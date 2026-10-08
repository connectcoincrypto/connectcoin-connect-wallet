package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import com.google.zxing.client.android.Intents;
import com.journeyapps.barcodescanner.CaptureActivity;
import com.journeyapps.barcodescanner.ScanOptions;

/** Internal camera activity with fixed options; no generic scanner configuration bridge. */
public final class PaymentQrCaptureActivity extends CaptureActivity {
    static Intent createIntent(Context context) {
        return new ScanOptions()
            .setCaptureActivity(PaymentQrCaptureActivity.class)
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Scan a ConnectCoin address or payment QR code")
            .setBeepEnabled(false)
            .setBarcodeImageEnabled(false)
            .setOrientationLocked(false)
            .addExtra(Intents.Scan.SHOW_MISSING_CAMERA_PERMISSION_DIALOG, false)
            .createScanIntent(context);
    }

    @Override protected void onCreate(Bundle savedInstanceState) {
        // Even an internal caller cannot enable image files, other formats or arbitrary extras.
        setIntent(createIntent(this));
        super.onCreate(savedInstanceState);
    }
}
