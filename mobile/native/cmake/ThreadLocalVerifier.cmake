# The vendored consensus verifier stays byte-for-byte pinned. This generated
# mobile translation unit adapts ownership and memoizes immutable DER/static
# signature math. Every context-dependent validation remains per proof.
# Fail closed if the reviewed source changes; review again on a Core upgrade.
file(READ "${CORE}/src/consensus/p2c_x509.cpp" VERIFIER_SOURCE)
string(REPLACE "\r\n" "\n" VERIFIER_SOURCE "${VERIFIER_SOURCE}")
string(SHA256 VERIFIER_HASH "${VERIFIER_SOURCE}")
if(NOT VERIFIER_HASH STREQUAL "5cdfa83166651fccb55da4b8592111416446f357e96adabad1e6db5e8334eed7")
  message(FATAL_ERROR "Review mobile thread-local verifier adaptation after Core source changes")
endif()
string(REPLACE
  "const mbedtls_x509_crt* RootStoreV1()"
  "const mbedtls_x509_crt* RootStoreV1(bool release = false)"
  VERIFIER_SOURCE "${VERIFIER_SOURCE}")
string(REPLACE
  "static const RootStore* const roots{new RootStore};\n    return roots->valid ? &roots->chain.value : nullptr;"
  "#ifdef _WIN32\n    // MinGW TLS destructors race emulated-TLS teardown. An outer RAII lease\n    // deletes this thread-owned cache before the worker leaves its call.\n    static thread_local RootStore* roots = nullptr;\n    if (release) { delete roots; roots = nullptr; return nullptr; }\n    if (!roots) roots = new RootStore;\n    return roots->valid ? &roots->chain.value : nullptr;\n#else\n    (void)release;\n    static thread_local const RootStore roots;\n    return roots.valid ? &roots.chain.value : nullptr;\n#endif"
  VERIFIER_SOURCE "${VERIFIER_SOURCE}")
string(REPLACE
  "static auto* const root_key_cache_mutex{new consensus::p2c::RootKeyCacheMutex};\n        const std::lock_guard lock{*root_key_cache_mutex};"
  "// Mobile: roots and their mutable key caches are owned by this thread."
  VERIFIER_SOURCE "${VERIFIER_SOURCE}")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/generated/consensus")
function(mobile_verifier_replace old new)
  p2c_mbedtls_count("${VERIFIER_SOURCE}" "${old}" count)
  if(NOT count EQUAL 1)
    message(FATAL_ERROR "Mobile verifier cache expected one reviewed source block, found ${count}")
  endif()
  string(REPLACE "${old}" "${new}" updated "${VERIFIER_SOURCE}")
  set(VERIFIER_SOURCE "${updated}" PARENT_SCOPE)
endfunction()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/verifier_cache.inc")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/src/verifier_cache.inc" CACHE_SOURCE)
mobile_verifier_replace("bool CheckSuppliedCertificateTimes(" "${CACHE_SOURCE}\nbool CheckSuppliedCertificateTimes(")
mobile_verifier_replace("        result = connectcoin_mbedtls_x509_crt_verify_root_first("
  "        const connectcoin_mbedtls_x509_signature_cache cache{nullptr, MobileSignatureLookup, MobileSignatureRemember};\n        result = connectcoin_mbedtls_x509_crt_verify_root_first_cached(")
mobile_verifier_replace("/*observer=*/nullptr, /*observer_context=*/nullptr);"
  "/*observer=*/nullptr, /*observer_context=*/nullptr, &cache);")
mobile_verifier_replace([=[    CertificateChain chain;
    if (!ParseCertificateChain(proof, chain, error) ||
        !CheckP2CCertificatePublicKeys(chain.value, error) ||
        !CheckSuppliedCertificateTimes(chain.value, validation_time, error) ||
        !CheckLeafUsage(chain.value, error)) {
        return false;
    }]=] [=[    const auto cached = MobileCertificates(proof, error);
    if (!cached || !MobileCheckCertificateTime(*cached, validation_time, error)) return false;
    auto& chain = cached->chain;]=])
string(REPLACE
  "        result = connectcoin_mbedtls_x509_crt_verify_root_first_cached("
  "#ifdef CONNECTWALLET_NATIVE_TESTS\n        connectwallet::NativeVerificationObserverForTest(&roots);\n#endif\n        result = connectcoin_mbedtls_x509_crt_verify_root_first_cached("
  VERIFIER_SOURCE "${VERIFIER_SOURCE}")
set(MOBILE_VERIFIER "${CMAKE_CURRENT_BINARY_DIR}/generated/consensus/p2c_x509_mobile.cpp")
file(WRITE "${MOBILE_VERIFIER}" "// Generated mobile adaptation: thread-owned immutable DER/static signature caches.\n// Original process-lifetime/shared-cache comments below describe upstream only.\n#include <algorithm>\n#include <deque>\n#include <memory>\n#ifdef CONNECTWALLET_NATIVE_TESTS\nnamespace connectwallet { void NativeVerificationObserverForTest(const void*); }\n#endif\n${VERIFIER_SOURCE}\n#ifdef _WIN32\nvoid ReleaseMobileP2CRootStoreForThread() { RootStoreV1(true); MobileCaches(true); }\n#endif\n")
file(APPEND "${MOBILE_VERIFIER}" "\n#ifdef CONNECTWALLET_NATIVE_TESTS\nstd::array<size_t,4> MobileVerifierCacheStatsForTest() { const auto& cache=*MobileCaches(); return {cache.parse_hits,cache.parse_misses,cache.time_checks,cache.signature_hits}; }\n#endif\n")
file(APPEND "${MOBILE_VERIFIER}" "\n#ifdef CONNECTWALLET_NATIVE_TESTS\nvoid CheckMobileVerifierLruForTest(const P2CTlsProofView& proof) { MobileCheckLru(proof); }\n#endif\n")
