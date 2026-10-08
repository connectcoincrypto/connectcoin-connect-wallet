package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.json.JSONObject;

/** Caller cancellation without a second timeout that mistakes intentional quota waiting for network failure. */
final class MobileRpcAwait {
    interface Check { void check() throws Exception; }
    interface CancelUnsent { boolean cancel(CompletableFuture<JSONObject> future); }
    private static final class Pending extends Exception {}
    private MobileRpcAwait() {}

    static JSONObject read(CompletableFuture<JSONObject> future, Check check) throws Exception {
        try {
            while (true) {
                check.check();
                try { JSONObject response = result(future); check.check(); return response; }
                catch (Pending pending) { /* The transport owns DNS/network deadlines; the caller owns lifecycle/budget. */ }
            }
        } finally { if (!future.isDone()) future.cancel(false); }
    }

    static JSONObject broadcast(CompletableFuture<JSONObject> future, Check check, CancelUnsent cancelUnsent) throws Exception {
        while (true) {
            try { check.check(); }
            catch (Exception revoked) {
                // Revocation can cancel a queued payment, never obscure an
                // already-written transaction's real reply or unknown outcome.
                cancelUnsent.cancel(future);
            }
            try { return result(future); }
            catch (Pending pending) { /* No automatic re-enqueue or broadcast retry. */ }
        }
    }

    private static JSONObject result(CompletableFuture<JSONObject> future) throws Exception {
        try { return future.get(100, TimeUnit.MILLISECONDS); }
        catch (TimeoutException pending) { throw new Pending(); }
        catch (ExecutionException failed) {
            if (failed.getCause() instanceof Exception) throw (Exception) failed.getCause();
            throw failed;
        }
    }
}
