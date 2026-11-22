package com.aureon.ai;

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
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * App Agent: Ava operates ONE app the owner chose, step by step (see backend/app-agent.js for the AI side).
 *
 * The loop runs here (not in the WebView) so it keeps working while the other app is on screen.
 * Load-bearing rules, enforced HERE so the phone never trusts the server or the AI:
 *  - any click on a send / post / pay / delete / buy / confirm style control needs the owner's Allow tap (heads-up notification);
 *    no answer within 2 minutes = denied;
 *  - banking / UPI / wallet / password-manager / settings apps are refused;
 *  - max 14 steps, only the chosen app (leaving it ends the task), password fields are never read or typed into;
 *  - the owner can stop it at any time from the ongoing notification.
 */
public final class AureonAppAgent {
    public static final String ACTION_ALLOW = "com.aureon.ai.AGENT_ALLOW";
    public static final String ACTION_DENY = "com.aureon.ai.AGENT_DENY";
    public static final String ACTION_STOP = "com.aureon.ai.AGENT_STOP";

    private static final String CH_RUN = "aureon_agent_run";
    private static final String CH_ASK = "aureon_agent_ask";
    private static final int NOTI_RUN = 7411;
    private static final int NOTI_ASK = 7412;
    private static final int MAX_STEPS = 14;
    private static final long APPROVAL_WAIT_MS = 120000L;
    private static final String PREFS = "aureon_agent";

    private static final Pattern DENY_PKG = Pattern.compile(
            "(paisa|phonepe|paytm|razorpay|bank|wallet|payment|keepass|bitwarden|lastpass|1password|dashlane|authenticator|packageinstaller|permissioncontroller)"
                    + "|(^|[._-])(upi|bhim|gpay)([._-]|$)|^com\\.android\\.settings$|^com\\.android\\.vending$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern SENSITIVE = Pattern.compile(
            "\\b(send|post|publish|share|reply|submit|confirm|pay|payment|buy|purchase|order|checkout|book|subscribe|transfer|delete|remove|uninstall|erase|clear|sign out|log out|logout|call|dial|tweet|upload|bhej|bhejo)\\b|^(ok|yes|done|allow)$",
            Pattern.CASE_INSENSITIVE);

    private static volatile boolean running = false;
    private static volatile boolean stopFlag = false;
    private static volatile int decision = 0; // 0 waiting, 1 allow, 2 deny/stop
    private static volatile String statusLine = "";

    private AureonAppAgent() { }

    public static boolean isRunning() { return running; }

    public static String status() { return statusLine; }

    /** Last finished task as JSON text ("" if none). */
    public static String lastResult(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("last", "");
    }

    public static boolean isDeniedPackage(String pkg) {
        return pkg == null || pkg.length() == 0 || DENY_PKG.matcher(pkg).find();
    }

    private static boolean isSensitive(String label) {
        if (label == null) return false;
        if (label.contains("भेज") || label.contains("खरीद")) return true;
        return SENSITIVE.matcher(label.trim()).find();
    }

    public static void stop() {
        stopFlag = true;
        decision = 2;
    }

    /** Called by AureonAgentReceiver for the notification buttons. */
    public static void onDecision(String action) {
        if (ACTION_ALLOW.equals(action)) decision = 1;
        else if (ACTION_DENY.equals(action)) decision = 2;
        else if (ACTION_STOP.equals(action)) stop();
    }

    /** Starts one task. Returns false if one is already running or the app is not allowed. */
    public static boolean start(final Context ctx, final String backendUrl, final String key, final String pkg, final String label, final String goal) {
        if (running || isDeniedPackage(pkg) || backendUrl == null || key == null) return false;
        running = true;
        stopFlag = false;
        decision = 0;
        final Context app = ctx.getApplicationContext();
        Thread t = new Thread(new Runnable() {
            @Override public void run() { runLoop(app, backendUrl, key, pkg, label, goal); }
        }, "aureon-app-agent");
        t.setDaemon(true);
        t.start();
        return true;
    }

    private static void sleep(long ms) {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end && !stopFlag) {
            try { Thread.sleep(100); } catch (InterruptedException e) { return; }
        }
    }

    private static void runLoop(Context ctx, String backendUrl, String key, String pkg, String label, String goal) {
        List<String> history = new ArrayList<String>();
        String finalMsg = "Task band.";
        try {
            notifyRun(ctx, label, "Ava " + label + " khol rahi hai…");
            Intent li = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
            if (li == null) { finish(ctx, label, goal, "App khul nahi paya.", history); return; }
            li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(li);
            sleep(3000);
            int mismatch = 0;
            for (int step = 1; step <= MAX_STEPS && !stopFlag; step++) {
                if (!AureonAccessibilityService.isEnabled()) { finalMsg = "Accessibility band hai: Settings me Aureon ko on karo."; break; }
                String active = AureonAccessibilityService.activePackage();
                if (!pkg.equals(active)) {
                    mismatch++;
                    if (mismatch >= 3) { finalMsg = "Doosra app screen par aa gaya, task roka."; break; }
                    sleep(1500);
                    step--;
                    continue;
                }
                mismatch = 0;
                String snap = AureonAccessibilityService.snapshotUi();
                if (snap.length() == 0) { sleep(1200); continue; }
                JSONObject snapObj = new JSONObject(snap);
                JSONObject body = new JSONObject();
                body.put("snapshot", snapObj);
                JSONArray h = new JSONArray();
                for (String x : history) { JSONObject o = new JSONObject(); o.put("a", x); h.put(o); }
                body.put("history", h);
                JSONObject resp = post(backendUrl + "/api/appagent/step", key, body);
                if (resp == null) { finalMsg = "Server se jawab nahi mila."; break; }
                if (!resp.optBoolean("ok", false)) { finalMsg = resp.optString("error", "Server error"); break; }
                JSONObject a = resp.getJSONObject("action");
                String act = a.optString("action", "wait");
                String say = a.optString("say", "");
                if (resp.optBoolean("abort", false)) { finalMsg = say; break; }
                if ("done".equals(act)) { finalMsg = "Ho gaya: " + say; break; }
                if ("ask".equals(act)) { finalMsg = "Ava puchh rahi hai: " + say; break; }
                notifyRun(ctx, label, step + "/" + MAX_STEPS + " · " + say);
                int idx = a.optInt("i", -1);
                String nodeLabel = "";
                JSONArray nodes = snapObj.optJSONArray("nodes");
                if (nodes != null && idx >= 0 && idx < nodes.length()) {
                    JSONObject n = nodes.getJSONObject(idx);
                    nodeLabel = n.optString("t", "");
                    if (nodeLabel.length() == 0) nodeLabel = n.optString("d", "");
                    nodeLabel = nodeLabel.trim();
                }
                if ("click".equals(act)) {
                    boolean needs = resp.optBoolean("needsApproval", false) || isSensitive(nodeLabel);
                    if (needs && !askApproval(ctx, label, goal, nodeLabel.length() == 0 ? say : nodeLabel)) { finalMsg = "Tumne allow nahi kiya, task band."; break; }
                    boolean ok = AureonAccessibilityService.agentClick(idx, nodeLabel);
                    history.add("click \"" + nodeLabel + "\"" + (ok ? "" : " (failed)"));
                } else if ("type".equals(act)) {
                    boolean ok = AureonAccessibilityService.agentType(idx, a.optString("text", ""), nodeLabel);
                    history.add("type into \"" + nodeLabel + "\"" + (ok ? "" : " (failed)"));
                } else if ("scroll_down".equals(act)) {
                    AureonAccessibilityService.scroll(true);
                    history.add("scroll down");
                } else if ("scroll_up".equals(act)) {
                    AureonAccessibilityService.scroll(false);
                    history.add("scroll up");
                } else if ("back".equals(act)) {
                    AureonAccessibilityService.globalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
                    history.add("back");
                } else {
                    history.add("wait");
                }
                sleep(1400);
                if (step == MAX_STEPS) finalMsg = "Step limit tak pahunch gayi.";
            }
            if (stopFlag) finalMsg = "Tumne roka.";
        } catch (Throwable t) {
            finalMsg = "Error: " + t.getClass().getSimpleName();
        }
        finish(ctx, label, goal, finalMsg, history);
    }

    private static boolean askApproval(Context ctx, String appLabel, String goal, String what) {
        decision = 0;
        notifyAsk(ctx, appLabel, goal, what);
        long end = System.currentTimeMillis() + APPROVAL_WAIT_MS;
        while (decision == 0 && !stopFlag && System.currentTimeMillis() < end) {
            try { Thread.sleep(250); } catch (InterruptedException e) { break; }
        }
        boolean allowed = decision == 1 && !stopFlag;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTI_ASK);
        decision = 0;
        return allowed;
    }

    private static JSONObject post(String url, String key, JSONObject body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(15000);
            c.setReadTimeout(40000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("x-agent-key", key);
            byte[] data = body.toString().getBytes("UTF-8");
            OutputStream os = c.getOutputStream();
            os.write(data);
            os.close();
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (is == null) return null;
            BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            br.close();
            return new JSONObject(sb.toString());
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static void finish(Context ctx, String label, String goal, String msg, List<String> history) {
        statusLine = msg;
        try {
            JSONObject o = new JSONObject();
            o.put("app", label);
            o.put("goal", goal);
            o.put("result", msg);
            o.put("at", System.currentTimeMillis());
            o.put("steps", history.size());
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            sp.edit().putString("last", o.toString()).apply();
        } catch (Throwable ignored) { }
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.cancel(NOTI_RUN);
            nm.cancel(NOTI_ASK);
            postNote(ctx, nm, CH_RUN, NOTI_RUN + 2, "Ava · " + label, msg, false, null);
        }
        running = false;
        stopFlag = false;
    }

    private static void ensureChannels(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel run = new NotificationChannel(CH_RUN, "Ava app tasks", NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(run);
        NotificationChannel ask = new NotificationChannel(CH_ASK, "Ava approval", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(ask);
    }

    private static PendingIntent actionIntent(Context ctx, String action, int req) {
        Intent i = new Intent(ctx, AureonAgentReceiver.class);
        i.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, req, i, flags);
    }

    @SuppressWarnings("deprecation")
    private static void postNote(Context ctx, NotificationManager nm, String channel, int id, String title, String text, boolean ongoing, String[][] actions) {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) b = new Notification.Builder(ctx, channel);
        else b = new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.ic_dialog_info);
        b.setContentTitle(title);
        b.setContentText(text);
        b.setStyle(new Notification.BigTextStyle().bigText(text));
        b.setOngoing(ongoing);
        b.setOnlyAlertOnce(true);
        if (Build.VERSION.SDK_INT < 26 && CH_ASK.equals(channel)) b.setPriority(Notification.PRIORITY_HIGH);
        if (actions != null) {
            for (int k = 0; k < actions.length; k++) {
                b.addAction(android.R.drawable.ic_menu_send, actions[k][1], actionIntent(ctx, actions[k][0], 100 + k));
            }
        }
        nm.notify(id, b.build());
    }

    private static void notifyRun(Context ctx, String label, String text) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            ensureChannels(nm);
            statusLine = text;
            postNote(ctx, nm, CH_RUN, NOTI_RUN, "Ava · " + label, text, true, new String[][]{{ACTION_STOP, "Roko"}});
        } catch (Throwable ignored) { }
    }

    private static void notifyAsk(Context ctx, String label, String goal, String what) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            ensureChannels(nm);
            String text = "Task: " + goal + "\nAva dabana chahti hai: \"" + what + "\"\nAllow karoge?";
            postNote(ctx, nm, CH_ASK, NOTI_ASK, "Ava " + label + " me approve maang rahi hai", text, false,
                    new String[][]{{ACTION_ALLOW, "Allow"}, {ACTION_DENY, "Roko"}});
        } catch (Throwable ignored) { }
    }
}
