'use strict';
// Email sender for the dead-man switch. Zero dependencies (uses Node's built-in fetch).
// Pick ONE provider with env vars:
//   Brevo  : EMAIL_PROVIDER=brevo  BREVO_API_KEY=...   EMAIL_FROM=<your verified sender email>  EMAIL_FROM_NAME=Aureon
//   Resend : EMAIL_PROVIDER=resend RESEND_API_KEY=...  EMAIL_FROM=<address on a domain verified in Resend>
// Note: Resend only sends to other people from a verified domain; Brevo works with a single verified sender email.

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const TIMEOUT_MS = 20000;

function oneLine(s, max) {
  return String(s || '').replace(/[\r\n]+/g, ' ').slice(0, max);
}

async function postJson(fetchImpl, url, headers, body, label) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`${label}: network error (${oneLine(e && e.name === 'TimeoutError' ? 'timeout' : e && e.message, 80)})`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = oneLine(await res.text(), 200); } catch (_) { /* ignore */ }
    throw new Error(`${label}: HTTP ${res.status} ${detail}`.trim());
  }
}

function createMailer(env = {}, fetchImpl = globalThis.fetch) {
  const provider = String(env.EMAIL_PROVIDER || '').toLowerCase();
  const from = String(env.EMAIL_FROM || '').trim();
  const fromName = oneLine(env.EMAIL_FROM_NAME || 'Aureon', 60);
  const key = provider === 'brevo' ? env.BREVO_API_KEY : provider === 'resend' ? env.RESEND_API_KEY : '';
  const configured = ['brevo', 'resend'].includes(provider) && !!key && EMAIL_RE.test(from);

  async function send({ to, subject, text }) {
    if (!configured) throw new Error('email is not configured (set EMAIL_PROVIDER, API key and EMAIL_FROM)');
    if (!EMAIL_RE.test(String(to || ''))) throw new Error('invalid recipient address');
    const subj = oneLine(subject, 150);
    const body = String(text || '').slice(0, 10000);
    if (provider === 'brevo') {
      return postJson(fetchImpl, 'https://api.brevo.com/v3/smtp/email', { 'api-key': key, accept: 'application/json' },
        { sender: { email: from, name: fromName }, to: [{ email: to }], subject: subj, textContent: body }, 'brevo');
    }
    return postJson(fetchImpl, 'https://api.resend.com/emails', { Authorization: `Bearer ${key}` },
      { from: `${fromName} <${from}>`, to: [to], subject: subj, text: body }, 'resend');
  }
  return { configured, provider: configured ? provider : 'none', send };
}

// Builds the deliver(uid, action, contact) function used by the dead-man switch.
function makeDeliver({ mailer, store, ownerName = 'the owner' }) {
  return async (uid, action, contact) => {
    if (contact.channel !== 'email') throw new Error(`channel "${contact.channel}" is not supported yet (email only)`);
    let body = action.text || '';
    if (action.type === 'release_asset') {
      const assets = await store.get(uid, 'assets', {});
      const a = assets[action.assetId];
      if (!a) throw new Error('asset not found: ' + action.assetId);
      body = (body ? body + '\n\n' : '') + a.label + '\n' + a.text;
    }
    const text =
      `${body}\n\n---\nThis message was sent automatically by Aureon (Digital Continuity) because ` +
      `${ownerName} has not checked in for a long time. If you think this is a mistake, please contact them directly.`;
    await mailer.send({ to: contact.address, subject: `Message from ${ownerName}`, text });
  };
}

module.exports = { createMailer, makeDeliver, EMAIL_RE };
