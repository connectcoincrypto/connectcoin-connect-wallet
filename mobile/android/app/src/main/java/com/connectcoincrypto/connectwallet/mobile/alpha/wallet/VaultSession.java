package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONObject;

/** Process-local private BIP32 branches. Never expose this object or signing primitives to JavaScript. */
public final class VaultSession implements AutoCloseable {
    private Node[] branches;

    public VaultSession(String mnemonic, String passphrase) {
        byte[] seed = WalletCrypto.mnemonicToSeed(mnemonic, passphrase);
        Node node = null;
        try {
            byte[] material = WalletCrypto.hmac512("Bitcoin seed".getBytes(StandardCharsets.US_ASCII), seed);
            try { node = new Node(Arrays.copyOfRange(material, 0, 32), Arrays.copyOfRange(material, 32, 64)); }
            finally { WalletCrypto.wipe(material); }
            if (!WalletCrypto.SECP.secKeyVerify(node.key)) throw new IllegalArgumentException("Invalid BIP32 master key");
            for (long index : new long[]{0x8000002cL, 0x80000000L, 0x80000000L}) {
                Node next = node.child(index); node.close(); node = next;
            }
            branches = new Node[2]; branches[0] = node.child(0); branches[1] = node.child(1);
        } catch (RuntimeException e) { lock(); throw e; }
        finally { if (node != null) node.close(); WalletCrypto.wipe(seed); }
    }
    public synchronized JSONObject publicAccount(int index, int change) {
        requireIndex(index, change);
        try (Node child = branches[change].child(index)) {
            byte[] key = Arrays.copyOfRange(WalletCrypto.SECP.pubkeyCreate(child.key), 1, 33);
            try {
                return new JSONObject().put("publicKey", WalletCrypto.hex(key)).put("address", WalletCrypto.encodeAddress(key))
                    .put("path", "m/44'/0'/0'/" + change + "/" + index).put("network", "main").put("index", index).put("change", change);
            } catch (org.json.JSONException e) { throw new IllegalStateException("Cannot construct public account", e); }
        }
    }
    public synchronized byte[] signDigest(byte[] digest, int index, int change) {
        requireIndex(index, change);
        if (digest == null || digest.length != 32) throw new IllegalArgumentException("Expected a 32-byte signing digest");
        byte[] message = digest.clone(), aux = new byte[32]; WalletCrypto.RANDOM.nextBytes(aux);
        try (Node child = branches[change].child(index)) {
            byte[] signature = WalletCrypto.SECP.signSchnorr(message, child.key, aux);
            byte[] pub = Arrays.copyOfRange(WalletCrypto.SECP.pubkeyCreate(child.key), 1, 33);
            if (!WalletCrypto.verifySchnorr(signature, message, pub)) { WalletCrypto.wipe(signature); throw new IllegalStateException("Signature self-verification failed"); }
            return signature;
        } finally { WalletCrypto.wipe(message); WalletCrypto.wipe(aux); }
    }
    public synchronized boolean isLocked() { return branches == null; }
    public synchronized void lock() {
        if (branches != null) { for (Node node : branches) if (node != null) node.close(); branches = null; }
    }
    @Override public void close() { lock(); }
    private void requireIndex(int index, int change) {
        if (branches == null) throw new IllegalStateException("Wallet is locked");
        if (index < 0 || change != 0 && change != 1) throw new IllegalArgumentException("Invalid derivation index");
    }
    private static final class Node implements AutoCloseable {
        private final byte[] key, chain;
        Node(byte[] key, byte[] chain) { this.key = key; this.chain = chain; }
        Node child(long requested) {
            long maximum = requested >= 0x80000000L ? 0xffffffffL : 0x7fffffffL;
            for (long index = requested; index <= maximum; index++) {
                byte[] data = null, material = null, tweak = null, child = null;
                try {
                    byte[] prefix = index >= 0x80000000L ? WalletCrypto.concat(new byte[]{0}, key) : WalletCrypto.SECP.pubKeyCompress(WalletCrypto.SECP.pubkeyCreate(key));
                    try { data = WalletCrypto.concat(prefix, ByteBuffer.allocate(4).putInt((int) index).array()); }
                    finally { WalletCrypto.wipe(prefix); }
                    material = WalletCrypto.hmac512(chain, data); tweak = Arrays.copyOfRange(material, 0, 32);
                    // Addition/curve arithmetic is performed by Bitcoin Core's libsecp256k1 through ACINQ JNI.
                    try { child = WalletCrypto.SECP.privKeyTweakAdd(key, tweak); }
                    catch (fr.acinq.secp256k1.Secp256k1Exception invalidChild) { continue; }
                    if (!WalletCrypto.SECP.secKeyVerify(child)) continue;
                    Node result = new Node(child, Arrays.copyOfRange(material, 32, 64)); child = null; return result;
                } finally { WalletCrypto.wipe(data); WalletCrypto.wipe(material); WalletCrypto.wipe(tweak); WalletCrypto.wipe(child); }
            }
            throw new IllegalArgumentException("Cannot derive another BIP32 child at this index");
        }
        @Override public void close() { WalletCrypto.wipe(key); WalletCrypto.wipe(chain); }
    }
}
