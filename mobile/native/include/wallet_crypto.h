#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Native-only primitives. Never export these methods, opaque handles, seeds or
 * derived keys through the Capacitor bridge. All buffers are caller-owned;
 * functions return 1 on success and 0 on failure unless stated otherwise. */
void cw_wallet_wipe(void *data, size_t size);
int cw_wallet_random(uint8_t *out, size_t size);
int cw_wallet_sha256(const uint8_t *data, size_t size, uint8_t out[32]);
int cw_wallet_hmac512(const uint8_t *key, size_t key_size, const uint8_t *data, size_t size, uint8_t out[64]);
int cw_wallet_pbkdf512(const uint8_t *password, size_t password_size, const uint8_t *salt, size_t salt_size, uint8_t out[64]);
/* Exactly desktop N=131072,r=8,p=1. -1 means allocation/resource failure.
 * One KDF runs at a time process-wide, including unrelated vault operations. */
int cw_wallet_scrypt(const uint8_t *password, size_t password_size, const uint8_t salt[32], uint8_t out[32]);
int cw_wallet_gcm_encrypt(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *aad, size_t aad_size,
    const uint8_t *plain, size_t size, uint8_t *cipher, uint8_t tag[16]);
int cw_wallet_gcm_decrypt(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *aad, size_t aad_size,
    const uint8_t *cipher, size_t size, const uint8_t tag[16], uint8_t *plain);
int cw_wallet_valid_public(const uint8_t public_key[32]);
int cw_wallet_verify(const uint8_t signature[64], const uint8_t digest[32], const uint8_t public_key[32]);
typedef struct cw_wallet_session cw_wallet_session;
/* Seed is consumed only during construction, and never retained. Private
 * material stays in native memory and is erased on lock/destruction. */
cw_wallet_session *cw_wallet_session_create(const uint8_t *seed, size_t size);
void cw_wallet_session_lock(cw_wallet_session *session);
void cw_wallet_session_destroy(cw_wallet_session *session);
int cw_wallet_session_public(cw_wallet_session *session, uint32_t index, uint32_t change, uint8_t out[32]);
int cw_wallet_session_sign(cw_wallet_session *session, uint32_t index, uint32_t change, const uint8_t digest[32], uint8_t signature[64]);
#ifdef __cplusplus
}
#endif
