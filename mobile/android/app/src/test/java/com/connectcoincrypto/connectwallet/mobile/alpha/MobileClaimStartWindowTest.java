package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public class MobileClaimStartWindowTest {
    private static long seconds(long value) { return TimeUnit.SECONDS.toNanos(value); }

    @Test public void usesAFixedTenSecondDenominatorAndExpiresWithoutNewEvents() {
        MobileClaimStartWindow window = new MobileClaimStartWindow();
        window.record(seconds(100), seconds(100));
        assertEquals(0.1, window.rate(seconds(100)), 0);
        assertEquals(0.1, window.rate(seconds(110) - 1), 0);
        assertEquals(0, window.rate(seconds(110)), 0);
    }
    @Test public void lateAndOutOfOrderAcknowledgementsKeepNativeEventExpiry() {
        MobileClaimStartWindow window = new MobileClaimStartWindow();
        window.record(seconds(109), seconds(109));
        window.record(seconds(101), seconds(109));
        window.record(seconds(105), seconds(109));
        window.record(seconds(99), seconds(109));
        assertEquals(0.3, window.rate(seconds(109)), 0);
        assertEquals(0.2, window.rate(seconds(111)), 0);
        assertEquals(0.1, window.rate(seconds(115)), 0);
        assertEquals(0, window.rate(seconds(119)), 0);
    }
    @Test public void sustainedHundredStartsPerSecondPlateausAndResetDropsPriorRun() {
        MobileClaimStartWindow window = new MobileClaimStartWindow();
        long step = TimeUnit.MILLISECONDS.toNanos(10);
        for (long timestamp = seconds(100); timestamp <= seconds(120); timestamp += step) window.record(timestamp, timestamp);
        assertEquals(100, window.rate(seconds(120)), 0);
        assertEquals(50.1, window.rate(seconds(125) - 1), 0);
        window.clear(); assertEquals(0, window.rate(seconds(125)), 0);
    }
}
