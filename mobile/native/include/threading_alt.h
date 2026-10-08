#pragma once
// Opaque Windows mutex storage keeps C and C++ consumers ABI-compatible.
typedef struct mbedtls_threading_mutex_t { void* native_mutex; } mbedtls_threading_mutex_t;
