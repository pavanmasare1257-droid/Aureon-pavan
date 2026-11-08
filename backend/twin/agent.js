'use strict';
// Autonomous Execution Agent: runs your recurring targets in the background.
// Every run still goes through core.run(), so Autonomy Levels, limits, freeze and the approval queue all apply.

const MIN_EVERY_MS = 60 * 1000;
const MAX_EVERY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_TARGETS = 25;

function createAgent({ store, core, now = Date.now }) {
  const KEY = 'targets';
  let timer = null;
  let ticking = false;

  async function list(uid) {
    return store.get(uid, KEY, []);
  }

  async function addTarget(uid, t) {
    const target = {
      id: String(t.id || 't' + now().toString(36) + Math.random().toString(36).slice(2, 6)).replace(/[^\w-]/g, '').slice(0, 40),
      name: String(t.name || (t.intent && t.intent.action) || 'target').slice(0, 80),
      everyMs: Number.isFinite(Number(t.everyMs)) && Number(t.everyMs) > 0
        ? Math.min(MAX_EVERY_MS, Math.max(MIN_EVERY_MS, Math.floor(Number(t.everyMs))))
        : 24 * 60 * 60 * 1000,
      intent: sanitizeIntent(t.intent),
      enabled: t.enabled !== false,
      nextRunAt: Number(t.firstRunAt) || now(),
      lastStatus: null,
    };
    await store.update(uid, KEY, (cur) => {
      const arr = (cur || []).filter((x) => x.id !== target.id);
      if (arr.length >= MAX_TARGETS) throw new Error('too many targets');
      arr.push(target);
      return arr;
    }, []);
    return target;
  }

  async function removeTarget(uid, id) {
    await store.update(uid, KEY, (cur) => (cur || []).filter((x) => x.id !== id), []);
  }

  async function setEnabled(uid, id, enabled) {
    await store.update(uid, KEY, (cur) => {
      const it = (cur || []).find((x) => x.id === id);
      if (it) it.enabled = !!enabled;
      return cur || [];
    }, []);
  }

  // Runs every due target for one user.
  // Due targets are CLAIMED and rescheduled in one atomic update, so two overlapping ticks (timer + cron ping,
  // or two server instances) can never run the same target twice.
  async function tick(uid) {
    const t = now();
    let claimed = [];
    await store.update(uid, KEY, (cur) => {
      claimed = [];
      const arr = cur || [];
      for (const it of arr) {
        if (it.enabled && it.nextRunAt <= t) {
          claimed.push({ id: it.id, intent: it.intent });
          it.nextRunAt = t + it.everyMs; // schedule first: a crash can never cause a rapid retry loop
        }
      }
      return arr;
    }, []);

    const out = [];
    for (const x of claimed) {
      const res = await core.run(uid, x.intent);
      await store.update(uid, KEY, (cur) => {
        const it = (cur || []).find((y) => y.id === x.id);
        if (it) it.lastStatus = res.status;
        return cur || [];
      }, []);
      out.push({ id: x.id, status: res.status });
    }
    return out;
  }

  async function tickAll(extra = []) {
    if (ticking) return { skipped: true }; // an earlier tick is still running in this process
    ticking = true;
    try {
      const uids = await store.listUids();
      for (const uid of uids) {
        // Each job is isolated: a failing target must never stop the dead-man switch from running for that user.
        for (const fn of [tick, ...extra]) {
          try {
            await fn(uid);
          } catch (e) {
            console.error('[twin] a background job failed for a user:', e.message);
          }
        }
      }
      return { skipped: false };
    } finally {
      ticking = false;
    }
  }

  // Render free tier sleeps when idle, so this only runs while the server is awake.
  // For reliable timing use the GitHub Actions / cron-job.org ping on POST /twin/tick.
  function start(intervalMs = 60 * 1000, extra = []) {
    if (timer) return;
    timer = setInterval(() => tickAll(extra).catch(() => {}), intervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { list, addTarget, removeTarget, setEnabled, tick, tickAll, start, stop };
}

function sanitizeIntent(i) {
  if (!i || typeof i !== 'object') throw new Error('intent required');
  const out = {
    feature: String(i.feature || 'execution'),
    action: String(i.action || '').slice(0, 80),
    summary: String(i.summary || '').slice(0, 200),
    payload: i.payload ?? null,
  };
  if (!out.action) throw new Error('intent.action required');
  if (out.payload != null && JSON.stringify(out.payload).length > 4000) throw new Error('payload too large');
  if (i.amount != null) out.amount = Number(i.amount);
  if (i.payee != null) out.payee = String(i.payee).slice(0, 80);
  if (i.target != null) out.target = String(i.target).slice(0, 80);
  // checksPassed is deliberately NOT accepted: only a server-side preflight can prove it at run time.
  return out;
}

module.exports = { createAgent };
