import Foundation

/// Cancellable public reads with a bounded cache of authenticated, stripped
/// parents. The cache never authenticates balances, ownership, or spendability.
public final class MobilePaymentFunding {
    public static let MAX_CACHE_ENTRIES = 8192, MAX_RETAINED_HEX = 16 * 1024 * 1024
    public static let MAX_PREPARATION_MS: Int64 = 15 * 60 * 1000
    public typealias Reader = (String, JSONObject) async throws -> JSONObject
    public typealias Check = () throws -> Void
    public typealias Progress = (String, Int, Int, Int64) -> Void
    private final class Node {
        let id: String, raw: String
        weak var previous: Node?
        var next: Node?
        init(_ id: String, _ raw: String) { self.id = id; self.raw = raw }
    }
    private let maxEntries: Int, maxCharacters: Int, clock: () -> Int64, sleeper: (Int64) async throws -> Void
    private let lock = NSLock()
    private var cache = [String: Node](), oldest: Node?, newest: Node?, characters = 0
    public init(maxEntries: Int = MAX_CACHE_ENTRIES, maxCharacters: Int = MAX_RETAINED_HEX,
                clock: @escaping () -> Int64 = { Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000) },
                sleeper: @escaping (Int64) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0) * 1_000_000) }) throws {
        try PJ.require((1...Self.MAX_CACHE_ENTRIES).contains(maxEntries) && (1...Self.MAX_RETAINED_HEX).contains(maxCharacters), "Invalid payment cache limits.")
        self.maxEntries = maxEntries; self.maxCharacters = maxCharacters; self.clock = clock; self.sleeper = sleeper
    }
    public func session(reader: @escaping Reader, check: @escaping Check, progress: @escaping Progress) -> Session { Session(self, reader, check, progress) }
    public final class Session {
        private let owner: MobilePaymentFunding, reader: Reader, cancellation: Check, progress: Progress, started: Int64
        fileprivate init(_ owner: MobilePaymentFunding, _ reader: @escaping Reader, _ check: @escaping Check, _ progress: @escaping Progress) {
            self.owner = owner; self.reader = reader; cancellation = check; self.progress = progress; started = owner.clock()
        }
        public func check() throws {
            try cancellation(); try Task.checkCancellation()
            try PJ.require(owner.clock() - started < MobilePaymentFunding.MAX_PREPARATION_MS, "Payment preparation timed out. Review again to resume verified funding downloads.")
        }
        fileprivate func report(_ stage: String, _ completed: Int, _ total: Int, _ retryAfterMs: Int64) throws { try check(); progress(stage, completed, total, retryAfterMs); try check() }
        public func read(_ method: String, _ params: JSONObject, _ stage: String, _ completed: Int, _ total: Int) async throws -> JSONObject {
            try PJ.require(["gettransactions", "getaddressutxos", "getaddresschanges", "getchaintip"].contains(method), "Payment preparation permits public reads only.")
            while true {
                try report(stage, completed, total, 0)
                do { let result = try await checkedRead(method, params); try check(); return result }
                catch {
                    try check()
                    guard let rpc = error as? RpcFailure, !rpc.unknownOutcome, ["-32029", "-32030"].contains(rpc.code) else { throw error }
                    let minimum: Int64 = rpc.code == "-32029" ? 60_000 : 1_000
                    try await waitFor(max(minimum, Int64(rpc.retryAfterMs)), completed, total)
                }
            }
        }
        private func checkedRead(_ method: String, _ params: JSONObject) async throws -> JSONObject {
            // The attempt budget and wallet revocation must also apply while
            // transport is waiting in its quota queue, not just between replies.
            try await withThrowingTaskGroup(of: JSONObject.self) { tasks in
                tasks.addTask { try await self.reader(method, params) }
                tasks.addTask {
                    while true { try self.check(); try await Task.sleep(nanoseconds: 100_000_000) }
                }
                defer { tasks.cancelAll() }
                guard let result = try await tasks.next() else { throw CancellationError() }; return result
            }
        }
        private func waitFor(_ delay: Int64, _ completed: Int, _ total: Int) async throws {
            let began = owner.clock(); var lastSeconds: Int64 = -1
            while true {
                try check(); let elapsed = owner.clock() - began; if elapsed >= delay { return }
                let remaining = delay - elapsed, seconds = remaining / 1000 + (remaining % 1000 == 0 ? 0 : 1)
                if seconds != lastSeconds { try report("waiting", completed, total, remaining); lastSeconds = seconds }
                try await owner.sleeper(min(100, remaining))
            }
        }
    }
    public func load(_ selected: [JSONObject], _ publicKey: String, _ session: Session) async throws -> [JSONObject] { try await load(selected, owner: { _ in publicKey }, session) }
    public func load(_ selected: [JSONObject], owner: (JSONObject) throws -> String, _ session: Session) async throws -> [JSONObject] {
        try session.check(); try PJ.require(!selected.isEmpty && selected.count <= NativeTransactions.MAX_PAYMENT_INPUTS, "Invalid selected payment inputs.")
        var outpoints = Set<String>(), ids = [String](), seenIDs = Set<String>(), parents = [String: String]()
        for row in selected {
            try session.check(); try PJ.require(outpoints.insert(PJ.outpoint(row)).inserted, "Invalid selected payment output."); _ = try PJ.money(row, "amount")
            let id = try PJ.hash(row["txid"]); if seenIDs.insert(id).inserted { ids.append(id) }
        }
        var completed = 0, retained = 0, missing = [String]()
        for id in ids {
            try session.check()
            if let raw = cached(id) { retained = try retain(retained, raw); parents[id] = raw; completed += 1 } else { missing.append(id) }
        }
        try session.report("funding", completed, ids.count, 0); var next = 0
        while next < missing.count {
            try session.check(); let requested = Array(missing[next..<min(next + 32, missing.count)])
            let response = try await session.read("gettransactions", ["txids": requested], "funding", completed, ids.count)
            let compact = try NativePaymentChecks.fundingTransactions(response, requested, check: session.check)
            for item in compact {
                try session.check(); let raw = try PJ.string(item["hex"]), id = try PJ.string(item["txid"])
                retained = try retain(retained, raw); parents[id] = raw; remember(id, raw); next += 1; completed += 1
                try session.report("funding", completed, ids.count, 0)
            }
        }
        var result = [JSONObject]()
        for source in selected {
            try session.check(); var row = PJ.snapshot(source)
            guard let raw = parents[try PJ.string(source["txid"])] else { throw WalletError("Missing verified funding transaction.") }
            row["rawTransaction"] = raw; result.append(row)
        }
        try NativeTransactions.verifyFundingBatch(result, owner: owner, check: session.check); try session.check(); return result
    }
    private func retain(_ retained: Int, _ hex: String) throws -> Int {
        try PJ.require(hex.utf8.count <= Self.MAX_RETAINED_HEX - retained, "Selected funding exceeds the mobile memory limit."); return retained + hex.utf8.count
    }
    private func unlink(_ node: Node) {
        if let before = node.previous { before.next = node.next } else { oldest = node.next }
        if let after = node.next { after.previous = node.previous } else { newest = node.previous }
        node.previous = nil; node.next = nil
    }
    private func append(_ node: Node) { node.previous = newest; newest?.next = node; newest = node; if oldest == nil { oldest = node } }
    private func cached(_ id: String) -> String? {
        lock.lock(); defer { lock.unlock() }; guard let node = cache[id] else { return nil }; unlink(node); append(node); return node.raw
    }
    private func remember(_ id: String, _ raw: String) {
        lock.lock(); defer { lock.unlock() }; guard raw.utf8.count <= maxCharacters else { return }
        if let previous = cache.removeValue(forKey: id) { unlink(previous); characters -= previous.raw.utf8.count }
        while let node = oldest, cache.count >= maxEntries || characters > maxCharacters - raw.utf8.count { unlink(node); cache.removeValue(forKey: node.id); characters -= node.raw.utf8.count }
        let node = Node(id, raw); cache[id] = node; append(node); characters += raw.utf8.count
    }
    public var cachedCount: Int { lock.lock(); defer { lock.unlock() }; return cache.count }
    public var cachedCharacters: Int { lock.lock(); defer { lock.unlock() }; return characters }
}
