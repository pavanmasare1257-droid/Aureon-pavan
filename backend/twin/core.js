'use strict';
// Core executor: every action (from the app, scheduler, LLM tool-call or self-correct loop) passes through run().
// run() -> server-side preflight (proves things like "tests passed") -> Autonomy decision -> suggest / queue / execute -> audit log.
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
const MAX_APPROVALS = 200;
const MAX_AUDIT = 500;

function createCore({ store, autonomy, now = Date.now, notify = async () => {} }) {
  const handlers = new Map();
  const preflights = new Map();

  const features = new Map(); // action -> feature it belongs to (decided by the SERVER, never by the caller)
  const EXECUTABLE = new Set(['finance', 'deploy', 'execution']);
  const safely = async (fn) => { try { await fn(); } catch (_) { /* bookkeeping after a real action must never undo or hide it */ } };

  // The feature is bound to the action here, so a caller cannot run "pay_bill" under a different feature's (weaker) limits.
  function registerHandler(action, fn, feature = 'execution') {
    if (typeof fn !== 'function') throw new Error('handler must be a function');
    if (!EXECUTABLE.has(feature)) throw new Error('feature must be finance, deploy or execution');
    handlers.set(String(action), fn);
    features.set(String(action), feature);
  }
  // A preflight runs on the SERVER before the autonomy decision. It is the only way `checksPassed` can become true.
  // fn(uid, intent) -> { checksPassed: boolean, meta?: { checks?: string } }
  function registerPreflight(action, fn) {
    if (typeof fn !== 'function') throw new Error('preflight must be a function');
    preflights.set(String(action), fn);
  }

  // The audit log is important but must never break or undo the action it describes, so a failed write is only reported.
  async function audit(uid, entry) {
    try {
      await store.update(uid, 'audit', (list) => {
        const arr = list || [];
        arr.push({ at: now(), ...entry });
        return arr.slice(-MAX_AUDIT);
      }, []);
    } catch (e) {
      console.error('[twin] audit write failed:', e && e.message);
    }
  }
  const getAudit = (uid, limit = 50) => store.get(uid, 'audit', []).then((a) => a.slice(-limit).reverse());

  // ---------- approval queue ----------
  async function propose(uid, intent, reason, ttlMs = DAY) {
    const item = {
      id: crypto.randomUUID(),
      feature: intent.feature,
      action: String(intent.action || ''),
      summary: String(intent.summary || intent.action || '').slice(0, 200),
      amount: intent.amount ?? null,
      payee: intent.payee ?? null,
      target: intent.target ?? null,
      payload: intent.payload ?? null,
      meta: intent.meta ?? null,
      reason,
      status: 'pending',
      createdAt: now(),
      expiresAt: now() + ttlMs,
    };
    await store.update(uid, 'approvals', (list) => {
      const arr = list || [];
      if (arr.length >= MAX_APPROVALS) {
        const firstResolved = arr.findIndex((x) => x.status !== 'pending');
        arr.splice(firstResolved >= 0 ? firstResolved : 0, 1);
      }
      arr.push(item);
      return arr;
    }, []);
    await audit(uid, { type: 'queued', feature: item.feature, action: item.action, detail: reason });
    try {
      await notify(uid, { kind: 'approval_needed', id: item.id, summary: item.summary });
    } catch (_) { /* notification failure must never break the flow */ }
    return item;
  }

  async function listApprovals(uid, status) {
    const list = await store.get(uid, 'approvals', []);
    const t = now();
    return list
      .map((x) => (x.status === 'pending' && x.expiresAt <= t ? { ...x, status: 'expired' } : x))
      .filter((x) => !status || x.status === status);
  }

  // Marks the item atomically so a double-tap can never execute twice.
  // NOTE: with Firestore the update fn can be re-run on contention, so its outputs MUST be reset at the top of every run.
  async function claim(uid, id, newStatus) {
    let claimed = null;
    let problem = null;
    await store.update(uid, 'approvals', (list) => {
      claimed = null;
      problem = null;
      const arr = list || [];
      const it = arr.find((x) => x.id === id);
      if (!it) { problem = 'not_found'; return arr; }
      if (it.status !== 'pending') { problem = 'already_' + it.status; return arr; }
      if (it.expiresAt <= now()) { it.status = 'expired'; problem = 'expired'; return arr; }
      it.status = newStatus;
      it.resolvedAt = now();
      claimed = { ...it };
      return arr;
    }, []);
    return { claimed, problem };
  }

  async function finish(uid, id, patch) {
    await store.update(uid, 'approvals', (list) => {
      const it = (list || []).find((x) => x.id === id);
      if (it) Object.assign(it, patch);
      return list || [];
    }, []);
  }

  const simNote = (r) => (r && r.simulated ? ' (SIMULATED: no real money/deploy happened)' : '');

  async function approve(uid, id) {
    const s = await autonomy.get(uid);
    if (s.frozen) return { ok: false, error: 'twin is frozen' };
    const { claimed, problem } = await claim(uid, id, 'approved');
    if (!claimed) return { ok: false, error: problem };
    const handler = handlers.get(claimed.action);
    if (!handler) {
      await finish(uid, id, { status: 'failed', result: 'no handler registered for this action' });
      await audit(uid, { type: 'failed', feature: claimed.feature, action: claimed.action, detail: 'no handler' });
      return { ok: false, error: 'no_handler' };
    }
    try {
      const result = await handler(uid, claimed); // claimed.id doubles as the idempotency key
      // The action already happened. Each bookkeeping step is best-effort and independent.
      if (claimed.feature === 'finance' && !(result && result.simulated)) await safely(() => autonomy.recordApprovedSpend(uid, claimed.amount));
      await safely(() => finish(uid, id, { result: safeResult(result) }));
      await safely(() => audit(uid, { type: 'executed', feature: claimed.feature, action: claimed.action, detail: 'approved by user' + simNote(result) }));
      return { ok: true, result };
    } catch (e) {
      // Ambiguous failure (e.g. timeout after the request left): money may have moved, so count it as spent.
      if (claimed.feature === 'finance' && e && e.ambiguous) await autonomy.recordApprovedSpend(uid, claimed.amount);
      const msg = String((e && e.message) || e).slice(0, 300);
      await finish(uid, id, { status: 'failed', result: msg });
      await audit(uid, { type: 'failed', feature: claimed.feature, action: claimed.action, detail: msg + (e && e.ambiguous ? ' (UNCERTAIN: check your bank before retrying)' : '') });
      return { ok: false, error: 'handler_failed', message: msg };
    }
  }

  async function reject(uid, id) {
    const { claimed, problem } = await claim(uid, id, 'rejected');
    if (!claimed) return { ok: false, error: problem };
    await audit(uid, { type: 'rejected', feature: claimed.feature, action: claimed.action });
    return { ok: true };
  }

  // ---------- main entry ----------
  async function run(uid, raw) {
    const intent = { ...(raw || {}) };
    // Nothing coming from a client, a stored target or an LLM may claim these. Only a server preflight can set them.
    delete intent.checksPassed;
    delete intent.meta;
    intent.id = crypto.randomUUID(); // idempotency key for handlers on the auto path

    // The feature (and so the limits that apply) comes from the registered action, not from the caller.
    const boundFeature = features.get(String(intent.action));
    if (boundFeature) intent.feature = boundFeature;
    if (!EXECUTABLE.has(intent.feature)) {
      await safely(() => audit(uid, { type: 'denied', feature: String(intent.feature), action: String(intent.action), detail: 'not an executable feature' }));
      return { status: 'denied', reason: 'not an executable feature' };
    }
    // Keep stored approvals small (a Firestore document is limited to 1 MB).
    if (intent.payload != null && JSON.stringify(intent.payload).length > 4000) {
      return { status: 'denied', reason: 'payload too large' };
    }
    intent.summary = String(intent.summary || '').slice(0, 200);

    const pf = preflights.get(String(intent.action));
    if (pf) {
      try {
        const r = (await pf(uid, intent)) || {};
        intent.checksPassed = r.checksPassed === true;
        if (r.meta && typeof r.meta === 'object') intent.meta = { checks: String(r.meta.checks || '').slice(0, 200) };
      } catch (e) {
        intent.checksPassed = false;
        intent.meta = { checks: 'preflight error: ' + String((e && e.message) || e).slice(0, 150) };
      }
    }

    const d = await autonomy.decide(uid, intent);
    const base = { feature: intent.feature, action: intent.action };

    if (d.mode === 'deny') {
      await audit(uid, { type: 'denied', ...base, detail: d.reason });
      return { status: 'denied', reason: d.reason };
    }
    if (d.mode === 'suggest') {
      await audit(uid, { type: 'suggested', ...base, detail: intent.summary });
      return { status: 'suggested', summary: intent.summary || intent.action };
    }
    if (d.mode === 'queue') {
      const item = await propose(uid, intent, d.reason);
      return { status: 'pending_approval', id: item.id, reason: d.reason };
    }

    const handler = handlers.get(String(intent.action));
    if (!handler) {
      await autonomy.refund(uid, intent);
      await audit(uid, { type: 'failed', ...base, detail: 'no handler' });
      return { status: 'failed', error: 'no handler registered' };
    }
    let result;
    try {
      result = await handler(uid, intent);
    } catch (e) {
      // Ambiguous failures keep the reserved budget: the action may really have happened.
      if (!(e && e.ambiguous)) await safely(() => autonomy.refund(uid, intent));
      const msg = String((e && e.message) || e).slice(0, 300);
      await safely(() => audit(uid, { type: 'failed', ...base, detail: msg + (e && e.ambiguous ? ' (UNCERTAIN: check before retrying)' : '') }));
      return { status: 'failed', error: msg, uncertain: !!(e && e.ambiguous) };
    }
    // The action succeeded. From here on nothing may refund the budget or report failure.
    if (result && result.simulated) await safely(() => autonomy.refund(uid, intent)); // dry-run never uses up your budget
    await safely(() => audit(uid, { type: 'executed', ...base, detail: 'auto (inside limits)' + simNote(result) }));
    return { status: 'executed', result, simulated: !!(result && result.simulated) };
  }

  return { registerHandler, registerPreflight, run, approve, reject, listApprovals, getAudit, audit };
}

function safeResult(r) {
  try {
    return JSON.parse(JSON.stringify(r ?? null));
  } catch (_) {
    return String(r).slice(0, 300);
  }
}

module.exports = { createCore };
