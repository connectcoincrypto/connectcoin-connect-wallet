import XCTest
@testable import WalletCore

final class MobileClaimsEngineTests: XCTestCase {
    private let address = "cc1p4t449ht5jnpkzpyaue7vdq8g867th0d7kymr0kfvmpzlwqcg4a0qc59p3e"
    private let txid = String(repeating: "ab", count: 32)
    private func location() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claims-tests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appendingPathComponent("receipt.json")
    }

    func testPendingOrUnknownReceiptNeverRestartsClaims() async throws {
        for status in ["pending", "unknown"] {
            let url = try location()
            try ClaimsPublicStore.write(["txid": txid, "status": status], to: url)
            let rpc = MobileRpcClient(); defer { rpc.close() }
            let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            await engine.setActive(true)
            do { try await engine.start(address: address); XCTFail("Indeterminate submission restarted") }
            catch let error as WalletError { XCTAssertEqual(error.message, "CLAIMS_UNKNOWN_OUTCOME") }
            let state = await engine.state()
            XCTAssertEqual(state["running"] as? Bool, false)
            XCTAssertEqual(state["receiptTxid"] as? String, txid)
            XCTAssertEqual(state["receiptStatus"] as? String, status)
            XCTAssertEqual(state["unknown"] as? Int64, 1)
            XCTAssertEqual(state["nativeBackgroundAvailable"] as? Bool, false)
            await engine.close()
        }
    }

    func testMalformedOrOversizedReceiptFailsClosed() async throws {
        for contents in [Data("{}".utf8), Data(repeating: 32, count: ClaimsPublicStore.maximumBytes + 1)] {
            let url = try location(); try contents.write(to: url)
            let rpc = MobileRpcClient(); defer { rpc.close() }
            let engine = MobileClaimsEngine(rpc: rpc, receiptURL: url)
            await engine.setActive(true)
            do { try await engine.start(address: address); XCTFail("Invalid receipt restarted") }
            catch let error as WalletError { XCTAssertEqual(error.message, "CLAIMS_RECEIPT_UNAVAILABLE") }
            await engine.close()
        }
    }

    func testDurablePolicyRestoresLimitsAndCannotEnableBackground() async throws {
        let url = try location(), rpc = MobileRpcClient(); defer { rpc.close() }
        let first = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        await first.setActive(true)
        _ = try await first.policy(["allowMobileData": true, "allowBackground": false])
        _ = try await first.limits(["connectionsPerSecondLimit": 17, "concurrency": 4])
        do { _ = try await first.policy(["allowMobileData": true, "allowBackground": true]); XCTFail("Background enabled") } catch {}
        await first.close()
        let restored = MobileClaimsEngine(rpc: rpc, receiptURL: url)
        let state = await restored.state()
        XCTAssertEqual(state["connectionsPerSecondLimit"] as? Int, 17)
        XCTAssertEqual(state["concurrency"] as? Int, 4)
        XCTAssertEqual(state["allowMobileData"] as? Bool, true)
        XCTAssertEqual(state["allowBackground"] as? Bool, false)
        XCTAssertEqual(state["requested"] as? Bool, false)
        do { try await restored.start(address: address); XCTFail("Background start succeeded") } catch {}
        await restored.close()
    }

    func testReceiptStoreRejectsSymlinkAndLeavesNoTemporaryFiles() throws {
        let url = try location()
        try ClaimsPublicStore.write(["txid": txid, "status": "pending"], to: url)
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "pending")
        try ClaimsPublicStore.write(["txid": txid, "status": "submitted"], to: url)
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "submitted")
        let directory = url.deletingLastPathComponent()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["receipt.json"])
        let link = directory.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: url)
        XCTAssertThrowsError(try ClaimsPublicStore.read(link))
        XCTAssertThrowsError(try ClaimsPublicStore.write(["oversized": String(repeating: "x", count: 4096)], to: url))
        XCTAssertEqual(try ClaimsPublicStore.read(url)["status"] as? String, "submitted")
    }
}
