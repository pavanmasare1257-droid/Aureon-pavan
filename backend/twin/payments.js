'use strict';
// Payment handler for intent.action === 'pay_bill'. Zero dependencies.
//
// SAFE BY DEFAULT: unless you explicitly turn it on, payments are SIMULATED (dry-run): nothing is sent anywhere,
// the result says simulated:true, the audit log says SIMULATED, and the simulated amount never uses up your daily budget.
//
// To go live (RazorpayX payouts, needs a RazorpayX account with KYC + IP allowlisting in the Razorpay dashboard):
//   PAYMENTS_PROVIDER=razorpayx
//   RAZORPAYX_KEY_ID=...  RAZORPAYX_KEY_SECRET=...  RAZORPAYX_ACCOUNT_NUMBER=...
//   TWIN_PAYEES_JSON={"electricity":{"fundAccountId":"fa_xxx","mode":"UPI","purpose":"utility bill"}}
// Hard ceiling that no limit setting can exceed: TWIN_MAX_PAYMENT_INR (default 5000).

const BAD_STATUS = new Set(['failed', 'rejected', 'cancelled', 'reversed']);
const PURPOSES = new Set(['refund', 'cashback', 'payout', 'salary', 'utility bill', 'vendor bill']);
const MODES = new Set(['UPI', 'IMPS', 'NEFT', 'RTGS']);
const TIMEOUT_MS = 20000;

function parsePayees(raw) {
  if (!raw) return {};
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { throw new Error('TWIN_PAYEES_JSON is not valid JSON'); }
  const out = {};
  for (const [name, p] of Object.entries(obj || {})) {
    if (!p || !/^fa_[A-Za-z0-9]+$/.test(String(p.fundAccountId || ''))) throw new Error(`payee "${name}": fundAccountId must look like fa_xxxx`);
    const mode = String(p.mode || 'UPI').toUpperCase();
    const purpose = String(p.purpose || 'utility bill');
    if (!MODES.has(mode)) throw new Error(`payee "${name}": bad mode`);
    if (!PURPOSES.has(purpose)) throw new Error(`payee "${name}": bad purpose`);
    out[name] = { fundAccountId: p.fundAccountId, mode, purpose };
  }
  return out;
}

function createPayments(env = {}, fetchImpl = globalThis.fetch) {
  const payees = parsePayees(env.TWIN_PAYEES_JSON);
  const ceiling = Number(env.TWIN_MAX_PAYMENT_INR) > 0 ? Number(env.TWIN_MAX_PAYMENT_INR) : 5000;
  const live =
    env.PAYMENTS_PROVIDER === 'razorpayx' && !!env.RAZORPAYX_KEY_ID && !!env.RAZORPAYX_KEY_SECRET && !!env.RAZORPAYX_ACCOUNT_NUMBER;

  function validate(intent) {
    const amount = Number(intent.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid amount');
    if (amount > ceiling) throw new Error(`amount is above the hard ceiling of ${ceiling} INR (TWIN_MAX_PAYMENT_INR)`);
    const paise = Math.round(amount * 100);
    if (Math.abs(amount * 100 - paise) > 1e-6) throw new Error('amount can have at most 2 decimals');
    if (paise < 100) throw new Error('minimum payout is 1 INR');
    const payee = payees[String(intent.payee || '')];
    if (!payee) throw new Error(`unknown payee "${intent.payee}" (add it to TWIN_PAYEES_JSON)`);
    return { paise, payee };
  }

  async function payLive(intent, paise, payee) {
    const auth = Buffer.from(`${env.RAZORPAYX_KEY_ID}:${env.RAZORPAYX_KEY_SECRET}`).toString('base64');
    const narration = ('Aureon ' + String(intent.payee)).replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 30);
    let res;
    try {
      res = await fetchImpl('https://api.razorpay.com/v1/payouts', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          'X-Payout-Idempotency': String(intent.id), // same id => Razorpay will not pay twice
        },
        body: JSON.stringify({
          account_number: env.RAZORPAYX_ACCOUNT_NUMBER,
          fund_account_id: payee.fundAccountId,
          amount: paise,
          currency: 'INR',
          mode: payee.mode,
          purpose: payee.purpose,
          queue_if_low_balance: false,
          reference_id: String(intent.id).slice(0, 40),
          narration,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // The request may have reached Razorpay. We cannot know, so this is an UNCERTAIN failure.
      const err = new Error('payment request timed out / network error: payout may or may not have been created');
      err.ambiguous = true;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON body */ }
    if (res.status >= 500) {
      const err = new Error(`razorpay server error ${res.status}: payout may or may not have been created`);
      err.ambiguous = true;
      throw err;
    }
    if (!res.ok) {
      const d = (data && data.error && (data.error.description || data.error.code)) || '';
      throw new Error(`razorpay rejected the payout (HTTP ${res.status}) ${String(d).slice(0, 150)}`.trim());
    }
    if (data && BAD_STATUS.has(data.status)) throw new Error(`payout ${data.status}`);
    return { simulated: false, provider: 'razorpayx', payoutId: data && data.id, status: data && data.status, utr: (data && data.utr) || null };
  }

  async function handler(uid, intent) {
    const { paise, payee } = validate(intent);
    if (!live) return { simulated: true, provider: 'dryrun', payee: intent.payee, amount: paise / 100 };
    return payLive(intent, paise, payee);
  }

  return { handler, live, payees: Object.keys(payees), ceiling };
}

module.exports = { createPayments, parsePayees };
