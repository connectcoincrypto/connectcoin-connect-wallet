# Imported from the claimer's pinned provider adapters. Only multiplication and
# compression change; key decoding, fresh randomness and all validation remain.
option(CONNECTWALLET_X25519_ACCELERATION "Use bundled HACL for PSA X25519" ON)
option(CONNECTWALLET_SHA256_ACCELERATION "Use runtime-selected SHA-256 compression" ON)
option(CONNECTWALLET_CRYPTO_INSTRUMENTATION "Instrument provider dispatch in offline tests" OFF)
if(CONNECTWALLET_CRYPTO_INSTRUMENTATION AND (NOT CONNECTWALLET_NATIVE_TESTS OR ANDROID OR IOS))
  message(FATAL_ERROR "Crypto instrumentation is restricted to offline host tests")
endif()
target_include_directories(mbedcrypto PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/vendor/mbedtls-adapters")
if(CONNECTWALLET_X25519_ACCELERATION)
  target_compile_definitions(everest PUBLIC CONNECTCOIN_X25519_ACCELERATION)
  target_sources(mbedcrypto PRIVATE vendor/mbedtls-adapters/mbedtls_x25519.c)
  target_include_directories(mbedcrypto PRIVATE
    "${mbed_SOURCE_DIR}/3rdparty/everest/include/everest"
    "${mbed_SOURCE_DIR}/3rdparty/everest/include/everest/kremlib")
  if(CONNECTWALLET_CRYPTO_INSTRUMENTATION)
    target_compile_definitions(mbedcrypto PUBLIC CONNECTCOIN_X25519_TESTING)
  endif()
endif()
if(CONNECTWALLET_SHA256_ACCELERATION)
  target_compile_definitions(mbedcrypto PUBLIC CONNECTCOIN_SHA256_ACCELERATION)
  target_sources(mbedcrypto PRIVATE vendor/mbedtls-adapters/mbedtls_sha256.cpp
    vendor/mbedtls-adapters/mbedtls_sha256_portable.c)
  if(CONNECTWALLET_CRYPTO_INSTRUMENTATION)
    target_compile_definitions(mbedcrypto PUBLIC CONNECTCOIN_SHA256_TESTING)
  endif()
  # Never apply x86 instructions to ARM devices or Apple universal libraries.
  # The dispatcher still checks SHA/SSSE3/SSE4.1 at runtime on x86-64 hosts.
  if(CMAKE_SIZEOF_VOID_P EQUAL 8 AND
     (NOT CMAKE_VS_PLATFORM_NAME OR CMAKE_VS_PLATFORM_NAME STREQUAL "x64") AND
     (NOT APPLE OR NOT CMAKE_OSX_ARCHITECTURES OR CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64"))
    include(CheckCXXSourceCompiles)
    check_cxx_source_compiles("
      #if defined(__aarch64__) || defined(_M_ARM64) || defined(_M_ARM64EC)
      #error not an x86-64 target
      #endif
      #if !defined(__x86_64__) && !defined(_M_X64)
      #error not an x86-64 target
      #endif
      int main() { return 0; }
    " CONNECTWALLET_SHA256_COMPILER_X86_64)
    if(CONNECTWALLET_SHA256_COMPILER_X86_64)
      target_compile_definitions(mbedcrypto PRIVATE CONNECTCOIN_SHA256_X86_BACKEND)
      target_sources(mbedcrypto PRIVATE vendor/bitcoin-core/sha256_x86_shani.cpp)
      set_source_files_properties("${CMAKE_CURRENT_SOURCE_DIR}/vendor/bitcoin-core/sha256_x86_shani.cpp"
        TARGET_DIRECTORY mbedcrypto PROPERTIES COMPILE_DEFINITIONS "ENABLE_SSE41;ENABLE_X86_SHANI")
      if(NOT MSVC)
        set_source_files_properties("${CMAKE_CURRENT_SOURCE_DIR}/vendor/bitcoin-core/sha256_x86_shani.cpp"
          TARGET_DIRECTORY mbedcrypto PROPERTIES COMPILE_OPTIONS "-msha;-mssse3;-msse4.1")
      endif()
    endif()
  endif()
endif()
