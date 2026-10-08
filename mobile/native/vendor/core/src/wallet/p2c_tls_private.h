// Copyright (c) 2026 The ConnectCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or https://opensource.org/license/mit/.
#ifndef CONNECTCOIN_WALLET_P2C_TLS_PRIVATE_H
#define CONNECTCOIN_WALLET_P2C_TLS_PRIVATE_H
#include <mbedtls/ssl.h>
#ifdef __cplusplus
extern "C" {
#endif
unsigned char* connectcoin_p2c_client_random(mbedtls_ssl_context* ssl);
#ifdef __cplusplus
}
#endif
#endif // CONNECTCOIN_WALLET_P2C_TLS_PRIVATE_H
