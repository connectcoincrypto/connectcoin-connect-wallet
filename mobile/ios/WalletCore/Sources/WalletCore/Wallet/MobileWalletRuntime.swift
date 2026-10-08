import Foundation
import CConnectWallet

/// Sole owner of wallet identity and payment approval. The plugin exposes only
/// named intents; passwords, native confirmation and signing never enter JS.
public actor MobileWalletRuntime {
    public static let shared = MobileWalletRuntime()
    private let fence = WalletLifecycleFence()
    private let storeResult: Result<DurableWalletStore, Error>
    private var settings: JSONObject = ["theme": "dark", "autoLockMinutes": 0, "rpcHost": "connectcoin4.com", "rpcPort": 48190]
    private var rpc: MobileRpcClient
    private var claims: MobileClaimsEngine
    private var subscriptions: MobileWalletSubscriptions?
    private var signing: VaultSession?, update: NativeVaultUpdateSession?, hd: NativeHdWallet?
    private var publicHd: JSONObject = [:], lastPayment: JSONObject?
    private var active = false, paymentBusy = false
    private var paymentPermit: RpcBroadcastPermit?
    private var endpointChanging = false
    private var rpcGeneration: UInt64 = 0
    private var eventHandler: ((String, JSONObject) -> Void)?
    private var recovery: Task<Void, Never>?, inactivity: Task<Void, Never>?
    private var lastInteraction = ProcessInfo.processInfo.systemUptime
    private let funding = try! MobilePaymentFunding()
    private struct Approval {
        let token: UInt64
        let send: NativeSendPolicy.Request?, bounty: NativeP2CPolicy.Request?
        let inventory: MobilePaymentPreparation.HdInventory
        let fundingSession: MobilePaymentFunding.Session
        let plans: [JSONObject]
        let batch: JSONObject?
        let change: JSONObject, accounts: [JSONObject]
        let expires: TimeInterval, replacesPending: Bool
    }
    private var approval: Approval?

    public init(directory: URL? = nil) {
        storeResult = Result { try DurableWalletStore(directory: directory) }
        if let store = try? storeResult.get(), let bytes = try? store.read(.settings, maxBytes: 4096), let value = try? JSON.decode(bytes, maxBytes: 4096),
           let checked = try? Self.validateSettings(value) { settings = checked }
        let endpoint = (try? TcpEndpoint(settings["rpcHost"] as? String ?? "connectcoin4.com", settings["rpcPort"] as? Int ?? 48190)) ?? (try! TcpEndpoint())
        let client = MobileRpcClient(endpoint: endpoint); rpc = client; claims = MobileClaimsEngine(rpc: client)
    }
    private func store() throws -> DurableWalletStore { try storeResult.get() }
    public func setEventHandler(_ handler: @escaping (String, JSONObject) -> Void) { eventHandler = handler }
    private func emit(_ name: String, _ data: JSONObject) { eventHandler?(name, data) }
    public func noteUserInteraction() { lastInteraction = ProcessInfo.processInfo.systemUptime }
    public func setActive(_ value: Bool) async {
        active = value; rpc.setActive(value)
        if !value { _ = await lock(); await claims.setActive(false); await subscriptions?.stop(); inactivity?.cancel(); inactivity = nil }
        else {
            await claims.setActive(true)
            noteUserInteraction(); await refreshSubscriptions()
            if inactivity == nil { inactivity = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    guard !Task.isCancelled else { break }; await self?.checkInactivity()
                }
            } }
        }
    }
    private func checkInactivity() async {
        let minutes = settings["autoLockMinutes"] as? Int ?? 0
        if active && minutes > 0 && signing != nil && ProcessInfo.processInfo.systemUptime - lastInteraction >= Double(minutes * 60) { _ = await lock() }
    }
    public func publicState() async throws -> JSONObject {
        let watch = await subscriptions?.state() ?? ["connected": false, "coverageLimited": false, "watched": 0, "total": 0]
        return ["exists": try store().exists(.vault), "locked": signing == nil || signing?.isLocked == true,
                "account": publicHd["account"] ?? NSNull(), "accounts": publicHd["accounts"] ?? [],
                "accountScope": "hd-wallet", "walletId": publicHd["walletId"] ?? NSNull(), "hd": publicHd["hd"] ?? NSNull(),
                "watch": watch, "lastPayment": lastPayment.map { $0 as Any } ?? NSNull(), "rpcTransport": "tcp",
                "rpcEndpoint": "\(settings["rpcHost"] ?? "connectcoin4.com"):\(settings["rpcPort"] ?? 48190)"]
    }
    private func revoke() -> (UInt64, NativeHdWallet?) {
        paymentPermit?.cancel(); let token = fence.invalidate(); recovery?.cancel(); recovery = nil
        signing?.lock(); signing = nil; update?.close(); update = nil
        let old = hd; hd = nil; approval?.inventory.discard(); approval = nil
        return (token, old)
    }
    private func revokeForOperation() async throws -> UInt64 {
        let (token, old) = revoke(); await old?.close(); try live(token); return token
    }
    public func lock() async -> JSONObject {
        let (_, old) = revoke()
        await old?.close()
        let state = (try? await publicState()) ?? ["locked": true]; emit("walletStateChanged", state); return state
    }
    private func live(_ token: UInt64) throws { try Task.checkCancellation(); try fence.check(token); try walletRequire(active, "Open the wallet to continue") }
    public func unlock(password: String) async throws {
        try walletRequire(active && !paymentBusy, "Finish the current payment first")
        let token = try await revokeForOperation(), envelope = try store().readVault()
        let candidate = try await Task.detached { try WalletVault.openForUpdate(envelope, password: password) }.value
        do { try live(token); try await adopt(candidate, token: token) } catch { candidate.close(); throw error }
    }
    private func adopt(_ candidate: NativeVaultUpdateSession, token: UInt64) async throws {
        try live(token)
        let payload = try candidate.payload(), next = try VaultSession(mnemonic: payload.string("mnemonic"), passphrase: payload.string("passphrase"))
        let store = try self.store(), fence = self.fence
        do {
            let nextHd = try NativeHdWallet(session: next, vault: candidate, persist: { value in try fence.commit(token) { try store.saveVault(value) } })
            let snapshot = await nextHd.snapshot()
            try live(token); signing = next; update = candidate; hd = nextHd; publicHd = snapshot
            try live(token); noteUserInteraction(); emit("walletStateChanged", try await publicState())
            await refreshSubscriptions(); startRecovery(nextHd, token)
        } catch { next.lock(); candidate.close(); throw error }
    }
    public func installMnemonic(_ mnemonic: String, password: String, replace: Bool, imported: Bool) async throws -> JSONObject {
        try walletRequire(active && !paymentBusy, "Finish the current payment first")
        let storage = try store(); try walletRequire(!storage.exists(.vault) || replace, "Back up the existing wallet before replacement")
        let token = try await revokeForOperation()
        let candidate = try await Task.detached { () throws -> NativeVaultUpdateSession in
            var payload = try WalletVault.newPayload(mnemonic: mnemonic); payload["needsRecovery"] = true
            return try WalletVault.createForUpdate(payload, password: password)
        }.value
        do {
            try live(token); try fence.commit(token) { try storage.saveVault(candidate.envelope()) }
            publicHd = [:]; try await adopt(candidate, token: token); return try await publicState()
        } catch { candidate.close(); throw error }
    }
    public func importEnvelope(_ data: Data, password: String, replace: Bool) async throws -> JSONObject {
        try walletRequire(active && !paymentBusy, "Finish the current payment first")
        let storage = try store(); try walletRequire(!storage.exists(.vault) || replace, "Back up the existing wallet before replacement")
        let envelope = try WalletVault.parse(data); let token = try await revokeForOperation()
        let candidate = try await Task.detached { () throws -> NativeVaultUpdateSession in
            let session = try WalletVault.openForUpdate(envelope, password: password)
            var payload = try session.payload(); payload["needsRecovery"] = true; payload["mobileHdRecovered"] = false
            try session.save(payload, writer: { _ in }); return session
        }.value
        do {
            try live(token); try fence.commit(token) { try storage.saveVault(candidate.envelope()) }
            publicHd = [:]; try await adopt(candidate, token: token); return try await publicState()
        } catch { candidate.close(); throw error }
    }
    public func exportEnvelope(password: String) async throws -> Data {
        let token = fence.token(), envelope = try store().readVault()
        let valid = try await Task.detached { try WalletVault.openForUpdate(envelope, password: password) }.value
        defer { valid.close() }; try live(token); return try Data(WalletVault.serialize(envelope).utf8)
    }
    public func recoveryPhrase(password: String) async throws -> String {
        let token = fence.token(), envelope = try store().readVault()
        let valid = try await Task.detached { try WalletVault.openForUpdate(envelope, password: password) }.value
        defer { valid.close() }; try live(token); return try valid.payload().string("mnemonic")
    }
    public func changePassword(old: String, new: String) async throws -> JSONObject {
        try walletRequire(active && !paymentBusy, "Finish the current payment first")
        let token = try await revokeForOperation(), envelope = try store().readVault()
        let changed = try await Task.detached { try WalletVault.changePassword(envelope, currentPassword: old, newPassword: new) }.value
        let candidate = try await Task.detached { try WalletVault.openForUpdate(changed, password: new) }.value
        do {
            try live(token); try fence.commit(token) { try store().saveVault(changed) }
            try await adopt(candidate, token: token); return try await publicState()
        } catch { candidate.close(); throw error }
    }
    private func startRecovery(_ owner: NativeHdWallet, _ token: UInt64) {
        recovery?.cancel()
        recovery = Task { [weak self] in
            guard let self else { return }
            do {
                try await owner.recover(rpc: self.rpc, progress: { value in Task { await self.acceptHd(value, token) } })
                await self.acceptHd(owner.snapshot(), token)
            } catch { await self.acceptHd(owner.snapshot(), token) }
        }
    }
    private func acceptHd(_ value: JSONObject, _ token: UInt64) async {
        guard (try? live(token)) != nil else { return }
        publicHd = value; await refreshSubscriptions()
        if let state = try? await publicState(), (try? live(token)) != nil { emit("walletStateChanged", state) }
    }
    private func refreshSubscriptions() async {
        guard active, let id = publicHd["walletId"] as? String, let rows = publicHd["accounts"] as? [JSONObject], !rows.isEmpty else { return }
        do {
            if subscriptions == nil {
                subscriptions = MobileWalletSubscriptions(endpoint: try TcpEndpoint(settings.string("rpcHost"), Int(settings.integer("rpcPort"))), emit: { [weak self] value in Task { await self?.emit("walletChanged", value) } })
            }
            try await subscriptions?.configure(id, rows.map { try $0.string("address") })
        } catch { /* Native watch state remains explicitly disconnected. */ }
    }
    private static func validateSettings(_ value: JSONObject) throws -> JSONObject {
        try walletRequire(Set(value.keys) == Set(["theme", "autoLockMinutes", "rpcHost", "rpcPort"]), "Invalid wallet settings")
        let theme = try value.string("theme"); try walletRequire(["dark", "light", "system"].contains(theme), "Invalid appearance")
        let minutes = try value.integer("autoLockMinutes", min: 0, max: 1440), port = try value.integer("rpcPort", min: 1, max: 65535)
        let endpoint = try TcpEndpoint(value.string("rpcHost"), Int(port))
        return ["theme": theme, "autoLockMinutes": Int(minutes), "rpcHost": endpoint.hostname, "rpcPort": Int(port)]
    }
    public func perform(_ method: String, _ params: JSONObject = [:]) async throws -> JSONObject {
        switch method {
        case "getState": return try await publicState()
        case "getSettings": return ["settings": settings]
        case "getRecoverySnapshots": return await hd?.recoverySnapshots() ?? ["groups": []]
        case "watchAccount": await refreshSubscriptions(); return try await publicState()
        case "lock": return await lock()
        case "newAddress":
            guard let hd else { throw WalletError("Unlock the wallet first") }
            let token = fence.token(); _ = try await hd.newAddress(); let snapshot = await hd.snapshot()
            try live(token); publicHd = snapshot; await refreshSubscriptions(); try live(token); return try await publicState()
        case "recoverAddresses":
            guard let hd else { throw WalletError("Unlock the wallet first") }
            try await hd.requestRecovery(); startRecovery(hd, fence.token()); return try await publicState()
        case "queryPublic":
            let method = try params.string("method"), arguments = try params.object("params"), token = fence.token(), rpcToken = rpcGeneration
            try walletRequire(!endpointChanging, "RPC endpoint is changing")
            try live(token); try walletRequire(params.count == 2 && ["getchaintip", "getaddressbalance", "getaddresshistory", "getaddressutxos", "getaddresschanges"].contains(method), "Unsupported wallet query")
            let own = Set((publicHd["accounts"] as? [JSONObject] ?? []).compactMap { $0["address"] as? String })
            try walletRequire(!own.isEmpty, "Native wallet account required")
            if method != "getchaintip" {
                let requested = method == "getaddresschanges" ? try arguments.array("addresses").map { try JSON.string($0) } : [try arguments.string("address")]
                try walletRequire(!requested.isEmpty && requested.allSatisfy(own.contains), "Query address is outside this wallet")
            }
            let response = try await rpc.call(method, arguments); try live(token)
            try walletRequire(rpcToken == rpcGeneration, "RPC endpoint changed")
            if let hd {
                for address in try NativeHdWallet.usedAddresses(method, arguments, response) { _ = try await hd.observeUsed(address); try live(token) }
                let snapshot = await hd.snapshot(); try live(token); try walletRequire(rpcToken == rpcGeneration, "RPC endpoint changed")
                publicHd = snapshot
            }
            return ["result": response]
        case "saveSettings":
            let next = try Self.validateSettings(params)
            let endpointChanged = settings["rpcHost"] as? String != next["rpcHost"] as? String || settings["rpcPort"] as? Int != next["rpcPort"] as? Int
            try walletRequire(active && !paymentBusy && approval == nil, "Finish the current payment before changing settings")
            paymentBusy = true; endpointChanging = endpointChanged
            defer { paymentBusy = false; endpointChanging = false }
            if endpointChanged { try walletRequire(await claims.canChangeEndpoint(), "Wait for claim submission before changing RPC") }
            if endpointChanged {
                let token = fence.token(), storage = try store()
                await claims.close(); await subscriptions?.stop(); subscriptions = nil; rpcGeneration &+= 1
                do {
                    let replacement = try await rpc.replaceEndpoint(TcpEndpoint(next.string("rpcHost"), Int(next.integer("rpcPort"))), persist: { [fence] in
                        try fence.commit(token) { try storage.write(.settings, JSON.encode(next)) }
                    })
                    settings = next; rpc = replacement
                } catch {
                    claims = MobileClaimsEngine(rpc: rpc); await claims.setActive(active); await refreshSubscriptions(); throw error
                }
                claims = MobileClaimsEngine(rpc: rpc); await claims.setActive(active); await refreshSubscriptions()
            } else { try store().write(.settings, JSON.encode(next)); settings = next }
            return ["settings": settings, "endpointChanged": endpointChanged]
        case "getPaymentBatch":
            if !paymentBusy, let receipt = try store().receipt() { try store().saveReservations(MobilePaymentBatch.reconcileNotSent(receipt, store().reservations())) }
            let summary = try MobilePaymentBatch.pendingSummary(store().receipt())
            return ["batch": summary.map { $0 as Any } ?? NSNull()]
        case "dismissPaymentBatch":
            try walletRequire(!paymentBusy && params.count == 1, "Wait for the current payment")
            if let receipt = try store().receipt() { try store().saveReceipt(MobilePaymentBatch.acknowledge(receipt, params.string("batchId"))) }
            return ["batch": NSNull()]
        case "cancelPayment": paymentPermit?.cancel(); approval?.inventory.discard(); approval = nil; return [:]
        case "claimsState": return ["state": await claims.state()]
        case "claimsPolicy": return ["state": try await claims.policy(params)]
        case "claimsLimits": return ["state": try await claims.limits(params)]
        case "claimsStart":
            try walletRequire(params.count == 1 && active, "Invalid claims start")
            let address = try params.string("address")
            try walletRequire((publicHd["accounts"] as? [JSONObject] ?? []).contains { $0["address"] as? String == address }, "Claims must use your native wallet address")
            try await claims.start(address: address); return ["state": await claims.state()]
        case "claimsStop": await claims.stop(); return ["state": await claims.state()]
        case "claimsCheckSubmission": return ["state": try await claims.checkSubmission()]
        default: throw WalletError("Unsupported native wallet operation")
        }
    }

    public func preparePayment(_ params: JSONObject, p2c: Bool = false) async throws -> JSONObject {
        try walletRequire(active && !paymentBusy && approval == nil, "Finish the current native wallet operation")
        guard let hd, let signing, !signing.isLocked else { throw WalletError("Unlock the wallet first") }
        let token = fence.token(), rpc = self.rpc, fence = self.fence
        paymentBusy = true; defer { paymentBusy = false }
        try await hd.requireReady(); try live(token)
        try walletRequire(try MobilePaymentBatch.pendingSummary(store().receipt()) == nil, "Review and dismiss the previous batch receipt first")
        let send = p2c ? nil : try NativeSendPolicy.request(params)
        var bounty = p2c ? try NativeP2CPolicy.request(params) : nil
        let scope = send?.fundingScope ?? bounty?.fundingScope
        let nativeAccounts = await hd.accounts(), change = try await hd.changeAccount()
        let accounts = try scope?.select(nativeAccounts) ?? nativeAccounts, walletID = try publicHd.string("walletId")
        try live(token)
        let fundingSession = funding.session(reader: { try await rpc.call($0, $1) }, check: { try fence.check(token) }, progress: { [weak self] stage, completed, total, retry in
            Task { await self?.paymentProgress(token, walletID, p2c, stage, completed, total, retry) }
        })
        let inventory = try await MobilePaymentPreparation.inventory(accounts, store().reservations(), fundingSession)
        do {
            try live(token); var candidates = try inventory.candidates()
            let pending = try inventory.pendingCandidates(), changeAddress = try change.string("address")
            var plans: [JSONObject], batch: JSONObject?
            do {
                if let send {
                    let result = try NativeSendBatch.plan(send, candidates, changeAddress)
                    plans = try PJ.objects(result["plans"]); batch = plans.count > 1 ? result : nil
                } else if let bounty {
                    plans = [try NativeTransactions.planPayment(candidates, [bounty.destination()], changeAddress, 1500, false)]
                } else { throw WalletError("Invalid payment intent") }
            } catch {
                // A replacement remains one explicitly approved transaction.
                // Only insufficient confirmed funds permits using reservations.
                let insufficient = (error as? WalletError)?.message == "Insufficient funds for payment and fee."
                guard send?.useAllBalance != true, !pending.isEmpty, candidates.isEmpty || insufficient else { throw error }
                candidates += pending; batch = nil
                if let send { plans = [try send.plan(candidates, changeAddress)] }
                else if let bounty { plans = [try NativeTransactions.planPayment(candidates, [bounty.destination()], changeAddress, 1500, false)] }
                else { throw WalletError("Invalid payment intent") }
            }
            var ownerByPath = [String: String]()
            for account in accounts {
                let path = "\(try account.integer("change")):\(try account.integer("index"))"
                try walletRequire(ownerByPath[path] == nil, "Duplicate native funding path"); ownerByPath[path] = try account.string("publicKey")
            }
            var retainedParents = [String: String](), retainedBytes = 0, combined = [JSONObject](), capacity = try store().reservations()
            for i in plans.indices {
                let selected = try PJ.objects(plans[i]["selected"])
                var loaded = try await funding.load(selected, owner: { row in
                    let key = "\(try PJ.integer(row["change"], 0, 1)):\(try PJ.integer(row["index"], 0, Int64(Int32.max)))"
                    guard let owner = ownerByPath[key] else { throw WalletError("Unknown native signing path") }; return owner
                }, fundingSession)
                for j in loaded.indices {
                    let id = try loaded[j].string("txid"), raw = try loaded[j].string("rawTransaction")
                    if let retained = retainedParents[id] { try walletRequire(raw == retained, "Funding parent changed"); loaded[j]["rawTransaction"] = retained }
                    else {
                        try walletRequire(raw.utf8.count <= MobilePaymentFunding.MAX_RETAINED_HEX - retainedBytes, "Selected funding exceeds the mobile memory limit.")
                        retainedBytes += raw.utf8.count; retainedParents[id] = raw
                    }
                }
                plans[i]["selected"] = loaded; combined += loaded
                capacity = try NativePaymentReservations.reserve(capacity, loaded, String(repeating: "0", count: 64))
            }
            let fresh = try await MobilePaymentPreparation.refresh(inventory, store().reservations(), fundingSession)
            if batch != nil { try fresh.verifyBatch(plans, send!.useAllBalance, send!.amount) }
            else { try fresh.verifySelected(combined, send?.useAllBalance ?? false, send?.amount) }
            try live(token)
            // The optional RSA probe is public advisory work. Its outcome only
            // narrows the mask after authenticated TLS support is established.
            if let intent = bounty {
                let outcome: String
                do { outcome = try await NativeClaims.probeRsa(domain: intent.domain, validationTime: Int64(Date().timeIntervalSince1970)) }
                catch {
                    try Task.checkCancellation(); try live(token)
                    let code = (error as? WalletError)?.message ?? ""
                    if code == "CLAIM_CANCELLED" { throw error }
                    outcome = code == "CLAIM_TIMEOUT" ? "timeout" : code == "CLAIM_BUSY" ? "busy" : code == "CLAIM_CRYPTO" ? "unavailable" : "failed"
                }
                try live(token); bounty = intent.withProbe(outcome)
                plans = [try NativeTransactions.planPayment(combined, [bounty!.destination()], changeAddress, 1500, false)]
            }
            var review: String
            if var value = batch {
                value["plans"] = plans; value["selected"] = combined; batch = value
                review = try NativeSendBatch.review(send!, value, changeAddress)
            } else if let bounty { review = try bounty.review(plans[0], changeAddress) }
            else { review = try send!.review(plans[0], changeAddress) }
            let replacements = try Set(combined.compactMap { row -> String? in PJ.null(row["pending_spent_by"]) ? nil : try PJ.hash(row["pending_spent_by"]) })
            if accounts.count < nativeAccounts.count { review += "\n\nFunding is restricted to \(accounts.count) of \(nativeAccounts.count) wallet addresses. Other addresses are not included in this payment." }
            if !replacements.isEmpty { review += "\n\nThis payment spends coins reserved by these pending or previously submitted transactions:\n" + replacements.sorted().joined(separator: "\n") + "\nTheir outcome may be unknown. Check them first. Explicitly allow a replacement below to proceed. The node may still reject it." }
            try live(token)
            approval = Approval(token: token, send: send, bounty: bounty, inventory: fresh, fundingSession: fundingSession, plans: plans, batch: batch, change: change, accounts: accounts, expires: ProcessInfo.processInfo.systemUptime + 120, replacesPending: !replacements.isEmpty)
            return ["lines": review.components(separatedBy: "\n"), "requiresReplacement": !replacements.isEmpty]
        } catch { inventory.discard(); throw error }
    }
    private func paymentProgress(_ token: UInt64, _ address: String, _ p2c: Bool, _ stage: String, _ completed: Int, _ total: Int, _ retry: Int64) {
        guard (try? live(token)) != nil else { return }
        emit("paymentPreparation", ["address": address, "operation": p2c ? "reviewP2C" : "reviewPayment", "stage": stage, "completed": completed, "total": total, "retryAfterMs": retry])
    }
    public func confirmPayment(allowReplacement: Bool = false) async throws -> JSONObject {
        guard let approved = approval, let signing, let hd else { throw WalletError("Review the payment again") }
        try live(approved.token); try walletRequire(!paymentBusy, "Payment already in progress")
        try walletRequire(!approved.replacesPending || allowReplacement, "Replacement was not authorized. Check the previous transaction before retrying.")
        let permit = RpcBroadcastPermit(); paymentPermit = permit
        approval = nil; paymentBusy = true; defer { paymentBusy = false; paymentPermit = nil; approved.inventory.discard() }
        let fence = self.fence, token = approved.token, rpc = self.rpc, expires = approved.expires
        let check: () throws -> Void = {
            try Task.checkCancellation(); try fence.check(token)
            try walletRequire(!signing.isLocked && permit.isValid, "Payment signing cancelled. Unlock and review again.")
            try walletRequire(ProcessInfo.processInfo.systemUptime < expires, "Payment review expired. Review a fresh payment.")
        }
        let expiry = Task {
            let remaining = max(0, expires - ProcessInfo.processInfo.systemUptime)
            do { try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)); permit.cancel() } catch { }
        }
        defer { expiry.cancel() }
        try check(); try await hd.requireReady(); try check()
        let walletID = try publicHd.string("walletId")
        let session = funding.session(reader: { try await rpc.call($0, $1) }, check: check, progress: { [weak self] stage, completed, total, retry in
            Task { await self?.paymentProgress(token, walletID, approved.bounty != nil, stage, completed, total, retry) }
        })
        let refreshed = try await MobilePaymentPreparation.refresh(approved.inventory, store().reservations(), session)
        defer { refreshed.discard() }; try live(approved.token)
        if approved.batch != nil { try refreshed.verifyBatch(approved.plans, approved.send!.useAllBalance, approved.send!.amount) }
        else { try refreshed.verifySelected(PJ.objects(approved.plans[0]["selected"]), approved.send?.useAllBalance ?? false, approved.send?.amount) }
        let change = try approved.change.string("address")
        if let batch = approved.batch { try NativeSendBatch.verify(approved.send!, batch, change) }
        for plan in approved.plans { if let send = approved.send, approved.batch == nil { try send.verifyPlan(plan, change) }; try approved.bounty?.verifyPlan(plan, change) }
        let signingTask = Task.detached { try approved.plans.map { try NativeTransactions.signPayment($0, signing, check: check) } }
        let signed = try await withTaskCancellationHandler(operation: { try await signingTask.value }, onCancel: { signingTask.cancel(); permit.cancel() })
        try live(token); try check()
        if try approved.plans.contains(where: { try NativeTransactions.amount($0.string("change")) > 0 }) { try await hd.allocateChange(Int(approved.change.integer("index"))) }
        try check(); publicHd = await hd.snapshot(); try check()
        let storage = try store(), sender = RpcBatchSender(rpc: rpc, permit: permit)
        if let batch = approved.batch {
            let result = try await MobilePaymentBatch.asyncSubmit(walletID, approved.send!.address, batch, signed, store: storage, sender: sender, check: check)
            lastPayment = result; return result
        }
        let plan = approved.plans[0], transaction = signed[0], txid = try transaction.string("txid")
        let selected = try PJ.objects(plan["selected"]), previousReservations = try storage.reservations()
        let reservations = try NativePaymentReservations.reserve(previousReservations, selected, txid)
        var receipt = transaction; receipt["broadcast_status"] = "check-required"
        try fence.commit(token) { try check(); try storage.saveReservations(reservations); try check(); try storage.write(.payment, JSON.encode(receipt)); try check() }
        var result: JSONObject = ["txid": txid, "status": "check-required"]
        lastPayment = result
        do {
            let sent = try await sender.broadcast(transaction.string("hex"))
            try walletRequire(sent["txid"] as? String == txid, "Broadcast returned a different transaction")
            receipt["broadcast_status"] = "submitted"
            try storage.write(.payment, JSON.encode(receipt)); result["status"] = "submitted"
        } catch {
            if sender.provenNotSent(error) {
                do {
                    // Durable proof of zero transmission precedes release and
                    // restores any reservation replaced by explicit approval.
                    receipt["broadcast_status"] = "not-sent"; try storage.write(.payment, JSON.encode(receipt))
                    try storage.saveReservations(NativePaymentReservations.releaseNotSent(storage.reservations(), txid, previousReservations))
                    result["status"] = "not-sent"; result["message"] = "Cancelled before transmission. No payment was sent; review again to send."
                } catch { /* Keep conservative holds if durable cleanup fails. */ }
            }
            if result["status"] as? String != "not-sent" { result["message"] = "Check this transaction ID before attempting another payment. The previous outcome may be unknown." }
        }
        lastPayment = result; return result
    }
}

private struct RpcBatchSender: MobilePaymentBatchAsyncSender {
    let rpc: MobileRpcClient
    let permit: RpcBroadcastPermit
    func broadcast(_ hex: String) async throws -> JSONObject { try await rpc.broadcast(hex, permit: permit) }
    func provenNotSent(_ error: Error) -> Bool {
        guard let failure = error as? RpcFailure else { return false }
        return !failure.unknownOutcome && !failure.explicitRejection && failure.code == "RPC_CANCELLED"
    }
}
