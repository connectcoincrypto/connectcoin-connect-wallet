import Foundation

// Fixed-width 352-bit unsigned arithmetic preserves exact target/EV priority
// ordering. Floating point is used only for the bounded measured-rate score.
struct ClaimInteger: Comparable, Equatable {
    var words = [UInt32](repeating: 0, count: 11)
    init(_ value: UInt64 = 0) { words[0] = UInt32(truncatingIfNeeded: value); words[1] = UInt32(value >> 32) }
    init(hex: String) throws {
        let bytes = try WalletCrypto.fromHex(hex)
        try walletRequire(bytes.count == 32, "CLAIMS_RPC_DATA")
        for (index, byte) in bytes.reversed().enumerated() { words[index / 4] |= UInt32(byte) << ((index % 4) * 8) }
    }
    func plusOne() -> ClaimInteger {
        var result = self
        for index in result.words.indices {
            let value = result.words[index].addingReportingOverflow(1)
            result.words[index] = value.partialValue
            if !value.overflow { break }
        }
        return result
    }
    func multiplied(_ value: UInt64) -> ClaimInteger {
        let factors = [UInt32(truncatingIfNeeded: value), UInt32(value >> 32)]
        var result = ClaimInteger()
        for (offset, factor) in factors.enumerated() where factor != 0 {
            var carry: UInt64 = 0
            for index in 0..<(words.count - offset) {
                let next = UInt64(words[index]) * UInt64(factor) + UInt64(result.words[index + offset]) + carry
                result.words[index + offset] = UInt32(truncatingIfNeeded: next)
                carry = next >> 32
            }
        }
        return result
    }
    static func < (lhs: ClaimInteger, rhs: ClaimInteger) -> Bool {
        for index in lhs.words.indices.reversed() where lhs.words[index] != rhs.words[index] { return lhs.words[index] < rhs.words[index] }
        return false
    }
    var floating: Double { words.reversed().reduce(0) { $0 * 4_294_967_296 + Double($1) } }
    static var twiceSpace: ClaimInteger { var value = ClaimInteger(); value.words[8] = 2; return value }
    /// First forbidden successful capture, cached once per immutable target.
    /// The fixed-width product is exact (257 + 64 bits fit our 352 bits).
    var captureStopCount: UInt64 {
        var low: UInt64 = 0, high = UInt64.max
        while low < high {
            let middle = low + (high - low) / 2
            if multiplied(middle) > .twiceSpace { high = middle } else { low = middle + 1 }
        }
        return low // UInt64 saturation is forbidden even for the hardest target.
    }
}

final class ClaimProgress {
    let factor: UInt64, block: String, policy: String
    var prepared: JSONObject?
    var captures: UInt64 = 0
    init(block: String, policy: String, factor: UInt64? = nil) throws {
        self.block = block; self.policy = policy
        if let factor {
            try walletRequire((1_000_000...1_100_000).contains(factor), "CLAIMS_PRIORITY_FACTOR")
            self.factor = factor; return
        }
        var random: UInt64
        repeat { random = try WalletCrypto.random(4).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } }
        while random >= (UInt64(1) << 32) / 100_001 * 100_001
        self.factor = 1_000_000 + random % 100_001
    }
}

struct ClaimCandidate {
    let bounty: JSONObject, key: String, domain: String, policy: String, target: String, block: String
    let height: Int64, mask: Int32, coinbase: Bool, supported: Bool
    let targetPlusOne: ClaimInteger, raw: ClaimInteger
    let captureStopCount: UInt64, outpointOrder: [UInt8], outputIndex: Int64
    private(set) var priority: ClaimInteger
    var state: String
    var progress: ClaimProgress { didSet { priority = raw.multiplied(progress.factor) } }
    init(_ source: JSONObject, block expectedBlock: String, fee: Int64, factor: UInt64? = nil) throws {
        bounty = try JSON.clone(source)
        key = try PJ.outpoint(source); target = try PJ.hash(source["connection_work_target"])
        outpointOrder = Array(try WalletCrypto.fromHex(String(key.prefix(64))).reversed())
        outputIndex = try PJ.integer(source["vout"], 0, 0xffff_ffff)
        block = try PJ.hash(source["block_hash"])
        try walletRequire(block == expectedBlock, "CLAIMS_RPC_DATA")
        height = try PJ.integer(source["block_height"], 0, 9_007_199_254_740_991)
        _ = try PJ.integer(source["confirmations"], 1, 9_007_199_254_740_991)
        coinbase = try PJ.bool(source["coinbase"])
        mask = Int32(try PJ.integer(source["signature_algorithms_mask"], 1, 7))
        let roots = try PJ.integer(source["root_certificates_version"], 1, 0xffff_ffff)
        domain = try PJ.string(source["domain"])
        try walletRequire(NativeTransactions.canonicalDomain(domain), "CLAIMS_RPC_DATA")
        policy = domain + ":" + String(mask)
        state = try PJ.string(source["status"])
        try walletRequire(["available", "immature", "pending_spend", "spent"].contains(state), "CLAIMS_RPC_DATA")
        supported = roots == 1 && domain.contains(".") && !PJ.matches(domain, "[0-9]+(?:\\.[0-9]+){3}") &&
            ![".localhost", ".local", ".internal"].contains(where: domain.hasSuffix)
        targetPlusOne = try ClaimInteger(hex: target).plusOne()
        captureStopCount = targetPlusOne.captureStopCount
        let amount = try PJ.money(source, "amount")
        raw = targetPlusOne.multiplied(UInt64(max(0, amount - fee)))
        progress = try ClaimProgress(block: block, policy: policy, factor: factor)
        priority = raw.multiplied(progress.factor)
    }
    var budget: Bool { progress.captures < captureStopCount }
    static func before(_ a: ClaimCandidate, _ b: ClaimCandidate) -> Bool {
        if a.priority != b.priority { return a.priority > b.priority }
        // Core uint256 outpoint ordering compares display-order txids backwards.
        if a.outpointOrder != b.outpointOrder { return a.outpointOrder.lexicographicallyPrecedes(b.outpointOrder) }
        return a.outputIndex < b.outputIndex
    }
}

/// Fixed 60 one-minute buckets; no per-attempt allocations or EMA decay. The
/// permanent five-valid-connections / one-second prior is not a real counter.
/// The owner actor serializes access, including scheduler reads that age data.
final class ClaimPerformanceWindow {
    private var counts = [Int64](repeating: 0, count: 60)
    private var successes = [Int64](repeating: 0, count: 60)
    private var seconds = [Double](repeating: 0, count: 60)
    private var minute: Int64?
    private let clock: () -> Double
    private(set) var observations: Int64 = 0, connections: Int64 = 0
    private(set) var totalTime = 0.0
    var completed: Int64 = 0
    var retryAfter: Double = 0
    init(clock: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) { self.clock = clock }
    func advance() {
        let reading = clock()
        let measured = reading.isFinite ? Int64((min(9_007_199_254_740_991, max(0, reading)) / 60).rounded(.down)) : minute ?? 0
        let current = max(minute ?? measured, measured)
        guard let previous = minute else { minute = current; return }
        guard previous != current else { return }
        if current - previous >= 60 {
            for slot in counts.indices { counts[slot] = 0; successes[slot] = 0; seconds[slot] = 0 }
        } else {
            for next in (previous + 1)...current {
                let slot = Int(next % 60); counts[slot] = 0; successes[slot] = 0; seconds[slot] = 0
            }
        }
        observations = counts.reduce(0, +); connections = successes.reduce(0, +); totalTime = seconds.reduce(0, +)
        minute = current
    }
    var rate: Double {
        advance()
        return max(Double.leastNonzeroMagnitude, min(Double.greatestFiniteMagnitude, (5 + Double(connections)) / (1 + totalTime)))
    }
    func record(_ success: Bool, _ duration: Double) {
        guard duration.isFinite && (0...60).contains(duration) else { return }
        advance(); let slot = Int(minute! % 60)
        counts[slot] += 1; observations += 1
        if success { successes[slot] += 1; connections += 1 }
        seconds[slot] += duration; totalTime += duration
        completed = min(9_007_199_254_740_991, completed + 1)
    }
}

/// A cached leader for each domain/mask. Fair domain turns alternate with EV
/// turns; low-observed-rate recovery probes are bounded to one per minute.
struct ClaimScheduler {
    struct Entry { let row: ClaimCandidate, score: Double, recovering: Bool, transportDue: Double }
    final class Selection {
        let id = UUID()
        let row: ClaimCandidate, recovering: Bool, economic: Bool, serial: UInt64
        var reserved = false, committed = false
        init(row: ClaimCandidate, recovering: Bool, economic: Bool, serial: UInt64) {
            self.row = row; self.recovering = recovering; self.economic = economic; self.serial = serial
        }
    }
    var groups: [String: [Int32: [Entry]]] = [:]
    private var names: [String] = []
    private var locations: [String: (String, Int32)] = [:]
    var probeDue: [String: Double] = [:]
    var pendingProbes: [String: UUID] = [:]
    private var probeOrder: [String] = []
    private var economic = false
    private var domainAfter = ""
    private var serial: UInt64 = 0
    static func score(_ raw: ClaimInteger, rate: Double, scale: Double = 1) -> Double {
        guard rate.isFinite && rate > 0 && scale.isFinite && scale > 0 else { return .nan }
        let expected = raw.floating / pow(2, 256), value = expected * rate / scale
        return value == .infinity ? min(Double.greatestFiniteMagnitude, expected / scale * rate) : value
    }
    static func worth(_ row: ClaimCandidate, rate: Double) -> Bool { score(row.raw, rate: rate) >= 1000 }
    mutating func rebuild(_ rows: [ClaimCandidate], stats: [String: ClaimPerformanceWindow], retired: Set<String>, now: Double) {
        groups.removeAll(keepingCapacity: true)
        locations.removeAll(keepingCapacity: true)
        let policies = Set(rows.map(\.policy))
        probeDue = probeDue.filter { policies.contains($0.key) }
        probeOrder.removeAll { probeDue[$0] == nil }
        let eligible = rows.filter { $0.supported && $0.state == "available" && !retired.contains($0.key) && $0.budget && $0.raw > ClaimInteger() }
        // Read/age each policy only once per refresh, not once per bounty.
        var rates: [String: Double] = [:]
        for row in eligible where rates[row.policy] == nil { rates[row.policy] = stats[row.policy]?.rate ?? 5 }
        let healthy = Set(eligible.filter { Self.worth($0, rate: rates[$0.policy]!) }.map(\.policy))
        var recovering: [String: ClaimCandidate] = [:]
        for row in eligible where !healthy.contains(row.policy) && Self.worth(row, rate: 5) {
            if recovering[row.policy] == nil || ClaimCandidate.before(row, recovering[row.policy]!) { recovering[row.policy] = row }
        }
        let admitted = recovering.values.sorted(by: ClaimCandidate.before).prefix(256)
        let admittedKeys = Set(admitted.map(\.key))
        for row in admitted { _ = due(row.policy, now: now) }
        for row in eligible {
            let rate = rates[row.policy]!
            let recovery = !Self.worth(row, rate: rate)
            if recovery && !admittedKeys.contains(row.key) { continue }
            let value = Self.score(row.priority, rate: rate, scale: 1_000_000)
            guard value.isFinite else { continue }
            groups[row.domain, default: [:]][row.mask, default: []].append(
                Entry(row: row, score: value, recovering: recovery, transportDue: stats[row.policy]?.retryAfter ?? 0))
            locations[row.key] = (row.domain, row.mask)
        }
        names = groups.keys.sorted()
        for domain in groups.keys { for mask in groups[domain]!.keys {
            groups[domain]![mask]!.sort { ClaimCandidate.before($0.row, $1.row) }
        } }
    }
    private mutating func due(_ policy: String, now: Double) -> Double {
        if let value = probeDue[policy] { return value }
        if probeOrder.count >= 256 { probeDue.removeValue(forKey: probeOrder.removeFirst()) }
        probeOrder.append(policy); probeDue[policy] = now + 60
        return now + 60
    }
    mutating func next(now: Double, prepared: Bool) -> Selection? {
        var reward: Entry?, first: Entry?, after: Entry?
        for domain in names {
            var best: Entry?
            for mask in groups[domain]!.values {
                guard let row = mask.first, row.transportDue <= now,
                      !row.recovering || (pendingProbes[row.row.policy] == nil && due(row.row.policy, now: now) <= now) else { continue }
                if best == nil || row.score > best!.score || row.score == best!.score && ClaimCandidate.before(row.row, best!.row) { best = row }
            }
            if let best, (best.row.progress.prepared != nil) == prepared {
                if first == nil { first = best }
                if after == nil && domain > domainAfter { after = best }
                if economic && (reward == nil || best.score > reward!.score || best.score == reward!.score && ClaimCandidate.before(best.row, reward!.row)) { reward = best }
            }
        }
        let selected = economic ? reward : after ?? first
        return selected.map { Selection(row: $0.row, recovering: $0.recovering, economic: economic, serial: serial) }
    }
    @discardableResult mutating func reserve(_ selected: Selection) -> Bool {
        guard !selected.reserved && selected.serial == serial && (!selected.recovering || pendingProbes[selected.row.policy] == nil) else { return false }
        selected.reserved = true
        if !selected.economic { domainAfter = selected.row.domain }
        economic = !selected.economic
        serial &+= 1
        if selected.recovering { pendingProbes[selected.row.policy] = selected.id }
        return true
    }
    @discardableResult mutating func acknowledge(_ selected: Selection, now: Double) -> Bool {
        guard selected.reserved && !selected.committed else { return false }
        selected.committed = true
        if selected.recovering {
            _ = due(selected.row.policy, now: now)
            probeOrder.removeAll { $0 == selected.row.policy }; probeOrder.append(selected.row.policy)
            probeDue[selected.row.policy] = now + 60
        }
        release(selected)
        return true
    }
    mutating func release(_ selected: Selection) {
        if selected.recovering && pendingProbes[selected.row.policy] == selected.id { pendingProbes.removeValue(forKey: selected.row.policy) }
    }
    mutating func remove(_ key: String) {
        guard let (domain, mask) = locations.removeValue(forKey: key) else { return }
        groups[domain]?[mask]?.removeAll { $0.row.key == key }
    }
    mutating func clear() { groups.removeAll(); names.removeAll(); locations.removeAll() }
}
