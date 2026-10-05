package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Strict public RPC schemas used before native payment selection. No secret or network access. */
public final class NativePaymentChecks {
    private NativePaymentChecks() {}
    public static final String GENESIS = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e";
    private static void require(boolean condition) { if (!condition) throw new IllegalArgumentException("Invalid or changed mainnet payment data. Refresh and review again."); }
    private static void fields(JSONObject object, String... expected) {
        require(object != null); Set<String> actual = new HashSet<>(); Iterator<String> keys = object.keys(); while (keys.hasNext()) actual.add(keys.next());
        require(actual.equals(new HashSet<>(Arrays.asList(expected))));
    }
    private static long integer(Object value, long minimum, long maximum) {
        require(value instanceof Integer || value instanceof Long); long number = ((Number)value).longValue(); require(number >= minimum && number <= maximum); return number;
    }
    private static String string(Object value) { require(value instanceof String); return (String)value; }
    private static String hash(Object value) { String text = string(value); require(text.matches("[0-9a-f]{64}")); return text; }
    public static JSONObject tip(JSONObject value) throws Exception {
        fields(value, "chain", "genesis_hash", "height", "hash", "mediantime"); require("main".equals(value.opt("chain")) && GENESIS.equals(value.opt("genesis_hash")));
        long height = integer(value.opt("height"), 0, Integer.MAX_VALUE); String block = hash(value.opt("hash")); integer(value.opt("mediantime"), 0, 0xffffffffL);
        require(height != 0 || GENESIS.equals(block)); return new JSONObject(value.toString());
    }
    public static void sameTip(JSONObject first, JSONObject second) throws Exception {
        JSONObject a = tip(first), b = tip(second);
        for (String key : new String[]{"hash", "height", "mediantime"}) require(a.get(key).toString().equals(b.get(key).toString()));
    }
    public static JSONArray utxos(JSONObject page, String address, JSONObject anchor) throws Exception {
        fields(page, "address", "tip", "unit", "live", "items", "next_cursor");
        require(address.equals(page.opt("address")) && "connects".equals(page.opt("unit")) && Boolean.TRUE.equals(page.opt("live")));
        WalletCrypto.decodeAddress(address); sameTip(anchor, page.getJSONObject("tip"));
        JSONArray rows = page.getJSONArray("items"); require(rows.length() <= 500); Set<String> seen = new HashSet<>();
        String cursor = cursor(page); require(cursor == null || rows.length() > 0);
        long tipHeight = anchor.getLong("height");
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            fields(row, "txid", "vout", "amount", "block_height", "status", "confirmations", "coinbase", "mature", "pending_spent_by");
            String txid = hash(row.opt("txid")); long vout = integer(row.opt("vout"), 0, 0xffffffffL);
            require(seen.add(txid + ":" + vout)); NativeTransactions.amount(string(row.opt("amount")));
            require(row.opt("coinbase") instanceof Boolean && row.opt("mature") instanceof Boolean);
            long confirmations = integer(row.opt("confirmations"), 0, (long)Integer.MAX_VALUE + 1);
            boolean coinbase = row.getBoolean("coinbase"), mature = row.getBoolean("mature");
            if ("pending".equals(row.opt("status"))) require(row.isNull("block_height") && confirmations == 0 && !coinbase && mature);
            else { require("confirmed".equals(row.opt("status"))); long height = integer(row.opt("block_height"), 0, tipHeight); require(confirmations == tipHeight - height + 1 && mature == (!coinbase || confirmations >= 100)); }
            if (!row.isNull("pending_spent_by")) hash(row.opt("pending_spent_by"));
        }
        return rows;
    }
    public static String cursor(JSONObject page) throws Exception {
        require(page.has("next_cursor")); if (page.isNull("next_cursor")) return null;
        String cursor = string(page.get("next_cursor")); require(cursor.length() <= 1024 && cursor.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")); return cursor;
    }
    /** Response is an ordered prefix followed by explicit remaining IDs, not an unordered complete batch. */
    public static JSONArray transactions(JSONObject response, JSONArray requested, JSONObject anchor) throws Exception {
        fields(response, "tip", "transactions", "remaining"); sameTip(anchor, response.getJSONObject("tip"));
        require(requested.length() > 0 && requested.length() <= 32); Set<String> ids = new HashSet<>();
        for (int i = 0; i < requested.length(); i++) require(ids.add(hash(requested.get(i))));
        JSONArray transactions = response.getJSONArray("transactions"), remaining = response.getJSONArray("remaining");
        require(transactions.length() > 0 && transactions.length() + remaining.length() == requested.length());
        long bytes = 0;
        for (int i = 0; i < transactions.length(); i++) {
            JSONObject item = transactions.getJSONObject(i); fields(item, "txid", "hex"); require(requested.getString(i).equals(hash(item.opt("txid"))));
            String hex = string(item.opt("hex")); bytes += hex.length(); require(bytes <= 8_000_000 && hex.length() >= 20 && hex.length() % 2 == 0 && hex.matches("[0-9a-fA-F]+"));
            require(NativeTransactions.txid(NativeTransactions.parse(hex)).equals(item.getString("txid")));
        }
        for (int i = 0; i < remaining.length(); i++) require(requested.getString(i + transactions.length()).equals(hash(remaining.get(i))));
        return transactions;
    }
}
