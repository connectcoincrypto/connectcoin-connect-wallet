package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;

import android.Manifest;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.content.res.XmlResourceParser;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.view.WindowManager;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.Bridge;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethodHandle;
import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.xmlpull.v1.XmlPullParser;

/**
 * Bundled-app smoke tests for a CLEAN, isolated Android emulator only.
 * No watched address is installed and no foreground RPC is submitted. This
 * deliberately refuses a saved profile rather than deleting user preferences.
 * Active-socket cancellation and wire behavior are covered by RpcTransportTest
 * on loopback; here we verify the actual Android lifecycle reaches that transport.
 */
@RunWith(AndroidJUnit4.class)
public final class AlphaSmokeTest {
    private static final String APP_ID = "com.connectcoincrypto.connectwallet.mobile.alpha";
    private static final String PROFILE_KEY = "connectwallet.mobile.alpha.public-profile.v1";
    private Context context;
    private ActivityScenario<MainActivity> scenario;

    @Before public void requireCleanEmulator() {
        // Do not silently skip this guard: a physical-device invocation is a test failure.
        assertTrue("Run these tests only on an isolated Android emulator, not a physical device.",
            "ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE) || Build.MODEL.startsWith("sdk_gphone"));
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(APP_ID, context.getPackageName());
        assertFalse("Use a clean emulator installation. Existing public preferences must not be read, removed or queried.",
            context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).contains(PROFILE_KEY));
        assertNoPersistedContentOverride();
        assertFalse("Use a clean emulator installation without a native wallet.",
            new File(context.getNoBackupFilesDir(), "mobile-wallet-v1.json").exists());
    }

    @After public void closeActivity() {
        if (scenario != null) scenario.close();
    }

    private void launch() {
        scenario = ActivityScenario.launch(MainActivity.class);
        assertEquals(Lifecycle.State.RESUMED, scenario.getState());
        scenario.onActivity(activity -> assertEquals("The runtime must serve bundled assets, never a persisted file path.",
            Bridge.DEFAULT_WEB_ASSET_DIR, activity.getBridge().getServerBasePath()));
        assertNoPersistedContentOverride();
    }

    private void assertNoPersistedContentOverride() {
        // Capacitor's first-launch isNewBinary() writes serverBasePath="" along
        // with lastBinaryVersionCode/Name. That is a reset sentinel, not a file
        // override. Do not clear preferences or accept any nonempty/wrong-type
        // value: a pre-existing profile must still fail before activity launch.
        Object path = context.getSharedPreferences("CapWebViewSettings", Context.MODE_PRIVATE)
            .getAll().get("serverBasePath");
        assertTrue("Use a clean emulator installation without a persisted WebView content override.",
            path == null || "".equals(path));
    }

    private String evaluate(String expression) throws Exception {
        CompletableFuture<String> result = new CompletableFuture<>();
        scenario.onActivity(activity -> {
            assertNotNull("Capacitor bridge failed to initialize", activity.getBridge());
            activity.getBridge().getWebView().evaluateJavascript(expression, result::complete);
        });
        return result.get(10, TimeUnit.SECONDS);
    }

    private void awaitReadyUi() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 15000;
        do {
            if ("true".equals(evaluate("Boolean(document.getElementById('watch-submit') && !document.getElementById('watch-submit').disabled)"))) return;
            Thread.sleep(100);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("The bundled UI did not initialize. Check WebView >=105, native plugin initialization and packaged assets.");
    }

    private NativeWalletPlugin walletPlugin() {
        AtomicReference<NativeWalletPlugin> result = new AtomicReference<>();
        scenario.onActivity(activity -> {
            PluginHandle handle = activity.getBridge().getPlugin("NativeWallet");
            assertNotNull(handle);
            assertEquals(NativeWalletPlugin.class, handle.getInstance().getClass());
            result.set((NativeWalletPlugin) handle.getInstance());
        });
        return result.get();
    }

    private static Object field(Object instance, String name) throws Exception {
        Field field = instance.getClass().getDeclaredField(name);
        field.setAccessible(true);
        synchronized (instance) { return field.get(instance); }
    }

    private static Set<String> methods(PluginHandle handle) {
        Set<String> names = new HashSet<>();
        for (PluginMethodHandle method : handle.getMethods()) names.add(method.getName());
        return names;
    }

    @Test public void activityLoadsBundledEnglishNativeWalletSetup() throws Exception {
        launch(); awaitReadyUi();
        JSONObject ui = new JSONObject(evaluate("({language:document.documentElement.lang,title:document.title," +
            "origin:location.origin,platform:window.Capacitor.getPlatform(),setupVisible:!document.getElementById('setup-panel').hidden," +
            "walletHidden:document.getElementById('wallet-panel').hidden,previewHidden:document.getElementById('preview-notice').hidden," +
            "claims:document.getElementById('claims-status').textContent,error:document.getElementById('global-error').textContent})"));
        assertEquals("en", ui.getString("language"));
        assertEquals("ConnectWallet Alpha", ui.getString("title"));
        assertEquals("https://localhost", ui.getString("origin"));
        assertEquals("android", ui.getString("platform"));
        assertTrue(ui.getBoolean("setupVisible")); assertTrue(ui.getBoolean("walletHidden"));
        assertTrue(ui.getBoolean("previewHidden"));
        assertTrue(ui.getString("claims").toLowerCase(Locale.ROOT).contains("stopped")); assertEquals("", ui.getString("error"));
        assertFalse(context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).contains(PROFILE_KEY));
    }

    @Test public void bridgeUsesRestrictedOverridesAndRemovesOriginalJavascriptInterfaces() throws Exception {
        launch(); awaitReadyUi();
        scenario.onActivity(activity -> {
            Bridge bridge = activity.getBridge();
            assertEquals(MainActivity.DisabledHttp.class, bridge.getPlugin("CapacitorHttp").getInstance().getClass());
            assertEquals(MainActivity.BundledWebView.class, bridge.getPlugin("WebView").getInstance().getClass());
            assertEquals(MainActivity.DisabledCookies.class, bridge.getPlugin("CapacitorCookies").getInstance().getClass());
            Set<String> unsafe = new HashSet<>(Arrays.asList("request", "get", "post", "put", "patch", "delete", "getCookies", "setCookie",
                "setServerBasePath", "setServerAssetPath", "persistServerBasePath"));
            for (String id : new String[] { "CapacitorHttp", "WebView", "CapacitorCookies" }) {
                Set<String> exposed = methods(bridge.getPlugin(id)); exposed.retainAll(unsafe);
                assertTrue(id + " still exposes generic native capabilities", exposed.isEmpty());
            }
            assertNull(bridge.getPlugin("ReadOnlyRpc"));
            Set<String> wallet = methods(bridge.getPlugin("NativeWallet"));
            // PluginHandle includes five inherited framework methods as well
            // as our twelve application methods. Keep the full exact allowlist;
            // permission methods cannot request undeclared plugin permissions.
            assertEquals(0, bridge.getPlugin("NativeWallet").getPluginAnnotation().permissions().length);
            assertEquals(new HashSet<>(Arrays.asList("getState", "lock", "create", "importRecovery", "unlock", "reviewPayment",
                "queryPublic", "claimsState", "claimsPolicy", "claimsStart", "claimsStop", "claimsCheckSubmission",
                "addListener", "removeListener", "removeAllListeners", "checkPermissions", "requestPermissions")), wallet);
            for (String id : new String[] { "App", "Network", "Preferences", "SystemBars" }) assertNotNull(bridge.getPlugin(id));
        });
        assertEquals("\"undefined\"", evaluate("typeof window.CapacitorHttpAndroidInterface"));
        assertEquals("\"undefined\"", evaluate("typeof window.CapacitorCookiesAndroidInterface"));
    }

    @Test public void nativeNavigationGuardAllowsOnlyBundledOrigin() {
        launch();
        AtomicReference<MainActivity.BundledWebView> holder = new AtomicReference<>();
        scenario.onActivity(activity -> holder.set((MainActivity.BundledWebView) activity.getBridge().getPlugin("WebView").getInstance()));
        MainActivity.BundledWebView plugin = holder.get();
        for (String url : new String[] { "https://localhost/", "https://localhost/index.html#receive", "https://localhost/assets/bundled.js" }) {
            assertEquals(Boolean.FALSE, plugin.shouldOverrideLoad(Uri.parse(url)));
        }
        assertEquals(Boolean.TRUE, plugin.shouldOverrideLoad(null));
        for (String url : new String[] { "http://localhost/", "https://example.com/", "https://localhost.evil/", "https://user@localhost/",
            "https://localhost:443/", "https://localhost%2Fevil/", "javascript:alert(1)", "data:text/html,test", "blob:https://localhost/test",
            "intent://anything/#Intent;scheme=example;end", "file:///data/local/tmp/test", "connectcoin:cc1p",
            "https://localhost/_capacitor_file_/data/private", "https://localhost/_capacitor_content_/private",
            "https://localhost/assets/../private", "https://localhost/assets/%2e%2e/private", "https://localhost/assets/%252e%252e/private" }) {
            assertEquals("Unexpected navigation allowed: " + url, Boolean.TRUE, plugin.shouldOverrideLoad(Uri.parse(url)));
        }
    }

    @Test public void realActivityPauseLocksWalletAndPausesUnrequestedRuntime() throws Exception {
        launch(); awaitReadyUi();
        NativeWalletPlugin plugin = walletPlugin();
        MobileRuntime runtime = (MobileRuntime) field(plugin, "runtime");
        assertEquals(Boolean.TRUE, field(plugin, "active"));
        assertEquals(Boolean.TRUE, field(runtime, "foreground"));
        long beforePause = (Long) field(plugin, "generation");
        scenario.moveToState(Lifecycle.State.CREATED);
        assertEquals(Boolean.FALSE, field(plugin, "active"));
        assertEquals(Boolean.FALSE, field(runtime, "foreground"));
        assertTrue((Long) field(plugin, "generation") > beforePause);
        assertNull(field(plugin, "session"));
        assertEquals(Boolean.FALSE, field(runtime.rpc, "active"));
        assertFalse(runtime.snapshot().getBoolean("enabled"));
        assertEquals("stopped", runtime.snapshot().getString("policyStatus"));
        // Inactive call fails before DNS. No real RPC endpoint is contacted.
        assertTrue(runtime.rpc.call("getchaintip", new JSONObject()).isCompletedExceptionally());
        scenario.moveToState(Lifecycle.State.RESUMED);
        assertEquals(Boolean.TRUE, field(plugin, "active"));
        scenario.close(); scenario = null;
        assertEquals(Boolean.TRUE, field(plugin, "destroyed"));
        assertNull(field(plugin, "session"));
        assertEquals(Boolean.FALSE, field(runtime, "foreground"));
    }

    @Test public void mergedPackageHasEnglishIdentityAndNoNotificationPromptPermission() throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(APP_ID,
            PackageManager.GET_PERMISSIONS | PackageManager.GET_PROVIDERS | PackageManager.GET_ACTIVITIES);
        assertEquals("1.0.0-alpha.1", info.versionName);
        Set<String> requested = new HashSet<>(Arrays.asList(info.requestedPermissions));
        // AndroidX may merge its own signature permission for non-exported dynamic receivers.
        requested.remove(APP_ID + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION");
        assertEquals(new HashSet<>(Arrays.asList(Manifest.permission.INTERNET, Manifest.permission.ACCESS_NETWORK_STATE,
            Manifest.permission.FOREGROUND_SERVICE, "android.permission.FOREGROUND_SERVICE_SPECIAL_USE")), requested);
        assertFalse(requested.contains("android.permission.POST_NOTIFICATIONS"));
        assertEquals(0, info.applicationInfo.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
        assertEquals(0, info.applicationInfo.flags & ApplicationInfo.FLAG_USES_CLEARTEXT_TRAFFIC);
        assertNotEquals(0, info.applicationInfo.icon);
        if (info.providers != null) for (android.content.pm.ProviderInfo provider : info.providers) assertFalse(provider.exported);
        boolean launcherFound = false;
        for (android.content.pm.ActivityInfo activity : info.activities) if (activity.name.equals(MainActivity.class.getName())) {
            launcherFound = true; assertTrue(activity.exported);
        }
        assertTrue(launcherFound);
        Configuration portuguese = new Configuration(context.getResources().getConfiguration());
        portuguese.setLocale(Locale.forLanguageTag("pt-BR"));
        Context localized = context.createConfigurationContext(portuguese);
        assertEquals("ConnectWallet Alpha", localized.getString(R.string.app_name));
        assertEquals("ConnectWallet Alpha", localized.getString(R.string.title_activity_main));
    }

    @Test public void privateFileAndContentProxiesAreBlockedByActualWebViewFetch() throws Exception {
        launch(); awaitReadyUi();
        scenario.onActivity(activity -> {
            assertNotEquals(0, activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE);
            assertFalse(activity.getBridge().getWebView().getSettings().getAllowFileAccess());
            assertFalse(activity.getBridge().getWebView().getSettings().getAllowContentAccess());
            assertFalse(activity.getBridge().getConfig().isResolveServiceWorkerRequests());
        });
        File fixture = new File(context.getNoBackupFilesDir(), "instrumentation-public-proxy-probe.txt");
        assertFalse("Do not overwrite any existing file", fixture.exists());
        try {
            try (FileOutputStream out = new FileOutputStream(fixture)) { out.write("PUBLIC_TEST_SENTINEL".getBytes(StandardCharsets.US_ASCII)); }
            String fileUrl = "https://localhost/_capacitor_file_" + fixture.getAbsolutePath();
            evaluate("window.__proxyProbe = null; Promise.all([" + JSONObject.quote(fileUrl) +
                ", 'https://localhost/_capacitor_content_/not-a-real-provider'].map(async u => { try { const r=await fetch(u); return {status:r.status,body:await r.text()}; } catch(e) { return {status:0,body:''}; } })).then(v => window.__proxyProbe=v); null");
            String value = "null"; long deadline = SystemClock.elapsedRealtime() + 5000;
            do { value = evaluate("window.__proxyProbe"); if (!"null".equals(value)) break; Thread.sleep(50); } while(SystemClock.elapsedRealtime() < deadline);
            org.json.JSONArray result = new org.json.JSONArray(value);
            assertEquals(2, result.length());
            for (int i=0;i<result.length();i++) {
                assertEquals(403, result.getJSONObject(i).getInt("status"));
                assertEquals("", result.getJSONObject(i).getString("body"));
            }
        } finally { assertTrue("Delete only the public fixture created by this test", fixture.delete()); }
    }

    @Test public void packagedBackupRulesExcludeEveryPublicDataDomainFromCloudAndTransfer() throws Exception {
        Set<String> expected = new HashSet<>(Arrays.asList("root", "file", "database", "sharedpref", "external",
            "device_root", "device_file", "device_database", "device_sharedpref"));
        Set<String> cloud = new HashSet<>(), transfer = new HashSet<>();
        Set<String> current = null;
        try (XmlResourceParser xml = context.getResources().getXml(R.xml.data_extraction_rules)) {
            for (int event = xml.getEventType(); event != XmlPullParser.END_DOCUMENT; event = xml.next()) {
                if (event == XmlPullParser.START_TAG) {
                    if (xml.getName().equals("cloud-backup")) current = cloud;
                    else if (xml.getName().equals("device-transfer")) current = transfer;
                    else if (xml.getName().equals("exclude")) {
                        assertNotNull(current); assertEquals(".", xml.getAttributeValue(null, "path"));
                        current.add(xml.getAttributeValue(null, "domain"));
                    }
                } else if (event == XmlPullParser.END_TAG && (xml.getName().equals("cloud-backup") || xml.getName().equals("device-transfer"))) current = null;
            }
        }
        assertEquals(expected, cloud); assertEquals(expected, transfer);
    }
}
