package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.util.LinkedHashMap;
import java.util.Map;

/** Immutable, verified public parent transactions; bounded by size AND count.
 * The engine calls putValidated only after NativeTransactions.prepare succeeds.
 * All access is under the engine lifecycle lock.
 */
final class MobileClaimParentCache {
    private final int maxEntries, maxCharacters;
    private final Map<String, String> entries = new LinkedHashMap<>();
    private int characters;
    MobileClaimParentCache(int maxEntries, int maxCharacters) {
        if (maxEntries < 1 || maxCharacters < 1) throw new IllegalArgumentException("Invalid parent cache limits");
        this.maxEntries = maxEntries; this.maxCharacters = maxCharacters;
    }
    String get(String txid) { return entries.get(txid); }
    void putValidated(String txid, String hex) {
        if (hex.length() > maxCharacters) return;
        String previous = entries.remove(txid); if (previous != null) characters -= previous.length();
        while (!entries.isEmpty() && (entries.size() >= maxEntries || characters > maxCharacters - hex.length())) {
            String first = entries.keySet().iterator().next(); characters -= entries.remove(first).length();
        }
        entries.put(txid, hex); characters += hex.length();
    }
    int size() { return entries.size(); }
    int characters() { return characters; }
}
