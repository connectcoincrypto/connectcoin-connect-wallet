# Public P2C native engine

This standalone CMake library captures **TLS 1.3 P2C version-2 proofs** and
verifies the complete certificate chain and CertificateVerify signature using
the Core consensus parser/verifier with thread-local root-cache ownership. It contains no wallet seed, reward address,
normal-transaction signer, broadcast method, or automatic startup.

Capture stops immediately after the server's `CertificateVerify`, like Core's
claim worker: it does not wait for server `Finished` or send client `Finished`.
The entire captured proof still undergoes consensus certificate-chain and
signature verification before it can be returned as valid.

The separate advisory RSA capability probe completes the TLS 1.3 handshake:
server `Finished` must authenticate and client `Finished` must be sent. It then
requires the same pinned consensus certificate/signature validation. It never
sends HTTP or application data. Probe success is not based on claim-capture
success alone and does not change the existing claim worker's stopping point.

## Provenance and licensing

`vendor/core/provenance.json` pins the copied Core source and its checkout
revision. Only LF normalization is permitted in those copies. The small
`compat/` adapters replace full-node types, SHA256 wrappers, and tagged-hash
serialization; they do not reimplement the certificate verifier. Core-derived
code is under `vendor/core/COPYING` (MIT). The mobile build generates a derivative
of `p2c_x509.cpp` using `cmake/ThreadLocalVerifier.cmake`, which verifies the full
pinned source hash before changing only root-store ownership and removing its
now-unneeded shared-cache lock. Certificate rules, root bytes and path selection stay unchanged;
the vendored source remains pristine. Each worker owns its parsed root keys,
including Mbed TLS's mutable RSA/EC precomputation caches, and releases them when
its OS thread exits on Android/Apple/Unix. Windows uses an exception-safe outer
capture/verification lease to release roots before the call exits, avoiding
MinGW's emulated-TLS destructor race; nested verification shares that lease.
Up to 100 workers therefore retain at most 100 parsed root
bundles; this intentionally uses more memory than one shared root cache.

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

`NativeClaims.probeRsa(domain, validationTime, timeoutMs, handle)` accepts only
public domain/time, a 1–3000 ms DNS-inclusive budget and cancellation handle.
Root version 1, RSA-only mask 6, maximum target and a fresh OS-CSPRNG challenge
are fixed internally; no wallet or transaction data is supplied. It returns
only `verified`, `failed`, `timeout`, `busy` or `unavailable`, never proof bytes.
Cancellation/context errors throw and must abort the owning review. Late
verification cannot produce `verified`; fallback does not prove incompatibility.
An ordinary claim's valid-proof EMA observation is not updated by these probes.

Successful attempts return public JSON fields `proof`, `captured`, `validationPassed`, `validProof`,
`meetsTarget`, `durationMs`, and `errorCode`. A valid certificate/signature counts
as a valid proof even when its hash misses the target. Completed TCP/TLS failures
return false plus a fixed error code and TCP/TLS duration. Cancellation, local
configuration/setup failures and pre-TCP DNS failures throw; do not count these
neutral failures as certificate-invalid EMA samples. Duration excludes DNS and
the final synchronous certificate verification.

`NativeClaims.hasStarted(handle)` acknowledges the actual TCP `connect` call,
not DNS, a queued task, or socket allocation. The owner checks it before
destroying the handle; unknown/destroyed handles return false. `captured` marks
a complete raw P2C transcript through `CertificateVerify`, independently of certificate validity or work target,
so successful-capture budgets are separate from validated-proof EMA samples.
`validationPassed` is the known certificate/signature result used for EMA and
validated-connection counters, while `validProof` means the proof is still usable
for submission. If validation completes successfully after the deadline,
`validationPassed` remains true but `validProof`/`meetsTarget` are false, `proof`
is empty, and `errorCode` is `CLAIM_TIMEOUT`; no late proof can be broadcast.

Each owning engine creates one native start limiter (1–100 starts/second), binds
its cancellation handles to it, and retains it across Stop/Start. DNS-ready
workers join a FIFO queue immediately before `connect`. Only its head performs
a timed pacing wait; the other workers do not all wake at every pacing deadline.
The cadence advances from the previous deadline while requests remain queued:
`next = max(next + ceil(1 second / configured_rate), now - 1 second)`.
Thus short scheduler delays can be recovered, but accumulated timing debt never
exceeds one second after a start. The interval depends on the configured rate;
10 ms is only the 100/s case. When live work returns after idle, its overdue
deadline is rebased to the current time;
the engine also explicitly resets this phase on lifecycle interruptions so
cancelled old waiters cannot carry paused credit into a resumed run. Future
deadlines are preserved. A separate rolling one-second ceiling bounds starts to
the configured rate, using
conservative syscall-return timestamps and retaining history across Stop/Start
and rate changes, including phase resets. Catch-up gaps can therefore be below
`1/rate`; this is
not a strict minimum-gap scheduler. Changing the rate also applies to queued
workers. Waiting respects cancellation
and the capture deadline; cancelled/unstarted calls consume no permit. Destroying
the limiter wakes its waiters and prevents further starts. The legacy no-argument
handle constructor binds a process-shared 100/s limiter, never an unlimited path.
`startedAgeNanos(handle)` reports elapsed monotonic time since the actual start
(or -1 before starting/after destruction), avoiding a native/Java clock-epoch
assumption. The Java owner converts this age when recording real starts.

Within a domain, IP selection matches Core/desktop: independent success/time
EMA per public IP and **exact signature mask**, starting at 0.1 successes and
0.02 seconds, updated with `old * 0.999 + sample * 0.001`. Smooth weighted
round-robin assigns 99% by validated connections per TCP/TLS second and 1%
uniform exploration. Equal credits rotate using a per-mask cursor. DNS refresh
preserves statistics/credits for unchanged IPs and drops removed IPs. Late
results update their selected statistics object only and cannot restore an
evicted domain or removed/readded IP. DNS failures, pre-TCP setup errors, and
cancellation without a known outcome do not penalize an IP. Completed certificate
and signature validation counts regardless of the work target; a known result
is retained even if cancellation arrives during validation, but its proof is
still suppressed. These local scheduling observations do not change consensus.

There are at most 100 active captures, 256 live handles, and two unfinished OS
DNS workers. Same-domain callers share an in-flight lookup and a bounded cache
of at most 128 domains (60 seconds for public endpoints, 5 seconds for failures).
Other domains wait for a resolver slot with their own deadline/cancellation;
they do not fail immediately just because the two resolver slots are occupied.
Cancel shuts down the socket; its owner closes it. OS `getaddrinfo` cannot be
interrupted portably. A lookup may still finish into the shared DNS cache after
its caller cancels, but it never opens a socket or emits a claim/proof itself.
DNS waits check cancellation/deadline at most every 50 ms; TLS polling at most every
100 ms; bounded synchronous crypto is checked immediately before/after. A
mobile configuration enables `MBEDTLS_THREADING_C`, using pthread mutexes on
Android/Apple/Unix and an alternate Windows SRW-lock backend on Windows. One-time
initialization warms Mbed TLS's lazy capability/CPU caches before publishing the
runtime, then initializes PSA. PSA's internal locks protect shared key slots,
RNG and global state; TLS contexts/configurations, proof chains and root-key
caches are owned by each worker. No global lock serializes complete handshakes
or proof verification. The bounded PSA runtime lives for the process so worker
teardown cannot race global mutex destruction. See Mbed TLS's
[threading contract](https://mbed-tls.readthedocs.io/en/latest/kb/development/thread-safety-and-multi-threading/).
Ephemeral key material uses only OS CSPRNG
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
rejections, name constraints, real TLS transcript capture against loopback,
fresh ephemeral keys, timeout and cancellation. A held-open loopback server
withholds `Finished` entirely: ECDSA, RSAE-PSS and restricted RSA-PSS captures
must still succeed, while modified certificate signatures, CertificateVerify
signatures and disallowed schemes must remain rejected. Eight-worker tests require
simultaneous entry at the chain-verification boundary and distinct production
root caches, then stress valid/tampered ECDSA/RSAE/restricted-PSS proofs. Parallel
loopback handshakes with eight and 100 workers exercise shared PSA key creation/destruction, fresh ephemeral
keys, bounded TCP-start pacing/rolling rate limits and timeout cleanup. Test-only root/loopback overrides
are compile-time guarded; CMake rejects enabling them for an Android build.

Android builds produce `libconnectwallet_claims.so` for arm64-v8a/x86_64 with
16-KiB load-segment alignment. All Android native components, including Mbed TLS,
use `-O2` even in the debug-signed installable APK; debug symbols and checks
remain enabled. Host debug/sanitizer configurations are not overridden.
Apple CI compiles native static libraries for iOS
device/simulator and runs the host oracle on macOS. **That is not an iOS app,
App Store package, or proof of iOS background-execution support.**
