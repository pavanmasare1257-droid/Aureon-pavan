/* Aureon Phone Security — web side of the AureonDeviceGuard plugin.
   Runs the native (read-only) scan and sends the result to YOUR backend with a per-phone
   device key. The key can only submit reports (create it in Security dashboard -> My Phone). */
(function () {
  var KEY = 'aureon_device_key', LAST = 'aureon_phone_check', AUTO = 'aureon_phone_check_auto';
  var $ = function (id) { return document.getElementById(id); };
  function plugin() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonDeviceGuard; }
  function backend() { try { return String(state.backendUrl || 'https://aureone.onrender.com').replace(/\/$/, ''); } catch (e) { return 'https://aureone.onrender.com'; } }
  function get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage full / blocked */ } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function show(msg, cls) {
    var el = $('pg-result'); if (!el) return;
    el.innerHTML = '<div style="padding:12px;border-radius:12px;border:1px solid var(--border-gold);background:var(--cream);font-size:13px;line-height:1.5' + (cls ? ';color:' + cls : '') + '">' + msg + '</div>';
  }
  function levelLine(r) {
    var lv = r.level === 'GOOD' ? 'good' : r.level === 'ATTENTION' ? 'warn' : 'bad';
    return '<span class="dg-dot dg-' + lv + '"></span><b>Score ' + r.score + '/100 — ' + esc(r.level) + '</b><br>' + r.findings + UL(' issue(s) found. Open Security dashboard → My Phone for details.', ' issue(s) mile. Details dekhne ke liye Security dashboard → My Phone kholo.');
  }
  function renderLast() {
    var sub = $('sub-phoneguard'), raw = get(LAST), r = null;
    try { r = raw ? JSON.parse(raw) : null; } catch (e) { r = null; }
    if (sub) sub.textContent = r ? ('Score ' + r.score + ' · ' + new Date(r.at).toLocaleDateString()) : (get(KEY) ? 'Abhi check nahi hua' : 'Device key daalo');
    if (r && $('pg-result')) show(levelLine(r) + '<br><small>last check: ' + new Date(r.at).toLocaleString() + '</small>');
  }

  async function run(silent) {
    var p = plugin(), key = get(KEY).trim();
    if (!p) { if (!silent) show('Ye feature sirf Aureon Android app mein chalta hai (phone ki settings padhne ke liye).', 'var(--danger)'); return; }
    if (!key) { if (!silent) show('Pehle device key daalo (Security dashboard → My Phone → Naya phone jodo).', 'var(--danger)'); return; }
    if (!silent) show('Phone check ho raha hai…');
    try {
      var raw = await p.scan();
      var res = await fetch(backend() + '/api/security/device/report', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-key': key }, body: JSON.stringify(raw) });
      if (!res.ok) { if (!silent) show(res.status === 404 ? 'Device key galat / hata di gayi hai. Dashboard se nayi key banao.' : 'Server ne report nahi li (' + res.status + ').', 'var(--danger)'); return; }
      var j = await res.json();
      set(LAST, JSON.stringify({ score: j.score, level: j.level, findings: j.findings, at: new Date().toISOString() }));
      renderLast();
    } catch (e) {
      if (!silent) show('Check fail: ' + esc(e && e.message ? e.message : e), 'var(--danger)');
    }
  }

  function wire() {
    var key = $('pg-key'); if (!key) return;
    key.value = get(KEY);
    $('pg-save').addEventListener('click', function () { set(KEY, key.value.trim()); renderLast(); show('Key save ho gayi. Ab "Abhi check karo" dabao.'); });
    $('pg-run').addEventListener('click', function () { set(KEY, key.value.trim()); run(false); });
    var auto = $('pg-auto'); auto.checked = get(AUTO) !== '0';
    auto.addEventListener('change', function () { set(AUTO, auto.checked ? '1' : '0'); });
    renderLast();
  }
  function autoRun() {
    if (get(AUTO) === '0' || !get(KEY)) return;
    var r = null; try { r = JSON.parse(get(LAST) || 'null'); } catch (e) { r = null; }
    if (!r || Date.now() - Date.parse(r.at) > 20 * 3600 * 1000) run(true);   // about once a day while the app is used
  }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
  setTimeout(autoRun, 15000);
  setInterval(autoRun, 3600 * 1000);
  window.AureonDeviceGuard = { run: run };
})();
