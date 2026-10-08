import Foundation
import XCTest
@testable import WalletCore

final class PaymentReceiptTests: XCTestCase {
    private func receipt() throws -> JSONObject {
        let payment = try PJ.object(PaymentVectors.fixture()["payment"])
        return try ["hex": PJ.string(payment["hex"]), "txid": PJ.string(payment["txid"]), "fee": PJ.string(payment["fee"])]
    }
    func testCrashRestoresOnlyAllowlistedPublicOutcome() throws {
        let original = try receipt(), recovered = try MobilePaymentReceipt.read(JSON.encode(original))
        let summary = try MobilePaymentReceipt.summary(recovered)
        XCTAssertEqual(Set(summary.keys), Set(["txid", "status"])); XCTAssertEqual(try PJ.string(summary["status"]), "check-required")
        for status in ["submitted", "check-required", "not-sent"] {
            var value = original; value["broadcast_status"] = status
            XCTAssertEqual(try PJ.string(MobilePaymentReceipt.summary(value)["status"]), status == "not-sent" ? "not-sent" : "check-required")
        }
    }
    func testCorruptOrUnknownSignedRecordsCannotDisappearIntoAnEmptyState() throws {
        let original = try receipt()
        for field in ["txid", "hex", "fee", "broadcast_status", "mnemonic"] {
            var altered = original
            switch field {
            case "txid": altered[field] = String(repeating: "aa", count: 32)
            case "hex": altered[field] = try PJ.string(original[field]) + "00"
            case "fee": altered[field] = String(NativeTransactions.COIN + 1)
            default: altered[field] = "not allowed"
            }
            XCTAssertThrowsError(try MobilePaymentReceipt.read(JSON.encode(altered)), field)
        }
        XCTAssertThrowsError(try MobilePaymentReceipt.read(Data([0xc3, 0x28])))
        XCTAssertThrowsError(try MobilePaymentReceipt.read(Data(repeating: 32, count: MobilePaymentReceipt.MAX_BYTES + 1)))
        var unsigned = try NativeTransactions.parse(PJ.string(original["hex"])), inputs = try PJ.objects(unsigned["inputs"])
        inputs[0]["witness"] = [String](); unsigned["inputs"] = inputs; var changed = original
        changed["hex"] = try WalletCrypto.hex(NativeTransactions.serialize(unsigned))
        XCTAssertThrowsError(try MobilePaymentReceipt.validate(changed))
    }
    func testRuntimeStartupRestoresReceiptAndBlocksMalformedStoredReceipt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("connectwallet-receipt-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try DurableWalletStore(directory: directory), original = try receipt()
        try store.write(.payment, JSON.encode(original))
        let runtime = MobileWalletRuntime(directory: directory), state = try await runtime.publicState()
        XCTAssertEqual(try PJ.string(PJ.object(state["lastPayment"])["txid"]), try PJ.string(original["txid"]))
        XCTAssertEqual(try PJ.string(PJ.object(state["lastPayment"])["status"]), "check-required")
        try store.write(.payment, Data("{\"txid\":\"bad\"}".utf8))
        let corrupt = MobileWalletRuntime(directory: directory)
        let corruptState = try await corrupt.publicState()
        XCTAssertFalse(try PJ.string(corruptState["paymentReceiptError"]).isEmpty)
        XCTAssertEqual(corruptState["locked"] as? Bool, true)
        do { _ = try await corrupt.preparePayment([:]); XCTFail("Malformed receipt must block new payment preparation") }
        catch { XCTAssertTrue(error.localizedDescription.contains("receipt")) }
        do { _ = try await corrupt.confirmPayment(); XCTFail("Malformed receipt must block payment confirmation") }
        catch { XCTAssertTrue(error.localizedDescription.contains("receipt")) }
    }
    func testMalformedSettingsStayVisibleAndRequireExplicitValidSave() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("connectwallet-settings-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try DurableWalletStore(directory: directory)
        try store.write(.settings, Data("{\"autoLockMinutes\":false}".utf8))
        let runtime = MobileWalletRuntime(directory: directory), state = try await runtime.publicState()
        XCTAssertFalse(try PJ.string(state["settingsError"]).isEmpty)
        let configuration = try await runtime.perform("getSettings")
        XCTAssertEqual(try PJ.integer(PJ.object(configuration["settings"])["autoLockMinutes"]), 15)
        await runtime.setActive(true)
        do { try await runtime.unlock(password: "public fixture"); XCTFail("Malformed settings must block unlocking") } catch { XCTAssertTrue(error.localizedDescription.contains("settings")) }
        let corrected: JSONObject = ["theme": "dark", "autoLockMinutes": 5, "rpcHost": "connectcoin4.com", "rpcPort": 48190]
        _ = try await runtime.perform("saveSettings", corrected)
        let repaired = try await runtime.perform("getSettings")
        XCTAssertTrue(PJ.null(repaired["settingsError"])); XCTAssertEqual(try PJ.integer(PJ.object(repaired["settings"])["autoLockMinutes"]), 5)
        await runtime.setActive(false)
    }
}
