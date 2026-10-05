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

    public static long createCancellationHandle() { return nativeCreate(); }
    public static void cancel(long handle) { nativeCancel(handle); }
    public static void destroyHandle(long handle) { nativeDestroy(handle); }

    /** Blocking worker call, at most four concurrent captures. Timeout1..10000ms
     * includes DNS/TCP/TLS. Cancellation/deadline checks bracket synchronous
     * bounded certificate verification too; OS DNS may finish later, but no
     * socket is opened by that abandoned DNS operation. Invalid proof returns
     * validProof:false without proof bytes; target misses remain validProof:true.
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
    private static native long nativeCreate();
    private static native void nativeCancel(long handle);
    private static native void nativeDestroy(long handle);
    private static native String nativeCapture(String domain, String challengeHex, String targetHex,
            int rootsVersion, int signatureMask, long validationTime, int timeoutMs, long handle);
}
