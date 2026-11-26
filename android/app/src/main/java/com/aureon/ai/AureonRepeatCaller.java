package com.aureon.ai;

import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

/**
 * Repeat caller = loud ring. If the SAME number rings 3 times within 10 minutes, the ring is made loud even when the phone is on
 * silent / vibrate / Do Not Disturb (someone calling again and again usually means it is urgent).
 *
 *  - With "Do Not Disturb access" the phone's own ringtone is used: ringer mode and DND filter are lifted and the ring volume is maxed.
 *  - Without that special permission the default ringtone is played on the ALARM stream at full volume (alarms are allowed through silent mode).
 *  - Everything is put back as soon as the call is answered / ends, and after 45 seconds at the latest.
 * Opt-out: aureon_repeat / "enabled" (Away mode screen). Only the ring is affected: no call is answered, blocked or changed.
 */
final class AureonRepeatCaller {
    private static final String PREFS = "aureon_repeat";
    private static final int THRESHOLD = 3;
    private static final long WINDOW_MS = 10L * 60L * 1000L;
    private static final long MAX_RING_MS = 45000L;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static Ringtone ringtone;
    private static int savedRingerMode = -1;
    private static int savedRingVol = -1;
    private static int savedAlarmVol = -1;
    private static int savedFilter = -1;
    private static Runnable stopTimer;

    private AureonRepeatCaller() { }

    static boolean isEnabled(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", true);
    }

    static void setEnabled(Context ctx, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", on).apply();
        if (!on) stopLoud(ctx);
    }

    static boolean hasPolicyAccess(Context ctx) {
        if (Build.VERSION.SDK_INT < 23) return false;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        return nm != null && nm.isNotificationPolicyAccessGranted();
    }

    /** Call once per ring of a known number (the caller key = last 10 digits). The 3rd ring inside the window goes loud. */
    static synchronized void onRing(Context ctx, String key) {
        if (key == null || key.length() == 0 || !isEnabled(ctx)) return;
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        String log = sp.getString("log", "");
        StringBuilder keep = new StringBuilder();
        int count = 1;
        for (String part : log.split(";")) {
            if (part.length() == 0) continue;
            int c = part.lastIndexOf(':');
            if (c < 0) continue;
            long ts;
            try { ts = Long.parseLong(part.substring(c + 1)); } catch (NumberFormatException e) { continue; }
            if (now - ts > WINDOW_MS) continue;
            keep.append(part).append(';');
            if (part.substring(0, c).equals(key)) count++;
        }
        keep.append(key).append(':').append(now).append(';');
        sp.edit().putString("log", keep.toString()).apply();
        if (count >= THRESHOLD) loudRing(ctx);
    }

    /** Answered, declined, missed: put every setting back. */
    static synchronized void onCallEnded(Context ctx) {
        stopLoud(ctx);
    }

    /** For the "Test loud ring" button: rings loudly for ~6 seconds. Returns a short description of what was used. */
    static synchronized String test(final Context ctx) {
        boolean policy = hasPolicyAccess(ctx);
        loudRing(ctx);
        MAIN.postDelayed(new Runnable() { @Override public void run() { onCallEnded(ctx); } }, 6000L);
        return policy ? "ringtone" : "alarm";
    }

    private static void armStop(final Context ctx) {
        if (stopTimer != null) MAIN.removeCallbacks(stopTimer);
        stopTimer = new Runnable() { @Override public void run() { onCallEnded(ctx); } };
        MAIN.postDelayed(stopTimer, MAX_RING_MS);
    }

    private static void loudRing(Context ctx) {
        try {
            if (ringtone != null || savedRingVol >= 0 || savedRingerMode >= 0) return;   // already loud
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (am == null) return;
            boolean dndOn = false;
            boolean policy = false;
            if (Build.VERSION.SDK_INT >= 23 && nm != null) {
                policy = nm.isNotificationPolicyAccessGranted();
                dndOn = nm.getCurrentInterruptionFilter() != NotificationManager.INTERRUPTION_FILTER_ALL;
            }
            boolean silent = am.getRingerMode() != AudioManager.RINGER_MODE_NORMAL || dndOn
                    || am.getStreamVolume(AudioManager.STREAM_RING) == 0;

            if (policy) {
                try {
                    if (dndOn) {
                        savedFilter = nm.getCurrentInterruptionFilter();
                        nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL);
                    }
                    if (am.getRingerMode() != AudioManager.RINGER_MODE_NORMAL) {
                        savedRingerMode = am.getRingerMode();
                        am.setRingerMode(AudioManager.RINGER_MODE_NORMAL);
                    }
                    savedRingVol = am.getStreamVolume(AudioManager.STREAM_RING);
                    am.setStreamVolume(AudioManager.STREAM_RING, am.getStreamMaxVolume(AudioManager.STREAM_RING), 0);
                    armStop(ctx);
                    return;
                } catch (Throwable ignored) {
                    stopLoud(ctx);   // undo any half-done change, then use the alarm-sound ring below
                }
            }
            if (!silent) {
                // the phone will ring by itself: just make it as loud as possible
                try {
                    savedRingVol = am.getStreamVolume(AudioManager.STREAM_RING);
                    am.setStreamVolume(AudioManager.STREAM_RING, am.getStreamMaxVolume(AudioManager.STREAM_RING), 0);
                    armStop(ctx);
                } catch (Throwable ignored) { savedRingVol = -1; }
                return;
            }
            // silent / vibrate / Do Not Disturb without special access: play the ringtone on the alarm stream
            try {
                savedAlarmVol = am.getStreamVolume(AudioManager.STREAM_ALARM);
                am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
            } catch (Throwable ignored) { savedAlarmVol = -1; }
            Uri uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            Ringtone r = RingtoneManager.getRingtone(ctx, uri);
            if (r == null) return;
            if (Build.VERSION.SDK_INT >= 21) {
                r.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            }
            if (Build.VERSION.SDK_INT >= 28) r.setLooping(true);
            r.play();
            ringtone = r;
            armStop(ctx);
        } catch (Throwable ignored) { }
    }

    private static void stopLoud(Context ctx) {
        if (stopTimer != null) { MAIN.removeCallbacks(stopTimer); stopTimer = null; }
        try { if (ringtone != null) ringtone.stop(); } catch (Throwable ignored) { }
        ringtone = null;
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (am != null) {
            if (savedAlarmVol >= 0) { try { am.setStreamVolume(AudioManager.STREAM_ALARM, savedAlarmVol, 0); } catch (Throwable ignored) { } }
            if (savedRingVol >= 0) { try { am.setStreamVolume(AudioManager.STREAM_RING, savedRingVol, 0); } catch (Throwable ignored) { } }
            if (savedRingerMode >= 0) { try { am.setRingerMode(savedRingerMode); } catch (Throwable ignored) { } }
        }
        if (savedFilter >= 0 && Build.VERSION.SDK_INT >= 23 && nm != null) {
            try { nm.setInterruptionFilter(savedFilter); } catch (Throwable ignored) { }
        }
        savedAlarmVol = -1;
        savedRingVol = -1;
        savedRingerMode = -1;
        savedFilter = -1;
    }
}
