import Foundation

/// Transport compression only. Expand into the original journal shape before
/// canonical-window/sequence/count checks; never manufacture missing identities.
enum ClaimBountyCodec {
    private static let immutable = ["txid", "vout", "block_hash", "block_height", "amount", "domain",
        "connection_work_target", "root_certificates_version", "signature_algorithms_mask", "coinbase"]
    static func digest(_ values: [Any]) throws -> String {
        WalletCrypto.hex(try WalletCrypto.sha256(JSONSerialization.data(withJSONObject: values, options: [.withoutEscapingSlashes])))
    }
    static func stateDigest(_ tip: ClaimRecentWindow.Tip, _ cursor: String) throws -> String {
        try digest(["bounty-state-v1", "main", NativePaymentChecks.GENESIS, tip.height, tip.hash, tip.medianTime, cursor])
    }
    static func immutableDigest(_ row: JSONObject) throws -> String {
        try digest(["bounty-immutable-v1"] + immutable.map { row[$0] ?? NSNull() })
    }
    static func validateRow(_ row: JSONObject, tip: ClaimRecentWindow.Tip) throws {
        let height = try PJ.integer(row["block_height"], max(0, tip.height - 599), tip.height)
        let confirmations = try PJ.integer(row["confirmations"], 1, 9_007_199_254_740_991)
        let coinbase = try PJ.bool(row["coinbase"]), state = try PJ.string(row["status"])
        let amount = try PJ.string(row["amount"])
        try walletRequire(PJ.matches(amount, "[0-9]{1,19}"), "CLAIMS_RPC_DATA")
        _ = try NativeTransactions.amount(amount)
        _ = try PJ.outpoint(row); _ = try PJ.hash(row["block_hash"])
        _ = try PJ.hash(row["connection_work_target"])
        _ = try PJ.integer(row["root_certificates_version"], 1, 0xffff_ffff)
        _ = try PJ.integer(row["signature_algorithms_mask"], 1, 7)
        try walletRequire(NativeTransactions.canonicalDomain(try PJ.string(row["domain"])) &&
            confirmations == tip.height - height + 1 && ["available", "immature", "spent", "pending_spend"].contains(state), "CLAIMS_RPC_DATA")
        let hasSpender = !(row["spending_txid"] is NSNull)
        if hasSpender { _ = try PJ.hash(row["spending_txid"]) }
        try walletRequire(hasSpender == ["spent", "pending_spend"].contains(state) &&
            (state == "immature") == (coinbase && confirmations < 100), "CLAIMS_RPC_DATA")
    }

    static func expand(_ original: JSONObject, window: ClaimRecentWindow?, cursor: String?,
                       rows: [String: ClaimCandidate], lastSequence: Int64 = -1) throws -> JSONObject {
        if let changes = original["changes"] as? [JSONObject], changes.contains(where: { $0["type"] as? String == "resync_required" }) {
            throw RpcFailure("-32011")
        }
        guard let marker = original["compact"] else {
            try walletRequire(original["unchanged"] == nil && original["tips"] == nil, "CLAIMS_RPC_DATA")
            return original
        }
        let version = try PJ.integer(marker, 1, 3)
        if original["unchanged"] != nil {
            try walletRequire(Set(original.keys) == Set(["compact", "unchanged"]) && (try PJ.bool(original["unchanged"])), "CLAIMS_RPC_DATA")
            guard let window, let cursor else { throw WalletError("CLAIMS_RPC_DATA") }
            return ["tip": window.tip.json, "changes": [JSONObject](), "has_more": false, "next_cursor": cursor,
                "bounty_deltas": 1, "block_deltas": 1,
                "block_delta": ["base_hash": window.tip.hash, "base_height": window.tip.height, "blocks": [JSONObject]()] as JSONObject]
        }
        var page = original
        if version == 3 {
            let defaults: JSONObject = ["changes": [JSONObject](), "tips": [JSONObject](), "has_more": false, "next_cursor": NSNull()]
            for (key, value) in defaults where page[key] == nil { page[key] = value }
        }
        let changes = try PJ.objects(page["changes"]), tips = try PJ.objects(page["tips"])
        try walletRequire(changes.count <= 500 && tips.count <= 500, "CLAIMS_RPC_DATA")
        let more = try PJ.bool(page["has_more"])
        if version >= 2 { try walletRequire(page["bounty_deltas"] == nil && page["block_deltas"] == nil, "CLAIMS_RPC_DATA") }
        let bound = page["tip"] is [Any] || version == 3 && page["tip"] is NSNull
        var responseTip: ClaimRecentWindow.Tip
        if bound {
            guard let window, cursor != nil else { throw WalletError("CLAIMS_RPC_DATA") }
            let blocks = try PJ.array(page["block_delta"])
            try walletRequire(blocks.count <= 5 && version >= 2, "CLAIMS_RPC_DATA")
            if page["tip"] is NSNull {
                try walletRequire(version == 3 && blocks.isEmpty, "CLAIMS_RPC_DATA"); responseTip = window.tip
            } else {
                let tuple = try PJ.array(page["tip"])
                try walletRequire(tuple.count == 3, "CLAIMS_RPC_DATA")
                responseTip = try ClaimRecentWindow.Tip(["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS,
                    "height": tuple[0], "hash": tuple[1], "mediantime": tuple[2]] as JSONObject)
            }
            try walletRequire(Int64(blocks.count) == responseTip.height - window.tip.height, "CLAIMS_RPC_DATA")
            let expanded: [JSONObject] = try blocks.enumerated().map { index, value in
                let pair = try PJ.array(value)
                try walletRequire(pair.count == 2, "CLAIMS_RPC_DATA")
                let height = window.tip.height + Int64(index) + 1
                let hash: String
                if pair[0] is NSNull {
                    try walletRequire(index == blocks.count - 1 && height == responseTip.height, "CLAIMS_RPC_DATA"); hash = responseTip.hash
                } else { hash = try PJ.hash(pair[0]) }
                return ["height": height, "hash": hash, "bounty_count": try PJ.integer(pair[1], 0, Int64(ClaimSubmissionRetry.maximumCatalogEntries))]
            }
            page["block_delta"] = ["base_height": window.tip.height, "base_hash": window.tip.hash, "blocks": expanded] as JSONObject
            if page["next_cursor"] is NSNull {
                try walletRequire(changes.isEmpty && !more, "CLAIMS_RPC_DATA"); page["next_cursor"] = cursor!
            }
        } else {
            try walletRequire(!(page["block_delta"] is [Any]) && !(page["next_cursor"] is NSNull), "CLAIMS_RPC_DATA")
            responseTip = try ClaimRecentWindow.Tip(page["tip"])
        }
        page["tip"] = responseTip.json
        let following = try ClaimDiscoveryReplay.cursor(page["next_cursor"])
        try walletRequire((!more || !changes.isEmpty) && (changes.isEmpty || following != cursor), "CLAIMS_RPC_DATA")
        if version >= 2 {
            page["bounty_deltas"] = 1
            if page["block_delta"] != nil { page["block_deltas"] = 1 }
        }
        try walletRequire(try PJ.integer(page["bounty_deltas"]) == 1, "CLAIMS_RPC_DATA")
        // Validate all canonical metadata before deciding that a cache miss
        // merits expanded replay. Malformed deltas are never negotiation.
        var canonicalWindow: ClaimRecentWindow?
        if let window {
            canonicalWindow = try window.applying(page)
            if canonicalWindow == nil, try window.tip.same(as: responseTip) { canonicalWindow = window }
        } else { try walletRequire(page["block_deltas"] == nil && page["block_delta"] == nil, "CLAIMS_RPC_DATA") }
        // Never apply the previous branch's window to a reorg response. When
        // this page does authenticate its window, validate it before any
        // unknown reference can cause an expanded replay of the same cursor.
        let canonicalHashes = Dictionary(uniqueKeysWithValues: (canonicalWindow?.blocks ?? []).map { ($0.height, $0.hash) })
        for value in tips {
            let item = try ClaimRecentWindow.Tip(value)
            _ = try item.same(as: responseTip)
            try walletRequire(item.height <= responseTip.height, "CLAIMS_RPC_DATA")
        }
        var expandedEvents: [JSONObject] = [], references = rows.mapValues(\.bounty), missing = false, sequence = lastSequence
        for originalEvent in changes {
            var event = originalEvent
            try walletRequire(event["tip"] == nil, "CLAIMS_RPC_DATA")
            let ref = try PJ.integer(event["tip_ref"], version == 3 ? -2 : version == 2 ? -1 : 0, 9_007_199_254_740_991)
            let publication: ClaimRecentWindow.Tip
            if ref == -2 {
                guard version == 3, bound, let window else { throw WalletError("CLAIMS_RPC_DATA") }; publication = window.tip
            } else if ref == -1 { publication = responseTip }
            else {
                // Check against the WIRE table, never an array extended by aliases.
                try walletRequire(ref < Int64(tips.count), "CLAIMS_RPC_DATA")
                publication = try ClaimRecentWindow.Tip(tips[Int(ref)])
            }
            if let canonical = canonicalHashes[publication.height], canonical != publication.hash { throw RpcFailure("-32011") }
            event.removeValue(forKey: "tip_ref"); event["tip"] = publication.json
            let kind = try PJ.string(event["type"])
            try walletRequire(["added", "spent", "pending_spend", "available_again", "matured", "window_exit"].contains(kind), "CLAIMS_RPC_DATA")
            let nextSequence = try PJ.integer(event["sequence"], 0, 9_007_199_254_740_991)
            try walletRequire(nextSequence > sequence, "CLAIMS_RPC_DATA"); sequence = nextSequence
            if version >= 2 && kind == "added" {
                try walletRequire(["txid", "vout", "block_hash", "block_height"].allSatisfy { event[$0] == nil }, "CLAIMS_RPC_DATA")
                let row = try PJ.object(event["bounty"])
                for key in ["txid", "vout", "block_hash", "block_height"] { event[key] = row[key] }
            }
            if event["spending_txid_ref"] != nil {
                try walletRequire(version >= 2 && (try PJ.bool(event["spending_txid_ref"])) && event["spending_txid"] == nil &&
                    ["spent", "pending_spend", "available_again", "matured"].contains(kind), "CLAIMS_RPC_DATA")
                let delta = try PJ.object(event["bounty_delta"])
                guard let spender = delta["spending_txid"] else { throw WalletError("CLAIMS_RPC_DATA") }
                event["spending_txid"] = spender; event.removeValue(forKey: "spending_txid_ref")
            }
            _ = try PJ.outpoint(event)
            if let hash = event["block_hash"] { _ = try PJ.hash(hash) }
            if let spender = event["spending_txid"], !(spender is NSNull) { _ = try PJ.hash(spender) }
            if event["bounty_ref"] != nil {
                try walletRequire(event["bounty"] == nil && ["spent", "pending_spend", "available_again", "matured"].contains(kind), "CLAIMS_RPC_DATA")
                let key = try PJ.outpoint(event), digest = try PJ.hash(event["bounty_ref"])
                var delta = try PJ.object(event["bounty_delta"])
                let expected = version == 3 && delta["confirmations"] == nil ? ["status", "spending_txid"] : ["status", "spending_txid", "confirmations"]
                try PJ.keys(delta, expected)
                let state = try PJ.string(delta["status"])
                try walletRequire(["available", "immature", "spent", "pending_spend"].contains(state), "CLAIMS_RPC_DATA")
                if !(delta["spending_txid"] is NSNull) { _ = try PJ.hash(delta["spending_txid"]) }
                try walletRequire(["spent", "pending_spend"].contains(state) == !(delta["spending_txid"] is NSNull), "CLAIMS_RPC_DATA")
                if let count = delta["confirmations"] { _ = try PJ.integer(count, 1, 9_007_199_254_740_991) }
                if let cached = references[key] {
                    try walletRequire(try immutableDigest(cached) == digest, "CLAIMS_RPC_DATA")
                    if version == 3 && delta["confirmations"] == nil {
                        delta["confirmations"] = publication.height - (try PJ.integer(cached["block_height"])) + 1
                    }
                    event["bounty"] = cached.merging(delta) { _, new in new }
                } else { missing = true }
                event.removeValue(forKey: "bounty_ref"); event.removeValue(forKey: "bounty_delta")
            } else {
                try walletRequire(event["bounty_delta"] == nil && ["added", "window_exit"].contains(kind), "CLAIMS_RPC_DATA")
                if kind == "window_exit" { try walletRequire(event["bounty"] is NSNull, "CLAIMS_RPC_DATA") }
                else { _ = try PJ.object(event["bounty"]) }
            }
            if let row = event["bounty"] as? JSONObject {
                try validateRow(row, tip: publication)
                let key = try PJ.outpoint(event)
                try walletRequire(try PJ.outpoint(row) == key, "CLAIMS_RPC_DATA")
                let rowHash = try PJ.hash(row["block_hash"]), rowHeight = try PJ.integer(row["block_height"])
                if let canonical = canonicalHashes[rowHeight], canonical != rowHash { throw RpcFailure("-32011") }
                if let count = canonicalWindow?.counts[rowHash] { try walletRequire(count > 0, "CLAIMS_RPC_DATA") }
                if let hash = event["block_hash"] { try walletRequire(try PJ.hash(hash) == PJ.hash(row["block_hash"]), "CLAIMS_RPC_DATA") }
                if let height = event["block_height"] { try walletRequire(try PJ.integer(height) == PJ.integer(row["block_height"]), "CLAIMS_RPC_DATA") }
                if let prior = references[key], try immutableDigest(prior) != immutableDigest(row) {
                    let outputFields = immutable.filter { !["block_hash", "block_height"].contains($0) }
                    try walletRequire(outputFields.allSatisfy { PJ.equal(prior[$0], row[$0]) }, "CLAIMS_RPC_DATA")
                    // A valid re-mining can relocate an unchanged outpoint.
                    // Its old proof stays retained while fresh canonical
                    // discovery authenticates the new funding location.
                    throw RpcFailure("-32011")
                }
                references[key] = row
            }
            expandedEvents.append(event)
        }
        if missing { throw WalletError("CLAIMS_UNKNOWN_REFERENCE") }
        page["changes"] = expandedEvents
        return page
    }
}
