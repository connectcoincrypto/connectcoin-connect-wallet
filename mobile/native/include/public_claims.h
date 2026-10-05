#pragma once
#include <cstdint>
#include <span>
#include <string>
#include <vector>
namespace connectwallet {
struct PublicClaimContext {
    std::string domain, challenge_hex, target_hex;
    int roots_version, signature_mask;
    int64_t validation_time;
};
struct ClaimResult {
    std::string proof_hex;
    bool valid_proof{false}, meets_target{false};
    int64_t duration_ms{0};
    std::string error_code;
};
// Bounded process-local cancellation; unknown/destroyed/reused handles fail shut.
int64_t CreateCancellation();
void Cancel(int64_t handle);
void DestroyCancellation(int64_t handle);
ClaimResult CaptureAndVerify(const PublicClaimContext&, int timeout_ms, int64_t handle);
ClaimResult VerifyProof(const PublicClaimContext&, std::span<const unsigned char> proof);
#ifdef CONNECTWALLET_NATIVE_TESTS
// Test-only APIs cannot be compiled into an Android library. No production call
// can select another root, port, or endpoint (even via a private JNI method).
ClaimResult VerifyProofForTest(const PublicClaimContext&, std::span<const unsigned char> proof, std::span<const unsigned char> roots);
ClaimResult CaptureLoopbackForTest(const PublicClaimContext&, int timeout_ms, int64_t handle, uint16_t port, std::span<const unsigned char> roots);
#endif
bool IsPublicAddress(std::string_view address);
std::vector<unsigned char> DecodeHex(std::string_view text, size_t maximum);
std::string EncodeHex(std::span<const unsigned char> bytes);
}
