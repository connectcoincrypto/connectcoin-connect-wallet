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
    var heights: [String: Int64] { Dictionary(uniqueKeysWithValues: blocks.map { ($0.hash, $0.height) }) }
    var order: [String] { blocks.map(\.hash) }
    private init(tip: Tip, blocks: [Block]) { self.tip = tip; self.blocks = blocks }

    private static func response(_ value: JSONObject, count: Int) throws -> ClaimRecentWindow {
        try walletRequire((1...600).contains(count), "CLAIMS_RPC_DATA")
        let tip = try Tip(value["tip"]), rows = try PJ.objects(value["blocks"])
        let size = Int(min(600, tip.height + 1))
        try walletRequire(try PJ.integer(value["window"]) == 600 &&
            (rows.count == Int(min(Int64(count), tip.height + 1)) || rows.count == size), "CLAIMS_RPC_DATA")
        var blocks = [Block](), seen = Set<String>()
        for (index, row) in rows.enumerated() {
            let height = try PJ.integer(row["height"]), hash = try PJ.hash(row["hash"])
            try walletRequire(height == tip.height - Int64(index) && seen.insert(hash).inserted &&
                (index != 0 || hash == tip.hash) && (height != 0 || hash == NativePaymentChecks.GENESIS), "CLAIMS_RPC_DATA")
            blocks.append(Block(height: height, hash: hash))
        }
        return ClaimRecentWindow(tip: tip, blocks: blocks)
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
        if blocks.count == size { return self }
        guard let anchor else { return nil }
        let combined = Array((Array(blocks.prefix(anchor)) + known.blocks.filter { $0.height <= blocks[anchor].height }).prefix(size))
        guard combined.count == size else { return nil } // Rollback may lack the oldest required tail.
        return try ClaimRecentWindow(["window": 600, "tip": tip.json,
            "blocks": combined.map { ["height": $0.height, "hash": $0.hash] as JSONObject }])
    }

    static func refresh(expected: Tip, known: ClaimRecentWindow?, force: Bool = false,
                        query: (JSONObject) async throws -> JSONObject) async throws -> ClaimRecentWindow {
        try Task.checkCancellation()
        if let known, try known.tip.same(as: expected), !force { return known }
        let counts = known == nil ? [600] : [5, 100, 600]
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
            if let known {
                if let full = try prefix.joining(known) { return full }
            } else { return prefix }
        }
        throw WalletError("CLAIMS_RPC_DATA")
    }
}
