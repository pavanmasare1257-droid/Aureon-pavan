// backend/mcp-server.js — Aureon as a Claude "custom connector" (MCP over Streamable HTTP, JSON responses).
//
//   Owner side (login):  GET /api/mcp-token/status · POST /api/mcp-token/create · POST /api/mcp-token/revoke
//   Claude side:         POST /mcp   with   Authorization: Bearer amcp_...
//
// Safety (same two load-bearing rules as the rest of Aureon):
//   * Tools are READ-ONLY, plus "draft an e-mail" which only creates a PENDING draft. There is deliberately NO send / run / deploy / delete tool:
//     the owner approves in the Aureon app (Gmail > Bhejo), the connector cannot.
//   * The token is shown ONCE, stored only as a SHA-256 hash, can be revoked any time, and is rate-limited.
const crypto = require('crypto');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LIM = { calls: 60, windowMs: 10 * 60 * 1000 };
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const cut = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

const TOOLS = [
  { name: 'aureon_overview', description: 'Short status of the owner\'s Aureon: pending approvals waiting in the Digital Twin, number of connected apps and automations, Gmail connection and pending e-mail drafts. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'gmail_important', description: 'List the owner\'s important recent e-mails (last 3 days, unread/important, no promotions) with a one-line reason each. Read-only: Aureon cannot change or delete mail.',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', description: 'Skip the 2-minute cache' } }, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'gmail_draft', description: 'Create a DRAFT e-mail (new mail to a given address, or a reply to a mail id from gmail_important). NOTHING IS SENT: the owner must open Aureon and tap "Bhejo" to approve. The recipient of a reply is always the original sender.',
    inputSchema: { type: 'object', properties: { instruction: { type: 'string', description: 'What the mail should say' }, replyToId: { type: 'string', description: 'Mail id from gmail_important, to answer it' }, to: { type: 'string', description: 'Recipient address for a NEW mail' }, subject: { type: 'string' } }, required: ['instruction'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'gmail_pending_drafts', description: 'List e-mail drafts that are waiting for the owner\'s approval in the Aureon app. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'automations_list', description: 'List the owner\'s Aureon automations (name, on/off, trigger, last run result). Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
];

function createMcp({ express, verifyAuth, getDb, gmailCore, getTwin, now }) {
  const clock = now || Date.now;
  const calls = new Map(); // uid -> [timestamps]
  const mcpDoc = (db, uid) => db.collection('users').doc(String(uid)).collection('integrations').doc('mcp');
  const json = express.json({ limit: '100kb' });

  /* -------------------- owner: manage the token -------------------- */
  const tokenRouter = express.Router();
  tokenRouter.get('/status', verifyAuth, async (req, res) => {
    try {
      const db = getDb(); if (!db) return res.status(503).json({ ok: false, error: 'Database set nahi hai.' });
      const d = await mcpDoc(db, req.verifiedUid).get();
      res.json({ ok: true, active: !!(d.exists && d.data().hash), createdAt: d.exists ? d.data().at || 0 : 0 });
    } catch (e) { res.status(500).json({ ok: false, error: cut(e.message, 120) }); }
  });
  tokenRouter.post('/create', verifyAuth, json, async (req, res) => {
    try {
      const db = getDb(); if (!db) return res.status(503).json({ ok: false, error: 'Database set nahi hai.' });
      const secret = crypto.randomBytes(24).toString('hex');
      const token = 'amcp_' + b64u(req.verifiedUid) + '.' + secret;     // the old token (if any) stops working immediately
      await mcpDoc(db, req.verifiedUid).set({ hash: sha(secret), at: clock() });
      res.json({ ok: true, token, note: 'Ye token sirf abhi dikhega. Copy kar lo.' });
    } catch (e) { res.status(500).json({ ok: false, error: cut(e.message, 120) }); }
  });
  tokenRouter.post('/revoke', verifyAuth, json, async (req, res) => {
    try { const db = getDb(); if (db) await mcpDoc(db, req.verifiedUid).delete(); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: cut(e.message, 120) }); }
  });

  /* -------------------- Claude: the MCP endpoint -------------------- */
  async function authToken(req) {
    const m = /^Bearer (amcp_([A-Za-z0-9_-]+)\.([a-f0-9]{48}))$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    let uid; try { uid = unb64u(m[2]).toString('utf8'); } catch (e) { return null; }
    if (!uid || uid.length > 128) return null;
    const db = getDb(); if (!db) return null;
    const d = await mcpDoc(db, uid).get();
    if (!d.exists || !d.data().hash) return null;
    const a = Buffer.from(sha(m[3])), b = Buffer.from(String(d.data().hash));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? uid : null;
  }
  function limited(uid) {
    const t = clock(), arr = (calls.get(uid) || []).filter((x) => x > t - LIM.windowMs);
    if (arr.length >= LIM.calls) { calls.set(uid, arr); return true; }
    arr.push(t); calls.set(uid, arr); return false;
  }
  const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
  const toolErr = (msg) => ({ content: [{ type: 'text', text: cut(msg, 300) }], isError: true });

  async function runTool(uid, name, args) {
    const db = getDb();
    try {
      switch (name) {
        case 'aureon_overview': {
          const out = { pendingApprovals: 0, approvals: [], connectedApps: 0, automations: 0, gmail: { connected: false }, pendingEmailDrafts: 0 };
          try { const tw = getTwin && getTwin(); if (tw) { const p = await tw.core.listApprovals(uid, 'pending'); out.pendingApprovals = p.length; out.approvals = p.slice(0, 5).map((x) => cut(x.summary || x.action, 120)); } } catch (e) { /* optional */ }
          try { out.connectedApps = (await db.collection('apps').where('uid', '==', uid).get()).size; } catch (e) { /* optional */ }
          try { out.automations = (await db.collection('automations').where('uid', '==', uid).get()).size; } catch (e) { /* optional */ }
          try { const g = await gmailCore.listDrafts(uid); out.gmail = { connected: true }; out.pendingEmailDrafts = g.length; } catch (e) { out.gmail = { connected: false }; }
          return text(out);
        }
        case 'gmail_important': {
          const r = await gmailCore.importantFor(uid, !!(args && args.force));
          return text({ summary: r.summary, items: (r.items || []).map((m) => ({ id: m.id, from: m.from, subject: m.subject, urgency: m.urgency, why: m.why, unread: m.unread })) });
        }
        case 'gmail_draft': {
          const d = await gmailCore.createDraft(uid, { instruction: args && args.instruction, replyToId: args && args.replyToId, to: args && args.to, subject: args && args.subject, source: 'mcp' });
          return text({ drafted: true, sent: false, draftId: d.id, to: d.to, subject: d.subject, body: d.body, next: 'Owner ko Aureon app me Settings > Apps & Automation > Gmail me ye draft dekh kar "Bhejo" dabana hoga. Tum ise bhej nahi sakte.' });
        }
        case 'gmail_pending_drafts': return text({ drafts: (await gmailCore.listDrafts(uid)).map((d) => ({ id: d.id, to: d.to, subject: d.subject, source: d.source })) });
        case 'automations_list': {
          const q = await db.collection('automations').where('uid', '==', uid).get();
          const rows = []; q.forEach((x) => { const a = x.data(); rows.push({ name: cut(a.name, 80), enabled: !!a.enabled, trigger: a.trigger && a.trigger.type, lastRun: a.lastRun ? { ok: !!a.lastRun.ok, at: a.lastRun.at, text: cut(a.lastRun.text, 200) } : null }); });
          return text({ automations: rows.slice(0, 50) });
        }
        default: return toolErr('Unknown tool: ' + cut(name, 40));
      }
    } catch (e) { return toolErr(e && e.message || 'Tool failed'); }
  }

  async function handleOne(uid, msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg && msg.id != null ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
    const id = msg.id;
    if (id === undefined) return null;                                    // notification (e.g. notifications/initialized): no reply
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'initialize': {
        const want = msg.params && msg.params.protocolVersion;
        return ok({ protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'aureon', version: '52' },
          instructions: 'Aureon is the owner\'s personal assistant. Tools are read-only except gmail_draft, which only creates a draft the owner must approve in the app.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const p = msg.params || {};
        if (!TOOLS.some((t) => t.name === p.name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
        return ok(await runTool(uid, p.name, p.arguments && typeof p.arguments === 'object' ? p.arguments : {}));
      }
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    }
  }

  async function handler(req, res) {
    res.set('Cache-Control', 'no-store');
    let uid = null;
    try { uid = await authToken(req); } catch (e) { uid = null; }
    if (!uid) return res.status(401).set('WWW-Authenticate', 'Bearer').json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    if (limited(uid)) return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'Too many requests' } });
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.slice(0, 20).map((m) => handleOne(uid, m)))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const r = await handleOne(uid, body);
    return r ? res.json(r) : res.status(202).end();
  }
  const mcpRouter = express.Router();
  mcpRouter.post('/', json, (req, res) => handler(req, res).catch(() => res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } })));
  mcpRouter.get('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }));
  mcpRouter.delete('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'No sessions' }));

  return { tokenRouter, mcpRouter, _t: { TOOLS, runTool } };
}

module.exports = { createMcp, TOOLS };
