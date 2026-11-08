'use strict';
// One call wires everything together:
//   const twin = createTwin({ store: firestoreStore(admin.firestore()), env: process.env, notify });
const path = require('path');
const { fileStore, memoryStore } = require('./store');
const { createShadow } = require('./shadow');
const { createAutonomy } = require('./autonomy');
const { createCore } = require('./core');
const { createContinuity } = require('./continuity');
const { createAgent } = require('./agent');
const { runWithCorrection } = require('./selfcorrect');
const { createMailer, makeDeliver } = require('./mailer');
const { createPayments } = require('./payments');
const { createDeploy } = require('./deploy');

function createTwin(opts = {}) {
  const now = opts.now || Date.now;
  const env = opts.env || {}; // pass process.env from server.js; tests pass nothing so nothing real is ever touched
  const store = opts.store || (opts.dataDir === ':memory:' ? memoryStore() : fileStore(opts.dataDir || path.join(process.cwd(), 'twin-data')));
  // notify(uid, payload): push to the owner (Firestore notifications / FCM).
  const notify = opts.notify || (async () => {});
  const ownerName = env.OWNER_NAME || 'Pavan';

  const mailer = opts.mailer || createMailer(env, opts.fetch || globalThis.fetch);
  const deliver = opts.deliver || makeDeliver({ mailer, store, ownerName });
  const payments = createPayments(env, opts.fetch || globalThis.fetch);
  const deploy = createDeploy(env, opts.fetch || globalThis.fetch);

  const shadow = createShadow({ store, now });
  const autonomy = createAutonomy({ store, now });
  const core = createCore({ store, autonomy, now, notify });
  const continuity = createContinuity({
    store,
    now,
    deliver,
    notifyOwner: async (uid, text) => notify(uid, { kind: 'continuity', text }),
    audit: core.audit,
  });
  const agent = createAgent({ store, core, now });

  // Registry of users who actually have something for the scheduler to do (a recurring target or an armed dead-man switch).
  // Without it every tick would read EVERY user's data from Firestore, which burns the free read quota as users grow.
  const REG_UID = '_registry', REG_KEY = 'active';
  const registry = {
    add: (uid) => store.update(REG_UID, REG_KEY, (m) => (m && m[uid] ? m : { ...(m || {}), [uid]: now() }), {}),
    remove: (uid) => store.update(REG_UID, REG_KEY, (m) => { const n = { ...(m || {}) }; delete n[uid]; return n; }, {}),
    list: async () => Object.keys(await store.get(REG_UID, REG_KEY, {})),
  };
  const addTarget0 = agent.addTarget;
  agent.addTarget = async (uid, t) => { const r = await addTarget0(uid, t); await registry.add(uid); return r; };
  const configure0 = continuity.configure;
  continuity.configure = async (uid, cfg) => { const r = await configure0(uid, cfg); if (r && r.enabled) await registry.add(uid); return r; };

  // Real actions. Each one is still gated by Autonomy Levels, limits, freeze and the approval queue.
  core.registerHandler('pay_bill', payments.handler, 'finance');
  if (deploy.targets.length) {
    core.registerHandler('deploy', deploy.handler, 'deploy');
    core.registerPreflight('deploy', deploy.preflight);
  }

  // Plain-language status that the app shows (so "simulated" is never mistaken for "real").
  const info = {
    payments: payments.live ? 'live' : 'simulated',
    payees: payments.payees,
    deployTargets: deploy.targets,
    deployChecks: deploy.githubReady ? 'github' : 'not_configured',
    email: mailer.provider,
    ownerEmailSet: !!env.OWNER_EMAIL,
  };

  let timer = null, ticking = false;
  // Walks only registered users. Each job is isolated, so one failing target never stops anybody's dead-man switch.
  async function tickAll() {
    if (ticking) return { skipped: true };   // an earlier tick is still running in this process
    ticking = true;
    try {
      const uids = await registry.list();
      for (const uid of uids) {
        for (const fn of [(u) => agent.tick(u), (u) => continuity.tick(u)]) {
          try { await fn(uid); } catch (e) { console.error('[twin] a background job failed for a user:', e.message); }
        }
        try {   // nothing left to do for this user -> stop reading their data every tick
          const [targets, c] = await Promise.all([agent.list(uid), continuity.get(uid)]);
          if (!targets.some((x) => x.enabled) && !c.enabled) await registry.remove(uid);
        } catch (_) { /* keep them registered; try again next tick */ }
      }
      return { skipped: false, users: uids.length };
    } finally {
      ticking = false;
    }
  }

  return {
    store, shadow, autonomy, core, continuity, agent, mailer, info,
    ownerEmail: env.OWNER_EMAIL || '',
    ownerName,
    selfCorrect: runWithCorrection,
    registry,
    // Background loop (targets + dead-man switch). Default every 5 min (a cron ping can call POST /twin/tick as well).
    start(intervalMs = 5 * 60 * 1000) {
      if (timer) return;
      timer = setInterval(() => tickAll().catch(() => {}), intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tickAll,
  };
}

module.exports = { createTwin, memoryStore, fileStore, runWithCorrection };
