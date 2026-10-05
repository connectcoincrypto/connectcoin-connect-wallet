// Copyright (c) 2026 The ConnectCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or https://opensource.org/license/mit/.

#include <consensus/p2c.h>

#include <arith_uint256.h>
#include <crypto/sha256.h>
#include <hash.h>
#include <primitives/transaction.h>

#include <algorithm>
#include <array>
#include <compare>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

constexpr uint8_t TLS_HANDSHAKE_CLIENT_HELLO{1};
constexpr uint8_t TLS_HANDSHAKE_SERVER_HELLO{2};
constexpr uint8_t TLS_HANDSHAKE_ENCRYPTED_EXTENSIONS{8};
constexpr uint8_t TLS_HANDSHAKE_CERTIFICATE{11};
constexpr uint8_t TLS_HANDSHAKE_CERTIFICATE_VERIFY{15};

constexpr uint16_t TLS_EXTENSION_SERVER_NAME{0};
constexpr uint16_t TLS_EXTENSION_COMPRESS_CERTIFICATE{27};
constexpr uint16_t TLS_EXTENSION_PRE_SHARED_KEY{41};
constexpr uint16_t TLS_EXTENSION_EARLY_DATA{42};
constexpr uint16_t TLS_EXTENSION_SUPPORTED_VERSIONS{43};
constexpr uint16_t TLS_EXTENSION_COOKIE{44};
constexpr uint16_t TLS_EXTENSION_PSK_KEY_EXCHANGE_MODES{45};
constexpr uint16_t TLS_EXTENSION_KEY_SHARE{51};
constexpr uint16_t TLS_EXTENSION_SIGNATURE_ALGORITHMS{13};
constexpr uint16_t TLS_EXTENSION_ENCRYPTED_CLIENT_HELLO{0xfe0d};

constexpr uint16_t TLS_VERSION_1_2{0x0303};
constexpr uint16_t TLS_VERSION_1_3{0x0304};
constexpr uint16_t TLS_AES_128_GCM_SHA256{0x1301};
constexpr uint16_t TLS_CHACHA20_POLY1305_SHA256{0x1303};

constexpr uint16_t TLS_ECDSA_SECP256R1_SHA256{0x0403};
constexpr uint16_t TLS_RSA_PSS_RSAE_SHA256{0x0804};
constexpr uint16_t TLS_RSA_PSS_PSS_SHA256{0x0809};
constexpr uint16_t TLS_GROUP_SECP256R1{0x0017};
constexpr uint16_t TLS_GROUP_X25519{0x001d};

constexpr size_t MAX_CLIENT_HELLO_SIZE{4096};
constexpr size_t MAX_SERVER_HELLO_SIZE{2048};
constexpr size_t MAX_ENCRYPTED_EXTENSIONS_SIZE{4096};
constexpr size_t MAX_CERTIFICATE_VERIFY_SIZE{8192};

constexpr std::array<unsigned char, 32> HELLO_RETRY_REQUEST_RANDOM{
    0xcf, 0x21, 0xad, 0x74, 0xe5, 0x9a, 0x61, 0x11,
    0xbe, 0x1d, 0x8c, 0x02, 0x1e, 0x65, 0xb8, 0x91,
    0xc2, 0xa2, 0x11, 0x16, 0x7a, 0xbb, 0x8c, 0x5e,
    0x07, 0x9e, 0x09, 0xe2, 0xc8, 0xa8, 0x33, 0x9c,
};

class ByteReader
{
private:
    std::span<const unsigned char> m_bytes;
    size_t m_pos{0};

public:
    explicit ByteReader(std::span<const unsigned char> bytes) : m_bytes{bytes} {}

    size_t Position() const { return m_pos; }
    size_t Remaining() const { return m_bytes.size() - m_pos; }
    bool Empty() const { return m_pos == m_bytes.size(); }

    bool ReadU8(uint8_t& out)
    {
        if (Remaining() < 1) return false;
        out = m_bytes[m_pos++];
        return true;
    }

    bool ReadU16(uint16_t& out)
    {
        if (Remaining() < 2) return false;
        out = (uint16_t{m_bytes[m_pos]} << 8) | uint16_t{m_bytes[m_pos + 1]};
        m_pos += 2;
        return true;
    }

    bool ReadU24(uint32_t& out)
    {
        if (Remaining() < 3) return false;
        out = (uint32_t{m_bytes[m_pos]} << 16) |
              (uint32_t{m_bytes[m_pos + 1]} << 8) |
              uint32_t{m_bytes[m_pos + 2]};
        m_pos += 3;
        return true;
    }

    bool ReadBytes(size_t size, std::span<const unsigned char>& out)
    {
        if (Remaining() < size) return false;
        out = m_bytes.subspan(m_pos, size);
        m_pos += size;
        return true;
    }
};

struct TlsExtension
{
    uint16_t type;
    std::span<const unsigned char> data;
};

struct ClientHelloState
{
    std::vector<uint16_t> cipher_suites;
    std::vector<uint16_t> signature_algorithms;
    std::vector<uint16_t> key_share_groups;
    std::vector<unsigned char> legacy_session_id;
};

bool IsValidKeyShare(uint16_t group, std::span<const unsigned char> exchange)
{
    if (group == TLS_GROUP_X25519) return exchange.size() == 32;
    return group == TLS_GROUP_SECP256R1 && exchange.size() == 65 && exchange.front() == 0x04;
}

bool SetError(std::string& error, std::string message)
{
    error = std::move(message);
    return false;
}

bool ReadHandshake(ByteReader& proof, uint8_t expected_type, size_t maximum_size,
                   std::span<const unsigned char>& full, std::span<const unsigned char>& body,
                   std::string& error)
{
    const size_t start{proof.Position()};
    uint8_t type{0};
    uint32_t size{0};
    if (!proof.ReadU8(type) || !proof.ReadU24(size)) return SetError(error, "truncated TLS handshake header");
    if (type != expected_type) return SetError(error, "unexpected TLS handshake message order");
    if (size + 4 > maximum_size) return SetError(error, "TLS handshake message exceeds P2C limit");
    if (!proof.ReadBytes(size, body)) return SetError(error, "truncated TLS handshake message");
    full = std::span<const unsigned char>{body.data() - 4, size + 4};
    if (proof.Position() != start + full.size()) return SetError(error, "internal TLS parser offset mismatch");
    return true;
}

bool ReadExtensions(ByteReader& message, std::vector<TlsExtension>& extensions, std::string& error)
{
    uint16_t total_size{0};
    if (!message.ReadU16(total_size) || message.Remaining() != total_size) {
        return SetError(error, "invalid TLS extensions length");
    }
    std::span<const unsigned char> encoded;
    if (!message.ReadBytes(total_size, encoded)) return SetError(error, "truncated TLS extensions");
    ByteReader reader{encoded};
    while (!reader.Empty()) {
        uint16_t type{0};
        uint16_t size{0};
        std::span<const unsigned char> data;
        if (!reader.ReadU16(type) || !reader.ReadU16(size) || !reader.ReadBytes(size, data)) {
            return SetError(error, "truncated TLS extension");
        }
        if (std::ranges::any_of(extensions, [type](const auto& extension) { return extension.type == type; })) {
            return SetError(error, "duplicate TLS extension");
        }
        extensions.push_back({type, data});
    }
    return true;
}

const TlsExtension* FindExtension(const std::vector<TlsExtension>& extensions, uint16_t type)
{
    const auto it{std::ranges::find_if(extensions, [type](const auto& extension) { return extension.type == type; })};
    return it == extensions.end() ? nullptr : &*it;
}

bool ParseServerName(const TlsExtension& extension, std::string_view expected_domain, std::string& error)
{
    ByteReader reader{extension.data};
    uint16_t list_size{0};
    uint8_t name_type{0};
    uint16_t name_size{0};
    std::span<const unsigned char> name;
    if (!reader.ReadU16(list_size) || list_size != reader.Remaining() ||
        !reader.ReadU8(name_type) || name_type != 0 ||
        !reader.ReadU16(name_size) || !reader.ReadBytes(name_size, name) || !reader.Empty()) {
        return SetError(error, "P2C ClientHello must contain exactly one DNS server_name");
    }
    const std::string_view encoded_name{reinterpret_cast<const char*>(name.data()), name.size()};
    if (encoded_name != expected_domain) return SetError(error, "ClientHello server_name does not match P2C domain");
    return true;
}

bool ParseClientHello(std::span<const unsigned char> body, std::string_view expected_domain,
                      const uint256& expected_challenge, ClientHelloState& state, std::string& error)
{
    ByteReader reader{body};
    uint16_t legacy_version{0};
    std::span<const unsigned char> random;
    uint8_t session_id_size{0};
    std::span<const unsigned char> session_id;
    uint16_t cipher_suites_size{0};
    std::span<const unsigned char> cipher_suites;
    uint8_t compression_size{0};
    std::span<const unsigned char> compression;
    if (!reader.ReadU16(legacy_version) || legacy_version != TLS_VERSION_1_2 ||
        !reader.ReadBytes(32, random) ||
        !reader.ReadU8(session_id_size) || session_id_size > 32 || !reader.ReadBytes(session_id_size, session_id) ||
        !reader.ReadU16(cipher_suites_size) || cipher_suites_size < 2 || (cipher_suites_size % 2) != 0 ||
        !reader.ReadBytes(cipher_suites_size, cipher_suites) ||
        !reader.ReadU8(compression_size) || compression_size != 1 ||
        !reader.ReadBytes(compression_size, compression) || compression[0] != 0) {
        return SetError(error, "invalid canonical P2C ClientHello");
    }
    if (!std::equal(random.begin(), random.end(), expected_challenge.begin())) {
        return SetError(error, "ClientHello.random does not match P2C claim challenge");
    }
    state.legacy_session_id.assign(session_id.begin(), session_id.end());
    for (size_t i{0}; i < cipher_suites.size(); i += 2) {
        state.cipher_suites.push_back((uint16_t{cipher_suites[i]} << 8) | cipher_suites[i + 1]);
    }

    std::vector<TlsExtension> extensions;
    if (!ReadExtensions(reader, extensions, error) || !reader.Empty()) return false;
    const auto* server_name{FindExtension(extensions, TLS_EXTENSION_SERVER_NAME)};
    const auto* versions{FindExtension(extensions, TLS_EXTENSION_SUPPORTED_VERSIONS)};
    const auto* signatures{FindExtension(extensions, TLS_EXTENSION_SIGNATURE_ALGORITHMS)};
    const auto* key_share{FindExtension(extensions, TLS_EXTENSION_KEY_SHARE)};
    if (!server_name || !versions || !signatures || !key_share) {
        return SetError(error, "P2C ClientHello is missing a required TLS 1.3 extension");
    }
    if (!ParseServerName(*server_name, expected_domain, error)) return false;
    for (uint16_t forbidden : {TLS_EXTENSION_COMPRESS_CERTIFICATE, TLS_EXTENSION_PRE_SHARED_KEY,
                               TLS_EXTENSION_EARLY_DATA, TLS_EXTENSION_COOKIE,
                               TLS_EXTENSION_PSK_KEY_EXCHANGE_MODES, TLS_EXTENSION_ENCRYPTED_CLIENT_HELLO}) {
        if (FindExtension(extensions, forbidden)) return SetError(error, "forbidden P2C ClientHello extension");
    }

    ByteReader version_reader{versions->data};
    uint8_t version_size{0};
    std::span<const unsigned char> version_list;
    if (!version_reader.ReadU8(version_size) || version_size < 2 || (version_size % 2) != 0 ||
        !version_reader.ReadBytes(version_size, version_list) || !version_reader.Empty()) {
        return SetError(error, "invalid supported_versions extension");
    }
    bool offers_tls13{false};
    for (size_t i{0}; i < version_list.size(); i += 2) {
        offers_tls13 |= ((uint16_t{version_list[i]} << 8) | version_list[i + 1]) == TLS_VERSION_1_3;
    }
    if (!offers_tls13) return SetError(error, "ClientHello does not offer TLS 1.3");

    ByteReader signature_reader{signatures->data};
    uint16_t signature_size{0};
    std::span<const unsigned char> signature_list;
    if (!signature_reader.ReadU16(signature_size) || signature_size < 2 || (signature_size % 2) != 0 ||
        !signature_reader.ReadBytes(signature_size, signature_list) || !signature_reader.Empty()) {
        return SetError(error, "invalid signature_algorithms extension");
    }
    for (size_t i{0}; i < signature_list.size(); i += 2) {
        state.signature_algorithms.push_back((uint16_t{signature_list[i]} << 8) | signature_list[i + 1]);
    }

    ByteReader key_share_reader{key_share->data};
    uint16_t shares_size{0};
    std::span<const unsigned char> shares;
    if (!key_share_reader.ReadU16(shares_size) || shares_size == 0 ||
        !key_share_reader.ReadBytes(shares_size, shares) || !key_share_reader.Empty()) {
        return SetError(error, "invalid ClientHello key_share extension");
    }
    ByteReader shares_reader{shares};
    while (!shares_reader.Empty()) {
        uint16_t group{0};
        uint16_t exchange_size{0};
        std::span<const unsigned char> exchange;
        if (!shares_reader.ReadU16(group) || !shares_reader.ReadU16(exchange_size) || exchange_size == 0 ||
            !shares_reader.ReadBytes(exchange_size, exchange) || !IsValidKeyShare(group, exchange) ||
            std::ranges::find(state.key_share_groups, group) != state.key_share_groups.end()) {
            return SetError(error, "invalid ClientHello key share");
        }
        state.key_share_groups.push_back(group);
    }
    return true;
}

bool ParseServerHello(std::span<const unsigned char> body, const ClientHelloState& client, std::string& error)
{
    ByteReader reader{body};
    uint16_t legacy_version{0};
    std::span<const unsigned char> random;
    uint8_t session_id_size{0};
    std::span<const unsigned char> session_id;
    uint16_t cipher_suite{0};
    uint8_t compression{0};
    if (!reader.ReadU16(legacy_version) || legacy_version != TLS_VERSION_1_2 || !reader.ReadBytes(32, random) ||
        !reader.ReadU8(session_id_size) || session_id_size > 32 || !reader.ReadBytes(session_id_size, session_id) ||
        !reader.ReadU16(cipher_suite) || !reader.ReadU8(compression) || compression != 0) {
        return SetError(error, "invalid canonical P2C ServerHello");
    }
    if (std::ranges::equal(random, HELLO_RETRY_REQUEST_RANDOM)) return SetError(error, "HelloRetryRequest is forbidden in P2C v2");
    if (!std::ranges::equal(session_id, client.legacy_session_id)) return SetError(error, "ServerHello session id mismatch");
    if (cipher_suite != TLS_AES_128_GCM_SHA256 && cipher_suite != TLS_CHACHA20_POLY1305_SHA256) {
        return SetError(error, "P2C v2 requires a SHA-256 TLS 1.3 cipher suite");
    }
    if (std::ranges::find(client.cipher_suites, cipher_suite) == client.cipher_suites.end()) {
        return SetError(error, "ServerHello selected an unoffered cipher suite");
    }

    std::vector<TlsExtension> extensions;
    if (!ReadExtensions(reader, extensions, error) || !reader.Empty()) return false;
    if (extensions.size() != 2) return SetError(error, "P2C ServerHello must contain only supported_versions and key_share");
    const auto* versions{FindExtension(extensions, TLS_EXTENSION_SUPPORTED_VERSIONS)};
    const auto* key_share{FindExtension(extensions, TLS_EXTENSION_KEY_SHARE)};
    if (!versions || !key_share || versions->data.size() != 2 ||
        ((uint16_t{versions->data[0]} << 8) | versions->data[1]) != TLS_VERSION_1_3) {
        return SetError(error, "ServerHello did not select TLS 1.3");
    }
    ByteReader key_share_reader{key_share->data};
    uint16_t group{0};
    uint16_t exchange_size{0};
    std::span<const unsigned char> exchange;
    if (!key_share_reader.ReadU16(group) || !key_share_reader.ReadU16(exchange_size) || exchange_size == 0 ||
        !key_share_reader.ReadBytes(exchange_size, exchange) || !key_share_reader.Empty() ||
        !IsValidKeyShare(group, exchange) ||
        std::ranges::find(client.key_share_groups, group) == client.key_share_groups.end()) {
        return SetError(error, "invalid or unoffered ServerHello key share");
    }
    return true;
}

bool ParseEncryptedExtensions(std::span<const unsigned char> body, std::string& error)
{
    ByteReader reader{body};
    std::vector<TlsExtension> extensions;
    if (!ReadExtensions(reader, extensions, error) || !reader.Empty()) return false;
    if (FindExtension(extensions, TLS_EXTENSION_EARLY_DATA)) return SetError(error, "TLS early_data is forbidden in P2C v2");
    return true;
}

bool ParseCertificate(std::span<const unsigned char> body, P2CTlsProofView& parsed, std::string& error)
{
    ByteReader reader{body};
    uint8_t context_size{0};
    std::span<const unsigned char> context;
    uint32_t list_size{0};
    std::span<const unsigned char> list;
    if (!reader.ReadU8(context_size) || context_size != 0 || !reader.ReadBytes(context_size, context) ||
        !reader.ReadU24(list_size) || list_size == 0 || list_size != reader.Remaining() ||
        !reader.ReadBytes(list_size, list) || !reader.Empty()) {
        return SetError(error, "invalid canonical P2C Certificate message");
    }

    ByteReader certificates{list};
    while (!certificates.Empty()) {
        uint32_t certificate_size{0};
        std::span<const unsigned char> certificate;
        uint16_t extensions_size{0};
        std::span<const unsigned char> extensions;
        if (!certificates.ReadU24(certificate_size) || certificate_size == 0 || certificate_size > MAX_P2C_CERTIFICATE_SIZE ||
            !certificates.ReadBytes(certificate_size, certificate) ||
            !certificates.ReadU16(extensions_size) || !certificates.ReadBytes(extensions_size, extensions)) {
            return SetError(error, "invalid certificate entry in P2C proof");
        }
        parsed.certificate_chain.push_back(certificate);
        if (parsed.certificate_chain.size() > MAX_P2C_CERTIFICATES) return SetError(error, "too many certificates in P2C proof");
    }
    return true;
}

bool IsSupportedCertificateVerifyScheme(uint16_t scheme)
{
    return scheme == TLS_ECDSA_SECP256R1_SHA256 ||
           scheme == TLS_RSA_PSS_RSAE_SHA256 ||
           scheme == TLS_RSA_PSS_PSS_SHA256;
}

bool ParseCertificateVerify(std::span<const unsigned char> body, const ClientHelloState& client,
                            P2CTlsProofView& parsed, std::string& error)
{
    ByteReader reader{body};
    uint16_t signature_size{0};
    if (!reader.ReadU16(parsed.certificate_verify_scheme) ||
        !reader.ReadU16(signature_size) || signature_size == 0 ||
        !reader.ReadBytes(signature_size, parsed.certificate_verify_signature) || !reader.Empty()) {
        return SetError(error, "invalid P2C CertificateVerify message");
    }
    if (!IsSupportedCertificateVerifyScheme(parsed.certificate_verify_scheme)) {
        return SetError(error, "unsupported P2C CertificateVerify signature scheme");
    }
    if (std::ranges::find(client.signature_algorithms, parsed.certificate_verify_scheme) == client.signature_algorithms.end()) {
        return SetError(error, "CertificateVerify used an unoffered signature scheme");
    }
    return true;
}

void WriteRaw(HashWriter& writer, std::span<const unsigned char> bytes)
{
    writer.write(std::as_bytes(bytes));
}

} // namespace

bool IsCanonicalP2COutput(const CTxOut& output)
{
    if (output.GetType() != TxOutputType::PAY_TO_CONNECT) return false;
    if (const auto p2c{output.GetPayToDomain()}) {
        return IsSupportedP2CRootCertificatesVersion(p2c->root_certificates_version);
    }
    return false;
}

bool P2CSignatureSchemeAllowed(uint8_t mask, uint16_t scheme)
{
    if (!IsValidP2CSignatureAlgorithmsMask(mask)) return false;
    uint8_t flag{0};
    switch (scheme) {
    case TLS_ECDSA_SECP256R1_SHA256: flag = PayToDomainOutput::SIGNATURE_ALGORITHM_ECDSA_P256_SHA256; break;
    case TLS_RSA_PSS_RSAE_SHA256: flag = PayToDomainOutput::SIGNATURE_ALGORITHM_RSA_PSS_RSAE_SHA256; break;
    case TLS_RSA_PSS_PSS_SHA256: flag = PayToDomainOutput::SIGNATURE_ALGORITHM_RSA_PSS_PSS_SHA256; break;
    default: return false;
    }
    return (mask & flag) != 0;
}

uint256 P2CClaimChallenge(const CTransaction& spending_tx, uint32_t input_index)
{
    return (TaggedHash("ConnectCoin/P2C/claim/v1") << spending_tx.GetHash() << input_index).GetSHA256();
}

bool ParseP2CTlsProof(std::span<const unsigned char> encoded_proof,
                      std::string_view expected_domain,
                      const uint256& expected_challenge,
                      P2CTlsProofView& parsed,
                      std::string& error)
{
    parsed = {};
    error.clear();
    if (!IsCanonicalP2CDomain(expected_domain)) return SetError(error, "invalid expected P2C domain");
    if (encoded_proof.empty() || encoded_proof.size() > MAX_P2C_PROOF_SIZE) return SetError(error, "invalid P2C proof size");

    ByteReader proof{encoded_proof};
    uint8_t version{0};
    if (!proof.ReadU8(version) || version != P2C_PROOF_VERSION) return SetError(error, "unsupported P2C proof version");

    std::span<const unsigned char> client_body;
    std::span<const unsigned char> server_body;
    std::span<const unsigned char> extensions_body;
    std::span<const unsigned char> certificate_body;
    std::span<const unsigned char> verify_body;
    if (!ReadHandshake(proof, TLS_HANDSHAKE_CLIENT_HELLO, MAX_CLIENT_HELLO_SIZE,
                       parsed.client_hello, client_body, error) ||
        !ReadHandshake(proof, TLS_HANDSHAKE_SERVER_HELLO, MAX_SERVER_HELLO_SIZE,
                       parsed.server_hello, server_body, error) ||
        !ReadHandshake(proof, TLS_HANDSHAKE_ENCRYPTED_EXTENSIONS, MAX_ENCRYPTED_EXTENSIONS_SIZE,
                       parsed.encrypted_extensions, extensions_body, error) ||
        !ReadHandshake(proof, TLS_HANDSHAKE_CERTIFICATE, MAX_P2C_CERTIFICATE_MESSAGE_SIZE,
                       parsed.certificate, certificate_body, error) ||
        !ReadHandshake(proof, TLS_HANDSHAKE_CERTIFICATE_VERIFY, MAX_CERTIFICATE_VERIFY_SIZE,
                       parsed.certificate_verify, verify_body, error)) {
        return false;
    }
    if (!proof.Empty()) return SetError(error, "trailing bytes after P2C CertificateVerify");

    ClientHelloState client;
    if (!ParseClientHello(client_body, expected_domain, expected_challenge, client, error) ||
        !ParseServerHello(server_body, client, error) ||
        !ParseEncryptedExtensions(extensions_body, error) ||
        !ParseCertificate(certificate_body, parsed, error) ||
        !ParseCertificateVerify(verify_body, client, parsed, error)) {
        return false;
    }

    CSHA256 transcript;
    for (const auto message : {parsed.client_hello, parsed.server_hello, parsed.encrypted_extensions, parsed.certificate}) {
        transcript.Write(message.data(), message.size());
    }
    transcript.Finalize(parsed.transcript_hash.begin());

    // Hash exactly the raw transcript authenticated by CertificateVerify. The
    // entire CertificateVerify message (including its header and lengths) is
    // excluded so equivalent signature encodings cannot create more work
    // candidates. Parsing it above and verifying its signature remain mandatory.
    HashWriter work{TaggedHash("ConnectCoin/P2C/work/v2")};
    WriteRaw(work, parsed.client_hello);
    WriteRaw(work, parsed.server_hello);
    WriteRaw(work, parsed.encrypted_extensions);
    WriteRaw(work, parsed.certificate);
    parsed.connection_work_hash = work.GetSHA256();
    return true;
}

bool P2CMeetsWorkTarget(const uint256& connection_work_hash, const uint256& target)
{
    return UintToArith256(connection_work_hash) <= UintToArith256(target);
}
