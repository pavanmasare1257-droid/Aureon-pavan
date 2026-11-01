package com.aureon.ai;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.provider.ContactsContract;
import android.provider.Settings;
import android.provider.Telephony;
import android.telecom.TelecomManager;

import androidx.core.content.ContextCompat;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Offline command router for device navigation and accessibility automation.
 * Understands English, Hindi and Marathi phrasing. Hindi/Marathi speech is
 * usually transcribed in Devanagari script by the recognizer (e.g. "खोलो"),
 * not Roman spelling, so keyword lists include both scripts where relevant.
 *
 * Also supports compound commands joined by "and"/"aur"/"और"/"आणि", e.g.
 * "open whatsapp and message pavan I'm coming" — each part is executed in
 * order, all offline, with a combined confirmation message.
 */
public final class OfflineVoiceCommandEngine {
    public interface Result { void onHandled(String message); }
    private OfflineVoiceCommandEngine() {}

    // "message pavan I'm on my way", "मैसेज पवन मी येत आहे", "संदेश पवन ..."
    // Contact name is the first word after the trigger; everything after
    // that is the message body — no special connector word needed.
    private static final Pattern CONTACT_MESSAGE_PATTERN = Pattern.compile(
            "(?i)^(?:message|whatsapp|text|मैसेज|संदेश|मेसेज)\\s+(\\S+)\\s+(.+)$");

    // "play <query> on youtube" / "youtube pe <query> bajao" / "youtube par
    // <query> chalao" — plays directly in the YouTube app (see
    // AureonActionsPlugin.doPlayYoutube), works fully offline-triggered
    // even though the actual playback obviously still needs internet.
    private static final Pattern YOUTUBE_PLAY_PATTERN = Pattern.compile(
            "(?i)^(?:play\\s+(.+?)\\s+on\\s+youtube|youtube\\s+(?:pe|par)\\s+(.+?)\\s+(?:बजाओ|चलाओ|bajao|chalao))$");

    // Splits compound commands. Only used as a first attempt — if any part
    // fails to match a known command, we fall back to treating the whole
    // sentence as one (so a message body that happens to contain "and"
    // still works as long as it isn't itself a two-command sentence).
    private static final Pattern COMPOUND_SPLIT = Pattern.compile("(?i)\\s+(?:and|aur|और|आणि)\\s+");

    public static boolean handle(Context context, String raw, Result result) {
        if (raw == null) return false;
        String text = raw.trim();
        if (text.isEmpty()) return false;

        List<String> parts = splitCompound(text);
        if (parts.size() > 1) {
            StringBuilder combined = new StringBuilder();
            boolean allHandled = true;
            for (String part : parts) {
                final String[] holder = new String[]{null};
                boolean ok = handleSingle(context, part, msg -> holder[0] = msg);
                if (!ok) { allHandled = false; break; }
                if (combined.length() > 0) combined.append(" Then, ");
                combined.append(holder[0] != null ? holder[0] : "done.");
            }
            if (allHandled) {
                result.onHandled(combined.toString());
                return true;
            }
            // One of the parts wasn't a recognised command — fall back to
            // trying the original, unsplit sentence below.
        }

        return handleSingle(context, text, result);
    }

    private static List<String> splitCompound(String text) {
        String[] pieces = COMPOUND_SPLIT.split(text);
        List<String> list = new ArrayList<>();
        for (String p : pieces) {
            String trimmed = p.trim();
            if (!trimmed.isEmpty()) list.add(trimmed);
        }
        return list;
    }

    private static boolean startsWithAny(String lower, String... prefixes) {
        for (String p : prefixes) if (lower.startsWith(p)) return true;
        return false;
    }
    /** Short phrases like "pickup", "pick up", "phone uthao", "haan utha lo", "answer" count as "answer the call"
     *  — but ONLY while a call is really ringing, so normal chat ("pickup truck") never triggers it. */
    private static boolean isLoosePickup(String lower) {
        if (!AureonCallAnnouncer.isRinging()) return false;
        String t = lower.replaceAll("[^\\p{L}\\p{N} ]", " ").trim().replaceAll("\\s+", " ");
        if (t.isEmpty() || t.split(" ").length > 5) return false;
        return containsAny(t, "pickup", "pick up", "picup", "uthao", "utha lo", "utha do", "utha le", "uthalo",
                "answer", "receive", "recieve", "attend", "haan bolo", "उठाओ", "उठा लो", "उठा दो", "रिसीव", "पिकअप", "पिक अप");
    }
    private static boolean equalsAny(String lower, String... options) {
        for (String o : options) if (lower.equals(o)) return true;
        return false;
    }
    private static boolean containsAny(String lower, String... options) {
        for (String o : options) if (lower.contains(o)) return true;
        return false;
    }
    /** Strips whichever of the given prefixes matched, returning the rest. */
    private static String stripPrefix(String text, String... prefixes) {
        String lower = text.toLowerCase(Locale.ROOT);
        for (String p : prefixes) {
            if (lower.startsWith(p)) return text.substring(p.length()).trim();
        }
        return text.trim();
    }

    private static boolean handleSingle(Context context, String raw, Result result) {
        if (raw == null) return false;
        String text = raw.trim();
        String lower = text.toLowerCase(Locale.ROOT);
        if (lower.isEmpty()) return false;
        try {
            // ---- Recent SMS (fully offline — no accessibility, no AI) ----
            // Flexible on purpose: matches any combination of a "message/sms"
            // word with a "read/check/recent" word, in English, Hinglish, or
            // Devanagari — so phrasing like "recent message padho" (which an
            // exact-string match would miss) still triggers this offline
            // path instead of falling through to the AI backend.
            boolean mentionsMessage = containsAny(lower, "message", "sms", "मैसेज", "मेसेज");
            boolean isReadIntent = containsAny(lower, "read", "recent", "check", "padho", "padh",
                    "पढ़ो", "पढ़", "पढ", "वाचा", "रीसेंट", "हाल", "अलीकड");
            if (mentionsMessage && isReadIntent) {
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS)
                        != PackageManager.PERMISSION_GRANTED) {
                    result.onHandled("Enable Aureon's SMS permission in phone Settings to read recent messages.");
                    return true;
                }
                result.onHandled(readMostRecentSms(context));
                return true;
            }

            // ---- Check email (opens the phone's mail app and reads what's
            // visible — needs Accessibility; not full email body parsing) ----
            boolean mentionsEmail = containsAny(lower, "email", "e-mail", "gmail", "ईमेल", "इमेल");
            if (mentionsEmail && isReadIntent) {
                if (!AureonAccessibilityService.isEnabled()) {
                    result.onHandled("Enable Aureon's Accessibility permission to read email.");
                    return true;
                }
                String mailApp = null;
                for (String candidate : new String[]{"gmail", "outlook", "mail"}) {
                    if (isAppInstalled(context, candidate)) { mailApp = candidate; break; }
                }
                if (mailApp == null) {
                    result.onHandled("Couldn't find a mail app (Gmail/Outlook/Mail) on this phone.");
                    return true;
                }
                openAnyApp(context, mailApp, msg -> { });
                // Brief wait for the inbox to render before reading. This
                // blocks the calling thread briefly — same tradeoff already
                // accepted elsewhere in this file for multi-step actions.
                try { Thread.sleep(1200); } catch (InterruptedException ignored) { }
                String screen = AureonAccessibilityService.readScreen();
                result.onHandled(screen.isEmpty()
                        ? "Opened your mail app but couldn't read anything on screen."
                        : screen);
                return true;
            }

            // ---- Share current location as a Maps link (NOT live-updating —
            // a one-time "here I am right now" link, sent via WhatsApp/SMS
            // the same way messageContact() sends any other text). This is
            // the reliable fallback next to AureonAgentActions' real,
            // automated WhatsApp Live Location feature. ----
            if (lower.contains("location") || lower.contains("लोकेशन")) {
                String locName = extractLocationContactName(text);
                if (locName != null && !locName.isEmpty()) {
                    if (sendLocationLink(context, locName, result)) return true;
                }
                // Couldn't figure out who to send it to — fall through so
                // the AI can ask for clarification instead of staying silent.
            }

            // ---- Answer an incoming call.
            // Primary path: TelecomManager.acceptRingingCall() — an official
            // API since Android 8.0 (API 26) made specifically for this,
            // requiring only ANSWER_PHONE_CALLS (a normal grantable
            // permission, not MODIFY_PHONE_STATE or default-dialer status).
            // This works regardless of what the phone's own call screen
            // looks like, unlike UI automation. Falls back to tapping an
            // on-screen Answer/Accept button via Accessibility only on
            // pre-Oreo devices or if the permission wasn't granted. ----
            if (equalsAny(lower, "answer call", "answer the call", "pick up call", "pick up the call",
                    "receive call", "call uthao", "call utha lo", "call receive karo",
                    "कॉल उठाओ", "कॉल रिसीव करो", "कॉल घ्या", "कॉल उचला")
                    || isLoosePickup(lower)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        && ContextCompat.checkSelfPermission(context, Manifest.permission.ANSWER_PHONE_CALLS)
                        == PackageManager.PERMISSION_GRANTED) {
                    try {
                        TelecomManager telecomManager =
                                (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
                        if (telecomManager != null) {
                            telecomManager.acceptRingingCall();
                            result.onHandled("Answering the call.");
                            return true;
                        }
                    } catch (SecurityException e) {
                        // fall through to the accessibility-based attempt below
                    }
                }
                if (!AureonAccessibilityService.isEnabled()) {
                    result.onHandled("Enable Aureon's phone-call permission (or Accessibility) in Settings to answer calls by voice.");
                    return true;
                }
                boolean answered = AureonAccessibilityService.clickTextWithRetry("Answer", 2500)
                        || AureonAccessibilityService.clickTextWithRetry("Accept", 2500)
                        || AureonAccessibilityService.clickTextWithRetry("Answer call", 2500)
                        || AureonAccessibilityService.clickTextWithRetry("स्वीकारें", 2500)
                        || AureonAccessibilityService.clickTextWithRetry("उत्तर दें", 2500);
                result.onHandled(answered
                        ? "Answering the call."
                        : "Couldn't find an Answer button on screen — this phone's call screen may not support automatic answering.");
                return true;
            }
            if (equalsAny(lower, "decline call", "reject call", "decline the call", "reject the call",
                    "call katao", "call cut karo", "कॉल काटो", "कॉल नाकारा")) {
                if (!AureonAccessibilityService.isEnabled()) {
                    result.onHandled("Enable Aureon's Accessibility permission to decline calls by voice.");
                    return true;
                }
                boolean declined = AureonAccessibilityService.clickTextWithRetry("Decline", 2500)
                        || AureonAccessibilityService.clickTextWithRetry("Reject", 2500)
                        || AureonAccessibilityService.clickTextWithRetry("अस्वीकार करें", 2500);
                result.onHandled(declined
                        ? "Declining the call."
                        : "Couldn't find a Decline button on screen — this phone's call screen may not support automatic declining.");
                return true;
            }

            // Broad/loose match (containsAny, not exact) on purpose — people
            // phrase this many different ways ("screen padho", "ye padho",
            // "kya likha hai", "isko read karo") and a strict exact-match
            // was silently failing on anything that wasn't the literal
            // English phrase.
            if (containsAny(lower, "read screen", "read the screen", "what is on screen", "screen read",
                    "screen padho", "screen padh", "ye padho", "isko padho", "yeh padho", "kya likha hai",
                    "kya likha he", "screen pe kya hai", "read karo screen", "screen ko padho",
                    "स्क्रीन पढ़ो", "स्क्रीन वाचा", "यह पढ़ो", "क्या लिखा है")) {
                if (!AureonAccessibilityService.isEnabled()) { result.onHandled("Enable Aureon's Accessibility permission to read the screen."); return true; }
                String screen = AureonAccessibilityService.readScreen();
                result.onHandled(screen.isEmpty() ? "I can't read any visible text on this screen." : screen);
                return true;
            }

            // ---- Message/WhatsApp a contact by name (checked before the
            // generic "type what's on screen" handler below) ----
            Matcher contactMatch = CONTACT_MESSAGE_PATTERN.matcher(text);
            if (contactMatch.matches()) {
                String name = contactMatch.group(1).trim();
                String message = contactMatch.group(2).trim();
                if (messageContact(context, name, message, result)) return true;
                // Contact not found — fall through to normal handling below.
            }

            if (startsWithAny(lower, "type ", "write ", "message ", "send message ",
                    "लिखो ", "टाइप करो ", "लिहा ", "टाईप करा ")) {
                String payload = stripPrefix(text, "type ", "write ", "message ", "send message ",
                        "लिखो ", "टाइप करो ", "लिहा ", "टाईप करा ");
                boolean ok = AureonAccessibilityService.typeText(payload);
                result.onHandled(ok ? "Typed it." : "Enable Aureon's Accessibility permission and focus a text box first.");
                return true;
            }
            if (startsWithAny(lower, "append ", "जोड़ो ", "जोडा ")) {
                String payload = stripPrefix(text, "append ", "जोड़ो ", "जोडा ");
                boolean ok = AureonAccessibilityService.appendText(payload);
                result.onHandled(ok ? "Added it." : "Enable Accessibility and focus a text box first.");
                return true;
            }
            if (startsWithAny(lower, "click ", "tap ", "press ", "दबाओ ", "दाबा ")) {
                String target = stripPrefix(text, "click ", "tap ", "press ", "दबाओ ", "दाबा ");
                boolean ok = AureonAccessibilityService.clickText(target);
                result.onHandled(ok ? "Done." : "I couldn't find that control on the screen.");
                return true;
            }
            if (equalsAny(lower, "scroll down", "scroll", "नीचे स्क्रॉल करो", "खाली स्क्रोल करा")) {
                result.onHandled(AureonAccessibilityService.scroll(true) ? "Scrolled down." : "I couldn't scroll this screen."); return true;
            }
            if (equalsAny(lower, "scroll up", "ऊपर स्क्रॉल करो", "वर स्क्रोल करा")) {
                result.onHandled(AureonAccessibilityService.scroll(false) ? "Scrolled up." : "I couldn't scroll this screen."); return true;
            }
            // ---- "3 dots"/menu icon, by common alias labels (offline) ----
            // Accessibility can't literally "see" an icon's shape — it can
            // only match the accessible label a developer gave that button.
            // Almost every app labels its overflow ("⋮") button "More
            // options" under the hood, so try the common aliases in turn
            // instead of the literal words the user said.
            if (containsAny(lower, "3 dot", "three dot", "तीन डॉट", "तीन बिंदु", "menu button", "dot menu", "overflow menu", "more options")) {
                String[] aliases = {"More options", "More", "Menu", "Overflow menu", "..."};
                boolean clicked = false;
                for (String alias : aliases) {
                    if (AureonAccessibilityService.clickText(alias)) { clicked = true; break; }
                }
                result.onHandled(clicked ? "Opened the menu." : "Couldn't find a menu button on this screen.");
                return true;
            }

            if (equalsAny(lower, "go back", "back", "वापस जाओ", "वापस", "मागे जा", "मागे")) {
                result.onHandled(AureonAccessibilityService.globalAction(1) ? "Going back." : "Back isn't available."); return true;
            }
            if (equalsAny(lower, "go home", "home", "होम जाओ", "घर जाओ", "होमवर जा")) {
                result.onHandled(AureonAccessibilityService.globalAction(2) ? "Going home." : "Home isn't available."); return true;
            }
            if (equalsAny(lower, "recent apps", "open recents", "हाल के ऐप्स", "अलीकडील ॲप्स")) {
                result.onHandled(AureonAccessibilityService.globalAction(3) ? "Opening recent apps." : "Recents isn't available."); return true;
            }
            if (equalsAny(lower, "notifications", "open notifications", "नोटिफिकेशन खोलो", "सूचना उघडा")) {
                result.onHandled(AureonAccessibilityService.globalAction(4) ? "Opening notifications." : "Notifications aren't available."); return true;
            }
            if (equalsAny(lower, "quick settings", "open quick settings", "क्विक सेटिंग्स खोलो", "क्विक सेटिंग्ज उघडा")) {
                result.onHandled(AureonAccessibilityService.globalAction(5) ? "Opening quick settings." : "Quick settings isn't available."); return true;
            }

            Matcher youtubePlayMatch = YOUTUBE_PLAY_PATTERN.matcher(text);
            if (youtubePlayMatch.matches()) {
                String query = youtubePlayMatch.group(1) != null ? youtubePlayMatch.group(1).trim() : youtubePlayMatch.group(2).trim();
                AureonActionsPlugin.doPlayYoutube(context, query);
                result.onHandled("Playing " + query + " on YouTube.");
                return true;
            }

            if (containsAny(lower, "open youtube", "youtube खोलो", "youtube उघडा") || equalsAny(lower, "youtube")) return launchPackage(context, "com.google.android.youtube", "YouTube", result);
            if (containsAny(lower, "open whatsapp", "whatsapp खोलो", "whatsapp उघडा") || equalsAny(lower, "whatsapp")) return launchPackage(context, "com.whatsapp", "WhatsApp", result);
            if (containsAny(lower, "open camera", "कैमरा खोलो", "कॅमेरा उघडा") || equalsAny(lower, "camera")) {
                Intent i = new Intent("android.media.action.IMAGE_CAPTURE"); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(i); result.onHandled("Opening camera."); return true;
            }
            if (containsAny(lower, "love camera", "answer camera", "question camera", "लव कैमरा", "आंसर कैमरा", "क्वेश्चन कैमरा")) {
                Intent i = new Intent(context, LoveCameraActivity.class); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(i); result.onHandled("Opening Love Camera."); return true;
            }
            if (containsAny(lower, "open settings", "सेटिंग्स खोलो", "सेटिंग्ज उघडा") || equalsAny(lower, "settings")) return start(context, Settings.ACTION_SETTINGS, "Opening settings.", result);
            if (containsAny(lower, "wifi settings", "open wifi", "वाईफाई सेटिंग्स", "वायफाय सेटिंग्ज")) return start(context, Settings.ACTION_WIFI_SETTINGS, "Opening Wi-Fi settings.", result);
            if (containsAny(lower, "bluetooth settings", "open bluetooth", "ब्लूटूथ सेटिंग्स", "ब्लूटूथ सेटिंग्ज")) return start(context, Settings.ACTION_BLUETOOTH_SETTINGS, "Opening Bluetooth settings.", result);
            if (containsAny(lower, "open accessibility", "accessibility settings", "एक्सेसिबिलिटी सेटिंग्स")) return start(context, Settings.ACTION_ACCESSIBILITY_SETTINGS, "Opening Accessibility settings.", result);
            if (containsAny(lower, "open app settings", "aureon settings", "aureon सेटिंग्स")) {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(i); result.onHandled("Opening Aureon settings."); return true;
            }

            // ---- Generic "open <any installed app>" fallback (English,
            // Hindi "खोलो/खोल", Marathi "उघडा/उघड") ----
            // Runs after the quick-match cases above so common apps stay fast.
            if (startsWithAny(lower, "open ") || containsAny(lower, " खोलो", " खोल") || containsAny(lower, " उघडा", " उघड")) {
                String appName = extractAppNameForOpen(text, lower);
                if (appName != null && !appName.isEmpty() && openAnyApp(context, appName, result)) return true;
                // Not found among installed apps — fall through so the AI
                // backend can respond (e.g. "open a good book recommendation").
            }

            // ---- Last resort: click whatever's on screen matching what
            // was said (e.g. a contact's name in a WhatsApp chat list) —
            // no "click"/"tap" prefix needed. Only tried for SHORT phrases
            // (up to 4 words), only when Accessibility is on, and only
            // after every pattern above has already failed to match — a
            // full sentence almost never means "tap this", but a bare name
            // or button label usually does. ----
            if (AureonAccessibilityService.isEnabled()) {
                int wordCount = text.split("\\s+").length;
                if (wordCount > 0 && wordCount <= 4 && AureonAccessibilityService.clickText(text)) {
                    result.onHandled("Opened \"" + text + "\".");
                    return true;
                }
            }
        } catch (Exception e) { result.onHandled("I couldn't perform that action on this phone."); return true; }
        return false;
    }

    /**
     * "open instagram" -> "instagram"; "instagram खोलो" -> "instagram";
     * "instagram उघडा" -> "instagram". Hindi/Marathi put the verb at the end.
     */
    private static String extractAppNameForOpen(String text, String lower) {
        if (lower.startsWith("open ")) return text.substring(5).trim();
        for (String verb : new String[]{" खोलो", " खोल", " उघडा", " उघड"}) {
            int idx = lower.lastIndexOf(verb);
            if (idx > 0) return text.substring(0, idx).trim();
        }
        return null;
    }

    private static boolean start(Context c, String action, String message, Result result) {
        Intent i = new Intent(action); i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); c.startActivity(i); result.onHandled(message); return true;
    }
    private static boolean launchPackage(Context c, String pkg, String label, Result result) {
        Intent i = c.getPackageManager().getLaunchIntentForPackage(pkg);
        if (i == null) { result.onHandled(label + " isn't installed."); return true; }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); c.startActivity(i); result.onHandled("Opening " + label + "."); return true;
    }

    /**
     * Searches installed launchable apps for one whose visible name best
     * matches the spoken name (e.g. "instagram" -> "Instagram"). Picks the
     * shortest matching label so "maps" prefers "Maps" over a longer
     * variant if both were ever installed.
     */
    private static boolean openAnyApp(Context context, String spokenName, Result result) {
        String needle = spokenName.toLowerCase(Locale.ROOT).trim();
        PackageManager pm = context.getPackageManager();
        Intent query = new Intent(Intent.ACTION_MAIN);
        query.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(query, 0);

        String bestPackage = null;
        String bestLabel = null;
        for (ResolveInfo info : apps) {
            String label = info.loadLabel(pm).toString();
            String labelLower = label.toLowerCase(Locale.ROOT);
            if (labelLower.equals(needle) || labelLower.contains(needle)) {
                if (bestLabel == null || label.length() < bestLabel.length()) {
                    bestLabel = label;
                    bestPackage = info.activityInfo.packageName;
                }
            }
        }

        if (bestPackage == null) {
            result.onHandled("Couldn't find an app matching \"" + spokenName + "\" on this phone.");
            return false;
        }

        Intent launch = pm.getLaunchIntentForPackage(bestPackage);
        if (launch == null) {
            result.onHandled("Couldn't launch " + bestLabel + ".");
            return true;
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(launch);
        result.onHandled("Opening " + bestLabel + ".");
        return true;
    }

    /**
     * Looks up a contact by name and opens WhatsApp (falling back to SMS)
     * with the message pre-filled, ready to send. Returns false (instead of
     * calling result.onHandled) when the contact isn't found, so the caller
     * can fall back to older behaviour.
     *
     * Note: contact names should be spoken the way they're saved in your
     * Contacts app — most Indian contact lists are saved in Roman/English
     * spelling even when you're speaking Hindi/Marathi, so say the name
     * itself in English for the best match (e.g. "message Pavan ...").
     */
    private static boolean messageContact(Context context, String name, String message, Result result) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS)
                != PackageManager.PERMISSION_GRANTED) {
            result.onHandled("Enable Aureon's Contacts permission in phone Settings to message people by name.");
            return true;
        }

        String phoneNumber = findContactNumber(context, name);
        if (phoneNumber == null) {
            return false; // let the caller fall back
        }

        String digitsOnly = phoneNumber.replaceAll("[^0-9]", "");
        // Best-effort: assume a 10-digit local number is Indian and prefix
        // the country code, since WhatsApp's deep link needs one.
        if (digitsOnly.length() == 10) {
            digitsOnly = "91" + digitsOnly;
        }

        boolean whatsappInstalled = isPackageInstalled(context, "com.whatsapp");
        try {
            if (whatsappInstalled) {
                String encoded = URLEncoder.encode(message, StandardCharsets.UTF_8.toString());
                Intent i = new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://api.whatsapp.com/send?phone=" + digitsOnly + "&text=" + encoded));
                i.setPackage("com.whatsapp");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(i);
                result.onHandled("Opening WhatsApp with your message to " + name + " — tap send to deliver it.");
            } else {
                Intent i = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + phoneNumber));
                i.putExtra("sms_body", message);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(i);
                result.onHandled("Opening a text message to " + name + " — tap send to deliver it.");
            }
        } catch (Exception e) {
            result.onHandled("Couldn't open messaging for " + name + ".");
        }
        return true;
    }

    /** Best-effort caller-name lookup so SMS read-back can say a name instead of a raw number. */
    private static String nameForPhoneNumber(Context context, String phoneNumber) {
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

    private static String readMostRecentSms(Context context) {
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                    Telephony.Sms.Inbox.CONTENT_URI,
                    new String[]{ Telephony.Sms.Inbox.ADDRESS, Telephony.Sms.Inbox.BODY },
                    null, null,
                    Telephony.Sms.Inbox.DATE + " DESC LIMIT 1");
            if (cursor == null || !cursor.moveToFirst()) {
                return "No recent text messages found.";
            }
            int addrIdx = cursor.getColumnIndex(Telephony.Sms.Inbox.ADDRESS);
            int bodyIdx = cursor.getColumnIndex(Telephony.Sms.Inbox.BODY);
            String address = addrIdx >= 0 ? cursor.getString(addrIdx) : null;
            String body = bodyIdx >= 0 ? cursor.getString(bodyIdx) : null;
            if (body == null) body = "";
            String from = address;
            String contactName = address != null ? nameForPhoneNumber(context, address) : null;
            if (contactName != null) from = contactName;
            return "From " + (from != null ? from : "unknown") + ": " + body;
        } catch (Exception e) {
            return "Couldn't read text messages on this phone.";
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private static boolean isAppInstalled(Context context, String needleLower) {
        PackageManager pm = context.getPackageManager();
        Intent query = new Intent(Intent.ACTION_MAIN);
        query.addCategory(Intent.CATEGORY_LAUNCHER);
        for (ResolveInfo info : pm.queryIntentActivities(query, 0)) {
            if (info.loadLabel(pm).toString().toLowerCase(Locale.ROOT).contains(needleLower)) return true;
        }
        return false;
    }

    /**
     * Pulls a contact name out of a "location" sentence by stripping known
     * filler words in English/Hindi/Marathi, e.g. "send location to Pavan"
     * -> "Pavan", "Pavan ko location bhejo" -> "Pavan". Word-order-agnostic
     * on purpose since Hindi/Marathi put the verb at the end.
     */
    private static final List<String> LOCATION_FILLERS = java.util.Arrays.asList(
            "send", "share", "location", "to", "with", "my", "current", "live", "the",
            "bhejo", "bhej", "do", "de", "ko", "kar", "karo", "dena", "dedo", "please",
            "लोकेशन", "भेजो", "पाठवा", "को", "ला", "करा", "द्या", "मेरी", "माझे");

    private static String extractLocationContactName(String text) {
        String[] tokens = text.trim().split("\\s+");
        StringBuilder nameBuilder = new StringBuilder();
        for (String token : tokens) {
            String clean = token.toLowerCase(Locale.ROOT);
            if (!LOCATION_FILLERS.contains(clean)) {
                if (nameBuilder.length() > 0) nameBuilder.append(" ");
                nameBuilder.append(token);
            }
        }
        return nameBuilder.length() > 0 ? nameBuilder.toString().trim() : null;
    }

    /**
     * One-time "here I am right now" location link (NOT live-updating),
     * sent the same way messageContact() sends any other text. Uses
     * getLastKnownLocation() (synchronous, no permission-dance callback)
     * rather than requesting a fresh GPS fix, so it can return quickly from
     * this fully-offline, synchronous command path — but that means it can
     * occasionally return null if the phone has no recent fix cached.
     */
    private static boolean sendLocationLink(Context context, String name, Result result) {
        boolean hasFine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean hasCoarse = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!hasFine && !hasCoarse) {
            result.onHandled("Enable Aureon's Location permission in phone Settings to share your location.");
            return true;
        }

        Location best = null;
        try {
            LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
            if (lm != null) {
                for (String provider : new String[]{ LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER }) {
                    try {
                        Location candidate = lm.getLastKnownLocation(provider);
                        if (candidate != null && (best == null || candidate.getTime() > best.getTime())) {
                            best = candidate;
                        }
                    } catch (SecurityException | IllegalArgumentException ignored) { }
                }
            }
        } catch (Exception ignored) { }

        if (best == null) {
            result.onHandled("Couldn't get your current location — make sure Location/GPS is turned on, then try again.");
            return true;
        }

        String link = "https://maps.google.com/?q=" + best.getLatitude() + "," + best.getLongitude();
        boolean sent = messageContact(context, name, "My current location: " + link, result);
        if (!sent) {
            result.onHandled("Couldn't find a contact named \"" + name + "\" to send your location to.");
        }
        return true;
    }

    private static String findContactNumber(Context context, String name) {
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    new String[]{ ContactsContract.CommonDataKinds.Phone.NUMBER,
                            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME },
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
                    new String[]{ "%" + name + "%" },
                    null);
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
                return idx >= 0 ? cursor.getString(idx) : null;
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    private static boolean isPackageInstalled(Context context, String pkg) {
        try {
            context.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }
}
