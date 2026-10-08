package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletVault;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;

public final class NativeWalletBackupTest {
    // A structural envelope only: no password, recovery words, or KDF execution.
    private static final String ENVELOPE = "{\"format\":\"connectcoin-connect-wallet\",\"version\":1,"
        + "\"kdf\":{\"name\":\"scrypt\",\"N\":131072,\"r\":8,\"p\":1,\"keyLength\":32},"
        + "\"cipher\":\"aes-256-gcm\",\"salt\":\"" + "00".repeat(32) + "\","
        + "\"nonce\":\"" + "00".repeat(12) + "\",\"ciphertext\":\"00\","
        + "\"tag\":\"" + "00".repeat(16) + "\"}";

    private static byte[] fixture() { return ENVELOPE.getBytes(StandardCharsets.UTF_8); }

    @Test public void roundTripPreservesExactBytesAndCallerOwnsStreams() throws Exception {
        byte[] original = (" \n" + ENVELOPE + "\n").getBytes(StandardCharsets.UTF_8);
        final boolean[] closed = {false, false};
        ByteArrayInputStream source = new ByteArrayInputStream(original) {
            @Override public void close() { closed[0] = true; }
        };
        final boolean[] flushed = {false};
        ByteArrayOutputStream destination = new ByteArrayOutputStream() {
            @Override public void flush() { flushed[0] = true; }
            @Override public void close() { closed[1] = true; }
        };
        byte[] snapshot = NativeWalletBackup.read(source);
        NativeWalletBackup.write(snapshot, destination);
        assertTrue(flushed[0]);
        assertFalse(closed[0]);
        assertFalse(closed[1]);
        destination.close();
        byte[] readback = NativeWalletBackup.read(new ByteArrayInputStream(destination.toByteArray()));
        NativeWalletBackup.verify(snapshot, readback);
        assertArrayEquals(original, readback);
        original[0] = '\t';
        assertEquals(' ', snapshot[0]); // Source storage cannot mutate the snapshot.
        source.close();
        assertTrue(closed[0]);
        assertTrue(closed[1]);
    }

    @Test public void rejectsEmptyTruncatedAndInvalidEnvelopes() {
        for (byte[] invalid : new byte[][] {
                new byte[0], "{}".getBytes(StandardCharsets.UTF_8),
                Arrays.copyOf(fixture(), fixture().length - 1),
                ENVELOPE.replace("\"version\":1", "\"version\":2").getBytes(StandardCharsets.UTF_8),
                ENVELOPE.replace("\"N\":131072", "\"N\":2147483647").getBytes(StandardCharsets.UTF_8) }) {
            assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.read(new ByteArrayInputStream(invalid)));
        }
        assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.validateSnapshot(null));
    }

    @Test public void rejectsMalformedUtf8EvenInAnUnrecognizedField() {
        byte[] malformed = (ENVELOPE.substring(0, ENVELOPE.length() - 1) + ",\"extra\":\"x\"}")
            .getBytes(StandardCharsets.UTF_8);
        malformed[malformed.length - 3] = (byte) 0xff;
        assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.read(new ByteArrayInputStream(malformed)));
    }

    @Test public void rejectsDuplicateKeysTrailingGarbageAndLenientJsonBeforeAnyKdf() {
        for (String invalid : new String[]{
                ENVELOPE + "{}", ENVELOPE + " garbage", ENVELOPE + "\0", "\ufeff" + ENVELOPE,
                ENVELOPE.replace("\"version\":1", "\"version\":1,\"version\":1"),
                ENVELOPE.replace("\"N\":131072", "\"N\":131072,\"\\u004e\":131072"),
                ENVELOPE.replace("\"version\":1", "\"version\":01"),
                ENVELOPE.replace("\"version\":1", "version:1"),
                ENVELOPE.replace("\"cipher\":\"aes-256-gcm\"", "'cipher':'aes-256-gcm'"),
                ENVELOPE.replace("\"version\":1", "\"version\":/*comment*/1"),
                ENVELOPE.substring(0, ENVELOPE.length() - 1) + ",}",
                ENVELOPE.substring(0, ENVELOPE.length() - 1) + ",\"extra\":\"\\ud800\"}" }) {
            assertThrows(invalid, IllegalArgumentException.class, () -> NativeWalletBackup.parseEnvelope(invalid.getBytes(StandardCharsets.UTF_8)));
        }
    }

    @Test public void exactLimitIsAllowedButOneExtraByteIsRejected() throws Exception {
        byte[] maximum = Arrays.copyOf(fixture(), WalletVault.MAX_FILE_BYTES);
        Arrays.fill(maximum, fixture().length, maximum.length, (byte) ' ');
        assertArrayEquals(maximum, NativeWalletBackup.read(new ByteArrayInputStream(maximum)));
        byte[] oversized = Arrays.copyOf(maximum, maximum.length + 1);
        oversized[oversized.length - 1] = ' ';
        assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.read(new ByteArrayInputStream(oversized)));
        assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.validateSnapshot(oversized));
    }

    @Test public void oversizedStreamStopsAfterOneByteBeyondLimit() {
        final int[] consumed = {0};
        InputStream unbounded = new InputStream() {
            @Override public int read() { consumed[0]++; return ' '; }
            @Override public int read(byte[] bytes, int offset, int count) {
                consumed[0] += count;
                Arrays.fill(bytes, offset, offset + count, (byte) ' ');
                return count;
            }
        };
        assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.read(unbounded));
        assertEquals(WalletVault.MAX_FILE_BYTES + 1, consumed[0]);
    }

    @Test public void shortReadsAndZeroProgressStillReadThroughEof() throws Exception {
        ByteArrayInputStream fragmented = new ByteArrayInputStream(fixture()) {
            private boolean first = true;
            @Override public synchronized int read(byte[] bytes, int offset, int count) {
                if (first) { first = false; return 0; }
                return super.read(bytes, offset, Math.min(3, count));
            }
        };
        assertArrayEquals(fixture(), NativeWalletBackup.read(fragmented));
    }

    @Test public void readbackMustMatchBytesEvenWhenBothEnvelopesAreValid() {
        byte[] changedCiphertext = ENVELOPE.replace("\"ciphertext\":\"00\"", "\"ciphertext\":\"01\"")
            .getBytes(StandardCharsets.UTF_8);
        NativeWalletBackup.validateSnapshot(changedCiphertext);
        assertThrows(IOException.class, () -> NativeWalletBackup.verify(fixture(), changedCiphertext));
        byte[] extraWhitespace = (ENVELOPE + "\n").getBytes(StandardCharsets.UTF_8);
        assertThrows(IOException.class, () -> NativeWalletBackup.verify(fixture(), extraWhitespace));
        assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.verify(fixture(), new byte[0]));
    }

    @Test public void invalidSnapshotNeverTouchesDestination() {
        ByteArrayOutputStream destination = new ByteArrayOutputStream();
        assertThrows(IllegalArgumentException.class, () -> NativeWalletBackup.write(new byte[0], destination));
        assertEquals(0, destination.size());
    }

    @Test public void propagatesReadWriteAndFlushFailures() {
        IOException failure = new IOException("Storage unavailable");
        InputStream brokenInput = new InputStream() {
            @Override public int read() throws IOException { throw failure; }
        };
        OutputStream brokenOutput = new OutputStream() {
            @Override public void write(int value) throws IOException { throw failure; }
        };
        OutputStream brokenFlush = new ByteArrayOutputStream() {
            @Override public void flush() throws IOException { throw failure; }
        };
        assertSame(failure, assertThrows(IOException.class, () -> NativeWalletBackup.read(brokenInput)));
        assertSame(failure, assertThrows(IOException.class, () -> NativeWalletBackup.write(fixture(), brokenOutput)));
        assertSame(failure, assertThrows(IOException.class, () -> NativeWalletBackup.write(fixture(), brokenFlush)));
        assertThrows(IOException.class, () -> NativeWalletBackup.read(null));
        assertThrows(IOException.class, () -> NativeWalletBackup.write(fixture(), null));
    }
}
