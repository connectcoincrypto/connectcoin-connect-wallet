package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import android.os.Build;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Loads the packaged JNI library without DNS, TLS to real hosts or claims. */
@RunWith(AndroidJUnit4.class)
public final class NativeClaimsSmokeTest {
    @Before public void isolatedEmulatorOnly() {
        assertTrue("Use an isolated emulator, never a physical device.",
            "ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE) || Build.MODEL.startsWith("sdk_gphone"));
    }

    @Test public void packagedLibraryAndCancellationFailBeforeDns() {
        long handle = NativeClaims.createCancellationHandle();
        assertTrue(handle > 0);
        assertFalse(NativeClaims.hasStarted(handle));
        try {
            NativeClaims.cancel(handle);
            assertFalse(NativeClaims.hasStarted(handle));
            try {
                NativeClaims.captureAndVerify("example.com", "00".repeat(32), "ff".repeat(32), 1, 7, 1800000000L, 100, handle);
                fail("Cancelled work must not start DNS or connect.");
            } catch (IllegalStateException expected) {
                assertEquals("CLAIM_CANCELLED", expected.getMessage());
            }
        } finally { NativeClaims.destroyHandle(handle); }
        NativeClaims.cancel(handle);
        NativeClaims.destroyHandle(handle);
        assertFalse(NativeClaims.hasStarted(handle));
        assertFalse(NativeClaims.hasStarted(0));
    }

    @Test public void invalidPublicContextIsRejectedBeforeDns() {
        long handle = NativeClaims.createCancellationHandle();
        try {
            try {
                NativeClaims.captureAndVerify("127.0.0.1", "00".repeat(32), "ff".repeat(32), 1, 7, 1800000000L, 100, handle);
                fail("IP literals must never be used as destinations.");
            } catch (IllegalStateException expected) { assertEquals("CLAIM_CONTEXT", expected.getMessage()); }
            assertFalse(NativeClaims.hasStarted(handle));
        } finally { NativeClaims.destroyHandle(handle); }
    }

    @Test public void mainThreadCannotStartCapture() {
        AtomicReference<String> code = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            try { NativeClaims.captureAndVerify("example.com", "00".repeat(32), "ff".repeat(32), 1, 7, 1800000000L, 100, 0); }
            catch (IllegalStateException expected) { code.set(expected.getMessage()); }
        });
        assertEquals("CLAIM_MAIN_THREAD", code.get());
    }
}
