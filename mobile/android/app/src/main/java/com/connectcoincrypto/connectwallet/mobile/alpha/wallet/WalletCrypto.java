package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import fr.acinq.secp256k1.Secp256k1;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.util.Arrays;
import java.util.Locale;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Native-only crypto boundary. No private material may be returned through a WebView bridge. */
public final class WalletCrypto {
    private WalletCrypto() {}
    static final SecureRandom RANDOM = new SecureRandom();
    static final Secp256k1 SECP = Secp256k1.get();
    private static final String BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    private static final int[] GENERATORS = {0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3};

    public static byte[] sha256(byte[] data) {
        if (data == null) throw new IllegalArgumentException("Missing hash input");
        try { return MessageDigest.getInstance("SHA-256").digest(data); }
        catch (Exception e) { throw new IllegalStateException("SHA-256 unavailable", e); }
    }
    public static byte[] hash256(byte[] data) { return sha256(sha256(data)); }
    public static byte[] taggedHash(String tag, byte[] data) {
        byte[] prefix = sha256(tag.getBytes(StandardCharsets.UTF_8));
        return sha256(concat(prefix, prefix, data));
    }
    public static byte[] concat(byte[]... arrays) {
        int size = 0;
        for (byte[] value : arrays) size = Math.addExact(size, value.length);
        byte[] out = new byte[size]; int at = 0;
        for (byte[] value : arrays) { System.arraycopy(value, 0, out, at, value.length); at += value.length; }
        return out;
    }
    public static String hex(byte[] data) {
        char[] out = new char[data.length * 2]; String alphabet = "0123456789abcdef";
        for (int i = 0; i < data.length; i++) { out[i * 2] = alphabet.charAt((data[i] & 255) >>> 4); out[i * 2 + 1] = alphabet.charAt(data[i] & 15); }
        return new String(out);
    }
    public static byte[] fromHex(String value) {
        if (value == null || value.length() % 2 != 0 || value.length() > 8_000_000) throw new IllegalArgumentException("Invalid hexadecimal data");
        byte[] out = new byte[value.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int a = Character.digit(value.charAt(i * 2), 16), b = Character.digit(value.charAt(i * 2 + 1), 16);
            if (a < 0 || b < 0 || value.charAt(i * 2) > 127 || value.charAt(i * 2 + 1) > 127) throw new IllegalArgumentException("Invalid hexadecimal data");
            out[i] = (byte) ((a << 4) | b);
        }
        return out;
    }
    public static void wipe(byte[] value) { if (value != null) Arrays.fill(value, (byte) 0); }
    public static void validatePublicKey(byte[] publicKey) {
        if (publicKey == null || publicKey.length != 32) throw new IllegalArgumentException("Expected a 32-byte public key");
        try { SECP.pubkeyParse(concat(new byte[]{2}, publicKey)); }
        catch (Exception e) { throw new IllegalArgumentException("Invalid public key"); }
    }
    public static boolean verifySchnorr(byte[] signature, byte[] digest, byte[] publicKey) {
        if (signature == null || signature.length != 64 || digest == null || digest.length != 32) return false;
        try { validatePublicKey(publicKey); return SECP.verifySchnorr(signature, digest, publicKey); }
        catch (Exception e) { return false; }
    }
    public static String encodeAddress(byte[] publicKey) {
        validatePublicKey(publicKey);
        byte[] words = convertBits(publicKey, 8, 5, true);
        int[] values = new int[1 + words.length + 6]; values[0] = 1;
        for (int i = 0; i < words.length; i++) values[i + 1] = words[i];
        int checksum = polymod(values) ^ 0x2bc830a3;
        StringBuilder out = new StringBuilder("cc1");
        for (int i = 0; i < values.length - 6; i++) out.append(BECH32.charAt(values[i]));
        for (int i = 0; i < 6; i++) out.append(BECH32.charAt((checksum >>> (5 * (5 - i))) & 31));
        return out.toString();
    }
    public static byte[] decodeAddress(String address) {
        if (address == null || address.length() > 90 || !address.equals(address.toLowerCase(Locale.ROOT)) && !address.equals(address.toUpperCase(Locale.ROOT))) throw new IllegalArgumentException("Invalid ConnectCoin address");
        String normalized = address.toLowerCase(Locale.ROOT);
        if (!normalized.startsWith("cc1") || normalized.length() != 62) throw new IllegalArgumentException("Expected a mainnet ConnectCoin address");
        int[] values = new int[normalized.length() - 3];
        for (int i = 0; i < values.length; i++) {
            values[i] = BECH32.indexOf(normalized.charAt(i + 3));
            if (values[i] < 0) throw new IllegalArgumentException("Invalid ConnectCoin address");
        }
        if (values[0] != 1 || polymod(values) != 0x2bc830a3) throw new IllegalArgumentException("Invalid ConnectCoin address checksum");
        byte[] words = new byte[values.length - 7];
        for (int i = 0; i < words.length; i++) words[i] = (byte) values[i + 1];
        byte[] key = convertBits(words, 5, 8, false); validatePublicKey(key); return key;
    }
    private static int polymod(int[] data) {
        int checksum = 1;
        // HRP expansion of mainnet's "cc". This API intentionally cannot select another chain.
        for (int value : new int[]{3, 3, 0, 3, 3}) checksum = polymodStep(checksum, value);
        for (int value : data) checksum = polymodStep(checksum, value);
        return checksum;
    }
    private static int polymodStep(int checksum, int value) {
        int high = checksum >>> 25; checksum = ((checksum & 0x1ffffff) << 5) ^ value;
        for (int i = 0; i < 5; i++) if (((high >>> i) & 1) != 0) checksum ^= GENERATORS[i];
        return checksum;
    }
    private static byte[] convertBits(byte[] input, int from, int to, boolean pad) {
        byte[] out = new byte[(input.length * from + to - 1) / to];
        int acc = 0, bits = 0, at = 0, mask = (1 << to) - 1;
        for (byte item : input) {
            int value = item & 255;
            if ((value >>> from) != 0) throw new IllegalArgumentException("Invalid address encoding");
            acc = ((acc << from) | value) & ((1 << (from + to - 1)) - 1); bits += from;
            while (bits >= to) { bits -= to; out[at++] = (byte) ((acc >>> bits) & mask); }
        }
        if (pad && bits > 0) out[at++] = (byte) ((acc << (to - bits)) & mask);
        else if (!pad && (bits >= from || ((acc << (to - bits)) & mask) != 0)) throw new IllegalArgumentException("Noncanonical address padding");
        return Arrays.copyOf(out, at);
    }
    public static String normalizeMnemonic(String value) {
        if (value == null || value.length() > 1024) throw new IllegalArgumentException("Invalid recovery phrase");
        String normalized = Normalizer.normalize(value, Normalizer.Form.NFKD).toLowerCase(Locale.ROOT);
        StringBuilder out = new StringBuilder(normalized.length()); boolean separator = false;
        for (int i = 0; i < normalized.length(); i++) {
            char character = normalized.charAt(i);
            if (mnemonicWhitespace(character)) { separator = out.length() > 0; continue; }
            if (separator) out.append(' ');
            out.append(character); separator = false;
        }
        return out.toString();
    }
    // Match desktop ECMAScript trim()/\s, not Java's broader Unicode classes or
    // trim()'s control characters. Android ICU rejects Java's inline (?U) flag.
    private static boolean mnemonicWhitespace(char value) {
        return value >= 0x0009 && value <= 0x000d || value == 0x0020 || value == 0x00a0
            || value == 0x1680 || value >= 0x2000 && value <= 0x200a || value == 0x2028
            || value == 0x2029 || value == 0x202f || value == 0x205f || value == 0x3000 || value == 0xfeff;
    }
    public static boolean validateMnemonic(String value) {
        try {
            String[] words = normalizeMnemonic(value).split(" ");
            if (words.length != 12 && words.length != 18 && words.length != 24) return false;
            int entropyBits = words.length / 3 * 32, checkBits = entropyBits / 32;
            byte[] entropy = new byte[entropyBits / 8]; int check = 0;
            try {
                for (int i = 0; i < words.length; i++) {
                    int word = Arrays.binarySearch(EnglishWords.WORDS, words[i]); if (word < 0) return false;
                    for (int j = 0; j < 11; j++) {
                        int bit = (word >>> (10 - j)) & 1, at = i * 11 + j;
                        if (at < entropyBits) entropy[at / 8] |= (byte) (bit << (7 - (at % 8)));
                        else check = (check << 1) | bit;
                    }
                }
                return check == ((sha256(entropy)[0] & 255) >>> (8 - checkBits));
            } finally { wipe(entropy); }
        } catch (RuntimeException e) { return false; }
    }
    public static String generateMnemonic(int count) {
        if (count != 12 && count != 18 && count != 24) throw new IllegalArgumentException("Choose 12, 18 or 24 recovery words");
        byte[] entropy = new byte[count / 3 * 4]; RANDOM.nextBytes(entropy);
        try { return mnemonicFromEntropy(entropy); } finally { wipe(entropy); }
    }
    static String mnemonicFromEntropy(byte[] entropy) {
        if (entropy == null || entropy.length != 16 && entropy.length != 24 && entropy.length != 32) throw new IllegalArgumentException("Invalid recovery entropy");
        byte[] checksum = sha256(entropy); StringBuilder out = new StringBuilder();
        int entropyBits = entropy.length * 8, count = entropy.length / 4 * 3;
        for (int i = 0; i < count; i++) {
            int word = 0;
            for (int j = 0; j < 11; j++) {
                int at = i * 11 + j;
                int bit = at < entropyBits ? ((entropy[at / 8] & 255) >>> (7 - at % 8)) & 1 : ((checksum[0] & 255) >>> (7 - (at - entropyBits))) & 1;
                word = (word << 1) | bit;
            }
            if (i > 0) out.append(' '); out.append(EnglishWords.WORDS[word]);
        }
        wipe(checksum); return out.toString();
    }
    /** BIP39 PBKDF2 is performed on explicit NFKD UTF-8 bytes, not provider-dependent char encoding. */
    public static byte[] mnemonicToSeed(String mnemonic, String passphrase) {
        String phrase = normalizeMnemonic(mnemonic);
        if (!validateMnemonic(phrase) || passphrase == null || passphrase.length() > 1024) throw new IllegalArgumentException("Invalid recovery phrase or passphrase");
        for (int i = 0; i < passphrase.length(); i++) {
            if (Character.isHighSurrogate(passphrase.charAt(i))) {
                if (++i >= passphrase.length() || !Character.isLowSurrogate(passphrase.charAt(i))) throw new IllegalArgumentException("Invalid passphrase encoding");
            } else if (Character.isLowSurrogate(passphrase.charAt(i))) throw new IllegalArgumentException("Invalid passphrase encoding");
        }
        byte[] password = phrase.getBytes(StandardCharsets.UTF_8);
        byte[] salt = ("mnemonic" + Normalizer.normalize(passphrase, Normalizer.Form.NFKD)).getBytes(StandardCharsets.UTF_8);
        byte[] u = null, out = null;
        try {
            u = hmac512(password, concat(salt, new byte[]{0, 0, 0, 1})); out = u.clone();
            for (int i = 1; i < 2048; i++) {
                byte[] next = hmac512(password, u); wipe(u); u = next;
                for (int j = 0; j < 64; j++) out[j] ^= u[j];
            }
            byte[] result = out; out = null; return result;
        } finally { wipe(password); wipe(salt); wipe(u); wipe(out); }
    }
    static byte[] hmac512(byte[] key, byte[] data) {
        try { Mac mac = Mac.getInstance("HmacSHA512"); mac.init(new SecretKeySpec(key, "HmacSHA512")); return mac.doFinal(data); }
        catch (Exception e) { throw new IllegalStateException("HMAC-SHA512 unavailable", e); }
    }
    static byte[] utf8(char[] chars) {
        if (chars == null) throw new IllegalArgumentException("Missing password");
        ByteBuffer encoded = StandardCharsets.UTF_8.encode(CharBuffer.wrap(chars));
        byte[] bytes = new byte[encoded.remaining()]; encoded.get(bytes);
        if (encoded.hasArray()) wipe(encoded.array());
        return bytes;
    }
}
