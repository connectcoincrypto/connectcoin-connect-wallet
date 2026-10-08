package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Immutable address-only funding filter. It never accepts balances, outputs,
 * paths or keys from the renderer; account metadata must come from the vault. */
public final class NativeFundingScope {
    public static final int MAX_ADDRESSES = 10000;
    private final Set<String> addresses;
    private NativeFundingScope(Set<String> addresses) {
        this.addresses = Collections.unmodifiableSet(addresses);
    }
    public static NativeFundingScope optional(JSONObject input) throws Exception {
        if (!input.has("fundingAddresses")) return null;
        Object value = input.opt("fundingAddresses");
        if (!(value instanceof JSONArray)) throw new IllegalArgumentException("Invalid payment funding address scope.");
        JSONArray requested = (JSONArray)value;
        if (requested.length() < 1 || requested.length() > MAX_ADDRESSES) throw new IllegalArgumentException("Select between 1 and 10000 wallet funding addresses.");
        Set<String> addresses = new LinkedHashSet<>();
        for (int i = 0; i < requested.length(); i++) {
            Object row = requested.opt(i);
            if (!(row instanceof String)) throw new IllegalArgumentException("Invalid payment funding address.");
            String address = (String)row;
            // Exact native membership below authenticates the address. Avoid
            // repeating thousands of elliptic-curve checks on the UI thread.
            if (address.length() != 62 || !address.matches("cc1p[023456789acdefghjklmnpqrstuvwxyz]{58}") || !addresses.add(address)) {
                throw new IllegalArgumentException("Duplicate or noncanonical payment funding address.");
            }
        }
        return new NativeFundingScope(addresses);
    }
    /** Return copies in native order, never renderer-supplied account records. */
    public JSONArray select(JSONArray nativeAccounts) throws Exception {
        if (nativeAccounts == null || nativeAccounts.length() < 1 || nativeAccounts.length() > MAX_ADDRESSES) {
            throw new IllegalStateException("Invalid native wallet address set.");
        }
        Set<String> remaining = new HashSet<>(addresses);
        Set<String> seen = new HashSet<>(); JSONArray selected = new JSONArray();
        for (int i = 0; i < nativeAccounts.length(); i++) {
            JSONObject account = nativeAccounts.getJSONObject(i);
            String address = account.getString("address");
            if (!seen.add(address)) throw new IllegalStateException("Duplicate native wallet address.");
            if (remaining.remove(address)) selected.put(new JSONObject(account.toString()));
        }
        if (!remaining.isEmpty()) throw new IllegalArgumentException("Payment funding address is outside the current native wallet.");
        return selected;
    }
}
