'use strict';
// Self-Correction & Reasoning Loop.
// attempt(ctx)  -> produces output.  ctx = { try, feedback: [issues from the last try] }
// verify(output) -> { ok: boolean, issues?: string[] }
// If it still fails after maxTries, it does NOT pretend success: it returns escalate:true
// so the caller can ask the human instead of acting on bad output.

async function runWithCorrection({ attempt, verify, maxTries = 3, backoffMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (typeof attempt !== 'function' || typeof verify !== 'function') throw new Error('attempt and verify are required');
  const tries = Math.min(Math.max(1, maxTries | 0), 8);
  const history = [];
  let feedback = [];
  let output = null;

  for (let i = 1; i <= tries; i++) {
    let issues;
    try {
      output = await attempt({ try: i, feedback });
      const v = await verify(output);
      if (v && v.ok) {
        history.push({ try: i, ok: true, issues: [] });
        return { ok: true, output, tries: i, history, escalate: false };
      }
      issues = (v && Array.isArray(v.issues) && v.issues.length ? v.issues : ['verification failed']).map(String);
    } catch (e) {
      issues = ['attempt crashed: ' + String((e && e.message) || e).slice(0, 200)];
    }
    history.push({ try: i, ok: false, issues });
    feedback = issues;
    if (i < tries && backoffMs > 0) await sleep(backoffMs * i);
  }
  return { ok: false, output, tries, history, escalate: true };
}

module.exports = { runWithCorrection };
