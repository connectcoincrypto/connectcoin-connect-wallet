import Foundation

/// Complete native inventories reconciled through frozen journal watermarks.
/// Each group shares one watermark and at most sixteen concurrent public reads.
public enum MobilePaymentPreparation {
    private static let MAX_ATTEMPTS = 3
    fileprivate final class Group {
        let accounts: [JSONObject], addresses: [String], inventories: [NativePaymentInventory], scope: NativePaymentInventory.RowBudget.Scope
        init(_ accounts: [JSONObject], _ addresses: [String], _ inventories: [NativePaymentInventory], _ scope: NativePaymentInventory.RowBudget.Scope) {
            self.accounts = accounts; self.addresses = addresses; self.inventories = inventories; self.scope = scope
        }
        func discard() { scope.close(); for inventory in inventories { inventory.discard() } }
    }
    public final class HdInventory {
        fileprivate let budget: NativePaymentInventory.RowBudget, groups: [Group], inventories: [NativePaymentInventory]
        fileprivate init(_ groups: [Group], _ budget: NativePaymentInventory.RowBudget) throws {
            self.groups = groups; self.budget = budget; inventories = groups.flatMap(\.inventories)
            try PJ.require(!inventories.isEmpty && inventories.reduce(0, { $0 + $1.rowCount() }) <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Wallet outputs exceed the mobile memory limit.")
        }
        public func candidates() throws -> [JSONObject] { try candidates(false) }
        public func pendingCandidates() throws -> [JSONObject] { try candidates(true) }
        private func candidates(_ pending: Bool) throws -> [JSONObject] {
            try requireCoherent(); var all = [JSONObject](), seen = Set<String>()
            for inventory in inventories {
                let rows = try pending ? inventory.pendingCandidates() : inventory.candidates()
                for row in rows {
                    try PJ.require(seen.insert(PJ.outpoint(row)).inserted, "Duplicate output across wallet addresses.")
                    try PJ.require(all.count < NativeTransactions.MAX_PAYMENT_CANDIDATES, "Wallet outputs exceed the mobile memory limit."); all.append(row)
                }
            }; return all
        }
        public func verifySelected(_ selected: [JSONObject], _ useAll: Bool, _ expectedAmount: String?) throws {
            try requireCoherent(); try PJ.require(!selected.isEmpty && selected.count <= NativeTransactions.MAX_PAYMENT_INPUTS, "Invalid selected payment input count.")
            var byPath = [String: [JSONObject]](), seen = Set<String>(); var selectedTotal: Int64 = 0
            for row in selected {
                let index = try PJ.integer(row["index"], 0, Int64(Int32.max)), change = try PJ.integer(row["change"], 0, 1)
                try PJ.require(seen.insert(PJ.outpoint(row)).inserted, "Duplicate selected payment input.")
                byPath["\(change):\(index)", default: []].append(row); selectedTotal = try PJ.add(selectedTotal, PJ.money(row, "amount"))
            }
            for inventory in inventories { if let rows = byPath.removeValue(forKey: "\(inventory.change()):\(inventory.index())") { try inventory.verifySelected(rows, false, nil) } }
            try PJ.require(byPath.isEmpty, "Payment input is outside this wallet's address inventory.")
            if useAll {
                var total: Int64 = 0; for row in try candidates() { total = try PJ.add(total, PJ.money(row, "amount")) }
                let expected = try NativeTransactions.amount(PJ.string(expectedAmount))
                try PJ.require(total == expected && selectedTotal == expected, "Available funds changed. Refresh the balance and use all again.")
                for row in selected { try PJ.require(PJ.null(row["pending_spent_by"]), "Available payment funds are reserved.") }
            }
        }
        public func verifyBatch(_ plans: [JSONObject], _ useAll: Bool, _ expectedAmount: String?) throws {
            try requireCoherent(); try PJ.require((2...32).contains(plans.count), "Invalid payment batch size.")
            var selectedKeys = Set<String>(); var selectedTotal: Int64 = 0
            for plan in plans {
                let selected = try PJ.objects(plan["selected"]); try verifySelected(selected, false, nil)
                for row in selected {
                    try PJ.require(PJ.null(row["pending_spent_by"]) && selectedKeys.insert(PJ.outpoint(row)).inserted, "Payment batches require distinct unreserved confirmed inputs.")
                    try PJ.require(selectedKeys.count <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Payment batch exceeds the mobile input limit."); selectedTotal = try PJ.add(selectedTotal, PJ.money(row, "amount"))
                }
            }
            if useAll {
                let available = try candidates(); var total: Int64 = 0
                try PJ.require(available.count == selectedKeys.count, "Available funds changed. Refresh the balance and use all again.")
                for row in available { try PJ.require(selectedKeys.remove(PJ.outpoint(row)) != nil, "Available funds changed. Refresh the balance and use all again."); total = try PJ.add(total, PJ.money(row, "amount")) }
                let expected = try NativeTransactions.amount(PJ.string(expectedAmount)); try PJ.require(selectedKeys.isEmpty && total == expected && selectedTotal == expected, "Available funds changed. Refresh the balance and use all again.")
            }
        }
        fileprivate func coherent() throws -> Bool {
            guard let first = inventories.first else { return false }; let firstTip = try first.tip()
            for inventory in inventories {
                let tip = try inventory.tip()
                if !inventory.reconciled() || inventory.journalEpoch() != first.journalEpoch() || inventory.throughSequence() != first.throughSequence() { return false }
                for field in ["height", "hash", "mediantime"] { if !PJ.equal(tip[field], firstTip[field]) { return false } }
            }; return true
        }
        fileprivate func requireCoherent() throws { try PJ.require(coherent(), "Wallet funding snapshots changed during synchronization. Review again.") }
        public func discard() { budget.close(); for group in groups { group.discard() } }
    }
    public static func inventory(_ address: String, _ reservations: JSONObject, _ session: MobilePaymentFunding.Session) async throws -> NativePaymentInventory { try await prepare(address, 0, 0, reservations, session, nil) }
    public static func refresh(_ inventory: NativePaymentInventory, _ reservations: JSONObject, _ session: MobilePaymentFunding.Session) async throws -> NativePaymentInventory { try await prepare(inventory.address(), inventory.index(), inventory.change(), reservations, session, inventory) }
    public static func inventory(_ nativeAccounts: [JSONObject], _ reservations: JSONObject, _ session: MobilePaymentFunding.Session) async throws -> HdInventory {
        try await inventory(nativeAccounts, reservations, session, NativePaymentInventory.RowBudget())
    }
    public static func inventory(_ nativeAccounts: [JSONObject], _ reservations: JSONObject, _ session: MobilePaymentFunding.Session, _ budget: NativePaymentInventory.RowBudget) async throws -> HdInventory {
        do { return try await loadInventory(nativeAccounts, reservations, session, budget) } catch { budget.close(); throw error }
    }
    private static func loadInventory(_ nativeAccounts: [JSONObject], _ reservations: JSONObject, _ session: MobilePaymentFunding.Session, _ budget: NativePaymentInventory.RowBudget) async throws -> HdInventory {
        try PJ.require((1...10_000).contains(nativeAccounts.count), "Invalid native wallet address count.")
        var accounts = [JSONObject](), addresses = Set<String>(), paths = Set<String>()
        for row in nativeAccounts {
            let address = try PJ.string(row["address"]); _ = try WalletCrypto.decodeAddress(address)
            let index = try PJ.integer(row["index"], 0, Int64(Int32.max)), change = try PJ.integer(row["change"], 0, 1)
            try PJ.require(addresses.insert(address).inserted && paths.insert("\(change):\(index)").inserted, "Invalid native wallet address set."); accounts.append(PJ.snapshot(row))
        }
        var groups = [Group]()
        for start in stride(from: 0, to: accounts.count, by: 100) { groups.append(try await prepareGroup(Array(accounts[start..<min(accounts.count, start + 100)]), reservations, session, nil, budget)) }
        return try await align(HdInventory(groups, budget), reservations, session)
    }
    public static func refresh(_ previous: HdInventory, _ reservations: JSONObject, _ session: MobilePaymentFunding.Session) async throws -> HdInventory {
        do {
            var groups = [Group]()
            for group in previous.groups { groups.append(try await prepareGroup(group.accounts, reservations, session, group, previous.budget)) }
            return try await align(HdInventory(groups, previous.budget), reservations, session)
        } catch { previous.budget.close(); throw error }
    }
    private static func align(_ original: HdInventory, _ reservations: JSONObject, _ session: MobilePaymentFunding.Session) async throws -> HdInventory {
        var current = original
        for _ in 0..<MAX_ATTEMPTS {
            try session.check(); if try current.coherent() { return current }; var groups = [Group]()
            for group in current.groups { groups.append(try await prepareGroup(group.accounts, reservations, session, group, current.budget)) }
            current = try HdInventory(groups, current.budget)
        }; try current.requireCoherent(); return current
    }
    private static func prepareGroup(_ accounts: [JSONObject], _ reservations: JSONObject, _ session: MobilePaymentFunding.Session, _ original: Group?, _ budget: NativePaymentInventory.RowBudget) async throws -> Group {
        let addresses = try accounts.map { try PJ.string($0["address"]) }; var previous = original
        for attempt in 0..<MAX_ATTEMPTS {
            try session.check(); let scope = try previous?.scope ?? budget.scope(); var retained = false
            defer { if !retained { scope.close() } }
            do {
                let inventories: [NativePaymentInventory]
                if let previous {
                    inventories = previous.inventories; for inventory in inventories { try inventory.beginRefresh(reservations) }
                } else {
                    let watermark = try await session.read("getaddresschanges", ["addresses": addresses], "outputs", 0, accounts.count)
                    inventories = try await parallel(accounts.count, session) { position in
                        let account = accounts[position]
                        let inventory = try NativePaymentInventory.fromWatermark(PJ.string(account["address"]), Int(PJ.integer(account["index"])), Int(PJ.integer(account["change"])), watermark, reservations, scope)
                        return try await baselinePages(inventory, session)
                    }
                }
                guard let first = inventories.first else { throw WalletError("Missing payment inventories.") }
                while !first.reconciled() {
                    try session.check(); guard let cursor = first.changesCursor() else { throw WalletError("Missing payment journal cursor.") }
                    let params: JSONObject = ["addresses": addresses, "cursor": cursor]
                    let page = try await session.read("getaddresschanges", params, "outputs", 0, inventories.count)
                    _ = try NativeHdWallet.usedAddresses("getaddresschanges", params, page)
                    try session.check(); try NativePaymentInventory.applySharedChanges(inventories, page)
                }
                try session.check(); try scope.check(); retained = true; return Group(accounts, addresses, inventories, scope)
            } catch {
                previous?.discard(); try session.check()
                if !stale(error) || attempt + 1 == MAX_ATTEMPTS { throw error }; previous = nil
            }
        }; throw WalletError("HD funding journal could not be reconciled.")
    }
    private static func parallel(_ size: Int, _ session: MobilePaymentFunding.Session, _ read: @escaping (Int) async throws -> NativePaymentInventory) async throws -> [NativePaymentInventory] {
        try await withThrowingTaskGroup(of: NativePaymentInventory.self) { tasks in
            var next = 0, rows = 0, result = [NativePaymentInventory]()
            while next < min(size, 16) { let position = next; tasks.addTask { try await read(position) }; next += 1 }
            do {
                while let inventory = try await tasks.next() {
                    try session.check(); rows += inventory.rowCount(); try PJ.require(rows <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Wallet outputs exceed the mobile memory limit."); result.append(inventory)
                    if next < size { let position = next; tasks.addTask { try await read(position) }; next += 1 }
                }; try session.check(); return result
            } catch { tasks.cancelAll(); throw error }
        }
    }
    private static func prepare(_ address: String, _ index: Int, _ change: Int, _ reservations: JSONObject, _ session: MobilePaymentFunding.Session, _ original: NativePaymentInventory?) async throws -> NativePaymentInventory {
        var previous = original
        for attempt in 0..<MAX_ATTEMPTS {
            try session.check()
            do {
                let inventory: NativePaymentInventory
                if let previous { inventory = previous; try inventory.beginRefresh(reservations) }
                else {
                    let watermark = try await session.read("getaddresschanges", changes(address, nil), "outputs", 0, 0)
                    let baseline = try NativePaymentInventory.fromWatermark(address, index, change, watermark, reservations)
                    inventory = try await baselinePages(baseline, session)
                }
                while !inventory.reconciled() {
                    try session.check(); let response = try await session.read("getaddresschanges", changes(inventory.address(), inventory.changesCursor()), "outputs", inventory.rowCount(), 0)
                    try inventory.applyChanges(response)
                }; try session.check(); return inventory
            } catch { try session.check(); if !stale(error) || attempt + 1 == MAX_ATTEMPTS { throw error }; previous = nil }
        }; throw WalletError("Payment output inventory could not be reconciled.")
    }
    private static func baselinePages(_ inventory: NativePaymentInventory, _ session: MobilePaymentFunding.Session) async throws -> NativePaymentInventory {
        while !inventory.complete() {
            try session.check(); var params: JSONObject = ["address": inventory.address(), "include_pending_spent": true]
            if let cursor = inventory.nextCursor() { params["cursor"] = cursor }
            let page = try await session.read("getaddressutxos", params, "outputs", inventory.rowCount(), 0); try inventory.accept(page)
        }; return inventory
    }
    private static func stale(_ error: Error) -> Bool { error is NativePaymentInventory.SnapshotChanged || (error as? RpcFailure)?.code == "-32011" }
    private static func changes(_ address: String, _ cursor: String?) -> JSONObject { var params: JSONObject = ["addresses": [address]]; if let cursor { params["cursor"] = cursor }; return params }
}
