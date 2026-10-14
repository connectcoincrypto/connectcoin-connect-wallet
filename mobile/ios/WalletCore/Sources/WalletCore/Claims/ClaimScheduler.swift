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
    var identity: ClaimCandidate.Identity?
    var prepared: JSONObject?
    var captures: UInt64 = 0
    var budgetExhausted = false
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

    /// Publish bounded accounting for both the canonical window and outputs
    /// whose funding block was just displaced. Their transaction may be mined
    /// again after a later stream/reset; losing this entry between those reads
    /// would reset the capture budget, priority factor and receipt history.
    /// This is metadata only: no orphaned preparation or proof is resurrected.
    static func reconcile(previous: [String: ClaimProgress], catalog: [String: ClaimCandidate],
                          window: ClaimRecentWindow, loaded: Set<String>, protected: Set<String>) throws -> [String: ClaimProgress] {
        var next = previous
        for row in catalog.values { next[row.key] = row.progress }
        let heights = window.heights, oldest = window.blocks.last!.height
        for (key, item) in next where !protected.contains(key) {
            if heights[item.block] != nil {
                if loaded.contains(item.block), catalog[key] == nil { next.removeValue(forKey: key) }
            } else if let identity = item.identity, identity.height >= oldest {
                // A rollback can leave the former height above today's tip.
                // It has not aged out; the same fixed total bound still applies.
                if item.prepared != nil {
                    let light = try ClaimProgress(block: item.block, policy: item.policy, factor: item.factor)
                    light.identity = identity; light.captures = item.captures; light.budgetExhausted = item.budgetExhausted
                    next[key] = light
                }
            } else { next.removeValue(forKey: key) }
        }
        try walletRequire(ClaimSubmissionRetry.validProgressCount(next.count), "CLAIMS_CAPACITY")
        // A relocated stream copies accounting before its asynchronous journal
        // and final fence. Old handles may drain while those reads await. Only
        // at publication, merge that newer accounting into the staged copy;
        // it has not admitted work, so these totals share the same prefix.
        // Validate all identities before touching any of the staged objects.
        for row in catalog.values {
            if let current = previous[row.key], current !== row.progress {
                try walletRequire(current.identity?.sameOutput(as: row.identity) == true, "CLAIMS_RPC_DATA")
            }
        }
        for row in catalog.values {
            if let current = previous[row.key], current !== row.progress {
                row.progress.captures = max(row.progress.captures, current.captures)
                row.progress.budgetExhausted = row.progress.budgetExhausted || current.budgetExhausted
            }
        }
        return next
    }

    /// Called once when the native handle drains, independently of whether
    /// its result can still be used by this lifecycle. The native budget may
    /// already include a capture which cancellation hid from the result.
    /// A reorg may have copied accounting into a new Progress while it ran;
    /// update that existing same-output copy too, never resurrect an entry.
    static func recordNativeCapture(_ captured: ClaimCandidate, hasCaptured: Bool, current: ClaimProgress?) {
        guard hasCaptured else { return }
        let original = captured.progress
        if original.captures != UInt64.max { original.captures += 1 }
        if let current, current !== original, let identity = current.identity,
           identity.sameOutput(as: captured.identity), current.captures != UInt64.max {
            current.captures += 1
        }
    }
}

struct ClaimCandidate {
    /// Status/confirmations change; the funding output and its chain location do not.
    struct Identity: Equatable {
        let key: String, block: String, domain: String, target: String
        let height: Int64, amount: Int64, roots: Int64, mask: Int32, coinbase: Bool
        func sameOutput(as other: Identity) -> Bool {
            key == other.key && domain == other.domain && target == other.target && amount == other.amount &&
                roots == other.roots && mask == other.mask && coinbase == other.coinbase
        }
    }
    let identity: Identity
    let bounty: JSONObject, key: String, domain: String, policy: String, target: String, block: String
    let height: Int64, mask: Int32, coinbase: Bool, supported: Bool
    let targetPlusOne: ClaimInteger, raw: ClaimInteger
    let captureStopCount: UInt64, outpointOrder: [UInt8], outputIndex: Int64
    private(set) var priority: ClaimInteger
    var state: String
    var spendingTxid: String?
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
        if let spender = source["spending_txid"], !(spender is NSNull) { spendingTxid = try PJ.hash(spender) }
        supported = roots == 1 && domain.contains(".") && !PJ.matches(domain, "[0-9]+(?:\\.[0-9]+){3}") &&
            ![".localhost", ".local", ".internal"].contains(where: domain.hasSuffix)
        targetPlusOne = try ClaimInteger(hex: target).plusOne()
        captureStopCount = targetPlusOne.captureStopCount
        let amount = try PJ.money(source, "amount")
        identity = Identity(key: key, block: block, domain: domain, target: target,
            height: height, amount: amount, roots: roots, mask: mask, coinbase: coinbase)
        raw = targetPlusOne.multiplied(UInt64(max(0, amount - fee)))
        progress = try ClaimProgress(block: block, policy: policy, factor: factor)
        priority = raw.multiplied(progress.factor)
        progress.identity = identity
    }
    var budget: Bool { !progress.budgetExhausted && progress.captures < captureStopCount }
    mutating func reuse(_ previous: ClaimProgress) throws {
        guard let old = previous.identity else { throw WalletError("CLAIMS_RPC_DATA") }
        try walletRequire(old.sameOutput(as: identity), "CLAIMS_RPC_DATA")
        if old.block == block {
            try walletRequire(old.height == height, "CLAIMS_RPC_DATA")
            progress = previous
        } else {
            // The same transaction may be mined again after a reorg. Its old
            // proposal/proof cannot survive relocation; its exact budget and
            // priority factor must not reset merely because the block moved.
            let relocated = try ClaimProgress(block: block, policy: policy, factor: previous.factor)
            relocated.identity = identity; relocated.captures = previous.captures
            relocated.budgetExhausted = previous.budgetExhausted
            progress = relocated
        }
    }
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
/// turns. Positive-reward policies get up to 32 calibration starts, then one
/// probe/minute; all probes share a no-credit four-starts/second global gate.
struct ClaimScheduler {
    final class Probe { var starts = 0; var nextDue = 0.0 }
    struct Entry { let row: ClaimCandidate, score: Double, recovering: Bool, transportDue: Double }
    final class Selection {
        let id = UUID()
        let row: ClaimCandidate, recovering: Bool, economic: Bool, serial: UInt64
        let selectedAt: Double, probe: Probe?
        var reserved = false, committed = false
        init(row: ClaimCandidate, recovering: Bool, economic: Bool, serial: UInt64, now: Double, probe: Probe?) {
            self.row = row; self.recovering = recovering; self.economic = economic; self.serial = serial
            selectedAt = now; self.probe = probe
        }
    }
    var groups: [String: [Int32: [Entry]]] = [:]
    private var names: [String] = []
    private var locations: [String: (String, Int32)] = [:]
    private var probes: [String: Probe] = [:]
    private var pendingProbe: Selection?
    private var nextGlobalProbe = 0.0
    var probeCount: Int { probes.count }
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
        let eligible = rows.filter { $0.supported && $0.state == "available" && !retired.contains($0.key) && $0.budget && $0.raw > ClaimInteger() }
        // Read/age each policy only once per refresh, not once per bounty.
        var rates: [String: Double] = [:]
        for row in eligible where rates[row.policy] == nil { rates[row.policy] = stats[row.policy]?.rate ?? 5 }
        let healthy = Set(eligible.filter { Self.worth($0, rate: rates[$0.policy]!) }.map(\.policy))
        var recovering: [String: ClaimCandidate] = [:]
        for row in eligible where !healthy.contains(row.policy) {
            if recovering[row.policy] == nil || ClaimCandidate.before(row, recovering[row.policy]!) { recovering[row.policy] = row }
        }
        let admitted = recovering.values.sorted(by: ClaimCandidate.before).prefix(256)
        let admittedKeys = Set(admitted.map(\.key))
        for row in admitted { _ = probeState(row.policy) }
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
    private mutating func probeState(_ policy: String) -> Probe {
        if let value = probes[policy] { return value }
        if probeOrder.count >= 256, let oldest = probeOrder.firstIndex(where: { $0 != pendingProbe?.row.policy }) {
            probes.removeValue(forKey: probeOrder.remove(at: oldest))
        }
        let value = Probe(); probeOrder.append(policy); probes[policy] = value
        return value
    }
    private mutating func probeReady(_ policy: String, now: Double) -> Bool {
        pendingProbe == nil && now >= nextGlobalProbe && now >= probeState(policy).nextDue
    }
    mutating func next(now: Double, prepared: Bool) -> Selection? {
        var reward: Entry?, first: Entry?, after: Entry?
        for domain in names {
            var best: Entry?
            for mask in groups[domain]!.values {
                guard let row = mask.first, row.transportDue <= now,
                      !row.recovering || probeReady(row.row.policy, now: now) else { continue }
                if best == nil || row.score > best!.score || row.score == best!.score && ClaimCandidate.before(row.row, best!.row) { best = row }
            }
            if let best, (best.row.progress.prepared != nil) == prepared {
                if first == nil { first = best }
                if after == nil && domain > domainAfter { after = best }
                if economic && (reward == nil || best.score > reward!.score || best.score == reward!.score && ClaimCandidate.before(best.row, reward!.row)) { reward = best }
            }
        }
        let selected = economic ? reward : after ?? first
        guard let selected else { return nil }
        return Selection(row: selected.row, recovering: selected.recovering, economic: economic, serial: serial,
                         now: now, probe: selected.recovering ? probeState(selected.row.policy) : nil)
    }
    @discardableResult mutating func reserve(_ selected: Selection, now: Double? = nil) -> Bool {
        let time = now ?? selected.selectedAt
        guard !selected.reserved && selected.serial == serial && (!selected.recovering ||
            (pendingProbe == nil && time >= nextGlobalProbe && time >= selected.probe!.nextDue)) else { return false }
        selected.reserved = true
        if !selected.economic { domainAfter = selected.row.domain }
        economic = !selected.economic
        serial &+= 1
        if selected.recovering { pendingProbe = selected }
        return true
    }
    @discardableResult mutating func acknowledge(_ selected: Selection, now: Double) -> Bool {
        guard selected.reserved && !selected.committed else { return false }
        selected.committed = true
        if selected.recovering {
            let probe = selected.probe!
            probe.starts = min(32, probe.starts + 1)
            probe.nextDue = max(probe.nextDue, now + (probe.starts < 32 ? 0.25 : 60))
            nextGlobalProbe = max(nextGlobalProbe, now + 0.25)
            if probes[selected.row.policy] === probe {
                probeOrder.removeAll { $0 == selected.row.policy }; probeOrder.append(selected.row.policy)
            }
        }
        release(selected)
        return true
    }
    mutating func release(_ selected: Selection) {
        if pendingProbe === selected { pendingProbe = nil }
    }
    mutating func remove(_ key: String) {
        guard let (domain, mask) = locations.removeValue(forKey: key) else { return }
        groups[domain]?[mask]?.removeAll { $0.row.key == key }
    }
    mutating func clear() { groups.removeAll(); names.removeAll(); locations.removeAll() }
}
