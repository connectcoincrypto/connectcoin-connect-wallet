package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Test;

public class MobileRpcAwaitTest {
    @Test public void pendingReadKeepsCheckingWithoutASecondWallClockTimeout() throws Exception {
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        AtomicInteger checks = new AtomicInteger(); JSONObject reply = new JSONObject();
        assertSame(reply, MobileRpcAwait.read(future, () -> {
            if (checks.incrementAndGet() == 3) future.complete(reply);
        }));
        assertEquals(4, checks.get()); assertFalse(future.isCancelled());
    }

    @Test public void cancellationWhileWaitingDisposesRead() {
        CompletableFuture<JSONObject> future = new CompletableFuture<>(); AtomicInteger checks = new AtomicInteger();
        assertThrows(InterruptedException.class, () -> MobileRpcAwait.read(future, () -> {
            if (checks.incrementAndGet() == 2) throw new InterruptedException("cancelled");
        }));
        assertTrue(future.isCancelled());
    }

    @Test public void completedFailuresAreNotMistakenForPollTimeouts() {
        for (Exception failure : new Exception[]{new TimeoutException("transport timeout"), new IllegalStateException("failed")}) {
            CompletableFuture<JSONObject> future = new CompletableFuture<>(); future.completeExceptionally(failure);
            assertSame(failure, assertThrows(Exception.class, () -> MobileRpcAwait.read(future, () -> {})));
            assertSame(failure, assertThrows(Exception.class, () -> MobileRpcAwait.broadcast(future, () -> {}, unused -> false)));
        }
    }

    @Test public void revokedQueuedBroadcastCancelsOnlyTheExistingUnsentFuture() {
        CompletableFuture<JSONObject> future = new CompletableFuture<>(); AtomicInteger cancellations = new AtomicInteger();
        assertThrows(CancellationException.class, () -> MobileRpcAwait.broadcast(future,
            () -> { throw new IllegalStateException("approval expired"); }, pending -> {
                assertSame(future, pending); cancellations.incrementAndGet(); return pending.cancel(false);
            }));
        assertEquals(1, cancellations.get()); assertTrue(future.isCancelled());
    }

    @Test public void revokedAlreadyWrittenBroadcastStillReturnsItsRealOutcome() throws Exception {
        CompletableFuture<JSONObject> future = new CompletableFuture<>(); AtomicInteger checks = new AtomicInteger();
        AtomicInteger cancellations = new AtomicInteger(); JSONObject reply = new JSONObject();
        assertSame(reply, MobileRpcAwait.broadcast(future, () -> {
            if (checks.incrementAndGet() == 3) future.complete(reply);
            throw new IllegalStateException("approval expired after write");
        }, pending -> { assertSame(future, pending); cancellations.incrementAndGet(); return false; }));
        assertEquals(3, cancellations.get()); assertFalse(future.isCancelled());
    }

    @Test public void readRechecksRevocationAfterReplyBeforeReturningData() {
        CompletableFuture<JSONObject> future = CompletableFuture.completedFuture(new JSONObject());
        AtomicInteger checks = new AtomicInteger();
        assertThrows(IllegalStateException.class, () -> MobileRpcAwait.read(future, () -> {
            if (checks.incrementAndGet() == 2) throw new IllegalStateException("wallet locked");
        }));
        assertFalse(future.isCancelled());
    }
}
