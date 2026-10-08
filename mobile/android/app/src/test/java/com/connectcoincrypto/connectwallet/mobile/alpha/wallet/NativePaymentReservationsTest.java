package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class NativePaymentReservationsTest {
    @Test public void aMaximumSweepAndEarlierReservationsSurviveRoundTrip() throws Exception {
        JSONObject original = new JSONObject().put("ab".repeat(32) + ":4294967295", "cd".repeat(32));
        JSONArray selected = new JSONArray();
        for (int i = 0; i < 1738; i++) selected.put(new JSONObject().put("txid", String.format("%064x", i)).put("vout", i));
        JSONObject held = NativePaymentReservations.reserve(original, selected, "ef".repeat(32));
        assertEquals(1739, held.length()); assertEquals(1, original.length());
        JSONObject restored = NativePaymentReservations.read(new ByteArrayInputStream(held.toString().getBytes(StandardCharsets.UTF_8)));
        assertEquals(held.toString(), restored.toString());
        assertEquals("cd".repeat(32), restored.getString("ab".repeat(32) + ":4294967295"));
    }
    @Test public void countAndByteLimitsAreCoherentAndDoNotEvictOldReservations() throws Exception {
        JSONObject original = new JSONObject();
        for (int i = 0; i < NativePaymentReservations.MAX_ENTRIES; i++) original.put(String.format("%064x", i) + ":4294967295", "ab".repeat(32));
        byte[] encoded = original.toString().getBytes(StandardCharsets.UTF_8);
        assertTrue(encoded.length < NativePaymentReservations.MAX_BYTES);
        assertEquals(original.length(), NativePaymentReservations.read(new ByteArrayInputStream(encoded)).length());
        JSONArray selected = new JSONArray().put(new JSONObject().put("txid", "ef".repeat(32)).put("vout", 0));
        assertThrows(IllegalStateException.class, () -> NativePaymentReservations.reserve(original, selected, "cd".repeat(32)));
        assertEquals(NativePaymentReservations.MAX_ENTRIES, original.length());
    }
    @Test public void corruptLegacyFilesFailClosed() throws Exception {
        for (String key : new String[]{"ab".repeat(32) + ":4294967296", "ab".repeat(32) + ":-1", "ab".repeat(32) + ":00", "nope"}) {
            JSONObject bad = new JSONObject().put(key, "ab".repeat(32));
            assertThrows(IllegalStateException.class, () -> NativePaymentReservations.read(new ByteArrayInputStream(bad.toString().getBytes(StandardCharsets.UTF_8))));
        }
        assertThrows(Exception.class, () -> NativePaymentReservations.read(new ByteArrayInputStream(new byte[]{(byte) 0xff})));
        assertThrows(IllegalStateException.class, () -> NativePaymentReservations.read(new ByteArrayInputStream(new byte[NativePaymentReservations.MAX_BYTES + 1])));
    }

    @Test public void releaseNotSentRemovesOnlyExactTransactionMatchesWithoutMutatingOriginal() throws Exception {
        String txid = "ab".repeat(32), other = "ab".repeat(31) + "ac";
        String first = "01".repeat(32) + ":0", second = "02".repeat(32) + ":4294967295", unrelated = txid + ":0";
        JSONObject original = new JSONObject().put(first, txid).put(second, txid).put(unrelated, other);
        String before = original.toString();
        JSONObject released = NativePaymentReservations.releaseNotSent(original, txid, new JSONObject());
        assertNotSame(original, released); assertEquals(1, released.length());
        assertFalse(released.has(first)); assertFalse(released.has(second)); assertEquals(other, released.getString(unrelated));
        assertEquals(before, original.toString());
        NativePaymentReservations.validate(released);
        released.put(unrelated, "cd".repeat(32)); assertEquals(other, original.getString(unrelated));
    }

    @Test public void releasingAbsentUnsentTransactionReturnsAnIndependentUnchangedSnapshot() throws Exception {
        String key = "01".repeat(32) + ":0";
        JSONObject original = new JSONObject().put(key, "ab".repeat(32));
        JSONObject released = NativePaymentReservations.releaseNotSent(original, "cd".repeat(32), new JSONObject());
        assertNotSame(original, released); assertEquals(original.toString(), released.toString());
        released.remove(key); assertTrue(original.has(key));
        assertEquals(0, NativePaymentReservations.releaseNotSent(new JSONObject(), "ab".repeat(32), new JSONObject()).length());
    }

    @Test public void releasingNotSentRejectsInvalidIdentifiersAndCorruptReservations() throws Exception {
        JSONObject original = new JSONObject().put("01".repeat(32) + ":0", "ab".repeat(32));
        String before = original.toString();
        for (String txid : new String[]{null, "", "ab".repeat(31), "AB".repeat(32), "g".repeat(64), " " + "ab".repeat(32)})
            assertThrows(IllegalArgumentException.class, () -> NativePaymentReservations.releaseNotSent(original, txid, new JSONObject()));
        assertEquals(before, original.toString());
        assertThrows(IllegalArgumentException.class, () -> NativePaymentReservations.releaseNotSent(null, "ab".repeat(32), new JSONObject()));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentReservations.releaseNotSent(original, "ab".repeat(32), null));
        for (JSONObject bad : new JSONObject[]{new JSONObject().put("invalid", "ab".repeat(32)),
                new JSONObject().put("01".repeat(32) + ":0", JSONObject.NULL),
                new JSONObject().put("01".repeat(32) + ":4294967296", "ab".repeat(32))}) {
            String unchanged = bad.toString();
            assertThrows(IllegalStateException.class, () -> NativePaymentReservations.releaseNotSent(bad, "ab".repeat(32), new JSONObject()));
            assertThrows(IllegalStateException.class, () -> NativePaymentReservations.releaseNotSent(original, "ab".repeat(32), bad));
            assertEquals(unchanged, bad.toString());
            assertEquals(before, original.toString());
        }
    }

    @Test public void releasingUnsentReplacementRestoresOlderUncertaintyWithoutClobberingNewOwners() throws Exception {
        String cancelled = "ab".repeat(32), older = "cd".repeat(32), newer = "ef".repeat(32);
        String replaced = "01".repeat(32) + ":0", fresh = "02".repeat(32) + ":0";
        String reassigned = "03".repeat(32) + ":0", removed = "04".repeat(32) + ":0";
        JSONObject previous = new JSONObject().put(replaced, older).put(reassigned, older).put(removed, older);
        JSONObject existing = new JSONObject().put(replaced, cancelled).put(fresh, cancelled).put(reassigned, newer);
        String originalPrevious = previous.toString(), originalExisting = existing.toString();
        JSONObject released = NativePaymentReservations.releaseNotSent(existing, cancelled, previous);
        assertEquals(2, released.length()); assertEquals(older, released.getString(replaced));
        assertFalse(released.has(fresh)); assertEquals(newer, released.getString(reassigned));
        assertFalse("Do not recreate an entry independently removed after the snapshot", released.has(removed));
        assertEquals(originalPrevious, previous.toString()); assertEquals(originalExisting, existing.toString());
        NativePaymentReservations.validate(released);
    }
}
