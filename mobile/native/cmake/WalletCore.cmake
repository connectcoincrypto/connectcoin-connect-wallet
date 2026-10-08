# Optional native wallet core. Android's existing Java/JNI wallet is unchanged.
set(SECP256K1_BUILD_BENCHMARK OFF CACHE BOOL "" FORCE)
set(SECP256K1_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(SECP256K1_BUILD_EXHAUSTIVE_TESTS OFF CACHE BOOL "" FORCE)
set(SECP256K1_BUILD_CTIME_TESTS OFF CACHE BOOL "" FORCE)
set(SECP256K1_ENABLE_MODULE_SCHNORRSIG ON CACHE BOOL "" FORCE)
set(SECP256K1_ENABLE_MODULE_EXTRAKEYS ON CACHE BOOL "" FORCE)
set(SECP256K1_ENABLE_MODULE_MUSIG OFF CACHE BOOL "" FORCE)
set(SECP256K1_DISABLE_SHARED ON CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(walletsecp
  URL https://github.com/bitcoin-core/secp256k1/archive/refs/tags/v0.6.0.tar.gz
  URL_HASH SHA256=785bb98e7d6705c51c8dfa8ac3af6aa2ccfa3774714d51c0b9e28fac1146e9f1)
FetchContent_MakeAvailable(walletsecp)
FetchContent_Declare(walletscrypt
  URL https://www.tarsnap.com/scrypt/scrypt-1.3.3.tgz
  URL_HASH SHA256=1c2710517e998eaac2e97db11f092e37139e69886b21a1b2661f64e130215ae9)
FetchContent_MakeAvailable(walletscrypt)
# Use upstream's portable reference, not platform autotools/cpu-dispatch state.
# The only transformation erases allocated work areas and temporary Salsa state.
# All input parameters are fixed by the native facade before entering this code.
file(READ "${walletscrypt_SOURCE_DIR}/lib/crypto/crypto_scrypt-ref.c" SCRYPT_REFERENCE)
string(REPLACE "#include \"sha256.h\"" "#include \"sha256.h\"\n#include \"insecure_memzero.h\"" SCRYPT_REFERENCE "${SCRYPT_REFERENCE}")
string(REPLACE "free(V);" "insecure_memzero(V, 128 * r * N); free(V);" SCRYPT_REFERENCE "${SCRYPT_REFERENCE}")
string(REPLACE "free(XY);" "insecure_memzero(XY, 256 * r); free(XY);" SCRYPT_REFERENCE "${SCRYPT_REFERENCE}")
string(REPLACE "free(B);" "insecure_memzero(B, 128 * r * p); free(B);" SCRYPT_REFERENCE "${SCRYPT_REFERENCE}")
string(REPLACE "le32enc(&B[4 * i], B32[i]);" "le32enc(&B[4 * i], B32[i]);\n\tinsecure_memzero(B32, sizeof(B32));\n\tinsecure_memzero(x, sizeof(x));" SCRYPT_REFERENCE "${SCRYPT_REFERENCE}")
string(REPLACE "blkcpy(&B[(i + r) * 64], &Y[(i * 2 + 1) * 64], 64);" "blkcpy(&B[(i + r) * 64], &Y[(i * 2 + 1) * 64], 64);\n\tinsecure_memzero(X, sizeof(X));" SCRYPT_REFERENCE "${SCRYPT_REFERENCE}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/generated/wallet_scrypt.c" "${SCRYPT_REFERENCE}")
add_library(connectwallet_scrypt STATIC
  "${CMAKE_CURRENT_BINARY_DIR}/generated/wallet_scrypt.c"
  "${walletscrypt_SOURCE_DIR}/libcperciva/alg/sha256.c"
  "${walletscrypt_SOURCE_DIR}/libcperciva/util/insecure_memzero.c")
target_include_directories(connectwallet_scrypt PRIVATE
  "${walletscrypt_SOURCE_DIR}/libcperciva/alg" "${walletscrypt_SOURCE_DIR}/libcperciva/util"
  "${walletscrypt_SOURCE_DIR}/libcperciva/cpusupport")
target_include_directories(connectwallet_scrypt PUBLIC "${walletscrypt_SOURCE_DIR}/lib-platform/crypto")
if(NOT MSVC)
  target_compile_options(connectwallet_scrypt PRIVATE -O2)
endif()
add_library(connectwallet_wallet STATIC src/wallet_crypto.cpp)
target_include_directories(connectwallet_wallet PUBLIC include)
target_link_libraries(connectwallet_wallet PUBLIC connectwallet_p2c secp256k1 connectwallet_scrypt)
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/licenses")
configure_file("${walletsecp_SOURCE_DIR}/COPYING" "${CMAKE_CURRENT_BINARY_DIR}/licenses/LICENSE-SECP256K1.txt" COPYONLY)
configure_file("${walletscrypt_SOURCE_DIR}/COPYRIGHT" "${CMAKE_CURRENT_BINARY_DIR}/licenses/LICENSE-SCRYPT.txt" COPYONLY)
if(CONNECTWALLET_NATIVE_TESTS)
  add_executable(wallet_crypto_test tests/wallet_crypto_test.cpp)
  target_link_libraries(wallet_crypto_test PRIVATE connectwallet_wallet)
  add_test(NAME native_wallet_crypto COMMAND wallet_crypto_test)
endif()
