import XCTest
@testable import WalletCore

private final class HdIntegrationClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 0
    func now() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ milliseconds: Int) { lock.lock(); value += Double(milliseconds) / 1000; lock.unlock() }
    var environment: HdRetryEnvironment {
        HdRetryEnvironment(now: now, sleep: { self.advance($0); await Task.yield() }, isOnline: { true }, jitter: { 0 })
    }
}

private actor HdRecoveryReader {
    enum Failure { case pageOnce, invalidPage, journalReset, none }
    let target: String, failure: Failure
    let tip: JSONObject = ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS,
                           "hash": String(repeating: "a", count: 64), "height": 123, "mediantime": 1_700_000_000]
    var calls = [String: Int](), pages = [String: Int](), states = [JSONObject]()
    init(_ target: String, _ failure: Failure) { self.target = target; self.failure = failure }
    func read(_ method: String, _ params: JSONObject) throws -> JSONObject {
        calls[method, default: 0] += 1
        if method == "getaddresschanges" {
            return ["tip": tip, "unit": "connects", "changes": [], "next_cursor": "checkpoint.0", "has_more": false, "through_sequence": 0, "journal_epoch": 1]
        }
        XCTAssertEqual(method, "getaddresshistory")
        let address = try params.string("address"), cursor = params["cursor"] as? String ?? "first"
        let key = "\(address):\(cursor)"; pages[key, default: 0] += 1
        if address == target {
            if failure == .invalidPage { return ["address": address, "private_node_detail": "do not publish"] }
            if failure == .journalReset { throw RpcFailure("-32011") }
            if failure == .pageOnce && cursor == "page.2" && pages[key] == 1 { throw RpcFailure("RPC_UNAVAILABLE") }
        }
        return ["tip": tip, "unit": "connects", "live": true, "address": address, "items": [],
                "next_cursor": failure == .pageOnce && address == target && cursor == "first" ? "page.2" as Any : NSNull()]
    }
    func record(_ state: JSONObject) { states.append(state) }
    func captured() -> ([String: Int], [String: Int], [JSONObject]) { (calls, pages, states) }
}

final class HdRecoveryRetryIntegrationTests: XCTestCase {
    private let words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private func fixture(persist: @escaping (JSONObject) throws -> Void = { _ in }) throws -> (NativeHdWallet, VaultSession, NativeVaultUpdateSession) {
        var payload = try WalletVault.newPayload(mnemonic: words); payload["needsRecovery"] = true
        let vault = try WalletVault.createForUpdate(payload, password: "ios-fixture-password")
        let signing = try VaultSession(mnemonic: words, passphrase: "")
        return (try NativeHdWallet(session: signing, vault: vault, persist: persist), signing, vault)
    }
    func testTransientHistoryPageRetainsCursorWatermarkAndValidatedPrefix() async throws {
        let (hd, signing, vault) = try fixture(); defer { signing.lock(); vault.close() }
        let target = try signing.publicAccount(index: 0, change: 0).string("address")
        let reader = HdRecoveryReader(target, .pageOnce), clock = HdIntegrationClock()
        try await hd.recover(reader: { try await reader.read($0, $1) }, environment: clock.environment,
                             progress: { await reader.record($0) })
        let (calls, pages, states) = await reader.captured()
        XCTAssertEqual(calls["getaddresschanges"], 1)
        XCTAssertEqual(calls["getaddresshistory"], 42)
        XCTAssertEqual(pages["\(target):first"], 1)
        XCTAssertEqual(pages["\(target):page.2"], 2)
        let progress = try states.map { try $0.object("hd").integer("scanned") }
        XCTAssertEqual(progress, progress.sorted())
        XCTAssertTrue(progress.contains { $0 > 0 && $0 < 40 })
        XCTAssertTrue(try states.contains { try $0.object("hd").string("recoveryState") == "retrying" })
        for state in states {
            let value = try state.object("hd")
            if try value.string("recoveryState") == "retrying" { XCTAssertTrue(try value.boolean("recovering")) }
        }
        let state = await hd.snapshot(), cache = await hd.recoverySnapshots()
        XCTAssertEqual(try state.object("hd").integer("scanned"), 40)
        XCTAssertEqual(try state.object("hd").string("recoveryState"), "complete")
        XCTAssertFalse(try state.object("hd").boolean("recovering"))
        XCTAssertTrue(try vault.payload().boolean("mobileHdRecovered"))
        XCTAssertEqual(try JSON.object(cache.array("groups")[0]).array("histories").count, 40)
    }
    func testInvalidHistoryAndJournalResetFailWithoutRetryOrReusableSnapshots() async throws {
        for failure in [HdRecoveryReader.Failure.invalidPage, .journalReset] {
            let (hd, signing, vault) = try fixture(); defer { signing.lock(); vault.close() }
            let target = try signing.publicAccount(index: 0, change: 0).string("address")
            let reader = HdRecoveryReader(target, failure), clock = HdIntegrationClock()
            do {
                try await hd.recover(reader: { try await reader.read($0, $1) }, environment: clock.environment, progress: { _ in })
                XCTFail("Invalid recovery must stop")
            } catch { }
            let (_, pages, _) = await reader.captured(), state = await hd.snapshot(), cache = await hd.recoverySnapshots()
            let status = try state.object("hd")
            XCTAssertEqual(pages["\(target):first"], 1)
            XCTAssertEqual(try status.string("recoveryState"), "failed")
            XCTAssertEqual(try status.string("errorCode"), failure == .journalReset ? "HD_RESCAN_REQUIRED" : "HD_INVALID_RESPONSE")
            XCTAssertFalse(try status.string("error").contains("private_node_detail"))
            XCTAssertFalse(try status.boolean("complete"))
            XCTAssertTrue(try cache.array("groups").isEmpty)
        }
    }
    func testFinalSaveFailureNeverPublishesComplete() async throws {
        var writes = 0
        let (hd, signing, vault) = try fixture(persist: { _ in
            writes += 1
            if writes == 2 { throw WalletError("fixture disk failure with private path") }
        })
        defer { signing.lock(); vault.close() }
        let reader = HdRecoveryReader("", .none), clock = HdIntegrationClock()
        do {
            try await hd.recover(reader: { try await reader.read($0, $1) }, environment: clock.environment,
                                 progress: { await reader.record($0) })
            XCTFail("Failed durable save cannot complete")
        } catch { }
        let (_, _, states) = await reader.captured(), state = await hd.snapshot()
        XCTAssertFalse(try states.contains { try $0.object("hd").boolean("complete") })
        XCTAssertEqual(try state.object("hd").string("errorCode"), "HD_STORAGE")
        XCTAssertFalse(try state.object("hd").string("error").contains("private path"))
        XCTAssertTrue(try vault.payload().boolean("needsRecovery"))
        do { try await hd.requireReady(); XCTFail("Sending must remain blocked") } catch { }
    }
}
