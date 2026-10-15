import Foundation

/// One already attached public proof. A gateway ACK is not confirmation and
/// must not discard the only copy of the transaction while it is in mempool.
/// The engine owns this record across policy pauses/Stop-Start; no new native
/// capture, signing or attachment is performed when it becomes available again.
final class ClaimSavedSubmission {
    let row: ClaimCandidate
    var retry: ClaimSubmissionRetry
    private(set) var acknowledged = false
    private(set) var counted = false
    private(set) var acknowledgedAt = 0.0
    private(set) var reopenedSinceWrite = false
    private(set) var ownAbsenceValidated = false
    private(set) var waitingForAvailability = false
    var nextCheck = 0.0

    init(row: ClaimCandidate, retry: ClaimSubmissionRetry) {
        self.row = row; self.retry = retry
    }
    /// Returns true only for the first ACK, never for an identical retransmit.
    func acknowledge(now: Double) -> Bool {
        acknowledged = true; acknowledgedAt = now; nextCheck = now + 30; ownAbsenceValidated = false; waitingForAvailability = false
        let first = !counted; counted = true; return first
    }
    func beginWrite() { reopenedSinceWrite = false }
    func inheritCountedSubmission(txid: String) { if retry.txid == txid { counted = true } }
    func foundPending() { ownAbsenceValidated = false }
    func rejected() { waitingForAvailability = !reopenedSinceWrite; ownAbsenceValidated = false }
    func reopened() { reopenedSinceWrite = true; waitingForAvailability = false; if acknowledged { nextCheck = 0 } }
    func availableForRetry(catalog: ClaimCandidate?, retained: ClaimCandidate?,
                           normallyAged: Bool, coherent: Bool, oldestHeight: Int64? = nil) -> Bool {
        guard !waitingForAvailability else { return false }
        return ClaimSubmissionRetry.canSubmitPreserved(catalog: catalog, retained: retained, captured: row,
            normallyAged: normallyAged, coherent: coherent) ||
            coherent && permitsAgedOwnRetry(catalog: catalog, retained: retained, oldestHeight: oldestHeight)
    }
    func matchesCurrent(catalog: ClaimCandidate?, retained: ClaimCandidate?, oldestHeight: Int64?) -> Bool {
        ClaimSubmissionRetry.matchesAvailableBounty(catalog ?? retained, captured: row) ||
            permitsAgedOwnRetry(catalog: catalog, retained: retained, oldestHeight: oldestHeight)
    }
    private func permitsAgedOwnRetry(catalog: ClaimCandidate?, retained: ClaimCandidate?, oldestHeight: Int64?) -> Bool {
        guard ownAbsenceValidated, acknowledged, catalog == nil, let oldestHeight else { return false }
        return agedAbsenceMayRestoreOwnPending(current: retained, oldestHeight: oldestHeight, coherent: true)
    }
    func absentAfterFreshSnapshot(catalogAt: Double, available: Bool) -> Bool {
        acknowledged && catalogAt > acknowledgedAt && available
    }
    func agedAbsenceMayRestoreOwnPending(current: ClaimCandidate?, oldestHeight: Int64, coherent: Bool) -> Bool {
        guard coherent, let current, current.identity == row.identity, current.height < oldestHeight, current.supported else { return false }
        return current.state == "available" || current.state == "pending_spend" && current.spendingTxid == retry.txid
    }
    func observedAgedAbsence(current: ClaimCandidate?, oldestHeight: Int64, catalogAt: Double, coherent: Bool) {
        ownAbsenceValidated = absentAfterFreshSnapshot(catalogAt: catalogAt, available:
            agedAbsenceMayRestoreOwnPending(current: current, oldestHeight: oldestHeight, coherent: coherent))
    }
    enum Location: Equatable { case pending, confirmed }
    /// The caller has revalidated these locally preserved bytes before querying
    /// the index. Txid does not commit the witness: never discard that proof
    /// merely because a compact location assertion was received.
    func expandStatus(_ response: JSONObject) throws -> JSONObject {
        if response["transaction"] != nil { return response } // Explicit legacy method fallback.
        let tip = try ClaimRecentWindow.Tip(response["tip"])
        try walletRequire(try PJ.hash(response["txid"]) == retry.txid, "CLAIMS_RPC_DATA")
        let state = try PJ.string(response["status"]), count = try PJ.integer(response["confirmations"], 0, 9_007_199_254_740_991)
        var tx: JSONObject = ["hex": retry.hex, "txid": retry.txid, "confirmations": count]
        if state == "pending" {
            try walletRequire(count == 0 && response["block_hash"] == nil && response["block_height"] == nil, "CLAIMS_RPC_DATA")
        } else {
            try walletRequire(state == "confirmed", "CLAIMS_RPC_DATA")
            let height = try PJ.integer(response["block_height"], 0, tip.height), hash = try PJ.hash(response["block_hash"])
            try walletRequire(count == tip.height - height + 1 && (height != tip.height || hash == tip.hash) &&
                (height != 0 || hash == NativePaymentChecks.GENESIS), "CLAIMS_RPC_DATA")
            tx["blockhash"] = hash
        }
        var full = response; full["transaction"] = tx
        return full
    }
    /// gettransaction is index-backed, but its raw transaction and canonical
    /// location still have to agree before an ACK record may be discarded.
    func location(_ response: JSONObject, known: ClaimRecentWindow?) throws -> Location {
        try Self.validateReceipt(response, expectedTxid: retry.txid, originalHex: retry.hex, target: row.target, known: known)
    }
    /// Manual recovery is a durable commit, not just a successful RPC read.
    /// Prepare every fallible validation first, then persist, and only then
    /// acknowledge/count or allow the caller to compact this public proof.
    /// A writer can publish its file and still throw on directory fsync.
    func commitReceipt(_ response: JSONObject, known: ClaimRecentWindow?, now: Double,
                       persist: () throws -> Void) throws -> (firstAck: Bool, retirement: ClaimConfirmedRetirement?) {
        let location = try self.location(response, known: known)
        let retirement: ClaimConfirmedRetirement?
        if location == .confirmed {
            retirement = try ClaimConfirmedRetirement(validated: self, response: response, known: known, counted: true)
        } else { retirement = nil }
        try persist()
        return (acknowledge(now: now), retirement)
    }
    /// A persisted uncertain receipt may survive the in-memory proof owner.
    /// Its public RPC envelope still needs exactly the same validation; only
    /// the unavailable original witness/target context is optional.
    static func validateReceipt(_ response: JSONObject, expectedTxid: String, originalHex: String? = nil,
                                target: String? = nil, known: ClaimRecentWindow? = nil) throws -> Location {
        let tip = try ClaimRecentWindow.Tip(response["tip"])
        let transaction = try PJ.object(response["transaction"])
        let raw = try PJ.string(transaction["hex"])
        _ = try NativeTransactions.validateObservedClaim(raw, expectedTxid: expectedTxid, originalHex: originalHex, target: target)
        if let reportedTxid = transaction["txid"] { try walletRequire(try PJ.hash(reportedTxid) == expectedTxid, "CLAIMS_RPC_DATA") }
        let state = try PJ.string(response["status"])
        try walletRequire(state == "pending" || state == "confirmed", "CLAIMS_RPC_DATA")
        // Validate every field before distinguishing malformed data from a
        // well-formed disagreement between the index and Core. The node can
        // mine/orphan a transaction while the index still reports its old
        // location; that receipt must be retried, never accepted or fatalized.
        let count = try transaction["confirmations"].map { try PJ.integer($0, 0, 9_007_199_254_740_991) }
        let nodeBlock = try transaction["blockhash"].map { try PJ.hash($0) }
        if state == "pending" {
            try walletRequire(response["block_hash"] == nil && response["block_height"] == nil, "CLAIMS_RPC_DATA")
            try walletRequire((count ?? 0) == 0 && nodeBlock == nil, "CLAIMS_SNAPSHOT_STALE")
            return .pending
        }
        let height = try PJ.integer(response["block_height"], 0, tip.height)
        let hash = try PJ.hash(response["block_hash"])
        try walletRequire(height != 0 || hash == NativePaymentChecks.GENESIS, "CLAIMS_RPC_DATA")
        try walletRequire(height != tip.height || hash == tip.hash, "CLAIMS_RPC_DATA")
        if let known {
            try walletRequire(try known.tip.same(as: tip), "CLAIMS_SNAPSHOT_STALE")
            if let block = known.blocks.first(where: { $0.height == height }) {
                try walletRequire(block.hash == hash, "CLAIMS_RPC_DATA")
            }
        }
        try walletRequire((count ?? 1) > 0 && (nodeBlock == nil || nodeBlock == hash), "CLAIMS_SNAPSHOT_STALE")
        return .confirmed
    }
}

/// Confirmation releases the large public proof, not the evidence needed to
/// undo its scheduler retirement after a proven reorg. This small record lives
/// only as long as the funding output's bounded progress entry.
final class ClaimConfirmedRetirement {
    enum Action: Equatable { case none, reload(String), reopen }
    let identity: ClaimCandidate.Identity
    let txid: String, hash: String
    let height: Int64, counted: Bool
    private var anchored: Bool, displaced = false, released = false
    private var streamedIdentity: ClaimCandidate.Identity?

    /// The caller must first validate the full receipt with saved.location().
    init(validated saved: ClaimSavedSubmission, response: JSONObject, known: ClaimRecentWindow?, counted: Bool? = nil) throws {
        let tip = try ClaimRecentWindow.Tip(response["tip"])
        try walletRequire(response["status"] as? String == "confirmed", "CLAIMS_RPC_DATA")
        let confirmedHeight = try PJ.integer(response["block_height"], 0, tip.height)
        let confirmedHash = try PJ.hash(response["block_hash"])
        height = confirmedHeight; hash = confirmedHash
        identity = saved.row.identity; txid = saved.retry.txid; self.counted = counted ?? saved.counted
        anchored = known?.blocks.contains(where: { $0.height == confirmedHeight && $0.hash == confirmedHash }) == true
    }

    /// Called only on a complete, fenced replay. Merely falling out of the
    /// 600-block window is not evidence of a reorg. A receipt ahead of our local
    /// window is also not orphaned just because discovery has not caught up.
    func observe(window: ClaimRecentWindow, newBlock: String?, staged: ClaimCandidate?, current: ClaimCandidate?) -> Action {
        guard !released else { return .none }
        let block = window.blocks.first(where: { $0.height == height })
        if block?.hash == hash {
            anchored = true; displaced = false; streamedIdentity = nil
            return .none
        }
        guard block != nil || anchored && window.tip.height < height else { return .none }
        let heights = window.heights
        if !displaced { displaced = true; streamedIdentity = nil }
        if let staged, newBlock == staged.block, identity.sameOutput(as: staged.identity),
           heights[staged.block] == staged.height {
            streamedIdentity = staged.identity
        }
        if let current, current.supported, current.state == "available",
           streamedIdentity == current.identity, heights[current.block] == current.height {
            released = true
            return .reopen
        }
        // Require one fresh complete funding stream after displacement. A
        // subsequent validated pending->available event may then finish it.
        let funding = current.flatMap { identity.sameOutput(as: $0.identity) ? $0.identity : nil } ?? identity
        if streamedIdentity != funding, heights[funding.block] == funding.height { return .reload(funding.block) }
        return .none
    }

    func inheritCount(on saved: ClaimSavedSubmission) {
        if counted, identity.sameOutput(as: saved.row.identity) { saved.inheritCountedSubmission(txid: txid) }
    }
}
