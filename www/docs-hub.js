/* Aureon — Docs (v35). Ava writes a document, you click anywhere and edit it yourself, select any line and tell Ava what to change
   (like a comment), and download it as Word or PDF. Docs are stored on this phone (localStorage); the server only does the AI + PDF.
   Needs app.js globals: state (backendUrl, user), authHeaders(). Server HTML is sanitized on the server; the editor only ever pastes plain text. */
(function () {
  var KEY = 'aureon_docs_v1';
  var $ = function (id) { return document.getElementById(id); };
  var ov = null, cur = null, ed = null, lastRange = null, busy = false, saveT = 0;

  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  function toast(t) { var d = el('div', 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:12px;font-size:13px;z-index:100001;max-width:86vw;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.4)', t); document.body.appendChild(d); setTimeout(function () { d.remove(); }, 2600); }
  function load() { try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function store(a) { try { localStorage.setItem(KEY, JSON.stringify(a.slice(0, 60))); } catch (e) { toast('Phone me jagah kam hai — kuch purane docs delete karo'); } }
  function upsert(d) { var a = load().filter(function (x) { return x.id !== d.id; }); a.unshift(d); store(a); }
  function plainText(h) { var t = document.createElement('div'); t.innerHTML = h || ''; return (t.textContent || '').replace(/\s+/g, ' ').trim(); }
  function uid() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  async function api(path, body) {
    if (typeof state === 'undefined' || !state.user) throw new Error('Pehle sign in karo');
    var res = await fetch(base() + '/api/docs' + path, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(j.error || ('Server error (' + res.status + ')'));
    return j;
  }
  async function saveFile(filename, b64, mime) {
    var C = window.Capacitor, native = C && C.isNativePlatform && C.isNativePlatform();
    if (native && C.Plugins && C.Plugins.Filesystem) {
      var w = await C.Plugins.Filesystem.writeFile({ path: filename, data: b64, directory: 'CACHE', recursive: true });
      if (C.Plugins.Share) { try { await C.Plugins.Share.share({ title: filename, url: w.uri }); } catch (e) { if (String((e && e.message) || e).toLowerCase().indexOf('cancel') < 0) throw e; } }
      else toast('File ban gayi: ' + filename);
    } else {
      var a = document.createElement('a'); a.href = 'data:' + mime + ';base64,' + b64; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    }
  }

  /* ---------------- styles ---------------- */
  function css() {
    if ($('docs-css')) return;
    var s = document.createElement('style'); s.id = 'docs-css';
    s.textContent = '#docs-ov{position:fixed;inset:0;z-index:99990;background:var(--bg,#0b0b14);color:var(--text,#eee);display:flex;flex-direction:column;padding-top:var(--safe-top,0px);font-family:inherit}'
      + '#docs-ov .dbar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.1);flex-wrap:wrap}'
      + '#docs-ov .dbtn{background:none;border:1px solid rgba(255,255,255,.22);color:inherit;border-radius:10px;padding:7px 11px;font-size:13px;min-height:36px}'
      + '#docs-ov .dbtn.pri{background:linear-gradient(135deg,#6d5efc,#22b8e6);border-color:transparent;color:#fff;font-weight:600}'
      + '#docs-ov .dbtn[disabled]{opacity:.5}'
      + '#docs-paper{flex:1;overflow:auto;padding:14px 10px 120px}'
      + '#docs-doc{background:#fff;color:#161616;max-width:760px;margin:0 auto;padding:22px 18px;border-radius:6px;min-height:60vh;outline:none;font-size:16px;line-height:1.55;word-wrap:break-word}'
      + '#docs-doc h1{font-size:26px;margin:.2em 0 .4em}#docs-doc h2{font-size:20px;margin:1em 0 .3em}#docs-doc h3{font-size:17px;margin:.8em 0 .3em}'
      + '#docs-doc p{margin:.45em 0}#docs-doc ul,#docs-doc ol{margin:.4em 0;padding-left:1.4em}#docs-doc table{border-collapse:collapse;width:100%}#docs-doc td,#docs-doc th{border:1px solid #bbb;padding:4px 6px}'
      + '#docs-doc a{color:#1a56db}#docs-doc .dflash{background:#d6f5e0;transition:background 1.4s}'
      + '#docs-sheet{position:fixed;left:0;right:0;bottom:0;z-index:99995;background:#15152a;border-top:1px solid rgba(255,255,255,.18);border-radius:18px 18px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 30px rgba(0,0,0,.5)}'
      + '#docs-sheet textarea{width:100%;box-sizing:border-box;background:#0d0d1c;color:#eee;border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:10px;font-size:15px;min-height:72px;resize:vertical}'
      + '#docs-sheet .chip{display:inline-block;margin:4px 6px 0 0;padding:5px 10px;border:1px solid rgba(255,255,255,.2);border-radius:99px;font-size:12px;cursor:pointer}'
      + '#docs-ov .drow{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid rgba(255,255,255,.12);border-radius:12px;margin:8px 10px}';
    document.head.appendChild(s);
  }

  /* ---------------- shell ---------------- */
  function open() {
    if (typeof state === 'undefined' || !state.user) { toast('Pehle sign in karo'); return; }
    css(); if (ov) ov.remove();
    ov = el('div'); ov.id = 'docs-ov'; document.body.appendChild(ov); showList();
  }
  function close() { clearTimeout(saveT); flush(); closeSheet(); if (ov) ov.remove(); ov = null; ed = null; cur = null; }
  function btn(label, fn, cls) {
    var b = el('button', null, label); b.className = 'dbtn' + (cls ? ' ' + cls : ''); b.type = 'button';
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the text selection while tapping toolbar buttons
    b.addEventListener('click', function (e) { e.preventDefault(); fn(b); }); return b;
  }

  /* ---------------- list ---------------- */
  function showList() {
    flush(); closeSheet(); cur = null; ed = null; ov.textContent = '';
    var bar = el('div'); bar.className = 'dbar';
    bar.appendChild(btn('✕', close)); bar.appendChild(el('b', 'flex:1;font-size:16px', '📄 Docs'));
    bar.appendChild(btn('✨ Naya doc', newDocSheet, 'pri')); ov.appendChild(bar);
    var wrap = el('div', 'flex:1;overflow:auto;padding-bottom:40px'); ov.appendChild(wrap);
    var docs = load();
    if (!docs.length) wrap.appendChild(el('div', 'padding:40px 24px;text-align:center;opacity:.75;line-height:1.6', 'Abhi koi doc nahi. "Naya doc" dabao, bolo kya chahiye (resume, letter, report…) — Ava likh degi, phir tum khud kahin bhi click karke edit kar sakte ho.'));
    docs.forEach(function (d) {
      var row = el('div'); row.className = 'drow';
      var t = el('div', 'flex:1;min-width:0;cursor:pointer');
      t.appendChild(el('div', 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', d.title || 'Bina naam'));
      t.appendChild(el('div', 'font-size:12px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', new Date(d.updatedAt || 0).toLocaleString() + ' · ' + plainText(d.html).slice(0, 70)));
      t.addEventListener('click', function () { openDoc(d.id); }); row.appendChild(t);
      row.appendChild(btn('🗑', function () { if (!window.confirm('Ye doc delete karu?')) return; store(load().filter(function (x) { return x.id !== d.id; })); showList(); }));
      wrap.appendChild(row);
    });
  }

  /* ---------------- bottom sheet ---------------- */
  function closeSheet() { var s = $('docs-sheet'); if (s) s.remove(); }
  function sheet(title, placeholder, chips, okLabel, onOk, extra) {
    closeSheet(); var s = el('div'); s.id = 'docs-sheet';
    s.appendChild(el('div', 'font-weight:600;margin-bottom:8px', title));
    var ta = el('textarea'); ta.placeholder = placeholder; s.appendChild(ta);
    var cw = el('div', 'margin:4px 0 8px');
    (chips || []).forEach(function (c) { var x = el('span', null, c); x.className = 'chip'; x.addEventListener('click', function () { ta.value = c; ta.focus(); }); cw.appendChild(x); });
    s.appendChild(cw);
    var msg = el('div', 'font-size:12px;min-height:16px;margin-bottom:6px;opacity:.85'); s.appendChild(msg);
    var row = el('div', 'display:flex;gap:8px');
    var cancel = btn('Raho', closeSheet); var ok = btn(okLabel, function () {
      var v = ta.value.trim(); if (v.length < 3) { msg.textContent = 'Thoda likho'; return; }
      busy = true; ok.disabled = true; cancel.disabled = true; msg.style.color = ''; msg.textContent = '⏳ Ava likh rahi hai… (10-40 sec)';
      Promise.resolve(onOk(v)).then(function () { busy = false; closeSheet(); }).catch(function (e) { busy = false; ok.disabled = false; cancel.disabled = false; msg.style.color = '#ff8a8a'; msg.textContent = '⚠ ' + String((e && e.message) || e); });
    }, 'pri');
    row.appendChild(cancel); row.appendChild(ok); s.appendChild(row); (extra || ov).appendChild(s); setTimeout(function () { ta.focus(); }, 80);
  }

  function newDocSheet() {
    sheet('Kis ke baare me doc banana hai?', 'Jaise: mera resume, Python developer fresher, 2 projects… ya: leave application 3 din ki', ['Mera resume', 'Application letter', 'Project report', 'Meeting notes'], 'Likho ✨', function (v) {
      return api('/ai', { mode: 'generate', prompt: v }).then(function (r) {
        var d = { id: uid(), title: r.title || 'Naya doc', html: r.html, updatedAt: Date.now() }; upsert(d); openDoc(d.id);
      });
    });
  }

  /* ---------------- editor ---------------- */
  function openDoc(id) {
    var d = load().filter(function (x) { return x.id === id; })[0]; if (!d) return showList();
    cur = d; closeSheet(); ov.textContent = '';
    var bar = el('div'); bar.className = 'dbar';
    bar.appendChild(btn('←', showList));
    var ti = el('input', 'flex:1;min-width:80px;background:none;border:none;color:inherit;font-size:15px;font-weight:600;outline:none'); ti.value = d.title || ''; ti.placeholder = 'Doc ka naam';
    ti.addEventListener('input', function () { cur.title = ti.value; queueSave(); }); bar.appendChild(ti);
    bar.appendChild(btn('⬇ Download', downloadSheet)); ov.appendChild(bar);
    var tools = el('div'); tools.className = 'dbar';
    tools.appendChild(btn('B', function () { fmt('bold'); })); tools.appendChild(btn('I', function () { fmt('italic'); })); tools.appendChild(btn('U', function () { fmt('underline'); }));
    tools.appendChild(btn('H', function () { fmt('formatBlock', 'h2'); })); tools.appendChild(btn('¶', function () { fmt('formatBlock', 'p'); }));
    tools.appendChild(btn('• List', function () { fmt('insertUnorderedList'); })); tools.appendChild(btn('↶', function () { fmt('undo'); })); tools.appendChild(btn('↷', function () { fmt('redo'); }));
    tools.appendChild(btn('💬 Ava ko batao', askAboutSelection, 'pri')); tools.appendChild(btn('📝 Poora doc', askWholeDoc)); ov.appendChild(tools);
    var paper = el('div'); paper.id = 'docs-paper'; ed = el('div'); ed.id = 'docs-doc'; ed.contentEditable = 'true'; ed.spellcheck = true; ed.innerHTML = d.html || '<p><br></p>';
    paper.appendChild(ed); ov.appendChild(paper);
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* ok */ }
    ed.addEventListener('input', queueSave);
    ed.addEventListener('paste', function (e) { e.preventDefault(); var t = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, t); });
  }
  document.addEventListener('selectionchange', function () {
    if (!ed) return; var s = window.getSelection(); if (s && s.rangeCount && ed.contains(s.anchorNode)) lastRange = s.getRangeAt(0).cloneRange();
  });
  function restore() { if (!ed) return null; ed.focus(); var s = window.getSelection(); s.removeAllRanges(); if (lastRange && ed.contains(lastRange.commonAncestorContainer)) s.addRange(lastRange); return s; }
  function fmt(cmd, val) { restore(); try { document.execCommand(cmd, false, val || null); } catch (e) { /* ignore */ } queueSave(); }
  function queueSave() { clearTimeout(saveT); saveT = setTimeout(flush, 500); }
  function flush() { clearTimeout(saveT); if (!cur || !ed) return; cur.html = ed.innerHTML; cur.updatedAt = Date.now(); if (!cur.title) cur.title = plainText((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(cur.html) || [])[1] || '').slice(0, 80) || 'Bina naam'; upsert(cur); }

  function blockOf(node) {
    while (node && node !== ed) { if (node.nodeType === 1 && /^(P|LI|H1|H2|H3|BLOCKQUOTE|TD|TH|DIV)$/.test(node.nodeName)) return node; node = node.parentNode; }
    return null;
  }
  function askAboutSelection() {
    var s = restore(); if (!s || !s.rangeCount) { toast('Pehle doc me koi line ya hissa chuno'); return; }
    var r = s.getRangeAt(0);
    if (r.collapsed) { var b = blockOf(r.startContainer); if (!b) { toast('Line ke andar tap karo ya text chuno'); return; } r = document.createRange(); r.selectNodeContents(b); s.removeAllRanges(); s.addRange(r); }
    var wrap = document.createElement('div'); wrap.appendChild(r.cloneContents()); var selHtml = wrap.innerHTML;
    if (!plainText(selHtml)) { toast('Pehle koi text chuno'); return; }
    var pre = document.createRange(); pre.selectNodeContents(ed); pre.setEnd(r.startContainer, r.startOffset);
    var post = document.createRange(); post.selectNodeContents(ed); post.setStart(r.endContainer, r.endOffset);
    var saved = r.cloneRange(), before = pre.toString().slice(-600), after = post.toString().slice(0, 600);
    sheet('Is hisse me kya badalna hai?  "' + plainText(selHtml).slice(0, 60) + (plainText(selHtml).length > 60 ? '…' : '') + '"', 'Jaise: chhota karo, aur professional banao, ek number jodo, Hinglish me likho', ['Chhota karo', 'Aur professional banao', 'Ek number jodo', 'Grammar theek karo'], 'Badlo ✨', function (v) {
      return api('/ai', { mode: 'rewrite', instruction: v, selection: selHtml, before: before, after: after }).then(function (res) {
        lastRange = saved; var sel = restore(); sel.removeAllRanges(); sel.addRange(saved);
        document.execCommand('insertHTML', false, res.html);   // goes through the browser undo stack, so ↶ brings the old text back
        queueSave(); toast('Badal diya ✓  (↶ se wapas)');
      });
    });
  }
  function askWholeDoc() {
    flush(); sheet('Poore doc me kya badalna hai?', 'Jaise: Hinglish se English me karo, ek skills section jodo, sab kuch chhota karo', ['Poora English me karo', 'Ek skills section jodo', 'Aur chhota karo'], 'Badlo ✨', function (v) {
      return api('/ai', { mode: 'revise', instruction: v, html: ed.innerHTML }).then(function (res) {
        ed.innerHTML = res.html; if (res.title) { cur.title = res.title; var ti = ov.querySelector('input'); if (ti) ti.value = res.title; } queueSave(); toast('Doc badal gaya ✓');
      });
    });
  }

  /* ---------------- download ---------------- */
  function fileName(ext) { return ((cur && cur.title) || 'doc').replace(/[^a-z0-9\u0900-\u097F]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) + '.' + ext; }
  function downloadSheet() {
    flush(); closeSheet(); var s = el('div'); s.id = 'docs-sheet';
    s.appendChild(el('div', 'font-weight:600;margin-bottom:10px', 'Kaise download karna hai?'));
    var msg = el('div', 'font-size:12px;min-height:16px;margin:8px 0;opacity:.85');
    var run = function (fn) { return function () { msg.textContent = '⏳ Ban raha hai…'; Promise.resolve(fn()).then(function () { msg.textContent = ''; closeSheet(); }).catch(function (e) { msg.style.color = '#ff8a8a'; msg.textContent = '⚠ ' + String((e && e.message) || e); }); }; };
    var row = el('div', 'display:flex;gap:8px;flex-wrap:wrap');
    row.appendChild(btn('📘 Word (.doc)', run(function () {
      var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>' + String(cur.title || '').replace(/</g, '') + '</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4}h1{font-size:20pt}h2{font-size:15pt}h3{font-size:12.5pt}table{border-collapse:collapse}td,th{border:1px solid #999;padding:3px 6px}</style></head><body>' + ed.innerHTML + '</body></html>';
      return saveFile(fileName('doc'), btoa(unescape(encodeURIComponent('\ufeff' + html))), 'application/msword');
    }), 'pri'));
    row.appendChild(btn('📕 PDF', run(function () {
      return api('/pdf', { title: cur.title, html: ed.innerHTML }).then(function (r) { return saveFile(r.filename || fileName('pdf'), r.dataBase64, 'application/pdf'); });
    }), 'pri'));
    row.appendChild(btn('Raho', closeSheet));
    s.appendChild(row); s.appendChild(msg); s.appendChild(el('div', 'font-size:11px;opacity:.6', 'PDF me Hindi (Devanagari) akshar nahi aate — Hindi doc ke liye Word lo.')); ov.appendChild(s);
  }

  /* ---------------- wire ---------------- */
  function wire() { var b = $('docs-open-row'); if (b && !b._w) { b._w = 1; b.addEventListener('click', open); } }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
  window.AureonDocs = { open: open };
})();
