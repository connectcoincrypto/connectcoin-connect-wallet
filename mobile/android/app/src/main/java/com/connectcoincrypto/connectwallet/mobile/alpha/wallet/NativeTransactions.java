package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** ConnectCoin's native typed outputs, NOT Bitcoin Script/PSBT/Taproot wire encoding.
 * Public transaction operations plus an internal signer. No network or Android UI.
 * Port of src/core/transaction.mjs; every spent output is checked against its raw
 * parent before signing. All monetary values are exact connects (10^10/CONN).
 */
public final class NativeTransactions {
    public static final long COIN = 10_000_000_000L, MAX_MONEY = 1_000_000_000_000_000_000L;
    // 1,738 native P2PK inputs and one P2PK output fit Core's 400,000 weight
    // limit. A wallet may have many more candidates than a payment will spend.
    public static final int MAX_PROOF = 65536, MAX_PAYMENT_INPUTS = 1738, MAX_PAYMENT_CANDIDATES = 50000;
    private static final int MAX_TX_BYTES = 4_000_000;
    static final int MAX_WEIGHT = 400_000;
    private static final String PAYMENT_WEIGHT_ERROR = "Payment exceeds standard weight. Enter a smaller amount instead of using all balance.";
    /** Only this failure permits an ordinary payment to become independent parts. */
    public static final class PaymentTooLarge extends IllegalArgumentException {
        public PaymentTooLarge() { super(PAYMENT_WEIGHT_ERROR); }
    }
    private static void paymentSize(boolean valid) { if (!valid) throw new PaymentTooLarge(); }
    private NativeTransactions() {}
    private static void write(ByteArrayOutputStream stream, byte[] bytes) { stream.write(bytes, 0, bytes.length); }
    private static String zeros(int length) { char[] chars = new char[length]; Arrays.fill(chars, '0'); return new String(chars); }
    private static void require(boolean condition, String error) { if (!condition) throw new IllegalArgumentException(error); }
    public static long amount(String value) {
        require(value != null && value.matches("0|[1-9][0-9]{0,18}"), "Use an exact integer amount in connects.");
        long result = Long.parseLong(value); require(result <= MAX_MONEY, "Amount exceeds the money range."); return result;
    }
    public static long coinAmount(String value) {
        require(value != null && value.matches("(0|[1-9][0-9]{0,8})(\\.[0-9]{1,10})?"), "Use a CONN amount with at most 10 decimals.");
        String[] fields = value.split("\\.");
        String decimal = fields.length == 2 ? fields[1] : "";
        return amount(Long.toString(Math.addExact(Math.multiplyExact(Long.parseLong(fields[0]), COIN), Long.parseLong((decimal + "0000000000").substring(0, 10)))));
    }
    public static String format(long value) {
        amount(Long.toString(value));
        String decimals = String.format(java.util.Locale.ROOT, "%010d", value % COIN).replaceFirst("0+$", "");
        return Long.toString(value / COIN) + (decimals.isEmpty() ? "" : "." + decimals);
    }
    public static byte[] bytes(String hex) { require(hex != null && hex.length() <= MAX_TX_BYTES * 2 && hex.length() % 2 == 0, "Invalid hexadecimal bytes."); return WalletCrypto.fromHex(hex); }
    private static byte[] fixed(String hex, int size) { byte[] result = bytes(hex); require(result.length == size, "Invalid fixed-size hexadecimal value."); return result; }
    private static byte[] reverse(byte[] input) { byte[] out = input.clone(); for (int i = 0; i < out.length / 2; i++) { byte v = out[i]; out[i] = out[out.length - i - 1]; out[out.length - i - 1] = v; } return out; }
    private static byte[] concat(byte[]... values) { ByteArrayOutputStream out = new ByteArrayOutputStream(); for (byte[] value : values) write(out, value); return out.toByteArray(); }
    private static byte[] le(long value, int size) { require(value >= 0 && (size != 4 || value <= 0xffffffffL), "Invalid wire integer."); byte[] out = new byte[size]; for (int i = 0; i < size; i++) out[i] = (byte) (value >>> (8 * i)); return out; }
    private static byte[] compact(int n) { require(n >= 0 && n <= MAX_TX_BYTES, "Oversized CompactSize."); return n < 253 ? new byte[]{(byte)n} : n <= 65535 ? concat(new byte[]{(byte)253}, le(n, 2)) : concat(new byte[]{(byte)254}, le(n, 4)); }
    private static byte[] blob(byte[] value) { return concat(compact(value.length), value); }
    public static boolean canonicalDomain(String domain) {
        if (domain == null || domain.isEmpty() || domain.length() > 253 || !domain.matches("[a-z0-9.-]+")) return false;
        for (String label : domain.split("\\.", -1)) if (!label.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) return false;
        return true;
    }
    public static byte[] outputPayload(JSONObject output) throws Exception {
        int type = output.getInt("type");
        if (type == 1) { byte[] pub = fixed(output.getString("publicKey"), 32); WalletCrypto.validatePublicKey(pub); return concat(new byte[]{1}, pub); }
        require(type == 2, "Unsupported output type.");
        String domain = output.getString("domain"); require(canonicalDomain(domain), "Noncanonical bounty domain.");
        int mask = output.getInt("mask"); long roots = output.getLong("rootVersion");
        require(mask >= 1 && mask <= 7 && roots >= 1 && roots <= 0xffffffffL, "Invalid bounty policy.");
        return concat(new byte[]{2, (byte)domain.length()}, domain.getBytes(StandardCharsets.US_ASCII), reverse(fixed(output.getString("target"), 32)), le(roots, 4), new byte[]{(byte)mask});
    }
    private static byte[] outputBytes(JSONObject output) throws Exception { return concat(le(amount(output.getString("amount")), 8), outputPayload(output)); }
    private static byte[] outpoint(JSONObject input) throws Exception { return concat(reverse(fixed(input.getString("txid"), 32)), le(input.getLong("vout"), 4)); }
    public static byte[] serialize(JSONObject tx, boolean witness) throws Exception {
        JSONArray inputs = tx.getJSONArray("inputs"), outputs = tx.getJSONArray("outputs");
        require(inputs.length() >= 1 && inputs.length() <= 10000 && outputs.length() >= 1 && outputs.length() <= 10000, "Invalid transaction size.");
        boolean hasWitness = false; long total = 0; HashSet<String> seen = new HashSet<>();
        for (int i = 0; i < inputs.length(); i++) { JSONObject input = inputs.getJSONObject(i); require(seen.add(WalletCrypto.hex(outpoint(input))), "Duplicate transaction input."); hasWitness |= input.getJSONArray("witness").length() > 0; }
        hasWitness &= witness;
        ByteArrayOutputStream out = new ByteArrayOutputStream(); write(out, le(tx.getLong("version"), 4));
        if (hasWitness) write(out, new byte[]{0, 1}); write(out, compact(inputs.length()));
        for (int i = 0; i < inputs.length(); i++) {
            JSONObject input = inputs.getJSONObject(i); byte[] script = bytes(input.getString("scriptSig")); require(script.length <= 10000, "Oversized input script.");
            write(out, outpoint(input)); write(out, blob(script)); write(out, le(input.getLong("sequence"), 4));
        }
        write(out, compact(outputs.length()));
        for (int i = 0; i < outputs.length(); i++) { JSONObject output = outputs.getJSONObject(i); total = Math.addExact(total, amount(output.getString("amount"))); require(total <= MAX_MONEY, "Transaction total exceeds money range."); write(out, outputBytes(output)); }
        if (hasWitness) for (int i = 0; i < inputs.length(); i++) {
            JSONArray stack = inputs.getJSONObject(i).getJSONArray("witness"); require(stack.length() <= 100, "Oversized witness stack."); write(out, compact(stack.length()));
            for (int j = 0; j < stack.length(); j++) { byte[] element = bytes(stack.getString(j)); require(element.length <= MAX_PROOF, "Oversized witness item."); write(out, blob(element)); }
        }
        write(out, le(tx.getLong("locktime"), 4)); require(out.size() <= MAX_TX_BYTES, "Transaction exceeds local limit."); return out.toByteArray();
    }
    public static String txid(JSONObject tx) throws Exception { return WalletCrypto.hex(reverse(WalletCrypto.hash256(serialize(tx, false)))); }
    public static int vsize(JSONObject tx) throws Exception { return (serialize(tx, false).length * 3 + serialize(tx, true).length + 3) / 4; }
    private static final class Reader {
        final byte[] data; int position;
        Reader(byte[] data) { this.data = data; }
        byte[] take(int size) { require(size >= 0 && size <= data.length - position, "Truncated transaction."); byte[] part = Arrays.copyOfRange(data, position, position + size); position += size; return part; }
        int octet() { return take(1)[0] & 255; }
        long integer(int size) { byte[] part = take(size); long value = 0; for (int i = 0; i < size; i++) value |= (part[i] & 255L) << (i * 8); require(value >= 0, "Negative wire amount."); return value; }
        int count(int max) { int first = octet(); require(first != 255, "Oversized CompactSize."); long n = first < 253 ? first : integer(first == 253 ? 2 : 4); require(n <= max && !(first == 253 && n < 253) && !(first == 254 && n <= 65535), "Noncanonical CompactSize."); return (int)n; }
        byte[] blob(int max) { return take(count(max)); }
    }
    public static JSONObject parse(String hex) throws Exception {
        Reader r = new Reader(bytes(hex)); long version = r.integer(4); int count = r.count(10000); boolean witness = count == 0;
        if (witness) { require(r.octet() == 1, "Unknown witness flag."); count = r.count(10000); }
        require(count >= 1 && count <= (r.data.length - r.position) / 41, "Invalid input count."); JSONArray inputs = new JSONArray();
        for (int i = 0; i < count; i++) inputs.put(new JSONObject().put("txid", WalletCrypto.hex(reverse(r.take(32)))).put("vout", r.integer(4)).put("scriptSig", WalletCrypto.hex(r.blob(10000))).put("sequence", r.integer(4)).put("witness", new JSONArray()));
        int outputCount = r.count(10000); require(outputCount >= 1 && outputCount <= (r.data.length - r.position) / 9, "Invalid output count."); JSONArray outputs = new JSONArray();
        for (int i = 0; i < outputCount; i++) {
            JSONObject output = new JSONObject().put("amount", Long.toString(r.integer(8))); int type = r.octet(); output.put("type", type);
            if (type == 1) output.put("publicKey", WalletCrypto.hex(r.take(32)));
            else if (type == 2) { byte[] domain = r.take(r.octet()); for (byte b : domain) require(b >= 0, "Non-ASCII bounty domain."); output.put("domain", new String(domain, StandardCharsets.US_ASCII)).put("target", WalletCrypto.hex(reverse(r.take(32)))).put("rootVersion", r.integer(4)).put("mask", r.octet()); }
            else throw new IllegalArgumentException("Unsupported output type."); outputs.put(output);
        }
        if (witness) for (int i = 0; i < count; i++) { int items = r.count(100); JSONArray stack = inputs.getJSONObject(i).getJSONArray("witness"); for (int j = 0; j < items; j++) stack.put(WalletCrypto.hex(r.blob(MAX_PROOF))); }
        JSONObject tx = new JSONObject().put("version", version).put("inputs", inputs).put("outputs", outputs).put("locktime", r.integer(4));
        require(r.position == r.data.length && Arrays.equals(serialize(tx, true), r.data), "Noncanonical or trailing transaction bytes."); return tx;
    }
    private static final class FundingParent {
        final JSONObject transaction;
        final String id;
        FundingParent(String raw) throws Exception { transaction = parse(raw); id = txid(transaction); }
    }
    private static JSONObject checkFundingOutput(JSONObject utxo, String expectedKey, FundingParent parent) throws Exception {
        require(parent.id.equals(utxo.getString("txid")), "Funding ID does not match the original transaction.");
        long index = utxo.getLong("vout"); require(index >= 0 && index < parent.transaction.getJSONArray("outputs").length(), "Funding output does not exist.");
        JSONObject output = parent.transaction.getJSONArray("outputs").getJSONObject((int)index);
        require(amount(output.getString("amount")) == amount(utxo.getString("amount")), "Funding amount does not match the original transaction.");
        if (expectedKey != null) require(output.getInt("type") == 1 && output.getString("publicKey").equals(expectedKey), "Funding output is not owned by this key.");
        return output;
    }
    public static JSONObject verifyFunding(JSONObject utxo, String expectedKey) throws Exception {
        return checkFundingOutput(utxo, expectedKey, new FundingParent(utxo.getString("rawTransaction")));
    }
    @FunctionalInterface public interface FundingCheck { void check() throws Exception; }
    @FunctionalInterface public interface FundingOwner { String publicKey(JSONObject input) throws Exception; }
    public static void verifyFundingBatch(JSONArray selected, String expectedKey) throws Exception {
        verifyFundingBatch(selected, expectedKey, () -> {});
    }
    /** Internal native review helper, never a WebView method. Cache only the
     * parse/identity work; authenticate every selected output independently. */
    public static void verifyFundingBatch(JSONArray selected, String expectedKey, FundingCheck check) throws Exception {
        require(expectedKey != null, "Missing funding ownership key.");
        verifyFundingBatch(selected, input -> expectedKey, check);
    }
    /** The owner resolver is native-owned and must bind each input path to the
     * current wallet; renderer/RPC ownership claims are never accepted. */
    public static void verifyFundingBatch(JSONArray selected, FundingOwner owner, FundingCheck check) throws Exception {
        require(selected.length() > 0 && selected.length() <= MAX_PAYMENT_INPUTS, PAYMENT_WEIGHT_ERROR);
        require(owner != null, "Missing funding ownership resolver.");
        Map<String, FundingParent> parents = new HashMap<>(); HashSet<String> seen = new HashSet<>();
        for (int i = 0; i < selected.length(); i++) {
            check.check(); JSONObject input = selected.getJSONObject(i);
            require(seen.add(WalletCrypto.hex(outpoint(input))), "Duplicate funding output.");
            String raw = input.getString("rawTransaction"); FundingParent parent = parents.get(raw);
            if (parent == null) { parent = new FundingParent(raw); parents.put(raw, parent); }
            String expectedKey = owner.publicKey(input);
            require(expectedKey != null, "Missing funding ownership key.");
            checkFundingOutput(input, expectedKey, parent);
        }
        check.check();
    }
    private static final class PaymentSignatureHashes {
        final byte[] prefix;
        final int inputCount;
        PaymentSignatureHashes(JSONObject tx, JSONArray spent) throws Exception {
            JSONArray inputs = tx.getJSONArray("inputs"), outputs = tx.getJSONArray("outputs"); inputCount = inputs.length();
            require(inputCount > 0 && spent.length() == inputCount, "Missing signing inputs.");
            ByteArrayOutputStream prevouts = new ByteArrayOutputStream(), amounts = new ByteArrayOutputStream(), locks = new ByteArrayOutputStream(), sequences = new ByteArrayOutputStream(), outputData = new ByteArrayOutputStream();
            for (int i = 0; i < inputs.length(); i++) { write(prevouts, outpoint(inputs.getJSONObject(i))); write(amounts, le(amount(spent.getJSONObject(i).getString("amount")), 8)); write(locks, outputPayload(spent.getJSONObject(i))); write(sequences, le(inputs.getJSONObject(i).getLong("sequence"), 4)); }
            for (int i = 0; i < outputs.length(); i++) write(outputData, outputBytes(outputs.getJSONObject(i)));
            // Native typed-output SIGHASH_DEFAULT: snapshot the common digest only
            // for this synchronous signing operation, never across plan mutations.
            prefix = concat(new byte[]{0, 0}, le(tx.getLong("version"), 4), le(tx.getLong("locktime"), 4), WalletCrypto.sha256(prevouts.toByteArray()), WalletCrypto.sha256(amounts.toByteArray()), WalletCrypto.sha256(locks.toByteArray()), WalletCrypto.sha256(sequences.toByteArray()), WalletCrypto.sha256(outputData.toByteArray()), new byte[]{0});
        }
        byte[] forInput(int index) {
            require(index >= 0 && index < inputCount, "Missing signing inputs.");
            return WalletCrypto.taggedHash("TapSighash", concat(prefix, le(index, 4)));
        }
    }
    public static byte[] signatureHash(JSONObject tx, JSONArray spent, int index) throws Exception { return new PaymentSignatureHashes(tx, spent).forInput(index); }
    public static String claimChallenge(JSONObject tx) throws Exception { return WalletCrypto.hex(WalletCrypto.taggedHash("ConnectCoin/P2C/claim/v1", concat(reverse(fixed(txid(tx), 32)), le(0, 4)))); }
    public static long claimFee(int feeRate) { feeRate(feeRate); return (long)((92 * 4 + 2 + 1 + compact(MAX_PROOF).length + MAX_PROOF + 3) / 4) * feeRate; }
    public static JSONObject prepareClaim(JSONObject bounty, String parentHex, String rewardAddress, int rate) throws Exception {
        JSONObject funded = new JSONObject(bounty.toString()).put("rawTransaction", parentHex), output = verifyFunding(funded, null);
        require(output.getInt("type") == 2 && output.getInt("rootVersion") == 1, "Unsupported bounty output.");
        for (String[] keys : new String[][]{{"domain","domain"}, {"connection_work_target","target"}, {"root_certificates_version","rootVersion"}, {"signature_algorithms_mask","mask"}}) require(bounty.has(keys[0]) && bounty.get(keys[0]).toString().equals(output.get(keys[1]).toString()), "Bounty differs from the funding transaction.");
        long fee = claimFee(rate), value = amount(output.getString("amount")); require(fee <= COIN && value > fee, "Bounty is smaller than its safe fee.");
        JSONObject reward = new JSONObject().put("type", 1).put("amount", Long.toString(value - fee)).put("publicKey", WalletCrypto.hex(WalletCrypto.decodeAddress(rewardAddress)));
        require(value - fee >= dust(reward), "Bounty payout is below dust.");
        JSONObject tx = new JSONObject().put("version", 2).put("locktime", 0).put("inputs", new JSONArray().put(new JSONObject().put("txid", bounty.getString("txid")).put("vout", bounty.getLong("vout")).put("sequence", 0xffffffffL).put("scriptSig", "").put("witness", new JSONArray()))).put("outputs", new JSONArray().put(reward));
        return new JSONObject().put("hex", WalletCrypto.hex(serialize(tx, false))).put("txid", txid(tx)).put("challenge", claimChallenge(tx)).put("bounty", output).put("fee", Long.toString(fee)).put("payout", Long.toString(value - fee));
    }
    public static JSONObject attachClaim(JSONObject prepared, String proofHex) throws Exception {
        byte[] proof = bytes(proofHex); require(proof.length > 0 && proof.length <= MAX_PROOF && proof[0] == 2, "Invalid proof version or size.");
        int offset = 1; List<byte[]> messages = new ArrayList<>();
        for (int[] spec : new int[][]{{1,4096},{2,2048},{8,4096},{11,49152},{15,8192}}) {
            require(offset + 4 <= proof.length && (proof[offset] & 255) == spec[0], "Invalid proof sequence.");
            int size = 4 + ((proof[offset+1] & 255) << 16) + ((proof[offset+2] & 255) << 8) + (proof[offset+3] & 255);
            require(size <= spec[1] && size <= proof.length - offset, "Invalid proof framing."); messages.add(Arrays.copyOfRange(proof, offset, offset + size)); offset += size;
        }
        require(offset == proof.length && messages.get(0).length >= 38 && WalletCrypto.hex(Arrays.copyOfRange(messages.get(0), 6, 38)).equals(prepared.getString("challenge")), "Proof is not bound to this claim.");
        JSONObject tx = parse(prepared.getString("hex")); require(txid(tx).equals(prepared.getString("txid")) && claimChallenge(tx).equals(prepared.getString("challenge")) && tx.getJSONArray("inputs").length() == 1 && tx.getJSONArray("outputs").length() == 1 && tx.getJSONArray("inputs").getJSONObject(0).getJSONArray("witness").length() == 0, "Claim proposal changed.");
        byte[] work = WalletCrypto.taggedHash("ConnectCoin/P2C/work/v2", concat(messages.subList(0, 4).toArray(new byte[0][])));
        require(new BigInteger(1, reverse(work)).compareTo(new BigInteger(prepared.getJSONObject("bounty").getString("target"), 16)) <= 0, "Proof does not meet target.");
        tx.getJSONArray("inputs").getJSONObject(0).put("witness", new JSONArray().put(proofHex));
        return new JSONObject().put("hex", WalletCrypto.hex(serialize(tx, true))).put("txid", txid(tx)).put("fee", prepared.getString("fee")).put("payout", prepared.getString("payout"));
    }
    private static void feeRate(int rate) { require(rate >= 1201 && rate <= 100000, "Fee rate must be 1,201–100,000 connects/vbyte."); }
    public static long dust(JSONObject output) throws Exception { return (outputBytes(output).length + (output.getInt("type") == 2 ? 41 + (1 + 5 + MAX_PROOF + 3) / 4 : 58)) * 3L; }
    public static JSONObject recipient(JSONObject source) throws Exception {
        long value = amount(source.getString("amount")); JSONObject output = new JSONObject().put("amount", Long.toString(value));
        if (source.has("address")) output.put("type", 1).put("publicKey", WalletCrypto.hex(WalletCrypto.decodeAddress(source.getString("address"))));
        else {
            String domain = source.getString("domain"); require(canonicalDomain(domain) && domain.contains("."), "Enter a canonical public domain.");
            String expected = source.getString("expectedConnections"); require(expected.matches("[1-9][0-9]{0,77}"), "Invalid expected connections.");
            BigInteger count = new BigInteger(expected), space = BigInteger.ONE.shiftLeft(256); require(count.compareTo(space) <= 0, "Expected connections out of range.");
            String target = space.divide(count).subtract(BigInteger.ONE).toString(16); target = zeros(64 - target.length()) + target;
            int mask = source.getInt("mask"); output.put("type", 2).put("domain", domain).put("target", target).put("rootVersion", 1).put("mask", mask);
        }
        require(value >= dust(output), "Recipient amount is below dust."); return output;
    }
    /** A plan is held only by native code and shown in a native confirmation dialog.
     * Candidate metadata is not trusted: raw parents and derived ownership are
     * checked AGAIN before signing by signPayment below. */
    public static JSONObject planPayment(JSONArray candidates, JSONArray destinations, String changeAddress, int rate, boolean deductFee) throws Exception {
        feeRate(rate); require(candidates.length() > 0 && candidates.length() <= MAX_PAYMENT_CANDIDATES && destinations.length() > 0 && destinations.length() <= 100 && (!deductFee || destinations.length() == 1), "Invalid mobile payment size.");
        JSONArray recipients = new JSONArray(); long requested = 0;
        for (int i = 0; i < destinations.length(); i++) { JSONObject output = recipient(destinations.getJSONObject(i)); recipients.put(output); requested = Math.addExact(requested, amount(output.getString("amount"))); } amount(Long.toString(requested));
        JSONObject changeOutput = new JSONObject().put("type", 1).put("amount", "0").put("publicKey", WalletCrypto.hex(WalletCrypto.decodeAddress(changeAddress)));
        List<PaymentCandidate> sorted = new ArrayList<>(); HashSet<String> seen = new HashSet<>();
        for (int i = 0; i < candidates.length(); i++) {
            JSONObject candidate = candidates.getJSONObject(i); long value = amount(candidate.getString("amount"));
            require(seen.add(WalletCrypto.hex(outpoint(candidate))), "Duplicate funding output."); sorted.add(new PaymentCandidate(candidate, value));
        }
        final long wanted = requested;
        sorted.sort((a,b) -> { if (deductFee && (a.value == wanted) != (b.value == wanted)) return a.value == wanted ? -1 : 1; return Long.compare(b.value, a.value); });
        PaymentSize size = new PaymentSize(recipients, changeOutput); long changeDust = dust(changeOutput);
        JSONArray selected = new JSONArray(), inputs = new JSONArray(); long sum = 0, fee = -1, change = 0, total = requested; JSONObject tx = new JSONObject().put("version", 2).put("locktime", 0).put("inputs", inputs).put("outputs", recipients);
        for (PaymentCandidate funding : sorted) {
            int count = inputs.length() + 1;
            paymentSize(count <= MAX_PAYMENT_INPUTS && size.weight(count, false) <= MAX_WEIGHT);
            JSONObject candidate = snapshotCandidate(funding.metadata);
            selected.put(candidate); sum = Math.addExact(sum, funding.value); amount(Long.toString(sum));
            inputs.put(new JSONObject().put("txid", candidate.getString("txid")).put("vout", candidate.getLong("vout")).put("scriptSig", "").put("sequence", 0xfffffffdL).put("witness", new JSONArray().put(zeros(128))));
            if (deductFee) {
                if (sum < requested) continue;
                long remaining = sum - requested; change = remaining == 0 ? 0 : Math.max(remaining, changeDust);
                paymentSize(size.weight(count, change > 0) <= MAX_WEIGHT);
                JSONArray outputs = new JSONArray(recipients.toString()); if (change > 0) outputs.put(new JSONObject(changeOutput.toString()).put("amount", Long.toString(change)));
                tx.put("outputs", outputs); fee = (long)size.vsize(count, change > 0) * rate; total = requested - fee - (change - remaining);
                require(total >= dust(outputs.getJSONObject(0)), "Payment after fee is below dust."); outputs.getJSONObject(0).put("amount", Long.toString(total)); break;
            }
            long withChangeFee = (long)size.vsize(count, true) * rate, candidateChange = sum - requested - withChangeFee;
            if (candidateChange >= changeDust) {
                paymentSize(size.weight(count, true) <= MAX_WEIGHT);
                change = candidateChange; fee = withChangeFee;
                tx.put("outputs", new JSONArray(recipients.toString()).put(new JSONObject(changeOutput.toString()).put("amount", Long.toString(change)))); break;
            }
            long minimum = (long)size.vsize(count, false) * rate;
            if (sum >= requested + minimum) { fee = sum - requested; break; }
        }
        require(fee >= 0, "Insufficient funds for payment and fee."); require(fee <= COIN, "Fee exceeds the 1 CONN safety limit.");
        int weight = serialize(tx, false).length * 3 + serialize(tx, true).length;
        paymentSize(weight <= MAX_WEIGHT);
        require((weight + 3) / 4 == size.vsize(inputs.length(), change > 0), "Payment size differs from its fee estimate.");
        return new JSONObject().put("transaction", tx).put("selected", selected).put("fee", Long.toString(fee)).put("total", Long.toString(total)).put("requestedTotal", Long.toString(requested)).put("inputTotal", Long.toString(sum)).put("change", Long.toString(change)).put("vsize", (weight + 3) / 4);
    }
    private static final class PaymentCandidate {
        final JSONObject metadata; final long value;
        PaymentCandidate(JSONObject metadata, long value) { this.metadata = metadata; this.value = value; }
    }
    private static JSONObject snapshotCandidate(JSONObject candidate) throws Exception {
        // Strings are immutable, including large raw parents shared by many
        // outputs. Preserve them while independently snapshotting mutable JSON.
        JSONObject copy = new JSONObject(); Iterator<String> keys = candidate.keys();
        while (keys.hasNext()) {
            String key = keys.next(); Object value = candidate.get(key);
            if (value instanceof JSONObject) value = new JSONObject(value.toString());
            else if (value instanceof JSONArray) value = new JSONArray(value.toString());
            copy.put(key, value);
        }
        return copy;
    }
    static final class PaymentSize {
        final int recipientCount, recipientBytes, changeBytes;
        PaymentSize(JSONArray recipients, JSONObject changeOutput) throws Exception {
            recipientCount = recipients.length(); int total = 0;
            for (int i = 0; i < recipientCount; i++) total += outputBytes(recipients.getJSONObject(i)).length;
            recipientBytes = total; changeBytes = outputBytes(changeOutput).length;
        }
        int weight(int inputs, boolean change) {
            // Native P2PK inputs have 41 stripped bytes and one 64-byte Schnorr
            // signature: 66 witness bytes. Include CompactSize and marker/flag.
            int base = 8 + compact(inputs).length + 41 * inputs + compact(recipientCount + (change ? 1 : 0)).length + recipientBytes + (change ? changeBytes : 0);
            return base * 4 + 2 + 66 * inputs;
        }
        int vsize(int inputs, boolean change) { return (weight(inputs, change) + 3) / 4; }
    }
    public static JSONObject signPayment(JSONObject plan, VaultSession session) throws Exception {
        return signPayment(plan, session, () -> {});
    }
    /** Signing remains on the worker; a caller can revoke its held session
     * between inputs without locking the UI for the whole transaction. */
    public static JSONObject signPayment(JSONObject plan, VaultSession session, FundingCheck check) throws Exception {
        check.check();
        JSONObject tx = new JSONObject(plan.getJSONObject("transaction").toString()); JSONArray selected = plan.getJSONArray("selected"), spent = new JSONArray();
        require(selected.length() > 0 && selected.length() <= MAX_PAYMENT_INPUTS, PAYMENT_WEIGHT_ERROR);
        require(tx.getJSONArray("inputs").length() == selected.length(), "Payment plan changed."); long inputTotal = 0, outputTotal = 0;
        int plannedWeight = serialize(tx, false).length * 3 + serialize(tx, true).length;
        require(plannedWeight <= MAX_WEIGHT, PAYMENT_WEIGHT_ERROR);
        Map<String, FundingParent> parents = new HashMap<>(); Map<String, JSONObject> accounts = new HashMap<>();
        for (int i = 0; i < selected.length(); i++) {
            check.check();
            JSONObject input = selected.getJSONObject(i); int index = input.getInt("index"), change = input.getInt("change");
            String path = change + ":" + index; JSONObject account = accounts.get(path);
            if (account == null) { account = session.publicAccount(index, change); accounts.put(path, account); }
            require(Arrays.equals(outpoint(input), outpoint(tx.getJSONArray("inputs").getJSONObject(i))), "Selected input changed.");
            String raw = input.getString("rawTransaction"); FundingParent parent = parents.get(raw);
            if (parent == null) { parent = new FundingParent(raw); parents.put(raw, parent); }
            // Cached parsing never replaces per-selected-output identity,
            // amount, index or derived-ownership authentication.
            JSONObject output = checkFundingOutput(input, account.getString("publicKey"), parent); spent.put(output); inputTotal = Math.addExact(inputTotal, amount(output.getString("amount"))); amount(Long.toString(inputTotal));
        }
        for (int i = 0; i < tx.getJSONArray("outputs").length(); i++) outputTotal = Math.addExact(outputTotal, amount(tx.getJSONArray("outputs").getJSONObject(i).getString("amount")));
        require(inputTotal - outputTotal == amount(plan.getString("fee")) && inputTotal - outputTotal <= COIN && (plannedWeight + 3) / 4 == plan.getInt("vsize"), "Payment totals changed.");
        check.check();
        PaymentSignatureHashes hashes = new PaymentSignatureHashes(tx, spent);
        for (int i = 0; i < selected.length(); i++) {
            check.check(); JSONObject input = selected.getJSONObject(i);
            byte[] signature = session.signDigest(hashes.forInput(i), input.getInt("index"), input.getInt("change"));
            tx.getJSONArray("inputs").getJSONObject(i).put("witness", new JSONArray().put(WalletCrypto.hex(signature)));
            check.check();
        }
        byte[] signed = serialize(tx, true); int signedWeight = serialize(tx, false).length * 3 + signed.length;
        require(signedWeight <= MAX_WEIGHT, PAYMENT_WEIGHT_ERROR);
        require((signedWeight + 3) / 4 == plan.getInt("vsize"), "Signed payment size changed.");
        check.check();
        return new JSONObject().put("hex", WalletCrypto.hex(signed)).put("txid", txid(tx)).put("fee", plan.getString("fee"));
    }
}
