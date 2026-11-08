'use strict';
// One-time check of the Firestore adapter against your REAL Firestore (I could only test it against a fake).
// Run it from the backend folder, with the same Firebase credentials your server uses:
//
//   cd backend
//   node scripts/check-twin-firestore.js
//
// Credentials: it uses FIREBASE_SERVICE_ACCOUNT (JSON string) if set, otherwise GOOGLE_APPLICATION_CREDENTIALS.
// If your server.js initialises firebase-admin some other way, copy that same initialisation into initAdmin() below.
// It only touches users/twin-selfcheck/twin/* and deletes it again at the end.

const admin = require('firebase-admin');
const { firestoreStore } = require('../twin/firestore-store');

function initAdmin() {
  if (admin.apps.length) return;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
}

let failed = 0;
function check(name, cond, extra) {
  if (!cond) failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || '')));
}

(async () => {
  initAdmin();
  const store = firestoreStore(admin.firestore());
  const UID = 'twin-selfcheck';
  try {
    await store.set(UID, 'check', { a: [1, 2, { b: 3 }], s: 'hello' });
    const got = await store.get(UID, 'check');
    check('write + read round trip (nested data)', got && got.a[2].b === 3 && got.s === 'hello', JSON.stringify(got));

    check('missing key returns the default', (await store.get(UID, 'nope', 'dflt')) === 'dflt');

    // 20 parallel increments: proves transactions stop updates from being lost
    await store.set(UID, 'counter', 0);
    await Promise.all(Array.from({ length: 20 }, () => store.update(UID, 'counter', (v) => (v || 0) + 1, 0)));
    const n = await store.get(UID, 'counter');
    check('20 parallel updates => exactly 20 (no lost writes)', n === 20, 'got ' + n);

    const uids = await store.listUids();
    check('listUids finds the test user (needed by the background scheduler)', uids.includes(UID), JSON.stringify(uids.slice(0, 5)));

    await store.remove(UID, 'check');
    check('remove works', (await store.get(UID, 'check', null)) === null);
  } catch (e) {
    failed++;
    console.log('FAIL unexpected error: ' + e.message);
  } finally {
    try { await store.remove(UID, 'counter'); } catch (_) { /* ignore */ }
  }
  console.log(failed ? `\n${failed} check(s) FAILED. Do not rely on the twin until this passes.` : '\nAll Firestore checks passed.');
  process.exit(failed ? 1 : 0);
})();
