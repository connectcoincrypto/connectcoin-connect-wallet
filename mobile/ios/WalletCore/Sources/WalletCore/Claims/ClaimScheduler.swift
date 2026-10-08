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
    var state: String, progress: ClaimProgress
    init(_ source: JSONObject, block expectedBlock: String, fee: Int64, factor: UInt64? = nil) throws {
        bounty = try JSON.clone(source)
        key = try PJ.outpoint(source); target = try PJ.hash(source["connection_work_target"])
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
        let amount = try PJ.money(source, "amount")
        raw = targetPlusOne.multiplied(UInt64(max(0, amount - fee)))
        progress = try ClaimProgress(block: block, policy: policy, factor: factor)
    }
    var priority: ClaimInteger { raw.multiplied(progress.factor) }
    var budget: Bool { progress.captures < UInt64.max && targetPlusOne.multiplied(progress.captures) <= .twiceSpace }
    static func before(_ a: ClaimCandidate, _ b: ClaimCandidate) -> Bool {
        if a.priority != b.priority { return a.priority > b.priority }
        let aHash = String(a.key.prefix(64)), bHash = String(b.key.prefix(64))
        // Core uint256 outpoint ordering compares display-order txids backwards.
        let aBytes = Array(aHash.utf8), bBytes = Array(bHash.utf8)
        for i in stride(from: 62, through: 0, by: -2) {
            if aBytes[i] != bBytes[i] { return aBytes[i] < bBytes[i] }
            if aBytes[i + 1] != bBytes[i + 1] { return aBytes[i + 1] < bBytes[i + 1] }
        }
        return ((a.bounty["vout"] as? NSNumber)?.uint64Value ?? 0) < ((b.bounty["vout"] as? NSNumber)?.uint64Value ?? 0)
    }
}

struct ClaimEMA {
    var connections = 0.1, totalTime = 0.02
    var completed: Int64 = 0
    var retryAfter: Double = 0
    var rate: Double { max(Double.leastNonzeroMagnitude, min(Double.greatestFiniteMagnitude, connections / max(Double.leastNonzeroMagnitude, totalTime))) }
    mutating func record(_ success: Bool, _ seconds: Double) {
        connections = 0.999 * connections + 0.001 * (success ? 1 : 0)
        totalTime = 0.999 * totalTime + 0.001 * seconds
        completed = min(9_007_199_254_740_991, completed + 1)
    }
}

/// A cached leader for each domain/mask. Fair domain turns alternate with EV
/// turns; low-observed-rate recovery probes are bounded to one per minute.
struct ClaimScheduler {
    struct Entry { let row: ClaimCandidate, score: Double, recovering: Bool, transportDue: Double }
    struct Selection { let row: ClaimCandidate, recovering: Bool, economic: Bool }
    var groups: [String: [Int32: [Entry]]] = [:]
    var probeDue: [String: Double] = [:]
    var pendingProbes = Set<String>()
    private var economic = false
    private var domainAfter = ""
    static func score(_ raw: ClaimInteger, rate: Double, scale: Double = 1) -> Double {
        raw.floating / pow(2, 256) * rate / scale
    }
    static func worth(_ row: ClaimCandidate, rate: Double) -> Bool { score(row.raw, rate: rate) >= 1000 }
    mutating func rebuild(_ rows: [ClaimCandidate], stats: [String: ClaimEMA], retired: Set<String>, now: Double) {
        groups.removeAll(keepingCapacity: true)
        let policies = Set(rows.map(\.policy))
        probeDue = probeDue.filter { policies.contains($0.key) }
        let eligible = rows.filter { $0.supported && $0.state == "available" && !retired.contains($0.key) && $0.budget && $0.raw > ClaimInteger() }
        let healthy = Set(eligible.filter { Self.worth($0, rate: stats[$0.policy]?.rate ?? 5) }.map(\.policy))
        var recovering: [String: ClaimCandidate] = [:]
        for row in eligible where !healthy.contains(row.policy) && Self.worth(row, rate: 5) {
            if recovering[row.policy] == nil || ClaimCandidate.before(row, recovering[row.policy]!) { recovering[row.policy] = row }
        }
        let admitted = recovering.values.sorted(by: ClaimCandidate.before).prefix(256)
        let admittedKeys = Set(admitted.map(\.key))
        for row in admitted where probeDue[row.policy] == nil { probeDue[row.policy] = now + 60 }
        for row in eligible {
            let rate = stats[row.policy]?.rate ?? 5
            let recovery = !Self.worth(row, rate: rate)
            if recovery && !admittedKeys.contains(row.key) { continue }
            let value = Self.score(row.priority, rate: rate, scale: 1_000_000)
            guard value.isFinite else { continue }
            groups[row.domain, default: [:]][row.mask, default: []].append(
                Entry(row: row, score: value, recovering: recovery, transportDue: stats[row.policy]?.retryAfter ?? 0))
        }
        for domain in groups.keys { for mask in groups[domain]!.keys {
            groups[domain]![mask]!.sort { ClaimCandidate.before($0.row, $1.row) }
        } }
    }
    func next(now: Double, prepared: Bool) -> Selection? {
        var leaders: [Entry] = []
        for domain in groups.keys.sorted() {
            var best: Entry?
            for mask in groups[domain]!.values {
                guard let row = mask.first, row.transportDue <= now,
                      !row.recovering || (!pendingProbes.contains(row.row.policy) && (probeDue[row.row.policy] ?? now + 60) <= now) else { continue }
                if best == nil || row.score > best!.score || row.score == best!.score && ClaimCandidate.before(row.row, best!.row) { best = row }
            }
            if let best, (best.row.progress.prepared != nil) == prepared { leaders.append(best) }
        }
        let selected: Entry?
        if economic { selected = leaders.sorted { $0.score == $1.score ? ClaimCandidate.before($0.row, $1.row) : $0.score > $1.score }.first }
        else { selected = leaders.first { $0.row.domain > domainAfter } ?? leaders.first }
        return selected.map { Selection(row: $0.row, recovering: $0.recovering, economic: economic) }
    }
    mutating func reserve(_ selected: Selection) {
        if !selected.economic { domainAfter = selected.row.domain }
        economic = !selected.economic
        if selected.recovering { pendingProbes.insert(selected.row.policy) }
    }
    mutating func acknowledge(_ selected: Selection, now: Double) {
        if selected.recovering { probeDue[selected.row.policy] = now + 60 }
        release(selected)
    }
    mutating func release(_ selected: Selection) { if selected.recovering { pendingProbes.remove(selected.row.policy) } }
    mutating func remove(_ key: String) {
        for domain in groups.keys { for mask in groups[domain]!.keys { groups[domain]![mask]!.removeAll { $0.row.key == key } } }
    }
    mutating func clear() { groups.removeAll() }
}
