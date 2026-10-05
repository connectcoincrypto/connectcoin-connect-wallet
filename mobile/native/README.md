# Public P2C native engine

This standalone CMake library captures **TLS 1.3 P2C version-2 proofs** and
verifies the complete certificate chain and CertificateVerify signature using
the Core consensus parser/verifier. It contains no wallet seed, reward address,
normal-transaction signer, broadcast method, or automatic startup.

## Provenance and licensing

`vendor/core/provenance.json` pins the copied Core source and its checkout
revision. Only LF normalization is permitted in those copies. The small
`compat/` adapters replace full-node types, SHA256 wrappers, and tagged-hash
serialization; they do not reimplement the certificate verifier. Core-derived
code is under `vendor/core/COPYING` (MIT).

CMake downloads **Mbed TLS 3.6.7** from its official release and checks archive
SHA256 `a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6`.
The copied Core patches preserve RSA-PSS SubjectPublicKeyInfo identity and
restrictions and deterministic root-first certificate path validation.
`vendor/MBEDTLS-LICENSE` preserves Mbed TLS's Apache-2.0/GPL-2.0-or-later dual
license; `vendor/NOTICE` preserves bundled contributor attribution. Distribution
selects Apache-2.0. Keep both license files and NOTICE with app/library builds.

The version-1 trust bundle is immutable and checked by CMake against SHA256
`f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9`.
No Android/Apple platform trust substitution or local-clock chain selection is
used for P2C consensus validation.

## Native contract

`NativeClaims.captureAndVerify` is a worker-thread-only JNI call. The caller
supplies canonical public domain, 32-byte raw ClientHello challenge hex,
display-order uint256 target, root version, allowed-signature mask, consensus
validation time, timeout (1–10000 ms), and cancellation handle. Only public DNS
addresses and port 443 are accepted; local, mapped, transition, documentation
and private ranges are rejected. DNS is resolved once and the chosen numeric
endpoint is used directly, preventing a second DNS lookup bypass.

Successful attempts return public JSON fields `proof`, `validProof`,
`meetsTarget`, `durationMs`, and `errorCode`. A valid certificate/signature counts
as a valid proof even when its hash misses the target. Completed TCP/TLS failures
return false plus a fixed error code and TCP/TLS duration. Cancellation, local
configuration/setup failures and pre-TCP DNS failures throw; do not count these
neutral failures as certificate-invalid EMA samples. Duration excludes DNS and
the final synchronous certificate verification.

There are at most four active captures, 32 live handles, and two unfinished OS
DNS workers. Cancel shuts down the socket; its owner closes it. OS `getaddrinfo`
cannot be interrupted portably, but an abandoned worker never opens a socket or
publishes a result. TLS polling checks cancellation/deadline at most every
100 ms; bounded synchronous crypto is checked immediately before/after. A
non-threaded Mbed TLS/PSA configuration is protected by one crypto-call mutex;
network waits are not serialized. Ephemeral key material uses only OS CSPRNG
(Linux/Android kernel getrandom, Windows BCryptGenRandom, Apple
SecRandomCopyBytes). Only the designated ClientHello random is the public
challenge; all other TLS randomness remains fresh.

The owning native service must enforce explicit user Start, foreground/background
policy, mobile-data preference, rate/worker budgets and handle cancellation on
Stop. The engine itself does not request notification permission, create a
foreground service, discover bounties, or send transactions.

## Offline and loopback verification

```sh
node mobile/native/tools/check-provenance.mjs
cmake -S mobile/native -B mobile/.tools/native-host -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCONNECTWALLET_NATIVE_TESTS=ON
cmake --build mobile/.tools/native-host --parallel 2
ctest --test-dir mobile/.tools/native-host --output-on-failure
python -m pip install --only-binary=:all: -r helpers/requirements.txt
python mobile/native/tests/test_oracle.py --cli mobile/.tools/native-host/p2c_test_cli -v
```

On Windows use the executable's `.exe` suffix and the existing desktop claims
venv. The Python verifier remains pinned to cryptography 50.0.1. Synthetic
identities are generated in a temporary directory; no user wallet or real domain
is queried. The tests cover ECDSA, RSAE-PSS, restricted RSA-PSS keys, exponent
limits, target equality/misses, transcript tampering, trust/domain/time/mask
rejections, name constraints, real completed TLS handshakes against loopback,
fresh ephemeral keys, timeout and cancellation. Test-only root/loopback overrides
are compile-time guarded; CMake rejects enabling them for an Android build.

Android builds produce `libconnectwallet_claims.so` for arm64-v8a/x86_64 with
16-KiB load-segment alignment. Apple CI compiles native static libraries for iOS
device/simulator and runs the host oracle on macOS. **That is not an iOS app,
App Store package, or proof of iOS background-execution support.**
