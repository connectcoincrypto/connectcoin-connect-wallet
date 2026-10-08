package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentChecks;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.VaultSession;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletVault;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native-owned HD address range and encrypted metadata. No renderer-selected paths or secrets. */
public final class NativeHdWallet implements AutoCloseable {
    public static final int GAP = 20;
    // An explicit incomplete-recovery error, never a silently truncated wallet.
    static final int MAX_ACCOUNTS = 10000, MAX_EMPTY_PAGES = 1000, RECOVERY_CONCURRENCY = 16;
    static final int MAX_RECOVERY_SNAPSHOT_BYTES = 8 * 1024 * 1024;
    @FunctionalInterface public interface Check { void check() throws Exception; }
    @FunctionalInterface public interface Persistence { void write(JSONObject envelope, Check check) throws Exception; }
    @FunctionalInterface public interface Reader { CompletableFuture<JSONObject> read(String method, JSONObject params) throws Exception; }
    @FunctionalInterface public interface Progress { void changed(JSONObject snapshot); }
    @FunctionalInterface interface Deriver { JSONObject account(int index, int change) throws Exception; }

    private final Deriver deriver;
    private final WalletVault.UpdateSession vault;
    private final Persistence persistence;
    private final Map<String, JSONObject> paths = new LinkedHashMap<>();
    private final Map<String, JSONObject> addresses = new LinkedHashMap<>();
    private JSONArray recoverySnapshots = new JSONArray();
    private int receiveIndex, changeIndex, lastUsedReceive, lastUsedChange, scanned;
    private String walletId, error = "";
    private String recoveryState = "paused", errorCode = "";
    private long retryAfterMs, retryDeadlineMs;
    private int retryAttempt;
    private boolean complete, recovering, updating;
    private volatile boolean closed;

    public NativeHdWallet(VaultSession session, WalletVault.UpdateSession vault, Persistence persistence) throws Exception {
        this(session::publicAccount, vault, persistence);
    }
    NativeHdWallet(Deriver deriver, WalletVault.UpdateSession vault, Persistence persistence) throws Exception {
        this.deriver = deriver; this.vault = vault; this.persistence = persistence;
        JSONObject payload = vault.payload();
        receiveIndex = payload.optInt("receiveIndex", 0); changeIndex = payload.optInt("changeIndex", 0);
        lastUsedReceive = payload.optInt("lastUsedReceive", -1); lastUsedChange = payload.optInt("lastUsedChange", -1);
        complete = Boolean.TRUE.equals(payload.opt("mobileHdRecovered")) && Boolean.FALSE.equals(payload.opt("needsRecovery"))
            && Boolean.TRUE.equals(payload.opt("scanLookahead"));
        recoveryState = complete ? "complete" : "paused";
        // Public accounts survive lock; native private branches and the update key do not.
        walletId = derive(0, 0, () -> {}).getString("address");
        buildRange(payload.optBoolean("scanLookahead", false), () -> {});
    }
    private void check(Check check) throws Exception { check.check(); if (closed) throw new IllegalStateException("Wallet is locked"); }
    private JSONObject derive(int index, int change, Check check) throws Exception {
        check(check); String key = change + ":" + index;
        synchronized (this) { if (paths.containsKey(key)) return copy(paths.get(key)); if (paths.size() >= MAX_ACCOUNTS) throw resourceLimit(); }
        JSONObject result = deriver.account(index, change); check(check);
        synchronized (this) {
            if (closed) throw new IllegalStateException("Wallet is locked");
            JSONObject previous = paths.get(key); if (previous != null) return copy(previous);
            if (paths.size() >= MAX_ACCOUNTS) throw resourceLimit();
            String address = result.getString("address");
            if (addresses.containsKey(address)) throw new IllegalArgumentException("Duplicate native HD address");
            paths.put(key, copy(result)); addresses.put(address, copy(result)); return copy(result);
        }
    }
    private void buildRange(boolean lookahead, Check check) throws Exception {
        int receive, change, usedReceive, usedChange;
        synchronized (this) { receive = receiveIndex; change = changeIndex; usedReceive = lastUsedReceive; usedChange = lastUsedChange; }
        buildRange(receive, change, usedReceive, usedChange, lookahead, check);
    }
    private void buildRange(int receive, int change, int usedReceive, int usedChange, boolean lookahead, Check check) throws Exception {
        int[] maxima = { maximum(receive, usedReceive, lookahead), maximum(change, usedChange, lookahead) };
        if ((long)maxima[0] + maxima[1] + 2 > MAX_ACCOUNTS) throw resourceLimit();
        for (int branch = 0; branch < 2; branch++) for (int index = 0; index <= maxima[branch]; index++) derive(index, branch, check);
    }
    private static int maximum(int issued, int used, boolean lookahead) { return lookahead ? (int)Math.min(Integer.MAX_VALUE, Math.max((long)issued, (long)used + GAP)) : issued; }
    static final class RecoveryLimitException extends IllegalStateException {
        RecoveryLimitException(String message) { super(message); }
    }
    static final class RecoveryStorageException extends Exception {
        RecoveryStorageException(Exception cause) { super("Address discovery could not save wallet data. Check storage and retry recovery.", cause); }
    }
    static final class RecoveryRefreshException extends Exception {
        RecoveryRefreshException() { super("Address history changed during discovery. Retry recovery to refresh the scan."); }
    }
    private static RecoveryLimitException resourceLimit() { return new RecoveryLimitException("HD recovery exceeds this device's address resource limit. Recovery is incomplete; use ConnectWallet desktop for this wallet."); }
    private static String recoveryError(Exception failure) {
        switch (recoveryCode(failure)) {
            case "HD_RESOURCE_LIMIT": return failure.getMessage();
            case "HD_STORAGE": return "Address discovery could not save wallet data. Check storage and retry recovery.";
            case "HD_VALIDATION": return "The node returned invalid address data. Check the RPC endpoint and retry recovery.";
            case "HD_REFRESH_REQUIRED": return "Address history changed during discovery. Retry recovery to refresh the scan.";
            case "HD_INVALID_REQUEST": return "Address discovery could not make a valid request. Check the wallet version and retry recovery.";
            case "HD_RETRY_EXHAUSTED": return "Address discovery could not reconnect. Check your connection and retry recovery.";
            case "HD_CANCELLED": return "Address discovery paused. Unlock the wallet to resume.";
            default: return "HD address recovery is incomplete. Check your connection and retry recovery.";
        }
    }
    private static String recoveryCode(Exception failure) {
        if (failure instanceof RecoveryLimitException) return "HD_RESOURCE_LIMIT";
        if (failure instanceof RecoveryStorageException) return "HD_STORAGE";
        if (failure instanceof RecoveryRefreshException) return "HD_REFRESH_REQUIRED";
        if (failure instanceof HdRecoveryReader.RetryExhausted) return "HD_RETRY_EXHAUSTED";
        if (failure instanceof MobileRpcClient.RpcFailure) {
            String code = ((MobileRpcClient.RpcFailure)failure).code;
            if ("-32011".equals(code)) return "HD_REFRESH_REQUIRED";
            if ("RPC_INVALID".equals(code)) return "HD_INVALID_REQUEST";
            if ("RPC_PROTOCOL".equals(code)) return "HD_VALIDATION";
            if ("RPC_CANCELLED".equals(code)) return "HD_CANCELLED";
            return "HD_RPC_REJECTED";
        }
        if (failure instanceof IllegalArgumentException || failure instanceof org.json.JSONException) return "HD_VALIDATION";
        if (failure instanceof java.util.concurrent.CancellationException || failure instanceof InterruptedException) return "HD_CANCELLED";
        return "HD_RECOVERY_FAILED";
    }
    public synchronized JSONObject account() { return copy(paths.get("0:" + receiveIndex)); }
    public synchronized JSONObject changeAccount() { return copy(paths.get("1:" + changeIndex)); }
    public synchronized JSONObject owned(String address) { JSONObject result = addresses.get(address); return result == null ? null : copy(result); }
    public synchronized JSONArray accounts() {
        List<JSONObject> ordered = new ArrayList<>(paths.values());
        ordered.sort((first, second) -> { int branch = Integer.compare(first.optInt("change"), second.optInt("change")); return branch != 0 ? branch : Integer.compare(first.optInt("index"), second.optInt("index")); });
        JSONArray result = new JSONArray(); for (JSONObject account : ordered) result.put(copy(account)); return result;
    }
    public synchronized JSONObject snapshot() {
        try {
            return new JSONObject().put("walletId", walletId).put("account", account()).put("accounts", accounts())
                .put("hd", hdSnapshot());
        } catch (org.json.JSONException impossible) { throw new IllegalStateException("Cannot construct HD wallet state", impossible); }
    }
    synchronized JSONObject hdSnapshot() {
        try {
            long remaining = "retrying".equals(recoveryState) ? Math.max(0, retryDeadlineMs - TimeUnit.NANOSECONDS.toMillis(System.nanoTime())) : 0;
            return new JSONObject().put("complete", complete).put("recovering", recovering).put("scanned", scanned)
                    .put("receiveIndex", receiveIndex).put("changeIndex", changeIndex).put("lastUsedReceive", lastUsedReceive)
                    .put("lastUsedChange", lastUsedChange).put("error", error).put("errorCode", errorCode)
                    .put("recoveryState", recoveryState).put("retryAfterMs", Math.min(retryAfterMs, remaining)).put("retryAttempt", retryAttempt);
        } catch (org.json.JSONException impossible) { throw new IllegalStateException("Cannot construct HD wallet state", impossible); }
    }
    void recoveryStatus(String state, long delayMs, int attempt, String code, Progress progress) {
        synchronized (this) {
            if (closed || !recovering) return;
            recoveryState = state; retryAfterMs = Math.max(0, delayMs); retryAttempt = Math.max(0, attempt); errorCode = code;
            retryDeadlineMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime()) + retryAfterMs;
        }
        publish(progress);
    }
    /** Public first pages only, with the original checkpoint from before their reads.
     * A caller must reconcile that checkpoint before presenting a current balance. */
    public synchronized JSONObject recoverySnapshots() {
        try {
            return new JSONObject().put("walletId", walletId).put("groups",
                !closed && complete && !recovering ? new JSONArray(recoverySnapshots.toString()) : new JSONArray());
        } catch (org.json.JSONException invalid) { throw new IllegalStateException("Invalid recovery snapshot", invalid); }
    }
    public synchronized void requireReady() {
        if (closed) throw new IllegalStateException("Unlock the wallet first.");
        if (!complete || recovering) throw new IllegalStateException("Wait for HD address recovery to finish before sending or creating an address.");
        if (updating) throw new IllegalStateException("A wallet address update is already in progress.");
    }
    private void beginUpdate() { synchronized (this) { requireReady(); updating = true; } }
    /** Explicit user rescan. Ordinary unlocks keep a previously completed HD range. */
    public void requestRecovery(Check check) throws Exception {
        check(check);
        synchronized (this) {
            if (recovering || updating) throw new IllegalStateException("A wallet address update is already in progress.");
            complete = false; error = ""; errorCode = ""; recoveryState = "paused"; retryAfterMs = 0; retryAttempt = 0; recoverySnapshots = new JSONArray();
        }
        try { persist(vault.payload().put("needsRecovery", true).put("mobileHdRecovered", false), check); }
        catch (Exception failure) {
            synchronized (this) { if (!closed) { error = recoveryError(failure); errorCode = recoveryCode(failure); recoveryState = "failed"; } }
            throw failure;
        }
    }
    private void persist(JSONObject payload, Check check) throws Exception {
        check(check);
        try { vault.save(payload, envelope -> { check(check); persistence.write(envelope, () -> check(check)); }); }
        catch (Exception failure) { check(check); throw new RecoveryStorageException(failure); }
        check(check);
    }
    public JSONObject newAddress(Check check) throws Exception {
        beginUpdate();
        try {
            check(check); JSONObject payload = vault.payload(); int next;
            synchronized (this) {
                if (receiveIndex == Integer.MAX_VALUE) throw new IllegalStateException("The BIP32 receive-address range is exhausted.");
                if ((long)receiveIndex >= (long)lastUsedReceive + GAP) throw new IllegalStateException("Use an existing receiving address first. Recovery keeps a 20-address gap.");
                next = receiveIndex + 1;
            }
            JSONObject account = derive(next, 0, check);
            payload.put("receiveIndex", next); persist(payload, check);
            synchronized (this) { receiveIndex = next; }
            return account;
        } finally { synchronized (this) { updating = false; } }
    }
    /** Call only after user confirmation and only if the reviewed transaction has change. */
    public void allocateChange(int expectedIndex, Check check) throws Exception {
        beginUpdate();
        try {
            check(check); JSONObject payload = vault.payload(); int next;
            synchronized (this) {
                if (changeIndex != expectedIndex) throw new IllegalStateException("The change address changed. Review the payment again.");
                if (changeIndex == Integer.MAX_VALUE) throw new IllegalStateException("The BIP32 change-address range is exhausted.");
                if ((long)changeIndex >= (long)lastUsedChange + GAP) throw new IllegalStateException("Too many unused change addresses. Wait for pending payments before sending again.");
                next = changeIndex + 1;
            }
            derive(next, 1, check); payload.put("changeIndex", next); persist(payload, check);
            synchronized (this) { changeIndex = next; }
        } finally { synchronized (this) { updating = false; } }
    }
    /** Positive validated history extends the recovery lookahead; a zero balance does not mean unused. */
    public boolean observeUsed(String address, Check check) throws Exception {
        JSONObject own = owned(address); if (own == null) throw new IllegalArgumentException("Address is not owned by this wallet.");
        synchronized (this) { if (!complete || recovering || updating || closed) return false; }
        int branch = own.getInt("change"), index = own.getInt("index");
        synchronized (this) { if (index <= (branch == 0 ? lastUsedReceive : lastUsedChange)) return false; }
        beginUpdate();
        try {
            JSONObject payload = vault.payload(); payload.put(branch == 0 ? "lastUsedReceive" : "lastUsedChange", index);
            buildRange(receiveIndex, changeIndex, branch == 0 ? index : lastUsedReceive, branch == 1 ? index : lastUsedChange, true, check);
            payload.put("scanLookahead", true); persist(payload, check);
            synchronized (this) { if (branch == 0) lastUsedReceive = index; else lastUsedChange = index; }
            return true;
        } catch (Exception failure) {
            if (!closed) {
                synchronized (this) { complete = false; error = recoveryError(failure); errorCode = recoveryCode(failure); recoveryState = "failed"; }
                // Do not silently forget an incomplete extension after a normal relaunch.
                // A disk failure may also prevent this marker, but never permits sending now.
                try { JSONObject payload = vault.payload().put("needsRecovery", true).put("mobileHdRecovered", false); persist(payload, check); }
                catch (Exception unavailable) { /* Preserve the original failure and public incomplete state. */ }
            }
            throw failure;
        } finally { synchronized (this) { updating = false; } }
    }
    /** Accept only a complete validated positive response before extending a saved gap. */
    public boolean observeResponse(String method, JSONObject params, JSONObject response, Check check) throws Exception {
        boolean changed = false;
        for (String address : usedAddresses(method, params, response)) changed |= observeUsed(address, check);
        return changed;
    }
    /** A bounded public hint. The owner must still bind it to native-derived owned addresses. */
    public static List<String> usedAddresses(String method, JSONObject params, JSONObject response) throws Exception {
        if ("getaddresschanges".equals(method)) return usedChanges(params, response);
        if (!"getaddresshistory".equals(method) && !"getaddressutxos".equals(method)) return java.util.Collections.emptyList();
        String address = params.getString("address");
        boolean used = "getaddresshistory".equals(method) ? historyUsed(response, address)
            : NativePaymentChecks.utxos(response, address, response.getJSONObject("tip")).length() > 0;
        return used ? java.util.Collections.singletonList(address) : java.util.Collections.emptyList();
    }
    private static List<String> usedChanges(JSONObject params, JSONObject response) throws Exception {
        require(response != null && response.length() == 7 && "connects".equals(response.opt("unit")) && response.opt("has_more") instanceof Boolean);
        JSONObject tip = NativePaymentChecks.tip(response.getJSONObject("tip"));
        long through = integer(response.opt("through_sequence"), 0, 9_007_199_254_740_991L);
        integer(response.opt("journal_epoch"), 0, 9_007_199_254_740_991L);
        Object cursor = response.opt("next_cursor"); require(cursor instanceof String && ((String)cursor).length() <= 4096 && ((String)cursor).matches("[A-Za-z0-9_.-]+"));
        JSONArray requested = params.getJSONArray("addresses"); require(requested.length() >= 1 && requested.length() <= 100);
        Set<String> allowed = new HashSet<>();
        for (int i = 0; i < requested.length(); i++) { Object value = requested.get(i); require(value instanceof String && allowed.add((String)value)); }
        JSONArray changes = response.getJSONArray("changes"); require(changes.length() <= 500 && (!response.getBoolean("has_more") || changes.length() > 0));
        Set<String> used = new LinkedHashSet<>(); long previous = -1;
        for (int i = 0; i < changes.length(); i++) {
            JSONObject event = changes.getJSONObject(i);
            long sequence = integer(event.opt("sequence"), 0, through); require(sequence > previous); previous = sequence;
            Object address = event.opt("address"), id = event.opt("txid"), kind = event.opt("kind"), action = event.opt("action");
            require(address instanceof String && allowed.contains(address) && id instanceof String && ((String)id).matches("[0-9a-f]{64}"));
            require(("history".equals(kind) || "utxo".equals(kind)) && ("upsert".equals(action) || "remove".equals(action)));
            boolean utxo = "utxo".equals(kind), upsert = "upsert".equals(action);
            require(event.length() == 5 + (utxo ? 1 : 0) + (upsert ? 1 : 0));
            long vout = utxo ? integer(event.opt("vout"), 0, 0xffffffffL) : -1;
            if (!upsert) continue;
            JSONObject item = event.getJSONObject("item"); require(id.equals(item.opt("txid")));
            JSONObject page = new JSONObject().put("address", address).put("tip", tip).put("unit", "connects").put("live", true)
                .put("items", new JSONArray().put(item)).put("next_cursor", JSONObject.NULL);
            if (utxo) { require(integer(item.opt("vout"), 0, 0xffffffffL) == vout); NativePaymentChecks.utxos(page, (String)address, tip); }
            else historyUsed(page, (String)address);
            used.add((String)address);
        }
        require(!response.getBoolean("has_more") || previous < through);
        // Validate the entire page before handing any native ownership hints to the caller.
        return new ArrayList<>(used);
    }
    private static long integer(Object value, long minimum, long maximum) {
        require(value instanceof Integer || value instanceof Long); long result = ((Number)value).longValue(); require(result >= minimum && result <= maximum); return result;
    }
    private static final class Scan {
        final int branch, minimum;
        int index, gap, lastUsed = -1;
        long nextIndex;
        boolean done;
        final Map<Integer, AddressScan> window = new LinkedHashMap<>();
        final Map<Integer, AddressScan> prepared = new LinkedHashMap<>();
        Scan(int branch, int minimum) { this.branch = branch; this.minimum = minimum; }
        long boundary() { return Math.min(Integer.MAX_VALUE, Math.max((long)minimum, (long)index + GAP - gap - 1)); }
    }
    private static final class AddressScan {
        final int index;
        final JSONObject account;
        int pages;
        String cursor;
        final Set<String> cursors = new HashSet<>();
        CompletableFuture<JSONObject> pending;
        RecoveryGroup group;
        JSONObject firstPage;
        Boolean used;
        AddressScan(int index, JSONObject account) { this.index = index; this.account = account; }
    }
    private static final class RecoveryGroup {
        final List<AddressScan> members;
        final JSONArray addresses = new JSONArray();
        CompletableFuture<JSONObject> pending;
        JSONObject sync;
        int bytes;
        boolean ready, discarded;
        RecoveryGroup(List<AddressScan> members) throws Exception {
            this.members = members;
            for (AddressScan member : members) { addresses.put(member.account.getString("address")); member.group = this; }
        }
        void discard() {
            discarded = true;
            for (AddressScan member : members) member.firstPage = null;
        }
    }
    private static boolean unsupportedCheckpoint(Exception failure) {
        return failure instanceof MobileRpcClient.RpcFailure && "-32601".equals(((MobileRpcClient.RpcFailure)failure).code);
    }
    /** A reconnect probe must pass the same validation as the scanner before
     * reopening its parallel window. The scanner still owns all progress. */
    static void validateRecoveryRead(String method, JSONObject params, JSONObject response) throws Exception {
        if ("getaddresschanges".equals(method)) {
            usedChanges(params, response);
            require(response.getJSONArray("changes").length() == 0 && !response.getBoolean("has_more"));
        } else if ("getaddresshistory".equals(method)) historyUsed(response, params.getString("address"));
        else throw new IllegalArgumentException("Unsupported HD recovery read.");
    }
    /** Cover the known gap before its individual reads begin. Every prepared
     * address is already required by the monotonic scan boundary; none is a
     * speculative address beyond the gap. This scope does not occupy history
     * slots until those addresses enter the rolling window. */
    private void extendCheckpointScope(Scan[] branches, List<AddressScan> members, Check check) throws Exception {
        long[] next = {branches[0].nextIndex, branches[1].nextIndex};
        boolean added;
        do {
            added = false;
            for (int branch = 0; branch < branches.length && members.size() < 100; branch++) {
                Scan scan = branches[branch];
                while (next[branch] <= scan.boundary() && scan.prepared.containsKey((int)next[branch])) next[branch]++;
                if (scan.done || next[branch] > scan.boundary()) continue;
                check(check); int index = (int)next[branch]++;
                AddressScan address = new AddressScan(index, derive(index, scan.branch, check));
                scan.prepared.put(index, address); members.add(address); added = true;
            }
        } while (added && members.size() < 100);
    }
    /** Sixteen rolling requests share the caller's bounded transport, with ordered gap decisions. */
    public void recover(Reader reader, Check check, Progress progress) throws Exception {
        synchronized (this) {
            if (closed) throw new IllegalStateException("Wallet is locked");
            if (complete) return;
            if (recovering || updating) throw new IllegalStateException("HD recovery is already running.");
            recovering = true; recoveryState = "scanning"; error = ""; errorCode = ""; retryAfterMs = 0; retryAttempt = 0; scanned = 0; recoverySnapshots = new JSONArray();
        }
        Scan[] branches = null;
        List<RecoveryGroup> groups = new ArrayList<>();
        JSONArray retained = new JSONArray(); int retainedBytes = 0;
        Long checkpointEpoch = null;
        boolean legacy = false;
        try {
            check(check); JSONObject payload = vault.payload();
            payload.put("needsRecovery", true); persist(payload, check);
            branches = new Scan[]{new Scan(0, maximum(receiveIndex, lastUsedReceive, true)), new Scan(1, maximum(changeIndex, lastUsedChange, true))};
            while (!branches[0].done || !branches[1].done) {
                // Reserve half the window for each live branch, so a slow receiving prefix cannot
                // monopolize every slot and stall change discovery. The last branch gets all 16.
                int branchLimit = !branches[0].done && !branches[1].done ? RECOVERY_CONCURRENCY / 2 : RECOVERY_CONCURRENCY;
                boolean derived = false, added;
                do {
                    added = false;
                    for (Scan scan : branches) if (!scan.done && scan.window.size() < branchLimit && scan.nextIndex <= scan.boundary()) {
                        check(check); int index = (int)scan.nextIndex++;
                        AddressScan address = scan.prepared.remove(index);
                        if (address == null) address = new AddressScan(index, derive(index, scan.branch, check));
                        scan.window.put(index, address);
                        added = true; derived = true;
                    }
                } while (added);
                // A checkpoint is captured before any member's first history read. Its
                // newly opened members retain their slots while queued, so checkpoints
                // and history reads together never exceed sixteen requests. Extend its
                // scope through the already required gap to avoid a checkpoint per refill.
                List<AddressScan> fresh = new ArrayList<>();
                if (!legacy) for (Scan scan : branches) for (AddressScan address : scan.window.values())
                    if (address.pages == 0 && address.group == null) fresh.add(address);
                if (!fresh.isEmpty()) {
                    extendCheckpointScope(branches, fresh, check);
                    publish(progress);
                    check(check); RecoveryGroup group = new RecoveryGroup(fresh); groups.add(group);
                    try {
                        group.pending = reader.read("getaddresschanges", new JSONObject().put("addresses", group.addresses));
                        if (group.pending == null) throw new IllegalStateException("Missing HD recovery checkpoint.");
                    } catch (Exception failure) {
                        if (!unsupportedCheckpoint(failure)) throw failure;
                        legacy = true; group.ready = true; group.discard(); retained = new JSONArray(); retainedBytes = 0;
                    }
                } else if (derived) publish(progress);
                for (RecoveryGroup group : groups) if (group.pending != null && group.pending.isDone()) {
                    try {
                        JSONObject sync = await(group.pending, check);
                        usedChanges(new JSONObject().put("addresses", group.addresses), sync);
                        require(sync.getJSONArray("changes").length() == 0 && !sync.getBoolean("has_more"));
                        long epoch = sync.getLong("journal_epoch");
                        if (checkpointEpoch != null && checkpointEpoch.longValue() != epoch) throw new RecoveryRefreshException();
                        checkpointEpoch = epoch;
                        group.sync = copy(sync);
                    } catch (Exception failure) {
                        if (!unsupportedCheckpoint(failure)) throw failure;
                        legacy = true; group.discard(); retained = new JSONArray(); retainedBytes = 0;
                    }
                    group.pending = null; group.ready = true;
                }
                // Empty continuation pages keep their address slot. Buffered out-of-order replies
                // also count toward the 16-address bound until their preceding indexes finish.
                for (Scan scan : branches) for (AddressScan address : scan.window.values()) if (address.used == null && address.pending == null) {
                    if (address.group != null && !address.group.ready) continue;
                    check(check);
                    JSONObject params = new JSONObject().put("address", address.account.getString("address"));
                    if (address.cursor != null) params.put("cursor", address.cursor);
                    if (++address.pages > MAX_EMPTY_PAGES) throw new RecoveryLimitException("HD history pagination limit reached. Recovery is incomplete; use ConnectWallet desktop for this wallet.");
                    address.pending = reader.read("getaddresshistory", params);
                    if (address.pending == null) throw new IllegalStateException("Missing HD recovery response.");
                }
                awaitAny(branches, groups, check);
                for (Scan scan : branches) for (AddressScan address : scan.window.values()) if (address.pending != null && address.pending.isDone()) {
                    JSONObject page = await(address.pending, check); address.pending = null;
                    boolean used = historyUsed(page, address.account.getString("address"));
                    if (!legacy && address.pages == 1 && address.group != null && !address.group.discarded) {
                        int bytes = page.toString().getBytes(StandardCharsets.UTF_8).length;
                        if ((long)address.group.bytes + bytes > MAX_RECOVERY_SNAPSHOT_BYTES) address.group.discard();
                        else { address.group.bytes += bytes; address.firstPage = copy(page); }
                    }
                    String cursor = page.isNull("next_cursor") ? null : page.getString("next_cursor");
                    if (!used && cursor != null) {
                        if (!address.cursors.add(cursor)) throw new IllegalArgumentException("Repeated HD history cursor.");
                        address.cursor = cursor;
                    } else address.used = used;
                }
                for (java.util.Iterator<RecoveryGroup> pending = groups.iterator(); pending.hasNext();) {
                    RecoveryGroup group = pending.next();
                    if (!group.ready) continue;
                    boolean finished = true;
                    for (AddressScan member : group.members) if (member.pages == 0 || member.pages == 1 && member.pending != null) finished = false;
                    if (!finished) continue;
                    if (!legacy && !group.discarded && group.sync != null) {
                        JSONArray histories = new JSONArray();
                        for (AddressScan member : group.members) { require(member.firstPage != null); histories.put(member.firstPage); }
                        JSONObject value = new JSONObject().put("addresses", group.addresses).put("sync", group.sync).put("histories", histories);
                        int bytes = value.toString().getBytes(StandardCharsets.UTF_8).length;
                        if ((long)retainedBytes + bytes <= MAX_RECOVERY_SNAPSHOT_BYTES) { retained.put(value); retainedBytes += bytes; }
                    }
                    for (AddressScan member : group.members) { member.group = null; member.firstPage = null; }
                    pending.remove();
                }
                // Only a contiguous, fully validated prefix may advance the gap. A fast unused
                // response must never hide an earlier slow used address or an unfinished page.
                for (Scan scan : branches) while (!scan.done) {
                    AddressScan address = scan.window.get(scan.index);
                    if (address == null || address.used == null) break;
                    scan.window.remove(scan.index);
                    if (address.used) { scan.lastUsed = scan.index; scan.gap = 0; } else scan.gap++;
                    synchronized (this) { scanned++; }
                    if (scan.index >= scan.minimum && scan.gap >= GAP) {
                        scan.done = true;
                        if (!scan.window.isEmpty() || !scan.prepared.isEmpty()) throw new IllegalStateException("HD recovery exceeded its gap boundary.");
                    } else if (scan.index == Integer.MAX_VALUE) {
                        throw new RecoveryLimitException("HD recovery cannot complete its unused-address gap at the derivation boundary. Use ConnectWallet desktop for this wallet.");
                    } else scan.index++;
                }
                publish(progress);
            }
            check(check);
            int usedReceive = Math.max(lastUsedReceive, branches[0].lastUsed), usedChange = Math.max(lastUsedChange, branches[1].lastUsed);
            int nextReceive = (int)Math.min(Integer.MAX_VALUE, Math.max((long)receiveIndex, (long)usedReceive + 1));
            int nextChange = (int)Math.min(Integer.MAX_VALUE, Math.max((long)changeIndex, (long)usedChange + 1));
            // All current addresses must exist before committed indexes are exposed.
            buildRange(nextReceive, nextChange, usedReceive, usedChange, true, check);
            payload = vault.payload();
            payload.put("receiveIndex", nextReceive).put("changeIndex", nextChange).put("lastUsedReceive", usedReceive)
                .put("lastUsedChange", usedChange).put("needsRecovery", false).put("scanLookahead", true).put("mobileHdRecovered", true);
            persist(payload, check);
            synchronized (this) { receiveIndex = nextReceive; changeIndex = nextChange; lastUsedReceive = usedReceive; lastUsedChange = usedChange; }
            check(check);
            synchronized (this) {
                if (closed) throw new IllegalStateException("Wallet is locked");
                complete = true; recoveryState = "complete"; errorCode = ""; retryAfterMs = 0; retryAttempt = 0; recoverySnapshots = retained;
            }
        } catch (Exception failure) {
            synchronized (this) { if (!closed) { error = recoveryError(failure); errorCode = recoveryCode(failure); recoveryState = "failed"; retryAfterMs = 0; } }
            throw failure;
        } finally {
            for (RecoveryGroup group : groups) if (group.pending != null) group.pending.cancel(true);
            if (branches != null) for (Scan scan : branches) for (AddressScan address : scan.window.values()) if (address.pending != null) address.pending.cancel(true);
            synchronized (this) { recovering = false; }
            publish(progress);
        }
    }
    private JSONObject await(CompletableFuture<JSONObject> future, Check check) throws Exception {
        for (;;) {
            check(check);
            try { JSONObject value = future.get(100, TimeUnit.MILLISECONDS); check(check); return value; }
            catch (TimeoutException pending) { /* Allow lock/lifecycle cancellation during RPC quota waits. */ }
            catch (ExecutionException failure) { if (failure.getCause() instanceof Exception) throw (Exception)failure.getCause(); throw failure; }
        }
    }
    private void awaitAny(Scan[] scans, List<RecoveryGroup> groups, Check check) throws Exception {
        List<CompletableFuture<JSONObject>> pending = new ArrayList<>();
        for (RecoveryGroup group : groups) if (group.pending != null) pending.add(group.pending);
        for (Scan scan : scans) for (AddressScan address : scan.window.values()) if (address.pending != null) pending.add(address.pending);
        if (pending.isEmpty()) return;
        CompletableFuture<?> ready = CompletableFuture.anyOf(pending.toArray(new CompletableFuture<?>[0]));
        for (;;) {
            check(check);
            try { ready.get(100, TimeUnit.MILLISECONDS); return; }
            catch (TimeoutException waiting) { /* Check lock/lifecycle while either branch is queued. */ }
            catch (ExecutionException | java.util.concurrent.CancellationException failed) { return; } // The owning future supplies its precise failure.
        }
    }
    private static boolean historyUsed(JSONObject page, String address) throws Exception {
        require(page != null && page.length() == 6 && address.equals(page.opt("address")) && "connects".equals(page.opt("unit")) && Boolean.TRUE.equals(page.opt("live")));
        JSONObject tip = NativePaymentChecks.tip(page.getJSONObject("tip")); JSONArray rows = page.getJSONArray("items");
        require(rows.length() <= 500 && page.has("next_cursor"));
        if (!page.isNull("next_cursor")) { Object cursor = page.opt("next_cursor"); require(cursor instanceof String && ((String)cursor).length() <= 4096 && ((String)cursor).matches("[A-Za-z0-9_.-]+")); }
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i); Object id = row.opt("txid");
            require(row.length() == 8 && id instanceof String && ((String)id).matches("[0-9a-f]{64}") && seen.add((String)id));
            long received = NativeTransactions.amount(row.getString("received")), spent = NativeTransactions.amount(row.getString("spent"));
            String delta = row.getString("balance_delta"); require(delta.matches("-?[0-9]{1,19}") && new BigInteger(delta).equals(BigInteger.valueOf(received).subtract(BigInteger.valueOf(spent))));
            Object count = row.opt("confirmations"); require(count instanceof Integer || count instanceof Long); long confirmations = ((Number)count).longValue();
            if ("pending".equals(row.opt("status"))) require(row.has("block_height") && row.isNull("block_height") && row.has("block_hash") && row.isNull("block_hash") && confirmations == 0);
            else {
                Object height = row.opt("block_height"), hash = row.opt("block_hash");
                require("confirmed".equals(row.opt("status")) && (height instanceof Integer || height instanceof Long) && hash instanceof String && ((String)hash).matches("[0-9a-f]{64}"));
                long blockHeight = ((Number)height).longValue(); require(blockHeight >= 0 && blockHeight <= tip.getLong("height") && confirmations == tip.getLong("height") - blockHeight + 1);
            }
        }
        return rows.length() > 0;
    }
    private static void require(boolean condition) { if (!condition) throw new IllegalArgumentException("Invalid HD address history response."); }
    private void publish(Progress progress) { if (progress != null && !closed) { try { progress.changed(snapshot()); } catch (RuntimeException ignored) { /* UI hints cannot alter recovery. */ } } }
    private static JSONObject copy(JSONObject value) {
        if (value == null) return null;
        try { return new JSONObject(value.toString()); } catch (org.json.JSONException invalid) { throw new IllegalStateException("Invalid native HD account", invalid); }
    }
    @Override public void close() {
        synchronized (this) { closed = true; recovering = false; recoveryState = "paused"; retryAfterMs = 0; recoverySnapshots = new JSONArray(); }
        vault.close();
    }
}
