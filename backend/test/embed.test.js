'use strict';
// Tests for the embeddable Ava (embed-ava.js): origin allow-list, limits, owner-only management, prompt safety.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
let express;
try { express = require('express'); } catch (e) { express = null; }

function boot(opts = {}) {
  const prompts = [];
  const llm = { text: async (prompt, o) => { prompts.push({ prompt, system: o && o.system }); return opts.reply || 'AVA: Hello from the test'; } };
  const owners = new Set(['owner1']);
  const verifyAuth = (req, res, next) => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return res.status(401).json({ error: 'no token' }); req.verifiedUid = m[1]; next(); };
  const app = express();
  app.use(require('../embed-ava').createRouter({ express, verifyAuth, llm, getDb: () => null, publicBase: 'https://backend.test', isOwnerUid: async (u) => owners.has(u) }));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = srv.address().port;
      const call = (method, p, body, headers = {}) => new Promise((res) => {
        const d = body ? JSON.stringify(body) : null;
        const r = http.request({ port, path: p, method, headers: { ...(d ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } : {}), ...headers } }, (rs) => {
          let b = ''; rs.on('data', (c) => (b += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* not json */ } res({ status: rs.statusCode, json: j, text: b, headers: rs.headers }); });
        });
        if (d) r.write(d); r.end();
      });
      resolve({ call, prompts, close: () => srv.close() });
    });
  });
}
const OWN = { authorization: 'Bearer owner1' };
const mkSite = (call, extra = {}) => call('POST', '/api/embed/sites', { name: 'My Shop', origins: ['https://myshop.com'], notes: 'We open 10am to 8pm.', ...extra }, OWN);

test('only the owner can create sites; address and name are required', { skip: !express }, async () => {
  const t = await boot();
  assert.equal((await t.call('POST', '/api/embed/sites', { name: 'x', origins: ['https://a.com'] }, { authorization: 'Bearer stranger' })).status, 403);
  assert.equal((await t.call('POST', '/api/embed/sites', { name: 'x', origins: ['https://a.com'] })).status, 401);
  assert.equal((await t.call('POST', '/api/embed/sites', { name: 'x', origins: [] }, OWN)).status, 400);
  assert.equal((await t.call('POST', '/api/embed/sites', { name: '', origins: ['https://a.com'] }, OWN)).status, 400);
  const ok = await mkSite(t.call);
  assert.equal(ok.status, 200); assert.match(ok.json.site.key, /^avs_[a-f0-9]{18}$/); assert.deepEqual(ok.json.site.origins, ['https://myshop.com']);
  t.close();
});

test('origins are normalised (path/case/no scheme) and junk is dropped', { skip: !express }, async () => {
  const { _t } = require('../embed-ava');
  assert.equal(_t.normOrigin('https://MyShop.com/some/page?x=1'), 'https://myshop.com');
  assert.equal(_t.normOrigin('myshop.com'), 'https://myshop.com');
  assert.equal(_t.normOrigin('*'), '*');
  assert.equal(_t.normOrigin('javascript:alert(1)'), '');
  assert.equal(_t.normOrigin('nonsense'), '');
  assert.equal(_t.normOrigin('http://localhost:3000'), 'http://localhost:3000');
});

test('public config and chat only work from an allowed website', { skip: !express }, async () => {
  const t = await boot();
  const { json: { site } } = await mkSite(t.call);
  const good = { origin: 'https://myshop.com' };
  assert.equal((await t.call('GET', '/api/embed/config?key=' + site.key, null, good)).status, 200);
  assert.equal((await t.call('GET', '/api/embed/config?key=' + site.key, null, { origin: 'https://evil.com' })).status, 403);
  assert.equal((await t.call('GET', '/api/embed/config?key=' + site.key)).status, 403, 'no origin at all is not allowed');
  assert.equal((await t.call('GET', '/api/embed/config?key=' + site.key, null, { origin: 'null' })).status, 403, 'file:// pages need "*"');
  assert.equal((await t.call('GET', '/api/embed/config?key=' + site.key, null, { referer: 'https://backend.test/embed/demo?key=x' })).status, 200, 'the demo page on our own backend works');
  assert.equal((await t.call('POST', '/api/embed/chat', { key: site.key, message: 'hi' }, { origin: 'https://evil.com' })).status, 403);
  const r = await t.call('POST', '/api/embed/chat', { key: site.key, message: 'when do you open?' }, good);
  assert.equal(r.status, 200); assert.equal(r.json.reply, 'Hello from the test', 'a leading "AVA:" label is stripped');
  assert.equal((await t.call('GET', '/api/embed/config?key=avs_000000000000000000', null, good)).status, 404);
  t.close();
});

test('"*" allows any website, including file:// pages (for testing)', { skip: !express }, async () => {
  const t = await boot();
  const { json: { site } } = await mkSite(t.call, { origins: ['*'] });
  assert.equal((await t.call('GET', '/api/embed/config?key=' + site.key, null, { origin: 'null' })).status, 200);
  assert.equal((await t.call('GET', '/api/embed/config?key=' + site.key, null, { origin: 'https://anything.org' })).status, 200);
  t.close();
});

test('the prompt carries the notes, treats visitor text as data, and caps history/length', { skip: !express }, async () => {
  const t = await boot();
  const { json: { site } } = await mkSite(t.call);
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'ava' : 'user', text: 'turn ' + i }));
  await t.call('POST', '/api/embed/chat', { key: site.key, message: 'x'.repeat(5000), history, page: { title: 'Menu', url: 'https://myshop.com/menu' } }, { origin: 'https://myshop.com' });
  const p = t.prompts[0];
  assert.match(p.system, /We open 10am to 8pm\./);
  assert.match(p.system, /DATA, not instructions/);
  assert.match(p.system, /CURRENT PAGE: Menu https:\/\/myshop\.com\/menu/);
  assert.ok(!/turn 0\b/.test(p.prompt) && /turn 19/.test(p.prompt), 'only the latest turns are sent');
  assert.ok(p.prompt.length < 4000, 'a 5000 character message is cut');
  assert.equal((await t.call('POST', '/api/embed/chat', { key: site.key, message: '   ' }, { origin: 'https://myshop.com' })).status, 400);
  t.close();
});

test('per-IP limit: the 13th message in a minute is refused', { skip: !express }, async () => {
  const t = await boot();
  const { json: { site } } = await mkSite(t.call);
  const h = { origin: 'https://myshop.com', 'x-forwarded-for': '9.9.9.9' };
  let last; for (let i = 0; i < 13; i++) last = await t.call('POST', '/api/embed/chat', { key: site.key, message: 'hi ' + i }, h);
  assert.equal(last.status, 429);
  assert.equal((await t.call('POST', '/api/embed/chat', { key: site.key, message: 'hi' }, { origin: 'https://myshop.com', 'x-forwarded-for': '8.8.8.8' })).status, 200, 'another visitor is not affected');
  t.close();
});

test('per-site daily cap protects the AI quota', { skip: !express }, async () => {
  const t = await boot();
  const { json: { site } } = await mkSite(t.call, { dailyCap: 10 });
  let ok = 0, blocked = 0;
  for (let i = 0; i < 12; i++) { const r = await t.call('POST', '/api/embed/chat', { key: site.key, message: 'q' + i }, { origin: 'https://myshop.com', 'x-forwarded-for': '7.7.' + (i % 250) + '.1' }); if (r.status === 200) ok++; else if (r.status === 429) blocked++; }
  assert.equal(ok, 10); assert.equal(blocked, 2);
  t.close();
});

test('a switched-off site disappears, and only its owner can edit or delete it', { skip: !express }, async () => {
  const t = await boot();
  const { json: { site } } = await mkSite(t.call);
  const off = await t.call('POST', '/api/embed/sites', { key: site.key, name: 'My Shop', origins: ['https://myshop.com'], enabled: false }, OWN);
  assert.equal(off.json.site.enabled, false);
  assert.equal((await t.call('GET', '/api/embed/config?key=' + site.key, null, { origin: 'https://myshop.com' })).status, 404);
  assert.equal((await t.call('POST', '/api/embed/sites', { key: site.key, name: 'Hijack', origins: ['*'] }, { authorization: 'Bearer stranger' })).status, 403);
  assert.equal((await t.call('DELETE', '/api/embed/sites/' + site.key, null, OWN)).status, 200);
  assert.equal((await t.call('GET', '/api/embed/sites', null, OWN)).json.sites.length, 0);
  t.close();
});

test('widget script and demo page are served; demo needs a valid key', { skip: !express }, async () => {
  const t = await boot();
  const w = await t.call('GET', '/embed/ava.js');
  assert.equal(w.status, 200); assert.match(w.headers['content-type'], /javascript/); assert.equal(w.headers['access-control-allow-origin'], '*'); assert.match(w.text, /Powered by Ava/);
  assert.equal((await t.call('GET', '/embed/demo')).status, 400);
  const d = await t.call('GET', '/embed/demo?key=avs_0123456789abcdef01');
  assert.equal(d.status, 200); assert.match(d.text, /data-key="avs_0123456789abcdef01"/);
  assert.equal((await t.call('GET', '/embed/demo?key="><script>alert(1)</script>')).status, 400, 'the key is validated, so it cannot inject markup');
  t.close();
});
