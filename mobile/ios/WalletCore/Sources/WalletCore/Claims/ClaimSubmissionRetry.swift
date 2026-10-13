import Foundation

/// Session-local retry state for one already verified, fully attached claim.
/// It never creates a transaction or changes its identity between attempts.
struct ClaimSubmissionRetry {
    static let maximumCatalogEntries = 10_000
    // Admission stops at 100 reservations while at most 100 captures drain.
    static let maximumRetainedWinners = 200
    static let maximumProgressEntries = maximumCatalogEntries + maximumRetainedWinners

    static func canAppendWinner(currentCount: Int) -> Bool {
        (0..<maximumRetainedWinners).contains(currentCount)
    }
    static func validProgressCount(_ count: Int) -> Bool {
        (0...maximumProgressEntries).contains(count)
    }

    let hex: String, txid: String
    private(set) var failures = 0
    private(set) var due = 0.0

    init(hex: String, txid: String) {
        self.hex = hex; self.txid = txid
    }

    /// Catalog age governs permission to transmit, not whether an already
    /// verified proof is worth keeping. Lifecycle / cancellation is checked by
    /// the engine separately, before calling this exact-bounty identity gate.
    static func matchesAvailableBounty(_ current: ClaimCandidate?, captured: ClaimCandidate) -> Bool {
        guard let current else { return false }
        return current.supported && current.state == "available" &&
            current.key == captured.key && current.block == captured.block
    }

    mutating func retain(after failure: RpcFailure, now: Double) -> Bool {
        guard failure.notSent, !failure.unknownOutcome, !failure.explicitRejection,
              failure.nodeCode == nil,
              ["RPC_UNAVAILABLE", "RPC_TIMEOUT", "RPC_BUSY"].contains(failure.code),
              now.isFinite else { return false }
        failures = min(31, failures + 1)
        let backoff = min(30, pow(2, Double(min(5, failures - 1))))
        // The exponential component is bounded; an already validated server /
        // transport cooldown is a floor and must never be shortened to 60s.
        let cooldown = Double(max(0, failure.retryAfterMs)) / 1000
        due = now + max(backoff, cooldown)
        return true
    }

    mutating func waitForFreshCatalog(now: Double) { due = now + 1 }
}
