package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Offline hash metadata only: no server, keys, signatures or broadcasts. */
public class MobileClaimBlockWindowTest {
    static final String GENESIS = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e";
    static String hash(long value) { return String.format("%064x", value); }
    static String canonical(int height) { return height == 0 ? GENESIS : hash(1000 + height); }
    static JSONObject window(int height, int replaced, int branch) throws Exception {
        JSONArray blocks = new JSONArray();
        for (int index = 0; index < Math.min(600, height + 1); index++) blocks.put(new JSONObject().put("height", height - index)
            .put("hash", index < replaced ? hash(branch * 1000000L + height - index) : canonical(height - index)));
        return new JSONObject().put("window", 600).put("blocks", blocks).put("tip", new JSONObject().put("chain", "main").put("genesis_hash", GENESIS)
            .put("hash", blocks.getJSONObject(0).getString("hash")).put("height", height).put("mediantime", 1700000000 + height));
    }
    static JSONObject prefix(JSONObject full, JSONObject params) throws Exception {
        JSONObject result = new JSONObject(full.toString()); JSONArray rows = new JSONArray();
        for (int index = 0; index < Math.min(params.optInt("count", 600), full.getJSONArray("blocks").length()); index++) rows.put(new JSONObject(full.getJSONArray("blocks").getJSONObject(index).toString()));
        return result.put("blocks", rows);
    }
    static MobileClaimBlockWindow cache(JSONObject full) throws Exception {
        return MobileClaimBlockWindow.refresh(null, full.getJSONObject("tip"), false, params -> full);
    }
    static MobileRpcClient.RpcFailure failure(String code) throws Exception {
        java.lang.reflect.Constructor<MobileRpcClient.RpcFailure> constructor = MobileRpcClient.RpcFailure.class.getDeclaredConstructor(String.class, boolean.class, Integer.class, long.class, boolean.class);
        constructor.setAccessible(true); return constructor.newInstance(code, false, null, 0L, false);
    }
    static void complete(MobileClaimBlockWindow actual, JSONObject full) throws Exception {
        assertEquals(full.getJSONObject("tip").toString(), actual.tip().toString());
        assertEquals(full.getJSONArray("blocks").length(), actual.blocks().size());
        int index = 0;
        for (Map.Entry<String, Long> block : actual.blocks().entrySet()) {
            JSONObject expected = full.getJSONArray("blocks").getJSONObject(index++);
            assertEquals(expected.getString("hash"), block.getKey()); assertEquals(expected.getLong("height"), block.getValue().longValue());
        }
    }
    @Test public void coldQueriesOnceAndUnchangedWindowSkipsAllHashTransfers() throws Exception {
        JSONObject full = window(700, 0, 0); List<Integer> counts = new ArrayList<>();
        MobileClaimBlockWindow.Query query = params -> { counts.add(params.optInt("count", 600)); return prefix(full, params); };
        MobileClaimBlockWindow initial = MobileClaimBlockWindow.refresh(null, full.getJSONObject("tip"), false, query);
        assertEquals(List.of(600), counts); complete(initial, full);
        assertSame(initial, MobileClaimBlockWindow.refresh(initial, full.getJSONObject("tip"), false, query));
        assertEquals(List.of(600), counts);
    }
    @Test public void advancesAndReorganizationsEscalateOnlyWhenAnchorRequiresIt() throws Exception {
        MobileClaimBlockWindow old = cache(window(700, 0, 0));
        for (int depth : new int[] {0, 3, 4, 5, 99, 100, 450, 600}) {
            JSONObject full = window(depth == 0 ? 701 : 700, depth, 1); List<Integer> counts = new ArrayList<>();
            MobileClaimBlockWindow result = MobileClaimBlockWindow.refresh(old, full.getJSONObject("tip"), false,
                params -> { counts.add(params.optInt("count", 600)); return prefix(full, params); });
            assertEquals(depth < 5 ? List.of(5) : depth < 100 ? List.of(5, 100) : List.of(5, 100, 600), counts);
            complete(result, full); complete(old, window(700, 0, 0));
        }
    }
    @Test public void rollbackAndMissingAnchorNeverInventMissingOldTail() throws Exception {
        for (int height : new int[] {699, 1400}) {
            JSONObject full = window(height, 0, 0); List<Integer> counts = new ArrayList<>();
            complete(MobileClaimBlockWindow.refresh(cache(window(700, 0, 0)), full.getJSONObject("tip"), false,
                params -> { counts.add(params.optInt("count", 600)); return prefix(full, params); }), full);
            assertEquals(List.of(5, 100, 600), counts);
        }
        JSONObject rollback = window(19, 0, 0); List<Integer> counts = new ArrayList<>();
        complete(MobileClaimBlockWindow.refresh(cache(window(20, 0, 0)), rollback.getJSONObject("tip"), false,
            params -> { counts.add(params.optInt("count", 600)); return prefix(rollback, params); }), rollback);
        assertEquals(List.of(5), counts);
    }
    @Test public void nearGenesisLengthsAndForcedResetReanchorRemainStrict() throws Exception {
        for (int height : new int[] {0, 1, 3, 4, 5}) {
            JSONObject full = window(height, 0, 0); List<Integer> counts = new ArrayList<>();
            MobileClaimBlockWindow result = MobileClaimBlockWindow.refresh(cache(window(Math.max(0, height - 1), 0, 0)), full.getJSONObject("tip"), true,
                params -> { counts.add(params.optInt("count", 600)); return prefix(full, params); });
            assertEquals(List.of(5), counts); complete(result, full); assertTrue(result.blocks().containsKey(GENESIS));
        }
    }
    @Test public void legacyRejectingCountFallsBackOnlyForInvalidParams() throws Exception {
        JSONObject full = window(701, 0, 0); MobileClaimBlockWindow old = cache(window(700, 0, 0));
        for (String code : List.of("-32602", "RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "-32029", "-32030")) {
            List<Integer> counts = new ArrayList<>();
            MobileClaimBlockWindow.Query query = params -> { counts.add(params.optInt("count", 600)); if (params.has("count")) throw failure(code); return full; };
            if (code.equals("-32602")) { complete(MobileClaimBlockWindow.refresh(old, full.getJSONObject("tip"), false, query), full); assertEquals(List.of(5, 600), counts); }
            else { assertEquals(code, assertThrows(MobileRpcClient.RpcFailure.class, () -> MobileClaimBlockWindow.refresh(old, full.getJSONObject("tip"), false, query)).code); assertEquals(List.of(5), counts); }
        }
    }
    @Test public void legacyIgnoringCountMustReturnAnActuallyCompleteWindow() throws Exception {
        JSONObject full = window(701, 0, 0); List<Integer> counts = new ArrayList<>();
        complete(MobileClaimBlockWindow.refresh(cache(window(700, 0, 0)), full.getJSONObject("tip"), false,
            params -> { counts.add(params.optInt("count", 600)); return full; }), full);
        assertEquals(List.of(5), counts);
    }
    @Test public void malformedPrefixNeverEscalatesOrPublishes() throws Exception {
        JSONObject full = window(701, 0, 0); MobileClaimBlockWindow old = cache(window(700, 0, 0));
        for (int mutation = 0; mutation < 12; mutation++) {
            JSONObject value = prefix(full, new JSONObject().put("count", 5)); JSONArray rows = value.getJSONArray("blocks");
            switch (mutation) {
                case 0: rows.remove(4); break;
                case 1: rows.put(new JSONObject().put("height", 696).put("hash", canonical(696))); break;
                case 2: rows.getJSONObject(2).put("height", 698); break;
                case 3: rows.getJSONObject(2).put("hash", rows.getJSONObject(3).getString("hash")); break;
                case 4: rows.getJSONObject(2).put("hash", "z".repeat(64)); break;
                case 5: rows.getJSONObject(0).put("hash", hash(99)); break;
                case 6: value.put("window", 5); break;
                case 7: value.getJSONObject("tip").put("genesis_hash", hash(99)); break;
                case 8: rows.getJSONObject(1).put("hash", canonical(650)); break;
                case 9: rows.getJSONObject(3).put("hash", hash(456789)); break;
                case 10: value.getJSONObject("tip").put("mediantime", 1); break;
                case 11: rows.getJSONObject(3).put("height", 698.0); break;
            }
            List<Integer> counts = new ArrayList<>();
            assertThrows("mutation " + mutation, Exception.class, () -> MobileClaimBlockWindow.refresh(old, full.getJSONObject("tip"), false,
                params -> { counts.add(params.optInt("count", 600)); return value; }));
            assertEquals(List.of(5), counts); complete(old, window(700, 0, 0));
        }
    }
    @Test public void genesisAndCachedTipMetadataCannotContradict() throws Exception {
        JSONObject source = window(3, 0, 0); MobileClaimBlockWindow old = cache(source);
        for (String field : List.of("height", "mediantime")) {
            JSONObject changed = new JSONObject(source.getJSONObject("tip").toString()); changed.put(field, changed.getLong(field) + 1);
            assertThrows(IllegalArgumentException.class, () -> MobileClaimBlockWindow.refresh(old, changed, false, params -> source));
        }
        JSONObject invalid = window(4, 0, 0); invalid.getJSONArray("blocks").getJSONObject(4).put("hash", hash(999));
        assertThrows(IllegalArgumentException.class, () -> MobileClaimBlockWindow.refresh(old, invalid.getJSONObject("tip"), false, params -> invalid));
    }
    @Test public void changedTipBetweenQueriesNeverMixesTwoPrefixes() throws Exception {
        MobileClaimBlockWindow old = cache(window(700, 0, 0)); JSONObject first = window(700, 10, 1), second = window(700, 2, 2);
        List<Integer> counts = new ArrayList<>();
        complete(MobileClaimBlockWindow.refresh(old, first.getJSONObject("tip"), false, params -> {
            counts.add(params.optInt("count", 600)); return prefix(counts.size() == 1 ? first : second, params);
        }), second);
        assertEquals(List.of(5, 100), counts);
    }
    @Test public void publishedMetadataOwnsCopiesAndBlocksAreUnmodifiable() throws Exception {
        JSONObject full = window(700, 0, 0); MobileClaimBlockWindow value = cache(full);
        full.getJSONObject("tip").put("height", 8); full.getJSONArray("blocks").remove(0);
        value.tip().put("hash", hash(0)); assertThrows(UnsupportedOperationException.class, () -> value.blocks().clear());
        complete(value, window(700, 0, 0));
    }
}
