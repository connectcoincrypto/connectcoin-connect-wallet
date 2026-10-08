import Capacitor

final class WalletBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeWalletPlugin())
        bridge?.registerPluginInstance(NativePaymentInputPlugin())
        bridge?.registerPluginInstance(NativeExplorerPlugin())
    }
}
