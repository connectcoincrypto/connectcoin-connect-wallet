import Capacitor
import UIKit
import WebKit

final class WalletBridgeViewController: CAPBridgeViewController {
    private let restrictedUIDelegate = WalletWebUIDelegate()
    private var scriptGuard: WalletScriptGuard?
    private var bundledWebConfiguration: WKWebViewConfiguration?
    override func instanceDescriptor() -> InstanceDescriptor {
        // Do not inherit a previously persisted WebView serverBasePath.
        let descriptor = InstanceDescriptor()
        descriptor.appLocation = Bundle.main.bundleURL.appendingPathComponent("public", isDirectory: true)
        descriptor.serverURL = nil; descriptor.urlScheme = "capacitor"; descriptor.urlHostname = "localhost"
        descriptor.allowedNavigationHostnames = []
        return descriptor
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // WKWebViewConfiguration has no unregister operation: setting nil for
        // an already registered scheme throws an Objective-C exception. Copy
        // the configured base BEFORE Capacitor installs its general file proxy.
        let bundled = configuration.copy() as! WKWebViewConfiguration
        bundled.setURLSchemeHandler(WalletBundledAssetHandler(), forURLScheme: "capacitor")
        bundledWebConfiguration = bundled
        return configuration
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        guard let bundled = bundledWebConfiguration else { preconditionFailure("Missing bundled WebView configuration") }
        bundledWebConfiguration = nil
        // Preserve Capacitor's scripts/message delegate, but never attach its
        // unrestricted scheme handler to a live WebView.
        bundled.userContentController = configuration.userContentController
        return super.webView(with: frame, configuration: bundled)
    }

    override func capacitorDidLoad() {
        if let webView {
            // Native top/side safe areas keep scrolling content out of the
            // status bar/notch. CSS sees zero top inset inside this rectangle;
            // its existing bottom safe-area padding still protects the home bar.
            let container = UIView()
            container.backgroundColor = UIColor { traits in
                traits.userInterfaceStyle == .light
                    ? UIColor(red: 250 / 255, green: 248 / 255, blue: 253 / 255, alpha: 1)
                    : UIColor(red: 21 / 255, green: 18 / 255, blue: 29 / 255, alpha: 1)
            }
            view = container
            webView.translatesAutoresizingMaskIntoConstraints = false
            webView.clipsToBounds = true
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            container.addSubview(webView)
            NSLayoutConstraint.activate([
                webView.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
                webView.leadingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.trailingAnchor),
                webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
            ])
        }
        webView?.uiDelegate = restrictedUIDelegate
        if let webView, let upstream = webView.navigationDelegate as? WKScriptMessageHandler {
            let handler = WalletScriptGuard(upstream: upstream)
            webView.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
            webView.configuration.userContentController.add(handler, name: "bridge")
            scriptGuard = handler
        } else {
            // No unguarded renderer may reach the dynamically loading bridge.
            webView?.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
        }
        bridge?.registerPluginInstance(WalletDisabledHttp())
        bridge?.registerPluginInstance(WalletDisabledCookies())
        bridge?.registerPluginInstance(WalletBundledWebView())
        bridge?.registerPluginInstance(NativeWalletPlugin())
        bridge?.registerPluginInstance(NativePaymentInputPlugin())
        bridge?.registerPluginInstance(NativeExplorerPlugin())
    }

    #if DEBUG && targetEnvironment(simulator)
    private var checkedIsolation = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !checkedIsolation, ProcessInfo.processInfo.arguments.contains("--wallet-ui-smoke") else { return }
        checkedIsolation = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let webView = self.webView else {
                self.showIsolationResult("Native isolation failed (WebView unavailable)"); return
            }
            let fixture = FileManager.default.temporaryDirectory.appendingPathComponent("wallet-scheme-test-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: fixture) }
            do {
                // The first WebKit process on a fresh CI Simulator can start
                // slowly. Wait for the packaged page before the one-shot probe;
                // do not silently abandon the marker while startup is pending.
                let deadline = ProcessInfo.processInfo.systemUptime + 60
                while webView.isLoading || webView.url?.scheme != "capacitor" || webView.url?.host != "localhost" {
                    guard ProcessInfo.processInfo.systemUptime < deadline else {
                        self.showIsolationResult("Native isolation failed (startup timeout)"); return
                    }
                    try await Task.sleep(nanoseconds: 200_000_000)
                }
                try Data("public disposable scheme fixture".utf8).write(to: fixture)
                let text = "capacitor://localhost/_capacitor_file_" + fixture.path
                let result = try await webView.callAsyncJavaScript("for (const pluginId of ['CAPHttpPlugin','CAPCookiesPlugin','CAPWebViewPlugin']) window.webkit.messageHandlers.bridge.postMessage({type:'message',pluginId,methodName:'unavailableSecurityProbe',callbackId:'security-probe',options:{}}); await new Promise(resolve => setTimeout(resolve, 50)); if (prompt(JSON.stringify({type:'CapacitorCookies.get',url:'https://example.com'})) !== null) return false; try { const response = await fetch(url); if (!response.ok) return true; return (await response.text()) !== 'public disposable scheme fixture'; } catch { return true; }",
                    arguments: ["url": text], in: nil, contentWorld: .page)
                let pluginsBlocked = self.bridge?.plugin(withName: "CapacitorHttp") is WalletDisabledHttp &&
                    self.bridge?.plugin(withName: "CapacitorCookies") is WalletDisabledCookies &&
                    self.bridge?.plugin(withName: "WebView") is WalletBundledWebView
                self.showIsolationResult((result as? Bool == true && pluginsBlocked && (self.scriptGuard?.rejected ?? 0) >= 3) ? "Native isolation verified" : "Native isolation failed")
            } catch { self.showIsolationResult("Native isolation failed (probe error)") }
        }
    }
    private func showIsolationResult(_ message: String) {
        let label = UILabel(); label.text = message
        label.accessibilityIdentifier = "wallet-native-security-check"
        label.font = .systemFont(ofSize: 10); label.textColor = .secondaryLabel
        label.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(label)
        NSLayoutConstraint.activate([label.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor), label.centerXAnchor.constraint(equalTo: view.centerXAnchor)])
    }
    #endif
}
