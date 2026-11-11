/* Aureon — Away mode (v41). Say it in chat: "nahane ja raha hu, 20 minute, call aaye to utha lena" and, for that time, Ava answers calls
   on this phone, talks to the caller, remembers it and reports to you when you are back. "main aa gaya" turns it off.
   The calls themselves are handled natively (AureonAwayMode.java); this file only switches it on/off and shows the report.
   Needs app.js globals: state, authHeaders(), addMessage(), saveChatSnapshot(). Works only inside the Android app. */
(function () {
  function plugin() { var C = window.Capacitor; return C && C.Plugins && C.Plugins.AureonActions; }
  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }
  function isEn() { try { return localStorage.getItem('aureon_ui_en') !== '0'; } catch (e) { return true; } }   // Settings > English interface
  function E(en, hi) { return isEn() ? en : hi; }
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

  var REASON_WORD = /(nahane|nahaane|naha|nahana|bath|so\s?(raha|rahi|rhi|rha|ne)|sone|soya|meeting|drive|gaadi|gadi|bike|khana|khaana|namaz|puja|pooja|padhai|exam|busy|kaam|shower|nap|sleeping|lunch|dinner|eating|prayer|study)/i;
  var EXPLICIT_ON = /(away mode|auto\s*call|call\s*pick|calls?\s*(utha|uthao|pick)|call\s*utha\s*lena|(answer|pick\s*up|take)\s+(my\s+)?calls?|auto\s*answer)/i;
  var TIME_RE = /(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|ghanta|ghante|ghnta|hour|hours|hr|hrs)\b/i;
  var OFF_RE = /(away\s*(mode)?\s*(off|band|stop)|auto\s*call\s*(off|band|stop)|main\s*aa\s*gaya|mai\s*aa\s*gaya|aa\s*gaya\s*hu|aa\s*gayi\s*hu|call\s*pick\s*(off|band)|away\s*band|i'?m\s*back|i\s*am\s*back|turn\s*off\s*away|stop\s*away)/i;
  var REPORT_RE = /(kisne\s*call|kiska\s*call|kiski\s*call|peeche\s*(kya|call)|away\s*report|calls?\s*ka\s*hisaab|kya\s*hua\s*mere\s*peeche|who\s*called|any\s*calls?|missed\s*calls?|call\s*report)/i;

  function parseMinutes(t) {
    if (/(aadha|adha|half)\s*(ghanta|ghante|hour)/i.test(t)) return 30;
    var m = TIME_RE.exec(t); if (!m) return 30;
    var n = parseFloat(m[1]), unit = m[2].toLowerCase();
    var mins = /^(ghanta|ghante|ghnta|hour|hours|hr|hrs)$/.test(unit) ? n * 60 : n;
    return Math.max(1, Math.min(720, Math.round(mins)));
  }
  function defReason() { return E('cannot take calls right now', 'abhi call nahi le sakte'); }
  function busyReason() { return E('is busy right now', 'abhi busy hain'); }
  function reasonOf(t) {
    if (/nahan|naha|bath|shower/i.test(t)) return E('is taking a bath', 'nahane gaye hain');
    if (/so\s?(raha|rahi|rhi|rha|ne)|sone|soya|sleep|nap/i.test(t)) return E('is sleeping', 'so rahe hain');
    if (/meeting/i.test(t)) return E('is in a meeting', 'meeting me hain');
    if (/drive|driving|gaadi|gadi|bike/i.test(t)) return E('is driving', 'gaadi chala rahe hain');
    if (/khana|khaana|lunch|dinner|eating|meal/i.test(t)) return E('is having a meal', 'khana kha rahe hain');
    if (/namaz|puja|pooja|prayer/i.test(t)) return E('is at prayer', 'puja me hain');
    if (/padhai|exam|study/i.test(t)) return E('is studying', 'padhai me hain');
    return defReason();
  }
  function ownerName() {
    var n = (typeof state !== 'undefined' && state.user && (state.user.displayName || '')) || '';
    n = String(n).trim().split(/\s+/)[0];
    return n ? n + ' sir' : 'sir';
  }

  var PKEY = 'aureon_away_prefs_v1';
  function loadPrefs() { try { var p = JSON.parse(localStorage.getItem(PKEY) || '{}'); return { minutes: Number(p.minutes) || 30, reason: String(p.reason || ''), notes: String(p.notes || ''), free: !!p.free }; } catch (e) { return { minutes: 30, reason: '', notes: '', free: false }; } }
  function savePrefs(p) { try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) { /* storage full: ignore */ } }

  /** one place that switches away mode on (used by chat and by the dashboard) */
  async function startAway(o) {
    var P = plugin();
    if (!P || !P.awayStart) throw new Error(E('Away mode works only in the Aureon APK (on the phone), not in a browser.', 'Away mode sirf Aureon APK (phone) me chalta hai, browser me nahi.'));
    var reason = String(o.reason || '').trim() || busyReason();
    var r = await post('/start', { minutes: o.minutes, reason: reason, ownerName: ownerName(), notes: o.notes || '', free: !!o.free, lang: isEn() ? 'en' : 'hi' });
    await P.awayStart({ backendUrl: base(), token: r.token, until: r.until, reason: reason, ownerName: ownerName(), lang: isEn() ? 'en' : 'hi' });
    return r;
  }
  async function stopAway() {
    var P = plugin();
    if (P && P.awayStop) await P.awayStop();
    try { await post('/stop', {}); } catch (e) { /* server may be asleep: the key expires on its own */ }
  }

  async function turnOn(text) {
    var P = plugin();
    if (!P || !P.awayStart) { say(E('Away mode works only in the Aureon APK (on the phone), not in a browser.', 'Away mode sirf Aureon APK (phone) me chalta hai, browser me nahi.')); return; }
    var prefs = loadPrefs(), minutes = parseMinutes(text), reason = reasonOf(text);
    if (reason === defReason() && prefs.reason) reason = prefs.reason;
    await startAway({ minutes: minutes, reason: reason, notes: prefs.notes, free: prefs.free });
    say(E('Okay, away mode is on for ' + minutes + ' minutes. If a call comes in I will pick it up, tell the caller that I am an AI assistant and that the call is being recorded, listen and reply' + (prefs.free ? ' (on my own as well)' : (prefs.notes ? ' (using your notes)' : '')) + ', remember everything and report back to you.\n\nTo turn it off, write "I am back". For notes and settings open Settings and then "Away mode".',
      'Theek hai, ' + minutes + ' minute ke liye away mode on. Is dauraan call aayegi to main utha lungi, caller ko bataungi ki main AI assistant hu aur baat record ho rahi hai, phir uski baat sunke jawab dungi' + (prefs.free ? ' (apni taraf se bhi)' : (prefs.notes ? ' (aapke notes ke hisaab se)' : '')) + ' aur sab yaad rakhke aapko batungi.\n\nBand karne ke liye "main aa gaya" likho. Notes aur settings ke liye Settings me "Away mode" kholo.'));
  }

  async function report(auto) {
    var P = plugin(); if (!P || !P.awayStatus) { if (!auto) say(E('This only works in the Aureon APK.', 'Ye sirf Aureon APK me dikhta hai.')); return false; }
    var st = await P.awayStatus(); var calls = (st && st.calls) || [];
    var fresh = calls.filter(function (c) { return !c.reported; });
    if (!fresh.length) { if (!auto) say(st && st.active ? E('No calls yet. Away mode is on.', 'Abhi tak koi call nahi aayi. Away mode chalu hai.') : E('No calls came in during this time.', 'Is dauraan koi call nahi aayi.')); return false; }
    var j = await post('/summary', { calls: fresh, reason: st.reason || '', lang: isEn() ? 'en' : 'hi' });
    say(E(fresh.length + (fresh.length === 1 ? ' call' : ' calls') + ' came in while you were away:\n\n', 'Aapke peeche ' + fresh.length + ' call aayi:\n\n') + (j.text || E('Could not build the summary.', 'Summary nahi ban payi.')));
    await P.awayMarkReported();
    return true;
  }

  /** returns true when the message was an away-mode request and was handled here */
  async function chatIntent(text) {
    text = String(text || '').trim();
    if (!text || text.length > 400 || typeof state === 'undefined' || !state.user) return false;
    var isOff = OFF_RE.test(text);
    var isOn = !isOff && (EXPLICIT_ON.test(text) || (REASON_WORD.test(text) && TIME_RE.test(text) && /(ja\s?r|jaa\s?r|ja\s?raha|ja\s?rha|jaa\s?rha|hu\b|hoon|hun\b|rahunga|lagega|going|gonna|i'?m|i\s*am|will\s*be)/i.test(text)));
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
        say(shown ? E('Away mode is off.', 'Away mode band kar diya.') : E('Away mode is off. No calls came in during this time.', 'Away mode band kar diya. Is dauraan koi call nahi aayi.'));
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
    if (typeof state === 'undefined' || !state.user) { say(E('Please sign in first.', 'Pehle sign in karo.')); return; }
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
    bar.appendChild(button(E('Close', 'Close'), closeDashboard)); bar.appendChild(el('b', 'flex:1;font-size:16px', E('Away mode: auto call pickup', 'Away mode: auto call pickup'))); ov.appendChild(bar);
    var body = el('div', 'flex:1;overflow:auto;padding-bottom:60px'); ov.appendChild(body);

    if (!P || !P.awayStart) { body.appendChild(el('div', CARD, E('This feature works only in the Aureon APK (on the phone).', 'Ye feature sirf Aureon APK (phone) me chalta hai.'))); return; }

    // status
    var c1 = el('div', CARD), line = el('div', 'font-size:16px;font-weight:600');
    var sub = el('div', 'font-size:13px;opacity:.75;margin-top:4px;line-height:1.5');
    function paintStatus() {
      var left = Math.max(0, Math.round((st.until - Date.now()) / 60000));
      if (st.active && st.until > Date.now()) { line.textContent = E('On (' + left + ' min left, until ' + when(st.until) + ')', 'Chalu hai (' + left + ' min baaki, ' + when(st.until) + ' tak)'); line.style.color = '#7ee2a8'; sub.textContent = E('When a call comes in Ava will pick up, talk to the caller and report to you later.', 'Call aane par Ava utha legi, caller se baat karegi aur aapko baad me batayegi.'); }
      else { line.textContent = E('Off', 'Band hai'); line.style.color = ''; sub.textContent = E('Fill in the settings below and press "Start".', 'Neeche settings bharo aur "Shuru karo" dabao.'); }
    }
    paintStatus(); tick = setInterval(paintStatus, 20000);
    c1.appendChild(line); c1.appendChild(sub); body.appendChild(c1);

    // settings
    var c2 = el('div', CARD);
    c2.appendChild(el('div', 'font-size:13px;opacity:.8;margin-bottom:4px', E('How long (minutes)', 'Kitni der (minute)')));
    var mins = el('input', FIELD); mins.type = 'number'; mins.min = '1'; mins.max = '720'; mins.value = String(prefs.minutes); c2.appendChild(mins);
    c2.appendChild(chips(['15', '30', '60', '120'], function (t) { mins.value = t; }));
    c2.appendChild(el('div', 'font-size:13px;opacity:.8;margin:12px 0 4px', E('What should Ava tell the caller (what you are doing now)', 'Ava caller ko kya bataye (aap abhi kya kar rahe ho)')));
    var reason = el('input', FIELD); reason.value = prefs.reason; reason.placeholder = E('for example: is taking a bath', 'jaise: nahane gaye hain'); c2.appendChild(reason);
    c2.appendChild(chips(isEn() ? ['is taking a bath', 'is in a meeting', 'is driving', 'is sleeping', 'is busy right now'] : ['nahane gaye hain', 'meeting me hain', 'gaadi chala rahe hain', 'so rahe hain', 'abhi busy hain'], function (t) { reason.value = t; }));
    c2.appendChild(el('div', 'font-size:13px;opacity:.8;margin:12px 0 4px', E('Notes: Ava answers from these', 'Notes: Ava inhi se jawab degi')));
    var notes = el('textarea', FIELD + ';min-height:130px;resize:vertical'); notes.value = prefs.notes;
    notes.placeholder = E('For example:\nSir will be free after 7 pm.\nDelivery people can leave the parcel at the gate.\nFor office work please send an email.\nFor anything about money or OTP, sir will call back himself.', 'Jaise:\nSir 7 baje tak free honge.\nDelivery wale parcel gate pe rakh dein.\nOffice ka kaam ho to email bhej dein.\nPaise ya OTP ki baat ho to sir khud call karenge.');
    c2.appendChild(notes);
    c2.appendChild(el('div', 'font-size:12px;opacity:.65;margin-top:6px;line-height:1.5', E('Ava tells callers only what is written in the notes. For anything about you that is not in the notes she will not guess, she will say she will pass it on. She never agrees to OTP, bank or money requests.', 'Notes me jo likha hai Ava wahi caller ko batayegi. Aapke baare me jo notes me nahi hai uska andaza nahi lagayegi, bolegi ki sir ko bata dungi. OTP, bank ya paise ki baat kabhi nahi manegi.')));
    var freeRow = el('label', 'display:flex;gap:10px;align-items:flex-start;margin-top:12px;font-size:14px;line-height:1.45;cursor:pointer');
    var free = el('input', 'margin-top:3px;width:20px;height:20px;flex:none'); free.type = 'checkbox'; free.checked = !!prefs.free;
    freeRow.appendChild(free); freeRow.appendChild(el('span', null, E('Let Ava also answer on her own (questions outside the notes, like general questions or small talk). If this is off she answers only from the notes.', 'Ava apni taraf se bhi jawab de (notes ke bahar ke sawal par bhi, jaise general sawal ya baat-cheet). Band rakhoge to sirf notes se jawab degi.')));
    c2.appendChild(freeRow);
    var msg = el('div', 'font-size:13px;min-height:18px;margin-top:8px');
    function readForm() { var m = Math.max(1, Math.min(720, parseInt(mins.value, 10) || 30)); return { minutes: m, reason: reason.value.trim(), notes: notes.value.trim().slice(0, 3000), free: !!free.checked }; }
    var row = el('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px');
    row.appendChild(button(E('Save settings', 'Settings save karo'), function () { savePrefs(readForm()); msg.style.color = '#7ee2a8'; msg.textContent = E('Saved.', 'Save ho gaya.'); }));
    if (st.active && st.until > Date.now()) {
      row.appendChild(button(E('Turn off', 'Band karo'), async function (b) { b.disabled = true; try { await stopAway(); } catch (e) { /* ignore */ } render(); }, true));
    } else {
      row.appendChild(button(E('Start', 'Shuru karo'), async function (b) {
        var f = readForm(); savePrefs(f); b.disabled = true; msg.style.color = ''; msg.textContent = E('Starting...', 'Shuru ho raha hai...');
        try { await startAway(f); render(); } catch (e) { b.disabled = false; msg.style.color = '#ff8a8a'; msg.textContent = 'Error: ' + String((e && e.message) || e); }
      }, true));
    }
    c2.appendChild(row); c2.appendChild(msg); body.appendChild(c2);

    // calls
    var c3 = el('div', CARD), calls = (st.calls || []).slice().reverse();
    var head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px');
    head.appendChild(el('b', 'flex:1', E('Calls received (' + calls.length + ')', 'Aayi hui calls (' + calls.length + ')')));
    var sumBox = el('div', 'font-size:14px;line-height:1.55;white-space:pre-wrap;margin-bottom:8px;display:none');
    if (calls.length) head.appendChild(button(E('Make summary', 'Summary banao'), async function (b) {
      b.disabled = true; sumBox.style.display = 'block'; sumBox.textContent = E('Working...', 'Ho raha hai...');
      try { var j = await post('/summary', { calls: calls.slice().reverse().slice(-20), reason: st.reason || '', lang: isEn() ? 'en' : 'hi' }); sumBox.textContent = j.text || E('Could not build the summary.', 'Summary nahi ban payi.'); if (P.awayMarkReported) await P.awayMarkReported(); }
      catch (e) { sumBox.textContent = 'Error: ' + String((e && e.message) || e); }
      b.disabled = false;
    }));
    c3.appendChild(head); c3.appendChild(sumBox);
    if (!calls.length) c3.appendChild(el('div', 'opacity:.7;font-size:13px', E('No calls yet.', 'Abhi tak koi call nahi aayi.')));
    calls.forEach(function (c) {
      var item = el('div', 'border-top:1px solid rgba(255,255,255,.1);padding:8px 0');
      var who = c.name || c.number || 'Unknown number';
      var firstCaller = ''; (c.transcript || []).some(function (x) { if (x.who === 'caller') { firstCaller = x.text; return true; } return false; });
      var stText = (isEn() ? { answered: 'Ava talked to the caller', missed: 'Missed', noaudio: 'Caller voice was not captured', silent: 'Caller stayed silent', noanswerperm: 'Ava could not answer (permission)' } : { answered: 'Ava ne baat ki', missed: 'Miss ho gayi', noaudio: 'Awaaz capture nahi hui', silent: 'Caller chup raha', noanswerperm: 'Ava utha nahi payi (permission)' })[c.status] || c.status;
      item.appendChild(el('div', 'font-weight:600;font-size:14px', who + '  ·  ' + (c.atText || '')));
      item.appendChild(el('div', 'font-size:12px;opacity:.7;margin:2px 0', stText + (c.durationSec ? ' · ' + c.durationSec + ' sec' : '')));
      if (firstCaller) item.appendChild(el('div', 'font-size:13px;opacity:.9', '"' + firstCaller + '"'));
      var full = el('div', 'display:none;font-size:13px;line-height:1.5;margin-top:6px;padding:8px;border-radius:8px;background:rgba(255,255,255,.05);white-space:pre-wrap');
      full.textContent = (c.transcript || []).filter(function (x) { return x.who !== 'sys'; }).map(function (x) { return (x.who === 'ava' ? 'Ava: ' : 'Caller: ') + x.text; }).join('\n') || E('(nothing was recorded)', '(kuch record nahi hua)');
      if (c.diag) full.textContent += '\n\nDebug: ' + c.diag;
      var tg = el('div', 'font-size:12px;color:#8ab4ff;margin-top:4px;cursor:pointer', E('See the full conversation', 'Poori baat dekho'));
      tg.addEventListener('click', function () { var show = full.style.display === 'none'; full.style.display = show ? 'block' : 'none'; tg.textContent = show ? E('Hide', 'Chhupao') : E('See the full conversation', 'Poori baat dekho'); });
      item.appendChild(tg); item.appendChild(full); c3.appendChild(item);
    });
    body.appendChild(c3);

    // Caller voice check: shows why Ava may stay silent when the phone rings (voice engine, volume, Do Not Disturb, number, contact)
    if (P.callTest && P.callDiag) {
      var c4 = el('div', CARD), yn = function (v) { return v ? E('yes', 'haan') : E('no', 'nahi'); };
      c4.appendChild(el('div', 'font-weight:600;margin-bottom:4px', E('Caller voice check', 'Caller voice check')));
      c4.appendChild(el('div', 'font-size:13px;opacity:.75;line-height:1.5;margin-bottom:8px', E('Ava says who is calling when your phone rings. If she stays silent, press the test button and read the result.', 'Phone ring hone par Ava bolti hai kaun call kar raha hai. Wo chup rahe to test button dabao aur result padho.')));
      var out = el('div', 'font-size:13px;line-height:1.6;white-space:pre-wrap;margin-top:8px');
      function describe(d, title) {
        var lines = [title];
        var rm = [E('silent', 'silent'), E('vibrate', 'vibrate'), E('normal', 'normal')][d.ringerMode] || '?';
        if (d.test) lines.push(E('Voice started: ', 'Voice shuru hui: ') + yn(d.spoke));
        else { lines.push(E('Number received: ', 'Number mila: ') + yn(d.numberSeen) + '  |  ' + E('Contact found: ', 'Contact mila: ') + yn(d.nameFound) + '  |  ' + E('Voice started: ', 'Voice shuru hui: ') + yn(d.spoke)); }
        lines.push(E('Media volume: ', 'Media volume: ') + d.mediaVol + '/' + d.mediaMax + '  |  ' + E('Ringer: ', 'Ringer: ') + rm + '  |  ' + E('Do Not Disturb: ', 'Do Not Disturb: ') + (d.dnd ? E('on', 'on') : E('off', 'off')) + '  |  ' + E('Voice engine ready: ', 'Voice engine ready: ') + yn(d.ttsReady));
        if (d.note) lines.push(E('Note: ', 'Note: ') + d.note);
        if (d.test) lines.push(d.spoke ? E('The voice started. If you heard nothing: raise the media volume and turn off Do Not Disturb.', 'Voice shuru hui. Sunayi na de to media volume badhao aur Do Not Disturb band karo.')
          : E('The phone voice engine did not start. In phone Settings search "Text-to-speech", choose Google as the engine and install the voice data for your language.', 'Phone ka voice engine shuru nahi hua. Phone Settings me "Text-to-speech" search karo, Google engine chuno aur apni language ka voice data install karo.'));
        else if (d.at) {
          if (!d.numberSeen) lines.push(E('The phone did not give Aureon the caller number. Allow the Phone and Call logs permissions, and set battery to "Unrestricted" for Aureon.', 'Phone ne Aureon ko caller ka number nahi diya. Phone aur Call logs permission allow karo, aur Aureon ki battery "Unrestricted" karo.'));
          else if (!d.nameFound) lines.push(E('The number came but no matching contact was found. Check the Contacts permission and that this number is saved in Contacts.', 'Number aaya par contact nahi mila. Contacts permission check karo aur ye number Contacts me saved ho.'));
          else if (!d.spoke) lines.push(E('Number and contact were found but the voice did not start. Press the test button above to check the voice engine.', 'Number aur contact mile par voice shuru nahi hui. Upar test button dabake voice engine check karo.'));
        }
        return lines.join('\n');
      }
      var row4 = el('div', 'display:flex;gap:8px;flex-wrap:wrap');
      row4.appendChild(button(E('Test caller voice', 'Test caller voice'), async function (b) {
        b.disabled = true; out.textContent = E('Speaking a test line...', 'Test line bol rahi hu...');
        try { out.textContent = describe(await P.callTest(), E('Test result', 'Test result')); } catch (e) { out.textContent = 'Error: ' + String((e && e.message) || e); }
        b.disabled = false;
      }, true));
      row4.appendChild(button(E('Show last real call', 'Last asli call dikhao'), async function () {
        try { var d = await P.callDiag(); out.textContent = d.at && !d.test ? describe(d, E('Last real call: ', 'Last asli call: ') + new Date(d.at).toLocaleString()) : E('No real call has been recorded yet. Call this phone once and press this again.', 'Abhi koi asli call record nahi hui. Is phone par ek call karo aur ye dobara dabao.'); } catch (e) { out.textContent = 'Error: ' + String((e && e.message) || e); }
      }));
      c4.appendChild(row4); c4.appendChild(out); body.appendChild(c4);
    }
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
