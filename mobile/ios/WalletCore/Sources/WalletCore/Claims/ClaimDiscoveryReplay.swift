import Foundation

/// One privately staged journal transaction. A complete hash window does not
/// mean all bounty streams are loaded; mobile keeps its existing incremental
/// loading policy, and commits both the cursor and this window together.
struct ClaimDiscoveryReplay {
    let window: ClaimRecentWindow
    let cursor: String
    let catalog: [String: ClaimCandidate]
    let loaded: Set<String>

    static func cursor(_ value: Any?) throws -> String {
        let text = try PJ.string(value)
        try walletRequire(PJ.matches(text, "[A-Za-z0-9_.-]{1,1024}"), "CLAIMS_RPC_DATA")
        return text
    }

    static func read(known: ClaimRecentWindow?, cursor: String?, catalog: [String: ClaimCandidate],
                     loaded: Set<String>, newBlock: String? = nil, staged: [String: ClaimCandidate] = [:],
                     query: (String, JSONObject) async throws -> JSONObject) async throws -> ClaimDiscoveryReplay {
        var window = known, nextCursor = cursor, next = catalog, nextLoaded = loaded
        // No cursor means the bounty state cannot be reused, even after an ABA
        // reorg. Hashes remain an anchor, but require a fresh prefix response.
        var forceWindow = cursor == nil
        if forceWindow { next.removeAll(); nextLoaded.removeAll() }
        if let newBlock { next = next.filter { $0.value.block != newBlock } }
        for (key, source) in staged {
            var row = source
            if !forceWindow, let previous = catalog[key] { row.progress = previous.progress }
            next[key] = row
        }
        if let newBlock { nextLoaded.insert(newBlock) }
        try walletRequire(next.count <= ClaimSubmissionRetry.maximumCatalogEntries, "CLAIMS_CAPACITY")
        var pages = 0, lastSequence: Int64 = -1
        for _ in 0..<32 {
            var more = true, readHashes = false
            while more {
                try Task.checkCancellation()
                let from = nextCursor
                let response = try await query("getbountychanges", from.map { ["cursor": $0] } ?? [:])
                try Task.checkCancellation()
                let tip = try ClaimRecentWindow.Tip(response["tip"])
                let events = try PJ.objects(response["changes"])
                more = try PJ.bool(response["has_more"])
                let following = try Self.cursor(response["next_cursor"])
                pages += 1
                try walletRequire(pages <= 100 && events.count <= 500 && (!more || !events.isEmpty) &&
                    (events.isEmpty || following != from), "CLAIMS_RPC_DATA")
                if from == nil { try walletRequire(events.isEmpty && !more, "CLAIMS_RPC_DATA") }
                let changed: Bool
                if let window { changed = try !window.tip.same(as: tip) } else { changed = true }
                readHashes = readHashes || forceWindow || changed
                window = try await ClaimRecentWindow.refresh(expected: tip, known: window, force: forceWindow) {
                    try await query("getrecentblockhashes", $0)
                }
                forceWindow = false
                let heights = window!.heights
                next = next.filter { heights[$0.value.block] == $0.value.height }
                nextLoaded.formIntersection(Set(heights.keys))
                for event in events {
                    let kind = try PJ.string(event["type"])
                    if kind == "resync_required" { throw RpcFailure("-32011") }
                    let sequence = try PJ.integer(event["sequence"], 0, 9_007_199_254_740_991)
                    try walletRequire(sequence > lastSequence, "CLAIMS_RPC_DATA"); lastSequence = sequence
                    let key = try PJ.outpoint(event)
                    if let value = event["block_hash"] { _ = try PJ.hash(value) }
                    switch kind {
                    case "window_exit": next.removeValue(forKey: key)
                    case "added":
                        let hash = try PJ.hash(event["block_hash"]), height = try PJ.integer(event["block_height"], 0, 9_007_199_254_740_991)
                        if let expected = heights[hash] { try walletRequire(height == expected, "CLAIMS_RPC_DATA") }
                        if let existing = next[key] {
                            try walletRequire(existing.block == hash && existing.height == height, "CLAIMS_RPC_DATA")
                        }
                        // An added row in an already-loaded block must be
                        // reread, not silently hidden behind its loaded bit.
                        if heights[hash] != nil && next[key] == nil {
                            nextLoaded.remove(hash)
                        }
                    case "spent", "pending_spend":
                        _ = try PJ.hash(event["spending_txid"]); next[key]?.state = kind
                    case "available_again", "matured":
                        if var row = next[key], row.state != "spent", kind == "available_again" || row.state == "immature" {
                            row.state = row.coinbase && tip.height - row.height + 1 < 100 ? "immature" : "available"
                            next[key] = row
                        }
                    default: throw WalletError("CLAIMS_RPC_DATA")
                    }
                }
                nextCursor = following
            }
            // A hash query may take long enough for mempool state to change.
            // Keep the pre-query watermark and replay again before the fence.
            if readHashes { continue }
            try Task.checkCancellation()
            let fenceResponse = try await query("getchaintip", [:])
            let fence = try ClaimRecentWindow.Tip(fenceResponse)
            try Task.checkCancellation()
            if let window, try window.tip.same(as: fence), let nextCursor {
                return ClaimDiscoveryReplay(window: window, cursor: nextCursor, catalog: next, loaded: nextLoaded)
            }
            window = try await ClaimRecentWindow.refresh(expected: fence, known: window) {
                try await query("getrecentblockhashes", $0)
            }
            // Do not commit this refresh yet: replay everything that arrived
            // during it, then fence again. No partial window/cursor escapes.
        }
        throw WalletError("CLAIMS_SYNC_BUSY")
    }
}
