'use strict';
// Shadow Learning Engine.
// PRIVACY: raw messages and raw code are NEVER stored. Only counters and word
// frequencies are kept, so the profile is useful but cannot be read back as chat history.

const HINGLISH = new Set(
  ('hai hain kar karo karna ka ki ke mein me nahi nahin aur ko se par pe bhi tha thi kya abhi haan ' +
    'lekin wo woh ye yeh hum aap mujhe tum bana banao de do sakte sakta raha rahe rahi chahiye ' +
    'bhai boss accha theek kaise kyun kaam bolo dekho paisa').split(' ')
);
const STOP = new Set(
  ('the and for that this with from have will your you are was but not can all any use hai hain kar karo ' +
    'ka ki ke mein nahi aur ko se par bhi kya abhi haan lekin ye wo hum aap mujhe').split(' ')
);
const MAX_WORDS = 300;
const MAX_DECISIONS = 100;

function emptyProfile() {
  return {
    messages: 0,
    chars: 0,
    hinglishWords: 0,
    totalWords: 0,
    words: {},
    code: { files: 0, semi: 0, noSemi: 0, single: 0, double: 0, indent2: 0, indent4: 0, tabs: 0, camel: 0, snake: 0, arrow: 0, funcDecl: 0 },
    decisions: [],
    updatedAt: 0,
  };
}

function trimWords(words) {
  const entries = Object.entries(words);
  if (entries.length <= MAX_WORDS) return words;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_WORDS));
}

function learnText(p, text) {
  const tokens = String(text).toLowerCase().match(/[a-zऀ-ॿ]+/g) || [];
  p.messages += 1;
  p.chars += String(text).length;
  for (const t of tokens) {
    p.totalWords += 1;
    if (HINGLISH.has(t)) p.hinglishWords += 1;
    if (t.length > 3 && !STOP.has(t)) p.words[t] = (p.words[t] || 0) + 1;
  }
  p.words = trimWords(p.words);
}

function learnCode(p, code) {
  const c = p.code;
  const lines = String(code).split('\n').filter((l) => l.trim());
  c.files += 1;
  for (const l of lines) {
    const t = l.trimEnd();
    if (/[;]$/.test(t)) c.semi += 1;
    else if (/[)\]a-z0-9'"`]$/i.test(t)) c.noSemi += 1;
    const lead = l.match(/^(\t+| +)/);
    if (lead) {
      if (lead[1][0] === '\t') c.tabs += 1;
      else if (lead[1].length % 4 === 0) c.indent4 += 1;
      else if (lead[1].length % 2 === 0) c.indent2 += 1;
    }
  }
  const s = String(code);
  c.single += (s.match(/'[^'\n]*'/g) || []).length;
  c.double += (s.match(/"[^"\n]*"/g) || []).length;
  c.camel += (s.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g) || []).length;
  c.snake += (s.match(/\b[a-z]+_[a-z0-9_]+\b/g) || []).length;
  c.arrow += (s.match(/=>/g) || []).length;
  c.funcDecl += (s.match(/\bfunction\s+\w+/g) || []).length;
}

function createShadow({ store, now = Date.now }) {
  const KEY = 'shadow';

  async function record(uid, event) {
    if (!event || typeof event !== 'object') throw new Error('event required');
    const type = event.type;
    if (!['message', 'code', 'decision'].includes(type)) throw new Error('unknown event type');
    return store.update(uid, KEY, (p) => {
      const prof = p || emptyProfile();
      if (type === 'message' && typeof event.text === 'string') learnText(prof, event.text.slice(0, 5000));
      if (type === 'code' && typeof event.code === 'string') learnCode(prof, event.code.slice(0, 50000));
      if (type === 'decision') {
        prof.decisions.push({
          topic: String(event.topic || '').slice(0, 80),
          choice: String(event.choice || '').slice(0, 120),
          at: now(),
        });
        prof.decisions = prof.decisions.slice(-MAX_DECISIONS);
      }
      prof.updatedAt = now();
      return prof;
    }, emptyProfile());
  }

  function summarize(p) {
    if (!p || !p.messages) return { learned: false };
    const ratio = p.totalWords ? p.hinglishWords / p.totalWords : 0;
    const avg = p.chars / p.messages;
    const c = p.code;
    const out = {
      learned: true,
      messages: p.messages,
      language: ratio > 0.15 ? 'Hinglish' : 'English',
      verbosity: avg < 60 ? 'short' : avg < 200 ? 'medium' : 'long',
      topTopics: Object.entries(p.words).sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]),
      recentDecisions: p.decisions.slice(-5),
    };
    if (c.files) {
      out.code = {
        semicolons: c.semi >= c.noSemi,
        quotes: c.single >= c.double ? 'single' : 'double',
        indent: c.tabs > c.indent2 + c.indent4 ? 'tabs' : c.indent4 > c.indent2 ? '4 spaces' : '2 spaces',
        naming: c.camel >= c.snake ? 'camelCase' : 'snake_case',
        prefersArrowFunctions: c.arrow >= c.funcDecl,
      };
    }
    return out;
  }

  async function getProfile(uid) {
    return summarize(await store.get(uid, KEY, null));
  }

  // Short text block that can be appended to the backend's system prompt.
  async function toPromptContext(uid) {
    const s = await getProfile(uid);
    if (!s.learned) return '';
    const parts = [`User writes mostly in ${s.language}; prefers ${s.verbosity} replies.`];
    if (s.topTopics.length) parts.push(`Frequent topics: ${s.topTopics.join(', ')}.`);
    if (s.code) {
      parts.push(
        `Code style: ${s.code.indent}, ${s.code.semicolons ? 'semicolons' : 'no semicolons'}, ` +
          `${s.code.quotes} quotes, ${s.code.naming}${s.code.prefersArrowFunctions ? ', arrow functions' : ''}.`
      );
    }
    return parts.join(' ').slice(0, 800);
  }

  async function forget(uid) {
    await store.remove(uid, KEY);
  }

  return { record, getProfile, toPromptContext, forget };
}

module.exports = { createShadow };
