package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Public deterministic funding only. No actual account, RPC or broadcast. */
public class NativeSendPolicyTest {
    private JSONObject fixture() throws Exception { return new JSONObject(TransactionVectors.JSON); }
    private JSONObject input() throws Exception {
        return new JSONObject().put("address", fixture().getJSONArray("outputs").getJSONObject(0).getString("address"))
            .put("amount", "1").put("feeRate", "1500").put("subtractFeeFromAmount", false).put("useAllBalance", false);
    }
    private String change() throws Exception { return fixture().getString("changeAddress"); }
    private JSONArray funding(long... amounts) throws Exception {
        JSONObject fixture = fixture(), parent = NativeTransactions.parse(fixture.getJSONObject("candidate").getString("rawTransaction"));
        JSONArray outputs = new JSONArray(), candidates = new JSONArray();
        for (long amount : amounts) outputs.put(new JSONObject().put("type", 1).put("amount", Long.toString(amount)).put("publicKey", fixture.getString("publicKey")));
        parent.put("outputs", outputs); String txid = NativeTransactions.txid(parent), raw = WalletCrypto.hex(NativeTransactions.serialize(parent, true));
        for (int i = 0; i < amounts.length; i++) candidates.put(new JSONObject().put("txid", txid).put("vout", i).put("amount", Long.toString(amounts[i]))
            .put("rawTransaction", raw).put("index", 0).put("change", 0).put("mature", true).put("status", "confirmed").put("pending_spent_by", JSONObject.NULL));
        return candidates;
    }
    private JSONObject plan(JSONObject input, JSONArray candidates) throws Exception {
        NativeSendPolicy.Request request = NativeSendPolicy.request(input);
        JSONObject plan = request.plan(candidates, change()); request.verifyPlan(plan, change()); return plan;
    }
    @Test public void bridgeHasExactSchemaAndDoesNotCoercePaymentOptions() throws Exception {
        for (String key : new String[]{"address", "amount", "feeRate", "subtractFeeFromAmount", "useAllBalance"}) {
            JSONObject missing = input(); missing.remove(key);
            assertThrows(IllegalArgumentException.class, () -> NativeSendPolicy.request(missing));
            Object[] wrongValues = key.equals("subtractFeeFromAmount") || key.equals("useAllBalance")
                ? new Object[]{"true", "false", 0, 1, JSONObject.NULL, new JSONArray()}
                : new Object[]{true, 1, 1500.0, JSONObject.NULL, new JSONObject()};
            for (Object value : wrongValues) {
                JSONObject wrong = input().put(key, value);
                assertThrows(IllegalArgumentException.class, () -> NativeSendPolicy.request(wrong));
            }
        }
        assertThrows(IllegalArgumentException.class, () -> NativeSendPolicy.request(input().put("mask", 7)));
        assertThrows(IllegalArgumentException.class, () -> NativeSendPolicy.request(input().put("useAllBalance", true)));
        assertThrows(IllegalArgumentException.class, () -> NativeSendPolicy.request(null));
    }
    @Test public void feeRateRequiresCanonicalBoundedIntegerString() throws Exception {
        for (String rate : new String[]{"1201", "1500", "99999", "100000"}) assertEquals(Integer.parseInt(rate), NativeSendPolicy.request(input().put("feeRate", rate)).feeRate);
        for (String rate : new String[]{"0", "1200", "100001", "1000000", "01500", "1500.", "1500.5", "1e4", " 1500", "1500 ", "-1500", ""}) {
            assertThrows(rate, IllegalArgumentException.class, () -> NativeSendPolicy.request(input().put("feeRate", rate)));
        }
    }
    @Test public void optionalFundingScopeIsCopiedAndUseAllReviewNamesThatScope() throws Exception {
        String source = input().getString("address"); JSONArray addresses = new JSONArray().put(source);
        NativeSendPolicy.Request request = NativeSendPolicy.request(input().put("subtractFeeFromAmount", true).put("useAllBalance", true).put("fundingAddresses", addresses));
        addresses.put(0, "changed");
        JSONArray accounts = new JSONArray().put(new JSONObject().put("address", source));
        assertEquals(source, request.fundingScope.select(accounts).getJSONObject(0).getString("address"));
        JSONObject plan = request.plan(funding(NativeTransactions.COIN), change());
        assertTrue(request.review(plan, change()).contains("in the selected address scope"));
        assertNull(NativeSendPolicy.request(input()).fundingScope);
        for (Object invalid : new Object[]{JSONObject.NULL, source, new JSONArray(), new JSONArray().put(source).put(source)}) {
            assertThrows(IllegalArgumentException.class, () -> NativeSendPolicy.request(input().put("fundingAddresses", invalid)));
        }
        assertThrows(IllegalArgumentException.class, () -> NativeSendPolicy.request(input().put("fundingAddresses", new JSONArray().put(source)).put("outputs", new JSONArray())));
    }
    @Test public void addedAndDeductedFeesUseChosenRateAndExactRecipientAmounts() throws Exception {
        JSONArray candidates = funding(10 * NativeTransactions.COIN);
        for (int rate : new int[]{1201, 1500, 100000}) for (boolean deduct : new boolean[]{false, true}) {
            JSONObject input = input().put("feeRate", Integer.toString(rate)).put("subtractFeeFromAmount", deduct);
            JSONObject plan = plan(input, candidates); long fee = NativeTransactions.amount(plan.getString("fee"));
            assertEquals((long)plan.getInt("vsize") * rate, fee);
            assertEquals(Long.toString(NativeTransactions.COIN - (deduct ? fee : 0)), plan.getString("total"));
            assertEquals(Long.toString(9 * NativeTransactions.COIN - (deduct ? 0 : fee)), plan.getString("change"));
            assertEquals(Long.toString(NativeTransactions.COIN), plan.getString("requestedTotal"));
        }
    }
    @Test public void useAllSpendsExactlyFreshAvailableFundsWithNoChangeAndValidSignatures() throws Exception {
        JSONArray candidates = funding(NativeTransactions.COIN, 2 * NativeTransactions.COIN, 3 * NativeTransactions.COIN);
        NativeSendPolicy.Request request = NativeSendPolicy.request(input().put("amount", "6").put("subtractFeeFromAmount", true).put("useAllBalance", true));
        JSONObject plan = request.plan(candidates, change()); request.verifyPlan(plan, change());
        assertEquals(3, plan.getJSONArray("selected").length()); assertEquals("60000000000", plan.getString("inputTotal")); assertEquals("0", plan.getString("change"));
        assertEquals(60000000000L - NativeTransactions.amount(plan.getString("fee")), NativeTransactions.amount(plan.getString("total")));
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            JSONObject signed = NativeTransactions.signPayment(plan, session), tx = NativeTransactions.parse(signed.getString("hex"));
            JSONArray spent = new JSONArray();
            for (int i = 0; i < plan.getJSONArray("selected").length(); i++) spent.put(NativeTransactions.verifyFunding(plan.getJSONArray("selected").getJSONObject(i), fixture().getString("publicKey")));
            assertEquals(1, tx.getJSONArray("outputs").length()); assertEquals(signed.getString("txid"), NativeTransactions.txid(tx));
            for (int i = 0; i < 3; i++) assertTrue(WalletCrypto.verifySchnorr(
                WalletCrypto.fromHex(tx.getJSONArray("inputs").getJSONObject(i).getJSONArray("witness").getString(0)),
                NativeTransactions.signatureHash(tx, spent, i), WalletCrypto.fromHex(fixture().getString("publicKey"))));
        }
    }
    @Test public void useAllRefusesBothStaleAmountsAndAnyUnavailableCandidate() throws Exception {
        NativeSendPolicy.Request request = NativeSendPolicy.request(input().put("amount", "3").put("subtractFeeFromAmount", true).put("useAllBalance", true));
        for (JSONArray candidates : new JSONArray[]{funding(NativeTransactions.COIN), funding(4 * NativeTransactions.COIN), new JSONArray()}) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () -> request.plan(candidates, change()));
            assertTrue(error.getMessage().contains("Refresh"));
        }
        for (String field : new String[]{"mature", "status", "pending_spent_by"}) {
            JSONArray candidates = funding(3 * NativeTransactions.COIN);
            candidates.getJSONObject(0).put(field, field.equals("mature") ? false : field.equals("status") ? "pending" : "aa".repeat(32));
            assertThrows(IllegalArgumentException.class, () -> request.plan(candidates, change()));
        }
        JSONArray missing = funding(3 * NativeTransactions.COIN); missing.getJSONObject(0).remove("pending_spent_by");
        assertThrows(IllegalArgumentException.class, () -> request.plan(missing, change()));
    }
    @Test public void regularDeductCanSelectOneExactCoinInsteadOfSweepingOrBlockingExplicitReplacement() throws Exception {
        JSONObject options = input().put("subtractFeeFromAmount", true);
        JSONArray candidates = funding(2 * NativeTransactions.COIN, NativeTransactions.COIN);
        JSONObject plan = plan(options, candidates);
        assertEquals(1, plan.getJSONArray("selected").length()); assertEquals(1, plan.getJSONArray("selected").getJSONObject(0).getInt("vout")); assertEquals("0", plan.getString("change"));
        JSONArray pending = funding(NativeTransactions.COIN); pending.getJSONObject(0).put("pending_spent_by", "aa".repeat(32));
        JSONObject replacement = plan(options, pending);
        assertEquals("aa".repeat(32), replacement.getJSONArray("selected").getJSONObject(0).getString("pending_spent_by"));
        // The plugin separately requires its existing explicit native replacement checkbox.
    }
    @Test public void tinyChangeIsRetainedAndExplainedWithoutIncreasingTheFee() throws Exception {
        NativeSendPolicy.Request request = NativeSendPolicy.request(input().put("subtractFeeFromAmount", true));
        JSONObject plan = request.plan(funding(NativeTransactions.COIN + 1), change()); request.verifyPlan(plan, change());
        long fee = NativeTransactions.amount(plan.getString("fee")), change = NativeTransactions.amount(plan.getString("change"));
        assertEquals(297, change); assertEquals((long)plan.getInt("vsize") * 1500, fee);
        assertEquals(Long.toString(NativeTransactions.COIN - fee - 296), plan.getString("total"));
        String review = request.review(plan, change());
        assertTrue(review.contains("Kept as spendable change: 0.0000000296 CONN"));
        assertTrue(review.contains("Total paid: 0.9999999704 CONN"));
    }
    @Test public void immutableNativeReviewShowsRequestedReceivedFeeChangeAndTotal() throws Exception {
        JSONObject renderer = input().put("subtractFeeFromAmount", true);
        NativeSendPolicy.Request request = NativeSendPolicy.request(renderer); renderer.put("feeRate", "100000").put("amount", "2");
        request.destination().put("amount", "1");
        JSONObject plan = request.plan(funding(10 * NativeTransactions.COIN), change());
        String review = request.review(plan, change());
        for (String expected : new String[]{"Entered amount: 1 CONN", "Recipient receives: 0.9999775 CONN", "Mining fee (deducted): 0.0000225 CONN",
            "Fee rate: 1500 connects/vbyte", "Total paid: 1 CONN", "Selected input total: 10 CONN", "Change: 9 CONN", request.address, change()}) assertTrue(expected, review.contains(expected));
    }
    @Test public void tamperedOutputsFeesOptionsAndUseAllReservationsFailBeforeSigning() throws Exception {
        NativeSendPolicy.Request request = NativeSendPolicy.request(input().put("subtractFeeFromAmount", true));
        JSONArray candidates = funding(10 * NativeTransactions.COIN);
        for (String field : new String[]{"fee", "total", "requestedTotal", "inputTotal", "change", "vsize"}) {
            JSONObject altered = request.plan(candidates, change()).put(field, "1");
            assertThrows(IllegalArgumentException.class, () -> request.verifyPlan(altered, change()));
        }
        JSONObject redirected = request.plan(candidates, change());
        redirected.getJSONObject("transaction").getJSONArray("outputs").getJSONObject(0).put("publicKey", fixture().getString("publicKey"));
        assertThrows(IllegalArgumentException.class, () -> request.verifyPlan(redirected, change()));
        JSONObject correct = request.plan(candidates, change());
        NativeSendPolicy.Request added = NativeSendPolicy.request(input()), higher = NativeSendPolicy.request(input().put("subtractFeeFromAmount", true).put("feeRate", "1501"));
        assertThrows(IllegalArgumentException.class, () -> added.verifyPlan(correct, change()));
        assertThrows(IllegalArgumentException.class, () -> higher.verifyPlan(correct, change()));
        NativeSendPolicy.Request all = NativeSendPolicy.request(input().put("amount", "10").put("subtractFeeFromAmount", true).put("useAllBalance", true));
        JSONObject reserved = all.plan(candidates, change()); reserved.getJSONArray("selected").getJSONObject(0).put("pending_spent_by", "aa".repeat(32));
        assertThrows(IllegalArgumentException.class, () -> all.verifyPlan(reserved, change()));
    }
    @Test public void highFeesAndDustCannotYieldNegativeOrUnspendableRecipient() throws Exception {
        JSONObject tiny = input().put("amount", "0.00001").put("feeRate", "100000").put("subtractFeeFromAmount", true);
        assertThrows(IllegalArgumentException.class, () -> plan(tiny, funding(100000)));
        NativeSendPolicy.Request request = NativeSendPolicy.request(input().put("amount", "10"));
        assertThrows(IllegalArgumentException.class, () -> request.plan(funding(10 * NativeTransactions.COIN), change()));
    }
}
