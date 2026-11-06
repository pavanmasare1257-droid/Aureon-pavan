// backend/ava-self.js — Ava Lab: Ava apne code ko khud padhti hai, khud upgrade likhti hai,
// aur Sentinel dashboard me dikhati hai ki KYA badla aur KYUN.
//
// Safety (ye jaan-bujh kar hai):
//  * Ava sirf PROPOSAL likhti hai. Disk par kuch bhi sirf tumhare Approve click ke baad likha jaata hai
//    (dash-auth login + agar on ho to fresh 2FA code).
//  * Sirf Ava ki apni files edit ho sakti hain (EDITABLE neeche). Security / dash-auth / Sentinel / server.js /
//    is file (ava-self.js) ko Ava chhu nahi sakti — apne guardrails khud nahi badal sakti.
//  * Har change: exact-match edits, JS syntax check, size/lines limit, khatarnak patterns (eval, child_process ...)
//    block, safety-words (ownerOnly, redact ...) hat jaaye to reject. Approve se pehle file dobara padhi jaati hai.
//  * Har approve ka backup + Rollback button + history (kya badla, kyun, risk, diff, patch download).
//  * Ye honest hai: Ava "khud ko conscious/free" nahi banati — wo code ka draft likhti hai, tum faisla karte ho.
const fs = require('fs');
const { UI_SKILL } = require('./design-skill');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EDITABLE = ['backend/ava.js', 'backend/ava-mind.js', 'backend/ava-extra.js', 'backend/public/ava-bot.js', 'www/ava-bot.js'];
const MIRRORS = { 'www/ava-bot.js': 'backend/public/ava-bot.js', 'backend/public/ava-bot.js': 'www/ava-bot.js' }; // same widget, two copies
const SAFETY_WORDS = ['ownerOnly', 'avaIsOwner', 'sameCode', 'limited(', 'redact(', 'consent'];
const BLOCKED_ADDED = /(child_process|\beval\s*\(|new\s+Function\s*\(|process\.exit|execSync|spawnSync|\.writeFileSync\s*\(\s*['"`]\/|rm\s+-rf|SENTINEL_OWNER_CODE|SECURITY_|DASH_)/;
// Ava's keys: ONLY Gemini + Groq (the brains she already uses). Nothing else from the environment ever reaches the sandbox.
const KEY_RE = /^(GEMINI|GROQ)_API_KEY(S|_\d)?$/;
const allowedKeys = () => { const o = {}; for (const k of Object.keys(process.env)) if (KEY_RE.test(k) && process.env[k]) o[k] = process.env[k]; return o; };
const ALLOWED_HOSTS = /^https?:\/\/(generativelanguage\.googleapis\.com|api\.groq\.com|aureone\.onrender\.com|localhost|127\.0\.0\.1)/;
const MAX_CHANGED_LINES = 320;
const MAX_FILE_SHOWN = 70000;
const HISTORY_MAX = 40;
// ---- Ava's Jail: pure creative sandbox. Ava designs standalone UI/widget
// variants here — generate -> sandbox syntax check -> save to a capped
// gallery. NOTHING here ever touches a real file, commits to GitHub, or
// goes live. The owner reviews the gallery and downloads code by hand if
// they want to use/test a variant themselves, outside this system.
const JAIL_CAP = 12;         // oldest entries drop beyond this
const JAIL_KEEP_CODE = 3;    // only the newest few keep their full code across a cold restart
const JAIL_MAX_PER_HOUR = 8; // separate budget from the real /improve pipeline
const gate = require('./ava-jail-gate'); // v17: quality gate + prompts live outside Ava's EDITABLE list on purpose

module.exports = function createAvaSelf({ lib, auth, store, DATA_DIR, callLLM, logEvent }) {
  const express = require('express');
  const router = express.Router();
  const FILE = path.join(DATA_DIR, 'ava-self.json');
  const BK_DIR = path.join(DATA_DIR, 'ava-self-backups');
  try { fs.mkdirSync(BK_DIR, { recursive: true }); } catch (e) { /* read-only disk: backups stay in memory/history */ }

  let state = { proposals: [], history: [], jail: [], version: 0, settings: { auto: false, hours: 6, autoApply: false, jailAuto: false, jailHours: 6 }, lastAuto: 0, lastJailAuto: 0 };
  let busy = false;
  const calls = [];
  const ready = (async () => {
    try {
      await store.whenFirestore(20000);
      const r = await store.load('ava_self', FILE);
      if (r && r.value && Array.isArray(r.value.proposals)) state = Object.assign(state, r.value, { settings: Object.assign({ auto: false, hours: 6, autoApply: false, jailAuto: false, jailHours: 6 }, r.value.settings || {}) });
    } catch (e) { console.error('[ava-self] load failed:', e.message); }
  })();
  const save = () => ready.then(() => store.save('ava_self', slim(), FILE)).catch((e) => console.error('[ava-self] save failed:', e.message));
  function slim() { // Firestore doc <1 MiB: decided proposals drop their file bodies, only the newest history keeps a backup copy
    return {
      version: state.version, settings: state.settings, lastAuto: state.lastAuto,
      proposals: state.proposals.slice(-30).map((p) => (p.status === 'pending' ? p : (({ oldContent, newContent, ...r }) => r)(p))),
      history: state.history.slice(0, HISTORY_MAX).map((h, i) => (i < 4 ? h : (({ backups, newContents, ...r }) => r)(h))),
      jail: (state.jail || []).slice(0, JAIL_CAP).map((j, i) => (i < JAIL_KEEP_CODE ? j : (({ code, ...r }) => r)(j))),
    };
  }

  // ---- safe location: a SPECIAL GitHub branch for Ava (default "ava-lab"), created automatically from main.
  // Approved upgrades are committed there, never straight to main, so Render does not deploy them until YOU merge
  // (Ava Lab has a "merge to main" button, or merge the pull request yourself). Needs: AVA_GITHUB_REPO=owner/repo and
  // GITHUB_TOKEN (Contents: read+write). Optional: AVA_GITHUB_BRANCH (default ava-lab), AVA_GITHUB_BASE (default main).
  const gh = () => ({ repo: process.env.AVA_GITHUB_REPO || process.env.GITHUB_REPO || '', branch: process.env.AVA_GITHUB_BRANCH || 'ava-lab', base: process.env.AVA_GITHUB_BASE || 'main', token: process.env.GITHUB_TOKEN || '' });
  const ghReady = () => { const g = gh(); return !!(g.repo && g.token) && g.branch !== g.base; };
  async function ghApi(pathSuffix, opts) { // the token only ever goes to api.github.com, and never into an error message
    const g = gh(); if (!g.repo || !g.token) throw new Error('GitHub set nahi hai (Render env: AVA_GITHUB_REPO=owner/repo + GITHUB_TOKEN)');
    const r = await fetch('https://api.github.com/repos/' + g.repo + pathSuffix, Object.assign({ signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined }, opts, { headers: { Authorization: 'Bearer ' + g.token, Accept: 'application/vnd.github+json', 'User-Agent': 'aureon-ava-lab', 'Content-Type': 'application/json' } }));
    const d = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, d };
  }
  let branchOk = '';
  async function ensureBranch() { // create "ava-lab" from main once
    const g = gh(); if (branchOk === g.repo + '#' + g.branch) return;
    if (g.branch === g.base) throw new Error('Ava ki branch main nahi ho sakti (AVA_GITHUB_BRANCH badlo)');
    const ex = await ghApi('/git/ref/heads/' + encodeURIComponent(g.branch));
    if (!ex.ok) {
      if (ex.status !== 404) throw new Error('GitHub branch check ' + ex.status);
      const base = await ghApi('/git/ref/heads/' + encodeURIComponent(g.base));
      if (!base.ok) throw new Error('GitHub base branch "' + g.base + '" nahi mili (' + base.status + ')');
      const mk = await ghApi('/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + g.branch, sha: base.d.object.sha }) });
      if (!mk.ok) throw new Error('GitHub branch "' + g.branch + '" ban nahi payi: ' + mk.status + ' ' + String(mk.d.message || '').slice(0, 100));
    }
    branchOk = g.repo + '#' + g.branch;
  }
  async function ghCommit(rel, content, message) {
    await ensureBranch(); const g = gh();
    const path = '/contents/' + rel.split('/').map(encodeURIComponent).join('/');
    const cur = await ghApi(path + '?ref=' + encodeURIComponent(g.branch));
    if (!cur.ok && cur.status !== 404) throw new Error('GitHub read ' + cur.status);
    const put = await ghApi(path, { method: 'PUT', body: JSON.stringify({ message, content: Buffer.from(content, 'utf8').toString('base64'), branch: g.branch, sha: cur.ok ? cur.d.sha : undefined }) });
    if (!put.ok) throw new Error('GitHub ' + put.status + ': ' + String(put.d.message || '').slice(0, 120));
    return { file: rel, branch: g.branch, sha: put.d.commit && put.d.commit.sha, url: put.d.commit && put.d.commit.html_url };
  }
  async function ghCommitAll(map, message) { const out = []; for (const [rel, content] of Object.entries(map)) out.push(await ghCommit(rel, content, message)); return out; }
  async function commitEntry(h) { // push this upgrade's NEW code to GitHub
    try {
      const nc = h.newContents; if (!nc) throw new Error('code history me nahi bacha');
      const c = await ghCommitAll(nc, 'Ava Lab: Ava v' + h.version + ' — ' + h.title);
      h.github = { ok: true, branch: gh().branch, at: new Date().toISOString(), commits: c };
    } catch (e) { h.github = { ok: false, at: new Date().toISOString(), error: e.message }; }
    save(); return h.github;
  }
  async function revertOnGithub(h, restored) { // keep the repo in step when an already-committed upgrade is rolled back
    if (!(h.github && h.github.ok)) return null;
    try { const c = await ghCommitAll(restored, 'Ava Lab: rollback Ava v' + h.version + ' — ' + h.title); h.github = { ok: true, branch: gh().branch, reverted: true, at: new Date().toISOString(), commits: c }; }
    catch (e) { h.github = { ok: false, reverted: false, at: new Date().toISOString(), error: 'rollback GitHub par nahi gaya: ' + e.message }; }
    save(); return h.github;
  }

  const nid = () => crypto.randomBytes(6).toString('hex');
  const abs = (rel) => path.join(ROOT, rel);
  const existing = () => EDITABLE.filter((f) => fs.existsSync(abs(f)));
  const read = (rel) => fs.readFileSync(abs(rel), 'utf8');

  // ---- how Ava thinks: her own LLM if ava.js exposed it, else Sentinel's
  async function askJSON(prompt) {
    const hook = global.__avaSelf;
    if (hook && typeof hook.llm === 'function') {
      let txt;
      try { txt = await hook.llm(prompt); }
      catch (e) { if (!process.env.GROQ_API_KEY) throw e; return callLLM(prompt); } // Gemini quota -> Sentinel's Groq
      const raw = String(txt || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
      try { return JSON.parse(raw); } catch (e) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ } } return null; }
    }
    return callLLM(prompt);
  }
  const signals = () => { try { return (global.__avaSelf && global.__avaSelf.signals && global.__avaSelf.signals()) || {}; } catch (e) { return {}; } };

  function outline(rel) {
    const src = read(rel); const out = [];
    src.split('\n').forEach((l, i) => { if (/^\s{0,4}(async\s+function|function|const\s+\w+\s*=\s*(async\s*)?\(|router\.(get|post|delete)\(|\/\/ -{4,})/.test(l) && out.length < 70) out.push((i + 1) + ': ' + l.trim().slice(0, 110)); });
    return { size: src.length, lines: out.join('\n') };
  }

  function countWord(s, w) { return s.split(w).length - 1; }
  function checkSafety(rel, oldC, newC, stats) {
    const added = stats.addedText;
    if (BLOCKED_ADDED.test(added)) return 'khatarnak pattern mila (eval / child_process / secrets) — block';
    if (/\.js$/.test(rel)) { // backend code: no reading of other secrets, no sending anything to a new host
      const envUse = added.match(/process\.env(\.[A-Z_0-9]+|\[[^\]]*\])?/g) || [];
      for (const u of envUse) if (u === 'process.env' || /\[/.test(u) || !(KEY_RE.test(u.slice(12)) || /^AVA_[A-Z_]+$/.test(u.slice(12)))) return 'sirf Gemini/Groq keys (aur AVA_* settings) padh sakti hai — ' + u + ' block';
      const urls = added.match(/https?:\/\/[^\s'"`)]+/g) || [];
      for (const u of urls) if (!ALLOWED_HOSTS.test(u)) return 'naya outside URL block (data bahar bhejne ka risk): ' + u.slice(0, 60);
    }
    for (const w of SAFETY_WORDS) if (countWord(newC, w) < countWord(oldC, w)) return 'safety check "' + w + '" hat raha tha — block';
    if (stats.added + stats.removed > MAX_CHANGED_LINES) return 'change bahut bada (' + (stats.added + stats.removed) + ' lines) — chhota upgrade chahiye';
    return null;
  }

  // ---- sandbox: run the changed file in a throw-away copy, with NO secrets in its environment
  function sandbox(rel, newContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avasbx-'));
    try {
      if (!/\.js$/.test(rel)) return { ok: true, log: 'skip (not js)' };
      const tgt = path.join(dir, rel); fs.mkdirSync(path.dirname(tgt), { recursive: true }); fs.writeFileSync(tgt, newContent);
      if (/ava-bot\.js$/.test(rel)) { // browser widget: must at least parse
        const r = spawnSync(process.execPath, ['--check', tgt], { encoding: 'utf8', timeout: 8000, env: { PATH: process.env.PATH } });
        return { ok: r.status === 0, log: r.status === 0 ? 'syntax ok (widget)' : String(r.stderr).slice(0, 300) };
      }
      const bdir = path.join(dir, 'backend'); fs.mkdirSync(bdir, { recursive: true });
      for (const f of fs.readdirSync(__dirname)) if (/\.js$/.test(f) && !f.endsWith('.bak')) fs.copyFileSync(path.join(__dirname, f), path.join(bdir, f));
      fs.writeFileSync(path.join(bdir, path.basename(rel)), newContent);
      try { fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(bdir, 'node_modules'), 'dir'); } catch (e) { /* none */ }
      const code = "const m=require('./" + path.basename(rel) + "');if(typeof m!=='function'&&typeof m!=='object')throw new Error('export weird: '+typeof m);console.log('load ok, export='+typeof m)";
      const r = spawnSync(process.execPath, ['-e', code], { cwd: bdir, encoding: 'utf8', timeout: 12000, env: Object.assign({ PATH: process.env.PATH, NODE_ENV: 'test', AVA_SANDBOX: '1' }, allowedKeys()) });
      return { ok: r.status === 0, log: (r.status === 0 ? String(r.stdout).trim() : String(r.stderr || r.error || 'failed').split('\n').slice(0, 4).join(' ')).slice(0, 300) };
    } catch (e) { return { ok: false, log: String(e.message).slice(0, 200) }; }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* tmp */ } }
  }

  function buildProposal(rel, idea, edits) {
    const oldC = read(rel);
    const ap = lib.applyEdits(oldC, edits);
    if (!ap.ok) return { error: 'edit lagi nahi: ' + ap.error };
    const bad = lib.validateNew(rel, oldC, ap.content);
    if (bad) return { error: bad };
    const d = lib.makeDiff(oldC, ap.content, { maxRows: 500 });
    const addedText = edits.map((e) => e.replace).join('\n');
    const sf = checkSafety(rel, oldC, ap.content, { added: d.added, removed: d.removed, addedText });
    if (sf) return { error: sf };
    const sb = sandbox(rel, ap.content);
    if (!sb.ok) return { error: 'sandbox test fail: ' + sb.log };
    return {
      p: {
        id: nid(), createdAt: new Date().toISOString(), status: 'pending',
        file: rel, title: String(idea.title || 'Upgrade').slice(0, 90),
        what: String(idea.what_changed || idea.what || '').slice(0, 600), why: String(idea.why || '').slice(0, 500),
        risk: ['low', 'medium', 'high'].includes(String(idea.risk)) ? idea.risk : 'medium',
        test: String(idea.test_hint || '').slice(0, 300), goal: String(idea.goal || '').slice(0, 200),
        sandbox: sb, auto: false, oldContent: oldC, newContent: ap.content, diff: d.hunks, stats: { added: d.added, removed: d.removed, truncated: d.truncated },
      },
    };
  }

  // ---- Ava improves herself: pick a file/idea, then write exact edits
  async function improve(goal, auto) {
    const files = existing();
    if (!files.length) throw new Error('Ava ki files nahi mili (ROOT=' + ROOT + ')');
    const hist = state.history.concat(state.proposals.filter((p) => p.status !== 'pending')).slice(0, 12)
      .map((h) => `- [${h.status}] ${h.file}: ${h.title}`).join('\n') || '(abhi koi)';
    const sig = JSON.stringify(signals()).slice(0, 1500);
    const outlines = files.map((f) => { const o = outline(f); return `### ${f} (${o.size} chars)\n${o.lines}`; }).join('\n\n');
    const who = `You are Ava, an AI assistant that lives in the Aureon app and Sentinel. You are reviewing YOUR OWN source code to make yourself better. You only DRAFT code; the owner reviews and approves every change.`;
    const g = goal ? `Owner's goal for this upgrade: ${goal}` : 'No specific goal: find the single most valuable, SAFE improvement (a real bug, missing error handling, a clearer reply, a performance fix, a small useful feature).';

    const pick = await askJSON(`${who}\n${g}\nYour recent upgrade history (do not repeat rejected ideas):\n${hist}\nYour live signals (JSON, may be empty): ${sig}\nOutline of the files you may edit:\n${outlines}\n\nChoose ONE file and ONE small improvement. Never touch security/auth/owner checks. Return ONLY JSON: {"file":"<one of the listed paths>","idea":"what you will change, one sentence"} — or {"file":null,"idea":"nothing worth changing"} if you honestly find nothing.`);
    if (!pick || !pick.file) return { none: true, say: (pick && pick.idea) || 'Ava ko abhi koi upgrade zaroori nahi laga.' };
    const rel = String(pick.file); if (!files.includes(rel)) throw new Error('Ava ne galat file chuni: ' + rel);
    const src = read(rel);

    const w = await askJSON(`${who}\nYou decided to: ${pick.idea}\n${g}\nHere is the COMPLETE current content of ${rel}:\n<<<FILE\n${src.slice(0, MAX_FILE_SHOWN)}\nFILE>>>\n\nWrite the upgrade as 1-5 exact edits. "find" must be copied EXACTLY (whitespace included) from the file and appear exactly ONCE; "replace" is the new code. Write it like a staff engineer: clear naming, input validation, defensive error handling, JSDoc on new functions, no dead code, no stubs/TODOs — production quality, but keep each edit focused and keep the file's style, do not remove safety checks (ownerOnly, avaIsOwner, sameCode, limited(, redact(, consent), no eval/child_process/process.exit. Return ONLY JSON: {"title":"short title","what_changed":"plain Hinglish: kya badla, 1-3 sentences","why":"plain Hinglish: kyun zaroori tha","risk":"low|medium|high","test_hint":"how the owner can check it works","edits":[{"find":"...","replace":"..."}]}`);
    if (!w || !Array.isArray(w.edits)) throw new Error('Ava ne valid edits nahi diye — dobara try karo');
    w.goal = goal || pick.idea;
    const r = buildProposal(rel, w, w.edits);
    if (r.error) throw new Error('Upgrade reject (safety/validation): ' + r.error);
    r.p.auto = !!auto;
    state.proposals.push(r.p); save();
    if (logEvent) logEvent('proposal', { name: 'Ava' }, 'Ava ka upgrade proposal: ' + r.p.title);
    if (auto && state.settings.autoApply && r.p.risk === 'low' && /ava-bot\.js$/.test(r.p.file) && r.p.stats.added + r.p.stats.removed <= 40) {
      const ar = applyProposal(r.p, true); // low-risk widget-only changes may go live by themselves; everything else waits for you
      if (ar.ok) return { proposal: pubP(r.p), autoApplied: true };
    }
    return { proposal: pubP(r.p) };
  }

  // ---- Jail: Ava designs a standalone, experimental widget-UI variant.
  // Pure creative output — read-only reference to the real widget for
  // inspiration, same safety checks (sandbox + checkSafety) as the real
  // pipeline, but the result only ever lands in a capped gallery list.
  const jailCalls = [];
  const JAIL_CATEGORIES = { ui: '🎨', security: '🛡️', utility: '🔧', game: '🎮', other: '🧩' };
  const jailQueue = []; // [{id, brief, queuedAt, attempts}] — a rate-limit never kills a job, it is only retried (from ava-jail-update-v3)
  const JAIL_MAX_QUEUE_AGE_MS = 6 * 3600000; // safety valve: stop retrying one job after 6h
  let jailRunning = false;
  function looksLikeRateLimit(msg) {
    const t = String(msg || '').toLowerCase();
    return t.includes('quota') || t.includes('rate limit') || t.includes('429') || t.includes('resource_exhausted') || t.includes('too many requests') || t.includes('overloaded');
  }
  async function jailGenerateCore(brief) {
    const refFile = EDITABLE.find((f) => /ava-bot\.js$/.test(f));
    const ref = refFile && fs.existsSync(abs(refFile)) ? read(refFile).slice(0, 4000) : '';
    // v17: up to 3 model calls (draft + 2 repair rounds). Raw text via Ava's own LLM; Sentinel's Groq (JSON-only) as fallback.
    const ask = async (prompt) => {
      const hook = global.__avaSelf;
      if (hook && typeof hook.llm === 'function') return String(await hook.llm(prompt) || '');
      const j = await callLLM(prompt + '\n\nReturn ONLY JSON: {"raw":"<your complete answer in the exact format above>"}');
      return String((j && (j.raw || j.code)) || '');
    };
    const safety = (code) => checkSafety('www/ava-bot.js', '', code, { added: code.split('\n').length, removed: 0, addedText: code });
    let out;
    try { out = await gate.produceVariant({ ask, brief, ref, safety }); }
    catch (e) { throw new Error(e.message); }
    const { meta, code, gate: g, test, rounds } = out;
    const entry = {
      id: nid(), createdAt: new Date().toISOString(),
      title: String(meta.title || 'Untitled variant').slice(0, 90),
      category: JAIL_CATEGORIES[meta.category] ? meta.category : 'other',
      description: String((meta.description || '') + (meta.limits ? ' | Limits: ' + meta.limits : '')).slice(0, 500),
      brief: String(brief || '').slice(0, 200),
      sandbox: { ok: true, log: 'quality gate ok (' + g.metrics.lines + ' lines, ' + g.metrics.functions + ' fns) | ' + test.log + ' | rounds: ' + rounds },
      code,
    };
    state.jail = [entry, ...(state.jail || [])].slice(0, JAIL_CAP);
    save();
    if (logEvent) logEvent('proposal', { name: 'Ava' }, 'Ava Jail: naya variant "' + entry.title + '" (gate pass, sirf gallery me, kahin apply nahi hua)');
    const { code: _omit, ...pub } = entry;
    return pub;
  }

  const pubP = (p) => { const { oldContent, newContent, ...r } = p; return r; };
  const hashOf = (c) => crypto.createHash('sha256').update(c).digest('hex');
  const isLive = (h) => { try { return (h.files || [h.file]).every((t) => hashOf(read(t)) === h.newHash); } catch (e) { return false; } };
  const pubH = (h) => { const { backups, newContents, ...r } = h; r.live = h.status === 'applied' ? isLive(h) : null; r.canReapply = !!newContents && !!backups; return r; };

  // ---- routes (mounted under /api/sentinel/ava, behind the dashboard lock)
  router.get('/state', async (req, res) => {
    await ready;
    const hook = global.__avaSelf;
    res.json({
      files: existing(), protected: 'security/*, dash-auth, Sentinel, server.js aur ava-self.js Ava ke liye locked hain',
      github: { configured: ghReady(), repo: gh().repo || null, branch: gh().branch, base: gh().base, compare: gh().repo ? 'https://github.com/' + gh().repo + '/compare/' + gh().base + '...' + gh().branch + '?expand=1' : null },
      keys: Object.keys(allowedKeys()).map((k) => k.replace(/_\d$/, '_N')).filter((v, i, a) => a.indexOf(v) === i),
      version: Math.max(0, ...state.history.filter((h) => h.status === 'applied').map((h) => h.version || 0)), latest: state.version, settings: state.settings, lastAuto: state.lastAuto,
      jailPending: jailQueue.length, jailInfo: { running: jailRunning, retryEveryMin: 10, jobs: jailQueue.slice(0, 5).map((j) => ({ brief: String(j.brief || '').slice(0, 80), attempts: j.attempts || 0, queuedAt: j.queuedAt, lastTry: j.lastTry || 0, lastError: j.lastError || '' })) }, busy, llm: hook && hook.llm ? 'ava' : (process.env.GROQ_API_KEY ? 'groq' : 'none'), signals: signals(),
      proposals: state.proposals.slice(-20).reverse().map(pubP), history: state.history.map(pubH),
    });
  });

  // Ava Lab brain: Ava's memories / fears / thoughts as neurons (read-only, text only).
  router.get('/brain', (req, res) => {
    try {
      const hook = global.__avaSelf;
      res.json(hook && typeof hook.brain === 'function' ? hook.brain() : { counts: [0, 0, 0, 0, 0, 0, 0], total: 0, items: [], at: Date.now() });
    } catch (e) { res.status(500).json({ error: 'brain data nahi bana' }); }
  });

  router.post('/improve', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab improve');
    await ready;
    if (busy) return res.status(409).json({ error: 'Ava abhi ek upgrade likh rahi hai' });
    const now = Date.now(); while (calls.length && now - calls[0] > 3600000) calls.shift();
    if (calls.length >= 6) return res.status(429).json({ error: 'Ghante me 6 upgrade-tries ki limit' });
    if (state.proposals.filter((p) => p.status === 'pending').length >= 5) return res.status(400).json({ error: 'Pehle pending proposals Approve/Reject karo (max 5)' });
    const hook = global.__avaSelf;
    if (!(hook && hook.llm) && !process.env.GROQ_API_KEY) return res.status(503).json({ error: 'Ava ka AI (Gemini) ya GROQ_API_KEY set nahi hai' });
    calls.push(now); busy = true;
    try { res.json({ ok: true, ...(await improve(String((req.body && req.body.goal) || '').slice(0, 300), false)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
    finally { busy = false; }
  });

  // ---- Ava Designer: Ava designs a TOP-LEVEL UI screen entirely by herself (own choice of screen + style when no brief).
  // Pass 1 = draft, pass 2 = art-director self-critique + full rewrite. Output is a standalone HTML file that only ever
  // lands in the Jail gallery (previewed in a sandboxed iframe, downloaded by hand). It is NEVER applied, committed or deployed.
  const designCalls = [];
  const DESIGN_MAX_PER_HOUR = 3;
  async function askText(prompt) {
    const hook = global.__avaSelf;
    if (!(hook && typeof hook.llmText === 'function')) throw new Error('Design mode ke liye Ava ka Gemini chahiye (hook.llmText nahi mila — backend/ava.js bhi update karo)');
    return String(await hook.llmText(prompt) || '');
  }
  function parseDesign(text) {
    const t = String(text || '').replace(/\r/g, '');
    const meta = {}; const m = t.match(/===META===\n([\s\S]*?)\n===HTML===/);
    if (m) m[1].split('\n').forEach((l) => { const k = l.match(/^(\w+):\s*(.+)$/); if (k) meta[k[1].toLowerCase()] = k[2].trim(); });
    const h = t.match(/===HTML===\n([\s\S]*?)(?:\n===END===|$)/);
    let html = h ? h[1] : '';
    html = html.replace(/^\s*```[a-z]*\n/i, '').replace(/\n```\s*$/i, '').trim();
    return { meta, html };
  }
  function checkDesign(html) {
    if (!/<\/html>/i.test(html) || html.length < 1500) return 'file adhoori / chhoti hai (</html> nahi mila)';
    if (!/viewport/i.test(html)) return 'viewport meta nahi hai';
    if (/(<script[^>]+src=|<link[^>]+href=["']https?:|src=["']https?:|url\(\s*["']?https?:|@import|\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|\bimport\s*\()/i.test(html)) return 'bahar ke resource / network call mila — design standalone hona chahiye';
    const sf = checkSafety('www/ava-bot.js', '', html, { added: html.split('\n').length, removed: 0, addedText: html });
    if (sf) return 'safety: ' + sf;
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((x) => x[1]).filter((x) => x.trim());
    for (const sc of scripts) { const sb = sandbox('www/ava-bot.js', sc); if (!sb.ok) return 'script syntax fail: ' + String(sb.log).slice(0, 120); }
    return null;
  }
  const DESIGN_RULES = [
    'You are Ava, and you are also a world-class product/UI designer. This is your DESIGN STUDIO (the Jail): pure creative work, never applied or deployed automatically — the owner will preview it and decide.',
    UI_SKILL,
    'TASK: design the BEST possible top-level UI screen for the Aureon app / its Sentinel dashboard. If the owner gave a brief, follow it. If not, YOU decide which top-level screen adds the most value (home dashboard, chat, settings, memory vault …) and what visual direction fits.',
    'REFERENCE DIRECTION (evolve it, do not copy blindly): futuristic dark glassmorphism — deep navy, violet/cyan/pink neon glows, rounded translucent cards, a glowing orb avatar for Ava, left sidebar on desktop and bottom navigation on phones, live-status cards, progress bars, tabs.',
    'QUALITY BAR: ONE standalone HTML file, inline CSS + JS, NO external files/fonts/images/CDN/network calls (inline SVG, emoji, CSS gradients only). Mobile-first (360–430px) AND great on desktop. Realistic sample content (Hinglish where natural). Real interactions (tabs, toggles, buttons that change state), smooth micro-animations, prefers-reduced-motion respected, strong typographic hierarchy, consistent spacing, accessible contrast and labels. No lorem ipsum, no dead buttons, no console errors. Must end with </html>.',
    'OUTPUT FORMAT (exactly, nothing else):\n===META===\ntitle: <short creative name>\ndescription: <1-2 sentences in Hinglish: what this screen is and what makes the design special>\n===HTML===\n<!DOCTYPE html> ... </html>\n===END===',
  ].join('\n\n');
  async function designGenerate(brief) {
    const b = brief ? 'Owner brief: ' + brief : 'No brief — choose the screen and the style yourself and make it exceptional.';
    const d1 = parseDesign(await askText(DESIGN_RULES + '\n\n' + b));
    if (!d1.html) throw new Error('Ava ka draft sahi format me nahi aaya — dobara try karo');
    let best = d1, bad = checkDesign(d1.html);
    const rev = 'You just produced the draft below. Now act as a ruthless art director: silently find the 6 weakest points (spacing, hierarchy, contrast, polish, mobile fit, missing interactions, boring visuals) and then output the COMPLETE improved file — more premium, more refined, still standalone — in the exact same output format.\n\nDRAFT:\n' + d1.html.slice(0, 70000);
    try {
      const d2 = parseDesign(await askText(DESIGN_RULES + '\n\n' + b + '\n\n' + rev));
      if (d2.html && !checkDesign(d2.html)) { best = Object.assign({}, d2, { meta: Object.assign({}, d1.meta, d2.meta) }); bad = null; }
    } catch (e) { /* keep the draft */ }
    if (bad) throw new Error('Design reject: ' + bad);
    const code = best.html;
    const entry = {
      id: nid(), createdAt: new Date().toISOString(), kind: 'design', category: 'ui',
      title: String(best.meta.title || 'Ava Design').slice(0, 90), description: String(best.meta.description || '').slice(0, 400),
      brief: String(brief || '(Ava ne khud chuna)').slice(0, 200), sandbox: { ok: true, log: 'html+js syntax checked' }, code,
    };
    state.jail = [entry, ...(state.jail || [])].slice(0, JAIL_CAP);
    save();
    if (logEvent) logEvent('proposal', { name: 'Ava' }, 'Ava Designer: naya UI design "' + entry.title + '" (sirf gallery me, kahin apply nahi hua)');
    const { code: _c, ...pub } = entry; return pub;
  }
  // Queue wrapper: quota/rate-limit errors keep the job queued and the 10-min tick retries it; other errors are logged and dropped.
  async function processJailQueue() {
    if (jailRunning || !jailQueue.length) return;
    jailRunning = true;
    try {
      while (jailQueue.length) {
        const job = jailQueue[0];
        if (Date.now() - job.queuedAt > JAIL_MAX_QUEUE_AGE_MS) { jailQueue.shift(); if (logEvent) logEvent('error', { name: 'Ava' }, 'Jail job "' + (job.brief || '(Ava ki apni soch)') + '" 6 ghante retry ke baad bhi quota nahi khula — chhod diya.'); continue; }
        try { await jailGenerateCore(job.brief); jailQueue.shift(); }
        catch (e) {
          if (looksLikeRateLimit(e.message)) { job.attempts = (job.attempts || 0) + 1; job.lastError = String(e && e.message || e).slice(0, 300); job.lastTry = Date.now(); break; } // stays queued, tick retries
          jailQueue.shift(); if (logEvent) logEvent('error', { name: 'Ava' }, 'Jail job fail: ' + e.message);
        }
      }
    } finally { jailRunning = false; }
  }
  router.post('/jail/queue/clear', async (req, res) => { if (!auth.stepUp(req, res)) return; auth.action(req, 'ava-lab jail queue clear'); const n = jailQueue.length; jailQueue.length = 0; res.json({ ok: true, cleared: n }); });
  router.get('/ai-health', async (req, res) => {
    try { const llm = require('./llm-text'); const results = await llm.testKeys(); res.json({ ok: true, results, models: llm.models(), status: llm.status() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  router.get('/jail/queue', async (req, res) => { res.json({ pending: jailQueue.length, jobs: jailQueue.map((j) => ({ id: j.id, brief: j.brief, attempts: j.attempts, queuedAt: j.queuedAt })) }); });

  router.post('/jail/design', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab designer');
    await ready;
    const now = Date.now(); while (designCalls.length && now - designCalls[0] > 3600000) designCalls.shift();
    if (designCalls.length >= DESIGN_MAX_PER_HOUR) return res.status(429).json({ error: 'Ghante me ' + DESIGN_MAX_PER_HOUR + ' designs ki limit (har design me 2 AI calls lagti hain)' });
    designCalls.push(now);
    try { res.json({ ok: true, entry: await designGenerate(String((req.body && req.body.brief) || '').slice(0, 300)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Jail routes: generate / list / view-code / delete. No apply, no GitHub, no deploy — ever.
  router.post('/jail/generate', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab jail generate');
    await ready;
    const now = Date.now(); while (jailCalls.length && now - jailCalls[0] > 3600000) jailCalls.shift();
    if (jailCalls.length >= JAIL_MAX_PER_HOUR) return res.status(429).json({ error: 'Ghante me ' + JAIL_MAX_PER_HOUR + ' jail-variants ki limit' });
    const hook = global.__avaSelf;
    if (!(hook && hook.llm) && !process.env.GROQ_API_KEY) return res.status(503).json({ error: 'Ava ka AI (Gemini) ya GROQ_API_KEY set nahi hai' });
    jailCalls.push(now);
    jailQueue.push({ id: nid(), brief: String((req.body && req.body.brief) || '').slice(0, 300), queuedAt: now, attempts: 0 });
    processJailQueue().catch(() => {}); // starts right away; if rate-limited it stays queued for the retry tick
    res.json({ ok: true, queued: true });
  });

  router.get('/jail/list', async (req, res) => {
    await ready;
    res.json((state.jail || []).map(({ code, ...r }) => ({ ...r, hasCode: !!code })));
  });

  router.get('/jail/:id/code', async (req, res) => {
    await ready;
    const j = (state.jail || []).find((x) => x.id === req.params.id);
    if (!j || !j.code) return res.status(404).type('text/plain').send('Ye variant ka code ab nahi bacha (sirf naye ' + JAIL_KEEP_CODE + ' ka restart ke baad bachta hai) — dobara generate karo.');
    const isD = j.kind === 'design'; res.type(isD ? 'text/html' : 'text/javascript').set('Content-Disposition', 'attachment; filename="ava-' + (isD ? 'design-' : 'jail-') + req.params.id + (isD ? '.html' : '.js') + '"').send(j.code);
  });

  router.delete('/jail/:id', async (req, res) => {
    auth.action(req, 'ava-lab jail delete ' + req.params.id);
    await ready;
    state.jail = (state.jail || []).filter((x) => x.id !== req.params.id);
    save();
    res.json({ ok: true });
  });

  /** Re-apply the changed part of a proposal (oldC -> newC) onto a file that has drifted (cur). Returns the new text or null. */
  function rebaseProposal(oldC, newC, cur) {
    oldC = String(oldC || ''); newC = String(newC || ''); cur = String(cur || '');
    if (!oldC || !newC || !cur) return null;
    let pre = 0; const max = Math.min(oldC.length, newC.length);
    while (pre < max && oldC.charCodeAt(pre) === newC.charCodeAt(pre)) pre++;
    let suf = 0;
    while (suf < max - pre && oldC.charCodeAt(oldC.length - 1 - suf) === newC.charCodeAt(newC.length - 1 - suf)) suf++;
    const oldMid = oldC.slice(pre, oldC.length - suf), newMid = newC.slice(pre, newC.length - suf);
    if (oldMid === newMid) return null;
    for (const n of [160, 80, 40, 20]) {            // a bit of surrounding text makes the spot unique; shrink it if the file drifted nearby
      const a = oldC.slice(Math.max(0, pre - n), pre), b = oldC.slice(oldC.length - suf, oldC.length - suf + n);
      const find = a + oldMid + b, at = cur.indexOf(find);
      if (at < 0) continue;
      if (cur.indexOf(find, at + 1) >= 0) continue;   // more than one place: not safe
      return cur.slice(0, at) + a + newMid + b + cur.slice(at + find.length);
    }
    return null;
  }

  function applyProposal(p, isAuto) {
    if (!EDITABLE.includes(p.file) || !fs.existsSync(abs(p.file))) return { code: 400, error: 'file allowed nahi / mili nahi' };
    const cur = read(p.file);
    let oldRef = p.oldContent, newContent = p.newContent;
    if (cur !== p.oldContent) {
      // The file on the server is not the one the proposal was written against (a redeploy resets Ava's earlier edits, or another
      // proposal went in first). Re-apply just the changed part onto the CURRENT file when it still fits in exactly one place.
      const rb = rebaseProposal(p.oldContent, p.newContent, cur);
      if (rb == null) return { code: 409, error: 'The file changed after this proposal and the change no longer fits — reject it and ask Ava to write it again.' };
      newContent = rb; oldRef = cur;
    }
    const bad = lib.validateNew(p.file, cur, newContent);
    if (bad) return { code: 400, error: bad };
    const sb = sandbox(p.file, newContent);
    if (!sb.ok) return { code: 400, error: 'sandbox test fail: ' + sb.log };
    const backups = {}; const wrote = [];
    const targets = [p.file]; const m = MIRRORS[p.file];
    if (m && fs.existsSync(abs(m)) && read(m) === oldRef) targets.push(m); // keep the two widget copies in sync
    try {
      for (const t of targets) {
        backups[t] = read(t);
        try { fs.writeFileSync(path.join(BK_DIR, p.id + '__' + t.replace(/\//g, '_')), backups[t]); } catch (e) { /* history keeps it */ }
        fs.writeFileSync(abs(t), newContent, 'utf8');
        if (read(t) !== newContent) { for (const w of wrote.concat([t])) fs.writeFileSync(abs(w), backups[w], 'utf8'); throw new Error('write verify fail — rollback kiya'); }
        wrote.push(t);
      }
    } catch (e) { return { code: 500, error: e.message }; }
    p.status = 'approved'; p.decidedAt = new Date().toISOString();
    state.version = (state.version || 0) + 1;
    const entry = { id: nid(), proposalId: p.id, version: state.version, auto: !!isAuto, at: p.decidedAt, status: 'applied', file: p.file, files: wrote, title: p.title, what: p.what, why: p.why, risk: p.risk, test: p.test, sandbox: p.sandbox, stats: p.stats, diff: p.diff, backups, newContents: Object.fromEntries(wrote.map((t) => [t, newContent])), newHash: crypto.createHash('sha256').update(newContent).digest('hex') };
    state.history.unshift(entry); if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
    save();
    if (logEvent) logEvent('approved', { name: 'Ava' }, 'Ava v' + entry.version + (isAuto ? ' (auto)' : '') + ': ' + p.title);
    reflect(entry); // Ava writes her own short note afterwards (best effort, async)
    return { ok: true, version: entry.version, files: wrote, needsRestart: !/ava-bot\.js$/.test(p.file), note: 'Ava v' + entry.version + ' — ' + (/ava-bot\.js$/.test(p.file) ? 'Widget file turant live hai (page refresh karo).' : 'Backend file badli hai — server restart/redeploy par naya code chalega.') };
  }

  router.post('/proposals/:id/approve', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab approve ' + req.params.id);
    await ready;
    const p = state.proposals.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.status !== 'pending') return res.status(400).json({ error: 'already ' + p.status });
    try {
      const r = applyProposal(p, false); if (!r.ok) return res.status(r.code || 500).json({ error: r.error });
      let g = null; if (ghReady()) g = await commitEntry(state.history[0]);
      r.github = g; r.note += g ? (g.ok ? ' ✅ GitHub branch "' + gh().branch + '" par save. Live deploy ke liye "main me merge" dabao.' : ' ⚠ GitHub save fail: ' + g.error) : ' (GitHub set nahi — deploy par ye local badlav ud sakta hai; .patch download karo)';
      res.json(r);
    }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function reflect(entry) {
    try {
      const r = await askJSON(`You are Ava. You just upgraded your own code with owner approval: "${entry.title}". What changed: ${entry.what}. Why: ${entry.why}. Write ONE honest first-person note (max 2 short sentences, Hinglish) about what you expect to improve and what you'll watch for. Do NOT claim consciousness or real feelings. Return ONLY JSON: {"note":"..."}`);
      if (r && r.note) { entry.note = String(r.note).slice(0, 300); save(); }
    } catch (e) { /* optional */ }
  }

  router.post('/proposals/:id/reject', async (req, res) => {
    auth.action(req, 'ava-lab reject ' + req.params.id);
    await ready;
    const p = state.proposals.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.status !== 'pending') return res.status(400).json({ error: 'already ' + p.status });
    p.status = 'rejected'; p.decidedAt = new Date().toISOString(); save();
    res.json({ ok: true });
  });

  function doRollback(h) {
    const files = h.files || [h.file];
    const plan = [];
    for (const t of files) {
      if (!EDITABLE.includes(t)) throw new Error('file allowed nahi');
      let bk = h.backups && h.backups[t];
      if (bk == null) { try { bk = fs.readFileSync(path.join(BK_DIR, h.proposalId + '__' + t.replace(/\//g, '_')), 'utf8'); } catch (e) { /* none */ } }
      if (bk == null) throw new Error('backup nahi mila: ' + t);
      const cur = read(t);
      if (crypto.createHash('sha256').update(cur).digest('hex') !== h.newHash) { const e = new Error(t + ' ek aur badlav ke baad badli hai — pehle naya upgrade rollback karo'); e.code = 409; throw e; }
      const bad = lib.validateNew(t, cur, bk); if (bad && bad !== 'file shrank too much') throw new Error(bad);
      plan.push([t, bk]);
    }
    for (const [t, bk] of plan) fs.writeFileSync(abs(t), bk, 'utf8');
    h.status = 'rolled_back'; h.rolledBackAt = new Date().toISOString();
    return Object.fromEntries(plan);
  }

  router.post('/history/:id/rollback', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab rollback ' + req.params.id);
    await ready;
    const h = state.history.find((x) => x.id === req.params.id);
    if (!h) return res.status(404).json({ error: 'not found' });
    if (h.status !== 'applied') return res.status(400).json({ error: 'already ' + h.status });
    try {
      const restored = doRollback(h); save();
      const g = await revertOnGithub(h, restored);
      if (logEvent) logEvent('rejected', { name: 'Ava' }, 'Ava v' + h.version + ' rollback hua: ' + h.title);
      res.json({ ok: true, needsRestart: true, github: g });
    } catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  });

  // go back to "Ava vN": undo every applied upgrade newer than N, newest first
  router.post('/versions/:n/restore', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab restore v' + req.params.n);
    await ready;
    const n = parseInt(req.params.n, 10);
    if (!(n >= 0)) return res.status(400).json({ error: 'bad version' });
    const todo = state.history.filter((h) => h.status === 'applied' && h.version > n).sort((a, b) => b.version - a.version);
    if (!todo.length) return res.status(400).json({ error: 'Ava v' + n + ' se naya kuch applied nahi hai' });
    const done = [];
    try { for (const h of todo) { const restored = doRollback(h); done.push(h.version); await revertOnGithub(h, restored); } }
    catch (e) { save(); return res.status(e.code || 500).json({ error: e.message + (done.length ? ' (rollback ho chuke: v' + done.join(', v') + ')' : '') }); }
    save();
    if (logEvent) logEvent('rejected', { name: 'Ava' }, 'Ava v' + n + ' par wapas (rollback v' + done.join(', v') + ')');
    res.json({ ok: true, restoredTo: n, rolledBack: done, needsRestart: true });
  });

  router.post('/history/:id/commit', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab github commit ' + req.params.id);
    await ready;
    const h = state.history.find((x) => x.id === req.params.id);
    if (!h || h.status !== 'applied') return res.status(404).json({ error: 'applied upgrade nahi mila' });
    if (!isLive(h)) return res.status(409).json({ error: 'Ye upgrade abhi file me live nahi (Render reset?) — pehle "Dobara lagao" dabao' });
    const g = await commitEntry(h);
    res.status(g.ok ? 200 : 502).json(g.ok ? { ok: true, github: g } : { error: g.error });
  });

  // Render wiped the disk (redeploy) and the old code came back: put the saved upgrade back (and it can then be committed)
  router.post('/history/:id/reapply', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab reapply ' + req.params.id);
    await ready;
    const h = state.history.find((x) => x.id === req.params.id);
    if (!h || h.status !== 'applied') return res.status(404).json({ error: 'applied upgrade nahi mila' });
    if (!h.newContents || !h.backups) return res.status(400).json({ error: 'is upgrade ka code history me nahi bacha (sirf naye 4 ka rehta hai)' });
    if (isLive(h)) return res.json({ ok: true, already: true });
    try {
      for (const t of (h.files || [h.file])) {
        if (!EDITABLE.includes(t) || !fs.existsSync(abs(t))) throw new Error('file allowed nahi / nahi mili: ' + t);
        if (read(t) !== h.backups[t]) throw new Error(t + ' ab alag version hai (repo me naya code aa gaya?) — manually dekho');
        const sb = sandbox(t, h.newContents[t]); if (!sb.ok) throw new Error('sandbox fail: ' + sb.log);
      }
      for (const t of (h.files || [h.file])) fs.writeFileSync(abs(t), h.newContents[t], 'utf8');
      if (logEvent) logEvent('approved', { name: 'Ava' }, 'Ava v' + h.version + ' dobara lagaya (Render reset ke baad)');
      res.json({ ok: true, needsRestart: !/ava-bot\.js$/.test(h.file) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // owner-only: merge Ava's branch into main -> Render deploys it. (Conflicts are reported, never forced.)
  router.post('/github/merge', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab merge to main');
    try {
      if (!ghReady()) return res.status(400).json({ error: 'GitHub set nahi hai' });
      await ensureBranch(); const g = gh();
      const r = await ghApi('/merges', { method: 'POST', body: JSON.stringify({ base: g.base, head: g.branch, commit_message: 'Ava Lab: merge ' + g.branch + ' into ' + g.base + ' (owner approved)' }) });
      if (r.status === 201) { if (logEvent) logEvent('approved', { name: 'Ava' }, 'Ava Lab: ' + g.branch + ' → ' + g.base + ' merge (deploy shuru hoga)'); return res.json({ ok: true, merged: true }); }
      if (r.status === 204) return res.json({ ok: true, merged: false, note: 'Kuch naya merge karne ko nahi (main me pehle se hai)' });
      if (r.status === 409) return res.status(409).json({ error: 'Merge conflict: main me aur badlav aa chuke hain. GitHub par pull request kholke conflict suljhao.' });
      res.status(502).json({ error: 'GitHub merge ' + r.status + ': ' + String(r.d.message || '').slice(0, 120) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/settings', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab settings');
    await ready;
    const b = req.body || {};
    if (typeof b.auto === 'boolean') state.settings.auto = b.auto;
    if (typeof b.autoApply === 'boolean') state.settings.autoApply = b.autoApply;
    if (b.hours != null) state.settings.hours = Math.min(48, Math.max(1, parseInt(b.hours, 10) || 6));
    if (typeof b.jailAuto === 'boolean') state.settings.jailAuto = b.jailAuto;
    if (b.jailHours != null) state.settings.jailHours = Math.min(48, Math.max(1, parseInt(b.jailHours, 10) || 6));
    save(); res.json({ ok: true, settings: state.settings });
  });

  // git-style patch so the change can also be committed to the repo (Render's disk resets on deploy)
  router.get('/patch/:id', async (req, res) => {
    await ready;
    const p = state.proposals.find((x) => x.id === req.params.id);
    const h = state.history.find((x) => x.id === req.params.id || x.proposalId === req.params.id);
    const file = (p && p.file) || (h && h.file);
    let oldC = p && p.oldContent, newC = p && p.newContent;
    if ((oldC == null || newC == null) && h && h.backups && h.backups[file]) { oldC = h.backups[file]; try { newC = read(file); } catch (e) { newC = null; } }
    if (oldC == null || newC == null) return res.status(404).type('text/plain').send('patch ke liye content nahi bacha');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avapatch-'));
    try {
      fs.mkdirSync(path.join(dir, 'a', path.dirname(file)), { recursive: true }); fs.mkdirSync(path.join(dir, 'b', path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'a', file), oldC); fs.writeFileSync(path.join(dir, 'b', file), newC);
      const r = spawnSync('diff', ['-u', 'a/' + file, 'b/' + file], { cwd: dir, encoding: 'utf8' });
      res.type('text/plain').set('Content-Disposition', 'attachment; filename="ava-upgrade-' + req.params.id + '.patch"').send(r.stdout || 'diff tool nahi mila');
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* tmp */ } }
  });

  // ---- auto-schedule: every N hours Ava looks at her own code and drafts an upgrade (never applies backend changes by herself)
  const tick = setInterval(async () => {
    try {
      await ready;
      const st = state.settings;
      if (st.auto && !busy && Date.now() - (state.lastAuto || 0) >= st.hours * 3600000 && state.proposals.filter((p) => p.status === 'pending').length < 5) {
        const hook = global.__avaSelf;
        if ((hook && hook.llm) || process.env.GROQ_API_KEY) { busy = true; state.lastAuto = Date.now(); save(); try { await improve('', true); } finally { busy = false; } }
      }
    } catch (e) { console.error('[ava-self] auto upgrade failed:', e.message); }
    // Ava's own periodic Jail creativity cycle (no brief: she picks her direction) + retry of quota-blocked jobs
    try {
      const st = state.settings;
      if (st.jailAuto && Date.now() - (state.lastJailAuto || 0) >= st.jailHours * 3600000) { state.lastJailAuto = Date.now(); save(); jailQueue.push({ id: nid(), brief: '', queuedAt: Date.now(), attempts: 0 }); }
      processJailQueue().catch((e) => console.error('[ava-self] jail queue tick failed:', e.message));
    } catch (e) { console.error('[ava-self] jail auto-cycle failed:', e.message); }
  }, 10 * 60000);
  if (tick.unref) tick.unref();

  return { router, page: PAGE, _t: { improve, sandbox } };
};

const PAGE = String.raw`<!DOCTYPE html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ava Lab — Aureon Sentinel</title><style>
:root{--bg:#0b0d12;--bg2:#12151c;--card:#161a23;--bd:#262c3a;--tx:#e8eaf0;--mu:#8b8f99;--ok:#4ade80;--danger:#ff6b6b;--warn:#fbbf24;--ac:#8b7bff}
@media (prefers-color-scheme:light){:root{--bg:#f5f6fa;--bg2:#eceef4;--card:#fff;--bd:#dde0ea;--tx:#161a23;--mu:#667;--ok:#16a34a;--danger:#dc2626;--warn:#b45309;--ac:#5b4be0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 system-ui,sans-serif;padding:16px;max-width:900px;margin:auto}
a{color:var(--ac);text-decoration:none}h1{font-size:20px;margin:6px 0}.sub{color:var(--mu);font-size:12px;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px;margin:12px 0}.card h3{margin:0 0 6px;font-size:15px}
.meta{color:var(--mu);font-size:12px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input[type=text]{flex:1;min-width:180px;background:var(--bg2);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:9px}
button{background:var(--ac);color:#fff;border:0;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer}button.g{background:var(--bg2);color:var(--tx);border:1px solid var(--bd)}button.d{background:var(--danger)}button:disabled{opacity:.5}
.b{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--bd);color:var(--mu)}.low{color:var(--ok)}.medium{color:var(--warn)}.high{color:var(--danger)}
.diff{font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;border:1px solid var(--bd);border-radius:8px;overflow-x:auto;margin-top:8px;background:var(--bg2)}
.diff .h{padding:4px 8px;color:var(--mu);background:rgba(139,143,153,.12)}.diff .r{display:flex;white-space:pre;min-width:max-content}
.diff .ln{flex:none;width:34px;text-align:right;padding:0 6px;color:var(--mu);user-select:none}.diff .sg{flex:none;width:16px;text-align:center;font-weight:700}.diff .tx{padding-right:12px}
.diff .r.add{background:rgba(74,222,128,.16)}.diff .r.del{background:rgba(255,107,107,.16)}
.add-n{color:var(--ok)}.del-n{color:var(--danger)}details summary{cursor:pointer;color:var(--ac);margin-top:8px}
.note{border-left:3px solid var(--ac);padding:4px 10px;margin-top:8px;color:var(--mu);font-style:italic}
#msg{min-height:20px;font-size:13px;margin:8px 0}
.jworld{background:linear-gradient(160deg,rgba(139,123,255,.14),rgba(139,123,255,.02) 60%);border:1px solid var(--bd);border-radius:16px;padding:18px;margin-top:16px}
.jworld h2{margin:0 0 2px;font-size:17px}
.jsub{color:var(--mu);font-size:12px;margin-bottom:12px}
.jstats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.jstat{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--mu)}
.jstat b{color:var(--tx);font-size:14px}
.jgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:10px}
.jcard{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:14px;position:relative;overflow:hidden}
.jcard::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--cat-color,var(--ac))}
.jicon{font-size:26px;line-height:1;margin-bottom:6px}
.jcard h4{margin:0 0 4px;font-size:14px}
.jcat{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--mu);margin-bottom:6px}
.jdesc{font-size:12.5px;color:var(--mu);margin:6px 0 10px;min-height:32px}
.jcard .row{gap:6px}
.jcard button{padding:7px 11px;font-size:12px}
.empty-world{color:var(--mu);font-size:13px;padding:20px;text-align:center}

/* ===== Ava Lab · neon finish (only this page) ===== */
:root{--bg:#070914;--bg2:#0c1024;--card:rgba(18,22,52,.62);--bd:rgba(120,110,255,.30);--tx:#eef0ff;--mu:#9aa0c8;--ac:#8b7bff;--ok:#3ee0a0;--danger:#ff6b8b;--warn:#ffc15e;--neon:#4fc3ff}
html{background:#070914}body{background:radial-gradient(900px 520px at 6% -6%,rgba(139,92,246,.38),transparent 60%),radial-gradient(800px 520px at 104% 30%,rgba(34,211,238,.20),transparent 60%),radial-gradient(700px 400px at 40% 112%,rgba(16,185,129,.14),transparent 60%),#070914;background-attachment:fixed;max-width:980px;padding:max(14px,env(safe-area-inset-top)) 14px 40px}
.card,.jcard,.jworld{backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-color:var(--bd);box-shadow:0 0 0 1px rgba(79,195,255,.05),0 10px 34px rgba(8,5,38,.55),inset 0 0 26px rgba(139,123,255,.07)}
button{background-image:linear-gradient(135deg,#7c5cff,#3aa8ff);color:#fff;border:0;box-shadow:0 0 14px rgba(110,120,255,.35)}button.g,button.d{background-image:none}
input[type=text],input[type=number],textarea{background:rgba(10,12,34,.8);border:1px solid var(--bd);color:var(--tx);border-radius:12px}
h1{background:linear-gradient(90deg,#c9b8ff,#7fe3ff);-webkit-background-clip:text;background-clip:text;color:transparent}h2{color:#d9d4ff}
.lhero{display:flex;gap:16px;align-items:center;background:var(--card);border:1px solid var(--bd);border-radius:20px;padding:16px;margin:8px 0 14px;position:relative;overflow:hidden}
.lorb{flex:none;width:92px;height:92px;border-radius:50%;background:radial-gradient(circle at 50% 45%,#0a0d2a 54%,transparent 55%),conic-gradient(from 0deg,#4fc3ff,#7c5cff,#ff4fd8,#4fc3ff);box-shadow:0 0 34px rgba(124,92,255,.7),0 0 80px rgba(79,195,255,.3);position:relative}
.lorb::after{content:"◠ ◠";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9be7ff;font-size:20px;letter-spacing:8px;text-shadow:0 0 10px #4fc3ff}
.lorb.busy{animation:lspin 2.2s linear infinite;box-shadow:0 0 46px rgba(124,92,255,.95),0 0 100px rgba(79,195,255,.5)}.lorb.busy::after{animation:lspin 2.2s linear infinite reverse}
@keyframes lspin{to{transform:rotate(360deg)}}
.lhero h1{margin:0 0 4px;font-size:22px}.lhero .sub{margin:0}.lchips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.lchips span{font-size:11px;padding:4px 10px;border-radius:99px;background:rgba(20,24,64,.8);border:1px solid var(--bd);color:var(--mu)}
.lback{display:inline-block;font-size:12px;color:var(--mu);margin-top:2px}
.vgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:4px 0 14px}@media(min-width:760px){.vgrid{grid-template-columns:repeat(4,1fr)}}
.vc{background:rgba(16,19,52,.7);border:1px solid var(--bd);border-radius:16px;padding:12px;text-align:center}.vc.act{border-color:#b18cff;box-shadow:0 0 18px rgba(177,140,255,.5)}
.vav{width:52px;height:52px;border-radius:50%;margin:0 auto 6px;box-shadow:0 0 16px var(--c);background:radial-gradient(circle at 35% 30%,#fff,var(--c))}.vc b{display:block;font-size:13px}.vc small{display:block;color:var(--mu);font-size:10.5px;min-height:28px}
.vc button{margin-top:6px;font-size:11px;padding:7px 9px;border-radius:10px;cursor:pointer;width:100%}.vc button.alt{background:rgba(30,34,78,.8);background-image:none;border:1px solid var(--bd);box-shadow:none}
.jav{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:8px;background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.35),var(--cat-color));box-shadow:0 0 16px var(--cat-color)}
.jcard{transition:transform .15s}.jcard:hover{transform:translateY(-2px)}
</style></head><body>
<a class="lback" href="/api/sentinel/dashboard">← Sentinel</a>
<div class="lhero"><div class="lorb"></div><div><h1>Ava Lab</h1><div class="sub">Ava apna code khud padhti hai, khud upgrade likhti hai aur yahan dikhati hai ki kya badla aur kyun. <b>Apply sirf tumhare Approve ke baad.</b></div></div></div>
<div class="card"><h3>Ava abhi</h3><div id="sig" class="meta">…</div></div>
<div class="card"><h3>Auto-upgrade <span id="ver" class="b"></span></h3>
<div class="row"><label><input type="checkbox" id="auto" onchange="saveSet()"> Ava khud har</label>
<input id="hrs" type="number" min="1" max="48" value="6" style="width:64px;background:var(--bg2);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:6px" onchange="saveSet()"> <span class="meta">ghante me apna code dekh ke upgrade <b>likhe</b> (proposal banta hai, tum Approve karte ho)</span></div>
<div class="row" style="margin-top:8px"><label><input type="checkbox" id="aapply" onchange="saveSet()"> Chhote <b>low-risk widget (ava-bot.js)</b> changes khud live ho jaayein</label></div>
<div class="meta" id="lastauto"></div><div class="meta" id="ghline"></div></div>
<div class="card"><h3>Ava, apne aap ko upgrade karo</h3>
<div class="row"><input id="goal" type="text" placeholder="(optional) goal: jaise 'jawab chhote aur saaf ho' — khali chhodo to Ava khud dhoondhegi">
<button id="go" onclick="improve()">⚡ Upgrade likho</button></div><div id="msg"></div>
<div class="meta" id="prot"></div></div>
<h2 id="proposals" style="font-size:16px">Pending proposals</h2><div id="pend"></div>
<h2 id="history" style="font-size:16px">Ava ne khud ko kya upgrade kiya (history)</h2><div id="hist"></div>
<div class="jworld">
<h2>🌌 Ava ki Duniya — Prototype Workshop</h2>
<div class="jsub">Ek alag jahaan jahan Ava khud sochti, banati aur test karti hai — kabhi apply/deploy nahi hota. Jo pasand aaye uska code download karke khud test karo.</div>
<div class="card" id="dcard" style="border-color:#b18cff"><h3>🎨 Ava Designer — top-level UI</h3><div class="jsub" style="margin-bottom:8px">Ava khud decide karti hai kaunsi screen aur kaisa look — pehle draft, phir khud critique karke best version. Sirf gallery me; apply tumhare haath me.</div>
<div class="row"><input id="dbrief" type="text" placeholder="(optional) jaise 'chat screen' — khali chhodo to Ava khud chunegi"><button id="dgo">🎨 Ava, khud best UI banao</button></div><div id="dmsg" class="meta"></div></div>
<div class="jstats" id="jstats"></div>
<h3 style="margin:6px 0 2px">Ava Variants</h3><div class="jsub">Different moods. Same purpose. "Clone" dabao — Ava us mood ka naya variant design karegi.</div><div class="vgrid" id="vars"></div>
<div class="card"><div class="row"><input id="jbrief" type="text" placeholder="(optional) brief: jaise 'ek log-scanner security tool' — khali chhodo to Ava khud sochegi">
<button id="jgo" onclick="jailGen()">🧪 Naya variant banao</button></div><div id="jmsg"></div></div>
<div class="jgrid" id="jail"></div>
</div>
<script src="/api/ava/widget.js"></script>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
async function af(url,opts){opts=opts||{};opts.headers=Object.assign({'x-csrf':'1','Content-Type':'application/json'},opts.headers);
 var r=await fetch(url,opts);
 if(r.status===403){var j=await r.clone().json().catch(function(){return{}});if(j.needTotp){var c=prompt('2FA code (Authenticator ka 6-digit) daalo:');if(c){opts.headers['x-totp']=c.trim();r=await fetch(url,opts)}}}
 if(r.status===401){document.body.innerHTML='<p style="padding:40px;text-align:center">Session khatam. Sentinel dashboard dobara kholo.</p>';throw new Error('401')}
 return r}
function diff(h,st){if(!h||!h.length)return'<div class="meta">Koi line-diff nahi.</div>';var o='<div class="diff">';
 h.forEach(function(k){o+='<div class="h">@@ -'+k.oldStart+','+k.oldLines+' +'+k.newStart+','+k.newLines+' @@</div>';
  k.rows.forEach(function(r){var c=r[0]==='+'?'add':r[0]==='-'?'del':'';o+='<div class="r '+c+'"><span class="ln">'+(r[1]||'')+'</span><span class="ln">'+(r[2]||'')+'</span><span class="sg">'+(r[0]===' '?'':r[0])+'</span><span class="tx">'+esc(r[3])+'</span></div>'})});
 if(st&&st.truncated)o+='<div class="h">… diff lamba hai</div>';return o+'</div>'}
function stat(s){return s?'<span class="add-n">+'+s.added+'</span> <span class="del-n">-'+s.removed+'</span>':''}
function when(t){try{return new Date(t).toLocaleString()}catch(e){return t}}
function card(p,hist){
 var h='<div class="card"><h3>'+esc(p.title)+'</h3><div class="row"><span class="b">'+esc(p.file)+'</span><span class="b '+esc(p.risk)+'">risk: '+esc(p.risk)+'</span>'+(p.version?'<span class="b" style="color:var(--ac)">Ava v'+p.version+'</span>':'')+(p.auto?'<span class="b">🤖 auto</span>':'')+(hist&&p.github?(p.github.ok?'<span class="b low">📌 GitHub ✓ '+esc(p.github.branch||'')+'</span>':'<span class="b high" title="'+esc(p.github.error)+'">⚠ GitHub fail</span>'):'')+(hist&&p.status==='applied'&&p.live===false?'<span class="b high">⚠ Render reset: purana code wapas</span>':'')+(p.sandbox?'<span class="b '+(p.sandbox.ok?'low':'high')+'" title="'+esc(p.sandbox.log)+'">sandbox '+(p.sandbox.ok?'✓':'✗')+'</span>':'')+(hist?'<span class="b">'+esc(p.status)+'</span>':'')+'<span class="meta">'+stat(p.stats)+' · '+when(p.at||p.createdAt)+'</span></div>'
 +'<p><b>Kya badla:</b> '+esc(p.what)+'</p><p><b>Kyun:</b> '+esc(p.why)+'</p>'+(p.test?'<p class="meta"><b>Kaise check karein:</b> '+esc(p.test)+'</p>':'')
 +(p.note?'<div class="note">Ava ka note: '+esc(p.note)+'</div>':'')
 +'<details'+(hist?'':' open')+'><summary>Exact badlav (diff)</summary>'+diff(p.diff,p.stats)+'</details><div class="row" style="margin-top:10px">';
 if(!hist)h+='<button onclick="decide(\''+esc(p.id)+'\',\'approve\')">✅ Approve</button><button class="d" onclick="decide(\''+esc(p.id)+'\',\'reject\')">✖ Reject</button>';
 if(hist&&p.status==='applied'&&p.live===false&&p.canReapply)h+='<button onclick="post(\'/history/'+esc(p.id)+'/reapply\',\'↻ Dobara laga diya\')">↻ Dobara lagao</button>';
 if(hist&&p.status==='applied'&&p.live!==false&&(!p.github||!p.github.ok))h+='<button class="g" onclick="post(\'/history/'+esc(p.id)+'/commit\',\'📌 GitHub par save\')">📌 GitHub me save</button>';
 if(hist&&p.status==='applied')h+='<button class="g" onclick="rollback(\''+esc(p.id)+'\')">↩ Rollback</button>'+(p.version>1?'<button class="g" onclick="restoreTo('+(p.version-1)+')">⏪ Ava v'+(p.version-1)+' par wapas</button>':'');
 h+='<a class="meta" href="/api/sentinel/ava/patch/'+esc(hist?p.id:p.id)+'">⬇ patch (.patch)</a></div></div>';return h}
async function load(){var r=await af('/api/sentinel/ava/state');var s=await r.json();
 var sg=s.signals&&s.signals.mind;document.getElementById('sig').innerHTML=(sg?'confidence <b>'+sg.confidence+'</b> · uncertainty '+sg.uncertainty+' · curiosity '+sg.curiosity+' · cycles '+sg.cycles+(sg.goal?'<br>goal: '+esc(sg.goal):''):'(Ava Mind data abhi nahi)')+'<br>AI: <b>'+esc(s.llm)+'</b> · keys: <b>'+(s.keys&&s.keys.length?esc(s.keys.join(', ')):'(Gemini/Groq key set nahi)')+'</b> · editable files: '+s.files.length;
 document.getElementById('ver').textContent='abhi: Ava v'+s.version;document.getElementById('auto').checked=!!s.settings.auto;document.getElementById('aapply').checked=!!s.settings.autoApply;document.getElementById('hrs').value=s.settings.hours;document.getElementById('lastauto').textContent=s.lastAuto?'Pichli auto-try: '+when(s.lastAuto):'';
 document.getElementById('ghline').innerHTML=s.github&&s.github.configured?'📌 Ava ki special branch: <b>'+esc(s.github.branch)+'</b> ('+esc(s.github.repo)+') — approve par upgrade yahin commit hota hai, <b>'+esc(s.github.base)+'</b> me nahi. <a href="'+esc(s.github.compare)+'" target="_blank" rel="noopener">PR / diff dekho ↗</a> <button class="g" style="padding:4px 10px;margin-left:6px" onclick="mergeMain()">🚀 '+esc(s.github.base)+' me merge (deploy)</button>':'⚠ GitHub set nahi: Render env me <b>AVA_GITHUB_REPO</b> (owner/repo) aur <b>GITHUB_TOKEN</b> daalo, warna upgrade deploy par ud sakta hai';
 document.getElementById('prot').textContent='🔒 '+s.protected;document.getElementById('go').disabled=!!s.busy;
 var pend=s.proposals.filter(function(p){return p.status==='pending'});document.getElementById('pend').innerHTML=pend.length?pend.map(function(p){return card(p,false)}).join(''):'<div class="meta">Koi pending upgrade nahi.</div>';
 document.getElementById('hist').innerHTML=s.history.length?s.history.map(function(h){return card(h,true)}).join(''):'<div class="meta">Abhi tak Ava ne khud ko upgrade nahi kiya.</div>'}
async function improve(){var b=document.getElementById('go'),m=document.getElementById('msg');b.disabled=true;m.style.color='';m.textContent='Ava apna code padh rahi hai aur upgrade likh rahi hai… (30–60 sec)';
 try{var r=await af('/api/sentinel/ava/improve',{method:'POST',body:JSON.stringify({goal:document.getElementById('goal').value})});var j=await r.json();
  if(!r.ok){m.style.color='var(--danger)';m.textContent='❌ '+(j.error||r.status)}else if(j.none){m.textContent='Ava: '+j.say}else{m.style.color='var(--ok)';m.textContent='✅ Naya proposal taiyar — neeche dekho aur Approve/Reject karo.'}}
 catch(e){m.textContent='Error: '+e.message}b.disabled=false;load()}
async function decide(id,a){if(a==='approve'&&!confirm('Ye code file me likha jayega. Diff dekh liya? Approve?'))return;
 var r=await af('/api/sentinel/ava/proposals/'+id+'/'+a,{method:'POST'});var j=await r.json();var m=document.getElementById('msg');
 m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?('✅ '+(j.note||'ho gaya')):('❌ '+(j.error||r.status));load()}
async function post(path,okmsg){var r=await af('/api/sentinel/ava'+path,{method:'POST'});var j=await r.json();var m=document.getElementById('msg');m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?'✅ '+okmsg:'❌ '+(j.error||r.status);load()}
async function mergeMain(){if(!confirm('Ava ki branch main me merge hogi aur Render naya code deploy karega. Diff dekh liya? Merge karein?'))return;var r=await af('/api/sentinel/ava/github/merge',{method:'POST'});var j=await r.json();var m=document.getElementById('msg');m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?(j.merged?'✅ Merge ho gaya — Render deploy shuru karega':'ℹ '+(j.note||'ho gaya')):'❌ '+(j.error||r.status)}
async function saveSet(){var r=await af('/api/sentinel/ava/settings',{method:'POST',body:JSON.stringify({auto:document.getElementById('auto').checked,autoApply:document.getElementById('aapply').checked,hours:document.getElementById('hrs').value})});var m=document.getElementById('msg');m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?'✅ Settings save':'❌ save nahi hua';load()}
async function restoreTo(n){if(!confirm('Ava v'+n+' par wapas jaana hai? Usse naye saare upgrades undo honge.'))return;var r=await af('/api/sentinel/ava/versions/'+n+'/restore',{method:'POST'});var j=await r.json();var m=document.getElementById('msg');m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?'⏪ Ava v'+n+' par wapas (server restart par chalega)':'❌ '+(j.error||r.status);load()}
async function rollback(id){if(!confirm('Is upgrade ko wapas undo karein?'))return;var r=await af('/api/sentinel/ava/history/'+id+'/rollback',{method:'POST'});var j=await r.json();
 var m=document.getElementById('msg');m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?'↩ Rollback ho gaya (server restart par chalega)':'❌ '+(j.error||r.status);load()}
var JCAT={ui:['🎨','#8b7bff'],security:['🛡️','#ef6a6a'],utility:['🔧','#f5b740'],game:['🎮','#4fd1c5'],other:['🧩','#9aa0ab']};
function jcard(j){var c=JCAT[j.category]||JCAT.other;
 return '<div class="jcard" style="--cat-color:'+c[1]+'"><div class="jav">'+c[0]+'</div><span class="jcat">'+esc(j.category||'other')+'</span><h4>'+esc(j.title)+'</h4>'
 +'<div class="jdesc">'+esc(j.description)+'</div>'
 +'<div class="row" style="margin-bottom:8px"><span class="b '+(j.sandbox&&j.sandbox.ok?'low':'high')+'">sandbox '+(j.sandbox&&j.sandbox.ok?'✓':'✗')+'</span><span class="meta">'+when(j.createdAt)+'</span></div>'
 +'<div class="row">'+(j.hasCode?'<a href="/api/sentinel/ava/jail/'+esc(j.id)+'/code"><button class="g">⬇ Code</button></a>':'<span class="meta">(code gaya)</span>')
 +(j.kind==='design'&&j.hasCode?'<button data-pv="'+esc(j.id)+'">👁 Preview</button>':'')
 +'<button class="d" onclick="jailDel(\''+esc(j.id)+'\')">✖</button></div></div>'}
function jstats(list){var byCat={};list.forEach(function(j){byCat[j.category||'other']=(byCat[j.category||'other']||0)+1});
 var s='<div class="jstat"><b>'+list.length+'</b> total variants</div>';
 Object.keys(JCAT).forEach(function(k){if(byCat[k])s+='<div class="jstat">'+JCAT[k][0]+' <b>'+byCat[k]+'</b> '+k+'</div>'});
 document.getElementById('jstats').innerHTML=s}
async function jailLoad(){var r=await af('/api/sentinel/ava/jail/list');var list=await r.json();
 jstats(list);
 document.getElementById('jail').innerHTML=list.length?list.map(jcard).join(''):'<div class="empty-world">🌙 Abhi Ava ki duniya khaali hai — pehla variant banao!</div>'}
async function jailGen(){var b=document.getElementById('jgo'),m=document.getElementById('jmsg');b.disabled=true;m.style.color='';m.textContent='Ava naya UI variant design kar rahi hai… (30–60 sec)';
 try{var r=await af('/api/sentinel/ava/jail/generate',{method:'POST',body:JSON.stringify({brief:document.getElementById('jbrief').value})});var j=await r.json();
  if(!r.ok){m.style.color='var(--danger)';m.textContent='❌ '+(j.error||r.status)}else{m.style.color='var(--ok)';m.textContent='✅ Naya variant gallery me aa gaya.'}}
 catch(e){m.textContent='Error: '+e.message}b.disabled=false;jailLoad()}
async function jailDel(id){if(!confirm('Ye variant gallery se hata dein?'))return;await af('/api/sentinel/ava/jail/'+id,{method:'DELETE'});jailLoad()}
function setBusy(on){var o=document.querySelector('.lorb');if(o)o.classList.toggle('busy',on);try{parent.postMessage({ava:'busy',on:on},location.origin)}catch(e){}}
if(window.parent!==window){var lb=document.querySelector('.lback');if(lb)lb.style.display='none'}
var _af=af;af=async function(u,o){var q=String(u).split('?')[0];var b=!!(o&&o.method==='POST'&&(q.endsWith('/jail/generate')||q.endsWith('/jail/design')||q.endsWith('/improve')));if(b)setBusy(true);try{return await _af(u,o)}finally{if(b)setBusy(false)}};
var VARS=[['Ava-Kiddo','Playful · Friendly','#ff8fd8','cute playful companion widget with pastel clouds and soft bounce'],['Ava-Classic','Professional · Calm','#4fc3ff','professional calm minimal assistant widget'],['Ava-Shadow','Focused · Silent','#8b5cff','focused silent dark hacker-mode assistant widget'],['Ava-Pro','Strategic · Future','#3ee0a0','strategic futuristic pro-mode assistant widget with insights']];
var actV=0;try{actV=Math.max(0,+localStorage.getItem('ava_variant_i')||0)}catch(e){}
function drawVars(){var h='';VARS.forEach(function(v,i){h+='<div class="vc'+(i===actV?' act':'')+'"><div class="vav" style="--c:'+v[2]+'"></div><b>'+v[0]+'</b><small>'+v[1]+'</small><button class="alt" data-i="'+i+'" data-a="pick">'+(i===actV?'Active ✓':'Select')+'</button><button data-i="'+i+'" data-a="clone">✨ Clone</button></div>'});document.getElementById('vars').innerHTML=h}
document.getElementById('vars').onclick=function(e){var b=e.target.closest('button');if(!b)return;var i=+b.getAttribute('data-i');if(b.getAttribute('data-a')==='pick'){actV=i;try{localStorage.setItem('ava_variant_i',i)}catch(x){}drawVars()}else{document.getElementById('jbrief').value='Variant "'+VARS[i][0]+'": '+VARS[i][3];jailGen()}};
drawVars();
document.getElementById('dgo').onclick=async function(){var b=this,m=document.getElementById('dmsg');b.disabled=true;m.style.color='';m.textContent='Ava design kar rahi hai — draft, phir khud critique (1–2 min)…';
 try{var r=await af('/api/sentinel/ava/jail/design',{method:'POST',body:JSON.stringify({brief:document.getElementById('dbrief').value})});var j=await r.json();
  if(r.ok){m.style.color='var(--ok)';m.textContent='✅ Naya design gallery me: '+((j.entry&&j.entry.title)||'')}else{m.style.color='var(--danger)';m.textContent='❌ '+(j.error||r.status)}}
 catch(e){m.style.color='var(--danger)';m.textContent='Error: '+e.message}b.disabled=false;jailLoad()};
document.getElementById('jail').addEventListener('click',async function(e){var b=e.target.closest('button[data-pv]');if(!b)return;
 var r=await af('/api/sentinel/ava/jail/'+b.getAttribute('data-pv')+'/code');var html=await r.text();
 var w=document.createElement('div');w.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(4,5,16,.92);display:flex;flex-direction:column';
 var bar=document.createElement('div');bar.style.cssText='display:flex;justify-content:space-between;align-items:center;padding:10px 14px;color:#cfd2ff;font:600 13px system-ui';bar.innerHTML='<span>👁 Preview (sandbox — kuch bhi apply nahi hota)</span>';
 var x=document.createElement('button');x.textContent='✖ Band';x.onclick=function(){w.remove()};bar.appendChild(x);
 var f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.style.cssText='flex:1;border:0;background:#070914;width:100%';f.srcdoc=html;w.appendChild(bar);w.appendChild(f);document.body.appendChild(w)});
load();jailLoad();
</script></body></html>`;
