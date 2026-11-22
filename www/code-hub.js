/* Aureon — Code mode "Repo task (PR)" (v52).
   You describe a change -> Ava proposes it -> you read the diff -> you tap Approve -> a Pull Request is opened on GitHub.
   Nothing is pushed to the main branch and nothing is merged; owner only. The server does the work (backend/repo-task.js);
   this file only shows the proposal and sends your approve/reject. Server text is rendered with textContent only. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }
  function needLogin() { return typeof state === 'undefined' || !state.user; }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  function btn(label, fn, css) { var b = el('button', 'background:none;border:1px solid rgba(255,255,255,.18);color:inherit;border-radius:10px;padding:8px 12px;font-size:13px;' + (css || ''), label); b.addEventListener('click', fn); return b; }
  function say(t, bad) { var e = $('rt-msg'); if (!e) return; e.textContent = t || ''; e.style.color = bad ? 'var(--danger, #ff6b6b)' : ''; }
  async function api(path, method, body) {
    var h = await authHeaders();
    var res = await fetch(base() + '/api/repotask' + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok && !j.error) j.error = 'Server error (' + res.status + ')';
    return j;
  }
  function openExternal(url) {
    var C = window.Capacitor, A = C && C.Plugins && C.Plugins.AureonActions;
    if (A && A.openUrl) { A.openUrl({ url: url }).catch(function () { window.open(url, '_blank'); }); } else window.open(url, '_blank');
  }

  function renderProposal(p) {
    var box = $('rt-box'); box.textContent = '';
    var c = el('div', 'margin:8px 0;padding:10px;border:1px solid rgba(255,204,102,.35);border-radius:12px');
    c.appendChild(el('div', 'font-weight:700;font-size:13px;margin-bottom:4px', 'Proposal'));
    if (p.summary) c.appendChild(el('div', 'font-size:13px;margin-bottom:6px;overflow-wrap:anywhere', p.summary));
    (p.files || []).forEach(function (f) {
      c.appendChild(el('div', 'font-size:12px;font-weight:600;margin-top:8px;overflow-wrap:anywhere', (f.isNew ? 'NAYI file: ' : 'Badli: ') + f.path + '  (+' + f.diff.added + ' / -' + f.diff.removed + ', line ' + f.diff.atLine + ')'));
      var pre = el('pre', 'font-size:11px;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;margin:4px 0;padding:8px;border-radius:8px;background:rgba(0,0,0,.3)', f.diff.preview);
      c.appendChild(pre);
    });
    var bar = el('div', 'display:flex;gap:8px;margin-top:8px'); var armed = false, timer = null;
    var ok = btn('Approve → PR banao', async function () {
      if (!armed) { armed = true; ok.textContent = 'Pakka? (dobara tap)'; timer = setTimeout(function () { armed = false; ok.textContent = 'Approve → PR banao'; }, 6000); return; }
      clearTimeout(timer); ok.disabled = true; ok.textContent = 'PR ban rahi hai…';
      var j = await api('/approve', 'POST', { id: p.id });
      if (!j.ok) { say(j.error, true); ok.disabled = false; ok.textContent = 'Approve → PR banao'; armed = false; return; }
      box.textContent = '';
      var d = el('div', 'margin:8px 0;padding:10px;border:1px solid rgba(111,220,140,.5);border-radius:12px');
      d.appendChild(el('div', 'font-size:13px;margin-bottom:6px', 'PR #' + j.pr.number + ' ban gayi (branch ' + j.pr.branch + '). Dekho aur khud merge karo.'));
      d.appendChild(btn('PR kholo', function () { openExternal(j.pr.url); })); box.appendChild(d);
      say('');
    }, 'flex:1;border-color:#6fdc8c');
    var no = btn('Reject', async function () { await api('/reject', 'POST', { id: p.id }); box.textContent = ''; say('Reject kar diya.'); });
    bar.appendChild(ok); bar.appendChild(no); c.appendChild(bar); box.appendChild(c);
  }

  async function load() {
    if (!$('rt-box') || needLogin()) return;
    var st = await api('/status');
    var s = $('rt-state'); if (!s) return;
    if (!st.ok) { say(st.error, true); return; }
    s.textContent = st.configured ? (st.owner ? '(' + st.repo + ')' : '') : '';
    if (!st.configured) say('GitHub set nahi hai: Render env me GITHUB_TOKEN aur GITHUB_REPO=owner/repo daalo (GET-STARTED / V52-NOTES).', true);
    else if (!st.owner) say('Ye sirf owner ke liye hai.', true);
    else say('');
  }

  function wire() {
    if (!$('rt-go') || $('rt-go').dataset.wired) return;
    $('rt-go').dataset.wired = '1';
    document.querySelectorAll('.list-row[data-open="claudecode"]').forEach(function (b) { b.addEventListener('click', load); });
    $('rt-go').addEventListener('click', async function () {
      if (needLogin()) return say('Pehle sign in karo.', true);
      var task = $('rt-task').value.trim();
      if (task.length < 8) return say('Task thoda detail me likho.', true);
      var b = $('rt-go'); b.disabled = true; b.textContent = 'Ava code padh rahi hai… (1-2 min)';
      $('rt-box').textContent = ''; say('');
      try {
        var j = await api('/propose', 'POST', { task: task });
        if (!j.ok) say(j.error, true); else { say('Proposal taiyaar: diff padho, phir Approve ya Reject.'); renderProposal(j.proposal); }
      } catch (e) { say('Network error, dobara try karo.', true); }
      b.disabled = false; b.textContent = 'Proposal banao';
    });
  }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
})();
