#include "apple_claims.h"
#include <cassert>
#include <cstring>

// Offline ABI ownership/error/cancellation checks. No capture of real domains.
int main() {
    char error[32]{};
    assert(cw_claim_limiter_create(0, error) == 0);
    assert(std::strcmp(error, "CLAIM_CONTEXT") == 0);
    const auto limiter = cw_claim_limiter_create(2, error);
    assert(limiter != 0 && error[0] == '\0');
    assert(cw_claim_limiter_set_rate(limiter, 3, error) == 1);
    assert(cw_claim_limiter_reset(limiter, error) == 1);
    const auto handle = cw_claim_cancellation_create(limiter, error);
    assert(handle != 0 && error[0] == '\0');
    assert(cw_claim_has_started(handle) == 0);
    assert(cw_claim_started_age_nanos(handle) == -1);
    cw_claim_result result{};
    assert(cw_claim_capture(nullptr, 100, handle, &result) == 0);
    assert(result.proof_hex == nullptr);
    assert(std::strcmp(result.error_code, "CLAIM_CONTEXT") == 0);
    cw_claim_result_free(&result);
    assert(result.error_code[0] == '\0');
    cw_claim_result_free(&result);
    char status[16]{};
    assert(cw_claim_probe_rsa(nullptr, 0, 100, handle, status, error) == 0);
    assert(status[0] == '\0' && std::strcmp(error, "CLAIM_CONTEXT") == 0);
    cw_claim_cancel(handle);
    cw_claim_cancellation_destroy(handle);
    assert(cw_claim_has_started(handle) == 0);
    assert(cw_claim_started_age_nanos(handle) == -1);
    cw_claim_limiter_destroy(limiter);
    return 0;
}
