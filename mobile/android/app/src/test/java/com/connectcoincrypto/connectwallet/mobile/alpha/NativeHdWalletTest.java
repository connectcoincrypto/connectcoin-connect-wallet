package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentChecks;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletVault;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class NativeHdWalletTest {
    private static final String WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    private static final char[] PASSWORD = "public-test-password-only".toCharArray();
    private static final NativeHdWallet.Check LIVE = () -> {};
    private static JSONObject account(int index, int branch) throws Exception {
        return new JSONObject().put("address", "native-" + branch + "-" + index).put("publicKey", "00".repeat(32))
            .put("path", "m/44'/0'/0'/" + branch + "/" + index).put("network", "main").put("index", index).put("change", branch);
    }
    private static JSONObject tip() throws Exception {
        return new JSONObject().put("chain", "main").put("genesis_hash", NativePaymentChecks.GENESIS).put("height", 123)
            .put("hash", "aa".repeat(32)).put("mediantime", 1800000000);
    }
    private static JSONObject page(String address, boolean used) throws Exception {
        JSONArray rows = new JSONArray();
        if (used) rows.put(new JSONObject().put("txid", "bb".repeat(32)).put("status", "confirmed").put("block_height", 121)
            .put("block_hash", "cc".repeat(32)).put("confirmations", 3).put("received", "0").put("spent", "100").put("balance_delta", "-100"));
        return new JSONObject().put("address", address).put("tip", tip()).put("unit", "connects").put("live", true).put("items", rows).put("next_cursor", JSONObject.NULL);
    }
    private static JSONObject checkpoint() throws Exception {
        return new JSONObject().put("tip", tip()).put("unit", "connects").put("changes", new JSONArray())
            .put("next_cursor", "original.checkpoint").put("has_more", false).put("through_sequence", 7).put("journal_epoch", 1);
    }
    private static final class Fixture implements AutoCloseable {
        final WalletVault.UpdateSession vault;
        final NativeHdWallet wallet;
        final List<JSONObject> writes = new ArrayList<>();
        boolean failWrite;
        Fixture() throws Exception { this(WalletVault.newPayload("Public fixture", WORDS, "")); }
        Fixture(JSONObject payload) throws Exception {
            vault = WalletVault.createForUpdate(payload, PASSWORD);
            wallet = new NativeHdWallet(NativeHdWalletTest::account, vault, (envelope, check) -> {
                check.check(); if (failWrite) throw new Exception("Synthetic write failure"); writes.add(new JSONObject(envelope.toString())); check.check();
            });
        }
        void recover(Set<String> used) throws Exception {
            recover((method, params) -> CompletableFuture.completedFuture(page(params.getString("address"), used.contains(params.getString("address")))), LIVE, ignored -> {});
        }
        void recover(NativeHdWallet.Reader reader, NativeHdWallet.Check check, NativeHdWallet.Progress progress) throws Exception {
            wallet.recover((method, params) -> "getaddresschanges".equals(method)
                ? CompletableFuture.completedFuture(checkpoint()) : reader.read(method, params), check, progress);
        }
        @Override public void close() { wallet.close(); }
    }
    @Test public void oldSingleAddressVaultRecoversBothGapsAndPreservesUnknownMetadata() throws Exception {
        try (Fixture fixture = new Fixture(WalletVault.newPayload("Fixture", WORDS, "").put("future", new JSONObject().put("keep", true)))) {
            assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete"));
            assertThrows(IllegalStateException.class, fixture.wallet::requireReady);
            fixture.recover(Set.of("native-0-0", "native-0-19", "native-1-3"));
            JSONObject state = fixture.wallet.snapshot(), hd = state.getJSONObject("hd");
            assertTrue(hd.getBoolean("complete")); assertFalse(hd.getBoolean("recovering")); assertEquals(64, hd.getInt("scanned"));
            assertEquals("native-0-20", fixture.wallet.account().getString("address"));
            assertEquals("native-1-4", fixture.wallet.changeAccount().getString("address"));
            assertEquals("native-0-0", state.getString("walletId")); assertEquals(64, fixture.wallet.accounts().length());
            assertNotNull(fixture.wallet.owned("native-0-39")); assertNotNull(fixture.wallet.owned("native-1-23"));
            assertEquals(19, hd.getInt("lastUsedReceive")); assertEquals(3, hd.getInt("lastUsedChange"));
            assertTrue(fixture.vault.payload().getJSONObject("future").getBoolean("keep"));
            assertTrue(fixture.vault.payload().getBoolean("mobileHdRecovered")); assertFalse(fixture.vault.payload().getBoolean("needsRecovery"));
            assertFalse(state.toString().contains("mnemonic")); assertFalse(state.toString().contains("abandon")); fixture.wallet.requireReady();
        }
    }
    @Test(timeout = 15000) public void startsSixteenHistoryReadsAndRefillsWithoutWaitingForTheOtherFifteen() throws Exception {
        try (Fixture fixture = new Fixture()) {
            List<CompletableFuture<JSONObject>> waiting = new ArrayList<>(); List<String> addresses = new ArrayList<>();
            AtomicInteger calls = new AtomicInteger(), active = new AtomicInteger(), peak = new AtomicInteger();
            fixture.recover((method, params) -> {
                int call = calls.incrementAndGet(); String address = params.getString("address");
                if (call <= 17) {
                    CompletableFuture<JSONObject> future = new CompletableFuture<>(); waiting.add(future); addresses.add(address);
                    peak.accumulateAndGet(active.incrementAndGet(), Math::max);
                    future.whenComplete((result, failure) -> active.decrementAndGet());
                    assertTrue(active.get() <= 16);
                    if (call == 16) {
                        assertEquals(16, active.get());
                        waiting.get(0).complete(page(addresses.get(0), false));
                    }
                    if (call == 17) {
                        assertEquals("native-0-8", address);
                        for (int i = 1; i < 16; i++) assertFalse("An unrelated request is still pending", waiting.get(i).isDone());
                        // The next address starts immediately after just one slot opens, not after a batch barrier.
                        for (int i = 16; i >= 1; i--) waiting.get(i).complete(page(addresses.get(i), false));
                    }
                    return future;
                }
                return CompletableFuture.completedFuture(page(address, false));
            }, LIVE, ignored -> {});
            assertEquals(16, peak.get()); assertEquals(0, active.get());
            assertEquals(40, calls.get()); assertEquals(40, fixture.wallet.accounts().length());
        }
    }
    @Test(timeout = 15000) public void slowReceivingReadDoesNotBlockSubsequentChangeAddresses() throws Exception {
        try (Fixture fixture = new Fixture()) {
            CompletableFuture<JSONObject> receiving = new CompletableFuture<>(); AtomicInteger changeReads = new AtomicInteger();
            fixture.recover((method, params) -> {
                String address = params.getString("address");
                if (address.equals("native-0-0")) return receiving;
                if (address.startsWith("native-1-")) {
                    int count = changeReads.incrementAndGet();
                    if (count <= 10) assertFalse(receiving.isDone());
                    if (count == 11) receiving.complete(page("native-0-0", false));
                }
                return CompletableFuture.completedFuture(page(address, false));
            }, LIVE, ignored -> {});
            assertEquals(20, changeReads.get()); fixture.wallet.requireReady();
        }
    }
    @Test(timeout = 15000) public void outOfOrderUnusedResultsCannotHideAnEarlierUsedAddress() throws Exception {
        try (Fixture fixture = new Fixture()) {
            CompletableFuture<JSONObject> earlierUsed = new CompletableFuture<>();
            Set<String> requested = new HashSet<>(); AtomicInteger laterUnused = new AtomicInteger();
            fixture.recover((method, params) -> {
                String address = params.getString("address"); assertTrue(requested.add(address));
                if (address.equals("native-0-7")) return earlierUsed;
                if (address.startsWith("native-0-")) {
                    int index = Integer.parseInt(address.substring("native-0-".length()));
                    if (!earlierUsed.isDone() && index > 7) { laterUnused.incrementAndGet(); assertTrue(index <= 14); }
                }
                if (address.equals("native-1-19")) {
                    assertFalse(earlierUsed.isDone()); assertTrue(laterUnused.get() > 0);
                    assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete"));
                    earlierUsed.complete(page("native-0-7", true));
                }
                return CompletableFuture.completedFuture(page(address, false));
            }, LIVE, ignored -> {});
            JSONObject hd = fixture.wallet.snapshot().getJSONObject("hd");
            assertEquals(7, hd.getInt("lastUsedReceive")); assertEquals(8, hd.getInt("receiveIndex"));
            assertEquals(48, hd.getInt("scanned")); assertEquals(48, requested.size());
            assertTrue(requested.contains("native-0-27")); assertFalse(requested.contains("native-0-28"));
            assertFalse(requested.contains("native-1-20")); fixture.wallet.requireReady();
        }
    }
    @Test public void emptyContinuationDoesNotCountAsUnusedAndSpentDownHistoryCounts() throws Exception {
        try (Fixture fixture = new Fixture()) {
            AtomicInteger pages = new AtomicInteger();
            fixture.recover((method, params) -> {
                pages.incrementAndGet(); String address = params.getString("address");
                JSONObject result = page(address, address.equals("native-0-0") && params.has("cursor"));
                if (address.equals("native-0-0") && !params.has("cursor")) result.put("next_cursor", "empty.continuation");
                return CompletableFuture.completedFuture(result);
            }, LIVE, ignored -> {});
            assertEquals(42, pages.get()); assertEquals(41, fixture.wallet.snapshot().getJSONObject("hd").getInt("scanned"));
            assertEquals(1, fixture.wallet.account().getInt("index"));
        }
    }
    @Test public void recoveryFailureNeverEnablesSendAndCanRetry() throws Exception {
        try (Fixture fixture = new Fixture()) {
            AtomicInteger calls = new AtomicInteger();
            assertThrows(Exception.class, () -> fixture.recover((method, params) -> {
                if (calls.incrementAndGet() == 4) throw new Exception("Synthetic timeout");
                return CompletableFuture.completedFuture(page(params.getString("address"), false));
            }, LIVE, ignored -> {}));
            assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete")); assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("recovering"));
            assertTrue(fixture.vault.payload().getBoolean("needsRecovery")); assertThrows(IllegalStateException.class, fixture.wallet::requireReady);
            fixture.recover(Set.of()); fixture.wallet.requireReady();
        }
    }
    @Test(timeout = 15000) public void outOfOrderFailureCancelsRemainingWindowAndNeverCommitsComplete() throws Exception {
        try (Fixture fixture = new Fixture()) {
            List<CompletableFuture<JSONObject>> reads = new ArrayList<>();
            assertThrows(Exception.class, () -> fixture.recover((method, params) -> {
                CompletableFuture<JSONObject> future = new CompletableFuture<>(); reads.add(future);
                if (reads.size() == 16) future.completeExceptionally(new Exception("Synthetic later-index failure"));
                return future;
            }, LIVE, ignored -> {}));
            assertEquals(16, reads.size());
            for (int i = 0; i < 15; i++) assertTrue(reads.get(i).isCancelled());
            assertTrue(fixture.vault.payload().getBoolean("needsRecovery"));
            assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete"));
            assertEquals(0, fixture.wallet.snapshot().getJSONObject("hd").getInt("scanned"));
            assertThrows(IllegalStateException.class, fixture.wallet::requireReady);
        }
    }
    @Test public void localPaginationLimitIsReportedWithoutEchoingRemoteExceptionText() throws Exception {
        try (Fixture fixture = new Fixture()) {
            AtomicInteger pages = new AtomicInteger();
            assertThrows(NativeHdWallet.RecoveryLimitException.class, () -> fixture.recover((method, params) -> {
                JSONObject result = page(params.getString("address"), false);
                if (params.getString("address").equals("native-0-0")) result.put("next_cursor", "next." + pages.incrementAndGet());
                return CompletableFuture.completedFuture(result);
            }, LIVE, ignored -> {}));
            assertTrue(fixture.wallet.snapshot().getJSONObject("hd").getString("error").contains("pagination limit"));
            assertTrue(fixture.wallet.snapshot().getJSONObject("hd").getString("error").contains("desktop"));
            assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete"));
            assertThrows(Exception.class, () -> fixture.recover((method, params) -> { throw new Exception("UNTRUSTED RPC SECRET TEXT"); }, LIVE, ignored -> {}));
            assertFalse(fixture.wallet.snapshot().toString().contains("UNTRUSTED"));
        }
    }
    @Test public void currentAddressAndChangeAreCommittedOnlyAfterPersistenceAndGapIsBounded() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.recover(Set.of()); fixture.failWrite = true;
            assertThrows(Exception.class, () -> fixture.wallet.newAddress(LIVE)); assertEquals(0, fixture.wallet.account().getInt("index"));
            assertEquals(0, fixture.vault.payload().getInt("receiveIndex"));
            assertThrows(Exception.class, () -> fixture.wallet.allocateChange(0, LIVE)); assertEquals(0, fixture.wallet.changeAccount().getInt("index"));
            fixture.failWrite = false;
            for (int index = 1; index < 20; index++) assertEquals(index, fixture.wallet.newAddress(LIVE).getInt("index"));
            assertThrows(IllegalStateException.class, () -> fixture.wallet.newAddress(LIVE));
            fixture.wallet.allocateChange(0, LIVE); assertEquals(1, fixture.wallet.changeAccount().getInt("index"));
            assertThrows(IllegalStateException.class, () -> fixture.wallet.allocateChange(0, LIVE));
        }
    }
    @Test public void lateOwnedHistoryExtendsBothGapsButHostileDataDoesNot() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.recover(Set.of());
            assertTrue(fixture.wallet.observeResponse("getaddresshistory", new JSONObject().put("address", "native-0-19"), page("native-0-19", true), LIVE));
            assertNotNull(fixture.wallet.owned("native-0-39")); assertEquals(19, fixture.vault.payload().getInt("lastUsedReceive"));
            JSONObject hostile = page("native-1-19", true); hostile.getJSONArray("items").getJSONObject(0).put("balance_delta", "100");
            assertThrows(IllegalArgumentException.class, () -> fixture.wallet.observeResponse("getaddresshistory", new JSONObject().put("address", "native-1-19"), hostile, LIVE));
            assertNull(fixture.wallet.owned("native-1-39")); assertEquals(-1, fixture.vault.payload().getInt("lastUsedChange"));
            assertTrue(fixture.wallet.observeResponse("getaddresshistory", new JSONObject().put("address", "native-1-19"), page("native-1-19", true), LIVE));
            assertNotNull(fixture.wallet.owned("native-1-39"));
        }
    }
    @Test public void failedLateGapPersistenceMakesRecoveryIncompleteUntilSuccessfulRetry() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.recover(Set.of()); fixture.failWrite = true;
            assertThrows(Exception.class, () -> fixture.wallet.observeUsed("native-0-19", LIVE));
            assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete"));
            assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getString("error").isEmpty());
            assertThrows(IllegalStateException.class, fixture.wallet::requireReady);
            fixture.failWrite = false; fixture.recover(Set.of("native-0-19")); fixture.wallet.requireReady();
            assertEquals(19, fixture.vault.payload().getInt("lastUsedReceive"));
            assertNotNull(fixture.wallet.owned("native-0-39"));
        }
    }
    @Test public void explicitRescanDoesNotSilentlyReturnWhenPreviousRecoveryWasComplete() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.recover(Set.of()); assertTrue(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete"));
            fixture.wallet.requestRecovery(LIVE);
            assertTrue(fixture.vault.payload().getBoolean("needsRecovery"));
            assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete"));
            fixture.recover(Set.of("native-1-19")); fixture.wallet.requireReady();
            assertEquals(20, fixture.wallet.changeAccount().getInt("index")); assertNotNull(fixture.wallet.owned("native-1-39"));
        }
    }
    @Test(timeout = 15000) public void lockDoesNotWaitForRpcAndCancelsAllSixteenPendingReads() throws Exception {
        try (Fixture fixture = new Fixture()) {
            List<CompletableFuture<JSONObject>> reads = new ArrayList<>(); AtomicBoolean closed = new AtomicBoolean();
            assertThrows(IllegalStateException.class, () -> fixture.recover((method, params) -> {
                CompletableFuture<JSONObject> future = new CompletableFuture<>(); reads.add(future);
                if (reads.size() == 16) { fixture.wallet.close(); closed.set(true); }
                return future;
            }, LIVE, ignored -> {}));
            assertTrue(closed.get()); assertEquals(16, reads.size()); for (CompletableFuture<JSONObject> read : reads) assertTrue(read.isCancelled());
            assertNotNull(fixture.wallet.snapshot().getJSONObject("account")); assertThrows(IllegalStateException.class, fixture.wallet::requireReady);
        }
    }
    @Test public void savedIssuedIndexesArePreservedAndResourceLimitNeverSilentlySucceeds() throws Exception {
        JSONObject payload = WalletVault.newPayload("Fixture", WORDS, "").put("receiveIndex", 27).put("changeIndex", 5);
        try (Fixture fixture = new Fixture(payload)) {
            fixture.recover(Set.of()); assertEquals(27, fixture.wallet.account().getInt("index")); assertEquals(5, fixture.wallet.changeAccount().getInt("index"));
            assertEquals(48, fixture.wallet.snapshot().getJSONObject("hd").getInt("scanned"));
        }
        try (WalletVault.UpdateSession vault = WalletVault.createForUpdate(payload.put("receiveIndex", 10001), PASSWORD)) {
            assertThrows(IllegalStateException.class, () -> new NativeHdWallet(NativeHdWalletTest::account, vault, (envelope, check) -> {}));
            assertFalse(vault.payload().optBoolean("mobileHdRecovered", false));
        }
    }
    @Test public void journalHistoryHintsAreAtomicBoundedAndBoundToRequestedAddresses() throws Exception {
        JSONObject item = page("native-0-19", true).getJSONArray("items").getJSONObject(0);
        JSONObject event = new JSONObject().put("sequence", 3).put("address", "native-0-19").put("kind", "history")
            .put("action", "upsert").put("txid", item.getString("txid")).put("item", item);
        JSONObject result = new JSONObject().put("tip", tip()).put("unit", "connects").put("changes", new JSONArray().put(event))
            .put("next_cursor", "next.cursor").put("has_more", false).put("through_sequence", 3).put("journal_epoch", 1);
        JSONObject params = new JSONObject().put("addresses", new JSONArray().put("native-0-19")).put("cursor", "old.cursor");
        assertEquals(List.of("native-0-19"), NativeHdWallet.usedAddresses("getaddresschanges", params, result));
        JSONObject malformed = new JSONObject(result.toString());
        malformed.getJSONArray("changes").put(new JSONObject(event.toString()).put("sequence", 4).put("address", "not-owned"));
        malformed.put("through_sequence", 4);
        assertThrows(IllegalArgumentException.class, () -> NativeHdWallet.usedAddresses("getaddresschanges", params, malformed));
        JSONObject removed = new JSONObject(result.toString());
        JSONObject removal = removed.getJSONArray("changes").getJSONObject(0).put("action", "remove"); removal.remove("item");
        assertTrue(NativeHdWallet.usedAddresses("getaddresschanges", params, removed).isEmpty());
        JSONObject duplicate = new JSONObject(result.toString()); duplicate.getJSONArray("changes").put(event);
        assertThrows(IllegalArgumentException.class, () -> NativeHdWallet.usedAddresses("getaddresschanges", params, duplicate));
        JSONObject forged = new JSONObject(result.toString()); forged.getJSONArray("changes").getJSONObject(0).getJSONObject("item").put("confirmations", 99);
        assertThrows(IllegalArgumentException.class, () -> NativeHdWallet.usedAddresses("getaddresschanges", params, forged));
    }
    @Test public void recoveryRetainsOriginalCheckpointAndFirstPagesWithoutRepeatingDiscoveryReads() throws Exception {
        try (Fixture fixture = new Fixture()) {
            Set<String> checkpointed = new HashSet<>(), read = new HashSet<>();
            AtomicInteger checkpoints = new AtomicInteger(), histories = new AtomicInteger();
            fixture.wallet.recover((method, params) -> {
                if (method.equals("getaddresschanges")) {
                    JSONArray members = params.getJSONArray("addresses"); assertTrue(members.length() <= 100);
                    for (int i = 0; i < members.length(); i++) assertTrue(checkpointed.add(members.getString(i)));
                    int sequence = checkpoints.incrementAndGet();
                    return CompletableFuture.completedFuture(checkpoint().put("through_sequence", sequence).put("next_cursor", "original." + sequence));
                }
                histories.incrementAndGet(); String address = params.getString("address");
                assertTrue(checkpointed.contains(address)); assertTrue(read.add(address));
                assertEquals(0, fixture.wallet.recoverySnapshots().getJSONArray("groups").length());
                return CompletableFuture.completedFuture(page(address, address.equals("native-0-0")));
            }, LIVE, ignored -> {});
            JSONObject result = fixture.wallet.recoverySnapshots(); JSONArray groups = result.getJSONArray("groups");
            Set<String> cached = new HashSet<>(); assertEquals("native-0-0", result.getString("walletId"));
            assertEquals(checkpoints.get(), groups.length()); assertEquals(41, histories.get());
            for (int i = 0; i < groups.length(); i++) {
                JSONObject group = groups.getJSONObject(i); JSONArray members = group.getJSONArray("addresses"), pages = group.getJSONArray("histories");
                assertEquals(members.length(), pages.length());
                assertTrue(group.getJSONObject("sync").getString("next_cursor").startsWith("original."));
                for (int j = 0; j < members.length(); j++) {
                    assertTrue(cached.add(members.getString(j))); assertEquals(members.getString(j), pages.getJSONObject(j).getString("address"));
                }
            }
            assertEquals(read, cached); assertFalse(result.toString().contains("mnemonic")); assertFalse(result.toString().contains("abandon"));
            groups.getJSONObject(0).getJSONObject("sync").put("next_cursor", "tampered.cursor");
            assertFalse(fixture.wallet.recoverySnapshots().toString().contains("tampered"));
            fixture.wallet.requestRecovery(LIVE); assertEquals(0, fixture.wallet.recoverySnapshots().getJSONArray("groups").length());
        }
    }
    @Test public void cachedEmptyContinuationPreservesItsFirstCursorAndCheckpoint() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.recover((method, params) -> {
                String address = params.getString("address"); boolean first = address.equals("native-0-0") && !params.has("cursor");
                JSONObject result = page(address, address.equals("native-0-0") && !first);
                if (first) result.put("next_cursor", "first.continuation");
                return CompletableFuture.completedFuture(result);
            }, LIVE, ignored -> {});
            JSONArray groups = fixture.wallet.recoverySnapshots().getJSONArray("groups"); JSONObject original = null;
            for (int i = 0; i < groups.length(); i++) {
                JSONArray pages = groups.getJSONObject(i).getJSONArray("histories");
                for (int j = 0; j < pages.length(); j++) if (pages.getJSONObject(j).getString("address").equals("native-0-0")) original = pages.getJSONObject(j);
            }
            assertNotNull(original); assertEquals(0, original.getJSONArray("items").length()); assertEquals("first.continuation", original.getString("next_cursor"));
            assertEquals(0, fixture.wallet.snapshot().getJSONObject("hd").getInt("lastUsedReceive"));
            fixture.wallet.close(); assertEquals(0, fixture.wallet.recoverySnapshots().getJSONArray("groups").length());
        }
    }
    @Test(timeout = 15000) public void rolling121AddressRecoveryUsesTwoCheckpointsAndNeverExceedsSixteenRequests() throws Exception {
        JSONObject payload = WalletVault.newPayload("Fixture", WORDS, "").put("receiveIndex", 81).put("lastUsedReceive", 80);
        try (Fixture fixture = new Fixture(payload)) {
            AtomicInteger checkpoints = new AtomicInteger(), active = new AtomicInteger(), peak = new AtomicInteger();
            List<CompletableFuture<JSONObject>> waiting = new ArrayList<>(); List<String> requested = new ArrayList<>();
            Set<String> checkpointed = new HashSet<>(); List<Integer> scopes = new ArrayList<>();
            java.util.concurrent.BlockingQueue<java.util.Map.Entry<String, CompletableFuture<JSONObject>>> replies = new java.util.concurrent.LinkedBlockingQueue<>(121);
            java.util.concurrent.CountDownLatch firstRefill = new java.util.concurrent.CountDownLatch(1);
            java.util.concurrent.ExecutorService responses = java.util.concurrent.Executors.newSingleThreadExecutor();
            java.util.concurrent.Future<?> responder = responses.submit(() -> {
                assertTrue("Recovery refills after just one completed request", firstRefill.await(5, java.util.concurrent.TimeUnit.SECONDS));
                for (int i = 0; i < 120; i++) {
                    java.util.Map.Entry<String, CompletableFuture<JSONObject>> reply = replies.poll(5, java.util.concurrent.TimeUnit.SECONDS);
                    assertNotNull("Every remaining history read receives a reply", reply);
                    active.decrementAndGet(); reply.getValue().complete(page(reply.getKey(), false));
                }
                return null;
            });
            try {
            fixture.wallet.recover((method, params) -> {
                peak.accumulateAndGet(active.incrementAndGet(), Math::max); assertTrue("Checkpoint plus history requests stay bounded", active.get() <= 16);
                CompletableFuture<JSONObject> future = new CompletableFuture<>();
                if (method.equals("getaddresschanges")) {
                    JSONArray addresses = params.getJSONArray("addresses"); scopes.add(addresses.length()); checkpoints.incrementAndGet();
                    for (int i = 0; i < addresses.length(); i++) assertTrue(checkpointed.add(addresses.getString(i)));
                    assertNull(fixture.wallet.owned("native-0-101")); assertNull(fixture.wallet.owned("native-1-20"));
                    active.decrementAndGet(); future.complete(checkpoint()); return future;
                }
                String address = params.getString("address"); assertTrue(checkpointed.contains(address));
                assertFalse(requested.contains(address)); requested.add(address); waiting.add(future);
                replies.add(new java.util.AbstractMap.SimpleImmutableEntry<>(address, future));
                if (waiting.size() == 16) {
                    java.util.Map.Entry<String, CompletableFuture<JSONObject>> first = replies.remove();
                    active.decrementAndGet(); first.getValue().complete(page(first.getKey(), false));
                }
                if (waiting.size() == 17) {
                    for (int i = 1; i < 16; i++) assertFalse("Refill does not wait for the other fifteen replies", waiting.get(i).isDone());
                    firstRefill.countDown();
                }
                // The independent responder keeps delivering one reply at a time
                // when a branch reaches its boundary and fewer than sixteen slots
                // remain available. New request count must not gate old replies.
                return future;
            }, () -> { if (responder.isDone()) responder.get(); }, ignored -> {});
            responder.get(5, java.util.concurrent.TimeUnit.SECONDS);
            assertEquals(121, requested.size()); assertEquals(2, checkpoints.get()); assertEquals(List.of(100, 21), scopes);
            assertEquals(16, peak.get()); assertEquals(0, active.get());
            assertEquals(121, fixture.wallet.snapshot().getJSONObject("hd").getInt("scanned")); assertEquals(121, fixture.wallet.accounts().length());
            assertNull(fixture.wallet.owned("native-0-101")); assertNull(fixture.wallet.owned("native-1-20"));
            JSONArray groups = fixture.wallet.recoverySnapshots().getJSONArray("groups"); assertEquals(2, groups.length());
            int saved = 0; for (int i = 0; i < groups.length(); i++) saved += groups.getJSONObject(i).getJSONArray("histories").length();
            assertEquals(121, saved); fixture.wallet.requireReady();
            } finally { responses.shutdownNow(); }
        }
    }
    @Test public void emptyRecoveryUsesOneCheckpointForTheGuaranteedFortyAddressGap() throws Exception {
        try (Fixture fixture = new Fixture()) {
            AtomicInteger checkpoints = new AtomicInteger(), histories = new AtomicInteger();
            fixture.wallet.recover((method, params) -> {
                if (method.equals("getaddresschanges")) {
                    checkpoints.incrementAndGet(); assertEquals(40, params.getJSONArray("addresses").length());
                    return CompletableFuture.completedFuture(checkpoint());
                }
                histories.incrementAndGet(); return CompletableFuture.completedFuture(page(params.getString("address"), false));
            }, LIVE, ignored -> {});
            assertEquals(1, checkpoints.get()); assertEquals(40, histories.get());
            assertEquals(1, fixture.wallet.recoverySnapshots().getJSONArray("groups").length());
            assertNull(fixture.wallet.owned("native-0-20")); assertNull(fixture.wallet.owned("native-1-20"));
        }
    }
    private static MobileRpcClient.RpcFailure remoteFailure(String code) throws Exception {
        java.lang.reflect.Constructor<MobileRpcClient.RpcFailure> constructor = MobileRpcClient.RpcFailure.class.getDeclaredConstructor(
            String.class, boolean.class, Integer.class, long.class, boolean.class);
        constructor.setAccessible(true); return constructor.newInstance(code, false, null, 0L, false);
    }
    /** Serial actor fixture advances virtual delay instead of sleeping. */
    private static final class RecoveryClock implements HdRecoveryReader.Scheduler {
        long now; boolean draining;
        final java.util.ArrayDeque<Runnable> queue = new java.util.ArrayDeque<>();
        final List<Long> delays = new ArrayList<>();
        public void execute(Runnable action) {
            queue.add(action); if (draining) return;
            draining = true;
            try { while (!queue.isEmpty()) queue.remove().run(); } finally { draining = false; }
        }
        public HdRecoveryReader.Cancel after(long ms, Runnable action) {
            delays.add(ms); java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean();
            execute(() -> { if (!cancelled.get()) { now += ms; action.run(); } });
            return () -> cancelled.set(true);
        }
        public void close() { }
    }
    @Test public void initialInactiveCheckpointAutomaticallyRecoversWithoutStartingHistoryEarly() throws Exception {
        try (Fixture fixture = new Fixture()) {
            RecoveryClock clock = new RecoveryClock(); AtomicInteger checkpoints = new AtomicInteger(), histories = new AtomicInteger();
            List<JSONObject> states = new ArrayList<>();
            NativeHdWallet.Progress progress = snapshot -> states.add(snapshot.optJSONObject("hd"));
            try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> {
                if (method.equals("getaddresschanges")) {
                    assertEquals(0, histories.get());
                    if (checkpoints.incrementAndGet() == 1) throw remoteFailure("RPC_INACTIVE").recoveryHint(false, true);
                    return CompletableFuture.completedFuture(checkpoint());
                }
                assertEquals(2, checkpoints.get()); histories.incrementAndGet();
                return CompletableFuture.completedFuture(page(params.getString("address"), false));
            }, LIVE, () -> true, (state, delay, attempt, code) -> fixture.wallet.recoveryStatus(state, delay, attempt, code, progress), clock, () -> clock.now, () -> 0)) {
                fixture.wallet.recover(reader, LIVE, progress);
            }
            assertEquals(2, checkpoints.get()); assertEquals(40, histories.get()); assertEquals(List.of(1000L), clock.delays);
            JSONObject retry = states.stream().filter(hd -> "retrying".equals(hd.optString("recoveryState"))).findFirst().orElseThrow();
            assertEquals(0, retry.getInt("scanned")); assertTrue(retry.getBoolean("recovering")); assertFalse(retry.getBoolean("complete"));
            assertEquals("complete", fixture.wallet.hdSnapshot().getString("recoveryState")); assertEquals(40, fixture.wallet.hdSnapshot().getInt("scanned"));
            assertEquals(1, fixture.wallet.recoverySnapshots().getJSONArray("groups").length()); fixture.wallet.requireReady();
        }
    }
    @Test public void continuationRetryKeepsValidatedPrefixOriginalCheckpointAndFirstPages() throws Exception {
        try (Fixture fixture = new Fixture()) {
            RecoveryClock clock = new RecoveryClock(); java.util.Map<String, Integer> reads = new java.util.LinkedHashMap<>();
            List<JSONObject> retryStates = new ArrayList<>();
            NativeHdWallet.Progress progress = snapshot -> {
                JSONObject hd = snapshot.optJSONObject("hd"); if ("retrying".equals(hd.optString("recoveryState"))) retryStates.add(hd);
            };
            try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> {
                if (method.equals("getaddresschanges")) return CompletableFuture.completedFuture(checkpoint());
                String address = params.getString("address"), key = address + ":" + params.optString("cursor", "first");
                int count = reads.merge(key, 1, Integer::sum);
                boolean continuation = address.equals("native-0-8") && params.has("cursor");
                if (continuation && count == 1) throw remoteFailure("RPC_TIMEOUT");
                JSONObject response = page(address, continuation);
                if (address.equals("native-0-8") && !continuation) response.put("next_cursor", "empty.continuation");
                return CompletableFuture.completedFuture(response);
            }, LIVE, () -> true, (state, delay, attempt, code) -> fixture.wallet.recoveryStatus(state, delay, attempt, code, progress), clock, () -> clock.now, () -> 0)) {
                fixture.wallet.recover(reader, LIVE, progress);
            }
            assertEquals(Integer.valueOf(2), reads.remove("native-0-8:empty.continuation"));
            assertTrue(reads.values().stream().allMatch(count -> count == 1)); assertEquals(49, reads.size());
            assertFalse(retryStates.isEmpty()); assertTrue(retryStates.stream().allMatch(hd -> hd.optInt("scanned") >= 16 && hd.optBoolean("recovering")));
            assertEquals(49, fixture.wallet.hdSnapshot().getInt("scanned")); assertEquals(8, fixture.wallet.hdSnapshot().getInt("lastUsedReceive"));
            JSONObject original = fixture.wallet.recoverySnapshots().getJSONArray("groups").getJSONObject(0);
            assertEquals("original.checkpoint", original.getJSONObject("sync").getString("next_cursor"));
            JSONArray histories = original.getJSONArray("histories"); boolean found = false;
            for (int i = 0; i < histories.length(); i++) if (histories.getJSONObject(i).getString("address").equals("native-0-8")) {
                found = true; assertEquals("empty.continuation", histories.getJSONObject(i).getString("next_cursor"));
                assertEquals(0, histories.getJSONObject(i).getJSONArray("items").length());
            }
            assertTrue(found); fixture.wallet.requireReady();
        }
    }
    @Test public void staleCursorAndValidationFailuresAreTerminalWithSafeDistinctCodes() throws Exception {
        for (String code : new String[]{"-32011", "RPC_PROTOCOL", "RPC_INVALID"}) try (Fixture fixture = new Fixture()) {
            RecoveryClock clock = new RecoveryClock(); AtomicInteger calls = new AtomicInteger();
            try (HdRecoveryReader reader = new HdRecoveryReader((method, params) -> { calls.incrementAndGet(); throw remoteFailure(code); },
                    LIVE, () -> true, (state, delay, attempt, error) -> {}, clock, () -> clock.now, () -> 0)) {
                assertThrows(Exception.class, () -> fixture.wallet.recover(reader, LIVE, ignored -> {}));
            }
            assertEquals(1, calls.get()); assertTrue(clock.delays.isEmpty());
            assertEquals(code.equals("-32011") ? "HD_REFRESH_REQUIRED" : code.equals("RPC_INVALID") ? "HD_INVALID_REQUEST" : "HD_VALIDATION",
                fixture.wallet.hdSnapshot().getString("errorCode"));
            assertEquals("failed", fixture.wallet.hdSnapshot().getString("recoveryState")); assertThrows(IllegalStateException.class, fixture.wallet::requireReady);
        }
    }
    @Test public void checkpointEpochChangeRequiresFreshDiscoveryButOrdinaryTipAdvanceDoesNot() throws Exception {
        for (boolean epochChanged : new boolean[]{true, false}) try (Fixture fixture = new Fixture()) {
            AtomicInteger checkpoints = new AtomicInteger();
            NativeHdWallet.Reader reader = (method, params) -> {
                if (method.equals("getaddresschanges")) {
                    JSONObject response = checkpoint();
                    if (checkpoints.incrementAndGet() > 1) {
                        if (epochChanged) response.put("journal_epoch", 2);
                        else response.getJSONObject("tip").put("height", 124).put("hash", "dd".repeat(32));
                    }
                    return CompletableFuture.completedFuture(response);
                }
                String address = params.getString("address");
                return CompletableFuture.completedFuture(page(address, address.equals("native-0-19")));
            };
            if (epochChanged) {
                assertThrows(NativeHdWallet.RecoveryRefreshException.class, () -> fixture.wallet.recover(reader, LIVE, ignored -> {}));
                assertEquals("HD_REFRESH_REQUIRED", fixture.wallet.hdSnapshot().getString("errorCode"));
                assertEquals("failed", fixture.wallet.hdSnapshot().getString("recoveryState"));
                assertFalse(fixture.wallet.hdSnapshot().getBoolean("complete"));
                assertEquals(0, fixture.wallet.recoverySnapshots().getJSONArray("groups").length());
                assertTrue(fixture.vault.payload().getBoolean("needsRecovery"));
            } else { fixture.wallet.recover(reader, LIVE, ignored -> {}); fixture.wallet.requireReady(); }
            assertEquals(2, checkpoints.get());
        }
    }
    @Test public void onlyExplicitUnsupportedCheckpointFallsBackToUncachedHistory() throws Exception {
        for (String code : new String[]{"-32601", "-32029", "RPC_TIMEOUT", "RPC_CANCELLED"}) try (Fixture fixture = new Fixture()) {
            AtomicInteger checkpoints = new AtomicInteger(), histories = new AtomicInteger();
            NativeHdWallet.Reader reader = (method, params) -> {
                if (method.equals("getaddresschanges")) {
                    checkpoints.incrementAndGet(); CompletableFuture<JSONObject> failed = new CompletableFuture<>(); failed.completeExceptionally(remoteFailure(code)); return failed;
                }
                histories.incrementAndGet(); return CompletableFuture.completedFuture(page(params.getString("address"), false));
            };
            if (code.equals("-32601")) { fixture.wallet.recover(reader, LIVE, ignored -> {}); fixture.wallet.requireReady(); assertEquals(40, histories.get()); }
            else { assertThrows(MobileRpcClient.RpcFailure.class, () -> fixture.wallet.recover(reader, LIVE, ignored -> {})); assertEquals(0, histories.get()); }
            assertEquals(1, checkpoints.get()); assertEquals(0, fixture.wallet.recoverySnapshots().getJSONArray("groups").length());
        }
    }
    @Test public void invalidCheckpointCannotStartHistoryOrPublishRecoveryCache() throws Exception {
        for (String mode : new String[]{"cursor", "initial-changes", "tip", "extra"}) try (Fixture fixture = new Fixture()) {
            AtomicInteger histories = new AtomicInteger();
            assertThrows(Exception.class, () -> fixture.wallet.recover((method, params) -> {
                if (method.equals("getaddresshistory")) { histories.incrementAndGet(); return CompletableFuture.completedFuture(page(params.getString("address"), false)); }
                JSONObject result = checkpoint();
                if (mode.equals("cursor")) result.put("next_cursor", "bad cursor");
                if (mode.equals("initial-changes")) result.getJSONArray("changes").put(new JSONObject().put("sequence", 3)
                    .put("address", "native-0-0").put("kind", "history").put("action", "remove").put("txid", "bb".repeat(32)));
                if (mode.equals("tip")) result.getJSONObject("tip").put("genesis_hash", "00".repeat(32));
                if (mode.equals("extra")) result.put("untrusted", "must not cross the bridge");
                return CompletableFuture.completedFuture(result);
            }, LIVE, ignored -> {}));
            assertEquals(0, histories.get()); assertEquals(0, fixture.wallet.recoverySnapshots().getJSONArray("groups").length());
            assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete"));
        }
    }
    @Test(timeout = 15000) public void lockCancelsPendingCheckpointBeforeAnyHistoryRead() throws Exception {
        try (Fixture fixture = new Fixture()) {
            CompletableFuture<JSONObject> checkpoint = new CompletableFuture<>(); AtomicInteger histories = new AtomicInteger();
            assertThrows(IllegalStateException.class, () -> fixture.wallet.recover((method, params) -> {
                if (method.equals("getaddresschanges")) { fixture.wallet.close(); return checkpoint; }
                histories.incrementAndGet(); return CompletableFuture.completedFuture(page(params.getString("address"), false));
            }, LIVE, ignored -> {}));
            assertTrue(checkpoint.isCancelled()); assertEquals(0, histories.get());
            assertEquals(0, fixture.wallet.recoverySnapshots().getJSONArray("groups").length());
        }
    }
    @Test public void failedFinalPersistenceDiscardsAllStagedRecoveryPages() throws Exception {
        try (Fixture fixture = new Fixture()) {
            AtomicInteger histories = new AtomicInteger();
            assertThrows(Exception.class, () -> fixture.recover((method, params) -> {
                if (histories.incrementAndGet() == 40) fixture.failWrite = true;
                return CompletableFuture.completedFuture(page(params.getString("address"), false));
            }, LIVE, ignored -> {}));
            assertEquals(40, histories.get()); assertEquals(0, fixture.wallet.recoverySnapshots().getJSONArray("groups").length());
            assertFalse(fixture.wallet.snapshot().getJSONObject("hd").getBoolean("complete"));
            assertEquals("failed", fixture.wallet.hdSnapshot().getString("recoveryState")); assertEquals("HD_STORAGE", fixture.wallet.hdSnapshot().getString("errorCode"));
            fixture.failWrite = false; fixture.recover(Set.of()); assertTrue(fixture.wallet.recoverySnapshots().getJSONArray("groups").length() > 0);
        }
    }
}
