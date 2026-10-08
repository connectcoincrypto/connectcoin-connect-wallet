// Copyright (c) 2026 The ConnectCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or https://opensource.org/license/mit/.

#define MBEDTLS_ALLOW_PRIVATE_ACCESS
#include <wallet/p2c_tls_private.h>
#include <ssl_misc.h>

// The pinned library's internal header is C-only. Keep the tiny layout adapter
// here instead of patching the dependency or duplicating its private struct.
unsigned char* connectcoin_p2c_client_random(mbedtls_ssl_context* ssl)
{
    return ssl->handshake ? ssl->handshake->randbytes : NULL;
}
