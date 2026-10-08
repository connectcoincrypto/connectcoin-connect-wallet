import Foundation

/// Mainnet RPC schemas validated before public data enters native selection.
public enum NativePaymentChecks {
    public static let GENESIS = "30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e"
    private static let changed = "Invalid or changed mainnet payment data. Refresh and review again."
    public static func tip(_ value: JSONObject) throws -> JSONObject {
        try PJ.keys(value, ["chain", "genesis_hash", "height", "hash", "mediantime"])
        try PJ.require(PJ.string(value["chain"]) == "main" && PJ.string(value["genesis_hash"]) == GENESIS, changed)
        let height = try PJ.integer(value["height"], 0, Int64(Int32.max)), block = try PJ.hash(value["hash"])
        _ = try PJ.integer(value["mediantime"], 0, 0xffff_ffff); try PJ.require(height != 0 || block == GENESIS, changed); return value
    }
    public static func sameTip(_ first: JSONObject, _ second: JSONObject) throws {
        let a = try tip(first), b = try tip(second)
        for field in ["hash", "height", "mediantime"] { try PJ.require(PJ.equal(a[field], b[field]), changed) }
    }
    public static func utxos(_ page: JSONObject, _ address: String, _ anchor: JSONObject) throws -> [JSONObject] {
        try PJ.keys(page, ["address", "tip", "unit", "live", "items", "next_cursor"])
        try PJ.require(PJ.string(page["address"]) == address && PJ.string(page["unit"]) == "connects" && PJ.bool(page["live"]), changed)
        _ = try WalletCrypto.decodeAddress(address); try sameTip(anchor, PJ.object(page["tip"]))
        let rows = try PJ.objects(page["items"]); try PJ.require(rows.count <= 500, changed); var seen = Set<String>()
        let next = try cursor(page); try PJ.require(next == nil || !rows.isEmpty, changed)
        let height = try PJ.integer(anchor["height"], 0, Int64(Int32.max))
        for row in rows {
            try PJ.keys(row, ["txid", "vout", "amount", "block_height", "status", "confirmations", "coinbase", "mature", "pending_spent_by"])
            try PJ.require(seen.insert(PJ.outpoint(row)).inserted, changed); _ = try PJ.money(row, "amount")
            let coinbase = try PJ.bool(row["coinbase"]), mature = try PJ.bool(row["mature"]), confirmations = try PJ.integer(row["confirmations"], 0, Int64(Int32.max) + 1)
            if try PJ.string(row["status"]) == "pending" { try PJ.require(PJ.null(row["block_height"]) && confirmations == 0 && !coinbase && mature, changed) }
            else { try PJ.require(PJ.string(row["status"]) == "confirmed", changed); let blockHeight = try PJ.integer(row["block_height"], 0, height); try PJ.require(confirmations == height - blockHeight + 1 && mature == (!coinbase || confirmations >= 100), changed) }
            if !PJ.null(row["pending_spent_by"]) { _ = try PJ.hash(row["pending_spent_by"]) }
        }; return rows
    }
    public static func cursor(_ page: JSONObject) throws -> String? {
        try PJ.require(page["next_cursor"] != nil, changed); if PJ.null(page["next_cursor"]) { return nil }
        let cursor = try PJ.string(page["next_cursor"]); try PJ.require(cursor.utf8.count <= 1024 && PJ.matches(cursor, "[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"), changed); return cursor
    }
    public static func transactions(_ response: JSONObject, _ requested: [String], _ anchor: JSONObject) throws -> [JSONObject] {
        try PJ.keys(response, ["tip", "transactions", "remaining"]); try sameTip(anchor, PJ.object(response["tip"]))
        return try checkedTransactions(response, requested, false, {})
    }
    public static func fundingTransactions(_ response: JSONObject, _ requested: [String], check: () throws -> Void = {}) throws -> [JSONObject] {
        try PJ.keys(response, ["tip", "transactions", "remaining"]); _ = try tip(PJ.object(response["tip"]))
        return try checkedTransactions(response, requested, true, check)
    }
    private static func checkedTransactions(_ response: JSONObject, _ requested: [String], _ stripped: Bool, _ check: () throws -> Void) throws -> [JSONObject] {
        try check(); try PJ.require((1...32).contains(requested.count), changed); var ids = Set<String>()
        for id in requested { try PJ.require(ids.insert(PJ.hash(id)).inserted, changed) }
        let transactions = try PJ.objects(response["transactions"]), remaining = try PJ.array(response["remaining"])
        try PJ.require(!transactions.isEmpty && transactions.count + remaining.count == requested.count, changed)
        for (i, id) in remaining.enumerated() { try PJ.require(requested[i + transactions.count] == PJ.hash(id), changed) }
        var count = 0, result = [JSONObject]()
        for (i, item) in transactions.enumerated() {
            try check(); try PJ.keys(item, ["txid", "hex"]); try PJ.require(requested[i] == PJ.hash(item["txid"]), changed)
            let hex = try PJ.string(item["hex"]); count += hex.utf8.count
            try PJ.require(count <= 8_000_000 && hex.utf8.count >= 20 && hex.utf8.count % 2 == 0, changed)
            let transaction = try NativeTransactions.parse(hex); try PJ.require(NativeTransactions.txid(transaction) == PJ.string(item["txid"]), changed)
            if stripped { result.append(try ["txid": PJ.string(item["txid"]), "hex": WalletCrypto.hex(NativeTransactions.serialize(transaction, false))]) }
        }; try check(); return stripped ? result : transactions
    }
}

/// Durable public outpoint holds. Unknown submissions remain held across wallet
/// changes and app restarts; the core never evicts old reservations.
public enum NativePaymentReservations {
    public static let MAX_ENTRIES = 50_000, MAX_BYTES = 8 * 1024 * 1024
    public static func read(_ data: Data) throws -> JSONObject {
        let value = try JSON.decode(data, maxBytes: MAX_BYTES); try validate(value); return value
    }
    public static func validate(_ held: JSONObject) throws {
        try PJ.require(held.count <= MAX_ENTRIES, "Too many saved payment reservations. Check earlier transactions before continuing.")
        for (key, value) in held {
            try PJ.require(PJ.matches(key, "[0-9a-f]{64}:(0|[1-9][0-9]{0,9})"), "Invalid payment reservations. Do not retry an earlier payment blindly.")
            guard let index = UInt64(key.dropFirst(65)), index <= 0xffff_ffff else { throw WalletError("Invalid payment reservation index.") }
            _ = try PJ.hash(value)
        }
    }
    public static func reserve(_ existing: JSONObject, _ selected: [JSONObject], _ txid: String) throws -> JSONObject {
        try validate(existing); try PJ.require(!selected.isEmpty && selected.count <= NativeTransactions.MAX_PAYMENT_INPUTS, "Invalid payment reservation."); _ = try PJ.hash(txid)
        var held = existing; for row in selected { held[try PJ.outpoint(row)] = txid }; try validate(held)
        try PJ.require(PJ.data(held).count <= MAX_BYTES, "Payment reservations exceed the safe storage limit. Do not retry an uncertain payment."); return held
    }
    /// Call only with proof of zero transmitted transaction bytes and the exact
    /// snapshot taken before reserve. Restores older replacement reservations.
    public static func releaseNotSent(_ existing: JSONObject, _ txid: String, _ previous: JSONObject) throws -> JSONObject {
        _ = try PJ.hash(txid); try validate(existing); try validate(previous); var held = existing
        for (key, value) in existing where (value as? String) == txid { if let old = previous[key] { held[key] = old } else { held.removeValue(forKey: key) } }; return held
    }
}
