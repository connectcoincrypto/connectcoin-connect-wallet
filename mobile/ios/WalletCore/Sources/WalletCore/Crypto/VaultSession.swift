import Foundation
import CConnectWallet

/// Owns two private BIP32 branches in C memory. Only public accounts and
/// signatures are returned to native callers. The UI bridge cannot sign digests.
public final class VaultSession {
    private let mutex = NSLock()
    private var handle: OpaquePointer?
    public init(mnemonic: String, passphrase: String = "") throws {
        var seed = try WalletCrypto.mnemonicToSeed(mnemonic, passphrase)
        defer { WalletCrypto.wipe(&seed) }
        handle = seed.withUnsafeBytes { cw_wallet_session_create($0.bindMemory(to: UInt8.self).baseAddress, $0.count) }
        guard handle != nil else { throw WalletError("Cannot derive wallet branches") }
    }
    deinit { lock() }
    public var isLocked: Bool { mutex.lock(); defer { mutex.unlock() }; return handle == nil }
    public func lock() {
        mutex.lock(); defer { mutex.unlock() }
        if let pointer = handle { cw_wallet_session_destroy(pointer); handle = nil }
    }
    public func close() { lock() }
    private func requireIndex(_ index: Int, _ change: Int) throws -> OpaquePointer {
        guard let pointer = handle else { throw WalletError("Wallet is locked") }
        guard index >= 0, index <= Int(Int32.max), change == 0 || change == 1 else { throw WalletError("Invalid derivation index") }
        return pointer
    }
    public func publicAccount(index: Int, change: Int) throws -> [String: Any] {
        mutex.lock(); defer { mutex.unlock() }
        let pointer = try requireIndex(index, change)
        var key = Data(count: 32)
        let ok = key.withUnsafeMutableBytes { cw_wallet_session_public(pointer, UInt32(index), UInt32(change), $0.bindMemory(to: UInt8.self).baseAddress) }
        guard ok == 1 else { throw WalletError("Cannot derive wallet address") }
        return ["publicKey": WalletCrypto.hex(key), "address": try WalletCrypto.encodeAddress(key),
            "path": "m/44'/0'/0'/\(change)/\(index)", "network": "main", "index": index, "change": change]
    }
    public func signDigest(_ digest: Data, index: Int, change: Int) throws -> Data {
        mutex.lock(); defer { mutex.unlock() }
        let pointer = try requireIndex(index, change)
        guard digest.count == 32 else { throw WalletError("Expected a 32-byte signing digest") }
        var signature = Data(count: 64)
        let ok = signature.withUnsafeMutableBytes { out in digest.withUnsafeBytes { message in
            cw_wallet_session_sign(pointer, UInt32(index), UInt32(change), message.bindMemory(to: UInt8.self).baseAddress,
                out.bindMemory(to: UInt8.self).baseAddress)
        } }
        guard ok == 1 else { WalletCrypto.wipe(&signature); throw WalletError("Cannot sign wallet transaction") }
        return signature
    }
}
