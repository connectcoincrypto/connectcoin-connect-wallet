package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto;
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
    private static MobileRpcClient.RpcFailure notForwarded(String code, long retryAfterMs) throws Exception {
        try { MobileRpcClient.reply(new JSONObject().put("jsonrpc", "2.0").put("id", "fixture").put("error", new JSONObject().put("code", Integer.parseInt(code))
            .put("data", new JSONObject().put("retry_after_ms", retryAfterMs))), "fixture"); }
        catch (MobileRpcClient.RpcFailure error) { return error; }
        throw new AssertionError();
    }
    private interface Action { void run() throws Exception; }
    private static final class Fixture implements AutoCloseable, MobileClaimsEngine.RpcAccess, MobileClaimsEngine.ProofAccess, MobileClaimsEngine.Transactions {
        final List<String> calls = new ArrayList<>(), receipts = new ArrayList<>(), limiterEvents = new ArrayList<>(), broadcastHexes = new ArrayList<>();
        final List<JSONArray> changes = new ArrayList<>();
        final List<Integer> windowCounts = new ArrayList<>();
        final List<String> blockReads = new ArrayList<>();
        final List<String> journalCursors = new ArrayList<>();
        final List<JSONObject> requestParams = new ArrayList<>();
        final List<String> boundBudgets = new ArrayList<>();
        final Map<String, JSONArray> blockRows = new HashMap<>();
        final Map<String, JSONArray> changesByCursor = new HashMap<>();
        final Map<String, JSONObject> journalReplies = new HashMap<>();
        final AtomicLong clock = new AtomicLong(TimeUnit.SECONDS.toNanos(100));
        final Map<Long, Long> startedTimes = new ConcurrentHashMap<>();
        final Set<Long> capturedHandles = ConcurrentHashMap.newKeySet();
        final MobileClaimsEngine engine;
        JSONArray rows = new JSONArray().put(bounty());
        JSONObject nativeResult = proof(true, false, 200), currentTip = tip();
        JSONObject receiptResponse;
        String alternateObservedHex;
        Exception receiptFailure;
        int receiptLookups;
        JSONObject recentOverride;
        int changesCount, captures, prepared, attaches, broadcasts, destroys, cancellations, acknowledgementPolls;
        boolean incomplete, badParent, failReceipt, fakeTime, hideAcknowledgements, limiterDestroyed;
        boolean repeatCursor, startsAllowed = true, queuedBroadcast, capturedBeforeFailure;
        boolean modern, rejectEnriched, rejectRaw;
        long rpcEpoch;
        long handleSerial = 6;
        Exception nativeFailure;
        final Map<String, Exception> readFailures = new HashMap<>();
        Action onCapture, onAttach, onTip, onWindow, onStream, onPrepare;
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
        public long connectionEpoch() { return rpcEpoch; }
        public CompletableFuture<JSONObject> call(String method, JSONObject params) {
            calls.add(method);
            requestParams.add(params);
            if (readFailures.containsKey(method)) return failed(readFailures.get(method));
            try {
                if (rejectEnriched && method.equals("getbountychanges") && params.has("include_bounties")) {
                    if (rpcEpoch == 0) rpcEpoch++;
                    return failed(rpcFailure("-32602", method, 0));
                }
                if (rejectRaw && method.equals("gettransaction") && params.has("raw_only")) return failed(rpcFailure("-32602", method, 0));
            } catch (Exception error) { return failed(error); }
            try { switch (method) {
                case "getchaintip": if (onTip != null) onTip.run(); return CompletableFuture.completedFuture(currentTip);
                case "getbountychanges": {
                    int page = changesCount++;
                    if (page == 0) assertFalse(params.has("cursor")); else assertTrue(params.has("cursor"));
                    journalCursors.add(params.optString("cursor", ""));
                    JSONObject scripted = journalReplies.get(params.optString("cursor", ""));
                    if (scripted != null) return CompletableFuture.completedFuture(scripted);
                    if (modern && params.has("known_state")) return CompletableFuture.completedFuture(new JSONObject().put("compact", 3).put("unchanged", true));
                    if (modern) return CompletableFuture.completedFuture(new JSONObject().put("compact", 3).put("tip", currentTip).put("next_cursor", "cursor" + page));
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
                    JSONObject manifest = new JSONObject().put("tip", currentTip).put("window", 600).put("blocks", recent);
                    if (modern) {
                        manifest.put("bounty_counts", 1);
                        for (int i = 0; i < recent.length(); i++) recent.getJSONObject(i).put("bounty_count", rows.length());
                    }
                    return CompletableFuture.completedFuture(manifest);
                }
                case "gettransactionstatus":
                    if (!modern) return failed(rpcFailure("-32601", method, 0)); // Legacy fixture.
                    receiptLookups++;
                    if (receiptFailure != null) return failed(receiptFailure);
                    return CompletableFuture.completedFuture(receiptResponse == null ? new JSONObject().put("tip", currentTip).put("txid", CLAIM).put("status", "pending").put("confirmations", 0) : receiptResponse);
                case "gettransaction":
                    if (CLAIM.equals(params.optString("txid"))) {
                        receiptLookups++;
                        if (receiptFailure != null) return failed(receiptFailure);
                        return CompletableFuture.completedFuture(receiptResponse == null ? new JSONObject().put("tip", currentTip).put("status", "pending")
                            .put("transaction", new JSONObject().put("hex", "complete-fixture").put("txid", CLAIM)) : receiptResponse);
                    }
                    return CompletableFuture.completedFuture(new JSONObject().put("tip", currentTip).put("transaction", new JSONObject().put("hex", badParent ? "bad" : "parent-fixture")));
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
        public CompletableFuture<JSONObject> broadcast(String hex) { calls.add("broadcast"); broadcasts++; broadcastHexes.add(hex); assertEquals("complete-fixture", hex); if (sent != null) sent.countDown(); return broadcastFuture; }
        public boolean cancelBeforeWrite(CompletableFuture<JSONObject> operation) {
            if (!queuedBroadcast || operation != broadcastFuture || operation.isDone()) return false;
            try { return operation.completeExceptionally(unsentFailure("RPC_CANCELLED", 0)); } catch (Exception impossible) { throw new AssertionError(impossible); }
        }
        public long createStartLimiter(int rate) { return 1; }
        public void setStartRate(long limiter, int rate) { assertEquals(1, limiter); }
        public void setStartAllowed(long limiter, boolean allowed) { assertEquals(1, limiter); startsAllowed = allowed; }
        public void bindBudget(long handle, String key, String target, String captured) { assertEquals(0L, startedTimes.get(handle).longValue()); boundBudgets.add(key + "/" + target + "/" + captured); }
        public void resetStartSchedule(long limiter) { assertEquals(1, limiter); assertFalse("Resetting a destroyed limiter", limiterDestroyed); limiterEvents.add("reset"); }
        public void destroyStartLimiter(long limiter) { assertEquals(1, limiter); assertFalse(limiterDestroyed); limiterDestroyed = true; }
        public long create(long limiter) { assertEquals(1, limiter); long handle = ++handleSerial; startedTimes.put(handle, 0L); if (onCreate != null) onCreate.run(); return handle; }
        public long startedAtNanos(long handle) { acknowledgementPolls++; assertTrue(startedTimes.containsKey(handle)); return hideAcknowledgements ? 0 : startedTimes.get(handle); }
        public boolean hasCaptured(long handle) { assertTrue(startedTimes.containsKey(handle)); return capturedHandles.contains(handle); }
        public void cancel(long handle) { assertTrue(startedTimes.containsKey(handle)); limiterEvents.add("cancel"); cancellations++; }
        public void destroy(long handle) { assertNotNull("Destroyed handle twice", startedTimes.remove(handle)); capturedHandles.remove(handle); destroys++; }
        public JSONObject capture(JSONObject context, long handle) throws Exception {
            captures++; assertTrue(startedTimes.containsKey(handle)); startedTimes.put(handle, nativeFailure == null ? (fakeTime ? clock.get() : System.nanoTime()) : 0); assertEquals(7, context.getInt("mask")); assertEquals("challenge", context.getString("challenge"));
            if (nativeFailure == null ? nativeResult.optBoolean("captured") : capturedBeforeFailure) capturedHandles.add(handle);
            if (onCapture != null) onCapture.run(); if (nativeFailure != null) throw nativeFailure; return nativeResult;
        }
        public void validateReward(String address) { if (!"fixture-public-address".equals(address)) throw new IllegalArgumentException("invalid fixture address"); }
        public long fee() { return 10; }
        public JSONObject prepare(JSONObject value, String parent, String reward) throws Exception { prepared++; if (!parent.equals("parent-fixture")) throw new IllegalArgumentException("bad raw parent"); if (onPrepare != null) onPrepare.run(); return new JSONObject().put("challenge", "challenge"); }
        public JSONObject attach(JSONObject prepared, String proof) throws Exception { attaches++; if (onAttach != null) onAttach.run(); return new JSONObject().put("txid", CLAIM).put("hex", "complete-fixture"); }
        public void validateObserved(String raw, String expectedTxid, String originalHex, String target) {
            if (modern) calls.add("validateObserved");
            if (!CLAIM.equals(expectedTxid) || originalHex != null && !originalHex.equals("complete-fixture")
                    || !("complete-fixture".equals(raw) || alternateObservedHex != null && alternateObservedHex.equals(raw))) throw new IllegalArgumentException("CLAIMS_RPC_DATA");
        }
        public void close() { engine.close(); }
    }

    private static String journalBacklog(Fixture f, int count, int pageSize) throws Exception {
        String cursor = (String)engineField(f.engine, "cursor");
        for (int offset = 0; offset < count; offset += pageSize) {
            int end = Math.min(count, offset + pageSize);
            JSONArray changes = new JSONArray();
            for (int index = offset; index < end; index++) changes.put(new JSONObject().put("sequence", index + 1)
                .put("type", index + 1 == count ? "spent" : "pending_spend").put("txid", TXID).put("vout", 1).put("spending_txid", CLAIM));
            String following = "backlog" + end;
            f.journalReplies.put(cursor, new JSONObject().put("tip", f.currentTip).put("changes", changes)
                .put("next_cursor", following).put("has_more", end < count));
            cursor = following;
        }
        return cursor;
    }
    private static Fixture modernEmpty() throws Exception {
        Fixture f = new Fixture(true); f.modern = true; f.rows = new JSONArray(); f.start(); maintain(f.engine); return f;
    }
    private static JSONObject modernRow(int output) throws Exception {
        return bounty("example.com", TXID, output, MAX_TARGET, "10000000000").put("block_height", 1)
            .put("block_hash", MobileClaimBlockWindowTest.canonical(1)).put("spending_txid", JSONObject.NULL);
    }
    private static JSONObject added(int sequence, JSONObject row) throws Exception {
        return new JSONObject().put("type", "added").put("sequence", sequence).put("tip_ref", -1).put("bounty", row);
    }
    private static JSONObject advanceModern(Fixture f, int count, JSONArray events) throws Exception {
        f.recentOverride = MobileClaimBlockWindowTest.window(1, 0, 0).put("bounty_counts", 1);
        f.currentTip = f.recentOverride.getJSONObject("tip");
        f.recentOverride.getJSONArray("blocks").getJSONObject(0).put("bounty_count", count);
        f.recentOverride.getJSONArray("blocks").getJSONObject(1).put("bounty_count", 0);
        JSONObject page = new JSONObject().put("compact", 3).put("tip", new JSONArray().put(1).put(f.currentTip.getString("hash")).put(f.currentTip.get("mediantime")))
            .put("block_delta", new JSONArray().put(new JSONArray().put(JSONObject.NULL).put(count))).put("changes", events).put("next_cursor", "modern1");
        f.journalReplies.put((String)engineField(f.engine, "cursor"), page); setEngineField(f.engine, "nextDiscovery", 0L); return page;
    }
    @Test public void countedEmptyGenesisAndNewBlockNeedNoStreamsOrDuplicateFenceQueries() throws Exception {
        try (Fixture f = modernEmpty()) {
            assertTrue(f.blockReads.isEmpty()); assertEquals(List.of(600), f.windowCounts);
            assertEquals(2, f.changesCount); assertFalse(f.calls.contains("getchaintip"));
            int reads = f.changesCount;
            advanceModern(f, 0, new JSONArray()); maintain(f.engine);
            assertEquals(reads + 1, f.changesCount); assertEquals(List.of(600), f.windowCounts); assertTrue(f.blockReads.isEmpty());
            assertEquals(2, ((Set<?>)engineField(f.engine, "loaded")).size());
        }
    }
    @Test public void completeFeedBlockUsesAllUniqueRowsWithoutStreamOrSecondPoll() throws Exception {
        try (Fixture f = modernEmpty()) {
            int reads = f.changesCount;
            advanceModern(f, 2, new JSONArray().put(added(1, modernRow(0))).put(added(2, modernRow(1)))); maintain(f.engine);
            assertEquals(reads + 1, f.changesCount); assertTrue(f.blockReads.isEmpty()); assertEquals(List.of(600), f.windowCounts);
            assertEquals(2, ((Map<?, ?>)engineField(f.engine, "catalog")).size());
            assertTrue(((Map<?, ?>)engineField(f.engine, "feedCandidates")).isEmpty());
            assertTrue(f.requestParams.stream().anyMatch(p -> Boolean.TRUE.equals(p.opt("raw_only"))));
        }
    }
    @Test public void mixedLegacyStateChangesRequireAStreamBeforeInlineAdmission() throws Exception {
        try (Fixture f = modernEmpty()) {
            advanceModern(f, 1, new JSONArray().put(added(1, modernRow(0)))).put("has_more", true);
            JSONObject spent = new JSONObject().put("sequence", 2).put("type", "spent").put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM);
            f.journalReplies.put("modern1", new JSONObject().put("tip", f.currentTip).put("next_cursor", "legacy2").put("has_more", false).put("changes", new JSONArray().put(spent)));
            setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            assertTrue(((Map<?, ?>)engineField(f.engine, "catalog")).isEmpty());
            @SuppressWarnings("unchecked") Map<String, Map<String, MobileClaimsEngine.Candidate>> pending = (Map<String, Map<String, MobileClaimsEngine.Candidate>>)engineField(f.engine, "feedCandidates");
            Map<String, MobileClaimsEngine.Candidate> rows = pending.get(f.currentTip.getString("hash"));
            assertEquals("spent", rows.get(TXID + ":0").state); assertEquals(CLAIM, rows.get(TXID + ":0").spendingTxid);
            assertEquals(0, f.prepared); assertTrue(f.blockReads.isEmpty()); assertTrue(f.calls.contains("getchaintip"));
            assertTrue(((Set<?>)engineField(f.engine, "feedNeedsStream")).contains(f.currentTip.getString("hash")));
        }
    }
    @Test public void partialFeedCandidatesSurviveCursorCommitAndCheckLaterStreamMembership() throws Exception {
        for (boolean omit : new boolean[]{false, true}) try (Fixture f = modernEmpty()) {
            JSONObject first = modernRow(0).put("status", "spent").put("spending_txid", CLAIM);
            advanceModern(f, 2, new JSONArray().put(added(1, first))); setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            assertEquals("modern1", engineField(f.engine, "cursor")); assertEquals(0, ((Map<?, ?>)engineField(f.engine, "catalog")).size());
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "feedCandidates")).size());
            f.blockRows.put(f.currentTip.getString("hash"), new JSONArray().put(modernRow(omit ? 2 : 0)).put(modernRow(1)));
            setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine);
            if (omit) {
                assertFalse((Boolean)engineField(f.engine, "healthy")); assertEquals(0, f.prepared);
            } else {
                assertEquals(2, ((Map<?, ?>)engineField(f.engine, "catalog")).size());
                assertTrue(((Map<?, ?>)engineField(f.engine, "feedCandidates")).isEmpty());
            }
            assertEquals(0, f.captures); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void unknownLegacyAdditionCannotPromoteOtherwiseCountCompleteInlineRows() throws Exception {
        try (Fixture f = modernEmpty()) {
            advanceModern(f, 1, new JSONArray().put(added(1, modernRow(0)))).put("has_more", true);
            JSONObject unknown = new JSONObject().put("sequence", 2).put("type", "added").put("txid", TXID).put("vout", 1)
                .put("block_hash", f.currentTip.getString("hash")).put("block_height", 1);
            f.journalReplies.put("modern1", new JSONObject().put("tip", f.currentTip).put("next_cursor", "legacy2").put("has_more", false).put("changes", new JSONArray().put(unknown)));
            setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            assertTrue(((Map<?, ?>)engineField(f.engine, "catalog")).isEmpty());
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "feedCandidates")).size());
            assertTrue(((Set<?>)engineField(f.engine, "feedNeedsStream")).contains(f.currentTip.getString("hash")));
            assertFalse(((Set<?>)engineField(f.engine, "loaded")).contains(f.currentTip.getString("hash")));
        }
    }
    @Test public void loadedBlockCannotAcceptContradictoryAuthoritativeCardinality() throws Exception {
        try (Fixture f = modernEmpty()) {
            advanceModern(f, 1, new JSONArray().put(added(1, modernRow(0)))); maintain(f.engine);
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "catalog")).size());
            // Model a previously legacy-loaded cache receiving its first count.
            f.recentOverride.getJSONArray("blocks").getJSONObject(0).put("bounty_count", 2);
            setEngineField(f.engine, "blockWindow", MobileClaimBlockWindowTest.cache(f.recentOverride));
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertFalse((Boolean)engineField(f.engine, "healthy")); assertEquals(0, f.captures);
        }
    }
    @Test public void orphanedHistoricalPublicationCannotPublishStateOrAdvanceCursor() throws Exception {
        try (Fixture f = modernEmpty()) {
            advanceModern(f, 1, new JSONArray().put(added(1, modernRow(0)))); maintain(f.engine);
            String before = (String)engineField(f.engine, "cursor");
            JSONObject state = modernRow(0).put("status", "spent").put("spending_txid", CLAIM);
            JSONObject orphan = new JSONObject(f.currentTip.toString()).put("hash", repeat("ee", 32));
            JSONObject nextTip = new JSONObject(f.currentTip.toString()).put("height", 2).put("hash", repeat("dd", 32));
            JSONObject e = new JSONObject().put("sequence", 2).put("type", "spent").put("txid", TXID).put("vout", 0).put("tip_ref", 0)
                .put("bounty_ref", MobileBountyCodec.immutableDigest(state)).put("bounty_delta", new JSONObject().put("status", "spent").put("spending_txid", CLAIM));
            f.journalReplies.put(before, new JSONObject().put("compact", 3).put("tip", new JSONArray().put(2).put(nextTip.getString("hash")).put(nextTip.get("mediantime")))
                .put("block_delta", new JSONArray().put(new JSONArray().put(JSONObject.NULL).put(0))).put("next_cursor", "orphan2").put("tips", new JSONArray().put(orphan)).put("changes", new JSONArray().put(e)));
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(before, engineField(f.engine, "cursor")); assertFalse((Boolean)engineField(f.engine, "healthy")); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void compactPendingReceiptValidatesOwnedBytesBeforeStatusAndRetainsProof() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); f.nativeResult = proof(true, true, 200); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, ((Map<?, ?>)engineField(f.engine, "savedWinners")).size());
            f.modern = true; f.rpcEpoch++; f.calls.clear(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31));
            // Keep the previously validated legacy feed while exercising receipts.
            f.journalReplies.put((String)engineField(f.engine, "cursor"), new JSONObject().put("tip", f.currentTip).put("next_cursor", "receiptfence").put("has_more", false).put("changes", new JSONArray()));
            maintain(f.engine);
            assertTrue(f.calls.toString(), f.calls.indexOf("validateObserved") < f.calls.indexOf("gettransactionstatus")); assertTrue(f.calls.toString(), f.calls.contains("gettransactionstatus"));
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "savedWinners")).size()); assertEquals(1, f.broadcasts); assertEquals(1, f.captures);
            assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void firstSocketCompatibilityIsRememberedAndOnlyNewSocketReprobes() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.rejectEnriched = true; f.start(); maintain(f.engine);
            long probes = f.requestParams.stream().filter(p -> p.has("include_bounties")).count();
            assertEquals(4, probes); assertEquals(1L, engineField(f.engine, "capabilityEpoch"));
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(probes, f.requestParams.stream().filter(p -> p.has("include_bounties")).count());
            f.rpcEpoch++; setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertTrue(f.requestParams.stream().filter(p -> p.has("include_bounties")).count() > probes);
        }
    }
    @Test public void rawFundingFallbackRequiresExplicitParameterRejection() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.rejectRaw = true; f.start(); maintain(f.engine);
            assertEquals(1, f.prepared); assertFalse((Boolean)engineField(f.engine, "rawFunding"));
            assertEquals(1, f.requestParams.stream().filter(p -> p.has("raw_only")).count());
        }
        try (Fixture f = new Fixture(true)) {
            f.readFailures.put("gettransaction", rpcFailure("RPC_TIMEOUT", "gettransaction", 0)); f.start(); maintain(f.engine);
            assertEquals(0, f.prepared); assertTrue((Boolean)engineField(f.engine, "rawFunding"));
            assertEquals(1, f.requestParams.stream().filter(p -> p.has("raw_only")).count());
        }
    }
    private static void warmFunding(MobileClaimsEngine engine) throws Exception {
        JSONObject output = new JSONObject().put("type", 2).put("amount", "10000000000").put("domain", "example.com").put("target", MAX_TARGET).put("rootVersion", 1).put("mask", 7);
        JSONObject input = new JSONObject().put("txid", repeat("00", 32)).put("vout", 0).put("scriptSig", "").put("sequence", 0xffffffffL).put("witness", new JSONArray());
        JSONObject tx = new JSONObject().put("version", 2).put("locktime", 0).put("inputs", new JSONArray().put(input)).put("outputs", new JSONArray().put(output));
        String raw = WalletCrypto.hex(NativeTransactions.serialize(tx, true)), id = NativeTransactions.txid(tx);
        NativeTransactions.FundingTransactionCache cache = (NativeTransactions.FundingTransactionCache)engineField(engine, "fundingValidation");
        cache.verifyFunding(new JSONObject().put("txid", id).put("vout", 0).put("amount", "10000000000").put("rawTransaction", raw), null);
        ((MobileClaimParentCache)engineField(engine, "parents")).putValidated(id, raw);
        assertEquals(1, cache.size());
    }
    private static void assertFundingEmpty(MobileClaimsEngine engine) throws Exception {
        NativeTransactions.FundingTransactionCache cache = (NativeTransactions.FundingTransactionCache)engineField(engine, "fundingValidation");
        assertEquals(0, cache.size()); assertEquals(0, cache.retainedBytes());
        MobileClaimParentCache raw = (MobileClaimParentCache)engineField(engine, "parents");
        assertEquals(0, raw.size()); assertEquals(0, raw.characters());
    }
    @Test public void fundingCachesFollowLifecycleAndCancelledPrepareNeverRepopulates() throws Exception {
        try (Fixture f = new Fixture()) {
            warmFunding(f.engine); f.start(); assertFundingEmpty(f.engine);
            warmFunding(f.engine); f.engine.setAllowed(false); assertFundingEmpty(f.engine);
            f.engine.setAllowed(true); warmFunding(f.engine); f.engine.stop(); assertFundingEmpty(f.engine);
        }
        try (Fixture f = new Fixture()) {
            f.start(); warmFunding(f.engine); f.onPrepare = f.engine::stop; f.engine.tick();
            assertEquals(1, f.prepared); assertEquals(0, f.captures); assertFundingEmpty(f.engine);
        }
    }
    private static void resetForResync(Fixture f) throws Exception {
        java.lang.reflect.Method reset = MobileClaimsEngine.class.getDeclaredMethod("resetCatalog", boolean.class); reset.setAccessible(true); reset.invoke(f.engine, true);
        f.changesCount = 0; setEngineField(f.engine, "nextDiscovery", 0L); setEngineField(f.engine, "nextBlock", 0L);
    }
    private static void adoptWindow(Fixture f, int height, int replaced) throws Exception {
        f.recentOverride = MobileClaimBlockWindowTest.window(height, replaced, 7); f.currentTip = f.recentOverride.getJSONObject("tip");
        setEngineField(f.engine, "nextDiscovery", 0L);
    }
    private static void primeOldest(Fixture f) throws Exception { primeOldest(f, 599); }
    private static void primeOldest(Fixture f, int height) throws Exception {
        String oldest = MobileClaimBlockWindowTest.canonical(height - 599);
        for (int index = 0; index < f.rows.length(); index++) f.rows.getJSONObject(index).put("block_hash", oldest).put("block_height", height - 599);
        adoptWindow(f, height, 0); f.blockRows.put(oldest, f.rows); f.start(); maintain(f.engine);
        @SuppressWarnings("unchecked") Set<String> loaded = (Set<String>)engineField(f.engine, "loaded");
        @SuppressWarnings("unchecked") Map<String, Long> blocks = (Map<String, Long>)engineField(f.engine, "blocks");
        loaded.addAll(blocks.keySet()); loaded.remove(oldest); setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine);
    }
    @Test public void budgetBindingIsRunScopedExactAndNativeExhaustionIsNeutral() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
            f.nativeFailure = new IllegalStateException("CLAIM_BUDGET"); f.engine.tick();
            assertEquals(List.of("1:" + TXID + ":0/" + MAX_TARGET + "/0", "1:" + TXID + ":0/" + MAX_TARGET + "/1"), f.boundBudgets);
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.engine.snapshot().getLong("invalid")); assertEquals(0, f.engine.snapshot().getLong("cancelled"));
            @SuppressWarnings("unchecked") Map<String, MobileClaimsEngine.Candidate.Progress> progress = (Map<String, MobileClaimsEngine.Candidate.Progress>)engineField(f.engine, "progress");
            assertEquals(BigInteger.ONE, progress.get(TXID + ":0").captures); assertTrue(progress.get(TXID + ":0").budgetExhausted);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); f.engine.tick(); assertEquals(2, f.captures);
        }
        try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); f.engine.stop(); f.changesCount = 0;
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); f.start(); f.engine.tick();
            assertTrue(f.boundBudgets.get(1).startsWith("2:"));
        }
    }
    @Test public void startedCaptureSurvivesResyncButCannotSendUntilProtectedBlockReloads() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200);
            f.onCapture = () -> { resetForResync(f); assertFalse(f.startsAllowed); assertEquals(0, f.cancellations); };
            f.start(); long epoch = ((Number)engineField(f.engine, "generation")).longValue(); f.engine.tick();
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue()); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.broadcasts); assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            f.onCapture = null; setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            assertFalse("Hash snapshot alone cannot authorize the old row", f.startsAllowed); assertEquals(0, f.broadcasts);
            setEngineField(f.engine, "nextBlock", 0L); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            assertTrue(f.startsAllowed); assertEquals(1, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.prepared); assertEquals(1, f.attaches);
            assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void drainedResyncCaptureRemovesBlockBarrierButStillRequiresACoherentSnapshot() throws Exception {
        for (boolean snapshotBeforeDrain : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            primeOldest(f); int oldReads = f.blockReads.size();
            f.nativeResult = proof(true, false, 200);
            f.onCapture = () -> {
                resetForResync(f); setEngineField(f.engine, "nextBlock", Long.MAX_VALUE);
                assertTrue((Boolean)engineField(f.engine, "resyncSnapshotPending"));
                assertFalse(f.startsAllowed);
                if (snapshotBeforeDrain) {
                    maintain(f.engine);
                    assertTrue((Boolean)engineField(f.engine, "healthy"));
                    assertFalse((Boolean)engineField(f.engine, "resyncSnapshotPending"));
                    assertFalse("The still-active retained capture requires its block", f.startsAllowed);
                }
            };
            f.engine.tick(); f.onCapture = null;
            assertTrue(((Map<?, ?>)engineField(f.engine, "retained")).isEmpty());
            assertTrue(((Set<?>)engineField(f.engine, "resyncBlocks")).isEmpty());
            assertEquals(snapshotBeforeDrain, f.startsAllowed);
            if (!snapshotBeforeDrain) {
                f.readFailures.put("getchaintip", rpcFailure("RPC_TIMEOUT", "getchaintip", 0));
                maintain(f.engine);
                assertFalse("A failed fence cannot reopen an empty resync barrier", f.startsAllowed);
                assertTrue((Boolean)engineField(f.engine, "resyncSnapshotPending"));
                f.readFailures.clear(); f.changesCount = 0; f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); maintain(f.engine);
                assertTrue(f.startsAllowed);
            }
            assertFalse((Boolean)engineField(f.engine, "catalogGate"));
            assertEquals("No obsolete protected-block stream is needed", oldReads, f.blockReads.size());
            assertEquals(1, f.engine.snapshot().getLong("attempts"));
            assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.engine.snapshot().getLong("cancelled"));
            assertEquals(0, f.broadcasts);
        }
    }
    @Test public void automaticPauseCancellationsStayInTheirRunEvenAcrossSeveralEpochs() throws Exception {
        for (boolean resumeBeforeDrain : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            f.onCapture = () -> {
                f.engine.setAllowed(false);
                if (resumeBeforeDrain) {
                    f.engine.setAllowed(true); f.engine.setAllowed(false); f.engine.setAllowed(true);
                }
            };
            f.start(); f.engine.tick();
            JSONObject state = f.engine.snapshot();
            assertTrue(state.getBoolean("enabled")); assertEquals(resumeBeforeDrain, state.getBoolean("allowed"));
            assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("cancelled"));
            assertEquals(0, state.getLong("valid")); assertEquals(0, state.getLong("invalid")); assertEquals(0, state.getLong("activeConnections"));
            assertEquals(0, f.broadcasts);
        }
        try (Fixture f = new Fixture(true)) {
            f.onCapture = () -> { f.engine.stop(); f.changesCount = 0; f.start(); };
            f.start(); f.engine.tick(); f.onCapture = null;
            JSONObject state = f.engine.snapshot();
            assertEquals(0, state.getLong("attempts")); assertEquals(0, state.getLong("cancelled"));
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick();
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.engine.snapshot().getLong("cancelled"));
        }
    }
    @Test public void automaticPauseDuringNativeSetupFailureCountsCancellationOnlyInItsOwnRun() throws Exception {
        for (String code : List.of("CLAIM_CANCELLED", "CLAIM_DNS", "CLAIM_BUDGET", "CLAIM_CONTEXT", "CLAIM_TIMEOUT", "CLAIM_BUSY", "CLAIM_LOCAL_UNAVAILABLE")) {
            for (boolean newRun : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
                f.nativeFailure = new IllegalStateException(code);
                f.onCapture = () -> {
                    f.engine.setAllowed(false);
                    if (newRun) { f.engine.stop(); f.changesCount = 0; f.start(); }
                };
                f.start(); f.engine.tick();
                JSONObject state = f.engine.snapshot();
                assertEquals(code, newRun ? 0 : 1, state.getLong("cancelled"));
                assertEquals(code, 0, state.getLong("attempts")); assertEquals(code, 0, state.getLong("valid"));
                assertEquals(code, 0, state.getLong("invalid")); assertEquals(code, 0, state.getLong("activeConnections"));
                assertEquals(code, 0, f.broadcasts); assertTrue(state.getBoolean("enabled"));
                if (newRun) {
                    f.onCapture = null; f.nativeFailure = null; f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick();
                    assertEquals(code, 1, f.engine.snapshot().getLong("valid")); assertEquals(code, 0, f.engine.snapshot().getLong("cancelled"));
                }
            }
        }
    }
    @Test public void pauseWhileReadingNativeResultCountsCancellationBeforeAnyOutcome() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = new JSONObject(proof(true, true, 200).toString()) {
                @Override public boolean getBoolean(String key) throws org.json.JSONException {
                    if (key.equals("validProof")) f.engine.setAllowed(false);
                    return super.getBoolean(key);
                }
            };
            f.start(); f.engine.tick(); JSONObject state = f.engine.snapshot();
            assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("cancelled"));
            assertEquals(0, state.getLong("valid")); assertEquals(0, state.getLong("invalid"));
            assertEquals(0, state.getLong("targetHits")); assertEquals(0, state.getLong("activeConnections")); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void pauseAfterCountingNativeOutcomeDoesNotAlsoCountCancellation() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = new JSONObject(proof(true, true, 200).toString()) {
                @Override public String getString(String key) throws org.json.JSONException {
                    if (key.equals("proof")) f.engine.setAllowed(false);
                    return super.getString(key);
                }
            };
            f.start(); f.engine.tick(); JSONObject state = f.engine.snapshot();
            assertEquals(1, state.getLong("attempts")); assertEquals(0, state.getLong("cancelled"));
            assertEquals(1, state.getLong("valid")); assertEquals(0, state.getLong("invalid"));
            assertEquals(1, state.getLong("targetHits")); assertEquals(0, state.getLong("activeConnections")); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void drainingLastProtectedCaptureCannotReopenNativeAdmissionInsideAnotherReplay() throws Exception {
        try (Fixture f = new Fixture(true)) {
            primeOldest(f); Object held = reserve(f.engine); assertNotNull(held);
            f.startedTimes.put(handle(held), f.clock.get()); f.engine.snapshot();
            resetForResync(f); setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            assertFalse((Boolean)engineField(f.engine, "resyncSnapshotPending")); assertFalse(f.startsAllowed);
            setEngineField(f.engine, "nextDiscovery", 0L);
            f.onTip = () -> {
                assertTrue((Boolean)engineField(f.engine, "replayPending"));
                release(f.engine, held);
                assertTrue(((Set<?>)engineField(f.engine, "resyncBlocks")).isEmpty());
                assertTrue("Logical capture and broadcast admission stays gated too", (Boolean)engineField(f.engine, "catalogGate"));
                assertNull(reserve(f.engine));
                assertFalse("The in-progress snapshot still owns native admission", f.startsAllowed);
            };
            maintain(f.engine); f.onTip = null;
            assertTrue(f.startsAllowed); assertFalse((Boolean)engineField(f.engine, "catalogGate"));
            assertFalse((Boolean)engineField(f.engine, "replayPending"));
        }
    }
    @Test public void explicitGatewayNonForwardingRetainsWinnerAndRetriesItsExactTransaction() throws Exception {
        for (String code : List.of("-32001", "-32029", "-32030")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(notForwarded(code, 6000));
            f.start(); long epoch = ((Number)engineField(f.engine, "generation")).longValue(); f.engine.tick();
            assertEquals(code, List.of("pending", "not-sent"), f.receipts);
            assertEquals(code, 0, f.engine.snapshot().getLong("unknown")); assertTrue(f.engine.snapshot().getBoolean("enabled"));
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); f.engine.tick(); assertEquals(code, 1, f.broadcasts);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); f.engine.tick(); assertEquals(code, 2, f.broadcasts);
            assertEquals(code, List.of("pending", "not-sent", "pending", "submitted"), f.receipts);
            assertEquals(1, f.captures); assertEquals(1, f.prepared); assertEquals(1, f.attaches);
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("targetHits"));
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void resyncCancelsOnlyUndialedHandlesAndHeldRowsHaveAHardBound() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(false, false, 20); f.start(); f.engine.tick(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
            Object queued = reserve(f.engine); assertNotNull(queued);
            try { resetForResync(f); assertEquals(1, f.cancellations); assertFalse(f.startsAllowed); assertEquals(1, f.engine.snapshot().getLong("attempts")); }
            finally { release(f.engine, queued); }
            java.lang.reflect.Method retain = MobileClaimsEngine.class.getDeclaredMethod("retain", MobileClaimsEngine.Candidate.class); retain.setAccessible(true);
            for (int vout = 0; vout < 200; vout++) retain.invoke(f.engine, candidate(bounty("example.com", TXID, vout, MAX_TARGET, "10000000000")));
            java.lang.reflect.InvocationTargetException error = assertThrows(java.lang.reflect.InvocationTargetException.class,
                () -> retain.invoke(f.engine, candidate(bounty("example.com", TXID, 200, MAX_TARGET, "10000000000"))));
            assertEquals("CLAIMS_CAPACITY", error.getCause().getMessage()); assertEquals(200, ((Map<?, ?>)engineField(f.engine, "retained")).size());
        }
    }
    @Test public void lateBudgetResultCannotRemoveSameOutpointFromANewRun() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeFailure = new IllegalStateException("CLAIM_BUDGET");
            f.onCapture = () -> { f.engine.stop(); f.changesCount = 0; f.start(); maintain(f.engine); };
            f.start(); f.engine.tick(); f.onCapture = null; f.nativeFailure = null;
            assertTrue(f.engine.snapshot().getBoolean("enabled")); assertEquals(1, f.engine.snapshot().getInt("eligible"));
            assertEquals(0, f.engine.snapshot().getLong("attempts")); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick();
            assertEquals(1, f.engine.snapshot().getLong("valid"));
        }
    }
    @Test public void resyncNeverRevivesOriginalAvailableRowOfAlreadyInvalidatedWinner() throws Exception {
        for (boolean alreadyHeld : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 0)); f.start(); f.engine.tick();
            @SuppressWarnings("unchecked") Map<String, MobileClaimsEngine.Candidate> catalog = (Map<String, MobileClaimsEngine.Candidate>)engineField(f.engine, "catalog");
            if (alreadyHeld) {
                java.lang.reflect.Method retain = MobileClaimsEngine.class.getDeclaredMethod("retain", MobileClaimsEngine.Candidate.class); retain.setAccessible(true);
                retain.invoke(f.engine, catalog.get(TXID + ":0").copy());
            }
            // Model the committed spend preceding the queued callback/retry drain.
            catalog.get(TXID + ":0").state = "spent"; resetForResync(f);
            @SuppressWarnings("unchecked") Map<String, Object> retained = (Map<String, Object>)engineField(f.engine, "retained");
            if (!retained.isEmpty()) {
                java.lang.reflect.Field heldRow = retained.values().iterator().next().getClass().getDeclaredField("row"); heldRow.setAccessible(true);
                assertEquals("spent", ((MobileClaimsEngine.Candidate)heldRow.get(retained.values().iterator().next())).state);
            }
            assertFalse(f.engine.snapshot().has("awaitingAvailability")); assertEquals(1, f.broadcasts);
        }
    }
    @Test public void normalAgingSendsStartedProofDirectlyWithoutReentryOldRpcPollingOrRecapture() throws Exception {
        try (Fixture f = new Fixture(true)) {
            primeOldest(f); f.nativeResult = proof(true, true, 200);
            f.onCapture = () -> { adoptWindow(f, 600, 0); maintain(f.engine); };
            f.engine.tick(); f.onCapture = null;
            assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(0, f.cancellations); assertEquals(1, f.broadcasts);
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
            assertFalse(f.engine.snapshot().has("awaitingAvailability"));
            int oldestReads = java.util.Collections.frequency(f.blockReads, GENESIS);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61)); f.engine.tick();
            assertEquals(oldestReads, java.util.Collections.frequency(f.blockReads, GENESIS)); assertEquals(1, f.broadcasts); assertEquals(1, f.captures);
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.prepared);
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("targetHits"));
            assertFalse(((Map<?, ?>)engineField(f.engine, "catalog")).containsKey(TXID + ":0"));
        }
    }
    @Test public void agedWinnerIsDiscardedByConfirmedSpendButPreservedAcrossPauseOrPendingSpend() throws Exception {
        for (String action : List.of("spent", "pending_spend", "stop", "pause")) try (Fixture f = new Fixture(true)) {
            primeOldest(f); f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 30000)); f.engine.tick();
            adoptWindow(f, 600, 0); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "retained")).size()); assertEquals(1, f.broadcasts);
            if (action.equals("stop")) f.engine.stop(); else if (action.equals("pause")) f.engine.setAllowed(false);
            else {
                f.changesByCursor.put((String)engineField(f.engine, "cursor"), new JSONArray().put(new JSONObject().put("sequence", 1).put("type", action).put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM)));
                setEngineField(f.engine, "nextDiscovery", 0L);
            }
            f.engine.tick(); assertEquals(action, 1, f.broadcasts);
            assertTrue(action, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).isEmpty());
            f.engine.tick(); // The saved owner is reconciled after its queued callback drains.
            boolean retained = !action.equals("spent");
            assertEquals(action, retained ? 1 : 0, ((Map<?, ?>)engineField(f.engine, "retained")).size());
            assertEquals(action, retained ? 1 : 0, ((Map<?, ?>)engineField(f.engine, "savedWinners")).size());
        }
    }
    @Test public void normalAgingKeepsQuotaWaitAndTransmitsSameProofWithoutCancellation() throws Exception {
        try (Fixture f = new Fixture(true)) {
            primeOldest(f); f.nativeResult = proof(true, true, 200); f.queuedBroadcast = true; f.broadcastFuture = new CompletableFuture<>(); f.sent = new CountDownLatch(1);
            Thread submitter = new Thread(f.engine::tick); submitter.start();
            try {
                assertTrue(f.sent.await(2, TimeUnit.SECONDS)); adoptWindow(f, 600, 0); maintain(f.engine);
                assertFalse("Aging cannot cancel an unwritten quota job", f.broadcastFuture.isDone());
                assertEquals(List.of("pending"), f.receipts);
                f.broadcastFuture.complete(new JSONObject().put("txid", CLAIM));
                submitter.join(2000); assertFalse(submitter.isAlive());
                assertEquals(List.of("pending", "submitted"), f.receipts);
                assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(1, f.broadcasts); assertEquals(1, f.attaches);
                assertEquals(1, f.captures); assertEquals(1, f.engine.snapshot().getLong("submitted"));
                assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            } finally { f.engine.stop(); submitter.join(2000); }
        }
    }
    @Test public void agedWinnerRetriesOnlyProvenUnsentUsingExactlyTheSameProofAndTransaction() throws Exception {
        try (Fixture f = new Fixture(true)) {
            primeOldest(f); f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 30000));
            f.onCapture = () -> { adoptWindow(f, 600, 0); maintain(f.engine); }; f.engine.tick(); f.onCapture = null;
            assertEquals(List.of("pending", "not-sent"), f.receipts); assertEquals(1, f.broadcasts);
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(29)); f.engine.tick(); assertEquals(1, f.broadcasts);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); f.engine.tick(); assertEquals(2, f.broadcasts);
            assertEquals(List.of("pending", "not-sent", "pending", "submitted"), f.receipts);
            assertEquals(1, f.prepared); assertEquals(1, f.attaches); assertEquals(1, f.captures);
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(1, f.engine.snapshot().getLong("targetHits"));
            assertFalse(((Map<?, ?>)engineField(f.engine, "catalog")).containsKey(TXID + ":0"));
        }
    }
    @Test public void agedWinnerUnknownTransmissionStillStopsWithoutAutomaticRetry() throws Exception {
        try (Fixture f = new Fixture(true)) {
            primeOldest(f); f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(new IOException("unknown send result"));
            f.onCapture = () -> { adoptWindow(f, 600, 0); maintain(f.engine); }; f.engine.tick(); f.onCapture = null;
            assertEquals(List.of("pending", "unknown"), f.receipts); assertEquals("unknown-outcome", f.engine.snapshot().getString("status"));
            f.clock.addAndGet(TimeUnit.MINUTES.toNanos(5)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, f.captures); assertFalse(f.engine.snapshot().getBoolean("enabled"));
        }
    }
    @Test public void agedWinnerCannotBypassResyncOrFailedSnapshotAndResumesWithoutCatalogReentry() throws Exception {
        try (Fixture f = new Fixture(true)) {
            primeOldest(f); f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 0));
            f.onCapture = () -> { adoptWindow(f, 600, 0); maintain(f.engine); }; f.engine.tick(); f.onCapture = null;
            resetForResync(f); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2));
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.readFailures.put("getbountychanges", rpcFailure("RPC_TIMEOUT", "getbountychanges", 0)); f.engine.tick();
            assertFalse(f.startsAllowed); assertEquals(1, f.broadcasts); assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            f.readFailures.clear(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, f.engine.snapshot().getLong("submitted"));
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.prepared);
            assertFalse(((Map<?, ?>)engineField(f.engine, "catalog")).containsKey(TXID + ":0"));
        }
    }
    @Test public void knownSpendInvalidatesAgedCaptureBeforeItsFirstSubmission() throws Exception {
        for (String reason : List.of("spent", "pending_spend")) try (Fixture f = new Fixture(true)) {
            primeOldest(f); f.nativeResult = proof(true, true, 200);
            f.onCapture = () -> {
                adoptWindow(f, 600, 0); maintain(f.engine);
                f.changesByCursor.put((String)engineField(f.engine, "cursor"), new JSONArray().put(new JSONObject().put("sequence", 1).put("type", reason).put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM))); setEngineField(f.engine, "nextDiscovery", 0L);
                maintain(f.engine);
            };
            f.engine.tick(); assertEquals(reason, 0, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.cancellations);
            assertEquals(0, f.engine.snapshot().getLong("valid")); assertEquals(0, f.engine.snapshot().getLong("targetHits"));
        }
    }

    @Test public void rolloverOrMissingWindowOverlapPreservesOnlyAdmittedWorkAcrossResync() throws Exception {
        for (int height : new int[]{601, 1201}) for (boolean reset : new boolean[]{false, true}) for (boolean pendingWinner : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            primeOldest(f, 600); f.nativeResult = proof(true, true, 200);
            String oldest = MobileClaimBlockWindowTest.canonical(1);
            if (pendingWinner) {
                f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 1000)); f.engine.tick();
                if (reset) resetForResync(f);
                adoptWindow(f, height, 0); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2));
                f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.engine.tick();
                assertEquals(2, f.broadcasts);
            } else {
                f.onCapture = () -> { if (reset) resetForResync(f); adoptWindow(f, height, 0); maintain(f.engine); };
                f.engine.tick(); f.onCapture = null; assertEquals(1, f.broadcasts);
            }
            assertEquals(0, f.cancellations); assertEquals(1, f.captures); assertEquals(1, f.prepared); assertEquals(1, f.attaches);
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(1, f.engine.snapshot().getLong("submitted"));
            assertEquals(1, java.util.Collections.frequency(f.blockReads, oldest));
            assertFalse(((Map<?, ?>)engineField(f.engine, "catalog")).containsKey(TXID + ":0"));
        }
    }

    @Test public void explicitCanonicalConflictStillRevokesStartedCaptureOrPendingWinner() throws Exception {
        for (boolean pendingWinner : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            primeOldest(f, 600); f.nativeResult = proof(true, true, 200);
            if (pendingWinner) {
                f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 30000)); f.engine.tick();
                adoptWindow(f, 600, 600); f.engine.tick(); assertEquals(1, f.broadcasts);
                assertTrue(((Map<?, ?>)engineField(f.engine, "pendingWinners")).isEmpty());
            } else {
                f.onCapture = () -> { adoptWindow(f, 600, 600); maintain(f.engine); };
                f.engine.tick(); assertEquals(0, f.broadcasts); assertEquals(1, f.cancellations);
            }
            assertEquals(1, f.captures); assertEquals(0, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void reminedOutpointInvalidatesOldProofButValidatesImmutableOutputsBeforePreparingAgain() throws Exception {
        for (boolean changedOutput : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            primeOldest(f); f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 30000)); f.engine.tick();
            MobileClaimsEngine.Candidate.Progress originalProgress = (MobileClaimsEngine.Candidate.Progress)((Map<?, ?>)engineField(f.engine, "progress")).get(TXID + ":0");
            adoptWindow(f, 600, 0); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            String replacement = MobileClaimBlockWindowTest.canonical(600);
            JSONObject row = bounty().put("block_hash", replacement).put("block_height", 600);
            if (changedOutput) row.put("domain", "other.example");
            f.blockRows.put(replacement, new JSONArray().put(row));
            f.changesByCursor.put((String)engineField(f.engine, "cursor"), new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "added").put("txid", TXID).put("vout", 0).put("block_hash", replacement).put("block_height", 600)));
            setEngineField(f.engine, "nextDiscovery", 0L); setEngineField(f.engine, "nextBlock", 0L); f.nativeResult = proof(false, false, 20); f.engine.tick();
            assertEquals(1, f.broadcasts); assertTrue(((Map<?, ?>)engineField(f.engine, "pendingWinners")).isEmpty());
            assertEquals(!changedOutput, f.engine.snapshot().getBoolean("enabled"));
            if (changedOutput) assertEquals("CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
            else {
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick(); assertEquals(2, f.prepared); assertEquals(2, f.captures);
                MobileClaimsEngine.Candidate.Progress relocated = (MobileClaimsEngine.Candidate.Progress)((Map<?, ?>)engineField(f.engine, "progress")).get(TXID + ":0");
                assertNotSame(originalProgress, relocated); assertEquals(originalProgress.factor, relocated.factor);
                assertEquals(BigInteger.ONE, relocated.captures); assertEquals(originalProgress.budgetExhausted, relocated.budgetExhausted);
            }
        }
    }
    @Test public void immutableOutputMetadataCannotBeChangedAcrossResyncToReusePreparedWork() throws Exception {
        for (String field : List.of("domain", "amount", "connection_work_target", "root_certificates_version", "signature_algorithms_mask", "coinbase")) try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); resetForResync(f);
            Object replacement = field.equals("domain") ? "other.example" : field.equals("amount") ? "9999999999" : field.equals("connection_work_target") ? "7f" + "ff".repeat(31) : field.equals("coinbase") ? true : 2;
            f.rows.getJSONObject(0).put(field, replacement); f.engine.tick();
            assertEquals(field, "CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError")); assertFalse(f.engine.snapshot().getBoolean("enabled"));
            assertEquals(field, 1, f.captures); assertEquals(field, 1, f.prepared);
        }
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
    @Test public void largeJournalBacklogsCommitOnlyAfterTailAndFenceAndKeepWinner() throws Exception {
        for (int count : new int[]{2100, 10000}) for (boolean changedTip : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            f.rows.put(bounty().put("vout", 1).put("amount", "1000000")); f.nativeResult = proof(true, true, 200);
            f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 0)); f.start(); f.engine.tick();
            String original = (String)engineField(f.engine, "cursor"); long epoch = ((Number)engineField(f.engine, "generation")).longValue();
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            if (changedTip) f.currentTip = tip().put("height", 1).put("hash", "34".repeat(32));
            String expected = journalBacklog(f, count, 100);
            int reads = f.journalCursors.size();
            f.onTip = () -> {
                assertEquals("No private journal page publishes its cursor", original, engineField(f.engine, "cursor"));
                assertEquals("available", ((MobileClaimsEngine.Candidate)((Map<?, ?>)engineField(f.engine, "catalog")).get(TXID + ":1")).state);
                assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            };
            setEngineField(f.engine, "nextDiscovery", 0L); setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine); f.onTip = null;
            assertEquals(count / 100, f.journalCursors.size() - reads); assertEquals(expected, engineField(f.engine, "cursor"));
            assertEquals("spent", ((MobileClaimsEngine.Candidate)((Map<?, ?>)engineField(f.engine, "catalog")).get(TXID + ":1")).state);
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue()); assertTrue((Boolean)engineField(f.engine, "healthy"));
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size()); assertEquals(1, f.captures);
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            assertEquals(List.of("pending", "not-sent", "pending", "submitted"), f.receipts);
            assertEquals("captures", 1, f.captures); assertEquals("attachments", 1, f.attaches); assertEquals("preparations", 1, f.prepared); assertEquals("broadcasts", 2, f.broadcasts);
            assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void journalBudgetExhaustionStartsCoherentRecoveryWithoutDiscardingUnsentWinner() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.rows.put(bounty().put("vout", 1).put("amount", "1000000")); f.nativeResult = proof(true, true, 200);
            f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 0)); f.start(); f.engine.tick();
            long epoch = ((Number)engineField(f.engine, "generation")).longValue(); Object anchor = engineField(f.engine, "blockWindow");
            int budget = ((Number)engineField(f.engine, "MAX_REPLAY_PAGES")).intValue();
            journalBacklog(f, budget + 1, 1); int reads = f.journalCursors.size();
            setEngineField(f.engine, "nextDiscovery", 0L); f.engine.tick();
            assertEquals(budget, f.journalCursors.size() - reads); assertNull(engineField(f.engine, "cursor")); assertSame(anchor, engineField(f.engine, "blockWindow"));
            assertTrue((Boolean)engineField(f.engine, "resyncSnapshotPending")); assertFalse(f.startsAllowed);
            assertTrue(((Map<?, ?>)engineField(f.engine, "catalog")).isEmpty()); assertTrue(((Set<?>)engineField(f.engine, "loaded")).isEmpty());
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
            assertEquals("CLAIMS_SYNC_BUSY", f.engine.snapshot().getString("lastError")); assertTrue(f.engine.snapshot().getBoolean("enabled"));
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size()); assertEquals(1, f.broadcasts);
            int calls = f.calls.size(); f.engine.tick(); assertEquals(calls, f.calls.size());

            // A failed replacement fence must not authorize a retained proof.
            f.journalReplies.clear(); f.changesCount = 0; f.readFailures.put("getchaintip", rpcFailure("RPC_UNAVAILABLE", "getchaintip", 0));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); f.engine.tick();
            assertNull(engineField(f.engine, "cursor")); assertFalse(f.startsAllowed); assertEquals(1, f.broadcasts);
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());

            // The new watermark precedes the block stream. Replay a spend
            // arriving during that stream before admitting any new work.
            f.readFailures.clear(); f.changesCount = 0; f.changes.clear(); f.changes.add(new JSONArray()); f.changes.add(new JSONArray());
            f.changes.add(new JSONArray().put(new JSONObject().put("sequence", 500).put("type", "spent").put("txid", TXID).put("vout", 1).put("spending_txid", CLAIM)));
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); f.engine.tick();
            assertNotNull(engineField(f.engine, "cursor")); assertFalse((Boolean)engineField(f.engine, "catalogGate")); assertTrue(f.startsAllowed);
            assertEquals(List.of(GENESIS, GENESIS), f.blockReads); assertEquals("spent", ((MobileClaimsEngine.Candidate)((Map<?, ?>)engineField(f.engine, "catalog")).get(TXID + ":1")).state);
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
            assertEquals(List.of("pending", "not-sent", "pending", "submitted"), f.receipts); assertEquals("captures", 1, f.captures); assertEquals("attachments", 1, f.attaches); assertEquals("broadcasts", 2, f.broadcasts);
            JSONObject state = f.engine.snapshot(); assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("valid")); assertEquals(1, state.getLong("targetHits"));
            assertEquals(1, state.getLong("submitted")); assertEquals(0, state.getLong("invalid")); assertEquals(0, state.getLong("cancelled")); assertEquals(0, state.getLong("unknown"));
        }
    }
    @Test public void malformedJournalPageBeyondOldLimitStillFailsWithoutPartialPublication() throws Exception {
        for (int malformedPage : new int[]{22, 128}) try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); String original = (String)engineField(f.engine, "cursor");
            journalBacklog(f, (malformedPage + 1) * 100, 100);
            f.journalReplies.get("backlog" + (malformedPage - 1) * 100).getJSONArray("changes").getJSONObject(0).put("sequence", 1);
            setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(original, engineField(f.engine, "cursor")); assertEquals("CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
            assertFalse(f.engine.snapshot().getBoolean("enabled")); assertEquals(1, f.captures); assertEquals(1, f.engine.snapshot().getLong("valid"));
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
            assertEquals(List.of(600, 600), f.windowCounts); assertEquals(List.of(GENESIS, GENESIS), f.blockReads);
            assertEquals(0, f.engine.snapshot().getInt("eligible")); assertTrue(f.engine.snapshot().getBoolean("enabled"));
        }
    }
    @Test public void journalResetWithNewTipWinsBeforeAnyFailingHashQuery() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); Object anchor = engineField(f.engine, "blockWindow");
            long attempts = f.engine.snapshot().getLong("attempts"), valid = f.engine.snapshot().getLong("valid");
            f.recentOverride = MobileClaimBlockWindowTest.window(1, 0, 0); f.currentTip = f.recentOverride.getJSONObject("tip");
            f.changesByCursor.put((String)engineField(f.engine, "cursor"), new JSONArray().put(new JSONObject().put("type", "resync_required")));
            f.readFailures.put("getrecentblockhashes", rpcFailure("RPC_TIMEOUT", "getrecentblockhashes", 0));
            int reads = f.calls.size(); setEngineField(f.engine, "nextDiscovery", 0L); maintain(f.engine);
            assertEquals(List.of("getbountychanges"), f.calls.subList(reads, f.calls.size()));
            assertEquals("CLAIMS_RESYNC", f.engine.snapshot().getString("lastError")); assertNull(engineField(f.engine, "cursor"));
            assertSame(anchor, engineField(f.engine, "blockWindow")); assertTrue(((Map<?, ?>)engineField(f.engine, "catalog")).isEmpty());
            assertEquals(attempts, f.engine.snapshot().getLong("attempts")); assertEquals(valid, f.engine.snapshot().getLong("valid"));
            assertTrue(f.engine.snapshot().getBoolean("enabled")); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void streamRetryResetWithNewTipWinsBeforeAnyFailingHashQuery() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); Object anchor = engineField(f.engine, "blockWindow");
            long attempts = f.engine.snapshot().getLong("attempts"), valid = f.engine.snapshot().getLong("valid");
            ((Set<?>)engineField(f.engine, "loaded")).clear(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1500));
            f.onStream = () -> {
                f.recentOverride = MobileClaimBlockWindowTest.window(1, 0, 0); f.currentTip = f.recentOverride.getJSONObject("tip");
                while (f.changes.size() <= f.changesCount + 1) f.changes.add(new JSONArray());
                f.changes.set(f.changesCount + 1, new JSONArray().put(new JSONObject().put("type", "resync_required")));
                f.readFailures.put("getrecentblockhashes", rpcFailure("RPC_UNAVAILABLE", "getrecentblockhashes", 0));
                f.onStream = null;
            };
            int reads = f.calls.size(); maintain(f.engine);
            assertEquals(List.of("stream", "getbountychanges", "getbountychanges"), f.calls.subList(reads, f.calls.size()));
            assertEquals("CLAIMS_RESYNC", f.engine.snapshot().getString("lastError")); assertNull(engineField(f.engine, "cursor"));
            assertSame(anchor, engineField(f.engine, "blockWindow")); assertTrue(((Map<?, ?>)engineField(f.engine, "catalog")).isEmpty());
            assertEquals(attempts, f.engine.snapshot().getLong("attempts")); assertEquals(valid, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.broadcasts); assertTrue(f.engine.snapshot().getBoolean("enabled"));
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
        for (String code : List.of("RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "-32001", "-32029", "-32030")) {
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
    @Test public void backendUnavailableReadPreservesWinnerAcrossCatalogExpiryAndRefresh() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 60000));
            f.start(); f.engine.tick(); long epoch = ((Number)engineField(f.engine, "generation")).longValue();
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            f.readFailures.put("getbountychanges", rpcFailure("-32001", "getbountychanges", 0));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61)); f.engine.tick();
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
            assertTrue(f.engine.snapshot().getBoolean("enabled")); assertEquals("retrying", f.engine.snapshot().getString("status"));
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "pendingWinners")).size());
            assertFalse(f.startsAllowed); assertEquals(1, f.broadcasts); assertEquals(0, f.cancellations);
            f.readFailures.clear(); f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, f.prepared); assertEquals(1, f.attaches); assertEquals(1, f.captures);
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void unavailableFundingReadPreservesUnrelatedWinnerAndItsExactRetry() throws Exception {
        try (Fixture f = new Fixture(true)) {
            String secondTxid = "34".repeat(32);
            f.rows.put(bounty("example.com", secondTxid, 0, MAX_TARGET, "1000000"));
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 120000));
            f.start(); f.engine.tick(); long epoch = ((Number)engineField(f.engine, "generation")).longValue();
            Map<?, ?> winners = (Map<?, ?>)engineField(f.engine, "pendingWinners"); Object winner = winners.get(TXID + ":0"); assertNotNull(winner);
            f.readFailures.put("gettransaction", rpcFailure("-32002", "gettransaction", 0));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue()); assertSame(winner, winners.get(TXID + ":0"));
            JSONObject state = f.engine.snapshot(); assertEquals("funding", state.getJSONObject("lastRpcError").getString("stage"));
            assertEquals("gettransaction", state.getJSONObject("lastRpcError").getString("method")); assertEquals("-32002", state.getString("lastError"));
            assertEquals(1, f.prepared); assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.broadcasts);
            assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("valid")); assertEquals(0, f.cancellations);
            int reads = f.calls.size(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(4)); maintain(f.engine); assertEquals(reads, f.calls.size());
            f.readFailures.clear(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(1)); maintain(f.engine);
            assertEquals("Recovered raw funding still passes transaction preparation", 2, f.prepared);
            assertSame(winner, winners.get(TXID + ":0")); assertTrue(f.engine.snapshot().isNull("lastRpcError"));
            // Retire only the other fixture bounty through a validated journal
            // event so final counters measure the preserved winner alone.
            f.changesByCursor.put((String)engineField(f.engine, "cursor"), new JSONArray().put(new JSONObject().put("sequence", 1)
                .put("type", "spent").put("txid", secondTxid).put("vout", 0).put("spending_txid", CLAIM)));
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(114)); f.engine.tick();
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue()); assertTrue(winners.isEmpty());
            assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(List.of("pending", "not-sent", "pending", "submitted"), f.receipts);
            state = f.engine.snapshot(); assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("valid"));
            assertEquals(1, state.getLong("targetHits")); assertEquals(1, state.getLong("submitted")); assertEquals(0, state.getLong("unknown"));
            assertEquals(1, f.captures); assertEquals(1, f.attaches);
        }
    }
    @Test public void fundingUnavailableCodeNeverBecomesGenericReadOrBroadcastPermission() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 120000));
            f.start(); f.engine.tick(); long epoch = ((Number)engineField(f.engine, "generation")).longValue();
            f.readFailures.put("getbountychanges", rpcFailure("-32002", "getbountychanges", 0));
            setEngineField(f.engine, "nextDiscovery", 0L); f.engine.tick();
            assertEquals(epoch + 1, ((Number)engineField(f.engine, "generation")).longValue()); assertEquals(1, f.broadcasts);
        }
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(rpcFailure("-32002", "sendrawtransaction", 0));
            f.start(); f.engine.tick(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61)); f.engine.tick();
            assertEquals(List.of("pending", "unknown"), f.receipts); assertEquals(1, f.broadcasts);
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status")); assertFalse(f.engine.snapshot().getBoolean("enabled"));
        }
        try (Fixture f = new Fixture(true)) {
            f.readFailures.put("gettransaction", rpcFailure("-32002", "gettransaction", 0));
            f.start(); f.engine.tick(); assertEquals(0, f.captures);
            f.readFailures.clear(); f.badParent = true; f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); f.engine.tick();
            assertEquals(1, f.prepared); assertEquals(0, f.captures); assertEquals(0, f.broadcasts);
            assertEquals("CLAIMS_FAILED", f.engine.snapshot().getString("lastError"));
        }
    }
    @Test public void provenReadDisconnectPreservesWinnerAndReplaysSameTransactionAfterRecovery() throws Exception {
        for (boolean stream : new boolean[] { false, true }) try (Fixture f = new Fixture(true)) {
            String code = stream ? "RPC_STREAM_INCOMPLETE" : "RPC_PROTOCOL";
            String method = stream ? "getblockbounties" : "getbountychanges";
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 120000));
            f.start(); f.engine.tick(); long epoch = ((Number)engineField(f.engine, "generation")).longValue();
            Map<?, ?> winners = (Map<?, ?>)engineField(f.engine, "pendingWinners"); Object winner = winners.get(TXID + ":0"); assertNotNull(winner);
            MobileRpcClient.RpcFailure disconnect = rpcFailure(code, method, 0).recoveryHint(true, false);
            if (stream) {
                ((Set<?>)engineField(f.engine, "loaded")).clear();
                f.rows.put(bounty("example.com", TXID, 1, MAX_TARGET, "1000000"));
                f.onStream = () -> { throw disconnect; }; // EOF after privately staged rows, before terminal completion.
            } else f.readFailures.put(method, disconnect);
            setEngineField(f.engine, "nextDiscovery", 0L); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61)); f.engine.tick();
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue()); assertSame(winner, winners.get(TXID + ":0"));
            assertEquals(1, f.broadcasts); assertEquals(0, f.cancellations); assertEquals(1, f.prepared); assertEquals(1, f.attaches);
            assertEquals(code, f.engine.snapshot().getString("lastError")); assertEquals(method, f.engine.snapshot().getJSONObject("lastRpcError").getString("method"));
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            if (stream) {
                assertTrue(((Set<?>)engineField(f.engine, "loaded")).isEmpty());
                assertFalse("Incomplete stream must not publish its new bounty", ((Map<?, ?>)engineField(f.engine, "catalog")).containsKey(TXID + ":1"));
                f.rows.remove(1);
            } else assertFalse("An expired catalog cannot admit work during a read disconnect", f.startsAllowed);
            int reads = f.calls.size(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(4)); f.engine.tick(); assertEquals(reads, f.calls.size());
            f.readFailures.clear(); f.onStream = null; f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(56)); f.engine.tick();
            assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue()); assertTrue(winners.isEmpty());
            assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(List.of("pending", "not-sent", "pending", "submitted"), f.receipts);
            assertEquals(1, f.captures); assertEquals(1, f.prepared); assertEquals(1, f.attaches);
            JSONObject state = f.engine.snapshot(); assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("valid"));
            assertEquals(1, state.getLong("targetHits")); assertEquals(1, state.getLong("submitted")); assertEquals(0, state.getLong("unknown"));
        }
    }
    @Test public void malformedReadsWithoutLossEvidenceAreNotPromotedToSafeRetry() throws Exception {
        for (String code : List.of("RPC_PROTOCOL", "RPC_STREAM_INCOMPLETE")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(unsentFailure("RPC_BUSY", 120000));
            f.start(); f.engine.tick(); long epoch = ((Number)engineField(f.engine, "generation")).longValue();
            f.readFailures.put("getbountychanges", rpcFailure(code, "getbountychanges", 0));
            setEngineField(f.engine, "nextDiscovery", 0L); f.engine.tick();
            assertEquals(epoch + 1, ((Number)engineField(f.engine, "generation")).longValue());
            assertTrue(((Map<?, ?>)engineField(f.engine, "pendingWinners")).isEmpty()); assertFalse((Boolean)engineField(f.engine, "healthy"));
            assertEquals(1, f.broadcasts); assertEquals(0, f.engine.snapshot().getLong("submitted")); assertEquals(code, f.engine.snapshot().getString("lastError"));
        }
    }
    @Test public void transportLossOnBroadcastDoesNotAuthorizeAReadStyleRetry() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20);
            f.broadcastFuture = failed(rpcFailure("RPC_PROTOCOL", "sendrawtransaction", 0).recoveryHint(true, false));
            f.start(); f.engine.tick(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61)); f.engine.tick();
            assertEquals(List.of("pending", "unknown"), f.receipts); assertEquals(1, f.broadcasts);
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status")); assertEquals(1, f.engine.snapshot().getLong("unknown"));
            assertFalse(f.engine.snapshot().getBoolean("enabled"));
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
                assertEquals(0, f.cancellations); assertFalse(f.startsAllowed); assertEquals(epoch, ((Number)engineField(f.engine, "generation")).longValue());
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
    private static void journal(Fixture f, String type, long sequence) throws Exception {
        JSONObject event = new JSONObject().put("sequence", sequence).put("type", type).put("txid", TXID).put("vout", 0);
        if (type.equals("pending_spend") || type.equals("spent")) event.put("spending_txid", CLAIM);
        f.changesByCursor.put((String)engineField(f.engine, "cursor"), new JSONArray().put(event)); setEngineField(f.engine, "nextDiscovery", 0L);
    }
    @Test public void definitiveRejectionReopensOnlyAfterCommittedAvailability() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(rejected(-26)); f.start(); f.engine.tick();
            assertEquals(0, f.engine.snapshot().getInt("eligible")); assertEquals(1, f.broadcasts);
            journal(f, "pending_spend", 1); maintain(f.engine);
            journal(f, "available_again", 2);
            f.readFailures.put("getchaintip", rpcFailure("RPC_TIMEOUT", "getchaintip", 0)); maintain(f.engine);
            assertEquals("A failed fence must not reopen a partial replay", 0, f.engine.snapshot().getInt("eligible"));
            f.readFailures.clear(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); maintain(f.engine);
            assertEquals("The original proof still owns this output", 0, f.engine.snapshot().getInt("eligible"));
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.engine.tick();
            assertEquals(1, f.captures); assertEquals(2, f.broadcasts); assertEquals(1, f.attaches);
            assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
        }
    }
    @Test public void acceptedClaimReopensWithSameBytesAndNoDuplicateCounters() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            assertEquals("An old available snapshot does not cause immediate replay", 1, f.broadcasts); assertEquals(0, f.receiptLookups);
            journal(f, "pending_spend", 1); maintain(f.engine);
            journal(f, "available_again", 2); f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.prepared);
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.engine.snapshot().getLong("attempts"));
            assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(1, f.engine.snapshot().getLong("targetHits"));
            assertEquals(0, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void reopeningCommittedDuringWriteStillAppliesAfterDefinitiveRejection() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = new CompletableFuture<>(); f.sent = new CountDownLatch(1); f.start();
            Thread submitter = new Thread(f.engine::tick); submitter.start();
            try {
                assertTrue(f.sent.await(2, TimeUnit.SECONDS));
                journal(f, "pending_spend", 1); maintain(f.engine);
                journal(f, "available_again", 2); maintain(f.engine);
                assertEquals(0, f.engine.snapshot().getInt("eligible"));
                f.broadcastFuture.completeExceptionally(rejected(-26)); submitter.join(2000); assertFalse(submitter.isAlive());
                assertEquals(0, f.engine.snapshot().getInt("eligible")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
                f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick();
                assertEquals(1, f.captures); assertEquals(2, f.broadcasts); assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            } finally { f.broadcastFuture.completeExceptionally(rejected(-26)); submitter.join(2000); }
        }
    }
    @Test public void agedAcceptedClaimReplaysAbsentOwnPendingButNeverCompetingOrConfirmedSpend() throws Exception {
        for (String state : List.of("available", "own-pending", "other-pending", "spent")) try (Fixture f = new Fixture(true)) {
            primeOldest(f); f.nativeResult = proof(true, true, 20); f.engine.tick();
            if (!state.equals("available")) {
                journal(f, state.equals("spent") ? "spent" : "pending_spend", 1);
                if (state.equals("other-pending")) f.changesByCursor.get((String)engineField(f.engine, "cursor")).getJSONObject(0).put("spending_txid", TXID);
                maintain(f.engine);
            }
            adoptWindow(f, 600, 0); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31));
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.engine.tick();
            boolean replay = state.equals("available") || state.equals("own-pending");
            assertEquals(state, replay ? 2 : 1, f.broadcasts);
            assertEquals(state, 1, f.captures); assertEquals(state, 1, f.prepared); assertEquals(state, 1, f.attaches);
            assertEquals(state, 1, f.engine.snapshot().getLong("submitted")); assertEquals(state, 1, f.engine.snapshot().getLong("valid"));
            assertEquals(state, 0, f.engine.snapshot().getLong("unknown"));
            assertFalse(((Map<?,?>)engineField(f.engine, "catalog")).containsKey(TXID + ":0"));
            if (replay) assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            else assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
        }
    }
    @Test public void stillCataloguedOwnPendingClaimCannotReplayUntilAvailabilityIsValidated() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick(); journal(f, "pending_spend", 1); maintain(f.engine);
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            journal(f, "available_again", 2); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); f.engine.tick(); assertEquals(2, f.broadcasts);
        }
    }
    @Test public void competingSpendCancelsQueuedReplayWithoutErasingItsEarlierAcknowledgement() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); journal(f, "available_again", 1);
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0);
            f.queuedBroadcast = true; f.broadcastFuture = new CompletableFuture<>(); f.sent = new CountDownLatch(1);
            Thread submitter = new Thread(f.engine::tick); submitter.start();
            try {
                assertTrue(f.sent.await(2, TimeUnit.SECONDS));
                journal(f, "pending_spend", 2);
                f.changesByCursor.get((String)engineField(f.engine, "cursor")).getJSONObject(0).put("spending_txid", TXID);
                maintain(f.engine); submitter.join(2000); assertFalse(submitter.isAlive());
                assertEquals(List.of("pending", "submitted", "pending", "not-sent"), f.receipts);
                assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size()); assertEquals(0, f.engine.snapshot().getLong("unknown"));
                journal(f, "available_again", 3); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3));
                f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.engine.tick();
                assertEquals(List.of("complete-fixture", "complete-fixture", "complete-fixture"), f.broadcastHexes);
                assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.engine.snapshot().getLong("submitted"));
            } finally { f.broadcastFuture.completeExceptionally(unsentFailure("RPC_CANCELLED", 0)); submitter.join(2000); }
        }
    }
    @Test public void acceptedClaimLookupFailuresAndPendingStateKeepProofUntilValidatedConfirmation() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            Object saved = ((Map<?,?>)engineField(f.engine, "savedWinners")).get(TXID + ":0");
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.receiptFailure = rpcFailure("-32002", "gettransaction", 0); f.engine.tick();
            assertSame(saved, ((Map<?,?>)engineField(f.engine, "savedWinners")).get(TXID + ":0")); assertEquals(1, f.broadcasts);
            f.receiptFailure = null; f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertSame(saved, ((Map<?,?>)engineField(f.engine, "savedWinners")).get(TXID + ":0"));
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "confirmed").put("block_hash", GENESIS).put("block_height", 0)
                .put("transaction", new JSONObject().put("txid", CLAIM).put("hex", "complete-fixture"));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertTrue(((Map<?,?>)engineField(f.engine, "savedWinners")).isEmpty()); assertEquals(1, f.captures); assertEquals(1, f.broadcasts);
            f.engine.stop(); assertTrue(f.engine.canChangeEndpoint());
        }
    }
    @Test public void orphanedConfirmedClaimCanRecaptureAfterFreshFundingSnapshotWithoutDoubleCredit() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); primeOldest(f); f.engine.tick();
            String confirmedBlock = f.currentTip.getString("hash");
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "confirmed").put("block_hash", confirmedBlock).put("block_height", 599)
                .put("transaction", new JSONObject().put("txid", CLAIM).put("hex", "complete-fixture"));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertTrue(((Map<?,?>)engineField(f.engine, "savedWinners")).isEmpty()); assertEquals(1, f.engine.snapshot().getLong("submitted"));
            adoptWindow(f, 599, 1); resetForResync(f); f.changesByCursor.clear(); maintain(f.engine);
            @SuppressWarnings("unchecked") Set<String> loaded = (Set<String>)engineField(f.engine, "loaded");
            @SuppressWarnings("unchecked") Map<String,Long> blocks = (Map<String,Long>)engineField(f.engine, "blocks");
            loaded.addAll(blocks.keySet()); loaded.remove(GENESIS); setEngineField(f.engine, "nextBlock", 0L);
            maintain(f.engine); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(20)); f.engine.tick();
            assertEquals("The old confirmation was orphaned and the same funding output is available again", 2, f.captures);
            assertEquals(2, f.attaches); assertEquals(2, f.broadcasts); assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    private static void confirmOldest(Fixture f) throws Exception {
        f.nativeResult = proof(true, true, 20); primeOldest(f); f.engine.tick();
        f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "confirmed").put("block_hash", f.currentTip.getString("hash")).put("block_height", 599)
            .put("transaction", new JSONObject().put("txid", CLAIM).put("hex", "complete-fixture"));
        f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
        assertTrue(((Map<?,?>)engineField(f.engine, "savedWinners")).isEmpty());
    }
    @Test public void orphanEvidenceRequiresCompleteFundingSnapshotAndCannotResetCaptureBudget() throws Exception {
        try (Fixture f = new Fixture(true)) {
            confirmOldest(f);
            @SuppressWarnings("unchecked") Map<String,MobileClaimsEngine.Candidate.Progress> progress = (Map<String,MobileClaimsEngine.Candidate.Progress>)engineField(f.engine, "progress");
            BigInteger captures = progress.get(TXID + ":0").captures;
            adoptWindow(f, 599, 1); setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            assertTrue(((Set<?>)engineField(f.engine, "retired")).contains(TXID + ":0")); assertEquals(1, f.captures);
            f.incomplete = true; setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine);
            assertTrue(((Set<?>)engineField(f.engine, "retired")).contains(TXID + ":0")); assertEquals(1, f.broadcasts);
            assertEquals(captures, progress.get(TXID + ":0").captures);
        }
    }
    @Test public void stillConfirmedAvailableSnapshotOrAvailableAgainDoesNotReopenRetirement() throws Exception {
        try (Fixture f = new Fixture(true)) {
            confirmOldest(f); journal(f, "available_again", 1); maintain(f.engine);
            @SuppressWarnings("unchecked") Set<String> loaded = (Set<String>)engineField(f.engine, "loaded");
            loaded.remove(GENESIS); setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine); f.engine.tick();
            assertTrue(((Set<?>)engineField(f.engine, "retired")).contains(TXID + ":0"));
            assertEquals(1, f.captures); assertEquals(1, f.broadcasts); assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void returningConfirmationBranchBeforeFundingReloadClearsOrphanEvidence() throws Exception {
        try (Fixture f = new Fixture(true)) {
            confirmOldest(f);
            adoptWindow(f, 599, 1); setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            adoptWindow(f, 599, 0); maintain(f.engine);
            setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine); f.engine.tick();
            assertTrue(((Set<?>)engineField(f.engine, "retired")).contains(TXID + ":0")); assertEquals(1, f.captures); assertEquals(1, f.broadcasts);
        }
    }
    @Test public void receiptAheadOfLocalWindowRetainsBytesInsteadOfCreatingFalseRollback() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); primeOldest(f); f.engine.tick();
            JSONObject ahead = MobileClaimBlockWindowTest.window(600, 0, 0).getJSONObject("tip");
            f.receiptResponse = new JSONObject().put("tip", ahead).put("status", "confirmed").put("block_hash", ahead.getString("hash")).put("block_height", 600)
                .put("transaction", new JSONObject().put("txid", CLAIM).put("hex", "complete-fixture"));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size()); assertEquals(1, f.captures);
            @SuppressWarnings("unchecked") Map<String,MobileClaimsEngine.Candidate.Progress> progress = (Map<String,MobileClaimsEngine.Candidate.Progress>)engineField(f.engine, "progress");
            assertNull(progress.get(TXID + ":0").confirmed);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
        }
    }
    @Test public void confirmedClaimRollbackReopensOnlyAfterFundingStreamAndKeepsHistoricalCounts() throws Exception {
        try (Fixture f = new Fixture(true)) {
            confirmOldest(f); adoptWindow(f, 598, 0); setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            assertTrue(((Set<?>)engineField(f.engine, "retired")).contains(TXID + ":0")); assertEquals(1, f.captures);
            setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(20)); f.engine.tick();
            assertEquals(2, f.captures); assertEquals(2, f.engine.snapshot().getLong("valid")); assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void orphanedConfirmationStreamPendingCanReopenOnLaterValidatedAvailableEvent() throws Exception {
        try (Fixture f = new Fixture(true)) {
            confirmOldest(f); f.rows.getJSONObject(0).put("status", "pending_spend").put("spending_txid", TXID);
            adoptWindow(f, 599, 1); setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine);
            assertTrue(((Set<?>)engineField(f.engine, "retired")).contains(TXID + ":0")); assertEquals(1, f.captures);
            journal(f, "available_again", 1); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(20)); f.engine.tick();
            assertEquals(2, f.captures); assertEquals(2, f.broadcasts); assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void reminedFundingAfterConfirmedClaimDoesNotCreditSameTransactionTwice() throws Exception {
        try (Fixture f = new Fixture(true)) {
            adoptWindow(f, 2, 0);
            String oldFunding = MobileClaimBlockWindowTest.canonical(1);
            f.rows = new JSONArray().put(bounty().put("block_hash", oldFunding).put("block_height", 1));
            f.blockRows.put(oldFunding, f.rows); f.nativeResult = proof(true, true, 20); f.start(); maintain(f.engine);
            setEngineField(f.engine, "nextBlock", 0L); f.engine.tick(); assertEquals(1, f.captures);
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "confirmed").put("block_hash", f.currentTip.getString("hash")).put("block_height", 2)
                .put("transaction", new JSONObject().put("txid", CLAIM).put("hex", "complete-fixture"));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertTrue(((Map<?,?>)engineField(f.engine, "savedWinners")).isEmpty());
            @SuppressWarnings("unchecked") Map<String,MobileClaimsEngine.Candidate.Progress> progress = (Map<String,MobileClaimsEngine.Candidate.Progress>)engineField(f.engine, "progress");
            MobileClaimsEngine.Candidate.Progress previous = progress.get(TXID + ":0");
            adoptWindow(f, 2, 2);
            String newFunding = f.recentOverride.getJSONArray("blocks").getJSONObject(1).getString("hash");
            f.blockRows.put(newFunding, new JSONArray().put(bounty().put("block_hash", newFunding).put("block_height", 1)));
            setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine);
            MobileClaimsEngine.Candidate.Progress orphan = progress.get(TXID + ":0");
            assertNotNull(orphan); assertNull(orphan.prepared); assertNotSame(previous, orphan);
            assertEquals(previous.factor, orphan.factor); assertEquals(previous.captures, orphan.captures); assertEquals(1, f.captures);
            assertFalse(((Map<?,?>)engineField(f.engine, "catalog")).containsKey(TXID + ":0"));
            setEngineField(f.engine, "nextBlock", 0L); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(20)); f.engine.tick();
            assertEquals(2, f.captures); assertEquals(2, f.broadcasts);
            assertEquals("Re-mining the same funding transaction cannot credit its identical claim txid twice", 1, f.engine.snapshot().getLong("submitted"));
            assertEquals(List.of("1:" + TXID + ":0/" + MAX_TARGET + "/0", "1:" + TXID + ":0/" + MAX_TARGET + "/1"), f.boundBudgets);
            assertEquals(2, f.prepared); assertEquals(previous.factor, progress.get(TXID + ":0").factor);
        }
    }
    @Test public void orphanAccountingSurvivesStopStartWithoutOldPreparationAndExpiresAtWindowBoundary() throws Exception {
        try (Fixture f = new Fixture(true)) {
            adoptWindow(f, 2, 0); String oldFunding = MobileClaimBlockWindowTest.canonical(1);
            f.rows = new JSONArray().put(bounty().put("block_hash", oldFunding).put("block_height", 1)); f.blockRows.put(oldFunding, f.rows);
            f.start(); maintain(f.engine); setEngineField(f.engine, "nextBlock", 0L); f.engine.tick(); assertEquals(1, f.captures);
            @SuppressWarnings("unchecked") Map<String,MobileClaimsEngine.Candidate.Progress> progress = (Map<String,MobileClaimsEngine.Candidate.Progress>)engineField(f.engine, "progress");
            int factor = progress.get(TXID + ":0").factor;
            f.engine.stop(); f.changesCount = 0; adoptWindow(f, 2, 2); f.start(); setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            assertEquals(BigInteger.ONE, progress.get(TXID + ":0").captures); assertEquals(factor, progress.get(TXID + ":0").factor); assertNull(progress.get(TXID + ":0").prepared);
            assertEquals(0, f.engine.snapshot().getLong("attempts")); assertEquals(0, f.engine.snapshot().getInt("eligible"));
            // Height 1 is still in [1,600], then leaves [2,601]. Ordinary
            // aging prunes this metadata instead of an unbounded history.
            adoptWindow(f, 600, 600); maintain(f.engine); assertTrue(progress.containsKey(TXID + ":0"));
            adoptWindow(f, 601, 600); maintain(f.engine); assertFalse(progress.containsKey(TXID + ":0"));
            assertEquals(1, f.captures); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void orphanAccountingCannotGrowPastExistingProgressBoundOrPublishPartialSnapshot() throws Exception {
        try (Fixture f = new Fixture(true)) {
            adoptWindow(f, 2, 0); f.start(); maintain(f.engine);
            @SuppressWarnings("unchecked") Map<String,MobileClaimsEngine.Candidate.Progress> progress = (Map<String,MobileClaimsEngine.Candidate.Progress>)engineField(f.engine, "progress");
            String oldFunding = MobileClaimBlockWindowTest.canonical(1);
            MobileClaimsEngine.Candidate template = new MobileClaimsEngine.Candidate(bounty().put("block_hash", oldFunding).put("block_height", 1), oldFunding, 10);
            for (int index = 0; index < 10200; index++) progress.put(TXID + ":" + index, template.progress.accountingOnly());
            adoptWindow(f, 2, 2); setEngineField(f.engine, "nextBlock", Long.MAX_VALUE); maintain(f.engine);
            String cursor = (String)engineField(f.engine, "cursor"); String newBlock = f.currentTip.getString("hash");
            f.blockRows.put(newBlock, new JSONArray().put(bounty().put("txid", repeat("34", 32)).put("block_hash", newBlock).put("block_height", 2)));
            setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine);
            assertEquals("CLAIMS_CAPACITY", f.engine.snapshot().getString("lastError")); assertFalse(f.engine.snapshot().getBoolean("enabled"));
            assertEquals(10200, progress.size()); assertTrue(((Map<?,?>)engineField(f.engine, "catalog")).isEmpty());
            assertEquals(cursor, engineField(f.engine, "cursor")); assertFalse(((Set<?>)engineField(f.engine, "loaded")).contains(newBlock));
            assertEquals(0, f.captures); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void repeatedAbsentReceiptsCannotStarveLaterAcknowledgedClaims() throws Exception {
        try (Fixture f = new Fixture(true)) {
            for (int index = 1; index < 3; index++) f.rows.put(new JSONObject(bounty().toString()).put("vout", index));
            f.nativeResult = proof(true, true, 20); f.start();
            for (int index = 0; index < 3; index++) { f.engine.tick(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(20)); }
            Map<?,?> saved = (Map<?,?>)engineField(f.engine, "savedWinners"); assertEquals(3, saved.size());
            List<Object> records = new ArrayList<>(saved.values());
            java.lang.reflect.Field retryDue = records.get(0).getClass().getDeclaredField("retryDue"); retryDue.setAccessible(true);
            long thirdOriginalDue = retryDue.getLong(records.get(2));
            JSONArray pending = new JSONArray();
            for (int index = 0; index < 3; index++) pending.put(new JSONObject().put("sequence", index + 1).put("type", "pending_spend")
                .put("txid", TXID).put("vout", index).put("spending_txid", TXID));
            f.changesByCursor.put((String)engineField(f.engine, "cursor"), pending); setEngineField(f.engine, "nextDiscovery", 0L);
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31));
            for (int index = 0; index < 12; index++) { f.engine.tick(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); }
            assertEquals(12, f.receiptLookups); assertEquals(3, f.broadcasts);
            assertTrue("Later ACKs must be queried even when the first two repeatedly return absent", retryDue.getLong(records.get(2)) > thirdOriginalDue);
            assertEquals(3, f.engine.snapshot().getLong("submitted")); assertEquals(3, f.engine.snapshot().getLong("valid"));
            f.receiptFailure = null;
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "confirmed").put("block_hash", GENESIS).put("block_height", 0)
                .put("transaction", new JSONObject().put("txid", CLAIM).put("hex", "complete-fixture"));
            for (int index = 0; index < 3; index++) { f.engine.tick(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); }
            assertTrue(saved.isEmpty()); assertEquals(3, f.captures); assertEquals(3, f.broadcasts);
        }
    }
    @Test public void anotherObservedWitnessRecognizesPendingAndConfirmedButReplayKeepsOriginalBytes() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.alternateObservedHex = "other-bound-witness"; f.start(); f.engine.tick();
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "pending")
                .put("transaction", new JSONObject().put("txid", CLAIM).put("hex", f.alternateObservedHex));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertEquals(1, f.receiptLookups); assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            assertEquals(1, f.broadcasts); assertEquals(1, f.engine.snapshot().getLong("submitted"));
            journal(f, "available_again", 1); f.receiptFailure = rpcFailure("-32004", "gettransaction", 0);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); f.engine.tick();
            assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.engine.snapshot().getLong("submitted"));
            f.receiptFailure = null;
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "confirmed").put("block_hash", GENESIS).put("block_height", 0)
                .put("transaction", new JSONObject().put("txid", CLAIM).put("hex", f.alternateObservedHex));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertTrue(((Map<?,?>)engineField(f.engine, "savedWinners")).isEmpty());
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(2, f.broadcasts);
        }
    }
    @Test public void verifiedProofWaitingForFreshCatalogSurvivesCompetingPendingSpend() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.onCapture = () -> f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61));
            f.start(); f.engine.tick(); f.onCapture = null;
            assertEquals(1, f.captures); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.attaches); assertEquals(0, f.broadcasts);
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "pendingWinners")).size());
            journal(f, "pending_spend", 1); f.engine.tick();
            assertEquals("A temporary competitor must not erase an already verified proof", 1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            assertEquals(0, f.attaches); assertEquals(0, f.broadcasts); assertEquals(1, f.captures);
            journal(f, "available_again", 2); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.broadcasts);
            assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(1, f.engine.snapshot().getLong("targetHits")); assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void pendingSpendBetweenCountedHitAndWinnerPublicationCannotEraseProof() throws Exception {
        try (Fixture f = new Fixture(true)) {
            CountDownLatch readingProof = new CountDownLatch(1), releaseProof = new CountDownLatch(1), published = new CountDownLatch(1);
            java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
            f.nativeResult = new JSONObject(proof(true, true, 20).toString()) {
                @Override public String getString(String key) throws org.json.JSONException {
                    if (key.equals("proof")) {
                        readingProof.countDown();
                        try { if (!releaseProof.await(5, TimeUnit.SECONDS)) throw new AssertionError("Proof gate timed out"); }
                        catch (InterruptedException interrupted) { throw new AssertionError(interrupted); }
                    }
                    return super.getString(key);
                }
            };
            f.start(); Thread capture = new Thread(() -> { try { f.engine.tick(); } catch (Throwable error) { failure.set(error); } });
            Thread discovery = new Thread(() -> {
                try { journal(f, "pending_spend", 1); maintain(f.engine); published.countDown(); }
                catch (Throwable error) { failure.set(error); }
            });
            try {
                capture.start(); assertTrue(readingProof.await(2, TimeUnit.SECONDS)); discovery.start();
                // Before the fix this commit slips between accounting and owner
                // creation. After the fix it waits for the same atomic section.
                published.await(1, TimeUnit.SECONDS); releaseProof.countDown(); capture.join(2000); discovery.join(2000);
                assertFalse(capture.isAlive()); assertFalse(discovery.isAlive()); if (failure.get() != null) throw new AssertionError(failure.get());
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(20)); f.engine.tick();
                assertEquals(1, f.captures); assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(1, f.engine.snapshot().getLong("targetHits"));
                assertEquals("A counted target hit must acquire a retained owner atomically", 1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
                journal(f, "available_again", 2); f.receiptFailure = rpcFailure("-32004", "gettransaction", 0);
                f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); f.engine.tick();
                assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.engine.snapshot().getLong("submitted"));
            } finally { releaseProof.countDown(); capture.join(2000); if (discovery.isAlive()) discovery.join(2000); }
        }
    }
    @Test public void restartedSnapshotReopensRejectedProofWhenKnownPendingSpendDisappeared() throws Exception {
        for (boolean acknowledged : new boolean[] {false, true}) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); if (!acknowledged) f.broadcastFuture = failed(rejected(-26)); f.start(); f.engine.tick();
            if (acknowledged) {
                f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); journal(f, "available_again", 1);
                f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.broadcastFuture = failed(rejected(-26)); f.engine.tick();
            }
            journal(f, "pending_spend", 2); maintain(f.engine); f.engine.stop();
            int written = f.broadcasts; f.changesCount = 0; f.changesByCursor.clear(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3));
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.start(); f.engine.tick();
            assertEquals("The complete available snapshot replaces a missed reopening event", written + 1, f.broadcasts);
            assertEquals(1, f.captures); assertEquals(1, f.attaches);
            for (String raw : f.broadcastHexes) assertEquals("complete-fixture", raw);
            assertEquals(acknowledged ? 0 : 1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void restartedAvailableSnapshotAloneDoesNotLoopAnUnchangedRejectedProof() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(rejected(-26)); f.start(); f.engine.tick(); f.engine.stop();
            f.changesCount = 0; f.changesByCursor.clear(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); f.start();
            for (int index = 0; index < 5; index++) { f.engine.tick(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(12)); }
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.broadcasts);
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
        }
    }
    @Test public void pendingUnattachedProofSurvivesPauseStopAndResyncWithoutNewCapture() throws Exception {
        for (String action : List.of("pause", "stop", "resync")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.onCapture = () -> f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61)); f.start(); f.engine.tick(); f.onCapture = null;
            journal(f, "pending_spend", 1); f.engine.tick(); assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            if (action.equals("pause")) { f.engine.setAllowed(false); f.engine.setAllowed(true); journal(f, "available_again", 2); }
            else {
                f.changesCount = 0; f.changesByCursor.clear();
                if (action.equals("stop")) { f.engine.stop(); f.start(); }
                else {
                    java.lang.reflect.Method reset = MobileClaimsEngine.class.getDeclaredMethod("resetCatalog", boolean.class); reset.setAccessible(true);
                    synchronized (f.engine) { reset.invoke(f.engine, true); setEngineField(f.engine, "nextDiscovery", 0L); }
                }
            }
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.engine.tick();
            assertEquals(action, 1, f.captures); assertEquals(action, 1, f.attaches); assertEquals(action, 1, f.broadcasts);
            assertEquals(action, 1, f.engine.snapshot().getLong("submitted")); assertEquals(action, 0, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void unattachedProofIsStillInvalidatedByConfirmedSpendOrCanonicalExit() throws Exception {
        for (String event : List.of("spent", "window_exit")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.onCapture = () -> f.clock.addAndGet(TimeUnit.SECONDS.toNanos(61)); f.start(); f.engine.tick(); f.onCapture = null;
            journal(f, event, 1); f.engine.tick();
            assertTrue(event, ((Map<?,?>)engineField(f.engine, "pendingWinners")).isEmpty()); assertTrue(event, ((Map<?,?>)engineField(f.engine, "savedWinners")).isEmpty());
            assertEquals(event, 1, f.captures); assertEquals(event, 0, f.attaches); assertEquals(event, 0, f.broadcasts);
            assertEquals(event, 1, f.engine.snapshot().getLong("valid")); assertEquals(event, 0, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void incompleteSnapshotCannotReopenRejectedProofAfterRestart() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(rejected(-26)); f.start(); f.engine.tick();
            journal(f, "pending_spend", 1); maintain(f.engine); f.engine.stop(); f.changesCount = 0; f.changesByCursor.clear(); f.incomplete = true;
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); f.start(); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            Object winner = ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next();
            java.lang.reflect.Field reopened = winner.getClass().getDeclaredField("reopened"); reopened.setAccessible(true); assertFalse(reopened.getBoolean(winner));
            f.incomplete = false; f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(6)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.attaches);
        }
    }
    @Test public void unknownSubmissionCanResolveAnotherBoundWitnessWithoutReplacingRetainedBytes() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(new IOException("response lost")); f.start(); f.engine.tick();
            assertEquals(1, f.engine.snapshot().getLong("unknown"));
            assertThrows(IllegalArgumentException.class, () -> f.engine.resolveConfirmedOutcome(CLAIM, "malformed-witness"));
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size()); assertEquals(0, f.engine.snapshot().getLong("submitted"));
            f.alternateObservedHex = "other-bound-witness"; f.engine.resolveConfirmedOutcome(CLAIM, f.alternateObservedHex);
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31)); f.changesCount = 0; f.changesByCursor.clear(); f.start();
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.engine.tick();
            assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(0, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void lateReceiptAfterStopPauseOrCloseCannotResolveUnknownProofOrChangeCounters() throws Exception {
        for (String action : List.of("stop", "pause", "close")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(new IOException("response lost")); f.start(); f.engine.tick();
            long token = f.engine.receiptLookupEpoch(CLAIM);
            CompletableFuture<String> read = new CompletableFuture<>();
            CompletableFuture<Void> completion = read.thenAccept(raw -> {
                try { f.engine.resolveConfirmedOutcome(CLAIM, raw, token); }
                catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
            });
            if (action.equals("stop")) f.engine.stop(); else if (action.equals("pause")) f.engine.setAllowed(false); else f.engine.close();
            List<String> before = new ArrayList<>(f.receipts); read.complete("complete-fixture");
            assertThrows(java.util.concurrent.CompletionException.class, completion::join);
            assertEquals(action, before, f.receipts); assertEquals(action, 1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            assertEquals(action, 0, f.engine.snapshot().getLong("submitted")); assertEquals(action, 1, f.engine.snapshot().getLong("unknown"));
            if (!action.equals("close")) {
                // A new explicit lookup while already paused is legitimate.
                long fresh = f.engine.receiptLookupEpoch(CLAIM); f.engine.resolveConfirmedOutcome(CLAIM, "complete-fixture", fresh);
                assertEquals(1, f.engine.snapshot().getLong("submitted"));
                assertThrows(IllegalArgumentException.class, () -> f.engine.resolveConfirmedOutcome(CLAIM, "complete-fixture", fresh));
            }
        }
    }
    @Test public void rejectedAcknowledgedReplayKeepsItsBytesAndWaitsForAnotherReopening() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3));
            journal(f, "available_again", 1); f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.broadcastFuture = failed(rejected(-26)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick(); assertEquals(2, f.broadcasts);
            journal(f, "available_again", 2); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3));
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.engine.tick();
            assertEquals(List.of("complete-fixture", "complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void preAcknowledgementSnapshotCannotAuthorizeAbsentClaimReplay() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            setEngineField(f.engine, "nextDiscovery", Long.MAX_VALUE); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30));
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.engine.tick();
            assertEquals(1, f.receiptLookups); assertEquals(1, f.broadcasts);
            setEngineField(f.engine, "nextDiscovery", 0L); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void unknownFirstWriteKeepsBytesUntilExactVerifiedResolutionThenAcknowledgedReplay() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(new IOException("response lost")); f.start(); f.engine.tick();
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size()); assertEquals(1, f.engine.snapshot().getLong("unknown"));
            assertThrows(IllegalArgumentException.class, () -> f.engine.resolveConfirmedOutcome(CLAIM, "different"));
            assertEquals(0, f.engine.snapshot().getLong("submitted")); assertFalse(f.engine.canChangeEndpoint());
            f.engine.resolveConfirmedOutcome(CLAIM, "complete-fixture"); assertEquals(1, f.engine.snapshot().getLong("submitted"));
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31)); f.changesCount = 0; f.changesByCursor.clear(); f.start();
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.engine.tick();
            assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes); assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals(0, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void acknowledgedProofKeepsReceiptOwnershipButNeverReplaysAcrossKnownCanonicalConflict() throws Exception {
        try (Fixture f = new Fixture(true)) {
            primeOldest(f, 600); f.nativeResult = proof(true, true, 20); f.engine.tick();
            adoptWindow(f, 600, 600); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31)); f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            f.engine.stop(); f.changesCount = 0; f.changesByCursor.clear(); f.start(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(1, f.captures); assertFalse(f.engine.canChangeEndpoint());
        }
    }
    @Test public void malformedReceiptCannotFreeAcceptedProofOrAuthorizeRebroadcast() throws Exception {
        for (String invalid : List.of("hex", "txid", "height", "block", "status", "text-confirmations")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            JSONObject transaction = new JSONObject().put("hex", "complete-fixture").put("txid", CLAIM);
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "confirmed").put("block_hash", GENESIS).put("block_height", 0).put("transaction", transaction);
            if (invalid.equals("hex")) transaction.put("hex", "different"); else if (invalid.equals("txid")) transaction.put("txid", TXID);
            else if (invalid.equals("height")) f.receiptResponse.put("block_height", 1);
            else if (invalid.equals("block")) f.receiptResponse.put("block_hash", TXID);
            else if (invalid.equals("text-confirmations")) transaction.put("confirmations", "1");
            else f.receiptResponse.put("status", "absent");
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertEquals(invalid, 1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            assertEquals(invalid, 1, f.broadcasts); assertEquals(invalid, "CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
            assertFalse(f.engine.canChangeEndpoint());
        }
    }
    @Test public void wellFormedIndexAndNodeLocationRaceRetriesWithoutStoppingOrLosingProof() throws Exception {
        for (String race : List.of("pending-confirmations", "pending-block", "confirmed-zero", "confirmed-block")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            long epoch = ((Number)engineField(f.engine, "generation")).longValue();
            Object owner = ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next();
            JSONObject transaction = new JSONObject().put("hex", "complete-fixture").put("txid", CLAIM);
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", race.startsWith("pending") ? "pending" : "confirmed").put("transaction", transaction);
            if (race.startsWith("confirmed")) f.receiptResponse.put("block_hash", GENESIS).put("block_height", 0);
            if (race.equals("pending-confirmations")) transaction.put("confirmations", 1);
            else if (race.equals("pending-block")) transaction.put("blockhash", GENESIS);
            else if (race.equals("confirmed-zero")) transaction.put("confirmations", 0);
            else transaction.put("blockhash", TXID);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertEquals(race, "retrying", f.engine.snapshot().getString("status"));
            assertEquals(race, epoch, ((Number)engineField(f.engine, "generation")).longValue());
            assertSame(owner, ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next());
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(1, f.broadcasts); assertEquals(List.of("complete-fixture"), f.broadcastHexes);
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "confirmed").put("block_hash", GENESIS).put("block_height", 0)
                .put("transaction", new JSONObject().put("hex", "complete-fixture").put("txid", CLAIM).put("confirmations", 1).put("blockhash", GENESIS));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31)); f.engine.tick();
            assertEquals(race, 0, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.broadcasts); assertEquals(1, f.captures);
        }
    }
    @Test public void contradictoryPendingReceiptCannotBeAcceptedAsAValidatedAck() throws Exception {
        for (String invalid : List.of("block-height", "block-hash", "null-block", "null-transaction-block", "text-confirmations", "bool-confirmations", "negative-confirmations", "fractional-confirmations")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            JSONObject transaction = new JSONObject().put("hex", "complete-fixture").put("txid", CLAIM);
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "pending").put("transaction", transaction);
            if (invalid.equals("block-height")) f.receiptResponse.put("block_height", 0);
            else if (invalid.equals("block-hash")) f.receiptResponse.put("block_hash", GENESIS);
            else if (invalid.equals("null-block")) f.receiptResponse.put("block_hash", JSONObject.NULL);
            else if (invalid.equals("null-transaction-block")) transaction.put("blockhash", JSONObject.NULL);
            else if (invalid.equals("text-confirmations")) transaction.put("confirmations", "1");
            else if (invalid.equals("bool-confirmations")) transaction.put("confirmations", true);
            else if (invalid.equals("negative-confirmations")) transaction.put("confirmations", -1);
            else transaction.put("confirmations", 0.5);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertEquals(invalid, "CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size()); assertEquals(1, f.broadcasts);
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.engine.snapshot().getLong("valid"));
        }
    }
    @Test public void locationRaceCannotHideInvalidObservedProofOrMalformedMetadata() throws Exception {
        for (String invalid : List.of("proof", "txid", "text-confirmations", "null-block", "top-block")) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            JSONObject transaction = new JSONObject().put("hex", "complete-fixture").put("txid", CLAIM).put("blockhash", GENESIS).put("confirmations", 1);
            f.receiptResponse = new JSONObject().put("tip", f.currentTip).put("status", "pending").put("transaction", transaction);
            if (invalid.equals("proof")) transaction.put("hex", "invalid-observed-proof");
            else if (invalid.equals("txid")) transaction.put("txid", TXID);
            else if (invalid.equals("text-confirmations")) transaction.put("confirmations", "1");
            else if (invalid.equals("null-block")) transaction.put("blockhash", JSONObject.NULL);
            else f.receiptResponse.put("block_hash", GENESIS);
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(30)); f.engine.tick();
            assertEquals(invalid, "error", f.engine.snapshot().getString("status"));
            assertEquals(invalid, "CLAIMS_RPC_DATA", f.engine.snapshot().getString("lastError"));
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.broadcasts);
        }
    }
    @Test public void manualReceiptRejectsMalformedEnvelopeBeforeResolvingRetainedOrRestoredUnknown() throws Exception {
        for (boolean retained : List.of(false, true)) for (String invalid : List.of("missing-tip", "wrong-network", "missing-tx", "wrong-raw", "txid", "null-txid", "status",
                "missing-block", "missing-height", "text-height", "future-height", "genesis-block", "tip-block", "confirmations", "text-confirmations", "null-confirmations",
                "transaction-block", "null-transaction-block", "pending-confirmations", "pending-text-zero", "pending-height", "pending-block", "pending-null-block")) try (Fixture f = new Fixture(true)) {
            if (retained) { f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(new IOException("response lost")); f.start(); f.engine.tick(); }
            else f.engine.restoreUnknownOutcome(CLAIM);
            long token = f.engine.receiptLookupEpoch(CLAIM);
            JSONObject transaction = new JSONObject().put("hex", "complete-fixture").put("txid", CLAIM);
            JSONObject response = new JSONObject().put("tip", tip()).put("status", "confirmed").put("block_hash", GENESIS).put("block_height", 0).put("transaction", transaction);
            switch (invalid) {
                case "missing-tip": response.remove("tip"); break;
                case "wrong-network": response.getJSONObject("tip").put("chain", "test"); break;
                case "missing-tx": response.remove("transaction"); break;
                case "wrong-raw": transaction.put("hex", "unrelated-raw"); break;
                case "txid": transaction.put("txid", TXID); break;
                case "null-txid": transaction.put("txid", JSONObject.NULL); break;
                case "status": response.put("status", "absent"); break;
                case "missing-block": response.remove("block_hash"); break;
                case "missing-height": response.remove("block_height"); break;
                case "text-height": response.put("block_height", "0"); break;
                case "future-height": response.put("block_height", 1); break;
                case "genesis-block": response.put("block_hash", TXID); break;
                case "tip-block": response.getJSONObject("tip").put("height", 2).put("hash", TXID); response.put("block_height", 2).put("block_hash", CLAIM); break;
                case "confirmations": transaction.put("confirmations", 0); break;
                case "text-confirmations": transaction.put("confirmations", "1"); break;
                case "null-confirmations": transaction.put("confirmations", JSONObject.NULL); break;
                case "transaction-block": transaction.put("blockhash", TXID); break;
                case "null-transaction-block": transaction.put("blockhash", JSONObject.NULL); break;
                default:
                    response.put("status", "pending"); response.remove("block_hash"); response.remove("block_height");
                    if (invalid.equals("pending-confirmations")) transaction.put("confirmations", 1);
                    else if (invalid.equals("pending-text-zero")) transaction.put("confirmations", "0");
                    else if (invalid.equals("pending-height")) response.put("block_height", 0);
                    else if (invalid.equals("pending-block")) response.put("block_hash", GENESIS);
                    else response.put("block_hash", JSONObject.NULL);
            }
            List<String> receipts = new ArrayList<>(f.receipts);
            assertThrows(invalid, Exception.class, () -> f.engine.resolveConfirmedReceipt(CLAIM, response, token));
            assertEquals(invalid, receipts, f.receipts); assertEquals(0, f.engine.snapshot().getLong("submitted"));
            assertEquals(invalid, retained ? 1 : 0, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            assertThrows(invalid, IllegalStateException.class, () -> f.engine.start("fixture-public-address"));
        }
    }
    @Test public void validManualReceiptResolvesOnceButNeverCompactsUnanchoredProof() throws Exception {
        for (boolean retained : List.of(false, true)) for (String status : List.of("pending", "confirmed")) for (boolean verbose : List.of(false, true)) try (Fixture f = new Fixture(true)) {
            if (retained) { f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(new IOException("response lost")); f.start(); f.engine.tick(); }
            else f.engine.restoreUnknownOutcome(CLAIM);
            long token = f.engine.receiptLookupEpoch(CLAIM);
            JSONObject transaction = new JSONObject().put("hex", "complete-fixture");
            JSONObject response = new JSONObject().put("tip", tip()).put("status", status).put("transaction", transaction);
            if (status.equals("confirmed")) response.put("block_hash", GENESIS).put("block_height", 0);
            if (verbose) {
                transaction.put("txid", CLAIM).put("confirmations", status.equals("pending") ? 0 : 1);
                if (status.equals("confirmed")) transaction.put("blockhash", GENESIS);
            }
            f.engine.resolveConfirmedReceipt(CLAIM, response, token);
            assertEquals("submitted", f.receipts.get(f.receipts.size() - 1)); assertEquals(retained ? 1 : 0, f.engine.snapshot().getLong("submitted"));
            assertEquals(retained ? 1 : 0, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            assertThrows(IllegalArgumentException.class, () -> f.engine.resolveConfirmedReceipt(CLAIM, response, token));
        }
    }
    @Test public void staleManualReceiptEnvelopeCannotMutateUnknownOutcome() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.engine.restoreUnknownOutcome(CLAIM); long token = f.engine.receiptLookupEpoch(CLAIM); f.engine.stop();
            JSONObject response = new JSONObject().put("tip", tip()).put("status", "pending").put("transaction", new JSONObject().put("hex", "complete-fixture"));
            assertThrows(IllegalArgumentException.class, () -> f.engine.resolveConfirmedReceipt(CLAIM, response, token));
            assertTrue(f.receipts.isEmpty()); assertThrows(IllegalStateException.class, () -> f.engine.start("fixture-public-address"));
            f.engine.resolveConfirmedReceipt(CLAIM, response, f.engine.receiptLookupEpoch(CLAIM)); assertEquals(List.of("submitted"), f.receipts);
        }
    }
    /** Allocated only for its real checkSubmission admission path. No Context,
     * Android service, preference file or active transport is constructed. */
    private static MobileRuntime receiptRuntimeFixture(MobileClaimsEngine engine, MobileRpcClient rpc, Map<String,String> receipt) throws Exception {
        Class<?> allocator = Class.forName("sun.misc.Unsafe");
        java.lang.reflect.Field access = allocator.getDeclaredField("theUnsafe"); access.setAccessible(true);
        MobileRuntime runtime = (MobileRuntime)allocator.getMethod("allocateInstance", Class.class).invoke(access.get(null), MobileRuntime.class);
        for (Map.Entry<String,Object> value : Map.<String,Object>of("claims", engine, "rpc", rpc, "foreground", true).entrySet()) {
            java.lang.reflect.Field field = MobileRuntime.class.getDeclaredField(value.getKey()); field.setAccessible(true); field.set(runtime, value.getValue());
        }
        java.lang.reflect.Field field = MobileRuntime.class.getDeclaredField("receipts"); field.setAccessible(true); field.set(runtime, receiptPreferencesFixture(receipt));
        return runtime;
    }
    private static android.content.SharedPreferences receiptPreferencesFixture(Map<String,String> receipt) {
        return (android.content.SharedPreferences)java.lang.reflect.Proxy.newProxyInstance(MobileRuntime.class.getClassLoader(), new Class<?>[]{android.content.SharedPreferences.class},
            (proxy, method, values) -> { if (method.getName().equals("getString")) return receipt.getOrDefault((String)values[0], (String)values[1]); throw new AssertionError(method); });
    }
    /** No Android context constructor or preference file is used by this fixture. */
    private static final class LimitsContext extends android.content.ContextWrapper {
        android.content.SharedPreferences preferences;
        boolean denyService;
        int serviceChanges;
        private LimitsContext() { super(null); }
        @Override public android.content.SharedPreferences getSharedPreferences(String name, int mode) {
            assertEquals("claims-public-policy", name); return preferences;
        }
        private void serviceChange() { serviceChanges++; if (denyService) throw new IllegalStateException("Service denied by the offline fixture"); }
        @Override public android.content.ComponentName startService(android.content.Intent intent) { serviceChange(); return null; }
        @Override public android.content.ComponentName startForegroundService(android.content.Intent intent) { serviceChange(); return null; }
        @Override public boolean stopService(android.content.Intent intent) { serviceChange(); return true; }
    }
    private static LimitsContext runtimeLimitsPreferences(MobileRuntime runtime, Map<String,Object> memory, boolean[] diskFailure, int[] commits) throws Exception {
        android.content.SharedPreferences preferences = (android.content.SharedPreferences)java.lang.reflect.Proxy.newProxyInstance(
            MobileRuntime.class.getClassLoader(), new Class<?>[]{android.content.SharedPreferences.class}, (proxy, method, values) -> {
                if (method.getName().equals("getAll")) return new HashMap<>(memory);
                if (!method.getName().equals("edit")) throw new AssertionError(method);
                Map<String,Object> changes = new HashMap<>();
                return java.lang.reflect.Proxy.newProxyInstance(MobileRuntime.class.getClassLoader(), new Class<?>[]{android.content.SharedPreferences.Editor.class},
                    (editor, edit, args) -> {
                        if (edit.getName().equals("putInt") || edit.getName().equals("putBoolean")) { changes.put((String)args[0], args[1]); return editor; }
                        if (edit.getName().equals("apply")) { memory.putAll(changes); return null; }
                        if (edit.getName().equals("commit")) { memory.putAll(changes); commits[0]++; return !diskFailure[0]; }
                        throw new AssertionError(edit);
                    });
            });
        Class<?> allocator = Class.forName("sun.misc.Unsafe"); java.lang.reflect.Field access = allocator.getDeclaredField("theUnsafe"); access.setAccessible(true);
        LimitsContext context = (LimitsContext)allocator.getMethod("allocateInstance", Class.class).invoke(access.get(null), LimitsContext.class);
        context.preferences = preferences; context.denyService = true;
        java.lang.reflect.Field field = MobileRuntime.class.getDeclaredField("context"); field.setAccessible(true); field.set(runtime, context);
        return context;
    }
    @Test public void failedLimitsCommitCannotSilentlyChangeRestoredWorkload() throws Exception {
        try (Fixture f = new Fixture(true);
             MobileRpcClient inactive = MobileRpcClient.localTestClient("127.0.0.1", 1, ignored -> { throw new AssertionError("No network allowed"); }, 100)) {
            f.engine.configureLimits(23, 17);
            MobileRuntime runtime = receiptRuntimeFixture(f.engine, inactive, new HashMap<>());
            Map<String,Object> memory = new HashMap<>(Map.of("connectionsPerSecondLimit", 23, "concurrency", 17, "allowMobileData", false, "allowBackground", true));
            boolean[] diskFailure = { true }; int[] commits = { 0 };
            runtimeLimitsPreferences(runtime, memory, diskFailure, commits);
            ClaimsLimits changed = ClaimsLimits.parse(new JSONObject().put("connectionsPerSecondLimit", 100).put("concurrency", 100));
            assertThrows(IllegalStateException.class, () -> runtime.limits(changed));
            assertEquals(23, f.engine.snapshot().getInt("connectionsPerSecondLimit")); assertEquals(17, f.engine.snapshot().getInt("concurrency"));
            // A replacement engine reads this same preference cache; a failed
            // save must not unexpectedly increase its native workload ceilings.
            ClaimsLimits restored = ClaimsLimits.restore(memory);
            assertEquals(23, restored.rate); assertEquals(17, restored.concurrency);
            assertEquals(false, memory.get("allowMobileData")); assertEquals(true, memory.get("allowBackground"));
            assertEquals(2, commits[0]);
            diskFailure[0] = false; runtime.limits(changed);
            assertEquals(100, f.engine.snapshot().getInt("connectionsPerSecondLimit")); assertEquals(100, f.engine.snapshot().getInt("concurrency"));
            assertEquals(100, ClaimsLimits.restore(memory).rate); assertEquals(3, commits[0]);
            assertFalse(f.engine.snapshot().getBoolean("enabled")); assertEquals(0, f.captures); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void limitsStorageRecoveryPreservesProofOwnerCountersAndPolicy() throws Exception {
        try (Fixture f = new Fixture(true);
             MobileRpcClient inactive = MobileRpcClient.localTestClient("127.0.0.1", 1, ignored -> { throw new AssertionError("No network allowed"); }, 100)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            Object owner = ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next();
            Map<String,Object> memory = new HashMap<>(Map.of("connectionsPerSecondLimit", "malformed", "allowMobileData", true, "allowBackground", false));
            boolean[] diskFailure = { true }; int[] commits = { 0 };
            MobileRuntime runtime = receiptRuntimeFixture(f.engine, inactive, new HashMap<>());
            runtimeLimitsPreferences(runtime, memory, diskFailure, commits);
            ClaimsLimits changed = ClaimsLimits.parse(new JSONObject().put("connectionsPerSecondLimit", 23).put("concurrency", 17));
            assertThrows(IllegalStateException.class, () -> runtime.limits(changed));
            assertEquals(100, ClaimsLimits.restore(memory).rate); assertEquals(100, ClaimsLimits.restore(memory).concurrency);
            assertEquals(100, f.engine.snapshot().getInt("connectionsPerSecondLimit")); assertEquals(100, f.engine.snapshot().getInt("concurrency"));
            diskFailure[0] = false; runtime.limits(changed);
            assertEquals(23, f.engine.snapshot().getInt("connectionsPerSecondLimit")); assertEquals(17, f.engine.snapshot().getInt("concurrency"));
            assertEquals(true, memory.get("allowMobileData")); assertEquals(false, memory.get("allowBackground"));
            assertSame(owner, ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next());
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.engine.snapshot().getLong("attempts"));
            assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(1, f.engine.snapshot().getLong("targetHits"));
            assertTrue(f.engine.snapshot().getBoolean("enabled")); assertEquals(List.of("complete-fixture"), f.broadcastHexes);
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(3, commits[0]);
        }
    }
    @Test public void deniedBackgroundServiceMustStillApplyCurrentNetworkPolicy() throws Exception {
        for (boolean enableBackground : new boolean[]{ true, false }) try (Fixture f = new Fixture(true);
             MobileRpcClient inactive = MobileRpcClient.localTestClient("127.0.0.1", 1, ignored -> { throw new AssertionError("No network allowed"); }, 100)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            Object owner = ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next();
            MobileRuntime runtime = receiptRuntimeFixture(f.engine, inactive, new HashMap<>());
            Map<String,Object> memory = new HashMap<>(Map.of("allowMobileData", true, "allowBackground", !enableBackground));
            LimitsContext context = runtimeLimitsPreferences(runtime, memory, new boolean[]{ false }, new int[]{ 0 });
            android.net.ConnectivityManager connectivity = org.mockito.Mockito.mock(android.net.ConnectivityManager.class);
            android.net.Network network = org.mockito.Mockito.mock(android.net.Network.class);
            android.net.NetworkCapabilities caps = org.mockito.Mockito.mock(android.net.NetworkCapabilities.class);
            org.mockito.Mockito.when(connectivity.getActiveNetwork()).thenReturn(network);
            org.mockito.Mockito.when(connectivity.getNetworkCapabilities(network)).thenReturn(caps);
            org.mockito.Mockito.when(connectivity.isActiveNetworkMetered()).thenReturn(true);
            org.mockito.Mockito.when(caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)).thenReturn(true);
            org.mockito.Mockito.when(caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)).thenReturn(true);
            for (Map.Entry<String,Object> value : Map.<String,Object>of("requested", true, "allowMobile", true, "allowBackground", !enableBackground, "service", !enableBackground, "connectivity", connectivity,
                    "recoveryNetworkListeners", new java.util.concurrent.CopyOnWriteArrayList<Runnable>()).entrySet()) {
                java.lang.reflect.Field field = MobileRuntime.class.getDeclaredField(value.getKey()); field.setAccessible(true); field.set(runtime, value.getValue());
            }
            assertTrue(f.engine.snapshot().getBoolean("allowed"));
            // Keep the same online metered network throughout. Native claims
            // were permitted by the old mobile-data setting; denied service
            // startup must still apply the newly disabled mobile-data policy.
            IllegalStateException failure;
            try (org.mockito.MockedConstruction<android.content.Intent> ignored = org.mockito.Mockito.mockConstruction(android.content.Intent.class)) {
                failure = assertThrows(IllegalStateException.class, () -> runtime.policy(false, enableBackground));
            }
            assertEquals(enableBackground ? "Android did not allow the background service. Keep the app open or turn background use off." : "Service denied by the offline fixture", failure.getMessage());
            assertEquals(false, memory.get("allowMobileData")); assertEquals(enableBackground, memory.get("allowBackground"));
            assertFalse("Service denial left the claim engine allowed under an obsolete network policy", f.engine.snapshot().getBoolean("allowed"));
            org.mockito.Mockito.verify(connectivity).getActiveNetwork();
            assertEquals("mobile-data-disabled", runtime.snapshot().getString("policyStatus"));
            assertEquals(!enableBackground, runtime.snapshot().getBoolean("backgroundService")); assertTrue(f.engine.snapshot().getBoolean("enabled"));
            assertEquals(1, context.serviceChanges);
            // The same normal path can resume the retained session once the
            // user permits the network again; no new proof or claim is made.
            context.denyService = false;
            try (org.mockito.MockedConstruction<android.content.Intent> ignored = org.mockito.Mockito.mockConstruction(android.content.Intent.class)) {
                runtime.policy(true, false);
            }
            assertTrue(f.engine.snapshot().getBoolean("allowed")); assertEquals("allowed", runtime.snapshot().getString("policyStatus"));
            assertEquals(true, memory.get("allowMobileData")); assertEquals(false, memory.get("allowBackground")); assertEquals(2, context.serviceChanges);
            assertSame(owner, ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next());
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.engine.snapshot().getLong("attempts"));
            assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals(List.of("complete-fixture"), f.broadcastHexes);
        }
    }
    @Test public void failedReceiptCommitCannotMakeRuntimeRecoveryPermanentlyInaccessible() throws Exception {
        try (Fixture f = new Fixture(true);
             MobileRpcClient inactive = MobileRpcClient.localTestClient("127.0.0.1", 1, ignored -> { throw new AssertionError("No network allowed"); }, 100)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(new IOException("unknown wire outcome")); f.start(); f.engine.tick();
            Object owner = ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next();
            Map<String,String> memory = new HashMap<>(Map.of("txid", CLAIM, "status", "unknown"));
            boolean[] diskFailure = { true };
            f.engine.setReceiptStore((txid, status) -> {
                memory.put("txid", txid); memory.put("status", status);
                if (diskFailure[0]) throw new IOException("Preference memory committed but disk full");
                f.receipts.add(status);
            });
            JSONObject response = new JSONObject().put("tip", f.currentTip).put("status", "pending")
                .put("transaction", new JSONObject().put("hex", "complete-fixture"));
            assertThrows(IllegalStateException.class, () -> f.engine.resolveConfirmedReceipt(CLAIM, response, f.engine.receiptLookupEpoch(CLAIM)));
            assertEquals("submitted", memory.get("status")); assertEquals(0, f.engine.snapshot().getLong("submitted"));
            MobileRuntime runtime = receiptRuntimeFixture(f.engine, inactive, memory);
            assertEquals("unknown", runtime.snapshot().getString("receiptStatus"));
            assertEquals(CLAIM, runtime.snapshot().getString("receiptTxid"));
            diskFailure[0] = false;
            // Exercise the production runtime entry point, not a duplicate
            // implementation of its old persisted-status admission checks.
            java.util.concurrent.CompletionException rejected = assertThrows(java.util.concurrent.CompletionException.class, () -> runtime.checkSubmission().join());
            assertEquals("RPC_INACTIVE", ((MobileRpcClient.RpcFailure)rejected.getCause()).code);
            assertSame(owner, ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next());
            MobileClaimsEngine.ReceiptLookup retry = f.engine.beginReceiptLookup();
            assertEquals(CLAIM, retry.txid); f.engine.resolveConfirmedReceipt(retry.txid, response, retry.epoch);
            assertEquals(1, f.engine.snapshot().getLong("submitted")); assertEquals("submitted", f.receipts.get(f.receipts.size() - 1));
            assertEquals("submitted", runtime.snapshot().getString("receiptStatus"));
            assertSame(owner, ((Map<?,?>)engineField(f.engine, "savedWinners")).values().iterator().next());
            assertEquals(List.of("complete-fixture"), f.broadcastHexes); assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertThrows(IllegalArgumentException.class, runtime::checkSubmission);
        }
    }
    @Test public void runtimeReceiptAdmissionUsesAtomicLiveOwnerNotPreferenceStatus() throws Exception {
        try (Fixture f = new Fixture(true);
             MobileRpcClient inactive = MobileRpcClient.localTestClient("127.0.0.1", 1, ignored -> { throw new AssertionError("No network allowed"); }, 100)) {
            Map<String,String> memory = new HashMap<>(Map.of("txid", CLAIM, "status", "pending"));
            MobileRuntime runtime = receiptRuntimeFixture(f.engine, inactive, memory);
            assertThrows(IllegalArgumentException.class, runtime::checkSubmission);
            f.engine.restoreUnknownOutcome(CLAIM);
            memory.put("txid", TXID); memory.put("status", "submitted");
            assertEquals("unknown", runtime.snapshot().getString("receiptStatus"));
            assertEquals(CLAIM, runtime.snapshot().getString("receiptTxid"));
            MobileClaimsEngine.ReceiptLookup token = f.engine.beginReceiptLookup(); assertEquals(CLAIM, token.txid);
            java.util.concurrent.CompletionException rejected = assertThrows(java.util.concurrent.CompletionException.class, () -> runtime.checkSubmission().join());
            assertEquals("RPC_INACTIVE", ((MobileRpcClient.RpcFailure)rejected.getCause()).code);
            f.engine.stop();
            JSONObject response = new JSONObject().put("tip", f.currentTip).put("status", "pending").put("transaction", new JSONObject().put("hex", "complete-fixture"));
            assertThrows(IllegalArgumentException.class, () -> f.engine.resolveConfirmedReceipt(token.txid, response, token.epoch));
            assertEquals(CLAIM, f.engine.beginReceiptLookup().txid); assertTrue(f.receipts.isEmpty());
            assertEquals(0, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void endpointReplacementRestorationKeepsUncommittedRecoveryGuard() throws Exception {
        try (Fixture old = new Fixture(true); Fixture replacement = new Fixture(true); Fixture resolvedReplacement = new Fixture(true)) {
            old.engine.restoreUnknownOutcome(CLAIM);
            Map<String,String> memory = new HashMap<>(Map.of("txid", CLAIM, "status", "unknown"));
            boolean[] fail = { true };
            old.engine.setReceiptStore((txid, status) -> { memory.put("txid", txid); memory.put("status", status); if (fail[0]) throw new IOException("Partial commit"); });
            JSONObject receipt = new JSONObject().put("tip", old.currentTip).put("status", "pending").put("transaction", new JSONObject().put("hex", "complete-fixture"));
            assertThrows(IllegalStateException.class, () -> old.engine.resolveConfirmedReceipt(CLAIM, receipt, old.engine.receiptLookupEpoch(CLAIM)));
            assertTrue(old.engine.canChangeEndpoint()); assertEquals("submitted", memory.get("status"));
            for (String state : List.of("pending", "unknown")) for (String conflictingId : List.of(TXID, "malformed")) {
                memory.put("status", state); memory.put("txid", conflictingId);
                assertThrows("Never erase a different saved indeterminate receipt", IllegalStateException.class,
                    () -> MobileRuntime.restoreClaimReceipt(replacement.engine, receiptPreferencesFixture(memory), old.engine.pendingReceiptLookup()));
                assertNull(replacement.engine.pendingReceiptLookup()); assertEquals(CLAIM, old.engine.beginReceiptLookup().txid);
                assertEquals(conflictingId, memory.get("txid")); assertEquals(state, memory.get("status"));
            }
            memory.put("status", "submitted"); memory.put("txid", CLAIM);
            // This is the exact restoration helper called during replacement
            // creation, before preferences/endpoint or the old owner are closed.
            MobileRuntime.restoreClaimReceipt(replacement.engine, receiptPreferencesFixture(memory), old.engine.pendingReceiptLookup());
            assertNotNull("A live unknown owner must not disappear in the replacement", replacement.engine.pendingReceiptLookup());
            assertEquals(CLAIM, replacement.engine.beginReceiptLookup().txid);
            assertThrows(IllegalStateException.class, () -> replacement.start());
            assertEquals(CLAIM, old.engine.beginReceiptLookup().txid); assertEquals(0, old.broadcasts); assertEquals(0, replacement.broadcasts);
            fail[0] = false;
            old.engine.resolveConfirmedReceipt(CLAIM, receipt, old.engine.receiptLookupEpoch(CLAIM));
            MobileRuntime.restoreClaimReceipt(resolvedReplacement.engine, receiptPreferencesFixture(memory), old.engine.pendingReceiptLookup());
            assertNull(resolvedReplacement.engine.pendingReceiptLookup());
            assertEquals(0, old.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void runtimeReceiptLookupNeverOverwritesAConflictingSavedOwner() throws Exception {
        for (String state : List.of("pending", "unknown")) for (String conflictingId : List.of(TXID, "malformed")) {
            try (Fixture f = new Fixture(true);
                 MobileRpcClient inactive = MobileRpcClient.localTestClient("127.0.0.1", 1, ignored -> { throw new AssertionError("No network allowed"); }, 100)) {
                f.engine.restoreUnknownOutcome(CLAIM);
                Map<String,String> memory = new HashMap<>(Map.of("txid", conflictingId, "status", state));
                MobileRuntime runtime = receiptRuntimeFixture(f.engine, inactive, memory);
                assertEquals("CLAIMS_RECEIPT_STATE", assertThrows(IllegalStateException.class, runtime::checkSubmission).getMessage());
                assertEquals(CLAIM, f.engine.beginReceiptLookup().txid); assertTrue(f.receipts.isEmpty());
                assertEquals(conflictingId, memory.get("txid")); assertEquals(state, memory.get("status"));
                assertEquals(0, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.broadcasts);
            }
        }
    }
    @Test public void runtimeLateReceiptCannotOverwriteAConflictingSavedOwner() throws Exception {
        for (String state : List.of("pending", "unknown")) for (String conflictingId : List.of(TXID, "malformed")) {
            try (Fixture f = new Fixture(true);
                 java.net.ServerSocket server = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress());
                 MobileRpcClient client = MobileRpcClient.localTestClient("localhost", server.getLocalPort(),
                     ignored -> new java.net.InetAddress[] { java.net.InetAddress.getLoopbackAddress() }, 3000)) {
                server.setSoTimeout(3000);
                CountDownLatch received = new CountDownLatch(1), reply = new CountDownLatch(1);
                java.util.concurrent.ExecutorService wire = java.util.concurrent.Executors.newSingleThreadExecutor();
                f.engine.restoreUnknownOutcome(CLAIM);
                Map<String,String> memory = new ConcurrentHashMap<>(Map.of("txid", CLAIM, "status", "unknown"));
                f.engine.setReceiptStore((txid, status) -> { memory.put("txid", txid); memory.put("status", status); f.receipts.add(status); });
                MobileRuntime runtime = receiptRuntimeFixture(f.engine, client, memory);
                java.util.concurrent.Future<?> sent = wire.submit(() -> {
                    try (java.net.Socket socket = server.accept()) {
                        socket.setSoTimeout(3000);
                        java.io.BufferedReader input = new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream(), java.nio.charset.StandardCharsets.UTF_8));
                        JSONObject request = new JSONObject(input.readLine()); received.countDown();
                        if (!reply.await(3, TimeUnit.SECONDS)) throw new AssertionError("Receipt response was not released");
                        JSONObject result = new JSONObject().put("tip", f.currentTip).put("status", "pending")
                            .put("transaction", new JSONObject().put("hex", "complete-fixture"));
                        byte[] frame = (new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id")).put("result", result) + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                        socket.getOutputStream().write(frame); socket.getOutputStream().flush();
                    } catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
                });
                try {
                    client.setActive(true); CompletableFuture<JSONObject> checking = runtime.checkSubmission();
                    assertTrue(received.await(3, TimeUnit.SECONDS));
                    memory.put("txid", conflictingId); memory.put("status", state); reply.countDown();
                    java.util.concurrent.ExecutionException rejected = assertThrows(java.util.concurrent.ExecutionException.class, () -> checking.get(3, TimeUnit.SECONDS));
                    assertEquals("CLAIMS_RECEIPT_STATE", rejected.getCause().getMessage()); sent.get(3, TimeUnit.SECONDS);
                    assertEquals(CLAIM, f.engine.beginReceiptLookup().txid); assertTrue(f.receipts.isEmpty());
                    assertEquals(conflictingId, memory.get("txid")); assertEquals(state, memory.get("status"));
                    assertEquals(0, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.broadcasts);
                } finally { reply.countDown(); wire.shutdownNow(); assertTrue(wire.awaitTermination(3, TimeUnit.SECONDS)); }
            }
        }
    }
    @Test public void unsentWinnerSurvivesStopOrPauseAndResumesWithoutNewProof() throws Exception {
        for (boolean stop : new boolean[] { false, true }) try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(unsentFailure("RPC_UNAVAILABLE", 0)); f.start(); f.engine.tick();
            if (stop) f.engine.stop(); else f.engine.setAllowed(false);
            assertEquals(1, ((Map<?,?>)engineField(f.engine, "savedWinners")).size()); assertFalse(f.engine.canChangeEndpoint());
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(2)); f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            if (stop) { f.changesCount = 0; f.changesByCursor.clear(); f.start(); } else f.engine.setAllowed(true);
            f.engine.tick(); assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(0, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void acknowledgedWinnerSurvivesStopAndUnavailableSnapshotWithoutDuplicatingTotals() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick(); f.engine.stop();
            assertFalse(f.engine.canChangeEndpoint()); f.changesCount = 0; f.changesByCursor.clear(); f.start();
            f.readFailures.put("getbountychanges", rpcFailure("RPC_TIMEOUT", "getbountychanges", 0)); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31)); f.engine.tick();
            assertEquals(1, f.broadcasts); assertEquals(0, f.receiptLookups);
            f.readFailures.clear(); f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(5)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals("An already counted ACK is not a new submitted claim in the restarted run", 0, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void acceptedReceiptCapacityPausesAdmissionWithoutDroppingSignedBytes() throws Exception {
        try (Fixture f = new Fixture(true)) {
            for (int index = 1; index <= 200; index++) f.rows.put(new JSONObject(bounty().toString()).put("vout", index));
            f.nativeResult = proof(true, true, 20); f.start();
            for (int index = 0; index < 220; index++) { f.engine.tick(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(20)); }
            assertEquals(200, f.captures); assertEquals(200, f.broadcasts); assertEquals(200, ((Map<?,?>)engineField(f.engine, "savedWinners")).size());
            assertEquals(200, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
            assertEquals("waiting", f.engine.snapshot().getString("status")); assertEquals("retained-capacity", f.engine.snapshot().getString("waitingReason"));
            assertEquals(200, f.engine.snapshot().getInt("retainedSubmissions"));
            assertTrue(f.engine.snapshot().getBoolean("enabled"));
        }
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
    @Test public void provenUnsentReceiptCanRecoverAfterStorageReturnsWithoutRecapturing() throws Exception {
        for (boolean gatewayReply : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            boolean[] unavailable = {true};
            Map<String,String> memory = new HashMap<>();
            f.engine.setReceiptStore((txid, status) -> {
                memory.put("txid", txid); memory.put("status", status); // SharedPreferences may publish before reporting disk failure.
                if (unavailable[0] && status.equals("not-sent")) throw new IOException("failed durable unsent receipt");
                f.receipts.add(status);
            });
            f.nativeResult = proof(true, true, 200);
            f.broadcastFuture = failed(gatewayReply ? notForwarded("-32030", 120000) : unsentFailure("RPC_UNAVAILABLE", 120000));
            f.start(); f.engine.tick();
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status"));
            assertEquals(List.of("pending", "unknown"), f.receipts);
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.broadcasts);
            assertEquals(1, f.engine.snapshot().getLong("unknown")); assertEquals(0, f.engine.snapshot().getLong("submitted"));
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals("CLAIMS_RECEIPT_UNAVAILABLE", assertThrows(IllegalStateException.class, () -> f.engine.start("fixture-public-address")).getMessage());
            assertEquals(1, f.engine.snapshot().getLong("unknown")); assertEquals(List.of("pending", "unknown"), f.receipts);
            assertEquals("not-sent", memory.get("status")); assertEquals(CLAIM, f.engine.pendingReceiptLookup().txid);
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "savedWinners")).size());
            f.engine.stop(); unavailable[0] = false; f.changesCount = 0;
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.start(); f.engine.tick();
            assertEquals(List.of("pending", "unknown", "not-sent"), f.receipts); assertEquals(1, f.broadcasts);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(119999)); f.engine.tick(); assertEquals(1, f.broadcasts);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1)); f.engine.tick();
            assertEquals("The same signed bytes must be retried only after a durable not-sent receipt", List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(List.of("pending", "unknown", "not-sent", "pending", "submitted"), f.receipts);
            assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals(0, f.engine.snapshot().getLong("attempts")); assertEquals(0, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void restoredPendingReceiptCannotInventLiveNoWriteEvidence() throws Exception {
        for (String state : List.of("pending", "unknown")) try (Fixture f = new Fixture(true)) {
            MobileRuntime.restoreClaimReceipt(f.engine, receiptPreferencesFixture(new HashMap<>(Map.of("txid", CLAIM, "status", state))), null);
            assertEquals("CLAIMS_UNKNOWN_OUTCOME", assertThrows(IllegalStateException.class, () -> f.engine.start("fixture-public-address")).getMessage());
            f.engine.stop();
            assertEquals("CLAIMS_UNKNOWN_OUTCOME", assertThrows(IllegalStateException.class, () -> f.engine.start("fixture-public-address")).getMessage());
            assertTrue(f.receipts.isEmpty()); assertEquals(0, f.captures); assertEquals(0, f.broadcasts);
            assertEquals(1, f.engine.snapshot().getLong("unknown"));
        }
    }
    @Test public void definitiveRejectionReceiptCanRecoverStorageWithoutAuthorizingImmediateReplay() throws Exception {
        for (boolean publishBeforeFailure : new boolean[]{false, true}) for (int node : new int[]{-26, -22})
        try (Fixture f = new Fixture(true)) {
            boolean[] unavailable = {true};
            Map<String,String> memory = new HashMap<>();
            f.engine.setReceiptStore((txid, state) -> {
                if (publishBeforeFailure) { memory.put("txid", txid); memory.put("status", state); }
                if (unavailable[0] && state.equals("rejected")) throw new IOException("failed durable rejection receipt");
                memory.put("txid", txid); memory.put("status", state); f.receipts.add(state);
            });
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = failed(rejected(node));
            f.start(); f.engine.tick();
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status"));
            assertEquals(List.of("pending", "unknown"), f.receipts);
            assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.broadcasts);
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(1, f.engine.snapshot().getLong("unknown")); assertEquals(0, f.engine.snapshot().getLong("submitted"));
            try (Fixture restarted = new Fixture(true)) {
                MobileRuntime.restoreClaimReceipt(restarted.engine, receiptPreferencesFixture(new HashMap<>(memory)), null);
                assertEquals("A new owner cannot inherit the old Core response", "CLAIMS_UNKNOWN_OUTCOME",
                    assertThrows(IllegalStateException.class, () -> restarted.engine.start("fixture-public-address")).getMessage());
                assertTrue(restarted.receipts.isEmpty()); assertEquals(0, restarted.broadcasts); assertEquals(0, restarted.captures);
            }
            assertEquals("CLAIMS_RECEIPT_UNAVAILABLE", assertThrows(IllegalStateException.class,
                () -> f.engine.start("fixture-public-address")).getMessage());
            assertEquals(CLAIM, f.engine.pendingReceiptLookup().txid);
            assertEquals(1, f.engine.snapshot().getLong("unknown")); assertEquals(List.of("pending", "unknown"), f.receipts);
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "savedWinners")).size());
            f.engine.stop(); unavailable[0] = false; f.changesCount = 0;
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.start(); f.engine.tick();
            assertEquals(List.of("pending", "unknown", "rejected"), f.receipts);
            assertEquals("rejected", memory.get("status")); assertNull(f.engine.pendingReceiptLookup());
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(60)); f.engine.tick();
            assertEquals("A known rejection is not permission to resend", 1, f.broadcasts);
            journal(f, "pending_spend", 1); maintain(f.engine);
            journal(f, "available_again", 2); f.engine.tick();
            assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals(0, f.engine.snapshot().getLong("attempts")); assertEquals(0, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(1, f.engine.snapshot().getLong("submitted"));
        }
    }
    @Test public void failedRejectionReceiptPreservesPreviousAcknowledgementAndItsExactBytes() throws Exception {
        try (Fixture f = new Fixture(true)) {
            boolean[] unavailable = {true};
            f.engine.setReceiptStore((txid, state) -> {
                if (unavailable[0] && state.equals("rejected")) throw new IOException("failed durable rejection receipt");
                f.receipts.add(state);
            });
            f.nativeResult = proof(true, true, 20); f.start(); f.engine.tick();
            assertEquals(1, f.engine.snapshot().getLong("submitted"));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); journal(f, "available_again", 1);
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); f.broadcastFuture = failed(rejected(-26)); f.engine.tick();
            assertEquals(2, f.broadcasts); assertEquals(1, f.engine.snapshot().getLong("submitted"));
            assertEquals(1, f.engine.snapshot().getLong("unknown")); assertNotNull(f.engine.pendingReceiptLookup());
            f.engine.stop(); unavailable[0] = false; f.changesCount = 0; f.changesByCursor.clear();
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM)); f.start(); f.engine.tick();
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31)); f.engine.tick();
            assertEquals("An absent receipt alone does not undo the known rejection", 2, f.broadcasts);
            journal(f, "available_again", 2); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3)); f.engine.tick();
            assertEquals(List.of("complete-fixture", "complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals("Previously counted ACK is not credited in the restarted run", 0, f.engine.snapshot().getLong("submitted"));
            assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(0, f.engine.snapshot().getLong("attempts"));
        }
    }
    @Test public void acknowledgedReceiptCanRecoverStorageBeforeNormalAbsentTransactionReplay() throws Exception {
        for (boolean previouslyAcknowledged : new boolean[]{false, true}) for (boolean publishBeforeFailure : new boolean[]{false, true})
        try (Fixture f = new Fixture(true)) {
            boolean[] unavailable = {false};
            Map<String,String> memory = new HashMap<>();
            f.engine.setReceiptStore((txid, state) -> {
                if (publishBeforeFailure) { memory.put("txid", txid); memory.put("status", state); }
                if (unavailable[0] && state.equals("submitted")) throw new IOException("failed durable acknowledgement receipt");
                memory.put("txid", txid); memory.put("status", state); f.receipts.add(state);
            });
            f.nativeResult = proof(true, true, 20); f.start();
            if (previouslyAcknowledged) {
                f.engine.tick(); f.clock.addAndGet(TimeUnit.SECONDS.toNanos(3));
                journal(f, "available_again", 1); f.receiptFailure = rpcFailure("-32004", "gettransaction", 0);
            }
            unavailable[0] = true; f.engine.tick();
            int initialBroadcasts = previouslyAcknowledged ? 2 : 1;
            assertEquals(initialBroadcasts, f.broadcasts); assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status"));
            assertEquals(1, f.engine.snapshot().getLong("unknown")); assertEquals(previouslyAcknowledged ? 1 : 0, f.engine.snapshot().getLong("submitted"));
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            try (Fixture restarted = new Fixture(true)) {
                MobileRuntime.restoreClaimReceipt(restarted.engine, receiptPreferencesFixture(new HashMap<>(memory)), null);
                assertEquals("CLAIMS_UNKNOWN_OUTCOME", assertThrows(IllegalStateException.class,
                    () -> restarted.engine.start("fixture-public-address")).getMessage());
                assertTrue(restarted.receipts.isEmpty()); assertEquals(0, restarted.broadcasts);
            }
            assertEquals("CLAIMS_RECEIPT_UNAVAILABLE", assertThrows(IllegalStateException.class,
                () -> f.engine.start("fixture-public-address")).getMessage());
            assertEquals(1, f.engine.snapshot().getLong("unknown")); assertEquals(initialBroadcasts, f.broadcasts);
            assertNotNull(f.engine.pendingReceiptLookup());
            f.engine.stop(); unavailable[0] = false; f.changesCount = 0; f.changesByCursor.clear();
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); // The accepted transaction has since left the mempool.
            f.start(); f.engine.tick();
            assertEquals("submitted", memory.get("status")); assertNull(f.engine.pendingReceiptLookup());
            assertEquals("Disk recovery alone cannot authorize another transmission", initialBroadcasts, f.broadcasts);
            assertEquals(0, f.engine.snapshot().getLong("submitted"));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31)); f.engine.tick();
            assertEquals(initialBroadcasts + 1, f.broadcasts);
            assertTrue(f.broadcastHexes.stream().allMatch("complete-fixture"::equals));
            assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals("The earlier valid ACK must not be credited twice", 0, f.engine.snapshot().getLong("submitted"));
            assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(0, f.engine.snapshot().getLong("attempts"));
            assertEquals(0, f.engine.snapshot().getLong("valid"));
        }
    }
    @Test public void runtimeKnownOutcomeRecoveryCannotOverwriteAnotherIndeterminateReceipt() throws Exception {
        for (String outcome : List.of("not-sent", "rejected", "submitted"))
        for (String state : List.of("pending", "unknown")) for (String storedId : List.of(TXID, "malformed"))
        try (Fixture f = new Fixture(true);
             MobileRpcClient inactive = MobileRpcClient.localTestClient("127.0.0.1", 1, ignored -> { throw new AssertionError("No network allowed"); }, 100)) {
            boolean[] unavailable = {true};
            f.engine.setReceiptStore((txid, status) -> {
                if (unavailable[0] && status.equals(outcome)) throw new IOException("failed durable terminal receipt");
                f.receipts.add(status);
            });
            f.nativeResult = proof(true, true, 200);
            if (!outcome.equals("submitted")) f.broadcastFuture = failed(outcome.equals("rejected") ? rejected(-26) : unsentFailure("RPC_UNAVAILABLE", 0));
            f.start(); f.engine.tick(); unavailable[0] = false;
            Map<String,String> memory = new HashMap<>(Map.of("txid", storedId, "status", state));
            MobileRuntime runtime = receiptRuntimeFixture(f.engine, inactive, memory);
            String address = com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto.encodeAddress(
                com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto.fromHex("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"));
            assertEquals("CLAIMS_RECEIPT_STATE", assertThrows(IllegalStateException.class, () -> runtime.start(address)).getMessage());
            assertEquals(Map.of("txid", storedId, "status", state), memory);
            assertEquals(List.of("pending", "unknown"), f.receipts); assertEquals(1, f.engine.snapshot().getLong("unknown"));
            assertEquals(1, f.engine.snapshot().getLong("attempts")); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.captures); assertEquals(1, f.attaches); assertEquals(1, f.broadcasts);
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "savedWinners")).size());
        }
    }
    @Test public void invalidAcknowledgementCannotAcquireStorageRecoveryEvidence() throws Exception {
        for (JSONObject response : List.of(new JSONObject(), new JSONObject().put("txid", TXID),
                new JSONObject().put("txid", new JSONArray().put(CLAIM)), new JSONObject().put("txid", JSONObject.NULL)))
        try (Fixture f = new Fixture(true)) {
            f.engine.setReceiptStore((txid, state) -> {
                assertNotEquals("An invalid ACK must not reach terminal receipt persistence", "submitted", state);
                f.receipts.add(state);
            });
            f.nativeResult = proof(true, true, 20); f.broadcastFuture = CompletableFuture.completedFuture(response);
            f.start(); f.engine.tick();
            for (int retry = 0; retry < 2; retry++) assertEquals("CLAIMS_UNKNOWN_OUTCOME",
                assertThrows(IllegalStateException.class, () -> f.engine.start("fixture-public-address")).getMessage());
            assertEquals(List.of("pending", "unknown"), f.receipts); assertEquals(1, f.broadcasts);
            assertEquals(1, f.engine.snapshot().getLong("unknown")); assertEquals(0, f.engine.snapshot().getLong("submitted"));
            assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals(1, ((Map<?, ?>)engineField(f.engine, "savedWinners")).size());
        }
    }
    @Test public void validatedManualReceiptStorageFailureRecoversOnlyItsLiveProofOwner() throws Exception {
        for (boolean liveProof : new boolean[]{true, false}) try (Fixture f = new Fixture(true)) {
            if (liveProof) {
                f.nativeResult = proof(true, true, 20); f.broadcastFuture = failed(new IOException("unknown wire outcome"));
                f.start(); f.engine.tick();
            } else f.engine.restoreUnknownOutcome(CLAIM);
            boolean[] unavailable = {true};
            Map<String,String> memory = new HashMap<>(Map.of("txid", CLAIM, "status", "unknown"));
            f.engine.setReceiptStore((txid, state) -> {
                memory.put("txid", txid); memory.put("status", state);
                if (unavailable[0]) throw new IOException("submitted was published in memory but not durable");
                f.receipts.add(state);
            });
            JSONObject receipt = new JSONObject().put("tip", f.currentTip).put("status", "pending")
                .put("transaction", new JSONObject().put("hex", "complete-fixture").put("txid", CLAIM));
            long lookup = f.engine.receiptLookupEpoch(CLAIM);
            assertEquals("CLAIMS_RECEIPT_UNAVAILABLE", assertThrows(IllegalStateException.class,
                () -> f.engine.resolveConfirmedReceipt(CLAIM, receipt, lookup)).getMessage());
            assertEquals("submitted", memory.get("status")); assertNotNull(f.engine.pendingReceiptLookup());
            assertEquals(0, f.engine.snapshot().getLong("submitted")); assertEquals(1, f.engine.snapshot().getLong("unknown"));
            assertEquals(liveProof ? "CLAIMS_RECEIPT_UNAVAILABLE" : "CLAIMS_UNKNOWN_OUTCOME",
                assertThrows(IllegalStateException.class, () -> f.engine.start("fixture-public-address")).getMessage());
            unavailable[0] = false;
            if (!liveProof) {
                assertEquals("A restored receipt without original bytes has no retained proof to reconcile", "CLAIMS_UNKNOWN_OUTCOME",
                    assertThrows(IllegalStateException.class, () -> f.engine.start("fixture-public-address")).getMessage());
                assertTrue(f.receipts.isEmpty()); assertEquals(0, f.broadcasts); continue;
            }
            f.engine.stop(); f.changesCount = 0; f.changesByCursor.clear();
            f.receiptFailure = rpcFailure("-32004", "gettransaction", 0); // Evicted after the successful manual lookup.
            f.broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            f.start(); f.engine.tick(); assertEquals(1, f.broadcasts); assertNull(f.engine.pendingReceiptLookup());
            assertEquals("submitted", memory.get("status"));
            assertThrows("The older lookup must not mutate a restarted owner", IllegalArgumentException.class,
                () -> f.engine.resolveConfirmedReceipt(CLAIM, receipt, lookup));
            f.clock.addAndGet(TimeUnit.SECONDS.toNanos(31)); f.engine.tick();
            assertEquals(List.of("complete-fixture", "complete-fixture"), f.broadcastHexes);
            assertEquals(1, f.captures); assertEquals(1, f.attaches);
            assertEquals(0, f.engine.snapshot().getLong("submitted")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
            assertEquals(0, f.engine.snapshot().getLong("attempts")); assertEquals(0, f.engine.snapshot().getLong("valid"));
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
                assertFalse(worker.isAlive()); assertFalse("ACK still owns signed bytes until confirmed", f.engine.canChangeEndpoint());
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
            f.engine.resolveConfirmedOutcome(CLAIM, "complete-fixture"); assertEquals(Arrays.asList("submitted"), f.receipts); assertFalse(f.engine.snapshot().getBoolean("enabled"));
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
    @Test public void completedCaptureCancelledBeforeDeliveryStillConsumesBudgetAfterRestart() throws Exception {
        for (boolean nativeCancellation : new boolean[] {false, true}) {
            try (Fixture f = new Fixture(true)) {
                f.start(); f.engine.tick();
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
                f.onCapture = () -> f.engine.stop();
                if (nativeCancellation) { f.nativeFailure = new IllegalStateException("CLAIM_CANCELLED"); f.capturedBeforeFailure = true; }
                f.engine.tick();
                assertEquals(2, f.captures);
                assertEquals(1, f.engine.snapshot().getLong("cancelled"));
                assertEquals(0, f.attaches); assertEquals(0, f.broadcasts);
                f.onCapture = null; f.nativeFailure = null; f.changesCount = 0; f.start();
                for (int index = 0; index < 4; index++) { f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick(); }
                assertEquals("A completed but cancelled native capture cannot renew the three-capture budget", 3, f.captures);
                assertTrue("The new native run imports both completed captures", f.boundBudgets.get(2).endsWith("/2"));
                assertEquals(1, f.engine.snapshot().getLong("attempts"));
                assertEquals(1, f.engine.snapshot().getLong("valid"));
                assertEquals(0, f.engine.snapshot().getLong("cancelled"));
                assertEquals(0, f.engine.snapshot().getInt("eligible"));
                assertEquals(0, f.attaches); assertEquals(0, f.broadcasts);
            }
        }
    }
    @Test public void restartedRunWaitsForOldNativeCaptureBudgetBeforeAdmittingAnother() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick();
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
            f.onCapture = () -> {
                f.onCapture = null; f.engine.stop(); f.changesCount = 0; f.start();
                f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick();
                assertEquals("The new run cannot bind an incomplete imported budget", 2, f.captures);
            };
            f.engine.tick();
            assertEquals(0, f.engine.snapshot().getLong("attempts"));
            assertEquals(0, f.engine.snapshot().getLong("cancelled"));
            for (int index = 0; index < 4; index++) { f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick(); }
            assertEquals(3, f.captures); assertTrue(f.boundBudgets.get(2).endsWith("/2"));
            assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.attaches); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void lateCaptureBudgetUpdatesRelocatedProgressOnceWithoutRevivingWork() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.start(); f.engine.tick(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
            Object held = reserve(f.engine); assertNotNull(held);
            @SuppressWarnings("unchecked") Map<String, MobileClaimsEngine.Candidate.Progress> progress =
                (Map<String, MobileClaimsEngine.Candidate.Progress>)engineField(f.engine, "progress");
            MobileClaimsEngine.Candidate.Progress original = progress.get(TXID + ":0");
            String otherBlock = repeat("34", 32);
            MobileClaimsEngine.Candidate moved = new MobileClaimsEngine.Candidate(bounty().put("block_hash", otherBlock).put("block_height", 1), otherBlock, 10);
            moved.reuse(original); assertNotSame(original, moved.progress); assertNull(moved.progress.prepared);
            moved.progress.captures = moved.progress.captures.add(BigInteger.ONE);
            progress.put(moved.key, moved.progress);
            f.capturedHandles.add(handle(held)); f.engine.setAllowed(false);
            release(f.engine, held); release(f.engine, held);
            assertEquals(BigInteger.valueOf(2), original.captures);
            assertEquals(BigInteger.valueOf(3), moved.progress.captures);
            assertFalse(moved.budget()); assertNull(moved.progress.prepared);
            assertEquals(2, f.destroys); assertEquals(1, f.engine.snapshot().getLong("valid"));
            assertEquals(0, f.attaches); assertEquals(0, f.broadcasts);
        }
    }
    @Test public void remineSnapshotCannotOverwriteCaptureBudgetDrainedDuringItsFence() throws Exception {
        for (boolean failFence : new boolean[]{false, true}) try (Fixture f = new Fixture(true)) {
            adoptWindow(f, 2, 0); String oldFunding = MobileClaimBlockWindowTest.canonical(1);
            f.rows = new JSONArray().put(bounty().put("block_hash", oldFunding).put("block_height", 1));
            f.blockRows.put(oldFunding, f.rows); f.start(); maintain(f.engine);
            setEngineField(f.engine, "nextBlock", 0L); f.engine.tick(); assertEquals(1, f.captures);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); Object held = reserve(f.engine); assertNotNull(held);
            f.startedTimes.put(handle(held), f.clock.get()); f.engine.snapshot();
            @SuppressWarnings("unchecked") Map<String, MobileClaimsEngine.Candidate.Progress> progress =
                (Map<String, MobileClaimsEngine.Candidate.Progress>)engineField(f.engine, "progress");
            MobileClaimsEngine.Candidate.Progress original = progress.get(TXID + ":0");
            JSONObject oldPreparation = original.prepared;
            adoptWindow(f, 2, 2);
            String newFunding = f.recentOverride.getJSONArray("blocks").getJSONObject(1).getString("hash");
            f.blockRows.put(newFunding, new JSONArray().put(bounty().put("block_hash", newFunding).put("block_height", 1)));
            setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine);
            setEngineField(f.engine, "nextPreparation", Long.MAX_VALUE);
            f.onTip = () -> {
                if (!f.blockReads.get(f.blockReads.size() - 1).equals(newFunding)) return;
                f.capturedHandles.add(handle(held)); release(f.engine, held);
                assertEquals(BigInteger.valueOf(2), original.captures);
                if (failFence) throw rpcFailure("RPC_TIMEOUT", "getchaintip", 0);
            };
            setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine); f.onTip = null;
            if (failFence) {
                assertTrue(f.engine.snapshot().getBoolean("enabled"));
                assertSame("A failed final fence must not publish its staged Progress", original, progress.get(TXID + ":0"));
                assertEquals(BigInteger.valueOf(2), original.captures);
                setEngineField(f.engine, "retryAt", 0L); setEngineField(f.engine, "nextBlock", 0L); maintain(f.engine);
            }
            assertEquals("The fenced snapshot must retain a capture completed after staging", BigInteger.valueOf(2), progress.get(TXID + ":0").captures);
            assertNotSame(original, progress.get(TXID + ":0"));
            assertNotSame("The accounting merge must not revive the old block's preparation", oldPreparation, progress.get(TXID + ":0").prepared);
            assertEquals(0, f.attaches); assertEquals(0, f.broadcasts);
            f.engine.stop(); f.changesCount = 0; f.start();
            for (int i = 0; i < 5; i++) { setEngineField(f.engine, "nextBlock", 0L); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick(); }
            assertEquals("Only one of the original three capture permits remains", 2, f.captures);
            assertTrue(f.boundBudgets.get(2).endsWith("/2"));
            assertEquals(1, f.engine.snapshot().getLong("valid"));
        }
    }
    @Test public void uncapturedCancellationDoesNotConsumeBudgetAndNormalResultsCountOnce() throws Exception {
        for (String error : new String[]{"CLAIM_CANCELLED", "CLAIM_DNS", "CLAIM_TLS"}) {
            try (Fixture f = new Fixture(true)) {
                f.nativeFailure = new IllegalStateException(error); f.onCapture = () -> f.engine.stop();
                f.start(); f.engine.tick();
                f.onCapture = null; f.nativeFailure = null; f.changesCount = 0; f.start();
                for (int index = 0; index < 4; index++) { f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10)); f.engine.tick(); }
                assertEquals(4, f.captures); assertTrue(f.boundBudgets.get(1).endsWith("/0"));
                assertEquals(3, f.engine.snapshot().getLong("valid"));
                assertEquals(0, f.engine.snapshot().getLong("cancelled"));
                assertEquals(0, f.engine.snapshot().getInt("eligible"));
                assertEquals(0, f.attaches); assertEquals(0, f.broadcasts);
            }
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
    @Test public void belowFloorRowsReportFilteredAndUseBoundedCalibrationWithoutCounterFabrication() throws Exception {
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
                assertEquals(scenario[0] + 1, waiting.getLong("attempts"));
                assertEquals(waiting.getLong("attempts"), waiting.getLong("valid"));
                assertEquals(0, waiting.getLong("invalid")); assertEquals(0, waiting.getLong("targetHits"));
                assertTrue(waiting.getBoolean("allowed")); assertTrue(waiting.getBoolean("enabled"));
                assertEquals("waiting", waiting.getString("status")); assertEquals("", waiting.getString("lastError"));
                assertEquals(9, waiting.getInt("available")); assertEquals(0, waiting.getInt("eligible"));
                assertEquals(9, waiting.getInt("economicFiltered")); assertEquals("economic-floor", waiting.getString("waitingReason"));
                assertEquals(0, waiting.getInt("activeConnections"));
                f.clock.addAndGet(TimeUnit.SECONDS.toNanos(10)); f.engine.tick();
                assertEquals(0.1, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
                assertEquals(scenario[0] + 2, f.engine.snapshot().getLong("attempts"));
                f.clock.addAndGet(TimeUnit.SECONDS.toNanos(50)); f.engine.tick();
                assertEquals("Idle time permits only one new probe, not accumulated credits", scenario[0] + 3, f.engine.snapshot().getLong("attempts"));
                f.engine.tick(); assertEquals("waiting", f.engine.snapshot().getString("status"));
            }
        }
    }
    @Test public void exhaustedOutputDoesNotPreventPositiveBelowFloorSiblingsFromCalibration() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.rows = new JSONArray().put(bounty());
            for (int vout = 1; vout <= 9; vout++) f.rows.put(bounty("example.com", TXID, vout, MAX_TARGET, "100"));
            f.onCapture = () -> f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(10));
            f.start(); for (int pulse = 0; pulse < 10; pulse++) f.engine.tick();
            assertEquals(3, f.engine.snapshot().getLong("attempts"));
            assertEquals(9, f.engine.snapshot().getInt("available")); assertEquals(0, f.engine.snapshot().getInt("eligible"));
            assertEquals("waiting", f.engine.snapshot().getString("status"));
            assertEquals("", f.engine.snapshot().getString("lastError"));
            f.clock.addAndGet(TimeUnit.MINUTES.toNanos(5)); f.engine.tick();
            assertEquals("After the rank refresh a below-prior-floor policy is measured without accumulated credits", 4, f.engine.snapshot().getLong("attempts"));
        }
    }

    @Test public void coldTwentyBitCatalogIsMeasuredAndCanBecomeEconomicallyEligible() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.rows = new JSONArray();
            for (int vout = 0; vout < 200; vout++) f.rows.put(bounty("example.com", TXID, vout, "00000" + "f".repeat(59), "75000010"));
            f.nativeResult = proof(true, false, 50); f.start();
            for (int pulse = 0; pulse < 32; pulse++) { f.engine.tick(); f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(250)); }
            JSONObject state = f.engine.snapshot();
            assertEquals(32, state.getLong("attempts")); assertEquals(32, state.getLong("valid"));
            assertEquals(0, state.getLong("invalid")); assertEquals(0, state.getLong("targetHits"));
            assertEquals(200, state.getInt("available")); assertEquals(200, state.getInt("eligible")); assertEquals(0, state.getInt("economicFiltered"));
            assertTrue(state.getJSONArray("domains").getJSONObject(0).getDouble("rate") > 13.98);
        }
    }

    @Test public void fractionalNativeStartCannotShortenTheGlobalProbeSpacing() throws Exception {
        try (Fixture f = new Fixture(true)) {
            f.rows = new JSONArray().put(bounty("example.com", TXID, 0, MAX_TARGET, "100"));
            f.clock.incrementAndGet(); f.start(); f.engine.tick(); assertEquals(1, f.captures);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(250) - 1);
            f.engine.tick(); assertEquals("249.999999 ms is still too early", 1, f.captures);
            f.clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1)); f.engine.tick(); assertEquals(2, f.captures);
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
