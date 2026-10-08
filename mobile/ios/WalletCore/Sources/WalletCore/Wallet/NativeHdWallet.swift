import Foundation

/// Native-owned derivation paths. Renderer hints never choose a signing key.
public actor NativeHdWallet {
    public static let gap = 20, maxAccounts = 10_000
    private let session: VaultSession
    private let vault: NativeVaultUpdateSession
    private let persist: (JSONObject) throws -> Void
    private var paths: [String: JSONObject] = [:]
    private var orderedAccounts: [JSONObject]?
    private var receiveIndex: Int, changeIndex: Int, lastReceive: Int, lastChange: Int
    private var complete: Bool, recovering = false, closed = false, scanned = 0
    private var error = "", groups: [JSONObject] = []
    private var recoveryState = "paused", errorCode = "", retryAfterMs = 0, retryAttempt = 0
    private var retryRevision: UInt64 = 0
    private var recoveryLease: HdRecoveryLease?
    private let walletID: String

    public init(session: VaultSession, vault: NativeVaultUpdateSession, persist: @escaping (JSONObject) throws -> Void) throws {
        self.session = session; self.vault = vault; self.persist = persist
        let payload = try vault.payload()
        receiveIndex = Int(try JSON.integer(payload["receiveIndex"] ?? 0, min: 0, max: Int64(Int32.max)))
        changeIndex = Int(try JSON.integer(payload["changeIndex"] ?? 0, min: 0, max: Int64(Int32.max)))
        lastReceive = Int(try JSON.integer(payload["lastUsedReceive"] ?? -1, min: -1, max: Int64(Int32.max)))
        lastChange = Int(try JSON.integer(payload["lastUsedChange"] ?? -1, min: -1, max: Int64(Int32.max)))
        complete = payload["mobileHdRecovered"] as? Bool == true && payload["needsRecovery"] as? Bool == false && payload["scanLookahead"] as? Bool == true
        walletID = try session.publicAccount(index: 0, change: 0).string("address")
        let maxima = [max(receiveIndex, payload["scanLookahead"] as? Bool == true ? lastReceive + Self.gap : 0),
                      max(changeIndex, payload["scanLookahead"] as? Bool == true ? lastChange + Self.gap : 0)]
        try walletRequire(maxima[0] + maxima[1] + 2 <= Self.maxAccounts, "HD address limit reached; use ConnectWallet desktop")
        for branch in 0...1 { for index in 0...maxima[branch] { paths["\(branch):\(index)"] = try session.publicAccount(index: index, change: branch) } }
    }
    private func check() throws { try Task.checkCancellation(); try walletRequire(!closed && !session.isLocked, "Wallet is locked") }
    private func derive(_ index: Int, _ branch: Int) throws -> JSONObject {
        try check(); let key = "\(branch):\(index)"
        if let value = paths[key] { return value }
        try walletRequire(paths.count < Self.maxAccounts && index <= Int(Int32.max), "HD recovery exceeds this device's address limit; use ConnectWallet desktop")
        let value = try session.publicAccount(index: index, change: branch)
        paths[key] = value; orderedAccounts = nil; return value
    }
    public func snapshot() -> JSONObject {
        // Native path records are immutable after derivation. Swift arrays and
        // dictionaries preserve value semantics across public snapshot copies.
        if orderedAccounts == nil {
            orderedAccounts = paths.values.sorted {
                let a = $0["change"] as? Int ?? 0, b = $1["change"] as? Int ?? 0
                return a == b ? ($0["index"] as? Int ?? 0) < ($1["index"] as? Int ?? 0) : a < b
            }
        }
        return ["walletId": walletID, "account": paths["0:\(receiveIndex)"] ?? [:], "accounts": orderedAccounts!,
                "hd": ["complete": complete, "recovering": recovering, "scanned": scanned,
                       "receiveIndex": receiveIndex, "changeIndex": changeIndex, "lastUsedReceive": lastReceive,
                       "lastUsedChange": lastChange, "error": error, "errorCode": errorCode,
                       "recoveryState": complete ? "complete" : recoveryState,
                       "retryAfterMs": retryAfterMs, "retryAttempt": retryAttempt] as JSONObject]
    }
    public func accounts() -> [JSONObject] { snapshot()["accounts"] as? [JSONObject] ?? [] }
    public func account() throws -> JSONObject { try derive(receiveIndex, 0) }
    public func changeAccount() throws -> JSONObject { try derive(changeIndex, 1) }
    public func owned(_ address: String) -> JSONObject? { paths.values.first { $0["address"] as? String == address } }
    public func recoverySnapshots() -> JSONObject { ["walletId": walletID, "groups": complete && !closed && !recovering ? groups : []] }
    public func requireReady() throws { try check(); try walletRequire(complete && !recovering, "Wait for HD recovery to finish before sending") }
    private func save(_ payload: JSONObject) throws { try check(); try vault.save(payload, writer: { try self.persist($0) }); try check() }
    public func requestRecovery() throws {
        try check(); try walletRequire(!recovering, "HD recovery is already running")
        complete = false; groups = []; error = ""; errorCode = ""; recoveryState = "paused"
        retryAfterMs = 0; retryAttempt = 0
        var payload = try vault.payload(); payload["needsRecovery"] = true; payload["mobileHdRecovered"] = false; try save(payload)
    }
    public func newAddress() throws -> JSONObject {
        try requireReady(); try walletRequire(receiveIndex < lastReceive + Self.gap, "Use an existing receiving address first; recovery keeps a 20-address gap")
        let next = receiveIndex + 1, account = try derive(receiveIndex + 1, 0)
        var payload = try vault.payload(); payload["receiveIndex"] = next; try save(payload); receiveIndex = next; return account
    }
    public func allocateChange(_ expected: Int) throws {
        try requireReady(); try walletRequire(changeIndex == expected && changeIndex < lastChange + Self.gap, "Change address changed or unused-address gap reached; review again")
        _ = try derive(expected + 1, 1)
        var payload = try vault.payload(); payload["changeIndex"] = expected + 1; try save(payload); changeIndex = expected + 1
    }
    public func observeUsed(_ address: String) throws -> Bool {
        try check(); guard complete && !recovering, let own = owned(address) else { return false }
        let branch = Int(try own.integer("change")), index = Int(try own.integer("index"))
        guard index > (branch == 0 ? lastReceive : lastChange) else { return false }
        do {
            for next in 0...max(branch == 0 ? receiveIndex : changeIndex, index + Self.gap) { _ = try derive(next, branch) }
            var payload = try vault.payload(); payload[branch == 0 ? "lastUsedReceive" : "lastUsedChange"] = index
            payload["scanLookahead"] = true; try save(payload)
            if branch == 0 { lastReceive = index } else { lastChange = index }; return true
        } catch {
            complete = false; groups = []; self.error = "HD range extension is incomplete. Rescan addresses."
            recoveryState = "failed"; errorCode = "HD_RANGE_EXTENSION"; retryAfterMs = 0
            // Do not let the next unlock treat the old range as complete after
            // failing to retain newly observed activity. Keep the original
            // failure if storage or the lifecycle fence also rejects this mark.
            if !closed && !session.isLocked {
                do {
                    var payload = try vault.payload()
                    payload["needsRecovery"] = true; payload["mobileHdRecovered"] = false
                    try save(payload)
                } catch { }
            }
            throw error
        }
    }
    public func close() {
        recoveryLease?.cancel(); closed = true; groups = []; recovering = false
        recoveryState = "paused"; retryAfterMs = 0; vault.close()
    }

    private func retryProgress(_ status: HdRetryStatus, _ progress: (JSONObject) async -> Void) async {
        guard !closed && !session.isLocked && status.revision > retryRevision else { return }
        retryRevision = status.revision; recoveryState = status.state
        retryAfterMs = status.retryAfterMs; retryAttempt = status.retryAttempt; errorCode = status.errorCode
        await progress(snapshot())
    }

    /// Capture a journal watermark before history reads and reuse those first pages
    /// for initial balances. Sixteen requests share one socket and its method quota.
    public func recover(rpc: MobileRpcClient, progress: @escaping (JSONObject) async -> Void) async throws {
        try await recover(reader: { try await rpc.call($0, $1) }, progress: progress)
    }

    /// Injectable public-read seam: tests never need a node, keys on the wire,
    /// wall-clock backoff, or an alternative production endpoint.
    func recover(reader: @escaping HdRetryCoordinator.Reader, environment: HdRetryEnvironment = .live,
                 ownership: @escaping () throws -> Void = {},
                 progress: @escaping (JSONObject) async -> Void) async throws {
        try check(); guard !complete else { return }; try walletRequire(!recovering, "HD recovery is already running")
        recovering = true; scanned = 0; error = ""; errorCode = ""; groups = []
        recoveryState = "scanning"; retryAfterMs = 0; retryAttempt = 0; retryRevision = 0
        let lease = HdRecoveryLease(), session = self.session
        recoveryLease = lease
        let retries = HdRetryCoordinator(environment: environment, check: {
            try lease.check()
            do { try ownership() } catch { throw CancellationError() }
            if session.isLocked { throw CancellationError() }
        }, progress: { status in await self.retryProgress(status, progress) })
        defer {
            lease.cancel()
            if recoveryLease === lease { recoveryLease = nil; recovering = false }
        }
        var next = [0, 0], gaps = [0, 0], used = [lastReceive, lastChange], done = [false, false]
        let minimum = [max(receiveIndex, lastReceive + Self.gap), max(changeIndex, lastChange + Self.gap)]
        var retainedBytes = 0, legacy = false
        var journalEpoch: Int64?
        var nextResultProgress = environment.now()
        do {
            var payload: JSONObject
            do { payload = try vault.payload(); payload["needsRecovery"] = true; try save(payload) }
            catch { try check(); throw HdRecoveryFailure.storage }
            while !done.allSatisfy({ $0 }) {
                try check()
                var members: [(Int, Int, JSONObject)] = []
                // Never derive beyond the gap justified by the contiguous prefix.
                for branch in 0...1 where !done[branch] {
                    let boundary = max(minimum[branch], next[branch] + Self.gap - gaps[branch] - 1)
                    for index in next[branch]...min(boundary, next[branch] + 49) {
                        do { members.append((branch, index, try derive(index, branch))) }
                        catch {
                            try check()
                            if paths.count >= Self.maxAccounts || index > Int(Int32.max) { throw HdRecoveryFailure.resource }
                            throw HdRecoveryFailure.derivation
                        }
                    }
                }
                let byBranch = [members.filter { $0.0 == 0 }, members.filter { $0.0 == 1 }]
                members = []
                for offset in 0..<max(byBranch[0].count, byBranch[1].count) {
                    for branch in 0...1 where offset < byBranch[branch].count { members.append(byBranch[branch][offset]) }
                }
                await progress(snapshot()); try check()
                let addresses = try members.map { try $0.2.string("address") }
                var checkpoint: JSONObject?
                if !legacy {
                    do {
                        let expectedEpoch = journalEpoch
                        checkpoint = try await retries.call("getaddresschanges", ["addresses": addresses], reader: { method, params in
                            let value = try await reader(method, params)
                            try Self.validateWatermark(value)
                            if let expectedEpoch, try value.integer("journal_epoch") != expectedEpoch { throw HdRecoveryFailure.rescan }
                            return value
                        })
                        journalEpoch = try checkpoint!.integer("journal_epoch")
                    }
                    catch let failure as RpcFailure where failure.code == "-32601" { legacy = true; groups = []; retainedBytes = 0 }
                }
                try check()
                var results: [Int: (Bool, JSONObject?)] = [:]
                var groupBytes = 0, retainGroup = !legacy
                try await withThrowingTaskGroup(of: (Int, Bool, JSONObject).self) { tasks in
                    var submitted = 0
                    func enqueue(_ offset: Int) {
                        let address = addresses[offset]
                        tasks.addTask {
                            var cursor: String?, cursors = Set<String>(), first: JSONObject?
                            for _ in 0..<1000 {
                                try Task.checkCancellation()
                                var params: JSONObject = ["address": address]; if let cursor { params["cursor"] = cursor }
                                let page = try await retries.call("getaddresshistory", params, reader: { method, params in
                                    let value = try await reader(method, params)
                                    _ = try Self.historyUsed(value, address); return value
                                })
                                let positive = try !page.array("items").isEmpty
                                if first == nil { first = page }
                                if positive || page.isNull("next_cursor") { return (offset, positive, first!) }
                                let next = try page.string("next_cursor")
                                try walletRequire(cursors.insert(next).inserted, "Repeated HD history cursor")
                                cursor = next
                            }
                            throw HdRecoveryFailure.resource
                        }
                    }
                    while submitted < min(16, members.count) { enqueue(submitted); submitted += 1 }
                    while let result = try await tasks.next() {
                        try check()
                        if retainGroup {
                            groupBytes += try JSON.encode(result.2).count
                            if retainedBytes + groupBytes > 8 * 1024 * 1024 {
                                retainGroup = false
                                for key in Array(results.keys) { results[key] = (results[key]!.0, nil) }
                            }
                        }
                        results[result.0] = (result.1, retainGroup ? result.2 : nil)
                        let previousScanned = scanned
                        // Publish only each branch's validated contiguous prefix.
                        // Out-of-order replies remain buffered until their gap is
                        // justified; retries never reset pages or gap counters.
                        for branch in 0...1 {
                            while let offset = members.firstIndex(where: { $0.0 == branch && $0.1 == next[branch] }),
                                  let ready = results[offset] {
                                let index = members[offset].1
                                try walletRequire(!done[branch], "Invalid HD scan ordering")
                                if ready.0 { used[branch] = max(used[branch], index); gaps[branch] = 0 } else { gaps[branch] += 1 }
                                scanned += 1; next[branch] += 1
                                if index >= minimum[branch] && gaps[branch] >= Self.gap { done[branch] = true }
                            }
                        }
                        // Coalesce fast replies before copying the full public
                        // account list across the bridge. Group boundaries and
                        // retry/error/completion transitions remain immediate.
                        let now = environment.now()
                        if scanned > previousScanned && now >= nextResultProgress {
                            nextResultProgress = now + 0.25
                            await progress(snapshot()); try check()
                        }
                        if submitted < members.count { enqueue(submitted); submitted += 1 }
                    }
                }
                try check()
                try walletRequire(results.count == members.count, "Incomplete HD discovery")
                if retainGroup, let checkpoint {
                    let histories: [JSONObject] = try members.indices.map {
                        guard let result = results[$0], let page = result.1 else { throw WalletError("Incomplete HD cache group") }; return page
                    }
                    let group: JSONObject = ["addresses": addresses, "sync": checkpoint, "histories": histories]
                    let size = try JSON.encode(group).count
                    if retainedBytes + size <= 8 * 1024 * 1024 { groups.append(group); retainedBytes += size }
                }
                await progress(snapshot()); try check()
            }
            lastReceive = used[0]; lastChange = used[1]
            receiveIndex = max(receiveIndex, lastReceive + 1); changeIndex = max(changeIndex, lastChange + 1)
            do { _ = try derive(receiveIndex, 0); _ = try derive(changeIndex, 1) }
            catch { try check(); throw paths.count >= Self.maxAccounts ? HdRecoveryFailure.resource : HdRecoveryFailure.derivation }
            do { payload = try vault.payload() }
            catch { try check(); throw HdRecoveryFailure.storage }
            payload["receiveIndex"] = receiveIndex; payload["changeIndex"] = changeIndex
            payload["lastUsedReceive"] = lastReceive; payload["lastUsedChange"] = lastChange
            payload["needsRecovery"] = false; payload["scanLookahead"] = true; payload["mobileHdRecovered"] = true
            do { try save(payload) }
            catch { try check(); throw HdRecoveryFailure.storage }
            complete = true; recovering = false; recoveryState = "complete"; retryAfterMs = 0; retryAttempt = 0; errorCode = ""
            await progress(snapshot())
        } catch {
            recovering = false; retryAfterMs = 0
            if closed || session.isLocked || Task.isCancelled || error is CancellationError {
                recoveryState = "paused"; self.error = ""; errorCode = ""
            } else {
                let failure = (error as? HdRecoveryFailure) ?? .invalid
                recoveryState = "failed"; self.error = failure.message; errorCode = failure.code
                // A journal reset invalidates every watermark held by this run.
                if failure.code == HdRecoveryFailure.rescan.code { groups = [] }
            }
            await progress(snapshot()); throw error
        }
    }
    private static func validateWatermark(_ value: JSONObject) throws {
        try walletRequire(Set(value.keys) == Set(["tip", "unit", "changes", "next_cursor", "has_more", "through_sequence", "journal_epoch"]) && value["unit"] as? String == "connects", "Invalid HD checkpoint")
        _ = try NativePaymentChecks.tip(value.object("tip"))
        _ = try value.integer("through_sequence", min: 0, max: 9_007_199_254_740_991)
        _ = try value.integer("journal_epoch", min: 0, max: 9_007_199_254_740_991)
        try walletRequire(try value.array("changes").isEmpty && !value.boolean("has_more"), "Invalid HD watermark")
        try walletRequire(try NativePaymentChecks.cursor(value) != nil, "Missing HD watermark cursor")
    }
    public static func historyUsed(_ page: JSONObject, _ address: String) throws -> Bool {
        try walletRequire(page.count == 6 && page["address"] as? String == address && page["unit"] as? String == "connects" && (try page.boolean("live")), "Invalid HD history")
        let tip = try NativePaymentChecks.tip(page.object("tip")), height = try tip.integer("height")
        let rows = try page.array("items"); try walletRequire(rows.count <= 500 && page.has("next_cursor"), "Invalid HD history")
        _ = try NativePaymentChecks.cursor(page); var seen = Set<String>()
        for value in rows {
            let row = try JSON.object(value), id = try row.string("txid")
            try walletRequire(row.count == 8 && MobileRpcClient.hash(id) && seen.insert(id).inserted, "Invalid HD history row")
            let received = try NativeTransactions.amount(row.string("received")), spent = try NativeTransactions.amount(row.string("spent"))
            try walletRequire(try row.string("balance_delta") == String(received - spent), "Invalid HD history delta")
            let confirmations = try row.integer("confirmations", min: 0)
            if row["status"] as? String == "pending" {
                try walletRequire(row.has("block_height") && row.has("block_hash") && row.isNull("block_height") && row.isNull("block_hash") && confirmations == 0, "Invalid pending history")
            } else {
                let blockHeight = try row.integer("block_height", min: 0, max: height)
                try walletRequire(row["status"] as? String == "confirmed" && MobileRpcClient.hash(try row.string("block_hash")) && confirmations == height - blockHeight + 1, "Invalid confirmed history")
            }
        }
        return !rows.isEmpty
    }
    public static func usedAddresses(_ method: String, _ params: JSONObject, _ response: JSONObject) throws -> [String] {
        if method == "getaddresshistory" {
            let address = try params.string("address"); return try historyUsed(response, address) ? [address] : []
        }
        if method == "getaddressutxos" {
            let address = try params.string("address")
            return try NativePaymentChecks.utxos(response, address, response.object("tip")).isEmpty ? [] : [address]
        }
        guard method == "getaddresschanges" else { return [] }
        try walletRequire(Set(response.keys) == Set(["tip", "unit", "changes", "next_cursor", "has_more", "through_sequence", "journal_epoch"]) && response["unit"] as? String == "connects", "Invalid address journal")
        let tip = try NativePaymentChecks.tip(response.object("tip")), more = try response.boolean("has_more")
        let through = try response.integer("through_sequence", min: 0, max: 9_007_199_254_740_991)
        _ = try response.integer("journal_epoch", min: 0, max: 9_007_199_254_740_991)
        try walletRequire(try NativePaymentChecks.cursor(response) != nil, "Missing journal cursor")
        let requested = try params.array("addresses").map { try JSON.string($0) }
        try walletRequire(!requested.isEmpty && requested.count <= 100 && Set(requested).count == requested.count, "Invalid journal scope")
        let changes = try response.array("changes"); try walletRequire(changes.count <= 500 && (!more || !changes.isEmpty), "Invalid journal page")
        var used = Set<String>(), previous: Int64 = -1
        for value in changes {
            let event = try JSON.object(value), sequence = try event.integer("sequence", min: 0, max: through)
            try walletRequire(sequence > previous, "Unordered journal"); previous = sequence
            let address = try event.string("address"), txid = try event.string("txid"), kind = try event.string("kind"), action = try event.string("action")
            try walletRequire(requested.contains(address) && MobileRpcClient.hash(txid) && ["history", "utxo"].contains(kind) && ["upsert", "remove"].contains(action), "Invalid journal event")
            let utxo = kind == "utxo", upsert = action == "upsert"
            try walletRequire(event.count == 5 + (utxo ? 1 : 0) + (upsert ? 1 : 0), "Invalid journal event schema")
            let vout = utxo ? try event.integer("vout", min: 0, max: 0xffffffff) : -1
            if !upsert { continue }
            let item = try event.object("item"); try walletRequire(item["txid"] as? String == txid, "Journal identity mismatch")
            let page: JSONObject = ["address": address, "tip": tip, "unit": "connects", "live": true, "items": [item], "next_cursor": NSNull()]
            if utxo { try walletRequire(try item.integer("vout") == vout, "Journal output mismatch"); _ = try NativePaymentChecks.utxos(page, address, tip) }
            else { _ = try historyUsed(page, address) }
            used.insert(address)
        }
        try walletRequire(!more || previous < through, "Invalid journal continuation")
        return used.sorted()
    }
}
