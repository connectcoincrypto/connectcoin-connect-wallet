import Foundation
import Network
import CConnectWallet

/// Foreground-only public-proof workload. It has no seed, signing key, or
/// automatic startup. The runtime supplies a natively derived reward address.
public actor MobileClaimsEngine {
    private static let maximum: Int64 = 9_007_199_254_740_991
    private let rpc: MobileRpcClient
    private let receiptURL: URL
    private let network = NWPathMonitor()
    private let capturesQueue = DispatchQueue(label: "ConnectWallet.claim-capture", attributes: .concurrent)
    private var limiter: Int64 = 0
    private var dispatchTask: Task<Void, Never>?, maintenanceTask: Task<Void, Never>?
    private var foreground = false, online = false, expensive = true, allowMobile = false
    private var enabled = false, allowed = false, closed = false, healthy = false, unknownBlocked = false
    private var epoch: UInt64 = 0, run: UInt64 = 0, nextCapture: UInt64 = 0
    private var address = "", cursor: String?, tip: JSONObject?
    private var recentWindow: ClaimRecentWindow?
    private var status = "stopped", lastError = "", lastTxid = "", receiptStatus = ""
    private var pendingReceiptRetryAllowed = false
    private var lastRpcError: JSONObject?
    private var rate = 100, concurrency = 100
    private var attempts: Int64 = 0, valid: Int64 = 0, invalid: Int64 = 0, hits: Int64 = 0
    private var submitted: Int64 = 0, unknown: Int64 = 0, cancelled: Int64 = 0
    private var elapsed = 0.0, activeSince: Double?
    private var nextDiscovery = 0.0, nextBlock = 0.0, retryAt = 0.0, nextPreparation = 0.0
    private var catalogAt = 0.0, nextSchedule = 0.0, nextAdmission = 0.0, nextAck = 0.0
    private var dirty = true, admissionIdle = true
    private var snapshotPending = false, nativeGateAllowed = true
    private var catalogRevision: UInt64 = 0
    private var pendingRevalidation = Set<String>()
    private var normallyAged = Set<String>()
    private var blocks: [String: Int64] = [:], blockOrder: [String] = [], loaded = Set<String>()
    private var catalog: [String: ClaimCandidate] = [:], progress: [String: ClaimProgress] = [:]
    private var retained: [String: ClaimCandidate] = [:]
    private var stats: [String: ClaimPerformanceWindow] = [:]
    private var scheduler = ClaimScheduler(), retired = Set<String>(), reservations = Set<String>()
    private var parentCache: [String: String] = [:], parentOrder: [String] = []
    private var parentBytes = 0
    private var savedSubmissions: [String: ClaimSavedSubmission] = [:]
    // This exception exists only while the exact live proof owner retains
    // positive transport evidence of no submission. A persisted pending or
    // unknown receipt alone can never recreate it after process restart.
    private var provenUnsentReceipt: ClaimSavedSubmission?
    // A definitive node rejection is also live evidence, but is not permission
    // to resend: the saved proof must still wait for validated availability.
    private var provenRejectedReceipt: ClaimSavedSubmission?
    // A matching broadcast ACK is not confirmation. It can restore receipt
    // persistence, but the normal fresh-catalog/absence gates still own replay.
    private var provenAcknowledgedReceipt: ClaimSavedSubmission?
    private var confirmedRetirements: [String: ClaimConfirmedRetirement] = [:]
    private var confirmationReloads = Set<String>()
    private var nextSavedCheck = 0.0
    private let fundingValidation = NativeTransactions.FundingTransactionCache()
    private var recentStarts: [Double] = []
    private struct Capture {
        let id: UInt64, epoch: UInt64, run: UInt64, handle: Int64
        let selection: ClaimScheduler.Selection
        var started = false, cancelled = false
    }
    private var active: [UInt64: Capture] = [:]
    private final class Winner {
        let saved: ClaimSavedSubmission, epoch: UInt64
        var row: ClaimCandidate { saved.row }
        var retry: ClaimSubmissionRetry { get { saved.retry } set { saved.retry = newValue } }
        var permit: RpcBroadcastPermit
        var catalogRevoked = false
        init(row: ClaimCandidate, completed: JSONObject, epoch: UInt64, validUntil: Double) throws {
            saved = ClaimSavedSubmission(row: row, retry: ClaimSubmissionRetry(hex: try PJ.string(completed["hex"]), txid: try PJ.hash(completed["txid"])))
            self.epoch = epoch
            permit = RpcBroadcastPermit(validUntil: validUntil)
        }
        init(saved: ClaimSavedSubmission, epoch: UInt64, validUntil: Double) {
            self.saved = saved; self.epoch = epoch; permit = RpcBroadcastPermit(validUntil: validUntil)
        }
    }
    // Admission stops at 100 reservations. At most 100 captures already in
    // flight can finish, so retained public proofs are bounded by 200 total.
    private var winners: [Winner] = [], transmitting: Winner?
    private var submissionTask: Task<Void, Never>?

    public init(rpc: MobileRpcClient, receiptURL: URL? = nil, inheritedUnknownTxid: String? = nil) {
        self.rpc = rpc
        self.receiptURL = receiptURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ConnectWallet", isDirectory: true).appendingPathComponent("claims-public-receipt-v1.json")
        var error = [CChar](repeating: 0, count: 32)
        limiter = cw_claim_limiter_create(100, &error)
        if limiter == 0 { status = "error"; lastError = String(cString: error) }
        do {
            if FileManager.default.fileExists(atPath: self.receiptURL.path) {
                let receipt = try ClaimsPublicStore.read(self.receiptURL)
                lastTxid = try PJ.hash(receipt["txid"]); receiptStatus = try PJ.string(receipt["status"])
                try walletRequire(["pending", "submitted", "rejected", "not-sent", "unknown"].contains(receiptStatus), "CLAIMS_RECEIPT_UNAVAILABLE")
                if ["pending", "unknown"].contains(receiptStatus) {
                    unknownBlocked = true; unknown = 1
                    if limiter != 0 { status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME" }
                }
            }
            let policyURL = self.receiptURL.deletingLastPathComponent().appendingPathComponent("claims-policy-v1.json")
            if FileManager.default.fileExists(atPath: policyURL.path) {
                let saved = try ClaimsPublicStore.read(policyURL)
                allowMobile = try PJ.bool(saved["allowMobileData"])
                rate = Int(try PJ.integer(saved["connectionsPerSecondLimit"], 1, 100))
                concurrency = Int(try PJ.integer(saved["concurrency"], 1, 100))
                _ = cw_claim_limiter_set_rate(limiter, Int32(rate), &error)
            }
        } catch { status = "error"; lastError = "CLAIMS_RECEIPT_UNAVAILABLE" }
        // A write may have renamed the receipt to submitted and then failed
        // its directory fsync/readback. The old live owner remains blocked;
        // replacing its transport must not silently resolve that guard from
        // the partially committed file. Do not overwrite another pending
        // receipt, or mask an unrelated initialization failure.
        if let inheritedUnknownTxid {
            do {
                let inherited = try PJ.hash(inheritedUnknownTxid)
                try walletRequire(!unknownBlocked || lastTxid == inherited, "CLAIMS_RECEIPT_UNAVAILABLE")
                lastTxid = inherited; receiptStatus = "unknown"; unknownBlocked = true; unknown = max(unknown, 1)
                if status != "error" { status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME" }
            } catch { status = "error"; lastError = "CLAIMS_RECEIPT_UNAVAILABLE" }
        }
        network.pathUpdateHandler = { [weak self] path in
            Task { await self?.networkChanged(path.status == .satisfied, expensive: path.isExpensive || path.isConstrained) }
        }
        network.start(queue: DispatchQueue(label: "ConnectWallet.claim-network"))
    }

    deinit {
        dispatchTask?.cancel(); maintenanceTask?.cancel(); network.cancel()
        for capture in active.values { cw_claim_cancel(capture.handle) }
        cw_claim_limiter_destroy(limiter)
    }
    private func now() -> Double { ProcessInfo.processInfo.systemUptime }
    private func increment(_ count: Int64) -> Int64 { min(Self.maximum, count + 1) }
    private func check(_ token: UInt64) throws {
        try Task.checkCancellation()
        try walletRequire(!closed && enabled && allowed && !unknownBlocked && token == epoch, "CLAIMS_STOPPED")
    }
    private var fresh: Bool { !snapshotPending && pendingRevalidation.isEmpty && healthy && now() - catalogAt < 60 }
    private func syncNativeGate() {
        let allow = fresh && enabled && allowed && !closed && !unknownBlocked
        guard nativeGateAllowed != allow else { return }
        var error = [CChar](repeating: 0, count: 32)
        if cw_claim_limiter_set_allowed(limiter, allow ? 1 : 0, &error) == 1 { nativeGateAllowed = allow }
        else { healthy = false; lastError = String(cString: error) }
        if !allow { transmitting?.catalogRevoked = true; transmitting?.permit.cancel() }
    }
    private var protectedKeys: Set<String> { reservations.union(savedSubmissions.keys).union(active.values.map { $0.selection.row.key }) }
    private func pruneRetained() {
        let keys = protectedKeys
        retained = retained.filter { keys.contains($0.key) }
        normallyAged.formIntersection(Set(retained.keys))
        pendingRevalidation.formIntersection(Set(retained.values.map(\.block)))
    }
    private func retainAdmittedWork() {
        var held: [String: ClaimCandidate] = [:]
        for capture in active.values where !capture.cancelled && capture.epoch == epoch {
            let row = capture.selection.row
            if let current = ClaimSubmissionRetry.retainAvailableBounty(catalog: catalog[row.key], retained: retained[row.key], captured: row) {
                held[row.key] = current
            }
        }
        for winner in winners + (transmitting.map { [$0] } ?? []) where winnerCurrent(winner) {
            let row = winner.row
            if let current = ClaimSubmissionRetry.retainAvailableBounty(catalog: catalog[row.key], retained: retained[row.key], captured: row) {
                held[row.key] = current
            }
        }
        for saved in savedSubmissions.values {
            if let current = catalog[saved.row.key] ?? retained[saved.row.key], current.identity == saved.row.identity {
                held[current.key] = current
            }
        }
        retained = held
        pruneRetained()
    }
    private var policyStatus: String {
        !enabled ? "stopped" : !foreground ? "background-paused" : !online ? "offline" : expensive && !allowMobile ? "mobile-data-disabled" : "allowed"
    }
    private func networkChanged(_ connected: Bool, expensive: Bool) {
        online = connected; self.expensive = expensive; refreshAllowed()
    }
    public func setActive(_ value: Bool) { foreground = value; refreshAllowed() }
    private func refreshAllowed() {
        let next = enabled && foreground && online && (allowMobile || !expensive)
        guard next != allowed else { return }
        allowed = next
        if !next {
            retainAdmittedWork()
            pauseClock(); epoch &+= 1; clearFunding(); cancelCaptures(); resetAdmission(); invalidateQueued()
            snapshotPending = false; healthy = false; catalogRevision &+= 1; syncNativeGate()
            maintenanceTask?.cancel(); maintenanceTask = nil
            status = unknownBlocked ? "unknown-outcome" : enabled ? "paused" : "stopped"
        } else if !unknownBlocked {
            activeSince = now(); nextDiscovery = 0; status = "synchronizing"; resetAdmission(); launchMaintenance()
        }
    }
    private func pauseClock() { if let activeSince { elapsed += max(0, now() - activeSince); self.activeSince = nil } }
    private func clearFunding() { parentCache.removeAll(); parentOrder.removeAll(); parentBytes = 0; fundingValidation.clear() }
    private func resetAdmission() {
        admissionIdle = true
        var error = [CChar](repeating: 0, count: 32)
        if limiter != 0 { _ = cw_claim_limiter_reset(limiter, &error) }
    }
    public func start(address: String) throws {
        _ = try WalletCrypto.decodeAddress(address)
        try walletRequire(!closed && limiter != 0, "CLAIMS_CLOSED")
        try walletRequire(lastError != "CLAIMS_RECEIPT_UNAVAILABLE" || pendingReceiptRetryAllowed, "CLAIMS_RECEIPT_UNAVAILABLE")
        let receiptRecovery: (saved: ClaimSavedSubmission, status: String)?
        if let saved = provenUnsentReceipt { receiptRecovery = (saved, "not-sent") }
        else if let saved = provenRejectedReceipt { receiptRecovery = (saved, "rejected") }
        else if let saved = provenAcknowledgedReceipt { receiptRecovery = (saved, "submitted") }
        else { receiptRecovery = nil }
        let recoverableReceipt = receiptRecovery.map {
            $0.saved.retry.txid == lastTxid && savedSubmissions[$0.saved.row.key] === $0.saved
        } ?? false
        try walletRequire(!unknownBlocked || recoverableReceipt, "CLAIMS_UNKNOWN_OUTCOME")
        try walletRequire(foreground, "Open the app to start claims.")
        try walletRequire(!enabled && active.isEmpty && reservations.isEmpty && transmitting == nil, "Stop the existing claims session and wait for it to finish.")
        try walletRequire(self.address == address || savedSubmissions.isEmpty, "Resolve retained claim submissions before changing the receiving address.")
        if unknownBlocked, let recovery = receiptRecovery {
            let saved = recovery.saved
            // Failure before or after rename remains blocked. No enabled state,
            // counter reset or broadcast may precede this durable recovery.
            if FileManager.default.fileExists(atPath: receiptURL.path) {
                let stored = try ClaimsPublicStore.read(receiptURL)
                let storedTxid = try PJ.hash(stored["txid"]), storedStatus = try PJ.string(stored["status"])
                try walletRequire(["pending", "submitted", "rejected", "not-sent", "unknown"].contains(storedStatus), "CLAIMS_RECEIPT_UNAVAILABLE")
                if ["pending", "unknown"].contains(storedStatus) {
                    try walletRequire(storedTxid == saved.retry.txid, "CLAIMS_RECEIPT_UNAVAILABLE")
                }
            }
            try record(saved.retry.txid, recovery.status)
            if recovery.status == "submitted" {
                // This ACK belongs to the ending run. Mark its identity counted
                // only after persistence; the new run resets visible counters.
                _ = saved.acknowledge(now: now())
            }
            unknownBlocked = false; provenUnsentReceipt = nil; provenRejectedReceipt = nil; provenAcknowledgedReceipt = nil; lastError = ""
        }
        if self.address != address { for item in progress.values { item.prepared = nil } }
        self.address = address; enabled = true; epoch &+= 1; clearFunding(); run &+= 1
        attempts = 0; valid = 0; invalid = 0; hits = 0; submitted = 0; unknown = 0; cancelled = 0
        elapsed = 0; recentStarts.removeAll(); activeSince = nil
        retainAdmittedWork()
        blocks.removeAll(); blockOrder.removeAll(); loaded.removeAll(); catalog.removeAll(); scheduler.clear()
        cursor = nil; tip = nil; recentWindow = nil; healthy = false; dirty = true; catalogAt = 0
        snapshotPending = false; catalogRevision &+= 1
        pendingRevalidation.removeAll(); normallyAged.removeAll()
        lastError = ""; lastRpcError = nil; nextDiscovery = 0; nextBlock = 0; nextPreparation = 0; retryAt = 0
        status = "paused"; refreshAllowed()
        if dispatchTask == nil {
            dispatchTask = Task { [weak self] in
                while !Task.isCancelled {
                    guard let delay = await self?.dispatchTick() else { return }
                    try? await Task.sleep(nanoseconds: delay)
                }
            }
        }
    }
    public func stop() {
        retainAdmittedWork()
        enabled = false; allowed = false; pauseClock(); epoch &+= 1; clearFunding()
        snapshotPending = false; healthy = false; catalogRevision &+= 1; syncNativeGate()
        dispatchTask?.cancel(); dispatchTask = nil
        maintenanceTask?.cancel(); maintenanceTask = nil
        cancelCaptures(); invalidateQueued(); resetAdmission(); acknowledgeStarts()
        status = unknownBlocked ? "unknown-outcome" : "stopped"
    }
    public func close() {
        stop(); closed = true; dispatchTask?.cancel(); dispatchTask = nil; network.cancel()
        cw_claim_limiter_destroy(limiter); limiter = 0
    }
    struct Replacement: Sendable {
        let receiptURL: URL, unknownTxid: String?
        func makeEngine(rpc: MobileRpcClient) -> MobileClaimsEngine {
            MobileClaimsEngine(rpc: rpc, receiptURL: receiptURL, inheritedUnknownTxid: unknownTxid)
        }
    }
    /// Capture the authoritative public guard and revoke old callbacks in one
    /// actor turn. Both successful and failed endpoint replacements use it.
    func closeForReplacement() throws -> Replacement {
        try walletRequire(!closed && canChangeEndpoint(), "Wait for claim submission before changing RPC")
        if unknownBlocked, FileManager.default.fileExists(atPath: receiptURL.path) {
            do {
                let stored = try ClaimsPublicStore.read(receiptURL)
                if let storedStatus = stored["status"] as? String, ["pending", "unknown"].contains(storedStatus) {
                    try walletRequire(try PJ.hash(stored["txid"]) == lastTxid, "CLAIMS_RECEIPT_UNAVAILABLE")
                }
            } catch {
                // Preserve both the original owner and the conflicting file.
                // Revoke any already running manual lookup too: it must not
                // overwrite the other receipt when its response arrives.
                stop(); status = "error"; lastError = "CLAIMS_RECEIPT_UNAVAILABLE"
                throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE")
            }
        }
        let replacement = Replacement(receiptURL: receiptURL, unknownTxid: unknownBlocked ? lastTxid : nil)
        close()
        return replacement
    }
    public func canChangeEndpoint() -> Bool { !enabled && active.isEmpty && reservations.isEmpty && transmitting == nil && winners.isEmpty && savedSubmissions.isEmpty }
    public func policy(_ options: JSONObject) throws -> JSONObject {
        try walletRequire(!closed && limiter != 0, "CLAIMS_CLOSED")
        try PJ.keys(options, ["allowMobileData", "allowBackground"])
        let mobile = try PJ.bool(options["allowMobileData"]), background = try PJ.bool(options["allowBackground"])
        try walletRequire(!background, "iOS claims can run only while the wallet is visible.")
        try savePolicy(mobile: mobile, rate: rate, concurrency: concurrency)
        allowMobile = mobile; refreshAllowed(); return state()
    }
    public func limits(_ options: JSONObject) throws -> JSONObject {
        // Runtime replacement may have closed this actor while a settings
        // request was queued. Never persist through an obsolete policy owner.
        try walletRequire(!closed && limiter != 0, "CLAIMS_CLOSED")
        try PJ.keys(options, ["connectionsPerSecondLimit", "concurrency"])
        let nextRate = Int(try PJ.integer(options["connectionsPerSecondLimit"], 1, 100))
        let nextConcurrency = Int(try PJ.integer(options["concurrency"], 1, 100))
        try walletRequire(foreground, "Open the app to change claims limits.")
        try savePolicy(mobile: allowMobile, rate: nextRate, concurrency: nextConcurrency)
        var error = [CChar](repeating: 0, count: 32)
        try walletRequire(cw_claim_limiter_set_rate(limiter, Int32(nextRate), &error) == 1, String(cString: error))
        rate = nextRate; concurrency = nextConcurrency; resetAdmission(); nextAdmission = now() + 1 / Double(rate)
        return state()
    }
    private func savePolicy(mobile: Bool, rate: Int, concurrency: Int) throws {
        let url = receiptURL.deletingLastPathComponent().appendingPathComponent("claims-policy-v1.json")
        try writePublic(["allowMobileData": mobile, "allowBackground": false, "connectionsPerSecondLimit": rate, "concurrency": concurrency], url)
    }
    private func writePublic(_ data: JSONObject, _ url: URL) throws {
        try ClaimsPublicStore.write(data, to: url)
    }
    private func record(_ txid: String, _ value: String) throws {
        do { try writePublic(["txid": txid, "status": value], receiptURL); lastTxid = txid; receiptStatus = value }
        catch { throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE") }
    }
    /// This failure is known to precede the socket write. Keep the existing
    /// in-memory winner and allow an explicit Start to retry its persistence,
    /// not to bypass it. Corrupt startup receipts and uncertain writes never
    /// receive this exception to the storage-error safety stop.
    func persistPendingSubmission(_ txid: String) throws {
        try walletRequire(!closed && enabled && !unknownBlocked, "CLAIMS_STOPPED")
        _ = try PJ.hash(txid)
        do {
            try record(txid, "pending")
            pendingReceiptRetryAllowed = false
        } catch {
            pendingReceiptRetryAllowed = true
            handleReadFailure(error, epoch)
            throw error
        }
    }
    /// The caller has already attached and validated the complete public proof.
    /// Register its sole owner before scheduler retirement or submission.
    func retainCompletedSubmission(_ saved: ClaimSavedSubmission) throws {
        try walletRequire(!closed && enabled && !unknownBlocked, "CLAIMS_STOPPED")
        try walletRequire(savedSubmissions[saved.row.key] == nil &&
            savedSubmissions.count < ClaimSubmissionRetry.maximumRetainedWinners, "CLAIMS_CAPACITY")
        savedSubmissions[saved.row.key] = saved
    }
    /// Record a positive transport/gateway no-submission result. If storage
    /// fails, keep the ordinary unknown guard plus this exact live owner. Start
    /// must retry the durable not-sent commit before restoring its same bytes.
    func persistUnsentSubmission(_ saved: ClaimSavedSubmission, failure: RpcFailure) throws -> Bool {
        try walletRequire(!unknownBlocked && savedSubmissions[saved.row.key] === saved && lastTxid == saved.retry.txid &&
            (failure.notSent || failure.notForwarded) && !failure.unknownOutcome &&
            !failure.explicitRejection && failure.nodeCode == nil, "CLAIMS_RECEIPT_STATE")
        let retryable = saved.retry.retain(after: failure, now: now())
        do {
            try record(saved.retry.txid, "not-sent")
            provenUnsentReceipt = nil
            return retryable
        } catch {
            uncertain(saved.retry.txid)
            provenUnsentReceipt = saved
            throw error
        }
    }
    /// A parsed Core rejection resolves uncertainty about this attempt, not
    /// the bounty's availability. Keep its separate retry gate even if storing
    /// rejected fails; Start must commit that exact status before unblocking.
    func persistRejectedSubmission(_ saved: ClaimSavedSubmission, failure: RpcFailure) throws {
        try walletRequire(!unknownBlocked && savedSubmissions[saved.row.key] === saved && lastTxid == saved.retry.txid &&
            failure.code == "-32020" && failure.explicitRejection &&
            [-22, -25, -26, -8].contains(failure.nodeCode ?? 0) &&
            !failure.unknownOutcome && !failure.notSent && !failure.notForwarded, "CLAIMS_RECEIPT_STATE")
        // Reopening may already have committed while the response was in
        // flight. rejected() preserves that evidence and any previous ACK.
        saved.rejected()
        do {
            try record(saved.retry.txid, "rejected")
            provenRejectedReceipt = nil
        } catch {
            uncertain(saved.retry.txid)
            provenRejectedReceipt = saved
            throw error
        }
    }
    /// Keep the positive ACK if its durable receipt fails. It may disappear
    /// from mempool before a manual lookup, which is not grounds to forget
    /// either the ACK or the exact locally validated transaction that was sent.
    func persistAcknowledgedSubmission(_ saved: ClaimSavedSubmission, response: JSONObject) throws {
        try walletRequire(!unknownBlocked && savedSubmissions[saved.row.key] === saved && lastTxid == saved.retry.txid &&
            response["txid"] as? String == saved.retry.txid, "CLAIMS_RECEIPT_STATE")
        do {
            try record(saved.retry.txid, "submitted")
            provenAcknowledgedReceipt = nil
        } catch {
            uncertain(saved.retry.txid)
            provenAcknowledgedReceipt = saved
            throw error
        }
        if saved.acknowledge(now: now()) { submitted = increment(submitted) }
    }
    public func checkSubmission() async throws -> JSONObject {
        try walletRequire(lastError != "CLAIMS_RECEIPT_UNAVAILABLE", "CLAIMS_RECEIPT_UNAVAILABLE")
        try walletRequire(foreground && unknownBlocked && !lastTxid.isEmpty, "No indeterminate claim submission to resolve.")
        let expected = lastTxid, receiptEpoch = epoch
        let response = try await rpc.call("gettransaction", ["txid": expected])
        try Task.checkCancellation()
        // The actor can be stopped/closed, or a concurrent receipt check can
        // resolve this outcome while the RPC is in flight. Its old callback
        // must not rewrite the receipt or stop a subsequently started run.
        try walletRequire(!closed && foreground && unknownBlocked && epoch == receiptEpoch && lastTxid == expected,
            "CLAIMS_RECEIPT_STATE")
        _ = try Self.validateTip(response["tip"])
        try walletRequire(["pending", "confirmed"].contains(try PJ.string(response["status"])), "The node has not confirmed receipt. Claims remain paused.")
        if let saved = savedSubmissions.values.first(where: { $0.retry.txid == expected }) {
            let committed = try saved.commitReceipt(response, known: nil, now: now()) {
                do { try self.record(expected, "submitted") }
                catch {
                    // commitReceipt reaches persistence only after all raw
                    // proof/identity/location checks. Keep this positive read
                    // for the same live owner if its receipt cannot commit;
                    // never derive it from absence or a restored txid alone.
                    if self.unknownBlocked && self.lastTxid == expected && self.savedSubmissions[saved.row.key] === saved {
                        self.provenUnsentReceipt = nil; self.provenRejectedReceipt = nil
                        self.provenAcknowledgedReceipt = saved
                    }
                    throw error
                }
            }
            if committed.firstAck { submitted = increment(submitted) }
            if let retirement = committed.retirement {
                confirmedRetirements[saved.row.key] = retirement
                savedSubmissions.removeValue(forKey: saved.row.key)
            }
        } else {
            _ = try ClaimSavedSubmission.validateReceipt(response, expectedTxid: expected)
            try record(expected, "submitted")
        }
        unknownBlocked = false; provenUnsentReceipt = nil; provenRejectedReceipt = nil; provenAcknowledgedReceipt = nil; lastError = ""; stop(); return state()
    }
    private static func validateTip(_ value: Any?) throws -> JSONObject {
        try ClaimRecentWindow.Tip(value).json
    }
    private func request(_ method: String, _ params: JSONObject, _ token: UInt64) async throws -> JSONObject {
        try check(token)
        do { let response = try await rpc.call(method, params); try check(token); return response }
        catch let failure as RpcFailure {
            if token == epoch {
                lastRpcError = ["code": failure.code, "method": method, "phase": "request", "stage": "discovery", "elapsedMs": 0, "queuedMs": 0, "bytesReceived": 0]
            }
            throw failure
        }
    }
    private func launchMaintenance() {
        guard maintenanceTask == nil else { return }
        let token = epoch
        maintenanceTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.maintain(token)
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }
    private func maintain(_ token: UInt64) async {
        guard enabled && allowed && token == epoch && !unknownBlocked && now() >= retryAt else { return }
        do {
            if now() >= nextDiscovery { try await discover(token) }
            let protectedBlocks = Set(retained.values.map(\.block)).union(confirmationReloads)
            if now() >= nextBlock, let missing = blockOrder.first(where: { protectedBlocks.contains($0) && !loaded.contains($0) }) ?? blockOrder.first(where: { !loaded.contains($0) }) {
                try await loadBlock(missing, token)
            }
            try await reconcileSaved(token)
            refreshSchedule()
            if fresh, let selection = scheduler.next(now: now(), prepared: false) { try await prepare(selection.row, token) }
            try check(token)
            status = !fresh ? "retrying" : transmitting != nil ? "submitting" : scheduler.next(now: now(), prepared: true) != nil ? "claiming" : loaded.count < blocks.count ? "synchronizing" : "waiting"
        } catch is CancellationError { }
        catch { handleReadFailure(error, token) }
    }
    private func discover(_ token: UInt64) async throws {
        try await replay(token)
        nextDiscovery = now() + 10
    }
    private func loadBlock(_ hash: String, _ token: UInt64) async throws {
        try check(token)
        let revision = catalogRevision
        let chunks = try await rpc.streamBounties(hash)
        try check(token)
        try walletRequire(revision == catalogRevision, "CLAIMS_SNAPSHOT_STALE")
        var staged: [String: ClaimCandidate] = [:]
        for chunk in chunks {
            _ = try Self.validateTip(chunk["tip"])
            guard chunk["type"] as? String == "bounties" else { continue }
            for item in try PJ.objects(chunk["items"]) {
                var candidate = try ClaimCandidate(item, block: hash, fee: NativeTransactions.claimFee(1500))
                try walletRequire(blocks[hash] == candidate.height && staged[candidate.key] == nil && staged.count < ClaimSubmissionRetry.maximumCatalogEntries, "CLAIMS_CAPACITY")
                if let previous = progress[candidate.key] { try candidate.reuse(previous) }
                staged[candidate.key] = candidate
            }
        }
        try await replay(token, newBlock: hash, staged: staged)
        nextBlock = now() + 1.5
    }
    private func replay(_ token: UInt64, newBlock: String? = nil, staged: [String: ClaimCandidate] = [:]) async throws {
        try check(token)
        // No new admissions can race the protected-work snapshot. Native
        // waiters pause atomically before TCP; started sockets keep running.
        retainAdmittedWork(); snapshotPending = true; syncNativeGate()
        let revision = catalogRevision
        var published = false
        defer {
            if token == epoch {
                if !published { healthy = false }
                snapshotPending = false; syncNativeGate()
            }
        }
        let began = now()
        let result = try await ClaimDiscoveryReplay.read(known: recentWindow, cursor: cursor, catalog: catalog,
            loaded: loaded, newBlock: newBlock, staged: staged, retained: retained) { method, params in
                try await self.request(method, params, token)
            }
        try check(token)
        try walletRequire(revision == catalogRevision, "CLAIMS_SNAPSHOT_STALE")
        let next = result.catalog, nextLoaded = result.loaded, nextBlocks = result.window.heights
        let protected = protectedKeys
        let nextProgress = try ClaimProgress.reconcile(previous: progress, catalog: next,
            window: result.window, loaded: nextLoaded, protected: protected)
        blocks = nextBlocks; blockOrder = result.window.order; recentWindow = result.window
        loaded = nextLoaded; catalog = next; progress = nextProgress
        retained = result.retained.filter { protectedKeys.contains($0.key) }
        normallyAged = result.normallyAged.intersection(Set(retained.keys))
        pendingRevalidation = Set(retained.values.filter { nextBlocks[$0.block] != nil && !nextLoaded.contains($0.block) }.map(\.block))
        let policies = Set(nextProgress.values.map(\.policy)); stats = stats.filter { policies.contains($0.key) }
        retired = retired.intersection(Set(progress.keys).union(reservations))
        confirmedRetirements = confirmedRetirements.filter { progress[$0.key] != nil }
        confirmationReloads.removeAll()
        for (key, confirmation) in confirmedRetirements where savedSubmissions[key] == nil && !reservations.contains(key) {
            switch confirmation.observe(window: result.window, newBlock: newBlock, staged: staged[key], current: catalog[key]) {
            case .none: break
            case .reload(let block): loaded.remove(block); confirmationReloads.insert(block)
            case .reopen: retired.remove(key)
            }
        }
        cursor = result.cursor; tip = result.window.tip.json; healthy = true; catalogAt = began; dirty = true
        // Only a complete fenced catalog may discard a never-acknowledged
        // proof after a confirmed spend or a known funding-identity conflict.
        // Pending spends and temporary absence keep the public bytes.
        for (key, saved) in savedSubmissions where !saved.acknowledged && !reservations.contains(key) {
            let current = catalog[key] ?? retained[key]
            let invalid = current.map { $0.identity != saved.row.identity || $0.state == "spent" } ??
                (nextLoaded.contains(saved.row.block) || saved.row.height >= (result.window.blocks.last?.height ?? 0) && nextBlocks[saved.row.block] == nil)
            if invalid { savedSubmissions.removeValue(forKey: key); retired.remove(key) }
        }
        for key in result.availableAgain {
            if let saved = savedSubmissions[key] { saved.reopened() }
            else if confirmedRetirements[key] == nil, !reservations.contains(key), catalog[key]?.state == "available" { retired.remove(key) }
        }
        lastRpcError = nil; lastError = ""; invalidateQueued()
        for capture in active.values where !ClaimSubmissionRetry.matchesAvailableBounty(catalog[capture.selection.row.key] ?? retained[capture.selection.row.key], captured: capture.selection.row) {
            cancelCaptures(capture.selection.row.key)
        }
        // The native gate is still closed, so start observation and this
        // cancellation cannot race a new connect. Aging protects work which
        // already started, not another TCP attempt outside the catalog.
        acknowledgeStarts()
        for id in active.keys {
            guard var capture = active[id], !capture.started, !capture.cancelled,
                  nextBlocks[capture.selection.row.block] == nil else { continue }
            capture.cancelled = true; active[id] = capture; cw_claim_cancel(capture.handle)
        }
        published = true
    }
    private func prepare(_ row: ClaimCandidate, _ token: UInt64) async throws {
        try check(token)
        guard fresh, available(row.key), row.progress.prepared == nil else { return }
        let txid = try PJ.hash(row.bounty["txid"])
        var parent = parentCache[txid]
        if parent == nil {
            guard now() >= nextPreparation else { return }
            nextPreparation = now() + 1.5
            let response = try await request("gettransaction", ["txid": txid], token)
            _ = try Self.validateTip(response["tip"])
            parent = try PJ.string(PJ.object(response["transaction"])["hex"])
        }
        let prepared = try fundingValidation.prepareClaim(row.bounty, parent!, address, 1500) { try self.check(token) }
        try check(token)
        guard fresh, available(row.key), let current = catalog[row.key] else { return }
        if parentCache[txid] == nil, parent!.utf8.count <= 8 * 1024 * 1024 {
            while !parentOrder.isEmpty && (parentOrder.count >= 128 || parentBytes + parent!.utf8.count > 8 * 1024 * 1024) {
                let oldest = parentOrder.removeFirst(); parentBytes -= parentCache.removeValue(forKey: oldest)?.utf8.count ?? 0
            }
            parentCache[txid] = parent!; parentOrder.append(txid); parentBytes += parent!.utf8.count
        }
        current.progress.prepared = prepared
    }
    private func enqueueSaved(_ saved: ClaimSavedSubmission) {
        let key = saved.row.key
        guard !reservations.contains(key), saved.availableForRetry(catalog: catalog[key], retained: retained[key],
            normallyAged: normallyAged.contains(key), coherent: fresh, oldestHeight: recentWindow?.blocks.last?.height) else { return }
        retired.insert(key); reservations.insert(key); scheduler.remove(key)
        winners.append(Winner(saved: saved, epoch: epoch, validUntil: catalogAt + 60))
    }
    /// Confirmation polling shares the ordinary RPC quota. It neither creates
    /// another proof nor releases a record on a timeout, absence or malformed ACK.
    private func reconcileSaved(_ token: UInt64) async throws {
        try check(token)
        guard fresh else { return }
        for saved in savedSubmissions.values where !saved.acknowledged { enqueueSaved(saved) }
        guard now() >= nextSavedCheck, now() >= nextPreparation,
              let saved = savedSubmissions.values.filter({ $0.acknowledged && !reservations.contains($0.row.key) && $0.nextCheck <= now() })
                .min(by: { $0.nextCheck < $1.nextCheck }) else { return }
        // Twelve receipt probes/minute leave room for normal funding reads.
        // Both paths still share the transport's per-method quota and cooldown.
        nextSavedCheck = now() + 5; nextPreparation = max(nextPreparation, now() + 1.5)
        saved.nextCheck = now() + 30
        do {
            let response = try await rpc.call("gettransaction", ["txid": saved.retry.txid])
            try check(token)
            guard savedSubmissions[saved.row.key] === saved else { return }
            if try saved.location(response, known: recentWindow) == .confirmed {
                confirmedRetirements[saved.row.key] = try ClaimConfirmedRetirement(validated: saved, response: response, known: recentWindow)
                savedSubmissions.removeValue(forKey: saved.row.key); pruneRetained()
            } else { saved.foundPending() }
        } catch let failure as RpcFailure where failure.code == "-32004" && !failure.unknownOutcome && !failure.explicitRejection && failure.nodeCode == nil {
            try check(token)
            let key = saved.row.key
            if catalog[key] == nil, let oldest = recentWindow?.blocks.last?.height,
               catalogAt > saved.acknowledgedAt,
               saved.agedAbsenceMayRestoreOwnPending(current: retained[key], oldestHeight: oldest, coherent: fresh) {
                // An ordinary window exit stops journal updates for this row.
                // The last pending spender may be our own now-absent claim,
                // never a competing transaction. Its attached bytes, output,
                // receiver and proof were already validated; no new claim is
                // generated and Core still performs the final UTXO checks.
                saved.observedAgedAbsence(current: retained[key], oldestHeight: oldest, catalogAt: catalogAt, coherent: fresh)
            }
            let available = saved.availableForRetry(catalog: catalog[key], retained: retained[key],
                normallyAged: normallyAged.contains(key), coherent: fresh, oldestHeight: recentWindow?.blocks.last?.height)
            if savedSubmissions[saved.row.key] === saved && saved.absentAfterFreshSnapshot(catalogAt: catalogAt, available: available) {
                enqueueSaved(saved)
            }
        }
    }
    private func handleReadFailure(_ error: Error, _ token: UInt64) {
        guard token == epoch && enabled else { return }
        let code = (error as? RpcFailure)?.code ?? (error as? WalletError)?.message ?? "CLAIMS_FAILED"
        if code == "CLAIMS_STOPPED" { return }
        if code == "CLAIMS_SNAPSHOT_STALE" { nextDiscovery = 0; return }
        lastError = code.hasPrefix("CLAIM") || code.hasPrefix("RPC_") || code.hasPrefix("-32") ? code : "CLAIMS_RPC_DATA"
        if ["CLAIMS_WRONG_NETWORK", "CLAIMS_CAPACITY", "CLAIMS_RPC_DATA", "CLAIMS_NATIVE_DATA", "CLAIMS_RECEIPT_UNAVAILABLE"].contains(lastError) {
            stop(); status = "error"; healthy = false
        } else {
            retryAt = now() + max(code == "CLAIMS_SYNC_BUSY" ? 1 : code == "-32029" ? 60 : 5,
                min(60, Double(max(0, (error as? RpcFailure)?.retryAfterMs ?? 0)) / 1000))
            nextDiscovery = 0; status = "retrying"
            // Only these explicitly transient read failures preserve a fresh
            // catalog. A reset revokes permission to start/write, not public
            // work already admitted. A new coherent snapshot is the barrier.
            let transient = (error as? RpcFailure).map {
                !$0.unknownOutcome && ["RPC_TIMEOUT", "RPC_UNAVAILABLE", "RPC_BUSY", "-32001", "-32029", "-32030"].contains($0.code)
            } ?? false
            if !transient {
                retainAdmittedWork(); healthy = false; catalogRevision &+= 1; syncNativeGate(); acknowledgeStarts()
                if ["-32011", "-32004", "CLAIMS_SYNC_BUSY"].contains(code) {
                    // A local page/coherence budget is not invalid RPC data.
                    // Take a new watermark before reloading complete blocks,
                    // instead of replaying the same oversized backlog forever.
                    // Keep admitted proofs/progress/counters and the hash anchor;
                    // the native/write gate stays closed until that snapshot and
                    // the protected blocks have been coherently revalidated.
                    catalog.removeAll(); blocks.removeAll(); blockOrder.removeAll(); loaded.removeAll(); scheduler.clear()
                    cursor = nil; tip = nil; catalogAt = 0; dirty = true
                }
            }
        }
    }
    private func available(_ key: String) -> Bool { guard let row = catalog[key] else { return false }; return row.supported && row.state == "available" && !retired.contains(key) }
    private func refreshSchedule() {
        if dirty || now() >= nextSchedule { scheduler.rebuild(Array(catalog.values), stats: stats, retired: retired, now: now()); dirty = false; nextSchedule = now() + 5 }
    }
    private func cancelCaptures(_ key: String? = nil, except: UInt64? = nil) {
        for id in active.keys {
            guard id != except, var capture = active[id], !capture.cancelled,
                  key == nil || capture.selection.row.key == key else { continue }
            capture.cancelled = true; active[id] = capture; cw_claim_cancel(capture.handle)
        }
    }
    private func invalidateQueued() {
        if let transmitting, !winnerCurrent(transmitting) { transmitting.permit.cancel() }
        winners.removeAll { winner in
            guard !winnerCurrent(winner) else { return false }
            winner.permit.cancel(); reservations.remove(winner.row.key)
            if savedSubmissions[winner.row.key] == nil { retired.remove(winner.row.key); dirty = true }
            return true
        }
        pruneRetained()
    }
    private func winnerCurrent(_ winner: Winner) -> Bool {
        !closed && enabled && allowed && !unknownBlocked && winner.epoch == epoch &&
            reservations.contains(winner.row.key) &&
            winner.saved.matchesCurrent(catalog: catalog[winner.row.key], retained: retained[winner.row.key],
                oldestHeight: recentWindow?.blocks.last?.height)
    }
    private func winnerReady(_ winner: Winner) -> Bool {
        winnerCurrent(winner) && winner.saved.availableForRetry(catalog: catalog[winner.row.key],
            retained: retained[winner.row.key], normallyAged: normallyAged.contains(winner.row.key), coherent: fresh,
            oldestHeight: recentWindow?.blocks.last?.height)
    }
    private func acknowledge(_ id: UInt64) {
        guard var capture = active[id], !capture.started else { return }
        let observed = now(), age = cw_claim_started_age_nanos(capture.handle)
        guard age >= 0 else { return }
        capture.started = true; active[id] = capture
        let started = observed - Double(age) / 1_000_000_000
        scheduler.acknowledge(capture.selection, now: started)
        if capture.run == run { attempts = increment(attempts); if now() - started < 10 { recentStarts.append(started); recentStarts.sort() } }
    }
    private func acknowledgeStarts() { nextAck = now() + 0.02; for id in active.keys { acknowledge(id) }; recentStarts.removeAll { now() - $0 >= 10 } }
    private func dispatchTick() -> UInt64 {
        if now() >= nextAck { acknowledgeStarts() }
        syncNativeGate()
        if !fresh { invalidateQueued(); admissionIdle = true }
        launchSubmission()
        guard !closed && enabled && allowed && !unknownBlocked && fresh && reservations.count < 100 &&
            savedSubmissions.count + active.count < ClaimSubmissionRetry.maximumRetainedWinners else { admissionIdle = true; return 100_000_000 }
        guard active.count < concurrency && now() >= nextAdmission else { return 2_000_000 }
        refreshSchedule()
        guard let selected = scheduler.next(now: now(), prepared: true) else { admissionIdle = true; return 100_000_000 }
        let row = selected.row
        guard available(row.key) && row.budget else { scheduler.remove(row.key); return 2_000_000 }
        if !selected.recovering && !ClaimScheduler.worth(row, rate: stats[row.policy]?.rate ?? 5) { dirty = true; return 2_000_000 }
        if stats[row.policy] == nil { guard stats.count < 3584 else { handleReadFailure(WalletError("CLAIMS_CAPACITY"), epoch); return 100_000_000 }; stats[row.policy] = ClaimPerformanceWindow() }
        var error = [CChar](repeating: 0, count: 32)
        let handle = cw_claim_cancellation_create(limiter, &error)
        guard handle != 0 else { lastError = String(cString: error); return 100_000_000 }
        let budgetKey = String(run) + ":" + row.key
        let bound = budgetKey.withCString { key in row.target.withCString { target in String(row.progress.captures).withCString { count in
            cw_claim_bind_budget(handle, key, target, count, &error)
        } } }
        guard bound == 1 else { cw_claim_cancellation_destroy(handle); lastError = String(cString: error); return 100_000_000 }
        guard scheduler.reserve(selected, now: now()) else { cw_claim_cancellation_destroy(handle); return 2_000_000 }
        nextCapture &+= 1
        let capture = Capture(id: nextCapture, epoch: epoch, run: run, handle: handle, selection: selected)
        active[capture.id] = capture
        let pacedAt = now(); if admissionIdle { nextAdmission = max(nextAdmission, pacedAt) }
        nextAdmission = max(nextAdmission + 1 / Double(rate), pacedAt - 1); admissionIdle = false
        guard let prepared = row.progress.prepared, let challenge = prepared["challenge"] as? String,
              let time = try? PJ.integer(tip?["mediantime"], 1) else { release(capture.id); return 100_000_000 }
        let domain = row.domain, target = row.target, mask = row.mask, captureID = capture.id
        capturesQueue.async { [weak self] in
            var result = cw_claim_result()
            let completed = domain.withCString { domain in challenge.withCString { challenge in target.withCString { target in
                var context = cw_claim_context(domain: domain, challenge_hex: challenge, target_hex: target,
                    roots_version: 1, signature_mask: mask, validation_time: time)
                return cw_claim_capture(&context, 10_000, handle, &result)
            } } }
            let code = withUnsafeBytes(of: result.error_code) { bytes in String(cString: bytes.bindMemory(to: CChar.self).baseAddress!) }
            let value = NativeProofResult(completed: completed == 1, proof: result.proof_hex.map { String(cString: $0) } ?? "",
                captured: result.captured != 0, validationPassed: result.validation_passed != 0,
                valid: result.valid_proof != 0, hit: result.meets_target != 0, duration: result.duration_ms, error: code)
            cw_claim_result_free(&result)
            Task {
                if let self { await self.complete(captureID, value) }
                else { cw_claim_cancellation_destroy(handle) }
            }
        }
        return 2_000_000
    }
    private struct NativeProofResult {
        let completed: Bool, proof: String, captured: Bool, validationPassed: Bool, valid: Bool, hit: Bool, duration: Int64, error: String
    }
    private func release(_ id: UInt64) {
        acknowledge(id)
        guard let capture = active.removeValue(forKey: id) else { return }
        // Removal makes this import exactly once, including callbacks rejected
        // by an epoch/pause guard. Native captures consume budget before they
        // can lose usable proof to cancellation; preserve that accounting when
        // a later Start creates a new native run/budget key.
        if cw_claim_has_captured(capture.handle) == 1 {
            let row = capture.selection.row
            ClaimProgress.recordNativeCapture(row, hasCaptured: true, current: progress[row.key])
            if !row.budget || catalog[row.key]?.budget == false { scheduler.remove(row.key) }
        }
        scheduler.release(capture.selection); cw_claim_cancellation_destroy(capture.handle)
        pruneRetained()
    }
    private func complete(_ id: UInt64, _ result: NativeProofResult) {
        acknowledge(id)
        guard let capture = active[id] else { return }
        defer { release(id) }
        let row = capture.selection.row
        guard capture.epoch == epoch && enabled && allowed && !capture.cancelled else {
            if capture.run == run { cancelled = increment(cancelled) }; return
        }
        if !result.completed {
            if result.error == "CLAIM_CANCELLED" { cancelled = increment(cancelled); return }
            if result.error == "CLAIM_BUDGET" {
                guard !capture.started && !result.captured && !result.validationPassed && !result.valid && !result.hit && result.proof.isEmpty else {
                    handleReadFailure(WalletError("CLAIMS_NATIVE_DATA"), capture.epoch); return
                }
                row.progress.budgetExhausted = true
                scheduler.remove(row.key); return
            }
            if result.error == "CLAIM_DNS" { stats[row.policy]?.retryAfter = now() + 2; dirty = true }
            if ["CLAIM_DNS", "CLAIM_CONTEXT", "CLAIM_TIMEOUT", "CLAIM_BUSY", "CLAIM_LOCAL_UNAVAILABLE"].contains(result.error) { lastError = result.error; return }
            handleReadFailure(WalletError(result.error), capture.epoch); return
        }
        let locallyUnavailable = result.error == "CLAIM_LOCAL_UNAVAILABLE"
        guard capture.started, (0...60_000).contains(result.duration), !result.valid || result.validationPassed,
              !result.validationPassed || result.captured, !result.hit || result.valid,
              !locallyUnavailable || !result.captured && !result.validationPassed && !result.valid && !result.hit,
              result.valid || result.proof.isEmpty else { handleReadFailure(WalletError("CLAIMS_NATIVE_DATA"), capture.epoch); return }
        if !locallyUnavailable { stats[row.policy]?.record(result.validationPassed, Double(result.duration) / 1000) }
        if result.validationPassed { valid = increment(valid) } else { invalid = increment(invalid) }
        if result.hit { hits = increment(hits) }
        if lastRpcError == nil { lastError = result.valid ? "" : result.error.isEmpty ? "CLAIM_INVALID_PROOF" : result.error }
        // A completed valid winner may arrive just as catalog freshness expires.
        // Keep it while identity/lifecycle remain valid; launchSubmission and
        // the write permit still require a refreshed catalog before any write.
        guard result.hit && !retired.contains(row.key),
              ClaimSubmissionRetry.matchesAvailableBounty(catalog[row.key] ?? retained[row.key], captured: row),
              let prepared = row.progress.prepared else { return }
        do {
            // Attach once. Every transport retry reuses these exact immutable
            // bytes and txid, with no new TLS work or transaction generation.
            try walletRequire(ClaimSubmissionRetry.canAppendWinner(currentCount: winners.count + (transmitting == nil ? 0 : 1)), "CLAIMS_CAPACITY")
            let completed = try NativeTransactions.attachClaim(prepared, result.proof)
            let winner = try Winner(row: row, completed: completed, epoch: capture.epoch, validUntil: catalogAt + 60)
            confirmedRetirements[row.key]?.inheritCount(on: winner.saved)
            try retainCompletedSubmission(winner.saved)
            retired.insert(row.key); reservations.insert(row.key); scheduler.remove(row.key); cancelCaptures(row.key, except: id)
            winners.append(winner); launchSubmission()
        } catch { handleReadFailure(error, capture.epoch) }
    }
    private func launchSubmission() {
        invalidateQueued()
        guard submissionTask == nil, fresh, let index = winners.firstIndex(where: { $0.retry.due <= now() && winnerReady($0) }) else { return }
        let winner = winners.remove(at: index)
        winner.permit = RpcBroadcastPermit(validUntil: catalogAt + 60)
        winner.catalogRevoked = false
        transmitting = winner; status = "submitting"
        submissionTask = Task { [weak self] in await self?.submit(winner) }
    }
    private func submit(_ winner: Winner) async {
        var attempted = false, retained = false
        defer {
            if !retained {
                reservations.remove(winner.row.key)
                if !attempted && savedSubmissions[winner.row.key] == nil { retired.remove(winner.row.key); dirty = true }
                // available_again may have committed while this write was in
                // flight. Do not lose that evidence when rejection drains last.
                if savedSubmissions[winner.row.key] == nil && winner.saved.reopenedSinceWrite && catalog[winner.row.key]?.state == "available" {
                    retired.remove(winner.row.key); dirty = true
                }
            }
            transmitting = nil; submissionTask = nil
            pruneRetained()
            launchSubmission()
        }
        do {
            try check(winner.epoch)
            guard winnerCurrent(winner) else { return }
            if !winnerReady(winner) { winner.retry.waitForFreshCatalog(now: now()); winners.append(winner); retained = true; return }
            let txid = winner.retry.txid
            try persistPendingSubmission(txid); attempted = true; winner.saved.beginWrite()
            do {
                let response = try await rpc.broadcast(winner.retry.hex, permit: winner.permit)
                guard response["txid"] as? String == txid else { uncertain(txid); return }
                do { try persistAcknowledgedSubmission(winner.saved, response: response) }
                catch { if provenAcknowledgedReceipt !== winner.saved { uncertain(txid) }; return }
                if winner.epoch == epoch && enabled { status = "submitted" }
            } catch let error as RpcFailure {
                if error.unknownOutcome || error.nodeCode == -27 { uncertain(txid); return }
                if error.notSent || error.notForwarded {
                    let retryable: Bool
                    do { retryable = try persistUnsentSubmission(winner.saved, failure: error); attempted = false }
                    catch { if provenUnsentReceipt !== winner.saved { uncertain(txid) }; return }
                    // A lifecycle pause may have happened while this response
                    // was in flight. Keep its full cooldown on the retained
                    // bytes even when the old lifecycle-bound Winner is gone.
                    if winnerCurrent(winner) {
                        let expired = error.code == "RPC_CANCELLED" && (winner.catalogRevoked || winner.permit.expired || !winnerReady(winner))
                        if expired { winner.retry.waitForFreshCatalog(now: now()) }
                        if expired || retryable {
                            winners.append(winner); retained = true; status = "retrying"
                            lastError = error.code; nextDiscovery = 0
                            return
                        }
                    }
                    if error.code != "RPC_CANCELLED" { handleReadFailure(error, winner.epoch) }
                    return
                }
                // Other responses without a validated node rejection are not
                // proof of non-broadcast. Never convert them into safe retries.
                guard error.explicitRejection else { uncertain(txid); return }
                do { try persistRejectedSubmission(winner.saved, failure: error) }
                catch { if provenRejectedReceipt !== winner.saved { uncertain(txid) }; return }
                // Keep the exact locally validated proof. A rejected first
                // attempt waits for a validated reopening rather than another
                // capture; a previously ACKed replay may still be confirmed.
                lastError = "CLAIMS_REJECTED"; nextDiscovery = 0
                lastRpcError = ["code": error.code, "method": "sendrawtransaction", "phase": "response", "stage": "submission", "elapsedMs": 0, "queuedMs": 0, "bytesReceived": 0]
            } catch { uncertain(txid) }
        } catch { handleReadFailure(error, winner.epoch) }
    }
    private func uncertain(_ txid: String) {
        provenUnsentReceipt = nil
        provenRejectedReceipt = nil
        provenAcknowledgedReceipt = nil
        pendingReceiptRetryAllowed = false
        unknown = increment(unknown); unknownBlocked = true; lastTxid = txid
        try? record(txid, "unknown")
        stop(); status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME"
    }
    public func state() -> JSONObject {
        acknowledgeStarts()
        let domains: [JSONObject] = stats.keys.sorted().map { key in
            let value = stats[key]!, parts = key.split(separator: ":")
            let measuredRate = value.rate
            return ["domain": parts.dropLast().joined(separator: ":"), "signatureAlgorithmsMask": Int(parts.last ?? "0") ?? 0,
                "connections": value.connections, "totalTime": value.totalTime, "rate": measuredRate, "completed": value.completed]
        }
        let availableRows = catalog.values.filter { available($0.key) && $0.budget }
        let eligible = availableRows.filter { $0.raw > ClaimInteger() && ClaimScheduler.worth($0, rate: stats[$0.policy]?.rate ?? 5) }.count
        let retainedCapacity = enabled && allowed && !unknownBlocked && fresh && transmitting == nil && winners.isEmpty &&
            savedSubmissions.count >= ClaimSubmissionRetry.maximumRetainedWinners
        let visibleStatus = retainedCapacity ? "waiting" : status
        return ["enabled": enabled, "requested": enabled, "allowed": allowed,
            "running": enabled && allowed && !closed && !unknownBlocked, "status": visibleStatus,
            "currentDomain": active.values.first?.selection.row.domain ?? "",
            "eligible": eligible, "available": availableRows.count, "economicFiltered": availableRows.count - eligible,
            "waitingReason": retainedCapacity ? "retained-capacity" : status == "waiting" && !availableRows.isEmpty && eligible == 0 ? "economic-floor" : "",
            "retainedSubmissions": savedSubmissions.count,
            "discoveredBlocks": loaded.count, "totalBlocks": blocks.count, "discoveryComplete": cursor != nil && loaded.count == blocks.count,
            "attempts": attempts, "valid": valid, "invalid": invalid, "targetHits": hits, "submitted": submitted,
            "unknown": unknown, "cancelled": cancelled, "elapsedSeconds": elapsed + (activeSince.map { max(0, now() - $0) } ?? 0),
            "connectionsPerSecond": Double(recentStarts.count) / 10, "connectionsPerSecondLimit": rate,
            "concurrency": concurrency, "activeConnections": active.count, "lastTxid": lastTxid,
            "lastError": lastError, "lastRpcError": lastRpcError as Any? ?? NSNull(), "domains": domains,
            "policyStatus": policyStatus, "allowMobileData": allowMobile, "allowBackground": false,
            "backgroundService": false, "nativeBackgroundAvailable": false,
            "receiptTxid": lastTxid, "receiptStatus": receiptStatus]
    }
}
