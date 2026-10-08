package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Test;

public class WalletVaultUpdateSessionTest {
    @Test public void updatesMetadataWithFreshNoncePreservesDesktopPayloadAndNeedsNoPasswordAgain() throws Exception {
        char[] password = DesktopVectors.PASSWORD.toCharArray();
        JSONObject saved;
        try (WalletVault.UpdateSession session = WalletVault.openForUpdate(WalletVault.parse(DesktopVectors.ENVELOPE), password)) {
            Arrays.fill(password, '\0');
            JSONObject original = session.payload();
            JSONObject next = session.payload().put("receiveIndex", 8).put("unknownFutureField", new JSONObject().put("preserve", true));
            String originalNonce = session.envelope().getString("nonce");
            JSONObject[] written = {null}; session.save(next, envelope -> written[0] = envelope);
            saved = written[0]; assertNotNull(saved);
            assertNotEquals(originalNonce, saved.getString("nonce"));
            assertEquals(WalletVault.parse(DesktopVectors.ENVELOPE).getString("salt"), saved.getString("salt"));
            assertEquals(original.getString("passphrase"), session.payload().getString("passphrase"));
            assertEquals(8, session.payload().getInt("receiveIndex"));
            assertTrue(session.payload().getJSONObject("unknownFutureField").getBoolean("preserve"));
            next.put("receiveIndex", 99); written[0].put("ciphertext", "00");
            assertEquals(8, session.payload().getInt("receiveIndex"));
            saved = session.envelope();
        }
        JSONObject reopened = WalletVault.decrypt(saved, DesktopVectors.PASSWORD.toCharArray());
        assertEquals(8, reopened.getInt("receiveIndex"));
        assertTrue(reopened.getJSONObject("unknownFutureField").getBoolean("preserve"));
    }
    @Test public void failedWritesAndIdentityChangesDoNotPublishNewMetadata() throws Exception {
        try (WalletVault.UpdateSession session = WalletVault.openForUpdate(WalletVault.parse(DesktopVectors.ENVELOPE), DesktopVectors.PASSWORD.toCharArray())) {
            String before = session.envelope().toString(); int index = session.payload().getInt("receiveIndex");
            assertThrows(Exception.class, () -> session.save(session.payload().put("receiveIndex", 99), envelope -> { throw new Exception("Synthetic disk failure"); }));
            assertEquals(index, session.payload().getInt("receiveIndex")); assertEquals(before, session.envelope().toString());
            AtomicInteger writes = new AtomicInteger();
            for (String field : new String[]{"mnemonic", "passphrase", "network"}) {
                JSONObject next = session.payload().put(field, field.equals("mnemonic") ? "legal winner thank year wave sausage worth useful legal winner thank yellow" : "other");
                assertThrows(IllegalArgumentException.class, () -> session.save(next, envelope -> writes.incrementAndGet()));
            }
            assertEquals(0, writes.get());
        }
    }
    @Test public void lockWipesRetainedKeyAndRevokesInFlightPublication() throws Exception {
        WalletVault.UpdateSession session = WalletVault.openForUpdate(WalletVault.parse(DesktopVectors.ENVELOPE), DesktopVectors.PASSWORD.toCharArray());
        java.lang.reflect.Field keyField = WalletVault.UpdateSession.class.getDeclaredField("key"); keyField.setAccessible(true);
        byte[] retainedKey = (byte[])keyField.get(session); assertNotNull(retainedKey);
        assertThrows(IllegalStateException.class, () -> session.save(session.payload().put("receiveIndex", 9), envelope -> session.close()));
        assertArrayEquals(new byte[32], retainedKey); assertNull(keyField.get(session));
        assertThrows(IllegalStateException.class, session::payload); assertThrows(IllegalStateException.class, session::envelope);
        session.close();
    }
    @Test public void recoveryFlagsMustBeBooleans() throws Exception {
        for (String field : new String[]{"needsRecovery", "scanLookahead", "mobileHdRecovered"}) {
            JSONObject payload = WalletVault.newPayload("Fixture", DesktopVectors.MNEMONIC, "").put(field, "false");
            assertThrows(IllegalArgumentException.class, () -> WalletVault.validatePayload(payload));
        }
    }
}
