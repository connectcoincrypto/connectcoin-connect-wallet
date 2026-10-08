# ConnectWallet iOS

The iOS host packages the shared mobile UI with Capacitor 8.5.2 and a native Swift/C++ wallet runtime. Device installation requires Apple signing; an unsigned device `.app` archive is not an installable IPA.

## Native boundaries

- `WalletCore` owns BIP39/BIP32 derivation, libsecp256k1 signing, desktop-compatible scrypt/AES-256-GCM vaults, HD discovery, public RPC transport, funding verification, payment reservations/receipts and P2C claims. Secrets are not passed to JavaScript, Preferences, URLs or RPC.
- `NativeWalletPlugin` exposes named wallet actions. UIKit collects passwords/recovery words, verifies a newly generated 24-word backup, and presents the final payment review. JavaScript has no raw signing, native-confirmation or arbitrary-broadcast method. Replacing pending conflicts requires a separate unchecked-by-default native approval control.
- Encrypted file import/export uses `UIDocumentPickerViewController`, bounded native reads and security-scoped file access. Provider reads have a 30-second deadline and prompt caller cancellation; one process-wide worker slot remains occupied until a blocked OS operation actually ends, preventing an unbounded queue. Replacement first requires an authenticated encrypted backup whose saved bytes can be read back exactly. If a file provider cannot supply that verification, replacement does not proceed. Wallet writes are app-private, atomic and synchronized; the vault directory is excluded from backup. Exported backups keep their existing password and are separate from public payment receipts/settings.
- Backgrounding locks the vault and cancels unconfirmed native operations. A privacy cover hides native/bridge contents during app switching. Pending proof work pauses when the app is not active. A broadcast already written to the socket is never treated as safely cancelled or automatically retried; durable pending/unknown receipts preserve conservative recovery after interruption.
- QR scanning requests camera permission only after explicit user action; frames are neither stored nor uploaded. Clipboard reads occur only after the native paste action. A bounded process-memory mailbox receives `connectcoin:` links without authorizing unlock, signing, broadcasting or claims. Explorer navigation accepts only a validated transaction ID and opens the fixed explorer in the system browser.
- The WebView serves only packaged `public/` files, not Capacitor's sandbox file/HTTP proxy routes. General HTTP, cookie and WebView-path plugins are replaced with no-method native instances. A fixed plugin-name/main-frame/local-origin message filter prevents Capacitor's fallback Objective-C class-name loader from re-enabling them. Renderer prompts, cookie-prompt access and pop-up navigation are disabled; native UIKit owns sensitive dialogs. These restrictions use public SDK hooks, not a modified Capacitor binary.

## Platform differences and limits

iOS claims are **foreground only**. Mobile-data permission defaults off; constrained/expensive or unavailable paths pause work unless the allowed policy permits them. There is no background task/service promise, background mode entitlement, automatic boot/start or mining notification. The shared UI disables the Android-only background option. Explicit Start is always required.

Claims use the pinned Core proof/certificate implementation, immutable production roots, public-only DNS/IP checks, exact priority arithmetic, fair-domain/expected-return scheduling, 1–100 connection and concurrency limits, bounded recovery probes and durable unknown-outcome guards. The engine holds only the native-owned public reward address, not a wallet secret. Changing or replacing a wallet does not authorize a new claims session.

UIKit creation/import forms are cancelled on backgrounding; Android's Activity draft-resume behavior is not promised on iOS. Authenticated recovery viewing includes any nonempty BIP39 passphrase, labels it separately from the encryption password, and dismisses after 60 seconds. Native secure text entry prevents keyboard suggestions, but Swift/Objective-C strings cannot promise perfect erasure. Screenshots remain possible; do not capture real recovery words. There is no biometric unlock. The unchanged scrypt cost needs substantial memory (approximately 128 MiB working memory); test actual devices without weakening the KDF.

RPC defaults to `connectcoin4.com:48190`, using the existing plaintext TCP mainnet service. Configurable servers must use a public DNS hostname and TCP port; private/local addresses are rejected. Transaction/ownership/schema/network checks do not authenticate that server or fully verify blockchain consensus. RPC observers may see public address/transaction data. This does not weaken the separate TLS proof/certificate validation used for P2C.

## Build

Requirements: macOS, Xcode 26 or newer with iOS Simulator runtime, Node.js 24+, CMake and Ninja. Minimum application deployment target is iOS 15.4, matching the packaged UI's Safari features (`Object.hasOwn`, `Array.at`, and native HTML dialogs); Swift package host tests target macOS 13+. The dependency is pinned to Capacitor 8.5.2, including its Swift package. Windows can check source policy and build the web assets but cannot compile or run UIKit/Xcode.

From `mobile/`:

```sh
npm ci --ignore-scripts
npm test
npm run sync:ios
npm run check:ios
bash scripts/build-ios.sh core       # native host libraries + Swift tests
bash scripts/build-ios.sh simulator  # unsigned Simulator app + offline UI test
bash scripts/build-ios.sh device     # unsigned arm64 device app
bash scripts/build-ios.sh all        # all of the above
```

`build-ios.sh` builds the optional native wallet target with pinned scrypt/secp256k1 dependencies, combines the required static libraries per SDK, copies third-party notices into the app and links `WalletCore`. It does not install tools, sign, publish, request store credentials or create a release. Generated libraries/build products remain under ignored `mobile/.tools/ios-native/`. Each invocation prints and creates its own `.tools/ios-artifacts/<mode>-<unique-id>/` directory, preserving previous results and keeping their archives, checksums and diagnostics separate:

- `ConnectWallet-simulator.app.zip`
- `ConnectWallet-unsigned-device.app.zip`
- `SHA256SUMS`
- `WalletUISmoke.xcresult` and exported UI screenshots

`App/App.xcodeproj` can be opened after building the matching native SDK library. Use scheme `App` for development or `WalletUISmoke` for the UI test. Device installation requires a separately configured development team/signing profile and explicit device testing; neither is supplied by CI.

The committed opaque 1024×1024 RGB icon is compiled deterministically from the existing repository SVG artwork. To regenerate it, install the root package's locked dependencies and run `node mobile/scripts/build-ios-icon.mjs` from the repository root. Desktop/Android icon masters are not modified.

`App/App/PrivacyInfo.xcprivacy` declares app-private preferences, elapsed-time timers, app-container file metadata and user-selected document metadata according to [Apple's required-reason API definitions](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons). This is not an App Store privacy-label submission: the publisher still needs to review the actual RPC service's collection/retention practices and complete the distribution declarations.

## Verification

`.github/workflows/ios-wallet.yml` runs macOS Swift tests, native linking, real Simulator/device app builds and UIKit/WKWebView smoke tests. Inspect the workflow for the exact commit; test source is not evidence of a completed passing run. Artifacts are temporary Actions outputs, never a release. The Simulator test creates/deletes only its own new simulator, launches with a Debug-Simulator-only offline flag, uses isolated temporary wallet storage, denies network before DNS and disables claims start. It verifies file-proxy/cookie-prompt/class-alias isolation and opens/cancels native creation, recovery and document dialogs plus shared Settings. A second test imports the public BIP39 `abandon … about` fixture through native forms, checks its known first receiving address, and locks/unlocks its encrypted test vault. Screenshot attachments deliberately exclude recovery/password inputs. It never imports a user wallet, funds a wallet or broadcasts a transaction.

The physical iPhone/iPad verification checklist covers keyboard/large text/rotation, Files providers and cancelled/stalled import/export, wrong passwords and replacement failure, protected-data locking, app-switch/process-death recovery, QR permissions/scanning/deep links, background/foreground and Wi-Fi/mobile/VPN transitions, memory pressure/KDF cost, long HD recovery and public payment/claims receipts. Live payment/claim tests require separately authorized dedicated test funds and explicit native review. App Store distribution requires the publisher's signing and policy submissions separately from these tests.
