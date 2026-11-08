'use strict';
// Firestore storage adapter (same interface as store.js). USE THIS ON RENDER.
// Render's free disk is wiped on every redeploy/restart, so the JSON file store would lose the twin's memory.
//
//   const admin = require('firebase-admin');           // already initialised in your server.js
//   const { firestoreStore } = require('./twin/firestore-store');
//   const twin = createTwin({ store: firestoreStore(admin.firestore()) });
//
// Data lives at users/{uid}/twin/{key}. Each doc holds { v: "<json string>" } so nested arrays are safe.
const { safeUid } = require('./store');

function safeKey(key) {
  const s = String(key || '');
  if (!/^[a-z0-9_-]{1,64}$/i.test(s)) throw new Error('invalid key');
  return s;
}

function firestoreStore(db) {
  const ref = (uid, key) => db.collection('users').doc(safeUid(uid)).collection('twin').doc(safeKey(key));
  const parse = (snap, def) => (snap.exists && snap.data() && typeof snap.data().v === 'string' ? JSON.parse(snap.data().v) : def);

  return {
    async get(uid, key, def = null) {
      return parse(await ref(uid, key).get(), def);
    },
    async set(uid, key, val) {
      await ref(uid, key).set({ v: JSON.stringify(val), updatedAt: Date.now() });
      return val;
    },
    // Transaction => safe even if two Render instances touch the same user.
    async update(uid, key, fn, def = null) {
      const r = ref(uid, key);
      return db.runTransaction(async (tx) => {
        const next = fn(parse(await tx.get(r), def));
        tx.set(r, { v: JSON.stringify(next), updatedAt: Date.now() });
        return next;
      });
    },
    async remove(uid, key) {
      await ref(uid, key).delete();
    },
    async listUids() {
      const docs = await db.collection('users').listDocuments();
      return docs.map((d) => d.id).filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id));
    },
  };
}

module.exports = { firestoreStore };
