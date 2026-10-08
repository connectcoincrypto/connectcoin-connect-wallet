package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;

import org.junit.Test;
import org.json.JSONObject;

public final class NativeWalletErrorsTest {
    @Test public void explicitDialogCancellationHasDistinctCode() {
        NativeWalletErrors.Cancelled error = new NativeWalletErrors.Cancelled();
        assertEquals("CANCELLED", NativeWalletErrors.code(error));
        assertEquals("Cancelled.", error.getMessage());
    }

    @Test public void matchingTextDoesNotConvertFailureIntoCancellation() {
        assertEquals("WALLET_ERROR", NativeWalletErrors.code(new IllegalStateException("Cancelled.")));
        assertEquals("WALLET_ERROR", NativeWalletErrors.code(new IllegalArgumentException("Cancelled.")));
        assertEquals("WALLET_ERROR", NativeWalletErrors.code(new java.io.IOException("Cancelled.")));
    }

    @Test public void lifecycleFundingAndSubmissionErrorsRemainFailures() {
        for (String message : new String[] {
                "Wallet operation interrupted.", "Wallet operation cancelled.", "Wallet is locked.",
                "Insufficient funds for payment and fee.", "Previous submission outcome may be unknown." }) {
            assertEquals("WALLET_ERROR", NativeWalletErrors.code(new IllegalStateException(message)));
        }
        assertEquals("WALLET_ERROR", NativeWalletErrors.code(new java.util.concurrent.CancellationException()));
    }
    @Test public void publicReadBridgePreservesOnlyRecoveryCodesNotServerMessages() throws Exception {
        for (int code : new int[]{-32011, -32029, -32030, -32001, -32099}) {
            try {
                MobileRpcClient.reply(new JSONObject().put("jsonrpc", "2.0").put("id", "fixture")
                    .put("error", new JSONObject().put("code", code).put("message", "untrusted raw server error")), "fixture");
                fail("Expected fixture error");
            } catch (MobileRpcClient.RpcFailure failure) {
                String expected = code == -32099 ? "RPC_UNAVAILABLE" : Integer.toString(code);
                assertEquals(expected, NativeWalletErrors.publicReadCode(failure));
                assertEquals(expected, NativeWalletErrors.publicReadCode(new java.util.concurrent.CompletionException(failure)));
            }
        }
        assertEquals("RPC_UNAVAILABLE", NativeWalletErrors.publicReadCode(new IllegalStateException("-32011")));
    }
}
