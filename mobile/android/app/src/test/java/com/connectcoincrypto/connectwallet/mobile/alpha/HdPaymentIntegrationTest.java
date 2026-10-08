package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.*;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Public deterministic fixtures only; never reads wallets, network or funds. */
public class HdPaymentIntegrationTest {
    private static final String WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    private static final long VALUE = 30_000_000_000L;
    private static JSONObject tip() throws Exception {
        return new JSONObject().put("chain", "main").put("genesis_hash", NativePaymentChecks.GENESIS)
            .put("height", 200).put("hash", "ab".repeat(32)).put("mediantime", 1700000000);
    }
    private static final class Fixtures implements MobilePaymentFunding.Reader, AutoCloseable {
        final VaultSession wallet = new VaultSession(WORDS, "");
        final JSONArray accounts = new JSONArray();
        final Map<String, JSONObject> rows = new LinkedHashMap<>();
        final Map<String, String> parents = new LinkedHashMap<>();
        final AtomicInteger inFlight = new AtomicInteger(), maximum = new AtomicInteger();
        final CountDownLatch firstReads;
        volatile boolean reserved;
        Fixtures() throws Exception { this(3); }
        Fixtures(int expectedReads) throws Exception {
            firstReads = new CountDownLatch(expectedReads);
            int counter = 0;
            for (int[] path : new int[][]{{0,0}, {7,0}, {4,1}}) {
                JSONObject account = wallet.publicAccount(path[0], path[1]); accounts.put(account);
                JSONObject output = new JSONObject().put("type", 1).put("amount", Long.toString(VALUE)).put("publicKey", account.getString("publicKey"));
                JSONObject parent = new JSONObject().put("version", 2).put("locktime", ++counter)
                    .put("inputs", new JSONArray().put(new JSONObject().put("txid", "00".repeat(32)).put("vout", 0xffffffffL)
                        .put("scriptSig", "0101").put("sequence", 0xffffffffL).put("witness", new JSONArray())))
                    .put("outputs", new JSONArray().put(output));
                String txid = NativeTransactions.txid(parent);
                parents.put(txid, WalletCrypto.hex(NativeTransactions.serialize(parent, false)));
                rows.put(account.getString("address"), new JSONObject().put("txid", txid).put("vout", 0).put("amount", Long.toString(VALUE))
                    .put("block_height", 100).put("status", "confirmed").put("confirmations", 101)
                    .put("coinbase", false).put("mature", true).put("pending_spent_by", JSONObject.NULL));
            }
        }
        public JSONObject read(String method, JSONObject params) throws Exception {
            int count = inFlight.incrementAndGet(); maximum.accumulateAndGet(count, Math::max);
            try {
                if (method.equals("gettransactions")) {
                    JSONArray result = new JSONArray(), ids = params.getJSONArray("txids");
                    for (int i = 0; i < ids.length(); i++) result.put(new JSONObject().put("txid", ids.getString(i)).put("hex", parents.get(ids.getString(i))));
                    return new JSONObject().put("tip", tip()).put("transactions", result).put("remaining", new JSONArray());
                }
                if (method.equals("getaddressutxos")) {
                    firstReads.countDown(); assertTrue(firstReads.await(5, TimeUnit.SECONDS));
                    return new JSONObject().put("address", params.getString("address"))
                        .put("tip", tip()).put("unit", "connects").put("live", true)
                        .put("items", new JSONArray().put(new JSONObject(rows.get(params.getString("address")).toString()))).put("next_cursor", JSONObject.NULL);
                }
                assertEquals("getaddresschanges", method);
                JSONArray addresses = params.getJSONArray("addresses");
                JSONArray changes = new JSONArray();
                if (reserved && params.has("cursor")) {
                    for (int i = 0; i < addresses.length(); i++) {
                        String address = addresses.getString(i);
                        JSONObject row = new JSONObject(rows.get(address).toString()).put("pending_spent_by", "cd".repeat(32));
                        changes.put(new JSONObject().put("sequence", i + 1).put("address", address).put("kind", "utxo").put("action", "upsert")
                            .put("txid", row.getString("txid")).put("vout", 0).put("item", row));
                    }
                }
                return new JSONObject().put("tip", tip()).put("unit", "connects").put("changes", changes)
                    .put("next_cursor", reserved ? "journal1.sig" : "journal0.sig").put("has_more", false)
                    .put("through_sequence", reserved ? addresses.length() : 0).put("journal_epoch", 1);
            } finally { inFlight.decrementAndGet(); }
        }
        MobilePaymentFunding.Session preparation(MobilePaymentFunding funding) { return funding.session(this, () -> {}, (stage, done, total, retry) -> {}); }
        String key(JSONObject input) throws Exception {
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject account = accounts.getJSONObject(i);
                if (account.getInt("index") == input.getInt("index") && account.getInt("change") == input.getInt("change")) return account.getString("publicKey");
            }
            throw new IllegalArgumentException("Foreign native path");
        }
        public void close() { wallet.close(); }
    }
    @Test public void mixedReceiveAndChangeInputsKeepTheirPathsAndSignAllThreeOwners() throws Exception {
        try (Fixtures fixture = new Fixtures()) {
            MobilePaymentFunding funding = new MobilePaymentFunding();
            MobilePaymentFunding.Session session = fixture.preparation(funding);
            MobilePaymentPreparation.HdInventory inventory = MobilePaymentPreparation.inventory(fixture.accounts, new JSONObject(), session);
            assertEquals(3, fixture.maximum.get()); assertEquals(3, inventory.candidates().length());
            String destination = fixture.wallet.publicAccount(20, 0).getString("address");
            String change = fixture.wallet.publicAccount(5, 1).getString("address");
            JSONObject plan = NativeTransactions.planPayment(inventory.candidates(), new JSONArray().put(new JSONObject().put("address", destination).put("amount", "75000000000")), change, 1500, false);
            JSONArray selected = funding.load(plan.getJSONArray("selected"), fixture::key, session);
            plan.put("selected", selected); assertEquals(3, selected.length());
            inventory.verifySelected(selected, false, null);
            JSONObject signed = NativeTransactions.signPayment(plan, fixture.wallet);
            JSONObject tx = NativeTransactions.parse(signed.getString("hex")); JSONArray spent = new JSONArray();
            for (int i = 0; i < selected.length(); i++) spent.put(NativeTransactions.verifyFunding(selected.getJSONObject(i), fixture.key(selected.getJSONObject(i))));
            for (int i = 0; i < selected.length(); i++) {
                byte[] signature = WalletCrypto.fromHex(tx.getJSONArray("inputs").getJSONObject(i).getJSONArray("witness").getString(0));
                assertTrue(WalletCrypto.verifySchnorr(signature, NativeTransactions.signatureHash(tx, spent, i), WalletCrypto.fromHex(fixture.key(selected.getJSONObject(i)))));
            }
        }
    }
    @Test public void aggregateUseAllAndNativePathSpoofingFailClosed() throws Exception {
        try (Fixtures fixture = new Fixtures()) {
            MobilePaymentFunding funding = new MobilePaymentFunding(); MobilePaymentFunding.Session session = fixture.preparation(funding);
            MobilePaymentPreparation.HdInventory inventory = MobilePaymentPreparation.inventory(fixture.accounts, new JSONObject(), session);
            JSONArray selected = funding.load(inventory.candidates(), fixture::key, session);
            inventory.verifySelected(selected, true, "90000000000");
            assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(selected, true, "60000000000"));
            JSONArray forged = new JSONArray(selected.toString()); forged.getJSONObject(0).put("index", 999);
            assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(forged, false, null));
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.verifyFundingBatch(forged, fixture::key, () -> {}));
            fixture.reserved = true;
            MobilePaymentPreparation.HdInventory refreshed = MobilePaymentPreparation.refresh(inventory, new JSONObject(), session);
            assertThrows(IllegalArgumentException.class, () -> refreshed.verifySelected(selected, false, null));
            assertEquals(0, refreshed.candidates().length()); assertEquals(3, refreshed.pendingCandidates().length());
        }
    }
    @Test public void duplicateAndForeignNativeAddressMetadataAreRejectedBeforeReads() throws Exception {
        try (Fixtures fixture = new Fixtures()) {
            MobilePaymentFunding.Session session = fixture.preparation(new MobilePaymentFunding());
            JSONArray duplicate = new JSONArray().put(fixture.accounts.getJSONObject(0)).put(fixture.accounts.getJSONObject(0));
            assertThrows(IllegalArgumentException.class, () -> MobilePaymentPreparation.inventory(duplicate, new JSONObject(), session));
            JSONArray wrong = new JSONArray().put(new JSONObject(fixture.accounts.getJSONObject(0).toString()).put("change", 2));
            assertThrows(IllegalArgumentException.class, () -> MobilePaymentPreparation.inventory(wrong, new JSONObject(), session));
            assertEquals(0, fixture.maximum.get());
        }
    }
    @Test public void paymentBatchChecksTheUniqueAggregateScopeAndFreshReservations() throws Exception {
        try (Fixtures fixture = new Fixtures()) {
            MobilePaymentFunding.Session session = fixture.preparation(new MobilePaymentFunding());
            MobilePaymentPreparation.HdInventory inventory = MobilePaymentPreparation.inventory(fixture.accounts, new JSONObject(), session);
            JSONArray selected = inventory.candidates();
            JSONArray plans = new JSONArray()
                .put(new JSONObject().put("selected", new JSONArray().put(selected.getJSONObject(0)).put(selected.getJSONObject(1))))
                .put(new JSONObject().put("selected", new JSONArray().put(selected.getJSONObject(2))));
            inventory.verifyBatch(plans, true, "90000000000");
            inventory.verifyBatch(plans, false, null);
            assertThrows(IllegalArgumentException.class, () -> inventory.verifyBatch(plans, true, "60000000000"));
            JSONArray duplicate = new JSONArray(plans.toString());
            duplicate.getJSONObject(1).getJSONArray("selected").put(selected.getJSONObject(0));
            assertThrows(IllegalArgumentException.class, () -> inventory.verifyBatch(duplicate, false, null));
            JSONArray missing = new JSONArray()
                .put(new JSONObject().put("selected", new JSONArray().put(selected.getJSONObject(0))))
                .put(new JSONObject().put("selected", new JSONArray().put(selected.getJSONObject(1))));
            assertThrows(IllegalArgumentException.class, () -> inventory.verifyBatch(missing, true, "90000000000"));
            inventory.verifyBatch(missing, false, null);
            fixture.reserved = true;
            MobilePaymentPreparation.HdInventory refreshed = MobilePaymentPreparation.refresh(inventory, new JSONObject(), session);
            assertThrows(IllegalArgumentException.class, () -> refreshed.verifyBatch(plans, false, null));
        }
    }
    @Test public void subsetSweepReadsAndReconcilesOnlySelectedNativeAddressesWithoutEnlargingFunds() throws Exception {
        try (Fixtures fixture = new Fixtures(1)) {
            String source = fixture.accounts.getJSONObject(1).getString("address");
            String destination = fixture.wallet.publicAccount(20, 0).getString("address");
            String change = fixture.wallet.publicAccount(5, 1).getString("address");
            NativeSendPolicy.Request send = NativeSendPolicy.request(new JSONObject().put("address", destination)
                .put("amount", "3").put("feeRate", "1500").put("subtractFeeFromAmount", true).put("useAllBalance", true)
                .put("fundingAddresses", new JSONArray().put(source)));
            JSONArray selectedAccounts = send.fundingScope.select(fixture.accounts);
            assertEquals(1, selectedAccounts.length()); assertEquals(7, selectedAccounts.getJSONObject(0).getInt("index"));
            AtomicInteger outputReads = new AtomicInteger(), journalReads = new AtomicInteger();
            MobilePaymentFunding.Reader reader = (method, params) -> {
                if (method.equals("getaddressutxos")) {
                    assertEquals(source, params.getString("address")); outputReads.incrementAndGet();
                } else if (method.equals("getaddresschanges")) {
                    assertEquals(1, params.getJSONArray("addresses").length());
                    assertEquals(source, params.getJSONArray("addresses").getString(0)); journalReads.incrementAndGet();
                } else assertEquals("gettransactions", method);
                return fixture.read(method, params);
            };
            MobilePaymentFunding funding = new MobilePaymentFunding();
            MobilePaymentFunding.Session preparation = funding.session(reader, () -> {}, (stage, done, total, retry) -> {});
            MobilePaymentPreparation.HdInventory inventory = MobilePaymentPreparation.inventory(selectedAccounts, new JSONObject(), preparation);
            assertEquals(1, outputReads.get()); assertEquals(2, journalReads.get());
            JSONObject plan = send.plan(inventory.candidates(), change);
            JSONArray selected = funding.load(plan.getJSONArray("selected"), fixture::key, preparation);
            plan.put("selected", selected); send.verifyPlan(plan, change);
            assertEquals(1, selected.length()); assertEquals("30000000000", plan.getString("inputTotal")); assertEquals("0", plan.getString("change"));
            inventory.verifySelected(selected, true, "30000000000");
            assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(selected, true, "90000000000"));
            JSONObject signed = NativeTransactions.signPayment(plan, fixture.wallet);
            assertEquals(1, NativeTransactions.parse(signed.getString("hex")).getJSONArray("inputs").length());
            MobilePaymentPreparation.HdInventory refreshed = MobilePaymentPreparation.refresh(inventory, new JSONObject(), preparation);
            refreshed.verifySelected(selected, true, "30000000000");
            assertEquals(1, outputReads.get()); assertEquals(3, journalReads.get());
            fixture.reserved = true;
            MobilePaymentPreparation.HdInventory spent = MobilePaymentPreparation.refresh(refreshed, new JSONObject(), preparation);
            assertThrows(IllegalArgumentException.class, () -> spent.verifySelected(selected, true, "30000000000"));
            assertEquals(0, spent.candidates().length()); assertEquals(1, outputReads.get()); assertEquals(4, journalReads.get());
        }
    }
    @Test public void sharedFrozenJournalPreventsCrossAddressTransferDoubleCounting() throws Exception {
        try (Fixtures fixture = new Fixtures()) {
            String first = fixture.accounts.getJSONObject(0).getString("address"), second = fixture.accounts.getJSONObject(1).getString("address");
            JSONObject incoming = new JSONObject(fixture.rows.get(second).toString()).put("txid", "ef".repeat(32)).put("amount", "29900000000")
                .put("block_height", 200).put("confirmations", 1);
            AtomicInteger watermarkCalls = new AtomicInteger(), drainCalls = new AtomicInteger();
            MobilePaymentFunding.Reader reader = (method, params) -> {
                if (method.equals("getaddressutxos")) {
                    JSONObject response = fixture.read(method, params);
                    // The transfer becomes visible between address baselines:
                    // old input is still present in the first captured page.
                    if (second.equals(params.getString("address"))) response.getJSONArray("items").put(new JSONObject(incoming.toString()));
                    return response;
                }
                assertEquals("getaddresschanges", method); assertEquals(3, params.getJSONArray("addresses").length());
                if (!params.has("cursor")) { watermarkCalls.incrementAndGet(); return fixture.read(method, params); }
                int page = drainCalls.getAndIncrement(); JSONArray changes = new JSONArray();
                if (page == 0) changes.put(new JSONObject().put("sequence", 1).put("address", first).put("kind", "utxo").put("action", "remove")
                    .put("txid", fixture.rows.get(first).getString("txid")).put("vout", 0));
                else changes.put(new JSONObject().put("sequence", 2).put("address", second).put("kind", "utxo").put("action", "upsert")
                    .put("txid", incoming.getString("txid")).put("vout", 0).put("item", incoming));
                return new JSONObject().put("tip", tip()).put("unit", "connects").put("changes", changes).put("next_cursor", page == 0 ? "journal1.sig" : "journal2.sig")
                    .put("has_more", page == 0).put("through_sequence", 2).put("journal_epoch", 1);
            };
            MobilePaymentFunding.Session session = new MobilePaymentFunding().session(reader, () -> {}, (stage, done, total, retry) -> {});
            MobilePaymentPreparation.HdInventory inventory = MobilePaymentPreparation.inventory(fixture.accounts, new JSONObject(), session);
            assertEquals(1, watermarkCalls.get()); assertEquals(2, drainCalls.get());
            JSONArray selected = inventory.candidates(); assertEquals(3, selected.length());
            inventory.verifySelected(selected, true, "89900000000");
            assertThrows(IllegalArgumentException.class, () -> inventory.verifySelected(selected, true, "119900000000"));
        }
    }
}
