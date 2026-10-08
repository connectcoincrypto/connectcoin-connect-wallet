package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentChecks;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Future;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.json.JSONObject;

/**
 * Dedicated native public-address and chain-tip channel. Notifications are hints only:
 * callers fetch/validate fresh balances through the existing query transport.
 * No balances, transaction bytes, secrets or endpoint selection cross this API.
 * One socket worker and one bounded DNS worker never occupy payment/claim workers.
 * Plaintext server metadata is not independent full-node verification.
 */
public final class MobileWalletSubscriptions implements AutoCloseable {
    public interface Listener { void changed(Event event); }
    /** Validated, bounded public metadata; never carries balances or raw RPC envelopes. */
    public static final class Event {
        final String address, reason;
        final JSONObject tip;
        final List<String> changedAddresses;
        final boolean reorg, resyncRequired, coverageLimited;
        final int watched, total;
        final long epoch, connection;
        Event(String address, String reason, JSONObject tip, boolean reorg, boolean resyncRequired, long epoch, long connection) {
            this(address, reason, tip, reorg, resyncRequired, epoch, connection,
                "address".equals(reason) ? List.of(address) : List.of(), 1, 1);
        }
        Event(String address, String reason, JSONObject tip, boolean reorg, boolean resyncRequired, long epoch, long connection,
                List<String> changedAddresses, int watched, int total) {
            this.address = address; this.reason = reason; this.tip = tip;
            LinkedHashSet<String> changes = new LinkedHashSet<>();
            boolean overflow = false;
            for (String changed : changedAddresses) {
                if (changes.contains(changed)) continue;
                if (changes.size() == MAX_WATCHED_ADDRESSES) { overflow = true; break; }
                changes.add(changed);
            }
            this.changedAddresses = List.copyOf(changes);
            this.reorg = reorg; this.resyncRequired = resyncRequired || overflow;
            this.epoch = epoch; this.connection = connection;
            this.watched = watched; this.total = total;
            this.coverageLimited = "disconnected".equals(reason) ? total > MAX_WATCHED_ADDRESSES : watched < total;
        }
        /** Coalesce without letting an ordinary tip erase an address/catch-up/reset hint. */
        static Event merge(Event previous, Event next) {
            if (previous == null || previous.epoch != next.epoch || previous.connection != next.connection ||
                    !previous.address.equals(next.address) || "disconnected".equals(next.reason) || "disconnected".equals(previous.reason)) return next;
            String reason = "connected".equals(previous.reason) || "connected".equals(next.reason) ? "connected" :
                "address".equals(previous.reason) || "address".equals(next.reason) ? "address" : "tip";
            // Protect even an unflagged rollback followed immediately by another
            // tip before Android's main thread drains the pending hint.
            boolean rollback = previous.tip != null && next.tip != null &&
                (next.tip.optLong("height") < previous.tip.optLong("height") ||
                 next.tip.optLong("height") == previous.tip.optLong("height") && !next.tip.optString("hash").equals(previous.tip.optString("hash")));
            ArrayList<String> changes = new ArrayList<>(previous.changedAddresses); changes.addAll(next.changedAddresses);
            return new Event(next.address, reason, next.tip, previous.reorg || next.reorg || rollback,
                previous.resyncRequired || next.resyncRequired, next.epoch, next.connection, changes, next.watched, next.total);
        }
    }
    interface Resolver { InetAddress[] resolve(String hostname) throws IOException; }
    static final int MAX_FRAME = 16 * 1024;
    /** The server's default per-IP budget is 100 subscriptions; reserve one for the tip. */
    public static final int MAX_WATCHED_ADDRESSES = 99;
    private static final int MAX_OWNED_ADDRESSES = 10000;
    private final Listener listener;
    private final Resolver resolver;
    private final String host;
    private final int port, requestMs, heartbeatMs, retryBaseMs, retryMaxMs, quotaMs;
    private final boolean fixture;
    private final Thread worker;
    private final ThreadPoolExecutor dns;
    private String address;
    private List<String> addresses = List.of();
    private List<String> configuredAddresses = List.of();
    private int requestedCount, watchedCount;
    private boolean active, closed, connected;
    private long generation, connectionGeneration, retryAt, quotaUntil;
    private Socket socket;

    public MobileWalletSubscriptions(Listener listener) {
        this(listener, new MobileRpcClient.TcpEndpoint("connectcoin4.com", 48190));
    }
    /** Native settings supply the same validated endpoint as the bounded query client. */
    public MobileWalletSubscriptions(Listener listener, MobileRpcClient.TcpEndpoint endpoint) {
        this(listener, requireEndpoint(endpoint).hostname, endpoint.port, InetAddress::getAllByName,
            false, 15000, 60000, 1000, 60000, 60000);
    }
    private static MobileRpcClient.TcpEndpoint requireEndpoint(MobileRpcClient.TcpEndpoint endpoint) {
        if (endpoint == null) throw new IllegalArgumentException("Missing subscription endpoint");
        // Revalidate so the loopback-only transport test seam cannot escape here.
        return new MobileRpcClient.TcpEndpoint(endpoint.hostname, endpoint.port);
    }
    // Package-private deterministic loopback seam, never a Capacitor method.
    static MobileWalletSubscriptions localTestClient(Listener listener, int port, Resolver resolver,
            int requestMs, int heartbeatMs, int retryBaseMs, int retryMaxMs, int quotaMs) {
        return new MobileWalletSubscriptions(listener, "localhost", port, resolver, true,
            requestMs, heartbeatMs, retryBaseMs, retryMaxMs, quotaMs);
    }
    static MobileWalletSubscriptions localTestClient(Listener listener, MobileRpcClient.TcpEndpoint endpoint, Resolver resolver) {
        return new MobileWalletSubscriptions(listener, requireEndpoint(endpoint).hostname, endpoint.port, resolver, true,
            500, 1000, 500, 500, 500);
    }
    private MobileWalletSubscriptions(Listener listener, String host, int port, Resolver resolver, boolean fixture,
            int requestMs, int heartbeatMs, int retryBaseMs, int retryMaxMs, int quotaMs) {
        if (listener == null || resolver == null || port < 1 || port > 65535 || requestMs < 1 || heartbeatMs < 1 ||
                retryBaseMs < 1 || retryMaxMs < retryBaseMs || quotaMs < retryMaxMs) throw new IllegalArgumentException("Invalid subscription settings");
        this.listener = listener; this.host = host; this.port = port; this.resolver = resolver; this.fixture = fixture;
        this.requestMs = requestMs; this.heartbeatMs = heartbeatMs; this.retryBaseMs = retryBaseMs; this.retryMaxMs = retryMaxMs; this.quotaMs = quotaMs;
        dns = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new SynchronousQueue<>(), runnable -> daemon(runnable, "connectwallet-subscription-dns"));
        worker = daemon(this::run, "connectwallet-wallet-subscriptions"); worker.start();
    }
    private static Thread daemon(Runnable runnable, String name) { Thread thread = new Thread(runnable, name); thread.setDaemon(true); return thread; }
    private static long now() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()); }

    /** Idempotent and nonblocking; native lifecycle supplies the wallet's own address. */
    public void configure(String ownAddress, boolean enabled) {
        configure(ownAddress, ownAddress == null || ownAddress.isEmpty() ? List.of() : List.of(ownAddress), enabled);
    }
    /** Native-owned HD addresses only; the stable identity is independent of the notified address. */
    public void configure(String walletId, List<String> ownAddresses, boolean enabled) {
        synchronized (this) {
            if (closed || enabled && active && java.util.Objects.equals(address, walletId)
                    && configuredAddresses.equals(ownAddresses)) return;
        }
        String next = null;
        List<String> nextAddresses = List.of(), nextInventory = List.of(); int nextCount = 0;
        if (enabled && walletId != null && !walletId.isEmpty()) {
            WalletCrypto.decodeAddress(walletId); next = walletId.toLowerCase(Locale.ROOT);
            if (ownAddresses == null || ownAddresses.isEmpty() || ownAddresses.size() > MAX_OWNED_ADDRESSES) {
                throw new IllegalArgumentException("Invalid native address inventory");
            }
            LinkedHashSet<String> unique = new LinkedHashSet<>();
            for (String own : ownAddresses) {
                WalletCrypto.decodeAddress(own); unique.add(own.toLowerCase(Locale.ROOT));
            }
            if (!unique.contains(next)) throw new IllegalArgumentException("Wallet identity is not owned");
            nextCount = unique.size();
            nextInventory = List.copyOf(unique);
            ArrayList<String> selected = new ArrayList<>(MAX_WATCHED_ADDRESSES);
            for (String own : unique) { if (selected.size() == MAX_WATCHED_ADDRESSES) break; selected.add(own); }
            nextAddresses = List.copyOf(selected);
        }
        Socket previous;
        synchronized (this) {
            if (closed) return;
            configuredAddresses = nextInventory;
            if (active == (next != null) && java.util.Objects.equals(address, next)
                    && addresses.equals(nextAddresses) && requestedCount == nextCount) return;
            address = next; addresses = nextAddresses; requestedCount = nextCount; watchedCount = 0;
            active = next != null; connected = false; generation++; retryAt = 0;
            previous = socket; socket = null; notifyAll();
        }
        closeSocket(previous);
    }
    /** Registration state only; this does not certify any balance or server. */
    public synchronized boolean isConnected(String ownAddress) {
        return !closed && active && connected && address != null && address.equals(ownAddress);
    }
    public synchronized boolean isCoverageLimited(String walletId) {
        return !closed && active && address != null && address.equals(walletId)
            && (connected ? watchedCount : addresses.size()) < requestedCount;
    }
    public synchronized int watchedAddressCount(String walletId) { return isConnected(walletId) ? watchedCount : 0; }
    public synchronized int requestedAddressCount(String walletId) {
        return !closed && active && address != null && address.equals(walletId) ? requestedCount : 0;
    }
    @Override public void close() {
        Socket previous;
        synchronized (this) {
            if (closed) return; closed = true; active = false; connected = false; address = null;
            addresses = List.of(); configuredAddresses = List.of(); watchedCount = 0; requestedCount = 0; generation++;
            previous = socket; socket = null; notifyAll();
        }
        closeSocket(previous); dns.shutdownNow(); worker.interrupt();
    }
    private synchronized boolean current(long epoch) { return !closed && active && generation == epoch; }
    private void check(long epoch) throws IOException { if (!current(epoch)) throw new IOException("Inactive subscription generation"); }
    public synchronized boolean isCurrent(Event event) {
        return event != null && current(event.epoch) && connectionGeneration == event.connection &&
            address.equals(event.address) && ("disconnected".equals(event.reason) != connected);
    }
    private void emit(Event event) {
        // Never invoke consumers under the lifecycle monitor. The consumer also
        // fences its native lifecycle before delivering to JavaScript.
        if (isCurrent(event)) try { listener.changed(event); } catch (RuntimeException ignored) { /* A consumer cannot kill reconnection. */ }
    }
    private void run() {
        int failures = 0; long previousEpoch = -1;
        while (true) {
            final long epoch, connectionId; final String ownAddress; final List<String> ownAddresses; final int total;
            synchronized (this) {
                try {
                    while (!closed && (!active || now() < Math.max(retryAt, quotaUntil))) {
                        if (!active) wait(); else wait(Math.max(1, Math.max(retryAt, quotaUntil) - now()));
                    }
                } catch (InterruptedException ignored) { if (closed) return; }
                if (closed) return; if (!active) continue;
                epoch = generation; ownAddress = address; ownAddresses = addresses; total = requestedCount; connectionId = ++connectionGeneration;
                if (epoch != previousEpoch) { previousEpoch = epoch; failures = 0; }
            }
            long started = now();
            try { connect(epoch, connectionId, ownAddress, ownAddresses, total); }
            catch (QuotaException limited) {
                synchronized (this) { quotaUntil = Math.max(quotaUntil, now() + Math.max(quotaMs, limited.delayMs)); }
            } catch (Exception ignored) { /* EOF, deadlines, malformed data and DNS failures all reconnect boundedly. */ }
            finally {
                Socket previous = null;
                synchronized (this) { if (generation == epoch) { previous = socket; socket = null; connected = false; watchedCount = 0; } }
                closeSocket(previous);
            }
            if (current(epoch)) {
                emit(new Event(ownAddress, "disconnected", null, false, false, epoch, connectionId, List.of(), 0, total));
                synchronized (this) {
                    if (current(epoch)) {
                        // A register/EOF loop must not reset to a one-second retry.
                        if (now() - started >= heartbeatMs) failures = 0;
                        long delay = retryBaseMs * (1L << Math.min(failures++, 16));
                        retryAt = now() + Math.min(retryMaxMs, delay);
                    }
                }
            }
        }
    }
    private InetAddress resolve(long epoch, long deadline) throws Exception {
        Future<InetAddress[]> future = dns.submit(() -> resolver.resolve(host));
        try {
            while (true) {
                check(epoch); long remaining = deadline - now(); if (remaining <= 0) throw new SocketTimeoutException("Subscription DNS deadline");
                try {
                    InetAddress[] addresses = future.get(Math.min(100, remaining), TimeUnit.MILLISECONDS);
                    if (addresses == null || addresses.length == 0 || addresses.length > 64) throw new IOException("Invalid DNS reply");
                    for (InetAddress entry : addresses) if (entry != null && (fixture || publicAddress(entry))) return entry;
                    throw new IOException("No public subscription endpoint");
                } catch (TimeoutException waiting) { /* OS DNS may ignore interruption; at most one such thread remains. */ }
            }
        } finally { future.cancel(true); }
    }
    private void connect(long epoch, long connectionId, String walletId, List<String> ownAddresses, int total) throws Exception {
        // More watches need more round trips, but registration always has a finite total deadline.
        long registrationDeadline = now() + (long)requestMs * Math.min(4, 1 + (ownAddresses.size() - 1) / 20);
        InetAddress remote = resolve(epoch, registrationDeadline); check(epoch);
        try (Socket connection = new Socket()) {
            synchronized (this) { check(epoch); socket = connection; }
            connection.connect(new InetSocketAddress(remote, port), remaining(registrationDeadline));
            connection.setTcpNoDelay(true); connection.setKeepAlive(true);
            Frames frames = new Frames(connection, epoch);
            String prefix = "wallet-sub-" + epoch + "-";
            send(connection, epoch, prefix + "address", "subscribeaddress", new JSONObject().put("address", ownAddresses.get(0)).put("changes_only", true));
            ArrayList<JSONObject> pending = new ArrayList<>();
            int pendingLimit = Math.max(16, ownAddresses.size() * 2);
            JSONObject addressAck = registration(frames, prefix + "address", registrationDeadline, pending, pendingLimit);
            String addressId = subscriptionId(addressAck, true);
            Map<String, String> addressIds = new LinkedHashMap<>(); addressIds.put(addressId, ownAddresses.get(0));
            send(connection, epoch, prefix + "tip", "subscribetip", new JSONObject());
            JSONObject tipAck = registration(frames, prefix + "tip", registrationDeadline, pending, pendingLimit);
            String tipId = subscriptionId(tipAck, false); require(!tipId.equals(addressId));
            for (int i = 1; i < ownAddresses.size(); i++) {
                String id = prefix + "address-" + i;
                send(connection, epoch, id, "subscribeaddress", new JSONObject().put("address", ownAddresses.get(i)).put("changes_only", true));
                try {
                    String registered = subscriptionId(registration(frames, id, registrationDeadline, pending, pendingLimit), true);
                    require(!tipId.equals(registered) && !addressIds.containsKey(registered));
                    addressIds.put(registered, ownAddresses.get(i));
                } catch (CapacityException capacity) {
                    // A shared IP can hit the server cap below our own 99-address limit.
                    // Keep existing watches and the tip, but report exact partial coverage.
                    break;
                }
            }
            boolean registrationReorg = false;
            ArrayList<String> registrationChanges = new ArrayList<>();
            for (JSONObject message : pending) {
                Event hint = event(message, addressIds, tipId, walletId, epoch, connectionId, total);
                registrationReorg |= hint.reorg; registrationChanges.addAll(hint.changedAddresses);
            }
            // Registration has no snapshot guarantee. The connected event always
            // requests a catch-up after the changes-only ACK, including reconnect/
            // resume. It must not impersonate a reorg and discard a valid startup
            // baseline/journal: only actual reorg or overflow hints require reset.
            // Tips only project confirmations; heartbeats are liveness checks.
            synchronized (this) { check(epoch); watchedCount = addressIds.size(); connected = true; }
            emit(new Event(walletId, "connected", NativePaymentChecks.tip(tipAck.getJSONObject("tip")), registrationReorg, false,
                epoch, connectionId, registrationChanges, addressIds.size(), total));
            long idleDeadline = now() + heartbeatMs, heartbeatDeadline = 0, sequence = 0;
            String heartbeatId = null;
            while (true) {
                check(epoch);
                JSONObject message;
                try { message = frames.next(heartbeatId == null ? idleDeadline : heartbeatDeadline); }
                catch (SocketTimeoutException idle) {
                    if (heartbeatId != null || frames.partial()) throw idle;
                    heartbeatId = prefix + "heartbeat-" + (++sequence);
                    send(connection, epoch, heartbeatId, "getchaintip", new JSONObject());
                    heartbeatDeadline = now() + requestMs; continue;
                }
                if (message.has("id")) {
                    require(heartbeatId != null);
                    NativePaymentChecks.tip(reply(message, heartbeatId)); heartbeatId = null;
                } else emit(event(message, addressIds, tipId, walletId, epoch, connectionId, total));
                idleDeadline = now() + heartbeatMs;
            }
        }
    }
    private JSONObject registration(Frames frames, String id, long deadline, ArrayList<JSONObject> pending, int pendingLimit) throws Exception {
        while (true) {
            JSONObject message = frames.next(deadline);
            if (message.has("id")) return reply(message, id);
            notificationEnvelope(message); require(pending.size() < pendingLimit); pending.add(message);
        }
    }
    private String subscriptionId(JSONObject value, boolean addressSubscription) throws Exception {
        if (addressSubscription) fields(value, "subscription_id", "tip", "cursor", "changes_only");
        else fields(value, "subscription_id", "tip", "cursor");
        // An older server must reject the new option, not silently restore
        // broad per-block balance refreshes. Require explicit capability ACK.
        if (addressSubscription) require(Boolean.TRUE.equals(value.opt("changes_only")));
        String id = string(value.opt("subscription_id")); require(id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"));
        NativePaymentChecks.tip(value.getJSONObject("tip"));
        String cursor = string(value.opt("cursor")); require(cursor.length() <= 1024 && cursor.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"));
        return id;
    }
    private static JSONObject notificationEnvelope(JSONObject value) throws Exception {
        fields(value, "jsonrpc", "method", "params"); require("2.0".equals(value.opt("jsonrpc")) && "subscription".equals(value.opt("method")));
        return value.getJSONObject("params");
    }
    private Event event(JSONObject value, Map<String, String> addressIds, String tipId, String walletId, long epoch, long connectionId, int total) throws Exception {
        JSONObject params = notificationEnvelope(value); String kind = string(params.opt("kind"));
        List<String> changed = List.of();
        if ("address".equals(kind)) {
            fields(params, "subscription_id", "kind", "address", "tip", "reorg", "refresh");
            String expectedAddress = addressIds.get(string(params.opt("subscription_id")));
            require(expectedAddress != null && expectedAddress.equals(params.opt("address")) && Boolean.TRUE.equals(params.opt("refresh")));
            changed = List.of(expectedAddress);
        } else {
            require("tip".equals(kind)); fields(params, "subscription_id", "kind", "tip", "reorg");
            require(tipId.equals(params.opt("subscription_id")));
        }
        require(params.opt("reorg") instanceof Boolean);
        return new Event(walletId, kind, NativePaymentChecks.tip(params.getJSONObject("tip")), params.getBoolean("reorg"), false,
            epoch, connectionId, changed, addressIds.size(), total);
    }
    private JSONObject reply(JSONObject response, String id) throws Exception {
        require("2.0".equals(response.opt("jsonrpc")) && id.equals(response.opt("id")) && response.has("result") != response.has("error") && response.length() == 3);
        if (response.has("result")) return response.getJSONObject("result");
        JSONObject error = response.getJSONObject("error");
        Set<String> allowed = new HashSet<>(Arrays.asList("code", "message", "data")); Iterator<String> names = error.keys();
        while (names.hasNext()) require(allowed.contains(names.next()));
        Object code = error.opt("code"); require((code instanceof Integer || code instanceof Long) && ((Number)code).longValue() >= Integer.MIN_VALUE && ((Number)code).longValue() <= Integer.MAX_VALUE);
        require(string(error.opt("message")).length() <= 2048);
        if (((Number)code).intValue() == -32005) throw new CapacityException();
        if (((Number)code).intValue() == -32029) {
            long delay = quotaMs;
            if (error.has("data")) {
                JSONObject data = error.getJSONObject("data"); Object retry = data.opt("retry_after_ms");
                require(retry instanceof Integer || retry instanceof Long); long milliseconds = ((Number)retry).longValue(); require(milliseconds >= 0);
                delay = Math.max(delay, Math.min(milliseconds, 300000));
            }
            throw new QuotaException(delay);
        }
        throw new IOException("Subscription rejected");
    }
    private void send(Socket connection, long epoch, String id, String method, JSONObject params) throws Exception {
        check(epoch); byte[] bytes = (new JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params) + "\n").getBytes(StandardCharsets.UTF_8);
        connection.getOutputStream().write(bytes); connection.getOutputStream().flush(); check(epoch);
    }
    private final class Frames {
        final Socket connection; final long epoch; final InputStream input;
        final byte[] buffer = new byte[4096]; final ByteArrayOutputStream frame = new ByteArrayOutputStream(1024);
        int at, size; long started;
        Frames(Socket connection, long epoch) throws IOException { this.connection = connection; this.epoch = epoch; input = connection.getInputStream(); }
        boolean partial() { return frame.size() != 0; }
        JSONObject next(long deadline) throws Exception {
            while (true) {
                check(epoch);
                if (at == size) {
                    long frameDeadline = partial() ? Math.min(deadline, started + requestMs) : deadline;
                    connection.setSoTimeout(remaining(frameDeadline)); size = input.read(buffer); at = 0;
                    if (size < 0) throw new IOException("Subscription EOF");
                }
                int end = at; while (end < size && buffer[end] != '\n') end++;
                int count = end - at; if (frame.size() == 0 && count != 0) started = now();
                require(frame.size() + count <= MAX_FRAME); frame.write(buffer, at, count); at = end;
                if (at < size) {
                    at++;
                    String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(frame.toByteArray())).toString();
                    frame.reset(); return RpcTransport.parseObject(text);
                }
            }
        }
    }
    private static int remaining(long deadline) throws SocketTimeoutException {
        long remaining = deadline - now(); if (remaining <= 0) throw new SocketTimeoutException("Subscription deadline"); return (int)Math.min(Integer.MAX_VALUE, remaining);
    }
    private static void require(boolean valid) throws IOException { if (!valid) throw new IOException("Invalid subscription protocol"); }
    private static String string(Object value) throws IOException { require(value instanceof String); return (String)value; }
    private static void fields(JSONObject object, String... fields) throws IOException {
        require(object != null); Set<String> keys = new HashSet<>(); Iterator<String> names = object.keys(); while (names.hasNext()) keys.add(names.next());
        require(keys.equals(new HashSet<>(Arrays.asList(fields))));
    }
    private static boolean publicAddress(InetAddress address) {
        byte[] bytes = address.getAddress();
        return !(address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress() ||
            (bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc) || (bytes.length == 4 && ((bytes[0] & 255) == 0 || (bytes[0] & 255) >= 224 || ((bytes[0] & 255) == 100 && (bytes[1] & 0xc0) == 64))));
    }
    private static void closeSocket(Socket connection) { if (connection != null) try { connection.close(); } catch (IOException ignored) {} }
    private static final class QuotaException extends IOException {
        private static final long serialVersionUID = 1L;
        final long delayMs; QuotaException(long delayMs) { super("Subscription quota"); this.delayMs = delayMs; }
    }
    private static final class CapacityException extends IOException {
        private static final long serialVersionUID = 1L;
        CapacityException() { super("Subscription capacity"); }
    }
}
