import Foundation
import XCTest
@testable import WalletCore

final class PaymentFundingTests: XCTestCase {
    final class Time {
        private let lock = NSLock(); private var value: Int64 = 0
        func now() -> Int64 { lock.lock(); defer { lock.unlock() }; return value }
        func advance(_ ms: Int64) { lock.lock(); value += ms; lock.unlock() }
    }
    private func tip() -> JSONObject { ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS, "height": 121, "hash": String(repeating: "ab", count: 32), "mediantime": 1_700_000_001] }
    private func expectFailure(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected failure", file: file, line: line) } catch { }
    }
    final class Parents {
        var compact = [String: String](), selected = [JSONObject](), requests = [[String]](); let key: String, prefix: Int, proofBytes: Int
        init(_ count: Int, _ outputs: Int = 1, _ prefix: Int = 32, _ proofBytes: Int = 0) throws {
            let f = try PaymentVectors.fixture(); key = try PJ.string(f["publicKey"]); self.prefix = prefix; self.proofBytes = proofBytes
            let base = try PJ.string(PJ.object(f["candidate"])["rawTransaction"])
            for index in 0..<count {
                var transaction = try NativeTransactions.parse(base); transaction["locktime"] = index
                let output = try PJ.objects(transaction["outputs"])[0]; transaction["outputs"] = Array(repeating: output, count: outputs)
                let id = try NativeTransactions.txid(transaction); compact[id] = try WalletCrypto.hex(NativeTransactions.serialize(transaction, false))
                for vout in 0..<outputs { selected.append(try ["txid": id, "vout": vout, "amount": PJ.string(output["amount"]), "index": 0, "change": 0]) }
            }
        }
        func read(_ method: String, _ params: JSONObject) throws -> JSONObject {
            XCTAssertEqual(method, "gettransactions"); let ids = try PJ.array(params["txids"]).map { try PJ.string($0) }; requests.append(ids); XCTAssertLessThanOrEqual(ids.count, 32)
            var transactions = [JSONObject](), remaining = [String]()
            for (i, id) in ids.enumerated() {
                if i >= prefix { remaining.append(id); continue }; var raw = try XCTUnwrap(compact[id])
                if proofBytes > 0 { var tx = try NativeTransactions.parse(raw), inputs = try PJ.objects(tx["inputs"]); inputs[0]["witness"] = ["02" + String(repeating: "00", count: proofBytes - 1)]; tx["inputs"] = inputs; raw = try WalletCrypto.hex(NativeTransactions.serialize(tx)) }
                transactions.append(["txid": id, "hex": raw])
            }
            return ["tip": ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS, "height": 121, "hash": String(repeating: "ab", count: 32), "mediantime": 1_700_000_001], "transactions": transactions, "remaining": remaining]
        }
    }
    func testPartialResponsesCacheStrippedParentsAndReauthenticateAllOutputs() async throws {
        let parents = try Parents(7, 2, 3, NativeTransactions.MAX_PROOF), funding = try MobilePaymentFunding()
        let session = funding.session(reader: { try parents.read($0, $1) }, check: {}, progress: { _, _, _, _ in })
        let loaded = try await funding.load(parents.selected, parents.key, session)
        XCTAssertEqual(loaded.count, 14); XCTAssertEqual(parents.requests.count, 3); XCTAssertEqual(funding.cachedCount, 7)
        XCTAssertLessThan(funding.cachedCharacters, 5000); XCTAssertNil(parents.selected[0]["rawTransaction"])
        for row in loaded { XCTAssertEqual(try PJ.string(row["rawTransaction"]), parents.compact[try PJ.string(row["txid"])]) }
        _ = try await funding.load(parents.selected, parents.key, session); XCTAssertEqual(parents.requests.count, 3)
        var changed = parents.selected; changed[5]["amount"] = "1"
        await expectFailure { _ = try await funding.load(changed, parents.key, session) }; XCTAssertEqual(parents.requests.count, 3)
        changed = parents.selected; changed[5]["vout"] = 99
        await expectFailure { _ = try await funding.load(changed, parents.key, session) }
        XCTAssertEqual(funding.cachedCount, 7)
    }
    func testQuotaAndCapacityRetryShareOneBoundedCancellableDeadline() async throws {
        let time = Time(), funding = try MobilePaymentFunding(clock: time.now, sleeper: { time.advance($0) }); var calls = 0, waits = [Int64]()
        let session = funding.session(reader: { _, _ in calls += 1; if calls == 1 { var error = RpcFailure("-32029"); error.retryAfterMs = 0; throw error }; return [:] }, check: {}, progress: { stage, _, _, delay in if stage == "waiting" { waits.append(delay) } })
        _ = try await session.read("getchaintip", [:], "outputs", 0, 1)
        XCTAssertEqual(calls, 2); XCTAssertEqual(time.now(), 60_000); XCTAssertEqual(waits.first, 60_000)
        time.advance(MobilePaymentFunding.MAX_PREPARATION_MS)
        await expectFailure { _ = try await session.read("getchaintip", [:], "outputs", 0, 1) }; XCTAssertEqual(calls, 2)
        let cancelledTime = Time(), cancelledFunding = try MobilePaymentFunding(clock: cancelledTime.now, sleeper: { cancelledTime.advance($0) })
        let cancelled = cancelledFunding.session(reader: { _, _ in throw RpcFailure("-32029") }, check: { if cancelledTime.now() >= 100 { throw CancellationError() } }, progress: { _, _, _, _ in })
        await expectFailure { _ = try await cancelled.read("gettransactions", [:], "funding", 0, 1) }; XCTAssertEqual(cancelledTime.now(), 100)
    }
    func testMalformedEntireBatchNeverPopulatesCacheAndWritesCannotUsePreparation() async throws {
        let parents = try Parents(2), funding = try MobilePaymentFunding()
        for alteration in ["network", "trailing", "id", "remaining"] {
            let session = funding.session(reader: { method, params in
                var response = try parents.read(method, params)
                if alteration == "network" { var tip = try PJ.object(response["tip"]); tip["genesis_hash"] = String(repeating: "00", count: 32); response["tip"] = tip }
                else if alteration == "remaining" { response["remaining"] = [String(repeating: "00", count: 32)] }
                else { var rows = try PJ.objects(response["transactions"]); if alteration == "id" { rows[1]["txid"] = String(repeating: "00", count: 32) } else { rows[1]["hex"] = try PJ.string(rows[1]["hex"]) + "00" }; response["transactions"] = rows }
                return response
            }, check: {}, progress: { _, _, _, _ in })
            await expectFailure { _ = try await funding.load(parents.selected, parents.key, session) }; XCTAssertEqual(funding.cachedCount, 0)
            await expectFailure { _ = try await session.read("sendrawtransaction", [:], "funding", 0, 1) }
        }
    }
    func testCacheLRUEvictionNeverChangesCurrentSelection() async throws {
        let parents = try Parents(3), funding = try MobilePaymentFunding(maxEntries: 2, maxCharacters: 10_000)
        let session = funding.session(reader: { try parents.read($0, $1) }, check: {}, progress: { _, _, _, _ in })
        let loaded = try await funding.load(parents.selected, parents.key, session); XCTAssertEqual(loaded.count, 3); XCTAssertEqual(funding.cachedCount, 2)
        _ = try await funding.load([parents.selected[0]], parents.key, session); XCTAssertEqual(parents.requests.count, 2)
    }
    func testPreparationCapturesWatermarkBeforeBaselineAndReplaysJournal() async throws {
        let f = try PaymentVectors.fixture(), account = try VaultSession(mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", passphrase: "").publicAccount(index: 0, change: 0), address = try PJ.string(account["address"])
        let candidate = try PJ.object(f["candidate"]), anchor = tip(); var requests = [String]()
        let row: JSONObject = try ["txid": PJ.string(candidate["txid"]), "vout": 0, "amount": PJ.string(candidate["amount"]), "block_height": 100, "status": "confirmed", "confirmations": 22, "coinbase": false, "mature": true, "pending_spent_by": NSNull()]
        let funding = try MobilePaymentFunding(), session = funding.session(reader: { method, params in
            requests.append(method)
            if method == "getaddressutxos" { return ["address": address, "tip": anchor, "unit": "connects", "live": true, "items": [row], "next_cursor": NSNull()] }
            return ["tip": anchor, "unit": "connects", "changes": [Any](), "next_cursor": "valid.cursor", "has_more": false, "through_sequence": 10, "journal_epoch": 1]
        }, check: {}, progress: { _, _, _, _ in })
        let inventory = try await MobilePaymentPreparation.inventory(address, [:], session)
        XCTAssertEqual(requests, ["getaddresschanges", "getaddressutxos", "getaddresschanges"])
        let candidates = try inventory.candidates(); XCTAssertEqual(candidates.count, 1); try inventory.verifySelected(candidates, true, PJ.string(candidate["amount"]))
        let refreshed = try await MobilePaymentPreparation.refresh(inventory, [try PJ.outpoint(candidate): String(repeating: "ef", count: 32)], session)
        XCTAssertTrue(try refreshed.candidates().isEmpty); XCTAssertEqual(try refreshed.pendingCandidates().count, 1); XCTAssertEqual(requests.last, "getaddresschanges")
    }
}
