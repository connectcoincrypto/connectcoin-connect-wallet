package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class NativePaymentChecksTest {
    private JSONObject tip() throws Exception { return new JSONObject().put("chain", "main").put("genesis_hash", NativePaymentChecks.GENESIS).put("height", 120).put("hash", "aa".repeat(32)).put("mediantime", 1700000000); }
    private JSONObject fixture() throws Exception { return new JSONObject(TransactionVectors.JSON); }
    private JSONObject row() throws Exception { return new JSONObject().put("txid", "bb".repeat(32)).put("vout", 0).put("amount", "10000000000").put("block_height", 10).put("status", "confirmed").put("confirmations", 111).put("coinbase", true).put("mature", true).put("pending_spent_by", JSONObject.NULL); }
    private JSONObject page() throws Exception { return new JSONObject().put("address", fixture().getString("rewardAddress")).put("tip", tip()).put("unit", "connects").put("live", true).put("items", new JSONArray().put(row())).put("next_cursor", JSONObject.NULL); }
    @Test public void mainnetTipIdentityAndWholeAnchorAreRequired() throws Exception {
        assertEquals(120, NativePaymentChecks.tip(tip()).getInt("height"));
        for (String key : new String[]{"hash", "height", "mediantime"}) {
            JSONObject changed = tip().put(key, key.equals("hash") ? "bb".repeat(32) : key.equals("height") ? 121 : 1700000001);
            assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.sameTip(tip(), changed));
        }
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.tip(tip().put("chain", "testnet4")));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.tip(tip().put("height", "120")));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.tip(tip().put("height", 120.5)));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.tip(tip().put("height", 0)));
    }
    @Test public void rpcItemsAndNullablePendingSpenderStringAreValidated() throws Exception {
        JSONObject page = page(); String address = page.getString("address");
        assertEquals(1, NativePaymentChecks.utxos(page, address, tip()).length());
        page.getJSONArray("items").getJSONObject(0).put("pending_spent_by", "cc".repeat(32));
        assertEquals("cc".repeat(32), NativePaymentChecks.utxos(page, address, tip()).getJSONObject(0).getString("pending_spent_by"));
        page.getJSONArray("items").getJSONObject(0).put("pending_spent_by", new JSONArray());
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.utxos(page, address, tip()));
        JSONObject wrongSchema = page().put("utxos", new JSONArray()); wrongSchema.remove("items");
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.utxos(wrongSchema, address, tip()));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.utxos(page(), fixture().getString("changeAddress"), tip()));
    }
    @Test public void maturityMoneyLocationDuplicatesAndCursorCannotBeForged() throws Exception {
        String address = page().getString("address");
        for (String field : new String[]{"amount", "vout", "confirmations", "mature", "coinbase", "block_height"}) {
            JSONObject altered = page(); Object bad = field.equals("amount") ? "1e10" : field.equals("mature") ? false : field.equals("coinbase") ? "true" : -1;
            altered.getJSONArray("items").getJSONObject(0).put(field, bad);
            assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.utxos(altered, address, tip()));
        }
        JSONObject duplicate = page(); duplicate.getJSONArray("items").put(row());
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.utxos(duplicate, address, tip()));
        JSONObject cursorWithoutRows = page().put("items", new JSONArray()).put("next_cursor", "YWJj.c2ln");
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.utxos(cursorWithoutRows, address, tip()));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.cursor(page().put("next_cursor", "x".repeat(1025))));
        JSONObject pending = page(); pending.getJSONArray("items").put(0, row().put("status", "pending").put("block_height", JSONObject.NULL).put("confirmations", 0).put("coinbase", false));
        assertEquals(1, NativePaymentChecks.utxos(pending, address, tip()).length());
    }
    @Test public void compactParentBatchesMustBeOrderedPrefixWithExactRemaining() throws Exception {
        JSONObject f = fixture(), candidate = f.getJSONObject("candidate"); String id = candidate.getString("txid");
        JSONArray ids = new JSONArray().put(id).put(f.getJSONObject("bounty").getString("txid"));
        JSONObject response = new JSONObject().put("tip", tip()).put("transactions", new JSONArray().put(new JSONObject().put("txid", id).put("hex", candidate.getString("rawTransaction")))).put("remaining", new JSONArray().put(ids.getString(1)));
        assertEquals(1, NativePaymentChecks.transactions(response, ids, tip()).length());
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.transactions(new JSONObject(response.toString()).put("remaining", new JSONArray()), ids, tip()));
        JSONObject swapped = new JSONObject(response.toString()); swapped.getJSONArray("transactions").getJSONObject(0).put("txid", ids.getString(1));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.transactions(swapped, ids, tip()));
        JSONObject forged = new JSONObject(response.toString()); forged.getJSONArray("transactions").getJSONObject(0).put("hex", f.getString("bountyHex"));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.transactions(forged, ids, tip()));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentChecks.transactions(response, new JSONArray().put(id).put(id), tip()));
    }
}
