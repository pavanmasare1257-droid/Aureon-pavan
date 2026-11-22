/* Aureon — Apps & Automation settings pane (connect any MCP / REST / webhook app, then automate it).
   Needs app.js globals: state (backendUrl, user), authHeaders(). All server data is rendered with textContent (no HTML injection). */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var S = { apps: [], autos: [] };
  var PRESETS = [
    { label: 'Custom (khud bharo)', kind: 'rest', auth: 'bearer' },
    { label: 'MCP server (koi bhi remote MCP)', kind: 'mcp', auth: 'bearer', ph: 'https://mcp.example.com/mcp' },
    { label: 'GitHub API', kind: 'rest', name: 'GitHub', url: 'https://api.github.com', auth: 'bearer' },
    { label: 'Notion API', kind: 'rest', name: 'Notion', url: 'https://api.notion.com/v1', auth: 'bearer', extra: '{"Notion-Version":"2022-06-28"}' },
    { label: 'Slack / Discord / Zapier / Make / n8n webhook', kind: 'webhook', name: 'Webhook', auth: 'none', ph: 'https://hooks.slack.com/services/...' }
  ];
  var preset = PRESETS[0];

  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }
  async function api(path, method, body) {
    var h = await authHeaders();
    var res = await fetch(base() + '/api/connect' + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok && !j.error) j.error = 'Server error (' + res.status + ')';
    return j;
  }
  function say(id, t, bad) { var e = $(id); if (!e) return; e.textContent = t || ''; e.style.color = bad ? 'var(--danger, #ff6b6b)' : ''; }
  function needLogin() { return typeof state === 'undefined' || !state.user; }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  function btn(label, fn, css) { var b = el('button', 'background:none;border:1px solid rgba(255,255,255,.18);color:inherit;border-radius:10px;padding:6px 10px;font-size:12px;' + (css || ''), label); b.addEventListener('click', fn); return b; }
  function agoTxt(t) { if (!t) return ''; var m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'abhi' : m < 60 ? m + ' min pehle' : m < 1440 ? Math.round(m / 60) + ' ghante pehle' : Math.round(m / 1440) + ' din pehle'; }
  var KIND = { mcp: 'MCP', rest: 'REST', webhook: 'Webhook' };

  function renderApps() {
    var box = $('ap-list'); box.textContent = '';
    $('ap-count').textContent = S.apps.length ? '(' + S.apps.length + ')' : '';
    if (!S.apps.length) box.appendChild(el('div', 'font-size:12px;opacity:.65;padding:6px 0', 'Abhi koi app nahi jodi.'));
    S.apps.forEach(function (a) {
      var row = el('div', 'display:flex;gap:8px;align-items:center;padding:9px 0;border-top:1px solid rgba(255,255,255,.1)');
      var t = el('div', 'flex:1;min-width:0');
      t.appendChild(el('div', 'font-weight:600;font-size:14px', a.name + '  ·  ' + (KIND[a.kind] || a.kind)));
      t.appendChild(el('div', 'font-size:11px;opacity:.55;overflow-wrap:anywhere', a.host + (a.hint ? '  ' + a.hint : '')));
      row.appendChild(t);
      row.appendChild(btn('Test', async function () {
        say('ap-msg', a.name + ' test ho raha hai…');
        var j = await api('/apps/' + encodeURIComponent(a.id) + '/test', 'POST');
        say('ap-msg', j.ok ? a.name + ': chal raha hai' + (j.info && j.info.tools != null ? ' (' + j.info.tools + ' tools)' : '') : a.name + ': ' + j.error, !j.ok);
      }));
      row.appendChild(btn('Hatao', async function () {
        var j = await api('/apps/' + encodeURIComponent(a.id), 'DELETE');
        if (j.ok) loadAll(); else say('ap-msg', j.error, true);
      }, 'padding:6px 9px'));
      box.appendChild(row);
    });
    var ap = $('au-apps'); ap.textContent = '';
    if (!S.apps.length) ap.appendChild(el('div', 'font-size:12px;opacity:.65', 'Pehle upar koi app jodo.'));
    S.apps.forEach(function (a) {
      var l = el('label', 'display:flex;gap:10px;align-items:center;font-size:13px;margin:6px 0');
      var c = document.createElement('input'); c.type = 'checkbox'; c.value = a.id; c.className = 'au-app-cb';
      l.appendChild(c); l.appendChild(document.createTextNode(a.name + ' (' + (KIND[a.kind] || a.kind) + ')')); ap.appendChild(l);
    });
  }
  function trigTxt(t) { return t.type === 'interval' ? 'har ' + t.everyMin + ' min' : t.type === 'webhook' ? 'webhook' : 'manual'; }
  function renderAutos() {
    var box = $('au-list'); box.textContent = '';
    $('au-count').textContent = S.autos.length ? '(' + S.autos.length + ')' : '';
    if (!S.autos.length) box.appendChild(el('div', 'font-size:12px;opacity:.65;padding:6px 0', 'Abhi koi automation nahi.'));
    var names = {}; S.apps.forEach(function (a) { names[a.id] = a.name; });
    S.autos.forEach(function (a) {
      var card = el('div', 'padding:10px 0;border-top:1px solid rgba(255,255,255,.1)');
      card.appendChild(el('div', 'font-weight:600;font-size:14px', (a.enabled ? 'Chalu · ' : 'Band · ') + a.name));
      card.appendChild(el('div', 'font-size:12px;opacity:.75;margin-top:2px;overflow-wrap:anywhere', a.instruction));
      card.appendChild(el('div', 'font-size:11px;opacity:.55;margin-top:3px', trigTxt(a.trigger) + ' · ' + (a.appIds || []).map(function (i) { return names[i] || '?'; }).join(', ') + (a.allowWrite ? ' · changes allowed' : ' · read-only')));
      if (a.lastRun) {
        var lr = el('div', 'font-size:12px;margin-top:6px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.06);overflow-wrap:anywhere', (a.lastRun.ok ? 'OK · ' : 'Fail · ') + a.lastRun.text);
        card.appendChild(lr);
        card.appendChild(el('div', 'font-size:10.5px;opacity:.5;margin-top:2px', agoTxt(a.lastRun.at) + ' · ' + (a.lastRun.steps || []).length + ' tool calls'));
      }
      var bar = el('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px');
      bar.appendChild(btn('▶ Chalao', async function (ev) {
        var b = ev.currentTarget; b.disabled = true; b.textContent = 'Chal rahi hai…';
        var j = await api('/automations/' + encodeURIComponent(a.id) + '/run', 'POST');
        if (!j.ok) say('au-msg', j.error, true); loadAll();
      }));
      bar.appendChild(btn(a.enabled ? 'Band karo' : 'Chalu karo', async function () { await api('/automations/' + encodeURIComponent(a.id), 'PATCH', { enabled: !a.enabled }); loadAll(); }));
      if (a.trigger.type === 'webhook') bar.appendChild(btn('Naya link', async function () {
        var j = await api('/automations/' + encodeURIComponent(a.id) + '/hook-reset', 'POST');
        say('au-msg', j.ok ? UL('Webhook link (shown only now, copy it):\n', 'Webhook link (sirf abhi dikhega, copy kar lo):\n') + j.hookUrl : j.error, !j.ok);
      }));
      bar.appendChild(btn('Delete', async function () { var j = await api('/automations/' + encodeURIComponent(a.id), 'DELETE'); if (j.ok) loadAll(); else say('au-msg', j.error, true); }));
      card.appendChild(bar); box.appendChild(card);
    });
  }
  async function loadAll() {
    if (needLogin()) { say('ap-msg', 'Pehle sign in karo.', true); return; }
    var a = await api('/apps'), u = await api('/automations');
    if (!a.ok) { say('ap-msg', a.error, true); return; }
    S.apps = a.apps || []; S.autos = u.ok ? (u.automations || []) : [];
    if (a.canStore === false) say('ap-msg', 'Server par SENTINEL_ENC_KEY set nahi hai — token save nahi ho payega.', true);
    var sub = $('sub-connect'); if (sub) sub.textContent = S.apps.length ? S.apps.length + ' apps · ' + S.autos.length + ' automations' : 'Koi bhi app jodo, kaam automate karo';
    renderApps(); renderAutos();
  }

  function applyPreset() {
    var p = preset;
    $('ap-name').value = p.name || ''; $('ap-url').value = p.url || ''; $('ap-url').placeholder = p.ph || 'https://...';
    $('ap-auth').value = p.auth || 'bearer'; $('ap-extra').value = p.extra || ''; $('ap-token').value = '';
    syncAuth();
  }
  function syncAuth() {
    var v = $('ap-auth').value;
    $('ap-hname').classList.toggle('hidden', v !== 'header');
    $('ap-token').classList.toggle('hidden', v === 'none');
    $('ap-token').placeholder = v === 'basic' ? 'user:password' : 'Token / API key';
  }
  async function saveApp() {
    if (needLogin()) return say('ap-msg', 'Pehle sign in karo.', true);
    var extra = null, ex = $('ap-extra').value.trim();
    if (ex) { try { extra = JSON.parse(ex); } catch (e) { return say('ap-msg', UL('Write the extra headers as valid JSON.', 'Extra headers sahi JSON me likho.'), true); } }
    say('ap-msg', 'Connect ho raha hai…');
    var j = await api('/apps', 'POST', { name: $('ap-name').value, kind: preset.kind, url: $('ap-url').value, authType: $('ap-auth').value, headerName: $('ap-hname').value, token: $('ap-token').value, headers: extra });
    if (j.ok) {
      $('ap-token').value = ''; $('ap-form').classList.add('hidden');
      say('ap-msg', 'Jud gaya' + (j.info && j.info.tools != null ? ' (' + j.info.tools + ' tools mile)' : '')); loadAll();
    } else say('ap-msg', j.error, true);
  }
  async function saveAuto() {
    if (needLogin()) return say('au-msg', 'Pehle sign in karo.', true);
    var ids = Array.prototype.map.call(document.querySelectorAll('.au-app-cb:checked'), function (c) { return c.value; });
    var type = $('au-trig').value;
    say('au-msg', 'Ban rahi hai…');
    var j = await api('/automations', 'POST', { name: $('au-name').value, instruction: $('au-text').value, appIds: ids, allowWrite: $('au-write').checked, trigger: { type: type, everyMin: Number($('au-every').value) } });
    if (j.ok) {
      $('au-name').value = ''; $('au-text').value = ''; $('au-form').classList.add('hidden');
      say('au-msg', j.hookUrl ? UL('Created. Webhook link (shown only now, copy it):\n', 'Ban gayi. Webhook link (sirf abhi dikhega, copy kar lo):\n') + j.hookUrl : UL('Created', 'Ban gayi')); loadAll();
    } else say('au-msg', j.error, true);
  }


  /* ============================ Gmail (read-only) ============================ */
  var GM = { st: null, busy: false };
  async function gapi(path, method, body) {
    var h = await authHeaders();
    var res = await fetch(base() + '/api/gmail' + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok && !j.error) j.error = 'Server error (' + res.status + ')';
    return j;
  }
  function openExternal(url) {
    var A = plugin();
    if (A && A.openUrl) { A.openUrl({ url: url }).catch(function () { window.open(url, '_blank'); }); } else window.open(url, '_blank');
  }
  var URG = { high: '🔴', medium: '🟡', low: '⚪' };
  function field(tag, ph, css) { var e = document.createElement(tag); if (tag === 'input') e.type = 'text'; e.placeholder = ph || ''; e.autocomplete = 'off'; e.className = 'text-input'; e.style.cssText = 'width:100%;margin:6px 0;' + (css || ''); return e; }
  async function makeDraft(args, msgId) {
    say(msgId, 'Draft ban raha hai…');
    var j = await gapi('/draft', 'POST', args);
    if (!j.ok) { say(msgId, j.error, true); return false; }
    say(msgId, 'Draft taiyaar. Neeche dekho, edit karo, phir "Bhejo" dabao. Tab tak kuch nahi bhejta.');
    loadDrafts(); return true;
  }
  function replyBox(row, m) {
    if (row.querySelector('[data-rb]')) return;
    var box = el('div', 'margin-top:6px'); box.setAttribute('data-rb', '1');
    var inp = field('input', 'Kya likhna hai? (jaise: haan kal tak bhej dunga)');
    var go = btn('Draft banao', async function () {
      if (!inp.value.trim()) return;
      go.disabled = true; var ok = await makeDraft({ instruction: inp.value, replyToId: m.id }, 'gm-msg'); go.disabled = false; if (ok) box.remove();
    });
    box.appendChild(inp); box.appendChild(go); row.appendChild(box); inp.focus();
  }
  function composeBox() {
    var box = el('div', 'margin:8px 0;padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:12px');
    var to = field('input', 'Kisko? (email address)'); to.type = 'email';
    var subj = field('input', 'Subject (optional)');
    var ins = field('textarea', 'Kya likhna hai? (jaise: kal ki meeting 4 baje confirm karo)', 'min-height:70px'); 
    var go = btn('Draft banao', async function () {
      if (!to.value.trim() || !ins.value.trim()) return say('gm-msg', 'Address aur kya likhna hai, dono do.', true);
      go.disabled = true; var ok = await makeDraft({ to: to.value, subject: subj.value, instruction: ins.value }, 'gm-msg'); go.disabled = false; if (ok) box.remove();
    });
    box.appendChild(to); box.appendChild(subj); box.appendChild(ins); box.appendChild(go); return box;
  }
  async function loadDrafts() {
    var host = $('gm-drafts'); if (!host) return;
    var j = await gapi('/drafts'); host.textContent = '';
    if (!j.ok || !(j.drafts || []).length) return;
    host.appendChild(el('div', 'font-size:12px;font-weight:700;margin:10px 0 4px;color:#ffcc66', (j.drafts.length) + ' draft tumhare approve ka intezaar kar raha hai'));
    j.drafts.forEach(function (d) {
      var c = el('div', 'margin:8px 0;padding:10px;border:1px solid rgba(255,204,102,.35);border-radius:12px');
      c.appendChild(el('div', 'font-size:12px;opacity:.8;overflow-wrap:anywhere', 'To: ' + d.to + (d.reply ? ' (reply)' : '') + (d.source === 'claude' ? ' · Claude ne banaya' : '')));
      var sub = field('input', 'Subject'); sub.value = d.subject;
      var body = field('textarea', 'Mail', 'min-height:120px'); body.value = d.body;
      var bar = el('div', 'display:flex;gap:8px;margin-top:4px'); var armed = false, timer = null;
      var send = btn('Bhejo ✓', async function () {
        if (!armed) { armed = true; send.textContent = 'Pakka bhejo? (dobara tap)'; timer = setTimeout(function () { armed = false; send.textContent = 'Bhejo ✓'; }, 6000); return; }
        clearTimeout(timer); send.disabled = true; send.textContent = 'Bhej raha hoon…';
        var r = await gapi('/send', 'POST', { id: d.id, confirm: true, subject: sub.value, body: body.value });
        if (r.ok) { say('gm-msg', 'Mail bhej di ✓ (' + d.to + ')'); loadDrafts(); } else { say('gm-msg', r.error, true); send.disabled = false; send.textContent = 'Bhejo ✓'; armed = false; }
      }, 'flex:1;padding:10px;border-color:#6fdc8c');
      var rej = btn('Reject', async function () { await gapi('/draft/reject', 'POST', { id: d.id }); loadDrafts(); });
      bar.appendChild(send); bar.appendChild(rej);
      c.appendChild(sub); c.appendChild(body); c.appendChild(bar); host.appendChild(c);
    });
  }

  function renderMails(box, d) {
    box.textContent = '';
    if (d.summary) box.appendChild(el('div', 'font-size:13px;margin:6px 0 4px', d.summary));
    (d.items || []).forEach(function (m) {
      var row = el('div', 'padding:8px 0;border-top:1px solid rgba(255,255,255,.1)');
      row.appendChild(el('div', 'font-size:13.5px;font-weight:600;overflow-wrap:anywhere', (URG[m.urgency] || '🟡') + ' ' + m.subject));
      row.appendChild(el('div', 'font-size:12px;opacity:.7;overflow-wrap:anywhere', m.from + (m.unread ? ' · unread' : '')));
      if (m.why) row.appendChild(el('div', 'font-size:12px;margin-top:2px;opacity:.9', m.why));
      if (GM.st && GM.st.canSend) row.appendChild(btn('Reply draft', function () { replyBox(row, m); }, 'margin-top:6px'));
      box.appendChild(row);
    });
    if (!(d.items || []).length) box.appendChild(el('div', 'font-size:12px;opacity:.65;padding:4px 0', 'Koi zaroori mail nahi mila.'));
  }

  /* ---------- urgent-mail watcher: the phone checks every ~20 min and notifies ONLY for urgent new mails ---------- */
  function watchBox() {
    var box = el('div', 'margin-top:10px;padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:12px');
    box.appendChild(el('div', 'font-size:13px;font-weight:700;margin-bottom:2px', 'Urgent mail par notification'));
    box.appendChild(el('div', 'font-size:12px;opacity:.75;line-height:1.5;margin-bottom:6px', 'Ava har ~20 min naye mails dekhti hai aur sirf zaroori par (offer letter, interview, bill/payment alert, official notice) notification deti hai. Sirf padhti hai, kuch bhejti nahi. Realme/ColorOS me Aureon ko Auto-start aur Battery "Unrestricted" do, warna phone alarm rok deta hai.'));
    var line = el('div', 'font-size:12px;margin:4px 0;opacity:.85', 'Check ho raha hai…');
    var A = plugin(), on = false;
    function paint(st) {
      on = !!(st && st.enabled); var last = {}; try { last = JSON.parse((st && st.last) || '{}'); } catch (e) { /* none */ }
      line.textContent = on ? 'CHALU' + (last.at ? ' · last check ' + new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (last.error ? ' (' + last.error + ')' : last.notified ? ' · ' + last.notified + ' notification' : '') : ' · pehla check ~1 min me') : 'Band hai';
      tog.textContent = on ? 'Band karo' : 'Chalu karo';
    }
    var tog = btn('…', async function () {
      if (!A || !A.mailWatchSet) return say('gm-msg', 'Ye sirf Android app me chalta hai.', true);
      tog.disabled = true;
      try {
        if (!on) {
          var j = await gapi('/watch/key', 'POST', {});
          if (!j.ok) { say('gm-msg', j.error, true); return; }
          await A.mailWatchSet({ enabled: true, backendUrl: base(), key: j.key });
          say('gm-msg', 'Chalu ho gaya. Purane unread mails par notification nahi aayegi, sirf naye zaroori mails par.');
        } else {
          await A.mailWatchSet({ enabled: false });
          await gapi('/watch/off', 'POST', {});
          say('gm-msg', 'Band kar diya.');
        }
        paint(await A.mailWatchStatus());
      } catch (e) { say('gm-msg', 'Nahi hua: ' + ((e && e.message) || e), true); }
      tog.disabled = false;
    }, 'padding:9px 12px');
    box.appendChild(line); box.appendChild(tog);
    if (A && A.mailWatchStatus) A.mailWatchStatus().then(paint).catch(function () { line.textContent = 'Status nahi mila'; });
    else line.textContent = 'Sirf Android app me.';
    return box;
  }

  async function renderGmail() {
    var box = $('gm-box'); if (!box) return;
    box.textContent = '';
    var st = GM.st;
    if (!st) { box.appendChild(el('div', 'font-size:12px;opacity:.65', 'Check ho raha hai…')); return; }
    if (!st.ok) { box.appendChild(el('div', 'font-size:12px;color:var(--danger,#ff6b6b)', st.error || 'Gmail status nahi mila')); return; }
    $('gm-state').textContent = st.connected ? '(jura hai)' : '';
    if (!st.configured) {
      box.appendChild(el('div', 'font-size:12px;opacity:.75;line-height:1.5', 'Server par Google setup baaki hai (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). GMAIL-SETUP.md ke steps karo, phir yahan "Gmail jodo" chalega.'));
      return;
    }
    var out = el('div', ''); var msg = el('div', 'font-size:12px;margin:6px 0;opacity:.8;overflow-wrap:anywhere', '');
    if (!st.connected) {
      box.appendChild(el('div', 'font-size:12px;opacity:.75;line-height:1.5;margin-bottom:6px', 'Sirf padhne ki permission (read-only). Aureon mail bhej, delete ya badal nahi sakta.'));
      var b = btn('Gmail jodo', async function () {
        if (needLogin()) return say('gm-msg', 'Pehle sign in karo.', true);
        var j = await gapi('/auth-url', 'POST', {});
        if (!j.ok) return say('gm-msg', j.error, true);
        say('gm-msg', 'Browser khulega — Google me allow karo, phir yahan wapas aao.');
        openExternal(j.url);
      }, 'width:100%;padding:11px'); box.appendChild(b);
    } else {
      box.appendChild(el('div', 'font-size:12px;opacity:.7;margin-bottom:6px;overflow-wrap:anywhere', st.email || ''));
      var bar = el('div', 'display:flex;gap:8px');
      var go = btn('Important mails batao', async function (ev) {
        var t = ev.currentTarget; t.disabled = true; t.textContent = 'Padh raha hoon…';
        var j = await gapi('/important', 'POST', { force: true });
        t.disabled = false; t.textContent = 'Important mails batao';
        if (!j.ok) return say('gm-msg', j.error, true);
        say('gm-msg', ''); renderMails(out, j);
      }, 'flex:1;padding:11px');
      var off = btn('Hatao', async function () { var j = await gapi('/disconnect', 'POST', {}); if (j.ok) loadGmail(); else say('gm-msg', j.error, true); });
      bar.appendChild(go); bar.appendChild(off); box.appendChild(bar);
      if (st.canSend) {
        var comp = el('div', ''); var nb = btn('Naya mail likho', function () { if (!comp.firstChild) comp.appendChild(composeBox()); else comp.textContent = ''; }, 'margin-top:8px;width:100%;padding:10px');
        box.appendChild(nb); box.appendChild(comp);
      } else {
        box.appendChild(el('div', 'font-size:12px;opacity:.7;margin-top:6px;line-height:1.5', 'Mail bhejne/reply ki permission nahi di gayi. "Hatao" dabake dobara "Gmail jodo" karo aur send allow karo. Bhejne se pehle Aureon hamesha tumse Approve maangta hai.'));
      }
      box.appendChild(watchBox());
      var dr = el('div', ''); dr.id = 'gm-drafts'; box.appendChild(dr);
      box.appendChild(out); loadDrafts();
    }
  }
  async function loadGmail() {
    if (!$('gm-box') || needLogin()) return;
    GM.st = await gapi('/status'); renderGmail();
  }

  /* ============================ Phone ke apps (installed on this phone) ============================ */
  var PA = { all: null, open: '', q: '' };
  function plugin() { var C = window.Capacitor; return C && C.Plugins && C.Plugins.AureonActions; }
  function paLoad() { try { var a = JSON.parse(localStorage.getItem('aureon_phone_apps') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function paSave(a) { try { localStorage.setItem('aureon_phone_apps', JSON.stringify(a.slice(0, 60))); } catch (e) { /* storage full / blocked */ } }
  function paIsOn(pkg) { return paLoad().some(function (x) { return x.pkg === pkg; }); }
  window.AureonPhoneApps = {
    list: paLoad,
    open: function (pkg) { var A = plugin(); return A && A.openAppByPackage ? A.openAppByPackage({ pkg: pkg }) : Promise.reject(new Error('Android app chahiye')); }
  };

  /* ============================ Claude connector (MCP) ============================ */
  async function mapi(path, method, body) {
    var h = await authHeaders();
    var res = await fetch(base() + '/api/mcp-token' + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok && !j.error) j.error = 'Server error (' + res.status + ')';
    return j;
  }
  async function loadMcp() {
    var box = $('mc-box'); if (!box || needLogin()) return;
    var st = await mapi('/status'); box.textContent = '';
    if (!st.ok) { box.appendChild(el('div', 'font-size:12px;color:var(--danger,#ff6b6b)', st.error || 'Status nahi mila')); return; }
    $('mc-state').textContent = st.active ? '(chalu)' : '';
    box.appendChild(el('div', 'font-size:12px;opacity:.75;line-height:1.5;margin-bottom:6px', 'Claude me Aureon ko connector ki tarah jodo: Claude se pucho "mere important mails?" ya "iska reply draft karo". Claude sirf padh sakta hai aur DRAFT bana sakta hai: bhejna hamesha tumhare Approve se hota hai.'));
    var out = el('div', '');
    var bar = el('div', 'display:flex;gap:8px');
    bar.appendChild(btn(st.active ? 'Naya token banao' : 'Token banao', async function () {
      var j = await mapi('/create', 'POST', {});
      if (!j.ok) return say('mc-msg', j.error, true);
      out.textContent = '';
      out.appendChild(el('div', 'font-size:12px;margin:8px 0 2px;color:#ffcc66', 'Ye token sirf abhi dikhega, copy kar lo (purana token band ho gaya):'));
      var t = field('input', ''); t.value = j.token; t.readOnly = true; out.appendChild(t);
      out.appendChild(btn('Token copy karo', function () { try { navigator.clipboard.writeText(j.token); say('mc-msg', 'Token copy ho gaya.'); } catch (e) { t.select(); say('mc-msg', 'Token select hai, copy karo.'); } }));
      var u = field('input', ''); u.value = base() + '/mcp'; u.readOnly = true; out.appendChild(el('div', 'font-size:12px;margin:10px 0 2px', 'Connector URL:')); out.appendChild(u);
      out.appendChild(btn('URL copy karo', function () { try { navigator.clipboard.writeText(u.value); say('mc-msg', 'URL copy ho gaya.'); } catch (e) { u.select(); } }));
      out.appendChild(el('div', 'font-size:12px;line-height:1.6;margin-top:10px;opacity:.85', 'Claude me: Settings → Connectors → "Add custom connector" → URL daalo → Advanced/Request headers me ek header jodo: Authorization = Bearer <token>. Phir chat me connector on karo.'));
      loadMcp.keep = true; $('mc-state').textContent = '(chalu)';
    }));
    if (st.active) bar.appendChild(btn('Band karo', async function () { var j = await mapi('/revoke', 'POST', {}); if (j.ok) { loadMcp.keep = false; loadMcp(); } else say('mc-msg', j.error, true); }));
    box.appendChild(bar); box.appendChild(out);
  }

  /* ============================ App Agent: "Ava, is app me ye karo" ============================ */
  var AG = { pkg: '', poll: null, consent: false };
  function agentConsentOk() { try { return localStorage.getItem('aureon_agent_ok') === '1'; } catch (e) { return false; } }
  function agentPoll() {
    var A = plugin(); if (!A || !A.agentStatus || AG.poll) return;
    AG.poll = setInterval(async function () {
      try {
        var r = await A.agentStatus();
        if (r.running) { say('pa-msg', 'Ava kaam kar rahi hai: ' + (r.status || '…')); return; }
        clearInterval(AG.poll); AG.poll = null;
        var last = {}; try { last = JSON.parse(r.last || '{}'); } catch (e) { /* none */ }
        say('pa-msg', last.result ? 'Ava (' + (last.app || '') + '): ' + last.result : 'Task khatam.');
      } catch (e) { clearInterval(AG.poll); AG.poll = null; }
    }, 2500);
  }
  function agentBox(a) {
    var box = el('div', 'padding:0 0 12px 40px');
    var inp = field('input', 'Ava ko kya karwana hai? (jaise: Raj ko hello bhejo)');
    var note = el('div', 'font-size:11.5px;opacity:.75;line-height:1.5;margin:2px 0 6px', 'Ava is app ki screen padhegi (password fields nahi) aur AI server ko bhejegi. Send / Post / Pay / Delete jaise button se pehle tumhe notification me "Allow" dabana hoga. Banking aur settings apps band hain.');
    var go = btn(agentConsentOk() ? 'Ava se karwao' : 'Samajh gaya, chalao', async function () {
      var A = plugin();
      if (!A || !A.agentStart) return say('pa-msg', 'Ye sirf Android app me chalta hai.', true);
      if (!inp.value.trim()) return say('pa-msg', 'Batao kya karna hai.', true);
      try { localStorage.setItem('aureon_agent_ok', '1'); } catch (e) { /* ignore */ }
      var h = await authHeaders();
      var res = await fetch(base() + '/api/appagent/start', { method: 'POST', headers: h, body: JSON.stringify({ pkg: a.pkg, label: a.label, goal: inp.value }) });
      var j = await res.json().catch(function () { return {}; });
      if (!j.ok) return say('pa-msg', j.error || 'Start nahi hua', true);
      try {
        await A.agentStart({ backendUrl: base(), key: j.key, pkg: a.pkg, label: a.label, goal: inp.value.trim() });
        say('pa-msg', a.label + ' khul raha hai… Ava kaam shuru kar rahi hai. Notification me "Roko" se rok sakte ho.'); agentPoll();
      } catch (e) {
        var m = (e && e.message) || String(e);
        if (m.indexOf('accessibility_off') >= 0) { say('pa-msg', 'Pehle Accessibility me Aureon ko ON karo. Settings khol raha hoon…', true); try { A.openAccessibilitySettings(); } catch (e2) { /* ignore */ } }
        else if (m.indexOf('busy') >= 0) say('pa-msg', 'Ava abhi ek task kar rahi hai.', true);
        else if (m.indexOf('denied_app') >= 0) say('pa-msg', 'Is app me Ava kaam nahi karti (safety).', true);
        else say('pa-msg', 'Start nahi hua: ' + m, true);
      }
    }, 'padding:9px 12px');
    var stop = btn('Roko', function () { var A = plugin(); if (A && A.agentStop) A.agentStop(); say('pa-msg', 'Rok diya.'); }, 'margin-left:8px');
    box.appendChild(inp); box.appendChild(note); box.appendChild(go); box.appendChild(stop);
    return box;
  }

  function renderPhoneApps() {
    var box = $('pa-list'); if (!box) return;
    box.textContent = '';
    var on = paLoad(); $('pa-count').textContent = on.length ? '(' + on.length + ' jude)' : '';
    if (PA.all == null) { box.appendChild(el('div', 'font-size:12px;opacity:.65', 'Apps load ho rahe hain…')); return; }
    if (!PA.all.length) { box.appendChild(el('div', 'font-size:12px;opacity:.65;line-height:1.5', plugin() ? 'Koi app nahi mila.' : 'Phone ke apps sirf Android app me dikhte hain (browser me nahi).')); return; }
    var q = PA.q.trim().toLowerCase();
    var rows = PA.all.filter(function (a) { return !q || a.label.toLowerCase().indexOf(q) >= 0; });
    // connected apps first
    rows.sort(function (a, b) { return (paIsOn(b.pkg) - paIsOn(a.pkg)); });
    rows.slice(0, 80).forEach(function (a) {
      var isOn = paIsOn(a.pkg), isOpen = PA.open === a.pkg;
      var card = el('div', 'border-top:1px solid rgba(255,255,255,.1)');
      var head = el('div', 'display:flex;align-items:center;gap:10px;padding:10px 0;cursor:pointer');
      var dot = el('div', 'width:30px;height:30px;border-radius:9px;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px', (a.label || '?').charAt(0).toUpperCase());
      var t = el('div', 'flex:1;min-width:0');
      t.appendChild(el('div', 'font-size:14px;font-weight:600', a.label));
      t.appendChild(el('div', 'font-size:11px;opacity:.5;overflow-wrap:anywhere', a.pkg));
      head.appendChild(dot); head.appendChild(t);
      if (isOn) head.appendChild(el('div', 'font-size:11px;color:#6fdc8c', 'Jura ✓'));
      head.addEventListener('click', function () { PA.open = isOpen ? '' : a.pkg; renderPhoneApps(); });
      card.appendChild(head);
      if (isOpen) {
        var bar = el('div', 'display:flex;gap:8px;padding:0 0 10px 40px;flex-wrap:wrap');
        bar.appendChild(btn('Kholo', function () {
          window.AureonPhoneApps.open(a.pkg).catch(function (e) { say('pa-msg', (e && e.message) || 'Khul nahi paya', true); });
        }));
        bar.appendChild(btn(isOn ? 'Aureon se hatao' : 'Aureon se jodo', function () {
          var cur = paLoad().filter(function (x) { return x.pkg !== a.pkg; });
          if (!isOn) cur.push({ pkg: a.pkg, label: a.label });
          paSave(cur); say('pa-msg', isOn ? a.label + ' hata diya.' : a.label + ' jud gaya: ab Dashboard se ek tap me khulega, aur Ava se "' + a.label + ' kholo" bol sakte ho.');
          renderPhoneApps();
        }));
        card.appendChild(bar);
        if (isOn) card.appendChild(agentBox(a));
      }
      box.appendChild(card);
    });
    if (rows.length > 80) box.appendChild(el('div', 'font-size:11px;opacity:.55;padding:6px 0', 'Aur ' + (rows.length - 80) + ' apps — upar search me naam likho.'));
    if (!rows.length) box.appendChild(el('div', 'font-size:12px;opacity:.65;padding:6px 0', 'Is naam ka koi app nahi.'));
  }
  async function loadPhoneApps() {
    if (!$('pa-list')) return;
    var A = plugin();
    if (!A || !A.listInstalledApps) { PA.all = []; renderPhoneApps(); return; }
    try { var r = await A.listInstalledApps(); PA.all = (r && r.apps) || []; } catch (e) { PA.all = []; say('pa-msg', 'Apps ki list nahi mili: ' + ((e && e.message) || e), true); }
    renderPhoneApps();
  }

  function wire() {
    if (!$('ap-save') || $('ap-save').dataset.wired) return;
    $('ap-save').dataset.wired = '1';
    var sel = $('ap-preset');
    PRESETS.forEach(function (p, i) { var o = document.createElement('option'); o.value = i; o.textContent = p.label; sel.appendChild(o); });
    sel.addEventListener('change', function () { preset = PRESETS[Number(sel.value)]; applyPreset(); });
    $('ap-auth').addEventListener('change', syncAuth);
    $('ap-toggle').addEventListener('click', function () { $('ap-form').classList.toggle('hidden'); applyPreset(); });
    $('au-toggle').addEventListener('click', function () { $('au-form').classList.toggle('hidden'); });
    $('au-trig').addEventListener('change', function () { $('au-every').classList.toggle('hidden', $('au-trig').value !== 'interval'); });
    $('ap-save').addEventListener('click', saveApp);
    $('au-save').addEventListener('click', saveAuto);
    document.querySelectorAll('.list-row[data-open="connect"]').forEach(function (b) { b.addEventListener('click', function () { loadAll(); loadGmail(); loadMcp(); loadPhoneApps(); }); });
    if ($('pa-search')) $('pa-search').addEventListener('input', function () { PA.q = $('pa-search').value; renderPhoneApps(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && $('gm-box') && $('gm-box').offsetParent) loadGmail(); });
  }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
})();
