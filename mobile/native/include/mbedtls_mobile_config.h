#pragma once
// Preserve every pinned consensus setting; add only a supported threading
// backend. PSA 3.6.x protects its key slots, RNG and global state with these.
#include "../vendor/core/src/crypto/mbedtls_user_config.h"
#define MBEDTLS_THREADING_C
#if defined(_WIN32)
#define MBEDTLS_THREADING_ALT
#else
#define MBEDTLS_THREADING_PTHREAD
#endif
// Replace compression only, preserving the provider lifecycle and portable
// fallback. This is runtime-gated on x86; ARM keeps the stock C compression.
#if defined(CONNECTCOIN_SHA256_ACCELERATION)
#undef MBEDTLS_SHA256_USE_ARMV8_A_CRYPTO_IF_PRESENT
#undef MBEDTLS_SHA256_USE_ARMV8_A_CRYPTO_ONLY
#undef MBEDTLS_SHA256_USE_A64_CRYPTO_IF_PRESENT
#undef MBEDTLS_SHA256_USE_A64_CRYPTO_ONLY
#define MBEDTLS_SHA256_PROCESS_ALT
#endif
