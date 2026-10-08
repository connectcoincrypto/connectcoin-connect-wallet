import XCTest
@testable import WalletCore

final class ClaimSchedulerTests: XCTestCase {
    private func row(domain: String = "example.com", amount: String = "1000000", tx: String = "01", target: String? = nil) throws -> ClaimCandidate {
        let block = String(repeating: "12", count: 32)
        let bounty: JSONObject = ["txid": String(repeating: "00", count: 31) + tx, "vout": 0, "amount": amount,
            "connection_work_target": target ?? String(repeating: "ff", count: 32), "block_hash": block,
            "block_height": 1, "confirmations": 1, "coinbase": false, "signature_algorithms_mask": 7,
            "root_certificates_version": 1, "domain": domain, "status": "available"]
        return try ClaimCandidate(bounty, block: block, fee: 0, factor: 1_000_000)
    }

    func testTargetCarryAndExactPriorityMultiplication() throws {
        let full = try ClaimInteger(hex: String(repeating: "ff", count: 32)).plusOne()
        XCTAssertEqual(full.words[8], 1)
        XCTAssertTrue(full.words.prefix(8).allSatisfy { $0 == 0 })
        let product = full.multiplied(UInt64.max)
        XCTAssertEqual(product.words[8], UInt32.max)
        XCTAssertEqual(product.words[9], UInt32.max)
        XCTAssertTrue(product.words.prefix(8).allSatisfy { $0 == 0 })
        XCTAssertEqual(ClaimScheduler.score(full, rate: 5), 5)
        let almost = try ClaimInteger(hex: String(repeating: "ff", count: 32))
        XCTAssertLessThan(almost, full)
        XCTAssertLessThan(almost.multiplied(1_100_000), full.multiplied(1_100_000))
    }

    func testSuccessfulCaptureBudgetMatchesTwiceExpectedWorkBoundary() throws {
        let candidate = try row()
        candidate.progress.captures = 2
        XCTAssertTrue(candidate.budget)
        candidate.progress.captures = 3
        XCTAssertFalse(candidate.budget)
        candidate.progress.captures = UInt64.max
        XCTAssertFalse(candidate.budget)
    }

    func testFairDomainTurnsAlternateWithExpectedValue() throws {
        let a = try row(domain: "a.example.com", tx: "01")
        let b = try row(domain: "b.example.com", amount: "5000000", tx: "02")
        a.progress.prepared = [:]; b.progress.prepared = [:]
        var scheduler = ClaimScheduler()
        scheduler.rebuild([b, a], stats: [:], retired: [], now: 0)
        let fair = try XCTUnwrap(scheduler.next(now: 0, prepared: true))
        XCTAssertEqual(fair.row.domain, a.domain); XCTAssertFalse(fair.economic)
        scheduler.reserve(fair); scheduler.acknowledge(fair, now: 0)
        let best = try XCTUnwrap(scheduler.next(now: 0, prepared: true))
        XCTAssertEqual(best.row.domain, b.domain); XCTAssertTrue(best.economic)
        scheduler.reserve(best); scheduler.acknowledge(best, now: 0)
        XCTAssertEqual(scheduler.next(now: 0, prepared: true)?.row.domain, b.domain)
    }

    func testUnpreparedLeaderDoesNotFallBackToWorseBountyInItsDomain() throws {
        let leader = try row(amount: "5000000", tx: "01")
        let lower = try row(tx: "02"); lower.progress.prepared = [:]
        var scheduler = ClaimScheduler()
        scheduler.rebuild([lower, leader], stats: [:], retired: [], now: 0)
        XCTAssertNil(scheduler.next(now: 0, prepared: true))
        XCTAssertEqual(scheduler.next(now: 0, prepared: false)?.row.key, leader.key)
    }

    func testRecoveryProbeStartsOnlyOncePerMinuteAndOnlyActualStartSpendsIt() throws {
        let candidate = try row(); candidate.progress.prepared = [:]
        var observed = ClaimEMA(); observed.connections = 0.000_000_001; observed.totalTime = 1
        var scheduler = ClaimScheduler()
        scheduler.rebuild([candidate], stats: [candidate.policy: observed], retired: [], now: 0)
        XCTAssertNil(scheduler.next(now: 59.9, prepared: true))
        let probe = try XCTUnwrap(scheduler.next(now: 60, prepared: true))
        XCTAssertTrue(probe.recovering)
        scheduler.reserve(probe)
        XCTAssertNil(scheduler.next(now: 60, prepared: true))
        scheduler.release(probe) // DNS/cancellation before actual TCP is neutral.
        let retry = try XCTUnwrap(scheduler.next(now: 60, prepared: true))
        scheduler.reserve(retry); scheduler.acknowledge(retry, now: 60)
        XCTAssertNil(scheduler.next(now: 119.9, prepared: true))
        XCTAssertNotNil(scheduler.next(now: 120, prepared: true))
    }

    func testInvalidPriorityFactorAndPrivateDomainsAreNotScheduled() throws {
        let candidate = try row(domain: "node.local")
        XCTAssertFalse(candidate.supported)
        XCTAssertThrowsError(try ClaimProgress(block: candidate.block, policy: candidate.policy, factor: 999_999))
        var scheduler = ClaimScheduler()
        scheduler.rebuild([candidate], stats: [:], retired: [], now: 0)
        XCTAssertNil(scheduler.next(now: 0, prepared: false))
    }

    func testOldProbeCompletionDoesNotReleaseNewReservation() throws {
        let candidate = try row(); candidate.progress.prepared = [:]
        var observed = ClaimEMA(); observed.connections = 0.000_000_001; observed.totalTime = 1
        var scheduler = ClaimScheduler()
        scheduler.rebuild([candidate], stats: [candidate.policy: observed], retired: [], now: 0)
        let old = try XCTUnwrap(scheduler.next(now: 60, prepared: true))
        scheduler.reserve(old); scheduler.acknowledge(old, now: 60)
        let newer = try XCTUnwrap(scheduler.next(now: 120, prepared: true))
        scheduler.reserve(newer); scheduler.release(old)
        XCTAssertNil(scheduler.next(now: 120, prepared: true))
        scheduler.release(newer)
        XCTAssertNotNil(scheduler.next(now: 120, prepared: true))
    }

    func testRecoveryProbeCacheStaysBoundedAcrossCatalogPriorityChanges() throws {
        var rows: [ClaimCandidate] = [], stats: [String: ClaimEMA] = [:]
        for index in 0..<300 {
            let candidate = try row(domain: "d\(index).example.com")
            rows.append(candidate)
            var observed = ClaimEMA(); observed.connections = 0.000_000_001; observed.totalTime = 1
            stats[candidate.policy] = observed
        }
        var scheduler = ClaimScheduler()
        scheduler.rebuild(rows, stats: stats, retired: [], now: 0)
        XCTAssertEqual(scheduler.probeDue.count, 256)
        for row in rows.prefix(100) { stats[row.policy] = ClaimEMA() }
        scheduler.rebuild(rows, stats: stats, retired: [], now: 1)
        XCTAssertLessThanOrEqual(scheduler.probeDue.count, 256)
    }
}
