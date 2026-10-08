package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import org.json.JSONArray;
import org.json.JSONObject;

/** Durable PUBLIC outpoint reservations, including payments with unknown outcomes.
 * Never discard older entries just to make room or because another wallet is open. */
public final class NativePaymentReservations {
    public static final int MAX_ENTRIES = 50000, MAX_BYTES = 8 * 1024 * 1024;
    private NativePaymentReservations() {}

    public static JSONObject read(InputStream input) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer, 0, Math.min(buffer.length, MAX_BYTES - bytes.size() + 1))) != -1) {
            if (count == 0) { int next = input.read(); if (next == -1) break; buffer[0] = (byte) next; count = 1; }
            if (count > MAX_BYTES - bytes.size()) throw new IllegalStateException("Payment reservations exceed the safe storage limit. Do not retry an uncertain payment.");
            bytes.write(buffer, 0, count);
        }
        String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        JSONObject held = new JSONObject(text);
        validate(held);
        return held;
    }

    public static void validate(JSONObject held) throws Exception {
        if (held.length() > MAX_ENTRIES) throw new IllegalStateException("Too many saved payment reservations. Check earlier transactions before continuing.");
        Iterator<String> keys = held.keys();
        while (keys.hasNext()) {
            String key = keys.next(); Object txid = held.get(key);
            if (!key.matches("[0-9a-f]{64}:(0|[1-9][0-9]{0,9})") || Long.parseLong(key.substring(65)) > 0xffffffffL
                || !(txid instanceof String) || !((String) txid).matches("[0-9a-f]{64}")) {
                throw new IllegalStateException("Invalid payment reservations. Do not retry an earlier payment blindly.");
            }
        }
    }

    public static JSONObject reserve(JSONObject existing, JSONArray selected, String txid) throws Exception {
        validate(existing);
        if (selected.length() == 0 || selected.length() > NativeTransactions.MAX_PAYMENT_INPUTS
            || txid == null || !txid.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid payment reservation.");
        JSONObject held = new JSONObject(existing.toString());
        for (int i = 0; i < selected.length(); i++) {
            JSONObject row = selected.getJSONObject(i);
            held.put(row.getString("txid") + ":" + row.getLong("vout"), txid);
        }
        validate(held);
        if (held.toString().getBytes(StandardCharsets.UTF_8).length > MAX_BYTES)
            throw new IllegalStateException("Payment reservations exceed the safe storage limit. Do not retry an uncertain payment.");
        return held;
    }

    /** Caller must first prove this transaction was never transmitted and pass
     * its exact pre-reservation snapshot. Preserve older uncertain payments
     * overwritten by an authorized replacement, and never touch a newer owner. */
    public static JSONObject releaseNotSent(JSONObject existing, String txid, JSONObject previous) throws Exception {
        if (existing == null || previous == null || txid == null || !txid.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid unsent payment reservation.");
        validate(existing); validate(previous);
        JSONObject held = new JSONObject(existing.toString());
        Iterator<String> keys = existing.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (txid.equals(existing.getString(key))) {
                if (previous.has(key)) held.put(key, previous.getString(key));
                else held.remove(key);
            }
        }
        return held;
    }
}
