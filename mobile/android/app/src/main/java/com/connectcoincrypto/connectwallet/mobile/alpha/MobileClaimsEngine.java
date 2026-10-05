package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Native claim scheduling, never a WebView signing/broadcast API.
 * One mobile worker, at most four TLS starts/second. Catalogs are progressive,
 * newest-first and bounded; each complete block is reconciled before use.
 * The process-wide RPC client's active state and other operations are not owned
 * here. Only this engine's futures and native proof handle are cancelled.
 */
public final class MobileClaimsEngine implements AutoCloseable {
    private static final String GENESIS = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e";
    private static final long SAFE_MAX = 9007199254740991L;
    private static final int FEE_RATE = 1500, MAX_CATALOG = 10000, MAX_DOMAINS = 512;
    private static final BigInteger SPACE = BigInteger.ONE.shiftLeft(256);
    private final RpcAccess rpc;
    private final ProofAccess proof;
    private final Transactions transactions;
    private final ScheduledThreadPoolExecutor worker;
    private final Set<CompletableFuture<JSONObject>> operations = new HashSet<>();
    private final Map<String, Candidate> catalog = new LinkedHashMap<>();
    private final Map<String, Ema> domains = new LinkedHashMap<>();
    private final Map<String, Long> blocks = new LinkedHashMap<>();
    private final Set<String> loaded = new HashSet<>(), retired = new HashSet<>();
    private String cursor, rewardAddress, currentDomain = "", status = "stopped", lastError = "", lastTxid = "";
    private JSONObject tip;
    private long generation, handle, attempts, valid, invalid, targetHits, submitted, unknown, cancelled;
    private long elapsedBeforePause, activeSince, nextDiscovery, nextBlock, nextAttempt, retryAt;
    private boolean enabled, allowed, closed, healthy, unknownBlocked;
    private ReceiptStore receiptStore;

    /** Public txid/status only; the native owner must durably commit before returning. */
    public interface ReceiptStore { void record(String txid, String status) throws Exception; }
    public synchronized void setReceiptStore(ReceiptStore store) {
        require(store != null && !enabled && operations.isEmpty(), "CLAIMS_RECEIPT_STATE"); receiptStore = store;
    }
    public synchronized void restoreUnknownOutcome(String txid) {
        require(!enabled && operations.isEmpty(), "CLAIMS_RECEIPT_STATE");
        lastTxid = hash(txid); unknownBlocked = true; unknown = Math.max(unknown, 1); status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME";
    }
    /** Native owner calls only after authentic RPC lookup AND raw txid verification. Never restarts automatically. */
    public synchronized void resolveConfirmedOutcome(String txid) throws Exception {
        require(unknownBlocked && lastTxid.equals(hash(txid)), "CLAIMS_RECEIPT_STATE");
        recordReceipt(txid, "submitted"); unknownBlocked = false; status = "stopped"; lastError = "";
    }
    private synchronized void recordReceipt(String txid, String state) throws Exception {
        require(receiptStore != null, "CLAIMS_RECEIPT_UNAVAILABLE");
        try { receiptStore.record(txid, state); } catch (Exception failure) { throw new IllegalStateException("CLAIMS_RECEIPT_UNAVAILABLE", failure); }
    }

    interface RpcAccess {
        CompletableFuture<JSONObject> call(String method, JSONObject params);
        CompletableFuture<JSONObject> stream(String hash, MobileRpcClient.ChunkConsumer consumer);
        CompletableFuture<JSONObject> broadcast(String hex);
    }
    interface ProofAccess {
        long create(); void cancel(long handle); void destroy(long handle);
        JSONObject capture(JSONObject context, long handle) throws Exception;
    }
    interface Transactions {
        void validateReward(String address);
        long fee();
        JSONObject prepare(JSONObject bounty, String parent, String reward) throws Exception;
        JSONObject attach(JSONObject prepared, String proof) throws Exception;
    }
    public MobileClaimsEngine(MobileRpcClient client) {
        this(new RpcAccess() {
            public CompletableFuture<JSONObject> call(String method, JSONObject params) { return client.call(method, params); }
            public CompletableFuture<JSONObject> stream(String hash, MobileRpcClient.ChunkConsumer consumer) { return client.streamBounties(hash, consumer); }
            public CompletableFuture<JSONObject> broadcast(String hex) { return client.broadcast(hex); }
        }, new ProofAccess() {
            public long create() { return NativeClaims.createCancellationHandle(); }
            public void cancel(long handle) { NativeClaims.cancel(handle); }
            public void destroy(long handle) { NativeClaims.destroyHandle(handle); }
            public JSONObject capture(JSONObject context, long handle) throws Exception {
                return RpcTransport.parseObject(NativeClaims.captureAndVerify(context.getString("domain"), context.getString("challenge"), context.getString("target"),
                    context.getInt("rootVersion"), context.getInt("mask"), context.getLong("validationTime"), 10000, handle));
            }
        }, new Transactions() {
            public void validateReward(String address) { WalletCrypto.decodeAddress(address); }
            public long fee() { return NativeTransactions.claimFee(FEE_RATE); }
            public JSONObject prepare(JSONObject bounty, String parent, String reward) throws Exception { return NativeTransactions.prepareClaim(bounty, parent, reward, FEE_RATE); }
            public JSONObject attach(JSONObject prepared, String bytes) throws Exception { return NativeTransactions.attachClaim(prepared, bytes); }
        }, true);
        if (client == null) throw new IllegalArgumentException("Missing native RPC client");
    }
    // Package-private offline seam: no live network or proof engine in tests.
    MobileClaimsEngine(RpcAccess rpc, ProofAccess proof, Transactions transactions, boolean schedule) {
        if (rpc == null || proof == null || transactions == null) throw new IllegalArgumentException("Missing claim dependencies");
        this.rpc = rpc; this.proof = proof; this.transactions = transactions;
        worker = new ScheduledThreadPoolExecutor(1, action -> { Thread thread = new Thread(action, "connectwallet-mobile-claims"); thread.setDaemon(true); return thread; });
        worker.setRemoveOnCancelPolicy(true);
        if (schedule) worker.scheduleWithFixedDelay(this::tick, 0, 100, TimeUnit.MILLISECONDS);
    }
    private static long now() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()); }
    private static long increment(long value) { return Math.min(SAFE_MAX, value + 1); }
    private static void require(boolean condition, String code) { if (!condition) throw new IllegalArgumentException(code); }
    private static String hash(Object value) { require(value instanceof String && ((String) value).matches("[0-9a-f]{64}"), "CLAIMS_RPC_DATA"); return (String) value; }
    private static long integer(Object value, long min, long max) { require((value instanceof Integer || value instanceof Long) && ((Number) value).longValue() >= min && ((Number) value).longValue() <= max, "CLAIMS_RPC_DATA"); return ((Number) value).longValue(); }
    private static String key(JSONObject bounty) throws JSONException { return bounty.getString("txid") + ":" + bounty.getLong("vout"); }
    private static JSONObject copy(JSONObject value) throws JSONException { return new JSONObject(value.toString()); }
    private static String validCursor(Object value) { require(value instanceof String && ((String) value).matches("[A-Za-z0-9_.-]{1,1024}"), "CLAIMS_RPC_DATA"); return (String) value; }

    public void setAllowed(boolean value) {
        List<CompletableFuture<JSONObject>> pending = null; long cancellation = 0;
        synchronized (this) {
            if (closed || allowed == value) return;
            allowed = value;
            if (!value) { pauseClock(); generation++; pending = new ArrayList<>(operations); cancellation = handle; status = enabled ? "paused" : "stopped"; currentDomain = ""; }
            else if (enabled && !unknownBlocked) { activeSince = now(); nextDiscovery = 0; status = "synchronizing"; }
        }
        cancelOwned(pending, cancellation);
    }
    public synchronized void start(String address) {
        if (closed) throw new IllegalStateException("CLAIMS_CLOSED");
        if (unknownBlocked) throw new IllegalStateException("CLAIMS_UNKNOWN_OUTCOME");
        transactions.validateReward(address);
        if (enabled) { require(address.equals(rewardAddress), "Stop claims before changing the reward address."); return; }
        rewardAddress = address; enabled = true; generation++; elapsedBeforePause = 0; activeSince = allowed ? now() : 0;
        attempts = valid = invalid = targetHits = submitted = unknown = cancelled = 0;
        resetCatalog(); domains.clear(); retired.clear(); lastError = ""; lastTxid = ""; nextDiscovery = nextBlock = nextAttempt = retryAt = 0;
        status = allowed ? "synchronizing" : "paused";
    }
    public void stop() {
        List<CompletableFuture<JSONObject>> pending; long cancellation;
        synchronized (this) { if (closed && !enabled) return; enabled = false; pauseClock(); generation++; pending = new ArrayList<>(operations); cancellation = handle; currentDomain = ""; status = unknownBlocked ? "unknown-outcome" : "stopped"; }
        cancelOwned(pending, cancellation);
    }
    @Override public void close() { stop(); synchronized (this) { closed = true; } worker.shutdownNow(); }
    private void cancelOwned(List<CompletableFuture<JSONObject>> pending, long cancellation) {
        if (cancellation != 0) proof.cancel(cancellation);
        if (pending != null) for (CompletableFuture<JSONObject> operation : pending) operation.cancel(false);
    }
    private void pauseClock() { if (activeSince != 0) { elapsedBeforePause += Math.max(0, now() - activeSince); activeSince = 0; } }
    private synchronized void check(long epoch) { if (closed || !enabled || !allowed || epoch != generation) throw new Stopped(); }
    private static final class Stopped extends RuntimeException { private static final long serialVersionUID = 1L; }
    private synchronized void resetCatalog() { catalog.clear(); blocks.clear(); loaded.clear(); cursor = null; tip = null; healthy = false; }

    private JSONObject waitFor(CompletableFuture<JSONObject> future, long epoch) throws Exception {
        synchronized (this) { try { check(epoch); } catch (Stopped stopped) { future.cancel(false); throw stopped; } operations.add(future); }
        try { JSONObject result = future.get(); check(epoch); return result; }
        catch (ExecutionException failure) { if (failure.getCause() instanceof Exception) throw (Exception) failure.getCause(); throw new IllegalStateException("CLAIMS_RPC", failure.getCause()); }
        finally { synchronized (this) { operations.remove(future); } }
    }
    private JSONObject request(String method, JSONObject params, long epoch) throws Exception { check(epoch); return waitFor(rpc.call(method, params), epoch); }
    static JSONObject validateTip(JSONObject value) throws JSONException {
        require(value != null && "main".equals(value.opt("chain")) && GENESIS.equals(value.opt("genesis_hash")), "CLAIMS_WRONG_NETWORK");
        hash(value.opt("hash")); integer(value.opt("height"), 0, SAFE_MAX); integer(value.opt("mediantime"), 1, 253402300799L); return copy(value);
    }
    private Map<String, Long> recent(JSONObject response) throws Exception {
        JSONObject state = validateTip(response.optJSONObject("tip")); long height = state.getLong("height");
        require(integer(response.opt("window"), 600, 600) == 600 && response.opt("blocks") instanceof JSONArray, "CLAIMS_RPC_DATA");
        JSONArray list = response.getJSONArray("blocks"); require(list.length() == Math.min(600L, height + 1), "CLAIMS_RPC_DATA");
        Map<String, Long> result = new LinkedHashMap<>();
        for (int index = 0; index < list.length(); index++) {
            JSONObject block = list.getJSONObject(index); String id = hash(block.opt("hash"));
            require(integer(block.opt("height"), 0, SAFE_MAX) == height - index && !result.containsKey(id), "CLAIMS_RPC_DATA");
            if (index == 0) require(id.equals(state.getString("hash")), "CLAIMS_RPC_DATA"); result.put(id, height - index);
        }
        return result;
    }
    private void discover(long epoch) throws Exception {
        String startCursor;
        synchronized (this) { startCursor = cursor; healthy = false; }
        if (startCursor == null) {
            JSONObject watermark = request("getbountychanges", new JSONObject(), epoch);
            validateTip(watermark.optJSONObject("tip"));
            require(watermark.opt("changes") instanceof JSONArray && watermark.getJSONArray("changes").length() == 0 && Boolean.FALSE.equals(watermark.opt("has_more")), "CLAIMS_RPC_DATA");
            startCursor = validCursor(watermark.opt("next_cursor"));
        }
        JSONObject response = request("getrecentblockhashes", new JSONObject(), epoch); Map<String, Long> recent = recent(response);
        synchronized (this) {
            check(epoch); blocks.clear(); blocks.putAll(recent); loaded.retainAll(blocks.keySet());
            catalog.values().removeIf(candidate -> !blocks.containsKey(candidate.blockHash));
            retired.retainAll(catalog.keySet());
            cursor = startCursor; tip = validateTip(response.getJSONObject("tip"));
        }
        replay(epoch, null, null);
        synchronized (this) { check(epoch); nextDiscovery = now() + 10000; healthy = true; lastError = ""; }
    }
    private void loadBlock(String blockHash, long epoch) throws Exception {
        Map<String, Candidate> staged = new LinkedHashMap<>();
        waitFor(rpc.stream(blockHash, chunk -> {
            check(epoch);
            validateTip(chunk.optJSONObject("tip"));
            if (!"bounties".equals(chunk.opt("type"))) return;
            JSONArray values = chunk.getJSONArray("items");
            for (int index = 0; index < values.length(); index++) {
                Candidate row = new Candidate(values.getJSONObject(index), blockHash, transactions.fee());
                synchronized (this) { require(blocks.containsKey(blockHash) && row.height == blocks.get(blockHash), "CLAIMS_RPC_DATA"); }
                require(staged.put(row.key, row) == null && staged.size() <= MAX_CATALOG, "CLAIMS_CAPACITY");
            }
        }), epoch);
        replay(epoch, blockHash, staged);
        synchronized (this) { check(epoch); nextBlock = now() + 1500; healthy = true; }
    }
    /** Private clone plus delta replay; no partially received block is published. */
    private void replay(long epoch, String newBlock, Map<String, Candidate> staged) throws Exception {
        Map<String, Candidate> next = new LinkedHashMap<>(); String nextCursor; JSONObject nextTip;
        synchronized (this) { check(epoch); for (Candidate row : catalog.values()) next.put(row.key, row.copy()); nextCursor = cursor; nextTip = tip; }
        if (staged != null) for (Candidate row : staged.values()) next.put(row.key, row);
        require(next.size() <= MAX_CATALOG, "CLAIMS_CAPACITY");
        boolean more = true; long previousSequence = -1;
        for (int page = 0; more && page < 20; page++) {
            JSONObject changes = request("getbountychanges", new JSONObject().put("cursor", nextCursor), epoch);
            nextTip = validateTip(changes.optJSONObject("tip"));
            require(changes.opt("changes") instanceof JSONArray && changes.opt("has_more") instanceof Boolean, "CLAIMS_RPC_DATA");
            JSONArray events = changes.getJSONArray("changes"); require(events.length() <= 500, "CLAIMS_RPC_DATA");
            String following = validCursor(changes.opt("next_cursor")); more = changes.getBoolean("has_more");
            require(!more || events.length() > 0 && !following.equals(nextCursor), "CLAIMS_RPC_DATA");
            for (int index = 0; index < events.length(); index++) {
                JSONObject event = events.getJSONObject(index); long sequence = integer(event.opt("sequence"), 0, SAFE_MAX);
                require(sequence > previousSequence, "CLAIMS_RPC_DATA"); previousSequence = sequence;
                String txid = hash(event.opt("txid")); long vout = integer(event.opt("vout"), 0, 0xffffffffL); String key = txid + ":" + vout;
                String type = event.optString("type", ""); Candidate row = next.get(key);
                if (type.equals("window_exit")) next.remove(key);
                else if (type.equals("added")) { hash(event.opt("block_hash")); integer(event.opt("block_height"), 0, SAFE_MAX); }
                else if (type.equals("spent") || type.equals("pending_spend")) { hash(event.opt("spending_txid")); if (row != null) row.state = type.equals("spent") ? "spent" : "pending_spend"; }
                else if (type.equals("available_again") || type.equals("matured")) {
                    if (row != null && !row.state.equals("spent") && (type.equals("available_again") || row.state.equals("immature"))) row.state = row.coinbase && nextTip.getLong("height") - row.height + 1 < 100 ? "immature" : "available";
                } else throw new IllegalArgumentException("CLAIMS_RPC_DATA");
            }
            nextCursor = following;
        }
        require(!more, "CLAIMS_SYNC_BUSY");
        synchronized (this) {
            check(epoch); if (newBlock != null && !blocks.containsKey(newBlock)) throw new IllegalArgumentException("CLAIMS_SYNC_BUSY");
            catalog.clear(); catalog.putAll(next); if (newBlock != null) loaded.add(newBlock);
            retired.retainAll(catalog.keySet());
            cursor = nextCursor; tip = nextTip;
        }
    }

    void tick() {
        final long epoch;
        synchronized (this) { if (closed || !enabled || !allowed || unknownBlocked || now() < retryAt) return; epoch = generation; }
        try {
            if (now() >= nextDiscovery) discover(epoch);
            String missing = null;
            synchronized (this) { for (String block : blocks.keySet()) if (!loaded.contains(block)) { missing = block; break; } }
            if (missing != null && now() >= nextBlock) loadBlock(missing, epoch);
            Candidate candidate;
            synchronized (this) { check(epoch); candidate = healthy ? select(catalog.values(), domains, retired) : null; status = candidate == null ? (loaded.size() < blocks.size() ? "synchronizing" : "waiting") : "claiming"; }
            if (candidate != null && now() >= nextAttempt) attempt(candidate, epoch);
        } catch (Stopped stopped) { /* An explicit lifecycle cancellation is neutral. */ }
        catch (Exception | LinkageError error) {
            synchronized (this) {
                if (epoch != generation || !enabled) return;
                healthy = false; currentDomain = "";
                String code = error instanceof MobileRpcClient.RpcFailure ? ((MobileRpcClient.RpcFailure) error).code : safeCode(error.getMessage());
                if (code.equals("-32011")) resetCatalog();
                if (code.equals("CLAIMS_WRONG_NETWORK") || code.equals("CLAIMS_CAPACITY") || code.equals("CLAIMS_RPC_DATA") || code.equals("CLAIMS_NATIVE_DATA") || code.equals("CLAIMS_RECEIPT_UNAVAILABLE") || error instanceof LinkageError) { enabled = false; pauseClock(); status = "error"; }
                else { status = "retrying"; retryAt = now() + (code.equals("-32029") ? 60000 : 5000); nextDiscovery = 0; }
                lastError = code;
            }
        }
    }
    private static String safeCode(String value) { return value != null && value.matches("CLAIM[S]?_[A-Z_]{1,40}") ? value : "CLAIMS_FAILED"; }

    private void attempt(Candidate row, long epoch) throws Exception {
        JSONObject prepared;
        synchronized (this) { check(epoch); if (!rowAvailable(row.key)) return; prepared = row.prepared; }
        if (prepared == null) {
            JSONObject parent = request("gettransaction", new JSONObject().put("txid", row.bounty.getString("txid")), epoch);
            validateTip(parent.optJSONObject("tip")); JSONObject tx = parent.optJSONObject("transaction");
            require(tx != null && tx.opt("hex") instanceof String, "CLAIMS_RPC_DATA");
            prepared = transactions.prepare(row.bounty, tx.getString("hex"), rewardAddress);
            synchronized (this) { check(epoch); Candidate current = catalog.get(row.key); if (current == null || !rowAvailable(row.key)) return; current.prepared = prepared; row = current; }
        }
        final long nativeHandle = proof.create(); JSONObject result;
        try {
            JSONObject context;
            synchronized (this) {
                check(epoch); handle = nativeHandle; currentDomain = row.domain;
                if (!domains.containsKey(row.domain)) { require(domains.size() < MAX_DOMAINS, "CLAIMS_CAPACITY"); domains.put(row.domain, new Ema()); }
                attempts = increment(attempts); nextAttempt = now() + 250;
                context = new JSONObject().put("domain", row.domain).put("challenge", prepared.getString("challenge")).put("target", row.target)
                    .put("rootVersion", 1).put("mask", row.mask).put("validationTime", tip.getLong("mediantime"));
            }
            result = proof.capture(context, nativeHandle); check(epoch);
        } catch (Stopped stopped) { synchronized (this) { cancelled = increment(cancelled); } throw stopped; }
        catch (IllegalStateException failure) {
            if ("CLAIM_CANCELLED".equals(failure.getMessage())) { synchronized (this) { cancelled = increment(cancelled); } throw new Stopped(); }
            if (java.util.Arrays.asList("CLAIM_DNS", "CLAIM_CONTEXT", "CLAIM_TIMEOUT", "CLAIM_BUSY").contains(failure.getMessage())) {
                synchronized (this) { check(epoch); domains.get(row.domain).retryAfter = now() + 30000; lastError = failure.getMessage(); }
                return; // No invented latency sample; temporarily try other domains.
            }
            throw failure; // DNS/setup/busy failures have no completed TCP/TLS sample.
        }
        finally { proof.destroy(nativeHandle); synchronized (this) { if (handle == nativeHandle) handle = 0; currentDomain = ""; } }
        require(result.opt("validProof") instanceof Boolean && result.opt("meetsTarget") instanceof Boolean, "CLAIMS_NATIVE_DATA");
        boolean verified = result.getBoolean("validProof"), hit = result.getBoolean("meetsTarget");
        long duration = integer(result.opt("durationMs"), 0, 60000);
        require(!hit || verified, "CLAIMS_NATIVE_DATA");
        require(result.opt("proof") instanceof String && (verified || result.getString("proof").isEmpty()), "CLAIMS_NATIVE_DATA");
        synchronized (this) {
            check(epoch); domains.get(row.domain).record(verified, duration / 1000.0);
            if (verified) { valid = increment(valid); row.validCaptures = increment(row.validCaptures); } else invalid = increment(invalid);
            if (hit) targetHits = increment(targetHits);
            String nativeCode = result.optString("errorCode", "");
            lastError = verified ? "" : java.util.Arrays.asList("CLAIM_NETWORK", "CLAIM_TLS", "CLAIM_CERTIFICATE", "CLAIM_TIMEOUT").contains(nativeCode) ? nativeCode : "CLAIM_INVALID_PROOF";
        }
        if (!hit) return;
        require(result.opt("proof") instanceof String, "CLAIMS_NATIVE_DATA");
        JSONObject completed = transactions.attach(prepared, result.getString("proof"));
        final String expectedTxid = hash(completed.opt("txid"));
        final CompletableFuture<JSONObject> transmission;
        synchronized (this) {
            check(epoch); if (!rowAvailable(row.key)) return;
            // Enqueue and register under the same lifecycle lock: Stop can
            // either precede transmission, or cancel/retain its outcome.
            recordReceipt(expectedTxid, "pending");
            try { transmission = rpc.broadcast(completed.getString("hex")); }
            catch (RuntimeException uncertainEnqueue) { uncertain(expectedTxid); return; }
            operations.add(transmission);
            retired.add(row.key); lastTxid = expectedTxid;
        }
        try {
            JSONObject response;
            try { response = transmission.get(); }
            catch (ExecutionException failure) { if (failure.getCause() instanceof Exception) throw (Exception) failure.getCause(); throw new IllegalStateException("CLAIMS_RPC", failure.getCause()); }
            if (!expectedTxid.equals(response.opt("txid"))) { uncertain(expectedTxid); return; }
            recordReceipt(expectedTxid, "submitted");
            synchronized (this) { submitted = increment(submitted); if (epoch == generation && enabled) status = "submitted"; }
        } catch (MobileRpcClient.RpcFailure error) {
            if (error.unknownOutcome || Integer.valueOf(-27).equals(error.nodeCode)) { uncertain(expectedTxid); return; }
            if (error.code.equals("-32020") && error.nodeCode != null) {
                try { recordReceipt(expectedTxid, "rejected"); } catch (Exception receiptFailure) { uncertain(expectedTxid); return; }
                synchronized (this) { if (epoch == generation) { lastError = "CLAIMS_REJECTED"; nextDiscovery = 0; } } return;
            }
            try { recordReceipt(expectedTxid, "rejected"); } catch (Exception receiptFailure) { uncertain(expectedTxid); return; }
            throw error;
        } catch (Exception unexpected) {
            // An interrupted wait/custom transport failure does not prove
            // non-transmission. Never silently retry the financial operation.
            uncertain(expectedTxid);
        } finally { synchronized (this) { operations.remove(transmission); } }
    }
    private synchronized boolean rowAvailable(String key) { Candidate row = catalog.get(key); return row != null && row.supported && row.state.equals("available") && !retired.contains(key); }
    private synchronized void uncertain(String txid) {
        // Even a simultaneous Stop must retain this information: transmission
        // already occurred and must not become a silently retryable claim.
        lastTxid = txid; unknown = increment(unknown); unknownBlocked = true; enabled = false; pauseClock(); status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME";
        try { recordReceipt(txid, "unknown"); } catch (Exception ignored) { /* The pre-write pending receipt remains a conservative crash guard. */ }
    }

    static final class Ema {
        double connections = 0.1, totalTime = 0.02; long completed, retryAfter;
        void record(boolean success, double seconds) {
            require(Double.isFinite(seconds) && seconds >= 0 && seconds <= 60, "CLAIMS_NATIVE_DATA");
            connections = 0.999 * connections + 0.001 * (success ? 1 : 0); totalTime = 0.999 * totalTime + 0.001 * seconds; completed = increment(completed);
        }
        double rate() { return Math.max(Double.MIN_VALUE, Math.min(Double.MAX_VALUE, connections / Math.max(Double.MIN_VALUE, totalTime))); }
    }
    static final class Candidate {
        final JSONObject bounty; final String key, domain, target, blockHash; final int mask; final long height; final boolean coinbase, supported;
        final BigInteger raw; String state; JSONObject prepared; long validCaptures;
        Candidate(JSONObject source, String expectedBlock, long fee) throws Exception {
            bounty = MobileClaimsEngine.copy(source); hash(bounty.opt("txid")); integer(bounty.opt("vout"), 0, 0xffffffffL);
            require(bounty.opt("amount") instanceof String, "CLAIMS_RPC_DATA"); long amount = NativeTransactions.amount(bounty.getString("amount"));
            target = hash(bounty.opt("connection_work_target")); blockHash = hash(bounty.opt("block_hash")); require(blockHash.equals(expectedBlock), "CLAIMS_RPC_DATA");
            height = integer(bounty.opt("block_height"), 0, SAFE_MAX); integer(bounty.opt("confirmations"), 1, SAFE_MAX);
            require(bounty.opt("coinbase") instanceof Boolean, "CLAIMS_RPC_DATA"); coinbase = bounty.getBoolean("coinbase");
            mask = (int)integer(bounty.opt("signature_algorithms_mask"), 1, 7); long roots = integer(bounty.opt("root_certificates_version"), 1, 0xffffffffL);
            require(bounty.opt("domain") instanceof String, "CLAIMS_RPC_DATA"); domain = bounty.getString("domain");
            require(NativeTransactions.canonicalDomain(domain), "CLAIMS_RPC_DATA");
            state = bounty.optString("status", ""); require(java.util.Arrays.asList("available", "immature", "pending_spend", "spent").contains(state), "CLAIMS_RPC_DATA");
            // These can be valid on-chain outputs, but cannot safely be dialed
            // by this public-only native engine. Do not let one poison others.
            supported = roots == 1 && domain.contains(".") && !domain.matches("[0-9]+(?:\\.[0-9]+){3}") && !domain.endsWith(".localhost") && !domain.endsWith(".local") && !domain.endsWith(".internal");
            key = key(bounty); raw = amount > fee ? new BigInteger(target, 16).add(BigInteger.ONE).multiply(BigInteger.valueOf(amount - fee)) : BigInteger.ZERO;
        }
        Candidate copy() throws Exception { return new Candidate(this); }
        private Candidate(Candidate source) throws Exception { bounty = MobileClaimsEngine.copy(source.bounty); key = source.key; domain = source.domain; target = source.target; blockHash = source.blockHash; mask = source.mask; height = source.height; coinbase = source.coinbase; supported = source.supported; raw = source.raw; state = source.state; prepared = source.prepared; validCaptures = source.validCaptures; }
        boolean budget() { return BigInteger.valueOf(validCaptures).multiply(new BigInteger(target, 16).add(BigInteger.ONE)).compareTo(SPACE.shiftLeft(1)) <= 0; }
    }
    static Candidate select(Iterable<Candidate> candidates, Map<String, Ema> stats, Set<String> retired) {
        Map<String, Candidate> perDomain = new HashMap<>();
        for (Candidate candidate : candidates) {
            if (!candidate.supported || !candidate.state.equals("available") || retired.contains(candidate.key) || !candidate.budget() || candidate.raw.signum() <= 0 || stats.containsKey(candidate.domain) && stats.get(candidate.domain).retryAfter > now()) continue;
            Candidate previous = perDomain.get(candidate.domain);
            if (previous == null || candidate.raw.compareTo(previous.raw) > 0 || candidate.raw.equals(previous.raw) && compareOutpoints(candidate, previous) < 0) perDomain.put(candidate.domain, candidate);
        }
        Candidate best = null; double score = -1;
        for (Candidate candidate : perDomain.values()) {
            double rate = stats.containsKey(candidate.domain) ? stats.get(candidate.domain).rate() : 5;
            double value = candidate.raw.doubleValue() / SPACE.doubleValue() * rate;
            if (!Double.isFinite(value) || value < 1000) continue;
            if (best == null || value > score || value == score && compareOutpoints(candidate, best) < 0) { best = candidate; score = value; }
        }
        return best;
    }
    private static int compareOutpoints(Candidate a, Candidate b) {
        String left = a.bounty.optString("txid"), right = b.bounty.optString("txid");
        for (int index = 62; index >= 0; index -= 2) {
            int difference = Integer.parseInt(left.substring(index, index + 2), 16) - Integer.parseInt(right.substring(index, index + 2), 16);
            if (difference != 0) return difference;
        }
        return Long.compare(a.bounty.optLong("vout"), b.bounty.optLong("vout"));
    }
    public synchronized JSONObject snapshot() {
        try {
            JSONArray measured = new JSONArray();
            for (Map.Entry<String, Ema> entry : domains.entrySet()) { Ema value = entry.getValue(); measured.put(new JSONObject().put("domain", entry.getKey()).put("connections", value.connections).put("totalTime", value.totalTime).put("rate", value.rate()).put("completed", value.completed)); }
            int eligible = 0; for (Candidate row : catalog.values()) if (rowAvailable(row.key) && row.budget()) eligible++;
            long elapsed = elapsedBeforePause + (activeSince == 0 ? 0 : Math.max(0, now() - activeSince));
            return new JSONObject().put("enabled", enabled).put("allowed", allowed).put("running", enabled && allowed && !closed && !unknownBlocked)
                .put("status", status).put("currentDomain", currentDomain).put("eligible", eligible).put("discoveredBlocks", loaded.size()).put("totalBlocks", blocks.size())
                .put("discoveryComplete", cursor != null && loaded.size() == blocks.size()).put("attempts", attempts).put("valid", valid).put("invalid", invalid).put("targetHits", targetHits)
                .put("submitted", submitted).put("unknown", unknown).put("cancelled", cancelled).put("elapsedSeconds", elapsed / 1000.0).put("connectionsPerSecond", elapsed > 0 ? attempts * 1000.0 / elapsed : 0).put("connectionsPerSecondLimit", 4).put("concurrency", 1)
                .put("lastTxid", lastTxid).put("lastError", lastError).put("domains", measured);
        } catch (JSONException impossible) { throw new IllegalStateException("CLAIMS_STATE", impossible); }
    }
}
