import Foundation

/// Independent payments spend disjoint original funding; they never spend an
/// earlier part's change. Only a standard-weight error permits splitting.
public enum NativeSendBatch {
    public static let MAX_TRANSACTIONS = 32
    private static let uneconomic = "These inputs cannot form economical independent payments. Enter a smaller amount or use different funding."
    private struct Candidate { let metadata: JSONObject, value: Int64, order: Int }
    private struct Slice { let start: Int, end: Int, contribution: Int64 }
    private enum Outcome { case fits, oversized, uneconomic, insufficient }
    private struct FinalSlice { let outcome: Outcome, start: Int, end: Int }
    private final class SearchBudget {
        var remaining = 8_000_000
        func step() throws { remaining -= 1; try PJ.require(remaining >= 0, "Payment requires too much input rebalancing. Enter a smaller amount or use different funding.") }
    }
    public static func plan(_ request: NativeSendPolicy.Request, _ candidates: [JSONObject], _ changeAddress: String) throws -> JSONObject {
        do { return try aggregate(request, [request.plan(candidates, changeAddress)]) }
        catch is NativeTransactions.PaymentTooLarge { return try multiple(request, candidates, changeAddress) }
    }
    private static func multiple(_ request: NativeSendPolicy.Request, _ candidates: [JSONObject], _ changeAddress: String) throws -> JSONObject {
        var sorted = [Candidate]()
        for (i, candidate) in candidates.enumerated() {
            try PJ.require(PJ.bool(candidate["mature"]) && PJ.string(candidate["status"]) == "confirmed" && PJ.null(candidate["pending_spent_by"]), "Multiple payments require confirmed, mature, unreserved original inputs. Pending replacements cannot be split.")
            sorted.append(try Candidate(metadata: candidate, value: PJ.money(candidate, "amount"), order: i))
        }
        sorted.sort { $0.value == $1.value ? $0.order < $1.order : $0.value > $1.value }
        var prefix = [Int64](repeating: 0, count: sorted.count + 1)
        for i in sorted.indices { prefix[i + 1] = try PJ.add(prefix[i], sorted[i].value) }
        let requested = try NativeTransactions.amount(request.amount); try PJ.require(!request.useAllBalance || prefix[sorted.count] == requested, "Available funds changed. Refresh the balance and use all again.")
        let recipient = try NativeTransactions.recipient(request.destination())
        let change: JSONObject = try ["type": 1, "amount": "0", "publicKey": WalletCrypto.hex(WalletCrypto.decodeAddress(changeAddress))]
        let size = try NativeTransactions.PaymentSize([recipient], change), dust = try NativeTransactions.dust(recipient), changeDust = try NativeTransactions.dust(change)
        var slices = [Slice](); let budget = SearchBudget(); var start = 0, nextLimit = NativeTransactions.MAX_PAYMENT_INPUTS, remaining = requested
        var last: FinalSlice
        while true {
            try budget.step(); last = try finalSlice(sorted, start, remaining, request, size, dust, changeDust, budget)
            if last.outcome == .fits { break }
            try PJ.require(last.outcome != .insufficient, "Insufficient funds for payment and all transaction fees.")
            if last.outcome == .oversized {
                var count = min(nextLimit, min(NativeTransactions.MAX_PAYMENT_INPUTS, sorted.count - start - 1)); var contribution: Int64 = 0
                while count > 0 {
                    try budget.step(); let sum = prefix[start + count] - prefix[start], fee = Int64(size.vsize(count, false)) * Int64(request.feeRate)
                    contribution = request.subtractFeeFromAmount ? sum : sum - fee
                    let minimumFinal = dust + (request.subtractFeeFromAmount ? Int64(size.vsize(1, false)) * Int64(request.feeRate) : 0)
                    if sum - fee >= dust && contribution > 0 && remaining - contribution >= minimumFinal { break }; count -= 1
                }
                if count > 0 {
                    try PJ.require(slices.count + 1 < MAX_TRANSACTIONS, "Payment exceeds the 32-transaction safety limit.")
                    slices.append(Slice(start: start, end: start + count, contribution: contribution)); start += count; remaining -= contribution; nextLimit = NativeTransactions.MAX_PAYMENT_INPUTS; continue
                }
            }
            guard let previous = slices.popLast() else { throw WalletError(uneconomic) }
            start = previous.start; remaining = try PJ.add(remaining, previous.contribution); nextLimit = previous.end - previous.start - 1; try PJ.require(nextLimit > 0, uneconomic)
        }
        try PJ.require(slices.count + 1 <= MAX_TRANSACTIONS, "Payment exceeds the 32-transaction safety limit.")
        var plans = [JSONObject]()
        for slice in slices {
            let sum = prefix[slice.end] - prefix[slice.start]
            let part = try NativeTransactions.planPayment(sorted[slice.start..<slice.end].map(\.metadata), [["address": request.address, "amount": String(sum)]], changeAddress, request.feeRate, true)
            try PJ.require(PJ.objects(part["selected"]).count == slice.end - slice.start && PJ.string(part["change"]) == "0", uneconomic); plans.append(part)
        }
        let final = try NativeTransactions.planPayment(sorted[last.start..<last.end].map(\.metadata), [["address": request.address, "amount": String(remaining)]], changeAddress, request.feeRate, request.subtractFeeFromAmount)
        try PJ.require(PJ.objects(final["selected"]).count == last.end - last.start, "Payment selection changed. Review again."); plans.append(final)
        let result = try aggregate(request, plans)
        try PJ.require(!request.useAllBalance || PJ.objects(result["selected"]).count == candidates.count, uneconomic); return result
    }
    private static func finalSlice(_ sorted: [Candidate], _ start: Int, _ wanted: Int64, _ request: NativeSendPolicy.Request, _ size: NativeTransactions.PaymentSize, _ dust: Int64, _ changeDust: Int64, _ budget: SearchBudget) throws -> FinalSlice {
        if wanted < dust { return FinalSlice(outcome: .uneconomic, start: start, end: start) }
        if request.subtractFeeFromAmount && !request.useAllBalance {
            for i in start..<sorted.count {
                try budget.step()
                if sorted[i].value == wanted { return FinalSlice(outcome: wanted - Int64(size.vsize(1, false)) * Int64(request.feeRate) >= dust ? .fits : .uneconomic, start: i, end: i + 1) }
            }
        }
        var sum: Int64 = 0
        for end in start..<sorted.count {
            try budget.step(); let count = end - start + 1
            if count > NativeTransactions.MAX_PAYMENT_INPUTS || size.weight(count, false) > NativeTransactions.MAX_WEIGHT { return FinalSlice(outcome: .oversized, start: start, end: end) }
            sum += sorted[end].value
            if request.subtractFeeFromAmount {
                if sum < wanted { continue }; let remaining = sum - wanted, change = remaining == 0 ? 0 : max(remaining, changeDust)
                if size.weight(count, change > 0) > NativeTransactions.MAX_WEIGHT { return FinalSlice(outcome: .oversized, start: start, end: end + 1) }
                let fee = Int64(size.vsize(count, change > 0)) * Int64(request.feeRate)
                return FinalSlice(outcome: wanted - fee - (change - remaining) >= dust ? .fits : .uneconomic, start: start, end: end + 1)
            }
            let withChangeFee = Int64(size.vsize(count, true)) * Int64(request.feeRate)
            if sum - wanted - withChangeFee >= changeDust { return FinalSlice(outcome: size.weight(count, true) <= NativeTransactions.MAX_WEIGHT ? .fits : .oversized, start: start, end: end + 1) }
            if sum - wanted >= Int64(size.vsize(count, false)) * Int64(request.feeRate) { return FinalSlice(outcome: .fits, start: start, end: end + 1) }
        }
        return FinalSlice(outcome: .insufficient, start: start, end: sorted.count)
    }
    private static func aggregate(_ request: NativeSendPolicy.Request, _ plans: [JSONObject]) throws -> JSONObject {
        try PJ.require((1...MAX_TRANSACTIONS).contains(plans.count), "Invalid payment batch size.")
        var selected = [JSONObject](); var fee: Int64 = 0, received: Int64 = 0, input: Int64 = 0, change: Int64 = 0
        for (i, part) in plans.enumerated() {
            fee = try PJ.add(fee, PJ.money(part, "fee")); received = try PJ.add(received, PJ.money(part, "total")); input = try PJ.add(input, PJ.money(part, "inputTotal")); change = try PJ.add(change, PJ.money(part, "change"))
            try PJ.require(i == plans.count - 1 || PJ.string(part["change"]) == "0", "Only the final payment may return change."); selected += try PJ.objects(part["selected"])
        }
        try PJ.require(selected.count <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Payment exceeds the input safety limit."); try PJ.require(fee <= NativeTransactions.COIN, "Total batch fee exceeds the 1 CONN safety limit.")
        let requested = try NativeTransactions.amount(request.amount)
        try PJ.require(input == PJ.add(PJ.add(received, fee), change), "Payment totals changed. Review again.")
        try PJ.require(request.subtractFeeFromAmount ? received + fee <= requested : received == requested, "Payment amount changed. Review again.")
        try PJ.require(!request.useAllBalance || input == requested && change == 0, "Available funds changed. Refresh the balance and use all again.")
        return ["plans": plans, "selected": selected, "fee": String(fee), "total": String(received), "requestedTotal": request.amount, "inputTotal": String(input), "change": String(change), "transactionCount": plans.count]
    }
    public static func verify(_ request: NativeSendPolicy.Request, _ batch: JSONObject, _ changeAddress: String) throws {
        let expected = try plan(request, PJ.objects(batch["selected"]), changeAddress)
        try PJ.require(PJ.equal(expected, batch), "Payment batch, destination, fee or change changed. Review again.")
    }
    public static func review(_ request: NativeSendPolicy.Request, _ batch: JSONObject, _ changeAddress: String) throws -> String {
        try verify(request, batch, changeAddress); let plans = try PJ.objects(batch["plans"])
        if plans.count == 1 { return try request.review(plans[0], changeAddress) }
        let requested = try NativeTransactions.amount(request.amount), received = try PJ.money(batch, "total"), fee = try PJ.money(batch, "fee"), adjustment = request.subtractFeeFromAmount ? requested - received - fee : 0
        var text = try "MAINNET\n\nTo: \(request.address)\nIndependent payments: \(plans.count)\nEntered amount: \(NativeTransactions.format(requested)) CONN\nRecipient receives: \(NativeTransactions.format(received)) CONN\nTotal mining fee (\(request.subtractFeeFromAmount ? "deducted" : "added")): \(NativeTransactions.format(fee)) CONN\nFee rate: \(request.feeRate) connects/vbyte"
        if adjustment > 0 { text += try "\nKept as spendable change: \(NativeTransactions.format(adjustment)) CONN" }
        text += try "\nTotal paid: \(NativeTransactions.format(PJ.add(received, fee))) CONN\nSelected input total: \(NativeTransactions.format(PJ.money(batch, "inputTotal"))) CONN\nChange: \(NativeTransactions.format(PJ.money(batch, "change"))) CONN\nWallet change address: \(changeAddress)"
        for (i, part) in plans.enumerated() { text += try "\n\nPayment \(i + 1) of \(plans.count): recipient \(NativeTransactions.format(PJ.money(part, "total"))) CONN; fee \(NativeTransactions.format(PJ.money(part, "fee"))) CONN; inputs \(PJ.objects(part["selected"]).count)" }
        if request.useAllBalance { text += "\n\nUsing all currently available confirmed funds" + (request.fundingScope == nil ? "" : " in the selected address scope") + ", with the fee deducted." }
        return text + "\n\nThese are separate, independent transactions and are not atomic. Earlier payments may succeed even if a later payment fails. Submission stops if an outcome is uncertain. Review the saved results before retrying."
    }
}
