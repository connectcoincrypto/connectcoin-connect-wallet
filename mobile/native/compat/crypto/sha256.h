#pragma once
#include <mbedtls/sha256.h>
#include <stdexcept>
class CSHA256 {
    mbedtls_sha256_context value;
public:
    CSHA256() { mbedtls_sha256_init(&value); if (mbedtls_sha256_starts(&value, 0)) throw std::runtime_error("SHA256 initialization"); }
    CSHA256(const CSHA256& other) { mbedtls_sha256_init(&value); mbedtls_sha256_clone(&value, &other.value); }
    ~CSHA256() { mbedtls_sha256_free(&value); }
    CSHA256& Write(const unsigned char* bytes, size_t size) { if (mbedtls_sha256_update(&value, bytes, size)) throw std::runtime_error("SHA256 update"); return *this; }
    void Finalize(unsigned char* out) { if (mbedtls_sha256_finish(&value, out)) throw std::runtime_error("SHA256 finalization"); }
};
