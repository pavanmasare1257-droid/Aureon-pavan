package com.aureon.ai;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.telecom.TelecomManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

/**
 * Away mode. While the owner is busy ("nahane ja raha hu, 20 minute"), an incoming call is answered by Ava:
 * she says who she is (an AI assistant, and that the call is recorded), listens to the caller, answers with the
 * help of the server (/api/away/reply), remembers the whole talk and, when the owner is back, the app reports it.
 *
 * HOW the audio works (Android does not let apps play into / record a phone call directly): the call is put on
 * SPEAKERPHONE, Ava's voice comes out of the loudspeaker and the phone's own microphone carries it to the caller;
 * the same microphone is used to hear the caller. Some phones silence the microphone for other apps during a call —
 * then Ava notices (no audio), says goodbye, and the log says "awaaz capture nahi hui".
 */
final class AureonAwayMode {
    private static final String PREFS = "aureon_away";
    private static final String CHANNEL = "aureon_away";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final int MAX_TURNS = 6;

    // ---- the live call ----
    private static boolean inSession = false, weAnswered = false, finishing = false, offhookHandled = false;
    private static String sNumber = "", sName = "";
    private static long sStart = 0;
    private static JSONArray sTranscript = new JSONArray();
    private static int sTurns = 0, sSilent = 0, sHardErrors = 0;
    private static Runnable pendingAnswer;
    private static TextToSpeech tts;
    private static boolean ttsReady = false;
    private static SpeechRecognizer rec;
    private static int savedVol = -1;
    private static boolean savedSpeaker = false;

    private AureonAwayMode() {}

    // ================= settings / log =================

    private static SharedPreferences sp(Context c) { return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static boolean isActive(Context c) {
        SharedPreferences p = sp(c);
        if (!p.getBoolean("active", false)) return false;
        if (p.getLong("until", 0) < System.currentTimeMillis()) { p.edit().putBoolean("active", false).apply(); return false; }
        return true;
    }

    static void start(Context c, String backendUrl, String token, String reason, String owner, long untilMs) {
        sp(c).edit().putBoolean("active", true).putString("backend", backendUrl.replaceAll("/+$", "")).putString("token", token)
                .putString("reason", reason).putString("owner", owner).putLong("until", untilMs).apply();
    }

    static void stop(Context c) { sp(c).edit().putBoolean("active", false).putString("token", "").apply(); }

    static JSONObject status(Context c) {
        JSONObject o = new JSONObject();
        try {
            SharedPreferences p = sp(c);
            o.put("active", isActive(c));
            o.put("until", p.getLong("until", 0));
            o.put("reason", p.getString("reason", ""));
            o.put("calls", new JSONArray(p.getString("log", "[]")));
        } catch (Exception ignored) { }
        return o;
    }

    static void markReported(Context c) {
        try {
            JSONArray a = new JSONArray(sp(c).getString("log", "[]"));
            for (int i = 0; i < a.length(); i++) a.getJSONObject(i).put("reported", true);
            sp(c).edit().putString("log", a.toString()).apply();
        } catch (Exception ignored) { }
    }

    private static synchronized void appendLog(Context c, JSONObject entry) {
        try {
            JSONArray a = new JSONArray(sp(c).getString("log", "[]"));
            a.put(entry);
            JSONArray keep = new JSONArray();
            for (int i = Math.max(0, a.length() - 30); i < a.length(); i++) keep.put(a.get(i));
            sp(c).edit().putString("log", keep.toString()).apply();
        } catch (Exception ignored) { }
    }

    // ================= call lifecycle (driven by AureonCallAnnouncer) =================

    /** A call is ringing and away mode is on: answer it after a short delay. */
    static void onRinging(final Context app, final String number, final String name) {
        MAIN.post(new Runnable() { @Override public void run() {
            if (inSession) return;
            inSession = true; weAnswered = false; finishing = false; offhookHandled = false;
            sNumber = number == null ? "" : number; sName = name == null ? "" : name;
            sStart = System.currentTimeMillis(); sTranscript = new JSONArray();
            sTurns = 0; sSilent = 0; sHardErrors = 0;
            initTts(app);
            pendingAnswer = new Runnable() { @Override public void run() {
                pendingAnswer = null;
                if (!inSession) return;
                if (!answerNow(app)) finishSession(app, "noanswerperm");
            } };
            MAIN.postDelayed(pendingAnswer, 2500);
        } });
    }

    /** The phone went off-hook. If it was our answer, start talking; if the owner picked up by hand, step aside. */
    static void onOffhook(final Context app) {
        MAIN.post(new Runnable() { @Override public void run() {
            if (!inSession || finishing) return;
            if (!weAnswered) { cancelPending(); resetSession(app); return; }   // owner answered himself
            if (offhookHandled) return;   // the static AND the service receiver both report the same OFFHOOK
            offhookHandled = true;
            audioForCall(app, true);
            MAIN.postDelayed(new Runnable() { @Override public void run() {
                if (!inSession || finishing) return;
                SharedPreferences p = sp(app);
                String owner = p.getString("owner", "sir"), reason = p.getString("reason", "abhi busy hain");
                say(app, "Namaste, main Ava hoon, " + owner + " ki AI assistant. " + owner + " " + reason
                        + ". Ye baat-cheet record ho rahi hai. Aap apna naam aur message bol dijiye.", "away_say");
            } }, 900);
        } });
    }

    /** The call is over (hang-up from either side). */
    static void onIdle(final Context app) {
        MAIN.post(new Runnable() { @Override public void run() { if (inSession) finishSession(app, null); } });
    }

    private static boolean answerNow(Context app) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                    || ContextCompat.checkSelfPermission(app, Manifest.permission.ANSWER_PHONE_CALLS) != PackageManager.PERMISSION_GRANTED) return false;
            TelecomManager tm = (TelecomManager) app.getSystemService(Context.TELECOM_SERVICE);
            if (tm == null) return false;
            weAnswered = true;
            tm.acceptRingingCall();
            return true;
        } catch (Throwable t) { weAnswered = false; return false; }
    }

    private static void endCall(Context app) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    && ContextCompat.checkSelfPermission(app, Manifest.permission.ANSWER_PHONE_CALLS) == PackageManager.PERMISSION_GRANTED) {
                TelecomManager tm = (TelecomManager) app.getSystemService(Context.TELECOM_SERVICE);
                if (tm != null) tm.endCall();
            }
        } catch (Throwable ignored) { }
    }

    private static void cancelPending() { if (pendingAnswer != null) { MAIN.removeCallbacks(pendingAnswer); pendingAnswer = null; } }

    private static void resetSession(Context app) {
        stopRec(); stopTtsNow(); audioForCall(app, false);
        inSession = false; weAnswered = false; finishing = false; offhookHandled = false;
    }

    // ================= talking =================

    private static void initTts(final Context app) {
        if (tts != null) return;
        tts = new TextToSpeech(app.getApplicationContext(), new TextToSpeech.OnInitListener() {
            @Override public void onInit(int status) {
                ttsReady = (status == TextToSpeech.SUCCESS);
                if (!ttsReady) return;
                try {
                    Locale hi = new Locale("hi", "IN");
                    tts.setLanguage(tts.isLanguageAvailable(hi) >= TextToSpeech.LANG_AVAILABLE ? hi : Locale.getDefault());
                    tts.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                } catch (Throwable ignored) { }
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onError(String id) { onSpoken(app, id); }
                    @Override public void onDone(String id) { onSpoken(app, id); }
                });
            }
        });
    }

    private static void onSpoken(final Context app, final String id) {
        MAIN.post(new Runnable() { @Override public void run() {
            if (!inSession) return;
            if ("away_end".equals(id) || "away_bye".equals(id)) { MAIN.postDelayed(new Runnable() { @Override public void run() { endCall(app); } }, 600); return; }
            if (finishing) return;
            if ("away_say".equals(id)) MAIN.postDelayed(new Runnable() { @Override public void run() { listen(app); } }, 350);
        } });
    }

    private static void say(final Context app, final String text, final String utteranceId) {
        try { sTranscript.put(new JSONObject().put("who", "ava").put("text", text)); } catch (Exception ignored) { }
        if (tts != null && ttsReady) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
        else MAIN.postDelayed(new Runnable() { @Override public void run() { if (tts != null && ttsReady && inSession) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId); } }, 1200);
    }

    private static void stopTtsNow() { try { if (tts != null) tts.stop(); } catch (Throwable ignored) { } }

    private static void audioForCall(Context app, boolean on) {
        try {
            AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (on) {
                if (savedVol >= 0) return;
                savedSpeaker = am.isSpeakerphoneOn();
                savedVol = am.getStreamVolume(AudioManager.STREAM_MUSIC);
                am.setSpeakerphoneOn(true);
                am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(savedVol, (int) (am.getStreamMaxVolume(AudioManager.STREAM_MUSIC) * 0.85)), 0);
            } else {
                am.setSpeakerphoneOn(savedSpeaker);
                if (savedVol >= 0) am.setStreamVolume(AudioManager.STREAM_MUSIC, savedVol, 0);
                savedVol = -1;
            }
        } catch (Throwable ignored) { }
    }

    // ================= listening =================

    private static void stopRec() {
        if (rec != null) {
            try { rec.cancel(); } catch (Throwable ignored) { }
            try { rec.destroy(); } catch (Throwable ignored) { }
            rec = null;
        }
    }

    private static void listen(final Context app) {
        if (!inSession || finishing) return;
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED || !SpeechRecognizer.isRecognitionAvailable(app)) {
            goodbye(app, "Maaf kijiye, mujhe aapki awaaz sunai nahi de rahi. Aap SMS bhej dijiye, main sir ko bata dungi.", "noaudio");
            return;
        }
        stopRec();
        try {
            rec = SpeechRecognizer.createSpeechRecognizer(app);
            rec.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onEvent(int eventType, Bundle params) {}
                @Override public void onPartialResults(Bundle partialResults) {}
                @Override public void onError(int error) { handleRecError(app, error); }
                @Override public void onResults(Bundle results) {
                    ArrayList<String> l = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    String said = (l == null || l.isEmpty() || l.get(0) == null) ? "" : l.get(0).trim();
                    if (said.isEmpty()) { handleRecError(app, SpeechRecognizer.ERROR_NO_MATCH); return; }
                    sSilent = 0; sHardErrors = 0;
                    onCallerSaid(app, said);
                }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "hi-IN");
            i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, app.getPackageName());
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            rec.startListening(i);
        } catch (Throwable t) { handleRecError(app, SpeechRecognizer.ERROR_CLIENT); }
    }

    private static void handleRecError(final Context app, final int error) {
        MAIN.post(new Runnable() { @Override public void run() {
            if (!inSession || finishing) return;
            boolean quiet = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
            if (quiet) sSilent++; else sHardErrors++;
            if (sHardErrors >= 3) { goodbye(app, "Maaf kijiye, mujhe aapki awaaz sunai nahi de rahi. Aap SMS bhej dijiye, main sir ko bata dungi.", "noaudio"); return; }
            if (sSilent >= 3) { goodbye(app, "Koi awaaz nahi aayi. Main sir ko bata dungi ki aapne call kiya tha. Dhanyavaad.", "silent"); return; }
            MAIN.postDelayed(new Runnable() { @Override public void run() { listen(app); } }, error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? 900 : 400);
        } });
    }

    private static void goodbye(Context app, String text, String reasonTag) {
        finishing = true;                  // no more listening; the call ends once this is spoken
        try { sTranscript.put(new JSONObject().put("who", "sys").put("text", "[" + reasonTag + "]")); } catch (Exception ignored) { }
        stopRec();
        finishingTag = reasonTag;
        if (tts != null && ttsReady) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "away_bye");
        final Context a = app;
        MAIN.postDelayed(new Runnable() { @Override public void run() { endCall(a); } }, 5500);
    }
    private static String finishingTag = null;

    private static void onCallerSaid(final Context app, final String said) {
        MAIN.post(new Runnable() { @Override public void run() {
            if (!inSession || finishing) return;
            try { sTranscript.put(new JSONObject().put("who", "caller").put("text", said)); } catch (Exception ignored) { }
            sTurns++;
            final int turn = sTurns;
            new Thread(new Runnable() { @Override public void run() {
                final String[] r = askServer(app, said);       // {reply, end}
                MAIN.post(new Runnable() { @Override public void run() {
                    if (!inSession || finishing) return;
                    boolean end = "1".equals(r[1]) || turn >= MAX_TURNS;
                    if (end) {
                        finishing = true; stopRec();
                        try { sTranscript.put(new JSONObject().put("who", "ava").put("text", r[0])); } catch (Exception ignored) { }
                        if (tts != null && ttsReady) tts.speak(r[0], TextToSpeech.QUEUE_FLUSH, null, "away_end");
                        MAIN.postDelayed(new Runnable() { @Override public void run() { endCall(app); } }, 7000);   // safety if the voice never reports done
                    } else say(app, r[0], "away_say");
                } });
            } }).start();
        } });
    }

    /** Ask the server for Ava's next sentence; if the net is down use a simple script so the caller is never left hanging. */
    private static String[] askServer(Context app, String said) {
        HttpURLConnection c = null;
        try {
            SharedPreferences p = sp(app);
            String base = p.getString("backend", ""), token = p.getString("token", "");
            if (base.isEmpty() || token.isEmpty()) throw new Exception("no server");
            JSONArray hist = new JSONArray();
            int from = Math.max(0, sTranscript.length() - 9);
            for (int i = from; i < sTranscript.length() - 1; i++) {      // everything before the line just said
                JSONObject t = sTranscript.getJSONObject(i);
                if ("sys".equals(t.optString("who"))) continue;
                hist.put(new JSONObject().put("who", t.optString("who")).put("text", t.optString("text")));
            }
            JSONObject body = new JSONObject().put("callerSaid", said).put("history", hist).put("callerName", sName);
            c = (HttpURLConnection) new URL(base + "/api/away/reply").openConnection();
            c.setRequestMethod("POST"); c.setConnectTimeout(6000); c.setReadTimeout(11000); c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json"); c.setRequestProperty("x-away-key", token);
            try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            if (c.getResponseCode() != 200) throw new Exception("http " + c.getResponseCode());
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[2048]; int n; java.io.InputStream in = c.getInputStream();
            while ((n = in.read(buf)) > 0 && bo.size() < 20000) bo.write(buf, 0, n);
            JSONObject j = new JSONObject(bo.toString("UTF-8"));
            String reply = j.optString("reply", "").trim();
            if (reply.isEmpty()) throw new Exception("empty");
            return new String[]{reply, j.optBoolean("end", false) ? "1" : "0"};
        } catch (Throwable t) {
            return sTurns <= 1
                    ? new String[]{"Theek hai. Aap apna naam aur zaroori message bata dijiye, main sir ko bata dungi.", "0"}
                    : new String[]{"Samajh gayi, main sir ko bata dungi. Dhanyavaad.", "1"};
        } finally { if (c != null) c.disconnect(); }
    }

    // ================= wrap-up =================

    private static void finishSession(Context app, String forcedStatus) {
        cancelPending();
        boolean hadCaller = false;
        for (int i = 0; i < sTranscript.length(); i++) { if ("caller".equals(sTranscript.optJSONObject(i).optString("who"))) { hadCaller = true; break; } }
        String status = forcedStatus != null ? forcedStatus
                : (!weAnswered ? "missed" : (finishingTag != null && !hadCaller ? finishingTag : "answered"));
        long now = System.currentTimeMillis();
        try {
            JSONObject e = new JSONObject();
            e.put("number", sNumber); e.put("name", sName); e.put("at", sStart);
            e.put("atText", new SimpleDateFormat("d MMM, h:mm a", Locale.getDefault()).format(new Date(sStart)));
            e.put("durationSec", (now - sStart) / 1000); e.put("status", status);
            e.put("transcript", sTranscript); e.put("reported", false);
            appendLog(app, e);
            notifyOwner(app, e, hadCaller);
        } catch (Exception ignored) { }
        finishingTag = null;
        resetSession(app);
    }

    private static void notifyOwner(Context app, JSONObject e, boolean hadCaller) {
        try {
            NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null)
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Away mode calls", NotificationManager.IMPORTANCE_DEFAULT));
            String who = !e.optString("name").isEmpty() ? e.optString("name") : (!e.optString("number").isEmpty() ? e.optString("number") : "Unknown number");
            String first = "";
            JSONArray t = e.optJSONArray("transcript");
            for (int i = 0; t != null && i < t.length(); i++) { JSONObject x = t.getJSONObject(i); if ("caller".equals(x.optString("who"))) { first = x.optString("text"); break; } }
            String st = e.optString("status");
            String text = hadCaller ? first : ("missed".equals(st) ? "Call miss ho gayi (Ava utha nahi payi)" : ("noanswerperm".equals(st) ? "Ava call utha nahi payi (permission)" : "Caller ki awaaz capture nahi hui"));
            Intent open = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
            PendingIntent pi = open == null ? null : PendingIntent.getActivity(app, 7, open, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
            NotificationCompat.Builder b = new NotificationCompat.Builder(app, CHANNEL).setSmallIcon(android.R.drawable.sym_call_incoming)
                    .setContentTitle("Away mode: " + who + " ne call kiya").setContentText(text)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(text)).setAutoCancel(true);
            if (pi != null) b.setContentIntent(pi);
            nm.notify((int) (System.currentTimeMillis() % 100000) + 500, b.build());
        } catch (Throwable ignored) { }
    }
}
