import Foundation

/// One privately staged journal transaction. A complete hash window does not
/// mean all bounty streams are loaded; mobile keeps its existing incremental
/// loading policy, and commits both the cursor and this window together.
struct ClaimDiscoveryReplay {
    // The default RPC journal holds 10,000 events in 100-event pages. Leave
    // room for the post-hash drain and final-fence replay, while bounding one
    // operation even on servers with smaller pages or a continually busy tip.
    // Exhaustion requests a fresh coherent snapshot; it is not malformed data.
    static let maximumJournalPages = 128
    static let maximumCoherenceRounds = 32

    let window: ClaimRecentWindow
    let cursor: String
    let catalog: [String: ClaimCandidate]
    let loaded: Set<String>
    // Only already admitted work lives here, never scheduler candidates. An
    // aged row is retained, not certified available by this window's journal.
    let retained: [String: ClaimCandidate]
    // Applied only when the entire replay (including its final fence) commits.
    var availableAgain: Set<String> = []
    // Derived only from the final fenced snapshot. This marks ordinary depth
    // aging of already admitted rows, not fresh availability outside the index.
    var normallyAged: Set<String> {
        guard let oldest = window.blocks.last?.height else { return [] }
        return Set(retained.values.filter { $0.height < oldest && $0.supported && $0.state == "available" }.map(\.key))
    }

    static func cursor(_ value: Any?) throws -> String {
        let text = try PJ.string(value)
        try walletRequire(PJ.matches(text, "[A-Za-z0-9_.-]{1,1024}"), "CLAIMS_RPC_DATA")
        return text
    }

    static func read(known: ClaimRecentWindow?, cursor: String?, catalog: [String: ClaimCandidate],
                     loaded: Set<String>, newBlock: String? = nil, staged: [String: ClaimCandidate] = [:],
                     retained: [String: ClaimCandidate] = [:],
                     query: (String, JSONObject) async throws -> JSONObject) async throws -> ClaimDiscoveryReplay {
        var window = known, nextCursor = cursor, next = catalog, nextLoaded = loaded
        var held = retained, availableAgain = Set<String>()
        try walletRequire(held.count <= ClaimSubmissionRetry.maximumRetainedWinners, "CLAIMS_CAPACITY")
        // No cursor means the bounty state cannot be reused, even after an ABA
        // reorg. Hashes remain an anchor, but require a fresh prefix response.
        var forceWindow = cursor == nil
        if forceWindow { next.removeAll(); nextLoaded.removeAll() }
        if let newBlock {
            next = next.filter { $0.value.block != newBlock }
            held = held.filter { $0.value.block != newBlock || staged[$0.key] != nil }
        }
        for (key, source) in staged {
            var row = source
            if let previous = catalog[key] ?? retained[key] {
                try row.reuse(previous.progress)
                // A stopped/resynchronized reader takes a new journal watermark.
                // A reopening that happened while it was away will not be replayed,
                // but a complete block stream can prove the same transition. Do
                // not treat an unchanged available snapshot as new permission to
                // retry a rejected claim; require the exact previously pending
                // funding identity, and publish only after the final replay fence.
                if newBlock == row.block, previous.identity == row.identity,
                   previous.state == "pending_spend", row.state == "available" {
                    availableAgain.insert(key)
                }
            }
            next[key] = row
            if held[key] != nil { held[key] = row }
        }
        if let newBlock { nextLoaded.insert(newBlock) }
        try walletRequire(next.count <= ClaimSubmissionRetry.maximumCatalogEntries, "CLAIMS_CAPACITY")
        var pages = 0, lastSequence: Int64 = -1
        for _ in 0..<maximumCoherenceRounds {
            var more = true, readHashes = false
            while more {
                try Task.checkCancellation()
                try walletRequire(pages < maximumJournalPages, "CLAIMS_SYNC_BUSY")
                let from = nextCursor
                let response = try await query("getbountychanges", from.map { ["cursor": $0] } ?? [:])
                try Task.checkCancellation()
                let tip = try ClaimRecentWindow.Tip(response["tip"])
                let events = try PJ.objects(response["changes"])
                more = try PJ.bool(response["has_more"])
                let following = try Self.cursor(response["next_cursor"])
                pages += 1
                try walletRequire(events.count <= 500 && (!more || !events.isEmpty) &&
                    (events.isEmpty || following != from), "CLAIMS_RPC_DATA")
                if from == nil { try walletRequire(events.isEmpty && !more, "CLAIMS_RPC_DATA") }
                // A required reset must not be masked by a transient failure
                // while refreshing the new tip's hashes.
                if events.contains(where: { $0["type"] as? String == "resync_required" }) {
                    throw RpcFailure("-32011")
                }
                let changed: Bool
                if let window { changed = try !window.tip.same(as: tip) } else { changed = true }
                readHashes = readHashes || forceWindow || changed
                window = try await ClaimRecentWindow.refresh(expected: tip, known: window, force: forceWindow) {
                    try await query("getrecentblockhashes", $0)
                }
                forceWindow = false
                let heights = window!.heights
                next = next.filter { heights[$0.value.block] == $0.value.height }
                let oldest = window!.blocks.last!.height
                // No overlap can mean a long pause, not a known conflict. The
                // claim proof does not bind the funding block; Core checks the
                // final UTXO/proof. Only known in-window conflicts invalidate it.
                held = held.filter { _, row in row.height < oldest || heights[row.block] == row.height }
                nextLoaded.formIntersection(Set(heights.keys))
                for event in events {
                    let kind = try PJ.string(event["type"])
                    let sequence = try PJ.integer(event["sequence"], 0, 9_007_199_254_740_991)
                    try walletRequire(sequence > lastSequence, "CLAIMS_RPC_DATA"); lastSequence = sequence
                    let key = try PJ.outpoint(event)
                    if let value = event["block_hash"] { _ = try PJ.hash(value) }
                    switch kind {
                    case "window_exit":
                        next.removeValue(forKey: key)
                        // Only ordinary depth aging preserves admitted work.
                        // An exit still inside the canonical 600-block window
                        // is not evidence that this funding output survives.
                        if let row = held[key], row.height >= oldest { held.removeValue(forKey: key) }
                    case "added":
                        let hash = try PJ.hash(event["block_hash"]), height = try PJ.integer(event["block_height"], 0, 9_007_199_254_740_991)
                        if let expected = heights[hash] { try walletRequire(height == expected, "CLAIMS_RPC_DATA") }
                        if let existing = next[key] {
                            try walletRequire(existing.block == hash && existing.height == height, "CLAIMS_RPC_DATA")
                        }
                        if let existing = held[key], existing.block != hash || existing.height != height {
                            // A retained, aged funding transaction can be mined
                            // in a new block after a reorg. This event revokes
                            // its old proof, but cannot authenticate the new
                            // output: require its complete stream below.
                            try walletRequire(existing.block != hash && heights[existing.block] == nil, "CLAIMS_RPC_DATA")
                            held.removeValue(forKey: key)
                        }
                        // An added row in an already-loaded block must be
                        // reread, not silently hidden behind its loaded bit.
                        if heights[hash] != nil && next[key] == nil {
                            nextLoaded.remove(hash)
                        }
                    case "spent", "pending_spend":
                        let spender = try PJ.hash(event["spending_txid"])
                        next[key]?.state = kind; held[key]?.state = kind
                        next[key]?.spendingTxid = spender; held[key]?.spendingTxid = spender
                    case "available_again", "matured":
                        if kind == "available_again" { availableAgain.insert(key) }
                        if var row = next[key], row.state != "spent", kind == "available_again" || row.state == "immature" {
                            row.state = row.coinbase && tip.height - row.height + 1 < 100 ? "immature" : "available"
                            row.spendingTxid = nil
                            next[key] = row
                        }
                        if var row = held[key], row.state != "spent", kind == "available_again" || row.state == "immature" {
                            row.state = row.coinbase && tip.height - row.height + 1 < 100 ? "immature" : "available"
                            row.spendingTxid = nil
                            held[key] = row
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
                return ClaimDiscoveryReplay(window: window, cursor: nextCursor, catalog: next, loaded: nextLoaded, retained: held,
                    availableAgain: availableAgain)
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
