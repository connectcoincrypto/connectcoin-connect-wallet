package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public final class MobilePaymentCancellationTest {
    private static final String TXID = "ab".repeat(32), OTHER = "cd".repeat(32);
    private static final String OWN_INPUT = "01".repeat(32) + ":0", OTHER_INPUT = "02".repeat(32) + ":1";

    private static MobileRpcClient.RpcFailure failure(String code, boolean unknown) throws Exception {
        java.lang.reflect.Constructor<MobileRpcClient.RpcFailure> constructor = MobileRpcClient.RpcFailure.class.getDeclaredConstructor(String.class, boolean.class, Integer.class, long.class, boolean.class);
        constructor.setAccessible(true);
        return constructor.newInstance(code, unknown, null, 0L, false);
    }
    private static JSONObject signed() throws Exception {
        return new JSONObject().put("txid", TXID).put("hex", "synthetic-public-transaction")
            .put("broadcast_status", "pending").put("selected", new JSONObject().put("count", 1));
    }
    private static final class Store implements MobilePaymentCancellation.Store {
        final List<String> calls = new ArrayList<>();
        JSONObject held = new JSONObject().put(OWN_INPUT, TXID).put(OTHER_INPUT, OTHER), receipt;
        boolean failReceipt, failReservations;
        Store() throws Exception {}
        public JSONObject reservations() { calls.add("read"); return held; }
        public void receipt(JSONObject value) throws Exception {
            calls.add("receipt"); if (failReceipt) throw new IOException("Receipt fixture failure");
            receipt = new JSONObject(value.toString());
        }
        public void reservations(JSONObject value) throws Exception {
            calls.add("release"); if (failReservations) throw new IOException("Reservation fixture failure");
            held = new JSONObject(value.toString());
        }
    }

    @Test public void knownPreWriteCancellationPersistsReceiptBeforeReleasingOnlyItsReservations() throws Exception {
        Store store = new Store(); JSONObject signed = signed(), oldHeld = store.held;
        String original = signed.toString();
        assertTrue(MobilePaymentCancellation.recordIfUnsent(failure("RPC_CANCELLED", false), signed, new JSONObject(), store));
        assertEquals(List.of("read", "receipt", "release"), store.calls);
        assertEquals("not-sent", store.receipt.getString("broadcast_status"));
        assertEquals(TXID, store.receipt.getString("txid")); assertEquals("synthetic-public-transaction", store.receipt.getString("hex"));
        assertEquals(1, store.held.length()); assertFalse(store.held.has(OWN_INPUT)); assertEquals(OTHER, store.held.getString(OTHER_INPUT));
        assertEquals(original, signed.toString()); assertEquals(2, oldHeld.length());
        store.receipt.getJSONObject("selected").put("count", 999); assertEquals(1, signed.getJSONObject("selected").getInt("count"));
    }

    @Test public void unknownAfterWriteCancellationNeverReadsOrChangesStorage() throws Exception {
        Store store = new Store();
        assertFalse(MobilePaymentCancellation.recordIfUnsent(failure("RPC_CANCELLED", true), signed(), new JSONObject(), store));
        assertTrue(store.calls.isEmpty()); assertNull(store.receipt); assertEquals(2, store.held.length());
    }

    @Test public void otherErrorsNeverReleaseReservationsOrNeedStorageContext() throws Exception {
        for (Exception error : new Exception[]{failure("RPC_TIMEOUT", false), failure("RPC_UNAVAILABLE", false),
                failure("-32029", false), failure("-32020", false), new IOException("RPC_CANCELLED"), null}) {
            Store store = new Store();
            assertFalse(MobilePaymentCancellation.recordIfUnsent(error, signed(), new JSONObject(), store));
            assertTrue(store.calls.isEmpty()); assertNull(store.receipt); assertEquals(2, store.held.length());
            assertFalse(MobilePaymentCancellation.recordIfUnsent(error, null, null, null));
        }
    }

    @Test public void receiptWriteFailureNeverReleasesReservations() throws Exception {
        Store store = new Store(); store.failReceipt = true; JSONObject original = store.held;
        assertThrows(IOException.class, () -> MobilePaymentCancellation.recordIfUnsent(failure("RPC_CANCELLED", false), signed(), new JSONObject(), store));
        assertEquals(List.of("read", "receipt"), store.calls); assertSame(original, store.held);
        assertEquals(2, store.held.length()); assertNull(store.receipt);
    }

    @Test public void reservationWriteFailurePropagatesAfterTheDurableNotSentReceipt() throws Exception {
        Store store = new Store(); store.failReservations = true; JSONObject original = store.held;
        assertThrows(IOException.class, () -> MobilePaymentCancellation.recordIfUnsent(failure("RPC_CANCELLED", false), signed(), new JSONObject(), store));
        assertEquals(List.of("read", "receipt", "release"), store.calls);
        assertEquals("not-sent", store.receipt.getString("broadcast_status"));
        assertSame(original, store.held); assertEquals(2, store.held.length());
    }

    @Test public void invalidReservationDataCannotProduceAnyDurableWrite() throws Exception {
        Store store = new Store(); store.held.put("malformed", TXID);
        assertThrows(IllegalStateException.class, () -> MobilePaymentCancellation.recordIfUnsent(failure("RPC_CANCELLED", false), signed(), new JSONObject(), store));
        assertEquals(List.of("read"), store.calls); assertNull(store.receipt); assertEquals(3, store.held.length());
    }

    @Test public void cancelledReplacementRestoresTheExactEarlierReservationSnapshot() throws Exception {
        Store store = new Store(); String earlier = "ef".repeat(32), newInput = "03".repeat(32) + ":2";
        JSONObject previous = new JSONObject().put(OWN_INPUT, earlier).put(OTHER_INPUT, OTHER);
        String before = previous.toString(); store.held.put(newInput, TXID);
        assertTrue(MobilePaymentCancellation.recordIfUnsent(failure("RPC_CANCELLED", false), signed(), previous, store));
        assertEquals(List.of("read", "receipt", "release"), store.calls);
        assertEquals(earlier, store.held.getString(OWN_INPUT)); assertEquals(OTHER, store.held.getString(OTHER_INPUT));
        assertFalse(store.held.has(newInput)); assertEquals(2, store.held.length()); assertEquals(before, previous.toString());
        assertEquals("not-sent", store.receipt.getString("broadcast_status"));
    }
}
