package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentReservations;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** One durable public journal for an explicitly approved group of independent
 * payments. There is deliberately no resume/retry operation. The Android owner
 * serializes payment operations; each Store write must be atomic and durable. */
public final class MobilePaymentBatch {
    public static final int MAX_PARTS = 32, MAX_BYTES = 16 * 1024 * 1024;
    private static final String NOT_SENT = "not-sent", UNKNOWN = "check-required", SUBMITTED = "submitted";
    private static final Set<String> RECEIPT_KEYS = Set.of("version", "batch", "batchId", "walletId", "address",
        "requestedTotal", "total", "fee", "inputTotal", "change", "acknowledged", "transactions");
    private static final Set<String> PART_KEYS = Set.of("txid", "hex", "status", "amount", "fee", "selected");
    private static final Set<String> OUTPOINT_KEYS = Set.of("txid", "vout");

    public interface Store {
        /** Null means no saved journal; malformed/unreadable storage must throw. */
        JSONObject receipt() throws Exception;
        JSONObject reservations() throws Exception;
        void receipt(JSONObject value) throws Exception;
        void reservations(JSONObject value) throws Exception;
    }
    public interface Sender {
        JSONObject broadcast(String hex) throws Exception;
        /** True only when transport evidence proves no transaction bytes were
         * written. A server rejection or timeout alone is not this proof. */
        boolean provenNotSent(Exception error);
    }
    public interface Check { void check() throws Exception; }
    private MobilePaymentBatch() {}

    /** All signed transactions and all reservations are saved before the first
     * network write. Each part is then journaled as uncertain BEFORE sending. */
    public static JSONObject submit(String walletId, String address, JSONObject batchPlan, JSONArray signed,
            Store store, Sender sender, Check check) throws Exception {
        require(store != null && sender != null && check != null, "Missing batch payment context.");
        check.check();
        JSONObject oldReceipt = store.receipt();
        if (oldReceipt != null) {
            validate(oldReceipt);
            require(oldReceipt.getBoolean("acknowledged"), "Review and dismiss the earlier batch receipt before another payment.");
        }
        JSONObject receipt = create(walletId, address, batchPlan, signed);
        JSONObject previous = copy(store.reservations());
        NativePaymentReservations.validate(previous);
        JSONObject held = copy(previous);
        JSONArray parts = receipt.getJSONArray("transactions");
        for (int i = 0; i < parts.length(); i++) {
            JSONObject part = parts.getJSONObject(i);
            JSONArray selected = part.getJSONArray("selected");
            for (int j = 0; j < selected.length(); j++) {
                JSONObject input = selected.getJSONObject(j);
                require(!previous.has(input.getString("txid") + ":" + input.getLong("vout")),
                    "Batch funding was reserved by another payment. Review again.");
            }
            held = NativePaymentReservations.reserve(held, selected, part.getString("txid"));
        }
        check.check();
        store.receipt(copy(receipt));
        store.reservations(held);
        for (int i = 0; i < parts.length(); i++) {
            JSONObject part = parts.getJSONObject(i);
            try { check.check(); }
            catch (Exception cancelled) { return stop(receipt, previous, store, -1); }
            part.put("status", UNKNOWN);
            try { store.receipt(copy(receipt)); }
            catch (Exception storageFailure) {
                // The sender was never called. A successful cleanup can prove
                // this durably; otherwise keep the conservative journal state.
                part.put("status", NOT_SENT);
                return stop(receipt, previous, store, i);
            }
            try {
                JSONObject sent = sender.broadcast(part.getString("hex"));
                if (sent == null || !(sent.opt("txid") instanceof String)
                        || !part.getString("txid").equals(sent.getString("txid"))) {
                    return stop(receipt, previous, store, -1);
                }
            } catch (Exception failure) {
                boolean unsent;
                try { unsent = sender.provenNotSent(failure); }
                catch (RuntimeException invalidEvidence) { unsent = false; }
                if (unsent) part.put("status", NOT_SENT);
                return stop(receipt, previous, store, unsent ? i : -1);
            }
            part.put("status", SUBMITTED);
            try { store.receipt(copy(receipt)); }
            catch (Exception storageFailure) {
                // A response does not replace the durable receipt. Never send
                // the next part after failing to save this submitted outcome.
                part.put("status", UNKNOWN);
                return stop(receipt, previous, store, -1);
            }
        }
        return summary(receipt);
    }

    /** Persist proof of non-submission before releasing any associated input.
     * Cleanup is best effort: storage failure always leaves reservations held.
     * uncertainOnFailure names a part whose durable state may still be unknown. */
    private static JSONObject stop(JSONObject receipt, JSONObject previous, Store store, int uncertainOnFailure) throws Exception {
        try { store.receipt(copy(receipt)); }
        catch (Exception storageFailure) {
            if (uncertainOnFailure >= 0) receipt.getJSONArray("transactions").getJSONObject(uncertainOnFailure).put("status", UNKNOWN);
            return summary(receipt);
        }
        try {
            JSONObject held = copy(store.reservations());
            JSONArray parts = receipt.getJSONArray("transactions");
            for (int i = 0; i < parts.length(); i++) {
                JSONObject part = parts.getJSONObject(i);
                if (NOT_SENT.equals(part.getString("status"))) held = NativePaymentReservations.releaseNotSent(held, part.getString("txid"), previous);
            }
            store.reservations(held);
        } catch (Exception storageFailure) { /* Conservative reservations remain recoverable. */ }
        return summary(receipt);
    }

    private static JSONObject create(String walletId, String address, JSONObject plan, JSONArray signed) throws Exception {
        require(plan != null && signed != null, "Missing signed batch payment.");
        JSONArray plans = plan.getJSONArray("plans");
        require(plans.length() >= 2 && plans.length() <= MAX_PARTS && plans.length() == signed.length(), "Invalid batch transaction count.");
        JSONObject receipt = new JSONObject().put("version", 1).put("batch", true).put("batchId", UUID.randomUUID().toString())
            .put("walletId", walletId).put("address", address).put("acknowledged", false)
            .put("requestedTotal", string(plan, "requestedTotal")).put("total", string(plan, "total"))
            .put("fee", string(plan, "fee")).put("inputTotal", string(plan, "inputTotal")).put("change", string(plan, "change"));
        JSONArray parts = new JSONArray(); long inputTotal = 0;
        for (int i = 0; i < plans.length(); i++) {
            JSONObject partPlan = plans.getJSONObject(i), transaction = signed.getJSONObject(i);
            require(string(partPlan, "fee").equals(string(transaction, "fee")), "Signed batch fee differs from its approved plan.");
            JSONArray selected = partPlan.getJSONArray("selected"), outpoints = new JSONArray(); long partInput = 0;
            for (int j = 0; j < selected.length(); j++) {
                JSONObject row = selected.getJSONObject(j);
                partInput = add(partInput, money(row, "amount"));
                outpoints.put(new JSONObject().put("txid", string(row, "txid")).put("vout", integer(row, "vout")));
            }
            JSONObject tx = NativeTransactions.parse(string(transaction, "hex")); long outputTotal = 0;
            JSONArray outputs = tx.getJSONArray("outputs");
            for (int j = 0; j < outputs.length(); j++) outputTotal = add(outputTotal, money(outputs.getJSONObject(j), "amount"));
            require(partInput == add(outputTotal, money(partPlan, "fee")), "Batch fee differs from its approved funding inputs.");
            inputTotal = add(inputTotal, partInput);
            parts.put(new JSONObject().put("txid", string(transaction, "txid")).put("hex", string(transaction, "hex"))
                .put("status", NOT_SENT).put("amount", string(partPlan, "total")).put("fee", string(partPlan, "fee")).put("selected", outpoints));
        }
        require(inputTotal == money(plan, "inputTotal"), "Batch input total differs from its approved funding inputs.");
        receipt.put("transactions", parts);
        validate(receipt);
        return receipt;
    }

    public static JSONObject read(InputStream input) throws Exception {
        require(input != null, "Missing batch receipt input.");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (;;) {
            int count = input.read(buffer, 0, Math.min(buffer.length, MAX_BYTES - bytes.size() + 1));
            if (count < 0) break;
            if (count == 0) { int next = input.read(); if (next < 0) break; buffer[0] = (byte) next; count = 1; }
            require(count <= MAX_BYTES - bytes.size(), "Batch receipt exceeds its safe storage limit.");
            bytes.write(buffer, 0, count);
        }
        String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        JSONObject receipt = new JSONObject(text);
        validate(receipt);
        return receipt;
    }

    /** Strict public schema: neither caller metadata nor raw parent transactions
     * can accidentally become durable wallet data or bridge-visible values. */
    public static void validate(JSONObject receipt) throws Exception {
        keys(receipt, RECEIPT_KEYS);
        require(integer(receipt, "version") == 1 && Boolean.TRUE.equals(receipt.opt("batch"))
            && receipt.opt("acknowledged") instanceof Boolean, "Invalid batch receipt version.");
        require(string(receipt, "batchId").matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"), "Invalid batch receipt identifier.");
        address(string(receipt, "walletId")); address(string(receipt, "address"));
        long requested = money(receipt, "requestedTotal"), total = money(receipt, "total"), fee = money(receipt, "fee"), inputTotal = money(receipt, "inputTotal"), change = money(receipt, "change");
        require(requested > 0 && total > 0 && fee <= NativeTransactions.COIN && inputTotal == add(add(total, fee), change)
            && (requested == total || requested >= add(total, fee)), "Invalid batch receipt totals.");
        JSONArray parts = receipt.getJSONArray("transactions");
        require(parts.length() >= 2 && parts.length() <= MAX_PARTS, "Invalid batch receipt transaction count.");
        Set<String> txids = new HashSet<>(), inputs = new HashSet<>();
        long partTotal = 0, partFee = 0, partChange = 0; int inputCount = 0;
        String publicKey = WalletCrypto.hex(WalletCrypto.decodeAddress(receipt.getString("address")));
        boolean stopped = false;
        for (int i = 0; i < parts.length(); i++) {
            JSONObject part = parts.getJSONObject(i); keys(part, PART_KEYS);
            String txid = string(part, "txid"), hex = string(part, "hex"), status = string(part, "status");
            require(txid.matches("[0-9a-f]{64}") && txids.add(txid), "Invalid or duplicate batch transaction ID.");
            require(hex.length() > 0 && hex.length() <= 800000 && hex.length() % 2 == 0 && hex.matches("[0-9a-f]+"), "Invalid signed batch transaction bytes.");
            require(SUBMITTED.equals(status) || UNKNOWN.equals(status) || NOT_SENT.equals(status), "Invalid batch transaction status.");
            require(!stopped || NOT_SENT.equals(status), "Invalid batch submission order.");
            if (!SUBMITTED.equals(status)) stopped = true;
            JSONObject tx = NativeTransactions.parse(hex);
            require(txid.equals(NativeTransactions.txid(tx)), "Batch transaction ID does not match its signed bytes.");
            require(NativeTransactions.serialize(tx, false).length * 3L + hex.length() / 2L <= 400000, "Batch transaction exceeds standard weight.");
            JSONArray selected = part.getJSONArray("selected"), txInputs = tx.getJSONArray("inputs"), outputs = tx.getJSONArray("outputs");
            require(selected.length() > 0 && selected.length() <= NativeTransactions.MAX_PAYMENT_INPUTS && selected.length() == txInputs.length(), "Invalid batch payment inputs.");
            inputCount = Math.addExact(inputCount, selected.length());
            require(inputCount <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Batch inputs exceed the native wallet limit.");
            for (int j = 0; j < selected.length(); j++) {
                JSONObject row = selected.getJSONObject(j), txInput = txInputs.getJSONObject(j); keys(row, OUTPOINT_KEYS);
                String parent = string(row, "txid"); long vout = integer(row, "vout");
                require(parent.matches("[0-9a-f]{64}") && vout >= 0 && vout <= 0xffffffffL
                    && parent.equals(txInput.getString("txid")) && vout == txInput.getLong("vout")
                    && inputs.add(parent + ":" + vout), "Batch transactions must have disjoint approved inputs.");
                JSONArray witness = txInput.getJSONArray("witness");
                require(txInput.getString("scriptSig").isEmpty() && witness.length() == 1
                    && witness.getString(0).matches("[0-9a-f]{128}"), "Missing native payment signature.");
            }
            long amount = money(part, "amount"), cost = money(part, "fee");
            require(amount > 0 && cost <= NativeTransactions.COIN && outputs.length() >= 1 && outputs.length() <= 2,
                "Invalid batch payment amounts or outputs.");
            JSONObject recipient = outputs.getJSONObject(0);
            require(recipient.getInt("type") == 1 && publicKey.equals(recipient.getString("publicKey"))
                && amount == money(recipient, "amount"), "Batch recipient differs from its approved payment.");
            if (outputs.length() == 2) {
                require(outputs.getJSONObject(1).getInt("type") == 1, "Invalid batch change output.");
                partChange = add(partChange, money(outputs.getJSONObject(1), "amount"));
            }
            partTotal = add(partTotal, amount); partFee = add(partFee, cost);
        }
        for (String outpoint : inputs) require(!txids.contains(outpoint.substring(0, 64)), "Batch transactions cannot depend on each other.");
        require(partTotal == total && partFee == fee && partChange == change, "Batch receipt subtotals changed.");
        require(receipt.toString().getBytes(StandardCharsets.UTF_8).length <= MAX_BYTES, "Batch receipt exceeds its safe storage limit.");
    }

    /** Only this allowlisted summary crosses the JavaScript bridge. */
    public static JSONObject summary(JSONObject receipt) throws Exception {
        validate(receipt);
        JSONArray transactions = new JSONArray(), parts = receipt.getJSONArray("transactions");
        int submitted = 0; boolean unknown = false;
        for (int i = 0; i < parts.length(); i++) {
            JSONObject part = parts.getJSONObject(i); String status = part.getString("status");
            if (SUBMITTED.equals(status)) submitted++;
            if (UNKNOWN.equals(status)) unknown = true;
            transactions.put(new JSONObject().put("txid", part.getString("txid")).put("status", status)
                .put("amount", part.getString("amount")).put("fee", part.getString("fee")));
        }
        String status = unknown ? UNKNOWN : submitted == parts.length() ? SUBMITTED : submitted > 0 ? "partial" : NOT_SENT;
        return new JSONObject().put("batch", true).put("batchId", receipt.getString("batchId"))
            .put("walletId", receipt.getString("walletId")).put("address", receipt.getString("address"))
            .put("status", status).put("transactionCount", parts.length()).put("submittedCount", submitted)
            .put("transactions", transactions).put("requestedTotal", receipt.getString("requestedTotal"))
            .put("total", receipt.getString("total")).put("fee", receipt.getString("fee"));
    }

    public static JSONObject pendingSummary(JSONObject receipt) throws Exception {
        if (receipt == null) return null;
        validate(receipt);
        return receipt.getBoolean("acknowledged") ? null : summary(receipt);
    }

    /** Recover a crash between journaling and cleanup. The caller must exclude
     * every active payment submission while reading and committing this result.
     * Only a durable not-sent status proves no transaction bytes were written:
     * every possible write is preceded by a durable check-required marker.
     * Batch creation never replaces existing input reservations, so these exact
     * matching holds can be removed without restoring an earlier owner. */
    public static JSONObject reconcileNotSent(JSONObject receipt, JSONObject reservations) throws Exception {
        validate(receipt);
        NativePaymentReservations.validate(reservations);
        JSONObject held = copy(reservations);
        JSONArray parts = receipt.getJSONArray("transactions");
        for (int i = 0; i < parts.length(); i++) {
            JSONObject part = parts.getJSONObject(i);
            if (!NOT_SENT.equals(part.getString("status"))) continue;
            String txid = part.getString("txid"); JSONArray selected = part.getJSONArray("selected");
            for (int j = 0; j < selected.length(); j++) {
                JSONObject input = selected.getJSONObject(j);
                String outpoint = input.getString("txid") + ":" + input.getLong("vout");
                if (txid.equals(held.opt(outpoint))) held.remove(outpoint);
            }
        }
        return held;
    }

    /** Dismissal changes only visibility. It never removes signed bytes or
     * releases inputs belonging to submitted/uncertain transactions. */
    public static JSONObject acknowledge(JSONObject receipt, String batchId) throws Exception {
        validate(receipt);
        require(receipt.getString("batchId").equals(batchId), "The batch receipt changed. Review it again.");
        return copy(receipt).put("acknowledged", true);
    }

    private static void address(String value) throws Exception {
        require(value.length() > 0 && value.length() <= 128, "Invalid batch wallet or recipient address.");
        WalletCrypto.decodeAddress(value);
    }
    private static long money(JSONObject value, String name) throws Exception { return NativeTransactions.amount(string(value, name)); }
    private static long add(long a, long b) { return NativeTransactions.amount(Long.toString(Math.addExact(a, b))); }
    private static JSONObject copy(JSONObject value) throws Exception { require(value != null, "Missing payment storage data."); return new JSONObject(value.toString()); }
    private static String string(JSONObject value, String name) throws Exception {
        require(value.opt(name) instanceof String, "Invalid batch receipt text field."); return value.getString(name);
    }
    private static long integer(JSONObject value, String name) throws Exception {
        Object number = value.opt(name);
        require(number instanceof Integer || number instanceof Long, "Invalid batch receipt integer field."); return ((Number) number).longValue();
    }
    private static void keys(JSONObject value, Set<String> expected) {
        require(value != null && value.length() == expected.size(), "Invalid batch receipt fields.");
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) require(expected.contains(keys.next()), "Invalid batch receipt field.");
    }
    private static void require(boolean valid, String message) { if (!valid) throw new IllegalArgumentException(message); }
}
