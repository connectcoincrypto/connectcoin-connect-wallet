package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** Pure, privately-owned compact feed decoder. No network, cache mutation or admission. */
final class MobileBountyCodec {
    static final long SAFE = 9007199254740991L;
    static final class UnknownReference extends Exception { private static final long serialVersionUID = 1L; }
    static void require(boolean value) { if (!value) throw new IllegalArgumentException("CLAIMS_RPC_DATA"); }
    static long number(Object value, long min, long max) {
        require(value instanceof Integer || value instanceof Long);
        long n = ((Number)value).longValue(); require(n >= min && n <= max); return n;
    }
    static String hash(Object value) { require(value instanceof String && ((String)value).matches("[0-9a-f]{64}")); return (String)value; }
    static String cursor(Object value) { require(value instanceof String && ((String)value).matches("[A-Za-z0-9_.-]{1,1024}")); return (String)value; }
    static boolean stateEvent(String type) { return Arrays.asList("pending_spend", "spent", "available_again", "matured").contains(type); }
    static String digest(JSONArray parts) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(parts.toString().getBytes(StandardCharsets.UTF_8));
        StringBuilder value = new StringBuilder(64); for (byte b : bytes) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return value.toString();
    }
    static String stateDigest(JSONObject tip, String cursor) throws Exception {
        MobileClaimsEngine.validateTip(tip); cursor(cursor);
        return digest(new JSONArray().put("bounty-state-v1").put(tip.get("chain")).put(tip.get("genesis_hash"))
            .put(tip.get("height")).put(tip.get("hash")).put(tip.get("mediantime")).put(cursor));
    }
    static String immutableDigest(JSONObject row) throws Exception {
        JSONArray values = new JSONArray().put("bounty-immutable-v1");
        for (String key : new String[] {"txid", "vout", "block_hash", "block_height", "amount", "domain", "connection_work_target", "root_certificates_version", "signature_algorithms_mask", "coinbase"}) values.put(row.get(key));
        return digest(values);
    }
    static void validateRow(JSONObject row, JSONObject publication) throws Exception {
        require(row != null); new MobileClaimsEngine.Candidate(row, hash(row.opt("block_hash")), 0, MobileClaimScheduler.FACTOR_SCALE);
        long height = number(row.opt("block_height"), 0, publication.getLong("height"));
        require(height >= Math.max(0, publication.getLong("height") - 599));
        require(number(row.opt("confirmations"), 1, SAFE) == publication.getLong("height") - height + 1);
        require(row.has("spending_txid")); String status = row.getString("status");
        boolean spent = status.equals("spent") || status.equals("pending_spend");
        require(spent == !row.isNull("spending_txid")); if (spent) hash(row.opt("spending_txid"));
        require(status.equals("immature") == (row.getBoolean("coinbase") && row.getLong("confirmations") < 100));
        if (height == publication.getLong("height")) require(row.getString("block_hash").equals(publication.getString("hash")));
        if (height == 0) require(row.getString("block_hash").equals(publication.getString("genesis_hash")));
    }
    static JSONObject decode(JSONObject source, JSONObject base, String checkpoint, Map<String, JSONObject> rows, int requested) throws Exception {
        return decode(source, base, checkpoint, rows, requested, java.util.Collections.emptyMap());
    }
    static JSONObject decode(JSONObject source, JSONObject base, String checkpoint, Map<String, JSONObject> rows, int requested, Map<String, Long> knownBlocks) throws Exception {
        return decode(source, base, checkpoint, rows, requested, knownBlocks, java.util.Collections.emptyMap());
    }
    static JSONObject decode(JSONObject source, JSONObject base, String checkpoint, Map<String, JSONObject> rows, int requested, Map<String, Long> knownBlocks, Map<String, Long> knownCounts) throws Exception {
        return decode(source, base, checkpoint, rows, requested, knownBlocks, knownCounts, -1);
    }
    static JSONObject decode(JSONObject source, JSONObject base, String checkpoint, Map<String, JSONObject> rows, int requested, Map<String, Long> knownBlocks, Map<String, Long> knownCounts, long minimumSequence) throws Exception {
        require(source != null); JSONObject page = new JSONObject(source.toString());
        if (!page.has("compact")) {
            require(!page.has("unchanged") && !page.has("tips"));
            if (page.has("bounty_deltas")) require(number(page.opt("bounty_deltas"), 1, 1) == 1);
            return page;
        }
        int version = (int)number(page.opt("compact"), 1, requested); require(requested > 0);
        if (page.has("unchanged")) {
            require(page.length() == 2 && Boolean.TRUE.equals(page.opt("unchanged")) && base != null && checkpoint != null);
            MobileClaimsEngine.validateTip(base); cursor(checkpoint);
            return new JSONObject().put("tip", new JSONObject(base.toString())).put("changes", new JSONArray()).put("has_more", false).put("next_cursor", checkpoint)
                .put("bounty_deltas", 1).put("block_deltas", 1).put("block_delta", new JSONObject().put("base_height", base.getLong("height")).put("base_hash", base.getString("hash")).put("blocks", new JSONArray()));
        }
        if (version == 3) {
            if (!page.has("changes")) page.put("changes", new JSONArray());
            if (!page.has("tips")) page.put("tips", new JSONArray());
            if (!page.has("has_more")) page.put("has_more", false);
            if (!page.has("next_cursor")) page.put("next_cursor", JSONObject.NULL);
        }
        require(page.opt("changes") instanceof JSONArray && page.opt("tips") instanceof JSONArray && page.opt("has_more") instanceof Boolean);
        JSONArray changes = page.getJSONArray("changes"), tips = page.getJSONArray("tips");
        require(changes.length() <= 500 && tips.length() <= changes.length());
        boolean bound = false;
        if (version >= 2) {
            require(!page.has("bounty_deltas") && !page.has("block_deltas") && page.has("tip") && page.has("next_cursor"));
            bound = page.opt("tip") instanceof JSONArray || version == 3 && page.isNull("tip");
            require(bound == (page.opt("block_delta") instanceof JSONArray));
            if (bound) {
                require(base != null && checkpoint != null); MobileClaimsEngine.validateTip(base); cursor(checkpoint);
                JSONArray pairs = page.getJSONArray("block_delta"); require(pairs.length() <= 5);
                JSONObject state;
                if (page.isNull("tip")) { require(pairs.length() == 0); state = new JSONObject(base.toString()); }
                else {
                    JSONArray tuple = page.getJSONArray("tip"); require(tuple.length() == 3);
                    state = new JSONObject().put("chain", base.get("chain")).put("genesis_hash", base.get("genesis_hash"))
                        .put("height", tuple.get(0)).put("hash", tuple.get(1)).put("mediantime", tuple.get(2));
                    MobileClaimsEngine.validateTip(state);
                }
                JSONArray blocks = new JSONArray();
                for (int i = 0; i < pairs.length(); i++) {
                    JSONArray pair = pairs.getJSONArray(i); require(pair.length() == 2); long height = base.getLong("height") + i + 1;
                    Object raw = pair.get(0); String id;
                    if (raw == JSONObject.NULL) { require(i == pairs.length() - 1 && height == state.getLong("height")); id = state.getString("hash"); }
                    else id = hash(raw);
                    blocks.put(new JSONObject().put("height", height).put("hash", id).put("bounty_count", number(pair.get(1), 0, 100000)));
                }
                page.put("tip", state).put("block_delta", new JSONObject().put("base_height", base.getLong("height")).put("base_hash", base.getString("hash")).put("blocks", blocks));
                if (page.isNull("next_cursor")) { require(changes.length() == 0 && Boolean.FALSE.equals(page.opt("has_more"))); page.put("next_cursor", checkpoint); }
            }
            require(page.opt("next_cursor") instanceof String);
            page.put("bounty_deltas", 1); if (page.has("block_delta")) page.put("block_deltas", 1);
        } else require(number(page.opt("bounty_deltas"), 1, 1) == 1);
        JSONObject current = MobileClaimsEngine.validateTip(page.optJSONObject("tip")); cursor(page.opt("next_cursor"));
        require(!page.getBoolean("has_more") || changes.length() > 0);
        require(changes.length() == 0 || checkpoint == null || !checkpoint.equals(page.getString("next_cursor")));
        validateDelta(page, base, current, knownBlocks);
        Map<Long, String> canonical = new java.util.LinkedHashMap<>();
        Map<String, Long> counts = new java.util.LinkedHashMap<>();
        // Only a proven extension (or the exact same tip) may borrow the
        // owned window. A null reorg suffix cannot bind an old branch.
        if (base != null && (page.opt("block_delta") instanceof JSONObject || MobileClaimBlockWindow.sameTip(base, current))) {
            for (Map.Entry<String, Long> block : knownBlocks.entrySet()) if (block.getValue() >= Math.max(0, current.getLong("height") - 599)) canonical.put(block.getValue(), block.getKey());
            counts.putAll(knownCounts);
            JSONObject delta = page.optJSONObject("block_delta");
            if (delta != null) for (int i = 0; i < delta.getJSONArray("blocks").length(); i++) {
                JSONObject block = delta.getJSONArray("blocks").getJSONObject(i);
                canonical.put(block.getLong("height"), block.getString("hash")); counts.put(block.getString("hash"), block.getLong("bounty_count"));
            }
        }
        for (int i = 0; i < tips.length(); i++) {
            JSONObject t = MobileClaimsEngine.validateTip(tips.getJSONObject(i)); require(t.getLong("height") <= current.getLong("height"));
            if (t.getLong("height") == current.getLong("height")) require(MobileClaimBlockWindow.sameTip(t, current));
        }
        // References are page-local copies: an added row can serve a later
        // delta in this page without publishing or mutating the caller's cache.
        Map<String, JSONObject> references = new java.util.LinkedHashMap<>(rows);
        boolean missing = false; long previous = minimumSequence;
        for (int i = 0; i < changes.length(); i++) {
            JSONObject event = changes.getJSONObject(i); require(!event.has("tip"));
            long sequence = number(event.opt("sequence"), 0, SAFE); require(sequence > previous); previous = sequence;
            long ref = number(event.opt("tip_ref"), version == 3 ? -2 : version == 2 ? -1 : 0, SAFE);
            JSONObject publication;
            if (ref == -2) { require(bound && base != null); publication = base; }
            else if (ref == -1) publication = current;
            else { require(ref < tips.length()); publication = tips.getJSONObject((int)ref); }
            if (canonical.containsKey(publication.getLong("height"))) require(canonical.get(publication.getLong("height")).equals(publication.getString("hash")));
            event.put("tip", new JSONObject(publication.toString())); event.remove("tip_ref");
            String type = event.optString("type", "");
            require(stateEvent(type) || type.equals("added") || type.equals("window_exit") || type.equals("resync_required"));
            if (type.equals("resync_required")) throw new IllegalArgumentException("CLAIMS_RESYNC");
            if (version >= 2 && type.equals("added")) {
                JSONObject row = event.optJSONObject("bounty"); require(row != null);
                for (String key : new String[] {"txid", "vout", "block_hash", "block_height"}) { require(!event.has(key) && row.has(key)); event.put(key, row.get(key)); }
            }
            String txid = hash(event.opt("txid")); long vout = number(event.opt("vout"), 0, 0xffffffffL);
            if (event.has("block_hash")) hash(event.opt("block_hash"));
            if (event.has("block_height")) number(event.opt("block_height"), 0, SAFE);
            if (event.has("spending_txid_ref")) {
                require(version >= 2 && stateEvent(type) && Boolean.TRUE.equals(event.opt("spending_txid_ref")) && !event.has("spending_txid"));
                JSONObject delta = event.optJSONObject("bounty_delta"); require(delta != null && delta.has("spending_txid")); event.put("spending_txid", delta.get("spending_txid")); event.remove("spending_txid_ref");
            }
            if (event.has("spending_txid") && !event.isNull("spending_txid")) hash(event.opt("spending_txid"));
            if (stateEvent(type)) {
                require(!event.has("bounty")); hash(event.opt("bounty_ref")); JSONObject delta = event.optJSONObject("bounty_delta"); require(delta != null);
                require(delta.length() == (delta.has("confirmations") ? 3 : 2) && delta.has("status") && delta.has("spending_txid"));
                require(version == 3 || delta.has("confirmations"));
                String status = delta.optString("status", ""); require(Arrays.asList("available", "immature", "pending_spend", "spent").contains(status));
                boolean spent = status.equals("spent") || status.equals("pending_spend"); require(spent == !delta.isNull("spending_txid")); if (spent) hash(delta.opt("spending_txid"));
                if (delta.has("confirmations")) number(delta.opt("confirmations"), 1, SAFE);
                JSONObject row = references.get(txid + ":" + vout);
                if (row == null) { missing = true; continue; }
                require(immutableDigest(row).equals(event.getString("bounty_ref")));
                row = new JSONObject(row.toString()); row.put("status", delta.get("status")).put("spending_txid", delta.get("spending_txid"));
                row.put("confirmations", delta.has("confirmations") ? delta.get("confirmations") : publication.getLong("height") - row.getLong("block_height") + 1);
                validateRow(row, publication); bindOuterBlock(event, row); canonicalRow(row, canonical, counts);
                event.put("bounty", row); event.remove("bounty_ref"); event.remove("bounty_delta");
                references.put(txid + ":" + vout, row);
            } else {
                require(!event.has("bounty_ref") && !event.has("bounty_delta") && event.has("bounty"));
                if (type.equals("window_exit")) {
                    require(event.isNull("bounty")); JSONObject previousRow = references.get(txid + ":" + vout);
                    String previousHash = previousRow == null ? null : previousRow.optString("block_hash", "");
                    if (canonical.containsValue(previousHash) || event.has("block_hash") && canonical.containsValue(event.getString("block_hash"))) throw new IllegalArgumentException("CLAIMS_RESYNC");
                    references.remove(txid + ":" + vout);
                }
                else {
                    JSONObject row = event.optJSONObject("bounty"); validateRow(row, publication);
                    canonicalRow(row, canonical, counts);
                    require(txid.equals(row.getString("txid")) && vout == row.getLong("vout"));
                    require(hash(event.opt("block_hash")).equals(row.getString("block_hash")) && number(event.opt("block_height"), 0, SAFE) == row.getLong("block_height"));
                    references.put(txid + ":" + vout, row);
                }
            }
        }
        if (missing) throw new UnknownReference();
        page.remove("compact"); page.remove("tips"); return page;
    }
    static void bindOuterBlock(JSONObject event, JSONObject row) throws Exception {
        if (event.has("block_hash")) require(hash(event.opt("block_hash")).equals(row.getString("block_hash")));
        if (event.has("block_height")) require(number(event.opt("block_height"), 0, SAFE) == row.getLong("block_height"));
    }
    private static void canonicalRow(JSONObject row, Map<Long, String> blocks, Map<String, Long> counts) throws Exception {
        if (blocks.containsKey(row.getLong("block_height"))) require(blocks.get(row.getLong("block_height")).equals(row.getString("block_hash")));
        if (counts.containsKey(row.getString("block_hash"))) require(counts.get(row.getString("block_hash")) > 0);
    }
    private static void validateDelta(JSONObject page, JSONObject base, JSONObject current, Map<String, Long> knownBlocks) throws Exception {
        if (!page.has("block_deltas")) { require(!page.has("block_delta")); return; }
        require(number(page.opt("block_deltas"), 1, 1) == 1 && page.has("block_delta") && base != null);
        if (page.isNull("block_delta")) { require(!MobileClaimBlockWindow.sameTip(base, current)); return; }
        JSONObject delta = page.getJSONObject("block_delta"); require(delta.length() == 3);
        require(number(delta.opt("base_height"), 0, SAFE) == base.getLong("height") && hash(delta.opt("base_hash")).equals(base.getString("hash")));
        JSONArray blocks = delta.getJSONArray("blocks"); require(blocks.length() <= 5 && blocks.length() == current.getLong("height") - base.getLong("height"));
        java.util.Set<String> hashes = new java.util.HashSet<>(knownBlocks.keySet()); hashes.add(base.getString("hash"));
        for (int i = 0; i < blocks.length(); i++) {
            JSONObject block = blocks.getJSONObject(i); require(block.length() == 3);
            require(number(block.opt("height"), 0, SAFE) == base.getLong("height") + i + 1 && hashes.add(hash(block.opt("hash"))));
            number(block.opt("bounty_count"), 0, 100000);
        }
        if (blocks.length() == 0) require(MobileClaimBlockWindow.sameTip(base, current));
        else require(blocks.getJSONObject(blocks.length() - 1).getString("hash").equals(current.getString("hash")));
    }
}
