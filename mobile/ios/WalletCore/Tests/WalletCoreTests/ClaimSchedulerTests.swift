import XCTest
@testable import WalletCore

final class ClaimSchedulerTests: XCTestCase {
    private func slowStats() -> ClaimPerformanceWindow {
        let observed = ClaimPerformanceWindow(clock: { 0 })
        for _ in 0..<100 { observed.record(false, 60) }
        return observed
    }
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

    func testNativeCaptureHiddenByCancellationStillExhaustsRestartedBudget() throws {
        let candidate = try row()
        candidate.progress.captures = 2
        candidate.progress.prepared = ["owner": "unchanged"]
        // The release path imports the native handle's accounting even when
        // pause/cancellation prevents complete() from accepting its result.
        ClaimProgress.recordNativeCapture(candidate, hasCaptured: false, current: candidate.progress)
        XCTAssertEqual(candidate.progress.captures, 2)
        XCTAssertTrue(candidate.budget)
        ClaimProgress.recordNativeCapture(candidate, hasCaptured: true, current: candidate.progress)
        XCTAssertEqual(candidate.progress.captures, 3, "The same Progress must not receive the increment twice")
        XCTAssertFalse(candidate.budget)
        XCTAssertEqual(candidate.progress.prepared?["owner"] as? String, "unchanged")

        // A new run imports progress into its new native budget key. This
        // must remain exhausted instead of admitting another capture.
        var restarted = try row()
        try restarted.reuse(candidate.progress)
        XCTAssertEqual(restarted.progress.captures, 3)
        XCTAssertFalse(restarted.budget)
        var scheduler = ClaimScheduler()
        scheduler.rebuild([restarted], stats: [:], retired: [], now: 0)
        XCTAssertNil(scheduler.next(now: 0, prepared: true))
    }

    func testLateNativeCaptureAddsToRelocatedAccountingWithoutRestoringPreparation() throws {
        let original = try row()
        original.progress.captures = 1
        original.progress.prepared = ["owner": "old block"]
        var source = original.bounty
        let newBlock = String(repeating: "34", count: 32)
        source["block_hash"] = newBlock; source["block_height"] = 2
        var relocated = try ClaimCandidate(source, block: newBlock, fee: 0, factor: 1_000_000)
        try relocated.reuse(original.progress)
        XCTAssertFalse(relocated.progress === original.progress)
        XCTAssertNil(relocated.progress.prepared)
        // A different handle has already completed on the current copy.
        // max(old, current) would lose one capture; import this handle's +1.
        relocated.progress.captures += 1
        ClaimProgress.recordNativeCapture(original, hasCaptured: true, current: relocated.progress)
        XCTAssertEqual(original.progress.captures, 2)
        XCTAssertEqual(relocated.progress.captures, 3)
        XCTAssertFalse(relocated.budget)
        XCTAssertNil(relocated.progress.prepared)
        XCTAssertEqual(original.progress.prepared?["owner"] as? String, "old block")
    }

    func testNativeCaptureAccountingDoesNotResurrectOrAlterDifferentOutputAndSaturates() throws {
        let original = try row(), unrelated = try row(amount: "2000000")
        original.progress.captures = 1
        unrelated.progress.captures = 7
        ClaimProgress.recordNativeCapture(original, hasCaptured: true, current: unrelated.progress)
        XCTAssertEqual(original.progress.captures, 2)
        XCTAssertEqual(unrelated.progress.captures, 7)
        ClaimProgress.recordNativeCapture(original, hasCaptured: true, current: nil)
        XCTAssertEqual(original.progress.captures, 3)
        original.progress.captures = UInt64.max
        ClaimProgress.recordNativeCapture(original, hasCaptured: true, current: original.progress)
        XCTAssertEqual(original.progress.captures, UInt64.max)
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

    func testBootstrapStartsImmediatelyAndOnlyActualStartSpendsItsGlobalSlot() throws {
        let candidate = try row(); candidate.progress.prepared = [:]
        let observed = slowStats()
        var scheduler = ClaimScheduler()
        scheduler.rebuild([candidate], stats: [candidate.policy: observed], retired: [], now: 0)
        let probe = try XCTUnwrap(scheduler.next(now: 0, prepared: true))
        XCTAssertTrue(probe.recovering)
        scheduler.reserve(probe)
        XCTAssertNil(scheduler.next(now: 60, prepared: true))
        scheduler.release(probe) // DNS/cancellation before actual TCP is neutral.
        let retry = try XCTUnwrap(scheduler.next(now: 60, prepared: true))
        scheduler.reserve(retry); scheduler.acknowledge(retry, now: 60)
        XCTAssertNil(scheduler.next(now: 60.249, prepared: true))
        XCTAssertNotNil(scheduler.next(now: 60.25, prepared: true))
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
        let observed = slowStats()
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
        var rows: [ClaimCandidate] = [], stats: [String: ClaimPerformanceWindow] = [:]
        for index in 0..<300 {
            let candidate = try row(domain: "d\(index).example.com")
            rows.append(candidate)
            let observed = slowStats()
            stats[candidate.policy] = observed
        }
        var scheduler = ClaimScheduler()
        scheduler.rebuild(rows, stats: stats, retired: [], now: 0)
        XCTAssertEqual(scheduler.probeCount, 256)
        for row in rows.prefix(100) { stats[row.policy] = ClaimPerformanceWindow() }
        scheduler.rebuild(rows, stats: stats, retired: [], now: 1)
        XCTAssertLessThanOrEqual(scheduler.probeCount, 256)
    }

    func testWindowExpiresWithoutNewConnectionsAndPriorDoesNotPolluteCounters() {
        var time = 0.0
        let observed = ClaimPerformanceWindow(clock: { time })
        XCTAssertEqual(observed.rate, 5)
        XCTAssertEqual(observed.connections, 0); XCTAssertEqual(observed.totalTime, 0)
        observed.record(true, 2)
        time = 59 * 60; observed.record(false, 3)
        time = 60 * 60
        XCTAssertEqual(observed.rate, 5.0 / 4)
        XCTAssertEqual(observed.observations, 1); XCTAssertEqual(observed.connections, 0)
        time = 0; observed.record(true, 1) // A backwards reading stays in minute 60.
        XCTAssertEqual(observed.rate, 6.0 / 5)
        time = 119 * 60; XCTAssertEqual(observed.rate, 6.0 / 2)
        time = 120 * 60; XCTAssertEqual(observed.rate, 5)
        XCTAssertEqual(observed.observations, 0); XCTAssertEqual(observed.connections, 0)
        XCTAssertEqual(observed.totalTime, 0); XCTAssertEqual(observed.completed, 3)
        observed.record(true, .nan); observed.record(true, -1); observed.record(true, .infinity)
        XCTAssertEqual(observed.completed, 3)
        time = .nan; XCTAssertEqual(observed.rate, 5)
    }

    func testCachedBudgetMatchesExactProductAndUint64Saturation() throws {
        for bit in 0..<256 {
            var target = [UInt8](repeating: 0, count: 32)
            target[31 - bit / 8] = UInt8(1 << (bit % 8))
            let hex = target.map { String(format: "%02x", $0) }.joined()
            let candidate = try row(target: hex)
            for count in [UInt64(0), 1, candidate.captureStopCount - 1, candidate.captureStopCount, UInt64.max] {
                candidate.progress.captures = count
                let expected = count < UInt64.max && candidate.targetPlusOne.multiplied(count) <= .twiceSpace
                XCTAssertEqual(candidate.budget, expected, "bit \(bit), count \(count)")
            }
        }
        let hardest = try row(target: String(repeating: "00", count: 32))
        hardest.progress.captures = UInt64.max - 1; XCTAssertTrue(hardest.budget)
        hardest.progress.captures = UInt64.max; XCTAssertFalse(hardest.budget)
    }

    func testReplacingProgressRecomputesPriorityWithoutChangingExactRank() throws {
        var candidate = try row()
        XCTAssertEqual(candidate.priority, candidate.raw.multiplied(1_000_000))
        candidate.progress = try ClaimProgress(block: candidate.block, policy: candidate.policy, factor: 1_100_000)
        XCTAssertEqual(candidate.priority, candidate.raw.multiplied(1_100_000))
    }

    func testRemovedUnpreparedLeaderCannotStrandItsReplacement() throws {
        let leader = try row(amount: "5000000", tx: "01"), replacement = try row(tx: "02")
        var scheduler = ClaimScheduler()
        scheduler.rebuild([replacement, leader], stats: [:], retired: [], now: 0)
        XCTAssertEqual(scheduler.next(now: 0, prepared: false)?.row.key, leader.key)
        scheduler.remove(leader.key)
        XCTAssertEqual(scheduler.next(now: 0, prepared: false)?.row.key, replacement.key)
        replacement.progress.prepared = [:]
        XCTAssertEqual(scheduler.next(now: 0, prepared: true)?.row.key, replacement.key)
    }

    func testSelectionAndAcknowledgementCanOnlySpendOneTurn() throws {
        let a = try row(domain: "a.example.com", tx: "01"), b = try row(domain: "b.example.com", tx: "02")
        a.progress.prepared = [:]; b.progress.prepared = [:]
        var scheduler = ClaimScheduler()
        scheduler.rebuild([a, b], stats: [:], retired: [], now: 0)
        let first = try XCTUnwrap(scheduler.next(now: 0, prepared: true))
        let stale = try XCTUnwrap(scheduler.next(now: 0, prepared: true))
        XCTAssertTrue(scheduler.reserve(first)); XCTAssertFalse(scheduler.reserve(first))
        XCTAssertFalse(scheduler.reserve(stale)); XCTAssertFalse(scheduler.acknowledge(stale, now: 0))
        XCTAssertTrue(scheduler.acknowledge(first, now: 0)); XCTAssertFalse(scheduler.acknowledge(first, now: 0))
        XCTAssertTrue(try XCTUnwrap(scheduler.next(now: 0, prepared: true)).economic)
    }

    func testScoreOverflowRemainsFiniteLikeDesktopAndAndroid() throws {
        let candidate = try row()
        XCTAssertEqual(ClaimScheduler.score(candidate.raw, rate: .greatestFiniteMagnitude), .greatestFiniteMagnitude)
        XCTAssertTrue(ClaimScheduler.score(candidate.raw, rate: .nan).isNaN)
    }

    func testThirtyTwoBootstrapStartsThenMinuteRecoverySurviveRebuildAndClear() throws {
        let candidate = try row(amount: "1"); candidate.progress.prepared = [:]
        var scheduler = ClaimScheduler()
        scheduler.rebuild([candidate], stats: [:], retired: [], now: 0)
        for index in 0..<32 {
            let time = Double(index) * 0.25
            if index > 0 { XCTAssertNil(scheduler.next(now: time - 0.001, prepared: true)) }
            let probe = try XCTUnwrap(scheduler.next(now: time, prepared: true)); XCTAssertTrue(probe.recovering)
            XCTAssertTrue(scheduler.reserve(probe, now: time)); XCTAssertTrue(scheduler.acknowledge(probe, now: time))
            XCTAssertFalse(scheduler.acknowledge(probe, now: time))
            scheduler.clear(); scheduler.rebuild([candidate], stats: [:], retired: [], now: time)
        }
        XCTAssertNil(scheduler.next(now: 67.749, prepared: true))
        XCTAssertNotNil(scheduler.next(now: 67.75, prepared: true))
    }

    func testGlobalProbeReservationDoesNotBlockEconomicWorkAndCancellationIsNeutral() throws {
        let a = try row(domain: "a.example.com", amount: "1", tx: "01")
        let b = try row(domain: "b.example.com", amount: "1", tx: "02")
        let good = try row(domain: "z.example.com", tx: "03")
        for row in [a, b, good] { row.progress.prepared = [:] }
        var scheduler = ClaimScheduler(); scheduler.rebuild([a, b, good], stats: [:], retired: [], now: 0)
        let pending = try XCTUnwrap(scheduler.next(now: 0, prepared: true)); XCTAssertTrue(pending.recovering)
        XCTAssertTrue(scheduler.reserve(pending, now: 0)); XCTAssertEqual(scheduler.next(now: 0, prepared: true)?.row.key, good.key)
        scheduler.remove(good.key); XCTAssertNil(scheduler.next(now: 100, prepared: true)); scheduler.release(pending)
        let retry = try XCTUnwrap(scheduler.next(now: 100, prepared: true)); scheduler.reserve(retry, now: 100)
        scheduler.release(pending); XCTAssertNil(scheduler.next(now: 200, prepared: true))
        scheduler.acknowledge(retry, now: 200); XCTAssertNil(scheduler.next(now: 200.249, prepared: true))
        XCTAssertNotNil(scheduler.next(now: 200.25, prepared: true))
    }

    func testColdTwentyBitPolicyCanLearnAndZeroNetCannotProbe() throws {
        let cold = try row(amount: "75000000", target: "00000" + String(repeating: "f", count: 59))
        let zero = try row(domain: "zero.example.com", amount: "0", tx: "02")
        cold.progress.prepared = [:]; zero.progress.prepared = [:]
        var scheduler = ClaimScheduler(); scheduler.rebuild([cold, zero], stats: [:], retired: [], now: 0)
        XCTAssertFalse(ClaimScheduler.worth(cold, rate: 5)); XCTAssertTrue(ClaimScheduler.worth(cold, rate: 20))
        let probe = try XCTUnwrap(scheduler.next(now: 0, prepared: true)); XCTAssertTrue(probe.recovering)
        scheduler.reserve(probe); scheduler.acknowledge(probe, now: 0)
        let measured = ClaimPerformanceWindow(clock: { 0 })
        for _ in 0..<32 { measured.record(true, 0.05) }
        scheduler.rebuild([cold, zero], stats: [cold.policy: measured], retired: [], now: 0.001)
        XCTAssertFalse(try XCTUnwrap(scheduler.next(now: 0.001, prepared: true)).recovering)
        cold.progress.budgetExhausted = true; scheduler.rebuild([cold, zero], stats: [:], retired: [], now: 1)
        XCTAssertNil(scheduler.next(now: 100, prepared: true))
    }

    func testEvictionNeverResetsGlobalProbeCadence() throws {
        let first = try row(amount: "1"); first.progress.prepared = [:]
        var scheduler = ClaimScheduler(); scheduler.rebuild([first], stats: [:], retired: [], now: 0)
        let probe = try XCTUnwrap(scheduler.next(now: 0, prepared: true)); scheduler.reserve(probe); scheduler.acknowledge(probe, now: 0)
        for index in 0..<300 {
            let replacement = try row(domain: "d\(index).example.com", amount: "1"); replacement.progress.prepared = [:]
            scheduler.rebuild([replacement], stats: [:], retired: [], now: 0.001)
            XCTAssertNil(scheduler.next(now: 0.249, prepared: true)); XCTAssertLessThanOrEqual(scheduler.probeCount, 256)
        }
        XCTAssertNotNil(scheduler.next(now: 0.25, prepared: true))
    }
}
