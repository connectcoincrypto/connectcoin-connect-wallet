package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentChecks;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentInventory;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.VaultSession;
import java.util.ArrayList;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class MobilePaymentPreparationTest {
    private static final String ADDRESS = "cc1pml9wc5eqzrtsfpswyzkk4luv7drhze8lkqhe84zu25k6m3cw6f8s9m7gac";
    private static String hash(int number) { return String.format(java.util.Locale.ROOT, "%064x", number); }
    private static JSONObject tip(int height) throws Exception {
        return new JSONObject().put("chain", "main").put("genesis_hash", NativePaymentChecks.GENESIS).put("height", height).put("hash", hash(height)).put("mediantime", 1700000000L + height * 10);
    }
    private static JSONObject row(int index, int height) throws Exception {
        return new JSONObject().put("txid", hash(index + 1)).put("vout", 0).put("amount", "100000000")
            .put("block_height", 900).put("status", "confirmed").put("confirmations", height - 899)
            .put("coinbase", false).put("mature", true).put("pending_spent_by", JSONObject.NULL);
    }
    private static JSONObject page(int start, int count, int total, int height) throws Exception {
        JSONArray rows = new JSONArray();
        for (int i = start; i < start + count; i++) rows.put(row(i, height));
        return new JSONObject().put("address", ADDRESS).put("tip", tip(height)).put("unit", "connects").put("live", true)
            .put("items", rows).put("next_cursor", start + count < total ? "page_" + (start + count) + ".sig" : JSONObject.NULL);
    }
    private static JSONObject journal(String cursor, long through, boolean more, JSONArray changes, int height) throws Exception {
        return new JSONObject().put("tip", tip(height)).put("unit", "connects").put("changes", changes).put("next_cursor", cursor)
            .put("has_more", more).put("through_sequence", through).put("journal_epoch", 1);
    }
    private static JSONObject remove(long sequence, int index) throws Exception {
        return new JSONObject().put("sequence", sequence).put("address", ADDRESS).put("kind", "utxo").put("action", "remove").put("txid", hash(index + 1)).put("vout", 0);
    }
    private static JSONObject upsert(long sequence, JSONObject row) throws Exception {
        return new JSONObject().put("sequence", sequence).put("address", ADDRESS).put("kind", "utxo").put("action", "upsert")
            .put("txid", row.getString("txid")).put("vout", row.getLong("vout")).put("item", row);
    }
    private static MobileRpcClient.RpcFailure expired() throws Exception {
        try {
            MobileRpcClient.reply(new JSONObject().put("jsonrpc", "2.0").put("id", "fixture").put("error", new JSONObject().put("code", -32011).put("message", "Synthetic expired cursor")), "fixture");
            throw new AssertionError("Expected fixture cursor failure");
        } catch (MobileRpcClient.RpcFailure failure) { return failure; }
    }
    private static MobilePaymentFunding.Session session(MobilePaymentFunding.Reader reader) {
        return session(reader, () -> {});
    }
    private static MobilePaymentFunding.Session session(MobilePaymentFunding.Reader reader, MobilePaymentFunding.Check check) {
        return new MobilePaymentFunding().session(reader, check, (stage, completed, total, retry) -> {});
    }
    private static JSONArray accounts(int count) throws Exception {
        JSONArray result = new JSONArray();
        try (VaultSession wallet = new VaultSession("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "")) {
            for (int i = 0; i < count; i++) result.put(wallet.publicAccount(i, 0));
        }
        return result;
    }
    @Test public void fragmentedBatchVerifiesMoreThanOneStandardTransactionWithoutRaisingSingleLimits() throws Exception {
        JSONArray own = accounts(1); String address = own.getJSONObject(0).getString("address");
        MobilePaymentFunding.Session preparation = session((method, params) -> {
            if (method.equals("getaddresschanges")) return journal("journal_0.sig", 0, false, new JSONArray(), 1000);
            int start = params.has("cursor") ? Integer.parseInt(params.getString("cursor").split("[_.]")[1]) : 0;
            return page(start, Math.min(500, 4000 - start), 4000, 1000).put("address", address);
        });
        MobilePaymentPreparation.HdInventory inventory = MobilePaymentPreparation.inventory(own, new JSONObject(), preparation);
        JSONArray all = inventory.candidates(); assertEquals(4000, all.length());
        assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(all, true, "400000000000"));
        JSONArray plans = new JSONArray();
        for (int start = 0; start < all.length(); start += 1700) {
            JSONArray part = new JSONArray();
            for (int i = start; i < Math.min(start + 1700, all.length()); i++) part.put(all.getJSONObject(i));
            plans.put(new JSONObject().put("selected", part));
        }
        inventory.verifyBatch(plans, true, "400000000000");
        assertThrows(IllegalArgumentException.class, () -> inventory.verifyBatch(plans, true, "399900000000"));
        plans.getJSONObject(2).getJSONArray("selected").put(all.getJSONObject(0));
        assertThrows(IllegalArgumentException.class, () -> inventory.verifyBatch(plans, false, null));
    }

    @Test(timeout = 15000) public void hdReadsUseSixteenRollingSlotsWithoutWaitingForASlowBatch() throws Exception {
        JSONArray accounts = accounts(17); Map<String, Integer> positions = new HashMap<>();
        for (int i = 0; i < accounts.length(); i++) positions.put(accounts.getJSONObject(i).getString("address"), i);
        CountDownLatch firstSixteen = new CountDownLatch(16), seventeenth = new CountDownLatch(1);
        AtomicInteger active = new AtomicInteger(), maximum = new AtomicInteger(), reads = new AtomicInteger();
        MobilePaymentFunding.Session session = session((method, params) -> {
            if (method.equals("getaddresschanges")) return journal("journal_0.sig", 0, false, new JSONArray(), 1000);
            int count = active.incrementAndGet(); maximum.accumulateAndGet(count, Math::max); reads.incrementAndGet();
            try {
                assertTrue(count <= 16); int position = positions.get(params.getString("address"));
                if (position < 16) {
                    firstSixteen.countDown(); assertTrue(firstSixteen.await(5, TimeUnit.SECONDS));
                    if (position != 0) assertTrue(seventeenth.await(5, TimeUnit.SECONDS));
                } else {
                    assertEquals(16, active.get()); // Fifteen older readers still wait when this slot rolls forward.
                    seventeenth.countDown();
                }
                return page(0, 0, 0, 1000).put("address", params.getString("address"));
            } finally { active.decrementAndGet(); }
        });
        MobilePaymentPreparation.HdInventory inventory = MobilePaymentPreparation.inventory(accounts, new JSONObject(), session);
        assertEquals(17, reads.get()); assertEquals(16, maximum.get()); assertEquals(0, inventory.candidates().length());
    }

    @Test public void hdBudgetCoversCompletedGroupsAsWellAsTheCurrentConcurrentPages() throws Exception {
        JSONArray accounts = accounts(101); AtomicInteger pages = new AtomicInteger();
        NativePaymentInventory.RowBudget budget = new NativePaymentInventory.RowBudget(100);
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class, () -> MobilePaymentPreparation.inventory(accounts, new JSONObject(), session((method, params) -> {
            if (method.equals("getaddresschanges")) return journal("journal_0.sig", 0, false, new JSONArray(), 1000);
            int index = pages.getAndIncrement();
            return page(index, 1, index + 1, 1000).put("address", params.getString("address"));
        }), budget));
        assertTrue(failure.getMessage().contains("memory limit")); assertEquals(101, pages.get()); assertTrue(budget.rowCount() <= 100);
    }

    @Test public void hdBudgetRejectsPagesBeforeConcurrentInventoriesCanEachReachTheirOwnLimit() throws Exception {
        JSONArray accounts = accounts(16); AtomicInteger pages = new AtomicInteger();
        NativePaymentInventory.RowBudget budget = new NativePaymentInventory.RowBudget(5);
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class, () -> MobilePaymentPreparation.inventory(accounts, new JSONObject(), session((method, params) -> {
            if (method.equals("getaddresschanges")) return journal("journal_0.sig", 0, false, new JSONArray(), 1000);
            int page = pages.getAndIncrement();
            return page(page * 3, 3, page * 3 + 1000, 1000).put("address", params.getString("address"));
        }), budget));
        assertTrue(failure.getMessage().contains("memory limit")); assertTrue(pages.get() <= 32); assertTrue(budget.rowCount() <= 5);
    }

    @Test public void staleHdJournalDiscardsOnlyItsOldScopeBeforeRebuildingWithinTheSameBudget() throws Exception {
        JSONArray accounts = accounts(2); AtomicInteger watermarks = new AtomicInteger(), pages = new AtomicInteger();
        NativePaymentInventory.RowBudget budget = new NativePaymentInventory.RowBudget(2);
        MobilePaymentPreparation.HdInventory inventory = MobilePaymentPreparation.inventory(accounts, new JSONObject(), session((method, params) -> {
            if (method.equals("getaddresschanges")) {
                if (!params.has("cursor")) watermarks.incrementAndGet();
                else if (watermarks.get() == 1) throw expired();
                return journal("journal_0.sig", 0, false, new JSONArray(), 1000);
            }
            int index = pages.getAndIncrement(); return page(index, 1, index + 1, 1000).put("address", params.getString("address"));
        }), budget);
        assertEquals(2, watermarks.get()); assertEquals(4, pages.get()); assertEquals(2, budget.rowCount()); assertEquals(2, inventory.candidates().length());
    }

    @Test public void twelveHundredOutputsReconcileAdvancingTipsAndChangesBehindThePageCursor() throws Exception {
        List<String> calls = new ArrayList<>(); AtomicInteger pages = new AtomicInteger(), changes = new AtomicInteger();
        MobilePaymentFunding.Session session = session((method, params) -> {
            calls.add(method);
            if (method.equals("getaddressutxos")) {
                int number = pages.getAndIncrement(), start = number * 500;
                assertEquals(ADDRESS, params.getString("address")); assertTrue(params.getBoolean("include_pending_spent"));
                if (number == 0) assertFalse(params.has("cursor")); else assertEquals("page_" + start + ".sig", params.getString("cursor"));
                return page(start, Math.min(500, 1205 - start), 1205, 1000 + number);
            }
            assertEquals("getaddresschanges", method); assertEquals(ADDRESS, params.getJSONArray("addresses").getString(0));
            int number = changes.getAndIncrement();
            if (number == 0) { assertFalse(params.has("cursor")); return journal("journal_0.sig", 0, false, new JSONArray(), 1000); }
            if (number == 1) {
                assertEquals("journal_0.sig", params.getString("cursor"));
                return journal("journal_1.sig", 3, true, new JSONArray().put(remove(1, 0)).put(upsert(2, row(2000, 1005))), 1005);
            }
            assertEquals("journal_1.sig", params.getString("cursor"));
            return journal("journal_2.sig", 3, false, new JSONArray().put(upsert(3, row(1, 1005).put("pending_spent_by", hash(9000)))), 1005);
        });
        NativePaymentInventory inventory = MobilePaymentPreparation.inventory(ADDRESS, new JSONObject(), session);
        assertTrue(inventory.reconciled()); assertEquals(1205, inventory.rowCount()); assertEquals(1204, inventory.candidates().length()); assertEquals(1, inventory.pendingCandidates().length());
        assertEquals(3, pages.get()); assertEquals(3, changes.get()); assertEquals(1005, inventory.tip().getInt("height"));
        assertEquals("getaddresschanges", calls.get(0));
        boolean inserted = false;
        JSONArray candidates = inventory.candidates();
        for (int i = 0; i < candidates.length(); i++) {
            JSONObject candidate = candidates.getJSONObject(i); assertNotEquals(hash(1), candidate.getString("txid")); assertEquals(106, candidate.getInt("confirmations"));
            if (candidate.getString("txid").equals(hash(2001))) inserted = true;
        }
        assertTrue(inserted);
    }

    @Test public void afterParentDownloadsRefreshReadsOnlyTheJournalAndDetectsSpentSelection() throws Exception {
        List<String> calls = new ArrayList<>(); AtomicInteger changes = new AtomicInteger();
        MobilePaymentFunding.Session session = session((method, params) -> {
            calls.add(method);
            if (method.equals("getaddressutxos")) return page(0, 2, 2, 1000);
            if (method.equals("gettransactions")) return new JSONObject();
            assertEquals("getaddresschanges", method); int number = changes.getAndIncrement();
            if (number == 0) return journal("journal_0.sig", 0, false, new JSONArray(), 1000);
            if (number == 1) return journal("journal_1.sig", 0, false, new JSONArray(), 1000);
            assertEquals("journal_1.sig", params.getString("cursor"));
            return journal("journal_2.sig", 1, false, new JSONArray().put(remove(1, 0)), 1008);
        });
        NativePaymentInventory inventory = MobilePaymentPreparation.inventory(ADDRESS, new JSONObject(), session);
        JSONArray selected = new JSONArray(); JSONArray candidates = inventory.candidates();
        for (int i = 0; i < candidates.length(); i++) if (candidates.getJSONObject(i).getString("txid").equals(hash(1))) selected.put(candidates.getJSONObject(i));
        session.read("gettransactions", new JSONObject().put("txids", new JSONArray().put(hash(1))), "funding", 0, 1);
        int beforeRefresh = calls.size();
        assertSame(inventory, MobilePaymentPreparation.refresh(inventory, new JSONObject(), session));
        assertEquals(beforeRefresh + 1, calls.size()); assertEquals("getaddresschanges", calls.get(beforeRefresh));
        assertEquals(1, inventory.rowCount());
        assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(selected, false, null));
    }

    @Test public void explicitExpiredCursorRebuildsAtMostThreeBaselines() throws Exception {
        AtomicInteger watermarks = new AtomicInteger(), pages = new AtomicInteger();
        MobilePaymentFunding.Session session = session((method, params) -> {
            if (method.equals("getaddresschanges")) { watermarks.incrementAndGet(); assertFalse(params.has("cursor")); return journal("journal_0.sig", 0, false, new JSONArray(), 1000); }
            pages.incrementAndGet(); throw expired();
        });
        assertThrows(MobileRpcClient.RpcFailure.class, () -> MobilePaymentPreparation.inventory(ADDRESS, new JSONObject(), session));
        assertEquals(3, watermarks.get()); assertEquals(3, pages.get());
    }

    @Test public void typedSnapshotRaceRetriesButOrdinaryProgressDoesNot() throws Exception {
        AtomicInteger watermarks = new AtomicInteger(), pages = new AtomicInteger();
        MobilePaymentFunding.Session session = session((method, params) -> {
            if (method.equals("getaddresschanges")) {
                if (!params.has("cursor")) { watermarks.incrementAndGet(); return journal("journal_0.sig", 0, false, new JSONArray(), 1000); }
                return journal("journal_1.sig", 0, false, new JSONArray(), 1002);
            }
            if (pages.getAndIncrement() < 2) throw new NativePaymentInventory.SnapshotChanged();
            return page(0, 1, 1, 1001);
        });
        NativePaymentInventory inventory = MobilePaymentPreparation.inventory(ADDRESS, new JSONObject(), session);
        assertTrue(inventory.reconciled()); assertEquals(3, watermarks.get()); assertEquals(3, pages.get()); assertEquals(1002, inventory.tip().getInt("height"));
    }

    @Test public void expiredReadbackReturnsFreshInventoryAndDoesNotReuseUnreconciledState() throws Exception {
        AtomicInteger watermarks = new AtomicInteger(), pages = new AtomicInteger(), drains = new AtomicInteger();
        MobilePaymentFunding.Session session = session((method, params) -> {
            if (method.equals("getaddressutxos")) { pages.incrementAndGet(); return page(0, watermarks.get(), watermarks.get(), 1000); }
            if (!params.has("cursor")) { watermarks.incrementAndGet(); return journal("journal_0.sig", 0, false, new JSONArray(), 1000); }
            if (drains.getAndIncrement() == 1) throw expired();
            return journal("journal_1.sig", 0, false, new JSONArray(), 1000);
        });
        NativePaymentInventory original = MobilePaymentPreparation.inventory(ADDRESS, new JSONObject(), session);
        NativePaymentInventory refreshed = MobilePaymentPreparation.refresh(original, new JSONObject(), session);
        assertNotSame(original, refreshed); assertTrue(refreshed.reconciled()); assertEquals(2, refreshed.rowCount());
        assertEquals(2, watermarks.get()); assertEquals(2, pages.get()); assertEquals(3, drains.get());
        assertFalse(original.reconciled());
    }

    @Test public void expiredRefreshHasThreeTotalAttemptsIncludingItsInitialJournalRead() throws Exception {
        AtomicInteger watermarks = new AtomicInteger(), pages = new AtomicInteger(), drains = new AtomicInteger(); AtomicBoolean expired = new AtomicBoolean();
        MobilePaymentFunding.Session session = session((method, params) -> {
            if (method.equals("getaddressutxos")) { pages.incrementAndGet(); return page(0, 1, 1, 1000); }
            if (!params.has("cursor")) { watermarks.incrementAndGet(); return journal("journal_0.sig", 0, false, new JSONArray(), 1000); }
            drains.incrementAndGet(); if (expired.get()) throw expired();
            return journal("journal_1.sig", 0, false, new JSONArray(), 1000);
        });
        NativePaymentInventory inventory = MobilePaymentPreparation.inventory(ADDRESS, new JSONObject(), session); expired.set(true);
        assertThrows(MobileRpcClient.RpcFailure.class, () -> MobilePaymentPreparation.refresh(inventory, new JSONObject(), session));
        assertEquals(3, watermarks.get()); assertEquals(3, pages.get()); assertEquals(4, drains.get());
    }

    @Test public void malformedDataWrongNetworkAndUnexpectedEpochNeverTriggerBaselineFallback() throws Exception {
        for (String problem : new String[]{"fields", "network", "epoch", "amount"}) {
            AtomicInteger watermarks = new AtomicInteger(), reads = new AtomicInteger();
            MobilePaymentFunding.Session session = session((method, params) -> {
                reads.incrementAndGet();
                if (method.equals("getaddressutxos")) {
                    JSONObject page = page(0, 1, 1, 1001);
                    if (problem.equals("amount")) page.getJSONArray("items").getJSONObject(0).put("amount", "broken");
                    return page;
                }
                boolean watermark = !params.has("cursor"); if (watermark) watermarks.incrementAndGet();
                JSONObject result = journal(watermark ? "journal_0.sig" : "journal_1.sig", 0, false, new JSONArray(), watermark ? 1000 : 1002);
                if (watermark && problem.equals("fields")) result.put("unexpected", true);
                if (watermark && problem.equals("network")) result.getJSONObject("tip").put("genesis_hash", hash(0));
                if (!watermark && problem.equals("epoch")) result.put("journal_epoch", 2);
                return result;
            });
            assertThrows(IllegalArgumentException.class, () -> MobilePaymentPreparation.inventory(ADDRESS, new JSONObject(), session));
            assertEquals(problem, 1, watermarks.get()); assertTrue(reads.get() <= 3);
        }
    }

    @Test public void cancellingDuringBaselineOrExpiredCursorStopsBeforeAnyRetry() throws Exception {
        for (boolean expired : new boolean[]{false, true}) {
            AtomicBoolean cancelled = new AtomicBoolean(); AtomicInteger calls = new AtomicInteger();
            MobilePaymentFunding.Session session = session((method, params) -> {
                calls.incrementAndGet();
                if (method.equals("getaddresschanges")) return journal("journal_0.sig", 0, false, new JSONArray(), 1000);
                cancelled.set(true);
                if (expired) throw expired();
                return page(0, 500, 1205, 1000);
            }, () -> { if (cancelled.get()) throw new InterruptedException("Synthetic payment cancelled"); });
            assertThrows(InterruptedException.class, () -> MobilePaymentPreparation.inventory(ADDRESS, new JSONObject(), session)); assertEquals(2, calls.get());
        }
    }
}
