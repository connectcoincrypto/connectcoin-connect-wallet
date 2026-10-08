package com.connectcoincrypto.connectwallet.mobile.alpha;

/** Bounded plain-text transfer only. The shared payment parser still validates its contents. */
final class NativePaymentClipboard {
    // Keep aligned with PAYMENT_URI_MAX_LENGTH in src/core/payment-uri.mjs (UTF-16 code units).
    static final int MAX_LENGTH = 1024;
    static final String INVALID_MESSAGE = "Copy a ConnectCoin address or payment link as text of no more than 1024 characters.";

    private NativePaymentClipboard() {}

    static String boundedText(CharSequence text) {
        if (text == null) throw new IllegalArgumentException(INVALID_MESSAGE);
        int length = text.length();
        if (length == 0 || length > MAX_LENGTH) throw new IllegalArgumentException(INVALID_MESSAGE);
        // Copy characters only, stripping spans and bounding conversion before creating bridge data.
        char[] plain = new char[length];
        for (int index = 0; index < length; index++) plain[index] = text.charAt(index);
        return new String(plain);
    }
}
