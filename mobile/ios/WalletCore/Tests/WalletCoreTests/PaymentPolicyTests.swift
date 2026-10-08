import Foundation
import XCTest
@testable import WalletCore

final class PaymentPolicyTests: XCTestCase {
    private func fixture() throws -> JSONObject { try PaymentVectors.fixture() }
    private func change() throws -> String { try PJ.string(fixture()["changeAddress"]) }
    private func candidates(_ count: Int) -> [JSONObject] {
        (0..<count).map { ["txid": String(repeating: "12", count: 32), "vout": $0, "amount": "1000000", "index": 0, "change": 0, "mature": true, "status": "confirmed", "pending_spent_by": NSNull()] }
    }
    private func request(_ amount: Int64, _ deduct: Bool = true, _ all: Bool = true, _ rate: String = "1500") throws -> NativeSendPolicy.Request {
        try NativeSendPolicy.request(["address": PJ.string(PJ.objects(fixture()["outputs"])[0]["address"]), "amount": NativeTransactions.format(amount), "feeRate": rate, "subtractFeeFromAmount": deduct, "useAllBalance": all])
    }
    private func assertBatch(_ request: NativeSendPolicy.Request, _ funding: [JSONObject]) throws -> JSONObject {
        let batch = try NativeSendBatch.plan(request, funding, change()); try NativeSendBatch.verify(request, batch, change())
        let plans = try PJ.objects(batch["plans"]); var seen = Set<String>(); var fee: Int64 = 0, received: Int64 = 0, input: Int64 = 0, returned: Int64 = 0
        for (i, part) in plans.enumerated() {
            let tx = try PJ.object(part["transaction"]), weight = try NativeTransactions.serialize(tx, false).count * 3 + NativeTransactions.serialize(tx, true).count
            XCTAssertLessThanOrEqual(weight, NativeTransactions.MAX_WEIGHT); XCTAssertEqual((weight + 3) / 4, Int(try PJ.integer(part["vsize"])))
            XCTAssertGreaterThanOrEqual(try PJ.money(part, "fee"), Int64((weight + 3) / 4) * Int64(request.feeRate))
            if i < plans.count - 1 { XCTAssertEqual(try PJ.string(part["change"]), "0") }
            for row in try PJ.objects(part["selected"]) { XCTAssertTrue(try seen.insert(PJ.outpoint(row)).inserted) }
            fee += try PJ.money(part, "fee"); received += try PJ.money(part, "total"); input += try PJ.money(part, "inputTotal"); returned += try PJ.money(part, "change")
        }
        XCTAssertEqual(input, received + fee + returned); XCTAssertEqual(fee, try PJ.money(batch, "fee")); XCTAssertEqual(received, try PJ.money(batch, "total"))
        if request.useAllBalance { XCTAssertEqual(seen.count, funding.count); XCTAssertEqual(returned, 0) }; return batch
    }
    func testCompactSizeAndStandardWeightBoundariesMatchAndroid() throws {
        for (count, vsize) in [(252, 14542), (253, 14601), (254, 14659), (1738, 99989)] {
            let intent = try request(Int64(count) * 1_000_000), plan = try intent.plan(candidates(count), change())
            try intent.verifyPlan(plan, change()); XCTAssertEqual(try PJ.integer(plan["vsize"]), Int64(vsize)); XCTAssertEqual(try PJ.string(plan["change"]), "0")
        }
        XCTAssertThrowsError(try request(1_739_000_000).plan(candidates(1739), change())) { XCTAssertTrue($0 is NativeTransactions.PaymentTooLarge) }
        XCTAssertThrowsError(try request(1_737_500_000, true, false).plan(candidates(1738), change())) { XCTAssertTrue($0 is NativeTransactions.PaymentTooLarge) }
    }
    func testIndependentSplitAndTinyTailRebalancing() throws {
        XCTAssertEqual(try PJ.integer(assertBatch(request(1_739_000_000), candidates(1739))["transactionCount"]), 2)
        let added = try assertBatch(request(3_600_000_000, false, false), candidates(4000)); XCTAssertEqual(try PJ.integer(added["transactionCount"]), 3); XCTAssertEqual(try PJ.string(added["total"]), "3600000000")
        var tinyTail = candidates(2238); for i in 1738..<tinyTail.count { tinyTail[i]["amount"] = "100" }
        let batch = try assertBatch(request(1_738_050_000), tinyTail), parts = try PJ.objects(batch["plans"])
        XCTAssertEqual(parts.count, 2); XCTAssertLessThan(try PJ.objects(parts[0]["selected"]).count, 1738); XCTAssertGreaterThan(try PJ.objects(parts[1]["selected"]).count, 500)
    }
    func testCandidateCeilingAndFeeCeiling() throws {
        let small = try request(500_000, false, false).plan(candidates(50_000), change()); XCTAssertEqual(try PJ.objects(small["selected"]).count, 1)
        XCTAssertThrowsError(try request(500_000, false, false).plan(candidates(50_001), change()))
        var high = candidates(1739); for i in high.indices { high[i]["amount"] = "100000000" }
        XCTAssertThrowsError(try NativeSendBatch.plan(request(173_900_000_000, true, true, "100000"), high, change()))
    }
    func testUseAllReservationFreshnessAndTamperRejection() throws {
        let intent = try request(1_739_000_000), original = try assertBatch(intent, candidates(1739))
        for field in ["fee", "total", "requestedTotal", "inputTotal", "change", "transactionCount"] {
            var altered = original; altered[field] = "1"; XCTAssertThrowsError(try NativeSendBatch.verify(intent, altered, change()), field)
        }
        for field in ["status", "mature", "pending_spent_by"] {
            var funding = candidates(1739)
            if field == "status" { funding[1738][field] = "pending" } else if field == "mature" { funding[1738][field] = false } else { funding[1738][field] = String(repeating: "ab", count: 32) }
            XCTAssertThrowsError(try NativeSendBatch.plan(request(1_739_000_000, true, false), funding, change()))
            XCTAssertThrowsError(try intent.plan(funding, change()))
        }
        var duplicate = candidates(2); duplicate[0]["txid"] = String(repeating: "ab", count: 32); duplicate[1]["txid"] = String(repeating: "AB", count: 32); duplicate[1]["vout"] = 0
        XCTAssertThrowsError(try request(500_000, true, false).plan(duplicate, change()))
    }
    func testP2CIntentIsStrictAndProbeOnlyNarrowsVerifiedRSA() throws {
        let request = try NativeP2CPolicy.request(["domain": " Example.COM ", "amount": "1", "expectedConnections": "3"])
        XCTAssertEqual(request.domain, "example.com"); XCTAssertEqual(request.signatureMask, 7); XCTAssertEqual(request.withProbe("verified").signatureMask, 6); XCTAssertEqual(request.withProbe("attacker").signatureMask, 7)
        for domain in ["https://example.com", "127.0.0.1", "example.local", "foo.home.arpa", "éxample.com", "a..com"] { XCTAssertThrowsError(try NativeP2CPolicy.request(["domain": domain, "amount": "1", "expectedConnections": "1"])) }
        XCTAssertThrowsError(try NativeP2CPolicy.request(["domain": "example.com", "amount": "1", "expectedConnections": "1", "mask": 6]))
    }
    func testReservationsSurviveReplacementAndReleaseOnlyExactOwner() throws {
        let key = String(repeating: "12", count: 32) + ":0", older = String(repeating: "ab", count: 32), new = String(repeating: "cd", count: 32), newest = String(repeating: "ef", count: 32)
        let before: JSONObject = [key: older], held = try NativePaymentReservations.reserve(before, candidates(1), new)
        XCTAssertEqual(try PJ.string(held[key]), new)
        XCTAssertEqual(try PJ.string(NativePaymentReservations.releaseNotSent(held, new, before)[key]), older)
        XCTAssertEqual(try PJ.string(NativePaymentReservations.releaseNotSent([key: newest], new, before)[key]), newest)
        XCTAssertThrowsError(try NativePaymentReservations.read(Data([0xc3, 0x28])))
        XCTAssertThrowsError(try NativePaymentReservations.read(Data("{\"\(key)\":\"\(older)\",\"\(key)\":\"\(new)\"}".utf8)))
        XCTAssertThrowsError(try NativePaymentReservations.validate([String(repeating: "12", count: 32) + ":4294967296": new]))
    }
}
