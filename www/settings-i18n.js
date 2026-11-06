/* Aureon — Settings language switch (English <-> Hinglish).
   Default is English. Turn it off in Settings > General > "English interface" to get the
   original Hinglish text back. Works on static text, placeholders and on text that the other
   scripts (device-guard, connect-hub, skills-hub, app.js) write into the page later.
   It never touches chat messages or anything the user types. */
(function () {
  'use strict';
  var KEY = 'aureon_ui_en';              // '1' = English (default), '0' = Hinglish
  function isEn() { try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; } }
  function setEn(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* private mode */ } }

  /* ---------- exact strings (Hinglish -> English) ---------- */
  var T = {
    // Ava's built-in lines (v44) - exact texts from ava-bot.js
    "Ava ko wapas bulao": "Call Ava back",
    "Screen dekhna on/off — Ava screen par jo chal raha hai wo yaad rakhegi": "Screen watching on/off - Ava remembers what is happening on the screen",
    "Ava ne kya naya khoja": "What new thing Ava found",
    "Abhi kuch naya seekho": "Learn something new now",
    "Order do ya kuch pucho…": "Give an order or ask something…",
    "Ye galat hai! 😠 Mujhe gussa aa raha hai.": "This is wrong! 😠 I'm getting angry.",
    "Hmph! Aisa kuch dekhna theek nahi lag raha.": "Hmph! This doesn't feel right to watch.",
    "Ye sab bilkul sahi nahi hai 😤": "None of this is right 😤",
    "Aww… mujhe rona aa raha hai 😢": "Aww… I feel like crying 😢",
    "Ye dekh ke dil bhar aaya… 💧": "This made my heart heavy… 💧",
    "Bahut dukh hua ye dekh ke 😭": "I felt very sad seeing this 😭",
    "Hayyy… 🙈 mai nahi dekh rahi!": "Hayyy… 🙈 I'm not looking!",
    "Ee… sharam aa rahi hai, aankhein band! 🙈": "Eee… I'm shy, eyes closed! 🙈",
    "Uff! Mai udhar nahi dekhungi 😳": "Uff! I won't look over there 😳",
    "Hmph! 😠 Dekho, ab mai gusse me hu.": "Hmph! 😠 Look, now I'm angry.",
    "Huhuhu… 😢 mujhe rona aa gaya.": "Huhuhu… 😢 I started crying.",
    "Hayyy… 🙈 sharam aa rahi hai.": "Hayyy… 🙈 I'm feeling shy.",
    "Hmph! 😠 Aise mat bolo, mujhe bura lagta hai.": "Hmph! 😠 Don't say that, it hurts my feelings.",
    "naya seekh rahi hu…": "learning something new…",
    "Servers pe nazar hai. Kuch gadbad dikhi to bataungi.": "I'm watching the servers. I'll tell you if anything looks wrong.",
    "Approve/Reject tumhare haath me hi rahega, mai sirf dekhti hu.": "Approve/Reject stays in your hands, I only watch.",
    "Yahin ghoom rahi hu — kuch chahiye to tap karo.": "I'm hanging around here - tap me if you need something.",
    "Order do, mai phone pe kar dungi.": "Give me an order, I'll do it on the phone.",
    "Naya kuch seekhne ka mood hai, dekhte hain.": "In the mood to learn something new, let's see.",
    "Bore ho rahe ho? Mujhse baat karo.": "Feeling bored? Talk to me.",
    'Device key daalo': 'Enter your device key',
    'Abhi check nahi hua': 'Not checked yet',
    'Aureon ko kya yaad rakhna hai': 'What Aureon should remember',
    'Forms ke liye tumhari details': 'Your details for filling forms',
    'Koi saved login nahi': 'No saved logins',
    'Koi saved login nahi.': 'No saved logins.',
    'Koi bhi app jodo, kaam automate karo': 'Connect any app and automate tasks',
    'Skills install karo': 'Install skills',
    'Apni photo': 'Your photo',
    'Owner code chahiye': 'Owner code required',
    'Device key (dashboard → My Phone → Naya phone jodo)': 'Device key (dashboard → My Phone → Add new phone)',
    'Key save': 'Save key',
    'Abhi check karo': 'Check now',
    'Roz apne aap check (app khulne par)': 'Check automatically every day (when the app opens)',
    'Jude hue apps': 'Connected apps',
    'App jodo': 'Connect an app',
    'Naam (jaise Notion, GitHub, Slack)': 'Name (e.g. Notion, GitHub, Slack)',
    'Token custom header me': 'Token in custom header',
    'Koi auth nahi': 'No authentication',
    'Header ka naam (jaise X-API-Key)': 'Header name (e.g. X-API-Key)',
    'Nayi automation': 'New automation',
    'Naam (jaise Roz subah summary)': 'Name (e.g. Daily morning summary)',
    'Kya karna hai? Jaise: Mere GitHub repos me naye issues dekho aur Slack pe summary bhejo.': 'What should it do? e.g. Check new issues in my GitHub repos and send a summary to Slack.',
    'Kaun se apps use kare:': 'Which apps should it use:',
    'Sirf jab main chalau': 'Only when I run it',
    'Har kuch minute me (apne aap)': 'Every few minutes (automatic)',
    'Jab koi link hit kare (webhook)': 'When a link is called (webhook)',
    'Kitne minute baad (min 5)': 'Run every how many minutes (min 5)',
    'Changes allowed (message bhejna, likhna, delete karna). Band ho to sirf padhegi.': 'Allow changes (sending messages, writing, deleting). When off, it can only read.',
    'Automation banao': 'Create automation',
    'Apne aap chalne wali automations tabhi chalti hain jab server jaag raha ho (free Render sleep karta hai — uptime pinger ya webhook trigger use karo).': 'Automatic automations only run while the server is awake (free Render sleeps — use an uptime pinger or a webhook trigger).',
    'Skill install karo': 'Install skill',
    'Code mode chalu': 'Turn on Code mode',
    'Aureon ka look chuno. Turant lagta hai aur yaad rehta hai.': 'Choose how Aureon looks. It applies instantly and is remembered.',
    'Purani black + gold theme': 'Original black + gold theme',
    'Ava (udta hua bot)': 'Ava (floating bot)',
    'Ava phone screen par (doosre apps ke upar)': 'Ava on the phone screen (over other apps)',
    'Auto (jaisa main likhu)': 'Auto (match how I write)',
    'Aureon ko tumhare baare mein kya yaad rakhna hai — jaise "short jawab do", "Hinglish mein reply karo".': 'What Aureon should remember about you — e.g. "keep answers short", "reply in Hinglish".',
    'Ek line mein ek preference…': 'One preference per line…',
    'Apni details ek baar likho — naam, phone, email, education, skills, projects, links, notice period. Forms isi se bharte hain. Sirf sach likho. Password / OTP / card / Aadhaar mat likhna.': 'Write your details once — name, phone, email, education, skills, projects, links, notice period. Forms are filled from this. Only write true information. Do not enter passwords, OTPs, cards or Aadhaar numbers.',
    'ON hone par Aureon khud Apply / Next / Submit dabata hai — sirf tab jab koi zaroori jawab khaali na ho. Verification code, captcha ya login problem par ruk ke notification deta hai. Pehle OFF rakhke test karo.': 'When ON, Aureon taps Apply / Next / Submit by itself — only when no required answer is empty. It stops and sends a notification on a verification code, captcha or login problem. Test with it OFF first.',
    'Sirf is phone par, encrypted. Password cloud ya AI ko kabhi nahi jaata. Site ka naam job link jaisa likho (e.g. linkedin.com). Code / captcha wale logins khud karne honge.': 'Stored only on this phone, encrypted. Passwords are never sent to the cloud or the AI. Enter the site name as in the job link (e.g. linkedin.com). Logins that need a code or captcha you will have to complete yourself.',
    'Apne chehre ki saaf photo daalo — Love Camera tumhe naam se pehchanega aur greet karega.': 'Add a clear photo of your face — Love Camera will recognise you by name and greet you.',
    'On — khud submit karega': 'On — submits automatically',
    /* messages written by device-guard.js */
    'Ye feature sirf Aureon Android app mein chalta hai (phone ki settings padhne ke liye).': 'This feature only works in the Aureon Android app (it needs to read the phone’s settings).',
    'Pehle device key daalo (Security dashboard → My Phone → Naya phone jodo).': 'Enter your device key first (Security dashboard → My Phone → Add new phone).',
    'Phone check ho raha hai…': 'Checking the phone…',
    'Device key galat / hata di gayi hai. Dashboard se nayi key banao.': 'The device key is wrong or has been removed. Create a new key in the dashboard.',
    'Key save ho gayi. Ab "Abhi check karo" dabao.': 'Key saved. Now tap "Check now".',
    /* connect-hub.js */
    'MCP server (koi bhi remote MCP)': 'MCP server (any remote MCP)',
    'Abhi koi app nahi jodi.': 'No apps connected yet.',
    'Pehle upar koi app jodo.': 'Connect an app above first.',
    'Abhi koi automation nahi.': 'No automations yet.',
    'Chal rahi hai…': 'Running…',
    'Band karo': 'Turn off',
    'Chalu karo': 'Turn on',
    'Pehle sign in karo.': 'Please sign in first.',
    'Server par SENTINEL_ENC_KEY set nahi hai — token save nahi ho payega.': 'SENTINEL_ENC_KEY is not set on the server — the token can’t be saved.',
    'Connect ho raha hai…': 'Connecting…',
    'Ban rahi hai…': 'Creating…',
    'Ban gayi': 'Created',
    /* skills-hub.js */
    'Abhi koi skill nahi. Upar GitHub link daalo.': 'No skills yet. Paste a GitHub link above.',
    '(description nahi hai)': '(no description)',
    'Hata nahi paaya': 'Could not remove it',
    'Sirf https://github.com/... ka link chalega.': 'Only https://github.com/... links are supported.',
    'Install ho rahi hai…': 'Installing…',
    'Code mode chalu — ab chat mein likho.': 'Code mode is on — now type in the chat.',
    /* app.js (settings related) */
    'Profile save ho gayi.': 'Profile saved.',
    'Sirf installed app mein kaam karta hai.': 'This only works in the installed app.',
    'Login is phone par encrypted save ho gaya.': 'Login saved, encrypted on this phone.',
    'Sentinel dashboard kholne ke liye apna owner code daalo.': 'Enter your owner code to open the Sentinel dashboard.',
    'Kholo': 'Open',
    'Code khaali nahi ho sakta.': 'The code can’t be empty.',
    /* video-ui.js */
    'Pehle likho ki kaisa video chahiye, phir video button dabao.': 'First type what kind of video you want, then tap the video button.'
  };

  /* ---------- strings that contain markup (innerHTML) ---------- */
  var H = {
    'pg-intro': 'This sends the phone’s security settings (screen lock, root, USB debugging, patch level) and the list of installed apps to <b>your own backend</b> — nobody else. It changes nothing, it only reads. Result: Security dashboard → My Phone. This is not an antivirus.',
    'ap-intro': 'Connect any app — <b>MCP server</b>, <b>REST API</b> or <b>Webhook</b> (Slack, Discord, Zapier, Make, n8n...). Then tell Aureon what to do in plain language and it will run that app by itself. The token is stored encrypted on the server and is never sent back to the app.',
    'cs-intro': 'Paste any <b>GitHub skill link</b> (repo, folder or SKILL.md link). Once installed it appears in the list below and <b>Code mode</b> and <b>Coding mode</b> will use it automatically (you can also install from any chat: <i>npx skills add owner/repo</i> or a GitHub link + “skill install karo”). A skill is only text guidance — it doesn’t run anything.'
  };

  /* ---------- strings with numbers / names in them ---------- */
  var R = [
    [/^(\d+) issue\(s\) mile\. Details dekhne ke liye Security dashboard → My Phone kholo\.$/, '$1 issue(s) found. Open Security dashboard → My Phone for details.'],
    [/^Server ne report nahi li \((\d+)\)\.$/, 'The server did not accept the report ($1).'],
    [/^Check fail: (.*)$/, 'Check failed: $1'],
    [/^abhi$/, 'just now'],
    [/^(\d+) min pehle$/, '$1 min ago'],
    [/^(\d+) ghante pehle$/, '$1 hours ago'],
    [/^(\d+) din pehle$/, '$1 days ago'],
    [/^(.+) test ho raha hai…$/, 'Testing $1…'],
    [/^(.+): chal raha hai(.*)$/, '$1: working$2'],
    [/^Jud gaya(.*)$/, 'Connected$1'],
    [/^\((\d+) tools mile\)$/, '($1 tools found)'],
    [/^Webhook link \(sirf abhi dikhega, copy kar lo\):([\s\S]*)$/, 'Webhook link (shown only now, copy it):$1'],
    [/^Ban gayi\. Webhook link \(sirf abhi dikhega, copy kar lo\):([\s\S]*)$/, 'Created. Webhook link (shown only now, copy it):$1'],
    [/^(\d+) skill install ho gayi$/, '$1 skill(s) installed'],
    [/^Save nahi hui: (.*)$/, 'Could not save: $1'],
    [/^Dashboard khul nahi paya\. Browser me ye link khol lo:([\s\S]*)$/, 'The dashboard could not be opened. Open this link in your browser:$1']
  ];

  function lookup(s) {
    if (T[s] !== undefined) return T[s];
    for (var i = 0; i < R.length; i++) if (R[i][0].test(s)) return s.replace(R[i][0], R[i][1]);
    return null;
  }
  /* translate a string, keeping leading / trailing whitespace */
  function tr(s) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    if (!m[2]) return null;
    var t = lookup(m[2]);
    return t === null ? null : m[1] + t + m[3];
  }

  var busy = false;
  var nodeOrig = new WeakMap();      // text node -> { o: original, t: translated }
  var ATTRS = ['placeholder', 'title', 'aria-label'];

  function skip(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') return true;
    if (el.id === 'messages' || el.id === 'chat-input' || el.id === 'home-input') return true;
    return false;
  }
  function inSkipped(node) {
    for (var el = node.nodeType === 1 ? node : node.parentNode; el; el = el.parentNode) if (skip(el)) return true;
    return false;
  }

  function doText(node) {
    var rec = nodeOrig.get(node);
    if (rec && node.data === rec.t) return;                 // already translated by us
    var t = tr(node.data);
    if (t === null) { if (rec) nodeOrig.delete(node); return; }
    nodeOrig.set(node, { o: node.data, t: t });
    node.data = t;
  }
  function doAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], v = el.getAttribute(a);
      if (!v) continue;
      var store = 'data-i18n-o-' + a;
      if (el.hasAttribute(store) && el.getAttribute('data-i18n-t-' + a) === v) continue;
      var t = tr(v);
      if (t === null) continue;
      el.setAttribute(store, v); el.setAttribute('data-i18n-t-' + a, t); el.setAttribute(a, t);
    }
  }
  function doHtml(el) {
    var id = el.getAttribute('data-i18n-html');
    if (!id || H[id] === undefined) return;
    if (!el.hasAttribute('data-i18n-orig')) el.setAttribute('data-i18n-orig', el.innerHTML);
    el.innerHTML = H[id];
    el.setAttribute('data-i18n-done', '1');
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 1 && root.tagName === 'TEXTAREA') { doAttrs(root); return; }
    if (inSkipped(root)) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    if (root.hasAttribute('data-i18n-html')) {
      if (!root.hasAttribute('data-i18n-done')) doHtml(root);
      return;
    }
    doAttrs(root);
    if (root.tagName === 'TEXTAREA') return;      // placeholder only, never the typed value
    for (var c = root.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && skip(c) && c.tagName !== 'TEXTAREA') continue;
      walk(c);
    }
  }

  /* ---------- put the original Hinglish text back ---------- */
  function restore(root) {
    if (root.nodeType === 3) {
      var rec = nodeOrig.get(root);
      if (rec && root.data === rec.t) { root.data = rec.o; nodeOrig.delete(root); }
      return;
    }
    if (root.nodeType !== 1) return;
    if (root.hasAttribute('data-i18n-orig') && root.hasAttribute('data-i18n-done')) {
      root.innerHTML = root.getAttribute('data-i18n-orig'); root.removeAttribute('data-i18n-done'); return;
    }
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (root.hasAttribute('data-i18n-o-' + a)) {
        if (root.getAttribute(a) === root.getAttribute('data-i18n-t-' + a)) root.setAttribute(a, root.getAttribute('data-i18n-o-' + a));
        root.removeAttribute('data-i18n-o-' + a); root.removeAttribute('data-i18n-t-' + a);
      }
    }
    for (var c = root.firstChild; c; c = c.nextSibling) restore(c);
  }

  function apply() {
    busy = true;
    try { if (isEn()) walk(document.body); else restore(document.body); }
    finally { busy = false; }
  }

  /* ---------- keep dynamic text translated ---------- */
  var pending = [], scheduled = false;
  function flush() {
    scheduled = false;
    if (!isEn()) { pending = []; return; }
    var list = pending; pending = [];
    busy = true;
    try { for (var i = 0; i < list.length; i++) if (list[i].isConnected !== false) walk(list[i]); }
    finally { busy = false; }
  }
  function queue(n) { pending.push(n); if (!scheduled) { scheduled = true; Promise.resolve().then(flush); } }
  function observe() {
    var mo = new MutationObserver(function (muts) {
      if (busy || !isEn()) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) queue(m.addedNodes[j]); }
        else if (m.type === 'characterData') queue(m.target);
        else if (m.type === 'attributes') queue(m.target);
      }
    });
    mo.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ATTRS });
  }

  /* alert() text written in the other scripts */
  var nativeAlert = window.alert;
  window.alert = function (msg) {
    if (isEn() && typeof msg === 'string') { var t = tr(msg); if (t !== null) msg = t; }
    return nativeAlert.call(window, msg);
  };

  /* ---------- the toggle in Settings > General ---------- */
  function wireToggle() {
    var cb = document.getElementById('toggle-ui-en');
    if (!cb || cb.dataset.wired) return;
    cb.dataset.wired = '1';
    cb.checked = isEn();
    cb.addEventListener('change', function () { setEn(cb.checked); apply(); });
  }

  function start() {
    // mark the long paragraphs that contain markup
    var map = { 'pg-intro': '[data-pane="phoneguard"] > .card-sub', 'ap-intro': '[data-pane="connect"] > .card-sub', 'cs-intro': '[data-pane="claudecode"] > .card-sub' };
    Object.keys(map).forEach(function (id) {
      var el = document.querySelector(map[id]);
      if (el && !el.hasAttribute('data-i18n-html')) el.setAttribute('data-i18n-html', id);
    });
    wireToggle();
    apply();
    observe();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.AureonI18n = { apply: apply, isEnglish: isEn, setEnglish: function (v) { setEn(!!v); var cb = document.getElementById('toggle-ui-en'); if (cb) cb.checked = !!v; apply(); } };
})();
