package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.util.Map;
import org.json.JSONObject;

/** Strict native boundary for the two public, persisted workload ceilings. */
final class ClaimsLimits {
    final int rate, concurrency;

    private ClaimsLimits(int rate, int concurrency) { this.rate = rate; this.concurrency = concurrency; }

    static ClaimsLimits parse(JSONObject data) {
        if (data == null || data.length() != 2) throw new IllegalArgumentException("Invalid claims limits.");
        return new ClaimsLimits(integer(data.opt("connectionsPerSecondLimit"), MobileClaimsEngine.MAX_CONNECTIONS_PER_SECOND),
            integer(data.opt("concurrency"), MobileClaimsEngine.MAX_CONCURRENCY));
    }

    static ClaimsLimits restore(Map<String, ?> saved) {
        return new ClaimsLimits(savedInteger(saved.get("connectionsPerSecondLimit"), MobileClaimsEngine.MAX_CONNECTIONS_PER_SECOND,
                MobileClaimsEngine.DEFAULT_CONNECTIONS_PER_SECOND),
            savedInteger(saved.get("concurrency"), MobileClaimsEngine.MAX_CONCURRENCY, MobileClaimsEngine.DEFAULT_CONCURRENCY));
    }

    private static int savedInteger(Object value, int maximum, int fallback) {
        try { return integer(value, maximum); } catch (IllegalArgumentException invalid) { return fallback; }
    }

    private static int integer(Object value, int maximum) {
        if (!(value instanceof Integer || value instanceof Long) || ((Number) value).longValue() < 1 || ((Number) value).longValue() > maximum) {
            throw new IllegalArgumentException("Enter whole numbers from 1 to " + maximum + " for both limits.");
        }
        return ((Number) value).intValue();
    }
}
