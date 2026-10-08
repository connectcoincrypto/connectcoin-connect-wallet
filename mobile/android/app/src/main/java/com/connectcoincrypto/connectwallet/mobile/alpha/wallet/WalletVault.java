package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.generators.SCrypt;
import org.json.JSONObject;

/** Portable password envelope compatible with desktop v1. Storage and native UI are separate responsibilities. */
public final class WalletVault {
    private WalletVault() {}
    public static final int MAX_FILE_BYTES = 131072 + 4096;
    private static final int MAX_PLAINTEXT = 65536;
    static final long MIN_KDF_HEAP_BYTES = 256L * 1024 * 1024;
    private static final String FORMAT = "connectcoin-connect-wallet";
    private static final String KDF_JSON = "{\"name\":\"scrypt\",\"N\":131072,\"r\":8,\"p\":1,\"keyLength\":32}";

    public static JSONObject newPayload(String name, String mnemonic, String passphrase) {
        try {
            return validatePayload(new JSONObject().put("name", name == null ? "ConnectWallet" : name).put("mnemonic", mnemonic)
                .put("network", "main").put("passphrase", passphrase).put("receiveIndex", 0).put("changeIndex", 0)
                .put("lastUsedReceive", -1).put("lastUsedChange", -1).put("needsRecovery", false));
        } catch (org.json.JSONException e) { throw new IllegalArgumentException("Invalid wallet payload"); }
    }
    /** Only for native code. Contains recovery words; never return this through a plugin callback. */
    public static JSONObject validatePayload(JSONObject payload) {
        try {
            if (payload == null || !"main".equals(payload.opt("network")) || !(payload.opt("mnemonic") instanceof String)
                || !WalletCrypto.validateMnemonic(payload.getString("mnemonic"))) throw new IllegalArgumentException("Invalid mainnet wallet recovery data");
            if (payload.has("passphrase") && (!(payload.opt("passphrase") instanceof String) || payload.getString("passphrase").length() > 1024)) throw new IllegalArgumentException("Invalid BIP39 passphrase");
            if (payload.has("name") && (!(payload.opt("name") instanceof String) || payload.getString("name").length() > 200)) throw new IllegalArgumentException("Invalid wallet name");
            for (String field : new String[]{"receiveIndex", "changeIndex", "lastUsedReceive", "lastUsedChange"}) {
                if (payload.has(field)) {
                    Object value = payload.get(field);
                    if (!(value instanceof Integer || value instanceof Long) || ((Number) value).longValue() < (field.startsWith("lastUsed") ? -1 : 0) || ((Number) value).longValue() > Integer.MAX_VALUE) throw new IllegalArgumentException("Invalid wallet address index");
                }
            }
            for (String field : new String[]{"needsRecovery", "scanLookahead", "mobileHdRecovered"}) {
                if (payload.has(field) && !(payload.opt(field) instanceof Boolean)) throw new IllegalArgumentException("Invalid wallet recovery state");
            }
            String serialized = payload.toString();
            if (serialized == null || serialized.length() > MAX_PLAINTEXT || serialized.getBytes(StandardCharsets.UTF_8).length > MAX_PLAINTEXT) throw new IllegalArgumentException("Wallet data is too large");
            JSONObject copy = new JSONObject(serialized);
            copy.put("mnemonic", WalletCrypto.normalizeMnemonic(payload.getString("mnemonic")));
            if (!copy.has("passphrase")) copy.put("passphrase", "");
            return copy;
        } catch (org.json.JSONException e) { throw new IllegalArgumentException("Invalid wallet payload"); }
    }
    public static void validatePassword(char[] password) {
        if (password == null || password.length < 12 || password.length > 1024) throw new IllegalArgumentException("Use a wallet password of at least 12 characters (maximum 1,024 bytes)");
        for (int i = 0; i < password.length; i++) {
            if (Character.isHighSurrogate(password[i])) {
                if (++i >= password.length || !Character.isLowSurrogate(password[i])) throw new IllegalArgumentException("Invalid password encoding");
            } else if (Character.isLowSurrogate(password[i])) throw new IllegalArgumentException("Invalid password encoding");
        }
        byte[] bytes = WalletCrypto.utf8(password);
        try { if (bytes.length > 1024) throw new IllegalArgumentException("Password exceeds 1,024 bytes"); }
        finally { WalletCrypto.wipe(bytes); }
    }
    public static JSONObject encrypt(JSONObject payload, char[] password) {
        try (UpdateSession session = createForUpdate(payload, password)) { return session.envelope(); }
    }
    public static JSONObject decrypt(JSONObject envelope, char[] password) {
        try (UpdateSession session = openForUpdate(envelope, password)) { return session.payload(); }
    }
    /** Native-only unlocked state. It never retains the password and must be closed on lock. */
    public static final class UpdateSession implements AutoCloseable {
        @FunctionalInterface public interface Writer { void write(JSONObject envelope) throws Exception; }
        private byte[] key;
        private final String salt;
        private JSONObject payload, envelope;
        private boolean saving;
        private UpdateSession(byte[] key, String salt, JSONObject payload, JSONObject envelope) {
            this.key = key; this.salt = salt; this.payload = payload; this.envelope = envelope;
        }
        private void requireOpen() { if (key == null) throw new IllegalStateException("Wallet is locked"); }
        public synchronized JSONObject payload() { requireOpen(); return copy(payload); }
        public synchronized JSONObject envelope() { requireOpen(); return copy(envelope); }
        /** Publish metadata only after durable storage succeeds. A fresh nonce is generated for every attempt. */
        public void save(JSONObject next, Writer writer) throws Exception {
            JSONObject candidate = validatePayload(next); final byte[] localKey;
            synchronized (this) {
                requireOpen();
                if (saving) throw new IllegalStateException("A wallet update is already in progress");
                // Metadata updates must never silently turn an existing vault into a different wallet.
                for (String field : new String[]{"mnemonic", "passphrase", "network"}) {
                    if (!java.util.Objects.equals(payload.opt(field), candidate.opt(field))) throw new IllegalArgumentException("Wallet identity cannot change during an update");
                }
                saving = true; localKey = key.clone();
            }
            try {
                JSONObject encrypted = encryptWithKey(candidate, localKey, salt);
                synchronized (this) { requireOpen(); }
                writer.write(copy(encrypted));
                synchronized (this) { requireOpen(); payload = candidate; envelope = encrypted; }
            } finally {
                WalletCrypto.wipe(localKey);
                synchronized (this) { saving = false; }
            }
        }
        /** No disk/network wait on the UI lock path; an in-flight writer must also check its lifecycle fence. */
        @Override public synchronized void close() {
            WalletCrypto.wipe(key); key = null; payload = null; envelope = null;
        }
    }
    public static UpdateSession createForUpdate(JSONObject payload, char[] password) {
        validatePassword(password); JSONObject clean = validatePayload(payload);
        byte[] salt = new byte[32], key = null; WalletCrypto.RANDOM.nextBytes(salt);
        try {
            key = keyFor(password, salt);
            String saltHex = WalletCrypto.hex(salt);
            JSONObject envelope = encryptWithKey(clean, key, saltHex);
            UpdateSession result = new UpdateSession(key, saltHex, clean, envelope); key = null; return result;
        } finally { WalletCrypto.wipe(key); WalletCrypto.wipe(salt); }
    }
    public static UpdateSession openForUpdate(JSONObject envelope, char[] password) {
        byte[] key = null, plaintext = null, encrypted = null;
        try {
            validatePassword(password); envelope = copy(envelope); validateEnvelope(envelope);
            key = keyFor(password, WalletCrypto.fromHex(envelope.getString("salt")));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, WalletCrypto.fromHex(envelope.getString("nonce"))));
            cipher.updateAAD(header(envelope).getBytes(StandardCharsets.UTF_8));
            encrypted = WalletCrypto.concat(WalletCrypto.fromHex(envelope.getString("ciphertext")), WalletCrypto.fromHex(envelope.getString("tag")));
            plaintext = cipher.doFinal(encrypted);
            if (plaintext.length > MAX_PLAINTEXT) throw new IllegalArgumentException("Wallet data is too large");
            JSONObject clean = validatePayload(StrictWalletJson.object(strictUtf8(plaintext)));
            UpdateSession result = new UpdateSession(key, envelope.getString("salt"), clean, envelope); key = null; return result;
        } catch (KdfMemoryException e) { throw e; }
        catch (Exception e) { throw new IllegalArgumentException("Cannot unlock wallet: incorrect password or damaged wallet file"); }
        finally { WalletCrypto.wipe(key); WalletCrypto.wipe(plaintext); WalletCrypto.wipe(encrypted); }
    }
    private static JSONObject encryptWithKey(JSONObject payload, byte[] key, String salt) {
        byte[] plaintext = payload.toString().getBytes(StandardCharsets.UTF_8), nonce = new byte[12], encrypted = null;
        WalletCrypto.RANDOM.nextBytes(nonce);
        try {
            JSONObject envelope = new JSONObject().put("format", FORMAT).put("version", 1).put("kdf", new JSONObject(KDF_JSON))
                .put("cipher", "aes-256-gcm").put("salt", salt).put("nonce", WalletCrypto.hex(nonce));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(header(envelope).getBytes(StandardCharsets.UTF_8)); encrypted = cipher.doFinal(plaintext);
            envelope.put("ciphertext", WalletCrypto.hex(Arrays.copyOfRange(encrypted, 0, encrypted.length - 16)));
            envelope.put("tag", WalletCrypto.hex(Arrays.copyOfRange(encrypted, encrypted.length - 16, encrypted.length)));
            return envelope;
        } catch (Exception e) { throw new IllegalStateException("Cannot encrypt wallet", e); }
        finally { WalletCrypto.wipe(plaintext); WalletCrypto.wipe(nonce); WalletCrypto.wipe(encrypted); }
    }
    private static JSONObject copy(JSONObject value) {
        try { if (value == null) throw new IllegalArgumentException("Missing wallet data"); return new JSONObject(value.toString()); }
        catch (org.json.JSONException e) { throw new IllegalArgumentException("Invalid wallet data"); }
    }
    /** Use this instead of JSONObject.toString(): desktop authenticates the KDF object's key order. */
    public static String serialize(JSONObject envelope) {
        try {
            validateEnvelope(envelope);
            String h = header(envelope);
            return h.substring(0, h.length() - 1) + ",\"ciphertext\":\"" + envelope.getString("ciphertext") + "\",\"tag\":\"" + envelope.getString("tag") + "\"}";
        } catch (org.json.JSONException e) { throw new IllegalArgumentException("Invalid encrypted wallet format"); }
    }
    public static JSONObject parse(String json) {
        try {
            if (json == null || json.length() > MAX_FILE_BYTES || json.getBytes(StandardCharsets.UTF_8).length > MAX_FILE_BYTES) throw new IllegalArgumentException("Unsafe or oversized wallet file");
            JSONObject value = StrictWalletJson.object(json); validateEnvelope(value); return value;
        } catch (org.json.JSONException e) { throw new IllegalArgumentException("Invalid encrypted wallet format"); }
    }
    public static JSONObject parse(byte[] encoded) {
        if (encoded == null || encoded.length == 0 || encoded.length > MAX_FILE_BYTES) throw new IllegalArgumentException("Unsafe or oversized wallet file");
        return parse(strictUtf8(encoded));
    }
    private static String strictUtf8(byte[] encoded) {
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(encoded)).toString();
        } catch (java.nio.charset.CharacterCodingException invalid) { throw new IllegalArgumentException("Invalid wallet file encoding"); }
    }
    private static String header(JSONObject envelope) throws org.json.JSONException {
        return "{\"format\":\"" + FORMAT + "\",\"version\":1,\"kdf\":" + KDF_JSON
            + ",\"cipher\":\"aes-256-gcm\",\"salt\":\"" + envelope.getString("salt") + "\",\"nonce\":\"" + envelope.getString("nonce") + "\"}";
    }
    private static byte[] keyFor(char[] password, byte[] salt) {
        // All create/import/unlock paths keep the same desktop scrypt cost. A
        // large-heap request is not guaranteed to be honored by every device.
        requireKdfHeap(Runtime.getRuntime().maxMemory());
        byte[] bytes = WalletCrypto.utf8(password);
        try { return SCrypt.generate(bytes, salt, 131072, 8, 1, 32); }
        catch (OutOfMemoryError exhausted) {
            // Only recover the KDF allocation failure, never arbitrary VM errors.
            // The caller's finally blocks still wipe passwords and plaintext.
            throw new KdfMemoryException("Not enough memory for the desktop-compatible wallet KDF. Close other apps and retry; wallet data was not changed.");
        }
        finally { WalletCrypto.wipe(bytes); }
    }
    static void requireKdfHeap(long maximum) {
        if (maximum < MIN_KDF_HEAP_BYTES) throw new KdfMemoryException("This device provides less than 256 MiB of application heap. It cannot create or unlock the desktop-compatible wallet safely; wallet data was not changed.");
    }
    private static final class KdfMemoryException extends IllegalStateException {
        KdfMemoryException(String message) { super(message); }
    }
    private static void validateEnvelope(JSONObject value) throws org.json.JSONException {
        if (value == null || !FORMAT.equals(value.opt("format")) || !integer(value.opt("version"), 1) || !"aes-256-gcm".equals(value.opt("cipher"))) throw new IllegalArgumentException("Unsupported encrypted wallet format");
        JSONObject kdf = value.getJSONObject("kdf");
        Set<String> fields = new HashSet<>(); Iterator<String> keys = kdf.keys(); while (keys.hasNext()) fields.add(keys.next());
        if (!fields.equals(new HashSet<>(Arrays.asList("name", "N", "r", "p", "keyLength"))) || !"scrypt".equals(kdf.opt("name")) || !integer(kdf.opt("N"), 131072) || !integer(kdf.opt("r"), 8) || !integer(kdf.opt("p"), 1) || !integer(kdf.opt("keyLength"), 32)) throw new IllegalArgumentException("Unsupported wallet KDF");
        strictHex(value.opt("salt"), 64, 64); strictHex(value.opt("nonce"), 24, 24); strictHex(value.opt("tag"), 32, 32);
        strictHex(value.opt("ciphertext"), 2, MAX_PLAINTEXT * 2);
    }
    private static boolean integer(Object value, int expected) { return (value instanceof Integer || value instanceof Long) && ((Number) value).longValue() == expected; }
    private static void strictHex(Object value, int minimum, int maximum) {
        if (!(value instanceof String)) throw new IllegalArgumentException("Invalid encrypted wallet format");
        String text = (String) value;
        if (text.length() < minimum || text.length() > maximum || text.length() % 2 != 0 || !text.matches("[0-9a-f]+")) throw new IllegalArgumentException("Invalid encrypted wallet format");
    }
}
