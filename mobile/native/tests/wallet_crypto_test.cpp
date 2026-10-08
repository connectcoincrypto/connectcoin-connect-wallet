#include <wallet_crypto.h>
#include <array>
#include <iostream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>
static void require(bool ok) { if(!ok) throw std::runtime_error("Native wallet crypto test failed"); }
static std::vector<uint8_t> unhex(const std::string &s) {
    std::vector<uint8_t> out; for(size_t i=0;i<s.size();i+=2) out.push_back(uint8_t(std::stoul(s.substr(i,2),nullptr,16))); return out;
}
static std::string hex(const uint8_t *data,size_t size) {
    const char *digits="0123456789abcdef"; std::string out;
    for(size_t i=0;i<size;++i) { out+=digits[data[i]>>4]; out+=digits[data[i]&15]; } return out;
}
int main() {
    try {
        std::array<uint8_t,32> hash{},salt{},key{},pub{},digest{};
        require(cw_wallet_sha256(reinterpret_cast<const uint8_t *>("abc"),3,hash.data()));
        require(hex(hash.data(),32)=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        auto knownPub=unhex("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9");
        auto knownSig=unhex("e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0");
        require(cw_wallet_verify(knownSig.data(),digest.data(),knownPub.data()));
        knownSig[0]^=1; require(!cw_wallet_verify(knownSig.data(),digest.data(),knownPub.data()));
        require(!cw_wallet_valid_public(pub.data()));
        const std::string words="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        std::array<uint8_t,64> seed{},signature{},other{};
        std::string mnemonicSalt="mnemonicTREZOR";
        require(cw_wallet_pbkdf512(reinterpret_cast<const uint8_t *>(words.data()),words.size(),reinterpret_cast<const uint8_t *>(mnemonicSalt.data()),mnemonicSalt.size(),seed.data()));
        require(hex(seed.data(),64)=="c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04");
        mnemonicSalt="mnemonic";
        require(cw_wallet_pbkdf512(reinterpret_cast<const uint8_t *>(words.data()),words.size(),reinterpret_cast<const uint8_t *>(mnemonicSalt.data()),mnemonicSalt.size(),seed.data()));
        auto *session=cw_wallet_session_create(seed.data(),seed.size()); require(session);
        for(const auto &[index,change,expected]:std::vector<std::tuple<uint32_t,uint32_t,std::string>>{
            {0,0,"aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e"},
            {7,1,"011fa6dcfbbc658f33139eb24e50063e96f58673b59cad268c5061ac38395d4b"},
            {2147483647,0,"2d6040532759b710bf8018744df076f81c7d65e121a306d3b243e7677e91dc4c"}}) {
            require(cw_wallet_session_public(session,index,change,pub.data())); require(hex(pub.data(),32)==expected);
            require(cw_wallet_session_sign(session,index,change,digest.data(),signature.data()));
            require(cw_wallet_verify(signature.data(),digest.data(),pub.data()));
            require(cw_wallet_session_sign(session,index,change,digest.data(),other.data())); require(signature!=other);
        }
        require(!cw_wallet_session_public(session,0x80000000U,0,pub.data()));
        cw_wallet_session_lock(session); require(!cw_wallet_session_public(session,0,0,pub.data()));
        require(!cw_wallet_session_sign(session,0,0,digest.data(),signature.data())); cw_wallet_session_destroy(session);
        const std::string password="wallet-test-password";
        require(cw_wallet_scrypt(reinterpret_cast<const uint8_t *>(password.data()),password.size(),salt.data(),key.data())==1);
        require(hex(key.data(),32)=="42b6f7034b24a38da12d57baf62615baddd01951550fed6fd945b22dee847dd5");
        std::array<uint8_t,12> nonce{}; std::array<uint8_t,16> tag{};
        std::array<uint8_t,4> plain{1,2,3,4},cipher{},decoded{},aad{5,6,7,8};
        require(cw_wallet_gcm_encrypt(key.data(),nonce.data(),aad.data(),aad.size(),plain.data(),plain.size(),cipher.data(),tag.data()));
        require(cw_wallet_gcm_decrypt(key.data(),nonce.data(),aad.data(),aad.size(),cipher.data(),cipher.size(),tag.data(),decoded.data())); require(plain==decoded);
        tag[0]^=1; require(!cw_wallet_gcm_decrypt(key.data(),nonce.data(),aad.data(),aad.size(),cipher.data(),cipher.size(),tag.data(),decoded.data()));
        require(decoded==std::array<uint8_t,4>{});
        cw_wallet_wipe(key.data(),key.size()); cw_wallet_wipe(seed.data(),seed.size());
        std::cout<<"Public BIP39/BIP32/BIP340, fixed desktop scrypt, GCM authentication and lock vectors passed\n";
        return 0;
    } catch(const std::exception &e) { std::cerr<<e.what()<<'\n'; return 1; }
}
