#ifndef CONNECTWALLET_APPLE_CLAIMS_H
#define CONNECTWALLET_APPLE_CLAIMS_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Stable C ABI over the production public-proof engine. No wallet secrets,
 * private endpoints, alternate roots, or test override are accepted here. */
typedef struct cw_claim_context {
    const char *domain;
    const char *challenge_hex;
    const char *target_hex;
    int32_t roots_version;
    int32_t signature_mask;
    int64_t validation_time;
} cw_claim_context;

typedef struct cw_claim_result {
    char *proof_hex; /* At most 128 KiB hex plus NUL. Owned; free with cw_claim_result_free. */
    int32_t captured;
    int32_t validation_passed;
    int32_t valid_proof;
    int32_t meets_target;
    int64_t duration_ms;
    char error_code[32];
} cw_claim_result;

/* Failure returns 0 and writes one fixed CLAIM_* code when error is non-null.
 * Every error buffer supplied to these functions must hold at least 32 bytes. */
int64_t cw_claim_limiter_create(int32_t rate, char *error);
int32_t cw_claim_limiter_set_rate(int64_t limiter, int32_t rate, char *error);
int32_t cw_claim_limiter_reset(int64_t limiter, char *error);
void cw_claim_limiter_destroy(int64_t limiter);
int64_t cw_claim_cancellation_create(int64_t limiter, char *error);
void cw_claim_cancel(int64_t handle);
void cw_claim_cancellation_destroy(int64_t handle);
int32_t cw_claim_has_started(int64_t handle);
int64_t cw_claim_started_age_nanos(int64_t handle);

/* Initialize result to zero before first use, and free once after every call.
 * A return value of 1 means an attempt completed, even if its proof was invalid.
 * A return value of 0 is a neutral exception/cancellation/setup failure. */
int32_t cw_claim_capture(const cw_claim_context *context, int32_t timeout_ms,
    int64_t handle, cw_claim_result *result);
void cw_claim_result_free(cw_claim_result *result);

/* Returns 1 with one bounded status in status[16], or 0 with error[32]. */
int32_t cw_claim_probe_rsa(const char *domain, int64_t validation_time,
    int32_t timeout_ms, int64_t handle, char *status, char *error);

#ifdef __cplusplus
}
#endif
#endif
