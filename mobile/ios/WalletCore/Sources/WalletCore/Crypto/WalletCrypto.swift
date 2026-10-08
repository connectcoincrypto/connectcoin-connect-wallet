import Foundation
import CConnectWallet

/// Native-only cryptographic functions. Secret input/output must never cross
/// Capacitor; the renderer receives public addresses and transaction results.
public enum WalletCrypto {
    public static func wipe(_ data: inout Data) {
        data.withUnsafeMutableBytes { cw_wallet_wipe($0.baseAddress, $0.count) }
        data.removeAll(keepingCapacity: false)
    }
    public static func random(_ count: Int) throws -> Data {
        guard count > 0, count <= 65_536 else { throw WalletError("Invalid random byte count") }
        var bytes = Data(count: count)
        let ok = bytes.withUnsafeMutableBytes { cw_wallet_random($0.bindMemory(to: UInt8.self).baseAddress, count) }
        guard ok == 1 else { wipe(&bytes); throw WalletError("Secure randomness is unavailable") }
        return bytes
    }
    public static func sha256(_ data: Data) throws -> Data {
        var result = Data(count: 32)
        let ok = result.withUnsafeMutableBytes { out in data.withUnsafeBytes { source in
            cw_wallet_sha256(source.bindMemory(to: UInt8.self).baseAddress, source.count, out.bindMemory(to: UInt8.self).baseAddress)
        } }
        guard ok == 1 else { throw WalletError("SHA-256 is unavailable") }
        return result
    }
    public static func hash256(_ data: Data) throws -> Data { try sha256(sha256(data)) }
    public static func taggedHash(_ tag: String, _ data: Data) throws -> Data {
        let prefix = try sha256(Data(tag.utf8))
        return try sha256(prefix + prefix + data)
    }
    public static func hmac512(_ key: Data, _ data: Data) throws -> Data {
        var result = Data(count: 64)
        let ok = result.withUnsafeMutableBytes { out in key.withUnsafeBytes { keyBytes in data.withUnsafeBytes { source in
            cw_wallet_hmac512(keyBytes.bindMemory(to: UInt8.self).baseAddress, keyBytes.count,
                source.bindMemory(to: UInt8.self).baseAddress, source.count, out.bindMemory(to: UInt8.self).baseAddress)
        } } }
        guard ok == 1 else { wipe(&result); throw WalletError("HMAC-SHA512 is unavailable") }
        return result
    }
    public static func hex(_ data: Data) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8](); out.reserveCapacity(data.count * 2)
        for byte in data { out.append(digits[Int(byte >> 4)]); out.append(digits[Int(byte & 15)]) }
        return String(decoding: out, as: UTF8.self)
    }
    public static func fromHex(_ text: String) throws -> Data {
        let chars = Array(text.utf8)
        guard chars.count <= 8_000_000, chars.count % 2 == 0 else { throw WalletError("Invalid hexadecimal data") }
        func nibble(_ c: UInt8) throws -> UInt8 {
            switch c { case 48...57: return c - 48; case 97...102: return c - 87; case 65...70: return c - 55
            default: throw WalletError("Invalid hexadecimal data") }
        }
        var data = Data(); data.reserveCapacity(chars.count / 2)
        for at in stride(from: 0, to: chars.count, by: 2) { data.append(try nibble(chars[at]) << 4 | nibble(chars[at + 1])) }
        return data
    }
    public static func validatePublicKey(_ key: Data) throws {
        guard key.count == 32, key.withUnsafeBytes({ cw_wallet_valid_public($0.bindMemory(to: UInt8.self).baseAddress) }) == 1 else {
            throw WalletError("Invalid 32-byte public key")
        }
    }
    public static func verifySchnorr(_ signature: Data, _ digest: Data, _ publicKey: Data) -> Bool {
        guard signature.count == 64, digest.count == 32, publicKey.count == 32 else { return false }
        return signature.withUnsafeBytes { sig in digest.withUnsafeBytes { hash in publicKey.withUnsafeBytes { key in
            cw_wallet_verify(sig.bindMemory(to: UInt8.self).baseAddress, hash.bindMemory(to: UInt8.self).baseAddress,
                key.bindMemory(to: UInt8.self).baseAddress) == 1
        } } }
    }
    private static let bech32 = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l".utf8)
    private static func polymod(_ values: [UInt8]) -> UInt32 {
        let generators: [UInt32] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
        var checksum: UInt32 = 1
        for value in [UInt8(3),3,0,3,3] + values {
            let high = checksum >> 25
            checksum = ((checksum & 0x1ffffff) << 5) ^ UInt32(value)
            for i in 0..<5 where ((high >> i) & 1) != 0 { checksum ^= generators[i] }
        }
        return checksum
    }
    private static func convertBits(_ input: [UInt8], from: Int, to: Int, pad: Bool) throws -> [UInt8] {
        var acc = 0, bits = 0, out = [UInt8]()
        let mask = (1 << to) - 1
        for byte in input {
            guard Int(byte) >> from == 0 else { throw WalletError("Invalid address encoding") }
            acc = ((acc << from) | Int(byte)) & ((1 << (from + to - 1)) - 1); bits += from
            while bits >= to { bits -= to; out.append(UInt8((acc >> bits) & mask)) }
        }
        if pad && bits > 0 { out.append(UInt8((acc << (to - bits)) & mask)) }
        else if !pad && (bits >= from || ((acc << (to - bits)) & mask) != 0) { throw WalletError("Noncanonical address padding") }
        return out
    }
    public static func encodeAddress(_ publicKey: Data) throws -> String {
        try validatePublicKey(publicKey)
        let words = try [UInt8(1)] + convertBits(Array(publicKey), from: 8, to: 5, pad: true)
        let check = polymod(words + [UInt8](repeating: 0, count: 6)) ^ 0x2bc830a3
        var out = Array("cc1".utf8) + words.map { bech32[Int($0)] }
        for i in 0..<6 { out.append(bech32[Int((check >> (5 * (5 - i))) & 31)]) }
        return String(decoding: out, as: UTF8.self)
    }
    public static func decodeAddress(_ address: String) throws -> Data {
        guard address.utf8.count == 62, address == address.lowercased() || address == address.uppercased() else { throw WalletError("Invalid ConnectCoin address") }
        let normalized = address.lowercased()
        guard normalized.hasPrefix("cc1") else { throw WalletError("Expected a mainnet ConnectCoin address") }
        let words = try normalized.utf8.dropFirst(3).map { byte -> UInt8 in
            guard let index = bech32.firstIndex(of: byte) else { throw WalletError("Invalid ConnectCoin address") }; return UInt8(index)
        }
        guard words.first == 1, polymod(words) == 0x2bc830a3 else { throw WalletError("Invalid ConnectCoin address checksum") }
        let key = Data(try convertBits(Array(words.dropFirst().dropLast(6)), from: 5, to: 8, pad: false))
        try validatePublicKey(key); return key
    }
    public static func normalizeMnemonic(_ text: String) throws -> String {
        guard text.utf16.count <= 1024 else { throw WalletError("Invalid recovery phrase") }
        let normalized = text.decomposedStringWithCompatibilityMapping.lowercased()
        func whitespace(_ code: UInt32) -> Bool {
            (9...13).contains(code) || code == 32 || code == 160 || code == 5760 || (8192...8202).contains(code)
                || code == 8232 || code == 8233 || code == 8239 || code == 8287 || code == 12288 || code == 65279
        }
        var out = "", separator = false
        for scalar in normalized.unicodeScalars {
            if whitespace(scalar.value) { separator = !out.isEmpty; continue }
            if separator { out.append(" ") }; out.unicodeScalars.append(scalar); separator = false
        }
        return out
    }
    public static func validateMnemonic(_ text: String) -> Bool {
        do {
            let words = try normalizeMnemonic(text).split(separator: " ")
            guard [12,18,24].contains(words.count) else { return false }
            let entropyBits = words.count / 3 * 32, checkBits = words.count / 3
            var entropy = Data(count: entropyBits / 8); defer { wipe(&entropy) }
            var checksum = 0
            for (i, word) in words.enumerated() {
                guard let index = EnglishWords.indices[String(word)] else { return false }
                for j in 0..<11 {
                    let bit = (index >> (10 - j)) & 1, at = i * 11 + j
                    if at < entropyBits { entropy[at / 8] |= UInt8(bit << (7 - at % 8)) }
                    else { checksum = (checksum << 1) | bit }
                }
            }
            return checksum == Int(try sha256(entropy)[0]) >> (8 - checkBits)
        } catch { return false }
    }
    public static func mnemonicFromEntropy(_ entropy: Data) throws -> String {
        guard [16,24,32].contains(entropy.count) else { throw WalletError("Invalid recovery entropy") }
        var checksum = try sha256(entropy); defer { wipe(&checksum) }
        let bits = entropy.count * 8, count = entropy.count / 4 * 3
        var words = [String](); words.reserveCapacity(count)
        for i in 0..<count {
            var word = 0
            for j in 0..<11 {
                let at = i * 11 + j
                let bit = at < bits ? (entropy[at / 8] >> (7 - at % 8)) & 1 : (checksum[0] >> (7 - (at - bits))) & 1
                word = (word << 1) | Int(bit)
            }
            words.append(EnglishWords.words[word])
        }
        return words.joined(separator: " ")
    }
    public static func generateMnemonic(_ count: Int = 24) throws -> String {
        guard [12,18,24].contains(count) else { throw WalletError("Choose 12, 18 or 24 recovery words") }
        var entropy = try random(count / 3 * 4); defer { wipe(&entropy) }
        return try mnemonicFromEntropy(entropy)
    }
    public static func mnemonicToSeed(_ mnemonic: String, _ passphrase: String) throws -> Data {
        let phrase = try normalizeMnemonic(mnemonic)
        guard validateMnemonic(phrase), passphrase.utf16.count <= 1024 else { throw WalletError("Invalid recovery phrase or passphrase") }
        var password = Data(phrase.utf8), salt = Data(("mnemonic" + passphrase.decomposedStringWithCompatibilityMapping).utf8)
        defer { wipe(&password); wipe(&salt) }
        var seed = Data(count: 64)
        let ok = seed.withUnsafeMutableBytes { out in password.withUnsafeBytes { pass in salt.withUnsafeBytes { saltBytes in
            cw_wallet_pbkdf512(pass.bindMemory(to: UInt8.self).baseAddress, pass.count, saltBytes.bindMemory(to: UInt8.self).baseAddress,
                saltBytes.count, out.bindMemory(to: UInt8.self).baseAddress)
        } } }
        guard ok == 1 else { wipe(&seed); throw WalletError("Cannot derive recovery seed") }
        return seed
    }
}
