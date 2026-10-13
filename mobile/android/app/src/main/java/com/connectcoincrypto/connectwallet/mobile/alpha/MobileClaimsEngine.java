package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto;
import java.math.BigInteger;
import java.security.SecureRandom;
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
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Native claim scheduling, never a WebView signing/broadcast API.
 * Independently paced parallel proof capture. Catalogs are progressive,
 * newest-first and bounded; each complete block is reconciled before use.
 * The process-wide RPC client's active state and other operations are not owned
 * here. Only this engine's futures and native proof handles are cancelled.
 */
public final class MobileClaimsEngine implements AutoCloseable {
    public static final int DEFAULT_CONNECTIONS_PER_SECOND = 100, DEFAULT_CONCURRENCY = 100;
    public static final int MAX_CONNECTIONS_PER_SECOND = 100, MAX_CONCURRENCY = 100;
    private static final String GENESIS = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e";
    private static final long SAFE_MAX = 9007199254740991L;
    private static final int FEE_RATE = 1500, MAX_CATALOG = 10000, MAX_DOMAINS = 512;
    // Admission pauses at MAX_CONCURRENCY reservations; captures already in
    // flight can still produce another MAX_CONCURRENCY verified winners.
    private static final int MAX_RETAINED_WINNERS = 2 * MAX_CONCURRENCY;
    private static final int MAX_PROGRESS = MAX_CATALOG + MAX_RETAINED_WINNERS;
    private static final long START_ACK_POLL_NANOS = TimeUnit.MILLISECONDS.toNanos(20);
    private static final long CATALOG_FRESH_MS = 60000;
    private static final BigInteger SPACE = BigInteger.ONE.shiftLeft(256);
    private static final BigInteger MAX_CAPTURES = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);
    private static final SecureRandom PRIORITY_RANDOM = new SecureRandom();
    private final RpcAccess rpc;
    private final ProofAccess proof;
    private final Transactions transactions;
    private final LongSupplier nanoClock;
    private final long startLimiter;
    private final MobileClaimStartWindow recentStarts = new MobileClaimStartWindow();
    private final ScheduledThreadPoolExecutor worker;
    private final ScheduledThreadPoolExecutor maintenance;
    private final ThreadPoolExecutor captures, submissions;
    private final Map<Long, Capture> activeCaptures = new LinkedHashMap<>();
    private final Set<String> reservations = new HashSet<>();
    private final Set<CompletableFuture<JSONObject>> operations = new HashSet<>();
    private final Map<CompletableFuture<JSONObject>, Winner> pendingTransmissions = new LinkedHashMap<>();
    // Admission stops at 100 reservations; up to 100 already-running captures
    // may still win. Keep every such proof without an unbounded retry queue.
    private final Map<String, Winner> pendingWinners = new LinkedHashMap<>();
    private final Map<String, Candidate> catalog = new LinkedHashMap<>();
    private final Map<String, Candidate.Progress> progress = new LinkedHashMap<>();
    private final MobileClaimParentCache parents = new MobileClaimParentCache(128, 8 * 1024 * 1024);
    private final Map<String, PerformanceWindow> domains = new LinkedHashMap<>();
    private final MobileClaimScheduler scheduler = new MobileClaimScheduler();
    private final Map<String, Long> blocks = new LinkedHashMap<>();
    private MobileClaimBlockWindow blockWindow;
    private final Set<String> loaded = new HashSet<>(), retired = new HashSet<>();
    private String cursor, rewardAddress, currentDomain = "", status = "stopped", lastError = "", lastTxid = "";
    private JSONObject tip, lastRpcError;
    private String lastRpcScope = "";
    private long catalogValidatedAt;
    private long generation, runSerial, captureSerial, attempts, valid, invalid, targetHits, submitted, unknown, cancelled;
    private long elapsedBeforePause, activeSince, nextDiscovery, nextBlock, retryAt, nextAttemptNanos, nextStartAcknowledgementNanos, nextSchedule, nextPreparation;
    private boolean scheduleDirty = true, admissionIdle = true;
    private int connectionsPerSecondLimit = DEFAULT_CONNECTIONS_PER_SECOND, concurrency = DEFAULT_CONCURRENCY;
    private boolean enabled, allowed, closed, healthy, unknownBlocked;
    private ReceiptStore receiptStore;
    public synchronized void configureLimits(int rate, int parallel) {
        require(rate >= 1 && rate <= MAX_CONNECTIONS_PER_SECOND && parallel >= 1 && parallel <= MAX_CONCURRENCY, "CLAIMS_LIMITS");
        if (closed) throw new IllegalStateException("CLAIMS_CLOSED");
        proof.setStartRate(startLimiter, rate);
        resetStartSchedule();
        connectionsPerSecondLimit = rate; concurrency = parallel;
        // Changing settings never releases accumulated tokens as a burst.
        nextAttemptNanos = nanoClock.getAsLong() + intervalNanos(rate);
    }

    /** Public txid/status only; the native owner must durably commit before returning. */
    public interface ReceiptStore { void record(String txid, String status) throws Exception; }
    public synchronized void setReceiptStore(ReceiptStore store) {
        require(store != null && !enabled && operations.isEmpty(), "CLAIMS_RECEIPT_STATE"); receiptStore = store;
    }
    public synchronized void restoreUnknownOutcome(String txid) {
        require(!enabled && operations.isEmpty(), "CLAIMS_RECEIPT_STATE");
        lastTxid = hash(txid); unknownBlocked = true; unknown = Math.max(unknown, 1); status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME";
    }
    /** A stopped engine may still be draining a proof or recording a sent outcome. */
    synchronized boolean canChangeEndpoint() {
        return !closed && !enabled && operations.isEmpty() && pendingTransmissions.isEmpty() &&
            reservations.isEmpty() && activeCaptures.isEmpty();
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
        default CompletableFuture<JSONObject> broadcast(String hex, Object guard, Runnable beforeWrite) {
            synchronized (guard) { beforeWrite.run(); return broadcast(hex); }
        }
        /** True only when the transport atomically proves this job has not begun writing. */
        default boolean cancelBeforeWrite(CompletableFuture<JSONObject> operation) { return false; }
    }
    interface ProofAccess {
        long createStartLimiter(int rate); void setStartRate(long limiter, int rate); void resetStartSchedule(long limiter); void destroyStartLimiter(long limiter);
        long create(long limiter); void cancel(long handle); void destroy(long handle);
        long startedAtNanos(long handle);
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
            public CompletableFuture<JSONObject> broadcast(String hex, Object guard, Runnable beforeWrite) { return client.broadcast(hex, guard, beforeWrite); }
            public boolean cancelBeforeWrite(CompletableFuture<JSONObject> operation) { return client.cancelBeforeWrite(operation); }
        }, new ProofAccess() {
            public long createStartLimiter(int rate) { return NativeClaims.createStartLimiter(rate); }
            public void setStartRate(long limiter, int rate) { NativeClaims.setStartRate(limiter, rate); }
            public void resetStartSchedule(long limiter) { NativeClaims.resetStartSchedule(limiter); }
            public void destroyStartLimiter(long limiter) { NativeClaims.destroyStartLimiter(limiter); }
            public long create(long limiter) { return NativeClaims.createCancellationHandle(limiter); }
            public void cancel(long handle) { NativeClaims.cancel(handle); }
            public void destroy(long handle) { NativeClaims.destroyHandle(handle); }
            public long startedAtNanos(long handle) {
                long observedAt = System.nanoTime();
                long age = NativeClaims.startedAgeNanos(handle);
                return age < 0 ? 0 : observedAt - age;
            }
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
        this(rpc, proof, transactions, schedule, System::nanoTime);
    }
    MobileClaimsEngine(RpcAccess rpc, ProofAccess proof, Transactions transactions, boolean schedule, LongSupplier nanoClock) {
        if (rpc == null || proof == null || transactions == null) throw new IllegalArgumentException("Missing claim dependencies");
        this.rpc = rpc; this.proof = proof; this.transactions = transactions; this.nanoClock = nanoClock;
        startLimiter = proof.createStartLimiter(DEFAULT_CONNECTIONS_PER_SECOND);
        worker = new ScheduledThreadPoolExecutor(1, action -> { Thread thread = new Thread(action, "connectwallet-mobile-claims"); thread.setDaemon(true); return thread; });
        maintenance = new ScheduledThreadPoolExecutor(1, action -> { Thread thread = new Thread(action, "connectwallet-claims-discovery"); thread.setDaemon(true); return thread; });
        captures = new ThreadPoolExecutor(0, MAX_CONCURRENCY, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), action -> { Thread thread = new Thread(action, "connectwallet-claims-capture"); thread.setDaemon(true); return thread; });
        submissions = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(MAX_RETAINED_WINNERS), action -> { Thread thread = new Thread(action, "connectwallet-claims-submit"); thread.setDaemon(true); return thread; });
        worker.setRemoveOnCancelPolicy(true);
        maintenance.setRemoveOnCancelPolicy(true);
        if (schedule) {
            maintenance.scheduleWithFixedDelay(this::maintain, 0, 100, TimeUnit.MILLISECONDS);
            worker.execute(this::dispatchLoop);
        }
    }
    private long now() { return TimeUnit.NANOSECONDS.toMillis(nanoClock.getAsLong()); }
    private static long intervalNanos(int rate) { return (TimeUnit.SECONDS.toNanos(1) + rate - 1) / rate; }
    private static long increment(long value) { return Math.min(SAFE_MAX, value + 1); }
    private static void require(boolean condition, String code) { if (!condition) throw new IllegalArgumentException(code); }
    private static String hash(Object value) { require(value instanceof String && ((String) value).matches("[0-9a-f]{64}"), "CLAIMS_RPC_DATA"); return (String) value; }
    private static long integer(Object value, long min, long max) { require((value instanceof Integer || value instanceof Long) && ((Number) value).longValue() >= min && ((Number) value).longValue() <= max, "CLAIMS_RPC_DATA"); return ((Number) value).longValue(); }
    private static String key(JSONObject bounty) throws JSONException { return bounty.getString("txid") + ":" + bounty.getLong("vout"); }
    private static JSONObject copy(JSONObject value) throws JSONException { return new JSONObject(value.toString()); }
    private static String validCursor(Object value) { require(value instanceof String && ((String) value).matches("[A-Za-z0-9_.-]{1,1024}"), "CLAIMS_RPC_DATA"); return (String) value; }

    public void setAllowed(boolean value) {
        List<CompletableFuture<JSONObject>> pending = null;
        synchronized (this) {
            if (closed || allowed == value) return;
            allowed = value;
            if (!value) { pauseClock(); generation++; pending = new ArrayList<>(operations); discardIdleWinners(); cancelCaptures(null, -1); resetStartSchedule(); acknowledgeStarts(); status = enabled ? "paused" : "stopped"; currentDomain = ""; }
            else if (enabled && !unknownBlocked) { resetStartSchedule(); activeSince = now(); nextDiscovery = 0; status = "synchronizing"; }
        }
        cancelOwned(pending);
    }
    public synchronized void start(String address) {
        if (closed) throw new IllegalStateException("CLAIMS_CLOSED");
        if (unknownBlocked) throw new IllegalStateException("CLAIMS_UNKNOWN_OUTCOME");
        transactions.validateReward(address);
        if (enabled) { require(address.equals(rewardAddress), "Stop claims before changing the reward address."); return; }
        if (!reservations.isEmpty() || !operations.isEmpty()) throw new IllegalStateException("CLAIMS_BUSY");
        resetStartSchedule();
        if (rewardAddress != null && !rewardAddress.equals(address)) for (Candidate.Progress item : progress.values()) item.prepared = null;
        rewardAddress = address; enabled = true; generation++; runSerial++; recentStarts.clear(); elapsedBeforePause = 0; activeSince = allowed ? now() : 0;
        attempts = valid = invalid = targetHits = submitted = unknown = cancelled = 0;
        resetCatalog(); lastError = ""; lastRpcError = null; lastTxid = ""; nextDiscovery = nextBlock = retryAt = nextStartAcknowledgementNanos = nextSchedule = nextPreparation = 0;
        status = allowed ? "synchronizing" : "paused";
    }
    public void stop() {
        List<CompletableFuture<JSONObject>> pending;
        synchronized (this) { if (closed && !enabled) return; enabled = false; pauseClock(); generation++; pending = new ArrayList<>(operations); discardIdleWinners(); cancelCaptures(null, -1); resetStartSchedule(); acknowledgeStarts(); currentDomain = ""; status = unknownBlocked ? "unknown-outcome" : "stopped"; }
        cancelOwned(pending);
    }
    @Override public void close() {
        synchronized (this) { if (closed) return; closed = true; }
        stop();
        synchronized (this) { proof.destroyStartLimiter(startLimiter); }
        worker.shutdownNow(); maintenance.shutdownNow(); captures.shutdown(); submissions.shutdown();
    }
    private void cancelOwned(List<CompletableFuture<JSONObject>> pending) {
        if (pending != null) for (CompletableFuture<JSONObject> operation : pending) operation.cancel(false);
    }
    // Called under the lifecycle lock. Destruction uses that same lock so a
    // cancellation handle can never be cancelled after it has been freed.
    private void cancelCaptures(String outpoint, long except) {
        for (Capture capture : activeCaptures.values()) if (capture.id != except && (outpoint == null || outpoint.equals(capture.row.key)) && !capture.cancelled) {
            capture.cancelled = true; proof.cancel(capture.handle);
        }
    }
    private void resetStartSchedule() {
        admissionIdle = true;
        // Keep native rolling-start history and any future rate deadline.
        // Old cancelled FIFO entries may still be draining after a restart.
        if (!closed) proof.resetStartSchedule(startLimiter);
    }
    private void pruneRetired() { retired.removeIf(key -> !progress.containsKey(key) && !reservations.contains(key)); }
    private void pauseClock() { if (activeSince != 0) { elapsedBeforePause += Math.max(0, now() - activeSince); activeSince = 0; } }
    private synchronized void check(long epoch) { if (closed || !enabled || !allowed || epoch != generation) throw new Stopped(); }
    private static final class Stopped extends RuntimeException { private static final long serialVersionUID = 1L; }
    private synchronized void resetCatalog() { resetCatalog(false); }
    private synchronized void resetCatalog(boolean keepHashAnchor) { catalog.clear(); blocks.clear(); loaded.clear(); scheduler.clear(); scheduleDirty = admissionIdle = true; cursor = null; tip = null; healthy = false; catalogValidatedAt = 0; if (!keepHashAnchor) blockWindow = null; }
    private static final class ChainMoved extends Exception { private static final long serialVersionUID = 1L; }

    /** Discovery reads may retry independently, but never authorize work from an unboundedly old snapshot. */
    private boolean catalogFresh() { return healthy && now() - catalogValidatedAt < CATALOG_FRESH_MS; }
    private void expireCatalogWork() {
        cancelUnsafeQueuedTransmissions();
        discardIdleWinners();
        if (healthy && !catalogFresh()) {
            cancelCaptures(null, -1); admissionIdle = true;
            // Leave transmissions and their outcome/receipt ownership untouched.
            if (enabled && allowed && !unknownBlocked) status = "retrying";
        }
    }
    /** A local quota wait is not transmission. Stop obsolete queued claims
     * without ever cancelling a job that has started its financial write. */
    private void cancelUnsafeQueuedTransmissions() {
        for (Map.Entry<CompletableFuture<JSONObject>, Winner> entry : pendingTransmissions.entrySet()) {
            Winner winner = entry.getValue();
            boolean usable = catalogFresh() && winnerUsable(winner);
            // rowAvailable also excludes retired rows, including this winner's
            // own reservation, so it must not be used for this eligibility test.
            if (!usable && !winner.cancelledBeforeWrite && rpc.cancelBeforeWrite(entry.getKey())) {
                winner.cancelledBeforeWrite = true;
                winner.cancelledForStaleness = winnerUsable(winner) && !catalogFresh();
            }
        }
    }
    private static final class ReadFailure extends Exception {
        private static final long serialVersionUID = 1L;
        final String method; final MobileRpcClient.RpcFailure failure;
        ReadFailure(String method, MobileRpcClient.RpcFailure failure) { super(failure); this.method = method; this.failure = failure; }
    }

    private JSONObject waitFor(CompletableFuture<JSONObject> future, long epoch) throws Exception {
        synchronized (this) { try { check(epoch); } catch (Stopped stopped) { future.cancel(false); throw stopped; } operations.add(future); }
        try { JSONObject result = future.get(); check(epoch); return result; }
        catch (ExecutionException failure) { if (failure.getCause() instanceof Exception) throw (Exception) failure.getCause(); throw new IllegalStateException("CLAIMS_RPC", failure.getCause()); }
        finally { synchronized (this) { operations.remove(future); } }
    }
    private JSONObject request(String method, JSONObject params, long epoch) throws Exception {
        check(epoch);
        try { return waitFor(rpc.call(method, params), epoch); }
        catch (MobileRpcClient.RpcFailure failure) { throw new ReadFailure(method, failure); }
    }
    static JSONObject validateTip(JSONObject value) throws JSONException {
        require(value != null && "main".equals(value.opt("chain")) && GENESIS.equals(value.opt("genesis_hash")), "CLAIMS_WRONG_NETWORK");
        String id = hash(value.opt("hash")); long height = integer(value.opt("height"), 0, SAFE_MAX);
        require(height != 0 || id.equals(GENESIS), "CLAIMS_RPC_DATA");
        integer(value.opt("mediantime"), 1, 253402300799L); return copy(value);
    }
    private void discover(long epoch) throws Exception {
        String originalCursor; MobileClaimBlockWindow known;
        synchronized (this) { originalCursor = cursor; known = blockWindow; }
        // A normal tip race usually settles with one extra pass. Retain the
        // original journal cursor until commit and bound repeated reorgs.
        for (int pass = 0; pass < 3; pass++) {
            String startCursor = originalCursor;
            JSONObject first = request("getbountychanges", startCursor == null ? new JSONObject() : new JSONObject().put("cursor", startCursor), epoch);
            JSONObject expected = validateTip(first.optJSONObject("tip"));
            boolean force = startCursor == null;
            if (startCursor == null) {
                require(first.opt("changes") instanceof JSONArray && first.getJSONArray("changes").length() == 0 && Boolean.FALSE.equals(first.opt("has_more")), "CLAIMS_RPC_DATA");
                startCursor = validCursor(first.opt("next_cursor")); first = null;
            }
            MobileClaimBlockWindow refreshed = refreshWindow(known, expected, force, epoch);
            // Publish recent blocks and deltas together. A failed read cannot
            // make a new tip or partially refreshed catalog visible to workers.
            try {
                replay(epoch, null, null, refreshed.blocks(), startCursor, refreshed, first);
                synchronized (this) { check(epoch); nextDiscovery = now() + 10000; readRecovered("discovery"); }
                return;
            } catch (ChainMoved moved) { if (pass == 2) throw moved; known = refreshed; }
        }
    }
    private MobileClaimBlockWindow refreshWindow(MobileClaimBlockWindow known, JSONObject expected, boolean force, long epoch) throws Exception {
        try { return MobileClaimBlockWindow.refresh(known, expected, force,
            params -> { check(epoch); return waitFor(rpc.call("getrecentblockhashes", params), epoch); }); }
        catch (MobileRpcClient.RpcFailure failure) { throw new ReadFailure("getrecentblockhashes", failure); }
    }
    private void loadBlock(String blockHash, long epoch) throws Exception {
        String originalCursor; MobileClaimBlockWindow known; long blockHeight;
        synchronized (this) { check(epoch); originalCursor = cursor; known = blockWindow; blockHeight = blocks.get(blockHash); }
        Map<String, Candidate> staged = new LinkedHashMap<>();
        try { waitFor(rpc.stream(blockHash, chunk -> {
            check(epoch);
            validateTip(chunk.optJSONObject("tip"));
            if (!"bounties".equals(chunk.opt("type"))) return;
            JSONArray values = chunk.getJSONArray("items");
            for (int index = 0; index < values.length(); index++) {
                Candidate row = new Candidate(values.getJSONObject(index), blockHash, transactions.fee());
                synchronized (this) {
                    require(blocks.containsKey(blockHash) && row.height == blocks.get(blockHash), "CLAIMS_RPC_DATA");
                    Candidate.Progress previous = progress.get(row.key);
                    if (previous != null) row.progress = previous;
                }
                require(staged.put(row.key, row) == null && staged.size() <= MAX_CATALOG, "CLAIMS_CAPACITY");
            }
        }), epoch); } catch (MobileRpcClient.RpcFailure failure) { throw new ReadFailure("getblockbounties", failure); }
        // Reuse the completed stream across ordinary new-block races, but
        // always replay from BEFORE that stream. Advancing the public cursor
        // separately would lose spends that arrived while the stream ran.
        JSONObject first = null; Map<String, Long> recent = null;
        for (int pass = 0; pass < 3; pass++) {
            boolean canonical = known.blocks().containsKey(blockHash) && known.blocks().get(blockHash) == blockHeight;
            try {
                replay(epoch, canonical ? blockHash : null, canonical ? staged : null, recent, originalCursor, known, first);
                break;
            } catch (ChainMoved moved) {
                if (pass == 2) throw moved;
                first = request("getbountychanges", new JSONObject().put("cursor", originalCursor), epoch);
                known = refreshWindow(known, validateTip(first.optJSONObject("tip")), false, epoch);
                recent = known.blocks();
            }
        }
        synchronized (this) { check(epoch); nextBlock = now() + 1500; readRecovered("catalog"); }
    }
    /** Private clone plus delta replay; no partially received block is published. */
    private void replay(long epoch, String newBlock, Map<String, Candidate> staged) throws Exception {
        replay(epoch, newBlock, staged, null, null);
    }
    private void replay(long epoch, String newBlock, Map<String, Candidate> staged, Map<String, Long> recent, String startCursor) throws Exception {
        MobileClaimBlockWindow known;
        synchronized (this) { known = recent == null ? blockWindow : null; }
        replay(epoch, newBlock, staged, recent, startCursor, known, null);
    }
    private void replay(long epoch, String newBlock, Map<String, Candidate> staged, Map<String, Long> recent, String startCursor,
                        MobileClaimBlockWindow window, JSONObject first) throws Exception {
        Map<String, Candidate> next = new LinkedHashMap<>(); String nextCursor; JSONObject nextTip;
        Map<String, Long> canonical; boolean replayAfterFirst;
        Set<String> dirtyBlocks = new HashSet<>();
        long validatedFrom = now();
        synchronized (this) {
            check(epoch);
            for (Candidate row : catalog.values()) if ((recent == null || recent.containsKey(row.blockHash)) && !row.blockHash.equals(newBlock)) next.put(row.key, row.copy());
            nextCursor = startCursor == null ? cursor : startCursor; nextTip = tip;
            canonical = new LinkedHashMap<>(recent == null ? blocks : recent);
            replayAfterFirst = first != null && window != blockWindow;
            // A complete stream replaces that block, including rows that have
            // disappeared. Preserve public accounting for surviving outpoints.
            if (staged != null) for (Candidate source : staged.values()) {
                Candidate row = source.copy();
                Candidate existing = catalog.get(row.key);
                if (existing != null) row.progress = existing.progress;
                next.put(row.key, row);
            }
        }
        require(next.size() <= MAX_CATALOG, "CLAIMS_CAPACITY");
        boolean more = true; long previousSequence = -1;
        for (int page = 0; (more || replayAfterFirst) && page < 20; page++) {
            JSONObject changes = page == 0 && first != null ? first : request("getbountychanges", new JSONObject().put("cursor", nextCursor), epoch);
            if (page > 0 || first == null) replayAfterFirst = false;
            nextTip = validateTip(changes.optJSONObject("tip"));
            require(changes.opt("changes") instanceof JSONArray && changes.opt("has_more") instanceof Boolean, "CLAIMS_RPC_DATA");
            JSONArray events = changes.getJSONArray("changes"); require(events.length() <= 500, "CLAIMS_RPC_DATA");
            for (int index = 0; index < events.length(); index++) if ("resync_required".equals(events.getJSONObject(index).opt("type"))) throw new IllegalArgumentException("CLAIMS_RESYNC");
            if (window != null && !MobileClaimBlockWindow.sameTip(window.tip(), nextTip)) throw new ChainMoved();
            String following = validCursor(changes.opt("next_cursor")); more = changes.getBoolean("has_more");
            require((!more || events.length() > 0) && (events.length() == 0 || !following.equals(nextCursor)), "CLAIMS_RPC_DATA");
            for (int index = 0; index < events.length(); index++) {
                JSONObject event = events.getJSONObject(index);
                long sequence = integer(event.opt("sequence"), 0, SAFE_MAX);
                require(sequence > previousSequence, "CLAIMS_RPC_DATA"); previousSequence = sequence;
                String txid = hash(event.opt("txid")); long vout = integer(event.opt("vout"), 0, 0xffffffffL); String key = txid + ":" + vout;
                String type = event.optString("type", ""); Candidate row = next.get(key);
                if (type.equals("window_exit")) next.remove(key);
                else if (type.equals("added")) {
                    String blockHash = hash(event.opt("block_hash")); long height = integer(event.opt("block_height"), 0, SAFE_MAX);
                    if (row != null) require(row.blockHash.equals(blockHash) && row.height == height, "CLAIMS_RPC_DATA");
                    if (canonical.containsKey(blockHash)) {
                        require(canonical.get(blockHash) == height, "CLAIMS_RPC_DATA");
                        if (row == null) dirtyBlocks.add(blockHash);
                    }
                }
                else if (type.equals("spent") || type.equals("pending_spend")) { hash(event.opt("spending_txid")); if (row != null) row.state = type.equals("spent") ? "spent" : "pending_spend"; }
                else if (type.equals("available_again") || type.equals("matured")) {
                    if (row != null && !row.state.equals("spent") && (type.equals("available_again") || row.state.equals("immature"))) row.state = row.coinbase && nextTip.getLong("height") - row.height + 1 < 100 ? "immature" : "available";
                } else throw new IllegalArgumentException("CLAIMS_RPC_DATA");
            }
            nextCursor = following;
        }
        require(!more && !replayAfterFirst, "CLAIMS_SYNC_BUSY");
        // Never mark mixed-branch rows fresh. This inexpensive fence replaces
        // a second full-window transfer and also protects each progressive block.
        JSONObject finalTip = validateTip(request("getchaintip", new JSONObject(), epoch));
        if (!MobileClaimBlockWindow.sameTip(nextTip, finalTip) || window != null && !MobileClaimBlockWindow.sameTip(window.tip(), finalTip)) throw new ChainMoved();
        synchronized (this) {
            check(epoch);
            Map<String, Long> nextBlocks = recent == null ? blocks : recent;
            if (newBlock != null && !nextBlocks.containsKey(newBlock)) throw new IllegalArgumentException("CLAIMS_SYNC_BUSY");
            Set<String> nextLoaded = new HashSet<>(loaded); nextLoaded.retainAll(nextBlocks.keySet()); if (newBlock != null) nextLoaded.add(newBlock);
            nextLoaded.removeAll(dirtyBlocks);
            Map<String, Candidate.Progress> nextProgress = new LinkedHashMap<>(progress);
            for (Candidate row : next.values()) nextProgress.put(row.key, row.progress);
            Set<String> protectedKeys = new HashSet<>(reservations);
            for (Capture capture : activeCaptures.values()) protectedKeys.add(capture.row.key);
            nextProgress.entrySet().removeIf(item -> (!nextBlocks.containsKey(item.getValue().blockHash) || nextLoaded.contains(item.getValue().blockHash) && !next.containsKey(item.getKey())) && !protectedKeys.contains(item.getKey()));
            // Validate the complete prospective state before publishing any of
            // it: protected old captures/winners can outlive their window.
            require(nextProgress.size() <= MAX_PROGRESS, "CLAIMS_CAPACITY");
            if (recent != null) { blocks.clear(); blocks.putAll(recent); }
            if (window != null) blockWindow = window;
            loaded.clear(); loaded.addAll(nextLoaded); catalog.clear(); catalog.putAll(next);
            progress.clear(); progress.putAll(nextProgress); scheduleDirty = true;
            if (recent != null) {
                Set<String> policies = new HashSet<>(); for (Candidate.Progress item : progress.values()) policies.add(item.policy);
                domains.keySet().retainAll(policies);
            }
            pruneRetired();
            cursor = nextCursor; tip = nextTip; healthy = true; catalogValidatedAt = validatedFrom;
            cancelUnsafeQueuedTransmissions();
        }
    }

    /** Deterministic, unscheduled fixture pulse; production uses independent lanes. */
    void tick() {
        maintain();
        retryWinners(false);
        Capture capture;
        synchronized (this) { capture = reserveCapture(); }
        if (capture != null) capture(capture, false);
    }
    private void maintain() {
        final long epoch;
        synchronized (this) { expireCatalogWork(); if (closed || !enabled || !allowed || unknownBlocked || now() < retryAt) return; epoch = generation; }
        String stage = "discovery", scope = "";
        try {
            if (now() >= nextDiscovery) discover(epoch);
            String missing = null;
            synchronized (this) { for (String block : blocks.keySet()) if (!loaded.contains(block)) { missing = block; break; } }
            stage = "catalog";
            scope = missing == null ? "" : missing;
            if (missing != null && now() >= nextBlock) loadBlock(missing, epoch);
            Candidate candidate;
            synchronized (this) {
                check(epoch); refreshSchedule();
                MobileClaimScheduler.Selection preparation = catalogFresh() ? scheduler.next(now(), false) : null;
                candidate = preparation == null ? null : preparation.row;
                status = !catalogFresh() || pendingReadDiagnostic() ? "retrying" : candidate == null && scheduler.next(now(), true) == null ? (loaded.size() < blocks.size() ? "synchronizing" : "waiting") : "claiming";
            }
            stage = "funding";
            scope = candidate == null ? "" : candidate.key;
            if (candidate != null) prepare(candidate, epoch);
        } catch (Stopped stopped) { /* An explicit lifecycle cancellation is neutral. */ }
        catch (ChainMoved moved) {
            synchronized (this) {
                if (epoch == generation && enabled) {
                    // A normal block race is not a new wallet generation and
                    // must not discard retained, proven-unsent winners.
                    healthy = false; nextDiscovery = 0; retryAt = now() + 1000; status = "retrying";
                    cancelCaptures(null, -1); cancelUnsafeQueuedTransmissions(); resetStartSchedule();
                }
            }
        }
        catch (ReadFailure error) {
            synchronized (this) { if (epoch == generation && enabled) { recordRpcError(error.failure, error.method, stage); lastRpcScope = scope; } }
            if (!retryRead(error.failure, epoch)) failed(error.failure, epoch, false);
        }
        catch (Exception | LinkageError error) { failed(error instanceof JSONException ? new IllegalArgumentException("CLAIMS_RPC_DATA", error) : error, epoch, false); }
    }
    /** This entry point is deliberately confined to maintain() READ failures. */
    private synchronized boolean retryRead(MobileRpcClient.RpcFailure error, long epoch) {
        if (error.unknownOutcome || !java.util.Arrays.asList("RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "-32029", "-32030").contains(error.code)) return false;
        if (epoch != generation || !enabled) return true;
        long delay = error.code.equals("-32029") ? 60000 : 5000;
        delay = Math.max(delay, Math.min(60000, Math.max(0, error.retryAfterMs)));
        retryAt = now() + delay; nextDiscovery = 0; status = "retrying"; lastError = error.code;
        expireCatalogWork();
        // No generation bump, proof cancellation (while fresh), or financial
        // future cancellation. The maintenance lane alone waits its backoff.
        return true;
    }
    private void recordRpcError(MobileRpcClient.RpcFailure failure, String fallbackMethod, String stage) {
        try {
            String method = failure.method;
            if (!java.util.Arrays.asList("getchaintip", "getbountychanges", "getrecentblockhashes", "getblockbounties", "gettransaction", "sendrawtransaction").contains(method)) method = fallbackMethod;
            String phase = failure.phase;
            if (phase == null || !phase.matches("[a-z_]{1,32}")) phase = "unknown";
            lastRpcError = new JSONObject().put("code", failure.code).put("method", method).put("phase", phase).put("stage", stage)
                .put("elapsedMs", boundedDiagnostic(failure.elapsedMs)).put("queuedMs", boundedDiagnostic(failure.queuedMs)).put("bytesReceived", boundedDiagnostic(failure.bytesReceived));
            lastRpcScope = "";
        } catch (JSONException impossible) { throw new IllegalStateException("CLAIMS_STATE", impossible); }
    }
    private static long boundedDiagnostic(long value) { return Math.min(SAFE_MAX, Math.max(0, value)); }
    private boolean pendingReadDiagnostic() { return lastRpcError != null && !"submission".equals(lastRpcError.optString("stage")); }
    private void readRecovered(String stage) {
        String previousStage = lastRpcError == null ? "" : lastRpcError.optString("stage");
        boolean obsolete = false;
        if (stage.equals("discovery") && lastRpcError != null) {
            Candidate pending = catalog.get(lastRpcScope);
            obsolete = previousStage.equals("submission")
                || previousStage.equals("catalog") && (!blocks.containsKey(lastRpcScope) || loaded.contains(lastRpcScope))
                || previousStage.equals("funding") && (pending == null || !rowAvailable(lastRpcScope) || pending.progress.prepared != null);
        }
        if (lastRpcError != null && (stage.equals(previousStage) || obsolete)) {
            if (lastError.equals(lastRpcError.optString("code")) || previousStage.equals("submission") && lastError.equals("CLAIMS_REJECTED")) lastError = "";
            lastRpcError = null; lastRpcScope = "";
        } else if (lastRpcError == null && stage.equals("discovery")) lastError = "";
    }
    private void failed(Throwable error, long epoch) { failed(error, epoch, true); }
    private void failed(Throwable error, long epoch, boolean cancelOperations) {
        List<CompletableFuture<JSONObject>> pending = null;
        synchronized (this) {
            if (epoch != generation || !enabled) return;
            healthy = false; currentDomain = "";
            String code = error instanceof MobileRpcClient.RpcFailure ? ((MobileRpcClient.RpcFailure) error).code : safeCode(error.getMessage());
            if (code.equals("-32011") || code.equals("-32004") || code.equals("CLAIMS_RESYNC")) resetCatalog(true);
            if (code.equals("CLAIMS_WRONG_NETWORK") || code.equals("CLAIMS_CAPACITY") || code.equals("CLAIMS_RPC_DATA") || code.equals("CLAIMS_NATIVE_DATA") || code.equals("CLAIMS_RECEIPT_UNAVAILABLE") || error instanceof LinkageError) { enabled = false; pauseClock(); status = "error"; }
            else { status = "retrying"; retryAt = now() + (code.equals("-32029") ? 60000 : 5000); nextDiscovery = 0; }
            lastError = code; generation++; cancelCaptures(null, -1); resetStartSchedule(); acknowledgeStarts();
            cancelUnsafeQueuedTransmissions();
            // A failed maintenance read is already complete; it must not
            // manufacture an unknown outcome for an unrelated transmission.
            if (cancelOperations) pending = new ArrayList<>(operations);
        }
        cancelOwned(pending);
    }
    private static String safeCode(String value) { return value != null && value.matches("CLAIM[S]?_[A-Z_]{1,40}") ? value : "CLAIMS_FAILED"; }

    private void prepare(Candidate row, long epoch) throws Exception {
        JSONObject prepared;
        synchronized (this) { check(epoch); if (!rowAvailable(row.key)) return; prepared = row.progress.prepared; }
        if (prepared == null) {
            String txid = row.bounty.getString("txid"), parentHex;
            synchronized (this) { parentHex = parents.get(txid); if (parentHex == null && now() < nextPreparation) return; }
            if (parentHex == null) {
                // Keep preparation under the shared RPC method quota. Hashing
                // 100 proofs/s must never mean 100 funding lookups/s.
                synchronized (this) { nextPreparation = now() + 1500; }
                JSONObject parent = request("gettransaction", new JSONObject().put("txid", txid), epoch);
                validateTip(parent.optJSONObject("tip")); JSONObject tx = parent.optJSONObject("transaction");
                require(tx != null && tx.opt("hex") instanceof String, "CLAIMS_RPC_DATA"); parentHex = tx.getString("hex");
            }
            prepared = transactions.prepare(row.bounty, parentHex, rewardAddress);
            synchronized (this) {
                check(epoch); Candidate current = catalog.get(row.key); if (current == null || !rowAvailable(row.key)) return;
                parents.putValidated(txid, parentHex); current.progress.prepared = prepared;
                readRecovered("funding");
            }
        }
    }
    private void dispatchLoop() {
        boolean admitted = dispatch();
        synchronized (this) {
            if (closed) return;
            long remaining = nextAttemptNanos - nanoClock.getAsLong();
            // Compensate for selection/dispatch work already performed. When
            // blocked on capacity/catalog, poll without building a task queue.
            if (!admitted) remaining = Math.max(remaining, TimeUnit.MILLISECONDS.toNanos(2));
            worker.schedule(this::dispatchLoop, Math.max(0, remaining), TimeUnit.NANOSECONDS);
        }
    }
    private boolean dispatch() {
        Capture capture = null; long epoch;
        synchronized (this) { epoch = generation; }
        try {
            retryWinners(true);
            synchronized (this) { capture = reserveCapture(); }
            if (capture != null) {
                final Capture reserved = capture;
                try { captures.execute(() -> capture(reserved, true)); }
                catch (RejectedExecutionException saturated) { releaseCapture(reserved); }
            }
        } catch (Exception | LinkageError error) { if (capture != null) releaseCapture(capture); failed(error, epoch); }
        return capture != null;
    }
    private Capture reserveCapture() {
        long admittedAt = nanoClock.getAsLong();
        if (admittedAt >= nextStartAcknowledgementNanos) acknowledgeStarts();
        expireCatalogWork();
        if (closed || !enabled || !allowed || unknownBlocked || !catalogFresh() || reservations.size() >= MAX_CONCURRENCY) { admissionIdle = true; return null; }
        // Full capacity is still continuous demand; preserve the global phase.
        if (activeCaptures.size() >= concurrency || admittedAt < nextAttemptNanos) return null;
        refreshSchedule(); MobileClaimScheduler.Selection selection = scheduler.next(now(), true);
        if (selection == null) { admissionIdle = true; return null; }
        Candidate row = selection.row;
        if (!rowAvailable(row.key) || !row.budget()) { scheduler.remove(row.key); return null; }
        if (!selection.recovery && !MobileClaimScheduler.worth(row.raw, MobileClaimScheduler.rate(row, domains))) { scheduleDirty = true; return null; }
        if (!domains.containsKey(row.policy)) { require(domains.size() < MAX_DOMAINS * 7, "CLAIMS_CAPACITY"); domains.put(row.policy, new PerformanceWindow(this::now)); }
        Capture capture = new Capture(++captureSerial, generation, runSerial, row, proof.create(startLimiter), selection);
        activeCaptures.put(capture.id, capture); currentDomain = row.domain;
        scheduler.reserve(selection);
        // Idle time earns no credit. Advance first, then retain at most one
        // second of debt, using time after ACK/selection/handle creation work.
        // This phase is global; native independently caps actual TCP starts.
        long pacedAt = nanoClock.getAsLong();
        if (admissionIdle) nextAttemptNanos = Math.max(nextAttemptNanos, pacedAt);
        nextAttemptNanos += intervalNanos(connectionsPerSecondLimit);
        nextAttemptNanos = Math.max(nextAttemptNanos, pacedAt - TimeUnit.SECONDS.toNanos(1));
        admissionIdle = false;
        return capture;
    }
    private void refreshSchedule() {
        if (scheduleDirty || now() >= nextSchedule) {
            scheduler.rebuild(catalog.values(), domains, retired, now()); scheduleDirty = false; nextSchedule = now() + 5000;
        }
    }
    /** Dispatch scans are bounded to once per 20ms, even at full capacity.
     * Lifecycle/snapshot scans and per-capture completion/destruction bypass
     * that throttle; native timestamps are recorded exactly once. */
    private void acknowledgeStarts() {
        nextStartAcknowledgementNanos = nanoClock.getAsLong() + START_ACK_POLL_NANOS;
        for (Capture capture : activeCaptures.values()) acknowledgeStart(capture);
    }
    private void acknowledgeStart(Capture capture) {
        if (capture.started) return;
        long startedAt = proof.startedAtNanos(capture.handle);
        if (startedAt == 0) return;
        capture.started = true;
        scheduler.acknowledge(capture.selection, TimeUnit.NANOSECONDS.toMillis(startedAt));
        if (capture.run != runSerial) return;
        attempts = increment(attempts);
        recentStarts.record(startedAt, nanoClock.getAsLong());
    }
    private static final class Capture {
        final long id, epoch, run, handle; final Candidate row; final MobileClaimScheduler.Selection selection; boolean cancelled, started;
        Capture(long id, long epoch, long run, Candidate row, long handle, MobileClaimScheduler.Selection selection) { this.id = id; this.epoch = epoch; this.run = run; this.row = row; this.handle = handle; this.selection = selection; }
    }
    private synchronized void releaseCapture(Capture capture) {
        if (activeCaptures.remove(capture.id) == null) return;
        acknowledgeStart(capture);
        scheduler.release(capture.selection);
        proof.destroy(capture.handle);
        currentDomain = activeCaptures.isEmpty() ? "" : activeCaptures.values().iterator().next().row.domain;
    }
    private void capture(Capture capture, boolean asyncSubmit) {
        try { captureResult(capture, asyncSubmit); }
        catch (Stopped stopped) { /* Cancellation is neutral, not a performance sample. */ }
        catch (Exception | LinkageError error) { failed(error, capture.epoch); }
        finally { releaseCapture(capture); }
    }
    private void captureResult(Capture capture, boolean asyncSubmit) throws Exception {
        Candidate row = capture.row; long epoch = capture.epoch;
        JSONObject prepared = row.progress.prepared, result;
        try {
            JSONObject context;
            synchronized (this) {
                check(epoch); if (capture.cancelled || !catalogFresh() || !rowAvailable(row.key)) throw new Stopped();
                context = new JSONObject().put("domain", row.domain).put("challenge", prepared.getString("challenge")).put("target", row.target)
                    .put("rootVersion", 1).put("mask", row.mask).put("validationTime", tip.getLong("mediantime"));
            }
            result = proof.capture(context, capture.handle);
            synchronized (this) { acknowledgeStart(capture); check(epoch); if (capture.cancelled) throw new Stopped(); }
        } catch (Stopped stopped) { countCancelled(capture); throw stopped; }
        catch (IllegalStateException failure) {
            if ("CLAIM_CANCELLED".equals(failure.getMessage())) { countCancelled(capture); throw new Stopped(); }
            if (java.util.Arrays.asList("CLAIM_DNS", "CLAIM_CONTEXT", "CLAIM_TIMEOUT", "CLAIM_BUSY", "CLAIM_LOCAL_UNAVAILABLE").contains(failure.getMessage())) {
                synchronized (this) {
                    check(epoch);
                    if ("CLAIM_DNS".equals(failure.getMessage())) { domains.get(row.policy).retryAfter = now() + 2000; scheduleDirty = true; }
                    if (!pendingReadDiagnostic()) lastError = failure.getMessage();
                }
                return; // No invented latency sample; local pre-TCP failures do not pause the policy.
            }
            throw failure; // DNS/setup/busy failures have no completed TCP/TLS sample.
        }
        require(capture.started && result.opt("validProof") instanceof Boolean && result.opt("meetsTarget") instanceof Boolean && result.opt("captured") instanceof Boolean && result.opt("validationPassed") instanceof Boolean, "CLAIMS_NATIVE_DATA");
        boolean verified = result.getBoolean("validProof"), hit = result.getBoolean("meetsTarget");
        boolean captured = result.getBoolean("captured"), validationPassed = result.getBoolean("validationPassed");
        require((!verified || validationPassed) && (!validationPassed || captured), "CLAIMS_NATIVE_DATA");
        long duration = integer(result.opt("durationMs"), 0, 60000);
        require(!hit || verified, "CLAIMS_NATIVE_DATA");
        require(result.opt("proof") instanceof String && (verified || result.getString("proof").isEmpty()), "CLAIMS_NATIVE_DATA");
        String nativeCode = result.optString("errorCode", "");
        boolean locallyUnavailable = nativeCode.equals("CLAIM_LOCAL_UNAVAILABLE");
        require(!locallyUnavailable || !captured && !validationPassed && !verified && !hit, "CLAIMS_NATIVE_DATA");
        synchronized (this) {
            check(epoch);
            // A missing local route/family says nothing about the server's
            // speed. Preserve real attempts/failures without poisoning rank.
            if (!locallyUnavailable) domains.get(row.policy).record(validationPassed, duration / 1000.0);
            if (captured) { row.progress.captures = row.progress.captures.add(BigInteger.ONE).min(MAX_CAPTURES); if (!row.budget()) scheduler.remove(row.key); }
            if (validationPassed) valid = increment(valid); else invalid = increment(invalid);
            if (hit) targetHits = increment(targetHits);
            if (!pendingReadDiagnostic()) lastError = verified ? "" : java.util.Arrays.asList("CLAIM_NETWORK", "CLAIM_TLS", "CLAIM_CERTIFICATE", "CLAIM_TIMEOUT", "CLAIM_LOCAL_UNAVAILABLE").contains(nativeCode) ? nativeCode : "CLAIM_INVALID_PROOF";
        }
        if (!hit) return;
        require(result.opt("proof") instanceof String, "CLAIMS_NATIVE_DATA");
        Winner winner = new Winner(row, prepared, result.getString("proof"), epoch);
        synchronized (this) {
            check(epoch);
            if (capture.cancelled || !rowAvailable(row.key) || !catalog.get(row.key).blockHash.equals(row.blockHash)) return;
            // Freshness expiring as verification completes pauses broadcasting,
            // not retention of this already-validated, still-owned proof.
            require(pendingWinners.size() < MAX_RETAINED_WINNERS, "CLAIMS_CAPACITY");
            retired.add(row.key); scheduler.remove(row.key); reservations.add(row.key); cancelCaptures(row.key, capture.id);
            pendingWinners.put(row.key, winner);
        }
        queueWinner(winner, asyncSubmit);
    }
    private void queueWinner(Winner winner, boolean asyncSubmit) {
        synchronized (this) {
            if (pendingWinners.get(winner.row.key) != winner || winner.scheduled || winner.retryDue > now()) return;
            winner.scheduled = true; winner.keepForRetry = false;
        }
        Runnable submit = () -> {
            try { submit(winner); }
            catch (Stopped stopped) { /* A queued winner was stopped before transmission. */ }
            catch (Exception | LinkageError failure) { failed(failure, winner.epoch); }
            finally {
                synchronized (MobileClaimsEngine.this) {
                    winner.scheduled = false;
                    if (!winner.keepForRetry || !winnerUsable(winner)) releaseWinner(winner);
                }
            }
        };
        if (asyncSubmit) {
            try { submissions.execute(submit); }
            catch (RejectedExecutionException stopped) { releaseWinner(winner); throw new Stopped(); }
        } else submit.run();
    }
    private static final class Winner {
        final Candidate row; final JSONObject prepared; final String proof; final long epoch;
        boolean transmissionAttempted, cancelledBeforeWrite, cancelledForStaleness, scheduled, keepForRetry;
        String transactionHex, txid;
        long retryDue;
        int failures;
        Winner(Candidate row, JSONObject prepared, String proof, long epoch) { this.row = row; this.prepared = prepared; this.proof = proof; this.epoch = epoch; }
    }
    private synchronized void releaseWinner(Winner winner) {
        if (pendingWinners.get(winner.row.key) != winner) return;
        pendingWinners.remove(winner.row.key);
        reservations.remove(winner.row.key);
        // A winner queued behind another output has not been sent yet. Pause,
        // offline and transient discovery failures must not retire it forever.
        if (!winner.transmissionAttempted) { retired.remove(winner.row.key); scheduleDirty = true; }
    }
    private boolean winnerUsable(Winner winner) {
        Candidate current = catalog.get(winner.row.key);
        return !closed && enabled && allowed && !unknownBlocked && winner.epoch == generation
            && pendingWinners.get(winner.row.key) == winner && reservations.contains(winner.row.key)
            && current != null && current.supported && current.state.equals("available")
            && current.blockHash.equals(winner.row.blockHash);
    }
    private void discardIdleWinners() {
        for (Winner winner : new ArrayList<>(pendingWinners.values())) if (!winner.scheduled && !winnerUsable(winner)) releaseWinner(winner);
    }
    private void retryWinners(boolean asynchronous) {
        List<Winner> due = new ArrayList<>();
        synchronized (this) {
            discardIdleWinners();
            if (!catalogFresh()) return;
            for (Winner winner : pendingWinners.values()) if (!winner.scheduled && winner.retryDue <= now() && winnerUsable(winner)) due.add(winner);
        }
        for (Winner winner : due) queueWinner(winner, asynchronous);
    }
    private synchronized void retainUnsentWinner(Winner winner, String code, long retryAfterMs) {
        if (!winnerUsable(winner)) return;
        boolean transientFailure = java.util.Arrays.asList("RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "-32029", "-32030").contains(code);
        if (!transientFailure && !(code.equals("RPC_CANCELLED") && winner.cancelledForStaleness)) return;
        long delay = Math.max(Math.min(30000L, 1000L << winner.failures), Math.max(0, retryAfterMs));
        winner.failures = Math.min(5, winner.failures + 1);
        winner.retryDue = now() + Math.min(SAFE_MAX - now(), delay);
        winner.keepForRetry = true; status = "retrying"; lastError = code;
    }
    private synchronized void countCancelled(Capture capture) {
        // Stop invalidates an epoch, but keep its cancellation counter until a
        // NEW run starts. Old workers may not mutate that new run's counters.
        if (capture.epoch == generation || !enabled && capture.epoch + 1 == generation) cancelled = increment(cancelled);
    }
    private void submit(Winner winner) throws Exception {
        Candidate row = winner.row; long epoch = winner.epoch;
        check(epoch);
        if (winner.transactionHex == null) {
            JSONObject completed = transactions.attach(winner.prepared, winner.proof);
            winner.txid = hash(completed.opt("txid")); winner.transactionHex = completed.getString("hex");
        }
        final String expectedTxid = winner.txid;
        final CompletableFuture<JSONObject> transmission;
        synchronized (this) {
            check(epoch); if (!winnerUsable(winner)) return;
            if (!catalogFresh()) {
                // Queued behind another output, or a retry whose read refresh
                // is still pending: no transmission has been enqueued here.
                winner.keepForRetry = true; winner.retryDue = now() + 1000; status = "retrying";
                return;
            }
            // Enqueue and register under the same lifecycle lock: Stop can
            // either precede transmission, or cancel/retain its outcome.
            recordReceipt(expectedTxid, "pending");
            winner.transmissionAttempted = true; winner.cancelledBeforeWrite = winner.cancelledForStaleness = false;
            try { transmission = rpc.broadcast(winner.transactionHex, this, () -> {
                check(epoch);
                if (!catalogFresh() || !winnerUsable(winner)) {
                    winner.cancelledForStaleness = winnerUsable(winner) && !catalogFresh();
                    throw new Stopped();
                }
            }); }
            catch (RuntimeException uncertainEnqueue) { uncertain(expectedTxid); return; }
            operations.add(transmission);
            pendingTransmissions.put(transmission, winner);
            lastTxid = expectedTxid;
        }
        try {
            JSONObject response;
            try { response = transmission.get(); }
            catch (ExecutionException failure) { if (failure.getCause() instanceof Exception) throw (Exception) failure.getCause(); throw new IllegalStateException("CLAIMS_RPC", failure.getCause()); }
            if (!expectedTxid.equals(response.opt("txid"))) { uncertain(expectedTxid); return; }
            recordReceipt(expectedTxid, "submitted");
            synchronized (this) { submitted = increment(submitted); if (epoch == generation && enabled && lastRpcError == null && catalogFresh()) status = "submitted"; }
        } catch (MobileRpcClient.RpcFailure error) {
            synchronized (this) { if (epoch == generation) recordRpcError(error, "sendrawtransaction", "submission"); }
            if (error.unknownOutcome || Integer.valueOf(-27).equals(error.nodeCode)) { uncertain(expectedTxid); return; }
            if (error.notSent) {
                if (!notSent(winner, expectedTxid)) return;
                retainUnsentWinner(winner, error.code, error.retryAfterMs);
                return;
            }
            if (winner.cancelledBeforeWrite && error.code.equals("RPC_CANCELLED")) {
                if (notSent(winner, expectedTxid)) retainUnsentWinner(winner, error.code, error.retryAfterMs);
                return;
            }
            if (error.explicitRejection && error.code.equals("-32020") && error.nodeCode != null) {
                try { recordReceipt(expectedTxid, "rejected"); } catch (Exception receiptFailure) { uncertain(expectedTxid); return; }
                synchronized (this) { if (epoch == generation) { lastError = "CLAIMS_REJECTED"; nextDiscovery = 0; } } return;
            }
            if (error.explicitRejection) {
                try { recordReceipt(expectedTxid, "rejected"); } catch (Exception receiptFailure) { uncertain(expectedTxid); return; }
                synchronized (this) { if (epoch == generation) { lastError = "CLAIMS_REJECTED"; nextDiscovery = 0; } }
                return;
            }
            // False unknownOutcome alone is not positive evidence of no write.
            uncertain(expectedTxid);
        } catch (Exception unexpected) {
            synchronized (this) {
                if (winner.cancelledBeforeWrite) {
                    if (notSent(winner, expectedTxid)) retainUnsentWinner(winner, "RPC_CANCELLED", 0);
                    return;
                }
            }
            // An interrupted wait/custom transport failure does not prove
            // non-transmission. Never silently retry the financial operation.
            uncertain(expectedTxid);
        } finally { synchronized (this) { operations.remove(transmission); pendingTransmissions.remove(transmission); } }
    }
    private synchronized boolean notSent(Winner winner, String txid) {
        try {
            recordReceipt(txid, "not-sent");
            // ReleaseWinner may make this output eligible again only after the
            // durable pending receipt has been replaced by proven non-sending.
            winner.transmissionAttempted = false;
            return true;
        } catch (Exception receiptFailure) { uncertain(txid); return false; }
    }
    private synchronized boolean rowAvailable(String key) { Candidate row = catalog.get(key); return row != null && row.supported && row.state.equals("available") && !retired.contains(key); }
    private synchronized void uncertain(String txid) {
        // Even a simultaneous Stop must retain this information: transmission
        // already occurred and must not become a silently retryable claim.
        lastTxid = txid; unknown = increment(unknown); unknownBlocked = true; enabled = false; pauseClock(); status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME";
        try { recordReceipt(txid, "unknown"); } catch (Exception ignored) { /* The pre-write pending receipt remains a conservative crash guard. */ }
        generation++; discardIdleWinners(); cancelCaptures(null, -1); resetStartSchedule(); acknowledgeStarts(); cancelOwned(new ArrayList<>(operations));
    }

    /** Bounded hour of real observations, matching the native claimer. The
     * permanent 5-connection / 1-second prior never changes public counters.
     * All operations run under the engine lock; samples cost O(1), and only a
     * minute transition scans the fixed 60 buckets to avoid subtraction drift. */
    static final class PerformanceWindow {
        private final long[] counts = new long[60], successes = new long[60];
        private final double[] seconds = new double[60];
        private final LongSupplier clock;
        private long minute = -1;
        long observations, connections, completed, retryAfter;
        double totalTime;
        PerformanceWindow() { this(() -> TimeUnit.NANOSECONDS.toMillis(System.nanoTime())); }
        PerformanceWindow(LongSupplier clock) { this.clock = java.util.Objects.requireNonNull(clock); }
        void advance() {
            long current = Math.max(minute, Math.max(0, clock.getAsLong()) / 60000);
            if (minute < 0) { minute = current; return; }
            if (current == minute) return;
            if (current - minute >= 60) {
                java.util.Arrays.fill(counts, 0); java.util.Arrays.fill(successes, 0); java.util.Arrays.fill(seconds, 0);
            } else for (long next = minute + 1; next <= current; next++) {
                int slot = (int)(next % 60); counts[slot] = successes[slot] = 0; seconds[slot] = 0;
            }
            observations = connections = 0; totalTime = 0;
            for (int slot = 0; slot < 60; slot++) {
                observations += counts[slot]; connections += successes[slot]; totalTime += seconds[slot];
            }
            minute = current;
        }
        void record(boolean success, double seconds) {
            require(Double.isFinite(seconds) && seconds >= 0 && seconds <= 60, "CLAIMS_NATIVE_DATA");
            advance(); int slot = (int)(minute % 60);
            counts[slot]++; observations++;
            if (success) { successes[slot]++; connections++; }
            this.seconds[slot] += seconds; totalTime += seconds; completed = increment(completed);
        }
        double rate() { advance(); return Math.max(Double.MIN_VALUE, Math.min(Double.MAX_VALUE, (5.0 + connections) / (1.0 + totalTime))); }
    }
    static final class Candidate {
        final JSONObject bounty; final String key, domain, policy, target, blockHash; final int mask; final long height; final boolean coinbase, supported;
        final BigInteger raw, targetPlusOne, captureStopCount;
        final String outpointOrder; final long outputIndex;
        private BigInteger cachedPriority; private int cachedFactor;
        String state; Progress progress;
        static final class Progress {
            final int factor; final String blockHash, policy;
            JSONObject prepared; BigInteger captures = BigInteger.ZERO;
            Progress(int factor, String blockHash, String policy) {
                require(factor >= MobileClaimScheduler.FACTOR_SCALE && factor <= MobileClaimScheduler.FACTOR_MAX, "CLAIMS_PRIORITY_FACTOR");
                this.factor = factor; this.blockHash = blockHash; this.policy = policy;
            }
        }
        Candidate(JSONObject source, String expectedBlock, long fee) throws Exception {
            this(source, expectedBlock, fee, MobileClaimScheduler.FACTOR_SCALE + PRIORITY_RANDOM.nextInt(MobileClaimScheduler.FACTOR_MAX - MobileClaimScheduler.FACTOR_SCALE + 1));
        }
        Candidate(JSONObject source, String expectedBlock, long fee, int factor) throws Exception {
            bounty = MobileClaimsEngine.copy(source); hash(bounty.opt("txid")); integer(bounty.opt("vout"), 0, 0xffffffffL);
            require(bounty.opt("amount") instanceof String, "CLAIMS_RPC_DATA"); long amount = NativeTransactions.amount(bounty.getString("amount"));
            target = hash(bounty.opt("connection_work_target")); blockHash = hash(bounty.opt("block_hash")); require(blockHash.equals(expectedBlock), "CLAIMS_RPC_DATA");
            height = integer(bounty.opt("block_height"), 0, SAFE_MAX); integer(bounty.opt("confirmations"), 1, SAFE_MAX);
            require(bounty.opt("coinbase") instanceof Boolean, "CLAIMS_RPC_DATA"); coinbase = bounty.getBoolean("coinbase");
            mask = (int)integer(bounty.opt("signature_algorithms_mask"), 1, 7); long roots = integer(bounty.opt("root_certificates_version"), 1, 0xffffffffL);
            require(bounty.opt("domain") instanceof String, "CLAIMS_RPC_DATA"); domain = bounty.getString("domain");
            require(NativeTransactions.canonicalDomain(domain), "CLAIMS_RPC_DATA");
            policy = domain + ":" + mask;
            state = bounty.optString("status", ""); require(java.util.Arrays.asList("available", "immature", "pending_spend", "spent").contains(state), "CLAIMS_RPC_DATA");
            // These can be valid on-chain outputs, but cannot safely be dialed
            // by this public-only native engine. Do not let one poison others.
            supported = roots == 1 && domain.contains(".") && !domain.matches("[0-9]+(?:\\.[0-9]+){3}") && !domain.endsWith(".localhost") && !domain.endsWith(".local") && !domain.endsWith(".internal");
            key = key(bounty); targetPlusOne = new BigInteger(target, 16).add(BigInteger.ONE); raw = amount > fee ? targetPlusOne.multiply(BigInteger.valueOf(amount - fee)) : BigInteger.ZERO;
            captureStopCount = SPACE.shiftLeft(1).divide(targetPlusOne).add(BigInteger.ONE).min(MAX_CAPTURES);
            String txid = bounty.getString("txid"); StringBuilder order = new StringBuilder(64);
            for (int index = 62; index >= 0; index -= 2) order.append(txid, index, index + 2);
            outpointOrder = order.toString(); outputIndex = bounty.getLong("vout");
            progress = new Progress(factor, blockHash, policy);
        }
        Candidate copy() throws Exception { return new Candidate(this); }
        private Candidate(Candidate source) throws Exception { bounty = MobileClaimsEngine.copy(source.bounty); key = source.key; domain = source.domain; policy = source.policy; target = source.target; blockHash = source.blockHash; mask = source.mask; height = source.height; coinbase = source.coinbase; supported = source.supported; raw = source.raw; targetPlusOne = source.targetPlusOne; captureStopCount = source.captureStopCount; outpointOrder = source.outpointOrder; outputIndex = source.outputIndex; state = source.state; progress = source.progress; }
        BigInteger priority() {
            if (cachedPriority == null || cachedFactor != progress.factor) { cachedFactor = progress.factor; cachedPriority = raw.multiply(BigInteger.valueOf(cachedFactor)); }
            return cachedPriority;
        }
        boolean budget() { return progress.captures.compareTo(captureStopCount) < 0; }
    }
    static Candidate select(Iterable<Candidate> candidates, Map<String, PerformanceWindow> stats, Set<String> retired) {
        Map<String, Candidate> perDomain = new HashMap<>();
        for (Candidate candidate : candidates) {
            if (!candidate.supported || !candidate.state.equals("available") || retired.contains(candidate.key) || !candidate.budget() || candidate.raw.signum() <= 0 || stats.containsKey(candidate.policy) && stats.get(candidate.policy).retryAfter > TimeUnit.NANOSECONDS.toMillis(System.nanoTime())) continue;
            double rate = MobileClaimScheduler.rate(candidate, stats);
            if (!MobileClaimScheduler.worth(candidate.raw, rate)) continue;
            Candidate previous = perDomain.get(candidate.domain);
            double value = MobileClaimScheduler.score(candidate.priority(), rate, MobileClaimScheduler.FACTOR_SCALE);
            double prior = previous == null ? -1 : MobileClaimScheduler.score(previous.priority(), MobileClaimScheduler.rate(previous, stats), MobileClaimScheduler.FACTOR_SCALE);
            if (previous == null || value > prior || value == prior && MobileClaimScheduler.compare(candidate, previous) < 0) perDomain.put(candidate.domain, candidate);
        }
        Candidate best = null; double score = -1;
        for (Candidate candidate : perDomain.values()) {
            double value = MobileClaimScheduler.score(candidate.priority(), MobileClaimScheduler.rate(candidate, stats), MobileClaimScheduler.FACTOR_SCALE);
            if (!Double.isFinite(value)) continue;
            if (best == null || value > score || value == score && MobileClaimScheduler.compare(candidate, best) < 0) { best = candidate; score = value; }
        }
        return best;
    }
    static int compareOutpoints(Candidate a, Candidate b) {
        int difference = a.outpointOrder.compareTo(b.outpointOrder);
        return difference != 0 ? difference : Long.compare(a.outputIndex, b.outputIndex);
    }
    public synchronized JSONObject snapshot() {
        try {
            acknowledgeStarts();
            JSONArray measured = new JSONArray();
            for (Map.Entry<String, PerformanceWindow> entry : domains.entrySet()) { PerformanceWindow value = entry.getValue(); double measuredRate = value.rate(); String policy = entry.getKey(); int separator = policy.lastIndexOf(':'); measured.put(new JSONObject().put("domain", policy.substring(0, separator)).put("signatureAlgorithmsMask", Integer.parseInt(policy.substring(separator + 1))).put("connections", value.connections).put("totalTime", value.totalTime).put("rate", measuredRate).put("completed", value.completed)); }
            int eligible = 0; for (Candidate row : catalog.values()) if (rowAvailable(row.key) && row.budget()) eligible++;
            long elapsed = elapsedBeforePause + (activeSince == 0 ? 0 : Math.max(0, now() - activeSince));
            return new JSONObject().put("enabled", enabled).put("allowed", allowed).put("running", enabled && allowed && !closed && !unknownBlocked)
                .put("status", status).put("currentDomain", currentDomain).put("eligible", eligible).put("discoveredBlocks", loaded.size()).put("totalBlocks", blocks.size())
                .put("discoveryComplete", cursor != null && loaded.size() == blocks.size()).put("attempts", attempts).put("valid", valid).put("invalid", invalid).put("targetHits", targetHits)
                .put("submitted", submitted).put("unknown", unknown).put("cancelled", cancelled).put("elapsedSeconds", elapsed / 1000.0).put("connectionsPerSecond", recentStarts.rate(nanoClock.getAsLong())).put("connectionsPerSecondLimit", connectionsPerSecondLimit).put("concurrency", concurrency).put("activeConnections", activeCaptures.size())
                .put("lastTxid", lastTxid).put("lastError", lastError).put("lastRpcError", lastRpcError == null ? JSONObject.NULL : copy(lastRpcError)).put("domains", measured);
        } catch (JSONException impossible) { throw new IllegalStateException("CLAIMS_STATE", impossible); }
    }
}
