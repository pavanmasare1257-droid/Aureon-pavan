// backend/llm-text.js — ONE plain-text LLM entry point for Ava Studio / APK Studio / attachments, with automatic key + model shifting.
//
//   text(prompt, {system, maxTokens})            -> string
//   vision(prompt, [{mime, b64}], {maxTokens})   -> string   (photos / screenshots)
//   research(prompt, {maxTokens})                -> {text, sources[]}   (Gemini with live Google Search grounding; falls back to plain text)
//   nextReadyMs()                                -> ms until some key/model is usable again (0 = now)
//
// Shifting: every (provider, key, model) is a "slot". A call walks the healthy slots in this order: Gemini models (best first) x Gemini keys,
// then Groq models x Groq keys. A slot that fails is put on cooldown for the right amount of time (429 -> its own retry-after / 45s, daily quota
// -> 30 min, invalid key -> 6 h, unknown model -> 12 h, 5xx/timeout -> 20 s) and the very next slot is tried IMMEDIATELY, so a quota error on one
// key or model never stops the work. The slot that worked last is tried first next time.
// Env: GEMINI_API_KEY, GEMINI_API_KEYS (comma list), GEMINI_API_KEY_1..9 | GROQ_API_KEY, GROQ_API_KEYS, GROQ_API_KEY_1..9
//      AVA_GEMINI_MODELS (default gemini-2.5-flash,gemini-2.5-flash-lite,gemini-flash-latest,gemini-2.0-flash)
//      AVA_GROQ_MODELS   (default llama-3.3-70b-versatile,openai/gpt-oss-120b,llama-3.1-8b-instant)  | AVA_GROQ_VISION_MODEL
const DEFAULT_SYSTEM = 'You are Ava, a principal engineer and world-class designer. Follow the requested output format exactly; output only what the format asks — no chat, no explanation, no markdown fences around the whole answer.';
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
function collect(base) {
  const out = []; const add = (v) => csv(v).forEach((k) => { if (!out.includes(k)) out.push(k); });
  add(process.env[base]); add(process.env[base + 'S']);
  Object.keys(process.env).map((n) => { const m = n.match(new RegExp('^' + base + '_(\\d+)$')); return m ? [parseInt(m[1], 10), n] : null; })
    .filter(Boolean).sort((a, b) => a[0] - b[0]).forEach(([, n]) => add(process.env[n]));
  return out;
}
const geminiKeys = () => collect('GEMINI_API_KEY');
const groqKeys = () => collect('GROQ_API_KEY');
// ---- model lists. Google retires models for new keys ("gemini-2.5-flash is no longer available to new users") and Groq accounts
// differ, so fixed names go stale. Order: env override > names learned from error hints > models the keys can REALLY use (asked
// from the API, refreshed every 6 h) > built-in names.
const learned = { g: [] };
const found = { g: { at: 0, list: [] }, q: { at: 0, list: [] } };
const GEMINI_DEFAULTS = 'gemini-flash-latest,gemini-flash-lite-latest,gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash';
const GROQ_DEFAULTS = 'openai/gpt-oss-120b,llama-3.3-70b-versatile,qwen/qwen3-32b,openai/gpt-oss-20b,llama-3.1-8b-instant';
const uniq = (a) => [...new Set(a.filter(Boolean))];
const geminiModels = () => (process.env.AVA_GEMINI_MODELS ? csv(process.env.AVA_GEMINI_MODELS) : uniq([...learned.g, ...found.g.list, ...csv(GEMINI_DEFAULTS)]));
const groqModels = () => (process.env.AVA_GROQ_MODELS || process.env.AVA_GROQ_MODEL ? csv(process.env.AVA_GROQ_MODELS || process.env.AVA_GROQ_MODEL) : uniq([...found.q.list, ...csv(GROQ_DEFAULTS)]));
async function listGeminiModels() {
  for (const key of geminiKeys()) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue; const d = await r.json();
      const names = (d.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
      if (names.length) return names;
    } catch (e) { /* try next key */ }
  }
  return [];
}
function rankGemini(names) {
  const ok = names.filter((n) => /flash/.test(n) && !/image|tts|live|audio|embed|thinking|vision|robotics|computer|learnlm|gemma|-exp|deep|research|native|customtools/i.test(n));
  const ver = (n) => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const stable = ok.filter((n) => !/preview|exp/i.test(n)); const pool = stable.length >= 2 ? stable : ok;
  return pool.sort((a, b) => (ver(b) - ver(a)) || ((/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0)) || a.length - b.length).slice(0, 6);
}
async function listGroqModels() {
  for (const key of groqKeys()) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue; const d = await r.json();
      const ids = (d.data || []).map((m) => m.id).filter(Boolean);
      if (ids.length) return ids;
    } catch (e) { /* try next key */ }
  }
  return [];
}
function rankGroq(ids) {
  const ok = ids.filter((i) => !/whisper|tts|guard|distil|embed|orpheus|playai|safeguard|compound/i.test(i));
  const pref = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];
  return uniq([...pref.filter((p) => ok.includes(p)), ...ok]).slice(0, 6);
}
let modelsLoading = null;
function ensureModels(force) {
  const fresh = (x) => Date.now() - x.at < 6 * 3600000;
  if (!force && fresh(found.g) && fresh(found.q)) return Promise.resolve();
  if (!modelsLoading) {
    modelsLoading = (async () => {
      const retry = Date.now() - (6 * 3600000 - 10 * 60000);   // if a lookup fails, try again in 10 minutes
      try {
        if (geminiKeys().length && !process.env.AVA_GEMINI_MODELS) { const n = await listGeminiModels(); found.g = n.length ? { at: Date.now(), list: rankGemini(n) } : { at: retry, list: found.g.list }; } else found.g.at = Date.now();
        if (groqKeys().length && !(process.env.AVA_GROQ_MODELS || process.env.AVA_GROQ_MODEL)) { const n = await listGroqModels(); found.q = n.length ? { at: Date.now(), list: rankGroq(n) } : { at: retry, list: found.q.list }; } else found.q.at = Date.now();
      } catch (e) { /* defaults stay */ } finally { modelsLoading = null; }
    })();
  }
  return Promise.race([modelsLoading, new Promise((r) => setTimeout(r, 12000))]);
}
const SIMPLE_NAME = (s) => String(s || '').replace(/\W/g, '');

// ---- slot health
const cool = new Map();          // slotId -> until (ms epoch)
const keyBan = new Map();        // key -> until
const modelBan = new Map();      // prov:model -> until
let rr = 0; const sticky = {};   // sticky[prov] = last slot id that worked
const now = () => Date.now();
const kid = (k) => 'k' + (String(k).slice(-6));
function usable(s) { const t = now(); return !((cool.get(s.id) || 0) > t || (keyBan.get(s.key) || 0) > t || (modelBan.get(s.prov + ':' + s.model) || 0) > t); }
function slotsFor(prov, models, keys) {
  const out = []; const off = keys.length ? rr++ % keys.length : 0;
  for (const m of models) for (let i = 0; i < keys.length; i++) { const key = keys[(i + off) % keys.length]; out.push({ prov, key, model: m, id: prov + ':' + m + ':' + kid(key) }); }
  const st = sticky[prov]; const i = out.findIndex((s) => s.id === st); if (i > 0) out.unshift(out.splice(i, 1)[0]);
  return out;
}
function penalize(s, status, msg) {
  const t = now(); msg = String(msg || '');
  if (status === 401 || status === 403 || /api key not valid|invalid api key|permission_denied|API_KEY_INVALID/i.test(msg)) keyBan.set(s.key, t + 6 * 3600000);
  else if (status === 404 || /model .*(not found|does not exist|decommissioned)|not supported/i.test(msg)) {
    modelBan.set(s.prov + ':' + s.model, t + 12 * 3600000);
    const hint = s.prov === 'g' && msg.match(/use models\/(gemini-[\w.\-]+)/i);
    if (hint && !learned.g.includes(hint[1])) { learned.g.unshift(hint[1]); found.g.at = 0; }   // refresh the list from the API too
  }
  else if (status === 429 || /quota|rate limit|resource_exhausted|too many/i.test(msg)) {
    let ms = 45000; const m = msg.match(/retry in ([\d.]+)\s*s|try again in ([\d.]+)\s*(s|m)/i);
    if (m) ms = Math.min(600000, Math.max(5000, Math.ceil(parseFloat(m[1] || m[2]) * (m[3] === 'm' ? 60000 : 1000)) + 500));
    if (/per day|daily|PerDay/i.test(msg)) ms = 30 * 60000;
    cool.set(s.id, t + ms);
  } else if (status >= 500 || status === 0) cool.set(s.id, t + 20000);
  else if (status === 400 && /context|too long|maximum|tokens/i.test(msg)) cool.set(s.id, t + 5000);   // this prompt is too big for this model — others may take it
}
function nextReadyMs() {
  const t = now(); const all = [...slotsFor('g', geminiModels(), geminiKeys()), ...slotsFor('q', groqModels(), groqKeys())];
  if (!all.length) return 0; let best = Infinity;
  for (const s of all) { if (usable(s)) return 0; best = Math.min(best, Math.max((cool.get(s.id) || 0), (keyBan.get(s.key) || 0), (modelBan.get(s.prov + ':' + s.model) || 0)) - t); }
  return Number.isFinite(best) ? Math.max(0, best) : 0;
}
function status() { const t = now(); return { geminiKeys: geminiKeys().length, groqKeys: groqKeys().length, cooling: [...cool.entries()].filter(([, u]) => u > t).length, banned: [...keyBan.values()].filter((u) => u > t).length, nextReadyMs: nextReadyMs() }; }

// ---- providers
async function callGemini(s, parts, o) {
  const body = { contents: [{ role: 'user', parts }], systemInstruction: { parts: [{ text: (o && o.system) || DEFAULT_SYSTEM }] }, generationConfig: { temperature: 0.35, maxOutputTokens: Math.min(Number((o && o.maxTokens) || 32000), 65000) } };
  if (/2\.5-flash/.test(s.model) && process.env.AVA_GEMINI_THINK !== '1') body.generationConfig.thinkingConfig = { thinkingBudget: 0 };   // fast: no hidden "thinking" tokens
  if (o && o.grounded) body.tools = [{ google_search: {} }];
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + s.model + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.key }, body: JSON.stringify(body), signal: AbortSignal.timeout((o && o.timeout) || 170000) });
  const d = await r.json().catch(() => ({}));
  const c = d && d.candidates && d.candidates[0];
  const text = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || '').join('') : '';
  const sources = [];
  const gm = c && c.groundingMetadata; if (gm && Array.isArray(gm.groundingChunks)) gm.groundingChunks.forEach((x) => { if (x.web && x.web.uri) sources.push({ title: x.web.title || x.web.uri, url: x.web.uri }); });
  return { status: r.status, text, sources, err: d && d.error && d.error.message, finish: c && c.finishReason };
}
async function callGroq(s, messages, o) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.key },
    body: JSON.stringify({ ...(/^openai\/gpt-oss/.test(s.model) ? { reasoning_effort: 'low' } : {}), model: s.model, temperature: 0.35, max_tokens: Math.min(Number((o && o.maxTokens) || process.env.AVA_GROQ_MAX_TOKENS || 16000), 32000), messages }), signal: AbortSignal.timeout((o && o.timeout) || 170000) });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, text: d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '', err: d && d.error && d.error.message };
}

async function walk(slots, run, errs) {
  for (const s of slots) {
    if (!usable(s)) continue;
    let r;
    try { r = await run(s); } catch (e) { r = { status: 0, text: '', err: (e && e.message) || 'network' }; }
    if (r.text && String(r.text).trim()) { sticky[s.prov] = s.id; return r; }
    penalize(s, r.status, r.err); errs.push(s.prov + '/' + s.model + ' ' + r.status + ' ' + String(r.err || (r.finish ? 'finish ' + r.finish : 'empty')).slice(0, 90));
  }
  return null;
}
const humanErr = (errs) => { const w = nextReadyMs(); return errs.slice(-3).join(' | ') + (w ? ' (rate limit — sabse jaldi ' + Math.ceil(w / 1000) + 's me koi key/model wapas)' : ''); };

async function text(prompt, opts) {
  await ensureModels();
  const errs = []; const o = opts || {};
  const gk = geminiKeys();
  const runG = (s) => callGemini(s, [{ text: String(prompt) }], o);
  const learnedBefore = learned.g.length;
  let r = gk.length ? await walk(slotsFor('g', geminiModels(), gk), runG, errs) : null;
  // Google just told us the new model name ("use models/X") -> try again at once with it instead of waiting for the next call
  if (!r && gk.length && learned.g.length > learnedBefore) r = await walk(slotsFor('g', geminiModels(), gk), runG, errs);
  if (r) return String(r.text);
  const h = global.__avaSelf || {};
  if (!gk.length && typeof h.llmText === 'function') {   // keys only known to the main server: use its own rotation
    try { const t = await h.llmText(prompt); if (t && String(t).trim()) return String(t); errs.push('server-gemini empty'); } catch (e) { errs.push('server-gemini ' + String(e.message).slice(0, 80)); }
  }
  const qk = groqKeys();
  r = qk.length ? await walk(slotsFor('q', groqModels(), qk), (s) => callGroq(s, [{ role: 'system', content: o.system || DEFAULT_SYSTEM }, { role: 'user', content: String(prompt) }], o), errs) : null;
  if (r) return String(r.text);
  if (gk.length && typeof h.llmText === 'function' && !errs.some((e) => /server-gemini/.test(e))) {   // last resort: the server's own Gemini path
    try { const t = await h.llmText(prompt); if (t && String(t).trim()) return String(t); } catch (e) { errs.push('server-gemini ' + String(e.message).slice(0, 80)); }
  }
  if (!gk.length && !qk.length && !(typeof h.llmText === 'function')) throw new Error('Koi AI key set nahi (GEMINI_API_KEY ya GROQ_API_KEY)');
  throw new Error(humanErr(errs) || 'AI ne jawab nahi diya');
}
async function groqText(prompt, opts) { await ensureModels(); const errs = []; const r = await walk(slotsFor('q', groqModels(), groqKeys()), (s) => callGroq(s, [{ role: 'system', content: (opts && opts.system) || DEFAULT_SYSTEM }, { role: 'user', content: String(prompt) }], opts || {}), errs); if (r) return String(r.text); throw new Error(errs.length ? humanErr(errs) : 'GROQ_API_KEY set nahi hai'); }

// photos / screenshots -> text. Gemini (all slots) first, then a Groq vision model.
async function vision(prompt, images, opts) {
  await ensureModels();
  const imgs = (images || []).slice(0, 4).filter((i) => i && i.b64); if (!imgs.length) throw new Error('image nahi mili');
  const errs = []; const o = Object.assign({ maxTokens: 6000 }, opts || {});
  const parts = [{ text: String(prompt) }, ...imgs.map((i) => ({ inline_data: { mime_type: i.mime || 'image/png', data: i.b64 } }))];
  const gk = geminiKeys();
  let r = gk.length ? await walk(slotsFor('g', geminiModels().filter((m) => !/lite/.test(m)).concat(geminiModels().filter((m) => /lite/.test(m))), gk), (s) => callGemini(s, parts, o), errs) : null;
  if (r) return String(r.text);
  const qk = groqKeys(); const vm = process.env.AVA_GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
  if (qk.length) {
    const content = [{ type: 'text', text: String(prompt) }, ...imgs.map((i) => ({ type: 'image_url', image_url: { url: 'data:' + (i.mime || 'image/png') + ';base64,' + i.b64 } }))];
    r = await walk(slotsFor('q', [vm], qk), (s) => callGroq(s, [{ role: 'user', content }], o), errs);
    if (r) return String(r.text);
  }
  throw new Error(errs.length ? humanErr(errs) : 'Photo dekhne ke liye GEMINI_API_KEY ya GROQ_API_KEY chahiye');
}
// real web research (Gemini google_search grounding). Never fails the job: falls back to plain model knowledge.
async function research(prompt, opts) {
  await ensureModels();
  const errs = []; const gk = geminiKeys(); const o = Object.assign({ maxTokens: 8000, grounded: true, timeout: 120000 }, opts || {});
  if (gk.length && process.env.AVA_RESEARCH !== 'off') {
    const r = await walk(slotsFor('g', geminiModels().filter((m) => !/2\.0/.test(m)), gk), (s) => callGemini(s, [{ text: String(prompt) }], o), errs);
    if (r) { const seen = new Set(); return { text: String(r.text), sources: (r.sources || []).filter((x) => !seen.has(x.url) && seen.add(x.url)).slice(0, 12), grounded: true }; }
  }
  return { text: await text(prompt, { maxTokens: 5000 }), sources: [], grounded: false };
}
// One tiny real call per key x model (about 20 short requests, no cooldown bookkeeping) so the owner sees WHICH key/model fails and WHY.
async function testKeys() {
  await ensureModels();
  const o = { maxTokens: 400, timeout: 25000, system: 'Reply with exactly the single word: ok' };
  const test = async (prov, n, key, model, run) => {
    let r; const t0 = Date.now();
    try { r = await run({ prov: prov === 'Gemini' ? 'g' : 'q', key, model, id: 'test' }); } catch (e) { r = { status: 0, text: '', err: (e && e.message) || 'network' }; }
    const ok = !!(r.text && String(r.text).trim());
    return { prov, n, tail: String(key).slice(-4), model, ok, status: r.status, ms: Date.now() - t0, keyBad: r.status === 401 || r.status === 403, msg: ok ? '' : String(r.err || (r.finish ? 'finish ' + r.finish : 'empty answer')).replace(/\s+/g, ' ').slice(0, 200) };
  };
  const perKey = async (prov, key, ki, models, run) => {
    const first = await test(prov, ki + 1, key, models[0], run);
    if (first.keyBad) return [{ ...first, model: 'KEY GALAT HAI (is key ke baaki models test nahi kiye)' }];   // one line per bad key, not five
    return [first, ...(await Promise.all(models.slice(1).map((m) => test(prov, ki + 1, key, m, run))))];
  };
  const gm = geminiModels().slice(0, 3), qm = groqModels().slice(0, 3);
  const parts = await Promise.all([
    ...geminiKeys().map((key, ki) => perKey('Gemini', key, ki, gm, (s) => callGemini(s, [{ text: 'Say ok' }], o))),
    ...groqKeys().map((key, ki) => perKey('Groq', key, ki, qm, (s) => callGroq(s, [{ role: 'system', content: o.system }, { role: 'user', content: 'Say ok' }], o)))
  ]);
  return parts.flat();
}
const available = () => !!(geminiKeys().length || groqKeys().length || (global.__avaSelf && global.__avaSelf.llmText));
module.exports = { text, testKeys, models: () => ({ gemini: geminiModels(), groq: groqModels() }), ensureModels, groqText, groqKeys, geminiKeys, vision, research, available, nextReadyMs, status, _t: { cool, keyBan, modelBan, penalize, slotsFor, usable, SIMPLE_NAME } };
