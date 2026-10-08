import Foundation
import XCTest
@testable import WalletCore

final class PaymentTransactionsTests: XCTestCase {
    private let mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    func testExactAmountsAndBountyTargetBoundaries() throws {
        XCTAssertEqual(try NativeTransactions.coinAmount("0.0000000001"), 1)
        XCTAssertEqual(try NativeTransactions.format(10_000_000_001), "1.0000000001")
        XCTAssertEqual(try NativeTransactions.coinAmount("100000000"), NativeTransactions.MAX_MONEY)
        for invalid in ["-1", "1e3", "0.00000000001", "100000001", "01", "Infinity", "NaN", ".1", "1."] { XCTAssertThrowsError(try NativeTransactions.coinAmount(invalid), invalid) }
        XCTAssertThrowsError(try NativeTransactions.amount("1000000000000000001"))
        XCTAssertEqual(try PaymentTarget.target("1"), String(repeating: "f", count: 64))
        XCTAssertEqual(try PaymentTarget.target("2"), "7" + String(repeating: "f", count: 63))
        XCTAssertEqual(try PaymentTarget.target("3"), String(repeating: "5", count: 63) + "4")
        XCTAssertEqual(try PaymentTarget.target(PaymentTarget.maximum), String(repeating: "0", count: 64))
        for invalid in ["0", "01", "1e3", "-1", PaymentTarget.maximum + "0", "115792089237316195423570985008687907853269984665640564039457584007913129639937"] { XCTAssertThrowsError(try PaymentTarget.target(invalid)) }
    }
    func testWireNativeSighashAndSignaturesMatchDesktopAndAndroid() throws {
        let f = try PaymentVectors.fixture(), candidate = try PJ.object(f["candidate"]), parent = try NativeTransactions.parse(PJ.string(candidate["rawTransaction"]))
        XCTAssertEqual(try WalletCrypto.hex(NativeTransactions.serialize(parent)), try PJ.string(candidate["rawTransaction"]))
        XCTAssertEqual(try NativeTransactions.txid(parent), try PJ.string(candidate["txid"]))
        for kind in ["payment", "deduct"] {
            let expected = try PJ.object(f[kind]), tx = try NativeTransactions.parse(PJ.string(expected["hex"]))
            XCTAssertEqual(try WalletCrypto.hex(NativeTransactions.serialize(tx)), try PJ.string(expected["hex"]))
            XCTAssertEqual(try NativeTransactions.txid(tx), try PJ.string(expected["txid"]))
            XCTAssertEqual(try NativeTransactions.vsize(tx), Int(try PJ.integer(expected["vsize"])))
            let digest = try NativeTransactions.signatureHash(tx, PJ.objects(parent["outputs"]), 0)
            XCTAssertEqual(WalletCrypto.hex(digest), try PJ.string(expected["sighash"]))
            let witness = try PJ.array(PJ.objects(tx["inputs"])[0]["witness"])
            XCTAssertTrue(try WalletCrypto.verifySchnorr(WalletCrypto.fromHex(PJ.string(witness[0])), digest, WalletCrypto.fromHex(PJ.string(f["publicKey"]))))
        }
    }
    func testNativePlanningSigningAndDeductionMatchGoldenVectors() throws {
        let f = try PaymentVectors.fixture(), session = try VaultSession(mnemonic: mnemonic, passphrase: "")
        defer { session.lock() }
        for deduct in [false, true] {
            let plan = try NativeTransactions.planPayment([PJ.object(f["candidate"])], PJ.objects(f["outputs"]), PJ.string(f["changeAddress"]), 1500, deduct)
            let expected = try PJ.object(f[deduct ? "deduct" : "payment"])
            for key in ["fee", "total", "change", "vsize"] { XCTAssertTrue(PJ.equal(plan[key], expected[key]), key) }
            let signed = try NativeTransactions.signPayment(plan, session), tx = try NativeTransactions.parse(PJ.string(signed["hex"]))
            XCTAssertEqual(try PJ.string(signed["txid"]), try PJ.string(expected["txid"]))
            let witness = try PJ.array(PJ.objects(tx["inputs"])[0]["witness"])
            XCTAssertTrue(try WalletCrypto.verifySchnorr(WalletCrypto.fromHex(PJ.string(witness[0])), WalletCrypto.fromHex(PJ.string(expected["sighash"])), WalletCrypto.fromHex(PJ.string(f["publicKey"]))))
        }
    }
    func testFundingAuthenticationAndCancelledSigningNeverPublishPartialResults() throws {
        let f = try PaymentVectors.fixture(), candidate = try PJ.object(f["candidate"]), session = try VaultSession(mnemonic: mnemonic, passphrase: "")
        defer { session.lock() }
        XCTAssertEqual(try PJ.string(NativeTransactions.verifyFunding(candidate, PJ.string(f["publicKey"]))["amount"]), try PJ.string(candidate["amount"]))
        for field in ["amount", "txid", "vout", "index", "change", "rawTransaction"] {
            var altered = candidate
            altered[field] = field == "amount" ? "1" : field == "txid" ? String(repeating: "aa", count: 32) : field == "rawTransaction" ? try PJ.string(candidate[field]) + "00" : field == "vout" ? 999 : 1
            var plan = try NativeTransactions.planPayment([candidate], PJ.objects(f["outputs"]), PJ.string(f["changeAddress"]), 1500, false)
            plan["selected"] = [altered]
            XCTAssertThrowsError(try NativeTransactions.signPayment(plan, session), field)
        }
        let plan = try NativeTransactions.planPayment([candidate], PJ.objects(f["outputs"]), PJ.string(f["changeAddress"]), 1500, false), original = try JSON.encode(plan)
        var checks = 0
        XCTAssertThrowsError(try NativeTransactions.signPayment(plan, session) { checks += 1; if checks == 5 { throw WalletError("Cancelled") } })
        XCTAssertEqual(checks, 5); XCTAssertEqual(try JSON.encode(plan), original)
    }
    func testClaimGoldenVectorAndFramingBindings() throws {
        let f = try PaymentVectors.fixture(), expected = try PJ.object(f["claim"])
        let prepared = try NativeTransactions.prepareClaim(PJ.object(f["bounty"]), PJ.string(f["bountyHex"]), PJ.string(f["rewardAddress"]), 1500)
        for key in ["hex", "txid", "challenge", "fee", "payout"] { XCTAssertEqual(try PJ.string(prepared[key]), try PJ.string(expected[key]), key) }
        let attached = try NativeTransactions.attachClaim(prepared, PJ.string(f["proof"]))
        XCTAssertEqual(try PJ.string(attached["hex"]), try PJ.string(PJ.object(f["attached"])["hex"]))
        var proof = try WalletCrypto.fromHex(PJ.string(f["proof"])); proof[7] ^= 1
        XCTAssertThrowsError(try NativeTransactions.attachClaim(prepared, WalletCrypto.hex(proof)))
        XCTAssertThrowsError(try NativeTransactions.attachClaim(prepared, "00"))
        var fake = try PJ.object(f["bounty"]); fake["domain"] = "attacker.example"
        XCTAssertThrowsError(try NativeTransactions.prepareClaim(fake, PJ.string(f["bountyHex"]), PJ.string(f["rewardAddress"]), 1500))
    }
    func testCanonicalWireAndOutpointBounds() throws {
        let parent = try PJ.string(PJ.object(PaymentVectors.fixture()["candidate"])["rawTransaction"])
        for bad in [parent + "00", String(parent.dropLast(2)), "02000000fd0100" + String(parent.dropFirst(10)), "020000000002" + String(parent.dropFirst(8))] { XCTAssertThrowsError(try NativeTransactions.parse(bad)) }
        var duplicate = try NativeTransactions.parse(parent); let inputs = try PJ.objects(duplicate["inputs"]); duplicate["inputs"] = inputs + inputs
        XCTAssertThrowsError(try NativeTransactions.serialize(duplicate))
        XCTAssertEqual(try NativeTransactions.bytes(String(repeating: "00", count: 100_000)).count, 100_000)
        XCTAssertThrowsError(try NativeTransactions.bytes(String(repeating: "00", count: 100_000) + "zz"))
        XCTAssertThrowsError(try NativeTransactions.bytes("f"))
        XCTAssertThrowsError(try PJ.integer(true)); XCTAssertThrowsError(try PJ.integer(1.0)); XCTAssertThrowsError(try PJ.integer("1"))
    }
}
