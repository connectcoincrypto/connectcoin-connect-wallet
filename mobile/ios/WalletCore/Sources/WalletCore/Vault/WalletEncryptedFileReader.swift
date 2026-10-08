import Foundation
import Darwin

public enum WalletFileReadError: Error, LocalizedError, Equatable {
    case busy, timedOut, invalidFile
    public var errorDescription: String? {
        switch self {
        case .busy: return "A file provider is still finishing an earlier read. Try again when it has finished."
        case .timedOut: return "The file provider did not respond in time. Save a local copy and try again."
        case .invalidFile: return "Choose a valid encrypted wallet file saved on this device."
        }
    }
}

/// The process has exactly one provider-read lease. Cancellation/deadline stop
/// the caller promptly, but cannot revoke an OS read: its lease and security
/// scope remain held until that worker actually exits. No canceled read can
/// publish bytes, and a stuck provider cannot create an unbounded thread queue.
public enum WalletEncryptedFileReader {
    private static let coordinator = WalletFileReadCoordinator(timeout: 30, worker: readFile)

    public static func read(_ url: URL) async throws -> Data {
        try await coordinator.read(url)
    }

    static func readFile(_ url: URL, check: () throws -> Void) throws -> Data {
        try check()
        guard url.isFileURL else { throw WalletFileReadError.invalidFile }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        try check()
        // Nonblocking rejects FIFO/device reads without tying up the lease;
        // regular cloud-provider files can still block inside open/read.
        let descriptor = url.withUnsafeFileSystemRepresentation { path -> Int32 in
            guard let path else { return -1 }
            return Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        }
        guard descriptor >= 0 else { throw WalletFileReadError.invalidFile }
        defer { _ = Darwin.close(descriptor) }
        try check()
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0,
              metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              metadata.st_size > 0, metadata.st_size <= Int64(WalletVault.maxFileBytes) else {
            throw WalletFileReadError.invalidFile
        }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        // Recheck the actual bytes; a provider can change size after fstat.
        while data.count <= WalletVault.maxFileBytes {
            try check()
            let count = min(buffer.count, WalletVault.maxFileBytes + 1 - data.count)
            let received = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, count) }
            if received < 0 {
                if errno == EINTR { continue }
                throw WalletFileReadError.invalidFile
            }
            if received == 0 { break }
            data.append(contentsOf: buffer.prefix(received))
        }
        try check()
        guard !data.isEmpty, data.count <= WalletVault.maxFileBytes else { throw WalletFileReadError.invalidFile }
        _ = try WalletVault.parse(data)
        try check()
        return data
    }
}

/// Internal dependency injection lets tests emulate an uninterruptible provider
/// without accessing a real provider or waiting for the production deadline.
final class WalletFileReadCoordinator: @unchecked Sendable {
    typealias Worker = (URL, @escaping () throws -> Void) throws -> Data
    private let mutex = NSLock()
    private let worker: Worker
    private let timeout: TimeInterval
    private var active: Operation?

    init(timeout: TimeInterval, worker: @escaping Worker) {
        precondition(timeout > 0 && timeout.isFinite && timeout <= 30)
        self.timeout = timeout; self.worker = worker
    }

    var isBusy: Bool { mutex.lock(); defer { mutex.unlock() }; return active != nil }

    func read(_ url: URL) async throws -> Data {
        try Task.checkCancellation()
        let operation = Operation(deadline: .now() + timeout)
        let data: Data = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                operation.install(continuation)
                start(operation, url)
            }
        }, onCancel: { operation.resolve(.failure(CancellationError())) })
        // Also fence cancellation after the worker won the result race but
        // before the suspended caller resumed.
        try Task.checkCancellation()
        return data
    }

    private func start(_ operation: Operation, _ url: URL) {
        mutex.lock()
        do { try operation.check() } catch { mutex.unlock(); operation.resolve(.failure(error)); return }
        guard active == nil else {
            mutex.unlock(); operation.resolve(.failure(WalletFileReadError.busy)); return
        }
        active = operation
        mutex.unlock()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: operation.deadline)
        timer.setEventHandler { operation.resolve(.failure(WalletFileReadError.timedOut)) }
        timer.resume()
        operation.setTimer(timer)
        // Admission happens before dispatch. No pending read is queued while an
        // old provider is stuck, even when the old caller has already returned.
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let result = Result<Data, Error> {
                try operation.check()
                return try worker(url, operation.check)
            }
            mutex.lock()
            if active === operation { active = nil }
            mutex.unlock()
            operation.resolve(result)
        }
    }

    private final class Operation: @unchecked Sendable {
        let deadline: DispatchTime
        private let mutex = NSLock()
        private var continuation: CheckedContinuation<Data, Error>?
        private var result: Result<Data, Error>?
        private var timer: DispatchSourceTimer?

        init(deadline: DispatchTime) { self.deadline = deadline }

        func install(_ continuation: CheckedContinuation<Data, Error>) {
            mutex.lock()
            if let result { mutex.unlock(); continuation.resume(with: result); return }
            self.continuation = continuation
            mutex.unlock()
        }

        func setTimer(_ timer: DispatchSourceTimer) {
            mutex.lock()
            if result != nil { mutex.unlock(); timer.cancel(); return }
            self.timer = timer
            mutex.unlock()
        }

        func check() throws {
            mutex.lock(); let result = self.result; mutex.unlock()
            if let result { _ = try result.get(); throw CancellationError() }
            if DispatchTime.now().uptimeNanoseconds >= deadline.uptimeNanoseconds { throw WalletFileReadError.timedOut }
        }

        func resolve(_ proposed: Result<Data, Error>) {
            mutex.lock()
            guard self.result == nil else { mutex.unlock(); return }
            let result: Result<Data, Error>
            if case .success = proposed, DispatchTime.now().uptimeNanoseconds >= deadline.uptimeNanoseconds {
                result = .failure(WalletFileReadError.timedOut)
            } else { result = proposed }
            self.result = result
            let continuation = self.continuation, timer = self.timer
            self.continuation = nil; self.timer = nil
            mutex.unlock()
            timer?.cancel()
            continuation?.resume(with: result)
        }
    }
}
