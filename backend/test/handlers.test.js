'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTwin, memoryStore } = require('../twin');
const { createMailer, makeDeliver } = require('../twin/mailer');
const { createPayments, parsePayees } = require('../twin/payments');
const { createDeploy, parseHooks, evaluateChecks } = require('../twin/deploy');
const { handlers } = require('../twin/routes');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const U = 'user1';

// fake fetch: records calls, answers from a responder
function mkFetch(responder) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const r = await responder(String(url), opts, calls.length);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json ?? {},
      text: async () => (r.text ?? JSON.stringify(r.json ?? {})),
    };
  };
  f.calls = calls;
  return f;
}

// ---------------- mailer ----------------
test('mailer: not configured => clear error (so nothing is falsely marked as sent)', async () => {
  const m = createMailer({}, mkFetch(() => ({ status: 200 })));
  assert.equal(m.configured, false);
  await assert.rejects(() => m.send({ to: 'a@b.com', subject: 's', text: 't' }), /not configured/);
});

test('mailer: brevo request shape, header-injection safe subject', async () => {
  const f = mkFetch(() => ({ status: 201 }));
  const m = createMailer({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k', EMAIL_FROM: 'me@x.com', EMAIL_FROM_NAME: 'Aureon' }, f);
  assert.equal(m.configured, true);
  await m.send({ to: 'mom@example.com', subject: 'Hi\r\nBcc: evil@x.com', text: 'hello' });
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(c.opts.headers['api-key'], 'k');
  const body = JSON.parse(c.opts.body);
  assert.equal(body.to[0].email, 'mom@example.com');
  assert.ok(!body.subject.includes('\n'));
  assert.equal(body.textContent, 'hello');
});

test('mailer: resend request shape; provider errors become errors without leaking the key', async () => {
  const f = mkFetch(() => ({ status: 403, text: 'domain not verified' }));
  const m = createMailer({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'SECRETKEY', EMAIL_FROM: 'me@x.com' }, f);
  await assert.rejects(() => m.send({ to: 'a@b.com', subject: 's', text: 't' }), (e) => /403/.test(e.message) && !e.message.includes('SECRETKEY'));
  assert.equal(f.calls[0].url, 'https://api.resend.com/emails');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer SECRETKEY');
});

test('mailer: rejects bad recipient', async () => {
  const m = createMailer({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k', EMAIL_FROM: 'me@x.com' }, mkFetch(() => ({ status: 201 })));
  await assert.rejects(() => m.send({ to: 'not-an-email', subject: 's', text: 't' }), /invalid recipient/);
});

test('deliver: email only, adds a transparency footer, releases stored assets', async () => {
  const store = memoryStore();
  const sent = [];
  const deliver = makeDeliver({ mailer: { send: async (m) => sent.push(m) }, store, ownerName: 'Pavan' });
  await deliver(U, { type: 'message', text: 'Hello Mom' }, { channel: 'email', address: 'mom@example.com' });
  assert.match(sent[0].text, /Hello Mom/);
  assert.match(sent[0].text, /sent automatically by Aureon/);
  await assert.rejects(() => deliver(U, { type: 'message', text: 'x' }, { channel: 'sms', address: '123' }), /not supported/);
  await assert.rejects(() => deliver(U, { type: 'release_asset', assetId: 'nope' }, { channel: 'email', address: 'a@b.com' }), /asset not found/);
  await store.set(U, 'assets', { pm: { label: 'Password manager', text: 'Emergency kit is in the red box.' } });
  await deliver(U, { type: 'release_asset', assetId: 'pm', text: '' }, { channel: 'email', address: 'a@b.com' });
  assert.match(sent[1].text, /Emergency kit is in the red box/);
});

// ---------------- payments ----------------
const PAYEES = JSON.stringify({ electricity: { fundAccountId: 'fa_123abc', mode: 'UPI', purpose: 'utility bill' } });
const LIVE_ENV = { PAYMENTS_PROVIDER: 'razorpayx', RAZORPAYX_KEY_ID: 'rzp_k', RAZORPAYX_KEY_SECRET: 's3cret', RAZORPAYX_ACCOUNT_NUMBER: '2323230000', TWIN_PAYEES_JSON: PAYEES };

test('payments: default is a SIMULATION and never calls the network', async () => {
  const f = mkFetch(() => { throw new Error('network must not be used'); });
  const p = createPayments({ TWIN_PAYEES_JSON: PAYEES }, f);
  assert.equal(p.live, false);
  const r = await p.handler(U, { id: 'i1', amount: 250, payee: 'electricity' });
  assert.equal(r.simulated, true);
  assert.equal(f.calls.length, 0);
});

test('payments: live request matches the Razorpay X API (paise, idempotency, basic auth)', async () => {
  const f = mkFetch(() => ({ status: 200, json: { id: 'pout_1', status: 'processing', utr: null } }));
  const p = createPayments(LIVE_ENV, f);
  assert.equal(p.live, true);
  const r = await p.handler(U, { id: 'abc-123', amount: 499.5, payee: 'electricity' });
  assert.equal(r.simulated, false);
  assert.equal(r.payoutId, 'pout_1');
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.razorpay.com/v1/payouts');
  assert.equal(c.opts.headers['X-Payout-Idempotency'], 'abc-123');
  assert.equal(c.opts.headers.Authorization, 'Basic ' + Buffer.from('rzp_k:s3cret').toString('base64'));
  const b = JSON.parse(c.opts.body);
  assert.equal(b.amount, 49950);
  assert.equal(b.currency, 'INR');
  assert.equal(b.fund_account_id, 'fa_123abc');
  assert.equal(b.mode, 'UPI');
  assert.equal(b.queue_if_low_balance, false);
  assert.ok(b.narration.length <= 30 && /^[a-zA-Z0-9 ]+$/.test(b.narration));
});

test('payments: validation (unknown payee, decimals, ceiling, tiny amounts)', async () => {
  const p = createPayments({ ...LIVE_ENV, TWIN_MAX_PAYMENT_INR: '1000' }, mkFetch(() => ({ status: 200 })));
  await assert.rejects(() => p.handler(U, { id: 'x', amount: 10, payee: 'stranger' }), /unknown payee/);
  await assert.rejects(() => p.handler(U, { id: 'x', amount: 10.123, payee: 'electricity' }), /2 decimals/);
  await assert.rejects(() => p.handler(U, { id: 'x', amount: 1001, payee: 'electricity' }), /hard ceiling/);
  await assert.rejects(() => p.handler(U, { id: 'x', amount: 0.5, payee: 'electricity' }), /minimum/);
  assert.throws(() => parsePayees('{"x":{"fundAccountId":"bad"}}'), /fa_/);
  assert.throws(() => parsePayees('nope'), /not valid JSON/);
});

test('payments: 5xx / timeout are UNCERTAIN (ambiguous), 4xx and failed status are definite', async () => {
  const mk = (r) => createPayments(LIVE_ENV, typeof r === 'function' ? r : mkFetch(() => r));
  await assert.rejects(() => mk({ status: 502 }).handler(U, { id: 'a', amount: 10, payee: 'electricity' }), (e) => e.ambiguous === true);
  await assert.rejects(() => mk(async () => { throw new Error('socket hang up'); }).handler(U, { id: 'a', amount: 10, payee: 'electricity' }), (e) => e.ambiguous === true);
  await assert.rejects(() => mk({ status: 400, json: { error: { description: 'low balance' } } }).handler(U, { id: 'a', amount: 10, payee: 'electricity' }), (e) => !e.ambiguous && /low balance/.test(e.message));
  await assert.rejects(() => mk({ status: 200, json: { status: 'failed' } }).handler(U, { id: 'a', amount: 10, payee: 'electricity' }), (e) => !e.ambiguous && /failed/.test(e.message));
});

// ---------------- deploy ----------------
const HOOK = 'https://api.render.com/deploy/srv-abc?key=SECRETKEY';

test('deploy: hook URLs must be https://api.render.com', () => {
  assert.deepEqual(Object.keys(parseHooks(JSON.stringify({ stg: HOOK }))), ['stg']);
  assert.throws(() => parseHooks(JSON.stringify({ x: 'https://evil.example.com/hook' })), /api\.render\.com/);
  assert.throws(() => parseHooks(JSON.stringify({ x: 'http://api.render.com/deploy/a' })), /api\.render\.com/);
});

test('deploy: evaluateChecks only passes when every check completed successfully', () => {
  const ok = { check_runs: [{ status: 'completed', conclusion: 'success', head_sha: 'abcdef123' }, { status: 'completed', conclusion: 'skipped', head_sha: 'abcdef123' }] };
  assert.equal(evaluateChecks(ok, 'main').checksPassed, true);
  assert.equal(evaluateChecks({ check_runs: [] }, 'main').checksPassed, false);
  assert.equal(evaluateChecks({ check_runs: [{ status: 'in_progress' }] }, 'main').checksPassed, false);
  assert.equal(evaluateChecks({ check_runs: [{ status: 'completed', conclusion: 'failure', head_sha: 'a' }] }, 'main').checksPassed, false);
  assert.equal(evaluateChecks(null, 'main').checksPassed, false);
});

test('deploy: preflight reads GitHub; without GitHub config checks can never be proven', async () => {
  const f = mkFetch(() => ({ status: 200, json: { check_runs: [{ status: 'completed', conclusion: 'success', head_sha: '1234567890' }] } }));
  const d = createDeploy({ TWIN_DEPLOY_HOOKS_JSON: JSON.stringify({ stg: HOOK }), GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'me/Aureone-' }, f);
  const r = await d.preflight(U, { target: 'stg', payload: { ref: 'main' } });
  assert.equal(r.checksPassed, true);
  assert.match(f.calls[0].url, /repos\/me\/Aureone-\/commits\/main\/check-runs/);
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer ghp_x');
  assert.equal((await d.preflight(U, { target: 'other' })).checksPassed, false);
  // a caller-supplied ref must be ignored: only the branch Render deploys (default 'main') may vouch for a deploy
  f.calls.length = 0;
  await d.preflight(U, { target: 'stg', payload: { ref: 'some-green-branch' } });
  assert.match(f.calls[0].url, /commits\/main\/check-runs/);
  assert.ok(!f.calls[0].url.includes('some-green-branch'));

  const noGh = createDeploy({ TWIN_DEPLOY_HOOKS_JSON: JSON.stringify({ stg: HOOK }) }, f);
  assert.equal((await noGh.preflight(U, { target: 'stg' })).checksPassed, false);
  const down = createDeploy({ TWIN_DEPLOY_HOOKS_JSON: JSON.stringify({ stg: HOOK }), GITHUB_TOKEN: 't', GITHUB_REPO: 'a/b' }, mkFetch(() => ({ status: 500 })));
  assert.equal((await down.preflight(U, { target: 'stg' })).checksPassed, false);
});

test('deploy: handler posts to the hook and never leaks the secret key in errors', async () => {
  const f = mkFetch(() => ({ status: 200 }));
  const d = createDeploy({ TWIN_DEPLOY_HOOKS_JSON: JSON.stringify({ stg: HOOK }) }, f);
  assert.equal((await d.handler(U, { target: 'stg' })).triggered, true);
  assert.equal(f.calls[0].opts.method, 'POST');
  const bad = createDeploy({ TWIN_DEPLOY_HOOKS_JSON: JSON.stringify({ stg: HOOK }) }, mkFetch(() => ({ status: 401 })));
  await assert.rejects(() => bad.handler(U, { target: 'stg' }), (e) => /401/.test(e.message) && !e.message.includes('SECRETKEY'));
  const dead = createDeploy({ TWIN_DEPLOY_HOOKS_JSON: JSON.stringify({ stg: HOOK }) }, async () => { throw new Error('boom ' + HOOK); });
  await assert.rejects(() => dead.handler(U, { target: 'stg' }), (e) => !e.message.includes('SECRETKEY'));
});

// ---------------- end to end through the guardrails ----------------
function liveTwin(extra = {}) {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const fetch = extra.fetch;
  const twin = createTwin({ dataDir: ':memory:', now: () => clock.t, env: { ...LIVE_ENV, TWIN_DEPLOY_HOOKS_JSON: JSON.stringify({ stg: HOOK }), GITHUB_TOKEN: 't', GITHUB_REPO: 'a/b' }, fetch, ...extra.opts });
  return { twin, clock };
}

test('e2e: simulated payment (default) never uses up the daily budget and is labelled in the audit log', async () => {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const twin = createTwin({ dataDir: ':memory:', now: () => clock.t, env: { TWIN_PAYEES_JSON: PAYEES } });
  await twin.autonomy.setLimits(U, 'finance', { perTxnCap: 500, dailyCap: 500, allowedPayees: ['electricity'] });
  await twin.autonomy.setLevel(U, 'finance', 3);
  for (let i = 0; i < 3; i++) {
    const r = await twin.core.run(U, { feature: 'finance', action: 'pay_bill', amount: 500, payee: 'electricity' });
    assert.equal(r.status, 'executed');
    assert.equal(r.simulated, true);
  }
  assert.equal((await twin.autonomy.get(U)).counters.spent, 0);
  assert.match((await twin.core.getAudit(U))[0].detail, /SIMULATED/);
});

test('e2e: live payment inside limits executes once with an idempotency key; budget is consumed', async () => {
  const f = mkFetch(() => ({ status: 200, json: { id: 'pout_9', status: 'processing' } }));
  const { twin } = liveTwin({ fetch: f });
  await twin.autonomy.setLimits(U, 'finance', { perTxnCap: 500, dailyCap: 600, allowedPayees: ['electricity'] });
  await twin.autonomy.setLevel(U, 'finance', 3);
  assert.equal((await twin.core.run(U, { feature: 'finance', action: 'pay_bill', amount: 500, payee: 'electricity' })).status, 'executed');
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].opts.headers['X-Payout-Idempotency'].length >= 30);
  const over = await twin.core.run(U, { feature: 'finance', action: 'pay_bill', amount: 500, payee: 'electricity' });
  assert.equal(over.status, 'pending_approval');
  assert.equal(f.calls.length, 1, 'over-budget request must not reach the bank');
});

test('e2e: an UNCERTAIN payment failure keeps the budget reserved (money may have moved)', async () => {
  const f = mkFetch(() => ({ status: 503 }));
  const { twin } = liveTwin({ fetch: f });
  await twin.autonomy.setLimits(U, 'finance', { perTxnCap: 500, dailyCap: 500, allowedPayees: ['electricity'] });
  await twin.autonomy.setLevel(U, 'finance', 3);
  const r = await twin.core.run(U, { feature: 'finance', action: 'pay_bill', amount: 500, payee: 'electricity' });
  assert.equal(r.status, 'failed');
  assert.equal(r.uncertain, true);
  assert.equal((await twin.autonomy.get(U)).counters.spent, 500);
  assert.match((await twin.core.getAudit(U))[0].detail, /UNCERTAIN/);
});

test('e2e: approved live payment counts toward spend; definite failure refunds nothing extra', async () => {
  const f = mkFetch(() => ({ status: 200, json: { id: 'pout_1', status: 'queued' } }));
  const { twin } = liveTwin({ fetch: f });
  const q = await twin.core.run(U, { feature: 'finance', action: 'pay_bill', amount: 300, payee: 'electricity' });
  assert.equal(q.status, 'pending_approval');
  assert.equal((await twin.core.approve(U, q.id)).ok, true);
  assert.equal((await twin.autonomy.get(U)).counters.spent, 300);
  assert.equal(JSON.parse(f.calls[0].opts.body).reference_id.length <= 40, true);
});

test('e2e: auto deploy needs GitHub proof; approving still works when checks cannot be proven', async () => {
  let ghChecks = 'success';
  const f = mkFetch((url) => {
    if (url.includes('api.github.com')) return { status: 200, json: { check_runs: [{ status: 'completed', conclusion: ghChecks, head_sha: 'abcdef1234' }] } };
    return { status: 200 };
  });
  const { twin } = liveTwin({ fetch: f });
  await twin.autonomy.setLimits(U, 'deploy', { allowedTargets: ['stg'] });
  await twin.autonomy.setLevel(U, 'deploy', 3);

  const good = await twin.core.run(U, { feature: 'deploy', action: 'deploy', target: 'stg' });
  assert.equal(good.status, 'executed');
  assert.ok(f.calls.some((c) => c.url.startsWith('https://api.render.com/deploy/')));

  ghChecks = 'failure';
  const before = f.calls.filter((c) => c.url.includes('render.com')).length;
  const red = await twin.core.run(U, { feature: 'deploy', action: 'deploy', target: 'stg' });
  assert.equal(red.status, 'pending_approval');
  assert.equal(f.calls.filter((c) => c.url.includes('render.com')).length, before, 'no deploy while checks are red');
  assert.match((await twin.core.listApprovals(U, 'pending'))[0].meta.checks, /failed/);
  assert.equal((await twin.core.approve(U, red.id)).ok, true, 'human can still decide to deploy');
});

// ---------------- concurrency / Firestore-style retries ----------------
// Firestore re-runs a transaction's function on contention. This wrapper simulates that by running fn once extra first.
function retryingStore() {
  const inner = memoryStore();
  return {
    ...inner,
    async update(uid, key, fn, def) {
      const snapshot = await inner.get(uid, key, def);
      try { fn(snapshot); } catch (_) { /* first attempt result is discarded, like an aborted transaction */ }
      return inner.update(uid, key, fn, def);
    },
  };
}

test('retrying store: an approval still executes exactly once (claim state is reset on every retry)', async () => {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const twin = createTwin({ store: retryingStore(), now: () => clock.t, env: {} });
  let ran = 0;
  twin.core.registerHandler('x', async () => { ran++; });
  const q = await twin.core.run(U, { feature: 'execution', action: 'x' });
  const results = await Promise.all([twin.core.approve(U, q.id), twin.core.approve(U, q.id), twin.core.approve(U, q.id)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(ran, 1);
});

test('two overlapping ticks run a due target only once', async () => {
  const twin = createTwin({ dataDir: ':memory:', env: {} });
  let ran = 0;
  twin.core.registerHandler('a', async () => { ran++; });
  await twin.autonomy.setLimits(U, 'execution', { allowedActions: ['a'], maxPerDay: 50 });
  await twin.autonomy.setLevel(U, 'execution', 3);
  await twin.agent.addTarget(U, { everyMs: DAY, intent: { feature: 'execution', action: 'a' } });
  await Promise.all([twin.agent.tick(U), twin.agent.tick(U), twin.agent.tick(U)]);
  assert.equal(ran, 1);
});

test('two overlapping dead-man ticks email each contact only once', async () => {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const sent = [];
  const owner = [];
  const twin = createTwin({
    dataDir: ':memory:', now: () => clock.t, env: {},
    deliver: async (_u, a, c) => { await new Promise((r) => setTimeout(r, 5)); sent.push(c.name); },
    notify: async (_u, p) => { if (p.kind === 'continuity') owner.push(p.text); },
  });
  await twin.continuity.configure(U, {
    enabled: true, inactivityDays: 30, graceHours: 48,
    contacts: [{ name: 'Mom', channel: 'email', address: 'mom@example.com' }],
    actions: [{ type: 'message', to: 'Mom', text: 'hello' }],
  });
  clock.t += 31 * DAY;
  await Promise.all([twin.continuity.tick(U), twin.continuity.tick(U)]);
  assert.equal(owner.filter((t) => /FINAL WARNING/.test(t)).length, 1, 'final warning only once');
  clock.t += 49 * HOUR;
  await Promise.all([twin.continuity.tick(U), twin.continuity.tick(U), twin.continuity.tick(U)]);
  assert.deepEqual(sent, ['Mom']);
});

test('dead-man: owner checks in while delivery is in progress => remaining sends are aborted and plan re-arms', async () => {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const sent = [];
  let twinRef;
  const twin = createTwin({
    dataDir: ':memory:', now: () => clock.t, env: {},
    deliver: async (_u, a, c) => { sent.push(c.name); if (c.name === 'Mom') await twinRef.continuity.checkIn(U); },
  });
  twinRef = twin;
  await twin.continuity.configure(U, {
    enabled: true, inactivityDays: 30, graceHours: 48,
    contacts: [{ name: 'Mom', channel: 'email', address: 'mom@example.com' }, { name: 'Dad', channel: 'email', address: 'dad@example.com' }],
    actions: [{ type: 'message', to: 'Mom', text: 'a' }, { type: 'message', to: 'Dad', text: 'b' }],
  });
  clock.t += 31 * DAY;
  await twin.continuity.tick(U);
  clock.t += 49 * HOUR;
  const r = await twin.continuity.tick(U);
  assert.equal(r.event, 'aborted');
  assert.deepEqual(sent, ['Mom'], 'Dad must not be emailed after the owner checked in');
  const cfg = await twin.continuity.get(U);
  assert.equal(cfg.state, 'ok');
  assert.ok(cfg.actions.every((a) => !a.done), 'plan is re-armed for the future');
});

// ---------------- routes ----------------
test('routes: shadow learning can be paused; overview exposes honest status; test-email only goes to OWNER_EMAIL', async () => {
  const sent = [];
  const twin = createTwin({
    dataDir: ':memory:', env: { OWNER_EMAIL: 'owner@example.com' },
    mailer: { configured: true, provider: 'brevo', send: async (m) => sent.push(m) },
  });
  const h = handlers(twin);
  await h['POST /twin/autonomy/level']({ uid: U, body: { feature: 'shadow', level: 1 } });
  const r = await h['POST /twin/shadow/event']({ uid: U, body: { type: 'message', text: 'hello there my friend' } });
  assert.equal(r.body.skipped, 'learning is paused');
  assert.equal((await twin.shadow.getProfile(U)).learned, false);
  await h['POST /twin/autonomy/level']({ uid: U, body: { feature: 'shadow', level: 3 } });
  await h['POST /twin/shadow/event']({ uid: U, body: { type: 'message', text: 'hello there my friend' } });
  assert.equal((await twin.shadow.getProfile(U)).learned, true);

  const ov = await h['GET /twin/overview']({ uid: U, body: {}, query: {} });
  assert.equal(ov.body.info.payments, 'simulated');
  assert.equal(ov.body.info.ownerEmailSet, true);

  const t = await h['POST /twin/test-email']({ uid: U, body: { to: 'victim@example.com' } });
  assert.equal(t.status, 200);
  assert.equal(sent[0].to, 'owner@example.com');
});

test('routes: assets are stored, listed by label only, and removable', async () => {
  const twin = createTwin({ dataDir: ':memory:', env: {} });
  const h = handlers(twin);
  await h['POST /twin/assets']({ uid: U, body: { id: 'pm', label: 'Password manager', text: 'Kit is in the red box' } });
  const list = await h['GET /twin/assets']({ uid: U, body: {}, query: {} });
  assert.deepEqual(list.body.items, [{ id: 'pm', label: 'Password manager' }]);
  assert.ok(!JSON.stringify(list.body).includes('red box'));
  assert.equal((await h['POST /twin/assets']({ uid: U, body: { id: '', label: 'x', text: 'y' } })).status, 400);
  await h['DELETE /twin/assets']({ uid: U, body: { id: 'pm' } });
  assert.equal((await h['GET /twin/assets']({ uid: U, body: {}, query: {} })).body.items.length, 0);
});


// ---------------- regressions from the independent review ----------------
test('review #1: the caller cannot pick a weaker feature to dodge limits; non-executable features are denied', async () => {
  const f = mkFetch(() => ({ status: 200, json: { id: 'pout_1', status: 'processing' } }));
  const { twin } = liveTwin({ fetch: f });
  await twin.autonomy.setLevel(U, 'finance', 1); // owner says: only suggest
  const spoof = await twin.core.run(U, { feature: 'shadow', action: 'pay_bill', amount: 400, payee: 'electricity' });
  assert.equal(spoof.status, 'suggested', 'must be judged as finance, not shadow');
  assert.equal(f.calls.length, 0, 'nothing may reach the bank');
  const spoof2 = await twin.core.run(U, { feature: 'selfcorrect', action: 'deploy', target: 'stg' });
  assert.equal(spoof2.status, 'pending_approval', 'deploy stays under deploy rules (level 2)');
  assert.equal((await twin.core.run(U, { feature: 'shadow', action: 'unknown_thing' })).status, 'denied');
  assert.throws(() => twin.core.registerHandler('x', async () => {}, 'shadow'), /feature must be/);
});

test('review #2: deploy checks always look at the deployed branch, never a caller-chosen ref', async () => {
  let ghRef = null;
  const f = mkFetch((url) => {
    if (url.includes('api.github.com')) {
      ghRef = decodeURIComponent(url.split('/commits/')[1].split('/check-runs')[0]);
      return { status: 200, json: { check_runs: [{ status: 'completed', conclusion: ghRef === 'main' ? 'failure' : 'success', head_sha: 'abcdef1' }] } };
    }
    return { status: 200 };
  });
  const { twin } = liveTwin({ fetch: f });
  await twin.autonomy.setLimits(U, 'deploy', { allowedTargets: ['stg'] });
  await twin.autonomy.setLevel(U, 'deploy', 3);
  const r = await twin.core.run(U, { feature: 'deploy', action: 'deploy', target: 'stg', payload: { ref: 'green-branch' } });
  assert.equal(ghRef, 'main');
  assert.equal(r.status, 'pending_approval');
  assert.ok(!f.calls.some((c) => c.url.includes('render.com')));
});

test('review #3: /twin/tick never crashes on odd secrets and only accepts the real one', async () => {
  const { mount } = require('../twin/routes');
  process.env.TWIN_TICK_SECRET = 'abcdefgh';
  const twin = createTwin({ dataDir: ':memory:', env: {} });
  let tickHandler;
  const router = new Proxy({}, { get: (_, m) => (path, ...fns) => { if (m === 'post' && path === '/twin/tick') tickHandler = fns[fns.length - 1]; } });
  mount(router, twin, (r, s, n) => n());
  const call = async (header) => {
    let status = 200, body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    await tickHandler({ get: () => header }, res);
    return { status, body };
  };
  assert.equal((await call('\u00e9\u00e9\u00e9\u00e9')).status, 401); // 4 chars but 8 bytes
  assert.equal((await call(undefined)).status, 401);
  assert.equal((await call('wrong-secret')).status, 401);
  assert.equal((await call('abcdefgh')).status, 200);
  delete process.env.TWIN_TICK_SECRET;
});

test('review #4: a failing recurring-target job can never stop the dead-man switch', async () => {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const inner = memoryStore();
  const broken = { ...inner, update(uid, key, fn, def) { if (key === 'targets') throw new Error('targets store down'); return inner.update(uid, key, fn, def); } };
  const sent = [];
  const twin = createTwin({ store: broken, now: () => clock.t, env: {}, deliver: async (_u, a, c) => { sent.push(c.name); } });
  await twin.continuity.configure(U, {
    enabled: true, inactivityDays: 30, graceHours: 48,
    contacts: [{ name: 'Mom', channel: 'email', address: 'mom@example.com' }],
    actions: [{ type: 'message', to: 'Mom', text: 'hello' }],
  });
  const quiet = console.error; console.error = () => {};
  try {
    clock.t += 31 * DAY; await twin.tickAll();
    assert.equal((await twin.continuity.get(U)).state, 'final_warning');
    clock.t += 49 * HOUR; await twin.tickAll();
  } finally { console.error = quiet; }
  assert.deepEqual(sent, ['Mom']);
});

test('review #5: each contact is marked as sent right after delivery (a crash cannot cause a re-send)', async () => {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  let twinRef; let seenWhenSendingB = null;
  const twin = createTwin({
    dataDir: ':memory:', now: () => clock.t, env: {},
    deliver: async (_u, a, c) => { if (c.name === 'B') seenWhenSendingB = (await twinRef.continuity.get(U)).actions[0].done; },
  });
  twinRef = twin;
  await twin.continuity.configure(U, {
    enabled: true, inactivityDays: 30, graceHours: 48,
    contacts: [{ name: 'A', channel: 'email', address: 'a@x.com' }, { name: 'B', channel: 'email', address: 'b@x.com' }],
    actions: [{ type: 'message', to: 'A', text: 'a' }, { type: 'message', to: 'B', text: 'b' }],
  });
  clock.t += 31 * DAY; await twin.continuity.tick(U);
  clock.t += 49 * HOUR; await twin.continuity.tick(U);
  assert.equal(seenWhenSendingB, true, 'A must already be persisted as done while B is being sent');
});

test('review #6: a failing audit write after a real payment neither refunds the budget nor reports failure', async () => {
  const f = mkFetch(() => ({ status: 200, json: { id: 'pout_1', status: 'processing' } }));
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const inner = memoryStore();
  let breakAudit = false;
  const store = { ...inner, update(uid, key, fn, def) { if (breakAudit && key === 'audit') throw new Error('audit write failed'); return inner.update(uid, key, fn, def); } };
  const twin = createTwin({ store, now: () => clock.t, fetch: f, env: LIVE_ENV });
  await twin.autonomy.setLimits(U, 'finance', { perTxnCap: 100, dailyCap: 100, allowedPayees: ['electricity'] });
  await twin.autonomy.setLevel(U, 'finance', 3);
  breakAudit = true;
  const quietErr = console.error; console.error = () => {};
  const r1 = await twin.core.run(U, { feature: 'finance', action: 'pay_bill', amount: 100, payee: 'electricity' });
  assert.equal(r1.status, 'executed');
  const r2 = await twin.core.run(U, { feature: 'finance', action: 'pay_bill', amount: 100, payee: 'electricity' });
  assert.equal(r2.status, 'pending_approval', 'daily cap must still be used up');
  console.error = quietErr;
  assert.equal(f.calls.length, 1, 'only one real payment');
});

test('review #7: infinite / absurd schedules and oversized payloads are rejected or clamped', async () => {
  const twin = createTwin({ dataDir: ':memory:', env: {} });
  const t1 = await twin.agent.addTarget(U, { everyMs: Infinity, intent: { feature: 'execution', action: 'a' } });
  assert.equal(t1.everyMs, DAY, 'non-finite falls back to daily');
  const t2 = await twin.agent.addTarget(U, { id: 'big', everyMs: 1e18, intent: { feature: 'execution', action: 'a' } });
  assert.equal(t2.everyMs, 365 * DAY);
  await assert.rejects(() => twin.agent.addTarget(U, { intent: { feature: 'execution', action: 'a', payload: 'x'.repeat(5000) } }), /payload too large/);
  const big = await twin.core.run(U, { feature: 'execution', action: 'a', payload: { blob: 'x'.repeat(5000) } });
  assert.equal(big.status, 'denied');
});
