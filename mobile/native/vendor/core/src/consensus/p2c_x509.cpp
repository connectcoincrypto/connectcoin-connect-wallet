// Copyright (c) 2026 The ConnectCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or https://opensource.org/license/mit/.

#include <consensus/p2c_x509.h>

#include <consensus/p2c.h>
#include <consensus/p2c_roots_v1.pem.h>
#include <consensus/p2c_x509_mutex.h>
#include <crypto/mbedtls_rsa_pss.h>
#include <crypto/mbedtls_x509_root_first.h>
#include <crypto/sha256.h>
#include <mbedtls/asn1.h>
#include <mbedtls/bignum.h>
#include <mbedtls/ecp.h>
#include <mbedtls/md.h>
#include <mbedtls/oid.h>
#include <mbedtls/pk.h>
#include <mbedtls/rsa.h>
#include <mbedtls/x509.h>
#include <mbedtls/x509_crt.h>
#include <primitives/transaction.h>
#include <uint256.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#if defined(MBEDTLS_HAVE_TIME) || defined(MBEDTLS_HAVE_TIME_DATE)
#error "P2C consensus validation must not depend on the node's local clock"
#endif

namespace {

constexpr uint16_t TLS_ECDSA_SECP256R1_SHA256{0x0403};
constexpr uint16_t TLS_RSA_PSS_RSAE_SHA256{0x0804};
constexpr uint16_t TLS_RSA_PSS_PSS_SHA256{0x0809};
constexpr std::string_view TLS13_SERVER_CERTIFICATE_VERIFY_CONTEXT{"TLS 1.3, server CertificateVerify"};

class CertificateChain
{
public:
    mbedtls_x509_crt value;

    CertificateChain() { mbedtls_x509_crt_init(&value); }
    ~CertificateChain() { mbedtls_x509_crt_free(&value); }
    CertificateChain(const CertificateChain&) = delete;
    CertificateChain& operator=(const CertificateChain&) = delete;
};

bool SetError(std::string& error, std::string message)
{
    error = std::move(message);
    return false;
}

const mbedtls_x509_crt* RootStoreV1()
{
    struct RootStore {
        CertificateChain chain;
        bool valid{false};

        RootStore()
        {
            std::vector<unsigned char> pem;
            pem.reserve(consensus::p2c::data::p2c_roots_v1.size() + 1);
            for (const std::byte value : consensus::p2c::data::p2c_roots_v1) {
                pem.push_back(std::to_integer<unsigned char>(value));
            }
            pem.push_back(0);
            std::string error;
            valid = mbedtls_x509_crt_parse(&chain.value, pem.data(), pem.size()) == 0 &&
                    CheckP2CCertificatePublicKeys(chain.value, error);
        }
    };
    // A cancelled detached GUI probe can still be finishing crypto when static
    // destruction begins. Keep this fixed, public-only trust cache alive for
    // the process lifetime. The static pointer remains reachable and its local
    // initialization retains C++'s thread-safety guarantee. Test roots stay
    // owned by their individual validation calls and are freed normally.
    static const RootStore* const roots{new RootStore};
    return roots->valid ? &roots->chain.value : nullptr;
}

bool ParseCertificateChain(const P2CTlsProofView& proof, CertificateChain& chain, std::string& error)
{
    if (proof.certificate_chain.empty()) return SetError(error, "P2C proof contains no leaf certificate");
    for (const auto certificate : proof.certificate_chain) {
        if (mbedtls_x509_crt_parse_der(&chain.value, certificate.data(), certificate.size()) != 0) {
            return SetError(error, "P2C proof contains an invalid DER certificate");
        }
    }
    return true;
}

bool IsLeapYear(int year)
{
    return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

int DaysInMonth(int year, int month)
{
    constexpr std::array<int, 12> DAYS{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (month < 1 || month > 12) return 0;
    return DAYS[month - 1] + (month == 2 && IsLeapYear(year) ? 1 : 0);
}

/** Days since 1970-01-01, valid for the Gregorian calendar. */
constexpr int64_t DaysFromCivil(int year, int month, int day)
{
    const int64_t adjusted_year{static_cast<int64_t>(year) - (month <= 2 ? 1 : 0)};
    const int64_t era{(adjusted_year >= 0 ? adjusted_year : adjusted_year - 399) / 400};
    const int64_t year_of_era{adjusted_year - era * 400};
    const int64_t adjusted_month{month > 2 ? month - 3 : month + 9};
    const int64_t day_of_year{(153 * adjusted_month + 2) / 5 + day - 1};
    const int64_t day_of_era{year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year};
    return era * 146097 + day_of_era - 719468;
}

static_assert(DaysFromCivil(1970, 1, 1) == 0);
static_assert(DaysFromCivil(2000, 3, 1) - DaysFromCivil(2000, 2, 28) == 2);
static_assert(DaysFromCivil(2100, 3, 1) - DaysFromCivil(2100, 2, 28) == 1);

bool X509TimeToUnix(const mbedtls_x509_time& time, int64_t& result)
{
    if (time.year < 1970 || time.mon < 1 || time.mon > 12 || time.day < 1 ||
        time.day > DaysInMonth(time.year, time.mon) || time.hour < 0 || time.hour > 23 ||
        time.min < 0 || time.min > 59 || time.sec < 0 || time.sec > 59) return false;
    const int64_t days{DaysFromCivil(time.year, time.mon, time.day)};
    if (days > (std::numeric_limits<int64_t>::max() - 86399) / 86400) return false;
    result = days * 86400 + int64_t{time.hour} * 3600 + int64_t{time.min} * 60 + time.sec;
    return true;
}

bool CheckSuppliedCertificateTimes(const mbedtls_x509_crt& chain, int64_t validation_time, std::string& error)
{
    if (validation_time <= 0) return SetError(error, "P2C certificate validation time is unavailable");
    for (const mbedtls_x509_crt* certificate{&chain}; certificate != nullptr; certificate = certificate->next) {
        int64_t valid_from{0};
        int64_t valid_to{0};
        if (!X509TimeToUnix(certificate->valid_from, valid_from) ||
            !X509TimeToUnix(certificate->valid_to, valid_to) ||
            validation_time < valid_from || validation_time > valid_to) {
            return SetError(error, "P2C certificate is not valid at block median time");
        }
    }
    return true;
}

bool VerifyDomainPath(mbedtls_x509_crt& chain, std::string_view domain,
                      const mbedtls_x509_crt& roots, std::string& error)
{
    std::string domain_string{domain};
    uint32_t flags{0};
    int result;
    {
        // The root DER is immutable, but Mbed TLS lazily populates RSA
        // Montgomery and EC precomputation caches in its parsed public keys.
        // Its classic backend has no configured threading support. Protect
        // path validation against concurrent consensus, worker and GUI probe
        // callers; each proof's private leaf/CV verification remains parallel.
        // Match the process lifetime of RootStoreV1, including detached probes
        // that finish during application shutdown. This retains no key data.
        static auto* const root_key_cache_mutex{new consensus::p2c::RootKeyCacheMutex};
        const std::lock_guard lock{*root_key_cache_mutex};
        // Select the same pinned, clock-independent path, but authenticate it
        // from the trust anchor towards the leaf. Stop at the first invalid
        // selected edge and never verify unanchored intermediates. Generic TLS
        // callers retain Mbed TLS's original callback/restartable semantics.
        result = connectcoin_mbedtls_x509_crt_verify_root_first(
            &chain, const_cast<mbedtls_x509_crt*>(&roots),
            &mbedtls_x509_crt_profile_default, domain_string.c_str(), &flags,
            /*observer=*/nullptr, /*observer_context=*/nullptr);
    }
    if (result != 0 || flags != 0) return SetError(error, "P2C certificate path or domain validation failed");
    return true;
}

bool CheckLeafUsage(const mbedtls_x509_crt& leaf, std::string& error)
{
    if (mbedtls_x509_crt_check_key_usage(&leaf, MBEDTLS_X509_KU_DIGITAL_SIGNATURE) != 0 ||
        mbedtls_x509_crt_check_extended_key_usage(
            &leaf, MBEDTLS_OID_SERVER_AUTH, MBEDTLS_OID_SIZE(MBEDTLS_OID_SERVER_AUTH)) != 0) {
        return SetError(error, "P2C leaf certificate is not authorized for TLS server signatures");
    }
    return true;
}

bool VerifyCertificateVerify(const mbedtls_x509_crt& leaf, const P2CTlsProofView& proof, std::string& error)
{
    std::array<unsigned char, 64> prefix;
    prefix.fill(0x20);
    uint256 signed_hash;
    CSHA256 digest;
    digest.Write(prefix.data(), prefix.size());
    digest.Write(reinterpret_cast<const unsigned char*>(TLS13_SERVER_CERTIFICATE_VERIFY_CONTEXT.data()),
                 TLS13_SERVER_CERTIFICATE_VERIFY_CONTEXT.size());
    const unsigned char separator{0};
    digest.Write(&separator, 1);
    digest.Write(proof.transcript_hash.begin(), proof.transcript_hash.size());
    digest.Finalize(signed_hash.begin());

    int result{-1};
    if (proof.certificate_verify_scheme == TLS_ECDSA_SECP256R1_SHA256) {
        mbedtls_ecp_keypair* ec{mbedtls_pk_ec(leaf.pk)};
        if (!ec || mbedtls_ecp_keypair_get_group_id(ec) != MBEDTLS_ECP_DP_SECP256R1) {
            return SetError(error, "CertificateVerify scheme does not match leaf EC key");
        }
        result = mbedtls_pk_verify_ext(MBEDTLS_PK_ECDSA, /*options=*/nullptr,
                                       const_cast<mbedtls_pk_context*>(&leaf.pk), MBEDTLS_MD_SHA256,
                                       signed_hash.begin(), signed_hash.size(),
                                       proof.certificate_verify_signature.data(), proof.certificate_verify_signature.size());
    } else if (proof.certificate_verify_scheme == TLS_RSA_PSS_RSAE_SHA256 ||
               proof.certificate_verify_scheme == TLS_RSA_PSS_PSS_SHA256) {
        if (!connectcoin_mbedtls_rsa_tls_scheme_matches(&leaf.pk, proof.certificate_verify_scheme) ||
            mbedtls_pk_get_bitlen(&leaf.pk) < 2048) {
            return SetError(error, "CertificateVerify scheme does not match leaf RSA key");
        }
        const mbedtls_pk_rsassa_pss_options options{
            .mgf1_hash_id = MBEDTLS_MD_SHA256,
            .expected_salt_len = 32,
        };
        result = mbedtls_pk_verify_ext(MBEDTLS_PK_RSASSA_PSS, &options,
                                       const_cast<mbedtls_pk_context*>(&leaf.pk), MBEDTLS_MD_SHA256,
                                       signed_hash.begin(), signed_hash.size(),
                                       proof.certificate_verify_signature.data(), proof.certificate_verify_signature.size());
    }
    if (result != 0) return SetError(error, "invalid P2C TLS CertificateVerify signature");
    return true;
}

bool VerifyP2CCertificateProofImpl(const CTxOut& spent_output,
                                   const P2CTlsProofView& proof,
                                   int64_t validation_time,
                                   const mbedtls_x509_crt& roots,
                                   std::string& error)
{
    error.clear();
    CertificateChain chain;
    if (!ParseCertificateChain(proof, chain, error) ||
        !CheckP2CCertificatePublicKeys(chain.value, error) ||
        !CheckSuppliedCertificateTimes(chain.value, validation_time, error) ||
        !CheckLeafUsage(chain.value, error)) {
        return false;
    }

    const auto output{spent_output.GetPayToDomain()};
    if (!output) return SetError(error, "spent output is not a canonical PAY_TO_CONNECT output");
    if (!P2CSignatureSchemeAllowed(output->signature_algorithms_mask, proof.certificate_verify_scheme)) {
        return SetError(error, "P2C CertificateVerify scheme is not allowed by the output");
    }
    if (!VerifyDomainPath(chain.value, output->domain, roots, error)) return false;
    return VerifyCertificateVerify(chain.value, proof, error);
}

} // namespace

bool CheckP2CCertificatePublicKeys(const mbedtls_x509_crt& chain, std::string& error)
{
    // Check ALL supplied certificates, including unused path candidates, before
    // Mbed TLS can perform any expensive signature verification. The pinned
    // adapter represents both rsaEncryption and restricted RSA-PSS keys as RSA;
    // pk_can_do(RSA) would incorrectly skip restricted RSA-PSS public keys.
    for (const mbedtls_x509_crt* certificate{&chain}; certificate != nullptr; certificate = certificate->next) {
        if (mbedtls_pk_get_type(&certificate->pk) != MBEDTLS_PK_RSA) continue;
        const mbedtls_rsa_context* rsa{mbedtls_pk_rsa(certificate->pk)};
        if (!rsa) return SetError(error, "P2C certificate RSA public key is unavailable");
        mbedtls_mpi exponent;
        mbedtls_mpi_init(&exponent);
        const int result{mbedtls_rsa_export(rsa, nullptr, nullptr, nullptr, nullptr, &exponent)};
        const size_t bits{mbedtls_mpi_bitlen(&exponent)};
        mbedtls_mpi_free(&exponent);
        if (result != 0) return SetError(error, "failed to read P2C certificate RSA public exponent");
        if (bits > MAX_P2C_RSA_PUBLIC_EXPONENT_BITS) {
            return SetError(error, "P2C certificate RSA public exponent exceeds 64 bits");
        }
    }
    return true;
}

bool P2CRootStoreAvailable()
{
    return RootStoreV1() != nullptr;
}

bool VerifyP2CCertificateProof(const CTxOut& spent_output,
                               const P2CTlsProofView& proof,
                               int64_t validation_time,
                               std::string& error)
{
    const auto output{spent_output.GetPayToDomain()};
    if (!output || !IsSupportedP2CRootCertificatesVersion(output->root_certificates_version)) {
        return SetError(error, "spent output is not a canonical PAY_TO_CONNECT output");
    }
    const mbedtls_x509_crt* roots{RootStoreV1()};
    if (!roots) return SetError(error, "failed to initialize immutable P2C root store");
    return VerifyP2CCertificateProofImpl(spent_output, proof, validation_time, *roots, error);
}

bool VerifyP2CCertificateProofForTest(const CTxOut& spent_output,
                                      const P2CTlsProofView& proof,
                                      int64_t validation_time,
                                      std::span<const unsigned char> trusted_roots_pem,
                                      std::string& error)
{
    CertificateChain roots;
    std::vector<unsigned char> nul_terminated{trusted_roots_pem.begin(), trusted_roots_pem.end()};
    nul_terminated.push_back(0);
    if (mbedtls_x509_crt_parse(&roots.value, nul_terminated.data(), nul_terminated.size()) != 0) {
        return SetError(error, "invalid P2C test root store");
    }
    if (!CheckP2CCertificatePublicKeys(roots.value, error)) return false;
    return VerifyP2CCertificateProofImpl(spent_output, proof, validation_time, roots.value, error);
}
