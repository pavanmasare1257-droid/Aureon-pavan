package com.aureon.ai;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Urgent-mail watcher. Every ~20 minutes the phone asks the Aureon backend "any NEW mail that needs attention now?"
 * (the backend reads Gmail READ-ONLY and the AI picks things like an offer letter, an interview, a payment/security alert).
 * Only those mails become a notification. This class only READS and NOTIFIES: it never sends, replies or changes anything.
 *
 * Self-rescheduling AlarmManager one-shots (same style as AureonProactiveScheduler): no WorkManager, survives Doze (within the
 * OS's own batching), re-armed after a reboot and whenever the app is opened.
 */
public final class AureonMailWatch {
    public static final String ACTION_POLL = "com.aureon.ai.MAIL_WATCH_POLL";
    private static final String PREFS = "aureon_mailwatch";
    private static final String CHANNEL = "aureon_mail";
    private static final long INTERVAL_MS = 20L * 60L * 1000L;
    private static final int MAX_NOTES = 3;

    private AureonMailWatch() { }

    public static boolean isEnabled(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false);
    }

    public static String lastResult(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("last", "");
    }

    /** Turns the watcher on (with the backend URL + the phone's watch key) or off. */
    public static void configure(Context ctx, boolean enabled, String backendUrl, String key) {
        SharedPreferences.Editor ed = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (enabled && backendUrl != null && key != null) {
            ed.putBoolean("enabled", true).putString("url", backendUrl).putString("key", key).apply();
            schedule(ctx, 60000L);
        } else {
            ed.putBoolean("enabled", false).remove("key").apply();
            cancel(ctx);
        }
    }

    private static PendingIntent pending(Context ctx) {
        Intent i = new Intent(ctx, AureonMailWatchReceiver.class);
        i.setAction(ACTION_POLL);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, 7421, i, flags);
    }

    static void schedule(Context ctx, long delayMs) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            long at = System.currentTimeMillis() + delayMs;
            if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(ctx));
            else am.set(AlarmManager.RTC_WAKEUP, at, pending(ctx));
        } catch (Throwable ignored) { }
    }

    static void cancel(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(pending(ctx));
        } catch (Throwable ignored) { }
    }

    static void rearmIfEnabled(Context ctx, long delayMs) {
        if (isEnabled(ctx)) schedule(ctx, delayMs);
    }

    /** Blocking: ask the backend, notify for each urgent mail. Called from a worker thread. */
    static void pollNow(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String url = sp.getString("url", "");
        String key = sp.getString("key", "");
        if (url.length() == 0 || key.length() == 0) return;
        String error = "";
        int notified = 0;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url + "/api/gmail/watch/poll").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("x-watch-key", key);
            OutputStream os = c.getOutputStream();
            os.write("{}".getBytes("UTF-8"));
            os.close();
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (is != null) {
                BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"));
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
            }
            JSONObject j = new JSONObject(sb.toString());
            if (code == 401) {
                // the key was revoked or Gmail was disconnected: stop polling instead of retrying forever
                sp.edit().putBoolean("enabled", false).remove("key").apply();
                error = "Watch key band ho gayi: Gmail me dobara ON karo.";
            } else if (!j.optBoolean("ok", false)) {
                error = j.optString("error", "Server error");
            } else {
                JSONArray items = j.optJSONArray("items");
                if (items != null) {
                    for (int i = 0; i < items.length() && notified < MAX_NOTES; i++) {
                        JSONObject m = items.getJSONObject(i);
                        notifyUrgent(ctx, m.optString("id", ""), m.optString("subject", ""), m.optString("from", ""), m.optString("why", ""));
                        notified++;
                    }
                }
            }
        } catch (Throwable t) {
            error = "Network: " + t.getClass().getSimpleName();
        } finally {
            if (c != null) c.disconnect();
        }
        try {
            JSONObject o = new JSONObject();
            o.put("at", System.currentTimeMillis());
            o.put("notified", notified);
            o.put("error", error);
            sp.edit().putString("last", o.toString()).apply();
        } catch (Throwable ignored) { }
    }

    private static void notifyUrgent(Context ctx, String id, String subject, String from, String why) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Urgent mail", NotificationManager.IMPORTANCE_HIGH));
        }
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26) ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx);
        String title = "Urgent mail: " + (subject.length() == 0 ? "(no subject)" : subject);
        String text = (from.length() == 0 ? "" : from) + (why.length() == 0 ? "" : " — " + why);
        b.setSmallIcon(android.R.drawable.ic_dialog_email);
        b.setContentTitle(title);
        b.setContentText(text);
        b.setStyle(new Notification.BigTextStyle().bigText(text));
        b.setAutoCancel(true);
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open != null) {
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            b.setContentIntent(PendingIntent.getActivity(ctx, 7422, open, flags));
        }
        int nid = 8000 + ((id.hashCode() & 0x7fffffff) % 90000);
        nm.notify(nid, b.build());
    }
}
