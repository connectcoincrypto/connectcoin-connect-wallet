import Foundation

private final class SubscriptionMailbox: @unchecked Sendable {
    private let mutex = NSLock()
    private var messages: [JSONObject] = [], scheduled = false, overflow = false
    func append(_ message: JSONObject) -> Bool {
        mutex.lock(); defer { mutex.unlock() }
        if messages.count < 200 { messages.append(message) } else { overflow = true }
        if scheduled { return false }; scheduled = true; return true
    }
    func take() -> ([JSONObject], Bool) {
        mutex.lock(); defer { mutex.unlock() }
        let result = (messages,overflow); messages = []; overflow = false; scheduled = false; return result
    }
}

/// Address events invalidate balances; ordinary tip events only update confirmations.
/// The native owner supplies addresses, never the WebView or a remote notification.
public actor MobileWalletSubscriptions {
    private let makeClient: () -> MobileRpcClient
    private let emit: (JSONObject) -> Void
    private var client: MobileRpcClient?
    private var current: Task<Void, Never>?
    private var generation: UInt64 = 0
    private var connectionGeneration: UInt64 = 0
    private var sleeper: Task<Void, Error>?
    private var walletID = "", addresses: [String] = [], identifiers: [String: String] = [:], tipID = ""
    private var connected = false, registering = false
    private var pending: [JSONObject] = []
    private var attempt = 0
    private var lastMessage = ProcessInfo.processInfo.systemUptime
    public init(endpoint: TcpEndpoint, emit: @escaping (JSONObject) -> Void) {
        makeClient = { MobileRpcClient(endpoint:endpoint,subscriptions:true) }; self.emit = emit
    }
    init(makeClient: @escaping () -> MobileRpcClient, emit: @escaping (JSONObject) -> Void) {
        self.makeClient = makeClient; self.emit = emit
    }
    public func state() -> JSONObject { ["connected": connected, "coverageLimited": identifiers.count < addresses.count, "watched": identifiers.count, "total": addresses.count] }
    public func stop() {
        generation &+= 1; connectionGeneration &+= 1; current?.cancel(); current = nil; sleeper?.cancel(); sleeper = nil
        client?.close(); client = nil; connected = false; registering = false; identifiers = [:]; pending = []; tipID = ""
    }
    public func configure(_ walletID: String, _ addresses: [String]) throws {
        try walletRequire(!addresses.isEmpty && addresses.count <= 10_000 && Set(addresses).count == addresses.count && addresses.contains(walletID), "Invalid native subscription scope")
        for address in addresses { _ = try WalletCrypto.decodeAddress(address) }
        if self.walletID == walletID && self.addresses == addresses && current != nil { return }
        stop(); self.walletID = walletID; self.addresses = addresses; attempt = 0
        let token = generation; current = Task { await self.run(token) }
    }
    private func run(_ token: UInt64) async {
        while token == generation && !Task.isCancelled {
            connectionGeneration &+= 1; let connection = connectionGeneration
            let rpc = makeClient()
            client = rpc; identifiers = [:]; tipID = ""; connected = false; registering = true; pending = []
            lastMessage = ProcessInfo.processInfo.systemUptime
            let mailbox = SubscriptionMailbox()
            rpc.notification = { [weak self] message in
                if mailbox.append(message) { Task { await self?.drain(mailbox,token,connection) } }
            }
            rpc.disconnected = { [weak self] in Task { await self?.lost(token,connection) } }
            rpc.setActive(true)
            do {
                let first = try await rpc.call("subscribeaddress", ["address": addresses[0], "changes_only": true])
                try check(token,connection); identifiers[try subscriptionID(first, address: true)] = addresses[0]
                let tip = try await rpc.call("subscribetip")
                try check(token,connection); tipID = try subscriptionID(tip, address: false)
                try walletRequire(identifiers[tipID] == nil, "Invalid subscription identifier")
                for address in addresses.prefix(99).dropFirst() {
                    do {
                        let ack = try await rpc.call("subscribeaddress", ["address": address, "changes_only": true]); try check(token,connection)
                        let id = try subscriptionID(ack, address: true)
                        try walletRequire(id != tipID && identifiers[id] == nil, "Duplicate subscription identifier"); identifiers[id] = address
                    } catch let failure as RpcFailure where failure.code == "-32005" { break }
                }
                try check(token,connection); connected = true; registering = false; attempt = 0
                event("connected", tip: try tip.object("tip"), reorg: false, changed: [])
                let queued = pending; pending = []; for message in queued { try notification(message) }
                while token == generation && connected && !Task.isCancelled {
                    let sleep = Task<Void, Error> { try await Task.sleep(nanoseconds:30_000_000_000) }
                    sleeper = sleep; try await sleep.value; sleeper = nil; try check(token,connection)
                    if ProcessInfo.processInfo.systemUptime - lastMessage >= 60 {
                        let heartbeat = try await rpc.call("getchaintip"); try check(token,connection)
                        _ = try NativePaymentChecks.tip(heartbeat); lastMessage = ProcessInfo.processInfo.systemUptime
                    }
                }
            } catch { /* Public status is a reconnect hint, not raw server-controlled text. */ }
            // Invalidate this wire before cancelling it; its delayed completion
            // can never disconnect or deliver data into a successor connection.
            if connection == connectionGeneration { connectionGeneration &+= 1 }
            rpc.close()
            guard token == generation && !Task.isCancelled else { return }
            if connected { event("disconnected",tip:nil,reorg:false,changed:[]) }
            connected = false; registering = false; pending = []; sleeper = nil
            attempt = min(attempt + 1, 6)
            try? await Task.sleep(nanoseconds: UInt64(min(60, 1 << (attempt - 1))) * 1_000_000_000)
        }
    }
    private func check(_ token: UInt64, _ connection: UInt64) throws {
        try Task.checkCancellation(); try walletRequire(token == generation && connection == connectionGeneration,"Subscription cancelled")
    }
    private func lost(_ token: UInt64, _ connection: UInt64) {
        guard token == generation && connection == connectionGeneration else { return }
        // A disconnect between two registration ACKs must revoke the whole
        // wire. Otherwise an auto-opened socket could mix subscription IDs.
        connectionGeneration &+= 1
        if connected { event("disconnected",tip:nil,reorg:false,changed:[]) }
        connected = false; sleeper?.cancel()
    }
    private func drain(_ mailbox: SubscriptionMailbox, _ token: UInt64, _ connection: UInt64) {
        let (messages,overflow) = mailbox.take()
        guard token == generation && connection == connectionGeneration else { return }
        do {
            try walletRequire(!overflow,"Subscription buffer exceeded")
            lastMessage = ProcessInfo.processInfo.systemUptime
            for message in messages {
                if registering { try walletRequire(pending.count < 200,"Subscription buffer exceeded"); pending.append(message) }
                else { try notification(message) }
            }
        } catch { lost(token,connection); client?.setActive(false) }
    }
    private func subscriptionID(_ ack: JSONObject, address: Bool) throws -> String {
        let expected: Set<String> = address ? ["subscription_id", "tip", "cursor", "changes_only"] : ["subscription_id", "tip", "cursor"]
        try walletRequire(Set(ack.keys) == expected, "Invalid subscription ACK")
        if address { try walletRequire(try ack.boolean("changes_only"), "Address changes-only support is required") }
        _ = try NativePaymentChecks.tip(ack.object("tip")); _ = try NativePaymentChecks.cursor(["next_cursor": ack.string("cursor")])
        let id = try ack.string("subscription_id")
        try walletRequire(id.range(of:"\\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z",options:.regularExpression) != nil,"Invalid subscription identifier"); return id
    }
    private func notification(_ message: JSONObject) throws {
        try walletRequire(message.count == 3 && message["jsonrpc"] as? String == "2.0" && message["method"] as? String == "subscription", "Invalid subscription event")
        let params = try message.object("params"), kind = try params.string("kind"), id = try params.string("subscription_id")
        let tip = try NativePaymentChecks.tip(params.object("tip")), reorg = try params.boolean("reorg")
        if kind == "address" {
            try walletRequire(Set(params.keys) == Set(["subscription_id", "kind", "address", "tip", "reorg", "refresh"]) && (try params.boolean("refresh")), "Invalid address event")
            let address = try params.string("address"); try walletRequire(identifiers[id] == address, "Unknown watched address")
            event(kind, tip: tip, reorg: reorg, changed: [address])
        } else {
            try walletRequire(kind == "tip" && params.count == 4 && id == tipID, "Invalid tip event")
            event(kind, tip: tip, reorg: reorg, changed: [])
        }
    }
    private func event(_ reason: String, tip: JSONObject?, reorg: Bool, changed: [String]) {
        var value: JSONObject = ["address": walletID, "reason": reason, "reorg": reorg,
            "changedAddresses": changed, "resyncRequired": false, "watched": identifiers.count,
            "total": addresses.count, "coverageLimited": identifiers.count < addresses.count]
        if let tip { value["tip"] = tip }; emit(value)
    }
}
