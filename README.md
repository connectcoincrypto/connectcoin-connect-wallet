# ConnectWallet

A calmer home for ConnectCoin. **ConnectWallet is a desktop light wallet**: it keeps your keys on your computer and uses the restricted ConnectCoin JSON-RPC service for chain information. No full node, blockchain download, or CPU miner is included.

[ConnectCoin](https://connectcoincrypto.com/) · [Community](https://discord.gg/JYWbz5PsPp) · [Explorer](https://explorer.connectcoincrypto.com/) · [Whitepaper](https://connectcoincrypto.com/whitepaper.pdf)

**Initial testnet release. This application has not received an independent security audit. Use test coins, not valuable funds.** Mainnet is deliberately unavailable in the UI.

## What you can do

- Create or restore a wallet with **12, 18 or 24 BIP39 recovery words**; 24 is the default.
- Protect the local wallet with a password before creating it, and verify your recovery backup.
- Receive using a QR code; send native ConnectCoin payments with a recipient/amount/fee review before broadcast.
- Create Pay-to-Connect bounties with a domain, reward and hash target, expressed as an expected number of candidate evaluations—not a guaranteed count of physical connections.
- Opt into **Automatic Claims**, with local TLS proof generation and local proof verification.
- Browse balances and transaction history, create receive addresses, export an encrypted backup and lock your wallet.
- Use a light or dark interface. **System** is the default and follows your operating system automatically; override it in **Settings → Appearance**. Your choice is saved without interrupting Automatic Claims or reconnecting RPC.

Before reviewing a P2C bounty, the wallet makes one bounded TLS capability check, without an HTTP request. A verified RSA handshake selects **mask 6** (the two supported RSA-PSS/SHA-256 schemes); an unavailable helper, failed check, busy worker or three-second timeout retains **mask 7** (ECDSA P-256/SHA-256 plus both RSA schemes), as in Core Qt. The review shows the result and the exact policy used by the signed transaction. Failure is not proof that the website lacks RSA, and retaining all schemes does not guarantee the bounty can be claimed. Success confirms one server's current capability, not future availability or every DNS endpoint. Cancelling the review or locking the wallet cancels the check; nothing is broadcast without confirmation.

Automatic Claims are **off by default**. Their on/off preference is saved: claims pause while locked and, if enabled, resume after unlocking once the helper and RPC network checks succeed, including after an app restart. Defaults are **100 connection starts per second and 100 simultaneous connections**; existing saved limits are preserved. Values over 100 show a warning; the local maximum is 256. The configurable discovery window is 1–600 recent blocks, matching the public API. These are network-intensive tasks, not CPU mining. Only interact with destinations you are authorized to test; rewards are not guaranteed, and other claimers may spend a bounty first.

Automatic Claims use Core/Qt's economic criteria: **net payout after the claim fee × success probability**, with probability `(target + 1) / 2^256`. Each bounty receives one OS-backed cryptographic random multiplier between **1.0 and 1.1**, retained while it remains in the discovery catalog. The multiplier adjusts priority, not profitability checks; there is no shuffle or new lottery on every retry. Exact integer arithmetic orders bounties, independently of RPC pagination order.

Like Core, selection alternates domain round-robin turns with economic-priority turns, and rotates through each domain's bounties in adjusted-priority order. **Each new TCP connection gets its own assignment**: a domain's largest bounty does not monopolize its attempts. One persistent helper reuses its worker pool across bounties, with global start-rate and concurrency limits. Newly discovered bounties can join subsequent assignments without interrupting connections already in progress.

Economic domain scores also account for complete TLS captures per second, measured over the last 100 completed attempts per domain and signature-policy mask (including failed attempts' elapsed time). Untried policies start with a 5/s prior. Raw expected net return below 1,000 connects per second of TLS effort is ineligible, even after a random boost; actual payout and dust are checked again before TLS. The queue holds at most 20,000 jobs; capacity admission favors adjusted economic scores while preserving active and cooling-down jobs. Priority indexes are refreshed periodically, not sorted again for every connection.

There is **no 1,000-attempt batch or 180-second bounty-search timeout** in Automatic Claims. As in Core, a bounty stops receiving new connections after its cumulative number of successful TLS captures exceeds twice the expected candidate count: `successes × (target + 1) > 2^257`. Failed DNS/TCP/TLS attempts do not consume that budget; a complete capture counts even if its hash misses the target. Connections already in progress may still produce a winning proof. Counters and random factors survive stop/start and catalog resynchronization while the bounty remains tracked in the same unlocked wallet session; they are not persisted across wallet locking or app restarts.

## Run from source

Install **Node.js 24 or newer**, npm and Git. For Automatic Claims development, also install **Python 3.11 or newer** with venv/pip support.

```sh
git clone https://github.com/connectcoincrypto/connectcoin-connect-wallet.git
cd connectcoin-connect-wallet
npm ci
npm run setup:claims
npm start
```

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`. `setup:claims` creates an isolated `.claims-venv`, installs pinned proof-helper dependencies and runs its local TLS tests. It does not install or start a blockchain node. The wallet remains usable for ordinary payments if the optional claims helper is absent; enabling claims then displays an explicit installation error.

## Build a desktop package

Build on the operating system you intend to distribute for. The helper must be built **on that same OS and architecture**.

```sh
npm ci
npm run build:claims
npm run pack
```

`build:claims` uses PyInstaller to include the Python runtime and verification dependencies. Packaged users do **not** need Python or a node. `npm run dist` produces an installer/package for the current platform: Windows NSIS, Linux AppImage or macOS DMG. Code signing/notarization requires the distributor's certificates; this repository does not claim its builds are signed. Generated installers are in `dist/` and are not committed.

Keep the Windows installer's explicit `build.nsis.guid` stable so upgrades recognize an existing ConnectWallet installation.

## RPC configuration

On first launch, a `config.json` is created alongside the encrypted wallet in the application's data folder:

- Windows: `%APPDATA%/ConnectWallet/`
- Linux: `$XDG_CONFIG_HOME/ConnectWallet/` (normally `~/.config/ConnectWallet/`)
- macOS: `~/Library/Application Support/ConnectWallet/`

ConnectWallet uses only its own data folder and `wallet.connectwallet.json`. It does not search other application profiles, use alternate wallet filenames or automatically import or migrate existing data.

The defaults are **`connectcoin4.com`, TCP port `48190`, testnet4**. Change hostname and port in Settings or edit the file while the app is closed. See [config.example.json](config.example.json).

Valid preferences are saved automatically, including appearance, Developer Mode, the RPC endpoint, inactivity timeout, default fee rate and Automatic Claims limits; no Save button is needed. Payment drafts, passwords and recovery words are not saved as preferences. Hostname and port are applied together when you leave both endpoint fields; changing other preferences does not reconnect RPC unnecessarily. Save failures are shown without discarding your edits; edit the setting again to retry.

This is **raw, newline-delimited TCP JSON-RPC, not HTTP or HTTPS**. No node username/password is required. Never point it at an unrestricted administrative node RPC service. The corresponding server is [connectcoin-json-rpc](https://github.com/connectcoincrypto/connectcoin-json-rpc).

**Trust and privacy:** network traffic is unencrypted. Your queried addresses, history and transactions can be observed, censored or modified in transit. The wallet pins the expected chain/genesis identity, but that check is not proof of consensus: a dishonest server can repeat the expected identity while lying about chain state. This is not an SPV wallet or an independently validating node. Choose a server you trust.

Private keys, passwords and recovery words are never sent to RPC. Before signing, the wallet parses funding transaction bytes, recomputes their transaction IDs, and checks the amounts and ownership against the locally derived keys. Recipients and fees are constructed locally. These checks do **not** prove inclusion, confirmations or unspentness.

## Recovery and encryption

Recovery uses the English **BIP39 word list and checksum**, backed by the OS cryptographic random generator through `node:crypto.randomBytes`. There is **no clock-derived seed, `Math.random`, handwritten-phrase generator or weak fallback**. The entropy sizes are 128, 192 and 256 bits for 12, 18 and 24 words respectively.

Keys use BIP32 with this documented ConnectWallet convention on testnet:

```text
m/44'/1'/0'/0/index    receive addresses
m/44'/1'/0'/1/index    change addresses
```

The child key is used as a **native ConnectCoin x-only P2PK key**, with no Bitcoin Taproot/BIP86 key tweak. Amounts use 10 decimal places: **1 CONN = 10,000,000,000 connects**. Bitcoin transaction libraries cannot be substituted for ConnectCoin's typed-output serialization.

Restoration scans both chains with a **20-unused-address gap**. Restored wallets continue watching that lookahead for later payments to previously issued, unused addresses. Creating receive addresses is bounded by the same gap. Discovery can take time because requests respect the public API's rate limits. This release has a 1,000-address safety limit per chain; it reports an error instead of silently claiming complete recovery beyond that limit. Keep the derivation convention with your offline backup. A BIP39 phrase alone does not make the wallet compatible with every other application's derivation scheme. This is not an importer for ConnectCoin Core's `wallet.dat`.

Within the initial recovery refresh, fully exhausted empty histories may be reused while the exact chain-tip hash and RPC session remain unchanged. They are not persisted or reused by later refreshes. A payment entering the mempool after discovery may appear on the next refresh; these separate RPC reads are not an atomic snapshot of the mempool.

The wallet-file password is **not a BIP39 passphrase** and does not change the addresses. This initial UI uses an empty BIP39 passphrase. Passwords must have at least 12 characters. The local encrypted file uses **scrypt (`N=131072, r=8, p=1`) and AES-256-GCM**, with a fresh 32-byte salt and 12-byte nonce. Format/KDF metadata is authenticated and KDF parameters are strictly bounded. Writes are atomic, and newly created files are restricted to the current OS account where supported. Windows also depends on your profile's access-control permissions.

The recovery phrase bypasses the local password: anyone with it controls the keys. Write it offline; do not send it to support. On the locked screen, **Forgot password?** restores from your original 12, 18 or 24 words and sets a new local password. There is no password reset by email or support. The app cannot compare a phrase against a locked, encrypted wallet: another valid phrase opens a different wallet, not the original funds.

**Use another wallet** lets you create or import another wallet without unlocking the current one. Both flows require an explicit acknowledgment. The active file stays untouched until a valid restoration completes or you verify the backup words for a newly generated wallet. Cancelling beforehand keeps the current wallet. On completion, the exact previous encrypted file is preserved under `wallet-backups/` in the data folder before the active wallet file is replaced. Creating another wallet does not transfer or recover the old funds. A backup in the same data folder does not protect against loss of the device; keep an independent offline backup too.

Every encrypted-file backup, including these preserved copies, still needs its original password. To restore a supported backup, close the application and preserve any existing wallet elsewhere first, then place the backup at `wallet.connectwallet.json` in the ConnectWallet data folder. Only encrypted files with the `connectcoin-connect-wallet` format identifier are supported. Earlier testnet file formats are not accepted or automatically converted, even if the file is renamed. Restore those wallets using their original BIP39 recovery phrase through **Forgot password?** or the initial restoration screen. Do not edit an encrypted file's format identifier: it is authenticated, so changing it invalidates the file. Existing files are not deleted automatically.

Locking drops the decrypted session, invalidates payment reviews and stops claims. The default inactivity lock is 15 minutes, configurable from 1–60. OS lock/suspend also locks the application. **JavaScript cannot guarantee physical erasure of all string copies from memory**, and no software wallet protects against malware controlling your unlocked computer.

## Automatic Claims architecture

Automatic Claims is off on a new installation. Its on/off preference is saved in `config.json` as `claims.enabled`, together with the connection limits and lookback window. Locking or closing the wallet stops the worker without disabling that preference. After a successful unlock, a saved enabled preference resumes claiming once the helper and RPC network checks succeed. No claims run while the wallet is locked. An unavailable helper or offline RPC does not discard the saved limits or preference. An uncertain broadcast disables Automatic Claims for safety; inspect the reported transaction before enabling it again.

The main process requests recent block hashes and complete bounty streams, reading the oldest required blocks first to reduce window-expiry retries while the chain advances. Partial streams are rejected; journal updates and reorganizations are reconciled. Metadata is limited to the server's recent window, but address history is chain-wide.

The lookback window selects new work; it does not expire P2C outputs. Connections already started, and submissions already in progress, may finish after their bounty leaves that window. Unstarted candidates leave the discovery queue, and an aged-out attempt is not retried after failure. Known spends, reorganizations, resynchronization and wallet locking still cancel affected work. Each new connection uses the validated chain median time from the shared wallet/discovery refresh, without an extra chain-tip request per connection; the full node validates the submitted proof against its own current consensus state.

For each candidate, funding bytes are verified locally. An immutable spending transaction is prepared before TLS work. The **spending transaction ID**, input index, domain, target, allowed signature schemes, pinned roots and chain median time define the proof context. No private wallet data is passed to the helper. A verified proof is attached without changing the prepared transaction's non-witness data.

Up to 256 prepared public transactions are cached in memory, preserving the payout and challenge across connections and retries. Active proposals and verified proofs waiting for a retry are never evicted; the successful-capture budget is retained separately if an idle proposal is evicted. A recoverable submission failure retries the same verified proof without new TLS work, even after the successful-capture cutoff. This retry state is limited to bounties still tracked in the recent discovery window and to the current unlocked wallet session, not Core's on-disk proposal storage. Simultaneous preparations for outputs of the same funding transaction share its authenticated RPC fetch. Public DNS results are cached for 60 seconds (failures for 2 seconds); DNS failures do not consume a connection's scheduling turn. A winning proof cancels only other attempts for the same bounty. An uncertain broadcast outcome stops all new work until the user checks the transaction.

The helper uses a hash-pinned consensus root bundle, validates the TLS signature and certificate path, rejects private/local destinations and bounds concurrency/time/output. Claims reserve a conservative fee for the maximum supported proof size; this can cost more than the minimum for a smaller actual proof. The full node remains the final consensus validator. See [helper provenance](helpers/PROVENANCE.md).

Fresh proofs and retries share a maximum of four concurrent submissions. Stopping Automatic Claims cancels broadcasts still waiting for RPC quota or a connection. A transaction already transmitted cannot be recalled: the wallet retains its confirmation or reports an unknown outcome without automatically resending it.

Stopping also releases claim preparation from shared funding lookups without cancelling other consumers. If bounty discovery is interrupted, its partial snapshot is discarded and the remaining stream is drained under the existing protocol, size and time limits; unrelated RPC requests keep their connection. Malformed streams and real transport failures still fail closed.

## Local diagnostic logs

**Developer Mode** in Settings is off by default, including for existing configurations that do not contain this preference. Enable it to show recoverable claim-rejection warnings and the **Recent diagnostic errors** panel in Automatic Claims. The preference persists without reconnecting RPC or stopping claims. Connection failures, security warnings and errors requiring user action remain visible in normal mode.

The diagnostic panel retains the last 50 errors from the current app session, even when the next bounty clears a transient warning. **Open log folder** opens the application's local diagnostic directory. Local logging remains active with Developer Mode off; the switch controls diagnostic visibility, not collection.

The data folder described above contains `logs/diagnostics.jsonl`, plus up to two rotated files, `diagnostics.1.jsonl` and `diagnostics.2.jsonl`. Each file is limited to 2 MiB (approximately 6 MiB total). Entries include UTC timestamps, an app-session identifier, claim stages and session-local claim numbers, durations, retry counters, and RPC/node error codes when available. File records survive app restarts; the in-app list is for the current session only.

Automatic Claims writes `claims.progress` at most once every five seconds, with counters accumulated for its `runId`, active preparation/DNS/capture/submission counts, maximum active age, settled-operation duration totals/maxima, and enumerated cancellation counts. `claims.stopped` and `claims.suspended` contain a final snapshot after active work drains; fatal errors are always recorded. The active-operation tracker is bounded by the worker limits and retains no operation history. Individual claim success/failure records are examples limited to four per event/stage in each five-second window; `suppressedEvents` counts omitted examples while aggregate operation counters retain every result. `claim.succeeded.durationMs` measures **submission only** (`stage: submit`, `durationScope: stage`), not a whole claim; aggregate duration totals sum settled stages and can overlap in wall time. `rpc.cancelled`, `wallet.refresh_cancelled` and `wallet.discovery_cancelled` distinguish normal local cancellation from failures and do not increase the error count.

Only allowlisted metadata and canonical error descriptions are recorded. Passwords, recovery words, private keys, addresses, transaction IDs/bytes, TLS proofs, arbitrary backend error text, helper stderr and RPC parameters are **not** written. Unknown errors use a generic description rather than copying potentially sensitive remote text. Logs remain on your device; nothing is uploaded automatically. Review them before sharing, since operation timing and error categories still describe wallet activity.

TLS capture timeouts have their own fixed diagnostic description, distinct from generic capture/proof failures. This does not change connection deadlines, retry rules or successful-capture budgets. See the [helper protocol](helpers/PROTOCOL.md).

Writes are asynchronous with a bounded queue and automatic rotation. If the disk or directory is unavailable, claiming continues and the panel reports the logging problem when Developer Mode is enabled; errors remain in bounded memory until the app closes. Diagnostics cannot recover warnings from versions that did not record them.

## Tests

```sh
npm run check
npm test
npm run test:ui
npm run test:ui:rsa
npm run test:ui:load
npm run test:ui:recovery
npm run setup:claims
```

Unit tests cover mnemonic vectors, encryption/tampering, exact amounts, funding verification, Schnorr signing, transaction serialization, TCP transport, configuration, claims cancellation and hostile responses. UI tests use temporary isolated profiles and do not touch your real wallet. Helper tests use a controlled local TLS server, never a third-party website.

The UI load test replays 1,000 progress updates with a 500-entry history and checks responsive navigation, scroll/focus preservation and immediate locking. It uses presentation-only fixtures, without a wallet or RPC connection. Background progress is coalesced before full state publication and rendering; security transitions are not delayed.

The recovery UI test uses a temporary profile and loopback RPC fixture to check password recovery, wallet replacement, cancellation, invalid inputs, backup verification, byte-identical encrypted archives and unlocking after restart. Unit tests also cover concurrent writes, expired authorization, lock/close races and backup failures. These tests never replace a real user wallet or broadcast transactions.

CI runs the unit, helper and RSA review/locking UI tests on Linux, Windows and macOS. The full UI smoke, load and recovery tests also run on Linux under Xvfb. UI tests fail if graceful shutdown fails or exceeds its deadline; emergency cleanup targets only the spawned test process tree. For a headless Linux machine, install the runtime dependencies with `npx playwright install-deps chromium`, then run `xvfb-run --auto-servernum npm run test:ui`. Playwright's Linux Electron test launcher supplies `--no-sandbox` by default: these automated tests exercise the UI, preload restrictions and wallet lifecycle, **not enforcement of the operating-system sandbox**. The normal application requests sandboxing and does not add this test flag; do not add it to normal wallet launches.

With an existing compatible ConnectCoin binary:

```sh
# Set CONNECTCOIND to your binary path first if it is not in the neighboring checkout.
npm run test:regtest
```

The integration test launches its own network-disabled regtest node. It verifies native Schnorr payments, P2C funding and claim-challenge parity against Core. It does not start mining on a public network or access existing wallets. This optional Core integration test is not part of the default CI matrix; it requires the compatible binary described above.

## Security boundary

The renderer has no Node.js access, no network permission and a narrow, allowlisted preload interface. Secrets are handled by the main process, except for deliberately displayed backup/recovery words and password entry. No analytics, remote scripts, webviews or automatic update downloads are included. A locally compromised renderer/OS remains a serious threat; this is not hardware-wallet isolation.

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
