import Foundation

/// A host store must atomically and durably commit each write before returning.
/// It must serialize submission/recovery and treat unreadable storage as errors.
public protocol MobilePaymentBatchStore {
    func receipt() throws -> JSONObject?
    func reservations() throws -> JSONObject
    func saveReceipt(_ value: JSONObject) throws
    func saveReservations(_ value: JSONObject) throws
}
public protocol MobilePaymentBatchSender {
    func broadcast(_ hex: String) throws -> JSONObject
    /// True only with transport evidence that zero transaction bytes were sent.
    /// A timeout, cancellation, or server rejection is insufficient evidence.
    func provenNotSent(_ error: Error) -> Bool
}

/// Durable public journal for explicitly approved independent payments. There
/// is no automatic resume/retry: an uncertain outcome stops the whole batch.
public enum MobilePaymentBatch {
    public static let MAX_PARTS = 32, MAX_BYTES = 16 * 1024 * 1024
    public static let NOT_SENT = "not-sent", UNKNOWN = "check-required", SUBMITTED = "submitted"
    private static let receiptKeys = ["version", "batch", "batchId", "walletId", "address", "requestedTotal", "total", "fee", "inputTotal", "change", "acknowledged", "transactions"]
    private static let partKeys = ["txid", "hex", "status", "amount", "fee", "selected"]

    public static func submit(_ walletId: String, _ address: String, _ batchPlan: JSONObject, _ signed: [JSONObject], store: MobilePaymentBatchStore, sender: MobilePaymentBatchSender, check: () throws -> Void = {}) throws -> JSONObject {
        try check()
        if let old = try store.receipt() { try validate(old); try PJ.require(PJ.bool(old["acknowledged"]), "Review and dismiss the earlier batch receipt before another payment.") }
        var receipt = try create(walletId, address, batchPlan, signed)
        let previous = try store.reservations(); try NativePaymentReservations.validate(previous); var held = previous, parts = try PJ.objects(receipt["transactions"])
        for part in parts {
            let selected = try PJ.objects(part["selected"])
            for input in selected { try PJ.require(previous[PJ.outpoint(input)] == nil, "Batch funding was reserved by another payment. Review again.") }
            held = try NativePaymentReservations.reserve(held, selected, PJ.string(part["txid"]))
        }
        try check(); try store.saveReceipt(receipt); try store.saveReservations(held)
        for i in parts.indices {
            do { try check() } catch { return try stop(receipt, previous, store, -1) }
            parts[i]["status"] = UNKNOWN; receipt["transactions"] = parts
            do { try store.saveReceipt(receipt) }
            catch { parts[i]["status"] = NOT_SENT; receipt["transactions"] = parts; return try stop(receipt, previous, store, i) }
            do {
                let sent = try sender.broadcast(PJ.string(parts[i]["hex"]))
                if (sent["txid"] as? String) != (parts[i]["txid"] as? String) { return try stop(receipt, previous, store, -1) }
            } catch {
                let unsent = sender.provenNotSent(error)
                if unsent { parts[i]["status"] = NOT_SENT; receipt["transactions"] = parts }
                return try stop(receipt, previous, store, unsent ? i : -1)
            }
            parts[i]["status"] = SUBMITTED; receipt["transactions"] = parts
            do { try store.saveReceipt(receipt) }
            catch { parts[i]["status"] = UNKNOWN; receipt["transactions"] = parts; return try stop(receipt, previous, store, -1) }
        }; return try summary(receipt)
    }
    private static func stop(_ source: JSONObject, _ previous: JSONObject, _ store: MobilePaymentBatchStore, _ uncertainOnFailure: Int) throws -> JSONObject {
        var receipt = source
        do { try store.saveReceipt(receipt) }
        catch {
            if uncertainOnFailure >= 0 { var parts = try PJ.objects(receipt["transactions"]); parts[uncertainOnFailure]["status"] = UNKNOWN; receipt["transactions"] = parts }
            return try summary(receipt)
        }
        do {
            var held = try store.reservations()
            for part in try PJ.objects(receipt["transactions"]) where (part["status"] as? String) == NOT_SENT { held = try NativePaymentReservations.releaseNotSent(held, PJ.string(part["txid"]), previous) }
            try store.saveReservations(held)
        } catch { /* Failed cleanup conservatively leaves reservations held. */ }
        return try summary(receipt)
    }
    public static func create(_ walletId: String, _ address: String, _ plan: JSONObject, _ signed: [JSONObject]) throws -> JSONObject {
        let plans = try PJ.objects(plan["plans"]); try PJ.require((2...MAX_PARTS).contains(plans.count) && plans.count == signed.count, "Invalid batch transaction count.")
        var receipt: JSONObject = ["version": 1, "batch": true, "batchId": UUID().uuidString.lowercased(), "walletId": walletId, "address": address, "acknowledged": false]
        for key in ["requestedTotal", "total", "fee", "inputTotal", "change"] { receipt[key] = try PJ.string(plan[key]) }
        var parts = [JSONObject](); var inputTotal: Int64 = 0
        for (i, partPlan) in plans.enumerated() {
            let transaction = signed[i]; try PJ.require(PJ.string(partPlan["fee"]) == PJ.string(transaction["fee"]), "Signed batch fee differs from its approved plan.")
            let selected = try PJ.objects(partPlan["selected"]); var outpoints = [JSONObject](); var partInput: Int64 = 0
            for row in selected { partInput = try PJ.add(partInput, PJ.money(row, "amount")); outpoints.append(try ["txid": PJ.string(row["txid"]), "vout": PJ.integer(row["vout"])] ) }
            let tx = try NativeTransactions.parse(PJ.string(transaction["hex"])); var outputTotal: Int64 = 0
            for output in try PJ.objects(tx["outputs"]) { outputTotal = try PJ.add(outputTotal, PJ.money(output, "amount")) }
            try PJ.require(partInput == PJ.add(outputTotal, PJ.money(partPlan, "fee")), "Batch fee differs from its approved funding inputs."); inputTotal = try PJ.add(inputTotal, partInput)
            parts.append(try ["txid": PJ.string(transaction["txid"]), "hex": PJ.string(transaction["hex"]), "status": NOT_SENT, "amount": PJ.string(partPlan["total"]), "fee": PJ.string(partPlan["fee"]), "selected": outpoints])
        }
        try PJ.require(inputTotal == PJ.money(plan, "inputTotal"), "Batch input total differs from its approved funding inputs."); receipt["transactions"] = parts; try validate(receipt); return receipt
    }
    public static func read(_ data: Data) throws -> JSONObject { let receipt = try JSON.decode(data, maxBytes: MAX_BYTES); try validate(receipt); return receipt }
    public static func validate(_ receipt: JSONObject) throws {
        try PJ.keys(receipt, receiptKeys)
        try PJ.require(PJ.integer(receipt["version"]) == 1 && PJ.bool(receipt["batch"]), "Invalid batch receipt version."); _ = try PJ.bool(receipt["acknowledged"])
        try PJ.require(PJ.matches(PJ.string(receipt["batchId"]), "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"), "Invalid batch receipt identifier.")
        for key in ["walletId", "address"] { let address = try PJ.string(receipt[key]); try PJ.require(!address.isEmpty && address.utf8.count <= 128, "Invalid batch wallet or recipient address."); _ = try WalletCrypto.decodeAddress(address) }
        let requested = try PJ.money(receipt, "requestedTotal"), total = try PJ.money(receipt, "total"), fee = try PJ.money(receipt, "fee"), inputTotal = try PJ.money(receipt, "inputTotal"), change = try PJ.money(receipt, "change")
        try PJ.require(requested > 0 && total > 0 && fee <= NativeTransactions.COIN && inputTotal == PJ.add(PJ.add(total, fee), change) && (requested == total || requested >= PJ.add(total, fee)), "Invalid batch receipt totals.")
        let parts = try PJ.objects(receipt["transactions"]); try PJ.require((2...MAX_PARTS).contains(parts.count), "Invalid batch receipt transaction count.")
        var txids = Set<String>(), inputs = Set<String>(); var partTotal: Int64 = 0, partFee: Int64 = 0, partChange: Int64 = 0, inputCount = 0, stopped = false
        let publicKey = try WalletCrypto.hex(WalletCrypto.decodeAddress(PJ.string(receipt["address"])))
        for part in parts {
            try PJ.keys(part, partKeys); let txid = try PJ.hash(part["txid"]), hex = try PJ.string(part["hex"]), status = try PJ.string(part["status"])
            try PJ.require(txids.insert(txid).inserted, "Invalid or duplicate batch transaction ID.")
            try PJ.require(!hex.isEmpty && hex.utf8.count <= 800_000 && hex.utf8.count % 2 == 0 && hex.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }, "Invalid signed batch transaction bytes.")
            try PJ.require([SUBMITTED, UNKNOWN, NOT_SENT].contains(status), "Invalid batch transaction status."); try PJ.require(!stopped || status == NOT_SENT, "Invalid batch submission order."); if status != SUBMITTED { stopped = true }
            let tx = try NativeTransactions.parse(hex); try PJ.require(txid == NativeTransactions.txid(tx), "Batch transaction ID does not match its signed bytes.")
            try PJ.require(NativeTransactions.serialize(tx, false).count * 3 + hex.utf8.count / 2 <= NativeTransactions.MAX_WEIGHT, "Batch transaction exceeds standard weight.")
            let selected = try PJ.objects(part["selected"]), txInputs = try PJ.objects(tx["inputs"]), outputs = try PJ.objects(tx["outputs"])
            try PJ.require(!selected.isEmpty && selected.count <= NativeTransactions.MAX_PAYMENT_INPUTS && selected.count == txInputs.count, "Invalid batch payment inputs.")
            inputCount += selected.count; try PJ.require(inputCount <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Batch inputs exceed the native wallet limit.")
            for (j, row) in selected.enumerated() {
                try PJ.keys(row, ["txid", "vout"]); let txInput = txInputs[j], key = try PJ.outpoint(row)
                try PJ.require(key == PJ.outpoint(txInput) && inputs.insert(key).inserted, "Batch transactions must have disjoint approved inputs.")
                let witness = try PJ.array(txInput["witness"])
                try PJ.require(PJ.string(txInput["scriptSig"]).isEmpty && witness.count == 1 && PJ.matches(PJ.string(witness[0]), "[0-9a-f]{128}"), "Missing native payment signature.")
            }
            let amount = try PJ.money(part, "amount"), cost = try PJ.money(part, "fee")
            try PJ.require(amount > 0 && cost <= NativeTransactions.COIN && (1...2).contains(outputs.count), "Invalid batch payment amounts or outputs.")
            let recipient = outputs[0]
            try PJ.require(PJ.integer(recipient["type"]) == 1 && publicKey == PJ.string(recipient["publicKey"]) && amount == PJ.money(recipient, "amount"), "Batch recipient differs from its approved payment.")
            if outputs.count == 2 { try PJ.require(PJ.integer(outputs[1]["type"]) == 1, "Invalid batch change output."); partChange = try PJ.add(partChange, PJ.money(outputs[1], "amount")) }
            partTotal = try PJ.add(partTotal, amount); partFee = try PJ.add(partFee, cost)
        }
        for key in inputs { try PJ.require(!txids.contains(String(key.prefix(64))), "Batch transactions cannot depend on each other.") }
        try PJ.require(partTotal == total && partFee == fee && partChange == change, "Batch receipt subtotals changed.")
        try PJ.require(PJ.data(receipt).count <= MAX_BYTES, "Batch receipt exceeds its safe storage limit.")
    }
    /// Only this explicit allowlist may cross the renderer bridge.
    public static func summary(_ receipt: JSONObject) throws -> JSONObject {
        try validate(receipt); var transactions = [JSONObject](); let parts = try PJ.objects(receipt["transactions"]); var submitted = 0, unknown = false
        for part in parts {
            let status = try PJ.string(part["status"]); if status == SUBMITTED { submitted += 1 }; if status == UNKNOWN { unknown = true }
            transactions.append(try ["txid": PJ.string(part["txid"]), "status": status, "amount": PJ.string(part["amount"]), "fee": PJ.string(part["fee"])])
        }
        let status = unknown ? UNKNOWN : submitted == parts.count ? SUBMITTED : submitted > 0 ? "partial" : NOT_SENT
        var summary: JSONObject = ["batch": true, "status": status, "transactionCount": parts.count, "submittedCount": submitted, "transactions": transactions]
        for key in ["batchId", "walletId", "address", "requestedTotal", "total", "fee"] { summary[key] = try PJ.string(receipt[key]) }; return summary
    }
    public static func pendingSummary(_ receipt: JSONObject?) throws -> JSONObject? {
        guard let receipt else { return nil }; try validate(receipt); return try PJ.bool(receipt["acknowledged"]) ? nil : summary(receipt)
    }
    /// Crash recovery removes exact matching holds only for durable NOT_SENT
    /// parts. The host excludes active submissions while committing the result.
    public static func reconcileNotSent(_ receipt: JSONObject, _ reservations: JSONObject) throws -> JSONObject {
        try validate(receipt); try NativePaymentReservations.validate(reservations); var held = reservations
        for part in try PJ.objects(receipt["transactions"]) where (part["status"] as? String) == NOT_SENT {
            let txid = try PJ.string(part["txid"])
            for input in try PJ.objects(part["selected"]) { let key = try PJ.outpoint(input); if held[key] as? String == txid { held.removeValue(forKey: key) } }
        }; return held
    }
    public static func acknowledge(_ receipt: JSONObject, _ batchId: String) throws -> JSONObject {
        try validate(receipt); try PJ.require(PJ.string(receipt["batchId"]) == batchId, "The batch receipt changed. Review it again.")
        var result = receipt; result["acknowledged"] = true; return result
    }
}
