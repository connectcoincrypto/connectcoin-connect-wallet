package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import org.junit.Test;

public final class NativePaymentInputTest {
    private static final String VIEW = "android.intent.action.VIEW";
    private static final String LINK = "connectcoin:cc1pfixture?amount=1&label=Example%20payment";

    @Test public void latestLinkIsConsumedOnlyOnce() {
        NativePaymentInput.Mailbox mailbox = new NativePaymentInput.Mailbox();
        assertNull(mailbox.take());
        assertTrue(mailbox.offer(VIEW, LINK));
        assertTrue(mailbox.offer(VIEW, "connectcoin:cc1psecond"));
        NativePaymentInput.Input input = mailbox.take();
        assertEquals("connectcoin:cc1psecond", input.text);
        assertNull(input.error);
        assertNull(mailbox.take());
    }

    @Test public void unrelatedIntentsCannotReplacePayment() {
        NativePaymentInput.Mailbox mailbox = new NativePaymentInput.Mailbox();
        assertTrue(mailbox.offer(VIEW, LINK));
        assertFalse(mailbox.offer("android.intent.action.SEND", "connectcoin:cc1pother"));
        assertFalse(mailbox.offer(VIEW, "https://example.com"));
        assertFalse(mailbox.offer(VIEW, "connectcoins:cc1pother"));
        assertFalse(mailbox.offer(VIEW, "javascript:example"));
        assertFalse(mailbox.offer(VIEW, null));
        assertEquals(LINK, mailbox.take().text);
    }

    @Test public void malformedAndOversizedLinksContainOnlyFixedError() {
        for (String input : new String[] { "connectcoin:", "connectcoin:cc1p%zz", "connectcoin:cc1p\nsecret",
                "connectcoin:" + "a".repeat(1024) }) {
            NativePaymentInput.Mailbox mailbox = new NativePaymentInput.Mailbox();
            assertTrue(mailbox.offer(VIEW, LINK));
            assertTrue(mailbox.offer(VIEW, input));
            NativePaymentInput.Input result = mailbox.take();
            assertNull(result.text);
            assertEquals("INVALID_PAYMENT_LINK", result.error);
            assertNull(mailbox.take());
        }
    }

    @Test public void boundedTextCopiesPlainCharactersWithoutToString() {
        CharSequence text = new CharSequence() {
            @Override public int length() { return LINK.length(); }
            @Override public char charAt(int index) { return LINK.charAt(index); }
            @Override public CharSequence subSequence(int start, int end) { throw new AssertionError(); }
            @Override public String toString() { throw new AssertionError("Untrusted conversion must not run"); }
        };
        assertEquals(LINK, NativePaymentInput.boundedText(text));
        assertEquals(1024, NativePaymentInput.boundedText("a".repeat(1024)).length());
        for (String invalid : new String[] { null, "", "a".repeat(1025) }) {
            try { NativePaymentInput.boundedText(invalid); fail(); }
            catch (IllegalArgumentException expected) { assertEquals("INVALID_PAYMENT_LINK", expected.getMessage()); }
        }
    }

    @Test public void schemeCheckAndBoundAreIndependentOfFullMainnetValidation() {
        NativePaymentInput.Mailbox mailbox = new NativePaymentInput.Mailbox();
        assertTrue(mailbox.offer(VIEW, "CONNECTCOIN:cc1pfixture"));
        assertEquals("CONNECTCOIN:cc1pfixture", mailbox.take().text);
        String limit = "connectcoin:" + "a".repeat(1024 - "connectcoin:".length());
        assertTrue(mailbox.offer(VIEW, limit));
        assertEquals(limit, mailbox.take().text);
    }

    @Test public void closeDiscardsStoredAndLateInputs() {
        NativePaymentInput.Mailbox mailbox = new NativePaymentInput.Mailbox();
        assertTrue(mailbox.offer(VIEW, LINK));
        mailbox.close();
        assertNull(mailbox.take());
        assertFalse(mailbox.offer(VIEW, LINK));
        assertNull(mailbox.take());
    }
}
