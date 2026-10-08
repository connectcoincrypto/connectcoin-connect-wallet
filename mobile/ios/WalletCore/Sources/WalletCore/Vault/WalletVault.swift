import Foundation
import CConnectWallet

/// The desktop v1 envelope and its exact authenticated header. Passwords,
/// decrypted payloads and update sessions belong only to native code.
public enum WalletVault {
    public static let maxFileBytes = 131_072 + 4_096
    public static let maxPlaintext = 65_536
    private static let format = "connectcoin-connect-wallet"
    private static let kdfJSON = "{\"name\":\"scrypt\",\"N\":131072,\"r\":8,\"p\":1,\"keyLength\":32}"
    public static func newPayload(_ name: String = "ConnectWallet", _ mnemonic: String, _ passphrase: String = "") throws -> JSONObject {
        try validatePayload(["name": name, "mnemonic": mnemonic, "network": "main", "passphrase": passphrase,
            "receiveIndex": 0, "changeIndex": 0, "lastUsedReceive": -1, "lastUsedChange": -1, "needsRecovery": false])
    }
    public static func newPayload(name: String = "ConnectWallet", mnemonic: String, passphrase: String = "") throws -> JSONObject {
        try newPayload(name, mnemonic, passphrase)
    }
    public static func validatePayload(_ payload: JSONObject) throws -> JSONObject {
        guard payload["network"] as? String == "main", let mnemonic = payload["mnemonic"] as? String,
              WalletCrypto.validateMnemonic(mnemonic) else { throw WalletError("Invalid mainnet wallet recovery data") }
        if let passphrase = payload["passphrase"] {
            guard let text = passphrase as? String, text.utf16.count <= 1024 else { throw WalletError("Invalid BIP39 passphrase") }
        }
        if let name = payload["name"] {
            guard let text = name as? String, text.utf16.count <= 200 else { throw WalletError("Invalid wallet name") }
        }
        for field in ["receiveIndex", "changeIndex", "lastUsedReceive", "lastUsedChange"] {
            if let value = payload[field] { _ = try JSON.integer(value, min: field.hasPrefix("lastUsed") ? -1 : 0, max: Int64(Int32.max)) }
        }
        for field in ["needsRecovery", "scanLookahead", "mobileHdRecovered"] {
            if let value = payload[field] { _ = try JSON.boolean(value) }
        }
        var encoded = try JSON.encode(payload); defer { WalletCrypto.wipe(&encoded) }
        guard encoded.count <= maxPlaintext else { throw WalletError("Wallet data is too large") }
        var clean = try JSON.decode(encoded, maxBytes: maxPlaintext)
        clean["mnemonic"] = try WalletCrypto.normalizeMnemonic(mnemonic)
        if clean["passphrase"] == nil { clean["passphrase"] = "" }
        return clean
    }
    public static func validatePassword(_ password: String) throws {
        guard password.utf16.count >= 12, password.utf16.count <= 1024, password.utf8.count <= 1024 else {
            throw WalletError("Use a wallet password of at least 12 characters (maximum 1,024 bytes)")
        }
    }
    public static func encrypt(_ payload: JSONObject, password: String) throws -> JSONObject {
        let session = try createForUpdate(payload, password: password); defer { session.close() }
        return try session.envelope()
    }
    public static func decrypt(_ envelope: JSONObject, password: String) throws -> JSONObject {
        let session = try openForUpdate(envelope, password: password); defer { session.close() }
        return try session.payload()
    }
    public static func createForUpdate(_ payload: JSONObject, password: String) throws -> NativeVaultUpdateSession {
        try validatePassword(password)
        let clean = try validatePayload(payload)
        var salt = try WalletCrypto.random(32); defer { WalletCrypto.wipe(&salt) }
        let key = try keyFor(password, salt: salt)
        do {
            let saltHex = WalletCrypto.hex(salt)
            let encrypted = try encryptWithKey(clean, key: key, salt: saltHex)
            return NativeVaultUpdateSession(key: key, salt: saltHex, payload: clean, envelope: encrypted)
        } catch { key.close(); throw error }
    }
    public static func openForUpdate(_ value: JSONObject, password: String) throws -> NativeVaultUpdateSession {
        do {
            try validatePassword(password); try validateEnvelope(value)
            let envelope = try JSON.clone(value)
            let key = try keyFor(password, salt: WalletCrypto.fromHex(envelope.string("salt")))
            do {
                let nonce = try WalletCrypto.fromHex(envelope.string("nonce"))
                let tag = try WalletCrypto.fromHex(envelope.string("tag"))
                let cipher = try WalletCrypto.fromHex(envelope.string("ciphertext"))
                let aad = Data(try header(envelope).utf8)
                var plain = Data(count: cipher.count); defer { WalletCrypto.wipe(&plain) }
                let ok = plain.withUnsafeMutableBytes { out in nonce.withUnsafeBytes { nonceBytes in aad.withUnsafeBytes { aadBytes in
                    cipher.withUnsafeBytes { encrypted in tag.withUnsafeBytes { tagBytes in
                        cw_wallet_gcm_decrypt(key.pointer, nonceBytes.bindMemory(to: UInt8.self).baseAddress,
                            aadBytes.bindMemory(to: UInt8.self).baseAddress, aadBytes.count,
                            encrypted.bindMemory(to: UInt8.self).baseAddress, encrypted.count,
                            tagBytes.bindMemory(to: UInt8.self).baseAddress, out.bindMemory(to: UInt8.self).baseAddress)
                    } }
                } } }
                guard ok == 1 else { throw WalletError("Wallet authentication failed") }
                let clean = try validatePayload(JSON.decode(plain, maxBytes: maxPlaintext))
                return NativeVaultUpdateSession(key: key, salt: try envelope.string("salt"), payload: clean, envelope: envelope)
            } catch { key.close(); throw error }
        } catch let error as WalletKDFError { throw error }
        catch { throw WalletError("Cannot unlock wallet: incorrect password or damaged wallet file") }
    }
    public static func changePassword(_ envelope: JSONObject, currentPassword: String, newPassword: String) throws -> JSONObject {
        // Authenticating the original payload preserves unknown desktop metadata,
        // passphrase and HD indexes; fresh creation replaces both salt and nonce.
        let old = try openForUpdate(envelope, password: currentPassword); defer { old.close() }
        return try encrypt(old.payload(), password: newPassword)
    }
    public static func parse(_ text: String) throws -> JSONObject { try parse(Data(text.utf8)) }
    public static func parse(_ data: Data) throws -> JSONObject {
        guard !data.isEmpty, data.count <= maxFileBytes else { throw WalletError("Unsafe or oversized wallet file") }
        let result = try JSON.decode(data, maxBytes: maxFileBytes); try validateEnvelope(result); return result
    }
    public static func serialize(_ envelope: JSONObject) throws -> String {
        try validateEnvelope(envelope)
        let h = try header(envelope)
        return String(h.dropLast()) + ",\"ciphertext\":\"" + (try envelope.string("ciphertext")) + "\",\"tag\":\"" + (try envelope.string("tag")) + "\"}"
    }
    public static func validateEnvelope(_ value: JSONObject) throws {
        guard value["format"] as? String == format, try value.integer("version") == 1,
              value["cipher"] as? String == "aes-256-gcm" else { throw WalletError("Unsupported encrypted wallet format") }
        let kdf = try value.object("kdf")
        guard Set(kdf.keys) == Set(["name", "N", "r", "p", "keyLength"]), kdf["name"] as? String == "scrypt",
              try kdf.integer("N") == 131072, try kdf.integer("r") == 8, try kdf.integer("p") == 1,
              try kdf.integer("keyLength") == 32 else { throw WalletError("Unsupported wallet KDF") }
        for (field,minimum,maximum) in [("salt",64,64),("nonce",24,24),("tag",32,32),("ciphertext",2,maxPlaintext * 2)] {
            let text = try value.string(field), bytes = Array(text.utf8)
            guard bytes.count >= minimum, bytes.count <= maximum, bytes.count % 2 == 0,
                  bytes.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw WalletError("Invalid encrypted wallet format") }
        }
    }
    private static func header(_ envelope: JSONObject) throws -> String {
        "{\"format\":\"" + format + "\",\"version\":1,\"kdf\":" + kdfJSON + ",\"cipher\":\"aes-256-gcm\",\"salt\":\""
            + (try envelope.string("salt")) + "\",\"nonce\":\"" + (try envelope.string("nonce")) + "\"}"
    }
    private static func keyFor(_ password: String, salt: Data) throws -> NativeVaultKey {
        guard salt.count == 32 else { throw WalletError("Invalid wallet salt") }
        var bytes = Data(password.utf8); defer { WalletCrypto.wipe(&bytes) }
        let key = NativeVaultKey()
        let result = bytes.withUnsafeBytes { pass in salt.withUnsafeBytes { saltBytes in
            cw_wallet_scrypt(pass.bindMemory(to: UInt8.self).baseAddress, pass.count,
                saltBytes.bindMemory(to: UInt8.self).baseAddress, key.pointer)
        } }
        guard result == 1 else {
            key.close()
            if result == -1 { throw WalletKDFError() }
            throw WalletError("Cannot derive wallet encryption key")
        }
        return key
    }
    fileprivate static func encryptWithKey(_ payload: JSONObject, key: NativeVaultKey, salt: String) throws -> JSONObject {
        var plain = try JSON.encode(payload); defer { WalletCrypto.wipe(&plain) }
        guard !plain.isEmpty, plain.count <= maxPlaintext else { throw WalletError("Wallet data is too large") }
        let nonce = try WalletCrypto.random(12)
        var envelope: JSONObject = ["format": format, "version": 1,
            "kdf": ["name": "scrypt", "N": 131072, "r": 8, "p": 1, "keyLength": 32] as JSONObject,
            "cipher": "aes-256-gcm", "salt": salt, "nonce": WalletCrypto.hex(nonce)]
        let aad = Data(try header(envelope).utf8)
        var cipher = Data(count: plain.count), tag = Data(count: 16)
        let ok = cipher.withUnsafeMutableBytes { encrypted in tag.withUnsafeMutableBytes { tagBytes in
            nonce.withUnsafeBytes { nonceBytes in aad.withUnsafeBytes { aadBytes in plain.withUnsafeBytes { source in
                cw_wallet_gcm_encrypt(key.pointer, nonceBytes.bindMemory(to: UInt8.self).baseAddress,
                    aadBytes.bindMemory(to: UInt8.self).baseAddress, aadBytes.count, source.bindMemory(to: UInt8.self).baseAddress,
                    source.count, encrypted.bindMemory(to: UInt8.self).baseAddress, tagBytes.bindMemory(to: UInt8.self).baseAddress)
            } } }
        } }
        guard ok == 1 else { throw WalletError("Cannot encrypt wallet") }
        envelope["ciphertext"] = WalletCrypto.hex(cipher); envelope["tag"] = WalletCrypto.hex(tag)
        return envelope
    }
}

private struct WalletKDFError: Error, LocalizedError {
    var errorDescription: String? { "Not enough memory for the desktop-compatible wallet KDF. Close other apps and retry; wallet data was not changed." }
}

/// Fixed allocation avoids Data's copy-on-write storage for retained keys.
fileprivate final class NativeVaultKey {
    let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: 32)
    init() { pointer.initialize(repeating: 0, count: 32) }
    deinit { close(); pointer.deallocate() }
    func close() { cw_wallet_wipe(pointer, 32) }
    func copy() -> NativeVaultKey { let key = NativeVaultKey(); key.pointer.update(from: pointer, count: 32); return key }
}

/// Native-only unlocked metadata writer. Close revokes it without waiting for
/// disk I/O. Its owner must also fence the writer's final filesystem commit by
/// lifecycle generation, as the Android AtomicFile owner does.
public final class NativeVaultUpdateSession {
    private let mutex = NSLock()
    private var key: NativeVaultKey?
    private let salt: String
    private var savedPayload: JSONObject?, savedEnvelope: JSONObject?
    private var saving = false
    fileprivate init(key: NativeVaultKey, salt: String, payload: JSONObject, envelope: JSONObject) {
        self.key = key; self.salt = salt; savedPayload = payload; savedEnvelope = envelope
    }
    deinit { close() }
    public var isClosed: Bool { mutex.lock(); defer { mutex.unlock() }; return key == nil }
    public func close() {
        mutex.lock(); defer { mutex.unlock() }
        key?.close(); key = nil; savedPayload = nil; savedEnvelope = nil
    }
    public func payload() throws -> JSONObject {
        mutex.lock(); defer { mutex.unlock() }
        guard key != nil, let payload = savedPayload else { throw WalletError("Wallet is locked") }
        return try JSON.clone(payload)
    }
    public func envelope() throws -> JSONObject {
        mutex.lock(); defer { mutex.unlock() }
        guard key != nil, let envelope = savedEnvelope else { throw WalletError("Wallet is locked") }
        return try JSON.clone(envelope)
    }
    public func save(_ next: JSONObject, writer: (JSONObject) throws -> Void) throws {
        let candidate = try WalletVault.validatePayload(next)
        let localKey: NativeVaultKey
        mutex.lock()
        do {
            guard let key = key, let payload = savedPayload else { throw WalletError("Wallet is locked") }
            guard !saving else { throw WalletError("A wallet update is already in progress") }
            for field in ["mnemonic", "passphrase", "network"] {
                guard candidate[field] as? String == payload[field] as? String else { throw WalletError("Wallet identity cannot change during an update") }
            }
            localKey = key.copy(); saving = true; mutex.unlock()
        } catch { mutex.unlock(); throw error }
        defer { localKey.close(); mutex.lock(); saving = false; mutex.unlock() }
        let encrypted = try WalletVault.encryptWithKey(candidate, key: localKey, salt: salt)
        mutex.lock(); let stillOpen = key != nil; mutex.unlock()
        guard stillOpen else { throw WalletError("Wallet is locked") }
        try writer(encrypted)
        mutex.lock(); defer { mutex.unlock() }
        guard key != nil else { throw WalletError("Wallet is locked") }
        savedPayload = candidate; savedEnvelope = encrypted
    }
}
