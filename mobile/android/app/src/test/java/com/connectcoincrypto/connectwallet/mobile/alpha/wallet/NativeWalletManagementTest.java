package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;

import com.connectcoincrypto.connectwallet.mobile.alpha.NativeWalletManagement;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Public desktop fixtures only. Password rotation tests use the real desktop-cost KDF. */
public final class NativeWalletManagementTest {
    private static final String NEXT_PASSWORD = "New public fixture password! \u00e9 \ud83d\udd11";

    /** Public-fixture export for reciprocal verification by desktop decryptVault. */
    public static void main(String[] args) {
        byte[] encrypted = NativeWalletManagement.changePassword(fixture(), DesktopVectors.PASSWORD.toCharArray(),
            NEXT_PASSWORD.toCharArray(), NEXT_PASSWORD.toCharArray());
        System.out.println(new String(encrypted, StandardCharsets.UTF_8));
    }

    private static byte[] fixture() { return DesktopVectors.ENVELOPE.getBytes(StandardCharsets.UTF_8); }

    private static void assertWiped(char[]... passwords) {
        for (char[] password : passwords) {
            if (password != null) assertArrayEquals(new char[password.length], password);
        }
    }

    private static void assertJsonEquals(String path, Object expected, Object actual) throws Exception {
        if (expected instanceof JSONObject) {
            assertTrue(path + " must remain an object", actual instanceof JSONObject);
            JSONObject expectedObject = (JSONObject) expected, actualObject = (JSONObject) actual;
            Set<String> expectedKeys = new HashSet<>(), actualKeys = new HashSet<>();
            for (Iterator<String> keys = expectedObject.keys(); keys.hasNext();) expectedKeys.add(keys.next());
            for (Iterator<String> keys = actualObject.keys(); keys.hasNext();) actualKeys.add(keys.next());
            assertEquals(path + " must preserve every key", expectedKeys, actualKeys);
            for (String key : expectedKeys) assertJsonEquals(path + "." + key, expectedObject.get(key), actualObject.get(key));
        } else if (expected instanceof JSONArray) {
            assertTrue(path + " must remain an array", actual instanceof JSONArray);
            JSONArray expectedArray = (JSONArray) expected, actualArray = (JSONArray) actual;
            assertEquals(path + " must preserve array length", expectedArray.length(), actualArray.length());
            for (int index = 0; index < expectedArray.length(); index++) {
                assertJsonEquals(path + "[" + index + "]", expectedArray.get(index), actualArray.get(index));
            }
        } else {
            assertEquals(path + " must preserve its value", expected, actual);
        }
    }

    @Test public void rotatesAuthenticatedDesktopWalletAndPreservesEveryPayloadField() throws Exception {
        final JSONObject expected;
        final byte[] source;
        try (WalletVault.UpdateSession current = WalletVault.openForUpdate(WalletVault.parse(fixture()), DesktopVectors.PASSWORD.toCharArray())) {
            expected = current.payload().put("name", "Saved public fixture")
                .put("receiveIndex", Integer.MAX_VALUE).put("changeIndex", 27)
                .put("lastUsedReceive", 41).put("lastUsedChange", -1)
                .put("needsRecovery", true).put("scanLookahead", false).put("mobileHdRecovered", true)
                .put("futureMetadata", new JSONObject().put("unicode", "caf\u00e9 \ud83d\udd11")
                    .put("enabled", true).put("unset", JSONObject.NULL)
                    .put("paths", new JSONArray().put(3).put(new JSONObject().put("index", 9))));
            current.save(expected, envelope -> {});
            source = WalletVault.serialize(current.envelope()).getBytes(StandardCharsets.UTF_8);
        }
        byte[] unchanged = source.clone();
        char[] current = DesktopVectors.PASSWORD.toCharArray(), next = NEXT_PASSWORD.toCharArray(), confirmation = NEXT_PASSWORD.toCharArray();
        byte[] rotated = NativeWalletManagement.changePassword(source, current, next, confirmation);
        assertWiped(current, next, confirmation);
        assertArrayEquals(unchanged, source);
        assertNotSame(source, rotated);
        JSONObject before = WalletVault.parse(source), after = WalletVault.parse(rotated);
        assertNotEquals(before.getString("salt"), after.getString("salt"));
        assertNotEquals(before.getString("nonce"), after.getString("nonce"));
        assertNotEquals(before.getString("ciphertext"), after.getString("ciphertext"));
        JSONObject reopened = WalletVault.decrypt(after, NEXT_PASSWORD.toCharArray());
        assertJsonEquals("payload", expected, reopened);
        assertEquals(DesktopVectors.MNEMONIC, reopened.getString("mnemonic"));
        assertEquals("caf\u00e9 \ud83d\udd11", reopened.getString("passphrase"));
        assertEquals("main", reopened.getString("network"));
        assertThrows(IllegalArgumentException.class, () -> WalletVault.decrypt(after, DesktopVectors.PASSWORD.toCharArray()));
        String serialized = new String(rotated, StandardCharsets.UTF_8);
        assertEquals(serialized, WalletVault.serialize(after));
        assertTrue(serialized.contains("\"kdf\":{\"name\":\"scrypt\",\"N\":131072,\"r\":8,\"p\":1,\"keyLength\":32}"));
        assertFalse(serialized.contains("mnemonic"));
        assertFalse(serialized.contains("passphrase"));
        assertFalse(serialized.contains(DesktopVectors.MNEMONIC));
    }

    @Test public void wrongCurrentPasswordDoesNotReturnReplacementAndWipesEveryPassword() {
        byte[] source = fixture(), unchanged = source.clone();
        char[] current = "Wrong public fixture password!".toCharArray(), next = NEXT_PASSWORD.toCharArray(), confirmation = NEXT_PASSWORD.toCharArray();
        assertThrows(IllegalArgumentException.class, () -> NativeWalletManagement.changePassword(source, current, next, confirmation));
        assertArrayEquals(unchanged, source);
        assertWiped(current, next, confirmation);
    }

    @Test public void mismatchedConfirmationDoesNotChangeSourceAndWipesEveryPassword() {
        byte[] source = fixture(), unchanged = source.clone();
        char[] current = DesktopVectors.PASSWORD.toCharArray(), next = NEXT_PASSWORD.toCharArray(), confirmation = "Different public password!".toCharArray();
        assertThrows(IllegalArgumentException.class, () -> NativeWalletManagement.changePassword(source, current, next, confirmation));
        assertArrayEquals(unchanged, source);
        assertWiped(current, next, confirmation);
    }

    @Test public void invalidNewPasswordsFailWithoutChangingSourceAndWipeEveryPassword() {
        for (String invalid : new String[]{"short", "x".repeat(1025), "\ud83d\udd11".repeat(400), "Long invalid password \ud800"}) {
            byte[] source = fixture(), unchanged = source.clone();
            char[] current = DesktopVectors.PASSWORD.toCharArray(), next = invalid.toCharArray(), confirmation = invalid.toCharArray();
            assertThrows(IllegalArgumentException.class, () -> NativeWalletManagement.changePassword(source, current, next, confirmation));
            assertArrayEquals(unchanged, source);
            assertWiped(current, next, confirmation);
        }
    }

    @Test public void missingPasswordsStillWipeTheOtherArrays() {
        for (int missing = 0; missing < 3; missing++) {
            byte[] source = fixture(), unchanged = source.clone();
            char[] current = missing == 0 ? null : DesktopVectors.PASSWORD.toCharArray();
            char[] next = missing == 1 ? null : NEXT_PASSWORD.toCharArray();
            char[] confirmation = missing == 2 ? null : NEXT_PASSWORD.toCharArray();
            assertThrows(IllegalArgumentException.class, () -> NativeWalletManagement.changePassword(source, current, next, confirmation));
            assertArrayEquals(unchanged, source);
            assertWiped(current, next, confirmation);
        }
    }

    @Test public void invalidSnapshotStillWipesEveryPassword() {
        for (byte[] source : new byte[][]{null, new byte[0], "{} trailing".getBytes(StandardCharsets.UTF_8), new byte[]{(byte) 0xff}}) {
            byte[] unchanged = source == null ? null : source.clone();
            char[] current = DesktopVectors.PASSWORD.toCharArray(), next = NEXT_PASSWORD.toCharArray(), confirmation = NEXT_PASSWORD.toCharArray();
            assertThrows(IllegalArgumentException.class, () -> NativeWalletManagement.changePassword(source, current, next, confirmation));
            assertArrayEquals(unchanged, source);
            assertWiped(current, next, confirmation);
        }
    }

    @Test public void aliasedPasswordArraysAreWipedOnFailure() {
        char[] shared = DesktopVectors.PASSWORD.toCharArray(), confirmation = NEXT_PASSWORD.toCharArray();
        assertThrows(IllegalArgumentException.class, () -> NativeWalletManagement.changePassword(fixture(), shared, shared, confirmation));
        assertWiped(shared, confirmation);
    }

    private static byte[] replacement() throws Exception {
        // Structural encrypted fixture for storage tests; no KDF or real wallet files.
        return WalletVault.serialize(WalletVault.parse(fixture()).put("nonce", "00".repeat(12))).getBytes(StandardCharsets.UTF_8);
    }

    private static final class MemoryStore implements NativeWalletManagement.Store {
        byte[] saved;
        int reads, writes;
        boolean ignoreFirstWrite, corruptFirstWrite;
        final Set<Integer> failedReads = new HashSet<>(), failedWrites = new HashSet<>(), failedAfterWrites = new HashSet<>();
        final IOException writeFailure = new IOException("Synthetic atomic write failure");
        final IOException readFailure = new IOException("Synthetic readback failure");
        MemoryStore(byte[] saved) { this.saved = saved.clone(); }
        @Override public byte[] read() throws IOException {
            if (failedReads.contains(++reads)) throw readFailure;
            return saved.clone();
        }
        @Override public void write(byte[] encrypted) throws IOException {
            if (failedWrites.contains(++writes)) throw writeFailure;
            if (!(writes == 1 && ignoreFirstWrite)) {
                saved = writes == 1 && corruptFirstWrite ? new byte[]{0} : encrypted.clone();
            }
            if (failedAfterWrites.contains(writes)) throw writeFailure;
        }
    }

    @Test public void commitsOnlyAfterSourceAndLifecycleChecksThenVerifiesReadback() throws Exception {
        byte[] source = fixture(), next = replacement(), unchangedSource = source.clone(), unchangedNext = next.clone();
        MemoryStore store = new MemoryStore(source);
        AtomicInteger checks = new AtomicInteger();
        NativeWalletManagement.commitPasswordChange(source, next, store, () -> {
            assertEquals("No lifecycle cancellation may be checked after writing", 0, store.writes);
            checks.incrementAndGet();
        });
        assertArrayEquals(next, store.saved);
        assertArrayEquals(unchangedSource, source);
        assertArrayEquals(unchangedNext, next);
        assertEquals(2, checks.get());
        assertEquals(1, store.writes);
        assertEquals(2, store.reads);
    }

    @Test public void externallyChangedSourceIsNeverOverwrittenOrRestored() throws Exception {
        byte[] source = fixture(), external = replacement();
        MemoryStore store = new MemoryStore(external);
        assertThrows(IOException.class, () -> NativeWalletManagement.commitPasswordChange(source, replacement(), store, () -> {}));
        assertArrayEquals(external, store.saved);
        assertEquals(0, store.writes);
    }

    @Test public void preWriteCancellationOrUnreadableSourceNeverWrites() throws Exception {
        for (int cancelAt : new int[]{1, 2}) {
            MemoryStore store = new MemoryStore(fixture());
            AtomicInteger checks = new AtomicInteger();
            Exception cancellation = new Exception("Synthetic lifecycle cancellation");
            assertSame(cancellation, assertThrows(Exception.class, () -> NativeWalletManagement.commitPasswordChange(fixture(), replacement(), store, () -> {
                if (checks.incrementAndGet() == cancelAt) throw cancellation;
            })));
            assertEquals(0, store.writes);
            assertArrayEquals(fixture(), store.saved);
        }
        MemoryStore unreadable = new MemoryStore(fixture());
        unreadable.failedReads.add(1);
        assertSame(unreadable.readFailure, assertThrows(IOException.class,
            () -> NativeWalletManagement.commitPasswordChange(fixture(), replacement(), unreadable, () -> {})));
        assertEquals(0, unreadable.writes);
    }

    @Test public void failedWriteWithOriginalIntactDoesNotRewriteIt() throws Exception {
        MemoryStore store = new MemoryStore(fixture());
        store.failedWrites.add(1);
        assertSame(store.writeFailure, assertThrows(IOException.class,
            () -> NativeWalletManagement.commitPasswordChange(fixture(), replacement(), store, () -> {})));
        assertArrayEquals(fixture(), store.saved);
        assertEquals(1, store.writes);
    }

    @Test public void silentAtomicFinishFailureIsDetectedByReadback() throws Exception {
        MemoryStore store = new MemoryStore(fixture());
        store.ignoreFirstWrite = true;
        assertThrows(IOException.class, () -> NativeWalletManagement.commitPasswordChange(fixture(), replacement(), store, () -> {}));
        assertArrayEquals(fixture(), store.saved);
        assertEquals(1, store.writes);
    }

    @Test public void partialWriteIsRestoredAndOriginalFailureIsReported() throws Exception {
        MemoryStore store = new MemoryStore(fixture());
        store.corruptFirstWrite = true;
        store.failedAfterWrites.add(1);
        assertSame(store.writeFailure, assertThrows(IOException.class,
            () -> NativeWalletManagement.commitPasswordChange(fixture(), replacement(), store, () -> {})));
        assertArrayEquals(fixture(), store.saved);
        assertEquals(2, store.writes);
    }

    @Test public void readbackFailureRestoresAndVerifiesOriginalBeforeReportingFailure() throws Exception {
        MemoryStore store = new MemoryStore(fixture());
        store.failedReads.add(2);
        assertSame(store.readFailure, assertThrows(IOException.class,
            () -> NativeWalletManagement.commitPasswordChange(fixture(), replacement(), store, () -> {})));
        assertArrayEquals(fixture(), store.saved);
        assertEquals(2, store.writes);
        assertEquals(4, store.reads);
    }

    @Test public void restorationWriteExceptionCanStillBeVerifiedAsRestored() throws Exception {
        MemoryStore store = new MemoryStore(fixture());
        store.failedReads.add(2);
        store.failedAfterWrites.add(2);
        assertSame(store.readFailure, assertThrows(IOException.class,
            () -> NativeWalletManagement.commitPasswordChange(fixture(), replacement(), store, () -> {})));
        assertArrayEquals(fixture(), store.saved);
        assertEquals(2, store.writes);
    }

    @Test public void failedRestorationReportsUncertainStorage() throws Exception {
        MemoryStore store = new MemoryStore(fixture());
        store.failedReads.add(2);
        store.failedWrites.add(2);
        NativeWalletManagement.StorageUncertainException failure = assertThrows(NativeWalletManagement.StorageUncertainException.class,
            () -> NativeWalletManagement.commitPasswordChange(fixture(), replacement(), store, () -> {}));
        assertSame(store.readFailure, failure.getCause());
        assertEquals(1, failure.getSuppressed().length);
        assertArrayEquals(replacement(), store.saved);
        assertEquals(2, store.writes);
    }

    @Test public void unverifiedRestorationReportsUncertainStorageEvenWhenWriteReturned() throws Exception {
        MemoryStore store = new MemoryStore(fixture());
        store.failedReads.add(2);
        store.failedReads.add(4);
        assertThrows(NativeWalletManagement.StorageUncertainException.class,
            () -> NativeWalletManagement.commitPasswordChange(fixture(), replacement(), store, () -> {}));
        assertEquals(2, store.writes);
    }

    @Test public void invalidReplacementFailsBeforeStorageOrLifecycleCalls() {
        MemoryStore store = new MemoryStore(fixture());
        AtomicInteger checks = new AtomicInteger();
        assertThrows(IllegalArgumentException.class,
            () -> NativeWalletManagement.commitPasswordChange(fixture(), new byte[0], store, checks::incrementAndGet));
        assertEquals(0, checks.get());
        assertEquals(0, store.reads);
        assertEquals(0, store.writes);
    }
}
