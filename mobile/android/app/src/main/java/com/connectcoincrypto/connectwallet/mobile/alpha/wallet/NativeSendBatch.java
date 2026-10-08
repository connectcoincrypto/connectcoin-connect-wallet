package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Pure ordinary-payment planning. Parts spend disjoint original funding, never
 * an earlier part's change. Signing, reservations and submission remain native. */
public final class NativeSendBatch {
    public static final int MAX_TRANSACTIONS = 32;
    private static final int MAX_PLANNING_STEPS = 8_000_000;
    private static final String UNECONOMIC = "These inputs cannot form economical independent payments. Enter a smaller amount or use different funding.";
    private NativeSendBatch() {}
    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalArgumentException(message);
    }
    private static long amount(JSONObject object, String field) throws Exception {
        return NativeTransactions.amount(object.getString(field));
    }
    private static long add(long first, long second) {
        long sum = Math.addExact(first, second);
        NativeTransactions.amount(Long.toString(sum));
        return sum;
    }

    public static JSONObject plan(NativeSendPolicy.Request request, JSONArray candidates, String changeAddress) throws Exception {
        require(request != null && candidates != null, "Missing payment intent or funding.");
        try {
            // Preserve all existing single-payment selection, replacements,
            // fee/dust handling and use-all freshness checks verbatim.
            return aggregate(request, new JSONArray().put(request.plan(candidates, changeAddress)));
        } catch (NativeTransactions.PaymentTooLarge oversized) {
            return multiple(request, candidates, changeAddress);
        }
    }

    private static final class Candidate {
        final JSONObject metadata;
        final long value;
        Candidate(JSONObject metadata) throws Exception { this.metadata = metadata; value = amount(metadata, "amount"); }
    }
    private static final class Slice {
        final int start, end;
        final long contribution;
        Slice(int start, int end, long contribution) { this.start = start; this.end = end; this.contribution = contribution; }
    }
    private enum Outcome { FITS, OVERSIZED, UNECONOMIC, INSUFFICIENT }
    private static final class SearchBudget {
        private int remaining = MAX_PLANNING_STEPS;
        void step() {
            require(--remaining >= 0, "Payment requires too much input rebalancing. Enter a smaller amount or use different funding.");
        }
    }
    private static final class FinalSlice {
        final Outcome outcome;
        final int start, end;
        FinalSlice(Outcome outcome, int start, int end) { this.outcome = outcome; this.start = start; this.end = end; }
    }

    private static JSONObject multiple(NativeSendPolicy.Request request, JSONArray candidates, String changeAddress) throws Exception {
        // The initial native planner has already authenticated integer amounts,
        // canonical outpoint uniqueness, address syntax and the candidate cap.
        // Fresh inventory and raw-parent ownership are checked by the caller.
        List<Candidate> sorted = new ArrayList<>();
        for (int i = 0; i < candidates.length(); i++) {
            JSONObject candidate = candidates.getJSONObject(i);
            require(Boolean.TRUE.equals(candidate.opt("mature")) && "confirmed".equals(candidate.opt("status"))
                && candidate.has("pending_spent_by") && candidate.isNull("pending_spent_by"),
                "Multiple payments require confirmed, mature, unreserved original inputs. Pending replacements cannot be split.");
            sorted.add(new Candidate(candidate));
        }
        sorted.sort((first, second) -> Long.compare(second.value, first.value));
        long[] prefix = new long[sorted.size() + 1];
        for (int i = 0; i < sorted.size(); i++) prefix[i + 1] = add(prefix[i], sorted.get(i).value);
        long requested = NativeTransactions.amount(request.amount);
        require(!request.useAllBalance || prefix[sorted.size()] == requested,
            "Available funds changed. Refresh the balance and use all again.");
        JSONObject recipient = NativeTransactions.recipient(request.destination());
        JSONObject change = new JSONObject().put("type", 1).put("amount", "0")
            .put("publicKey", WalletCrypto.hex(WalletCrypto.decodeAddress(changeAddress)));
        NativeTransactions.PaymentSize size = new NativeTransactions.PaymentSize(new JSONArray().put(recipient), change);
        long dust = NativeTransactions.dust(recipient), changeDust = NativeTransactions.dust(change);
        List<Slice> slices = new ArrayList<>();
        SearchBudget budget = new SearchBudget();
        int start = 0, nextLimit = NativeTransactions.MAX_PAYMENT_INPUTS;
        long remaining = requested;
        FinalSlice last;
        while (true) {
            budget.step();
            last = finalSlice(sorted, start, remaining, request, size, dust, changeDust, budget);
            if (last.outcome == Outcome.FITS) break;
            require(last.outcome != Outcome.INSUFFICIENT, "Insufficient funds for payment and all transaction fees.");
            if (last.outcome == Outcome.OVERSIZED) {
                int count = Math.min(nextLimit, Math.min(NativeTransactions.MAX_PAYMENT_INPUTS, sorted.size() - start - 1));
                long contribution = 0;
                for (; count > 0; count--) {
                    budget.step();
                    long sum = prefix[start + count] - prefix[start];
                    long fee = (long)size.vsize(count, false) * request.feeRate;
                    contribution = request.subtractFeeFromAmount ? sum : sum - fee;
                    long minimumFinal = dust + (request.subtractFeeFromAmount ? (long)size.vsize(1, false) * request.feeRate : 0);
                    if (sum - fee >= dust && contribution > 0 && remaining - contribution >= minimumFinal) break;
                }
                if (count > 0) {
                    require(slices.size() + 1 < MAX_TRANSACTIONS, "Payment exceeds the 32-transaction safety limit.");
                    slices.add(new Slice(start, start + count, contribution));
                    start += count; remaining -= contribution; nextLimit = NativeTransactions.MAX_PAYMENT_INPUTS;
                    continue;
                }
            }
            // A tiny last group may not pay its own fee. Move the last boundary
            // backwards, retaining every input and reallocating the exact amount.
            // Only arithmetic runs during this search: no repeated raw-parent
            // JSON cloning or transaction serialization as boundaries move.
            require(!slices.isEmpty(), UNECONOMIC);
            Slice previous = slices.remove(slices.size() - 1);
            start = previous.start; remaining = add(remaining, previous.contribution);
            nextLimit = previous.end - previous.start - 1;
            require(nextLimit > 0, UNECONOMIC);
        }
        require(slices.size() + 1 <= MAX_TRANSACTIONS, "Payment exceeds the 32-transaction safety limit.");
        JSONArray plans = new JSONArray();
        for (Slice slice : slices) {
            long sum = prefix[slice.end] - prefix[slice.start];
            JSONObject part = NativeTransactions.planPayment(range(sorted, slice.start, slice.end),
                new JSONArray().put(new JSONObject().put("address", request.address).put("amount", Long.toString(sum))),
                changeAddress, request.feeRate, true);
            require(part.getJSONArray("selected").length() == slice.end - slice.start && "0".equals(part.getString("change")), UNECONOMIC);
            plans.put(part);
        }
        JSONObject finalPart = NativeTransactions.planPayment(range(sorted, last.start, last.end),
            new JSONArray().put(new JSONObject().put("address", request.address).put("amount", Long.toString(remaining))),
            changeAddress, request.feeRate, request.subtractFeeFromAmount);
        require(finalPart.getJSONArray("selected").length() == last.end - last.start, "Payment selection changed. Review again.");
        plans.put(finalPart);
        JSONObject result = aggregate(request, plans);
        require(!request.useAllBalance || result.getJSONArray("selected").length() == candidates.length(), UNECONOMIC);
        return result;
    }

    /** Estimate only an ordinary one-recipient final part, using the native
     * planner's exact size model. Actual plans are always built by planPayment. */
    private static FinalSlice finalSlice(List<Candidate> sorted, int start, long wanted,
            NativeSendPolicy.Request request, NativeTransactions.PaymentSize size, long dust, long changeDust, SearchBudget budget) {
        if (wanted < dust) return new FinalSlice(Outcome.UNECONOMIC, start, start);
        if (request.subtractFeeFromAmount && !request.useAllBalance) {
            // Preserve native deducted-payment exact-match priority. Such an
            // input can be below larger unused candidates in the final suffix.
            for (int i = start; i < sorted.size(); i++) {
                budget.step();
                if (sorted.get(i).value == wanted) {
                    return new FinalSlice(wanted - (long)size.vsize(1, false) * request.feeRate >= dust
                        ? Outcome.FITS : Outcome.UNECONOMIC, i, i + 1);
                }
            }
        }
        long sum = 0;
        for (int end = start; end < sorted.size(); end++) {
            budget.step();
            int count = end - start + 1;
            if (count > NativeTransactions.MAX_PAYMENT_INPUTS || size.weight(count, false) > NativeTransactions.MAX_WEIGHT)
                return new FinalSlice(Outcome.OVERSIZED, start, end);
            sum += sorted.get(end).value;
            if (request.subtractFeeFromAmount) {
                if (sum < wanted) continue;
                long remaining = sum - wanted, change = remaining == 0 ? 0 : Math.max(remaining, changeDust);
                if (size.weight(count, change > 0) > NativeTransactions.MAX_WEIGHT)
                    return new FinalSlice(Outcome.OVERSIZED, start, end + 1);
                long fee = (long)size.vsize(count, change > 0) * request.feeRate;
                return new FinalSlice(wanted - fee - (change - remaining) >= dust ? Outcome.FITS : Outcome.UNECONOMIC, start, end + 1);
            }
            long withChangeFee = (long)size.vsize(count, true) * request.feeRate;
            if (sum - wanted - withChangeFee >= changeDust) {
                return new FinalSlice(size.weight(count, true) <= NativeTransactions.MAX_WEIGHT ? Outcome.FITS : Outcome.OVERSIZED, start, end + 1);
            }
            if (sum - wanted >= (long)size.vsize(count, false) * request.feeRate)
                return new FinalSlice(Outcome.FITS, start, end + 1);
        }
        return new FinalSlice(Outcome.INSUFFICIENT, start, sorted.size());
    }

    private static JSONArray range(List<Candidate> candidates, int start, int end) {
        JSONArray result = new JSONArray();
        for (int i = start; i < end; i++) result.put(candidates.get(i).metadata);
        return result;
    }
    private static JSONObject aggregate(NativeSendPolicy.Request request, JSONArray plans) throws Exception {
        require(plans.length() > 0 && plans.length() <= MAX_TRANSACTIONS, "Invalid payment batch size.");
        JSONArray selected = new JSONArray();
        long fee = 0, received = 0, input = 0, change = 0;
        for (int i = 0; i < plans.length(); i++) {
            JSONObject part = plans.getJSONObject(i);
            fee = add(fee, amount(part, "fee")); received = add(received, amount(part, "total"));
            input = add(input, amount(part, "inputTotal")); change = add(change, amount(part, "change"));
            require(i == plans.length() - 1 || "0".equals(part.getString("change")), "Only the final payment may return change.");
            JSONArray inputs = part.getJSONArray("selected");
            for (int j = 0; j < inputs.length(); j++) selected.put(inputs.getJSONObject(j));
        }
        require(selected.length() <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Payment exceeds the input safety limit.");
        require(fee <= NativeTransactions.COIN, "Total batch fee exceeds the 1 CONN safety limit.");
        long requested = NativeTransactions.amount(request.amount);
        require(input == add(add(received, fee), change), "Payment totals changed. Review again.");
        require(request.subtractFeeFromAmount ? received + fee <= requested : received == requested,
            "Payment amount changed. Review again.");
        require(!request.useAllBalance || input == requested && change == 0,
            "Available funds changed. Refresh the balance and use all again.");
        return new JSONObject().put("plans", plans).put("selected", selected).put("fee", Long.toString(fee))
            .put("total", Long.toString(received)).put("requestedTotal", request.amount).put("inputTotal", Long.toString(input))
            .put("change", Long.toString(change)).put("transactionCount", plans.length());
    }

    public static void verify(NativeSendPolicy.Request request, JSONObject batch, String changeAddress) throws Exception {
        require(batch != null, "Missing payment review.");
        JSONObject expected = plan(request, batch.getJSONArray("selected"), changeAddress);
        require(equalJson(expected, batch), "Payment batch, destination, fee or change changed. Review again.");
    }
    private static boolean equalJson(Object first, Object second) throws Exception {
        if (first instanceof JSONObject && second instanceof JSONObject) {
            JSONObject left = (JSONObject)first, right = (JSONObject)second;
            if (left.length() != right.length()) return false;
            Iterator<String> keys = left.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!right.has(key) || !equalJson(left.get(key), right.get(key))) return false;
            }
            return true;
        }
        if (first instanceof JSONArray && second instanceof JSONArray) {
            JSONArray left = (JSONArray)first, right = (JSONArray)second;
            if (left.length() != right.length()) return false;
            for (int i = 0; i < left.length(); i++) if (!equalJson(left.get(i), right.get(i))) return false;
            return true;
        }
        return first == second || first != null && first.equals(second);
    }

    public static String review(NativeSendPolicy.Request request, JSONObject batch, String changeAddress) throws Exception {
        verify(request, batch, changeAddress);
        JSONArray plans = batch.getJSONArray("plans");
        if (plans.length() == 1) return request.review(plans.getJSONObject(0), changeAddress);
        long requested = NativeTransactions.amount(request.amount), received = amount(batch, "total"), fee = amount(batch, "fee");
        long adjustment = request.subtractFeeFromAmount ? requested - received - fee : 0;
        StringBuilder review = new StringBuilder("MAINNET\n\nTo: ").append(request.address)
            .append("\nIndependent payments: ").append(plans.length())
            .append("\nEntered amount: ").append(NativeTransactions.format(requested)).append(" CONN")
            .append("\nRecipient receives: ").append(NativeTransactions.format(received)).append(" CONN")
            .append("\nTotal mining fee (").append(request.subtractFeeFromAmount ? "deducted" : "added").append("): ")
            .append(NativeTransactions.format(fee)).append(" CONN")
            .append("\nFee rate: ").append(request.feeRate).append(" connects/vbyte");
        if (adjustment > 0) review.append("\nKept as spendable change: ").append(NativeTransactions.format(adjustment)).append(" CONN");
        review.append("\nTotal paid: ").append(NativeTransactions.format(add(received, fee))).append(" CONN")
            .append("\nSelected input total: ").append(NativeTransactions.format(amount(batch, "inputTotal"))).append(" CONN")
            .append("\nChange: ").append(NativeTransactions.format(amount(batch, "change"))).append(" CONN")
            .append("\nWallet change address: ").append(changeAddress);
        for (int i = 0; i < plans.length(); i++) {
            JSONObject part = plans.getJSONObject(i);
            review.append("\n\nPayment ").append(i + 1).append(" of ").append(plans.length())
                .append(": recipient ").append(NativeTransactions.format(amount(part, "total"))).append(" CONN; fee ")
                .append(NativeTransactions.format(amount(part, "fee"))).append(" CONN; inputs ").append(part.getJSONArray("selected").length());
        }
        if (request.useAllBalance) review.append("\n\nUsing all currently available confirmed funds")
            .append(request.fundingScope == null ? "" : " in the selected address scope").append(", with the fee deducted.");
        return review.append("\n\nThese are separate, independent transactions and are not atomic. Earlier payments may succeed even if a later payment fails. Submission stops if an outcome is uncertain. Review the saved results before retrying.").toString();
    }
}
