package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;

/** Immutable native send intent. No renderer-supplied fee totals, transaction, inputs or signing operation. */
public final class NativeSendPolicy {
    private NativeSendPolicy() {}
    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalArgumentException(message);
    }
    public static Request request(JSONObject input) throws Exception {
        require(input != null && input.length() == (input.has("fundingAddresses") ? 6 : 5) && input.opt("address") instanceof String
            && input.opt("amount") instanceof String && input.opt("feeRate") instanceof String
            && input.opt("subtractFeeFromAmount") instanceof Boolean && input.opt("useAllBalance") instanceof Boolean,
            "Enter an address, decimal CONN amount, fee rate and payment options.");
        String rate = input.getString("feeRate");
        require(rate.matches("[1-9][0-9]{0,5}"), "Fee rate must be 1,201–100,000 connects/vbyte.");
        int feeRate = Integer.parseInt(rate);
        require(feeRate >= 1201 && feeRate <= 100000, "Fee rate must be 1,201–100,000 connects/vbyte.");
        boolean deduct = input.getBoolean("subtractFeeFromAmount"), useAll = input.getBoolean("useAllBalance");
        require(!useAll || deduct, "Use all balance requires deducting the fee from the payment.");
        Request request = new Request(WalletCrypto.encodeAddress(WalletCrypto.decodeAddress(input.getString("address"))),
            Long.toString(NativeTransactions.coinAmount(input.getString("amount"))), feeRate, deduct, useAll, NativeFundingScope.optional(input));
        NativeTransactions.recipient(request.destination());
        return request;
    }
    public static final class Request {
        public final String address, amount;
        public final int feeRate;
        public final boolean subtractFeeFromAmount, useAllBalance;
        public final NativeFundingScope fundingScope;
        private Request(String address, String amount, int feeRate, boolean subtractFeeFromAmount, boolean useAllBalance, NativeFundingScope fundingScope) {
            this.address = address; this.amount = amount; this.feeRate = feeRate;
            this.subtractFeeFromAmount = subtractFeeFromAmount; this.useAllBalance = useAllBalance;
            this.fundingScope = fundingScope;
        }
        public JSONObject destination() throws Exception { return new JSONObject().put("address", address).put("amount", amount); }
        /** Compare the user's displayed balance with fresh confirmed, mature,
         * locally and remotely unreserved candidates. Never silently enlarge a sweep. */
        private void verifyAvailable(JSONArray candidates) throws Exception {
            if (!useAllBalance) return;
            long available = 0;
            for (int i = 0; i < candidates.length(); i++) {
                JSONObject candidate = candidates.getJSONObject(i);
                require(Boolean.TRUE.equals(candidate.opt("mature")) && "confirmed".equals(candidate.opt("status"))
                    && candidate.has("pending_spent_by") && candidate.isNull("pending_spent_by"),
                    "Use all balance cannot include immature, pending or reserved funds. Refresh the balance and try again.");
                available = Math.addExact(available, NativeTransactions.amount(candidate.getString("amount")));
                NativeTransactions.amount(Long.toString(available));
            }
            require(Long.toString(available).equals(amount),
                "Available funds changed or are reserved by pending or uncertain payments. Refresh the balance and use all again.");
        }
        public JSONObject plan(JSONArray candidates, String changeAddress) throws Exception {
            verifyAvailable(candidates);
            return NativeTransactions.planPayment(candidates, new JSONArray().put(destination()), changeAddress, feeRate, subtractFeeFromAmount);
        }
        /** Recompute exact recipient, dust handling, fee and input ordering from
         * the held native selection. The signer separately authenticates every
         * raw parent and its derived ownership immediately before signing. */
        public void verifyPlan(JSONObject plan, String changeAddress) throws Exception {
            JSONObject expected = plan(plan.getJSONArray("selected"), changeAddress);
            for (String field : new String[]{"fee", "total", "requestedTotal", "inputTotal", "change", "vsize"}) {
                require(expected.get(field).equals(plan.opt(field)), "Payment review changed. Review again.");
            }
            JSONObject transaction = plan.getJSONObject("transaction"), expectedTransaction = expected.getJSONObject("transaction");
            require(Arrays.equals(NativeTransactions.serialize(expectedTransaction, true), NativeTransactions.serialize(transaction, true)),
                "Payment destination, fee or change changed. Review again.");
            if (useAllBalance) require(amount.equals(plan.getString("inputTotal")) && "0".equals(plan.getString("change")),
                "Available funds changed. Refresh the balance and use all again.");
        }
        public String review(JSONObject plan, String changeAddress) throws Exception {
            verifyPlan(plan, changeAddress);
            long requested = NativeTransactions.amount(amount), received = NativeTransactions.amount(plan.getString("total"));
            long fee = NativeTransactions.amount(plan.getString("fee")), change = NativeTransactions.amount(plan.getString("change"));
            long adjustment = subtractFeeFromAmount ? requested - received - fee : 0;
            return "MAINNET\n\nTo: " + address
                + "\nEntered amount: " + NativeTransactions.format(requested) + " CONN"
                + "\nRecipient receives: " + NativeTransactions.format(received) + " CONN"
                + "\nMining fee" + (subtractFeeFromAmount ? " (deducted)" : " (added)") + ": " + NativeTransactions.format(fee) + " CONN"
                + "\nFee rate: " + feeRate + " connects/vbyte"
                + (adjustment > 0 ? "\nKept as spendable change: " + NativeTransactions.format(adjustment) + " CONN" : "")
                + "\nTotal paid: " + NativeTransactions.format(Math.addExact(received, fee)) + " CONN"
                + "\nSelected input total: " + NativeTransactions.format(NativeTransactions.amount(plan.getString("inputTotal"))) + " CONN"
                + "\nChange: " + NativeTransactions.format(change) + " CONN"
                + "\nWallet change address: " + changeAddress
                + (useAllBalance ? "\n\nUsing all currently available confirmed funds" + (fundingScope == null ? "" : " in the selected address scope")
                    + ", with the fee deducted. Immature, pending and reserved funds are excluded." : "");
        }
    }
}
