package com.aureon.ai;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.telephony.TelephonyManager;

/**
 * Keeps Aureon's caller-ID announcement alive in the background. A plain
 * manifest-declared BroadcastReceiver for PHONE_STATE can get skipped
 * entirely on aggressive OEM skins (ColorOS/Realme in particular) even
 * with Autostart and unrestricted battery enabled — this service exists
 * specifically to work around that: its foreground notification is what
 * keeps the process (and the receiver it registers dynamically inside
 * itself) alive with much higher priority than a static receiver gets on
 * its own.
 *
 * Started once from MainActivity.onCreate(); Android will attempt to
 * restart it (START_STICKY) if the OS kills it anyway.
 */
public class AureonCallListenerService extends Service {

    private static final String CHANNEL_ID = "aureon_call_listener";
    private static final int NOTIFICATION_ID = 4821;

    private BroadcastReceiver phoneStateReceiver;

    @Override
    public void onCreate() {
        super.onCreate();

        // Pay TTS's async-init cost now, once, instead of on the first
        // actual ring — that init delay was the main reason the caller's
        // name used to be announced well after the phone had already
        // started ringing.
        AureonCallAnnouncer.warmUp(getApplicationContext());

        phoneStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                AureonCallAnnouncer.handlePhoneStateIntent(context, intent);
            }
        };
        registerReceiver(phoneStateReceiver, new IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = buildNotification();
        boolean started = false;
        // microphone type lets the ring-time "pickup" listener record while the app is in the background
        if (Build.VERSION.SDK_INT >= 30 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            try {
                int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if (Build.VERSION.SDK_INT >= 34) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
                startForeground(NOTIFICATION_ID, n, types);
                started = true;
            } catch (Throwable ignored) { /* e.g. restarted from background: fall back below */ }
        }
        if (!started) {
            try {
                if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                else startForeground(NOTIFICATION_ID, n);
            } catch (Throwable ignored) {
                try { startForeground(NOTIFICATION_ID, n); } catch (Throwable ignored2) { /* keep running anyway */ }
            }
        }
        return START_STICKY;
    }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID, "Aureon Call Announcements", NotificationManager.IMPORTANCE_MIN);
                channel.setDescription("Keeps Aureon ready to announce who's calling.");
                channel.setShowBadge(false);
                nm.createNotificationChannel(channel);
            }
        }

        Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("Aureon")
                .setContentText("Listening for calls to announce")
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_MIN)
                .build();
    }

    @Override
    public void onDestroy() {
        if (phoneStateReceiver != null) {
            try { unregisterReceiver(phoneStateReceiver); } catch (Exception ignored) {}
            phoneStateReceiver = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
