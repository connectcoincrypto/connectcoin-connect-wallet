package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import androidx.core.content.ContextCompat;
import org.json.JSONObject;

/** Process-only workload. Never restart claims on app launch, reboot or service death. */
final class MobileRuntime {
    private static MobileRuntime instance;
    static synchronized MobileRuntime get(Context context) {
        if (instance == null) instance = new MobileRuntime(context.getApplicationContext());
        return instance;
    }
    final MobileRpcClient rpc = new MobileRpcClient(new MobileRpcClient.TlsEndpoint("connectcoin4.com", 48191));
    final MobileClaimsEngine claims = new MobileClaimsEngine(rpc);
    private final Context context;
    private final ConnectivityManager connectivity;
    private final android.content.SharedPreferences receipts;
    private boolean foreground, service, allowMobile, allowBackground, requested;
    private String policyStatus = "stopped";
    private MobileRuntime(Context context) {
        this.context = context;
        receipts = context.getSharedPreferences("claims-public-receipt", Context.MODE_PRIVATE);
        claims.setReceiptStore((txid, status) -> {
            if (!txid.matches("[0-9a-f]{64}") || !java.util.Arrays.asList("pending", "submitted", "rejected", "unknown").contains(status)) throw new IllegalArgumentException("Invalid public claim receipt.");
            if (!receipts.edit().putString("txid", txid).putString("status", status).commit()) throw new IllegalStateException("Could not save the public claim receipt. Submission stopped.");
        });
        String previousStatus = receipts.getString("status", "");
        if ("pending".equals(previousStatus) || "unknown".equals(previousStatus)) claims.restoreUnknownOutcome(receipts.getString("txid", ""));
        connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        android.content.SharedPreferences preferences = context.getSharedPreferences("claims-public-policy", Context.MODE_PRIVATE);
        allowMobile = preferences.getBoolean("allowMobileData", false); allowBackground = preferences.getBoolean("allowBackground", false);
        connectivity.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { refresh(); }
            @Override public void onLost(Network network) { refresh(); }
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) { refresh(); }
        });
    }
    synchronized void foreground(boolean value) { foreground = value; refresh(); }
    synchronized boolean backgroundServiceRequested() { return requested && allowBackground; }
    synchronized void service(boolean value) { service = value; refresh(); }
    synchronized void policy(boolean mobile, boolean background) {
        allowMobile = mobile; allowBackground = background;
        context.getSharedPreferences("claims-public-policy", Context.MODE_PRIVATE).edit()
            .putBoolean("allowMobileData", mobile).putBoolean("allowBackground", background).apply();
        if (!background) context.stopService(new Intent(context, ClaimsService.class));
        // Starting a foreground service is only permitted while this app is visible.
        if (background && requested && foreground && !service) startService();
        refresh();
    }
    synchronized void start(String address) {
        if (!foreground) throw new IllegalStateException("Open the app to start claims.");
        com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto.decodeAddress(address);
        if (requested) throw new IllegalStateException("Stop the current claims session before changing its reward address.");
        requested = true;
        try { if (allowBackground) startService(); claims.start(address); refresh(); }
        catch (RuntimeException error) { requested = false; context.stopService(new Intent(context, ClaimsService.class)); refresh(); throw error; }
    }
    private void startService() {
        try { ContextCompat.startForegroundService(context, new Intent(context, ClaimsService.class)); }
        catch (RuntimeException error) { service = false; throw new IllegalStateException("Android did not allow the background service. Keep the app open or turn background use off."); }
    }
    synchronized void stop() {
        requested = false; claims.stop(); context.stopService(new Intent(context, ClaimsService.class)); refresh();
    }
    java.util.concurrent.CompletableFuture<JSONObject> checkSubmission() {
        final String txid;
        synchronized (this) {
            if (!foreground) throw new IllegalStateException("Open the app to check the previous submission.");
            txid = receipts.getString("txid", "");
            if (!txid.matches("[0-9a-f]{64}")) throw new IllegalStateException("No previous claim transaction to check.");
            if (!java.util.Arrays.asList("pending", "unknown").contains(receipts.getString("status", ""))) throw new IllegalStateException("No indeterminate submission to resolve.");
        }
        JSONObject params = new JSONObject();
        try { params.put("txid", txid); } catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
        return rpc.call("gettransaction", params).thenApply(response -> {
            try {
                MobileClaimsEngine.validateTip(response.getJSONObject("tip"));
                String status = response.getString("status");
                if (!status.equals("pending") && !status.equals("confirmed")) throw new IllegalStateException("The node has not confirmed receipt. Claims remain paused.");
                JSONObject tx = response.getJSONObject("transaction");
                if (!txid.equals(com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions.txid(
                    com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions.parse(tx.getString("hex"))))) throw new IllegalStateException("RPC transaction identity mismatch.");
                // The engine validates the captured ID against its blocked ID
                // and commits the matching receipt under the same lock.
                claims.resolveConfirmedOutcome(txid);
                stop(); // Leave both runtime and service stopped; the next Start is explicit.
                return snapshot();
            } catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
        });
    }
    synchronized void refresh() {
        Network network = connectivity.getActiveNetwork(); NetworkCapabilities caps = network == null ? null : connectivity.getNetworkCapabilities(network);
        boolean online = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        boolean unmetered = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) && !connectivity.isActiveNetworkMetered();
        boolean backgroundAllowed = allowBackground && service;
        policyStatus = !requested ? "stopped" : !online ? "offline" : !allowMobile && !unmetered ? "mobile-data-disabled" : !foreground && !backgroundAllowed ? "background-paused" : "allowed";
        rpc.setActive(online && (foreground || requested && backgroundAllowed && (allowMobile || unmetered)));
        claims.setAllowed(requested && "allowed".equals(policyStatus));
    }
    synchronized JSONObject snapshot() {
        try { return claims.snapshot().put("policyStatus", policyStatus).put("allowMobileData", allowMobile)
            .put("allowBackground", allowBackground).put("backgroundService", service).put("requested", requested)
            .put("receiptTxid", receipts.getString("txid", "")).put("receiptStatus", receipts.getString("status", "")); }
        catch (org.json.JSONException error) { throw new IllegalStateException("Cannot read claims state."); }
    }
}
