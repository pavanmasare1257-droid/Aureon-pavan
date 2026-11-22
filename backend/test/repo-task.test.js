'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const rt = require('../repo-task');

const FILES = { 'backend/a.js': 'const x = 1;\nconsole.log(x);\n', 'www/app.js': 'let y = 2;\n', '.github/workflows/w.yml': 'on: push\n' };
const sha = (p) => 'sha-' + p;
function boot(o = {}) {
  const log = []; let n = 0;
  const gh = async (url, init) => {
    const u = String(url).replace('https://api.github.com/repos/o/r', ''); const m = (init && init.method) || 'GET'; log.push(m + ' ' + u);
    const R = (s, b) => ({ ok: s < 400, status: s, json: async () => b });
    if (u.startsWith('/git/trees/')) return R(200, { tree: Object.keys(FILES).map((p) => ({ type: 'blob', path: p, size: FILES[p].length, sha: sha(p) })).concat([{ type: 'blob', path: 'x.apk', size: 5, sha: 'z' }]) });
    if (u.startsWith('/git/ref/heads/')) return R(200, { object: { sha: 'HEAD1' } });
    if (u === '/git/refs') return R(201, {});
    if (u.startsWith('/contents/') && m === 'GET') { const p = decodeURIComponent(u.slice(10).split('?')[0]); return FILES[p] != null ? R(200, { encoding: 'base64', size: FILES[p].length, sha: (o.shaDrift && u.includes('ref=aureon')) ? 'changed' : sha(p), content: Buffer.from(FILES[p]).toString('base64') }) : R(404, { message: 'nf' }); }
    if (u.startsWith('/contents/') && m === 'PUT') return R(200, {});
    if (u === '/pulls') return R(201, { html_url: 'https://github.com/o/r/pull/7', number: 7 });
    return R(404, { message: 'nf' });
  };
  const llm = { text: async (prompt, op) => { n++; if (op.system.includes('"files":["path"')) return o.pick || '{"files":["backend/a.js"]}'; return o.edit || '{"summary":"x ko 5 kiya","files":[{"path":"backend/a.js","content":"const x = 5;\\nconsole.log(x);\\n"}]}'; } };
  const verifyAuth = (req, res, next) => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return res.status(401).json({}); req.verifiedUid = m[1]; next(); };
  const app = express(); app.use('/api/repotask', rt.createRouter({ express, verifyAuth, isOwnerUid: async (u) => u === 'owner', llm, fetchImpl: gh, env: o.env || { GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' } }));
  return new Promise((resolve) => { const srv = app.listen(0, () => { const port = srv.address().port;
    const call = (method, path, uid, body) => new Promise((res) => { const d = body ? JSON.stringify(body) : null; const r = http.request({ port, path, method, headers: { ...(uid ? { authorization: 'Bearer ' + uid } : {}), ...(d ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } : {}) } }, (rs) => { let b = ''; rs.on('data', (c) => (b += c)); rs.on('end', () => res({ status: rs.statusCode, json: JSON.parse(b || '{}') })); }); if (d) r.write(d); r.end(); });
    resolve({ call, log, close: () => srv.close() }); }); });
}
const T = { task: 'x ki value 5 kar do backend/a.js me' };

test('owner only; not configured -> clear message', async () => {
  let h = await boot(); assert.equal((await h.call('POST', '/api/repotask/propose', 'stranger', T)).status, 403); assert.equal((await h.call('POST', '/api/repotask/propose', null, T)).status, 401); h.close();
  h = await boot({ env: {} }); assert.equal((await h.call('POST', '/api/repotask/propose', 'owner', T)).status, 503); h.close();
});

test('propose writes NOTHING to GitHub; approve makes a branch + PR, never touches base, never merges', async () => {
  const h = await boot();
  const p = (await h.call('POST', '/api/repotask/propose', 'owner', T)).json.proposal;
  assert.equal(p.files[0].path, 'backend/a.js'); assert.match(p.files[0].diff.preview, /- const x = 1;[\s\S]*\+ const x = 5;/);
  assert.ok(!h.log.some((l) => /^(POST|PUT|PATCH|DELETE)/.test(l)));                     // proposing is read-only
  assert.equal((await h.call('POST', '/api/repotask/approve', 'stranger', { id: p.id })).status, 403);
  const ap = (await h.call('POST', '/api/repotask/approve', 'owner', { id: p.id })).json;
  assert.equal(ap.pr.url, 'https://github.com/o/r/pull/7'); assert.match(ap.pr.branch, /^aureon\/task-[a-f0-9]{10}$/);
  const writes = h.log.filter((l) => /^(POST|PUT|PATCH|DELETE)/.test(l));
  assert.ok(writes.every((l) => /\/git\/refs$|\/contents\/|\/pulls$/.test(l)));
  assert.ok(!writes.some((l) => /merge|heads\/main/.test(l)));
  assert.equal((await h.call('POST', '/api/repotask/approve', 'owner', { id: p.id })).status, 409);   // no second PR
  h.close();
});

test('broken JS, workflow paths, unknown files and no-op edits are rejected', async () => {
  for (const [edit, re] of [
    ['{"summary":"s","files":[{"path":"backend/a.js","content":"const x = ;"}]}', /syntax/i],
    ['{"summary":"s","files":[{"path":".github/workflows/w.yml","content":"on: push"}]}', /allowed/i],
    ['{"summary":"s","files":[{"path":"www/app.js","content":"let y = 3;"}]}', /diya nahi/],
    ['{"summary":"s","files":[{"path":"backend/a.js","content":"const x = 1;\\nconsole.log(x);\\n"}]}', /asli badlav/],
    ['not json', /proposal nahi bana/],
  ]) { const h = await boot({ edit }); const r = await h.call('POST', '/api/repotask/propose', 'owner', T); assert.equal(r.status >= 400, true); assert.match(r.json.error, re); h.close(); }
});

test('if the file changed on GitHub meanwhile, approve aborts: no commit, no PR', async () => {
  const h = await boot({ shaDrift: true });
  const p = (await h.call('POST', '/api/repotask/propose', 'owner', T)).json.proposal;
  const r = await h.call('POST', '/api/repotask/approve', 'owner', { id: p.id });
  assert.equal(r.status, 409); assert.match(r.json.error, /badal gayi/);
  assert.ok(!h.log.some((l) => /PUT |\/pulls/.test(l)));
  h.close();
});

test('path / content gates', () => {
  const t = rt._t;
  assert.equal(t.allowedPath('backend/a.js'), true);
  for (const bad of ['.github/workflows/x.yml', '../x.js', '/etc/x.js', 'backend/.env', 'a/secret.js', 'package-lock.json', 'x.apk', 'node_modules/a.js', 'android/local.properties']) assert.equal(t.allowedPath(bad), false, bad);
  assert.match(t.checkContent('a.json', '{bad'), /JSON/);
  assert.match(t.checkContent('A.java', 'class A {'), /braces/);
  assert.match(t.checkContent('a.js', '```js\nx\n```'), /fence/);
  assert.equal(t.checkContent('a.js', 'const a = 1;'), '');
});
