package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Pure public fixtures: no vault, passwords, keys, preferences or network. */
public class NativeAccountPolicyTest {
    private static final String OWN = "cc1p8w0r8l9z0lanx4h5ghvkfvlfanfjdqn0023x7qez6g6w4nc702nq2p2437";
    private static final String OTHER = "cc1pacjc369srd0cjfxy6raj8fr4wktpkq6us6fwxg96xtvmssj0xkaqznkk74";
    private static JSONObject account() throws Exception { return new JSONObject().put("address", OWN); }
    private static JSONObject params(Object address) throws Exception { return new JSONObject().put("address", address); }

    @Test public void everyPublicQueryRequiresNativeAccountIncludingTip() throws Exception {
        for (String method : new String[] { "getchaintip", "getaddressbalance", "getaddresshistory" }) {
            JSONObject request = params(OWN);
            assertThrows(IllegalStateException.class, () -> NativeAccountPolicy.requireQuery(null, method, request));
        }
    }

    @Test public void onlyOwnBalanceAndHistoryAreAllowed() throws Exception {
        JSONObject account = account(), request = params(OWN), other = params(OTHER);
        assertEquals(OWN, NativeAccountPolicy.requireQuery(account, "getchaintip", new JSONObject()));
        for (String method : new String[] { "getaddressbalance", "getaddresshistory" }) {
            assertEquals(OWN, NativeAccountPolicy.requireQuery(account, method, request));
            assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireQuery(account, method, other));
        }
    }

    @Test public void addressTypesAreNotCoercedOrDefaulted() throws Exception {
        JSONObject account = account();
        for (Object value : new Object[] { JSONObject.NULL, 7, true, new JSONArray().put(OWN), new JSONObject(), "", OWN + " ", OWN.toUpperCase(java.util.Locale.ROOT) }) {
            JSONObject request = params(value);
            assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireQuery(account, "getaddressbalance", request));
            assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireReward(account, value));
        }
        assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireQuery(account, "getaddresshistory", new JSONObject()));
        assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireReward(account, null));
    }

    @Test public void missingNativeAddressDoesNotAdoptRendererAddress() throws Exception {
        for (JSONObject missing : new JSONObject[] { new JSONObject(), params(JSONObject.NULL), params(7), params("") }) {
            assertThrows(IllegalStateException.class, () -> NativeAccountPolicy.requireReward(missing, OWN));
        }
    }

    @Test public void unsupportedMethodsAndMissingParamsAreRejected() throws Exception {
        JSONObject account = account(), request = params(OWN);
        for (String method : new String[] { null, "sendrawtransaction", "getaddressutxos", "GetAddressBalance" }) {
            assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireQuery(account, method, request));
        }
        assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireQuery(account, "getchaintip", null));
    }

    @Test public void lockedWalletPublicMetadataStillPermitsOwnRewardsAndReads() throws Exception {
        // This is precisely the retained public object; there is no session or
        // private key in the policy API and no unlocked flag to bypass.
        JSONObject retained = account().put("locked", true);
        assertEquals(OWN, NativeAccountPolicy.requireReward(retained, OWN));
        assertEquals(OWN, NativeAccountPolicy.requireQuery(retained, "getaddresshistory", params(OWN)));
        assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireReward(retained, OTHER));
    }

    @Test public void capturedIdentityRejectsReplacementRemovalAndWrongTypes() throws Exception {
        assertTrue(NativeAccountPolicy.matches(account(), OWN));
        assertFalse(NativeAccountPolicy.matches(params(OTHER), OWN));
        assertFalse(NativeAccountPolicy.matches(null, OWN));
        assertFalse(NativeAccountPolicy.matches(account(), null));
        assertFalse(NativeAccountPolicy.matches(params(new JSONArray().put(OWN)), OWN));
    }
    @Test public void hdQueriesAcceptOnlyNativeOwnedUniqueAddressScopes() throws Exception {
        JSONArray accounts = new JSONArray().put(account()).put(params(OTHER));
        for (String method : new String[]{"getaddresshistory", "getaddressbalance", "getaddressutxos"}) {
            assertEquals(OWN, NativeAccountPolicy.requireQuery(accounts, OWN, method, params(OTHER)));
            assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireQuery(accounts, OWN, method, params("cc1pforeign")));
        }
        JSONObject changes = new JSONObject().put("addresses", new JSONArray().put(OWN).put(OTHER));
        assertEquals(OWN, NativeAccountPolicy.requireQuery(accounts, OWN, "getaddresschanges", changes));
        assertEquals(OTHER, NativeAccountPolicy.requireReward(accounts, OTHER));
        for (JSONArray invalid : new JSONArray[]{new JSONArray(), new JSONArray().put(OWN).put(OWN), new JSONArray().put(OWN).put("foreign"), new JSONArray().put(7)}) {
            assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireQuery(accounts, OWN, "getaddresschanges", new JSONObject().put("addresses", invalid)));
        }
        assertThrows(IllegalStateException.class, () -> NativeAccountPolicy.requireQuery(accounts, "different-wallet", "getchaintip", new JSONObject()));
        assertThrows(IllegalArgumentException.class, () -> NativeAccountPolicy.requireQuery(accounts, OWN, "sendrawtransaction", new JSONObject()));
    }
}
