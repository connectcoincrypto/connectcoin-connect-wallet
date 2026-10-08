package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentChecks;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class MobilePaymentFundingTest {
    // Public synthetic vector already used by wallet/TransactionVectors.java.
    private static final String KEY = "aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e";
    private static final String BASE = "02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff020101ffffffff0100e876481700000001aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e00000000";
    private static final MobilePaymentFunding.Check ACTIVE = () -> {};
    private static final MobilePaymentFunding.Progress QUIET = (stage, completed, total, retry) -> {};
    private static final class Time implements MobilePaymentFunding.Clock, MobilePaymentFunding.Sleeper {
        long now, longestSleep;
        @Override public long now() { return now; }
        @Override public void sleep(long milliseconds) { now += milliseconds; longestSleep = Math.max(longestSleep, milliseconds); }
    }
    private static JSONObject tip() throws Exception {
        return new JSONObject().put("chain", "main").put("genesis_hash", NativePaymentChecks.GENESIS).put("height", 121).put("hash", "ab".repeat(32)).put("mediantime", 1700000001);
    }
    private static MobileRpcClient.RpcFailure failure(String code, long delay) throws Exception {
        JSONObject error = new JSONObject().put("code", Integer.parseInt(code)).put("message", "Synthetic public fixture").put("data", new JSONObject().put("retry_after_ms", delay));
        try { MobileRpcClient.reply(new JSONObject().put("jsonrpc", "2.0").put("id", "test").put("error", error), "test"); throw new AssertionError("Expected fixture RPC failure"); }
        catch (MobileRpcClient.RpcFailure result) { return result; }
    }
    private static final class Parents implements MobilePaymentFunding.Reader {
        final Map<String, String> compact = new LinkedHashMap<>();
        final JSONArray selected = new JSONArray();
        final List<JSONArray> requests = new ArrayList<>();
        final int prefix, proofBytes;
        int calls;
        Parents(int count, int outputs, int prefix, int proofBytes) throws Exception {
            this.prefix = prefix; this.proofBytes = proofBytes;
            for (int index = 0; index < count; index++) {
                JSONObject transaction = NativeTransactions.parse(BASE).put("locktime", index);
                JSONObject output = transaction.getJSONArray("outputs").getJSONObject(0); JSONArray destinations = new JSONArray();
                for (int vout = 0; vout < outputs; vout++) destinations.put(new JSONObject(output.toString()));
                transaction.put("outputs", destinations); String id = NativeTransactions.txid(transaction);
                compact.put(id, WalletCrypto.hex(NativeTransactions.serialize(transaction, false)));
                for (int vout = 0; vout < outputs; vout++) selected.put(new JSONObject().put("txid", id).put("vout", vout).put("amount", output.getString("amount")).put("index", 0).put("change", 0));
            }
        }
        @Override public JSONObject read(String method, JSONObject params) throws Exception {
            assertEquals("gettransactions", method); calls++; JSONArray ids = params.getJSONArray("txids");
            assertTrue(ids.length() <= 32); requests.add(new JSONArray(ids.toString()));
            JSONArray transactions = new JSONArray(), remaining = new JSONArray();
            for (int i = 0; i < ids.length(); i++) {
                String id = ids.getString(i); assertTrue(compact.containsKey(id));
                if (i >= prefix) { remaining.put(id); continue; }
                String raw = compact.get(id);
                if (proofBytes > 0) {
                    JSONObject transaction = NativeTransactions.parse(raw);
                    transaction.getJSONArray("inputs").getJSONObject(0).put("witness", new JSONArray().put("02" + "00".repeat(proofBytes - 1)));
                    raw = WalletCrypto.hex(NativeTransactions.serialize(transaction, true));
                }
                transactions.put(new JSONObject().put("txid", id).put("hex", raw));
            }
            return new JSONObject().put("tip", tip()).put("transactions", transactions).put("remaining", remaining);
        }
    }
    private MobilePaymentFunding helper(Time time) { return new MobilePaymentFunding(8192, 16 * 1024 * 1024, time, time); }

    @Test public void sharedPreparationBudgetIsAvailableInsidePendingQuotaReads() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); AtomicInteger checks = new AtomicInteger();
        MobilePaymentFunding.Reader reader = new MobilePaymentFunding.Reader() {
            @Override public JSONObject read(String method, JSONObject params) { throw new AssertionError("Missing shared cancellation check"); }
            @Override public JSONObject read(String method, JSONObject params, MobilePaymentFunding.Check check) throws Exception {
                check.check(); checks.incrementAndGet();
                time.now += MobilePaymentFunding.MAX_PREPARATION_MS;
                check.check(); throw new AssertionError("Expired preparation continued waiting");
            }
        };
        MobilePaymentFunding.Session session = funding.session(reader, ACTIVE, QUIET);
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
            () -> session.read("getchaintip", new JSONObject(), "checking", 0, 1));
        assertTrue(failure.getMessage().contains("timed out")); assertEquals(1, checks.get());
    }

    @Test public void eightBatchesSurviveSixPerMinuteQuotaAndReuseOnlyVerifiedParents() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); Parents data = new Parents(225, 1, 32, 0);
        AtomicInteger attempts = new AtomicInteger(), minuteCalls = new AtomicInteger(); long[] minute = {-1}; List<Long> waits = new ArrayList<>();
        MobilePaymentFunding.Reader reader = (method, params) -> {
            attempts.incrementAndGet(); long current = time.now / 60000;
            if (minute[0] != current) { minute[0] = current; minuteCalls.set(0); }
            if (minuteCalls.getAndIncrement() >= 6) throw failure("-32029", 0);
            return data.read(method, params);
        };
        JSONArray loaded = funding.load(data.selected, KEY, reader, ACTIVE, (stage, completed, total, retry) -> { if (stage.equals("waiting")) waits.add(retry); });
        assertEquals(225, loaded.length()); assertEquals(8, data.calls); assertEquals(9, attempts.get()); assertEquals(60000, time.now); assertEquals(100, time.longestSleep);
        assertEquals(Long.valueOf(60000), waits.get(0)); assertFalse(data.selected.getJSONObject(0).has("rawTransaction"));
        funding.load(data.selected, KEY, reader, ACTIVE, QUIET); assertEquals(9, attempts.get()); assertEquals(225, funding.cachedCount());
    }
    @Test public void compactPrefixResponsesContinueWithoutRepeatingCompletedParents() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); Parents data = new Parents(70, 1, 3, 0);
        assertEquals(70, funding.load(data.selected, KEY, data, ACTIVE, QUIET).length()); assertEquals(24, data.calls);
        List<String> ids = new ArrayList<>(data.compact.keySet());
        for (int batch = 0; batch < data.requests.size(); batch++) assertEquals(ids.get(batch * 3), data.requests.get(batch).getString(0));
    }
    @Test public void sharedParentsStillAuthenticateEveryOutputAndCachedMetadataIsNeverTrusted() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); Parents data = new Parents(2, 6, 32, 0);
        JSONArray loaded = funding.load(data.selected, KEY, data, ACTIVE, QUIET); assertEquals(12, loaded.length()); assertEquals(2, data.requests.get(0).length());
        assertSame(loaded.getJSONObject(0).getString("rawTransaction"), loaded.getJSONObject(5).getString("rawTransaction"));
        for (String field : new String[]{"amount", "vout"}) {
            JSONArray changed = new JSONArray(data.selected.toString()); changed.getJSONObject(5).put(field, field.equals("amount") ? "1" : 99);
            assertThrows(IllegalArgumentException.class, () -> funding.load(changed, KEY, data, ACTIVE, QUIET));
        }
        JSONArray forged = new JSONArray(data.selected.toString()); forged.getJSONObject(5).put("txid", "00".repeat(32));
        assertThrows(IllegalArgumentException.class, () -> funding.load(forged, KEY, (method, params) -> new JSONObject().put("tip", tip())
            .put("transactions", new JSONArray().put(new JSONObject().put("txid", "00".repeat(32)).put("hex", BASE))).put("remaining", new JSONArray()), ACTIVE, QUIET));
        assertEquals(2, funding.cachedCount()); assertEquals(1, data.calls);
        assertThrows(IllegalArgumentException.class, () -> funding.load(data.selected, "dfcaec532010d704860e20ad6aff8cf3477164ffb02f93d45c552dadc70ed24f1", data, ACTIVE, QUIET));
        JSONArray stringIndex = new JSONArray(data.selected.toString()); stringIndex.getJSONObject(0).put("vout", "0");
        assertThrows(IllegalArgumentException.class, () -> funding.load(stringIndex, KEY, data, ACTIVE, QUIET));
    }
    @Test public void cancelledDownloadsResumeFromTheirVerifiedPrefix() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); Parents data = new Parents(8, 1, 2, 0); AtomicBoolean cancelled = new AtomicBoolean();
        MobilePaymentFunding.Check check = () -> { if (cancelled.get()) throw new InterruptedException("Fixture cancelled"); };
        assertThrows(InterruptedException.class, () -> funding.load(data.selected, KEY, data, check, (stage, completed, total, retry) -> { if (completed == 2) cancelled.set(true); }));
        assertEquals(2, funding.cachedCount()); assertEquals(1, data.calls);
        cancelled.set(false); assertEquals(8, funding.load(data.selected, KEY, data, check, QUIET).length()); assertEquals(4, data.calls);
        assertEquals(new ArrayList<>(data.compact.keySet()).get(2), data.requests.get(1).getString(0));
    }
    @Test public void quotaWaitCancelsWithinOneHundredMilliseconds() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); Parents data = new Parents(1, 1, 32, 0); AtomicInteger calls = new AtomicInteger();
        MobilePaymentFunding.Reader reader = (method, params) -> { calls.incrementAndGet(); throw failure("-32029", 60000); };
        assertThrows(InterruptedException.class, () -> funding.load(data.selected, KEY, reader, () -> { if (time.now >= 100) throw new InterruptedException("Fixture cancelled"); }, QUIET));
        assertEquals(100, time.now); assertEquals(1, calls.get()); assertEquals(0, funding.cachedCount());
    }
    @Test public void capacityReadRetriesAndPreparationHasOneBoundedDeadline() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); AtomicInteger calls = new AtomicInteger();
        MobilePaymentFunding.Session session = funding.session((method, params) -> { if (calls.getAndIncrement() == 0) throw new ExecutionException(failure("-32030", 1500)); return new JSONObject(); }, ACTIVE, QUIET);
        session.read("getaddressutxos", new JSONObject(), "outputs", 0, 1); assertEquals(1500, time.now); assertEquals(2, calls.get());
        time.now = MobilePaymentFunding.MAX_PREPARATION_MS;
        assertThrows(IllegalArgumentException.class, () -> session.read("getchaintip", new JSONObject(), "outputs", 0, 1)); assertEquals(2, calls.get());
        Time retryTime = new Time(); MobilePaymentFunding retryFunding = helper(retryTime); AtomicInteger exhausted = new AtomicInteger();
        MobilePaymentFunding.Session exhaustedSession = retryFunding.session((method, params) -> { exhausted.incrementAndGet(); throw failure("-32029", 0); }, ACTIVE, QUIET);
        assertThrows(IllegalArgumentException.class, () -> exhaustedSession.read("gettransactions", new JSONObject(), "funding", 0, 1));
        assertEquals(15, exhausted.get()); assertEquals(MobilePaymentFunding.MAX_PREPARATION_MS, retryTime.now);
    }
    @Test public void protocolAndTransportErrorsNeverRetryAndBroadcastIsNotAllowed() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); AtomicInteger calls = new AtomicInteger();
        for (String code : new String[]{"-32020", "-32602"}) {
            MobilePaymentFunding.Session session = funding.session((method, params) -> { calls.incrementAndGet(); throw failure(code, 60000); }, ACTIVE, QUIET);
            assertThrows(MobileRpcClient.RpcFailure.class, () -> session.read("gettransactions", new JSONObject(), "funding", 0, 1));
        }
        MobilePaymentFunding.Session session = funding.session((method, params) -> { calls.incrementAndGet(); throw new java.io.IOException("Fixture disconnected"); }, ACTIVE, QUIET);
        assertThrows(java.io.IOException.class, () -> session.read("gettransactions", new JSONObject(), "funding", 0, 1));
        assertThrows(IllegalArgumentException.class, () -> session.read("sendrawtransaction", new JSONObject(), "funding", 0, 1));
        assertEquals(3, calls.get()); assertEquals(0, time.now);
    }
    @Test public void journalReadsAreAllowedButOtherPublicMethodsStayOutsidePreparation() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); AtomicInteger calls = new AtomicInteger();
        JSONObject expected = new JSONObject();
        MobilePaymentFunding.Session session = funding.session((method, params) -> { calls.incrementAndGet(); return expected; }, ACTIVE, QUIET);
        assertSame(expected, session.read("getaddresschanges", new JSONObject(), "outputs", 0, 0));
        for (String method : new String[]{"gettransaction", "getaddressbalance", "getaddresshistory", "getblockbounties", "sendrawtransaction"}) {
            assertThrows(IllegalArgumentException.class, () -> session.read(method, new JSONObject(), "outputs", 0, 0));
        }
        assertEquals(1, calls.get());
    }
    @Test public void proofHeavyHistoryRetainsCompactHexInsteadOfSixteenMiBOfWitnesses() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); Parents data = new Parents(129, 1, 8, NativeTransactions.MAX_PROOF);
        assertTrue((long)data.selected.length() * NativeTransactions.MAX_PROOF * 2 > MobilePaymentFunding.MAX_RETAINED_HEX);
        JSONArray loaded = funding.load(data.selected, KEY, data, ACTIVE, QUIET); assertEquals(129, loaded.length()); assertEquals(17, data.calls);
        assertTrue(funding.cachedCharacters() < 30_000);
        for (int i = 0; i < loaded.length(); i++) {
            String raw = loaded.getJSONObject(i).getString("rawTransaction"); assertEquals(data.compact.get(loaded.getJSONObject(i).getString("txid")), raw);
            assertEquals(0, NativeTransactions.parse(raw).getJSONArray("inputs").getJSONObject(0).getJSONArray("witness").length());
        }
    }
    @Test public void countAndCharacterLimitsEvictOldParentsWithoutChangingCurrentSelection() throws Exception {
        Time time = new Time(); Parents data = new Parents(3, 1, 32, 0); int length = data.compact.values().iterator().next().length();
        MobilePaymentFunding countBound = new MobilePaymentFunding(2, 10000, time, time);
        assertEquals(3, countBound.load(data.selected, KEY, data, ACTIVE, QUIET).length()); assertEquals(2, countBound.cachedCount());
        countBound.load(new JSONArray().put(data.selected.getJSONObject(0)), KEY, data, ACTIVE, QUIET); assertEquals(2, data.calls);
        MobilePaymentFunding bytesBound = new MobilePaymentFunding(8192, length * 2 - 1, time, time);
        bytesBound.load(data.selected, KEY, data, ACTIVE, QUIET); assertEquals(1, bytesBound.cachedCount()); assertEquals(length, bytesBound.cachedCharacters());
        MobilePaymentFunding tooSmall = new MobilePaymentFunding(2, length - 1, time, time);
        assertEquals(3, tooSmall.load(data.selected, KEY, data, ACTIVE, QUIET).length()); assertEquals(0, tooSmall.cachedCount());
    }
    @Test public void deadlinePreservesProofHeavyPrefixForANewReviewAttempt() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); Parents data = new Parents(100, 1, 1, NativeTransactions.MAX_PROOF);
        AtomicInteger minuteCalls = new AtomicInteger(); long[] minute = {-1};
        MobilePaymentFunding.Reader reader = (method, params) -> {
            long current = time.now / 60000;
            if (minute[0] != current) { minute[0] = current; minuteCalls.set(0); }
            if (minuteCalls.getAndIncrement() >= 6) throw failure("-32029", 0);
            return data.read(method, params);
        };
        assertThrows(IllegalArgumentException.class, () -> funding.load(data.selected, KEY, reader, ACTIVE, QUIET));
        assertEquals(MobilePaymentFunding.MAX_PREPARATION_MS, time.now); assertEquals(90, funding.cachedCount()); assertEquals(90, data.calls);
        assertEquals(100, funding.load(data.selected, KEY, reader, ACTIVE, QUIET).length()); assertEquals(100, data.calls);
        assertEquals(new ArrayList<>(data.compact.keySet()).get(90), data.requests.get(90).getString(0));
    }
    @Test public void malformedBatchOrWrongNetworkCannotPopulateCache() throws Exception {
        Time time = new Time(); MobilePaymentFunding funding = helper(time); Parents data = new Parents(2, 1, 32, 0);
        for (String alteration : new String[]{"network", "trailing", "id", "remaining"}) {
            MobilePaymentFunding.Reader reader = (method, params) -> {
                JSONObject response = data.read(method, params);
                if (alteration.equals("network")) response.getJSONObject("tip").put("genesis_hash", "00".repeat(32));
                else if (alteration.equals("remaining")) response.put("remaining", new JSONArray().put("00".repeat(32)));
                else { JSONObject item = response.getJSONArray("transactions").getJSONObject(1); item.put(alteration.equals("id") ? "txid" : "hex", alteration.equals("id") ? "00".repeat(32) : item.getString("hex") + "00"); }
                return response;
            };
            assertThrows(IllegalArgumentException.class, () -> funding.load(data.selected, KEY, reader, ACTIVE, QUIET)); assertEquals(0, funding.cachedCount());
        }
    }
}
