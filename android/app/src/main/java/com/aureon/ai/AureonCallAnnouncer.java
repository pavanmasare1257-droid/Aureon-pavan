package com.aureon.ai;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.ContactsContract;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.telephony.TelephonyManager;

import java.util.ArrayList;
import java.util.Locale;

import androidx.core.content.ContextCompat;

/**
 * Core "who's calling" logic, shared by AureonCallReceiver (manifest-
 * declared, works when it works) and AureonCallListenerService (a
 * persistent foreground service with its OWN dynamically-registered
 * receiver — kept alive by the foreground notification, which survives
 * OEM battery managers far more reliably than a static manifest receiver
 * alone on phones like ColorOS/Realme).
 */
final class AureonCallAnnouncer {
    private AureonCallAnnouncer() {}

    // Android 10+ sends PHONE_STATE=RINGING TWICE for one ring: first WITHOUT the
    // number, then (a moment later) WITH it. Old code announced on the first one
    // ("You have an incoming call") and its cooldown then threw away the second one
    // (the one that has the number) -> the caller's name was never spoken.
    // Now: no number -> wait a little for the numbered broadcast, number -> speak
    // the name at once; the same number is never spoken twice for one ring.
    private static final long NO_NUMBER_WAIT_MS = 1600;
    private static final android.os.Handler MAIN = new android.os.Handler(android.os.Looper.getMainLooper());
    private static volatile boolean ringing = false;
    private static volatile String lastSpokenKey = "";
    private static volatile long lastSpokenAt = 0;
    private static Runnable pendingGeneric;

    /** True while a call is ringing (used so "pickup" only answers when a call is really ringing). */
    static boolean isRinging() { return ringing; }

    /** Call from any PHONE_STATE broadcast receiver, static or dynamic. */
    static void handlePhoneStateIntent(final Context context, Intent intent) {
        if (intent == null || !TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;

        String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
        if (TelephonyManager.EXTRA_STATE_OFFHOOK.equals(state)) AureonAwayMode.onOffhook(context.getApplicationContext());
        else if (TelephonyManager.EXTRA_STATE_IDLE.equals(state)) AureonAwayMode.onIdle(context.getApplicationContext());
        if (!TelephonyManager.EXTRA_STATE_RINGING.equals(state)) {
            // IDLE / OFFHOOK = ring is over (answered, declined or missed)
            ringing = false;
            lastSpokenKey = "";
            MAIN.post(new Runnable() { @Override public void run() { stopAnswerListening(); } });
            synchronized (MAIN) {
                if (pendingGeneric != null) { MAIN.removeCallbacks(pendingGeneric); pendingGeneric = null; }
            }
            return;
        }
        ringing = true;

        // Needs READ_CALL_LOG on Android 9+ for this extra to be filled.
        String number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER);
        final boolean hasNumber = number != null && !number.trim().isEmpty();
        final Context app = context.getApplicationContext();

        if (!hasNumber) {
            // wait for the broadcast that carries the number; if none comes, say the generic line
            synchronized (MAIN) {
                if (pendingGeneric != null) return; // already waiting
                pendingGeneric = new Runnable() {
                    @Override public void run() {
                        synchronized (MAIN) { pendingGeneric = null; }
                        if (!ringing) return;
                        if (AureonAwayMode.isActive(app)) { AureonAwayMode.onRinging(app, "", ""); return; }
                        announceOnce(app, "generic", "You have an incoming call");
                    }
                };
                MAIN.postDelayed(pendingGeneric, NO_NUMBER_WAIT_MS);
            }
            return;
        }

        synchronized (MAIN) {
            if (pendingGeneric != null) { MAIN.removeCallbacks(pendingGeneric); pendingGeneric = null; }
        }
        String digits = number.replaceAll("[^0-9]", "");
        String name = lookupContactName(app, number);
        if (AureonAwayMode.isActive(app)) { AureonAwayMode.onRinging(app, number, name == null ? "" : name); return; }   // away mode: Ava takes the call
        String announcement = name != null
                ? (name + " is calling")
                : ("Incoming call from " + spellNumber(number));
        announceOnce(app, digits.isEmpty() ? number : digits, announcement);
    }

    /** Speak once per (ring, caller): the static receiver AND the service receiver both fire for one ring. */
    private static synchronized void announceOnce(Context app, String key, String text) {
        long now = System.currentTimeMillis();
        if (key.equals(lastSpokenKey) && now - lastSpokenAt < 8000) return;
        lastSpokenKey = key;
        lastSpokenAt = now;
        speak(app, text);
    }

    /** "9876543210" -> "9 8 7 6 5 4 3 2 1 0" so the voice reads digit by digit. */
    private static String spellNumber(String number) {
        String d = number.replaceAll("[^0-9+]", "");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < d.length(); i++) { if (i > 0) sb.append(' '); sb.append(d.charAt(i)); }
        return sb.toString();
    }

    private static String lookupContactName(Context context, String phoneNumber) {
        // Primary lookup — Android's own PhoneLookup provider, which
        // normally handles country-code/formatting differences internally.
        String name = lookupViaPhoneLookup(context, phoneNumber);
        if (name != null) return name;

        // Fallback: PhoneLookup can still miss a match on some OEM ROMs when
        // the incoming number's format differs from how it's saved in
        // Contacts (e.g. incoming "9876543210" vs saved "+91 98765 43210").
        // Compare just the last 10 digits against every saved number instead.
        String digitsOnly = phoneNumber.replaceAll("[^0-9]", "");
        if (digitsOnly.length() < 10) return null;
        String last10 = digitsOnly.substring(digitsOnly.length() - 10);

        Cursor cursor = null;
        try {
            Uri uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI;
            cursor = context.getContentResolver().query(uri,
                    new String[]{ ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                            ContactsContract.CommonDataKinds.Phone.NUMBER },
                    null, null, null);
            if (cursor != null) {
                int nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME);
                int numIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
                while (cursor.moveToNext()) {
                    String savedNumber = numIdx >= 0 ? cursor.getString(numIdx) : null;
                    if (savedNumber == null) continue;
                    String savedDigits = savedNumber.replaceAll("[^0-9]", "");
                    if (savedDigits.length() >= 10
                            && savedDigits.substring(savedDigits.length() - 10).equals(last10)) {
                        return nameIdx >= 0 ? cursor.getString(nameIdx) : null;
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    private static String lookupViaPhoneLookup(Context context, String phoneNumber) {
        Cursor cursor = null;
        try {
            Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phoneNumber));
            cursor = context.getContentResolver().query(uri,
                    new String[]{ ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME);
                if (idx >= 0) return cursor.getString(idx);
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    // Kept alive for the whole process instead of created fresh per call —
    // TextToSpeech's async init (binding to the system TTS service) can
    // take a very noticeable moment, which was the main cause of the
    // announcement arriving well after the phone had already been ringing
    // for a while. Pre-warming it once (see warmUp()) means a ring just
    // uses an engine that's already sitting there ready to speak.
    private static volatile TextToSpeech sharedEngine;
    private static volatile boolean sharedEngineReady = false;
    private static final Object ENGINE_LOCK = new Object();

    /** Call once, early (e.g. MainActivity.onCreate / AureonCallListenerService.onCreate),
     *  to pay TTS's init cost before any call actually rings. Safe to call more than once. */
    static void warmUp(Context appContext) {
        synchronized (ENGINE_LOCK) {
            if (sharedEngine != null) return;
            sharedEngine = new TextToSpeech(appContext.getApplicationContext(), status -> {
                sharedEngineReady = (status == TextToSpeech.SUCCESS);
                if (sharedEngineReady) {
                    sharedEngine.setLanguage(Locale.getDefault());
                    final Context app = appContext.getApplicationContext();
                    sharedEngine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override public void onStart(String utteranceId) {}
                        @Override public void onError(String utteranceId) {}
                        @Override public void onDone(String utteranceId) {
                            if ("aureon_call_announce".equals(utteranceId)) startAnswerListening(app);
                        }
                    });
                }
            });
        }
    }

    // ---- Hands-free answer: right after the caller is announced, listen for "pickup" / "utha lo" for ~15 seconds.
    // (Before, Aureon only spoke the name and never listened, so "pickup" without "Hey Aureon" did nothing.)
    private static SpeechRecognizer answerRecognizer;
    private static int answerTries = 0;

    static void startAnswerListening(final Context app) {
        if (AureonAwayMode.isActive(app)) return;
        MAIN.post(new Runnable() { @Override public void run() { answerTries = 0; listenOnce(app); } });
    }

    private static void stopAnswerListening() {
        if (answerRecognizer != null) {
            try { answerRecognizer.cancel(); } catch (Throwable ignored) { }
            try { answerRecognizer.destroy(); } catch (Throwable ignored) { }
            answerRecognizer = null;
        }
    }

    private static void listenOnce(final Context app) {
        if (!ringing || answerTries >= 5) { stopAnswerListening(); return; }
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        if (!SpeechRecognizer.isRecognitionAvailable(app)) return;
        answerTries++;
        stopAnswerListening();
        try {
            boolean onDevice = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S
                    && SpeechRecognizer.isOnDeviceRecognitionAvailable(app);
            answerRecognizer = onDevice ? SpeechRecognizer.createOnDeviceSpeechRecognizer(app) : SpeechRecognizer.createSpeechRecognizer(app);
            answerRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onEvent(int eventType, Bundle params) {}
                @Override public void onError(int error) { retryListen(app); }
                @Override public void onPartialResults(Bundle partial) { checkHeard(app, partial, false); }
                @Override public void onResults(Bundle results) { if (!checkHeard(app, results, true)) retryListen(app); }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, app.getPackageName());
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            answerRecognizer.startListening(i);
        } catch (Throwable t) {
            stopAnswerListening();
        }
    }

    private static void retryListen(final Context app) {
        MAIN.postDelayed(new Runnable() { @Override public void run() { listenOnce(app); } }, 350);
    }

    /** true if the user said "pickup" (or similar) and the call is being answered */
    private static boolean checkHeard(final Context app, Bundle b, boolean isFinal) {
        if (!ringing || b == null) return false;
        ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null) return false;
        for (String heard : list) {
            if (heard == null || !OfflineVoiceCommandEngine.isAnswerCommand(heard)) continue;
            stopAnswerListening();
            OfflineVoiceCommandEngine.handle(app, heard, new OfflineVoiceCommandEngine.Result() {
                @Override public void onHandled(String message) {
                    // say something only when answering was NOT possible (permission missing etc.)
                    if (message != null && !message.startsWith("Answering")) speakPlain(app, message);
                }
            });
            return true;
        }
        return false;
    }

    private static void speakPlain(Context appContext, String text) {
        warmUp(appContext);
        if (sharedEngineReady) sharedEngine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "aureon_call_msg");
    }

    private static void speak(Context appContext, String text) {
        warmUp(appContext); // no-op if already warmed/warming
        if (sharedEngineReady) {
            sharedEngine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "aureon_call_announce");
            return;
        }
        // Engine not ready yet (very first call right after boot, before
        // warmUp() finished) — fall back to a one-off engine for just this
        // announcement so the caller's name still gets spoken.
        final TextToSpeech[] fallback = new TextToSpeech[1];
        fallback[0] = new TextToSpeech(appContext.getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS || fallback[0] == null) return;
            fallback[0].setLanguage(Locale.getDefault());
            fallback[0].setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {}
                @Override public void onDone(String utteranceId) { shutdownQuietly(); startAnswerListening(appContext.getApplicationContext()); }
                @Override public void onError(String utteranceId) { shutdownQuietly(); }
                private void shutdownQuietly() {
                    if (fallback[0] != null) {
                        try { fallback[0].shutdown(); } catch (Exception ignored) {}
                        fallback[0] = null;
                    }
                }
            });
            fallback[0].speak(text, TextToSpeech.QUEUE_FLUSH, null, "aureon_call_announce");
        });
    }
}
