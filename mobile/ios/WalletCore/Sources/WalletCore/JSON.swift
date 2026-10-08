import Foundation
import CoreFoundation

public typealias JSONObject = [String: Any]
public typealias JSONArray = [Any]

public struct WalletError: Error, LocalizedError, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public func walletRequire(_ condition: Bool, _ message: String) throws {
    if !condition { throw WalletError(message) }
}

/// JSON at the native boundary must not silently coerce booleans or floating-point money.
public enum JSON {
    public static func require(_ condition: Bool, _ message: String) throws { try walletRequire(condition, message) }
    public static func object(_ value: Any) throws -> JSONObject {
        guard let result = value as? JSONObject else { throw WalletError("Expected JSON object") }; return result
    }
    public static func array(_ value: Any) throws -> JSONArray {
        guard let result = value as? JSONArray else { throw WalletError("Expected JSON array") }; return result
    }
    public static func string(_ value: Any) throws -> String {
        guard let result = value as? String else { throw WalletError("Expected JSON string") }; return result
    }
    public static func integer(_ value: Any, min: Int64 = .min, max: Int64 = .max) throws -> Int64 {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              !["f", "d"].contains(String(cString: number.objCType)),
              let result = Int64(number.stringValue), result >= min, result <= max else {
            throw WalletError("Expected bounded JSON integer")
        }
        return result
    }
    public static func boolean(_ value: Any) throws -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw WalletError("Expected JSON boolean")
        }; return number.boolValue
    }
    public static func encode(_ value: JSONObject) throws -> Data {
        guard JSONSerialization.isValidJSONObject(value) else { throw WalletError("Invalid JSON data") }
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    public static func decode(_ data: Data, maxBytes: Int = 2 * 1024 * 1024) throws -> JSONObject {
        guard data.count <= maxBytes, String(data: data, encoding: .utf8) != nil else { throw WalletError("Invalid JSON data") }
        var parser = JSONPreflight(bytes: Array(data))
        try parser.document()
        return try object(JSONSerialization.jsonObject(with: data))
    }
    public static func clone(_ value: JSONObject) throws -> JSONObject { try decode(encode(value), maxBytes: 16 * 1024 * 1024) }
}

public extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) throws -> String { try JSON.string(self[key] ?? NSNull()) }
    func integer(_ key: String, min: Int64 = .min, max: Int64 = .max) throws -> Int64 { try JSON.integer(self[key] ?? NSNull(), min: min, max: max) }
    func boolean(_ key: String) throws -> Bool { try JSON.boolean(self[key] ?? NSNull()) }
    func object(_ key: String) throws -> JSONObject { try JSON.object(self[key] ?? NSNull()) }
    func array(_ key: String) throws -> JSONArray { try JSON.array(self[key] ?? NSNull()) }
    func has(_ key: String) -> Bool { self[key] != nil }
    func isNull(_ key: String) -> Bool { self[key] == nil || self[key] is NSNull }
}

/// Foundation accepts duplicate object keys. Reject those (including escaped aliases),
/// excessive nesting and malformed surrogate pairs before any wallet data is interpreted.
private struct JSONPreflight {
    let bytes: [UInt8]
    var at = 0
    var values = 0
    var next: UInt8 { at < bytes.count ? bytes[at] : 0 }
    mutating func space() { while [9, 10, 13, 32].contains(next) { at += 1 } }
    mutating func take(_ byte: UInt8) throws { guard next == byte, at < bytes.count else { throw WalletError("Invalid JSON data") }; at += 1 }
    mutating func document() throws {
        space(); guard next == 123 else { throw WalletError("Expected JSON object") }
        try value(0); space(); try walletRequire(at == bytes.count, "Invalid JSON data")
    }
    mutating func value(_ depth: Int) throws {
        values += 1
        try walletRequire(depth <= 32 && values <= 1_000_000, "JSON complexity limit exceeded")
        space()
        switch next {
        case 123:
            at += 1; space(); var keys = Set<String>()
            if next == 125 { at += 1; return }
            while true {
                space(); let key = try string()
                try walletRequire(keys.insert(key).inserted, "Duplicate JSON key")
                space(); try take(58); try value(depth + 1); space()
                if next == 125 { at += 1; break }; try take(44)
            }
        case 91:
            at += 1; space(); if next == 93 { at += 1; return }
            while true { try value(depth + 1); space(); if next == 93 { at += 1; break }; try take(44) }
        case 34: _ = try string()
        case 116: try literal("true")
        case 102: try literal("false")
        case 110: try literal("null")
        default: try number()
        }
    }
    mutating func literal(_ text: String) throws { for byte in text.utf8 { try take(byte) } }
    mutating func unicodeUnit() throws -> UInt16 {
        var result: UInt16 = 0
        for _ in 0..<4 {
            let n = next
            let digit: UInt16
            switch n { case 48...57: digit = UInt16(n - 48); case 65...70: digit = UInt16(n - 55); case 97...102: digit = UInt16(n - 87); default: throw WalletError("Invalid JSON escape") }
            result = result * 16 + digit; at += 1
        }; return result
    }
    mutating func string() throws -> String {
        let start = at; try take(34)
        while at < bytes.count {
            let n = next; at += 1
            if n == 34 {
                let decoded = try JSONSerialization.jsonObject(with: Data(bytes[start..<at]), options: .fragmentsAllowed)
                return try JSON.string(decoded)
            }
            try walletRequire(n >= 32, "Invalid JSON string")
            if n == 92 {
                let escape = next; at += 1
                if escape == 117 {
                    let unit = try unicodeUnit()
                    if (0xD800...0xDBFF).contains(unit) {
                        try take(92); try take(117)
                        let low = try unicodeUnit(); try walletRequire((0xDC00...0xDFFF).contains(low), "Invalid JSON surrogate")
                    } else { try walletRequire(!(0xDC00...0xDFFF).contains(unit), "Invalid JSON surrogate") }
                } else { try walletRequire([34, 92, 47, 98, 102, 110, 114, 116].contains(escape), "Invalid JSON escape") }
            }
        }; throw WalletError("Unterminated JSON string")
    }
    mutating func digits() throws {
        try walletRequire((48...57).contains(next), "Invalid JSON number")
        while (48...57).contains(next) { at += 1 }
    }
    mutating func number() throws {
        let start = at
        if next == 45 { at += 1 }
        if next == 48 { at += 1 } else { try walletRequire((49...57).contains(next), "Invalid JSON number"); try digits() }
        if next == 46 { at += 1; try digits() }
        if next == 101 || next == 69 { at += 1; if next == 43 || next == 45 { at += 1 }; try digits() }
        try walletRequire(at - start <= 128, "JSON number limit exceeded")
    }
}
