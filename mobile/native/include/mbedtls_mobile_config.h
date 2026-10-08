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
