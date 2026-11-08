'use strict';
// Deploy handler for intent.action === 'deploy' (Render deploy hooks) + a server-side "tests passed?" preflight
// that reads your GitHub check-runs. Zero dependencies.
//
//   TWIN_DEPLOY_HOOKS_JSON={"render-staging":"https://api.render.com/deploy/srv-xxxx?key=yyyy"}
//   GITHUB_TOKEN=<fine-grained token, repo "Checks: read" + "Metadata: read">   GITHUB_REPO=owner/Aureone-
//   GITHUB_DEFAULT_BRANCH=main     (should be the branch Render deploys)
//
// Level 3 (auto) deploy only fires if the target is allowlisted AND this preflight proves the latest commit's checks passed.
// If GitHub is not configured, checks can never be proven, so a deploy always waits for your approval.
// The deploy-hook URLs contain a secret key: they are never logged and never put in error messages.

const TIMEOUT_MS = 20000;
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function parseHooks(raw) {
  if (!raw) return {};
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { throw new Error('TWIN_DEPLOY_HOOKS_JSON is not valid JSON'); }
  const out = {};
  for (const [name, url] of Object.entries(obj || {})) {
    let u;
    try { u = new URL(String(url)); } catch (_) { throw new Error(`deploy hook "${name}" is not a valid URL`); }
    if (u.protocol !== 'https:' || u.hostname !== 'api.render.com') throw new Error(`deploy hook "${name}" must be an https://api.render.com/ URL`);
    out[name] = u.toString();
  }
  return out;
}

// Pure function (unit-tested): decides from GitHub's check-runs response.
function evaluateChecks(json, ref) {
  const runs = (json && Array.isArray(json.check_runs)) ? json.check_runs : [];
  if (!runs.length) return { checksPassed: false, meta: { checks: `no checks found on ${ref} (cannot prove tests passed)` } };
  const pending = runs.filter((r) => r.status !== 'completed');
  if (pending.length) return { checksPassed: false, meta: { checks: `${pending.length} check(s) still running on ${ref}` } };
  const bad = runs.filter((r) => !OK_CONCLUSIONS.has(r.conclusion));
  const sha = String(runs[0].head_sha || '').slice(0, 7);
  if (bad.length) return { checksPassed: false, meta: { checks: `${bad.length} of ${runs.length} check(s) failed on ${ref}@${sha}` } };
  return { checksPassed: true, meta: { checks: `all ${runs.length} check(s) passed on ${ref}@${sha}` } };
}

function createDeploy(env = {}, fetchImpl = globalThis.fetch) {
  const hooks = parseHooks(env.TWIN_DEPLOY_HOOKS_JSON);
  const repo = String(env.GITHUB_REPO || '');
  const token = String(env.GITHUB_TOKEN || '');
  const defaultRef = String(env.GITHUB_DEFAULT_BRANCH || 'main');
  const githubReady = /^[\w.-]+\/[\w.-]+$/.test(repo) && !!token;

  async function preflight(uid, intent) {
    if (!hooks[String(intent.target || '')]) return { checksPassed: false, meta: { checks: 'unknown deploy target' } };
    if (!githubReady) return { checksPassed: false, meta: { checks: 'GitHub checks not configured, so tests cannot be proven' } };
    // Always the branch Render actually deploys. A caller-supplied ref would let a green branch vouch for a failing one.
    const ref = defaultRef;
    if (!/^[\w./-]{1,100}$/.test(ref) || ref.includes('..')) return { checksPassed: false, meta: { checks: 'invalid ref' } };
    let res;
    try {
      res = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'aureon-twin',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (_) {
      return { checksPassed: false, meta: { checks: 'could not reach GitHub' } };
    }
    if (!res.ok) return { checksPassed: false, meta: { checks: `GitHub returned HTTP ${res.status}` } };
    return evaluateChecks(await res.json(), ref);
  }

  async function handler(uid, intent) {
    const url = hooks[String(intent.target || '')];
    if (!url) throw new Error(`unknown deploy target "${intent.target}"`);
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (_) {
      throw new Error('could not reach Render (deploy not triggered)');
    }
    if (!res.ok) throw new Error(`Render refused the deploy hook (HTTP ${res.status})`);
    return { simulated: false, triggered: true, target: intent.target };
  }

  return { handler, preflight, targets: Object.keys(hooks), githubReady };
}

module.exports = { createDeploy, parseHooks, evaluateChecks };
