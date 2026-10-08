import Foundation
import Network
import CConnectWallet

/// Foreground-only public-proof workload. It has no seed, signing key, or
/// automatic startup. The runtime supplies a natively derived reward address.
public actor MobileClaimsEngine {
    private static let maximum: Int64 = 9_007_199_254_740_991
    private static let genesis = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e"
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
    private var status = "stopped", lastError = "", lastTxid = "", receiptStatus = ""
    private var lastRpcError: JSONObject?
    private var rate = 100, concurrency = 100
    private var attempts: Int64 = 0, valid: Int64 = 0, invalid: Int64 = 0, hits: Int64 = 0
    private var submitted: Int64 = 0, unknown: Int64 = 0, cancelled: Int64 = 0
    private var elapsed = 0.0, activeSince: Double?
    private var nextDiscovery = 0.0, nextBlock = 0.0, retryAt = 0.0, nextPreparation = 0.0
    private var catalogAt = 0.0, nextSchedule = 0.0, nextAdmission = 0.0, nextAck = 0.0
    private var dirty = true, admissionIdle = true
    private var blocks: [String: Int64] = [:], blockOrder: [String] = [], loaded = Set<String>()
    private var catalog: [String: ClaimCandidate] = [:], progress: [String: ClaimProgress] = [:]
    private var stats: [String: ClaimEMA] = [:]
    private var scheduler = ClaimScheduler(), retired = Set<String>(), reservations = Set<String>()
    private var parentCache: [String: String] = [:], parentOrder: [String] = []
    private var parentBytes = 0
    private var recentStarts: [Double] = []
    private struct Capture {
        let id: UInt64, epoch: UInt64, run: UInt64, handle: Int64
        let selection: ClaimScheduler.Selection
        var started = false, cancelled = false
    }
    private var active: [UInt64: Capture] = [:]
    private struct Winner {
        let row: ClaimCandidate, prepared: JSONObject, proof: String, epoch: UInt64
        let permit: RpcBroadcastPermit
    }
    private var winners: [Winner] = [], transmitting: Winner?
    private var submissionTask: Task<Void, Never>?

    public init(rpc: MobileRpcClient, receiptURL: URL? = nil) {
        self.rpc = rpc
        self.receiptURL = receiptURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ConnectWallet", isDirectory: true).appendingPathComponent("claims-public-receipt-v1.json")
        var error = [CChar](repeating: 0, count: 32)
        limiter = cw_claim_limiter_create(100, &error)
        if limiter == 0 { status = "error"; lastError = String(cString: error) }
        do {
            if FileManager.default.fileExists(atPath: self.receiptURL.path) {
                let receipt = try JSON.decode(Data(contentsOf: self.receiptURL), maxBytes: 4096)
                lastTxid = try PJ.hash(receipt["txid"]); receiptStatus = try PJ.string(receipt["status"])
                try walletRequire(["pending", "submitted", "rejected", "not-sent", "unknown"].contains(receiptStatus), "CLAIMS_RECEIPT_UNAVAILABLE")
                if ["pending", "unknown"].contains(receiptStatus) { unknownBlocked = true; unknown = 1; status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME" }
            }
            let policyURL = self.receiptURL.deletingLastPathComponent().appendingPathComponent("claims-policy-v1.json")
            if FileManager.default.fileExists(atPath: policyURL.path) {
                let saved = try JSON.decode(Data(contentsOf: policyURL), maxBytes: 4096)
                allowMobile = try PJ.bool(saved["allowMobileData"])
                rate = Int(try PJ.integer(saved["connectionsPerSecondLimit"], 1, 100))
                concurrency = Int(try PJ.integer(saved["concurrency"], 1, 100))
                _ = cw_claim_limiter_set_rate(limiter, Int32(rate), &error)
            }
        } catch { status = "error"; lastError = "CLAIMS_RECEIPT_UNAVAILABLE" }
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
    private var fresh: Bool { healthy && now() - catalogAt < 60 }
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
            pauseClock(); epoch &+= 1; cancelCaptures(); resetAdmission(); invalidateQueued()
            maintenanceTask?.cancel(); maintenanceTask = nil
            status = unknownBlocked ? "unknown-outcome" : enabled ? "paused" : "stopped"
        } else if !unknownBlocked {
            activeSince = now(); nextDiscovery = 0; status = "synchronizing"; resetAdmission(); launchMaintenance()
        }
    }
    private func pauseClock() { if let activeSince { elapsed += max(0, now() - activeSince); self.activeSince = nil } }
    private func resetAdmission() {
        admissionIdle = true
        var error = [CChar](repeating: 0, count: 32)
        if limiter != 0 { _ = cw_claim_limiter_reset(limiter, &error) }
    }
    public func start(address: String) throws {
        _ = try WalletCrypto.decodeAddress(address)
        try walletRequire(!closed && limiter != 0, "CLAIMS_CLOSED")
        try walletRequire(lastError != "CLAIMS_RECEIPT_UNAVAILABLE", "CLAIMS_RECEIPT_UNAVAILABLE")
        try walletRequire(!unknownBlocked, "CLAIMS_UNKNOWN_OUTCOME")
        try walletRequire(foreground, "Open the app to start claims.")
        try walletRequire(!enabled && active.isEmpty && reservations.isEmpty() && transmitting == nil, "Stop the existing claims session and wait for it to finish.")
        if self.address != address { for item in progress.values { item.prepared = nil } }
        self.address = address; enabled = true; epoch &+= 1; run &+= 1
        attempts = 0; valid = 0; invalid = 0; hits = 0; submitted = 0; unknown = 0; cancelled = 0
        elapsed = 0; recentStarts.removeAll(); activeSince = nil
        blocks.removeAll(); blockOrder.removeAll(); loaded.removeAll(); catalog.removeAll(); scheduler.clear()
        cursor = nil; tip = nil; healthy = false; dirty = true; catalogAt = 0
        lastError = ""; lastRpcError = nil; nextDiscovery = 0; nextBlock = 0; nextPreparation = 0; retryAt = 0
        status = "paused"; refreshAllowed()
        if dispatchTask == nil {
            dispatchTask = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.dispatchTick()
                    try? await Task.sleep(nanoseconds: 2_000_000)
                }
            }
        }
    }
    public func stop() {
        enabled = false; allowed = false; pauseClock(); epoch &+= 1
        maintenanceTask?.cancel(); maintenanceTask = nil
        cancelCaptures(); invalidateQueued(); resetAdmission(); acknowledgeStarts()
        status = unknownBlocked ? "unknown-outcome" : "stopped"
    }
    public func close() {
        stop(); closed = true; dispatchTask?.cancel(); dispatchTask = nil; network.cancel()
        cw_claim_limiter_destroy(limiter); limiter = 0
    }
    public func canChangeEndpoint() -> Bool { !enabled && active.isEmpty && reservations.isEmpty() && transmitting == nil && winners.isEmpty }
    public func policy(_ options: JSONObject) throws -> JSONObject {
        try PJ.keys(options, ["allowMobileData", "allowBackground"])
        let mobile = try PJ.bool(options["allowMobileData"]), background = try PJ.bool(options["allowBackground"])
        try walletRequire(!background, "iOS claims can run only while the wallet is visible.")
        try savePolicy(mobile: mobile, rate: rate, concurrency: concurrency)
        allowMobile = mobile; refreshAllowed(); return state()
    }
    public func limits(_ options: JSONObject) throws -> JSONObject {
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
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bytes = try JSON.encode(data)
        try bytes.write(to: url, options: .atomic)
        try walletRequire(try Data(contentsOf: url) == bytes, "CLAIMS_RECEIPT_UNAVAILABLE")
    }
    private func record(_ txid: String, _ value: String) throws {
        do { try writePublic(["txid": txid, "status": value], receiptURL); lastTxid = txid; receiptStatus = value }
        catch { throw WalletError("CLAIMS_RECEIPT_UNAVAILABLE") }
    }
    public func checkSubmission() async throws -> JSONObject {
        try walletRequire(foreground && unknownBlocked && !lastTxid.isEmpty, "No indeterminate claim submission to resolve.")
        let expected = lastTxid
        let response = try await rpc.call("gettransaction", ["txid": expected])
        _ = try Self.validateTip(response["tip"])
        try walletRequire(["pending", "confirmed"].contains(try PJ.string(response["status"])), "The node has not confirmed receipt. Claims remain paused.")
        let raw = try PJ.string(PJ.object(response["transaction"])["hex"])
        try walletRequire(try NativeTransactions.txid(NativeTransactions.parse(raw)) == expected && lastTxid == expected, "RPC transaction identity mismatch.")
        try record(expected, "submitted"); unknownBlocked = false; lastError = ""; stop(); return state()
    }
    private static func validateTip(_ value: Any?) throws -> JSONObject {
        let value = try PJ.object(value)
        try walletRequire(value["chain"] as? String == "main" && value["genesis_hash"] as? String == genesis, "CLAIMS_WRONG_NETWORK")
        _ = try PJ.hash(value["hash"]); _ = try PJ.integer(value["height"], 0, maximum)
        _ = try PJ.integer(value["mediantime"], 1, 253_402_300_799)
        return value
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
    private func validCursor(_ value: Any?) throws -> String {
        let text = try PJ.string(value); try walletRequire(PJ.matches(text, "[A-Za-z0-9_.-]{1,1024}"), "CLAIMS_RPC_DATA"); return text
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
            if now() >= nextBlock, let missing = blockOrder.first(where: { !loaded.contains($0) }) { try await loadBlock(missing, token) }
            refreshSchedule()
            if fresh, let selection = scheduler.next(now: now(), prepared: false) { try await prepare(selection.row, token) }
            try check(token)
            status = !fresh ? "retrying" : scheduler.next(now: now(), prepared: true) != nil ? "claiming" : loaded.count < blocks.count ? "synchronizing" : "waiting"
        } catch is CancellationError { }
        catch { handleReadFailure(error, token) }
    }
    private func discover(_ token: UInt64) async throws {
        var start = cursor
        if start == nil {
            let watermark = try await request("getbountychanges", [:], token)
            _ = try Self.validateTip(watermark["tip"])
            try walletRequire(try PJ.array(watermark["changes"]).isEmpty && !PJ.bool(watermark["has_more"]), "CLAIMS_RPC_DATA")
            start = try validCursor(watermark["next_cursor"])
        }
        let response = try await request("getrecentblockhashes", [:], token)
        let snapshot = try Self.validateTip(response["tip"]), height = try PJ.integer(snapshot["height"])
        let list = try PJ.objects(response["blocks"])
        try walletRequire(try PJ.integer(response["window"]) == 600 && list.count == min(600, height + 1), "CLAIMS_RPC_DATA")
        var nextBlocks: [String: Int64] = [:], order: [String] = []
        for (index, row) in list.enumerated() {
            let hash = try PJ.hash(row["hash"])
            try walletRequire(try PJ.integer(row["height"]) == height - Int64(index) && nextBlocks[hash] == nil, "CLAIMS_RPC_DATA")
            if index == 0 { try walletRequire(hash == snapshot["hash"] as? String, "CLAIMS_RPC_DATA") }
            nextBlocks[hash] = height - Int64(index); order.append(hash)
        }
        try await replay(token, recent: nextBlocks, recentOrder: order, start: start)
        nextDiscovery = now() + 10
    }
    private func loadBlock(_ hash: String, _ token: UInt64) async throws {
        try check(token)
        let chunks = try await rpc.streamBounties(hash)
        try check(token)
        var staged: [String: ClaimCandidate] = [:]
        for chunk in chunks {
            _ = try Self.validateTip(chunk["tip"])
            guard chunk["type"] as? String == "bounties" else { continue }
            for item in try PJ.objects(chunk["items"]) {
                var candidate = try ClaimCandidate(item, block: hash, fee: NativeTransactions.claimFee(1500))
                try walletRequire(blocks[hash] == candidate.height && staged[candidate.key] == nil && staged.count < 10_000, "CLAIMS_CAPACITY")
                if let previous = progress[candidate.key] { candidate.progress = previous }
                staged[candidate.key] = candidate
            }
        }
        try await replay(token, newBlock: hash, staged: staged)
        nextBlock = now() + 1.5
    }
    private func replay(_ token: UInt64, newBlock: String? = nil, staged: [String: ClaimCandidate] = [:],
                        recent: [String: Int64]? = nil, recentOrder: [String]? = nil, start: String? = nil) async throws {
        try check(token)
        let began = now()
        var next = catalog.filter { recent == nil || recent![$0.value.block] != nil }
        for (key, source) in staged {
            var row = source
            if let previous = next[key] { row.progress = previous.progress }
            next[key] = row
        }
        try walletRequire(next.count <= 10_000, "CLAIMS_CAPACITY")
        var nextCursor = start ?? cursor, nextTip = tip, more = true, lastSequence: Int64 = -1
        for _ in 0..<20 {
            guard more, let current = nextCursor else { break }
            let response = try await request("getbountychanges", ["cursor": current], token)
            nextTip = try Self.validateTip(response["tip"])
            let events = try PJ.objects(response["changes"])
            more = try PJ.bool(response["has_more"])
            let following = try validCursor(response["next_cursor"])
            try walletRequire(events.count <= 500 && (!more || !events.isEmpty && following != current), "CLAIMS_RPC_DATA")
            for event in events {
                let sequence = try PJ.integer(event["sequence"], 0, Self.maximum)
                try walletRequire(sequence > lastSequence, "CLAIMS_RPC_DATA"); lastSequence = sequence
                let key = try PJ.outpoint(event), kind = try PJ.string(event["type"])
                switch kind {
                case "window_exit": next.removeValue(forKey: key)
                case "added": _ = try PJ.hash(event["block_hash"]); _ = try PJ.integer(event["block_height"], 0, Self.maximum)
                case "spent", "pending_spend": _ = try PJ.hash(event["spending_txid"]); next[key]?.state = kind
                case "available_again", "matured":
                    if var row = next[key], row.state != "spent", kind == "available_again" || row.state == "immature" {
                        row.state = try row.coinbase && PJ.integer(nextTip!["height"]) - row.height + 1 < 100 ? "immature" : "available"
                        next[key] = row
                    }
                default: throw WalletError("CLAIMS_RPC_DATA")
                }
            }
            nextCursor = following
        }
        try walletRequire(!more, "CLAIMS_SYNC_BUSY"); try check(token)
        if let newBlock { try walletRequire(blocks[newBlock] != nil, "CLAIMS_SYNC_BUSY") }
        let nextBlocks = recent ?? blocks
        var nextLoaded = loaded.intersection(Set(nextBlocks.keys)); if let newBlock { nextLoaded.insert(newBlock) }
        var nextProgress = progress
        for row in next.values { nextProgress[row.key] = row.progress }
        let protected = reservations.union(Set(active.values.map { $0.selection.row.key }))
        nextProgress = nextProgress.filter { key, item in protected.contains(key) || nextBlocks[item.block] != nil && (!nextLoaded.contains(item.block) || next[key] != nil) }
        try walletRequire(nextProgress.count <= 10_100, "CLAIMS_CAPACITY")
        blocks = nextBlocks; if let recentOrder { blockOrder = recentOrder }
        loaded = nextLoaded; catalog = next; progress = nextProgress
        let policies = Set(nextProgress.values.map(\.policy)); stats = stats.filter { policies.contains($0.key) }
        retired = retired.intersection(Set(progress.keys).union(reservations))
        cursor = nextCursor; tip = nextTip; healthy = true; catalogAt = began; dirty = true
        lastRpcError = nil; lastError = ""; invalidateQueued()
    }
    private func prepare(_ row: ClaimCandidate, _ token: UInt64) async throws {
        try check(token)
        guard available(row.key), row.progress.prepared == nil else { return }
        let txid = try PJ.hash(row.bounty["txid"])
        var parent = parentCache[txid]
        if parent == nil {
            guard now() >= nextPreparation else { return }
            nextPreparation = now() + 1.5
            let response = try await request("gettransaction", ["txid": txid], token)
            _ = try Self.validateTip(response["tip"])
            parent = try PJ.string(PJ.object(response["transaction"])["hex"])
        }
        let prepared = try NativeTransactions.prepareClaim(row.bounty, parent!, address, 1500)
        try check(token)
        guard available(row.key), let current = catalog[row.key] else { return }
        if parentCache[txid] == nil, parent!.utf8.count <= 8 * 1024 * 1024 {
            while !parentOrder.isEmpty && (parentOrder.count >= 128 || parentBytes + parent!.utf8.count > 8 * 1024 * 1024) {
                let oldest = parentOrder.removeFirst(); parentBytes -= parentCache.removeValue(forKey: oldest)?.utf8.count ?? 0
            }
            parentCache[txid] = parent!; parentOrder.append(txid); parentBytes += parent!.utf8.count
        }
        current.progress.prepared = prepared
    }
    private func handleReadFailure(_ error: Error, _ token: UInt64) {
        guard token == epoch && enabled else { return }
        let code = (error as? RpcFailure)?.code ?? (error as? WalletError)?.message ?? "CLAIMS_FAILED"
        if code == "CLAIMS_STOPPED" { return }
        lastError = code.hasPrefix("CLAIM") || code.hasPrefix("RPC_") || code.hasPrefix("-32") ? code : "CLAIMS_RPC_DATA"
        if ["CLAIMS_WRONG_NETWORK", "CLAIMS_CAPACITY", "CLAIMS_RPC_DATA", "CLAIMS_NATIVE_DATA", "CLAIMS_RECEIPT_UNAVAILABLE"].contains(lastError) {
            stop(); status = "error"; healthy = false
        } else {
            retryAt = now() + max(code == "-32029" ? 60 : 5, Double((error as? RpcFailure)?.retryAfterMs ?? 0) / 1000)
            nextDiscovery = 0; status = "retrying"
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
        for winner in winners + (transmitting.map { [$0] } ?? []) {
            if !enabled || !allowed || !fresh || winner.epoch != epoch || catalog[winner.row.key]?.state != "available" { winner.permit.cancel() }
        }
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
    private func dispatchTick() {
        if now() >= nextAck { acknowledgeStarts() }
        if !fresh { cancelCaptures(); invalidateQueued(); admissionIdle = true }
        guard !closed && enabled && allowed && !unknownBlocked && fresh && reservations.count < 100 else { admissionIdle = true; return }
        guard active.count < concurrency && now() >= nextAdmission else { return }
        refreshSchedule()
        guard let selected = scheduler.next(now: now(), prepared: true) else { admissionIdle = true; return }
        let row = selected.row
        guard available(row.key) && row.budget else { scheduler.remove(row.key); return }
        if !selected.recovering && !ClaimScheduler.worth(row, rate: stats[row.policy]?.rate ?? 5) { dirty = true; return }
        if stats[row.policy] == nil { guard stats.count < 3584 else { handleReadFailure(WalletError("CLAIMS_CAPACITY"), epoch); return }; stats[row.policy] = ClaimEMA() }
        var error = [CChar](repeating: 0, count: 32)
        let handle = cw_claim_cancellation_create(limiter, &error)
        guard handle != 0 else { lastError = String(cString: error); return }
        nextCapture &+= 1
        let capture = Capture(id: nextCapture, epoch: epoch, run: run, handle: handle, selection: selected)
        active[capture.id] = capture; scheduler.reserve(selected)
        let pacedAt = now(); if admissionIdle { nextAdmission = max(nextAdmission, pacedAt) }
        nextAdmission = max(nextAdmission + 1 / Double(rate), pacedAt - 1); admissionIdle = false
        guard let prepared = row.progress.prepared, let challenge = prepared["challenge"] as? String,
              let time = try? PJ.integer(tip?["mediantime"], 1) else { release(capture.id); return }
        capturesQueue.async { [weak self] in
            var result = cw_claim_result()
            let completed = row.domain.withCString { domain in challenge.withCString { challenge in row.target.withCString { target in
                var context = cw_claim_context(domain: domain, challenge_hex: challenge, target_hex: target,
                    roots_version: 1, signature_mask: row.mask, validation_time: time)
                return cw_claim_capture(&context, 10_000, handle, &result)
            } } }
            let code = withUnsafeBytes(of: result.error_code) { bytes in String(cString: bytes.bindMemory(to: CChar.self).baseAddress!) }
            let value = NativeProofResult(completed: completed == 1, proof: result.proof_hex.map { String(cString: $0) } ?? "",
                captured: result.captured != 0, validationPassed: result.validation_passed != 0,
                valid: result.valid_proof != 0, hit: result.meets_target != 0, duration: result.duration_ms, error: code)
            cw_claim_result_free(&result)
            Task {
                if let self { await self.complete(capture.id, value) }
                else { cw_claim_cancellation_destroy(handle) }
            }
        }
    }
    private struct NativeProofResult {
        let completed: Bool, proof: String, captured: Bool, validationPassed: Bool, valid: Bool, hit: Bool, duration: Int64, error: String
    }
    private func release(_ id: UInt64) {
        acknowledge(id)
        guard let capture = active.removeValue(forKey: id) else { return }
        scheduler.release(capture.selection); cw_claim_cancellation_destroy(capture.handle)
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
            if result.error == "CLAIM_DNS" { stats[row.policy]?.retryAfter = now() + 2; dirty = true }
            if ["CLAIM_DNS", "CLAIM_CONTEXT", "CLAIM_TIMEOUT", "CLAIM_BUSY"].contains(result.error) { lastError = result.error; return }
            handleReadFailure(WalletError(result.error), capture.epoch); return
        }
        guard capture.started, (0...60_000).contains(result.duration), !result.valid || result.validationPassed,
              !result.validationPassed || result.captured, !result.hit || result.valid,
              result.valid || result.proof.isEmpty else { handleReadFailure(WalletError("CLAIMS_NATIVE_DATA"), capture.epoch); return }
        stats[row.policy]?.record(result.validationPassed, Double(result.duration) / 1000)
        if result.captured {
            if row.progress.captures != UInt64.max { row.progress.captures += 1 }
            if !row.budget { scheduler.remove(row.key) }
        }
        if result.validationPassed { valid = increment(valid) } else { invalid = increment(invalid) }
        if result.hit { hits = increment(hits) }
        if lastRpcError == nil { lastError = result.valid ? "" : result.error.isEmpty ? "CLAIM_INVALID_PROOF" : result.error }
        guard result.hit && fresh && available(row.key), let prepared = row.progress.prepared else { return }
        retired.insert(row.key); reservations.insert(row.key); scheduler.remove(row.key); cancelCaptures(row.key, except: id)
        winners.append(Winner(row: row, prepared: prepared, proof: result.proof, epoch: capture.epoch, permit: RpcBroadcastPermit()))
        launchSubmission()
    }
    private func launchSubmission() {
        guard submissionTask == nil, !winners.isEmpty else { return }
        let winner = winners.removeFirst(); transmitting = winner
        submissionTask = Task { [weak self] in await self?.submit(winner) }
    }
    private func submit(_ winner: Winner) async {
        var attempted = false
        defer {
            reservations.remove(winner.row.key)
            if !attempted { retired.remove(winner.row.key); dirty = true }
            transmitting = nil; submissionTask = nil; launchSubmission()
        }
        do {
            try check(winner.epoch)
            guard fresh && catalog[winner.row.key]?.state == "available" else { return }
            let completed = try NativeTransactions.attachClaim(winner.prepared, winner.proof)
            let txid = try PJ.hash(completed["txid"])
            try record(txid, "pending"); attempted = true
            do {
                let response = try await rpc.broadcast(PJ.string(completed["hex"]), permit: winner.permit)
                guard response["txid"] as? String == txid else { uncertain(txid); return }
                try record(txid, "submitted"); submitted = increment(submitted)
                if winner.epoch == epoch && enabled { status = "submitted" }
            } catch let error as RpcFailure {
                if !error.unknownOutcome && error.code == "RPC_CANCELLED" {
                    do { try record(txid, "not-sent"); attempted = false } catch { uncertain(txid) }; return
                }
                if error.unknownOutcome || error.nodeCode == -27 { uncertain(txid); return }
                do { try record(txid, "rejected") } catch { uncertain(txid); return }
                lastError = "CLAIMS_REJECTED"; nextDiscovery = 0
                lastRpcError = ["code": error.code, "method": "sendrawtransaction", "phase": "response", "stage": "submission", "elapsedMs": 0, "queuedMs": 0, "bytesReceived": 0]
            } catch { uncertain(txid) }
        } catch { handleReadFailure(error, winner.epoch) }
    }
    private func uncertain(_ txid: String) {
        unknown = increment(unknown); unknownBlocked = true; lastTxid = txid
        try? record(txid, "unknown")
        stop(); status = "unknown-outcome"; lastError = "CLAIMS_UNKNOWN_OUTCOME"
    }
    public func state() -> JSONObject {
        acknowledgeStarts()
        let domains: [JSONObject] = stats.keys.sorted().map { key in
            let value = stats[key]!, parts = key.split(separator: ":")
            return ["domain": parts.dropLast().joined(separator: ":"), "signatureAlgorithmsMask": Int(parts.last ?? "0") ?? 0,
                "connections": value.connections, "totalTime": value.totalTime, "rate": value.rate, "completed": value.completed]
        }
        return ["enabled": enabled, "requested": enabled, "allowed": allowed,
            "running": enabled && allowed && !closed && !unknownBlocked, "status": status,
            "currentDomain": active.values.first?.selection.row.domain ?? "",
            "eligible": catalog.values.filter { available($0.key) && $0.budget }.count,
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
