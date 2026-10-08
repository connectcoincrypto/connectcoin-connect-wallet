package com.connectcoincrypto.connectwallet.mobile.alpha;

/** Distinguish an explicit native-dialog cancellation from actual failures. */
final class NativeWalletErrors {
    private NativeWalletErrors() {}

    static final class Cancelled extends IllegalStateException {
        private static final long serialVersionUID = 1L;
        Cancelled() { super("Cancelled."); }
    }

    static String code(Exception error) {
        return error instanceof Cancelled ? "CANCELLED" : "WALLET_ERROR";
    }
    /** Only fixed transport codes cross the public-read bridge, never a server
     * supplied message or data. Expired journal cursors require a new baseline. */
    static String publicReadCode(Throwable error) {
        Throwable current = error;
        for (int depth = 0; depth < 8 && (current instanceof java.util.concurrent.CompletionException || current instanceof java.util.concurrent.ExecutionException)
                && current.getCause() != null; depth++) current = current.getCause();
        if (current instanceof MobileRpcClient.RpcFailure) {
            MobileRpcClient.RpcFailure failure = (MobileRpcClient.RpcFailure)current;
            if (!failure.unknownOutcome && ("-32011".equals(failure.code) || "-32029".equals(failure.code)
                    || "-32030".equals(failure.code) || "-32001".equals(failure.code)
                    || "RPC_TIMEOUT".equals(failure.code) || "RPC_CANCELLED".equals(failure.code))) return failure.code;
        }
        return "RPC_UNAVAILABLE";
    }
}
