// Cloudflare Worker for the embedded donation form (donate page with ?checkout=embedded).
//
//   POST /checkout-session  { code, turnstileToken }  -> { clientSecret }
//        Checks the Turnstile token, then creates an embedded Checkout Session for the
//        donation price, tagged with the student code like the Payment Link's
//        ?client_reference_id=. Turnstile keeps bots from using it to test stolen cards.
//   GET  /session-status?session_id=cs_...           -> { status, paymentStatus }
//        Lets the return page say "thank you" or show the form again.
//
// Apps Script's donation sync counts these sessions by their metadata.app tag, so
// totals work the same as for the Payment Link. This Worker never stores anything.
//
// Settings (worker/wrangler.jsonc "vars"): STRIPE_PRICE_ID, SITE_URL, ALLOWED_ORIGINS,
// TURNSTILE_HOSTNAMES. Secrets (wrangler secret put): STRIPE_SECRET_KEY, TURNSTILE_SECRET_KEY.

export const STRIPE_API_VERSION = '2026-09-30.endive';
export const APP_TAG = 'readathon.bishopschoolpto.com';
const CODE_RE = /^[A-Z0-9]{4,12}$/; // student donation codes, same check as donation.get
const SESSION_RE = /^cs_(test_|live_)?[A-Za-z0-9]{10,200}$/;
const SUBMIT_MESSAGE = 'Thank you for supporting the Bishop PTO and our readers! ' +
  'No goods or services were provided in exchange for this gift.';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    try {
      if (url.pathname === '/checkout-session' && request.method === 'POST') {
        if (!cors) return json({ error: 'Not allowed.' }, 403);
        return json(await createSession(request, env), 200, cors);
      }
      if (url.pathname === '/session-status' && request.method === 'GET') {
        if (!cors) return json({ error: 'Not allowed.' }, 403);
        return json(await sessionStatus(url.searchParams.get('session_id'), env), 200, cors);
      }
      return json({ error: 'Not found.' }, 404, cors || {});
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err.stack || String(err));
      return json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message }, status, cors || {});
    }
  },
};

async function createSession(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    throw httpError(400, 'Invalid request.');
  }
  const code = String((body && body.code) || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw httpError(400, 'This donation link is missing the reader code.');
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(String((body && body.turnstileToken) || ''), ip, env))) {
    throw httpError(403, 'We could not confirm you are a person. Please refresh the page and try again.');
  }
  const site = String(env.SITE_URL).replace(/\/+$/, '');
  // Literal braces: Stripe fills in {CHECKOUT_SESSION_ID} when it redirects back.
  const returnUrl = site + '/donate.html?c=' + encodeURIComponent(code) +
    '&checkout=embedded&session_id={CHECKOUT_SESSION_ID}';
  const session = await stripe(env, 'POST', '/v1/checkout/sessions', {
    mode: 'payment',
    ui_mode: 'embedded_page',
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    submit_type: 'donate',
    client_reference_id: code,
    'metadata[app]': APP_TAG,
    'metadata[source]': 'embedded',
    'custom_text[submit][message]': SUBMIT_MESSAGE,
    return_url: returnUrl,
    integration_identifier: 'readathon_embedded_v1',
  });
  return { clientSecret: session.client_secret };
}

async function sessionStatus(id, env) {
  if (!SESSION_RE.test(String(id || ''))) throw httpError(400, 'Invalid session.');
  const s = await stripe(env, 'GET', '/v1/checkout/sessions/' + encodeURIComponent(id));
  // Only answer for sessions this Worker created.
  if (!s.metadata || s.metadata.app !== APP_TAG) throw httpError(404, 'Session not found.');
  return { status: s.status, paymentStatus: s.payment_status };
}

/** Asks Cloudflare whether the Turnstile token is valid, unused, for our action and site. */
export async function verifyTurnstile(token, ip, env) {
  if (!token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) form.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Turnstile siteverify returned HTTP ' + res.status);
  const out = await res.json();
  if (!out.success) return false;
  if (out.action && out.action !== 'donate') return false;
  const hosts = list(env.TURNSTILE_HOSTNAMES);
  return !hosts.length || hosts.includes(out.hostname);
}

async function stripe(env, method, path, params) {
  const init = {
    method,
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Stripe-Version': STRIPE_API_VERSION },
  };
  if (params) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(params).toString();
  }
  const res = await fetch('https://api.stripe.com' + path, init);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404) throw httpError(404, 'Session not found.');
    throw new Error('Stripe ' + method + ' ' + path + ': ' + ((out.error && out.error.message) || 'HTTP ' + res.status));
  }
  return out;
}

/** CORS headers when the request comes from an allowed origin, otherwise null. */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !list(env.ALLOWED_ORIGINS).includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function list(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
