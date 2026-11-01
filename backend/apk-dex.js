// backend/apk-dex.js — reads Android DEX files (classes.dex, classes2.dex...) in memory, so Ava can look for bugs / risks inside an APK.
// Honest scope: this is NOT a decompiler (no Java source). It reads the DEX tables: class + method names, which Android / library APIs the app
// calls, and every string constant — then runs static rules over them (insecure WebView, trust-all TLS, hard-coded keys, cleartext URLs, weak crypto...).
// Nothing is installed or executed. Secrets found are MASKED before they reach the AI context.

const MAX_STRINGS = 400000, MAX_STR_LEN = 600;

function uleb(buf, o) { let r = 0, s = 0, b; do { b = buf[o++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80 && s < 35); return { v: r >>> 0, o }; }

/** parse one DEX buffer -> {version, strings[], types[], methods[{cls,name,proto}], classes[{name,access,superName}]} */
function parseDex(buf) {
  if (buf.length < 0x70 || buf.slice(0, 4).toString('latin1') !== 'dex\n') throw new Error('ye valid dex nahi');
  const u32 = (o) => buf.readUInt32LE(o);
  const sN = u32(0x38), sOff = u32(0x3c), tN = u32(0x40), tOff = u32(0x44), pN = u32(0x48), pOff = u32(0x4c), mN = u32(0x58), mOff = u32(0x5c), cN = u32(0x60), cOff = u32(0x64);
  if (sN > MAX_STRINGS || sOff + sN * 4 > buf.length) throw new Error('dex header galat / bahut badi');
  const strings = new Array(sN);
  for (let i = 0; i < sN; i++) {
    let o = u32(sOff + i * 4); if (o >= buf.length) { strings[i] = ''; continue; }
    o = uleb(buf, o).o; let e = o; const lim = Math.min(buf.length, o + MAX_STR_LEN * 3); while (e < lim && buf[e] !== 0) e++;
    strings[i] = buf.slice(o, e).toString('utf8');
  }
  const types = new Array(tN); for (let i = 0; i < tN; i++) types[i] = strings[u32(tOff + i * 4)] || '';
  const protos = new Array(pN); for (let i = 0; i < pN; i++) protos[i] = strings[u32(pOff + i * 12)] || '';   // shorty only
  const methods = new Array(mN);
  for (let i = 0; i < mN; i++) { const o = mOff + i * 8; methods[i] = { cls: types[buf.readUInt16LE(o)] || '', name: strings[u32(o + 4)] || '', proto: protos[buf.readUInt16LE(o + 2)] || '' }; }
  const classes = [];
  for (let i = 0; i < cN; i++) { const o = cOff + i * 32; classes.push({ name: types[u32(o)] || '', access: u32(o + 4), superName: u32(o + 8) === 0xffffffff ? '' : (types[u32(o + 8)] || '') }); }
  return { version: buf.slice(4, 7).toString('latin1'), strings, types, methods, classes };
}

const pretty = (d) => String(d).replace(/^L/, '').replace(/;$/, '').replace(/\//g, '.');
const mask = (s) => (s.length <= 8 ? '****' : s.slice(0, 5) + '…(' + s.length + ' chars, masked)');

// risky framework / library calls: [class regex, method regex, severity, what it means]
const API_RULES = [
  [/^Landroid\/webkit\/WebView;$/, /^addJavascriptInterface$/, 'HIGH', 'WebView.addJavascriptInterface — JS se native code call; untrusted page ho to RCE risk'],
  [/^Landroid\/webkit\/WebSettings;$/, /^setJavaScriptEnabled$/, 'INFO', 'WebView me JavaScript on hai (sirf apna trusted content load karo)'],
  [/^Landroid\/webkit\/WebSettings;$/, /^set(AllowFileAccessFromFileURLs|AllowUniversalAccessFromFileURLs)$/, 'HIGH', 'WebView file:// se dusre files / origins padh sakta hai'],
  [/^Landroid\/webkit\/WebViewClient;$/, /^onReceivedSslError$/, 'HIGH', 'WebView SSL error handler — agar proceed() karta hai to HTTPS verification band (check karo)'],
  [/^Ljava\/lang\/Runtime;$/, /^exec$/, 'MED', 'Runtime.exec — shell command chalti hai'],
  [/^Ldalvik\/system\/(DexClassLoader|PathClassLoader|InMemoryDexClassLoader);$/, /^<init>$/, 'MED', 'Runtime par dynamic code load ho raha hai'],
  [/^Ljavax\/net\/ssl\/HttpsURLConnection;$/, /^setDefaultHostnameVerifier$/, 'HIGH', 'Global hostname verifier badla ja raha hai — trust-all ho sakta hai'],
  [/^Ljavax\/net\/ssl\/SSLContext;$/, /^init$/, 'INFO', 'Custom SSLContext / TrustManager use — verify karo ki trust-all nahi hai'],
  [/^Landroid\/util\/Log;$/, /^(d|v)$/, 'LOW', 'Log.d / Log.v — release me sensitive data log na ho'],
  [/^Landroid\/os\/Environment;$/, /^getExternalStorage(Directory|PublicDirectory)$/, 'LOW', 'External storage use — files sabko padhne ko mil sakti hain'],
  [/^Landroid\/content\/Context;$/, /^openFileOutput$/, 'INFO', 'Private file likhi ja rahi hai (MODE check karo)'],
  [/^Landroid\/telephony\/SmsManager;$/, /^sendTextMessage$/, 'MED', 'SMS bheja ja raha hai'],
  [/^Ljava\/io\/ObjectInputStream;$/, /^readObject$/, 'MED', 'Java deserialization — untrusted data par khatarnak'],
  [/^Landroid\/database\/sqlite\/SQLiteDatabase;$/, /^(rawQuery|execSQL)$/, 'LOW', 'Raw SQL — string jod ke query banai to SQL injection ho sakta hai'],
];
// string rules: [regex, severity, label, mask?]
const STR_RULES = [
  [/AIza[0-9A-Za-z_\-]{35}/, 'HIGH', 'Google API key hard-coded', true],
  [/AKIA[0-9A-Z]{16}/, 'HIGH', 'AWS access key hard-coded', true],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'HIGH', 'Private key app ke andar', true],
  [/(ghp_|github_pat_)[0-9A-Za-z_]{30,}/, 'HIGH', 'GitHub token hard-coded', true],
  [/xox[baprs]-[0-9A-Za-z-]{10,}/, 'HIGH', 'Slack token hard-coded', true],
  [/sk-[A-Za-z0-9]{32,}/, 'HIGH', 'API secret key (sk-…) hard-coded', true],
  [/^(DES|DESede|RC4|AES\/ECB\/[A-Za-z0-9]+|AES\/ECB)$/, 'MED', 'Weak cipher mode', false],
  [/^(MD5|SHA-?1)$/, 'LOW', 'Weak hash algorithm (MD5 / SHA-1)', false],
  [/https:\/\/[a-z0-9\-]+\.firebaseio\.com/i, 'INFO', 'Firebase Realtime DB URL — rules public to nahi? check karo', false],
];

/** analyse a list of parsed dex objects. `ownPkg` (from the manifest) narrows the class list to the app's own code. */
function analyse(dexes, ownPkg) {
  const own = ownPkg ? 'L' + String(ownPkg).replace(/\./g, '/') + '/' : null;
  const classNames = [], apiHits = new Map(), findings = [], urls = new Set(), ownMethods = new Map();
  let strCount = 0, methodCount = 0, classCount = 0, trustAll = false, trustMgr = false;
  const add = (sev, msg, where) => { const k = sev + '|' + msg; if (!findings.some((f) => f.k === k)) findings.push({ k, sev, msg, where: where || '' }); };
  for (const d of dexes) {
    classCount += d.classes.length; methodCount += d.methods.length; strCount += d.strings.length;
    for (const c of d.classes) {
      classNames.push(c.name);
      if (/^Ljavax\/net\/ssl\/X509TrustManager;|^Ljavax\/net\/ssl\/HostnameVerifier;/.test(c.name) === false && /X509TrustManager|HostnameVerifier/.test(c.superName)) { trustMgr = true; add('MED', 'App apna TrustManager / HostnameVerifier implement karta hai: ' + pretty(c.name) + ' — checkServerTrusted / verify khaali ya true-always to nahi? (check karo)', pretty(c.name)); }
    }
    for (const m of d.methods) {
      if (own && m.cls.startsWith(own)) { const a = ownMethods.get(m.cls) || []; if (a.length < 40) a.push(m.name); ownMethods.set(m.cls, a); }
      for (const [cr, mr, sev, why] of API_RULES) if (cr.test(m.cls) && mr.test(m.name)) { const k = m.cls + '.' + m.name; apiHits.set(k, { sev, why, k: pretty(m.cls) + '.' + m.name }); }
    }
    for (const s of d.strings) {
      if (!s || s.length > MAX_STR_LEN) continue;
      if (s.length > 10 && /^https?:\/\//i.test(s)) urls.add(s);
      for (const [re, sev, label, doMask] of STR_RULES) { const m = s.match(re); if (m) add(sev, label + (doMask ? ': ' + mask(m[0]) : ''), ''); }
    }
  }
  for (const h of apiHits.values()) add(h.sev, h.why, h.k);
  const cleartext = [...urls].filter((u) => /^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.|10\.0\.2\.2|schemas\.|www\.w3\.org|xmlpull|ns\.adobe|apache\.org|java\.sun|xml\.org|json\.org)/i.test(u));
  if (cleartext.length) add('MED', 'Cleartext http:// URLs mile (' + cleartext.length + '): ' + cleartext.slice(0, 4).join(', ').slice(0, 220), '');
  const order = { HIGH: 0, MED: 1, LOW: 2, INFO: 3 };
  findings.sort((a, b) => order[a.sev] - order[b.sev]);
  return { classCount, methodCount, strCount, classNames, ownMethods, urls: [...urls], findings, trustMgr, trustAll };
}

/** manifest-level rules (info comes from attach.parseAxml) */
function manifestFindings(m) {
  const out = []; if (!m) return out;
  const f = m.flags || {};
  if (f.debuggable === 'true') out.push({ sev: 'HIGH', msg: 'android:debuggable="true" — release APK debuggable nahi hona chahiye' });
  if (f.allowBackup !== 'false') out.push({ sev: 'MED', msg: 'allowBackup on (default) — adb backup se app ka data nikal sakta hai' });
  if (f.usesCleartextTraffic === 'true') out.push({ sev: 'MED', msg: 'usesCleartextTraffic="true" — plain HTTP allowed' });
  if (m.minSdk && Number(m.minSdk) < 23) out.push({ sev: 'LOW', msg: 'minSdk ' + m.minSdk + ' bahut purana — kam security features' });
  if (m.targetSdk && Number(m.targetSdk) < 33) out.push({ sev: 'LOW', msg: 'targetSdk ' + m.targetSdk + ' purana — Play Store naye apps ko 34+ maangta hai' });
  for (const c of m.components || []) if (c.exported === 'true' && !c.permission) out.push({ sev: c.kind === 'activity' ? 'LOW' : 'MED', msg: 'exported ' + c.kind + ' bina permission ke: ' + c.name + ' — koi bhi dusra app ise khol sakta hai' });
  for (const c of m.components || []) if (c.exported === undefined && c.filter && !c.permission && /^(service|receiver|provider)$/.test(c.kind)) out.push({ sev: 'MED', msg: c.kind + ' ' + c.name + ' me intent-filter hai (implicitly exported on old targets) — android:exported saaf likho' });
  const dang = (m.permissions || []).filter((p) => /(READ_SMS|SEND_SMS|RECEIVE_SMS|READ_CALL_LOG|RECORD_AUDIO|ACCESS_FINE_LOCATION|READ_CONTACTS|CAMERA|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|SYSTEM_ALERT_WINDOW|REQUEST_INSTALL_PACKAGES|BIND_ACCESSIBILITY_SERVICE)$/.test(p));
  if (dang.length) out.push({ sev: 'INFO', msg: 'Sensitive permissions: ' + dang.map((p) => p.replace(/^android\.permission\./, '')).join(', ') + ' — sach me zaroorat hai?' });
  return out;
}

/** text block for the AI context */
function renderReport(a, m, opts) {
  const lim = (opts && opts.chars) || 7000; const L = [];
  L.push('DEX ANALYSIS (static — compiled code ka source nahi, par ye tables / APIs / strings pakde gaye):');
  L.push(a.classCount + ' classes, ' + a.methodCount + ' methods, ' + a.strCount + ' strings in ' + (a.dexCount || '?') + ' dex file(s)');
  const mf = manifestFindings(m); const all = mf.map((x) => ({ sev: x.sev, msg: 'MANIFEST: ' + x.msg })).concat(a.findings.map((x) => ({ sev: x.sev, msg: x.msg + (x.where ? '  [' + x.where + ']' : '') })));
  const order = { HIGH: 0, MED: 1, LOW: 2, INFO: 3 }; all.sort((x, y) => order[x.sev] - order[y.sev]);
  if (all.length) { L.push('POSSIBLE ISSUES (' + all.length + '; verify before fixing — static rules guess):'); all.slice(0, 40).forEach((x) => L.push('- [' + x.sev + '] ' + x.msg)); } else L.push('Koi static issue nahi pakda.');
  const own = [...a.ownMethods.entries()].slice(0, 60);
  if (own.length) { L.push('APP KE APNE CLASSES (+ methods):'); own.forEach(([c, ms]) => L.push('- ' + pretty(c) + ': ' + [...new Set(ms)].slice(0, 14).join(', '))); }
  else { const cn = a.classNames.filter((c) => !/^L(android|androidx|kotlin|kotlinx|java|javax|com\/google|com\/android|org\/(jetbrains|apache|json)|okhttp3|okio|retrofit2|dalvik)\//.test(c)).slice(0, 80); if (cn.length) L.push('Classes (framework/libraries chhod ke): ' + cn.map(pretty).join(', ')); }
  const ul = a.urls.filter((u) => !/^https?:\/\/(schemas\.android|www\.w3\.org|developer\.android|developers\.google|play\.google|goo\.gl|g\.co)/i.test(u)).slice(0, 25); if (ul.length) L.push('URLs: ' + ul.join(' | '));
  return L.join('\n').slice(0, lim);
}

module.exports = { parseDex, analyse, manifestFindings, renderReport, _t: { uleb, mask, pretty } };
