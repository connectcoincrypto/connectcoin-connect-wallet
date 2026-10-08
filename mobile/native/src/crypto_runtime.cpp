#include <public_claims.h>
#include <mbedtls/threading.h>
#include <mbedtls/aes.h>
#include <mbedtls/cipher.h>
#include <mbedtls/ecp.h>
#include <mbedtls/sha256.h>
#include <mbedtls/sha512.h>
#include <mbedtls/ssl.h>
#include <psa/crypto.h>
#include <mutex>
#include <new>
#include <stdexcept>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

#if !defined(MBEDTLS_THREADING_C)
#error "Concurrent mobile capture requires the Mbed TLS threading layer"
#endif
namespace connectwallet {
namespace {
#if defined(MBEDTLS_THREADING_ALT)
static_assert(sizeof(SRWLOCK)==sizeof(mbedtls_threading_mutex_t));
static_assert(alignof(SRWLOCK)==alignof(mbedtls_threading_mutex_t));
SRWLOCK* PlatformMutex(mbedtls_threading_mutex_t* value) noexcept {
    return reinterpret_cast<SRWLOCK*>(&value->native_mutex);
}
void MutexInit(mbedtls_threading_mutex_t* value) noexcept {
    if(value) InitializeSRWLock(PlatformMutex(value));
}
void MutexFree(mbedtls_threading_mutex_t* value) noexcept {
    // SRW locks have no separately allocated resource or destruction API.
    if(value) value->native_mutex=nullptr;
}
int MutexLock(mbedtls_threading_mutex_t* value) noexcept {
    if(!value) return MBEDTLS_ERR_THREADING_BAD_INPUT_DATA;
    AcquireSRWLockExclusive(PlatformMutex(value)); return 0;
}
int MutexUnlock(mbedtls_threading_mutex_t* value) noexcept {
    if(!value) return MBEDTLS_ERR_THREADING_BAD_INPUT_DATA;
    ReleaseSRWLockExclusive(PlatformMutex(value)); return 0;
}
#endif
}
void InitializeCrypto() {
    // Initialize before any worker owns crypto contexts. Never dismantle PSA
    // globals while detached DNS/worker callers or thread-local roots can live.
    // The bounded global PSA runtime lasts for the process; worker roots do not.
    static const bool initialized=[] {
#if defined(MBEDTLS_THREADING_ALT)
        mbedtls_threading_set_alt(MutexInit,MutexFree,MutexLock,MutexUnlock);
#endif
        // These pinned 3.6.7 classic APIs lazily fill process-wide capability
        // lists / CPU-dispatch caches outside PSA's own mutexes. Warm them
        // exactly once before publishing initialization to any worker.
        mbedtls_ecp_grp_id_list();
        mbedtls_ssl_list_ciphersuites();
        mbedtls_cipher_list();
        unsigned char input[128]{}, digest[64]{}, key[32]{};
        if(mbedtls_sha256(input,sizeof(input),digest,0) || mbedtls_sha512(input,sizeof(input),digest,0)) return false;
        mbedtls_aes_context aes; mbedtls_aes_init(&aes);
        int aes_result=mbedtls_aes_setkey_enc(&aes,key,256);
        if(!aes_result) aes_result=mbedtls_aes_crypt_ecb(&aes,MBEDTLS_AES_ENCRYPT,input,digest);
        mbedtls_aes_free(&aes);
        return aes_result==0 && psa_crypto_init()==PSA_SUCCESS;
    }();
    if(!initialized) throw std::runtime_error("CLAIM_CRYPTO");
}
}
