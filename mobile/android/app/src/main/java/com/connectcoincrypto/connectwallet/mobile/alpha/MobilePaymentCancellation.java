package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentReservations;
import org.json.JSONObject;

/** Durable recovery only for a transport-proven pre-write cancellation.
 * The caller must hold PAYMENT_STORAGE across this complete operation. */
final class MobilePaymentCancellation {
    interface Store {
        JSONObject reservations() throws Exception;
        void receipt(JSONObject receipt) throws Exception;
        void reservations(JSONObject reservations) throws Exception;
    }
    private MobilePaymentCancellation() {}

    static boolean recordIfUnsent(Exception error, JSONObject signed, JSONObject previousReservations, Store store) throws Exception {
        if (!(error instanceof MobileRpcClient.RpcFailure)) return false;
        MobileRpcClient.RpcFailure failure = (MobileRpcClient.RpcFailure) error;
        if (failure.unknownOutcome || !"RPC_CANCELLED".equals(failure.code)) return false;
        if (signed == null || store == null) throw new IllegalArgumentException("Missing unsent payment storage context.");
        JSONObject receipt = new JSONObject(signed.toString()).put("broadcast_status", "not-sent");
        JSONObject released = NativePaymentReservations.releaseNotSent(store.reservations(), receipt.getString("txid"), previousReservations);
        // Never release coins while their only durable receipt still denotes
        // an indeterminate financial operation. A failed write propagates to
        // the caller's conservative check-required handling.
        store.receipt(receipt);
        store.reservations(released);
        return true;
    }
}
