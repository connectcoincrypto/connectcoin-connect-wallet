import Foundation
import Network
import Darwin
import CConnectWallet

public struct RpcFailure: Error, LocalizedError {
    public let code: String
    public var unknownOutcome = false
    public var nodeCode: Int?
    public var retryAfterMs = 0
    public var explicitRejection = false
    public init(_ code: String) { self.code = code }
    public var errorDescription: String? {
        if unknownOutcome { return "Broadcast outcome is unknown. Check its transaction ID before retrying." }
        if code == "-32029" { return "RPC rate limit reached. Retrying after the server cooldown." }
        return code
    }
}

/// Native lifecycle fence checked atomically at the first socket write. Once a
/// write begins, revocation never pretends the outcome is safely unsent.
public final class RpcBroadcastPermit: @unchecked Sendable {
    private let mutex = NSLock()
    private var valid = true
    public init() {}
    public func cancel() { mutex.lock(); valid = false; mutex.unlock() }
    public var isValid: Bool { mutex.lock(); defer { mutex.unlock() }; return valid }
    fileprivate func perform(_ action: () -> Void) -> Bool {
        mutex.lock(); defer { mutex.unlock() }; guard valid else { return false }; action(); return true
    }
}

public struct TcpEndpoint: Equatable {
    public let hostname: String
    public let port: UInt16
    public init(_ hostname: String = "connectcoin4.com", _ port: Int = 48190) throws {
        let host = hostname.lowercased()
        try walletRequire(host.count <= 253 && (1...65535).contains(port) && host.contains(".") &&
            host.range(of: "^[a-z0-9.-]+$", options: .regularExpression) != nil &&
            host.range(of: "^[0-9.]+$", options: .regularExpression) == nil &&
            ![".local", ".localhost", ".internal"].contains(where: host.hasSuffix), "A public DNS hostname is required")
        for label in host.split(separator: ".", omittingEmptySubsequences: false) {
            try walletRequire(!label.isEmpty && label.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-"), "Invalid RPC hostname")
        }
        self.hostname = host; self.port = UInt16(port)
    }
}

/// Socket abstraction makes fragmentation, disconnect and uncertain broadcasts testable
/// without placing production signing keys or test-only endpoints in the WebView.
public protocol RpcWire: AnyObject {
    func start(queue: DispatchQueue, ready: @escaping () -> Void,
               receive: @escaping (Data) -> Void, failed: @escaping () -> Void)
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void)
    func cancel()
}

/// getaddrinfo is not cancellable. At most two process-wide native workers may
/// remain in OS resolution, with no unbounded queued work. A late result never
/// opens a socket after its wire has been cancelled. Numeric NWEndpoint avoids
/// a second DNS lookup between address validation and the actual connection.
private enum PublicRpcResolver {
    static let mutex = NSLock()
    static var running = 0
    static let workers = DispatchQueue(label: "connectwallet.ios.rpc.dns", attributes: .concurrent)
    static func resolve(_ hostname: String, _ completed: @escaping (String?) -> Void) {
        mutex.lock()
        guard running < 2 else { mutex.unlock(); completed(nil); return }
        running += 1; mutex.unlock()
        workers.async {
            var numeric: String?
            var hints = addrinfo(); hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_protocol = IPPROTO_TCP
            var head: UnsafeMutablePointer<addrinfo>?
            if getaddrinfo(hostname, nil, &hints, &head) == 0, let first = head {
                defer { freeaddrinfo(first) }
                // Match the Android rule: the resolver's chosen first endpoint
                // must itself be public. Mixed private/public answers fail shut.
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if let address = first.pointee.ai_addr,
                   getnameinfo(address,first.pointee.ai_addrlen,&host,socklen_t(host.count),nil,0,NI_NUMERICHOST) == 0 {
                    let result = String(cString: host)
                    if isPublic(result) { numeric = result }
                }
            }
            mutex.lock(); running -= 1; mutex.unlock(); completed(numeric)
        }
    }
    static func isPublic(_ numeric: String) -> Bool { numeric.withCString { cw_wallet_is_public_address($0) == 1 } }
}
final class NetworkRpcWire: RpcWire {
    private let endpoint: TcpEndpoint, mutex = NSLock()
    private var connection: NWConnection?, cancelled = false
    init(_ endpoint: TcpEndpoint) { self.endpoint = endpoint }
    static func isPublicAddress(_ numeric: String) -> Bool { PublicRpcResolver.isPublic(numeric) }
    func start(queue: DispatchQueue, ready: @escaping () -> Void, receive: @escaping (Data) -> Void, failed: @escaping () -> Void) {
        PublicRpcResolver.resolve(endpoint.hostname) { [weak self] numeric in
            queue.async {
                guard let self else { return }
                self.mutex.lock()
                guard !self.cancelled else { self.mutex.unlock(); return }
                guard let numeric else { self.mutex.unlock(); failed(); return }
                let options = NWProtocolTCP.Options(); options.noDelay = true; options.enableKeepalive = true
                let connection = NWConnection(host: NWEndpoint.Host(numeric), port: NWEndpoint.Port(rawValue: self.endpoint.port)!, using: NWParameters(tls:nil,tcp:options))
                self.connection = connection; self.mutex.unlock()
                connection.stateUpdateHandler = { [weak self] state in
                    switch state {
                    case .ready: ready(); self?.read(connection, receive, failed)
                    case .failed: failed()
                    default: break
                    }
                }
                connection.start(queue: queue)
            }
        }
    }
    private func read(_ connection: NWConnection, _ receive: @escaping (Data) -> Void, _ failed: @escaping () -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            if let data, !data.isEmpty { receive(data) }
            if complete || error != nil { failed() } else { self?.read(connection, receive, failed) }
        }
    }
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void) {
        mutex.lock(); let connection = cancelled ? nil : self.connection; mutex.unlock()
        guard let connection else { completed(false); return }
        connection.send(content: bytes, completion: .contentProcessed { completed($0 == nil) })
    }
    func cancel() {
        mutex.lock(); cancelled = true; let old = connection; connection = nil; mutex.unlock()
        old?.stateUpdateHandler = nil; old?.cancel()
    }
}

/// One multiplexed TCP connection, 16 in-flight requests, 48 total operations.
/// Quota waits never consume request timeout, nor occupy an in-flight slot.
// All mutable client state and callbacks are owned by queue; public operations
// enqueue there. The only cross-queue flags have their own mutexes.
public final class MobileRpcClient: @unchecked Sendable {
    public typealias Completion = (Result<JSONObject, Error>) -> Void
    private final class Cancellation: @unchecked Sendable {
        private let lock = NSLock()
        private var cancelled = false
        func cancel() { lock.lock(); cancelled = true; lock.unlock() }
        var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    }
    private final class Job {
        let id: String, method: String
        let params: JSONObject
        let permit: RpcBroadcastPermit?
        var completion: Completion?
        var started: TimeInterval?
        var written = false
        var streamID: String?
        var sequence = 0, rows = 0, bytes = 0, retainedBytes = 0
        var snapshot = false, state = false
        var chunks: [JSONObject] = []
        init(_ id: String, _ method: String, _ params: JSONObject, _ permit: RpcBroadcastPermit?, _ completion: @escaping Completion) {
            self.id = id; self.method = method; self.params = params; self.permit = permit; self.completion = completion
        }
    }
    private let queue = DispatchQueue(label: "connectwallet.ios.rpc")
    private let factory: () -> RpcWire
    private let now: () -> TimeInterval
    private let window: TimeInterval
    private var wire: RpcWire?, ready = false, active = false, retired = false
    private var epoch: UInt64 = 0
    private var buffer = Data()
    private var jobs: [String: Job] = [:], order: [String] = []
    private var history: [String: [TimeInterval]] = [:], cooldowns: [String: TimeInterval] = [:]
    private var timer: DispatchSourceTimer?
    private var connectStarted: TimeInterval?
    private var retainedStreamBytes = 0
    // Listener-only clients are constructed natively. UI query never exposes these methods.
    private let subscriptions: Bool
    private var notificationHandler: ((JSONObject) -> Void)?
    private var disconnectedHandler: (() -> Void)?
    public var notification: ((JSONObject) -> Void)? {
        get { queue.sync { notificationHandler } }
        set { queue.async { self.notificationHandler = newValue } }
    }
    public var disconnected: (() -> Void)? {
        get { queue.sync { disconnectedHandler } }
        set { queue.async { self.disconnectedHandler = newValue } }
    }

    public convenience init(endpoint: TcpEndpoint, subscriptions: Bool = false) {
        self.init(factory: { NetworkRpcWire(endpoint) }, subscriptions: subscriptions)
    }
    public init(factory: @escaping () -> RpcWire, subscriptions: Bool = false,
                window: TimeInterval = 60, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.factory = factory; self.subscriptions = subscriptions; self.window = window; self.now = now
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in self?.tick() }; timer.resume(); self.timer = timer
    }
    deinit { timer?.cancel(); wire?.cancel() }
    public func setActive(_ value: Bool) {
        queue.async { guard !self.retired else { return }; self.active = value; if !value { self.failWire("RPC_CANCELLED") } else { self.pump() } }
    }
    public func cancelAll() { queue.async { self.failWire("RPC_CANCELLED") } }
    public func close() { queue.async { self.retired = true; self.active = false; self.failWire("RPC_CANCELLED") } }
    /// Native settings transition: no broadcast may overlap replacement. Public
    /// reads are revoked and quota/cooldown timestamps survive the endpoint swap.
    public func replaceEndpoint(_ endpoint: TcpEndpoint) async throws -> MobileRpcClient {
        try await replacing(factory: { NetworkRpcWire(endpoint) })
    }
    func replacing(factory: @escaping () -> RpcWire) async throws -> MobileRpcClient {
        try await withCheckedThrowingContinuation { continuation in queue.async {
            guard !self.retired, !self.jobs.values.contains(where: { $0.method == "sendrawtransaction" }) else {
                continuation.resume(throwing: RpcFailure("RPC_BUSY")); return
            }
            let successor = MobileRpcClient(factory:factory,subscriptions:self.subscriptions,window:self.window,now:self.now)
            let history = self.history, cooldowns = self.cooldowns, active = self.active
            self.retired = true; self.active = false; self.failWire("RPC_CANCELLED")
            successor.queue.async {
                successor.history = history; successor.cooldowns = cooldowns; successor.active = active
                continuation.resume(returning:successor)
            }
        } }
    }
    public func call(_ method: String, _ params: JSONObject = [:]) async throws -> JSONObject {
        try walletRequire(!["sendrawtransaction", "getblockbounties"].contains(method), "Unsupported native RPC method")
        return try await operation(method, params)
    }
    public func broadcast(_ hex: String, permit: RpcBroadcastPermit? = nil) async throws -> JSONObject {
        try await operation("sendrawtransaction", ["transaction_hex": hex], permit:permit)
    }
    /// Chunks are published only after a verified stream.end, never on an incomplete snapshot.
    public func streamBounties(_ hash: String) async throws -> [JSONObject] {
        let result = try await operation("getblockbounties", ["block_hash": hash])
        return try result.array("chunks").map { try JSON.object($0) }
    }
    private func operation(_ method: String, _ params: JSONObject, permit: RpcBroadcastPermit? = nil) async throws -> JSONObject {
        let id = UUID().uuidString
        let cancellation = Cancellation()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    do {
                        guard !cancellation.isCancelled else { throw RpcFailure("RPC_CANCELLED") }
                        let clean = try Self.validateParams(method, params, subscriptions: self.subscriptions)
                        guard self.active else { throw RpcFailure("RPC_INACTIVE") }
                        guard self.jobs.count < 48 else { throw RpcFailure("RPC_BUSY") }
                        guard permit?.isValid != false else { throw RpcFailure("RPC_CANCELLED") }
                        self.jobs[id] = Job(id, method, clean, permit) { continuation.resume(with: $0) }
                        self.order.append(id); self.pump()
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }, onCancel: { cancellation.cancel(); self.queue.async { self.cancel(id) } })
    }
    private func cancel(_ id: String) {
        guard let job = jobs[id] else { return }
        var failure = RpcFailure("RPC_CANCELLED")
        failure.unknownOutcome = job.method == "sendrawtransaction" && job.written
        job.completion?(.failure(failure)); job.completion = nil
        retainedStreamBytes -= job.retainedBytes; job.retainedBytes = 0; job.chunks = []
        if !job.written { remove(job); pump() }
        // A written request retains its ID until reply/timeout, so late replies do
        // not corrupt unrelated payments. No cancellation ever auto-retries a send.
    }
    private func quotaKeys(_ job: Job) -> [(String, Int)] {
        if subscriptions && ["subscribeaddress", "subscribetip"].contains(job.method) { return [] }
        if job.method == "getblockbounties" { return [(job.method, 48), (job.method + ":" + (job.params["block_hash"] as? String ?? ""), 8)] }
        return [(job.method, job.method == "gettransactions" ? 6 : 48)]
    }
    private func eligible(_ job: Job, _ time: TimeInterval) -> Bool {
        if (cooldowns[job.method] ?? 0) > time { return false }
        for (key, limit) in quotaKeys(job) {
            history[key] = (history[key] ?? []).filter { time - $0 < window }
            if history[key]!.count >= limit { return false }
        }
        return true
    }
    private func pump() {
        guard active else { return }
        guard !jobs.isEmpty else { return }
        let time = now()
        // Reclaim expired block-specific histories even when those blocks never
        // appear again. Remote block hashes cannot grow the limiter indefinitely.
        for key in Array(history.keys) {
            let retained = history[key]!.filter { time - $0 < window }
            if retained.isEmpty { history.removeValue(forKey:key) } else { history[key] = retained }
        }
        for key in Array(cooldowns.keys) where cooldowns[key]! <= time { cooldowns.removeValue(forKey:key) }
        let waiting = order.compactMap { jobs[$0] }.filter { !$0.written && eligible($0, time) }
        guard !waiting.isEmpty else { return }
        if wire == nil { connect() }; guard ready, let wire else { return }
        var count = jobs.values.filter { $0.written }.count
        for job in waiting where count < 16 {
            guard eligible(job, time) else { continue }
            do {
                var bytes = try JSON.encode(["jsonrpc": "2.0", "id": job.id, "method": job.method, "params": job.params])
                try walletRequire(bytes.count <= 1024 * 1024, "RPC_INVALID"); bytes.append(10)
                try walletRequire(Set(history.keys).union(quotaKeys(job).map { $0.0 }).count <= 1024, "RPC_BUSY")
                let transmit = {
                    for (key, _) in self.quotaKeys(job) { self.history[key, default: []].append(time) }
                    job.started = time; job.written = true
                    let epoch = self.epoch
                    wire.send(bytes) { [weak self] success in
                        guard let self else { return }; self.queue.async { if !success && self.epoch == epoch { self.failWire("RPC_UNAVAILABLE") } }
                    }
                }
                if let permit = job.permit { guard permit.perform(transmit) else { throw RpcFailure("RPC_CANCELLED") } } else { transmit() }
                count += 1
            } catch { finish(job, .failure(error)) }
        }
    }
    private func connect() {
        epoch &+= 1; let token = epoch
        let next = factory(); wire = next; connectStarted = now()
        next.start(queue: queue, ready: { [weak self] in
            guard let self, self.epoch == token else { return }; self.ready = true; self.connectStarted = nil; self.pump()
        }, receive: { [weak self] bytes in
            guard let self, self.epoch == token else { return }; self.receive(bytes)
        }, failed: { [weak self] in
            guard let self, self.epoch == token else { return }; self.failWire("RPC_UNAVAILABLE")
        })
    }
    private func receive(_ bytes: Data) {
        buffer.append(bytes)
        do {
            while let end = buffer.firstIndex(of: 10) {
                let frame = Data(buffer[..<end]); buffer.removeSubrange(...end)
                let message = try JSON.decode(frame, maxBytes: subscriptions ? 16 * 1024 : 2 * 1024 * 1024)
                try dispatch(message, frame.count)
            }
            try walletRequire(buffer.count <= (subscriptions ? 16 * 1024 : 2 * 1024 * 1024), "RPC_PROTOCOL")
            pump()
        } catch { failWire("RPC_PROTOCOL") }
    }
    private func dispatch(_ message: JSONObject, _ bytes: Int) throws {
        try walletRequire(message.count == 3 && (message["jsonrpc"] as? String) == "2.0", "RPC_PROTOCOL")
        if let id = message["id"] as? String {
            guard let job = jobs[id], job.written, job.streamID == nil else { throw RpcFailure("RPC_PROTOCOL") }
            try walletRequire(message.has("result") != message.has("error"), "RPC_PROTOCOL")
            if message.has("error") {
                let remote = try message.object("error")
                var error = RpcFailure(String(try remote.integer("code", min: Int64(Int32.min), max: Int64(Int32.max))))
                if let details = remote["data"] as? JSONObject {
                    if let node = try? details.integer("node_code"), [-22, -25, -26, -27, -8].contains(node) { error.nodeCode = Int(node) }
                    if let delay = try? details.integer("retry_after_ms", min: 0) { error.retryAfterMs = Int(min(60_000, delay)) }
                }
                error.explicitRejection = error.code == "-32020" && error.nodeCode != nil
                error.unknownOutcome = job.method == "sendrawtransaction" && !error.explicitRejection
                if error.code == "-32029" { cooldowns[job.method] = now() + max(window, Double(error.retryAfterMs) / 1000) }
                finish(job, .failure(error)); return
            }
            let result = try message.object("result")
            if job.method == "getblockbounties" {
                let streamID = try result.string("stream_id")
                try walletRequire(result.count == 1 && streamID.range(of: "^[A-Za-z0-9_.-]{1,100}$", options: .regularExpression) != nil && !jobs.values.contains { $0.streamID == streamID }, "RPC_PROTOCOL")
                job.streamID = streamID
            } else {
                if job.method == "sendrawtransaction" { try walletRequire(result.count == 1 && Self.hash(try result.string("txid")), "RPC_PROTOCOL") }
                finish(job, .success(result))
            }
        } else {
            let method = try message.string("method"), params = try message.object("params")
            if subscriptions && method == "subscription" { notificationHandler?(message); return }
            let streamID = try params.string("stream_id")
            guard let job = jobs.values.first(where: { $0.streamID == streamID }) else { throw RpcFailure("RPC_PROTOCOL") }
            job.bytes += bytes; try walletRequire(job.bytes <= 64 * 1024 * 1024, "RPC_STREAM_LIMIT")
            if method == "stream.end" {
                try walletRequire(try params.boolean("complete") && params.integer("chunks") == Int64(job.sequence) && job.snapshot && job.state, "RPC_STREAM_INCOMPLETE")
                finish(job, .success(["chunks": job.chunks])); return
            }
            try walletRequire(method == "stream.chunk" && !job.state && job.sequence < 100_000, "RPC_PROTOCOL")
            try walletRequire(try params.integer("sequence") == Int64(job.sequence), "RPC_PROTOCOL"); job.sequence += 1
            let chunk = try params.object("items"), type = try chunk.string("type")
            _ = try chunk.object("tip")
            if !job.snapshot {
                try walletRequire(type == "snapshot" && (chunk["block_hash"] as? String) == (job.params["block_hash"] as? String) && (chunk["unit"] as? String) == "connects" && (try chunk.boolean("live")), "RPC_PROTOCOL")
                _ = try chunk.string("cursor"); job.snapshot = true
            } else if type == "bounties" {
                let items = try chunk.array("items"); job.rows += items.count
                try walletRequire(items.count <= 500 && job.rows <= 100_000, "RPC_STREAM_LIMIT")
            } else { try walletRequire(type == "state", "RPC_PROTOCOL"); _ = try chunk.string("cursor"); job.state = true }
            if job.completion != nil {
                try walletRequire(retainedStreamBytes + bytes <= 64 * 1024 * 1024, "RPC_STREAM_LIMIT")
                job.chunks.append(chunk); job.retainedBytes += bytes; retainedStreamBytes += bytes
            }
        }
    }
    private func remove(_ job: Job) {
        retainedStreamBytes -= job.retainedBytes; job.retainedBytes = 0
        jobs.removeValue(forKey: job.id); order.removeAll { $0 == job.id }
    }
    private func finish(_ job: Job, _ result: Result<JSONObject, Error>) {
        remove(job); let completion = job.completion; job.completion = nil; completion?(result)
    }
    private func failWire(_ code: String) {
        epoch &+= 1; wire?.cancel(); wire = nil; ready = false; connectStarted = nil; buffer.removeAll(keepingCapacity: false)
        for job in Array(jobs.values) {
            var error = RpcFailure(code); error.unknownOutcome = job.method == "sendrawtransaction" && job.written
            finish(job, .failure(error))
        }
        disconnectedHandler?()
    }
    private func tick() {
        let time = now()
        if let started = connectStarted, time - started > 40 { failWire("RPC_TIMEOUT"); return }
        for job in jobs.values {
            if let started = job.started, time - started >= (job.method == "getblockbounties" ? 120 : 40) { failWire("RPC_TIMEOUT"); return }
        }
        pump()
    }
    public static func hash(_ value: String) -> Bool { value.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil }
    public static func validateParams(_ method: String, _ params: JSONObject, subscriptions: Bool = false) throws -> JSONObject {
        let methods: [String: Set<String>] = ["getchaintip": [], "getrecentblockhashes": [],
            "getaddressbalance": ["address"], "getaddresshistory": ["address", "cursor"],
            "getaddressutxos": ["address", "cursor", "include_pending_spent"], "getaddresschanges": ["addresses", "cursor"],
            "gettransaction": ["txid"], "gettransactions": ["txids"], "getbountychanges": ["cursor"],
            "getblockbounties": ["block_hash"], "sendrawtransaction": ["transaction_hex"],
            "subscribeaddress": ["address", "changes_only"], "subscribetip": []]
        guard let allowed = methods[method], Set(params.keys).isSubset(of: allowed),
              subscriptions || !["subscribeaddress", "subscribetip"].contains(method) else { throw RpcFailure("RPC_INVALID") }
        if subscriptions { try walletRequire(["subscribeaddress","subscribetip","getchaintip"].contains(method), "RPC_INVALID") }
        var clean: JSONObject = [:]
        for key in allowed {
            guard let value = params[key] else { if ["cursor", "include_pending_spent"].contains(key) { continue }; throw RpcFailure("RPC_INVALID") }
            switch key {
            case "address":
                let text = try JSON.string(value); _ = try WalletCrypto.decodeAddress(text); clean[key] = text.lowercased()
            case "addresses":
                let addresses = try JSON.array(value); try walletRequire(!addresses.isEmpty && addresses.count <= 100, "RPC_INVALID")
                var normalized = [String]()
                for address in addresses { let text = try JSON.string(address); _ = try WalletCrypto.decodeAddress(text); normalized.append(text.lowercased()) }
                try walletRequire(Set(normalized).count == normalized.count,"RPC_INVALID"); clean[key] = normalized
            case "txid", "block_hash":
                let text = try JSON.string(value); try walletRequire(hash(text), "RPC_INVALID"); clean[key] = text.lowercased()
            case "txids":
                let ids = try JSON.array(value); try walletRequire(!ids.isEmpty && ids.count <= 32, "RPC_INVALID")
                var normalized = [String]()
                for id in ids { let text = try JSON.string(id); try walletRequire(hash(text),"RPC_INVALID"); normalized.append(text.lowercased()) }
                try walletRequire(Set(normalized).count == normalized.count,"RPC_INVALID"); clean[key] = normalized
            case "cursor":
                if value is NSNull { clean[key] = NSNull() }
                else { let text = try JSON.string(value); try walletRequire(text.range(of:"\\A[A-Za-z0-9_.-]{1,1024}\\z",options:.regularExpression) != nil,"RPC_INVALID"); clean[key] = text }
            case "include_pending_spent", "changes_only":
                let boolean = try JSON.boolean(value); try walletRequire(key != "changes_only" || boolean,"RPC_INVALID"); clean[key] = boolean
            case "transaction_hex":
                let hex = try JSON.string(value)
                try walletRequire(hex.count >= 20 && hex.count <= 800_000 && hex.count % 2 == 0 && hex.range(of: "\\A[0-9a-fA-F]+\\z", options: .regularExpression) != nil, "RPC_INVALID")
                clean[key] = hex.lowercased()
            default: throw RpcFailure("RPC_INVALID")
            }
        }
        return clean
    }
}
