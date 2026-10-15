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
    // The default journal can hold 10,000 events in 100-event pages. Leave
    // room for the fence replay without allowing an unbounded maintenance
    // pass. Smaller pages or continuous growth fall back to a coherent reset.
    private static final int MAX_REPLAY_PAGES = 128;
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
    // Public signed bytes only. An RPC ACK is not chain confirmation; paused
    // proven-unsent work also survives without occupying a submission slot.
    private final Map<String, Winner> savedWinners = new LinkedHashMap<>();
    private final Map<String, Candidate> catalog = new LinkedHashMap<>();
    // Partial enriched blocks are never scheduler-visible. Keep their full
    // validated identities until a stream proves completeness (or the block
    // exits), so advancing the journal cannot erase consistency evidence.
    private final Map<String, Map<String, Candidate>> feedCandidates = new LinkedHashMap<>();
    private final Set<String> feedNeedsStream = new HashSet<>();
    // Only already-dispatched captures and verified winners may outlive the
    // discovery window. These rows are NEVER scheduler candidates.
    private final Map<String, Retained> retained = new LinkedHashMap<>();
    private final Set<String> resyncBlocks = new HashSet<>();
    private boolean catalogGate, resyncSnapshotPending, replayPending;
    private final Map<String, Candidate.Progress> progress = new LinkedHashMap<>();
    private final MobileClaimParentCache parents = new MobileClaimParentCache(128, 8 * 1024 * 1024);
    private final NativeTransactions.FundingTransactionCache fundingValidation = new NativeTransactions.FundingTransactionCache();
    private final Map<String, PerformanceWindow> domains = new LinkedHashMap<>();
    private final MobileClaimScheduler scheduler = new MobileClaimScheduler();
    private final Map<String, Long> blocks = new LinkedHashMap<>();
    private MobileClaimBlockWindow blockWindow;
    private long capabilityEpoch = Long.MIN_VALUE;
    private int compactVersion = 3;
    private boolean enrichedFeed = true, blockDeltas = true, bountyCounts = true, rawFunding = true, compactReceipts = true;
    private final Set<String> loaded = new HashSet<>(), retired = new HashSet<>();
    private String cursor, rewardAddress, currentDomain = "", status = "stopped", lastError = "", lastTxid = "";
    private JSONObject tip, lastRpcError;
    private String lastRpcScope = "";
    private long catalogValidatedAt;
    private long generation, runSerial, captureSerial, attempts, valid, invalid, targetHits, submitted, unknown, cancelled, nextReceiptLookup;
    private long elapsedBeforePause, activeSince, nextDiscovery, nextBlock, retryAt, nextAttemptNanos, nextStartAcknowledgementNanos, nextSchedule, nextPreparation;
    private boolean scheduleDirty = true, admissionIdle = true;
    private int connectionsPerSecondLimit = DEFAULT_CONNECTIONS_PER_SECOND, concurrency = DEFAULT_CONCURRENCY;
    private boolean enabled, allowed, closed, healthy, unknownBlocked;
    private ReceiptStore receiptStore;
    // Positive transport/Core evidence survives a failed final receipt only in
    // this owner. A restored pending receipt cannot infer a terminal state.
    private enum ReceiptState {
        NOT_SENT("not-sent"), REJECTED("rejected"), SUBMITTED("submitted");
        final String value;
        ReceiptState(String value) { this.value = value; }
    }
    private static final class UncommittedReceipt {
        final Winner winner; final ReceiptState state;
        UncommittedReceipt(Winner winner, ReceiptState state) { this.winner = winner; this.state = state; }
    }
    private UncommittedReceipt uncommittedReceipt;
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
        lastTxid = hash(txid); uncommittedReceipt = null; unknownBlocked = true; unknown = Math.max(unknown, 1); status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME";
    }
    /** A stopped engine may still be draining a proof or recording a sent outcome. */
    synchronized boolean canChangeEndpoint() {
        return !closed && !enabled && operations.isEmpty() && pendingTransmissions.isEmpty() &&
            reservations.isEmpty() && activeCaptures.isEmpty() && savedWinners.isEmpty();
    }
    /** Native owner calls only after authentic RPC lookup AND raw txid verification. Never restarts automatically. */
    public synchronized void resolveConfirmedOutcome(String txid) throws Exception {
        resolveConfirmedOutcome(txid, null);
    }
    public synchronized void resolveConfirmedOutcome(String txid, String transactionHex) throws Exception {
        resolveConfirmedOutcome(txid, transactionHex, receiptLookupEpoch(txid));
    }
    synchronized long receiptLookupEpoch(String txid) {
        require(!closed && unknownBlocked && lastTxid.equals(hash(txid)), "CLAIMS_RECEIPT_STATE");
        return generation;
    }
    static final class ReceiptLookup {
        final String txid; final long epoch;
        ReceiptLookup(String txid, long epoch) { this.txid = txid; this.epoch = epoch; }
    }
    synchronized ReceiptLookup beginReceiptLookup() {
        // A failed preference commit can already have changed its in-memory
        // status to submitted. Only the live owner knows whether recovery was
        // durably completed; startup restoration installs this same guard.
        ReceiptLookup pending = pendingReceiptLookup();
        require(pending != null, "CLAIMS_RECEIPT_STATE");
        return pending;
    }
    synchronized ReceiptLookup pendingReceiptLookup() {
        return !closed && unknownBlocked ? new ReceiptLookup(lastTxid, receiptLookupEpoch(lastTxid)) : null;
    }
    synchronized void resolveConfirmedReceipt(String txid, JSONObject response, long lookupEpoch) throws Exception {
        require(!closed && generation == lookupEpoch && unknownBlocked && lastTxid.equals(hash(txid)), "CLAIMS_RECEIPT_STATE");
        ReceiptEnvelope envelope = validateReceiptEnvelope(response, txid);
        Winner saved = observedReceiptOwner(txid, response.getJSONObject("transaction").getString("hex"));
        if (envelope.locationChanged) throw new ChainMoved();
        recordResolvedReceipt(txid, saved);
    }
    synchronized void resolveConfirmedOutcome(String txid, String transactionHex, long lookupEpoch) throws Exception {
        // Manual receipt reads can outlive Stop, policy suspension or Close.
        // Do not let their old callback rewrite the durable receipt or counters.
        require(!closed && generation == lookupEpoch && unknownBlocked && lastTxid.equals(hash(txid)), "CLAIMS_RECEIPT_STATE");
        recordResolvedReceipt(txid, observedReceiptOwner(txid, transactionHex));
    }
    private Winner observedReceiptOwner(String txid, String transactionHex) {
        Winner saved = null;
        for (Winner winner : savedWinners.values()) if (txid.equals(winner.txid)) {
            saved = winner; break;
        }
        validateObserved(transactionHex, txid, saved == null ? null : saved.transactionHex, saved == null ? null : saved.row.target);
        return saved;
    }
    private void recordResolvedReceipt(String txid, Winner saved) throws Exception {
        try { recordReceipt(txid, "submitted"); }
        catch (Exception failure) {
            // Metadata, raw identity/proof and the lookup epoch have already
            // been validated. Keep that positive observation only alongside
            // its original live bytes; a restored txid alone is insufficient.
            if (saved != null && savedWinners.get(saved.row.key) == saved)
                uncommittedReceipt = new UncommittedReceipt(saved, ReceiptState.SUBMITTED);
            throw failure;
        }
        uncommittedReceipt = null; unknownBlocked = false; status = "stopped"; lastError = "";
        if (saved != null) {
            saved.acknowledged = true; saved.acknowledgedAt = now(); saved.rejected = saved.ownAbsenceValidated = false; saved.retryDue = now() + 30000;
            if (!saved.submissionCounted) { submitted = increment(submitted); saved.submissionCounted = true; }
        }
    }
    private synchronized void recordReceipt(String txid, String state) throws Exception {
        require(receiptStore != null, "CLAIMS_RECEIPT_UNAVAILABLE");
        try { receiptStore.record(txid, state); } catch (Exception failure) { throw new IllegalStateException("CLAIMS_RECEIPT_UNAVAILABLE", failure); }
    }

    interface RpcAccess {
        default long connectionEpoch() { return 0; }
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
        default boolean hasCaptured(long handle) { return false; }
        default void setStartAllowed(long limiter, boolean allowed) {}
        default void bindBudget(long handle, String key, String target, String captured) {}
        JSONObject capture(JSONObject context, long handle) throws Exception;
    }
    interface Transactions {
        void validateReward(String address);
        long fee();
        JSONObject prepare(JSONObject bounty, String parent, String reward) throws Exception;
        default JSONObject prepare(JSONObject bounty, String parent, String reward, NativeTransactions.FundingTransactionCache cache, NativeTransactions.FundingCheck check) throws Exception {
            check.check(); JSONObject result = prepare(bounty, parent, reward); check.check(); return result;
        }
        JSONObject attach(JSONObject prepared, String proof) throws Exception;
        default void validateObserved(String raw, String expectedTxid, String originalHex, String target) throws Exception {
            NativeTransactions.validateObservedClaim(raw, expectedTxid, originalHex, target);
        }
    }
    public MobileClaimsEngine(MobileRpcClient client) {
        this(new RpcAccess() {
            public long connectionEpoch() { return client.connectionEpoch(); }
            public CompletableFuture<JSONObject> call(String method, JSONObject params) { return client.call(method, params); }
            public CompletableFuture<JSONObject> stream(String hash, MobileRpcClient.ChunkConsumer consumer) { return client.streamBounties(hash, consumer); }
            public CompletableFuture<JSONObject> broadcast(String hex) { return client.broadcast(hex); }
            public CompletableFuture<JSONObject> broadcast(String hex, Object guard, Runnable beforeWrite) { return client.broadcast(hex, guard, beforeWrite); }
            public boolean cancelBeforeWrite(CompletableFuture<JSONObject> operation) { return client.cancelBeforeWrite(operation); }
        }, new ProofAccess() {
            public long createStartLimiter(int rate) { return NativeClaims.createStartLimiter(rate); }
            public void setStartRate(long limiter, int rate) { NativeClaims.setStartRate(limiter, rate); }
            public void resetStartSchedule(long limiter) { NativeClaims.resetStartSchedule(limiter); }
            public void setStartAllowed(long limiter, boolean allowed) { NativeClaims.setStartAllowed(limiter, allowed); }
            public void bindBudget(long handle, String key, String target, String captured) { NativeClaims.bindBudget(handle, key, target, captured); }
            public boolean hasCaptured(long handle) { return NativeClaims.hasCaptured(handle); }
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
            public JSONObject prepare(JSONObject bounty, String parent, String reward, NativeTransactions.FundingTransactionCache cache, NativeTransactions.FundingCheck check) throws Exception { return cache.prepareClaim(bounty, parent, reward, FEE_RATE, check); }
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
            if (!value) { pauseClock(); generation++; clearFunding(); pending = new ArrayList<>(operations); discardIdleWinners(); cancelCaptures(null, -1); resetStartSchedule(); acknowledgeStarts(); status = enabled ? "paused" : "stopped"; currentDomain = ""; }
            else if (enabled && !unknownBlocked) { resetStartSchedule(); activeSince = now(); nextDiscovery = 0; status = "synchronizing"; }
        }
        cancelOwned(pending);
    }
    public synchronized void start(String address) {
        if (closed) throw new IllegalStateException("CLAIMS_CLOSED");
        if (unknownBlocked && uncommittedReceipt == null) throw new IllegalStateException("CLAIMS_UNKNOWN_OUTCOME");
        transactions.validateReward(address);
        if (enabled) { require(address.equals(rewardAddress), "Stop claims before changing the reward address."); return; }
        if (!reservations.isEmpty() || !operations.isEmpty()) throw new IllegalStateException("CLAIMS_BUSY");
        require(savedWinners.isEmpty() || rewardAddress == null || rewardAddress.equals(address), "Resume preserved claims before changing the reward address.");
        if (unknownBlocked) {
            UncommittedReceipt outcome = uncommittedReceipt;
            Winner owner = outcome == null ? null : outcome.winner;
            require(owner != null && lastTxid.equals(owner.txid) && savedWinners.get(owner.row.key) == owner, "CLAIMS_RECEIPT_STATE");
            // Reconcile the durable crash guard before releasing the live one.
            // Only this exact owner carries the validated terminal response;
            // neither an absent RPC transaction nor a restart supplies it.
            try { recordReceipt(owner.txid, outcome.state.value); }
            catch (Exception failure) { throw new IllegalStateException("CLAIMS_RECEIPT_UNAVAILABLE", failure); }
            if (outcome.state == ReceiptState.SUBMITTED) acknowledgeWinner(owner);
            else if (outcome.state == ReceiptState.REJECTED) owner.rejected = true; // Still wait for committed availability, not merely disk recovery.
            else owner.transmissionAttempted = false;
            uncommittedReceipt = null; unknownBlocked = false;
        }
        resetStartSchedule();
        if (rewardAddress != null && !rewardAddress.equals(address)) for (Candidate.Progress item : progress.values()) item.prepared = null;
        rewardAddress = address; enabled = true; generation++; clearFunding(); runSerial++; recentStarts.clear(); elapsedBeforePause = 0; activeSince = allowed ? now() : 0;
        attempts = valid = invalid = targetHits = submitted = unknown = cancelled = 0;
        resetCatalog(!savedWinners.isEmpty()); lastError = ""; lastRpcError = null; lastTxid = ""; nextDiscovery = nextBlock = retryAt = nextStartAcknowledgementNanos = nextSchedule = nextPreparation = nextReceiptLookup = 0;
        status = allowed ? "synchronizing" : "paused";
    }
    public void stop() {
        List<CompletableFuture<JSONObject>> pending;
        synchronized (this) { if (closed && !enabled) return; enabled = false; pauseClock(); generation++; clearFunding(); pending = new ArrayList<>(operations); discardIdleWinners(); cancelCaptures(null, -1); resetStartSchedule(); acknowledgeStarts(); currentDomain = ""; status = unknownBlocked ? "unknown-outcome" : "stopped"; }
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
    private void pruneRetired() { retired.removeIf(key -> !progress.containsKey(key) && !reservations.contains(key) && !savedWinners.containsKey(key)); }
    private void pauseClock() { if (activeSince != 0) { elapsedBeforePause += Math.max(0, now() - activeSince); activeSince = 0; } }
    private synchronized void check(long epoch) { if (closed || !enabled || !allowed || epoch != generation) throw new Stopped(); }
    private void clearFunding() { parents.clear(); fundingValidation.clear(); }
    private static final class Stopped extends RuntimeException { private static final long serialVersionUID = 1L; }
    private synchronized void resetCatalog() { resetCatalog(false); }
    private synchronized void resetCatalog(boolean keepHashAnchor) {
        if (keepHashAnchor) {
            proof.setStartAllowed(startLimiter, false); acknowledgeStarts();
            Map<String, Retained> preserved = new LinkedHashMap<>();
            for (Capture capture : activeCaptures.values()) {
                if (capture.started && !capture.cancelled && ownedAvailable(capture.row)) preserved.put(capture.row.key, new Retained(ownedRow(capture.row.key)));
                else if (!capture.cancelled) { capture.cancelled = true; proof.cancel(capture.handle); }
            }
            // A queued callback may still own an obsolete winner after a spend
            // commit. Preserve CURRENT state, never the winner's original row.
            for (Winner winner : pendingWinners.values()) if (winnerRetainable(winner)) preserved.put(winner.row.key, new Retained(ownedRow(winner.row.key)));
            for (Winner winner : savedWinners.values()) {
                Candidate current = ownedRow(winner.row.key);
                // Absence of current ownership is not permission to revive
                // the original available row after a known reorganization.
                if (current != null) preserved.put(winner.row.key, new Retained(current));
            }
            require(preserved.size() <= MAX_RETAINED_WINNERS, "CLAIMS_CAPACITY");
            retained.clear(); retained.putAll(preserved); resyncBlocks.clear();
            for (Retained row : retained.values()) resyncBlocks.add(row.row.blockHash);
            catalogGate = true; resyncSnapshotPending = true;
        } else { retained.clear(); resyncBlocks.clear(); catalogGate = resyncSnapshotPending = false; }
        catalog.clear(); feedCandidates.clear(); feedNeedsStream.clear(); blocks.clear(); loaded.clear(); scheduler.clear(); scheduleDirty = admissionIdle = true; cursor = null; tip = null; healthy = false; catalogValidatedAt = 0; if (!keepHashAnchor) blockWindow = null;
    }
    private static final class Retained {
        Candidate row; boolean normalAged;
        Retained(Candidate row) { this.row = row; }
        Retained copy() throws Exception { Retained result = new Retained(row.copy()); result.normalAged = normalAged; return result; }
    }
    private void retain(Candidate row) {
        if (retained.containsKey(row.key)) return;
        require(retained.size() < MAX_RETAINED_WINNERS, "CLAIMS_CAPACITY"); retained.put(row.key, new Retained(row));
    }
    private boolean protectedOutpoint(String key) {
        if (reservations.contains(key) || savedWinners.containsKey(key)) return true;
        for (Capture capture : activeCaptures.values()) if (capture.row.key.equals(key) && capture.started && !capture.cancelled) return true;
        return false;
    }
    private void pruneRetained() {
        retained.keySet().removeIf(key -> !protectedOutpoint(key));
        Set<String> protectedBlocks = new HashSet<>();
        for (Retained row : retained.values()) protectedBlocks.add(row.row.blockHash);
        resyncBlocks.retainAll(protectedBlocks);
    }
    /** A completed coherent snapshot and protected-block revalidation are
     * separate barriers. Draining a final miss only removes the latter. This
     * runs after a release, never in the middle of a catalog publication. */
    private void releaseObsoleteResyncGate() {
        if (catalogGate && !resyncSnapshotPending && !replayPending && resyncBlocks.isEmpty()) {
            catalogGate = false;
            if (!closed) proof.setStartAllowed(startLimiter, catalogFresh() && enabled && allowed && !unknownBlocked);
        }
    }
    private Candidate ownedRow(String key) { Candidate row = catalog.get(key); return row != null ? row : retained.containsKey(key) ? retained.get(key).row : null; }
    private boolean ownedAvailable(Candidate captured) {
        Candidate row = ownedRow(captured.key);
        return row != null && row.supported && row.state.equals("available") && row.blockHash.equals(captured.blockHash) && row.sameMetadata(captured);
    }
    private boolean winnerOwnedAvailable(Winner winner) {
        if (ownedAvailable(winner.row)) return true;
        // The journal no longer tracks outputs outside its rolling window.
        // A known-absent OWN transaction may therefore leave an old pending
        // marker behind. Only replay its original signed bytes, not a fresh
        // capture; a competing or confirmed spend never qualifies here.
        Retained held = retained.get(winner.row.key);
        return winner.acknowledged && winner.ownAbsenceValidated && !catalog.containsKey(winner.row.key)
            && held != null && held.normalAged && held.row.state.equals("pending_spend")
            && winner.txid != null && winner.txid.equals(held.row.spendingTxid)
            && held.row.blockHash.equals(winner.row.blockHash) && held.row.sameMetadata(winner.row);
    }
    /** Retention is not transmission permission. A mempool competitor can
     * disappear; keep the already verified proof while the exact funding
     * identity is still owned, without sending until availability is fresh. */
    private boolean winnerRetainable(Winner winner) {
        Candidate row = ownedRow(winner.row.key);
        return row != null && row.supported && row.blockHash.equals(winner.row.blockHash) && row.sameMetadata(winner.row)
            && (row.state.equals("available") || row.state.equals("pending_spend") || row.state.equals("immature"));
    }
    private boolean winnerCanSubmit(Winner winner) {
        if (!catalogFresh()) return false;
        if (catalog.containsKey(winner.row.key)) return true;
        // Normal aging is not evidence of a spend. Keep the validated proof
        // and let sendrawtransaction/Core check the UTXO; do not describe the
        // old row as freshly available or start another capture for it.
        Retained held = retained.get(winner.row.key);
        return held != null && held.normalAged && winnerOwnedAvailable(winner);
    }
    private static final class ChainMoved extends Exception {
        private static final long serialVersionUID = 1L;
        ChainMoved() { super("CLAIMS_SNAPSHOT_STALE"); }
    }

    /** Discovery reads may retry independently, but never authorize work from an unboundedly old snapshot. */
    private boolean catalogFresh() { return !catalogGate && healthy && now() - catalogValidatedAt < CATALOG_FRESH_MS; }
    private void expireCatalogWork() {
        cancelUnsafeQueuedTransmissions();
        discardIdleWinners();
        if (healthy && !catalogFresh()) {
            proof.setStartAllowed(startLimiter, false); admissionIdle = true;
            // Leave transmissions and their outcome/receipt ownership untouched.
            if (enabled && allowed && !unknownBlocked) status = "retrying";
        }
    }
    /** A local quota wait is not transmission. Stop obsolete queued claims
     * without ever cancelling a job that has started its financial write. */
    private void cancelUnsafeQueuedTransmissions() {
        for (Map.Entry<CompletableFuture<JSONObject>, Winner> entry : pendingTransmissions.entrySet()) {
            Winner winner = entry.getValue();
            boolean usable = winnerCanSubmit(winner) && winnerUsable(winner);
            // rowAvailable also excludes retired rows, including this winner's
            // own reservation, so it must not be used for this eligibility test.
            if (!usable && !winner.cancelledBeforeWrite && rpc.cancelBeforeWrite(entry.getKey())) {
                winner.cancelledBeforeWrite = true;
                winner.cancelledForStaleness = winnerUsable(winner) && !winnerCanSubmit(winner);
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
    private void capabilities() {
        long current = rpc.connectionEpoch();
        if (current != capabilityEpoch) { capabilityEpoch = current; compactVersion = 3; enrichedFeed = blockDeltas = bountyCounts = rawFunding = compactReceipts = true; }
    }
    private Map<String, JSONObject> ownedRows() throws Exception {
        Map<String, JSONObject> rows = new LinkedHashMap<>();
        synchronized (this) {
            for (Candidate row : catalog.values()) rows.put(row.key, copy(row.bounty));
            for (Retained row : retained.values()) rows.putIfAbsent(row.row.key, copy(row.row.bounty));
            for (Map<String, Candidate> candidates : feedCandidates.values()) for (Candidate row : candidates.values()) rows.putIfAbsent(row.key, copy(row.bounty));
        }
        return rows;
    }
    private JSONObject changes(String checkpoint, MobileClaimBlockWindow window, Map<String, JSONObject> rows, long epoch) throws Exception {
        return changes(checkpoint, window, rows, epoch, -1);
    }
    private JSONObject changes(String checkpoint, MobileClaimBlockWindow window, Map<String, JSONObject> rows, long epoch, long minimumSequence) throws Exception {
        capabilities(); boolean expandedReplay = false;
        for (int attempt = 0; attempt < 7; attempt++) {
            JSONObject params = new JSONObject(); if (checkpoint != null) params.put("cursor", checkpoint);
            if (enrichedFeed) params.put("include_bounties", true);
            JSONObject base = window == null || checkpoint == null || !enrichedFeed || !blockDeltas ? null : window.tip();
            if (base != null) params.put("known_tip", new JSONObject().put("height", base.get("height")).put("hash", base.get("hash")));
            int requested = enrichedFeed && !expandedReplay ? compactVersion : 0;
            if (requested > 0) { params.put("compact", true); if (requested > 1) params.put("compact_version", requested); if (base != null) params.put("known_state", MobileBountyCodec.stateDigest(base, checkpoint)); }
            JSONObject response;
            try { response = request("getbountychanges", params, epoch); }
            catch (ReadFailure error) {
                capabilities();
                if (!"-32602".equals(error.failure.code) || !enrichedFeed) throw error;
                if (requested > 1) compactVersion = requested - 1;
                else if (requested == 1) compactVersion = 0;
                else if (base != null) blockDeltas = false;
                else enrichedFeed = false;
                continue;
            }
            // A socket replacement resets learned capabilities. Never bind the
            // next connection to an old unsupported-method conclusion.
            long currentEpoch = rpc.connectionEpoch(); if (currentEpoch != capabilityEpoch) { capabilities(); }
            try {
                JSONObject normalized = MobileBountyCodec.decode(response, base, checkpoint, rows, requested,
                    window == null ? java.util.Collections.emptyMap() : window.blocks(), window == null ? java.util.Collections.emptyMap() : window.counts(), minimumSequence);
                if (!normalized.has("bounty_deltas")) { enrichedFeed = false; compactVersion = 0; }
                if (base != null && !normalized.has("block_deltas")) blockDeltas = false;
                if (response.has("compact")) compactVersion = (int)MobileBountyCodec.number(response.opt("compact"), 1, requested);
                return normalized;
            } catch (MobileBountyCodec.UnknownReference unknown) { require(!expandedReplay, "CLAIMS_RPC_DATA"); expandedReplay = true; }
        }
        throw new IllegalArgumentException("CLAIMS_RPC_DATA");
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
            JSONObject first = changes(startCursor, startCursor == null ? null : known, ownedRows(), epoch);
            JSONObject expected = validateTip(first.optJSONObject("tip"));
            JSONArray firstEvents = journalEvents(first);
            boolean force = startCursor == null;
            if (startCursor == null) {
                require(firstEvents.length() == 0 && Boolean.FALSE.equals(first.opt("has_more")), "CLAIMS_RPC_DATA");
                startCursor = validCursor(first.opt("next_cursor")); first = null;
            }
            MobileClaimBlockWindow refreshed = force ? null : MobileClaimBlockWindow.fromDelta(known, first);
            boolean readAfterFirst = refreshed == null && (force || known == null || !MobileClaimBlockWindow.sameTip(known.tip(), expected));
            if (refreshed == null) refreshed = refreshWindow(known, expected, force, epoch);
            // Publish recent blocks and deltas together. A failed read cannot
            // make a new tip or partially refreshed catalog visible to workers.
            try {
                replay(epoch, null, null, refreshed.blocks(), startCursor, refreshed, first, readAfterFirst);
                synchronized (this) { check(epoch); nextDiscovery = now() + 10000; readRecovered("discovery"); }
                return;
            } catch (ChainMoved moved) { if (pass == 2) throw moved; known = refreshed; }
        }
    }
    private MobileClaimBlockWindow refreshWindow(MobileClaimBlockWindow known, JSONObject expected, boolean force, long epoch) throws Exception {
        capabilities();
        try { return MobileClaimBlockWindow.refresh(known, expected, force,
            params -> {
                check(epoch); JSONObject requested = copy(params); if (bountyCounts) requested.put("include_bounty_counts", true);
                JSONObject result;
                try { result = waitFor(rpc.call("getrecentblockhashes", requested), epoch); }
                catch (MobileRpcClient.RpcFailure failure) { capabilities(); if (!bountyCounts || !"-32602".equals(failure.code)) throw failure; bountyCounts = false; result = waitFor(rpc.call("getrecentblockhashes", params), epoch); }
                capabilities();
                if (!result.has("bounty_counts")) bountyCounts = false; return result;
            }); }
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
                    if (previous != null) {
                        row.reuse(previous);
                    }
                }
                require(staged.put(row.key, row) == null && staged.size() <= MAX_CATALOG, "CLAIMS_CAPACITY");
            }
        }), epoch); } catch (MobileRpcClient.RpcFailure failure) { throw new ReadFailure("getblockbounties", failure); }
        // Reuse the completed stream across ordinary new-block races, but
        // always replay from BEFORE that stream. Advancing the public cursor
        // separately would lose spends that arrived while the stream ran.
        JSONObject first = null; Map<String, Long> recent = null; boolean readAfterFirst = false;
        for (int pass = 0; pass < 3; pass++) {
            boolean canonical = known.blocks().containsKey(blockHash) && known.blocks().get(blockHash) == blockHeight;
            try {
                replay(epoch, canonical ? blockHash : null, canonical ? staged : null, recent, originalCursor, known, first, readAfterFirst);
                break;
            } catch (ChainMoved moved) {
                if (pass == 2) throw moved;
                first = changes(originalCursor, known, ownedRows(), epoch);
                JSONObject expected = validateTip(first.optJSONObject("tip"));
                journalEvents(first);
                MobileClaimBlockWindow advanced = MobileClaimBlockWindow.fromDelta(known, first);
                readAfterFirst = advanced == null && !MobileClaimBlockWindow.sameTip(known.tip(), expected);
                known = advanced == null ? refreshWindow(known, expected, false, epoch) : advanced;
                recent = known.blocks();
            }
        }
        synchronized (this) { check(epoch); nextBlock = now() + 1500; readRecovered("catalog"); }
    }
    /** Reset markers invalidate the cursor before any secondary RPC can fail
     * and mask them. All callers validate the page's tip before this envelope. */
    private static JSONArray journalEvents(JSONObject changes) throws JSONException {
        require(changes.opt("changes") instanceof JSONArray && changes.opt("has_more") instanceof Boolean, "CLAIMS_RPC_DATA");
        JSONArray events = changes.getJSONArray("changes"); require(events.length() <= 500, "CLAIMS_RPC_DATA");
        for (int index = 0; index < events.length(); index++) if ("resync_required".equals(events.getJSONObject(index).opt("type"))) throw new IllegalArgumentException("CLAIMS_RESYNC");
        return events;
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
        replay(epoch, newBlock, staged, recent, startCursor, window, first, first != null && window != blockWindow);
    }
    private void replay(long epoch, String newBlock, Map<String, Candidate> staged, Map<String, Long> recent, String startCursor,
                        MobileClaimBlockWindow window, JSONObject first, boolean readAfterFirst) throws Exception {
        synchronized (this) { check(epoch); replayPending = true; }
        try { replaySnapshot(epoch, newBlock, staged, recent, startCursor, window, first, readAfterFirst); }
        finally { synchronized (this) { replayPending = false; } }
    }
    private void replaySnapshot(long epoch, String newBlock, Map<String, Candidate> staged, Map<String, Long> recent, String startCursor,
                                MobileClaimBlockWindow window, JSONObject first, boolean readAfterFirst) throws Exception {
        Map<String, Candidate> next = new LinkedHashMap<>(); Map<String, Retained> nextRetained = new LinkedHashMap<>(); String nextCursor; JSONObject nextTip;
        Map<String, Long> canonical; boolean replayAfterFirst;
        Set<String> dirtyBlocks = new HashSet<>();
        Set<String> needsStream = new HashSet<>();
        Map<String, Map<String, Candidate>> inline = new LinkedHashMap<>();
        Set<String> completeFeedBlocks = new HashSet<>();
        Set<String> reopened = new HashSet<>();
        Map<String, Candidate> exited = new LinkedHashMap<>();
        long validatedFrom = now();
        synchronized (this) {
            check(epoch);
            if (recent != null && !recent.equals(blocks)) proof.setStartAllowed(startLimiter, false);
            acknowledgeStarts();
            for (Retained row : retained.values()) nextRetained.put(row.row.key, row.copy());
            for (Candidate row : catalog.values()) {
                if ((recent == null || recent.containsKey(row.blockHash)) && !row.blockHash.equals(newBlock)) next.put(row.key, row.copy());
                else if (!row.blockHash.equals(newBlock)) exited.put(row.key, row.copy());
            }
            nextCursor = startCursor == null ? cursor : startCursor; nextTip = tip;
            canonical = new LinkedHashMap<>(recent == null ? blocks : recent);
            needsStream.addAll(feedNeedsStream); needsStream.retainAll(canonical.keySet()); if (newBlock != null) needsStream.remove(newBlock);
            for (Map.Entry<String, Map<String, Candidate>> entry : feedCandidates.entrySet()) {
                if (!canonical.containsKey(entry.getKey())) continue;
                if (entry.getKey().equals(newBlock)) {
                    require(staged != null, "CLAIMS_RPC_DATA");
                    for (Candidate expected : entry.getValue().values()) {
                        Candidate actual = staged.get(expected.key);
                        require(actual != null && actual.sameMetadata(expected) && actual.height == expected.height && actual.blockHash.equals(expected.blockHash), "CLAIMS_RPC_DATA");
                    }
                } else {
                    Map<String, Candidate> candidates = new LinkedHashMap<>();
                    for (Candidate row : entry.getValue().values()) candidates.put(row.key, row.copy());
                    inline.put(entry.getKey(), candidates);
                }
            }
            replayAfterFirst = first != null && readAfterFirst;
            // A complete stream replaces that block, including rows that have
            // disappeared. Preserve public accounting for surviving outpoints.
            if (staged != null) for (Candidate source : staged.values()) {
                Candidate row = source.copy();
                Candidate.Progress previous = progress.get(row.key);
                if (previous != null) row.reuse(previous);
                Candidate old = ownedRow(row.key);
                // A reset/new watermark can skip available_again while paused.
                // A complete same-identity snapshot proves that transition too,
                // but an unchanged available row must not retry every rejection.
                if (newBlock != null && newBlock.equals(row.blockHash) && old != null && old.state.equals("pending_spend") && row.state.equals("available")
                        && row.blockHash.equals(old.blockHash) && row.sameMetadata(old)) reopened.add(row.key);
                next.put(row.key, row);
                if (nextRetained.containsKey(row.key)) { nextRetained.get(row.key).row = row; }
            }
            if (newBlock != null) for (Retained row : nextRetained.values()) if (row.row.blockHash.equals(newBlock) && !next.containsKey(row.row.key)) row.row.state = "unavailable";
        }
        require(next.size() <= MAX_CATALOG, "CLAIMS_CAPACITY");
        require(nextRetained.size() <= MAX_RETAINED_WINNERS, "CLAIMS_CAPACITY");
        boolean more = true; long previousSequence = -1;
        for (int page = 0; (more || replayAfterFirst) && page < MAX_REPLAY_PAGES; page++) {
            Map<String, JSONObject> immutable = new LinkedHashMap<>();
            for (Candidate row : next.values()) immutable.put(row.key, row.bounty);
            for (Retained row : nextRetained.values()) immutable.putIfAbsent(row.row.key, row.row.bounty);
            for (Map<String, Candidate> rows : inline.values()) for (Candidate row : rows.values()) immutable.put(row.key, row.bounty);
            JSONObject changes = page == 0 && first != null ? first : changes(nextCursor, window, immutable, epoch, previousSequence);
            if (page > 0 || first == null) replayAfterFirst = false;
            nextTip = validateTip(changes.optJSONObject("tip"));
            JSONArray events = journalEvents(changes);
            if (window != null && !MobileClaimBlockWindow.sameTip(window.tip(), nextTip)) {
                MobileClaimBlockWindow advanced = MobileClaimBlockWindow.fromDelta(window, changes);
                if (advanced == null) throw new ChainMoved();
                window = advanced; recent = window.blocks(); canonical = new LinkedHashMap<>(recent);
                for (var iterator = next.entrySet().iterator(); iterator.hasNext();) { Candidate row = iterator.next().getValue(); if (!canonical.containsKey(row.blockHash)) { exited.put(row.key, row); iterator.remove(); } }
                inline.keySet().retainAll(canonical.keySet());
            }
            String following = validCursor(changes.opt("next_cursor")); more = changes.getBoolean("has_more");
            require((!more || events.length() > 0) && (events.length() == 0 || !following.equals(nextCursor)), "CLAIMS_RPC_DATA");
            for (int index = 0; index < events.length(); index++) {
                JSONObject event = events.getJSONObject(index);
                long sequence = integer(event.opt("sequence"), 0, SAFE_MAX);
                require(sequence > previousSequence, "CLAIMS_RPC_DATA"); previousSequence = sequence;
                String txid = hash(event.opt("txid")); long vout = integer(event.opt("vout"), 0, 0xffffffffL); String key = txid + ":" + vout;
                String type = event.optString("type", ""); Candidate row = next.get(key);
                if (row == null && nextRetained.containsKey(key)) row = nextRetained.get(key).row;
                if (row == null) for (Map<String, Candidate> candidates : inline.values()) if (candidates.containsKey(key)) { row = candidates.get(key); break; }
                if (changes.has("bounty_deltas")) {
                    require(MobileBountyCodec.number(changes.opt("bounty_deltas"), 1, 1) == 1, "CLAIMS_RPC_DATA");
                    JSONObject publication = validateTip(event.optJSONObject("tip"));
                    require(publication.getLong("height") <= nextTip.getLong("height"), "CLAIMS_RPC_DATA");
                    if (publication.getLong("height") == nextTip.getLong("height")) require(MobileClaimBlockWindow.sameTip(publication, nextTip), "CLAIMS_RPC_DATA");
                    for (Map.Entry<String, Long> block : canonical.entrySet()) if (block.getValue() == publication.getLong("height") && !block.getKey().equals(publication.getString("hash"))) throw new ChainMoved();
                    if (type.equals("window_exit")) {
                        require(event.has("bounty") && event.isNull("bounty"), "CLAIMS_RPC_DATA");
                        if (row != null && canonical.containsKey(row.blockHash)) throw new IllegalArgumentException("CLAIMS_RESYNC");
                    }
                    else {
                        require(type.equals("added") || MobileBountyCodec.stateEvent(type), "CLAIMS_RPC_DATA");
                        JSONObject full = event.optJSONObject("bounty"); MobileBountyCodec.validateRow(full, publication);
                        MobileBountyCodec.bindOuterBlock(event, full);
                        require(txid.equals(full.getString("txid")) && vout == full.getLong("vout"), "CLAIMS_RPC_DATA");
                        if (event.has("spending_txid") && !event.isNull("spending_txid")) hash(event.opt("spending_txid"));
                        Candidate replacement = new Candidate(full, full.getString("block_hash"), transactions.fee());
                        if (type.equals("added")) require(hash(event.opt("block_hash")).equals(replacement.blockHash) && integer(event.opt("block_height"), 0, SAFE_MAX) == replacement.height, "CLAIMS_RPC_DATA");
                        if (row != null) {
                            require(row.sameMetadata(replacement), "CLAIMS_RPC_DATA");
                            require(row.blockHash.equals(replacement.blockHash) || !canonical.containsKey(row.blockHash), "CLAIMS_RPC_DATA");
                            replacement.reuse(row.progress);
                            if (row.state.equals("pending_spend") && replacement.state.equals("available")) reopened.add(key);
                        } else synchronized (this) { Candidate.Progress previous = progress.get(key); if (previous != null) replacement.reuse(previous); }
                        if (canonical.containsKey(replacement.blockHash)) {
                            require(canonical.get(replacement.blockHash) == replacement.height, "CLAIMS_RPC_DATA");
                            Long count = window == null ? null : window.counts().get(replacement.blockHash);
                            require(count == null || count > 0, "CLAIMS_RPC_DATA");
                            if (loaded.contains(replacement.blockHash) || replacement.blockHash.equals(newBlock)) next.put(key, replacement);
                            else {
                                Map<String, Candidate> candidates = inline.computeIfAbsent(replacement.blockHash, ignored -> new LinkedHashMap<>());
                                Candidate old = candidates.get(key); if (old != null) require(old.sameMetadata(replacement) && old.height == replacement.height, "CLAIMS_RPC_DATA");
                                candidates.put(key, replacement); require(candidates.size() <= MAX_CATALOG && (count == null || candidates.size() <= count), "CLAIMS_CAPACITY");
                                dirtyBlocks.add(replacement.blockHash);
                            }
                        } else {
                            // A full historical row may have normally aged out.
                            // A different currently canonical hash at its height is a contradiction.
                            for (Map.Entry<String, Long> known : canonical.entrySet()) if (known.getValue() == replacement.height) require(known.getKey().equals(replacement.blockHash), "CLAIMS_RPC_DATA");
                            if (nextRetained.containsKey(key)) nextRetained.get(key).row = replacement;
                            if (exited.containsKey(key)) exited.put(key, replacement);
                        }
                        if (nextRetained.containsKey(key)) nextRetained.get(key).row = replacement;
                        require(next.size() + inline.values().stream().mapToInt(Map::size).sum() <= MAX_CATALOG, "CLAIMS_CAPACITY");
                        continue;
                    }
                }
                if (!changes.has("bounty_deltas") && row != null && inline.containsKey(row.blockHash)) {
                    // Legacy events can describe a historical transition rather
                    // than the row's current coalesced state. Preserve identities
                    // but require a coherent stream before candidate admission.
                    needsStream.add(row.blockHash); dirtyBlocks.add(row.blockHash);
                    if (type.equals("window_exit") && canonical.containsKey(row.blockHash)) throw new IllegalArgumentException("CLAIMS_RESYNC");
                }
                if (type.equals("window_exit")) {
                    if (row != null) exited.put(key, row);
                    next.remove(key);
                    for (Map<String, Candidate> candidates : inline.values()) candidates.remove(key);
                }
                else if (type.equals("added")) {
                    String blockHash = hash(event.opt("block_hash")); long height = integer(event.opt("block_height"), 0, SAFE_MAX);
                    if (row != null && !row.blockHash.equals(blockHash)) {
                        // A re-mined funding transaction keeps its immutable
                        // outputs, but its old proof/location is no longer owned.
                        require(!canonical.containsKey(row.blockHash), "CLAIMS_RPC_DATA");
                        row.state = "unavailable"; next.remove(key);
                        for (Map<String, Candidate> candidates : inline.values()) candidates.remove(key);
                        if (nextRetained.containsKey(key)) nextRetained.get(key).row.state = "unavailable";
                        row = null;
                    }
                    if (row != null) require(row.height == height, "CLAIMS_RPC_DATA");
                    if (canonical.containsKey(blockHash)) {
                        require(canonical.get(blockHash) == height, "CLAIMS_RPC_DATA");
                        Long count = window == null ? null : window.counts().get(blockHash);
                        require(count == null || count > 0, "CLAIMS_RPC_DATA");
                        if (row == null) { dirtyBlocks.add(blockHash); needsStream.add(blockHash); }
                    }
                }
                else if (type.equals("spent") || type.equals("pending_spend")) {
                    String spender = hash(event.opt("spending_txid"));
                    if (row != null) { row.state = type; row.spendingTxid = spender; }
                    if (nextRetained.containsKey(key)) { nextRetained.get(key).row.state = type; nextRetained.get(key).row.spendingTxid = spender; }
                    if (exited.containsKey(key)) { exited.get(key).state = type; exited.get(key).spendingTxid = spender; }
                }
                else if (type.equals("available_again") || type.equals("matured")) {
                    if (row != null && !row.state.equals("spent") && (type.equals("available_again") || row.state.equals("immature"))) { row.state = row.coinbase && nextTip.getLong("height") - row.height + 1 < 100 ? "immature" : "available"; row.spendingTxid = null; }
                    if (type.equals("available_again")) reopened.add(key);
                } else throw new IllegalArgumentException("CLAIMS_RPC_DATA");
            }
            nextCursor = following;
        }
        require(!more && !replayAfterFirst, "CLAIMS_SYNC_BUSY");
        if (window != null) for (Map.Entry<String, Long> count : window.counts().entrySet()) {
            Map<String, Candidate> candidates = inline.get(count.getKey());
            if (count.getValue() == 0) {
                require(next.values().stream().noneMatch(row -> row.blockHash.equals(count.getKey())) && (candidates == null || candidates.isEmpty()), "CLAIMS_RPC_DATA");
                completeFeedBlocks.add(count.getKey());
            } else if (candidates != null && candidates.size() == count.getValue() && !needsStream.contains(count.getKey())) {
                next.putAll(candidates); completeFeedBlocks.add(count.getKey()); dirtyBlocks.remove(count.getKey());
            }
            if (count.getKey().equals(newBlock) && staged != null) require(staged.size() == count.getValue(), "CLAIMS_RPC_DATA");
            if (loaded.contains(count.getKey()) || count.getKey().equals(newBlock)) {
                long actual = next.values().stream().filter(row -> row.blockHash.equals(count.getKey())).count();
                require(actual == count.getValue(), "CLAIMS_RPC_DATA");
            }
        }
        // Never mark mixed-branch rows fresh. This inexpensive fence replaces
        // a second full-window transfer and also protects each progressive block.
        // A fully drained coherent enriched page is itself the publication
        // fence; there has been no intervening asynchronous indexed read.
        JSONObject finalTip = enrichedFeed ? nextTip : validateTip(request("getchaintip", new JSONObject(), epoch));
        if (!MobileClaimBlockWindow.sameTip(nextTip, finalTip) || window != null && !MobileClaimBlockWindow.sameTip(window.tip(), finalTip)) throw new ChainMoved();
        synchronized (this) {
            check(epoch);
            proof.setStartAllowed(startLimiter, false); acknowledgeStarts();
            Map<String, Long> nextBlocks = recent == null ? blocks : recent;
            if (newBlock != null && !nextBlocks.containsKey(newBlock)) throw new IllegalArgumentException("CLAIMS_SYNC_BUSY");
            Set<String> nextLoaded = new HashSet<>(loaded); nextLoaded.retainAll(nextBlocks.keySet()); if (newBlock != null) nextLoaded.add(newBlock);
            nextLoaded.addAll(completeFeedBlocks);
            nextLoaded.removeAll(dirtyBlocks);
            Map<Long, String> canonicalHeights = new HashMap<>(); for (Map.Entry<String, Long> block : nextBlocks.entrySet()) canonicalHeights.put(block.getValue(), block.getKey());
            // Missing overlap also occurs after a long pause; it is not proof
            // that an older funding output was reorganized or spent. Preserve
            // already-admitted work and let Core validate the final UTXO/proof.
            for (Candidate row : exited.values()) if (protectedOutpoint(row.key)) {
                if (finalTip.getLong("height") - row.height < 600) row.state = "unavailable";
                nextRetained.put(row.key, new Retained(row));
            }
            for (Retained row : nextRetained.values()) {
                String canonicalHash = canonicalHeights.get(row.row.height);
                if (row.row.height > finalTip.getLong("height") || canonicalHash != null && !canonicalHash.equals(row.row.blockHash)) row.row.state = "unavailable";
                row.normalAged = (row.row.state.equals("available") || row.row.state.equals("pending_spend")) && !nextBlocks.containsKey(row.row.blockHash)
                    && finalTip.getLong("height") - row.row.height >= 600;
            }
            nextRetained.keySet().removeIf(key -> !protectedOutpoint(key));
            require(nextRetained.size() <= MAX_RETAINED_WINNERS, "CLAIMS_CAPACITY");
            Map<String, Candidate.Progress> nextProgress = new LinkedHashMap<>(progress);
            for (Candidate row : next.values()) {
                Candidate.Progress latest = progress.get(row.key);
                if (latest != null && latest != row.progress) {
                    require(latest.metadata.equals(row.progress.metadata), "CLAIMS_RPC_DATA");
                    // Re-mining staged a distinct Progress before journal/tip
                    // I/O. A native callback may have consumed more budget in
                    // that interval. Rebase its monotonic accounting at commit,
                    // never the old block's preparation or proof ownership.
                    row.progress.captures = row.progress.captures.max(latest.captures);
                    row.progress.budgetExhausted |= latest.budgetExhausted;
                }
                nextProgress.put(row.key, row.progress);
            }
            Set<String> protectedKeys = new HashSet<>(reservations); protectedKeys.addAll(savedWinners.keySet());
            for (Capture capture : activeCaptures.values()) protectedKeys.add(capture.row.key);
            long oldestHeight = Math.max(0, finalTip.getLong("height") - 599);
            for (var iterator = nextProgress.entrySet().iterator(); iterator.hasNext();) {
                Map.Entry<String, Candidate.Progress> entry = iterator.next(); Candidate.Progress item = entry.getValue();
                if (protectedKeys.contains(entry.getKey())) continue;
                if (!nextBlocks.containsKey(item.blockHash)) {
                    // A funding reorg precedes discovery of its re-mined tx.
                    // Keep only bounded accounting through that gap, never an
                    // old preparation/proof or an eligible catalog candidate.
                    if (item.height >= oldestHeight) entry.setValue(item.accountingOnly()); else iterator.remove();
                } else if (nextLoaded.contains(item.blockHash) && !next.containsKey(entry.getKey())) iterator.remove();
            }
            // Validate the complete prospective state before publishing any of
            // it: protected old captures/winners can outlive their window.
            require(nextProgress.size() <= MAX_PROGRESS, "CLAIMS_CAPACITY");
            // Receipt bytes can be compacted after confirmation, but retirement
            // is not eternal if that confirmation is later orphaned. Require a
            // positive canonical conflict, then a newly streamed funding block;
            // an old available row or ordinary window aging proves neither.
            Set<String> confirmedReopened = new HashSet<>();
            for (Map.Entry<String, Candidate.Progress> entry : nextProgress.entrySet()) {
                Candidate.Progress item = entry.getValue(); ConfirmedClaim completed = item.confirmed;
                if (completed == null || completed.reopened) continue;
                String canonicalHash = canonicalHeights.get(completed.height);
                if (completed.blockHash.equals(canonicalHash)) { completed.orphaned = false; completed.reloadedFundingBlock = null; continue; }
                if (!completed.orphaned && (finalTip.getLong("height") < completed.height || canonicalHash != null && !canonicalHash.equals(completed.blockHash))) completed.orphaned = true;
                if (!completed.orphaned) continue;
                Candidate row = next.get(entry.getKey());
                if ((newBlock != null && newBlock.equals(item.blockHash) && staged != null && staged.containsKey(entry.getKey()) || completeFeedBlocks.contains(item.blockHash))
                        && row != null && row.blockHash.equals(item.blockHash) && row.progress.metadata.equals(item.metadata)) completed.reloadedFundingBlock = item.blockHash;
                if (item.blockHash.equals(completed.reloadedFundingBlock) && row != null && row.blockHash.equals(item.blockHash) && row.progress.metadata.equals(item.metadata) && row.state.equals("available")) {
                    completed.reopened = true; confirmedReopened.add(entry.getKey());
                } else if (!item.blockHash.equals(completed.reloadedFundingBlock) && nextBlocks.containsKey(item.blockHash)) nextLoaded.remove(item.blockHash);
            }
            if (recent != null) { blocks.clear(); blocks.putAll(recent); }
            if (window != null) blockWindow = window;
            loaded.clear(); loaded.addAll(nextLoaded); catalog.clear(); catalog.putAll(next);
            feedCandidates.clear();
            for (Map.Entry<String, Map<String, Candidate>> entry : inline.entrySet()) if (!completeFeedBlocks.contains(entry.getKey()) && nextBlocks.containsKey(entry.getKey()) && !entry.getValue().isEmpty()) feedCandidates.put(entry.getKey(), entry.getValue());
            feedNeedsStream.clear(); feedNeedsStream.addAll(needsStream); feedNeedsStream.retainAll(nextBlocks.keySet()); feedNeedsStream.removeAll(nextLoaded);
            retained.clear(); retained.putAll(nextRetained); pruneRetained();
            // Reopening is evidence only after the complete journal/final tip
            // fence commits. Never let a partial page authorize a new claim.
            for (String key : reopened) {
                Candidate row = ownedRow(key);
                if (row == null || !row.state.equals("available")) continue;
                Winner pending = pendingWinners.get(key), saved = savedWinners.get(key);
                if (pending != null) pending.reopened = true;
                if (saved != null) { saved.reopened = true; saved.retryDue = 0; }
                Candidate.Progress item = nextProgress.get(key);
                if (pending == null && saved == null && (item == null || item.confirmed == null || item.confirmed.reopened)) retired.remove(key);
            }
            for (String key : confirmedReopened) if (!pendingWinners.containsKey(key) && !savedWinners.containsKey(key)) retired.remove(key);
            resyncBlocks.retainAll(nextBlocks.keySet()); if (newBlock != null) resyncBlocks.remove(newBlock); resyncBlocks.removeAll(completeFeedBlocks);
            resyncSnapshotPending = false;
            if (resyncBlocks.isEmpty()) catalogGate = false;
            progress.clear(); progress.putAll(nextProgress); scheduleDirty = true;
            if (recent != null) {
                Set<String> policies = new HashSet<>(); for (Candidate.Progress item : progress.values()) policies.add(item.policy);
                domains.keySet().retainAll(policies);
            }
            pruneRetired();
            cursor = nextCursor; tip = nextTip; healthy = true; catalogValidatedAt = validatedFrom;
            for (Capture capture : activeCaptures.values()) {
                boolean invalid = !ownedAvailable(capture.row);
                boolean outside = !catalog.containsKey(capture.row.key);
                if (!capture.cancelled && (invalid || outside && !capture.started)) { capture.cancelled = true; proof.cancel(capture.handle); }
            }
            cancelUnsafeQueuedTransmissions();
            proof.setStartAllowed(startLimiter, catalogFresh() && enabled && allowed && !closed);
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
            synchronized (this) {
                for (String block : resyncBlocks) if (blocks.containsKey(block) && !loaded.contains(block)) { missing = block; break; }
                if (missing == null) for (Candidate.Progress item : progress.values()) if (item.confirmed != null && item.confirmed.orphaned && !item.confirmed.reopened && !item.blockHash.equals(item.confirmed.reloadedFundingBlock)
                        && blocks.containsKey(item.blockHash) && !loaded.contains(item.blockHash)) { missing = item.blockHash; break; }
                if (missing == null) for (String block : blocks.keySet()) if (!loaded.contains(block)) { missing = block; break; }
            }
            stage = "catalog";
            scope = missing == null ? "" : missing;
            if (missing != null && now() >= nextBlock) loadBlock(missing, epoch);
            stage = "receipt"; scope = "";
            reconcileSaved(epoch);
            Candidate candidate;
            synchronized (this) {
                check(epoch); refreshSchedule();
                MobileClaimScheduler.Selection preparation = catalogFresh() ? scheduler.next(now(), false) : null;
                candidate = heldWinnerCount() >= MAX_RETAINED_WINNERS || preparation == null ? null : preparation.row;
                status = !catalogFresh() || pendingReadDiagnostic() ? "retrying" : heldWinnerCount() >= MAX_RETAINED_WINNERS ? "waiting" : candidate == null && scheduler.next(now(), true) == null ? (loaded.size() < blocks.size() ? "synchronizing" : "waiting") : "claiming";
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
                    proof.setStartAllowed(startLimiter, false); cancelUnsafeQueuedTransmissions(); resetStartSchedule();
                }
            }
        }
        catch (ReadFailure error) {
            synchronized (this) { if (epoch == generation && enabled) { recordRpcError(error.failure, error.method, stage); lastRpcScope = scope; } }
            if (!retryRead(error.failure, error.method, epoch)) failed(error.failure, epoch, false);
        }
        catch (Exception | LinkageError error) { failed(error instanceof JSONException ? new IllegalArgumentException("CLAIMS_RPC_DATA", error) : error, epoch, false); }
    }
    /** This entry point is deliberately confined to maintain() READ failures. */
    private synchronized boolean retryRead(MobileRpcClient.RpcFailure error, String method, long epoch) {
        // EOF after a written read has these conservative protocol/stream codes.
        // Only the transport's positive loss evidence makes them recoverable:
        // malformed replies and financial outcome ambiguity remain failures.
        boolean disconnectedRead = error.transportLoss && !error.explicitRejection &&
            (error.code.equals("RPC_PROTOCOL") || error.code.equals("RPC_STREAM_INCOMPLETE"));
        // This code means a temporarily unavailable funding lookup ONLY here.
        // sendrawtransaction uses it for an ambiguous financial outcome and
        // must never inherit read retry semantics.
        boolean fundingUnavailable = method.equals("gettransaction") && error.code.equals("-32002") &&
            error.nodeCode == null && !error.explicitRejection;
        if (error.unknownOutcome || (!disconnectedRead && !fundingUnavailable &&
            !java.util.Arrays.asList("RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "-32001", "-32029", "-32030").contains(error.code))) return false;
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
            if (!java.util.Arrays.asList("getchaintip", "getbountychanges", "getrecentblockhashes", "getblockbounties", "gettransaction", "gettransactionstatus", "sendrawtransaction").contains(method)) method = fallbackMethod;
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
            if (code.equals("-32011") || code.equals("-32004") || code.equals("CLAIMS_RESYNC") || code.equals("CLAIMS_SYNC_BUSY")) {
                // A replay budget is a work bound, not invalid server data.
                // Repeating its original cursor can never drain a larger
                // backlog. Obtain a fresh watermark before reloading streams,
                // retaining admitted proofs/counters behind the resync gate.
                resetCatalog(true); lastError = code; status = "retrying"; retryAt = now() + 1000; nextDiscovery = 0;
                cancelUnsafeQueuedTransmissions(); resetStartSchedule(); return;
            }
            if (code.equals("CLAIMS_WRONG_NETWORK") || code.equals("CLAIMS_CAPACITY") || code.equals("CLAIMS_RPC_DATA") || code.equals("CLAIMS_NATIVE_DATA") || code.equals("CLAIMS_RECEIPT_UNAVAILABLE") || error instanceof LinkageError) { enabled = false; pauseClock(); status = "error"; }
            else { status = "retrying"; retryAt = now() + (code.equals("-32029") ? 60000 : 5000); nextDiscovery = 0; }
            lastError = code; generation++; clearFunding(); cancelCaptures(null, -1); resetStartSchedule(); acknowledgeStarts();
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
        synchronized (this) { check(epoch); if (!catalogFresh() || !rowAvailable(row.key)) return; prepared = row.progress.prepared; }
        if (prepared == null) {
            String txid = row.bounty.getString("txid"), parentHex;
            synchronized (this) { parentHex = parents.get(txid); if (parentHex == null && now() < nextPreparation) return; }
            if (parentHex == null) {
                // Keep preparation under the shared RPC method quota. Hashing
                // 100 proofs/s must never mean 100 funding lookups/s.
                synchronized (this) { nextPreparation = now() + 1500; }
                capabilities(); JSONObject parent;
                JSONObject fundingParams = new JSONObject().put("txid", txid); if (rawFunding) fundingParams.put("raw_only", true);
                try { parent = request("gettransaction", fundingParams, epoch); }
                catch (ReadFailure failure) { capabilities(); if (!rawFunding || !"-32602".equals(failure.failure.code)) throw failure; rawFunding = false; parent = request("gettransaction", new JSONObject().put("txid", txid), epoch); }
                validateTip(parent.optJSONObject("tip")); JSONObject tx = parent.optJSONObject("transaction");
                require(tx != null && tx.opt("hex") instanceof String, "CLAIMS_RPC_DATA"); parentHex = tx.getString("hex");
            }
            prepared = transactions.prepare(row.bounty, parentHex, rewardAddress, fundingValidation, () -> check(epoch));
            synchronized (this) {
                check(epoch); Candidate current = catalog.get(row.key); if (!catalogFresh() || current == null || !rowAvailable(row.key)) return;
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
        if (closed || !enabled || !allowed || unknownBlocked || !catalogFresh() || reservations.size() >= MAX_CONCURRENCY || heldWinnerCount() + activeCaptures.size() >= MAX_RETAINED_WINNERS) { admissionIdle = true; return null; }
        // Full capacity is still continuous demand; preserve the global phase.
        if (activeCaptures.size() >= concurrency || admittedAt < nextAttemptNanos) return null;
        // Stop/Start creates a fresh native budget key. The prior run must
        // finish importing any captured-but-cancelled observations before a
        // new key is seeded, even though Start itself may already be enabled.
        // LinkedHashMap preserves admission order; this gate itself prevents
        // different runs from mixing, so inspecting its oldest entry suffices.
        if (!activeCaptures.isEmpty() && activeCaptures.values().iterator().next().run != runSerial) return null;
        refreshSchedule(); MobileClaimScheduler.Selection selection = scheduler.next(now(), true);
        if (selection == null) { admissionIdle = true; return null; }
        Candidate row = selection.row;
        if (!rowAvailable(row.key) || !row.budget()) { scheduler.remove(row.key); return null; }
        if (!selection.recovery && !MobileClaimScheduler.worth(row.raw, MobileClaimScheduler.rate(row, domains))) { scheduleDirty = true; return null; }
        if (!domains.containsKey(row.policy)) { require(domains.size() < MAX_DOMAINS * 7, "CLAIMS_CAPACITY"); domains.put(row.policy, new PerformanceWindow(this::now)); }
        long handle = proof.create(startLimiter);
        try { proof.bindBudget(handle, Long.toHexString(runSerial) + ":" + row.key, row.target, row.progress.captures.toString()); }
        catch (RuntimeException | LinkageError error) { proof.destroy(handle); throw error; }
        Capture capture = new Capture(++captureSerial, generation, runSerial, row, handle, selection);
        if (!scheduler.reserve(selection, now())) { proof.destroy(handle); return null; }
        activeCaptures.put(capture.id, capture); currentDomain = row.domain;
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
        // Scheduler deadlines are whole milliseconds. Round the native event
        // up, not down, so fractional milliseconds cannot shorten 250 ms.
        long probeStartedMs = TimeUnit.NANOSECONDS.toMillis(startedAt) + (startedAt % 1_000_000 == 0 ? 0 : 1);
        scheduler.acknowledge(capture.selection, probeStartedMs);
        if (capture.run != runSerial) return;
        attempts = increment(attempts);
        recentStarts.record(startedAt, nanoClock.getAsLong());
    }
    private static final class Capture {
        final long id, epoch, run, handle; final Candidate row; final MobileClaimScheduler.Selection selection; boolean cancelled, started, outcomeCounted, budgetCounted;
        Capture(long id, long epoch, long run, Candidate row, long handle, MobileClaimScheduler.Selection selection) { this.id = id; this.epoch = epoch; this.run = run; this.row = row; this.handle = handle; this.selection = selection; }
    }
    private synchronized void releaseCapture(Capture capture) {
        if (activeCaptures.remove(capture.id) == null) return;
        acknowledgeStart(capture);
        if (!capture.budgetCounted && proof.hasCaptured(capture.handle)) accountCaptured(capture);
        scheduler.release(capture.selection);
        proof.destroy(capture.handle);
        pruneRetained();
        releaseObsoleteResyncGate();
        currentDomain = activeCaptures.isEmpty() ? "" : activeCaptures.values().iterator().next().row.domain;
    }
    private void accountCaptured(Capture capture) {
        if (capture.budgetCounted) return;
        capture.budgetCounted = true;
        Candidate row = capture.row;
        row.progress.captures = row.progress.captures.add(BigInteger.ONE).min(MAX_CAPTURES);
        Candidate.Progress current = progress.get(row.key);
        // A reorg may already have copied this outpoint's accounting while the
        // old native call was draining. Import this handle once into both views,
        // without reviving removed work or crediting a new run's UI counters.
        if (current != null && current.metadata.equals(row.progress.metadata)) {
            if (current != row.progress) current.captures = current.captures.add(BigInteger.ONE).min(MAX_CAPTURES);
            if (current.captures.compareTo(row.captureStopCount) >= 0) scheduler.remove(row.key);
        }
    }
    private void capture(Capture capture, boolean asyncSubmit) {
        try { captureResult(capture, asyncSubmit); }
        catch (Stopped stopped) { countCancelled(capture); }
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
        } catch (IllegalStateException failure) {
            if ("CLAIM_CANCELLED".equals(failure.getMessage())) throw new Stopped();
            if ("CLAIM_BUDGET".equals(failure.getMessage())) {
                synchronized (this) {
                    acknowledgeStart(capture); check(epoch); if (capture.cancelled) throw new Stopped();
                    require(!capture.started, "CLAIMS_NATIVE_DATA");
                    row.progress.budgetExhausted = true; scheduler.remove(row.key);
                }
                return;
            }
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
        Winner winner;
        synchronized (this) {
            check(epoch);
            // A missing local route/family says nothing about the server's
            // speed. Preserve real attempts/failures without poisoning rank.
            if (!locallyUnavailable) domains.get(row.policy).record(validationPassed, duration / 1000.0);
            if (captured) accountCaptured(capture);
            if (validationPassed) valid = increment(valid); else invalid = increment(invalid);
            capture.outcomeCounted = true;
            if (hit) targetHits = increment(targetHits);
            if (!pendingReadDiagnostic()) lastError = verified ? "" : java.util.Arrays.asList("CLAIM_NETWORK", "CLAIM_TLS", "CLAIM_CERTIFICATE", "CLAIM_TIMEOUT", "CLAIM_LOCAL_UNAVAILABLE").contains(nativeCode) ? nativeCode : "CLAIM_INVALID_PROOF";
            if (!hit) return;
            require(result.opt("proof") instanceof String, "CLAIMS_NATIVE_DATA");
            winner = new Winner(row, prepared, result.getString("proof"), epoch);
            check(epoch);
            if (capture.cancelled || !ownedAvailable(row)) return;
            // Counting the verified hit and publishing its owner is one commit.
            // A pending-spend notification between them would otherwise discard
            // this completed proof before the winner's retention rules can run.
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
            if (winnerUsable(winner) && !winnerCanSubmit(winner)) {
                winner.keepForRetry = true; winner.retryDue = now() + 1000;
                status = "retrying";
                return; // Incoherent discovery state never occupies the executor.
            }
            winner.scheduled = true; winner.keepForRetry = false;
        }
        Runnable submit = () -> {
            try { submit(winner); }
            catch (Stopped stopped) {
                synchronized (MobileClaimsEngine.this) {
                    if (!winner.transmissionAttempted && !closed && winnerRetainable(winner)) winner.keepForRetry = true;
                }
            }
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
        final Candidate row; final JSONObject prepared; final String proof; long epoch;
        boolean transmissionAttempted, cancelledBeforeWrite, cancelledForStaleness, scheduled, keepForRetry;
        boolean acknowledged, submissionCounted, rejected, reopened, ownAbsenceValidated;
        String transactionHex, txid;
        long retryDue, acknowledgedAt;
        int failures;
        Winner(Candidate row, JSONObject prepared, String proof, long epoch) { this.row = row; this.prepared = prepared; this.proof = proof; this.epoch = epoch; }
    }
    private synchronized void releaseWinner(Winner winner) {
        if (pendingWinners.get(winner.row.key) != winner) return;
        if (winner.keepForRetry && !winner.transmissionAttempted && !unknownBlocked && !closed && winnerRetainable(winner)) saveWinner(winner);
        pendingWinners.remove(winner.row.key);
        reservations.remove(winner.row.key);
        pruneRetained();
        releaseObsoleteResyncGate();
        // A winner queued behind another output has not been sent yet. Pause,
        // offline and transient discovery failures must not retire it forever.
        if ((!winner.transmissionAttempted || winner.rejected && winner.reopened) && !savedWinners.containsKey(winner.row.key)) { retired.remove(winner.row.key); scheduleDirty = true; }
    }
    private boolean winnerUsable(Winner winner) {
        return !closed && enabled && allowed && !unknownBlocked && winner.epoch == generation
            && pendingWinners.get(winner.row.key) == winner && reservations.contains(winner.row.key)
            && winnerOwnedAvailable(winner);
    }
    private void discardIdleWinners() {
        for (Winner winner : new ArrayList<>(pendingWinners.values())) if (!winner.scheduled && !winnerUsable(winner)) {
            if (!winner.transmissionAttempted && winnerRetainable(winner)) winner.keepForRetry = true;
            releaseWinner(winner);
        }
    }
    private void retryWinners(boolean asynchronous) {
        List<Winner> due = new ArrayList<>();
        synchronized (this) {
            discardIdleWinners();
            if (!catalogFresh()) return;
            for (Winner winner : pendingWinners.values()) if (!winner.scheduled && winner.retryDue <= now() && winnerUsable(winner) && winnerCanSubmit(winner)) due.add(winner);
        }
        for (Winner winner : due) queueWinner(winner, asynchronous);
    }
    private int heldWinnerCount() {
        int count = pendingWinners.size();
        for (String key : savedWinners.keySet()) if (!pendingWinners.containsKey(key)) count++;
        return count;
    }
    private void saveWinner(Winner winner) {
        require(savedWinners.containsKey(winner.row.key) || pendingWinners.containsKey(winner.row.key) || heldWinnerCount() < MAX_RETAINED_WINNERS, "CLAIMS_CAPACITY");
        savedWinners.put(winner.row.key, winner); retired.add(winner.row.key);
    }
    private void forgetSaved(Winner winner) {
        if (savedWinners.get(winner.row.key) != winner) return;
        savedWinners.remove(winner.row.key); pruneRetained(); releaseObsoleteResyncGate();
    }
    private void validateObserved(String raw, String expectedTxid, String originalHex, String target) {
        try { transactions.validateObserved(raw, expectedTxid, originalHex, target); }
        catch (Exception failure) { throw new IllegalArgumentException("CLAIMS_RPC_DATA", failure); }
    }
    /** Shared by manual recovery and automatic reconciliation. A matching raw
     * txid does not make contradictory receipt/location metadata trustworthy. */
    private static final class ReceiptEnvelope {
        final JSONObject tip; final boolean locationChanged;
        ReceiptEnvelope(JSONObject tip, boolean locationChanged) { this.tip = tip; this.locationChanged = locationChanged; }
    }
    private static ReceiptEnvelope validateReceiptEnvelope(JSONObject response, String expectedTxid) throws JSONException {
        require(response != null, "CLAIMS_RPC_DATA");
        JSONObject receiptTip = validateTip(response.optJSONObject("tip"));
        JSONObject transaction = response.optJSONObject("transaction");
        require(transaction != null && transaction.opt("hex") instanceof String, "CLAIMS_RPC_DATA");
        require(!transaction.has("txid") || expectedTxid.equals(hash(transaction.opt("txid"))), "CLAIMS_RPC_DATA");
        String location = response.optString("status", "");
        require(location.equals("pending") || location.equals("confirmed"), "CLAIMS_RPC_DATA");
        boolean changed = false;
        // The index location and Core's verbose transaction are separate reads.
        // A well-typed disagreement can be a block/reorg between those reads.
        // Validate every field (and the raw proof at the caller) before retrying;
        // never accept the contradiction as an ACK or compact its retained bytes.
        if (location.equals("pending")) {
            require(!response.has("block_hash") && !response.has("block_height"), "CLAIMS_RPC_DATA");
            if (transaction.has("blockhash")) { hash(transaction.opt("blockhash")); changed = true; }
            if (transaction.has("confirmations")) changed |= integer(transaction.opt("confirmations"), 0, SAFE_MAX) > 0;
        } else {
            String block = hash(response.opt("block_hash"));
            long height = integer(response.opt("block_height"), 0, receiptTip.getLong("height"));
            require(height != 0 || block.equals(GENESIS), "CLAIMS_RPC_DATA");
            require(height != receiptTip.getLong("height") || block.equals(receiptTip.getString("hash")), "CLAIMS_RPC_DATA");
            if (transaction.has("confirmations")) changed |= integer(transaction.opt("confirmations"), 0, SAFE_MAX) == 0;
            if (transaction.has("blockhash")) changed |= !block.equals(hash(transaction.opt("blockhash")));
        }
        return new ReceiptEnvelope(receiptTip, changed);
    }
    static JSONObject validateCompactReceipt(JSONObject response, String expectedTxid) throws Exception {
        require(response != null && expectedTxid.equals(hash(response.opt("txid"))), "CLAIMS_RPC_DATA");
        JSONObject observed = validateTip(response.optJSONObject("tip")); String status = response.optString("status", "");
        require(!response.has("transaction") && !response.has("hex"), "CLAIMS_RPC_DATA");
        if (status.equals("pending")) {
            require(response.length() == 4 && !response.has("block_hash") && !response.has("block_height") && integer(response.opt("confirmations"), 0, 0) == 0, "CLAIMS_RPC_DATA");
        } else {
            require(status.equals("confirmed") && response.length() == 6, "CLAIMS_RPC_DATA");
            String block = hash(response.opt("block_hash")); long height = integer(response.opt("block_height"), 0, observed.getLong("height"));
            require(integer(response.opt("confirmations"), 1, SAFE_MAX) == observed.getLong("height") - height + 1, "CLAIMS_RPC_DATA");
            require(height != 0 || block.equals(GENESIS), "CLAIMS_RPC_DATA");
            require(height != observed.getLong("height") || block.equals(observed.getString("hash")), "CLAIMS_RPC_DATA");
        }
        return observed;
    }
    private boolean restoreSaved(Winner winner, long epoch) {
        if (savedWinners.get(winner.row.key) != winner || reservations.size() >= MAX_CONCURRENCY || !catalogFresh() || !winnerOwnedAvailable(winner)
                || winner.acknowledged && catalogValidatedAt <= winner.acknowledgedAt) return false;
        winner.epoch = epoch; winner.transmissionAttempted = false; winner.keepForRetry = true;
        winner.scheduled = false; winner.cancelledBeforeWrite = winner.cancelledForStaleness = false;
        // Keep the retained owner until a definitive outcome. A new pending
        // spend can cancel this quota-queued replay before any byte is sent;
        // that must not erase an earlier ACK or its original signed bytes.
        pendingWinners.put(winner.row.key, winner); reservations.add(winner.row.key);
        return true;
    }
    /** ACK retention is in-memory and bounded. Never invent a second proof or
     * treat an old available snapshot as permission to duplicate a submission.
     * Receipt reads share the funding method's 1.5-second admission budget. */
    private void reconcileSaved(long epoch) throws Exception {
        Winner lookup = null;
        synchronized (this) {
            check(epoch); if (!catalogFresh()) return;
            for (Winner winner : new ArrayList<>(savedWinners.values())) {
                if (winner.scheduled || pendingWinners.containsKey(winner.row.key)) continue;
                Candidate current = ownedRow(winner.row.key);
                if (!winner.acknowledged) {
                    if (current != null && (!current.blockHash.equals(winner.row.blockHash) || !current.sameMetadata(winner.row) || current.state.equals("unavailable") || current.state.equals("spent"))) {
                        forgetSaved(winner); retired.remove(winner.row.key); scheduleDirty = true; continue;
                    }
                    if (winner.retryDue <= now() && (!winner.rejected || winner.reopened)) restoreSaved(winner, epoch);
                } else if (winner.retryDue <= now() && now() >= nextReceiptLookup && now() >= nextPreparation
                        && (lookup == null || winner.retryDue < lookup.retryDue)) {
                    // Service the oldest deadline, not insertion order. Two
                    // early absent claims can otherwise alternate 5-second
                    // retries and starve every later receipt indefinitely.
                    lookup = winner;
                }
            }
            if (lookup == null) return;
            nextPreparation = now() + 1500;
            // Receipt reconciliation must leave funding admission slots too.
            nextReceiptLookup = now() + 3000;
            lookup.retryDue = now() + 30000;
        }
        final Winner winner = lookup;
        // Status alone never proves a preserved claim is locally valid. Bind
        // and validate our original proof/bytes before any compact receipt read.
        validateObserved(winner.transactionHex, winner.txid, winner.transactionHex, winner.row.target);
        capabilities(); JSONObject response; boolean metadata = compactReceipts;
        try {
            if (metadata) {
                try { response = request("gettransactionstatus", new JSONObject().put("txid", winner.txid), epoch); }
                catch (ReadFailure unsupported) {
                    capabilities();
                    if (!"-32601".equals(unsupported.failure.code)) throw unsupported;
                    compactReceipts = false; metadata = false; response = request("gettransaction", new JSONObject().put("txid", winner.txid), epoch);
                }
            } else response = request("gettransaction", new JSONObject().put("txid", winner.txid), epoch);
        }
        catch (ReadFailure failure) {
            if (!failure.failure.code.equals("-32004") || failure.failure.unknownOutcome || failure.failure.explicitRejection || failure.failure.nodeCode != null) throw failure;
            synchronized (this) {
                check(epoch); if (savedWinners.get(winner.row.key) != winner) return;
                winner.retryDue = now() + 5000;
                winner.ownAbsenceValidated = true;
                // The exact transaction is absent AND a coherent catalog says
                // the same funding output is available. Core still validates
                // the same signed bytes on retransmission.
                if (catalogValidatedAt > winner.acknowledgedAt && winnerOwnedAvailable(winner) && (!winner.rejected || winner.reopened)) { winner.retryDue = now(); restoreSaved(winner, epoch); }
                readRecovered("receipt");
            }
            return;
        }
        JSONObject confirmedTip;
        if (metadata) confirmedTip = validateCompactReceipt(response, winner.txid);
        else {
            ReceiptEnvelope envelope = validateReceiptEnvelope(response, winner.txid);
            validateObserved(response.getJSONObject("transaction").getString("hex"), winner.txid, winner.transactionHex, winner.row.target);
            if (envelope.locationChanged) throw new ChainMoved(); confirmedTip = envelope.tip;
        }
        String location = response.getString("status");
        String block = null; long height = -1;
        if (location.equals("confirmed")) {
            block = response.getString("block_hash"); height = response.getLong("block_height");
        }
        synchronized (this) {
            check(epoch); if (savedWinners.get(winner.row.key) != winner) return;
            if (!MobileClaimBlockWindow.sameTip(tip, confirmedTip)) throw new ChainMoved();
            winner.ownAbsenceValidated = false;
            if (location.equals("confirmed")) {
                for (Map.Entry<String, Long> known : blocks.entrySet()) if (known.getValue() == height) require(known.getKey().equals(block), "CLAIMS_RPC_DATA");
                Candidate.Progress item = progress.get(winner.row.key);
                // sameTip above anchors the receipt to a local snapshot that
                // has already reached height; a receipt ahead of local sync
                // cannot later be mistaken for a chain rollback.
                if (item != null && item.blockHash.equals(winner.row.blockHash) && item.metadata.equals(winner.row.progress.metadata))
                    item.confirmed = new ConfirmedClaim(winner.txid, block, height, winner.submissionCounted);
                forgetSaved(winner);
            }
            readRecovered("receipt");
        }
    }
    private synchronized void retainUnsentWinner(Winner winner, String code, long retryAfterMs) {
        boolean transientFailure = java.util.Arrays.asList("RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "-32001", "-32029", "-32030").contains(code);
        if (!transientFailure && !(code.equals("RPC_CANCELLED") && (winner.cancelledForStaleness || winner.epoch != generation || !enabled || !allowed))) return;
        if (unknownBlocked || closed || !winnerRetainable(winner)) return;
        long delay = Math.max(Math.min(30000L, 1000L << winner.failures), Math.max(0, retryAfterMs));
        winner.failures = Math.min(5, winner.failures + 1);
        winner.retryDue = now() + Math.min(SAFE_MAX - now(), delay);
        winner.keepForRetry = true;
        if (winner.epoch == generation && enabled && allowed) { status = "retrying"; lastError = code; }
    }
    private synchronized void countCancelled(Capture capture) {
        // Automatic network/background pauses invalidate epochs without ending
        // the run. Count their drained captures, but never mutate a NEW run.
        if (capture.run == runSerial && !capture.outcomeCounted) {
            cancelled = increment(cancelled);
            capture.outcomeCounted = true;
        }
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
            Candidate.Progress item = progress.get(winner.row.key);
            if (item != null && item.confirmed != null && item.confirmed.counted && item.confirmed.txid.equals(winner.txid)) winner.submissionCounted = true;
            if (!closed && pendingWinners.get(winner.row.key) == winner) saveWinner(winner);
            check(epoch); if (!winnerUsable(winner)) return;
            if (!winnerCanSubmit(winner)) {
                // Queued behind another output, or a retry whose read refresh
                // is still pending: no transmission has been enqueued here.
                winner.keepForRetry = true; winner.retryDue = now() + 1000; status = "retrying";
                return;
            }
            // Enqueue and register under the same lifecycle lock: Stop can
            // either precede transmission, or cancel/retain its outcome.
            recordReceipt(expectedTxid, "pending");
            winner.transmissionAttempted = true; winner.cancelledBeforeWrite = winner.cancelledForStaleness = false; winner.rejected = winner.reopened = false;
            try { transmission = rpc.broadcast(winner.transactionHex, this, () -> {
                check(epoch);
                if (!winnerCanSubmit(winner) || !winnerUsable(winner)) {
                    winner.cancelledForStaleness = winnerUsable(winner) && !winnerCanSubmit(winner);
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
            recordAcknowledged(winner, epoch);
        } catch (MobileRpcClient.RpcFailure error) {
            synchronized (this) { if (epoch == generation) recordRpcError(error, "sendrawtransaction", "submission"); }
            if (error.unknownOutcome || Integer.valueOf(-27).equals(error.nodeCode)) { uncertain(expectedTxid); return; }
            if (error.notSent || error.notForwarded) {
                retainUnsentWinner(winner, error.code, error.retryAfterMs);
                notSent(winner, expectedTxid);
                return;
            }
            if (winner.cancelledBeforeWrite && error.code.equals("RPC_CANCELLED")) {
                retainUnsentWinner(winner, error.code, error.retryAfterMs); notSent(winner, expectedTxid);
                return;
            }
            if (error.explicitRejection) {
                recordRejected(winner, epoch);
                return;
            }
            // False unknownOutcome alone is not positive evidence of no write.
            uncertain(expectedTxid);
        } catch (Exception unexpected) {
            synchronized (this) {
                if (winner.cancelledBeforeWrite) {
                    retainUnsentWinner(winner, "RPC_CANCELLED", 0); notSent(winner, expectedTxid);
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
            // durable pending receipt has been replaced by proven non-sending
            // or an explicit gateway response proving no forwarding to Core.
            winner.transmissionAttempted = false;
            return true;
        } catch (Exception receiptFailure) {
            uncertain(txid);
            uncommittedReceipt = new UncommittedReceipt(winner, ReceiptState.NOT_SENT);
            return false;
        }
    }
    private synchronized void recordRejected(Winner winner, long epoch) {
        // An explicit rejection is not an unknown network outcome. A failed
        // durable write must keep the crash guard, but must not erase the live
        // response or allow immediate replay of a still-rejected transaction.
        winner.rejected = true; saveWinner(winner);
        try { recordReceipt(winner.txid, "rejected"); }
        catch (Exception receiptFailure) {
            uncertain(winner.txid);
            uncommittedReceipt = new UncommittedReceipt(winner, ReceiptState.REJECTED);
            return;
        }
        if (epoch == generation) { lastError = "CLAIMS_REJECTED"; nextDiscovery = 0; }
    }
    private void acknowledgeWinner(Winner winner) {
        if (!winner.submissionCounted) { submitted = increment(submitted); winner.submissionCounted = true; }
        winner.acknowledged = true; winner.acknowledgedAt = now(); winner.rejected = winner.ownAbsenceValidated = false;
        winner.retryDue = now() + 30000; saveWinner(winner);
    }
    private synchronized void recordAcknowledged(Winner winner, long epoch) {
        // A validated ACK may leave the mempool before a manual lookup can
        // find it. Preserve that live evidence across a failed durable write;
        // recovery still commits submitted before the normal receipt/freshness
        // gates can ever authorize replay of these exact signed bytes.
        try { recordReceipt(winner.txid, "submitted"); }
        catch (Exception receiptFailure) {
            uncertain(winner.txid);
            uncommittedReceipt = new UncommittedReceipt(winner, ReceiptState.SUBMITTED);
            return;
        }
        acknowledgeWinner(winner);
        if (epoch == generation && enabled && lastRpcError == null && catalogFresh()) status = "submitted";
    }
    private synchronized boolean rowAvailable(String key) { Candidate row = catalog.get(key); return row != null && row.supported && row.state.equals("available") && !retired.contains(key); }
    private synchronized void uncertain(String txid) {
        // Even a simultaneous Stop must retain this information: transmission
        // already occurred and must not become a silently retryable claim.
        lastTxid = txid; uncommittedReceipt = null; unknown = increment(unknown); unknownBlocked = true; enabled = false; pauseClock(); status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME";
        try { recordReceipt(txid, "unknown"); } catch (Exception ignored) { /* The pre-write pending receipt remains a conservative crash guard. */ }
        generation++; clearFunding(); discardIdleWinners(); cancelCaptures(null, -1); resetStartSchedule(); acknowledgeStarts(); cancelOwned(new ArrayList<>(operations));
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
    private static final class ConfirmedClaim {
        final String txid, blockHash; final long height; final boolean counted;
        boolean orphaned, reopened; String reloadedFundingBlock;
        ConfirmedClaim(String txid, String blockHash, long height, boolean counted) {
            this.txid = txid; this.blockHash = blockHash; this.height = height; this.counted = counted;
        }
    }
    static final class Candidate {
        final JSONObject bounty; final String key, domain, policy, target, blockHash; final int mask; final long height; final boolean coinbase, supported;
        final BigInteger raw, targetPlusOne, captureStopCount;
        final String outpointOrder; final long outputIndex;
        private BigInteger cachedPriority; private int cachedFactor;
        String state, spendingTxid; Progress progress;
        static final class Progress {
            final int factor; final String blockHash, policy, metadata; final long height;
            JSONObject prepared; BigInteger captures = BigInteger.ZERO; boolean budgetExhausted;
            ConfirmedClaim confirmed;
            Progress(int factor, String blockHash, long height, String policy, String metadata) {
                require(factor >= MobileClaimScheduler.FACTOR_SCALE && factor <= MobileClaimScheduler.FACTOR_MAX, "CLAIMS_PRIORITY_FACTOR");
                this.factor = factor; this.blockHash = blockHash; this.height = height; this.policy = policy; this.metadata = metadata;
            }
            Progress accountingOnly() {
                if (prepared == null) return this;
                Progress result = new Progress(factor, blockHash, height, policy, metadata);
                result.captures = captures; result.budgetExhausted = budgetExhausted; result.confirmed = confirmed;
                return result;
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
            if (bounty.has("spending_txid") && !bounty.isNull("spending_txid")) spendingTxid = hash(bounty.opt("spending_txid"));
            // These can be valid on-chain outputs, but cannot safely be dialed
            // by this public-only native engine. Do not let one poison others.
            supported = roots == 1 && domain.contains(".") && !domain.matches("[0-9]+(?:\\.[0-9]+){3}") && !domain.endsWith(".localhost") && !domain.endsWith(".local") && !domain.endsWith(".internal");
            key = key(bounty); targetPlusOne = new BigInteger(target, 16).add(BigInteger.ONE); raw = amount > fee ? targetPlusOne.multiply(BigInteger.valueOf(amount - fee)) : BigInteger.ZERO;
            captureStopCount = SPACE.shiftLeft(1).divide(targetPlusOne).add(BigInteger.ONE).min(MAX_CAPTURES);
            String txid = bounty.getString("txid"); StringBuilder order = new StringBuilder(64);
            for (int index = 62; index >= 0; index -= 2) order.append(txid, index, index + 2);
            outpointOrder = order.toString(); outputIndex = bounty.getLong("vout");
            progress = new Progress(factor, blockHash, height, policy, domain + ":" + amount + ":" + target + ":" + roots + ":" + mask + ":" + coinbase);
        }
        Candidate copy() throws Exception { return new Candidate(this); }
        private Candidate(Candidate source) throws Exception { bounty = MobileClaimsEngine.copy(source.bounty); key = source.key; domain = source.domain; policy = source.policy; target = source.target; blockHash = source.blockHash; mask = source.mask; height = source.height; coinbase = source.coinbase; supported = source.supported; raw = source.raw; targetPlusOne = source.targetPlusOne; captureStopCount = source.captureStopCount; outpointOrder = source.outpointOrder; outputIndex = source.outputIndex; state = source.state; spendingTxid = source.spendingTxid; progress = source.progress; }
        BigInteger priority() {
            if (cachedPriority == null || cachedFactor != progress.factor) { cachedFactor = progress.factor; cachedPriority = raw.multiply(BigInteger.valueOf(cachedFactor)); }
            return cachedPriority;
        }
        boolean budget() { return !progress.budgetExhausted && progress.captures.compareTo(captureStopCount) < 0; }
        boolean sameMetadata(Candidate other) { return progress.metadata.equals(other.progress.metadata); }
        void reuse(Progress previous) {
            require(previous.metadata.equals(progress.metadata), "CLAIMS_RPC_DATA");
            if (previous.blockHash.equals(blockHash)) { progress = previous; return; }
            // Re-mining changes chain context, not the same outpoint's exact
            // successful-capture budget or stable random priority factor.
            Progress relocated = new Progress(previous.factor, blockHash, height, policy, progress.metadata);
            relocated.captures = previous.captures; relocated.budgetExhausted = previous.budgetExhausted;
            relocated.confirmed = previous.confirmed; // Small receipt metadata, never the old proof or preparation.
            progress = relocated; // Prepared work/proofs are not transplanted.
        }
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
            int available = 0, eligible = 0;
            for (Candidate row : catalog.values()) if (rowAvailable(row.key) && row.budget()) {
                available++; if (row.raw.signum() > 0 && MobileClaimScheduler.worth(row.raw, MobileClaimScheduler.rate(row, domains))) eligible++;
            }
            long elapsed = elapsedBeforePause + (activeSince == 0 ? 0 : Math.max(0, now() - activeSince));
            return new JSONObject().put("enabled", enabled).put("allowed", allowed).put("running", enabled && allowed && !closed && !unknownBlocked)
                .put("status", status).put("currentDomain", currentDomain).put("eligible", eligible).put("available", available).put("economicFiltered", available - eligible)
                .put("waitingReason", status.equals("waiting") && heldWinnerCount() >= MAX_RETAINED_WINNERS ? "retained-capacity" : status.equals("waiting") && available > 0 && eligible == 0 ? "economic-floor" : "")
                .put("retainedSubmissions", heldWinnerCount()).put("discoveredBlocks", loaded.size()).put("totalBlocks", blocks.size())
                .put("discoveryComplete", cursor != null && loaded.size() == blocks.size()).put("attempts", attempts).put("valid", valid).put("invalid", invalid).put("targetHits", targetHits)
                .put("submitted", submitted).put("unknown", unknown).put("cancelled", cancelled).put("elapsedSeconds", elapsed / 1000.0).put("connectionsPerSecond", recentStarts.rate(nanoClock.getAsLong())).put("connectionsPerSecondLimit", connectionsPerSecondLimit).put("concurrency", concurrency).put("activeConnections", activeCaptures.size())
                .put("lastTxid", lastTxid).put("lastError", lastError).put("lastRpcError", lastRpcError == null ? JSONObject.NULL : copy(lastRpcError)).put("domains", measured);
        } catch (JSONException impossible) { throw new IllegalStateException("CLAIMS_STATE", impossible); }
    }
}
