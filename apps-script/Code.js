/**
 * Apps Script web app: a JSON API over two Google Sheets.
 *
 *   ROSTER_SPREADSHEET_ID  school roster (Student ID, First Name, Last Name, Grade, Teacher). Read-only.
 *   DATA_SPREADSHEET_ID    everything the app writes: Settings, Students, Minutes, Books, Contacts tabs.
 *   ROSTER_SHEET_NAME      optional; defaults to the roster's first tab.
 *   GOOGLE_CLIENT_ID       OAuth client ID used by "Sign in with Google" on the organizer page.
 *                          Organizers are the data spreadsheet's owner and editors.
 *   STRIPE_API_KEY         restricted key (rk_...) with read access to Checkout Sessions,
 *                          PaymentIntents and Charges. Used only to total donations.
 *   STRIPE_PAYMENT_LINK_ID the donation Payment Link (plink_...); only its payments count.
 *
 * These live in Script Properties (Project Settings > Script properties).
 * Run setup() once from the editor to create anything that's missing. It also
 * installs the weekly trigger that runs sendWeeklyUpdates() on Sunday evenings
 * and the 10-minute trigger that runs syncDonationsNow().
 */

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (!params.action) return jsonOutput({ ok: true, data: { service: 'readathon', status: 'ready' } });
  return jsonOutput(handleApi(createSheetsStore(), createGasEnv(), params));
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOutput({ ok: false, error: 'Invalid request.', status: 400 });
  }
  return jsonOutput(handleApi(createSheetsStore(), createGasEnv(), req));
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function createGasEnv() {
  var tz = Session.getScriptTimeZone();
  var props = PropertiesService.getScriptProperties();
  var stripeKey = props.getProperty('STRIPE_API_KEY');
  return {
    today: function () { return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'); },
    now: function () { return new Date().toISOString(); },
    randomBytes: function (n) {
      // Utilities.getUuid() is backed by a secure random generator.
      var hex = '';
      while (hex.length < n * 2) hex += Utilities.getUuid().replace(/-/g, '');
      var out = [];
      for (var i = 0; i < n; i++) out.push(parseInt(hex.substr(i * 2, 2), 16));
      return out;
    },
    googleClientId: PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID'),
    verifyGoogleIdToken: verifyGoogleIdToken,
    // Sent from the account that deployed the script, which has a daily quota
    // (about 100 recipients for Gmail, 1,500 for Google Workspace).
    sendEmail: function (msg) {
      var opts = { to: msg.to, subject: msg.subject, body: msg.body, htmlBody: msg.htmlBody, name: msg.name };
      if (msg.replyTo) opts.replyTo = msg.replyTo;
      MailApp.sendEmail(opts);
    },
    emailQuota: function () { return MailApp.getRemainingDailyQuota(); },
    stripeGet: stripeKey ? function (path, query) { return stripeGet(stripeKey, path, query); } : null,
    stripePaymentLinkId: props.getProperty('STRIPE_PAYMENT_LINK_ID'),
    donationLinkUrl: props.getProperty('STRIPE_PAYMENT_LINK_URL'),
    log: function (msg) { console.error(msg); },
  };
}

/**
 * Asks Google to validate a Sign in with Google ID token (signature and expiry)
 * and returns its claims, or null. Core.js checks audience, issuer, expiry and
 * email. Results are cached briefly so each admin click isn't a round trip.
 */
function verifyGoogleIdToken(idToken) {
  var cache = CacheService.getScriptCache();
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken);
  var key = 'idt:' + Utilities.base64EncodeWebSafe(digest);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  var claims = JSON.parse(res.getContentText());
  cache.put(key, JSON.stringify(claims), 600);
  return claims;
}

/** GET from the Stripe API; throws with Stripe's error message on failure. */
function stripeGet(key, path, query) {
  var qs = Object.keys(query || {}).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]);
  }).join('&');
  var res = UrlFetchApp.fetch('https://api.stripe.com' + path + (qs ? '?' + qs : ''), {
    headers: { Authorization: 'Bearer ' + key },
    muteHttpExceptions: true,
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { /* not JSON */ }
  if (res.getResponseCode() !== 200) {
    throw new Error((body.error && body.error.message) || 'HTTP ' + res.getResponseCode());
  }
  return body;
}

function createSheetsStore() {
  var props = PropertiesService.getScriptProperties();
  var tz = Session.getScriptTimeZone();
  var dataSs = null;

  function data() {
    if (!dataSs) {
      var id = props.getProperty('DATA_SPREADSHEET_ID');
      if (!id) throw new ApiError('DATA_SPREADSHEET_ID is not set. Run setup() in Apps Script.', 500);
      dataSs = SpreadsheetApp.openById(id);
    }
    return dataSs;
  }

  function sheet(name) {
    var sh = data().getSheetByName(name);
    if (!sh) throw new ApiError('The data spreadsheet has no "' + name + '" tab. Run setup() in Apps Script.', 500);
    return sh;
  }

  // Sheets turns typed-looking strings into dates/numbers/formulas. A leading
  // apostrophe stores the text literally (and is not returned by getValues).
  function toCell(v) {
    if (typeof v === 'string' && v !== '') return "'" + v;
    return v === null || v === undefined ? '' : v;
  }

  function fromCell(v) {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return v;
  }

  function readSheet(sh) {
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [] };
    var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
    return {
      headers: values[0].map(String),
      rows: values.slice(1).map(function (r) { return r.map(fromCell); }),
    };
  }

  return {
    readTable: function (name) {
      return readSheet(sheet(name));
    },
    appendRows: function (name, rows) {
      if (!rows.length) return;
      var sh = sheet(name);
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length)
        .setValues(rows.map(function (r) { return r.map(toCell); }));
    },
    updateRow: function (name, index, values) {
      sheet(name).getRange(index + 2, 1, 1, values.length).setValues([values.map(toCell)]);
    },
    deleteRows: function (name, indexes) {
      var sh = sheet(name);
      indexes.slice().sort(function (a, b) { return b - a; })
        .forEach(function (i) { sh.deleteRow(i + 2); });
    },
    replaceRows: function (name, rows) {
      var sh = sheet(name);
      var lastRow = sh.getLastRow();
      if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).clearContent();
      if (rows.length) {
        sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows.map(function (r) { return r.map(toCell); }));
      }
    },
    readRoster: function () {
      var id = props.getProperty('ROSTER_SPREADSHEET_ID');
      if (!id) throw new ApiError('ROSTER_SPREADSHEET_ID is not set. Run setup() in Apps Script.', 500);
      var ss = SpreadsheetApp.openById(id);
      var tabName = props.getProperty('ROSTER_SHEET_NAME');
      var sh = tabName ? ss.getSheetByName(tabName) : ss.getSheets()[0];
      if (!sh) throw new ApiError('Roster tab "' + tabName + '" not found.', 500);
      return readSheet(sh);
    },
    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) throw new ApiError('The readathon is very busy right now. Please try again.', 503);
      try {
        var result = fn();
        SpreadsheetApp.flush();
        return result;
      } finally {
        lock.releaseLock();
      }
    },
    cacheGet: function (key) {
      var v = CacheService.getScriptCache().get(key);
      return v ? JSON.parse(v) : null;
    },
    cachePut: function (key, value, seconds) {
      CacheService.getScriptCache().put(key, JSON.stringify(value), seconds);
    },
    cacheRemove: function (key) {
      CacheService.getScriptCache().remove(key);
    },
    // Organizers = owner + editors of the data spreadsheet. Cached for 5 minutes,
    // so un-sharing the sheet takes up to that long to revoke access.
    adminEmails: function () {
      var cache = CacheService.getScriptCache();
      var hit = cache.get('admins:v1');
      if (hit) return JSON.parse(hit);
      var ss = data();
      var emails = ss.getEditors().map(function (u) { return u.getEmail(); });
      var owner = ss.getOwner();
      if (owner) emails.push(owner.getEmail());
      emails = emails.filter(String);
      cache.put('admins:v1', JSON.stringify(emails), 300);
      return emails;
    },
  };
}

/**
 * One-time setup. Run from the Apps Script editor (select "setup", click Run).
 * Creates the data spreadsheet and its tabs, a sample roster if none is
 * configured. Safe to run again; it only fills in gaps.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();

  var rosterId = props.getProperty('ROSTER_SPREADSHEET_ID');
  if (!rosterId) {
    var roster = SpreadsheetApp.create('Readathon Roster');
    roster.getSheets()[0].setName('Students').getRange(1, 1, 4, 5).setValues([
      ['Student ID', 'First Name', 'Last Name', 'Grade', 'Teacher'],
      ['1001', 'Avery', 'Example', 'K', 'Ms. Rivera'],
      ['1002', 'Jordan', 'Sample', '3', 'Mr. Chen'],
      ['1003', 'Riley', 'Test', '3', 'Mr. Chen'],
    ]);
    rosterId = roster.getId();
    props.setProperty('ROSTER_SPREADSHEET_ID', rosterId);
    console.log('Created sample roster: ' + roster.getUrl() + ' (replace the sample rows with your students)');
  }

  var dataId = props.getProperty('DATA_SPREADSHEET_ID');
  var ss = dataId ? SpreadsheetApp.openById(dataId) : SpreadsheetApp.create('Readathon Data');
  if (!dataId) props.setProperty('DATA_SPREADSHEET_ID', ss.getId());

  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SCHEMA[name];
    var existing = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    var missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
    if (missing.length) {
      sh.getRange(1, existing.filter(String).length + 1, 1, missing.length).setValues([missing]);
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);

  installWeeklyTrigger();
  installDonationTrigger();
  var link = props.getProperty('STRIPE_PAYMENT_LINK_URL') || '';
  if (!/^https:\/\/(donate|buy)\.stripe\.com\/[A-Za-z0-9_]+$/.test(link)) {
    console.warn('STRIPE_PAYMENT_LINK_URL is not a https://donate.stripe.com/... link, so donation pages have no donate button. See the README.');
  } else if (/\/test_/.test(link)) {
    console.warn('STRIPE_PAYMENT_LINK_URL is a Stripe test-mode link: donors can only use test cards.');
  }
  if (!props.getProperty('STRIPE_API_KEY') || !props.getProperty('STRIPE_PAYMENT_LINK_ID')) {
    console.warn('STRIPE_API_KEY / STRIPE_PAYMENT_LINK_ID are not set, so donation totals stay off. See the README.');
  } else {
    syncDonationsNow();
  }
  console.log('Email quota left today: ' + MailApp.getRemainingDailyQuota());

  var result = syncRosterNow();
  console.log('Data spreadsheet: ' + ss.getUrl());
  console.log('Organizers: anyone with edit access to the data spreadsheet. Share it to add organizers.');
  if (!props.getProperty('GOOGLE_CLIENT_ID')) {
    console.warn('GOOGLE_CLIENT_ID is not set yet, so nobody can sign in to /admin. See the README.');
  }
  console.log('Roster sync: ' + JSON.stringify(result));
}

/**
 * Time-driven trigger (installed by setup): emails weekly progress updates.
 * If it runs out of time before everyone is emailed, it schedules itself to
 * continue a few minutes later. Addresses already updated this week are skipped.
 */
function sendWeeklyUpdates() {
  var props = PropertiesService.getScriptProperties();
  var pending = props.getProperty('WEEKLY_CONTINUATION_TRIGGER');
  if (pending) {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getUniqueId() === pending) ScriptApp.deleteTrigger(t); });
    props.deleteProperty('WEEKLY_CONTINUATION_TRIGGER');
  }
  var ctx = { store: createSheetsStore(), env: createGasEnv(), req: {}, memo: {} };
  var result = runWeeklyUpdates(ctx);
  console.log('Weekly updates: ' + JSON.stringify(result));
  if (result.remaining && MailApp.getRemainingDailyQuota() > 0) {
    var t = ScriptApp.newTrigger('sendWeeklyUpdates').timeBased().after(5 * 60 * 1000).create();
    props.setProperty('WEEKLY_CONTINUATION_TRIGGER', t.getUniqueId());
  } else if (result.remaining) {
    console.warn(result.remaining + ' weekly update(s) not sent: the daily email quota ran out.');
  }
}

/** Time-driven trigger (installed by setup): copies donations from Stripe into the Donations tab. */
function syncDonationsNow() {
  var env = createGasEnv();
  if (!env.stripeGet || !env.stripePaymentLinkId) return; // Stripe not set up yet
  var ctx = { store: createSheetsStore(), env: env, req: {}, memo: {} };
  console.log('Donations: ' + JSON.stringify(syncDonations(ctx)));
}

function installDonationTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncDonationsNow'; });
  if (exists) return;
  ScriptApp.newTrigger('syncDonationsNow').timeBased().everyMinutes(10).create();
  console.log('Installed the donation sync trigger (every 10 minutes).');
}

function installWeeklyTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'sendWeeklyUpdates' && t.getEventType() === ScriptApp.EventType.CLOCK &&
      t.getUniqueId() !== PropertiesService.getScriptProperties().getProperty('WEEKLY_CONTINUATION_TRIGGER');
  });
  if (exists) return;
  ScriptApp.newTrigger('sendWeeklyUpdates').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(17).create();
  console.log('Installed the weekly update trigger (Sundays around 5pm, script time zone).');
}

/** Assigns links to new roster students. Run manually or from a time-driven trigger. */
function syncRosterNow() {
  var store = createSheetsStore();
  var ctx = { store: store, env: createGasEnv(), req: {}, memo: {} };
  return store.withLock(function () {
    var result = syncRoster(ctx);
    store.cacheRemove(AGG_CACHE_KEY);
    store.cacheRemove(ROSTER_CACHE_KEY);
    return result;
  });
}
