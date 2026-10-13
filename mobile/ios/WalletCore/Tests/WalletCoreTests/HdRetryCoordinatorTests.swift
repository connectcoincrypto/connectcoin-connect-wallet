import XCTest
@testable import WalletCore

private final class HdRetryFixture: @unchecked Sendable {
    struct Read { let method: String, params: JSONObject, atMs: Int }
    private let lock = NSLock()
    private var timeMs = 0, onlineAtMs = 0, valid = true
    private var reads: [Read] = [], sleeps: [Int] = [], statuses: [HdRetryStatus] = []

    func now() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return Double(timeMs) / 1000 }
    func online() -> Bool { lock.lock(); defer { lock.unlock() }; return timeMs >= onlineAtMs }
    func offline(until milliseconds: Int) { lock.lock(); onlineAtMs = milliseconds; lock.unlock() }
    func revoke() { lock.lock(); valid = false; lock.unlock() }
    func check() throws {
        lock.lock(); let current = valid; lock.unlock()
        if !current { throw CancellationError() }
    }
    func advance(_ milliseconds: Int) { lock.lock(); timeMs = milliseconds; lock.unlock() }
    func slept(_ milliseconds: Int) { lock.lock(); sleeps.append(milliseconds); timeMs += milliseconds; lock.unlock() }
    func record(_ method: String, _ params: JSONObject) -> Int {
        lock.lock(); defer { lock.unlock() }
        reads.append(Read(method: method, params: params, atMs: timeMs)); return reads.count
    }
    func report(_ status: HdRetryStatus) { lock.lock(); statuses.append(status); lock.unlock() }
    var requests: [Read] { lock.lock(); defer { lock.unlock() }; return reads }
    var delays: [Int] { lock.lock(); defer { lock.unlock() }; return sleeps }
    var progress: [HdRetryStatus] { lock.lock(); defer { lock.unlock() }; return statuses }
    func environment(jitter: Double = 0) -> HdRetryEnvironment {
        HdRetryEnvironment(now: now, sleep: { milliseconds in
            try Task.checkCancellation(); self.slept(milliseconds)
            await Task.yield(); try Task.checkCancellation()
        }, isOnline: online, jitter: { jitter })
    }
    func coordinator(jitter: Double = 0) -> HdRetryCoordinator {
        HdRetryCoordinator(environment: environment(jitter: jitter), check: check, progress: { self.report($0) })
    }
}

/// All concurrent workers share this clock. Waiting workers cannot themselves
/// advance time and accidentally shorten another worker's cooldown.
private final class HdRetryManualSleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [CheckedContinuation<Void, Error>] = []
    private var requested: [Int] = []
    private var stopped = false
    func sleep(_ milliseconds: Int) async throws {
        try await withCheckedThrowingContinuation { continuation in register(milliseconds, continuation) }
    }
    private func register(_ milliseconds: Int, _ continuation: CheckedContinuation<Void, Error>) {
        lock.lock()
        if stopped { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
        requested.append(milliseconds); pending.append(continuation); lock.unlock()
    }
    var count: Int { lock.lock(); defer { lock.unlock() }; return pending.count }
    var delays: [Int] { lock.lock(); defer { lock.unlock() }; return requested }
    func wakeAll() {
        lock.lock(); let waiting = pending; pending.removeAll(); lock.unlock()
        waiting.forEach { $0.resume() }
    }
    func stop() {
        lock.lock(); stopped = true; let waiting = pending; pending.removeAll(); lock.unlock()
        waiting.forEach { $0.resume(throwing: CancellationError()) }
    }
}

private final class HdRetryControlledReader: @unchecked Sendable {
    private let lock = NSLock()
    private var next = 0, stopped = false
    private var pending: [Int: CheckedContinuation<JSONObject, Error>] = [:]
    func read(_ method: String, _ params: JSONObject) async throws -> JSONObject {
        try await withCheckedThrowingContinuation { continuation in register(continuation) }
    }
    private func register(_ continuation: CheckedContinuation<JSONObject, Error>) {
        lock.lock()
        if stopped { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
        pending[next] = continuation; next += 1; lock.unlock()
    }
    var count: Int { lock.lock(); defer { lock.unlock() }; return next }
    func finish(_ id: Int, _ result: Result<JSONObject, Error>) {
        lock.lock(); let continuation = pending.removeValue(forKey: id); lock.unlock()
        continuation?.resume(with: result)
    }
    func stop() {
        lock.lock(); stopped = true; let waiting = Array(pending.values); pending.removeAll(); lock.unlock()
        waiting.forEach { $0.resume(throwing: CancellationError()) }
    }
}

final class HdRetryCoordinatorTests: XCTestCase {
    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<20_000 { if condition() { return }; await Task.yield() }
        XCTFail("Timed out waiting for deterministic HD retry fixture")
        throw WalletError("HD retry fixture timed out")
    }

    func testTransientReadsRetryTheIdenticalAddressAndCursor() async throws {
        for method in ["getaddresshistory", "getaddresschanges"] {
            for code in ["RPC_UNAVAILABLE", "RPC_TIMEOUT", "RPC_BUSY", "RPC_INACTIVE", "RPC_CANCELLED", "-32001", "-32030", "-32029"] {
                let fixture = HdRetryFixture(), coordinator = fixture.coordinator()
                let params: JSONObject = ["address": "fixture-address", "cursor": "same.cursor", "limit": 100]
                let result = try await coordinator.call(method, params) { method, params in
                    if fixture.record(method, params) == 1 { throw RpcFailure(code) }
                    return ["next_cursor": "next.cursor", "items": []]
                }
                XCTAssertEqual(result["next_cursor"] as? String, "next.cursor", code)
                XCTAssertEqual(fixture.requests.count, 2, code)
                XCTAssertEqual(fixture.requests.map(\.atMs), [0, 1_000], code)
                for request in fixture.requests {
                    XCTAssertEqual(request.method, method)
                    XCTAssertEqual(try JSON.encode(request.params), try JSON.encode(params))
                }
                XCTAssertTrue(fixture.progress.contains { $0.state == "retrying" && $0.errorCode == code })
                XCTAssertEqual(fixture.progress.last?.state, "scanning")
                XCTAssertEqual(fixture.progress.last?.retryAttempt, 0)
            }
        }
    }

    func testServerCooldownIsAFloorAndJitterOnlyAddsDelay() async throws {
        for (hint, jitter, expected) in [(12_345, 0.0, 12_345), (500, 1.0, 1_200), (0, 0.5, 1_100)] {
            let fixture = HdRetryFixture(), coordinator = fixture.coordinator(jitter: jitter)
            _ = try await coordinator.call("getaddresshistory", [:]) { method, params in
                if fixture.record(method, params) == 1 {
                    var failure = RpcFailure("-32029"); failure.retryAfterMs = hint; throw failure
                }
                return [:]
            }
            let retry = try XCTUnwrap(fixture.requests.last)
            XCTAssertGreaterThanOrEqual(retry.atMs, expected)
            XCTAssertLessThanOrEqual(retry.atMs, expected + 1)
            XCTAssertTrue(fixture.progress.contains { $0.retryAfterMs == expected && $0.retryAttempt == 0 })
            XCTAssertTrue(fixture.delays.allSatisfy { (1...100).contains($0) })
        }
    }

    func testEightFailedProbeRoundsExhaustWithSafeFailureAndStayClosed() async throws {
        let fixture = HdRetryFixture(), coordinator = fixture.coordinator()
        do {
            _ = try await coordinator.call("getaddresshistory", [:]) { method, params in
                _ = fixture.record(method, params); throw RpcFailure("RPC_UNAVAILABLE")
            }
            XCTFail("An unavailable node must exhaust the bounded retry budget")
        } catch let failure as HdRecoveryFailure {
            XCTAssertEqual(failure.code, "HD_RETRY_EXHAUSTED")
            XCTAssertEqual(failure.errorDescription, "HD recovery could not reconnect. Retry to continue scanning.")
        }
        XCTAssertEqual(fixture.requests.map(\.atMs), [0, 1_000, 3_000, 7_000, 15_000, 30_000, 60_000, 90_000, 120_000])
        XCTAssertEqual(fixture.progress.last?.state, "failed")
        XCTAssertEqual(fixture.progress.last?.retryAttempt, 8)
        do {
            _ = try await coordinator.call("getaddresschanges", [:]) { method, params in
                _ = fixture.record(method, params); return [:]
            }
            XCTFail("An exhausted coordinator must remain closed")
        } catch let failure as HdRecoveryFailure { XCTAssertEqual(failure.code, "HD_RETRY_EXHAUSTED") }
        XCTAssertEqual(fixture.requests.count, 9)
        let revisions = fixture.progress.map(\.revision)
        XCTAssertEqual(revisions, revisions.sorted())
        XCTAssertEqual(Set(revisions).count, revisions.count)
    }

    func testOfflineWaitDoesNotReadOrConsumeProbeRounds() async throws {
        let fixture = HdRetryFixture(); fixture.offline(until: 100_000)
        let coordinator = fixture.coordinator()
        _ = try await coordinator.call("getaddresshistory", [:]) { method, params in
            let attempt = fixture.record(method, params)
            if attempt == 1 { fixture.offline(until: 200_000); throw RpcFailure("RPC_UNAVAILABLE") }
            return [:]
        }
        XCTAssertEqual(fixture.requests.map(\.atMs), [100_000, 200_000])
        let offline = fixture.progress.filter { $0.state == "waiting-network" }
        XCTAssertFalse(offline.isEmpty)
        XCTAssertTrue(offline.allSatisfy { $0.retryAttempt == 0 })
        XCTAssertEqual(fixture.progress.map(\.retryAttempt).max(), 1)
        XCTAssertEqual(fixture.progress.last?.state, "scanning")
    }

    func testPermanentFailuresAndUnknownOutcomesNeverRetry() async throws {
        for (code, expected) in [("-32011", "HD_RESCAN_REQUIRED"), ("RPC_PROTOCOL", "HD_INVALID_RESPONSE"),
                                 ("-32602", "HD_RPC_REJECTED"), ("untrusted server text", "HD_RPC_REJECTED")] {
            let fixture = HdRetryFixture(), coordinator = fixture.coordinator()
            do {
                _ = try await coordinator.call("getaddresschanges", [:]) { method, params in
                    _ = fixture.record(method, params); throw RpcFailure(code)
                }
                XCTFail("Permanent failure unexpectedly succeeded")
            } catch let failure as HdRecoveryFailure {
                XCTAssertEqual(failure.code, expected)
                XCTAssertFalse(failure.message.contains("untrusted server text"))
            }
            XCTAssertEqual(fixture.requests.count, 1); XCTAssertTrue(fixture.delays.isEmpty)
        }
        let fixture = HdRetryFixture(), coordinator = fixture.coordinator()
        do {
            _ = try await coordinator.call("getaddresshistory", [:]) { method, params in
                _ = fixture.record(method, params)
                var failure = RpcFailure("RPC_UNAVAILABLE"); failure.unknownOutcome = true; throw failure
            }
            XCTFail("Unknown outcome unexpectedly succeeded")
        } catch let failure as HdRecoveryFailure { XCTAssertEqual(failure.code, "HD_RPC_REJECTED") }
        XCTAssertEqual(fixture.requests.count, 1); XCTAssertTrue(fixture.delays.isEmpty)
    }

    func testLegacyMethodUnavailableIsPreservedForJournalFallback() async throws {
        let fixture = HdRetryFixture(), coordinator = fixture.coordinator()
        do {
            _ = try await coordinator.call("getaddresschanges", [:]) { method, params in
                _ = fixture.record(method, params); throw RpcFailure("-32601")
            }
            XCTFail("Unavailable journal unexpectedly succeeded")
        } catch let failure as RpcFailure { XCTAssertEqual(failure.code, "-32601") }
        XCTAssertEqual(fixture.requests.count, 1); XCTAssertTrue(fixture.delays.isEmpty)
    }

    func testUnsupportedMethodsAreRejectedBeforeTheReader() async throws {
        for method in ["sendrawtransaction", "gettransaction", "getchaintip"] {
            let fixture = HdRetryFixture(), coordinator = fixture.coordinator()
            do {
                _ = try await coordinator.call(method, [:]) { method, params in
                    _ = fixture.record(method, params); return [:]
                }
                XCTFail("Only HD history and journal reads may use this coordinator")
            } catch let failure as HdRecoveryFailure { XCTAssertEqual(failure.code, "HD_RPC_REJECTED") }
            XCTAssertTrue(fixture.requests.isEmpty); XCTAssertTrue(fixture.delays.isEmpty)
        }
    }

    func testLegacyFallbackAfterAReconnectProbeReleasesTheHistoryGate() async throws {
        let fixture = HdRetryFixture()
        var environment = fixture.environment()
        let sleep = environment.sleep
        environment.sleep = { milliseconds in
            try walletRequire(fixture.delays.count < 20, "Legacy fallback left the probe gate closed")
            try await sleep(milliseconds)
        }
        let coordinator = HdRetryCoordinator(environment: environment, check: fixture.check, progress: { fixture.report($0) })
        do {
            _ = try await coordinator.call("getaddresschanges", [:]) { method, params in
                let attempt = fixture.record(method, params)
                throw RpcFailure(attempt == 1 ? "RPC_UNAVAILABLE" : "-32601")
            }
            XCTFail("Legacy journal response must reach the discovery fallback")
        } catch let failure as RpcFailure { XCTAssertEqual(failure.code, "-32601") }
        let waits = fixture.delays.count
        _ = try await coordinator.call("getaddresshistory", ["address": "fixture-address"]) { method, params in
            _ = fixture.record(method, params); return ["items": []]
        }
        XCTAssertEqual(fixture.requests.map(\.atMs), [0, 1_000, 1_000])
        XCTAssertEqual(fixture.delays.count, waits)
        XCTAssertEqual(fixture.progress.last?.retryAttempt, 0)
    }

    func testRevokedOwnerAndCancellationNeverRetryTransportCancellation() async throws {
        for code in ["RPC_CANCELLED", "RPC_INACTIVE"] {
            let fixture = HdRetryFixture(), coordinator = fixture.coordinator()
            do {
                _ = try await coordinator.call("getaddresshistory", [:]) { method, params in
                    _ = fixture.record(method, params); fixture.revoke(); throw RpcFailure(code)
                }
                XCTFail("A revoked owner unexpectedly succeeded")
            } catch is CancellationError { }
            XCTAssertEqual(fixture.requests.count, 1); XCTAssertTrue(fixture.delays.isEmpty)
        }
        let fixture = HdRetryFixture(), coordinator = fixture.coordinator()
        do {
            _ = try await coordinator.call("getaddresshistory", [:]) { method, params in
                _ = fixture.record(method, params); throw CancellationError()
            }
            XCTFail("Cancellation unexpectedly succeeded")
        } catch is CancellationError { }
        XCTAssertEqual(fixture.requests.count, 1); XCTAssertTrue(fixture.delays.isEmpty)
    }

    func testCancellationDuringCooldownStopsBeforeAnotherRead() async throws {
        let fixture = HdRetryFixture(), sleeper = HdRetryManualSleeper()
        var environment = fixture.environment(); environment.sleep = sleeper.sleep
        let coordinator = HdRetryCoordinator(environment: environment, check: fixture.check, progress: { fixture.report($0) })
        let operation = Task {
            try await coordinator.call("getaddresshistory", [:]) { method, params in
                _ = fixture.record(method, params); throw RpcFailure("RPC_UNAVAILABLE")
            }
        }
        defer { operation.cancel(); sleeper.stop() }
        try await eventually { sleeper.count == 1 }
        operation.cancel(); sleeper.wakeAll()
        do { _ = try await operation.value; XCTFail("A cancelled cooldown unexpectedly succeeded") }
        catch is CancellationError { }
        XCTAssertEqual(fixture.requests.count, 1)
    }

    func testOwnerRevokedDuringAReadDiscardsItsSuccessfulResponse() async throws {
        let fixture = HdRetryFixture(), coordinator = fixture.coordinator()
        do {
            _ = try await coordinator.call("getaddresshistory", [:]) { method, params in
                _ = fixture.record(method, params); fixture.revoke(); return ["items": []]
            }
            XCTFail("A response arriving after owner revocation must not be published")
        } catch is CancellationError { }
        XCTAssertEqual(fixture.requests.count, 1); XCTAssertTrue(fixture.delays.isEmpty)
    }

    func testLateInitialFailureDoesNotRecloseARecoveredGate() async throws {
        let fixture = HdRetryFixture(), sleeper = HdRetryManualSleeper(), reader = HdRetryControlledReader()
        var environment = fixture.environment(); environment.sleep = sleeper.sleep
        let coordinator = HdRetryCoordinator(environment: environment, check: fixture.check, progress: { fixture.report($0) })
        let operations: [Task<JSONObject, Error>] = (0..<2).map { id in
            Task { try await coordinator.call("getaddresshistory", ["address": "address-\(id)"], reader: reader.read) }
        }
        defer { operations.forEach { $0.cancel() }; sleeper.stop(); reader.stop() }
        try await eventually { reader.count == 2 }
        reader.finish(0, .failure(RpcFailure("RPC_UNAVAILABLE")))
        try await eventually { sleeper.count == 1 }
        fixture.advance(1_000); sleeper.wakeAll()
        try await eventually { reader.count == 3 }
        reader.finish(2, .success(["recovered": true]))
        try await eventually { fixture.progress.last?.state == "scanning" }
        reader.finish(1, .failure(RpcFailure("RPC_TIMEOUT")))
        try await eventually { reader.count == 4 }
        XCTAssertEqual(sleeper.count, 0)
        XCTAssertEqual(fixture.progress.map(\.retryAttempt).max(), 1)
        reader.finish(3, .success(["recovered": true]))
        for operation in operations {
            let result = try await operation.value
            XCTAssertEqual(result["recovered"] as? Bool, true)
        }
    }

    func testSiblingServerCooldownExtendsTheSharedGateWithoutSpendingARound() async throws {
        let fixture = HdRetryFixture(), sleeper = HdRetryManualSleeper(), reader = HdRetryControlledReader()
        var environment = fixture.environment(); environment.sleep = sleeper.sleep
        let coordinator = HdRetryCoordinator(environment: environment, check: fixture.check, progress: { fixture.report($0) })
        let operations: [Task<JSONObject, Error>] = (0..<2).map { id in
            Task { try await coordinator.call("getaddresshistory", ["address": "address-\(id)"], reader: reader.read) }
        }
        defer { operations.forEach { $0.cancel() }; sleeper.stop(); reader.stop() }
        try await eventually { reader.count == 2 }
        reader.finish(0, .failure(RpcFailure("RPC_UNAVAILABLE")))
        try await eventually { sleeper.count == 1 }
        var limited = RpcFailure("-32029"); limited.retryAfterMs = 60_000
        reader.finish(1, .failure(limited))
        try await eventually { sleeper.count == 2 }
        XCTAssertTrue(fixture.progress.contains { $0.retryAfterMs == 60_000 && $0.retryAttempt == 0 })
        fixture.advance(1_000); sleeper.wakeAll()
        try await eventually { sleeper.count == 2 }
        XCTAssertEqual(reader.count, 2)
        XCTAssertEqual(fixture.progress.map(\.retryAttempt).max(), 0)
        fixture.advance(60_000); sleeper.wakeAll()
        try await eventually { reader.count == 3 && sleeper.count == 1 }
        XCTAssertEqual(fixture.progress.map(\.retryAttempt).max(), 1)
        reader.finish(2, .success(["recovered": true]))
        try await eventually { fixture.progress.last?.state == "scanning" }
        fixture.advance(60_100); sleeper.wakeAll()
        try await eventually { reader.count == 4 }
        reader.finish(3, .success(["recovered": true]))
        for operation in operations {
            let result = try await operation.value
            XCTAssertEqual(result["recovered"] as? Bool, true)
        }
    }

    func testConcurrentInitialFailuresShareOneGateAndOneProbePerRound() async throws {
        let fixture = HdRetryFixture(), sleeper = HdRetryManualSleeper(), reader = HdRetryControlledReader()
        var environment = fixture.environment(); environment.sleep = sleeper.sleep
        let coordinator = HdRetryCoordinator(environment: environment, check: fixture.check, progress: { fixture.report($0) })
        var operations: [Task<JSONObject, Error>] = (0..<16).map { id in
            Task { try await coordinator.call("getaddresshistory", ["address": "address-\(id)"], reader: reader.read) }
        }
        defer { operations.forEach { $0.cancel() }; sleeper.stop(); reader.stop() }
        try await eventually { reader.count == 16 }
        reader.finish(0, .failure(RpcFailure("RPC_UNAVAILABLE")))
        try await eventually { sleeper.count == 1 }
        for id in 1..<16 { reader.finish(id, .failure(RpcFailure(id % 2 == 0 ? "RPC_BUSY" : "RPC_TIMEOUT"))) }
        try await eventually { sleeper.count == 16 }
        operations.append(Task { try await coordinator.call("getaddresschanges", ["cursor": "original.cursor"], reader: reader.read) })
        try await eventually { sleeper.count == 17 }
        XCTAssertEqual(reader.count, 16)
        XCTAssertEqual(fixture.progress.map(\.retryAttempt).max(), 0)

        fixture.advance(1_000); sleeper.wakeAll()
        try await eventually { reader.count == 17 && sleeper.count == 16 }
        XCTAssertEqual(fixture.progress.map(\.retryAttempt).max(), 1)
        XCTAssertEqual(Array(sleeper.delays.suffix(16)), Array(repeating: 100, count: 16))
        reader.finish(16, .failure(RpcFailure("RPC_UNAVAILABLE")))
        try await eventually { sleeper.count == 17 }
        fixture.advance(3_000); sleeper.wakeAll()
        try await eventually { reader.count == 18 && sleeper.count == 16 }
        XCTAssertEqual(fixture.progress.map(\.retryAttempt).max(), 2)
        XCTAssertEqual(Array(sleeper.delays.suffix(16)), Array(repeating: 100, count: 16))
        reader.finish(17, .success(["recovered": true]))
        try await eventually { fixture.progress.last?.state == "scanning" }
        fixture.advance(3_100); sleeper.wakeAll()
        try await eventually { reader.count == 34 }
        for id in 18..<34 { reader.finish(id, .success(["recovered": true])) }
        for operation in operations {
            let result = try await operation.value
            XCTAssertEqual(result["recovered"] as? Bool, true)
        }
        XCTAssertEqual(reader.count, 34)
        XCTAssertEqual(fixture.progress.last?.retryAttempt, 0)
    }
}
