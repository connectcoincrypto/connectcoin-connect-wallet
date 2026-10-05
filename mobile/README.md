# ConnectWallet mobile development alpha

Android-first development target, isolated from desktop and installed as `com.connectcoincrypto.connectwallet.mobile.alpha`. Version `1.0.0-alpha.1`, English UI. The desktop build remains unchanged.

## Implemented in source

- Native BIP39/BIP32 mainnet wallet creation/import/unlock, libsecp256k1 Schnorr signatures, and the desktop-compatible scrypt/AES-256-GCM envelope. Recovery words/passwords use native dialogs, not JavaScript, Preferences or clipboard. Vault storage is atomic, app-private and excluded from Android backups.
- **Limited account scope:** only `m/44'/0'/0'/0/0` is displayed/spent. Change returns there. This is not yet a complete HD recovery/discovery implementation. Do not use a primary funded wallet.
- Native payment review of recipient, amount, mining fee and pending conflicts before signing. Exact typed ConnectCoin serialization and parent/ownership checks. One recipient, default 1,500 connects/vB, maximum 256 selected candidates, 1 CONN fee ceiling. Persisted public broadcast receipt; indeterminate submission is not retried automatically. No arbitrary raw signing/broadcast bridge.
- Public balance/history, receive URI/QR, desktop-compatible numeric/text limits and clipboard payment-link parsing. History remains paged by the existing opaque cursor and capped at 2,000 loaded entries; refresh rechecks loaded state.
- Native P2C capture and certificate/proof validation reusing pinned Core consensus code, immutable roots and patched MbedTLS. One claim connection at a time, at most four starts/second, progressive bounded bounty discovery, EMA success/time priority and best eligible output per domain.
- Real claims counters: attempts, valid/invalid proofs, target hits, submitted/unknown transactions, connection rate, eligible bounties, discovery progress and current domain.
- Mobile-data and background opt-ins default off. Native network policy treats metered/unknown connectivity conservatively. Explicit user Start only; no boot receiver, sticky restart or invisible auto-start. Android background claims use an ongoing service indication with Stop, not permission for additional notifications. System interruption is still possible.
- Screen capture protection, native-only secrets, WebView file/content proxy blocked, no remote WebView origin, no generic HTTP/cookie/file plugins exported.

## Important integration gates

The new native runtime is TLS-only at **connectcoin4.com:48191** with platform certificate/hostname validation and no plaintext fallback. The existing desktop server on 48190 is not silently repurposed. Deployment of the new TLS listener requires separate authorization and verification. Until it exists, network-dependent features must fail closed.

This is development code, not a production release. Creating test keys offline is distinct from verifying the entire end-to-end wallet flow on a device. Managed Java strings/garbage collection cannot promise perfect erasure; mutable private buffers are wiped on lock, and the wallet locks when backgrounded. Claims need only a public reward address and may continue separately.

The Android foreground service uses an explicit `specialUse` declaration explaining P2C proof collection. This does not guarantee Google Play policy approval. See the [Android foreground-service rules](https://developer.android.com/develop/background-work/services/fgs/service-types#special-use). No CPU block-mining service is implemented.

iOS currently has **native C++ library compilation checks only**, not an iOS wallet/IPA. Its vault, Swift bridge, UI lifecycle and supported background model remain separate work. Camera QR scanning, biometric unlock, full address discovery/recovery, backup export/import UI and full desktop feature parity also remain unfinished.

## Build and verify

Use Node.js 24+, JDK 21, Android platform 36, Build Tools 35.0.0/36.0.0, NDK 28.2.13676358 and CMake 3.22.1.

```sh
# repository root
npm ci
cd mobile
npm ci
npm test
npm run test:ui
npm run sync:android
npm run check:android
cd android
./gradlew --no-daemon --max-workers=2 :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug :app:lintRelease
```

Windows packaging verification uses `scripts/build-android.ps1 -SdkRoot <sdk> -JavaHome <jdk>`. SDK and JDK may live under ignored `.tools/`; scripts do not change global Windows configuration. Debug APKs are test-signed. Release APKs are unsigned compilation checks, not installable releases. Never commit keystores or user wallets.

The `mobile-alpha` branch workflow builds Android, runs isolated emulator instrumentation and cross-checks public native proofs on Linux/macOS; it also compiles static iOS device/simulator libraries. It uploads temporary Actions artifacts only, without a tag, GitHub Release or store publication.

`native/tools/check-provenance.mjs` verifies vendored Core sources. `native/tests/test_oracle.py` uses the pinned desktop verifier and ephemeral public test certificates on loopback, including ECDSA/RSA/PSS restrictions and invalid cases. Native/JVM and UI tests must not touch real wallets or send public transactions.

`npm run test:rpc` is an explicit optional three-query TLS integration probe for a well-known public test address. It never broadcasts. Instrumentation is only for a fresh isolated emulator; it refuses existing wallet/profile data rather than deleting it.

## Remaining acceptance work

Run lifecycle, keyboard, large-text, rotation, metered Wi-Fi/mobile/VPN transitions, background Stop and process-death tests on real Android devices. Measure KDF heap/battery/traffic without reducing security parameters. Verify native payment/claims operation against the authenticated RPC after its deployment, using dedicated test funds only with explicit user action. Do not call macOS static-library compilation an iOS app test.
