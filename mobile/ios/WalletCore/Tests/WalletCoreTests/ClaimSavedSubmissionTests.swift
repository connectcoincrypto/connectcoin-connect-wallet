import XCTest
@testable import WalletCore

final class ClaimSavedSubmissionTests: XCTestCase {
    func testCompactPendingAndConfirmedReceiptsKeepLocalProofValidation() throws {
        let (saved, window) = try fixture()
        _ = try NativeTransactions.validateObservedClaim(saved.retry.hex, expectedTxid: saved.retry.txid,
            originalHex: saved.retry.hex, target: saved.row.target)
        let pending: JSONObject = ["tip": window.tip.json, "txid": saved.retry.txid, "status": "pending", "confirmations": 0]
        XCTAssertEqual(try saved.location(saved.expandStatus(pending), known: window), .pending)
        let confirmed: JSONObject = ["tip": window.tip.json, "txid": saved.retry.txid, "status": "confirmed", "confirmations": 2,
            "block_hash": window.blocks[1].hash, "block_height": window.blocks[1].height]
        XCTAssertEqual(try saved.location(saved.expandStatus(confirmed), known: window), .confirmed)
        let changes: [JSONObject] = [["confirmations": 1], ["txid": String(repeating: "ab", count: 32)],
                                   ["block_hash": window.tip.hash], ["confirmations": NSNull()]]
        for change in changes {
            XCTAssertThrowsError(try saved.expandStatus(pending.merging(change) { _, new in new }))
        }
        var wrong = confirmed; wrong["confirmations"] = 3
        XCTAssertThrowsError(try saved.expandStatus(wrong))
        XCTAssertEqual(saved.retry.hex, try PJ.string(PJ.object(PaymentVectors.fixture()["attached"])["hex"]))
        XCTAssertFalse(saved.acknowledged); XCTAssertFalse(saved.counted)
    }
    private func fixture() throws -> (ClaimSavedSubmission, ClaimRecentWindow) {
        let claim = try PJ.object(PaymentVectors.fixture()["attached"])
        let blocks: [JSONObject] = (0...3).reversed().map { height in
            ["height": height, "hash": height == 0 ? NativePaymentChecks.GENESIS : String(repeating: "0", count: 63) + String(height)]
        }
        let tip: JSONObject = ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS, "height": 3,
            "hash": blocks[0]["hash"]!, "mediantime": 1_700_000_000]
        let window = try ClaimRecentWindow(["window": 600, "tip": tip, "blocks": blocks])
        let block = window.blocks[1]
        let row = try ClaimCandidate(["txid": String(repeating: "01", count: 32), "vout": 0, "amount": "1000000",
            "connection_work_target": String(repeating: "ff", count: 32), "block_hash": block.hash,
            "block_height": block.height, "confirmations": 2, "coinbase": false, "signature_algorithms_mask": 7,
            "root_certificates_version": 1, "domain": "example.com", "status": "available"], block: block.hash, fee: 0, factor: 1_000_000)
        let saved = ClaimSavedSubmission(row: row, retry: ClaimSubmissionRetry(hex: try PJ.string(claim["hex"]), txid: try PJ.hash(claim["txid"])))
        return (saved, window)
    }
    private func pending(_ saved: ClaimSavedSubmission, _ window: ClaimRecentWindow) -> JSONObject {
        ["tip": window.tip.json, "status": "pending", "transaction": ["hex": saved.retry.hex]]
    }
    private func confirmed(_ saved: ClaimSavedSubmission, _ window: ClaimRecentWindow) -> JSONObject {
        ["tip": window.tip.json, "status": "confirmed", "block_hash": window.blocks[1].hash,
            "block_height": window.blocks[1].height, "transaction": ["hex": saved.retry.hex]]
    }

    private func retirementWindow(height: Int64 = 3, replacement: [Int64: String] = [:]) throws -> ClaimRecentWindow {
        let rows: [JSONObject] = (max(0, height - 599)...height).reversed().map { number in
            ["height": number, "hash": replacement[number] ?? (number == 0 ? NativePaymentChecks.GENESIS : String(format: "%064llx", number))]
        }
        return try ClaimRecentWindow(["window": 600, "blocks": rows, "tip": ["chain": "main",
            "genesis_hash": NativePaymentChecks.GENESIS, "height": height, "hash": rows[0]["hash"]!, "mediantime": 1_700_000_000]])
    }
    private func retirementReceipt(_ saved: ClaimSavedSubmission, _ window: ClaimRecentWindow) throws -> JSONObject {
        let response: JSONObject = ["tip": window.tip.json, "status": "confirmed", "block_hash": window.tip.hash,
            "block_height": window.tip.height, "transaction": ["hex": saved.retry.hex]]
        XCTAssertEqual(try saved.location(response, known: window), .confirmed)
        return response
    }

    func testOrphanedConfirmationReopensOnlyAfterFreshFundingStreamAndPreservesCount() throws {
        let (saved, original) = try fixture(); XCTAssertTrue(saved.acknowledge(now: 1))
        let receipt = try retirementReceipt(saved, original)
        let marker = try ClaimConfirmedRetirement(validated: saved, response: receipt, known: original)
        let fork = try retirementWindow(replacement: [3: String(repeating: "ab", count: 32)])
        var retired: Set<String> = [saved.row.key]
        XCTAssertEqual(marker.observe(window: original, newBlock: saved.row.block, staged: saved.row, current: saved.row), .none)
        XCTAssertEqual(marker.observe(window: fork, newBlock: nil, staged: nil, current: saved.row), .reload(saved.row.block))
        XCTAssertTrue(retired.contains(saved.row.key), "A cached available row is not a new funding snapshot")
        var pending = saved.row; pending.state = "pending_spend"
        XCTAssertEqual(marker.observe(window: fork, newBlock: saved.row.block, staged: pending, current: pending), .none)
        XCTAssertTrue(retired.contains(saved.row.key))
        // The engine invokes this only after the entire stream/journal/fence
        // commit. A subsequent validated reopening can complete the recovery.
        if marker.observe(window: fork, newBlock: nil, staged: nil, current: saved.row) == .reopen { retired.remove(saved.row.key) }
        XCTAssertFalse(retired.contains(saved.row.key))
        XCTAssertEqual(marker.observe(window: fork, newBlock: saved.row.block, staged: saved.row, current: saved.row), .none,
            "An old marker cannot release a newly reserved claim a second time")
        let recaptured = ClaimSavedSubmission(row: saved.row, retry: saved.retry)
        marker.inheritCount(on: recaptured)
        XCTAssertFalse(recaptured.acknowledge(now: 2), "A second proof with the same transaction id is not another submitted transaction")
        XCTAssertEqual(recaptured.retry.hex, saved.retry.hex)
        let different = ClaimSavedSubmission(row: saved.row, retry: ClaimSubmissionRetry(hex: saved.retry.hex, txid: String(repeating: "cd", count: 32)))
        marker.inheritCount(on: different)
        XCTAssertTrue(different.acknowledge(now: 2))
    }

    func testConfirmationAgingAndAheadReceiptAreNotReorgEvidence() throws {
        let (saved, original) = try fixture(); _ = saved.acknowledge(now: 1)
        let marker = try ClaimConfirmedRetirement(validated: saved, response: retirementReceipt(saved, original), known: original)
        let aged = try retirementWindow(height: 603)
        XCTAssertEqual(marker.observe(window: aged, newBlock: saved.row.block, staged: saved.row, current: saved.row), .none)
        let ahead = try retirementWindow(height: 5)
        let unanchored = try ClaimConfirmedRetirement(validated: saved, response: retirementReceipt(saved, ahead), known: nil)
        XCTAssertEqual(unanchored.observe(window: original, newBlock: saved.row.block, staged: saved.row, current: saved.row), .none,
            "Manual confirmation can be ahead of discovery; a lower cached tip is not a rollback")
        XCTAssertEqual(unanchored.observe(window: ahead, newBlock: nil, staged: nil, current: saved.row), .none)
        XCTAssertEqual(unanchored.observe(window: original, newBlock: nil, staged: nil, current: saved.row), .reload(saved.row.block),
            "A lower tip becomes evidence only after the confirming block was anchored")
        XCTAssertEqual(unanchored.observe(window: original, newBlock: saved.row.block, staged: saved.row, current: saved.row), .reopen)
    }

    func testOrphanedConfirmationNeverBypassesFundingIdentityStateOrCompleteStream() throws {
        let (saved, original) = try fixture(); _ = saved.acknowledge(now: 1)
        let response = try retirementReceipt(saved, original)
        let fork = try retirementWindow(replacement: [3: String(repeating: "ab", count: 32)])
        for state in ["pending_spend", "spent", "immature"] {
            let marker = try ClaimConfirmedRetirement(validated: saved, response: response, known: original)
            var row = saved.row; row.state = state
            XCTAssertEqual(marker.observe(window: fork, newBlock: row.block, staged: row, current: row), .none)
        }
        let marker = try ClaimConfirmedRetirement(validated: saved, response: response, known: original)
        XCTAssertEqual(marker.observe(window: fork, newBlock: nil, staged: saved.row, current: saved.row), .reload(saved.row.block))
        var changed = saved.row.bounty; changed["amount"] = "1000001"
        let changedRow = try ClaimCandidate(changed, block: saved.row.block, fee: 0)
        XCTAssertEqual(marker.observe(window: fork, newBlock: saved.row.block, staged: changedRow, current: changedRow), .reload(saved.row.block))
        var pending = saved.row; pending.state = "pending_spend"
        XCTAssertEqual(marker.observe(window: fork, newBlock: saved.row.block, staged: saved.row, current: pending), .none,
            "Journal events after the stream still gate the final state")
        XCTAssertEqual(marker.observe(window: original, newBlock: nil, staged: nil, current: saved.row), .none)
        XCTAssertEqual(marker.observe(window: fork, newBlock: nil, staged: nil, current: saved.row), .reload(saved.row.block),
            "Returning to the original chain invalidates the earlier orphan snapshot")
    }

    func testFundingReminePreservesAccountingAcrossPruningAndResetGapWithoutOldPreparation() throws {
        let (saved, original) = try fixture(); _ = saved.acknowledge(now: 1)
        saved.row.progress.captures = 2; saved.row.progress.prepared = ["challenge": "old-funding-block"]
        let marker = try ClaimConfirmedRetirement(validated: saved, response: retirementReceipt(saved, original), known: original)
        let newFunding = String(repeating: "ab", count: 32)
        let fork = try retirementWindow(replacement: [2: newFunding, 3: String(repeating: "cd", count: 32)])
        let pruned = try ClaimProgress.reconcile(previous: [saved.row.key: saved.row.progress], catalog: [:], window: fork, loaded: [], protected: [])
        let light = try XCTUnwrap(pruned[saved.row.key])
        XCTAssertFalse(light === saved.row.progress); XCTAssertNil(light.prepared)
        XCTAssertEqual(light.captures, 2); XCTAssertEqual(light.factor, saved.row.progress.factor)
        XCTAssertEqual(saved.row.progress.prepared?["challenge"] as? String, "old-funding-block", "Staging must not mutate a previous owner")
        // Stop/Start or a new journal watermark can insert another empty replay
        // before the re-mined funding block's complete stream arrives.
        let reset = try ClaimProgress.reconcile(previous: pruned, catalog: [:], window: fork, loaded: [], protected: [])
        var source = saved.row.bounty; source["block_hash"] = newFunding
        var moved = try ClaimCandidate(source, block: newFunding, fee: 0)
        try moved.reuse(XCTUnwrap(reset[saved.row.key]))
        let published = try ClaimProgress.reconcile(previous: reset, catalog: [moved.key: moved], window: fork, loaded: [newFunding], protected: [])
        XCTAssertEqual(published[moved.key]?.captures, 2); XCTAssertNil(published[moved.key]?.prepared)
        XCTAssertEqual(marker.observe(window: fork, newBlock: newFunding, staged: moved, current: moved), .reopen)
        let recaptured = ClaimSavedSubmission(row: moved, retry: saved.retry)
        marker.inheritCount(on: recaptured)
        XCTAssertFalse(recaptured.acknowledge(now: 2), "Re-mining the funding transaction must not lose the counted transaction id")

        light.budgetExhausted = true
        var exhausted = try ClaimCandidate(source, block: newFunding, fee: 0)
        try exhausted.reuse(light)
        XCTAssertFalse(exhausted.budget, "A reorg is not a new successful-capture budget")
    }

    func testOrphanProgressExpiresByHeightButProtectedWorkAndCanonicalAbsenceKeepTheirRules() throws {
        let (saved, original) = try fixture(); saved.row.progress.prepared = ["challenge": "owned"]
        let rollback = try retirementWindow(height: 1)
        let removed = try ClaimProgress.reconcile(previous: [saved.row.key: saved.row.progress], catalog: [:], window: rollback, loaded: [], protected: [])
        XCTAssertEqual(removed[saved.row.key]?.captures, saved.row.progress.captures)
        XCTAssertNil(removed[saved.row.key]?.prepared, "A funding height above a rolled-back tip has not aged out")
        let aged = try retirementWindow(height: 603)
        XCTAssertTrue(try ClaimProgress.reconcile(previous: removed, catalog: [:], window: aged, loaded: [], protected: []).isEmpty)
        XCTAssertTrue(try ClaimProgress.reconcile(previous: [saved.row.key: saved.row.progress], catalog: [:], window: original,
            loaded: [saved.row.block], protected: []).isEmpty, "Complete canonical absence still removes the accounting row")
        let protected = try ClaimProgress.reconcile(previous: [saved.row.key: saved.row.progress], catalog: [:], window: aged,
            loaded: [], protected: [saved.row.key])
        XCTAssertTrue(protected[saved.row.key] === saved.row.progress)
        XCTAssertEqual(protected[saved.row.key]?.prepared?["challenge"] as? String, "owned")
    }

    func testOrphanAccountingSharesExistingCapacityAndFailsBeforePublication() throws {
        let (saved, _) = try fixture(), old = saved.row.identity
        let newFunding = String(repeating: "ab", count: 32)
        let fork = try retirementWindow(replacement: [2: newFunding, 3: String(repeating: "cd", count: 32)])
        var previous: [String: ClaimProgress] = [:]
        for index in 0..<ClaimSubmissionRetry.maximumProgressEntries {
            let key = String(format: "%064llx", Int64(index)) + ":0"
            let item = try ClaimProgress(block: old.block, policy: saved.row.policy, factor: 1_000_000)
            item.identity = ClaimCandidate.Identity(key: key, block: old.block, domain: old.domain, target: old.target,
                height: old.height, amount: old.amount, roots: old.roots, mask: old.mask, coinbase: old.coinbase)
            item.captures = 2; previous[key] = item
        }
        var source = saved.row.bounty; source["block_hash"] = newFunding
        let moved = try ClaimCandidate(source, block: newFunding, fee: 0)
        XCTAssertThrowsError(try ClaimProgress.reconcile(previous: previous, catalog: [moved.key: moved], window: fork,
            loaded: [newFunding], protected: [])) { error in
            XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_CAPACITY")
        }
        XCTAssertEqual(previous.count, ClaimSubmissionRetry.maximumProgressEntries)
        XCTAssertTrue(previous.values.allSatisfy { $0.captures == 2 && $0.prepared == nil })
    }

    func testAckRetainsExactBytesAndOnlyFirstAckCounts() throws {
        let (saved, window) = try fixture(), hex = saved.retry.hex, txid = saved.retry.txid
        saved.row.progress.captures = 2
        saved.row.progress.prepared = ["challenge": "prepared-once"]
        XCTAssertFalse(saved.acknowledged)
        XCTAssertTrue(saved.acknowledge(now: 10))
        XCTAssertEqual(saved.nextCheck, 40)
        XCTAssertEqual(try saved.location(pending(saved, window), known: window), .pending)
        XCTAssertTrue(saved.acknowledged); XCTAssertTrue(saved.counted)
        saved.reopened(); XCTAssertEqual(saved.nextCheck, 0)
        XCTAssertTrue(saved.availableForRetry(catalog: saved.row, retained: nil, normallyAged: false, coherent: true))
        XCTAssertFalse(saved.absentAfterFreshSnapshot(catalogAt: 9, available: true))
        XCTAssertFalse(saved.absentAfterFreshSnapshot(catalogAt: 10, available: true))
        XCTAssertFalse(saved.absentAfterFreshSnapshot(catalogAt: 11, available: false))
        XCTAssertTrue(saved.absentAfterFreshSnapshot(catalogAt: 11, available: true))
        saved.beginWrite(); XCTAssertFalse(saved.reopenedSinceWrite)
        XCTAssertFalse(saved.acknowledge(now: 11), "Identical retransmission must not double-count submitted")
        XCTAssertEqual(saved.retry.hex, hex); XCTAssertEqual(saved.retry.txid, txid)
        XCTAssertEqual(saved.row.progress.captures, 2)
        XCTAssertEqual(saved.row.progress.prepared?["challenge"] as? String, "prepared-once")
    }
    func testManualReceiptPersistenceFailureCannotAcknowledgeOrCompactSavedProof() throws {
        for alreadyAcknowledged in [false, true] {
            for confirmedLocation in [false, true] {
                for publishedBeforeFailure in [false, true] {
                    let (saved, window) = try fixture()
                    if alreadyAcknowledged { XCTAssertTrue(saved.acknowledge(now: 10)) }
                    var refusal = RpcFailure("-32030"); refusal.notForwarded = true; refusal.retryAfterMs = 120_000
                    XCTAssertTrue(saved.retry.retain(after: refusal, now: 1))
                    saved.row.progress.captures = 9
                    let originalHex = saved.retry.hex, originalTxid = saved.retry.txid
                    let originalCheck = saved.nextCheck, originalAckAt = saved.acknowledgedAt, originalDue = saved.retry.due
                    let response = confirmedLocation ? confirmed(saved, window) : pending(saved, window)
                    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-receipt-commit-" + UUID().uuidString)
                    let url = directory.appendingPathComponent("receipt.json")
                    defer { try? FileManager.default.removeItem(at: directory) }
                    try ClaimsPublicStore.write(["txid": originalTxid, "status": "unknown"], to: url)
                    var retirement: ClaimConfirmedRetirement?, writes = 0
                    do {
                        // This is the same commit primitive used by the real
                        // actor's checkSubmission. Model failures both before
                        // publication and after rename/directory fsync failure.
                        let committed = try saved.commitReceipt(response, known: window, now: 20) {
                            writes += 1
                            if publishedBeforeFailure {
                                try ClaimsPublicStore.write(["txid": originalTxid, "status": "submitted"], to: url)
                            }
                            throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE")
                        }
                        retirement = committed.retirement
                        XCTFail("Receipt persistence failure was ignored")
                    } catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
                    XCTAssertEqual(writes, 1); XCTAssertNil(retirement, "No compaction token may escape a failed durable commit")
                    XCTAssertEqual(saved.acknowledged, alreadyAcknowledged); XCTAssertEqual(saved.counted, alreadyAcknowledged)
                    XCTAssertEqual(saved.nextCheck, originalCheck); XCTAssertEqual(saved.acknowledgedAt, originalAckAt)
                    XCTAssertEqual(saved.retry.hex, originalHex); XCTAssertEqual(saved.retry.txid, originalTxid)
                    XCTAssertEqual(saved.retry.due, originalDue); XCTAssertEqual(saved.retry.failures, 1)
                    XCTAssertEqual(saved.row.progress.captures, 9)
                    XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, publishedBeforeFailure ? "submitted" : "unknown")
                    // Repairing persistence commits exactly the same proof.
                    // A retained earlier ACK or repeated recovery never counts twice.
                    let committed = try saved.commitReceipt(response, known: window, now: 21) {
                        try ClaimsPublicStore.write(["txid": originalTxid, "status": "submitted"], to: url)
                    }
                    XCTAssertEqual(committed.firstAck, !alreadyAcknowledged)
                    XCTAssertEqual(committed.retirement != nil, confirmedLocation)
                    if let marker = committed.retirement { XCTAssertTrue(marker.counted); XCTAssertEqual(marker.txid, originalTxid) }
                    let repeated = try saved.commitReceipt(response, known: window, now: 22) {
                        try ClaimsPublicStore.write(["txid": originalTxid, "status": "submitted"], to: url)
                    }
                    XCTAssertFalse(repeated.firstAck); XCTAssertEqual(saved.retry.hex, originalHex)
                    XCTAssertEqual(saved.row.progress.captures, 9)
                }
            }
        }
    }

    func testManualReceiptValidatesBeforeAttemptingAnyPersistentCommit() throws {
        let (saved, window) = try fixture()
        var response = confirmed(saved, window)
        response["transaction"] = ["hex": saved.retry.hex, "txid": String(repeating: "ab", count: 32)]
        var writes = 0
        XCTAssertThrowsError(try saved.commitReceipt(response, known: window, now: 1) { writes += 1 })
        XCTAssertEqual(writes, 0); XCTAssertFalse(saved.acknowledged); XCTAssertFalse(saved.counted)
        XCTAssertEqual(saved.nextCheck, 0)
    }
    func testAbsenceNeverBypassesCurrentStateIdentityOrFreshness() throws {
        let (saved, _) = try fixture(); _ = saved.acknowledge(now: 1)
        for state in ["spent", "pending_spend", "immature"] {
            var row = saved.row; row.state = state
            XCTAssertFalse(saved.availableForRetry(catalog: row, retained: saved.row, normallyAged: true, coherent: true))
        }
        XCTAssertFalse(saved.availableForRetry(catalog: saved.row, retained: nil, normallyAged: false, coherent: false))
        XCTAssertFalse(saved.availableForRetry(catalog: nil, retained: saved.row, normallyAged: false, coherent: true))
        XCTAssertFalse(saved.availableForRetry(catalog: nil, retained: nil, normallyAged: true, coherent: true))
        var changed = saved.row.bounty; changed["amount"] = "1000001"
        let changedRow = try ClaimCandidate(changed, block: saved.row.block, fee: 0)
        XCTAssertFalse(saved.availableForRetry(catalog: changedRow, retained: saved.row, normallyAged: false, coherent: true))
        XCTAssertTrue(saved.availableForRetry(catalog: nil, retained: saved.row, normallyAged: true, coherent: true))
    }
    func testOnlyMatchingConfirmedTransactionAndCanonicalLocationCanReleaseBytes() throws {
        let (saved, window) = try fixture(); _ = saved.acknowledge(now: 0)
        let good = confirmed(saved, window)
        XCTAssertEqual(try saved.location(good, known: window), .confirmed)
        var badCases = [JSONObject]()
        for key in ["status", "block_hash", "block_height", "transaction", "tip"] {
            var value = good; value.removeValue(forKey: key); badCases.append(value)
        }
        var value = good; value["block_height"] = 4; badCases.append(value)
        value = good; value["block_height"] = 0; badCases.append(value)
        value = good; value["block_hash"] = String(repeating: "ab", count: 32); badCases.append(value)
        value = good; value["block_height"] = window.tip.height; badCases.append(value)
        value = good; value["transaction"] = ["hex": try PJ.string(PJ.object(PaymentVectors.fixture()["payment"])["hex"])]; badCases.append(value)
        var wrongTip = window.tip.json; wrongTip["genesis_hash"] = String(repeating: "00", count: 32)
        value = good; value["tip"] = wrongTip; badCases.append(value)
        value = pending(saved, window); value["block_hash"] = window.tip.hash; badCases.append(value)
        let malformedConfirmations: [Any] = [true, "1", -1, 1.5, NSNull()]
        for malformed in malformedConfirmations {
            value = good; value["transaction"] = ["hex": saved.retry.hex, "confirmations": malformed]; badCases.append(value)
        }
        value = good; value["transaction"] = ["hex": saved.retry.hex, "confirmations": 0]; badCases.append(value)
        value = pending(saved, window); value["transaction"] = ["hex": saved.retry.hex, "confirmations": 1]; badCases.append(value)
        value = good; value["transaction"] = ["hex": saved.retry.hex, "blockhash": String(repeating: "ab", count: 32)]; badCases.append(value)
        value = pending(saved, window); value["transaction"] = ["hex": saved.retry.hex, "blockhash": window.tip.hash]; badCases.append(value)
        value = good; value["transaction"] = ["hex": saved.retry.hex, "txid": String(repeating: "ab", count: 32)]; badCases.append(value)
        for bad in badCases { XCTAssertThrowsError(try saved.location(bad, known: window)) }
        value = good; value["transaction"] = ["hex": saved.retry.hex, "confirmations": 2, "blockhash": window.blocks[1].hash]
        XCTAssertEqual(try saved.location(value, known: window), .confirmed)
        value = pending(saved, window); value["transaction"] = ["hex": saved.retry.hex, "confirmations": 0]
        XCTAssertEqual(try saved.location(value, known: window), .pending)
        var movedTip = window.tip.json; movedTip["hash"] = String(repeating: "cd", count: 32)
        value = good; value["tip"] = movedTip
        XCTAssertThrowsError(try saved.location(value, known: window)) { error in
            XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_SNAPSHOT_STALE")
        }
        XCTAssertTrue(saved.acknowledged, "Failed validation never releases or edits the retained transaction")
    }
    func testPauseRetentionAndRejectionDrainDoNotResetBytesCooldownOrReopenEvidence() throws {
        let (saved, _) = try fixture()
        let hex = saved.retry.hex, txid = saved.retry.txid
        var refusal = RpcFailure("-32030"); refusal.notForwarded = true; refusal.retryAfterMs = 120_000
        XCTAssertTrue(saved.retry.retain(after: refusal, now: 1))
        // The engine retains this record rather than a lifecycle-bound Winner.
        let afterPause = saved
        XCTAssertTrue(afterPause === saved); XCTAssertEqual(afterPause.retry.due, 121)
        afterPause.beginWrite(); afterPause.reopened()
        XCTAssertTrue(afterPause.reopenedSinceWrite, "A valid event arriving before rejection callback cannot be lost")
        afterPause.beginWrite(); XCTAssertFalse(afterPause.reopenedSinceWrite)
        XCTAssertEqual(afterPause.retry.hex, hex); XCTAssertEqual(afterPause.retry.txid, txid)
        XCTAssertFalse(afterPause.acknowledged); XCTAssertFalse(afterPause.counted)
    }

    func testIndexCoreLocationRacesAreRetryableButNeverResolveOrReleaseProof() throws {
        let (saved, window) = try fixture(), originalHex = saved.retry.hex
        saved.row.progress.captures = 7
        XCTAssertTrue(saved.acknowledge(now: 10))
        var races = [JSONObject]()
        var response = pending(saved, window)
        response["transaction"] = ["hex": originalHex, "confirmations": 1, "blockhash": window.tip.hash]; races.append(response)
        response = pending(saved, window)
        response["transaction"] = ["hex": originalHex, "blockhash": window.tip.hash]; races.append(response)
        response = confirmed(saved, window)
        response["transaction"] = ["hex": originalHex, "confirmations": 0, "blockhash": window.blocks[1].hash]; races.append(response)
        response = confirmed(saved, window)
        response["transaction"] = ["hex": originalHex, "confirmations": 1, "blockhash": window.tip.hash]; races.append(response)
        for race in races {
            // Both the automatic retained owner and manual lookup after an
            // app restart must reject the inconsistent location. Only the
            // former schedules automatic maintenance retries.
            XCTAssertThrowsError(try saved.location(race, known: window)) { error in
                XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_SNAPSHOT_STALE")
            }
            XCTAssertThrowsError(try ClaimSavedSubmission.validateReceipt(race, expectedTxid: saved.retry.txid)) { error in
                XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_SNAPSHOT_STALE")
            }
            XCTAssertEqual(saved.retry.hex, originalHex); XCTAssertTrue(saved.acknowledged); XCTAssertTrue(saved.counted)
            XCTAssertEqual(saved.row.progress.captures, 7); XCTAssertEqual(saved.nextCheck, 40)
        }
        XCTAssertEqual(try saved.location(pending(saved, window), known: window), .pending)
        XCTAssertEqual(try saved.location(confirmed(saved, window), known: window), .confirmed)
        XCTAssertFalse(saved.acknowledge(now: 41), "A later coherent receipt does not create a second submitted count")
    }

    func testLocationRaceCannotHideMalformedMetadataOrTransactionIdentity() throws {
        let (saved, window) = try fixture()
        var invalid = [JSONObject]()
        var response = pending(saved, window)
        response["transaction"] = ["hex": saved.retry.hex, "confirmations": 1, "blockhash": NSNull()]; invalid.append(response)
        response = pending(saved, window)
        response["transaction"] = ["hex": saved.retry.hex, "confirmations": "1", "blockhash": window.tip.hash]; invalid.append(response)
        response = pending(saved, window); response["block_hash"] = window.tip.hash
        response["transaction"] = ["hex": saved.retry.hex, "confirmations": 1]; invalid.append(response)
        response = confirmed(saved, window); response["block_height"] = NSNull()
        response["transaction"] = ["hex": saved.retry.hex, "confirmations": 0]; invalid.append(response)
        response = confirmed(saved, window)
        response["transaction"] = ["hex": saved.retry.hex, "confirmations": 0, "txid": String(repeating: "ab", count: 32)]; invalid.append(response)
        for malformed in invalid {
            XCTAssertThrowsError(try saved.location(malformed, known: window)) { error in
                XCTAssertNotEqual((error as? WalletError)?.message, "CLAIMS_SNAPSHOT_STALE")
            }
        }
    }

    func testAgedOwnPendingNeedsFreshAbsenceAndNeverRestoresSchedulerAvailability() throws {
        let (saved, _) = try fixture(), oldest = saved.row.height + 1
        var ownPending = saved.row; ownPending.state = "pending_spend"; ownPending.spendingTxid = saved.retry.txid
        _ = saved.acknowledge(now: 10)
        XCTAssertTrue(saved.agedAbsenceMayRestoreOwnPending(current: ownPending, oldestHeight: oldest, coherent: true))
        XCTAssertFalse(saved.availableForRetry(catalog: nil, retained: ownPending, normallyAged: false, coherent: true, oldestHeight: oldest))
        saved.observedAgedAbsence(current: ownPending, oldestHeight: oldest, catalogAt: 10, coherent: true)
        XCTAssertFalse(saved.ownAbsenceValidated, "A pre-ACK snapshot cannot prove current availability")
        saved.observedAgedAbsence(current: ownPending, oldestHeight: oldest, catalogAt: 11, coherent: false)
        XCTAssertFalse(saved.ownAbsenceValidated)
        saved.observedAgedAbsence(current: ownPending, oldestHeight: oldest, catalogAt: 11, coherent: true)
        XCTAssertTrue(saved.ownAbsenceValidated)
        XCTAssertTrue(saved.availableForRetry(catalog: nil, retained: ownPending, normallyAged: false, coherent: true, oldestHeight: oldest))
        XCTAssertTrue(saved.matchesCurrent(catalog: nil, retained: ownPending, oldestHeight: oldest))
        XCTAssertFalse(saved.availableForRetry(catalog: ownPending, retained: ownPending, normallyAged: false, coherent: true, oldestHeight: oldest))
        XCTAssertFalse(saved.availableForRetry(catalog: nil, retained: ownPending, normallyAged: false, coherent: false, oldestHeight: oldest))
        XCTAssertFalse(saved.availableForRetry(catalog: nil, retained: ownPending, normallyAged: false, coherent: true, oldestHeight: saved.row.height))
        XCTAssertFalse(saved.availableForRetry(catalog: nil, retained: nil, normallyAged: false, coherent: true, oldestHeight: oldest))
        var competitor = ownPending; competitor.spendingTxid = String(repeating: "ab", count: 32)
        var spent = ownPending; spent.state = "spent"
        for row in [competitor, spent] {
            XCTAssertFalse(saved.availableForRetry(catalog: nil, retained: row, normallyAged: true, coherent: true, oldestHeight: oldest))
        }
        XCTAssertEqual(ownPending.state, "pending_spend", "Only the saved transaction is authorized, not the scheduler row")
        saved.beginWrite()
        XCTAssertTrue(saved.ownAbsenceValidated, "A pre-write permit still needs the validated absence during the same attempt")
        saved.foundPending()
        XCTAssertFalse(saved.ownAbsenceValidated, "A successful read of the transaction supersedes an older absence")
        saved.observedAgedAbsence(current: ownPending, oldestHeight: oldest, catalogAt: 11, coherent: true)
        XCTAssertFalse(saved.acknowledge(now: 12)); XCTAssertFalse(saved.ownAbsenceValidated)
    }

    func testSnapshotSpenderIsValidatedAndDoesNotChangeProofIdentityOrProgress() throws {
        let (saved, _) = try fixture()
        saved.row.progress.captures = 2; saved.row.progress.prepared = ["challenge": "unchanged"]
        var source = saved.row.bounty; source["status"] = "pending_spend"; source["spending_txid"] = saved.retry.txid
        var pending = try ClaimCandidate(source, block: saved.row.block, fee: 0)
        try pending.reuse(saved.row.progress)
        XCTAssertEqual(pending.spendingTxid, saved.retry.txid); XCTAssertEqual(pending.identity, saved.row.identity)
        XCTAssertTrue(pending.progress === saved.row.progress); XCTAssertEqual(pending.progress.captures, 2)
        source["spending_txid"] = "invalid"
        XCTAssertThrowsError(try ClaimCandidate(source, block: saved.row.block, fee: 0))
        source["spending_txid"] = NSNull()
        XCTAssertNil(try ClaimCandidate(source, block: saved.row.block, fee: 0).spendingTxid)
    }

    func testRejectionKeepsSameProofUntilValidatedReopeningAndRetainsPriorAck() throws {
        for previouslyAcked in [false, true] {
            let (saved, window) = try fixture(), hex = saved.retry.hex, txid = saved.retry.txid
            if previouslyAcked { XCTAssertTrue(saved.acknowledge(now: 1)) }
            saved.beginWrite(); saved.rejected()
            XCTAssertTrue(saved.waitingForAvailability)
            XCTAssertFalse(saved.availableForRetry(catalog: saved.row, retained: nil, normallyAged: false, coherent: true))
            XCTAssertEqual(saved.acknowledged, previouslyAcked); XCTAssertEqual(saved.counted, previouslyAcked)
            // A rejection of a replay cannot erase the earlier ACK: it may
            // still become confirmed without any further broadcast.
            XCTAssertEqual(try saved.location(confirmed(saved, window), known: window), .confirmed)
            saved.reopened()
            XCTAssertFalse(saved.waitingForAvailability)
            XCTAssertTrue(saved.availableForRetry(catalog: saved.row, retained: nil, normallyAged: false, coherent: true))
            XCTAssertEqual(saved.retry.hex, hex); XCTAssertEqual(saved.retry.txid, txid)
            XCTAssertEqual(saved.acknowledge(now: 2), !previouslyAcked)
        }
        let (racing, _) = try fixture()
        racing.beginWrite(); racing.reopened(); racing.rejected()
        XCTAssertFalse(racing.waitingForAvailability, "Reopening committed before the response is still valid evidence")
        XCTAssertTrue(racing.availableForRetry(catalog: racing.row, retained: nil, normallyAged: false, coherent: true))
    }

    func testObservedAlternativeWitnessDoesNotReplaceOurImmutableReplayBytes() throws {
        let (saved, window) = try fixture(), original = saved.retry.hex
        // Public synthetic framing fixture, not a certificate/signature vector.
        // Adding a CertificateVerify payload changes wtxid but not input/payout.
        var proof = [UInt8](try NativeTransactions.bytes(PJ.string(PaymentVectors.fixture()["proof"])))
        proof[proof.count - 1] = 1; proof.append(42)
        var observed = try NativeTransactions.parse(original), inputs = try PJ.objects(observed["inputs"])
        inputs[0]["witness"] = [WalletCrypto.hex(Data(proof))]; observed["inputs"] = inputs
        let raw = try WalletCrypto.hex(NativeTransactions.serialize(observed))
        XCTAssertNotEqual(raw, original); XCTAssertEqual(try NativeTransactions.txid(observed), saved.retry.txid)
        _ = saved.acknowledge(now: 1)
        for isConfirmed in [false, true] {
            var response = isConfirmed ? confirmed(saved, window) : pending(saved, window)
            response["transaction"] = ["hex": raw, "txid": saved.retry.txid]
            XCTAssertEqual(try saved.location(response, known: window), isConfirmed ? .confirmed : .pending)
            XCTAssertEqual(saved.retry.hex, original, "Observed witness never overwrites the locally verified replay payload")
        }
        _ = try NativeTransactions.validateObservedClaim(raw, expectedTxid: saved.retry.txid)
        XCTAssertFalse(saved.acknowledge(now: 2), "Observation/replay cannot add a second submitted claim")
    }

    func testSameTxidCannotHideMalformedObservedProofOrWrongChallenge() throws {
        let (saved, _) = try fixture(), original = try NativeTransactions.parse(saved.retry.hex)
        let proof = [UInt8](try NativeTransactions.bytes(PJ.string(PaymentVectors.fixture()["proof"])))
        var changedChallenge = proof; changedChallenge[7] ^= 1
        var changedType = proof; changedType[39] = 3
        var changedLength = proof; changedLength[2] = 1
        let badProofs: [[UInt8]] = [[], [1], Array(proof.dropLast()), proof + [0], changedChallenge, changedType, changedLength]
        for badProof in badProofs {
            var observed = original, inputs = try PJ.objects(original["inputs"])
            inputs[0]["witness"] = [WalletCrypto.hex(Data(badProof))]; observed["inputs"] = inputs
            let raw = try WalletCrypto.hex(NativeTransactions.serialize(observed))
            XCTAssertEqual(try NativeTransactions.txid(observed), saved.retry.txid)
            XCTAssertThrowsError(try NativeTransactions.validateObservedClaim(raw, expectedTxid: saved.retry.txid, originalHex: saved.retry.hex))
            XCTAssertThrowsError(try NativeTransactions.validateObservedClaim(raw, expectedTxid: saved.retry.txid))
        }
        for stack in [[String](), [WalletCrypto.hex(Data(proof)), "00"]] {
            var observed = original, inputs = try PJ.objects(original["inputs"])
            inputs[0]["witness"] = stack; observed["inputs"] = inputs
            let raw = try WalletCrypto.hex(NativeTransactions.serialize(observed))
            XCTAssertEqual(try NativeTransactions.txid(observed), saved.retry.txid)
            XCTAssertThrowsError(try NativeTransactions.validateObservedClaim(raw, expectedTxid: saved.retry.txid, originalHex: saved.retry.hex))
        }
        var changed = original, outputs = try PJ.objects(original["outputs"])
        outputs[0]["amount"] = "1"; changed["outputs"] = outputs
        let changedRaw = try WalletCrypto.hex(NativeTransactions.serialize(changed)), changedID = try NativeTransactions.txid(changed)
        XCTAssertThrowsError(try NativeTransactions.validateObservedClaim(changedRaw, expectedTxid: saved.retry.txid, originalHex: saved.retry.hex))
        XCTAssertThrowsError(try NativeTransactions.validateObservedClaim(changedRaw, expectedTxid: changedID, originalHex: saved.retry.hex))
        for change in ["version", "locktime", "script", "sequence"] {
            var invalid = original, inputs = try PJ.objects(original["inputs"])
            if change == "version" { invalid["version"] = 3 }
            if change == "locktime" { invalid["locktime"] = 1 }
            if change == "script" { inputs[0]["scriptSig"] = "00" }
            if change == "sequence" { inputs[0]["sequence"] = 1 }
            invalid["inputs"] = inputs
            XCTAssertThrowsError(try NativeTransactions.validateObservedClaim(WalletCrypto.hex(NativeTransactions.serialize(invalid)),
                expectedTxid: NativeTransactions.txid(invalid)))
        }
    }

    func testObservedClaimRechecksWorkAgainstTheCapturedBountyTarget() throws {
        let (saved, window) = try fixture()
        var proof = [UInt8](try NativeTransactions.bytes(PJ.string(PaymentVectors.fixture()["proof"])))
        // Change ServerHello, one of the four work-hashed messages, while
        // retaining the ClientHello challenge and the transaction's txid.
        proof[42] = 1; proof.insert(42, at: 43)
        var observed = try NativeTransactions.parse(saved.retry.hex), inputs = try PJ.objects(observed["inputs"])
        inputs[0]["witness"] = [WalletCrypto.hex(Data(proof))]; observed["inputs"] = inputs
        let raw = try WalletCrypto.hex(NativeTransactions.serialize(observed))
        XCTAssertEqual(try NativeTransactions.txid(observed), saved.retry.txid)
        _ = try NativeTransactions.validateObservedClaim(raw, expectedTxid: saved.retry.txid, originalHex: saved.retry.hex,
            target: String(repeating: "ff", count: 32))
        XCTAssertThrowsError(try NativeTransactions.validateObservedClaim(raw, expectedTxid: saved.retry.txid,
            originalHex: saved.retry.hex, target: String(repeating: "00", count: 32)))
        XCTAssertThrowsError(try NativeTransactions.validateObservedClaim(raw, expectedTxid: saved.retry.txid,
            originalHex: saved.retry.hex, target: "ff"))
        var strictBounty = saved.row.bounty; strictBounty["connection_work_target"] = String(repeating: "00", count: 32)
        let strictRow = try ClaimCandidate(strictBounty, block: saved.row.block, fee: 0)
        let strict = ClaimSavedSubmission(row: strictRow, retry: saved.retry)
        _ = strict.acknowledge(now: 1)
        var response = confirmed(strict, window); response["transaction"] = ["hex": raw]
        XCTAssertThrowsError(try strict.location(response, known: window))
        XCTAssertTrue(strict.acknowledged); XCTAssertTrue(strict.counted)
        XCTAssertEqual(strict.retry.hex, saved.retry.hex, "Invalid observed work cannot replace or release our retained proof")
        XCTAssertEqual(saved.retry.hex, try PJ.string(PJ.object(PaymentVectors.fixture()["attached"])["hex"]))
    }
}
