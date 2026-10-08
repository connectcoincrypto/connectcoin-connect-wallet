import Foundation
import Darwin
import XCTest
@testable import WalletCore

final class WalletEncryptedFileReaderTests: XCTestCase {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        private var calls = 0
        private var outcome: Result<Data, Error>?
        func entered() -> Int { lock.lock(); defer { lock.unlock() }; calls += 1; return calls }
        var count: Int { lock.lock(); defer { lock.unlock() }; return calls }
        func save(_ result: Result<Data, Error>) { lock.lock(); outcome = result; lock.unlock() }
        var result: Result<Data, Error>? { lock.lock(); defer { lock.unlock() }; return outcome }
    }

    private let url = URL(fileURLWithPath: "/injected-provider/wallet.json")

    private func awaitIdle(_ reader: WalletFileReadCoordinator) async throws {
        for _ in 0..<200 {
            if !reader.isBusy { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Provider read lease was not released")
    }

    private func expectBusy(_ reader: WalletFileReadCoordinator) async {
        do { _ = try await reader.read(url); XCTFail("A second provider worker was admitted") }
        catch { XCTAssertEqual(error as? WalletFileReadError, .busy) }
    }

    func testCancellationReturnsPromptlyWithoutReleasingBlockedWorkerAndDiscardsLateBytes() async throws {
        let started = expectation(description: "OS worker started"), completed = expectation(description: "Caller canceled")
        let gate = DispatchSemaphore(value: 0), state = State()
        let reader = WalletFileReadCoordinator(timeout: 30) { _, _ in
            if state.entered() == 1 { started.fulfill(); gate.wait(); return Data("stale".utf8) }
            return Data("fresh".utf8)
        }
        // Intentionally ignore the injected check: a real OS read cannot be
        // forced to observe cancellation until it returns either.
        let task = Task {
            do { state.save(.success(try await reader.read(url))) }
            catch { state.save(.failure(error)) }
            completed.fulfill()
        }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        await fulfillment(of: [completed], timeout: 1)
        if case .failure(let error)? = state.result { XCTAssertTrue(error is CancellationError) }
        else { XCTFail("Canceled caller received provider bytes") }
        XCTAssertTrue(reader.isBusy)
        for _ in 0..<32 { await expectBusy(reader) }
        XCTAssertEqual(state.count, 1)
        gate.signal()
        try await awaitIdle(reader)
        let fresh = try await reader.read(url)
        XCTAssertEqual(fresh, Data("fresh".utf8))
        XCTAssertEqual(state.count, 2)
        if case .failure(let error)? = state.result { XCTAssertTrue(error is CancellationError) }
        else { XCTFail("Late provider completion replaced cancellation") }
    }

    func testDeadlineReturnsPromptlyAndRepeatedReadsCannotQueueMoreBlockedWorkers() async throws {
        let started = expectation(description: "OS worker started"), completed = expectation(description: "Deadline returned")
        let gate = DispatchSemaphore(value: 0), state = State()
        let reader = WalletFileReadCoordinator(timeout: 0.15) { _, _ in
            if state.entered() == 1 { started.fulfill(); gate.wait() }
            return Data("late".utf8)
        }
        let task = Task {
            do { state.save(.success(try await reader.read(url))) }
            catch { state.save(.failure(error)) }
            completed.fulfill()
        }
        await fulfillment(of: [started, completed], timeout: 2)
        if case .failure(let error)? = state.result { XCTAssertEqual(error as? WalletFileReadError, .timedOut) }
        else { XCTFail("Expired provider returned bytes") }
        XCTAssertTrue(reader.isBusy)
        for _ in 0..<32 { await expectBusy(reader) }
        XCTAssertEqual(state.count, 1)
        gate.signal()
        try await awaitIdle(reader)
        await task.value
        if case .failure(let error)? = state.result { XCTAssertEqual(error as? WalletFileReadError, .timedOut) }
        else { XCTFail("Late provider completion replaced deadline") }
        _ = try await reader.read(url)
        XCTAssertEqual(state.count, 2)
    }

    func testWorkerFailureReleasesLeaseAndPreCancelledTaskNeverEntersWorker() async throws {
        let state = State()
        let reader = WalletFileReadCoordinator(timeout: 1) { _, _ in
            _ = state.entered(); throw WalletFileReadError.invalidFile
        }
        do { _ = try await reader.read(url); XCTFail("Invalid file succeeded") }
        catch { XCTAssertEqual(error as? WalletFileReadError, .invalidFile) }
        XCTAssertFalse(reader.isBusy)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            do { _ = try await reader.read(url); XCTFail("Canceled read succeeded") }
            catch { XCTAssertTrue(error is CancellationError) }
        }
        await task.value
        XCTAssertEqual(state.count, 1)
        XCTAssertFalse(reader.isBusy)
    }

    func testNativeReadRequiresBoundedRegularEncryptedFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("WalletFileReaderTests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("wallet.json"), valid = Data(DesktopCryptoVectors.envelope.utf8)
        try valid.write(to: file)
        XCTAssertEqual(try WalletEncryptedFileReader.readFile(file, check: {}), valid)
        XCTAssertThrowsError(try WalletEncryptedFileReader.readFile(file, check: { throw CancellationError() }))
        XCTAssertThrowsError(try WalletEncryptedFileReader.readFile(directory, check: {}))
        XCTAssertThrowsError(try WalletEncryptedFileReader.readFile(URL(string: "https://example.invalid/wallet.json")!, check: {}))
        let link = directory.appendingPathComponent("symlink.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertThrowsError(try WalletEncryptedFileReader.readFile(link, check: {}))
        let fifo = directory.appendingPathComponent("pipe")
        XCTAssertEqual(fifo.withUnsafeFileSystemRepresentation { Darwin.mkfifo($0!, 0o600) }, 0)
        XCTAssertThrowsError(try WalletEncryptedFileReader.readFile(fifo, check: {}))
        for bytes in [Data(), Data("{}".utf8), Data(repeating: 65, count: WalletVault.maxFileBytes + 1)] {
            try bytes.write(to: file)
            XCTAssertThrowsError(try WalletEncryptedFileReader.readFile(file, check: {}))
        }
    }
}
