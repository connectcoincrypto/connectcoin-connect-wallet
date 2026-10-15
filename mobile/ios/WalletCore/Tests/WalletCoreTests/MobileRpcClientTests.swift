import XCTest
@testable import WalletCore

private final class RpcTestClock: @unchecked Sendable {
    private let mutex = NSLock(); private var time: TimeInterval = 0
    func now() -> TimeInterval { mutex.lock(); defer { mutex.unlock() }; return time }
    func advance(_ by: TimeInterval) { mutex.lock(); time += by; mutex.unlock() }
}

/// On an already-ready wire, admission and pump see a live permit. It expires
/// only at perform(), the last atomic check immediately before socket write.
private final class RpcWriteFenceClock: @unchecked Sendable {
    private let mutex = NSLock()
    private var calls = 0
    func now() -> TimeInterval {
        mutex.lock(); defer { mutex.unlock() }
        calls += 1
        return calls < 3 ? 0 : 1
    }
    var readings: Int { mutex.lock(); defer { mutex.unlock() }; return calls }
}

private final class SubscriptionEvents: @unchecked Sendable {
    private let mutex = NSLock(); private var values: [JSONObject] = []
    func append(_ value: JSONObject) { mutex.lock(); values.append(value); mutex.unlock() }
    var events: [JSONObject] { mutex.lock(); defer { mutex.unlock() }; return values }
}

final class MobileWalletSubscriptionsTests: XCTestCase {
    private let address = "cc1p4t449ht5jnpkzpyaue7vdq8g867th0d7kymr0kfvmpzlwqcg4a0qc59p3e"
    private let addressID = "11111111-1111-4111-8111-111111111111", tipID = "22222222-2222-4222-8222-222222222222"
    private var tip: JSONObject { ["chain":"main","genesis_hash":NativePaymentChecks.GENESIS,"height":120,"hash":String(repeating:"aa",count:32),"mediantime":1_700_000_000] }
    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<200 { if condition() { return }; try await Task.sleep(nanoseconds:10_000_000) }
        XCTFail("Timed out waiting for subscription fixture"); throw WalletError("Subscription fixture timed out")
    }
    private func ack(_ request: JSONObject) -> JSONObject? {
        if request["method"] as? String == "subscribeaddress" { return ["subscription_id":addressID,"tip":tip,"cursor":"cursor.signature","changes_only":true] }
        if request["method"] as? String == "subscribetip" { return ["subscription_id":tipID,"tip":tip,"cursor":"cursor.signature"] }
        return nil
    }
    private func event(_ id: String, addressEvent: Bool = true) throws -> Data {
        var params: JSONObject = ["subscription_id":id,"kind":addressEvent ? "address" : "tip","tip":tip,"reorg":false]
        if addressEvent { params["address"] = address; params["refresh"] = true }
        return try JSON.encode(["jsonrpc":"2.0","method":"subscription","params":params]) + Data([10])
    }
    func testNativeAddressScopeAndImmediateDisconnect() async throws {
        let wire = RpcTestWire(), events = SubscriptionEvents(); wire.respond = ack
        let subscriptions = MobileWalletSubscriptions(makeClient:{ MobileRpcClient(factory:{wire},subscriptions:true) },emit:events.append)
        try await subscriptions.configure(address,[address])
        try await eventually { events.events.count == 1 }
        XCTAssertEqual(events.events[0]["reason"] as? String,"connected")
        wire.emit(try event(addressID)); wire.emit(try event(tipID,addressEvent:false))
        try await eventually { events.events.count == 3 }
        XCTAssertEqual(events.events[1]["reason"] as? String,"address")
        XCTAssertEqual(events.events[1]["changedAddresses"] as? [String],[address])
        XCTAssertEqual(events.events[2]["reason"] as? String,"tip")
        wire.disconnect()
        try await eventually { events.events.count == 4 }
        XCTAssertEqual(events.events[3]["reason"] as? String,"disconnected")
        let state = await subscriptions.state(); XCTAssertEqual(state["connected"] as? Bool,false)
        await subscriptions.stop()
        wire.emit(try event(addressID)); try await Task.sleep(nanoseconds:20_000_000)
        XCTAssertEqual(events.events.count,4)
    }
    func testFailedInitialRegistrationNeverInvalidatesIndependentStartup() async throws {
        let wire = RpcTestWire(), events = SubscriptionEvents()
        let subscriptions = MobileWalletSubscriptions(makeClient:{ MobileRpcClient(factory:{wire},subscriptions:true) },emit:events.append)
        try await subscriptions.configure(address,[address])
        try await eventually { wire.sent.count == 1 }; wire.disconnect()
        try await Task.sleep(nanoseconds:20_000_000)
        XCTAssertTrue(events.events.isEmpty)
        await subscriptions.stop()
    }
    func testForgedSubscriptionIdentityRevokesEstablishedWire() async throws {
        let wire = RpcTestWire(), events = SubscriptionEvents(); wire.respond = ack
        let subscriptions = MobileWalletSubscriptions(makeClient:{ MobileRpcClient(factory:{wire},subscriptions:true) },emit:events.append)
        try await subscriptions.configure(address,[address]); try await eventually { events.events.count == 1 }
        wire.emit(try event("33333333-3333-4333-8333-333333333333"))
        try await eventually { events.events.count == 2 }
        XCTAssertEqual(events.events[1]["reason"] as? String,"disconnected")
        await subscriptions.stop()
        XCTAssertFalse(events.events.contains { $0["reason"] as? String == "address" })
    }
    func testRepeatedValidatedScopeSkipsDecodingAndRegistrationButChangesStillValidate() async throws {
        let wire = RpcTestWire(), events = SubscriptionEvents(), validations = SubscriptionEvents(); wire.respond = ack
        let subscriptions = MobileWalletSubscriptions(makeClient: { MobileRpcClient(factory: { wire }, subscriptions: true) },
            validateAddress: { value in
                validations.append(["address": value]); _ = try WalletCrypto.decodeAddress(value)
            }, emit: events.append)
        try await subscriptions.configure(address, [address])
        try await eventually { events.events.count == 1 }
        for _ in 0..<1_000 { try await subscriptions.configure(address, [address]) }
        XCTAssertEqual(validations.events.count, 1)
        XCTAssertEqual(wire.sent.count, 2)
        do {
            try await subscriptions.configure(address, [address, "invalid-address"])
            XCTFail("A different scope must still be validated")
        } catch { }
        XCTAssertEqual(validations.events.count, 3)
        let state = await subscriptions.state()
        XCTAssertEqual(state["connected"] as? Bool, true)
        XCTAssertEqual(state["total"] as? Int, 1)
        XCTAssertEqual(wire.sent.count, 2)
        await subscriptions.stop()
        try await subscriptions.configure(address, [address])
        try await eventually { events.events.count == 2 }
        XCTAssertEqual(validations.events.count, 4)
        XCTAssertEqual(wire.sent.count, 4)
        await subscriptions.stop()
    }
}
private final class RpcTestWire: RpcWire, @unchecked Sendable {
    private let mutex = NSLock()
    private var callback: ((Data) -> Void)?, failure: (() -> Void)?, ready: (() -> Void)?
    private var _sent: [JSONObject] = []
    var autoReady = true
    var respond: ((JSONObject) -> JSONObject?)?
    var sent: [JSONObject] { mutex.lock(); defer { mutex.unlock() }; return _sent }
    var started: Bool { mutex.lock(); defer { mutex.unlock() }; return ready != nil }
    func start(queue: DispatchQueue, ready: @escaping () -> Void, receive: @escaping (Data) -> Void, failed: @escaping () -> Void) {
        mutex.lock(); self.ready = ready; callback = receive; failure = failed; mutex.unlock()
        if autoReady { ready() }
    }
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void) {
        do {
            let request = try JSON.decode(Data(bytes.dropLast()))
            mutex.lock(); _sent.append(request); mutex.unlock(); completed(true)
            if let result = respond?(request) { reply(request,result:result) }
        } catch { completed(false) }
    }
    func becomeReady() { mutex.lock(); let ready = self.ready; mutex.unlock(); ready?() }
    func emit(_ data: Data) { mutex.lock(); let callback = self.callback; mutex.unlock(); callback?(data) }
    func reply(_ request: JSONObject, result: JSONObject) {
        if let bytes = try? JSON.encode(["jsonrpc":"2.0","id":request["id"]!,"result":result]) { emit(bytes + Data([10])) }
    }
    func reject(_ request: JSONObject, code: Int) {
        if let bytes = try? JSON.encode(["jsonrpc":"2.0","id":request["id"]!,"error":["code":code,"message":"server text is never displayed"]]) { emit(bytes + Data([10])) }
    }
    func disconnect() { mutex.lock(); let failure = self.failure; mutex.unlock(); failure?() }
    func cancel() {}
}

final class MobileRpcClientTests: XCTestCase {
    func testClaimsRawOnlyFallbackIsExplicitAndResetsWithConnection() async throws {
        let wire = RpcTestWire(), client = MobileRpcClient(factory: { wire }); defer { client.close() }; client.setActive(true)
        let params: JSONObject = ["txid": String(repeating: "a", count: 64), "raw_only": true]
        let first = Task { try await client.claimRead("gettransaction", params) }
        try await eventually { wire.sent.count == 1 }
        XCTAssertEqual(try PJ.object(wire.sent[0]["params"])["raw_only"] as? Bool, true)
        wire.reject(wire.sent[0], code: -32602)
        try await eventually { wire.sent.count == 2 }
        XCTAssertNil(try PJ.object(wire.sent[1]["params"])["raw_only"])
        wire.reply(wire.sent[1], result: [:]); _ = try await first.value
        let second = Task { try await client.claimRead("gettransaction", params) }
        try await eventually { wire.sent.count == 3 }
        XCTAssertNil(try PJ.object(wire.sent[2]["params"])["raw_only"])
        wire.reply(wire.sent[2], result: [:]); _ = try await second.value
        client.cancelAll()
        let third = Task { try await client.claimRead("gettransaction", params) }
        try await eventually { wire.sent.count == 4 }
        XCTAssertEqual(try PJ.object(wire.sent[3]["params"])["raw_only"] as? Bool, true)
        wire.reply(wire.sent[3], result: [:]); _ = try await third.value
    }
    func testClaimStatusFallbackRequiresMethodNotFoundAndRejectsInoculatedLegacyPayload() async throws {
        for code in [-32601, -32602, -32002] {
            let wire = RpcTestWire(), client = MobileRpcClient(factory: { wire }); defer { client.close() }; client.setActive(true)
            let lookup = Task { try await client.claimRead("gettransactionstatus", ["txid": self.fixtureHash]) }
            try await eventually { wire.sent.count == 1 }; wire.reject(wire.sent[0], code: code)
            if code == -32601 {
                try await eventually { wire.sent.count == 2 }
                XCTAssertEqual(wire.sent[1]["method"] as? String, "gettransaction")
                wire.reply(wire.sent[1], result: ["transaction": ["hex": "retained by full validator"]])
                _ = try await lookup.value
            } else {
                do { _ = try await lookup.value; XCTFail("Non-capability failure was downgraded") } catch {}
                XCTAssertEqual(wire.sent.count, 1)
            }
        }
        let wire = RpcTestWire(), client = MobileRpcClient(factory: { wire }); defer { client.close() }; client.setActive(true)
        let malformed = Task { try await client.claimRead("gettransactionstatus", ["txid": self.fixtureHash]) }
        try await eventually { wire.sent.count == 1 }
        wire.reply(wire.sent[0], result: ["txid": String(repeating: "b", count: 64), "transaction": ["hex": "injected"]])
        do { _ = try await malformed.value; XCTFail("Status response masqueraded as legacy receipt") } catch {}
        XCTAssertEqual(wire.sent.count, 1)
    }
    func testClaimCompactNegotiationAndMalformedResponsesDoNotDowngrade() async throws {
        let wire = RpcTestWire(), client = MobileRpcClient(factory: { wire }); defer { client.close() }; client.setActive(true)
        let params: JSONObject = ["include_bounties": true, "compact": true, "compact_version": 3]
        let read = Task { try await client.claimRead("getbountychanges", params) }
        for index in 0..<3 {
            try await eventually { wire.sent.count == index + 1 }
            let sent = try PJ.object(wire.sent[index]["params"])
            XCTAssertEqual(sent["compact_version"] as? Int, index == 2 ? nil : 3 - index)
            wire.reject(wire.sent[index], code: -32602)
        }
        try await eventually { wire.sent.count == 4 }
        XCTAssertNil(try PJ.object(wire.sent[3]["params"])["compact"])
        wire.reply(wire.sent[3], result: ["compact": 3, "unchanged": true])
        do { _ = try await read.value; XCTFail("Unrequested compressed response accepted") } catch {}
        XCTAssertEqual(wire.sent.count, 4)
    }
    func testLegacyColdNegotiationAlsoStripsWarmKnownTip() async throws {
        let wire = RpcTestWire(), client = MobileRpcClient(factory: { wire }); defer { client.close() }; client.setActive(true)
        let cold = Task { try await client.claimRead("getbountychanges", ["include_bounties": true, "compact": true, "compact_version": 3]) }
        for index in 0..<4 {
            try await eventually { wire.sent.count == index + 1 }
            wire.reject(wire.sent[index], code: -32602)
        }
        try await eventually { wire.sent.count == 5 }
        XCTAssertTrue(try PJ.object(wire.sent[4]["params"]).isEmpty)
        wire.reply(wire.sent[4], result: [:]); _ = try await cold.value
        let warm = Task { try await client.claimRead("getbountychanges", ["cursor": "base", "include_bounties": true,
            "compact": true, "compact_version": 3, "known_tip": ["height": 1, "hash": self.fixtureHash] as JSONObject,
            "known_state": self.fixtureHash]) }
        try await eventually { wire.sent.count == 6 }
        XCTAssertEqual(Set(try PJ.object(wire.sent[5]["params"]).keys), ["cursor"])
        wire.reply(wire.sent[5], result: [:]); _ = try await warm.value
    }
    private let address = "cc1p4t449ht5jnpkzpyaue7vdq8g867th0d7kymr0kfvmpzlwqcg4a0qc59p3e"
    private let fixtureHash = String(repeating:"aa",count:32)
    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<200 { if condition() { return }; try await Task.sleep(nanoseconds:10_000_000) }
        XCTFail("Timed out waiting for local RPC fixture")
        throw WalletError("RPC fixture timed out")
    }
    func testStrictNativeMethodParametersAndPublicEndpoints() throws {
        let normalized = try MobileRpcClient.validateParams("getaddresschanges",["addresses":[address.uppercased()],"cursor":NSNull()])
        XCTAssertEqual((normalized["addresses"] as? [String])?.first,address)
        for request in [
            ("getaddresschanges",["addresses":[address,address.uppercased()]]),
            ("gettransactions",["txids":Array(repeating:fixtureHash,count:33)]),
            ("gettransactions",["txids":[fixtureHash,fixtureHash.uppercased()]]),
            ("getaddresshistory",["address":address,"cursor":"invalid\n"]),
            ("gettransaction",["txid":fixtureHash + "\n"]),
            ("sendrawtransaction",["transaction_hex":"00"]),
            ("subscribetip",[:])
        ] as [(String,JSONObject)] { XCTAssertThrowsError(try MobileRpcClient.validateParams(request.0,request.1)) }
        XCTAssertThrowsError(try MobileRpcClient.validateParams("subscribeaddress",["address":address,"changes_only":false],subscriptions:true))
        XCTAssertThrowsError(try MobileRpcClient.validateParams("sendrawtransaction",["transaction_hex":String(repeating:"00",count:10)],subscriptions:true))
        for host in ["127.0.0.1","localhost","server.local","example.com\n","bad..example.com","https://example.com"] { XCTAssertThrowsError(try TcpEndpoint(host)) }
        for ip in ["127.0.0.1","10.1.2.3","100.64.0.1","169.254.1.1","192.168.1.1","192.0.2.1","::1","fc00::1","fe80::1","::ffff:127.0.0.1","2001:db8::1","2002:7f00:1::"] { XCTAssertFalse(NetworkRpcWire.isPublicAddress(ip),ip) }
        XCTAssertTrue(NetworkRpcWire.isPublicAddress("8.8.8.8")); XCTAssertTrue(NetworkRpcWire.isPublicAddress("2606:4700:4700::1111"))
    }
    func testFragmentedOutOfOrderResponsesKeepRequestIdentity() async throws {
        let wire = RpcTestWire(), client = MobileRpcClient(factory:{ wire }); defer { client.close() }; client.setActive(true)
        let first = Task { try await client.call("getchaintip") }, second = Task { try await client.call("getrecentblockhashes") }
        try await eventually { wire.sent.count == 2 }
        let requests = wire.sent
        for request in requests.reversed() {
            let bytes = try JSON.encode(["jsonrpc":"2.0","id":request["id"]!,"result":["method":request["method"]!]]) + Data([10])
            wire.emit(Data(bytes.prefix(7))); wire.emit(Data(bytes.dropFirst(7)))
        }
        let one = try await first.value, two = try await second.value
        XCTAssertEqual(one["method"] as? String,"getchaintip"); XCTAssertEqual(two["method"] as? String,"getrecentblockhashes")
    }
    func testSixteenInFlightAndFortyEightTotalBound() async throws {
        let wire = RpcTestWire(), client = MobileRpcClient(factory:{wire}); defer { client.close() }; client.setActive(true)
        let tasks: [Task<JSONObject,Error>] = (0..<49).map { _ in Task { try await client.call("getchaintip") } }
        try await eventually { wire.sent.count == 16 }
        try await Task.sleep(nanoseconds:40_000_000); XCTAssertEqual(wire.sent.count,16)
        var answered = 0
        while answered < 48 {
            try await eventually { wire.sent.count > answered }
            let requests = wire.sent
            XCTAssertLessThanOrEqual(requests.count - answered,16)
            for request in requests.dropFirst(answered) { wire.reply(request,result:[:]) }
            answered = requests.count
        }
        var completed = 0, busy = 0
        for task in tasks {
            do { _ = try await task.value; completed += 1 }
            catch let failure as RpcFailure { XCTAssertEqual(failure.code,"RPC_BUSY"); busy += 1 }
        }
        XCTAssertEqual(completed,48); XCTAssertEqual(busy,1)
    }
    func testBountyStreamPublishesOnlyAfterCompleteEnd() async throws {
        let wire = RpcTestWire(), client = MobileRpcClient(factory:{wire}); defer { client.close() }; client.setActive(true)
        let stream = Task { try await client.streamBounties(fixtureHash) }
        try await eventually { wire.sent.count == 1 }; wire.reply(wire.sent[0],result:["stream_id":"public-fixture"])
        let chunks: [JSONObject] = [
            ["type":"snapshot","tip":[:],"block_hash":fixtureHash,"unit":"connects","live":true,"cursor":"start.signature"],
            ["type":"bounties","tip":[:],"items":[]],
            ["type":"state","tip":[:],"cursor":"end.signature"]
        ]
        for (sequence,chunk) in chunks.enumerated() {
            let message: JSONObject = ["jsonrpc":"2.0","method":"stream.chunk","params":["stream_id":"public-fixture","sequence":sequence,"items":chunk]]
            wire.emit(try JSON.encode(message) + Data([10]))
        }
        let ending: JSONObject = ["jsonrpc":"2.0","method":"stream.end","params":["stream_id":"public-fixture","complete":true,"chunks":3]]
        wire.emit(try JSON.encode(ending) + Data([10]))
        let published = try await stream.value; XCTAssertEqual(published.count,3)
        XCTAssertEqual(published[2]["type"] as? String,"state")
    }
    func testCancelledWrittenReadDrainsLateReplyWithoutPoisoningSibling() async throws {
        let wire = RpcTestWire(), client = MobileRpcClient(factory:{ wire }); defer { client.close() }; client.setActive(true)
        let first = Task { try await client.call("getchaintip") }
        try await eventually { wire.sent.count == 1 }; first.cancel()
        do { _ = try await first.value; XCTFail("Cancelled read succeeded") } catch {}
        let second = Task { try await client.call("getrecentblockhashes") }
        try await eventually { wire.sent.count == 2 }
        wire.reply(wire.sent[0],result:[:]); wire.reply(wire.sent[1],result:["valid":true])
        let result = try await second.value
        XCTAssertEqual(result["valid"] as? Bool,true)
    }
    func testBroadcastPermitPrewriteCancellationAndPostwriteUncertainty() async throws {
        let wire = RpcTestWire(); wire.autoReady = false
        let client = MobileRpcClient(factory:{ wire }); defer { client.close() }; client.setActive(true)
        let permit = RpcBroadcastPermit()
        let pending = Task { try await client.broadcast(String(repeating:"00",count:10),permit:permit) }
        try await Task.sleep(nanoseconds:20_000_000); permit.cancel(); wire.becomeReady()
        do { _ = try await pending.value; XCTFail("Revoked broadcast succeeded") }
        catch let failure as RpcFailure { XCTAssertFalse(failure.unknownOutcome); XCTAssertTrue(failure.notSent); XCTAssertEqual(failure.code,"RPC_CANCELLED") }
        XCTAssertTrue(wire.sent.isEmpty)
        let next = Task { try await client.broadcast(String(repeating:"00",count:10),permit:RpcBroadcastPermit()) }
        try await eventually { wire.sent.count == 1 }; wire.disconnect()
        do { _ = try await next.value; XCTFail("Disconnected broadcast succeeded") }
        catch let failure as RpcFailure { XCTAssertTrue(failure.unknownOutcome); XCTAssertFalse(failure.notSent) }
        XCTAssertEqual(wire.sent.count,1)
    }
    func testFinalWriteFenceRevocationsDoNotConsumeQuotaButActualBroadcastsDo() async throws {
        let clock = RpcTestClock(), wire = RpcTestWire(), hash = fixtureHash
        wire.respond = { request in request["method"] as? String == "sendrawtransaction" ? ["txid": hash] : [:] }
        let rpc = MobileRpcClient(factory: { wire }, now: clock.now)
        defer { rpc.close() }; rpc.setActive(true)
        // Keep connection setup out of the permit clock: each revoked request
        // reaches the final write fence, rather than failing at initial admission.
        _ = try await rpc.call("getchaintip")
        let hex = String(repeating: "00", count: 10)
        for _ in 0..<48 {
            let fence = RpcWriteFenceClock(), permit = RpcBroadcastPermit(validUntil: 1, now: fence.now)
            do { _ = try await rpc.broadcast(hex, permit: permit); XCTFail("Expired permit wrote a broadcast") }
            catch let failure as RpcFailure {
                XCTAssertEqual(failure.code, "RPC_CANCELLED")
                XCTAssertTrue(failure.notSent); XCTAssertFalse(failure.unknownOutcome)
            }
            XCTAssertEqual(fence.readings, 3, "The expiration must occur at perform(), after both earlier checks")
        }
        XCTAssertEqual(wire.sent.count, 1, "None of the 48 revoked broadcasts reached the wire")
        func broadcasts() -> [JSONObject] { wire.sent.filter { $0["method"] as? String == "sendrawtransaction" } }
        for count in 1...48 {
            let pending = Task { try await rpc.broadcast(hex, permit: RpcBroadcastPermit()) }
            try await eventually { broadcasts().count == count }
            let response = try await pending.value
            XCTAssertEqual(response["txid"] as? String, hash)
        }
        // These are genuine writes and therefore exhaust the unchanged quota.
        let limited = Task { try await rpc.broadcast(hex, permit: RpcBroadcastPermit()) }
        defer { limited.cancel() }
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(broadcasts().count, 48)
        clock.advance(59.999)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(broadcasts().count, 48)
        clock.advance(0.002)
        try await eventually { broadcasts().count == 49 }
        let response = try await limited.value
        XCTAssertEqual(response["txid"] as? String, hash)
        XCTAssertTrue(broadcasts().allSatisfy { ($0["params"] as? JSONObject)?["transaction_hex"] as? String == hex })
    }
    func testSixPerMinuteParentsQuotaSurvivesEndpointReplacementAndFailedPersist() async throws {
        let clock = RpcTestClock(), firstWire = RpcTestWire(); firstWire.respond = { _ in [:] }
        let original = MobileRpcClient(factory:{firstWire},now:clock.now); defer { original.close() }; original.setActive(true)
        for _ in 0..<6 { _ = try await original.call("gettransactions",["txids":[fixtureHash]]) }
        XCTAssertEqual(firstWire.sent.count,6)
        do { _ = try await original.replacing(factory:{RpcTestWire()}) { throw WalletError("disk failed") }; XCTFail("Failed persistence switched endpoint") } catch {}
        _ = try await original.call("getchaintip"); XCTAssertEqual(firstWire.sent.count,7)
        let secondWire = RpcTestWire(); secondWire.respond = { _ in [:] }
        let successor = try await original.replacing(factory:{secondWire}); defer { successor.close() }
        let waiting = Task { try await successor.call("gettransactions",["txids":[fixtureHash]]) }
        try await Task.sleep(nanoseconds:40_000_000); XCTAssertTrue(secondWire.sent.isEmpty)
        clock.advance(60); _ = try await waiting.value; XCTAssertEqual(secondWire.sent.count,1)
        original.setActive(true)
        do { _ = try await original.call("getchaintip"); XCTFail("Retired client reopened") } catch {}
    }
    func testRevokedBroadcastSettlesWhileConnectionIsStillPending() async throws {
        let wire = RpcTestWire(); wire.autoReady = false
        let client = MobileRpcClient(factory:{wire}); defer { client.close() }; client.setActive(true)
        let permit = RpcBroadcastPermit()
        let pending = Task { try await client.broadcast(String(repeating:"00",count:10),permit:permit) }
        try await Task.sleep(nanoseconds:20_000_000); permit.cancel()
        do { _ = try await pending.value; XCTFail("Revoked broadcast succeeded") }
        catch let error as RpcFailure { XCTAssertEqual(error.code,"RPC_CANCELLED"); XCTAssertFalse(error.unknownOutcome) }
        XCTAssertTrue(wire.sent.isEmpty)
        wire.becomeReady(); try await Task.sleep(nanoseconds:20_000_000)
        XCTAssertTrue(wire.sent.isEmpty)
    }
    func testFortyEightPerMinuteAndServerCooldownDoNotRetryBroadcasts() async throws {
        let clock = RpcTestClock(), wire = RpcTestWire(); wire.respond = { _ in [:] }
        let client = MobileRpcClient(factory:{wire},now:clock.now); defer { client.close() }; client.setActive(true)
        for _ in 0..<48 { _ = try await client.call("getchaintip") }; XCTAssertEqual(wire.sent.count,48)
        let waiting = Task { try await client.call("getchaintip") }
        try await Task.sleep(nanoseconds:20_000_000); XCTAssertEqual(wire.sent.count,48)
        clock.advance(60); _ = try await waiting.value; XCTAssertEqual(wire.sent.count,49)
        wire.respond = nil
        let broadcast = Task { try await client.broadcast(String(repeating:"00",count:10)) }
        try await eventually { wire.sent.count == 50 }; wire.reject(wire.sent[49],code:-32029)
        do { _ = try await broadcast.value; XCTFail("Rejected send succeeded") }
        catch let failure as RpcFailure { XCTAssertEqual(failure.code,"-32029"); XCTAssertFalse(failure.unknownOutcome); XCTAssertFalse(failure.notSent); XCTAssertTrue(failure.notForwarded) }
        clock.advance(120); try await Task.sleep(nanoseconds:20_000_000); XCTAssertEqual(wire.sent.count,50)
    }
    func testGatewayRefusalsProveNonSubmissionButNotAbsenceOfSocketWrite() async throws {
        for code in [-32001, -32029, -32030] {
            let wire = RpcTestWire(), rpc = MobileRpcClient(factory: { wire }); defer { rpc.close() }; rpc.setActive(true)
            let waiting = Task { try await rpc.broadcast(String(repeating: "00", count: 10)) }
            try await eventually { wire.sent.count == 1 }
            wire.emit(try JSON.encode(["jsonrpc": "2.0", "id": wire.sent[0]["id"]!,
                "error": ["code": code, "message": "gateway rejection", "data": ["retry_after_ms": 120_000]]]) + Data([10]))
            do { _ = try await waiting.value; XCTFail("Rejected request succeeded") }
            catch let failure as RpcFailure {
                XCTAssertEqual(failure.code, String(code)); XCTAssertTrue(failure.notForwarded)
                XCTAssertFalse(failure.notSent); XCTAssertFalse(failure.unknownOutcome); XCTAssertFalse(failure.explicitRejection)
                XCTAssertNil(failure.nodeCode); XCTAssertEqual(failure.retryAfterMs, 120_000)
            }
            XCTAssertEqual(wire.sent.count, 1)
        }
    }
    func testAmbiguousOrContradictoryRepliesCannotClaimNonSubmission() async throws {
        let responses: [JSONObject] = [
            ["code": -32002, "data": ["notForwarded": true, "notSent": true]],
            ["code": -32030, "data": ["node_code": -27]],
            ["code": -32029, "data": ["node_code": "invalid"]],
            ["code": -32001, "data": [Any]()],
            ["code": -32030, "data": true],
        ]
        for remote in responses {
            let wire = RpcTestWire(), rpc = MobileRpcClient(factory: { wire }); defer { rpc.close() }; rpc.setActive(true)
            let waiting = Task { try await rpc.broadcast(String(repeating: "00", count: 10)) }
            try await eventually { wire.sent.count == 1 }
            wire.emit(try JSON.encode(["jsonrpc": "2.0", "id": wire.sent[0]["id"]!, "error": remote]) + Data([10]))
            do { _ = try await waiting.value; XCTFail("Rejected request succeeded") }
            catch let failure as RpcFailure {
                XCTAssertTrue(failure.unknownOutcome); XCTAssertFalse(failure.notSent); XCTAssertFalse(failure.notForwarded)
            }
            XCTAssertEqual(wire.sent.count, 1)
        }
    }
    func testInvalidRefusalCooldownRemainsAmbiguousAfterWrite() async throws {
        let delays: [Any] = ["invalid", -1, 9_007_199_254_740_992, true, NSNull()]
        for delay in delays {
            let wire = RpcTestWire(), rpc = MobileRpcClient(factory: { wire }); defer { rpc.close() }; rpc.setActive(true)
            let waiting = Task { try await rpc.broadcast(String(repeating: "00", count: 10)) }
            try await eventually { wire.sent.count == 1 }
            wire.emit(try JSON.encode(["jsonrpc": "2.0", "id": wire.sent[0]["id"]!,
                "error": ["code": -32030, "data": ["retry_after_ms": delay]]]) + Data([10]))
            do { _ = try await waiting.value; XCTFail("Malformed response succeeded") }
            catch let failure as RpcFailure {
                XCTAssertEqual(failure.code, "RPC_PROTOCOL"); XCTAssertTrue(failure.unknownOutcome)
                XCTAssertFalse(failure.notSent); XCTAssertFalse(failure.notForwarded)
            }
        }
    }
    func testFreshnessDeadlineIsCheckedAtWriteAndDistinguishedFromLifecycleStop() async throws {
        let clock = RpcTestClock(), wire = RpcTestWire(); wire.autoReady = false
        let rpc = MobileRpcClient(factory: { wire }); defer { rpc.close() }; rpc.setActive(true)
        let permit = RpcBroadcastPermit(validUntil: 60, now: clock.now)
        let waiting = Task { try await rpc.broadcast(String(repeating: "00", count: 10), permit: permit) }
        try await eventually { wire.started }; clock.advance(60); wire.becomeReady()
        do { _ = try await waiting.value; XCTFail("Stale claim reached the wire") }
        catch let failure as RpcFailure {
            XCTAssertEqual(failure.code, "RPC_CANCELLED"); XCTAssertTrue(failure.notSent); XCTAssertFalse(failure.unknownOutcome)
        }
        XCTAssertTrue(wire.sent.isEmpty); XCTAssertTrue(permit.expired)
        permit.cancel(); XCTAssertFalse(permit.expired); XCTAssertFalse(permit.isValid)
    }
    func testPrewriteConnectTimeoutCarriesExplicitNotSent() async throws {
        let clock = RpcTestClock(), wire = RpcTestWire(); wire.autoReady = false
        let rpc = MobileRpcClient(factory: { wire }, now: clock.now); defer { rpc.close() }; rpc.setActive(true)
        let waiting = Task { try await rpc.broadcast(String(repeating: "00", count: 10)) }
        try await eventually { wire.started }; clock.advance(41)
        do { _ = try await waiting.value; XCTFail("Timed-out connection succeeded") }
        catch let failure as RpcFailure {
            XCTAssertEqual(failure.code, "RPC_TIMEOUT"); XCTAssertTrue(failure.notSent); XCTAssertFalse(failure.unknownOutcome)
        }
        XCTAssertTrue(wire.sent.isEmpty)
    }
    func testGettransactionBackendFailureIsReadOnlyButSameCodeAfterBroadcastStaysUnknown() async throws {
        let wire = RpcTestWire(), rpc = MobileRpcClient(factory: { wire })
        defer { rpc.close() }; rpc.setActive(true)
        let params: JSONObject = ["txid": fixtureHash]
        let reading = Task { try await rpc.call("gettransaction", params) }
        try await eventually { wire.sent.count == 1 }
        wire.reject(wire.sent[0], code: -32002)
        do { _ = try await reading.value; XCTFail("Unavailable parent transaction unexpectedly succeeded") }
        catch let failure as RpcFailure {
            XCTAssertEqual(failure.code, "-32002")
            XCTAssertFalse(failure.unknownOutcome); XCTAssertFalse(failure.explicitRejection)
            XCTAssertFalse(failure.notSent); XCTAssertFalse(failure.notForwarded)
        }
        let retried = Task { try await rpc.call("gettransaction", params) }
        try await eventually { wire.sent.count == 2 }
        XCTAssertEqual(try JSON.encode(wire.sent[0]["params"] as! JSONObject), try JSON.encode(wire.sent[1]["params"] as! JSONObject))
        wire.reply(wire.sent[1], result: ["recovered": true])
        let response = try await retried.value
        XCTAssertEqual(response["recovered"] as? Bool, true)

        // Read recoverability is not evidence that a financial write was rejected.
        let broadcast = Task { try await rpc.broadcast(String(repeating: "00", count: 10)) }
        try await eventually { wire.sent.count == 3 }
        wire.reject(wire.sent[2], code: -32002)
        do { _ = try await broadcast.value; XCTFail("Ambiguous broadcast unexpectedly succeeded") }
        catch let failure as RpcFailure {
            XCTAssertEqual(failure.code, "-32002"); XCTAssertTrue(failure.unknownOutcome)
            XCTAssertFalse(failure.notSent); XCTAssertFalse(failure.notForwarded)
            var pending = ClaimSubmissionRetry(hex: String(repeating: "00", count: 10), txid: fixtureHash)
            XCTAssertFalse(pending.retain(after: failure, now: 0))
        }
        XCTAssertEqual(wire.sent.count, 3)
    }
    func testStreamTimeoutDiscardsPartialChunksAndReconnectStillRequiresCompleteEnd() async throws {
        let clock = RpcTestClock(), wire = RpcTestWire()
        let rpc = MobileRpcClient(factory: { wire }, now: clock.now)
        defer { rpc.close() }; rpc.setActive(true)
        func chunk(_ stream: String, _ sequence: Int, _ items: JSONObject) throws {
            wire.emit(try JSON.encode(["jsonrpc": "2.0", "method": "stream.chunk",
                "params": ["stream_id": stream, "sequence": sequence, "items": items]]) + Data([10]))
        }
        func snapshot(_ stream: String) throws {
            try chunk(stream, 0, ["type": "snapshot", "tip": [:], "block_hash": fixtureHash,
                "unit": "connects", "live": true, "cursor": "snapshot.cursor"])
        }
        let timedOut = Task { try await rpc.streamBounties(fixtureHash) }
        try await eventually { wire.sent.count == 1 }
        wire.reply(wire.sent[0], result: ["stream_id": "interrupted"])
        try snapshot("interrupted")
        try chunk("interrupted", 1, ["type": "bounties", "tip": [:], "items": [["partial": true]]])
        // A completed sibling read is a queue barrier: the preceding stream
        // chunks have actually been parsed and buffered before the deadline.
        let barrier = Task { try await rpc.call("getchaintip") }
        try await eventually { wire.sent.count == 2 }
        wire.reply(wire.sent[1], result: [:]); _ = try await barrier.value
        clock.advance(121)
        do { _ = try await timedOut.value; XCTFail("An unfinished stream published partial chunks") }
        catch let failure as RpcFailure {
            XCTAssertEqual(failure.code, "RPC_TIMEOUT")
            XCTAssertFalse(failure.unknownOutcome); XCTAssertFalse(failure.notSent)
        }
        for complete in [false, true] {
            let stream = complete ? "complete" : "incomplete"
            let pending = Task { try await rpc.streamBounties(fixtureHash) }
            let expected = complete ? 4 : 3
            try await eventually { wire.sent.count == expected }
            wire.reply(wire.sent[expected - 1], result: ["stream_id": stream])
            try snapshot(stream)
            try chunk(stream, 1, ["type": "state", "tip": [:], "cursor": "final.cursor"])
            wire.emit(try JSON.encode(["jsonrpc": "2.0", "method": "stream.end",
                "params": ["stream_id": stream, "complete": complete, "chunks": 2]]) + Data([10]))
            do {
                let result = try await pending.value
                XCTAssertTrue(complete); XCTAssertEqual(result.count, 2)
                XCTAssertEqual(result.compactMap { $0["type"] as? String }, ["snapshot", "state"])
            } catch let failure as RpcFailure {
                XCTAssertFalse(complete); XCTAssertEqual(failure.code, "RPC_PROTOCOL")
                XCTAssertFalse(failure.unknownOutcome)
            }
        }
        XCTAssertEqual(wire.sent.count, 4)
        XCTAssertEqual(wire.sent.filter { $0["method"] as? String == "getblockbounties" }.count, 3)
    }
    func testExplicitNodeRejectionIsNotAnUnsentTransportFailure() async throws {
        let wire = RpcTestWire(), rpc = MobileRpcClient(factory: { wire }); defer { rpc.close() }; rpc.setActive(true)
        let waiting = Task { try await rpc.broadcast(String(repeating: "00", count: 10)) }
        try await eventually { wire.sent.count == 1 }
        wire.emit(try JSON.encode(["jsonrpc": "2.0", "id": wire.sent[0]["id"]!,
            "error": ["code": -32020, "message": "rejected", "data": ["node_code": -26, "notSent": true]]]) + Data([10]))
        do { _ = try await waiting.value; XCTFail("Rejected send succeeded") }
        catch let failure as RpcFailure {
            XCTAssertTrue(failure.explicitRejection); XCTAssertEqual(failure.nodeCode, -26)
            XCTAssertFalse(failure.unknownOutcome); XCTAssertFalse(failure.notSent)
        }
        XCTAssertEqual(wire.sent.count, 1)
    }
    func testServerCooldownLongerThanMinuteIsNeverShortened() async throws {
        let clock = RpcTestClock(), wire = RpcTestWire()
        let rpc = MobileRpcClient(factory: { wire }, now: clock.now); defer { rpc.close() }; rpc.setActive(true)
        let limited = Task { try await rpc.call("getchaintip") }
        try await eventually { wire.sent.count == 1 }
        wire.emit(try JSON.encode(["jsonrpc": "2.0", "id": wire.sent[0]["id"]!,
            "error": ["code": -32029, "message": "limited", "data": ["retry_after_ms": 120_000]]]) + Data([10]))
        do { _ = try await limited.value; XCTFail("Limited request succeeded") }
        catch let failure as RpcFailure { XCTAssertEqual(failure.retryAfterMs, 120_000); XCTAssertFalse(failure.notSent) }
        wire.respond = { _ in [:] }
        let waiting = Task { try await rpc.call("getchaintip") }
        clock.advance(60); try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(wire.sent.count, 1)
        clock.advance(60); _ = try await waiting.value
        XCTAssertEqual(wire.sent.count, 2)
    }
}
