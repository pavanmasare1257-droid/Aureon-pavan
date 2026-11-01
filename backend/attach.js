// backend/attach.js — turns what the owner drops into Ava Lab (a ZIP of a project and/or photos / screenshots) into a compact text "context"
// Ava can build from. Nothing is written to disk or executed: the ZIP is only READ in memory (size/entry caps = zip-bomb safe, no extraction paths).
const zlib = require('zlib');

const MB = 1024 * 1024, envMB = (k, d) => { const n = Number(process.env[k]); return (n > 0 ? n : d) * MB; };
// v33: no small fixed cap any more. Only a memory-safety ceiling, raise it on Render with AVA_MAX_ZIP_MB / AVA_MAX_UNPACKED_MB (the file is held in RAM while reading).
const MAX_ZIP = envMB('AVA_MAX_ZIP_MB', 400), MAX_IMG = 6 * MB, MAX_IMAGES = 4, MAX_ENTRIES = 60000, MAX_UNPACKED = envMB('AVA_MAX_UNPACKED_MB', 2000), MAX_READ_FILE = 200 * 1024, MAX_DEX = 96 * MB;
const CONTEXT_CHARS = 26000, PER_FILE = 3200, APK_REPORT = 14000;
const TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|json|md|txt|html|htm|css|scss|py|java|kt|kts|go|rs|c|cc|cpp|h|hpp|cs|rb|php|sh|yml|yaml|toml|xml|sql|gradle|properties|swift|dart|vue|svelte|ini|cfg|env\.example)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|__pycache__|\.gradle|\.idea|\.vscode|vendor|coverage|target|android\/app\/build|ios\/Pods)(\/|$)/;
const PRIORITY = [/(^|\/)readme(\.md|\.txt)?$/i, /(^|\/)package\.json$/, /(^|\/)(manifest|AndroidManifest)\.(json|xml)$/, /(^|\/)(index|main|app|server)\.(js|ts|py|html|jsx|tsx)$/i, /(^|\/)(pubspec\.yaml|requirements\.txt|pom\.xml|build\.gradle|go\.mod|Cargo\.toml)$/i, /(^|\/)(src|lib|app|routes|api)\//];

function isImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}
/** Reads the central directory of a ZIP buffer. Returns [{name, method, csize, usize, off}] */
function zipEntries(buf) {
  let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('ye valid ZIP nahi lagti');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = []; let total = 0;
  if (n > MAX_ENTRIES) throw new Error('ZIP me bahut zyada files (' + n + ' > ' + MAX_ENTRIES + ')');
  for (let i = 0; i < n && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8').replace(/\\/g, '/');
    total += usize; if (total > MAX_UNPACKED) throw new Error('ZIP unpack hone par bahut badi (>' + (MAX_UNPACKED >> 20) + 'MB)');
    out.push({ name, method, csize, usize, off }); p += 46 + nl + xl + cl;
  }
  return out;
}
function readEntry(buf, en, max) {
  max = max || MAX_READ_FILE;
  const p = en.off; if (buf.readUInt32LE(p) !== 0x04034b50) return null;
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28); const body = buf.slice(start, start + en.csize);
  if (en.method === 0) return body.slice(0, max);
  if (en.method === 8) { try { return zlib.inflateRawSync(body, { maxOutputLength: max }); } catch (e) { try { return zlib.inflateRawSync(body).slice(0, max); } catch (e2) { return null; } } }
  return null;
}

// ---------------------------------------------------------------- APK reading (v33)
// An APK is a ZIP, but AndroidManifest.xml inside is binary XML (AXML). This reads it in memory (never installs / runs anything):
// package, version, SDKs, permissions, components + what the app is made of (dex, native libs, Capacitor/Cordova web assets).
function parseAxml(buf) {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) throw new Error('manifest binary XML nahi lagta');
  const pools = []; let strings = [];
  const readPool = (p) => {
    const count = buf.readUInt32LE(p + 8), flags = buf.readUInt32LE(p + 16), sStart = buf.readUInt32LE(p + 20), utf8 = !!(flags & 0x100);
    if (count > 20000) throw new Error('string pool bahut badi');
    const out = [];
    for (let i = 0; i < count; i++) {
      let o = p + sStart + buf.readUInt32LE(p + 28 + i * 4);
      if (utf8) { let l = buf[o++]; if (l & 0x80) o++; let bl = buf[o++]; if (bl & 0x80) bl = ((bl & 0x7f) << 8) | buf[o++]; out.push(buf.slice(o, o + bl).toString('utf8')); }
      else { let l = buf.readUInt16LE(o); o += 2; if (l & 0x8000) { l = ((l & 0x7fff) << 16) | buf.readUInt16LE(o); o += 2; } out.push(buf.slice(o, o + l * 2).toString('utf16le')); }
    }
    return out;
  };
  const info = { flags: {}, components: [], package: '', versionName: '', versionCode: '', minSdk: '', targetSdk: '', label: '', permissions: [], activities: [], services: [], receivers: [], providers: [], features: [], mainActivity: '' };
  let p = buf.readUInt16LE(2); let stack = [];
  const val = (type, data, raw) => raw >= 0 && raw < strings.length && raw !== 0xffffffff ? strings[raw] : type === 0x10 ? String(data | 0) : type === 0x12 ? String(!!data) : type === 0x03 ? (strings[data] || '') : type === 0x01 ? '@' + data.toString(16) : String(data);
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p), size = buf.readUInt32LE(p + 4); if (size < 8) break;
    if (type === 0x0001) strings = readPool(p);
    else if (type === 0x0102) {
      const name = strings[buf.readUInt32LE(p + 20)] || '', attrStart = buf.readUInt16LE(p + 24), attrSize = buf.readUInt16LE(p + 26), n = buf.readUInt16LE(p + 28); const a = {};
      for (let i = 0; i < n && i < 200; i++) { const o = p + 16 + attrStart + i * attrSize; const an = strings[buf.readUInt32LE(o + 4)] || ''; const raw = buf.readUInt32LE(o + 8); a[an] = val(buf[o + 15], buf.readUInt32LE(o + 16), raw); }
      const parent = stack[stack.length - 1]; stack.push(name);
      if (name === 'manifest') { info.package = a.package || ''; info.versionName = a.versionName || ''; info.versionCode = a.versionCode || ''; }
      else if (name === 'uses-sdk') { info.minSdk = a.minSdkVersion || ''; info.targetSdk = a.targetSdkVersion || ''; }
      else if (name === 'uses-permission' || name === 'uses-permission-sdk-23') { if (a.name) info.permissions.push(a.name); }
      else if (name === 'uses-feature') { if (a.name) info.features.push(a.name + (a.required === 'false' ? ' (optional)' : '')); }
      else if (name === 'application') { info.label = a.label || ''; info.flags = { debuggable: a.debuggable, allowBackup: a.allowBackup, usesCleartextTraffic: a.usesCleartextTraffic }; }
      else if (name === 'activity' || name === 'activity-alias') info.activities.push(a.name || '?');
      else if (name === 'service') info.services.push(a.name || '?');
      else if (name === 'receiver') info.receivers.push(a.name || '?');
      else if (name === 'provider') info.providers.push(a.name || '?');
      else if (name === 'action' && a.name === 'android.intent.action.MAIN' && parent === 'intent-filter') info._main = true;
      if (name === 'activity' || name === 'activity-alias') info._lastAct = a.name || '';
      if (/^(activity|activity-alias|service|receiver|provider)$/.test(name)) { info._comp = { kind: name === 'activity-alias' ? 'activity' : name, name: a.name || '?', exported: a.exported, permission: a.permission, filter: false }; info.components.push(info._comp); }
      if (name === 'intent-filter' && info._comp && /^(activity|activity-alias|service|receiver)$/.test(parent)) info._comp.filter = true;
      if (name === 'category' && a.name === 'android.intent.category.LAUNCHER' && info._main) info.mainActivity = info._lastAct;
    } else if (type === 0x0103) stack.pop();
    p += size;
  }
  delete info._main; delete info._lastAct; delete info._comp; return info;
}
const isApk = (names) => names.includes('AndroidManifest.xml') && names.some((n) => /^classes\d*\.dex$/.test(n) || n === 'resources.arsc');
function summariseApk(buf, label, entries) {
  const out = ['--- APK "' + label + '" (Android app, ' + Math.round(buf.length / 1024) + ' KB) ---'];
  const mf = entries.find((e) => e.name === 'AndroidManifest.xml'); let m = null;
  try { const raw = mf && (mf.method === 0 ? buf.slice(mf.off + 30 + buf.readUInt16LE(mf.off + 26) + buf.readUInt16LE(mf.off + 28), mf.off + 30 + buf.readUInt16LE(mf.off + 26) + buf.readUInt16LE(mf.off + 28) + mf.csize) : zlib.inflateRawSync(buf.slice(mf.off + 30 + buf.readUInt16LE(mf.off + 26) + buf.readUInt16LE(mf.off + 28), mf.off + 30 + buf.readUInt16LE(mf.off + 26) + buf.readUInt16LE(mf.off + 28) + mf.csize))); m = parseAxml(raw); } catch (e) { out.push('(manifest padh nahi payi: ' + String(e.message).slice(0, 80) + ')'); }
  if (m) {
    out.push('Package: ' + m.package + ' | version: ' + (m.versionName || '?') + ' (code ' + (m.versionCode || '?') + ') | minSdk ' + (m.minSdk || '?') + ' / targetSdk ' + (m.targetSdk || '?') + (m.label ? ' | label: ' + m.label : ''));
    if (m.mainActivity) out.push('Launcher activity: ' + m.mainActivity);
    if (m.permissions.length) out.push('Permissions (' + m.permissions.length + '): ' + m.permissions.map((x) => x.replace(/^android\.permission\./, '')).join(', '));
    if (m.features.length) out.push('Features: ' + m.features.join(', '));
    if (m.activities.length) out.push('Activities: ' + m.activities.slice(0, 25).join(', '));
    if (m.services.length) out.push('Services: ' + m.services.slice(0, 25).join(', '));
    if (m.receivers.length) out.push('Receivers: ' + m.receivers.slice(0, 25).join(', '));
    if (m.providers.length) out.push('Providers: ' + m.providers.slice(0, 15).join(', '));
  }
  const names = entries.map((e) => e.name);
  const kinds = [];
  const dex = entries.filter((e) => /^classes\d*\.dex$/.test(e.name)); if (dex.length) kinds.push(dex.length + ' dex (' + Math.round(dex.reduce((a, e) => a + e.usize, 0) / 1024) + ' KB compiled Java/Kotlin)');
  const abis = [...new Set(names.map((n) => (n.match(/^lib\/([^/]+)\//) || [])[1]).filter(Boolean))]; if (abis.length) kinds.push('native libs: ' + abis.join(', '));
  const web = names.filter((n) => /^assets\/(public|www)\//.test(n)); if (web.length || names.includes('assets/capacitor.config.json')) kinds.push('Capacitor/Cordova WebView app (' + web.length + ' web files) — asli UI/logic assets/public me HTML/JS hai');
  if (names.some((n) => /^assets\/index\.android\.bundle$/.test(n))) kinds.push('React Native bundle');
  if (names.some((n) => /libflutter\.so$/.test(n))) kinds.push('Flutter app');
  if (names.some((n) => /^META-INF\/.*\.(RSA|DSA|EC)$/.test(n))) kinds.push('signed');
  out.push('Banaya kaise gaya: ' + (kinds.join('; ') || 'normal native Android app'));
  // v33: read the compiled code tables too (classes / methods / API calls / strings) + static bug & security rules
  try {
    const dexer = require('./apk-dex'); const parsed = [];
    for (const en of dex.slice(0, 12)) { const b = readEntry(buf, en, MAX_DEX); if (b && b.length > 0x70) { try { parsed.push(dexer.parseDex(b)); } catch (e) { out.push('(' + en.name + ' padh nahi payi: ' + String(e.message).slice(0, 60) + ')'); } } }
    if (parsed.length) { const a = dexer.analyse(parsed, m && m.package); a.dexCount = parsed.length; out.push('\n' + dexer.renderReport(a, m)); }
    else if (m) { const mf = dexer.manifestFindings(m); if (mf.length) out.push('\nMANIFEST ISSUES:\n' + mf.map((x) => '- [' + x.sev + '] ' + x.msg).join('\n')); }
  } catch (e) { out.push('(dex analysis fail: ' + String(e.message).slice(0, 80) + ')'); }
  return { text: out.join('\n'), web: m ? m : null };
}

const rank = (name) => { for (let i = 0; i < PRIORITY.length; i++) if (PRIORITY[i].test(name)) return i; return PRIORITY.length; };

/** Summarise a ZIP: file tree + the most important files (truncated). */
function summariseZip(buf, label) {
  const raw = zipEntries(buf); const apk = isApk(raw.map((x) => x.name)) ? summariseApk(buf, label, raw) : null;
  const all = raw.filter((x) => x.name && !x.name.endsWith('/') && !/(^|\/)\.\.(\/|$)/.test(x.name) && !x.name.startsWith('/') && !SKIP_DIR.test(x.name) && !/(^|\/)__MACOSX\//.test(x.name));
  const text = all.filter((x) => TEXT_EXT.test(x.name) && x.usize <= 2 * MAX_READ_FILE && !(apk && (x.name === 'AndroidManifest.xml' || /^(res|META-INF)\//.test(x.name)))).sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length);
  const tree = all.slice(0, 400).map((x) => x.name + (x.usize ? ' (' + x.usize + 'B)' : '')).join('\n') + (all.length > 400 ? '\n… +' + (all.length - 400) + ' aur files' : '');
  let used = 0; const shown = []; let lines = 0;
  for (const en of text) {
    const b = readEntry(buf, en); if (!b) continue; const s = b.toString('utf8'); lines += s.split('\n').length;
    if (used < CONTEXT_CHARS && shown.length < 40) { const piece = s.length > PER_FILE ? s.slice(0, PER_FILE) + '\n… (truncated)' : s; used += piece.length; shown.push('### ' + en.name + '\n' + piece); }
  }
  if (apk) return { files: all.length, textFiles: text.length, lines, apk: true, text: apk.text + '\n\nFILE TREE:\n' + tree + (shown.length ? '\n\nWEB / TEXT FILES INSIDE THE APK:\n' + shown.join('\n\n') : '') };
  return { files: all.length, textFiles: text.length, lines, text: '--- ZIP "' + label + '": ' + all.length + ' files, ~' + lines + ' text lines ---\nFILE TREE:\n' + tree + '\n\nKEY FILES:\n' + shown.join('\n\n') };
}

const IMG_PROMPT = 'You are helping a software engineer who must rebuild / build from this image. First say what it is (app screenshot, UI mockup, hand-drawn sketch, diagram, whiteboard, document, photo). Then describe it precisely and completely: layout and sections, every visible component and its text, colours (hex guesses), typography, spacing, icons, states, navigation and likely interactions / data flow; for diagrams list entities and relationships; for documents transcribe the important text. End with a bullet list "IMPLIED REQUIREMENTS". Plain text, max 3500 characters, no preamble.';

/**
 * attachments: [{name, mime?, b64}]; llm = require('./llm-text')
 * -> { context, notes[], images, zips, ok }
 */
async function parseAttachments(list, llm) {
  const notes = []; const ctx = []; let images = 0, zips = 0; const imgs = [];
  for (const a of (Array.isArray(list) ? list : []).slice(0, 8)) {
    const name = String((a && a.name) || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 80);
    let buf; try { buf = Buffer.from(String((a && (a.b64 || a.data)) || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch (e) { buf = null; }
    if (!buf || !buf.length) { notes.push(name + ': khaali file'); continue; }
    if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50 || (buf.length > 22 && /\.zip$/i.test(name))) {
      if (buf.length > MAX_ZIP) { notes.push(name + ': ZIP ' + (MAX_ZIP >> 20) + 'MB se badi hai'); continue; }
      try { const z = summariseZip(buf, name); zips++; ctx.push(z.text); notes.push((z.apk ? 'APK padhi: ' : 'ZIP padhi: ') + name + ' (' + z.files + ' files, ~' + z.lines + ' lines)'); } catch (e) { notes.push(name + ': ' + e.message); }
      continue;
    }
    const mime = isImage(buf);
    if (mime) {
      if (buf.length > MAX_IMG) { notes.push(name + ': photo ' + (MAX_IMG >> 20) + 'MB se badi hai'); continue; }
      if (imgs.length < MAX_IMAGES) imgs.push({ name, mime, b64: buf.toString('base64') });
      continue;
    }
    if (TEXT_EXT.test(name) && buf.length <= 400 * 1024) { ctx.push('--- FILE "' + name + '" ---\n' + buf.toString('utf8').slice(0, 9000)); notes.push('File padhi: ' + name); continue; }
    notes.push(name + ': ye type support nahi (ZIP, photo ya text/code file do)');
  }
  if (imgs.length) {
    try {
      const d = await llm.vision(IMG_PROMPT + '\nImages attached: ' + imgs.map((i) => i.name).join(', '), imgs, { maxTokens: 5000 });
      images = imgs.length; ctx.push('--- PHOTO / SCREENSHOT ANALYSIS (' + imgs.map((i) => i.name).join(', ') + ') ---\n' + String(d).slice(0, 5000)); notes.push('Photo dekhi: ' + images);
    } catch (e) { notes.push('Photo samajh nahi paayi: ' + String(e.message).slice(0, 100)); }
  }
  return { context: ctx.join('\n\n').slice(0, CONTEXT_CHARS + 6000), notes, images, zips, ok: ctx.length > 0 };
}
module.exports = { parseAxml, isApk, parseAttachments, summariseZip, zipEntries, isImage, MAX_ZIP, MAX_IMG, MAX_IMAGES };
