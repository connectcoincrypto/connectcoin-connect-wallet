import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = WalletBridgeViewController()
        window?.makeKeyAndVisible()

        for context in connectionOptions.urlContexts { PaymentLinkMailbox.shared.offer(context.url) }

        if !connectionOptions.urlContexts.contains(where: { $0.url.scheme?.lowercased() == "connectcoin" }) {
            SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { PaymentLinkMailbox.shared.offer(context.url) }
        let otherURLs = URLContexts.filter { $0.url.scheme?.lowercased() != "connectcoin" }
        if !otherURLs.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: otherURLs) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
