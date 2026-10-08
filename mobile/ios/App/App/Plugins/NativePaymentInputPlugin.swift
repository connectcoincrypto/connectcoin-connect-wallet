import AVFoundation
import Capacitor
import UIKit

// One bounded, process-memory-only slot. Receiving a URL never authorizes any
// wallet action. The renderer drains it after attaching the availability listener.
final class PaymentLinkMailbox {
    static let shared = PaymentLinkMailbox()
    static let available = Notification.Name("ConnectWalletPaymentLinkAvailable")
    private let lock = NSLock()
    private var pending: [String: Any]?

    func offer(_ url: URL) {
        guard url.scheme?.lowercased() == "connectcoin" else { return }
        let text = url.absoluteString
        let value: [String: Any] = text.utf16.count <= 1024 && text.utf16.count > 12
            ? ["text": text] : ["error": "INVALID_PAYMENT_LINK"]
        lock.lock(); pending = value; lock.unlock()
        NotificationCenter.default.post(name: Self.available, object: nil)
    }

    func take() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let value = pending ?? [:]
        pending = nil
        return value
    }
}

@objc(NativePaymentInputPlugin)
public final class NativePaymentInputPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePaymentInputPlugin"
    public let jsName = "NativePaymentInput"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "takePaymentLink", returnType: CAPPluginReturnPromise)!,
        CAPPluginMethod(name: "scanPaymentQr", returnType: CAPPluginReturnPromise)!
    ]
    private var observers: [NSObjectProtocol] = []
    private var pendingScan: CAPPluginCall?
    private var scanner: PaymentQrViewController?

    public override func load() {
        observers.append(NotificationCenter.default.addObserver(forName: PaymentLinkMailbox.available,
            object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("paymentLinkAvailable", data: [:])
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in
            // Cameras and pending scans cannot survive wallet backgrounding.
            guard let self = self else { return }
            if let scanner = self.scanner { scanner.finish(["cancelled": true]) }
            else if let call = self.pendingScan { self.pendingScan = nil; call.resolve(["cancelled": true]) }
        })
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func takePaymentLink(_ call: CAPPluginCall) {
        guard call.options.isEmpty else {
            call.reject("This payment input action does not accept options.", "INVALID_ARGUMENT"); return
        }
        call.resolve(PaymentLinkMailbox.shared.take())
    }

    @objc func scanPaymentQr(_ call: CAPPluginCall) {
        guard call.options.isEmpty else {
            call.reject("This payment input action does not accept options.", "INVALID_ARGUMENT"); return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, UIApplication.shared.applicationState == .active,
                  self.bridge?.viewController?.viewIfLoaded?.window != nil else {
                call.reject("Open the wallet to scan a payment QR code.", "INACTIVE"); return
            }
            guard self.pendingScan == nil else {
                call.reject("A QR scanner is already open.", "SCANNER_BUSY"); return
            }
            self.pendingScan = call
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: self.presentScanner(call)
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                    DispatchQueue.main.async {
                        guard let self = self, self.pendingScan === call else { return }
                        if granted { self.presentScanner(call) }
                        else { self.pendingScan = nil; call.resolve(["error": "CAMERA_PERMISSION_DENIED"]) }
                    }
                }
            default:
                self.pendingScan = nil
                call.resolve(["error": "CAMERA_PERMISSION_DENIED"])
            }
        }
    }

    private func presentScanner(_ call: CAPPluginCall) {
        guard pendingScan === call else { return }
        guard UIApplication.shared.applicationState == .active,
              let presenter = bridge?.viewController, presenter.viewIfLoaded?.window != nil,
              presenter.presentedViewController == nil else {
            pendingScan = nil
            call.resolve(["cancelled": true]); return
        }
        let scanner = PaymentQrViewController { [weak self] result in
            guard let self = self, self.pendingScan === call else { return }
            self.pendingScan = nil
            self.scanner = nil
            call.resolve(result)
        }
        self.scanner = scanner
        let navigation = UINavigationController(rootViewController: scanner)
        navigation.modalPresentationStyle = .fullScreen
        presenter.present(navigation, animated: true)
    }
}

private final class PaymentQrViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let capture = AVCaptureSession()
    private let captureQueue = DispatchQueue(label: "ConnectWallet.QrCamera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var completed = false
    private let completion: ([String: Any]) -> Void

    init(completion: @escaping ([String: Any]) -> Void) {
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("QR scanner must be created explicitly") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Scan payment QR"
        view.backgroundColor = .black
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel,
            target: self, action: #selector(cancel))
        let preview = AVCaptureVideoPreviewLayer(session: capture)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview
        captureQueue.async { [weak self] in
            guard let self = self, let camera = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: camera) else {
                DispatchQueue.main.async { self?.finish(["error": "SCANNER_UNAVAILABLE"]) }
                return
            }
            self.capture.beginConfiguration()
            let output = AVCaptureMetadataOutput()
            guard self.capture.canAddInput(input), self.capture.canAddOutput(output) else {
                self.capture.commitConfiguration()
                DispatchQueue.main.async { self.finish(["error": "SCANNER_UNAVAILABLE"]) }; return
            }
            self.capture.addInput(input)
            self.capture.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            guard output.availableMetadataObjectTypes.contains(.qr) else {
                self.capture.commitConfiguration()
                DispatchQueue.main.async { self.finish(["error": "SCANNER_UNAVAILABLE"]) }; return
            }
            output.metadataObjectTypes = [.qr]
            self.capture.commitConfiguration()
            self.capture.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        if let connection = preview?.connection, connection.isVideoOrientationSupported,
           let orientation = view.window?.windowScene?.interfaceOrientation {
            switch orientation {
            case .portrait: connection.videoOrientation = .portrait
            case .portraitUpsideDown: connection.videoOrientation = .portraitUpsideDown
            case .landscapeLeft: connection.videoOrientation = .landscapeLeft
            case .landscapeRight: connection.videoOrientation = .landscapeRight
            default: break
            }
        }
    }

    @objc private func cancel() { finish(["cancelled": true]) }

    func finish(_ result: [String: Any]) {
        guard !completed else { return }
        completed = true
        let session = capture
        captureQueue.async { session.stopRunning() }
        dismiss(animated: true) { [completion] in completion(result) }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !completed { finish(["cancelled": true]) }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let qr = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject })
            .first(where: { $0.type == .qr }), let text = qr.stringValue else { return }
        guard !text.isEmpty && text.utf16.count <= 1024 else { finish(["error": "INVALID_PAYMENT_LINK"]); return }
        finish(["text": text])
    }
}
