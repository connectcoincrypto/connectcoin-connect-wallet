# Claimer optimization port

The port uses connectcoin-claimer commit
`f97fe7f5b8078957ca514f72133a5b0b6db2f829` as its reference.
It does not change wallet versions, publish releases, modify RPC quotas or
apply host-wide TCP/port tuning.

## Desktop

- C++/Mbed TLS replaces the Python runtime behind the existing public-only
  protocol-4 helper boundary. Private wallet material never crosses it.
- Bounded CA/certificate-signature/public-context reuse, checked X25519
  acceleration and SHA fallback retain independent validation on every proof.
- Captures stop at CertificateVerify. Pacing, active concurrency, raw capture
  budgets and validated result counts remain separate.
- Preparation and DNS capacity are re-evaluated by the coordinator so removal
  of a previously awakened candidate cannot strand the remaining queue.
- Admission time and capture time have separate watchdogs. Configured high
  concurrency is no longer stopped by the old 256/512 guards.
- An immutable work target's strict capture threshold is computed once, using
  exact integer arithmetic. Equality and uint64 saturation remain unchanged.
- Domain/endpoint performance uses sixty minute buckets with a fixed 5/1 prior,
  not unbounded observations or a lifetime EMA. Raw counters exclude the prior.
- Well-framed RPC stream invalidation codes remain recoverable; malformed
  frames fail closed. A synchronous pre-write fence rechecks claim state after
  quota/capacity waits. Proven-unsent failures cannot be mistaken for broadcasts.
- Normal discovery-window aging retains already verified retry work. Known
  spends and reorgs still invalidate it; wallet lock/stop still cancels work.
- Discovery preserves a verified automatic winner waiting for RPC allowance
  when the outpoint is reserved by that same submission. Other reservations
  still exclude duplicate work.
- Unsupported local address families/routes are quarantined without reducing
  remote quality scores. A real TCP start/failure is still counted; a rejected
  pre-start request never invents a connection.

## Mobile

Android and iOS already used native TLS/proof validation. The shared C++ layer
receives reusable native cryptographic and endpoint optimizations; Java/Swift
retain their platform-specific scheduling, lifecycle and custody boundaries.
The domain estimator and immutable ranking/budget calculations use the same
policy as desktop. Mobile never inherits the desktop process/stdio bridge.
Its existing 1–100 rate/concurrency controls and 100/100 defaults are unchanged;
desktop's configurable high limits do not silently become phone defaults.

- Valid target misses retain their validation/capture flags and counters, but
  no longer hex-encode or transfer the proof bytes to Java/Swift. Target hits
  still carry the complete verified proof for transaction attachment.
- An exact-match, single-entry public-context cache per native worker reuses
  immutable domain/challenge/target/root-version/signature-mask preparation.
  Validation time, certificate-chain checks, signatures and target comparison
  are still checked for each proof; secrets are never reused by this cache.
- A verified winner whose RPC submission is proven not to have reached a
  transport write remains reserved, with the same proof, transaction bytes and
  txid. Transient retries use bounded exponential backoff and respect RPC
  cooldowns. They do not recapture TLS or increment proof/attempt counters.
- Each retry rechecks lifecycle, bounty availability and catalog freshness
  immediately before transport admission. A merely stale catalog pauses retained
  work until refreshed; known invalidation cancels it. Written or indeterminate
  submissions still use the durable receipt and stop automatic work.

## Intentionally not imported

The headless program's address-only transaction modules, CLI configuration,
service installation and OS tuning are not wallet features. Its plaintext
public broadcast journal is not substituted for encrypted wallet storage.
An unknown transmitted wallet claim remains visible and stops automatic work;
it is never silently dropped, counted as accepted or retried as a different
transaction. Mobile window-aging and durable receipt rules remain conservative.

Tests use controlled clocks, fake RPC/loopback TLS and public cryptographic
fixtures. They do not benchmark or submit claims against public websites and
do not establish a throughput guarantee on a phone or VPS.

## Adaptive discovery window

Desktop, Android and iOS retain a privately owned, validated window of up to
600 block hashes and heights. The window is a discovery cache, not a substitute
for the bounty journal or proof validation.

- An unchanged tip reuses the window without downloading another hash list.
  Bounty/mempool changes and every journal page are still processed.
- A changed tip first requests the latest 5 hashes, then 100, then the full
  600 if necessary. Normal block arrivals and reorganizations use the same
  path. A cached overlap must match both hash and height, and overlapping
  ancestors must agree before the complete window can be reconstructed.
- Partial results from separate requests are never spliced together. A tip
  race, rollback or missing overlap cannot silently truncate the active window.
- Only an explicit invalid-parameters response to the optional `count`
  parameter permits a legacy full-window retry. Servers that ignore `count`
  may return a complete, validated window. Malformed responses still fail.
- Journal reset invalidates the bounty snapshot and forces a fresh window
  query; cached hashes can only supply a validated reconstruction anchor.
  A final lightweight tip check protects publication of the staged result.

These changes do not increase RPC quotas, skip block-bounty streams, alter
claim counters, or change transaction submission/retry rules. Tests use
controlled RPC fixtures for new blocks, shallow/deep reorganizations, cursor
reset, pagination, mempool changes and inconsistent responses.

## Local verification (2026-10-13)

The Windows native helper and unpacked desktop application were built and
tested locally. The Android alpha APK was built for arm64-v8a and x86_64 and
passed package/signature checks. Native differential tests passed with
acceleration enabled and disabled, including invalid-certificate/proof cases.

The iOS source, bridge and packaging policies were checked, but the iOS app
and Swift tests require a macOS/Apple SDK build and were not executed on this
Windows host. Linux/macOS desktop packaging was reviewed, not built locally.
Cross-platform validation uses the temporary `wallet-claims-port-validation`
branch and artifact-only workflows. It does not bump versions, create a tag or
release, merge into the default branch, or replace an installed wallet.
