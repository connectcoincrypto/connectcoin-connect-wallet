package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native-only plaintext TCP NDJSON client, matching the desktop RPC service.
 * RPC traffic is not encrypted or server-authenticated. Private signing keys
 * remain native; this transport does not alter TLS/certificate verification
 * performed separately by the P2C proof engine. No JavaScript bridge.
 * One persistent socket, sixteen in-flight requests and forty-eight total jobs.
 * The bounded waiting headroom permits UI/payment reads to overlap with claims.
 * Local quota waits are bounded by that same operation cap, use no socket/worker,
 * and do not consume the actual network-operation timeout.
 * Wallet notifications use a separate MobileWalletSubscriptions socket/worker;
 * subscriptions never occupy this bounded query/bounty worker pool.
 * A bounty consumer must stage chunks privately until the future succeeds;
 * cancellation, EOF, malformed/incomplete streams never publish partial success.
 */
public final class MobileRpcClient implements AutoCloseable {
    static final int MAX_IN_FLIGHT = 16, MAX_JOBS = 48;
    private static final int MAX_BUFFERED_FRAMES = 128;
    private static final long MAX_BUFFERED_BYTES = 16L * 1024 * 1024;
    static final int MAX_FRAME = 2 * 1024 * 1024;
    static final long MAX_STREAM_BYTES = 64L * 1024 * 1024;
    static final int MAX_STREAM_ROWS = 100000;
    private static final long WINDOW_MS = 60000;
    private static final String HASH = "[0-9a-fA-F]{64}";
    private static final Map<String, Set<String>> PARAMS;
    static {
        Map<String, Set<String>> methods = new HashMap<>();
        methods.put("getchaintip", keys()); methods.put("getrecentblockhashes", keys());
        methods.put("getaddressbalance", keys("address"));
        methods.put("getaddresshistory", keys("address", "cursor"));
        methods.put("getaddressutxos", keys("address", "cursor", "include_pending_spent"));
        methods.put("getaddresschanges", keys("addresses", "cursor"));
        methods.put("gettransaction", keys("txid")); methods.put("gettransactions", keys("txids"));
        methods.put("getbountychanges", keys("cursor"));
        methods.put("getblockbounties", keys("block_hash"));
        methods.put("sendrawtransaction", keys("transaction_hex"));
        PARAMS = Collections.unmodifiableMap(methods);
    }
    private static Set<String> keys(String... names) { return new HashSet<>(Arrays.asList(names)); }

    /** Selected by native application configuration, never from an RPC/JS call. */
    public static final class TcpEndpoint {
        public final String hostname;
        public final int port;
        public TcpEndpoint(String hostname, int port) { this(hostname, port, false); }
        private TcpEndpoint(String hostname, int port, boolean localFixture) {
            if (hostname == null || hostname.length() > 253 || port < 1 || port > 65535 ||
                !hostname.matches("[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?")) throw new IllegalArgumentException("Invalid pinned TCP endpoint");
            String name = hostname.toLowerCase(Locale.ROOT);
            for (String label : name.split("\\.", -1)) if (label.length() < 1 || label.length() > 63 || label.startsWith("-") || label.endsWith("-")) throw new IllegalArgumentException("Invalid pinned TCP hostname");
            if (!localFixture && (!name.contains(".") || name.matches("[0-9.]+") || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal"))) {
                throw new IllegalArgumentException("A public DNS hostname is required for the TCP endpoint");
            }
            this.hostname = name; this.port = port;
        }
    }
    public static final class RpcFailure extends Exception {
        private static final long serialVersionUID = 1L;
        public final String code;
        public final boolean unknownOutcome;
        public final Integer nodeCode;
        public final long retryAfterMs;
        /** Safe operation metadata only: never includes an endpoint, parameters or response content. */
        public final String method, phase;
        public final long elapsedMs, queuedMs, bytesReceived;
        // Native-only recovery hints. Do not infer a broken wire from a malformed response,
        // or treat an ordinary lifecycle cancellation as network suspension.
        final boolean transportLoss, networkSuspended;
        private final boolean explicitRejection;
        private RpcFailure(String code, boolean unknownOutcome, Integer nodeCode, long retryAfterMs, boolean explicitRejection) {
            this(code, unknownOutcome, nodeCode, retryAfterMs, explicitRejection, "", "", 0, 0, 0);
        }
        private RpcFailure(String code, boolean unknownOutcome, Integer nodeCode, long retryAfterMs, boolean explicitRejection,
            String method, String phase, long elapsedMs, long queuedMs, long bytesReceived) {
            this(code, unknownOutcome, nodeCode, retryAfterMs, explicitRejection, method, phase, elapsedMs, queuedMs, bytesReceived, false, false);
        }
        private RpcFailure(String code, boolean unknownOutcome, Integer nodeCode, long retryAfterMs, boolean explicitRejection,
            String method, String phase, long elapsedMs, long queuedMs, long bytesReceived, boolean transportLoss, boolean networkSuspended) {
            super(unknownOutcome ? "Broadcast outcome is unknown. Check its transaction ID before retrying." : message(code));
            this.code = code; this.unknownOutcome = unknownOutcome; this.nodeCode = nodeCode;
            this.retryAfterMs = retryAfterMs; this.explicitRejection = explicitRejection;
            this.method = method; this.phase = phase; this.elapsedMs = elapsedMs; this.queuedMs = queuedMs; this.bytesReceived = bytesReceived;
            this.transportLoss = transportLoss; this.networkSuspended = networkSuspended;
        }
        RpcFailure recoveryHint(boolean lost, boolean suspended) {
            return new RpcFailure(code, unknownOutcome, nodeCode, retryAfterMs, explicitRejection, method, phase,
                elapsedMs, queuedMs, bytesReceived, lost, suspended);
        }
    }
    public interface ChunkConsumer { void accept(JSONObject chunk) throws Exception; }
    interface Resolver { InetAddress[] resolve(String hostname) throws IOException; }
    private final TcpEndpoint endpoint;
    private final Resolver resolver;
    private final boolean localFixture;
    private final int requestTimeoutMs, streamTimeoutMs;
    private final long quotaWindowMs;
    private final ThreadPoolExecutor workers;
    private final ScheduledThreadPoolExecutor deadlines;
    private final Set<Job> jobs = new HashSet<>();
    private final Map<String, ArrayDeque<Long>> history = new HashMap<>();
    private final Map<String, Long> cooldowns = new HashMap<>();
    private Connection connection;
    private int bufferedFrames;
    private long bufferedBytes;
    private long generation, sequence;
    private boolean active, closed, networkSuspended;

    public MobileRpcClient(TcpEndpoint endpoint) {
        this(endpoint, InetAddress::getAllByName, false, 40000, 120000, WINDOW_MS);
    }
    // Explicit package-private fixture seam, never callable through Capacitor.
    static MobileRpcClient localTestClient(String hostname, int port, Resolver resolver, int timeoutMs) {
        return localTestClient(hostname, port, resolver, timeoutMs, WINDOW_MS);
    }
    static MobileRpcClient localTestClient(String hostname, int port, Resolver resolver, int timeoutMs, long quotaWindowMs) {
        return new MobileRpcClient(new TcpEndpoint(hostname, port, true), resolver, true, timeoutMs, timeoutMs, quotaWindowMs);
    }
    private MobileRpcClient(TcpEndpoint endpoint, Resolver resolver, boolean localFixture,
        int requestTimeoutMs, int streamTimeoutMs, long quotaWindowMs) {
        if (endpoint == null || resolver == null || requestTimeoutMs < 1 || requestTimeoutMs > 40000 || streamTimeoutMs < 1 || streamTimeoutMs > 120000 || quotaWindowMs < 1 || quotaWindowMs > WINDOW_MS) throw new IllegalArgumentException("Invalid TCP transport settings");
        this.endpoint = endpoint; this.resolver = resolver; this.localFixture = localFixture;
        this.requestTimeoutMs = requestTimeoutMs; this.streamTimeoutMs = streamTimeoutMs; this.quotaWindowMs = quotaWindowMs;
        ThreadFactory threads = runnable -> { Thread thread = new Thread(runnable, "connectwallet-native-tcp-rpc"); thread.setDaemon(true); return thread; };
        workers = new ThreadPoolExecutor(MAX_IN_FLIGHT, MAX_IN_FLIGHT, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(MAX_JOBS - MAX_IN_FLIGHT), threads, new ThreadPoolExecutor.AbortPolicy());
        deadlines = new ScheduledThreadPoolExecutor(1, threads); deadlines.setRemoveOnCancelPolicy(true);
    }

    /** The native engine decides foreground/background policy; inactive initially. */
    public void setActive(boolean enabled) {
        setActive(enabled, false);
    }
    void setActive(boolean enabled, boolean networkUnavailable) {
        ArrayList<Job> cancelled = null;
        synchronized (this) {
            if (closed) return; active = enabled; networkSuspended = !enabled && networkUnavailable;
            if (!enabled) { generation++; cancelled = new ArrayList<>(jobs); workers.getQueue().clear(); detachConnection(); }
        }
        // A concurrent resume must not have its newly queued jobs cancelled.
        if (cancelled != null) for (Job job : cancelled) job.finish(null, failure("RPC_CANCELLED").recoveryHint(false, networkUnavailable), true);
    }
    synchronized boolean isActive() { return active && !closed; }
    public void cancelAll() {
        ArrayList<Job> cancelled;
        synchronized (this) { generation++; cancelled = new ArrayList<>(jobs); workers.getQueue().clear(); detachConnection(); }
        for (Job job : cancelled) job.finish(null, failure("RPC_CANCELLED"), true);
    }
    /** Cancel only this client's operation, atomically before any request bytes may be written. */
    public boolean cancelBeforeWrite(CompletableFuture<JSONObject> future) {
        Job cancelled = null;
        synchronized (this) {
            for (Job job : jobs) if (job.future == future) {
                if (job.done.get() || job.writeAttempted || job.preWriteCancelled) return false;
                job.preWriteCancelled = true; cancelled = job; break;
            }
        }
        if (cancelled == null) return false;
        cancelled.finish(null, failure("RPC_CANCELLED"), true); return true;
    }
    /** Endpoint replacement must not cancel any queued, written or draining broadcast. */
    synchronized boolean canChangeEndpoint() {
        if (closed) return false;
        for (Job job : jobs) if ("sendrawtransaction".equals(job.method)) return false;
        return true;
    }
    /** Build an inactive native successor; this performs no DNS or network operation. */
    MobileRpcClient prepareReplacement(TcpEndpoint next) {
        return new MobileRpcClient(next, resolver, localFixture, requestTimeoutMs, streamTimeoutMs, quotaWindowMs);
    }
    /**
     * Commit preferences while enqueue/write admission is held. Failure leaves this
     * client untouched. A successful replacement inherits all method quotas and
     * cooldowns, even when switching away and back to the same host.
     */
    void replaceWith(MobileRpcClient replacement, Runnable persist) {
        if (replacement == null || replacement == this || persist == null) throw new IllegalArgumentException("Invalid native RPC replacement");
        synchronized (this) {
            if (!canChangeEndpoint()) throw new IllegalStateException("Wait for the current transaction before changing RPC.");
            synchronized (replacement) {
                if (replacement.closed || replacement.active || !replacement.jobs.isEmpty() || !replacement.history.isEmpty() || !replacement.cooldowns.isEmpty()) {
                    throw new IllegalStateException("The replacement RPC client must be unused.");
                }
                for (Map.Entry<String, ArrayDeque<Long>> item : history.entrySet()) {
                    replacement.history.put(item.getKey(), new ArrayDeque<>(item.getValue()));
                }
                replacement.cooldowns.putAll(cooldowns);
                persist.run();
                replacement.active = active;
                closed = true; active = false;
            }
        }
        cancelAll(); workers.shutdownNow(); deadlines.shutdownNow();
    }
    @Override public void close() {
        synchronized (this) { if (closed) return; closed = true; active = false; }
        cancelAll(); workers.shutdownNow(); deadlines.shutdownNow();
    }

    public CompletableFuture<JSONObject> call(String method, JSONObject params) {
        if ("sendrawtransaction".equals(method) || "getblockbounties".equals(method)) return failed(failure("RPC_INVALID"));
        return enqueue(method, params, null);
    }
    public CompletableFuture<JSONObject> streamBounties(String blockHash, ChunkConsumer consumer) {
        if (consumer == null) return failed(failure("RPC_INVALID"));
        try { return enqueue("getblockbounties", new JSONObject().put("block_hash", blockHash), consumer); }
        catch (JSONException error) { return failed(failure("RPC_INVALID")); }
    }
    /** Native signing/claim engine only. Not registered as a plugin method. */
    public CompletableFuture<JSONObject> broadcast(String transactionHex) {
        try { return enqueue("sendrawtransaction", new JSONObject().put("transaction_hex", transactionHex), null); }
        catch (JSONException error) { return failed(failure("RPC_INVALID")); }
    }
    private static CompletableFuture<JSONObject> failed(RpcFailure error) {
        CompletableFuture<JSONObject> future = new CompletableFuture<>(); future.completeExceptionally(error); return future;
    }
    private CompletableFuture<JSONObject> enqueue(String method, JSONObject params, ChunkConsumer consumer) {
        final JSONObject clean;
        try { clean = validateParams(method, params); } catch (RpcFailure error) { return failed(error); }
        final Job job;
        synchronized (this) {
            if (closed || !active) return failed(failure(closed ? "RPC_CANCELLED" : "RPC_INACTIVE").recoveryHint(false, !closed && networkSuspended));
            if (jobs.size() >= MAX_JOBS || sequence == Long.MAX_VALUE) return failed(failure("RPC_BUSY"));
            job = new Job(method, clean, "mobile-native-" + (++sequence), generation, consumer);
            jobs.add(job);
        }
        job.schedule(); return job.future;
    }

    static JSONObject validateParams(String method, JSONObject params) throws RpcFailure {
        Set<String> allowed = PARAMS.get(method);
        if (allowed == null || params == null) throw failure("RPC_INVALID");
        Iterator<String> names = params.keys();
        while (names.hasNext()) if (!allowed.contains(names.next())) throw failure("RPC_INVALID");
        JSONObject clean = new JSONObject();
        try {
            for (String name : allowed) {
                if (!params.has(name)) {
                    if (!name.equals("cursor") && !name.equals("include_pending_spent")) throw failure("RPC_INVALID");
                    continue;
                }
                Object value = params.opt(name);
                switch (name) {
                    case "address": clean.put(name, address(value)); break;
                    case "cursor":
                        if (value != JSONObject.NULL && (!(value instanceof String) || !((String) value).matches("[A-Za-z0-9_.-]{1,1024}"))) throw failure("RPC_INVALID");
                        clean.put(name, value); break;
                    case "include_pending_spent":
                        if (!(value instanceof Boolean)) throw failure("RPC_INVALID"); clean.put(name, value); break;
                    case "txid": case "block_hash": clean.put(name, hash(value)); break;
                    case "transaction_hex":
                        if (!(value instanceof String) || ((String) value).length() < 20 || ((String) value).length() > 800000 || ((String) value).length() % 2 != 0 || !((String) value).matches("[0-9a-fA-F]+")) throw failure("RPC_INVALID");
                        clean.put(name, ((String) value).toLowerCase(Locale.ROOT)); break;
                    case "addresses": case "txids":
                        if (!(value instanceof JSONArray)) throw failure("RPC_INVALID");
                        JSONArray source = (JSONArray) value, copy = new JSONArray(); Set<String> unique = new HashSet<>();
                        if (source.length() < 1 || source.length() > (name.equals("addresses") ? 100 : 32)) throw failure("RPC_INVALID");
                        for (int index = 0; index < source.length(); index++) {
                            String entry = name.equals("addresses") ? address(source.opt(index)) : hash(source.opt(index));
                            if (!unique.add(entry)) throw failure("RPC_INVALID"); copy.put(entry);
                        }
                        clean.put(name, copy); break;
                    default: throw failure("RPC_INVALID");
                }
            }
        } catch (JSONException error) { throw failure("RPC_INVALID"); }
        return clean;
    }
    private static String hash(Object value) throws RpcFailure {
        if (!(value instanceof String) || !((String) value).matches(HASH)) throw failure("RPC_INVALID");
        return ((String) value).toLowerCase(Locale.ROOT);
    }
    private static String address(Object value) throws RpcFailure {
        if (!(value instanceof String)) throw failure("RPC_INVALID");
        String source = (String) value, text = source.toLowerCase(Locale.ROOT);
        if ((!source.equals(text) && !source.equals(source.toUpperCase(Locale.ROOT))) || !text.matches("cc1p[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}")) throw failure("RPC_INVALID");
        return text; // Wallet model verifies curve/checksum/network before spending.
    }
    private static long nowMs() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()); }
    private static boolean publicAddress(InetAddress address) {
        byte[] bytes = address.getAddress();
        return !(address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress() ||
            (bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc) || (bytes.length == 4 && ((bytes[0] & 255) == 0 || (bytes[0] & 255) >= 224 || ((bytes[0] & 255) == 100 && (bytes[1] & 0xc0) == 64))));
    }
    private String quotaKey(String method, JSONObject params) throws JSONException {
        return method.equals("getblockbounties") ? method + ":" + params.getString("block_hash") : method;
    }
    private long quotaWait(Job job, boolean reserve) throws RpcFailure, JSONException {
        synchronized (this) {
            job.check(); long now = nowMs();
            long wait = Math.max(0, cooldowns.getOrDefault(job.method, 0L) - now);
            // Reclaim old block-specific quota keys; never let attacker-selected
            // block hashes grow the per-client limiter without a bound.
            Iterator<Map.Entry<String, ArrayDeque<Long>>> entries = history.entrySet().iterator();
            while (entries.hasNext()) {
                ArrayDeque<Long> times = entries.next().getValue();
                while (!times.isEmpty() && now - times.peekFirst() >= quotaWindowMs) times.removeFirst();
                if (times.isEmpty()) entries.remove();
            }
            String key = quotaKey(job.method, job.params);
            ArrayDeque<Long> times = history.get(key);
            int limit = job.method.equals("gettransactions") ? 6 : job.method.equals("getblockbounties") ? 8 : 48;
            if (times != null && times.size() >= limit) wait = Math.max(wait, times.peekFirst() + quotaWindowMs - now);
            ArrayDeque<Long> overall = job.method.equals("getblockbounties") ? history.get(job.method) : null;
            if (overall != null && overall.size() >= 48) wait = Math.max(wait, overall.peekFirst() + quotaWindowMs - now);
            if (wait > 0 || !reserve) return wait;
            int needed = (times == null ? 1 : 0) + (job.method.equals("getblockbounties") && overall == null ? 1 : 0);
            if (history.size() + needed > 1024) throw failure("RPC_BUSY");
            if (times == null) { times = new ArrayDeque<>(); history.put(key, times); }
            if (job.method.equals("getblockbounties")) {
                if (overall == null) { overall = new ArrayDeque<>(); history.put(job.method, overall); }
                overall.addLast(now);
            }
            times.addLast(now);
            return 0;
        }
    }
    private void detachConnection() {
        Connection old = connection; connection = null;
        if (old != null) { old.lost = true; closeSocket(old.socket); }
    }
    private Connection bind(Job job) throws RpcFailure {
        synchronized (this) {
            job.check();
            if (job.connection != null) {
                if (job.connection.lost) throw failure("RPC_UNAVAILABLE");
                return job.connection;
            }
            if (connection == null || connection.lost) connection = new Connection();
            job.connection = connection; return connection;
        }
    }
    private static final class Inbound {
        final JSONObject message; final int bytes;
        Inbound(JSONObject message, int bytes) { this.message = message; this.bytes = bytes; }
    }
    /** Socket ownership is independent of any one request. Calls only reconnect
     * when newly scheduled; connection loss never retransmits existing jobs. */
    private final class Connection {
        final Socket socket = new Socket();
        final Object connectLock = new Object(), writeLock = new Object();
        final Map<String, Job> replies = new HashMap<>(), streams = new HashMap<>();
        volatile boolean connected, lost;
        void connect(Job owner) throws Exception {
            synchronized (connectLock) {
                owner.check(); if (lost) throw failure("RPC_UNAVAILABLE");
                if (connected) return;
                owner.phase("dns");
                InetAddress[] addresses = resolver.resolve(endpoint.hostname); owner.check();
                if (addresses == null || addresses.length == 0 || (!localFixture && !publicAddress(addresses[0]))) throw failure("RPC_UNAVAILABLE");
                if (lost) throw failure("RPC_UNAVAILABLE");
                owner.phase("connect");
                socket.connect(new InetSocketAddress(addresses[0], endpoint.port), Math.min(8000, owner.remaining()));
                socket.setTcpNoDelay(true); socket.setKeepAlive(true); socket.setSoTimeout(0);
                synchronized (MobileRpcClient.this) {
                    // Once TCP connects, readiness belongs to the connection,
                    // not to the first request. Its individual cancellation
                    // must not leave a connected Socket marked unconnected.
                    if (lost || closed || !active || generation != owner.epoch) throw failure("RPC_CANCELLED").recoveryHint(false, !closed && !active && networkSuspended);
                    connected = true;
                }
                Thread reader = new Thread(this::read, "connectwallet-native-tcp-reader");
                reader.setDaemon(true); reader.start();
            }
        }
        void read() {
            try {
                WireFrames frames = new WireFrames(socket.getInputStream(), this);
                for (;;) { Inbound inbound = frames.next(); dispatch(inbound); }
            } catch (java.io.EOFException end) { fail(failure("RPC_UNAVAILABLE"), true); }
            catch (RpcFailure error) { fail(error, false); }
            catch (java.nio.charset.CharacterCodingException error) { fail(failure("RPC_PROTOCOL"), false); }
            catch (IOException error) { fail(failure("RPC_UNAVAILABLE"), true); }
            catch (Exception error) { fail(failure("RPC_PROTOCOL"), false); }
        }
        void dispatch(Inbound inbound) throws Exception {
            synchronized (MobileRpcClient.this) {
                if (lost) return;
                JSONObject message = inbound.message; Job job;
                if (!"2.0".equals(message.opt("jsonrpc")) || message.length() != 3) throw failure("RPC_PROTOCOL");
                if (message.has("id")) {
                    if (!(message.opt("id") instanceof String) || message.has("method") || message.has("result") == message.has("error")) throw failure("RPC_PROTOCOL");
                    job = replies.get(message.getString("id"));
                    if (job == null || job.responseSeen) throw failure("RPC_PROTOCOL");
                    JSONObject result = null;
                    try { result = reply(message, job.id); }
                    catch (RpcFailure rejected) {
                        if (!rejected.code.matches("-?[0-9]+")) throw rejected;
                        // Apply server pacing before a different writer can
                        // transmit, not later when this job drains its inbox.
                        if ("-32029".equals(rejected.code)) cooldowns.put(job.method, nowMs() + Math.max(quotaWindowMs, rejected.retryAfterMs));
                    }
                    job.responseSeen = true;
                    if (job.consumer != null && result != null) {
                        Object id = result.opt("stream_id");
                        if (result == null || result.length() != 1 || !(id instanceof String) || !((String)id).matches("[A-Za-z0-9_.-]{1,100}") || streams.containsKey(id)) throw failure("RPC_PROTOCOL");
                        job.streamId = (String)id; streams.put(job.streamId, job);
                    } else job.terminalReceived = true;
                } else {
                    if (!message.has("method") || !(message.opt("params") instanceof JSONObject)) throw failure("RPC_PROTOCOL");
                    JSONObject params = message.getJSONObject("params"); Object id = params.opt("stream_id");
                    job = id instanceof String ? streams.get(id) : null;
                    if (job == null || job.terminalReceived || !("stream.chunk".equals(message.opt("method")) || "stream.end".equals(message.opt("method")))) throw failure("RPC_PROTOCOL");
                    if ("stream.end".equals(message.opt("method"))) job.terminalReceived = true;
                }
                if (job.done.get() || job.connection != this || bufferedFrames >= MAX_BUFFERED_FRAMES || bufferedBytes + inbound.bytes > MAX_BUFFERED_BYTES) throw failure("RPC_STREAM_LIMIT");
                if (!job.inbox.offer(inbound)) throw failure("RPC_STREAM_LIMIT");
                bufferedFrames++; bufferedBytes += inbound.bytes;
                job.bytesReceived = Math.max(job.bytesReceived, inbound.bytes);
            }
        }
        void fail(RpcFailure reason, boolean allowCompleteReply) {
            ArrayList<Job> affected = new ArrayList<>();
            synchronized (MobileRpcClient.this) {
                if (lost) return;
                lost = true; closeSocket(socket); if (connection == this) connection = null;
                for (Job job : jobs) if (job.connection == this && !(allowCompleteReply && job.terminalReceived)) affected.add(job);
            }
            for (Job job : affected) {
                RpcFailure error = reason;
                if (allowCompleteReply && job.writeAttempted) error = failure(job.consumer == null ? "RPC_PROTOCOL" : "RPC_STREAM_INCOMPLETE").recoveryHint(true, false);
                job.finish(null, error, true);
            }
        }
        void received(int bytes) {
            // Attribute an incomplete frame only when there is one owner. With
            // multiplexing, complete frames are attributed by their verified ID.
            synchronized (MobileRpcClient.this) {
                Job sole = null;
                for (Job job : replies.values()) if (!job.done.get()) { if (sole != null) return; sole = job; }
                if (sole != null) sole.bytesReceived += bytes;
            }
        }
    }
    private final class Job implements Runnable {
        final String method, id;
        final JSONObject params;
        final long epoch, started = nowMs();
        final int timeoutMs;
        final ChunkConsumer consumer;
        final AtomicBoolean done = new AtomicBoolean();
        // Cancellation completes with RpcFailure, preserving unknownOutcome
        // rather than hiding an in-flight broadcast behind CancellationException.
        final CompletableFuture<JSONObject> future = new CompletableFuture<JSONObject>() {
            @Override public boolean cancel(boolean mayInterruptIfRunning) { return finish(null, failure("RPC_CANCELLED")); }
        };
        volatile Connection connection;
        final ArrayBlockingQueue<Inbound> inbox = new ArrayBlockingQueue<>(MAX_BUFFERED_FRAMES);
        boolean responseSeen, terminalReceived, preWriteCancelled;
        volatile boolean abandoned;
        String streamId;
        volatile ScheduledFuture<?> deadline, quotaWake;
        long deadlineSerial, quotaStarted = -1, quotaElapsed, queueStarted = -1, queueElapsed;
        volatile long bytesReceived;
        volatile String phase = "queue";
        boolean writeAttempted;
        Job(String method, JSONObject params, String id, long epoch, ChunkConsumer consumer) {
            this.method = method; this.params = params; this.id = id; this.epoch = epoch; this.consumer = consumer;
            timeoutMs = consumer == null ? requestTimeoutMs : streamTimeoutMs;
        }
        MobileRpcClient owner() { return MobileRpcClient.this; }
        void check() throws RpcFailure {
            synchronized (MobileRpcClient.this) {
                if (done.get() || preWriteCancelled || closed || !active || generation != epoch) throw failure("RPC_CANCELLED").recoveryHint(false, !closed && !active && networkSuspended);
                if (activeElapsed() >= timeoutMs) throw failure("RPC_TIMEOUT");
            }
        }
        private long activeElapsed() { long now = nowMs(); return Math.max(0, now - started - quotaElapsed - (quotaStarted < 0 ? 0 : now - quotaStarted)); }
        int remaining() throws RpcFailure { synchronized (MobileRpcClient.this) { check(); return (int) Math.max(1, timeoutMs - activeElapsed()); } }
        private void endQueueWait() { if (queueStarted >= 0) { queueElapsed += Math.max(0, nowMs() - queueStarted); queueStarted = -1; } }
        private void endQuotaWait() { if (quotaStarted >= 0) { quotaElapsed += Math.max(0, nowMs() - quotaStarted); quotaStarted = -1; } }
        /** Scheduling is metadata-only. Waiting for one method's quota owns neither worker nor socket. */
        void schedule() {
            try {
                synchronized (MobileRpcClient.this) {
                    if (done.get()) return;
                    endQuotaWait(); check();
                    long wait = quotaWait(this, false);
                    if (wait > 0) { parkForQuota(wait); return; }
                    bind(this); phase = "queue"; queueStarted = nowMs(); armDeadline(); workers.execute(this);
                }
            } catch (RpcFailure error) { finish(null, error); }
            catch (RejectedExecutionException error) { finish(null, failure("RPC_BUSY")); }
            catch (JSONException error) { finish(null, failure("RPC_INVALID")); }
        }
        private void parkForQuota(long wait) throws RpcFailure {
            check(); endQueueWait();
            // A method quota wait releases its request worker/slot, never the
            // persistent socket serving unrelated requests or a broadcast.
            connection = null;
            phase = "quota"; quotaStarted = nowMs();
            deadlineSerial++; if (deadline != null) deadline.cancel(false); deadline = null;
            if (quotaWake != null) quotaWake.cancel(false);
            quotaWake = deadlines.schedule(this::schedule, Math.max(1, wait), TimeUnit.MILLISECONDS);
        }
        private void armDeadline() {
            if (deadline != null) deadline.cancel(false);
            final long token = ++deadlineSerial;
            deadline = deadlines.schedule(() -> {
                Connection failedWire;
                synchronized (MobileRpcClient.this) {
                    if (done.get() || token != deadlineSerial || quotaStarted >= 0) return;
                    if (activeElapsed() < timeoutMs) { armDeadline(); return; }
                    failedWire = connection != null && !connection.lost && (writeAttempted || !connection.connected) ? connection : null;
                }
                if (failedWire != null) failedWire.fail(failure("RPC_TIMEOUT"), false);
                else finish(null, failure("RPC_TIMEOUT"), true);
            }, Math.max(1, timeoutMs - activeElapsed()), TimeUnit.MILLISECONDS);
        }
        void phase(String value) throws RpcFailure {
            synchronized (MobileRpcClient.this) { check(); phase = value; }
        }
        @Override public void run() {
            try {
                synchronized (MobileRpcClient.this) {
                    check(); endQueueWait();
                    long wait = quotaWait(this, false);
                    if (wait > 0) { parkForQuota(wait); return; }
                    phase = "dns";
                }
                Connection wire = bind(this); wire.connect(this); check();
                JSONObject request = new JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params);
                byte[] bytes = (request + "\n").getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 1024 * 1024) throw failure("RPC_INVALID");
                synchronized (wire.writeLock) {
                    synchronized (MobileRpcClient.this) {
                        check(); if (wire.lost || connection != wire) throw failure("RPC_UNAVAILABLE");
                        long wait = quotaWait(this, true);
                        if (wait > 0) { parkForQuota(wait); return; }
                        phase = "write"; wire.replies.put(id, this); writeAttempted = true;
                    }
                    wire.socket.getOutputStream().write(bytes); wire.socket.getOutputStream().flush();
                }
                phase("read");
                Frames frames = new Frames(this);
                JSONObject result = reply(frames.next(), id);
                if (consumer != null) result = drain(frames, result);
                if (method.equals("sendrawtransaction")) {
                    if (result.length() != 1 || !(result.opt("txid") instanceof String) || !((String) result.opt("txid")).matches(HASH)) throw failure("RPC_PROTOCOL");
                }
                check(); finish(result, null);
            } catch (RpcFailure error) { failed(error); }
            catch (java.net.SocketTimeoutException error) { failed(failure("RPC_TIMEOUT")); }
            catch (IOException error) { failed(failure("RPC_UNAVAILABLE")); }
            catch (Exception error) { failed(failure("RPC_PROTOCOL")); }
        }
        void failed(RpcFailure error) {
            if (done.get()) return;
            // A classified server rejection completes only its request. Invalid
            // framing, connection loss or a stuck written request fail the wire.
            if (connection != null && !(error.code.matches("-?[0-9]+")) && !"RPC_CANCELLED".equals(error.code)) connection.fail(error, false);
            finish(null, error, true);
        }
        JSONObject drain(Frames frames, JSONObject result) throws Exception {
            Object streamId = result.opt("stream_id");
            if (result.length() != 1 || !(streamId instanceof String) || !((String) streamId).matches("[A-Za-z0-9_.-]{1,100}")) throw failure("RPC_PROTOCOL");
            long expected = 0, rows = 0; boolean sawSnapshot = false, sawState = false;
            while (true) {
                check(); JSONObject message = frames.next();
                if (!"2.0".equals(message.opt("jsonrpc")) || message.has("id") || message.length() != 3 || !(message.opt("params") instanceof JSONObject)) throw failure("RPC_PROTOCOL");
                JSONObject details = message.getJSONObject("params");
                if (!streamId.equals(details.opt("stream_id"))) throw failure("RPC_PROTOCOL");
                if ("stream.end".equals(message.opt("method"))) {
                    if (!Boolean.TRUE.equals(details.opt("complete")) || !integerEquals(details.opt("chunks"), expected) || !sawSnapshot || !sawState) throw failure("RPC_STREAM_INCOMPLETE");
                    return new JSONObject().put("stream_id", streamId).put("complete", true).put("chunks", expected);
                }
                if (!"stream.chunk".equals(message.opt("method")) || !integerEquals(details.opt("sequence"), expected++) || !(details.opt("items") instanceof JSONObject)) throw failure("RPC_PROTOCOL");
                JSONObject chunk = details.getJSONObject("items"); String type = chunk.optString("type", "");
                if (sawState || expected > MAX_STREAM_ROWS) throw failure("RPC_PROTOCOL");
                if (!sawSnapshot) {
                    if (!type.equals("snapshot") || !params.getString("block_hash").equals(chunk.opt("block_hash")) || !"connects".equals(chunk.opt("unit")) || !Boolean.TRUE.equals(chunk.opt("live")) || !(chunk.opt("cursor") instanceof String)) throw failure("RPC_PROTOCOL");
                    sawSnapshot = true;
                } else if (type.equals("bounties")) {
                    if (!(chunk.opt("items") instanceof JSONArray) || chunk.getJSONArray("items").length() > 500) throw failure("RPC_PROTOCOL");
                    rows += chunk.getJSONArray("items").length();
                    if (rows > MAX_STREAM_ROWS) throw failure("RPC_STREAM_LIMIT");
                } else if (type.equals("state") && chunk.opt("cursor") instanceof String) { sawState = true; }
                else throw failure("RPC_PROTOCOL");
                if (!(chunk.opt("tip") instanceof JSONObject)) throw failure("RPC_PROTOCOL");
                // Consumers stage private data. Do not hold the lifecycle lock
                // while calling user code: deadlines/cancel must settle even if
                // a faulty consumer blocks one of the bounded workers.
                phase("consumer");
                if (!abandoned) {
                    try { consumer.accept(chunk); }
                    catch (Exception consumerError) {
                        // Consumer lifecycle/data failures are not wire framing
                        // failures. Stop publishing this snapshot, but validate
                        // and drain its remaining frames without harming a
                        // payment or another reader on the shared connection.
                        RpcFailure stopped;
                        synchronized (MobileRpcClient.this) {
                            stopped = detailed(failure(abandoned || consumerError instanceof java.util.concurrent.CancellationException
                                ? "RPC_CANCELLED" : "RPC_PROTOCOL"));
                            abandoned = true;
                        }
                        future.completeExceptionally(stopped);
                    }
                }
                check();
            }
        }
        boolean finish(JSONObject result, RpcFailure error) {
            return finish(result, error, false);
        }
        boolean finish(JSONObject result, RpcFailure error, boolean force) {
            boolean tombstone = false;
            synchronized (MobileRpcClient.this) {
                if (!force && error != null && "RPC_CANCELLED".equals(error.code) && writeAttempted && !done.get() && !closed && active && epoch == generation) {
                    if (future.isDone()) return false;
                    // Keep ID, worker, quota and inbox until the bounded reply/
                    // stream drain completes. A late reply must not poison an
                    // unrelated payment using the same connection.
                    abandoned = true;
                    error = detailed(error); tombstone = true;
                }
                if (!tombstone) {
                    if (!done.compareAndSet(false, true)) return false;
                    if (closed || !active || epoch != generation) { result = null; error = failure("RPC_CANCELLED"); }
                    if (error != null) error = detailed(error);
                    if (error != null && error.code.equals("-32029")) cooldowns.put(method, nowMs() + Math.max(quotaWindowMs, error.retryAfterMs));
                    if (deadline != null) deadline.cancel(false); if (quotaWake != null) quotaWake.cancel(false);
                    if (connection != null) {
                        connection.replies.remove(id);
                        if (streamId != null) connection.streams.remove(streamId);
                    }
                    Inbound inbound; while ((inbound = inbox.poll()) != null) { bufferedFrames--; bufferedBytes -= inbound.bytes; }
                    jobs.remove(this); workers.remove(this);
                }
            }
            boolean published = error == null ? future.complete(result) : future.completeExceptionally(error);
            return !tombstone || published;
        }
        RpcFailure detailed(RpcFailure error) {
            long elapsed = Math.max(0, nowMs() - started);
            long queued = Math.max(0, Math.min(elapsed, queueElapsed + (queueStarted < 0 ? 0 : nowMs() - queueStarted)));
            return new RpcFailure(error.code, error.unknownOutcome || method.equals("sendrawtransaction") && writeAttempted && !error.explicitRejection,
                error.nodeCode, error.retryAfterMs, error.explicitRejection, method, phase, elapsed, queued, bytesReceived,
                error.transportLoss, error.networkSuspended);
        }
    }
    private static boolean integerEquals(Object value, long expected) {
        return (value instanceof Integer || value instanceof Long) && ((Number) value).longValue() == expected;
    }
    private static final class Frames {
        final Job job;
        long total;
        Frames(Job job) { this.job = job; }
        JSONObject next() throws Exception {
            job.phase("read");
            for (;;) {
                job.check(); Inbound frame = job.inbox.poll(Math.min(100, job.remaining()), TimeUnit.MILLISECONDS);
                if (frame == null) continue;
                synchronized (job.owner()) { job.owner().bufferedFrames--; job.owner().bufferedBytes -= frame.bytes; }
                job.check(); total += frame.bytes;
                if (total > MAX_STREAM_BYTES) throw failure("RPC_STREAM_LIMIT");
                job.phase("parse"); return frame.message;
            }
        }
    }
    private static final class WireFrames {
        final InputStream input; final Connection connection; final byte[] buffer = new byte[8192];
        int at, size;
        WireFrames(InputStream input, Connection connection) { this.input = input; this.connection = connection; }
        Inbound next() throws Exception {
            ByteArrayOutputStream frame = new ByteArrayOutputStream(4096);
            while (true) {
                if (at == size) {
                    size = input.read(buffer); at = 0;
                    if (size < 0) throw new java.io.EOFException();
                    connection.received(size);
                }
                int end = at; while (end < size && buffer[end] != '\n') end++;
                int count = end - at;
                if (frame.size() + count > MAX_FRAME) throw failure("RPC_PROTOCOL");
                frame.write(buffer, at, count);
                at = end;
                if (at < size) {
                    at++;
                    String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(frame.toByteArray())).toString();
                    try { return new Inbound(RpcTransport.parseObject(text), frame.size() + 1); }
                    catch (RpcTransport.RpcFailure error) { throw failure("RPC_PROTOCOL"); }
                }
            }
        }
    }
    static JSONObject reply(JSONObject response, String id) throws RpcFailure {
        if (!"2.0".equals(response.opt("jsonrpc")) || !id.equals(response.opt("id")) || response.has("result") == response.has("error") || response.length() != 3) throw failure("RPC_PROTOCOL");
        if (response.has("error")) {
            if (!(response.opt("error") instanceof JSONObject)) throw failure("RPC_PROTOCOL");
            JSONObject remote = response.optJSONObject("error"); Object rawCode = remote.opt("code");
            if (!(rawCode instanceof Integer || rawCode instanceof Long) || ((Number) rawCode).longValue() < Integer.MIN_VALUE || ((Number) rawCode).longValue() > Integer.MAX_VALUE) throw failure("RPC_PROTOCOL");
            String code = String.valueOf(((Number) rawCode).longValue());
            JSONObject data = remote.optJSONObject("data"); Integer nodeCode = null; long retry = 0;
            if (data != null) {
                Object node = data.opt("node_code"), delay = data.opt("retry_after_ms");
                if ((node instanceof Integer || node instanceof Long) && Arrays.asList(-22L, -25L, -26L, -27L, -8L).contains(((Number) node).longValue())) nodeCode = ((Number) node).intValue();
                if ((delay instanceof Integer || delay instanceof Long) && ((Number) delay).longValue() > 0) retry = Math.min(60000, ((Number) delay).longValue());
            }
            throw new RpcFailure(code, false, nodeCode, retry, code.equals("-32020") && nodeCode != null);
        }
        Object result = response.opt("result");
        if (!(result instanceof JSONObject)) throw failure("RPC_PROTOCOL");
        return (JSONObject) result;
    }
    private static void closeSocket(Socket socket) { if (socket != null) try { socket.close(); } catch (IOException ignored) {} }
    private static RpcFailure failure(String code) { return new RpcFailure(code, false, null, 0, false); }
    private static String message(String code) {
        switch (code) {
            case "RPC_INVALID": return "Unsupported native RPC method or invalid public parameters.";
            case "RPC_BUSY": return "The bounded native RPC queue is full.";
            case "RPC_INACTIVE": return "The native RPC engine is inactive.";
            case "RPC_CANCELLED": return "The native RPC operation was cancelled.";
            case "RPC_TIMEOUT": return "The native RPC operation timed out.";
            case "RPC_UNAVAILABLE": return "The native RPC endpoint is unavailable.";
            case "RPC_STREAM_LIMIT": return "The bounty snapshot exceeded the mobile resource limit; no complete snapshot was received.";
            case "RPC_STREAM_INCOMPLETE": return "The bounty snapshot was incomplete; discard its staged chunks.";
            case "-32029": return "RPC rate limit reached. Retry later.";
            default: return "The native RPC request failed or returned an invalid response.";
        }
    }
}
