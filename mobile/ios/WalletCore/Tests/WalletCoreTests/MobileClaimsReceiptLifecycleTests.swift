import XCTest
@testable import WalletCore

/// Controlled public RPC frames: no DNS, network request, proof capture or
/// broadcast is needed to exercise the actor's actual receipt-commit fence.
private final class ClaimReceiptWire: RpcWire, @unchecked Sendable {
    private let mutex = NSLock()
    private var receive: ((Data) -> Void)?
    private var requests: [JSONObject] = []
    var reads: [JSONObject] {
        mutex.lock(); defer { mutex.unlock() }
        return requests.filter { $0["method"] as? String == "gettransaction" }
    }
    func start(queue: DispatchQueue, ready: @escaping () -> Void, receive: @escaping (Data) -> Void, failed: @escaping () -> Void) {
        mutex.lock(); self.receive = receive; mutex.unlock(); ready()
    }
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void) {
        do {
            let request = try JSON.decode(Data(bytes.dropLast()))
            mutex.lock(); requests.append(request); mutex.unlock(); completed(true)
            // These lifecycle tests exercise legacy full-transaction receipt
            // validation. Negotiate that path explicitly, never by returning
            // a legacy payload to the compact status method.
            if request["method"] as? String == "gettransactionstatus" {
                let bytes = try JSON.encode(["jsonrpc": "2.0", "id": request["id"]!,
                    "error": ["code": -32601, "message": "Method not found"]]) + Data([10])
                mutex.lock(); let callback = receive; mutex.unlock(); callback?(bytes)
            }
        } catch { completed(false) }
    }
    func reply(_ request: JSONObject, _ response: JSONObject) throws {
        let bytes = try JSON.encode(["jsonrpc": "2.0", "id": request["id"]!, "result": response]) + Data([10])
        mutex.lock(); let callback = receive; mutex.unlock(); callback?(bytes)
    }
    func cancel() {}
}

final class MobileClaimsReceiptLifecycleTests: XCTestCase {
    private let reward = "cc1p4t449ht5jnpkzpyaue7vdq8g867th0d7kymr0kfvmpzlwqcg4a0qc59p3e"
    private func waitForRead(_ wire: ClaimReceiptWire, _ count: Int) async throws -> JSONObject {
        for _ in 0..<200 {
            let reads = wire.reads
            if reads.count >= count { return reads[count - 1] }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Receipt fixture did not receive the expected local request")
        throw WalletError("Receipt fixture timed out")
    }
    private func pending(_ claim: JSONObject) throws -> JSONObject {
        ["tip": ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS,
            "height": 0, "hash": NativePaymentChecks.GENESIS, "mediantime": 1_700_000_000],
            "status": "pending", "transaction": ["hex": try PJ.string(claim["hex"])]]
    }

    func testValidatedManualReceiptFailureKeepsLiveAckButInvalidOrObsoleteReadsDoNot() async throws {
        for outcome in ["valid", "malformed", "stopped"] {
            let fixture = try PaymentVectors.fixture(), claim = try PJ.object(fixture["attached"])
            var bounty = try PJ.object(fixture["bounty"])
            let block = String(repeating: "12", count: 32)
            bounty["block_hash"] = block; bounty["block_height"] = 1
            bounty["confirmations"] = 1; bounty["coinbase"] = false; bounty["status"] = "available"
            let row = try ClaimCandidate(bounty, block: block, fee: 1500, factor: 1_000_000)
            row.progress.prepared = try PJ.object(fixture["claim"])
            let saved = ClaimSavedSubmission(row: row, retry: ClaimSubmissionRetry(
                hex: try PJ.string(claim["hex"]), txid: try PJ.hash(claim["txid"])))
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-manual-storage-test-" + UUID().uuidString)
            let url = directory.appendingPathComponent("receipt.json")
            let wire = ClaimReceiptWire(), rpc = MobileRpcClient(factory: { wire })
            let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            let address = try PJ.string(fixture["rewardAddress"])
            await engine.setActive(true); try await engine.start(address: address)
            // Establish the live attached owner through production helpers.
            // This fixture does not perform native TLS or a broadcast.
            try await engine.retainCompletedSubmission(saved)
            try await engine.persistPendingSubmission(saved.retry.txid)
            try FileManager.default.removeItem(at: url)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
            var rejection = RpcFailure("-32020"); rejection.explicitRejection = true; rejection.nodeCode = -26
            do { try await engine.persistRejectedSubmission(saved, failure: rejection); XCTFail("Broken receipt storage succeeded") } catch {}
            rpc.setActive(true)
            let checking = Task { try await engine.checkSubmission() }
            do {
                let request = try await waitForRead(wire, 1)
                var response = try pending(claim)
                if outcome == "malformed" { response["transaction"] = ["hex": "00"] }
                if outcome == "stopped" { await engine.stop() }
                try wire.reply(request, response)
                do { _ = try await checking.value; XCTFail("Uncommitted or invalid lookup succeeded") }
                catch {
                    if outcome == "valid" { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
                    if outcome == "stopped" { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
                }
                var state = await engine.state()
                XCTAssertEqual(state["unknown"] as? Int64, 1); XCTAssertEqual(state["submitted"] as? Int64, 0)
                XCTAssertFalse(saved.acknowledged); XCTAssertFalse(saved.counted)
                XCTAssertEqual(saved.retry.hex, try PJ.string(claim["hex"]))
                try FileManager.default.removeItem(at: url)
                try ClaimsPublicStore.write(["txid": saved.retry.txid, "status": "pending"], to: url)
                rpc.setActive(false)
                try await engine.start(address: address)
                state = await engine.state()
                XCTAssertEqual(state["unknown"] as? Int64, 0); XCTAssertEqual(state["submitted"] as? Int64, 0)
                XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, outcome == "valid" ? "submitted" : "rejected",
                    "Only a fully validated, current positive read replaces the earlier live rejection")
                XCTAssertEqual(saved.acknowledged, outcome == "valid")
                XCTAssertEqual(saved.counted, outcome == "valid")
                XCTAssertEqual(saved.waitingForAvailability, outcome != "valid")
                XCTAssertEqual(wire.reads.count, 1, "Start commits existing evidence without issuing another receipt query")
            } catch {
                checking.cancel(); await engine.close(); rpc.close()
                try? FileManager.default.removeItem(at: directory); throw error
            }
            await engine.close(); rpc.close(); try FileManager.default.removeItem(at: directory)
        }
    }

    func testManualReceiptFailureWithoutLiveProofCannotManufactureRecoveryOwner() async throws {
        let claim = try PJ.object(PaymentVectors.fixture()["attached"]), txid = try PJ.hash(claim["txid"])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-manual-storage-test-" + UUID().uuidString)
        let url = directory.appendingPathComponent("receipt.json")
        try ClaimsPublicStore.write(["txid": txid, "status": "unknown"], to: url)
        let wire = ClaimReceiptWire(), rpc = MobileRpcClient(factory: { wire })
        let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        await engine.setActive(true); rpc.setActive(true)
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        let checking = Task { try await engine.checkSubmission() }
        do {
            let request = try await waitForRead(wire, 1)
            try wire.reply(request, pending(claim))
            do { _ = try await checking.value; XCTFail("Broken receipt storage succeeded") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
            try FileManager.default.removeItem(at: url)
            try ClaimsPublicStore.write(["txid": txid, "status": "unknown"], to: url)
            do { try await engine.start(address: reward); XCTFail("Restored txid acquired a live proof owner") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_UNKNOWN_OUTCOME") }
            let state = await engine.state()
            XCTAssertEqual(state["unknown"] as? Int64, 1); XCTAssertEqual(state["submitted"] as? Int64, 0)
            XCTAssertEqual(state["retainedSubmissions"] as? Int, 0)
            XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "unknown")
        } catch {
            checking.cancel(); await engine.close(); rpc.close()
            try? FileManager.default.removeItem(at: directory); throw error
        }
        await engine.close(); rpc.close(); try FileManager.default.removeItem(at: directory)
    }

    func testEndpointReplacementKeepsLiveUnknownAfterPartiallyCommittedReceipt() async throws {
        let claim = try PJ.object(PaymentVectors.fixture()["attached"]), txid = try PJ.hash(claim["txid"])
        // The successful replacement uses the new client; a failed endpoint
        // transaction reinstalls the old client through the same real factory.
        for replacementSucceeded in [false, true] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-replacement-test-" + UUID().uuidString)
            let url = directory.appendingPathComponent("receipt.json")
            try ClaimsPublicStore.write(["txid": txid, "status": "unknown"], to: url)
            let oldWire = ClaimReceiptWire(), newWire = ClaimReceiptWire()
            let oldRpc = MobileRpcClient(factory: { oldWire }), newRpc = MobileRpcClient(factory: { newWire })
            let old = MobileClaimsEngine(rpc: oldRpc, receiptURL: url)
            oldRpc.setActive(true); await old.setActive(true)
            let late = Task { try await old.checkSubmission() }
            var replacement: MobileClaimsEngine?
            do {
                let oldRequest = try await waitForRead(oldWire, 1)
                // Exact observable state of write() failing after rename: the
                // file changed, but record() did not clear the live guard.
                try ClaimsPublicStore.write(["txid": txid, "status": "submitted"], to: url)
                let handoff = try await old.closeForReplacement()
                let rpc = replacementSucceeded ? newRpc : oldRpc
                let wire = replacementSucceeded ? newWire : oldWire
                let next = handoff.makeEngine(rpc: rpc); replacement = next
                var state = await next.state()
                XCTAssertEqual(state["receiptStatus"] as? String, "unknown")
                XCTAssertEqual(state["receiptTxid"] as? String, txid)
                XCTAssertEqual(state["unknown"] as? Int64, 1)
                XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "submitted", "Handoff never rewrites the receipt")
                do { _ = try await next.checkSubmission(); XCTFail("Background recovery was allowed") } catch {}
                rpc.setActive(true); await next.setActive(true)
                do { try await next.start(address: reward); XCTFail("Endpoint replacement lost the unresolved guard") }
                catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_UNKNOWN_OUTCOME") }
                try oldWire.reply(oldRequest, pending(claim))
                do { _ = try await late.value; XCTFail("Old endpoint callback committed after handoff") }
                catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
                let checking = Task { try await next.checkSubmission() }
                do {
                    let request = try await waitForRead(wire, replacementSucceeded ? 1 : 2)
                    try wire.reply(request, pending(claim)); _ = try await checking.value
                } catch { checking.cancel(); throw error }
                state = await next.state()
                XCTAssertEqual(state["receiptStatus"] as? String, "submitted")
                XCTAssertEqual(state["submitted"] as? Int64, 0, "A recovery read never creates a broadcast")
                XCTAssertEqual(state["enabled"] as? Bool, false)
                XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "submitted")
            } catch {
                late.cancel(); await old.close(); await replacement?.close(); oldRpc.close(); newRpc.close()
                try? FileManager.default.removeItem(at: directory); throw error
            }
            await old.close(); await replacement?.close(); oldRpc.close(); newRpc.close()
            try FileManager.default.removeItem(at: directory)
        }
    }

    func testEndpointHandoffRejectsAnotherPendingReceiptBeforeClosingOldOwner() async throws {
        let claim = try PJ.object(PaymentVectors.fixture()["attached"]), txid = try PJ.hash(claim["txid"])
        for conflict in [String(repeating: "ab", count: 32), "malformed"] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-replacement-test-" + UUID().uuidString)
            let url = directory.appendingPathComponent("receipt.json")
            try ClaimsPublicStore.write(["txid": txid, "status": "unknown"], to: url)
            let wire = ClaimReceiptWire(), rpc = MobileRpcClient(factory: { wire })
            let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            rpc.setActive(true); await engine.setActive(true)
            let checking = Task { try await engine.checkSubmission() }
            let request = try await waitForRead(wire, 1)
            try ClaimsPublicStore.write(["txid": conflict, "status": "pending"], to: url)
            do { _ = try await engine.closeForReplacement(); XCTFail("A different pending receipt was overwritten") } catch {}
            try wire.reply(request, pending(claim))
            do { _ = try await checking.value; XCTFail("Old lookup overwrote the conflicting receipt") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
            let state = await engine.state()
            XCTAssertEqual(state["receiptTxid"] as? String, txid); XCTAssertEqual(state["receiptStatus"] as? String, "unknown")
            XCTAssertEqual(try ClaimsPublicStore.read(url)["txid"] as? String, conflict)
            do { try await engine.start(address: reward); XCTFail("Unknown guard was removed") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
            do { _ = try await engine.checkSubmission(); XCTFail("Manual recovery overwrote another pending receipt") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
            XCTAssertEqual(wire.reads.count, 1)
            XCTAssertEqual(try ClaimsPublicStore.read(url)["txid"] as? String, conflict)
            // Repairing the conflicting file can produce a replacement; the
            // original owner was not closed or discarded by the failed try.
            try ClaimsPublicStore.write(["txid": txid, "status": "unknown"], to: url)
            let handoff = try await engine.closeForReplacement(), next = handoff.makeEngine(rpc: rpc)
            let restored = await next.state(); XCTAssertEqual(restored["receiptStatus"] as? String, "unknown")
            await next.close()
            await engine.close(); rpc.close(); try FileManager.default.removeItem(at: directory)
        }
    }

    func testEndpointHandoffRechecksEngineAdmissionAtomically() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-replacement-test-" + UUID().uuidString)
        let url = directory.appendingPathComponent("receipt.json")
        let wire = ClaimReceiptWire(), rpc = MobileRpcClient(factory: { wire })
        let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        await engine.setActive(true); try await engine.start(address: reward)
        do { _ = try await engine.closeForReplacement(); XCTFail("An enabled engine was replaced") } catch {}
        let state = await engine.state(); XCTAssertEqual(state["enabled"] as? Bool, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        await engine.close(); rpc.close()
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    func testEndpointHandoffCannotMaskReplacementInitializationFailure() async throws {
        let claim = try PJ.object(PaymentVectors.fixture()["attached"]), txid = try PJ.hash(claim["txid"])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-replacement-test-" + UUID().uuidString)
        let url = directory.appendingPathComponent("receipt.json")
        try ClaimsPublicStore.write(["txid": txid, "status": "unknown"], to: url)
        let wire = ClaimReceiptWire(), rpc = MobileRpcClient(factory: { wire })
        let old = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        try ClaimsPublicStore.write(["txid": txid, "status": "submitted"], to: url)
        try ClaimsPublicStore.write(["allowMobileData": "not-a-boolean"], to: directory.appendingPathComponent("claims-policy-v1.json"))
        let handoff = try await old.closeForReplacement(), next = handoff.makeEngine(rpc: rpc)
        await next.setActive(true)
        let state = await next.state()
        XCTAssertEqual(state["status"] as? String, "error")
        XCTAssertEqual(state["lastError"] as? String, "CLAIMS_RECEIPT_UNAVAILABLE")
        XCTAssertEqual(state["receiptTxid"] as? String, txid)
        do { try await next.start(address: reward); XCTFail("Bad policy was hidden by inherited receipt") }
        catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
        do { _ = try await next.checkSubmission(); XCTFail("Receipt recovery bypassed initialization failure") }
        catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
        XCTAssertTrue(wire.reads.isEmpty)
        await next.close(); rpc.close(); try FileManager.default.removeItem(at: directory)
    }

    func testLateReceiptReadCannotCommitAfterStopCloseOrBackground() async throws {
        let claim = try PJ.object(PaymentVectors.fixture()["attached"]), txid = try PJ.hash(claim["txid"])
        for transition in ["stop", "close", "background"] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-receipt-test-" + UUID().uuidString)
            let url = directory.appendingPathComponent("receipt.json")
            try ClaimsPublicStore.write(["txid": txid, "status": "unknown"], to: url)
            let wire = ClaimReceiptWire(), rpc = MobileRpcClient(factory: { wire })
            let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            rpc.setActive(true)
            await engine.setActive(true)
            let checking = Task { try await engine.checkSubmission() }
            do {
                let request = try await waitForRead(wire, 1)
                if transition == "close" { await engine.close() }
                else if transition == "background" { await engine.setActive(false) }
                else { await engine.stop() }
                try wire.reply(request, pending(claim))
                do { _ = try await checking.value; XCTFail("Obsolete receipt read committed after \(transition)") }
                catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
                let persisted = try ClaimsPublicStore.read(url), state = await engine.state()
                XCTAssertEqual(persisted["status"] as? String, "unknown")
                XCTAssertEqual(state["unknown"] as? Int64, 1)
                XCTAssertEqual(state["submitted"] as? Int64, 0)
            } catch {
                checking.cancel(); await engine.close(); rpc.close()
                try? FileManager.default.removeItem(at: directory); throw error
            }
            await engine.close(); rpc.close(); try FileManager.default.removeItem(at: directory)
        }
    }

    func testConcurrentReceiptResultCannotStopTheNewSession() async throws {
        let claim = try PJ.object(PaymentVectors.fixture()["attached"]), txid = try PJ.hash(claim["txid"])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-receipt-test-" + UUID().uuidString)
        let url = directory.appendingPathComponent("receipt.json")
        try ClaimsPublicStore.write(["txid": txid, "status": "unknown"], to: url)
        let wire = ClaimReceiptWire(), rpc = MobileRpcClient(factory: { wire })
        let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        rpc.setActive(true)
        await engine.setActive(true)
        let first = Task { try await engine.checkSubmission() }
        var second: Task<JSONObject, Error>?
        do {
            let firstRequest = try await waitForRead(wire, 1)
            let duplicate = Task { try await engine.checkSubmission() }; second = duplicate
            let secondRequest = try await waitForRead(wire, 2)
            try wire.reply(firstRequest, pending(claim)); _ = try await first.value
            try await engine.start(address: reward)
            try wire.reply(secondRequest, pending(claim))
            do { _ = try await duplicate.value; XCTFail("The old result was allowed to stop the new session") }
            catch { XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RECEIPT_STATE") }
            let state = await engine.state()
            XCTAssertEqual(state["enabled"] as? Bool, true)
            XCTAssertEqual(state["unknown"] as? Int64, 0)
            XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "submitted")
        } catch {
            first.cancel(); second?.cancel(); await engine.close(); rpc.close()
            try? FileManager.default.removeItem(at: directory); throw error
        }
        await engine.close(); rpc.close(); try FileManager.default.removeItem(at: directory)
    }
}
