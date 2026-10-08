package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

/** Validate strict, bounded JSON before Android's intentionally lenient parser. */
final class StrictWalletJson {
    private final String text;
    private int at, values;
    private StrictWalletJson(String text) { this.text = text; }
    static JSONObject object(String text) {
        try {
            if (text == null) throw invalid();
            StrictWalletJson parser = new StrictWalletJson(text);
            parser.space(); if (parser.peek() != '{') throw invalid();
            parser.value(0); parser.space();
            if (parser.at != text.length()) throw invalid();
            return new JSONObject(text);
        } catch (org.json.JSONException invalid) { throw invalid(); }
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("Invalid wallet JSON data"); }
    private char peek() { return at < text.length() ? text.charAt(at) : '\0'; }
    private void space() { while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) at++; }
    private void expect(char wanted) { if (peek() != wanted || at >= text.length()) throw invalid(); at++; }
    private void value(int depth) {
        if (depth > 32 || ++values > 8192) throw invalid();
        space(); char next = peek();
        if (next == '{') {
            at++; space(); Set<String> keys = new HashSet<>();
            if (peek() == '}') { at++; return; }
            while (true) {
                space(); String key = string(); if (!keys.add(key)) throw invalid();
                space(); expect(':'); value(depth + 1); space();
                if (peek() == '}') { at++; return; }
                expect(',');
            }
        }
        if (next == '[') {
            at++; space(); if (peek() == ']') { at++; return; }
            while (true) {
                value(depth + 1); space(); if (peek() == ']') { at++; return; }
                expect(',');
            }
        }
        if (next == '"') { string(); return; }
        for (String literal : new String[]{"true", "false", "null"}) {
            if (text.startsWith(literal, at)) { at += literal.length(); return; }
        }
        number();
    }
    private String string() {
        expect('"'); StringBuilder result = new StringBuilder();
        while (at < text.length()) {
            char next = text.charAt(at++);
            if (next == '"') {
                for (int i = 0; i < result.length(); i++) {
                    char character = result.charAt(i);
                    if (Character.isHighSurrogate(character)) {
                        if (++i >= result.length() || !Character.isLowSurrogate(result.charAt(i))) throw invalid();
                    } else if (Character.isLowSurrogate(character)) throw invalid();
                }
                return result.toString();
            }
            if (next < 0x20) throw invalid();
            if (next == '\\') {
                if (at >= text.length()) throw invalid(); next = text.charAt(at++);
                switch (next) {
                    case '"': case '\\': case '/': break;
                    case 'b': next = '\b'; break;
                    case 'f': next = '\f'; break;
                    case 'n': next = '\n'; break;
                    case 'r': next = '\r'; break;
                    case 't': next = '\t'; break;
                    case 'u':
                        if (at + 4 > text.length()) throw invalid();
                        int value = 0;
                        for (int i = 0; i < 4; i++) {
                            char digit = text.charAt(at++);
                            int hex = digit >= '0' && digit <= '9' ? digit - '0' : digit >= 'a' && digit <= 'f' ? digit - 'a' + 10 : digit >= 'A' && digit <= 'F' ? digit - 'A' + 10 : -1;
                            if (hex < 0) throw invalid(); value = value * 16 + hex;
                        }
                        next = (char)value; break;
                    default: throw invalid();
                }
            }
            result.append(next);
        }
        throw invalid();
    }
    private void number() {
        int start = at; if (peek() == '-') at++;
        if (peek() == '0') at++;
        else {
            if (peek() < '1' || peek() > '9') throw invalid();
            while (peek() >= '0' && peek() <= '9') at++;
        }
        if (peek() == '.') { at++; digits(); }
        if (peek() == 'e' || peek() == 'E') { at++; if (peek() == '+' || peek() == '-') at++; digits(); }
        if (at - start > 128) throw invalid();
        try { if (!Double.isFinite(Double.parseDouble(text.substring(start, at)))) throw invalid(); }
        catch (NumberFormatException malformed) { throw invalid(); }
    }
    private void digits() {
        if (peek() < '0' || peek() > '9') throw invalid();
        while (peek() >= '0' && peek() <= '9') at++;
    }
}
