'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTwin } = require('../twin');
const { handlers } = require('../twin/routes');
const { fileStore } = require('../twin/store');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const U = 'user1';

function make(extra = {}) {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const twin = createTwin({ dataDir: ':memory:', now: () => clock.t, ...extra });
  return { twin, clock };
}

// ---------------- store ----------------
test('store rejects path-traversal uids and keys', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-'));
  const s = fileStore(dir);
  await assert.rejects(() => s.set('../evil', 'k', 1), /invalid uid/);
  await assert.rejects(() => s.set('ok', '../k', 1), /invalid key/);
  await s.set('ok', 'k', { a: 1 });
  assert.deepEqual(await s.get('ok', 'k'), { a: 1 });
  assert.deepEqual(await s.listUids(), ['ok']);
});

test('store: concurrent updates do not lose writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-'));
  const s = fileStore(dir);
  await Promise.all(Array.from({ length: 40 }, () => s.update('u', 'n', (v) => (v || 0) + 1, 0)));
  assert.equal(await s.get('u', 'n'), 40);
});

// ---------------- shadow ----------------
test('shadow learns language, verbosity and code style without storing raw text', async () => {
  const { twin } = make();
  for (const text of ['bhai ye kaam kar do abhi', 'aur ye bhi bana do boss', 'mujhe ye chahiye nahi to rehne do']) {
    await twin.shadow.record(U, { type: 'message', text });
  }
  await twin.shadow.record(U, {
    type: 'code',
    code: "const getUser = (id) => {\n  const userName = 'a';\n  return userName;\n};\n",
  });
  const p = await twin.shadow.getProfile(U);
  assert.equal(p.language, 'Hinglish');
  assert.equal(p.verbosity, 'short');
  assert.equal(p.code.quotes, 'single');
  assert.equal(p.code.semicolons, true);
  assert.equal(p.code.indent, '2 spaces');
  assert.equal(p.code.naming, 'camelCase');
  const raw = JSON.stringify(await twin.store.get(U, 'shadow'));
  assert.ok(!raw.includes('bhai ye kaam kar do'), 'raw message must not be stored');
  assert.ok(!raw.includes('getUser'), 'raw code must not be stored');
  const ctx = await twin.shadow.toPromptContext(U);
  assert.match(ctx, /Hinglish/);
  await twin.shadow.forget(U);
  assert.equal((await twin.shadow.getProfile(U)).learned, false);
});

test('shadow rejects unknown event types', async () => {
  const { twin } = make();
  await assert.rejects(() => twin.shadow.record(U, { type: 'spy' }), /unknown event type/);
});

// ---------------- autonomy ----------------
test('finance and deploy cannot go Level 3 until limits exist', async () => {
  const { twin } = make();
  await assert.rejects(() => twin.autonomy.setLevel(U, 'finance', 3), /set limits/);
  await assert.rejects(() => twin.autonomy.setLevel(U, 'deploy', 3), /set limits/);
  await twin.autonomy.setLimits(U, 'finance', { perTxnCap: 500, dailyCap: 1000, allowedPayees: ['electricity'] });
  const s = await twin.autonomy.setLevel(U, 'finance', 3);
  assert.equal(s.levels.finance, 3);
});

test('default level 2: money/deploy always go to the approval queue', async () => {
  const { twin } = make();
  twin.core.registerHandler('pay', async () => 'paid', 'finance');
  const r = await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 10, payee: 'x' });
  assert.equal(r.status, 'pending_approval');
  const d = await twin.core.run(U, { feature: 'deploy', action: 'deploy', target: 'render', checksPassed: true });
  assert.equal(d.status, 'pending_approval');
});

test('level 3 finance: auto inside limits, queue outside, caps enforced per day', async () => {
  const { twin, clock } = make();
  let paid = 0;
  twin.core.registerHandler('pay', async (_u, i) => { paid += i.amount; return 'ok'; }, 'finance');
  await twin.autonomy.setLimits(U, 'finance', { perTxnCap: 500, dailyCap: 800, allowedPayees: ['electricity'] });
  await twin.autonomy.setLevel(U, 'finance', 3);

  assert.equal((await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 400, payee: 'electricity' })).status, 'executed');
  // above per-txn cap
  assert.equal((await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 600, payee: 'electricity' })).status, 'pending_approval');
  // unknown payee
  assert.equal((await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 50, payee: 'stranger' })).status, 'pending_approval');
  // 400 spent, +400 = 800 allowed, +1 more would exceed
  assert.equal((await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 400, payee: 'electricity' })).status, 'executed');
  const over = await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 1, payee: 'electricity' });
  assert.equal(over.status, 'pending_approval');
  assert.match(over.reason, /daily cap/);
  assert.equal(paid, 800);
  // next day the budget resets
  clock.t += DAY;
  assert.equal((await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 100, payee: 'electricity' })).status, 'executed');
});

test('invalid or negative amounts are denied outright', async () => {
  const { twin } = make();
  for (const amount of [0, -5, NaN, 'abc']) {
    const r = await twin.core.run(U, { feature: 'finance', action: 'pay', amount, payee: 'x' });
    assert.equal(r.status, 'denied');
  }
});

test('failed auto action refunds the reserved budget', async () => {
  const { twin } = make();
  let fail = true;
  twin.core.registerHandler('pay', async () => { if (fail) throw new Error('bank down'); return 'ok'; }, 'finance');
  await twin.autonomy.setLimits(U, 'finance', { perTxnCap: 500, dailyCap: 500, allowedPayees: ['p'] });
  await twin.autonomy.setLevel(U, 'finance', 3);
  const a = await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 500, payee: 'p' });
  assert.equal(a.status, 'failed');
  fail = false;
  const b = await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 500, payee: 'p' });
  assert.equal(b.status, 'executed');
});

test('deploy auto requires allowlisted target AND a server preflight that proves checks passed', async () => {
  const { twin } = make();
  let checks = true;
  twin.core.registerHandler('deploy', async () => 'deployed', 'deploy');
  twin.core.registerPreflight('deploy', async () => ({ checksPassed: checks, meta: { checks: checks ? 'all green' : 'red' } }));
  await twin.autonomy.setLimits(U, 'deploy', { allowedTargets: ['render-staging'] });
  await twin.autonomy.setLevel(U, 'deploy', 3);
  assert.equal((await twin.core.run(U, { feature: 'deploy', action: 'deploy', target: 'render-staging' })).status, 'executed');
  checks = false;
  const red = await twin.core.run(U, { feature: 'deploy', action: 'deploy', target: 'render-staging' });
  assert.equal(red.status, 'pending_approval');
  assert.equal((await twin.core.listApprovals(U, 'pending'))[0].meta.checks, 'red');
  checks = true;
  assert.equal((await twin.core.run(U, { feature: 'deploy', action: 'deploy', target: 'render-prod' })).status, 'pending_approval');
});

test('a caller can never claim checksPassed: without a preflight, auto deploy always waits for approval', async () => {
  const { twin } = make();
  twin.core.registerHandler('deploy', async () => 'deployed', 'deploy');
  await twin.autonomy.setLimits(U, 'deploy', { allowedTargets: ['render-staging'] });
  await twin.autonomy.setLevel(U, 'deploy', 3);
  const r = await twin.core.run(U, { feature: 'deploy', action: 'deploy', target: 'render-staging', checksPassed: true, meta: { checks: 'fake' } });
  assert.equal(r.status, 'pending_approval');
});

test('removing limits drops level 3 back to approval mode', async () => {
  const { twin } = make();
  await twin.autonomy.setLimits(U, 'deploy', { allowedTargets: ['a'] });
  await twin.autonomy.setLevel(U, 'deploy', 3);
  const s = await twin.autonomy.setLimits(U, 'deploy', { allowedTargets: [] });
  assert.equal(s.levels.deploy, 2);
});

test('level 1 only suggests; freeze denies everything and blocks approvals', async () => {
  const { twin } = make();
  let ran = 0;
  twin.core.registerHandler('open_app', async () => { ran++; });
  await twin.autonomy.setLevel(U, 'execution', 1);
  assert.equal((await twin.core.run(U, { feature: 'execution', action: 'open_app' })).status, 'suggested');
  assert.equal(ran, 0);

  await twin.autonomy.setLevel(U, 'execution', 2);
  const q = await twin.core.run(U, { feature: 'execution', action: 'open_app' });
  await twin.autonomy.setFrozen(U, true);
  assert.equal((await twin.core.run(U, { feature: 'execution', action: 'open_app' })).status, 'denied');
  const blocked = await twin.core.approve(U, q.id);
  assert.equal(blocked.ok, false);
  assert.equal(ran, 0);
  await twin.autonomy.setFrozen(U, false);
  assert.equal((await twin.core.approve(U, q.id)).ok, true);
  assert.equal(ran, 1);
});

// ---------------- approvals ----------------
test('approve executes exactly once, even on double tap', async () => {
  const { twin } = make();
  let ran = 0;
  twin.core.registerHandler('send_report', async () => { ran++; return 'sent'; });
  const q = await twin.core.run(U, { feature: 'execution', action: 'send_report', summary: 'Send weekly report' });
  const results = await Promise.all([twin.core.approve(U, q.id), twin.core.approve(U, q.id)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(ran, 1);
});

test('reject, expiry and unknown ids behave correctly', async () => {
  const { twin, clock } = make();
  twin.core.registerHandler('x', async () => 'x');
  const a = await twin.core.run(U, { feature: 'execution', action: 'x' });
  assert.equal((await twin.core.reject(U, a.id)).ok, true);
  assert.equal((await twin.core.approve(U, a.id)).ok, false);

  const b = await twin.core.run(U, { feature: 'execution', action: 'x' });
  clock.t += 2 * DAY;
  const r = await twin.core.approve(U, b.id);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'expired');
  assert.equal((await twin.core.approve(U, 'nope')).error, 'not_found');
});

test('approved finance action counts toward spend and a failing handler is reported', async () => {
  const { twin } = make();
  twin.core.registerHandler('pay', async () => 'ok', 'finance');
  twin.core.registerHandler('boom', async () => { throw new Error('nope'); });
  const q = await twin.core.run(U, { feature: 'finance', action: 'pay', amount: 250, payee: 'p' });
  await twin.core.approve(U, q.id);
  assert.equal((await twin.autonomy.get(U)).counters.spent, 250);

  const q2 = await twin.core.run(U, { feature: 'execution', action: 'boom' });
  const r = await twin.core.approve(U, q2.id);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'handler_failed');
});

test('audit log records what happened', async () => {
  const { twin } = make();
  twin.core.registerHandler('x', async () => 1);
  const q = await twin.core.run(U, { feature: 'execution', action: 'x' });
  await twin.core.approve(U, q.id);
  const types = (await twin.core.getAudit(U)).map((e) => e.type);
  assert.ok(types.includes('queued') && types.includes('executed'));
});

// ---------------- self-correction ----------------
test('self-correction fixes itself using feedback from the failed try', async () => {
  const { twin } = make();
  const seen = [];
  const r = await twin.selfCorrect({
    maxTries: 3,
    attempt: async ({ try: n, feedback }) => { seen.push(feedback); return n < 3 ? 'bad' : 'good'; },
    verify: async (o) => (o === 'good' ? { ok: true } : { ok: false, issues: ['output was bad'] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.tries, 3);
  assert.deepEqual(seen[1], ['output was bad']);
});

test('self-correction escalates to the human instead of faking success', async () => {
  const { twin } = make();
  const r = await twin.selfCorrect({
    maxTries: 2,
    attempt: async () => { throw new Error('crash'); },
    verify: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.escalate, true);
  assert.match(r.history[0].issues[0], /crashed/);
});

// ---------------- continuity ----------------
function continuityCfg() {
  return {
    enabled: true,
    inactivityDays: 30,
    warnDaysBefore: 5,
    graceHours: 48,
    contacts: [{ name: 'Mom', channel: 'email', address: 'mom@example.com' }],
    actions: [
      { type: 'message', to: 'Mom', text: 'If you are reading this, check the shared folder.' },
      { type: 'message', to: 'Stranger', text: 'should be dropped (not in contacts)' },
    ],
  };
}

test('continuity: warn, final warning, grace, then deliver only to listed contacts', async () => {
  const sent = [];
  const owner = [];
  const { twin, clock } = make({
    deliver: async (_u, action, contact) => { sent.push({ to: contact.name, text: action.text }); },
    notify: async (_u, p) => { if (p.kind === 'continuity') owner.push(p.text); },
  });
  const cfg = await twin.continuity.configure(U, continuityCfg());
  assert.equal(cfg.actions.length, 1, 'action to a non-contact must be dropped');

  clock.t += 10 * DAY;
  assert.equal((await twin.continuity.tick(U)).event, 'none');

  clock.t += 16 * DAY; // day 26 -> inside warn window
  assert.equal((await twin.continuity.tick(U)).event, 'warned');
  assert.equal((await twin.continuity.tick(U)).event, 'none', 'only one warning per day');

  clock.t += 4 * DAY; // day 30
  assert.equal((await twin.continuity.tick(U)).event, 'final_warning');
  assert.equal(sent.length, 0);

  clock.t += 24 * HOUR;
  assert.equal((await twin.continuity.tick(U)).event, 'waiting_grace');
  assert.equal(sent.length, 0);

  clock.t += 25 * HOUR;
  const out = await twin.continuity.tick(U);
  assert.equal(out.event, 'triggered');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'Mom');
  assert.equal((await twin.continuity.tick(U)).event, 'none', 'never fires twice');
  assert.ok(owner.length >= 2);
});

test('continuity: a check-in during the grace window cancels everything', async () => {
  const sent = [];
  const { twin, clock } = make({ deliver: async (_u, a) => { sent.push(a); } });
  await twin.continuity.configure(U, continuityCfg());
  clock.t += 31 * DAY;
  assert.equal((await twin.continuity.tick(U)).event, 'final_warning');
  clock.t += 30 * HOUR;
  await twin.continuity.checkIn(U);
  clock.t += 30 * HOUR;
  assert.equal((await twin.continuity.tick(U)).event, 'none');
  assert.equal(sent.length, 0);
});

test('continuity: failed delivery is retried on the next tick, not lost', async () => {
  let fail = true;
  const sent = [];
  const { twin, clock } = make({
    deliver: async (_u, a) => { if (fail) throw new Error('smtp down'); sent.push(a); },
  });
  await twin.continuity.configure(U, continuityCfg());
  clock.t += 31 * DAY;
  await twin.continuity.tick(U);
  clock.t += 49 * HOUR;
  const first = await twin.continuity.tick(U);
  assert.equal(first.complete, false);
  fail = false;
  assert.equal((await twin.continuity.tick(U)).event, 'waiting_retry', 'must not hammer a failing provider');
  clock.t += 61 * 60 * 1000;
  const second = await twin.continuity.tick(U);
  assert.equal(second.event, 'triggered');
  assert.equal(second.complete, true);
  assert.equal(sent.length, 1);
});

test('continuity: cannot be enabled without contacts and actions', async () => {
  const { twin } = make();
  const cfg = await twin.continuity.configure(U, { enabled: true, contacts: [], actions: [] });
  assert.equal(cfg.enabled, false);
});

// ---------------- execution agent ----------------
test('agent runs due targets through the guardrails', async () => {
  const { twin, clock } = make();
  let ran = 0;
  twin.core.registerHandler('daily_report', async () => { ran++; });
  await twin.agent.addTarget(U, { name: 'report', everyMs: DAY, intent: { feature: 'execution', action: 'daily_report' } });

  // level 2 default -> queued, not executed
  assert.deepEqual((await twin.agent.tick(U)).map((x) => x.status), ['pending_approval']);
  assert.equal(ran, 0);
  assert.deepEqual(await twin.agent.tick(U), [], 'not due again yet');

  await twin.autonomy.setLimits(U, 'execution', { allowedActions: ['daily_report'], maxPerDay: 1 });
  await twin.autonomy.setLevel(U, 'execution', 3);
  clock.t += DAY;
  assert.deepEqual((await twin.agent.tick(U)).map((x) => x.status), ['executed']);
  assert.equal(ran, 1);
});

test('agent: stored targets cannot smuggle checksPassed', async () => {
  const { twin } = make();
  twin.core.registerHandler('deploy', async () => 'd', 'deploy');
  await twin.autonomy.setLimits(U, 'deploy', { allowedTargets: ['stg'] });
  await twin.autonomy.setLevel(U, 'deploy', 3);
  await twin.agent.addTarget(U, { everyMs: DAY, intent: { feature: 'deploy', action: 'deploy', target: 'stg', checksPassed: true } });
  assert.deepEqual((await twin.agent.tick(U)).map((x) => x.status), ['pending_approval']);
});

test('tickAll walks every user and survives a failing one', async () => {
  const { twin } = make();
  twin.core.registerHandler('a', async () => {});
  await twin.agent.addTarget('alice', { everyMs: DAY, intent: { feature: 'execution', action: 'a' } });
  await twin.agent.addTarget('bob', { everyMs: DAY, intent: { feature: 'execution', action: 'a' } });
  await twin.tickAll();
  assert.equal((await twin.core.listApprovals('alice', 'pending')).length, 1);
  assert.equal((await twin.core.listApprovals('bob', 'pending')).length, 1);
});

// ---------------- routes ----------------
test('routes: client cannot claim checksPassed and uid is taken from the verified request only', async () => {
  const { twin } = make();
  twin.core.registerHandler('deploy', async () => 'd', 'deploy');
  await twin.autonomy.setLimits('alice', 'deploy', { allowedTargets: ['stg'] });
  await twin.autonomy.setLevel('alice', 'deploy', 3);
  const h = handlers(twin);
  const out = await h['POST /twin/run']({ uid: 'alice', body: { feature: 'deploy', action: 'deploy', target: 'stg', checksPassed: true, uid: 'bob' } });
  assert.equal(out.body.outcome.status, 'pending_approval');
  assert.equal((await twin.core.listApprovals('bob', 'pending')).length, 0);
});

test('routes: overview redacts contact addresses and bad input returns 400, not a crash', async () => {
  const { twin } = make();
  const h = handlers(twin);
  await h['POST /twin/continuity']({ uid: U, body: continuityCfg() });
  const ov = await h['GET /twin/overview']({ uid: U, body: {}, query: {} });
  const text = JSON.stringify(ov.body);
  assert.ok(!text.includes('mom@example.com'));
  assert.ok(!text.includes('shared folder'));
  const bad = await h['POST /twin/autonomy/level']({ uid: U, body: { feature: 'finance', level: 3 } });
  assert.equal(bad.status, 400);
  const bad2 = await h['POST /twin/shadow/event']({ uid: U, body: { type: 'nope' } });
  assert.equal(bad2.status, 400);
});

// ---------------- scheduler registry (Aureon integration) ----------------
test('scheduler only walks users who have a target or an armed dead-man switch', async () => {
  const { twin } = make();
  twin.core.registerHandler('a', async () => {});
  // "ghost" has data in the store but never created a target or armed continuity -> must not be read/ticked
  await twin.store.set('ghost', 'targets', [{ id: 't1', name: 'x', everyMs: DAY, intent: { feature: 'execution', action: 'a' }, enabled: true, nextRunAt: 0 }]);
  await twin.agent.addTarget('alice', { everyMs: DAY, intent: { feature: 'execution', action: 'a' } });
  assert.deepEqual(await twin.registry.list(), ['alice']);
  const r = await twin.tickAll();
  assert.equal(r.users, 1);
  assert.equal((await twin.core.listApprovals('alice', 'pending')).length, 1);
  assert.equal((await twin.core.listApprovals('ghost', 'pending')).length, 0);
});

test('user with nothing left to do is dropped from the registry (no more reads every tick)', async () => {
  const { twin } = make();
  const t = await twin.agent.addTarget('alice', { everyMs: DAY, intent: { feature: 'execution', action: 'a' } });
  await twin.agent.removeTarget('alice', t.id);
  await twin.tickAll();
  assert.deepEqual(await twin.registry.list(), []);
});

test('an armed dead-man switch registers the user and still fires through tickAll', async () => {
  const sent = [];
  const { twin, clock } = make({ deliver: async (_u, a, c) => { sent.push(c.name + ':' + a.text); } });
  await twin.continuity.configure('alice', {
    enabled: true, inactivityDays: 10, warnDaysBefore: 2, graceHours: 24,
    contacts: [{ name: 'Mom', channel: 'email', address: 'mom@example.com' }],
    actions: [{ type: 'message', to: 'Mom', text: 'hello' }],
  });
  assert.deepEqual(await twin.registry.list(), ['alice']);
  clock.t += 11 * DAY; await twin.tickAll();     // final warning
  clock.t += 25 * HOUR; await twin.tickAll();    // grace over -> delivered
  assert.deepEqual(sent, ['Mom:hello']);
  assert.deepEqual(await twin.registry.list(), ['alice'], 'stays registered while armed (cheap: only this user)');
});

test('a tick that is still running makes the next one skip instead of overlapping', async () => {
  const { twin } = make();
  let release; const gate = new Promise((r) => { release = r; });
  twin.core.registerHandler('slow', async () => { await gate; });
  await twin.autonomy.setLimits('alice', 'execution', { allowedActions: ['slow'], maxPerDay: 5 });
  await twin.autonomy.setLevel('alice', 'execution', 3);
  await twin.agent.addTarget('alice', { everyMs: DAY, intent: { feature: 'execution', action: 'slow' } });
  const first = twin.tickAll();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await twin.tickAll(), { skipped: true });
  release(); await first;
});
