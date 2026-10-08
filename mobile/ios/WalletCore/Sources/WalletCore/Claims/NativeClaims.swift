import Foundation
import CConnectWallet

public enum NativeClaims {
    // A handle can be cancelled from the Swift task cancellation callback while
    // its owning native worker is blocked. Destruction shares the same lock.
    private final class Lease {
        private let mutex = NSLock()
        private var handle: Int64
        init() throws {
            var error = [CChar](repeating: 0, count: 32)
            handle = cw_claim_cancellation_create(0, &error)
            try walletRequire(handle != 0, String(cString: error))
        }
        func cancel() { mutex.lock(); defer { mutex.unlock() }; if handle != 0 { cw_claim_cancel(handle) } }
        func close() { mutex.lock(); defer { mutex.unlock() }; if handle != 0 { cw_claim_cancellation_destroy(handle); handle = 0 } }
        var value: Int64 { mutex.lock(); defer { mutex.unlock() }; return handle }
        deinit { close() }
    }

    /// Advisory completed-handshake RSA probe. No proof, wallet secret, or
    /// transaction enters this operation. Production roots/public DNS only.
    public static func probeRsa(domain: String, validationTime: Int64, timeoutMs: Int32 = 3000) async throws -> String {
        try walletRequire(NativeTransactions.canonicalDomain(domain) && (1...3000).contains(timeoutMs), "CLAIM_CONTEXT")
        let lease = try Lease()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            let result: String = try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    defer { lease.close() }
                    var status = [CChar](repeating: 0, count: 16), error = [CChar](repeating: 0, count: 32)
                    let ok = domain.withCString { cw_claim_probe_rsa($0, validationTime, timeoutMs, lease.value, &status, &error) }
                    if ok == 1 { continuation.resume(returning: String(cString: status)) }
                    else { continuation.resume(throwing: WalletError(String(cString: error))) }
                }
            }
            try Task.checkCancellation()
            return result
        }, onCancel: { lease.cancel() })
    }
}
