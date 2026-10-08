// Copyright (c) 2026 The ConnectCoin Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or https://opensource.org/license/mit/.

#ifndef CONNECTCOIN_CRYPTO_MBEDTLS_USER_CONFIG_H
#define CONNECTCOIN_CRYPTO_MBEDTLS_USER_CONFIG_H

// Consensus validation supplies certificates and TLS transcript bytes from the
// transaction. It never asks Mbed TLS to access the network.
#undef MBEDTLS_NET_C

// Certificate validity is checked separately against consensus time in
// p2c_x509.cpp. Disabling Mbed TLS's wall-clock path selection makes the
// selected certificate chain independent of each node's local clock.
#undef MBEDTLS_HAVE_TIME
#undef MBEDTLS_HAVE_TIME_DATE

// P2C parses DER certificates supplied by the transaction and does not use
// Mbed TLS file loading or persistent PSA key storage.
#undef MBEDTLS_FS_IO
#undef MBEDTLS_PSA_CRYPTO_STORAGE_C
#undef MBEDTLS_PSA_ITS_FILE_C

// Bare-metal consensus-library builds also lack the platform timing
// implementation used by Mbed TLS.
#if defined(MBEDTLS_NO_PLATFORM_ENTROPY)
#undef MBEDTLS_TIMING_C
#endif

// MemorySanitizer cannot observe Mbed TLS's assembly. Disabling assembly alone
// leaves AES-NI enabled without an implementation on x86-64, while VIA PadLock
// also requires assembly on x86. Use the portable AES implementation instead.
#if defined(__has_feature)
#if __has_feature(memory_sanitizer)
#undef MBEDTLS_HAVE_ASM
#undef MBEDTLS_AESNI_C
#undef MBEDTLS_PADLOCK_C
#endif
#endif

#endif // CONNECTCOIN_CRYPTO_MBEDTLS_USER_CONFIG_H
