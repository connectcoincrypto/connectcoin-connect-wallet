package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Synthetic public metadata/parents only. No funds, RPC or broadcast. */
public class NativeTransactionsCapacityTest {
    private static final long VALUE = 1_000_000L;
    private JSONObject fixture() throws Exception { return new JSONObject(TransactionVectors.JSON); }
    private String change() throws Exception { return fixture().getString("changeAddress"); }
    private JSONArray candidates(int count) throws Exception {
        JSONArray result = new JSONArray();
        for (int i = 0; i < count; i++) result.put(new JSONObject().put("txid", "12".repeat(32)).put("vout", i)
            .put("amount", Long.toString(VALUE)).put("index", 0).put("change", 0)
            .put("mature", true).put("status", "confirmed").put("pending_spent_by", JSONObject.NULL));
        return result;
    }
    private NativeSendPolicy.Request request(long amount, boolean deduct, boolean all) throws Exception {
        return NativeSendPolicy.request(new JSONObject().put("address", fixture().getJSONArray("outputs").getJSONObject(0).getString("address"))
            .put("amount", NativeTransactions.format(amount)).put("feeRate", "1500")
            .put("subtractFeeFromAmount", deduct).put("useAllBalance", all));
    }
    private int exactSize(int inputs, int outputs) {
        int stripped = 4 + (inputs < 253 ? 1 : 3) + inputs * 41 + 1 + outputs * 41 + 4;
        return (stripped * 4 + 2 + inputs * 66 + 3) / 4;
    }
    private void assertWireSize(JSONObject plan) throws Exception {
        JSONObject tx = plan.getJSONObject("transaction");
        int weight = NativeTransactions.serialize(tx, false).length * 3 + NativeTransactions.serialize(tx, true).length;
        assertTrue(weight <= 400000);
        assertEquals((weight + 3) / 4, plan.getInt("vsize"));
        assertEquals((long)plan.getInt("vsize") * 1500, NativeTransactions.amount(plan.getString("fee")));
    }
    @Test public void addedDeductedAndUseAllPaymentsPassFormerLimitUpToStandardMaximum() throws Exception {
        assertEquals(1738, NativeTransactions.MAX_PAYMENT_INPUTS);
        for (int count : new int[]{256, 257, 1000, 1738}) {
            JSONArray funding = candidates(count); long sum = VALUE * count, fee = (long)exactSize(count, 1) * 1500;
            for (boolean deduct : new boolean[]{false, true}) {
                NativeSendPolicy.Request intent = request(deduct ? sum : sum - fee, deduct, deduct);
                JSONObject plan = intent.plan(funding, change()); intent.verifyPlan(plan, change());
                assertEquals(count, plan.getJSONArray("selected").length());
                assertEquals("0", plan.getString("change")); assertEquals(Long.toString(sum), plan.getString("inputTotal"));
                assertEquals(Long.toString(sum - fee), plan.getString("total")); assertWireSize(plan);
            }
        }
    }
    @Test public void compactSizeBoundaryFeesAreExactWithAndWithoutChange() throws Exception {
        int[] counts = {252, 253, 254}; int[] sizes = {14542, 14601, 14659};
        for (int at = 0; at < counts.length; at++) {
            int count = counts[at]; JSONArray funding = candidates(count); long sum = VALUE * count;
            for (boolean change : new boolean[]{false, true}) {
                NativeSendPolicy.Request intent = request(sum - (change ? 500_000 : 0), true, !change);
                JSONObject plan = intent.plan(funding, change()); intent.verifyPlan(plan, change());
                assertEquals(count, plan.getJSONArray("selected").length());
                assertEquals(sizes[at] + (change ? 41 : 0), plan.getInt("vsize")); assertWireSize(plan);
            }
        }
    }
    @Test public void candidateCapacityDoesNotBecomeSelectedInputCapacity() throws Exception {
        assertEquals(50000, NativeTransactions.MAX_PAYMENT_CANDIDATES);
        JSONArray funding = candidates(NativeTransactions.MAX_PAYMENT_CANDIDATES);
        for (boolean deduct : new boolean[]{false, true}) {
            NativeSendPolicy.Request intent = request(500000, deduct, false);
            JSONObject plan = intent.plan(funding, change()); intent.verifyPlan(plan, change());
            assertEquals(1, plan.getJSONArray("selected").length()); assertWireSize(plan);
        }
        funding.put(new JSONObject(funding.getJSONObject(0).toString()).put("vout", funding.length()));
        assertThrows(IllegalArgumentException.class, () -> request(500000, false, false).plan(funding, change()));
    }
    @Test public void selectedInputOrOutputWeightOverflowFailsBeforeAnyParentsAreRequired() throws Exception {
        JSONArray tooMany = candidates(1739);
        IllegalArgumentException count = assertThrows(IllegalArgumentException.class, () -> request(1739 * VALUE, true, true).plan(tooMany, change()));
        assertTrue(count.getMessage().contains("standard weight"));
        // 1,738 inputs leave room for one P2PK output, but not a second output.
        JSONArray maximum = candidates(1738);
        IllegalArgumentException outputs = assertThrows(IllegalArgumentException.class, () -> request(1738 * VALUE - 500000, true, false).plan(maximum, change()));
        assertTrue(outputs.getMessage().contains("standard weight"));
        JSONArray destinations = new JSONArray().put(new JSONObject().put("domain", "example.com").put("expectedConnections", "1").put("mask", 7).put("amount", Long.toString(1738 * VALUE)));
        IllegalArgumentException typed = assertThrows(IllegalArgumentException.class, () -> NativeTransactions.planPayment(maximum, destinations, change(), 1500, true));
        assertTrue(typed.getMessage().contains("standard weight"));
    }
    @Test public void canonicalDuplicatesAndHostileCandidateOutpointsAreRejected() throws Exception {
        JSONArray duplicate = candidates(2); duplicate.getJSONObject(0).put("txid", "ab".repeat(32));
        duplicate.getJSONObject(1).put("txid", "AB".repeat(32)).put("vout", 0);
        assertThrows(IllegalArgumentException.class, () -> request(500000, true, false).plan(duplicate, change()));
        for (Object invalid : new Object[]{-1, 0x100000000L}) {
            JSONArray invalidIndex = candidates(1); invalidIndex.getJSONObject(0).put("vout", invalid);
            assertThrows(IllegalArgumentException.class, () -> request(500000, true, false).plan(invalidIndex, change()));
        }
    }
    private JSONArray authenticatedFunding(int count, VaultSession session, boolean mixedPaths) throws Exception {
        JSONObject parent = NativeTransactions.parse(fixture().getJSONObject("candidate").getString("rawTransaction"));
        JSONArray outputs = new JSONArray(), funding = candidates(count);
        String first = session.publicAccount(0, 0).getString("publicKey"), second = session.publicAccount(1, 1).getString("publicKey");
        for (int i = 0; i < count; i++) {
            int path = mixedPaths ? i % 2 : 0;
            outputs.put(new JSONObject().put("type", 1).put("amount", Long.toString(VALUE)).put("publicKey", path == 0 ? first : second));
            funding.getJSONObject(i).put("index", path).put("change", path);
        }
        parent.put("outputs", outputs); String raw = WalletCrypto.hex(NativeTransactions.serialize(parent, true)), id = NativeTransactions.txid(parent);
        for (int i = 0; i < count; i++) funding.getJSONObject(i).put("rawTransaction", raw).put("txid", id);
        return funding;
    }
    private JSONObject sweep(JSONArray funding) throws Exception {
        NativeSendPolicy.Request intent = request(VALUE * funding.length(), true, true);
        JSONObject plan = intent.plan(funding, change()); intent.verifyPlan(plan, change()); return plan;
    }
    @Test public void cachedSigningVerifiesEveryInputAndIndexAcrossMultipleDerivationPaths() throws Exception {
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            JSONArray funding = authenticatedFunding(257, session, true); JSONObject plan = sweep(funding);
            JSONArray selected = plan.getJSONArray("selected");
            assertSame(funding.getJSONObject(0).getString("rawTransaction"), selected.getJSONObject(256).getString("rawTransaction"));
            JSONObject signed = NativeTransactions.signPayment(plan, session), tx = NativeTransactions.parse(signed.getString("hex"));
            JSONArray spent = NativeTransactions.parse(funding.getJSONObject(0).getString("rawTransaction")).getJSONArray("outputs");
            assertEquals(257, tx.getJSONArray("inputs").length()); assertEquals(plan.getInt("vsize"), NativeTransactions.vsize(tx));
            for (int i = 0; i < selected.length(); i++) {
                byte[] signature = WalletCrypto.fromHex(tx.getJSONArray("inputs").getJSONObject(i).getJSONArray("witness").getString(0));
                byte[] digest = NativeTransactions.signatureHash(tx, spent, i), key = WalletCrypto.fromHex(spent.getJSONObject(i).getString("publicKey"));
                assertTrue("input " + i, WalletCrypto.verifySchnorr(signature, digest, key));
                if (i == 0) assertFalse(WalletCrypto.verifySchnorr(signature, NativeTransactions.signatureHash(tx, spent, 1), key));
            }
            String originalHash = WalletCrypto.hex(NativeTransactions.signatureHash(tx, spent, 0));
            tx.getJSONArray("outputs").getJSONObject(0).put("amount", "100000");
            assertNotEquals(originalHash, WalletCrypto.hex(NativeTransactions.signatureHash(tx, spent, 0)));
        }
    }
    @Test public void maximumStandardSweepSignsWithoutDuplicatingSharedParentData() throws Exception {
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            JSONArray funding = authenticatedFunding(1738, session, false);
            JSONObject plan = sweep(funding), signed = NativeTransactions.signPayment(plan, session);
            JSONObject tx = NativeTransactions.parse(signed.getString("hex"));
            JSONArray spent = NativeTransactions.parse(funding.getJSONObject(0).getString("rawTransaction")).getJSONArray("outputs");
            assertEquals(1738, tx.getJSONArray("inputs").length());
            assertEquals(399954, NativeTransactions.serialize(tx, false).length * 3 + NativeTransactions.serialize(tx, true).length);
            assertEquals(plan.getString("fee"), signed.getString("fee"));
            assertEquals(NativeTransactions.txid(tx), signed.getString("txid"));
            for (int index : new int[]{0, 252, 253, 1000, 1737}) {
                byte[] signature = WalletCrypto.fromHex(tx.getJSONArray("inputs").getJSONObject(index).getJSONArray("witness").getString(0));
                assertTrue(WalletCrypto.verifySchnorr(signature, NativeTransactions.signatureHash(tx, spent, index),
                    WalletCrypto.fromHex(spent.getJSONObject(index).getString("publicKey"))));
            }
            assertSame(funding.getJSONObject(0).getString("rawTransaction"), plan.getJSONArray("selected").getJSONObject(1737).getString("rawTransaction"));
        }
    }
    @Test public void cachedParentsNeverSkipLaterAmountOutpointPathOrRawChecks() throws Exception {
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            JSONArray funding = authenticatedFunding(3, session, false);
            JSONObject valid = sweep(funding); NativeTransactions.signPayment(valid, session);
            for (String field : new String[]{"amount", "txid", "vout", "index", "change", "rawTransaction"}) {
                JSONObject altered = sweep(funding), later = altered.getJSONArray("selected").getJSONObject(1);
                Object value = field.equals("amount") ? "1" : field.equals("txid") ? "aa".repeat(32)
                    : field.equals("rawTransaction") ? later.getString("rawTransaction") + "00" : field.equals("vout") ? 999 : 1;
                later.put(field, value);
                assertThrows(field, IllegalArgumentException.class, () -> NativeTransactions.signPayment(altered, session));
            }
            JSONObject changedOutpoint = sweep(funding);
            changedOutpoint.getJSONObject("transaction").getJSONArray("inputs").getJSONObject(1).put("vout", 2);
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.signPayment(changedOutpoint, session));
            JSONObject changedFee = sweep(funding); changedFee.put("fee", Long.toString(NativeTransactions.COIN + 1));
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.signPayment(changedFee, session));
            JSONObject changedSize = sweep(funding); changedSize.put("vsize", changedSize.getInt("vsize") - 1);
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.signPayment(changedSize, session));
            JSONObject changedParent = NativeTransactions.parse(funding.getJSONObject(1).getString("rawTransaction"));
            changedParent.getJSONArray("outputs").getJSONObject(1).put("amount", "2");
            funding.getJSONObject(1).put("rawTransaction", WalletCrypto.hex(NativeTransactions.serialize(changedParent, true)));
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.signPayment(sweep(funding), session));
        }
    }
    @Test public void batchReviewAuthenticatesEachSharedParentOutputAndChecksCancellation() throws Exception {
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            JSONArray funding = authenticatedFunding(3, session, false); String key = session.publicAccount(0, 0).getString("publicKey");
            AtomicInteger checks = new AtomicInteger(); NativeTransactions.verifyFundingBatch(funding, key, checks::incrementAndGet);
            assertEquals(4, checks.get());
            assertThrows(IllegalStateException.class, () -> NativeTransactions.verifyFundingBatch(funding, key, () -> { throw new IllegalStateException("Cancelled"); }));
            for (String field : new String[]{"amount", "txid", "vout"}) {
                JSONArray altered = new JSONArray(funding.toString());
                altered.getJSONObject(1).put(field, field.equals("amount") ? "1" : field.equals("txid") ? "aa".repeat(32) : 999);
                assertThrows(IllegalArgumentException.class, () -> NativeTransactions.verifyFundingBatch(altered, key));
            }
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.verifyFundingBatch(funding, session.publicAccount(1, 0).getString("publicKey")));
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.verifyFundingBatch(funding, null));
        }
    }
    @Test public void lockingDuringSigningCancelsWithoutPublishingPartialSignatures() throws Exception {
        ExecutorService worker = Executors.newSingleThreadExecutor();
        CountDownLatch firstSignature = new CountDownLatch(1), continueSigning = new CountDownLatch(1);
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            JSONArray funding = authenticatedFunding(3, session, false); JSONObject plan = sweep(funding);
            String original = plan.getJSONObject("transaction").toString(); AtomicInteger checks = new AtomicInteger();
            Future<JSONObject> signing = worker.submit(() -> NativeTransactions.signPayment(plan, session, () -> {
                // Initial check, funding inputs, pre-hash check, then before/
                // after the first signature. Lock from another thread here.
                if (checks.incrementAndGet() == funding.length() + 4) {
                    firstSignature.countDown();
                    if (!continueSigning.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test cancellation timed out");
                }
                if (session.isLocked()) throw new IllegalStateException("Signing cancelled");
            }));
            assertTrue(firstSignature.await(5, TimeUnit.SECONDS));
            session.lock(); continueSigning.countDown();
            ExecutionException cancelled = assertThrows(ExecutionException.class, () -> signing.get(5, TimeUnit.SECONDS));
            assertTrue(cancelled.getCause() instanceof IllegalStateException);
            assertEquals("Signing cancelled", cancelled.getCause().getMessage());
            assertEquals(funding.length() + 4, checks.get());
            assertEquals(original, plan.getJSONObject("transaction").toString());
        } finally { continueSigning.countDown(); worker.shutdownNow(); }
    }
}
