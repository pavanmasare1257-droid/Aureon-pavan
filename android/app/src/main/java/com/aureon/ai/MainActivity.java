package com.aureon.ai;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.content.Intent;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_PERMISSIONS = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before super.onCreate() so the Capacitor bridge
        // picks it up.
        // - AureonSpeechPlugin: native offline speech-to-text + on-device
        //   command execution, exposed to the chat screen's mic button.
        // - AureonActionsPlugin: JS-callable bridge for agent actions
        //   (open_app, get_battery, set_alarm, search_web, open_url,
        //   play_music, and the new send-message flow) — see
        //   AureonAgentActions.java.
        registerPlugin(AureonSpeechPlugin.class);
        registerPlugin(AureonActionsPlugin.class);
        registerPlugin(AureonDeviceGuardPlugin.class);

        super.onCreate(savedInstanceState);
        aureonFullscreen(); // v9: hide status + navigation bars (immersive)
        aureonKeyboardResize(); // fix: edge-to-edge breaks adjustResize, so the keyboard covered the input box
        // the page loads a moment after onCreate: push the cutout height again once it is there
        final android.os.Handler safeTopHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        // the Capacitor layout settles a moment after onCreate: clear any top gap again a few times
        safeTopHandler.postDelayed(() -> { aureonFullscreen(); aureonFreeTopPadding(); }, 400);
        safeTopHandler.postDelayed(() -> { aureonFullscreen(); aureonFreeTopPadding(); }, 1500);
        safeTopHandler.postDelayed(() -> aureonFreeTopPadding(), 4000);
        safeTopHandler.postDelayed(() -> aureonPushSafeTop(lastSafeTopPx), 2500);
        safeTopHandler.postDelayed(() -> aureonPushSafeTop(lastSafeTopPx), 6000);

        // Watchdog: catch any app-wide crash and report it (next launch) to
        // the backend, which emails the owner. See watchdog.js /
        // WATCHDOG-SETUP.md for the full pipeline.
        AureonCrashReporter.install(this);
        AureonCrashReporter.reportPendingCrashIfAny(this);

        // JARVIS-style proactive check-ins (daily + "been quiet a while").
        // Re-arming every launch is harmless — AlarmManager just replaces
        // the pending alarm with the same request code.
        AureonProactiveScheduler.scheduleAll(this);

        List<String> needed = new ArrayList<>();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }

        // Needed so voice commands like "message Pavan saying ..." can look
        // up a contact's number and open WhatsApp/SMS/Instagram with it.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_CONTACTS);
        }

        // "kiska call hai" (caller-ID announcement) and "call uthao" (voice
        // answer) both need to know a call is ringing; READ_CALL_LOG is
        // additionally required on Android 9+ for the incoming number to
        // actually be included in the system broadcast.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_PHONE_STATE);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_CALL_LOG);
        }

        // "call uthao" (voice answer) — lets Aureon accept a ringing call
        // directly through the telephony framework (TelecomManager), which
        // works regardless of what the phone's own call screen looks like.
        // Available since Android 8.0 (API 26).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && ContextCompat.checkSelfPermission(this, Manifest.permission.ANSWER_PHONE_CALLS)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ANSWER_PHONE_CALLS);
        }

        // "recent message padho" — reads the latest text message without
        // opening any app.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_SMS);
        }

        // "send location to Pavan" — needed to read the phone's last known
        // GPS/network fix so it can be shared as a Maps link.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.POST_NOTIFICATIONS);
            }
        }

        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(
                    this,
                    needed.toArray(new String[0]),
                    REQUEST_PERMISSIONS
            );
        } else {
            promptPhase6Setup();
        }

        startCallListenerService();
        AvaOverlayService.startIfEnabled(this);
    }

    /**
     * Starts the persistent foreground service backing caller-ID
     * announcement. Called unconditionally on every launch — Android will
     * simply no-op if it's already running. This doesn't require the
     * phone-state permissions to be granted yet; it just gets the
     * always-on listener in place so announcements work as soon as the
     * user does grant them.
     */
    private void startCallListenerService() {
        try {
            ContextCompat.startForegroundService(this, new Intent(this, AureonCallListenerService.class));
        } catch (Exception ignored) {
            // Best-effort — if this fails for any reason, the manifest-
            // declared AureonCallReceiver is still there as a fallback.
        }
    }

    private void promptPhase6Setup() {
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Aureon voice permissions")
                .setMessage("For voice typing and app actions (open apps, send messages with your confirmation), enable Aureon's Accessibility Service.\n\nFor system-wide \"Hey Aureon\", also set Aureon as your Default Digital Assistant.")
                .setPositiveButton("Accessibility", (d, w) -> {
                    try { startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); }
                    catch (Exception e) { Toast.makeText(this, "Open Settings \u2192 Accessibility \u2192 Aureon", Toast.LENGTH_LONG).show(); }
                })
                .setNeutralButton("Default Assistant", (d, w) -> {
                    try { startActivity(new Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)); }
                    catch (Exception e) { Toast.makeText(this, "Set Aureon as Default Digital Assistant in Settings", Toast.LENGTH_LONG).show(); }
                })
                .setNegativeButton("Later", null)
                .show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_PERMISSIONS) promptPhase6Setup();
    }

    // ---- v9: full screen (immersive). Swipe from an edge to peek at the system bars. ----
    private void aureonFullscreen() {
        try {
            android.view.Window w = getWindow();
            androidx.core.view.WindowCompat.setDecorFitsSystemWindows(w, false); // draw behind bars + notch (no black strip)
            w.setStatusBarColor(android.graphics.Color.TRANSPARENT);
            w.setNavigationBarColor(android.graphics.Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= 28) { // also use the area around a camera notch (CSS safe-area keeps the header clear of it)
                android.view.WindowManager.LayoutParams lp = w.getAttributes();
                // Android 11+: ALWAYS (SHORT_EDGES is skipped by some phones, e.g. Oppo/Realme/Vivo, which left a black strip on top)
                lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                        ? android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                        : android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                w.setAttributes(lp);
            }
            // v47: some phones (ColorOS/Realme/Oppo, MIUI, Funtouch) ignore the modern calls above and keep a black strip under the status bar.
            // The older flags below are what those phones still obey; they are harmless on every other phone.
            try {
                w.addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                w.clearFlags(android.view.WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
                w.clearFlags(android.view.WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
                w.addFlags(android.view.WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);   // let the window extend under the status bar / cutout
                android.view.View dv = w.getDecorView();
                dv.setSystemUiVisibility(dv.getSystemUiVisibility()
                        | android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            } catch (Throwable ignored2) { /* cosmetics only */ }
            // the WebView itself must not leave a gap or paint black above the page
            try {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().setBackgroundColor(0xFF0B0B14);
                    getBridge().getWebView().setFitsSystemWindows(false);
                }
                android.view.View content = findViewById(android.R.id.content);
                if (content != null) { content.setFitsSystemWindows(false); content.setPadding(content.getPaddingLeft(), 0, content.getPaddingRight(), content.getPaddingBottom()); }
            } catch (Throwable ignored3) { /* cosmetics only */ }
            // whatever the phone still paints outside the page is app-dark instead of pure black
            w.getDecorView().setBackgroundColor(0xFF0B0B14);
            try { w.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(0xFF0B0B14)); } catch (Throwable ignored4) { }
            androidx.core.view.WindowInsetsControllerCompat c = androidx.core.view.WindowCompat.getInsetsController(w, w.getDecorView());
            if (c != null) {
                c.setSystemBarsBehavior(androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
            }
        } catch (Throwable ignored) { /* never break startup over cosmetics */ }
    }


    // ---- Black strip on top (real cause): AppCompat wraps the page in layouts that have fitsSystemWindows=true.
    // On ColorOS/Realme (with the "stable layout" flags) they keep adding the status-bar height as TOP PADDING,
    // so the page starts ~40dp lower and the phone paints that strip pure black. We switch that off on every
    // parent of the content view, and give the page the real camera-cutout height as --safe-top ourselves.
    private int lastSafeTopPx = -1;

    private void aureonFreeTopPadding() {
        try {
            final android.view.View content = findViewById(android.R.id.content);
            android.view.View p = content;
            while (p != null) {
                p.setFitsSystemWindows(false);
                if (p != content) p.setPadding(p.getPaddingLeft(), 0, p.getPaddingRight(), p.getPaddingBottom());
                // a leftover TOP MARGIN on the page container (or the WebView itself) would also push the page down
                android.view.ViewGroup.LayoutParams plp = p.getLayoutParams();
                if (plp instanceof android.view.ViewGroup.MarginLayoutParams && ((android.view.ViewGroup.MarginLayoutParams) plp).topMargin != 0) {
                    ((android.view.ViewGroup.MarginLayoutParams) plp).topMargin = 0; p.setLayoutParams(plp);
                }
                android.view.ViewParent pp = p.getParent();
                p = (pp instanceof android.view.View) ? (android.view.View) pp : null;
            }
            if (content != null) androidx.core.view.ViewCompat.requestApplyInsets(content);
        } catch (Throwable ignored) { /* cosmetics only */ }
    }

    private void aureonPushSafeTop(int px) {
        try {
            lastSafeTopPx = px;
            if (px < 0 || getBridge() == null || getBridge().getWebView() == null) return;
            float d = getResources().getDisplayMetrics().density;
            final String js = "document.documentElement.style.setProperty('--safe-top','" + Math.round(px / d) + "px')";
            final android.webkit.WebView wv = getBridge().getWebView();
            wv.post(() -> wv.evaluateJavascript(js, null));
        } catch (Throwable ignored) { /* cosmetics only */ }
    }

    // ---- Keyboard fix. With setDecorFitsSystemWindows(false) (edge-to-edge) Android ignores
    // android:windowSoftInputMode="adjustResize", so the keyboard slid OVER the chat box and the
    // page looked cut/odd. We now shrink the content area by the keyboard height ourselves, so the
    // WebView (and its 100dvh layout) gets smaller and the input stays visible above the keyboard.
    private void aureonKeyboardResize() {
        try {
            final android.view.View content = findViewById(android.R.id.content);
            if (content == null) return;
            aureonFreeTopPadding();
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
                try {
                    aureonPushSafeTop(insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.displayCutout()).top);
                } catch (Throwable ignoredCut) { }
                int imeBottom = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom;
                boolean imeShown = insets.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime());
                v.setPadding(0, 0, 0, imeShown ? imeBottom : 0);
                return insets; // not consumed: WebView still receives cutout/safe-area insets
            });
            androidx.core.view.ViewCompat.requestApplyInsets(content);
        } catch (Throwable ignored) { /* never break startup over cosmetics */ }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            aureonFullscreen(); // bars come back after the keyboard / a dialog — hide them again
            aureonFreeTopPadding();
            aureonPushSafeTop(lastSafeTopPx);
        }
    }
}
