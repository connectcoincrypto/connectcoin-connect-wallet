package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class WalletCryptoTest {
    private static String words(int count, String last) { return String.join(" ", java.util.Collections.nCopies(count - 1, "abandon")) + " " + last; }
    @Test public void bip39OfficialVectorsAndNormalization() {
        assertEquals(words(12, "about"), WalletCrypto.mnemonicFromEntropy(new byte[16]));
        assertEquals(words(18, "agent"), WalletCrypto.mnemonicFromEntropy(new byte[24]));
        assertEquals(words(24, "art"), WalletCrypto.mnemonicFromEntropy(new byte[32]));
        assertEquals(DesktopVectors.MNEMONIC, WalletCrypto.normalizeMnemonic("  " + DesktopVectors.MNEMONIC.toUpperCase(java.util.Locale.ROOT).replace(" ", "\u3000") + "\n"));
        assertEquals("c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04", WalletCrypto.hex(WalletCrypto.mnemonicToSeed(DesktopVectors.MNEMONIC, "TREZOR")));
        assertArrayEquals(WalletCrypto.mnemonicToSeed(DesktopVectors.MNEMONIC, "caf\u00e9"), WalletCrypto.mnemonicToSeed(DesktopVectors.MNEMONIC, "cafe\u0301"));
    }
    @Test public void rejectsInvalidMnemonicCountsChecksumsAndBounds() {
        for (String value : new String[]{null, "", words(12, "abandon"), words(15, "about"), words(21, "about"), "x".repeat(1025), "not english words"}) assertFalse(WalletCrypto.validateMnemonic(value));
        assertThrows(IllegalArgumentException.class, () -> WalletCrypto.generateMnemonic(15));
        assertThrows(IllegalArgumentException.class, () -> WalletCrypto.mnemonicToSeed(DesktopVectors.MNEMONIC, "x".repeat(1025)));
        assertThrows(IllegalArgumentException.class, () -> new VaultSession(words(12, "abandon"), ""));
    }
    @Test public void mnemonicWhitespaceMatchesDesktopWithoutJavaRegexFlags() {
        int[] whitespace = {9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197,
            8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279};
        for (int code : whitespace) {
            String separator = Character.toString((char) code);
            String phrase = separator + DesktopVectors.MNEMONIC.replace(" ", separator + separator) + separator;
            assertEquals("Whitespace U+" + Integer.toHexString(code), DesktopVectors.MNEMONIC, WalletCrypto.normalizeMnemonic(phrase));
            assertTrue(WalletCrypto.validateMnemonic(phrase));
        }
        for (int code : new int[]{0, 8, 14, 28, 31, 133, 6158, 8203, 8288}) {
            String separator = Character.toString((char) code);
            String phrase = DesktopVectors.MNEMONIC.replace(" ", separator);
            assertEquals(phrase, WalletCrypto.normalizeMnemonic(phrase));
            assertFalse(WalletCrypto.validateMnemonic(phrase));
            assertFalse(WalletCrypto.validateMnemonic(separator + DesktopVectors.MNEMONIC + separator));
        }
        assertEquals("", WalletCrypto.normalizeMnemonic("\ufeff\u2028\u2029\u1680\t\r\n"));
        assertArrayEquals(WalletCrypto.mnemonicToSeed(DesktopVectors.MNEMONIC, ""),
            WalletCrypto.mnemonicToSeed("\ufeff" + DesktopVectors.MNEMONIC.replace(" ", "\u2028\u00a0") + "\ufeff", ""));
    }
    @Test public void generatedPhrasesUseFreshEntropyForEverySupportedSize() {
        Set<String> seen = new HashSet<>();
        for (int count : new int[]{12, 18, 24}) for (int i = 0; i < 8; i++) {
            String phrase = WalletCrypto.generateMnemonic(count);
            assertEquals(count, phrase.split(" ").length); assertTrue(WalletCrypto.validateMnemonic(phrase)); assertTrue(seen.add(phrase));
        }
    }
    @Test public void mainnetUntweakedAccountsMatchDesktopIncludingParityAndBoundary() throws Exception {
        JSONArray rows = new JSONArray(DesktopVectors.ROWS);
        for (int i = 0; i < rows.length(); i++) {
            JSONObject vector = rows.getJSONObject(i);
            try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, vector.getString("passphrase"))) {
                JSONObject actual = session.publicAccount(vector.getInt("index"), vector.getInt("change"));
                for (String key : new String[]{"publicKey", "address", "path"}) assertEquals(vector.getString(key), actual.getString(key));
                assertEquals("main", actual.getString("network")); assertEquals(6, actual.length());
                assertFalse(actual.has("privateKey")); assertFalse(actual.has("mnemonic")); assertFalse(actual.has("chainCode"));
                byte[] publicKey = WalletCrypto.decodeAddress(actual.getString("address"));
                assertEquals(vector.getString("publicKey"), WalletCrypto.hex(publicKey));
                assertArrayEquals(publicKey, WalletCrypto.decodeAddress(actual.getString("address").toUpperCase(java.util.Locale.ROOT)));
                assertTrue(WalletCrypto.verifySchnorr(WalletCrypto.fromHex(vector.getString("signature")), WalletCrypto.fromHex(vector.getString("digest")), publicKey));
                byte[] first = session.signDigest(WalletCrypto.fromHex(vector.getString("digest")), vector.getInt("index"), vector.getInt("change"));
                byte[] second = session.signDigest(WalletCrypto.fromHex(vector.getString("digest")), vector.getInt("index"), vector.getInt("change"));
                assertFalse(Arrays.equals(first, second)); assertTrue(WalletCrypto.verifySchnorr(first, WalletCrypto.fromHex(vector.getString("digest")), publicKey));
                byte[] changed = WalletCrypto.fromHex(vector.getString("digest")); changed[0] ^= 1; assertFalse(WalletCrypto.verifySchnorr(first, changed, publicKey));
            }
        }
    }
    @Test public void bip340KnownPublicKeyAndDeterministicZeroAuxiliaryVector() {
        byte[] secret = new byte[32]; secret[31] = 3;
        byte[] pub = Arrays.copyOfRange(WalletCrypto.SECP.pubkeyCreate(secret), 1, 33);
        assertEquals("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9", WalletCrypto.hex(pub));
        byte[] signature = WalletCrypto.SECP.signSchnorr(new byte[32], secret, new byte[32]);
        assertEquals("e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0", WalletCrypto.hex(signature));
        assertTrue(WalletCrypto.verifySchnorr(signature, new byte[32], pub)); WalletCrypto.wipe(secret);
    }
    @Test public void invalidAddressesAndCurvePointsAreRejected() throws Exception {
        String address = new JSONArray(DesktopVectors.ROWS).getJSONObject(0).getString("address");
        for (String bad : new String[]{null, "", "t" + address, address.substring(0, 2).toUpperCase() + address.substring(2), address.substring(0, 61) + (address.endsWith("q") ? "p" : "q"), " " + address, address + " ", "cc1" + "q".repeat(59)}) assertThrows(IllegalArgumentException.class, () -> WalletCrypto.decodeAddress(bad));
        assertThrows(IllegalArgumentException.class, () -> WalletCrypto.validatePublicKey(new byte[32]));
        byte[] tooLarge = new byte[32]; Arrays.fill(tooLarge, (byte) 255);
        assertThrows(IllegalArgumentException.class, () -> WalletCrypto.encodeAddress(tooLarge));
        assertThrows(IllegalArgumentException.class, () -> WalletCrypto.validatePublicKey(new byte[33]));
        assertFalse(WalletCrypto.verifySchnorr(new byte[63], new byte[32], new byte[32]));
    }
    @Test public void lockingWipesRetainedNativeSessionArraysAndBlocksAllOperations() throws Exception {
        VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "");
        Field branches = VaultSession.class.getDeclaredField("branches"); branches.setAccessible(true);
        Object[] nodes = (Object[]) branches.get(session);
        Field key = nodes[0].getClass().getDeclaredField("key"), chain = nodes[0].getClass().getDeclaredField("chain"); key.setAccessible(true); chain.setAccessible(true);
        byte[] firstKey = (byte[]) key.get(nodes[0]), firstChain = (byte[]) chain.get(nodes[0]); assertFalse(Arrays.equals(firstKey, new byte[32]));
        session.lock(); session.close(); assertTrue(session.isLocked()); assertNull(branches.get(session));
        assertArrayEquals(new byte[32], firstKey); assertArrayEquals(new byte[32], firstChain);
        assertThrows(IllegalStateException.class, () -> session.publicAccount(0, 0));
        assertThrows(IllegalStateException.class, () -> session.signDigest(new byte[32], 0, 0));
        try (VaultSession fresh = new VaultSession(DesktopVectors.MNEMONIC, "different passphrase")) {
            assertNotEquals(new JSONArray(DesktopVectors.ROWS).getJSONObject(0).getString("address"), fresh.publicAccount(0, 0).getString("address"));
        }
    }
    @Test public void derivationOnlyAllowsNormalReceiveAndChangeIndices() {
        try (VaultSession session = new VaultSession(DesktopVectors.MNEMONIC, "")) {
            assertThrows(IllegalArgumentException.class, () -> session.publicAccount(-1, 0));
            assertThrows(IllegalArgumentException.class, () -> session.publicAccount(0, 2));
            assertThrows(IllegalArgumentException.class, () -> session.signDigest(new byte[31], 0, 0));
            assertThrows(IllegalArgumentException.class, () -> session.signDigest(null, 0, 0));
        }
    }
    @Test public void hashingAndHexAreStrict() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", WalletCrypto.hex(WalletCrypto.sha256(new byte[]{97, 98, 99})));
        assertThrows(IllegalArgumentException.class, () -> WalletCrypto.fromHex("00zz"));
        assertThrows(IllegalArgumentException.class, () -> WalletCrypto.fromHex("0"));
        assertThrows(IllegalArgumentException.class, () -> WalletCrypto.fromHex("\uff10\uff10"));
    }
}
