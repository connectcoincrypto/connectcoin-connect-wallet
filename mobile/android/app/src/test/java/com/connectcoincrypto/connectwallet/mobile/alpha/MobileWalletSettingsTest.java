package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Pure validation and restoration; never invokes Android, DNS or the network. */
public class MobileWalletSettingsTest {
    private static JSONObject data() { return MobileWalletSettings.defaults().toJson(); }

    @Test public void defaultsMatchTheExistingDarkWalletAndNeverLockInForeground() {
        MobileWalletSettings.Settings defaults = MobileWalletSettings.defaults();
        assertEquals("dark", defaults.theme); assertEquals(0, defaults.autoLockMinutes);
        assertEquals("connectcoin4.com", defaults.rpcHost); assertEquals(48190, defaults.rpcPort);
        assertEquals(4, defaults.toJson().length());
    }

    @Test public void acceptsThemesIntegerBoundsAndCanonicalPublicDns() throws Exception {
        for (String theme : new String[] { "dark", "light", "system" }) {
            for (int minutes : new int[] { 0, 1, 60, 1440 }) for (int port : new int[] { 1, 48190, 65535 }) {
                MobileWalletSettings.Settings settings = MobileWalletSettings.parse(data().put("theme", theme)
                    .put("autoLockMinutes", (long) minutes).put("rpcHost", "RPC.EXAMPLE.COM").put("rpcPort", port));
                assertEquals(theme, settings.theme); assertEquals(minutes, settings.autoLockMinutes);
                assertEquals("rpc.example.com", settings.rpcHost); assertEquals(port, settings.rpcPort);
                assertEquals(settings.rpcHost, settings.endpoint().hostname); assertEquals(port, settings.endpoint().port);
            }
        }
    }

    @Test public void requiresExactlyTheFourNamedFields() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(null));
        assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(new JSONObject()));
        for (String field : new String[] { "theme", "autoLockMinutes", "rpcHost", "rpcPort" }) {
            JSONObject missing = data(); missing.remove(field);
            assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(missing));
            missing.put("unexpected", 1);
            assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(missing));
        }
        assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(data().put("method", "sendrawtransaction")));
    }

    @Test public void rejectsCoercionAndOutOfRangeNumbers() throws Exception {
        for (String field : new String[] { "autoLockMinutes", "rpcPort" }) {
            for (Object value : new Object[] { JSONObject.NULL, true, "1", 1.0, 1.5, -1, Long.MAX_VALUE, new JSONArray(), new JSONObject() }) {
                assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(data().put(field, value)));
            }
        }
        assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(data().put("autoLockMinutes", 1441)));
        assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(data().put("rpcPort", 0)));
        assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(data().put("rpcPort", 65536)));
        for (Object theme : new Object[] { "Dark", "auto", " dark", "", true, 1, JSONObject.NULL }) {
            assertThrows(IllegalArgumentException.class, () -> MobileWalletSettings.parse(data().put("theme", theme)));
        }
    }

    @Test public void endpointNeverAcceptsUrlsAddressesCredentialsOrLocalNames() throws Exception {
        for (Object host : new Object[] { JSONObject.NULL, 12, true, "", "localhost", "127.0.0.1", "192.168.0.1", "::1", "[::1]",
                "https://rpc.example.com", "tcp://rpc.example.com", "rpc.example.com/", "rpc.example.com:48190", "user@rpc.example.com",
                "rpc.example.com?method=x", "rpc.example.com#x", " rpc.example.com", "rpc.example.com ", "rpc.\texample.com", "rpc.example.com\n",
                "rpc.localhost", "rpc.local", "rpc.internal", "rpc..example.com", ".example.com", "example.com.", "-rpc.example.com",
                "rpc-.example.com", "rpc_ex.example.com", "éxample.com", "a".repeat(64) + ".com", ("a".repeat(63) + ".").repeat(4) + "com" }) {
            assertThrows(String.valueOf(host), IllegalArgumentException.class, () -> MobileWalletSettings.parse(data().put("rpcHost", host)));
        }
    }

    @Test public void endpointIdentityIgnoresOtherSettingsAndHostnameCase() throws Exception {
        MobileWalletSettings.Settings defaults = MobileWalletSettings.defaults();
        assertTrue(defaults.sameEndpoint(MobileWalletSettings.parse(data().put("theme", "light")
            .put("autoLockMinutes", 30).put("rpcHost", "CONNECTCOIN4.COM"))));
        assertFalse(defaults.sameEndpoint(MobileWalletSettings.parse(data().put("rpcPort", 48191))));
        assertFalse(defaults.sameEndpoint(MobileWalletSettings.parse(data().put("rpcHost", "rpc.example.com"))));
        assertFalse(defaults.sameEndpoint(null));
    }

    @Test public void restorationRoundTripsOrDefaultsTheEntireInvalidRecord() throws Exception {
        JSONObject valid = data().put("theme", "system").put("autoLockMinutes", 7).put("rpcHost", "rpc.example.com").put("rpcPort", 12345);
        MobileWalletSettings.Settings restored = MobileWalletSettings.restore(valid.toString());
        assertEquals("system", restored.theme); assertEquals(7, restored.autoLockMinutes);
        assertEquals("rpc.example.com", restored.rpcHost); assertEquals(12345, restored.rpcPort);
        for (Object bad : new Object[] { null, true, 42, "", "{", "{}", valid.put("rpcPort", 0).toString() }) {
            restored = MobileWalletSettings.restore(bad);
            assertEquals("dark", restored.theme); assertEquals(0, restored.autoLockMinutes);
            assertTrue(restored.sameEndpoint(MobileWalletSettings.defaults()));
        }
    }
}
