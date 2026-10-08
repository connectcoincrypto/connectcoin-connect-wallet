package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.google.zxing.client.android.Intents;
import com.journeyapps.barcodescanner.ScanOptions;
import java.util.Arrays;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** No camera, wallet, RPC or Activity is opened by these manifest/Intent checks. */
@RunWith(AndroidJUnit4.class)
public final class NativePaymentInputInstrumentationTest {
    private Context context;
    @Before public void isolatedEmulatorOnly() {
        assertTrue("Use an isolated Android emulator.", "ranchu".equals(Build.HARDWARE)
            || "goldfish".equals(Build.HARDWARE) || Build.MODEL.startsWith("sdk_gphone"));
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    @Test public void launchAndWarmIntentsAreConsumedNotReplayed() {
        NativePaymentInput.Mailbox mailbox = new NativePaymentInput.Mailbox();
        Intent cold = new Intent(Intent.ACTION_VIEW, Uri.parse("connectcoin:cc1pfirst"));
        assertTrue(NativePaymentInputPlugin.consumeIntent(cold, mailbox));
        assertNull(cold.getData());
        assertFalse(NativePaymentInputPlugin.consumeIntent(cold, mailbox));
        assertEquals("connectcoin:cc1pfirst", mailbox.take().text);
        assertNull(mailbox.take());
        Intent warm = new Intent(Intent.ACTION_VIEW, Uri.parse("connectcoin:cc1psecond?amount=1"));
        assertTrue(NativePaymentInputPlugin.consumeIntent(warm, mailbox));
        assertNull(warm.getData());
        assertEquals("connectcoin:cc1psecond?amount=1", mailbox.take().text);
        assertNull(mailbox.take());
        Intent wrong = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"));
        assertFalse(NativePaymentInputPlugin.consumeIntent(wrong, mailbox));
        assertNotNull(wrong.getData());
    }

    @Test public void oversizedAndMalformedUrisAreConsumedAsFixedErrors() {
        for (String uri : new String[] { "connectcoin:", "connectcoin:cc1p%xx", "connectcoin:" + "x".repeat(1024) }) {
            NativePaymentInput.Mailbox mailbox = new NativePaymentInput.Mailbox();
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
            assertTrue(NativePaymentInputPlugin.consumeIntent(intent, mailbox));
            assertNull(intent.getData());
            NativePaymentInput.Input result = mailbox.take();
            assertNull(result.text);
            assertEquals("INVALID_PAYMENT_LINK", result.error);
        }
    }

    @Test public void scannerIntentUsesOnlyInternalQrWithNoBeepOrImageFiles() {
        Intent intent = PaymentQrCaptureActivity.createIntent(context);
        assertEquals(new ComponentName(context, PaymentQrCaptureActivity.class), intent.getComponent());
        assertEquals(Intents.Scan.ACTION, intent.getAction());
        assertEquals(ScanOptions.QR_CODE, intent.getStringExtra(Intents.Scan.FORMATS));
        assertFalse(intent.getBooleanExtra(Intents.Scan.BEEP_ENABLED, true));
        assertFalse(intent.getBooleanExtra(Intents.Scan.BARCODE_IMAGE_ENABLED, true));
        assertFalse(intent.getBooleanExtra(Intents.Scan.SHOW_MISSING_CAMERA_PERMISSION_DIALOG, true));
    }

    @Test public void mergedManifestKeepsScannerPrivateAndRoutesPaymentLinksOnly() throws Exception {
        PackageManager pm = context.getPackageManager();
        ActivityInfo scanner = pm.getActivityInfo(new ComponentName(context, PaymentQrCaptureActivity.class), 0);
        assertFalse(scanner.exported);
        PackageInfo info = pm.getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS | PackageManager.GET_ACTIVITIES);
        assertTrue(Arrays.asList(info.requestedPermissions).contains(Manifest.permission.CAMERA));
        assertFalse(Arrays.asList(info.requestedPermissions).contains(Manifest.permission.VIBRATE));
        for (ActivityInfo activity : info.activities) {
            assertNotEquals("com.journeyapps.barcodescanner.CaptureActivity", activity.name);
        }
        Intent payment = new Intent(Intent.ACTION_VIEW, Uri.parse("connectcoin:cc1pfixture"))
            .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.getPackageName());
        assertEquals(MainActivity.class.getName(), pm.resolveActivity(payment, PackageManager.MATCH_DEFAULT_ONLY).activityInfo.name);
        Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"))
            .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.getPackageName());
        assertNull(pm.resolveActivity(web, PackageManager.MATCH_DEFAULT_ONLY));
    }
}
