/* Aureon — "important mail batao" inside the chat (v53), same hook style as AureonAway / AureonDocs.
   If a typed message clearly asks Ava about the inbox ("important mail batao", "koi urgent mail aaya?", "offer letter aaya kya"),
   Ava reads Gmail (read-only, via the backend) and answers right in the chat. Messages that WRITE / SEND / REPLY are NOT handled here
   (those go through the draft -> Approve flow in Settings > Apps & Automation > Gmail).
   Also re-arms the phone's urgent-mail watcher when the app opens (the alarm can be lost after a force-stop). */
(function () {
  var MAIL = /\b(e-?mails?|mails?|gmail|inbox)\b/i;
  var WRITE = /(likh|write|draft|compose|bhej|send|reply|jawab|forward|delete|hata|spam|unsubscribe)/i;
  var ASKING = /(important|zaroori|zaruri|jaruri|zaroor|urgent|batao|bata\b|bataiye|bolo|dikhao|dikha|dekh|check|padh|read|aaya|aayi|aaye|aya\b|aye\b|hai kya|hain kya|naya|nayi|new|unread|summary|summar|kya hai|any|koi)/i;
  var EVENT = /(offer letter|interview|selection letter|joining letter|admit card|result)/i;
  var CAME = /(aaya|aayi|aaye|aya\b|mila|mili|came|received|aa gaya|aa gayi)/i;

  function isMailQuestion(text) {
    var t = String(text || '').trim();
    if (!t || t.length > 140) return false;
    if (WRITE.test(t)) return false;
    if (MAIL.test(t) && ASKING.test(t)) return true;
    return EVENT.test(t) && CAME.test(t) && /(\?|kya|koi|check|dekh)/i.test(t);
  }
  function base() { return String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, ''); }
  function plugin() { var C = window.Capacitor; return C && C.Plugins && C.Plugins.AureonActions; }
  var URG = { high: '🔴', medium: '🟡', low: '⚪' };

  function format(j) {
    var lines = [];
    if (j.summary) lines.push(j.summary);
    (j.items || []).slice(0, 6).forEach(function (m) {
      lines.push('• ' + (URG[m.urgency] || '🟡') + ' ' + m.subject + ' — ' + m.from + (m.why ? ' (' + m.why + ')' : ''));
    });
    if (!(j.items || []).length) lines.push('Abhi koi zaroori mail nahi hai.');
    else lines.push('\nReply draft chahiye to Settings > Apps & Automation > Gmail me "Reply draft" dabao. Bhejne se pehle tumse Approve maangungi.');
    return lines.join('\n');
  }

  async function chatIntent(text) {
    if (!isMailQuestion(text) || typeof state === 'undefined' || !state.user) return false;
    var typing = document.getElementById('typing-indicator');
    if (typing) typing.classList.remove('hidden');
    var reply;
    try {
      var h = await authHeaders();
      var res = await fetch(base() + '/api/gmail/important', { method: 'POST', headers: h, body: JSON.stringify({}) });
      var j = await res.json().catch(function () { return {}; });
      if (res.ok && j.ok) reply = format(j);
      else if (res.status === 404 || res.status === 503) reply = 'Gmail abhi jura nahi hai. Settings > Apps & Automation > Gmail me "Gmail jodo" karo, phir main tumhare important mails bata paungi.';
      else reply = 'Gmail abhi check nahi ho paya: ' + (j.error || ('server error ' + res.status));
    } catch (e) {
      reply = 'Network ki dikkat, Gmail abhi check nahi ho paya. Thodi der baad dobara pucho.';
    }
    if (typing) typing.classList.add('hidden');
    if (typeof addMessage === 'function') addMessage('ai', reply);
    try { state.currentMessages.push({ role: 'assistant', content: reply }); if (typeof saveChatSnapshot === 'function') saveChatSnapshot(); } catch (e) { /* display only */ }
    return true;
  }

  // keep the native alarm chain alive (the plugin re-arms it when it is switched on)
  setTimeout(function () { try { var A = plugin(); if (A && A.mailWatchStatus) A.mailWatchStatus().catch(function () {}); } catch (e) { /* optional */ } }, 4000);

  window.AureonMail = { chatIntent: chatIntent, isMailQuestion: isMailQuestion };
})();
