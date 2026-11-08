'use strict';
// Digital Continuity (dead-man switch).
// Timeline when you stop checking in:
//   idle >= inactivityDays - warnDaysBefore  -> warning to YOU (once a day)
//   idle >= inactivityDays                   -> FINAL warning to you, then a grace window starts
//   grace window over, still no check-in     -> pre-set actions go out to pre-set contacts ONLY
// Any check-in at any point resets everything. Nothing is ever sent to someone who is not in your contact list.
//
// Every state change below is an atomic "claim": only the caller that wins the claim sends anything,
// so overlapping ticks (timer + cron ping, or two instances) can never email a contact twice.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const RETRY_MS = HOUR; // after a failed delivery, wait this long before trying again
const LOCK_MS = 10 * 60 * 1000; // a delivery run that died mid-way is considered dead after this long

function clampInt(v, lo, hi, def) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

function createContinuity({ store, now = Date.now, deliver = async () => {}, notifyOwner = async () => {}, audit = async () => {} }) {
  const KEY = 'continuity';

  const fresh = () => ({
    enabled: false,
    inactivityDays: 30,
    warnDaysBefore: 5,
    graceHours: 48,
    contacts: [],
    actions: [],
    lastCheckIn: now(),
    state: 'ok',
    finalWarningAt: 0,
    lastWarnDay: -1,
    triggeredAt: 0,
    deliveringAt: 0,
    retryAfter: 0,
  });
  const merge = (c) => ({ ...fresh(), ...(c || {}) });
  const get = async (uid) => merge(await store.get(uid, KEY, {}));

  async function configure(uid, cfg) {
    const contacts = (Array.isArray(cfg.contacts) ? cfg.contacts : [])
      .slice(0, 10)
      .map((c) => ({
        name: String(c.name || '').trim().slice(0, 60),
        channel: ['sms', 'email', 'whatsapp'].includes(c.channel) ? c.channel : 'email',
        address: String(c.address || '').trim().slice(0, 120),
      }))
      .filter((c) => c.name && c.address);

    const names = new Set(contacts.map((c) => c.name));
    const actions = (Array.isArray(cfg.actions) ? cfg.actions : [])
      .slice(0, 20)
      .map((a) => ({
        type: a.type === 'release_asset' ? 'release_asset' : 'message',
        to: String(a.to || '').trim(),
        text: String(a.text || '').slice(0, 2000),
        assetId: String(a.assetId || '').slice(0, 120),
        done: false,
      }))
      .filter((a) => names.has(a.to) && (a.type === 'message' ? a.text : a.assetId));

    const inactivityDays = clampInt(cfg.inactivityDays, 7, 365, 30);
    return store.update(uid, KEY, (cur) => ({
      ...merge(cur),
      enabled: !!cfg.enabled && contacts.length > 0 && actions.length > 0,
      inactivityDays,
      warnDaysBefore: clampInt(cfg.warnDaysBefore, 1, inactivityDays - 1, 5),
      graceHours: clampInt(cfg.graceHours, 24, 24 * 14, 48),
      contacts,
      actions,
      lastCheckIn: now(),
      state: 'ok',
      finalWarningAt: 0,
      lastWarnDay: -1,
      triggeredAt: 0,
      deliveringAt: 0,
      retryAfter: 0,
    }), {});
  }

  async function checkIn(uid) {
    return store.update(uid, KEY, (cur) => {
      const m = merge(cur);
      return {
        ...m,
        lastCheckIn: now(),
        state: 'ok',
        finalWarningAt: 0,
        lastWarnDay: -1,
        deliveringAt: 0,
        retryAfter: 0,
        triggeredAt: 0,
        actions: m.actions.map((a) => ({ ...a, done: false })), // re-arm for the future
      };
    }, {});
  }

  async function disable(uid) {
    return store.update(uid, KEY, (cur) => ({ ...merge(cur), enabled: false, state: 'ok', deliveringAt: 0 }), {});
  }

  // Called by the scheduler. Returns what happened (useful for tests/logs).
  async function tick(uid) {
    const cfg = await get(uid);
    if (!cfg.enabled || cfg.state === 'triggered') return { event: 'none' };
    const t = now();
    const idle = t - cfg.lastCheckIn;
    const limit = cfg.inactivityDays * DAY;

    if (cfg.state === 'final_warning') {
      if (t - cfg.finalWarningAt < cfg.graceHours * HOUR) return { event: 'waiting_grace' };
      if (t < cfg.retryAfter) return { event: 'waiting_retry' };
      return trigger(uid);
    }

    if (idle >= limit) {
      let won = false;
      await store.update(uid, KEY, (c) => {
        won = false;
        const m = merge(c);
        if (m.state === 'ok' && m.enabled) { m.state = 'final_warning'; m.finalWarningAt = t; won = true; }
        return m;
      }, {});
      if (!won) return { event: 'none' };
      await notifyOwner(uid, `FINAL WARNING: no check-in for ${cfg.inactivityDays} days. Your continuity actions run in ${cfg.graceHours}h unless you check in.`);
      await audit(uid, { type: 'continuity_final_warning', feature: 'continuity', action: 'warn' });
      return { event: 'final_warning' };
    }

    if (idle >= limit - cfg.warnDaysBefore * DAY) {
      const today = Math.floor(t / DAY);
      let won = false;
      await store.update(uid, KEY, (c) => {
        won = false;
        const m = merge(c);
        if (m.state === 'ok' && m.lastWarnDay !== today) { m.lastWarnDay = today; won = true; }
        return m;
      }, {});
      if (won) {
        const left = Math.max(1, Math.ceil((limit - idle) / DAY));
        await notifyOwner(uid, `Check-in reminder: ${left} day(s) left before your continuity plan activates. Open Aureon to check in.`);
        return { event: 'warned' };
      }
    }
    return { event: 'none' };
  }

  async function trigger(uid) {
    const t = now();
    // Claim the delivery. Only the winner sends.
    let cfg = null;
    await store.update(uid, KEY, (c) => {
      cfg = null;
      const m = merge(c);
      if (m.state !== 'final_warning' || !m.enabled) return m;
      if (m.deliveringAt && t - m.deliveringAt < LOCK_MS) return m;
      if (t - m.finalWarningAt < m.graceHours * HOUR) return m;
      if (t < m.retryAfter) return m;
      m.deliveringAt = t;
      cfg = m;
      return m;
    }, {});
    if (!cfg) return { event: 'waiting' };

    const byName = new Map(cfg.contacts.map((c) => [c.name, c]));
    const results = [];
    const doneIdx = new Set();
    let aborted = false;

    for (let i = 0; i < cfg.actions.length; i++) {
      const a = cfg.actions[i];
      if (a.done) continue;
      // The owner may check in while we are mid-way: stop immediately.
      const live = await get(uid);
      if (live.state !== 'final_warning' || !live.enabled) { aborted = true; results.push({ aborted: true }); break; }
      const contact = byName.get(a.to);
      if (!contact) { results.push({ to: a.to, ok: false, error: 'contact not in list' }); continue; }
      try {
        await deliver(uid, a, contact);
        doneIdx.add(i);
        results.push({ to: a.to, type: a.type, ok: true });
        // Persist "sent" IMMEDIATELY, so a crash after this point can never cause this contact to be emailed again.
        await store.update(uid, KEY, (c) => {
          const m = merge(c);
          if (m.state === 'final_warning' && m.actions[i]) m.actions[i] = { ...m.actions[i], done: true };
          return m;
        }, {});
      } catch (e) {
        results.push({ to: a.to, type: a.type, ok: false, error: String((e && e.message) || e).slice(0, 200) });
      }
    }

    let complete = false;
    await store.update(uid, KEY, (c) => {
      const m = merge(c);
      m.deliveringAt = 0;
      complete = false;
      // Only record "done" while we are still in the final-warning state. If the owner checked in meanwhile,
      // the plan was re-armed and must stay re-armed, otherwise a contact would be silently skipped next time.
      if (m.state === 'final_warning') m.actions = m.actions.map((a, i) => (doneIdx.has(i) ? { ...a, done: true } : a));
      if (!aborted && m.state === 'final_warning') {
        if (m.actions.every((a) => a.done)) { m.state = 'triggered'; m.triggeredAt = now(); complete = true; }
        else m.retryAfter = now() + RETRY_MS;
      }
      return m;
    }, {});
    await audit(uid, { type: aborted ? 'continuity_aborted' : 'continuity_triggered', feature: 'continuity', action: 'deliver', detail: JSON.stringify(results).slice(0, 400) });
    return aborted ? { event: 'aborted', results } : { event: 'triggered', results, complete };
  }

  return { get, configure, checkIn, disable, tick };
}

module.exports = { createContinuity };
