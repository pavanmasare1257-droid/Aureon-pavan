package com.aureon.ai;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * User-enabled automation bridge. Android requires the user to explicitly
 * enable this service in Accessibility settings before cross-app automation
 * can read UI text, click controls, type, scroll, or perform navigation.
 */
public class AureonAccessibilityService extends AccessibilityService {
    private static AureonAccessibilityService instance;
    private volatile String lastScreenText = "";
    private static long lastAlarmAnnounceAt = 0;
    private static final long ALARM_ANNOUNCE_COOLDOWN_MS = 15000;

    @Override public void onServiceConnected() { instance = this; AvaTeach.attach(this); }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        try { AvaTeach.onEvent(this, event); } catch (Throwable ignored) { }
        if (event != null && event.getEventType() != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            lastScreenText = readScreen();
            maybeAnnounceAlarm(lastScreenText);
        }
    }
    @Override public void onInterrupt() {}
    @Override public void onDestroy() { if (instance == this) instance = null; super.onDestroy(); }

    public static boolean isEnabled() { return instance != null; }
    public static String readScreen() { return instance == null ? "" : instance.readScreenInternal(); }

    /**
     * Announces a ringing alarm by voice — works over the lock screen too,
     * since this service runs system-wide regardless of lock state. Detects
     * an alarm screen by the near-universal presence of a "Snooze" control
     * (works across OEM clock apps without hardcoding any one package
     * name), rather than relying on a specific app to be the source.
     */
    private void maybeAnnounceAlarm(String screenText) {
        if (screenText == null) return;
        String lower = screenText.toLowerCase(Locale.ROOT);
        boolean looksLikeAlarm = lower.contains("snooze");
        if (!looksLikeAlarm) return;

        long now = System.currentTimeMillis();
        if (now - lastAlarmAnnounceAt < ALARM_ANNOUNCE_COOLDOWN_MS) return; // avoid re-announcing on repeat events for the same ringing alarm
        lastAlarmAnnounceAt = now;

        String label = extractAlarmLabel(screenText);
        speak(label != null ? ("Alarm: " + label) : "Your alarm is ringing.");
    }

    /**
     * readScreen() puts one UI element's text per line. The ringing screen
     * always has a handful of predictable lines (current time, today's
     * date, Snooze/Stop/Dismiss buttons) alongside the one line that's
     * actually the alarm's own label — this filters those predictable
     * ones out so only the label (if there is one) gets spoken, instead
     * of reading the whole screen top to bottom.
     */
    private String extractAlarmLabel(String screenText) {
        for (String rawLine : screenText.split("\n")) {
            String trimmed = rawLine.trim();
            if (trimmed.isEmpty()) continue;
            String l = trimmed.toLowerCase(Locale.ROOT);
            if (l.contains("snooze") || l.contains("dismiss") || l.equals("stop")
                    || l.equals("cancel") || l.contains("alarm off") || l.equals("ok")) continue;
            if (trimmed.matches("(?i)\\d{1,2}:\\d{2}(\\s*[ap]\\.?m\\.?)?")) continue; // clock time, e.g. "10:09" / "10:09 AM"
            if (l.matches("(?i).*(monday|tuesday|wednesday|thursday|friday|saturday|sunday).*")) continue; // date line
            return trimmed;
        }
        return null;
    }

    /** A fresh short-lived TTS engine per announcement, shut down once it finishes speaking. */
    private void speak(String text) {
        final TextToSpeech[] engine = new TextToSpeech[1];
        engine[0] = new TextToSpeech(getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS || engine[0] == null) return;
            engine[0].setLanguage(Locale.getDefault());
            engine[0].setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {}
                @Override public void onDone(String utteranceId) { shutdownQuietly(); }
                @Override public void onError(String utteranceId) { shutdownQuietly(); }
                private void shutdownQuietly() {
                    if (engine[0] != null) {
                        try { engine[0].shutdown(); } catch (Exception ignored) {}
                        engine[0] = null;
                    }
                }
            });
            engine[0].speak(text, TextToSpeech.QUEUE_FLUSH, null, "aureon_alarm_announce");
        });
    }

    /** Returns visible UI text/content descriptions from the active window. */
    private String readScreenInternal() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "";
        StringBuilder out = new StringBuilder();
        appendNodeText(root, out, 0);
        root.recycle();
        return out.toString().trim();
    }

    private void appendNodeText(AccessibilityNodeInfo node, StringBuilder out, int depth) {
        if (node == null || depth > 40) return;
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        String value = text != null ? text.toString().trim() : "";
        if (TextUtils.isEmpty(value) && desc != null) value = desc.toString().trim();
        if (!TextUtils.isEmpty(value)) {
            String normalized = value.replaceAll("\\s+", " ");
            if (out.length() == 0 || !out.toString().contains("\n" + normalized + "\n")) out.append(normalized).append('\n');
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                appendNodeText(child, out, depth + 1);
                child.recycle();
            }
        }
    }

    public static boolean typeText(String text) {
        if (instance == null || TextUtils.isEmpty(text)) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo target = findFocusedEditable(root);
        if (target == null) target = findFirstEditable(root);
        if (target == null) { root.recycle(); return false; }
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        target.recycle(); root.recycle();
        return ok;
    }

    public static boolean appendText(String text) {
        if (instance == null || TextUtils.isEmpty(text)) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo target = findFocusedEditable(root);
        if (target == null) target = findFirstEditable(root);
        if (target == null) { root.recycle(); return false; }
        CharSequence old = target.getText();
        String combined = (old == null ? "" : old.toString()) + text;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, combined);
        boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        target.recycle(); root.recycle();
        return ok;
    }

    public static boolean clickText(String query) {
        if (instance == null || TextUtils.isEmpty(query)) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo target = findByText(root, query.toLowerCase(Locale.ROOT));
        boolean ok = target != null && clickNode(target);
        if (target != null) target.recycle();
        root.recycle();
        return ok;
    }

    /**
     * Same as clickText(), but polls for up to timeoutMs — useful right
     * after navigating to a new screen, where the target text may not be
     * in the accessibility tree yet because the screen is still loading.
     * Returns as soon as the click succeeds, or false after the timeout.
     */
    public static boolean clickTextWithRetry(String query, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (clickText(query)) return true;
            try { Thread.sleep(300); } catch (InterruptedException ignored) { return false; }
        }
        return false;
    }

    /** Same idea as clickTextWithRetry, but just checks presence (no click). */
    public static boolean waitForText(String query, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (instance != null && readScreen().toLowerCase(Locale.ROOT).contains(query.toLowerCase(Locale.ROOT))) {
                return true;
            }
            try { Thread.sleep(300); } catch (InterruptedException ignored) { return false; }
        }
        return false;
    }

    public static boolean scroll(boolean forward) {
        if (instance == null) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        boolean ok = performScroll(root, forward);
        root.recycle();
        return ok;
    }

    public static boolean globalAction(int action) {
        return instance != null && instance.performGlobalAction(action);
    }

    public static boolean tap(float x, float y) {
        if (instance == null || android.os.Build.VERSION.SDK_INT < 24) return false;
        Path path = new Path(); path.moveTo(x, y);
        GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, 80);
        return instance.dispatchGesture(new GestureDescription.Builder().addStroke(stroke).build(), null, null);
    }

    private static boolean performScroll(AccessibilityNodeInfo node, boolean forward) {
        if (node.isScrollable()) {
            int action = forward ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
            if (node.performAction(action)) return true;
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                boolean ok = performScroll(child, forward);
                child.recycle();
                if (ok) return true;
            }
        }
        return false;
    }

    private static boolean clickNode(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        while (current != null) {
            if (current.isClickable() && current.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
            AccessibilityNodeInfo parent = current.getParent();
            if (current != node) current.recycle();
            current = parent;
        }
        return false;
    }

    private static AccessibilityNodeInfo findFocusedEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isFocused() && node.isEditable()) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findFocusedEditable(child);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    private static AccessibilityNodeInfo findFirstEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable() && node.isEnabled()) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findFirstEditable(child);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    private static AccessibilityNodeInfo findByText(AccessibilityNodeInfo node, String query) {
        if (node == null) return null;
        String t = node.getText() == null ? "" : node.getText().toString().toLowerCase(Locale.ROOT);
        String d = node.getContentDescription() == null ? "" : node.getContentDescription().toString().toLowerCase(Locale.ROOT);
        if (t.contains(query) || d.contains(query)) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findByText(child, query);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    // ---------------- Form filling (Application Profile) ----------------
    // Scans the foreground screen/page for fillable controls (text boxes,
    // checkboxes, radio buttons, dropdowns) and acts on them by index.
    // Never reads or fills password fields, and never taps Submit/Apply.
    //
    // The index counts EVERY non-password control in tree order (visible or
    // not) and the walk never descends into a control, so scan-pass and
    // act-pass always agree even if the keyboard changes what is visible.

    private static volatile boolean scanSawPassword = false;
    public static boolean lastScanSawPassword() { return scanSawPassword; }

    // ---- App Agent (v52): a numbered snapshot of the visible screen, and acting on a node by that number.
    // Password fields are never exposed (empty text) and never typed into. Every act re-checks the label, so a changed screen is refused, not guessed.
    private static final int UI_MAX_NODES = 150;

    private static String uiLabel(AccessibilityNodeInfo n) {
        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        String s = (t != null && t.length() > 0) ? t.toString() : (d != null ? d.toString() : "");
        s = s.replace('\n', ' ').trim();
        return s.length() > 80 ? s.substring(0, 80) : s;
    }

    private static void collectUi(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> out, int depth) {
        if (node == null || out.size() >= UI_MAX_NODES || depth > 25) return;
        if (!node.isVisibleToUser()) return;
        CharSequence t = node.getText();
        CharSequence d = node.getContentDescription();
        boolean useful = (t != null && t.length() > 0) || (d != null && d.length() > 0)
                || node.isClickable() || node.isEditable() || node.isScrollable();
        if (useful) out.add(AccessibilityNodeInfo.obtain(node));
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                collectUi(child, out, depth + 1);
                child.recycle();
            }
        }
    }

    private static void recycleAll(List<AccessibilityNodeInfo> list) {
        for (AccessibilityNodeInfo n : list) { try { n.recycle(); } catch (Throwable ignored) { } }
    }

    /** JSON: {"pkg":"...","nodes":[{"i":0,"k":"Button","t":"text","d":"desc","c":true,"e":false,"s":false,"x":false}]} or "" if no screen. */
    public static String snapshotUi() {
        if (instance == null) return "";
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return "";
        List<AccessibilityNodeInfo> list = new ArrayList<AccessibilityNodeInfo>();
        try {
            collectUi(root, list, 0);
            JSONObject o = new JSONObject();
            CharSequence pkg = root.getPackageName();
            o.put("pkg", pkg == null ? "" : pkg.toString());
            JSONArray arr = new JSONArray();
            for (int i = 0; i < list.size(); i++) {
                AccessibilityNodeInfo n = list.get(i);
                boolean pw = n.isPassword();
                String t = pw ? "" : (n.getText() != null ? n.getText().toString().replace('\n', ' ').trim() : "");
                String d = pw ? "(password field)" : (n.getContentDescription() != null ? n.getContentDescription().toString().replace('\n', ' ').trim() : "");
                if (t.length() > 80) t = t.substring(0, 80);
                if (d.length() > 80) d = d.substring(0, 80);
                String cls = n.getClassName() == null ? "" : n.getClassName().toString();
                int dot = cls.lastIndexOf('.');
                JSONObject j = new JSONObject();
                j.put("i", i);
                j.put("k", dot >= 0 ? cls.substring(dot + 1) : cls);
                j.put("t", t);
                j.put("d", d);
                j.put("c", n.isClickable());
                j.put("e", n.isEditable() && !pw);
                j.put("s", n.isScrollable());
                j.put("x", n.isChecked());
                arr.put(j);
            }
            o.put("nodes", arr);
            return o.toString();
        } catch (Throwable t) {
            return "";
        } finally {
            recycleAll(list);
            root.recycle();
        }
    }

    /** Click node #index, only if its label still equals expectLabel (the screen did not change under us). */
    public static boolean agentClick(int index, String expectLabel) {
        if (instance == null) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        List<AccessibilityNodeInfo> list = new ArrayList<AccessibilityNodeInfo>();
        try {
            collectUi(root, list, 0);
            if (index < 0 || index >= list.size()) return false;
            AccessibilityNodeInfo n = list.get(index);
            if (!uiLabel(n).equals(expectLabel == null ? "" : expectLabel.trim())) return false;
            return clickNode(n);
        } catch (Throwable t) {
            return false;
        } finally {
            recycleAll(list);
            root.recycle();
        }
    }

    /** Type text into editable node #index (never into a password field), only if its label still matches. */
    public static boolean agentType(int index, String text, String expectLabel) {
        if (instance == null || text == null) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        List<AccessibilityNodeInfo> list = new ArrayList<AccessibilityNodeInfo>();
        try {
            collectUi(root, list, 0);
            if (index < 0 || index >= list.size()) return false;
            AccessibilityNodeInfo n = list.get(index);
            if (!n.isEditable() || n.isPassword()) return false;
            if (!uiLabel(n).equals(expectLabel == null ? "" : expectLabel.trim())) return false;
            n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            return n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        } catch (Throwable t) {
            return false;
        } finally {
            recycleAll(list);
            root.recycle();
        }
    }

    public static String activePackage() {
        if (instance == null) return "";
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return "";
        CharSequence pkg = root.getPackageName();
        root.recycle();
        return pkg == null ? "" : pkg.toString();
    }

    private static String controlType(AccessibilityNodeInfo n) {
        if (n.isPassword()) return "password";
        if (!n.isEnabled()) return null;
        if (n.isEditable()) return "text";
        CharSequence cn = n.getClassName();
        String c = cn == null ? "" : cn.toString();
        if (n.isCheckable()) return c.contains("RadioButton") ? "radio" : "checkbox";
        if (c.contains("Spinner")) return "dropdown";
        return null;
    }

    private static String joinLabel(String a, String b) {
        if (b == null || b.isEmpty() || a.equals(b) || a.contains(b)) return a;
        if (a.isEmpty()) return b;
        return a + " | " + b;
    }

    /** JSON array of visible controls: {index, type, label, current, checked, group, option, multiline}. */
    public static String scanForm() {
        scanSawPassword = false;
        JSONArray out = new JSONArray();
        if (instance == null) return out.toString();
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return out.toString();
        try {
            walkForm(root, new int[]{0}, new String[]{""}, out, 0);
        } catch (Exception ignored) {}
        root.recycle();
        return out.toString();
    }

    private static void walkForm(AccessibilityNodeInfo node, int[] idx, String[] lastLabel,
                                 JSONArray out, int depth) throws JSONException {
        if (node == null || depth > 45) return;
        String type = controlType(node);
        if ("password".equals(type)) {
            if (node.isVisibleToUser()) scanSawPassword = true;
            return;
        }
        if (type != null) {
            int myIndex = idx[0]++;
            if (node.isVisibleToUser()) {
                CharSequence txtCs = node.getText();
                String txt = txtCs == null ? "" : txtCs.toString().trim();
                CharSequence descCs = node.getContentDescription();
                String desc = descCs == null ? "" : descCs.toString().trim();
                JSONObject f = new JSONObject();
                f.put("index", myIndex);
                f.put("type", type);
                if ("text".equals(type)) {
                    CharSequence hintCs = Build.VERSION.SDK_INT >= 26 ? node.getHintText() : null;
                    String hint = hintCs == null ? "" : hintCs.toString().trim();
                    boolean showingHint = Build.VERSION.SDK_INT >= 26 && node.isShowingHintText();
                    String current = showingHint ? "" : txt;
                    String label = joinLabel(joinLabel(lastLabel[0], hint), desc);
                    f.put("label", label.length() > 200 ? label.substring(0, 200) : label);
                    f.put("current", current.length() > 300 ? current.substring(0, 300) : current);
                    f.put("multiline", node.isMultiLine());
                } else if ("dropdown".equals(type)) {
                    f.put("label", joinLabel(lastLabel[0], desc));
                    f.put("current", txt);
                } else {
                    String own = !txt.isEmpty() ? txt : desc;
                    f.put("checked", node.isChecked());
                    if ("radio".equals(type)) {
                        f.put("group", lastLabel[0]);
                        f.put("option", own.isEmpty() ? ("option " + myIndex) : own);
                    } else {
                        f.put("label", own.isEmpty() ? lastLabel[0] : own);
                    }
                }
                out.put(f);
            }
            if ("text".equals(type) || "dropdown".equals(type)) lastLabel[0] = "";
            return;
        }
        CharSequence t = node.getText();
        if (t != null && !node.isClickable()) {
            String str = t.toString().trim();
            if (str.length() >= 2 && str.length() <= 200) lastLabel[0] = str;
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                walkForm(child, idx, lastLabel, out, depth + 1);
                child.recycle();
            }
        }
    }

    private static AccessibilityNodeInfo locateControl(int target) {
        if (instance == null) return null;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return null;
        AccessibilityNodeInfo found = locate(root, new int[]{0}, target, 0);
        root.recycle();
        return found;
    }

    private static AccessibilityNodeInfo locate(AccessibilityNodeInfo node, int[] idx, int target, int depth) {
        if (node == null || depth > 45) return null;
        String type = controlType(node);
        if ("password".equals(type)) return null;
        if (type != null) {
            if (idx[0]++ == target) return AccessibilityNodeInfo.obtain(node);
            return null;
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = locate(child, idx, target, depth + 1);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    private static void pause(int ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) {}
    }

    public static boolean setTextAt(int index, String value) {
        AccessibilityNodeInfo n = locateControl(index);
        if (n == null) return false;
        n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        boolean ok = n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        n.recycle();
        return ok;
    }

    private static boolean clickControl(AccessibilityNodeInfo n) {
        boolean ok = clickNode(n);
        if (!ok) ok = n.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        return ok;
    }

    public static boolean clickAt(int index) {
        AccessibilityNodeInfo n = locateControl(index);
        if (n == null) return false;
        boolean ok = clickControl(n);
        n.recycle();
        return ok;
    }

    public static boolean setCheckedAt(int index, boolean wantChecked) {
        AccessibilityNodeInfo n = locateControl(index);
        if (n == null) return false;
        boolean ok = true;
        if (n.isChecked() != wantChecked) ok = clickControl(n);
        n.recycle();
        return ok;
    }

    /**
     * Opens a dropdown and reads its options (native popup only). Returns an
     * empty array if nothing opened or the "popup" looks like the whole page
     * (a custom inline widget) — those are left for the user. Only presses
     * BACK when a small popup really appeared, so it can never navigate the
     * page away.
     */
    public static JSONArray readDropdownOptions(int index) {
        JSONArray opts = new JSONArray();
        AccessibilityNodeInfo n = locateControl(index);
        if (n == null) return opts;
        String before = readScreen();
        boolean clicked = clickControl(n);
        if (!clicked) { n.recycle(); return opts; }
        pause(700);
        String after = readScreen();
        if (after == null || after.equals(before)) { n.recycle(); return opts; }
        String[] lines = after.split("\n");
        if (lines.length > 40) {
            // Inline widget opened over the page: toggle it closed, skip it.
            AccessibilityNodeInfo again = locateControl(index);
            if (again != null) { clickControl(again); again.recycle(); }
            n.recycle();
            return opts;
        }
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        for (String line : lines) {
            String o = line.trim();
            String low = o.toLowerCase(Locale.ROOT);
            if (o.isEmpty() || o.length() > 80) continue;
            if (low.equals("cancel") || low.equals("done") || low.equals("ok") || low.equals("close")) continue;
            if (seen.add(low)) opts.put(o);
        }
        performGlobalActionStatic(GLOBAL_ACTION_BACK);
        pause(500);
        n.recycle();
        return opts;
    }

    private static void performGlobalActionStatic(int action) {
        if (instance != null) instance.performGlobalAction(action);
    }

    /** Opens the dropdown at index and taps the option whose text matches. */
    public static boolean chooseDropdown(int index, String option) {
        AccessibilityNodeInfo n = locateControl(index);
        if (n == null) return false;
        boolean clicked = clickControl(n);
        n.recycle();
        if (!clicked) return false;
        pause(700);
        boolean ok = selectOptionText(option, 2500);
        if (!ok) {
            performGlobalActionStatic(GLOBAL_ACTION_BACK);
            pause(400);
        }
        return ok;
    }

    private static boolean selectOptionText(String option, int timeoutMs) {
        String q = option.trim().toLowerCase(Locale.ROOT);
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (instance != null) {
                AccessibilityNodeInfo root = instance.getRootInActiveWindow();
                if (root != null) {
                    AccessibilityNodeInfo hit = findExactText(root, q);
                    if (hit == null) hit = findByText(root, q);
                    root.recycle();
                    if (hit != null) {
                        boolean ok = clickControl(hit);
                        hit.recycle();
                        if (ok) return true;
                    }
                }
            }
            pause(300);
        }
        return false;
    }

    private static AccessibilityNodeInfo findExactText(AccessibilityNodeInfo node, String q) {
        if (node == null) return null;
        CharSequence tCs = node.getText();
        CharSequence dCs = node.getContentDescription();
        String t = tCs == null ? "" : tCs.toString().trim().toLowerCase(Locale.ROOT);
        String d = dCs == null ? "" : dCs.toString().trim().toLowerCase(Locale.ROOT);
        if (t.equals(q) || d.equals(q)) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findExactText(child, q);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    // ---------------- Login + button helpers (auto-apply) ----------------

    private static AccessibilityNodeInfo findPasswordNode(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 45) return null;
        if (node.isPassword() && node.isEditable() && node.isEnabled() && node.isVisibleToUser()) {
            return AccessibilityNodeInfo.obtain(node);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findPasswordNode(child, depth + 1);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    /** Types into the visible password box. The value never leaves this process. */
    public static boolean fillPasswordField(String value) {
        if (instance == null || value == null) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo n = findPasswordNode(root, 0);
        root.recycle();
        if (n == null) return false;
        n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        boolean ok = n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        n.recycle();
        return ok;
    }

    private static AccessibilityNodeInfo findRegexNode(AccessibilityNodeInfo node, java.util.regex.Pattern p, int depth) {
        if (node == null || depth > 45) return null;
        if (node.isVisibleToUser() && !node.isEditable()) {
            CharSequence tCs = node.getText();
            CharSequence dCs = node.getContentDescription();
            String t = tCs == null ? "" : tCs.toString().trim();
            String d = dCs == null ? "" : dCs.toString().trim();
            if ((!t.isEmpty() && p.matcher(t).matches()) || (!d.isEmpty() && p.matcher(d).matches())) {
                return AccessibilityNodeInfo.obtain(node);
            }
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findRegexNode(child, p, depth + 1);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    /** Taps the first visible button/link whose whole text matches the pattern. */
    public static boolean clickButtonMatching(java.util.regex.Pattern p) {
        if (instance == null) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo hit = findRegexNode(root, p, 0);
        root.recycle();
        if (hit == null) return false;
        boolean ok = clickControl(hit);
        hit.recycle();
        return ok;
    }
}
