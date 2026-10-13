package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import org.json.JSONObject;

/** HD reads only. Logical futures survive transport loss, keeping the scanner's
 * validated prefix, checkpoints and pagination in memory. All decisions run on
 * one scheduler, and every failed window shares one bounded retry probe. */
final class HdRecoveryReader implements NativeHdWallet.Reader, AutoCloseable {
    static final int MAX_PROBES = 8;
    private static final long[] DELAYS = {1000, 2000, 4000, 8000, 15000, 30000};
    interface Cancel { void cancel(); }
    interface Scheduler extends AutoCloseable {
        void execute(Runnable action);
        Cancel after(long delayMs, Runnable action);
        @Override void close();
    }
    @FunctionalInterface interface Status { void changed(String state, long retryAfterMs, int attempt, String code); }
    static final class RetryExhausted extends Exception {
        RetryExhausted() { super("Address discovery could not reconnect. Check your connection and retry recovery."); }
    }
    private static final class Timer implements Scheduler {
        final ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1, task -> {
            Thread thread = new Thread(task, "connectwallet-hd-retry"); thread.setDaemon(true); return thread;
        });
        Timer() { executor.setRemoveOnCancelPolicy(true); }
        public void execute(Runnable task) { executor.execute(task); }
        public Cancel after(long delay, Runnable task) {
            java.util.concurrent.ScheduledFuture<?> future = executor.schedule(task, delay, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        }
        public void close() { executor.shutdown(); }
    }
    private static final class Read {
        final String method;
        final JSONObject params;
        final CompletableFuture<JSONObject> logical = new CompletableFuture<>();
        CompletableFuture<JSONObject> actual;
        boolean probe;
        Read(String method, JSONObject params) { this.method = method; this.params = params; }
    }
    private final NativeHdWallet.Reader transport;
    private final NativeHdWallet.Check live;
    private final BooleanSupplier active;
    private final Status status;
    private final Scheduler scheduler;
    private final LongSupplier clock, jitter;
    private final Set<Read> reads = new LinkedHashSet<>();
    private volatile boolean closed;
    private boolean stopped, degraded;
    private int inFlight, attempts;
    private long due;
    private String code = "";
    private Cancel timer;
    private String lastState = "", lastCode = "";
    private long lastDelay = -1;
    private int lastAttempt = -1;

    HdRecoveryReader(NativeHdWallet.Reader transport, NativeHdWallet.Check live, BooleanSupplier active, Status status) {
        this(transport, live, active, status, new Timer(), () -> TimeUnit.NANOSECONDS.toMillis(System.nanoTime()),
            () -> java.util.concurrent.ThreadLocalRandom.current().nextLong(251));
    }
    HdRecoveryReader(NativeHdWallet.Reader transport, NativeHdWallet.Check live, BooleanSupplier active, Status status,
        Scheduler scheduler, LongSupplier clock, LongSupplier jitter) {
        this.transport = transport; this.live = live; this.active = active; this.status = status;
        this.scheduler = scheduler; this.clock = clock; this.jitter = jitter;
    }
    @Override public CompletableFuture<JSONObject> read(String method, JSONObject params) throws Exception {
        if (!"getaddresshistory".equals(method) && !"getaddresschanges".equals(method)) throw new IllegalArgumentException("Unsupported HD recovery read.");
        Read read = new Read(method, new JSONObject(params.toString()));
        if (closed) { read.logical.completeExceptionally(new CancellationException()); return read.logical; }
        enqueue(() -> {
            if (stopped || closed) { read.logical.completeExceptionally(new CancellationException()); return; }
            if (reads.size() >= NativeHdWallet.RECOVERY_CONCURRENCY) {
                read.logical.completeExceptionally(new NativeHdWallet.RecoveryLimitException("HD recovery request limit reached. Retry recovery.")); return;
            }
            reads.add(read); pump();
        });
        read.logical.whenComplete((result, failure) -> {
            if (read.logical.isCancelled()) enqueue(() -> {
                if (!reads.remove(read)) return;
                if (read.actual != null) { inFlight--; read.actual.cancel(true); }
                pump();
            });
        });
        return read.logical;
    }
    /** Called after the runtime applied its validated-network activity state. */
    void wake() { if (!closed) enqueue(this::pump); }
    private void enqueue(Runnable action) {
        try { scheduler.execute(action); }
        catch (java.util.concurrent.RejectedExecutionException stopped) { /* Closed owner; no new work can be admitted. */ }
    }
    private boolean check() {
        try { if (closed) throw new CancellationException(); live.check(); return true; }
        catch (Exception cancelled) { stop(cancelled); return false; }
    }
    private void pump() {
        if (stopped || !check() || reads.isEmpty()) return;
        if (!active.getAsBoolean()) {
            cancelTimer(); publish("waiting-network", 0); return;
        }
        if (degraded) {
            long wait = Math.max(0, due - clock.getAsLong());
            publish("retrying", wait);
            // Settle the failed window before probing, so sixteen simultaneous
            // failures consume one round and cannot reopen sixteen connections.
            if (inFlight > 0) return;
            if (wait > 0) {
                if (timer == null) timer = scheduler.after(wait, () -> { timer = null; pump(); });
                return;
            }
            cancelTimer();
            if (attempts >= MAX_PROBES) { stop(new RetryExhausted()); return; }
            for (Read read : reads) if (read.actual == null) {
                issue(read, true); return;
            }
        } else {
            cancelTimer(); publish("scanning", 0);
            for (Read read : new ArrayList<>(reads)) {
                if (stopped || closed) break;
                if (read.actual == null && inFlight < NativeHdWallet.RECOVERY_CONCURRENCY) issue(read, false);
            }
        }
    }
    private void issue(Read read, boolean probe) {
        if (!check()) return;
        // Preserve runtime quota/cooldown admission: no socket or timeout exists
        // here; the same bounded transport handles each new wire attempt.
        if (!active.getAsBoolean()) { publish("waiting-network", 0); return; }
        if (probe) { attempts++; publish("retrying", 0); }
        read.probe = probe; inFlight++;
        try {
            read.actual = transport.read(read.method, read.params);
            if (read.actual == null) throw new IllegalStateException("Missing HD recovery response.");
            CompletableFuture<JSONObject> source = read.actual;
            source.whenComplete((result, failure) -> enqueue(() -> settled(read, source, result, failure)));
        } catch (Exception failure) { settled(read, null, null, failure); }
    }
    private void settled(Read read, CompletableFuture<JSONObject> source, JSONObject result, Throwable failure) {
        if (stopped || !reads.contains(read) || read.actual != source) return;
        read.actual = null; inFlight--;
        if (!check()) return;
        if (failure == null) {
            try { NativeHdWallet.validateRecoveryRead(read.method, read.params, result); }
            catch (Exception invalid) { failure = invalid; }
        }
        if (failure == null) {
            reads.remove(read); read.logical.complete(result);
            if (read.probe) { degraded = false; attempts = 0; due = 0; code = ""; }
        } else {
            Throwable cause = unwrap(failure);
            // Legacy nodes may omit the optional checkpoint method. Let the
            // scanner discard checkpoint snapshots and continue its old path.
            if ("getaddresschanges".equals(read.method) && cause instanceof MobileRpcClient.RpcFailure
                    && "-32601".equals(((MobileRpcClient.RpcFailure)cause).code)) {
                reads.remove(read); read.logical.completeExceptionally(cause);
                if (read.probe) { degraded = false; attempts = 0; due = 0; code = ""; }
                pump(); return;
            }
            if (!retryable(cause)) { stop(cause); return; }
            MobileRpcClient.RpcFailure rpc = (MobileRpcClient.RpcFailure)cause;
            code = rpc.transportLoss ? "RPC_UNAVAILABLE" : rpc.code;
            if (!degraded || read.probe) {
                degraded = true;
                if (read.probe && attempts >= MAX_PROBES) { stop(new RetryExhausted()); return; }
                due = clock.getAsLong() + DELAYS[Math.min(attempts, DELAYS.length - 1)] + Math.max(0, Math.min(250, jitter.getAsLong()));
            }
            due = Math.max(due, clock.getAsLong() + rpc.retryAfterMs);
        }
        pump();
    }
    static boolean retryable(Throwable failure) {
        if (!(failure instanceof MobileRpcClient.RpcFailure)) return false;
        MobileRpcClient.RpcFailure rpc = (MobileRpcClient.RpcFailure)failure;
        if (rpc.unknownOutcome) return false;
        switch (rpc.code) {
            case "RPC_TIMEOUT": case "RPC_UNAVAILABLE": case "RPC_BUSY":
            case "-32001": case "-32030": case "-32029": return true;
            case "RPC_PROTOCOL": return rpc.transportLoss;
            case "RPC_INACTIVE": case "RPC_CANCELLED": return rpc.networkSuspended;
            default: return false;
        }
    }
    private static Throwable unwrap(Throwable failure) {
        while ((failure instanceof CompletionException || failure instanceof java.util.concurrent.ExecutionException) && failure.getCause() != null) failure = failure.getCause();
        return failure;
    }
    private void publish(String state, long delay) {
        if (lastState.equals(state) && lastDelay == delay && lastAttempt == attempts && lastCode.equals(code)) return;
        lastState = state; lastDelay = delay; lastAttempt = attempts; lastCode = code;
        try { status.changed(state, delay, attempts, code); } catch (RuntimeException ignored) { /* State hints never change recovery. */ }
    }
    private void cancelTimer() { if (timer != null) { timer.cancel(); timer = null; } }
    private void stop(Throwable failure) {
        if (stopped) return;
        stopped = true; cancelTimer();
        ArrayList<Read> pending = new ArrayList<>(reads); reads.clear(); inFlight = 0;
        for (Read read : pending) {
            read.logical.completeExceptionally(failure);
            if (read.actual != null) read.actual.cancel(true);
        }
    }
    @Override public void close() {
        if (closed) return;
        closed = true;
        enqueue(() -> { stop(new CancellationException()); scheduler.close(); });
    }
}
