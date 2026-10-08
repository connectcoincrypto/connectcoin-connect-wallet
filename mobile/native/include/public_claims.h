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
    bool captured{false}, validation_passed{false}, valid_proof{false}, meets_target{false};
    int64_t duration_ms{0};
    std::string error_code;
};
// Bounded process-local cancellation; unknown/destroyed/reused handles fail shut.
void InitializeCrypto();
int64_t CreateStartLimiter(int rate);
void SetStartRate(int64_t limiter,int rate);
// Rebase overdue pacing after cancelling a paused/stopped run, without clearing
// actual-start history or moving a still-future deadline earlier.
void ResetStartSchedule(int64_t limiter);
void DestroyStartLimiter(int64_t limiter);
int64_t CreateCancellation(int64_t limiter=0);
// True only once this handle's capture has reached the actual TCP connect call.
// Unknown/destroyed handles return false; the owner queries before destruction.
bool HasStarted(int64_t handle);
// Monotonic nanoseconds captured immediately before connect; zero if unstarted.
// Native diagnostics only; the Java bridge uses age to avoid epoch assumptions.
int64_t StartedAtNanos(int64_t handle);
int64_t StartedAgeNanos(int64_t handle);
void Cancel(int64_t handle);
void DestroyCancellation(int64_t handle);
ClaimResult CaptureAndVerify(const PublicClaimContext&, int timeout_ms, int64_t handle);
// Advisory completed TLS 1.3 RSA capability check. Fixed roots 1/mask 6/max
// target and fresh OS randomness; returns only a sanitized status, never proof.
std::string ProbeRsa(const std::string& domain, int64_t validation_time, int timeout_ms, int64_t handle);
ClaimResult VerifyProof(const PublicClaimContext&, std::span<const unsigned char> proof);
#ifdef CONNECTWALLET_NATIVE_TESTS
void SetVerificationObserverForTest(void (*observer)(const void*));
// Test-only APIs cannot be compiled into an Android library. No production call
// can select another root, port, or endpoint (even via a private JNI method).
ClaimResult VerifyProofForTest(const PublicClaimContext&, std::span<const unsigned char> proof, std::span<const unsigned char> roots);
ClaimResult CaptureLoopbackForTest(const PublicClaimContext&, int timeout_ms, int64_t handle, uint16_t port, std::span<const unsigned char> roots);
std::string ProbeRsaLoopbackForTest(const std::string& domain, int64_t validation_time, int timeout_ms, int64_t handle, uint16_t port, std::span<const unsigned char> roots);
#endif
bool IsPublicAddress(std::string_view address);
std::vector<unsigned char> DecodeHex(std::string_view text, size_t maximum);
std::string EncodeHex(std::span<const unsigned char> bytes);
}
