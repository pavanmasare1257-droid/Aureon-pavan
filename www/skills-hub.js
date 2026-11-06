/* Aureon — Code mode (skills) settings pane.
   Needs app.js globals: state (backendUrl, model), authHeaders(), MODEL_LABELS, ic().
   Fast delete: search, filters (non-English / no description / source), Select mode with "Sab chuno", bulk delete, delete a whole source. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }

  async function api(path, method, body) {
    var h = await authHeaders();
    var res = await fetch(base() + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok && !j.error) j.error = 'Server error (' + res.status + ')';
    j._status = res.status;
    return j;
  }
  function say(id, text, bad) {
    var el = $(id); if (!el) return;
    el.textContent = text || '';
    el.style.color = bad ? 'var(--danger, #ff6b6b)' : '';
  }
  function needLogin() { return typeof state === 'undefined' || !state.user; }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  var BTN = 'padding:8px 12px;border-radius:10px;border:1px solid var(--border-gold, rgba(255,255,255,.22));background:transparent;color:inherit;font-size:13px;';

  /* ---------------- Code mode (skills) ---------------- */
  var S = { all: [], sel: new Set(), mode: false, q: '', f: 'all', src: '', shown: 100 };
  var UI = {};   // toolbar elements, built once
  var NONLATIN = /[\u0400-\u04FF\u0590-\u06FF\u0900-\u0DFF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/g;

  function isNonEnglish(s) { var m = String(s.description || '').match(NONLATIN); return !!m && m.length >= 4; }
  function noDesc(s) { return !String(s.description || '').trim(); }
  function srcOf(s) { return s.source || '(unknown)'; }
  function shortSrc(u) { return String(u).replace(/^https:\/\/github\.com\//i, ''); }
  function filtered() {
    var q = S.q.trim().toLowerCase();
    return S.all.filter(function (s) {
      if (S.f === 'ne' && !isNonEnglish(s)) return false;
      if (S.f === 'nodesc' && !noDesc(s)) return false;
      if (S.src && srcOf(s) !== S.src) return false;
      if (q && (s.name + ' ' + (s.description || '') + ' ' + srcOf(s)).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function buildToolbar() {
    if (UI.root || !$('cs-list')) return;
    var root = el('div', 'margin:8px 0 4px');
    UI.root = root;
    var row1 = el('div', 'display:flex;gap:8px;align-items:center');
    UI.search = el('input', 'flex:1;min-width:0'); UI.search.className = 'text-input'; UI.search.type = 'search';
    UI.search.placeholder = 'Skill dhundo (naam ya description)…'; UI.search.setAttribute('autocapitalize', 'off'); UI.search.setAttribute('spellcheck', 'false');
    UI.search.addEventListener('input', function () { S.q = UI.search.value; S.shown = 100; render(); });
    UI.modeBtn = el('button', BTN, 'Select'); UI.modeBtn.addEventListener('click', function () { S.mode = !S.mode; if (!S.mode) S.sel.clear(); render(); });
    row1.appendChild(UI.search); row1.appendChild(UI.modeBtn);

    var row2 = el('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center');
    UI.chips = {};
    [['all', 'Sab'], ['ne', 'Non-English'], ['nodesc', 'Bina description']].forEach(function (c) {
      var b = el('button', BTN, c[1]); b.addEventListener('click', function () { S.f = c[0]; S.shown = 100; render(); });
      UI.chips[c[0]] = b; row2.appendChild(b);
    });
    UI.srcSel = el('select', BTN + 'max-width:100%'); UI.srcSel.className = 'text-input';
    UI.srcSel.addEventListener('change', function () { S.src = UI.srcSel.value; S.shown = 100; render(); });
    row2.appendChild(UI.srcSel);

    UI.info = el('div', 'font-size:12px;opacity:.65;margin-top:6px');
    UI.bar = el('div', 'display:none;gap:8px;flex-wrap:wrap;align-items:center;position:sticky;bottom:8px;z-index:6;margin-top:8px;padding:8px;border-radius:12px;background:var(--p-surface, #14142a);border:1px solid var(--border-gold, rgba(255,255,255,.22))');
    UI.selAll = el('button', BTN, 'Sab chuno'); UI.selAll.addEventListener('click', function () { filtered().forEach(function (s) { S.sel.add(s.name); }); render(); });
    UI.clear = el('button', BTN, 'Clear'); UI.clear.addEventListener('click', function () { S.sel.clear(); render(); });
    UI.delSel = el('button', BTN + 'background:var(--danger, #e5484d);border-color:transparent;color:#fff;font-weight:600', 'Hatao'); UI.delSel.addEventListener('click', function () { deleteNames(Array.from(S.sel)); });
    UI.delSrc = el('button', BTN + 'border-color:var(--danger, #e5484d);color:var(--danger, #ff6b6b)', 'Poora source hatao'); UI.delSrc.addEventListener('click', deleteSource);
    UI.bar.appendChild(UI.selAll); UI.bar.appendChild(UI.clear); UI.bar.appendChild(UI.delSel); UI.bar.appendChild(UI.delSrc);

    root.appendChild(row1); root.appendChild(row2); root.appendChild(UI.info); root.appendChild(UI.bar);
    $('cs-list').parentNode.insertBefore(root, $('cs-list'));
  }

  function updateBar() {
    if (!UI.bar) return;
    UI.bar.style.display = S.mode ? 'flex' : 'none';
    UI.modeBtn.textContent = S.mode ? 'Done' : 'Select';
    var f = filtered();
    UI.selAll.textContent = 'Sab chuno (' + f.length + ')';
    UI.delSel.textContent = 'Hatao (' + S.sel.size + ')';
    UI.delSel.disabled = !S.sel.size; UI.delSel.style.opacity = S.sel.size ? '1' : '.45';
    UI.delSrc.style.display = S.src ? '' : 'none';
  }

  function render() {
    buildToolbar();
    var box = $('cs-list'); box.textContent = '';
    var list = S.all;
    var cnt = $('cs-count'); if (cnt) cnt.textContent = list.length ? '(' + list.length + ')' : '';
    var sub = $('sub-claudecode'); if (sub) sub.textContent = list.length ? list.length + ' skill installed' : 'Skills install karo';
    if (UI.root) UI.root.style.display = list.length ? '' : 'none';
    if (!list.length) { box.appendChild(el('div', '', 'Abhi koi skill nahi. Upar GitHub link daalo.')).className = 'card-sub'; return; }

    var neN = list.filter(isNonEnglish).length, ndN = list.filter(noDesc).length;
    var names = { all: 'Sab (' + list.length + ')', ne: 'Non-English (' + neN + ')', nodesc: 'Bina description (' + ndN + ')' };
    Object.keys(UI.chips).forEach(function (k) { UI.chips[k].textContent = names[k]; UI.chips[k].style.background = S.f === k ? 'var(--accent, rgba(120,120,255,.35))' : 'transparent'; });
    var counts = {}; list.forEach(function (s) { counts[srcOf(s)] = (counts[srcOf(s)] || 0) + 1; });
    UI.srcSel.textContent = '';
    var o0 = el('option', '', 'Sab sources'); o0.value = ''; UI.srcSel.appendChild(o0);
    Object.keys(counts).sort().forEach(function (k) { var o = el('option', '', shortSrc(k) + ' (' + counts[k] + ')'); o.value = k; UI.srcSel.appendChild(o); });
    UI.srcSel.value = S.src;

    var f = filtered();
    UI.info.textContent = f.length + UL(' shown', ' dikh rahi hain') + (S.mode ? ' · ' + S.sel.size + UL(' selected', ' chuni hui') : UL(' · press "Select" to remove', ' · hatane ke liye "Select" dabao'));
    f.slice(0, S.shown).forEach(function (s) { box.appendChild(buildRow(s)); });
    if (f.length > S.shown) {
      var more = el('button', BTN + 'width:100%;margin:10px 0', 'Aur dikhao (+100)'); more.addEventListener('click', function () { S.shown += 100; render(); });
      box.appendChild(more);
    }
    updateBar();
  }

  function buildRow(s) {
    var row = el('div', 'display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--border-gold, rgba(255,255,255,.12))');
    var cb = null;
    if (S.mode) {
      cb = el('input', 'margin-top:4px;width:18px;height:18px;flex:none'); cb.type = 'checkbox'; cb.checked = S.sel.has(s.name);
      row.style.cursor = 'pointer';
      var toggle = function (fromBox) {
        if (S.sel.has(s.name)) S.sel.delete(s.name); else S.sel.add(s.name);
        cb.checked = S.sel.has(s.name);
        var info = UI.info; if (info) info.textContent = filtered().length + UL(' shown · ', ' dikh rahi hain · ') + S.sel.size + UL(' selected', ' chuni hui');
        updateBar();
      };
      row.addEventListener('click', function (e) { if (e.target === cb) { toggle(); return; } toggle(); });
      row.appendChild(cb);
    }
    var txt = el('div', 'flex:1;min-width:0');
    txt.appendChild(el('div', 'font-weight:600;font-size:14px', s.name));
    txt.appendChild(el('div', 'font-size:12px;opacity:.75;line-height:1.4;margin-top:2px;overflow-wrap:anywhere', s.description || '(description nahi hai)'));
    txt.appendChild(el('div', 'font-size:11px;opacity:.5;margin-top:2px;overflow-wrap:anywhere', s.source || ''));
    row.appendChild(txt);
    if (!S.mode) {
      var del = el('button', 'background:none;border:0;color:inherit;font-size:16px;padding:6px 8px;opacity:.7');
      del.innerHTML = (typeof ic === 'function') ? ic('x') : '×'; del.setAttribute('aria-label', 'Remove ' + s.name);
      del.addEventListener('click', function () { deleteOne(s); });
      row.appendChild(del);
    }
    return row;
  }

  function removeLocal(names) {
    var set = new Set(names);
    S.all = S.all.filter(function (s) { return !set.has(s.name); });
    names.forEach(function (n) { S.sel.delete(n); });
    if (S.src && !S.all.some(function (s) { return srcOf(s) === S.src; })) S.src = '';
  }
  async function deleteOne(s) {   // one tap, row disappears at once, server call in the background
    removeLocal([s.name]); render();
    var j = await api('/api/skills/' + encodeURIComponent(s.name), 'DELETE');
    if (!j.ok) { S.all.push(s); render(); say('cs-msg', j.error || 'Hata nahi paaya', true); }
  }
  async function deleteNames(names) {
    if (!names.length) return;
    var preview = names.slice(0, 5).join(', ') + (names.length > 5 ? ' … +' + (names.length - 5) + ' aur' : '');
    if (!window.confirm(names.length + UL(' skill(s) to remove?\n', ' skill hatani hain?\n') + preview + UL('\n\nThey will not come back (you must install them again).', '\n\nYe wapas nahi aayengi (dobara install karni padegi).'))) return;
    var done = 0;
    for (var i = 0; i < names.length; i += 400) {
      var chunk = names.slice(i, i + 400);
      say('cs-msg', UL('Removing… (', 'Hataa rahe hain… (') + done + '/' + names.length + ')');
      var j = await api('/api/skills/bulk-delete', 'POST', { names: chunk });
      if (!j.ok) { say('cs-msg', (j.error || UL('Delete failed', 'Delete fail hua')) + ' — ' + done + UL(' skill(s) were removed.', ' skill hat chuki hain.'), true); render(); return; }
      done += chunk.length; removeLocal(chunk);
    }
    say('cs-msg', done + ' skill hata di gayi.'); render();
  }
  async function deleteSource() {
    var src = S.src; if (!src) return;
    var n = S.all.filter(function (s) { return srcOf(s) === src; }).length;
    if (!window.confirm(UL('Remove all ' + n + ' skill(s) from ' + shortSrc(src) + '?\n\nThey will not come back (you must install them again).', shortSrc(src) + ' ki saari ' + n + ' skill hatani hain?\n\nYe wapas nahi aayengi (dobara install karni padegi).'))) return;
    say('cs-msg', UL('Removing…', 'Hataa rahe hain…'));
    var j = await api('/api/skills/bulk-delete', 'POST', { source: src });
    if (!j.ok) { say('cs-msg', j.error || 'Delete fail hua', true); return; }
    S.all = S.all.filter(function (s) { return srcOf(s) !== src; }); S.src = ''; S.sel.clear();
    say('cs-msg', (j.deleted || n) + ' skill hata di gayi.'); render();
  }

  async function loadSkills() {
    if (needLogin()) { say('cs-msg', 'Pehle sign in karo.', true); return; }
    var j = await api('/api/skills');
    if (j.error) { say('cs-msg', j.error, true); return; }
    S.all = (j.skills || []).slice().sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    S.sel.clear(); render();
  }
  async function installSkill() {
    if (needLogin()) return say('cs-msg', 'Pehle sign in karo.', true);
    var url = $('cs-url').value.trim();
    if (!/^https:\/\/github\.com\//i.test(url)) return say('cs-msg', 'Sirf https://github.com/... ka link chalega.', true);
    say('cs-msg', 'Install ho rahi hai…');
    var j = await api('/api/skills/install', 'POST', { url: url });
    if (j.ok) { $('cs-url').value = ''; say('cs-msg', (j.installed || []).length + ' skill install ho gayi'); loadSkills(); }
    else say('cs-msg', j.error, true);
  }
  function useCodeMode() {
    state.model = 'claudecode';
    try { localStorage.setItem('aureon_model', 'claudecode'); } catch (e) { /* blocked */ }
    var pill = $('model-pill'); if (pill && typeof MODEL_LABELS !== 'undefined') pill.textContent = MODEL_LABELS.claudecode;
    say('cs-msg', 'Code mode chalu — ab chat mein likho.');
  }

  function useCodingMode() {
    state.model = 'coding';
    try { localStorage.setItem('aureon_model', 'coding'); } catch (e) { /* blocked */ }
    var pill = $('model-pill'); if (pill && typeof MODEL_LABELS !== 'undefined') pill.textContent = MODEL_LABELS.coding;
    say('cs-msg', 'Coding mode chalu — ab chat mein likho.');
  }

  function wire() {
    if (!$('cs-install') || $('cs-install').dataset.wired) return;
    $('cs-install').dataset.wired = '1';
    $('cs-install').addEventListener('click', installSkill);
    $('cs-use').addEventListener('click', useCodeMode);
    if ($('cs-use-coding')) $('cs-use-coding').addEventListener('click', useCodingMode);
    $('cs-url').addEventListener('keydown', function (e) { if (e.key === 'Enter') installSkill(); });
    document.querySelectorAll('.list-row[data-open="claudecode"]').forEach(function (b) { b.addEventListener('click', loadSkills); });
  }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
  try { window.AureonSkillsHub = { _state: S, _filtered: filtered, _isNonEnglish: isNonEnglish }; } catch (e) { /* no window */ }
})();
