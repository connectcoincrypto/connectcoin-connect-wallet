# ConnectWallet

A calmer home for ConnectCoin. **ConnectWallet is a desktop light wallet**: it keeps your keys on your computer and uses the restricted ConnectCoin JSON-RPC service for chain information. No full node, blockchain download, or CPU miner is included.

[ConnectCoin](https://connectcoincrypto.com/) · [Community](https://discord.gg/JYWbz5PsPp) · [Explorer](https://explorer.connectcoincrypto.com/) · [Whitepaper](https://connectcoincrypto.com/whitepaper.pdf)

**ConnectCoin mainnet wallet.** It relies on an unencrypted RPC connection and a trusted server for chain state; it does not independently validate consensus.

Mobile development lives separately in [`mobile/`](mobile/README.md), with an Android native wallet/claims alpha and explicit unfinished integration gates. It is not a production replacement for the desktop wallet. The desktop application/version remains unchanged.

## What you can do

- Create or restore a wallet with **12, 18 or 24 BIP39 recovery words**; 24 is the default.
- Protect the local wallet with a password before creating it, and verify your recovery backup.
- Receive using a copyable `connectcoin:` payment link and its QR code, with optional amount, label and message; send native ConnectCoin payments with a recipient/amount/fee review before broadcast.
- Use **Use all balance** to fill the available confirmed balance and enable **Deduct fees from payment**, or enable fee deduction separately. Review the recipient's net amount, exact fee and any change before confirming. Normal selection excludes pending-spent and reserved inputs; deliberate pending replacements require the separate advanced option described below.
- Create Pay-to-Connect bounties with a domain, reward and hash target, expressed as an expected number of candidate evaluations—not a guaranteed count of physical connections.
- Opt into **Automatic Claims**, with local TLS proof generation and local proof verification.
- Browse balances and transaction history, create receive addresses, export an encrypted backup and lock your wallet.
- Use a light or dark interface. **System** is the default and follows your operating system automatically; override it in **Settings → Appearance**. Your choice is saved without interrupting Automatic Claims or reconnecting RPC.

Before reviewing a P2C bounty, the wallet makes one bounded TLS capability check, without an HTTP request. A verified RSA handshake selects **mask 6** (the two supported RSA-PSS/SHA-256 schemes); an unavailable helper, failed check, busy worker or three-second timeout retains **mask 7** (ECDSA P-256/SHA-256 plus both RSA schemes), as in Core Qt. The review shows the result and the exact policy used by the signed transaction. Failure is not proof that the website lacks RSA, and retaining all schemes does not guarantee the bounty can be claimed. Success confirms one server's current capability, not future availability or every DNS endpoint. Cancelling the review or locking the wallet cancels the check; nothing is broadcast without confirmation.

Automatic Claims are **off by default**. Their on/off preference is saved: claims pause while locked and, if enabled, resume after unlocking once the helper and RPC network checks succeed, including after an app restart. Defaults are **100 connection starts per second and 100 simultaneous connections**; existing saved limits are preserved. Values over 100 show a warning; the local maximum is 256. The configurable discovery window is 1–600 recent blocks, matching the public API. These are network-intensive tasks, not CPU mining. Only interact with destinations you are authorized to test; rewards are not guaranteed, and other claimers may spend a bounty first.

Start pacing advances a shared timeline across all domains: `next = max(next + 1 / configured_rate, monotonic_now - 1 second)`. Both helper admission and TCP-start permission use this rule, so ordinary timer/IPC delays are recovered instead of adding a new full interval after every wake. Timing debt is bounded to one second; genuine idle or cancelled-only work cannot bank catch-up credit. The TCP gate separately caps granted start permissions in a rolling second at the configured rate. Concurrency remains independent; network latency, verification and OS scheduling can still reduce actual throughput. Production does not add another JavaScript pacing timer on top of the helper.

Automatic Claims use Core/Qt's economic criteria: **net payout after the claim fee × success probability**, with probability `(target + 1) / 2^256`. Each bounty receives one OS-backed cryptographic random multiplier between **1.0 and 1.1**, retained while it remains in the discovery catalog. The multiplier adjusts priority, not profitability checks; there is no shuffle or new lottery on every retry. Exact integer arithmetic orders bounties, independently of RPC pagination order.

Like Core, selection alternates domain round-robin turns with economic-priority turns. **Within each domain, every new TCP connection uses its best eligible, ready bounty**, ranked by net expected return, the stable ranking factor and its exact signature mask's measured valid-proof rate. Both kinds of domain turn use that same leader; concurrent attempts can work on it together instead of rotating through lower-ranked bounties. A completed proof, exhausted budget, unavailable bounty or temporary readiness/retry gate lets the next ready leader take over. A refreshed higher score can also change the leader without interrupting healthy connections already in progress. One persistent helper reuses its worker pool across bounties, with unchanged global start-rate and concurrency limits.

Economic domain scores also account for cryptographically valid TLS proofs per second of TCP/TLS effort using an exponential moving average per domain and signature-policy mask. Initialize `connections = 0.1` and `totalTime = 0.02` (5/s). After each conclusive attempt, update `connections = 0.999 * connections + 0.001 * success` and `totalTime = 0.999 * totalTime + 0.001 * seconds`, where `success` is 1 only after certificate-chain and proof-signature verification, and 0 for a TCP/TLS, parsing or cryptographic verification failure; rank using `connections / totalTime`. A cryptographically valid proof that misses the work target still counts as success: target probability already enters the economic score separately. The duration remains the measured TCP/TLS time, not verification time. Locally cancelled attempts without a conclusive outcome do not change the EMA; known outcomes survive later cancellation. The initial prior decays rather than creating a fixed floor. Protocol 4 separates early raw-capture diagnostics/budget updates from validated terminal observations and rejects stale helpers. The history has a half-life of about 693 observations; idle time alone does not update it. Raw expected net return below 1,000 connects per second of TLS effort excludes normal attempts, even after a random boost. A domain/signature policy that would qualify at the initial 5/s rate can receive one recovery probe per minute, without resetting its EMA. At most 256 representative probes share the existing queue capacity; normal candidates retain priority. Actual payout and dust are checked again before TLS. The queue holds at most 20,000 jobs; capacity admission favors adjusted economic scores while preserving active and cooling-down jobs. Priority indexes are refreshed periodically, not sorted again for every connection.

The configured global start-rate and concurrency limits apply even when all eligible work belongs to one domain. There is no additional per-domain/IP connection cap or progressive transport cooldown. Within each domain and signature-policy mask, resolved public IPs are selected by a weighted rotation: 99% of the weight follows their individually measured valid proofs per second, and 1% is shared equally for exploration. Each IP uses the same `0.999/0.001` EMA and initial 5/s prior as domain statistics. Success requires certificate and proof-signature validation, not merely a completed handshake; a valid target miss also counts. Inconclusive cancellations are neutral, and verification/queue time is excluded. Unchanged IPs retain their history across DNS refreshes. The existing domain EMA, minimum-return rules and per-job retry handling remain in place.

Automatic Claims completes TLS 1.3, authenticates server Finished and sends client Finished, then attempts a graceful TLS close. The ten-second TCP/TLS deadline excludes queueing, rate waits and local IPC start-reporting delays. Teardown is best effort, bounded to 200 ms and 64 KiB; a teardown timeout does not discard an otherwise complete capture. Every returned proof still undergoes all existing certificate/signature and target checks.

There is **no 1,000-attempt batch or 180-second bounty-search timeout** in Automatic Claims. As in Core, a bounty stops receiving new connections after its cumulative number of successful TLS captures exceeds twice the expected candidate count: `successes × (target + 1) > 2^257`. Failed DNS/TCP/TLS attempts do not consume that budget; a complete capture counts even if its hash misses the target. Connections already in progress may still produce a winning proof. Counters and random factors survive stop/start and catalog resynchronization while the bounty remains tracked in the same unlocked wallet session; they are not persisted across wallet locking or app restarts.

## Payment requests

**Send → Advanced fee settings → Allow replacing pending transactions** is off by default. When enabled, the wallet still prefers free confirmed funds; if they are insufficient, it may reuse confirmed, mature inputs spent only by a pending transaction. A fresh RPC query must identify the pending spender. The review lists the exact conflicting transaction IDs selected for the new signed transaction. Replacing them can cancel earlier payments and their dependent transactions, and the node may require a higher fee or reject the replacement. This option does not bypass node policy or broadcast automatically. Uncertain local reservations without fresh pending-spender evidence remain protected. The option is a temporary payment draft, cleared on wallet lock or successful payment, not a persistent preference. **Use all balance** still refers to the ordinary available balance, not pending-spent inputs.

In **Receive**, copy your public address or generate a new one as before. The optional amount (in CONN, up to 10 decimal places), label and message start empty. The payment URI and QR code update together; **Copy payment link** copies the complete `connectcoin:` URI. Invalid details disable copying the request and remove its QR code until corrected. **Copy address** remains available separately.

In **Send → To an address**, the separate **Paste payment link** button reads a `connectcoin:` URI directly from the clipboard, without opening another dialog. The clipboard is read only on that action, never polled, logged or sent to a server; arbitrary clipboard text is not exposed to the renderer. It validates the address checksum and wallet network locally, then replaces the recipient, amount, label and message together. Missing fields are cleared, so a link without an amount never inherits an old amount. Import does not contact the recipient, change fees, sign or broadcast a transaction; use **Review payment** and confirm explicitly afterward. Empty clipboards or invalid links show an error without changing the current draft. Duplicate fields, unsupported required parameters and payment-protocol/fee/network instructions are rejected; unused optional fields are clearly reported. Core's uppercase addresses and percent-encoded Unicode metadata are supported. Late replies cannot overwrite edits made after clicking Paste.

Send labels and messages remain editable, appear in the payment review and are saved by transaction ID inside the encrypted wallet before broadcasting. They appear as **Local payment notes** when that transaction is in Activity, and survive locking/reopening and encrypted backups, but are not recoverable from the recovery phrase alone. They are never included in transaction bytes or sent to the recipient. If local note storage is full, remove the new notes to send without adding more; existing notes are not silently discarded. Cancelled imports and late results from a locked/replaced wallet cannot repopulate the Send form.

Amount fields in Receive and Send (including bounty rewards) accept digits and one decimal point or comma, with up to 10 decimal places. A decimal comma is converted to a point; do not use thousands separators. Invalid pasted amounts are rejected as a whole, not truncated or stripped into a different amount. Amount range and payment validation still run in the wallet backend.

A final decimal separator is kept while editing but ignored when using the number: `123.` means `123`, and the payment URI/QR stays usable. This also applies to whole-number fields (fees, expected candidates, claim limits, TCP port and auto-lock minutes). Their integer/range constraints still apply; a fractional value is never rounded into a valid integer.

Public text fields also prevent edits beyond their existing limits. Receive labels allow 100 Unicode code points and messages 200; wallet names, recipient addresses, RPC hostnames and raw bounty domains retain their existing length limits. Oversized pastes are rejected whole rather than silently shortened. These editing guards do not change password/recovery input or replace backend validation, including the combined encoded payment-URI size limit.

Labels and messages are not written to the blockchain: a compatible sending wallet can store them locally. Anyone with the URI or QR can read these details, so do not include secrets. Request drafts stay in memory while navigating and are cleared when the wallet locks; they are not saved as preferences. ConnectCoin Core can open the URI through **File → Open URI** and requires the sender to confirm the payment. Generating a request does not monitor an invoice, guarantee payment or broadcast a transaction.

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

Source launches default to mainnet. For development, set `CONNECTWALLET_NETWORK=testnet4` or `CONNECTWALLET_NETWORK=regtest` before starting the app and configure an endpoint for that network. A new development profile defaults to `127.0.0.1:48190`; existing profiles keep their saved endpoint. PowerShell example: `$env:CONNECTWALLET_NETWORK = 'testnet4'`, then `npm.cmd start`. Packaged applications use mainnet only. The network is fixed for each launch and cannot be changed by editing the RPC hostname or the profile's `config.json`.

## Build a desktop package

Build on the operating system you intend to distribute for. The helper must be built **on that same OS and architecture**.

```sh
npm ci
npm run build:claims
npm run pack
```

`build:claims` uses PyInstaller to include the Python runtime and verification dependencies. Packaged users do **not** need Python or a node. `npm run pack` creates the unpacked development distribution in `dist/`.

For installers, run **`npm run dist:win`**, **`npm run dist:mac`** or **`npm run dist:linux`** on the corresponding native host, after `npm ci`. These commands rebuild and test the native claims helper, embed icons, build the installers, verify the packaged runtime, and write checksums. Windows produces English-only **MSI and NSIS EXE**, macOS produces **DMG and ZIP** separately for Intel and Apple Silicon, and Linux x86_64 produces **DEB, RPM, AppImage and tar.gz**. Outputs go to `dist/installers/<platform>-<arch>/`; move an earlier build aside before rebuilding. No installer is executed and no wallet is opened by the packaging command.

The manual **Wallet installers** Actions workflow builds all four native OS/architecture combinations and uploads downloadable artifacts. It does **not** publish Releases or run on every ordinary commit. See [the installer guide](docs/installers.md) for requirements, exact commands, verification limits, signing, and safe upgrades. Keep both the Windows NSIS GUID and MSI upgrade code stable. Installer-managed text is English; operating-system dialogs may use the system language.

The claims helper pins `cryptography==50.0.1`, including fixes for duplicate-certificate path construction and wildcard DNS name constraints. After changing helper dependencies, rebuild the native helper and the desktop package: updating the source environment alone does not update an existing executable. Packaging checks the **bundled** provider version against the pin and rejects older helpers without security metadata. The consensus root bundle and proof format are unchanged.

## RPC configuration

On first mainnet launch, a `config.json` is created alongside the encrypted wallet in the application's data folder:

- Windows: `%APPDATA%/ConnectWallet-mainnet/`
- Linux: `$XDG_CONFIG_HOME/ConnectWallet-mainnet/` (normally `~/.config/ConnectWallet-mainnet/`)
- macOS: `~/Library/Application Support/ConnectWallet-mainnet/`

Profiles are isolated by network. Development testnet4 uses the legacy `ConnectWallet` folder under the same OS data directory; regtest uses `ConnectWallet-regtest`. Mainnet uses the new `ConnectWallet-mainnet` folder and starts with Automatic Claims off. Testnet wallets, settings, claims consent and backups are not copied or migrated to mainnet. Existing testnet data remains available through an explicit testnet4 source launch with a compatible testnet endpoint.

ConnectWallet uses only the selected network's data folder and `wallet.connectwallet.json`. It does not search other application profiles, use alternate wallet filenames or automatically import or migrate existing data. Do not move an encrypted wallet between network profiles: the wallet's stored network must match the selected network.

The defaults are **`connectcoin4.com`, TCP port `48190`, mainnet (`main`)**. Mainnet pins genesis hash `30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e`. Change hostname and port in Settings or edit the file while the app is closed; the endpoint must serve the profile's selected network and expected genesis. See [config.example.json](config.example.json).

Valid preferences are saved automatically, including appearance, Developer Mode, the RPC endpoint, inactivity timeout, default fee rate and Automatic Claims limits; no Save button is needed. Payment drafts, passwords and recovery words are not saved as preferences. Hostname and port are applied together when you leave both endpoint fields; changing other preferences does not reconnect RPC unnecessarily. Save failures are shown without discarding your edits; edit the setting again to retry.

Inactivity locking is **off by default** (`autoLockMinutes: 0`). In Settings, keep **Lock after inactivity** at `0` to disable it, or choose `1`–`60` minutes to enable it. With inactivity locking disabled, the decrypted wallet stays available and enabled Automatic Claims keep running while the wallet remains unlocked. Use **Lock now** when leaving the computer unattended; Suspend still locks the wallet and stops claims. Screen-lock events also do so on Windows and macOS; Electron does not provide that event on Linux, so use **Lock now** or enable the inactivity timer there.

This is **raw, newline-delimited TCP JSON-RPC, not HTTP or HTTPS**. No node username/password is required. Never point it at an unrestricted administrative node RPC service. The corresponding server is [connectcoin-json-rpc](https://github.com/connectcoincrypto/connectcoin-json-rpc).

Existing saved inactivity timeouts are preserved on upgrade, including the former 15-minute default. Set **Lock after inactivity** to `0` once to disable a saved timeout.

While unlocked, ConnectWallet subscribes to chain-tip, bounty and address updates over its persistent RPC connection. Ordinary tip notifications update the displayed height and confirmed transactions' confirmation counts locally, without querying address balances, history, UTXOs or deltas. Pending transactions stay unconfirmed until an address update establishes their inclusion. Address watches opt into `changes_only:true` and require the server's explicit acknowledgment; their notifications trigger validated reads. There is **no 20-second network polling loop**. Bounty discovery runs independently of balance/history refreshes, and notification bursts are combined without losing updates received during a read. After a disconnect, the wallet reconnects with bounded backoff, subscribes again and catches up before resuming claims. Locking closes subscriptions and cancels reconnect attempts. When enabled, the local inactivity/auto-lock timer remains independent of network updates.

On servers supporting `getaddresschanges`, the first synchronization captures a journal watermark, downloads the address history/UTXO baseline, and replays changes that occurred during those reads. Later address notifications retrieve only journal changes, in batches of up to 100 addresses; ordinary tip notifications do not even query this journal. Large wallets converge their batches to the same chain tip, journal epoch and global sequence before publishing, including transfers between batches within the same mempool tip. Normal advancement retries only deltas, retaining an unpublished candidate if convergence needs another attempt. Display-only confirmation updates never advance address cursors or change spendable funds. Coinbase maturity is an address event from the server; reorganizations require revalidation and invalidate in-flight old-chain reads. Pending-spent outputs remain in the synchronized UTXO state with their `pending_spent_by` marker, while available balances exclude those spends. A complete validated candidate replaces the displayed snapshot atomically; interrupted or malformed updates cannot advance its cursor.

This cache is **session-only**, not an on-disk history cache: locking, changing wallets or changing the RPC endpoint discards it. Initial loading and recovery still require baseline reads and can encounter the existing per-method rate limits. Growing the tracked address set, expired journals, or chain reorganizations can require another baseline. Servers returning method-not-found continue using the legacy full-refresh path; other errors do not silently downgrade synchronization. The cursor is a journal position, not the last transaction ID from the historical pagination API.

The journal-based initial baseline pipelines up to **four address reads**, with one page per worker at a time. Address notification registrations use up to **two workers**; each address is subscribed before its baseline is read, and journal replay still completes before any new balance/history snapshot is published. Failed batches stop queued work and drain already-sent replies before retrying. All requests, including Automatic Claims, share the same RPC connection and its unchanged limits: **12 in-flight requests/streams**, **32 outstanding calls**, and normally **48 requests per method per minute** (transaction batches and per-block bounty streams retain their tighter quotas). Calls wait for capacity and quota without opening extra connections or bypassing server cooldowns. Large histories can therefore still require a quota-window wait.

Address subscriptions are subject to the server's per-IP capacity, shared with other clients. If that capacity is exhausted, the wallet reports it; untracked addresses require a manual refresh. Servers without acknowledged changes-only subscriptions also show a warning and retain startup/manual reads, without silently falling back to per-block address polling. Deploy a compatible JSON-RPC service before distributing this build. Subscription notifications are hints, not cryptographic proof of blockchain state.

**Trust and privacy:** network traffic is unencrypted. Your queried addresses, history and transactions can be observed, censored or modified in transit. The wallet pins the expected chain/genesis identity, but that check is not proof of consensus: a dishonest server can repeat the expected identity while lying about chain state. This is not an SPV wallet or an independently validating node. Choose a server you trust.

Private keys, passwords and recovery words are never sent to RPC. Before signing, the wallet parses funding transaction bytes, recomputes their transaction IDs, and checks the amounts and ownership against the locally derived keys. Recipients and fees are constructed locally. These checks do **not** prove inclusion, confirmations or unspentness.

## Recovery and encryption

Recovery uses the English **BIP39 word list and checksum**, backed by the OS cryptographic random generator through `node:crypto.randomBytes`. There is **no clock-derived seed, `Math.random`, handwritten-phrase generator or weak fallback**. The entropy sizes are 128, 192 and 256 bits for 12, 18 and 24 words respectively.

Keys use BIP32 with these documented ConnectWallet conventions:

```text
m/44'/0'/0'/0/index    mainnet receive addresses
m/44'/0'/0'/1/index    mainnet change addresses
m/44'/1'/0'/0/index    testnet4/regtest receive addresses
m/44'/1'/0'/1/index    testnet4/regtest change addresses
```

Mainnet's coin type `0` is a provisional ConnectWallet convention, **not a registered ConnectCoin SLIP-44 coin type**. Keep the network and full derivation path with the recovery phrase. The same phrase derives different keys and addresses on mainnet and testnet because their coin types differ; restoring on mainnet does not recover testnet coins or transfer funds across networks.

The child key is used as a **native ConnectCoin x-only P2PK key**, with no Bitcoin Taproot/BIP86 key tweak. Amounts use 10 decimal places: **1 CONN = 10,000,000,000 connects**. Bitcoin transaction libraries cannot be substituted for ConnectCoin's typed-output serialization.

Restoration scans both chains with a **20-unused-address gap**. Restored wallets continue watching that lookahead for later payments to previously issued, unused addresses. Creating receive addresses is bounded by the same gap, not by a lifetime address count. There is no 1,000-address ceiling: receiving, change and recovery continue beyond index 999, within BIP32's normal child-index range (`0` through `2,147,483,647`). Address-list preparation yields between batches so locking can cancel it; existing addresses and derivation paths do not change. Discovery can take time because requests respect the public API's rate limits, and memory/query costs grow with the wallet's address history. Keep the wallet unlocked during recovery; suspend, supported OS screen-lock events and any enabled inactivity timeout still apply, and interrupted discovery restarts on the next refresh/unlock. For a long recovery, you can disable inactivity locking with `0` in Settings or increase an enabled timeout. Keep the derivation convention with your offline backup. A BIP39 phrase alone does not make the wallet compatible with every other application's derivation scheme. This is not an importer for ConnectCoin Core's `wallet.dat`.

Within the initial recovery refresh, fully exhausted empty histories may be reused while the exact chain-tip hash and RPC session remain unchanged. They are not persisted or reused by later refreshes. A payment entering the mempool after discovery may appear on the next refresh; these separate RPC reads are not an atomic snapshot of the mempool.

The wallet-file password is **not a BIP39 passphrase** and does not change the addresses. This initial UI uses an empty BIP39 passphrase. Passwords must have at least 12 characters. The local encrypted file uses **scrypt (`N=131072, r=8, p=1`) and AES-256-GCM**, with a fresh 32-byte salt and 12-byte nonce. Format/KDF metadata is authenticated and KDF parameters are strictly bounded. Writes are atomic, and newly created files are restricted to the current OS account where supported. Windows also depends on your profile's access-control permissions.

The recovery phrase bypasses the local password: anyone with it controls the keys. Write it offline; do not send it to support. On the locked screen, **Forgot password?** restores from your original 12, 18 or 24 words and sets a new local password. There is no password reset by email or support. The app cannot compare a phrase against a locked, encrypted wallet: another valid phrase opens a different wallet, not the original funds.

Public address preparation derives the BIP39 seed and common account path once per unlocked security context, then derives receive/change addresses from public-only branches. Temporary seed and owned private-node buffers are cleared before those branches are cached; neither the branches nor their chain codes are sent to the renderer or saved to disk. Locking or replacing the session discards this cache. Address paths, signing keys, BIP39 parameters and password encryption are unchanged.

**Use another wallet** lets you create or import another wallet without unlocking the current one. Both flows require an explicit acknowledgment. The active file stays untouched until a valid restoration completes or you verify the backup words for a newly generated wallet. Cancelling beforehand keeps the current wallet. On completion, the exact previous encrypted file is preserved under `wallet-backups/` in the data folder before the active wallet file is replaced. Creating another wallet does not transfer or recover the old funds. A backup in the same data folder does not protect against loss of the device; keep an independent offline backup too.

Every encrypted-file backup, including these preserved copies, still needs its original password. To restore a supported backup, close the application and preserve any existing wallet elsewhere first, then place the backup at `wallet.connectwallet.json` in the matching network's data folder. Only encrypted files with the `connectcoin-connect-wallet` format identifier are supported. Earlier testnet file formats are not accepted or automatically converted, even if the file is renamed. Restore those wallets on testnet4 using their original BIP39 recovery phrase through **Forgot password?** or the initial restoration screen. Do not edit an encrypted file's format identifier: it is authenticated, so changing it invalidates the file. Existing files are not deleted automatically.

Locking drops the decrypted session, invalidates payment reviews and stops claims. Inactivity locking is off by default (`0`); an optional timeout of 1–60 minutes can be set in Settings. Without that timeout, an unattended wallet remains decrypted until you lock the wallet. Manual locking, suspend and Windows/macOS screen locking still lock the application and stop claims. Linux screen locking is not automatically detected; use **Lock now** or opt into an inactivity timeout. **JavaScript cannot guarantee physical erasure of all string copies from memory**, and no software wallet protects against malware controlling your unlocked computer.

## Automatic Claims architecture

Automatic Claims is off in every new network profile, including the new mainnet profile when a legacy testnet wallet exists. Its on/off preference is saved in that profile's `config.json` as `claims.enabled`, together with the connection limits and lookback window; preferences are not inherited across networks. Locking or closing the wallet stops the worker without disabling that preference. After a successful unlock, a saved enabled preference resumes claiming once the helper and RPC network checks succeed. No claims run while the wallet is locked. An unavailable helper or offline RPC does not discard the saved limits or preference. An uncertain broadcast disables Automatic Claims for safety; inspect the reported transaction before enabling it again.

The main process requests recent block hashes and complete bounty streams, reading the oldest required blocks first to reduce window-expiry retries while the chain advances. Partial streams are rejected; journal updates and reorganizations are reconciled. Metadata is limited to the server's recent window, but address history is chain-wide.

The lookback window selects new work; it does not expire P2C outputs. Connections already started, and submissions already in progress, may finish after their bounty leaves that window. Unstarted candidates leave the discovery queue, and an aged-out attempt is not retried after failure. Known spends, reorganizations, resynchronization and wallet locking still cancel affected work. Each new connection uses the validated chain median time from the shared wallet/discovery refresh, without an extra chain-tip request per connection; the full node validates the submitted proof against its own current consensus state.

For each candidate, funding bytes are verified locally. An immutable spending transaction is prepared before TLS work. The **spending transaction ID**, input index, domain, target, allowed signature schemes, pinned roots and chain median time define the proof context. No private wallet data is passed to the helper. A verified proof is attached without changing the prepared transaction's non-witness data.

Up to 256 prepared public transactions are cached in memory, preserving the payout and challenge across connections and retries. Active proposals and verified proofs waiting for a retry are never evicted; the successful-capture budget is retained separately if an idle proposal is evicted. A recoverable submission failure retries the same verified proof without new TLS work, even after the successful-capture cutoff. This retry state is limited to bounties still tracked in the recent discovery window and to the current unlocked wallet session, not Core's on-disk proposal storage. Simultaneous preparations for outputs of the same funding transaction share its authenticated RPC fetch. Public DNS results are cached for 60 seconds (failures for 2 seconds); DNS failures do not consume a connection's scheduling turn. A winning proof cancels only other attempts for the same bounty. An uncertain broadcast outcome stops all new work until the user checks the transaction.

The helper uses a hash-pinned consensus root bundle, validates the TLS signature and certificate path, rejects private/local destinations and bounds concurrency/time/output. Claims reserve a conservative fee for the maximum supported proof size; this can cost more than the minimum for a smaller actual proof. The full node remains the final consensus validator. See [helper provenance](helpers/PROVENANCE.md).

Prepared connections are admitted without waiting for each preceding helper start acknowledgement. Fair/economic turns are reserved in dispatch order, so delayed acknowledgements cannot reorder the scheduler. Unacknowledged admissions are bounded to 100 ms of the configured rate (at least two, never above concurrency); at the default 100/s this allows ten pending starts, not ten total active connections. The helper still limits actual TCP starts and total concurrency. Attempt statistics and the one-minute recovery-probe cooldown begin only on the start acknowledgement; a pending recovery probe exclusively reserves its domain/signature-mask policy even if the catalog replaces its bounty. Legacy custom adapters without helper-side pacing retain serial start admission.

Like Core, the helper permits RSA public exponents of at most 64 bits in every supplied certificate and trust root, including RSA-PSS keys and unused chain entries. This limits the public exponent, not the RSA modulus/key size. The check precedes certificate-path and TLS signature verification. The desktop refuses older helpers instead of silently reusing them after a source update; run `npm run build:claims` to rebuild the native helper.

Fresh proofs and retries share a maximum of four concurrent submissions. Stopping Automatic Claims cancels broadcasts still waiting for RPC quota or a connection. A transaction already transmitted cannot be recalled: the wallet retains its confirmation or reports an unknown outcome without automatically resending it.

Stopping also releases claim preparation from shared funding lookups without cancelling other consumers. If bounty discovery is interrupted, its partial snapshot is discarded and the remaining stream is drained under the existing protocol, size and time limits; unrelated RPC requests keep their connection. Malformed streams and real transport failures still fail closed.

## Local diagnostic logs

**Developer Mode** in Settings is off by default, including for existing configurations that do not contain this preference. Enable it to show recoverable claim-rejection warnings and the **Recent diagnostic events** panel in Automatic Claims. The preference persists without reconnecting RPC or stopping claims. Connection failures, security warnings and errors requiring user action remain visible in normal mode.

The diagnostic panel retains the last 50 errors and individual attempt failures from the current app session, even after recovery. It is a history, not the current status of Automatic Claims. **Open log folder** opens the application's local diagnostic directory. Local logging remains active with Developer Mode off; the switch controls diagnostic visibility, not collection.

The data folder described above contains `logs/diagnostics.jsonl`, plus up to two rotated files, `diagnostics.1.jsonl` and `diagnostics.2.jsonl`. Each file is limited to 2 MiB (approximately 6 MiB total). Entries include UTC timestamps, an app-session identifier, claim stages and session-local claim numbers, durations, retry counters, and RPC/node error codes when available. File records survive app restarts; the in-app list is for the current session only.

Automatic Claims writes `claims.progress` at most once every five seconds, with counters accumulated for its `runId`, active preparation/DNS/capture/submission counts, maximum active age, settled-operation duration totals/maxima, and enumerated cancellation counts. `claims.stopped` and `claims.suspended` contain a final snapshot after active work drains; fatal errors are always recorded. The active-operation tracker is bounded by the worker limits and retains no operation history. Individual claim success/failure records are examples limited to four per event/stage in each five-second window; `suppressedEvents` counts omitted examples while aggregate operation counters retain every result. `claim.succeeded.durationMs` measures **submission only** (`stage: submit`, `durationScope: stage`), not a whole claim; aggregate duration totals sum settled stages and can overlap in wall time. `rpc.cancelled`, `wallet.refresh_cancelled` and `wallet.discovery_cancelled` distinguish normal local cancellation from failures and do not increase the error count.

Only allowlisted metadata and canonical error descriptions are recorded. Passwords, recovery words, private keys, addresses, transaction IDs/bytes, TLS proofs, arbitrary backend error text, helper stderr and RPC parameters are **not** written. Unknown errors use a generic description rather than copying potentially sensitive remote text. Logs remain on your device; nothing is uploaded automatically. Review them before sharing, since operation timing and error categories still describe wallet activity.

Individual TCP/TLS capture timeouts use the `tls-timeout` category: that attempt did not produce a usable capture or broadcast a claim transaction, and the timeout itself does not stop Automatic Claims. Its inline warning is informational; fatal and unknown-broadcast warnings remain prominent. Generic proof-processing, helper-watchdog and RPC timeouts are not labeled as TLS connection timeouts. The displayed bounty job number identifies a bounty's local job, not a connection-attempt number. This does not change connection deadlines, retry rules or successful-capture budgets. See the [helper protocol](helpers/PROTOCOL.md).

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
