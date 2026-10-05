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
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native-only TLS NDJSON client. No Capacitor annotation or JavaScript bridge.
 * Two socket workers, eight waiting operations, strict schemas and no retries.
 * Subscriptions are deliberately NOT implemented: callers poll bounded deltas.
 * A bounty consumer must stage chunks privately until the future succeeds;
 * cancellation, EOF, malformed/incomplete streams never publish partial success.
 */
public final class MobileRpcClient implements AutoCloseable {
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
    public static final class TlsEndpoint {
        public final String hostname;
        public final int port;
        public TlsEndpoint(String hostname, int port) { this(hostname, port, false); }
        private TlsEndpoint(String hostname, int port, boolean localFixture) {
            if (hostname == null || hostname.length() > 253 || port < 1 || port > 65535 ||
                !hostname.matches("[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?")) throw new IllegalArgumentException("Invalid pinned TLS endpoint");
            String name = hostname.toLowerCase(Locale.ROOT);
            for (String label : name.split("\\.", -1)) if (label.length() < 1 || label.length() > 63 || label.startsWith("-") || label.endsWith("-")) throw new IllegalArgumentException("Invalid pinned TLS hostname");
            if (!localFixture && (!name.contains(".") || name.matches("[0-9.]+") || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal"))) {
                throw new IllegalArgumentException("A public DNS hostname is required for the TLS endpoint");
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
        private final boolean explicitRejection;
        private RpcFailure(String code, boolean unknownOutcome, Integer nodeCode, long retryAfterMs, boolean explicitRejection) {
            super(unknownOutcome ? "Broadcast outcome is unknown. Check its transaction ID before retrying." : message(code));
            this.code = code; this.unknownOutcome = unknownOutcome; this.nodeCode = nodeCode;
            this.retryAfterMs = retryAfterMs; this.explicitRejection = explicitRejection;
        }
    }
    public interface ChunkConsumer { void accept(JSONObject chunk) throws Exception; }
    interface Resolver { InetAddress[] resolve(String hostname) throws IOException; }
    private final TlsEndpoint endpoint;
    private final SSLSocketFactory socketFactory;
    private final Resolver resolver;
    private final boolean localFixture;
    private final int requestTimeoutMs, streamTimeoutMs;
    private final ThreadPoolExecutor workers;
    private final ScheduledThreadPoolExecutor deadlines;
    private final Set<Job> jobs = new HashSet<>();
    private final Map<String, ArrayDeque<Long>> history = new HashMap<>();
    private final Map<String, Long> cooldowns = new HashMap<>();
    private long generation, sequence;
    private boolean active, closed;

    public MobileRpcClient(TlsEndpoint endpoint) {
        this(endpoint, (SSLSocketFactory) SSLSocketFactory.getDefault(), InetAddress::getAllByName, false, 40000, 120000);
    }
    // Explicit package-private fixture seam, never callable through Capacitor.
    static MobileRpcClient localTestClient(String hostname, int port, SSLSocketFactory trustedFixtureFactory,
        Resolver resolver, int timeoutMs) {
        return new MobileRpcClient(new TlsEndpoint(hostname, port, true), trustedFixtureFactory, resolver, true, timeoutMs, timeoutMs);
    }
    private MobileRpcClient(TlsEndpoint endpoint, SSLSocketFactory factory, Resolver resolver, boolean localFixture,
        int requestTimeoutMs, int streamTimeoutMs) {
        if (endpoint == null || factory == null || resolver == null || requestTimeoutMs < 1 || requestTimeoutMs > 40000 || streamTimeoutMs < 1 || streamTimeoutMs > 120000) throw new IllegalArgumentException("Invalid TLS transport settings");
        this.endpoint = endpoint; this.socketFactory = factory; this.resolver = resolver; this.localFixture = localFixture;
        this.requestTimeoutMs = requestTimeoutMs; this.streamTimeoutMs = streamTimeoutMs;
        ThreadFactory threads = runnable -> { Thread thread = new Thread(runnable, "connectwallet-native-tls-rpc"); thread.setDaemon(true); return thread; };
        workers = new ThreadPoolExecutor(2, 2, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8), threads, new ThreadPoolExecutor.AbortPolicy());
        deadlines = new ScheduledThreadPoolExecutor(1, threads); deadlines.setRemoveOnCancelPolicy(true);
    }

    /** The native engine decides foreground/background policy; inactive initially. */
    public void setActive(boolean enabled) {
        ArrayList<Job> cancelled = null;
        synchronized (this) {
            if (closed) return; active = enabled;
            if (!enabled) { generation++; cancelled = new ArrayList<>(jobs); workers.getQueue().clear(); }
        }
        // A concurrent resume must not have its newly queued jobs cancelled.
        if (cancelled != null) for (Job job : cancelled) job.finish(null, failure("RPC_CANCELLED"));
    }
    public void cancelAll() {
        ArrayList<Job> cancelled;
        synchronized (this) { generation++; cancelled = new ArrayList<>(jobs); workers.getQueue().clear(); }
        for (Job job : cancelled) job.finish(null, failure("RPC_CANCELLED"));
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
        synchronized (this) {
            if (closed || !active) return failed(failure(closed ? "RPC_CANCELLED" : "RPC_INACTIVE"));
            if (jobs.size() >= 10 || sequence == Long.MAX_VALUE) return failed(failure("RPC_BUSY"));
            Job job = new Job(method, clean, "mobile-native-" + (++sequence), generation, consumer);
            jobs.add(job);
            try {
                job.deadline = deadlines.schedule(() -> job.finish(null, failure("RPC_TIMEOUT")), job.timeoutMs, TimeUnit.MILLISECONDS);
                workers.execute(job);
            } catch (RejectedExecutionException error) { job.finish(null, failure("RPC_BUSY")); }
            return job.future;
        }
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
    private void consumeQuota(Job job) throws RpcFailure, JSONException {
        synchronized (this) {
            job.check(); long now = nowMs();
            if (cooldowns.getOrDefault(job.method, 0L) > now) throw failure("-32029");
            // Reclaim old block-specific quota keys; never let attacker-selected
            // block hashes grow the per-client limiter without a bound.
            Iterator<Map.Entry<String, ArrayDeque<Long>>> entries = history.entrySet().iterator();
            while (entries.hasNext()) {
                ArrayDeque<Long> times = entries.next().getValue();
                while (!times.isEmpty() && now - times.peekFirst() >= WINDOW_MS) times.removeFirst();
                if (times.isEmpty()) entries.remove();
            }
            String key = quotaKey(job.method, job.params);
            if (!history.containsKey(key) && history.size() >= 1024) throw failure("RPC_BUSY");
            ArrayDeque<Long> times = history.computeIfAbsent(key, unused -> new ArrayDeque<>());
            int limit = job.method.equals("gettransactions") ? 6 : job.method.equals("getblockbounties") ? 8 : 48;
            if (times.size() >= limit) throw failure("-32029");
            if (job.method.equals("getblockbounties")) {
                ArrayDeque<Long> overall = history.computeIfAbsent(job.method, unused -> new ArrayDeque<>());
                if (overall.size() >= 48) throw failure("-32029");
                overall.addLast(now);
            }
            times.addLast(now);
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
        volatile Socket socket;
        volatile ScheduledFuture<?> deadline;
        boolean writeAttempted;
        Job(String method, JSONObject params, String id, long epoch, ChunkConsumer consumer) {
            this.method = method; this.params = params; this.id = id; this.epoch = epoch; this.consumer = consumer;
            timeoutMs = consumer == null ? requestTimeoutMs : streamTimeoutMs;
        }
        void check() throws RpcFailure {
            synchronized (MobileRpcClient.this) {
                if (done.get() || closed || !active || generation != epoch) throw failure("RPC_CANCELLED");
                if (nowMs() - started >= timeoutMs) throw failure("RPC_TIMEOUT");
            }
        }
        int remaining() throws RpcFailure { check(); return (int) Math.max(1, timeoutMs - (nowMs() - started)); }
        @Override public void run() {
            try {
                check();
                Socket raw = new Socket();
                synchronized (MobileRpcClient.this) { socket = raw; check(); }
                InetAddress[] addresses = resolver.resolve(endpoint.hostname); check();
                if (addresses == null || addresses.length == 0 || (!localFixture && !publicAddress(addresses[0]))) throw failure("RPC_UNAVAILABLE");
                raw.connect(new InetSocketAddress(addresses[0], endpoint.port), Math.min(8000, remaining()));
                raw.setTcpNoDelay(true); raw.setSoTimeout(remaining());
                SSLSocket tls = (SSLSocket) socketFactory.createSocket(raw, endpoint.hostname, endpoint.port, true);
                synchronized (MobileRpcClient.this) { socket = tls; check(); }
                SSLParameters settings = tls.getSSLParameters();
                settings.setEndpointIdentificationAlgorithm("HTTPS");
                settings.setServerNames(Collections.singletonList(new SNIHostName(endpoint.hostname)));
                ArrayList<String> protocols = new ArrayList<>();
                for (String supported : tls.getSupportedProtocols()) if (supported.equals("TLSv1.3") || supported.equals("TLSv1.2")) protocols.add(supported);
                if (protocols.isEmpty()) throw failure("RPC_TLS");
                settings.setProtocols(protocols.toArray(new String[0])); tls.setSSLParameters(settings);
                tls.setSoTimeout(remaining()); tls.startHandshake(); check();
                JSONObject request = new JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params);
                byte[] bytes = (request + "\n").getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 1024 * 1024) throw failure("RPC_INVALID");
                consumeQuota(this);
                synchronized (MobileRpcClient.this) { check(); writeAttempted = true; }
                tls.getOutputStream().write(bytes); tls.getOutputStream().flush();
                Frames frames = new Frames(tls.getInputStream(), this);
                JSONObject result = reply(frames.next(), id);
                if (consumer != null) result = drain(frames, result);
                if (method.equals("sendrawtransaction")) {
                    if (result.length() != 1 || !(result.opt("txid") instanceof String) || !((String) result.opt("txid")).matches(HASH)) throw failure("RPC_PROTOCOL");
                }
                check(); finish(result, null);
            } catch (RpcFailure error) { finish(null, error); }
            catch (SSLException error) { finish(null, failure("RPC_TLS")); }
            catch (java.net.SocketTimeoutException error) { finish(null, failure("RPC_TIMEOUT")); }
            catch (java.nio.charset.CharacterCodingException error) { finish(null, failure("RPC_PROTOCOL")); }
            catch (IOException error) { finish(null, failure("RPC_UNAVAILABLE")); }
            catch (Exception error) { finish(null, failure("RPC_PROTOCOL")); }
            finally { closeSocket(socket); }
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
                // a faulty consumer blocks one of the two bounded workers.
                check(); consumer.accept(chunk); check();
            }
        }
        boolean finish(JSONObject result, RpcFailure error) {
            synchronized (MobileRpcClient.this) {
                if (!done.compareAndSet(false, true)) return false;
                if (closed || !active || epoch != generation) { result = null; error = failure("RPC_CANCELLED"); }
                if (error != null && method.equals("sendrawtransaction") && writeAttempted && !error.explicitRejection) {
                    error = new RpcFailure(error.code, true, error.nodeCode, error.retryAfterMs, false);
                }
                if (error != null && error.code.equals("-32029")) cooldowns.put(method, nowMs() + Math.max(WINDOW_MS, error.retryAfterMs));
                closeSocket(socket); if (deadline != null) deadline.cancel(false);
                jobs.remove(this); workers.remove(this);
            }
            if (error == null) future.complete(result); else future.completeExceptionally(error);
            return true;
        }
    }
    private static boolean integerEquals(Object value, long expected) {
        return (value instanceof Integer || value instanceof Long) && ((Number) value).longValue() == expected;
    }
    private static final class Frames {
        final InputStream input; final Job job; final byte[] buffer = new byte[8192];
        int at, size; long total;
        Frames(InputStream input, Job job) { this.input = input; this.job = job; }
        JSONObject next() throws Exception {
            ByteArrayOutputStream frame = new ByteArrayOutputStream(4096);
            while (true) {
                job.check();
                if (at == size) {
                    job.socket.setSoTimeout(job.remaining()); size = input.read(buffer); at = 0;
                    if (size < 0) throw failure(job.consumer == null ? "RPC_PROTOCOL" : "RPC_STREAM_INCOMPLETE");
                }
                int end = at; while (end < size && buffer[end] != '\n') end++;
                int count = end - at;
                if (frame.size() + count > MAX_FRAME) throw failure("RPC_PROTOCOL");
                frame.write(buffer, at, count); total += count;
                if (total > MAX_STREAM_BYTES) throw failure("RPC_STREAM_LIMIT");
                at = end;
                if (at < size) {
                    at++; total++;
                    String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(frame.toByteArray())).toString();
                    try { return RpcTransport.parseObject(text); }
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
            case "RPC_TLS": return "The RPC server could not be authenticated with TLS.";
            case "RPC_UNAVAILABLE": return "The native RPC endpoint is unavailable.";
            case "RPC_STREAM_LIMIT": return "The bounty snapshot exceeded the mobile resource limit; no complete snapshot was received.";
            case "RPC_STREAM_INCOMPLETE": return "The bounty snapshot was incomplete; discard its staged chunks.";
            case "-32029": return "RPC rate limit reached. Retry later.";
            default: return "The native RPC request failed or returned an invalid response.";
        }
    }
}
