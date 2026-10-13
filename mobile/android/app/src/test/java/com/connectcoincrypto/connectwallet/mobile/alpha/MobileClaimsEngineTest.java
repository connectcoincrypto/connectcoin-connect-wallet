package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.io.IOException;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Entirely offline scheduling fixtures: no keys, live hosts or broadcasts. */
public class MobileClaimsEngineTest {
    private static final String GENESIS = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e";
    private static final String TXID = repeat("12", 32), CLAIM = repeat("ab", 32), MAX_TARGET = repeat("ff", 32);
    private static String repeat(String text, int count) { return text.repeat(count); }
    private static JSONObject tip() throws Exception { return new JSONObject().put("chain", "main").put("genesis_hash", GENESIS).put("hash", GENESIS).put("height", 0).put("mediantime", 1780000000); }
    private static JSONObject bounty(String domain, String txid, long vout, String target, String amount) throws Exception {
        return new JSONObject().put("txid", txid).put("vout", vout).put("amount", amount).put("domain", domain).put("connection_work_target", target)
            .put("root_certificates_version", 1).put("signature_algorithms_mask", 7).put("block_hash", GENESIS).put("block_height", 0).put("confirmations", 1).put("coinbase", false).put("status", "available");
    }
    private static JSONObject bounty() throws Exception { return bounty("example.com", TXID, 0, MAX_TARGET, "10000000000"); }
    private static MobileClaimsEngine.Candidate candidate(JSONObject value) throws Exception { return new MobileClaimsEngine.Candidate(value, GENESIS, 10, MobileClaimScheduler.FACTOR_SCALE); }
    private static Object reserve(MobileClaimsEngine engine) throws Exception {
        java.lang.reflect.Method method = MobileClaimsEngine.class.getDeclaredMethod("reserveCapture"); method.setAccessible(true);
        synchronized (engine) { return method.invoke(engine); }
    }
    private static long handle(Object capture) throws Exception {
        java.lang.reflect.Field field = capture.getClass().getDeclaredField("handle"); field.setAccessible(true); return field.getLong(capture);
    }
    private static void release(MobileClaimsEngine engine, Object capture) throws Exception {
        java.lang.reflect.Method method = MobileClaimsEngine.class.getDeclaredMethod("releaseCapture", capture.getClass()); method.setAccessible(true);
        method.invoke(engine, capture);
    }
    private static Object engineField(MobileClaimsEngine engine, String name) throws Exception {
        java.lang.reflect.Field field = MobileClaimsEngine.class.getDeclaredField(name); field.setAccessible(true); return field.get(engine);
    }
    private static void setEngineField(MobileClaimsEngine engine, String name, Object value) throws Exception {
        java.lang.reflect.Field field = MobileClaimsEngine.class.getDeclaredField(name); field.setAccessible(true); field.set(engine, value);
    }
    private static void maintain(MobileClaimsEngine engine) throws Exception {
        java.lang.reflect.Method method = MobileClaimsEngine.class.getDeclaredMethod("maintain"); method.setAccessible(true); method.invoke(engine);
    }
    private static MobileRpcClient.RpcFailure rpcFailure(String code, String method, long retryAfterMs) throws Exception {
        java.lang.reflect.Constructor<MobileRpcClient.RpcFailure> constructor = MobileRpcClient.RpcFailure.class.getDeclaredConstructor(String.class, boolean.class, Integer.class, long.class, boolean.class, String.class, String.class, long.class, long.class, long.class);
        constructor.setAccessible(true);
        return constructor.newInstance(code, false, null, retryAfterMs, false, method, "read", 40000L, 125L, 77L);
    }
    private static MobileRpcClient.RpcFailure unsentFailure(String code, long retryAfterMs) throws Exception {
        java.lang.reflect.Method beforeWrite = MobileRpcClient.RpcFailure.class.getDeclaredMethod("beforeWrite", String.class);
        beforeWrite.setAccessible(true);
        return (MobileRpcClient.RpcFailure)beforeWrite.invoke(rpcFailure(code, "sendrawtransaction", retryAfterMs), "sendrawtransaction");
    }
    private static JSONObject proof(boolean valid, boolean target, long duration) throws Exception { return new JSONObject().put("proof", valid ? "02aa" : "").put("captured", valid).put("validationPassed", valid).put("validProof", valid).put("meetsTarget", target).put("durationMs", duration); }
    private static <T> CompletableFuture<T> failed(Exception failure) { CompletableFuture<T> value = new CompletableFuture<>(); value.completeExceptionally(failure); return value; }
    private static MobileRpcClient.RpcFailure rejected(int node) throws Exception {
        try { MobileRpcClient.reply(new JSONObject().put("jsonrpc", "2.0").put("id", "fixture").put("error", new JSONObject().put("code", -32020).put("data", new JSONObject().put("node_code", node))), "fixture"); }
        catch (MobileRpcClient.RpcFailure error) { return error; }
        throw new AssertionError();
    }
    private interface Action { void run() throws Exception; }
    private static final class Fixture implements AutoCloseable, MobileClaimsEngine.RpcAccess, MobileClaimsEngine.ProofAccess, MobileClaimsEngine.Transactions {
        final List<String> calls = new ArrayList<>(), receipts = new ArrayList<>(), limiterEvents = new ArrayList<>();
        final List<JSONArray> changes = new ArrayList<>();
        final List<Integer> windowCounts = new ArrayList<>();
        final List<String> blockReads = new ArrayList<>();
        final List<String> journalCursors = new ArrayList<>();
        final Map<String, JSONArray> blockRows = new HashMap<>();
        final Map<String, JSONArray> changesByCursor = new HashMap<>();
        final AtomicLong clock = new AtomicLong(TimeUnit.SECONDS.toNanos(100));
        final Map<Long, Long> startedTimes = new ConcurrentHashMap<>();
        final MobileClaimsEngine engine;
        JSONArray rows = new JSONArray().put(bounty());
        JSONObject nativeResult = proof(true, false, 200), currentTip = tip();
        JSONObject recentOverride;
        int changesCount, captures, prepared, attaches, broadcasts, destroys, cancellations, acknowledgementPolls;
        boolean incomplete, badParent, failReceipt, fakeTime, hideAcknowledgements, limiterDestroyed;
        boolean repeatCursor;
        long handleSerial = 6;
        Exception nativeFailure;
        final Map<String, Exception> readFailures = new HashMap<>();
        Action onCapture, onAttach, onTip, onWindow, onStream;
        Runnable onCreate;
        CompletableFuture<JSONObject> broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
        CountDownLatch sent;
        Fixture() throws Exception { this(false); }
        Fixture(boolean fakeTime) throws Exception {
            this.fakeTime = fakeTime;
            engine = new MobileClaimsEngine(this, this, this, false, () -> fakeTime ? clock.get() : System.nanoTime());
            engine.setReceiptStore((txid, status) -> { if (failReceipt) throw new IOException("fixture"); assertEquals(CLAIM, txid); receipts.add(status); });
        }
        void start() { engine.start("fixture-public-address"); engine.setAllowed(true); }
        public CompletableFuture<JSONObject> call(String method, JSONObject params) {
            calls.add(method);
            if (readFailures.containsKey(method)) return failed(readFailures.get(method));
            try { switch (method) {
                case "getchaintip": if (onTip != null) onTip.run(); return CompletableFuture.completedFuture(currentTip);
                case "getbountychanges": {
                    int page = changesCount++;
                    if (page == 0) assertEquals(0, params.length()); else assertTrue(params.has("cursor"));
                    journalCursors.add(params.optString("cursor", ""));
                    JSONArray events = changesByCursor.getOrDefault(params.optString("cursor", ""), page < changes.size() ? changes.get(page) : new JSONArray());
                    return CompletableFuture.completedFuture(new JSONObject().put("tip", currentTip).put("next_cursor", repeatCursor ? params.getString("cursor") : "cursor" + page).put("has_more", false).put("changes", events));
                }
                case "getrecentblockhashes": {
                    windowCounts.add(params.optInt("count", 600));
                    if (onWindow != null) onWindow.run();
                    if (recentOverride != null) return CompletableFuture.completedFuture(MobileClaimBlockWindowTest.prefix(recentOverride, params));
                    JSONArray recent = new JSONArray();
                    if (currentTip.getLong("height") == 1) recent.put(new JSONObject().put("height", 1).put("hash", currentTip.getString("hash")));
                    recent.put(new JSONObject().put("height", 0).put("hash", GENESIS));
                    return CompletableFuture.completedFuture(new JSONObject().put("tip", currentTip).put("window", 600).put("blocks", recent));
                }
                case "gettransaction": return CompletableFuture.completedFuture(new JSONObject().put("tip", currentTip).put("transaction", new JSONObject().put("hex", badParent ? "bad" : "parent-fixture")));
                default: throw new AssertionError(method);
            } } catch (Exception failure) { return failed(failure); }
        }
        public CompletableFuture<JSONObject> stream(String hash, MobileRpcClient.ChunkConsumer consumer) {
            calls.add("stream"); blockReads.add(hash); if (recentOverride == null) assertEquals(GENESIS, hash);
            try {
                consumer.accept(new JSONObject().put("type", "snapshot").put("tip", currentTip).put("cursor", "stream-watermark"));
                consumer.accept(new JSONObject().put("type", "bounties").put("tip", currentTip).put("items", recentOverride == null ? rows : blockRows.getOrDefault(hash, new JSONArray())));
                if (onStream != null) onStream.run();
                if (incomplete) return failed(new IOException("fixture incomplete"));
                consumer.accept(new JSONObject().put("type", "state").put("tip", currentTip).put("cursor", "stream-final"));
                return CompletableFuture.completedFuture(new JSONObject().put("complete", true));
            } catch (Exception error) { return failed(error); }
        }
        public CompletableFuture<JSONObject> broadcast(String hex) { calls.add("broadcast"); broadcasts++; assertEquals("complete-fixture", hex); if (sent != null) sent.countDown(); return broadcastFuture; }
        public long createStartLimiter(int rate) { return 1; }
        public void setStartRate(long limiter, int rate) { assertEquals(1, limiter); }
        public void resetStartSchedule(long limiter) { assertEquals(1, limiter); assertFalse("Resetting a destroyed limiter", limiterDestroyed); limiterEvents.add("reset"); }
        public void destroyStartLimiter(long limiter) { assertEquals(1, limiter); assertFalse(limiterDestroyed); limiterDestroyed = true; }
        public long create(long limiter) { assertEquals(1, limiter); long handle = ++handleSerial; startedTimes.put(handle, 0L); if (onCreate != null) onCreate.run(); return handle; }
        public long startedAtNanos(long handle) { acknowledgementPolls++; assertTrue(startedTimes.containsKey(handle)); return hideAcknowledgements ? 0 : startedTimes.get(handle); }
        public void cancel(long handle) { assertTrue(startedTimes.containsKey(handle)); limiterEvents.add("cancel"); cancellations++; }
        public void destroy(long handle) { assertNotNull("Destroyed handle twice", startedTimes.remove(handle)); destroys++; }
        public JSONObject capture(JSONObject context, long handle) throws Exception {
            captures++; assertTrue(startedTimes.containsKey(handle)); startedTimes.put(handle, nativeFailure == null ? (fakeTime ? clock.get() : System.nanoTime()) : 0); assertEquals(7, context.getInt("mask")); assertEquals("challenge", context.getString("challenge"));
            if (onCapture != null) onCapture.run(); if (nativeFailure != null) throw nativeFailure; return nativeResult;
        }
        public void validateReward(String address) { if (!"fixture-public-address".equals(address)) throw new IllegalArgumentException("invalid fixture address"); }
        public long fee() { return 10; }
        public JSONObject prepare(JSONObject value, String parent, String reward) throws Exception { prepared++; if (!parent.equals("parent-fixture")) throw new IllegalArgumentException("bad raw parent"); return new JSONObject().put("challenge", "challenge"); }
        public JSONObject attach(JSONObject prepared, String proof) throws Exception { attaches++; if (onAttach != null) onAttach.run(); return new JSONObject().put("txid", CLAIM).put("hex", "complete-fixture"); }
        public void close() { engine.close(); }
    }

    @Test public void performanceWindowCountsVerifiedProofNotTargetAndKeepsPriorSeparate() {
        MobileClaimsEngine.PerformanceWindow stats = new MobileClaimsEngine.PerformanceWindow(); assertEquals(5, stats.rate(), 0);
        assertEquals(0, stats.connections); assertEquals(0, stats.totalTime, 0);
        stats.record(false, 0.2); assertEquals(0, stats.connections); assertEquals(0.2, stats.totalTime, 1e-15);
        stats.record(true, 0.2); assertEquals(1, stats.connections); assertEquals(6 / 1.4, stats.rate(), 1e-15);
        assertEquals(2, stats.completed);
        for (int index = 0; index < 800000; index++) stats.record(false, 0.2);
        assertTrue(stats.rate() > 0); assertTrue(Double.isFinite(stats.rate()));
        MobileClaimsEngine.PerformanceWindow instant = new MobileClaimsEngine.PerformanceWindow();
        for (int index = 0; index < 800000; index++) instant.record(false, 0);
        assertTrue(instant.rate() > 0); assertTrue(Double.isFinite(instant.rate()));
    }
    @Test public void sameDomainAlwaysUsesBestNetRewardTimesTargetAndOthersUseLatency() throws Exception {
        MobileClaimsEngine.Candidate hard = candidate(bounty("example.com", TXID, 1, "0000" + repeat("ff", 30), "10000000000"));
        MobileClaimsEngine.Candidate easy = candidate(bounty("example.com", TXID, 2, "00" + repeat("ff", 31), "10000000000"));
        MobileClaimsEngine.Candidate rich = candidate(bounty("other.com", TXID, 3, "00" + repeat("ff", 31), "10000000000"));
        Map<String, MobileClaimsEngine.PerformanceWindow> stats = new HashMap<>();
        MobileClaimsEngine.PerformanceWindow slow = new MobileClaimsEngine.PerformanceWindow(); slow.record(false, 1); stats.put("other.com:7", slow);
        assertSame(easy, MobileClaimsEngine.select(Arrays.asList(hard, easy, rich), stats, new HashSet<>()));
        for (int index = 0; index < 6; index++) slow.record(true, 0);
        assertSame(rich, MobileClaimsEngine.select(Arrays.asList(hard, easy, rich), stats, new HashSet<>()));
        assertSame(hard, MobileClaimsEngine.select(Arrays.asList(easy, hard), new HashMap<>(), new HashSet<>(Arrays.asList(easy.key))));
    }
    @Test public void performanceWindowExpiresWithoutNewConnectionsAndDoesNotRollBackClock() {
        AtomicLong clock = new AtomicLong(0); MobileClaimsEngine.PerformanceWindow stats = new MobileClaimsEngine.PerformanceWindow(clock::get);
        stats.record(true, 2);
        clock.set(59 * 60000L); assertEquals(6.0 / 3, stats.rate(), 0); stats.record(false, 3);
        clock.set(60 * 60000L); assertEquals(5.0 / 4, stats.rate(), 0);
        assertEquals(1, stats.observations); assertEquals(0, stats.connections); assertEquals(2, stats.completed);
        clock.set(0); stats.record(true, 1); assertEquals(6.0 / 5, stats.rate(), 0);
        clock.set(119 * 60000L); assertEquals(6.0 / 2, stats.rate(), 0);
        clock.set(120 * 60000L); assertEquals(5, stats.rate(), 0);
        assertEquals(0, stats.observations); assertEquals(0, stats.connections); assertEquals(0, stats.totalTime, 0); assertEquals(3, stats.completed);
        assertThrows(IllegalArgumentException.class, () -> stats.record(true, Double.NaN));
        assertThrows(IllegalArgumentException.class, () -> stats.record(true, -1));
        assertEquals(3, stats.completed);
    }
    @Test public void tieBreakUsesInternalTxidBytesThenNumericVoutAndClonesPreserveFee() throws Exception {
        MobileClaimsEngine.Candidate smallInternal = candidate(bounty("example.com", "ff" + repeat("00", 31), 10, MAX_TARGET, "10000"));
        MobileClaimsEngine.Candidate bigInternal = candidate(bounty("example.com", repeat("00", 31) + "01", 2, MAX_TARGET, "10000"));
        assertSame(smallInternal, MobileClaimsEngine.select(Arrays.asList(bigInternal, smallInternal), new HashMap<>(), new HashSet<>()));
        MobileClaimsEngine.Candidate vout2 = candidate(bounty("example.com", smallInternal.bounty.getString("txid"), 2, MAX_TARGET, "10000"));
        assertSame(vout2, MobileClaimsEngine.select(Arrays.asList(smallInternal, vout2), new HashMap<>(), new HashSet<>()));
        MobileClaimsEngine.Candidate clone = vout2.copy(); assertEquals(vout2.raw, clone.raw); clone.bounty.put("domain", "changed.com"); assertEquals("example.com", vout2.bounty.getString("domain"));
    }
    @Test public void belowMinimumAndSpentImmatureUnsupportedAreNeverAttempted() throws Exception {
        List<MobileClaimsEngine.Candidate> rows = new ArrayList<>();
        rows.add(candidate(bounty("example.com", TXID, 1, MAX_TARGET, "100")));
        rows.add(candidate(bounty().put("status", "spent"))); rows.add(candidate(bounty().put("status", "immature")));
        rows.add(candidate(bounty().put("domain", "127.0.0.1"))); rows.add(candidate(bounty().put("domain", "server.local"))); rows.add(candidate(bounty().put("root_certificates_version", 2)));
        assertNull(MobileClaimsEngine.select(rows, new HashMap<>(), new HashSet<>()));
    }
    @Test public void watermarkPrecedesStreamReplayThenFundingAndValidMissUpdatesPerformanceWindow() throws Exception {
        try (Fixture f = new Fixture()) {
            f.start(); f.engine.tick();
            assertEquals(Arrays.asList("getbountychanges", "getrecentblockhashes", "getbountychanges", "getchaintip", "stream", "getbountychanges", "getchaintip", "gettransaction"), f.calls);
            assertEquals(1, f.captures); assertEquals(1, f.prepared); assertEquals(1, f.destroys); assertEquals(0, f.broadcasts);
            JSONObject state = f.engine.snapshot(); assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("valid")); assertEquals(0, state.getLong("targetHits"));
            assertEquals(1, state.getJSONArray("domains").getJSONObject(0).getLong("connections"));
            assertEquals(100, state.getInt("connectionsPerSecondLimit")); assertEquals(100, state.getInt("concurrency")); assertTrue(state.getBoolean("discoveryComplete"));
        }
    }
    @Test public void invalidCompletedHandshakeCountsFailureButDnsFailureIsNeutral() throws Exception {
        try (Fixture f = new Fixture()) { f.nativeResult = proof(false, false, 200).put("errorCode", "CLAIM_CERTIFICATE"); f.start(); f.engine.tick(); assertEquals(1, f.engine.snapshot().getLong("invalid")); assertEquals("CLAIM_CERTIFICATE", f.engine.snapshot().getString("lastError")); assertEquals(0, f.engine.snapshot().getJSONArray("domains").getJSONObject(0).getLong("connections")); }
        try (Fixture f = new Fixture()) { f.nativeFailure = new IllegalStateException("CLAIM_DNS"); f.start(); f.engine.tick(); assertEquals(0, f.engine.snapshot().getLong("invalid")); assertEquals(0, f.engine.snapshot().getJSONArray("domains").getJSONObject(0).getLong("completed")); assertTrue(f.engine.snapshot().getBoolean("enabled")); }
    }
    @Test public void locallyUnavailableStartedConnectionKeepsCountersButDoesNotPoisonDomainScore() throws Exception {
        try (Fixture f = new Fixture()) {
            f.nativeResult = proof(false, false, 1).put("errorCode", "CLAIM_LOCAL_UNAVAILABLE");
            f.start(); f.engine.tick(); JSONObject state = f.engine.snapshot();
            assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("invalid")); assertEquals(0, state.getLong("valid"));
            assertEquals("CLAIM_LOCAL_UNAVAILABLE", state.getString("lastError"));
            JSONObject domain = state.getJSONArray("domains").getJSONObject(0);
            assertEquals(0, domain.getLong("completed")); assertEquals(5, domain.getDouble("rate"), 0);
            assertTrue(state.getBoolean("enabled"));
        }
        try (Fixture f = new Fixture()) {
            f.nativeResult = proof(true, false, 1).put("errorCode", "CLAIM_LOCAL_UNAVAILABLE");
            f.start(); f.engine.tick();
            assertEquals("CLAIMS_NATIVE_DATA", f.engine.snapshot().getString("lastError"));
            assertEquals(0, f.engine.snapshot().getLong("valid")); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void streamFailureNeverPublishesPartialCatalogAndBackoffDoesNotHammerRpc() throws Exception {
        try (Fixture f = new Fixture()) { f.incomplete = true; f.start(); f.engine.tick(); assertEquals(0, f.captures); assertEquals(0, f.engine.snapshot().getInt("discoveredBlocks")); assertEquals(0, f.engine.snapshot().getInt("eligible")); int count = f.calls.size(); for (int i = 0; i < 10; i++) f.engine.tick(); assertEquals(count, f.calls.size()); }
    }
    @Test public void unchangedDiscoveryUsesNoHashListButStillReplaysMempoolAndFinalFence() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); long attempts = f.engine.snapshot().getLong("attempts");
            String oldCursor = (String)engineField(f.engine, "cursor"); int oldCalls = f.calls.size();
            while (f.changes.size() <= f.changesCount) f.changes.add(new JSONArray());
            f.changes.set(f.changesCount, new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "pending_spend")
                .put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM)));
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(List.of(600), f.windowCounts);
            assertEquals(List.of("getbountychanges", "getchaintip"), f.calls.subList(oldCalls, f.calls.size()));
            assertNotEquals(oldCursor, engineField(f.engine, "cursor"));
            assertEquals(0, f.engine.snapshot().getInt("eligible")); assertEquals(attempts, f.engine.snapshot().getLong("attempts"));
            while (f.changes.size() <= f.changesCount) f.changes.add(new JSONArray());
            f.changes.set(f.changesCount, new JSONArray().put(new JSONObject().put("sequence", 2).put("type", "available_again").put("txid", TXID).put("vout", 0)));
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(1, f.engine.snapshot().getInt("eligible")); assertEquals(List.of(600), f.windowCounts);
        }
    }
    @Test public void discoveryAdaptsNewTipsAndReorgsWithoutReplacingTheWholeHashList() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.recentOverride = MobileClaimBlockWindowTest.window(700, 0, 0); f.currentTip = f.recentOverride.getJSONObject("tip");
            f.start(); maintain(f.engine); String original = f.currentTip.getString("hash");
            f.recentOverride = MobileClaimBlockWindowTest.window(701, 0, 0); f.currentTip = f.recentOverride.getJSONObject("tip");
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(10)); maintain(f.engine);
            assertEquals(List.of(600, 5), f.windowCounts); assertTrue(((Map<?, ?>)engineField(f.engine, "blocks")).containsKey(original));
            assertTrue(((Set<?>)engineField(f.engine, "loaded")).contains(original));
            f.recentOverride = MobileClaimBlockWindowTest.window(701, 5, 1); f.currentTip = f.recentOverride.getJSONObject("tip");
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(10)); maintain(f.engine);
            assertEquals(List.of(600, 5, 5, 100), f.windowCounts); assertEquals(600, ((Map<?, ?>)engineField(f.engine, "blocks")).size());
            assertFalse(((Map<?, ?>)engineField(f.engine, "blocks")).containsKey(original));
            assertFalse(((Set<?>)engineField(f.engine, "loaded")).contains(original));
        }
    }
    @Test public void ordinaryFinalFenceRaceRestagesInCallWithoutDroppingVerifiedWinner() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(unsentFailure("RPC_UNAVAILABLE", 120000));
            f.start(); f.engine.tick(); String previous = (String)engineField(f.engine, "cursor");
            long epoch = ((Number)engineField(f.engine, "generation")).longValue(); int captures = f.captures;
            f.onTip = () -> { f.recentOverride = MobileClaimBlockWindowTest.window(1, 0, 0); f.currentTip = f.recentOverride.getJSONObject("tip"); f.onTip = null; };
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size()); assertEquals(1, f.broadcasts);
            assertEquals(List.of(600, 5), f.windowCounts); assertNotEquals(previous, engineField(f.engine, "cursor"));
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size()); assertEquals(captures, f.captures);
            assertEquals(1, f.engine.snapshot().getLong("targetHits")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void repeatedFinalFenceRacesHaveBoundedRetriesAndPreserveWinnerAndCommittedState() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(unsentFailure("RPC_UNAVAILABLE", 120000));
            f.start(); f.engine.tick(); String previous = (String)engineField(f.engine, "cursor"); Object oldWindow = engineField(f.engine, "blockWindow");
            long epoch = ((Number)engineField(f.engine, "generation")).longValue();
            f.onTip = () -> { f.recentOverride = MobileClaimBlockWindowTest.window(f.currentTip.getInt("height") + 1, 0, 0); f.currentTip = f.recentOverride.getJSONObject("tip"); };
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(previous, engineField(f.engine, "cursor")); assertSame(oldWindow, engineField(f.engine, "blockWindow"));
            assertEquals(List.of(600, 5, 5), f.windowCounts); assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size()); assertEquals(1, f.broadcasts);
            int reads = f.calls.size(); for (int i = 0; i < 10; i++) maintain(f.engine); assertEquals(reads, f.calls.size());
            f.onTip = null; f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); maintain(f.engine);
            assertNotEquals(previous, engineField(f.engine, "cursor")); assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
        }
    }
    @Test public void spendArrivingDuringAdaptiveHashReadIsReplayedBeforePublication() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); maintain(f.engine);
            f.recentOverride = MobileClaimBlockWindowTest.window(1, 0, 0); f.currentTip = f.recentOverride.getJSONObject("tip");
            f.onWindow = () -> {
                while (f.changes.size() <= f.changesCount) f.changes.add(new JSONArray());
                f.changes.set(f.changesCount, new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "pending_spend").put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM)));
                f.onWindow = null;
            };
            int reads = f.calls.size(); setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(List.of("getbountychanges", "getrecentblockhashes", "getbountychanges", "getchaintip"), f.calls.subList(reads, f.calls.size()));
            assertEquals(0, f.engine.snapshot().getInt("eligible")); assertEquals(0, f.captures); assertTrue(f.engine.snapshot().getBoolean("enabled"));
        }
    }
    @Test public void nonemptyLastJournalPageCannotReuseCursor() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); maintain(f.engine); String previous = (String)engineField(f.engine, "cursor");
            f.changesByCursor.put(previous, new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "pending_spend").put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM)));
            f.repeatCursor = true; setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(previous, engineField(f.engine, "cursor")); assertEquals("CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
            assertFalse(f.engine.snapshot().getBoolean("enabled"));
        }
    }
    @Test public void addedEventInvalidatesLoadedCanonicalBlockAndChecksHeight() throws Exception {
        for (long eventHeight : new long[] {0, 1}) try (Fixture f = new Fixture(true)) {
            f.rows = new JSONArray(); f.start(); maintain(f.engine); String previous = (String)engineField(f.engine, "cursor");
            f.changesByCursor.put(previous, new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "added").put("txid", TXID).put("vout", 0).put("block_hash", GENESIS).put("block_height", eventHeight)));
            f.rows = new JSONArray().put(bounty()); setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            if (eventHeight == 1) {
                assertFalse(f.engine.snapshot().getBoolean("enabled")); assertEquals(previous, engineField(f.engine, "cursor"));
                assertEquals("CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
            } else {
                assertFalse(((Set<?>)engineField(f.engine, "loaded")).contains(GENESIS));
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1500)); maintain(f.engine);
                assertEquals(List.of(GENESIS, GENESIS), f.blockReads); assertEquals(1, f.engine.snapshot().getInt("eligible"));
                assertEquals(List.of(600), f.windowCounts);
            }
        }
    }
    @Test public void blockStreamRaceReusesStagingAndOriginalCursorWithoutLosingSpends() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start();
            f.onStream = () -> {
                String previous = (String)engineField(f.engine, "cursor");
                f.changesByCursor.put(previous, new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "pending_spend").put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM)));
                f.recentOverride = MobileClaimBlockWindowTest.window(1, 0, 0); f.currentTip = f.recentOverride.getJSONObject("tip"); f.onStream = null;
            };
            long epoch = ((Number)engineField(f.engine, "generation")).longValue(); maintain(f.engine);
            assertEquals(List.of(GENESIS), f.blockReads); assertEquals(List.of(600, 5), f.windowCounts);
            assertEquals(List.of("", "cursor0", "cursor1", "cursor1", "cursor3"), f.journalCursors);
            assertEquals(0, f.engine.snapshot().getInt("eligible")); assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
            assertTrue(f.engine.snapshot().getBoolean("enabled")); assertTrue(((Set<?>)engineField(f.engine, "loaded")).contains(GENESIS));
            assertEquals(0, f.cancellations);
        }
    }
    @Test public void blockStreamReorgDiscardsOnlyOrphanStagingWithoutRereadingStream() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.recentOverride = MobileClaimBlockWindowTest.window(1, 0, 0); f.currentTip = f.recentOverride.getJSONObject("tip");
            String orphan = f.currentTip.getString("hash");
            f.blockRows.put(orphan, new JSONArray().put(bounty().put("block_hash", orphan).put("block_height", 1)));
            f.onStream = () -> { f.recentOverride = MobileClaimBlockWindowTest.window(1, 1, 1); f.currentTip = f.recentOverride.getJSONObject("tip"); f.onStream = null; };
            f.start(); long epoch = ((Number)engineField(f.engine, "generation")).longValue(); maintain(f.engine);
            assertEquals(List.of(orphan), f.blockReads); assertEquals(List.of(600, 5), f.windowCounts);
            assertFalse(((Map<?, ?>)engineField(f.engine, "blocks")).containsKey(orphan));
            assertFalse(((Set<?>)engineField(f.engine, "loaded")).contains(orphan));
            assertEquals(0, f.engine.snapshot().getInt("eligible")); assertTrue(((Map<?, ?>)engineField(f.engine, "catalog")).isEmpty());
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue()); assertTrue(f.engine.snapshot().getBoolean("enabled"));
        }
    }
    @Test public void canonicalBlockReloadReplacesSnapshotButPreservesSurvivingCounters() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.rows = new JSONArray().put(bounty()).put(bounty().put("vout", 1)); f.start(); f.engine.tick();
            @SuppressWarnings("unchecked") Map<String, MobileClaimsEngine.Candidate> before = (Map<String, MobileClaimsEngine.Candidate>)engineField(f.engine, "catalog");
            Object progress = before.get(TXID + ":0").progress; long attempts = f.engine.snapshot().getLong("attempts");
            f.rows = new JSONArray().put(bounty());
            ((Set<?>)engineField(f.engine, "loaded")).clear();
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1500)); maintain(f.engine);
            @SuppressWarnings("unchecked") Map<String, MobileClaimsEngine.Candidate> after = (Map<String, MobileClaimsEngine.Candidate>)engineField(f.engine, "catalog");
            assertEquals(1, after.size()); assertSame(progress, after.get(TXID + ":0").progress);
            assertEquals(attempts, f.engine.snapshot().getLong("attempts")); assertEquals(List.of(GENESIS, GENESIS), f.blockReads);
        }
    }
    @Test public void addedEventCannotMoveExistingOutpointOutsideCanonicalWindow() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); maintain(f.engine); String previous = (String)engineField(f.engine, "cursor");
            f.changesByCursor.put(previous, new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "added").put("txid", TXID).put("vout", 0).put("block_hash", "34".repeat(32)).put("block_height", 1)));
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(previous, engineField(f.engine, "cursor")); assertEquals("CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
            assertFalse(f.engine.snapshot().getBoolean("enabled"));
        }
    }
    @Test public void journalResetRetainsOnlyHashAnchorAndReloadsBountyStateAfterBackoff() throws Exception {
        for (String reset : List.of("-32011", "-32004", "resync_required")) try (Fixture f = new Fixture(true)) {
            f.start(); maintain(f.engine); Object anchor = engineField(f.engine, "blockWindow");
            if (reset.equals("resync_required")) {
                while (f.changes.size() <= f.changesCount) f.changes.add(new JSONArray());
                f.changes.set(f.changesCount, new JSONArray().put(new JSONObject().put("type", reset)));
            } else f.readFailures.put("getbountychanges", rpcFailure(reset, "getbountychanges", 0));
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertSame(anchor, engineField(f.engine, "blockWindow")); assertNull(engineField(f.engine, "cursor"));
            assertTrue(((Map<?, ?>)engineField(f.engine, "catalog")).isEmpty()); assertTrue(((Set<?>)engineField(f.engine, "loaded")).isEmpty());
            int reads = f.calls.size(); maintain(f.engine); assertEquals(reads, f.calls.size());
            f.readFailures.clear(); f.changes.clear(); f.changesCount = 0;
            f.rows = new JSONArray().put(bounty().put("status", "spent"));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); maintain(f.engine);
            assertEquals(List.of(600, 5), f.windowCounts); assertEquals(List.of(GENESIS, GENESIS), f.blockReads);
            assertEquals(0, f.engine.snapshot().getInt("eligible")); assertTrue(f.engine.snapshot().getBoolean("enabled"));
        }
    }
    @Test public void contradictoryFinalTipAndGenesisIdentityFailClosedWithoutPublishing() throws Exception {
        for (String field : List.of("height", "mediantime", "hash")) try (Fixture f = new Fixture(true)) {
            f.start(); maintain(f.engine); String previous = (String)engineField(f.engine, "cursor");
            f.onTip = () -> { if (field.equals("hash")) f.currentTip.put(field, "34".repeat(32)); else f.currentTip.put(field, f.currentTip.getLong(field) + 1); };
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(previous, engineField(f.engine, "cursor")); assertFalse(f.engine.snapshot().getBoolean("enabled"));
            assertEquals("CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
        }
    }
    @Test public void deltaSpendAfterSnapshotPreventsCapture() throws Exception {
        try (Fixture f = new Fixture()) {
            f.changes.add(new JSONArray()); f.changes.add(new JSONArray());
            f.changes.add(new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "pending_spend").put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM)));
            f.start(); f.engine.tick(); assertEquals(0, f.captures); assertEquals(0, f.engine.snapshot().getInt("eligible"));
        }
    }
    @Test public void transientMaintenanceReadsPreserveFreshCapturesAndRespectReadOnlyBackoff() throws Exception {
        for (String code : List.of("RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "-32029", "-32030")) {
            try (Fixture f = new Fixture(true)) {
                f.nativeResult = proof(false, false, 20); f.start(); f.engine.tick();
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); Object held = reserve(f.engine); assertNotNull(held);
                try {
                    long epoch = ((Number)engineField(f.engine, "generation")).longValue();
                    f.readFailures.put("getrecentblockhashes", rpcFailure(code, "getrecentblockhashes", 0));
                    setEngineField(f.engine, "blockWindow", null); // Force an actual full-window read failure, not a cache hit.
                    setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
                    assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
                    assertEquals(0, f.cancellations); assertEquals("retrying", f.engine.snapshot().getString("status"));
                    JSONObject diagnostic = f.engine.snapshot().getJSONObject("lastRpcError");
                    assertEquals("getrecentblockhashes", diagnostic.getString("method")); assertEquals("discovery", diagnostic.getString("stage"));
                    assertEquals(40000, diagnostic.getLong("elapsedMs")); assertEquals(125, diagnostic.getLong("queuedMs")); assertEquals(77, diagnostic.getLong("bytesReceived"));
                    diagnostic.put("method", "tampered"); assertEquals("getrecentblockhashes", f.engine.snapshot().getJSONObject("lastRpcError").getString("method"));
                    int reads = f.calls.size(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick();
                    assertEquals("Prepared claims continue without another RPC request", reads, f.calls.size()); assertEquals(2, f.captures);
                    assertEquals(code, f.engine.snapshot().getString("lastError")); assertEquals(0, f.cancellations);
                    long delay = code.equals("-32029") ? 60000 : 5000;
                    assertEquals(TimeUnit.NANOSECONDS.toMillis(f.clock.get()) - 10 + delay, ((Number)engineField(f.engine, "retryAt")).longValue());
                    f.readFailures.clear(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(delay)); maintain(f.engine);
                    assertTrue(f.engine.snapshot().isNull("lastRpcError")); assertEquals("", f.engine.snapshot().getString("lastError"));
                    assertTrue(f.engine.snapshot().getBoolean("enabled")); assertEquals(1, f.prepared);
                } finally { release(f.engine, held); }
            }
        }
    }
    @Test public void transientFailureBeforeAnyCatalogRetriesWithoutClaimsAndRespectsBoundedHint() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.readFailures.put("getbountychanges", rpcFailure("RPC_TIMEOUT", "getbountychanges", 30000));
            f.start(); f.engine.tick(); assertEquals(0, f.captures); assertEquals(0, f.prepared); assertEquals(0, f.engine.snapshot().getInt("eligible"));
            long epoch = ((Number)engineField(f.engine, "generation")).longValue(); int reads = f.calls.size();
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(29)); f.engine.tick(); assertEquals(reads, f.calls.size());
            f.readFailures.clear(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); f.engine.tick();
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue()); assertEquals(1, f.captures); assertTrue(f.engine.snapshot().isNull("lastRpcError"));
        }
    }
    @Test public void staleCatalogStopsProofAdmissionWithoutChangingGenerationAndRecovers() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20); f.start(); f.engine.tick();
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); Object held = reserve(f.engine); assertNotNull(held);
            try {
                long epoch = ((Number)engineField(f.engine, "generation")).longValue();
                f.readFailures.put("getrecentblockhashes", rpcFailure("RPC_TIMEOUT", "getrecentblockhashes", 0));
                setEngineField(f.engine, "blockWindow", null);
                setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
                f.clock.addAndGet(TimeUnit.SECONDS.toNanos(60)); assertNull(reserve(f.engine));
                assertEquals(1, f.cancellations); assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
                assertEquals(1, f.engine.snapshot().getInt("eligible")); assertEquals("retrying", f.engine.snapshot().getString("status"));
                release(f.engine, held); f.readFailures.clear(); f.engine.tick();
                assertEquals(2, f.captures); assertEquals(1, f.prepared); assertEquals(0, f.broadcasts); assertTrue(f.engine.snapshot().isNull("lastRpcError"));
            } finally { release(f.engine, held); }
        }
    }
    @Test public void winnerCannotStartBroadcastAfterCatalogExpiresDuringAttachment() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.onAttach = () -> f.clock.addAndGet(TimeUnit.SECONDS.toNanos(60));
            f.start(); f.engine.tick(); assertEquals(1, f.attaches); assertEquals(0, f.broadcasts); assertTrue(f.receipts.isEmpty());
            assertEquals("The retained winner must not trigger another TLS attempt", 0, f.engine.snapshot().getInt("eligible"));
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
        }
    }
    @Test public void interruptedDiscoveryDoesNotPublishNewBlockIndexBeforeDeltaReplay() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); Object originalTip = engineField(f.engine, "tip");
            f.currentTip = tip().put("height", 1).put("hash", "34".repeat(32));
            f.readFailures.put("getbountychanges", rpcFailure("RPC_TIMEOUT", "getbountychanges", 0));
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertSame(originalTip, engineField(f.engine, "tip")); assertEquals(1, f.engine.snapshot().getInt("totalBlocks"));
            assertEquals(1, f.engine.snapshot().getInt("discoveredBlocks")); assertEquals(1, f.engine.snapshot().getInt("eligible"));
        }
    }
    @Test public void schemaAndWrongNetworkFailuresStillFailClosedAfterHealthyCatalog() throws Exception {
        for (boolean wrongNetwork : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick();
            if (wrongNetwork) f.currentTip.put("chain", "testnet4"); else f.currentTip.remove("height");
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertFalse(f.engine.snapshot().getBoolean("enabled")); assertEquals("error", f.engine.snapshot().getString("status"));
            assertEquals(wrongNetwork ? "CLAIMS_WRONG_NETWORK" : "CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
        }
    }
    @Test public void submissionDiagnosticIsNotAPersistentMaintenanceRetryAfterRecovery() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(rejected(-26)); f.start(); f.engine.tick();
            assertEquals("submission", f.engine.snapshot().getJSONObject("lastRpcError").getString("stage"));
            assertEquals("CLAIMS_REJECTED", f.engine.snapshot().getString("lastError"));
            maintain(f.engine);
            assertTrue(f.engine.snapshot().isNull("lastRpcError")); assertEquals("", f.engine.snapshot().getString("lastError"));
            assertEquals("waiting", f.engine.snapshot().getString("status")); assertEquals(1, f.broadcasts);
        }
    }
    @Test public void fundingTimeoutClearsWhenDiscoveryProvesItsOutpointNoLongerAvailable() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.readFailures.put("gettransaction", rpcFailure("RPC_TIMEOUT", "gettransaction", 0));
            f.start(); f.engine.tick(); assertEquals(0, f.captures);
            assertEquals("funding", f.engine.snapshot().getJSONObject("lastRpcError").getString("stage"));
            while (f.changes.size() <= f.changesCount) f.changes.add(new JSONArray());
            f.changes.set(f.changesCount, new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "spent").put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM)));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); maintain(f.engine);
            assertTrue(f.engine.snapshot().isNull("lastRpcError")); assertEquals("", f.engine.snapshot().getString("lastError"));
            assertEquals("waiting", f.engine.snapshot().getString("status")); assertEquals(0, f.captures);
        }
    }
    @Test public void replayAllowsTwoHundredProtectedRowsAndRejectsExcessWithoutPartialPublication() throws Exception {
        // One protected active capture plus 199 reservations is legal. An
        // impossible extra reservation must still fail closed transactionally.
        for (int reserveCount : List.of(199, 200)) try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); Object held = reserve(f.engine); assertNotNull(held);
            @SuppressWarnings("unchecked") Map<String, MobileClaimsEngine.Candidate.Progress> retained = (Map<String, MobileClaimsEngine.Candidate.Progress>)engineField(f.engine, "progress");
            @SuppressWarnings("unchecked") java.util.Set<String> reserved = (java.util.Set<String>)engineField(f.engine, "reservations");
            try {
                for (int index = 1; index <= reserveCount; index++) {
                    MobileClaimsEngine.Candidate old = candidate(bounty("example.com", TXID, index, MAX_TARGET, "10000000000"));
                    retained.put(old.key, old.progress); reserved.add(old.key);
                }
                String newBlock = "34".repeat(32), newTx = "56".repeat(32);
                Map<String, MobileClaimsEngine.Candidate> staged = new java.util.LinkedHashMap<>();
                for (int index = 0; index < 10000; index++) {
                    JSONObject row = bounty("example.com", newTx, index, MAX_TARGET, "10000000000").put("block_hash", newBlock).put("block_height", 1);
                    MobileClaimsEngine.Candidate candidate = new MobileClaimsEngine.Candidate(row, newBlock, 10, MobileClaimScheduler.FACTOR_SCALE); staged.put(candidate.key, candidate);
                }
                Object oldTip = engineField(f.engine, "tip"); String oldCursor = (String)engineField(f.engine, "cursor");
                java.lang.reflect.Method method = MobileClaimsEngine.class.getDeclaredMethod("replay", long.class, String.class, Map.class, Map.class, String.class); method.setAccessible(true);
                f.currentTip = tip().put("hash", newBlock).put("height", 1);
                if (reserveCount == 199) {
                    method.invoke(f.engine, ((Number)engineField(f.engine, "generation")).longValue(), null, staged, Map.of(newBlock, 1L), oldCursor);
                    assertEquals(10200, retained.size());
                    assertEquals(10000, ((Map<?, ?>)engineField(f.engine, "catalog")).size());
                    assertEquals(Map.of(newBlock, 1L), engineField(f.engine, "blocks"));
                    assertEquals(199, reserved.size());
                    assertTrue(f.engine.snapshot().getBoolean("enabled"));
                } else {
                    try { method.invoke(f.engine, ((Number)engineField(f.engine, "generation")).longValue(), null, staged, Map.of(newBlock, 1L), oldCursor); fail("Protected progress must stay bounded at 10200"); }
                    catch (java.lang.reflect.InvocationTargetException expected) { assertEquals("CLAIMS_CAPACITY", expected.getCause().getMessage()); }
                    assertSame(oldTip, engineField(f.engine, "tip")); assertEquals(oldCursor, engineField(f.engine, "cursor"));
                    assertEquals(1, f.engine.snapshot().getInt("eligible")); assertEquals(1, f.engine.snapshot().getInt("discoveredBlocks"));
                    assertEquals(Map.of(GENESIS, 0L), engineField(f.engine, "blocks")); assertEquals(201, retained.size());
                }
            } finally { reserved.clear(); release(f.engine, held); }
        }
    }
    @Test public void wrongNetworkAndBadFundingNeverReachProofOrBroadcast() throws Exception {
        try (Fixture f = new Fixture()) { f.currentTip.put("chain", "testnet4"); f.start(); f.engine.tick(); assertEquals("CLAIMS_WRONG_NETWORK", f.engine.snapshot().getString("lastError")); assertFalse(f.engine.snapshot().getBoolean("enabled")); assertEquals(0, f.captures); }
        try (Fixture f = new Fixture()) {
            f.badParent = true; f.start(); f.engine.tick(); assertEquals(0, f.captures); assertEquals(0, f.broadcasts);
            java.lang.reflect.Field cache = MobileClaimsEngine.class.getDeclaredField("parents"); cache.setAccessible(true);
            assertEquals(0, ((MobileClaimParentCache)cache.get(f.engine)).size());
        }
    }
    @Test public void successfulTargetPersistsBeforeBroadcastAndDoesNotRepeat() throws Exception {
        try (Fixture f = new Fixture()) { f.nativeResult = proof(true, true, 200); f.start(); f.engine.tick(); assertEquals(Arrays.asList("pending", "submitted"), f.receipts); assertEquals(1, f.broadcasts); assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.engine.snapshot().getLong("targetHits")); f.engine.tick(); assertEquals(1, f.broadcasts); }
    }
    @Test public void stopDuringVerificationPreventsTransmissionAndIsNeutral() throws Exception {
        try (Fixture f = new Fixture()) { f.nativeResult = proof(true, true, 200); f.onCapture = f.engine::stop; f.start(); f.engine.tick(); assertEquals(0, f.broadcasts); assertEquals(0, f.engine.snapshot().getLong("valid")); assertEquals(1, f.engine.snapshot().getLong("cancelled")); assertEquals(1, f.cancellations); assertEquals(1, f.destroys); }
        try (Fixture f = new Fixture()) { f.nativeResult = proof(true, true, 200); f.onAttach = f.engine::stop; f.start(); f.engine.tick(); assertEquals(0, f.broadcasts); assertTrue(f.receipts.isEmpty()); }
    }
    @Test public void unknownAndAlreadyKnownBlockRestartWithoutAutomaticRetry() throws Exception {
        for (Exception outcome : Arrays.asList(new IOException("offline unknown"), rejected(-27))) {
            try (Fixture f = new Fixture()) {
                f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(outcome); f.start(); f.engine.tick();
                assertEquals("unknown-outcome", f.engine.snapshot().getString("status")); assertEquals(1, f.engine.snapshot().getLong("unknown")); assertEquals(Arrays.asList("pending", "unknown"), f.receipts);
                try { f.engine.start("fixture-public-address"); fail(); } catch (IllegalStateException expected) { assertEquals("CLAIMS_UNKNOWN_OUTCOME", expected.getMessage()); }
                f.engine.tick(); assertEquals(1, f.broadcasts);
            }
        }
    }
    @Test public void explicitRejectionIsNotUnknownAndDoesNotRetryThatOutput() throws Exception {
        try (Fixture f = new Fixture()) { f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(rejected(-26)); f.start(); f.engine.tick(); assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(Arrays.asList("pending", "rejected"), f.receipts); f.engine.tick(); assertEquals(1, f.broadcasts); }
    }
    @Test public void provenUnsentTransientFailureRetriesIdenticalWinnerWithoutNewCaptureOrAttach() throws Exception {
        for (String code : List.of("RPC_UNAVAILABLE", "RPC_TIMEOUT", "RPC_BUSY", "-32029", "-32030")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure(code, 4500));
            f.start(); f.engine.tick();
            assertEquals(Arrays.asList("pending", "not-sent"), f.receipts);
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            assertEquals(1, ((Set<?>)engineField(f.engine, "reservations")).size());
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.broadcasts);
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(4499)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, f.captures);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, f.prepared); assertEquals(1, f.attaches); assertEquals(1, f.captures);
            assertEquals(Arrays.asList("pending", "not-sent", "pending", "submitted"), f.receipts);
            JSONObject state = f.engine.snapshot();
            assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("valid"));
            assertEquals(1, state.getLong("targetHits")); assertEquals(1, state.getLong("submitted")); assertEquals(0, state.getLong("unknown"));
            assertTrue(((Map<?, ?>)engineField(f.engine, "pendingWinners")).isEmpty());
        }
    }
    @Test public void repeatedUnsentFailureUsesBoundedBackoffAndDoesNotChangeProofCounters() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_UNAVAILABLE", 0));
            f.start(); f.engine.tick();
            for (long delay : new long[] { 1000, 2000, 4000, 8000, 16000, 30000, 30000 }) {
                int previous = f.broadcasts;
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(delay - 1)); f.engine.tick(); assertEquals(previous, f.broadcasts);
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1)); f.engine.tick(); assertEquals(previous + 1, f.broadcasts);
                assertEquals(1, f.attaches); assertEquals(1, f.captures); assertEquals(1, f.engine.snapshot().getLong("valid"));
            }
        }
    }
    @Test public void retainedWinnerWaitsForFreshCatalogWithoutAnotherProof() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_UNAVAILABLE", 0));
            f.start(); f.engine.tick();
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61));
            f.readFailures.put("getrecentblockhashes", rpcFailure("RPC_UNAVAILABLE", "getrecentblockhashes", 0));
            setEngineField(f.engine, "blockWindow", null);
            f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            f.readFailures.clear(); f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void winnerWhoseCatalogExpiresDuringAttachmentIsKeptBeforeFirstEnqueue() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200);
            f.onAttach = () -> f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61));
            f.start(); f.engine.tick();
            assertEquals(0, f.broadcasts); assertTrue(f.receipts.isEmpty());
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            f.onAttach = null; f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals(Arrays.asList("pending", "submitted"), f.receipts);
        }
    }
    @Test public void verifiedWinnerRetainsProofWhenCatalogExpiresAtCaptureCompletion() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200); f.onCapture = () -> f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61));
            f.start(); f.engine.tick();
            assertEquals(0, f.broadcasts); assertTrue(f.receipts.isEmpty());
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(1, f.engine.snapshot().getLong("targetHits"));
            f.onCapture = null; f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals(Arrays.asList("pending", "submitted"), f.receipts);
        }
    }
    @Test public void retryAfterLongerThanMinuteIsNotShortenedForRetainedWinner() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 120000));
            f.start(); f.engine.tick(); f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(119999)); f.engine.tick(); assertEquals(1, f.broadcasts);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.attaches);
        }
    }
    @Test public void unsentRetryBackoffDoesNotBlockOtherBountiesOrTheirCounters() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.rows.put(new JSONObject(bounty().toString()).put("vout", 1));
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_UNAVAILABLE", 30000));
            f.start(); f.engine.tick();
            f.nativeResult = proof(true, false, 200); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(20)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(2, f.captures); assertEquals(2, f.prepared);
            assertEquals(2, f.engine.snapshot().getLong("attempts")); assertEquals(2, f.engine.snapshot().getLong("valid"));
            assertEquals(1, f.engine.snapshot().getLong("targetHits"));
        }
    }
    @Test public void stoppingPausingOrInvalidatingRetainedWinnerCancelsOnlyItsRetry() throws Exception {
        for (String action : List.of("stop", "pause", "spent", "pending_spend", "window_exit")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_UNAVAILABLE", 0));
            f.start(); f.engine.tick();
            if (action.equals("stop")) f.engine.stop();
            else if (action.equals("pause")) f.engine.setAllowed(false);
            else {
                JSONObject event = new JSONObject().put("sequence", 1).put("type", action).put("txid", TXID).put("vout", 0);
                if (!action.equals("window_exit")) event.put("spending_txid", CLAIM);
                while (f.changes.size() < f.changesCount) f.changes.add(new JSONArray());
                f.changes.add(new JSONArray().put(event)); setEngineField(f.engine, "nextDiscovery", 0L);
            }
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            assertEquals(action, 1, f.broadcasts); assertEquals(action, 1, f.captures);
            assertTrue(action, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).isEmpty());
            assertTrue(action, ((Set<?>)engineField(f.engine, "reservations")).isEmpty());
            assertEquals(Arrays.asList("pending", "not-sent"), f.receipts);
        }
    }
    @Test public void missingUnsentEvidenceAndFailedDurableReceiptNeverAuthorizeRetry() throws Exception {
        for (String code : List.of("RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "RPC_CANCELLED")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(rpcFailure(code, "sendrawtransaction", 0));
            f.start(); f.engine.tick(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(60)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(Arrays.asList("pending", "unknown"), f.receipts);
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status"));
        }
        try (Fixture f = new Fixture(true)) {
            f.engine.setReceiptStore((txid, status) -> { if (status.equals("not-sent")) throw new IOException("failed durable unsent receipt"); f.receipts.add(status); });
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_UNAVAILABLE", 0));
            f.start(); f.engine.tick(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(60)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(Arrays.asList("pending", "unknown"), f.receipts);
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status"));
        }
    }
    @Test public void stopDuringBroadcastRetainsUnknownReceipt() throws Exception {
        try (Fixture f = new Fixture()) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = new CompletableFuture<>(); f.sent = new CountDownLatch(1); f.start();
            Thread worker = new Thread(f.engine::tick); worker.start(); assertTrue(f.sent.await(2, TimeUnit.SECONDS)); f.engine.stop(); worker.join(2000); assertFalse(worker.isAlive());
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status")); assertEquals(Arrays.asList("pending", "unknown"), f.receipts); assertEquals(1, f.broadcasts);
        }
    }
    @Test public void endpointChangeWaitsForStoppedTransmissionAndReceiptCompletion() throws Exception {
        try (Fixture f = new Fixture()) {
            assertTrue(f.engine.canChangeEndpoint());
            f.nativeResult = proof(true, true, 200);
            f.broadcastFuture = new CompletableFuture<>() {
                @Override public boolean cancel(boolean interrupt) { return false; }
            };
            f.sent = new CountDownLatch(1); f.start(); assertFalse(f.engine.canChangeEndpoint());
            Thread worker = new Thread(f.engine::tick); worker.start();
            try {
                assertTrue(f.sent.await(2, TimeUnit.SECONDS)); f.engine.stop();
                assertFalse(f.engine.canChangeEndpoint()); assertEquals(Arrays.asList("pending"), f.receipts);
                f.broadcastFuture.complete(new JSONObject().put("txid", CLAIM)); worker.join(2000);
                assertFalse(worker.isAlive()); assertTrue(f.engine.canChangeEndpoint());
                assertEquals(Arrays.asList("pending", "submitted"), f.receipts);
            } finally { f.broadcastFuture.complete(new JSONObject().put("txid", CLAIM)); worker.join(2000); }
        }
    }
    @Test public void endpointChangeWaitsForStoppedCaptureAndRetainsUnknownGuard() throws Exception {
        try (Fixture f = new Fixture()) {
            f.onCapture = () -> { f.engine.stop(); assertFalse(f.engine.canChangeEndpoint()); };
            f.start(); f.engine.tick(); assertTrue(f.engine.canChangeEndpoint());
            f.engine.restoreUnknownOutcome(CLAIM); f.engine.configureLimits(7, 9);
            assertTrue(f.engine.canChangeEndpoint()); assertEquals("unknown-outcome", f.engine.snapshot().getString("status"));
            assertEquals(7, f.engine.snapshot().getInt("connectionsPerSecondLimit")); assertEquals(9, f.engine.snapshot().getInt("concurrency"));
            assertThrows(IllegalStateException.class, () -> f.engine.start("fixture-public-address"));
        }
    }
    @Test public void receiptFailurePreventsBroadcastAndRestoreRequiresVerifiedResolution() throws Exception {
        try (Fixture f = new Fixture()) { f.failReceipt = true; f.nativeResult = proof(true, true, 200); f.start(); f.engine.tick(); assertEquals(0, f.broadcasts); assertFalse(f.engine.snapshot().getBoolean("enabled")); assertEquals("CLAIMS_RECEIPT_UNAVAILABLE", f.engine.snapshot().getString("lastError")); }
        try (Fixture f = new Fixture()) {
            f.engine.restoreUnknownOutcome(CLAIM);
            try { f.engine.start("fixture-public-address"); fail(); } catch (IllegalStateException expected) { assertEquals("CLAIMS_UNKNOWN_OUTCOME", expected.getMessage()); }
            try { f.engine.resolveConfirmedOutcome(TXID); fail(); } catch (IllegalArgumentException expected) { assertEquals("CLAIMS_RECEIPT_STATE", expected.getMessage()); }
            f.engine.resolveConfirmedOutcome(CLAIM); assertEquals(Arrays.asList("submitted"), f.receipts); assertFalse(f.engine.snapshot().getBoolean("enabled"));
            f.start(); assertTrue(f.engine.snapshot().getBoolean("enabled"));
        }
    }
    @Test public void lifecycleDoesNotCallSharedClientPolicyAndPausedMakesNoRequests() throws Exception {
        try (Fixture f = new Fixture()) {
            f.engine.start("fixture-public-address"); f.engine.tick(); assertTrue(f.calls.isEmpty()); assertEquals("paused", f.engine.snapshot().getString("status"));
            f.engine.setAllowed(true); f.engine.tick(); assertEquals(1, f.captures); f.engine.setAllowed(false); int calls = f.calls.size(); f.engine.tick(); assertEquals(calls, f.calls.size());
            f.engine.stop(); assertFalse(f.engine.snapshot().getBoolean("enabled"));
        }
    }
    @Test public void rawCapturesConsumeBudgetEvenWhenCertificateValidationFails() throws Exception {
        try (Fixture f = new Fixture()) {
            f.nativeResult = proof(false, false, 200).put("captured", true).put("errorCode", "CLAIM_CERTIFICATE"); f.start();
            for (int index = 0; index < 3; index++) { f.engine.tick(); Thread.sleep(15); }
            assertEquals(3, f.captures); assertEquals(0, f.engine.snapshot().getLong("valid")); assertEquals(3, f.engine.snapshot().getLong("invalid"));
            f.engine.tick(); assertEquals(3, f.captures); assertEquals(0, f.engine.snapshot().getInt("eligible"));
        }
    }
    @Test public void stopStartKeepsOutpointFactorBudgetAndPolicyHistory() throws Exception {
        try (Fixture f = new Fixture(true)) {
            java.lang.reflect.Field field = MobileClaimsEngine.class.getDeclaredField("progress"); field.setAccessible(true);
            Object original = null;
            for (int index = 0; index < 3; index++) {
                if (index != 0) f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
                f.changesCount = 0; f.start(); f.engine.tick();
                Object current = ((Map<?, ?>)field.get(f.engine)).get(TXID + ":0");
                if (original == null) original = current; else assertSame(original, current);
                f.engine.stop();
            }
            assertEquals(3, f.captures); assertEquals(1, f.prepared);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
            f.changesCount = 0; f.start(); f.engine.tick();
            assertEquals(3, f.captures); assertEquals(3, f.engine.snapshot().getJSONArray("domains").getJSONObject(0).getLong("completed"));
            assertEquals(7, f.engine.snapshot().getJSONArray("domains").getJSONObject(0).getInt("signatureAlgorithmsMask"));
        }
    }
    @Test public void validatedCapturePastDeadlineRemainsASuccessfulObservationWithoutBroadcast() throws Exception {
        try (Fixture f = new Fixture()) {
            f.nativeResult = proof(false, false, 10001).put("captured", true).put("validationPassed", true).put("errorCode", "CLAIM_TIMEOUT");
            f.start(); f.engine.tick();
            assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(0, f.engine.snapshot().getLong("invalid")); assertEquals(0, f.broadcasts);
            assertEquals(1, f.engine.snapshot().getJSONArray("domains").getJSONObject(0).getLong("connections"));
        }
    }
    @Test public void inconsistentNativeCaptureValidationFlagsFailClosed() throws Exception {
        for (JSONObject result : List.of(proof(true, false, 200).put("captured", false), proof(true, false, 200).put("validationPassed", false))) {
            try (Fixture f = new Fixture()) {
                f.nativeResult = result; f.start(); f.engine.tick();
                assertFalse(f.engine.snapshot().getBoolean("enabled")); assertEquals("CLAIMS_NATIVE_DATA", f.engine.snapshot().getString("lastError"));
                assertEquals(0, f.broadcasts); assertEquals(0, f.engine.snapshot().getLong("valid"));
            }
        }
    }
    @Test public void elapsedCaptureWorkAlreadyConsumesThePacingInterval() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.onCapture = () -> f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
            f.start(); f.engine.tick(); f.engine.tick();
            assertEquals("The 10ms of work leaves no additional 10ms sleep", 2, f.captures);
            assertEquals(2, f.engine.snapshot().getLong("attempts"));
        }
    }
    @Test public void fastWorkWaitsOnlyTheRemainderAndRateChangeCannotCatchUpInABurst() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.onCapture = () -> f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(7));
            f.start(); f.engine.tick(); f.engine.tick(); assertEquals(1, f.captures);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(3)); f.engine.tick(); assertEquals(2, f.captures);
            f.engine.configureLimits(1, 100);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(999)); f.engine.tick(); assertEquals(2, f.captures);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1)); f.engine.tick(); assertEquals(3, f.captures);
        }
    }
    @Test public void timerOversleepDoesNotAccumulateIntoRepeatedTwelveAndAHalfMillisecondIntervals() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20); f.start();
            long first = f.clock.get(); f.engine.tick();
            for (int slot = 1; slot <= 100; slot++) {
                f.clock.set(first + TimeUnit.MILLISECONDS.toNanos(slot * 10L) + TimeUnit.MICROSECONDS.toNanos(2500));
                f.engine.tick(); assertEquals("Each timer wake stays on the original cadence", slot + 1, f.captures);
                f.engine.tick(); assertEquals("A 2.5ms late wake does not earn another slot", slot + 1, f.captures);
            }
            assertEquals(101, f.engine.snapshot().getLong("attempts"));
        }
    }
    @Test public void continuousDemandCatchesUpAcrossFifteenPointSixTwoFiveMillisecondTimerWakes() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20); f.start(); long first = f.clock.get(); f.engine.tick();
            long quantum = TimeUnit.MICROSECONDS.toNanos(15625);
            for (int wake = 1; wake <= 64; wake++) {
                f.clock.set(first + wake * quantum);
                for (int pulse = 0; pulse < 3; pulse++) f.engine.tick();
                assertEquals("Coarse timer wakes retain the complete admission phase", 1 + wake * quantum / TimeUnit.MILLISECONDS.toNanos(10), f.captures);
            }
            assertEquals(101, f.captures);
        }
    }
    @Test public void configuredIntervalsAndFutureDeadlinesSurviveRateChangesAndRestarts() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20); f.start();
            for (int rate : new int[]{1, 7, 10, 50, 100, 7, 1}) {
                f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); f.engine.configureLimits(rate, 100);
                long interval = (TimeUnit.SECONDS.toNanos(1) + rate - 1) / rate;
                int before = f.captures;
                f.clock.addAndGet(interval - 1); f.engine.tick(); assertEquals("The configured rate deadline must not admit early", before, f.captures);
                f.clock.incrementAndGet(); f.engine.tick(); f.engine.tick(); assertEquals(before + 1, f.captures);
                assertEquals(f.clock.get() + interval, ((Number)engineField(f.engine, "nextAttemptNanos")).longValue());
                f.engine.stop(); f.changesCount = 0; f.start(); f.engine.tick(); assertEquals(before + 1, f.captures);
                f.clock.addAndGet(interval - 1); f.engine.tick(); assertEquals("Restart retains a future configured deadline", before + 1, f.captures);
                f.clock.incrementAndGet(); f.engine.tick(); f.engine.tick(); assertEquals(before + 2, f.captures);
            }
        }
    }
    @Test public void oneSecondDebtBoundaryIsAppliedAfterAdvancingTheConfiguredInterval() throws Exception {
        long second = TimeUnit.SECONDS.toNanos(1);
        for (int rate : new int[]{1, 7, 10, 50, 100}) {
            long interval = (second + rate - 1) / rate;
            for (long beyondBoundary : new long[]{0, interval - 1, interval, interval + 1, 5 * second}) {
                try (Fixture f = new Fixture(true)) {
                    f.nativeResult = proof(false, false, 20); f.start(); f.engine.configureLimits(rate, 100);
                    f.clock.addAndGet(interval); f.engine.tick();
                    long previousDeadline = ((Number)engineField(f.engine, "nextAttemptNanos")).longValue();
                    f.clock.set(previousDeadline + second + beyondBoundary); f.engine.tick();
                    long expected = beyondBoundary <= interval ? previousDeadline + interval : f.clock.get() - second;
                    assertEquals("Advance must precede the one-second clamp at rate " + rate, expected, ((Number)engineField(f.engine, "nextAttemptNanos")).longValue());
                    assertEquals(2, f.captures);
                    int beforeCatchUp = f.captures;
                    for (int pulse = 0; pulse <= rate + 2; pulse++) f.engine.tick();
                    assertTrue("Long stalls cannot retain more than one second of admission debt", f.captures - beforeCatchUp <= rate + 1);
                    assertTrue(((Number)engineField(f.engine, "nextAttemptNanos")).longValue() > f.clock.get());
                }
            }
        }
    }
    @Test public void debtClampUsesFreshTimeAfterAdmissionWorkAtEveryConfiguredRate() throws Exception {
        long second = TimeUnit.SECONDS.toNanos(1);
        for (int rate : new int[]{1, 7, 10, 50, 100}) {
            try (Fixture f = new Fixture(true)) {
                f.nativeResult = proof(false, false, 20); f.start(); f.engine.configureLimits(rate, 100);
                long interval = (second + rate - 1) / rate;
                f.clock.addAndGet(interval); f.engine.tick();
                f.clock.set(((Number)engineField(f.engine, "nextAttemptNanos")).longValue());
                f.onCreate = () -> f.clock.addAndGet(3 * second);
                f.engine.tick(); f.onCreate = null;
                assertEquals("Selection/handle work must not leave more than one second of debt", f.clock.get() - second, ((Number)engineField(f.engine, "nextAttemptNanos")).longValue());
                assertEquals(2, f.captures);
            }
        }
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20); f.start(); f.engine.configureLimits(7, 100);
            long interval = (second + 6) / 7; f.clock.addAndGet(interval);
            f.onCreate = () -> f.clock.addAndGet(3 * second); f.engine.tick(); f.onCreate = null;
            assertEquals("Fresh idle admission starts its phase after setup work", f.clock.get() + interval, ((Number)engineField(f.engine, "nextAttemptNanos")).longValue());
            f.engine.tick(); assertEquals(1, f.captures);
        }
    }
    @Test public void fullCapacityKeepsTheAdmissionPhaseAndCatchUpRemainsBoundedByConcurrency() throws Exception {
        try (Fixture f = new Fixture(true)) {
            List<Object> pending = new ArrayList<>();
            try {
                f.nativeResult = proof(false, false, 20); f.start(); f.engine.tick(); f.engine.configureLimits(100, 5);
                for (int slot = 0; slot < 5; slot++) {
                    f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); Object capture = reserve(f.engine); assertNotNull(capture); pending.add(capture);
                }
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(100)); assertNull(reserve(f.engine));
                for (Object capture : pending) release(f.engine, capture); pending.clear();
                for (int slot = 0; slot < 5; slot++) {
                    Object capture = reserve(f.engine); assertNotNull("Capacity waits must not discard overdue admission slots", capture); pending.add(capture);
                }
                assertNull("Catch-up cannot exceed the configured parallel capacity", reserve(f.engine));
                assertEquals(5, f.engine.snapshot().getInt("activeConnections"));
            } finally { for (Object capture : pending) release(f.engine, capture); }
        }
    }
    @Test public void noEligibleWorkPauseAndNewRunDoNotBankIdleAdmissionTime() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20); f.start(); f.engine.tick();
            @SuppressWarnings("unchecked") Map<String, MobileClaimsEngine.Candidate> catalog = (Map<String, MobileClaimsEngine.Candidate>)engineField(f.engine, "catalog");
            Map<String, MobileClaimsEngine.Candidate> saved = new HashMap<>(catalog); catalog.clear(); setEngineField(f.engine, "scheduleDirty", true);
            f.clock.addAndGet(TimeUnit.MINUTES.toNanos(1)); f.engine.tick(); assertEquals(1, f.captures);
            f.clock.addAndGet(TimeUnit.MINUTES.toNanos(1)); catalog.putAll(saved); setEngineField(f.engine, "scheduleDirty", true);
            f.engine.tick(); f.engine.tick(); assertEquals("Returning work gets one fresh slot after an idle period", 2, f.captures);
            f.engine.setAllowed(false); f.clock.addAndGet(TimeUnit.MINUTES.toNanos(1)); f.engine.setAllowed(true);
            f.engine.tick(); f.engine.tick(); assertEquals("Pause must reset phase even without a paused dispatch poll", 3, f.captures);
            f.engine.stop(); f.changesCount = 0; f.clock.addAndGet(TimeUnit.MINUTES.toNanos(1));
            int before = f.captures; f.start(); f.engine.tick(); f.engine.tick();
            assertEquals("A new run does not inherit idle admission credit", before + 1, f.captures);
        }
    }
    @Test public void lifecycleResetsPreserveFutureRateDeadlinesAndCancelBeforeResettingNativePhase() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20);
            f.onCapture = () -> { f.limiterEvents.clear(); f.engine.setAllowed(false); assertEquals(Arrays.asList("cancel", "reset"), f.limiterEvents); };
            f.start(); f.engine.tick(); assertEquals(1, f.engine.snapshot().getLong("attempts"));
            f.onCapture = null; f.engine.configureLimits(1, 100); f.engine.setAllowed(true); f.engine.tick(); assertEquals(1, f.captures);
            f.engine.stop(); f.changesCount = 0; f.start(); f.engine.tick(); assertEquals(1, f.captures);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(999)); f.engine.tick(); assertEquals(1, f.captures);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1)); f.engine.tick(); assertEquals(2, f.captures);
        }
    }
    @Test public void configuringRateDiscardsOverdueAdmissionDebt() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20); f.start(); f.engine.tick();
            f.clock.addAndGet(TimeUnit.MINUTES.toNanos(1)); f.engine.configureLimits(20, 100);
            f.engine.tick(); assertEquals(1, f.captures);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(50) - 1); f.engine.tick(); assertEquals(1, f.captures);
            f.clock.incrementAndGet(); f.engine.tick(); f.engine.tick(); assertEquals(2, f.captures);
        }
    }
    @Test public void fullCapacityPollsAtMostFiftyTimesPerSecondAndSnapshotCanForceAnAcknowledgement() throws Exception {
        try (Fixture f = new Fixture(true)) {
            List<Object> pending = new ArrayList<>();
            try {
                f.nativeResult = proof(false, false, 20); f.start(); f.engine.tick();
                for (int slot = 0; slot < 100; slot++) {
                    f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
                    Object capture = reserve(f.engine); assertNotNull(capture); pending.add(capture);
                }
                assertEquals(100, f.engine.snapshot().getInt("activeConnections")); f.acknowledgementPolls = 0;
                for (int poll = 0; poll < 500; poll++) {
                    f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(2)); assertNull(reserve(f.engine));
                }
                assertEquals("100 pending handles need at most 5,000 JNI reads/s", 5000, f.acknowledgementPolls);
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1));
                f.startedTimes.put(handle(pending.get(0)), f.clock.get());
                assertNull(reserve(f.engine)); assertEquals(5000, f.acknowledgementPolls);
                assertEquals("An explicit snapshot can discover a start before the next background scan", 2, f.engine.snapshot().getLong("attempts"));
                assertEquals(5100, f.acknowledgementPolls);
            } finally { for (Object capture : pending) release(f.engine, capture); }
            assertEquals(101, f.destroys);
        }
    }
    @Test public void finalReleaseReadsAnUnpolledStartOnceAndKeepsItsActualTimestamp() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20); f.start(); f.engine.tick();
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); Object capture = reserve(f.engine); assertNotNull(capture);
            try {
                assertEquals(1, f.engine.snapshot().getLong("attempts")); f.acknowledgementPolls = 0;
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1)); long startedAt = f.clock.get();
                f.startedTimes.put(handle(capture), startedAt);
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(8));
                release(f.engine, capture); release(f.engine, capture);
                assertEquals("Destruction always reads the timestamp even inside the 20ms scan interval", 1, f.acknowledgementPolls);
                assertEquals(2, f.engine.snapshot().getLong("attempts"));
                f.clock.set(startedAt + TimeUnit.SECONDS.toNanos(10) - 1);
                assertEquals(0.1, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
                f.clock.incrementAndGet(); assertEquals(0, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
            } finally { release(f.engine, capture); }
            assertEquals(2, f.destroys);
        }
    }
    @Test public void actualStartRateExpiresOnPauseStopAndIsEmptyInANewRun() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); assertEquals(0.1, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
            f.engine.setAllowed(false); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(10));
            assertEquals(0, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
            f.engine.setAllowed(true); f.engine.tick();
            assertEquals(0.1, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
            f.engine.stop(); assertEquals(0.1, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(10)); assertEquals(0, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
            f.changesCount = 0; f.start(); assertEquals(0, f.engine.snapshot().getLong("attempts"));
            assertEquals(0, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
        }
    }
    @Test public void latePollingDoesNotMoveAnOldTcpStartIntoTheCurrentWindow() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.onCapture = () -> f.clock.addAndGet(TimeUnit.SECONDS.toNanos(11));
            f.start(); f.engine.tick();
            assertEquals(1, f.engine.snapshot().getLong("attempts"));
            assertEquals(0, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
        }
    }
    @Test public void lateCancelledStartIsCountedForTheSameRunButCannotContaminateARestart() throws Exception {
        for (boolean restart : new boolean[]{false, true}) {
            try (Fixture f = new Fixture(true)) {
                f.hideAcknowledgements = true;
                f.onCapture = () -> {
                    f.engine.stop();
                    if (restart) { f.changesCount = 0; f.start(); }
                    f.hideAcknowledgements = false;
                };
                f.start(); f.engine.tick();
                assertEquals(restart ? 0 : 1, f.engine.snapshot().getLong("attempts"));
                assertEquals(restart ? 0 : 0.1, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
                assertEquals(restart ? 0 : 1, f.engine.snapshot().getLong("cancelled"));
                assertEquals(0, f.engine.snapshot().getLong("valid")); assertEquals(0, f.broadcasts);
                assertEquals(1, f.destroys);
            }
        }
    }
    @Test public void healthyProofsCanWaitAtTheReportedCountsWithNineEligibleRowsAndRecoverOnSchedule() throws Exception {
        // Synthetic parameters place the learned return just below its floor
        // at each reported count. This reproduces the UI state, not the user's
        // unknown on-chain amounts/targets or measured handshake durations.
        for (long[] scenario : new long[][]{{949, 68586034}, {2147, 68748756}}) {
            try (Fixture f = new Fixture(true)) {
                f.rows = new JSONArray();
                for (int vout = 0; vout < 9; vout++) f.rows.put(bounty("example.com", TXID, vout, "0000" + repeat("ff", 30), Long.toString(scenario[1] + 10)));
                f.nativeResult = proof(true, false, 1051);
                f.onCapture = () -> f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
                f.start();
                for (int pulse = 0; pulse < scenario[0] + 5; pulse++) f.engine.tick();
                JSONObject waiting = f.engine.snapshot();
                assertEquals(scenario[0], waiting.getLong("attempts"));
                assertEquals(scenario[0], waiting.getLong("valid"));
                assertEquals(0, waiting.getLong("invalid")); assertEquals(0, waiting.getLong("targetHits"));
                assertTrue(waiting.getBoolean("allowed")); assertTrue(waiting.getBoolean("enabled"));
                assertEquals("waiting", waiting.getString("status")); assertEquals("", waiting.getString("lastError"));
                assertEquals(9, waiting.getInt("eligible")); assertEquals(0, waiting.getInt("activeConnections"));
                f.clock.addAndGet(TimeUnit.SECONDS.toNanos(10)); f.engine.tick();
                assertEquals(0, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
                assertEquals(scenario[0], f.engine.snapshot().getLong("attempts"));
                f.clock.addAndGet(TimeUnit.SECONDS.toNanos(50)); f.engine.tick();
                assertEquals("The per-policy recovery probe still runs after 60 seconds", scenario[0] + 1, f.engine.snapshot().getLong("attempts"));
                f.engine.tick(); assertEquals("waiting", f.engine.snapshot().getString("status"));
            }
        }
    }
    @Test public void exhaustedCaptureBudgetCanLeaveNineListedOutputsThatNeverMeetTheReturnFloor() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.rows = new JSONArray().put(bounty());
            for (int vout = 1; vout <= 9; vout++) f.rows.put(bounty("example.com", TXID, vout, MAX_TARGET, "100"));
            f.onCapture = () -> f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
            f.start(); for (int pulse = 0; pulse < 10; pulse++) f.engine.tick();
            assertEquals(3, f.engine.snapshot().getLong("attempts"));
            assertEquals(9, f.engine.snapshot().getInt("eligible"));
            assertEquals("waiting", f.engine.snapshot().getString("status"));
            assertEquals("", f.engine.snapshot().getString("lastError"));
            f.clock.addAndGet(TimeUnit.MINUTES.toNanos(5)); f.engine.tick();
            assertEquals("Outputs below even the optimistic return floor do not receive recovery probes", 3, f.engine.snapshot().getLong("attempts"));
        }
    }
    @Test public void localPreTcpFailureAllowsTheSamePolicyAtTheNextConfiguredPacingSlot() throws Exception {
        for (String code : new String[]{"CLAIM_TIMEOUT", "CLAIM_BUSY", "CLAIM_CONTEXT"}) {
            try (Fixture f = new Fixture(true)) {
                f.nativeFailure = new IllegalStateException(code); f.start(); f.engine.tick();
                assertEquals(0, f.engine.snapshot().getLong("attempts")); assertEquals(0, f.engine.snapshot().getLong("invalid"));
                f.nativeFailure = null; f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(9)); f.engine.tick();
                assertEquals(1, f.captures);
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1)); f.engine.tick();
                assertEquals("No policy cooldown beyond the configured 10ms admission interval", 2, f.captures);
                assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
                assertEquals(0, f.engine.snapshot().getLong("invalid")); assertEquals("", f.engine.snapshot().getString("lastError"));
            }
        }
    }
}
