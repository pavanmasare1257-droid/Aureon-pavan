/* Aureon — "My Dashboard" settings pane (v51): one small screen with everything that matters.
   Cards: Phone (battery, Away mode), Gmail (important mails), Digital Twin (approvals), Apps & Automation (last runs), quick-launch of the
   phone apps you connected. Every card loads on its own, so one failing server call never blanks the rest.
   Needs app.js globals: state (backendUrl, user), authHeaders(). All server data is rendered with textContent (no HTML injection). */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }
  function plugin() { var C = window.Capacitor; return C && C.Plugins && C.Plugins.AureonActions; }
  function needLogin() { return typeof state === 'undefined' || !state.user; }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  function btn(label, fn, css) { var b = el('button', 'background:none;border:1px solid rgba(255,255,255,.18);color:inherit;border-radius:10px;padding:6px 10px;font-size:12px;' + (css || ''), label); b.addEventListener('click', fn); return b; }
  function agoTxt(t) { if (!t) return ''; var m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'abhi' : m < 60 ? m + ' min pehle' : m < 1440 ? Math.round(m / 60) + ' ghante pehle' : Math.round(m / 1440) + ' din pehle'; }
  async function get(path, method, body) {
    var h = await authHeaders();
    var res = await fetch(base() + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok && !j.error) j.error = 'Server error (' + res.status + ')';
    return j;
  }

  var BUSY = false;

  /* a card = title + body; returns the body element to fill */
  function card(title, right) {
    var c = el('div', 'border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:12px 14px;margin:0 0 12px;background:rgba(255,255,255,.04)');
    var h = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px');
    h.appendChild(el('div', 'font-weight:700;font-size:14px', title));
    if (right) h.appendChild(right);
    c.appendChild(h);
    var body = el('div', 'font-size:13px');
    c.appendChild(body);
    $('dash-box').appendChild(c);
    return body;
  }
  function line(body, text, css) { body.appendChild(el('div', 'margin:3px 0;overflow-wrap:anywhere;' + (css || ''), text)); }
  function err(body, text) { line(body, text, 'color:var(--danger,#ff6b6b);font-size:12px'); }
  function muted(body, text) { line(body, text, 'opacity:.65;font-size:12px'); }

  /* ---------- Phone ---------- */
  async function cardPhone() {
    var b = card('Phone');
    var A = plugin();
    if (!A) { muted(b, 'Battery aur Away mode sirf Android app me dikhte hain.'); return; }
    try {
      if (A.getBattery) { var bt = await A.getBattery(); if (bt && bt.level >= 0) line(b, 'Battery: ' + bt.level + '%' + (bt.charging ? ' (charge ho rahi hai)' : '')); }
    } catch (e) { /* optional */ }
    try {
      if (A.agentStatus) {
        var g = await A.agentStatus(), last = {}; try { last = JSON.parse(g.last || '{}'); } catch (e) { /* none */ }
        if (g.running) line(b, 'Ava kaam kar rahi hai: ' + (g.status || '…'), 'color:#6fdc8c');
        else if (last.result) line(b, 'Ava ka last app-task (' + (last.app || '') + '): ' + last.result, 'font-size:12px;opacity:.85');
      }
    } catch (e) { /* optional */ }
    try {
      if (A.awayStatus) {
        var a = await A.awayStatus();
        var calls = (a && a.calls) || [], fresh = calls.filter(function (c) { return !c.reported; });
        if (a && a.active) line(b, 'Away mode CHALU' + (a.reason ? ': ' + a.reason : '') + (a.until ? ' (' + new Date(a.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' tak)' : ''), 'color:#6fdc8c');
        else line(b, 'Away mode band hai.');
        if (fresh.length) {
          line(b, fresh.length + ' nayi call Ava ne li:', 'margin-top:6px');
          fresh.slice(-3).reverse().forEach(function (c) {
            var who = c.name || c.number || 'Unknown';
            var first = ''; (c.transcript || []).some(function (t) { if (t.who === 'caller') { first = t.text; return true; } return false; });
            line(b, '• ' + who + (c.atText ? ' (' + c.atText + ')' : '') + (first ? ': ' + first : ''), 'font-size:12px;opacity:.85');
          });
        }
      }
    } catch (e) { /* optional */ }
  }

  /* ---------- Gmail ---------- */
  async function cardGmail() {
    var again = btn('Naya check', function () { fill(true); }, 'padding:4px 9px');
    var b = card('Gmail', again);
    async function fill(force) {
      b.textContent = ''; muted(b, 'Check ho raha hai…');
      var st = await get('/api/gmail/status');
      b.textContent = '';
      if (!st.ok) return err(b, st.error);
      if (!st.configured) return muted(b, 'Gmail abhi setup nahi hua. Settings > Apps & Automation > Gmail.');
      if (!st.connected) return muted(b, 'Gmail jura nahi hai. Settings > Apps & Automation > Gmail jodo.');
      var j = await get('/api/gmail/important', 'POST', { force: !!force });
      b.textContent = '';
      if (st.pendingDrafts) line(b, '✉️ ' + st.pendingDrafts + ' mail draft tumhare Approve ka intezaar kar raha hai (Apps & Automation > Gmail)', 'color:#ffcc66;font-weight:600');
      if (!j.ok) return err(b, j.error);
      if (j.summary) line(b, j.summary);
      (j.items || []).slice(0, 5).forEach(function (m) {
        var u = m.urgency === 'high' ? '🔴' : m.urgency === 'low' ? '⚪' : '🟡';
        line(b, u + ' ' + m.subject, 'font-weight:600;margin-top:7px');
        line(b, m.from + (m.why ? ' — ' + m.why : ''), 'font-size:12px;opacity:.75');
      });
      if (!(j.items || []).length) muted(b, 'Koi zaroori mail nahi.');
      if (j.checkedAt) muted(b, agoTxt(j.checkedAt) + ' check hua');
      try { var A2 = plugin(); if (A2 && A2.mailWatchStatus) { var ws = await A2.mailWatchStatus(); muted(b, 'Urgent mail alerts: ' + (ws.enabled ? 'CHALU' : 'band (Apps & Automation > Gmail me chalu karo)')); } } catch (e) { /* optional */ }
    }
    try { await fill(false); } catch (e) { b.textContent = ''; err(b, 'Gmail card load nahi hua.'); }
  }

  /* ---------- Digital Twin ---------- */
  async function cardTwin() {
    var b = card('Digital Twin');
    try {
      var o = await get('/api/twin/overview');
      if (!o.ok) { muted(b, o.error || 'Twin abhi available nahi.'); return; }
      var pend = o.pending || [];
      line(b, pend.length ? pend.length + ' approval ka intezaar hai' : 'Koi approval pending nahi.', pend.length ? 'color:#ffcc66;font-weight:600' : '');
      pend.slice(0, 3).forEach(function (p) { line(b, '• ' + (p.summary || p.action || 'Action'), 'font-size:12px;opacity:.85'); });
      var c = o.continuity || {};
      line(b, 'Dead-man switch: ' + (c.enabled ? 'chalu (' + (c.state || 'ok') + ')' : 'band'), 'font-size:12px;opacity:.8');
      if (pend.length) b.appendChild(btn('Approvals dekho', function () {
        if (typeof settingsShowList === 'function') settingsShowList();
        var r = $('twin-open-row'); if (r) r.click();
      }, 'margin-top:6px'));
    } catch (e) { err(b, 'Twin card load nahi hua.'); }
  }

  /* ---------- Apps & Automation ---------- */
  async function cardAutos() {
    var b = card('Apps & Automation');
    try {
      var a = await get('/api/connect/apps'), u = await get('/api/connect/automations');
      if (!a.ok) { muted(b, a.error || 'Abhi available nahi.'); return; }
      var autos = u.ok ? (u.automations || []) : [];
      line(b, (a.apps || []).length + ' apps jude · ' + autos.filter(function (x) { return x.enabled; }).length + '/' + autos.length + ' automations chalu');
      autos.filter(function (x) { return x.lastRun; }).sort(function (x, y) { return y.lastRun.at - x.lastRun.at; }).slice(0, 3).forEach(function (x) {
        line(b, (x.lastRun.ok ? '✓ ' : '✗ ') + x.name + ' · ' + agoTxt(x.lastRun.at), 'font-size:12px;margin-top:5px;opacity:.9');
        line(b, String(x.lastRun.text || '').slice(0, 160), 'font-size:12px;opacity:.65');
      });
    } catch (e) { err(b, 'Card load nahi hua.'); }
  }

  /* ---------- Quick launch (phone apps the owner connected) ---------- */
  function cardQuick() {
    var list = (window.AureonPhoneApps && window.AureonPhoneApps.list()) || [];
    var b = card('Mere apps');
    if (!list.length) { muted(b, 'Settings > Apps & Automation > Phone ke apps me kisi app par tap karke "Aureon se jodo" dabao.'); return; }
    var row = el('div', 'display:flex;flex-wrap:wrap;gap:8px');
    list.forEach(function (a) {
      row.appendChild(btn(a.label, function () {
        window.AureonPhoneApps.open(a.pkg).catch(function (e) { alert((e && e.message) || 'Khul nahi paya'); });
      }, 'padding:9px 12px;font-size:13px'));
    });
    b.appendChild(row);
  }

  async function refresh() {
    if (BUSY || !$('dash-box')) return;
    BUSY = true;
    try {
      $('dash-box').textContent = '';
      if (needLogin()) { var b = card('Sign in'); muted(b, 'Dashboard dekhne ke liye pehle sign in karo.'); return; }
      cardQuick();
      await Promise.all([cardPhone(), cardGmail(), cardTwin(), cardAutos()]);
      var t = $('dash-time'); if (t) t.textContent = 'Update: ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } finally { BUSY = false; }
  }

  function wire() {
    if (!$('dash-box') || $('dash-box').dataset.wired) return;
    $('dash-box').dataset.wired = '1';
    document.querySelectorAll('.list-row[data-open="dash"]').forEach(function (b) { b.addEventListener('click', refresh); });
    var r = $('dash-refresh'); if (r) r.addEventListener('click', refresh);
  }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
})();
