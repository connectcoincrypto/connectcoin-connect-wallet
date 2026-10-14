import XCTest
@testable import WalletCore

private func blockHash(_ value: Int64) -> String { String(format: "%064llx", value) }
private func recentWindow(_ height: Int64 = 700, depth: Int = 0, branch: Int64 = 1) -> JSONObject {
    let rows: [JSONObject] = (0..<Int(min(600, height + 1))).map { index in
        let blockHeight = height - Int64(index)
        let hash = index < depth ? blockHash(branch * 1_000_000 + blockHeight) :
            blockHeight == 0 ? NativePaymentChecks.GENESIS : blockHash(blockHeight + 1000)
        return ["height": blockHeight, "hash": hash]
    }
    return ["window": 600, "blocks": rows, "tip": ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS,
        "hash": rows[0]["hash"]!, "height": height, "mediantime": 1_700_000_000 + height] as JSONObject]
}

private final class WindowFixture {
    var current: JSONObject
    var calls: [(String, JSONObject)] = []
    var hook: ((String, JSONObject, Int) throws -> JSONObject?)?
    private var counts: [String: Int] = [:]
    private var journal = 0
    init(_ current: JSONObject = recentWindow()) { self.current = current }
    var tip: JSONObject { current["tip"] as! JSONObject }
    var hashCounts: [Int] { calls.filter { $0.0 == "getrecentblockhashes" }.map { $0.1["count"] as? Int ?? 600 } }
    func query(_ method: String, _ params: JSONObject) async throws -> JSONObject {
        calls.append((method, params)); counts[method, default: 0] += 1
        if let result = try hook?(method, params, counts[method]!) { return result }
        switch method {
        case "getchaintip": return tip
        case "getrecentblockhashes":
            var value = current
            value["blocks"] = Array((current["blocks"] as! [JSONObject]).prefix(params["count"] as? Int ?? 600))
            return value
        case "getbountychanges":
            journal += 1
            return ["tip": tip, "next_cursor": "cursor-\(journal)", "has_more": false, "changes": [JSONObject]()]
        default: XCTFail("Unexpected or non-read-only RPC: \(method)"); throw WalletError("TEST_RPC")
        }
    }
    func run(known: ClaimRecentWindow? = nil, cursor: String? = nil,
             rows: [String: ClaimCandidate] = [:], loaded: Set<String> = [],
             newBlock: String? = nil, staged: [String: ClaimCandidate] = [:],
             retained: [String: ClaimCandidate] = [:]) async throws -> ClaimDiscoveryReplay {
        try await ClaimDiscoveryReplay.read(known: known, cursor: cursor, catalog: rows, loaded: loaded,
            newBlock: newBlock, staged: staged, retained: retained, query: query)
    }
}

/// Real MobileRpcClient framing with an offline transport that can close on a
/// chosen read. Discovery still goes through all production parsing/fences.
private final class WindowRpcWire: RpcWire, @unchecked Sendable {
    private let mutex = NSLock()
    private let fixture: WindowFixture, disconnectOn: String?
    private var receive: ((Data) -> Void)?, failed: (() -> Void)?
    private var requests: [String] = []
    init(_ fixture: WindowFixture, disconnectOn: String? = nil) {
        self.fixture = fixture; self.disconnectOn = disconnectOn
    }
    var methods: [String] { mutex.lock(); defer { mutex.unlock() }; return requests }
    func start(queue: DispatchQueue, ready: @escaping () -> Void, receive: @escaping (Data) -> Void, failed: @escaping () -> Void) {
        mutex.lock(); self.receive = receive; self.failed = failed; mutex.unlock(); ready()
    }
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void) {
        do {
            let request = try JSON.decode(Data(bytes.dropLast()))
            let method = try PJ.string(request["method"]), params = try PJ.object(request["params"])
            mutex.lock(); requests.append(method); let receive = self.receive, failed = self.failed; mutex.unlock()
            completed(true)
            if method == disconnectOn { failed?(); return }
            let fixture = self.fixture
            Task {
                do {
                    let result = try await fixture.query(method, params)
                    receive?(try JSON.encode(["jsonrpc": "2.0", "id": request["id"]!, "result": result]) + Data([10]))
                } catch { failed?() }
            }
        } catch { completed(false) }
    }
    func cancel() {}
}

final class ClaimRecentWindowTests: XCTestCase {
    private func rejects(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Malformed or interrupted discovery was published", file: file, line: line) } catch {}
    }
    private func candidate(_ window: ClaimRecentWindow, index: Int = 1) throws -> ClaimCandidate {
        let block = window.blocks[index]
        return try ClaimCandidate(["txid": blockHash(9_000_001), "vout": 0, "block_hash": block.hash,
            "block_height": block.height, "confirmations": window.tip.height - block.height + 1,
            "coinbase": false, "amount": "10000000000", "domain": "example.com",
            "connection_work_target": String(repeating: "f", count: 64), "root_certificates_version": 1,
            "signature_algorithms_mask": 7, "status": "available"], block: block.hash, fee: 1500, factor: 1_000_000)
    }
    private func event(_ row: ClaimCandidate, _ kind: String, _ sequence: Int) -> JSONObject {
        ["type": kind, "sequence": sequence, "txid": row.bounty["txid"]!, "vout": 0,
         "block_hash": row.block, "spending_txid": blockHash(9_000_002)]
    }

    func testColdFullWindowAndWarmZeroListsBothKeepJournalAndFinalFence() async throws {
        let f = WindowFixture(), cold = try await f.run()
        XCTAssertEqual(f.hashCounts, [600]); XCTAssertEqual(cold.window.blocks.count, 600)
        XCTAssertEqual(f.calls.map(\.0), ["getbountychanges", "getrecentblockhashes", "getbountychanges", "getchaintip"])
        XCTAssertTrue(cold.loaded.isEmpty, "A hash window does not mark unread bounty streams complete")
        f.calls.removeAll()
        let warm = try await f.run(known: cold.window, cursor: cold.cursor, loaded: Set(cold.window.order))
        XCTAssertEqual(f.hashCounts, []); XCTAssertEqual(warm.window, cold.window)
        XCTAssertEqual(f.calls.map(\.0), ["getbountychanges", "getchaintip"])
        XCTAssertEqual(warm.loaded.count, 600)
    }

    func testAvailableAgainIsPublishedOnlyWithValidatedCompleteReplay() async throws {
        let window = try ClaimRecentWindow(recentWindow()), row = try candidate(window)
        for validFence in [false, true] {
            let f = WindowFixture(); var published = Set<String>()
            f.hook = { method, _, count in
                if method == "getbountychanges" && count == 1 {
                    return ["tip": f.tip, "changes": [self.event(row, "available_again", 1)],
                        "next_cursor": "reopened", "has_more": false]
                }
                if method == "getchaintip" && !validFence { throw RpcFailure("RPC_TIMEOUT") }
                return nil
            }
            do {
                let result = try await f.run(known: window, cursor: "old", rows: [row.key: row], loaded: [row.block])
                published = result.availableAgain; XCTAssertTrue(validFence)
                XCTAssertEqual(result.catalog[row.key]?.state, "available")
            } catch { XCTAssertFalse(validFence) }
            XCTAssertEqual(published.contains(row.key), validFence)
        }
    }

    func testPendingSpenderAndAvailableAgainCommitTogetherWithoutChangingProgress() async throws {
        let window = try ClaimRecentWindow(recentWindow()), row = try candidate(window)
        row.progress.captures = 2; row.progress.prepared = ["challenge": "unchanged"]
        let f = WindowFixture()
        f.hook = { method, _, count in
            guard method == "getbountychanges", count == 1 else { return nil }
            return ["tip": f.tip, "changes": [self.event(row, "pending_spend", 1)], "next_cursor": "pending", "has_more": false]
        }
        let pending = try await f.run(known: window, cursor: "old", rows: [row.key: row], retained: [row.key: row])
        XCTAssertEqual(pending.catalog[row.key]?.spendingTxid, blockHash(9_000_002))
        XCTAssertEqual(pending.retained[row.key]?.spendingTxid, blockHash(9_000_002))
        XCTAssertTrue(pending.availableAgain.isEmpty); XCTAssertNil(row.spendingTxid)
        let resumed = WindowFixture()
        resumed.hook = { method, _, count in
            guard method == "getbountychanges", count == 1 else { return nil }
            return ["tip": resumed.tip, "changes": [self.event(row, "available_again", 2)], "next_cursor": "available", "has_more": false]
        }
        let reopened = try await resumed.run(known: pending.window, cursor: pending.cursor,
            rows: pending.catalog, retained: pending.retained)
        XCTAssertEqual(reopened.availableAgain, [row.key])
        XCTAssertEqual(reopened.catalog[row.key]?.state, "available"); XCTAssertNil(reopened.catalog[row.key]?.spendingTxid)
        XCTAssertEqual(reopened.retained[row.key]?.state, "available"); XCTAssertNil(reopened.retained[row.key]?.spendingTxid)
        XCTAssertTrue(reopened.catalog[row.key]?.progress === row.progress)
        XCTAssertEqual(row.progress.captures, 2); XCTAssertEqual(row.progress.prepared?["challenge"] as? String, "unchanged")
    }

    func testReadDisconnectPreservesRetainedProgressAndRetryPayloadUntilValidatedReplay() async throws {
        // This covers the actual transport/discovery/retention boundary. Native
        // capture injection and the actor's private queue are not mocked here.
        for phase in ["getbountychanges", "getchaintip"] {
            for outcome in ["available", "spent", "malformed"] {
                let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
                row.progress.captures = 2
                row.progress.prepared = ["challenge": "same-prepared-claim"]
                let progress = row.progress
                var pending = ClaimSubmissionRetry(hex: String(repeating: "020001ab", count: 10), txid: blockHash(77))
                var unsent = RpcFailure("RPC_UNAVAILABLE"); unsent.notSent = true
                XCTAssertTrue(pending.retain(after: unsent, now: 10))
                let due = pending.due, failures = pending.failures, hex = pending.hex, txid = pending.txid
                let fixture = WindowFixture(), first = WindowRpcWire(fixture, disconnectOn: phase), recovered = WindowRpcWire(fixture)
                var connections = 0
                let rpc = MobileRpcClient(factory: { connections += 1; return connections == 1 ? first : recovered })
                defer { rpc.close() }; rpc.setActive(true)
                func replay() async throws -> ClaimDiscoveryReplay {
                    try await ClaimDiscoveryReplay.read(known: known, cursor: "committed-before-disconnect",
                        catalog: [row.key: row], loaded: Set(known.order), retained: [row.key: row]) {
                            try await rpc.call($0, $1)
                        }
                }
                do { _ = try await replay(); XCTFail("Interrupted read published a snapshot") }
                catch let failure as RpcFailure {
                    XCTAssertEqual(failure.code, "RPC_UNAVAILABLE")
                    XCTAssertFalse(failure.unknownOutcome); XCTAssertFalse(failure.notSent)
                    XCTAssertFalse(failure.notForwarded); XCTAssertFalse(failure.explicitRejection)
                    // A failed READ is not evidence that a payment was unsent,
                    // and must not mutate that payment's retry accounting.
                    XCTAssertFalse(pending.retain(after: failure, now: 20))
                }
                XCTAssertEqual(first.methods, phase == "getchaintip" ? ["getbountychanges", "getchaintip"] : ["getbountychanges"])
                XCTAssertEqual(row.state, "available"); XCTAssertTrue(row.progress === progress)
                XCTAssertEqual(progress.captures, 2)
                XCTAssertEqual(progress.prepared?["challenge"] as? String, "same-prepared-claim")
                XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: row, retained: row, captured: row,
                    normallyAged: false, coherent: false), "An interrupted snapshot must not authorize a send")

                fixture.hook = { method, _, _ in
                    guard method == "getbountychanges", outcome != "available" else { return nil }
                    let change = self.event(row, "spent", 1)
                    return ["tip": fixture.tip, "changes": outcome == "malformed" ? [change, change] : [change],
                        "next_cursor": "after-reconnect", "has_more": false]
                }
                do {
                    let result = try await replay()
                    XCTAssertNotEqual(outcome, "malformed", "Reconnect must not bypass event validation")
                    XCTAssertEqual(result.retained[row.key]?.state, outcome)
                    XCTAssertTrue(result.retained[row.key]?.progress === progress)
                    XCTAssertEqual(recovered.methods, ["getbountychanges", "getchaintip"])
                    XCTAssertEqual(ClaimSubmissionRetry.canSubmitPreserved(catalog: result.catalog[row.key],
                        retained: result.retained[row.key], captured: row, normallyAged: false, coherent: true), outcome == "available")
                } catch let failure as WalletError {
                    XCTAssertEqual(outcome, "malformed")
                    XCTAssertEqual(failure.message, "CLAIMS_RPC_DATA")
                    XCTAssertEqual(recovered.methods, ["getbountychanges"], "Malformed events cannot reach the final fence")
                }
                XCTAssertEqual(progress.captures, 2)
                XCTAssertEqual(progress.prepared?["challenge"] as? String, "same-prepared-claim")
                XCTAssertEqual(row.state, "available", "A staged spend must not mutate the previously committed row")
                XCTAssertEqual(pending.hex, hex); XCTAssertEqual(pending.txid, txid)
                XCTAssertEqual(pending.due, due); XCTAssertEqual(pending.failures, failures)
                XCTAssertFalse((first.methods + recovered.methods).contains("sendrawtransaction"))
            }
        }
    }

    func testNewBlocksReorganizationsAndRollbackUseOnlyCompleteAnchoredWindows() async throws {
        let known = try ClaimRecentWindow(recentWindow())
        let cases: [(Int64, Int, [Int])] = [(701, 0, [5]), (700, 3, [5]), (700, 4, [5]),
            (700, 5, [5, 100]), (700, 99, [5, 100]), (700, 100, [5, 100, 600]),
            (700, 450, [5, 100, 600]), (1400, 0, [5, 100, 600]), (699, 0, [5, 100, 600])]
        for (height, depth, expected) in cases {
            let f = WindowFixture(recentWindow(height, depth: depth))
            let result = try await f.run(known: known, cursor: "old", loaded: Set(known.order))
            XCTAssertEqual(f.hashCounts, expected, "height \(height), depth \(depth)")
            XCTAssertEqual(result.window, try ClaimRecentWindow(f.current))
            XCTAssertEqual(result.window.blocks.count, 600)
            XCTAssertEqual(result.loaded, Set(known.order).intersection(Set(result.window.order)))
        }
    }

    func testNearGenesisLengthsAndRollbackReuseTheEntireShortHistory() async throws {
        for height in [Int64(0), 1, 3, 4, 5, 19] {
            let known = try ClaimRecentWindow(recentWindow(height == 19 ? 20 : max(0, height - 1)))
            let f = WindowFixture(recentWindow(height))
            let result = try await f.run(known: known, cursor: height == 0 ? nil : "old")
            XCTAssertEqual(f.hashCounts, [5])
            XCTAssertEqual(result.window.blocks.count, Int(height + 1))
            XCTAssertEqual(result.window.blocks.last?.hash, NativePaymentChecks.GENESIS)
        }
    }

    func testOldServersMayIgnoreCountOrRejectOnlyThatParameter() async throws {
        let known = try ClaimRecentWindow(recentWindow())
        for rejectsCount in [false, true] {
            let f = WindowFixture(recentWindow(701))
            f.hook = { method, params, _ in
                guard method == "getrecentblockhashes" else { return nil }
                if rejectsCount && params["count"] != nil { throw RpcFailure("-32602") }
                return f.current
            }
            let result = try await f.run(known: known, cursor: "old")
            XCTAssertEqual(f.hashCounts, rejectsCount ? [5, 600] : [5])
            XCTAssertEqual(result.window, try ClaimRecentWindow(f.current))
        }
        for code in ["RPC_TIMEOUT", "RPC_UNAVAILABLE", "-32029", "-32603"] {
            let f = WindowFixture(recentWindow(701))
            f.hook = { method, _, _ in if method == "getrecentblockhashes" { throw RpcFailure(code) }; return nil }
            await rejects { _ = try await f.run(known: known, cursor: "old") }
            XCTAssertEqual(f.hashCounts, [5], "Transport/protocol failures must not cause a fallback")
        }
    }

    func testMalformedPrefixAndFallbackFailClosedWithoutLargerQueries() async throws {
        let known = try ClaimRecentWindow(recentWindow())
        for mutation in 0..<9 {
            let f = WindowFixture(recentWindow(701))
            f.hook = { method, _, _ in
                guard method == "getrecentblockhashes" else { return nil }
                var result = f.current, rows = Array((f.current["blocks"] as! [JSONObject]).prefix(5)), tip = f.tip
                switch mutation {
                case 0: rows.removeLast()
                case 1: rows.append((f.current["blocks"] as! [JSONObject])[5])
                case 2: rows[2]["height"] = 2
                case 3: rows[2]["hash"] = rows[3]["hash"]
                case 4: rows[2]["hash"] = String(repeating: "z", count: 64)
                case 5: rows[0]["hash"] = blockHash(77)
                case 6: result["window"] = 5
                case 7: tip["genesis_hash"] = blockHash(77)
                default: tip["mediantime"] = 2
                }
                result["blocks"] = rows; result["tip"] = tip; return result
            }
            await rejects { _ = try await f.run(known: known, cursor: "old") }
            XCTAssertEqual(f.hashCounts, [5])
        }
        let fallback = WindowFixture(recentWindow(701))
        fallback.hook = { method, params, _ in
            guard method == "getrecentblockhashes" else { return nil }
            if params["count"] != nil { throw RpcFailure("-32602") }
            var value = fallback.current; value["blocks"] = Array((value["blocks"] as! [JSONObject]).prefix(5)); return value
        }
        await rejects { _ = try await fallback.run(known: known, cursor: "old") }
        XCTAssertEqual(fallback.hashCounts, [5, 600])
    }

    func testKnownHashHeightAndAncestryCannotContradictTheCache() async throws {
        let known = try ClaimRecentWindow(recentWindow())
        for wrongHeight in [true, false] {
            let f = WindowFixture(recentWindow(701))
            f.hook = { method, _, _ in
                guard method == "getrecentblockhashes" else { return nil }
                var value = f.current, rows = Array((value["blocks"] as! [JSONObject]).prefix(5))
                rows[wrongHeight ? 1 : 3]["hash"] = wrongHeight ? blockHash(1650) : blockHash(888888)
                value["blocks"] = rows; return value
            }
            await rejects { _ = try await f.run(known: known, cursor: "old") }
        }
    }

    func testChangingBranchesBetweenPrefixesDoesNotSpliceTheirHashes() async throws {
        let known = try ClaimRecentWindow(recentWindow())
        let f = WindowFixture(recentWindow(700, depth: 10))
        f.hook = { method, _, count in
            if method == "getrecentblockhashes" && count == 2 { f.current = recentWindow(700, depth: 2, branch: 2) }
            return nil
        }
        let result = try await f.run(known: known, cursor: "old")
        XCTAssertEqual(f.hashCounts, [5, 100]); XCTAssertEqual(result.window, try ClaimRecentWindow(f.current))
    }

    func testFinalFenceDetectsNewBlockAndReorgBeforePublication() async throws {
        let known = try ClaimRecentWindow(recentWindow())
        for reorg in [false, true] {
            let f = WindowFixture()
            f.hook = { method, _, count in
                if method == "getchaintip" && count == 1 { f.current = recentWindow(reorg ? 700 : 701, depth: reorg ? 3 : 0) }
                return nil
            }
            let result = try await f.run(known: known, cursor: "old")
            XCTAssertEqual(f.hashCounts, [5]); XCTAssertEqual(result.window, try ClaimRecentWindow(f.current))
            XCTAssertEqual(f.calls.filter { $0.0 == "getchaintip" }.count, 2)
            XCTAssertEqual(f.calls.filter { $0.0 == "getbountychanges" }.count, 2)
        }
    }

    func testAllJournalPagesAndMempoolEventsReplayWithoutMutatingPublishedRows() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        let f = WindowFixture()
        f.hook = { method, _, count in
            guard method == "getbountychanges", count <= 3 else { return nil }
            let kind = ["pending_spend", "available_again", "spent"][count - 1]
            return ["tip": f.tip, "next_cursor": "page-\(count)", "has_more": count < 3, "changes": [self.event(row, kind, count)]]
        }
        let result = try await f.run(known: known, cursor: "old", rows: [row.key: row], loaded: Set(known.order))
        XCTAssertEqual(f.hashCounts, []); XCTAssertEqual(result.catalog[row.key]?.state, "spent")
        XCTAssertEqual(row.state, "available"); XCTAssertTrue(result.catalog[row.key]?.progress === row.progress)
        XCTAssertEqual(f.calls.filter { $0.0 == "getbountychanges" }.map { $0.1["cursor"] as? String }, ["old", "page-1", "page-2"])
    }

    func testDefaultTenThousandEventJournalLeavesRoomForPostHashDrain() async throws {
        let known = try ClaimRecentWindow(recentWindow())
        for changedDuringHashes in [false, true] {
            let row = try candidate(known), f = WindowFixture(recentWindow(701))
            row.progress.captures = 2; row.progress.prepared = ["challenge": "preserved"]
            f.hook = { method, params, count in
                guard method == "getbountychanges" else { return nil }
                if count <= 100 {
                    XCTAssertEqual(params["cursor"] as? String, count == 1 ? "old" : "page-\(count - 1)")
                    let events = (1...100).map { item -> JSONObject in
                        let sequence = (count - 1) * 100 + item
                        return self.event(row, sequence.isMultiple(of: 2) ? "available_again" : "pending_spend", sequence)
                    }
                    return ["tip": f.tip, "next_cursor": "page-\(count)", "has_more": count < 100, "changes": events]
                }
                XCTAssertEqual(count, 101); XCTAssertEqual(params["cursor"] as? String, "page-100")
                return ["tip": f.tip, "next_cursor": "drained", "has_more": false,
                    "changes": changedDuringHashes ? [self.event(row, "spent", 10_001)] : [JSONObject]()]
            }
            let result = try await f.run(known: known, cursor: "old", rows: [row.key: row],
                loaded: Set(known.order), retained: [row.key: row])
            XCTAssertEqual(f.hashCounts, [5]); XCTAssertEqual(result.cursor, "drained")
            XCTAssertEqual(f.calls.filter { $0.0 == "getbountychanges" }.count, 101)
            XCTAssertEqual(f.calls.last?.0, "getchaintip", "The extra drain never replaces the final fence")
            XCTAssertEqual(result.catalog[row.key]?.state, changedDuringHashes ? "spent" : "available")
            XCTAssertEqual(result.retained[row.key]?.state, changedDuringHashes ? "spent" : "available")
            XCTAssertEqual(row.state, "available", "Replay never publishes intermediate journal states")
            XCTAssertTrue(result.catalog[row.key]!.progress === row.progress)
            XCTAssertEqual(row.progress.captures, 2)
            XCTAssertEqual(row.progress.prepared?["challenge"] as? String, "preserved")
        }
    }

    func testFinalAllowedPageCanFenceButAnExtraDrainCannotExceedTheBudget() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        for hashRefresh in [false, true] {
            let f = WindowFixture(recentWindow(hashRefresh ? 701 : 700))
            f.hook = { method, _, count in
                guard method == "getbountychanges" else { return nil }
                return ["tip": f.tip, "next_cursor": "page-\(count)",
                    "has_more": count < ClaimDiscoveryReplay.maximumJournalPages,
                    "changes": [self.event(row, "available_again", count)]]
            }
            do {
                let result = try await f.run(known: known, cursor: "old", rows: [row.key: row])
                XCTAssertFalse(hashRefresh, "A post-hash drain beyond the page budget must retry")
                XCTAssertEqual(result.cursor, "page-128"); XCTAssertEqual(f.calls.last?.0, "getchaintip")
            } catch let failure as WalletError {
                XCTAssertTrue(hashRefresh); XCTAssertEqual(failure.message, "CLAIMS_SYNC_BUSY")
                XCTAssertFalse(f.calls.contains { $0.0 == "getchaintip" }, "Unfenced staging cannot be published")
            }
            XCTAssertEqual(f.calls.filter { $0.0 == "getbountychanges" }.count, 128)
            XCTAssertEqual(row.state, "available")
        }
    }

    func testBudgetExhaustionIsRetryableAndFreshSnapshotPreservesAdmittedWork() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        row.progress.captures = 2; row.progress.prepared = ["challenge": "already-verified"]
        var pending = ClaimSubmissionRetry(hex: "unchanged-transaction", txid: blockHash(9_999_999))
        var refusal = RpcFailure("-32030"); refusal.notForwarded = true; refusal.retryAfterMs = 120_000
        XCTAssertTrue(pending.retain(after: refusal, now: 0))
        for movingFence in [false, true] {
            let f = WindowFixture()
            f.hook = { method, _, count in
                if movingFence {
                    if method == "getchaintip" { f.current = recentWindow(700 + Int64(count)) }
                    return nil
                }
                guard method == "getbountychanges" else { return nil }
                return ["tip": f.tip, "next_cursor": "page-\(count)", "has_more": true,
                    "changes": [self.event(row, "pending_spend", count)]]
            }
            do {
                _ = try await f.run(known: known, cursor: "old", rows: [row.key: row],
                    loaded: Set(known.order), retained: [row.key: row])
                XCTFail("An unbounded journal or moving final fence was published")
            } catch let failure as WalletError { XCTAssertEqual(failure.message, "CLAIMS_SYNC_BUSY") }
            XCTAssertEqual(f.calls.filter { $0.0 == "getbountychanges" }.count,
                movingFence ? ClaimDiscoveryReplay.maximumCoherenceRounds : ClaimDiscoveryReplay.maximumJournalPages)
            XCTAssertEqual(row.state, "available"); XCTAssertEqual(row.progress.captures, 2)
            // Engine recovery closes admission and resets only the snapshot / cursor.
            // The next operation takes a new watermark before loading any block.
            let resumed = WindowFixture()
            let fresh = try await resumed.run(known: known, retained: [row.key: row])
            XCTAssertNil(resumed.calls.first?.1["cursor"]); XCTAssertEqual(resumed.calls.first?.0, "getbountychanges")
            XCTAssertEqual(resumed.hashCounts, [5]); XCTAssertTrue(fresh.catalog.isEmpty); XCTAssertTrue(fresh.loaded.isEmpty)
            XCTAssertTrue(fresh.retained[row.key]!.progress === row.progress)
            XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: fresh.retained[row.key],
                captured: row, normallyAged: false, coherent: true), "In-window work must await its complete block")
            let reloaded = try await resumed.run(known: fresh.window, cursor: fresh.cursor, rows: fresh.catalog,
                loaded: fresh.loaded, newBlock: row.block, staged: [row.key: try candidate(known)], retained: fresh.retained)
            XCTAssertTrue(reloaded.catalog[row.key]!.progress === row.progress)
            XCTAssertTrue(ClaimSubmissionRetry.canSubmitPreserved(catalog: reloaded.catalog[row.key], retained: reloaded.retained[row.key],
                captured: row, normallyAged: false, coherent: true))
            XCTAssertEqual(row.progress.captures, 2)
            XCTAssertEqual(row.progress.prepared?["challenge"] as? String, "already-verified")
            XCTAssertEqual(pending.hex, "unchanged-transaction"); XCTAssertEqual(pending.txid, blockHash(9_999_999))
            XCTAssertEqual(pending.due, 120); XCTAssertEqual(pending.failures, 1)
        }
    }

    func testFreshBlockStreamRecoversMissedReopeningWithoutRecapturingRetainedProof() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        let attached = try PJ.object(PaymentVectors.fixture()["attached"])
        for acknowledged in [false, true] {
            let saved = ClaimSavedSubmission(row: row, retry: ClaimSubmissionRetry(
                hex: try PJ.string(attached["hex"]), txid: try PJ.hash(attached["txid"])))
            row.progress.captures = 2; row.progress.prepared = ["challenge": "unchanged"]
            if acknowledged { _ = saved.acknowledge(now: 1) }
            saved.beginWrite(); saved.rejected()
            var pending = row; pending.state = "pending_spend"; pending.spendingTxid = blockHash(9_000_002)
            let f = WindowFixture()
            // Stop/Start or a required journal reset missed available_again.
            // The new watermark and hash list cannot by themselves reopen it.
            let reset = try await f.run(known: known, retained: [row.key: pending])
            XCTAssertNil(f.calls.first?.1["cursor"]); XCTAssertTrue(reset.availableAgain.isEmpty)
            XCTAssertTrue(saved.waitingForAvailability)
            let result = try await f.run(known: reset.window, cursor: reset.cursor, rows: reset.catalog,
                loaded: reset.loaded, newBlock: row.block, staged: [row.key: try candidate(known)], retained: reset.retained)
            XCTAssertEqual(result.availableAgain, [row.key]); XCTAssertEqual(f.calls.last?.0, "getchaintip")
            XCTAssertEqual(result.retained[row.key]?.state, "available")
            XCTAssertNil(result.retained[row.key]?.spendingTxid)
            for key in result.availableAgain where key == row.key { saved.reopened() }
            XCTAssertTrue(saved.availableForRetry(catalog: result.catalog[row.key], retained: result.retained[row.key],
                normallyAged: false, coherent: true))
            XCTAssertEqual(saved.counted, acknowledged); XCTAssertEqual(saved.acknowledged, acknowledged)
            XCTAssertEqual(saved.retry.hex, try PJ.string(attached["hex"]))
            XCTAssertEqual(result.retained[row.key]?.progress.captures, 2)
            XCTAssertEqual(result.retained[row.key]?.progress.prepared?["challenge"] as? String, "unchanged")
        }
    }

    func testFreshBlockStreamCannotInventReopeningOrPublishBeforeFence() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        for state in ["available", "immature", "spent"] {
            var previous = row; previous.state = state
            let result = try await WindowFixture().run(known: known, cursor: "reset", newBlock: row.block,
                staged: [row.key: row], retained: [row.key: previous])
            XCTAssertTrue(result.availableAgain.isEmpty, "An unchanged snapshot or confirmed spend is not a pending-spend reopening")
        }
        var pending = row; pending.state = "pending_spend"; pending.spendingTxid = blockHash(9_000_002)
        let noStream = try await WindowFixture().run(known: known, cursor: "reset", staged: [row.key: row], retained: [row.key: pending])
        XCTAssertTrue(noStream.availableAgain.isEmpty, "Only a validated complete block stream is snapshot evidence")
        for failureMode in ["fence", "changed-identity"] {
            let f = WindowFixture(); var replacement = row
            if failureMode == "fence" {
                f.hook = { method, _, _ in if method == "getchaintip" { throw RpcFailure("RPC_TIMEOUT") }; return nil }
            } else {
                var source = row.bounty; source["amount"] = "10000000001"
                replacement = try ClaimCandidate(source, block: row.block, fee: 1500)
            }
            var published = Set<String>()
            await rejects {
                let result = try await f.run(known: known, cursor: "reset", newBlock: row.block,
                    staged: [row.key: replacement], retained: [row.key: pending])
                published = result.availableAgain
            }
            XCTAssertTrue(published.isEmpty); XCTAssertEqual(pending.state, "pending_spend")
        }
    }

    func testMalformedJournalAfterOneHundredPagesStillFailsClosed() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known), f = WindowFixture()
        f.hook = { method, _, count in
            guard method == "getbountychanges" else { return nil }
            return ["tip": f.tip, "next_cursor": "page-\(count)", "has_more": count < 101,
                "changes": [self.event(row, "pending_spend", min(count, 100))]]
        }
        do {
            _ = try await f.run(known: known, cursor: "old", rows: [row.key: row], retained: [row.key: row])
            XCTFail("A repeated event sequence after page 100 was accepted")
        } catch let failure as WalletError { XCTAssertEqual(failure.message, "CLAIMS_RPC_DATA") }
        XCTAssertEqual(f.calls.filter { $0.0 == "getbountychanges" }.count, 101)
        XCTAssertEqual(row.state, "available"); XCTAssertFalse(f.calls.contains { $0.0 == "getchaintip" })
    }

    func testSpentDuringHashRefreshAndBlockStreamIsReplayedBeforeCommit() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        let f = WindowFixture(recentWindow(701))
        f.hook = { method, _, count in
            guard method == "getbountychanges", count == 2 else { return nil }
            return ["tip": f.tip, "next_cursor": "spent", "has_more": false, "changes": [self.event(row, "spent", 1)]]
        }
        let result = try await f.run(known: known, cursor: "old", newBlock: row.block, staged: [row.key: row])
        XCTAssertEqual(f.hashCounts, [5]); XCTAssertEqual(result.catalog[row.key]?.state, "spent")
        XCTAssertTrue(result.loaded.contains(row.block)); XCTAssertEqual(row.state, "available")
    }

    func testMissingCursorForcesFreshPrefixAndDropsAllBountyStateEvenAtSameTip() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        let f = WindowFixture()
        let result = try await f.run(known: known, rows: [row.key: row], loaded: Set(known.order))
        XCTAssertEqual(f.hashCounts, [5]); XCTAssertEqual(result.window, known)
        XCTAssertTrue(result.catalog.isEmpty); XCTAssertTrue(result.loaded.isEmpty)
        XCTAssertNil(f.calls.first?.1["cursor"])
        for code in ["-32011", "-32004"] {
            let failed = WindowFixture()
            failed.hook = { method, _, _ in if method == "getbountychanges" { throw RpcFailure(code) }; return nil }
            await rejects { _ = try await failed.run(known: known, cursor: "old", rows: [row.key: row]) }
        }
        let reset = WindowFixture()
        reset.hook = { method, _, _ in method == "getbountychanges" ?
            ["tip": reset.tip, "next_cursor": "reset", "has_more": false, "changes": [["type": "resync_required"]]] : nil }
        do { _ = try await reset.run(known: known, cursor: "old"); XCTFail("Reset ignored") }
        catch let error as RpcFailure { XCTAssertEqual(error.code, "-32011") }
    }

    func testRequiredResyncAtNewTipWinsOverHashRefreshFailureOnEveryPage() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        for resetPage in [1, 2] {
            let f = WindowFixture()
            f.hook = { method, _, count in
                if method == "getrecentblockhashes" { throw RpcFailure("RPC_TIMEOUT") }
                guard method == "getbountychanges" else { return nil }
                if count < resetPage {
                    return ["tip": f.tip, "next_cursor": "before-reset", "has_more": true,
                        "changes": [self.event(row, "pending_spend", 1)]]
                }
                f.current = recentWindow(701)
                return ["tip": f.tip, "next_cursor": "reset", "has_more": false,
                    "changes": [["type": "resync_required"]]]
            }
            do {
                _ = try await f.run(known: known, cursor: "old", rows: [row.key: row], loaded: Set(known.order))
                XCTFail("Required resync was ignored")
            } catch let error as RpcFailure {
                XCTAssertEqual(error.code, "-32011", "A timeout must not mask the server's required reset")
            } catch {
                XCTFail("Unexpected error instead of required resync: \(error)")
            }
            XCTAssertEqual(f.calls.map(\.0), Array(repeating: "getbountychanges", count: resetPage))
            XCTAssertEqual(f.hashCounts, [])
            XCTAssertEqual(row.state, "available", "Earlier pages must remain privately staged")
            XCTAssertEqual(known, try ClaimRecentWindow(recentWindow()))
        }
    }

    func testSameHashMetadataAndGenesisMustAlwaysAgreeIncludingFinalFence() async throws {
        let known = try ClaimRecentWindow(recentWindow())
        for method in ["getbountychanges", "getchaintip"] {
            for field in ["height", "mediantime", "genesis_hash", "chain"] {
                let f = WindowFixture()
                f.hook = { name, _, _ in
                    guard name == method else { return nil }
                    var tip = f.tip
                    if field == "chain" { tip[field] = "testnet" }
                    else if field == "genesis_hash" { tip[field] = blockHash(66) }
                    else { tip[field] = 42 }
                    return name == "getchaintip" ? tip : ["tip": tip, "next_cursor": "bad", "has_more": false, "changes": [JSONObject]()]
                }
                await rejects { _ = try await f.run(known: known, cursor: "old") }
            }
        }
        var zero = recentWindow(0), zeroTip = zero["tip"] as! JSONObject
        zeroTip["hash"] = blockHash(88); zero["tip"] = zeroTip
        XCTAssertThrowsError(try ClaimRecentWindow(zero))
        var near = recentWindow(3), rows = near["blocks"] as! [JSONObject]
        rows[3]["hash"] = blockHash(88); near["blocks"] = rows
        XCTAssertThrowsError(try ClaimRecentWindow(near))
    }

    func testBadJournalDoesNotPublishOrDiscardThePreviousCursorAndRows() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        for mutation in 0..<5 {
            let f = WindowFixture()
            f.hook = { method, _, _ in
                guard method == "getbountychanges" else { return nil }
                var response: JSONObject = ["tip": f.tip, "next_cursor": "next", "has_more": false,
                    "changes": [self.event(row, "spent", 1)]]
                switch mutation {
                case 0: response["has_more"] = true; response["changes"] = [JSONObject]()
                case 1: response["next_cursor"] = "old"
                case 2: response["next_cursor"] = ""
                case 3: response["changes"] = [self.event(row, "spent", 1), self.event(row, "spent", 1)]
                default: response["changes"] = [self.event(row, "invalid", 1)]
                }
                return response
            }
            await rejects { _ = try await f.run(known: known, cursor: "old", rows: [row.key: row]) }
            XCTAssertEqual(row.state, "available"); XCTAssertEqual(known, try ClaimRecentWindow(recentWindow()))
        }
    }

    func testCancellationAfterHashResponseAndFinalFenceNeverPublishes() async throws {
        for boundary in ["getrecentblockhashes", "getchaintip"] {
            let f = WindowFixture()
            f.hook = { method, _, _ in
                if method == boundary { withUnsafeCurrentTask { $0?.cancel() } }
                return nil
            }
            let task = Task { try await f.run() }
            await rejects { _ = try await task.value }
        }
    }

    func testWindowOwnsItsValuesIndependentlyOfMutableRpcContainers() throws {
        let source = recentWindow(), mutable = NSMutableDictionary(dictionary: source)
        let known = try ClaimRecentWindow(mutable as! JSONObject), expected = known
        mutable["window"] = 1; mutable["blocks"] = [JSONObject]()
        mutable["tip"] = ["height": 0]
        XCTAssertEqual(known, expected); XCTAssertEqual(known.blocks.count, 600)
    }

    func testOptionalRpcCountAcceptsOnlyIntegersOneThroughSixHundred() throws {
        XCTAssertTrue(try MobileRpcClient.validateParams("getrecentblockhashes", [:]).isEmpty)
        for value in [1, 5, 100, 600] {
            XCTAssertEqual(try MobileRpcClient.validateParams("getrecentblockhashes", ["count": value])["count"] as? Int64, Int64(value))
        }
        let invalid: [Any] = [0, -1, 601, true, 1.5, "5", NSNull()]
        for value in invalid {
            XCTAssertThrowsError(try MobileRpcClient.validateParams("getrecentblockhashes", ["count": value]))
        }
        XCTAssertThrowsError(try MobileRpcClient.validateParams("getrecentblockhashes", ["count": 5, "extra": 1]))
        XCTAssertThrowsError(try MobileRpcClient.validateParams("getchaintip", ["count": 5]))
    }

    func testFullWindowCannotBeTruncatedAndEveryPublishedWindowIsComplete() throws {
        for mutation in 0..<5 {
            var value = recentWindow(), rows = value["blocks"] as! [JSONObject]
            switch mutation {
            case 0: rows.removeLast()
            case 1: rows[10]["height"] = 1
            case 2: rows[10]["hash"] = rows[11]["hash"]
            case 3: rows[0]["hash"] = blockHash(12)
            default: value["window"] = 599
            }
            value["blocks"] = rows
            XCTAssertThrowsError(try ClaimRecentWindow(value))
        }
    }

    func testNewBlockDuringPaginatedReplayAndAddedRowDoNotRemainHidden() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        let f = WindowFixture()
        f.hook = { method, _, count in
            guard method == "getbountychanges", count <= 2 else { return nil }
            if count == 1 {
                return ["tip": f.tip, "next_cursor": "first", "has_more": true,
                    "changes": [self.event(row, "pending_spend", 1)]]
            }
            f.current = recentWindow(701)
            var added = self.event(row, "added", 2)
            added["txid"] = blockHash(9_000_003); added["block_height"] = row.height
            return ["tip": f.tip, "next_cursor": "second", "has_more": false, "changes": [added]]
        }
        let result = try await f.run(known: known, cursor: "old", rows: [row.key: row], loaded: Set(known.order))
        XCTAssertEqual(f.hashCounts, [5]); XCTAssertEqual(result.window, try ClaimRecentWindow(f.current))
        XCTAssertFalse(result.loaded.contains(row.block), "An unknown added row requires that block to be read again")
        XCTAssertEqual(result.catalog[row.key]?.state, "pending_spend", "Other rows are preserved until the full stream replaces them")
        XCTAssertEqual(f.calls.filter { $0.0 == "getbountychanges" }.count, 3)
        XCTAssertEqual(row.state, "available")
    }

    func testFailuresAfterConsumingJournalOrAtFinalFenceLeaveTheInputUnchanged() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        for failAtFence in [false, true] {
            let f = WindowFixture()
            f.hook = { method, _, count in
                if failAtFence && method == "getchaintip" { throw RpcFailure("RPC_TIMEOUT") }
                if method == "getbountychanges" {
                    if count == 2 { throw RpcFailure("RPC_UNAVAILABLE") }
                    return ["tip": f.tip, "next_cursor": "consumed", "has_more": !failAtFence,
                        "changes": [self.event(row, "spent", 1)]]
                }
                return nil
            }
            await rejects { _ = try await f.run(known: known, cursor: "old", rows: [row.key: row], loaded: Set(known.order)) }
            XCTAssertEqual(row.state, "available"); XCTAssertEqual(known, try ClaimRecentWindow(recentWindow()))
            XCTAssertEqual(f.calls.first?.1["cursor"] as? String, "old")
        }
    }

    func testReloadedCompleteBlockReplacesRatherThanMergesItsPreviousRows() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known), f = WindowFixture()
        let result = try await f.run(known: known, cursor: "old", rows: [row.key: row],
            loaded: Set(known.order), newBlock: row.block, staged: [:])
        XCTAssertTrue(result.loaded.contains(row.block)); XCTAssertNil(result.catalog[row.key])
        XCTAssertEqual(row.state, "available"); XCTAssertEqual(f.hashCounts, [])
    }

    func testAddedExistingOutpointCannotMoveToAnotherBlockOrHeight() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        for mutation in 0..<3 {
            let f = WindowFixture()
            f.hook = { method, _, _ in
                guard method == "getbountychanges" else { return nil }
                var added = self.event(row, "added", 1)
                added["block_height"] = row.height - 1
                if mutation == 1 { added["block_hash"] = known.blocks[2].hash }
                if mutation == 2 { added["block_hash"] = blockHash(8_888_888) }
                return ["tip": f.tip, "next_cursor": "forged", "has_more": false, "changes": [added]]
            }
            await rejects { _ = try await f.run(known: known, cursor: "old", rows: [row.key: row], loaded: Set(known.order)) }
            XCTAssertEqual(row.block, known.blocks[1].hash); XCTAssertEqual(row.height, known.blocks[1].height)
            XCTAssertEqual(row.state, "available"); XCTAssertEqual(f.hashCounts, [])
        }
    }

    func testNormalWindowExitRetainsAdmittedWorkButIsNotAvailabilityEvidence() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known, index: 599)
        row.progress.captures = 2; row.progress.prepared = ["challenge": "preserved"]
        let f = WindowFixture(recentWindow(701))
        f.hook = { method, _, count in
            guard method == "getbountychanges", count == 1 else { return nil }
            return ["tip": f.tip, "next_cursor": "aged", "has_more": false,
                "changes": [self.event(row, "window_exit", 1)]]
        }
        let result = try await f.run(known: known, cursor: "old", rows: [row.key: row],
            loaded: Set(known.order), retained: [row.key: row])
        XCTAssertNil(result.catalog[row.key]); XCTAssertNotNil(result.retained[row.key])
        XCTAssertTrue(result.retained[row.key]!.progress === row.progress)
        XCTAssertEqual(row.progress.captures, 2)
        XCTAssertEqual(row.progress.prepared?["challenge"] as? String, "preserved")
        XCTAssertFalse(ClaimSubmissionRetry.matchesAvailableBounty(result.catalog[row.key], captured: row))
        XCTAssertTrue(ClaimSubmissionRetry.matchesAvailableBounty(result.retained[row.key], captured: row))
        XCTAssertTrue(result.normallyAged.contains(row.key))
        XCTAssertTrue(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: result.retained[row.key],
            captured: row, normallyAged: result.normallyAged.contains(row.key), coherent: true))
        XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: result.retained[row.key],
            captured: row, normallyAged: true, coherent: false), "Resync/freshness still gates submission")
        XCTAssertEqual(f.calls.last?.0, "getchaintip")
        XCTAssertFalse(f.calls.contains { $0.0 == "getblockbounties" }, "Never ask for an out-of-window stream")
    }

    func testCatalogResetAtNormalRolloverPreservesAdmittedWork() async throws {
        let known = try ClaimRecentWindow(recentWindow(600)), row = try candidate(known, index: 599)
        XCTAssertEqual(row.height, 1)
        row.progress.captures = 2; row.progress.prepared = ["challenge": "already-captured"]
        for cursor in [nil, "old"] as [String?] {
            let f = WindowFixture(recentWindow(601))
            let result = try await f.run(known: known, cursor: cursor, rows: cursor == nil ? [:] : [row.key: row],
                loaded: cursor == nil ? [] : Set(known.order), retained: [row.key: row])
            XCTAssertNil(result.catalog[row.key]); XCTAssertTrue(result.normallyAged.contains(row.key))
            XCTAssertTrue(result.retained[row.key]!.progress === row.progress)
            XCTAssertEqual(result.retained[row.key]?.progress.captures, 2)
            XCTAssertEqual(result.retained[row.key]?.progress.prepared?["challenge"] as? String, "already-captured")
            XCTAssertTrue(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: result.retained[row.key],
                captured: row, normallyAged: result.normallyAged.contains(row.key), coherent: true))
            XCTAssertEqual(f.calls.last?.0, "getchaintip")
            XCTAssertFalse(f.calls.contains { $0.0 == "getblockbounties" })
        }
    }

    func testMissingOverlapDoesNotAssertAnOutOfWindowConflictWithOrWithoutReset() async throws {
        let known = try ClaimRecentWindow(recentWindow(700)), row = try candidate(known, index: 599)
        row.progress.prepared = ["challenge": "old-branch"]
        for cursor in [nil, "old"] as [String?] {
            let f = WindowFixture(recentWindow(701, depth: 600))
            let result = try await f.run(known: known, cursor: cursor, rows: [row.key: row],
                loaded: Set(known.order), retained: [row.key: row])
            XCTAssertEqual(f.hashCounts, [5, 100, 600])
            XCTAssertNotNil(result.retained[row.key]); XCTAssertTrue(result.normallyAged.contains(row.key))
            XCTAssertTrue(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: result.retained[row.key],
                captured: row, normallyAged: result.normallyAged.contains(row.key), coherent: true))
            XCTAssertEqual(row.progress.prepared?["challenge"] as? String, "old-branch", "Staged replay must not mutate its caller")
        }
    }

    func testFinalFenceReplacementWithoutKnownConflictKeepsAgedWork() async throws {
        let known = try ClaimRecentWindow(recentWindow(700)), row = try candidate(known, index: 599)
        let f = WindowFixture(recentWindow(700))
        f.hook = { method, _, count in
            if method == "getchaintip", count == 1 { f.current = recentWindow(701, depth: 600) }
            return nil
        }
        let result = try await f.run(known: known, cursor: "old", rows: [row.key: row], retained: [row.key: row])
        XCTAssertEqual(f.hashCounts, [5, 100, 600])
        XCTAssertEqual(result.window, try ClaimRecentWindow(f.current))
        XCTAssertNotNil(result.retained[row.key]); XCTAssertTrue(result.normallyAged.contains(row.key))
        XCTAssertEqual(f.calls.filter { $0.0 == "getchaintip" }.count, 2)
    }

    func testAdmittedOutOfWindowProofDoesNotNeedAnInventedAncestor() async throws {
        let old = try ClaimRecentWindow(recentWindow(700)), row = try candidate(old, index: 599)
        let result = try await WindowFixture(recentWindow(701)).run(retained: [row.key: row])
        XCTAssertNotNil(result.retained[row.key]); XCTAssertTrue(result.normallyAged.contains(row.key))
    }

    func testExplicitCanonicalConflictAtFinalFenceStillRevokesRetainedProof() async throws {
        let known = try ClaimRecentWindow(recentWindow(700)), row = try candidate(known)
        let f = WindowFixture(recentWindow(700))
        f.hook = { method, _, count in
            if method == "getchaintip", count == 1 { f.current = recentWindow(700, depth: 3) }
            return nil
        }
        let result = try await f.run(known: known, cursor: "old", rows: [row.key: row], retained: [row.key: row])
        XCTAssertNil(result.retained[row.key]); XCTAssertFalse(result.normallyAged.contains(row.key))
        XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: result.retained[row.key],
            captured: row, normallyAged: result.normallyAged.contains(row.key), coherent: true))
    }

    func testResyncRetainsProgressUntilFreshCompleteBlockAndFence() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        row.progress.captures = 1; row.progress.budgetExhausted = true
        let f = WindowFixture()
        let reset = try await f.run(known: known, rows: [row.key: row], loaded: Set(known.order), retained: [row.key: row])
        XCTAssertTrue(reset.catalog.isEmpty); XCTAssertTrue(reset.loaded.isEmpty)
        XCTAssertTrue(reset.retained[row.key]!.progress === row.progress)
        XCTAssertFalse(ClaimSubmissionRetry.matchesAvailableBounty(reset.catalog[row.key], captured: row))
        XCTAssertFalse(reset.normallyAged.contains(row.key))
        XCTAssertFalse(ClaimSubmissionRetry.canSubmitPreserved(catalog: nil, retained: reset.retained[row.key],
            captured: row, normallyAged: false, coherent: true), "In-window work still needs its complete replacement stream")
        let reloaded = try await f.run(known: reset.window, cursor: reset.cursor, rows: reset.catalog,
            loaded: reset.loaded, newBlock: row.block, staged: [row.key: try candidate(known)], retained: reset.retained)
        XCTAssertTrue(reloaded.catalog[row.key]!.progress === row.progress)
        XCTAssertEqual(reloaded.catalog[row.key]!.progress.captures, 1)
        XCTAssertFalse(reloaded.catalog[row.key]!.budget)
        XCTAssertTrue(ClaimSubmissionRetry.matchesAvailableBounty(reloaded.catalog[row.key], captured: row))
    }

    func testRetainedWorkIsInvalidatedByReorgSpentOrCompleteBlockAbsence() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        let reorg = try await WindowFixture(recentWindow(700, depth: 3)).run(known: known, cursor: "old",
            rows: [row.key: row], retained: [row.key: row])
        XCTAssertNil(reorg.retained[row.key])
        let missing = try await WindowFixture().run(known: known, cursor: "old", rows: [row.key: row],
            newBlock: row.block, retained: [row.key: row])
        XCTAssertNil(missing.retained[row.key])
        for state in ["spent", "pending_spend"] {
            let f = WindowFixture()
            f.hook = { method, _, count in
                guard method == "getbountychanges", count == 1 else { return nil }
                return ["tip": f.tip, "next_cursor": "changed", "has_more": false, "changes": [self.event(row, state, 1)]]
            }
            let result = try await f.run(known: known, cursor: "old", rows: [row.key: row], retained: [row.key: row])
            XCTAssertEqual(result.retained[row.key]?.state, state)
            XCTAssertFalse(ClaimSubmissionRetry.matchesAvailableBounty(result.retained[row.key], captured: row))
            XCTAssertEqual(row.state, "available", "Staging must not mutate the published row")
        }
    }

    func testSameOutpointCannotReplacePreparedWorkWithChangedImmutableMetadata() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        row.progress.prepared = ["challenge": "original"]; row.progress.captures = 1
        let mutations: [(String, Any)] = [("amount", "20000000000"), ("domain", "different.example"),
            ("connection_work_target", String(repeating: "e", count: 64)), ("root_certificates_version", 2),
            ("signature_algorithms_mask", 1), ("coinbase", true), ("block_height", row.height - 1)]
        for (field, value) in mutations {
            var source = row.bounty; source[field] = value
            let changed = try ClaimCandidate(source, block: row.block, fee: 1500, factor: 1_000_000)
            await rejects { _ = try await WindowFixture().run(known: known, cursor: "old", rows: [row.key: row],
                newBlock: row.block, staged: [row.key: changed], retained: [row.key: row]) }
            XCTAssertFalse(ClaimSubmissionRetry.matchesAvailableBounty(changed, captured: row))
        }
        var mutable = row.bounty; mutable["confirmations"] = 100; mutable["status"] = "pending_spend"
        var updated = try ClaimCandidate(mutable, block: row.block, fee: 1500, factor: 1_000_000)
        try updated.reuse(row.progress)
        XCTAssertTrue(updated.progress === row.progress); XCTAssertEqual(updated.progress.captures, 1)
        XCTAssertEqual(updated.progress.prepared?["challenge"] as? String, "original")
    }

    func testRetainedSnapshotFailureDoesNotPublishPartialAvailability() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        let f = WindowFixture()
        f.hook = { method, _, _ in if method == "getchaintip" { throw RpcFailure("RPC_TIMEOUT") }; return nil }
        await rejects { _ = try await f.run(known: known, cursor: "old", newBlock: row.block,
            staged: [row.key: row], retained: [row.key: row]) }
        XCTAssertEqual(row.state, "available")
        XCTAssertNil(row.progress.prepared)
    }

    func testRetainedWorkCannotExpandTheBoundedPublicProofQueue() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        let held = Dictionary(uniqueKeysWithValues: (0...ClaimSubmissionRetry.maximumRetainedWinners).map { (String($0), row) })
        let f = WindowFixture()
        await rejects { _ = try await f.run(known: known, cursor: "old", retained: held) }
        XCTAssertTrue(f.calls.isEmpty, "Capacity is checked before any RPC or snapshot staging")
    }

    func testRelocatedFundingOutputDropsPreparedWorkWithoutResettingItsBudget() throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known)
        row.progress.captures = 2; row.progress.prepared = ["challenge": "old-block"]
        var source = row.bounty; source["block_hash"] = known.blocks[2].hash; source["block_height"] = known.blocks[2].height
        var moved = try ClaimCandidate(source, block: known.blocks[2].hash, fee: 1500, factor: 1_100_000)
        try moved.reuse(row.progress)
        XCTAssertFalse(moved.progress === row.progress); XCTAssertNil(moved.progress.prepared)
        XCTAssertEqual(moved.progress.factor, row.progress.factor); XCTAssertEqual(moved.progress.captures, 2)
        XCTAssertFalse(ClaimSubmissionRetry.matchesAvailableBounty(moved, captured: row))
        XCTAssertEqual(row.progress.prepared?["challenge"] as? String, "old-block")
    }

    func testReminePublicationRebasesCaptureBudgetDrainedDuringJournalFence() async throws {
        for exhaustionOnly in [false, true] {
            let previous = try ClaimRecentWindow(recentWindow()), original = try candidate(previous)
            let forkSource = recentWindow(depth: 2), fork = try ClaimRecentWindow(forkSource)
            let destination = fork.blocks[1]
            original.progress.captures = 2
            original.progress.prepared = ["challenge": "old-funding-block"]
            var source = original.bounty
            source["block_hash"] = destination.hash; source["block_height"] = destination.height
            var moved = try ClaimCandidate(source, block: destination.hash, fee: 1500, factor: 1_100_000)
            try moved.reuse(original.progress)
            XCTAssertFalse(moved.progress === original.progress)
            let f = WindowFixture(forkSource)
            f.hook = { method, _, _ in
                if method == "getchaintip" {
                    // A pre-reorg handle drains while replay awaits its final
                    // fence. Its accounting is newer than the staged copy.
                    if exhaustionOnly { original.progress.budgetExhausted = true }
                    else { ClaimProgress.recordNativeCapture(original, hasCaptured: true, current: original.progress) }
                }
                return nil
            }
            let replay = try await f.run(known: fork, cursor: "post-reorg", newBlock: destination.hash,
                staged: [moved.key: moved])
            XCTAssertEqual(f.calls.last?.0, "getchaintip")
            let published = try ClaimProgress.reconcile(previous: [original.key: original.progress],
                catalog: replay.catalog, window: replay.window, loaded: replay.loaded, protected: [])
            let current = try XCTUnwrap(replay.catalog[moved.key])
            XCTAssertTrue(published[moved.key] === current.progress)
            XCTAssertEqual(current.progress.captures, exhaustionOnly ? 2 : 3)
            XCTAssertEqual(current.progress.budgetExhausted, exhaustionOnly)
            XCTAssertFalse(current.budget, "Publishing the fenced stream must not renew an exhausted budget")
            XCTAssertEqual(current.progress.factor, original.progress.factor)
            XCTAssertNil(current.progress.prepared, "Accounting must not resurrect the old funding preparation")
            XCTAssertEqual(original.progress.prepared?["challenge"] as? String, "old-funding-block")
            let repeated = try ClaimProgress.reconcile(previous: published, catalog: replay.catalog,
                window: replay.window, loaded: replay.loaded, protected: [])
            XCTAssertEqual(repeated[moved.key]?.captures, exhaustionOnly ? 2 : 3, "Publishing again must not add the same capture twice")
            var scheduler = ClaimScheduler()
            scheduler.rebuild(Array(replay.catalog.values), stats: [:], retired: [], now: 0)
            XCTAssertNil(scheduler.next(now: 0, prepared: false))
        }
    }

    func testFailedRemineFenceKeepsDrainedAccountingWithoutPublishingStagedProgress() async throws {
        let previous = try ClaimRecentWindow(recentWindow()), original = try candidate(previous)
        let forkSource = recentWindow(depth: 2), fork = try ClaimRecentWindow(forkSource)
        let destination = fork.blocks[1]
        original.progress.captures = 2; original.progress.prepared = ["challenge": "owned"]
        var source = original.bounty; source["block_hash"] = destination.hash; source["block_height"] = destination.height
        var moved = try ClaimCandidate(source, block: destination.hash, fee: 1500)
        try moved.reuse(original.progress)
        let f = WindowFixture(forkSource)
        f.hook = { method, _, _ in
            if method == "getchaintip" {
                ClaimProgress.recordNativeCapture(original, hasCaptured: true, current: original.progress)
                throw RpcFailure("RPC_TIMEOUT")
            }
            return nil
        }
        var published = [original.key: original.progress]
        await rejects {
            let replay = try await f.run(known: fork, cursor: "post-reorg", newBlock: destination.hash, staged: [moved.key: moved])
            published = try ClaimProgress.reconcile(previous: published, catalog: replay.catalog,
                window: replay.window, loaded: replay.loaded, protected: [])
        }
        XCTAssertTrue(published[original.key] === original.progress)
        XCTAssertEqual(published[original.key]?.captures, 3)
        XCTAssertEqual(original.progress.prepared?["challenge"] as? String, "owned")
        XCTAssertEqual(moved.progress.captures, 2)
        XCTAssertNil(moved.progress.prepared)
    }

    func testPublicationBudgetRebaseRejectsDifferentFundingOutputBeforeMutation() throws {
        let previous = try ClaimRecentWindow(recentWindow()), original = try candidate(previous)
        let fork = try ClaimRecentWindow(recentWindow(depth: 2)), destination = fork.blocks[1]
        original.progress.captures = 3
        var source = original.bounty
        source["block_hash"] = destination.hash; source["block_height"] = destination.height
        source["amount"] = "10000000001"
        let conflicting = try ClaimCandidate(source, block: destination.hash, fee: 1500)
        XCTAssertThrowsError(try ClaimProgress.reconcile(previous: [original.key: original.progress],
            catalog: [conflicting.key: conflicting], window: fork, loaded: [destination.hash], protected: [])) { error in
            XCTAssertEqual((error as? WalletError)?.message, "CLAIMS_RPC_DATA")
        }
        XCTAssertEqual(original.progress.captures, 3)
        XCTAssertEqual(conflicting.progress.captures, 0)
        XCTAssertNil(conflicting.progress.prepared)
    }

    func testWindowExitInsideCurrentDepthIsNotTreatedAsNormalAging() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known), f = WindowFixture()
        f.hook = { method, _, count in
            guard method == "getbountychanges", count == 1 else { return nil }
            return ["tip": f.tip, "next_cursor": "exited", "has_more": false, "changes": [self.event(row, "window_exit", 1)]]
        }
        let result = try await f.run(known: known, cursor: "old", rows: [row.key: row], retained: [row.key: row])
        XCTAssertNil(result.catalog[row.key]); XCTAssertNil(result.retained[row.key])
        XCTAssertFalse(result.normallyAged.contains(row.key))
        XCTAssertEqual(row.state, "available")
    }

    func testJournalRelocationRevokesAgedProofAndRequiresCompleteNewBlock() async throws {
        let previous = try ClaimRecentWindow(recentWindow()), aged = try candidate(previous, index: 599)
        aged.progress.captures = 2; aged.progress.prepared = ["challenge": "old-location"]
        let known = try ClaimRecentWindow(recentWindow(701)), destination = known.blocks[1], f = WindowFixture(recentWindow(701))
        f.hook = { method, _, count in
            guard method == "getbountychanges", count == 1 else { return nil }
            var added = self.event(aged, "added", 1); added["block_hash"] = destination.hash; added["block_height"] = destination.height
            return ["tip": f.tip, "next_cursor": "relocated", "has_more": false, "changes": [added]]
        }
        let journal = try await f.run(known: known, cursor: "old", loaded: Set(known.order), retained: [aged.key: aged])
        XCTAssertNil(journal.retained[aged.key]); XCTAssertNil(journal.catalog[aged.key])
        XCTAssertFalse(journal.loaded.contains(destination.hash), "An added event is not a complete bounty stream")
        XCTAssertEqual(f.calls.last?.0, "getchaintip")
        var source = aged.bounty; source["block_hash"] = destination.hash; source["block_height"] = destination.height
        var moved = try ClaimCandidate(source, block: destination.hash, fee: 1500, factor: 1_100_000)
        try moved.reuse(aged.progress)
        let complete = try await f.run(known: journal.window, cursor: journal.cursor, rows: journal.catalog,
            loaded: journal.loaded, newBlock: destination.hash, staged: [moved.key: moved], retained: journal.retained)
        XCTAssertEqual(complete.catalog[aged.key]?.block, destination.hash)
        XCTAssertNil(complete.catalog[aged.key]?.progress.prepared)
        XCTAssertEqual(complete.catalog[aged.key]?.progress.captures, 2)
        XCTAssertFalse(ClaimSubmissionRetry.matchesAvailableBounty(complete.catalog[aged.key], captured: aged))
        XCTAssertEqual(aged.progress.prepared?["challenge"] as? String, "old-location")
    }

    func testJournalCannotRelocateRetainedFundingFromAStillCanonicalBlock() async throws {
        let known = try ClaimRecentWindow(recentWindow()), row = try candidate(known), f = WindowFixture()
        f.hook = { method, _, _ in
            guard method == "getbountychanges" else { return nil }
            var added = self.event(row, "added", 1)
            added["block_hash"] = known.blocks[2].hash; added["block_height"] = known.blocks[2].height
            return ["tip": f.tip, "next_cursor": "contradiction", "has_more": false, "changes": [added]]
        }
        await rejects { _ = try await f.run(known: known, cursor: "old", retained: [row.key: row]) }
        XCTAssertEqual(row.block, known.blocks[1].hash)
    }
}
