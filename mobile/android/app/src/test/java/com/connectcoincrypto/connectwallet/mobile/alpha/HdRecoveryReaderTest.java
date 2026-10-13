package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentChecks;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class HdRecoveryReaderTest {
    static MobileRpcClient.RpcFailure failure(String code, long delay) throws Exception {
        java.lang.reflect.Constructor<MobileRpcClient.RpcFailure> factory = MobileRpcClient.RpcFailure.class.getDeclaredConstructor(
            String.class, boolean.class, Integer.class, long.class, boolean.class);
        factory.setAccessible(true); return factory.newInstance(code, false, null, delay, false);
    }
    static final class Manual implements HdRecoveryReader.Scheduler {
        static final class Alarm {
            final long at; final Runnable action; boolean cancelled;
            Alarm(long at, Runnable action) { this.at = at; this.action = action; }
        }
        long now; final ArrayDeque<Runnable> immediate = new ArrayDeque<>(); final List<Alarm> alarms = new ArrayList<>();
        public void execute(Runnable action) { immediate.add(action); }
        public HdRecoveryReader.Cancel after(long ms, Runnable action) {
            Alarm alarm = new Alarm(now + ms, action); alarms.add(alarm); return () -> alarm.cancelled = true;
        }
        void drain() { int guard = 0; while (!immediate.isEmpty()) { assertTrue("No busy loop", ++guard < 1000); immediate.remove().run(); } }
        void advance(long ms) {
            now += ms;
            for (Alarm alarm : new ArrayList<>(alarms)) if (!alarm.cancelled && alarm.at <= now) {
                alarm.cancelled = true; execute(alarm.action);
            }
            drain();
        }
        long pendingAlarms() { return alarms.stream().filter(alarm -> !alarm.cancelled).count(); }
        public void close() { for (Alarm alarm : alarms) alarm.cancelled = true; }
    }
    private static JSONObject params() throws Exception { return new JSONObject().put("address", "native-0-0"); }
    private static JSONObject tip() throws Exception {
        return new JSONObject().put("chain", "main").put("genesis_hash", NativePaymentChecks.GENESIS)
            .put("height", 123).put("hash", "aa".repeat(32)).put("mediantime", 1800000000);
    }
    private static JSONObject history() throws Exception {
        return new JSONObject().put("address", "native-0-0").put("tip", tip()).put("unit", "connects")
            .put("live", true).put("items", new JSONArray()).put("next_cursor", JSONObject.NULL);
    }
    private static JSONObject checkpoint() throws Exception {
        return new JSONObject().put("tip", tip()).put("unit", "connects").put("changes", new JSONArray())
            .put("next_cursor", "original.checkpoint").put("has_more", false).put("through_sequence", 7).put("journal_epoch", 1);
    }
    private static CompletableFuture<JSONObject> failed(Throwable error) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>(); result.completeExceptionally(error); return result;
    }
    @Test public void offlineCheckpointWaitsWithoutRequestsTimersOrAttemptsUntilValidatedRuntimeWake() throws Exception {
        Manual clock = new Manual(); AtomicBoolean active = new AtomicBoolean(); AtomicInteger calls = new AtomicInteger();
        List<String> states = new ArrayList<>();
        try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> {
            calls.incrementAndGet(); return CompletableFuture.completedFuture(checkpoint());
        }, () -> {}, active::get, (state, delay, attempt, code) -> { states.add(state); assertEquals(0, attempt); }, clock, () -> clock.now, () -> 0)) {
            CompletableFuture<JSONObject> checkpoint = reader.read("getaddresschanges", new JSONObject().put("addresses", new JSONArray().put("native-0-0"))); clock.drain();
            assertEquals(List.of("waiting-network"), states); assertFalse(checkpoint.isDone()); assertEquals(0, calls.get());
            clock.advance(600000); reader.wake(); clock.drain(); assertEquals(0, calls.get()); assertEquals(0, clock.pendingAlarms());
            active.set(true); reader.wake(); clock.drain(); assertTrue(checkpoint.isDone()); assertEquals(1, calls.get());
            assertEquals(List.of("waiting-network", "scanning"), states);
        }
        clock.drain();
    }
    @Test public void sixteenFailuresShareOneProbeAndKeepOriginalLogicalFutures() throws Exception {
        Manual clock = new Manual(); List<CompletableFuture<JSONObject>> actual = new ArrayList<>(), logical = new ArrayList<>();
        try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> {
            CompletableFuture<JSONObject> future = new CompletableFuture<>(); actual.add(future); return future;
        }, () -> {}, () -> true, (state, delay, attempt, code) -> {}, clock, () -> clock.now, () -> 0)) {
            for (int i = 0; i < 16; i++) logical.add(reader.read("getaddresshistory", params())); clock.drain(); assertEquals(16, actual.size());
            for (CompletableFuture<JSONObject> future : new ArrayList<>(actual)) future.completeExceptionally(failure("RPC_UNAVAILABLE", 0));
            clock.drain(); assertEquals(1, clock.pendingAlarms()); assertTrue(logical.stream().noneMatch(CompletableFuture::isDone));
            clock.advance(999); assertEquals(16, actual.size()); clock.advance(1); assertEquals(17, actual.size());
            // No sibling read retries until this single probe succeeds.
            clock.advance(60000); assertEquals(17, actual.size());
            actual.get(16).complete(history()); clock.drain(); assertEquals(32, actual.size());
            assertEquals(1, logical.stream().filter(CompletableFuture::isDone).count());
            for (int i = 17; i < 32; i++) actual.get(i).complete(history()); clock.drain();
            assertTrue(logical.stream().allMatch(CompletableFuture::isDone));
        }
        clock.drain();
    }
    @Test public void boundedProbeRoundsUseExponentialBackoffAndRequireExplicitRetryAfterExhaustion() throws Exception {
        Manual clock = new Manual(); AtomicInteger calls = new AtomicInteger();
        try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> {
            calls.incrementAndGet(); return failed(failure("RPC_TIMEOUT", 0));
        }, () -> {}, () -> true, (state, delay, attempt, code) -> {}, clock, () -> clock.now, () -> 0)) {
            CompletableFuture<JSONObject> logical = reader.read("getaddresshistory", params()); clock.drain();
            for (long delay : new long[]{1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000}) {
                int previous = calls.get(); clock.advance(delay - 1); assertEquals(previous, calls.get()); clock.advance(1);
                assertEquals(previous + 1, calls.get());
            }
            assertEquals(9, calls.get()); assertTrue(logical.isCompletedExceptionally());
            assertTrue(assertThrows(java.util.concurrent.CompletionException.class, logical::join).getCause() instanceof HdRecoveryReader.RetryExhausted);
            clock.advance(600000); reader.wake(); clock.drain(); assertEquals(9, calls.get()); assertEquals(0, clock.pendingAlarms());
        }
        clock.drain();
    }
    @Test public void offlineTimeConsumesNoRetryBudgetAndResumeHonorsRemainingCooldown() throws Exception {
        Manual clock = new Manual(); AtomicBoolean active = new AtomicBoolean(true); AtomicInteger calls = new AtomicInteger();
        List<Integer> attempts = new ArrayList<>();
        try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> {
            return calls.incrementAndGet() == 1 ? failed(failure("-32029", 60000)) : CompletableFuture.completedFuture(history());
        }, () -> {}, active::get, (state, delay, attempt, code) -> attempts.add(attempt), clock, () -> clock.now, () -> 0)) {
            CompletableFuture<JSONObject> logical = reader.read("getaddresshistory", params()); clock.drain();
            active.set(false); reader.wake(); clock.drain(); clock.advance(30000); assertEquals(1, calls.get());
            assertTrue(attempts.stream().allMatch(attempt -> attempt == 0)); assertEquals(0, clock.pendingAlarms());
            active.set(true); reader.wake(); clock.drain(); clock.advance(29999); assertEquals(1, calls.get());
            clock.advance(1); assertEquals(2, calls.get()); assertTrue(logical.isDone());
        }
        clock.drain();
    }
    @Test public void transportQuotaWaitIsOnePendingAttemptAndNeverTriggersRetries() throws Exception {
        Manual clock = new Manual(); AtomicInteger calls = new AtomicInteger(); CompletableFuture<JSONObject> quota = new CompletableFuture<>();
        try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> { calls.incrementAndGet(); return quota; },
                () -> {}, () -> true, (state, delay, attempt, code) -> assertEquals(0, attempt), clock, () -> clock.now, () -> 0)) {
            CompletableFuture<JSONObject> logical = reader.read("getaddresshistory", params()); clock.drain(); clock.advance(600000);
            reader.wake(); clock.drain(); assertEquals(1, calls.get()); assertEquals(0, clock.pendingAlarms()); assertFalse(logical.isDone());
            quota.complete(history()); clock.drain(); assertTrue(logical.isDone());
        }
        clock.drain();
    }
    @Test public void ownerRevocationDuringNetworkWaitCancelsWithoutAnyReadOrResurrection() throws Exception {
        Manual clock = new Manual(); AtomicBoolean live = new AtomicBoolean(true), active = new AtomicBoolean(); AtomicInteger calls = new AtomicInteger();
        try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> { calls.incrementAndGet(); return new CompletableFuture<>(); },
                () -> { if (!live.get()) throw new IllegalStateException("Wallet changed"); }, active::get,
                (state, delay, attempt, code) -> {}, clock, () -> clock.now, () -> 0)) {
            CompletableFuture<JSONObject> logical = reader.read("getaddresshistory", params()); clock.drain();
            live.set(false); active.set(true); reader.wake(); clock.drain(); assertTrue(logical.isCompletedExceptionally());
            clock.advance(600000); reader.wake(); clock.drain(); assertEquals(0, calls.get());
        }
        clock.drain();
    }
    @Test public void networkCancellationOnlyRetriesForLiveOwnerAndExplicitNetworkReason() throws Exception {
        for (boolean network : new boolean[]{false, true}) {
            Manual clock = new Manual(); AtomicInteger calls = new AtomicInteger();
            try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> calls.incrementAndGet() == 1
                    ? failed(failure("RPC_CANCELLED", 0).recoveryHint(false, network)) : CompletableFuture.completedFuture(history()),
                    () -> {}, () -> true, (state, delay, attempt, code) -> {}, clock, () -> clock.now, () -> 0)) {
                CompletableFuture<JSONObject> logical = reader.read("getaddresshistory", params()); clock.drain(); clock.advance(1000);
                assertEquals(network ? 2 : 1, calls.get()); assertEquals(!network, logical.isCompletedExceptionally());
            }
            clock.drain();
        }
    }
    @Test public void closeCancelsTimerAndLogicalFutureWhileOffline() throws Exception {
        Manual clock = new Manual(); HdRecoveryReader reader = new HdRecoveryReader((method, params) -> { throw new AssertionError(); },
            () -> {}, () -> false, (state, delay, attempt, code) -> {}, clock, () -> clock.now, () -> 0);
        CompletableFuture<JSONObject> logical = reader.read("getaddresshistory", params()); clock.drain(); reader.close(); clock.drain();
        assertTrue(logical.isCompletedExceptionally()); reader.wake(); clock.advance(600000); assertEquals(0, clock.pendingAlarms());
    }
    @Test public void safeClassificationSeparatesTransientTransportFromMalformedProtocolAndStaleCursors() throws Exception {
        for (String code : new String[]{"RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "-32001", "-32030", "-32029"}) assertTrue(HdRecoveryReader.retryable(failure(code, 0)));
        for (String code : new String[]{"RPC_PROTOCOL", "RPC_INVALID", "RPC_CANCELLED", "RPC_INACTIVE", "-32011", "-32602"}) assertFalse(HdRecoveryReader.retryable(failure(code, 0)));
        assertTrue(HdRecoveryReader.retryable(failure("RPC_PROTOCOL", 0).recoveryHint(true, false)));
        assertTrue(HdRecoveryReader.retryable(failure("RPC_INACTIVE", 0).recoveryHint(false, true)));
        assertFalse(HdRecoveryReader.retryable(new IllegalArgumentException("untrusted")));
    }
    @Test public void malformedRetryProbeStopsTheWindowBeforeAnySiblingIsRetried() throws Exception {
        Manual clock = new Manual(); List<CompletableFuture<JSONObject>> actual = new ArrayList<>(), logical = new ArrayList<>();
        try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> {
            CompletableFuture<JSONObject> future = new CompletableFuture<>(); actual.add(future); return future;
        }, () -> {}, () -> true, (state, delay, attempt, code) -> {}, clock, () -> clock.now, () -> 0)) {
            for (int i = 0; i < 16; i++) logical.add(reader.read("getaddresshistory", params())); clock.drain();
            for (CompletableFuture<JSONObject> future : actual) future.completeExceptionally(failure("RPC_UNAVAILABLE", 0));
            clock.drain(); clock.advance(1000); assertEquals(17, actual.size());
            actual.get(16).complete(history().put("untrusted", "must not be exposed")); clock.drain();
            assertTrue(logical.stream().allMatch(CompletableFuture::isCompletedExceptionally));
            reader.wake(); clock.advance(600000); assertEquals(17, actual.size()); assertEquals(0, clock.pendingAlarms());
        }
        clock.drain();
    }
    @Test public void unsupportedCheckpointStillAllowsLegacyHistoryThroughTheRecoveryReader() throws Exception {
        Manual clock = new Manual();
        try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> method.equals("getaddresschanges")
                ? failed(failure("-32601", 0)) : CompletableFuture.completedFuture(history()),
                () -> {}, () -> true, (state, delay, attempt, code) -> {}, clock, () -> clock.now, () -> 0)) {
            CompletableFuture<JSONObject> checkpoint = reader.read("getaddresschanges", new JSONObject()); clock.drain();
            assertTrue(checkpoint.isCompletedExceptionally());
            CompletableFuture<JSONObject> history = reader.read("getaddresshistory", params()); clock.drain();
            assertTrue(history.isDone()); assertFalse(history.isCompletedExceptionally()); assertEquals(0, clock.pendingAlarms());
        }
        clock.drain();
    }
}
