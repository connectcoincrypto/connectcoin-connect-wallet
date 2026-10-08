package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/** One advisory, key-free native probe with a bounded caller wait and no retries.
 * Timed-out native verification may finish later; its process-wide worker slot
 * remains occupied until it exits, and its late result can never select RSA.
 */
final class MobileRsaProbe {
    static final int DEADLINE_MS = 3000;
    private static final Executor WORKER = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
        new SynchronousQueue<>(), task -> { Thread thread = new Thread(task, "connectwallet-rsa-probe"); thread.setDaemon(true); return thread; });
    interface Backend {
        long create();
        String probe(String domain, long validationTime, int timeoutMs, long handle);
        void cancel(long handle);
        void destroy(long handle);
    }
    private final Backend backend;
    private final Executor worker;
    private final int deadlineMs;
    MobileRsaProbe(Backend backend) { this(backend, WORKER, DEADLINE_MS); }
    MobileRsaProbe(Backend backend, Executor worker, int deadlineMs) {
        if (backend == null || worker == null || deadlineMs < 1 || deadlineMs > DEADLINE_MS) throw new IllegalArgumentException("Invalid RSA probe configuration.");
        this.backend = backend; this.worker = worker; this.deadlineMs = deadlineMs;
    }
    Attempt prepare(String domain, long validationTime) {
        if (domain == null || domain.length() > 253 || !domain.matches("[a-z0-9.-]+") || validationTime < 1 || validationTime > 253402300799L)
            throw new IllegalArgumentException("Invalid RSA probe request.");
        return new Attempt(domain, validationTime);
    }
    private static String status(String value) {
        return "verified".equals(value) || "timeout".equals(value) || "busy".equals(value) || "unavailable".equals(value) ? value : "failed";
    }
    final class Attempt {
        private final String domain;
        private final long validationTime, deadline;
        private final AtomicBoolean started = new AtomicBoolean(), cancelled = new AtomicBoolean();
        private final CompletableFuture<String> result = new CompletableFuture<>();
        private final Object guard = new Object();
        private long handle;
        private Attempt(String domain, long validationTime) {
            this.domain = domain; this.validationTime = validationTime;
            deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(deadlineMs);
        }
        private long remaining() { return deadline - System.nanoTime(); }
        void cancel() {
            cancelled.set(true);
            result.completeExceptionally(new CancellationException("P2C review cancelled. Review again."));
            long current; synchronized (guard) { current = handle; }
            if (current != 0) cancelHandle(current);
        }
        private void cancelHandle(long current) {
            try { backend.cancel(current); } catch (RuntimeException | LinkageError ignored) { /* Never surface native/OS details. */ }
        }
        String await() throws InterruptedException {
            if (cancelled.get()) throw new CancellationException("P2C review cancelled. Review again.");
            if (!started.compareAndSet(false, true)) throw new IllegalStateException("RSA probe was already awaited.");
            if (remaining() <= 0) { cancel(); return "timeout"; }
            try { worker.execute(this::run); }
            catch (RejectedExecutionException busy) { result.complete("busy"); }
            try {
                long budget = remaining();
                if (budget <= 0) { cancel(); return "timeout"; }
                String outcome = result.get(budget, TimeUnit.NANOSECONDS);
                if (cancelled.get()) throw new CancellationException("P2C review cancelled. Review again.");
                if (remaining() <= 0) { cancel(); return "timeout"; }
                return status(outcome);
            } catch (TimeoutException timeout) { cancel(); return "timeout"; }
            catch (ExecutionException failure) {
                if (cancelled.get() || failure.getCause() instanceof CancellationException) throw new CancellationException("P2C review cancelled. Review again.");
                return "failed";
            } catch (InterruptedException interrupted) { cancel(); Thread.currentThread().interrupt(); throw interrupted; }
        }
        private void run() {
            long created = 0; String outcome = "failed";
            try {
                if (cancelled.get()) return;
                if (remaining() <= 0) { outcome = "timeout"; return; }
                created = backend.create();
                if (created <= 0) { outcome = "unavailable"; return; }
                synchronized (guard) { handle = created; }
                if (cancelled.get()) { cancelHandle(created); return; }
                long budgetMs = TimeUnit.NANOSECONDS.toMillis(remaining());
                if (budgetMs < 1) { outcome = "timeout"; return; }
                outcome = status(backend.probe(domain, validationTime, (int)Math.min(deadlineMs, budgetMs), created));
                if (remaining() <= 0) outcome = "timeout";
            } catch (LinkageError unavailable) { outcome = "unavailable"; }
            catch (RuntimeException failure) {
                String code = failure.getMessage();
                if ("CLAIM_CANCELLED".equals(code)) { cancel(); return; }
                outcome = "CLAIM_TIMEOUT".equals(code) ? "timeout" : "CLAIM_BUSY".equals(code) ? "busy"
                    : "CLAIM_CRYPTO".equals(code) ? "unavailable" : "failed";
            } finally {
                synchronized (guard) { handle = 0; }
                if (created > 0) {
                    try { backend.destroy(created); } catch (RuntimeException | LinkageError ignored) { outcome = "failed"; }
                }
                if (!cancelled.get()) result.complete(remaining() <= 0 ? "timeout" : outcome);
            }
        }
    }
}
