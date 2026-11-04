// Local dev server: serves public/ and runs apps-script/Core.js against a JSON file.
//   PORT=8082  DEV_DATA=dev/data.json (or ":memory:")  DEV_TODAY=2026-10-09
//   DEV_ADMINS=organizer@example.com   comma-separated stand-ins for the spreadsheet's editors
//   DEV_EMAIL_QUOTA=1000               emails "Google" allows per run of the server
//   DEV_CHECKOUT_API_URL=http://localhost:8787  DEV_STRIPE_PK=pk_test_...
//                                      turn on the embedded donation form (?checkout=embedded)
//                                      against `npm run worker:dev`. Uses Turnstile's test site key.
//
// There's no Google sign-in locally: the admin page sends "dev:<email>" as its ID token.
// Emails aren't sent: they're printed and kept in memory, readable at GET /dev/outbox.
// Stripe is faked too: a few demo donations for some students (see fakeStripeGet).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { handleApi } = require('../apps-script/Core.js');
const { createFileStore } = require('./store.js');
const { buildRoster } = require('./seed.js');

const PORT = Number(process.env.PORT || 8082);
const ROOT = path.join(__dirname, '..', 'public');
const DATA = process.env.DEV_DATA || path.join(__dirname, 'data.json');
const TZ = 'America/Los_Angeles';
const DEV_CLIENT_ID = 'dev-client-id';
const outbox = [];
const ADMINS = (process.env.DEV_ADMINS || 'organizer@example.com').split(',').map((e) => e.trim()).filter(Boolean);

const env = {
  today: () => process.env.DEV_TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()),
  now: () => new Date().toISOString(),
  randomBytes: (n) => [...crypto.randomBytes(n)],
  googleClientId: DEV_CLIENT_ID,
  // Stand-in for Google's tokeninfo: "dev:<email>" looks like a valid, fresh token for that email.
  verifyGoogleIdToken: (token) => {
    const m = /^dev:(.+@.+)$/.exec(token);
    if (!m) return null;
    const exp = String(Math.floor(Date.now() / 1000) + 3600);
    return { aud: DEV_CLIENT_ID, iss: 'accounts.google.com', exp, email: m[1], email_verified: 'true' };
  },
  sendEmail: (msg) => {
    outbox.push({ ...msg, sentAt: new Date().toISOString() });
    console.log(`[email] to ${msg.to}: ${msg.subject}`);
  },
  emailQuota: () => Number(process.env.DEV_EMAIL_QUOTA || 1000) - outbox.length, // like Google's daily limit
  stripeGet: (p, q) => fakeStripeGet(p, q),
  stripePaymentLinkId: 'plink_dev',
  donationLinkUrl: 'https://donate.stripe.com/test_00wbJ2ebP3zB8pObgZcjS00',
  siteUrl: `http://localhost:${PORT}`,
  log: (msg) => console.error(msg),
};

const store = createFileStore(DATA === ':memory:' ? null : DATA, buildRoster(), ADMINS);
seedIfEmpty();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api') return api(req, res, url);
  if (url.pathname === '/dev/outbox') {
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(outbox));
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
    const cfg = { apiUrl: '/api', devSignIn: true };
    if (process.env.DEV_CHECKOUT_API_URL && process.env.DEV_STRIPE_PK) {
      Object.assign(cfg, { checkoutApiUrl: process.env.DEV_CHECKOUT_API_URL, stripePublishableKey: process.env.DEV_STRIPE_PK,
        turnstileSiteKey: '1x00000000000000000000AA' }); // Cloudflare's always-passes test key
    }
    return res.end('window.READATHON_CONFIG = ' + JSON.stringify(cfg) + ';\n');
  }
  // Same rewrites as public/_redirects.
  let file = url.pathname;
  if (/^\/s\/[^/]+\/?$/.test(file)) file = '/student.html';
  else if (/^\/d\/[^/]+\/?$/.test(file)) file = '/donate.html';
  else if (file === '/admin' || file === '/admin/') file = '/admin.html';
  else if (file.endsWith('/')) file += 'index.html';
  const full = path.normalize(path.join(ROOT, file));
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': TYPES['.html'] });
    return fs.createReadStream(path.join(ROOT, '404.html')).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(res);
});

function api(req, res, url) {
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET') return send(handleApi(store, env, Object.fromEntries(url.searchParams)));
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch (e) { return send({ ok: false, error: 'Invalid request.' }); }
    send(handleApi(store, env, parsed));
  });
}

// Completed Checkout Sessions as Stripe's API would list them, newest first, 3 per page.
function fakeStripeGet(apiPath, q) {
  if (apiPath !== '/v1/checkout/sessions' || q.status !== 'complete') throw new Error('Unexpected Stripe call');
  const sessions = [];
  store.readTable('Students').rows.forEach((row, i) => {
    if (i % 3) return;
    const cents = [2500, 5000, 1000, 10000][i % 4];
    // Every other gift came through the embedded form rather than the Payment Link.
    const via = i % 2 ? { payment_link: null, metadata: { app: 'readathon.bishopschoolpto.com' } } : { payment_link: 'plink_dev' };
    sessions.push({ id: 'cs_dev_' + i, client_reference_id: row[5], amount_total: cents, currency: 'usd', payment_status: 'paid',
      created: 1791500000 + i, payment_intent: { latest_charge: { amount: cents, amount_refunded: i === 6 ? cents : 0 } }, ...via });
  });
  sessions.push({ id: 'cs_dev_general', payment_link: 'plink_dev', client_reference_id: null, amount_total: 2000, currency: 'usd', payment_status: 'paid', created: 1791400000 });
  sessions.push({ id: 'cs_dev_pending', payment_link: 'plink_dev', client_reference_id: 'NOPE', amount_total: 5000, currency: 'usd', payment_status: 'unpaid', created: 1791300000 });
  sessions.push({ id: 'cs_dev_bakesale', payment_link: 'plink_other', client_reference_id: null, amount_total: 99900, currency: 'usd', payment_status: 'paid', created: 1791200000 });
  const start = q.starting_after ? sessions.findIndex((x) => x.id === q.starting_after) + 1 : 0;
  return { object: 'list', data: sessions.slice(start, start + 3), has_more: start + 3 < sessions.length };
}

function addDays(d, n) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

function seedIfEmpty() {
  if (store.readTable('Settings').rows.length) return;
  const today = env.today();
  const call = (action, params) => {
    const r = handleApi(store, env, { action, idToken: 'dev:' + ADMINS[0], ...params });
    if (!r.ok) throw new Error(action + ': ' + r.error);
    return r.data;
  };
  call('admin.saveSettings', { settings: { startDate: addDays(today, -5), endDate: addDays(today, 9), schoolGoalMinutes: 20000 } });
  call('admin.syncRoster', {});
  // Some demo reading for the first half of the class, deterministic per student.
  const students = store.readTable('Students').rows;
  students.forEach((row, i) => {
    if (i % 2) return;
    for (let d = -5; d < 0; d++) {
      const minutes = (((i * 7 - d * 13) % 4) + 1) * 10; // d < 0, so this stays positive
      store.appendRows('Minutes', [[row[0], addDays(today, d), minutes, env.now()]]);
    }
  });
}

// Like the 10-minute trigger in Apps Script.
handleApi(store, env, { action: 'admin.syncDonations', idToken: 'dev:' + ADMINS[0] });

server.listen(PORT, () => {
  const students = store.readTable('Students').rows.slice(0, 3);
  console.log(`Readathon dev server: http://localhost:${PORT}`);
  console.log(`  Organizer:  http://localhost:${PORT}/admin   (sign in as: ${ADMINS.join(', ')})`);
  students.forEach((r) => {
    console.log(`  ${r[1]}: student http://localhost:${PORT}/s/${r[4]}  donate http://localhost:${PORT}/d/${r[5]}`);
  });
});
