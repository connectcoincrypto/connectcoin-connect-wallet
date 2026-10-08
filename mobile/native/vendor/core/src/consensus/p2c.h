// Copyright (c) 2026 The ConnectCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or https://opensource.org/license/mit/.

#ifndef CONNECTCOIN_CONSENSUS_P2C_H
#define CONNECTCOIN_CONSENSUS_P2C_H

#include <uint256.h>

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

class CTransaction;
class CTxOut;

inline constexpr uint8_t P2C_PROOF_VERSION{2};
inline constexpr uint32_t P2C_ROOT_CERTIFICATES_VERSION_1{1};
inline constexpr size_t MAX_P2C_PROOF_SIZE{size_t{64} * 1024};
inline constexpr size_t MAX_P2C_CERTIFICATE_MESSAGE_SIZE{size_t{48} * 1024};
inline constexpr size_t MAX_P2C_CERTIFICATES{8};
inline constexpr size_t MAX_P2C_CERTIFICATE_SIZE{size_t{16} * 1024};
/** Public RSA exponent limit, independent of the RSA modulus/key size. */
inline constexpr size_t MAX_P2C_RSA_PUBLIC_EXPONENT_BITS{64};

/** Versions are consensus identifiers for immutable root bundles. */
constexpr bool IsSupportedP2CRootCertificatesVersion(uint32_t version)
{
    return version == P2C_ROOT_CERTIFICATES_VERSION_1;
}

/** Return whether an output is a canonical, currently supported type-2 P2C output. */
bool IsCanonicalP2COutput(const CTxOut& output);

/** Match one negotiated TLS SignatureScheme against the output's exact mask. */
bool P2CSignatureSchemeAllowed(uint8_t mask, uint16_t scheme);

/** A non-owning, fully parsed view of one version-2 P2C TLS proof. */
struct P2CTlsProofView
{
    std::span<const unsigned char> client_hello;
    std::span<const unsigned char> server_hello;
    std::span<const unsigned char> encrypted_extensions;
    std::span<const unsigned char> certificate;
    std::span<const unsigned char> certificate_verify;
    std::vector<std::span<const unsigned char>> certificate_chain;
    uint16_t certificate_verify_scheme{0};
    std::span<const unsigned char> certificate_verify_signature;
    uint256 transcript_hash;
    /** Tagged hash of CH || SH || EE || Certificate, excluding all CertificateVerify bytes. */
    uint256 connection_work_hash;
};

/**
 * Challenge placed verbatim in ClientHello.random. The txid excludes witness,
 * so this commits the proof to the final transaction without creating a hash
 * cycle. input_index distinguishes multiple P2C claims in the same transaction.
 */
uint256 P2CClaimChallenge(const CTransaction& spending_tx, uint32_t input_index);

/** Parse and structurally validate the canonical ConnectCoin TLS 1.3 profile. */
bool ParseP2CTlsProof(std::span<const unsigned char> encoded_proof,
                      std::string_view expected_domain,
                      const uint256& expected_challenge,
                      P2CTlsProofView& parsed,
                      std::string& error);

/** Interpret both hashes as unsigned 256-bit integers and enforce hash <= target. */
bool P2CMeetsWorkTarget(const uint256& connection_work_hash, const uint256& target);

#endif // CONNECTCOIN_CONSENSUS_P2C_H
