package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletVault;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import org.json.JSONObject;

/** Bounded encrypted backups. Decryption and recovery metadata remain native-only. */
public final class NativeWalletBackup {
    private NativeWalletBackup() {}

    /** Reads through EOF, keeping the stream open for its caller to close. */
    static byte[] read(InputStream input) throws IOException {
        if (input == null) throw new IOException("Cannot read encrypted wallet file.");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(8192);
        byte[] buffer = new byte[8192];
        while (true) {
            // At the limit, consume only one extra byte to distinguish EOF from oversize.
            int count = input.read(buffer, 0, Math.min(buffer.length, WalletVault.MAX_FILE_BYTES - bytes.size() + 1));
            if (count == -1) break;
            if (count == 0) {
                int next = input.read();
                if (next == -1) break;
                buffer[0] = (byte) next;
                count = 1;
            }
            if (count > WalletVault.MAX_FILE_BYTES - bytes.size()) {
                throw new IllegalArgumentException("Encrypted wallet file is too large.");
            }
            bytes.write(buffer, 0, count);
        }
        byte[] snapshot = bytes.toByteArray();
        validateSnapshot(snapshot);
        return snapshot;
    }

    /** The caller must close the output before opening the backup for readback. */
    static void write(byte[] snapshot, OutputStream output) throws IOException {
        validateSnapshot(snapshot);
        if (output == null) throw new IOException("Cannot write encrypted wallet backup.");
        output.write(snapshot);
        output.flush();
    }

    /** Also usable to confirm that the source wallet still matches its saved snapshot. */
    static void verify(byte[] expected, byte[] actual) throws IOException {
        validateSnapshot(expected);
        validateSnapshot(actual);
        if (!MessageDigest.isEqual(expected, actual)) {
            throw new IOException("Encrypted wallet bytes did not match the saved snapshot.");
        }
    }

    static void validateSnapshot(byte[] snapshot) {
        parseEnvelope(snapshot);
    }

    public static JSONObject parseEnvelope(byte[] snapshot) {
        if (snapshot == null || snapshot.length == 0 || snapshot.length > WalletVault.MAX_FILE_BYTES) {
            throw new IllegalArgumentException("Missing or oversized encrypted wallet file.");
        }
        return WalletVault.parse(snapshot);
    }

    /** Consumes and wipes the password. The caller must close the returned
     * session on cancellation or transfer it to the native unlocked wallet.
     * No source or destination file is changed by this method. */
    public static WalletVault.UpdateSession openForImport(byte[] snapshot, char[] password) throws Exception {
        WalletVault.UpdateSession session = null;
        try {
            session = WalletVault.openForUpdate(parseEnvelope(snapshot), password);
            JSONObject payload = session.payload().put("needsRecovery", true).put("mobileHdRecovered", false);
            // Preserve all saved paths, seed passphrase, name and compatible
            // metadata; only recovery readiness changes on the new device.
            session.save(payload, encrypted -> {});
            WalletVault.UpdateSession imported = session; session = null; return imported;
        } finally {
            if (session != null) session.close();
            if (password != null) Arrays.fill(password, '\0');
        }
    }
}
