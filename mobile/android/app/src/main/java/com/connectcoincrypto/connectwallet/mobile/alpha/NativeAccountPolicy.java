package com.connectcoincrypto.connectwallet.mobile.alpha;

import org.json.JSONObject;
import org.json.JSONArray;
import java.util.HashSet;

/** Public account binding only. The account must come from the native vault,
 * never an RPC response, renderer argument or saved watch-only preference.
 * No unlocked session is required: its derived public account survives lock.
 */
final class NativeAccountPolicy {
    private NativeAccountPolicy() {}

    private static String address(JSONObject account) {
        Object value = account == null ? null : account.opt("address");
        if (!(value instanceof String) || ((String) value).isEmpty()) {
            throw new IllegalStateException("Create or unlock your native wallet first.");
        }
        return (String) value;
    }

    static String requireReward(JSONObject account, Object requested) {
        String own = address(account);
        if (!(requested instanceof String) || !own.equals(requested)) {
            throw new IllegalArgumentException("Use the address of your native wallet.");
        }
        return own;
    }

    static String requireQuery(JSONObject account, String method, JSONObject params) {
        String own = address(account);
        if (params == null) throw new IllegalArgumentException("Invalid public query.");
        if ("getchaintip".equals(method)) return own;
        if (!"getaddressbalance".equals(method) && !"getaddresshistory".equals(method)) {
            throw new IllegalArgumentException("Unsupported public query.");
        }
        return requireReward(account, params.opt("address"));
    }

    static boolean matches(JSONObject account, String expected) {
        return expected != null && account != null && expected.equals(account.opt("address"));
    }

    static boolean owns(JSONArray accounts, String requested) {
        if (accounts == null || requested == null) return false;
        for (int i = 0; i < accounts.length(); i++) {
            JSONObject account = accounts.optJSONObject(i);
            if (account != null && requested.equals(account.opt("address"))) return true;
        }
        return false;
    }
    static String requireReward(JSONArray accounts, Object requested) {
        if (accounts == null || accounts.length() == 0) throw new IllegalStateException("Create or unlock your native wallet first.");
        if (!(requested instanceof String) || !owns(accounts, (String)requested)) throw new IllegalArgumentException("Use an address of your native wallet.");
        return (String)requested;
    }
    /** Only the native-derived public account set can authorize read scope.
     * Return stable wallet identity, not its changing receiving address. */
    static String requireQuery(JSONArray accounts, String walletId, String method, JSONObject params) {
        if (!owns(accounts, walletId)) throw new IllegalStateException("Create or unlock your native wallet first.");
        if (params == null) throw new IllegalArgumentException("Invalid public query.");
        if ("getchaintip".equals(method)) return walletId;
        if ("getaddressbalance".equals(method) || "getaddresshistory".equals(method) || "getaddressutxos".equals(method)) {
            requireReward(accounts, params.opt("address")); return walletId;
        }
        if ("getaddresschanges".equals(method)) {
            Object value = params.opt("addresses");
            if (!(value instanceof JSONArray)) throw new IllegalArgumentException("Invalid wallet address query.");
            JSONArray addresses = (JSONArray)value; HashSet<String> seen = new HashSet<>();
            if (addresses.length() < 1 || addresses.length() > 100) throw new IllegalArgumentException("Query between 1 and 100 native wallet addresses.");
            for (int i = 0; i < addresses.length(); i++) {
                String own = requireReward(accounts, addresses.opt(i));
                if (!seen.add(own)) throw new IllegalArgumentException("Duplicate wallet address query.");
            }
            return walletId;
        }
        throw new IllegalArgumentException("Unsupported public query.");
    }
}
