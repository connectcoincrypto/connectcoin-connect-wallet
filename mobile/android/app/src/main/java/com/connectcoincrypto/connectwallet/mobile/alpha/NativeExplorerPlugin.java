package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/** Explicit public transaction lookup in the system browser, outside the wallet WebView. */
@CapacitorPlugin(name = "NativeExplorer")
public final class NativeExplorerPlugin extends Plugin {
    private final Object lifecycle = new Object();
    private boolean active;
    private boolean destroyed;
    private boolean opening;
    private PluginCall pending;

    static Intent transactionIntent(JSONObject options) {
        return new Intent(Intent.ACTION_VIEW, Uri.parse(NativeExplorer.transactionUrl(options)))
            .addCategory(Intent.CATEGORY_BROWSABLE);
    }

    @PluginMethod public void openTransaction(PluginCall call) {
        final Intent intent;
        try { intent = transactionIntent(call.getData()); }
        catch (IllegalArgumentException error) {
            call.reject("Choose a valid transaction to open in the explorer.", "INVALID_ARGUMENT"); return;
        }
        final Activity activity = getActivity();
        synchronized (lifecycle) {
            if (destroyed || !active || activity == null) { inactive(call); return; }
            if (opening || pending != null) {
                call.reject("The explorer is already opening.", "EXPLORER_BUSY"); return;
            }
            pending = call;
        }
        activity.runOnUiThread(() -> {
            synchronized (lifecycle) {
                if (pending != call) return;
                pending = null;
                if (destroyed || !active || getActivity() != activity || activity.isFinishing()
                        || activity.isDestroyed() || !activity.hasWindowFocus()) { inactive(call); return; }
                try {
                    opening = true;
                    activity.startActivity(intent);
                    call.resolve(new JSObject());
                } catch (RuntimeException error) {
                    opening = false;
                    call.reject("No browser is available to open the explorer.", "EXPLORER_UNAVAILABLE");
                }
            }
        });
    }

    private static void inactive(PluginCall call) {
        call.reject("Open the wallet to view this transaction in the explorer.", "INACTIVE");
    }

    private void cancelPending() {
        if (pending == null) return;
        PluginCall call = pending; pending = null;
        inactive(call);
    }

    @Override protected void handleOnResume() {
        synchronized (lifecycle) { if (!destroyed) { active = true; opening = false; } }
    }
    @Override protected void handleOnPause() {
        synchronized (lifecycle) { active = false; cancelPending(); }
    }
    @Override protected void handleOnDestroy() {
        synchronized (lifecycle) { destroyed = true; active = false; cancelPending(); }
    }
}
