// swift-tools-version: 5.9
import PackageDescription
import Foundation

// Apple SDK-specific archives are built from the pinned CMake sources. The
// Xcode app supplies LIBRARY_SEARCH_PATHS; swift test uses this explicit path.
var nativeLinkerSettings: [LinkerSetting] = [
    .linkedLibrary("connectwallet_native"),
    .linkedLibrary("c++"),
    .linkedFramework("Security")
]
if let path = ProcessInfo.processInfo.environment["CONNECTWALLET_NATIVE_LIB_DIR"], !path.isEmpty {
    nativeLinkerSettings.append(.unsafeFlags(["-L", path]))
}

let package = Package(
    name: "WalletCore",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "WalletCore", targets: ["WalletCore"])],
    targets: [
        .target(name: "CConnectWallet", publicHeadersPath: "include", linkerSettings: nativeLinkerSettings),
        .target(name: "WalletCore", dependencies: ["CConnectWallet"]),
        .testTarget(name: "WalletCoreTests", dependencies: ["WalletCore", "CConnectWallet"])
    ],
    swiftLanguageVersions: [.v5]
)
