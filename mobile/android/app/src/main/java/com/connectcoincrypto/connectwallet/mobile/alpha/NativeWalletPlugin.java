package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.app.AlertDialog;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.text.InputType;
import android.util.AtomicFile;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.*;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/** No seed/password/secret signing interface is exported to the renderer.
 * Secrets are entered in native dialogs. A renderer may request a payment, but
 * only a native, immutable review and a fresh user confirmation authorize it.
 */
@CapacitorPlugin(name = "NativeWallet")
public final class NativeWalletPlugin extends Plugin {
    private static final String GENESIS = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e";
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(1), task -> new Thread(task, "connectwallet-vault"));
    // Some older Android providers cannot interrupt a blocked pipe read. Keep
    // that work off the signing/KDF worker, with one process-wide slot and no
    // queue so Activity recreation cannot accumulate stuck provider threads.
    private static final ThreadPoolExecutor BACKUP_IO = new ThreadPoolExecutor(0, 1, 30, TimeUnit.SECONDS,
        new java.util.concurrent.SynchronousQueue<>(), task -> {
            Thread thread = new Thread(task, "connectwallet-backup"); thread.setDaemon(true); return thread;
        });
    private final AtomicBoolean busy = new AtomicBoolean();
    private final Object lifecycle = new Object();
    // Activity recreation can leave an old worker finishing an AtomicFile
    // write. Serialize public payment commits across instances, only on workers.
    private static final Object PAYMENT_STORAGE = new Object();
    private static final AtomicBoolean BATCH_IN_FLIGHT = new AtomicBoolean();
    private static final String BATCH_RECEIPT_FILE = "payment-batch-public-v1.json";
    private static final ThreadPoolExecutor BATCH_RECEIPT_IO = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(4), task -> { Thread thread = new Thread(task, "connectwallet-payment-receipt"); thread.setDaemon(true); return thread; });
    private volatile boolean active, destroyed;
    private volatile long generation;
    private VaultSession session;
    private JSONObject account;
    private NativeHdWallet hdWallet;
    private JSONObject publicHd;
    private final AtomicBoolean recoveryRunning = new AtomicBoolean();
    private final java.util.LinkedHashSet<String> pendingHdUsed = new java.util.LinkedHashSet<>();
    private boolean hdObservationQueued;
    private final Runnable hdObservationRetry = this::queueHdObservations;
    private final ThreadPoolExecutor recoveryWorker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(1), task -> new Thread(task, "connectwallet-hd-recovery"));
    private AtomicFile file;
    private AlertDialog dialog;
    private PluginCall dialogCall;
    // Unsaved create/import UI only, guarded by lifecycle. Ordinary app
    // switching keeps this draft in Activity memory, never in saved state/disk.
    private boolean setupDraft;
    // Replacement authorization lives only in this Activity. The encrypted
    // source stays untouched until a user-selected external backup is verified.
    private boolean replacingWallet, backupPickerPending, backupImporting, replacementBackupVerified;
    private boolean fileImportMode, importPickerPending, exportOnly;
    // A verified install is definitive even if Android pauses before its
    // completion callback. Never report that committed replacement as cancelled.
    private boolean walletCommitted;
    private byte[] replacementSource;
    private byte[] importedEnvelope;
    private Uri backupDestination;
    private Uri importSource;
    private CancellationSignal backupCancellation;
    private ParcelFileDescriptor backupDescriptor;
    private volatile boolean broadcasting;
    private volatile JSONObject lastPayment;
    private MobileRuntime runtime;
    private MobileWalletSettings.Settings settings;
    private final NativeInactivityPolicy inactivity = new NativeInactivityPolicy();
    private final Runnable inactivityCheck = this::checkInactivity;
    private boolean savingSettings, settingsEndpointChanged, settingsCommitted;
    // Passwords/recovery text are native-only, revocable on pause/cancel, never bridge data.
    private char[][] managementSecrets;
    private boolean recoveryViewed;
    private Runnable recoveryHide;
    private final MobilePaymentFunding paymentFunding = new MobilePaymentFunding();
    // Public-account notifications use their own socket and lifecycle. Keeping
    // this separate from the signing generation allows a locked wallet to
    // continue receiving public balance changes without retaining secrets.
    private MobileWalletSubscriptions subscriptions;
    private long subscriptionSource = 1;
    private ConnectivityManager walletConnectivity;
    private ConnectivityManager.NetworkCallback walletNetworkCallback;
    private final Handler subscriptionHandler = new Handler(Looper.getMainLooper());
    private final AtomicBoolean subscriptionRefreshQueued = new AtomicBoolean();
    private boolean watchRequested, watchActive, walletEventQueued;
    private long watchGeneration;
    private String watchAddress;
    private MobileWalletSubscriptions.Event walletEvent;
    private Network watchNetwork;
    private long walletEventGeneration;
    private final Runnable subscriptionRefresh = () -> { subscriptionRefreshQueued.set(false); refreshSubscriptions(); };
    private final Runnable walletEventDelivery = this::deliverWalletEvent;
    private MobileRsaProbe.Attempt pendingRsaProbe;
    private final MobileRsaProbe rsaProber = new MobileRsaProbe(new MobileRsaProbe.Backend() {
        public long create() { return NativeClaims.createCancellationHandle(); }
        public String probe(String domain, long validationTime, int timeoutMs, long handle) { return NativeClaims.probeRsa(domain, validationTime, timeoutMs, handle); }
        public void cancel(long handle) { NativeClaims.cancel(handle); }
        public void destroy(long handle) { NativeClaims.destroyHandle(handle); }
    });

    @Override public void load() {
        file = new AtomicFile(new File(getContext().getNoBackupFilesDir(), "mobile-wallet-v1.json"));
        runtime = MobileRuntime.get(getContext());
        settings = runtime.settings();
        inactivity.configure(settings.autoLockMinutes, android.os.SystemClock.elapsedRealtime());
        final long source = subscriptionSource;
        subscriptions = new MobileWalletSubscriptions(event -> walletChanged(event, source), settings.endpoint());
        walletConnectivity = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        walletNetworkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { scheduleSubscriptionRefresh(); }
            @Override public void onLost(Network network) { scheduleSubscriptionRefresh(); }
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) { scheduleSubscriptionRefresh(); }
        };
        walletConnectivity.registerDefaultNetworkCallback(walletNetworkCallback);
        try {
            AtomicFile receipt = new AtomicFile(new File(getContext().getNoBackupFilesDir(), "last-payment-public.json"));
            if (stored(receipt) && receipt.getBaseFile().length() <= 2_000_000) {
                JSONObject saved = new JSONObject(new String(receipt.readFully(), StandardCharsets.UTF_8));
                String txid = saved.optString("txid", "");
                if (txid.matches("[0-9a-f]{64}")) lastPayment = new JSONObject().put("txid", txid)
                    .put("status", "not-sent".equals(saved.optString("broadcast_status", "")) ? "not-sent" : "check-required");
            }
        } catch (Exception ignored) { /* Public receipt corruption must not expose its raw bytes to JavaScript. */ }
    }
    private boolean empty(PluginCall call) {
        if (call.getData().length() != 0) { call.reject("Unexpected options.", "INVALID"); return false; }
        return true;
    }
    private JSObject state() {
        synchronized (lifecycle) {
            return new JSObject().put("exists", stored(file)).put("locked", session == null || session.isLocked())
                .put("account", account == null ? JSONObject.NULL : account).put("accountScope", "hd-wallet")
                .put("walletId", walletId() == null ? JSONObject.NULL : walletId()).put("accounts", ownedAccounts())
                .put("hd", publicHd == null ? JSONObject.NULL : publicHd.opt("hd"))
                .put("watch", watchState())
                .put("lastPayment", lastPayment == null ? JSONObject.NULL : lastPayment)
                .put("rpcTransport", "tcp").put("rpcEndpoint", settings.rpcHost + ":" + settings.rpcPort);
        }
    }
    private String walletId() { return publicHd == null ? null : publicHd.optString("walletId", null); }
    private JSONArray ownedAccounts() { return publicHd == null ? new JSONArray() : publicHd.optJSONArray("accounts"); }
    private JSObject watchState() {
        String own = walletId();
        return new JSObject().put("connected", subscriptions != null && own != null && watchActive && subscriptions.isConnected(own))
            .put("coverageLimited", subscriptions != null && own != null && subscriptions.isCoverageLimited(own))
            .put("watched", subscriptions == null || own == null ? 0 : subscriptions.watchedAddressCount(own))
            .put("total", subscriptions == null || own == null ? 0 : subscriptions.requestedAddressCount(own));
    }
    private void publishHd(NativeHdWallet owner, long expected) throws Exception {
        JSONObject snapshot = owner.snapshot();
        synchronized (lifecycle) {
            requireLive(expected);
            if (hdWallet != owner) throw new IllegalStateException("Wallet changed during address discovery.");
            publicHd = snapshot; account = snapshot.getJSONObject("account");
        }
        refreshSubscriptions();
    }
    private NativeHdWallet createHd(VaultSession signing, WalletVault.UpdateSession envelope) throws Exception {
        return new NativeHdWallet(signing, envelope, (next, check) -> {
            check.check(); byte[] encoded = WalletVault.serialize(next).getBytes(StandardCharsets.UTF_8);
            synchronized (PAYMENT_STORAGE) {
                // Serialize the short atomic commit with replacement and lock.
                // All KDF/derivation/network work remains outside this monitor.
                synchronized (lifecycle) {
                    check.check(); FileOutputStream stream = null;
                    try {
                        stream = file.startWrite(); stream.write(encoded); stream.getFD().sync(); check.check();
                        file.finishWrite(stream); stream = null;
                        NativeWalletBackup.verify(encoded, readWalletSnapshot());
                    } catch (Exception error) { if (stream != null) file.failWrite(stream); throw error; }
                }
            }
        });
    }
    private void startRecovery(PluginCall call) {
        final NativeHdWallet owner; final long expected;
        synchronized (lifecycle) {
            owner = hdWallet; expected = generation;
            if (!active || destroyed || owner == null) { if (call != null) finish(call, new IllegalStateException("Unlock your wallet to discover addresses.")); return; }
            if (!recoveryRunning.compareAndSet(false, true)) { if (call != null) finish(call, new IllegalStateException("Address discovery is already running.")); return; }
        }
        try { recoveryWorker.execute(() -> {
            Exception failure = null;
            try {
                NativeHdWallet.Check check = () -> {
                    synchronized (lifecycle) { requireLive(expected); if (hdWallet != owner || session == null) throw new IllegalStateException("Address discovery interrupted. Unlock to resume."); }
                };
                if (call != null) owner.requestRecovery(check);
                owner.recover((method, params) -> runtime.rpc.call(method, params), check, snapshot -> {
                    try { publishHd(owner, expected); } catch (Exception interrupted) { /* The next check revokes this generation. */ }
                });
                publishHd(owner, expected);
            } catch (Exception error) {
                failure = error;
                try { publishHd(owner, expected); } catch (Exception interrupted) { /* Never replace the new wallet's state. */ }
            } finally {
                recoveryRunning.set(false);
                if (call != null) finish(call, failure);
                boolean restart;
                synchronized (lifecycle) { restart = active && !destroyed && hdWallet != null && hdWallet != owner
                    && publicHd != null && !publicHd.optJSONObject("hd").optBoolean("complete"); }
                if (restart) startRecovery(null);
                else queueHdObservations();
            }
        }); } catch (java.util.concurrent.RejectedExecutionException error) {
            recoveryRunning.set(false); if (call != null) finish(call, new IllegalStateException("Address discovery is busy. Retry shortly."));
        }
    }
    @PluginMethod public void recoverAddresses(PluginCall call) { if (empty(call) && begin(call)) startRecovery(call); }
    @PluginMethod public void newAddress(PluginCall call) {
        if (!empty(call) || !begin(call)) return;
        execute(call, expected -> {
            final NativeHdWallet owner;
            synchronized (lifecycle) { requireLive(expected); owner = hdWallet; if (owner == null) throw new IllegalStateException("Unlock the wallet first."); }
            owner.newAddress(() -> { synchronized (lifecycle) { requireLive(expected); if (hdWallet != owner) throw new IllegalStateException("Wallet changed."); } });
            publishHd(owner, expected); finish(call, null);
        });
    }
    private void observeHdResponse(String method, JSONObject params, JSONObject response, long expected) {
        final java.util.List<String> used;
        try { used = NativeHdWallet.usedAddresses(method, params, response); }
        catch (Exception invalid) { return; } // Display validation independently rejects malformed public responses.
        synchronized (lifecycle) {
            if (!active || destroyed || expected != generation || publicHd == null) return;
            JSONObject metadata = publicHd.optJSONObject("hd");
            for (String address : used) {
                JSONObject derived = null;
                JSONArray accounts = ownedAccounts();
                for (int i = 0; i < accounts.length(); i++) {
                    JSONObject candidate = accounts.optJSONObject(i);
                    if (candidate != null && address.equals(candidate.opt("address"))) { derived = candidate; break; }
                }
                if (derived == null) continue;
                int maximum = metadata.optInt(derived.optInt("change") == 0 ? "lastUsedReceive" : "lastUsedChange", -1);
                if (derived.optInt("index") > maximum) pendingHdUsed.add(address);
            }
        }
        queueHdObservations();
    }
    private void queueHdObservations() {
        final NativeHdWallet owner; final long expected;
        synchronized (lifecycle) {
            if (!active || destroyed || hdWallet == null || pendingHdUsed.isEmpty() || hdObservationQueued
                    || publicHd == null || !publicHd.optJSONObject("hd").optBoolean("complete")) return;
            if (recoveryRunning.get() || busy.get()) {
                subscriptionHandler.removeCallbacks(hdObservationRetry); subscriptionHandler.postDelayed(hdObservationRetry, 500); return;
            }
            owner = hdWallet; expected = generation; hdObservationQueued = true;
        }
        try { worker.execute(() -> {
            try {
                for (;;) {
                    final String address;
                    synchronized (lifecycle) {
                        requireLive(expected); if (hdWallet != owner || recoveryRunning.get() || busy.get()) return;
                        if (pendingHdUsed.isEmpty()) return;
                        address = pendingHdUsed.iterator().next();
                    }
                    try {
                        owner.observeUsed(address, () -> { synchronized (lifecycle) { requireLive(expected); if (hdWallet != owner) throw new IllegalStateException("Wallet changed."); } });
                        publishHd(owner, expected);
                        synchronized (lifecycle) { if (generation == expected && hdWallet == owner) pendingHdUsed.remove(address); }
                    } catch (Exception failed) {
                        try { publishHd(owner, expected); } catch (Exception interrupted) { /* Keep the newer wallet's state. */ }
                        synchronized (lifecycle) {
                            if (active && !destroyed && generation == expected && hdWallet == owner) pendingHdUsed.clear();
                        }
                        return;
                    }
                }
            } finally {
                synchronized (lifecycle) {
                    hdObservationQueued = false;
                    if (active && !destroyed && hdWallet != null && !pendingHdUsed.isEmpty()
                            && publicHd != null && publicHd.optJSONObject("hd").optBoolean("complete")) {
                        subscriptionHandler.removeCallbacks(hdObservationRetry); subscriptionHandler.postDelayed(hdObservationRetry, 1000);
                    }
                }
            }
        }); } catch (java.util.concurrent.RejectedExecutionException full) {
            synchronized (lifecycle) { hdObservationQueued = false; }
            subscriptionHandler.removeCallbacks(hdObservationRetry); subscriptionHandler.postDelayed(hdObservationRetry, 500);
        }
    }
    @PluginMethod public void getState(PluginCall call) { if (empty(call)) call.resolve(state()); }
    @PluginMethod public void getRecoverySnapshots(PluginCall call) {
        if (!empty(call)) return;
        synchronized (lifecycle) {
            if (hdWallet == null) {
                call.resolve(new JSObject().put("walletId", walletId() == null ? JSONObject.NULL : walletId()).put("groups", new JSONArray()));
            } else {
                JSONObject snapshots = hdWallet.recoverySnapshots();
                call.resolve(new JSObject().put("walletId", snapshots.opt("walletId")).put("groups", snapshots.opt("groups")));
            }
        }
    }
    /** Called only by the payment form's Paste button; never observe clipboard changes. */
    @PluginMethod public void readPaymentClipboard(PluginCall call) {
        if (!empty(call)) return;
        final Activity activity = getActivity();
        final long expected;
        synchronized (lifecycle) {
            if (!active || destroyed || activity == null) {
                call.reject("Open the wallet to paste a payment address or link.", "INACTIVE"); return;
            }
            expected = generation;
        }
        activity.runOnUiThread(() -> {
            synchronized (lifecycle) {
                // A delayed tap must not read after locking, backgrounding or Activity replacement.
                if (!active || destroyed || generation != expected || getActivity() != activity
                        || activity.isFinishing() || activity.isDestroyed() || !activity.hasWindowFocus()) {
                    call.reject("Open the wallet to paste a payment address or link.", "INACTIVE"); return;
                }
                try {
                    ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (clipboard == null) {
                        call.reject("Clipboard is unavailable. Paste directly into the recipient field.", "CLIPBOARD_UNAVAILABLE"); return;
                    }
                    ClipData clip = clipboard.getPrimaryClip();
                    // getText reads only supplied text; never coerce URI/Intent/HTML content.
                    CharSequence text = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).getText();
                    call.resolve(new JSObject().put("text", NativePaymentClipboard.boundedText(text)));
                } catch (IllegalArgumentException error) {
                    call.reject(NativePaymentClipboard.INVALID_MESSAGE, "CLIPBOARD_INVALID");
                } catch (RuntimeException error) {
                    // Android policy errors must never echo clipboard contents to the renderer/logs.
                    call.reject("Clipboard is unavailable. Paste directly into the recipient field.", "CLIPBOARD_UNAVAILABLE");
                }
            }
        });
    }
    @PluginMethod public void watchAccount(PluginCall call) {
        if (!empty(call)) return;
        synchronized (lifecycle) {
            if (destroyed) { call.reject("Wallet is closed.", "INACTIVE"); return; }
            watchRequested = true;
        }
        refreshSubscriptions();
        synchronized (lifecycle) {
            // No renderer-supplied address, endpoint or subscription options.
            String own = walletId();
            call.resolve(new JSObject().put("address", own == null ? JSONObject.NULL : own)
                .put("rpcEndpoint", settings.rpcHost + ":" + settings.rpcPort)
                .put("connected", watchActive && subscriptions.isConnected(own)).put("watch", watchState()));
        }
    }
    private void scheduleSubscriptionRefresh() {
        if (!destroyed && subscriptionRefreshQueued.compareAndSet(false, true)) subscriptionHandler.post(subscriptionRefresh);
    }
    private void refreshSubscriptions() {
        if (subscriptions == null || walletConnectivity == null) return;
        synchronized (lifecycle) {
            Network network = walletConnectivity.getActiveNetwork();
            NetworkCapabilities caps = network == null ? null : walletConnectivity.getNetworkCapabilities(network);
            boolean online = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
            String own = walletId();
            java.util.ArrayList<String> addresses = new java.util.ArrayList<>();
            if (account != null) addresses.add(account.optString("address"));
            JSONArray accounts = ownedAccounts();
            int currentChange = publicHd == null ? -1 : publicHd.optJSONObject("hd").optInt("changeIndex", -1);
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject derived = accounts.optJSONObject(i);
                if (derived.optInt("change") == 1 && derived.optInt("index") == currentChange) addresses.add(derived.optString("address"));
            }
            for (int i = 0; i < accounts.length(); i++) addresses.add(accounts.optJSONObject(i).optString("address"));
            boolean enabled = watchRequested && active && !destroyed && online && own != null;
            boolean networkChanged = enabled && watchActive && !java.util.Objects.equals(watchNetwork, network);
            if (enabled != watchActive || !java.util.Objects.equals(own, watchAddress) || networkChanged) {
                watchGeneration++;
                walletEventQueued = false; walletEvent = null;
                subscriptionHandler.removeCallbacks(walletEventDelivery);
            }
            // A Wi-Fi/mobile switch can remain "online" while the old socket
            // still points to the lost network. Recreate only in that case.
            if (networkChanged) subscriptions.configure(own, addresses, false);
            watchAddress = own; watchActive = enabled; watchNetwork = enabled ? network : null;
            subscriptions.configure(own, addresses, enabled);
        }
    }
    private void walletChanged(MobileWalletSubscriptions.Event event, long source) {
        synchronized (lifecycle) {
            if (source != subscriptionSource) return;
            if (!watchActive || !active || destroyed || !java.util.Objects.equals(walletId(), event.address)) return;
            for (String changed : event.changedAddresses) if (!NativeAccountPolicy.owns(ownedAccounts(), changed)) return;
            // A callback can have left the socket monitor just before a
            // lifecycle reconfiguration. Do not revive an unacknowledged
            // connection or report an old disconnect after a new connection.
            if (!subscriptions.isCurrent(event)) return;
            // Keep at most one pending public hint, never a queue of raw RPC
            // payloads. The renderer fetches and validates a fresh snapshot.
            walletEvent = MobileWalletSubscriptions.Event.merge(walletEvent, event);
            walletEventGeneration = watchGeneration;
            if (!walletEventQueued) { walletEventQueued = true; subscriptionHandler.post(walletEventDelivery); }
        }
    }
    private void deliverWalletEvent() {
        synchronized (lifecycle) {
            if (!walletEventQueued) return;
            walletEventQueued = false;
            MobileWalletSubscriptions.Event event = walletEvent; walletEvent = null;
            if (!watchActive || !active || destroyed || walletEventGeneration != watchGeneration || event == null || !java.util.Objects.equals(walletId(), event.address)) return;
            if (!subscriptions.isCurrent(event)) return;
            JSObject hint = new JSObject().put("address", event.address).put("reason", event.reason)
                .put("rpcEndpoint", settings.rpcHost + ":" + settings.rpcPort)
                .put("reorg", event.reorg).put("resync_required", event.resyncRequired)
                .put("changedAddresses", new JSONArray(event.changedAddresses)).put("watch", watchState());
            if (event.tip != null) hint.put("tip", event.tip);
            notifyListeners("walletChanged", hint, false);
        }
    }
    @PluginMethod public void lock(PluginCall call) { if (empty(call)) { lockNow(); interruptPending(); call.resolve(state()); } }
    @PluginMethod public void getSettings(PluginCall call) {
        if (empty(call)) synchronized (lifecycle) { call.resolve(settingsValue()); }
    }
    @PluginMethod public void saveSettings(PluginCall call) {
        final MobileWalletSettings.Settings next;
        try { next = MobileWalletSettings.parse(call.getData()); }
        catch (Exception invalid) { call.reject("Check the theme, inactivity time, RPC hostname and port.", "INVALID"); return; }
        synchronized (lifecycle) {
            if (!active || destroyed) { call.reject("Open the app to change settings.", "INACTIVE"); return; }
            if (busy.get()) { call.reject("Complete the current wallet operation first.", "BUSY"); return; }
            if (settings.sameEndpoint(next)) {
                try {
                    runtime.changeEndpoint(next);
                    if (settings.autoLockMinutes != next.autoLockMinutes) inactivity.configure(next.autoLockMinutes, android.os.SystemClock.elapsedRealtime());
                    settings = next;
                    scheduleInactivity();
                    call.resolve(settingsResult(false));
                } catch (Exception error) { call.reject("Could not save settings. Try again.", "SETTINGS_ERROR"); }
                return;
            }
            if (recoveryRunning.get() || !runtime.canChangeEndpoint()) {
                call.reject("Stop Automatic Claims and wait for wallet operations to finish before changing the RPC server.", "BUSY"); return;
            }
            if (!begin(call)) return;
            savingSettings = true; settingsEndpointChanged = settingsCommitted = false;
        }
        show(call, "Change RPC server?", panel("Connect to " + next.rpcHost + ":" + next.rpcPort +
            " over TCP. The server receives your wallet's public-address queries. Only ConnectCoin mainnet is supported.\n\n" +
            "Your wallet will lock and its public data will be checked again. No payment will be sent and claims will not start."), "Change server", () -> execute(call, expected -> {
                synchronized (lifecycle) {
                    requireLive(expected);
                    if (recoveryRunning.get() || !runtime.canChangeEndpoint()) throw new IllegalStateException("Wait for wallet operations to finish before changing the RPC server.");
                    long source = subscriptionSource + 1;
                    MobileWalletSubscriptions replacement = new MobileWalletSubscriptions(event -> walletChanged(event, source), next.endpoint());
                    try {
                        // Revoke every old-server read/signing generation before swapping transport.
                        lockNow();
                        runtime.changeEndpoint(next);
                    } catch (Exception error) { replacement.close(); throw error; }
                    subscriptions.close(); subscriptions = replacement; subscriptionSource = source;
                    settings = next; settingsEndpointChanged = true;
                    pendingHdUsed.clear();
                    walletEvent = null; walletEventQueued = false; watchGeneration++;
                    subscriptionHandler.removeCallbacks(walletEventDelivery);
                    inactivity.configure(settings.autoLockMinutes, android.os.SystemClock.elapsedRealtime());
                    settingsCommitted = true;
                    refreshSubscriptions();
                }
                finish(call, null);
            }));
    }
    private JSObject settingsResult(boolean changed) {
        synchronized (lifecycle) {
            return new JSObject().put("settings", settingsValue()).put("state", state()).put("endpointChanged", changed);
        }
    }
    private JSObject settingsValue() {
        return new JSObject().put("theme", settings.theme).put("autoLockMinutes", settings.autoLockMinutes)
            .put("rpcHost", settings.rpcHost).put("rpcPort", settings.rpcPort);
    }
    // Called only from native input dispatch, never from RPC updates or a renderer timer.
    void userInteraction() {
        synchronized (lifecycle) {
            if (!active || destroyed) return;
            if (!inactivity.activity(android.os.SystemClock.elapsedRealtime())) { checkInactivity(); return; }
            scheduleInactivity();
        }
    }
    private void scheduleInactivity() {
        subscriptionHandler.removeCallbacks(inactivityCheck);
        if (!active || destroyed) return;
        long delay = inactivity.remainingMs(android.os.SystemClock.elapsedRealtime());
        if (delay >= 0) subscriptionHandler.postDelayed(inactivityCheck, delay);
    }
    private void checkInactivity() {
        synchronized (lifecycle) {
            if (!active || destroyed || session == null || session.isLocked()) return;
            if (inactivity.remainingMs(android.os.SystemClock.elapsedRealtime()) != 0) { scheduleInactivity(); return; }
            lockNow(); interruptPending();
            notifyListeners("walletStateChanged", state(), false);
        }
    }
    private void armInactivity() {
        inactivity.unlocked(android.os.SystemClock.elapsedRealtime());
        scheduleInactivity();
    }
    private void lockNow() {
        synchronized (lifecycle) {
            generation++;
            inactivity.locked(); subscriptionHandler.removeCallbacks(inactivityCheck);
            // These are public, already validated used-address hints. Keep
            // them over an ordinary lock, so a consumed journal event can
            // extend the derivation gap after the next unlock.
            subscriptionHandler.removeCallbacks(hdObservationRetry);
            if (hdWallet != null) { hdWallet.close(); hdWallet = null; }
            if (publicHd != null && publicHd.optJSONObject("hd") != null) {
                JSONObject metadata = publicHd.optJSONObject("hd");
                try { metadata.put("recovering", false); } catch (org.json.JSONException ignored) { }
            }
            if (session != null) session.close(); session = null;
        }
    }
    private static boolean stored(AtomicFile target) {
        File base = target.getBaseFile();
        return base.exists() || new File(base.getPath() + ".bak").exists() || new File(base.getPath() + ".new").exists();
    }
    private void interruptPending() {
        synchronized (lifecycle) {
            setupDraft = false;
            clearManagementSecrets();
            cancelBackupIo();
            if (pendingRsaProbe != null) { pendingRsaProbe.cancel(); pendingRsaProbe = null; }
            AlertDialog previous = dialog; dialog = null;
            if (previous != null && getActivity() != null) getActivity().runOnUiThread(previous::dismiss);
            char[] secret = pendingPassword; pendingPassword = null; if (secret != null) Arrays.fill(secret, '\0');
            PluginCall current = dialogCall;
            // Once a write may have begun, its completion must retain the txid and unknown-outcome semantics.
            if (current != null && !broadcasting) finish(current, new IllegalStateException("Wallet operation interrupted."));
        }
    }
    private boolean begin(PluginCall call) {
        synchronized (lifecycle) {
            if (!active || destroyed) { call.reject("Open the wallet to continue.", "INACTIVE"); return false; }
            if (!busy.compareAndSet(false, true)) { call.reject("Complete the current wallet operation first.", "BUSY"); return false; }
            walletCommitted = false; dialogCall = call; return true;
        }
    }
    private void finish(PluginCall call, Exception error) {
        final boolean exported;
        final boolean settingsSaved, endpointChanged, viewed;
        synchronized (lifecycle) {
            if (dialogCall != call) return; // Cancellation/late completions must never finish a newer operation.
            if (walletCommitted || settingsCommitted) error = null;
            exported = error == null && exportOnly;
            viewed = error == null && recoveryViewed;
            recoveryViewed = false;
            if (recoveryHide != null) subscriptionHandler.removeCallbacks(recoveryHide);
            recoveryHide = null;
            clearManagementSecrets();
            settingsSaved = error == null && savingSettings; endpointChanged = settingsEndpointChanged;
            savingSettings = settingsEndpointChanged = settingsCommitted = false;
            busy.set(false); dialogCall = null; setupDraft = false;
            replacingWallet = backupPickerPending = backupImporting = replacementBackupVerified = false;
            replacementSource = null; backupDestination = null;
            fileImportMode = importPickerPending = exportOnly = false; importSource = null;
            walletCommitted = false;
            if (importedEnvelope != null) Arrays.fill(importedEnvelope, (byte)0); importedEnvelope = null;
            cancelBackupIo();
            char[] secret = pendingPassword; pendingPassword = null; if (secret != null) Arrays.fill(secret, '\0');
        }
        if (error == null) {
            if (settingsSaved) call.resolve(settingsResult(endpointChanged));
            else if (viewed) call.resolve(new JSObject().put("viewed", true));
            else call.resolve(exported ? new JSObject().put("exported", true) : state());
        }
        else call.reject(safeMessage(error), error instanceof StorageUncertain ? "STORAGE_UNCERTAIN" : NativeWalletErrors.code(error));
    }
    private static final class StorageUncertain extends IllegalStateException {
        private static final long serialVersionUID = 1L;
        StorageUncertain() { super("Wallet storage could not be verified. Keep your saved encrypted backup and its original password, and reopen the app before continuing."); }
        StorageUncertain(String message) { super(message); }
    }
    private static String safeMessage(Exception error) {
        if (error instanceof IllegalArgumentException || error instanceof IllegalStateException) return error.getMessage();
        return "The operation could not complete. Check connectivity and unlock again if needed.";
    }
    private void requireLive(long expected) {
        if (!active || destroyed || generation != expected) throw new IllegalStateException("Wallet operation interrupted. Open and unlock the wallet again.");
    }
    private void execute(PluginCall call, Work work) {
        executeOn(worker, call, work, "Wallet is busy.");
    }
    private void executeBackup(PluginCall call, Work work) {
        executeOn(BACKUP_IO, call, work, "A backup location is still busy. Restart the app before trying another backup. Your current wallet is unchanged.");
    }
    private void executeOn(ThreadPoolExecutor executor, PluginCall call, Work work, String unavailable) {
        long expected = generation;
        try { executor.execute(() -> {
            try { requireLive(expected); synchronized (lifecycle) { if (dialogCall != call) throw new IllegalStateException("Wallet operation cancelled."); } work.run(expected); }
            catch (Exception error) { finish(call, error); }
        }); } catch (java.util.concurrent.RejectedExecutionException error) { finish(call, new IllegalStateException(unavailable)); }
    }
    private interface Work { void run(long expected) throws Exception; }
    private Context dialogContext() {
        synchronized (lifecycle) {
            boolean systemDark = (getContext().getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
            boolean dark = "dark".equals(settings.theme) || "system".equals(settings.theme) && systemDark;
            return new android.view.ContextThemeWrapper(getActivity(), dark ? android.R.style.Theme_Material_Dialog_Alert : android.R.style.Theme_Material_Light_Dialog_Alert);
        }
    }
    private EditText field(String hint, boolean secret, boolean words) {
        EditText view = new EditText(dialogContext()); view.setHint(hint);
        view.setInputType(secret ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | (words ? InputType.TYPE_TEXT_FLAG_MULTI_LINE : 0));
        view.setSaveEnabled(false); view.setLongClickable(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            view.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
            view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
        view.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(words ? 1024 : 1024)});
        // IMEs can commit text without delivering a KeyEvent to the dialog.
        // Count edits only while this native field is focused and visible;
        // clearing a dismissed secret field must not rearm the idle timer.
        view.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {
                if (view.hasFocus() && view.hasWindowFocus() && view.isShown()) userInteraction();
            }
            @Override public void afterTextChanged(android.text.Editable value) { }
        });
        return view;
    }
    private LinearLayout panel(String message, View... fields) {
        Context context = dialogContext();
        LinearLayout layout = new LinearLayout(context); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32, 16, 32, 16);
        TextView text = new TextView(context); text.setText(message); layout.addView(text);
        for (View field : fields) layout.addView(field); return layout;
    }
    private void show(PluginCall call, String title, View view, String action, Runnable accept) {
        show(call, title, view, action, accept, null, null);
    }
    private void show(PluginCall call, String title, View view, String action, Runnable accept, String backLabel, Runnable back) {
        show(call, title, view, action, accept, backLabel, back, false);
    }
    private void show(PluginCall call, String title, View view, String action, Runnable accept, String backLabel, Runnable back, boolean recoveryDisplay) {
        getActivity().runOnUiThread(() -> {
            if (!active || destroyed || dialogCall != call) { clearFields((android.view.ViewGroup)view); finish(call, new IllegalStateException("Wallet is not in the foreground.")); return; }
            Context context = dialogContext();
            ScrollView scroll = new ScrollView(context); scroll.addView(view);
            // A native dialog has its own input dispatch, separate from Activity.
            AlertDialog shown = new AlertDialog(context) {
                @Override public boolean dispatchTouchEvent(android.view.MotionEvent event) { userInteraction(); return super.dispatchTouchEvent(event); }
                @Override public boolean dispatchKeyEvent(android.view.KeyEvent event) { userInteraction(); return super.dispatchKeyEvent(event); }
            };
            shown.setTitle(title); shown.setView(scroll);
            shown.setButton(AlertDialog.BUTTON_NEGATIVE, "Cancel", (which, button) -> finish(call, new NativeWalletErrors.Cancelled()));
            shown.setButton(AlertDialog.BUTTON_POSITIVE, action, (which, button) -> {
                    if (!active || destroyed || dialogCall != call) { finish(call, new IllegalStateException("Wallet operation cancelled.")); return; }
                    try { accept.run(); } catch (Exception error) { finish(call, error); }
                });
            if (back != null) shown.setButton(AlertDialog.BUTTON_NEUTRAL, backLabel, (which, button) -> {
                if (!active || destroyed || dialogCall != call) { finish(call, new IllegalStateException("Wallet operation cancelled.")); return; }
                try { back.run(); } catch (Exception error) { finish(call, error); }
            });
            dialog = shown;
            shown.setOnCancelListener(which -> finish(call, new NativeWalletErrors.Cancelled()));
            shown.setOnDismissListener(which -> {
                if (view instanceof android.view.ViewGroup) clearFields((android.view.ViewGroup) view);
                // Drop dismissed callbacks (which can capture the phrase), but
                // do not discard the next step opened by the previous button.
                synchronized (lifecycle) { if (dialog == shown) dialog = null; }
            });
            shown.setCanceledOnTouchOutside(false);
            shown.show();
            if (recoveryDisplay) synchronized (lifecycle) {
                recoveryViewed = true;
                recoveryHide = () -> {
                    synchronized (lifecycle) {
                        if (dialogCall != call || dialog != shown) return;
                        shown.dismiss();
                        finish(call, null);
                    }
                };
                subscriptionHandler.postDelayed(recoveryHide, 60_000);
            }
            shown.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        });
    }
    private static void clearFields(android.view.ViewGroup view) {
        for (int i = 0; i < view.getChildCount(); i++) {
            View child = view.getChildAt(i); if (child instanceof EditText) ((EditText) child).getText().clear();
            else if (child instanceof android.view.ViewGroup) clearFields((android.view.ViewGroup) child);
            else if (child instanceof TextView) ((TextView) child).setText("");
        }
    }
    @PluginMethod public void create(PluginCall call) { setup(call, false); }
    @PluginMethod public void importRecovery(PluginCall call) { setup(call, true); }
    @PluginMethod public void importWallet(PluginCall call) {
        if (!empty(call) || !begin(call)) return;
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall != call) { finish(call, new NativeWalletErrors.Cancelled()); return; }
            fileImportMode = true;
        }
        beginSetup(call, true);
    }
    @PluginMethod public void exportWallet(PluginCall call) {
        if (!empty(call) || !begin(call)) return;
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall != call) { finish(call, new NativeWalletErrors.Cancelled()); return; }
            if (!stored(file)) { finish(call, new IllegalStateException("Create or import a wallet first.")); return; }
            exportOnly = true; setupDraft = true;
        }
        getActivity().runOnUiThread(() -> show(call, "Export encrypted wallet", panel("Save a copy of this wallet's encrypted file in a location you control. The file keeps its existing password; exporting does not unlock it or change its password. Keep your recovery words and any BIP39 passphrase safe too.\n\nThis is a backup, not a transfer of funds. The wallet on this device stays in place."),
            "Choose location", () -> chooseReplacementBackup(call, false)));
    }
    private static char[] readSecret(EditText field) {
        android.text.Editable text = field.getText();
        char[] value = new char[text.length()];
        text.getChars(0, text.length(), value, 0);
        return value;
    }
    private static void wipeSecrets(char[][] values) {
        if (values != null) for (char[] value : values) if (value != null) Arrays.fill(value, '\0');
    }
    private void clearManagementSecrets() {
        wipeSecrets(managementSecrets); managementSecrets = null;
    }
    private boolean keepManagementSecrets(PluginCall call, char[][] values) {
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall != call) { wipeSecrets(values); return false; }
            clearManagementSecrets(); managementSecrets = values; return true;
        }
    }
    private void releaseManagementSecrets(char[][] values) {
        synchronized (lifecycle) {
            wipeSecrets(values); if (managementSecrets == values) managementSecrets = null;
        }
    }
    @PluginMethod public void changePassword(PluginCall call) {
        if (!empty(call) || !begin(call)) return;
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall != call) { finish(call, new NativeWalletErrors.Cancelled()); return; }
            if (!stored(file)) { finish(call, new IllegalStateException("Create or import a wallet first.")); return; }
            // Revoke old HD metadata writers before taking the authenticated disk
            // snapshot. No old encryption-key session may overwrite the rekey.
            lockNow();
            notifyListeners("walletStateChanged", state(), false);
        }
        getActivity().runOnUiThread(() -> {
            if (!active || destroyed || dialogCall != call) return;
            EditText current = field("Current wallet password", true, false);
            EditText next = field("New password (at least 12 characters)", true, false);
            EditText confirm = field("Repeat new password", true, false);
            show(call, "Change wallet password", panel("Your addresses, coins and recovery phrase stay the same. The wallet is locked while its encryption password changes.\n\nExport a new encrypted backup afterwards. Existing backups keep their old password. Cancelling does not change the password.", current, next, confirm), "Change password", () -> {
                char[][] secrets = { readSecret(current), readSecret(next), readSecret(confirm) };
                if (!keepManagementSecrets(call, secrets)) return;
                execute(call, expected -> {
                    byte[] source = null, replacement = null;
                    try {
                        synchronized (PAYMENT_STORAGE) {
                            synchronized (lifecycle) { requireLive(expected); source = readWalletSnapshot(); }
                        }
                        requireVaultMemory();
                        replacement = NativeWalletManagement.changePassword(source, secrets[0], secrets[1], secrets[2]);
                        synchronized (PAYMENT_STORAGE) {
                            synchronized (lifecycle) {
                                requireLive(expected);
                                if (dialogCall != call) throw new NativeWalletErrors.Cancelled();
                                try {
                                    NativeWalletManagement.commitPasswordChange(source, replacement, new NativeWalletManagement.Store() {
                                        @Override public byte[] read() throws Exception { return readWalletSnapshot(); }
                                        @Override public void write(byte[] value) throws Exception {
                                            FileOutputStream stream = null;
                                            try {
                                                stream = file.startWrite(); stream.write(value); stream.getFD().sync();
                                                file.finishWrite(stream); stream = null;
                                            } finally { if (stream != null) file.failWrite(stream); }
                                        }
                                    }, () -> {
                                        requireLive(expected);
                                        if (dialogCall != call) throw new NativeWalletErrors.Cancelled();
                                    });
                                } catch (NativeWalletManagement.StorageUncertainException uncertain) {
                                    throw new StorageUncertain("The password change could not be verified. Keep both passwords and your existing encrypted backups. Reopen the app before trying to unlock; do not replace this wallet.");
                                }
                                walletCommitted = true;
                            }
                        }
                        finish(call, null);
                    } finally {
                        if (source != null) Arrays.fill(source, (byte)0);
                        if (replacement != null) Arrays.fill(replacement, (byte)0);
                        releaseManagementSecrets(secrets);
                    }
                });
            });
        });
    }
    @PluginMethod public void viewRecoveryPhrase(PluginCall call) {
        if (!empty(call) || !begin(call)) return;
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall != call) { finish(call, new NativeWalletErrors.Cancelled()); return; }
            if (!stored(file)) { finish(call, new IllegalStateException("Create or import a wallet first.")); return; }
        }
        getActivity().runOnUiThread(() -> {
            if (!active || destroyed || dialogCall != call) return;
            EditText password = field("Current wallet password", true, false);
            show(call, "Authenticate to view recovery phrase", panel("Enter your current wallet password, even if the wallet is already unlocked. Recovery words are displayed only in a native window and are never sent to the server or web interface.", password), "View recovery phrase", () -> {
                char[][] secrets = { readSecret(password) };
                if (!keepManagementSecrets(call, secrets)) return;
                execute(call, expected -> {
                    byte[] source = null;
                    char[][] revealed = null;
                    boolean queued = false;
                    try {
                        synchronized (PAYMENT_STORAGE) {
                            synchronized (lifecycle) { requireLive(expected); source = readWalletSnapshot(); }
                        }
                        requireVaultMemory();
                        try (WalletVault.UpdateSession authenticated = WalletVault.openForUpdate(WalletVault.parse(source), secrets[0])) {
                            JSONObject payload = authenticated.payload();
                            revealed = new char[][] { payload.getString("mnemonic").toCharArray(), payload.optString("passphrase", "").toCharArray() };
                        }
                        synchronized (lifecycle) {
                            requireLive(expected);
                            if (!keepManagementSecrets(call, revealed)) throw new NativeWalletErrors.Cancelled();
                            char[][] words = revealed;
                            getActivity().runOnUiThread(() -> displayAuthenticatedRecovery(call, expected, words));
                            queued = true;
                        }
                    } finally {
                        if (source != null) Arrays.fill(source, (byte)0);
                        releaseManagementSecrets(secrets);
                        if (!queued) releaseManagementSecrets(revealed);
                    }
                });
            });
        });
    }
    private void displayAuthenticatedRecovery(PluginCall call, long expected, char[][] revealed) {
        try {
            synchronized (lifecycle) {
                requireLive(expected);
                if (dialogCall != call || managementSecrets != revealed) throw new NativeWalletErrors.Cancelled();
                LinearLayout form = panel("Anyone with this recovery information can spend your funds. Keep it private. Screenshots are allowed; keep any capture safe. This window closes after 60 seconds or when you leave the app.");
                String[] words = new String(revealed[0]).split(" ");
                for (int i = 0; i < words.length; i += 2) {
                    LinearLayout row = new LinearLayout(dialogContext()); row.setOrientation(LinearLayout.HORIZONTAL);
                    for (int j = i; j < Math.min(i + 2, words.length); j++) {
                        TextView word = recoveryText((j + 1) + ". " + words[j]);
                        row.addView(word, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
                    }
                    form.addView(row);
                }
                Arrays.fill(words, null);
                if (revealed[1].length > 0) {
                    form.addView(recoveryText("Additional BIP39 passphrase — also required to recover this wallet:"));
                    form.addView(recoveryText(new String(revealed[1])));
                }
                show(call, "Recovery phrase", form, "Done", () -> finish(call, null), null, null, true);
            }
        } catch (Exception error) { finish(call, error); }
        finally { releaseManagementSecrets(revealed); }
    }
    private TextView recoveryText(String text) {
        TextView view = new TextView(dialogContext());
        view.setText(text); view.setTextSize(18); view.setPadding(0, 12, 12, 12);
        view.setSaveEnabled(false); view.setTextIsSelectable(false); view.setLongClickable(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        return view;
    }
    private void setup(PluginCall call, boolean importing) {
        if (!empty(call) || !begin(call)) return;
        beginSetup(call, importing);
    }
    private void beginSetup(PluginCall call, boolean importing) {
        getActivity().runOnUiThread(() -> {
            synchronized (lifecycle) {
                if (!active || destroyed || dialogCall != call) { finish(call, new IllegalStateException("Wallet operation cancelled.")); return; }
                setupDraft = true;
                replacingWallet = stored(file);
            }
            try {
                if (replacingWallet) show(call, "Replace current wallet?", panel(
                    "First save an encrypted backup of your current wallet in a location you control. You need its current password to open that file in ConnectWallet desktop. Keep your recovery words too.\n\n"
                    + "The current wallet stays on this device until you finish creating or importing its replacement. Cancelling leaves it in place. On replacement, Automatic Claims stop; previous payment and claim receipts remain available. No funds are transferred."),
                    "Save encrypted backup", () -> chooseReplacementBackup(call, importing));
                else continueSetup(call, importing);
            } catch (Exception error) { finish(call, error); }
        });
    }
    private void continueSetup(PluginCall call, boolean importing) {
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall != call) { finish(call, new IllegalStateException("Wallet operation cancelled.")); return; }
            setupDraft = true;
        }
        if (importing && fileImportMode) chooseImportFile(call);
        else if (importing) requestPassword(call, null);
        else showRecoveryPhrase(call, WalletCrypto.generateMnemonic(24));
    }
    private byte[] readWalletSnapshot() throws Exception {
        try (InputStream input = file.openRead()) { return NativeWalletBackup.read(input); }
    }
    private void restoreReplacementSnapshot() throws Exception {
        // AtomicFile.finishWrite reports some failures only in Android logs.
        // Verify the original first, then restore its verified external-backup
        // bytes only when necessary; never delete an uncertain wallet file.
        try { NativeWalletBackup.verify(replacementSource, readWalletSnapshot()); return; }
        catch (Exception mismatch) { /* Attempt the bounded atomic restoration below. */ }
        FileOutputStream restoration = null;
        try {
            restoration = file.startWrite(); restoration.write(replacementSource); restoration.getFD().sync();
            file.finishWrite(restoration); restoration = null;
            NativeWalletBackup.verify(replacementSource, readWalletSnapshot());
        } catch (Exception error) {
            if (restoration != null) file.failWrite(restoration);
            throw error;
        }
    }
    private void chooseReplacementBackup(PluginCall call, boolean importing) {
        synchronized (lifecycle) { setupDraft = false; }
        execute(call, expected -> {
            final byte[] source;
            synchronized (PAYMENT_STORAGE) {
                synchronized (lifecycle) {
                    requireLive(expected);
                    if (dialogCall != call || !exportOnly && !replacingWallet) throw new IllegalStateException("Wallet backup cancelled.");
                    source = readWalletSnapshot();
                }
            }
            getActivity().runOnUiThread(() -> {
                try {
                    synchronized (lifecycle) {
                        requireLive(expected);
                        if (dialogCall != call || !exportOnly && !replacingWallet) throw new IllegalStateException("Wallet backup cancelled.");
                        replacementSource = source; backupImporting = importing;
                        backupPickerPending = true; setupDraft = true;
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("application/json").putExtra(Intent.EXTRA_TITLE, "ConnectWallet-backup-" + System.currentTimeMillis() + ".connectwallet.json")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                        startActivityForResult(call, intent, "replacementBackupChosen");
                    }
                } catch (Exception error) { finish(call, new IllegalStateException("Could not open the backup location picker. Your current wallet is unchanged.")); }
            });
        });
    }
    @ActivityCallback private void replacementBackupChosen(PluginCall call, ActivityResult result) {
        synchronized (lifecycle) {
            // A restored or late Android result cannot authorize a new operation.
            if (call == null || destroyed || dialogCall != call || !backupPickerPending || replacementSource == null) return;
            backupPickerPending = false;
            if (result.getResultCode() != Activity.RESULT_OK) { finish(call, new NativeWalletErrors.Cancelled()); return; }
            Uri destination = result.getData() == null ? null : result.getData().getData();
            if (destination == null || !"content".equals(destination.getScheme())) {
                finish(call, new IllegalStateException("Choose a document location for the encrypted backup. Your current wallet is unchanged.")); return;
            }
            backupDestination = destination;
        }
        // Android may deliver the result before onResume. Defer work until the
        // Activity is foreground again instead of accepting a stale generation.
        resumeReplacementBackup();
    }
    private void resumeReplacementBackup() {
        final PluginCall call;
        final Uri destination;
        final byte[] source;
        final boolean importing;
        final boolean exporting;
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall == null || backupDestination == null) return;
            call = dialogCall; destination = backupDestination; backupDestination = null;
            source = replacementSource; importing = backupImporting; exporting = exportOnly; setupDraft = false;
        }
        executeBackup(call, expected -> {
            final CancellationSignal cancellation = new CancellationSignal();
            final Runnable deadline = () -> {
                synchronized (lifecycle) {
                    if (dialogCall == call && backupCancellation == cancellation) {
                        finish(call, new IllegalStateException("The backup location did not respond in time. Your current wallet is unchanged."));
                    }
                }
            };
            try {
                synchronized (lifecycle) { requireLive(expected); backupCancellation = cancellation; }
                subscriptionHandler.postDelayed(deadline, 30000);
                try (ParcelFileDescriptor descriptor = getContext().getContentResolver().openFileDescriptor(destination, "wt", cancellation)) {
                    registerBackupDescriptor(call, expected, cancellation, descriptor);
                    try (ParcelFileDescriptor.AutoCloseOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) {
                        NativeWalletBackup.write(source, output);
                    }
                }
                synchronized (lifecycle) { requireLive(expected); backupDescriptor = null; }
                // Closing the write before opening the read makes provider
                // errors and truncated/changed copies block replacement.
                try (ParcelFileDescriptor descriptor = getContext().getContentResolver().openFileDescriptor(destination, "r", cancellation)) {
                    registerBackupDescriptor(call, expected, cancellation, descriptor);
                    try (ParcelFileDescriptor.AutoCloseInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
                        NativeWalletBackup.verify(source, NativeWalletBackup.read(input));
                    }
                }
                synchronized (PAYMENT_STORAGE) {
                    synchronized (lifecycle) {
                        requireLive(expected);
                        if (dialogCall != call || backupCancellation != cancellation || cancellation.isCanceled()) throw new IllegalStateException("Wallet backup cancelled.");
                        // Export is a verified point-in-time copy. Replacement
                        // additionally requires this exact source still installed.
                        if (!exporting) NativeWalletBackup.verify(source, readWalletSnapshot());
                        replacementBackupVerified = !exporting; backupDescriptor = null; backupCancellation = null;
                    }
                }
                getActivity().runOnUiThread(() -> {
                    try { if (exporting) finish(call, null); else continueSetup(call, importing); }
                    catch (Exception error) { finish(call, error); }
                });
            } catch (Exception error) {
                finish(call, new IllegalStateException("The encrypted backup could not be saved and verified. Your current wallet is unchanged. Choose another location and try again."));
            } finally {
                subscriptionHandler.removeCallbacks(deadline);
                synchronized (lifecycle) { if (backupCancellation == cancellation) cancelBackupIo(); }
            }
        });
    }
    private void chooseImportFile(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                synchronized (lifecycle) {
                    if (!active || destroyed || dialogCall != call || !fileImportMode) throw new IllegalStateException("Wallet import cancelled.");
                    if (replacingWallet && !replacementBackupVerified) throw new IllegalStateException("Save and verify the current wallet backup first.");
                    importPickerPending = true; setupDraft = true;
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(call, intent, "walletImportFileChosen");
                }
            } catch (Exception error) { finish(call, new IllegalStateException("Could not open the wallet file picker. Your current wallet is unchanged.")); }
        });
    }
    @ActivityCallback private void walletImportFileChosen(PluginCall call, ActivityResult result) {
        synchronized (lifecycle) {
            if (call == null || destroyed || dialogCall != call || !importPickerPending || !fileImportMode) return;
            importPickerPending = false;
            if (result.getResultCode() != Activity.RESULT_OK) { finish(call, new NativeWalletErrors.Cancelled()); return; }
            Uri source = result.getData() == null ? null : result.getData().getData();
            if (source == null || !"content".equals(source.getScheme())) {
                finish(call, new IllegalStateException("Choose an encrypted ConnectWallet document. Your current wallet is unchanged.")); return;
            }
            importSource = source;
        }
        resumeWalletFileImport();
    }
    private void resumeWalletFileImport() {
        final PluginCall call; final Uri source;
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall == null || importSource == null || !fileImportMode) return;
            call = dialogCall; source = importSource; importSource = null; setupDraft = false;
        }
        executeBackup(call, expected -> {
            final CancellationSignal cancellation = new CancellationSignal();
            final Runnable deadline = () -> {
                synchronized (lifecycle) {
                    if (dialogCall == call && backupCancellation == cancellation)
                        finish(call, new IllegalStateException("The wallet file location did not respond in time. Your current wallet is unchanged."));
                }
            };
            byte[] bytes = null;
            try {
                synchronized (lifecycle) { requireLive(expected); backupCancellation = cancellation; }
                subscriptionHandler.postDelayed(deadline, 30000);
                try (ParcelFileDescriptor descriptor = getContext().getContentResolver().openFileDescriptor(source, "r", cancellation)) {
                    registerBackupDescriptor(call, expected, cancellation, descriptor);
                    try (ParcelFileDescriptor.AutoCloseInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
                        bytes = NativeWalletBackup.read(input);
                    }
                }
                // Reject oversized, malformed or unsupported envelopes before
                // the KDF. Network and payload validation follow decryption.
                NativeWalletBackup.parseEnvelope(bytes);
                synchronized (lifecycle) {
                    requireLive(expected);
                    if (dialogCall != call || backupCancellation != cancellation || cancellation.isCanceled()) throw new IllegalStateException("Wallet import cancelled.");
                    importedEnvelope = bytes; bytes = null; setupDraft = true;
                    backupDescriptor = null; backupCancellation = null;
                }
                getActivity().runOnUiThread(() -> requestFilePassword(call));
            } catch (Exception error) {
                finish(call, new IllegalStateException("The selected file could not be read as an encrypted ConnectWallet wallet. Your current wallet is unchanged."));
            } finally {
                if (bytes != null) Arrays.fill(bytes, (byte)0);
                subscriptionHandler.removeCallbacks(deadline);
                synchronized (lifecycle) { if (backupCancellation == cancellation) cancelBackupIo(); }
            }
        });
    }
    private void requestFilePassword(PluginCall call) {
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall != call || importedEnvelope == null || !fileImportMode) {
                finish(call, new IllegalStateException("Wallet import cancelled.")); return;
            }
            setupDraft = true;
        }
        EditText password = field("Wallet file password", true, false);
        show(call, "Import encrypted wallet file", panel(
            "Enter this file's existing password. It will remain the password for this wallet; it is used only in native memory. Compatible receiving and change addresses, metadata and any saved BIP39 passphrase are preserved. Address recovery runs again before sending.\n\n"
            + (replacingWallet ? "Your current wallet's encrypted backup was saved and verified. Importing replaces that wallet on this device and stops Automatic Claims. Keep the backup and its original password. " : "The imported wallet will be saved encrypted on this device. ")
            + "No funds are transferred.", password), replacingWallet ? "Replace wallet" : "Import wallet", () -> {
                char[] secret = password.getText().toString().toCharArray(); final byte[] source;
                synchronized (lifecycle) {
                    if (!active || destroyed || dialogCall != call || importedEnvelope == null) {
                        Arrays.fill(secret, '\0'); finish(call, new IllegalStateException("Wallet import cancelled.")); return;
                    }
                    source = importedEnvelope.clone(); setupDraft = false; pendingPassword = secret;
                }
                execute(call, expected -> {
                    WalletVault.UpdateSession encrypted = null;
                    try {
                        requireVaultMemory();
                        try { encrypted = NativeWalletBackup.openForImport(source, secret); }
                        catch (Exception error) { throw new IllegalStateException("The encrypted wallet could not be unlocked. Check the file and its password. Your current wallet is unchanged."); }
                        WalletVault.UpdateSession prepared = encrypted; encrypted = null;
                        installWallet(call, expected, prepared);
                    } finally {
                        if (encrypted != null) encrypted.close(); Arrays.fill(source, (byte)0); Arrays.fill(secret, '\0');
                        if (pendingPassword == secret) pendingPassword = null;
                    }
                });
            });
    }
    private void registerBackupDescriptor(PluginCall call, long expected, CancellationSignal cancellation, ParcelFileDescriptor descriptor) {
        synchronized (lifecycle) {
            requireLive(expected);
            if (descriptor == null || dialogCall != call || backupCancellation != cancellation || cancellation.isCanceled()) throw new IllegalStateException("Backup cancelled.");
            backupDescriptor = descriptor;
        }
    }
    private void cancelBackupIo() {
        CancellationSignal cancellation = backupCancellation; backupCancellation = null;
        ParcelFileDescriptor descriptor = backupDescriptor; backupDescriptor = null;
        // A document provider may run cancellation callbacks synchronously.
        // Detach under lifecycle, but never call that provider while holding
        // the wallet monitor or blocking the Activity's main thread.
        if (cancellation != null || descriptor != null) java.util.concurrent.CompletableFuture.runAsync(() -> {
            if (descriptor != null) try { descriptor.close(); } catch (java.io.IOException ignored) { }
            if (cancellation != null) cancellation.cancel();
        });
    }
    private void showRecoveryPhrase(PluginCall call, String mnemonic) {
        LinearLayout form = panel("Write these 24 words down in order before continuing. Anyone with these words can spend your funds. Screenshots are allowed; keep any capture private.\n\nReceiving and change addresses follow the same derivation paths and 20-address recovery gap as ConnectWallet desktop. Keep these words safe: they recover your addresses, not just the one currently shown.");
        // Read-only native text, never sent to the WebView or clipboard. No
        // input fields here: the keyboard cannot cover the phrase on entry.
        String[] words = mnemonic.split(" ");
        for (int i = 0; i < words.length; i += 2) {
            LinearLayout row = new LinearLayout(dialogContext()); row.setOrientation(LinearLayout.HORIZONTAL);
            for (int j = i; j < Math.min(i + 2, words.length); j++) {
                TextView word = new TextView(dialogContext()); word.setText((j + 1) + ". " + words[j]);
                word.setTextSize(18); word.setPadding(0, 12, 12, 12); word.setSaveEnabled(false);
                row.addView(word, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
            }
            form.addView(row);
        }
        show(call, "Step 1 of 3: Recovery words", form, "I wrote down my words", () -> backupCheck(call, mnemonic, false));
    }
    private void backupCheck(PluginCall call, String mnemonic, boolean mismatch) {
        String[] words = mnemonic.split(" ");
        EditText first = field("Word 3", false, false), second = field("Word 12", false, false), third = field("Word 23", false, false);
        LinearLayout form = panel((mismatch ? "The words do not match. Check your backup and try again.\n\n" : "")
            + "Enter words 3, 12 and 23 from the phrase you just wrote down. Use Review words to see the same phrase again.", first, second, third);
        show(call, "Step 2 of 3: Confirm recovery words", form, "Continue", () -> {
            if (!words[2].equals(first.getText().toString().trim()) || !words[11].equals(second.getText().toString().trim()) || !words[22].equals(third.getText().toString().trim())) {
                backupCheck(call, mnemonic, true); return;
            }
            requestPassword(call, mnemonic);
        }, "Review words", () -> showRecoveryPhrase(call, mnemonic));
    }
    private void requestPassword(PluginCall call, String generatedMnemonic) {
        requestPassword(call, generatedMnemonic, "");
    }
    private void requestPassword(PluginCall call, String generatedMnemonic, String validationError) {
        boolean importing = generatedMnemonic == null;
        EditText phrase = importing ? field("Recovery words", false, true) : null;
        EditText password = field("New password (at least 12 characters)", true, false), confirm = field("Repeat password", true, false);
        LinearLayout form = panel((validationError.isEmpty() ? "" : validationError + "\n\n")
            + "Use a trusted keyboard. Your password encrypts this wallet on this device; it does not replace your recovery words. "
            + (importing ? "This import supports recovery phrases without an additional BIP39 passphrase. The wallet will discover receiving and change addresses using the same 20-address recovery gap as ConnectWallet desktop. Keep it open until discovery finishes before sending." : "Your recovery words have been confirmed. Now choose your local password."), password, confirm);
        if (importing) form.addView(phrase, 1);
        if (replacingWallet) form.addView(panel("Your encrypted backup was saved and verified. Completing this step replaces the current wallet on this device and stops Automatic Claims. Keep the backup and its original password."));
        show(call, importing ? "Import recovery phrase" : "Step 3 of 3: Protect your wallet", form, replacingWallet ? "Replace wallet" : "Create encrypted wallet", () -> {
            String mnemonic = importing ? phrase.getText().toString() : generatedMnemonic;
            char[] secret = password.getText().toString().toCharArray();
            char[] repeated = confirm.getText().toString().toCharArray(); boolean samePassword;
            try { samePassword = Arrays.equals(secret, repeated); } finally { Arrays.fill(repeated, '\0'); }
            if (!samePassword) { Arrays.fill(secret, '\0'); retryPassword(call, generatedMnemonic, new IllegalArgumentException("Passwords do not match.")); return; }
            try { WalletVault.validatePassword(secret); if (!WalletCrypto.validateMnemonic(mnemonic)) throw new IllegalArgumentException("Invalid recovery phrase."); }
            catch (Exception error) { Arrays.fill(secret, '\0'); retryPassword(call, generatedMnemonic, error); return; }
            saveWallet(call, mnemonic, secret, importing);
        });
    }
    private void retryPassword(PluginCall call, String generatedMnemonic, Exception error) {
        // A password typo must not discard a new phrase the user already backed up.
        if (generatedMnemonic != null) requestPassword(call, generatedMnemonic, safeMessage(error));
        else finish(call, error);
    }
    private volatile char[] pendingPassword;
    private void saveWallet(PluginCall call, String mnemonic, char[] secret, boolean importing) {
        synchronized (lifecycle) {
            if (!active || destroyed || dialogCall != call) {
                Arrays.fill(secret, '\0'); finish(call, new IllegalStateException("Wallet operation cancelled.")); return;
            }
            // Once saving begins, normal cancellation/generation checks apply.
            // The background exception is only for the editable setup screens.
            setupDraft = false;
            pendingPassword = secret;
        }
        execute(call, expected -> {
            WalletVault.UpdateSession encrypted = null;
            try {
                requireVaultMemory();
                // Creation/recovery matches the desktop UI: no extra BIP39 passphrase.
                JSONObject payload = WalletVault.newPayload("ConnectWallet mobile", mnemonic, "").put("needsRecovery", importing);
                encrypted = WalletVault.createForUpdate(payload, secret);
                WalletVault.UpdateSession prepared = encrypted; encrypted = null;
                installWallet(call, expected, prepared);
            } finally { if (encrypted != null) encrypted.close(); Arrays.fill(secret, '\0'); if (pendingPassword == secret) pendingPassword = null; }
        });
    }
    private static void requireVaultMemory() {
        if (Runtime.getRuntime().maxMemory() < 256L * 1024 * 1024) throw new IllegalStateException("This device cannot allocate the desktop-compatible wallet KDF safely.");
    }
    /** Takes ownership of an authenticated, mainnet-only envelope. No source
     * bytes, decryption key, recovery phrase or password cross the bridge. */
    private void installWallet(PluginCall call, long expected, WalletVault.UpdateSession encrypted) throws Exception {
        VaultSession unlocked = null; NativeHdWallet nextHd = null;
        try {
            JSONObject payload = encrypted.payload();
            byte[] encoded = WalletVault.serialize(encrypted.envelope()).getBytes(StandardCharsets.UTF_8);
            unlocked = new VaultSession(payload.getString("mnemonic"), payload.optString("passphrase", ""));
            nextHd = createHd(unlocked, encrypted); encrypted = null;
            JSONObject nextPublic = nextHd.snapshot(); JSONObject nextAccount = nextPublic.getJSONObject("account");
            synchronized (PAYMENT_STORAGE) {
                synchronized (lifecycle) {
                    requireLive(expected);
                    if (dialogCall != call) throw new IllegalStateException("Wallet operation cancelled.");
                    if (replacingWallet) {
                        if (!replacementBackupVerified || replacementSource == null) throw new IllegalStateException("Save and verify the current wallet backup first.");
                        NativeWalletBackup.verify(replacementSource, readWalletSnapshot());
                    } else if (stored(file)) throw new IllegalStateException("Wallet already exists. Start again to back it up before replacement.");
                    FileOutputStream stream = null;
                    try {
                        stream = file.startWrite(); stream.write(encoded); stream.getFD().sync();
                        requireLive(expected);
                        // Keep receipts/unknown outcomes, but stop signing for
                        // the former reward destination before swapping wallets.
                        if (replacingWallet) runtime.stop();
                        file.finishWrite(stream); stream = null;
                        NativeWalletBackup.verify(encoded, readWalletSnapshot());
                    } catch (Exception error) {
                        if (stream != null) file.failWrite(stream);
                        if (replacingWallet) {
                            try { restoreReplacementSnapshot(); }
                            catch (Exception restoration) {
                                lockNow(); account = null; publicHd = null; runtime.stop(); refreshSubscriptions();
                                throw new StorageUncertain();
                            }
                        }
                        throw error;
                    }
                    generation++; pendingHdUsed.clear();
                    if (hdWallet != null) hdWallet.close(); if (session != null) session.close();
                    publicHd = nextPublic; hdWallet = nextHd; nextHd = null;
                    account = nextAccount; session = unlocked; unlocked = null;
                    armInactivity();
                    walletCommitted = true;
                }
            }
        } finally { if (nextHd != null) nextHd.close(); if (encrypted != null) encrypted.close(); if (unlocked != null) unlocked.close(); }
        // The verified atomic commit has succeeded. Notification setup must not
        // turn that success into a misleading "old wallet unchanged" failure.
        try { refreshSubscriptions(); } catch (RuntimeException network) { scheduleSubscriptionRefresh(); }
        finish(call, null); startRecovery(null);
    }
    @PluginMethod public void unlock(PluginCall call) {
        if (!empty(call) || !begin(call)) return;
        if (!stored(file)) { finish(call, new IllegalStateException("Create or import a wallet first.")); return; }
        getActivity().runOnUiThread(() -> {
            EditText password = field("Wallet password", true, false);
            show(call, "Unlock wallet", panel("Your password is used only in native memory.", password), "Unlock", () -> {
                char[] secret = password.getText().toString().toCharArray(); pendingPassword = secret;
                execute(call, expected -> {
                    VaultSession unlocked = null;
                    WalletVault.UpdateSession encrypted = null;
                    NativeHdWallet nextHd = null;
                    try {
                        final byte[] source;
                        synchronized (PAYMENT_STORAGE) {
                            synchronized (lifecycle) { requireLive(expected); source = readWalletSnapshot(); }
                        }
                        encrypted = WalletVault.openForUpdate(WalletVault.parse(new String(source, StandardCharsets.UTF_8)), secret);
                        JSONObject payload = encrypted.payload();
                        // Preserve any passphrase already stored by earlier alpha builds.
                        unlocked = new VaultSession(payload.getString("mnemonic"), payload.optString("passphrase", ""));
                        nextHd = createHd(unlocked, encrypted); encrypted = null;
                        JSONObject nextPublic = nextHd.snapshot();
                        synchronized (lifecycle) {
                            requireLive(expected); if (hdWallet != null) hdWallet.close(); if (session != null) session.close();
                            if (!java.util.Objects.equals(walletId(), nextPublic.optString("walletId"))) pendingHdUsed.clear();
                            publicHd = nextPublic; account = nextPublic.getJSONObject("account"); hdWallet = nextHd; nextHd = null; session = unlocked; unlocked = null;
                            armInactivity();
                        }
                        refreshSubscriptions();
                        finish(call, null);
                        if (!nextPublic.getJSONObject("hd").getBoolean("complete")) startRecovery(null);
                        else queueHdObservations();
                    } finally { if (nextHd != null) nextHd.close(); if (encrypted != null) encrypted.close(); if (unlocked != null) unlocked.close(); Arrays.fill(secret, '\0'); if (pendingPassword == secret) pendingPassword = null; }
                });
            });
        });
    }
    @PluginMethod public void reviewPayment(PluginCall call) {
        final NativeSendPolicy.Request send;
        final JSONObject destination;
        try { send = NativeSendPolicy.request(call.getData()); destination = send.destination(); }
        catch (Exception error) { call.reject(safeMessage(error), "INVALID"); return; }
        reviewTransfer(call, destination, null, send);
    }
    @PluginMethod public void reviewP2C(PluginCall call) {
        final NativeP2CPolicy.Request bounty;
        final JSONObject destination;
        try { bounty = NativeP2CPolicy.request(call.getData()); destination = bounty.destination(); }
        catch (Exception error) { call.reject(safeMessage(error), "INVALID"); return; }
        reviewTransfer(call, destination, bounty, null);
    }
    private void reviewTransfer(PluginCall call, JSONObject destination, NativeP2CPolicy.Request bounty, NativeSendPolicy.Request send) {
        if (!begin(call)) return;
        execute(call, expected -> {
            requireNoPendingBatch();
            JSONObject mine;
            final NativeHdWallet wallet;
            final JSONArray nativeAccounts;
            final int totalAccountCount;
            final String ownAddress;
            synchronized (lifecycle) {
                requireLive(expected); if (session == null || hdWallet == null) throw new IllegalStateException("Unlock the wallet first.");
                wallet = hdWallet; wallet.requireReady(); mine = wallet.changeAccount(); ownAddress = walletId();
                JSONArray allAccounts = wallet.accounts(); totalAccountCount = allAccounts.length();
                NativeFundingScope scope = send == null ? bounty.fundingScope : send.fundingScope;
                // This is only a source-address filter. Re-read and authenticate
                // every selected address below; no renderer balance is trusted.
                nativeAccounts = scope == null ? allAccounts : scope.select(allAccounts);
            }
            final java.util.Map<String, String> fundingOwners = new java.util.HashMap<>();
            for (int i = 0; i < nativeAccounts.length(); i++) {
                JSONObject derived = nativeAccounts.getJSONObject(i);
                fundingOwners.put(derived.getInt("change") + ":" + derived.getInt("index"), derived.getString("publicKey"));
            }
            JSONObject reservations = readReservations();
            MobilePaymentFunding.Session preparation = paymentFunding.session(
                paymentReader(expected),
                () -> checkPaymentPreparation(call, expected),
                (stage, completed, total, retryAfterMs) -> paymentProgress(call, expected, ownAddress,
                    bounty == null ? "reviewPayment" : "reviewP2C", stage, completed, total, retryAfterMs));
            MobilePaymentPreparation.HdInventory inventory = MobilePaymentPreparation.inventory(nativeAccounts, reservations, preparation);
            JSONArray candidates = inventory.candidates(), pendingCandidates = inventory.pendingCandidates();
            // Select by exact amounts first; authenticate only the required parents.
            JSONObject selectedPlan;
            JSONObject batch = null;
            try {
                if (send == null) selectedPlan = NativeTransactions.planPayment(candidates, new JSONArray().put(destination), mine.getString("address"), 1500, false);
                else { batch = NativeSendBatch.plan(send, candidates, mine.getString("address")); selectedPlan = batch.getJSONArray("plans").getJSONObject(0); }
            }
            catch (IllegalArgumentException insufficient) {
                if (send != null && send.useAllBalance || pendingCandidates.length() == 0 || candidates.length() != 0 && !"Insufficient funds for payment and fee.".equals(insufficient.getMessage())) throw insufficient;
                for (int i = 0; i < pendingCandidates.length(); i++) candidates.put(pendingCandidates.getJSONObject(i));
                selectedPlan = send == null ? NativeTransactions.planPayment(candidates, new JSONArray().put(destination), mine.getString("address"), 1500, false) : send.plan(candidates, mine.getString("address"));
            }
            if (batch != null && batch.getJSONArray("plans").length() > 1) {
                prepareBatchReview(call, expected, wallet, mine, ownAddress, nativeAccounts.length(), totalAccountCount,
                    fundingOwners, inventory, preparation, send, batch);
                return;
            }
            JSONArray selected = paymentFunding.load(selectedPlan.getJSONArray("selected"), input -> {
                if (!(input.opt("index") instanceof Integer) || !(input.opt("change") instanceof Integer)) throw new IllegalArgumentException("Invalid native funding path.");
                String key = fundingOwners.get(input.getInt("change") + ":" + input.getInt("index"));
                if (key == null) throw new IllegalArgumentException("Funding path is outside the current wallet.");
                return key;
            }, preparation);
            selectedPlan.put("selected", selected);
            // Parent bytes are immutable, but spendability is not. Reconcile
            // address mutations since the baseline after slow funding reads.
            // Never silently enlarge use-all or replace the reviewed selection.
            final MobilePaymentPreparation.HdInventory fresh = MobilePaymentPreparation.refresh(inventory, readReservations(), preparation);
            fresh.verifySelected(selected, send != null && send.useAllBalance, send == null ? null : send.amount);
            // Reserve capacity before displaying/signing, preserving old and
            // uncertain payments even when their wallet is no longer open.
            NativePaymentReservations.reserve(readReservations(), selected, "0".repeat(64));
            requireLive(expected);
            // Check funding before the advisory network connection. The probe
            // receives only a public domain/time, never keys or transaction data.
            final NativeP2CPolicy.Request reviewedBounty = bounty == null ? null : probeBounty(call, bounty, expected);
            final JSONObject plan = reviewedBounty == null ? selectedPlan : NativeTransactions.planPayment(selected,
                new JSONArray().put(reviewedBounty.destination()), mine.getString("address"), 1500, false);
            requireLive(expected);
            HashSet<String> replacing = new HashSet<>();
            for (int i = 0; i < selected.length(); i++) if (!selected.getJSONObject(i).isNull("pending_spent_by")) replacing.add(selected.getJSONObject(i).getString("pending_spent_by"));
            final boolean replacesPending = !replacing.isEmpty();
            String warning = replacesPending ? "\n\nThis payment spends coins reserved by these pending or previously submitted transactions:\n" + android.text.TextUtils.join("\n", replacing) + "\nTheir outcome may be unknown. Check them first. Explicitly allow a replacement below to proceed. The node may still reject it." : "";
            String scopeNotice = nativeAccounts.length() < totalAccountCount
                ? "\n\nFunding is restricted to " + nativeAccounts.length() + " of " + totalAccountCount + " wallet addresses. Other addresses are not included in this payment." : "";
            String review = (reviewedBounty == null ? send.review(plan, mine.getString("address")) : reviewedBounty.review(plan, mine.getString("address"))) + scopeNotice + warning;
            long expires = android.os.SystemClock.elapsedRealtime() + 120000;
            getActivity().runOnUiThread(() -> {
                android.widget.CheckBox allowReplacement = new android.widget.CheckBox(dialogContext());
                allowReplacement.setText("Allow replacing pending payments"); allowReplacement.setChecked(false);
                show(call, bounty == null ? "Confirm payment" : "Confirm public P2C bounty", replacesPending ? panel(review, allowReplacement) : panel(review), bounty == null ? "Sign and send" : "Create public bounty", () -> {
                    if (replacesPending && !allowReplacement.isChecked()) { finish(call, new IllegalStateException("Replacement was not authorized. Check the previous transaction before retrying.")); return; }
                    execute(call, stillExpected -> {
                final VaultSession signingSession;
                synchronized (lifecycle) {
                    requireLive(expected); requireLive(stillExpected);
                    if (dialogCall != call || session == null || hdWallet != wallet) throw new IllegalStateException("Payment signing cancelled. Unlock and review again.");
                    signingSession = session;
                }
                NativeTransactions.FundingCheck signingCheck = () -> {
                    synchronized (lifecycle) {
                        requireLive(expected); requireLive(stillExpected);
                        if (dialogCall != call || session != signingSession || signingSession.isLocked() || hdWallet != wallet) throw new IllegalStateException("Payment signing cancelled. Unlock and review again.");
                        if (android.os.SystemClock.elapsedRealtime() >= expires) throw new IllegalStateException("Payment review expired. Review a fresh payment.");
                    }
                };
                signingCheck.check();
                // A reservation can arrive while the native confirmation is
                // open. Reconcile it before signing; never turn that payment
                // into an unreviewed replacement of another transaction.
                MobilePaymentFunding.Session confirmedPreparation = paymentFunding.session(
                    paymentReader(expected), signingCheck::check,
                    (stage, completed, total, retryAfterMs) -> paymentProgress(call, expected, ownAddress,
                        bounty == null ? "reviewPayment" : "reviewP2C", stage, completed, total, retryAfterMs));
                MobilePaymentPreparation.HdInventory beforeSigning = MobilePaymentPreparation.refresh(fresh, readReservations(), confirmedPreparation);
                beforeSigning.verifySelected(selected, send != null && send.useAllBalance, send == null ? null : send.amount);
                signingCheck.check();
                // Large plans must not prevent onPause/lock from revoking the
                // session. Each digest is checked independently on this worker.
                if (reviewedBounty != null) reviewedBounty.verifyPlan(plan, mine.getString("address")); else send.verifyPlan(plan, mine.getString("address"));
                JSONObject signed = NativeTransactions.signPayment(plan, signingSession, signingCheck);
                if (NativeTransactions.amount(plan.getString("change")) > 0) {
                    // Commit the reviewed change path before any possible write
                    // to the network. An unknown broadcast must never reuse it.
                    wallet.allocateChange(mine.getInt("index"), signingCheck::check);
                    publishHd(wallet, expected);
                }
                // The process-wide gate covers ordinary payments as well as
                // batches, including any late proven-unsent cleanup. Every
                // reservation writer therefore owns it from snapshot through
                // the final write, even when its Activity has been replaced.
                synchronized (PAYMENT_STORAGE) {
                    signingCheck.check();
                    requireNoPendingBatch();
                    if (!BATCH_IN_FLIGHT.compareAndSet(false, true)) throw new IllegalStateException("A previous payment is still settling. Check it before sending again.");
                }
                try {
                    // Persist the PUBLIC signed transaction before the write. It allows
                    // inspection after any indeterminate broadcast, never an auto retry.
                    java.util.concurrent.CompletableFuture<JSONObject> submission;
                    final JSONObject previousReservations;
                    synchronized (PAYMENT_STORAGE) {
                        signingCheck.check();
                        previousReservations = readReservations();
                        JSONObject held = NativePaymentReservations.reserve(previousReservations, selected, signed.getString("txid"));
                        signingCheck.check();
                        writePublicFile("payment-reservations-v1.json", held);
                        signingCheck.check();
                        writePublicFile("last-payment-public.json", signed);
                        signingCheck.check();
                    }
                    synchronized (lifecycle) {
                        signingCheck.check();
                        lastPayment = new JSONObject().put("txid", signed.getString("txid")).put("status", "check-required");
                        broadcasting = true; submission = runtime.rpc.broadcast(signed.getString("hex"));
                    }
                    try {
                        JSONObject sent = MobileRpcAwait.broadcast(submission, signingCheck::check, runtime.rpc::cancelBeforeWrite);
                        if (!signed.getString("txid").equals(sent.optString("txid"))) throw new IllegalStateException("Unexpected broadcast response; check the transaction ID before retrying.");
                        completePayment(call, new JSObject().put("txid", signed.getString("txid")).put("status", "submitted"));
                    } catch (Exception error) {
                        submission.cancel(true);
                        try {
                            boolean notSent;
                            synchronized (PAYMENT_STORAGE) {
                                notSent = MobilePaymentCancellation.recordIfUnsent(error, signed, previousReservations, new MobilePaymentCancellation.Store() {
                                    public JSONObject reservations() throws Exception { return readReservations(); }
                                    public void receipt(JSONObject value) throws Exception { writePublicFile("last-payment-public.json", value); }
                                    public void reservations(JSONObject value) throws Exception { writePublicFile("payment-reservations-v1.json", value); }
                                });
                            }
                            if (notSent) {
                                completePayment(call, new JSObject().put("txid", signed.getString("txid")).put("status", "not-sent")
                                    .put("message", "Cancelled before transmission. No payment was sent; review again to send."));
                                return;
                            }
                        } catch (Exception receiptFailure) { /* Keep uncertain/reserved state if durable cleanup fails. */ }
                        completePayment(call, new JSObject().put("txid", signed.getString("txid")).put("status", "check-required").put("message", "Check this transaction ID before attempting another payment. The previous outcome may be unknown."));
                    }
                } finally {
                    synchronized (lifecycle) { broadcasting = false; }
                    BATCH_IN_FLIGHT.set(false);
                }
                    });
                });
            });
        });
    }
    private void prepareBatchReview(PluginCall call, long expected, NativeHdWallet wallet, JSONObject mine,
            String ownAddress, int fundedAddresses, int totalAddresses, java.util.Map<String, String> fundingOwners,
            MobilePaymentPreparation.HdInventory inventory, MobilePaymentFunding.Session preparation,
            NativeSendPolicy.Request send, JSONObject batch) throws Exception {
        JSONArray plans = batch.getJSONArray("plans"), combined = new JSONArray();
        // The shared funding cache may evict an earlier part's parent. Keep one
        // canonical string per txid across this review so the memory bound also
        // bounds retained bytes, not just the distinct parent IDs.
        java.util.Map<String, String> retainedParents = new java.util.HashMap<>(); long retainedHex = 0;
        JSONObject capacity = readReservations();
        for (int part = 0; part < plans.length(); part++) {
            preparation.check(); JSONObject plan = plans.getJSONObject(part);
            JSONArray selected = paymentFunding.load(plan.getJSONArray("selected"), input -> {
                if (!(input.opt("index") instanceof Integer) || !(input.opt("change") instanceof Integer)) throw new IllegalArgumentException("Invalid native funding path.");
                String key = fundingOwners.get(input.getInt("change") + ":" + input.getInt("index"));
                if (key == null) throw new IllegalArgumentException("Funding path is outside the current wallet.");
                return key;
            }, preparation);
            for (int i = 0; i < selected.length(); i++) {
                JSONObject row = selected.getJSONObject(i); combined.put(row);
                String raw = row.getString("rawTransaction");
                String retained = retainedParents.putIfAbsent(row.getString("txid"), raw);
                if (retained == null) retainedHex += raw.length();
                else row.put("rawTransaction", retained);
                if (retainedHex > 16L * 1024 * 1024) throw new IllegalArgumentException("Selected batch funding exceeds the mobile memory limit. Send a smaller amount first.");
            }
            plan.put("selected", selected);
            capacity = NativePaymentReservations.reserve(capacity, selected, "0".repeat(64));
        }
        batch.put("selected", combined);
        final MobilePaymentPreparation.HdInventory fresh = MobilePaymentPreparation.refresh(inventory, readReservations(), preparation);
        fresh.verifyBatch(plans, send.useAllBalance, send.amount);
        NativeSendBatch.verify(send, batch, mine.getString("address"));
        requireNoPendingBatch(); requireLive(expected);
        String scopeNotice = fundedAddresses < totalAddresses
            ? "\n\nFunding is restricted to " + fundedAddresses + " of " + totalAddresses + " wallet addresses. Other addresses are not included." : "";
        String review = NativeSendBatch.review(send, batch, mine.getString("address")) + scopeNotice;
        long expires = android.os.SystemClock.elapsedRealtime() + 120000;
        getActivity().runOnUiThread(() -> show(call, "Confirm payment batch", panel(review), "Sign and send batch", () -> execute(call, stillExpected -> {
            final VaultSession signingSession;
            synchronized (lifecycle) {
                requireLive(expected); requireLive(stillExpected);
                if (dialogCall != call || session == null || hdWallet != wallet) throw new IllegalStateException("Payment batch cancelled. Unlock and review again.");
                signingSession = session;
            }
            NativeTransactions.FundingCheck signingCheck = () -> {
                synchronized (lifecycle) {
                    requireLive(expected); requireLive(stillExpected);
                    if (dialogCall != call || session != signingSession || signingSession.isLocked() || hdWallet != wallet) throw new IllegalStateException("Payment batch cancelled. Unlock and review again.");
                    if (android.os.SystemClock.elapsedRealtime() >= expires) throw new IllegalStateException("Payment review expired. Review a fresh payment.");
                }
            };
            signingCheck.check(); requireNoPendingBatch();
            MobilePaymentFunding.Session confirmed = paymentFunding.session(paymentReader(expected), signingCheck::check,
                (stage, completed, total, retryAfterMs) -> paymentProgress(call, expected, ownAddress, "reviewPayment", stage, completed, total, retryAfterMs));
            MobilePaymentPreparation.HdInventory beforeSigning = MobilePaymentPreparation.refresh(fresh, readReservations(), confirmed);
            beforeSigning.verifyBatch(plans, send.useAllBalance, send.amount);
            NativeSendBatch.verify(send, batch, mine.getString("address"));
            JSONArray signed = new JSONArray();
            for (int part = 0; part < plans.length(); part++) {
                signingCheck.check(); paymentProgress(call, expected, ownAddress, "reviewPayment", "signing", part, plans.length(), 0);
                signed.put(NativeTransactions.signPayment(plans.getJSONObject(part), signingSession, signingCheck));
            }
            signingCheck.check();
            if (NativeTransactions.amount(batch.getString("change")) > 0) {
                wallet.allocateChange(mine.getInt("index"), signingCheck::check); publishHd(wallet, expected);
            }
            submitPaymentBatch(call, expected, ownAddress, send, batch, signed, signingCheck);
        })));
    }
    private void submitPaymentBatch(PluginCall call, long expected, String ownAddress, NativeSendPolicy.Request send,
            JSONObject batch, JSONArray signed, NativeTransactions.FundingCheck check) throws Exception {
        check.check();
        synchronized (PAYMENT_STORAGE) {
            check.check();
            if (!BATCH_IN_FLIGHT.compareAndSet(false, true)) throw new IllegalStateException("A previous payment is still settling. Check it before sending again.");
        }
        boolean receiptMayExist = false;
        try {
            synchronized (lifecycle) { check.check(); broadcasting = true; }
            final int[] next = {0};
            MobilePaymentBatch.Store store = batchStore();
            receiptMayExist = true;
            JSONObject result = MobilePaymentBatch.submit(ownAddress, send.address, batch, signed, store, new MobilePaymentBatch.Sender() {
                @Override public JSONObject broadcast(String hex) throws Exception {
                    final java.util.concurrent.CompletableFuture<JSONObject> submission;
                    int part = next[0]++;
                    synchronized (lifecycle) {
                        try { check.check(); }
                        catch (Exception cancelled) { throw new BatchNotSent(cancelled); }
                        submission = runtime.rpc.broadcast(hex);
                    }
                    paymentProgress(call, expected, ownAddress, "reviewPayment", "broadcasting", part, signed.length(), 0);
                    // A lifecycle cancellation can retract only a proven queued
                    // request. Once written, retain its actual/unknown outcome.
                    JSONObject response = MobileRpcAwait.broadcast(submission, check::check, runtime.rpc::cancelBeforeWrite);
                    paymentProgress(call, expected, ownAddress, "reviewPayment", "broadcasting", part + 1, signed.length(), 0);
                    return response;
                }
                @Override public boolean provenNotSent(Exception error) {
                    return error instanceof BatchNotSent || error instanceof MobileRpcClient.RpcFailure
                        && !((MobileRpcClient.RpcFailure)error).unknownOutcome
                        && "RPC_CANCELLED".equals(((MobileRpcClient.RpcFailure)error).code);
                }
            }, check::check);
            completeBatchPayment(call, result);
        } catch (Exception error) {
            // Never collapse a persisted partial/unknown batch into a generic
            // send failure. The durable receipt remains the source of truth.
            JSONObject saved = receiptMayExist ? readBatchReceipt() : null;
            if (saved != null && !saved.optBoolean("acknowledged", false)) completeBatchPayment(call, MobilePaymentBatch.summary(saved));
            else throw error;
        } finally {
            synchronized (lifecycle) { broadcasting = false; }
            BATCH_IN_FLIGHT.set(false);
        }
    }
    private static final class BatchNotSent extends Exception {
        private static final long serialVersionUID = 1L;
        BatchNotSent(Exception cause) { super("Payment part was cancelled before queueing.", cause); }
    }
    private void completeBatchPayment(PluginCall call, JSONObject result) throws Exception {
        synchronized (lifecycle) {
            broadcasting = false;
            if (dialogCall != call) return;
            dialogCall = null; busy.set(false);
        }
        call.resolve(new JSObject(result.toString()));
    }
    private JSONObject readBatchReceipt() throws Exception {
        synchronized (PAYMENT_STORAGE) {
            AtomicFile receipt = new AtomicFile(new File(getContext().getNoBackupFilesDir(), BATCH_RECEIPT_FILE));
            if (!stored(receipt)) return null;
            try (InputStream input = receipt.openRead()) { return MobilePaymentBatch.read(input); }
        }
    }
    private void requireNoPendingBatch() throws Exception {
        synchronized (PAYMENT_STORAGE) {
            if (BATCH_IN_FLIGHT.get()) throw new IllegalStateException("A previous payment is still settling. Check its result before sending again.");
            JSONObject previous = readBatchReceiptAndReconcile();
            if (previous != null && !previous.optBoolean("acknowledged", false)) throw new IllegalStateException("Check and close the previous payment batch result in Send before creating another payment.");
        }
    }
    private JSONObject readBatchReceiptAndReconcile() throws Exception {
        synchronized (PAYMENT_STORAGE) {
            JSONObject saved = readBatchReceipt();
            // A crash can leave reservations for parts whose durable state is
            // still not-sent. Only the idle journal proves they were not written:
            // during submission those same parts may be about to be sent.
            // Acquiring a submission gate also holds PAYMENT_STORAGE, so it
            // cannot race this recovery. No RPC request or retry is performed.
            if (saved != null && !BATCH_IN_FLIGHT.get()) {
                JSONObject held = readReservations();
                JSONObject recovered = MobilePaymentBatch.reconcileNotSent(saved, held);
                if (recovered.length() != held.length()) writeVerifiedPublicFile("payment-reservations-v1.json", recovered);
            }
            return saved;
        }
    }
    private MobilePaymentBatch.Store batchStore() {
        return new MobilePaymentBatch.Store() {
            @Override public JSONObject receipt() throws Exception { return readBatchReceipt(); }
            @Override public JSONObject reservations() throws Exception { synchronized (PAYMENT_STORAGE) { return readReservations(); } }
            @Override public void receipt(JSONObject value) throws Exception {
                MobilePaymentBatch.validate(value);
                synchronized (PAYMENT_STORAGE) { writeVerifiedPublicFile(BATCH_RECEIPT_FILE, value); }
            }
            @Override public void reservations(JSONObject value) throws Exception {
                NativePaymentReservations.validate(value);
                synchronized (PAYMENT_STORAGE) { writeVerifiedPublicFile("payment-reservations-v1.json", value); }
            }
        };
    }
    private void writeVerifiedPublicFile(String name, JSONObject value) throws Exception {
        // Native fixed filenames only. Detect AtomicFile.finishWrite failures
        // before treating either receipt or reservations as durable.
        byte[] expected = value.toString().getBytes(StandardCharsets.UTF_8);
        writePublicFile(name, value);
        AtomicFile saved = new AtomicFile(new File(getContext().getNoBackupFilesDir(), name));
        if (!Arrays.equals(expected, saved.readFully())) throw new java.io.IOException("Payment batch storage could not be verified. Do not retry the payment blindly.");
    }
    @PluginMethod public void getPaymentBatch(PluginCall call) {
        if (!empty(call)) return;
        try { BATCH_RECEIPT_IO.execute(() -> {
            try {
                JSONObject saved = readBatchReceiptAndReconcile();
                call.resolve(new JSObject().put("batch", saved == null || saved.optBoolean("acknowledged", false) ? JSONObject.NULL : MobilePaymentBatch.summary(saved)));
            } catch (Exception error) { call.reject("Could not read the saved payment batch. Do not repeat the payment blindly.", "BATCH_STORAGE"); }
        }); } catch (java.util.concurrent.RejectedExecutionException busyReceipt) { call.reject("Payment receipt is busy. Try again shortly.", "BUSY"); }
    }
    @PluginMethod public void dismissPaymentBatch(PluginCall call) {
        String id = call.getString("batchId");
        if (call.getData().length() != 1 || id == null) { call.reject("Invalid payment batch acknowledgment.", "INVALID"); return; }
        synchronized (lifecycle) {
            if (!active || destroyed || busy.get() || BATCH_IN_FLIGHT.get()) { call.reject("Wait for the active wallet operation to finish.", "BUSY"); return; }
        }
        try { BATCH_RECEIPT_IO.execute(() -> {
            try {
                synchronized (PAYMENT_STORAGE) {
                    synchronized (lifecycle) {
                        if (!active || destroyed || busy.get() || BATCH_IN_FLIGHT.get()) throw new IllegalStateException("Wait for the active wallet operation to finish.");
                    }
                    // This acknowledges only public history. Parsing/fsync of
                    // a large receipt must not hold the UI's lifecycle lock.
                    // PAYMENT_STORAGE still excludes new submission gates.
                    JSONObject saved = readBatchReceipt();
                    writeVerifiedPublicFile(BATCH_RECEIPT_FILE, MobilePaymentBatch.acknowledge(saved, id));
                }
                call.resolve(new JSObject().put("dismissed", true).put("batchId", id));
            } catch (Exception error) { call.reject("Could not acknowledge this payment batch. Check its transactions before sending again.", "BATCH_STORAGE"); }
        }); } catch (java.util.concurrent.RejectedExecutionException busyReceipt) { call.reject("Payment receipt is busy. Try again shortly.", "BUSY"); }
    }
    private NativeP2CPolicy.Request probeBounty(PluginCall call, NativeP2CPolicy.Request bounty, long expected) throws Exception {
        MobileRsaProbe.Attempt probe = rsaProber.prepare(bounty.domain, System.currentTimeMillis() / 1000);
        synchronized (lifecycle) {
            requireLive(expected);
            if (dialogCall != call || session == null) throw new IllegalStateException("P2C review cancelled. Review again.");
            pendingRsaProbe = probe;
        }
        try {
            String status;
            try { status = probe.await(); }
            catch (java.util.concurrent.CancellationException cancelled) { throw new IllegalStateException("P2C review cancelled. Review again."); }
            synchronized (lifecycle) {
                requireLive(expected);
                if (dialogCall != call || session == null) throw new IllegalStateException("P2C review cancelled. Review again.");
                return bounty.withProbe(status);
            }
        } finally {
            synchronized (lifecycle) { if (pendingRsaProbe == probe) pendingRsaProbe = null; }
        }
    }
    private MobilePaymentFunding.Reader paymentReader(long expected) {
        return new MobilePaymentFunding.Reader() {
            public JSONObject read(String method, JSONObject params) throws Exception {
                return readRpc(method, params, expected, () -> requireLive(expected));
            }
            @Override public JSONObject read(String method, JSONObject params, MobilePaymentFunding.Check check) throws Exception {
                return readRpc(method, params, expected, check);
            }
        };
    }
    private JSONObject readRpc(String method, JSONObject params, long expected, MobilePaymentFunding.Check check) throws Exception {
        requireLive(expected); java.util.concurrent.CompletableFuture<JSONObject> future = runtime.rpc.call(method, params);
        // Keep the shared preparation/review budget live during quota waiting,
        // instead of timing out a healthy paced request after 45 wall seconds.
        return MobileRpcAwait.read(future, () -> { requireLive(expected); check.check(); });
    }
    private void checkPaymentPreparation(PluginCall call, long expected) {
        synchronized (lifecycle) {
            requireLive(expected);
            if (dialogCall != call || session == null) throw new IllegalStateException("Payment preparation cancelled. Unlock and review again.");
        }
    }
    private void paymentProgress(PluginCall call, long expected, String address, String operation,
                                 String stage, int completed, int total, long retryAfterMs) {
        subscriptionHandler.post(() -> {
            synchronized (lifecycle) {
                if (!active || destroyed || generation != expected || dialogCall != call) return;
                notifyListeners("paymentPreparation", new JSObject().put("address", address).put("operation", operation)
                    .put("stage", stage).put("completed", completed).put("total", total).put("retryAfterMs", retryAfterMs), false);
            }
        });
    }
    private void completePayment(PluginCall call, JSObject result) {
        synchronized (lifecycle) {
            broadcasting = false;
            try { lastPayment = new JSONObject().put("txid", result.optString("txid")).put("status", result.optString("status")); }
            catch (org.json.JSONException ignored) { }
            if (dialogCall != call) return; dialogCall = null; busy.set(false);
        }
        call.resolve(result);
    }
    private void writePublicFile(String name, JSONObject value) throws Exception {
        AtomicFile target = new AtomicFile(new File(getContext().getNoBackupFilesDir(), name)); FileOutputStream stream = null;
        try { stream = target.startWrite(); stream.write(value.toString().getBytes(StandardCharsets.UTF_8)); stream.getFD().sync(); target.finishWrite(stream); }
        catch (Exception error) { if (stream != null) target.failWrite(stream); throw error; }
    }
    private JSONObject readReservations() throws Exception {
        AtomicFile target = new AtomicFile(new File(getContext().getNoBackupFilesDir(), "payment-reservations-v1.json"));
        if (!stored(target)) return new JSONObject();
        try (InputStream input = target.openRead()) { return NativePaymentReservations.read(input); }
    }
    @PluginMethod public void queryPublic(PluginCall call) {
        String method = call.getString("method"); JSONObject params = call.getObject("params");
        if (!active || destroyed || call.getData().length() != 2 || params == null ||
            !("getchaintip".equals(method) || "getaddressbalance".equals(method) || "getaddresshistory".equals(method)
                || "getaddressutxos".equals(method) || "getaddresschanges".equals(method))) {
            call.reject("Unsupported public query or inactive application.", "RPC_INVALID"); return;
        }
        final long expected;
        final String own;
        final java.util.concurrent.CompletableFuture<JSONObject> request;
        synchronized (lifecycle) {
            if (!active || destroyed) { call.reject("Request cancelled.", "RPC_CANCELLED"); return; }
            try { own = NativeAccountPolicy.requireQuery(ownedAccounts(), walletId(), method, params); }
            catch (IllegalArgumentException | IllegalStateException error) { call.reject(error.getMessage(), "RPC_ACCOUNT"); return; }
            expected = generation;
            request = runtime.rpc.call(method, params);
        }
        // A network callback can cancel this future while holding the runtime
        // monitor. Never acquire lifecycle inline from that callback: native
        // confirmation holds lifecycle while atomically starting the runtime.
        request.whenCompleteAsync((result, error) -> {
            boolean accepted = false;
            synchronized (lifecycle) {
                if (!active || destroyed || expected != generation || !java.util.Objects.equals(walletId(), own)) call.reject("Request cancelled.", "RPC_CANCELLED");
                else if (error != null) call.reject("The RPC query could not be completed. Please try again.", NativeWalletErrors.publicReadCode(error));
                else { call.resolve(new JSObject().put("result", result)); accepted = true; }
            }
            if (accepted) observeHdResponse(method, params, result, expected);
        });
    }
    @PluginMethod public void claimsState(PluginCall call) {
        if (empty(call)) call.resolve(new JSObject().put("state", runtime.snapshot()));
    }
    @PluginMethod public void claimsPolicy(PluginCall call) {
        JSONObject data = call.getData();
        if (!active || data.length() != 2 || !(data.opt("allowMobileData") instanceof Boolean) || !(data.opt("allowBackground") instanceof Boolean)) {
            call.reject("Invalid claims preferences.", "INVALID"); return;
        }
        try { runtime.policy(data.getBoolean("allowMobileData"), data.getBoolean("allowBackground")); call.resolve(new JSObject().put("state", runtime.snapshot())); }
        catch (Exception error) { call.reject("Could not change claims preferences.", "CLAIMS_ERROR"); }
    }
    @PluginMethod public void claimsLimits(PluginCall call) {
        final ClaimsLimits limits;
        try { limits = ClaimsLimits.parse(call.getData()); }
        catch (IllegalArgumentException invalid) { call.reject("Enter whole numbers from 1 to 100 for both limits.", "INVALID"); return; }
        synchronized (lifecycle) {
            if (!active || destroyed) { call.reject("Open the app to change claims limits.", "INVALID"); return; }
            try { runtime.limits(limits); call.resolve(new JSObject().put("state", runtime.snapshot())); }
            catch (Exception error) { call.reject("Could not save claims limits. Try again.", "CLAIMS_ERROR"); }
        }
    }
    @PluginMethod public void claimsStart(PluginCall call) {
        final String reward;
        final long expected;
        synchronized (lifecycle) {
            try {
                if (call.getData().length() != 1) throw new IllegalArgumentException();
                reward = NativeAccountPolicy.requireReward(ownedAccounts(), call.getData().opt("address"));
                WalletCrypto.decodeAddress(reward);
            } catch (Exception error) { call.reject("Claims rewards must use your native wallet address. Create or unlock it first.", "INVALID"); return; }
            if (!begin(call)) return;
            expected = generation;
        }
        getActivity().runOnUiThread(() -> show(call, "Start Automatic Claims?", panel("Rewards go to:\n" + reward +
            "\n\nClaims use battery and network data. Only Wi-Fi/unmetered access is allowed by default. Background use is optional and requires Android's ongoing service indication with a Stop button. It does not request extra notification permission. Your wallet may remain locked. The system may pause or end the workload."), "Start", () -> {
                try {
                    synchronized (lifecycle) {
                        requireLive(expected);
                        NativeAccountPolicy.requireReward(ownedAccounts(), reward);
                        runtime.start(reward);
                    }
                    finish(call, null);
                }
                catch (Exception error) { finish(call, error); }
            }));
    }
    @PluginMethod public void claimsStop(PluginCall call) {
        if (empty(call)) { runtime.stop(); call.resolve(new JSObject().put("state", runtime.snapshot())); }
    }
    @PluginMethod public void claimsCheckSubmission(PluginCall call) {
        if (!empty(call)) return;
        try { runtime.checkSubmission().whenComplete((state, error) -> {
            if (error == null) call.resolve(new JSObject().put("state", state));
            else call.reject("Could not confirm the previous submission. Claims remain paused; do not retry the transaction blindly.", "CLAIMS_CHECK_REQUIRED");
        }); } catch (Exception error) { call.reject(safeMessage(error), "CLAIMS_CHECK_REQUIRED"); }
    }
    @Override protected void handleOnResume() { active = true; runtime.foreground(true); refreshSubscriptions(); resumeReplacementBackup(); resumeWalletFileImport(); }
    @Override protected void handleOnPause() {
        final boolean keepSetupDraft;
        synchronized (lifecycle) {
            active = false;
            keepSetupDraft = setupDraft && dialogCall != null && (backupPickerPending || backupDestination != null
                || importPickerPending || importSource != null || dialog != null && dialog.isShowing());
            lockNow();
        }
        refreshSubscriptions();
        runtime.foreground(false);
        // Keep the same native views, phrase, inputs and scroll position when
        // switching apps. Payment/unlock work still cancels and the vault locks.
        if (!keepSetupDraft) interruptPending();
    }
    @Override protected void handleOnDestroy() {
        destroyed = true; active = false; lockNow(); interruptPending();
        refreshSubscriptions();
        if (walletConnectivity != null && walletNetworkCallback != null) walletConnectivity.unregisterNetworkCallback(walletNetworkCallback);
        subscriptionHandler.removeCallbacks(subscriptionRefresh);
        subscriptionHandler.removeCallbacks(walletEventDelivery);
        if (subscriptions != null) subscriptions.close();
        runtime.foreground(false); worker.shutdownNow(); recoveryWorker.shutdownNow();
    }
}
