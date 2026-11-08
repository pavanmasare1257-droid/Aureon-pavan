'use strict';
// Autonomy Levels + guardrails.
//   Level 1 = suggest only      (Aureon tells you, does nothing)
//   Level 2 = draft + approve   (Aureon prepares, you approve with one tap)
//   Level 3 = full auto         (only inside the limits YOU set; outside limits it falls back to approval)
// Money and deploy start at Level 2 and cannot be moved to Level 3 until limits exist.

const FEATURES = ['shadow', 'selfcorrect', 'continuity', 'execution', 'finance', 'deploy'];
const SENSITIVE = new Set(['finance', 'deploy', 'execution']);
const IST_OFFSET_MS = 330 * 60 * 1000;

function defaults() {
  return {
    levels: { shadow: 3, selfcorrect: 3, continuity: 2, execution: 2, finance: 2, deploy: 2 },
    limits: {
      finance: { perTxnCap: 0, dailyCap: 0, allowedPayees: [] },
      deploy: { allowedTargets: [], requireChecksPass: true },
      execution: { allowedActions: [], maxPerDay: 20 },
    },
    frozen: false,
    counters: { day: '', spent: 0, execs: 0 },
  };
}

function dayKey(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function strList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
}
function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Can this feature safely run at level 3 with the current limits?
function level3Allowed(feature, limits) {
  if (feature === 'finance') {
    const l = limits.finance;
    return l.perTxnCap > 0 && l.dailyCap >= l.perTxnCap && l.allowedPayees.length > 0;
  }
  if (feature === 'deploy') return limits.deploy.allowedTargets.length > 0;
  if (feature === 'execution') return limits.execution.allowedActions.length > 0 && limits.execution.maxPerDay > 0;
  return true;
}

function normalise(s) {
  const d = defaults();
  const out = { ...d, ...(s || {}) };
  out.levels = { ...d.levels, ...((s && s.levels) || {}) };
  out.limits = {
    finance: { ...d.limits.finance, ...((s && s.limits && s.limits.finance) || {}) },
    deploy: { ...d.limits.deploy, ...((s && s.limits && s.limits.deploy) || {}) },
    execution: { ...d.limits.execution, ...((s && s.limits && s.limits.execution) || {}) },
  };
  out.counters = { ...d.counters, ...((s && s.counters) || {}) };
  return out;
}

function createAutonomy({ store, now = Date.now }) {
  const KEY = 'autonomy';

  const get = async (uid) => normalise(await store.get(uid, KEY, null));

  function rollDay(s) {
    const today = dayKey(now());
    if (s.counters.day !== today) s.counters = { day: today, spent: 0, execs: 0 };
  }

  async function setLevel(uid, feature, level) {
    if (!FEATURES.includes(feature)) throw new Error('unknown feature');
    if (![1, 2, 3].includes(level)) throw new Error('level must be 1, 2 or 3');
    return store.update(uid, KEY, (cur) => {
      const s = normalise(cur);
      if (level === 3 && !level3Allowed(feature, s.limits)) {
        throw new Error(`set limits for "${feature}" first (caps / allowlist) before enabling Level 3`);
      }
      s.levels[feature] = level;
      return s;
    }, null);
  }

  async function setLimits(uid, feature, patch) {
    if (!SENSITIVE.has(feature)) throw new Error('no limits for this feature');
    return store.update(uid, KEY, (cur) => {
      const s = normalise(cur);
      const l = s.limits[feature];
      if (feature === 'finance') {
        if ('perTxnCap' in patch) l.perTxnCap = posNum(patch.perTxnCap);
        if ('dailyCap' in patch) l.dailyCap = posNum(patch.dailyCap);
        if ('allowedPayees' in patch) l.allowedPayees = strList(patch.allowedPayees);
      } else if (feature === 'deploy') {
        if ('allowedTargets' in patch) l.allowedTargets = strList(patch.allowedTargets);
        if ('requireChecksPass' in patch) l.requireChecksPass = patch.requireChecksPass !== false;
      } else {
        if ('allowedActions' in patch) l.allowedActions = strList(patch.allowedActions);
        if ('maxPerDay' in patch) l.maxPerDay = Math.floor(posNum(patch.maxPerDay));
      }
      // If limits were loosened away, drop back to approval mode automatically.
      if (s.levels[feature] === 3 && !level3Allowed(feature, s.limits)) s.levels[feature] = 2;
      return s;
    }, null);
  }

  async function setFrozen(uid, frozen) {
    return store.update(uid, KEY, (cur) => ({ ...normalise(cur), frozen: !!frozen }), null);
  }

  // Decides what to do with an intent. Reserves spend / exec counters atomically when it says "execute".
  async function decide(uid, intent) {
    const { feature } = intent || {};
    if (!FEATURES.includes(feature)) return { mode: 'deny', reason: 'unknown feature' };
    let decision = { mode: 'deny', reason: 'unreachable' };

    await store.update(uid, KEY, (cur) => {
      const s = normalise(cur);
      rollDay(s);
      decision = evaluate(s, intent);
      if (decision.mode === 'execute') {
        if (feature === 'finance') s.counters.spent += Number(intent.amount);
        if (feature === 'execution') s.counters.execs += 1;
      }
      return s;
    }, null);
    return decision;
  }

  function evaluate(s, intent) {
    const { feature } = intent;
    if (s.frozen) return { mode: 'deny', reason: 'twin is frozen (kill switch on)' };

    if (feature === 'finance') {
      const amt = Number(intent.amount);
      if (!Number.isFinite(amt) || amt <= 0) return { mode: 'deny', reason: 'invalid amount' };
    }

    const level = s.levels[feature];
    if (level === 1) return { mode: 'suggest', reason: 'level 1: suggest only' };
    if (level === 2) return { mode: 'queue', reason: 'level 2: needs your approval' };

    // Level 3: auto, but only inside limits. Anything outside goes to the approval queue.
    if (!level3Allowed(feature, s.limits)) return { mode: 'queue', reason: 'limits not configured' };

    if (feature === 'finance') {
      const l = s.limits.finance;
      const amt = Number(intent.amount);
      if (!l.allowedPayees.includes(String(intent.payee || ''))) return { mode: 'queue', reason: 'payee not in allowlist' };
      if (amt > l.perTxnCap) return { mode: 'queue', reason: 'above per-transaction cap' };
      if (s.counters.spent + amt > l.dailyCap) return { mode: 'queue', reason: 'would exceed daily cap' };
    }
    if (feature === 'deploy') {
      const l = s.limits.deploy;
      if (!l.allowedTargets.includes(String(intent.target || ''))) return { mode: 'queue', reason: 'target not in allowlist' };
      if (l.requireChecksPass && intent.checksPassed !== true) return { mode: 'queue', reason: 'checks have not passed' };
    }
    if (feature === 'execution') {
      const l = s.limits.execution;
      if (!l.allowedActions.includes(String(intent.action || ''))) return { mode: 'queue', reason: 'action not allowed for auto' };
      if (s.counters.execs >= l.maxPerDay) return { mode: 'queue', reason: 'daily action limit reached' };
    }
    return { mode: 'execute', reason: 'inside your limits' };
  }

  // Give back reserved budget when an auto-executed action fails.
  async function refund(uid, intent) {
    await store.update(uid, KEY, (cur) => {
      const s = normalise(cur);
      rollDay(s);
      if (intent.feature === 'finance') s.counters.spent = Math.max(0, s.counters.spent - Number(intent.amount));
      if (intent.feature === 'execution') s.counters.execs = Math.max(0, s.counters.execs - 1);
      return s;
    }, null);
  }

  // Human-approved spend still counts toward today's total (for visibility), without being capped.
  async function recordApprovedSpend(uid, amount) {
    await store.update(uid, KEY, (cur) => {
      const s = normalise(cur);
      rollDay(s);
      s.counters.spent += Number(amount) || 0;
      return s;
    }, null);
  }

  return { get, setLevel, setLimits, setFrozen, decide, refund, recordApprovedSpend, FEATURES };
}

module.exports = { createAutonomy, FEATURES };
