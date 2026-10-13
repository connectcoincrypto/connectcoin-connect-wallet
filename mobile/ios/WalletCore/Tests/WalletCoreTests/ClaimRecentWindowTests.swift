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
             newBlock: String? = nil, staged: [String: ClaimCandidate] = [:]) async throws -> ClaimDiscoveryReplay {
        try await ClaimDiscoveryReplay.read(known: known, cursor: cursor, catalog: rows, loaded: loaded,
            newBlock: newBlock, staged: staged, query: query)
    }
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
}
