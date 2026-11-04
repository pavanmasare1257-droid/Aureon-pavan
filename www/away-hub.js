/* Aureon — Away mode (v41). Say it in chat: "nahane ja raha hu, 20 minute, call aaye to utha lena" and, for that time, Ava answers calls
   on this phone, talks to the caller, remembers it and reports to you when you are back. "main aa gaya" turns it off.
   The calls themselves are handled natively (AureonAwayMode.java); this file only switches it on/off and shows the report.
   Needs app.js globals: state, authHeaders(), addMessage(), saveChatSnapshot(). Works only inside the Android app. */
(function () {
  function plugin() { var C = window.Capacitor; return C && C.Plugins && C.Plugins.AureonActions; }
  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }
  function say(text) {
    if (typeof addMessage === 'function') addMessage('ai', text);
    if (typeof state !== 'undefined' && state.currentMessages) { state.currentMessages.push({ role: 'assistant', content: text }); if (typeof saveChatSnapshot === 'function') saveChatSnapshot(); }
  }
  function busy(on) { var t = document.getElementById('typing-indicator'); if (t) t.classList[on ? 'remove' : 'add']('hidden'); }
  async function post(path, body) {
    var res = await fetch(base() + '/api/away' + path, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body || {}) });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(j.error || ('Server error (' + res.status + ')'));
    return j;
  }

  var REASON_WORD = /(nahane|nahaane|naha|nahana|bath|so\s?(raha|rahi|rhi|rha|ne)|sone|soya|meeting|drive|gaadi|gadi|bike|khana|khaana|namaz|puja|pooja|padhai|exam|busy|kaam)/i;
  var EXPLICIT_ON = /(away mode|auto\s*call|call\s*pick|calls?\s*(utha|uthao|pick)|call\s*utha\s*lena)/i;
  var TIME_RE = /(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|ghanta|ghante|ghnta|hour|hours|hr|hrs)\b/i;
  var OFF_RE = /(away\s*(mode)?\s*(off|band|stop)|auto\s*call\s*(off|band|stop)|main\s*aa\s*gaya|mai\s*aa\s*gaya|aa\s*gaya\s*hu|aa\s*gayi\s*hu|call\s*pick\s*(off|band)|away\s*band)/i;
  var REPORT_RE = /(kisne\s*call|kiska\s*call|kiski\s*call|peeche\s*(kya|call)|away\s*report|calls?\s*ka\s*hisaab|kya\s*hua\s*mere\s*peeche)/i;

  function parseMinutes(t) {
    if (/(aadha|adha|half)\s*(ghanta|ghante|hour)/i.test(t)) return 30;
    var m = TIME_RE.exec(t); if (!m) return 30;
    var n = parseFloat(m[1]), unit = m[2].toLowerCase();
    var mins = /^(ghanta|ghante|ghnta|hour|hours|hr|hrs)$/.test(unit) ? n * 60 : n;
    return Math.max(1, Math.min(720, Math.round(mins)));
  }
  function reasonOf(t) {
    if (/nahan|naha|bath/i.test(t)) return 'nahane gaye hain';
    if (/so\s?(raha|rahi|rhi|rha|ne)|sone|soya/i.test(t)) return 'so rahe hain';
    if (/meeting/i.test(t)) return 'meeting me hain';
    if (/drive|gaadi|gadi|bike/i.test(t)) return 'gaadi chala rahe hain';
    if (/khana|khaana/i.test(t)) return 'khana kha rahe hain';
    if (/namaz|puja|pooja/i.test(t)) return 'puja me hain';
    if (/padhai|exam/i.test(t)) return 'padhai me hain';
    return 'abhi call nahi le sakte';
  }
  function ownerName() {
    var n = (typeof state !== 'undefined' && state.user && (state.user.displayName || '')) || '';
    n = String(n).trim().split(/\s+/)[0];
    return n ? n + ' sir' : 'sir';
  }

  var PKEY = 'aureon_away_prefs_v1';
  function loadPrefs() { try { var p = JSON.parse(localStorage.getItem(PKEY) || '{}'); return { minutes: Number(p.minutes) || 30, reason: String(p.reason || ''), notes: String(p.notes || '') }; } catch (e) { return { minutes: 30, reason: '', notes: '' }; } }
  function savePrefs(p) { try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) { /* storage full: ignore */ } }

  /** one place that switches away mode on (used by chat and by the dashboard) */
  async function startAway(o) {
    var P = plugin();
    if (!P || !P.awayStart) throw new Error('Away mode sirf Aureon APK (phone) me chalta hai, browser me nahi.');
    var reason = String(o.reason || '').trim() || 'abhi busy hain';
    var r = await post('/start', { minutes: o.minutes, reason: reason, ownerName: ownerName(), notes: o.notes || '' });
    await P.awayStart({ backendUrl: base(), token: r.token, until: r.until, reason: reason, ownerName: ownerName() });
    return r;
  }
  async function stopAway() {
    var P = plugin();
    if (P && P.awayStop) await P.awayStop();
    try { await post('/stop', {}); } catch (e) { /* server may be asleep: the key expires on its own */ }
  }

  async function turnOn(text) {
    var P = plugin();
    if (!P || !P.awayStart) { say('Away mode sirf Aureon APK (phone) me chalta hai, browser me nahi.'); return; }
    var prefs = loadPrefs(), minutes = parseMinutes(text), reason = reasonOf(text);
    if (reason === 'abhi call nahi le sakte' && prefs.reason) reason = prefs.reason;
    await startAway({ minutes: minutes, reason: reason, notes: prefs.notes });
    say('Theek hai, ' + minutes + ' minute ke liye away mode on. Is dauraan call aayegi to main utha lungi, caller ko bataungi ki main AI assistant hu aur baat record ho rahi hai, phir uski baat sunke jawab dungi' + (prefs.notes ? ' (aapke notes ke hisaab se)' : '') + ' aur sab yaad rakhke aapko batungi.\n\nBand karne ke liye "main aa gaya" likho. Notes aur settings ke liye Settings me "Away mode" kholo.');
  }

  async function report(auto) {
    var P = plugin(); if (!P || !P.awayStatus) { if (!auto) say('Ye sirf Aureon APK me dikhta hai.'); return false; }
    var st = await P.awayStatus(); var calls = (st && st.calls) || [];
    var fresh = calls.filter(function (c) { return !c.reported; });
    if (!fresh.length) { if (!auto) say(st && st.active ? 'Abhi tak koi call nahi aayi. Away mode chalu hai.' : 'Is dauraan koi call nahi aayi.'); return false; }
    var j = await post('/summary', { calls: fresh, reason: st.reason || '' });
    say('Aapke peeche ' + fresh.length + ' call aayi:\n\n' + (j.text || 'Summary nahi ban payi.'));
    await P.awayMarkReported();
    return true;
  }

  /** returns true when the message was an away-mode request and was handled here */
  async function chatIntent(text) {
    text = String(text || '').trim();
    if (!text || text.length > 400 || typeof state === 'undefined' || !state.user) return false;
    var isOff = OFF_RE.test(text);
    var isOn = !isOff && (EXPLICIT_ON.test(text) || (REASON_WORD.test(text) && TIME_RE.test(text) && /(ja\s?r|jaa\s?r|ja\s?raha|ja\s?rha|jaa\s?rha|hu\b|hoon|hun\b|rahunga|rahunga|lagega)/i.test(text)));
    var isRep = !isOff && !isOn && REPORT_RE.test(text);
    if (!isOff && !isOn && !isRep) return false;
    if (isOff) {   // "main aa gaya" is also normal chat: only treat it as OFF when away mode is on or calls are waiting
      var P0 = plugin(); if (!P0 || !P0.awayStatus) return false;
      var st0 = await P0.awayStatus();
      if (!(st0 && st0.active) && !((st0 && st0.calls) || []).some(function (c) { return !c.reported; })) return false;
    }
    busy(true);
    try {
      if (isOn) { await turnOn(text); }
      else if (isOff) {
        await stopAway();
        busy(false);
        var shown = await report(true);
        say(shown ? 'Away mode band kar diya.' : 'Away mode band kar diya. Is dauraan koi call nahi aayi.');
      } else { busy(false); await report(false); }
    } catch (e) {
      if (typeof addMessage === 'function') addMessage('error', 'Away mode: ' + String((e && e.message) || e));
    }
    busy(false);
    return true;
  }

  /* ---------------- dashboard (Settings -> Away mode) ---------------- */
  var ov = null, tick = 0;
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  var CARD = 'border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:12px;margin:10px 12px;background:rgba(255,255,255,.04)';
  var FIELD = 'width:100%;box-sizing:border-box;background:#0d0d1c;color:#eee;border:1px solid rgba(255,255,255,.2);border-radius:10px;padding:10px;font-size:15px;font-family:inherit';
  function button(label, fn, primary) {
    var b = el('button', 'border:1px solid rgba(255,255,255,.25);background:' + (primary ? 'linear-gradient(135deg,#6d5efc,#22b8e6)' : 'transparent') + ';color:#fff;border-radius:10px;padding:9px 14px;font-size:14px;min-height:38px;font-family:inherit', label);
    b.type = 'button'; b.addEventListener('click', function () { fn(b); }); return b;
  }
  function chips(list, onPick) {
    var w = el('div', 'margin-top:6px');
    list.forEach(function (t) { var c = el('span', 'display:inline-block;margin:4px 6px 0 0;padding:5px 10px;border:1px solid rgba(255,255,255,.22);border-radius:99px;font-size:12px;cursor:pointer', t); c.addEventListener('click', function () { onPick(t); }); w.appendChild(c); });
    return w;
  }
  function when(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }

  function openDashboard() {
    if (typeof state === 'undefined' || !state.user) { say('Pehle sign in karo.'); return; }
    if (ov) ov.remove();
    ov = el('div', 'position:fixed;inset:0;z-index:99990;background:var(--bg,#0b0b14);color:var(--text,#eee);display:flex;flex-direction:column;padding-top:var(--safe-top,0px);font-family:inherit');
    document.body.appendChild(ov); render();
  }
  function closeDashboard() { clearInterval(tick); if (ov) ov.remove(); ov = null; }

  async function render() {
    if (!ov) return; clearInterval(tick);
    var P = plugin(), st = { active: false, calls: [], until: 0 };
    try { if (P && P.awayStatus) st = await P.awayStatus(); } catch (e) { /* show as off */ }
    if (!ov) return;
    var prefs = loadPrefs(); ov.textContent = '';

    var bar = el('div', 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1)');
    bar.appendChild(button('Close', closeDashboard)); bar.appendChild(el('b', 'flex:1;font-size:16px', 'Away mode: auto call pickup')); ov.appendChild(bar);
    var body = el('div', 'flex:1;overflow:auto;padding-bottom:60px'); ov.appendChild(body);

    if (!P || !P.awayStart) { body.appendChild(el('div', CARD, 'Ye feature sirf Aureon APK (phone) me chalta hai.')); return; }

    // status
    var c1 = el('div', CARD), line = el('div', 'font-size:16px;font-weight:600');
    var sub = el('div', 'font-size:13px;opacity:.75;margin-top:4px;line-height:1.5');
    function paintStatus() {
      var left = Math.max(0, Math.round((st.until - Date.now()) / 60000));
      if (st.active && st.until > Date.now()) { line.textContent = 'Chalu hai (' + left + ' min baaki, ' + when(st.until) + ' tak)'; line.style.color = '#7ee2a8'; sub.textContent = 'Call aane par Ava utha legi, caller se baat karegi aur aapko baad me batayegi.'; }
      else { line.textContent = 'Band hai'; line.style.color = ''; sub.textContent = 'Neeche settings bharo aur "Shuru karo" dabao.'; }
    }
    paintStatus(); tick = setInterval(paintStatus, 20000);
    c1.appendChild(line); c1.appendChild(sub); body.appendChild(c1);

    // settings
    var c2 = el('div', CARD);
    c2.appendChild(el('div', 'font-size:13px;opacity:.8;margin-bottom:4px', 'Kitni der (minute)'));
    var mins = el('input', FIELD); mins.type = 'number'; mins.min = '1'; mins.max = '720'; mins.value = String(prefs.minutes); c2.appendChild(mins);
    c2.appendChild(chips(['15', '30', '60', '120'], function (t) { mins.value = t; }));
    c2.appendChild(el('div', 'font-size:13px;opacity:.8;margin:12px 0 4px', 'Ava caller ko kya bataye (aap abhi kya kar rahe ho)'));
    var reason = el('input', FIELD); reason.value = prefs.reason; reason.placeholder = 'jaise: nahane gaye hain'; c2.appendChild(reason);
    c2.appendChild(chips(['nahane gaye hain', 'meeting me hain', 'gaadi chala rahe hain', 'so rahe hain', 'abhi busy hain'], function (t) { reason.value = t; }));
    c2.appendChild(el('div', 'font-size:13px;opacity:.8;margin:12px 0 4px', 'Notes: Ava inhi se jawab degi'));
    var notes = el('textarea', FIELD + ';min-height:130px;resize:vertical'); notes.value = prefs.notes;
    notes.placeholder = 'Jaise:\nSir 7 baje tak free honge.\nDelivery wale parcel gate pe rakh dein.\nOffice ka kaam ho to email bhej dein.\nPaise ya OTP ki baat ho to sir khud call karenge.';
    c2.appendChild(notes);
    c2.appendChild(el('div', 'font-size:12px;opacity:.65;margin-top:6px;line-height:1.5', 'Caller kuch kaam ka pooche to Ava sirf in notes se jawab degi. Jo notes me nahi hai uska andaza nahi lagayegi, bolegi ki sir ko bata dungi. OTP, bank ya paise ki baat kabhi nahi manegi.'));
    var msg = el('div', 'font-size:13px;min-height:18px;margin-top:8px');
    function readForm() { var m = Math.max(1, Math.min(720, parseInt(mins.value, 10) || 30)); return { minutes: m, reason: reason.value.trim(), notes: notes.value.trim().slice(0, 3000) }; }
    var row = el('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px');
    row.appendChild(button('Settings save karo', function () { savePrefs(readForm()); msg.style.color = '#7ee2a8'; msg.textContent = 'Save ho gaya.'; }));
    if (st.active && st.until > Date.now()) {
      row.appendChild(button('Band karo', async function (b) { b.disabled = true; try { await stopAway(); } catch (e) { /* ignore */ } render(); }, true));
    } else {
      row.appendChild(button('Shuru karo', async function (b) {
        var f = readForm(); savePrefs(f); b.disabled = true; msg.style.color = ''; msg.textContent = 'Shuru ho raha hai...';
        try { await startAway(f); render(); } catch (e) { b.disabled = false; msg.style.color = '#ff8a8a'; msg.textContent = 'Error: ' + String((e && e.message) || e); }
      }, true));
    }
    c2.appendChild(row); c2.appendChild(msg); body.appendChild(c2);

    // calls
    var c3 = el('div', CARD), calls = (st.calls || []).slice().reverse();
    var head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px');
    head.appendChild(el('b', 'flex:1', 'Aayi hui calls (' + calls.length + ')'));
    var sumBox = el('div', 'font-size:14px;line-height:1.55;white-space:pre-wrap;margin-bottom:8px;display:none');
    if (calls.length) head.appendChild(button('Summary banao', async function (b) {
      b.disabled = true; sumBox.style.display = 'block'; sumBox.textContent = 'Ho raha hai...';
      try { var j = await post('/summary', { calls: calls.slice().reverse().slice(-20), reason: st.reason || '' }); sumBox.textContent = j.text || 'Summary nahi ban payi.'; if (P.awayMarkReported) await P.awayMarkReported(); }
      catch (e) { sumBox.textContent = 'Error: ' + String((e && e.message) || e); }
      b.disabled = false;
    }));
    c3.appendChild(head); c3.appendChild(sumBox);
    if (!calls.length) c3.appendChild(el('div', 'opacity:.7;font-size:13px', 'Abhi tak koi call nahi aayi.'));
    calls.forEach(function (c) {
      var item = el('div', 'border-top:1px solid rgba(255,255,255,.1);padding:8px 0');
      var who = c.name || c.number || 'Unknown number';
      var firstCaller = ''; (c.transcript || []).some(function (x) { if (x.who === 'caller') { firstCaller = x.text; return true; } return false; });
      var stText = { answered: 'Ava ne baat ki', missed: 'Miss ho gayi', noaudio: 'Awaaz capture nahi hui', silent: 'Caller chup raha', noanswerperm: 'Ava utha nahi payi (permission)' }[c.status] || c.status;
      item.appendChild(el('div', 'font-weight:600;font-size:14px', who + '  ·  ' + (c.atText || '')));
      item.appendChild(el('div', 'font-size:12px;opacity:.7;margin:2px 0', stText + (c.durationSec ? ' · ' + c.durationSec + ' sec' : '')));
      if (firstCaller) item.appendChild(el('div', 'font-size:13px;opacity:.9', '"' + firstCaller + '"'));
      var full = el('div', 'display:none;font-size:13px;line-height:1.5;margin-top:6px;padding:8px;border-radius:8px;background:rgba(255,255,255,.05);white-space:pre-wrap');
      full.textContent = (c.transcript || []).filter(function (x) { return x.who !== 'sys'; }).map(function (x) { return (x.who === 'ava' ? 'Ava: ' : 'Caller: ') + x.text; }).join('\n') || '(kuch record nahi hua)';
      var tg = el('div', 'font-size:12px;color:#8ab4ff;margin-top:4px;cursor:pointer', 'Poori baat dekho');
      tg.addEventListener('click', function () { var show = full.style.display === 'none'; full.style.display = show ? 'block' : 'none'; tg.textContent = show ? 'Chhupao' : 'Poori baat dekho'; });
      item.appendChild(tg); item.appendChild(full); c3.appendChild(item);
    });
    body.appendChild(c3);
  }

  function wire() { var b = document.getElementById('away-open-row'); if (b && !b._w) { b._w = 1; b.addEventListener('click', openDashboard); } }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();

  // when the app comes back to the front, hand over the calls that came in meanwhile
  var checking = false, lastCheck = 0;
  async function autoReport() {
    if (checking || Date.now() - lastCheck < 5000) return;
    if (typeof state === 'undefined' || !state.user || !plugin()) return;
    checking = true; lastCheck = Date.now();
    try { await report(true); } catch (e) { /* try again next time */ }
    checking = false;
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') setTimeout(autoReport, 1200); });
  setTimeout(autoReport, 6000);

  window.AureonAway = { chatIntent: chatIntent, report: report, open: openDashboard };
})();
