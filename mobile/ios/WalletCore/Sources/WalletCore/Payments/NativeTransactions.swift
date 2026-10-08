import Foundation

/// ConnectCoin typed outputs and native Schnorr sighashes. This is deliberately
/// not Bitcoin Script, PSBT, or Bitcoin Taproot transaction serialization.
public enum NativeTransactions {
    public static let COIN: Int64 = 10_000_000_000
    public static let MAX_MONEY: Int64 = 1_000_000_000_000_000_000
    public static let MAX_PROOF = 65_536, MAX_PAYMENT_INPUTS = 1_738, MAX_PAYMENT_CANDIDATES = 50_000
    public static let MAX_WEIGHT = 400_000
    private static let MAX_TX_BYTES = 4_000_000
    public struct PaymentTooLarge: LocalizedError {
        public var errorDescription: String? { "Payment exceeds standard weight. Enter a smaller amount instead of using all balance." }
        public init() {}
    }
    private static func paymentSize(_ valid: Bool) throws { if !valid { throw PaymentTooLarge() } }
    public static func amount(_ value: String) throws -> Int64 {
        try PJ.require(PJ.matches(value, "0|[1-9][0-9]{0,18}"), "Use an exact integer amount in connects.")
        guard let result = Int64(value), result <= MAX_MONEY else { throw WalletError("Amount exceeds the money range.") }; return result
    }
    public static func coinAmount(_ value: String) throws -> Int64 {
        try PJ.require(PJ.matches(value, "(0|[1-9][0-9]{0,8})(\\.[0-9]{1,10})?"), "Use a CONN amount with at most 10 decimals.")
        let fields = value.split(separator: ".", omittingEmptySubsequences: false)
        let decimals = fields.count == 2 ? String(fields[1]) : ""
        guard let whole = Int64(fields[0]), let fraction = Int64((decimals + String(repeating: "0", count: 10)).prefix(10)) else { throw WalletError("Invalid CONN amount.") }
        return try amount(String(whole * COIN + fraction))
    }
    public static func format(_ value: Int64) throws -> String {
        _ = try amount(String(value)); var decimal = String(format: "%010lld", value % COIN)
        while decimal.last == "0" { decimal.removeLast() }
        return String(value / COIN) + (decimal.isEmpty ? "" : "." + decimal)
    }
    public static func bytes(_ hex: String) throws -> Data {
        try PJ.require(hex.utf8.count <= MAX_TX_BYTES * 2 && hex.utf8.count % 2 == 0, "Invalid hexadecimal bytes.")
        return try WalletCrypto.fromHex(hex)
    }
    private static func fixed(_ hex: String, _ size: Int) throws -> Data { let data = try bytes(hex); try PJ.require(data.count == size, "Invalid fixed-size hexadecimal value."); return data }
    private static func reverse(_ data: Data) -> Data { Data(data.reversed()) }
    private static func le(_ value: Int64, _ size: Int) throws -> Data {
        try PJ.require(value >= 0 && (size != 4 || value <= 0xffff_ffff), "Invalid wire integer.")
        return Data((0..<size).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) })
    }
    private static func compact(_ n: Int) throws -> Data {
        try PJ.require(n >= 0 && n <= MAX_TX_BYTES, "Oversized CompactSize.")
        if n < 253 { return Data([UInt8(n)]) }; return try Data([n <= 65_535 ? 253 : 254]) + le(Int64(n), n <= 65_535 ? 2 : 4)
    }
    private static func blob(_ data: Data) throws -> Data { try compact(data.count) + data }
    public static func canonicalDomain(_ domain: String) -> Bool {
        !domain.isEmpty && domain.utf8.count <= 253 && PJ.matches(domain, "[a-z0-9.-]+") && domain.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { PJ.matches(String($0), "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?") }
    }
    public static func outputPayload(_ output: JSONObject) throws -> Data {
        let type = try PJ.integer(output["type"])
        if type == 1 {
            let key = try fixed(PJ.string(output["publicKey"]), 32); try WalletCrypto.validatePublicKey(key); return Data([1]) + key
        }
        try PJ.require(type == 2, "Unsupported output type.")
        let domain = try PJ.string(output["domain"]); try PJ.require(canonicalDomain(domain), "Noncanonical bounty domain.")
        let mask = try PJ.integer(output["mask"], 1, 7), roots = try PJ.integer(output["rootVersion"], 1, 0xffff_ffff)
        return try Data([2, UInt8(domain.utf8.count)]) + Data(domain.utf8) + reverse(fixed(PJ.string(output["target"]), 32)) + le(roots, 4) + Data([UInt8(mask)])
    }
    private static func outputBytes(_ output: JSONObject) throws -> Data { try le(PJ.money(output, "amount"), 8) + outputPayload(output) }
    private static func outpoint(_ input: JSONObject) throws -> Data { try reverse(fixed(PJ.string(input["txid"]), 32)) + le(PJ.integer(input["vout"]), 4) }
    public static func serialize(_ tx: JSONObject, _ witness: Bool = true) throws -> Data {
        let inputs = try PJ.objects(tx["inputs"]), outputs = try PJ.objects(tx["outputs"])
        try PJ.require((1...10_000).contains(inputs.count) && (1...10_000).contains(outputs.count), "Invalid transaction size.")
        var hasWitness = false, seen = Set<Data>(); var total: Int64 = 0
        for input in inputs {
            try PJ.require(seen.insert(outpoint(input)).inserted, "Duplicate transaction input.")
            if try !PJ.array(input["witness"]).isEmpty { hasWitness = true }
        }
        hasWitness = hasWitness && witness
        var out = try le(PJ.integer(tx["version"]), 4)
        if hasWitness { out += Data([0, 1]) }; out += try compact(inputs.count)
        for input in inputs {
            let script = try bytes(PJ.string(input["scriptSig"])); try PJ.require(script.count <= 10_000, "Oversized input script.")
            out += try outpoint(input) + blob(script) + le(PJ.integer(input["sequence"]), 4)
        }
        out += try compact(outputs.count)
        for output in outputs { total = try PJ.add(total, PJ.money(output, "amount")); out += try outputBytes(output) }
        if hasWitness { for input in inputs {
            let stack = try PJ.array(input["witness"]); try PJ.require(stack.count <= 100, "Oversized witness stack."); out += try compact(stack.count)
            for value in stack { let element = try bytes(PJ.string(value)); try PJ.require(element.count <= MAX_PROOF, "Oversized witness item."); out += try blob(element) }
        } }
        out += try le(PJ.integer(tx["locktime"]), 4); try PJ.require(out.count <= MAX_TX_BYTES, "Transaction exceeds local limit."); return out
    }
    public static func txid(_ tx: JSONObject) throws -> String { try WalletCrypto.hex(reverse(WalletCrypto.hash256(serialize(tx, false)))) }
    public static func vsize(_ tx: JSONObject) throws -> Int { try (serialize(tx, false).count * 3 + serialize(tx, true).count + 3) / 4 }
    private struct Reader {
        let data: [UInt8]; var position = 0
        mutating func take(_ size: Int) throws -> Data { try PJ.require(size >= 0 && size <= data.count - position, "Truncated transaction."); defer { position += size }; return Data(data[position..<(position + size)]) }
        mutating func octet() throws -> Int { Int(try take(1)[0]) }
        mutating func integer(_ size: Int) throws -> Int64 {
            let part = try take(size); var value: UInt64 = 0
            for (i, byte) in part.enumerated() { value |= UInt64(byte) << (8 * i) }
            try PJ.require(value <= UInt64(Int64.max), "Negative wire amount."); return Int64(value)
        }
        mutating func count(_ max: Int) throws -> Int {
            let first = try octet(); try PJ.require(first != 255, "Oversized CompactSize.")
            let value = first < 253 ? Int64(first) : try integer(first == 253 ? 2 : 4)
            try PJ.require(value <= max && !(first == 253 && value < 253) && !(first == 254 && value <= 65_535), "Noncanonical CompactSize."); return Int(value)
        }
        mutating func blob(_ max: Int) throws -> Data { let length = try count(max); return try take(length) }
    }
    public static func parse(_ hex: String) throws -> JSONObject {
        var reader = Reader(data: Array(try bytes(hex))); let version = try reader.integer(4); var count = try reader.count(10_000); let witness = count == 0
        if witness { try PJ.require(reader.octet() == 1, "Unknown witness flag."); count = try reader.count(10_000) }
        try PJ.require(count >= 1 && count <= (reader.data.count - reader.position) / 41, "Invalid input count.")
        var inputs = [JSONObject](), outputs = [JSONObject]()
        for _ in 0..<count { inputs.append(try ["txid": WalletCrypto.hex(reverse(reader.take(32))), "vout": reader.integer(4), "scriptSig": WalletCrypto.hex(reader.blob(10_000)), "sequence": reader.integer(4), "witness": [String]()]) }
        let outputCount = try reader.count(10_000); try PJ.require(outputCount >= 1 && outputCount <= (reader.data.count - reader.position) / 9, "Invalid output count.")
        for _ in 0..<outputCount {
            let amount = try reader.integer(8), type = try reader.octet(); var output: JSONObject = ["amount": String(amount), "type": type]
            if type == 1 { output["publicKey"] = try WalletCrypto.hex(reader.take(32)) }
            else if type == 2 {
                let domainLength = try reader.octet(), domain = try reader.take(domainLength)
                try PJ.require(domain.allSatisfy { $0 < 128 }, "Non-ASCII bounty domain.")
                output["domain"] = String(decoding: domain, as: UTF8.self); output["target"] = try WalletCrypto.hex(reverse(reader.take(32)))
                output["rootVersion"] = try reader.integer(4); output["mask"] = try reader.octet()
            } else { throw WalletError("Unsupported output type.") }; outputs.append(output)
        }
        if witness { for i in 0..<count { let items = try reader.count(100); var stack = [String](); for _ in 0..<items { stack.append(try WalletCrypto.hex(reader.blob(MAX_PROOF))) }; inputs[i]["witness"] = stack } }
        let tx: JSONObject = try ["version": version, "inputs": inputs, "outputs": outputs, "locktime": reader.integer(4)]
        try PJ.require(reader.position == reader.data.count && serialize(tx, true) == Data(reader.data), "Noncanonical or trailing transaction bytes."); return tx
    }
    private struct FundingParent {
        let transaction: JSONObject, id: String
        init(_ raw: String) throws { transaction = try parse(raw); id = try txid(transaction) }
    }
    private static func checkFundingOutput(_ utxo: JSONObject, _ expectedKey: String?, _ parent: FundingParent) throws -> JSONObject {
        try PJ.require(parent.id == PJ.string(utxo["txid"]), "Funding ID does not match the original transaction.")
        let index = try PJ.integer(utxo["vout"]), outputs = try PJ.objects(parent.transaction["outputs"])
        try PJ.require(index < outputs.count, "Funding output does not exist."); let output = outputs[Int(index)]
        try PJ.require(PJ.money(output, "amount") == PJ.money(utxo, "amount"), "Funding amount does not match the original transaction.")
        if let expectedKey { try PJ.require(PJ.integer(output["type"]) == 1 && PJ.string(output["publicKey"]) == expectedKey, "Funding output is not owned by this key.") }; return output
    }
    public static func verifyFunding(_ utxo: JSONObject, _ expectedKey: String?) throws -> JSONObject { try checkFundingOutput(utxo, expectedKey, FundingParent(PJ.string(utxo["rawTransaction"]))) }
    public static func verifyFundingBatch(_ selected: [JSONObject], _ expectedKey: String, check: () throws -> Void = {}) throws { try verifyFundingBatch(selected, owner: { _ in expectedKey }, check: check) }
    public static func verifyFundingBatch(_ selected: [JSONObject], owner: (JSONObject) throws -> String, check: () throws -> Void = {}) throws {
        try paymentSize(!selected.isEmpty && selected.count <= MAX_PAYMENT_INPUTS); var parents = [String: FundingParent](), seen = Set<Data>()
        for input in selected {
            try check(); try PJ.require(seen.insert(outpoint(input)).inserted, "Duplicate funding output.")
            let raw = try PJ.string(input["rawTransaction"]); if parents[raw] == nil { parents[raw] = try FundingParent(raw) }
            _ = try checkFundingOutput(input, owner(input), parents[raw]!)
        }; try check()
    }
    private struct PaymentSignatureHashes {
        let prefix: Data, inputCount: Int
        init(_ tx: JSONObject, _ spent: [JSONObject]) throws {
            let inputs = try PJ.objects(tx["inputs"]), outputs = try PJ.objects(tx["outputs"]); inputCount = inputs.count
            try PJ.require(inputCount > 0 && spent.count == inputCount, "Missing signing inputs.")
            var prevouts = Data(), amounts = Data(), locks = Data(), sequences = Data(), outputData = Data()
            for (i, input) in inputs.enumerated() { prevouts += try outpoint(input); amounts += try le(PJ.money(spent[i], "amount"), 8); locks += try outputPayload(spent[i]); sequences += try le(PJ.integer(input["sequence"]), 4) }
            for output in outputs { outputData += try outputBytes(output) }
            var p = try Data([0, 0]) + le(PJ.integer(tx["version"]), 4) + le(PJ.integer(tx["locktime"]), 4)
            for data in [prevouts, amounts, locks, sequences, outputData] { p += try WalletCrypto.sha256(data) }; p += Data([0]); prefix = p
        }
        func forInput(_ index: Int) throws -> Data { try PJ.require(index >= 0 && index < inputCount, "Missing signing inputs."); return try WalletCrypto.taggedHash("TapSighash", prefix + le(Int64(index), 4)) }
    }
    public static func signatureHash(_ tx: JSONObject, _ spent: [JSONObject], _ index: Int) throws -> Data { try PaymentSignatureHashes(tx, spent).forInput(index) }
    public static func claimChallenge(_ tx: JSONObject) throws -> String { try WalletCrypto.hex(WalletCrypto.taggedHash("ConnectCoin/P2C/claim/v1", reverse(fixed(txid(tx), 32)) + le(0, 4))) }
    public static func claimFee(_ rate: Int) throws -> Int64 { try feeRate(rate); return try Int64((92 * 4 + 2 + 1 + compact(MAX_PROOF).count + MAX_PROOF + 3) / 4) * Int64(rate) }
    public static func prepareClaim(_ bounty: JSONObject, _ parentHex: String, _ rewardAddress: String, _ rate: Int) throws -> JSONObject {
        var funded = bounty; funded["rawTransaction"] = parentHex; let output = try verifyFunding(funded, nil)
        try PJ.require(PJ.integer(output["type"]) == 2 && PJ.integer(output["rootVersion"]) == 1, "Unsupported bounty output.")
        for pair in [("domain", "domain"), ("connection_work_target", "target"), ("root_certificates_version", "rootVersion"), ("signature_algorithms_mask", "mask")] {
            guard let actual = bounty[pair.0], let expected = output[pair.1] else { throw WalletError("Bounty differs from the funding transaction.") }
            try PJ.require(String(describing: actual) == String(describing: expected), "Bounty differs from the funding transaction.")
        }
        let fee = try claimFee(rate), value = try PJ.money(output, "amount"); try PJ.require(fee <= COIN && value > fee, "Bounty is smaller than its safe fee.")
        let reward: JSONObject = try ["type": 1, "amount": String(value - fee), "publicKey": WalletCrypto.hex(WalletCrypto.decodeAddress(rewardAddress))]
        try PJ.require(value - fee >= dust(reward), "Bounty payout is below dust.")
        let input: JSONObject = try ["txid": PJ.string(bounty["txid"]), "vout": PJ.integer(bounty["vout"]), "sequence": Int64(0xffff_ffff), "scriptSig": "", "witness": [String]()]
        let tx: JSONObject = ["version": 2, "locktime": 0, "inputs": [input], "outputs": [reward]]
        return try ["hex": WalletCrypto.hex(serialize(tx, false)), "txid": txid(tx), "challenge": claimChallenge(tx), "bounty": output, "fee": String(fee), "payout": String(value - fee)]
    }
    public static func attachClaim(_ prepared: JSONObject, _ proofHex: String) throws -> JSONObject {
        let proof = [UInt8](try bytes(proofHex)); try PJ.require(!proof.isEmpty && proof.count <= MAX_PROOF && proof[0] == 2, "Invalid proof version or size.")
        var offset = 1, messages = [Data]()
        for (type, maximum) in [(1, 4096), (2, 2048), (8, 4096), (11, 49152), (15, 8192)] {
            try PJ.require(offset + 4 <= proof.count && Int(proof[offset]) == type, "Invalid proof sequence.")
            let size = 4 + Int(proof[offset + 1]) * 65536 + Int(proof[offset + 2]) * 256 + Int(proof[offset + 3])
            try PJ.require(size <= maximum && size <= proof.count - offset, "Invalid proof framing.")
            messages.append(Data(proof[offset..<(offset + size)])); offset += size
        }
        try PJ.require(offset == proof.count && messages[0].count >= 38 && WalletCrypto.hex(messages[0].subdata(in: 6..<38)) == PJ.string(prepared["challenge"]), "Proof is not bound to this claim.")
        var tx = try parse(PJ.string(prepared["hex"])); var inputs = try PJ.objects(tx["inputs"]); let outputs = try PJ.objects(tx["outputs"])
        try PJ.require(txid(tx) == PJ.string(prepared["txid"]) && claimChallenge(tx) == PJ.string(prepared["challenge"]) && inputs.count == 1 && outputs.count == 1 && PJ.array(inputs[0]["witness"]).isEmpty, "Claim proposal changed.")
        let work = try WalletCrypto.taggedHash("ConnectCoin/P2C/work/v2", messages.prefix(4).reduce(Data(), +))
        let target = try fixed(PJ.string(PJ.object(prepared["bounty"])["target"]), 32)
        try PJ.require(!target.lexicographicallyPrecedes(reverse(work)), "Proof does not meet target.")
        inputs[0]["witness"] = [proofHex]; tx["inputs"] = inputs
        return try ["hex": WalletCrypto.hex(serialize(tx, true)), "txid": txid(tx), "fee": PJ.string(prepared["fee"]), "payout": PJ.string(prepared["payout"])]
    }
    static func feeRate(_ rate: Int) throws { try PJ.require((1201...100000).contains(rate), "Fee rate must be 1,201–100,000 connects/vbyte.") }
    public static func dust(_ output: JSONObject) throws -> Int64 { try Int64(outputBytes(output).count + (PJ.integer(output["type"]) == 2 ? 41 + (1 + 5 + MAX_PROOF + 3) / 4 : 58)) * 3 }
    public static func recipient(_ source: JSONObject) throws -> JSONObject {
        let value = try PJ.money(source, "amount"); var output: JSONObject = ["amount": String(value)]
        if source["address"] != nil { output["type"] = 1; output["publicKey"] = try WalletCrypto.hex(WalletCrypto.decodeAddress(PJ.string(source["address"]))) }
        else {
            let domain = try PJ.string(source["domain"]); try PJ.require(canonicalDomain(domain) && domain.contains("."), "Enter a canonical public domain.")
            output["type"] = 2; output["domain"] = domain; output["target"] = try PaymentTarget.target(PJ.string(source["expectedConnections"])); output["rootVersion"] = 1; output["mask"] = try PJ.integer(source["mask"])
        }
        try PJ.require(value >= dust(output), "Recipient amount is below dust."); return output
    }
    struct PaymentSize {
        let recipientCount: Int, recipientBytes: Int, changeBytes: Int
        init(_ recipients: [JSONObject], _ change: JSONObject) throws { recipientCount = recipients.count; recipientBytes = try recipients.reduce(0) { try $0 + outputBytes($1).count }; changeBytes = try outputBytes(change).count }
        func weight(_ inputs: Int, _ change: Bool) -> Int {
            func length(_ count: Int) -> Int { count < 253 ? 1 : count <= 65535 ? 3 : 5 }
            let base = 8 + length(inputs) + 41 * inputs + length(recipientCount + (change ? 1 : 0)) + recipientBytes + (change ? changeBytes : 0)
            return base * 4 + 2 + 66 * inputs
        }
        func vsize(_ inputs: Int, _ change: Bool) -> Int { (weight(inputs, change) + 3) / 4 }
    }
    public static func planPayment(_ candidates: [JSONObject], _ destinations: [JSONObject], _ changeAddress: String, _ rate: Int, _ deductFee: Bool) throws -> JSONObject {
        try feeRate(rate); try PJ.require(!candidates.isEmpty && candidates.count <= MAX_PAYMENT_CANDIDATES && !destinations.isEmpty && destinations.count <= 100 && (!deductFee || destinations.count == 1), "Invalid mobile payment size.")
        let recipients = try destinations.map { try recipient($0) }; var requested: Int64 = 0
        for output in recipients { requested = try PJ.add(requested, PJ.money(output, "amount")) }
        let changeOutput: JSONObject = try ["type": 1, "amount": "0", "publicKey": WalletCrypto.hex(WalletCrypto.decodeAddress(changeAddress))]
        var seen = Set<Data>(), sorted = [(metadata: JSONObject, value: Int64, order: Int)]()
        for (i, candidate) in candidates.enumerated() { let value = try PJ.money(candidate, "amount"); try PJ.require(seen.insert(outpoint(candidate)).inserted, "Duplicate funding output."); sorted.append((candidate, value, i)) }
        sorted.sort { a, b in if deductFee && (a.value == requested) != (b.value == requested) { return a.value == requested }; return a.value == b.value ? a.order < b.order : a.value > b.value }
        let size = try PaymentSize(recipients, changeOutput), changeDust = try dust(changeOutput)
        var selected = [JSONObject](), inputs = [JSONObject](), outputs = recipients; var sum: Int64 = 0, fee: Int64 = -1, change: Int64 = 0, total = requested
        for funding in sorted {
            let count = inputs.count + 1; try paymentSize(count <= MAX_PAYMENT_INPUTS && size.weight(count, false) <= MAX_WEIGHT)
            let candidate = funding.metadata; selected.append(candidate); sum = try PJ.add(sum, funding.value)
            inputs.append(try ["txid": PJ.string(candidate["txid"]), "vout": PJ.integer(candidate["vout"]), "scriptSig": "", "sequence": Int64(0xffff_fffd), "witness": [String(repeating: "0", count: 128)]])
            if deductFee {
                if sum < requested { continue }; let remaining = sum - requested; change = remaining == 0 ? 0 : max(remaining, changeDust)
                try paymentSize(size.weight(count, change > 0) <= MAX_WEIGHT); outputs = recipients
                if change > 0 { var returned = changeOutput; returned["amount"] = String(change); outputs.append(returned) }
                fee = Int64(size.vsize(count, change > 0)) * Int64(rate); total = requested - fee - (change - remaining)
                try PJ.require(total >= dust(outputs[0]), "Payment after fee is below dust."); outputs[0]["amount"] = String(total); break
            }
            let withChangeFee = Int64(size.vsize(count, true)) * Int64(rate), candidateChange = sum - requested - withChangeFee
            if candidateChange >= changeDust {
                try paymentSize(size.weight(count, true) <= MAX_WEIGHT); change = candidateChange; fee = withChangeFee
                var returned = changeOutput; returned["amount"] = String(change); outputs = recipients + [returned]; break
            }
            let minimum = Int64(size.vsize(count, false)) * Int64(rate)
            if sum >= requested + minimum { fee = sum - requested; break }
        }
        try PJ.require(fee >= 0, "Insufficient funds for payment and fee."); try PJ.require(fee <= COIN, "Fee exceeds the 1 CONN safety limit.")
        let tx: JSONObject = ["version": 2, "locktime": 0, "inputs": inputs, "outputs": outputs]
        let weight = try serialize(tx, false).count * 3 + serialize(tx, true).count; try paymentSize(weight <= MAX_WEIGHT)
        try PJ.require((weight + 3) / 4 == size.vsize(inputs.count, change > 0), "Payment size differs from its fee estimate.")
        return ["transaction": tx, "selected": selected, "fee": String(fee), "total": String(total), "requestedTotal": String(requested), "inputTotal": String(sum), "change": String(change), "vsize": (weight + 3) / 4]
    }
    public static func signPayment(_ plan: JSONObject, _ session: VaultSession, check: () throws -> Void = {}) throws -> JSONObject {
        try check(); var tx = try PJ.object(plan["transaction"]), inputs = try PJ.objects(tx["inputs"])
        let selected = try PJ.objects(plan["selected"]); var spent = [JSONObject](); try paymentSize(!selected.isEmpty && selected.count <= MAX_PAYMENT_INPUTS)
        try PJ.require(inputs.count == selected.count, "Payment plan changed."); var inputTotal: Int64 = 0, outputTotal: Int64 = 0
        let plannedWeight = try serialize(tx, false).count * 3 + serialize(tx, true).count; try paymentSize(plannedWeight <= MAX_WEIGHT)
        var parents = [String: FundingParent](), accounts = [String: JSONObject]()
        for (i, input) in selected.enumerated() {
            try check(); let index = try PJ.integer(input["index"], 0, Int64(Int32.max)), change = try PJ.integer(input["change"], 0, 1), path = "\(change):\(index)"
            if accounts[path] == nil { accounts[path] = try session.publicAccount(index: Int(index), change: Int(change)) }
            try PJ.require(outpoint(input) == outpoint(inputs[i]), "Selected input changed.")
            let raw = try PJ.string(input["rawTransaction"]); if parents[raw] == nil { parents[raw] = try FundingParent(raw) }
            let output = try checkFundingOutput(input, PJ.string(accounts[path]!["publicKey"]), parents[raw]!); spent.append(output); inputTotal = try PJ.add(inputTotal, PJ.money(output, "amount"))
        }
        for output in try PJ.objects(tx["outputs"]) { outputTotal = try PJ.add(outputTotal, PJ.money(output, "amount")) }
        try PJ.require(inputTotal - outputTotal == PJ.money(plan, "fee") && inputTotal - outputTotal <= COIN && Int64((plannedWeight + 3) / 4) == PJ.integer(plan["vsize"]), "Payment totals changed.")
        try check(); let hashes = try PaymentSignatureHashes(tx, spent)
        for (i, input) in selected.enumerated() {
            try check(); let signature = try session.signDigest(hashes.forInput(i), index: Int(PJ.integer(input["index"])), change: Int(PJ.integer(input["change"])))
            inputs[i]["witness"] = [WalletCrypto.hex(signature)]; try check()
        }
        tx["inputs"] = inputs; let signed = try serialize(tx, true), signedWeight = try serialize(tx, false).count * 3 + signed.count
        try paymentSize(signedWeight <= MAX_WEIGHT); try PJ.require(Int64((signedWeight + 3) / 4) == PJ.integer(plan["vsize"]), "Signed payment size changed."); try check()
        return try ["hex": WalletCrypto.hex(signed), "txid": txid(tx), "fee": PJ.string(plan["fee"])]
    }
}
