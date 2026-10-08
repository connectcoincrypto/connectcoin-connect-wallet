import UIKit
import UniformTypeIdentifiers
import WalletCore

struct NativeWalletCancelled: Error {}

/// All input and file contents remain native. This controller never evaluates JS.
@MainActor
final class WalletNativeUI: NSObject, UIDocumentPickerDelegate {
    struct Field {
        let key: String
        let label: String
        var secure = false
        var multiline = false
        var checkbox = false
    }
    weak var presenter: UIViewController?
    private var formController: WalletFormController?
    private var fileContinuation: CheckedContinuation<URL, Error>?
    private var picker: UIDocumentPickerViewController?
    private var exporting = false
    var hasPresentation: Bool { formController != nil || picker != nil }

    func form(title: String, message: String, fields: [Field] = [], button: String,
              destructive: Bool = false, validate: @escaping ([String: String]) -> String? = { _ in nil }) async throws -> [String: String] {
        try Task.checkCancellation()
        guard let presenter = presenter, presenter.viewIfLoaded?.window != nil,
              UIApplication.shared.applicationState == .active, !hasPresentation,
              presenter.presentedViewController == nil else { throw WalletError("Open the wallet to continue.") }
        return try await withCheckedThrowingContinuation { continuation in
            let form = WalletFormController(title: title, message: message, fields: fields,
                button: button, destructive: destructive, validate: validate) { [weak self] result in
                self?.formController = nil
                continuation.resume(with: result)
            }
            formController = form
            let navigation = UINavigationController(rootViewController: form)
            navigation.modalPresentationStyle = .fullScreen
            presenter.present(navigation, animated: true)
        }
    }

    func confirm(title: String, message: String, button: String = "Continue", destructive: Bool = false) async throws {
        _ = try await form(title: title, message: message, button: button, destructive: destructive)
    }

    func importEncrypted() async throws -> Data {
        let url = try await pick(UIDocumentPickerViewController(forOpeningContentTypes: [.json, .data], asCopy: true), exporting: false)
        try Task.checkCancellation()
        return try await Task.detached(priority: .userInitiated) { try Self.readEncrypted(url) }.value
    }

    func exportEncrypted(_ bytes: Data) async throws {
        _ = try WalletVault.parse(bytes)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ConnectWallet-export-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("ConnectWallet-encrypted-backup.json")
        try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        var excludedFile = file; try excludedFile.setResourceValues(excluded)
        let destination = try await pick(UIDocumentPickerViewController(forExporting: [file], asCopy: true), exporting: true)
        try Task.checkCancellation()
        // Replacement never proceeds merely because the picker returned. Verify
        // the saved encrypted bytes while the provider's security scope is live.
        let readback = try await Task.detached(priority: .userInitiated) { try Self.readEncrypted(destination) }.value
        guard readback == bytes else { throw WalletError("The saved backup could not be verified. Your current wallet is unchanged.") }
    }

    private func pick(_ controller: UIDocumentPickerViewController, exporting: Bool) async throws -> URL {
        try Task.checkCancellation()
        guard let presenter = presenter, presenter.viewIfLoaded?.window != nil,
              UIApplication.shared.applicationState == .active, !hasPresentation,
              presenter.presentedViewController == nil else { throw WalletError("Open the wallet to choose a file.") }
        return try await withCheckedThrowingContinuation { continuation in
            fileContinuation = continuation
            picker = controller
            self.exporting = exporting
            controller.delegate = self
            controller.allowsMultipleSelection = false
            presenter.present(controller, animated: true)
        }
    }

    nonisolated private static func readEncrypted(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        while data.count <= WalletVault.maxFileBytes {
            try Task.checkCancellation()
            guard let chunk = try handle.read(upToCount: min(8192, WalletVault.maxFileBytes + 1 - data.count)), !chunk.isEmpty else { break }
            data.append(chunk)
        }
        guard !data.isEmpty, data.count <= WalletVault.maxFileBytes else { throw WalletError("Choose a valid encrypted wallet file.") }
        _ = try WalletVault.parse(data)
        return data
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard picker === controller, let continuation = fileContinuation else { return }
        picker = nil; fileContinuation = nil
        guard urls.count == 1, let url = urls.first else { continuation.resume(throwing: NativeWalletCancelled()); return }
        // UIKit owns dismissal of its picker. Resume after that transition so a
        // following password/replacement form is never presented underneath it.
        controller.dismiss(animated: true) { continuation.resume(returning: url) }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard picker === controller else { return }
        let continuation = fileContinuation
        picker = nil; fileContinuation = nil
        controller.dismiss(animated: true) { continuation?.resume(throwing: NativeWalletCancelled()) }
    }

    func cancel() {
        formController?.cancel()
        if let picker = picker {
            let continuation = fileContinuation
            self.picker = nil; fileContinuation = nil
            picker.dismiss(animated: false) { continuation?.resume(throwing: NativeWalletCancelled()) }
        }
    }
}

@MainActor
private final class WalletFormController: UIViewController, UITextFieldDelegate {
    private let message: String
    private let fields: [WalletNativeUI.Field]
    private let actionTitle: String
    private let destructive: Bool
    private let validate: ([String: String]) -> String?
    private var completion: ((Result<[String: String], Error>) -> Void)?
    private var inputs: [String: UIView] = [:]
    private let errorLabel = UILabel()

    init(title: String, message: String, fields: [WalletNativeUI.Field], button: String,
         destructive: Bool, validate: @escaping ([String: String]) -> String?,
         completion: @escaping (Result<[String: String], Error>) -> Void) {
        self.message = message; self.fields = fields; actionTitle = button
        self.destructive = destructive; self.validate = validate; self.completion = completion
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }
    required init?(coder: NSCoder) { fatalError("Native wallet forms must be created explicitly") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancel))
        let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false; scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)
        ])
        let label = UILabel(); label.numberOfLines = 0; label.text = message
        label.font = .preferredFont(forTextStyle: .body); label.adjustsFontForContentSizeCategory = true
        label.accessibilityIdentifier = "native-wallet-message"; stack.addArrangedSubview(label)
        for field in fields {
            let title = UILabel(); title.text = field.label; title.numberOfLines = 0
            title.font = .preferredFont(forTextStyle: .headline); title.adjustsFontForContentSizeCategory = true
            stack.addArrangedSubview(title)
            let input: UIView
            if field.checkbox {
                let toggle = UISwitch(); toggle.isOn = false
                input = toggle
            } else if field.multiline {
                let text = UITextView(); text.font = .preferredFont(forTextStyle: .body)
                text.adjustsFontForContentSizeCategory = true
                text.autocorrectionType = .no; text.autocapitalizationType = .none; text.spellCheckingType = .no
                text.smartQuotesType = .no; text.smartDashesType = .no
                text.backgroundColor = .secondarySystemBackground
                text.heightAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
                text.textContentType = .none
                input = text
            } else {
                let text = UITextField(); text.font = .preferredFont(forTextStyle: .body)
                text.adjustsFontForContentSizeCategory = true
                text.borderStyle = .roundedRect; text.isSecureTextEntry = field.secure
                text.autocorrectionType = .no; text.autocapitalizationType = .none; text.spellCheckingType = .no
                text.smartQuotesType = .no; text.smartDashesType = .no
                text.textContentType = field.secure ? .password : .none
                text.delegate = self; text.returnKeyType = .done
                text.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
                input = text
            }
            input.accessibilityLabel = field.label
            input.accessibilityIdentifier = "native-wallet-" + field.key
            inputs[field.key] = input
            stack.addArrangedSubview(input)
        }
        errorLabel.numberOfLines = 0; errorLabel.textColor = .systemRed
        errorLabel.font = .preferredFont(forTextStyle: .body); errorLabel.adjustsFontForContentSizeCategory = true
        stack.addArrangedSubview(errorLabel)
        var config = UIButton.Configuration.filled(); config.title = actionTitle
        config.baseBackgroundColor = destructive ? .systemRed : .systemIndigo
        let button = UIButton(configuration: config); button.accessibilityIdentifier = "native-wallet-confirm"
        button.addTarget(self, action: #selector(submit), for: .touchUpInside)
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
        stack.addArrangedSubview(button)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool { textField.resignFirstResponder(); return true }

    @objc private func submit() {
        var values: [String: String] = [:]
        for (key, input) in inputs {
            if let toggle = input as? UISwitch { values[key] = toggle.isOn ? "true" : "false" }
            else { values[key] = (input as? UITextField)?.text ?? (input as? UITextView)?.text ?? "" }
        }
        guard let problem = validate(values) else { finish(.success(values)); return }
        errorLabel.text = problem
        UIAccessibility.post(notification: .announcement, argument: problem)
    }

    @objc func cancel() { finish(.failure(NativeWalletCancelled())) }

    private func finish(_ result: Result<[String: String], Error>) {
        guard let completion = completion else { return }
        self.completion = nil
        for input in inputs.values {
            (input as? UITextField)?.text = nil
            (input as? UITextView)?.text = nil
        }
        view.endEditing(true)
        dismiss(animated: true) { completion(result) }
    }
}
