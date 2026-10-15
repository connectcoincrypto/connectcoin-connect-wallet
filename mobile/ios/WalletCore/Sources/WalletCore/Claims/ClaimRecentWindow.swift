import Foundation

/// Only complete, value-owned public hash windows may be cached. Neither
/// bounty status nor journal cursor is implied by a matching block hash.
struct ClaimRecentWindow: Equatable {
    struct Tip: Equatable {
        let hash: String, height: Int64, medianTime: Int64
        init(_ value: Any?) throws {
            let value = try PJ.object(value)
            try walletRequire(value["chain"] as? String == "main" && value["genesis_hash"] as? String == NativePaymentChecks.GENESIS, "CLAIMS_WRONG_NETWORK")
            hash = try PJ.hash(value["hash"])
            height = try PJ.integer(value["height"], 0, 9_007_199_254_740_991)
            medianTime = try PJ.integer(value["mediantime"], 1, 253_402_300_799)
            try walletRequire(height != 0 || hash == NativePaymentChecks.GENESIS, "CLAIMS_RPC_DATA")
        }
        var json: JSONObject { ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS,
            "hash": hash, "height": height, "mediantime": medianTime] }
        func same(as other: Tip) throws -> Bool {
            guard hash == other.hash else { return false }
            try walletRequire(self == other, "CLAIMS_RPC_DATA")
            return true
        }
    }
    struct Block: Equatable { let height: Int64, hash: String }
    let tip: Tip
    let blocks: [Block]
    let counts: [String: Int]
    var heights: [String: Int64] { Dictionary(uniqueKeysWithValues: blocks.map { ($0.hash, $0.height) }) }
    var order: [String] { blocks.map(\.hash) }
    private init(tip: Tip, blocks: [Block], counts: [String: Int] = [:]) { self.tip = tip; self.blocks = blocks; self.counts = counts }

    private static func response(_ value: JSONObject, count: Int) throws -> ClaimRecentWindow {
        try walletRequire((1...600).contains(count), "CLAIMS_RPC_DATA")
        let tip = try Tip(value["tip"]), rows = try PJ.objects(value["blocks"])
        let size = Int(min(600, tip.height + 1))
        try walletRequire(try PJ.integer(value["window"]) == 600 &&
            (rows.count == Int(min(Int64(count), tip.height + 1)) || rows.count == size), "CLAIMS_RPC_DATA")
        let hasCounts = value["bounty_counts"] != nil
        if hasCounts { try walletRequire(try PJ.integer(value["bounty_counts"]) == 1, "CLAIMS_RPC_DATA") }
        var blocks = [Block](), seen = Set<String>(), counts: [String: Int] = [:]
        for (index, row) in rows.enumerated() {
            let height = try PJ.integer(row["height"]), hash = try PJ.hash(row["hash"])
            try walletRequire(height == tip.height - Int64(index) && seen.insert(hash).inserted &&
                (index != 0 || hash == tip.hash) && (height != 0 || hash == NativePaymentChecks.GENESIS), "CLAIMS_RPC_DATA")
            blocks.append(Block(height: height, hash: hash))
            if hasCounts { counts[hash] = Int(try PJ.integer(row["bounty_count"], 0, Int64(ClaimSubmissionRetry.maximumCatalogEntries))) }
            else { try walletRequire(row["bounty_count"] == nil, "CLAIMS_RPC_DATA") }
        }
        return ClaimRecentWindow(tip: tip, blocks: blocks, counts: counts)
    }
    init(_ complete: JSONObject) throws { self = try Self.response(complete, count: 600) }

    private func joining(_ known: ClaimRecentWindow) throws -> ClaimRecentWindow? {
        _ = try known.tip.same(as: tip)
        let knownHeights = known.heights
        let knownHashes = Dictionary(uniqueKeysWithValues: known.blocks.map { ($0.height, $0.hash) })
        var anchor: Int?
        for (index, block) in blocks.enumerated() {
            if let height = knownHeights[block.hash] {
                try walletRequire(height == block.height, "CLAIMS_RPC_DATA")
                if anchor == nil { anchor = index }
            }
            if anchor != nil, let hash = knownHashes[block.height] {
                try walletRequire(hash == block.hash, "CLAIMS_RPC_DATA")
            }
        }
        let size = Int(min(600, tip.height + 1))
        for (hash, count) in counts {
            if let previous = known.counts[hash] { try walletRequire(previous == count, "CLAIMS_RPC_DATA") }
        }
        if blocks.count == size { return ClaimRecentWindow(tip: tip, blocks: blocks,
            counts: known.counts.filter { heights[$0.key] != nil }.merging(counts) { _, new in new }) }
        guard let anchor else { return nil }
        let combined = Array((Array(blocks.prefix(anchor)) + known.blocks.filter { $0.height <= blocks[anchor].height }).prefix(size))
        guard combined.count == size else { return nil } // Rollback may lack the oldest required tail.
        let validated = try ClaimRecentWindow(["window": 600, "tip": tip.json,
            "blocks": combined.map { ["height": $0.height, "hash": $0.hash] as JSONObject }])
        return ClaimRecentWindow(tip: validated.tip, blocks: validated.blocks,
            counts: known.counts.merging(counts) { _, new in new }.filter { validated.heights[$0.key] != nil })
    }

    /// Only an explicitly canonical, request-bound delta can extend a window.
    /// Null means reorg/large gap: retain the bounded 5/100/600 fallback.
    func applying(_ page: JSONObject) throws -> ClaimRecentWindow? {
        guard page["block_deltas"] != nil else {
            try walletRequire(page["block_delta"] == nil, "CLAIMS_RPC_DATA"); return nil
        }
        try walletRequire(try PJ.integer(page["block_deltas"]) == 1 && PJ.integer(page["bounty_deltas"]) == 1,
            "CLAIMS_RPC_DATA")
        let current = try Tip(page["tip"])
        if page["block_delta"] is NSNull {
            try walletRequire(try !tip.same(as: current), "CLAIMS_RPC_DATA"); return nil
        }
        let delta = try PJ.object(page["block_delta"]), additions = try PJ.objects(delta["blocks"])
        try walletRequire(try PJ.integer(delta["base_height"]) == tip.height && PJ.hash(delta["base_hash"]) == tip.hash &&
            additions.count <= 5 && Int64(additions.count) == current.height - tip.height, "CLAIMS_RPC_DATA")
        _ = try tip.same(as: current)
        var seen = Set(order), newBlocks: [Block] = [], newCounts = counts
        for (index, item) in additions.enumerated() {
            let height = try PJ.integer(item["height"]), hash = try PJ.hash(item["hash"])
            let count = Int(try PJ.integer(item["bounty_count"], 0, Int64(ClaimSubmissionRetry.maximumCatalogEntries)))
            try walletRequire(height == tip.height + Int64(index) + 1 && seen.insert(hash).inserted, "CLAIMS_RPC_DATA")
            newBlocks.append(Block(height: height, hash: hash)); newCounts[hash] = count
        }
        let combined = Array((Array(newBlocks.reversed()) + blocks).prefix(Int(min(600, current.height + 1))))
        let checked = try ClaimRecentWindow(["window": 600, "tip": current.json,
            "blocks": combined.map { ["height": $0.height, "hash": $0.hash] as JSONObject }])
        return ClaimRecentWindow(tip: current, blocks: checked.blocks, counts: newCounts.filter { checked.heights[$0.key] != nil })
    }

    static func refresh(expected: Tip, known: ClaimRecentWindow?, force: Bool = false,
                        query: (JSONObject) async throws -> JSONObject) async throws -> ClaimRecentWindow {
        try Task.checkCancellation()
        if let known, try known.tip.same(as: expected), !force { return known }
        let counts = known == nil || force ? [600] : [5, 100, 600]
        for count in counts {
            try Task.checkCancellation()
            var value: JSONObject
            do { value = try await query(count == 600 ? [:] : ["count": count]) }
            catch let failure as RpcFailure where count != 600 && failure.code == "-32602" {
                try Task.checkCancellation()
                value = try await query([:])
                _ = try response(value, count: 600) // Legacy fallback must really be complete.
            }
            try Task.checkCancellation()
            let prefix = try response(value, count: count)
            _ = try expected.same(as: prefix.tip)
            if force {
                // A new journal watermark invalidates all cached count
                // capabilities. Obtain today's complete manifest, not a
                // short prefix spliced onto yesterday's count metadata.
                if let known { _ = try prefix.joining(known) }
                return prefix
            }
            if let known {
                if let full = try prefix.joining(known) { return full }
            } else { return prefix }
        }
        throw WalletError("CLAIMS_RPC_DATA")
    }
}
