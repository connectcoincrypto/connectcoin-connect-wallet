#include <wallet_crypto.h>
#include <public_claims.h>
#include <mbedtls/gcm.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <mbedtls/platform_util.h>
#include <secp256k1.h>
#include <secp256k1_extrakeys.h>
#include <secp256k1_schnorrsig.h>
#include <array>
#include <cerrno>
#include <cstring>
#include <mutex>
#include <new>
#include <stdexcept>
#include <vector>
extern "C" {
#include <crypto_scrypt.h>
}
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#elif defined(__APPLE__)
#include <Security/SecRandom.h>
#else
#include <sys/random.h>
#endif

extern "C" void cw_wallet_wipe(void *data, size_t size) { if (data && size) mbedtls_platform_zeroize(data, size); }
namespace {
template<size_t N> struct Secret {
    std::array<uint8_t,N> bytes{};
    ~Secret() { cw_wallet_wipe(bytes.data(), N); }
};
struct SecretKeypair {
    secp256k1_keypair value{};
    ~SecretKeypair() { cw_wallet_wipe(&value,sizeof(value)); }
};
bool input(const uint8_t *data, size_t size) { return data || size == 0; }
const uint8_t *nonempty(const uint8_t *data) { static const uint8_t empty{}; return data ? data : &empty; }
const secp256k1_context *context() {
    static const secp256k1_context *value=[] {
        connectwallet::InitializeCrypto();
        auto *ctx=secp256k1_context_create(SECP256K1_CONTEXT_NONE);
        if (!ctx) throw std::bad_alloc();
        Secret<32> random;
        if (!cw_wallet_random(random.bytes.data(), random.bytes.size()) || !secp256k1_context_randomize(ctx,random.bytes.data())) {
            secp256k1_context_destroy(ctx); throw std::runtime_error("Wallet random initialization failed");
        }
        return ctx;
    }();
    // Process-owned randomized, immutable context. Concurrent callers never
    // mutate it; destruction cannot race app worker teardown.
    return value;
}
struct Node {
    Secret<32> key, chain;
    bool derive(uint32_t requested, Node &out) const {
        uint64_t maximum=requested>=0x80000000U ? 0xffffffffULL : 0x7fffffffULL;
        for (uint64_t index=requested; index<=maximum; ++index) {
            Secret<37> data; Secret<64> material;
            if (index>=0x80000000ULL) std::memcpy(data.bytes.data()+1,key.bytes.data(),32);
            else {
                secp256k1_pubkey pub; size_t size=33;
                if (!secp256k1_ec_pubkey_create(context(),&pub,key.bytes.data()) ||
                    !secp256k1_ec_pubkey_serialize(context(),data.bytes.data(),&size,&pub,SECP256K1_EC_COMPRESSED)) return false;
            }
            for (int i=0;i<4;++i) data.bytes[33+i]=uint8_t(index>>(24-i*8));
            if (!cw_wallet_hmac512(chain.bytes.data(),32,data.bytes.data(),37,material.bytes.data())) return false;
            std::memcpy(out.key.bytes.data(),key.bytes.data(),32);
            if (!secp256k1_ec_seckey_tweak_add(context(),out.key.bytes.data(),material.bytes.data())) continue;
            std::memcpy(out.chain.bytes.data(),material.bytes.data()+32,32); return true;
        }
        return false;
    }
};
std::mutex kdfMutex;
}
struct cw_wallet_session { std::mutex mutex; Node branches[2]; bool locked{false}; };

extern "C" int cw_wallet_random(uint8_t *out,size_t size) {
    if (!out || size>65536) return 0;
#if defined(_WIN32)
    return BCryptGenRandom(nullptr,out,static_cast<ULONG>(size),BCRYPT_USE_SYSTEM_PREFERRED_RNG)==0;
#elif defined(__APPLE__)
    return SecRandomCopyBytes(kSecRandomDefault,size,out)==errSecSuccess;
#else
    size_t at=0;
    while(at<size) { auto n=getrandom(out+at,size-at,0); if(n<0 && errno==EINTR) continue; if(n<=0) { cw_wallet_wipe(out,size); return 0; } at+=size_t(n); }
    return 1;
#endif
}
extern "C" int cw_wallet_sha256(const uint8_t *data,size_t size,uint8_t out[32]) {
    if (!input(data,size) || !out) return 0;
    try { connectwallet::InitializeCrypto(); return mbedtls_sha256(nonempty(data),size,out,0)==0; } catch (...) { cw_wallet_wipe(out,32); return 0; }
}
extern "C" int cw_wallet_hmac512(const uint8_t *key,size_t key_size,const uint8_t *data,size_t size,uint8_t out[64]) {
    if (!input(key,key_size) || !input(data,size) || !out) return 0;
    try { connectwallet::InitializeCrypto(); return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA512),nonempty(key),key_size,nonempty(data),size,out)==0; }
    catch (...) { cw_wallet_wipe(out,64); return 0; }
}
extern "C" int cw_wallet_pbkdf512(const uint8_t *password,size_t password_size,const uint8_t *salt,size_t salt_size,uint8_t out[64]) {
    if (!input(password,password_size) || !input(salt,salt_size) || password_size>4096 || salt_size>8192 || !out) return 0;
    try {
        // A fixed wiped buffer avoids a vector reallocation leaving a copy of
        // the BIP39 passphrase salt in a freed allocation.
        Secret<8196> first;
        if(salt_size) std::memcpy(first.bytes.data(),salt,salt_size);
        first.bytes[salt_size+3]=1;
        Secret<64> u,next;
        int ok=cw_wallet_hmac512(password,password_size,first.bytes.data(),salt_size+4,u.bytes.data());
        if (!ok) return 0;
        std::memcpy(out,u.bytes.data(),64);
        for (int i=1;i<2048;++i) {
            if (!cw_wallet_hmac512(password,password_size,u.bytes.data(),64,next.bytes.data())) { cw_wallet_wipe(out,64); return 0; }
            u.bytes=next.bytes; for(size_t j=0;j<64;++j) out[j]^=u.bytes[j];
        }
        return 1;
    } catch (...) { cw_wallet_wipe(out,64); return 0; }
}
extern "C" int cw_wallet_scrypt(const uint8_t *password,size_t password_size,const uint8_t salt[32],uint8_t out[32]) {
    if (!input(password,password_size) || password_size>1024 || !salt || !out) return 0;
    try { std::lock_guard<std::mutex> guard(kdfMutex); if(crypto_scrypt(nonempty(password),password_size,salt,32,131072,8,1,out,32)==0) return 1; }
    catch (...) { }
    cw_wallet_wipe(out,32); return -1;
}
namespace {
int gcm(bool encrypt,const uint8_t *key,const uint8_t *nonce,const uint8_t *aad,size_t aad_size,
    const uint8_t *source,size_t size,const uint8_t *tag_in,uint8_t *destination,uint8_t *tag_out) {
    if (!key || !nonce || !input(aad,aad_size) || !input(source,size) || !destination || size>65536 || aad_size>4096 || (encrypt ? !tag_out : !tag_in)) return 0;
    try {
        connectwallet::InitializeCrypto(); mbedtls_gcm_context cipher; mbedtls_gcm_init(&cipher);
        int result=mbedtls_gcm_setkey(&cipher,MBEDTLS_CIPHER_ID_AES,key,256);
        if (!result) result=encrypt ? mbedtls_gcm_crypt_and_tag(&cipher,MBEDTLS_GCM_ENCRYPT,size,nonce,12,nonempty(aad),aad_size,nonempty(source),destination,16,tag_out)
            : mbedtls_gcm_auth_decrypt(&cipher,size,nonce,12,nonempty(aad),aad_size,tag_in,16,nonempty(source),destination);
        mbedtls_gcm_free(&cipher); if (!result) return 1;
    } catch (...) { }
    cw_wallet_wipe(destination,size); if(tag_out) cw_wallet_wipe(tag_out,16); return 0;
}
}
extern "C" int cw_wallet_gcm_encrypt(const uint8_t key[32],const uint8_t nonce[12],const uint8_t *aad,size_t aad_size,const uint8_t *plain,size_t size,uint8_t *cipher,uint8_t tag[16]) {
    return gcm(true,key,nonce,aad,aad_size,plain,size,nullptr,cipher,tag);
}
extern "C" int cw_wallet_gcm_decrypt(const uint8_t key[32],const uint8_t nonce[12],const uint8_t *aad,size_t aad_size,const uint8_t *cipher,size_t size,const uint8_t tag[16],uint8_t *plain) {
    return gcm(false,key,nonce,aad,aad_size,cipher,size,tag,plain,nullptr);
}
extern "C" int cw_wallet_valid_public(const uint8_t public_key[32]) {
    if (!public_key) return 0;
    try { secp256k1_xonly_pubkey pub; return secp256k1_xonly_pubkey_parse(context(),&pub,public_key); } catch (...) { return 0; }
}
extern "C" int cw_wallet_is_public_address(const char *address) {
    if(!address) return 0;
    size_t size=0; while(size<=64 && address[size]) ++size;
    if(!size || size>64) return 0;
    try { return connectwallet::IsPublicAddress(std::string_view(address,size)) ? 1 : 0; } catch(...) { return 0; }
}
extern "C" int cw_wallet_verify(const uint8_t signature[64],const uint8_t digest[32],const uint8_t public_key[32]) {
    if (!signature || !digest || !public_key) return 0;
    try { secp256k1_xonly_pubkey pub; return secp256k1_xonly_pubkey_parse(context(),&pub,public_key) && secp256k1_schnorrsig_verify(context(),signature,digest,32,&pub); } catch (...) { return 0; }
}
extern "C" cw_wallet_session *cw_wallet_session_create(const uint8_t *seed,size_t size) {
    if (!seed || size!=64) return nullptr;
    cw_wallet_session *session=nullptr;
    try {
        Secret<64> material; static const uint8_t label[]="Bitcoin seed";
        if (!cw_wallet_hmac512(label,sizeof(label)-1,seed,size,material.bytes.data())) return nullptr;
        Node node,next; std::memcpy(node.key.bytes.data(),material.bytes.data(),32); std::memcpy(node.chain.bytes.data(),material.bytes.data()+32,32);
        if (!secp256k1_ec_seckey_verify(context(),node.key.bytes.data())) return nullptr;
        for(uint32_t index:{0x8000002cU,0x80000000U,0x80000000U}) { if(!node.derive(index,next)) return nullptr; node.key.bytes=next.key.bytes; node.chain.bytes=next.chain.bytes; }
        session=new cw_wallet_session;
        if(!node.derive(0,session->branches[0]) || !node.derive(1,session->branches[1])) { delete session; return nullptr; }
        return session;
    } catch (...) { delete session; return nullptr; }
}
extern "C" void cw_wallet_session_lock(cw_wallet_session *session) {
    if (!session) return;
    std::lock_guard<std::mutex> guard(session->mutex); session->locked=true;
    for(auto &branch:session->branches) { cw_wallet_wipe(branch.key.bytes.data(),32); cw_wallet_wipe(branch.chain.bytes.data(),32); }
}
extern "C" void cw_wallet_session_destroy(cw_wallet_session *session) { if(session) { cw_wallet_session_lock(session); delete session; } }
extern "C" int cw_wallet_session_public(cw_wallet_session *session,uint32_t index,uint32_t change,uint8_t out[32]) {
    if(!session || !out || index>0x7fffffffU || change>1) return 0;
    try {
        std::lock_guard<std::mutex> guard(session->mutex); if(session->locked) return 0;
        Node node; secp256k1_pubkey pub; secp256k1_xonly_pubkey xonly;
        if(!session->branches[change].derive(index,node) || !secp256k1_ec_pubkey_create(context(),&pub,node.key.bytes.data()) || !secp256k1_xonly_pubkey_from_pubkey(context(),&xonly,nullptr,&pub)) return 0;
        return secp256k1_xonly_pubkey_serialize(context(),out,&xonly);
    } catch (...) { cw_wallet_wipe(out,32); return 0; }
}
extern "C" int cw_wallet_session_sign(cw_wallet_session *session,uint32_t index,uint32_t change,const uint8_t digest[32],uint8_t signature[64]) {
    if(!session || !digest || !signature || index>0x7fffffffU || change>1) return 0;
    try {
        std::lock_guard<std::mutex> guard(session->mutex); if(session->locked) return 0;
        Node node; Secret<32> aux; SecretKeypair pair; secp256k1_xonly_pubkey pub;
        if(!session->branches[change].derive(index,node) || !cw_wallet_random(aux.bytes.data(),32) || !secp256k1_keypair_create(context(),&pair.value,node.key.bytes.data())) return 0;
        bool ok=secp256k1_schnorrsig_sign32(context(),signature,digest,&pair.value,aux.bytes.data()) && secp256k1_keypair_xonly_pub(context(),&pub,nullptr,&pair.value) && secp256k1_schnorrsig_verify(context(),signature,digest,32,&pub);
        if(ok) return 1;
    } catch (...) { }
    cw_wallet_wipe(signature,64); return 0;
}
