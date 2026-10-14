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
  work until refreshed; normal discovery-window aging does not require catalog
  reentry. Known invalidation cancels it. Written or indeterminate
  submissions still use the durable receipt and stop automatic work.

## Intentionally not imported

The headless program's address-only transaction modules, CLI configuration,
service installation and OS tuning are not wallet features. Its plaintext
public broadcast journal is not substituted for encrypted wallet storage.
An unknown transmitted wallet claim remains visible and stops automatic work;
it is never silently dropped, counted as accepted or retried as a different
transaction. Durable receipt rules remain conservative. The later four-gap
follow-up below documents the wallet-only window-aging policy.

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

## Latest native and scheduler port (2026-10-13)

The local source now also incorporates the applicable changes through claimer
`7ce30c45fe962f41f3d4fa3887bb423c680a2d2c` (including `ea99038` and `ed86a51`).
This is a source-level port, not a release or a throughput guarantee.

- Desktop releases job/admission reservations before emitting a terminal frame.
  A replacement request cannot race an already-reported completion. Its TCP
  start gate is FIFO and event-driven, retaining pacing, cancellation, endpoint
  exclusion and capture-budget checks. The gate rechecks admission after the
  started ACK, since a sibling may invalidate it while that ACK is written.
  Such an exit retains the acknowledged attempt but produces no TCP call,
  captured proof, budget increment or performance sample. Pool and engine
  validation accept only the explicit, evidence-free gate outcomes.
  Mobile already had a non-polling gate.
- Desktop and shared mobile native workers retain TLS configuration/buffers,
  not TLS sessions or secrets. Every connection uses fresh key exchange and a
  full reset; failed or partial resets discard the context. RNG/BIO callbacks,
  hostname and signature policy cannot leak into the next capture.
- The parsed-certificate cache is now a four-entry per-worker LRU, bounded by
  retained bytes and estimated parsed memory. Cached DER/static metadata never
  substitutes for per-proof time, hostname, path, CertificateVerify or target
  checks. The unused abbreviated-Certificate checksum is removed only from
  the independently verified capture path; full RSA probes keep their handshake.
- Desktop, Android and iOS cache fully parsed funding parents by exact raw bytes,
  including witness bytes, retaining immutable scalar outputs only. Every claim
  still checks its output, amount, target, policy, address and fee. Lifecycle
  changes invalidate caches and fence old asynchronous replies. Desktop payment
  signing keeps its separate full validation worker and its responsive batch
  fetch path. Raw and parsed caches have independent count/byte budgets.
- Desktop maintains a separate prepared-candidate index while its four
  preparation slots are occupied. Both views share priority, rotation and DNS
  gates. A vacancy no longer wakes and reparks the entire backlog. The journal
  fallback outpoint index is built only when a validated event lacks a block
  hash; the final duplicate and tip checks remain unchanged. Mobile already has
  direct journal lookups and prepared selection, so those desktop mechanisms
  are not copied into its platform engines.

The optional mobile domain-selection index has not been added: its benefit
needs measurement before introducing extra synchronized ranking state.

### Verification of this port

- Desktop JavaScript: 1,217/1,217 tests passed with test concurrency limited to
  two. An earlier unrestricted run had one `Deriving bits failed` error during
  vault setup while this Windows host had little free memory. No KDF parameters
  or vault validation were changed; the entire bounded rerun passed.
- Desktop native Release x64: 8/8 CTest suites passed, including crypto/TLS
  invalid-input fixtures; the service suite also passed 10 consecutive runs.
  The freshly installed workspace helper matches the build hash and passes
  package validation and offline protocol startup/shutdown.
- Real Electron source-UI tests passed all 58 stages. Payment-worker tests
  passed with 151 inputs and cancellation, and the load test passed with 500
  history rows and 1,000 updates. These use isolated test data, not a user wallet.
- Mobile JavaScript: 208/208 passed. Shared mobile native Windows-host tests:
  4/4 CTest suites and the 19-case differential oracle passed.
- Android: 519/519 JVM tests in 44 suites passed. The debug APK was built for
  arm64-v8a and x86_64 and passed signature/package checks. Its SHA-256 is
  `7e4dc144495be4eeb73b361b818713ce01e6bbfbc2db8c8c459934db46a3bf5c`.
- Android/iOS static checks passed. New Swift funding-cache tests are included,
  but Swift tests and iOS compilation were not run: this host lacks Xcode.
- Independent reviews covered scheduler/cache lifetime, native session reuse,
  admission races and end-to-end inconclusive result validation. The discovered
  post-ACK admission race was fixed and regression-tested.

This pass did not commit, push, run remote CI, publish a release, install the APK
on a phone, or replace the user's installed desktop application. It also did not
measure public-site throughput or claim a CPU/connection-rate improvement.

## Four-gap wallet-only follow-up (2026-10-13)

- Mobile waiters now recheck the shared exact capture budget and endpoint/family
  exclusions at the native TCP gate, including after waking from a pause. A
  sibling's completion can revoke an unstarted admission. Rejected pre-start
  work does not invent an attempt, failed proof or capture; work already on the
  wire still completes its existing validation. Budget state is bounded and
  pinned by active handles, with run/outpoint isolation and monotonic counters.
- Catalog resynchronization closes preparation/admission and transmission
  gates while preserving admitted captures, fixed proposals and verified
  winners. Mobile additionally closes its native pre-TCP gate. Protected blocks
  must finish reloading before that gate reopens: a hash snapshot alone is not
  enough. Desktop transient backend/rate-limit reads keep its gate closed for
  bounded event-queue retry. Invalid data, disconnects and lifecycle changes
  retain their fail-closed rules.
- Ordinary aging preserves already-started mobile captures and verified
  winners separately from the scheduling catalog, within a 200-entry retained
  work bound. Known spends, replaced blocks and lifecycle cancellation remain
  distinct from aging. A verified winner may be submitted after normal aging,
  without catalog reentry. An incomplete resync still blocks its transmission.
  Retention uses current catalog state, never an original `available` copy that
  could resurrect a bounty whose spend was already published while a capture
  or submission was still draining.
- Both platforms reject changed domain, amount, target, root version,
  signature mask or coinbase classification for an existing funding outpoint.
  Catalog replacement cannot silently reuse preparation for changed output
  metadata. Block placement is separately checked for reorganization.

The initial follow-up unnecessarily held aged winners until they reappeared in
the discovery catalog. This was corrected: 600 blocks is a discovery limit,
not a consensus expiry rule. Desktop and mobile send the preserved verified
proof in the existing `sendrawtransaction` transaction; Core rechecks its input,
proof, target, certificates and transaction rules. An old `available` row is
retained validation context, not a claim of fresh unspentness. The wallet still
rejects known spends/reorgs/metadata changes, waits out an incomplete resync,
and applies lifecycle and pre-write checks. No RPC extension or individual
availability query is needed, and no new captures are admitted for aged rows.
The obsolete awaiting-availability UI was removed. Proven-unsent retries keep
the exact proposal, proof, serialized bytes and counters; uncertain broadcasts
still preserve their safety stop and receipt/reservation handling.

The claimer already sends verified winners after normal aging. Its production
code and resync/recovery gates were not changed. Two additional regression
tests cover aging while queued for RPC and while backing off from rejection.

Verification in this follow-up uses synthetic/loopback data only:

- Desktop JavaScript: 1,235/1,235 passed at concurrency two; syntax check passed
  for 145 JavaScript files. The 58-test claim-window suite covers aged submission,
  identical-byte retries, four-slot submission limits, post-aging spend events,
  lifecycle changes, resync and uncertain-broadcast stops.
- The preceding implementation pass also passed all 58 real Electron source UI
  stages and shared native Release tests (4/4 CTest suites, 19/19 differential
  oracle cases, and 20 repeated offline proof/admission runs). The aging correction
  does not change native cryptography or the desktop UI.
- Mobile JavaScript: 213/213 passed; Vite build and iOS static checks passed.
  Mobile web UI: 196/196 passed, including removal of the obsolete held-proof
  status for both platforms and locked background controls.
- Android: 533/533 JVM tests in 44 suites passed, with no failures/errors/skips.
  The arm64-v8a/x86_64 debug APK built successfully and passed signature,
  architecture, current web-asset and launcher checks. SHA-256:
  `8d2205b46d68e9ef20e0eb2da08a811716702df7cd0265e80be14c44ffbdd1fd`.
  Package report:
  `mobile/.tools/android-build-reports/aging-submit-20261013T184137Z/debug.json`.
- Claimer: 129 relevant offline tests passed, including the two new aging
  regressions; no production changes were necessary.
- Additional Swift regressions are written, but not executed on Windows:
  macOS/Xcode is required. Static checks are not a substitute for XCTest.

This follow-up does not change the JSON-RPC repository, claimer production code,
VPS services, versions or releases, and does not replace the installed desktop
application. Changes remain local, without commit or push.

## Sampling and resynchronization follow-up (2026-10-13)

The six follow-up findings are addressed locally in the Wallet and claimer:

- Unknown or underperforming domain/mask policies can receive bounded real
  measurements without first passing the 5/s prior. Up to 32 initial starts
  are spaced by at least 250ms, then one per minute per tracked policy. A
  global 4/s ceiling and single pending start reservation survive catalog
  rebuilds and eviction; normal profitable work retains the configured limits.
  Neither the 1,000-connects economic floor nor the performance-window prior
  is changed. Sampling cannot bypass metadata, funding, proof or budget checks.
- Claimer DNS capacity waiters are reopened without requiring another DNS
  completion, including when previously awakened candidates were invalidated.
- Desktop push resets use the preserving catalog barrier, not a destructive
  worker suspend. Protocol 4 advertises and requires `admissionGate: 1`; the
  gate is applied to pre-TCP native work as well as the JS scheduler. Started
  captures retain their deadlines and counters, while transmission waits for
  a coherent catalog. The claimer detects journal resets before waiting for
  subsequent hash queries and uses the same JS/native admission barrier.
  Temporary read failures during a reset preserve this closed barrier and
  existing work; actual disconnection and fatal errors still use the lifecycle
  teardown path.
- Claimer native admission repeats endpoint/budget checks after its start ACK
  write. Explicit machine-local route/family failures remain real failures in
  activity counters without degrading the remote domain/endpoint quality score.
- Android preserves per-outpoint captures, budget exhaustion and the priority
  factor when the same transaction is mined into another block. Its old
  prepared/proof context is invalidated; metadata is still authenticated.
- Mobile distinguishes available candidates from economically eligible ones
  and explains the return-floor waiting state and bounded sampling.
- A reset that coincides with ordinary discovery-window aging retains
  already-admitted work and verified winners. Lack of overlap after a long
  pause is not evidence that an outpoint was invalidated: proofs bind the
  claim transaction, not a funding block hash. Known spends, explicit chain
  conflicts and lifecycle changes retain their existing handling. No new
  capture is admitted outside discovery; the node validates retained claims
  as ordinary transactions on submission, without a new RPC endpoint.

These changes do not modify RPC, live profiles, installed applications, VPS
services, versions or releases. Native iOS execution still requires macOS/Xcode.

Verification for this follow-up:

- Desktop Node suite: 1,267 passed, zero failures/skips, with test concurrency
  limited to two. Log: `tmp/claims-six-fixes-desktop-final-tests.log`.
- Real Electron smoke test: all 58 stages passed using an isolated profile
  and local RPC fixtures. Log: `tmp/claims-six-fixes-ui.log`.
- Windows native helper: all eight CTest targets passed; Python reference
  tests passed (142). The rebuilt development helper advertises
  `admissionGate: 1`, and package validation passed. The installed desktop
  executable was not replaced.
- Claimer's rebuilt Windows native helper passed all eight CTest targets;
  the Python reference passed 171 tests. The full Node suite passed 682 tests,
  with four symlink-permission skips on Windows and zero failures. Log:
  `connectcoin-claimer/tmp/claims-admission-gate-final-tests.log` (sibling repo).
  An independent review also ran 190 focused tests and reproduced gate closure,
  recovery and the three recoverable RPC read-error cases with offline mocks.
- Android JVM: 540 passed in 44 suites, zero failures/errors/skips. Mobile
  JavaScript: 215 passed; browser UI: 198 passed. Android/iOS static checks
  passed. Swift regressions were added, but XCTest was not run on Windows.
- Android debug APK was rebuilt for arm64-v8a and x86_64 and passed signature,
  current-web-assets and launcher-icon checks. Report:
  `mobile/.tools/android-build-reports/bootstrap-aging-final-20261013T201904Z.json`.
  It was not installed on a device or published.

## Earlier local verification (2026-10-13)

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
