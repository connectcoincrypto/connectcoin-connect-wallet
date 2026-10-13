// Static packaging/security regression checks. This does not replace Gradle,
// merged-manifest inspection, JVM transport tests or an actual device test.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import viteConfig from '../vite.config.mjs';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DOMParser } = createRequire(path.join(mobile, '../package.json'))('@xmldom/xmldom');
const app = path.join(mobile, 'android/app');
const res = path.join(app, 'src/main/res');
const java = path.join(app, 'src/main/java/com/connectcoincrypto/connectwallet/mobile/alpha');
const android = 'http://schemas.android.com/apk/res/android';
const tools = 'http://schemas.android.com/tools';
const appId = 'com.connectcoincrypto.connectwallet.mobile.alpha';
const read = (file) => readFile(file, 'utf8');
const elements = (document, name) => Array.from(document.getElementsByTagName(name));
const attr = (element, name) => element.getAttributeNS(android, name);
let xmlCount = 0;

async function xml(file) {
  const fail = (message) => { throw new Error(`${file}: ${message}`); };
  const document = new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } })
    .parseFromString(await read(file), 'application/xml');
  assert(document.documentElement, `${file} has no document element`);
  xmlCount++;
  return document;
}

async function scanXml(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await scanXml(file);
    else if (entry.name.endsWith('.xml')) await xml(file);
  }
}

const manifest = await xml(path.join(app, 'src/main/AndroidManifest.xml'));
const permissions = elements(manifest, 'uses-permission').map((item) => attr(item, 'name')).sort();
const expectedPermissions = ['android.permission.ACCESS_NETWORK_STATE', 'android.permission.CAMERA', 'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE', 'android.permission.INTERNET'];
assert.deepEqual(permissions, expectedPermissions, 'Only network, on-demand QR camera and explicitly declared claims service permissions are allowed');
assert.equal(elements(manifest, 'uses-permission-sdk-23').length, 0);
assert.equal(elements(manifest, 'uses-permission-sdk-m').length, 0);
const application = elements(manifest, 'application');
assert.equal(application.length, 1);
assert.equal(attr(application[0], 'largeHeap'), 'true', 'The desktop-compatible scrypt allocation needs the larger app heap');
for (const name of ['allowBackup', 'fullBackupContent', 'usesCleartextTraffic']) {
  assert.equal(attr(application[0], name), 'false', `${name} must stay disabled`);
}
assert.equal(attr(application[0], 'dataExtractionRules'), '@xml/data_extraction_rules');
assert.equal(attr(application[0], 'icon'), '@mipmap/ic_launcher');
assert.equal(attr(application[0], 'roundIcon'), '@mipmap/ic_launcher_round');
assert.equal(attr(application[0], 'label'), '@string/app_name');
assert.notEqual(attr(application[0], 'debuggable'), 'true');
for (const component of ['provider', 'receiver', 'activity-alias']) {
  assert.equal(elements(manifest, component).length, 0, `Unexpected ${component} in the native wallet alpha`);
}
const services = elements(manifest, 'service');
assert.equal(services.length, 1);
assert.equal(attr(services[0], 'name'), '.ClaimsService');
assert.equal(attr(services[0], 'exported'), 'false');
assert.equal(attr(services[0], 'foregroundServiceType'), 'specialUse');
assert.equal(attr(services[0], 'stopWithTask'), 'true');
assert.equal(attr(elements(services[0], 'property')[0], 'name'), 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE');
const activityRemovals = elements(manifest, 'activity').filter((item) => item.getAttributeNS(tools, 'node') === 'remove');
assert.deepEqual(activityRemovals.map((item) => attr(item, 'name')), ['com.journeyapps.barcodescanner.CaptureActivity'],
  'The generic library scanner must be removed during merge');
const activities = elements(manifest, 'activity').filter((item) => !activityRemovals.includes(item));
assert.deepEqual(activities.map((item) => attr(item, 'name')).sort(), ['.MainActivity', '.PaymentQrCaptureActivity']);
const mainActivity = activities.find((item) => attr(item, 'name') === '.MainActivity');
const scannerActivity = activities.find((item) => attr(item, 'name') === '.PaymentQrCaptureActivity');
assert.equal(attr(mainActivity, 'label'), '@string/title_activity_main');
assert.equal(attr(mainActivity, 'exported'), 'true'); // Launcher and explicit public payment links only.
assert.equal(attr(mainActivity, 'launchMode'), 'singleTask');
assert.equal(attr(scannerActivity, 'exported'), 'false');
assert.equal(elements(scannerActivity, 'intent-filter').length, 0, 'The scanner must not accept external intents');
const filters = elements(mainActivity, 'intent-filter');
assert.equal(filters.length, 2);
const launcherFilter = filters.find((item) => elements(item, 'action').some((action) => attr(action, 'name') === 'android.intent.action.MAIN'));
const paymentFilter = filters.find((item) => elements(item, 'action').some((action) => attr(action, 'name') === 'android.intent.action.VIEW'));
assert(launcherFilter && paymentFilter);
assert.deepEqual(elements(launcherFilter, 'action').map((item) => attr(item, 'name')), ['android.intent.action.MAIN']);
assert.deepEqual(elements(launcherFilter, 'category').map((item) => attr(item, 'name')), ['android.intent.category.LAUNCHER']);
assert.equal(elements(launcherFilter, 'data').length, 0);
assert.deepEqual(elements(paymentFilter, 'action').map((item) => attr(item, 'name')), ['android.intent.action.VIEW']);
assert.deepEqual(elements(paymentFilter, 'category').map((item) => attr(item, 'name')).sort(), ['android.intent.category.BROWSABLE', 'android.intent.category.DEFAULT']);
const linkData = elements(paymentFilter, 'data');
assert.equal(linkData.length, 1);
assert.equal(linkData[0].attributes.length, 1, 'Payment URL entry must not add hosts, paths, MIME types or wildcard schemes');
assert.equal(attr(linkData[0], 'scheme'), 'connectcoin');
assert.equal(elements(manifest, 'data').length, 1);
assert.deepEqual(elements(manifest, 'action').map((item) => attr(item, 'name')).sort(), ['android.intent.action.MAIN', 'android.intent.action.VIEW']);
assert.deepEqual(elements(manifest, 'category').map((item) => attr(item, 'name')).sort(),
  ['android.intent.category.BROWSABLE', 'android.intent.category.DEFAULT', 'android.intent.category.LAUNCHER']);
assert.deepEqual(elements(manifest, 'uses-feature').map((item) => [attr(item, 'name'), attr(item, 'required')]).sort(), [
  ['android.hardware.camera', 'false'], ['android.hardware.camera.any', 'false'], ['android.hardware.camera.autofocus', 'false'],
].sort(), 'The camera and autofocus must remain optional');

// Check the installed Capacitor dependency manifests too, before manifest merge.
for (const relative of [
  '@capacitor/android/capacitor/src/main/AndroidManifest.xml',
  '@capacitor/app/android/src/main/AndroidManifest.xml',
  '@capacitor/network/android/src/main/AndroidManifest.xml',
  '@capacitor/preferences/android/src/main/AndroidManifest.xml',
]) {
  const dependency = await xml(path.join(mobile, 'node_modules', relative));
  for (const permission of elements(dependency, 'uses-permission')) {
    assert(expectedPermissions.includes(attr(permission, 'name')), `Unexpected dependency permission: ${attr(permission, 'name')}`);
  }
  assert.equal(elements(dependency, 'uses-permission-sdk-23').length, 0);
  assert.equal(elements(dependency, 'uses-permission-sdk-m').length, 0);
}

const extraction = await xml(path.join(res, 'xml/data_extraction_rules.xml'));
const domains = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'].sort();
for (const transport of ['cloud-backup', 'device-transfer']) {
  const sections = elements(extraction, transport);
  assert.equal(sections.length, 1);
  assert.equal(elements(sections[0], 'include').length, 0);
  const excluded = elements(sections[0], 'exclude');
  assert.deepEqual(excluded.map((item) => item.getAttribute('domain')).sort(), domains);
  assert(excluded.every((item) => item.getAttribute('path') === '.'));
}
await scanXml(res);
const strings = await xml(path.join(res, 'values/strings.xml'));
const stringMap = new Map(elements(strings, 'string').map((item) => [item.getAttribute('name'), item.textContent]));
assert.equal(stringMap.get('app_name'), 'ConnectWallet');
assert.equal(stringMap.get('title_activity_main'), 'ConnectWallet');
assert.equal(stringMap.get('package_name'), appId);
for (const name of ['ic_launcher', 'ic_launcher_round']) {
  const adaptive = await xml(path.join(res, `mipmap-anydpi-v26/${name}.xml`));
  assert.equal(attr(elements(adaptive, 'foreground')[0], 'drawable'), '@mipmap/ic_launcher_foreground');
  assert.equal(attr(elements(adaptive, 'background')[0], 'drawable'), '@color/ic_launcher_background');
}

const gradle = await read(path.join(app, 'build.gradle'));
assert.match(gradle, /namespace\s*=\s*"com\.connectcoincrypto\.connectwallet\.mobile\.alpha"/);
assert.match(gradle, /applicationId\s+"com\.connectcoincrypto\.connectwallet\.mobile\.alpha"/);
assert.match(gradle, /versionCode\s+1\b/);
assert.match(gradle, /versionName\s+"1\.0\.0-alpha\.1"/);
assert.match(gradle, /resourceConfigurations\s*\+=\s*\['en'\]/);
assert.match(gradle, /release\s*\{\s*debuggable\s+false/);
assert.match(gradle, /testImplementation\s+'org\.json:json:20250517'/);
assert.match(gradle, /testImplementation\s+"junit:junit:\$junitVersion"/);
assert.match(gradle, /implementation\s+'com\.journeyapps:zxing-android-embedded:4\.3\.0'/);
const wrapper = await read(path.join(mobile, 'android/gradle/wrapper/gradle-wrapper.properties'));
assert.match(wrapper, /^distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.14\.3-bin\.zip\r?$/m);
assert.match(wrapper, /^distributionSha256Sum=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531\r?$/m);
assert.match(wrapper, /^validateDistributionUrl=true\r?$/m);
assert.match(await read(path.join(mobile, 'android/build.gradle')), /classpath 'com\.android\.tools\.build:gradle:8\.13\.2'/);
const variables = await read(path.join(mobile, 'android/variables.gradle'));
assert.match(variables, /minSdkVersion\s*=\s*24\b/);
assert.match(variables, /compileSdkVersion\s*=\s*36\b/);
assert.match(variables, /targetSdkVersion\s*=\s*36\b/);
const config = JSON.parse(await read(path.join(mobile, 'capacitor.config.json')));
assert.equal(config.appId, appId);
assert.equal(config.android?.minWebViewVersion, 105);
assert.equal(config.android?.webContentsDebuggingEnabled, false);
assert.equal(config.android?.allowMixedContent, false);
assert.equal(config.android?.resolveServiceWorkerRequests, false);
assert.equal(config.server?.androidScheme, 'https');
assert.equal(config.server?.errorPath, 'unsupported-webview.html');
assert.equal(config.server?.url, undefined, 'Never ship a remote WebView development server');
assert(!config.server?.allowNavigation?.length, 'External WebView origins must not gain native bridge access');
const webTargets = Array.isArray(viteConfig.build.target) ? viteConfig.build.target : [viteConfig.build.target];
assert.ok(webTargets.includes('chrome105'), 'The build must retain Android WebView 105 support');
const fallback = await read(path.join(mobile, 'public/unsupported-webview.html'));
assert.match(fallback, /<html\s+lang="en">/);
assert.match(fallback, /default-src 'none'/);
assert.match(fallback, /href="unsupported-webview\.css"/);
assert.match(fallback, /version 105 or later/);
assert.doesNotMatch(fallback, /<script\b|\son\w+\s*=|<iframe\b|<form\b/i, 'The unsupported-WebView page must not need JavaScript');
assert.doesNotMatch(fallback, /https?:\/\//i, 'The fallback must work offline without opening another app');
assert.doesNotMatch(await read(path.join(mobile, 'public/unsupported-webview.css')), /@import|url\(/i);

// Structural guards complement (but cannot substitute for) executable Java tests.
const plugin = await read(path.join(java, 'ReadOnlyRpcPlugin.java'));
assert.match(plugin, /@CapacitorPlugin\(name\s*=\s*"ReadOnlyRpc"\)/);
assert.deepEqual([...plugin.matchAll(/@PluginMethod\s+public\s+void\s+(\w+)\s*\(/g)].map((match) => match[1]).sort(), ['cancelAll', 'query']);
assert.match(plugin, /shouldOverrideLoad\(Uri url\)/);
assert.match(plugin, /!"https"\.equals\(url\.getScheme\(\)\)/);
assert.match(plugin, /!"localhost"\.equals\(url\.getEncodedAuthority\(\)\)/);
assert.match(plugin, /transport\.close\(\)/);
const transport = await read(path.join(java, 'RpcTransport.java'));
const validationStart = transport.indexOf('static JSONObject validateParams(');
const validationEnd = transport.indexOf('private static long nowMs()', validationStart);
assert(validationStart >= 0 && validationEnd > validationStart);
const validatedMethods = [...transport.slice(validationStart, validationEnd).matchAll(/"(get\w+)"\.equals\(method\)/g)].map((match) => match[1]);
assert.deepEqual([...new Set(validatedMethods)].sort(), ['getaddressbalance', 'getaddresshistory', 'getchaintip']);
assert.match(transport, /public RpcTransport\(\)\s*\{\s*this\("connectcoin4\.com",\s*48190,/);
assert.doesNotMatch(transport, /public RpcTransport\(String/);
const activity = await read(path.join(java, 'MainActivity.java'));
// Replacement ordering was reviewed against this exact Capacitor source version:
// core plugins are eagerly loaded, then custom registrations overwrite their IDs
// before JS export/WebView load. A framework upgrade requires that review again.
assert.equal(JSON.parse(await read(path.join(mobile, 'node_modules/@capacitor/android/package.json'))).version, '8.5.2');
const registrations = [...activity.matchAll(/registerPlugin\((\w+)\.class\)/g)];
assert.deepEqual(registrations.map((match) => match[1]), ['DisabledHttp', 'BundledWebView', 'DisabledCookies', 'NativeWalletPlugin', 'NativePaymentInputPlugin', 'NativeExplorerPlugin']);
assert(registrations.every((match) => match.index < activity.indexOf('super.onCreate(')));
for (const [id, className] of [['CapacitorHttp', 'DisabledHttp'], ['WebView', 'BundledWebView'], ['CapacitorCookies', 'DisabledCookies']]) {
  assert.match(activity, new RegExp(`@CapacitorPlugin\\(name = "${id}"\\)\\s+public static final class ${className} extends Plugin`));
}
assert.doesNotMatch(activity, /@PluginMethod/, 'Capability-free core replacements must not expose callable methods');
for (const interfaceName of ['CapacitorHttpAndroidInterface', 'CapacitorCookiesAndroidInterface']) {
  assert(activity.includes(`removeJavascriptInterface("${interfaceName}")`), `The eagerly loaded ${interfaceName} must also be removed`);
}
assert.doesNotMatch(activity, /FLAG_SECURE/, 'Screen capture must remain available in the activity');
assert.match(activity, /setAllowFileAccess\(false\)/);
assert.match(activity, /setAllowContentAccess\(false\)/);
assert.match(activity, /shouldInterceptRequest/);
assert.match(activity, /setServiceWorkerClient/);
assert.doesNotMatch(registrations.map(x => x[1]).join(','), /ReadOnlyRpc/, 'Keep the legacy reader unregistered; use the bounded shared native RPC client');
const nativeWallet = await read(path.join(java, 'NativeWalletPlugin.java'));
const explorer = await read(path.join(java, 'NativeExplorerPlugin.java'));
const explorerPolicy = await read(path.join(java, 'NativeExplorer.java'));
assert.match(explorer, /@CapacitorPlugin\(name = "NativeExplorer"\)/);
assert.deepEqual([...explorer.matchAll(/@PluginMethod\s+public\s+void\s+(\w+)\s*\(/g)].map((match) => match[1]), ['openTransaction']);
assert.match(explorer, /new Intent\(Intent\.ACTION_VIEW, Uri\.parse\(NativeExplorer\.transactionUrl\(options\)\)\)/);
assert.match(explorer, /\.addCategory\(Intent\.CATEGORY_BROWSABLE\)/);
assert.match(explorer, /intent = transactionIntent\(call\.getData\(\)\)/);
assert.match(explorer, /destroyed \|\| !active \|\| getActivity\(\) != activity/);
assert.match(explorer, /!activity\.hasWindowFocus\(\)/);
assert.match(explorer, /activity\.startActivity\(intent\)/);
assert.match(explorerPolicy, /"https:\/\/explorer\.connectcoincrypto\.com\/tx\/"/);
assert.match(explorerPolicy, /options\.length\(\) != 1 \|\| !options\.has\("txid"\)/);
assert.match(explorerPolicy, /!\(value instanceof String\)/);
assert.match(explorerPolicy, /txid\.length\(\) != 64/);
assert.doesNotMatch(explorer + explorerPolicy,
  /WalletCrypto|WalletVault|VaultSession|NativeWalletPlugin|MobileRuntime|RpcTransport|MobileRpc|queryPublic|reviewPayment|reviewP2C|privateKey|mnemonic|\.broadcast\(|\.sign\(|loadUrl\(|getMessage\(|\bLog\.|ContentResolver|setComponent\(|setPackage\(/,
  'The explorer must remain a fixed public lookup outside the wallet WebView, without keys, RPC, secrets or generic URLs');
const nativeClaims = await read(path.join(java, 'NativeClaims.java'));
const nativeMethods = [...nativeClaims.matchAll(/private\s+static\s+native\s+\w+\s+(native\w+)\s*\(/g)].map(x => x[1]).sort();
const claimsExports = await read(path.join(mobile, 'native/jni-exports.map'));
const exportedMethods = [...claimsExports.matchAll(/Java_com_connectcoincrypto_connectwallet_mobile_alpha_NativeClaims_(native\w+);/g)].map(x => x[1]).sort();
const jniSource = await read(path.join(mobile, 'native/src/jni.cpp'));
const implementedMethods = [...jniSource.matchAll(/Java_com_connectcoincrypto_connectwallet_mobile_alpha_NativeClaims_(native\w+)\(/g)].map(x => x[1]).sort();
assert.deepEqual(nativeMethods, ['nativeCancel', 'nativeCapture', 'nativeCreate', 'nativeCreateStartLimiter', 'nativeDestroy', 'nativeDestroyStartLimiter', 'nativeHasStarted', 'nativeProbeRsa', 'nativeResetStartSchedule', 'nativeSetStartRate', 'nativeStartedAgeNanos']);
assert.deepEqual(exportedMethods, nativeMethods, 'Every declared native claims method must be exported by the Android library');
assert.deepEqual(implementedMethods, nativeMethods, 'JNI implementations must match the exact claims contract');
assert.doesNotMatch(nativeClaims, /@PluginMethod/, 'The native capture/start acknowledgement must not be exposed to the WebView');
assert.doesNotMatch(nativeWallet, /FLAG_SECURE/, 'Screen capture must remain available in native dialogs');
assert.match(nativeWallet, /else showRecoveryPhrase\(call, WalletCrypto\.generateMnemonic\(24\)\)/);
assert.match(nativeWallet, /"Step 1 of 3: Recovery words"/);
assert.match(nativeWallet, /"Step 2 of 3: Confirm recovery words"/);
assert.match(nativeWallet, /"Step 3 of 3: Protect your wallet"/);
const phraseScreen = nativeWallet.slice(nativeWallet.indexOf('private void showRecoveryPhrase('), nativeWallet.indexOf('private void backupCheck('));
assert.doesNotMatch(phraseScreen, /\bfield\(|\bEditText\b|saveWallet\(/, 'Read-only phrase review must precede input and persistence');
assert.match(phraseScreen, /backupCheck\(call, mnemonic, false\)/);
assert.match(nativeWallet, /"Review words", \(\) -> showRecoveryPhrase\(call, mnemonic\)/);
assert.match(nativeWallet, /keepSetupDraft = setupDraft && dialogCall != null && \(backupPickerPending \|\| backupDestination != null\s*\|\| importPickerPending \|\| importSource != null \|\| dialog != null && dialog\.isShowing\(\)\)/);
assert.match(nativeWallet, /if \(!keepSetupDraft\) interruptPending\(\)/);
assert.match(nativeWallet, /"Replace current wallet\?"/);
assert.match(nativeWallet, /Intent\.ACTION_CREATE_DOCUMENT/);
assert.match(nativeWallet, /@ActivityCallback private void replacementBackupChosen\(/);
assert.match(nativeWallet, /dialogCall != call \|\| !backupPickerPending \|\| replacementSource == null/,
  'Only the original in-memory setup call may accept the backup picker result');
assert.match(nativeWallet, /subscriptionHandler\.postDelayed\(deadline, 30000\)/,
  'A stalled backup provider must not leave an unbounded replacement operation');
assert.match(nativeWallet, /private static final ThreadPoolExecutor BACKUP_IO = new ThreadPoolExecutor\(0, 1, 30, TimeUnit\.SECONDS,[\s\S]*?new java\.util\.concurrent\.SynchronousQueue<>\(\)/,
  'Backup provider IO must have a process-bounded slot without an accumulating queue');
const backupCopy = nativeWallet.slice(nativeWallet.indexOf('private void resumeReplacementBackup('), nativeWallet.indexOf('private void chooseImportFile('));
assert.match(backupCopy, /executeBackup\(call,/);
assert.doesNotMatch(backupCopy, /\bexecute\(call,/,
  'A blocked document provider must never occupy the signing/KDF worker');
assert.match(nativeWallet, /NativeWalletBackup\.verify\(source, NativeWalletBackup\.read\(input\)\)/,
  'An external backup must be read back and verified before replacement is authorized');
assert.match(nativeWallet, /replacingWallet \? "Replace wallet" : "Create encrypted wallet"/,
  'Replacement requires an explicit native final action');
const saveWallet = nativeWallet.slice(nativeWallet.indexOf('private void saveWallet('), nativeWallet.indexOf('@PluginMethod public void unlock('));
const clearSetupDraft = saveWallet.indexOf('setupDraft = false');
assert(clearSetupDraft >= 0 && clearSetupDraft < saveWallet.indexOf('execute(call'),
  'The background exception must end before wallet encryption/persistence starts');
assert.match(saveWallet, /!replacementBackupVerified \|\| replacementSource == null/);
assert(saveWallet.indexOf('NativeWalletBackup.verify(replacementSource, readWalletSnapshot())') < saveWallet.indexOf('file.startWrite()'),
  'Replacement must recheck the backed-up source before touching the current wallet');
assert(saveWallet.indexOf('stream.getFD().sync()') < saveWallet.indexOf('if (replacingWallet) runtime.stop()'),
  'An unfinished setup or failed encryption must not stop Automatic Claims');
assert(saveWallet.indexOf('file.finishWrite(stream)') < saveWallet.indexOf('generation++'),
  'Account generations must only advance after the new encrypted wallet is committed');
assert(saveWallet.indexOf('NativeWalletBackup.verify(encoded, readWalletSnapshot())') < saveWallet.indexOf('account = nextAccount'),
  'Silent AtomicFile finish failures must never authorize a new in-memory account');
assert.match(saveWallet, /restoreReplacementSnapshot\(\)/,
  'A failed replacement commit must attempt to preserve the verified original');
assert.match(saveWallet, /throw new StorageUncertain\(\)/,
  'A failed restoration must not be reported as an ordinary unchanged-wallet import error');
assert.match(nativeWallet, /error instanceof StorageUncertain \? "STORAGE_UNCERTAIN"/);
assert.match(saveWallet, /synchronized \(PAYMENT_STORAGE\) \{\s*synchronized \(lifecycle\) \{\s*requireLive\(expected\)/,
  'Creation and both import paths must serialize atomic installation against HD metadata writes');
assert.doesNotMatch(saveWallet, /lastPayment\s*=|payment-reservations|last-payment-public|claims-public-receipt|\.delete\(/,
  'Replacing wallet keys must preserve old public receipts and unknown payment outcomes');
const destroyWallet = nativeWallet.slice(nativeWallet.indexOf('protected void handleOnDestroy()'));
assert.match(destroyWallet, /interruptPending\(\)/);
assert.match(destroyWallet, /unregisterNetworkCallback\(walletNetworkCallback\)/);
assert.match(destroyWallet, /subscriptions\.close\(\)/);
assert.doesNotMatch(nativeWallet, /field\("BIP39 passphrase|passphrase\.getText\(\)/);
assert.match(nativeWallet, /WalletVault\.newPayload\("ConnectWallet mobile", mnemonic, ""\)/);
assert.match(nativeWallet, /new VaultSession\(payload\.getString\("mnemonic"\), payload\.optString\("passphrase", ""\)\)/,
  'Removing the setup field must not change keys in an existing encrypted wallet');
const exposed = [...nativeWallet.matchAll(/@PluginMethod\s+public\s+void\s+(\w+)\s*\(/g)].map(x => x[1]).sort();
assert.deepEqual(exposed, ['changePassword', 'claimsCheckSubmission', 'claimsLimits', 'claimsPolicy', 'claimsStart', 'claimsState', 'claimsStop', 'create', 'dismissPaymentBatch', 'exportWallet', 'getPaymentBatch', 'getRecoverySnapshots', 'getSettings', 'getState', 'importRecovery', 'importWallet', 'lock', 'newAddress', 'queryPublic', 'readPaymentClipboard', 'recoverAddresses', 'reviewP2C', 'reviewPayment', 'saveSettings', 'unlock', 'viewRecoveryPhrase', 'watchAccount'].sort());
const recoverySnapshots = nativeWallet.slice(nativeWallet.indexOf('@PluginMethod public void getRecoverySnapshots('), nativeWallet.indexOf('@PluginMethod public void readPaymentClipboard('));
assert.match(recoverySnapshots, /if \(!empty\(call\)\) return/);
assert.match(recoverySnapshots, /hdWallet\.recoverySnapshots\(\)/);
assert.doesNotMatch(recoverySnapshots, /runtime\.rpc|readFully|mnemonic|privateKey|vault\.payload/,
  'Recovery reuse may expose only the validated public in-memory checkpoint/history groups');
assert.doesNotMatch(exposed.filter((method) => method !== 'exportWallet').join(','), /signDigest|privateKey|mnemonic|broadcast|export|readFile/i);
const exportWallet = nativeWallet.slice(nativeWallet.indexOf('@PluginMethod public void exportWallet('), nativeWallet.indexOf('private static char[] readSecret('));
const importWallet = nativeWallet.slice(nativeWallet.indexOf('@PluginMethod public void importWallet('), nativeWallet.indexOf('@PluginMethod public void exportWallet('));
assert.match(exportWallet, /if \(!empty\(call\) \|\| !begin\(call\)\) return/);
assert.match(importWallet, /if \(!empty\(call\) \|\| !begin\(call\)\) return/);
for (const entry of [exportWallet, importWallet]) {
  assert.match(entry, /synchronized \(lifecycle\) \{\s*if \(!active \|\| destroyed \|\| dialogCall != call\)/,
    'A paused or superseded file operation must not set flags for a later wallet action');
}
assert.match(importWallet, /fileImportMode = true/);
assert.match(importWallet, /beginSetup\(call, true\)/);
assert.doesNotMatch(importWallet, /\bshow\(|\bpanel\(/,
  'The file-import action must not offer another phrase/file chooser');
assert.match(nativeWallet, /@PluginMethod public void importRecovery\(PluginCall call\) \{ setup\(call, true\); \}/,
  'Recovery phrase import must remain a separate native entry point');
assert.match(nativeWallet, /call\.resolve\(exported \? new JSObject\(\)\.put\("exported", true\) : state\(\)\)/,
  'Encrypted-file export returns only a completion flag, never file data, paths or secrets');
assert.match(nativeWallet, /Intent\.ACTION_OPEN_DOCUMENT/);
assert.match(nativeWallet, /@ActivityCallback private void walletImportFileChosen\(/);
assert.match(nativeWallet, /dialogCall != call \|\| !importPickerPending \|\| !fileImportMode/,
  'Only the original live import operation may accept a document result');
assert.match(nativeWallet, /source == null \|\| !"content"\.equals\(source\.getScheme\(\)\)/);
const importFile = nativeWallet.slice(nativeWallet.indexOf('private void resumeWalletFileImport('), nativeWallet.indexOf('private void registerBackupDescriptor('));
const importRead = nativeWallet.slice(nativeWallet.indexOf('private void resumeWalletFileImport('), nativeWallet.indexOf('private void requestFilePassword('));
assert.doesNotMatch(importRead, /\bexecute\(call,/,
  'A blocked import document provider must not occupy the signing/KDF worker');
assert.match(importFile, /executeBackup\(call,/);
assert.match(importFile, /subscriptionHandler\.postDelayed\(deadline, 30000\)/);
assert.match(importFile, /NativeWalletBackup\.read\(input\)/);
assert.match(importFile, /NativeWalletBackup\.openForImport\(source, secret\)/);
assert(importFile.indexOf('NativeWalletBackup.openForImport(source, secret)') < importFile.indexOf('installWallet(call, expected, prepared)'),
  'Authentication and recovery validation must precede file installation');
assert.doesNotMatch(importFile + importWallet + exportWallet, /call\.get(?:String|Object|Array|Boolean|Int)|\.put\("(?:password|mnemonic|ciphertext|uri|path)"/,
  'Import/export must use native-only password and picker input, never JavaScript-provided file data');
const changePassword = nativeWallet.slice(nativeWallet.indexOf('@PluginMethod public void changePassword('), nativeWallet.indexOf('@PluginMethod public void viewRecoveryPhrase('));
const viewRecovery = nativeWallet.slice(nativeWallet.indexOf('@PluginMethod public void viewRecoveryPhrase('), nativeWallet.indexOf('private void setup('));
for (const entry of [changePassword, viewRecovery]) {
  assert.match(entry, /if \(!empty\(call\) \|\| !begin\(call\)\) return/);
  assert.match(entry, /synchronized \(lifecycle\) \{\s*if \(!active \|\| destroyed \|\| dialogCall != call\)/);
  assert.doesNotMatch(entry, /call\.get(?:String|Object|Array|Boolean|Int)|\.put\("(?:password|mnemonic|passphrase|ciphertext)"|setupDraft\s*=\s*true|runtime\.rpc|setPrimaryClip|\bLog\./,
    'Wallet management must authenticate locally with native fields and keep secrets out of the bridge, RPC, storage drafts and clipboard');
}
assert(changePassword.indexOf('lockNow()') < changePassword.indexOf('readWalletSnapshot()'),
  'Rekey must revoke old HD encryption sessions before taking its storage snapshot');
assert.match(changePassword, /NativeWalletManagement\.commitPasswordChange\(source, replacement/);
assert(changePassword.indexOf('commitPasswordChange') < changePassword.indexOf('walletCommitted = true'),
  'Password change success requires durable readback verification');
assert.match(viewRecovery, /WalletVault\.openForUpdate\(WalletVault\.parse\(source\), secrets\[0\]\)/);
assert.doesNotMatch(viewRecovery, /file\.startWrite|lockNow\(|new VaultSession|session\s*=/,
  'Viewing recovery must neither change storage nor implicitly unlock or replace the signing session');
assert.match(nativeWallet, /else if \(viewed\) call\.resolve\(new JSObject\(\)\.put\("viewed", true\)\)/);
assert.match(nativeWallet, /subscriptionHandler\.postDelayed\(recoveryHide, 60_000\)/);
assert.match(nativeWallet, /if \(recoveryHide != null\) subscriptionHandler\.removeCallbacks\(recoveryHide\)/);
assert.match(nativeWallet, /setupDraft = false;\s*clearManagementSecrets\(\)/,
  'Lifecycle interruption must wipe wallet-management password and phrase buffers');
const batchReview = nativeWallet.slice(nativeWallet.indexOf('private void prepareBatchReview('), nativeWallet.indexOf('private void submitPaymentBatch('));
assert.match(batchReview, /fresh\.verifyBatch\(plans, send\.useAllBalance, send\.amount\)/);
assert.match(batchReview, /beforeSigning\.verifyBatch\(plans, send\.useAllBalance, send\.amount\)/);
assert.match(batchReview, /"Confirm payment batch"/);
assert.match(batchReview, /NativeSendBatch\.verify\(send, batch/);
assert.match(batchReview, /NativeTransactions\.signPayment\(plans\.getJSONObject\(part\), signingSession, signingCheck\)/);
assert.match(batchReview, /Map<String, String> retainedParents/);
assert.match(batchReview, /retainedParents\.putIfAbsent\(row\.getString\("txid"\), raw\)/);
assert.match(batchReview, /if \(retained == null\) retainedHex \+= raw\.length\(\);\s*else row\.put\("rawTransaction", retained\)/,
  'Batch funding must reuse retained parent strings after cache eviction, so its byte budget bounds actual retained data');
const singleSubmission = nativeWallet.slice(nativeWallet.indexOf('private void reviewTransfer('), nativeWallet.indexOf('private void prepareBatchReview('));
const batchSubmission = nativeWallet.slice(nativeWallet.indexOf('private void submitPaymentBatch('), nativeWallet.indexOf('private static final class BatchNotSent'));
assert.match(singleSubmission, /synchronized \(PAYMENT_STORAGE\) \{\s*signingCheck\.check\(\);\s*requireNoPendingBatch\(\);\s*if \(!BATCH_IN_FLIGHT\.compareAndSet\(false, true\)\)/,
  'An ordinary payment must join the process-wide submission gate before reserving inputs');
assert.match(batchSubmission, /synchronized \(PAYMENT_STORAGE\) \{\s*check\.check\(\);\s*if \(!BATCH_IN_FLIGHT\.compareAndSet\(false, true\)\)/);
for (const submission of [singleSubmission, batchSubmission]) {
  assert.match(submission, /finally \{\s*synchronized \(lifecycle\) \{ broadcasting = false; \}\s*BATCH_IN_FLIGHT\.set\(false\);/,
    'Every submission exit must release the process-wide gate in finally');
}
assert(singleSubmission.indexOf('BATCH_IN_FLIGHT.compareAndSet(false, true)') < singleSubmission.indexOf('previousReservations = readReservations()')
  && singleSubmission.indexOf('MobilePaymentCancellation.recordIfUnsent(') < singleSubmission.indexOf('BATCH_IN_FLIGHT.set(false)'),
  'Ordinary payment reservation snapshots and late unsent cleanup must both remain inside the submission gate');
const reconcileBatch = nativeWallet.slice(nativeWallet.indexOf('private JSONObject readBatchReceiptAndReconcile('), nativeWallet.indexOf('private MobilePaymentBatch.Store batchStore('));
assert.match(reconcileBatch, /synchronized \(PAYMENT_STORAGE\)/);
assert.match(reconcileBatch, /saved != null && !BATCH_IN_FLIGHT\.get\(\)/);
assert.match(reconcileBatch, /MobilePaymentBatch\.reconcileNotSent\(saved, held\)/);
assert.match(reconcileBatch, /writeVerifiedPublicFile\("payment-reservations-v1\.json", recovered\)/,
  'Idle crash recovery must durably release only proven-unsent batch inputs, fenced against a new submission');
assert.doesNotMatch(reconcileBatch, /\.broadcast\(|\.sign\(/);
const dismissBatch = nativeWallet.slice(nativeWallet.indexOf('@PluginMethod public void dismissPaymentBatch('), nativeWallet.indexOf('private NativeP2CPolicy.Request probeBounty('));
assert.match(dismissBatch, /MobilePaymentBatch\.acknowledge\(saved, id\)/);
assert.doesNotMatch(dismissBatch, /\.broadcast\(|\.sign\(|releaseNotSent|payment-reservations/,
  'Dismissing a batch receipt must never spend, rebroadcast, or release uncertain inputs');
const clipboardRead = nativeWallet.slice(nativeWallet.indexOf('@PluginMethod public void readPaymentClipboard('), nativeWallet.indexOf('@PluginMethod public void watchAccount('));
assert.match(clipboardRead, /if \(!empty\(call\)\) return/);
assert.match(clipboardRead, /!active \|\| destroyed \|\| generation != expected/);
assert.match(clipboardRead, /!activity\.hasWindowFocus\(\)/);
assert.match(clipboardRead, /activity\.runOnUiThread\(/);
assert.match(clipboardRead, /clipboard\.getPrimaryClip\(\)/);
assert.match(clipboardRead, /clip\.getItemAt\(0\)\.getText\(\)/);
assert.match(clipboardRead, /new JSObject\(\)\.put\("text", NativePaymentClipboard\.boundedText\(text\)\)/);
assert.doesNotMatch(clipboardRead, /coerceTo\w+\(|getHtmlText\(|getUri\(|getIntent\(|setPrimaryClip\(|addPrimaryClipChangedListener\(|getMessage\(|\bLog\./,
  'Payment paste must only read bounded explicit text on demand without clipboard observers, writes, coercion, or content logging');
const clipboardPolicy = await read(path.join(java, 'NativePaymentClipboard.java'));
assert.match(clipboardPolicy, /MAX_LENGTH = 1024;/);
assert.match(clipboardPolicy, /length == 0 \|\| length > MAX_LENGTH/);
const paymentInput = await read(path.join(java, 'NativePaymentInputPlugin.java'));
assert.match(paymentInput, /@CapacitorPlugin\(name = "NativePaymentInput"\)/,
  'Camera permission is requested by the explicit scanner activity, never generic bridge permission calls');
assert.deepEqual([...paymentInput.matchAll(/@PluginMethod\s+public\s+void\s+(\w+)\s*\(/g)].map((match) => match[1]).sort(), ['scanPaymentQr', 'takePaymentLink']);
assert.doesNotMatch(paymentInput, /WalletCrypto|WalletVault|VaultSession|NativeWalletPlugin|MobileRuntime|RpcTransport|MobileRpc|queryPublic|reviewPayment|reviewP2C|privateKey|mnemonic|\.broadcast\(|\.sign\(/,
  'Payment intake must not reach wallet secrets, signing or transaction/RPC operations');
assert.match(paymentInput, /notifyListeners\("paymentLinkAvailable", new JSObject\(\)\)/,
  'Payment events carry no untrusted text and are not retained as an unbounded event queue');
assert.match(paymentInput, /intent\.setData\(null\)/, 'Consumed external links must not replay on activity recreation');
assert.equal([...paymentInput.matchAll(/if \(!empty\(call\)\) return/g)].length, 2,
  'Neither scanner nor link inbox may accept caller-supplied native options');
assert.match(paymentInput, /NativePaymentInput\.boundedText\(data\.getStringExtra\(Intents\.Scan\.RESULT\)\)/);
assert.match(paymentInput, /links\.close\(\)/);
assert.match(paymentInput, /destroyed \|\| call == null \|\| scanning != call/);
assert.doesNotMatch(paymentInput, /getMessage\(|\bLog\.|SharedPreferences|FileOutputStream|ContentResolver|openConnection\(|ACTION_SEND/,
  'Public payment input must not persist, log, fetch or export scanned text');
const inputPolicy = await read(path.join(java, 'NativePaymentInput.java'));
assert.match(inputPolicy, /MAX_LENGTH = 1024;/);
assert.match(inputPolicy, /text\.length\(\) == 0 \|\| text\.length\(\) > MAX_LENGTH/);
assert.match(inputPolicy, /private Input pending;/);
assert.match(inputPolicy, /Input result = pending; pending = null; return result;/);
assert.match(inputPolicy, /if \(!VIEW\.equals\(action\)/);
assert.match(inputPolicy, /SCHEME_PREFIX = "connectcoin:"/);
const captureActivity = await read(path.join(java, 'PaymentQrCaptureActivity.java'));
assert.match(captureActivity, /setCaptureActivity\(PaymentQrCaptureActivity\.class\)/);
assert.match(captureActivity, /setDesiredBarcodeFormats\(ScanOptions\.QR_CODE\)/);
assert.match(captureActivity, /setBeepEnabled\(false\)/);
assert.match(captureActivity, /setBarcodeImageEnabled\(false\)/);
assert.match(captureActivity, /setIntent\(createIntent\(this\)\);\s*super\.onCreate\(savedInstanceState\)/,
  'Scanner options must be fixed before the library can process caller extras');
assert.match(nativeWallet, /put\("rpcTransport", "tcp"\)\.put\("rpcEndpoint", settings\.rpcHost \+ ":" \+ settings\.rpcPort\)/);
assert.match(nativeWallet, /source != subscriptionSource/,
  'Old subscription instances must not deliver callbacks after an endpoint change');
assert.match(nativeWallet, /new MobileWalletSubscriptions\(event -> walletChanged\(event, source\), settings\.endpoint\(\)\)/);
assert.match(nativeWallet, /recoveryRunning\.get\(\) \|\| !runtime\.canChangeEndpoint\(\)/);
assert.match(nativeWallet, /lockNow\(\);\s*runtime\.changeEndpoint\(next\)/,
  'Switching endpoints revokes old signing and query generations first');
assert.match(nativeWallet, /new NativeInactivityPolicy\(\)/);
assert.match(nativeWallet, /new AlertDialog\(context\)\s*\{\s*@Override public boolean dispatchTouchEvent/,
  'Native dialog interactions must use the same idle timer as WebView interactions');
assert.match(activity, /onUserInteraction\(\)/);
const watchAccount = nativeWallet.slice(nativeWallet.indexOf('@PluginMethod public void watchAccount('), nativeWallet.indexOf('private void scheduleSubscriptionRefresh('));
assert.match(watchAccount, /if \(!empty\(call\)\) return/);
assert.match(watchAccount, /String own = walletId\(\)/);
assert.match(watchAccount, /subscriptions\.isConnected\(own\)/);
assert.doesNotMatch(watchAccount, /call\.get(?:String|Object|Array|Boolean|Int)|session|password|privateKey/,
  'Subscriptions bind only the native public account, including while locked');
assert.match(nativeWallet, /watchRequested && active && !destroyed && online && own != null/);
assert.match(nativeWallet, /NET_CAPABILITY_VALIDATED/);
assert.match(nativeWallet, /registerDefaultNetworkCallback\(walletNetworkCallback\)/);
assert.match(nativeWallet, /walletEventGeneration != watchGeneration/);
assert.match(nativeWallet, /MobileWalletSubscriptions\.Event\.merge\(walletEvent, event\)/,
  'Coalescing must preserve address and reset hints across ordinary tips');
assert.match(nativeWallet, /subscriptions\.isCurrent\(event\)/,
  'Native callbacks must remain fenced to their originating connection');
assert.match(nativeWallet, /NativeAccountPolicy\.requireQuery\(ownedAccounts\(\), walletId\(\), method, params\)/,
  'Every HD query must be bound to native-derived wallet addresses');
assert.match(nativeWallet, /wallet\.allocateChange\(mine\.getInt\("index"\), signingCheck::check\)/,
  'The reviewed HD change path must be committed before network submission');
assert(nativeWallet.indexOf('wallet.allocateChange(') < nativeWallet.indexOf('submission = runtime.rpc.broadcast('));
assert.match(nativeWallet, /if \(hdWallet != null\) \{ hdWallet\.close\(\); hdWallet = null; \}/,
  'Lock must destroy encrypted-metadata update capability');
const lockWallet = nativeWallet.slice(nativeWallet.indexOf('private void lockNow('), nativeWallet.indexOf('private static boolean stored('));
assert.doesNotMatch(lockWallet, /pendingHdUsed\.clear\(/,
  'Validated public used-address hints must survive lock until native HD metadata is updated');
assert.match(nativeWallet, /if \(call != null\) owner\.requestRecovery\(check\)/,
  'An explicit rescan must not become a no-op after an earlier completed discovery');
assert.match(nativeWallet, /NativeWalletErrors\.publicReadCode\(error\)/,
  'Expired HD journal cursors must retain their stable error code for rebuilding');
const chooseBackup = nativeWallet.slice(nativeWallet.indexOf('private void chooseReplacementBackup('), nativeWallet.indexOf('@ActivityCallback private void replacementBackupChosen('));
assert.match(chooseBackup, /synchronized \(PAYMENT_STORAGE\) \{\s*synchronized \(lifecycle\) \{\s*requireLive\(expected\);[\s\S]*?source = readWalletSnapshot\(\)/,
  'AtomicFile backup reads must not race HD metadata commits');
assert.match(nativeWallet, /new JSObject\(\)\.put\("address", event\.address\)\.put\("reason", event\.reason\)[\s\S]*?\.put\("reorg", event\.reorg\)\.put\("resync_required", event\.resyncRequired\)/);
assert.match(nativeWallet, /if \(event\.tip != null\) hint\.put\("tip", event\.tip\)/);
assert.match(nativeWallet, /notifyListeners\("walletChanged", hint, false\)/,
  'Only bounded validated public tip/address hints may be sent; do not retain raw server events');
assert.match(nativeWallet, /void getState\(PluginCall call\) \{ if \(empty\(call\)\) call\.resolve\(state\(\)\); \}/,
  'Reading native state must not reconnect or restart the public subscription socket');
const runtime = await read(path.join(java, 'MobileRuntime.java'));
const walletSettings = await read(path.join(java, 'MobileWalletSettings.java'));
assert.match(walletSettings, /new Settings\("dark", 0, new MobileRpcClient\.TcpEndpoint\("connectcoin4\.com", 48190\)\)/,
  'Foreground inactivity lock must default to disabled');
assert.match(runtime, /rpc = new MobileRpcClient\(settings\.endpoint\(\)\)/);
assert.match(runtime, /settings = MobileWalletSettings\.read\(context\)/);
const appSource = await read(path.join(mobile, 'src/app.mjs'));
const appHtml = await read(path.join(mobile, 'index.html'));
assert.match(appHtml, /id="import-recovery"[^>]*>Import recovery phrase<\/button>/);
assert.match(appHtml, /id="import-wallet"[^>]*>Import wallet file<\/button>/);
assert.match(appSource, /\['import-recovery', 'importRecovery'\]/);
assert.match(appSource, /\['import-wallet', 'importWallet'\]/);
assert.doesNotMatch(appHtml, /id="(?:watch-form|watch-address|watch-submit|forget)"|WATCH-ONLY ACCOUNT/);
const displayCacheIO = appSource.slice(appSource.indexOf('async function readPublicSnapshot('), appSource.indexOf('function clearPaymentInputError('));
assert.match(displayCacheIO, /walletId\(vault\) !== identity/);
assert.match(displayCacheIO, /key: PUBLIC_SNAPSHOT_PREFIX \+ encodeURIComponent\(endpoint\) \+ '\.' \+ identity/);
assert.match(displayCacheIO, /endpoint !== activeRpcEndpoint/);
assert.match(appSource, /PUBLIC_SNAPSHOT_PREFIX = 'connectwallet\.mobile\.public-snapshot\.mainnet\.v2\.'/);
assert.doesNotMatch(appSource.replace(displayCacheIO, ''), /Preferences\.(?:get|set)|profile\.address|PUBLIC_PROFILE/,
  'Only wallet-scoped public display snapshots may use preferences; account authority stays native');
assert.match(appSource, /const info = await wallet\.getState\(\)/);
assert.match(appSource, /if \(expected === nativeRevision\) adoptNativeAccount\(info\)/);
assert.match(runtime, /NET_CAPABILITY_NOT_METERED/);
assert.match(await read(path.join(java, 'ClaimsService.java')), /START_NOT_STICKY/);

const icons = spawnSync(process.execPath, [path.join(mobile, 'scripts/generate-android-icons.mjs'), '--check'], { encoding: 'utf8' });
assert.equal(icons.status, 0, icons.stderr || icons.stdout || String(icons.error));
console.log(icons.stdout.trim());
console.log(`Android alpha static checks passed (${xmlCount} XML documents, manifest, backup, pinned build tools, WebView fallback and restricted native wallet bridge).`);
