import Foundation

/// The durable single-payment file contains public signed bytes only. Startup
/// validates it before showing an outcome or allowing a new payment review.
public enum MobilePaymentReceipt {
    public static let MAX_BYTES = 1024 * 1024
    public static func read(_ data: Data) throws -> JSONObject {
        let receipt = try JSON.decode(data, maxBytes: MAX_BYTES); try validate(receipt); return receipt
    }
    public static func validate(_ receipt: JSONObject) throws {
        try PJ.keys(receipt, ["hex", "txid", "fee"] + (receipt["broadcast_status"] == nil ? [] : ["broadcast_status"]))
        let hex = try PJ.string(receipt["hex"]), id = try PJ.hash(receipt["txid"])
        try PJ.require(!hex.isEmpty && hex.utf8.count <= 800_000 && hex.utf8.count % 2 == 0 && hex.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }, "Invalid saved payment bytes.")
        let fee = try PJ.money(receipt, "fee"); try PJ.require(fee <= NativeTransactions.COIN, "Invalid saved payment fee.")
        if let value = receipt["broadcast_status"] { try PJ.require(["not-sent", "check-required", "submitted"].contains(PJ.string(value)), "Invalid saved payment outcome.") }
        let transaction = try NativeTransactions.parse(hex), inputs = try PJ.objects(transaction["inputs"]), outputs = try PJ.objects(transaction["outputs"])
        try PJ.require(NativeTransactions.txid(transaction) == id, "Saved payment ID differs from its signed bytes.")
        try PJ.require(!inputs.isEmpty && inputs.count <= NativeTransactions.MAX_PAYMENT_INPUTS && (1...2).contains(outputs.count), "Invalid saved payment size.")
        try PJ.require(NativeTransactions.serialize(transaction, false).count * 3 + hex.utf8.count / 2 <= NativeTransactions.MAX_WEIGHT, "Saved payment exceeds standard weight.")
        for input in inputs {
            let witness = try PJ.array(input["witness"])
            try PJ.require(PJ.string(input["scriptSig"]).isEmpty && witness.count == 1 && PJ.matches(PJ.string(witness[0]), "[0-9a-f]{128}"), "Missing saved native payment signature.")
        }
        try PJ.require(PJ.data(receipt).count <= MAX_BYTES, "Saved payment exceeds its storage limit.")
    }
    /// Only a durable NOT_SENT marker proves that retrying does not duplicate
    /// this operation. Other saved records remain visible for inspection.
    public static func summary(_ receipt: JSONObject) throws -> JSONObject {
        try validate(receipt)
        return try ["txid": PJ.string(receipt["txid"]), "status": (receipt["broadcast_status"] as? String) == "not-sent" ? "not-sent" : "check-required"]
    }
}
