#include "apple_claims.h"
#include "public_claims.h"
#include <cstdlib>
#include <cstring>
#include <exception>
#include <new>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {
void Error(char* destination, const char* candidate) noexcept {
    if (!destination) return;
    std::string_view code = candidate ? candidate : "";
    bool known = false;
    for (const auto allowed : {"CLAIM_CONTEXT", "CLAIM_MEMORY", "CLAIM_CANCELLED", "CLAIM_TIMEOUT",
            "CLAIM_BUSY", "CLAIM_NETWORK", "CLAIM_DNS", "CLAIM_TLS", "CLAIM_CERTIFICATE",
            "CLAIM_CRYPTO", "CLAIM_NATIVE"}) {
        if (code == allowed) { known = true; break; }
    }
    if (!known) code = "CLAIM_NATIVE";
    std::memcpy(destination, code.data(), code.size());
    destination[code.size()] = '\0';
}
std::string Text(const char* value, size_t maximum) {
    if (!value) throw std::runtime_error("CLAIM_CONTEXT");
    size_t length = 0;
    while (length <= maximum && value[length]) ++length;
    if (length == 0 || length > maximum) throw std::runtime_error("CLAIM_CONTEXT");
    return std::string(value, length);
}
template <typename Operation> int32_t Guard(char* error, Operation operation) noexcept {
    if (error) error[0] = '\0';
    try { operation(); return 1; }
    catch (const std::bad_alloc&) { Error(error, "CLAIM_MEMORY"); }
    catch (const std::exception& failure) { Error(error, failure.what()); }
    catch (...) { Error(error, "CLAIM_NATIVE"); }
    return 0;
}
}

extern "C" int64_t cw_claim_limiter_create(int32_t rate, char* error) {
    int64_t limiter = 0;
    Guard(error, [&] { limiter = connectwallet::CreateStartLimiter(rate); });
    return limiter;
}
extern "C" int32_t cw_claim_limiter_set_rate(int64_t limiter, int32_t rate, char* error) {
    return Guard(error, [&] { connectwallet::SetStartRate(limiter, rate); });
}
extern "C" int32_t cw_claim_limiter_reset(int64_t limiter, char* error) {
    return Guard(error, [&] { connectwallet::ResetStartSchedule(limiter); });
}
extern "C" void cw_claim_limiter_destroy(int64_t limiter) {
    Guard(nullptr, [&] { connectwallet::DestroyStartLimiter(limiter); });
}
extern "C" int64_t cw_claim_cancellation_create(int64_t limiter, char* error) {
    int64_t handle = 0;
    Guard(error, [&] { handle = connectwallet::CreateCancellation(limiter); });
    return handle;
}
extern "C" void cw_claim_cancel(int64_t handle) {
    Guard(nullptr, [&] { connectwallet::Cancel(handle); });
}
extern "C" void cw_claim_cancellation_destroy(int64_t handle) {
    Guard(nullptr, [&] { connectwallet::DestroyCancellation(handle); });
}
extern "C" int32_t cw_claim_has_started(int64_t handle) {
    int32_t started = 0;
    Guard(nullptr, [&] { started = connectwallet::HasStarted(handle) ? 1 : 0; });
    return started;
}
extern "C" int64_t cw_claim_started_age_nanos(int64_t handle) {
    int64_t age = -1;
    Guard(nullptr, [&] { age = connectwallet::StartedAgeNanos(handle); });
    return age;
}
extern "C" int32_t cw_claim_capture(const cw_claim_context* input, int32_t timeout,
        int64_t handle, cw_claim_result* output) {
    if (!output) return 0;
    // The caller must free any previous result before reusing this structure.
    std::memset(output, 0, sizeof(*output));
    return Guard(output->error_code, [&] {
        if (!input) throw std::runtime_error("CLAIM_CONTEXT");
        connectwallet::PublicClaimContext context{Text(input->domain, 253), Text(input->challenge_hex, 64),
            Text(input->target_hex, 64), input->roots_version, input->signature_mask, input->validation_time};
        const auto result = connectwallet::CaptureAndVerify(context, timeout, handle);
        if (result.proof_hex.size() > 2 * 64 * 1024) throw std::runtime_error("CLAIM_NATIVE");
        char* proof = static_cast<char*>(std::malloc(result.proof_hex.size() + 1));
        if (!proof) throw std::bad_alloc();
        std::memcpy(proof, result.proof_hex.c_str(), result.proof_hex.size() + 1);
        output->proof_hex = proof;
        output->captured = result.captured;
        output->validation_passed = result.validation_passed;
        output->valid_proof = result.valid_proof;
        output->meets_target = result.meets_target;
        output->duration_ms = result.duration_ms;
        if (!result.error_code.empty()) Error(output->error_code, result.error_code.c_str());
    });
}
extern "C" void cw_claim_result_free(cw_claim_result* result) {
    if (!result) return;
    std::free(result->proof_hex);
    std::memset(result, 0, sizeof(*result));
}
extern "C" int32_t cw_claim_probe_rsa(const char* domain, int64_t time,
        int32_t timeout, int64_t handle, char* status, char* error) {
    if (status) status[0] = '\0';
    return Guard(error, [&] {
        if (!status) throw std::runtime_error("CLAIM_CONTEXT");
        const auto result = connectwallet::ProbeRsa(Text(domain, 253), time, timeout, handle);
        if (result != "verified" && result != "failed" && result != "timeout" &&
                result != "busy" && result != "unavailable") throw std::runtime_error("CLAIM_NATIVE");
        std::memcpy(status, result.c_str(), result.size() + 1);
    });
}
