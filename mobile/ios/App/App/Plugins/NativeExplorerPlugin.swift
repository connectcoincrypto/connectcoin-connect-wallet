import UIKit
import Capacitor

@objc(NativeExplorerPlugin)
public final class NativeExplorerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeExplorerPlugin"
    public let jsName = "NativeExplorer"
    public let pluginMethods = [CAPPluginMethod(name: "openTransaction", returnType: CAPPluginReturnPromise)]
    private var opening = false

    @objc func openTransaction(_ call: CAPPluginCall) {
        guard call.options.count == 1, let txid = call.getString("txid"),
              txid.utf8.count == 64,
              txid.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let url = URL(string: "https://explorer.connectcoincrypto.com/tx/" + txid) else {
            call.reject("Choose a valid transaction to open in the explorer.", "INVALID_ARGUMENT")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, UIApplication.shared.applicationState == .active,
                  self.bridge?.viewController?.viewIfLoaded?.window != nil else {
                call.reject("Open the wallet to view this transaction in the explorer.", "INACTIVE")
                return
            }
            guard !self.opening else {
                call.reject("The explorer is already opening.", "EXPLORER_BUSY")
                return
            }
            self.opening = true
            UIApplication.shared.open(url, options: [:]) { [weak self] opened in
                self?.opening = false
                if opened { call.resolve() }
                else { call.reject("No browser is available to open the explorer.", "EXPLORER_UNAVAILABLE") }
            }
        }
    }
}
