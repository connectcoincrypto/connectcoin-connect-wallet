package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import com.connectcoincrypto.connectwallet.mobile.alpha.NativeWalletBackup;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.generators.SCrypt;
import org.json.JSONObject;
import org.junit.Test;

/** Public deterministic desktop vectors only; never opens a real wallet file. */
public class NativeWalletImportTest {
    /** Public-fixture export for reciprocal verification by desktop decryptVault. */
    public static void main(String[] args) throws Exception {
        try (WalletVault.UpdateSession imported = NativeWalletBackup.openForImport(
                DesktopVectors.ENVELOPE.getBytes(StandardCharsets.UTF_8), DesktopVectors.PASSWORD.toCharArray())) {
            System.out.println(WalletVault.serialize(imported.envelope()));
        }
    }
    @Test public void authenticDesktopFileImportsWithItsPathsPassphraseAndNewRecoveryState() throws Exception {
        byte[] original = DesktopVectors.ENVELOPE.getBytes(StandardCharsets.UTF_8), unchanged = original.clone();
        char[] password = DesktopVectors.PASSWORD.toCharArray();
        try (WalletVault.UpdateSession imported = NativeWalletBackup.openForImport(original, password)) {
            JSONObject payload = imported.payload();
            assertEquals(DesktopVectors.MNEMONIC, payload.getString("mnemonic")); assertEquals("main", payload.getString("network"));
            assertEquals("caf\u00e9 \ud83d\udd11", payload.getString("passphrase"));
            assertEquals(7, payload.getInt("receiveIndex")); assertEquals(3, payload.getInt("changeIndex"));
            assertTrue(payload.getBoolean("needsRecovery")); assertFalse(payload.getBoolean("mobileHdRecovered"));
            assertNotEquals(WalletVault.parse(original).getString("nonce"), imported.envelope().getString("nonce"));
            assertEquals(WalletVault.parse(original).getString("salt"), imported.envelope().getString("salt"));
            String exported = WalletVault.serialize(imported.envelope());
            assertTrue(exported.contains("\"kdf\":{\"name\":\"scrypt\",\"N\":131072,\"r\":8,\"p\":1,\"keyLength\":32}"));
            assertFalse(exported.contains("mnemonic"));
            JSONObject reopened = WalletVault.decrypt(WalletVault.parse(exported), DesktopVectors.PASSWORD.toCharArray());
            assertEquals(payload.toString(), reopened.toString());
        }
        assertArrayEquals(unchanged, original); assertArrayEquals(new char[password.length], password);
    }
    @Test public void importedMetadataIsPreservedWithoutTrustingPreviousRecoveryReadiness() throws Exception {
        JSONObject original = WalletVault.newPayload("My saved wallet", DesktopVectors.MNEMONIC, "saved seed passphrase")
            .put("receiveIndex", 41).put("changeIndex", 27).put("lastUsedReceive", 38).put("lastUsedChange", 24)
            .put("scanLookahead", true).put("needsRecovery", false).put("mobileHdRecovered", true)
            .put("futureSettings", new JSONObject().put("unicode", "caf\u00e9").put("enabled", true));
        byte[] encrypted = WalletVault.serialize(WalletVault.encrypt(original, DesktopVectors.PASSWORD.toCharArray())).getBytes(StandardCharsets.UTF_8);
        try (WalletVault.UpdateSession imported = NativeWalletBackup.openForImport(encrypted, DesktopVectors.PASSWORD.toCharArray())) {
            JSONObject payload = imported.payload();
            for (String field : new String[]{"name", "mnemonic", "network", "passphrase", "receiveIndex", "changeIndex", "lastUsedReceive", "lastUsedChange", "scanLookahead"}) assertEquals(field, original.get(field), payload.get(field));
            assertEquals(original.getJSONObject("futureSettings").toString(), payload.getJSONObject("futureSettings").toString());
            assertTrue(payload.getBoolean("needsRecovery")); assertFalse(payload.getBoolean("mobileHdRecovered"));
        }
    }
    @Test public void failedAuthenticationOrParsingConsumesThePasswordAndReturnsNoSession() {
        char[] wrong = "Wrong public fixture password!".toCharArray();
        assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.openForImport(DesktopVectors.ENVELOPE.getBytes(StandardCharsets.UTF_8), wrong));
        assertArrayEquals(new char[wrong.length], wrong);
        char[] invalid = DesktopVectors.PASSWORD.toCharArray();
        assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.openForImport("{} trailing".getBytes(StandardCharsets.UTF_8), invalid));
        assertArrayEquals(new char[invalid.length], invalid);
    }
    private static byte[] authenticatedPublicFixture(byte[] plaintext) throws Exception {
        JSONObject envelope = WalletVault.parse(DesktopVectors.ENVELOPE);
        byte[] salt = WalletCrypto.fromHex(envelope.getString("salt")), nonce = new byte[12], key = null, encrypted = null;
        WalletCrypto.RANDOM.nextBytes(nonce);
        try {
            key = SCrypt.generate(DesktopVectors.PASSWORD.getBytes(StandardCharsets.UTF_8), salt, 131072, 8, 1, 32);
            envelope.put("nonce", WalletCrypto.hex(nonce));
            String serialized = WalletVault.serialize(envelope);
            String header = serialized.substring(0, serialized.indexOf(",\"ciphertext\"")) + "}";
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(header.getBytes(StandardCharsets.UTF_8)); encrypted = cipher.doFinal(plaintext);
            envelope.put("ciphertext", WalletCrypto.hex(Arrays.copyOfRange(encrypted, 0, encrypted.length - 16)))
                .put("tag", WalletCrypto.hex(Arrays.copyOfRange(encrypted, encrypted.length - 16, encrypted.length)));
            return WalletVault.serialize(envelope).getBytes(StandardCharsets.UTF_8);
        } finally { WalletCrypto.wipe(key); WalletCrypto.wipe(encrypted); WalletCrypto.wipe(nonce); WalletCrypto.wipe(salt); }
    }
    @Test public void evenAuthenticatedWrongNetworkAndAmbiguousPlaintextFailClosed() throws Exception {
        String payload = WalletVault.newPayload("Public invalid-data fixture", DesktopVectors.MNEMONIC, "").toString();
        byte[] invalidUtf8 = Arrays.copyOf(payload.getBytes(StandardCharsets.UTF_8), payload.getBytes(StandardCharsets.UTF_8).length + 1);
        invalidUtf8[invalidUtf8.length - 1] = (byte)0xff;
        for (byte[] invalid : new byte[][]{
                payload.replace("\"main\"", "\"testnet4\"").getBytes(StandardCharsets.UTF_8),
                (payload + "{}").getBytes(StandardCharsets.UTF_8),
                (payload.substring(0, payload.length() - 1) + ",\"network\":\"main\"}").getBytes(StandardCharsets.UTF_8), invalidUtf8 }) {
            byte[] envelope = authenticatedPublicFixture(invalid); char[] password = DesktopVectors.PASSWORD.toCharArray();
            IllegalArgumentException failure = assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.openForImport(envelope, password));
            assertEquals("Cannot unlock wallet: incorrect password or damaged wallet file", failure.getMessage());
            assertArrayEquals(new char[password.length], password);
        }
    }
}
