import Foundation
import Darwin

/// Serialize the short storage commit with lock/replacement. Expensive KDFs and
/// network reads happen outside this fence; stale work cannot replace a wallet.
final class WalletLifecycleFence {
    private let lock = NSRecursiveLock()
    private var generation: UInt64 = 0
    func invalidate() -> UInt64 { lock.lock(); defer { lock.unlock() }; generation &+= 1; return generation }
    func token() -> UInt64 { lock.lock(); defer { lock.unlock() }; return generation }
    func check(_ token: UInt64) throws { lock.lock(); defer { lock.unlock() }; try walletRequire(token == generation, "Wallet operation was cancelled") }
    func commit<T>(_ token: UInt64, _ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }; try check(token); return try body()
    }
}

/// Encrypted vault and public transaction journal only. No mnemonic/password or
/// decrypted key material is ever written as a separate file or preference.
public final class DurableWalletStore: MobilePaymentBatchStore {
    public enum File: String { case vault = "wallet.enc.json", settings = "settings.json", reservations = "reservations.json", receipt = "payment-batch.json", payment = "last-payment.json" }
    private let directory: URL
    private let mutex = NSRecursiveLock()
    public init(directory: URL? = nil) throws {
        self.directory = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("ConnectWallet", isDirectory: true)
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var folder = self.directory; var resource = URLResourceValues(); resource.isExcludedFromBackup = true
        try folder.setResourceValues(resource)
    }
    public func exists(_ file: File) -> Bool { mutex.lock(); defer { mutex.unlock() }; return FileManager.default.fileExists(atPath: directory.appendingPathComponent(file.rawValue).path) }
    public func read(_ file: File, maxBytes: Int = 16 * 1024 * 1024) throws -> Data? {
        mutex.lock(); defer { mutex.unlock() }
        let path = directory.appendingPathComponent(file.rawValue)
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        let attrs = try FileManager.default.attributesOfItem(atPath: path.path)
        try walletRequire(attrs[.type] as? FileAttributeType == .typeRegular && ((attrs[.size] as? NSNumber)?.intValue ?? Int.max) <= maxBytes, "Unsafe or oversized wallet storage")
        let result = try Data(contentsOf: path); try walletRequire(result.count <= maxBytes, "Wallet storage limit exceeded"); return result
    }
    public func write(_ file: File, _ data: Data) throws {
        mutex.lock(); defer { mutex.unlock() }
        try walletRequire(!data.isEmpty && data.count <= 16 * 1024 * 1024, "Wallet storage limit exceeded")
        let target = directory.appendingPathComponent(file.rawValue), temporary = directory.appendingPathComponent(".commit-" + UUID().uuidString)
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw WalletError("Cannot create wallet storage transaction") }
        var opened = true
        defer { if opened { Darwin.close(descriptor) }; try? FileManager.default.removeItem(at: temporary) }
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: temporary.path)
        #endif
        try data.withUnsafeBytes { source in
            var offset = 0
            while offset < source.count {
                let count = Darwin.write(descriptor, source.baseAddress!.advanced(by: offset), source.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw WalletError("Cannot write wallet storage") }; offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw WalletError("Cannot synchronize wallet storage") }
        guard Darwin.close(descriptor) == 0 else { opened = false; throw WalletError("Cannot close wallet storage") }; opened = false
        guard Darwin.rename(temporary.path, target.path) == 0 else { throw WalletError("Cannot commit wallet storage") }
        let folder = Darwin.open(directory.path, O_RDONLY)
        guard folder >= 0 else { throw WalletError("Wallet storage outcome needs checking") }
        let synced = fsync(folder); Darwin.close(folder)
        guard synced == 0, try Data(contentsOf: target) == data else { throw WalletError("Wallet storage outcome needs checking") }
    }
    public func receipt() throws -> JSONObject? {
        guard let data = try read(.receipt) else { return nil }; return try MobilePaymentBatch.read(data)
    }
    public func reservations() throws -> JSONObject {
        guard let data = try read(.reservations) else { return [:] }; return try NativePaymentReservations.read(data)
    }
    public func saveReceipt(_ value: JSONObject) throws { try MobilePaymentBatch.validate(value); try write(.receipt, JSON.encode(value)) }
    public func saveReservations(_ value: JSONObject) throws { try NativePaymentReservations.validate(value); try write(.reservations, JSON.encode(value)) }
    public func readVault() throws -> JSONObject {
        guard let bytes = try read(.vault, maxBytes: WalletVault.maxFileBytes) else { throw WalletError("No wallet has been saved") }
        return try WalletVault.parse(bytes)
    }
    public func saveVault(_ value: JSONObject) throws { try write(.vault, Data(WalletVault.serialize(value).utf8)) }
}
