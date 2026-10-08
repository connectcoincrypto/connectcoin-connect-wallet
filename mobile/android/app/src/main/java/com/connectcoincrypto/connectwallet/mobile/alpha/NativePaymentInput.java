package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.net.URI;
import java.net.URISyntaxException;

/** Public payment text only. This never parses or authorizes a wallet operation. */
final class NativePaymentInput {
    static final int MAX_LENGTH = 1024;
    static final String INVALID = "INVALID_PAYMENT_LINK";
    private static final String VIEW = "android.intent.action.VIEW";
    private static final String SCHEME_PREFIX = "connectcoin:";

    private NativePaymentInput() {}

    static String boundedText(CharSequence text) {
        if (text == null || text.length() == 0 || text.length() > MAX_LENGTH) {
            throw new IllegalArgumentException(INVALID);
        }
        char[] plain = new char[text.length()];
        for (int i = 0; i < plain.length; i++) plain[i] = text.charAt(i);
        return new String(plain);
    }

    static boolean isPaymentIntent(String action, CharSequence text) {
        if (!VIEW.equals(action) || text == null || text.length() < SCHEME_PREFIX.length()) return false;
        // Inspect only the scheme before copying an untrusted, possibly oversized string.
        for (int i = 0; i < SCHEME_PREFIX.length(); i++) {
            char actual = text.charAt(i);
            char expected = SCHEME_PREFIX.charAt(i);
            if (actual != expected && actual != Character.toUpperCase(expected)) return false;
        }
        return true;
    }

    static final class Input {
        final String text;
        final String error;
        private Input(String text, String error) { this.text = text; this.error = error; }
    }

    /** One bounded, latest-only, memory-only slot. Taking it consumes it exactly once. */
    static final class Mailbox {
        private Input pending;
        private boolean closed;

        synchronized boolean offer(String action, CharSequence text) {
            if (closed || !isPaymentIntent(action, text)) return false;
            try {
                String plain = boundedText(text);
                URI uri = new URI(plain);
                if (!"connectcoin".equalsIgnoreCase(uri.getScheme()) || uri.getRawSchemeSpecificPart() == null
                        || uri.getRawSchemeSpecificPart().isEmpty()) throw new URISyntaxException("", INVALID);
                pending = new Input(plain, null);
            } catch (IllegalArgumentException | URISyntaxException error) {
                pending = new Input(null, INVALID);
            }
            return true;
        }

        synchronized Input take() { Input result = pending; pending = null; return result; }
        synchronized void close() { closed = true; pending = null; }
    }
}
