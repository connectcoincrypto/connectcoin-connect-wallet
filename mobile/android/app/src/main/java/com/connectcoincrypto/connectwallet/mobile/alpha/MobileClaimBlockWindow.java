package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** A privately owned, fully validated 600-block (or genesis-bounded) hash window. */
final class MobileClaimBlockWindow {
    interface Query { JSONObject read(JSONObject params) throws Exception; }
    private static final long SAFE_MAX = 9007199254740991L;
    private final JSONObject tip;
    private final Map<String, Long> blocks;

    private MobileClaimBlockWindow(JSONObject state, Map<String, Long> rows) throws Exception {
        tip = MobileClaimsEngine.validateTip(state);
        blocks = Collections.unmodifiableMap(new LinkedHashMap<>(rows));
    }

    JSONObject tip() throws Exception { return new JSONObject(tip.toString()); }
    Map<String, Long> blocks() { return blocks; }

    static boolean sameTip(JSONObject left, JSONObject right) throws Exception {
        left = MobileClaimsEngine.validateTip(left); right = MobileClaimsEngine.validateTip(right);
        if (!left.getString("hash").equals(right.getString("hash"))) return false;
        require(left.getLong("height") == right.getLong("height") && left.getLong("mediantime") == right.getLong("mediantime"));
        return true;
    }

    static MobileClaimBlockWindow refresh(MobileClaimBlockWindow known, JSONObject expectedTip, boolean force, Query query) throws Exception {
        MobileClaimsEngine.validateTip(expectedTip);
        if (known != null && !force && sameTip(known.tip, expectedTip)) return known;
        for (int count : known == null ? new int[] {600} : new int[] {5, 100, 600}) {
            JSONObject response;
            int required = count;
            try { response = query.read(count == 600 ? new JSONObject() : new JSONObject().put("count", count)); }
            catch (MobileRpcClient.RpcFailure failure) {
                if (count == 600 || !"-32602".equals(failure.code)) throw failure;
                // Only the server's explicit unsupported-parameter response
                // permits legacy fallback, never network or malformed data.
                response = query.read(new JSONObject()); required = 600;
            }
            require(response != null);
            JSONObject state = MobileClaimsEngine.validateTip(response.optJSONObject("tip"));
            sameTip(expectedTip, state); // Equal hashes cannot contradict metadata.
            Map<String, Long> prefix = validate(response, state, required);
            MobileClaimBlockWindow joined = join(state, prefix, known);
            if (joined != null) return joined;
        }
        throw new IllegalArgumentException("CLAIMS_RPC_DATA");
    }

    private static Map<String, Long> validate(JSONObject response, JSONObject state, int count) throws Exception {
        require(response.opt("window") instanceof Integer || response.opt("window") instanceof Long);
        require(response.getLong("window") == 600 && response.opt("blocks") instanceof JSONArray);
        long height = state.getLong("height");
        JSONArray rows = response.getJSONArray("blocks");
        require(rows.length() == Math.min(count, height + 1) || rows.length() == Math.min(600L, height + 1));
        Map<String, Long> result = new LinkedHashMap<>();
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.getJSONObject(index);
            Object number = row.opt("height"), rawHash = row.opt("hash");
            require(number instanceof Integer || number instanceof Long);
            long blockHeight = ((Number) number).longValue();
            require(blockHeight >= 0 && blockHeight <= SAFE_MAX && blockHeight == height - index);
            require(rawHash instanceof String && ((String) rawHash).matches("[0-9a-f]{64}"));
            String hash = (String) rawHash;
            require(!result.containsKey(hash));
            if (index == 0) require(hash.equals(state.getString("hash")));
            if (blockHeight == 0) require(hash.equals(state.getString("genesis_hash")));
            result.put(hash, blockHeight);
        }
        return result;
    }

    private static MobileClaimBlockWindow join(JSONObject state, Map<String, Long> prefix, MobileClaimBlockWindow known) throws Exception {
        int fullSize = (int)Math.min(600L, state.getLong("height") + 1);
        if (known == null) { require(prefix.size() == fullSize); return new MobileClaimBlockWindow(state, prefix); }
        sameTip(known.tip, state);
        Map<Long, String> oldHeights = new LinkedHashMap<>();
        for (Map.Entry<String, Long> block : known.blocks.entrySet()) oldHeights.put(block.getValue(), block.getKey());
        Long anchor = null;
        for (Map.Entry<String, Long> block : prefix.entrySet()) {
            Long oldHeight = known.blocks.get(block.getKey());
            if (oldHeight != null) { require(oldHeight.equals(block.getValue())); if (anchor == null) anchor = oldHeight; }
            // Once a known hash anchors the chain, every overlapping ancestor
            // must match. Never combine mutually inconsistent server replies.
            if (anchor != null && oldHeights.containsKey(block.getValue())) require(oldHeights.get(block.getValue()).equals(block.getKey()));
        }
        if (prefix.size() == fullSize) return new MobileClaimBlockWindow(state, prefix);
        if (anchor == null) return null;
        Map<String, Long> merged = new LinkedHashMap<>();
        for (Map.Entry<String, Long> block : prefix.entrySet()) if (block.getValue() > anchor) merged.put(block.getKey(), block.getValue());
        for (Map.Entry<String, Long> block : known.blocks.entrySet()) {
            if (block.getValue() <= anchor && merged.size() < fullSize) merged.put(block.getKey(), block.getValue());
        }
        // A rollback can find an anchor but require older hashes absent from
        // the cache. Escalate rather than silently truncating the window.
        return merged.size() == fullSize ? new MobileClaimBlockWindow(state, merged) : null;
    }

    private static void require(boolean condition) { if (!condition) throw new IllegalArgumentException("CLAIMS_RPC_DATA"); }
}
