package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.Arrays;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Offline device test: PUBLIC BIP39 vectors only, no files, network, wallet import or broadcast. */
@RunWith(AndroidJUnit4.class)
public class NativeWalletCryptoSmokeTest {
    private static final String MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    @Test public void androidUnicodeMnemonicWhitespaceMatchesDesktop() throws Exception {
        int[] whitespace = {9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
            8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279};
        for (int code : whitespace) {
            String separator = Character.toString((char) code);
            String phrase = separator + MNEMONIC.replace(" ", separator + separator) + separator;
            assertEquals("Whitespace U+" + Integer.toHexString(code), MNEMONIC, WalletCrypto.normalizeMnemonic(phrase));
            assertTrue(WalletCrypto.validateMnemonic(phrase));
        }
        for (int code : new int[]{0, 8, 14, 28, 31, 133, 6158, 8203, 8288}) {
            String separator = Character.toString((char) code);
            assertFalse(WalletCrypto.validateMnemonic(MNEMONIC.replace(" ", separator)));
            assertFalse(WalletCrypto.validateMnemonic(separator + MNEMONIC + separator));
        }
        assertEquals("", WalletCrypto.normalizeMnemonic("\ufeff\u2028\u2029\u1680\t\r\n"));
        try (VaultSession session = new VaultSession("\ufeff" + MNEMONIC.replace(" ", "\u2028\u00a0") + "\ufeff", "")) {
            assertEquals("cc1p4t449ht5jnpkzpyaue7vdq8g867th0d7kymr0kfvmpzlwqcg4a0qc59p3e", session.publicAccount(0, 0).getString("address"));
        }
    }
    @Test public void androidJniSignsOfficialBip340VectorAndLocks() throws Exception {
        byte[] privateKey = new byte[32]; privateKey[31] = 3;
        try {
            byte[] signature = WalletCrypto.SECP.signSchnorr(new byte[32], privateKey, new byte[32]);
            assertEquals("e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0", WalletCrypto.hex(signature));
            assertTrue(WalletCrypto.verifySchnorr(signature, new byte[32], WalletCrypto.fromHex("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9")));
        } finally { WalletCrypto.wipe(privateKey); }
        VaultSession session = new VaultSession(MNEMONIC, "");
        try {
            JSONObject account = session.publicAccount(0, 0);
            assertEquals("m/44'/0'/0'/0/0", account.getString("path"));
            assertEquals("main", account.getString("network"));
            assertEquals("cc1p4t449ht5jnpkzpyaue7vdq8g867th0d7kymr0kfvmpzlwqcg4a0qc59p3e", account.getString("address"));
            assertEquals("aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e", account.getString("publicKey"));
            byte[] pubkey = WalletCrypto.decodeAddress(account.getString("address"));
            byte[] first = session.signDigest(new byte[32], 0, 0), second = session.signDigest(new byte[32], 0, 0);
            assertFalse(Arrays.equals(first, second)); assertTrue(WalletCrypto.verifySchnorr(first, new byte[32], pubkey));
        } finally { session.close(); }
        assertTrue(session.isLocked());
        try { session.publicAccount(0, 0); fail("Locked session derived an account"); } catch (IllegalStateException expected) { }
    }
    @Test public void androidAesGcmAndDesktopCostScryptRoundTripWithoutPersistence() throws Exception {
        // Do not silently skip: wallet creation must satisfy this budget.
        assertTrue("Desktop-compatible scrypt requires a >=256MiB application heap", Runtime.getRuntime().maxMemory() >= 256L * 1024 * 1024);
        char[] password = "Public instrumentation password!".toCharArray();
        try {
            JSONObject payload = WalletVault.newPayload("PUBLIC TEST ONLY", MNEMONIC, "caf\u00e9");
            JSONObject encrypted = WalletVault.encrypt(payload, password);
            JSONObject decrypted = WalletVault.decrypt(WalletVault.parse(WalletVault.serialize(encrypted)), password);
            assertEquals(MNEMONIC, decrypted.getString("mnemonic")); assertEquals("caf\u00e9", decrypted.getString("passphrase"));
            String tag = encrypted.getString("tag"); encrypted.put("tag", (tag.charAt(0) == '0' ? "1" : "0") + tag.substring(1));
            try { WalletVault.decrypt(encrypted, password); fail("Tampered GCM tag accepted"); } catch (IllegalArgumentException expected) { }
        } finally { Arrays.fill(password, '\0'); }
    }
}
