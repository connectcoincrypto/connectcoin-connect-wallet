import Foundation
import Network

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

final class NetworkRpcWire: RpcWire {
    let connection: NWConnection
    init(_ endpoint: TcpEndpoint) {
        let options = NWProtocolTCP.Options(); options.noDelay = true
        options.enableKeepalive = true
        connection = NWConnection(host: NWEndpoint.Host(endpoint.hostname), port: NWEndpoint.Port(rawValue: endpoint.port)!, using: NWParameters(tls: nil, tcp: options))
    }
    func start(queue: DispatchQueue, ready: @escaping () -> Void, receive: @escaping (Data) -> Void, failed: @escaping () -> Void) {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: ready(); self?.read(receive, failed)
            case .failed: failed()
            default: break
            }
        }
        connection.start(queue: queue)
    }
    private func read(_ receive: @escaping (Data) -> Void, _ failed: @escaping () -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            if let data, !data.isEmpty { receive(data) }
            if complete || error != nil { failed() } else { self?.read(receive, failed) }
        }
    }
    func send(_ bytes: Data, completed: @escaping (Bool) -> Void) {
        connection.send(content: bytes, completion: .contentProcessed { completed($0 == nil) })
    }
    func cancel() { connection.stateUpdateHandler = nil; connection.cancel() }
}

/// One multiplexed TCP connection, 16 in-flight requests, 48 total operations.
/// Quota waits never consume request timeout, nor occupy an in-flight slot.
public final class MobileRpcClient {
    public typealias Completion = (Result<JSONObject, Error>) -> Void
    private final class Cancellation {
        private let lock = NSLock()
        private var cancelled = false
        func cancel() { lock.lock(); cancelled = true; lock.unlock() }
        var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    }
    private final class Job {
        let id: String, method: String
        let params: JSONObject
        var completion: Completion?
        var started: TimeInterval?
        var written = false
        var streamID: String?
        var sequence = 0, rows = 0, bytes = 0
        var snapshot = false, state = false
        var chunks: [JSONObject] = []
        init(_ id: String, _ method: String, _ params: JSONObject, _ completion: @escaping Completion) {
            self.id = id; self.method = method; self.params = params; self.completion = completion
        }
    }
    private let queue = DispatchQueue(label: "connectwallet.ios.rpc")
    private let factory: () -> RpcWire
    private let now: () -> TimeInterval
    private let window: TimeInterval
    private var wire: RpcWire?, ready = false, active = false
    private var epoch: UInt64 = 0
    private var buffer = Data()
    private var jobs: [String: Job] = [:], order: [String] = []
    private var history: [String: [TimeInterval]] = [:], cooldowns: [String: TimeInterval] = [:]
    private var timer: DispatchSourceTimer?
    private var connectStarted: TimeInterval?
    // Listener-only clients are constructed natively. UI query never exposes these methods.
    private let subscriptions: Bool
    public var notification: ((JSONObject) -> Void)?
    public var disconnected: (() -> Void)?

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
        queue.async { self.active = value; if !value { self.failWire("RPC_CANCELLED") } else { self.pump() } }
    }
    public func cancelAll() { queue.async { self.failWire("RPC_CANCELLED") } }
    public func call(_ method: String, _ params: JSONObject = [:]) async throws -> JSONObject {
        try walletRequire(!["sendrawtransaction", "getblockbounties"].contains(method), "Unsupported native RPC method")
        return try await operation(method, params)
    }
    public func broadcast(_ hex: String) async throws -> JSONObject { try await operation("sendrawtransaction", ["transaction_hex": hex]) }
    /// Chunks are published only after a verified stream.end, never on an incomplete snapshot.
    public func streamBounties(_ hash: String) async throws -> [JSONObject] {
        let result = try await operation("getblockbounties", ["block_hash": hash])
        return try result.array("chunks").map { try JSON.object($0) }
    }
    private func operation(_ method: String, _ params: JSONObject) async throws -> JSONObject {
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
                        self.jobs[id] = Job(id, method, clean) { continuation.resume(with: $0) }
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
        if !job.written { remove(job); pump() }
        // A written request retains its ID until reply/timeout, so late replies do
        // not corrupt unrelated payments. No cancellation ever auto-retries a send.
    }
    private func quotaKeys(_ job: Job) -> [(String, Int)] {
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
        let waiting = order.compactMap { jobs[$0] }.filter { !$0.written && eligible($0, time) }
        guard !waiting.isEmpty else { return }
        if wire == nil { connect() }; guard ready, let wire else { return }
        var count = jobs.values.filter { $0.written }.count
        for job in waiting where count < 16 {
            guard eligible(job, time) else { continue }
            do {
                var bytes = try JSON.encode(["jsonrpc": "2.0", "id": job.id, "method": job.method, "params": job.params])
                try walletRequire(bytes.count <= 1024 * 1024, "RPC_INVALID"); bytes.append(10)
                for (key, _) in quotaKeys(job) { history[key, default: []].append(time) }
                job.started = time; job.written = true; count += 1
                let epoch = self.epoch
                wire.send(bytes) { [weak self] success in
                    guard let self else { return }; self.queue.async { if !success && self.epoch == epoch { self.failWire("RPC_UNAVAILABLE") } }
                }
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
                // Validation/rate-limit errors received from the service are proven rejection.
                if ["-32029", "-32602", "-32601"].contains(error.code) { error.explicitRejection = true }
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
            if subscriptions && method == "subscription" { notification?(message); return }
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
            if job.completion != nil { job.chunks.append(chunk) }
        }
    }
    private func remove(_ job: Job) { jobs.removeValue(forKey: job.id); order.removeAll { $0 == job.id } }
    private func finish(_ job: Job, _ result: Result<JSONObject, Error>) {
        remove(job); let completion = job.completion; job.completion = nil; completion?(result)
    }
    private func failWire(_ code: String) {
        epoch &+= 1; wire?.cancel(); wire = nil; ready = false; connectStarted = nil; buffer.removeAll(keepingCapacity: false)
        for job in Array(jobs.values) {
            var error = RpcFailure(code); error.unknownOutcome = job.method == "sendrawtransaction" && job.written
            finish(job, .failure(error))
        }
        disconnected?()
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
        for key in allowed {
            guard let value = params[key] else { if ["cursor", "include_pending_spent"].contains(key) { continue }; throw RpcFailure("RPC_INVALID") }
            switch key {
            case "address": _ = try WalletCrypto.decodeAddress(JSON.string(value))
            case "addresses":
                let addresses = try JSON.array(value); try walletRequire(!addresses.isEmpty && addresses.count <= 10_000, "RPC_INVALID")
                for address in addresses { _ = try WalletCrypto.decodeAddress(JSON.string(address)) }
            case "txid", "block_hash": try walletRequire(hash(try JSON.string(value)), "RPC_INVALID")
            case "txids":
                let ids = try JSON.array(value); try walletRequire(!ids.isEmpty && ids.count <= 100, "RPC_INVALID")
                for id in ids { try walletRequire(hash(try JSON.string(id)), "RPC_INVALID") }
            case "cursor": try walletRequire(try JSON.string(value).utf8.count <= 2048, "RPC_INVALID")
            case "include_pending_spent", "changes_only": _ = try JSON.boolean(value)
            case "transaction_hex":
                let hex = try JSON.string(value)
                try walletRequire(!hex.isEmpty && hex.count <= 800_000 && hex.count % 2 == 0 && hex.range(of: "^[0-9a-fA-F]+$", options: .regularExpression) != nil, "RPC_INVALID")
            default: throw RpcFailure("RPC_INVALID")
            }
        }
        return try JSON.clone(params)
    }
}
