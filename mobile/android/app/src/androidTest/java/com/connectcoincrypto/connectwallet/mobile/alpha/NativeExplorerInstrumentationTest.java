package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import android.content.Intent;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.Collections;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Inspects the outbound public intent only; no activity, browser or wallet is opened. */
@RunWith(AndroidJUnit4.class)
public final class NativeExplorerInstrumentationTest {
    @Test public void transactionOpensOnlyTheFixedHttpsExplorerWithoutExtraCapabilities() throws Exception {
        String txid = "0123456789abcdef".repeat(4);
        Intent intent = NativeExplorerPlugin.transactionIntent(new JSONObject().put("txid", txid));
        assertEquals(Intent.ACTION_VIEW, intent.getAction());
        assertEquals(Uri.parse("https://explorer.connectcoincrypto.com/tx/" + txid), intent.getData());
        assertEquals(Collections.singleton(Intent.CATEGORY_BROWSABLE), intent.getCategories());
        assertEquals(0, intent.getFlags());
        assertNull(intent.getExtras());
        assertNull(intent.getClipData());
        assertNull(intent.getSelector());
        assertNull(intent.getComponent());
        assertNull(intent.getPackage());
        assertNull(intent.getType());
    }

    @Test public void arbitraryUrlsCannotBecomeAnIntent() throws Exception {
        for (JSONObject options : new JSONObject[] { new JSONObject(), new JSONObject().put("url", "https://example.com"),
                new JSONObject().put("txid", "a".repeat(64)).put("url", "https://example.com"),
                new JSONObject().put("txid", "https://example.com"), new JSONObject().put("txid", "A".repeat(64)) }) {
            try { NativeExplorerPlugin.transactionIntent(options); fail("Arbitrary explorer intent accepted"); }
            catch (IllegalArgumentException expected) { assertEquals("INVALID_ARGUMENT", expected.getMessage()); }
        }
    }
}
