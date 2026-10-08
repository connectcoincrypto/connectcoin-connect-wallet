import Foundation
import CoreFoundation

// Strict accessors for public financial data. In particular, NSNumber's
// conversion of booleans and floating point values to integers is forbidden.
enum PJ {
    static func require(_ valid: Bool, _ message: String) throws { if !valid { throw WalletError(message) } }
    static func string(_ value: Any?) throws -> String {
        guard let value = value as? String else { throw WalletError("Invalid payment text field.") }; return value
    }
    static func integer(_ value: Any?, _ min: Int64 = 0, _ max: Int64 = Int64.max) throws -> Int64 {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              !["f", "d"].contains(String(cString: value.objCType)) else { throw WalletError("Invalid payment integer field.") }
        let number = value.int64Value
        try require(number >= min && number <= max && value.stringValue == String(number), "Invalid payment integer field.")
        return number
    }
    static func bool(_ value: Any?) throws -> Bool {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw WalletError("Invalid payment Boolean field.") }
        return value.boolValue
    }
    static func object(_ value: Any?) throws -> JSONObject { guard let value = value as? JSONObject else { throw WalletError("Invalid payment object.") }; return value }
    static func array(_ value: Any?) throws -> [Any] { guard let value = value as? [Any] else { throw WalletError("Invalid payment array.") }; return value }
    static func objects(_ value: Any?) throws -> [JSONObject] { try array(value).map { try object($0) } }
    static func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: "\\A(?:" + pattern + ")\\z", options: .regularExpression) != nil }
    static func hash(_ value: Any?) throws -> String { let value = try string(value); try require(matches(value, "[0-9a-f]{64}"), "Invalid payment hash."); return value }
    static func keys(_ value: JSONObject, _ expected: [String]) throws { try require(Set(value.keys) == Set(expected), "Invalid payment schema.") }
    static func null(_ value: Any?) -> Bool { value is NSNull }
    static func money(_ object: JSONObject, _ key: String) throws -> Int64 { try NativeTransactions.amount(string(object[key])) }
    static func add(_ lhs: Int64, _ rhs: Int64) throws -> Int64 {
        let result = lhs.addingReportingOverflow(rhs); try require(!result.overflow, "Amount exceeds the money range.")
        return try NativeTransactions.amount(String(result.partialValue))
    }
    static func data(_ object: JSONObject) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
    static func read(_ data: Data, max: Int) throws -> JSONObject {
        try require(data.count <= max && String(data: data, encoding: .utf8) != nil, "Payment storage exceeds its safe limit or is invalid UTF-8.")
        return try object(JSONSerialization.jsonObject(with: data))
    }
    static func equal(_ lhs: Any?, _ rhs: Any?) -> Bool {
        if let a = lhs as? JSONObject, let b = rhs as? JSONObject { return Set(a.keys) == Set(b.keys) && a.keys.allSatisfy { equal(a[$0], b[$0]) } }
        if let a = lhs as? [Any], let b = rhs as? [Any] { return a.count == b.count && zip(a, b).allSatisfy { equal($0.0, $0.1) } }
        if let a = lhs as? String, let b = rhs as? String { return a == b }
        if let a = lhs as? NSNumber, let b = rhs as? NSNumber {
            return (CFGetTypeID(a) == CFBooleanGetTypeID()) == (CFGetTypeID(b) == CFBooleanGetTypeID())
                && ["f", "d"].contains(String(cString: a.objCType)) == ["f", "d"].contains(String(cString: b.objCType)) && a == b
        }
        return lhs is NSNull && rhs is NSNull
    }
    static func snapshot(_ object: JSONObject) -> JSONObject {
        // Detach nested mutable Foundation containers while retaining immutable
        // strings, including large raw parents shared by thousands of outputs.
        func copy(_ value: Any) -> Any {
            if let dictionary = value as? JSONObject { return dictionary.mapValues(copy) }
            if let array = value as? [Any] { return array.map(copy) }
            return value
        }
        return object.mapValues(copy)
    }
    static func outpoint(_ value: JSONObject) throws -> String { try hash(value["txid"]) + ":" + String(integer(value["vout"], 0, 0xffff_ffff)) }
}

/// Bounded 257-bit arithmetic used only for the native bounty target formula.
/// No floating point, decimal rounding, or general-purpose bignum dependency.
enum PaymentTarget {
    static let maximum = "115792089237316195423570985008687907853269984665640564039457584007913129639936"
    static func target(_ decimal: String) throws -> String {
        try PJ.require(PJ.matches(decimal, "[1-9][0-9]{0,77}") && (decimal.count < maximum.count || decimal.count == maximum.count && decimal <= maximum), "Expected connections out of range.")
        var divisor = [UInt8](repeating: 0, count: 33)
        for digit in decimal.utf8 {
            var carry = Int(digit - 48)
            for i in stride(from: 32, through: 0, by: -1) { carry += Int(divisor[i]) * 10; divisor[i] = UInt8(carry & 255); carry >>= 8 }
            try PJ.require(carry == 0, "Expected connections out of range.")
        }
        var remainder = [UInt8](repeating: 0, count: 33), quotient = remainder
        for bit in stride(from: 256, through: 0, by: -1) {
            var carry = bit == 256 ? 1 : 0
            for i in stride(from: 32, through: 0, by: -1) { let n = Int(remainder[i]) * 2 + carry; remainder[i] = UInt8(n & 255); carry = n >> 8 }
            if !remainder.lexicographicallyPrecedes(divisor) {
                var borrow = 0
                for i in stride(from: 32, through: 0, by: -1) { let n = Int(remainder[i]) - Int(divisor[i]) - borrow; remainder[i] = UInt8((n + 256) & 255); borrow = n < 0 ? 1 : 0 }
                quotient[32 - bit / 8] |= UInt8(1 << (bit % 8))
            }
        }
        for i in stride(from: 32, through: 0, by: -1) { if quotient[i] > 0 { quotient[i] -= 1; break }; quotient[i] = 255 }
        try PJ.require(quotient[0] == 0, "Invalid bounty target.")
        return WalletCrypto.hex(Data(quotient.dropFirst()))
    }
}
