package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.util.ArrayDeque;
import java.util.concurrent.TimeUnit;

/** Actual TCP starts in (now - 10 seconds, now], under the engine lock. */
final class MobileClaimStartWindow {
    private static final long WINDOW_NANOS = TimeUnit.SECONDS.toNanos(10);
    private final ArrayDeque<Long> starts = new ArrayDeque<>();

    void record(long startedAt, long now) {
        expire(now);
        if (now - startedAt >= WINDOW_NANOS) return;
        // Worker acknowledgements can arrive in a different order from TCP.
        // Keep expiry ordered by the native event, never by the poll time.
        ArrayDeque<Long> later = new ArrayDeque<>();
        while (!starts.isEmpty() && starts.peekLast() > startedAt) later.addFirst(starts.removeLast());
        starts.addLast(startedAt);
        starts.addAll(later);
    }

    double rate(long now) { expire(now); return starts.size() / 10.0; }
    void clear() { starts.clear(); }
    private void expire(long now) {
        while (!starts.isEmpty() && now - starts.peekFirst() >= WINDOW_NANOS) starts.removeFirst();
    }
}
