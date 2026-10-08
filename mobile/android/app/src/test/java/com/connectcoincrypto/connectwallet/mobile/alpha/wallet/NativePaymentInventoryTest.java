package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import java.util.List;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Deterministic public metadata only: no wallet, device, RPC or broadcast. */
public class NativePaymentInventoryTest {
    private JSONObject fixture() throws Exception { return new JSONObject(TransactionVectors.JSON); }
    private String address() throws Exception { return fixture().getString("rewardAddress"); }
    private JSONObject tip() throws Exception {
        return new JSONObject().put("chain", "main").put("genesis_hash", NativePaymentChecks.GENESIS)
            .put("height", 120).put("hash", "aa".repeat(32)).put("mediantime", 1700000000);
    }
    private JSONObject row(int vout) throws Exception {
        return new JSONObject().put("txid", "bb".repeat(32)).put("vout", vout).put("amount", "30000")
            .put("block_height", 10).put("status", "confirmed").put("confirmations", 111)
            .put("coinbase", false).put("mature", true).put("pending_spent_by", JSONObject.NULL);
    }
    private String key(int vout) { return "bb".repeat(32) + ":" + vout; }
    private JSONArray rows(int start, int count) throws Exception {
        JSONArray result = new JSONArray();
        for (int i = start; i < start + count; i++) result.put(row(i));
        return result;
    }
    private JSONObject page(JSONArray rows, String cursor) throws Exception {
        return new JSONObject().put("address", address()).put("tip", tip()).put("unit", "connects")
            .put("live", true).put("items", rows).put("next_cursor", cursor == null ? JSONObject.NULL : cursor);
    }
    private NativePaymentInventory inventory() throws Exception {
        return new NativePaymentInventory(address(), tip(), new JSONObject());
    }
    private NativePaymentInventory complete(JSONArray rows, JSONObject reservations) throws Exception {
        NativePaymentInventory result = new NativePaymentInventory(address(), tip(), reservations);
        result.accept(page(rows, null));
        return result;
    }
    private NativePaymentInventory complete(JSONArray rows) throws Exception { return complete(rows, new JSONObject()); }
    private JSONObject immature(int vout) throws Exception {
        return row(vout).put("coinbase", true).put("block_height", 119).put("confirmations", 2).put("mature", false);
    }
    private JSONObject unconfirmed(int vout) throws Exception {
        return row(vout).put("status", "pending").put("block_height", JSONObject.NULL).put("confirmations", 0);
    }
    private JSONObject tipAt(int height) throws Exception {
        return tip().put("height", height).put("hash", String.format(java.util.Locale.ROOT, "%064x", height))
            .put("mediantime", 1700000000L + height);
    }
    private JSONObject rowAt(JSONObject row, JSONObject tip) throws Exception {
        JSONObject copy = new JSONObject(row.toString());
        long confirmations = "pending".equals(copy.getString("status")) ? 0 : tip.getLong("height") - copy.getLong("block_height") + 1;
        return copy.put("confirmations", confirmations).put("mature", !copy.getBoolean("coinbase") || confirmations >= 100);
    }
    private JSONObject pageAt(JSONArray rows, String cursor, JSONObject tip) throws Exception {
        JSONArray adjusted = new JSONArray();
        for (int i = 0; i < rows.length(); i++) adjusted.put(rowAt(rows.getJSONObject(i), tip));
        return page(adjusted, cursor).put("tip", tip);
    }
    private JSONObject journal(JSONArray changes, String cursor, long through, boolean more, JSONObject tip) throws Exception {
        return new JSONObject().put("tip", tip).put("unit", "connects").put("changes", changes)
            .put("next_cursor", cursor).put("has_more", more).put("through_sequence", through).put("journal_epoch", 1);
    }
    private JSONObject watermark() throws Exception { return journal(new JSONArray(), "watermark.signature", 10, false, tip()); }
    private NativePaymentInventory live() throws Exception {
        return NativePaymentInventory.fromWatermark(address(), watermark(), new JSONObject());
    }
    private NativePaymentInventory live(NativePaymentInventory.RowBudget.Scope budget) throws Exception {
        return NativePaymentInventory.fromWatermark(address(), 0, 0, watermark(), new JSONObject(), budget);
    }
    private JSONObject remove(long sequence, int vout) throws Exception {
        return new JSONObject().put("sequence", sequence).put("address", address()).put("kind", "utxo")
            .put("action", "remove").put("txid", "bb".repeat(32)).put("vout", vout);
    }
    private JSONObject upsert(long sequence, JSONObject row, JSONObject tip) throws Exception {
        return remove(sequence, row.getInt("vout")).put("action", "upsert").put("item", rowAt(row, tip));
    }
    private JSONObject history(long sequence, JSONObject tip) throws Exception {
        JSONObject item = new JSONObject().put("txid", "bb".repeat(32)).put("status", "confirmed")
            .put("block_height", 10).put("block_hash", "cc".repeat(32)).put("received", "30000")
            .put("spent", "0").put("balance_delta", "30000").put("confirmations", tip.getLong("height") - 9);
        return new JSONObject().put("sequence", sequence).put("address", address()).put("kind", "history")
            .put("action", "upsert").put("txid", "bb".repeat(32)).put("item", item);
    }

    @Test public void sharedBudgetReservesEachPageAndReleasesFailedStagingAndDiscardedScopes() throws Exception {
        try (NativePaymentInventory.RowBudget budget = new NativePaymentInventory.RowBudget(3)) {
            NativePaymentInventory.RowBudget.Scope firstScope = budget.scope(), secondScope = budget.scope();
            NativePaymentInventory first = live(firstScope), second = live(secondScope);
            first.accept(page(rows(0, 2), "first.signature")); assertEquals(2, budget.rowCount());
            assertThrows(IllegalArgumentException.class, () -> second.accept(page(rows(10, 2), null)));
            assertEquals(0, second.rowCount()); assertEquals(2, budget.rowCount());
            // A duplicate discovered while cloning must roll its reservation back.
            assertThrows(IllegalArgumentException.class, () -> first.accept(page(rows(0, 1), null)));
            assertEquals(2, budget.rowCount()); assertEquals(2, first.rowCount());
            firstScope.close(); assertEquals(0, budget.rowCount());
            assertThrows(IllegalArgumentException.class, () -> first.accept(page(rows(2, 1), null)));
            second.accept(page(rows(10, 2), null)); assertEquals(2, budget.rowCount());
            second.applyChanges(watermark()); assertEquals(2, second.candidates().length());
            secondScope.close(); assertThrows(IllegalArgumentException.class, second::candidates);
            assertEquals(0, budget.rowCount());
        }
    }

    @Test(timeout = 15000) public void sixteenConcurrentPagesCannotOverbookTheSharedBudget() throws Exception {
        try (NativePaymentInventory.RowBudget budget = new NativePaymentInventory.RowBudget(10)) {
            NativePaymentInventory.RowBudget.Scope scope = budget.scope();
            List<NativePaymentInventory> inventories = new ArrayList<>();
            for (int i = 0; i < 16; i++) inventories.add(live(scope));
            ExecutorService workers = Executors.newFixedThreadPool(16); CountDownLatch started = new CountDownLatch(16);
            AtomicInteger accepted = new AtomicInteger(); List<Future<?>> results = new ArrayList<>();
            try {
                for (int i = 0; i < inventories.size(); i++) {
                    final int index = i;
                    results.add(workers.submit(() -> {
                        started.countDown();
                        try {
                            assertTrue(started.await(5, TimeUnit.SECONDS)); inventories.get(index).accept(page(rows(index, 1), null)); accepted.incrementAndGet();
                        } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("memory limit")); }
                        catch (Exception unexpected) { throw new RuntimeException(unexpected); }
                    }));
                }
                for (Future<?> result : results) result.get(5, TimeUnit.SECONDS);
                assertEquals(10, accepted.get()); assertEquals(10, budget.rowCount());
            } finally { workers.shutdownNow(); scope.close(); }
            assertEquals(0, budget.rowCount());
            for (NativePaymentInventory inventory : inventories) {
                int previous = inventory.rowCount();
                assertThrows(IllegalArgumentException.class, () -> inventory.accept(page(rows(20, 1), null)));
                assertEquals(previous, inventory.rowCount());
            }
        }
    }

    @Test public void sharedJournalChargesNetTransferGrowthWithoutDependingOnAddressOrder() throws Exception {
        try (NativePaymentInventory.RowBudget budget = new NativePaymentInventory.RowBudget(2)) {
            NativePaymentInventory.RowBudget.Scope scope = budget.scope();
            String other = fixture().getString("changeAddress");
            NativePaymentInventory first = live(scope);
            NativePaymentInventory second = NativePaymentInventory.fromWatermark(other, 0, 1, watermark(), new JSONObject(), scope);
            first.accept(page(rows(0, 1), null)); second.accept(page(rows(1, 1), null).put("address", other));
            assertEquals(2, budget.rowCount());
            // Adding to the first inventory before removing from the second
            // used to report a false over-limit error at a full wallet budget.
            JSONArray events = new JSONArray().put(upsert(11, row(2), tip())).put(remove(12, 1).put("address", other));
            NativePaymentInventory.applySharedChanges(List.of(first, second), journal(events, "transfer.signature", 12, false, tip()));
            assertEquals(2, budget.rowCount()); assertEquals(2, first.candidates().length()); assertEquals(0, second.candidates().length());
            first.beginRefresh(new JSONObject()); second.beginRefresh(new JSONObject());
            JSONObject growth = journal(new JSONArray().put(upsert(13, row(3), tip())), "growth.signature", 13, false, tip());
            assertThrows(IllegalArgumentException.class, () -> NativePaymentInventory.applySharedChanges(List.of(first, second), growth));
            assertEquals(2, budget.rowCount()); assertEquals(2, first.rowCount()); assertEquals(0, second.rowCount());
            assertEquals("transfer.signature", first.changesCursor()); assertEquals("transfer.signature", second.changesCursor());
            assertThrows(IllegalArgumentException.class, first::candidates); assertThrows(IllegalArgumentException.class, second::candidates);
        }
    }

    @Test public void moreThanOneThousandOutputsCanSelectASufficientCoinOnTheLastPage() throws Exception {
        NativePaymentInventory inventory = inventory();
        assertFalse(inventory.complete());
        inventory.accept(page(rows(0, 500), "page1.signature"));
        inventory.accept(page(rows(500, 500), "page2.signature"));
        JSONArray last = rows(1000, 201);
        last.getJSONObject(200).put("amount", "100000000000");
        inventory.accept(page(last, null));
        assertTrue(inventory.complete()); assertNull(inventory.nextCursor());
        assertEquals(1201, inventory.rowCount()); assertEquals(3, inventory.pageCount());
        assertEquals(1201, inventory.candidates().length()); assertEquals(0, inventory.pendingCandidates().length());
        JSONObject fixture = fixture();
        JSONObject plan = NativeTransactions.planPayment(inventory.candidates(), fixture.getJSONArray("outputs"),
            fixture.getString("changeAddress"), 1500, false);
        assertEquals(1, plan.getJSONArray("selected").length());
        assertEquals(1200, plan.getJSONArray("selected").getJSONObject(0).getInt("vout"));
        inventory.verifySelected(plan.getJSONArray("selected"), false, null);
    }

    @Test public void onlyCompleteInventoriesExposeCandidatesAndVerifySelections() throws Exception {
        NativePaymentInventory inventory = inventory();
        assertThrows(IllegalArgumentException.class, () -> inventory.candidates());
        assertThrows(IllegalArgumentException.class, () -> inventory.pendingCandidates());
        inventory.accept(page(rows(0, 1), "next.signature"));
        assertFalse(inventory.complete()); assertEquals("next.signature", inventory.nextCursor());
        assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(new JSONArray(), false, null));
        inventory.accept(page(new JSONArray(), null));
        assertTrue(inventory.complete());
        assertThrows(IllegalArgumentException.class, () -> inventory.accept(page(rows(1, 1), null)));
        assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(new JSONArray(), false, null));
    }

    @Test public void duplicatesCyclesAndEmptyContinuationNeverPublishPartialPages() throws Exception {
        NativePaymentInventory inventory = inventory();
        inventory.accept(page(rows(0, 2), "first.signature"));
        // A valid new row followed by a duplicate must not leak the first row.
        assertThrows(IllegalArgumentException.class, () -> inventory.accept(page(new JSONArray().put(row(2)).put(row(1)), null)));
        assertEquals(2, inventory.rowCount()); assertEquals(1, inventory.pageCount()); assertFalse(inventory.complete());
        assertThrows(IllegalArgumentException.class, () -> inventory.accept(page(rows(2, 1), "first.signature")));
        assertThrows(IllegalArgumentException.class, () -> inventory.accept(page(new JSONArray(), "next.signature")));
        inventory.accept(page(rows(2, 1), "second.signature"));
        assertThrows(IllegalArgumentException.class, () -> inventory.accept(page(rows(3, 1), "first.signature")));
        assertEquals(3, inventory.rowCount()); assertEquals(2, inventory.pageCount());
        assertThrows(IllegalArgumentException.class, () -> inventory.accept(page(new JSONArray().put(row(3)).put(row(3)), null)));
    }

    @Test public void onlyAnEntirelyValidPageFromAnotherMainnetTipIsRetryable() throws Exception {
        NativePaymentInventory inventory = inventory();
        JSONObject changed = page(rows(0, 1), null);
        changed.getJSONObject("tip").put("height", 121).put("hash", "cc".repeat(32)).put("mediantime", 1700000001);
        changed.getJSONArray("items").getJSONObject(0).put("confirmations", 112);
        assertThrows(NativePaymentInventory.SnapshotChanged.class, () -> inventory.accept(changed));
        assertEquals(0, inventory.rowCount()); assertEquals(0, inventory.pageCount()); assertFalse(inventory.complete());
        for (String fault : new String[]{"schema", "amount", "confirmations", "chain", "genesis"}) {
            JSONObject malformed = new JSONObject(changed.toString());
            if (fault.equals("schema")) malformed.put("extra", true);
            if (fault.equals("amount")) malformed.getJSONArray("items").getJSONObject(0).put("amount", "1e10");
            if (fault.equals("confirmations")) malformed.getJSONArray("items").getJSONObject(0).put("confirmations", 111);
            if (fault.equals("chain")) malformed.getJSONObject("tip").put("chain", "testnet4");
            if (fault.equals("genesis")) malformed.getJSONObject("tip").put("genesis_hash", "dd".repeat(32));
            IllegalArgumentException error = assertThrows(fault, IllegalArgumentException.class, () -> inventory.accept(malformed));
            assertFalse(fault, error instanceof NativePaymentInventory.SnapshotChanged);
        }
        inventory.accept(page(rows(0, 1), null));
        assertTrue(inventory.complete());
    }

    @Test public void pageAndRowLimitsApplyToAllOutputsIncludingUnavailableOnes() throws Exception {
        NativePaymentInventory pages = inventory();
        for (int i = 0; i < NativePaymentInventory.MAX_PAGES - 1; i++) {
            pages.accept(page(new JSONArray().put(unconfirmed(i)), "page" + i + ".signature"));
        }
        assertThrows(IllegalArgumentException.class, () -> pages.accept(page(rows(600, 1), "overflow.signature")));
        assertEquals(NativePaymentInventory.MAX_PAGES - 1, pages.pageCount());
        pages.accept(page(new JSONArray().put(immature(600)), null));
        assertEquals(NativePaymentInventory.MAX_PAGES, pages.pageCount()); assertEquals(0, pages.candidates().length());
        NativePaymentInventory bounded = inventory();
        int count = NativeTransactions.MAX_PAYMENT_CANDIDATES;
        for (int start = 0; start < count; start += 500) {
            bounded.accept(page(rows(start, Math.min(500, count - start)), "batch" + start + ".signature"));
        }
        assertThrows(IllegalArgumentException.class, () -> bounded.accept(page(rows(count, 1), null)));
        assertEquals(count, bounded.rowCount()); assertFalse(bounded.complete());
    }

    @Test public void pendingImmatureAndLocalReservationsStayExcludedWithoutLosingOutpoints() throws Exception {
        JSONObject reservations = new JSONObject().put(key(1), "cc".repeat(32)).put(key(2), "dd".repeat(32));
        JSONArray rows = new JSONArray().put(row(0)).put(row(1)).put(row(2).put("pending_spent_by", "ee".repeat(32)))
            .put(immature(3)).put(unconfirmed(4));
        NativePaymentInventory inventory = complete(rows, reservations);
        assertEquals(5, inventory.rowCount()); assertEquals(1, inventory.candidates().length());
        JSONArray pending = inventory.pendingCandidates(); assertEquals(2, pending.length());
        assertEquals("cc".repeat(32), pending.getJSONObject(0).getString("pending_spent_by"));
        assertEquals("ee".repeat(32), pending.getJSONObject(1).getString("pending_spent_by"));
        inventory.verifySelected(pending, false, null);
        assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(pending, true, "30000"));
        for (int vout : new int[]{3, 4, 5}) {
            JSONArray selected = new JSONArray().put(row(vout).put("index", 0).put("change", 0));
            assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(selected, false, null));
        }
        assertEquals(2, reservations.length()); // The global legacy map is never pruned.
    }

    @Test public void constructorPagesAndReturnedValuesCannotMutateTheHeldSnapshot() throws Exception {
        JSONObject anchor = tip(), reservations = new JSONObject().put(key(1), "cc".repeat(32));
        NativePaymentInventory inventory = new NativePaymentInventory(address(), anchor, reservations);
        anchor.put("height", 999); reservations.put(key(1), "dd".repeat(32));
        JSONObject page = page(rows(0, 2), null); inventory.accept(page);
        page.getJSONArray("items").getJSONObject(0).put("amount", "1");
        inventory.candidates().getJSONObject(0).put("amount", "2");
        inventory.pendingCandidates().getJSONObject(0).put("pending_spent_by", JSONObject.NULL);
        inventory.tip().put("height", 1000);
        assertEquals("30000", inventory.candidates().getJSONObject(0).getString("amount"));
        assertEquals("cc".repeat(32), inventory.pendingCandidates().getJSONObject(0).getString("pending_spent_by"));
        assertEquals(120, inventory.tip().getInt("height"));
    }

    @Test public void freshSelectionRejectsSpentChangedImmatureAndNewlyReservedInputs() throws Exception {
        JSONArray selected = complete(rows(0, 1)).candidates();
        for (JSONArray changed : new JSONArray[]{new JSONArray(), new JSONArray().put(row(0).put("amount", "30001")),
                new JSONArray().put(immature(0)), new JSONArray().put(unconfirmed(0)),
                new JSONArray().put(row(0).put("pending_spent_by", "cc".repeat(32)))}) {
            NativePaymentInventory fresh = complete(changed);
            assertThrows(IllegalArgumentException.class, () -> fresh.verifySelected(selected, false, null));
        }
        NativePaymentInventory reserved = complete(rows(0, 1), new JSONObject().put(key(0), "dd".repeat(32)));
        assertThrows(IllegalArgumentException.class, () -> reserved.verifySelected(selected, false, null));
        JSONArray reviewedReserved = reserved.pendingCandidates();
        reserved.verifySelected(reviewedReserved, false, null);
        NativePaymentInventory cleared = complete(rows(0, 1));
        assertThrows(IllegalArgumentException.class, () -> cleared.verifySelected(reviewedReserved, false, null));
        for (String field : new String[]{"amount", "index", "change", "pending_spent_by", "vout"}) {
            JSONArray altered = new JSONArray(selected.toString());
            if (field.equals("pending_spent_by")) altered.getJSONObject(0).remove(field);
            else altered.getJSONObject(0).put(field, field.equals("amount") ? "30001" : field.equals("vout") ? "0" : 1);
            assertThrows(field, IllegalArgumentException.class, () -> cleared.verifySelected(altered, false, null));
        }
        assertThrows(IllegalArgumentException.class, () -> cleared.verifySelected(new JSONArray().put(selected.getJSONObject(0)).put(selected.getJSONObject(0)), false, null));
        JSONArray excessive = new JSONArray();
        for (int i = 0; i <= NativeTransactions.MAX_PAYMENT_INPUTS; i++) excessive.put(selected.getJSONObject(0));
        assertThrows(IllegalArgumentException.class, () -> cleared.verifySelected(excessive, false, null));
    }

    @Test public void useAllRequiresTheSameFreeBalanceAndTheSameReviewedInputs() throws Exception {
        NativePaymentInventory original = complete(rows(0, 2));
        JSONArray selected = original.candidates();
        original.verifySelected(selected, true, "60000");
        NativePaymentInventory added = complete(rows(0, 3));
        assertThrows(IllegalArgumentException.class, () -> added.verifySelected(selected, true, "60000"));
        assertThrows(IllegalArgumentException.class, () -> original.verifySelected(new JSONArray().put(selected.getJSONObject(0)), true, "60000"));
        assertThrows(IllegalArgumentException.class, () -> original.verifySelected(selected, true, "60001"));
        NativePaymentInventory addedUnavailable = complete(new JSONArray().put(row(0)).put(row(1)).put(immature(2)).put(unconfirmed(3))
            .put(row(4).put("pending_spent_by", "dd".repeat(32))));
        addedUnavailable.verifySelected(selected, true, "60000");
        added.verifySelected(selected, false, null); // Ordinary payments do not silently add new inputs.
        assertEquals(2, selected.length());
    }

    @Test public void liveBaselineSurvivesAdvancingTipsAndReplaysBehindCursorChanges() throws Exception {
        NativePaymentInventory inventory = live();
        assertEquals(address(), inventory.address()); assertEquals("watermark.signature", inventory.changesCursor());
        assertFalse(inventory.reconciled());
        inventory.accept(pageAt(new JSONArray().put(row(10)), "baseline.signature", tipAt(121)));
        inventory.accept(pageAt(new JSONArray().put(row(20)), null, tipAt(123)));
        assertTrue(inventory.complete()); assertFalse(inventory.reconciled());
        assertThrows(IllegalArgumentException.class, () -> inventory.candidates());
        assertThrows(IllegalArgumentException.class, () -> inventory.pendingCandidates());
        JSONObject tip = tipAt(124);
        JSONArray first = new JSONArray().put(remove(11, 10)).put(upsert(12, row(5), tip))
            .put(upsert(13, row(20).put("amount", "30001"), tip)).put(history(14, tip));
        inventory.applyChanges(journal(first, "first.signature", 15, true, tip));
        assertEquals("first.signature", inventory.changesCursor()); assertFalse(inventory.reconciled());
        assertThrows(IllegalArgumentException.class, () -> inventory.candidates());
        inventory.applyChanges(journal(new JSONArray().put(upsert(15, row(30), tip)), "final.signature", 15, false, tip));
        assertTrue(inventory.reconciled()); assertEquals(3, inventory.rowCount()); assertEquals(124, inventory.tip().getInt("height"));
        JSONArray candidates = inventory.candidates(); long total = 0; boolean sawBehindCursor = false;
        for (int i = 0; i < candidates.length(); i++) {
            JSONObject candidate = candidates.getJSONObject(i); assertNotEquals(10, candidate.getInt("vout"));
            if (candidate.getInt("vout") == 5) sawBehindCursor = true;
            assertEquals(115, candidate.getLong("confirmations")); total += Long.parseLong(candidate.getString("amount"));
        }
        assertTrue(sawBehindCursor); assertEquals(90001, total);
        inventory.verifySelected(candidates, true, "90001");
        assertThrows(IllegalArgumentException.class, () -> inventory.applyChanges(journal(new JSONArray(), "final.signature", 15, false, tip)));
    }

    @Test public void netZeroBalanceChangesStillInvalidateTheReviewedInputs() throws Exception {
        NativePaymentInventory inventory = live(); inventory.accept(page(rows(0, 1), null));
        inventory.applyChanges(journal(new JSONArray(), "watermark.signature", 10, false, tip()));
        JSONArray selected = inventory.candidates(); inventory.verifySelected(selected, true, "30000");
        inventory.beginRefresh(new JSONObject()); assertFalse(inventory.reconciled());
        assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(selected, true, "30000"));
        JSONObject tip = tipAt(121);
        inventory.applyChanges(journal(new JSONArray().put(remove(11, 0)).put(upsert(12, row(1), tip)), "replaced.signature", 12, false, tip));
        assertEquals("30000", inventory.candidates().getJSONObject(0).getString("amount"));
        assertEquals(1, inventory.candidates().getJSONObject(0).getInt("vout"));
        assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(selected, true, "30000"));
        inventory.verifySelected(inventory.candidates(), true, "30000");
    }

    @Test public void finalJournalTipProjectsCoinbaseMaturityAndRefreshesLocalReservations() throws Exception {
        JSONObject reservations = new JSONObject().put(key(1), "cc".repeat(32));
        NativePaymentInventory inventory = NativePaymentInventory.fromWatermark(address(), watermark(), reservations);
        inventory.accept(pageAt(new JSONArray().put(immature(0)).put(row(1)), null, tipAt(121)));
        inventory.applyChanges(journal(new JSONArray(), "mature.signature", 10, false, tipAt(218)));
        JSONArray available = inventory.candidates(); assertEquals(1, available.length());
        assertEquals(100, available.getJSONObject(0).getLong("confirmations")); assertTrue(available.getJSONObject(0).getBoolean("mature"));
        JSONArray selectedReserved = inventory.pendingCandidates(); assertEquals(1, selectedReserved.length());
        inventory.verifySelected(selectedReserved, false, null);
        JSONObject replacementReservations = new JSONObject().put(key(1), "dd".repeat(32));
        inventory.beginRefresh(replacementReservations); replacementReservations.put(key(1), "ee".repeat(32));
        inventory.applyChanges(journal(new JSONArray(), "refreshed.signature", 10, false, tipAt(219)));
        assertEquals("dd".repeat(32), inventory.pendingCandidates().getJSONObject(0).getString("pending_spent_by"));
        assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(selectedReserved, false, null));
        inventory.beginRefresh(new JSONObject());
        inventory.applyChanges(journal(new JSONArray(), "cleared.signature", 10, false, tipAt(219)));
        assertEquals(2, inventory.candidates().length()); assertEquals(0, inventory.pendingCandidates().length());
        assertEquals("cc".repeat(32), reservations.getString(key(1))); // Storage itself was never changed.
    }

    @Test public void journalPendingTransitionsApplyBeforeSelectionAndUseAllChecks() throws Exception {
        NativePaymentInventory inventory = live(); inventory.accept(page(rows(0, 2), null));
        JSONObject tip = tipAt(121);
        inventory.applyChanges(journal(new JSONArray().put(upsert(11, row(0).put("pending_spent_by", "cc".repeat(32)), tip))
            .put(upsert(12, unconfirmed(2), tip)), "pending.signature", 12, false, tip));
        assertEquals(3, inventory.rowCount()); assertEquals(1, inventory.candidates().length());
        assertEquals(1, inventory.pendingCandidates().length());
        JSONArray selected = inventory.candidates(); inventory.verifySelected(selected, true, "30000");
        inventory.beginRefresh(new JSONObject());
        inventory.applyChanges(journal(new JSONArray().put(upsert(13, row(2).put("block_height", 122), tipAt(122))),
            "confirmed.signature", 13, false, tipAt(122)));
        assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(selected, true, "30000"));
        inventory.verifySelected(selected, false, null);
    }

    @Test public void journalRejectsWrongScopeEpochSchemaSequenceAndPayloadWithoutPublishing() throws Exception {
        NativePaymentInventory inventory = live(); inventory.accept(page(rows(0, 1), null));
        JSONObject tip = tipAt(121);
        for (String fault : new String[]{"address", "epoch", "through", "sequence", "item", "amount", "schema", "history", "network", "cursor", "empty"}) {
            JSONArray events = new JSONArray().put(upsert(11, row(1), tip)).put(upsert(12, row(2), tip));
            JSONObject response = journal(events, "valid.signature", 12, false, tip);
            JSONObject last = events.getJSONObject(1);
            if (fault.equals("address")) last.put("address", fixture().getString("changeAddress"));
            if (fault.equals("epoch")) response.put("journal_epoch", 2);
            if (fault.equals("through")) response.put("through_sequence", 11);
            if (fault.equals("sequence")) last.put("sequence", 11);
            if (fault.equals("item")) last.getJSONObject("item").put("vout", 99);
            if (fault.equals("amount")) last.getJSONObject("item").put("amount", "3e4");
            if (fault.equals("schema")) last.put("extra", true);
            if (fault.equals("history")) { JSONObject bad = history(12, tip); bad.getJSONObject("item").put("balance_delta", "29999"); events.put(1, bad); }
            if (fault.equals("network")) response.put("tip", tipAt(121).put("genesis_hash", "ff".repeat(32)));
            if (fault.equals("cursor")) response.put("next_cursor", "watermark.signature");
            if (fault.equals("empty")) response.put("changes", new JSONArray()).put("has_more", true);
            IllegalArgumentException error = assertThrows(fault, IllegalArgumentException.class, () -> inventory.applyChanges(response));
            assertFalse(fault, error instanceof NativePaymentInventory.SnapshotChanged);
            assertEquals(1, inventory.rowCount()); assertEquals("watermark.signature", inventory.changesCursor()); assertFalse(inventory.reconciled());
        }
        inventory.applyChanges(journal(new JSONArray(), "watermark.signature", 10, false, tip));
        assertEquals(1, inventory.candidates().length());
    }

    @Test public void journalDrainFreezesTipWatermarkAndForbidsCursorCycles() throws Exception {
        NativePaymentInventory inventory = live(); inventory.accept(page(rows(0, 1), null)); JSONObject tip = tipAt(121);
        inventory.applyChanges(journal(new JSONArray().put(remove(11, 0)), "first.signature", 14, true, tip));
        assertEquals(0, inventory.rowCount());
        for (String fault : new String[]{"tip", "watermark", "sequence", "cursor", "epoch"}) {
            JSONObject response = journal(new JSONArray().put(upsert(12, row(2), tip)), "second.signature", 14, true, tip);
            if (fault.equals("tip")) response = journal(new JSONArray().put(upsert(12, row(2), tipAt(122))), "second.signature", 14, true, tipAt(122));
            if (fault.equals("watermark")) response.put("through_sequence", 15);
            if (fault.equals("sequence")) response.getJSONArray("changes").getJSONObject(0).put("sequence", 11);
            if (fault.equals("cursor")) response.put("next_cursor", "watermark.signature");
            if (fault.equals("epoch")) response.put("journal_epoch", 2);
            JSONObject invalid = response;
            assertThrows(fault, IllegalArgumentException.class, () -> inventory.applyChanges(invalid));
            assertEquals(0, inventory.rowCount()); assertEquals("first.signature", inventory.changesCursor());
        }
        inventory.applyChanges(journal(new JSONArray().put(upsert(14, row(2), tip)), "last.signature", 14, false, tip));
        assertTrue(inventory.reconciled()); assertEquals(1, inventory.candidates().length());
    }

    @Test public void journalWatermarkAndPageBoundsFailClosed() throws Exception {
        for (String field : new String[]{"changes", "has_more", "through_sequence", "journal_epoch", "next_cursor"}) {
            JSONObject wrong = watermark();
            if (field.equals("changes")) wrong.put(field, new JSONArray().put(remove(11, 0)));
            if (field.equals("has_more")) wrong.put(field, true);
            if (field.equals("through_sequence")) wrong.put(field, 9_007_199_254_740_992L);
            if (field.equals("journal_epoch")) wrong.put(field, "1");
            if (field.equals("next_cursor")) wrong.put(field, JSONObject.NULL);
            assertThrows(field, IllegalArgumentException.class, () -> NativePaymentInventory.fromWatermark(address(), wrong, new JSONObject()));
        }
        NativePaymentInventory inventory = live();
        assertThrows(IllegalArgumentException.class, () -> inventory.applyChanges(watermark()));
        assertThrows(IllegalArgumentException.class, () -> inventory.beginRefresh(new JSONObject()));
        inventory.accept(page(new JSONArray(), null));
        JSONArray tooMany = new JSONArray(); for (int i = 0; i < 501; i++) tooMany.put(remove(11 + i, i));
        assertThrows(IllegalArgumentException.class, () -> inventory.applyChanges(journal(tooMany, "oversize.signature", 511, false, tip())));
        assertEquals("watermark.signature", inventory.changesCursor());
        inventory.applyChanges(journal(new JSONArray(), "advanced.signature", 100, false, tipAt(121))); // Other addresses may create sequence gaps.
        inventory.beginRefresh(new JSONObject());
        assertThrows(IllegalArgumentException.class, () -> inventory.applyChanges(journal(new JSONArray(), "old.signature", 99, false, tipAt(121))));
    }
}
