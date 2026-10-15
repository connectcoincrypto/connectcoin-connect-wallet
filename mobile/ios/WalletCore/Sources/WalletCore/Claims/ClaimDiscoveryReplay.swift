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
    // Privately staged partial blocks are not scheduler/catalog entries. Keep
    // their immutable evidence until the required full stream is compared.
    var incomplete: [String: ClaimCandidate] = [:]
    var requiresStreams: Set<String> = []
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
                     incomplete: [String: ClaimCandidate] = [:], requiresStreams: Set<String> = [],
                     query: (String, JSONObject) async throws -> JSONObject) async throws -> ClaimDiscoveryReplay {
        var window = known, nextCursor = cursor, next = catalog, nextLoaded = loaded
        var held = retained, availableAgain = Set<String>()
        var candidates = cursor == nil ? [:] : incomplete
        var dirtyBlocks = cursor == nil ? Set<String>() : requiresStreams
        try walletRequire(held.count <= ClaimSubmissionRetry.maximumRetainedWinners, "CLAIMS_CAPACITY")
        // No cursor means the bounty state cannot be reused, even after an ABA
        // reorg. Hashes remain an anchor, but require a fresh prefix response.
        var forceWindow = cursor == nil
        if forceWindow { next.removeAll(); nextLoaded.removeAll() }
        if let newBlock {
            for row in candidates.values where row.block == newBlock {
                try walletRequire(staged[row.key]?.identity == row.identity, "CLAIMS_RPC_DATA")
            }
            candidates = candidates.filter { $0.value.block != newBlock }; dirtyBlocks.remove(newBlock)
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
        try walletRequire(next.count + candidates.count <= ClaimSubmissionRetry.maximumCatalogEntries, "CLAIMS_CAPACITY")
        var pages = 0, lastSequence: Int64 = -1
        for _ in 0..<maximumCoherenceRounds {
            var more = true, readHashes = false, completeFeed = false
            while more {
                try Task.checkCancellation()
                try walletRequire(pages < maximumJournalPages, "CLAIMS_SYNC_BUSY")
                let from = nextCursor
                let base = from == nil || forceWindow ? nil : window
                var params: JSONObject = ["include_bounties": true, "compact": true, "compact_version": 3]
                if let from { params["cursor"] = from }
                if let base, let from {
                    params["known_tip"] = ["height": base.tip.height, "hash": base.tip.hash] as JSONObject
                    params["known_state"] = try ClaimBountyCodec.stateDigest(base.tip, from)
                }
                var response: JSONObject
                do {
                    response = try ClaimBountyCodec.expand(await query("getbountychanges", params), window: base, cursor: from,
                        rows: next.merging(candidates) { _, candidate in candidate }, lastSequence: lastSequence)
                } catch let error as WalletError where error.message == "CLAIMS_UNKNOWN_REFERENCE" {
                    // Same pre-page watermark, expanded rows. A missing local
                    // row is not a permission to skip a delta or advance cursor.
                    params.removeValue(forKey: "compact"); params.removeValue(forKey: "compact_version"); params.removeValue(forKey: "known_state")
                    response = try await query("getbountychanges", params)
                    try walletRequire(response["compact"] == nil, "CLAIMS_RPC_DATA")
                }
                try Task.checkCancellation()
                let tip = try ClaimRecentWindow.Tip(response["tip"])
                let events = try PJ.objects(response["changes"])
                more = try PJ.bool(response["has_more"])
                let following = try Self.cursor(response["next_cursor"])
                pages += 1
                try walletRequire(events.count <= 500 && (!more || !events.isEmpty) &&
                    (events.isEmpty || following != from), "CLAIMS_RPC_DATA")
                if from == nil { try walletRequire(events.isEmpty && !more, "CLAIMS_RPC_DATA") }
                completeFeed = response["bounty_deltas"] != nil
                if completeFeed { try walletRequire(try PJ.integer(response["bounty_deltas"]) == 1, "CLAIMS_RPC_DATA") }
                if base == nil { try walletRequire(response["block_deltas"] == nil && response["block_delta"] == nil, "CLAIMS_RPC_DATA") }
                // A required reset must not be masked by a transient failure
                // while refreshing the new tip's hashes.
                if events.contains(where: { $0["type"] as? String == "resync_required" }) {
                    throw RpcFailure("-32011")
                }
                let changed: Bool
                if let window { changed = try !window.tip.same(as: tip) } else { changed = true }
                let inline = try base?.applying(response)
                if let inline { window = inline }
                else {
                    readHashes = readHashes || forceWindow || changed
                    window = try await ClaimRecentWindow.refresh(expected: tip, known: window, force: forceWindow) {
                        try await query("getrecentblockhashes", $0.merging(["include_bounty_counts": true]) { _, new in new })
                    }
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
                candidates = candidates.filter { heights[$0.value.block] == $0.value.height }
                dirtyBlocks.formIntersection(Set(heights.keys))
                var blockSizes: [String: Int] = [:], distinctRows = Set<String>()
                for row in Array(next.values) + Array(candidates.values) {
                    try walletRequire(distinctRows.insert(row.key).inserted, "CLAIMS_RPC_DATA")
                    blockSizes[row.block, default: 0] += 1
                }
                for (hash, count) in window!.counts where count == 0 {
                    try walletRequire(blockSizes[hash, default: 0] == 0, "CLAIMS_RPC_DATA")
                    nextLoaded.insert(hash)
                }
                for hash in nextLoaded {
                    if let count = window!.counts[hash] {
                        try walletRequire(blockSizes[hash, default: 0] == count, "CLAIMS_RPC_DATA")
                    }
                }
                for event in events {
                    let kind = try PJ.string(event["type"])
                    try walletRequire(["added", "spent", "pending_spend", "available_again", "matured", "window_exit"].contains(kind), "CLAIMS_RPC_DATA")
                    let sequence = try PJ.integer(event["sequence"], 0, 9_007_199_254_740_991)
                    try walletRequire(sequence > lastSequence, "CLAIMS_RPC_DATA"); lastSequence = sequence
                    let key = try PJ.outpoint(event)
                    if let value = event["block_hash"] { _ = try PJ.hash(value) }
                    if !completeFeed, let hash = event["block_hash"] as? String ?? next[key]?.block ?? candidates[key]?.block,
                       heights[hash] != nil, candidates.values.contains(where: { $0.block == hash }) {
                        // Metadata-only mutations cannot certify the state of
                        // an earlier inline accumulator. Require its stream.
                        dirtyBlocks.insert(hash); nextLoaded.remove(hash)
                        if kind == "window_exit" { throw RpcFailure("-32011") }
                        // Keep the immutable evidence for the eventual stream
                        // comparison; dirty prevents any promotion/admission.
                    }
                    if completeFeed {
                        if let spender = event["spending_txid"], !(spender is NSNull) { _ = try PJ.hash(spender) }
                        let publication = try ClaimRecentWindow.Tip(event["tip"])
                        _ = try publication.same(as: tip)
                        try walletRequire(publication.height <= tip.height, "CLAIMS_RPC_DATA")
                        if let canonical = window!.blocks.first(where: { $0.height == publication.height }), canonical.hash != publication.hash {
                            throw RpcFailure("-32011")
                        }
                        if kind == "window_exit" {
                            try walletRequire(event["bounty"] is NSNull, "CLAIMS_RPC_DATA")
                            let hash = event["block_hash"] as? String ?? next[key]?.block ?? candidates[key]?.block
                            if let hash, heights[hash] != nil { throw RpcFailure("-32011") }
                        } else {
                            let full = try PJ.object(event["bounty"])
                            try ClaimBountyCodec.validateRow(full, tip: publication)
                            var row = try ClaimCandidate(full, block: PJ.hash(full["block_hash"]), fee: NativeTransactions.claimFee(1500))
                            try walletRequire(row.key == key && (event["block_hash"] == nil || event["block_hash"] as? String == row.block), "CLAIMS_RPC_DATA")
                            if let height = event["block_height"] { try walletRequire(try PJ.integer(height) == row.height, "CLAIMS_RPC_DATA") }
                            if let canonical = window!.blocks.first(where: { $0.height == row.height }), canonical.hash != row.block { throw RpcFailure("-32011") }
                            let previous = next[key] ?? candidates[key] ?? held[key]
                            if let previous {
                                if previous.identity != row.identity {
                                    try walletRequire(previous.identity.sameOutput(as: row.identity) && previous.block != row.block && heights[previous.block] == nil,
                                        "CLAIMS_RPC_DATA")
                                    held.removeValue(forKey: key)
                                }
                                try row.reuse(previous.progress)
                            }
                            if heights[row.block] != nil {
                                if distinctRows.insert(key).inserted { blockSizes[row.block, default: 0] += 1 }
                                if nextLoaded.contains(row.block) || next[key] != nil { next[key] = row }
                                else { candidates[key] = row }
                                if let count = window!.counts[row.block] {
                                    try walletRequire(blockSizes[row.block, default: 0] <= count, "CLAIMS_RPC_DATA")
                                }
                            }
                            if held[key] != nil { held[key] = row }
                            // A coalesced event label is not the final state.
                            // Admission follows the fully validated row only.
                            if row.state == "available", kind == "available_again" || previous?.state == "pending_spend" {
                                availableAgain.insert(key)
                            }
                            continue
                        }
                    }
                    switch kind {
                    case "window_exit":
                        if let row = next[key] ?? candidates[key], distinctRows.remove(key) != nil {
                            blockSizes[row.block, default: 0] -= 1
                        }
                        next.removeValue(forKey: key)
                        candidates.removeValue(forKey: key)
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
                try walletRequire(next.count + candidates.count <= ClaimSubmissionRetry.maximumCatalogEntries, "CLAIMS_CAPACITY")
                let finalSizes = Dictionary(grouping: next.values, by: \.block).mapValues(\.count)
                for hash in nextLoaded {
                    if let count = window!.counts[hash] { try walletRequire(finalSizes[hash, default: 0] == count, "CLAIMS_RPC_DATA") }
                }
            }
            // A hash query may take long enough for mempool state to change.
            // Keep the pre-query watermark and replay again before the fence.
            if readHashes { continue }
            // A drained inline feed is a single canonical server snapshot.
            // Publish only complete-count blocks; incomplete accumulators never
            // become scheduler candidates and still require a full stream.
            let grouped = Dictionary(grouping: candidates.values, by: \.block)
            for (hash, count) in window!.counts where !nextLoaded.contains(hash) && !dirtyBlocks.contains(hash) {
                let rows = grouped[hash] ?? []
                if rows.count == count {
                    for row in rows { next[row.key] = row }
                    nextLoaded.insert(hash)
                    candidates = candidates.filter { $0.value.block != hash }
                }
            }
            if completeFeed, let window, let nextCursor {
                return ClaimDiscoveryReplay(window: window, cursor: nextCursor, catalog: next, loaded: nextLoaded, retained: held,
                    incomplete: candidates, requiresStreams: dirtyBlocks,
                    availableAgain: availableAgain)
            }
            try Task.checkCancellation()
            let fenceResponse = try await query("getchaintip", [:])
            let fence = try ClaimRecentWindow.Tip(fenceResponse)
            try Task.checkCancellation()
            if let window, try window.tip.same(as: fence), let nextCursor {
                return ClaimDiscoveryReplay(window: window, cursor: nextCursor, catalog: next, loaded: nextLoaded, retained: held,
                    incomplete: candidates, requiresStreams: dirtyBlocks,
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
