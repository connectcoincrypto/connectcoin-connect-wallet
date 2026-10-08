import Foundation

/// Complete native-owned output inventory. It does not fetch, sign, submit or
/// remove durable reservations. Each instance has one serialized worker owner;
/// its aggregate row budget synchronizes all concurrently loading addresses.
public final class NativePaymentInventory {
    public static let MAX_PAGES = 512, MAX_CHANGE_PAGES = 1000, MAX_CHANGE_EVENTS = 100_000
    private static let maxSafeInteger: Int64 = 9_007_199_254_740_991
    public struct SnapshotChanged: Error, LocalizedError {
        public init() {}
        public var errorDescription: String? { "Payment snapshot changed. Refresh and review again." }
    }
    public final class RowBudget {
        private let mutex = NSRecursiveLock()
        private let limit: Int
        private var rows = 0, closed = false
        public init(_ limit: Int = NativeTransactions.MAX_PAYMENT_CANDIDATES) throws {
            try PJ.require(limit > 0 && limit <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Invalid payment inventory budget."); self.limit = limit
        }
        public func scope() throws -> Scope {
            mutex.lock(); defer { mutex.unlock() }
            try PJ.require(!closed, "Payment output inventory was cancelled."); return Scope(self)
        }
        public func rowCount() -> Int { mutex.lock(); defer { mutex.unlock() }; return rows }
        public func close() { mutex.lock(); closed = true; mutex.unlock() }
        public final class Scope {
            private let owner: RowBudget
            private var retained = 0, discarded = false
            fileprivate init(_ owner: RowBudget) { self.owner = owner }
            deinit { close() }
            public func check() throws {
                owner.mutex.lock(); defer { owner.mutex.unlock() }
                try PJ.require(!owner.closed && !discarded, "Payment output inventory was cancelled.")
            }
            fileprivate func adjust(_ delta: Int) throws {
                owner.mutex.lock(); defer { owner.mutex.unlock() }; try check()
                try PJ.require(delta >= -retained && owner.rows + delta <= owner.limit, "Wallet outputs exceed the mobile memory limit.")
                retained += delta; owner.rows += delta
            }
            fileprivate func publish(_ delta: Int, _ publication: () -> Void) throws {
                owner.mutex.lock(); defer { owner.mutex.unlock() }; try adjust(delta); publication()
            }
            public func close() {
                owner.mutex.lock(); defer { owner.mutex.unlock() }
                if !discarded { owner.rows -= retained; retained = 0; discarded = true }
            }
        }
    }
    // Explicit insertion ranks preserve Java LinkedHashMap ordering without
    // quadratic array removals when many journal mutations remove/re-add rows.
    private struct OrderedOutputs {
        var values = [String: JSONObject](), ranks = [String: Int](), nextRank = 0
        var count: Int { values.count }
        var orderedKeys: [String] { values.keys.sorted { ranks[$0]! < ranks[$1]! } }
        mutating func set(_ key: String, _ value: JSONObject) {
            if values[key] == nil { ranks[key] = nextRank; nextRank += 1 }; values[key] = value
        }
        mutating func remove(_ key: String) { values.removeValue(forKey: key); ranks.removeValue(forKey: key) }
    }
    private let ownedAddress: String, ownedIndex: Int, ownedChange: Int
    private var budget: RowBudget.Scope?
    private var anchor: JSONObject, reservations: JSONObject
    private var outputs = OrderedOutputs(), cursors = Set<String>()
    private var cursor: String?, pages = 0, isComplete = false, journal = false, isReconciled = false
    private var journalCursor: String?, epoch: Int64 = 0, sequence: Int64 = 0, drainThrough: Int64 = -1
    private var drainTip: JSONObject?, changePages = 0, changeEvents = 0, changeCursors = Set<String>()

    public convenience init(_ address: String, _ tip: JSONObject, _ reservations: JSONObject) throws { try self.init(address, 0, 0, tip, reservations) }
    public init(_ address: String, _ index: Int, _ change: Int, _ tip: JSONObject, _ reservations: JSONObject) throws {
        _ = try WalletCrypto.decodeAddress(address)
        try PJ.require(index >= 0 && index <= Int(Int32.max) && (change == 0 || change == 1), "Invalid native payment derivation path.")
        ownedAddress = address; ownedIndex = index; ownedChange = change
        anchor = try JSON.clone(NativePaymentChecks.tip(tip)); self.reservations = try JSON.clone(reservations)
    }
    public static func fromWatermark(_ address: String, _ watermark: JSONObject, _ reservations: JSONObject) throws -> NativePaymentInventory {
        try fromWatermark(address, 0, 0, watermark, reservations)
    }
    public static func fromWatermark(_ address: String, _ index: Int, _ change: Int, _ watermark: JSONObject,
        _ reservations: JSONObject, budget: RowBudget.Scope?) throws -> NativePaymentInventory {
        try fromWatermark(address,index,change,watermark,reservations,budget)
    }
    public static func fromWatermark(_ address: String, _ index: Int, _ change: Int, _ watermark: JSONObject,
        _ reservations: JSONObject, _ budget: RowBudget.Scope? = nil) throws -> NativePaymentInventory {
        try budget?.check()
        let tip = try journalResponse(watermark)
        try PJ.require(PJ.array(watermark["changes"]).isEmpty && !PJ.bool(watermark["has_more"]), "Invalid payment journal watermark.")
        let inventory = try NativePaymentInventory(address, index, change, tip, reservations)
        inventory.journal = true; inventory.sequence = try PJ.integer(watermark["through_sequence"], 0, maxSafeInteger)
        inventory.epoch = try PJ.integer(watermark["journal_epoch"], 0, maxSafeInteger)
        inventory.journalCursor = try requiredCursor(watermark); inventory.changeCursors.insert(inventory.journalCursor!)
        inventory.budget = budget; return inventory
    }
    private static func requiredCursor(_ response: JSONObject) throws -> String {
        guard let cursor = try NativePaymentChecks.cursor(response) else { throw WalletError("Missing payment journal cursor.") }; return cursor
    }
    private static func journalResponse(_ response: JSONObject) throws -> JSONObject {
        try PJ.keys(response, ["tip", "unit", "changes", "next_cursor", "has_more", "through_sequence", "journal_epoch"])
        try PJ.require(PJ.string(response["unit"]) == "connects" && PJ.array(response["changes"]).count <= 500, "Invalid payment journal response.")
        _ = try PJ.bool(response["has_more"]); _ = try requiredCursor(response)
        _ = try PJ.integer(response["through_sequence"], 0, maxSafeInteger); _ = try PJ.integer(response["journal_epoch"], 0, maxSafeInteger)
        return try NativePaymentChecks.tip(PJ.object(response["tip"]))
    }
    private static func pendingSpender(_ row: JSONObject) throws -> String? {
        try PJ.require(row["pending_spent_by"] != nil, "Payment reservation changed. Review again.")
        return PJ.null(row["pending_spent_by"]) ? nil : try PJ.hash(row["pending_spent_by"])
    }
    private func requireComplete() throws {
        try budget?.check(); try PJ.require(isComplete && (!journal || isReconciled), "Payment outputs are incomplete. Refresh and review again.")
    }
    private func reservedView(_ source: JSONObject) throws -> JSONObject {
        var row = source; let key = try PJ.outpoint(row)
        if PJ.null(row["pending_spent_by"]), let held = reservations[key] { row["pending_spent_by"] = try PJ.hash(held) }
        return row
    }
    public func accept(_ page: JSONObject) throws {
        try budget?.check(); try PJ.require(!isComplete && pages < Self.MAX_PAGES, "Invalid or oversized UTXO pagination.")
        let pageTip = try NativePaymentChecks.tip(PJ.object(page["tip"]))
        // Validate the entire schema first. Only a valid different snapshot is
        // retryable; malformed rows must never masquerade as chain advancement.
        let rows = try NativePaymentChecks.utxos(page, ownedAddress, pageTip)
        if !journal {
            for field in ["hash", "height", "mediantime"] where !PJ.equal(anchor[field], pageTip[field]) { throw SnapshotChanged() }
            try NativePaymentChecks.sameTip(anchor, pageTip)
        }
        try PJ.require(outputs.count + rows.count <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Payment output inventory exceeds the mobile memory limit.")
        let next = try NativePaymentChecks.cursor(page)
        try PJ.require(next == nil || !cursors.contains(next!), "Repeated UTXO pagination cursor.")
        try PJ.require(next == nil || pages + 1 < Self.MAX_PAGES, "Invalid or oversized UTXO pagination.")
        try budget?.adjust(rows.count)
        var staged = [(String, JSONObject)](); staged.reserveCapacity(rows.count)
        do {
            for source in rows {
                var row = try JSON.clone(source); let key = try PJ.outpoint(row)
                try PJ.require(outputs.values[key] == nil, "Duplicate output across RPC pages. Refresh again.")
                row["index"] = ownedIndex; row["change"] = ownedChange; _ = try reservedView(row); staged.append((key,row))
            }
        } catch { try? budget?.adjust(-rows.count); throw error }
        let publish = {
            for (key,row) in staged { self.outputs.set(key,row) }; self.pages += 1; self.cursor = next
            if next == nil { self.isComplete = true; self.isReconciled = !self.journal } else { self.cursors.insert(next!) }
        }
        if let scope = budget { try scope.publish(0,publish) } else { publish() }
    }
    public func applyChanges(_ response: JSONObject) throws { try stageChanges(response,false).publish() }
    public func applySharedChanges(_ response: JSONObject) throws { try stageChanges(response,true).publish() }
    public static func applySharedChanges(_ inventories: [NativePaymentInventory], _ response: JSONObject) throws {
        try PJ.require(!inventories.isEmpty, "Missing shared payment inventory.")
        let scope = inventories[0].budget; var updates = [JournalUpdate](), delta = 0
        for inventory in inventories {
            try PJ.require(inventory.budget === scope, "Mismatched shared payment inventory budget.")
            let update = try inventory.stageChanges(response,true); updates.append(update); delta += update.delta
        }
        let publish = { updates.forEach { $0.commit() } }
        if let scope = scope { try scope.publish(delta,publish) } else { publish() }
    }
    private final class JournalUpdate {
        let owner: NativePaymentInventory, staged: OrderedOutputs, tip: JSONObject, through: Int64, last: Int64, next: String, more: Bool, events: Int
        init(_ owner: NativePaymentInventory, _ staged: OrderedOutputs, _ tip: JSONObject, _ through: Int64, _ last: Int64,
             _ next: String, _ more: Bool, _ events: Int) {
            self.owner = owner; self.staged = staged; self.tip = tip; self.through = through; self.last = last
            self.next = next; self.more = more; self.events = events
        }
        var delta: Int { staged.count - owner.outputs.count }
        func publish() throws { if let scope = owner.budget { try scope.publish(delta,commit) } else { commit() } }
        func commit() {
            owner.outputs = staged; owner.changePages += 1; owner.changeEvents += events
            owner.drainThrough = through; owner.drainTip = tip; owner.journalCursor = next; owner.changeCursors.insert(next)
            owner.sequence = more ? last : through
            if !more { owner.anchor = tip; owner.isReconciled = true }
        }
    }
    private func stageChanges(_ response: JSONObject, _ shared: Bool) throws -> JournalUpdate {
        try budget?.check()
        try PJ.require(journal && isComplete && !isReconciled && changePages < Self.MAX_CHANGE_PAGES, "Invalid payment journal state.")
        let tip = try Self.journalResponse(response), through = try PJ.integer(response["through_sequence"], 0, Self.maxSafeInteger)
        try PJ.require(PJ.integer(response["journal_epoch"], 0, Self.maxSafeInteger) == epoch, "Payment journal epoch changed. Review again.")
        try PJ.require(through >= sequence && (drainThrough < 0 || through == drainThrough), "Payment journal watermark changed during transfer.")
        if let frozen = drainTip { try NativePaymentChecks.sameTip(frozen,tip) }
        let changes = try PJ.objects(response["changes"]), more = try PJ.bool(response["has_more"])
        try PJ.require(!more || !changes.isEmpty, "Empty continuing payment journal page.")
        try PJ.require(!more || changePages + 1 < Self.MAX_CHANGE_PAGES, "Payment journal exceeds the page limit.")
        try PJ.require(changeEvents + changes.count <= Self.MAX_CHANGE_EVENTS, "Payment journal exceeds the event limit.")
        let next = try Self.requiredCursor(response)
        try PJ.require(!(more || !changes.isEmpty) || next != journalCursor, "Payment journal cursor did not advance.")
        try PJ.require(!changeCursors.contains(next) || next == journalCursor && !more && changes.isEmpty, "Repeated payment journal cursor.")
        var last = sequence, staged = outputs
        for event in changes {
            let eventSequence = try PJ.integer(event["sequence"], 0, Self.maxSafeInteger)
            try PJ.require(eventSequence > last && eventSequence <= through, "Invalid payment journal sequence or address.")
            // Group owner authenticates every event against the complete owned
            // address set before fanout. All members advance the same journal.
            if shared && event["address"] as? String != ownedAddress { last = eventSequence; continue }
            try PJ.require(event["address"] as? String == ownedAddress, "Invalid payment journal sequence or address.")
            let id = try PJ.hash(event["txid"]), kind = try PJ.string(event["kind"]), action = try PJ.string(event["action"])
            try PJ.require(["utxo","history"].contains(kind) && ["upsert","remove"].contains(action), "Invalid payment journal mutation.")
            let utxo = kind == "utxo", upsert = action == "upsert"
            var fields = ["sequence","address","kind","action","txid"]
            if utxo { fields.append("vout") }; if upsert { fields.append("item") }; try PJ.keys(event,fields)
            if utxo {
                let vout = try PJ.integer(event["vout"], 0, 0xffff_ffff), key = id + ":" + String(vout)
                if !upsert { staged.remove(key) }
                else {
                    var row = try PJ.object(event["item"])
                    _ = try NativePaymentChecks.utxos(["address":ownedAddress,"tip":tip,"unit":"connects","live":true,
                        "items":[row],"next_cursor":NSNull()],ownedAddress,tip)
                    try PJ.require(key == PJ.outpoint(row), "Payment journal item does not match its output.")
                    row["index"] = ownedIndex; row["change"] = ownedChange; _ = try reservedView(row); staged.set(key,row)
                }
            } else if upsert { try Self.validateHistory(PJ.object(event["item"]),id,tip) }
            last = eventSequence
        }
        try PJ.require(!more || last < through, "Invalid continuing payment journal watermark.")
        try PJ.require(staged.count <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Payment output inventory exceeds the mobile memory limit.")
        if !more {
            let height = try PJ.integer(tip["height"])
            for key in Array(staged.values.keys) {
                var row = staged.values[key]!, confirmations: Int64 = 0
                if try PJ.string(row["status"]) == "confirmed" {
                    let blockHeight = try PJ.integer(row["block_height"])
                    try PJ.require(blockHeight <= height, "Payment inventory contains outputs beyond its reconciled tip."); confirmations = height - blockHeight + 1
                }
                row["confirmations"] = confirmations; row["mature"] = try !PJ.bool(row["coinbase"]) || confirmations >= 100
                _ = try reservedView(row); staged.values[key] = row
            }
        }
        return JournalUpdate(self,staged,tip,through,last,next,more,changes.count)
    }
    private static func validateHistory(_ row: JSONObject, _ id: String, _ tip: JSONObject) throws {
        try PJ.keys(row,["txid","status","block_height","block_hash","received","spent","balance_delta","confirmations"])
        try PJ.require(id == PJ.hash(row["txid"]), "Payment journal history ID changed.")
        let received = try PJ.money(row,"received"), spent = try PJ.money(row,"spent"), delta = try PJ.string(row["balance_delta"])
        try PJ.require(PJ.matches(delta,"0|-?[1-9][0-9]{0,18}"), "Invalid payment journal history amount.")
        guard let value = Int64(delta), value >= -NativeTransactions.MAX_MONEY, value <= NativeTransactions.MAX_MONEY,
              received - spent == value else { throw WalletError("Invalid payment journal history total.") }
        let confirmations = try PJ.integer(row["confirmations"],0,Int64(Int32.max)+1)
        if try PJ.string(row["status"]) == "pending" {
            try PJ.require(PJ.null(row["block_height"]) && PJ.null(row["block_hash"]) && confirmations == 0, "Invalid payment journal history location.")
        } else {
            try PJ.require(PJ.string(row["status"]) == "confirmed", "Invalid payment journal history status.")
            let height = try PJ.integer(tip["height"]), block = try PJ.integer(row["block_height"],0,height); _ = try PJ.hash(row["block_hash"])
            try PJ.require(confirmations == height - block + 1, "Invalid payment journal history confirmations.")
        }
    }
    public func beginRefresh(_ reservations: JSONObject) throws {
        try budget?.check(); try PJ.require(journal && isReconciled, "Payment inventory is not ready for refresh.")
        let held = try JSON.clone(reservations); self.reservations = held; isReconciled = false
        changePages = 0; changeEvents = 0; drainThrough = -1; drainTip = nil; changeCursors = Set([journalCursor!])
    }
    public func discard() { budget?.close(); outputs = OrderedOutputs(); isComplete = false; isReconciled = false }
    public func address() -> String { ownedAddress }
    public func index() -> Int { ownedIndex }
    public func change() -> Int { ownedChange }
    public func journalEpoch() -> Int64 { epoch }
    public func throughSequence() -> Int64 { sequence }
    public func nextCursor() -> String? { cursor }
    public func changesCursor() -> String? { journalCursor }
    public func reconciled() -> Bool { isReconciled }
    public func complete() -> Bool { isComplete }
    public func rowCount() -> Int { outputs.count }
    public func pageCount() -> Int { pages }
    public func tip() throws -> JSONObject { try JSON.clone(anchor) }
    private func candidates(_ reserved: Bool) throws -> [JSONObject] {
        try requireComplete(); var rows = [JSONObject]()
        for key in outputs.orderedKeys {
            let row = try reservedView(outputs.values[key]!)
            if try PJ.bool(row["mature"]) && PJ.string(row["status"]) == "confirmed" && (Self.pendingSpender(row) != nil) == reserved { rows.append(row) }
        }; return rows
    }
    public func candidates() throws -> [JSONObject] { try candidates(false) }
    public func pendingCandidates() throws -> [JSONObject] { try candidates(true) }
    public func verifySelected(_ selected: [JSONObject], _ useAll: Bool, _ expectedAmount: String?) throws {
        try requireComplete()
        try PJ.require(!selected.isEmpty && selected.count <= NativeTransactions.MAX_PAYMENT_INPUTS, "Invalid selected payment input count.")
        var seen = Set<String>(), total: Int64 = 0
        for reviewed in selected {
            let key = try PJ.outpoint(reviewed)
            try PJ.require(seen.insert(key).inserted, "Duplicate selected payment input.")
            guard let source = outputs.values[key] else { throw WalletError("Selected payment funds changed or were spent. Review again.") }
            let fresh = try reservedView(source)
            try PJ.require(PJ.bool(fresh["mature"]) && PJ.string(fresh["status"]) == "confirmed", "Selected payment funds changed or were spent. Review again.")
            try PJ.require(PJ.bool(reviewed["mature"]) && PJ.string(reviewed["status"]) == "confirmed"
                && PJ.string(fresh["amount"]) == PJ.string(reviewed["amount"])
                && PJ.integer(reviewed["index"],0,Int64(Int32.max)) == Int64(ownedIndex)
                && PJ.integer(reviewed["change"],0,1) == Int64(ownedChange), "Selected payment input changed. Review again.")
            let spender = try Self.pendingSpender(fresh)
            try PJ.require(spender == Self.pendingSpender(reviewed) && (!useAll || spender == nil), "Selected payment reservation changed. Review again.")
            total = try PJ.add(total,PJ.money(fresh,"amount")); _ = try NativeTransactions.amount(String(total))
        }
        if useAll {
            var available: Int64 = 0
            for row in try candidates() { available = try PJ.add(available,PJ.money(row,"amount")); _ = try NativeTransactions.amount(String(available)) }
            let expected = try NativeTransactions.amount(expectedAmount ?? "")
            try PJ.require(available == expected && total == expected, "Available funds changed. Refresh the balance and use all again.")
        }
    }
}
