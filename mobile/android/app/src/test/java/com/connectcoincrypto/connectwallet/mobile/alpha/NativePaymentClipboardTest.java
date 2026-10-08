package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;

import org.junit.Test;

public final class NativePaymentClipboardTest {
    @Test public void preservesAddressAndPaymentLinkForSharedValidation() {
        String address = "cc1p" + "q".repeat(58);
        assertEquals(address, NativePaymentClipboard.boundedText(address));
        String link = "connectcoin:" + address + "?amount=0.1&label=Hello%20there";
        assertEquals(link, NativePaymentClipboard.boundedText(link));
        assertEquals("  " + address + "  ", NativePaymentClipboard.boundedText("  " + address + "  "));
    }

    @Test public void rejectsMissingEmptyAndOversizedTextWithFixedMessage() {
        for (CharSequence text : new CharSequence[] { null, "", "private-clipboard-content".repeat(100) }) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> NativePaymentClipboard.boundedText(text));
            assertEquals(NativePaymentClipboard.INVALID_MESSAGE, error.getMessage());
            assertFalse(error.getMessage().contains("private-clipboard-content"));
        }
    }

    @Test public void acceptsExactLimitWithoutTruncation() {
        String text = "x".repeat(NativePaymentClipboard.MAX_LENGTH);
        assertEquals(text, NativePaymentClipboard.boundedText(text));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentClipboard.boundedText(text + "x"));
    }

    @Test public void boundsRawUtf16BeforeWhitespaceOrUnicodeNormalization() {
        assertThrows(IllegalArgumentException.class,
            () -> NativePaymentClipboard.boundedText(" ".repeat(1024) + "x"));
        String unicode = "\ud83d\ude00".repeat(512);
        assertEquals(unicode, NativePaymentClipboard.boundedText(unicode));
        assertThrows(IllegalArgumentException.class, () -> NativePaymentClipboard.boundedText(unicode + "x"));
    }

    @Test public void copiesCharactersWithoutCoercingText() {
        CharSequence text = new CharSequence() {
            public int length() { return 3; }
            public char charAt(int index) { return "abc".charAt(index); }
            public CharSequence subSequence(int start, int end) { throw new AssertionError("Unexpected subsequence conversion"); }
            public String toString() { throw new AssertionError("Unexpected text conversion"); }
        };
        assertEquals("abc", NativePaymentClipboard.boundedText(text));
    }

    @Test public void rejectsOversizedSequenceBeforeReadingItsCharacters() {
        CharSequence text = new CharSequence() {
            public int length() { return Integer.MAX_VALUE; }
            public char charAt(int index) { throw new AssertionError("Oversized text was read"); }
            public CharSequence subSequence(int start, int end) { throw new AssertionError("Oversized text was converted"); }
            public String toString() { throw new AssertionError("Oversized text was converted"); }
        };
        assertThrows(IllegalArgumentException.class, () -> NativePaymentClipboard.boundedText(text));
    }
}
