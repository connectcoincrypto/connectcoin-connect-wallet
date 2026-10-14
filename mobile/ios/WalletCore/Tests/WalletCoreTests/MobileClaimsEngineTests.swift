import XCTest
@testable import WalletCore

private final class ClaimsOfflineWire: RpcWire {
    func start(queue: DispatchQueue, ready: @escaping () -> Void, receive: @escaping (Data) -> Void, failed: @escaping () -> Void) { failed() }
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void) { XCTFail("Offline claims test attempted a network write"); completed(false) }
    func cancel() {}
}

private final class ClaimsReceiptWire: RpcWire, @unchecked Sendable {
    private let mutex = NSLock()
    private let response: JSONObject
    private var receive: ((Data) -> Void)?, methods: [String] = []
    init(_ response: JSONObject) { self.response = response }
    var requests: [String] { mutex.lock(); defer { mutex.unlock() }; return methods }
    func start(queue: DispatchQueue, ready: @escaping () -> Void, receive: @escaping (Data) -> Void, failed: @escaping () -> Void) {
        mutex.lock(); self.receive = receive; mutex.unlock(); ready()
    }
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void) {
        do {
            let request = try JSON.decode(Data(bytes.dropLast()))
            mutex.lock(); methods.append(request["method"] as? String ?? ""); let callback = receive; mutex.unlock()
            completed(true)
            callback?(try JSON.encode(["jsonrpc": "2.0", "id": request["id"]!, "result": response]) + Data([10]))
        } catch { completed(false) }
    }
    func cancel() {}
}

final class MobileClaimsEngineTests: XCTestCase {
    private let address = "cc1p4t449ht5jnpkzpyaue7vdq8g867th0d7kymr0kfvmpzlwqcg4a0qc59p3e"
    private let txid = String(repeating: "ab", count: 32)
    private func location() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-tests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appendingPathComponent("receipt.json")
    }

    func testPendingOrUnknownReceiptNeverRestartsClaims() async throws {
        for status in ["pending", "unknown"] {
            let url = try location()
            try ClaimsPublicStore.write(["txid": txid, "status": status], to: url)
            let rpc = MobileRpcClient(factory: { ClaimsOfflineWire() }); defer { rpc.close() }
            let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            await engine.setActive(true)
            do { try await engine.start(address: address); XCTFail("Indeterminate submission restarted") }
            catch let error as WalletError { XCTAssertEqual(error.message, "CLAIMS_UNKNOWN_OUTCOME") }
            let state = await engine.state()
            XCTAssertEqual(state["running"] as? Bool, false)
            XCTAssertEqual(state["receiptTxid"] as? String, txid)
            XCTAssertEqual(state["receiptStatus"] as? String, status)
            XCTAssertEqual(state["unknown"] as? Int64, 1)
            XCTAssertEqual(state["nativeBackgroundAvailable"] as? Bool, false)
            await engine.close()
        }
    }

    func testMalformedOrOversizedReceiptFailsClosed() async throws {
        for contents in [Data("{}".utf8), Data(repeating: 32, count: ClaimsPublicStore.maximumBytes + 1)] {
            let url = try location(); try contents.write(to: url)
            let rpc = MobileRpcClient(factory: { ClaimsOfflineWire() }); defer { rpc.close() }
            let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            await engine.setActive(true)
            do { try await engine.start(address: address); XCTFail("Invalid receipt restarted") }
            catch let error as WalletError { XCTAssertEqual(error.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
            await engine.close()
        }
    }

    func testPreBroadcastReceiptWriteFailureCanRetryAfterStorageRecovers() async throws {
        let url = try location(), rpc = MobileRpcClient(factory: { ClaimsOfflineWire() })
        defer { rpc.close() }
        let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        await engine.setActive(true)
        try await engine.start(address: address)
        // A directory at the destination makes the real atomic replacement
        // fail. This is the production preflight called by submit(), before
        // rpc.broadcast; no native capture or live connection is fabricated.
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        for _ in 0..<2 {
            do { try await engine.persistPendingSubmission(txid); XCTFail("Receipt write unexpectedly succeeded") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
            let failed = await engine.state()
            XCTAssertEqual(failed["enabled"] as? Bool, false)
            XCTAssertEqual(failed["lastError"] as? String, "CLAIMS_RECEIPT_UNAVAILABLE")
            XCTAssertEqual(failed["submitted"] as? Int64, 0)
            XCTAssertEqual(failed["unknown"] as? Int64, 0)
            // Retrying while storage is still broken must stop at persistence
            // again, rather than bypassing it or becoming an unknown broadcast.
            try await engine.start(address: address)
        }
        try FileManager.default.removeItem(at: url)
        try await engine.persistPendingSubmission(txid)
        let saved = try ClaimsPublicStore.read(url), state = await engine.state()
        XCTAssertEqual(saved["txid"] as? String, txid)
        XCTAssertEqual(saved["status"] as? String, "pending")
        XCTAssertEqual(state["submitted"] as? Int64, 0)
        XCTAssertEqual(state["unknown"] as? Int64, 0)
        await engine.close()
        // Only the original live preflight knows that no write was attempted.
        // A process restart must conservatively keep the pending receipt guard.
        let restarted = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        await restarted.setActive(true)
        do { try await restarted.start(address: address); XCTFail("Restart bypassed a pending receipt") }
        catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_UNKNOWN_OUTCOME") }
        await restarted.close()
    }

    func testPreflightRetryCannotOverrideCorruptStartupOrUnknownReceipt() async throws {
        for initial in [Data("{}".utf8), try JSON.encode(["txid": txid, "status": "unknown"])] {
            let url = try location(); try initial.write(to: url)
            let rpc = MobileRpcClient(factory: { ClaimsOfflineWire() }); defer { rpc.close() }
            let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            await engine.setActive(true)
            do { try await engine.persistPendingSubmission(txid); XCTFail("Stopped preflight replaced the startup receipt") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_STOPPED") }
            XCTAssertEqual(try Data(contentsOf: url), initial)
            do { try await engine.start(address: address); XCTFail("Unsafe startup receipt was bypassed") }
            catch {
                XCTAssertTrue(["CLAIMS_RECEIPT_UNAVAILABLE", "CLAIMS_UNKNOWN_OUTCOME"].contains((error as? WalletError)?.message ?? ""))
            }
            await engine.close()
        }
    }

    private func retainedFixture() throws -> (ClaimSavedSubmission, String) {
        let fixture = try PaymentVectors.fixture(), attached = try PJ.object(fixture["attached"])
        var bounty = try PJ.object(fixture["bounty"])
        let block = String(repeating: "12", count: 32)
        bounty["block_hash"] = block; bounty["block_height"] = 1
        bounty["confirmations"] = 1; bounty["coinbase"] = false; bounty["status"] = "available"
        let row = try ClaimCandidate(bounty, block: block, fee: 1500, factor: 1_000_000)
        row.progress.prepared = try PJ.object(fixture["claim"])
        let saved = ClaimSavedSubmission(row: row, retry: ClaimSubmissionRetry(
            hex: try PJ.string(attached["hex"]), txid: try PJ.hash(attached["txid"])))
        return (saved, try PJ.string(fixture["rewardAddress"]))
    }

    func testKnownUnsentReceiptFailureCanRecoverOnlyAfterDurableSameOwnerCommit() async throws {
        for gateway in [false, true] {
            let url = try location(), rpc = MobileRpcClient(factory: { ClaimsOfflineWire() })
            defer { rpc.close() }
            let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            let (saved, reward) = try retainedFixture()
            let hex = saved.retry.hex, ownerTxid = saved.retry.txid
            await engine.setActive(true); try await engine.start(address: reward)
            // Register through the same production path as a completed capture.
            // This fixture does not perform TLS work or fabricate a wire send.
            try await engine.retainCompletedSubmission(saved)
            try await engine.persistPendingSubmission(ownerTxid)
            try FileManager.default.removeItem(at: url)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
            var refusal = RpcFailure(gateway ? "-32029" : "RPC_UNAVAILABLE")
            refusal.notSent = !gateway; refusal.notForwarded = gateway; refusal.retryAfterMs = 120_000
            let before = ProcessInfo.processInfo.systemUptime
            do { _ = try await engine.persistUnsentSubmission(saved, failure: refusal); XCTFail("Broken receipt storage succeeded") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
            let blocked = await engine.state()
            XCTAssertEqual(blocked["enabled"] as? Bool, false)
            XCTAssertEqual(blocked["status"] as? String, "unknown-outcome")
            XCTAssertEqual(blocked["unknown"] as? Int64, 1)
            XCTAssertEqual(blocked["retainedSubmissions"] as? Int, 1)
            XCTAssertEqual(blocked["submitted"] as? Int64, 0)
            XCTAssertGreaterThanOrEqual(saved.retry.due, before + 120)
            let due = saved.retry.due
            for _ in 0..<2 {
                do { try await engine.start(address: reward); XCTFail("Uncommitted no-write evidence unblocked claims") } catch {}
                let stillBlocked = await engine.state()
                XCTAssertEqual(stillBlocked["enabled"] as? Bool, false)
                XCTAssertEqual(stillBlocked["unknown"] as? Int64, 1)
            }
            try FileManager.default.removeItem(at: url)
            try ClaimsPublicStore.write(["txid": ownerTxid, "status": "pending"], to: url)
            // The persisted pending receipt cannot manufacture the live token.
            let restarted = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            await restarted.setActive(true)
            do { try await restarted.start(address: reward); XCTFail("Restart inferred no send from a pending receipt") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_UNKNOWN_OUTCOME") }
            await restarted.close()

            // Neither a changed receiving identity nor a different pending
            // receipt may use the old transport result to overwrite ownership.
            do { try await engine.start(address: address); XCTFail("Old proof was rebound to another address") } catch {}
            let other = String(repeating: "bc", count: 32)
            try ClaimsPublicStore.write(["txid": other, "status": "unknown"], to: url)
            do { try await engine.start(address: reward); XCTFail("Another pending owner was overwritten") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
            XCTAssertEqual(try ClaimsPublicStore.read(url)["txid"] as? String, other)
            // A failed post-rename write may already have exposed not-sent.
            // It still requires a successful durable commit in this live owner.
            try ClaimsPublicStore.write(["txid": ownerTxid, "status": gateway ? "not-sent" : "pending"], to: url)
            await engine.setActive(false)
            do { try await engine.start(address: reward); XCTFail("Recovery ignored the foreground guard") } catch {}
            await engine.setActive(true)
            try await engine.start(address: reward)
            let recovered = await engine.state(), receipt = try ClaimsPublicStore.read(url)
            XCTAssertEqual(receipt["status"] as? String, "not-sent")
            XCTAssertEqual(receipt["txid"] as? String, ownerTxid)
            XCTAssertEqual(recovered["enabled"] as? Bool, true)
            XCTAssertEqual(recovered["unknown"] as? Int64, 0)
            XCTAssertEqual(recovered["retainedSubmissions"] as? Int, 1)
            XCTAssertEqual(recovered["submitted"] as? Int64, 0)
            XCTAssertEqual(saved.retry.hex, hex); XCTAssertEqual(saved.retry.txid, ownerTxid)
            XCTAssertEqual(saved.retry.due, due); XCTAssertEqual(saved.retry.failures, 1)
            XCTAssertFalse(saved.acknowledged); XCTAssertFalse(saved.counted)
            // The next actual submit still goes through its mandatory pending
            // receipt preflight. No broadcast is performed by this test.
            try await engine.persistPendingSubmission(ownerTxid)
            XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "pending")
            await engine.close()
        }
    }

    func testAcknowledgedReceiptFailureCanRecoverStorageWithoutImmediateReplay() async throws {
        for previouslyAcked in [false, true] {
            for postRenameState in [false, true] {
                let url = try location(), rpc = MobileRpcClient(factory: { ClaimsOfflineWire() })
                defer { rpc.close() }
                let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
                let (saved, reward) = try retainedFixture()
                let hex = saved.retry.hex, ownerTxid = saved.retry.txid
                let ack: JSONObject = ["txid": ownerTxid]
                await engine.setActive(true); try await engine.start(address: reward)
                try await engine.retainCompletedSubmission(saved)
                try await engine.persistPendingSubmission(ownerTxid)
                if previouslyAcked {
                    try await engine.persistAcknowledgedSubmission(saved, response: ack)
                    try await engine.persistPendingSubmission(ownerTxid)
                }
                try FileManager.default.removeItem(at: url)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
                // submit() uses this exact helper after its RPC ACK. The real
                // writer fails at rename; no TLS connection or send is made.
                do { try await engine.persistAcknowledgedSubmission(saved, response: ack); XCTFail("Broken ACK receipt storage succeeded") }
                catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
                var state = await engine.state()
                XCTAssertEqual(state["unknown"] as? Int64, 1)
                XCTAssertEqual(state["enabled"] as? Bool, false)
                XCTAssertEqual(state["submitted"] as? Int64, previouslyAcked ? 1 : 0)
                XCTAssertEqual(saved.acknowledged, previouslyAcked); XCTAssertEqual(saved.counted, previouslyAcked)
                for _ in 0..<2 {
                    do { try await engine.start(address: reward); XCTFail("ACK recovery ignored broken storage") }
                    catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
                    state = await engine.state()
                    XCTAssertEqual(state["unknown"] as? Int64, 1)
                    XCTAssertEqual(state["enabled"] as? Bool, false)
                }
                try FileManager.default.removeItem(at: url)
                try ClaimsPublicStore.write(["txid": ownerTxid, "status": "pending"], to: url)
                let restarted = MobileClaimsEngine(rpc: rpc, receiptURL: url)
                await restarted.setActive(true)
                do { try await restarted.start(address: reward); XCTFail("Restart manufactured a broadcast ACK") }
                catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_UNKNOWN_OUTCOME") }
                await restarted.close()
                let other = String(repeating: "cd", count: 32)
                try ClaimsPublicStore.write(["txid": other, "status": "unknown"], to: url)
                do { try await engine.start(address: reward); XCTFail("ACK overwrote a different pending owner") }
                catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
                XCTAssertEqual(try ClaimsPublicStore.read(url)["txid"] as? String, other)
                // The submitted variant is the observable state after a failed
                // post-rename commit, not an injected fsync failure.
                try ClaimsPublicStore.write(["txid": ownerTxid, "status": postRenameState ? "submitted" : "pending"], to: url)
                let beforeRecovery = ProcessInfo.processInfo.systemUptime
                try await engine.start(address: reward)
                state = await engine.state()
                XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "submitted")
                XCTAssertEqual(state["enabled"] as? Bool, true); XCTAssertEqual(state["unknown"] as? Int64, 0)
                XCTAssertEqual(state["submitted"] as? Int64, 0, "Recovery does not credit an old ACK to the new run")
                XCTAssertEqual(state["attempts"] as? Int64, 0); XCTAssertEqual(state["retainedSubmissions"] as? Int, 1)
                XCTAssertEqual(saved.retry.hex, hex); XCTAssertEqual(saved.retry.txid, ownerTxid)
                XCTAssertTrue(saved.acknowledged); XCTAssertTrue(saved.counted); XCTAssertFalse(saved.ownAbsenceValidated)
                XCTAssertGreaterThanOrEqual(saved.nextCheck, beforeRecovery + 30)
                XCTAssertFalse(saved.absentAfterFreshSnapshot(catalogAt: beforeRecovery, available: true),
                    "ACK recovery cannot authorize replay from the old catalog")
                // Any later real retry still needs ordinary reconciliation and
                // the pending preflight. A repeated ACK never counts twice.
                try await engine.persistPendingSubmission(ownerTxid)
                try await engine.persistAcknowledgedSubmission(saved, response: ack)
                state = await engine.state(); XCTAssertEqual(state["submitted"] as? Int64, 0)
                XCTAssertEqual(saved.retry.hex, hex)
                await engine.close()
            }
        }
    }

    func testAcknowledgedReceiptRecoveryRequiresMatchingResponseAndExactOwner() async throws {
        let url = try location(), rpc = MobileRpcClient(factory: { ClaimsOfflineWire() })
        defer { rpc.close() }
        let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        let (saved, reward) = try retainedFixture()
        await engine.setActive(true); try await engine.start(address: reward)
        try await engine.retainCompletedSubmission(saved)
        try await engine.persistPendingSubmission(saved.retry.txid)
        let invalid: [JSONObject] = [[:], ["txid": NSNull()], ["txid": 1],
            ["txid": [saved.retry.txid]], ["txid": String(repeating: "bc", count: 32)]]
        for response in invalid {
            do { try await engine.persistAcknowledgedSubmission(saved, response: response); XCTFail("Invalid ACK acquired live evidence") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
        }
        let duplicate = ClaimSavedSubmission(row: saved.row, retry: saved.retry)
        do { try await engine.persistAcknowledgedSubmission(duplicate, response: ["txid": saved.retry.txid]); XCTFail("Another proof object acquired ACK ownership") }
        catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
        XCTAssertFalse(saved.acknowledged); XCTAssertFalse(saved.counted)
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "pending")
        let state = await engine.state()
        XCTAssertEqual(state["unknown"] as? Int64, 0); XCTAssertEqual(state["submitted"] as? Int64, 0)
        await engine.close()
    }

    func testRejectedReceiptFailureRecoversStorageButNotAvailability() async throws {
        for previouslyAcked in [false, true] {
            for alreadyReopened in [false, true] {
                let url = try location(), rpc = MobileRpcClient(factory: { ClaimsOfflineWire() })
                defer { rpc.close() }
                let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
                let (saved, reward) = try retainedFixture()
                let hex = saved.retry.hex, ownerTxid = saved.retry.txid
                await engine.setActive(true); try await engine.start(address: reward)
                try await engine.retainCompletedSubmission(saved)
                try await engine.persistPendingSubmission(ownerTxid)
                if previouslyAcked { XCTAssertTrue(saved.acknowledge(now: 1)) }
                saved.retry.waitForFreshCatalog(now: 120)
                let due = saved.retry.due
                saved.beginWrite()
                if alreadyReopened { saved.reopened() }
                try FileManager.default.removeItem(at: url)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
                var rejected = RpcFailure("-32020"); rejected.explicitRejection = true; rejected.nodeCode = -26
                // This is the helper used by submit's real rejection branch,
                // with its real atomic writer failing at rename. The synthetic
                // attached fixture does not claim to execute a TLS/broadcast.
                do { try await engine.persistRejectedSubmission(saved, failure: rejected); XCTFail("Broken receipt storage succeeded") }
                catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
                var state = await engine.state()
                XCTAssertEqual(state["enabled"] as? Bool, false)
                XCTAssertEqual(state["unknown"] as? Int64, 1)
                XCTAssertEqual(state["retainedSubmissions"] as? Int, 1)
                XCTAssertEqual(saved.waitingForAvailability, !alreadyReopened)
                XCTAssertEqual(saved.acknowledged, previouslyAcked); XCTAssertEqual(saved.counted, previouslyAcked)
                // Persisting the known rejection is mandatory, even though it
                // establishes that this particular attempt was not accepted.
                for _ in 0..<2 {
                    do { try await engine.start(address: reward); XCTFail("Recovery bypassed broken storage") }
                    catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
                    state = await engine.state()
                    XCTAssertEqual(state["enabled"] as? Bool, false)
                    XCTAssertEqual(state["unknown"] as? Int64, 1)
                }
                try FileManager.default.removeItem(at: url)
                try ClaimsPublicStore.write(["txid": ownerTxid, "status": "unknown"], to: url)
                let restarted = MobileClaimsEngine(rpc: rpc, receiptURL: url)
                await restarted.setActive(true)
                do { try await restarted.start(address: reward); XCTFail("A new owner invented rejection evidence") }
                catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_UNKNOWN_OUTCOME") }
                await restarted.close()
                let other = String(repeating: "bc", count: 32)
                try ClaimsPublicStore.write(["txid": other, "status": "pending"], to: url)
                do { try await engine.start(address: reward); XCTFail("Recovery overwrote another pending receipt") }
                catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
                XCTAssertEqual(try ClaimsPublicStore.read(url)["txid"] as? String, other)
                // Also cover the observable file after a failed post-rename
                // commit. This simulates that state, not an injected fsync fault.
                try ClaimsPublicStore.write(["txid": ownerTxid, "status": alreadyReopened ? "rejected" : "pending"], to: url)
                try await engine.start(address: reward)
                state = await engine.state()
                XCTAssertEqual(state["enabled"] as? Bool, true)
                XCTAssertEqual(state["unknown"] as? Int64, 0)
                XCTAssertEqual(state["retainedSubmissions"] as? Int, 1)
                XCTAssertEqual(state["attempts"] as? Int64, 0); XCTAssertEqual(state["submitted"] as? Int64, 0)
                XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "rejected", "Rejection must never become not-sent")
                XCTAssertEqual(saved.retry.hex, hex); XCTAssertEqual(saved.retry.txid, ownerTxid)
                XCTAssertEqual(saved.retry.due, due); XCTAssertEqual(saved.retry.failures, 0)
                XCTAssertEqual(saved.acknowledged, previouslyAcked); XCTAssertEqual(saved.counted, previouslyAcked)
                XCTAssertEqual(saved.availableForRetry(catalog: saved.row, retained: nil, normallyAged: false, coherent: true), alreadyReopened,
                    "An unchanged available row is not a reopening after rejection")
                // The exact same production availability gate may open only
                // when replay publishes reopening; earlier ACK/count survive.
                saved.reopened()
                XCTAssertTrue(saved.availableForRetry(catalog: saved.row, retained: nil, normallyAged: false, coherent: true))
                XCTAssertEqual(saved.acknowledge(now: 2), !previouslyAcked)
                XCTAssertFalse(saved.acknowledge(now: 3))
                await engine.close()
            }
        }
    }

    func testRejectedReceiptRecoveryRequiresDefinitiveNodeEvidenceAndExactOwner() async throws {
        let url = try location(), rpc = MobileRpcClient(factory: { ClaimsOfflineWire() })
        defer { rpc.close() }
        let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        let (saved, reward) = try retainedFixture()
        await engine.setActive(true); try await engine.start(address: reward)
        try await engine.retainCompletedSubmission(saved)
        try await engine.persistPendingSubmission(saved.retry.txid)
        var rejected = RpcFailure("-32020"); rejected.explicitRejection = true; rejected.nodeCode = -26
        var unknown = rejected; unknown.unknownOutcome = true
        var alreadyKnown = rejected; alreadyKnown.nodeCode = -27
        var missingCode = rejected; missingCode.nodeCode = nil
        var unknownCode = rejected; unknownCode.nodeCode = -99
        var noWrite = rejected; noWrite.notSent = true
        var noForward = rejected; noForward.notForwarded = true
        var noEvidence = rejected; noEvidence.explicitRejection = false
        var wrongGateway = RpcFailure("-32002"); wrongGateway.explicitRejection = true; wrongGateway.nodeCode = -26
        for failure in [unknown, alreadyKnown, missingCode, unknownCode, noWrite, noForward, noEvidence, wrongGateway] {
            do { try await engine.persistRejectedSubmission(saved, failure: failure); XCTFail("Ambiguous response acquired a rejection token") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
        }
        let duplicate = ClaimSavedSubmission(row: saved.row, retry: saved.retry)
        do { try await engine.persistRejectedSubmission(duplicate, failure: rejected); XCTFail("A different proof object acquired the token") }
        catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
        XCTAssertFalse(saved.waitingForAvailability); XCTAssertFalse(saved.acknowledged); XCTAssertFalse(saved.counted)
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "pending")
        let state = await engine.state()
        XCTAssertEqual(state["unknown"] as? Int64, 0); XCTAssertEqual(state["retainedSubmissions"] as? Int, 1)
        // A valid response succeeds through the same helper without arming a
        // recovery exception when no persistence failure occurred.
        try await engine.persistRejectedSubmission(saved, failure: rejected)
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "rejected")
        XCTAssertTrue(saved.waitingForAvailability)
        await engine.close()
    }

    func testUnsentReceiptRecoveryRejectsAmbiguousFlagsAndDifferentLiveOwner() async throws {
        let url = try location(), rpc = MobileRpcClient(factory: { ClaimsOfflineWire() })
        defer { rpc.close() }
        let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        let (saved, reward) = try retainedFixture()
        await engine.setActive(true); try await engine.start(address: reward)
        try await engine.retainCompletedSubmission(saved)
        try await engine.persistPendingSubmission(saved.retry.txid)
        var unknown = RpcFailure("RPC_TIMEOUT"); unknown.notSent = true; unknown.unknownOutcome = true
        var alreadyKnown = RpcFailure("-32020"); alreadyKnown.notForwarded = true; alreadyKnown.nodeCode = -27
        var rejected = RpcFailure("-32020"); rejected.notSent = true; rejected.explicitRejection = true
        for failure in [unknown, alreadyKnown, rejected, RpcFailure("RPC_UNAVAILABLE")] {
            do { _ = try await engine.persistUnsentSubmission(saved, failure: failure); XCTFail("Ambiguous evidence acquired a no-write token") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
        }
        let duplicate = ClaimSavedSubmission(row: saved.row, retry: saved.retry)
        var refused = RpcFailure("RPC_UNAVAILABLE"); refused.notSent = true
        do { _ = try await engine.persistUnsentSubmission(duplicate, failure: refused); XCTFail("A different object acquired the original owner token") }
        catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
        XCTAssertEqual(saved.retry.failures, 0); XCTAssertEqual(saved.retry.due, 0)
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "pending")
        await engine.close()
        // A true uncertain receipt, even with this same txid/bytes available to
        // the caller, has no transport evidence or live owner in a new engine.
        try ClaimsPublicStore.write(["txid": saved.retry.txid, "status": "unknown"], to: url)
        let restored = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        await restored.setActive(true)
        do { try await restored.start(address: reward); XCTFail("A genuine unknown outcome was bypassed") }
        catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_UNKNOWN_OUTCOME") }
        await restored.close()
    }

    func testDurablePolicyRestoresLimitsAndCannotEnableBackground() async throws {
        let url = try location(), rpc = MobileRpcClient(factory: { ClaimsOfflineWire() }); defer { rpc.close() }
        let first = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        await first.setActive(true)
        _ = try await first.policy(["allowMobileData": true, "allowBackground": false])
        _ = try await first.limits(["connectionsPerSecondLimit": 17, "concurrency": 4])
        do { _ = try await first.policy(["allowMobileData": true, "allowBackground": true]); XCTFail("Background enabled") } catch {}
        await first.close()
        let restored = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        let state = await restored.state()
        XCTAssertEqual(state["connectionsPerSecondLimit"] as? Int, 17)
        XCTAssertEqual(state["concurrency"] as? Int, 4)
        XCTAssertEqual(state["allowMobileData"] as? Bool, true)
        XCTAssertEqual(state["allowBackground"] as? Bool, false)
        XCTAssertEqual(state["requested"] as? Bool, false)
        do { try await restored.start(address: address); XCTFail("Background start succeeded") } catch {}
        await restored.close()
    }

    func testClosedPolicyOwnerCannotChangeReplacementLimitsOrPermissions() async throws {
        let url = try location(), rpc = MobileRpcClient(factory: { ClaimsOfflineWire() })
        defer { rpc.close() }
        let old = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        await old.setActive(true)
        _ = try await old.policy(["allowMobileData": false, "allowBackground": false])
        _ = try await old.limits(["connectionsPerSecondLimit": 19, "concurrency": 7])
        let policyURL = url.deletingLastPathComponent().appendingPathComponent("claims-policy-v1.json")
        let original = try Data(contentsOf: policyURL)
        // This is the real replacement path used by saveSettings. The runtime
        // can suspend after closing old and before publishing the next actor.
        let handoff = try await old.closeForReplacement()
        do { _ = try await old.policy(["allowMobileData": true, "allowBackground": false]); XCTFail("Closed policy owner persisted a permission change") }
        catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_CLOSED") }
        XCTAssertEqual(try Data(contentsOf: policyURL), original)
        do { _ = try await old.limits(["connectionsPerSecondLimit": 100, "concurrency": 100]); XCTFail("Closed policy owner persisted limits before its native failure") }
        catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_CLOSED") }
        XCTAssertEqual(try Data(contentsOf: policyURL), original)
        let next = handoff.makeEngine(rpc: rpc), state = await next.state()
        XCTAssertEqual(state["connectionsPerSecondLimit"] as? Int, 19)
        XCTAssertEqual(state["concurrency"] as? Int, 7)
        XCTAssertEqual(state["allowMobileData"] as? Bool, false)
        XCTAssertEqual(state["enabled"] as? Bool, false)
        XCTAssertEqual(state["submitted"] as? Int64, 0)
        XCTAssertEqual(state["attempts"] as? Int64, 0)
        await next.close()
    }

    func testReceiptStoreRejectsSymlinkAndLeavesNoTemporaryFiles() throws {
        let url = try location()
        try ClaimsPublicStore.write(["txid": txid, "status": "pending"], to: url)
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "pending")
        try ClaimsPublicStore.write(["txid": txid, "status": "submitted"], to: url)
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "submitted")
        let directory = url.deletingLastPathComponent()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["receipt.json"])
        let link = directory.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: url)
        XCTAssertThrowsError(try ClaimsPublicStore.read(link))
        XCTAssertThrowsError(try ClaimsPublicStore.write(["oversized": String(repeating: "x", count: 4096)], to: url))
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "submitted")
    }

    func testUnknownResolutionRequiresMatchingMainnetTransactionAndNeverBroadcasts() async throws {
        let vector = try PaymentVectors.fixture(), claim = try PJ.object(vector["attached"])
        let expected = try PJ.string(claim["txid"]), validHex = try PJ.string(claim["hex"])
        let differentHex = try PJ.string(PJ.object(vector["payment"])["hex"])
        // A different bound proof changes the witness, not the claim's txid.
        // These are framing fixtures; consensus TLS verification belongs to the node.
        let proof = [UInt8](try NativeTransactions.bytes(PJ.string(vector["proof"])))
        var alternativeProof = proof; alternativeProof[alternativeProof.count - 1] = 1; alternativeProof.append(42)
        var wrongChallenge = proof; wrongChallenge[7] ^= 1
        func withWitness(_ witness: [UInt8]) throws -> String {
            var tx = try NativeTransactions.parse(validHex), inputs = try PJ.objects(tx["inputs"])
            inputs[0]["witness"] = [WalletCrypto.hex(Data(witness))]; tx["inputs"] = inputs
            XCTAssertEqual(try NativeTransactions.txid(tx), expected)
            return try WalletCrypto.hex(NativeTransactions.serialize(tx))
        }
        let alternativeHex = try withWitness(alternativeProof), malformedHex = try withWitness(wrongChallenge)
        XCTAssertNotEqual(alternativeHex, validHex)
        let tip: JSONObject = ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS,
            "height": 120, "hash": String(repeating: "aa", count: 32), "mediantime": 1_700_000_000]
        var wrongTip = tip; wrongTip["genesis_hash"] = String(repeating: "00", count: 32)
        let confirmed: JSONObject = ["tip": tip, "status": "confirmed", "block_hash": tip["hash"]!,
            "block_height": 120, "transaction": ["hex": validHex, "txid": expected, "confirmations": 1, "blockhash": tip["hash"]!]]
        let pending: JSONObject = ["tip": tip, "status": "pending", "transaction": ["hex": validHex, "txid": expected, "confirmations": 0]]
        var cases: [(JSONObject, Bool)] = [
            (["tip": wrongTip, "status": "confirmed", "transaction": ["hex": validHex]], false),
            (["tip": tip, "status": "confirmed", "transaction": ["hex": differentHex]], false),
            (["tip": tip, "status": "missing", "transaction": ["hex": validHex]], false),
            (["tip": tip, "status": "pending", "transaction": ["hex": validHex]], true),
            (["tip": tip, "status": "pending", "transaction": ["hex": alternativeHex]], true),
            (["tip": tip, "status": "pending", "transaction": ["hex": malformedHex]], false),
            (confirmed, true), (pending, true)
        ]
        // These responses have the right raw txid but a contradictory or
        // incomplete envelope. Restarting (no retained owner) must not make
        // them sufficient to clear the persisted uncertain-outcome guard.
        for key in ["block_height", "block_hash"] {
            var response = confirmed; response.removeValue(forKey: key); cases.append((response, false))
        }
        let invalidHeights: [Any] = [-1, 121, "120", true, NSNull()]
        for height in invalidHeights {
            var response = confirmed; response["block_height"] = height; cases.append((response, false))
        }
        var response = confirmed; response["block_hash"] = String(repeating: "bb", count: 32); cases.append((response, false))
        response = pending; response["block_height"] = 120; cases.append((response, false))
        response = pending; response["block_hash"] = tip["hash"]!; cases.append((response, false))
        let invalidIds: [Any] = [String(repeating: "bb", count: 32), NSNull()]
        let invalidCounts: [Any] = [true, "1", -1, 0.5, NSNull()]
        for base in [confirmed, pending] {
            for wrongId in invalidIds {
                response = base; var transaction = try PJ.object(response["transaction"])
                transaction["txid"] = wrongId; response["transaction"] = transaction; cases.append((response, false))
            }
            for count in invalidCounts {
                response = base; var transaction = try PJ.object(response["transaction"])
                transaction["confirmations"] = count; response["transaction"] = transaction; cases.append((response, false))
            }
            response = base; var transaction = try PJ.object(response["transaction"])
            transaction["blockhash"] = String(repeating: "bb", count: 32); response["transaction"] = transaction; cases.append((response, false))
        }
        response = pending; response["transaction"] = ["hex": validHex, "confirmations": 1]; cases.append((response, false))
        response = confirmed; response["transaction"] = ["hex": validHex, "confirmations": 0]; cases.append((response, false))
        for (response, resolves) in cases {
            let url = try location(); try ClaimsPublicStore.write(["txid": expected, "status": "pending"], to: url)
            let wire = ClaimsReceiptWire(response)
            let client = MobileRpcClient(factory: { wire }); defer { client.close() }; client.setActive(true)
            let engine = MobileClaimsEngine(rpc: client, receiptURL: url); await engine.setActive(true)
            do { _ = try await engine.checkSubmission(); XCTAssertTrue(resolves) }
            catch { XCTAssertFalse(resolves) }
            let state = await engine.state()
            XCTAssertEqual(state["receiptStatus"] as? String, resolves ? "submitted" : "pending")
            XCTAssertEqual(state["running"] as? Bool, false)
            XCTAssertEqual(state["submitted"] as? Int64, 0, "A receipt lookup is not a new broadcast")
            XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, resolves ? "submitted" : "pending")
            XCTAssertEqual(wire.requests, ["gettransaction"])
            await engine.close()
        }
    }
}
