import Foundation

/// Immutable renderer address filter. Derivation paths and balances are always
/// resolved from the native wallet, never accepted from this intent.
public struct NativeFundingScope {
    public static let MAX_ADDRESSES = 10_000
    private let addresses: Set<String>
    public static func optional(_ input: JSONObject) throws -> NativeFundingScope? {
        guard let value = input["fundingAddresses"] else { return nil }
        let requested = try PJ.array(value); try PJ.require((1...MAX_ADDRESSES).contains(requested.count), "Select between 1 and 10000 wallet funding addresses.")
        var addresses = Set<String>()
        for row in requested {
            let address = try PJ.string(row)
            try PJ.require(address.utf8.count == 62 && PJ.matches(address, "cc1p[023456789acdefghjklmnpqrstuvwxyz]{58}") && addresses.insert(address).inserted, "Duplicate or noncanonical payment funding address.")
        }
        return NativeFundingScope(addresses: addresses)
    }
    public func select(_ nativeAccounts: [JSONObject]) throws -> [JSONObject] {
        try PJ.require((1...Self.MAX_ADDRESSES).contains(nativeAccounts.count), "Invalid native wallet address set.")
        var remaining = addresses, seen = Set<String>(), selected = [JSONObject]()
        for account in nativeAccounts { let address = try PJ.string(account["address"]); try PJ.require(seen.insert(address).inserted, "Duplicate native wallet address."); if remaining.remove(address) != nil { selected.append(account) } }
        try PJ.require(remaining.isEmpty, "Payment funding address is outside the current native wallet."); return selected
    }
}

public enum NativeSendPolicy {
    public static func request(_ input: JSONObject) throws -> Request {
        try PJ.keys(input, ["address", "amount", "feeRate", "subtractFeeFromAmount", "useAllBalance"] + (input["fundingAddresses"] == nil ? [] : ["fundingAddresses"]))
        let rate = try PJ.string(input["feeRate"]); try PJ.require(PJ.matches(rate, "[1-9][0-9]{0,5}"), "Fee rate must be 1,201–100,000 connects/vbyte.")
        guard let feeRate = Int(rate) else { throw WalletError("Invalid payment fee rate.") }; try NativeTransactions.feeRate(feeRate)
        let deduct = try PJ.bool(input["subtractFeeFromAmount"]), useAll = try PJ.bool(input["useAllBalance"])
        try PJ.require(!useAll || deduct, "Use all balance requires deducting the fee from the payment.")
        let request = try Request(address: WalletCrypto.encodeAddress(WalletCrypto.decodeAddress(PJ.string(input["address"]))), amount: String(NativeTransactions.coinAmount(PJ.string(input["amount"]))), feeRate: feeRate, subtractFeeFromAmount: deduct, useAllBalance: useAll, fundingScope: NativeFundingScope.optional(input))
        _ = try NativeTransactions.recipient(request.destination()); return request
    }
    public struct Request {
        public let address: String, amount: String, feeRate: Int, subtractFeeFromAmount: Bool, useAllBalance: Bool, fundingScope: NativeFundingScope?
        public func destination() -> JSONObject { ["address": address, "amount": amount] }
        private func verifyAvailable(_ candidates: [JSONObject]) throws {
            if !useAllBalance { return }; var available: Int64 = 0
            for candidate in candidates {
                try PJ.require(PJ.bool(candidate["mature"]) && PJ.string(candidate["status"]) == "confirmed" && PJ.null(candidate["pending_spent_by"]), "Use all balance cannot include immature, pending or reserved funds. Refresh the balance and try again.")
                available = try PJ.add(available, PJ.money(candidate, "amount"))
            }
            try PJ.require(String(available) == amount, "Available funds changed or are reserved by pending or uncertain payments. Refresh the balance and use all again.")
        }
        public func plan(_ candidates: [JSONObject], _ changeAddress: String) throws -> JSONObject { try verifyAvailable(candidates); return try NativeTransactions.planPayment(candidates, [destination()], changeAddress, feeRate, subtractFeeFromAmount) }
        public func verifyPlan(_ plan: JSONObject, _ changeAddress: String) throws {
            let expected = try self.plan(PJ.objects(plan["selected"]), changeAddress)
            for field in ["fee", "total", "requestedTotal", "inputTotal", "change", "vsize"] { try PJ.require(PJ.equal(expected[field], plan[field]), "Payment review changed. Review again.") }
            try PJ.require(NativeTransactions.serialize(PJ.object(expected["transaction"])) == NativeTransactions.serialize(PJ.object(plan["transaction"])), "Payment destination, fee or change changed. Review again.")
            if useAllBalance { try PJ.require(amount == PJ.string(plan["inputTotal"]) && PJ.string(plan["change"]) == "0", "Available funds changed. Refresh the balance and use all again.") }
        }
        public func review(_ plan: JSONObject, _ changeAddress: String) throws -> String {
            try verifyPlan(plan, changeAddress)
            let requested = try NativeTransactions.amount(amount), received = try PJ.money(plan, "total"), fee = try PJ.money(plan, "fee"), change = try PJ.money(plan, "change")
            let adjustment = subtractFeeFromAmount ? requested - received - fee : 0
            var text = "MAINNET\n\nTo: " + address
            text += try "\nEntered amount: \(NativeTransactions.format(requested)) CONN\nRecipient receives: \(NativeTransactions.format(received)) CONN"
            text += try "\nMining fee (\(subtractFeeFromAmount ? "deducted" : "added")): \(NativeTransactions.format(fee)) CONN\nFee rate: \(feeRate) connects/vbyte"
            if adjustment > 0 { text += try "\nKept as spendable change: \(NativeTransactions.format(adjustment)) CONN" }
            text += try "\nTotal paid: \(NativeTransactions.format(PJ.add(received, fee))) CONN\nSelected input total: \(NativeTransactions.format(PJ.money(plan, "inputTotal"))) CONN\nChange: \(NativeTransactions.format(change)) CONN\nWallet change address: \(changeAddress)"
            if useAllBalance { text += "\n\nUsing all currently available confirmed funds" + (fundingScope == nil ? "" : " in the selected address scope") + ", with the fee deducted. Immature, pending and reserved funds are excluded." }
            return text
        }
    }
}

public enum NativeP2CPolicy {
    public static func request(_ input: JSONObject) throws -> Request {
        try PJ.keys(input, ["domain", "amount", "expectedConnections"] + (input["fundingAddresses"] == nil ? [] : ["fundingAddresses"]))
        let raw = try PJ.string(input["domain"]); try PJ.require(raw.utf8.count <= 1024, "Domain is too long.")
        try PJ.require(PJ.matches(raw, "[\\x09-\\x0d\\x20-\\x7e]+"), "Use an ASCII public domain or punycode, not a URL.")
        let domain = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        try PJ.require(NativeTransactions.canonicalDomain(domain) && domain.contains("."), "Use an ASCII public domain or punycode, not a URL.")
        let tld = String(domain.split(separator: ".").last ?? "")
        try PJ.require(!PJ.matches(tld, "[0-9]+"), "Use a public domain, not an IP address.")
        try PJ.require(!["localhost", "local", "localdomain", "internal", "test", "invalid", "onion"].contains(tld) && domain != "home.arpa" && !domain.hasSuffix(".home.arpa"), "Use a public Internet domain.")
        let expected = try PJ.string(input["expectedConnections"]); _ = try PaymentTarget.target(expected)
        let result = try Request(domain: domain, amount: String(NativeTransactions.coinAmount(PJ.string(input["amount"]))), expectedConnections: expected, rsaProbeStatus: "unavailable", fundingScope: NativeFundingScope.optional(input))
        _ = try NativeTransactions.recipient(result.destination()); return result
    }
    public struct Request {
        public let domain: String, amount: String, expectedConnections: String, rsaProbeStatus: String, fundingScope: NativeFundingScope?
        public var signatureMask: Int { rsaProbeStatus == "verified" ? 6 : 7 }
        public func withProbe(_ status: String) -> Request { Request(domain: domain, amount: amount, expectedConnections: expectedConnections, rsaProbeStatus: ["verified", "timeout", "busy", "unavailable"].contains(status) ? status : "failed", fundingScope: fundingScope) }
        public func destination() -> JSONObject { ["domain": domain, "amount": amount, "expectedConnections": expectedConnections, "mask": signatureMask] }
        public func verifyPlan(_ plan: JSONObject, _ changeAddress: String) throws {
            let recipient = try NativeTransactions.recipient(destination()), outputs = try PJ.objects(PJ.object(plan["transaction"])["outputs"])
            try PJ.require((1...2).contains(outputs.count) && PJ.equal(outputs[0], recipient), "Bounty review changed. Review again.")
            try PJ.require(amount == PJ.string(plan["total"]) && amount == PJ.string(plan["requestedTotal"]), "Bounty reward changed. Review again.")
            let change = try PJ.money(plan, "change"); try PJ.require((change > 0) == (outputs.count == 2), "Bounty change changed. Review again.")
            if change > 0 {
                let returned = outputs[1]; try PJ.require(returned.count == 3 && PJ.integer(returned["type"]) == 1 && String(change) == PJ.string(returned["amount"]) && WalletCrypto.hex(WalletCrypto.decodeAddress(changeAddress)) == PJ.string(returned["publicKey"]), "Bounty change changed. Review again.")
            }
            let fee = try PJ.money(plan, "fee"); try PJ.require(fee <= NativeTransactions.COIN && PJ.add(PJ.add(NativeTransactions.amount(amount), change), fee) == PJ.money(plan, "inputTotal"), "Bounty totals changed. Review again.")
        }
        public func review(_ plan: JSONObject, _ changeAddress: String) throws -> String {
            try verifyPlan(plan, changeAddress)
            let signatures = signatureMask == 6 ? "RSA-PSS-RSAE / SHA-256 and RSA-PSS-PSS / SHA-256 only (mask 6)" : "ECDSA P-256 / SHA-256, RSA-PSS-RSAE / SHA-256 and RSA-PSS-PSS / SHA-256 (mask 7)"
            return try "MAINNET — CREATE PUBLIC P2C BOUNTY\n\nDomain: \(domain)\nPublic reward: \(NativeTransactions.format(NativeTransactions.amount(amount))) CONN\nExpected connections: \(expectedConnections) (statistical average, not a guaranteed number of attempts)\nAllowed signatures: \(signatures)\nCertificate roots: version 1\n\(probeDescription())\nMining fee: \(NativeTransactions.format(PJ.money(plan, "fee"))) CONN\nChange: \(NativeTransactions.format(PJ.money(plan, "change"))) CONN\nWallet change address: \(changeAddress)\n\nThis creates a public bounty, not a payment to the domain owner. Anyone who submits a valid qualifying proof can claim the reward. Creating it spends your coins and cannot be undone."
        }
        private func probeDescription() -> String {
            if signatureMask == 6 { return "RSA support verified with one authenticated TLS 1.3 connection. This checks one server now, not every server or future availability." }
            let reason = rsaProbeStatus == "timeout" ? "The RSA check timed out." : rsaProbeStatus == "busy" ? "The RSA checker is busy." : rsaProbeStatus == "unavailable" ? "The RSA checker is unavailable." : "The RSA check did not verify support."
            return reason + " RSA support is unconfirmed. All supported signature schemes remain allowed; this does not mean the domain cannot be claimed."
        }
    }
}
