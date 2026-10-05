package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Bounded foreground-only, plaintext TCP reader for the existing public API.
 * No retries, wallet secrets, arbitrary endpoints, subscriptions or writes.
 * Java DNS is not reliably interruptible: the deadline still rejects the call,
 * and at most two fixed workers can remain in the OS resolver until it returns.
 */
public final class RpcTransport implements AutoCloseable {
    static final int MAX_FRAME = 2 * 1024 * 1024;
    private static final long WINDOW_MS = 60000;
    private static final int QUOTA = 48;
    private final String host;
    private final int port, timeoutMs;
    private final Resolver resolver;
    private final ThreadPoolExecutor workers;
    private final ScheduledThreadPoolExecutor deadlines;
    private final Set<Job> jobs = new HashSet<>();
    private final Map<String, ArrayDeque<Long>> history = new HashMap<>();
    private final Map<String, Long> cooldowns = new HashMap<>();
    private long generation, sequence;
    private boolean foreground, closed;

    public interface Callback { void complete(JSONObject result, RpcFailure error); }
    interface Resolver { InetAddress[] resolve(String hostname) throws IOException; }
    public static final class RpcFailure extends Exception {
        private static final long serialVersionUID = 1L;
        public final String code;
        private final boolean remote;
        RpcFailure(String code, String message) { this(code, message, false); }
        RpcFailure(String code, String message, boolean remote) { super(message); this.code = code; this.remote = remote; }
    }

    public RpcTransport() { this("connectcoin4.com", 48190, 40000, InetAddress::getAllByName); }

    // Package-private test seam; never receives bridge-controlled values.
    RpcTransport(String host, int port, int timeoutMs, Resolver resolver) {
        if (host == null || host.length() > 253 || port < 1 || port > 65535 || timeoutMs < 1 || timeoutMs > 40000 || resolver == null) {
            throw new IllegalArgumentException("Invalid transport settings");
        }
        this.host = host; this.port = port; this.timeoutMs = timeoutMs; this.resolver = resolver;
        ThreadFactory threads = runnable -> {
            Thread thread = new Thread(runnable, "connectwallet-public-rpc");
            thread.setDaemon(true); return thread;
        };
        workers = new ThreadPoolExecutor(2, 2, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8), threads,
            new ThreadPoolExecutor.AbortPolicy());
        deadlines = new ScheduledThreadPoolExecutor(1, threads);
        deadlines.setRemoveOnCancelPolicy(true);
    }

    public synchronized void setForeground(boolean active) {
        if (closed) return;
        foreground = active;
        if (!active) cancelAll();
    }

    public synchronized void cancelAll() {
        generation++;
        for (Job job : new ArrayList<>(jobs)) job.finish(null, failure("RPC_CANCELLED"));
        // Remove cancelled queued work; running DNS tasks cannot be force-killed.
        workers.getQueue().clear();
    }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true; foreground = false; cancelAll();
        workers.shutdownNow(); deadlines.shutdownNow();
    }

    public void query(String method, JSONObject params, Callback callback) {
        JSONObject clean;
        try { clean = validateParams(method, params); }
        catch (RpcFailure error) { callback.complete(null, error); return; }
        synchronized (this) {
            if (closed || !foreground) { callback.complete(null, failure(closed ? "RPC_CANCELLED" : "RPC_BACKGROUND")); return; }
            if (jobs.size() >= 10 || sequence == Long.MAX_VALUE) { callback.complete(null, failure("RPC_BUSY")); return; }
            Job job = new Job(method, clean, "mobile-" + (++sequence), generation, callback);
            jobs.add(job);
            try {
                job.deadline = deadlines.schedule(() -> job.finish(null, failure("RPC_TIMEOUT")), timeoutMs, TimeUnit.MILLISECONDS);
                workers.execute(job);
            } catch (RejectedExecutionException error) { job.finish(null, failure("RPC_BUSY")); }
        }
    }

    static JSONObject validateParams(String method, JSONObject params) throws RpcFailure {
        if (params == null || !("getchaintip".equals(method) || "getaddressbalance".equals(method) || "getaddresshistory".equals(method))) {
            throw failure("RPC_INVALID");
        }
        JSONObject clean = new JSONObject();
        Iterator<String> keys = params.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!(key.equals("address") && !method.equals("getchaintip")) && !(key.equals("cursor") && method.equals("getaddresshistory"))) {
                throw failure("RPC_INVALID");
            }
        }
        try {
            if (!method.equals("getchaintip")) {
                Object address = params.opt("address");
                if (!(address instanceof String) || !((String) address).matches("cc1p[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}")) throw failure("RPC_INVALID");
                clean.put("address", address);
            }
            if (params.has("cursor")) {
                Object cursor = params.opt("cursor");
                if (cursor != JSONObject.NULL && (!(cursor instanceof String) || ((String) cursor).length() > 1024 || !((String) cursor).matches("[A-Za-z0-9_.-]+"))) {
                    throw failure("RPC_INVALID");
                }
                clean.put("cursor", cursor);
            }
        } catch (JSONException error) { throw failure("RPC_INVALID"); }
        return clean;
    }

    private static long nowMs() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()); }

    private void consumeQuota(Job job) throws RpcFailure {
        synchronized (this) {
            job.check();
            long now = nowMs();
            if (cooldowns.getOrDefault(job.method, 0L) > now) throw failure("-32029");
            ArrayDeque<Long> times = history.computeIfAbsent(job.method, unused -> new ArrayDeque<>());
            while (!times.isEmpty() && now - times.peekFirst() >= WINDOW_MS) times.removeFirst();
            if (times.size() >= QUOTA) throw failure("-32029");
            times.addLast(now);
        }
    }

    private final class Job implements Runnable {
        final String method, id;
        final JSONObject params;
        final long epoch, started = nowMs();
        final Callback callback;
        final AtomicBoolean done = new AtomicBoolean();
        volatile Socket socket;
        volatile ScheduledFuture<?> deadline;
        Job(String method, JSONObject params, String id, long epoch, Callback callback) {
            this.method = method; this.params = params; this.id = id; this.epoch = epoch; this.callback = callback;
        }
        void check() throws RpcFailure {
            synchronized (RpcTransport.this) {
                if (done.get() || closed || epoch != generation || !foreground) throw failure("RPC_CANCELLED");
                if (nowMs() - started >= timeoutMs) throw failure("RPC_TIMEOUT");
            }
        }
        int remaining() throws RpcFailure { check(); return (int) Math.max(1, timeoutMs - (nowMs() - started)); }
        @Override public void run() {
            try {
                check();
                Socket connection = new Socket();
                synchronized (RpcTransport.this) { socket = connection; check(); }
                InetAddress[] addresses = resolver.resolve(host);
                check();
                if (addresses == null || addresses.length == 0) throw failure("RPC_UNAVAILABLE");
                connection.connect(new InetSocketAddress(addresses[0], port), Math.min(8000, remaining()));
                connection.setTcpNoDelay(true);
                JSONObject request = new JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params);
                byte[] encoded = (request.toString() + "\n").getBytes(StandardCharsets.UTF_8);
                consumeQuota(this); check();
                connection.getOutputStream().write(encoded);
                connection.getOutputStream().flush();
                ByteArrayOutputStream frame = new ByteArrayOutputStream(4096);
                BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
                byte[] chunk = new byte[8192];
                boolean complete = false;
                while (!complete) {
                    connection.setSoTimeout(remaining());
                    int count = input.read(chunk);
                    if (count == -1) throw failure("RPC_PROTOCOL");
                    int size = 0;
                    while (size < count && chunk[size] != '\n') size++;
                    if (frame.size() + size > MAX_FRAME) throw failure("RPC_PROTOCOL");
                    frame.write(chunk, 0, size);
                    complete = size < count;
                }
                String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(frame.toByteArray())).toString();
                check();
                JSONObject result = parseReply(text, id);
                finish(result, null);
            } catch (RpcFailure error) {
                if (error.remote && error.code.equals("-32029")) synchronized (RpcTransport.this) {
                    if (!done.get() && epoch == generation) cooldowns.put(method, nowMs() + WINDOW_MS);
                }
                finish(null, error);
            } catch (java.net.SocketTimeoutException error) { finish(null, failure("RPC_TIMEOUT")); }
            catch (java.nio.charset.CharacterCodingException error) { finish(null, failure("RPC_PROTOCOL")); }
            catch (IOException error) { finish(null, failure("RPC_UNAVAILABLE")); }
            catch (Exception error) { finish(null, failure("RPC_PROTOCOL")); }
            finally { closeSocket(socket); }
        }
        void finish(JSONObject result, RpcFailure error) {
            if (!done.compareAndSet(false, true)) return;
            closeSocket(socket);
            if (deadline != null) deadline.cancel(false);
            synchronized (RpcTransport.this) {
                jobs.remove(this); workers.remove(this);
                if (epoch != generation || closed || !foreground) { result = null; error = failure("RPC_CANCELLED"); }
                // Serialized with lifecycle changes: no stale success can be delivered after pause/cancel.
                try { callback.complete(result, error); } catch (RuntimeException ignored) { /* A bridge failure must not kill workers. */ }
            }
        }
    }

    private static void closeSocket(Socket socket) { if (socket != null) try { socket.close(); } catch (IOException ignored) {} }

    static JSONObject parseReply(String text, String id) throws RpcFailure {
            JSONObject response = parseObject(text);
            if (!"2.0".equals(response.opt("jsonrpc")) || !(response.opt("id") instanceof String) || !id.equals(response.opt("id")) || response.has("result") == response.has("error")) throw failure("RPC_PROTOCOL");
            if (response.has("error")) {
                Object error = response.opt("error");
                if (!(error instanceof JSONObject)) throw failure("RPC_PROTOCOL");
                Object code = ((JSONObject) error).opt("code");
                if (!(code instanceof Integer || code instanceof Long) || ((Number) code).longValue() < Integer.MIN_VALUE || ((Number) code).longValue() > Integer.MAX_VALUE) throw failure("RPC_PROTOCOL");
                String value = String.valueOf(((Number) code).longValue());
                throw new RpcFailure(value, value.equals("-32029") ? "RPC rate limit reached. Try again in one minute." : "The RPC server rejected the request.", true);
            }
            Object result = response.opt("result");
            if (!(result instanceof JSONObject)) throw failure("RPC_PROTOCOL");
            return (JSONObject) result;
    }

    // Shared syntax validation only. The native TLS client has its own broader
    // method allowlist; the public read-only bridge above remains unchanged.
    static JSONObject parseObject(String text) throws RpcFailure {
        try { new JsonSyntax(text).validate(); return new JSONObject(text); }
        catch (JSONException error) { throw failure("RPC_PROTOCOL"); }
    }

    private static RpcFailure failure(String code) {
        String message;
        switch (code) {
            case "RPC_INVALID": message = "Only supported public read-only requests are allowed."; break;
            case "RPC_BUSY": message = "Too many requests are in progress. Try again shortly."; break;
            case "RPC_BACKGROUND": message = "Open the app to refresh public wallet data."; break;
            case "RPC_CANCELLED": message = "The RPC request was cancelled."; break;
            case "RPC_TIMEOUT": message = "The RPC request timed out. Try again."; break;
            case "RPC_UNAVAILABLE": message = "The RPC connection is unavailable. Check your connection."; break;
            case "-32029": message = "RPC rate limit reached. Try again in one minute."; break;
            default: message = "The RPC server returned an invalid response.";
        }
        return new RpcFailure(code, message);
    }

    /** org.json is intentionally permissive; reject non-JSON/duplicates and bound nesting first. */
    private static final class JsonSyntax {
        final String text; int at;
        JsonSyntax(String text) { this.text = text; }
        void validate() throws RpcFailure { value(0); space(); if (at != text.length()) bad(); }
        void space() { while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) at++; }
        void bad() throws RpcFailure { throw failure("RPC_PROTOCOL"); }
        boolean take(char c) { space(); if (at < text.length() && text.charAt(at) == c) { at++; return true; } return false; }
        void value(int depth) throws RpcFailure {
            if (depth > 64) bad();
            space(); if (at >= text.length()) bad();
            char c = text.charAt(at);
            if (c == '"') { string(); return; }
            if (take('{')) {
                Set<String> keys = new HashSet<>();
                if (take('}')) return;
                do { space(); String key = string(); if (!keys.add(key) || !take(':')) bad(); value(depth + 1); } while (take(','));
                if (!take('}')) bad(); return;
            }
            if (take('[')) {
                if (take(']')) return;
                do { value(depth + 1); } while (take(','));
                if (!take(']')) bad(); return;
            }
            int start = at;
            while (at < text.length() && ",]} \t\r\n".indexOf(text.charAt(at)) < 0) at++;
            String token = text.substring(start, at);
            if (token.length() > 64 || !(token.equals("true") || token.equals("false") || token.equals("null") || token.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?"))) bad();
        }
        String string() throws RpcFailure {
            int start = at;
            if (at >= text.length() || text.charAt(at++) != '"') { bad(); return null; }
            while (at < text.length()) {
                char c = text.charAt(at++);
                if (c == '"') {
                    try { return (String) new JSONTokener(text.substring(start, at)).nextValue(); }
                    catch (JSONException error) { bad(); }
                }
                if (c < 0x20) bad();
                if (c == '\\') {
                    if (at >= text.length()) bad();
                    char escape = text.charAt(at++);
                    if (escape == 'u') {
                        for (int i = 0; i < 4; i++) if (at >= text.length() || "0123456789abcdefABCDEF".indexOf(text.charAt(at++)) < 0) bad();
                    } else if ("\"\\/bfnrt".indexOf(escape) < 0) bad();
                }
            }
            bad(); return null;
        }
    }
}
