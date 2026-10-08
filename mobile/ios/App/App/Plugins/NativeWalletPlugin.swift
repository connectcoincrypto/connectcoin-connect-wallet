import Capacitor
import UIKit
import WalletCore

/// Secrets enter UIKit only. JavaScript cannot call sign/confirm, supply a
/// password/seed, choose a file path, or bypass the native payment review.
@objc(NativeWalletPlugin)
public final class NativeWalletPlugin: CAPPlugin, CAPBridgedPlugin, UIGestureRecognizerDelegate {
    public let identifier = "NativeWalletPlugin"
    public let jsName = "NativeWallet"
    public let pluginMethods: [CAPPluginMethod] = [
        "getState", "getRecoverySnapshots", "watchAccount", "lock", "getSettings", "saveSettings",
        "create", "importRecovery", "importWallet", "exportWallet", "changePassword", "viewRecoveryPhrase",
        "unlock", "recoverAddresses", "newAddress", "readPaymentClipboard", "reviewPayment", "reviewP2C",
        "getPaymentBatch", "dismissPaymentBatch", "queryPublic", "claimsState", "claimsPolicy", "claimsLimits",
        "claimsStart", "claimsStop", "claimsCheckSubmission"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)! }

    private let runtime = MobileWalletRuntime.shared
    private var nativeUI: WalletNativeUI?
    private var operation: UUID?
    private var operationCall: CAPPluginCall?
    private var operationTask: Task<Void, Never>?
    private var confirmedPayment = false
    private var observers: [NSObjectProtocol] = []
    private var privacyCover: UIView?
    private var interactionRecognizers: [UIGestureRecognizer] = []

    @MainActor private var ui: WalletNativeUI {
        if nativeUI == nil { nativeUI = WalletNativeUI() }
        nativeUI!.presenter = bridge?.viewController
        return nativeUI!
    }

    public override func load() {
        Task { @MainActor [weak self] in
            guard let self = self else { return }
            if let view = self.bridge?.viewController?.view {
                let tap = UITapGestureRecognizer(target: self, action: #selector(self.noteInteraction))
                let pan = UIPanGestureRecognizer(target: self, action: #selector(self.noteInteraction))
                self.interactionRecognizers = [tap, pan]
                for gesture in self.interactionRecognizers {
                    gesture.cancelsTouchesInView = false
                    gesture.delaysTouchesBegan = false
                    gesture.delegate = self
                    view.addGestureRecognizer(gesture)
                }
            }
            await self.runtime.setEventHandler { [weak self] name, data in
                DispatchQueue.main.async { self?.notifyListeners(name, data: data) }
            }
            await self.runtime.setActive(UIApplication.shared.applicationState == .active)
        }
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.coverSecrets() }
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                self.cancelOperation()
                await self.runtime.setActive(false)
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                self.privacyCover?.removeFromSuperview(); self.privacyCover = nil
                await self.runtime.setActive(true)
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
            object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                self.cancelOperation(); _ = await self.runtime.lock()
            }
        })
    }

    deinit {
        operationTask?.cancel()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    @objc private func noteInteraction() { Task { await runtime.noteUserInteraction() } }
    public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                                  shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }

    private func requireEmpty(_ call: CAPPluginCall) -> Bool {
        guard call.options.count == 0 else {
            call.reject("This wallet action does not accept options.", "INVALID_ARGUMENT"); return false
        }
        return true
    }

    private func parameters(_ call: CAPPluginCall) -> JSONObject { call.options as? JSONObject ?? [:] }

    private func simple(_ call: CAPPluginCall, _ method: String, empty: Bool = true) {
        if empty && !requireEmpty(call) { return }
        let params = parameters(call)
        Task {
            do { call.resolve(try await runtime.perform(method, params)) }
            catch {
                if method == "queryPublic" { rejectPublicRead(call, error) }
                else { reject(call, error) }
            }
        }
    }

    private func rejectPublicRead(_ call: CAPPluginCall, _ error: Error) {
        let allowed = ["-32011", "-32029", "-32030", "-32001", "RPC_TIMEOUT", "RPC_CANCELLED"]
        let failure = error as? RpcFailure
        let code = failure.map { !$0.unknownOutcome && allowed.contains($0.code) ? $0.code : "RPC_UNAVAILABLE" } ?? "RPC_UNAVAILABLE"
        // These codes drive journal resynchronization/quota handling in the
        // shared renderer. Never forward server-provided error text or data.
        call.reject("The public wallet query could not complete. Refresh or retry when the connection is available.", code)
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        if error is NativeWalletCancelled || error is CancellationError { call.reject("Cancelled", "CANCELLED"); return }
        // Cocoa/provider errors can contain filesystem paths. Only deliberate
        // WalletCore errors are eligible for renderer-visible explanations.
        let text = (error as? WalletError)?.message ?? (error as? WalletFileReadError)?.errorDescription
            ?? "The native wallet action could not complete. Please try again."
        let code = ["STORAGE_UNCERTAIN", "BUSY", "NATIVE_BUSY", "RECOVERY_ACTIVE", "RECOVERY_BUSY"].contains(text) ? text : "WALLET_ERROR"
        call.reject(text, code)
    }

    @MainActor private func begin(_ call: CAPPluginCall,
        action: @escaping @MainActor () async throws -> JSONObject) {
        guard UIApplication.shared.applicationState == .active,
              bridge?.viewController?.viewIfLoaded?.window != nil else {
            call.reject("Open the wallet to continue.", "INACTIVE"); return
        }
        guard operation == nil else { call.reject("Finish the current native wallet action first.", "BUSY"); return }
        let token = UUID(); operation = token; operationCall = call; confirmedPayment = false
        operationTask = Task { @MainActor [weak self] in
            guard let self = self else { return }
            do {
                await self.runtime.noteUserInteraction()
                let result = try await action()
                if self.operation == token { call.resolve(result) }
            } catch {
                if self.operation == token { self.reject(call, error) }
            }
            if self.operation == token {
                self.operation = nil; self.operationCall = nil; self.operationTask = nil; self.confirmedPayment = false
            }
        }
    }

    @MainActor private func cancelOperation() {
        if confirmedPayment {
            // Stop remaining work, but let a submitted/uncertain transaction's
            // durable receipt finish. Never call that result a cancelled payment.
            nativeUI?.cancel()
            Task { _ = try? await runtime.perform("cancelPayment", [:]) }
            return
        }
        let call = operationCall
        operation = nil; operationCall = nil
        operationTask?.cancel(); operationTask = nil
        nativeUI?.cancel()
        call?.reject("Cancelled", "CANCELLED")
        Task { _ = try? await runtime.perform("cancelPayment", [:]) }
    }

    @MainActor private func coverSecrets() {
        guard privacyCover == nil, let window = bridge?.viewController?.view.window else { return }
        let cover = UIView(frame: window.bounds); cover.backgroundColor = .systemBackground
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let label = UILabel(frame: cover.bounds.insetBy(dx: 24, dy: 24)); label.text = "ConnectWallet"
        label.font = .preferredFont(forTextStyle: .largeTitle); label.textAlignment = .center
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.addSubview(label); window.addSubview(cover); privacyCover = cover
    }

    @objc func getState(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { do { call.resolve(try await runtime.publicState()) } catch { reject(call, error) } }
    }
    @objc func getRecoverySnapshots(_ call: CAPPluginCall) { simple(call, "getRecoverySnapshots") }
    @objc func watchAccount(_ call: CAPPluginCall) { simple(call, "watchAccount") }
    @objc func getSettings(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in
            do { let value = try await runtime.perform("getSettings"); applyAppearance(value); call.resolve(value) }
            catch { reject(call, error) }
        }
    }
    @MainActor private func applyAppearance(_ result: JSONObject) {
        let theme = ((result["settings"] as? JSONObject) ?? result)["theme"] as? String
        bridge?.viewController?.view.window?.overrideUserInterfaceStyle = theme == "dark" ? .dark : theme == "light" ? .light : .unspecified
    }
    @objc func recoverAddresses(_ call: CAPPluginCall) { simple(call, "recoverAddresses") }
    @objc func newAddress(_ call: CAPPluginCall) { simple(call, "newAddress") }
    @objc func getPaymentBatch(_ call: CAPPluginCall) { simple(call, "getPaymentBatch") }
    @objc func dismissPaymentBatch(_ call: CAPPluginCall) { simple(call, "dismissPaymentBatch", empty: false) }
    @objc func queryPublic(_ call: CAPPluginCall) { simple(call, "queryPublic", empty: false) }
    @objc func claimsState(_ call: CAPPluginCall) { simple(call, "claimsState") }
    @objc func claimsPolicy(_ call: CAPPluginCall) { simple(call, "claimsPolicy", empty: false) }
    @objc func claimsLimits(_ call: CAPPluginCall) { simple(call, "claimsLimits", empty: false) }
    @objc func claimsStart(_ call: CAPPluginCall) {
        let params = parameters(call)
        Task { @MainActor in
            self.begin(call) {
                try walletRequire(params.count == 1, "Invalid claims start")
                let address = try params.string("address")
                _ = try WalletCrypto.decodeAddress(address)
                let wallet = try await self.runtime.publicState()
                try walletRequire((wallet["accounts"] as? [JSONObject] ?? []).contains { $0["address"] as? String == address }, "Claims must use your native wallet address")
                let state = try await self.runtime.perform("claimsState").object("state")
                try await self.ui.confirm(title: "Start Automatic Claims?",
                    message: "Public reward address:\n\(address)\n\nThis performs public TLS proof work and can use substantial battery and network data. It runs only while the wallet is visible, pauses in the background, and does not unlock or spend your wallet.\n\nLimits: \(state["connectionsPerSecondLimit"] ?? 100) connection starts/second and \(state["concurrency"] ?? 100) simultaneous attempts. Mobile data: \(state["allowMobileData"] as? Bool == true ? "allowed" : "disabled").",
                    button: "Start foreground claims")
                return try await self.runtime.perform("claimsStart", params)
            }
        }
    }
    @objc func claimsStop(_ call: CAPPluginCall) { simple(call, "claimsStop") }
    @objc func claimsCheckSubmission(_ call: CAPPluginCall) { simple(call, "claimsCheckSubmission") }

    @objc func lock(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in self.cancelOperation(); call.resolve(await self.runtime.lock()) }
    }

    @objc func saveSettings(_ call: CAPPluginCall) {
        let params = parameters(call)
        Task { @MainActor in
            self.begin(call) {
                let endpoint = try TcpEndpoint(params.string("rpcHost"), Int(params.integer("rpcPort", min: 1, max: 65535)))
                let before = try await self.runtime.perform("getSettings", [:])
                let previousPort = try before.integer("rpcPort")
                if before["rpcHost"] as? String != endpoint.hostname ||
                    previousPort != Int64(endpoint.port) {
                    try await self.ui.confirm(title: "Change RPC server",
                        message: "Use \(endpoint.hostname):\(endpoint.port)?\n\nThe wallet must finish existing work, then locks and verifies the new server before showing its data.",
                        button: "Change server")
                }
                let result = try await self.runtime.perform("saveSettings", params)
                self.applyAppearance(result)
                return result
            }
        }
    }

    @objc func readPaymentClipboard(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in
            guard UIApplication.shared.applicationState == .active else { call.reject("Open the wallet to paste a payment.", "INACTIVE"); return }
            // Read only after the user's Paste request. iOS owns its paste privacy prompt.
            guard let text = UIPasteboard.general.string, !text.isEmpty, text.utf16.count <= 1024 else {
                call.reject("Copy a payment address or link before using Paste.", "INVALID_PAYMENT_LINK"); return
            }
            call.resolve(["text": text])
        }
    }

    @MainActor private func password(title: String, message: String, button: String = "Continue") async throws -> String {
        let values = try await ui.form(title: title, message: message,
            fields: [.init(key: "password", label: "Wallet password", secure: true)], button: button) { values in
            guard let password = values["password"], !password.isEmpty, password.utf8.count <= 1024 else { return "Enter the wallet password." }
            return nil
        }
        return values["password"] ?? ""
    }

    @MainActor private func authorizeReplacement() async throws -> Data? {
        let state = try await runtime.publicState()
        guard state["exists"] as? Bool == true else { return nil }
        let password = try await password(title: "Back up current wallet",
            message: "Before replacing this wallet, authenticate and save a verified encrypted backup. The current wallet stays unchanged until the new wallet is ready.", button: "Choose backup destination")
        let encrypted = try await runtime.exportEnvelope(password: password)
        try await ui.exportEncrypted(encrypted)
        try await ui.confirm(title: "Replace current wallet?",
            message: "The encrypted backup was saved and verified. Continue to create or import the replacement wallet. Keep the old password and recovery phrase with your backup.",
            button: "Continue with replacement", destructive: true)
        return encrypted
    }

    @objc func create(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in
            self.begin(call) {
                let replacement = try await self.authorizeReplacement()
                var mnemonic = try WalletCrypto.generateMnemonic()
                defer { mnemonic = "" }
                try await self.ui.confirm(title: "Write down your recovery phrase",
                    message: "These 24 words restore your wallet. Write them down privately in order. Anyone with these words can spend your funds.\n\n" + mnemonic,
                    button: "I wrote down the words")
                let words = mnemonic.split(separator: " ").map(String.init)
                let random = try WalletCrypto.random(3)
                var indices = Set<Int>()
                for byte in random { indices.insert(Int(byte) % words.count) }
                for index in words.indices where indices.count < 3 { indices.insert(index) }
                let selected = indices.sorted()
                _ = try await self.ui.form(title: "Verify your backup", message: "Enter the requested recovery words from your written backup.",
                    fields: selected.map { .init(key: "word\($0)", label: "Word \($0 + 1)") }, button: "Verify words") { values in
                    selected.allSatisfy { values["word\($0)"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == words[$0] }
                        ? nil : "The words do not match. Check your written backup."
                }
                let values = try await self.newPassword(title: "Encrypt your wallet", message: "Choose a password of at least 12 characters. This protects the wallet file on this device.")
                return try await self.runtime.installMnemonic(mnemonic, password: values, replace: replacement != nil, imported: false, replacementBackup: replacement)
            }
        }
    }

    @MainActor private func newPassword(title: String, message: String) async throws -> String {
        let values = try await ui.form(title: title, message: message,
            fields: [.init(key: "password", label: "New wallet password", secure: true),
                     .init(key: "confirm", label: "Confirm password", secure: true)], button: "Save wallet") { values in
            do { try WalletVault.validatePassword(values["password"] ?? "") } catch { return (error as? WalletError)?.message ?? "Use a password of at least 12 characters." }
            return values["password"] == values["confirm"] ? nil : "Passwords do not match."
        }
        return values["password"] ?? ""
    }

    @objc func importRecovery(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in
            self.begin(call) {
                let replacement = try await self.authorizeReplacement()
                var values = try await self.ui.form(title: "Import recovery phrase",
                    message: "Enter your recovery words in order. They remain inside the native wallet. Import an encrypted wallet file if your backup uses a BIP39 passphrase.",
                    fields: [.init(key: "mnemonic", label: "Recovery phrase", multiline: true)], button: "Continue") { values in
                    WalletCrypto.validateMnemonic(values["mnemonic"] ?? "") ? nil : "Enter a valid BIP39 recovery phrase."
                }
                defer { values.removeAll() }
                let password = try await self.newPassword(title: "Encrypt imported wallet", message: "Choose a new password to protect this recovery on the device.")
                return try await self.runtime.installMnemonic(values["mnemonic"] ?? "", password: password, replace: replacement != nil, imported: true, replacementBackup: replacement)
            }
        }
    }

    @objc func importWallet(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in
            self.begin(call) {
                let replacement = try await self.authorizeReplacement()
                let encrypted = try await self.ui.importEncrypted()
                let password = try await self.password(title: "Unlock imported backup",
                    message: "Enter the password used to encrypt the selected wallet file.", button: "Import wallet")
                return try await self.runtime.importEnvelope(encrypted, password: password, replace: replacement != nil, replacementBackup: replacement)
            }
        }
    }

    @objc func unlock(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in
            self.begin(call) {
                let password = try await self.password(title: "Unlock wallet", message: "Enter your wallet password.", button: "Unlock")
                try await self.runtime.unlock(password: password)
                return try await self.runtime.publicState()
            }
        }
    }

    @objc func exportWallet(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in
            self.begin(call) {
                let password = try await self.password(title: "Export encrypted wallet",
                    message: "Authenticate, then choose where to save your encrypted wallet backup. Keep its password safe.", button: "Choose destination")
                let encrypted = try await self.runtime.exportEnvelope(password: password)
                try await self.ui.exportEncrypted(encrypted)
                return ["exported": true]
            }
        }
    }

    @objc func changePassword(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in
            self.begin(call) {
                var values = try await self.ui.form(title: "Change wallet password",
                    message: "This changes the password for the wallet on this device. Previously exported backups keep their original password. If saving fails or cannot be verified, keep both passwords and your existing encrypted backup until reopening confirms which password works.",
                    fields: [.init(key: "old", label: "Current password", secure: true),
                             .init(key: "new", label: "New password", secure: true),
                             .init(key: "confirm", label: "Confirm new password", secure: true)], button: "Change password") { values in
                    guard !(values["old"] ?? "").isEmpty else { return "Enter your current password." }
                    do { try WalletVault.validatePassword(values["new"] ?? "") } catch { return (error as? WalletError)?.message ?? "Use a password of at least 12 characters." }
                    return values["new"] == values["confirm"] ? nil : "New passwords do not match."
                }
                defer { values.removeAll() }
                return try await self.runtime.changePassword(old: values["old"] ?? "", new: values["new"] ?? "")
            }
        }
    }

    @objc func viewRecoveryPhrase(_ call: CAPPluginCall) {
        guard requireEmpty(call) else { return }
        Task { @MainActor in
            self.begin(call) {
                let password = try await self.password(title: "View recovery phrase", message: "Authenticate in a private place. Anyone who sees these words can spend your funds.", button: "Show phrase")
                var secrets = try await self.runtime.recoverySecrets(password: password)
                defer { secrets = ("", "") }
                let phrase = secrets.mnemonic.split(separator: " ").enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
                let extra = secrets.passphrase.isEmpty ? "" : "\n\nBIP39 passphrase (required to restore these accounts):\n" + secrets.passphrase + "\n\nThis is separate from your wallet file password. Keep an encrypted backup; phrase-only import does not accept this passphrase."
                let token = self.operation
                let timeout = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 60_000_000_000)
                    if !Task.isCancelled, let self, self.operation == token { self.nativeUI?.cancel() }
                }
                defer { timeout.cancel() }
                try await self.ui.confirm(title: "Your recovery phrase", message: phrase + extra + "\n\nKeep these secrets private. This screen closes after 60 seconds.", button: "Done")
                return ["viewed": true]
            }
        }
    }

    @objc func reviewPayment(_ call: CAPPluginCall) { review(call, p2c: false) }
    @objc func reviewP2C(_ call: CAPPluginCall) { review(call, p2c: true) }
    private func review(_ call: CAPPluginCall, p2c: Bool) {
        let params = parameters(call)
        Task { @MainActor in
            self.begin(call) {
                do {
                    let review = try await self.runtime.preparePayment(params, p2c: p2c)
                    guard let lines = review["lines"] as? [String], !lines.isEmpty,
                          lines.joined(separator: "\n").utf8.count <= 32768 else { throw WalletError("The payment review could not be verified.") }
                    let requiresReplacement = review["requiresReplacement"] as? Bool == true
                    let approval = try await self.ui.form(title: p2c ? "Review P2C reward" : "Review payment",
                        message: lines.joined(separator: "\n\n") + "\n\nConfirming signs and submits the transaction. Verify the recipient and every amount above.",
                        fields: requiresReplacement ? [.init(key: "replace", label: "I approve replacing the conflicting pending transaction(s).", checkbox: true)] : [],
                        button: p2c ? "Confirm reward" : "Confirm payment") { values in
                            requiresReplacement && values["replace"] != "true" ? "Approve the pending transaction replacement or cancel this payment." : nil
                        }
                    try Task.checkCancellation()
                    self.confirmedPayment = true
                    return try await self.runtime.confirmPayment(allowReplacement: approval["replace"] == "true")
                } catch {
                    _ = try? await self.runtime.perform("cancelPayment", [:])
                    throw error
                }
            }
        }
    }
}
