package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

/** Advisory probe orchestration with mocks; never uses DNS, TLS, native libraries or wallet keys. */
public class MobileRsaProbeTest {
    private static class Backend implements MobileRsaProbe.Backend {
        final AtomicInteger creates = new AtomicInteger(), probes = new AtomicInteger(), cancels = new AtomicInteger(), destroys = new AtomicInteger();
        String outcome = "verified", error;
        public long create() { creates.incrementAndGet(); return 42; }
        public String probe(String domain, long time, int timeout, long handle) {
            assertEquals("example.com", domain); assertEquals(123456789L, time); assertEquals(42, handle);
            assertTrue(timeout > 0 && timeout <= MobileRsaProbe.DEADLINE_MS); probes.incrementAndGet();
            if (error != null) throw new IllegalStateException(error);
            return outcome;
        }
        public void cancel(long handle) { assertEquals(42, handle); cancels.incrementAndGet(); }
        public void destroy(long handle) { assertEquals(42, handle); destroys.incrementAndGet(); }
    }
    private static ThreadPoolExecutor worker() {
        return new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new SynchronousQueue<>(), task -> {
            Thread thread = new Thread(task, "mock-rsa-probe"); thread.setDaemon(true); return thread;
        });
    }
    private static String await(MobileRsaProbe.Attempt attempt) {
        try { return attempt.await(); } catch (InterruptedException failure) { throw new AssertionError(failure); }
    }

    @Test public void onlyExactNativeStatusesSurviveAndEachHandleIsDestroyed() throws Exception {
        for (String value : new String[]{"verified", "failed", "timeout", "busy", "unavailable", null, "true", "verified\n", "OS exception/path/secret"}) {
            Backend backend = new Backend(); backend.outcome = value;
            MobileRsaProbe probe = new MobileRsaProbe(backend, Runnable::run, 3000);
            String actual = probe.prepare("example.com", 123456789L).await();
            String expected = "verified".equals(value) || "timeout".equals(value) || "busy".equals(value) || "unavailable".equals(value) ? value : "failed";
            assertEquals(expected, actual); assertEquals(1, backend.creates.get()); assertEquals(1, backend.probes.get()); assertEquals(1, backend.destroys.get());
        }
    }
    @Test public void fixedFailuresMapToFallbackButCancellationNeverDoes() throws Exception {
        for (String code : new String[]{"CLAIM_TIMEOUT", "CLAIM_BUSY", "CLAIM_CRYPTO", "CLAIM_TLS", "untrusted remote text"}) {
            Backend backend = new Backend(); backend.error = code;
            String outcome = new MobileRsaProbe(backend, Runnable::run, 3000).prepare("example.com", 123456789L).await();
            assertEquals(code.equals("CLAIM_TIMEOUT") ? "timeout" : code.equals("CLAIM_BUSY") ? "busy" : code.equals("CLAIM_CRYPTO") ? "unavailable" : "failed", outcome);
            assertEquals(1, backend.destroys.get());
        }
        Backend backend = new Backend(); backend.error = "CLAIM_CANCELLED";
        MobileRsaProbe.Attempt cancelled = new MobileRsaProbe(backend, Runnable::run, 3000).prepare("example.com", 123456789L);
        assertThrows(CancellationException.class, cancelled::await); assertEquals(1, backend.destroys.get());
        Backend missing = new Backend() { public long create() { throw new UnsatisfiedLinkError("local library path"); } };
        assertEquals("unavailable", new MobileRsaProbe(missing, Runnable::run, 3000).prepare("example.com", 123456789L).await());
    }
    @Test public void cancellationBeforeDispatchDoesNotCreateOrProbe() {
        Backend backend = new Backend();
        MobileRsaProbe.Attempt attempt = new MobileRsaProbe(backend, Runnable::run, 3000).prepare("example.com", 123456789L);
        attempt.cancel(); assertThrows(CancellationException.class, attempt::await);
        assertEquals(0, backend.creates.get()); assertEquals(0, backend.probes.get());
    }
    @Test public void timeoutRejectsLateSuccessAndRetainsWorkerCapacityUntilExit() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        Backend backend = new Backend() { public String probe(String domain, long time, int timeout, long handle) {
            super.probe(domain, time, timeout, handle); entered.countDown();
            try { assertTrue(release.await(2, TimeUnit.SECONDS)); } catch (InterruptedException e) { throw new AssertionError(e); }
            return "verified";
        } };
        ThreadPoolExecutor executor = worker();
        try {
            MobileRsaProbe probe = new MobileRsaProbe(backend, executor, 100);
            long start = System.nanoTime(); String result = probe.prepare("example.com", 123456789L).await();
            assertEquals("timeout", result); assertEquals(0, entered.getCount());
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 1000);
            assertEquals(1, backend.cancels.get()); assertEquals(0, backend.destroys.get());
            assertEquals("busy", probe.prepare("example.com", 123456789L).await());
            assertEquals(1, backend.creates.get());
        } finally { release.countDown(); executor.shutdown(); assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS)); }
        assertEquals(1, backend.destroys.get());
    }
    @Test public void lifecycleCancellationInterruptsWaitAndSuppressesLateSuccess() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        Backend backend = new Backend() { public String probe(String domain, long time, int timeout, long handle) {
            super.probe(domain, time, timeout, handle); entered.countDown();
            try { assertTrue(release.await(2, TimeUnit.SECONDS)); } catch (InterruptedException e) { throw new AssertionError(e); }
            return "verified";
        } };
        ThreadPoolExecutor executor = worker();
        try {
            MobileRsaProbe.Attempt attempt = new MobileRsaProbe(backend, executor, 3000).prepare("example.com", 123456789L);
            CompletableFuture<String> waiter = CompletableFuture.supplyAsync(() -> await(attempt));
            assertTrue(entered.await(1, TimeUnit.SECONDS)); attempt.cancel();
            ExecutionException error = assertThrows(ExecutionException.class, () -> waiter.get(1, TimeUnit.SECONDS));
            assertTrue(error.getCause() instanceof CancellationException); assertEquals(1, backend.cancels.get());
        } finally { release.countDown(); executor.shutdown(); assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS)); }
        assertEquals(1, backend.destroys.get());
    }
    @Test public void timeoutDuringHandleCreationPreventsAnyLaterNetworkCall() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        Backend backend = new Backend() { public long create() {
            entered.countDown();
            try { assertTrue(release.await(2, TimeUnit.SECONDS)); } catch (InterruptedException e) { throw new AssertionError(e); }
            return super.create();
        } };
        ThreadPoolExecutor executor = worker();
        try {
            assertEquals("timeout", new MobileRsaProbe(backend, executor, 100).prepare("example.com", 123456789L).await());
            assertEquals(0, entered.getCount());
        } finally { release.countDown(); executor.shutdown(); assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS)); }
        assertEquals(0, backend.probes.get()); assertEquals(1, backend.cancels.get()); assertEquals(1, backend.destroys.get());
    }
}
