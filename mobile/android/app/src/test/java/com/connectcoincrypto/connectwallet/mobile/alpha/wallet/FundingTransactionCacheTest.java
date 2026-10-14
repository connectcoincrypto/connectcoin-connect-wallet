package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class FundingTransactionCacheTest {
    private JSONObject fixture() throws Exception { return new JSONObject(TransactionVectors.JSON); }
    private JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }
    private JSONObject funded(JSONObject f, String raw) throws Exception { return copy(f.getJSONObject("bounty")).put("rawTransaction", raw); }
    private String witness(JSONObject f, String bytes) throws Exception {
        JSONObject tx = NativeTransactions.parse(f.getString("bountyHex"));
        tx.getJSONArray("inputs").getJSONObject(0).put("witness", new JSONArray().put(bytes));
        return WalletCrypto.hex(NativeTransactions.serialize(tx, true));
    }
    @Test public void siblingsShareOneParseButEveryOutputAndClaimContextIsChecked() throws Exception {
        JSONObject f = fixture(), tx = NativeTransactions.parse(f.getString("bountyHex"));
        JSONObject other = copy(tx.getJSONArray("outputs").getJSONObject(0)).put("amount", "20000000000");
        tx.getJSONArray("outputs").put(other);
        String raw = WalletCrypto.hex(NativeTransactions.serialize(tx, true)), id = NativeTransactions.txid(tx);
        JSONObject first = copy(f.getJSONObject("bounty")).put("txid", id), second = copy(first).put("vout", 1).put("amount", "20000000000");
        NativeTransactions.FundingTransactionCache cache = new NativeTransactions.FundingTransactionCache();
        JSONObject a = cache.prepareClaim(first, raw, f.getString("rewardAddress"), 1500, () -> {});
        JSONObject b = cache.prepareClaim(second, raw, f.getString("rewardAddress"), 1500, () -> {});
        assertEquals(1, cache.parses()); assertNotEquals(a.getString("challenge"), b.getString("challenge"));
        a.getJSONObject("bounty").put("domain", "attacker.example").put("amount", "1");
        assertEquals(first.getString("domain"), cache.prepareClaim(first, raw, f.getString("rewardAddress"), 1500, () -> {}).getJSONObject("bounty").getString("domain"));
        for (String field : new String[]{"txid", "vout", "amount", "domain", "connection_work_target", "root_certificates_version", "signature_algorithms_mask"}) {
            Object value = field.equals("txid") || field.equals("connection_work_target") ? "00".repeat(32) : field.equals("domain") ? "attacker.example" : field.equals("vout") ? 99 : field.equals("amount") ? "1" : 999;
            JSONObject changed = copy(first).put(field, value);
            assertThrows(field, IllegalArgumentException.class, () -> cache.prepareClaim(changed, raw, f.getString("rewardAddress"), 1500, () -> {}));
        }
        assertThrows(IllegalArgumentException.class, () -> cache.prepareClaim(first, raw, "not-an-address", 1500, () -> {}));
        assertThrows(IllegalArgumentException.class, () -> cache.prepareClaim(first, raw, f.getString("rewardAddress"), 0, () -> {}));
        assertNotEquals(a.getString("challenge"), cache.prepareClaim(first, raw, f.getString("rewardAddress"), 2000, () -> {}).getString("challenge"));
        assertEquals(1, cache.parses());
        JSONObject paid = copy(f.getJSONObject("candidate"));
        cache.verifyFunding(paid, f.getString("publicKey")).put("publicKey", "00".repeat(32));
        assertEquals(f.getString("publicKey"), cache.verifyFunding(paid, f.getString("publicKey")).getString("publicKey"));
        assertThrows(IllegalArgumentException.class, () -> cache.verifyFunding(paid, "00".repeat(32)));
    }
    @Test public void exactWitnessBytesAndMalformedSiblingCannotReuseTxidTrust() throws Exception {
        JSONObject f = fixture(); String raw = f.getString("bountyHex"), alternate = witness(f, "01");
        assertEquals(NativeTransactions.txid(NativeTransactions.parse(raw)), NativeTransactions.txid(NativeTransactions.parse(alternate)));
        NativeTransactions.FundingTransactionCache cache = new NativeTransactions.FundingTransactionCache();
        cache.verifyFunding(funded(f, raw), null); cache.verifyFunding(funded(f, alternate), null);
        assertEquals(2, cache.parses()); assertEquals(2, cache.size());
        for (String malformed : new String[]{alternate + "00", alternate.substring(0, alternate.length() - 2)})
            assertThrows(IllegalArgumentException.class, () -> cache.verifyFunding(funded(f, malformed), null));
        JSONObject tx = NativeTransactions.parse(raw);
        tx.getJSONArray("outputs").put(new JSONObject().put("type", 1).put("amount", "1").put("publicKey", f.getString("publicKey")));
        String sibling = WalletCrypto.hex(NativeTransactions.serialize(tx, true)).replace(f.getString("publicKey"), "ff".repeat(32));
        assertThrows(IllegalArgumentException.class, () -> cache.verifyFunding(funded(f, sibling), null));
        assertEquals(2, cache.size()); cache.verifyFunding(funded(f, raw), null); assertEquals(2, cache.parses());
    }
    @Test public void lruEntryBytesAndOversizedBoundsAreIndependent() throws Exception {
        JSONObject f = fixture(); String a = witness(f, "00"), b = witness(f, "01"), c = witness(f, "02");
        NativeTransactions.FundingTransactionCache cache = new NativeTransactions.FundingTransactionCache(2, 16 * 1024 * 1024);
        cache.verifyFunding(funded(f, a), null); long one = cache.retainedBytes();
        cache.verifyFunding(funded(f, b), null); cache.verifyFunding(funded(f, a), null); cache.verifyFunding(funded(f, c), null);
        assertEquals(3, cache.parses()); assertEquals(2, cache.size());
        cache.verifyFunding(funded(f, a), null); assertEquals(3, cache.parses());
        cache.verifyFunding(funded(f, b), null); assertEquals(4, cache.parses());
        NativeTransactions.FundingTransactionCache byteBound = new NativeTransactions.FundingTransactionCache(128, one);
        byteBound.verifyFunding(funded(f, a), null); byteBound.verifyFunding(funded(f, b), null);
        assertEquals(1, byteBound.size()); assertEquals(one, byteBound.retainedBytes());
        String oversized = witness(f, "00".repeat(100)); byteBound.verifyFunding(funded(f, oversized), null);
        assertEquals(1, byteBound.size()); assertEquals(one, byteBound.retainedBytes());
        long parsed = byteBound.parses(); byteBound.verifyFunding(funded(f, b), null); assertEquals(parsed, byteBound.parses());
        NativeTransactions.FundingTransactionCache tiny = new NativeTransactions.FundingTransactionCache(1, 1);
        tiny.verifyFunding(funded(f, a), null); tiny.verifyFunding(funded(f, a), null);
        assertEquals(2, tiny.parses()); assertEquals(0, tiny.size()); assertEquals(0, tiny.retainedBytes());
        cache.clear(); assertEquals(0, cache.size()); assertEquals(0, cache.retainedBytes());
        cache.verifyFunding(funded(f, a), null); assertEquals(5, cache.parses());
        assertThrows(IllegalArgumentException.class, () -> new NativeTransactions.FundingTransactionCache(129, 1));
        assertThrows(IllegalArgumentException.class, () -> new NativeTransactions.FundingTransactionCache(1, 16L * 1024 * 1024 + 1));
    }
    @Test public void clearWhileMissIsParsingCannotRepopulateOldGeneration() throws Exception {
        JSONObject f = fixture(); NativeTransactions.FundingTransactionCache cache = new NativeTransactions.FundingTransactionCache();
        CountDownLatch parsed = new CountDownLatch(1), resume = new CountDownLatch(1);
        AtomicInteger checks = new AtomicInteger(); AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try { cache.verifyFunding(funded(f, f.getString("bountyHex")), null, () -> {
                if (checks.incrementAndGet() == 2) { parsed.countDown(); if (!resume.await(5, TimeUnit.SECONDS)) throw new AssertionError("Timed out"); }
            }); } catch (Throwable error) { failure.set(error); }
        });
        worker.start();
        try { assertTrue(parsed.await(5, TimeUnit.SECONDS)); cache.clear(); } finally { resume.countDown(); worker.join(5000); }
        assertFalse(worker.isAlive()); assertTrue(failure.get() instanceof CancellationException);
        assertEquals(0, cache.size()); assertEquals(0, cache.retainedBytes());
        cache.verifyFunding(funded(f, f.getString("bountyHex")), null); assertEquals(1, cache.size());
    }
    @Test public void cancelledMissOrHitDoesNotPublishAndMissDoesNotPopulate() throws Exception {
        JSONObject f = fixture(); NativeTransactions.FundingTransactionCache cache = new NativeTransactions.FundingTransactionCache();
        AtomicInteger checks = new AtomicInteger();
        assertThrows(CancellationException.class, () -> cache.verifyFunding(funded(f, f.getString("bountyHex")), null, () -> { if (checks.incrementAndGet() == 2) throw new CancellationException(); }));
        assertEquals(0, cache.size());
        cache.verifyFunding(funded(f, f.getString("bountyHex")), null);
        assertThrows(CancellationException.class, () -> cache.verifyFunding(funded(f, f.getString("bountyHex")), null, () -> { throw new CancellationException(); }));
        assertEquals(1, cache.size());
    }
}
