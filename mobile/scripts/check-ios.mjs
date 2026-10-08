// Source/package checks; Apple SDK compilation is verified separately on macOS.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(resolve(root, path), 'utf8');
const [manifest, lock, project, plist, scene, bridge, spm, config, packageManifest] = await Promise.all([
  read('package.json'), read('package-lock.json'), read('ios/App/App.xcodeproj/project.pbxproj'),
  read('ios/App/App/Info.plist'), read('ios/App/App/SceneDelegate.swift'),
  read('ios/App/App/Plugins/WalletBridgeViewController.swift'), read('ios/App/CapApp-SPM/Package.swift'),
  read('capacitor.config.json'), read('ios/WalletCore/Package.swift'),
]);
const pkg = JSON.parse(manifest), locked = JSON.parse(lock), capacitor = JSON.parse(config);
assert.equal(pkg.dependencies['@capacitor/ios'], '8.5.2');
assert.equal(locked.packages['node_modules/@capacitor/ios'].version, '8.5.2');
assert.equal(capacitor.ios.webContentsDebuggingEnabled, false);
assert.equal(capacitor.ios.contentInset, 'never', 'Native safe-area bounds must not be applied a second time by UIScrollView.');
assert.equal(capacitor.server.url, undefined, 'Only packaged web assets may run.');
assert.match(spm, /exact: "8\.5\.2"/);
assert.match(project, /PBXFileSystemSynchronizedRootGroup/);
assert.match(project, /relativePath = \.\.\/WalletCore;/);
assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 15\.4;/);
assert.doesNotMatch(project, /IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
assert.match(scene, /rootViewController = WalletBridgeViewController\(\)/);
for (const plugin of ['NativeWalletPlugin', 'NativePaymentInputPlugin', 'NativeExplorerPlugin']) {
  assert.ok(bridge.includes(`registerPluginInstance(${plugin}())`), `${plugin} must be registered`);
}
for (const plugin of ['WalletDisabledHttp', 'WalletDisabledCookies', 'WalletBundledWebView']) {
  assert.ok(bridge.includes(`registerPluginInstance(${plugin}())`), `${plugin} must restrict built-in capabilities`);
}
assert.match(bridge, /setURLSchemeHandler\(WalletBundledAssetHandler\(\)/);
assert.doesNotMatch(bridge, /setURLSchemeHandler\(nil/, 'WebKit cannot unregister an existing scheme handler.');
assert.match(bridge, /configuration\.copy\(\) as! WKWebViewConfiguration/);
assert.match(bridge, /webView\.topAnchor\.constraint\(equalTo: container\.safeAreaLayoutGuide\.topAnchor\)/);
assert.match(bridge, /webView\?\.uiDelegate = restrictedUIDelegate/);
assert.match(project, /PrivacyInfo\.xcprivacy in Resources/);
assert.match(plist, /<string>connectcoin<\/string>/);
assert.match(plist, /NSCameraUsageDescription/);
assert.doesNotMatch(plist, /UIBackgroundModes/, 'Claims must stop when iOS suspends the app.');
assert.doesNotMatch(plist, /NSAllowsArbitraryLoads/, 'Do not loosen WebView transport policy.');
assert.doesNotMatch(plist, /NSLocalNetworkUsageDescription/, 'The production native RPC permits public endpoints only.');
const icon = await readFile(resolve(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert.equal(icon.readUInt32BE(16), 1024); assert.equal(icon.readUInt32BE(20), 1024);
assert.equal(icon[25], 2, 'iOS icon must be RGB without an alpha channel.');
assert.ok(!icon.includes(Buffer.from('tRNS')), 'iOS icon must not include PNG transparency.');
assert.match(packageManifest, /linkedLibrary\("connectwallet_native"\)/);
const privacy = await read('ios/App/App/PrivacyInfo.xcprivacy');
for (const reason of ['CA92.1', '35F9.1', 'C617.1', '3B52.1']) assert.ok(privacy.includes(`<string>${reason}</string>`));
console.log('iOS host, plugin registration, pinned dependencies and packaging policy checks passed.');
