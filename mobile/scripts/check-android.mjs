// Static packaging/security regression checks. This does not replace Gradle,
// merged-manifest inspection, JVM transport tests or an actual device test.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DOMParser } = createRequire(path.join(mobile, '../package.json'))('@xmldom/xmldom');
const app = path.join(mobile, 'android/app');
const res = path.join(app, 'src/main/res');
const java = path.join(app, 'src/main/java/com/connectcoincrypto/connectwallet/mobile/alpha');
const android = 'http://schemas.android.com/apk/res/android';
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
const expectedPermissions = ['android.permission.ACCESS_NETWORK_STATE', 'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE', 'android.permission.INTERNET'];
assert.deepEqual(permissions, expectedPermissions, 'Only network and explicitly declared claims service permissions are allowed');
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
const activities = elements(manifest, 'activity');
assert.equal(activities.length, 1);
assert.equal(attr(activities[0], 'name'), '.MainActivity');
assert.equal(attr(activities[0], 'exported'), 'true'); // Required by the launcher.
assert.deepEqual(elements(manifest, 'action').map((item) => attr(item, 'name')), ['android.intent.action.MAIN']);
assert.deepEqual(elements(manifest, 'category').map((item) => attr(item, 'name')), ['android.intent.category.LAUNCHER']);
assert.equal(elements(manifest, 'data').length, 0, 'No deep-link/URL entry points in this alpha');

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
assert.equal(stringMap.get('app_name'), 'ConnectWallet Alpha');
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
assert.match(await read(path.join(mobile, 'vite.config.mjs')), /target:\s*'chrome105'/);
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
assert.deepEqual(registrations.map((match) => match[1]), ['DisabledHttp', 'BundledWebView', 'DisabledCookies', 'NativeWalletPlugin']);
assert(registrations.every((match) => match.index < activity.indexOf('super.onCreate(')));
for (const [id, className] of [['CapacitorHttp', 'DisabledHttp'], ['WebView', 'BundledWebView'], ['CapacitorCookies', 'DisabledCookies']]) {
  assert.match(activity, new RegExp(`@CapacitorPlugin\\(name = "${id}"\\)\\s+public static final class ${className} extends Plugin`));
}
assert.doesNotMatch(activity, /@PluginMethod/, 'Capability-free core replacements must not expose callable methods');
for (const interfaceName of ['CapacitorHttpAndroidInterface', 'CapacitorCookiesAndroidInterface']) {
  assert(activity.includes(`removeJavascriptInterface("${interfaceName}")`), `The eagerly loaded ${interfaceName} must also be removed`);
}
assert.match(activity, /FLAG_SECURE/);
assert.match(activity, /setAllowFileAccess\(false\)/);
assert.match(activity, /setAllowContentAccess\(false\)/);
assert.match(activity, /shouldInterceptRequest/);
assert.match(activity, /setServiceWorkerClient/);
assert.doesNotMatch(registrations.map(x => x[1]).join(','), /ReadOnlyRpc/, 'Do not export the old plaintext transport');
const nativeWallet = await read(path.join(java, 'NativeWalletPlugin.java'));
const exposed = [...nativeWallet.matchAll(/@PluginMethod\s+public\s+void\s+(\w+)\s*\(/g)].map(x => x[1]).sort();
assert.deepEqual(exposed, ['claimsCheckSubmission', 'claimsPolicy', 'claimsStart', 'claimsState', 'claimsStop', 'create', 'getState', 'importRecovery', 'lock', 'queryPublic', 'reviewPayment', 'unlock'].sort());
assert.doesNotMatch(exposed.join(','), /signDigest|privateKey|mnemonic|broadcast|export|readFile/i);
const runtime = await read(path.join(java, 'MobileRuntime.java'));
assert.match(runtime, /TlsEndpoint\("connectcoin4\.com", 48191\)/);
assert.match(runtime, /NET_CAPABILITY_NOT_METERED/);
assert.match(await read(path.join(java, 'ClaimsService.java')), /START_NOT_STICKY/);

const icons = spawnSync(process.execPath, [path.join(mobile, 'scripts/generate-android-icons.mjs'), '--check'], { encoding: 'utf8' });
assert.equal(icons.status, 0, icons.stderr || icons.stdout || String(icons.error));
console.log(icons.stdout.trim());
console.log(`Android alpha static checks passed (${xmlCount} XML documents, manifest, backup, pinned build tools, WebView fallback and restricted native wallet bridge).`);
