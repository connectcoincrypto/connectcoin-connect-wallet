package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import java.util.HashSet;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Public synthetic funding only: no wallet, network, signatures or broadcasts. */
public class NativeSendBatchTest {
    private static final long VALUE = 1_000_000;
    private JSONObject fixture() throws Exception { return new JSONObject(TransactionVectors.JSON); }
    private String change() throws Exception { return fixture().getString("changeAddress"); }
    private JSONArray candidates(int count) throws Exception {
        JSONArray result = new JSONArray();
        for (int i = 0; i < count; i++) result.put(new JSONObject().put("txid", "12".repeat(32)).put("vout", i)
            .put("amount", Long.toString(VALUE)).put("index", 0).put("change", 0)
            .put("mature", true).put("status", "confirmed").put("pending_spent_by", JSONObject.NULL));
        return result;
    }
    private NativeSendPolicy.Request request(long value, boolean deduct, boolean all) throws Exception {
        return request(value, deduct, all, "1500");
    }
    private NativeSendPolicy.Request request(long value, boolean deduct, boolean all, String rate) throws Exception {
        return NativeSendPolicy.request(new JSONObject().put("address", fixture().getJSONArray("outputs").getJSONObject(0).getString("address"))
            .put("amount", NativeTransactions.format(value)).put("feeRate", rate)
            .put("subtractFeeFromAmount", deduct).put("useAllBalance", all));
    }
    private long amount(JSONObject object, String field) throws Exception { return NativeTransactions.amount(object.getString(field)); }
    private JSONObject plan(NativeSendPolicy.Request request, JSONArray candidates) throws Exception {
        JSONObject batch = NativeSendBatch.plan(request, candidates, change());
        NativeSendBatch.verify(request, batch, change());
        JSONArray parts = batch.getJSONArray("plans"), selected = batch.getJSONArray("selected");
        assertEquals(parts.length(), batch.getInt("transactionCount"));
        HashSet<String> unique = new HashSet<>();
        long fees = 0, received = 0, input = 0, returned = 0;
        int at = 0;
        for (int i = 0; i < parts.length(); i++) {
            JSONObject part = parts.getJSONObject(i), tx = part.getJSONObject("transaction");
            int weight = NativeTransactions.serialize(tx, false).length * 3 + NativeTransactions.serialize(tx, true).length;
            assertTrue(weight <= 400000);
            assertTrue(part.getJSONArray("selected").length() <= 1738);
            assertEquals((weight + 3) / 4, part.getInt("vsize"));
            assertTrue(amount(part, "fee") >= (long)part.getInt("vsize") * request.feeRate);
            assertEquals(WalletCrypto.hex(WalletCrypto.decodeAddress(request.address)), tx.getJSONArray("outputs").getJSONObject(0).getString("publicKey"));
            if (i < parts.length() - 1) { assertEquals("0", part.getString("change")); assertEquals(1, tx.getJSONArray("outputs").length()); }
            for (int j = 0; j < part.getJSONArray("selected").length(); j++) {
                JSONObject funding = part.getJSONArray("selected").getJSONObject(j);
                assertTrue(unique.add(funding.getString("txid").toLowerCase(java.util.Locale.ROOT) + ":" + funding.getLong("vout")));
                assertSame(funding, selected.getJSONObject(at++));
            }
            fees += amount(part, "fee"); received += amount(part, "total");
            input += amount(part, "inputTotal"); returned += amount(part, "change");
        }
        assertEquals(at, selected.length()); assertEquals(fees, amount(batch, "fee"));
        assertEquals(received, amount(batch, "total")); assertEquals(input, amount(batch, "inputTotal"));
        assertEquals(returned, amount(batch, "change")); assertEquals(request.amount, batch.getString("requestedTotal"));
        assertEquals(input, received + fees + returned);
        if (!request.subtractFeeFromAmount) assertEquals(Long.parseLong(request.amount), received);
        if (request.useAllBalance) { assertEquals(candidates.length(), selected.length()); assertEquals(request.amount, batch.getString("inputTotal")); assertEquals(0, returned); }
        return batch;
    }
    @Test public void ordinarySinglePaymentIsWrappedWithoutChangingItsSemantics() throws Exception {
        for (boolean deduct : new boolean[]{false, true}) {
            NativeSendPolicy.Request intent = request(500000, deduct, false);
            JSONArray funding = candidates(4000);
            JSONObject expected = intent.plan(funding, change()), batch = plan(intent, funding);
            assertEquals(1, batch.getInt("transactionCount"));
            assertEquals(expected.toString(), batch.getJSONArray("plans").getJSONObject(0).toString());
            assertEquals(intent.review(expected, change()), NativeSendBatch.review(intent, batch, change()));
        }
    }
    @Test public void standardLimitSplitsOnlyAt1739ForNoChangeSweep() throws Exception {
        assertEquals(32, NativeSendBatch.MAX_TRANSACTIONS);
        for (int count : new int[]{1738, 1739}) {
            NativeSendPolicy.Request intent = request(count * VALUE, true, true);
            JSONObject batch = plan(intent, candidates(count));
            assertEquals(count == 1738 ? 1 : 2, batch.getInt("transactionCount"));
            assertEquals(count * VALUE - amount(batch, "fee"), amount(batch, "total"));
        }
        assertThrows(NativeTransactions.PaymentTooLarge.class,
            () -> request(1739 * VALUE, true, true).plan(candidates(1739), change()));
    }
    @Test public void secondOutputWeightSplits1738InputsWithoutRaisingConsensusLimit() throws Exception {
        JSONObject batch = plan(request(1738 * VALUE - 500000, true, false), candidates(1738));
        assertEquals(2, batch.getInt("transactionCount")); assertEquals("500000", batch.getString("change"));
        assertEquals(2, batch.getJSONArray("plans").getJSONObject(1).getJSONObject("transaction").getJSONArray("outputs").length());
    }
    @Test public void fourThousandInputsSupportAddedDeductedAndUseAllTotals() throws Exception {
        JSONObject added = plan(request(3_600_000_000L, false, false), candidates(4000));
        assertEquals(3, added.getInt("transactionCount")); assertEquals("3600000000", added.getString("total"));
        JSONObject deducted = plan(request(4000 * VALUE - 500000, true, false), candidates(4000));
        assertEquals(3, deducted.getInt("transactionCount")); assertEquals("500000", deducted.getString("change"));
        assertEquals(4000 * VALUE - 500000, amount(deducted, "total") + amount(deducted, "fee"));
        JSONObject all = plan(request(4000 * VALUE, true, true), candidates(4000));
        assertEquals(3, all.getInt("transactionCount"));
    }
    @Test public void tinyUneconomicalTailIsRebalancedWithoutDiscardingInputs() throws Exception {
        JSONArray funding = candidates(2238);
        for (int i = 1738; i < funding.length(); i++) funding.getJSONObject(i).put("amount", "100");
        JSONObject batch = plan(request(1738 * VALUE + 50000, true, true), funding);
        assertEquals(2, batch.getInt("transactionCount"));
        assertTrue(batch.getJSONArray("plans").getJSONObject(0).getJSONArray("selected").length() < 1738);
        assertTrue(batch.getJSONArray("plans").getJSONObject(1).getJSONArray("selected").length() > 500);
        assertTrue(amount(batch.getJSONArray("plans").getJSONObject(1), "total") >= 297);
    }
    @Test public void deductedDustAdjustmentIsDisclosedOnlyInFinalChange() throws Exception {
        NativeSendPolicy.Request intent = request(4000 * VALUE - 1, true, false);
        JSONObject batch = plan(intent, candidates(4000));
        assertEquals(297, amount(batch, "change"));
        assertEquals(296, Long.parseLong(intent.amount) - amount(batch, "total") - amount(batch, "fee"));
        String review = NativeSendBatch.review(intent, batch, change());
        assertTrue(review.contains("Kept as spendable change: 0.0000000296 CONN"));
        assertTrue(review.contains("not atomic")); assertTrue(review.contains("outcome is uncertain"));
        assertTrue(review.contains("Payment 3 of 3"));
    }
    @Test public void aggregateFeeAndCandidateSafetyCeilingsRemainEnforced() throws Exception {
        JSONArray highValue = candidates(1739);
        for (int i = 0; i < highValue.length(); i++) highValue.getJSONObject(i).put("amount", "100000000");
        IllegalArgumentException fees = assertThrows(IllegalArgumentException.class,
            () -> NativeSendBatch.plan(request(1739L * 100000000, true, true, "100000"), highValue, change()));
        assertTrue(fees.getMessage().contains("1 CONN"));
        assertThrows(IllegalArgumentException.class,
            () -> NativeSendBatch.plan(request(50001 * VALUE, true, true), candidates(50001), change()));
    }
    @Test public void fundingOnlyOneOversizedTransactionsFeeFailsAsInsufficient() throws Exception {
        int inputs = 1739;
        int hypotheticalWeight = (8 + 3 + 41 * inputs + 1 + 41) * 4 + 2 + 66 * inputs;
        long hypotheticalFee = (long)((hypotheticalWeight + 3) / 4) * 1500;
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
            () -> NativeSendBatch.plan(request(inputs * VALUE - hypotheticalFee, false, false), candidates(inputs), change()));
        assertFalse(failure instanceof NativeTransactions.PaymentTooLarge);
        assertTrue(failure.getMessage().contains("Insufficient funds"));
    }
    @Test public void pendingImmatureAndReservedFundingCannotBecomeMultiplePayments() throws Exception {
        for (String field : new String[]{"status", "mature", "pending_spent_by"}) {
            JSONArray funding = candidates(1739);
            funding.getJSONObject(1738).put(field, field.equals("status") ? "pending" : field.equals("mature") ? false : "ab".repeat(32));
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> NativeSendBatch.plan(request(1739 * VALUE, true, false), funding, change()));
            assertTrue(error.getMessage().contains("confirmed, mature, unreserved"));
        }
        JSONArray single = candidates(1); single.getJSONObject(0).put("pending_spent_by", "ab".repeat(32));
        assertEquals(1, plan(request(500000, false, false), single).getInt("transactionCount"));
    }
    @Test public void malformedDuplicatesInsufficientFundsAndDustDoNotTriggerBatchFallback() throws Exception {
        JSONArray duplicate = candidates(1739);
        duplicate.getJSONObject(0).put("txid", "ab".repeat(32));
        duplicate.getJSONObject(1738).put("txid", "AB".repeat(32)).put("vout", 0);
        IllegalArgumentException duplicates = assertThrows(IllegalArgumentException.class,
            () -> NativeSendBatch.plan(request(1739 * VALUE, true, false), duplicate, change()));
        assertTrue(duplicates.getMessage().contains("Duplicate"));
        JSONArray malformed = candidates(1739); malformed.getJSONObject(1738).put("vout", 0x100000000L);
        assertThrows(IllegalArgumentException.class,
            () -> NativeSendBatch.plan(request(1739 * VALUE, true, false), malformed, change()));
        assertThrows(IllegalArgumentException.class,
            () -> NativeSendBatch.plan(request(2 * VALUE, false, false), candidates(1), change()));
        assertThrows(IllegalArgumentException.class,
            () -> NativeSendBatch.plan(request(297, true, false), candidates(1739), change()));
        JSONArray uneconomic = candidates(1739);
        for (int i = 0; i < uneconomic.length(); i++) uneconomic.getJSONObject(i).put("amount", "100");
        assertThrows(IllegalArgumentException.class,
            () -> NativeSendBatch.plan(request(173900, true, true), uneconomic, change()));
    }
    @Test public void reviewRejectsTamperingWithTotalsPartsOutputsAndUnion() throws Exception {
        NativeSendPolicy.Request intent = request(1739 * VALUE, true, true);
        JSONObject original = plan(intent, candidates(1739));
        for (String field : new String[]{"fee", "total", "requestedTotal", "inputTotal", "change", "transactionCount"}) {
            JSONObject altered = new JSONObject(original.toString()).put(field, "1");
            assertThrows(IllegalArgumentException.class, () -> NativeSendBatch.verify(intent, altered, change()));
        }
        JSONObject redirected = new JSONObject(original.toString());
        redirected.getJSONArray("plans").getJSONObject(1).getJSONObject("transaction").getJSONArray("outputs")
            .getJSONObject(0).put("publicKey", fixture().getString("publicKey"));
        assertThrows(IllegalArgumentException.class, () -> NativeSendBatch.verify(intent, redirected, change()));
        JSONObject repeated = new JSONObject(original.toString());
        repeated.getJSONArray("plans").put(1, repeated.getJSONArray("plans").getJSONObject(0));
        assertThrows(IllegalArgumentException.class, () -> NativeSendBatch.verify(intent, repeated, change()));
        JSONObject missing = new JSONObject(original.toString()); missing.getJSONArray("selected").remove(0);
        assertThrows(IllegalArgumentException.class, () -> NativeSendBatch.verify(intent, missing, change()));
        JSONObject duplicate = new JSONObject(original.toString()); duplicate.getJSONArray("selected").put(1, duplicate.getJSONArray("selected").getJSONObject(0));
        assertThrows(IllegalArgumentException.class, () -> NativeSendBatch.verify(intent, duplicate, change()));
    }
    @Test public void snapshotsPreserveSharedImmutableParentsAndDetachMutableMetadata() throws Exception {
        JSONArray funding = candidates(1739);
        String publicParent = fixture().getJSONObject("candidate").getString("rawTransaction");
        for (int i = 0; i < funding.length(); i++) funding.getJSONObject(i).put("rawTransaction", publicParent).put("metadata", new JSONObject().put("confirmed", true));
        NativeSendPolicy.Request intent = request(1739 * VALUE, true, true);
        JSONObject batch = plan(intent, funding);
        assertSame(publicParent, batch.getJSONArray("selected").getJSONObject(1738).getString("rawTransaction"));
        funding.getJSONObject(0).getJSONObject("metadata").put("confirmed", false);
        assertTrue(batch.getJSONArray("selected").getJSONObject(0).getJSONObject("metadata").getBoolean("confirmed"));
        NativeSendBatch.verify(intent, batch, change());
    }
    @Test(timeout = 10000) public void fiftyThousandInputsFitTwentyNineIndependentPayments() throws Exception {
        JSONObject batch = plan(request(50000 * VALUE, true, true), candidates(50000));
        assertEquals(29, batch.getInt("transactionCount"));
    }
    @Test(timeout = 5000) public void pathologicalTinyTailCannotCauseUnboundedRebalancing() throws Exception {
        JSONArray funding = candidates(50000);
        for (int i = 10000; i < funding.length(); i++) funding.getJSONObject(i).put("amount", "100");
        assertThrows(IllegalArgumentException.class,
            () -> NativeSendBatch.plan(request(10000 * VALUE + 4000000, true, true), funding, change()));
    }
    @Test public void mixedValuesAndCandidateOrdersRecomputeFromTheirSelectedUnion() throws Exception {
        java.util.Random random = new java.util.Random(73151);
        for (int round = 0; round < 12; round++) {
            JSONArray funding = candidates(2000 + random.nextInt(2500));
            long available = 0;
            for (int i = 0; i < funding.length(); i++) {
                long value = 300000 + random.nextInt(2000000);
                available += value; funding.getJSONObject(i).put("amount", Long.toString(value));
            }
            for (int mode = 0; mode < 3; mode++) {
                long wanted = mode == 0 ? available * 4 / 5 : mode == 1 ? available - 200000 : available;
                JSONObject batch = plan(request(wanted, mode > 0, mode == 2), funding);
                assertTrue(batch.getInt("transactionCount") >= (mode == 2 ? 2 : 1));
            }
        }
    }
    @Test public void independentPartsSignAndVerifyAgainstTheirOriginalPublicFunding() throws Exception {
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            JSONArray funding = candidates(2000), outputs = new JSONArray();
            String key = session.publicAccount(0, 0).getString("publicKey");
            JSONObject parent = NativeTransactions.parse(fixture().getJSONObject("candidate").getString("rawTransaction"));
            for (int i = 0; i < funding.length(); i++) outputs.put(new JSONObject().put("type", 1).put("amount", Long.toString(VALUE)).put("publicKey", key));
            parent.put("outputs", outputs);
            String raw = WalletCrypto.hex(NativeTransactions.serialize(parent, true)), parentId = NativeTransactions.txid(parent);
            for (int i = 0; i < funding.length(); i++) funding.getJSONObject(i).put("rawTransaction", raw).put("txid", parentId);
            JSONObject batch = plan(request(2000 * VALUE, true, true), funding);
            JSONArray parts = batch.getJSONArray("plans"); assertEquals(2, parts.length());
            HashSet<String> transactionIds = new HashSet<>();
            long recipientTotal = 0, fees = 0;
            for (int i = 0; i < parts.length(); i++) {
                JSONObject part = parts.getJSONObject(i), signed = NativeTransactions.signPayment(part, session);
                JSONObject transaction = NativeTransactions.parse(signed.getString("hex"));
                assertTrue(transactionIds.add(signed.getString("txid")));
                assertEquals(NativeTransactions.txid(transaction), signed.getString("txid"));
                assertTrue(NativeTransactions.serialize(transaction, false).length * 3 + NativeTransactions.serialize(transaction, true).length <= 400000);
                JSONArray selected = part.getJSONArray("selected"), spent = new JSONArray();
                for (int j = 0; j < selected.length(); j++) {
                    assertSame(raw, selected.getJSONObject(j).getString("rawTransaction"));
                    spent.put(outputs.getJSONObject(selected.getJSONObject(j).getInt("vout")));
                }
                for (int at : new int[]{0, selected.length() - 1}) {
                    byte[] signature = WalletCrypto.fromHex(transaction.getJSONArray("inputs").getJSONObject(at).getJSONArray("witness").getString(0));
                    assertTrue(WalletCrypto.verifySchnorr(signature, NativeTransactions.signatureHash(transaction, spent, at), WalletCrypto.fromHex(key)));
                }
                recipientTotal += amount(transaction.getJSONArray("outputs").getJSONObject(0), "amount");
                fees += amount(signed, "fee");
            }
            assertEquals(2000 * VALUE, recipientTotal + fees);
            assertEquals(amount(batch, "total"), recipientTotal); assertEquals(amount(batch, "fee"), fees);
        }
    }
}
