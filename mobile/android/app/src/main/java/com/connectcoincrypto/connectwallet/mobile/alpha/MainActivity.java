package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.os.Bundle;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import java.io.ByteArrayInputStream;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

public class MainActivity extends BridgeActivity {
    private final NativePaymentInput.Mailbox paymentLinks = new NativePaymentInput.Mailbox();

    NativePaymentInput.Mailbox paymentLinks() { return paymentLinks; }

    @Override public void onUserInteraction() {
        super.onUserInteraction();
        Bridge current = getBridge();
        if (current == null) return;
        com.getcapacitor.PluginHandle handle = current.getPlugin("NativeWallet");
        if (handle != null && handle.getInstance() instanceof NativeWalletPlugin) {
            ((NativeWalletPlugin) handle.getInstance()).userInteraction();
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Bound and consume the launch URI before Capacitor copies Intent.data
        // into Bridge.intentUri. Only this Activity's one-shot public mailbox remains.
        NativePaymentInputPlugin.consumeIntent(getIntent(), paymentLinks);
        // Capacitor registers its core plugins first, then these custom classes.
        // Replace unused generic network/cookie/content-path capabilities before
        // it exports the bridge or loads bundled content. No node_modules patch.
        registerPlugin(DisabledHttp.class);
        registerPlugin(BundledWebView.class);
        registerPlugin(DisabledCookies.class);
        registerPlugin(NativeWalletPlugin.class);
        registerPlugin(NativePaymentInputPlugin.class);
        registerPlugin(NativeExplorerPlugin.class);
        super.onCreate(savedInstanceState);
    }

    private static void restrictWebView(Bridge bridge) {
        // No file/content proxy, even for a compromised bundled renderer. The
        // plugin calls this BEFORE the framework's first loadUrl. A guard added
        // only after super.onCreate leaves the first document racing the setup.
        bridge.getWebView().getSettings().setAllowFileAccess(false);
        bridge.getWebView().getSettings().setAllowContentAccess(false);
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return permittedAsset(request) ? super.shouldInterceptRequest(view, request) : denied();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !permittedAsset(request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return url == null || !permittedUrl(Uri.parse(url));
            }
        });
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) { return denied(); }
        });
    }

    static boolean permittedAsset(WebResourceRequest request) {
        if (request == null || !"GET".equals(request.getMethod())) return false;
        return permittedUrl(request.getUrl());
    }
    static boolean permittedUrl(Uri uri) {
        if (uri == null) return false;
        if (!"https".equals(uri.getScheme()) || !"localhost".equals(uri.getEncodedAuthority())) return false;
        String path = uri.getPath();
        return path != null && !path.contains("..") && !path.contains("\\") && !path.contains("%") &&
            (path.equals("/") || path.equals("/index.html") || path.equals("/favicon.ico") || path.equals("/capacitor.js") ||
             path.equals("/cordova.js") || path.equals("/cordova_plugins.js") || path.equals("/unsupported-webview.html") ||
             path.equals("/unsupported-webview.css") || path.startsWith("/assets/"));
    }
    private static WebResourceResponse denied() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    @CapacitorPlugin(name = "CapacitorHttp")
    public static final class DisabledHttp extends Plugin {
        @Override public void load() {
            // The original core instance was eagerly loaded before replacement.
            getBridge().getWebView().removeJavascriptInterface("CapacitorHttpAndroidInterface");
        }
    }

    @CapacitorPlugin(name = "WebView")
    public static final class BundledWebView extends Plugin {
        // Deliberately no setServerBasePath/setServerAssetPath/persist methods.
        @Override public void load() {
            if (getBridge().getConfig().isResolveServiceWorkerRequests()) {
                throw new IllegalStateException("Disable service-worker proxying before loading the native wallet.");
            }
            getContext().getSharedPreferences("CapWebViewSettings", android.content.Context.MODE_PRIVATE)
                .edit().remove("serverBasePath").apply();
            restrictWebView(getBridge());
        }
        // Also guards Bridge.launchIntent, before its external ACTION_VIEW fallback.
        @Override public Boolean shouldOverrideLoad(Uri url) { return !permittedUrl(url); }
    }

    @CapacitorPlugin(name = "CapacitorCookies")
    public static final class DisabledCookies extends Plugin {
        @Override public void load() {
            // enabled:false only disables the patch; the original JS interface
            // otherwise still exposes setCookie(domain, value).
            getBridge().getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        }
    }
}
