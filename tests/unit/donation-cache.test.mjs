// Unit tests for the Worker's donation-page cache (worker/src/donation.js), with Apps Script
// faked and D1 played by Node's built-in SQLite, so the real SQL runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/src/index.js';
import { FRESH_MS, MAX_STALE_MS } from '../../worker/src/donation.js';

const ORIGIN = 'https://readathon.bishopschoolpto.com';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/test/exec';

/** A D1 binding over in-memory SQLite. Counts the statements that write. */
function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    writes: 0,
    sqlite,
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() { return stmt.get(...args) || null; },
        async run() {
          if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) db.writes++;
          stmt.run(...args);
          return { success: true };
        },
      };
      return api;
    },
  };
  return db;
}

/** Fakes Apps Script: answers[code] is data, an { ok: false, ... } envelope, or a function. */
function fakeAppsScript(answers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), APPS_SCRIPT_URL);
    const req = JSON.parse(init.body);
    calls.push({ init, req });
    let a = answers[req.code];
    if (typeof a === 'function') a = await a();
    if (a instanceof Error) throw a;
    if (a === undefined) return Response.json({ ok: false, error: 'We could not find that reader.', status: 404 });
    return Response.json(a.ok === false ? a : { ok: true, data: a });
  };
  return calls;
}

function setup({ db = fakeD1() } = {}) {
  const env = { ALLOWED_ORIGINS: ORIGIN, APPS_SCRIPT_URL, DB: db };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const settle = async () => { while (pending.length) await pending.shift(); };
  const get = (code, origin = ORIGIN) => worker.fetch(new Request('https://w.example/donation?c=' + encodeURIComponent(code), {
    headers: { Origin: origin },
  }), env, ctx);
  const refresh = (body, origin = ORIGIN) => worker.fetch(new Request('https://w.example/donation/refresh', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain;charset=utf-8' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env, ctx);
  return { env, db, ctx, settle, get, refresh };
}

/** Moves Date.now() forward for the rest of a test. */
function clock(t) {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  t.after(() => { Date.now = real; });
  return (ms) => { now += ms; };
}

function quietErrors(t) {
  const orig = console.error;
  const logged = [];
  console.error = (m) => logged.push(String(m));
  t.after(() => { console.error = orig; });
  return logged;
}

test('first visit reads Apps Script and stores the answer; later visits come from D1', async (t) => {
  clock(t);
  const s = setup();
  const calls = fakeAppsScript({ ABC234: { student: { firstName: 'Avery' }, totalMinutes: 50 } });

  const res = await s.get('abc234');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await res.json(), { student: { firstName: 'Avery' }, totalMinutes: 50 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].req, { action: 'donation.get', code: 'ABC234' });
  assert.match(calls[0].init.headers['Content-Type'], /^text\/plain/); // Apps Script needs a simple request
  assert.equal(calls[0].init.redirect, 'follow');

  const again = await s.get('ABC234');
  assert.deepEqual(await again.json(), { student: { firstName: 'Avery' }, totalMinutes: 50 });
  await s.settle();
  assert.equal(calls.length, 1); // fresh: Apps Script not asked again
  assert.equal(s.db.writes, 1);
});

test('a stale copy is served at once and refreshed in the background', async (t) => {
  const tick = clock(t);
  const s = setup();
  const answers = { ABC234: { totalMinutes: 50 } };
  const calls = fakeAppsScript(answers);
  await s.get('ABC234');

  answers.ABC234 = { totalMinutes: 80 };
  tick(FRESH_MS + 1);
  assert.deepEqual(await (await s.get('ABC234')).json(), { totalMinutes: 50 }); // old copy, no wait
  await s.settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(await (await s.get('ABC234')).json(), { totalMinutes: 80 });
  await s.settle();
  assert.equal(calls.length, 2);
});

test('a copy older than MAX_STALE_MS waits for Apps Script, and is still served if that fails', async (t) => {
  const tick = clock(t);
  const s = setup();
  const answers = { ABC234: { totalMinutes: 50 } };
  fakeAppsScript(answers);
  await s.get('ABC234');

  tick(MAX_STALE_MS + 1);
  answers.ABC234 = { totalMinutes: 90 };
  assert.deepEqual(await (await s.get('ABC234')).json(), { totalMinutes: 90 }); // waited for the new answer

  tick(MAX_STALE_MS + 1);
  answers.ABC234 = new Error('Apps Script timed out');
  const logged = quietErrors(t);
  const res = await s.get('ABC234');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { totalMinutes: 90 });
  assert.match(logged.join(' '), /timed out/);
});

test('unknown codes get a 404 and are never stored; a code that disappears is removed', async (t) => {
  const tick = clock(t);
  const s = setup();
  const answers = { ABC234: { totalMinutes: 50 } };
  const calls = fakeAppsScript(answers);

  const res = await s.get('NOPE99');
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /could not find that reader/);
  assert.equal((await s.get('NOPE99')).status, 404);
  assert.equal(calls.length, 2); // asked each time: nothing cached
  assert.equal(s.db.writes, 0);

  await s.get('ABC234');
  delete answers.ABC234; // e.g. the student left the roster
  tick(MAX_STALE_MS + 1);
  assert.equal((await s.get('ABC234')).status, 404);
  assert.equal(s.db.sqlite.prepare('SELECT COUNT(*) AS n FROM donation_cache_v1').get().n, 0);
});

test('Apps Script errors other than 404 are not shown to visitors', async (t) => {
  clock(t);
  const s = setup();
  fakeAppsScript({ ABC234: { ok: false, error: 'The data spreadsheet has no "Books" tab.', status: 500 } });
  const logged = quietErrors(t);
  const res = await s.get('ABC234');
  assert.equal(res.status, 500);
  assert.doesNotMatch((await res.json()).error, /spreadsheet/);
  assert.match(logged.join(' '), /Books/);
});

test('refresh re-reads in the background and writes only when the answer changed', async (t) => {
  clock(t);
  const s = setup();
  const answers = { ABC234: { prefs: { showReadingList: true } } };
  const calls = fakeAppsScript(answers);
  await s.get('ABC234');
  assert.equal(s.db.writes, 1);

  const res = await s.refresh({ code: 'abc234' });
  assert.equal(res.status, 202);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  await s.settle();
  assert.equal(calls.length, 2);
  assert.equal(s.db.writes, 1); // same answer, still fresh: no write

  answers.ABC234 = { prefs: { showReadingList: false } };
  await s.refresh({ code: 'ABC234' });
  await s.settle();
  assert.equal(s.db.writes, 2);
  assert.deepEqual(await (await s.get('ABC234')).json(), { prefs: { showReadingList: false } });
  await s.settle();
  assert.equal(calls.length, 3);
});

test('a refresh asked for during another read is not lost', async (t) => {
  clock(t);
  const s = setup();
  let release;
  let value = 1;
  const calls = fakeAppsScript({
    ABC234: () => (value === 1 ? new Promise((r) => { release = r; }).then(() => ({ v: 1 })) : { v: value }),
  });
  const first = s.get('ABC234'); // a slow read is under way
  await new Promise((r) => setImmediate(r));
  value = 2; // the student saves something...
  await s.refresh({ code: 'ABC234' }); // ...and the page asks for a refresh
  release();
  assert.deepEqual(await (await first).json(), { v: 2 }); // includes the second read
  await s.settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(await (await s.get('ABC234')).json(), { v: 2 });
});

test('rejects bad codes and other sites', async (t) => {
  clock(t);
  const s = setup();
  const calls = fakeAppsScript({ ABC234: { v: 1 } });
  for (const code of ['', 'AB', 'ABC-234', 'A'.repeat(13), '<script>']) {
    assert.equal((await s.get(code)).status, 400, code);
    assert.equal((await s.refresh({ code })).status, 400, code);
  }
  assert.equal((await s.refresh('{nope')).status, 400);
  assert.equal((await s.get('ABC234', 'https://evil.example')).status, 403);
  assert.equal((await s.refresh({ code: 'ABC234' }, 'https://evil.example')).status, 403);
  await s.settle();
  assert.equal(calls.length, 0);
});

test('without D1, or when D1 fails, requests go straight to Apps Script', async (t) => {
  clock(t);
  const logged = quietErrors(t);
  const calls = fakeAppsScript({ ABC234: { v: 1 } });

  const noDb = setup({ db: null });
  delete noDb.env.DB;
  assert.deepEqual(await (await noDb.get('ABC234')).json(), { v: 1 });

  const broken = setup({ db: { prepare() { throw new Error('D1_ERROR: daily write limit reached'); } } });
  assert.deepEqual(await (await broken.get('ABC234')).json(), { v: 1 });
  assert.equal(calls.length, 2);
  assert.match(logged.join(' '), /D1_ERROR/);
});
