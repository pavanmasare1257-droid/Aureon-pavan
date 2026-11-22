'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createMcp } = require('../mcp-server');

function fakeDb() {
  const store = new Map();
  const doc = (path) => ({ get: async () => ({ exists: store.has(path), data: () => store.get(path) }), set: async (v) => { store.set(path, v); }, delete: async () => { store.delete(path); }, collection: (c) => ({ doc: (d) => doc(path + '/' + c + '/' + d) }) });
  return { store, collection: (c) => ({ doc: (d) => doc(c + '/' + d), where: () => ({ get: async () => ({ size: 2, forEach: (f) => f({ data: () => ({ name: 'Daily', enabled: true, trigger: { type: 'manual' }, lastRun: { ok: true, at: 1, text: 'done' } }) }) }) }) }) };
}
async function boot(t = {}) {
  const db = fakeDb(); let clock = 1000; const drafts = [];
  const gmailCore = { importantFor: async () => ({ summary: 'S', items: [{ id: 'm1', from: 'HDFC', subject: 'Bill', urgency: 'high', why: 'due', unread: true, snippet: 'secret snippet' }] }),
    createDraft: async (uid, a) => { assert.equal(a.source, 'mcp'); const d = { id: 'd1', to: 'a@b.com', subject: 'Hi', body: 'Body', source: 'claude' }; drafts.push(d); return d; }, listDrafts: async () => drafts };
  const verifyAuth = (req, res, next) => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m || m[1].startsWith('amcp_')) return res.status(401).json({ error: 'no' }); req.verifiedUid = m[1]; next(); };
  const m = createMcp({ express, verifyAuth, getDb: () => db, gmailCore, getTwin: () => ({ core: { listApprovals: async () => [{ summary: 'Pay 500' }] } }), now: () => clock });
  const app = express(); app.use('/api/mcp-token', m.tokenRouter); app.use('/mcp', m.mcpRouter);
  return new Promise((resolve) => { const srv = app.listen(0, () => {
    const port = srv.address().port;
    const call = (method, path, headers, body) => new Promise((res) => { const d = body ? JSON.stringify(body) : null;
      const r = http.request({ port, path, method, headers: { ...(headers || {}), ...(d ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } : {}) } }, (rs) => { let b = ''; rs.on('data', (c) => (b += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* empty */ } res({ status: rs.statusCode, json: j }); }); }); if (d) r.write(d); r.end(); });
    resolve({ call, db, drafts, tick: (ms) => { clock += ms; }, close: () => srv.close() }); }); });
}
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('token: shown once, only the hash is stored, MCP rejects bad/revoked tokens', async () => {
  const h = await boot();
  assert.equal((await h.call('POST', '/mcp', {}, rpc(1, 'ping'))).status, 401);
  const tok = (await h.call('POST', '/api/mcp-token/create', { authorization: 'Bearer u1' }, {})).json.token;
  assert.match(tok, /^amcp_[A-Za-z0-9_-]+\.[a-f0-9]{48}$/);
  assert.ok(!JSON.stringify([...h.db.store.values()]).includes(tok.split('.')[1]));
  const A = { authorization: 'Bearer ' + tok };
  assert.equal((await h.call('POST', '/mcp', A, rpc(1, 'ping'))).json.result.constructor, Object);
  assert.equal((await h.call('POST', '/mcp', { authorization: 'Bearer ' + tok.slice(0, -1) + '0' }, rpc(1, 'ping'))).status, 401);
  const tok2 = (await h.call('POST', '/api/mcp-token/create', { authorization: 'Bearer u1' }, {})).json.token;   // rotating kills the old one
  assert.equal((await h.call('POST', '/mcp', A, rpc(1, 'ping'))).status, 401);
  await h.call('POST', '/api/mcp-token/revoke', { authorization: 'Bearer u1' }, {});
  assert.equal((await h.call('POST', '/mcp', { authorization: 'Bearer ' + tok2 }, rpc(1, 'ping'))).status, 401);
  assert.equal((await h.call('GET', '/mcp', A)).status, 405);
  h.close();
});

test('protocol: initialize, notification, tools/list has no send/run/deploy tool', async () => {
  const h = await boot();
  const A = { authorization: 'Bearer ' + (await h.call('POST', '/api/mcp-token/create', { authorization: 'Bearer u1' }, {})).json.token };
  const init = (await h.call('POST', '/mcp', A, rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude' } }))).json.result;
  assert.equal(init.protocolVersion, '2025-03-26'); assert.ok(init.capabilities.tools); assert.equal(init.serverInfo.name, 'aureon');
  assert.equal((await h.call('POST', '/mcp', A, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const names = (await h.call('POST', '/mcp', A, rpc(2, 'tools/list'))).json.result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['aureon_overview', 'automations_list', 'gmail_draft', 'gmail_important', 'gmail_pending_drafts']);
  assert.ok(!names.some((n) => /send|run|deploy|delete|pay/.test(n)));
  assert.equal((await h.call('POST', '/mcp', A, rpc(3, 'tools/call', { name: 'gmail_send', arguments: {} }))).json.error.code, -32602);
  assert.equal((await h.call('POST', '/mcp', A, rpc(4, 'nope'))).json.error.code, -32601);
  h.close();
});

test('tools: overview, important (no snippets leak), draft only drafts, pending list, automations', async () => {
  const h = await boot();
  const A = { authorization: 'Bearer ' + (await h.call('POST', '/api/mcp-token/create', { authorization: 'Bearer u1' }, {})).json.token };
  const call = async (name, args) => (await h.call('POST', '/mcp', A, rpc(9, 'tools/call', { name, arguments: args || {} }))).json.result;
  const ov = JSON.parse((await call('aureon_overview')).content[0].text);
  assert.equal(ov.pendingApprovals, 1); assert.equal(ov.connectedApps, 2);
  const imp = (await call('gmail_important')).content[0].text;
  assert.ok(imp.includes('HDFC') && !imp.includes('secret snippet'));
  const dr = await call('gmail_draft', { instruction: 'reply yes', replyToId: 'm1' });
  const dj = JSON.parse(dr.content[0].text); assert.equal(dj.sent, false); assert.equal(dj.draftId, 'd1');
  assert.equal(JSON.parse((await call('gmail_pending_drafts')).content[0].text).drafts.length, 1);
  assert.equal(JSON.parse((await call('automations_list')).content[0].text).automations[0].name, 'Daily');
  h.close();
});

test('rate limit: 60 calls / 10 min per owner', async () => {
  const h = await boot();
  const A = { authorization: 'Bearer ' + (await h.call('POST', '/api/mcp-token/create', { authorization: 'Bearer u1' }, {})).json.token };
  for (let i = 0; i < 60; i++) assert.equal((await h.call('POST', '/mcp', A, rpc(i, 'ping'))).status, 200);
  assert.equal((await h.call('POST', '/mcp', A, rpc(99, 'ping'))).status, 429);
  h.tick(11 * 60 * 1000);
  assert.equal((await h.call('POST', '/mcp', A, rpc(100, 'ping'))).status, 200);
  h.close();
});
