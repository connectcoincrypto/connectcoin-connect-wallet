// Only the immutable public context used by the unmodified Core verifier.
// No transaction parser, signer, wallet, or implicit serialization is present.
#pragma once
#include <uint256.h>
#include <optional>
#include <string>
#include <string_view>
enum class TxOutputType : uint8_t { INVALID=0, P2PK=1, PAY_TO_CONNECT=2 };
struct PayToDomainOutput {
    static constexpr uint8_t SIGNATURE_ALGORITHM_ECDSA_P256_SHA256=1;
    static constexpr uint8_t SIGNATURE_ALGORITHM_RSA_PSS_RSAE_SHA256=2;
    static constexpr uint8_t SIGNATURE_ALGORITHM_RSA_PSS_PSS_SHA256=4;
    static constexpr uint8_t SIGNATURE_ALGORITHMS_ALL=7;
    std::string domain;
    uint256 connection_work_target{};
    uint32_t root_certificates_version{};
    uint8_t signature_algorithms_mask{};
};
inline bool IsValidP2CSignatureAlgorithmsMask(uint8_t mask) { return mask && !(mask & ~7); }
inline bool IsCanonicalP2CDomain(std::string_view domain) {
    if (domain.empty() || domain.size()>253 || domain.back()=='.') return false;
    size_t label=0;
    for (size_t i=0; i<domain.size(); ++i) {
        unsigned char ch=domain[i];
        if(ch=='.') { if(!label || label>63 || domain[i-1]=='-') return false; label=0; }
        else { if (!((ch>='a' && ch<='z') || (ch>='0' && ch<='9') || ch=='-') || (!label && ch=='-')) return false; ++label; }
    }
    return label>0 && label<=63 && domain.back()!='-';
}
class CTxOut {
    PayToDomainOutput output;
public:
    explicit CTxOut(PayToDomainOutput value): output(std::move(value)) {}
    TxOutputType GetType() const { return TxOutputType::PAY_TO_CONNECT; }
    std::optional<PayToDomainOutput> GetPayToDomain() const { return IsCanonicalP2CDomain(output.domain) && IsValidP2CSignatureAlgorithmsMask(output.signature_algorithms_mask) ? std::optional{output} : std::nullopt; }
};
// Used only by Core's public challenge function: caller supplies a verified txid
// in its native little-endian byte representation, never a transaction object.
class CTransaction {
    uint256 txid;
public:
    explicit CTransaction(uint256 verified_txid): txid(verified_txid) {}
    const uint256& GetHash() const { return txid; }
};
