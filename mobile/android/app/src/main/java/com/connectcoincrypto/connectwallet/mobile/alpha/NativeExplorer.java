package com.connectcoincrypto.connectwallet.mobile.alpha;

import org.json.JSONObject;

/** The renderer may choose a transaction, never an external host, scheme or path. */
final class NativeExplorer {
    private static final String TRANSACTION_URL = "https://explorer.connectcoincrypto.com/tx/";

    private NativeExplorer() {}

    static String transactionUrl(JSONObject options) {
        if (options == null || options.length() != 1 || !options.has("txid")) throw invalid();
        Object value = options.opt("txid");
        if (!(value instanceof String)) throw invalid();
        String txid = (String) value;
        if (txid.length() != 64) throw invalid();
        for (int i = 0; i < txid.length(); i++) {
            char c = txid.charAt(i);
            if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) throw invalid();
        }
        return TRANSACTION_URL + txid;
    }

    private static IllegalArgumentException invalid() { return new IllegalArgumentException("INVALID_ARGUMENT"); }
}
