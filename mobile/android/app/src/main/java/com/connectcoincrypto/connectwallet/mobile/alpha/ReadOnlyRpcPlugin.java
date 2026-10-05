package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import org.json.JSONObject;

/** Public data only. No configurable endpoint, filesystem, signing or broadcast bridge. */
@CapacitorPlugin(name = "ReadOnlyRpc")
public final class ReadOnlyRpcPlugin extends Plugin {
    private final RpcTransport transport = new RpcTransport();

    @PluginMethod
    public void query(PluginCall call) {
        JSONObject input = call.getData();
        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!key.equals("method") && !key.equals("params")) {
                call.reject("Unexpected RPC options.", "RPC_INVALID");
                return;
            }
        }
        Object method = input.opt("method"), params = input.opt("params");
        if (!(method instanceof String) || !(params instanceof JSONObject)) {
            call.reject("Invalid RPC request.", "RPC_INVALID");
            return;
        }
        transport.query((String) method, (JSONObject) params, (result, error) -> {
            if (error != null) call.reject(error.getMessage(), error.code);
            else call.resolve(new JSObject().put("result", result));
        });
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        if (call.getData().length() != 0) {
            call.reject("Unexpected cancellation options.", "RPC_INVALID");
            return;
        }
        transport.cancelAll();
        call.resolve(new JSObject());
    }

    @Override protected void handleOnResume() { transport.setForeground(true); }
    @Override protected void handleOnPause() { transport.setForeground(false); }
    @Override protected void handleOnStop() { transport.setForeground(false); }
    @Override protected void handleOnDestroy() { transport.close(); }

    // Do not let Capacitor's default ACTION_VIEW fallback launch arbitrary apps/sites.
    @Override public Boolean shouldOverrideLoad(Uri url) {
        return url == null || !"https".equals(url.getScheme()) || !"localhost".equals(url.getEncodedAuthority());
    }
}
