# The vendored consensus verifier stays byte-for-byte pinned. This generated
# mobile translation unit changes ONLY ownership of mutable root-key caches.
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
string(REPLACE
  "        result = connectcoin_mbedtls_x509_crt_verify_root_first("
  "#ifdef CONNECTWALLET_NATIVE_TESTS\n        connectwallet::NativeVerificationObserverForTest(&roots);\n#endif\n        result = connectcoin_mbedtls_x509_crt_verify_root_first("
  VERIFIER_SOURCE "${VERIFIER_SOURCE}")
set(MOBILE_VERIFIER "${CMAKE_CURRENT_BINARY_DIR}/generated/consensus/p2c_x509_mobile.cpp")
file(WRITE "${MOBILE_VERIFIER}" "// Generated mobile adaptation: root caches have thread-owned RAII lifetime.\n// Original process-lifetime/shared-cache comments below describe upstream only.\n#ifdef CONNECTWALLET_NATIVE_TESTS\nnamespace connectwallet { void NativeVerificationObserverForTest(const void*); }\n#endif\n${VERIFIER_SOURCE}\n#ifdef _WIN32\nvoid ReleaseMobileP2CRootStoreForThread() { RootStoreV1(true); }\n#endif\n")
