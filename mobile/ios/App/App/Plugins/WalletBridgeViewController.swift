import Capacitor
import UIKit
import WebKit

final class WalletBridgeViewController: CAPBridgeViewController {
    private let restrictedUIDelegate = WalletWebUIDelegate()
    private var scriptGuard: WalletScriptGuard?
    override func instanceDescriptor() -> InstanceDescriptor {
        // Do not inherit a previously persisted WebView serverBasePath.
        let descriptor = InstanceDescriptor()
        descriptor.appLocation = Bundle.main.bundleURL.appendingPathComponent("public", isDirectory: true)
        descriptor.serverURL = nil; descriptor.urlScheme = "capacitor"; descriptor.urlHostname = "localhost"
        descriptor.allowedNavigationHostnames = []
        return descriptor
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        // Public hook runs after Capacitor configures its handler, before the
        // WKWebView is constructed. Replace that handler, never its delegate.
        configuration.setURLSchemeHandler(nil, forURLScheme: "capacitor")
        configuration.setURLSchemeHandler(WalletBundledAssetHandler(), forURLScheme: "capacitor")
        return super.webView(with: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
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
            guard let self, let webView = self.webView else { return }
            let fixture = FileManager.default.temporaryDirectory.appendingPathComponent("wallet-scheme-test-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: fixture) }
            do {
                for _ in 0..<200 {
                    if !webView.isLoading, webView.url?.scheme == "capacitor", webView.url?.host == "localhost" { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                guard !webView.isLoading, webView.url?.scheme == "capacitor", webView.url?.host == "localhost" else { return }
                try Data("public disposable scheme fixture".utf8).write(to: fixture)
                let text = "capacitor://localhost/_capacitor_file_" + fixture.path
                let result = try await webView.callAsyncJavaScript("for (const pluginId of ['CAPHttpPlugin','CAPCookiesPlugin','CAPWebViewPlugin']) window.webkit.messageHandlers.bridge.postMessage({type:'message',pluginId,methodName:'unavailableSecurityProbe',callbackId:'security-probe',options:{}}); await new Promise(resolve => setTimeout(resolve, 50)); if (prompt(JSON.stringify({type:'CapacitorCookies.get',url:'https://example.com'})) !== null) return false; try { const response = await fetch(url); if (!response.ok) return true; return (await response.text()) !== 'public disposable scheme fixture'; } catch { return true; }",
                    arguments: ["url": text], in: nil, contentWorld: .page)
                let pluginsBlocked = self.bridge?.plugin(withName: "CapacitorHttp") is WalletDisabledHttp &&
                    self.bridge?.plugin(withName: "CapacitorCookies") is WalletDisabledCookies &&
                    self.bridge?.plugin(withName: "WebView") is WalletBundledWebView
                let label = UILabel(); label.text = (result as? Bool == true && pluginsBlocked && (self.scriptGuard?.rejected ?? 0) >= 3) ? "Native isolation verified" : "Native isolation failed"
                label.accessibilityIdentifier = "wallet-native-security-check"
                label.font = .systemFont(ofSize: 10); label.textColor = .secondaryLabel
                label.translatesAutoresizingMaskIntoConstraints = false; self.view.addSubview(label)
                NSLayoutConstraint.activate([label.bottomAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.bottomAnchor), label.centerXAnchor.constraint(equalTo: self.view.centerXAnchor)])
            } catch { /* Test fails if its success accessibility marker is absent. */ }
        }
    }
    #endif
}
