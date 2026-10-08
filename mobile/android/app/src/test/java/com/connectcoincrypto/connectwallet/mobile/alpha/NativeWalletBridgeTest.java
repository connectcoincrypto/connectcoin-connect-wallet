package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.assertEquals;

import com.getcapacitor.PluginMethod;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

/** Checks the compiled bridge surface without starting Android or a wallet. */
public final class NativeWalletBridgeTest {
    @Test public void compiledPluginExposesOnlyApprovedWalletAndFrameworkMethods() {
        Set<String> actual = new HashSet<>();
        for (Method method : NativeWalletPlugin.class.getMethods()) {
            if (method.isAnnotationPresent(PluginMethod.class)) actual.add(method.getName());
        }
        // Independent approval list, not inferred from the source or runtime.
        assertEquals(new HashSet<>(Arrays.asList(
            "getState", "getSettings", "saveSettings", "lock", "create", "importRecovery", "importWallet", "exportWallet",
            "changePassword", "viewRecoveryPhrase", "unlock", "reviewPayment", "reviewP2C", "getPaymentBatch", "dismissPaymentBatch",
            "queryPublic", "watchAccount", "readPaymentClipboard", "newAddress", "recoverAddresses", "getRecoverySnapshots",
            "claimsState", "claimsLimits", "claimsPolicy", "claimsStart", "claimsStop", "claimsCheckSubmission",
            "addListener", "removeListener", "removeAllListeners", "checkPermissions", "requestPermissions")), actual);
    }
}
