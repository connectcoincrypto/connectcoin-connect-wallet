package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class WalletVaultTest {
    @Test public void decryptsRealDesktopV1EnvelopeWithoutMigration() throws Exception {
        JSONObject actual = WalletVault.decrypt(WalletVault.parse(DesktopVectors.ENVELOPE), DesktopVectors.PASSWORD.toCharArray());
        assertEquals(DesktopVectors.MNEMONIC, actual.getString("mnemonic")); assertEquals("main", actual.getString("network"));
        assertEquals("caf\u00e9 \ud83d\udd11", actual.getString("passphrase")); assertEquals(7, actual.getInt("receiveIndex")); assertEquals(3, actual.getInt("changeIndex"));
    }
    @Test public void randomizedEncryptionRoundTripsWithExactOrderedPortableHeader() throws Exception {
        JSONObject payload = WalletVault.newPayload("Public test fixture", DesktopVectors.MNEMONIC, "");
        char[] password = DesktopVectors.PASSWORD.toCharArray();
        JSONObject first = WalletVault.encrypt(payload, password), second = WalletVault.encrypt(payload, password);
        assertNotEquals(first.getString("salt"), second.getString("salt")); assertNotEquals(first.getString("nonce"), second.getString("nonce"));
        String serialized = WalletVault.serialize(first);
        assertTrue(serialized.contains("\"kdf\":{\"name\":\"scrypt\",\"N\":131072,\"r\":8,\"p\":1,\"keyLength\":32}"));
        assertFalse(serialized.contains("abandon"));
        assertEquals(DesktopVectors.MNEMONIC, WalletVault.decrypt(WalletVault.parse(serialized), password).getString("mnemonic"));
        assertArrayEquals(DesktopVectors.PASSWORD.toCharArray(), password); // Caller owns/clears its password buffer.
    }
    @Test public void authenticationRejectsWrongPasswordAndTamperedCiphertextTagNonceSalt() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> WalletVault.decrypt(WalletVault.parse(DesktopVectors.ENVELOPE), "incorrect public password".toCharArray()));
        for (String field : new String[]{"ciphertext", "tag", "nonce", "salt"}) {
            JSONObject copy = WalletVault.parse(DesktopVectors.ENVELOPE); String value = copy.getString(field);
            copy.put(field, (value.charAt(0) == '0' ? "1" : "0") + value.substring(1));
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () -> WalletVault.decrypt(copy, DesktopVectors.PASSWORD.toCharArray()));
            assertEquals("Cannot unlock wallet: incorrect password or damaged wallet file", error.getMessage());
        }
    }
    @Test public void hostileKdfAndFormatAreRejectedBeforeExpensiveWork() throws Exception {
        for (String field : new String[]{"N", "r", "p", "keyLength"}) {
            JSONObject copy = WalletVault.parse(DesktopVectors.ENVELOPE); copy.getJSONObject("kdf").put(field, 2147483647);
            assertThrows(IllegalArgumentException.class, () -> WalletVault.serialize(copy));
            assertThrows(IllegalArgumentException.class, () -> WalletVault.decrypt(copy, DesktopVectors.PASSWORD.toCharArray()));
        }
        JSONObject copy = WalletVault.parse(DesktopVectors.ENVELOPE); copy.getJSONObject("kdf").put("extra", true);
        assertThrows(IllegalArgumentException.class, () -> WalletVault.serialize(copy));
        for (Object version : new Object[]{2, "1", 1.0}) {
            JSONObject altered = WalletVault.parse(DesktopVectors.ENVELOPE).put("version", version);
            assertThrows(IllegalArgumentException.class, () -> WalletVault.serialize(altered));
        }
    }
    @Test public void sizeEncodingAndNetworkBoundsFailClosed() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> WalletVault.parse("x".repeat(WalletVault.MAX_FILE_BYTES + 1)));
        assertThrows(IllegalArgumentException.class, () -> WalletVault.parse("[]"));
        JSONObject payload = WalletVault.newPayload("Fixture", DesktopVectors.MNEMONIC, "").put("network", "testnet4");
        assertThrows(IllegalArgumentException.class, () -> WalletVault.encrypt(payload, DesktopVectors.PASSWORD.toCharArray()));
        payload.put("network", "main").put("receiveIndex", 0x80000000L);
        assertThrows(IllegalArgumentException.class, () -> WalletVault.validatePayload(payload));
        for (String password : new String[]{"short", "x".repeat(1025), "\u00e9".repeat(513), "12345678901\ud800"}) assertThrows(IllegalArgumentException.class, () -> WalletVault.validatePassword(password.toCharArray()));
        JSONObject wrongHex = WalletVault.parse(DesktopVectors.ENVELOPE).put("tag", "AA".repeat(16));
        assertThrows(IllegalArgumentException.class, () -> WalletVault.serialize(wrongHex));
    }
    @Test public void validatingPayloadMakesIndependentCopyAndNormalizesPhrase() throws Exception {
        JSONObject payload = WalletVault.newPayload("Fixture", "  " + DesktopVectors.MNEMONIC.toUpperCase(java.util.Locale.ROOT) + "  ", "");
        JSONObject copy = WalletVault.validatePayload(payload); copy.put("receiveIndex", 9);
        assertEquals(0, payload.getInt("receiveIndex")); assertEquals(DesktopVectors.MNEMONIC, payload.getString("mnemonic"));
    }
}
