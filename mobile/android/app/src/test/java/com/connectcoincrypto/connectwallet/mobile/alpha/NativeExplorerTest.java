package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class NativeExplorerTest {
    private static final String TXID = "0123456789abcdef".repeat(4);

    @Test public void onlyBuildsTheFixedHttpsMainnetTransactionUrl() throws Exception {
        assertEquals("https://explorer.connectcoincrypto.com/tx/" + TXID,
            NativeExplorer.transactionUrl(new JSONObject().put("txid", TXID)));
        assertEquals("https://explorer.connectcoincrypto.com/tx/" + "0".repeat(64),
            NativeExplorer.transactionUrl(new JSONObject().put("txid", "0".repeat(64))));
        assertEquals("https://explorer.connectcoincrypto.com/tx/" + "f".repeat(64),
            NativeExplorer.transactionUrl(new JSONObject().put("txid", "f".repeat(64))));
    }

    @Test public void refusesAllOptionsExceptOneStringTxidWithoutCoercion() throws Exception {
        invalid(null);
        invalid(new JSONObject());
        invalid(new JSONObject().put("url", "https://example.com"));
        invalid(new JSONObject().put("txid", TXID).put("url", "https://example.com"));
        invalid(new JSONObject().put("txid", TXID).put("network", "testnet"));
        for (Object value : new Object[] { JSONObject.NULL, 1, true, new JSONObject(), new JSONArray() }) {
            invalid(new JSONObject().put("txid", value));
        }
    }

    @Test public void rejectsNonCanonicalIdsAndUrlInjection() throws Exception {
        for (String value : new String[] { "", TXID.toUpperCase(), TXID.substring(1), TXID + "a", " " + TXID,
                TXID + "\n", "https://example.com/" + TXID, "../" + TXID, "g".repeat(64),
                "a".repeat(63) + "?", "a".repeat(63) + "#", "a".repeat(63) + "/", "a".repeat(63) + "\\",
                "a".repeat(63) + "\u0000", "a".repeat(63) + "\uff46", "a".repeat(100_000) }) {
            invalid(new JSONObject().put("txid", value));
        }
    }

    private static void invalid(JSONObject options) {
        try { NativeExplorer.transactionUrl(options); fail("Invalid explorer request was accepted"); }
        catch (IllegalArgumentException expected) { assertEquals("INVALID_ARGUMENT", expected.getMessage()); }
    }
}
