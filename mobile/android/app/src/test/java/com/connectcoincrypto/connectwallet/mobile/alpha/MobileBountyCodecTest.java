package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class MobileBountyCodecTest {
    static final String GENESIS = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e";
    static final String TXID = "a".repeat(64), BLOCK = "b".repeat(64), SPENDER = "c".repeat(64);
    static JSONObject tip(int height) throws Exception { return new JSONObject().put("chain", "main").put("genesis_hash", GENESIS).put("height", height).put("hash", height == 0 ? GENESIS : BLOCK).put("mediantime", 1700000000 + height * 10); }
    static JSONObject row() throws Exception { return new JSONObject().put("txid", TXID).put("vout", 0).put("amount", "10000000").put("domain", "example.com").put("connection_work_target", "f".repeat(64)).put("root_certificates_version", 1).put("signature_algorithms_mask", 7).put("block_height", 0).put("block_hash", GENESIS).put("coinbase", false).put("confirmations", 1).put("status", "available").put("spending_txid", JSONObject.NULL); }
    static JSONObject event(int ref) throws Exception { return new JSONObject().put("sequence", 1).put("type", "pending_spend").put("txid", TXID).put("vout", 0).put("tip_ref", ref).put("bounty_ref", MobileBountyCodec.immutableDigest(row())).put("spending_txid_ref", true).put("bounty_delta", new JSONObject().put("status", "pending_spend").put("spending_txid", SPENDER)); }
    static JSONObject page() throws Exception { return new JSONObject().put("compact", 3).put("tip", JSONObject.NULL).put("block_delta", new JSONArray()).put("next_cursor", "c1").put("changes", new JSONArray().put(event(-1))); }
    static JSONObject decode(JSONObject page) throws Exception { return MobileBountyCodec.decode(page, tip(0), "c0", Map.of(TXID + ":0", row()), 3); }
    @Test public void exactDigestsMatchJavaScript() throws Exception {
        assertEquals("66616e61b440159287d14e319d40606c374d6956cbc88124d272b526cfe0d1b1", MobileBountyCodec.stateDigest(tip(0), "c0"));
        assertEquals("822710134698f21672ee54bfad06eb16f5d13af378c60c25f68459bf2dfc6c21", MobileBountyCodec.immutableDigest(row()));
    }
    @Test public void v3SameTipPreservesAliasesAndDerivesHistoricalConfirmations() throws Exception {
        JSONObject source = page(), decoded = decode(source), e = decoded.getJSONArray("changes").getJSONObject(0);
        assertEquals(1, e.getJSONObject("bounty").getLong("confirmations")); assertEquals(SPENDER, e.getString("spending_txid"));
        assertTrue(source.isNull("tip")); assertFalse(source.getJSONArray("changes").getJSONObject(0).has("bounty"));
        source.put("tip", new JSONArray().put(1).put(BLOCK).put(1700000010)).put("block_delta", new JSONArray().put(new JSONArray().put(JSONObject.NULL).put(0)));
        source.getJSONArray("changes").getJSONObject(0).put("tip_ref", -2);
        e = decode(source).getJSONArray("changes").getJSONObject(0); assertEquals(0, e.getJSONObject("tip").getInt("height")); assertEquals(1, e.getJSONObject("bounty").getInt("confirmations"));
    }
    @Test public void exactAckNeedsOwnedBaseAndCursor() throws Exception {
        JSONObject ack = new JSONObject().put("compact", 3).put("unchanged", true);
        assertEquals("c0", decode(ack).getString("next_cursor"));
        assertThrows(Exception.class, () -> MobileBountyCodec.decode(ack, null, "c0", Map.of(), 3));
        ack.put("changes", new JSONArray()); assertThrows(Exception.class, () -> decode(ack));
    }
    @Test public void addedIdentityOmissionAndV2V1AreValidated() throws Exception {
        JSONObject e = new JSONObject().put("sequence", 1).put("type", "added").put("tip_ref", -1).put("bounty", row());
        JSONObject p = page().put("changes", new JSONArray().put(e));
        assertEquals(TXID, decode(p).getJSONArray("changes").getJSONObject(0).getString("txid"));
        e.put("txid", TXID); assertThrows(Exception.class, () -> decode(p));
        JSONObject v2 = page().put("compact", 2).put("tip", new JSONArray().put(0).put(GENESIS).put(1700000000)).put("tips", new JSONArray()).put("has_more", false);
        v2.getJSONArray("changes").getJSONObject(0).getJSONObject("bounty_delta").put("confirmations", 1); decode(v2);
        JSONObject v1 = new JSONObject(v2.toString()).put("compact", 1).put("tip", tip(0)).put("bounty_deltas", 1).put("block_deltas", 1)
            .put("block_delta", new JSONObject().put("base_height", 0).put("base_hash", GENESIS).put("blocks", new JSONArray())).put("tips", new JSONArray().put(tip(0)));
        JSONObject ve = v1.getJSONArray("changes").getJSONObject(0); ve.put("tip_ref", 0).put("spending_txid", SPENDER); ve.remove("spending_txid_ref"); decode(v1);
    }
    @Test public void invalidDefaultsAliasesAndRowsNeverDowngrade() throws Exception {
        for (int n = 0; n < 18; n++) {
            JSONObject p = page(), e = p.getJSONArray("changes").getJSONObject(0);
            switch (n) {
                case 0: p.put("compact", 4); break;
                case 1: p.put("changes", JSONObject.NULL); break;
                case 2: p.put("tips", JSONObject.NULL); break;
                case 3: p.put("has_more", JSONObject.NULL); break;
                case 4: p.remove("next_cursor"); break;
                case 5: p.put("bounty_deltas", 1); break;
                case 6: p.put("block_delta", new JSONArray().put(new JSONArray().put(JSONObject.NULL).put(0))); break;
                case 7: e.put("tip_ref", 0); break;
                case 8: e.put("spending_txid_ref", false); break;
                case 9: e.put("spending_txid", SPENDER); break;
                case 10: e.put("bounty_ref", "0".repeat(64)); break;
                case 11: e.getJSONObject("bounty_delta").put("confirmations", 2); break;
                case 12: e.getJSONObject("bounty_delta").put("status", "available"); break;
                case 13: e.getJSONObject("bounty_delta").put("confirmations", 1.5); break;
                case 14: e.put("bounty", row()); break;
                case 15: e.put("vout", true); break;
                case 16: e.getJSONObject("bounty_delta").put("spending_txid", JSONObject.NULL); break;
                case 17: p.put("tip", tip(0)).put("block_delta", JSONObject.NULL); e.put("tip_ref", -2); break;
            }
            assertThrows("mutation " + n, Exception.class, () -> decode(p));
        }
    }
    @Test public void unknownReferenceReplayNeverHidesMalformedSiblingOrSuffix() throws Exception {
        JSONObject valid = page(); assertThrows(MobileBountyCodec.UnknownReference.class, () -> MobileBountyCodec.decode(valid, tip(0), "c0", Map.of(), 3));
        JSONObject sibling = page(); sibling.getJSONArray("changes").put(new JSONObject().put("type", "added").put("sequence", 2).put("tip_ref", 0).put("bounty", row()));
        assertThrows(IllegalArgumentException.class, () -> MobileBountyCodec.decode(sibling, tip(0), "c0", Map.of(), 3));
        JSONObject suffix = page().put("tip", new JSONArray().put(1).put(BLOCK).put(1700000010));
        assertThrows(IllegalArgumentException.class, () -> MobileBountyCodec.decode(suffix, tip(0), "c0", Map.of(), 3));
    }
    @Test public void compactReceiptStrictlyBindsTransactionAndLocation() throws Exception {
        JSONObject receipt = new JSONObject().put("tip", tip(0)).put("txid", TXID).put("status", "pending").put("confirmations", 0);
        MobileClaimsEngine.validateCompactReceipt(receipt, TXID);
        receipt.remove("confirmations"); assertThrows(Exception.class, () -> MobileClaimsEngine.validateCompactReceipt(receipt, TXID));
        for (Object invalid : new Object[] {1, -1, 0.0, true, "0", JSONObject.NULL}) {
            receipt.put("confirmations", invalid); assertThrows(Exception.class, () -> MobileClaimsEngine.validateCompactReceipt(receipt, TXID));
        }
        receipt.put("status", "confirmed").put("confirmations", 1).put("block_height", 0).put("block_hash", GENESIS); MobileClaimsEngine.validateCompactReceipt(receipt, TXID);
        receipt.put("txid", SPENDER); assertThrows(Exception.class, () -> MobileClaimsEngine.validateCompactReceipt(receipt, TXID));
    }
    @Test public void countedManifestAndDeltaNeverInferZeroOrChangeCanonicalCount() throws Exception {
        JSONObject manifest = new JSONObject().put("tip", tip(0)).put("window", 600).put("bounty_counts", 1)
            .put("blocks", new JSONArray().put(new JSONObject().put("height", 0).put("hash", GENESIS).put("bounty_count", 1)));
        MobileClaimBlockWindow known = MobileClaimBlockWindow.refresh(null, tip(0), true, p -> manifest);
        assertEquals(Long.valueOf(1), known.counts().get(GENESIS));
        JSONObject advance = new JSONObject().put("compact", 3).put("tip", new JSONArray().put(1).put(BLOCK).put(1700000010)).put("block_delta", new JSONArray().put(new JSONArray().put(JSONObject.NULL).put(0)));
        MobileClaimBlockWindow fresh = MobileClaimBlockWindow.fromDelta(known, decode(advance));
        assertEquals(Long.valueOf(0), fresh.counts().get(BLOCK)); assertEquals(Long.valueOf(1), fresh.counts().get(GENESIS));
        manifest.getJSONArray("blocks").getJSONObject(0).remove("bounty_count");
        assertThrows(Exception.class, () -> MobileClaimBlockWindow.refresh(null, tip(0), true, p -> manifest));
    }
    @Test public void pageLocalAddedReferenceAvoidsExpandedReplayWithoutMutatingCache() throws Exception {
        Map<String, JSONObject> external = new LinkedHashMap<>();
        JSONObject added = new JSONObject().put("sequence", 1).put("type", "added").put("tip_ref", -1).put("bounty", row());
        JSONObject pending = event(-1).put("sequence", 2);
        JSONObject source = page().put("changes", new JSONArray().put(added).put(pending));
        JSONObject result = MobileBountyCodec.decode(source, tip(0), "c0", external, 3);
        assertTrue(external.isEmpty()); assertFalse(added.has("txid"));
        assertEquals("pending_spend", result.getJSONArray("changes").getJSONObject(1).getJSONObject("bounty").getString("status"));
    }
    @Test public void optionalOuterStateIdentityMustAgreeAndMalformedUnknownNeverReplays() throws Exception {
        for (String field : new String[]{"block_hash", "block_height"}) {
            JSONObject p = page(); p.getJSONArray("changes").getJSONObject(0).put(field, field.equals("block_hash") ? BLOCK : 1);
            assertThrows(IllegalArgumentException.class, () -> decode(p));
            p.getJSONArray("changes").getJSONObject(0).put(field, JSONObject.NULL);
            assertThrows(IllegalArgumentException.class, () -> MobileBountyCodec.decode(p, tip(0), "c0", Map.of(), 3));
        }
    }
    @Test public void missingCanonicalDeltaAndReusedAncestorFailBeforeUnknownReplay() throws Exception {
        JSONObject nullDelta = page().put("tip", tip(0)).put("block_delta", JSONObject.NULL);
        assertThrows(IllegalArgumentException.class, () -> decode(nullDelta));
        JSONObject reused = page().put("tip", new JSONArray().put(2).put(GENESIS).put(1700000020))
            .put("block_delta", new JSONArray().put(new JSONArray().put(JSONObject.NULL).put(0)));
        assertThrows(IllegalArgumentException.class, () -> MobileBountyCodec.decode(reused, tip(1), "c0", Map.of(), 3, Map.of(GENESIS, 0L, BLOCK, 1L)));
    }
    @Test public void unknownReferenceCannotHideOrphanPublicationOrRowOrAuthoritativeZero() throws Exception {
        String endpoint = "d".repeat(64), orphan = "e".repeat(64);
        for (int mode = 0; mode < 3; mode++) {
            JSONObject p = page().put("tip", new JSONArray().put(2).put(endpoint).put(1700000020))
                .put("block_delta", new JSONArray().put(new JSONArray().put(JSONObject.NULL).put(mode == 2 ? 0 : 1)));
            JSONObject unknown = event(-2);
            p.put("changes", new JSONArray().put(unknown));
            if (mode == 0) {
                unknown.put("tip_ref", 0); p.put("tips", new JSONArray().put(tip(1).put("hash", orphan)));
            } else {
                JSONObject invalidRow = row().put("block_height", mode == 2 ? 2 : 1).put("block_hash", mode == 2 ? endpoint : orphan).put("confirmations", mode == 2 ? 1 : 2);
                p.getJSONArray("changes").put(new JSONObject().put("type", "added").put("sequence", 2).put("tip_ref", -1).put("bounty", invalidRow));
            }
            assertThrows(IllegalArgumentException.class, () -> MobileBountyCodec.decode(p, tip(1), "c0", Map.of(), 3,
                Map.of(GENESIS, 0L, BLOCK, 1L), Map.of(GENESIS, 1L, BLOCK, 1L)));
        }
    }
    @Test public void unknownReferenceCannotHideCursorOrCrossPageSequenceRegression() throws Exception {
        JSONObject repeated = page().put("next_cursor", "c0");
        assertThrows(IllegalArgumentException.class, () -> MobileBountyCodec.decode(repeated, tip(0), "c0", Map.of(), 3));
        assertThrows(IllegalArgumentException.class, () -> MobileBountyCodec.decode(page(), tip(0), "c0", Map.of(), 3, Map.of(GENESIS, 0L), Map.of(GENESIS, 1L), 2));
    }
}
