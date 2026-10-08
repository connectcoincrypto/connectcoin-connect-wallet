import XCTest
@testable import WalletCore

private final class HdWire: RpcWire {
    var queue: DispatchQueue!, receive: ((Data) -> Void)?
    let positive: String?, legacy: Bool
    let tip: JSONObject = ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS,
                           "hash": String(repeating: "a", count: 64), "height": 123, "mediantime": 1_700_000_000]
    let lock = NSLock()
    var counts: [String: Int] = [:]
    init(positive: String? = nil, legacy: Bool = false) { self.positive = positive; self.legacy = legacy }
    func start(queue: DispatchQueue, ready: @escaping () -> Void, receive: @escaping (Data) -> Void, failed: @escaping () -> Void) {
        self.queue = queue; self.receive = receive; queue.async { ready() }
    }
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void) {
        do {
            let request = try JSON.decode(bytes), method = try request.string("method"), params = try request.object("params")
            lock.lock(); counts[method, default: 0] += 1; lock.unlock()
            var response: JSONObject = ["jsonrpc": "2.0", "id": try request.string("id")]
            if method == "getaddresschanges" {
                if legacy { response["error"] = ["code": -32601, "message": "method unavailable"] }
                else { response["result"] = ["tip": tip, "unit": "connects", "changes": [], "next_cursor": "checkpoint.0", "has_more": false, "through_sequence": 0, "journal_epoch": 1] as JSONObject }
            } else if method == "getaddresshistory" {
                let address = try params.string("address")
                let items: [JSONObject] = address == positive ? [["txid": String(repeating: "b", count: 64), "status": "confirmed", "block_height": 123,
                    "block_hash": String(repeating: "a", count: 64), "confirmations": 1, "received": "10000000000", "spent": "0", "balance_delta": "10000000000"]] : []
                response["result"] = ["tip": tip, "unit": "connects", "live": true, "address": address, "items": items, "next_cursor": NSNull()] as JSONObject
            } else { throw WalletError("Unexpected HD fixture method") }
            var frame = try JSON.encode(response); frame.append(10)
            queue.async { self.receive?(frame); completed(true) }
        } catch { completed(false) }
    }
    func cancel() {}
    func count(_ method: String) -> Int { lock.lock(); defer { lock.unlock() }; return counts[method] ?? 0 }
}

final class HdWalletTests: XCTestCase {
    private let words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private func fixture() throws -> (NativeHdWallet, VaultSession, NativeVaultUpdateSession) {
        var payload = try WalletVault.newPayload(mnemonic: words); payload["needsRecovery"] = true
        let vault = try WalletVault.createForUpdate(payload, password: "ios-fixture-password")
        let session = try VaultSession(mnemonic: words, passphrase: "")
        return (try NativeHdWallet(session: session, vault: vault, persist: { _ in }), session, vault)
    }
    func testEmptyDiscoveryChecksBothBranchesOnceAndReusesFirstPages() async throws {
        let (hd, signing, vault) = try fixture(); defer { signing.lock(); vault.close() }
        let wire = HdWire(), rpc = MobileRpcClient(factory: { wire }); rpc.setActive(true); defer { rpc.close() }
        try await hd.recover(reader: { try await rpc.call($0, $1) }, environment: HdRetryEnvironment(isOnline: { true }, jitter: { 0 }), progress: { _ in })
        let state = await hd.snapshot(), groups = await hd.recoverySnapshots()
        XCTAssertEqual(try state.object("hd").boolean("complete"), true)
        XCTAssertEqual(try state.array("accounts").count, 40)
        XCTAssertEqual(wire.count("getaddresshistory"), 40)
        XCTAssertEqual(wire.count("getaddresschanges"), 1)
        XCTAssertEqual(try JSON.object(groups.array("groups")[0]).array("histories").count, 40)
        try await hd.recover(reader: { try await rpc.call($0, $1) }, environment: HdRetryEnvironment(isOnline: { true }, jitter: { 0 }), progress: { _ in })
        XCTAssertEqual(wire.count("getaddresshistory"), 40)
    }
    func testUsedFirstAddressExtendsGapWithoutRescanningPrefix() async throws {
        let (hd, signing, vault) = try fixture(); defer { signing.lock(); vault.close() }
        let first = try signing.publicAccount(index: 0, change: 0).string("address")
        let wire = HdWire(positive: first), rpc = MobileRpcClient(factory: { wire }); rpc.setActive(true); defer { rpc.close() }
        try await hd.recover(reader: { try await rpc.call($0, $1) }, environment: HdRetryEnvironment(isOnline: { true }, jitter: { 0 }), progress: { _ in })
        let state = await hd.snapshot()
        XCTAssertEqual(try state.object("hd").integer("lastUsedReceive"), 0)
        XCTAssertEqual(try state.object("hd").integer("receiveIndex"), 1)
        XCTAssertEqual(try state.array("accounts").count, 41)
        XCTAssertEqual(wire.count("getaddresshistory"), 41)
    }
    func testLegacyServerDiscoveryRemainsCompleteButHasNoReusableCheckpoint() async throws {
        let (hd, signing, vault) = try fixture(); defer { signing.lock(); vault.close() }
        let wire = HdWire(legacy: true), rpc = MobileRpcClient(factory: { wire }); rpc.setActive(true); defer { rpc.close() }
        try await hd.recover(reader: { try await rpc.call($0, $1) }, environment: HdRetryEnvironment(isOnline: { true }, jitter: { 0 }), progress: { _ in })
        let state = await hd.snapshot(), cache = await hd.recoverySnapshots()
        XCTAssertEqual(try state.object("hd").boolean("complete"), true)
        XCTAssertTrue(try cache.array("groups").isEmpty)
        XCTAssertEqual(wire.count("getaddresschanges"), 1)
    }
    func testHistoryRejectsMalformedMonetaryAndConfirmationData() throws {
        let address = try WalletCrypto.encodeAddress(WalletCrypto.fromHex("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"))
        var row: JSONObject = ["txid": String(repeating: "b", count: 64), "status": "confirmed", "block_height": 123, "block_hash": String(repeating: "a", count: 64), "confirmations": 1, "received": "100", "spent": "30", "balance_delta": "70"]
        func page(_ row: JSONObject) -> JSONObject { ["tip": ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS, "hash": String(repeating: "a", count: 64), "height": 123, "mediantime": 0], "address": address, "unit": "connects", "live": true, "items": [row], "next_cursor": NSNull()] }
        XCTAssertTrue(try NativeHdWallet.historyUsed(page(row), address))
        row["balance_delta"] = "71"; XCTAssertThrowsError(try NativeHdWallet.historyUsed(page(row), address))
        row["balance_delta"] = "70"; row["confirmations"] = 2; XCTAssertThrowsError(try NativeHdWallet.historyUsed(page(row), address))
    }

    func testFailedRangeExtensionPersistsRecoveryRequirement() async throws {
        var payload = try WalletVault.newPayload(mnemonic: words)
        payload["needsRecovery"] = false; payload["mobileHdRecovered"] = true; payload["scanLookahead"] = true
        let vault = try WalletVault.createForUpdate(payload, password: "ios-fixture-password")
        let session = try VaultSession(mnemonic: words, passphrase: "")
        defer { session.lock(); vault.close() }
        var writes = 0
        let hd = try NativeHdWallet(session: session, vault: vault, persist: { _ in
            writes += 1
            if writes == 1 { throw WalletError("Fixture storage failure") }
        })
        let first = try session.publicAccount(index: 0, change: 0).string("address")
        do { _ = try await hd.observeUsed(first); XCTFail("Range extension should fail") } catch { }
        let state = await hd.snapshot()
        XCTAssertFalse(try state.object("hd").boolean("complete"))
        XCTAssertEqual(writes, 2)
        XCTAssertTrue(try vault.payload().boolean("needsRecovery"))
        XCTAssertFalse(try vault.payload().boolean("mobileHdRecovered"))
        do { try await hd.requireReady(); XCTFail("Incomplete HD range must not permit payments") } catch { }
    }
}
