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
    document.querySelectorAll('.list-row[data-open="connect"]').forEach(function (b) { b.addEventListener('click', loadAll); });
  }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
})();
