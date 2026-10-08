package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeInactivityPolicyTest {
    @Test public void defaultAndExplicitZeroNeverLockAnActiveWallet() {
        NativeInactivityPolicy policy = new NativeInactivityPolicy();
        policy.unlocked(0);
        assertEquals(-1, policy.remainingMs(100_000_000));
        policy.configure(0, 100_000_000);
        assertEquals(-1, policy.remainingMs(900_000_000));
    }
    @Test public void lockedWalletHasNoTimerAndUnlockStartsAFullInterval() {
        NativeInactivityPolicy policy = new NativeInactivityPolicy();
        policy.configure(1, 0); assertEquals(-1, policy.remainingMs(1_000_000));
        policy.unlocked(100); assertEquals(60_000, policy.remainingMs(100));
        assertEquals(1, policy.remainingMs(60_099)); assertEquals(0, policy.remainingMs(60_100));
        policy.locked(); assertEquals(-1, policy.remainingMs(60_100));
        policy.unlocked(90_000); assertEquals(60_000, policy.remainingMs(90_000));
    }
    @Test public void genuineInteractionResetsDeadlineButLateInteractionCannotReviveIt() {
        NativeInactivityPolicy policy = new NativeInactivityPolicy();
        policy.configure(1, 0); policy.unlocked(0);
        assertTrue(policy.activity(30_000)); assertEquals(30_001, policy.remainingMs(59_999));
        assertFalse(policy.activity(90_000)); assertEquals(0, policy.remainingMs(90_001));
    }
    @Test public void changingDurationRearmsAndZeroRemovesTheDeadline() {
        NativeInactivityPolicy policy = new NativeInactivityPolicy();
        policy.configure(1, 0); policy.unlocked(0);
        policy.configure(15, 59_000); assertEquals(900_000, policy.remainingMs(59_000));
        policy.configure(0, 60_000); assertEquals(-1, policy.remainingMs(9_000_000));
        policy.configure(1, 9_000_000); assertEquals(60_000, policy.remainingMs(9_000_000));
    }
    @Test public void boundsAndClockRollbackAreSafe() {
        NativeInactivityPolicy policy = new NativeInactivityPolicy();
        for (int value : new int[]{-1, 1441, Integer.MAX_VALUE}) {
            try { policy.configure(value, 0); fail("Accepted invalid duration"); }
            catch (IllegalArgumentException expected) { }
        }
        policy.configure(1440, 100); policy.unlocked(100);
        assertEquals(86_400_000, policy.remainingMs(0));
        assertEquals(0, policy.remainingMs(86_400_100));
    }
}
