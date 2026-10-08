import XCTest
@testable import WalletCore

private final class RpcTestClock: @unchecked Sendable {
    private let mutex = NSLock(); private var time: TimeInterval = 0
    func now() -> TimeInterval { mutex.lock(); defer { mutex.unlock() }; return time }
    func advance(_ by: TimeInterval) { mutex.lock(); time += by; mutex.unlock() }
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
}
private final class RpcTestWire: RpcWire, @unchecked Sendable {
    private let mutex = NSLock()
    private var callback: ((Data) -> Void)?, failure: (() -> Void)?, ready: (() -> Void)?
    private var _sent: [JSONObject] = []
    var autoReady = true
    var respond: ((JSONObject) -> JSONObject?)?
    var sent: [JSONObject] { mutex.lock(); defer { mutex.unlock() }; return _sent }
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
        catch let failure as RpcFailure { XCTAssertFalse(failure.unknownOutcome); XCTAssertEqual(failure.code,"RPC_CANCELLED") }
        XCTAssertTrue(wire.sent.isEmpty)
        let next = Task { try await client.broadcast(String(repeating:"00",count:10),permit:RpcBroadcastPermit()) }
        try await eventually { wire.sent.count == 1 }; wire.disconnect()
        do { _ = try await next.value; XCTFail("Disconnected broadcast succeeded") }
        catch let failure as RpcFailure { XCTAssertTrue(failure.unknownOutcome) }
        XCTAssertEqual(wire.sent.count,1)
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
        catch let failure as RpcFailure { XCTAssertEqual(failure.code,"-32029"); XCTAssertTrue(failure.unknownOutcome) }
        clock.advance(120); try await Task.sleep(nanoseconds:20_000_000); XCTAssertEqual(wire.sent.count,50)
    }
}
