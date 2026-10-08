package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ClaimsLimitsTest {
    private static JSONObject data(Object rate, Object concurrency) throws Exception {
        return new JSONObject().put("connectionsPerSecondLimit", rate).put("concurrency", concurrency);
    }
    @Test public void acceptsIndependentIntegerCeilingsAndBothBoundaries() throws Exception {
        for (int rate : new int[] { 1, 37, 100 }) for (int concurrency : new int[] { 1, 83, 100 }) {
            ClaimsLimits limits = ClaimsLimits.parse(data(rate, (long) concurrency));
            assertEquals(rate, limits.rate); assertEquals(concurrency, limits.concurrency);
        }
    }
    @Test public void rejectsWrongTypesAndOutOfRangeWithoutCoercion() throws Exception {
        for (Object value : new Object[] { JSONObject.NULL, true, "100", 1.0, 1.5, 0, -1, 101, Long.MAX_VALUE, new JSONArray(), new JSONObject() }) {
            JSONObject badRate = data(value, 100), badConcurrency = data(100, value);
            assertThrows(IllegalArgumentException.class, () -> ClaimsLimits.parse(badRate));
            assertThrows(IllegalArgumentException.class, () -> ClaimsLimits.parse(badConcurrency));
        }
    }
    @Test public void rejectsMissingOrExtraFields() throws Exception {
        for (JSONObject value : new JSONObject[] { null, new JSONObject(), new JSONObject().put("concurrency", 100),
                data(100, 100).put("allowMobileData", true), new JSONObject().put("rate", 100).put("concurrency", 100) }) {
            assertThrows(IllegalArgumentException.class, () -> ClaimsLimits.parse(value));
        }
    }
    @Test public void firstLaunchDefaultsTo100WithoutClaimStart() {
        ClaimsLimits limits = ClaimsLimits.restore(Map.of());
        assertEquals(100, limits.rate); assertEquals(100, limits.concurrency);
    }
    @Test public void reloadPreservesEachValidValueAndSafelyDefaultsMalformedStorage() {
        ClaimsLimits limits = ClaimsLimits.restore(Map.of("connectionsPerSecondLimit", 23, "concurrency", 17));
        assertEquals(23, limits.rate); assertEquals(17, limits.concurrency);
        for (Object value : new Object[] { true, "1", 1.0, 0, -1, 101, Long.MAX_VALUE }) {
            limits = ClaimsLimits.restore(Map.of("connectionsPerSecondLimit", value, "concurrency", 17));
            assertEquals(100, limits.rate); assertEquals(17, limits.concurrency);
            limits = ClaimsLimits.restore(Map.of("connectionsPerSecondLimit", 23, "concurrency", value));
            assertEquals(23, limits.rate); assertEquals(100, limits.concurrency);
        }
    }
}
