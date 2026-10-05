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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
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
    private static MobileClaimsEngine.Candidate candidate(JSONObject value) throws Exception { return new MobileClaimsEngine.Candidate(value, GENESIS, 10); }
    private static JSONObject proof(boolean valid, boolean target, long duration) throws Exception { return new JSONObject().put("proof", valid ? "02aa" : "").put("validProof", valid).put("meetsTarget", target).put("durationMs", duration); }
    private static <T> CompletableFuture<T> failed(Exception failure) { CompletableFuture<T> value = new CompletableFuture<>(); value.completeExceptionally(failure); return value; }
    private static MobileRpcClient.RpcFailure rejected(int node) throws Exception {
        try { MobileRpcClient.reply(new JSONObject().put("jsonrpc", "2.0").put("id", "fixture").put("error", new JSONObject().put("code", -32020).put("data", new JSONObject().put("node_code", node))), "fixture"); }
        catch (MobileRpcClient.RpcFailure error) { return error; }
        throw new AssertionError();
    }
    private interface Action { void run() throws Exception; }
    private static final class Fixture implements AutoCloseable, MobileClaimsEngine.RpcAccess, MobileClaimsEngine.ProofAccess, MobileClaimsEngine.Transactions {
        final List<String> calls = new ArrayList<>(), receipts = new ArrayList<>();
        final List<JSONArray> changes = new ArrayList<>();
        final MobileClaimsEngine engine = new MobileClaimsEngine(this, this, this, false);
        JSONArray rows = new JSONArray().put(bounty());
        JSONObject nativeResult = proof(true, false, 200), currentTip = tip();
        int changesCount, captures, prepared, attaches, broadcasts, destroys, cancellations;
        boolean incomplete, badParent, failReceipt;
        Exception nativeFailure;
        Action onCapture, onAttach;
        CompletableFuture<JSONObject> broadcastFuture = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
        CountDownLatch sent;
        Fixture() throws Exception { engine.setReceiptStore((txid, status) -> { if (failReceipt) throw new IOException("fixture"); assertEquals(CLAIM, txid); receipts.add(status); }); }
        void start() { engine.start("fixture-public-address"); engine.setAllowed(true); }
        public CompletableFuture<JSONObject> call(String method, JSONObject params) {
            calls.add(method);
            try { switch (method) {
                case "getbountychanges": {
                    int page = changesCount++;
                    if (page == 0) assertEquals(0, params.length()); else assertTrue(params.has("cursor"));
                    return CompletableFuture.completedFuture(new JSONObject().put("tip", currentTip).put("next_cursor", "cursor" + page).put("has_more", false).put("changes", page < changes.size() ? changes.get(page) : new JSONArray()));
                }
                case "getrecentblockhashes": return CompletableFuture.completedFuture(new JSONObject().put("tip", currentTip).put("window", 600).put("blocks", new JSONArray().put(new JSONObject().put("height", 0).put("hash", GENESIS))));
                case "gettransaction": return CompletableFuture.completedFuture(new JSONObject().put("tip", currentTip).put("transaction", new JSONObject().put("hex", badParent ? "bad" : "parent-fixture")));
                default: throw new AssertionError(method);
            } } catch (Exception failure) { return failed(failure); }
        }
        public CompletableFuture<JSONObject> stream(String hash, MobileRpcClient.ChunkConsumer consumer) {
            calls.add("stream"); assertEquals(GENESIS, hash);
            try {
                consumer.accept(new JSONObject().put("type", "snapshot").put("tip", currentTip).put("cursor", "stream-watermark"));
                consumer.accept(new JSONObject().put("type", "bounties").put("tip", currentTip).put("items", rows));
                if (incomplete) return failed(new IOException("fixture incomplete"));
                consumer.accept(new JSONObject().put("type", "state").put("tip", currentTip).put("cursor", "stream-final"));
                return CompletableFuture.completedFuture(new JSONObject().put("complete", true));
            } catch (Exception error) { return failed(error); }
        }
        public CompletableFuture<JSONObject> broadcast(String hex) { calls.add("broadcast"); broadcasts++; assertEquals("complete-fixture", hex); if (sent != null) sent.countDown(); return broadcastFuture; }
        public long create() { return 7; }
        public void cancel(long handle) { assertEquals(7, handle); cancellations++; }
        public void destroy(long handle) { assertEquals(7, handle); destroys++; }
        public JSONObject capture(JSONObject context, long handle) throws Exception {
            captures++; assertEquals(7, handle); assertEquals(7, context.getInt("mask")); assertEquals("challenge", context.getString("challenge"));
            if (onCapture != null) onCapture.run(); if (nativeFailure != null) throw nativeFailure; return nativeResult;
        }
        public void validateReward(String address) { if (!"fixture-public-address".equals(address)) throw new IllegalArgumentException("invalid fixture address"); }
        public long fee() { return 10; }
        public JSONObject prepare(JSONObject value, String parent, String reward) throws Exception { prepared++; if (!parent.equals("parent-fixture")) throw new IllegalArgumentException("bad raw parent"); return new JSONObject().put("challenge", "challenge"); }
        public JSONObject attach(JSONObject prepared, String proof) throws Exception { attaches++; if (onAttach != null) onAttach.run(); return new JSONObject().put("txid", CLAIM).put("hex", "complete-fixture"); }
        public void close() { engine.close(); }
    }

    @Test public void emaMatchesExactDecayAndUsesVerifiedProofNotTarget() {
        MobileClaimsEngine.Ema stats = new MobileClaimsEngine.Ema(); assertEquals(5, stats.rate(), 0);
        stats.record(false, 0.2); assertEquals(0.0999, stats.connections, 1e-15); assertEquals(0.02018, stats.totalTime, 1e-15);
        stats.record(true, 0.2); assertEquals(0.999 * 0.0999 + 0.001, stats.connections, 1e-15);
        assertEquals(2, stats.completed);
        for (int index = 0; index < 800000; index++) stats.record(false, 0.2);
        assertTrue(stats.rate() > 0); assertTrue(Double.isFinite(stats.rate()));
        MobileClaimsEngine.Ema instant = new MobileClaimsEngine.Ema();
        for (int index = 0; index < 800000; index++) instant.record(false, 0);
        assertTrue(instant.rate() > 0); assertTrue(Double.isFinite(instant.rate()));
    }
    @Test public void sameDomainAlwaysUsesBestNetRewardTimesTargetAndOthersUseLatency() throws Exception {
        MobileClaimsEngine.Candidate hard = candidate(bounty("example.com", TXID, 1, "0000" + repeat("ff", 30), "10000000000"));
        MobileClaimsEngine.Candidate easy = candidate(bounty("example.com", TXID, 2, "00" + repeat("ff", 31), "10000000000"));
        MobileClaimsEngine.Candidate rich = candidate(bounty("other.com", TXID, 3, "00" + repeat("ff", 31), "10000000000"));
        Map<String, MobileClaimsEngine.Ema> stats = new HashMap<>();
        MobileClaimsEngine.Ema slow = new MobileClaimsEngine.Ema(); slow.totalTime = 1; stats.put("other.com", slow);
        assertSame(easy, MobileClaimsEngine.select(Arrays.asList(hard, easy, rich), stats, new HashSet<>()));
        stats.get("other.com").totalTime = 0.001;
        assertSame(rich, MobileClaimsEngine.select(Arrays.asList(hard, easy, rich), stats, new HashSet<>()));
        assertSame(hard, MobileClaimsEngine.select(Arrays.asList(easy, hard), new HashMap<>(), new HashSet<>(Arrays.asList(easy.key))));
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
    @Test public void watermarkPrecedesStreamReplayThenFundingAndValidMissUpdatesEma() throws Exception {
        try (Fixture f = new Fixture()) {
            f.start(); f.engine.tick();
            assertEquals(Arrays.asList("getbountychanges", "getrecentblockhashes", "getbountychanges", "stream", "getbountychanges", "gettransaction"), f.calls);
            assertEquals(1, f.captures); assertEquals(1, f.prepared); assertEquals(1, f.destroys); assertEquals(0, f.broadcasts);
            JSONObject state = f.engine.snapshot(); assertEquals(1, state.getLong("attempts")); assertEquals(1, state.getLong("valid")); assertEquals(0, state.getLong("targetHits"));
            assertEquals(0.1009, state.getJSONArray("domains").getJSONObject(0).getDouble("connections"), 1e-15);
            assertEquals(4, state.getInt("connectionsPerSecondLimit")); assertTrue(state.getBoolean("discoveryComplete"));
        }
    }
    @Test public void invalidCompletedHandshakeCountsFailureButDnsFailureIsNeutral() throws Exception {
        try (Fixture f = new Fixture()) { f.nativeResult = proof(false, false, 200).put("errorCode", "CLAIM_CERTIFICATE"); f.start(); f.engine.tick(); assertEquals(1, f.engine.snapshot().getLong("invalid")); assertEquals("CLAIM_CERTIFICATE", f.engine.snapshot().getString("lastError")); assertEquals(0.0999, f.engine.snapshot().getJSONArray("domains").getJSONObject(0).getDouble("connections"), 1e-15); }
        try (Fixture f = new Fixture()) { f.nativeFailure = new IllegalStateException("CLAIM_DNS"); f.start(); f.engine.tick(); assertEquals(0, f.engine.snapshot().getLong("invalid")); assertEquals(0, f.engine.snapshot().getJSONArray("domains").getJSONObject(0).getLong("completed")); assertTrue(f.engine.snapshot().getBoolean("enabled")); }
    }
    @Test public void streamFailureNeverPublishesPartialCatalogAndBackoffDoesNotHammerRpc() throws Exception {
        try (Fixture f = new Fixture()) { f.incomplete = true; f.start(); f.engine.tick(); assertEquals(0, f.captures); assertEquals(0, f.engine.snapshot().getInt("discoveredBlocks")); assertEquals(0, f.engine.snapshot().getInt("eligible")); int count = f.calls.size(); for (int i = 0; i < 10; i++) f.engine.tick(); assertEquals(count, f.calls.size()); }
    }
    @Test public void deltaSpendAfterSnapshotPreventsCapture() throws Exception {
        try (Fixture f = new Fixture()) {
            f.changes.add(new JSONArray()); f.changes.add(new JSONArray());
            f.changes.add(new JSONArray().put(new JSONObject().put("sequence", 1).put("type", "pending_spend").put("txid", TXID).put("vout", 0).put("spending_txid", CLAIM)));
            f.start(); f.engine.tick(); assertEquals(0, f.captures); assertEquals(0, f.engine.snapshot().getInt("eligible"));
        }
    }
    @Test public void wrongNetworkAndBadFundingNeverReachProofOrBroadcast() throws Exception {
        try (Fixture f = new Fixture()) { f.currentTip.put("chain", "testnet4"); f.start(); f.engine.tick(); assertEquals("CLAIMS_WRONG_NETWORK", f.engine.snapshot().getString("lastError")); assertFalse(f.engine.snapshot().getBoolean("enabled")); assertEquals(0, f.captures); }
        try (Fixture f = new Fixture()) { f.badParent = true; f.start(); f.engine.tick(); assertEquals(0, f.captures); assertEquals(0, f.broadcasts); }
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
    @Test public void stopDuringBroadcastRetainsUnknownReceipt() throws Exception {
        try (Fixture f = new Fixture()) {
            f.nativeResult = proof(true, true, 200); f.broadcastFuture = new CompletableFuture<>(); f.sent = new CountDownLatch(1); f.start();
            Thread worker = new Thread(f.engine::tick); worker.start(); assertTrue(f.sent.await(2, TimeUnit.SECONDS)); f.engine.stop(); worker.join(2000); assertFalse(worker.isAlive());
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status")); assertEquals(Arrays.asList("pending", "unknown"), f.receipts); assertEquals(1, f.broadcasts);
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
}
