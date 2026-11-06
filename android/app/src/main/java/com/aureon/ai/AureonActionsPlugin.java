package com.aureon.ai;

import android.Manifest;
import android.app.Activity;
import android.media.projection.MediaProjectionManager;
import android.app.SearchManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Handler;
import android.os.Looper;
import android.provider.AlarmClock;
import android.provider.ContactsContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.telephony.SmsManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

// Phase 6 — Agent: native actions the AI can trigger on the phone.
// Each method here corresponds 1:1 to a tool the backend defines for Gemini
// function-calling (see backend/server.js AGENT_TOOLS). www/app.js calls
// these through window.Capacitor.Plugins.AureonActions after the model
// requests a tool call.
@CapacitorPlugin(
    name = "AureonActions",
    permissions = {
        @Permission(strings = { Manifest.permission.CALL_PHONE }, alias = "call"),
        @Permission(strings = { Manifest.permission.SEND_SMS }, alias = "sms"),
        @Permission(strings = { Manifest.permission.READ_CONTACTS }, alias = "contacts")
    }
)
public class AureonActionsPlugin extends Plugin {

    // Timings for cross-app UI automation below. Real devices/app versions
    // vary, so these are generous defaults, not guarantees — if Instagram's
    // UI changes its labels or gets slower to load, these steps may need
    // retuning. Every step is verified before moving to the next; nothing
    // here assumes success.
    private static final int APP_LAUNCH_WAIT_MS = 1800;
    private static final int SCREEN_STEP_TIMEOUT_MS = 4000;

    // ---- Ava watching the screen (MediaProjection -> AvaScreenWatchService) ----
    // JS: startScreenWatch({ backendUrl, key, intervalMs }) shows Android's own
    // "start recording or casting?" dialog; only after the user accepts does the
    // foreground service start. stopScreenWatch() / the notification's Stop button end it.
    @PluginMethod
    public void getScreenWatch(PluginCall call) {
        JSObject r = new JSObject();
        r.put("active", AvaScreenWatchService.isActive());
        call.resolve(r);
    }

    @PluginMethod
    public void startScreenWatch(PluginCall call) {
        String url = call.getString("backendUrl");
        String key = call.getString("key");
        if (url == null || key == null || !url.startsWith("http")) {
            call.reject("backendUrl and key are required");
            return;
        }
        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("Screen capture is not available on this device");
            return;
        }
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "screenWatchResult");
    }

    @ActivityCallback
    private void screenWatchResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            r.put("started", false);
            call.resolve(r);
            return;
        }
        Integer interval = call.getInt("intervalMs", 6000);
        AvaScreenWatchService.start(getContext(), result.getResultCode(), result.getData(),
                call.getString("backendUrl"), call.getString("key"), interval == null ? 6000 : interval);
        r.put("started", true);
        call.resolve(r);
    }

    @PluginMethod
    public void stopScreenWatch(PluginCall call) {
        AvaScreenWatchService.stop(getContext());
        JSObject r = new JSObject();
        r.put("active", false);
        call.resolve(r);
    }

    // ---- Teach Ava: record what the user does, replay it on command ----
    // ---- Away mode (Ava answers calls while the owner is busy) ----
    private JSObject awayState() {
        try { return new JSObject(AureonAwayMode.status(getContext()).toString()); } catch (Exception e) { return new JSObject(); }
    }

    @PluginMethod
    public void awayStart(PluginCall call) {
        String url = call.getString("backendUrl"), token = call.getString("token");
        if (url == null || token == null || !url.startsWith("http")) { call.reject("backendUrl and token are required"); return; }
        long until = call.getData().optLong("until", 0);
        if (until <= System.currentTimeMillis()) until = System.currentTimeMillis() + 30L * 60000L;
        AureonAwayMode.start(getContext(), url, token, call.getString("reason", "is busy right now"), call.getString("ownerName", "sir"), until, call.getString("lang", "en"));
        call.resolve(awayState());
    }

    @PluginMethod
    public void awayStop(PluginCall call) { AureonAwayMode.stop(getContext()); call.resolve(awayState()); }

    @PluginMethod
    public void awayStatus(PluginCall call) { call.resolve(awayState()); }

    @PluginMethod
    public void awayMarkReported(PluginCall call) { AureonAwayMode.markReported(getContext()); call.resolve(awayState()); }

    @PluginMethod
    public void getTeach(PluginCall call) { call.resolve(AvaTeach.status(getContext())); }

    @PluginMethod
    public void teachStart(PluginCall call) { call.resolve(AvaTeach.start(call.getString("name", ""))); }

    @PluginMethod
    public void teachStop(PluginCall call) {
        Boolean save = call.getBoolean("save", true);
        call.resolve(AvaTeach.stop(getContext(), save == null || save));
    }

    @PluginMethod
    public void macroPlay(PluginCall call) { call.resolve(AvaTeach.play(getContext(), call.getString("name", ""))); }

    @PluginMethod
    public void macroStop(PluginCall call) { AvaTeach.stopPlay(); call.resolve(); }

    @PluginMethod
    public void macroDelete(PluginCall call) { call.resolve(AvaTeach.delete(getContext(), call.getString("name", ""))); }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }

    // ---- Ava's transparent chat screen (AvaPanelActivity) ----
    @PluginMethod
    public void avaPanelMode(PluginCall call) {
        JSObject r = new JSObject();
        r.put("panel", getActivity() instanceof AvaPanelActivity);
        call.resolve(r);
    }

    @PluginMethod
    public void avaPanelReady(PluginCall call) {
        final android.app.Activity a = getActivity();
        if (a instanceof AvaPanelActivity) {
            final AvaPanelActivity pa = (AvaPanelActivity) a;
            a.runOnUiThread(new Runnable() { @Override public void run() { pa.markReady(); } });
        }
        call.resolve();
    }

    @PluginMethod
    public void closeAvaPanel(PluginCall call) {
        final android.app.Activity a = getActivity();
        if (a instanceof AvaPanelActivity) a.runOnUiThread(a::finish);
        call.resolve();
    }

    // ---- Ava floating on the phone screen (over other apps) ----
    @PluginMethod
    public void getAvaOverlay(PluginCall call) {
        Context ctx = getContext();
        JSObject r = new JSObject();
        r.put("enabled", AvaOverlayService.isEnabled(ctx));
        r.put("permitted", AvaOverlayService.canDraw(ctx));
        call.resolve(r);
    }

    @PluginMethod
    public void setAvaOverlay(PluginCall call) {
        Context ctx = getContext();
        boolean on = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        JSObject r = new JSObject();
        if (on && !AvaOverlayService.canDraw(ctx)) {
            // "Display over other apps" must be granted by the user in Settings.
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            } catch (Exception ignored) { }
            AvaOverlayService.setEnabled(ctx, true); // remembered: MainActivity.onResume starts Ava as soon as the permission is granted
            r.put("enabled", false);
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        AvaOverlayService.setEnabled(ctx, on);
        if (on) AvaOverlayService.start(ctx); else AvaOverlayService.stop(ctx);
        r.put("enabled", on);
        r.put("permitted", true);
        call.resolve(r);
    }

    @PluginMethod
    public void getBattery(PluginCall call) {
        Context ctx = getContext();
        BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
        int level = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : -1;

        IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent batteryStatus = ctx.registerReceiver(null, filter);
        int status = batteryStatus != null ? batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1) : -1;
        boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
                || status == BatteryManager.BATTERY_STATUS_FULL;

        JSObject ret = new JSObject();
        ret.put("level", level);
        ret.put("charging", charging);
        call.resolve(ret);
    }

    @PluginMethod
    public void openApp(PluginCall call) {
        String appName = call.getString("app_name");
        if (appName == null || appName.trim().isEmpty()) {
            call.reject("app_name is required");
            return;
        }
        // queryIntentActivities against LAUNCHER, not getInstalledApplications —
        // Android 11+ hides most apps from the latter unless declared in
        // <queries>. Querying by the launcher intent (a wildcard <queries>
        // entry in the manifest) is the documented way to see every
        // launchable app regardless. Shared with sendInstagramMessage() via
        // openAppByName() below.
        try {
            call.resolve(openAppByName(appName.trim()));
        } catch (ActionException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void saveOwnerPhoto(PluginCall call) {
        String base64 = call.getString("base64", "");
        if (base64.isEmpty()) {
            call.reject("No photo data provided.");
            return;
        }
        try {
            byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
            java.io.File outFile = new java.io.File(getContext().getFilesDir(), "owner_reference.jpg");
            try (java.io.FileOutputStream fos = new java.io.FileOutputStream(outFile)) {
                fos.write(bytes);
            }
            JSObject ret = new JSObject();
            ret.put("saved", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Couldn't save photo: " + e.getMessage());
        }
    }

    // Called from app.js on every typed-chat message send, so the "been
    // quiet for X hours" proactive check-in knows typed chat counts as an
    // interaction too, not just voice/Love Camera.
    @PluginMethod
    public void markInteraction(PluginCall call) {
        AureonProactiveScheduler.markInteraction(getContext());
        call.resolve();
    }

    @PluginMethod
    public void setRefreshToken(PluginCall call) {
        String refreshToken = call.getString("refreshToken", "");
        AureonAgentActions.storeRefreshToken(getContext(), refreshToken);
        call.resolve();
    }

    @PluginMethod
    public void setUserId(PluginCall call) {
        String uid = call.getString("uid", "");
        AureonAgentActions.storeUid(getContext(), uid);
        call.resolve();
    }

    @PluginMethod
    public void openLoveCamera(PluginCall call) {
        Intent intent = new Intent(getContext(), LoveCameraActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        JSObject ret = new JSObject();
        ret.put("opened", "Love Camera");
        call.resolve(ret);
    }

    @PluginMethod
    public void makeCall(PluginCall call) {
        String number = call.getString("number");
        if (number == null || number.trim().isEmpty()) {
            call.reject("number is required");
            return;
        }
        if (getPermissionState("call") != PermissionState.GRANTED) {
            requestPermissionForAlias("call", call, "callPermsCallback");
            return;
        }
        doMakeCall(call, number);
    }

    @PermissionCallback
    private void callPermsCallback(PluginCall call) {
        String number = call.getString("number");
        if (getPermissionState("call") == PermissionState.GRANTED) {
            doMakeCall(call, number);
        } else {
            call.reject("Call permission was denied");
        }
    }

    private void doMakeCall(PluginCall call, String number) {
        Intent intent = new Intent(Intent.ACTION_CALL);
        intent.setData(Uri.parse("tel:" + Uri.encode(number)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("called", number);
        call.resolve(ret);
    }

    @PluginMethod
    public void sendSms(PluginCall call) {
        String number = call.getString("number");
        String message = call.getString("message");
        if (number == null || number.trim().isEmpty() || message == null) {
            call.reject("number and message are required");
            return;
        }
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermsCallback");
            return;
        }
        doSendSms(call, number, message);
    }

    @PermissionCallback
    private void smsPermsCallback(PluginCall call) {
        String number = call.getString("number");
        String message = call.getString("message");
        if (getPermissionState("sms") == PermissionState.GRANTED) {
            doSendSms(call, number, message);
        } else {
            call.reject("SMS permission was denied");
        }
    }

    private void doSendSms(PluginCall call, String number, String message) {
        try {
            SmsManager smsManager = SmsManager.getDefault();
            ArrayList<String> parts = smsManager.divideMessage(message);
            smsManager.sendMultipartTextMessage(number, null, parts, null, null);

            JSObject ret = new JSObject();
            ret.put("sent", true);
            ret.put("to", number);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not send SMS: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setAlarm(PluginCall call) {
        Integer hour = call.getInt("hour");
        Integer minute = call.getInt("minute");
        String label = call.getString("label", "Aureon Alarm");
        if (hour == null || minute == null) {
            call.reject("hour and minute are required");
            return;
        }

        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM);
        intent.putExtra(AlarmClock.EXTRA_HOUR, hour);
        intent.putExtra(AlarmClock.EXTRA_MINUTES, minute);
        intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        intent.putExtra(AlarmClock.EXTRA_SKIP_UI, false);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (intent.resolveActivity(getContext().getPackageManager()) != null) {
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("alarmSet", String.format(Locale.US, "%02d:%02d", hour, minute));
            call.resolve(ret);
        } else {
            call.reject("No clock app found to set the alarm");
        }
    }

    @PluginMethod
    public void searchWeb(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.trim().isEmpty()) {
            call.reject("query is required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("https://www.google.com/search?q=" + Uri.encode(query)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("searched", query);
        call.resolve(ret);
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("opened", url);
        call.resolve(ret);
    }

    @PluginMethod
    public void composeEmail(PluginCall call) {
        String to = call.getString("to");
        String subject = call.getString("subject", "");
        String body = call.getString("body", "");

        Intent intent = new Intent(Intent.ACTION_SENDTO);
        intent.setData(Uri.parse("mailto:" + (to != null ? Uri.encode(to) : "")));
        intent.putExtra(Intent.EXTRA_SUBJECT, subject);
        intent.putExtra(Intent.EXTRA_TEXT, body);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("No email app found");
            return;
        }
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("composed", true);
        ret.put("subject", subject);
        call.resolve(ret);
    }

    @PluginMethod
    public void playYoutube(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.trim().isEmpty()) {
            call.reject("query is required");
            return;
        }
        JSObject ret = doPlayYoutube(getContext(), query.trim());
        call.resolve(ret);
    }

    /** Shared by playYoutube() plugin method and reused by offline commands. */
    static JSObject doPlayYoutube(Context ctx, String query) {
        try {
            // Targets the YouTube app's own in-app search directly, so
            // "youtube pe X bajao" plays on YouTube specifically instead of
            // whatever app answers the generic media-search intent.
            Intent intent = new Intent(Intent.ACTION_SEARCH);
            intent.setPackage("com.google.android.youtube");
            intent.putExtra("query", query);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (intent.resolveActivity(ctx.getPackageManager()) != null) {
                ctx.startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("playing", query);
                ret.put("via", "youtube_app");
                return ret;
            }
        } catch (Exception ignored) {
            // fall through to the browser fallback below
        }
        Intent fallback = new Intent(Intent.ACTION_VIEW);
        fallback.setData(Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(query)));
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(fallback);
        JSObject ret = new JSObject();
        ret.put("playing", query);
        ret.put("via", "youtube_web");
        return ret;
    }

    @PluginMethod
    public void playMusic(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.trim().isEmpty()) {
            call.reject("query is required");
            return;
        }

        try {
            Intent intent = new Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH);
            intent.putExtra(SearchManager.QUERY, query);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (intent.resolveActivity(getContext().getPackageManager()) != null) {
                getContext().startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("playing", query);
                call.resolve(ret);
                return;
            }
        } catch (Exception ignored) {
            // fall through to the browser fallback below
        }

        // No music app registered for the media-search intent — fall back to
        // opening a YouTube search so something useful still happens.
        Intent fallback = new Intent(Intent.ACTION_VIEW);
        fallback.setData(Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(query)));
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(fallback);

        JSObject ret = new JSObject();
        ret.put("playing", query);
        ret.put("via", "youtube");
        call.resolve(ret);
    }

    @PluginMethod
    public void sendWhatsappMessage(PluginCall call) {
        String number = call.getString("number");
        String contactName = call.getString("contact_name");
        String message = call.getString("message", "");

        if ((number == null || number.trim().isEmpty()) && contactName != null && !contactName.trim().isEmpty()) {
            if (getPermissionState("contacts") != PermissionState.GRANTED) {
                requestPermissionForAlias("contacts", call, "whatsappContactsPermsCallback");
                return;
            }
            number = resolveContactNumber(contactName);
            if (number == null) {
                call.reject("Could not find a phone number for \"" + contactName + "\" in your contacts.");
                return;
            }
        }

        if (number == null || number.trim().isEmpty()) {
            call.reject("number or contact_name is required");
            return;
        }
        // Strip anything but digits — wa.me needs a plain country-code number.
        String cleanNumber = number.replaceAll("[^0-9]", "");

        Intent intent = new Intent(Intent.ACTION_VIEW);
        // Opens WhatsApp with the chat + message pre-filled. It does NOT
        // send automatically — the user (or the confirmed accessibility
        // step, if you wire that up) still has to tap WhatsApp's own Send
        // button. Left this way deliberately: one extra manual/explicit
        // tap inside WhatsApp itself is a cheap extra safety net on top of
        // the confirm dialog already shown in the chat UI.
        intent.setData(Uri.parse("https://wa.me/" + cleanNumber + "?text=" + Uri.encode(message)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("Could not open WhatsApp");
            return;
        }
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("opened", true);
        ret.put("to", number);
        call.resolve(ret);
    }

    @PermissionCallback
    private void whatsappContactsPermsCallback(PluginCall call) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) {
            sendWhatsappMessage(call);
        } else {
            call.reject("Contacts permission was denied — can't look up that name. Try giving a phone number instead.");
        }
    }

    /** Looks up a contact's first phone number by display name. Returns null if not found. */
    private String resolveContactNumber(String name) {
        Cursor cursor = getContext().getContentResolver().query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[] { ContactsContract.CommonDataKinds.Phone.NUMBER },
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
                new String[] { "%" + name.trim() + "%" },
                null
        );
        if (cursor == null) return null;
        String number = null;
        try {
            if (cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
                if (idx >= 0) number = cursor.getString(idx);
            }
        } finally {
            cursor.close();
        }
        return number;
    }

    // ---------------------------------------------------------------
    // Instagram DM via Accessibility automation.
    //
    // There's no pre-fill deep-link for Instagram DMs like wa.me for
    // WhatsApp, so this drives the actual UI: open Instagram, search the
    // contact, open the chat, type the message, tap Send. This ONLY runs
    // after the chat UI has already shown the user a confirm dialog (see
    // SENSITIVE_AGENT_ACTIONS in www/app.js) — by the time this method is
    // called, the user has already said yes to this exact message.
    //
    // Instagram's exact button labels/layout can change between app
    // versions and aren't something we can verify without a live device,
    // so every step is verified before moving to the next and the call
    // fails loudly (with the step that failed) instead of pretending to
    // succeed.
    // ---------------------------------------------------------------
    @PluginMethod
    public void sendInstagramMessage(PluginCall call) {
        String contactName = call.getString("contact_name");
        String message = call.getString("message", "");
        if (contactName == null || contactName.trim().isEmpty() || message.trim().isEmpty()) {
            call.reject("contact_name and message are required");
            return;
        }

        if (!AureonAccessibilityService.isEnabled()) {
            call.reject("Aureon's Accessibility Service isn't turned on yet. Enable it in Settings \u2192 Accessibility \u2192 Aureon, then try again.");
            return;
        }

        JSObject openResult;
        try {
            openResult = openAppByName("Instagram");
        } catch (ActionException e) {
            call.reject(e.getMessage());
            return;
        }

        Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(() -> runInstagramSendSteps(call, contactName.trim(), message), APP_LAUNCH_WAIT_MS);
    }

    private void runInstagramSendSteps(PluginCall call, String contactName, String message) {
        JSObject status = new JSObject();
        status.put("contact", contactName);

        // Step 1: open the DM/search screen. Instagram's DM icon is usually
        // labelled "Direct" or "Messages" depending on app version/locale.
        boolean openedDm = AureonAccessibilityService.clickTextWithRetry("Direct", SCREEN_STEP_TIMEOUT_MS)
                || AureonAccessibilityService.clickTextWithRetry("Messages", SCREEN_STEP_TIMEOUT_MS);
        if (!openedDm) {
            status.put("step_failed", "open_dm_list");
            call.reject("Opened Instagram but couldn't find the Direct/Messages button. You'll need to open the chat manually this time.");
            return;
        }

        // Step 2: search for the contact and type their name.
        boolean searchOpened = AureonAccessibilityService.clickTextWithRetry("Search", SCREEN_STEP_TIMEOUT_MS);
        boolean typed = searchOpened && AureonAccessibilityService.typeText(contactName);
        if (!typed) {
            status.put("step_failed", "search_contact");
            call.reject("Couldn't search for \"" + contactName + "\" — you'll need to find the chat manually this time.");
            return;
        }

        // Step 3: wait for search results, then open the matching chat.
        boolean opened = AureonAccessibilityService.clickTextWithRetry(contactName, SCREEN_STEP_TIMEOUT_MS);
        if (!opened) {
            status.put("step_failed", "open_chat");
            call.reject("Found search results but couldn't open \"" + contactName + "\"'s chat automatically.");
            return;
        }

        // Step 4: type the message into the chat's text box.
        boolean messageTyped = AureonAccessibilityService.waitForText("Message", SCREEN_STEP_TIMEOUT_MS)
                && AureonAccessibilityService.typeText(message);
        if (!messageTyped) {
            status.put("step_failed", "type_message");
            call.reject("Opened the chat but couldn't type the message — you'll need to send it manually this time.");
            return;
        }

        // Step 5: tap Send. This is the only step that actually publishes
        // anything — everything before this is just navigation/typing.
        boolean sent = AureonAccessibilityService.clickTextWithRetry("Send", SCREEN_STEP_TIMEOUT_MS);
        status.put("sent", sent);
        if (!sent) {
            status.put("step_failed", "tap_send");
            call.reject("Typed the message but couldn't tap Send — it's sitting ready in the chat, you can send it yourself.");
            return;
        }

        call.resolve(status);
    }

    // ---------------------------------------------------------------
    // Instagram DM reading via Accessibility automation.
    //
    // Mirrors sendInstagramMessage()'s navigation (open Instagram, find the
    // contact, open their chat) but stops before typing anything — it just
    // captures whatever text is visible once the chat is open. This is NOT
    // sensitive (nothing is sent or changed), so unlike sending, this runs
    // immediately without a confirm dialog.
    //
    // Caveat: readScreen() returns ALL visible text in the chat (recent
    // messages, timestamps, UI labels), not just the single latest message
    // — Instagram's accessibility tree doesn't cleanly separate "their last
    // message" from the rest of the conversation view. The AI is expected
    // to pick out the relevant part when it reads this back to the user.
    // ---------------------------------------------------------------
    @PluginMethod
    public void readInstagramMessage(PluginCall call) {
        String contactName = call.getString("contact_name");
        if (contactName == null || contactName.trim().isEmpty()) {
            call.reject("contact_name is required");
            return;
        }

        if (!AureonAccessibilityService.isEnabled()) {
            call.reject("Aureon's Accessibility Service isn't turned on yet. Enable it in Settings \u2192 Accessibility \u2192 Aureon, then try again.");
            return;
        }

        JSObject openResult;
        try {
            openResult = openAppByName("Instagram");
        } catch (ActionException e) {
            call.reject(e.getMessage());
            return;
        }

        Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(() -> runInstagramReadSteps(call, contactName.trim()), APP_LAUNCH_WAIT_MS);
    }

    private void runInstagramReadSteps(PluginCall call, String contactName) {
        JSObject status = new JSObject();
        status.put("contact", contactName);

        boolean openedDm = AureonAccessibilityService.clickTextWithRetry("Direct", SCREEN_STEP_TIMEOUT_MS)
                || AureonAccessibilityService.clickTextWithRetry("Messages", SCREEN_STEP_TIMEOUT_MS);
        if (!openedDm) {
            status.put("step_failed", "open_dm_list");
            call.reject("Opened Instagram but couldn't find the Direct/Messages button. You'll need to check the chat manually this time.");
            return;
        }

        boolean searchOpened = AureonAccessibilityService.clickTextWithRetry("Search", SCREEN_STEP_TIMEOUT_MS);
        boolean typed = searchOpened && AureonAccessibilityService.typeText(contactName);
        if (!typed) {
            status.put("step_failed", "search_contact");
            call.reject("Couldn't search for \"" + contactName + "\" — you'll need to find the chat manually this time.");
            return;
        }

        boolean opened = AureonAccessibilityService.clickTextWithRetry(contactName, SCREEN_STEP_TIMEOUT_MS);
        if (!opened) {
            status.put("step_failed", "open_chat");
            call.reject("Found search results but couldn't open \"" + contactName + "\"'s chat automatically.");
            return;
        }

        // Give the chat a moment to render its message bubbles before reading.
        Handler readHandler = new Handler(Looper.getMainLooper());
        readHandler.postDelayed(() -> {
            String screenText = AureonAccessibilityService.readScreen();
            if (screenText == null || screenText.trim().isEmpty()) {
                status.put("step_failed", "read_messages");
                call.reject("Opened \"" + contactName + "\"'s chat but couldn't read any message text on screen.");
                return;
            }
            status.put("message", screenText);
            call.resolve(status);
        }, 700);
    }

    // ---------------------------------------------------------------
    // WhatsApp Live Location sharing — EXPERIMENTAL.
    //
    // Unlike sendWhatsappMessage() (which just pre-fills a deep-link
    // compose screen and stops there, waiting for a human tap on Send),
    // this drives WhatsApp's own "Share live location" UI all the way
    // through, including the final Send tap. That's why it's marked
    // sensitive in server.js and always asks for confirmation first.
    //
    // This depends on exact WhatsApp button labels/content-descriptions
    // ("Attach", "Location", "Share live location", a duration option,
    // "Send") which vary across WhatsApp versions and phone languages —
    // treat this as a first attempt that will likely need at least one
    // round of live-device debugging. Each step reports exactly where it
    // failed to make that easier.
    // ---------------------------------------------------------------
    @PluginMethod
    public void sendWhatsappLiveLocation(PluginCall call) {
        String contactName = call.getString("contact_name");
        String duration = call.getString("duration");
        if (duration == null || duration.trim().isEmpty()) duration = "15 minutes";
        if (contactName == null || contactName.trim().isEmpty()) {
            call.reject("contact_name is required");
            return;
        }

        if (!AureonAccessibilityService.isEnabled()) {
            call.reject("Aureon's Accessibility Service isn't turned on yet. Enable it in Settings \u2192 Accessibility \u2192 Aureon, then try again.");
            return;
        }

        try {
            openAppByName("WhatsApp");
        } catch (ActionException e) {
            call.reject(e.getMessage());
            return;
        }

        final String finalDuration = duration.trim();
        Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(() -> runWhatsappLiveLocationSteps(call, contactName.trim(), finalDuration), APP_LAUNCH_WAIT_MS);
    }

    private void runWhatsappLiveLocationSteps(PluginCall call, String contactName, String duration) {
        JSObject status = new JSObject();
        status.put("contact", contactName);
        status.put("duration", duration);

        boolean newChatOpened = AureonAccessibilityService.clickTextWithRetry("New chat", SCREEN_STEP_TIMEOUT_MS)
                || AureonAccessibilityService.clickTextWithRetry("New Chat", SCREEN_STEP_TIMEOUT_MS);
        if (!newChatOpened) {
            status.put("step_failed", "new_chat");
            call.reject("Opened WhatsApp but couldn't find the \"New chat\" button.");
            return;
        }

        boolean typed = AureonAccessibilityService.typeText(contactName);
        if (!typed) {
            status.put("step_failed", "type_contact_search");
            call.reject("Couldn't type \"" + contactName + "\" into WhatsApp's search.");
            return;
        }

        boolean contactOpened = AureonAccessibilityService.clickTextWithRetry(contactName, SCREEN_STEP_TIMEOUT_MS);
        if (!contactOpened) {
            status.put("step_failed", "open_contact_chat");
            call.reject("Searched for \"" + contactName + "\" but couldn't open their chat.");
            return;
        }

        boolean attachOpened = AureonAccessibilityService.clickTextWithRetry("Attach", SCREEN_STEP_TIMEOUT_MS);
        if (!attachOpened) {
            status.put("step_failed", "open_attach_menu");
            call.reject("Opened the chat but couldn't find the attach (\u2795) button.");
            return;
        }

        boolean locationOpened = AureonAccessibilityService.clickTextWithRetry("Location", SCREEN_STEP_TIMEOUT_MS);
        if (!locationOpened) {
            status.put("step_failed", "open_location_menu");
            call.reject("Opened the attach menu but couldn't find \"Location\".");
            return;
        }

        boolean liveLocationOpened = AureonAccessibilityService.clickTextWithRetry("Share live location", SCREEN_STEP_TIMEOUT_MS)
                || AureonAccessibilityService.clickTextWithRetry("Share Live Location", SCREEN_STEP_TIMEOUT_MS);
        if (!liveLocationOpened) {
            status.put("step_failed", "open_live_location_option");
            call.reject("Opened Location sharing but couldn't find \"Share live location\".");
            return;
        }

        boolean durationSelected = AureonAccessibilityService.clickTextWithRetry(duration, SCREEN_STEP_TIMEOUT_MS);
        if (!durationSelected) {
            status.put("step_failed", "select_duration");
            call.reject("Opened live location sharing but couldn't select the \"" + duration + "\" option.");
            return;
        }

        boolean sent = AureonAccessibilityService.clickTextWithRetry("Send", SCREEN_STEP_TIMEOUT_MS);
        if (!sent) {
            status.put("step_failed", "tap_send");
            call.reject("Set up live location sharing but couldn't tap the final Send button — check WhatsApp, it may be waiting there.");
            return;
        }

        status.put("sent", true);
        call.resolve(status);
    }

    /** Shared by openApp() and sendInstagramMessage() — launches an app by its display name. */
    private JSObject openAppByName(String appName) throws ActionException {
        PackageManager pm = getContext().getPackageManager();
        Intent launcherIntent = new Intent(Intent.ACTION_MAIN);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(launcherIntent, 0);
        String needle = appName.trim().toLowerCase(Locale.US);

        ResolveInfo bestMatch = null;
        for (ResolveInfo info : apps) {
            String label = info.loadLabel(pm).toString().toLowerCase(Locale.US);
            if (label.equals(needle)) { bestMatch = info; break; }
            if (bestMatch == null && label.contains(needle)) bestMatch = info;
        }
        if (bestMatch == null) throw new ActionException("Couldn't find an app called \"" + appName + "\" on this phone.");

        String packageName = bestMatch.activityInfo.packageName;
        Intent launchIntent = pm.getLaunchIntentForPackage(packageName);
        if (launchIntent == null) throw new ActionException("Found \"" + appName + "\" but it can't be launched directly");
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(launchIntent);

        JSObject ret = new JSObject();
        ret.put("opened", appName);
        ret.put("package", packageName);
        return ret;
    }

    private static class ActionException extends Exception {
        ActionException(String message) { super(message); }
    }

    // Opens Android's keyboard-management settings so the user can switch on
    // "Aureon Voice Typing" (see AureonVoiceKeyboardService) — lets them
    // dictate into any app's text field, not just Aureon's own chat.
    @PluginMethod
    public void openKeyboardSettings(PluginCall call) {
        Intent intent = new Intent(android.provider.Settings.ACTION_INPUT_METHOD_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    // ---------------------------------------------------------------
    // Application form filling — runs the shared AureonFormFiller on a
    // background thread. Never taps Submit/Apply.
    // ---------------------------------------------------------------
    @PluginMethod
    public void fillForm(PluginCall call) {
        final String base = call.getString("base");
        if (base == null || base.trim().isEmpty()) {
            call.reject("base is required");
            return;
        }
        final String url = call.getString("url", "");
        final String host = call.getString("host", "");
        final boolean apply = call.getBoolean("apply", false);
        final boolean autoSubmit = call.getBoolean("autoSubmit", false);
        final Context ctx = getContext();
        new Thread(() -> {
            try {
                org.json.JSONObject result = apply
                        ? AureonFormFiller.runApplication(ctx, base.trim(), url, host, autoSubmit)
                        : AureonFormFiller.run(ctx, base.trim(), true);
                call.resolve(JSObject.fromJSONObject(result));
            } catch (AureonAgentActions.ActionException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("Form fill failed: " + e.getMessage());
            }
        }).start();
    }

    // Site logins: encrypted, phone-only. Passwords are never returned to JS.
    @PluginMethod
    public void saveLogin(PluginCall call) {
        String host = call.getString("host", "");
        String user = call.getString("user", "");
        String pass = call.getString("pass", "");
        if (host.isEmpty() || user.isEmpty() || pass.isEmpty()) {
            call.reject("site, username aur password teeno chahiye");
            return;
        }
        if (!AureonCredStore.save(getContext(), host, user, pass)) {
            call.reject("Secure storage available nahi hai (Android 6+ chahiye) ya save fail hua.");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void deleteLogin(PluginCall call) {
        AureonCredStore.delete(getContext(), call.getString("host", ""));
        call.resolve();
    }

    @PluginMethod
    public void listLogins(PluginCall call) {
        JSObject out = new JSObject();
        out.put("logins", AureonCredStore.list(getContext()).toString());
        call.resolve(out);
    }
}
