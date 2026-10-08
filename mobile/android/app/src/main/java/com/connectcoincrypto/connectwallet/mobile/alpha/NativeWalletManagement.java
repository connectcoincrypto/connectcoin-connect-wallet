package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletVault;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Native-only wallet management. Callers own durable storage and lifecycle fencing. */
public final class NativeWalletManagement {
    private NativeWalletManagement() {}

    /** Callers serialize access and provide an atomic, durable write implementation. */
    public interface Store {
        byte[] read() throws Exception;
        void write(byte[] encrypted) throws Exception;
    }

    @FunctionalInterface public interface Check { void check() throws Exception; }

    /** Storage could not be verified after both the change and a restoration attempt. */
    public static final class StorageUncertainException extends Exception {
        private static final long serialVersionUID = 1L;
        private StorageUncertainException(Exception commitFailure, Exception restorationFailure) {
            super("Could not verify or restore the wallet file. Keep both passwords and the encrypted backup.", commitFailure);
            addSuppressed(restorationFailure);
        }
    }

    /**
     * Authenticates an encrypted snapshot and rotates its password without changing its payload.
     * Returns only a desktop-compatible encrypted envelope with a fresh salt and nonce.
     * Consumes and wipes every supplied password array, including on failure; does not mutate
     * the source snapshot or write any files. The caller must publish the result atomically.
     */
    public static byte[] changePassword(byte[] source, char[] currentPassword, char[] nextPassword,
            char[] confirmation) {
        try {
            WalletVault.validatePassword(nextPassword);
            if (!Arrays.equals(nextPassword, confirmation)) {
                throw new IllegalArgumentException("New wallet passwords do not match.");
            }
            try (WalletVault.UpdateSession current = WalletVault.openForUpdate(WalletVault.parse(source), currentPassword);
                    WalletVault.UpdateSession replacement = WalletVault.createForUpdate(current.payload(), nextPassword)) {
                return WalletVault.serialize(replacement.envelope()).getBytes(StandardCharsets.UTF_8);
            }
        } finally {
            if (currentPassword != null) Arrays.fill(currentPassword, '\0');
            if (nextPassword != null) Arrays.fill(nextPassword, '\0');
            if (confirmation != null) Arrays.fill(confirmation, '\0');
        }
    }

    /**
     * Commits a prepared password change while the caller holds its storage/lifecycle locks.
     * Source mismatch and cancellation before writing never cause a restoration write.
     * After writing, readback establishes the result without a later cancellation check.
     * A failed write/readback restores and verifies the exact original bytes before failing;
     * StorageUncertainException means neither a changed nor restored file could be confirmed.
     */
    public static void commitPasswordChange(byte[] source, byte[] replacement, Store store, Check check) throws Exception {
        NativeWalletBackup.validateSnapshot(source);
        NativeWalletBackup.validateSnapshot(replacement);
        if (store == null || check == null) throw new IllegalArgumentException("Missing wallet storage or lifecycle check.");
        byte[] original = source.clone(), candidate = replacement.clone();
        check.check();
        NativeWalletBackup.verify(original, store.read());
        check.check();
        try {
            store.write(candidate.clone());
            NativeWalletBackup.verify(candidate, store.read());
        } catch (Exception commitFailure) {
            try { restoreOriginal(original, store); }
            catch (Exception restorationFailure) {
                throw new StorageUncertainException(commitFailure, restorationFailure);
            }
            throw commitFailure;
        }
    }

    private static void restoreOriginal(byte[] original, Store store) throws Exception {
        try {
            NativeWalletBackup.verify(original, store.read());
            return;
        } catch (Exception unverified) {
            Exception writeFailure = null;
            try { store.write(original.clone()); }
            catch (Exception failure) { writeFailure = failure; }
            try {
                NativeWalletBackup.verify(original, store.read());
            } catch (Exception restorationFailure) {
                if (restorationFailure != unverified) restorationFailure.addSuppressed(unverified);
                if (writeFailure != null && restorationFailure != writeFailure && unverified != writeFailure) {
                    restorationFailure.addSuppressed(writeFailure);
                }
                throw restorationFailure;
            }
        }
    }
}
