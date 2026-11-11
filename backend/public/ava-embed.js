/* Ava for websites. Add ONE line to any page (or HTML file):
 *   <script src="https://YOUR-BACKEND/embed/ava.js" data-key="avs_xxxxxxxxxxxxxxxxxx"></script>
 * Optional attributes: data-position="left|right"  data-color="#5b8cff"  data-open="1" (open at once)
 * Self-contained, no libraries. Lives in a Shadow DOM so the page's CSS can't break it. On phones the chat opens full-screen. */
(function () {
  'use strict';
  if (window.__AVA_EMBED__) return;
  var script = document.currentScript || (function () { var s = document.getElementsByTagName('script'); return s[s.length - 1]; })();
  var KEY = script && script.getAttribute('data-key');
  var HOST = ''; try { HOST = new URL(script.src, location.href).origin; } catch (e) { /* no host */ }
  if (!KEY || !HOST) return;
  window.__AVA_EMBED__ = true;

  var SS = 'ava_embed_' + KEY;
  function ssGet(k, d) { try { var v = sessionStorage.getItem(SS + k); return v === null ? d : v; } catch (e) { return d; } }
  function ssSet(k, v) { try { sessionStorage.setItem(SS + k, v); } catch (e) { /* private mode */ } }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(path, opts) { return fetch(HOST + path, opts).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'error'); return j; }); }); }

  var AVA_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true"><defs>'
    + '<radialGradient id="h" cx="38%" cy="30%" r="75%"><stop offset="0" stop-color="#bff1ff"/><stop offset=".45" stop-color="#4fb4ff"/><stop offset="1" stop-color="#3b5bff"/></radialGradient>'
    + '<linearGradient id="r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6ad5"/><stop offset="1" stop-color="#8a6bff"/></linearGradient></defs>'
    + '<ellipse cx="50" cy="19" rx="24" ry="4.5" fill="none" stroke="#8fdcff" stroke-width="1.6" opacity=".9"/>'
    + '<line x1="50" y1="23" x2="50" y2="14" stroke="#c9a8ff" stroke-width="2"/><circle cx="50" cy="11" r="4" fill="#ff8fe3"/>'
    + '<circle cx="50" cy="57" r="33" fill="url(#h)" stroke="url(#r)" stroke-width="3"/>'
    + '<ellipse cx="50" cy="57" rx="24" ry="16" fill="#0a1430"/>'
    + '<ellipse cx="41.5" cy="54" rx="4" ry="6.5" fill="#7ff3ff"/><ellipse cx="58.5" cy="54" rx="4" ry="6.5" fill="#7ff3ff"/>'
    + '<path d="M44 64 Q50 69 56 64" fill="none" stroke="#7ff3ff" stroke-width="2.2" stroke-linecap="round"/>'
    + '<rect x="8" y="46" width="9" height="22" rx="4.5" fill="#b86bff" stroke="#ff9be6" stroke-width="1.5"/><rect x="83" y="46" width="9" height="22" rx="4.5" fill="#b86bff" stroke="#ff9be6" stroke-width="1.5"/></svg>';

  var CSS = ':host{all:initial}*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}'
    + '.wrap{position:fixed;bottom:16px;z-index:2147483646;--c:#5b8cff;color:#1b2033}.wrap.right{right:16px}.wrap.left{left:16px}'
    + '.orb{width:64px;height:64px;border:0;padding:0;border-radius:50%;background:radial-gradient(circle at 35% 30%,#2a3b7a,#0d1431);box-shadow:0 8px 24px rgba(20,30,80,.45),0 0 0 2px rgba(255,255,255,.15) inset;cursor:pointer;display:block;animation:float 3.2s ease-in-out infinite;-webkit-tap-highlight-color:transparent}'
    + '.orb svg{width:100%;height:100%;display:block}.orb:focus-visible{outline:3px solid #fff;outline-offset:2px}'
    + '@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}@media (prefers-reduced-motion:reduce){.orb{animation:none}}'
    + '.tip{position:absolute;bottom:76px;max-width:240px;background:#fff;color:#1b2033;padding:10px 12px;border-radius:14px;font-size:14px;line-height:1.4;box-shadow:0 8px 24px rgba(0,0,0,.2);cursor:pointer}'
    + '.right .tip{right:0}.left .tip{left:0}.tip[hidden]{display:none}'
    + '.panel{position:absolute;bottom:76px;width:360px;height:min(540px,calc(100vh - 110px));background:#fff;border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden}'
    + '.right .panel{right:0}.left .panel{left:0}.open .panel{display:flex}'
    + '.head{display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--c);color:#fff}.head .av{width:34px;height:34px;border-radius:50%;background:#0d1431;flex:none}.head .av svg{width:100%;height:100%;display:block}'
    + '.head .t{flex:1;min-width:0}.head .n{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.head .s{font-size:12px;opacity:.9}'
    + '.x{border:0;background:rgba(255,255,255,.2);color:#fff;width:34px;height:34px;border-radius:50%;font-size:20px;line-height:1;cursor:pointer}'
    + '.msgs{flex:1;overflow-y:auto;padding:14px;background:#f5f6fb;display:flex;flex-direction:column;gap:8px;-webkit-overflow-scrolling:touch}'
    + '.m{max-width:84%;padding:9px 12px;border-radius:14px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}'
    + '.m.ava{align-self:flex-start;background:#fff;border:1px solid #e3e6f2;border-bottom-left-radius:4px}.m.me{align-self:flex-end;background:var(--c);color:#fff;border-bottom-right-radius:4px}.m.err{align-self:center;background:#fdecec;color:#9a1f1f;font-size:13px}'
    + '.m a{color:inherit;text-decoration:underline}.dots{align-self:flex-start;background:#fff;border:1px solid #e3e6f2;border-radius:14px;padding:10px 14px;display:flex;gap:4px}'
    + '.dots i{width:7px;height:7px;border-radius:50%;background:#9aa3c7;animation:b 1s infinite}.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}@keyframes b{0%,60%,100%{opacity:.3}30%{opacity:1}}'
    + '.in{display:flex;gap:8px;padding:10px;border-top:1px solid #e6e8f2;background:#fff}.in textarea{flex:1;resize:none;border:1px solid #d5d9ea;border-radius:12px;padding:10px 12px;font-size:16px;line-height:1.3;max-height:96px;outline:none;color:#1b2033;background:#fff}'
    + '.in textarea:focus{border-color:var(--c)}.send{border:0;background:var(--c);color:#fff;border-radius:12px;padding:0 16px;font-size:15px;font-weight:600;cursor:pointer}.send[disabled]{opacity:.55;cursor:default}'
    + '.pow{text-align:center;font-size:11px;color:#8a90ad;padding:0 0 8px;background:#fff}'
    + '@media (max-width:520px){.wrap{bottom:calc(14px + env(safe-area-inset-bottom,0px))}.wrap.right{right:14px}.wrap.left{left:14px}'
    + '.open.wrap{inset:0;bottom:0}.open .orb,.open .tip{display:none}.open .panel{position:fixed;left:0;right:0;top:0;bottom:0;width:auto;height:auto;border-radius:0}'
    + '.head{padding-top:calc(12px + env(safe-area-inset-top,0px))}.in{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}}';

  var cfg = null, hist = [], busy = false, root, wrap, panel, msgs, input, sendBtn, tip, prevOverflow = null;
  try { hist = JSON.parse(ssGet('_h', '[]')) || []; } catch (e) { hist = []; }

  function linkify(parent, text) {
    var re = /(https?:\/\/[^\s<>"')]+)/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = el('a', null, m[1]); a.href = m[1]; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.appendChild(a);
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function addMsg(role, text) {
    var d = el('div', 'm ' + role); linkify(d, text); msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d;
  }
  function save() { ssSet('_h', JSON.stringify(hist.slice(-20))); }

  function send() {
    var text = input.value.replace(/\s+/g, ' ').trim();
    if (!text || busy) return;
    input.value = ''; input.style.height = 'auto';
    addMsg('me', text); hist.push({ role: 'user', text: text }); save();
    busy = true; sendBtn.disabled = true;
    var dots = el('div', 'dots'); dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i')); msgs.appendChild(dots); msgs.scrollTop = msgs.scrollHeight;
    api('/api/embed/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, message: text, history: hist.slice(-9, -1), page: { title: document.title, url: location.href } }),
    }).then(function (j) { dots.remove(); addMsg('ava', j.reply); hist.push({ role: 'ava', text: j.reply }); save(); })
      .catch(function (e) { dots.remove(); addMsg('err', e && e.message && e.message !== 'error' && e.message !== 'Failed to fetch' ? e.message : 'Ava is resting right now. Please try again in a moment.'); })
      .then(function () { busy = false; sendBtn.disabled = false; if (window.matchMedia && matchMedia('(hover:hover)').matches) input.focus(); });
  }

  function isPhone() { return window.matchMedia && matchMedia('(max-width:520px)').matches; }
  function fitToViewport() {   // keeps the input above the phone keyboard
    if (!wrap.classList.contains('open') || !isPhone() || !window.visualViewport) { panel.style.height = ''; panel.style.top = ''; panel.style.bottom = ''; return; }
    var vv = window.visualViewport; panel.style.top = vv.offsetTop + 'px'; panel.style.bottom = 'auto'; panel.style.height = vv.height + 'px';
  }
  function open() {
    if (wrap.classList.contains('open')) return;
    wrap.classList.add('open'); tip.hidden = true; ssSet('_tip', '1');
    if (isPhone()) { prevOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden'; }
    if (!msgs.children.length) { addMsg('ava', cfg.greeting); hist.length || hist.push({ role: 'ava', text: cfg.greeting }); }
    fitToViewport(); msgs.scrollTop = msgs.scrollHeight;
    if (!isPhone()) setTimeout(function () { input.focus(); }, 50);
  }
  function close() {
    wrap.classList.remove('open'); fitToViewport();
    if (prevOverflow !== null) { document.documentElement.style.overflow = prevOverflow; prevOverflow = null; }
  }

  function build() {
    var hostEl = document.createElement('div'); hostEl.id = 'ava-embed-host'; document.body.appendChild(hostEl);
    root = hostEl.attachShadow ? hostEl.attachShadow({ mode: 'open' }) : hostEl;
    var style = document.createElement('style'); style.textContent = CSS; root.appendChild(style);
    var pos = (script.getAttribute('data-position') || cfg.position) === 'left' ? 'left' : 'right';
    var color = script.getAttribute('data-color'); color = /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : (cfg.color || '#5b8cff');
    wrap = el('div', 'wrap ' + pos); wrap.style.setProperty('--c', color); root.appendChild(wrap);

    tip = el('div', 'tip'); tip.hidden = true; tip.textContent = cfg.greeting; tip.addEventListener('click', open); wrap.appendChild(tip);
    panel = el('div', 'panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat with Ava'); wrap.appendChild(panel);
    var head = el('div', 'head'), av = el('div', 'av'); av.innerHTML = AVA_SVG; head.appendChild(av);
    var t = el('div', 't'); t.appendChild(el('div', 'n', 'Ava')); t.appendChild(el('div', 's', 'AI assistant for ' + cfg.name)); head.appendChild(t);
    var x = el('button', 'x', '\u00d7'); x.type = 'button'; x.setAttribute('aria-label', 'Close chat'); x.addEventListener('click', close); head.appendChild(x); panel.appendChild(head);
    msgs = el('div', 'msgs'); msgs.setAttribute('aria-live', 'polite'); panel.appendChild(msgs);
    hist.forEach(function (h) { addMsg(h.role === 'ava' ? 'ava' : 'me', h.text); });
    var bar = el('div', 'in'); input = el('textarea'); input.rows = 1; input.placeholder = 'Type your message...'; input.maxLength = 600; input.setAttribute('aria-label', 'Your message');
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(96, input.scrollHeight) + 'px'; });
    sendBtn = el('button', 'send', 'Send'); sendBtn.type = 'button'; sendBtn.addEventListener('click', send);
    bar.appendChild(input); bar.appendChild(sendBtn); panel.appendChild(bar); panel.appendChild(el('div', 'pow', 'Powered by Ava \u00b7 AI can make mistakes'));

    var orb = el('button', 'orb'); orb.type = 'button'; orb.setAttribute('aria-label', 'Chat with Ava'); orb.innerHTML = AVA_SVG;
    orb.addEventListener('click', function () { wrap.classList.contains('open') ? close() : open(); }); wrap.appendChild(orb);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    if (window.visualViewport) { visualViewport.addEventListener('resize', fitToViewport); visualViewport.addEventListener('scroll', fitToViewport); }
    window.addEventListener('resize', fitToViewport);

    if (script.getAttribute('data-open') === '1') open();
    else if (ssGet('_tip', '0') !== '1') setTimeout(function () { if (!wrap.classList.contains('open')) { tip.hidden = false; setTimeout(function () { tip.hidden = true; }, 9000); } }, 1800);
    window.AvaEmbed = { open: open, close: close };
  }

  function start() {
    api('/api/embed/config?key=' + encodeURIComponent(KEY)).then(function (c) { cfg = c; build(); }).catch(function () { /* not allowed here or switched off: stay invisible */ });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
