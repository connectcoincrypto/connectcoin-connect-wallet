import Capacitor
import UIKit
import WebKit
import UniformTypeIdentifiers

/// Capacitor falls back to NSClassFromString for unknown plugin IDs. Restrict
/// the actual WK message boundary, not only the exported JavaScript names, so
/// a raw CAPHttpPlugin/CAPWebViewPlugin call cannot reload a forbidden class.
final class WalletScriptGuard: NSObject, WKScriptMessageHandler {
    private let upstream: WKScriptMessageHandler
    private let allowed = Set(["NativeWallet", "NativePaymentInput", "NativeExplorer", "App", "Network", "Preferences", "SystemBars", "Console"])
    private(set) var rejected = 0
    init(upstream: WKScriptMessageHandler) { self.upstream = upstream }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "capacitor", origin.host == "localhost", origin.port == 0,
              let body = message.body as? [String: Any], body["type"] as? String == "message",
              let plugin = body["pluginId"] as? String, allowed.contains(plugin) else { rejected += 1; return }
        upstream.userContentController(userContentController, didReceive: message)
    }
}

/// The stock Capacitor scheme handler also serves arbitrary sandbox paths via
/// _capacitor_file_. A wallet serves only immutable packaged UI resources.
final class WalletBundledAssetHandler: NSObject, WKURLSchemeHandler {
    private let base = Bundle.main.bundleURL.appendingPathComponent("public", isDirectory: true).resolvingSymlinksInPath()

    static func allowed(_ url: URL) -> Bool {
        url.scheme == "capacitor" && url.host == "localhost" && url.port == nil &&
            url.user == nil && url.password == nil && !url.path.hasPrefix("/_capacitor_") &&
            !url.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) &&
            !url.path.contains("\\") && !url.path.contains("\0")
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, Self.allowed(url),
              ["GET", "HEAD"].contains(urlSchemeTask.request.httpMethod ?? "GET") else {
            urlSchemeTask.didFailWithError(URLError(.unsupportedURL)); return
        }
        let relative = url.path == "/" || url.path.isEmpty ? "index.html" : String(url.path.dropFirst())
        let file = base.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(base.path + "/") else { urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile)); return }
        do {
            let info = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard info.isRegularFile == true, let size = info.fileSize, size <= 16 * 1024 * 1024 else { throw URLError(.fileDoesNotExist) }
            let data = try Data(contentsOf: file)
            let type = ["js": "text/javascript", "mjs": "text/javascript", "css": "text/css", "html": "text/html", "svg": "image/svg+xml"][file.pathExtension]
                ?? UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"]) else { throw URLError(.badServerResponse) }
            urlSchemeTask.didReceive(response)
            if urlSchemeTask.request.httpMethod != "HEAD" { urlSchemeTask.didReceive(data) }
            urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)) }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

/// Capacitor's stock UI delegate also implements a synchronous cookie bridge
/// through JavaScript prompt(), independent of the Cookies plugin. The wallet
/// has no renderer-owned prompt/alert/pop-up workflows; secret UI is UIKit.
final class WalletWebUIDelegate: NSObject, WKUIDelegate {
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) { completionHandler() }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) { completionHandler(false) }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) { completionHandler(nil) }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
}

// Replace automatically registered general-purpose plugins before loading any
// application JavaScript. Their old native methods are not present on these
// instances, even if a renderer constructs a raw nativePromise invocation.
@objc(WalletDisabledHttp)
final class WalletDisabledHttp: CAPPlugin, CAPBridgedPlugin {
    let identifier = "WalletDisabledHttp", jsName = "CapacitorHttp"
    let pluginMethods: [CAPPluginMethod] = []
}
@objc(WalletDisabledCookies)
final class WalletDisabledCookies: CAPPlugin, CAPBridgedPlugin {
    let identifier = "WalletDisabledCookies", jsName = "CapacitorCookies"
    let pluginMethods: [CAPPluginMethod] = []
}
@objc(WalletBundledWebView)
final class WalletBundledWebView: CAPPlugin, CAPBridgedPlugin {
    let identifier = "WalletBundledWebView", jsName = "WebView"
    let pluginMethods: [CAPPluginMethod] = []
    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url else { return true }
        return WalletBundledAssetHandler.allowed(url) ? nil : true
    }
}
