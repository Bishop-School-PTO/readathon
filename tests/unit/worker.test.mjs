// Unit tests for the embedded-checkout Cloudflare Worker, with Turnstile and Stripe faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { STRIPE_API_VERSION } from '../../worker/src/checkout.js';

const ORIGIN = 'https://readathon.bishopschoolpto.com';
const ENV = {
  STRIPE_SECRET_KEY: 'rk_test_x',
  TURNSTILE_SECRET_KEY: 'ts_secret',
  STRIPE_PRICE_ID: 'price_donate',
  SITE_URL: 'https://readathon.bishopschoolpto.com/',
  ALLOWED_ORIGINS: ORIGIN + ', http://localhost:8082',
  TURNSTILE_HOSTNAMES: 'readathon.bishopschoolpto.com',
};

/** Replaces fetch: Turnstile answers `turnstile`, Stripe answers `stripe(url, init)`. */
function fakeFetch({ turnstile = { success: true, action: 'donate', hostname: 'readathon.bishopschoolpto.com' }, stripe } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://challenges.cloudflare.com/')) return Response.json(turnstile);
    if (String(url).startsWith('https://api.stripe.com/')) {
      const [status, body] = stripe ? stripe(String(url), init) : [200, { id: 'cs_test_1', client_secret: 'cs_test_1_secret_abc' }];
      return Response.json(body, { status });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return calls;
}

function post(body, origin = ORIGIN) {
  return worker.fetch(new Request('https://w.example/checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': '203.0.113.9' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), ENV);
}

function status(id, origin = ORIGIN) {
  return worker.fetch(new Request('https://w.example/session-status?session_id=' + encodeURIComponent(id), {
    headers: { Origin: origin },
  }), ENV);
}

test('creates an embedded Checkout Session for the student after Turnstile passes', async () => {
  const calls = fakeFetch();
  const res = await post({ code: 'abc234', turnstileToken: 'tok' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { clientSecret: 'cs_test_1_secret_abc' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  const ts = new URLSearchParams(calls[0].init.body);
  assert.equal(ts.get('secret'), 'ts_secret');
  assert.equal(ts.get('response'), 'tok');
  assert.equal(ts.get('remoteip'), '203.0.113.9');

  const sc = calls[1];
  assert.equal(sc.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(sc.init.headers.Authorization, 'Bearer rk_test_x');
  assert.equal(sc.init.headers['Stripe-Version'], STRIPE_API_VERSION);
  const p = Object.fromEntries(new URLSearchParams(sc.init.body));
  assert.equal(p.ui_mode, 'embedded_page');
  assert.equal(p.mode, 'payment');
  assert.equal(p['line_items[0][price]'], 'price_donate');
  assert.equal(p['line_items[0][quantity]'], '1');
  assert.equal(p.client_reference_id, 'ABC234');
  assert.equal(p['metadata[app]'], 'readathon.bishopschoolpto.com'); // what the Apps Script sync counts
  assert.equal(p.submit_type, 'donate');
  assert.equal(p.redirect_on_completion, 'if_required'); // card payments finish without leaving the page
  assert.equal(p.return_url,
    'https://readathon.bishopschoolpto.com/donate.html?c=ABC234&checkout=embedded&session_id={CHECKOUT_SESSION_ID}');
});

test('refuses without a valid Turnstile token, and never calls Stripe', async () => {
  for (const turnstile of [
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: true, action: 'login', hostname: 'readathon.bishopschoolpto.com' },
    { success: true, action: 'donate', hostname: 'evil.example' },
  ]) {
    const calls = fakeFetch({ turnstile });
    const res = await post({ code: 'ABC234', turnstileToken: 'tok' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /confirm you are a person/);
    assert.ok(calls.every((c) => !c.url.includes('stripe.com')));
  }
  const calls = fakeFetch();
  assert.equal((await post({ code: 'ABC234' })).status, 403); // no token: not even sent to Cloudflare
  assert.equal(calls.length, 0);
});

test('rejects bad codes, bad JSON and other sites', async () => {
  const calls = fakeFetch();
  for (const code of ['', 'AB', 'ABC-234', 'A'.repeat(13), '<script>']) {
    assert.equal((await post({ code, turnstileToken: 'tok' })).status, 400, code);
  }
  assert.equal((await post('{nope')).status, 400);
  const other = await post({ code: 'ABC234', turnstileToken: 'tok' }, 'https://evil.example');
  assert.equal(other.status, 403);
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(calls.length, 0);
});

test('answers CORS preflight only for allowed origins', async () => {
  const pre = (origin) => worker.fetch(new Request('https://w.example/checkout-session', {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  }), ENV);
  const ok = await pre('http://localhost:8082');
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8082');
  assert.match(ok.headers.get('Access-Control-Allow-Headers'), /Content-Type/);
  assert.equal((await pre('https://evil.example')).status, 403);
});

test('Stripe errors are logged, not shown to donors', async () => {
  fakeFetch({ stripe: () => [400, { error: { message: 'No such price: price_donate' } }] });
  const orig = console.error;
  const logged = [];
  console.error = (m) => logged.push(m);
  try {
    const res = await post({ code: 'ABC234', turnstileToken: 'tok' });
    assert.equal(res.status, 500);
    assert.doesNotMatch((await res.json()).error, /price/);
    assert.match(logged.join(' '), /No such price/);
  } finally {
    console.error = orig;
  }
});

test('session status: only for sessions this Worker created', async () => {
  fakeFetch({
    stripe: (url) => url.endsWith('/cs_test_a1mine12345')
      ? [200, { status: 'complete', payment_status: 'paid', metadata: { app: 'readathon.bishopschoolpto.com' }, customer_details: { email: 'x@y.z' } }]
      : [200, { status: 'complete', payment_status: 'paid', metadata: {} }],
  });
  const mine = await status('cs_test_a1mine12345');
  assert.equal(mine.status, 200);
  assert.deepEqual(await mine.json(), { status: 'complete', paymentStatus: 'paid' }); // no donor details
  assert.equal((await status('cs_test_a1other1234')).status, 404);
  assert.equal((await status('pi_123/../../v1/customers')).status, 400);
  assert.equal((await status('cs_test_a1mine12345', 'https://evil.example')).status, 403);
});
