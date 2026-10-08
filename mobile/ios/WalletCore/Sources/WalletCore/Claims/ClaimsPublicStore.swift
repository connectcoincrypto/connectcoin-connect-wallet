import Foundation
import Darwin

/// Public claim receipts still need crash durability: a restart must never
/// forget that a socket write may already have submitted a transaction.
enum ClaimsPublicStore {
    static let maximumBytes = 4096

    static func read(_ url: URL) throws -> JSONObject {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        try walletRequire(attrs[.type] as? FileAttributeType == .typeRegular &&
            ((attrs[.size] as? NSNumber)?.intValue ?? Int.max) <= maximumBytes, "CLAIMS_RECEIPT_UNAVAILABLE")
        return try JSON.decode(Data(contentsOf: url), maxBytes: maximumBytes)
    }

    static func write(_ value: JSONObject, to url: URL) throws {
        let bytes = try JSON.encode(value)
        try walletRequire(!bytes.isEmpty && bytes.count <= maximumBytes, "CLAIMS_RECEIPT_UNAVAILABLE")
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(".claim-commit-" + UUID().uuidString)
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE") }
        var opened = true
        defer { if opened { Darwin.close(descriptor) }; try? FileManager.default.removeItem(at: temporary) }
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: temporary.path)
        #endif
        try bytes.withUnsafeBytes { source in
            var offset = 0
            while offset < source.count {
                let count = Darwin.write(descriptor, source.baseAddress!.advanced(by: offset), source.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE") }
                offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE") }
        guard Darwin.close(descriptor) == 0 else { opened = false; throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE") }
        opened = false
        guard Darwin.rename(temporary.path, url.path) == 0 else { throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE") }
        let folder = Darwin.open(directory.path, O_RDONLY)
        guard folder >= 0 else { throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE") }
        let synced = fsync(folder); Darwin.close(folder)
        guard synced == 0, try Data(contentsOf: url) == bytes else { throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE") }
    }
}
