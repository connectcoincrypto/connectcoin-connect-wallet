package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class MobilePaymentBatchTest {
    private static final String KEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", OTHER = "ee".repeat(32);
    private static final String ADDRESS = WalletCrypto.encodeAddress(WalletCrypto.fromHex(KEY));
    private static final MobilePaymentBatch.Check CHECK = () -> {};

    private static final class Fixture {
        final JSONArray signed = new JSONArray(), plans = new JSONArray();
        final JSONObject plan;
        Fixture(int count) throws Exception {
            for (int i = 0; i < count; i++) {
                String parent = String.format("%064x", i + 1);
                JSONObject input = new JSONObject().put("txid", parent).put("vout", 0).put("scriptSig", "")
                    .put("sequence", 0xffffffffL).put("witness", new JSONArray().put("00".repeat(64)));
                // Synthetic framed signatures suffice here: signing tests own
                // the cryptography; these tests exercise journaling and writes.
                JSONObject tx = new JSONObject().put("version", 2).put("locktime", 0).put("inputs", new JSONArray().put(input))
                    .put("outputs", new JSONArray().put(new JSONObject().put("type", 1).put("amount", "1000").put("publicKey", KEY)));
                signed.put(new JSONObject().put("hex", WalletCrypto.hex(NativeTransactions.serialize(tx, true)))
                    .put("txid", NativeTransactions.txid(tx)).put("fee", "10"));
                plans.put(new JSONObject().put("total", "1000").put("fee", "10")
                    .put("selected", new JSONArray().put(new JSONObject().put("txid", parent).put("vout", 0)
                        .put("amount", "1010").put("rawTransaction", "must-not-be-persisted").put("secret", "must-not-be-persisted"))));
            }
            plan = new JSONObject().put("plans", plans).put("requestedTotal", Integer.toString(count * 1000))
                .put("total", Integer.toString(count * 1000)).put("fee", Integer.toString(count * 10))
                .put("inputTotal", Integer.toString(count * 1010)).put("change", "0");
        }
        String txid(int part) throws Exception { return signed.getJSONObject(part).getString("txid"); }
        String outpoint(int part) { return String.format("%064x:0", part + 1); }
        JSONObject submit(Store store, Sender sender) throws Exception { return submit(store, sender, CHECK); }
        JSONObject submit(Store store, Sender sender, MobilePaymentBatch.Check check) throws Exception {
            return MobilePaymentBatch.submit(ADDRESS, ADDRESS, plan, signed, store, sender, check);
        }
    }
    private static final class Store implements MobilePaymentBatch.Store {
        final List<String> events = new ArrayList<>();
        final Set<Integer> failReceipts = new HashSet<>();
        JSONObject saved, held = new JSONObject();
        int receiptWrites, reservationWrites;
        int failReservations = -1, failReceiptsFrom = Integer.MAX_VALUE, crashAfterReservationWrite = -1;
        boolean commitThenFail;
        public JSONObject receipt() throws Exception { events.add("read-receipt"); return saved == null ? null : copy(saved); }
        public JSONObject reservations() throws Exception { events.add("read-reservations"); return copy(held); }
        public void receipt(JSONObject value) throws Exception {
            events.add("receipt"); receiptWrites++;
            boolean fail = failReceipts.contains(receiptWrites) || receiptWrites >= failReceiptsFrom;
            if (fail && !commitThenFail) throw new IOException("Receipt fixture failure");
            saved = copy(value);
            if (fail) throw new IOException("Receipt readback fixture failure");
        }
        public void reservations(JSONObject value) throws Exception {
            events.add("reservations"); reservationWrites++;
            if (reservationWrites == failReservations) throw new IOException("Reservation fixture failure");
            held = copy(value);
            if (reservationWrites == crashAfterReservationWrite) throw new Crash();
        }
    }
    private static final class NotWritten extends IOException {}
    private static final class Crash extends Error {}
    private static class Sender implements MobilePaymentBatch.Sender {
        final Fixture fixture; final Store store;
        int calls, failAt = -1; String failure = "unknown";
        Sender(Fixture fixture, Store store) { this.fixture = fixture; this.store = store; }
        public JSONObject broadcast(String hex) throws Exception {
            int index = calls++;
            store.events.add("send");
            assertNotNull(store.saved);
            assertEquals(fixture.signed.length(), store.saved.getJSONArray("transactions").length());
            assertEquals("check-required", part(store.saved, index).getString("status"));
            for (int i = 0; i < fixture.signed.length(); i++) {
                assertEquals(fixture.signed.getJSONObject(i).getString("hex"), part(store.saved, i).getString("hex"));
                assertEquals(fixture.txid(i), store.held.getString(fixture.outpoint(i)));
            }
            assertEquals(fixture.signed.getJSONObject(index).getString("hex"), hex);
            if (index == failAt) {
                if ("not-written".equals(failure)) throw new NotWritten();
                if ("wrong-txid".equals(failure)) return new JSONObject().put("txid", OTHER);
                if ("null".equals(failure)) return null;
                if ("crash".equals(failure)) throw new Crash();
                throw new IOException("Fixture unknown outcome");
            }
            return new JSONObject().put("txid", fixture.txid(index));
        }
        public boolean provenNotSent(Exception failure) { return failure instanceof NotWritten; }
    }
    private static JSONObject part(JSONObject receipt, int index) throws Exception { return receipt.getJSONArray("transactions").getJSONObject(index); }
    private static JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }
    private static void statuses(JSONObject receipt, String... expected) throws Exception {
        assertEquals(expected.length, receipt.getJSONArray("transactions").length());
        for (int i = 0; i < expected.length; i++) assertEquals(expected[i], part(receipt, i).getString("status"));
    }

    @Test public void allSignedBytesAndReservationsAreDurableBeforeAnyWriteAndPartsAreSequential() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        JSONObject summary = f.submit(store, sender);
        assertEquals("submitted", summary.getString("status")); assertEquals(3, sender.calls);
        assertEquals(3, summary.getInt("submittedCount")); statuses(store.saved, "submitted", "submitted", "submitted");
        assertEquals(List.of("read-receipt", "read-reservations", "receipt", "reservations", "receipt", "send", "receipt",
            "receipt", "send", "receipt", "receipt", "send", "receipt"), store.events);
        assertEquals("3000", summary.getString("total")); assertEquals("30", summary.getString("fee"));
        assertFalse(summary.toString().contains("hex")); assertFalse(summary.toString().contains("selected"));
        assertFalse(store.saved.toString().contains("must-not-be-persisted"));
        assertTrue(summary.getString("batchId").matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));
    }

    @Test public void unknownResponseStopsWithoutRetryAndReleasesOnlyUntouchedParts() throws Exception {
        for (String failure : new String[]{"unknown", "wrong-txid", "null"}) {
            Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
            sender.failAt = 1; sender.failure = failure;
            JSONObject summary = f.submit(store, sender);
            assertEquals("check-required", summary.getString("status")); assertEquals(2, sender.calls);
            assertEquals(1, summary.getInt("submittedCount")); statuses(store.saved, "submitted", "check-required", "not-sent");
            assertEquals(2, store.held.length()); assertFalse(store.held.has(f.outpoint(2)));
            assertEquals("3000", summary.getString("total")); assertEquals("30", summary.getString("fee"));
        }
    }

    @Test public void transportProvenNoWritePreservesUnrelatedReservationsAndStops() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        store.held.put("ff".repeat(32) + ":9", OTHER);
        sender.failAt = 1; sender.failure = "not-written";
        JSONObject summary = f.submit(store, sender);
        assertEquals("partial", summary.getString("status")); assertEquals(2, sender.calls);
        statuses(store.saved, "submitted", "not-sent", "not-sent");
        assertFalse(store.held.has(f.outpoint(1))); assertFalse(store.held.has(f.outpoint(2)));
        assertEquals(f.txid(0), store.held.getString(f.outpoint(0))); assertEquals(2, store.held.length());
        assertEquals(OTHER, store.held.getString("ff".repeat(32) + ":9"));
    }

    @Test public void reservationArrivingAfterReviewRejectsTheEntireBatchBeforeAnyDurableWrite() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        store.held.put(f.outpoint(1), OTHER).put("ff".repeat(32) + ":9", OTHER);
        String before = store.held.toString();
        assertThrows(IllegalArgumentException.class, () -> f.submit(store, sender));
        assertEquals(before, store.held.toString()); assertNull(store.saved);
        assertEquals(0, sender.calls); assertEquals(0, store.receiptWrites); assertEquals(0, store.reservationWrites);
    }

    @Test public void cancellationBeforeFirstSendReleasesEveryNewReservation() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store); int[] checks = {0};
        JSONObject summary = f.submit(store, sender, () -> { if (++checks[0] == 3) throw new IllegalStateException("Locked"); });
        assertEquals("not-sent", summary.getString("status")); assertEquals(0, sender.calls); assertEquals(0, store.held.length());
        statuses(store.saved, "not-sent", "not-sent", "not-sent"); assertNotNull(MobilePaymentBatch.pendingSummary(store.saved));
    }

    @Test public void cancellationBetweenPartsNeverErasesSubmittedReceipt() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store); int[] checks = {0};
        JSONObject summary = f.submit(store, sender, () -> { if (++checks[0] == 4) throw new IOException("Backgrounded"); });
        assertEquals("partial", summary.getString("status")); assertEquals(1, sender.calls); assertEquals(1, store.held.length());
        statuses(store.saved, "submitted", "not-sent", "not-sent");
    }

    @Test public void initialReceiptFailureOrReservationFailureCannotWriteToNetwork() throws Exception {
        for (boolean receiptFailure : new boolean[]{true, false}) {
            Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
            if (receiptFailure) store.failReceipts.add(1); else store.failReservations = 1;
            assertThrows(IOException.class, () -> f.submit(store, sender));
            assertEquals(0, sender.calls); assertEquals(0, store.held.length());
            if (!receiptFailure) statuses(store.saved, "not-sent", "not-sent", "not-sent");
        }
    }

    @Test public void failureSavingPrewriteMarkerStopsAndDurablyRestoresNotSent() throws Exception {
        for (boolean committed : new boolean[]{true, false}) {
            Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
            store.failReceipts.add(2); store.commitThenFail = committed;
            assertEquals("not-sent", f.submit(store, sender).getString("status"));
            assertEquals(0, sender.calls); assertEquals(0, store.held.length());
            statuses(store.saved, "not-sent", "not-sent", "not-sent");
        }
    }

    @Test public void failureSavingSubmittedOutcomeRemainsUnknownAndDoesNotSendNextPart() throws Exception {
        for (boolean committed : new boolean[]{true, false}) {
            Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
            store.failReceipts.add(3); store.commitThenFail = committed;
            assertEquals("check-required", f.submit(store, sender).getString("status"));
            assertEquals(1, sender.calls); assertEquals(1, store.held.length());
            statuses(store.saved, "check-required", "not-sent", "not-sent");
        }
    }

    @Test public void persistentlyFailedJournalNeverReleasesPotentiallyWrittenInputs() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        store.failReceiptsFrom = 3;
        assertEquals("check-required", f.submit(store, sender).getString("status"));
        assertEquals(1, sender.calls); assertEquals(3, store.held.length());
        statuses(store.saved, "check-required", "not-sent", "not-sent");
    }

    @Test public void noWriteProofRequiresDurableReceiptBeforeRelease() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        sender.failAt = 0; sender.failure = "not-written"; store.failReceiptsFrom = 3;
        assertEquals("check-required", f.submit(store, sender).getString("status"));
        assertEquals(1, sender.calls); assertEquals(3, store.held.length());
        statuses(store.saved, "check-required", "not-sent", "not-sent");
    }

    @Test public void failedReservationCleanupLeavesDurableNotSentReceiptAndConservativeHolds() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        sender.failAt = 0; sender.failure = "not-written"; store.failReservations = 2;
        assertEquals("not-sent", f.submit(store, sender).getString("status"));
        assertEquals(1, sender.calls); assertEquals(3, store.held.length()); statuses(store.saved, "not-sent", "not-sent", "not-sent");
    }

    @Test public void cleanupDoesNotOverwriteANewerReservationOwner() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store) {
            @Override public boolean provenNotSent(Exception failure) {
                try { store.held.put(fixture.outpoint(2), OTHER); } catch (Exception impossible) { throw new AssertionError(impossible); }
                return true;
            }
        };
        sender.failAt = 0; sender.failure = "unknown";
        assertEquals("not-sent", f.submit(store, sender).getString("status"));
        assertEquals(1, store.held.length()); assertEquals(OTHER, store.held.getString(f.outpoint(2)));
    }

    @Test public void crashRecoveryShowsUnknownAndCannotAutomaticallyResubmit() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        sender.failAt = 1; sender.failure = "crash";
        assertThrows(Crash.class, () -> f.submit(store, sender));
        JSONObject recovered = MobilePaymentBatch.read(new ByteArrayInputStream(store.saved.toString().getBytes(StandardCharsets.UTF_8)));
        assertEquals("check-required", MobilePaymentBatch.pendingSummary(recovered).getString("status"));
        statuses(recovered, "submitted", "check-required", "not-sent");
        assertThrows(IllegalArgumentException.class, () -> f.submit(store, sender)); assertEquals(2, sender.calls);
    }

    @Test public void crashAfterInitialReservationCanRecoverEveryDurablyUnsentInput() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        String unrelated = "ff".repeat(32) + ":9";
        store.held.put(unrelated, OTHER); store.crashAfterReservationWrite = 1;
        assertThrows(Crash.class, () -> f.submit(store, sender));
        assertEquals(0, sender.calls); assertEquals(4, store.held.length());
        JSONObject recovered = MobilePaymentBatch.read(new ByteArrayInputStream(store.saved.toString().getBytes(StandardCharsets.UTF_8)));
        String originalReceipt = recovered.toString(), originalHolds = store.held.toString();
        statuses(recovered, "not-sent", "not-sent", "not-sent");
        JSONObject reconciled = MobilePaymentBatch.reconcileNotSent(recovered, store.held);
        assertEquals(1, reconciled.length()); assertEquals(OTHER, reconciled.getString(unrelated));
        assertEquals(originalReceipt, recovered.toString()); assertEquals(originalHolds, store.held.toString());
        assertEquals(reconciled.toString(), MobilePaymentBatch.reconcileNotSent(recovered, reconciled).toString());
    }

    @Test public void midBatchCrashRecoveryReleasesOnlyUnsentTailAndPreservesReceiptAndGuard() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        sender.failAt = 1; sender.failure = "crash";
        assertThrows(Crash.class, () -> f.submit(store, sender));
        JSONObject recovered = MobilePaymentBatch.read(new ByteArrayInputStream(store.saved.toString().getBytes(StandardCharsets.UTF_8)));
        String original = recovered.toString();
        statuses(recovered, "submitted", "check-required", "not-sent");
        JSONObject reconciled = MobilePaymentBatch.reconcileNotSent(recovered, store.held);
        assertEquals(2, reconciled.length());
        assertEquals(f.txid(0), reconciled.getString(f.outpoint(0))); assertEquals(f.txid(1), reconciled.getString(f.outpoint(1)));
        assertFalse(reconciled.has(f.outpoint(2))); assertEquals(original, recovered.toString());
        store.held = reconciled;
        assertThrows(IllegalArgumentException.class, () -> f.submit(store, sender)); assertEquals(2, sender.calls);
    }

    @Test public void crashRecoveryPreservesNewOwnersAndUnexpectedEntriesEvenWithSameTransactionId() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
        store.crashAfterReservationWrite = 1;
        assertThrows(Crash.class, () -> f.submit(store, sender));
        String unexpected = "ff".repeat(32) + ":9";
        store.held.put(f.outpoint(1), OTHER).put(unexpected, f.txid(2));
        JSONObject reconciled = MobilePaymentBatch.reconcileNotSent(store.saved, store.held);
        assertEquals(2, reconciled.length()); assertEquals(OTHER, reconciled.getString(f.outpoint(1)));
        assertEquals(f.txid(2), reconciled.getString(unexpected));
        JSONObject corrupt = copy(store.saved); part(corrupt, 0).getJSONArray("selected").getJSONObject(0).put("vout", 9);
        String before = store.held.toString();
        assertThrows(IllegalArgumentException.class, () -> MobilePaymentBatch.reconcileNotSent(corrupt, store.held));
        assertEquals(before, store.held.toString());
    }

    @Test public void allUnacknowledgedOutcomesBlockNewBatchesAndDismissalPreservesData() throws Exception {
        for (String outcome : new String[]{"submitted", "not-written", "unknown"}) {
            Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
            if (!"submitted".equals(outcome)) { sender.failAt = 0; sender.failure = outcome; }
            f.submit(store, sender); int writes = store.receiptWrites, calls = sender.calls;
            assertThrows(IllegalArgumentException.class, () -> f.submit(store, sender));
            assertEquals(writes, store.receiptWrites); assertEquals(calls, sender.calls);
            String before = store.saved.toString(), reservations = store.held.toString();
            assertThrows(IllegalArgumentException.class, () -> MobilePaymentBatch.acknowledge(store.saved, "wrong-batch-id"));
            JSONObject acknowledged = MobilePaymentBatch.acknowledge(store.saved, store.saved.getString("batchId"));
            assertTrue(acknowledged.getBoolean("acknowledged")); assertFalse(store.saved.getBoolean("acknowledged"));
            assertNull(MobilePaymentBatch.pendingSummary(acknowledged));
            acknowledged.put("acknowledged", false); assertEquals(before, acknowledged.toString());
            assertEquals(reservations, store.held.toString());
        }
    }

    @Test public void invalidSignedBytesAmountsInputsAndRecipientAreRejectedBeforeStorageWrites() throws Exception {
        for (String tamper : new String[]{"txid", "amount", "fee", "selected", "address", "count", "total", "input-amount", "coordinated-fee", "requested"}) {
            Fixture f = new Fixture(3); Store store = new Store(); Sender sender = new Sender(f, store);
            if ("txid".equals(tamper)) f.signed.getJSONObject(0).put("txid", OTHER);
            if ("amount".equals(tamper)) f.plans.getJSONObject(0).put("total", "999");
            if ("fee".equals(tamper)) f.signed.getJSONObject(0).put("fee", "11");
            if ("selected".equals(tamper)) f.plans.getJSONObject(1).put("selected", f.plans.getJSONObject(0).getJSONArray("selected"));
            if ("count".equals(tamper)) f.signed.put(f.signed.getJSONObject(0));
            if ("total".equals(tamper)) f.plan.put("total", "3001");
            if ("input-amount".equals(tamper)) f.plans.getJSONObject(0).getJSONArray("selected").getJSONObject(0).put("amount", "1011");
            if ("coordinated-fee".equals(tamper)) { f.signed.getJSONObject(0).put("fee", "11"); f.plans.getJSONObject(0).put("fee", "11"); }
            if ("requested".equals(tamper)) f.plan.put("requestedTotal", "3001");
            String address = "address".equals(tamper) ? WalletCrypto.encodeAddress(WalletCrypto.fromHex("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5")) : ADDRESS;
            assertThrows(IllegalArgumentException.class, () -> MobilePaymentBatch.submit(ADDRESS, address, f.plan, f.signed, store, sender, CHECK));
            assertEquals(0, store.receiptWrites); assertEquals(0, store.reservationWrites); assertEquals(0, sender.calls);
        }
    }

    @Test public void aggregateFeeAboveOneCoinIsRejectedEvenWhenEachPartFeeIsAllowed() throws Exception {
        Fixture f = new Fixture(2); Store store = new Store(); Sender sender = new Sender(f, store);
        for (int i = 0; i < 2; i++) {
            String fee = Long.toString(NativeTransactions.COIN / 2 + i);
            f.signed.getJSONObject(i).put("fee", fee); f.plans.getJSONObject(i).put("fee", fee);
            f.plans.getJSONObject(i).getJSONArray("selected").getJSONObject(0).put("amount", Long.toString(NativeTransactions.COIN / 2 + i + 1000));
        }
        f.plan.put("fee", Long.toString(NativeTransactions.COIN + 1)).put("inputTotal", Long.toString(NativeTransactions.COIN + 2001));
        assertThrows(IllegalArgumentException.class, () -> f.submit(store, sender));
        assertEquals(0, store.receiptWrites); assertEquals(0, sender.calls);
    }

    @Test public void disjointInputRequirementRejectsEvenDifferentValidTransactionIdsSpendingTheSameCoin() throws Exception {
        Fixture f = new Fixture(2); Store store = new Store(); Sender sender = new Sender(f, store);
        JSONObject second = NativeTransactions.parse(f.signed.getJSONObject(1).getString("hex"));
        second.getJSONArray("inputs").getJSONObject(0).put("txid", String.format("%064x", 1));
        second.put("locktime", 1);
        f.signed.getJSONObject(1).put("hex", WalletCrypto.hex(NativeTransactions.serialize(second, true))).put("txid", NativeTransactions.txid(second));
        f.plans.getJSONObject(1).getJSONArray("selected").getJSONObject(0).put("txid", String.format("%064x", 1));
        assertNotEquals(f.txid(0), f.txid(1));
        assertThrows(IllegalArgumentException.class, () -> f.submit(store, sender));
        assertEquals(0, store.receiptWrites); assertEquals(0, sender.calls);
    }

    @Test public void receiptsRejectUnexpectedFieldsInvalidStatusesAndAggregateChanges() throws Exception {
        Fixture f = new Fixture(3); Store store = new Store(); f.submit(store, new Sender(f, store));
        for (String field : new String[]{"secret", "status", "aggregate", "wallet", "sequence"}) {
            JSONObject bad = copy(store.saved);
            if ("secret".equals(field)) bad.put("mnemonic", "not-allowed");
            if ("status".equals(field)) part(bad, 0).put("status", "failed");
            if ("aggregate".equals(field)) bad.put("fee", "31");
            if ("wallet".equals(field)) bad.put("walletId", "invalid");
            if ("sequence".equals(field)) part(bad, 0).put("status", "not-sent");
            assertThrows(IllegalArgumentException.class, () -> MobilePaymentBatch.summary(bad));
        }
    }

    @Test public void readerRejectsInvalidUtf8AndBoundsInputBeforeParsing() throws Exception {
        assertThrows(Exception.class, () -> MobilePaymentBatch.read(new ByteArrayInputStream(new byte[]{(byte) 0xc3, 0x28})));
        int[] consumed = {0};
        InputStream oversized = new InputStream() {
            @Override public int read() { consumed[0]++; return ' '; }
            @Override public int read(byte[] bytes, int offset, int length) {
                java.util.Arrays.fill(bytes, offset, offset + length, (byte) ' '); consumed[0] += length; return length;
            }
        };
        assertThrows(IllegalArgumentException.class, () -> MobilePaymentBatch.read(oversized));
        assertEquals(MobilePaymentBatch.MAX_BYTES + 1, consumed[0]);
    }

    @Test public void boundedThirtyTwoPartBatchCanSubmitAndThirtyThreeCannot() throws Exception {
        Fixture f = new Fixture(32); Store store = new Store(); Sender sender = new Sender(f, store);
        assertEquals(32, f.submit(store, sender).getInt("submittedCount")); assertEquals(32, sender.calls);
        Fixture tooMany = new Fixture(33); Store rejected = new Store(); Sender unused = new Sender(tooMany, rejected);
        assertThrows(IllegalArgumentException.class, () -> tooMany.submit(rejected, unused));
        assertEquals(0, rejected.receiptWrites); assertEquals(0, unused.calls);
    }
}
