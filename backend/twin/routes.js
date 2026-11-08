'use strict';
// HTTP layer. `handlers(twin)` are pure functions (easy to test); `mount(router, twin, requireAuth)` adapts them to Express.
// IMPORTANT: uid ALWAYS comes from req.uid (set by your requireAuth after verifying the Firebase ID token), never from the body.

function handlers(twin) {
  const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
  const bad = (msg, status = 400) => ({ status, body: { ok: false, error: msg } });
  const guard = (fn) => async (req) => {
    try {
      return await fn(req);
    } catch (e) {
      return bad(String((e && e.message) || e).slice(0, 200));
    }
  };

  return {
    'GET /twin/overview': guard(async ({ uid }) =>
      ok({
        profile: await twin.shadow.getProfile(uid),
        autonomy: await twin.autonomy.get(uid),
        pending: await twin.core.listApprovals(uid, 'pending'),
        targets: await twin.agent.list(uid),
        continuity: redact(await twin.continuity.get(uid)),
        info: twin.info,
        serverTime: Date.now(),
      })),

    'POST /twin/shadow/event': guard(async ({ uid, body }) => {
      // Learning can be paused from the app (shadow level 1 = off).
      const s = await twin.autonomy.get(uid);
      if (s.levels.shadow === 1) return ok({ skipped: 'learning is paused' });
      await twin.shadow.record(uid, body);
      return ok();
    }),
    'DELETE /twin/shadow': guard(async ({ uid }) => {
      await twin.shadow.forget(uid);
      return ok();
    }),

    'POST /twin/autonomy/level': guard(async ({ uid, body }) =>
      ok({ autonomy: await twin.autonomy.setLevel(uid, body.feature, Number(body.level)) })),
    'POST /twin/autonomy/limits': guard(async ({ uid, body }) =>
      ok({ autonomy: await twin.autonomy.setLimits(uid, body.feature, body.limits || {}) })),
    'POST /twin/freeze': guard(async ({ uid, body }) =>
      ok({ autonomy: await twin.autonomy.setFrozen(uid, body.frozen !== false) })),

    'GET /twin/approvals': guard(async ({ uid, query }) =>
      ok({ items: await twin.core.listApprovals(uid, query && query.status) })),
    'POST /twin/approvals/approve': guard(async ({ uid, body }) => {
      const r = await twin.core.approve(uid, String(body.id || ''));
      return r.ok ? ok({ result: r.result ?? null }) : bad(r.message || r.error, 409);
    }),
    'POST /twin/approvals/reject': guard(async ({ uid, body }) => {
      const r = await twin.core.reject(uid, String(body.id || ''));
      return r.ok ? ok() : bad(r.error, 409);
    }),

    'POST /twin/run': guard(async ({ uid, body }) => {
      // Lets the app (or the LLM tool-call layer) propose an action. It still goes through all guardrails.
      // core.run() strips checksPassed/meta itself, so a client can never claim "tests passed".
      return ok({ outcome: await twin.core.run(uid, body) });
    }),

    'GET /twin/audit': guard(async ({ uid }) => ok({ items: await twin.core.getAudit(uid, 50) })),

    'GET /twin/targets': guard(async ({ uid }) => ok({ items: await twin.agent.list(uid) })),
    'POST /twin/targets': guard(async ({ uid, body }) => ok({ target: await twin.agent.addTarget(uid, body) })),
    'DELETE /twin/targets': guard(async ({ uid, body }) => {
      await twin.agent.removeTarget(uid, String(body.id || ''));
      return ok();
    }),

    'GET /twin/continuity': guard(async ({ uid }) => ok({ continuity: redact(await twin.continuity.get(uid)) })),
    'POST /twin/continuity': guard(async ({ uid, body }) => ok({ continuity: redact(await twin.continuity.configure(uid, body)) })),
    'POST /twin/continuity/checkin': guard(async ({ uid }) => ok({ continuity: redact(await twin.continuity.checkIn(uid)) })),
    'POST /twin/continuity/disable': guard(async ({ uid }) => ok({ continuity: redact(await twin.continuity.disable(uid)) })),

    // Sends one test email to OWNER_EMAIL (from env), never to anyone else, so setup can be verified safely.
    'POST /twin/test-email': guard(async () => {
      if (!twin.mailer.configured) return bad('email is not configured on the server');
      if (!twin.ownerEmail) return bad('OWNER_EMAIL is not set on the server');
      await twin.mailer.send({
        to: twin.ownerEmail,
        subject: 'Aureon test email',
        text: 'This is a test from Aureon Digital Continuity. If you can read this, the dead-man switch email works.',
      });
      return ok();
    }),

    // Notes that can be released to a contact by the dead-man switch (e.g. "where to find my password manager").
    // Do NOT store raw passwords here; store instructions.
    'GET /twin/assets': guard(async ({ uid }) => {
      const a = await twin.store.get(uid, 'assets', {});
      return ok({ items: Object.entries(a).map(([id, v]) => ({ id, label: v.label })) });
    }),
    'POST /twin/assets': guard(async ({ uid, body }) => {
      const id = String(body.id || '').replace(/[^\w-]/g, '').slice(0, 60);
      if (!id) throw new Error('id required');
      const label = String(body.label || '').slice(0, 100);
      const text = String(body.text || '').slice(0, 5000);
      if (!label || !text) throw new Error('label and text required');
      await twin.store.update(uid, 'assets', (cur) => {
        const m = cur || {};
        if (!m[id] && Object.keys(m).length >= 20) throw new Error('too many assets');
        m[id] = { label, text };
        return m;
      }, {});
      return ok();
    }),
    'DELETE /twin/assets': guard(async ({ uid, body }) => {
      const id = String(body.id || '');
      await twin.store.update(uid, 'assets', (cur) => { const m = cur || {}; delete m[id]; return m; }, {});
      return ok();
    }),
  };
}

// Never send contact addresses or message bodies back in bulk responses.
function redact(c) {
  return {
    enabled: c.enabled,
    state: c.state,
    inactivityDays: c.inactivityDays,
    warnDaysBefore: c.warnDaysBefore,
    graceHours: c.graceHours,
    lastCheckIn: c.lastCheckIn,
    contacts: c.contacts.map((x) => ({ name: x.name, channel: x.channel })),
    actionCount: c.actions.length,
  };
}

function mount(router, twin, requireAuth) {
  if (typeof requireAuth !== 'function') throw new Error('requireAuth middleware is required');
  const map = handlers(twin);
  for (const [key, fn] of Object.entries(map)) {
    const [method, path] = key.split(' ');
    router[method.toLowerCase()](path, requireAuth, async (req, res) => {
      if (!req.uid) return res.status(401).json({ ok: false, error: 'unauthenticated' });
      const out = await fn({ uid: req.uid, body: req.body || {}, query: req.query || {} });
      res.status(out.status).json(out.body);
    });
  }
  // Called by a free pinger (GitHub Actions / cron-job.org) so the scheduler runs even if Render slept.
  // Protected by a shared secret from env, NOT by Firebase auth.
  router.post('/twin/tick', async (req, res) => {
    try {
      const crypto = require('crypto');
      const secret = process.env.TWIN_TICK_SECRET;
      // Hash both sides first: equal length digests, so non-ASCII or odd-length headers can never throw.
      const sha = (s) => crypto.createHash('sha256').update(String(s || '')).digest();
      if (!secret || !crypto.timingSafeEqual(sha(req.get('x-tick-secret')), sha(secret))) {
        return res.status(401).json({ ok: false });
      }
      const r = await twin.tickAll();
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'tick failed' });
    }
  });
  return router;
}

module.exports = { handlers, mount };
