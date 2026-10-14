import Foundation
import XCTest
@testable import WalletCore

final class FundingTransactionCacheTests: XCTestCase {
    private func funded(_ f: JSONObject, _ raw: String) throws -> JSONObject {
        var row = try PJ.object(f["bounty"]); row["rawTransaction"] = raw; return row
    }
    private func witness(_ f: JSONObject, _ value: String) throws -> String {
        var tx = try NativeTransactions.parse(PJ.string(f["bountyHex"])), inputs = try PJ.objects(tx["inputs"])
        inputs[0]["witness"] = [value]; tx["inputs"] = inputs
        return try WalletCrypto.hex(NativeTransactions.serialize(tx))
    }
    func testSiblingsReuseParseButEveryOutputContextAndCallerMutationIsChecked() throws {
        let f = try PaymentVectors.fixture(), cache = NativeTransactions.FundingTransactionCache()
        var tx = try NativeTransactions.parse(PJ.string(f["bountyHex"])), outputs = try PJ.objects(tx["outputs"])
        var other = outputs[0]; other["amount"] = "20000000000"; outputs.append(other); tx["outputs"] = outputs
        let raw = try WalletCrypto.hex(NativeTransactions.serialize(tx)), id = try NativeTransactions.txid(tx), reward = try PJ.string(f["rewardAddress"])
        var first = try PJ.object(f["bounty"]); first["txid"] = id
        var second = first; second["vout"] = 1; second["amount"] = "20000000000"
        var a = try cache.prepareClaim(first, raw, reward, 1500)
        let b = try cache.prepareClaim(second, raw, reward, 1500)
        XCTAssertEqual(cache.parses, 1); XCTAssertNotEqual(try PJ.string(a["challenge"]), try PJ.string(b["challenge"]))
        var changedOutput = try PJ.object(a["bounty"]); changedOutput["domain"] = "attacker.example"; changedOutput["amount"] = "1"; a["bounty"] = changedOutput
        XCTAssertEqual(try PJ.string(PJ.object(cache.prepareClaim(first, raw, reward, 1500)["bounty"])["domain"]), try PJ.string(first["domain"]))
        for field in ["txid", "vout", "amount", "domain", "connection_work_target", "root_certificates_version", "signature_algorithms_mask"] {
            var altered = first
            if field == "txid" || field == "connection_work_target" { altered[field] = String(repeating: "00", count: 32) }
            else if field == "domain" { altered[field] = "attacker.example" }
            else if field == "amount" { altered[field] = "1" }
            else { altered[field] = 999 }
            XCTAssertThrowsError(try cache.prepareClaim(altered, raw, reward, 1500), field)
        }
        XCTAssertThrowsError(try cache.prepareClaim(first, raw, "not-an-address", 1500))
        XCTAssertThrowsError(try cache.prepareClaim(first, raw, reward, 0))
        XCTAssertNotEqual(try PJ.string(a["challenge"]), try PJ.string(cache.prepareClaim(first, raw, reward, 2000)["challenge"]))
        XCTAssertEqual(cache.parses, 1)
        let paid = try PJ.object(f["candidate"]), publicKey = try PJ.string(f["publicKey"])
        var paidOutput = try cache.verifyFunding(paid, publicKey); paidOutput["publicKey"] = String(repeating: "00", count: 32)
        XCTAssertEqual(try PJ.string(cache.verifyFunding(paid, publicKey)["publicKey"]), publicKey)
        XCTAssertThrowsError(try cache.verifyFunding(paid, String(repeating: "00", count: 32)))
    }
    func testExactWitnessKeyAndMalformedSiblingsCannotInheritTxidTrust() throws {
        let f = try PaymentVectors.fixture(), cache = NativeTransactions.FundingTransactionCache()
        let raw = try PJ.string(f["bountyHex"]), alternate = try witness(f, "01")
        XCTAssertEqual(try NativeTransactions.txid(NativeTransactions.parse(raw)), try NativeTransactions.txid(NativeTransactions.parse(alternate)))
        _ = try cache.verifyFunding(funded(f, raw), nil); _ = try cache.verifyFunding(funded(f, alternate), nil)
        XCTAssertEqual(cache.parses, 2); XCTAssertEqual(cache.size, 2)
        for bad in [alternate + "00", String(alternate.dropLast(2))] { XCTAssertThrowsError(try cache.verifyFunding(funded(f, bad), nil)) }
        var tx = try NativeTransactions.parse(raw), outputs = try PJ.objects(tx["outputs"])
        let publicKey = try PJ.string(f["publicKey"])
        outputs.append(["type": 1, "amount": "1", "publicKey": publicKey]); tx["outputs"] = outputs
        let malformed = try WalletCrypto.hex(NativeTransactions.serialize(tx)).replacingOccurrences(of: publicKey, with: String(repeating: "ff", count: 32))
        XCTAssertThrowsError(try cache.verifyFunding(funded(f, malformed), nil))
        XCTAssertEqual(cache.size, 2); _ = try cache.verifyFunding(funded(f, raw), nil); XCTAssertEqual(cache.parses, 2)
    }
    func testLruCountByteBudgetOversizedAndClear() throws {
        let f = try PaymentVectors.fixture(), a = try witness(f, "00"), b = try witness(f, "01"), c = try witness(f, "02")
        let cache = try NativeTransactions.FundingTransactionCache(maxEntries: 2, maxBytes: 16 * 1024 * 1024)
        _ = try cache.verifyFunding(funded(f, a), nil); let one = cache.retainedBytes
        _ = try cache.verifyFunding(funded(f, b), nil); _ = try cache.verifyFunding(funded(f, a), nil); _ = try cache.verifyFunding(funded(f, c), nil)
        XCTAssertEqual(cache.parses, 3); XCTAssertEqual(cache.size, 2)
        _ = try cache.verifyFunding(funded(f, a), nil); XCTAssertEqual(cache.parses, 3)
        _ = try cache.verifyFunding(funded(f, b), nil); XCTAssertEqual(cache.parses, 4)
        let bounded = try NativeTransactions.FundingTransactionCache(maxEntries: 128, maxBytes: one)
        _ = try bounded.verifyFunding(funded(f, a), nil); _ = try bounded.verifyFunding(funded(f, b), nil)
        XCTAssertEqual(bounded.size, 1); XCTAssertEqual(bounded.retainedBytes, one)
        _ = try bounded.verifyFunding(funded(f, witness(f, String(repeating: "00", count: 100))), nil)
        XCTAssertEqual(bounded.size, 1); XCTAssertEqual(bounded.retainedBytes, one)
        let parsed = bounded.parses; _ = try bounded.verifyFunding(funded(f, b), nil); XCTAssertEqual(bounded.parses, parsed)
        let tiny = try NativeTransactions.FundingTransactionCache(maxEntries: 1, maxBytes: 1)
        _ = try tiny.verifyFunding(funded(f, a), nil); _ = try tiny.verifyFunding(funded(f, a), nil)
        XCTAssertEqual(tiny.parses, 2); XCTAssertEqual(tiny.size, 0); XCTAssertEqual(tiny.retainedBytes, 0)
        cache.clear(); XCTAssertEqual(cache.size, 0); XCTAssertEqual(cache.retainedBytes, 0)
        _ = try cache.verifyFunding(funded(f, a), nil); XCTAssertEqual(cache.parses, 5)
        XCTAssertThrowsError(try NativeTransactions.FundingTransactionCache(maxEntries: 129, maxBytes: 1))
        XCTAssertThrowsError(try NativeTransactions.FundingTransactionCache(maxEntries: 1, maxBytes: 16 * 1024 * 1024 + 1))
    }
    func testClearedOrCancelledMissCannotRepopulateAndCancelledHitCannotPublish() throws {
        let f = try PaymentVectors.fixture(), row = try funded(f, PJ.string(f["bountyHex"])), cache = NativeTransactions.FundingTransactionCache()
        var checks = 0
        XCTAssertThrowsError(try cache.verifyFunding(row, nil) {
            checks += 1; if checks == 2 { cache.clear() }
        }) { XCTAssertTrue($0 is CancellationError) }
        XCTAssertEqual(cache.size, 0); XCTAssertEqual(cache.retainedBytes, 0)
        checks = 0
        XCTAssertThrowsError(try cache.verifyFunding(row, nil) {
            checks += 1; if checks == 2 { throw CancellationError() }
        })
        XCTAssertEqual(cache.size, 0)
        _ = try cache.verifyFunding(row, nil)
        XCTAssertThrowsError(try cache.verifyFunding(row, nil) { throw CancellationError() })
        XCTAssertEqual(cache.size, 1)
    }
    func testCachedPreparationStillMatchesGoldenVectors() throws {
        let f = try PaymentVectors.fixture(), cache = NativeTransactions.FundingTransactionCache()
        let prepared = try cache.prepareClaim(PJ.object(f["bounty"]), PJ.string(f["bountyHex"]), PJ.string(f["rewardAddress"]), 1500)
        let expected = try PJ.object(f["claim"])
        for key in ["hex", "txid", "challenge", "fee", "payout"] { XCTAssertEqual(try PJ.string(prepared[key]), try PJ.string(expected[key])) }
        XCTAssertEqual(try PJ.string(NativeTransactions.attachClaim(prepared, PJ.string(f["proof"]))["hex"]), try PJ.string(PJ.object(f["attached"])["hex"]))
    }
}
