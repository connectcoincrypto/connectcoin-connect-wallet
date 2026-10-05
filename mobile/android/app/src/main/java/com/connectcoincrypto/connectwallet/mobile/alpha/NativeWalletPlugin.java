package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.app.AlertDialog;
import android.content.Context;
import android.text.InputType;
import android.util.AtomicFile;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.*;
import java.io.File;
import java.io.FileOutputStream;
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
    private final AtomicBoolean busy = new AtomicBoolean();
    private final Object lifecycle = new Object();
    private volatile boolean active, destroyed;
    private volatile long generation;
    private VaultSession session;
    private JSONObject account;
    private AtomicFile file;
    private AlertDialog dialog;
    private PluginCall dialogCall;
    private volatile boolean broadcasting;
    private volatile JSONObject lastPayment;
    private MobileRuntime runtime;

    @Override public void load() {
        file = new AtomicFile(new File(getContext().getNoBackupFilesDir(), "mobile-wallet-v1.json"));
        runtime = MobileRuntime.get(getContext());
        try {
            AtomicFile receipt = new AtomicFile(new File(getContext().getNoBackupFilesDir(), "last-payment-public.json"));
            if (stored(receipt) && receipt.getBaseFile().length() <= 2_000_000) {
                JSONObject saved = new JSONObject(new String(receipt.readFully(), StandardCharsets.UTF_8));
                String txid = saved.optString("txid", "");
                if (txid.matches("[0-9a-f]{64}")) lastPayment = new JSONObject().put("txid", txid).put("status", "check-required");
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
                .put("account", account == null ? JSONObject.NULL : account).put("accountScope", "first-receive-address")
                .put("lastPayment", lastPayment == null ? JSONObject.NULL : lastPayment)
                .put("rpcTransport", "tls").put("rpcEndpoint", "connectcoin4.com:48191");
        }
    }
    @PluginMethod public void getState(PluginCall call) { if (empty(call)) call.resolve(state()); }
    @PluginMethod public void lock(PluginCall call) { if (empty(call)) { lockNow(); interruptPending(); call.resolve(state()); } }
    private void lockNow() {
        synchronized (lifecycle) { generation++; if (session != null) session.close(); session = null; }
    }
    private static boolean stored(AtomicFile target) {
        File base = target.getBaseFile();
        return base.exists() || new File(base.getPath() + ".bak").exists() || new File(base.getPath() + ".new").exists();
    }
    private void interruptPending() {
        synchronized (lifecycle) {
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
            dialogCall = call; return true;
        }
    }
    private void finish(PluginCall call, Exception error) {
        synchronized (lifecycle) {
            if (dialogCall != call) return; // Cancellation/late completions must never finish a newer operation.
            busy.set(false); dialogCall = null;
            char[] secret = pendingPassword; pendingPassword = null; if (secret != null) Arrays.fill(secret, '\0');
        }
        if (error == null) call.resolve(state());
        else call.reject(safeMessage(error), "WALLET_ERROR");
    }
    private static String safeMessage(Exception error) {
        if (error instanceof IllegalArgumentException || error instanceof IllegalStateException) return error.getMessage();
        return "The operation could not complete. Check connectivity and unlock again if needed.";
    }
    private void requireLive(long expected) {
        if (!active || destroyed || generation != expected) throw new IllegalStateException("Wallet operation interrupted. Open and unlock the wallet again.");
    }
    private void execute(PluginCall call, Work work) {
        long expected = generation;
        try { worker.execute(() -> {
            try { requireLive(expected); synchronized (lifecycle) { if (dialogCall != call) throw new IllegalStateException("Wallet operation cancelled."); } work.run(expected); }
            catch (Exception error) { finish(call, error); }
        }); } catch (java.util.concurrent.RejectedExecutionException error) { finish(call, new IllegalStateException("Wallet is busy.")); }
    }
    private interface Work { void run(long expected) throws Exception; }
    private EditText field(String hint, boolean secret, boolean words) {
        EditText view = new EditText(getActivity()); view.setHint(hint);
        view.setInputType(secret ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | (words ? InputType.TYPE_TEXT_FLAG_MULTI_LINE : 0));
        view.setSaveEnabled(false); view.setLongClickable(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            view.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
            view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
        view.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(words ? 1024 : 1024)});
        return view;
    }
    private LinearLayout panel(String message, View... fields) {
        LinearLayout layout = new LinearLayout(getActivity()); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32, 16, 32, 16);
        TextView text = new TextView(getActivity()); text.setText(message); layout.addView(text);
        for (View field : fields) layout.addView(field); return layout;
    }
    private void show(PluginCall call, String title, View view, String action, Runnable accept) {
        getActivity().runOnUiThread(() -> {
            if (!active || destroyed || dialogCall != call) { clearFields((android.view.ViewGroup)view); finish(call, new IllegalStateException("Wallet is not in the foreground.")); return; }
            ScrollView scroll = new ScrollView(getActivity()); scroll.addView(view);
            dialog = new AlertDialog.Builder(getActivity()).setTitle(title).setView(scroll)
                .setNegativeButton("Cancel", (which, button) -> finish(call, new IllegalStateException("Cancelled.")))
                .setPositiveButton(action, (which, button) -> {
                    if (!active || destroyed || dialogCall != call) { finish(call, new IllegalStateException("Wallet operation cancelled.")); return; }
                    try { accept.run(); } catch (Exception error) { finish(call, error); }
                }).create();
            dialog.setOnCancelListener(which -> finish(call, new IllegalStateException("Cancelled.")));
            dialog.setOnDismissListener(which -> { if (view instanceof android.view.ViewGroup) clearFields((android.view.ViewGroup) view); });
            dialog.setCanceledOnTouchOutside(false);
            if (dialog.getWindow() != null) dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            dialog.show();
            dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
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
    private void setup(PluginCall call, boolean importing) {
        if (!empty(call) || !begin(call)) return;
        if (stored(file)) { finish(call, new IllegalStateException("A wallet already exists. This alpha never overwrites it.")); return; }
        getActivity().runOnUiThread(() -> {
            EditText phrase = field("Recovery words", false, true), passphrase = field("BIP39 passphrase (optional)", true, false);
            EditText password = field("New password (at least 12 characters)", true, false), confirm = field("Repeat password", true, false);
            LinearLayout form = panel("Use a trusted keyboard. Recovery words never enter the web interface. This development alpha currently displays/spends only address m/44'/0'/0'/0/0; it is not a complete HD recovery tool. Do not use your primary funded wallet.", passphrase, password, confirm);
            if (importing) form.addView(phrase, 1);
            show(call, importing ? "Import recovery phrase" : "Create wallet", form, "Continue", () -> {
                String mnemonic = importing ? phrase.getText().toString() : WalletCrypto.generateMnemonic(24);
                String extra = passphrase.getText().toString(); char[] secret = password.getText().toString().toCharArray();
                char[] repeated = confirm.getText().toString().toCharArray(); boolean samePassword;
                try { samePassword = Arrays.equals(secret, repeated); } finally { Arrays.fill(repeated, '\0'); }
                if (!samePassword) { Arrays.fill(secret, '\0'); finish(call, new IllegalArgumentException("Passwords do not match.")); return; }
                try { WalletVault.validatePassword(secret); if (!WalletCrypto.validateMnemonic(mnemonic)) throw new IllegalArgumentException("Invalid recovery phrase."); }
                catch (Exception error) { Arrays.fill(secret, '\0'); finish(call, error); return; }
                if (importing) saveWallet(call, mnemonic, extra, secret);
                else backupCheck(call, mnemonic, extra, secret);
            });
        });
    }
    private void backupCheck(PluginCall call, String mnemonic, String extra, char[] secret) {
        pendingPassword = secret;
        String[] words = mnemonic.split(" ");
        EditText first = field("Word 3", false, false), second = field("Word 12", false, false), third = field("Word 23", false, false);
        // The phrase is a native TextView, never clipboard/HTML/JavaScript.
        show(call, "Write down your recovery phrase", panel("Write the words in order on paper. Losing these words and your password can permanently lose funds.\n\n" + mnemonic + "\n\nConfirm words 3, 12 and 23 below.", first, second, third), "Create encrypted wallet", () -> {
            if (!words[2].equals(first.getText().toString().trim()) || !words[11].equals(second.getText().toString().trim()) || !words[22].equals(third.getText().toString().trim())) {
                Arrays.fill(secret, '\0'); finish(call, new IllegalArgumentException("Recovery words did not match. Create a new wallet to try again.")); return;
            }
            saveWallet(call, mnemonic, extra, secret);
        });
        // Cancel/on-pause cleanup also clears the captured password below.
    }
    private volatile char[] pendingPassword;
    private void saveWallet(PluginCall call, String mnemonic, String extra, char[] secret) {
        pendingPassword = secret;
        execute(call, expected -> {
            VaultSession unlocked = null;
            try {
                if (Runtime.getRuntime().maxMemory() < 256L * 1024 * 1024) throw new IllegalStateException("This device cannot allocate the desktop-compatible wallet KDF safely.");
                JSONObject payload = WalletVault.newPayload("ConnectWallet mobile", mnemonic, extra);
                byte[] encoded = WalletVault.serialize(WalletVault.encrypt(payload, secret)).getBytes(StandardCharsets.UTF_8);
                unlocked = new VaultSession(mnemonic, extra);
                synchronized (lifecycle) {
                    requireLive(expected);
                    if (stored(file)) throw new IllegalStateException("Wallet already exists.");
                    FileOutputStream stream = null;
                    try { stream = file.startWrite(); stream.write(encoded); stream.getFD().sync(); file.finishWrite(stream); }
                    catch (Exception error) { if (stream != null) file.failWrite(stream); throw error; }
                    account = unlocked.publicAccount(0, 0); session = unlocked; unlocked = null;
                }
                finish(call, null);
            } finally { if (unlocked != null) unlocked.close(); Arrays.fill(secret, '\0'); if (pendingPassword == secret) pendingPassword = null; }
        });
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
                    try {
                        if (file.getBaseFile().length() > WalletVault.MAX_FILE_BYTES) throw new IllegalArgumentException("Wallet file is too large.");
                        JSONObject payload = WalletVault.decrypt(WalletVault.parse(new String(file.readFully(), StandardCharsets.UTF_8)), secret);
                        unlocked = new VaultSession(payload.getString("mnemonic"), payload.optString("passphrase", ""));
                        synchronized (lifecycle) { requireLive(expected); if (session != null) session.close(); account = unlocked.publicAccount(0, 0); session = unlocked; unlocked = null; }
                        finish(call, null);
                    } finally { if (unlocked != null) unlocked.close(); Arrays.fill(secret, '\0'); if (pendingPassword == secret) pendingPassword = null; }
                });
            });
        });
    }
    @PluginMethod public void reviewPayment(PluginCall call) {
        JSONObject input = call.getData();
        if (input.length() != 2 || !(input.opt("address") instanceof String) || !(input.opt("amount") instanceof String)) { call.reject("Enter one address and a decimal CONN amount.", "INVALID"); return; }
        final JSONObject destination;
        try { destination = new JSONObject().put("address", WalletCrypto.encodeAddress(WalletCrypto.decodeAddress(input.getString("address"))))
                .put("amount", Long.toString(NativeTransactions.coinAmount(input.getString("amount")))); NativeTransactions.recipient(destination); }
        catch (Exception error) { call.reject("Invalid mainnet address or amount.", "INVALID"); return; }
        if (!begin(call)) return;
        execute(call, expected -> {
            JSONObject mine;
            synchronized (lifecycle) { requireLive(expected); if (session == null) throw new IllegalStateException("Unlock the wallet first."); mine = session.publicAccount(0, 0); }
            JSONObject tip = NativePaymentChecks.tip(readRpc("getchaintip", new JSONObject(), expected));
            JSONObject reservations = readReservations();
            JSONArray candidates = new JSONArray(), pendingCandidates = new JSONArray(); String cursor = null;
            HashSet<String> cursors = new HashSet<>(), outpoints = new HashSet<>(); int rowCount = 0;
            do {
                JSONObject params = new JSONObject().put("address", mine.getString("address")).put("include_pending_spent", true);
                if (cursor != null) params.put("cursor", cursor);
                JSONObject page = readRpc("getaddressutxos", params, expected);
                JSONArray list = NativePaymentChecks.utxos(page, mine.getString("address"), tip);
                rowCount += list.length(); if (rowCount > 5000) throw new IllegalStateException("Too many outputs for this mobile alpha.");
                for (int i = 0; i < list.length(); i++) {
                    JSONObject u = list.getJSONObject(i); String key = u.getString("txid") + ":" + u.getLong("vout");
                    if (!outpoints.add(key)) throw new IllegalStateException("Duplicate output across RPC pages. Refresh again.");
                    if (!u.getBoolean("mature") || !"confirmed".equals(u.getString("status"))) continue;
                    if (candidates.length() + pendingCandidates.length() >= 256) throw new IllegalStateException("This alpha supports at most 256 spendable outputs. Use desktop for this account.");
                    JSONObject candidate = new JSONObject(u.toString()).put("index", 0).put("change", 0);
                    if (u.isNull("pending_spent_by") && reservations.has(key)) candidate.put("pending_spent_by", reservations.getString(key));
                    (candidate.isNull("pending_spent_by") ? candidates : pendingCandidates).put(candidate);
                }
                cursor = NativePaymentChecks.cursor(page);
                if (cursor != null && (!cursors.add(cursor) || cursors.size() > 10)) throw new IllegalStateException("Invalid or oversized UTXO pagination.");
            } while (cursor != null);
            // Select by exact amounts first; authenticate only the required parents.
            JSONObject selectedPlan;
            try { selectedPlan = NativeTransactions.planPayment(candidates, new JSONArray().put(destination), mine.getString("address"), 1500, false); }
            catch (IllegalArgumentException insufficient) {
                if (pendingCandidates.length() == 0 || candidates.length() != 0 && !"Insufficient funds for payment and fee.".equals(insufficient.getMessage())) throw insufficient;
                for (int i = 0; i < pendingCandidates.length(); i++) candidates.put(pendingCandidates.getJSONObject(i));
                selectedPlan = NativeTransactions.planPayment(candidates, new JSONArray().put(destination), mine.getString("address"), 1500, false);
            }
            final JSONObject plan = selectedPlan;
            JSONArray selected = plan.getJSONArray("selected"); java.util.Map<String, String> parents = new java.util.HashMap<>(); long parentHexBytes = 0;
            for (int offset = 0; offset < selected.length(); offset += 32) {
                JSONArray ids = new JSONArray(); HashSet<String> requested = new HashSet<>();
                for (int i = offset; i < Math.min(offset + 32, selected.length()); i++) { String id = selected.getJSONObject(i).getString("txid"); if (!parents.containsKey(id) && requested.add(id)) ids.put(id); }
                if (ids.length() == 0) continue;
                int pages = 0;
                while (ids.length() > 0) {
                    if (++pages > 32) throw new IllegalStateException("Funding batch did not complete.");
                    JSONObject response = readRpc("gettransactions", new JSONObject().put("txids", ids), expected);
                    JSONArray transactions = NativePaymentChecks.transactions(response, ids, tip);
                    for (int i = 0; i < transactions.length(); i++) {
                        JSONObject tx = transactions.getJSONObject(i); parentHexBytes += tx.getString("hex").length();
                        if (parentHexBytes > 16L * 1024 * 1024) throw new IllegalStateException("Funding data exceeds the mobile memory limit. Use desktop for this payment.");
                        parents.put(tx.getString("txid"), tx.getString("hex"));
                    }
                    ids = response.getJSONArray("remaining");
                }
            }
            for (int i = 0; i < selected.length(); i++) { JSONObject item = selected.getJSONObject(i); String raw = parents.get(item.getString("txid")); if (raw == null) throw new IllegalStateException("Missing funding transaction."); item.put("rawTransaction", raw); NativeTransactions.verifyFunding(item, mine.getString("publicKey")); }
            requireLive(expected);
            HashSet<String> replacing = new HashSet<>();
            for (int i = 0; i < selected.length(); i++) if (!selected.getJSONObject(i).isNull("pending_spent_by")) replacing.add(selected.getJSONObject(i).getString("pending_spent_by"));
            final boolean replacesPending = !replacing.isEmpty();
            String warning = replacesPending ? "\n\nThis payment spends coins reserved by these pending or previously submitted transactions:\n" + android.text.TextUtils.join("\n", replacing) + "\nTheir outcome may be unknown. Check them first. Explicitly allow a replacement below to proceed. The node may still reject it." : "";
            String review = "MAINNET\n\nTo: " + destination.getString("address") + "\nAmount: " + NativeTransactions.format(NativeTransactions.amount(destination.getString("amount"))) + " CONN\nMining fee: " + NativeTransactions.format(NativeTransactions.amount(plan.getString("fee"))) + " CONN\nChange returns to your first address." + warning;
            long expires = android.os.SystemClock.elapsedRealtime() + 120000;
            getActivity().runOnUiThread(() -> {
                android.widget.CheckBox allowReplacement = new android.widget.CheckBox(getActivity());
                allowReplacement.setText("Allow replacing pending payments"); allowReplacement.setChecked(false);
                show(call, "Confirm payment", replacesPending ? panel(review, allowReplacement) : panel(review), "Sign and send", () -> {
                    if (replacesPending && !allowReplacement.isChecked()) { finish(call, new IllegalStateException("Replacement was not authorized. Check the previous transaction before retrying.")); return; }
                    execute(call, stillExpected -> {
                JSONObject signed;
                synchronized (lifecycle) { requireLive(expected); requireLive(stillExpected); if (android.os.SystemClock.elapsedRealtime() >= expires) throw new IllegalStateException("Payment review expired. Review a fresh payment."); if (session == null) throw new IllegalStateException("Wallet is locked."); signed = NativeTransactions.signPayment(plan, session); }
                // Persist the PUBLIC signed transaction before the write. It allows
                // inspection after any indeterminate broadcast, never an auto retry.
                java.util.concurrent.CompletableFuture<JSONObject> submission;
                synchronized (lifecycle) {
                    requireLive(expected);
                    JSONObject held = readReservations();
                    for (int i = 0; i < selected.length(); i++) { JSONObject row = selected.getJSONObject(i); held.put(row.getString("txid") + ":" + row.getLong("vout"), signed.getString("txid")); }
                    if (held.length() > 1000) throw new IllegalStateException("Mobile reservation limit reached. Review prior transactions in desktop.");
                    writePublicFile("payment-reservations-v1.json", held);
                    writePublicFile("last-payment-public.json", signed);
                    lastPayment = new JSONObject().put("txid", signed.getString("txid")).put("status", "check-required");
                    broadcasting = true; submission = runtime.rpc.broadcast(signed.getString("hex"));
                }
                try {
                    JSONObject sent = submission.get(45, TimeUnit.SECONDS);
                    if (!signed.getString("txid").equals(sent.optString("txid"))) throw new IllegalStateException("Unexpected broadcast response; check the transaction ID before retrying.");
                    completePayment(call, new JSObject().put("txid", signed.getString("txid")).put("status", "submitted"));
                } catch (Exception error) {
                    submission.cancel(true);
                    completePayment(call, new JSObject().put("txid", signed.getString("txid")).put("status", "check-required").put("message", "Check this transaction ID before attempting another payment. The previous outcome may be unknown."));
                }
                    });
                });
            });
        });
    }
    private JSONObject readRpc(String method, JSONObject params, long expected) throws Exception {
        requireLive(expected); java.util.concurrent.CompletableFuture<JSONObject> future = runtime.rpc.call(method, params);
        try { JSONObject result = future.get(45, TimeUnit.SECONDS); requireLive(expected); return result; }
        finally { if (!future.isDone()) future.cancel(true); }
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
        if (target.getBaseFile().length() > 200000) throw new IllegalStateException("Payment reservations are oversized. Inspect the wallet in desktop.");
        JSONObject held = new JSONObject(new String(target.readFully(), StandardCharsets.UTF_8));
        if (held.length() > 1000) throw new IllegalStateException("Too many pending payment reservations.");
        java.util.Iterator<String> keys = held.keys();
        while (keys.hasNext()) { String key = keys.next(); Object txid = held.get(key); if (!key.matches("[0-9a-f]{64}:(0|[1-9][0-9]{0,9})") || Long.parseLong(key.substring(65)) > 0xffffffffL || !(txid instanceof String) || !((String)txid).matches("[0-9a-f]{64}")) throw new IllegalStateException("Invalid payment reservations. Do not retry an earlier payment blindly."); }
        return held;
    }
    @PluginMethod public void queryPublic(PluginCall call) {
        String method = call.getString("method"); JSONObject params = call.getObject("params");
        if (!active || call.getData().length() != 2 || params == null ||
            !("getchaintip".equals(method) || "getaddressbalance".equals(method) || "getaddresshistory".equals(method))) {
            call.reject("Unsupported public query or inactive application.", "RPC_INVALID"); return;
        }
        long expected = generation;
        runtime.rpc.call(method, params).whenComplete((result, error) -> {
            if (!active || expected != generation) call.reject("Request cancelled.", "RPC_CANCELLED");
            else if (error != null) call.reject("Authenticated RPC is unavailable. No unencrypted fallback is used.", "RPC_UNAVAILABLE");
            else call.resolve(new JSObject().put("result", result));
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
    @PluginMethod public void claimsStart(PluginCall call) {
        String reward = call.getString("address");
        try { if (call.getData().length() != 1) throw new IllegalArgumentException(); WalletCrypto.decodeAddress(reward); }
        catch (Exception error) { call.reject("A valid mainnet reward address is required.", "INVALID"); return; }
        if (!begin(call)) return;
        getActivity().runOnUiThread(() -> show(call, "Start Automatic Claims?", panel("Rewards go to:\n" + reward +
            "\n\nClaims use battery and network data. Only Wi-Fi/unmetered access is allowed by default. Background use is optional and requires Android's ongoing service indication with a Stop button. It does not request extra notification permission. Your wallet may remain locked. The system may pause or end the workload."), "Start", () -> {
                try { runtime.start(reward); finish(call, null); }
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
    @Override protected void handleOnResume() { active = true; runtime.foreground(true); }
    @Override protected void handleOnPause() {
        active = false; lockNow(); runtime.foreground(false);
        interruptPending();
    }
    @Override protected void handleOnDestroy() { destroyed = true; active = false; lockNow(); interruptPending(); runtime.foreground(false); worker.shutdownNow(); }
}
