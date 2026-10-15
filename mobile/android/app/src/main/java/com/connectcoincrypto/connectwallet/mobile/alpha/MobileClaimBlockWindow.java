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
    private final Map<String, Long> counts;

    private MobileClaimBlockWindow(JSONObject state, Map<String, Long> rows) throws Exception {
        this(state, rows, Collections.emptyMap());
    }
    private MobileClaimBlockWindow(JSONObject state, Map<String, Long> rows, Map<String, Long> sizes) throws Exception {
        tip = MobileClaimsEngine.validateTip(state);
        blocks = Collections.unmodifiableMap(new LinkedHashMap<>(rows));
        counts = Collections.unmodifiableMap(new LinkedHashMap<>(sizes));
    }

    JSONObject tip() throws Exception { return new JSONObject(tip.toString()); }
    Map<String, Long> blocks() { return blocks; }
    Map<String, Long> counts() { return counts; }
    MobileClaimBlockWindow withoutCounts() throws Exception { return new MobileClaimBlockWindow(tip, blocks); }

    static boolean sameTip(JSONObject left, JSONObject right) throws Exception {
        left = MobileClaimsEngine.validateTip(left); right = MobileClaimsEngine.validateTip(right);
        if (!left.getString("hash").equals(right.getString("hash"))) return false;
        require(left.getLong("height") == right.getLong("height") && left.getLong("mediantime") == right.getLong("mediantime"));
        return true;
    }

    static MobileClaimBlockWindow refresh(MobileClaimBlockWindow known, JSONObject expectedTip, boolean force, Query query) throws Exception {
        MobileClaimsEngine.validateTip(expectedTip);
        if (known != null && !force && sameTip(known.tip, expectedTip)) return known;
        for (int count : known == null || force ? new int[] {600} : new int[] {5, 100, 600}) {
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
            Map<String, Long> sizes = new LinkedHashMap<>();
            if (response.has("bounty_counts")) {
                require(MobileBountyCodec.number(response.opt("bounty_counts"), 1, 1) == 1);
                for (int i = 0; i < response.getJSONArray("blocks").length(); i++) {
                    JSONObject row = response.getJSONArray("blocks").getJSONObject(i);
                    long size = MobileBountyCodec.number(row.opt("bounty_count"), 0, 100000);
                    String hash = row.getString("hash");
                    if (!force && known != null && known.counts.containsKey(hash)) require(known.counts.get(hash) == size);
                    sizes.put(hash, size);
                }
            } else for (int i = 0; i < response.getJSONArray("blocks").length(); i++) require(!response.getJSONArray("blocks").getJSONObject(i).has("bounty_count"));
            if (joined != null) {
                if (!force && known != null) for (Map.Entry<String, Long> old : known.counts.entrySet())
                    if (joined.blocks.containsKey(old.getKey()) && !sizes.containsKey(old.getKey())) sizes.put(old.getKey(), old.getValue());
                return new MobileClaimBlockWindow(state, joined.blocks, sizes);
            }
        }
        throw new IllegalArgumentException("CLAIMS_RPC_DATA");
    }

    /** Counted suffix from the same publication as a fully validated feed page. */
    static MobileClaimBlockWindow fromDelta(MobileClaimBlockWindow known, JSONObject page) throws Exception {
        if (!page.has("block_deltas")) { require(!page.has("block_delta")); return null; }
        require(MobileBountyCodec.number(page.opt("block_deltas"), 1, 1) == 1 && MobileBountyCodec.number(page.opt("bounty_deltas"), 1, 1) == 1 && page.has("block_delta") && known != null);
        JSONObject state = MobileClaimsEngine.validateTip(page.optJSONObject("tip"));
        if (page.isNull("block_delta")) { require(!sameTip(known.tip, state)); return null; }
        JSONObject delta = page.getJSONObject("block_delta"); require(delta.length() == 3);
        require(MobileBountyCodec.number(delta.opt("base_height"), 0, SAFE_MAX) == known.tip.getLong("height") && MobileBountyCodec.hash(delta.opt("base_hash")).equals(known.tip.getString("hash")));
        JSONArray rows = delta.getJSONArray("blocks"); require(rows.length() <= 5 && rows.length() == state.getLong("height") - known.tip.getLong("height"));
        Map<String, Long> additions = new LinkedHashMap<>(), sizes = new LinkedHashMap<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i); require(row.length() == 3);
            String hash = MobileBountyCodec.hash(row.opt("hash")); long height = MobileBountyCodec.number(row.opt("height"), 0, SAFE_MAX);
            require(height == known.tip.getLong("height") + i + 1 && !known.blocks.containsKey(hash) && !additions.containsKey(hash));
            additions.put(hash, height); sizes.put(hash, MobileBountyCodec.number(row.opt("bounty_count"), 0, 100000));
        }
        if (rows.length() == 0) require(sameTip(known.tip, state));
        else require(rows.getJSONObject(rows.length() - 1).getString("hash").equals(state.getString("hash")));
        Map<String, Long> all = new LinkedHashMap<>();
        for (int i = rows.length() - 1; i >= 0; i--) { JSONObject row = rows.getJSONObject(i); all.put(row.getString("hash"), row.getLong("height")); }
        int length = (int)Math.min(600L, state.getLong("height") + 1);
        for (Map.Entry<String, Long> row : known.blocks.entrySet()) if (all.size() < length) { all.put(row.getKey(), row.getValue()); if (known.counts.containsKey(row.getKey())) sizes.put(row.getKey(), known.counts.get(row.getKey())); }
        require(all.size() == length); return new MobileClaimBlockWindow(state, all, sizes);
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
