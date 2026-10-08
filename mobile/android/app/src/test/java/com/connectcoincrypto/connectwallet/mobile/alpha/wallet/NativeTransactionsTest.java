package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class NativeTransactionsTest {
    private JSONObject fixture() throws Exception { return new JSONObject(TransactionVectors.JSON); }
    @Test public void exactAmountsRejectFloatExponentOverflowAndExcessPrecision() {
        assertEquals(1, NativeTransactions.coinAmount("0.0000000001"));
        assertEquals("1.0000000001", NativeTransactions.format(10000000001L));
        assertEquals(1000000000000000000L, NativeTransactions.coinAmount("100000000"));
        for (String text : new String[]{"-1", "1e3", "0.00000000001", "100000001", "01", "Infinity", "NaN", ".1", "1."}) assertThrows(IllegalArgumentException.class, () -> NativeTransactions.coinAmount(text));
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.amount("1000000000000000001"));
    }
    @Test public void largeBoundedHexDoesNotUseRecursiveRegularExpressionMatching() {
        assertEquals(100000, NativeTransactions.bytes("00".repeat(100000)).length);
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.bytes("00".repeat(100000) + "zz"));
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.bytes("f"));
    }
    @Test public void wireAndCustomSighashMatchDesktopExactly() throws Exception {
        JSONObject f = fixture(), candidate = f.getJSONObject("candidate");
        JSONObject parent = NativeTransactions.parse(candidate.getString("rawTransaction"));
        assertEquals(candidate.getString("rawTransaction"), WalletCrypto.hex(NativeTransactions.serialize(parent, true)));
        assertEquals(candidate.getString("txid"), NativeTransactions.txid(parent));
        for (String kind : new String[]{"payment", "deduct"}) {
            JSONObject expected = f.getJSONObject(kind), tx = NativeTransactions.parse(expected.getString("hex"));
            assertEquals(expected.getString("hex"), WalletCrypto.hex(NativeTransactions.serialize(tx, true)));
            assertEquals(expected.getString("txid"), NativeTransactions.txid(tx)); assertEquals(expected.getInt("vsize"), NativeTransactions.vsize(tx));
            byte[] digest = NativeTransactions.signatureHash(tx, parent.getJSONArray("outputs"), 0);
            assertEquals(expected.getString("sighash"), WalletCrypto.hex(digest));
            assertTrue(WalletCrypto.verifySchnorr(WalletCrypto.fromHex(tx.getJSONArray("inputs").getJSONObject(0).getJSONArray("witness").getString(0)), digest, WalletCrypto.fromHex(f.getString("publicKey"))));
        }
    }
    @Test public void nativePaymentSelectionSigningAndFeeDeductionMatchDesktop() throws Exception {
        JSONObject f = fixture();
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            for (boolean deduct : new boolean[]{false, true}) {
                JSONObject plan = NativeTransactions.planPayment(new JSONArray().put(f.getJSONObject("candidate")), f.getJSONArray("outputs"), f.getString("changeAddress"), 1500, deduct);
                JSONObject expected = f.getJSONObject(deduct ? "deduct" : "payment");
                for (String key : new String[]{"fee", "total", "change"}) assertEquals(expected.getString(key), plan.getString(key));
                assertEquals(expected.getInt("vsize"), plan.getInt("vsize"));
                JSONObject payment = NativeTransactions.signPayment(plan, session), tx = NativeTransactions.parse(payment.getString("hex"));
                assertEquals(expected.getString("txid"), payment.getString("txid"));
                assertTrue(WalletCrypto.verifySchnorr(WalletCrypto.fromHex(tx.getJSONArray("inputs").getJSONObject(0).getJSONArray("witness").getString(0)), WalletCrypto.fromHex(expected.getString("sighash")), WalletCrypto.fromHex(f.getString("publicKey"))));
            }
        }
    }
    @Test public void fundingAndPlansAreVerifiedBeforeSigning() throws Exception {
        JSONObject f = fixture(), candidate = f.getJSONObject("candidate");
        assertEquals(candidate.getString("amount"), NativeTransactions.verifyFunding(candidate, f.getString("publicKey")).getString("amount"));
        for (String field : new String[]{"amount", "txid", "vout"}) {
            JSONObject altered = new JSONObject(candidate.toString()).put(field, field.equals("txid") ? "aa".repeat(32) : field.equals("vout") ? 999 : "1");
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.verifyFunding(altered, f.getString("publicKey")));
        }
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            String wrongKey = session.publicAccount(1, 0).getString("publicKey");
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.verifyFunding(candidate, wrongKey));
            JSONObject plan = NativeTransactions.planPayment(new JSONArray().put(candidate), f.getJSONArray("outputs"), f.getString("changeAddress"), 1500, false);
            plan.getJSONObject("transaction").getJSONArray("outputs").getJSONObject(0).put("amount", "1");
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.signPayment(plan, session));
            JSONObject wrongIndex = new JSONObject(candidate.toString()).put("index", 1);
            JSONObject wrongPlan = NativeTransactions.planPayment(new JSONArray().put(wrongIndex), f.getJSONArray("outputs"), f.getString("changeAddress"), 1500, false);
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.signPayment(wrongPlan, session));
        }
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.planPayment(new JSONArray().put(candidate).put(candidate), f.getJSONArray("outputs"), f.getString("changeAddress"), 1500, false));
    }
    @Test public void claimChallengeFeePayoutAndProofBindingMatchDesktop() throws Exception {
        JSONObject f = fixture(), expected = f.getJSONObject("claim");
        JSONObject prepared = NativeTransactions.prepareClaim(f.getJSONObject("bounty"), f.getString("bountyHex"), f.getString("rewardAddress"), 1500);
        for (String key : new String[]{"hex", "txid", "challenge", "fee", "payout"}) assertEquals(expected.getString(key), prepared.getString(key));
        JSONObject attached = NativeTransactions.attachClaim(prepared, f.getString("proof"));
        assertEquals(f.getJSONObject("attached").getString("hex"), attached.getString("hex"));
        assertEquals(expected.getString("txid"), attached.getString("txid"));
        // This is a framing-only fixture: TLS certificate validation remains the native helper's responsibility.
        byte[] changed = WalletCrypto.fromHex(f.getString("proof")); changed[7] ^= 1;
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.attachClaim(prepared, WalletCrypto.hex(changed)));
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.attachClaim(prepared, "00"));
        JSONObject fake = new JSONObject(f.getJSONObject("bounty").toString()).put("domain", "attacker.example");
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.prepareClaim(fake, f.getString("bountyHex"), f.getString("rewardAddress"), 1500));
    }
    @Test public void hostileWireAndDuplicateInputsFailClosed() throws Exception {
        String parent = fixture().getJSONObject("candidate").getString("rawTransaction");
        for (String bad : new String[]{parent + "00", parent.substring(0, parent.length() - 2), "02000000fd0100" + parent.substring(10), "020000000002" + parent.substring(8)}) assertThrows(IllegalArgumentException.class, () -> NativeTransactions.parse(bad));
        JSONObject duplicate = NativeTransactions.parse(parent); duplicate.getJSONArray("inputs").put(duplicate.getJSONArray("inputs").getJSONObject(0));
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.serialize(duplicate, true));
    }
}
