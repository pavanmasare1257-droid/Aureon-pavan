'use strict';
// Tiny storage layer. Same interface for memory (tests) and JSON files (default).
// To use Firestore later, implement the same 5 methods and pass it to createTwin({ store }).
const fs = require('fs');
const path = require('path');

function safeUid(uid) {
  const s = String(uid || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) throw new Error('invalid uid');
  return s;
}
function safeKey(key) {
  const s = String(key || '');
  if (!/^[a-z0-9_-]{1,64}$/i.test(s)) throw new Error('invalid key');
  return s;
}

// Serialises writes so two requests never overwrite each other.
function makeLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

function memoryStore() {
  const data = new Map();
  const lock = makeLock();
  const store = {
    async get(uid, key, def = null) {
      const k = safeUid(uid) + '/' + safeKey(key);
      return data.has(k) ? structuredClone(data.get(k)) : def;
    },
    async set(uid, key, val) {
      data.set(safeUid(uid) + '/' + safeKey(key), structuredClone(val));
      return val;
    },
    update(uid, key, fn, def = null) {
      return lock(async () => {
        const next = fn(await store.get(uid, key, def));
        await store.set(uid, key, next);
        return structuredClone(next);
      });
    },
    async remove(uid, key) {
      data.delete(safeUid(uid) + '/' + safeKey(key));
    },
    async listUids() {
      return [...new Set([...data.keys()].map((k) => k.split('/')[0]))];
    },
  };
  return store;
}

function fileStore(dir) {
  const lock = makeLock();
  const file = (uid, key) => path.join(dir, safeUid(uid), safeKey(key) + '.json');
  const store = {
    async get(uid, key, def = null) {
      try {
        return JSON.parse(await fs.promises.readFile(file(uid, key), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return def;
        throw e;
      }
    },
    async set(uid, key, val) {
      const f = file(uid, key);
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      const tmp = f + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(val));
      await fs.promises.rename(tmp, f); // atomic replace
      return val;
    },
    update(uid, key, fn, def = null) {
      return lock(async () => {
        const next = fn(await store.get(uid, key, def));
        await store.set(uid, key, next);
        return next;
      });
    },
    async remove(uid, key) {
      try {
        await fs.promises.unlink(file(uid, key));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },
    async listUids() {
      try {
        const items = await fs.promises.readdir(dir, { withFileTypes: true });
        return items.filter((d) => d.isDirectory()).map((d) => d.name);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
  };
  return store;
}

module.exports = { memoryStore, fileStore, safeUid };
