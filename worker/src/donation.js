// Cached donation-page data, kept in D1 (binding DB):
//
//   GET  /donation?c=CODE        -> the same data as Apps Script's donation.get
//   POST /donation/refresh {code} -> 202; re-reads that code from Apps Script in the background
//
// Without this, every donation page waits ~3 s for Apps Script (its ~0.8 s floor plus
// Google Sheets reads). Here each code's last answer is served at once:
//   younger than FRESH_MS      -> served as is
//   younger than MAX_STALE_MS  -> served, then refreshed from Apps Script in the background
//   older, or not cached yet   -> read from Apps Script first (the old copy if that fails)
//
// The student page calls /donation/refresh after each save, so a change like hiding the
// reading list reaches the next visitor right away. A row is rewritten only when the answer
// changed or the row is older than FRESH_MS, so repeated refreshes cost no D1 writes.
// Unknown codes are never stored. With no DB binding, or when D1 fails, requests go
// straight to Apps Script, so the page is never worse off than without this cache.
//
// Everything stored here is already public to anyone with the donation link.

import { CODE_RE, httpError } from './shared.js';

export const FRESH_MS = 60 * 1000;
export const MAX_STALE_MS = 24 * 60 * 60 * 1000;
const APPS_SCRIPT_TIMEOUT_MS = 20000;
// A cache, so a schema change can just use a new table name.
const TABLE = 'donation_cache_v1';
const CREATE_TABLE = 'CREATE TABLE IF NOT EXISTS ' + TABLE +
  ' (code TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL)';

const tables = new WeakMap(); // D1 binding -> Promise once its table exists (per isolate)
const jobs = new Map(); // code -> refresh in progress in this isolate

export async function getDonation(rawCode, env, ctx) {
  const code = normCode(rawCode);
  const row = await readRow(env, code);
  const age = row ? Date.now() - row.fetchedAt : Infinity;
  if (age < FRESH_MS) return row.data;
  if (age < MAX_STALE_MS) {
    ctx.waitUntil(refresh(code, env, row).catch(logError));
    return row.data;
  }
  try {
    return await refresh(code, env, row);
  } catch (err) {
    if (row && err.status !== 404) {
      logError(err);
      return row.data; // Apps Script is down or slow: an old copy beats an error
    }
    throw err;
  }
}

/** Validates now; the Apps Script read runs after the response (ctx.waitUntil). */
export async function refreshDonation(rawCode, env, ctx) {
  const code = normCode(rawCode);
  ctx.waitUntil(readRow(env, code).then((row) => refresh(code, env, row, true)).catch(logError));
}

function normCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw httpError(400, 'This link is missing the reader code.');
  return code;
}

/**
 * Reads the code from Apps Script and stores it. Concurrent calls for one code share a
 * single read. With `again`, a read already under way is followed by one more, so a save
 * made while it was running isn't missed.
 */
function refresh(code, env, row, again = false) {
  const running = jobs.get(code);
  if (running) {
    if (again) running.again = true;
    return running.promise;
  }
  const job = { again: false };
  job.promise = (async () => {
    let stored = row;
    let data;
    do {
      job.again = false;
      data = await fetchFromAppsScript(code, env).catch(async (err) => {
        if (err.status === 404 && stored) await deleteRow(env, code); // student left the roster
        throw err;
      });
      const body = JSON.stringify(data);
      const now = Date.now();
      if (!stored || stored.body !== body || now - stored.fetchedAt >= FRESH_MS) {
        await writeRow(env, code, body, now);
        stored = { body, fetchedAt: now };
      }
    } while (job.again);
    return data;
  })().finally(() => jobs.delete(code));
  jobs.set(code, job);
  return job.promise;
}

async function fetchFromAppsScript(code, env) {
  if (!env.APPS_SCRIPT_URL) throw new Error('APPS_SCRIPT_URL is not set');
  // text/plain and a followed redirect, the same request the browser makes (js/common.js).
  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'donation.get', code }),
    redirect: 'follow',
    signal: AbortSignal.timeout(APPS_SCRIPT_TIMEOUT_MS),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out) throw new Error('Apps Script donation.get returned HTTP ' + res.status);
  if (out.ok) return out.data;
  if (out.status === 404) throw httpError(404, out.error || 'We could not find that reader. Please check the link.');
  throw new Error('Apps Script donation.get: ' + (out.error || 'failed'));
}

// ---- D1. Failures are logged and treated as a cache miss, never as a page error. ----

function ensureTable(db) {
  if (!tables.has(db)) {
    tables.set(db, db.prepare(CREATE_TABLE).run().catch((err) => {
      tables.delete(db);
      throw err;
    }));
  }
  return tables.get(db);
}

async function readRow(env, code) {
  if (!env.DB) return null;
  try {
    await ensureTable(env.DB);
    const r = await env.DB.prepare('SELECT body, fetched_at FROM ' + TABLE + ' WHERE code = ?').bind(code).first();
    return r ? { body: r.body, data: JSON.parse(r.body), fetchedAt: Number(r.fetched_at) } : null;
  } catch (err) {
    logError(err);
    return null;
  }
}

async function writeRow(env, code, body, fetchedAt) {
  if (!env.DB) return;
  try {
    await ensureTable(env.DB);
    await env.DB.prepare('INSERT INTO ' + TABLE + ' (code, body, fetched_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (code) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at')
      .bind(code, body, fetchedAt).run();
  } catch (err) {
    logError(err);
  }
}

async function deleteRow(env, code) {
  if (!env.DB) return;
  try {
    await ensureTable(env.DB);
    await env.DB.prepare('DELETE FROM ' + TABLE + ' WHERE code = ?').bind(code).run();
  } catch (err) {
    logError(err);
  }
}

function logError(err) {
  if (err && err.status === 404) return; // an unknown code, not a fault
  console.error((err && err.stack) || String(err));
}
