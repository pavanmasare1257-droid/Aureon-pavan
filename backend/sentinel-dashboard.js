// backend/sentinel-dashboard.js
//
// Aureon Sentinel Dashboard — multi-server health monitoring with a
// human-approval gate. NOTHING in this file ever writes a file or calls a
// restart webhook on its own. A failure only ever produces a *proposal*;
// a file is written / a webhook is called ONLY inside the /approve route,
// which only runs when you click Approve on the dashboard.
//
// Two kinds of monitored servers:
//   - "self"     — a server whose source this process can read/write on
//                  disk (e.g. this same backend checkout, or any other repo
//                  you've cloned into this Codespace). On failure, Sentinel
//                  proposes a patch (you see old vs new content) — never
//                  applies it until you approve.
//   - "external" — any URL you paste in, hosted elsewhere. Sentinel has no
//                  filesystem access to someone else's server, so it can
//                  only monitor uptime. If you also give a restart webhook
//                  for it, a failure proposes calling that webhook — again
//                  gated behind Approve, never automatic.
//
// Data persists to Firestore (collection aureon_persist) so it survives
// Render deploys, and is mirrored to backend/sentinel-data/*.json as a
// fallback when Firestore isn't configured. See persist.js.
//
// Env vars reused from watchdog.js's email setup (same values, nothing new
// to configure if you already set those up): RESEND_API_KEY, ALERT_EMAIL_TO,
// ALERT_EMAIL_FROM (optional).

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

const DATA_DIR = path.join(__dirname, 'sentinel-data');
const SERVERS_PATH = path.join(DATA_DIR, 'servers.json');
const PROPOSALS_PATH = path.join(DATA_DIR, 'proposals.json');
const SNAPSHOTS_PATH = path.join(DATA_DIR, 'snapshots.json');
const CHANGELOG_PATH = path.join(DATA_DIR, 'changelog.json');
const EVENTS_PATH = path.join(DATA_DIR, 'events.json');
const POSTDEPLOY_PATH = path.join(DATA_DIR, 'postdeploy.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[sentinel] failed to load', p, e.message);
    return fallback;
  }
}
function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

let servers = loadJSON(SERVERS_PATH, []);
let proposals = loadJSON(PROPOSALS_PATH, []);
let snapshots = loadJSON(SNAPSHOTS_PATH, {}); // key -> sha256 hash of last-seen content
let postDeploy = loadJSON(POSTDEPLOY_PATH, []); // v12: approved GitHub commits being watched after deploy
let events = loadJSON(EVENTS_PATH, []); // live timeline: down / up / proposal / approved / rejected
let changeLog = loadJSON(CHANGELOG_PATH, []); // [{serverId, serverName, file, changedAt}], newest first

// ---- Firestore hydration ----
// On a fresh Render deploy the local files are gone, so the real copy lives
// in Firestore. Until it has been read, nothing is allowed to write (that
// would overwrite good data with an empty list) and the monitor loops wait.
const store = require('./persist');
const { THEME_TAGS } = require('./ui-theme');
const lib = require('./sentinel-lib');
const auth = require('./dash-auth');   // shared lock: stealth 404, session cookie, 2FA, audit (see dash-auth.js)

// Last-seen content of each file (one small doc per file) — lets Sentinel show
// WHAT changed between two scans, not just that something changed.
const SNAP_DIR = path.join(DATA_DIR, 'snaps');
try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch (e) { /* read-only disk is fine */ }
const snapId = (key) => 'snap_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 24);
async function loadSnap(key) {
  await ready;
  const r = await store.load(snapId(key), path.join(SNAP_DIR, snapId(key) + '.json'));
  return r.value && typeof r.value.content === 'string' ? r.value.content : null;
}
function saveSnap(key, content) {
  if (content.length > 300000) return;
  ready.then(() => store.save(snapId(key), { content }, path.join(SNAP_DIR, snapId(key) + '.json'))).catch(() => {});
}

const PERSISTED = {
  servers:   { file: SERVERS_PATH,   get: () => servers,   set: (v) => { servers = v; } },
  proposals: { file: PROPOSALS_PATH, get: () => proposals, set: (v) => { proposals = v; } },
  snapshots: { file: SNAPSHOTS_PATH, get: () => snapshots, set: (v) => { snapshots = v; } },
  changelog: { file: CHANGELOG_PATH, get: () => changeLog, set: (v) => { changeLog = v; } },
  events:    { file: EVENTS_PATH,    get: () => events,    set: (v) => { events = v; } },
  postdeploy: { file: POSTDEPLOY_PATH, get: () => postDeploy, set: (v) => { postDeploy = v; } },
};
const isEmptyVal = (v) => (Array.isArray(v) ? v.length === 0 : !v || Object.keys(v).length === 0);

// Old, decided proposals don't need their full file contents stored forever
// (Firestore docs are limited to 1 MiB) — pending ones keep everything.
function slimProposals(list) {
  return list.slice(-200).map((p) => {
    if (p.status === 'pending') return p;
    const { oldContent, newContent, ...rest } = p;
    return rest;
  });
}

const ready = (async () => {
  await store.whenFirestore(20000);
  for (const key of Object.keys(PERSISTED)) {
    const cfg = PERSISTED[key];
    const r = await store.load(key, cfg.file);
    if (r.source === 'firestore') cfg.set(r.value);
    else if (!isEmptyVal(cfg.get())) await store.save(key, key === 'proposals' ? slimProposals(cfg.get()) : cfg.get(), cfg.file); // one-time migration of existing local data
  }
  console.log('[sentinel] data loaded — servers:', servers.length, 'proposals:', proposals.length);
})().catch((e) => console.error('[sentinel] hydrate failed:', e.message));

function persist(key) {
  ready.then(() => {
    const cfg = PERSISTED[key];
    return store.save(key, key === 'proposals' ? slimProposals(cfg.get()) : cfg.get(), cfg.file);
  }).catch((e) => console.error('[sentinel] persist failed:', key, e.message));
}
function persistServers() { persist('servers'); }
function persistProposals() { persist('proposals'); }
function persistSnapshots() { persist('snapshots'); }
function persistChangelog() { persist('changelog'); }

// ---------------- v8: health history, live events, alerts without spam ----------------
const HISTORY_MAX = 288; // samples kept per server (24 h at the default 5-minute interval)
const REMIND_MS = (Number(process.env.SENTINEL_REMIND_MIN) > 0 ? Number(process.env.SENTINEL_REMIND_MIN) : 60) * 60000;

function logEvent(type, server, text) {
  events.unshift({ t: new Date().toISOString(), type, server: server ? server.name : '', text: String(text || '').slice(0, 240) });
  if (events.length > 150) events.length = 150;
  persist('events');
  try {   // brain: Sentinel, Ava Guard and Ava's upgrade proposals/approvals all become neurons
    if (global.__brain) {
      const R = { down: 3, deploy_bad: 3, error: 3, rejected: 4, proposal: 0, approved: 6, up: 0, deploy_ok: 6, deploy_watch: 0 };
      global.__brain.record(R[type] != null ? R[type] : 0, 'Sentinel ' + type + (server && server.name ? ' [' + server.name + ']' : '') + ': ' + String(text || ''), { kind: 'sentinel' });
    }
  } catch (e) { /* brain is optional */ }
}

// history entries are [timestamp, responseMs] — responseMs -1 means the check failed
function recordSample(server, r) {
  const ok = !!r.ok;
  server.history = server.history || [];
  server.history.push([Date.now(), ok ? r.ms : -1]);
  if (server.history.length > HISTORY_MAX) server.history.splice(0, server.history.length - HISTORY_MAX);
  if (!ok && !server.downSince) {
    server.downSince = new Date().toISOString();
    logEvent('down', server, 'DOWN — ' + (server.lastError || server.lastStatus));
  } else if (ok && server.downSince) {
    const mins = Math.max(1, Math.round((Date.now() - Date.parse(server.downSince)) / 60000));
    logEvent('up', server, 'wapas UP — ' + mins + ' min downtime');
    server.downSince = null;
  }
}

function metrics(server) {
  const day = Date.now() - 86400000;
  const d = (server.history || []).filter((x) => x[0] >= day);
  const okMs = d.filter((x) => x[1] >= 0).map((x) => x[1]).sort((a, b) => a - b);
  return {
    uptime24: d.length ? Math.round((okMs.length / d.length) * 1000) / 10 : null,
    avgMs: okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null,
    p95Ms: okMs.length ? okMs[Math.min(okMs.length - 1, Math.floor(okMs.length * 0.95))] : null,
    samples: d.length,
  };
}

function getSummary() {
  const list = servers.map((s) => ({
    name: s.name, status: s.lastStatus || 'UNKNOWN', down: !!s.downSince,
    downForMin: s.downSince ? Math.round((Date.now() - Date.parse(s.downSince)) / 60000) : 0,
    ms: s.lastResponseMs || null, ...metrics(s),
  }));
  const down = list.filter((s) => s.down);
  const pending = proposals.filter((p) => p.status === 'pending').length;
  const withUp = list.filter((s) => s.uptime24 !== null);
  const avgUptime24 = withUp.length ? Math.round((withUp.reduce((a, s) => a + s.uptime24, 0) / withUp.length) * 10) / 10 : null;
  let score = 100 - down.length * 35 - Math.min(15, pending * 5);
  if (avgUptime24 !== null) score -= Math.round((100 - avgUptime24) * 0.5);
  score = Math.max(0, Math.min(100, score));
  const incidents24 = events.filter((e) => e.type === 'down' && Date.parse(e.t) >= Date.now() - 86400000).length;
  return { score, total: list.length, servers: list, down: down.map((s) => s.name), downCount: down.length, pending, avgUptime24, incidents24 };
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------- Owner-code gate ----------------
// Set SENTINEL_OWNER_CODE on Render to actually lock this down. Without
// it, anyone who finds the dashboard URL could approve/reject proposals —
// so until it's set, every page/response carries a loud warning instead
// of silently pretending to be protected.
function checkOwnerCode(req) {
  const configured = process.env.SENTINEL_OWNER_CODE;
  if (!configured) return 'unprotected';
  const provided = req.header('x-owner-code') || req.query.code;
  if (typeof provided !== 'string') return 'denied';
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'denied';
}

// Brute-force protection: too many wrong owner-code attempts from one IP
// and it gets temporarily locked out, with an email alert. This is
// defensive only — it blocks repeated guessing, it does NOT probe, trace,
// or take any action against the attacker's own system (that would be
// illegal regardless of who they are).
const failedAttempts = {}; // ip -> { count, firstAt, blockedUntil }
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_DURATION_MS = 30 * 60 * 1000;

function getClientIp(req) {
  // req.ip honours Express' 'trust proxy' setting (set in server.js), so it is
  // the real client address. Reading X-Forwarded-For directly would let an
  // attacker send a fresh fake value each request and never get locked out.
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function isBlocked(ip) {
  const rec = failedAttempts[ip];
  return !!(rec && rec.blockedUntil && Date.now() < rec.blockedUntil);
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  let rec = failedAttempts[ip];
  if (!rec || now - rec.firstAt > ATTEMPT_WINDOW_MS) rec = { count: 0, firstAt: now, blockedUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.blockedUntil = now + BLOCK_DURATION_MS;
    rec.count = 0;
    sendAlertEmail(
      'Aureon Sentinel: suspicious activity — IP blocked',
      `IP ${ip} entered the wrong owner code ${MAX_ATTEMPTS} times in a row and has been temporarily blocked for ${BLOCK_DURATION_MS / 60000} minutes. If this wasn't you, your owner code may be guessable — consider changing SENTINEL_OWNER_CODE on Render.`
    );
  }
  failedAttempts[ip] = rec;
}

function clearFailedAttempts(ip) { delete failedAttempts[ip]; }

function requireOwnerCode(req, res, next) {
  const ip = getClientIp(req);
  if (isBlocked(ip)) return res.status(429).json({ error: 'too many failed attempts — try again later' });
  const status = checkOwnerCode(req);
  if (status === 'denied') { recordFailedAttempt(ip); return res.status(401).json({ error: 'owner code required' }); }
  if (status === 'ok') clearFailedAttempts(ip);
  next();
}

async function sendAlertEmail(subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  // ALERT_EMAIL_TO can be one address or several comma-separated
  // (e.g. "you@gmail.com, owner@yourdomain.com") — every address in it
  // gets every alert.
  const toRaw = process.env.ALERT_EMAIL_TO;
  const to = (toRaw || '').split(',').map((s) => s.trim()).filter(Boolean);
  const from = process.env.ALERT_EMAIL_FROM || 'Aureon Sentinel <onboarding@resend.dev>';
  if (!apiKey || !to.length) {
    console.warn('[sentinel] Email alerting not configured, would have sent:', subject, '|', text);
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to, subject, text }),
    });
  } catch (e) {
    console.error('[sentinel] email send failed:', e.message);
  }
}

// ---------------- GitHub repo access (for servers hosted elsewhere) ----------------
// Reads/writes files in a remote GitHub repo via the Contents API — no
// local clone needed. A write here IS a real commit on the target branch,
// which is why it only ever happens inside the /approve route.
// A per-server token is encrypted at rest (AES-256-GCM) with a key derived from
// SENTINEL_ENC_KEY (or, if that's not set, SENTINEL_OWNER_CODE). It is never
// sent back to the dashboard — only a "token set" flag is.
function encKey() {
  const secret = process.env.SENTINEL_ENC_KEY || process.env.SENTINEL_OWNER_CODE;
  return secret ? crypto.createHash('sha256').update(secret).digest() : null;
}
function encryptToken(t) {
  const k = encKey();
  if (!k) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return 'v1:' + [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}
function decryptToken(str) {
  try {
    const k = encKey();
    if (!k || !str || !str.startsWith('v1:')) return null;
    const [iv, tag, enc] = str.slice(3).split(':').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (e) { return null; }
}
function publicServer(sv) {
  const { ghToken, ghTokenEnc, history, ...rest } = sv;
  return {
    ...rest, ...metrics(sv), spark: (history || []).slice(-48).map((x) => x[1]),
    downForMin: sv.downSince ? Math.max(0, Math.round((Date.now() - Date.parse(sv.downSince)) / 60000)) : null,
    ghTokenSet: !!(ghToken || ghTokenEnc),
  };
}
function githubToken(server) {
  return (server.ghTokenEnc && decryptToken(server.ghTokenEnc)) || server.ghToken || process.env.GITHUB_TOKEN;
}

async function githubApi(server, pathSuffix, opts) {
  const token = githubToken(server);
  if (!token) throw new Error('No GitHub token configured (set one on the server or GITHUB_TOKEN env var)');
  const res = await fetch(`https://api.github.com/repos/${server.ghRepo}${pathSuffix}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...(opts && opts.headers),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function githubListFiles(server) {
  const folder = (server.ghPath || '').replace(/^\/|\/$/g, '');
  const ref = server.ghBranch || 'main';
  // ONE call returns the whole repo tree (all subfolders)
  const tree = await githubApi(server, `/git/trees/${encodeURIComponent(ref)}?recursive=1`, { method: 'GET' });
  if (!tree || !Array.isArray(tree.tree)) return [];
  if (tree.truncated) console.warn('[sentinel] repo tree truncated by GitHub — very large repo, set a Folder to narrow it');
  const prefix = folder ? folder + '/' : '';
  return tree.tree
    .filter((t) => t.type === 'blob' && t.path.startsWith(prefix))
    .map((t) => ({ name: t.path.slice(prefix.length), size: t.size || 0 }))
    .filter((f) => lib.isSourceFile(f.name, f.size));
}

async function githubReadFile(server, repoFilePath) {
  const ref = server.ghBranch || 'main';
  const data = await githubApi(server, `/contents/${repoFilePath}?ref=${encodeURIComponent(ref)}`, { method: 'GET' });
  let b64 = data.content;
  if (!b64 && data.sha) {
    // Contents API returns no body for files over 1 MB — fetch the git blob instead.
    const blob = await githubApi(server, `/git/blobs/${data.sha}`, { method: 'GET' });
    b64 = blob.content;
  }
  const content = Buffer.from(b64 || '', 'base64').toString('utf8');
  return { content, sha: data.sha };
}

async function githubWriteFile(server, repoFilePath, newContent, sha, message) {
  const ref = server.ghBranch || 'main';
  return githubApi(server, `/contents/${repoFilePath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || 'Aureon Sentinel: approved fix',
      content: Buffer.from(newContent, 'utf8').toString('base64'),
      sha,
      branch: ref,
    }),
  });
}

function hasPendingProposalFor(serverId, kind, key) {
  return proposals.some(
    (p) => p.status === 'pending' && p.serverId === serverId && p.kind === kind &&
      (kind === 'patch' ? (p.key === key || p.filePath === key) : p.webhookUrl === key)
  );
}

// ---------------- Unified code-source access ----------------
// Both "self" (local filesystem) and "github" (remote repo via API) servers
// go through these three functions, so the AI-diagnosis and proactive-scan
// logic below doesn't need to care which one it's dealing with.
async function listServerFilesDetailed(server, hintText) {
  let files = [];
  if (server.type === 'github') {
    try { files = await githubListFiles(server); }
    catch (e) { console.warn('[sentinel] github list failed:', e.message); return []; }
  } else {
    const dir = server.localPath;
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    files = lib.walkLocal(dir);
  }
  return lib.rankFiles(files, hintText);
}
async function listServerFiles(server, hintText) {
  return (await listServerFilesDetailed(server, hintText)).map((f) => f.name);
}

async function readServerFile(server, name) {
  let content, key, meta;
  if (server.type === 'github') {
    const folder = (server.ghPath || '').replace(/^\/|\/$/g, '');
    const repoFilePath = folder ? `${folder}/${name}` : name;
    const r = await githubReadFile(server, repoFilePath);
    content = r.content;
    key = `github:${server.ghRepo}:${repoFilePath}`;
    meta = { repoFilePath, sha: r.sha };
  } else {
    const filePath = path.join(server.localPath, name);
    content = fs.readFileSync(filePath, 'utf8');
    key = filePath;
    meta = { filePath };
  }

  // Diff/version tracking: note it in the changelog whenever a file's
  // content differs from the last time Sentinel read it (first time
  // seeing a file just sets the baseline, no log entry).
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  if (snapshots[key] !== hash) {
    if (snapshots[key]) { // changed since last time -> log WHAT changed
      let diff = null, stats = null, note = null;
      const old = await loadSnap(key);
      if (old !== null) {
        const d = lib.makeDiff(old, content, { maxRows: 120 });
        diff = d.hunks; stats = { added: d.added, removed: d.removed, truncated: d.truncated };
      } else {
        note = 'Pichhla content save nahi tha — ab se line-by-line diff dikhega.';
      }
      changeLog.unshift({ serverId: server.id, serverName: server.name, file: name, changedAt: new Date().toISOString(), diff, stats, note });
      changeLog = changeLog.slice(0, 40);
      persistChangelog();
    }
    snapshots[key] = hash;
    persistSnapshots();
    saveSnap(key, content);
  }

  return { content, key, meta };
}

function buildPatchProposal(server, source, name, explanation, oldFile, newContent) {
  const base = {
    id: newId(),
    serverId: server.id,
    serverName: server.name,
    kind: 'patch',
    source,
    description: `${source === 'proactive-ai' ? 'Proactive review found a bug in' : 'AI-diagnosed fix for'} ${name}: ${explanation}`,
    oldContent: oldFile.content,
    newContent,
    key: oldFile.key,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  const d = lib.makeDiff(oldFile.content, newContent, { maxRows: 400 });
  base.diff = d.hunks;
  base.stats = { added: d.added, removed: d.removed, truncated: d.truncated };
  if (server.type === 'github') {
    return { ...base, target: 'github', filePath: `${server.ghRepo}/${oldFile.meta.repoFilePath}`, ghRepo: server.ghRepo, ghBranch: server.ghBranch || 'main', ghFilePath: oldFile.meta.repoFilePath, ghSha: oldFile.meta.sha };
  }
  return { ...base, target: 'local', filePath: oldFile.meta.filePath };
}

// ---- shared AI helpers --------------------------------------------------
async function callLLM(prompt) {
  const keys = require('./keys').groqKeys();
  if (!keys.length) return null;
  let data = null;
  for (const apiKey of keys) {   // ek key fail/limit ho to agli
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
      });
      const d = await res.json();
      if (res.ok && d && d.choices) { data = d; break; }
    } catch (e) { /* next key */ }
  }
  let raw = (data?.choices?.[0]?.message?.content || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  try { return JSON.parse(raw); } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/); // model added chatter around the JSON
    if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ } }
    return null;
  }
}

const PER_FILE_CAP = 9000;   // chars of one file shown to the model
const BATCH_BUDGET = 14000;  // chars of code per model call

async function bundleFiles(server, batch) {
  let combined = '';
  const included = [];
  for (const f of batch) {
    try {
      const r = await readServerFile(server, f.name);
      const shown = r.content.length > PER_FILE_CAP ? r.content.slice(0, PER_FILE_CAP) + '\n...[file continues — only the part above is shown]' : r.content;
      combined += `\n\n----- FILE: ${f.name} -----\n${shown}`;
      included.push(f.name);
    } catch (e) { /* unreadable file: skip */ }
  }
  return { combined, included };
}

const EDIT_RULES = `HOW TO PROPOSE A FIX: give small "edits", NOT the whole file. Each edit is {"find": "<exact existing snippet copied character-for-character from the code above, including indentation>", "replace": "<the fixed snippet>"}. "find" must appear exactly ONCE in that file (include a neighbouring line if needed to make it unique). Keep edits minimal (a few lines), at most 4 per finding. Never rewrite or reformat the whole file.`;

// Turn the model's edits into a validated proposal (or null).
async function proposalFromEdits(server, source, name, explanation, edits) {
  const oldFile = await readServerFile(server, name);
  if (hasPendingProposalFor(server.id, 'patch', oldFile.key)) return null;
  const applied = lib.applyEdits(oldFile.content, edits);
  if (!applied.ok) { console.warn('[sentinel] edit rejected for', name + ':', applied.error); return null; }
  const bad = lib.validateNew(name, oldFile.content, applied.content);
  if (bad) { console.warn('[sentinel] fix rejected for', name + ':', bad); return null; }
  return buildPatchProposal(server, source, name, explanation, oldFile, applied.content);
}

// Tries real AI diagnosis first (reads the error + the server's own code,
// asks an LLM to find and fix the specific bug). The model is explicitly
// told to say "not confident" rather than guess when the cause isn't
// visible in the code shown (e.g. a network blip, a missing env var, an
// external service being down) — those return null here and the caller
// falls back to the narrower pattern-match check below. Either way, this
// function only ever returns a *proposal*; nothing is written/committed.
async function generateAIFixProposal(server, errorMessage) {
  if (!process.env.GROQ_API_KEY) return null;
  const files = await listServerFilesDetailed(server, errorMessage);
  if (!files.length) return null;
  const batch = lib.chunkFiles(files, BATCH_BUDGET, PER_FILE_CAP)[0]; // files named in the error come first
  const { combined, included } = await bundleFiles(server, batch);
  if (!combined) return null;
  const { hints } = lib.detectStack(files.map((f) => f.name));
  const is404 = /HTTP_404/.test(String(errorMessage));

  const prompt = `You are a careful senior engineer. A web service just failed its health check with this error:

ERROR: ${errorMessage}
${is404 ? '\nNote: the health URL answered 404 — very often the app simply has no route at that path (e.g. /health). If that is what the code shows, the fix is to add a minimal health route in the same framework style.\n' : ''}
Stack-specific things to watch for:
${hints || '(general)'}

Here is its source code:
${combined}

Diagnose the SPECIFIC bug causing this error, ONLY if it is visible in the code above. If the cause could be something outside this code (network issue, missing environment variable, a dependency/service being down, a sleeping free-tier instance, insufficient information), do NOT guess — say you are not confident instead.

${EDIT_RULES}

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"confident": true or false, "file": "<exact file path from the list above, or null>", "explanation": "<1-2 sentences in Hindi/Hinglish: the bug and the fix in plain language>", "edits": [{"find": "...", "replace": "..."}]}`;

  try {
    const parsed = await callLLM(prompt);
    if (!parsed || !parsed.confident || !parsed.file || !Array.isArray(parsed.edits)) return null;
    if (!included.includes(parsed.file)) return null;
    return await proposalFromEdits(server, 'reactive-ai', parsed.file, parsed.explanation, parsed.edits);
  } catch (e) {
    console.warn('[sentinel] AI diagnosis skipped/failed:', e.message);
    return null;
  }
}

// Proactive scan — runs even when a server is healthy, reviews its own
// code for real bugs (not style nitpicks), and proposes fixes for the
// ones it's confident about. Same rule as reactive diagnosis: if it isn't
// sure, it reports nothing rather than inventing minor complaints. Only
// ever produces proposals — never writes/commits on its own.
async function generateProactiveFindings(server) {
  if (!process.env.GROQ_API_KEY) return [];
  const files = await listServerFilesDetailed(server, '');
  if (!files.length) return [];
  const batches = lib.chunkFiles(files, BATCH_BUDGET, PER_FILE_CAP);
  const BATCHES_PER_RUN = 2;                      // keeps each run small (API rate limits); the rest is covered on the next runs
  let cursor = server.scanCursor || 0;
  if (cursor >= batches.length) cursor = 0;
  const proposalsOut = [];

  for (let k = 0; k < Math.min(BATCHES_PER_RUN, batches.length); k++) {
    const idx = (cursor + k) % batches.length;
    const { combined, included } = await bundleFiles(server, batches[idx]);
    if (!combined) continue;
    const { hints } = lib.detectStack(included);

    const prompt = `You are a careful senior engineer doing a routine code review (the service is running fine — you are looking for problems BEFORE they cause an outage or a breach, not reacting to one).

Stack-specific things to watch for:
${hints || '(general)'}

Here is the code (part ${idx + 1} of ${batches.length} of the project):
${combined}

Find up to 3 REAL issues only, in two categories:
- Bugs: unhandled errors/rejections, null/None access, resource or memory leaks, race conditions, broken error handling.
- Security: hardcoded keys/secrets/passwords, injection (SQL/NoSQL/command/template), missing authentication or authorization on sensitive routes, path traversal, XSS, unsafe deserialization, missing validation of user input that reaches a risky sink.

Do NOT report style, formatting or naming. If you are not genuinely confident something is a real bug or vulnerability, leave it out. Returning zero findings is fine.

${EDIT_RULES}

Respond with ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"findings": [{"file": "<exact file path from above>", "explanation": "<1-2 sentences in Hindi/Hinglish>", "edits": [{"find": "...", "replace": "..."}]}]}`;

    try {
      const parsed = await callLLM(prompt);
      const findings = parsed && Array.isArray(parsed.findings) ? parsed.findings.slice(0, 3) : [];
      for (const f of findings) {
        if (!f || !f.file || !included.includes(f.file) || !Array.isArray(f.edits)) continue;
        const p = await proposalFromEdits(server, 'proactive-ai', f.file, f.explanation, f.edits);
        if (p) proposalsOut.push(p);
      }
    } catch (e) {
      console.warn('[sentinel] Proactive scan skipped/failed:', e.message);
    }
  }
  server.scanCursor = (cursor + BATCHES_PER_RUN) % batches.length;
  server.lastScan = { at: new Date().toISOString(), files: files.length, batches: batches.length };
  persistServers();
  return proposalsOut;
}

async function runProactiveScanCycle() {
  await ready;
  let changed = false;
  for (const server of servers) {
    if (server.type !== 'self' && server.type !== 'github') continue;
    const found = await generateProactiveFindings(server);
    if (found.length) {
      proposals.push(...found);
      changed = true;
      await sendAlertEmail(
        `Aureon Sentinel: proactive review found ${found.length} issue(s) in ${server.name}`,
        found.map((p) => `- ${p.description}`).join('\n') +
          '\n\nOpen the Sentinel dashboard to approve or reject. Nothing has been changed yet.'
      );
    }
  }
  if (changed) persistProposals();
}

const PROACTIVE_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
setInterval(() => {
  runProactiveScanCycle().catch((e) => console.error('[sentinel] proactive cycle failed:', e.message));
}, PROACTIVE_SCAN_INTERVAL_MS);

// Deliberately narrow and explainable fallback for "self" (local) servers
// only, used when AI diagnosis above isn't configured, isn't confident, or
// fails. NEVER applied automatically — only ever proposed.
function scanForProposals(server) {
  if (server.type !== 'self' || !server.localPath) return [];
  const dir = server.localPath;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const found = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('unhandledRejection')) {
      if (hasPendingProposalFor(server.id, 'patch', filePath)) continue;
      const addition =
        "\n\nprocess.on('unhandledRejection', (reason) => {\n  console.error('[Sentinel] Unhandled rejection:', reason);\n});\n";
      found.push({
        id: newId(),
        serverId: server.id,
        serverName: server.name,
        kind: 'patch',
        source: 'reactive-pattern',
        target: 'local',
        description: `Add missing unhandledRejection guard to ${file}`,
        filePath,
        oldContent: content,
        newContent: content + addition,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    }
  }
  return found;
}

async function pingOnce(url, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.message, timeout: e.name === 'AbortError', ms: Date.now() - started };
  } finally { clearTimeout(t); }
}

// ---------------- v28: link se add (website / GitHub repo) + GitHub-only health (CI) ----------------
function isPrivateHost(h) {
  h = String(h || '').toLowerCase();
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.startsWith('[') ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^(fc|fd|fe80)/i.test(h);
}
// Repo-only server (no hosted URL needed): checks via GitHub API that the repo exists + latest GitHub Actions run. Read-only, changes nothing.
async function checkGithubOnly(server) {
  const started = Date.now(), token = githubToken(server);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'aureon-sentinel', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  const get = async (p) => {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
    try { const r = await fetch('https://api.github.com/repos/' + server.ghRepo + p, { headers, signal: c.signal }); return { r, j: r.ok ? await r.json().catch(() => null) : null }; }
    finally { clearTimeout(t); }
  };
  let ok = false;
  try {
    const repo = await get('');
    if (repo.r.status === 404) { server.lastStatus = 'DOWN'; server.lastError = token ? 'repo nahi mila ya token ko access nahi' : 'repo nahi mila — private ho to Render me GITHUB_TOKEN set karo'; }
    else if (repo.r.status === 403 || repo.r.status === 429) { server.lastStatus = 'HTTP_' + repo.r.status; server.lastError = 'GitHub rate limit — Render me GITHUB_TOKEN jodo'; }
    else if (!repo.r.ok || !repo.j) { server.lastStatus = 'HTTP_' + repo.r.status; server.lastError = 'GitHub ne HTTP ' + repo.r.status + ' diya'; }
    else {
      const info = { pushedAt: repo.j.pushed_at, openIssues: repo.j.open_issues_count, archived: !!repo.j.archived, isPrivate: !!repo.j.private, defaultBranch: repo.j.default_branch, homepage: repo.j.homepage || '' };
      try {
        const runs = await get('/actions/runs?per_page=1' + (server.ghBranch ? '&branch=' + encodeURIComponent(server.ghBranch) : ''));
        const run = runs.j && runs.j.workflow_runs && runs.j.workflow_runs[0];
        if (run) { info.ci = run.status === 'completed' ? run.conclusion : run.status; info.ciName = String(run.name || '').slice(0, 60); }
      } catch (e) { /* CI info optional */ }
      server.ghInfo = info;
      if (info.ci === 'failure' || info.ci === 'timed_out') { server.lastStatus = 'CI_FAILING'; server.lastError = 'Latest GitHub Actions run fail hui' + (info.ciName ? ': ' + info.ciName : ''); }
      else { ok = true; server.lastStatus = 'HEALTHY'; server.lastError = null; }
    }
  } catch (e) { server.lastStatus = 'DOWN'; server.lastError = e.name === 'AbortError' ? 'GitHub 15s me jawab nahi diya' : e.message; }
  const ms = Date.now() - started; server.lastResponseMs = ms; server.lastCheckedAt = new Date().toISOString();
  recordSample(server, { ok, ms });
  return ok;
}

async function checkServer(server) {
  if (server.ghOnly) return checkGithubOnly(server);
  let r = await pingOnce(server.healthUrl, 8000);
  // Render/Heroku free instances sleep when idle and need up to ~50 s to wake.
  // Don't call that an outage (and don't trigger AI "fixes") — wake it and re-check once.
  if (!r.ok && (r.timeout || r.status === 502 || r.status === 503 || r.status === 504 || r.error)) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    r = await pingOnce(server.healthUrl, 50000);
  }
  server.lastCheckedAt = new Date().toISOString();
  if (r.ok) { server.lastStatus = 'HEALTHY'; server.lastResponseMs = r.ms; server.lastError = null; }
  else if (r.status) { server.lastStatus = `HTTP_${r.status}`; server.lastResponseMs = r.ms; server.lastError = `HTTP ${r.status}`; }
  else { server.lastStatus = 'DOWN'; server.lastError = r.timeout ? 'no response in 50s (instance may be crashed or still waking)' : r.error; }
  recordSample(server, r);

  // Website certificate expiry (checked every 6 hours)
  try {
    const u = new URL(server.healthUrl);
    if (u.protocol === 'https:' && (!server.sslCheckedAt || Date.now() - Date.parse(server.sslCheckedAt) > 6 * 3600 * 1000)) {
      server.sslDays = await lib.sslDaysLeft(u.hostname);
      server.sslCheckedAt = new Date().toISOString();
      if (server.sslDays !== null && server.sslDays <= 14 && (!server.sslAlertAt || Date.now() - Date.parse(server.sslAlertAt) > 3 * 86400000)) {
        server.sslAlertAt = new Date().toISOString();
        await sendAlertEmail(`Aureon Sentinel: SSL certificate of ${server.name} expires in ${server.sslDays} day(s)`, `${u.hostname} — renew the certificate before it expires or the site will show a security warning.`);
      }
    }
  } catch (e) { /* bad URL — ignore */ }
  return r.ok;
}

async function runMonitorCycle() {
  await ready;
  let changed = false;
  for (const server of servers) {
    const prevDownSince = server.downSince;
    const ok = await checkServer(server);
    if (ok && prevDownSince) {
      const mins = Math.max(1, Math.round((Date.now() - Date.parse(prevDownSince)) / 60000));
      await sendAlertEmail(`Aureon Sentinel: ${server.name} is back UP ✅`, `${server.name} is healthy again after about ${mins} minute(s) of downtime.`);
    }
    if (!ok) {
      // One alert per outage, then a reminder every SENTINEL_REMIND_MIN (default 60) while it stays down —
      // instead of a new email + a new AI diagnosis every 5 minutes.
      const remind = !!prevDownSince && Date.now() - (server.lastAlertAt || 0) >= REMIND_MS;
      if (prevDownSince && !remind) continue;
      server.lastAlertAt = Date.now();
      if (server.ghOnly) {   // repo-only check: AI fix proposal nahi, sirf alert (kuch change nahi hota)
        await sendAlertEmail(`Aureon Sentinel: ${server.name} — GitHub check fail`, `${server.lastError || server.lastStatus}\nGitHub Actions / repo kholke dekho. Sentinel ne kuch change nahi kiya.`);
        continue;
      }
      if (server.type === 'self' || server.type === 'github') {
        const aiProposal = await generateAIFixProposal(server, server.lastError || server.lastStatus);
        const newProposals = aiProposal ? [aiProposal] : scanForProposals(server);
        if (newProposals.length) {
          proposals.push(...newProposals);
          newProposals.forEach((p) => logEvent('proposal', server, 'fix proposed — ' + String(p.description || '').slice(0, 120)));
          changed = true;
          await sendAlertEmail(
            `Aureon Sentinel: ${newProposals.length} fix(es) proposed for ${server.name}`,
            newProposals.map((p) => `- ${p.description} (${p.filePath})`).join('\n') +
              '\n\nOpen the Sentinel dashboard to approve or reject. Nothing has been changed yet.'
          );
        } else {
          await sendAlertEmail(
            `Aureon Sentinel: ${server.name} is DOWN`,
            `Health check failed: ${server.lastError || server.lastStatus}\nNo fix matched a known pattern — needs a human look.`
          );
        }
      } else if (server.type === 'external') {
        if (server.restartWebhookUrl && !hasPendingProposalFor(server.id, 'restart', server.restartWebhookUrl)) {
          proposals.push({
            id: newId(),
            serverId: server.id,
            serverName: server.name,
            kind: 'restart',
            source: 'reactive-external',
            description: `Call restart webhook for ${server.name} (currently DOWN)`,
            webhookUrl: server.restartWebhookUrl,
            status: 'pending',
            createdAt: new Date().toISOString(),
          });
          changed = true;
          await sendAlertEmail(
            `Aureon Sentinel: ${server.name} is DOWN — restart proposed`,
            `Open the Sentinel dashboard to approve or reject calling its restart webhook. Nothing has been triggered yet.`
          );
        } else {
          await sendAlertEmail(
            `Aureon Sentinel: ${server.name} is DOWN`,
            `No restart webhook configured for it — add one on the dashboard, or fix it manually.`
          );
        }
      }
    }
  }
  persistServers();
  if (changed) persistProposals();
}

const CHECK_INTERVAL_MS = (Number(process.env.SENTINEL_CHECK_MIN) >= 1 ? Number(process.env.SENTINEL_CHECK_MIN) : 5) * 60 * 1000; // default every 5 min
setInterval(() => {
  runMonitorCycle().catch((e) => console.error('[sentinel] cycle failed:', e.message));
}, CHECK_INTERVAL_MS);
// first reading shortly after boot, so history/sparklines start filling right away
setTimeout(() => { runMonitorCycle().catch((e) => console.error('[sentinel] first cycle failed:', e.message)); }, 20000);

// ---------------- API ----------------
// Every route below the dashboard page itself requires the owner code
// (as the x-owner-code header, which the dashboard page's own JS sends
// automatically once you've unlocked it).
router.use((req, res, next) => {
  if (req.path === '/dashboard' || req.path === '/ava-lab' || req.path === '/ava-desk') return next(); // the pages themselves run the login flow (auth.dashboard)
  return auth.apiGate(req, res, (err) => {
    if (err) return next(err);
    // v9 operators: viewer/analyst may only read here; anything that changes state (Sentinel, Ava, Studio, Boss, desk chat) needs admin
    if (req.method === 'GET' || req.method === 'HEAD' || !auth.requireRole) return next();
    return auth.requireRole('admin')(req, res, next);
  });
});

// ---------------- Ava Lab: Ava writes her own upgrades, you approve (see backend/ava-self.js, AVA-LAB.md) ----------------
try {
  const avaSelf = require('./ava-self')({ lib, auth, store, DATA_DIR, callLLM, logEvent });
  router.use('/ava', avaSelf.router);
  router.get('/ava-lab', (req, res) => auth.dashboard(req, res, () => res.redirect(302, '/api/sentinel/ava-desk'))); // Ava Lab now lives inside Ava Desktop
} catch (e) { console.error('[sentinel] Ava Lab disabled:', e.message); }

// ---------------- Ava Studio: multi-pass professional projects + "best UI" tournament (backend/ava-studio.js) ----------------
try {
  const avaStudio = require('./ava-studio')({ auth, DATA_DIR, callLLM, logEvent });
  router.use('/ava-studio', avaStudio.router);
} catch (e) { console.error('[sentinel] Ava Studio disabled:', e.message); }

// ---------------- HTML Maker: Ava writes a complete standalone HTML page (backend/html-maker.js) ----------------
try {
  const htmlMaker = require('./html-maker')({ auth, DATA_DIR, logEvent });
  router.use('/ava-html', htmlMaker.router);
} catch (e) { console.error('[sentinel] HTML Maker disabled:', e.message); }

// ---------------- Boss Orders: owner priority order queue, never silently dropped (backend/boss-orders.js) ----------------
try {
  const boss = require('./boss-orders')({ auth, DATA_DIR, logEvent });
  router.use('/boss', boss.router);
} catch (e) { console.error('[sentinel] Boss Orders disabled:', e.message); }

// ---------------- Ava Desktop: the full-screen desktop dashboard (backend/ava-desk.js + ava-desk.html) ----------------
try {
  const avaDesk = require('./ava-desk')({ auth, getSummary, getEvents: () => events });
  router.use(avaDesk.router);   // /ava-desk (page, behind the same login), /ava-desk/data|world|chat|forecast (behind apiGate)
} catch (e) { console.error('[sentinel] Ava Desktop disabled:', e.message); }

router.get('/servers', (req, res) => res.json(servers.map(publicServer)));

router.post('/servers', (req, res) => {
  const { name, healthUrl, type, localPath, restartWebhookUrl, ghRepo, ghBranch, ghPath, ghToken } = req.body || {};
  if (!name || !healthUrl || !type) {
    return res.status(400).json({ error: 'name, healthUrl, type are required' });
  }
  if (!['self', 'external', 'github'].includes(type)) {
    return res.status(400).json({ error: "type must be 'self', 'external', or 'github'" });
  }
  if (type === 'github' && !ghRepo) {
    return res.status(400).json({ error: "ghRepo (owner/repo) is required for type 'github'" });
  }
  const server = {
    id: newId(),
    name,
    healthUrl,
    type,
    localPath: type === 'self' ? (localPath || null) : null,
    restartWebhookUrl: type === 'external' ? (restartWebhookUrl || null) : null,
    ghRepo: type === 'github' ? ghRepo : null,
    ghBranch: type === 'github' ? (ghBranch || 'main') : null,
    ghPath: type === 'github' ? (ghPath || '') : null,
    ghToken: null,
    ghTokenEnc: null,
    lastStatus: 'UNKNOWN',
  };
  if (type === 'github' && ghToken) {
    // optional per-repo override of the GITHUB_TOKEN env var
    const enc = encryptToken(ghToken);
    if (enc) server.ghTokenEnc = enc; else server.ghToken = ghToken; // no secret configured -> can't encrypt
  }
  servers.push(server);
  persistServers();
  res.json(publicServer(server));
});

// ---------------- v28 routes: /servers/quick (link se add) and /project-check (zip, kuch run nahi hota) ----------------
let projectCheck = null; try { projectCheck = require('./project-check'); } catch (e) { console.error('[sentinel] project-check disabled:', e.message); }
router.post('/servers/quick', async (req, res) => {
  let link = String((req.body || {}).link || '').trim().slice(0, 300);
  if (!link) return res.status(400).json({ error: 'link likho (website ya GitHub repo)' });
  if (!/^https?:\/\//i.test(link)) link = /^[\w.-]+\/[\w.-]+$/.test(link) ? 'https://github.com/' + link : 'https://' + link;
  let u; try { u = new URL(link); } catch (e) { return res.status(400).json({ error: 'link samajh nahi aaya' }); }
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return res.status(400).json({ error: 'sirf public website / GitHub link (localhost ya private address nahi)' });
  const host = u.hostname.toLowerCase(), seg = u.pathname.split('/').filter(Boolean), added = [], notes = [];
  const base = { localPath: null, restartWebhookUrl: null, ghRepo: null, ghBranch: null, ghPath: null, ghToken: null, ghTokenEnc: null, lastStatus: 'UNKNOWN' };
  if (/^(www\.)?github\.com$/.test(host)) {
    if (seg.length < 2) return res.status(400).json({ error: 'GitHub link me owner/repo chahiye (jaise github.com/pavan/myapp)' });
    const owner = seg[0], repo = seg[1].replace(/\.git$/i, ''), full = owner + '/' + repo;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return res.status(400).json({ error: 'GitHub owner/repo ka naam galat hai' });
    if (servers.some((s) => s.ghRepo && s.ghRepo.toLowerCase() === full.toLowerCase())) return res.status(409).json({ error: full + ' pehle se Sentinel me hai' });
    const sv = { ...base, id: newId(), name: repo, healthUrl: 'https://github.com/' + full, type: 'github', ghRepo: full, ghBranch: seg[2] === 'tree' && seg[3] ? seg[3] : '', ghPath: seg[2] === 'tree' ? seg.slice(4).join('/') : '', ghOnly: true };
    await checkGithubOnly(sv);
    if (sv.lastStatus === 'DOWN' && !sv.ghInfo) return res.status(400).json({ error: sv.lastError || 'repo nahi mila' });
    if (!sv.ghBranch) sv.ghBranch = (sv.ghInfo && sv.ghInfo.defaultBranch) || 'main';
    servers.push(sv); added.push(sv);
    const hp = sv.ghInfo && sv.ghInfo.homepage;
    if (hp) { try { const hu = new URL(hp); if (/^https?:$/.test(hu.protocol) && !isPrivateHost(hu.hostname) && !servers.some((s) => s.healthUrl === hu.href)) { const web = { ...base, id: newId(), name: repo + ' (website)', healthUrl: hu.href, type: 'external' }; servers.push(web); added.push(web); notes.push('Repo ki website bhi add ho gayi: ' + hu.href); } } catch (e) { /* bad homepage */ } }
    notes.push(sv.lastStatus === 'HEALTHY' ? 'Repo theek hai' + (sv.ghInfo && sv.ghInfo.ci ? ' (CI: ' + sv.ghInfo.ci + ')' : ' (is repo me GitHub Actions nahi mile)') : (sv.lastError || sv.lastStatus));
  } else {
    if (servers.some((s) => s.healthUrl && s.healthUrl.replace(/\/$/, '') === u.href.replace(/\/$/, ''))) return res.status(409).json({ error: 'ye link pehle se Sentinel me hai' });
    const sv = { ...base, id: newId(), name: host.replace(/^www\./, ''), healthUrl: u.href, type: 'external' };
    const p = await pingOnce(u.href, 10000); sv.lastCheckedAt = new Date().toISOString();
    if (p.ok) { sv.lastStatus = 'HEALTHY'; sv.lastResponseMs = p.ms; } else { sv.lastStatus = p.status ? 'HTTP_' + p.status : 'UNKNOWN'; sv.lastError = p.status ? 'HTTP ' + p.status : (p.error || 'jawab nahi aaya'); }
    servers.push(sv); added.push(sv);
    notes.push(p.ok ? 'Website chal rahi hai (' + p.ms + ' ms)' : 'Abhi jawab nahi aaya — Sentinel har 5 min check karega (so rahi ho to jaag jayegi)');
  }
  persistServers();
  res.json({ ok: true, added: added.map(publicServer), notes });
});
router.post('/project-check', express.json({ limit: '36mb' }), (req, res) => {
  if (!projectCheck) return res.status(503).json({ error: 'project-check module load nahi hua' });
  const b = req.body || {}; let buf; try { buf = Buffer.from(String(b.data || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch (e) { buf = null; }
  if (!buf || buf.length < 22) return res.status(400).json({ error: 'zip khaali hai' });
  if (buf.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'zip 25 MB se badi hai' });
  try { res.json({ ok: true, name: String(b.name || 'project.zip').replace(/[^\w.\- ]/g, '_').slice(0, 80), report: projectCheck.checkZip(buf) }); }
  catch (e) { res.status(400).json({ error: String(e.message).slice(0, 160) }); }
});

router.delete('/servers/:id', (req, res) => {
  servers = servers.filter((s) => s.id !== req.params.id);
  persistServers();
  res.json({ ok: true });
});

router.get('/proposals', (req, res) => res.json(proposals.map((p) => {
  const { oldContent, newContent, ...rest } = p;   // diff is what the dashboard needs; full file bodies stay on the server
  return rest;
})));

router.get('/changes', (req, res) => res.json(changeLog));
router.get('/summary', (req, res) => res.json(getSummary()));
router.get('/events', (req, res) => res.json(events.slice(0, 60)));

// ---------------- v12: deploy watch + rollback proposal ----------------
// After you Approve a GitHub fix, Render redeploys. Sentinel then pings the server's health URL every 2 minutes (up to
// 8 times). First healthy answer = "deploy OK". If it never comes back, Sentinel does NOT auto-revert — it creates a NEW
// pending "ROLLBACK" proposal (previous file version) that you approve like any other fix. The watch list is persisted
// because a redeploy of Aureon's own backend restarts this very process.
const DEPLOY_EVERY_MS = 2 * 60000, DEPLOY_MAX_CHECKS = 8;
function schedulePostDeploy(p, server, commitSha) {
  if (!server || !server.healthUrl || !commitSha) return;
  postDeploy.push({ id: newId(), proposalId: p.id, serverId: server.id, serverName: server.name, ghRepo: p.ghRepo, ghBranch: p.ghBranch, ghFilePath: p.ghFilePath, commitSha, description: String(p.description || '').slice(0, 160), due: Date.now() + 3 * 60000, checks: 0 });
  persist('postdeploy');
  logEvent('deploy_watch', server, 'deploy ko watch kar raha hu (commit ' + String(commitSha).slice(0, 7) + ')');
}
async function buildRollbackProposal(w, server) {
  if (proposals.some((x) => x.status === 'pending' && x.rollbackOf === w.commitSha)) return null;
  const target = { ...server, ghRepo: w.ghRepo, ghBranch: w.ghBranch };
  const commit = await githubApi(target, `/commits/${w.commitSha}`, { method: 'GET' });
  const parent = commit && commit.parents && commit.parents[0] && commit.parents[0].sha;
  if (!parent) throw new Error('commit ka parent nahi mila');
  const prev = await githubApi(target, `/contents/${w.ghFilePath}?ref=${parent}`, { method: 'GET' });
  const prevContent = Buffer.from(prev.content || '', 'base64').toString('utf8');
  const cur = await githubReadFile(target, w.ghFilePath);
  if (cur.content === prevContent) return null; // someone already reverted
  const d = lib.makeDiff(cur.content, prevContent, { maxRows: 400 });
  return {
    id: newId(), serverId: server.id, serverName: server.name, kind: 'patch', source: 'rollback', rollbackOf: w.commitSha, target: 'github',
    description: `ROLLBACK: fix deploy hone ke baad ${server.name} ${DEPLOY_MAX_CHECKS} checks me bhi UP nahi aaya — ${w.ghFilePath} ko pichhle version par wapas laao (commit ${String(w.commitSha).slice(0, 7)} ke pehle ka).`,
    oldContent: cur.content, newContent: prevContent, key: `github:${w.ghRepo}:${w.ghFilePath}`,
    ghRepo: w.ghRepo, ghBranch: w.ghBranch, ghFilePath: w.ghFilePath, ghSha: cur.sha, filePath: `${w.ghRepo}/${w.ghFilePath}`,
    status: 'pending', createdAt: new Date().toISOString(), diff: d.hunks, stats: { added: d.added, removed: d.removed, truncated: d.truncated },
  };
}
let deployBusy = false;
async function deployWatchTick() {
  if (deployBusy || !postDeploy.length) return;
  deployBusy = true;
  try {
    await ready;
    for (const w of postDeploy.slice()) {
      if (Date.now() < w.due) continue;
      const server = servers.find((x) => x.id === w.serverId);
      if (!server || !server.healthUrl) { postDeploy = postDeploy.filter((x) => x !== w); persist('postdeploy'); continue; }
      const r = await pingOnce(server.healthUrl, 20000);
      w.checks++;
      if (r.ok) {
        postDeploy = postDeploy.filter((x) => x !== w); persist('postdeploy');
        logEvent('deploy_ok', server, 'deploy theek — server healthy (' + w.checks + '. check)');
        await sendAlertEmail(`Aureon Sentinel: deploy OK ✅ — ${server.name}`, `${w.description}\n\n${server.name} deploy ke baad healthy hai.`);
      } else if (w.checks >= DEPLOY_MAX_CHECKS) {
        postDeploy = postDeploy.filter((x) => x !== w); persist('postdeploy');
        logEvent('deploy_bad', server, 'deploy ke baad UP nahi aaya — rollback proposal bana raha hu');
        try {
          const rb = await buildRollbackProposal(w, server);
          if (rb) { proposals.push(rb); persistProposals(); }
          await sendAlertEmail(`Aureon Sentinel: ${server.name} deploy ke baad DOWN ❌`, `${w.description}\n\n${server.name} ${DEPLOY_MAX_CHECKS} checks me bhi healthy nahi hua.\n` + (rb ? 'Maine ek ROLLBACK proposal banaya hai — Sentinel dashboard me Approve karo.' : 'Rollback proposal nahi ban paya — GitHub me khud revert karo.'));
        } catch (e) {
          await sendAlertEmail(`Aureon Sentinel: ${server.name} deploy ke baad DOWN ❌`, `${w.description}\n\nRollback proposal banane me error: ${e.message}\nGitHub me khud revert karo.`);
        }
      } else { w.due = Date.now() + DEPLOY_EVERY_MS; persist('postdeploy'); }
    }
  } catch (e) { console.error('[sentinel] deploy watch:', e.message); }
  finally { deployBusy = false; }
}
{ const t = setInterval(() => { deployWatchTick(); }, 60000); if (t.unref) t.unref(); }

// The ONLY place that ever writes a file or calls a webhook — and it only
// runs because a human clicked Approve on the dashboard.
router.post('/proposals/:id/approve', async (req, res) => {
  if (!auth.stepUp(req, res)) return;              // fresh 2FA code when "step-up" is on
  auth.action(req, 'sentinel approve ' + req.params.id);
  const p = proposals.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.status !== 'pending') return res.status(400).json({ error: `already ${p.status}` });
  try {
    if (p.kind === 'patch' && p.target === 'github') {
      const server = servers.find((s) => s.id === p.serverId) || { ghRepo: p.ghRepo };
      const target = { ...server, ghRepo: p.ghRepo, ghBranch: p.ghBranch };
      // Re-read the file right now: if someone pushed since this proposal was
      // made, committing our old-based version would silently undo their work.
      const cur = await githubReadFile(target, p.ghFilePath);
      if (p.oldContent !== undefined && cur.content !== p.oldContent) {
        return res.status(409).json({ error: 'GitHub par ye file proposal ke baad badal chuki hai — proposal purana hai. Reject karo aur "Review now" dobara chalao.' });
      }
      const wr = await githubWriteFile(target, p.ghFilePath, p.newContent, cur.sha, `Aureon Sentinel: ${p.description}`);
      try { schedulePostDeploy(p, server, wr && wr.commit && wr.commit.sha); } catch (e) { /* watching is a bonus, never block the approve */ }
    } else if (p.kind === 'patch') {
      fs.writeFileSync(p.filePath, p.newContent, 'utf8');
    } else if (p.kind === 'restart') {
      await fetch(p.webhookUrl, { method: 'POST' });
    }
    p.status = 'approved'; logEvent('approved', { name: p.serverName }, p.description || p.kind);
    // our own commit must not show up as an "outside change" on the next scan
    try {
      const k = p.key || (p.target === 'github' ? `github:${p.ghRepo}:${p.ghFilePath}` : p.filePath);
      snapshots[k] = crypto.createHash('sha256').update(p.newContent).digest('hex');
      persistSnapshots(); saveSnap(k, p.newContent);
    } catch (e) { /* bookkeeping only */ }
    p.decidedAt = new Date().toISOString();
    persistProposals();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/proposals/:id/reject', (req, res) => {
  const p = proposals.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  p.status = 'rejected'; logEvent('rejected', { name: p.serverName }, p.description || p.kind);
  p.decidedAt = new Date().toISOString();
  persistProposals();
  res.json({ ok: true });
});

router.post('/check-now', async (req, res) => {
  await runMonitorCycle();
  res.json({ ok: true });
});

router.post('/servers/:id/scan-now', async (req, res) => {
  const server = servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'not found' });
  if (server.type !== 'self' && server.type !== 'github') return res.status(400).json({ error: 'proactive scan only works on servers with code access (self-hosted or GitHub)' });
  const found = await generateProactiveFindings(server);
  if (found.length) {
    proposals.push(...found);
    persistProposals();
    await sendAlertEmail(
      `Aureon Sentinel: proactive review found ${found.length} issue(s) in ${server.name}`,
      found.map((p) => `- ${p.description}`).join('\n') + '\n\nOpen the Sentinel dashboard to approve or reject.'
    );
  }
  res.json({ found: found.length, scan: server.lastScan || null });
});

router.get('/dashboard', (req, res) => auth.dashboard(req, res, () =>
  res.type('html').send(DASHBOARD_HTML.replace("'__OWNER_CODE__'", () => '""').replace('__UNPROTECTED__', 'false'))   // no secret goes into the page any more
));

const LOGIN_HTML = (wrongAttempt, blocked) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aureon Sentinel — Locked</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0a0a0d; color:#eee; font-family:-apple-system,sans-serif; }
  form { background:#15151b; border:1px solid #24242e; border-radius:12px; padding:28px; width:90%; max-width:320px; text-align:center; }
  h1 { color:#d4af37; font-size:18px; margin:0 0 18px; }
  input { width:100%; background:#101014; border:1px solid #24242e; color:#eee; padding:10px 12px; border-radius:8px; font-size:14px; margin-bottom:12px; }
  button { width:100%; background:#d4af37; color:#141414; border:none; border-radius:8px; padding:10px; font-weight:600; font-size:14px; cursor:pointer; }
  button:disabled { opacity:.5; }
  .err { color:#ff6b6b; font-size:12px; margin:-6px 0 12px; }
</style>${THEME_TAGS}</head>
<body>
  <form method="GET" action="/api/sentinel/dashboard">
    <h1>🛡️ Aureon Sentinel</h1>
    ${blocked ? '<div class="err">Bahut saari galat koshishein — 30 min ke liye block hai.</div>' : ''}
    ${wrongAttempt ? '<div class="err">Galat code, dobara try karo.</div>' : ''}
    <input name="code" type="password" placeholder="Owner code" autofocus ${blocked ? 'disabled' : ''}>
    <button type="submit" ${blocked ? 'disabled' : ''}>Unlock</button>
  </form>
</body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Aureon Sentinel</title>
<style>
  :root {
    --gold:#d4af37; --gold-dim:rgba(212,175,55,.5);
    --bg:#0a0a0d; --bg2:#101014;
    --card:#15151b; --card-border:#24242e;
    --danger:#ff6b6b; --ok:#4ade80; --warn:#f5a524; --muted:#8b8f99;
    --text:#f0f0f2;
  }
  * { box-sizing: border-box; }
  html, body { height:100%; }
  body {
    margin:0; background:
      radial-gradient(1200px 400px at 50% -10%, rgba(212,175,55,.06), transparent),
      var(--bg);
    color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;
    padding:20px 16px; max-width:1100px; margin-left:auto; margin-right:auto;
    padding-top: calc(20px + env(safe-area-inset-top, 0px)); padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  }
  header { margin-bottom:22px; }
  h1 { color:var(--gold); font-size:21px; font-weight:700; margin:0 0 4px; letter-spacing:.2px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:16px; }
  .summary-bar { display:flex; gap:10px; flex-wrap:wrap; }
  .summary-chip { background:var(--card); border:1px solid var(--card-border); border-radius:8px; padding:8px 14px; font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  .summary-chip b { color:var(--text); font-size:14px; }
  .card {
    background:linear-gradient(180deg, var(--card), var(--bg2));
    border:1px solid var(--card-border); border-radius:12px; padding:16px; margin-bottom:10px;
    box-shadow:0 1px 3px rgba(0,0,0,.3);
  }
  .row { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; flex-shrink:0; }
  .dot.HEALTHY { background:var(--ok); box-shadow:0 0 6px var(--ok); }
  .dot.DOWN, .dot[class*="HTTP_"] { background:var(--danger); box-shadow:0 0 6px var(--danger); }
  .dot.UNKNOWN { background:var(--muted); }
  .diff { font:11px/1.5 ui-monospace,Menlo,Consolas,monospace; border:1px solid var(--card-border); border-radius:8px; overflow-x:auto; margin-top:8px; background:var(--bg2); }
  .diff .h { padding:4px 8px; color:var(--muted); background:rgba(139,143,153,.12); }
  .diff .r { display:flex; white-space:pre; min-width:max-content; }
  .diff .ln { flex:none; width:34px; text-align:right; padding:0 6px; color:var(--muted); user-select:none; }
  .diff .sg { flex:none; width:16px; text-align:center; font-weight:700; }
  .diff .tx { padding-right:12px; }
  .diff .r.add { background:rgba(74,222,128,.16); } .diff .r.add .sg { color:var(--ok); }
  .diff .r.del { background:rgba(255,107,107,.16); } .diff .r.del .sg { color:var(--danger); }
  .stat-add { color:var(--ok); font-weight:700; } .stat-del { color:var(--danger); font-weight:700; }
  .badge { font-size:11px; padding:4px 10px; border-radius:20px; font-weight:600; letter-spacing:.3px; text-transform:uppercase; display:inline-flex; align-items:center; }
  .badge.HEALTHY { background:rgba(74,222,128,.12); color:var(--ok); border:1px solid rgba(74,222,128,.25); }
  .badge.DOWN, .badge[class*="HTTP_"] { background:rgba(255,107,107,.12); color:var(--danger); border:1px solid rgba(255,107,107,.25); }
  .badge.UNKNOWN { background:rgba(139,143,153,.12); color:var(--muted); border:1px solid rgba(139,143,153,.25); }
  .name { font-weight:600; font-size:14px; }
  .meta { font-size:12px; color:var(--muted); margin-top:2px; }
  button { background:var(--gold); color:#141414; border:none; border-radius:8px; padding:8px 16px; font-weight:600; font-size:13px; cursor:pointer; transition:filter .15s; }
  button:hover { filter:brightness(1.08); }
  button.reject { background:transparent; color:var(--text); border:1px solid var(--card-border); }
  button.danger { background:var(--danger); color:#fff; }
  input, select {
    background:var(--bg2); border:1px solid var(--card-border); color:var(--text);
    padding:10px 12px; border-radius:8px; font-size:13px; width:100%;
  }
  input:focus, select:focus { outline:none; border-color:var(--gold-dim); }
  .grid { display:grid; grid-template-columns:1fr; gap:8px; margin-top:10px; }
  details summary { cursor:pointer; color:var(--gold); font-size:12px; font-weight:600; }
  pre { background:var(--bg2); padding:10px; border-radius:8px; overflow-x:auto; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-word; border:1px solid var(--card-border); }
  h2 { font-size:13px; font-weight:700; color:var(--gold); margin:0 0 12px; text-transform:uppercase; letter-spacing:.6px; }
  .empty { color:var(--muted); font-size:13px; padding:14px 0; }
  .columns { display:grid; grid-template-columns:1fr; gap:24px; margin-top:24px; }
  @media(min-width:760px){ .columns { grid-template-columns:1fr 1fr; } }
  .col-left, .col-right { min-width:0; }
  .decide-btns { display:flex; gap:8px; flex-shrink:0; }
  .history-section { margin-top:32px; }
  .spark { display:block; flex-shrink:0; max-width:100%; }
  .ev { display:flex; gap:10px; align-items:baseline; padding:8px 0; border-bottom:1px solid var(--card-border); font-size:12.5px; }
  .ev-t { color:var(--muted); min-width:92px; font-variant-numeric:tabular-nums; }
  .ev-i { width:18px; text-align:center; flex:none; }
  .ev-x { min-width:0; word-break:break-word; }
  .ai-tag { font-size:10px; color:var(--gold); background:rgba(212,175,55,.1); border:1px solid rgba(212,175,55,.3); border-radius:5px; padding:2px 6px; margin-left:6px; vertical-align:middle; }
</style>
${THEME_TAGS}
</head>
<body>
  <header>
    <h1>🛡️ Aureon Sentinel</h1>
    <div class="sub">Every fix is diagnosed and proposed — never applied — until you click Approve.</div>
    <a id="sec-link" class="sec-link" href="#">🔐 Security Dashboard →</a>
    <a class="sec-link" href="/api/sentinel/ava-desk" style="margin-left:12px">🖥 Ava Desktop →</a>
    <div id="unprotected-banner" style="display:none;background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.3);color:#ff6b6b;font-size:12px;padding:10px 14px;border-radius:8px;margin-bottom:14px;">
      ⚠️ SENTINEL_OWNER_CODE set nahi hai Render pe — ye page abhi kisi ke liye bhi locked nahi hai. Render → Environment me add karo.
    </div>
    <div class="summary-bar" id="summary"></div>
  </header>

  <div class="columns">
    <div class="col-left">
      <h2>Servers</h2>
      <div id="servers"></div>
      <div class="card">
        <div class="grid">
          <input id="q-link" placeholder="Website ya GitHub link (https://github.com/owner/repo) — Render zaroori nahi">
          <button onclick="quickAdd()">Link se add karo</button>
          <div class="meta" id="q-msg">Website = uptime + SSL check. GitHub repo = repo + CI (GitHub Actions) check. Private repo ho to Render me GITHUB_TOKEN chahiye.</div>
        </div>
      </div>
      <div class="card">
        <div class="grid">
          <div class="meta">Koi project (zip) check karna hai? Code chalaye bina syntax, package.json, missing files aur secrets dekhta hai.</div>
          <input id="pc-file" type="file" accept=".zip,application/zip,application/x-zip-compressed">
          <button onclick="projectCheck()">Project check karo</button>
          <div id="pc-out" class="meta"></div>
        </div>
      </div>
      <div class="card">
        <div class="grid">
          <input id="s-name" placeholder="Name (e.g. Aureon backend)">
          <input id="s-url" placeholder="Health check URL (https://.../health)">
          <select id="s-type" onchange="toggleTypeFields()">
            <option value="self">Self-hosted — code access (full diagnosis)</option>
            <option value="github">GitHub repo — code access via API (full diagnosis)</option>
            <option value="external">External — monitor only</option>
          </select>
          <input id="s-local" placeholder="Local path (self-hosted only, e.g. ./ )">
          <input id="s-webhook" placeholder="Restart webhook URL (external only, optional)">
          <input id="s-gh-repo" placeholder="owner/repo (GitHub only, e.g. pavan/omnisell-backend)" style="display:none">
          <input id="s-gh-branch" placeholder="Branch (GitHub only, default: main)" style="display:none">
          <input id="s-gh-path" placeholder="Folder in repo (GitHub only, optional, e.g. backend)" style="display:none">
          <input id="s-gh-token" type="password" placeholder="GitHub token (optional — else uses GITHUB_TOKEN env)" style="display:none">
        </div>
        <div style="margin-top:12px"><button onclick="addServer()">+ Add server</button></div>
      </div>
    </div>

    <div class="col-right">
      <h2>Accept / Reject</h2>
      <div id="pending"></div>
    </div>
  </div>

  <div class="history-section">
    <h2>Live events</h2>
    <div id="events"></div>
  </div>

  <div class="history-section">
    <h2>History</h2>
    <div id="history"></div>
  </div>

  <div class="history-section">
    <h2>Recent code changes detected</h2>
    <div id="changes"></div>
  </div>

<script>
const API = '/api/sentinel';
const OWNER_CODE = '__OWNER_CODE__';
const UNPROTECTED = __UNPROTECTED__;
if (UNPROTECTED) document.getElementById('unprotected-banner').style.display = 'block';
document.getElementById('sec-link').href = '/api/security/dashboard';

async function authFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'x-csrf': '1' }, opts.headers);
  if (OWNER_CODE) opts.headers['x-owner-code'] = OWNER_CODE;
  var r = await fetch(url, opts);
  if (r.status === 403) {                                   // step-up: server wants a fresh 2FA code
    var j = await r.clone().json().catch(function () { return {}; });
    if (j.needTotp) {
      var c = prompt('2FA code (Authenticator ka 6-digit) daalo:');
      if (c) { opts.headers['x-totp'] = c.trim(); r = await fetch(url, opts); }
    }
  }
  if (r.status === 401) { document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#999">Session khatam ho gaya.<br>Dashboard link dobara kholo.</div>'; throw new Error('session expired'); }
  return r;
}

async function load() {
  const [servers, proposals, changes, summary, events] = await Promise.all([
    authFetch(API + '/servers').then(r => r.json()),
    authFetch(API + '/proposals').then(r => r.json()),
    authFetch(API + '/changes').then(r => r.json()),
    authFetch(API + '/summary').then(r => r.json()).catch(() => null),
    authFetch(API + '/events').then(r => r.json()).catch(() => []),
  ]);
  renderSummary(servers, proposals, summary);
  renderServers(servers);
  renderProposals(proposals);
  renderChanges(changes);
  renderEvents(events);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

function statChips(st) {
  if (!st) return '';
  return '<span class="stat-add">+' + st.added + '</span> <span class="stat-del">-' + st.removed + '</span>';
}

function renderDiff(hunks, st) {
  if (!hunks || !hunks.length) return '<div class="meta">Koi line-diff nahi.</div>';
  var h = '<div class="diff">';
  hunks.forEach(function (k) {
    h += '<div class="h">@@ -' + k.oldStart + ',' + k.oldLines + ' +' + k.newStart + ',' + k.newLines + ' @@</div>';
    k.rows.forEach(function (r) {
      var cls = r[0] === '+' ? 'add' : r[0] === '-' ? 'del' : '';
      h += '<div class="r ' + cls + '"><span class="ln">' + (r[1] || '') + '</span><span class="ln">' + (r[2] || '') + '</span><span class="sg">' + (r[0] === ' ' ? '' : r[0]) + '</span><span class="tx">' + esc(r[3]) + '</span></div>';
    });
  });
  if (st && st.truncated) h += '<div class="h">... diff lamba hai, baaki hissa yahan nahi dikhaya</div>';
  return h + '</div>';
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

function statChips(st) {
  if (!st) return '';
  return '<span class="stat-add">+' + st.added + '</span> <span class="stat-del">-' + st.removed + '</span>';
}

function renderDiff(hunks, st) {
  if (!hunks || !hunks.length) return '<div class="meta">Koi line-diff nahi.</div>';
  var h = '<div class="diff">';
  hunks.forEach(function (k) {
    h += '<div class="h">@@ -' + k.oldStart + ',' + k.oldLines + ' +' + k.newStart + ',' + k.newLines + ' @@</div>';
    k.rows.forEach(function (r) {
      var cls = r[0] === '+' ? 'add' : r[0] === '-' ? 'del' : '';
      h += '<div class="r ' + cls + '"><span class="ln">' + (r[1] || '') + '</span><span class="ln">' + (r[2] || '') + '</span><span class="sg">' + (r[0] === ' ' ? '' : r[0]) + '</span><span class="tx">' + esc(r[3]) + '</span></div>';
    });
  });
  if (st && st.truncated) h += '<div class="h">... diff lamba hai, baaki hissa yahan nahi dikhaya</div>';
  return h + '</div>';
}

function renderChanges(changes) {
  var el = document.getElementById('changes');
  if (!changes.length) { el.innerHTML = '<div class="empty">Koi change detect nahi hua ab tak (scan hone ke baad hi pata chalega).</div>'; return; }
  el.innerHTML = changes.slice(0, 15).map(function (c) {
    return '<div class="card"><div class="row"><div><div class="name">' + esc(c.serverName) + '</div>' +
      '<div class="meta">' + esc(c.file) + ' changed ' + statChips(c.stats) + '</div></div>' +
      '<div class="meta">' + new Date(c.changedAt).toLocaleString() + '</div></div>' +
      (c.diff ? '<details style="margin-top:8px"><summary>Kya badla (diff)</summary>' + renderDiff(c.diff, c.stats) + '</details>' : (c.note ? '<div class="meta">' + esc(c.note) + '</div>' : '')) +
      '</div>';
  }).join('');
}

function renderSummary(servers, proposals, sm) {
  var healthy = servers.filter(function (s) { return s.lastStatus === 'HEALTHY'; }).length;
  var down = servers.filter(function (s) { return s.lastStatus && s.lastStatus !== 'HEALTHY' && s.lastStatus !== 'UNKNOWN'; }).length;
  var pending = proposals.filter(function (p) { return p.status === 'pending'; }).length;
  var h = '';
  if (sm && sm.total) { var c = sm.score >= 90 ? 'var(--ok)' : sm.score >= 60 ? 'var(--warn)' : 'var(--danger)'; h += '<div class="summary-chip"><b style="color:' + c + '">' + sm.score + '</b>&nbsp;health score</div>'; }
  h += '<div class="summary-chip"><span class="dot HEALTHY"></span><b>' + healthy + '</b>&nbsp;healthy</div>';
  h += '<div class="summary-chip"><span class="dot DOWN"></span><b>' + down + '</b>&nbsp;down</div>';
  h += '<div class="summary-chip"><b>' + pending + '</b>&nbsp;awaiting approval</div>';
  if (sm && sm.avgUptime24 != null) h += '<div class="summary-chip"><b>' + sm.avgUptime24 + '%</b>&nbsp;uptime 24h</div>';
  if (sm && sm.total) h += '<div class="summary-chip"><b>' + sm.incidents24 + '</b>&nbsp;incidents 24h</div>';
  document.getElementById('summary').innerHTML = h;
}

function sparkSvg(a) {
  if (!a || !a.length) return '';
  var max = 1; a.forEach(function (v) { if (v > max) max = v; });
  var w = 3, h = 26, out = '<svg class="spark" width="' + a.length * w + '" height="' + h + '" viewBox="0 0 ' + a.length * w + ' ' + h + '">';
  a.forEach(function (v, i) {
    var bh = v < 0 ? h : Math.max(2, Math.round(v / max * (h - 4)));
    out += '<rect x="' + i * w + '" y="' + (h - bh) + '" width="2" height="' + bh + '" rx="1" fill="' + (v < 0 ? '#ff6b6b' : '#4ade80') + '" opacity="' + (v < 0 ? '.9' : '.75') + '"/>';
  });
  return out + '</svg>';
}

var EV_ICON = { down: '🔴', up: '🟢', proposal: '🛠️', approved: '✅', rejected: '⛔', ssl: '🔒' };
function renderEvents(list) {
  var el = document.getElementById('events'); if (!el) return;
  if (!list || !list.length) { el.innerHTML = '<div class="empty">Abhi koi event nahi — health checks chalte hi yahan dikhenge.</div>'; return; }
  el.innerHTML = list.slice(0, 25).map(function (e) {
    var d = new Date(e.t);
    return '<div class="ev"><span class="ev-t">' + d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      '</span><span class="ev-i">' + (EV_ICON[e.type] || '•') + '</span><span class="ev-x"><b>' + esc(e.server) + '</b> ' + esc(e.text) + '</span></div>';
  }).join('');
}

function renderServers(servers) {
  var el = document.getElementById('servers');
  if (!servers.length) { el.innerHTML = '<div class="empty">No servers added yet.</div>'; return; }
  el.innerHTML = servers.map(function (s) {
    var st = s.lastStatus || 'UNKNOWN';
    var bits = [];
    if (s.lastResponseMs) bits.push(s.lastResponseMs + ' ms');
    if (s.sslDays !== null && s.sslDays !== undefined) bits.push('SSL ' + s.sslDays + ' din' + (s.sslDays <= 14 ? ' (renew karo!)' : ''));
    if (s.lastScan) bits.push(s.lastScan.files + ' files / ' + s.lastScan.batches + ' parts reviewed');
    var canScan = (s.type === 'self' || s.type === 'github');
    return '<div class="card row"><div>' +
      '<div class="name"><span class="dot ' + esc(st) + '"></span>' + esc(s.name) + ' <span class="meta">(' + (s.type === 'self' ? 'self-hosted' : s.type === 'github' ? 'GitHub repo' : 'external') + ')</span></div>' +
      '<div class="meta">' + esc(s.healthUrl) + '</div>' +
      (s.downForMin != null ? '<div class="meta" style="color:var(--danger)">⛔ ' + s.downForMin + ' min se down hai</div>' : '') +
      '<div style="margin-top:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' + sparkSvg(s.spark) + '<span class="meta">' + (s.uptime24 != null ? s.uptime24 + '% uptime 24h' : '') + (s.avgMs ? ' · avg ' + s.avgMs + ' ms · p95 ' + s.p95Ms + ' ms' : '') + '</span></div>' +
      (s.type === 'github' ? '<div class="meta">' + esc(s.ghRepo) + ' @ ' + esc(s.ghBranch) + (s.ghPath ? '/' + esc(s.ghPath) : '') + '</div>' : '') +
      (s.ghInfo ? '<div class="meta">' + (s.ghInfo.ci ? 'CI: ' + esc(s.ghInfo.ci) + ' · ' : '') + 'last push ' + (s.ghInfo.pushedAt ? new Date(s.ghInfo.pushedAt).toLocaleDateString() : '?') + ' · ' + (s.ghInfo.openIssues || 0) + ' open issues' + (s.ghInfo.archived ? ' · ARCHIVED' : '') + '</div>' : '') +
      (s.lastCheckedAt ? '<div class="meta">checked ' + new Date(s.lastCheckedAt).toLocaleString() + (bits.length ? ' - ' + esc(bits.join(' - ')) : '') + '</div>' : '') +
      (s.lastError && st !== 'HEALTHY' ? '<div class="meta" style="color:var(--danger)">' + esc(s.lastError) + '</div>' : '') +
      '</div><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<span class="badge ' + esc(st) + '">' + esc(st) + '</span>' +
      (canScan ? '<button class="reject" data-id="' + esc(s.id) + '" onclick="scanNow(this.dataset.id)">Review now</button>' : '') +
      '<button class="reject" data-id="' + esc(s.id) + '" onclick="removeServer(this.dataset.id)">Remove</button></div></div>';
  }).join('');
}

function renderProposals(proposals) {
  var pending = proposals.filter(function (p) { return p.status === 'pending'; });
  var done = proposals.filter(function (p) { return p.status !== 'pending'; }).sort(function (a, b) { return new Date(b.decidedAt) - new Date(a.decidedAt); });

  document.getElementById('pending').innerHTML = pending.length ? pending.map(function (p) {
    return '<div class="card"><div class="row"><div>' +
      '<div class="name">' + esc(p.serverName) + (p.source === 'reactive-ai' ? '<span class="ai-tag">AI diagnosed</span>' : '') + (p.source === 'proactive-ai' ? '<span class="ai-tag">Proactive scan</span>' : '') + '</div>' +
      '<div class="meta">' + esc(p.description) + '</div>' +
      (p.kind === 'patch' ? '<div class="meta">' + esc(p.ghFilePath || p.filePath || '') + ' ' + statChips(p.stats) + '</div>' : '') +
      '</div><div class="decide-btns">' +
      '<button data-id="' + esc(p.id) + '" onclick="decide(this.dataset.id,&quot;approve&quot;)">Approve</button>' +
      '<button class="reject" data-id="' + esc(p.id) + '" onclick="decide(this.dataset.id,&quot;reject&quot;)">Reject</button></div></div>' +
      (p.kind === 'patch' ? '<details open style="margin-top:8px"><summary>Exact badlav (diff)</summary>' + renderDiff(p.diff, p.stats) + '</details>' : '') +
      '</div>';
  }).join('') : '<div class="empty">Nothing pending.</div>';

  document.getElementById('history').innerHTML = done.length ? done.slice(0, 20).map(function (p) {
    return '<div class="card"><div class="row"><div><div class="name">' + esc(p.serverName) + '</div>' +
      '<div class="meta">' + esc(p.description) + ' ' + statChips(p.stats) + '</div></div>' +
      '<span class="badge ' + (p.status === 'approved' ? 'HEALTHY' : 'DOWN') + '">' + esc(p.status) + '</span></div>' +
      (p.diff && p.diff.length ? '<details style="margin-top:8px"><summary>Diff dekho</summary>' + renderDiff(p.diff, p.stats) + '</details>' : '') + '</div>';
  }).join('') : '<div class="empty">No history yet.</div>';
}

function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function toggleTypeFields() {
  const type = document.getElementById('s-type').value;
  document.getElementById('s-local').style.display = type === 'self' ? '' : 'none';
  document.getElementById('s-webhook').style.display = type === 'external' ? '' : 'none';
  ['s-gh-repo','s-gh-branch','s-gh-path','s-gh-token'].forEach(id => {
    document.getElementById(id).style.display = type === 'github' ? '' : 'none';
  });
}

async function quickAdd() {
  var inp = document.getElementById('q-link'), msg = document.getElementById('q-msg'), link = inp.value.trim();
  if (!link) { msg.textContent = 'Pehle link paste karo'; return; }
  msg.textContent = 'Check ho raha hai…';
  var res = await authFetch(API + '/servers/quick', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ link: link }) });
  var j = await res.json().catch(function () { return {}; });
  if (!res.ok) { msg.textContent = '❌ ' + (j.error || 'add nahi hua'); return; }
  inp.value = ''; msg.textContent = '✅ ' + (j.added || []).map(function (s) { return s.name; }).join(', ') + ' add hua. ' + (j.notes || []).join(' · ');
  load();
}
async function projectCheck() {
  var f = document.getElementById('pc-file').files[0], out = document.getElementById('pc-out');
  if (!f) { out.textContent = 'Pehle zip chuno'; return; }
  if (f.size > 25 * 1024 * 1024) { out.textContent = 'Zip 25 MB se badi hai'; return; }
  out.textContent = 'Padh raha hai…';
  var data = await new Promise(function (ok) { var fr = new FileReader(); fr.onload = function () { ok(fr.result); }; fr.onerror = function () { ok(null); }; fr.readAsDataURL(f); });
  if (!data) { out.textContent = 'File padh nahi paye'; return; }
  var res = await authFetch(API + '/project-check', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: f.name, data: data }) });
  var j = await res.json().catch(function () { return {}; });
  if (!res.ok) { out.textContent = '❌ ' + (j.error || 'check nahi hua'); return; }
  var r = j.report, L = [];
  L.push((r.verdict === 'GOOD' ? '✅ Theek hai' : r.verdict === 'RISK' ? '⚠️ Secrets/.env ka khatra' : '❌ Problems mili') + ' — ' + r.files + ' files, JS ok ' + r.js.ok + '/' + r.js.checked + (r.js.esmSkipped ? ' (' + r.js.esmSkipped + ' ESM skip)' : ''));
  r.js.bad.forEach(function (b) { L.push('❌ syntax: ' + b.path + (b.line ? ':' + b.line : '') + ' — ' + b.error); });
  r.json.bad.forEach(function (b) { L.push('❌ JSON: ' + b.path + ' — ' + b.error); });
  r.pkg.issues.forEach(function (x) { L.push('❌ package.json: ' + x); });
  r.missingRequires.forEach(function (x) { L.push('❌ file nahi mili: ' + x); });
  r.secrets.forEach(function (s) { L.push('⚠️ secret: ' + s.path + ':' + s.line + ' (' + s.kind + ')'); });
  r.envFiles.forEach(function (x) { L.push('⚠️ .env file zip me hai: ' + x); });
  out.innerHTML = L.map(function (x) { return '<div>' + esc(x) + '</div>'; }).join('');
}

async function addServer() {
  const type = document.getElementById('s-type').value;
  const body = {
    name: document.getElementById('s-name').value,
    healthUrl: document.getElementById('s-url').value,
    type,
    localPath: document.getElementById('s-local').value,
    restartWebhookUrl: document.getElementById('s-webhook').value,
    ghRepo: document.getElementById('s-gh-repo').value,
    ghBranch: document.getElementById('s-gh-branch').value,
    ghPath: document.getElementById('s-gh-path').value,
    ghToken: document.getElementById('s-gh-token').value,
  };
  if (!body.name || !body.healthUrl) { alert('Name and health URL are required'); return; }
  if (type === 'github' && !body.ghRepo) { alert('owner/repo is required for GitHub type'); return; }
  const res = await authFetch(API + '/servers', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Could not add server'); return; }
  ['s-name','s-url','s-local','s-webhook','s-gh-repo','s-gh-branch','s-gh-path','s-gh-token'].forEach(id => document.getElementById(id).value = '');
  load();
}

async function scanNow(id) {
  const btn = event.target; btn.textContent = 'Scanning…'; btn.disabled = true;
  const res = await authFetch(\`\${API}/servers/\${id}/scan-now\`, { method:'POST' }).then(r => r.json());
  alert((res.found ? res.found + ' issue(s) mile — Accept/Reject check karo.' : 'Is baar koi pakka issue nahi mila.') + (res.scan ? ' (' + res.scan.files + ' files, ' + res.scan.batches + ' parts me; har run 2 parts dekhta hai)' : ''));
  load();
}

async function removeServer(id) {
  if (!confirm('Remove this server from monitoring?')) return;
  await authFetch(API + '/servers/' + id, { method:'DELETE' });
  load();
}

async function decide(id, action) {
  await authFetch(\`\${API}/proposals/\${id}/\${action}\`, { method:'POST' });
  load();
}

load();
setInterval(load, 10000);
</script>
<script src="/api/ava/widget.js"></script>
</body>
</html>`;

router._backup = { export: () => servers.map(({ lastError, ...x }) => x), import: (v) => { if (Array.isArray(v)) { servers = v.slice(0, 50); persistServers(); } } };   // v9 signed backup/recovery
router.getSummary = getSummary; // used by Ava (owner-only status line)
router._test = { runMonitorCycle, getSummary, events: () => events, generateAIFixProposal, generateProactiveFindings, checkServer, servers: () => servers, proposals: () => proposals, changeLog: () => changeLog };
router.deployWatching = () => postDeploy.length;
module.exports = router;
