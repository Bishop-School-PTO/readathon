// JSON-file store implementing the same interface as the Sheets store in apps-script/Code.js.
const fs = require('fs');
const { SCHEMA } = require('../apps-script/Core.js');

function createFileStore(file, roster, adminEmails) {
  let db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (!db) db = { tables: {} };
  // Like setup() in Apps Script: add any tabs that are missing (e.g. from an older data.json).
  for (const name of Object.keys(SCHEMA)) {
    if (!db.tables[name]) db.tables[name] = { headers: SCHEMA[name].slice(), rows: [] };
  }
  const cache = new Map();
  const save = () => { if (file) fs.writeFileSync(file, JSON.stringify(db, null, 1)); };
  const table = (name) => {
    if (!db.tables[name]) throw new Error('No table ' + name);
    return db.tables[name];
  };
  // Mimic Sheets: rows come back padded to the header width, as plain values.
  const copyRows = (t) => t.rows.map((r) => t.headers.map((_, i) => (r[i] === undefined ? '' : r[i])));

  return {
    db,
    readTable: (name) => ({ headers: table(name).headers.slice(), rows: copyRows(table(name)) }),
    appendRows(name, rows) { table(name).rows.push(...rows.map((r) => r.slice())); save(); },
    updateRow(name, index, values) { table(name).rows[index] = values.slice(); save(); },
    deleteRows(name, indexes) {
      const t = table(name);
      [...indexes].sort((a, b) => b - a).forEach((i) => t.rows.splice(i, 1));
      save();
    },
    replaceRows(name, rows) { table(name).rows = rows.map((r) => r.slice()); save(); },
    readRoster: () => JSON.parse(JSON.stringify(roster)),
    withLock: (fn) => fn(),
    cacheGet(key) {
      const e = cache.get(key);
      return e && e.expires > Date.now() ? JSON.parse(e.value) : null;
    },
    cachePut(key, value, seconds) { cache.set(key, { value: JSON.stringify(value), expires: Date.now() + seconds * 1000 }); },
    cacheRemove(key) { cache.delete(key); },
    adminEmails: () => (adminEmails || []).slice(),
  };
}

module.exports = { createFileStore };
