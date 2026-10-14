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
    @Test public void observedClaimAcceptsAnotherBoundWitnessWithoutChangingOriginalBytes() throws Exception {
        JSONObject f = fixture();
        JSONObject prepared = NativeTransactions.prepareClaim(f.getJSONObject("bounty"), f.getString("bountyHex"), f.getString("rewardAddress"), 1500);
        String proof = f.getString("proof");
        // Framing-only fixtures: changing CertificateVerify does not change the
        // stripped transaction ID. Full TLS validity remains the node's job.
        String alternateProof = proof.substring(0, proof.length() - 8) + "0f000001aa";
        JSONObject original = NativeTransactions.attachClaim(prepared, proof), alternate = NativeTransactions.attachClaim(prepared, alternateProof);
        String originalHex = original.getString("hex"), alternateHex = alternate.getString("hex"), txid = original.getString("txid");
        assertNotEquals(originalHex, alternateHex); assertEquals(txid, alternate.getString("txid"));
        NativeTransactions.validateObservedClaim(originalHex, txid, originalHex);
        NativeTransactions.validateObservedClaim(alternateHex, txid, originalHex);
        NativeTransactions.validateObservedClaim(alternateHex, txid, null);
        NativeTransactions.validateObservedClaim(alternateHex, txid, originalHex, "ff".repeat(32));
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.validateObservedClaim(alternateHex, txid, originalHex, "00".repeat(32)));
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.validateObservedClaim(alternateHex, txid, originalHex, "ff"));
        assertEquals(f.getJSONObject("attached").getString("hex"), originalHex);
        assertEquals(f.getJSONObject("claim").getString("hex"), prepared.getString("hex"));
    }
    @Test public void observedSameIdNeverBypassesProofFramingChallengeOrWitnessChecks() throws Exception {
        JSONObject f = fixture(); String originalHex = f.getJSONObject("attached").getString("hex"), txid = f.getJSONObject("attached").getString("txid");
        String proof = f.getString("proof"); byte[] wrongChallenge = WalletCrypto.fromHex(proof); wrongChallenge[7] ^= 1;
        for (String invalid : new String[] {"00" + proof.substring(2), WalletCrypto.hex(wrongChallenge), proof + "00", proof.substring(0, proof.length() - 2),
                proof.substring(0, proof.length() - 8) + "0e000000", proof.substring(0, proof.length() - 8) + "0f002001" + "00".repeat(8193)}) {
            JSONObject observed = NativeTransactions.parse(originalHex);
            observed.getJSONArray("inputs").getJSONObject(0).put("witness", new JSONArray().put(invalid));
            String raw = WalletCrypto.hex(NativeTransactions.serialize(observed, true));
            assertEquals(txid, NativeTransactions.txid(observed));
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.validateObservedClaim(raw, txid, originalHex));
        }
        for (JSONArray invalid : new JSONArray[] {new JSONArray(), new JSONArray().put(proof).put(proof)}) {
            JSONObject observed = NativeTransactions.parse(originalHex); observed.getJSONArray("inputs").getJSONObject(0).put("witness", invalid);
            String raw = WalletCrypto.hex(NativeTransactions.serialize(observed, true)); assertEquals(txid, NativeTransactions.txid(observed));
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.validateObservedClaim(raw, txid, originalHex));
        }
    }
    @Test public void observedClaimRejectsDifferentBaseMalformedWireAndPaymentTransactions() throws Exception {
        JSONObject f = fixture(); String original = f.getJSONObject("attached").getString("hex"), txid = f.getJSONObject("attached").getString("txid");
        for (String field : new String[] {"version", "locktime", "vout", "sequence", "scriptSig", "amount", "publicKey"}) {
            JSONObject changed = NativeTransactions.parse(original);
            JSONObject input = changed.getJSONArray("inputs").getJSONObject(0), output = changed.getJSONArray("outputs").getJSONObject(0);
            if (field.equals("version")) changed.put(field, 1); else if (field.equals("locktime")) changed.put(field, 1);
            else if (field.equals("vout")) input.put(field, 99); else if (field.equals("sequence")) input.put(field, 0xfffffffdL);
            else if (field.equals("scriptSig")) input.put(field, "00"); else if (field.equals("amount")) output.put(field, "100000");
            else output.put(field, f.getString("publicKey"));
            String raw = WalletCrypto.hex(NativeTransactions.serialize(changed, true)), changedId = NativeTransactions.txid(changed);
            assertNotEquals(field, txid, changedId);
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.validateObservedClaim(raw, txid, original));
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.validateObservedClaim(raw, changedId, original));
        }
        for (String raw : new String[] {original + "00", original.substring(0, original.length() - 2), f.getJSONObject("payment").getString("hex")})
            assertThrows(IllegalArgumentException.class, () -> NativeTransactions.validateObservedClaim(raw, txid, original));
        String payment = f.getJSONObject("payment").getString("hex"), paymentId = f.getJSONObject("payment").getString("txid");
        assertThrows(IllegalArgumentException.class, () -> NativeTransactions.validateObservedClaim(payment, paymentId, null));
    }
}
