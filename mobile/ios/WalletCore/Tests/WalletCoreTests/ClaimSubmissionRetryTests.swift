import XCTest
@testable import WalletCore

private final class ClaimRetryWire: RpcWire, @unchecked Sendable {
    private let lock = NSLock()
    private let prewriteFailure: Bool, postwriteFailure: Bool, txid: String, initialRefusal: Int?
    private var receive: ((Data) -> Void)?, failed: (() -> Void)?
    private var requests: [JSONObject] = []
    init(txid: String, prewriteFailure: Bool = false, postwriteFailure: Bool = false, initialRefusal: Int? = nil) {
        self.txid = txid; self.prewriteFailure = prewriteFailure; self.postwriteFailure = postwriteFailure
        self.initialRefusal = initialRefusal
    }
    var sent: [JSONObject] { lock.lock(); defer { lock.unlock() }; return requests }
    func start(queue: DispatchQueue, ready: @escaping () -> Void, receive: @escaping (Data) -> Void, failed: @escaping () -> Void) {
        lock.lock(); self.receive = receive; self.failed = failed; lock.unlock()
        if prewriteFailure { failed() } else { ready() }
    }
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void) {
        do {
            let request = try JSON.decode(Data(bytes.dropLast()))
            lock.lock(); requests.append(request); let receive = self.receive, failed = self.failed, attempt = requests.count; lock.unlock()
            if postwriteFailure { completed(false); failed?(); return }
            completed(true)
            if attempt == 1, let code = initialRefusal {
                receive?(try JSON.encode(["jsonrpc": "2.0", "id": request["id"]!, "error": ["code": code, "message": "gateway refusal"]]) + Data([10]))
                return
            }
            receive?(try JSON.encode(["jsonrpc": "2.0", "id": request["id"]!, "result": ["txid": txid]]) + Data([10]))
        } catch { completed(false) }
    }
    func cancel() {}
}

final class ClaimSubmissionRetryTests: XCTestCase {
    private let txid = String(repeating: "ab", count: 32)
    private let hex = String(repeating: "020001ab", count: 10)
    private func retryable(_ code: String = "RPC_UNAVAILABLE") -> RpcFailure {
        var error = RpcFailure(code); error.notSent = true; return error
    }
    private func row(block: String = "12", state: String = "available", roots: Int = 1, tx: String = "01") throws -> ClaimCandidate {
        let blockHash = String(repeating: block, count: 32)
        let bounty: JSONObject = ["txid": String(repeating: "00", count: 31) + tx, "vout": 0, "amount": "1000000",
            "connection_work_target": String(repeating: "ff", count: 32), "block_hash": blockHash,
            "block_height": 1, "confirmations": 1, "coinbase": false, "signature_algorithms_mask": 7,
            "root_certificates_version": roots, "domain": "example.com", "status": state]
        return try ClaimCandidate(bounty, block: blockHash, fee: 0, factor: 1_000_000)
    }
    func testWinnerRetentionUsesCurrentIdentityNotCatalogAge() throws {
        let captured = try row()
        XCTAssertTrue(ClaimSubmissionRetry.matchesAvailableBounty(try row(), captured: captured))
        XCTAssertFalse(ClaimSubmissionRetry.matchesAvailableBounty(nil, captured: captured))
        for current in [try row(block: "13"), try row(tx: "02"), try row(roots: 2),
                        try row(state: "spent"), try row(state: "pending_spend"), try row(state: "immature")] {
            XCTAssertFalse(ClaimSubmissionRetry.matchesAvailableBounty(current, captured: captured))
        }
        // Retaining public bytes is not authorization to send: the same
        // expired-catalog permit still refuses the financial write.
        let permit = RpcBroadcastPermit(validUntil: 60, now: { 60 })
        XCTAssertFalse(permit.isValid)
        XCTAssertTrue(ClaimSubmissionRetry.matchesAvailableBounty(captured, captured: captured))
    }
    func testRetentionBoundsAllowDrainWithoutGrowingTheCatalogLimit() {
        XCTAssertEqual(ClaimSubmissionRetry.maximumCatalogEntries, 10_000)
        XCTAssertEqual(ClaimSubmissionRetry.maximumRetainedWinners, 200)
        var retained = 0
        while ClaimSubmissionRetry.canAppendWinner(currentCount: retained) { retained += 1 }
        XCTAssertEqual(retained, 200)
        XCTAssertFalse(ClaimSubmissionRetry.canAppendWinner(currentCount: retained))
        XCTAssertFalse(ClaimSubmissionRetry.canAppendWinner(currentCount: retained + 1))
        XCTAssertFalse(ClaimSubmissionRetry.canAppendWinner(currentCount: -1))
        // Replay temporarily retains old window entries until queued winners
        // are invalidated, in addition to the unchanged full catalog bound.
        XCTAssertTrue(ClaimSubmissionRetry.validProgressCount(10_000 + retained))
        XCTAssertFalse(ClaimSubmissionRetry.validProgressCount(10_000 + retained + 1))
        XCTAssertFalse(ClaimSubmissionRetry.validProgressCount(-1))
    }
    func testResyncCannotResurrectOriginalWinnerWhileItsSpentCallbackDrains() throws {
        let original = try row()
        original.progress.prepared = ["challenge": "preserved-before-spend"]
        original.progress.captures = 2
        for state in ["spent", "pending_spend", "immature"] {
            let published = try row(state: state)
            // Even an older retained `available` copy must lose to the latest
            // catalog state before resync clears that catalog.
            XCTAssertNil(ClaimSubmissionRetry.retainAvailableBounty(catalog: published, retained: original, captured: original))
            XCTAssertNil(ClaimSubmissionRetry.retainAvailableBounty(catalog: nil, retained: published, captured: original))
        }
        XCTAssertNil(ClaimSubmissionRetry.retainAvailableBounty(catalog: nil, retained: nil, captured: original))
        XCTAssertNil(ClaimSubmissionRetry.retainAvailableBounty(catalog: try row(block: "13"), retained: original, captured: original))
        // Normal aging is not fresh catalog evidence. The separate submission
        // gate may admit this preserved proof to Core after a coherent snapshot.
        let aged = ClaimSubmissionRetry.retainAvailableBounty(catalog: nil, retained: original, captured: original)
        XCTAssertTrue(aged?.progress === original.progress)
        XCTAssertFalse(ClaimSubmissionRetry.matchesAvailableBounty(nil, captured: original))
        XCTAssertEqual(original.progress.captures, 2)
        XCTAssertEqual(original.progress.prepared?["challenge"] as? String, "preserved-before-spend")
    }
    func testNormallyAgedSubmissionStillRejectsEveryKnownInvalidationAndResync() throws {
        let original = try row()
        XCTAssertTrue(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: original, captured: original, normallyAged: true, coherent: true))
        XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: original, captured: original, normallyAged: true, coherent: false))
        XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: original, captured: original, normallyAged: false, coherent: true))
        XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: nil, captured: original, normallyAged: true, coherent: true))
        for invalid in [try row(state: "spent"), try row(state: "pending_spend"), try row(state: "immature"),
                        try row(block: "13"), try row(roots: 2), try row(tx: "02")] {
            XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: invalid, retained: original, captured: original, normallyAged: true, coherent: true))
            XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: invalid, captured: original, normallyAged: true, coherent: true))
        }
    }

    func testNormallyAgedProofUsesTheSameTransactionAfterAnUnsentRetryWithoutCatalogReentry() async throws {
        let captured = try row(), unavailable = ClaimRetryWire(txid: txid, prewriteFailure: true), accepted = ClaimRetryWire(txid: txid)
        var factories = 0
        let rpc = MobileRpcClient(factory: { factories += 1; return factories == 1 ? unavailable : accepted })
        defer { rpc.close() }; rpc.setActive(true)
        var pending = ClaimSubmissionRetry(hex: hex, txid: txid)
        for attempt in 0..<2 {
            XCTAssertTrue(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: captured, captured: captured, normallyAged: true, coherent: true))
            do {
                let response = try await rpc.broadcast(pending.hex, permit: RpcBroadcastPermit())
                XCTAssertEqual(attempt, 1); XCTAssertEqual(response["txid"] as? String, txid)
            } catch let failure as RpcFailure {
                XCTAssertEqual(attempt, 0); XCTAssertTrue(failure.notSent); XCTAssertFalse(failure.unknownOutcome)
                XCTAssertTrue(pending.retain(after: failure, now: 0))
            }
        }
        XCTAssertTrue(unavailable.sent.isEmpty); XCTAssertEqual(accepted.sent.count, 1)
        XCTAssertEqual(accepted.sent[0]["method"] as? String, "sendrawtransaction")
        XCTAssertEqual((accepted.sent[0]["params"] as? JSONObject)?["transaction_hex"] as? String, hex)
        XCTAssertEqual(pending.hex, hex); XCTAssertEqual(pending.txid, txid)
    }
    func testOnlyProvenUnsentTransientErrorsRetainIdenticalPayload() {
        var pending = ClaimSubmissionRetry(hex: hex, txid: txid)
        for (index, code) in ["RPC_UNAVAILABLE", "RPC_TIMEOUT", "RPC_BUSY"].enumerated() {
            XCTAssertTrue(pending.retain(after: retryable(code), now: 100))
            XCTAssertEqual(pending.due, 100 + pow(2, Double(index)))
            XCTAssertEqual(pending.hex, hex); XCTAssertEqual(pending.txid, txid)
        }
        let due = pending.due, failures = pending.failures
        var unknown = retryable(); unknown.unknownOutcome = true
        var rejected = retryable(); rejected.explicitRejection = true; rejected.nodeCode = -26
        var alreadyKnown = retryable(); alreadyKnown.nodeCode = -27
        for error in [RpcFailure("RPC_UNAVAILABLE"), unknown, rejected, alreadyKnown,
                      retryable("RPC_CANCELLED"), retryable("RPC_PROTOCOL"), retryable("RPC_INACTIVE"),
                      retryable("-32029"), retryable("-32020")] {
            XCTAssertFalse(pending.retain(after: error, now: 100), error.code)
            XCTAssertEqual(pending.due, due); XCTAssertEqual(pending.failures, failures)
            XCTAssertEqual(pending.hex, hex); XCTAssertEqual(pending.txid, txid)
        }
    }
    func testBoundedBackoffNeverShortensTransportCooldownAndFreshnessWait() {
        var pending = ClaimSubmissionRetry(hex: hex, txid: txid)
        for _ in 0..<1000 { XCTAssertTrue(pending.retain(after: retryable(), now: 0)) }
        XCTAssertEqual(pending.failures, 31); XCTAssertEqual(pending.due, 30)
        var cooldown = retryable(); cooldown.retryAfterMs = 60_000
        XCTAssertTrue(pending.retain(after: cooldown, now: 2)); XCTAssertEqual(pending.due, 62)
        cooldown.retryAfterMs = 120_000
        XCTAssertTrue(pending.retain(after: cooldown, now: 2)); XCTAssertEqual(pending.due, 122)
        pending.waitForFreshCatalog(now: 100); XCTAssertEqual(pending.due, 101)
        XCTAssertEqual(pending.hex, hex); XCTAssertEqual(pending.txid, txid)
    }
    func testGatewayRefusalRetainsExactPayloadAndHonorsCooldownWithoutSkippingChecks() {
        for code in ["-32001", "-32029", "-32030"] {
            var pending = ClaimSubmissionRetry(hex: hex, txid: txid)
            var failure = RpcFailure(code); failure.notForwarded = true; failure.retryAfterMs = 120_000
            XCTAssertTrue(pending.retain(after: failure, now: 2)); XCTAssertEqual(pending.due, 122)
            XCTAssertEqual(pending.hex, hex); XCTAssertEqual(pending.txid, txid); XCTAssertEqual(pending.failures, 1)
            var unknown = failure; unknown.unknownOutcome = true
            var rejected = failure; rejected.explicitRejection = true
            var node = failure; node.nodeCode = -27
            for unsafe in [RpcFailure(code), unknown, rejected, node] {
                XCTAssertFalse(pending.retain(after: unsafe, now: 3))
                XCTAssertEqual(pending.due, 122); XCTAssertEqual(pending.failures, 1)
            }
        }
        for code in ["-32002", "-32020", "RPC_TIMEOUT", "RPC_PROTOCOL"] {
            var failure = RpcFailure(code); failure.notForwarded = true
            var pending = ClaimSubmissionRetry(hex: hex, txid: txid)
            XCTAssertFalse(pending.retain(after: failure, now: 0))
        }
    }
    func testPrewriteDisconnectRetriesSameBytesWithoutAnotherProof() async throws {
        let unavailable = ClaimRetryWire(txid: txid, prewriteFailure: true), accepted = ClaimRetryWire(txid: txid)
        var factories = 0
        let rpc = MobileRpcClient(factory: { factories += 1; return factories == 1 ? unavailable : accepted })
        defer { rpc.close() }; rpc.setActive(true)
        var pending = ClaimSubmissionRetry(hex: hex, txid: txid)
        do { _ = try await rpc.broadcast(pending.hex, permit: RpcBroadcastPermit()); XCTFail("Offline send succeeded") }
        catch let failure as RpcFailure {
            XCTAssertTrue(failure.notSent); XCTAssertFalse(failure.unknownOutcome)
            XCTAssertTrue(pending.retain(after: failure, now: 0))
        }
        XCTAssertTrue(unavailable.sent.isEmpty)
        let response = try await rpc.broadcast(pending.hex, permit: RpcBroadcastPermit())
        XCTAssertEqual(response["txid"] as? String, txid)
        XCTAssertEqual(accepted.sent.count, 1)
        XCTAssertEqual((accepted.sent[0]["params"] as? JSONObject)?["transaction_hex"] as? String, hex)
        XCTAssertEqual(pending.txid, txid); XCTAssertEqual(pending.hex, hex)
    }
    func testWrittenDisconnectCannotEnterRetryState() async throws {
        let wire = ClaimRetryWire(txid: txid, postwriteFailure: true)
        let rpc = MobileRpcClient(factory: { wire }); defer { rpc.close() }; rpc.setActive(true)
        var pending = ClaimSubmissionRetry(hex: hex, txid: txid)
        do { _ = try await rpc.broadcast(pending.hex); XCTFail("Disconnected send succeeded") }
        catch let failure as RpcFailure {
            XCTAssertTrue(failure.unknownOutcome); XCTAssertFalse(failure.notSent)
            XCTAssertFalse(pending.retain(after: failure, now: 0))
        }
        XCTAssertEqual(wire.sent.count, 1); XCTAssertEqual(pending.failures, 0)
    }
    func testParsedGatewayRefusalRetriesOnlyTheIdenticalTransaction() async throws {
        for code in [-32001, -32029, -32030] {
            let wire = ClaimRetryWire(txid: txid, initialRefusal: code)
            let rpc = MobileRpcClient(factory: { wire }, window: 0.001); defer { rpc.close() }; rpc.setActive(true)
            var pending = ClaimSubmissionRetry(hex: hex, txid: txid)
            do { _ = try await rpc.broadcast(pending.hex, permit: RpcBroadcastPermit()); XCTFail("Refused send succeeded") }
            catch let failure as RpcFailure {
                XCTAssertTrue(failure.notForwarded); XCTAssertFalse(failure.notSent); XCTAssertFalse(failure.unknownOutcome)
                XCTAssertTrue(pending.retain(after: failure, now: 0)); XCTAssertEqual(pending.failures, 1)
            }
            let response = try await rpc.broadcast(pending.hex, permit: RpcBroadcastPermit())
            XCTAssertEqual(response["txid"] as? String, txid); XCTAssertEqual(wire.sent.count, 2)
            XCTAssertEqual(pending.txid, txid); XCTAssertEqual(pending.hex, hex)
            for request in wire.sent { XCTAssertEqual((request["params"] as? JSONObject)?["transaction_hex"] as? String, hex) }
        }
    }
}
