package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Public address fixtures only: no wallet files, network or user funds. */
public class NativeFundingScopeTest {
    private static final String FIRST = "cc1p8w0r8l9z0lanx4h5ghvkfvlfanfjdqn0023x7qez6g6w4nc702nq2p2437";
    private static final String SECOND = "cc1pacjc369srd0cjfxy6raj8fr4wktpkq6us6fwxg96xtvmssj0xkaqznkk74";
    private JSONObject input(Object scope) throws Exception { return new JSONObject().put("fundingAddresses", scope); }
    private JSONObject account(String address, int index) throws Exception {
        return new JSONObject().put("address", address).put("index", index).put("change", 0).put("publicKey", "native-owned-" + index);
    }
    @Test public void absentScopeKeepsLegacyBehaviorButMalformedPresentScopeFailsClosed() throws Exception {
        assertNull(NativeFundingScope.optional(new JSONObject()));
        for (Object invalid : new Object[]{JSONObject.NULL, true, 3, FIRST, new JSONObject(), new JSONArray(),
                new JSONArray().put(FIRST).put(FIRST), new JSONArray().put(1), new JSONArray().put(JSONObject.NULL),
                new JSONArray().put(FIRST.toUpperCase(java.util.Locale.ROOT)), new JSONArray().put(FIRST + " "),
                new JSONArray().put("t" + FIRST)}) {
            assertThrows(IllegalArgumentException.class, () -> NativeFundingScope.optional(input(invalid)));
        }
        JSONArray tooMany = new JSONArray(); for (int i = 0; i <= NativeFundingScope.MAX_ADDRESSES; i++) tooMany.put(FIRST);
        assertThrows(IllegalArgumentException.class, () -> NativeFundingScope.optional(input(tooMany)));
    }
    @Test public void selectedScopeUsesCopiedNativeMetadataAndNativeOrdering() throws Exception {
        JSONArray requested = new JSONArray().put(SECOND).put(FIRST);
        NativeFundingScope scope = NativeFundingScope.optional(input(requested));
        requested.put(0, "changed-renderer-value");
        JSONArray accounts = new JSONArray().put(account(FIRST, 0)).put(account(SECOND, 7));
        JSONArray selected = scope.select(accounts);
        assertEquals(FIRST, selected.getJSONObject(0).getString("address"));
        assertEquals(SECOND, selected.getJSONObject(1).getString("address"));
        assertEquals(7, selected.getJSONObject(1).getInt("index"));
        selected.getJSONObject(1).put("publicKey", "mutated-copy");
        assertEquals("native-owned-7", accounts.getJSONObject(1).getString("publicKey"));
        assertEquals("native-owned-7", scope.select(accounts).getJSONObject(1).getString("publicKey"));
    }
    @Test public void foreignOrReplacedWalletAndDuplicateNativeMetadataAreRejected() throws Exception {
        NativeFundingScope scope = NativeFundingScope.optional(input(new JSONArray().put(FIRST)));
        assertThrows(IllegalArgumentException.class, () -> scope.select(new JSONArray().put(account(SECOND, 0))));
        assertThrows(IllegalStateException.class, () -> scope.select(new JSONArray()));
        assertThrows(IllegalStateException.class, () -> scope.select(null));
        assertThrows(IllegalStateException.class, () -> scope.select(new JSONArray().put(account(FIRST, 0)).put(account(FIRST, 1))));
        JSONArray selected = scope.select(new JSONArray().put(account(FIRST, 0)).put(account(SECOND, 7)));
        assertEquals(1, selected.length()); assertEquals(FIRST, selected.getJSONObject(0).getString("address"));
    }
}
