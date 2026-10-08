package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentChecks;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import org.json.JSONArray;
import org.json.JSONObject;

/** Bounded public funding data and cancellable read-only payment preparation.
 * Cached bytes authenticate immutable parents only, never balances, ownership,
 * confirmation state or whether an output remains unspent. No bridge or signer. */
public final class MobilePaymentFunding {
    public static final int MAX_CACHE_ENTRIES = 8192, MAX_RETAINED_HEX = 16 * 1024 * 1024;
    public static final long MAX_PREPARATION_MS = 15 * 60 * 1000L;
    private static final long QUOTA_WINDOW_MS = 60_000;
    public interface Reader {
        JSONObject read(String method, JSONObject params) throws Exception;
        default JSONObject read(String method, JSONObject params, Check check) throws Exception { return read(method, params); }
    }
    public interface Check { void check() throws Exception; }
    public interface Progress { void update(String stage, int completed, int total, long retryAfterMs); }
    interface Clock { long now(); }
    interface Sleeper { void sleep(long milliseconds) throws InterruptedException; }

    private final int maxEntries, maxCharacters;
    private final Clock clock;
    private final Sleeper sleeper;
    private final Map<String, String> cache = new LinkedHashMap<>(16, 0.75f, true);
    private int characters;

    public MobilePaymentFunding() { this(MAX_CACHE_ENTRIES, MAX_RETAINED_HEX); }
    public MobilePaymentFunding(int maxEntries, int maxCharacters) {
        this(maxEntries, maxCharacters, () -> System.nanoTime() / 1_000_000L, Thread::sleep);
    }
    MobilePaymentFunding(int maxEntries, int maxCharacters, Clock clock, Sleeper sleeper) {
        if (maxEntries < 1 || maxEntries > MAX_CACHE_ENTRIES || maxCharacters < 1 || maxCharacters > MAX_RETAINED_HEX || clock == null || sleeper == null) throw new IllegalArgumentException("Invalid payment cache limits.");
        this.maxEntries = maxEntries; this.maxCharacters = maxCharacters; this.clock = clock; this.sleeper = sleeper;
    }
    public Session session(Reader reader, Check check, Progress progress) { return new Session(reader, check, progress); }

    /** One review attempt shares its deadline across inventory, parents and the
     * fresh inventory readback. Only explicit read quota/capacity errors retry. */
    public final class Session {
        private final Reader reader;
        private final Check cancellation;
        private final Progress progress;
        private final long started;
        private Session(Reader reader, Check cancellation, Progress progress) {
            if (reader == null || cancellation == null || progress == null) throw new IllegalArgumentException("Missing payment preparation callback.");
            this.reader = reader; this.cancellation = cancellation; this.progress = progress; started = clock.now();
        }
        public void check() throws Exception {
            cancellation.check();
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException("Payment preparation cancelled.");
            if (clock.now() - started >= MAX_PREPARATION_MS) throw new IllegalArgumentException("Payment preparation timed out. Review again to resume verified funding downloads.");
        }
        private void report(String stage, int completed, int total, long retryAfterMs) throws Exception {
            check(); progress.update(stage, completed, total, retryAfterMs); check();
        }
        public JSONObject read(String method, JSONObject params, String stage, int completed, int total) throws Exception {
            if (!"gettransactions".equals(method) && !"getaddressutxos".equals(method) && !"getaddresschanges".equals(method) && !"getchaintip".equals(method)) throw new IllegalArgumentException("Payment preparation permits public reads only.");
            while (true) {
                report(stage, completed, total, 0);
                try { JSONObject response = reader.read(method, params, this::check); check(); return response; }
                catch (Exception error) {
                    check(); Exception failure = unwrap(error);
                    if (!(failure instanceof MobileRpcClient.RpcFailure)) throw failure;
                    MobileRpcClient.RpcFailure rpc = (MobileRpcClient.RpcFailure)failure;
                    if (rpc.unknownOutcome || (!"-32029".equals(rpc.code) && !"-32030".equals(rpc.code))) throw rpc;
                    // The server may omit retry duration. Local quotas now
                    // wait in the transport instead of raising this error.
                    long minimum = "-32029".equals(rpc.code) ? QUOTA_WINDOW_MS : 1000;
                    waitFor(Math.max(minimum, rpc.retryAfterMs), completed, total);
                }
            }
        }
        private void waitFor(long delay, int completed, int total) throws Exception {
            long began = clock.now(), lastSeconds = -1;
            while (true) {
                check(); long elapsed = clock.now() - began;
                if (elapsed >= delay) return;
                long remaining = delay - elapsed, seconds = (remaining + 999) / 1000;
                if (seconds != lastSeconds) { report("waiting", completed, total, remaining); lastSeconds = seconds; }
                sleeper.sleep(Math.min(100, remaining));
            }
        }
    }
    private static Exception unwrap(Exception error) {
        Exception current = error;
        while ((current instanceof ExecutionException || current instanceof CompletionException) && current.getCause() instanceof Exception) current = (Exception)current.getCause();
        return current;
    }
    public JSONArray load(JSONArray selected, String publicKey, Reader reader, Check check, Progress progress) throws Exception {
        return load(selected, publicKey, session(reader, check, progress));
    }
    public JSONArray load(JSONArray selected, String publicKey, Session session) throws Exception {
        if (publicKey == null) throw new IllegalArgumentException("Missing funding ownership key.");
        return load(selected, input -> publicKey, session);
    }
    public JSONArray load(JSONArray selected, NativeTransactions.FundingOwner owner, Session session) throws Exception {
        session.check();
        if (selected == null || selected.length() < 1 || selected.length() > NativeTransactions.MAX_PAYMENT_INPUTS || owner == null) throw new IllegalArgumentException("Invalid selected payment inputs.");
        Set<String> outpoints = new HashSet<>(); Map<String, String> parents = new LinkedHashMap<>();
        for (int i = 0; i < selected.length(); i++) {
            session.check(); JSONObject row = selected.getJSONObject(i); Object id = row.opt("txid"), vout = row.opt("vout"), value = row.opt("amount");
            if (!(id instanceof String) || !((String)id).matches("[0-9a-f]{64}") || !(vout instanceof Integer || vout instanceof Long) || ((Number)vout).longValue() < 0 || ((Number)vout).longValue() > 0xffffffffL || !(value instanceof String) || !outpoints.add(id + ":" + vout)) throw new IllegalArgumentException("Invalid selected payment output.");
            NativeTransactions.amount((String)value); parents.put((String)id, null);
        }
        int completed = 0, retained = 0; List<String> missing = new ArrayList<>();
        for (String id : parents.keySet()) {
            session.check(); String raw = cached(id);
            if (raw == null) missing.add(id);
            else { retained = retain(retained, raw); parents.put(id, raw); completed++; }
        }
        session.report("funding", completed, parents.size(), 0);
        int next = 0;
        while (next < missing.size()) {
            session.check(); JSONArray ids = new JSONArray();
            for (int i = next; i < Math.min(next + 32, missing.size()); i++) ids.put(missing.get(i));
            // The batch scope releases the original proof-bearing response
            // before fetching another. Only compact, authenticated hex survives.
            JSONArray compact = fetch(ids, session, completed, parents.size());
            for (int i = 0; i < compact.length(); i++) {
                session.check(); JSONObject item = compact.getJSONObject(i); String raw = item.getString("hex"), id = item.getString("txid");
                retained = retain(retained, raw); parents.put(id, raw); remember(id, raw); next++; completed++;
                session.report("funding", completed, parents.size(), 0);
            }
        }
        JSONArray result = new JSONArray();
        for (int i = 0; i < selected.length(); i++) {
            session.check(); JSONObject source = selected.getJSONObject(i), row = new JSONObject();
            Iterator<String> fields = source.keys(); while (fields.hasNext()) { String field = fields.next(); if (!"rawTransaction".equals(field)) row.put(field, source.get(field)); }
            row.put("rawTransaction", parents.get(source.getString("txid"))); result.put(row);
        }
        NativeTransactions.verifyFundingBatch(result, owner, session::check);
        session.check(); return result;
    }
    private static int retain(int retained, String hex) {
        if (hex.length() > MAX_RETAINED_HEX - retained) throw new IllegalArgumentException("Selected funding exceeds the mobile memory limit.");
        return retained + hex.length();
    }
    private JSONArray fetch(JSONArray ids, Session session, int completed, int total) throws Exception {
        JSONObject response = session.read("gettransactions", new JSONObject().put("txids", ids), "funding", completed, total);
        return NativePaymentChecks.fundingTransactions(response, ids, session::check);
    }
    private synchronized String cached(String id) { return cache.get(id); }
    private synchronized void remember(String id, String raw) {
        if (raw.length() > maxCharacters) return;
        String previous = cache.remove(id); if (previous != null) characters -= previous.length();
        while (!cache.isEmpty() && (cache.size() >= maxEntries || characters > maxCharacters - raw.length())) {
            String oldest = cache.keySet().iterator().next(); characters -= cache.remove(oldest).length();
        }
        cache.put(id, raw); characters += raw.length();
    }
    synchronized int cachedCount() { return cache.size(); }
    synchronized int cachedCharacters() { return characters; }
}
