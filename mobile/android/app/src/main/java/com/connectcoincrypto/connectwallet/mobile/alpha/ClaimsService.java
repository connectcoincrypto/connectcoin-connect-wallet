package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** User-started, visible P2C proof collection. No boot receiver or sticky restart.
 * specialUse declares the foreground service category for proof collection.
 */
public final class ClaimsService extends Service {
    private static final String CHANNEL = "automatic-claims-active";
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) { MobileRuntime.get(this).stop(); stopSelf(); return START_NOT_STICKY; }
        // Stop or a policy change can win the race after startForegroundService
        // was queued. Never revive an orphan service or infer a new Start intent.
        if (!MobileRuntime.get(this).backgroundServiceRequested()) { stopSelf(); return START_NOT_STICKY; }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Automatic Claims status", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ClaimsService.class).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        android.app.Notification notification = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_claims_notification).setContentTitle("ConnectWallet Automatic Claims")
            .setContentText("Claims session enabled. Network policy applies; open the app for live counters.")
            .setOngoing(true).setSilent(true).setContentIntent(open).addAction(0, "Stop", stop).build();
        try {
            ServiceCompat.startForeground(this, 101, notification, Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0);
            MobileRuntime.get(this).service(true);
        } catch (RuntimeException denied) { MobileRuntime.get(this).stop(); stopSelf(); }
        return START_NOT_STICKY;
    }
    @Override public void onTaskRemoved(Intent rootIntent) { MobileRuntime.get(this).stop(); stopSelf(); }
    @Override public void onDestroy() { MobileRuntime.get(this).service(false); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
