package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.zxing.client.android.Intents;
import com.journeyapps.barcodescanner.ScanOptions;

/** Read-only public payment input. Wallet state, keys and transaction APIs are not accessible here. */
@CapacitorPlugin(name = "NativePaymentInput")
public final class NativePaymentInputPlugin extends Plugin {
    private final Object lifecycle = new Object();
    private NativePaymentInput.Mailbox links;
    private boolean active;
    private boolean destroyed;
    private PluginCall scanning;
    private JSObject scanResult;

    @Override public void load() {
        links = ((MainActivity) getActivity()).paymentLinks();
        // MainActivity consumed the cold URI before constructing Bridge. JS drains
        // the bounded mailbox after registering its listener; no raw URI is retained here.
    }

    static boolean consumeIntent(Intent intent, NativePaymentInput.Mailbox mailbox) {
        if (intent == null) return false;
        Uri data = intent.getData();
        String text = data == null ? null : data.toString();
        if (!NativePaymentInput.isPaymentIntent(intent.getAction(), text)) return false;
        // Clear before any callback. BridgeActivity redelivers its launch intent after load,
        // and Android can recreate MainActivity with that same Intent instance.
        intent.setData(null);
        return mailbox.offer(Intent.ACTION_VIEW, text);
    }

    private void acceptIntent(Intent intent) {
        synchronized (lifecycle) {
            if (destroyed || !consumeIntent(intent, links)) return;
            // No untrusted payment text in an event (and no unbounded retained event queue).
            notifyListeners("paymentLinkAvailable", new JSObject());
        }
    }

    @Override protected void handleOnNewIntent(Intent intent) { acceptIntent(intent); }

    @PluginMethod public void takePaymentLink(PluginCall call) {
        if (!empty(call)) return;
        synchronized (lifecycle) {
            if (destroyed) { call.resolve(new JSObject()); return; }
            NativePaymentInput.Input input = links.take();
            JSObject result = new JSObject();
            if (input != null) {
                if (input.error != null) result.put("error", input.error);
                else result.put("text", input.text);
            }
            call.resolve(result);
        }
    }

    @PluginMethod public void scanPaymentQr(PluginCall call) {
        if (!empty(call)) return;
        final Activity activity = getActivity();
        synchronized (lifecycle) {
            if (destroyed || !active || activity == null) {
                call.reject("Open the wallet to scan a payment QR code.", "INACTIVE"); return;
            }
            if (scanning != null) { call.reject("A QR scanner is already open.", "SCANNER_BUSY"); return; }
            scanning = call;
        }
        activity.runOnUiThread(() -> {
            synchronized (lifecycle) {
                if (destroyed || scanning != call) return;
                if (!active || getActivity() != activity || activity.isFinishing() || activity.isDestroyed()
                        || !activity.hasWindowFocus()) {
                    finishScan(call, new JSObject().put("cancelled", true)); return;
                }
                try {
                    // CaptureManager asks for CAMERA permission only now, after this explicit action.
                    startActivityForResult(call, PaymentQrCaptureActivity.createIntent(activity), "paymentQrScanned");
                } catch (RuntimeException error) {
                    scanning = null;
                    call.reject("The QR scanner is unavailable. Paste the payment address or link instead.", "SCANNER_UNAVAILABLE");
                    getBridge().releaseCall(call);
                }
            }
        });
    }

    @ActivityCallback private void paymentQrScanned(PluginCall call, ActivityResult result) {
        synchronized (lifecycle) {
            // A recreated Activity/plugin must never deliver a previous scan into a new form.
            if (destroyed || call == null || scanning != call) return;
            try {
                Intent data = result.getData();
                if (data != null && data.getBooleanExtra(Intents.Scan.MISSING_CAMERA_PERMISSION, false)) {
                    scanResult = new JSObject().put("error", "CAMERA_PERMISSION_DENIED");
                } else if (result.getResultCode() != Activity.RESULT_OK) {
                    scanResult = new JSObject().put("cancelled", true);
                } else if (data == null || !ScanOptions.QR_CODE.equals(data.getStringExtra(Intents.Scan.RESULT_FORMAT))) {
                    scanResult = new JSObject().put("error", NativePaymentInput.INVALID);
                } else {
                    scanResult = new JSObject().put("text", NativePaymentInput.boundedText(data.getStringExtra(Intents.Scan.RESULT)));
                }
            } catch (RuntimeException error) {
                scanResult = new JSObject().put("error", NativePaymentInput.INVALID);
            }
            deliverScanIfActive();
        }
    }

    private void deliverScanIfActive() {
        if (!destroyed && active && scanning != null && scanResult != null) finishScan(scanning, scanResult);
    }

    private void finishScan(PluginCall call, JSObject result) {
        scanning = null; scanResult = null;
        call.resolve(result);
        getBridge().releaseCall(call);
    }

    private static boolean empty(PluginCall call) {
        if (call.getData().length() == 0) return true;
        call.reject("This payment input action does not accept options.", "INVALID_ARGUMENT"); return false;
    }

    @Override protected void handleOnResume() {
        synchronized (lifecycle) { if (!destroyed) { active = true; deliverScanIfActive(); } }
    }
    @Override protected void handleOnPause() { synchronized (lifecycle) { active = false; } }
    @Override protected void handleOnDestroy() {
        synchronized (lifecycle) {
            destroyed = true; active = false; links.close();
            if (scanning != null) finishScan(scanning, new JSObject().put("cancelled", true));
        }
    }
}
