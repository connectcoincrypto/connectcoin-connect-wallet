package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Scheduled production lanes, exclusively fake RPC and proof dependencies. */
public class MobileClaimsParallelTest {
    private static final String GENESIS = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e";
    private static final String TXID = "12".repeat(32), CLAIM = "ab".repeat(32);
    private static JSONObject tip() throws Exception { return new JSONObject().put("chain", "main").put("genesis_hash", GENESIS).put("hash", GENESIS).put("height", 0).put("mediantime", 1780000000); }
    private static JSONObject bounty(int vout) throws Exception {
        return new JSONObject().put("txid", TXID).put("vout", vout).put("amount", "10000000000").put("domain", "example.com").put("connection_work_target", "ff".repeat(32))
            .put("root_certificates_version", 1).put("signature_algorithms_mask", 7).put("block_hash", GENESIS).put("block_height", 0).put("confirmations", 1).put("coinbase", false).put("status", "available");
    }
    private static void until(BooleanSupplier condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(5);
        assertTrue("Timed out waiting for an offline engine condition", condition.getAsBoolean());
    }
    private static void assertPacedStarts(List<Long> starts, int rate) {
        for (int index = 0, first = 0; index < starts.size(); index++) {
            while (starts.get(index) - starts.get(first) >= TimeUnit.SECONDS.toNanos(1)) first++;
            assertTrue("Actual TCP starts obey the rolling one-second ceiling", index - first + 1 <= rate);
        }
    }
    private static MobileRpcClient.RpcFailure cancelledRpc(boolean written) {
        try {
            java.lang.reflect.Constructor<MobileRpcClient.RpcFailure> constructor = MobileRpcClient.RpcFailure.class.getDeclaredConstructor(String.class, boolean.class, Integer.class, long.class, boolean.class);
            constructor.setAccessible(true); return constructor.newInstance("RPC_CANCELLED", written, null, 0L, false);
        } catch (Exception failure) { throw new AssertionError(failure); }
    }
    private static final class Gate {
        final CountDownLatch ready = new CountDownLatch(1);
        final CountDownLatch startReady = new CountDownLatch(1);
        volatile boolean cancelled;
        volatile long startedAt;
    }
    private static final class Fixture implements AutoCloseable, MobileClaimsEngine.RpcAccess, MobileClaimsEngine.ProofAccess, MobileClaimsEngine.Transactions {
        final AtomicLong clockOffsetNanos = new AtomicLong();
        final MobileClaimsEngine engine = new MobileClaimsEngine(this, this, this, true, () -> System.nanoTime() + clockOffsetNanos.get());
        final Map<Long, Gate> gates = new ConcurrentHashMap<>();
        final Map<Long, String> preStartFailures = new ConcurrentHashMap<>();
        final List<Long> starts = new CopyOnWriteArrayList<>(), startedHandles = new CopyOnWriteArrayList<>();
        final List<String> receipts = new CopyOnWriteArrayList<>();
        final AtomicLong serial = new AtomicLong();
        final AtomicInteger active = new AtomicInteger(), peak = new AtomicInteger(), destroyed = new AtomicInteger(), cancellations = new AtomicInteger(), parents = new AtomicInteger(), prepared = new AtomicInteger(), broadcasts = new AtomicInteger(), pages = new AtomicInteger();
        final CompletableFuture<JSONObject> pendingDiscovery = new CompletableFuture<>();
        final CountDownLatch attachGate = new CountDownLatch(1);
        final Object startLimiter = new Object();
        final ArrayDeque<Long> recentNativeStarts = new ArrayDeque<>(), startWaiters = new ArrayDeque<>();
        volatile int rate = 100;
        long nextNativeStart, lastNativeStart;
        boolean limiterClosed, heldStartsReleased;
        volatile boolean holdDiscovery, discoveryWaiting, hit, validMiss, holdAttach, attachWaiting, holdStart, startWaiting;
        volatile CompletableFuture<JSONObject> broadcastResult;
        volatile boolean broadcastWritten = true, failNotSentReceipt;
        volatile int lastWinnerVout = -1;
        final AtomicInteger queuedCancellations = new AtomicInteger();
        volatile JSONArray changeEvents = new JSONArray();
        JSONArray rows = new JSONArray().put(bounty(0));
        Fixture() throws Exception {
            broadcastResult = CompletableFuture.completedFuture(new JSONObject().put("txid", CLAIM));
            engine.setReceiptStore((txid, status) -> { if (failNotSentReceipt && status.equals("not-sent")) throw new IOException("fixture receipt failure"); receipts.add(txid + ":" + status); });
        }
        void queueBroadcast() {
            broadcastWritten = false;
            broadcastResult = new CompletableFuture<>() {
                @Override public boolean cancel(boolean interrupt) { return completeExceptionally(cancelledRpc(broadcastWritten)); }
            };
        }
        void start() { engine.setAllowed(true); engine.start("fixture"); }
        void refresh() throws Exception { synchronized (engine) { Field field = MobileClaimsEngine.class.getDeclaredField("nextDiscovery"); field.setAccessible(true); field.setLong(engine, 0); } }
        public CompletableFuture<JSONObject> call(String method, JSONObject params) {
            try {
                if (method.equals("getbountychanges")) return CompletableFuture.completedFuture(new JSONObject().put("tip", tip()).put("next_cursor", "cursor" + pages.incrementAndGet()).put("has_more", false).put("changes", changeEvents));
                if (method.equals("getrecentblockhashes")) {
                    if (holdDiscovery) { discoveryWaiting = true; return pendingDiscovery; }
                    return CompletableFuture.completedFuture(new JSONObject().put("tip", tip()).put("window", 600).put("blocks", new JSONArray().put(new JSONObject().put("height", 0).put("hash", GENESIS))));
                }
                if (method.equals("gettransaction")) { parents.incrementAndGet(); return CompletableFuture.completedFuture(new JSONObject().put("tip", tip()).put("transaction", new JSONObject().put("hex", "fixture"))); }
                throw new AssertionError(method);
            } catch (Exception failure) { CompletableFuture<JSONObject> result = new CompletableFuture<>(); result.completeExceptionally(failure); return result; }
        }
        public CompletableFuture<JSONObject> stream(String hash, MobileRpcClient.ChunkConsumer consumer) {
            try { consumer.accept(new JSONObject().put("type", "bounties").put("tip", tip()).put("items", rows)); return CompletableFuture.completedFuture(new JSONObject().put("complete", true)); }
            catch (Exception failure) { CompletableFuture<JSONObject> result = new CompletableFuture<>(); result.completeExceptionally(failure); return result; }
        }
        public CompletableFuture<JSONObject> broadcast(String hex) { broadcasts.incrementAndGet(); return broadcastResult; }
        public synchronized boolean cancelBeforeWrite(CompletableFuture<JSONObject> operation) {
            if (operation != broadcastResult || broadcastWritten || operation.isDone()) return false;
            boolean cancelled = operation.cancel(false); if (cancelled) queuedCancellations.incrementAndGet(); return cancelled;
        }
        public long createStartLimiter(int rate) { return 1; }
        public void setStartRate(long limiter, int rate) {
            synchronized (startLimiter) {
                if (this.rate != rate && lastNativeStart != 0) nextNativeStart = lastNativeStart + (TimeUnit.SECONDS.toNanos(1) + rate - 1) / rate;
                this.rate = rate; startLimiter.notifyAll();
            }
        }
        public void resetStartSchedule(long limiter) { synchronized (startLimiter) { nextNativeStart = Math.max(nextNativeStart, System.nanoTime()); startLimiter.notifyAll(); } }
        public void destroyStartLimiter(long limiter) { synchronized (startLimiter) { limiterClosed = true; startLimiter.notifyAll(); } }
        public long create(long limiter) {
            assertEquals(1, limiter); long id = serial.incrementAndGet(); Gate gate = new Gate();
            synchronized (startLimiter) {
                if (heldStartsReleased) gate.startReady.countDown();
                gates.put(id, gate);
            }
            return id;
        }
        public long startedAtNanos(long handle) { Gate gate = gates.get(handle); return gate == null ? 0 : gate.startedAt; }
        public void cancel(long handle) {
            Gate gate = gates.get(handle); assertNotNull("Cancelled freed handle", gate);
            gate.cancelled = true; cancellations.incrementAndGet(); gate.ready.countDown();
            // Cancelling one capture must not acknowledge TCP starts for its
            // neighbours while the engine is still cancelling those handles.
            gate.startReady.countDown();
            synchronized (startLimiter) { startLimiter.notifyAll(); }
        }
        void releaseHeldStarts() {
            synchronized (startLimiter) {
                heldStartsReleased = true;
                for (Gate gate : gates.values()) gate.startReady.countDown();
            }
        }
        public void destroy(long handle) { assertNotNull("Destroyed handle twice", gates.remove(handle)); destroyed.incrementAndGet(); }
        public JSONObject capture(JSONObject context, long handle) throws Exception {
            Gate gate = gates.get(handle); assertNotNull(gate);
            String preStartFailure = preStartFailures.get(handle);
            if (preStartFailure != null) {
                assertTrue("Fixture pre-TCP failure was not released", gate.ready.await(8, TimeUnit.SECONDS));
                throw new IllegalStateException(gate.cancelled ? "CLAIM_CANCELLED" : preStartFailure);
            }
            if (holdStart) { startWaiting = true; assertTrue(gate.startReady.await(8, TimeUnit.SECONDS)); }
            synchronized (startLimiter) {
                if (startWaiters.isEmpty()) nextNativeStart = Math.max(nextNativeStart, System.nanoTime());
                startWaiters.addLast(handle);
                try {
                    while (true) {
                        if (gate.cancelled || limiterClosed) throw new IllegalStateException("CLAIM_CANCELLED");
                        if (startWaiters.peekFirst() != handle) { startLimiter.wait(); continue; }
                        long now = System.nanoTime();
                        while (!recentNativeStarts.isEmpty() && now - recentNativeStarts.peekFirst() >= TimeUnit.SECONDS.toNanos(1)) recentNativeStarts.removeFirst();
                        long remaining = nextNativeStart - now;
                        if (recentNativeStarts.size() >= rate) remaining = Math.max(remaining, recentNativeStarts.peekFirst() + TimeUnit.SECONDS.toNanos(1) - now);
                        if (remaining <= 0) break;
                        TimeUnit.NANOSECONDS.timedWait(startLimiter, remaining);
                    }
                    long started = System.nanoTime();
                    gate.startedAt = started + clockOffsetNanos.get();
                    long interval = (TimeUnit.SECONDS.toNanos(1) + rate - 1) / rate;
                    nextNativeStart += interval;
                    nextNativeStart = Math.max(nextNativeStart, System.nanoTime() - TimeUnit.SECONDS.toNanos(1));
                    lastNativeStart = started;
                    recentNativeStarts.addLast(started);
                    starts.add(started); startedHandles.add(handle);
                } finally {
                    startWaiters.remove(handle); startLimiter.notifyAll();
                }
            }
            int count = active.incrementAndGet(); peak.accumulateAndGet(count, Math::max);
            try {
                assertTrue("Fixture capture was not released", gate.ready.await(8, TimeUnit.SECONDS));
                if (gate.cancelled) throw new IllegalStateException("CLAIM_CANCELLED");
                boolean valid = hit || validMiss;
                return new JSONObject().put("captured", valid).put("validationPassed", valid).put("validProof", valid).put("meetsTarget", hit).put("proof", valid ? "fixture-proof" : "").put("durationMs", 200);
            } finally { active.decrementAndGet(); }
        }
        void finish(long handle) { Gate gate = gates.get(handle); if (gate != null) gate.ready.countDown(); }
        public void validateReward(String address) { if (!address.equals("fixture")) throw new AssertionError(); }
        public long fee() { return 10; }
        public JSONObject prepare(JSONObject row, String parent, String reward) throws Exception { prepared.incrementAndGet(); return new JSONObject().put("challenge", "fixture").put("vout", row.getInt("vout")); }
        public JSONObject attach(JSONObject prepared, String proof) throws Exception {
            lastWinnerVout = prepared.getInt("vout");
            if (holdAttach) { attachWaiting = true; assertTrue(attachGate.await(8, TimeUnit.SECONDS)); }
            return new JSONObject().put("txid", CLAIM).put("hex", "fixture-signed");
        }
        public void close() throws Exception { engine.close(); attachGate.countDown(); releaseHeldStarts(); until(() -> gates.isEmpty()); }
    }

    @Test public void defaultsAre100AndBothLimitsValidateBeforeChanging() throws Exception {
        try (Fixture f = new Fixture()) {
            assertEquals(100, f.engine.snapshot().getInt("connectionsPerSecondLimit")); assertEquals(100, f.engine.snapshot().getInt("concurrency"));
            for (int[] limits : new int[][]{{0, 1}, {101, 1}, {1, 0}, {1, 101}, {-1, 100}, {100, Integer.MAX_VALUE}}) {
                try { f.engine.configureLimits(limits[0], limits[1]); fail("Invalid limits accepted"); } catch (IllegalArgumentException expected) { assertEquals("CLAIMS_LIMITS", expected.getMessage()); }
                assertEquals(100, f.engine.snapshot().getInt("concurrency")); assertEquals(100, f.engine.snapshot().getInt("connectionsPerSecondLimit"));
            }
            f.engine.configureLimits(17, 9); assertEquals(17, f.engine.snapshot().getInt("connectionsPerSecondLimit")); assertEquals(9, f.engine.snapshot().getInt("concurrency"));
        }
    }
    @Test public void productionSchedulerActuallyRuns100CapturesAndStopCancelsEveryHandle() throws Exception {
        try (Fixture f = new Fixture()) {
            f.start(); until(() -> f.active.get() == 100);
            assertEquals(100, f.engine.snapshot().getInt("activeConnections")); assertEquals(100, f.peak.get()); assertEquals(1, f.parents.get()); assertEquals(1, f.prepared.get());
            assertTrue("Starts must be paced, not a 100-connection burst", f.starts.get(99) - f.starts.get(0) >= TimeUnit.MILLISECONDS.toNanos(900));
            assertPacedStarts(f.starts, 100);
            f.engine.stop(); until(() -> f.gates.isEmpty());
            assertEquals(100, f.cancellations.get()); assertEquals(100, f.destroyed.get()); assertEquals(0, f.broadcasts.get()); assertEquals(0, f.engine.snapshot().getInt("activeConnections"));
        }
    }
    @Test public void loweringConcurrencyDrainsAndRateChangeDoesNotReleaseABurst() throws Exception {
        try (Fixture f = new Fixture()) {
            f.engine.configureLimits(100, 5); f.start(); until(() -> f.active.get() == 5);
            f.engine.configureLimits(1, 2); int count = f.starts.size();
            Thread.sleep(100); assertEquals(count, f.starts.size()); assertEquals(0, f.cancellations.get());
            List<Long> first = new ArrayList<>(f.startedHandles);
            f.finish(first.get(0)); f.finish(first.get(1)); f.finish(first.get(2)); until(() -> f.active.get() == 2);
            Thread.sleep(1100); assertEquals(count, f.starts.size());
            f.finish(first.get(3)); until(() -> f.starts.size() == count + 1);
            Thread.sleep(100); assertEquals(count + 1, f.starts.size()); assertEquals(2, f.active.get());
        }
    }
    @Test public void slowDiscoveryDoesNotBlockPreparedAttemptsAndStopCancelsItsFuture() throws Exception {
        try (Fixture f = new Fixture()) {
            f.start(); until(() -> f.active.get() >= 4); f.holdDiscovery = true; f.refresh();
            until(() -> f.discoveryWaiting); int whileWaiting = f.starts.size();
            until(() -> f.starts.size() >= whileWaiting + 10);
            assertFalse(f.pendingDiscovery.isDone()); assertEquals(1, f.parents.get());
            f.engine.stop(); until(() -> f.gates.isEmpty()); assertTrue(f.pendingDiscovery.isCancelled());
        }
    }
    @Test public void readTimeoutAndExpiredCatalogNeverCancelAnAlreadyTransmittingClaim() throws Exception {
        try (Fixture f = new Fixture()) {
            f.rows.put(bounty(1)); f.engine.configureLimits(100, 1); f.hit = true; f.broadcastResult = new CompletableFuture<>(); f.start();
            until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.broadcasts.get() == 1);
            until(() -> f.active.get() == 1); f.hit = false; f.validMiss = true;
            f.holdDiscovery = true; f.refresh(); until(() -> f.discoveryWaiting);
            java.lang.reflect.Constructor<MobileRpcClient.RpcFailure> constructor = MobileRpcClient.RpcFailure.class.getDeclaredConstructor(String.class, boolean.class, Integer.class, long.class, boolean.class);
            constructor.setAccessible(true);
            f.pendingDiscovery.completeExceptionally(constructor.newInstance("RPC_TIMEOUT", false, null, 0L, false));
            until(() -> "RPC_TIMEOUT".equals(f.engine.snapshot().optString("lastError")));
            assertFalse("Maintenance timeout cannot cancel a financial transmission", f.broadcastResult.isDone());
            assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(0, f.cancellations.get()); assertEquals(1, f.active.get());
            f.clockOffsetNanos.addAndGet(TimeUnit.SECONDS.toNanos(61)); until(() -> f.gates.isEmpty());
            assertFalse("Even stale-catalog suspension owns only proof handles", f.broadcastResult.isDone());
            assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(1, f.cancellations.get());
            int previousStarts = f.starts.size(); Thread.sleep(40); assertEquals(previousStarts, f.starts.size());
            f.broadcastResult.complete(new JSONObject().put("txid", CLAIM)); until(() -> f.engine.snapshot().optLong("submitted") == 1);
            assertEquals(List.of(CLAIM + ":pending", CLAIM + ":submitted"), f.receipts); assertEquals(0, f.engine.snapshot().getLong("unknown"));
            f.holdDiscovery = false; f.clockOffsetNanos.addAndGet(TimeUnit.SECONDS.toNanos(6)); until(() -> f.active.get() == 1);
            assertTrue(f.engine.snapshot().isNull("lastRpcError")); assertEquals(1, f.broadcasts.get());
        }
    }
    @Test public void cursorProtocolAndMalformedMaintenanceFailuresPreserveTransmittingReceipt() throws Exception {
        for (String code : List.of("-32011", "RPC_PROTOCOL", "CLAIMS_WRONG_NETWORK")) {
            try (Fixture f = new Fixture()) {
                f.rows.put(bounty(1)); f.engine.configureLimits(100, 1); f.hit = true; f.broadcastResult = new CompletableFuture<>(); f.start();
                until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.broadcasts.get() == 1);
                until(() -> f.active.get() == 1); f.hit = false; f.holdDiscovery = true; f.refresh(); until(() -> f.discoveryWaiting);
                if (code.equals("CLAIMS_WRONG_NETWORK")) f.pendingDiscovery.complete(new JSONObject().put("tip", tip().put("chain", "testnet4")));
                else {
                    java.lang.reflect.Constructor<MobileRpcClient.RpcFailure> constructor = MobileRpcClient.RpcFailure.class.getDeclaredConstructor(String.class, boolean.class, Integer.class, long.class, boolean.class);
                    constructor.setAccessible(true); f.pendingDiscovery.completeExceptionally(constructor.newInstance(code, false, null, 0L, false));
                }
                until(() -> code.equals(f.engine.snapshot().optString("lastError"))); until(() -> f.gates.isEmpty());
                assertFalse("Only explicit lifecycle shutdown owns financial cancellation", f.broadcastResult.isDone());
                assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(1, f.cancellations.get());
                f.broadcastResult.complete(new JSONObject().put("txid", CLAIM)); until(() -> f.engine.snapshot().optLong("submitted") == 1);
                assertEquals(List.of(CLAIM + ":pending", CLAIM + ":submitted"), f.receipts); assertEquals(0, f.engine.snapshot().getLong("unknown"));
                assertEquals(1, f.broadcasts.get());
                if (code.equals("CLAIMS_WRONG_NETWORK")) assertFalse(f.engine.snapshot().getBoolean("enabled"));
            }
        }
    }
    @Test public void concurrentHitsForOneOutpointHaveOnlyOneWinnerAndCancelSiblings() throws Exception {
        try (Fixture f = new Fixture()) {
            f.engine.configureLimits(100, 10); f.hit = true; f.start(); until(() -> f.active.get() == 10);
            for (long handle : new ArrayList<>(f.startedHandles)) f.finish(handle);
            until(() -> f.broadcasts.get() == 1); until(() -> f.gates.isEmpty());
            Thread.sleep(150); assertEquals(1, f.broadcasts.get());
            assertEquals(List.of(CLAIM + ":pending", CLAIM + ":submitted"), f.receipts);
        }
    }
    @Test public void financialSubmissionsSerializeAcrossOutputsAndUnknownStopsTheQueue() throws Exception {
        try (Fixture f = new Fixture()) {
            f.rows.put(bounty(1)); f.engine.configureLimits(100, 1); f.hit = true; f.broadcastResult = new CompletableFuture<>(); f.start();
            until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.broadcasts.get() == 1);
            until(() -> f.starts.size() == 2); f.finish(f.startedHandles.get(1)); until(() -> f.gates.isEmpty());
            Thread.sleep(100); assertEquals(1, f.broadcasts.get()); assertEquals(List.of(CLAIM + ":pending"), f.receipts);
            f.broadcastResult.completeExceptionally(new IOException("fixture transport outcome unknown"));
            until(() -> f.engine.snapshot().optBoolean("enabled") == false);
            assertEquals("unknown-outcome", f.engine.snapshot().getString("status"));
            Thread.sleep(100); assertEquals(1, f.broadcasts.get()); assertEquals(List.of(CLAIM + ":pending", CLAIM + ":unknown"), f.receipts);
        }
    }
    @Test public void localQuotaQueueKeepsSingleWinnerAndOtherCapturesRunningUntilOneCompletion() throws Exception {
        try (Fixture f = new Fixture()) {
            f.rows.put(bounty(1)); f.engine.configureLimits(100, 1); f.hit = true; f.queueBroadcast(); f.start();
            until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.broadcasts.get() == 1);
            f.hit = false; until(() -> f.starts.size() == 2);
            for (int index = 1; index < 4; index++) { f.finish(f.startedHandles.get(index)); int expected = index + 2; until(() -> f.starts.size() == expected); }
            assertFalse(f.broadcastResult.isDone()); assertEquals(1, f.broadcasts.get()); assertEquals(0, f.queuedCancellations.get());
            assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(0, f.engine.snapshot().getLong("submitted"));
            assertTrue(f.engine.snapshot().isNull("lastRpcError")); assertEquals(List.of(CLAIM + ":pending"), f.receipts);
            f.broadcastWritten = true; f.broadcastResult.complete(new JSONObject().put("txid", CLAIM)); until(() -> f.engine.snapshot().optLong("submitted") == 1);
            assertEquals(1, f.broadcasts.get()); assertEquals(List.of(CLAIM + ":pending", CLAIM + ":submitted"), f.receipts);
        }
    }
    @Test public void stopWhileQuotaQueuedRecordsNotSentAndAllowsTheOutpointAgain() throws Exception {
        try (Fixture f = new Fixture()) {
            f.engine.configureLimits(100, 1); f.hit = true; f.queueBroadcast(); f.start();
            until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.broadcasts.get() == 1);
            f.engine.stop(); until(() -> f.receipts.contains(CLAIM + ":not-sent")); until(() -> f.engine.snapshot().optInt("eligible") == 1);
            assertEquals(List.of(CLAIM + ":pending", CLAIM + ":not-sent"), f.receipts); assertEquals("stopped", f.engine.snapshot().getString("status"));
            assertEquals("", f.engine.snapshot().getString("lastError")); assertEquals(0, f.engine.snapshot().getLong("unknown"));
            f.hit = false; f.validMiss = true; f.start(); until(() -> f.starts.size() == 2);
            assertEquals(1, f.broadcasts.get()); assertTrue(f.engine.snapshot().isNull("lastRpcError"));
        }
    }
    @Test public void stopAfterQuotaReleasedAndWriteStartedStillRecordsUnknown() throws Exception {
        try (Fixture f = new Fixture()) {
            f.engine.configureLimits(100, 1); f.hit = true; f.queueBroadcast(); f.start();
            until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.broadcasts.get() == 1);
            f.broadcastWritten = true; f.engine.stop(); until(() -> f.engine.snapshot().optLong("unknown") == 1);
            assertEquals(List.of(CLAIM + ":pending", CLAIM + ":unknown"), f.receipts); assertEquals("unknown-outcome", f.engine.snapshot().getString("status"));
            assertEquals(1, f.broadcasts.get()); assertEquals(0, f.queuedCancellations.get());
        }
    }
    @Test public void staleCatalogCancelsOnlyQuotaQueuedClaimAndKeepsItNotSent() throws Exception {
        try (Fixture f = new Fixture()) {
            f.rows.put(bounty(1)); f.engine.configureLimits(100, 1); f.hit = true; f.queueBroadcast(); f.start();
            until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.broadcasts.get() == 1);
            f.hit = false; f.holdDiscovery = true; f.refresh(); until(() -> f.discoveryWaiting);
            f.clockOffsetNanos.addAndGet(TimeUnit.SECONDS.toNanos(61)); until(() -> f.receipts.contains(CLAIM + ":not-sent")); until(() -> f.gates.isEmpty());
            assertEquals(1, f.queuedCancellations.get()); assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(0, f.engine.snapshot().getLong("submitted"));
            assertEquals(List.of(CLAIM + ":pending", CLAIM + ":not-sent"), f.receipts); assertEquals(1, f.broadcasts.get());
            until(() -> f.engine.snapshot().optInt("eligible") == 2);
        }
    }
    @Test public void spentOrExitedOutpointCancelsOnlyUnwrittenQuotaJobDuringAtomicReplay() throws Exception {
        for (String event : List.of("spent", "window_exit")) try (Fixture f = new Fixture()) {
            f.rows.put(bounty(1)); f.engine.configureLimits(100, 1); f.hit = true; f.queueBroadcast(); f.start();
            until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.broadcasts.get() == 1); f.hit = false;
            JSONObject change = new JSONObject().put("sequence", 1).put("type", event).put("txid", TXID).put("vout", f.lastWinnerVout).put("spending_txid", CLAIM);
            f.changeEvents = new JSONArray().put(change); f.refresh(); until(() -> f.receipts.contains(CLAIM + ":not-sent"));
            assertEquals(1, f.queuedCancellations.get()); assertEquals(0, f.engine.snapshot().getLong("unknown")); assertEquals(1, f.broadcasts.get());
            assertEquals(1, f.engine.snapshot().getInt("eligible"));
        }
    }
    @Test public void invalidCatalogCancelsUnwrittenClaimButReceiptFailureRemainsConservative() throws Exception {
        for (boolean receiptFailure : new boolean[]{false, true}) try (Fixture f = new Fixture()) {
            f.engine.configureLimits(100, 1); f.hit = true; f.queueBroadcast(); f.start();
            until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.broadcasts.get() == 1);
            f.failNotSentReceipt = receiptFailure; f.holdDiscovery = true; f.refresh(); until(() -> f.discoveryWaiting);
            f.pendingDiscovery.complete(new JSONObject().put("tip", tip().put("chain", "testnet4")));
            until(() -> f.receipts.contains(CLAIM + (receiptFailure ? ":unknown" : ":not-sent")));
            assertEquals(1, f.queuedCancellations.get()); assertEquals(1, f.broadcasts.get());
            assertEquals(receiptFailure ? 1 : 0, f.engine.snapshot().getLong("unknown"));
            assertEquals(receiptFailure ? "unknown-outcome" : "error", f.engine.snapshot().getString("status"));
        }
    }
    @Test public void catalogClonesSharePreparedTransactionAndCaptureBudget() throws Exception {
        MobileClaimsEngine.Candidate first = new MobileClaimsEngine.Candidate(bounty(0), GENESIS, 10), second = first.copy();
        first.progress.prepared = new JSONObject().put("challenge", "shared"); first.progress.captures = java.math.BigInteger.valueOf(3);
        assertSame(first.progress.prepared, second.progress.prepared); assertFalse(second.budget());
        second.progress.captures = java.math.BigInteger.ONE; assertTrue(first.budget());
    }
    @Test public void pauseBeforeTransmissionReleasesQueuedWinnersForTheSameSession() throws Exception {
        try (Fixture f = new Fixture()) {
            f.rows.put(bounty(1)); f.engine.configureLimits(100, 1); f.hit = true; f.holdAttach = true; f.start();
            until(() -> f.starts.size() == 1); f.finish(f.startedHandles.get(0)); until(() -> f.attachWaiting);
            until(() -> f.starts.size() == 2); f.finish(f.startedHandles.get(1)); until(() -> f.gates.isEmpty());
            assertEquals(0, f.engine.snapshot().getInt("eligible"));
            f.engine.setAllowed(false); f.holdAttach = false; f.attachGate.countDown();
            until(() -> f.engine.snapshot().optInt("eligible") == 2);
            assertTrue(f.engine.snapshot().getBoolean("enabled")); assertEquals(0, f.broadcasts.get()); assertTrue(f.receipts.isEmpty());
            f.engine.setAllowed(true); until(() -> f.starts.size() == 3);
        }
    }
    @Test public void delayedTcpAcknowledgementsDoNotBlockBoundedParallelAdmissionOrBurstOnRelease() throws Exception {
        try (Fixture f = new Fixture()) {
            f.engine.configureLimits(100, 10); f.holdStart = true; f.start(); until(() -> f.gates.size() == 10);
            Thread.sleep(100); assertEquals(10, f.gates.size()); assertEquals(0, f.engine.snapshot().getLong("attempts"));
            assertEquals(0, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
            f.releaseHeldStarts(); until(() -> f.starts.size() == 10);
            assertEquals(10, f.engine.snapshot().getLong("attempts"));
            assertEquals(1, f.engine.snapshot().getDouble("connectionsPerSecond"), 0);
            assertPacedStarts(f.starts, 100);
        }
        try (Fixture f = new Fixture()) {
            f.engine.configureLimits(100, 10); f.holdStart = true; f.start(); until(() -> f.gates.size() == 10); f.engine.stop(); until(() -> f.gates.isEmpty());
            assertTrue("Stopping unacknowledged captures must not release any TCP start", f.starts.isEmpty());
            assertEquals(10, f.cancellations.get()); assertEquals(10, f.destroyed.get());
            assertEquals(0, f.engine.snapshot().getLong("attempts")); assertEquals(0, f.broadcasts.get());
        }
    }
    @Test public void localPreTcpFailuresBeforeOrAfterAnInflightSuccessDoNotPauseThePolicy() throws Exception {
        for (String code : new String[]{"CLAIM_TIMEOUT", "CLAIM_BUSY", "CLAIM_CONTEXT"}) for (boolean failureFirst : new boolean[]{true, false}) {
            try (Fixture f = new Fixture()) {
                f.rows = new JSONArray().put(bounty(0).put("connection_work_target", "0000" + "ff".repeat(30)));
                f.preStartFailures.put(1L, code); f.validMiss = true; f.engine.configureLimits(100, 2); f.start();
                until(() -> f.gates.size() == 2 && f.starts.size() == 1);
                f.finish(failureFirst ? 1 : 2);
                until(() -> f.starts.size() == 2);
                f.finish(failureFirst ? 2 : 1);
                until(() -> f.starts.size() == 3 && f.active.get() == 2);
                JSONObject state = f.engine.snapshot();
                assertEquals(0, f.clockOffsetNanos.get());
                assertEquals(3, state.getLong("attempts")); assertEquals(1, state.getLong("valid"));
                assertEquals(0, state.getLong("invalid")); assertEquals(0, state.getLong("targetHits"));
                assertTrue(state.getBoolean("allowed")); assertEquals(2, state.getInt("activeConnections"));
                assertPacedStarts(f.starts, 100);
                f.engine.stop(); until(() -> f.gates.isEmpty());
                assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(0, f.engine.snapshot().getLong("invalid"));
                assertEquals(2, f.engine.snapshot().getLong("cancelled"));
            }
        }
    }
    @Test public void dnsKeepsItsTwoSecondCooldownEvenWhenOtherPreTcpFailuresAndSuccessArriveLater() throws Exception {
        for (String code : new String[]{"CLAIM_TIMEOUT", "CLAIM_BUSY", "CLAIM_CONTEXT"}) {
            try (Fixture f = new Fixture()) {
                f.rows = new JSONArray().put(bounty(0).put("connection_work_target", "0000" + "ff".repeat(30)));
                f.preStartFailures.put(1L, "CLAIM_DNS"); f.preStartFailures.put(2L, code);
                f.validMiss = true; f.engine.configureLimits(100, 3); f.start();
                until(() -> f.gates.size() == 3 && f.starts.size() == 1);
                f.finish(1); until(() -> "CLAIM_DNS".equals(f.engine.snapshot().optString("lastError")));
                Field domains = MobileClaimsEngine.class.getDeclaredField("domains"); domains.setAccessible(true);
                final long cooldown;
                synchronized (f.engine) { cooldown = ((MobileClaimsEngine.Ema)((Map<?, ?>)domains.get(f.engine)).get("example.com:7")).retryAfter; }
                f.finish(2); until(() -> f.gates.size() == 1); f.finish(3); until(() -> f.gates.isEmpty());
                assertEquals(1, f.engine.snapshot().getLong("valid")); assertEquals(0, f.engine.snapshot().getLong("invalid"));
                synchronized (f.engine) { assertEquals("Local failures must neither extend nor clear the DNS delay", cooldown, ((MobileClaimsEngine.Ema)((Map<?, ?>)domains.get(f.engine)).get("example.com:7")).retryAfter); }
                f.clockOffsetNanos.addAndGet(TimeUnit.SECONDS.toNanos(1)); Thread.sleep(30);
                assertEquals(1, f.starts.size());
                f.clockOffsetNanos.addAndGet(TimeUnit.SECONDS.toNanos(1)); until(() -> f.active.get() == 3);
                assertEquals("Only the existing two-second DNS delay remains", 4, f.starts.size());
                assertEquals(4, f.engine.snapshot().getLong("attempts"));
            }
        }
    }
}
