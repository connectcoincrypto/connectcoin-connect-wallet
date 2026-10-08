package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import java.math.BigInteger;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Mock funding and fixed public test vectors only; never broadcasts or contacts a domain. */
public class NativeP2CPolicyTest {
    private JSONObject input() throws Exception {
        return new JSONObject().put("domain", "example.com").put("amount", "1").put("expectedConnections", "1024");
    }
    private JSONObject fixture() throws Exception { return new JSONObject(TransactionVectors.JSON); }
    private JSONObject plan(NativeP2CPolicy.Request request) throws Exception {
        JSONObject fixture = fixture();
        return NativeTransactions.planPayment(new JSONArray().put(fixture.getJSONObject("candidate")),
            new JSONArray().put(request.destination()), fixture.getString("changeAddress"), 1500, false);
    }

    @Test public void strictBridgeSchemaRejectsExtraFieldsAndCoercion() throws Exception {
        for (String key : new String[]{"address", "mask", "target", "rootVersion", "feeRate", "hex", "privateKey", "rsaProbeStatus", "verified"}) {
            JSONObject request = input().put(key, "1");
            assertThrows(IllegalArgumentException.class, () -> NativeP2CPolicy.request(request));
        }
        for (String key : new String[]{"domain", "amount", "expectedConnections"}) {
            JSONObject missing = input(); missing.remove(key);
            assertThrows(IllegalArgumentException.class, () -> NativeP2CPolicy.request(missing));
            for (Object wrong : new Object[]{JSONObject.NULL, true, 1, 1.0, new JSONObject(), new JSONArray()}) {
                JSONObject request = input().put(key, wrong);
                assertThrows(IllegalArgumentException.class, () -> NativeP2CPolicy.request(request));
            }
        }
        assertThrows(IllegalArgumentException.class, () -> NativeP2CPolicy.request(null));
    }

    @Test public void domainsNormalizeDeterministicallyWithoutUrlOrIdnMappings() throws Exception {
        Locale original = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR"));
            assertEquals("i.example.com", NativeP2CPolicy.request(input().put("domain", "  I.Example.COM  ")).domain);
            assertEquals("xn--bcher-kva.example.com", NativeP2CPolicy.request(input().put("domain", "XN--BCHER-KVA.example.com")).domain);
        } finally { Locale.setDefault(original); }
        for (String domain : new String[]{"", "example", "https://example.com", "example.com:443", "a@b.com", "example.com/x", "a\\b.com",
            "a?b.com", "a#b.com", "example.com.", ".example.com", "a..com", "a_.com", "-a.com", "a-.com", "a b.com", "a\nb.com",
            "a\u0000b.com", "example.com\u0000", "bücher.com", "\u212a.example.com", "a\u202eb.com", "127.0.0.1", "[::1]", "0x7f000001", "example.123",
            "a.local", "a.localhost", "a.localdomain", "a.internal", "a.test", "a.invalid", "a.onion", "home.arpa", "a.home.arpa", "a".repeat(64) + ".com", "a".repeat(1025)}) {
            assertThrows(domain, IllegalArgumentException.class, () -> NativeP2CPolicy.request(input().put("domain", domain)));
        }
        String longest = "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(61);
        assertEquals(253, NativeP2CPolicy.request(input().put("domain", longest)).domain.length());
        assertThrows(IllegalArgumentException.class, () -> NativeP2CPolicy.request(input().put("domain", longest + "d")));
    }
    @Test public void optionalFundingScopeSurvivesNativeProbeAndRejectsExtraAuthority() throws Exception {
        String source = fixture().getString("changeAddress"); JSONArray addresses = new JSONArray().put(source);
        NativeP2CPolicy.Request request = NativeP2CPolicy.request(input().put("fundingAddresses", addresses));
        addresses.put(0, "changed");
        JSONArray accounts = new JSONArray().put(new JSONObject().put("address", source));
        assertEquals(source, request.withProbe("verified").fundingScope.select(accounts).getJSONObject(0).getString("address"));
        assertNull(NativeP2CPolicy.request(input()).fundingScope);
        for (Object invalid : new Object[]{JSONObject.NULL, source, new JSONArray(), new JSONArray().put(source).put(source)}) {
            assertThrows(IllegalArgumentException.class, () -> NativeP2CPolicy.request(input().put("fundingAddresses", invalid)));
        }
        assertThrows(IllegalArgumentException.class, () -> NativeP2CPolicy.request(input().put("fundingAddresses", new JSONArray().put(source)).put("utxos", new JSONArray())));
    }

    @Test public void expectedWorkIsExactAcrossTheFull256BitRange() throws Exception {
        BigInteger space = BigInteger.ONE.shiftLeft(256);
        for (String count : new String[]{"1", "2", "1024", space.subtract(BigInteger.ONE).toString(), space.toString()}) {
            NativeP2CPolicy.Request request = NativeP2CPolicy.request(input().put("expectedConnections", count));
            JSONObject output = NativeTransactions.recipient(request.destination());
            String target = space.divide(new BigInteger(count)).subtract(BigInteger.ONE).toString(16);
            assertEquals("0".repeat(64 - target.length()) + target, output.getString("target"));
            assertEquals(7, output.getInt("mask")); assertEquals(1, output.getInt("rootVersion"));
        }
        for (String invalid : new String[]{"0", "-1", "01", "1.0", "1e3", " 1", "1 ", "", "9".repeat(79), space.add(BigInteger.ONE).toString()}) {
            assertThrows(IllegalArgumentException.class, () -> NativeP2CPolicy.request(input().put("expectedConnections", invalid)));
        }
    }

    @Test public void rewardsRequireExactMoneyAndTypedOutputDust() throws Exception {
        NativeP2CPolicy.Request sample = NativeP2CPolicy.request(input());
        long dust = NativeTransactions.dust(NativeTransactions.recipient(sample.destination()));
        assertEquals(Long.toString(dust), NativeP2CPolicy.request(input().put("amount", NativeTransactions.format(dust))).amount);
        for (String invalid : new String[]{"0", "0.0000000001", NativeTransactions.format(dust - 1), "1e1", "1.", "01", "100000001", "0.12345678901"}) {
            assertThrows(IllegalArgumentException.class, () -> NativeP2CPolicy.request(input().put("amount", invalid)));
        }
        assertEquals(Long.toString(NativeTransactions.MAX_MONEY), NativeP2CPolicy.request(input().put("amount", "100000000")).amount);
    }

    @Test public void immutableNativeRequestAndReviewDescribeTheActualBounty() throws Exception {
        JSONObject rendererInput = input(); NativeP2CPolicy.Request request = NativeP2CPolicy.request(rendererInput);
        rendererInput.put("domain", "changed.com"); request.destination().put("mask", 6).put("domain", "changed.com");
        JSONObject plan = plan(request); String address = fixture().getString("changeAddress");
        String review = request.review(plan, address);
        for (String required : new String[]{"MAINNET", "Domain: example.com", "Public reward: 1 CONN", "Expected connections: 1024",
            "statistical average", "ECDSA P-256", "RSA-PSS-RSAE", "RSA-PSS-PSS", "mask 7", "roots: version 1",
            "RSA checker is unavailable", "RSA support is unconfirmed", "Mining fee: " + NativeTransactions.format(NativeTransactions.amount(plan.getString("fee"))),
            "Change: " + NativeTransactions.format(NativeTransactions.amount(plan.getString("change"))), address,
            "public bounty, not a payment to the domain owner", "Anyone", "cannot be undone"}) {
            assertTrue(required, review.contains(required));
        }
        assertFalse(review.contains("changed.com"));
    }

    @Test public void onlyAnExactVerifiedNativeProbeSelectsRsaAndFreezesThatPolicy() throws Exception {
        NativeP2CPolicy.Request original = NativeP2CPolicy.request(input()); String address = fixture().getString("changeAddress");
        for (String status : new String[]{"verified", "failed", "timeout", "busy", "unavailable", null, "true", "verified\n", "attacker text"}) {
            NativeP2CPolicy.Request reviewed = original.withProbe(status);
            boolean verified = "verified".equals(status); JSONObject plan = plan(reviewed);
            assertEquals(verified ? 6 : 7, reviewed.signatureMask);
            assertEquals(verified ? 6 : 7, plan.getJSONObject("transaction").getJSONArray("outputs").getJSONObject(0).getInt("mask"));
            assertEquals("250500", plan.getString("fee")); assertEquals(167, plan.getInt("vsize"));
            String review = reviewed.review(plan, address);
            assertEquals(verified, review.contains("RSA support verified with one authenticated TLS 1.3 connection"));
            if (verified) {
                assertFalse(review.contains("ECDSA")); assertTrue(review.contains("not every server or future availability"));
                assertThrows(IllegalArgumentException.class, () -> reviewed.verifyPlan(plan(original), address));
                plan.getJSONObject("transaction").getJSONArray("outputs").getJSONObject(0).put("mask", 7);
                assertThrows(IllegalArgumentException.class, () -> reviewed.verifyPlan(plan, address));
            } else {
                assertTrue(review.contains("RSA support is unconfirmed")); assertTrue(review.contains("mask 7"));
                assertFalse(review.contains("attacker text"));
            }
        }
        assertEquals(7, original.signatureMask);
    }

    @Test public void mockFundedBountySignsAndRoundTripsWithAValidNativeSignature() throws Exception {
        NativeP2CPolicy.Request request = NativeP2CPolicy.request(input()); JSONObject plan = plan(request), fixture = fixture();
        request.verifyPlan(plan, fixture.getString("changeAddress"));
        // Independently generated with desktop buildPayment and the same PUBLIC fixture (mask 7, N=1024).
        assertEquals("250500", plan.getString("fee")); assertEquals("89999749500", plan.getString("change"));
        assertEquals(167, plan.getInt("vsize"));
        assertEquals("0200000001c89e69db5e65de218f565da77f27809bc42a5d8352d3cb50557459b110892bca0000000000fdffffff0200e40b5402000000020b6578616d706c652e636f6dffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff3f0001000000077c3167f41400000001498b3ac8e882c5d693540c49adf22b7a1b99c1bb8047966739bfe8cdeb272e6400000000",
            WalletCrypto.hex(NativeTransactions.serialize(plan.getJSONObject("transaction"), false)));
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            JSONObject signed = NativeTransactions.signPayment(plan, session), tx = NativeTransactions.parse(signed.getString("hex"));
            assertEquals("91e020fa60076e793150340b496999bf18a2ea1ce0524cf713cfb5e8e831c1d5", signed.getString("txid"));
            assertEquals(signed.getString("txid"), NativeTransactions.txid(tx));
            assertEquals(2, tx.getJSONArray("outputs").getJSONObject(0).getInt("type"));
            assertEquals("example.com", tx.getJSONArray("outputs").getJSONObject(0).getString("domain"));
            JSONObject parent = NativeTransactions.parse(fixture.getJSONObject("candidate").getString("rawTransaction"));
            assertTrue(WalletCrypto.verifySchnorr(WalletCrypto.fromHex(tx.getJSONArray("inputs").getJSONObject(0).getJSONArray("witness").getString(0)),
                NativeTransactions.signatureHash(tx, parent.getJSONArray("outputs"), 0), WalletCrypto.fromHex(fixture.getString("publicKey"))));
            session.lock(); assertThrows(IllegalStateException.class, () -> NativeTransactions.signPayment(plan, session));
        }
    }

    @Test public void changedRecipientChangeAndFeeCannotPassNativeReview() throws Exception {
        NativeP2CPolicy.Request request = NativeP2CPolicy.request(input()); String address = fixture().getString("changeAddress");
        for (String field : new String[]{"type", "amount", "domain", "target", "rootVersion", "mask"}) {
            JSONObject altered = plan(request);
            altered.getJSONObject("transaction").getJSONArray("outputs").getJSONObject(0).put(field,
                field.equals("type") ? 1 : field.equals("rootVersion") ? 2 : field.equals("mask") ? 6 : field.equals("amount") ? "1" : field.equals("domain") ? "changed.com" : "0".repeat(64));
            assertThrows(IllegalArgumentException.class, () -> request.verifyPlan(altered, address));
        }
        for (String field : new String[]{"fee", "inputTotal", "total", "requestedTotal", "change"}) {
            JSONObject altered = plan(request).put(field, "1");
            assertThrows(IllegalArgumentException.class, () -> request.verifyPlan(altered, address));
        }
        JSONObject redirected = plan(request);
        redirected.getJSONObject("transaction").getJSONArray("outputs").getJSONObject(1).put("publicKey", fixture().getString("publicKey"));
        assertThrows(IllegalArgumentException.class, () -> request.verifyPlan(redirected, address));
        JSONObject extra = plan(request);
        extra.getJSONObject("transaction").getJSONArray("outputs").put(extra.getJSONObject("transaction").getJSONArray("outputs").getJSONObject(1));
        assertThrows(IllegalArgumentException.class, () -> request.verifyPlan(extra, address));
    }

    @Test public void verifiedRsaBountySignsMaskSixAndRejectsCrossPolicyTampering() throws Exception {
        NativeP2CPolicy.Request fallback = NativeP2CPolicy.request(input()), verified = fallback.withProbe("verified");
        JSONObject plan = plan(verified), fixture = fixture(); String change = fixture.getString("changeAddress");
        verified.verifyPlan(plan, change);
        assertThrows(IllegalArgumentException.class, () -> fallback.verifyPlan(plan, change));
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            JSONObject signed = NativeTransactions.signPayment(plan, session), tx = NativeTransactions.parse(signed.getString("hex"));
            JSONObject output = tx.getJSONArray("outputs").getJSONObject(0);
            assertEquals(2, output.getInt("type")); assertEquals(6, output.getInt("mask")); assertEquals(1, output.getInt("rootVersion"));
            assertEquals(verified.domain, output.getString("domain")); assertEquals(verified.amount, output.getString("amount"));
            assertEquals(signed.getString("txid"), NativeTransactions.txid(tx));
            assertEquals(signed.getString("hex"), WalletCrypto.hex(NativeTransactions.serialize(tx, true)));
            JSONObject parent = NativeTransactions.parse(fixture.getJSONObject("candidate").getString("rawTransaction"));
            byte[] signature = WalletCrypto.fromHex(tx.getJSONArray("inputs").getJSONObject(0).getJSONArray("witness").getString(0));
            byte[] publicKey = WalletCrypto.fromHex(fixture.getString("publicKey"));
            assertTrue(WalletCrypto.verifySchnorr(signature, NativeTransactions.signatureHash(tx, parent.getJSONArray("outputs"), 0), publicKey));
            output.put("mask", 7);
            assertFalse(WalletCrypto.verifySchnorr(signature, NativeTransactions.signatureHash(tx, parent.getJSONArray("outputs"), 0), publicKey));
            plan.getJSONObject("transaction").getJSONArray("outputs").getJSONObject(0).put("mask", 7);
            assertThrows(IllegalArgumentException.class, () -> verified.verifyPlan(plan, change));
        }
    }

    @Test public void insufficientAndForgedFundingDoNotProduceSignedBounties() throws Exception {
        NativeP2CPolicy.Request tooLarge = NativeP2CPolicy.request(input().put("amount", "100"));
        assertThrows(IllegalArgumentException.class, () -> plan(tooLarge));
        NativeP2CPolicy.Request request = NativeP2CPolicy.request(input());
        for (String field : new String[]{"amount", "rawTransaction", "index"}) {
            JSONObject altered = plan(request);
            altered.getJSONArray("selected").getJSONObject(0).put(field, field.equals("amount") ? "1" : field.equals("index") ? 1 : "00");
            try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
                assertThrows(IllegalArgumentException.class, () -> NativeTransactions.signPayment(altered, session));
            }
        }
    }
}
