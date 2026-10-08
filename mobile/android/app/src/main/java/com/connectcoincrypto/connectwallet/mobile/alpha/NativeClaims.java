package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.os.Looper;

/** Key-free Core-derived P2C TLS engine. Not itself a JavaScript plugin.
 * The owning service must enforce user Start, network policy, bounded workers,
 * rate limits, and cancel/destroy its handles on Stop or lifecycle suspension.
 * No native method accepts a private key, reward address, arbitrary port,
 * filesystem path, alternate trust store, or broadcast instruction.
 */
public final class NativeClaims {
    static { System.loadLibrary("connectwallet_claims"); }
    private NativeClaims() {}

    public static long createCancellationHandle() { return nativeCreate(0); }
    public static long createCancellationHandle(long limiter) { return nativeCreate(limiter); }
    /** One limiter per owning engine; preserve it across pause/resume. */
    public static long createStartLimiter(int rate) { return nativeCreateStartLimiter(rate); }
    public static void setStartRate(long limiter, int rate) { nativeSetStartRate(limiter, rate); }
    /** Clear paused-run timing debt, retaining the rolling actual-start limit. */
    public static void resetStartSchedule(long limiter) { nativeResetStartSchedule(limiter); }
    public static void destroyStartLimiter(long limiter) { nativeDestroyStartLimiter(limiter); }
    /** Elapsed monotonic nanos since actual connect, or -1 until started.
     * Using an age avoids assuming a shared epoch with System.nanoTime(). */
    public static long startedAgeNanos(long handle) { return nativeStartedAgeNanos(handle); }
    /** Actual TCP-start acknowledgement; query before destroying this handle. */
    public static boolean hasStarted(long handle) { return nativeHasStarted(handle); }
    public static void cancel(long handle) { nativeCancel(handle); }
    public static void destroyHandle(long handle) { nativeDestroy(handle); }

    /** Blocking worker call, at most 100 concurrent captures. Timeout1..10000ms
     * includes DNS/TCP/TLS. Cancellation/deadline checks bracket synchronous
     * bounded certificate verification too; OS DNS may finish later, but no
     * socket is opened by that abandoned DNS operation. Invalid proof returns
     * validProof:false without proof bytes; target misses remain validProof:true.
     * captured records the raw P2C transcript through CertificateVerify (not
     * a completed TLS handshake). validationPassed is the
     * known certificate/signature outcome for EMA; validProof additionally
     * requires an unexpired usable proof. An expired known-valid result retains
     * validationPassed:true but no proof bytes and validProof:false.
     * Completed TCP/TLS failures also return false with durationMs/errorCode.
     * Pre-TCP DNS failures, cancellation and local setup errors throw instead:
     * they must not be recorded as a certificate-failure EMA sample.
     * challengeHex is the exact32 ClientHello bytes, targetHex is uint256 display.
     */
    public static String captureAndVerify(String domain, String challengeHex, String targetHex,
            int rootsVersion, int signatureMask, long validationTime, int timeoutMs, long handle) {
        if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("CLAIM_MAIN_THREAD");
        return nativeCapture(domain, challengeHex, targetHex, rootsVersion, signatureMask, validationTime, timeoutMs, handle);
    }
    /** Advisory capability check, not mining. Native code generates a fresh
     * random challenge, fixes root bundle 1/RSA mask 6/maximum target and only
     * verifies a completed TLS 1.3 handshake. No proof or wallet data crosses
     * this boundary. The owning review supplies a budget of at most 3000 ms.
     */
    public static String probeRsa(String domain, long validationTime, int timeoutMs, long handle) {
        if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("CLAIM_MAIN_THREAD");
        return nativeProbeRsa(domain, validationTime, timeoutMs, handle);
    }
    private static native long nativeCreate(long limiter);
    private static native long nativeCreateStartLimiter(int rate);
    private static native void nativeSetStartRate(long limiter, int rate);
    private static native void nativeResetStartSchedule(long limiter);
    private static native void nativeDestroyStartLimiter(long limiter);
    private static native long nativeStartedAgeNanos(long handle);
    private static native boolean nativeHasStarted(long handle);
    private static native void nativeCancel(long handle);
    private static native void nativeDestroy(long handle);
    private static native String nativeCapture(String domain, String challengeHex, String targetHex,
            int rootsVersion, int signatureMask, long validationTime, int timeoutMs, long handle);
    private static native String nativeProbeRsa(String domain, long validationTime, int timeoutMs, long handle);
}
