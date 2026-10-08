package com.connectcoincrypto.connectwallet.mobile.alpha;

/** Monotonic native inactivity deadline. Zero means no foreground auto-lock. */
final class NativeInactivityPolicy {
    private long timeoutMs, lastActivity;
    private boolean unlocked;

    void configure(int minutes, long now) {
        if (minutes < 0 || minutes > 1440) throw new IllegalArgumentException("Invalid inactivity time.");
        timeoutMs = minutes * 60_000L;
        lastActivity = now;
    }
    void unlocked(long now) { unlocked = true; lastActivity = now; }
    void locked() { unlocked = false; }
    /** A delayed input must not revive a deadline which already expired. */
    boolean activity(long now) {
        if (remainingMs(now) == 0) return false;
        lastActivity = now;
        return true;
    }
    /** -1: no timer; 0: lock now; positive: remaining monotonic milliseconds. */
    long remainingMs(long now) {
        if (!unlocked || timeoutMs == 0) return -1;
        long elapsed = Math.max(0, now - lastActivity);
        return Math.max(0, timeoutMs - elapsed);
    }
}
