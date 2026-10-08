import Capacitor
import UIKit
import WalletCore

/// Secrets enter UIKit only. JavaScript cannot call sign/confirm, supply a
/// password/seed, choose a file path, or bypass the native payment review.
@objc(NativeWalletPlugin)
public final class NativeWalletPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeWalletPlugin"
    public let jsName = "NativeWallet"
    public let pluginMethods = [
        "getState", "getRecoverySnapshots", "watchAccount", "lock", "getSettings", "saveSettings",
        "create", "importRecovery", "importWallet", "exportWallet", "changePassword", "viewRecoveryPhrase",
        "unlock", "recoverAddresses", "newAddress", "readPaymentClipboard", "reviewPayment", "reviewP2C",
        "getPaymentBatch", "dismissPaymentBatch", "queryPublic", "claimsState", "claimsPolicy", "claimsLimits",
        "claimsStart", "claimsStop", "claimsCheckSubmission"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private let runtime = MobileWalletRuntime.shared
    private var nativeUI: WalletNativeUI?
    private var operation: UUID?
    private var operationCall: CAPPluginCall?
    private var operationTask: Task<Void, Never>?
    private var confirmedPayment = false
    private var observers: [NSObjectProtocol] = []
    private var privacyCover: UIView?

    @MainActor private var ui: WalletNativeUI {
        if nativeUI == nil { nativeUI = WalletNativeUI() }
        nativeUI!.presenter = bridge?.viewController
        return nativeUI!
    }

    public override func load() {
        Task { @MainActor [weak self] in
            guard let self = self else { return }
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
            catch { reject(call, error) }
        }
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        if error is NativeWalletCancelled || error is CancellationError { call.resolve(["cancelled": true]); return }
        // Cocoa/provider errors can contain filesystem paths. Only deliberate
        // WalletCore errors are eligible for renderer-visible explanations.
        let text = (error as? WalletError)?.message ?? "The native wallet action could not complete. Please try again."
        call.reject(text, "WALLET_ERROR")
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
        call?.resolve(["cancelled": true])
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
    @objc func getSettings(_ call: CAPPluginCall) { simple(call, "getSettings") }
    @objc func recoverAddresses(_ call: CAPPluginCall) { simple(call, "recoverAddresses") }
    @objc func newAddress(_ call: CAPPluginCall) { simple(call, "newAddress") }
    @objc func getPaymentBatch(_ call: CAPPluginCall) { simple(call, "getPaymentBatch") }
    @objc func dismissPaymentBatch(_ call: CAPPluginCall) { simple(call, "dismissPaymentBatch", empty: false) }
    @objc func queryPublic(_ call: CAPPluginCall) { simple(call, "queryPublic", empty: false) }
    @objc func claimsState(_ call: CAPPluginCall) { simple(call, "claimsState") }
    @objc func claimsPolicy(_ call: CAPPluginCall) { simple(call, "claimsPolicy", empty: false) }
    @objc func claimsLimits(_ call: CAPPluginCall) { simple(call, "claimsLimits", empty: false) }
    @objc func claimsStart(_ call: CAPPluginCall) { simple(call, "claimsStart") }
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
                let before = try await self.runtime.perform("getSettings", [:])
                if before["rpcHost"] as? String != params["rpcHost"] as? String ||
                    String(describing: before["rpcPort"] ?? "") != String(describing: params["rpcPort"] ?? "") {
                    try await self.ui.confirm(title: "Change RPC server",
                        message: "Use \(params["rpcHost"] as? String ?? ""):\(params["rpcPort"] ?? "")?\n\nThe wallet will stop claims, cancel pending payment preparation and verify the new server before showing its data.",
                        button: "Change server")
                }
                return try await self.runtime.perform("saveSettings", params)
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

    @MainActor private func authorizeReplacement() async throws -> Bool {
        let state = try await runtime.publicState()
        guard state["exists"] as? Bool == true else { return false }
        let password = try await password(title: "Back up current wallet",
            message: "Before replacing this wallet, authenticate and save a verified encrypted backup. The current wallet stays unchanged until the new wallet is ready.", button: "Choose backup destination")
        let encrypted = try await runtime.exportEnvelope(password: password)
        try await ui.exportEncrypted(encrypted)
        try await ui.confirm(title: "Replace current wallet?",
            message: "The encrypted backup was saved and verified. Continue to create or import the replacement wallet. Keep the old password and recovery phrase with your backup.",
            button: "Continue with replacement", destructive: true)
        return true
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
                return try await self.runtime.installMnemonic(mnemonic, password: values, replace: replacement, imported: false)
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
                return try await self.runtime.installMnemonic(values["mnemonic"] ?? "", password: password, replace: replacement, imported: true)
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
                return try await self.runtime.importEnvelope(encrypted, password: password, replace: replacement)
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
                    message: "This changes the password for the wallet on this device. Previously exported backups keep their original password.",
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
                var phrase = try await self.runtime.recoveryPhrase(password: password)
                defer { phrase = "" }
                try await self.ui.confirm(title: "Your recovery phrase", message: phrase + "\n\nKeep these words private. Close this screen when finished.", button: "Done")
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
                    try await self.ui.confirm(title: p2c ? "Review P2C reward" : "Review payment",
                        message: lines.joined(separator: "\n\n") + "\n\nConfirming signs and submits the transaction. Verify the recipient and every amount above.",
                        button: p2c ? "Confirm reward" : "Confirm payment")
                    try Task.checkCancellation()
                    self.confirmedPayment = true
                    return try await self.runtime.confirmPayment()
                } catch {
                    _ = try? await self.runtime.perform("cancelPayment", [:])
                    throw error
                }
            }
        }
    }
}
