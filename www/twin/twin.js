/* Aureon Digital Twin panel: approvals, autonomy levels, continuity (dead-man switch), targets, log.
 * One self-contained file. No libraries. All text is inserted with textContent (never innerHTML), so
 * nothing coming from the server can inject markup.
 *
 * Use:
 *   <script src="twin/twin.js"></script>
 *   AureonTwin.init({ apiBase: 'https://aureone.onrender.com', getIdToken: () => firebase.auth().currentUser.getIdToken() });
 *   AureonTwin.open();            // from any button / menu item
 */
(function () {
  'use strict';
  if (window.AureonTwin) return;

  var cfg = { apiBase: '', getIdToken: null };
  var S = {
    open: false, tab: 'approvals', data: null, audit: [], loading: false, error: '', slow: false,
    timer: null, toastTimer: null, busy: {}, forms: { target: { feature: 'finance', action: 'pay_bill', summary: '', amount: '', payee: '', target: '', hours: '0' }, limits: {}, cont: null },
  };
  var root, body, tabsEl, chipsEl, badgeEls = [], freezeBtn, toastEl, onBadge = null;

  /* ---------- tiny DOM helper (textContent only) ---------- */
  function h(tag, props) {
    var el = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { add(el, k); }); return; }
    el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }

  /* ---------- formatting ---------- */
  function money(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
  function ago(ms) {
    if (!ms) return 'never';
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + ' min ago';
    var hh = Math.floor(m / 60); if (hh < 48) return hh + ' h ago';
    return Math.floor(hh / 24) + ' days ago';
  }
  function until(ms) {
    var s = Math.floor((ms - Date.now()) / 1000);
    if (s <= 0) return 'now';
    var m = Math.floor(s / 60); if (m < 60) return 'in ' + Math.max(1, m) + ' min';
    var hh = Math.floor(m / 60); if (hh < 48) return 'in ' + hh + ' h';
    return 'in ' + Math.floor(hh / 24) + ' days';
  }
  function listToArr(s) { return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  var EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

  /* ---------- API ---------- */
  function api(method, path, body) {
    if (!cfg.apiBase || typeof cfg.getIdToken !== 'function') return Promise.reject(new Error('AureonTwin.init({apiBase, getIdToken}) was not called'));
    return Promise.resolve(cfg.getIdToken()).then(function (token) {
      var ctl = new AbortController();
      var to = setTimeout(function () { ctl.abort(); }, 70000);
      return fetch(cfg.apiBase.replace(/\/$/, '') + path, {
        method: method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || 'HTTP ' + res.status);
          return data;
        });
      }).catch(function (e) {
        if (e && e.name === 'AbortError') throw new Error('Server did not answer in time (it may be waking up). Try again in a moment.');
        throw e;
      }).finally(function () { clearTimeout(to); });
    });
  }

  function toast(msg, kind) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'at-toast at-show ' + (kind === 'err' ? 'at-err' : 'at-okt');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { toastEl.className = 'at-toast'; }, kind === 'err' ? 6000 : 3000);
  }

  /* ---------- data ---------- */
  function load(opts) {
    var quiet = opts && opts.quiet;
    if (!quiet) { S.loading = true; S.error = ''; S.slow = false; render(); }
    var slowT = setTimeout(function () { if (S.loading) { S.slow = true; render(); } }, 5000);
    return api('GET', '/twin/overview').then(function (d) {
      S.data = d; S.loading = false; S.error = '';
      return S.tab === 'log' ? api('GET', '/twin/audit').then(function (a) { S.audit = a.items || []; }) : null;
    }).catch(function (e) {
      S.loading = false;
      if (!quiet || !S.data) S.error = e.message;
    }).finally(function () {
      clearTimeout(slowT);
      chrome();
      // Do not rebuild forms under the user's fingers on quiet refresh.
      if (!quiet || S.tab === 'approvals' || S.tab === 'log') render();
    });
  }
  function act(key, fn, okMsg) {
    if (S.busy[key]) return;
    S.busy[key] = true; render();
    return fn().then(function (r) { if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return load({ quiet: true }); })
      .catch(function (e) { toast(e.message, 'err'); })
      .finally(function () { delete S.busy[key]; render(); });
  }
  function pendingCount() { return S.data && S.data.pending ? S.data.pending.length : 0; }

  /* ---------- views ---------- */
  var FEATURE_LABEL = { finance: 'Money', deploy: 'Deploy', execution: 'Action' };
  var LEVEL_TXT = { 1: 'Suggest', 2: 'Approve', 3: 'Auto' };
  var LEVEL_HELP = {
    1: 'Aureon only tells you what it would do. Nothing runs.',
    2: 'Aureon prepares it and waits for your tap in Approvals.',
    3: 'Aureon does it by itself, but only inside your limits. Anything outside goes to Approvals.',
  };

  function empty(title, sub) { return h('div', { class: 'at-empty' }, h('div', { class: 'at-empty-t', text: title }), h('div', { class: 'at-sub', text: sub })); }
  function card() { var c = h('section', { class: 'at-card' }); for (var i = 0; i < arguments.length; i++) add(c, arguments[i]); return c; }
  function btn(label, cls, onclick, disabled) { return h('button', { class: 'at-btn ' + (cls || ''), type: 'button', onclick: onclick, disabled: disabled }, label); }
  function field(label, input, hint) { return h('label', { class: 'at-field' }, h('span', { class: 'at-lbl', text: label }), input, hint ? h('span', { class: 'at-hint', text: hint }) : null); }
  function input(type, value, onin, ph, extra) {
    var el = h('input', Object.assign({ class: 'at-in', type: type, value: value == null ? '' : value, placeholder: ph || '', autocomplete: 'off' }, extra || {}));
    el.addEventListener('input', function () { onin(el.value); });
    return el;
  }

  /* Approvals */
  function viewApprovals() {
    var d = S.data, items = d.pending || [];
    if (!items.length) return empty('Nothing waiting for you', 'When Aureon wants to do something sensitive (money, deploy), it shows up here for one-tap approval.');
    return items.map(function (it) {
      var simulated = it.feature === 'finance' && d.info && d.info.payments === 'simulated';
      var detail = [];
      if (it.amount != null) detail.push(money(it.amount));
      if (it.payee) detail.push('to ' + it.payee);
      if (it.target) detail.push('target ' + it.target);
      var b1 = 'ap:' + it.id, b2 = 'rj:' + it.id;
      return card(
        h('div', { class: 'at-row' }, h('span', { class: 'at-chip at-' + it.feature, text: FEATURE_LABEL[it.feature] || it.feature }), h('span', { class: 'at-sub', text: 'expires ' + until(it.expiresAt) })),
        h('div', { class: 'at-title', text: it.summary || it.action }),
        detail.length ? h('div', { class: 'at-big', text: detail.join('  ·  ') }) : null,
        h('div', { class: 'at-sub', text: 'Why it is waiting: ' + it.reason }),
        it.meta && it.meta.checks ? h('div', { class: 'at-sub', text: 'Checks: ' + it.meta.checks }) : null,
        simulated ? h('div', { class: 'at-note at-warn', text: 'Dry-run mode: approving will NOT move real money.' }) : null,
        h('div', { class: 'at-actions' },
          btn(S.busy[b2] ? 'Working…' : 'Reject', 'at-ghost', function () { act(b2, function () { return api('POST', '/twin/approvals/reject', { id: it.id }); }, 'Rejected'); }, !!(S.busy[b1] || S.busy[b2])),
          btn(S.busy[b1] ? 'Working…' : 'Approve', 'at-primary', function () { act(b1, function () { return api('POST', '/twin/approvals/approve', { id: it.id }); }, 'Approved and done'); }, !!(S.busy[b1] || S.busy[b2]))));
    });
  }

  /* Autonomy */
  function seg(feature, level) {
    var g = h('div', { class: 'at-seg', role: 'group', 'aria-label': FEATURE_LABEL[feature] + ' autonomy level' });
    [1, 2, 3].forEach(function (n) {
      g.appendChild(h('button', {
        class: 'at-segb' + (n === level ? ' at-on' : ''), type: 'button', 'aria-pressed': n === level ? 'true' : 'false',
        onclick: function () { if (n !== level) act('lv:' + feature, function () { return api('POST', '/twin/autonomy/level', { feature: feature, level: n }); }, FEATURE_LABEL[feature] + ': ' + LEVEL_TXT[n]); },
      }, LEVEL_TXT[n]));
    });
    return g;
  }
  function limitsForm(feature, a, info) {
    var L = a.limits[feature];
    var f = S.forms.limits[feature] || (S.forms.limits[feature] = {});
    function v(k, dflt) { return k in f ? f[k] : dflt; }
    var fields = [];
    if (feature === 'finance') {
      fields.push(field('Max per payment (₹)', input('number', v('perTxnCap', L.perTxnCap || ''), function (x) { f.perTxnCap = x; }, 'e.g. 500', { inputmode: 'decimal', min: 0 })));
      fields.push(field('Max per day (₹)', input('number', v('dailyCap', L.dailyCap || ''), function (x) { f.dailyCap = x; }, 'e.g. 1000', { inputmode: 'decimal', min: 0 })));
      fields.push(field('Allowed payees', input('text', v('allowedPayees', (L.allowedPayees || []).join(', ')), function (x) { f.allowedPayees = x; }, 'electricity, rent'), info.payees && info.payees.length ? 'Set up on server: ' + info.payees.join(', ') : 'No payees set up on the server yet (TWIN_PAYEES_JSON).'));
    } else if (feature === 'deploy') {
      fields.push(field('Allowed targets', input('text', v('allowedTargets', (L.allowedTargets || []).join(', ')), function (x) { f.allowedTargets = x; }, 'render-staging'), info.deployTargets && info.deployTargets.length ? 'Set up on server: ' + info.deployTargets.join(', ') : 'No deploy hooks set up on the server yet.'));
    } else {
      fields.push(field('Allowed actions', input('text', v('allowedActions', (L.allowedActions || []).join(', ')), function (x) { f.allowedActions = x; }, 'daily_report'), 'Only these may run on Auto.'));
      fields.push(field('Max runs per day', input('number', v('maxPerDay', L.maxPerDay || ''), function (x) { f.maxPerDay = x; }, '20', { inputmode: 'numeric', min: 1 })));
    }
    return h('details', { class: 'at-det', open: S.forms.limits[feature + '_open'] ? true : null, ontoggle: function (e) { S.forms.limits[feature + '_open'] = e.target.open; } },
      h('summary', { text: 'Limits' }), fields,
      btn(S.busy['lm:' + feature] ? 'Saving…' : 'Save limits', 'at-primary at-sm', function () {
        var out = {};
        if (feature === 'finance') { out.perTxnCap = Number(v('perTxnCap', L.perTxnCap)); out.dailyCap = Number(v('dailyCap', L.dailyCap)); out.allowedPayees = listToArr(v('allowedPayees', (L.allowedPayees || []).join(','))); }
        else if (feature === 'deploy') out.allowedTargets = listToArr(v('allowedTargets', (L.allowedTargets || []).join(',')));
        else { out.allowedActions = listToArr(v('allowedActions', (L.allowedActions || []).join(','))); out.maxPerDay = Number(v('maxPerDay', L.maxPerDay)); }
        act('lm:' + feature, function () { return api('POST', '/twin/autonomy/limits', { feature: feature, limits: out }); }, 'Limits saved');
      }, !!S.busy['lm:' + feature]));
  }
  function viewAutonomy() {
    var d = S.data, a = d.autonomy, info = d.info || {};
    var cards = ['finance', 'deploy', 'execution'].map(function (feature) {
      var level = a.levels[feature];
      var usage = null;
      if (feature === 'finance') usage = 'Spent today: ' + money(a.counters.spent) + (a.limits.finance.dailyCap ? ' of ' + money(a.limits.finance.dailyCap) : '');
      if (feature === 'execution') usage = 'Auto runs today: ' + a.counters.execs + (a.limits.execution.maxPerDay ? ' of ' + a.limits.execution.maxPerDay : '');
      var note = null;
      if (feature === 'finance' && info.payments === 'simulated') note = 'Payments are in dry-run mode: nothing real is sent until the server is switched to live.';
      if (feature === 'deploy') note = info.deployChecks === 'github' ? 'Auto-deploy also needs your GitHub checks to be green.' : 'GitHub checks are not set up, so deploys always wait for your approval.';
      return card(
        h('div', { class: 'at-row' }, h('div', { class: 'at-title', text: FEATURE_LABEL[feature] }), usage ? h('span', { class: 'at-sub', text: usage }) : null),
        seg(feature, level),
        h('div', { class: 'at-sub', text: LEVEL_HELP[level] }),
        note ? h('div', { class: 'at-note', text: note }) : null,
        limitsForm(feature, a, info));
    });
    var learning = a.levels.shadow !== 1, p = d.profile || {};
    var learnCard = card(
      h('div', { class: 'at-row' }, h('div', { class: 'at-title', text: 'Learning about you' }),
        h('button', { class: 'at-switch' + (learning ? ' at-on' : ''), type: 'button', role: 'switch', 'aria-checked': learning ? 'true' : 'false', 'aria-label': 'Learning', onclick: function () { act('shadow', function () { return api('POST', '/twin/autonomy/level', { feature: 'shadow', level: learning ? 1 : 3 }); }, learning ? 'Learning paused' : 'Learning on'); } }, h('span', { class: 'at-knob' }))),
      h('div', { class: 'at-sub', text: p.learned ? 'Style so far: ' + p.language + ', ' + p.verbosity + ' replies' + (p.topTopics && p.topTopics.length ? '. Topics: ' + p.topTopics.slice(0, 5).join(', ') : '') + '.' : 'Nothing learned yet.' }),
      h('div', { class: 'at-sub', text: 'Only counts are stored (never your messages or code), so it can be wiped any time.' }),
      btn('Forget everything it learned', 'at-ghost at-sm at-danger', function () { if (window.confirm('Delete everything Aureon learned about your style?')) act('forget', function () { return api('DELETE', '/twin/shadow'); }, 'Forgotten'); }, !!S.busy.forget));
    return cards.concat([learnCard]);
  }

  /* Continuity */
  function viewContinuity() {
    var c = S.data.continuity, info = S.data.info || {};
    if (!S.forms.cont) {
      S.forms.cont = {
        enabled: c.enabled, inactivityDays: c.inactivityDays, graceHours: c.graceHours,
        rows: (c.contacts.length ? c.contacts.map(function (x) { return { name: x.name, address: '', text: '' }; }) : [{ name: '', address: '', text: '' }]),
      };
    }
    var F = S.forms.cont;
    var status, cls = '';
    if (!c.enabled) status = 'Off';
    else if (c.state === 'final_warning') { status = 'FINAL WARNING sent. Check in now or your messages will go out.'; cls = 'at-bad'; }
    else if (c.state === 'triggered') { status = 'Triggered: your messages were sent.'; cls = 'at-bad'; }
    else status = 'Active. All good.';
    var top = card(
      h('div', { class: 'at-row' }, h('div', { class: 'at-title', text: 'Digital continuity' }), h('span', { class: 'at-chip ' + (c.enabled ? 'at-chip-ok' : ''), text: c.enabled ? 'ON' : 'OFF' })),
      h('div', { class: 'at-status ' + cls, text: status }),
      h('div', { class: 'at-sub', text: 'Last check-in: ' + ago(c.lastCheckIn) + (c.enabled ? '. Plan starts after ' + c.inactivityDays + ' days of silence, then ' + c.graceHours + ' h grace.' : '') }),
      h('div', { class: 'at-sub', text: 'Email: ' + (info.email && info.email !== 'none' ? info.email + ' connected' : 'not connected on the server yet. Messages cannot be sent until it is.') }),
      h('div', { class: 'at-actions' },
        btn(S.busy.checkin ? 'Working…' : "I'm here ✓", 'at-primary', function () { act('checkin', function () { return api('POST', '/twin/continuity/checkin'); }, 'Checked in'); }, !!S.busy.checkin),
        btn(S.busy.testmail ? 'Sending…' : 'Send me a test email', 'at-ghost', function () { act('testmail', function () { return api('POST', '/twin/test-email'); }, 'Test email sent to you'); }, !!S.busy.testmail)));

    var rows = F.rows.map(function (r, i) {
      return h('div', { class: 'at-contact' },
        h('div', { class: 'at-row' }, h('strong', { text: 'Contact ' + (i + 1) }), F.rows.length > 1 ? btn('Remove', 'at-ghost at-sm', function () { F.rows.splice(i, 1); render(); }) : null),
        field('Name', input('text', r.name, function (x) { r.name = x; }, 'Mom')),
        field('Email', input('email', r.address, function (x) { r.address = x; }, 'mom@example.com', { inputmode: 'email' })),
        field('Message to send', h('textarea', { class: 'at-in', rows: '3', placeholder: 'What should this person receive?', value: r.text, oninput: function (e) { r.text = e.target.value; } })));
    });
    var form = card(
      h('div', { class: 'at-title', text: 'Set up the plan' }),
      h('div', { class: 'at-sub', text: 'For your safety, saved addresses and messages are never shown back. Saving replaces the whole plan.' }),
      h('div', { class: 'at-row' }, h('span', { class: 'at-lbl', text: 'Turn on' }),
        h('button', { class: 'at-switch' + (F.enabled ? ' at-on' : ''), type: 'button', role: 'switch', 'aria-checked': F.enabled ? 'true' : 'false', 'aria-label': 'Turn on continuity', onclick: function () { F.enabled = !F.enabled; render(); } }, h('span', { class: 'at-knob' }))),
      field('Days without check-in before it starts', input('number', F.inactivityDays, function (x) { F.inactivityDays = x; }, '30', { inputmode: 'numeric', min: 7, max: 365 }), '7 to 365 days. You get warnings first.'),
      field('Grace period after the final warning (hours)', input('number', F.graceHours, function (x) { F.graceHours = x; }, '48', { inputmode: 'numeric', min: 24 }), 'At least 24 hours.'),
      rows,
      F.rows.length < 5 ? btn('+ Add contact', 'at-ghost at-sm', function () { F.rows.push({ name: '', address: '', text: '' }); render(); }) : null,
      h('div', { class: 'at-actions' },
        c.enabled ? btn('Turn off', 'at-ghost', function () { act('cdis', function () { return api('POST', '/twin/continuity/disable').then(function (r) { S.forms.cont = null; return r; }); }, 'Turned off'); }, !!S.busy.cdis) : null,
        btn(S.busy.csave ? 'Saving…' : 'Save plan', 'at-primary', saveContinuity, !!S.busy.csave)));
    return [top, form];
  }
  function saveContinuity() {
    var F = S.forms.cont, contacts = [], actions = [], seen = {};
    for (var i = 0; i < F.rows.length; i++) {
      var r = F.rows[i];
      if (!r.name.trim() && !r.address.trim() && !r.text.trim()) continue;
      if (!r.name.trim()) return toast('Contact ' + (i + 1) + ': name is required', 'err');
      if (!EMAIL_RE.test(r.address.trim())) return toast('Contact ' + (i + 1) + ': enter a valid email address', 'err');
      if (!r.text.trim()) return toast('Contact ' + (i + 1) + ': write the message to send', 'err');
      if (seen[r.name.trim()]) return toast('Two contacts have the same name', 'err');
      seen[r.name.trim()] = 1;
      contacts.push({ name: r.name.trim(), channel: 'email', address: r.address.trim() });
      actions.push({ type: 'message', to: r.name.trim(), text: r.text.trim() });
    }
    // Never let an empty form silently wipe an existing plan. Use "Turn off" to switch it off.
    if (!contacts.length) return toast('Add at least one contact first (use "Turn off" to switch the plan off)', 'err');
    act('csave', function () {
      return api('POST', '/twin/continuity', { enabled: !!F.enabled, inactivityDays: Number(F.inactivityDays), graceHours: Number(F.graceHours), contacts: contacts, actions: actions })
        .then(function (r) { S.forms.cont = null; return r; });
    }, 'Plan saved');
  }

  /* Targets + one-off requests */
  function viewTargets() {
    var d = S.data, info = d.info || {}, T = S.forms.target;
    var list = (d.targets || []).map(function (t) {
      var key = 'rt:' + t.id, it = t.intent || {};
      return h('div', { class: 'at-li' },
        h('div', {}, h('div', { class: 'at-li-t', text: t.name }),
          h('div', { class: 'at-sub', text: [FEATURE_LABEL[it.feature] || it.feature, it.amount != null ? money(it.amount) : null, 'every ' + Math.round(t.everyMs / 3600000 * 10) / 10 + ' h', 'next ' + until(t.nextRunAt), t.lastStatus ? 'last: ' + t.lastStatus.replace('_', ' ') : null].filter(Boolean).join(' · ') })),
        btn(S.busy[key] ? '…' : 'Remove', 'at-ghost at-sm', function () { if (window.confirm('Remove "' + t.name + '"?')) act(key, function () { return api('DELETE', '/twin/targets', { id: t.id }); }, 'Removed'); }, !!S.busy[key]));
    });
    var listCard = card(h('div', { class: 'at-title', text: 'Recurring targets' }), list.length ? list : h('div', { class: 'at-sub', text: 'None yet. Targets run in the background and still obey your autonomy levels.' }));

    function sel(name, opts, val, onch) {
      var s = h('select', { class: 'at-in' });
      opts.forEach(function (o) { s.appendChild(h('option', { value: o[0], text: o[1] })); });
      s.value = val; s.addEventListener('change', function () { onch(s.value); });
      return s;
    }
    var fields = [
      field('Type', sel('feature', [['finance', 'Pay a bill'], ['deploy', 'Deploy'], ['execution', 'Other action']], T.feature, function (x) {
        T.feature = x; T.action = x === 'finance' ? 'pay_bill' : x === 'deploy' ? 'deploy' : ''; render();
      })),
    ];
    if (T.feature === 'execution') fields.push(field('Action name', input('text', T.action, function (x) { T.action = x; }, 'daily_report')));
    fields.push(field('Description', input('text', T.summary, function (x) { T.summary = x; }, T.feature === 'finance' ? 'Electricity bill' : T.feature === 'deploy' ? 'Deploy backend' : 'What is this?')));
    if (T.feature === 'finance') {
      fields.push(field('Amount (₹)', input('number', T.amount, function (x) { T.amount = x; }, '500', { inputmode: 'decimal', min: 0 })));
      fields.push(info.payees && info.payees.length
        ? field('Payee', sel('payee', [['', 'Choose…']].concat(info.payees.map(function (p) { return [p, p]; })), T.payee, function (x) { T.payee = x; }))
        : field('Payee', input('text', T.payee, function (x) { T.payee = x; }, 'electricity'), 'No payees on the server yet, so this will be refused.'));
    }
    if (T.feature === 'deploy') {
      fields.push(info.deployTargets && info.deployTargets.length
        ? field('Target', sel('target', [['', 'Choose…']].concat(info.deployTargets.map(function (p) { return [p, p]; })), T.target, function (x) { T.target = x; }))
        : field('Target', input('text', T.target, function (x) { T.target = x; }, 'render-staging'), 'No deploy hooks on the server yet, so this will be refused.'));
    }
    var submitBtn;
    function submitLabel() { return S.busy.newreq ? 'Working…' : Number(T.hours) > 0 ? 'Add recurring target' : 'Send request'; }
    fields.push(field('Repeat every (hours)', input('number', T.hours, function (x) { T.hours = x; if (submitBtn) submitBtn.textContent = submitLabel(); }, '0', { inputmode: 'decimal', min: 0 }), '0 = just once, right now.'));
    submitBtn = btn(submitLabel(), 'at-primary', submitTarget, !!S.busy.newreq);
    var form = card(h('div', { class: 'at-title', text: 'New request' }), fields, submitBtn);
    return [form, listCard];
  }
  function submitTarget() {
    var T = S.forms.target, intent = { feature: T.feature, action: T.action.trim(), summary: T.summary.trim() };
    if (!intent.action) return toast('Action name is required', 'err');
    if (T.feature === 'finance') {
      var amt = Number(T.amount);
      if (!(amt > 0)) return toast('Enter an amount above 0', 'err');
      if (!T.payee.trim()) return toast('Choose a payee', 'err');
      intent.amount = amt; intent.payee = T.payee.trim();
    }
    if (T.feature === 'deploy') { if (!T.target.trim()) return toast('Choose a target', 'err'); intent.target = T.target.trim(); }
    var hours = Number(T.hours) || 0;
    act('newreq', function () {
      if (hours > 0) return api('POST', '/twin/targets', { name: intent.summary || intent.action, everyMs: hours * 3600000, intent: intent });
      return api('POST', '/twin/run', intent);
    }, function (r) {
      if (hours > 0) return 'Target added';
      var o = (r && r.outcome) || {};
      return o.status === 'pending_approval' ? 'Sent to Approvals' : o.status === 'executed' ? (o.simulated ? 'Done (simulated, nothing real happened)' : 'Done') : o.status === 'suggested' ? 'Suggestion only (level 1)' : o.status === 'denied' ? 'Denied: ' + o.reason : 'Failed: ' + (o.error || 'unknown');
    });
  }

  /* Log */
  function viewLog() {
    if (!S.audit.length) return empty('No activity yet', 'Every action, approval and warning is recorded here.');
    return card(S.audit.map(function (e) {
      return h('div', { class: 'at-li' }, h('div', {},
        h('div', { class: 'at-li-t' }, h('span', { class: 'at-chip at-t-' + e.type, text: String(e.type).replace('continuity_', '').replace('_', ' ') }), ' ', (e.feature || '') + (e.action ? ' · ' + e.action : '')),
        e.detail ? h('div', { class: 'at-sub', text: e.detail }) : null,
        h('div', { class: 'at-sub', text: ago(e.at) })));
    }));
  }

  /* ---------- shell ---------- */
  var TABS = [['approvals', 'Approvals'], ['autonomy', 'Autonomy'], ['continuity', 'Continuity'], ['targets', 'Targets'], ['log', 'Log']];
  function chrome() {
    if (!root) return;
    var d = S.data, n = pendingCount();
    badgeEls.forEach(function (b) { b.textContent = n ? String(n) : ''; b.style.display = n ? '' : 'none'; });
    if (typeof onBadge === 'function') try { onBadge(n); } catch (e) { /* ignore */ }
    var frozen = !!(d && d.autonomy && d.autonomy.frozen);
    freezeBtn.textContent = frozen ? 'FROZEN · tap to resume' : 'Freeze all';
    freezeBtn.className = 'at-freeze' + (frozen ? ' at-frozen' : '');
    chipsEl.textContent = '';
    if (d && d.info) {
      var i = d.info;
      chipsEl.appendChild(h('span', { class: 'at-chip ' + (i.payments === 'live' ? 'at-chip-ok' : 'at-chip-warn'), text: 'Payments: ' + (i.payments === 'live' ? 'LIVE' : 'simulated') }));
      chipsEl.appendChild(h('span', { class: 'at-chip ' + (i.deployTargets && i.deployTargets.length ? 'at-chip-ok' : ''), text: 'Deploy: ' + (i.deployTargets && i.deployTargets.length ? i.deployTargets.length + ' target(s)' : 'not set up') }));
      chipsEl.appendChild(h('span', { class: 'at-chip ' + (i.email && i.email !== 'none' ? 'at-chip-ok' : ''), text: 'Email: ' + (i.email && i.email !== 'none' ? i.email : 'not set up') }));
    }
  }
  function render() {
    if (!root || !S.open) return;
    // tabs
    tabsEl.textContent = '';
    badgeEls = [];
    TABS.forEach(function (t) {
      var b = h('button', { class: 'at-tab' + (S.tab === t[0] ? ' at-on' : ''), type: 'button', role: 'tab', 'aria-selected': S.tab === t[0] ? 'true' : 'false', onclick: function () { S.tab = t[0]; if (t[0] === 'log') load({ quiet: true }); render(); body.scrollTop = 0; } }, t[1]);
      if (t[0] === 'approvals') { var bd = h('span', { class: 'at-badge' }); badgeEls.push(bd); b.appendChild(bd); }
      tabsEl.appendChild(b);
    });
    chrome();
    // body
    var keep = body.scrollTop;
    body.textContent = '';
    if (S.error && !S.data) {
      body.appendChild(card(h('div', { class: 'at-title', text: 'Could not connect' }), h('div', { class: 'at-sub', text: S.error }), btn('Try again', 'at-primary', function () { load(); })));
    } else if (!S.data) {
      body.appendChild(card(h('div', { class: 'at-title', text: 'Connecting…' }), h('div', { class: 'at-sub', text: S.slow ? 'The server is waking up. This can take up to a minute on the free plan.' : 'One moment.' })));
    } else {
      var v = S.tab === 'approvals' ? viewApprovals() : S.tab === 'autonomy' ? viewAutonomy() : S.tab === 'continuity' ? viewContinuity() : S.tab === 'targets' ? viewTargets() : viewLog();
      add(body, v);
    }
    body.scrollTop = keep;
  }

  var CSS = [
    '#at-root{position:fixed;inset:0;z-index:99999;display:none;flex-direction:column;background:radial-gradient(120% 60% at 0% 0%,#2a1858 0%,#0a0d1f 45%,#070a16 100%);color:#e9ecff;font-family:Manrope,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}',
    '#at-root.at-open{display:flex}',
    '#at-root *{box-sizing:border-box}',
    '.at-head{display:flex;align-items:center;gap:10px;padding:calc(var(--safe-top,env(safe-area-inset-top,0px)) + 12px) 14px 8px}',
    '.at-x{background:none;border:1px solid rgba(140,150,255,.35);color:#cfd5ff;border-radius:12px;min-width:44px;height:44px;font-size:20px}',
    '.at-h1{font-size:19px;font-weight:700;flex:1;letter-spacing:.2px}',
    '.at-freeze{background:rgba(255,92,122,.12);border:1px solid rgba(255,92,122,.55);color:#ff8aa0;border-radius:12px;height:44px;padding:0 12px;font-weight:700;font-size:13px}',
    '.at-freeze.at-frozen{background:#ff5c7a;color:#16050a;box-shadow:0 0 18px rgba(255,92,122,.55)}',
    '.at-chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 8px}',
    '.at-chip{display:inline-block;font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;background:rgba(255,255,255,.07);border:1px solid rgba(140,150,255,.25);color:#b9c0ee;text-transform:none}',
    '.at-chip-ok{border-color:rgba(61,220,151,.6);color:#6ff0b8;background:rgba(61,220,151,.1)}',
    '.at-chip-warn{border-color:rgba(255,180,84,.6);color:#ffc779;background:rgba(255,180,84,.1)}',
    '.at-finance{border-color:rgba(56,225,245,.6);color:#7aeaf9}.at-deploy{border-color:rgba(139,92,246,.7);color:#c3a9ff}.at-execution{border-color:rgba(255,180,84,.6);color:#ffc779}',
    '.at-t-executed{border-color:rgba(61,220,151,.6);color:#6ff0b8}.at-t-failed,.at-t-denied,.at-t-rejected,.at-t-final_warning,.at-t-triggered{border-color:rgba(255,92,122,.6);color:#ff8aa0}.at-t-queued{border-color:rgba(255,180,84,.6);color:#ffc779}',
    '.at-tabs{display:flex;gap:6px;padding:4px 14px 10px;overflow-x:auto;scrollbar-width:none}.at-tabs::-webkit-scrollbar{display:none}',
    '.at-tab{flex:0 0 auto;min-height:44px;padding:0 14px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid rgba(140,150,255,.22);color:#aab2e6;font-weight:700;font-size:14px;position:relative}',
    '.at-tab.at-on{color:#fff;border-color:rgba(56,225,245,.8);background:linear-gradient(135deg,rgba(139,92,246,.45),rgba(56,225,245,.25));box-shadow:0 0 16px rgba(120,120,255,.35)}',
    '.at-badge{display:inline-block;min-width:18px;height:18px;line-height:18px;border-radius:9px;background:#ff5c7a;color:#16050a;font-size:11px;margin-left:6px;padding:0 5px}',
    '.at-body{flex:1;overflow-y:auto;padding:4px 14px calc(env(safe-area-inset-bottom,0px) + 24px);-webkit-overflow-scrolling:touch}',
    '.at-card{background:rgba(18,22,44,.82);border:1px solid rgba(110,130,255,.28);border-radius:16px;padding:14px;margin:0 0 12px;box-shadow:0 0 22px rgba(90,80,220,.12)}',
    '.at-card>*+*{margin-top:10px}',
    '.at-row{display:flex;align-items:center;justify-content:space-between;gap:10px}',
    '.at-title{font-weight:700;font-size:16px;line-height:1.3}.at-big{font-size:22px;font-weight:800;color:#7aeaf9}',
    '.at-sub{font-size:13px;color:#98a0d4;line-height:1.45}.at-lbl{font-size:13px;color:#b9c0ee;font-weight:600}.at-hint{font-size:12px;color:#7f87bd}',
    '.at-note{font-size:12.5px;padding:8px 10px;border-radius:10px;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.3);color:#cdbcff}',
    '.at-warn{background:rgba(255,180,84,.1);border-color:rgba(255,180,84,.45);color:#ffc779}',
    '.at-status{font-weight:700;color:#6ff0b8}.at-status.at-bad{color:#ff8aa0}',
    '.at-actions{display:flex;gap:10px}.at-actions .at-btn{flex:1}',
    '.at-btn{min-height:46px;padding:0 16px;border-radius:12px;font-weight:700;font-size:15px;border:1px solid rgba(140,150,255,.4);background:rgba(255,255,255,.06);color:#dfe3ff}',
    '.at-btn:disabled{opacity:.55}',
    '.at-primary{border:none;color:#0a0d1f;background:linear-gradient(135deg,#8b5cf6,#38e1f5);box-shadow:0 0 18px rgba(80,160,255,.4)}',
    '.at-ghost{background:rgba(255,255,255,.04)}.at-danger{color:#ff8aa0;border-color:rgba(255,92,122,.5)}.at-sm{min-height:40px;font-size:14px;padding:0 12px}',
    '.at-seg{display:flex;border-radius:12px;overflow:hidden;border:1px solid rgba(140,150,255,.35)}',
    '.at-segb{flex:1;min-height:46px;background:rgba(255,255,255,.04);border:none;color:#aab2e6;font-weight:700;font-size:15px}.at-segb+.at-segb{border-left:1px solid rgba(140,150,255,.25)}',
    '.at-segb.at-on{color:#0a0d1f;background:linear-gradient(135deg,#8b5cf6,#38e1f5)}',
    '.at-det{border-top:1px solid rgba(140,150,255,.18);padding-top:8px}.at-det summary{min-height:40px;display:flex;align-items:center;font-weight:700;color:#b9c0ee;cursor:pointer}.at-det>*+*{margin-top:10px}',
    '.at-field{display:flex;flex-direction:column;gap:5px}',
    '.at-in{width:100%;min-height:46px;padding:10px 12px;border-radius:12px;border:1px solid rgba(140,150,255,.35);background:rgba(8,10,24,.8);color:#eef0ff;font:inherit;font-size:16px}',
    '.at-in:focus{outline:none;border-color:#38e1f5;box-shadow:0 0 12px rgba(56,225,245,.4)}',
    'textarea.at-in{resize:vertical}',
    '.at-contact{border:1px dashed rgba(140,150,255,.3);border-radius:12px;padding:10px}.at-contact>*+*{margin-top:10px}',
    '.at-switch{width:52px;height:30px;border-radius:15px;border:1px solid rgba(140,150,255,.4);background:rgba(255,255,255,.08);position:relative;flex:0 0 auto;padding:0}',
    '.at-knob{position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#aab2e6;transition:transform .15s}',
    '.at-switch.at-on{background:linear-gradient(135deg,#8b5cf6,#38e1f5)}.at-switch.at-on .at-knob{transform:translateX(22px);background:#fff}',
    '.at-li{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid rgba(140,150,255,.14)}.at-li:first-of-type{border-top:none}.at-li-t{font-weight:700;font-size:14px;word-break:break-word}',
    '.at-empty{text-align:center;padding:48px 24px}.at-empty-t{font-size:17px;font-weight:700;margin-bottom:6px}',
    '.at-toast{position:fixed;left:14px;right:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);padding:12px 14px;border-radius:12px;font-weight:600;font-size:14px;opacity:0;pointer-events:none;transform:translateY(10px);transition:all .2s;z-index:100000}',
    '.at-toast.at-show{opacity:1;transform:none}.at-okt{background:#12324a;border:1px solid #38e1f5;color:#d6f8ff}.at-err{background:#3a1220;border:1px solid #ff5c7a;color:#ffd3dc}',
    '@media (prefers-reduced-motion:reduce){.at-knob,.at-toast{transition:none}}',
  ].join('\n');

  function build() {
    if (root) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    freezeBtn = h('button', { class: 'at-freeze', type: 'button', onclick: function () {
      var frozen = !!(S.data && S.data.autonomy && S.data.autonomy.frozen);
      act('freeze', function () { return api('POST', '/twin/freeze', { frozen: !frozen }); }, frozen ? 'Resumed' : 'Frozen: nothing will run until you resume');
    } }, 'Freeze all');
    chipsEl = h('div', { class: 'at-chips' });
    tabsEl = h('div', { class: 'at-tabs', role: 'tablist' });
    body = h('div', { class: 'at-body' });
    toastEl = h('div', { class: 'at-toast', role: 'status', 'aria-live': 'polite' });
    root = h('div', { id: 'at-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Digital Twin' },
      h('div', { class: 'at-head' }, h('button', { class: 'at-x', type: 'button', 'aria-label': 'Close', onclick: close }, '‹'), h('div', { class: 'at-h1', text: 'Digital Twin' }), freezeBtn),
      chipsEl, tabsEl, body, toastEl);
    document.body.appendChild(root);
  }

  function open() {
    build();
    S.open = true; root.className = 'at-open';
    render(); load();
    clearInterval(S.timer);
    S.timer = setInterval(function () { if (!document.hidden) load({ quiet: true }); }, 15000);
  }
  function close() {
    S.open = false; if (root) root.className = ''; clearInterval(S.timer);
  }
  function init(o) {
    cfg.apiBase = (o && o.apiBase) || cfg.apiBase;
    if (o && typeof o.getIdToken === 'function') cfg.getIdToken = o.getIdToken;
    if (o && typeof o.onBadge === 'function') onBadge = o.onBadge;
  }

  window.AureonTwin = { init: init, open: open, close: close, pending: pendingCount, refresh: function () { return load({ quiet: true }); } };
})();
