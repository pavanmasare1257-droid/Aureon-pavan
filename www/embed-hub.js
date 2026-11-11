/* Aureon - "Ava on my website" (v47). Create a site here, copy ONE line of code, paste it into any website / HTML file and a small Ava
   bubble appears there (full-screen chat on phones). Needs app.js globals: state (user, backendUrl) and authHeaders().
   Texts follow Settings > English interface. */
(function () {
  function isEn() { try { return localStorage.getItem('aureon_ui_en') !== '0'; } catch (e) { return true; } }
  function E(en, hi) { return isEn() ? en : hi; }
  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  async function api(method, path, body) {
    var res = await fetch(base() + '/api/embed' + path, { method: method, headers: await authHeaders(), body: body ? JSON.stringify(body) : undefined });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(j.error || ('Server error (' + res.status + ')'));
    return j;
  }
  function snippet(key) { return '<script src="' + base() + '/embed/ava.js" data-key="' + key + '"></script>'; }

  var CARD = 'border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:12px;margin:10px 12px;background:rgba(255,255,255,.04)';
  var FIELD = 'width:100%;box-sizing:border-box;background:#0d0d1c;color:#eee;border:1px solid rgba(255,255,255,.2);border-radius:10px;padding:10px;font-size:15px;font-family:inherit';
  var COLORS = ['#5b8cff', '#8a5cff', '#00b894', '#ff6b81', '#ff9f1a', '#222b45'];
  var ov = null;

  function button(label, fn, primary, danger) {
    var b = el('button', 'border:1px solid ' + (danger ? 'rgba(255,120,120,.6)' : 'rgba(255,255,255,.25)') + ';background:' + (primary ? 'linear-gradient(135deg,#6d5efc,#22b8e6)' : 'transparent') + ';color:' + (danger ? '#ff9a9a' : '#fff') + ';border-radius:10px;padding:9px 14px;font-size:14px;min-height:38px;font-family:inherit', label);
    b.type = 'button'; b.addEventListener('click', function () { fn(b); }); return b;
  }
  function label(text) { return el('div', 'font-size:13px;opacity:.8;margin:12px 0 4px', text); }

  function open() {
    if (typeof state === 'undefined' || !state.user) { if (typeof addMessage === 'function') addMessage('ai', E('Please sign in first.', 'Pehle sign in karo.')); return; }
    if (ov) ov.remove();
    ov = el('div', 'position:fixed;inset:0;z-index:99990;background:var(--bg,#0b0b14);color:var(--text,#eee);display:flex;flex-direction:column;padding-top:var(--safe-top,0px);font-family:inherit');
    document.body.appendChild(ov); showList();
  }
  function close() { if (ov) ov.remove(); ov = null; }
  function shell(title, backFn) {
    ov.textContent = '';
    var bar = el('div', 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1)');
    bar.appendChild(button(backFn ? E('Back', 'Back') : E('Close', 'Close'), backFn || close)); bar.appendChild(el('b', 'flex:1;font-size:16px', title)); ov.appendChild(bar);
    var body = el('div', 'flex:1;overflow:auto;padding-bottom:60px'); ov.appendChild(body); return body;
  }

  async function showList() {
    var body = shell(E('Ava on my website', 'Ava on my website'));
    var intro = el('div', CARD);
    intro.appendChild(el('div', 'font-size:14px;line-height:1.55', E('Put a small Ava bubble on your own website or HTML file. Visitors tap her and chat; she answers only from the notes you write here. Create a site, copy the code and paste it before </body> on your page.', 'Apni website ya HTML file par chhota Ava bubble lagao. Visitors usse baat karte hain, aur wo sirf tumhare likhe notes se jawab deti hai. Site banao, code copy karo aur apne page me </body> se pehle paste karo.')));
    body.appendChild(intro);
    body.appendChild(button(E('+ New website', '+ Nayi website'), function () { showForm(null); }, true));
    body.lastChild.style.margin = '4px 12px 8px';
    var listBox = el('div'); body.appendChild(listBox); listBox.appendChild(el('div', 'padding:12px;opacity:.7;font-size:13px', E('Loading...', 'Ho raha hai...')));
    try {
      var j = await api('GET', '/sites'); listBox.textContent = '';
      if (!j.sites.length) listBox.appendChild(el('div', 'padding:12px;opacity:.7;font-size:13px', E('No websites yet.', 'Abhi koi website nahi.')));
      j.sites.forEach(function (s) {
        var c = el('div', CARD + ';cursor:pointer');
        c.appendChild(el('div', 'font-weight:600', s.name + (s.enabled ? '' : E('  (off)', '  (off)'))));
        c.appendChild(el('div', 'font-size:12px;opacity:.7;margin-top:2px;word-break:break-all', s.origins.join(', ')));
        c.addEventListener('click', function () { showForm(s); }); listBox.appendChild(c);
      });
    } catch (e) { listBox.textContent = ''; listBox.appendChild(el('div', CARD + ';color:#ff9a9a', (e && e.message) || String(e))); }
  }

  function showForm(site) {
    var body = shell(site ? E('Edit website', 'Website edit karo') : E('New website', 'Nayi website'), showList);
    var c = el('div', CARD); body.appendChild(c);
    var st = { color: (site && site.color) || COLORS[0], position: (site && site.position) || 'right' };

    c.appendChild(label(E('Website name', 'Website ka naam')));
    var name = el('input', FIELD); name.value = site ? site.name : ''; name.placeholder = E('for example: My Shop', 'jaise: My Shop'); c.appendChild(name);

    c.appendChild(label(E('Websites allowed to show Ava (one per line)', 'Kin websites par Ava dikhe (ek line me ek)')));
    var origins = el('textarea', FIELD + ';min-height:80px;resize:vertical'); origins.value = site ? site.origins.join('\n') : ''; origins.placeholder = 'https://mysite.com\nhttps://www.mysite.com'; c.appendChild(origins);
    var chip = el('span', 'display:inline-block;margin-top:6px;padding:5px 10px;border:1px solid rgba(255,255,255,.22);border-radius:99px;font-size:12px;cursor:pointer', E('Any website (for testing a local HTML file)', 'Koi bhi website (local HTML file test karne ke liye)'));
    chip.addEventListener('click', function () { origins.value = '*'; }); c.appendChild(chip);
    c.appendChild(el('div', 'font-size:12px;opacity:.65;margin-top:6px;line-height:1.5', E('Use your real address once it works. "Any website" lets other sites use your Ava key and your AI quota (the daily limit still applies).', 'Sahi hone ke baad apna asli address daalo. "Koi bhi website" se dusri sites bhi tumhari key aur AI quota use kar sakti hain (daily limit phir bhi lagti hai).')));

    c.appendChild(label(E('Greeting', 'Greeting')));
    var greet = el('input', FIELD); greet.value = site ? site.greeting : ''; greet.placeholder = E('Hi! I am Ava. Ask me anything about my shop.', 'Hi! I am Ava. Ask me anything about my shop.'); c.appendChild(greet);

    c.appendChild(label(E('Notes: what Ava may tell visitors', 'Notes: Ava visitors ko kya bata sakti hai')));
    var notes = el('textarea', FIELD + ';min-height:150px;resize:vertical'); notes.value = site ? site.notes : '';
    notes.placeholder = E('For example:\nWe are open 10am to 8pm, Monday to Saturday.\nDelivery in the city is free above Rs 500.\nTo order, call 98xxxxxx or email shop@example.com.\nWe do not do refunds after 7 days.', 'Jaise:\nHum subah 10 se raat 8 baje tak khule hain.\n500 se upar city me delivery free hai.\nOrder ke liye 98xxxxxx par call ya shop@example.com par email karo.\n7 din ke baad refund nahi hota.');
    c.appendChild(notes);
    c.appendChild(el('div', 'font-size:12px;opacity:.65;margin-top:6px;line-height:1.5', E('She answers only from these notes. Anything else: she says she does not know and suggests contacting you. Never write passwords or private details here, visitors can ask about anything you write.', 'Wo sirf in notes se jawab degi. Baaki sab par bolegi ki pata nahi aur tumse contact karne ko kahegi. Yahan password ya private baat mat likhna, visitors notes me likhi har cheez pooch sakte hain.')));

    c.appendChild(label(E('Color', 'Color')));
    var cw = el('div', 'display:flex;gap:10px;flex-wrap:wrap'); c.appendChild(cw);
    function paintColors() { cw.textContent = ''; COLORS.forEach(function (col) { var d = el('div', 'width:34px;height:34px;border-radius:50%;cursor:pointer;background:' + col + ';border:3px solid ' + (st.color === col ? '#fff' : 'transparent')); d.addEventListener('click', function () { st.color = col; paintColors(); }); cw.appendChild(d); }); }
    paintColors();

    c.appendChild(label(E('Position on the page', 'Page par jagah')));
    var pw = el('div', 'display:flex;gap:8px'); c.appendChild(pw);
    function paintPos() { pw.textContent = ''; ['left', 'right'].forEach(function (p) { var b = button(p === 'left' ? E('Bottom left', 'Neeche left') : E('Bottom right', 'Neeche right'), function () { st.position = p; paintPos(); }, st.position === p); pw.appendChild(b); }); }
    paintPos();

    c.appendChild(label(E('Messages allowed per day (all visitors together)', 'Ek din me kitne messages (saare visitors mila ke)')));
    var cap = el('input', FIELD); cap.type = 'number'; cap.min = '10'; cap.max = '5000'; cap.value = String(site ? site.dailyCap : 300); c.appendChild(cap);

    var enRow = el('label', 'display:flex;gap:10px;align-items:center;margin-top:12px;font-size:14px;cursor:pointer');
    var en = el('input', 'width:20px;height:20px'); en.type = 'checkbox'; en.checked = site ? site.enabled !== false : true; enRow.appendChild(en); enRow.appendChild(el('span', null, E('Ava is switched on', 'Ava chalu hai'))); c.appendChild(enRow);

    var msg = el('div', 'font-size:13px;min-height:18px;margin-top:10px;line-height:1.5'); var codeBox = el('div');
    var row = el('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px'); c.appendChild(row); c.appendChild(msg); body.appendChild(codeBox);

    function showCode(s) {
      codeBox.textContent = ''; var cc = el('div', CARD); codeBox.appendChild(cc);
      cc.appendChild(el('div', 'font-weight:600;margin-bottom:6px', E('Your code', 'Tumhara code')));
      cc.appendChild(el('div', 'font-size:12px;opacity:.7;margin-bottom:6px;line-height:1.5', E('Paste this line just before </body> on every page where Ava should appear.', 'Ye line jis page par Ava dikhani hai uske </body> se pehle paste karo.')));
      var ta = el('textarea', FIELD + ';min-height:72px;font-family:monospace;font-size:12px'); ta.readOnly = true; ta.value = snippet(s.key); cc.appendChild(ta);
      var r = el('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px'); cc.appendChild(r);
      r.appendChild(button(E('Copy code', 'Code copy karo'), async function (b) {
        try { await navigator.clipboard.writeText(ta.value); b.textContent = E('Copied', 'Copy ho gaya'); } catch (e) { ta.focus(); ta.select(); b.textContent = E('Select and copy it', 'Select karke copy karo'); }
      }, true));
      r.appendChild(button(E('Open test page', 'Test page kholo'), function () { window.open(base() + '/embed/demo?key=' + s.key, '_blank'); }));
    }

    row.appendChild(button(E('Save', 'Save karo'), async function (b) {
      b.disabled = true; msg.style.color = ''; msg.textContent = E('Saving...', 'Save ho raha hai...');
      try {
        var j = await api('POST', '/sites', { key: site ? site.key : undefined, name: name.value, origins: origins.value, greeting: greet.value, notes: notes.value, color: st.color, position: st.position, dailyCap: cap.value, enabled: en.checked });
        site = j.site; msg.style.color = '#7ee2a8'; msg.textContent = E('Saved. Copy the code below.', 'Save ho gaya. Neeche se code copy karo.'); showCode(site);
      } catch (e) { msg.style.color = '#ff8a8a'; msg.textContent = (e && e.message) || String(e); }
      b.disabled = false;
    }, true));
    if (site) {
      row.appendChild(button(E('Delete', 'Delete'), async function (b) {
        if (!window.confirm(E('Delete this website? Ava will disappear from it.', 'Ye website delete karni hai? Wahan se Ava hat jayegi.'))) return;
        b.disabled = true; try { await api('DELETE', '/sites/' + site.key); showList(); } catch (e) { b.disabled = false; msg.style.color = '#ff8a8a'; msg.textContent = (e && e.message) || String(e); }
      }, false, true));
      showCode(site);
    }
  }

  function wire() { var b = document.getElementById('embed-open-row'); if (b && !b._w) { b._w = 1; b.addEventListener('click', open); } }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
  window.AureonEmbed = { open: open };
})();
