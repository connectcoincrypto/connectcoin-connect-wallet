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
    volatile MobileRpcClient rpc;
    volatile MobileClaimsEngine claims;
    private final Context context;
    private final ConnectivityManager connectivity;
    private final android.content.SharedPreferences receipts;
    private MobileWalletSettings.Settings settings;
    private boolean foreground, service, allowMobile, allowBackground, requested;
    private long receiptLifecycle;
    private String policyStatus = "stopped";
    private final java.util.concurrent.CopyOnWriteArrayList<Runnable> recoveryNetworkListeners = new java.util.concurrent.CopyOnWriteArrayList<>();
    private MobileRuntime(Context context) {
        this.context = context;
        receipts = context.getSharedPreferences("claims-public-receipt", Context.MODE_PRIVATE);
        settings = MobileWalletSettings.read(context);
        rpc = new MobileRpcClient(settings.endpoint());
        claims = createClaims(rpc, null);
        connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        android.content.SharedPreferences preferences = context.getSharedPreferences("claims-public-policy", Context.MODE_PRIVATE);
        allowMobile = preferences.getBoolean("allowMobileData", false); allowBackground = preferences.getBoolean("allowBackground", false);
        connectivity.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { refresh(); }
            @Override public void onLost(Network network) { refresh(); }
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) { refresh(); }
        });
    }
    private MobileClaimsEngine createClaims(MobileRpcClient client, MobileClaimsEngine.ReceiptLookup pending) {
        MobileClaimsEngine engine = new MobileClaimsEngine(client);
        try {
            engine.setReceiptStore((txid, status) -> {
                if (!txid.matches("[0-9a-f]{64}") || !java.util.Arrays.asList("pending", "submitted", "rejected", "not-sent", "unknown").contains(status)) throw new IllegalArgumentException("Invalid public claim receipt.");
                if (!receipts.edit().putString("txid", txid).putString("status", status).commit()) throw new IllegalStateException("Could not save the public claim receipt. Submission stopped.");
            });
            restoreClaimReceipt(engine, receipts, pending);
            ClaimsLimits limits = ClaimsLimits.restore(context.getSharedPreferences("claims-public-policy", Context.MODE_PRIVATE).getAll());
            engine.configureLimits(limits.rate, limits.concurrency);
            return engine;
        } catch (RuntimeException | LinkageError error) { engine.close(); throw error; }
    }
    /** Shared startup/replacement restoration, independent of Android services. */
    static void restoreClaimReceipt(MobileClaimsEngine engine, android.content.SharedPreferences receipts, MobileClaimsEngine.ReceiptLookup pending) {
        // Endpoint replacement must inherit the guarded live owner, not an
        // in-memory preference status changed by an unsuccessful disk commit.
        // A true process startup has no live owner and uses the saved receipt.
        String previousStatus = receipts.getString("status", "");
        boolean indeterminate = "pending".equals(previousStatus) || "unknown".equals(previousStatus);
        String previousTxid = indeterminate ? receipts.getString("txid", "") : null;
        if (pending != null) {
            requireConsistentClaimReceipt(receipts, pending.txid);
            engine.restoreUnknownOutcome(pending.txid);
        } else if (indeterminate) engine.restoreUnknownOutcome(previousTxid);
    }
    private static void requireConsistentClaimReceipt(android.content.SharedPreferences receipts, String txid) {
        String status = receipts.getString("status", "");
        if (("pending".equals(status) || "unknown".equals(status)) && !txid.equals(receipts.getString("txid", ""))) {
            throw new IllegalStateException("CLAIMS_RECEIPT_STATE");
        }
    }
    synchronized MobileWalletSettings.Settings settings() { return settings; }
    // Listeners only enqueue work. No wallet/lifecycle locks may be acquired here.
    void addRecoveryNetworkListener(Runnable listener) { recoveryNetworkListeners.add(listener); }
    void removeRecoveryNetworkListener(Runnable listener) { recoveryNetworkListeners.remove(listener); }
    synchronized boolean canChangeEndpoint() {
        return !requested && claims.canChangeEndpoint() && rpc.canChangeEndpoint();
    }
    /** Caller has confirmed the exact endpoint and invalidated its wallet query generation. */
    synchronized boolean changeEndpoint(MobileWalletSettings.Settings next) {
        if (!foreground) throw new IllegalStateException("Open the app to change wallet settings.");
        if (next == null) throw new IllegalArgumentException("Invalid wallet settings.");
        if (settings.sameEndpoint(next)) {
            // Theme/timeout changes and unchanged endpoint saves never reset quotas.
            MobileWalletSettings.save(context, next); settings = next; return false;
        }
        MobileClaimsEngine previousClaims = claims;
        synchronized (previousClaims) {
            if (!canChangeEndpoint()) throw new IllegalStateException("Stop claims and wait for active transactions before changing RPC.");
            MobileRpcClient replacement = rpc.prepareReplacement(next.endpoint());
            MobileClaimsEngine replacementClaims = null;
            try {
                // Prepare every fallible dependency before committing preferences.
                // The old engine monitor also prevents a late receipt from racing restoration.
                replacementClaims = createClaims(replacement, previousClaims.pendingReceiptLookup());
                rpc.replaceWith(replacement, () -> MobileWalletSettings.save(context, next));
            } catch (RuntimeException | LinkageError error) {
                if (replacementClaims != null) replacementClaims.close();
                replacement.close(); throw error;
            }
            rpc = replacement; claims = replacementClaims; settings = next;
            previousClaims.close();
            // The replacement is stopped; policy flags and unknown public receipts
            // are retained. Only an explicit Start can resume claim work.
            return true;
        }
    }
    synchronized void foreground(boolean value) { if (foreground != value) receiptLifecycle++; foreground = value; refresh(); }
    synchronized boolean backgroundServiceRequested() { return requested && allowBackground; }
    synchronized void service(boolean value) { service = value; refresh(); }
    synchronized void policy(boolean mobile, boolean background) {
        allowMobile = mobile; allowBackground = background;
        try {
            context.getSharedPreferences("claims-public-policy", Context.MODE_PRIVATE).edit()
                .putBoolean("allowMobileData", mobile).putBoolean("allowBackground", background).apply();
            if (!background) context.stopService(new Intent(context, ClaimsService.class));
            // Starting a foreground service is only permitted while this app is visible.
            if (background && requested && foreground && !service) startService();
        } finally {
            // Service setup can be denied after the new permissions are saved.
            // Never leave claims running under the previous mobile/background
            // policy; keep the original service error visible to the caller.
            refresh();
        }
    }
    synchronized void limits(ClaimsLimits limits) {
        if (!foreground) throw new IllegalStateException("Open the app to change claims limits.");
        // Save both validated values atomically before reporting or applying them.
        // This does not start claims or change network/background permissions.
        android.content.SharedPreferences preferences = context.getSharedPreferences("claims-public-policy", Context.MODE_PRIVATE);
        ClaimsLimits previous = ClaimsLimits.restore(preferences.getAll());
        if (!preferences.edit()
            .putInt("connectionsPerSecondLimit", limits.rate).putInt("concurrency", limits.concurrency).commit()) {
            // A failed disk commit can already have changed the preference
            // cache. A replacement engine must not restore workload limits
            // that this operation reported as unsaved. Restore the previous
            // effective pair even if storage is still unavailable.
            preferences.edit().putInt("connectionsPerSecondLimit", previous.rate).putInt("concurrency", previous.concurrency).commit();
            throw new IllegalStateException("Could not save claims limits.");
        }
        claims.configureLimits(limits.rate, limits.concurrency);
    }
    synchronized void start(String address) {
        if (!foreground) throw new IllegalStateException("Open the app to start claims.");
        com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto.decodeAddress(address);
        if (requested) throw new IllegalStateException("Stop the current claims session before changing its reward address.");
        MobileClaimsEngine.ReceiptLookup pending = claims.pendingReceiptLookup();
        if (pending != null) requireConsistentClaimReceipt(receipts, pending.txid);
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
        final MobileRpcClient sourceRpc;
        final MobileClaimsEngine sourceClaims;
        final long lookupEpoch, lookupLifecycle;
        synchronized (this) {
            if (!foreground) throw new IllegalStateException("Open the app to check the previous submission.");
            sourceRpc = rpc; sourceClaims = claims;
            MobileClaimsEngine.ReceiptLookup lookup = sourceClaims.beginReceiptLookup();
            txid = lookup.txid; lookupEpoch = lookup.epoch; lookupLifecycle = receiptLifecycle;
            requireConsistentClaimReceipt(receipts, txid);
        }
        JSONObject params = new JSONObject();
        try { params.put("txid", txid); } catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
        return sourceRpc.call("gettransaction", params).thenApply(response -> {
            try {
                // The engine validates both receipt metadata and the observed
                // claim's raw txid/proof binding before committing recovery.
                synchronized (this) {
                    if (sourceRpc != rpc || sourceClaims != claims) throw new IllegalStateException("RPC changed. Check the previous submission again.");
                    if (!foreground || lookupLifecycle != receiptLifecycle) throw new IllegalStateException("CLAIMS_RECEIPT_STATE");
                    // A partially committed submitted status is not authority
                    // to clear the live guard; a different pending owner is
                    // likewise never safe to overwrite, even on a late reply.
                    requireConsistentClaimReceipt(receipts, txid);
                    sourceClaims.resolveConfirmedReceipt(txid, response, lookupEpoch);
                    stop(); // Leave both runtime and service stopped; the next Start is explicit.
                    return snapshot();
                }
            } catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
        });
    }
    synchronized void refresh() {
        Network network = connectivity.getActiveNetwork(); NetworkCapabilities caps = network == null ? null : connectivity.getNetworkCapabilities(network);
        boolean online = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        boolean unmetered = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) && !connectivity.isActiveNetworkMetered();
        boolean backgroundAllowed = allowBackground && service;
        policyStatus = !requested ? "stopped" : !online ? "offline" : !allowMobile && !unmetered ? "mobile-data-disabled" : !foreground && !backgroundAllowed ? "background-paused" : "allowed";
        rpc.setActive(online && (foreground || requested && backgroundAllowed && (allowMobile || unmetered)), !online);
        claims.setAllowed(requested && "allowed".equals(policyStatus));
        for (Runnable listener : recoveryNetworkListeners) listener.run();
    }
    synchronized JSONObject snapshot() {
        try { synchronized (claims) {
            // Preferences can reflect an unsuccessful disk commit in memory.
            // Keep the recovery action visible until the authoritative owner
            // actually commits resolution, not merely until the cache changes.
            MobileClaimsEngine.ReceiptLookup pending = claims.pendingReceiptLookup();
            return claims.snapshot().put("policyStatus", policyStatus).put("allowMobileData", allowMobile)
                .put("allowBackground", allowBackground).put("backgroundService", service).put("requested", requested)
                .put("receiptTxid", pending == null ? receipts.getString("txid", "") : pending.txid)
                .put("receiptStatus", pending == null ? receipts.getString("status", "") : "unknown");
        } }
        catch (org.json.JSONException error) { throw new IllegalStateException("Cannot read claims state."); }
    }
}
