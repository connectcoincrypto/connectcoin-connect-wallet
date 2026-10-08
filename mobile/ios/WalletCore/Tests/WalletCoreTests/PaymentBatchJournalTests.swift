import Foundation
import XCTest
@testable import WalletCore

final class PaymentBatchJournalTests: XCTestCase {
    enum Failure: Error { case storage, notWritten, unknown }
    struct Fixture {
        let address: String, plan: JSONObject, signed: [JSONObject]
        init(_ count: Int = 3) throws {
            let key = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
            address = try WalletCrypto.encodeAddress(WalletCrypto.fromHex(key)); var signed = [JSONObject](), plans = [JSONObject]()
            for i in 0..<count {
                let parent = String(repeating: "0", count: 63) + String(i + 1, radix: 16)
                let tx: JSONObject = ["version": 2, "locktime": 0, "inputs": [["txid": parent, "vout": 0, "scriptSig": "", "sequence": Int64(0xffff_ffff), "witness": [String(repeating: "00", count: 64)]]], "outputs": [["type": 1, "amount": "1000", "publicKey": key]]]
                signed.append(try ["hex": WalletCrypto.hex(NativeTransactions.serialize(tx)), "txid": NativeTransactions.txid(tx), "fee": "10"])
                plans.append(["total": "1000", "fee": "10", "selected": [["txid": parent, "vout": 0, "amount": "1010", "rawTransaction": "must-not-be-persisted", "secret": "must-not-be-persisted"]]])
            }
            self.signed = signed; plan = ["plans": plans, "requestedTotal": String(count * 1000), "total": String(count * 1000), "fee": String(count * 10), "inputTotal": String(count * 1010), "change": "0"]
        }
        func outpoint(_ i: Int) -> String { String(repeating: "0", count: 63) + String(i + 1, radix: 16) + ":0" }
    }
    final class Store: MobilePaymentBatchStore {
        var saved: JSONObject?, held: JSONObject = [:], events = [String](), writes = 0, reservationWrites = 0
        var failReceipts = Set<Int>(), failFrom = Int.max, failReservation = -1, commitThenFail = false
        func receipt() throws -> JSONObject? { events.append("read-receipt"); return saved }
        func reservations() throws -> JSONObject { events.append("read-reservations"); return held }
        func saveReceipt(_ value: JSONObject) throws {
            events.append("receipt"); writes += 1; let fail = failReceipts.contains(writes) || writes >= failFrom
            if fail && !commitThenFail { throw Failure.storage }; saved = value; if fail { throw Failure.storage }
        }
        func saveReservations(_ value: JSONObject) throws { events.append("reservations"); reservationWrites += 1; if reservationWrites == failReservation { throw Failure.storage }; held = value }
    }
    final class Sender: MobilePaymentBatchSender {
        let fixture: Fixture, store: Store; var calls = 0, failAt = -1, failure: Failure = .unknown, wrongID = false
        init(_ fixture: Fixture, _ store: Store) { self.fixture = fixture; self.store = store }
        func broadcast(_ hex: String) throws -> JSONObject {
            let i = calls; calls += 1; store.events.append("send")
            let receipt = try XCTUnwrap(store.saved), parts = try PJ.objects(receipt["transactions"])
            XCTAssertEqual(try PJ.string(parts[i]["status"]), MobilePaymentBatch.UNKNOWN)
            XCTAssertEqual(try PJ.string(fixture.signed[i]["hex"]), hex)
            for j in fixture.signed.indices { XCTAssertEqual(try PJ.string(parts[j]["hex"]), try PJ.string(fixture.signed[j]["hex"])); XCTAssertEqual(try PJ.string(store.held[fixture.outpoint(j)]), try PJ.string(fixture.signed[j]["txid"])) }
            if i == failAt { if wrongID { return ["txid": String(repeating: "ee", count: 32)] }; throw failure }
            return try ["txid": PJ.string(fixture.signed[i]["txid"])]
        }
        func provenNotSent(_ error: Error) -> Bool { if case Failure.notWritten = error { return true }; return false }
    }
    private func submit(_ f: Fixture, _ store: Store, _ sender: Sender, _ check: () throws -> Void = {}) throws -> JSONObject { try MobilePaymentBatch.submit(f.address, f.address, f.plan, f.signed, store: store, sender: sender, check: check) }
    private func statuses(_ store: Store) throws -> [String] { try PJ.objects(XCTUnwrap(store.saved)["transactions"]).map { try PJ.string($0["status"]) } }
    func testDurableBytesAndReservationsPrecedeEveryNetworkWrite() throws {
        let f = try Fixture(), store = Store(), sender = Sender(f, store), summary = try submit(f, store, sender)
        XCTAssertEqual(try PJ.string(summary["status"]), "submitted"); XCTAssertEqual(sender.calls, 3)
        XCTAssertEqual(try statuses(store), ["submitted", "submitted", "submitted"])
        XCTAssertEqual(store.events, ["read-receipt", "read-reservations", "receipt", "reservations", "receipt", "send", "receipt", "receipt", "send", "receipt", "receipt", "send", "receipt"])
        let summaryText = String(decoding: try JSON.encode(summary), as: UTF8.self)
        XCTAssertFalse(summaryText.contains("hex")); XCTAssertFalse(summaryText.contains("selected"))
        XCTAssertFalse(String(decoding: try JSON.encode(XCTUnwrap(store.saved)), as: UTF8.self).contains("must-not-be-persisted"))
    }
    func testUncertainOrWrongResponseStopsAndReleasesOnlyUnsentTail() throws {
        for wrongID in [false, true] {
            let f = try Fixture(), store = Store(), sender = Sender(f, store); sender.failAt = 1; sender.wrongID = wrongID
            let result = try submit(f, store, sender)
            XCTAssertEqual(try PJ.string(result["status"]), "check-required"); XCTAssertEqual(sender.calls, 2)
            XCTAssertEqual(try statuses(store), ["submitted", "check-required", "not-sent"]); XCTAssertEqual(store.held.count, 2); XCTAssertNil(store.held[f.outpoint(2)])
            XCTAssertThrowsError(try submit(f, store, sender)); XCTAssertEqual(sender.calls, 2)
        }
    }
    func testTransportProofAndCancellationReleaseOnlyProvablyUnsent() throws {
        let f = try Fixture(), store = Store(), sender = Sender(f, store); sender.failAt = 1; sender.failure = .notWritten
        let unrelated = String(repeating: "ff", count: 32) + ":9"; store.held[unrelated] = String(repeating: "ee", count: 32)
        XCTAssertEqual(try PJ.string(submit(f, store, sender)["status"]), "partial"); XCTAssertEqual(try statuses(store), ["submitted", "not-sent", "not-sent"]); XCTAssertEqual(store.held.count, 2); XCTAssertNotNil(store.held[unrelated])
        let cancelled = Store(), unused = Sender(f, cancelled); var checks = 0
        XCTAssertEqual(try PJ.string(submit(f, cancelled, unused) { checks += 1; if checks == 3 { throw Failure.unknown } }["status"]), "not-sent")
        XCTAssertEqual(unused.calls, 0); XCTAssertTrue(cancelled.held.isEmpty)
    }
    func testStorageFailuresNeverPermitUnjournaledWritesOrReleaseUnknownInputs() throws {
        for committed in [false, true] {
            for failedWrite in [2, 3] {
                let f = try Fixture(), store = Store(), sender = Sender(f, store); store.failReceipts = [failedWrite]; store.commitThenFail = committed
                let result = try submit(f, store, sender)
                XCTAssertEqual(try PJ.string(result["status"]), failedWrite == 2 ? "not-sent" : "check-required")
                XCTAssertEqual(sender.calls, failedWrite == 2 ? 0 : 1); XCTAssertEqual(store.held.count, failedWrite == 2 ? 0 : 1)
            }
        }
        for proof in [false, true] {
            let f = try Fixture(), store = Store(), sender = Sender(f, store); store.failFrom = 3
            if proof { sender.failAt = 0; sender.failure = .notWritten }
            XCTAssertEqual(try PJ.string(submit(f, store, sender)["status"]), "check-required"); XCTAssertEqual(sender.calls, 1); XCTAssertEqual(store.held.count, 3)
        }
        for receiptFailure in [false, true] {
            let f = try Fixture(), store = Store(), sender = Sender(f, store)
            if receiptFailure { store.failReceipts = [1] } else { store.failReservation = 1 }
            XCTAssertThrowsError(try submit(f, store, sender)); XCTAssertEqual(sender.calls, 0)
        }
    }
    func testCrashReconciliationAndAcknowledgementPreserveUnknownAndNewOwners() throws {
        let f = try Fixture(); var receipt = try MobilePaymentBatch.create(f.address, f.address, f.plan, f.signed), parts = try PJ.objects(receipt["transactions"])
        parts[0]["status"] = "submitted"; parts[1]["status"] = "check-required"; receipt["transactions"] = parts
        let recovered = try MobilePaymentBatch.read(JSON.encode(receipt)); var held: JSONObject = [:]
        for (i, part) in parts.enumerated() { held[f.outpoint(i)] = try PJ.string(part["txid"]) }
        let reconciled = try MobilePaymentBatch.reconcileNotSent(recovered, held); XCTAssertEqual(reconciled.count, 2); XCTAssertNil(reconciled[f.outpoint(2)]); XCTAssertEqual(held.count, 3)
        held[f.outpoint(2)] = String(repeating: "ee", count: 32); XCTAssertEqual(try MobilePaymentBatch.reconcileNotSent(recovered, held).count, 3)
        let acknowledged = try MobilePaymentBatch.acknowledge(recovered, PJ.string(recovered["batchId"]))
        XCTAssertNil(try MobilePaymentBatch.pendingSummary(acknowledged)); XCTAssertNotNil(try MobilePaymentBatch.pendingSummary(recovered))
        XCTAssertThrowsError(try MobilePaymentBatch.acknowledge(recovered, "wrong"))
        XCTAssertThrowsError(try MobilePaymentBatch.read(Data([0xc3, 0x28])))
    }
    func testTamperedSignedBytesTotalsAndJournalOrderFailClosed() throws {
        let f = try Fixture(), receipt = try MobilePaymentBatch.create(f.address, f.address, f.plan, f.signed)
        for field in ["fee", "total", "walletId", "secret"] { var corrupt = receipt; corrupt[field] = "1"; XCTAssertThrowsError(try MobilePaymentBatch.validate(corrupt)) }
        var corrupt = receipt, parts = try PJ.objects(receipt["transactions"]); parts[1]["status"] = "submitted"; corrupt["transactions"] = parts
        XCTAssertThrowsError(try MobilePaymentBatch.validate(corrupt))
        parts = try PJ.objects(receipt["transactions"]); parts[0]["hex"] = try PJ.string(parts[0]["hex"]) + "00"; corrupt["transactions"] = parts
        XCTAssertThrowsError(try MobilePaymentBatch.validate(corrupt))
        let store = Store(), sender = Sender(f, store); store.held[f.outpoint(1)] = String(repeating: "ee", count: 32)
        XCTAssertThrowsError(try submit(f, store, sender)); XCTAssertEqual(store.writes, 0); XCTAssertEqual(sender.calls, 0)
    }
}
