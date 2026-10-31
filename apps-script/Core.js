/**
 * Readathon core logic.
 *
 * Plain JavaScript shared by the Apps Script web app (Code.js) and the local
 * dev server (dev/server.js). All storage goes through a `store` object and
 * all environment-specific behavior (clock, randomness, secrets) through an
 * `env` object, so this file never touches SpreadsheetApp directly.
 *
 * store: readTable(name) -> {headers, rows}, appendRows(name, rows),
 *        updateRow(name, index, values), deleteRows(name, indexes),
 *        replaceRows(name, rows), readRoster() -> {headers, rows},
 *        withLock(fn), cacheGet(key), cachePut(key, value, seconds), cacheRemove(key),
 *        adminEmails() -> emails of the data spreadsheet's owner and editors
 * env:   today() -> 'yyyy-MM-dd', now() -> ISO string, randomBytes(n) -> int[],
 *        googleClientId, verifyGoogleIdToken(idToken) -> Google's token claims or null,
 *        sendEmail({to, subject, body, htmlBody, name, replyTo}), emailQuota() -> emails left today,
 *        stripeGet(path, query) -> parsed JSON (null when no Stripe key is configured),
 *        stripePaymentLinkId -> the donation Payment Link (plink_...) whose payments count,
 *        donationLinkUrl -> that Payment Link's https://donate.stripe.com/... URL,
 *        siteUrl -> optional; overrides SITE_URL (the dev server uses localhost),
 *        log(message)
 */

var SCHEMA = {
  Settings: ['key', 'value'],
  Students: ['studentId', 'studentName', 'grade', 'teacher', 'token', 'code', 'goalMinutes',
    'showReadingList', 'showTotalMinutes', 'showClassMinutes', 'createdAt', 'updatedAt', 'showRaised'],
  Minutes: ['studentId', 'date', 'minutes', 'updatedAt'],
  Books: ['bookId', 'studentId', 'title', 'author', 'status', 'coverId', 'isbn', 'addedAt', 'finishedAt'],
  Contacts: ['studentId', 'email', 'weeklyUpdates', 'unsubscribeKey', 'linksSentAt', 'lastUpdateSentAt', 'addedAt'],
  // Rewritten from Stripe on every sync. Amounts are US dollars.
  Donations: ['sessionId', 'studentCode', 'amount', 'refunded', 'currency', 'paymentStatus', 'createdAt'],
};

// Where links in emails point. Not an organizer setting, so a compromised
// organizer account can't point families at a look-alike site.
var SITE_URL = 'https://readathon.bishopschoolpto.com';
// Reply-to addresses must be on the PTO's own domain, for the same reason.
var REPLY_TO_DOMAIN = 'bishopschoolpto.com';
// The donate button only ever points at a Stripe-hosted Payment Link, which
// comes from Script Properties rather than the spreadsheet.
var DONATION_LINK_RE = /^https:\/\/(donate|buy)\.stripe\.com\/[A-Za-z0-9_]+$/;

var DEFAULT_SETTINGS = {
  readathonTitle: 'Bishop Readathon',
  schoolName: 'Bishop School',
  startDate: '',
  endDate: '',
  schoolGoalMinutes: 0,
  maxMinutesPerDay: 600,
  editsLocked: false,
  nameFormat: 'firstLastInitial',
  homeShowClassTotals: true,
  defaultShowReadingList: true,
  defaultShowTotalMinutes: true,
  defaultShowClassMinutes: true,
  weeklyUpdatesEnabled: true,
  emailReplyTo: '',
  showDonationTotals: true,
  defaultShowRaised: false,
};

var SETTING_TYPES = {
  schoolGoalMinutes: 'number',
  maxMinutesPerDay: 'number',
  editsLocked: 'bool',
  homeShowClassTotals: 'bool',
  defaultShowReadingList: 'bool',
  defaultShowTotalMinutes: 'bool',
  defaultShowClassMinutes: 'bool',
  weeklyUpdatesEnabled: 'bool',
  showDonationTotals: 'bool',
  defaultShowRaised: 'bool',
  startDate: 'date',
  endDate: 'date',
};

var NAME_FORMATS = ['first', 'firstLastInitial', 'full'];
var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
var MAX_BOOKS_PER_STUDENT = 300;
var MAX_CONTACTS = 5;
var MAX_LINK_EMAILS_PER_DAY = 10; // per student, from the student page
var EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
var SEND_TIME_LIMIT_MS = 270000; // Apps Script stops a run at 6 minutes
var AGG_CACHE_KEY = 'agg:v1';
var ROSTER_CACHE_KEY = 'roster:v1';
var STRIPE_MAX_PAGES = 100; // 100 sessions per page
var GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 400;
  }
}

/** Entry point: dispatches one API request and returns {ok, data} or {ok:false, error}. */
function handleApi(store, env, req) {
  try {
    req = req || {};
    var action = ACTIONS[req.action];
    if (!action) throw new ApiError('Unknown action.');
    var ctx = { store: store, env: env, req: req, memo: {} };
    return { ok: true, data: action(ctx, req) };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message, status: err.status };
    if (env && env.log) env.log((err && err.stack) || String(err));
    return { ok: false, error: 'Something went wrong. Please try again.', status: 500 };
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function toBool(v, dflt) {
  if (v === true || v === false) return v;
  var s = str(v).toLowerCase();
  if (s === '') return dflt;
  return s === 'true' || s === 'yes' || s === '1' || s === 'y';
}

function toInt(v, dflt) {
  var n = Number(v);
  return isFinite(n) && str(v) !== '' ? Math.round(n) : dflt;
}

function isDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateStr, n) {
  var d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of dates from start to end ('yyyy-MM-dd'), capped for safety. */
function dateRange(start, end) {
  var out = [];
  for (var d = start; d <= end && out.length < 366; d = addDays(d, 1)) out.push(d);
  return out;
}

function randomString(env, length, alphabet) {
  var bytes = env.randomBytes(length);
  var out = '';
  for (var i = 0; i < length; i++) out += alphabet.charAt(bytes[i] % alphabet.length);
  return out;
}

function normHeader(h) {
  return str(h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function compareGrades(a, b) {
  var rank = function (g) {
    var s = str(g).toUpperCase();
    if (s === 'PK' || s === 'PRE-K' || s === 'PREK') return -2;
    if (s === 'TK') return -1;
    if (s === 'K' || s === 'KINDER' || s === 'KINDERGARTEN') return 0;
    var n = parseInt(s.replace(/[^0-9]/g, ''), 10);
    return isNaN(n) ? 100 : n;
  };
  return rank(a) - rank(b) || str(a).localeCompare(str(b));
}

// ---------------------------------------------------------------------------
// HTML escaping and links
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function siteBase(settings) {
  return str(settings.siteUrl).replace(/\/+$/, '');
}

/** The student's Stripe donation link, or '' when no valid Payment Link URL is configured. */
function donateUrl(ctx, code) {
  var link = str(ctx.env.donationLinkUrl);
  return DONATION_LINK_RE.test(link) ? link + '?client_reference_id=' + encodeURIComponent(code) : '';
}

function isReplyTo(email) {
  return isEmail(email) && email.slice(email.lastIndexOf('@') + 1) === REPLY_TO_DOMAIN;
}

function displayName(student, format) {
  if (format === 'first') return student.firstName;
  if (format === 'full') return (student.firstName + ' ' + student.lastName).trim();
  return (student.firstName + (student.lastName ? ' ' + student.lastName.charAt(0) + '.' : '')).trim();
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/** Reads a data tab into records keyed by header, each with _i (data row index) and _raw. */
function loadTable(ctx, name) {
  var key = 'table:' + name;
  if (ctx.memo[key]) return ctx.memo[key];
  var t = ctx.store.readTable(name);
  var headers = (t.headers || []).map(str);
  SCHEMA[name].forEach(function (h) {
    if (headers.indexOf(h) < 0) {
      throw new ApiError('The "' + name + '" tab is missing the "' + h + '" column. Run setup() in Apps Script.', 500);
    }
  });
  var records = (t.rows || []).map(function (row, i) {
    var rec = { _i: i, _raw: row };
    headers.forEach(function (h, j) { rec[h] = row[j]; });
    return rec;
  });
  ctx.memo[key] = { name: name, headers: headers, records: records };
  return ctx.memo[key];
}

/** Builds a row in the tab's actual column order, preserving columns the app doesn't know about. */
function toRow(table, rec) {
  return table.headers.map(function (h, j) {
    if (Object.prototype.hasOwnProperty.call(rec, h)) return rec[h] === undefined ? '' : rec[h];
    return rec._raw ? rec._raw[j] : '';
  });
}

function saveRecord(ctx, table, rec) {
  ctx.store.updateRow(table.name, rec._i, toRow(table, rec));
}

function appendRecord(ctx, table, rec) {
  ctx.store.appendRows(table.name, [toRow(table, rec)]);
  rec._i = table.records.length;
  table.records.push(rec);
}

function getSettings(ctx) {
  if (ctx.memo.settings) return ctx.memo.settings;
  var t = loadTable(ctx, 'Settings');
  var raw = {};
  t.records.forEach(function (r) { if (str(r.key)) raw[str(r.key)] = r.value; });
  var s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    s[k] = coerceSetting(k, Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : DEFAULT_SETTINGS[k]);
  });
  s.siteUrl = str(ctx.env.siteUrl) || SITE_URL; // read-only
  ctx.memo.settings = s;
  return s;
}

function coerceSetting(key, value) {
  var type = SETTING_TYPES[key];
  if (type === 'bool') return toBool(value, DEFAULT_SETTINGS[key]);
  if (type === 'number') return Math.max(0, toInt(value, DEFAULT_SETTINGS[key]));
  if (type === 'date') return isDateStr(str(value)) ? str(value) : '';
  if (key === 'nameFormat') return NAME_FORMATS.indexOf(str(value)) >= 0 ? str(value) : DEFAULT_SETTINGS.nameFormat;
  // Checked again on read, so an address typed straight into the sheet is ignored too.
  if (key === 'emailReplyTo') return isReplyTo(normEmail(value)) ? normEmail(value) : '';
  return str(value);
}

function publicSettings(s) {
  return {
    readathonTitle: s.readathonTitle,
    schoolName: s.schoolName,
    startDate: s.startDate,
    endDate: s.endDate,
    schoolGoalMinutes: s.schoolGoalMinutes,
    maxMinutesPerDay: s.maxMinutesPerDay,
    editsLocked: s.editsLocked,
  };
}

/** Parses the school roster, tolerating common header spellings. */
function parseRoster(raw) {
  var norm = (raw.headers || []).map(normHeader);
  var find = function (cands) {
    for (var i = 0; i < cands.length; i++) {
      var j = norm.indexOf(cands[i]);
      if (j >= 0) return j;
    }
    return -1;
  };
  var iId = find(['studentid', 'id', 'studentnumber', 'studentno', 'sid']);
  var iFirst = find(['firstname', 'first', 'studentfirstname', 'givenname', 'preferredname']);
  var iLast = find(['lastname', 'last', 'studentlastname', 'surname', 'familyname']);
  var iName = find(['studentname', 'name', 'fullname']);
  var iGrade = find(['grade', 'gradelevel', 'gr']);
  var iTeacher = find(['teacher', 'teachername', 'homeroomteacher', 'homeroom', 'classroom', 'class']);
  if (iId < 0) throw new ApiError('The roster needs a "Student ID" column (any unique value per student).', 500);
  if (iFirst < 0 && iName < 0) throw new ApiError('The roster needs "First Name"/"Last Name" or "Student Name" columns.', 500);

  var list = [];
  var byId = {};
  (raw.rows || []).forEach(function (r) {
    var id = str(r[iId]);
    if (!id || byId[id]) return;
    var first = iFirst >= 0 ? str(r[iFirst]) : '';
    var last = iLast >= 0 ? str(r[iLast]) : '';
    if (!first && iName >= 0) {
      var full = str(r[iName]);
      if (full.indexOf(',') >= 0) {
        last = str(full.split(',')[0]);
        first = str(full.split(',').slice(1).join(','));
      } else {
        var parts = full.split(/\s+/);
        first = parts.shift() || '';
        last = parts.join(' ');
      }
    }
    if (!first && !last) return;
    var s = {
      studentId: id,
      firstName: first,
      lastName: last,
      grade: iGrade >= 0 ? str(r[iGrade]) : '',
      teacher: iTeacher >= 0 ? str(r[iTeacher]) : '',
    };
    byId[id] = s;
    list.push(s);
  });
  return { list: list, byId: byId };
}

function getRoster(ctx, fresh) {
  if (ctx.memo.roster && !fresh) return ctx.memo.roster;
  var raw = fresh ? null : cacheGet(ctx, ROSTER_CACHE_KEY);
  if (!raw) {
    raw = ctx.store.readRoster();
    cachePut(ctx, ROSTER_CACHE_KEY, raw, 300);
  }
  ctx.memo.roster = parseRoster(raw);
  return ctx.memo.roster;
}

function cacheGet(ctx, key) {
  try { return ctx.store.cacheGet ? ctx.store.cacheGet(key) : null; } catch (e) { return null; }
}

function cachePut(ctx, key, value, seconds) {
  try { if (ctx.store.cachePut) ctx.store.cachePut(key, value, seconds); } catch (e) { /* too big to cache */ }
}

function cacheRemove(ctx, key) {
  try { if (ctx.store.cacheRemove) ctx.store.cacheRemove(key); } catch (e) { /* ignore */ }
}

function classKey(student) {
  return student.teacher ? 't:' + student.teacher : 'g:' + student.grade;
}

/** Minutes totals per student and per class, counting only days inside the readathon. */
function getAggregates(ctx, useCache) {
  if (ctx.memo.agg) return ctx.memo.agg;
  var cached = useCache ? cacheGet(ctx, AGG_CACHE_KEY) : null;
  if (cached) return (ctx.memo.agg = cached);
  var settings = getSettings(ctx);
  var roster = getRoster(ctx);
  var byStudent = {};
  loadTable(ctx, 'Minutes').records.forEach(function (r) {
    var id = str(r.studentId);
    var date = str(r.date);
    var m = toInt(r.minutes, 0);
    if (!id || m <= 0 || !roster.byId[id]) return;
    if (settings.startDate && date < settings.startDate) return;
    if (settings.endDate && date > settings.endDate) return;
    var e = byStudent[id] || (byStudent[id] = { minutes: 0, days: 0 });
    e.minutes += m;
    e.days += 1;
  });
  var raised = donationTotals(ctx, roster);
  var byClass = {};
  roster.list.forEach(function (s) {
    var k = classKey(s);
    var c = byClass[k] || (byClass[k] = { teacher: s.teacher, grade: s.grade, minutes: 0, students: 0, readers: 0, raised: 0 });
    var e = byStudent[s.studentId];
    c.students += 1;
    c.raised += raised.byStudent[s.studentId] || 0;
    if (e) { c.minutes += e.minutes; c.readers += 1; }
  });
  ctx.memo.agg = { byStudent: byStudent, byClass: byClass, raised: raised };
  cachePut(ctx, AGG_CACHE_KEY, ctx.memo.agg, 60);
  return ctx.memo.agg;
}

/**
 * Paid donations (in cents, net of refunds) per student and school-wide.
 * Donations whose code doesn't match a current student still count toward
 * the school total.
 */
function donationTotals(ctx, roster) {
  var idByCode = {};
  loadTable(ctx, 'Students').records.forEach(function (r) {
    if (str(r.code)) idByCode[str(r.code).toUpperCase()] = str(r.studentId);
  });
  var out = { total: 0, count: 0, byStudent: {}, countByStudent: {} };
  loadTable(ctx, 'Donations').records.forEach(function (r) {
    if (str(r.paymentStatus) !== 'paid' || str(r.currency).toLowerCase() !== 'usd') return;
    var cents = Math.round(Number(r.amount || 0) * 100) - Math.round(Number(r.refunded || 0) * 100);
    if (!(cents > 0)) return;
    out.total += cents;
    out.count += 1;
    var id = idByCode[str(r.studentCode).toUpperCase()];
    if (id && roster.byId[id]) {
      out.byStudent[id] = (out.byStudent[id] || 0) + cents;
      out.countByStudent[id] = (out.countByStudent[id] || 0) + 1;
    }
  });
  return out;
}

/** Internal values kept in the Settings tab that organizers don't edit (e.g. donationsSyncedAt). */
function getStatusValue(ctx, key) {
  var recs = loadTable(ctx, 'Settings').records;
  for (var i = 0; i < recs.length; i++) if (str(recs[i].key) === key) return recs[i].value;
  return '';
}

/** Inserts or updates Settings rows. Call while holding the lock. */
function putSettingsRows(ctx, values) {
  var table = loadTable(ctx, 'Settings');
  Object.keys(values).forEach(function (k) {
    var rec = null;
    for (var i = 0; i < table.records.length; i++) {
      if (str(table.records[i].key) === k) { rec = table.records[i]; break; }
    }
    if (rec) {
      rec.value = values[k];
      saveRecord(ctx, table, rec);
    } else {
      appendRecord(ctx, table, { key: k, value: values[k] });
    }
  });
  ctx.memo.settings = null;
}

/** Donation totals are public once a sync has run and organizers haven't turned them off. */
function donationTotalsVisible(ctx) {
  return getSettings(ctx).showDonationTotals && !!str(getStatusValue(ctx, 'donationsSyncedAt'));
}

function findStudentRecord(ctx, field, value) {
  var v = str(value);
  if (!v) return null;
  if (field === 'code') v = v.toUpperCase();
  var recs = loadTable(ctx, 'Students').records;
  for (var i = 0; i < recs.length; i++) {
    var rv = str(recs[i][field]);
    if (field === 'code') rv = rv.toUpperCase();
    if (rv === v) return recs[i];
  }
  return null;
}

/** Resolves a private student token to the roster entry + Students record. */
function requireStudent(ctx, token) {
  var rec = /^[A-Za-z0-9]{12,64}$/.test(str(token)) ? findStudentRecord(ctx, 'token', token) : null;
  var info = rec ? getRoster(ctx).byId[str(rec.studentId)] : null;
  if (!info) throw new ApiError('We could not find this reading log. Please check your link.', 404);
  return { rec: rec, info: withCode(info, rec) };
}

function withCode(info, rec) {
  var out = {};
  Object.keys(info).forEach(function (k) { out[k] = info[k]; });
  out.code = str(rec.code);
  return out;
}

function prefsOf(rec, settings) {
  return {
    showReadingList: toBool(rec.showReadingList, settings.defaultShowReadingList),
    showTotalMinutes: toBool(rec.showTotalMinutes, settings.defaultShowTotalMinutes),
    showClassMinutes: toBool(rec.showClassMinutes, settings.defaultShowClassMinutes),
    showRaised: toBool(rec.showRaised, settings.defaultShowRaised),
    goalMinutes: Math.max(0, toInt(rec.goalMinutes, 0)),
  };
}

function booksFor(ctx, studentId) {
  return loadTable(ctx, 'Books').records
    .filter(function (b) { return str(b.studentId) === studentId; })
    .map(publicBook);
}

function publicBook(b) {
  return {
    bookId: str(b.bookId),
    title: str(b.title),
    author: str(b.author),
    status: str(b.status) === 'reading' ? 'reading' : 'finished',
    coverId: str(b.coverId),
    isbn: str(b.isbn),
    addedAt: str(b.addedAt),
    finishedAt: str(b.finishedAt),
  };
}

/** The days a student may log: readathon start through min(end, today). */
function loggableDays(settings, today) {
  var start = settings.startDate || today;
  var end = settings.endDate && settings.endDate < today ? settings.endDate : today;
  return start > end ? [] : dateRange(start, end);
}

function invalidateAggregates(ctx) {
  ctx.memo.agg = null;
  cacheRemove(ctx, AGG_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

var ACTIONS = {
  home: function (ctx) {
    var s = getSettings(ctx);
    var roster = getRoster(ctx);
    var agg = getAggregates(ctx, true);
    var total = 0;
    var readers = 0;
    var grades = {};
    roster.list.forEach(function (st) {
      var e = agg.byStudent[st.studentId];
      var g = grades[st.grade] || (grades[st.grade] = { grade: st.grade, minutes: 0, students: 0, readers: 0, raised: 0 });
      g.students += 1;
      g.raised += agg.raised.byStudent[st.studentId] || 0;
      if (e) { total += e.minutes; readers += 1; g.minutes += e.minutes; g.readers += 1; }
    });
    var allClasses = Object.keys(agg.byClass).map(function (k) { return agg.byClass[k]; });
    var classes = s.homeShowClassTotals ? allClasses.map(withoutRaised)
      .sort(function (a, b) { return b.minutes - a.minutes || compareGrades(a.grade, b.grade); }) : null;
    var gradeList = Object.keys(grades).map(function (k) { return grades[k]; })
      .sort(function (a, b) { return compareGrades(a.grade, b.grade); });
    var donations = null;
    if (donationTotalsVisible(ctx)) {
      donations = {
        total: agg.raised.total,
        count: agg.raised.count,
        grades: gradeList.map(function (g) { return { grade: g.grade, raised: g.raised }; }),
        classes: allClasses.map(function (c) { return { teacher: c.teacher, grade: c.grade, raised: c.raised }; })
          .sort(function (a, b) { return b.raised - a.raised || compareGrades(a.grade, b.grade); }),
      };
    }
    return {
      settings: publicSettings(s),
      today: ctx.env.today(),
      totalMinutes: total,
      readers: readers,
      studentCount: roster.list.length,
      grades: gradeList.map(withoutRaised),
      classes: classes,
      donations: donations,
    };
  },

  'student.get': function (ctx, req) {
    var st = requireStudent(ctx, req.token);
    var s = getSettings(ctx);
    var today = ctx.env.today();
    var id = st.info.studentId;
    var logged = {};
    loadTable(ctx, 'Minutes').records.forEach(function (r) {
      if (str(r.studentId) === id) logged[str(r.date)] = toInt(r.minutes, 0);
    });
    var days = loggableDays(s, today).map(function (d) { return { date: d, minutes: logged[d] || 0 }; });
    var agg = getAggregates(ctx, false);
    var cls = agg.byClass[classKey(st.info)] || { minutes: 0, students: 0 };
    var mine = agg.byStudent[id] || { minutes: 0, days: 0 };
    return {
      student: {
        firstName: st.info.firstName,
        lastName: st.info.lastName,
        grade: st.info.grade,
        teacher: st.info.teacher,
        code: st.info.code,
      },
      settings: publicSettings(s),
      today: today,
      days: days,
      totalMinutes: mine.minutes,
      daysRead: mine.days,
      classMinutes: cls.minutes,
      classSize: cls.students,
      prefs: prefsOf(st.rec, s),
      books: booksFor(ctx, id),
      contacts: contactsFor(ctx, id).map(publicContact),
      maxContacts: MAX_CONTACTS,
      donationTotalsEnabled: donationTotalsVisible(ctx),
      raised: donationTotalsVisible(ctx) ? agg.raised.byStudent[id] || 0 : undefined,
      weeklyUpdatesEnabled: s.weeklyUpdatesEnabled,
    };
  },

  'student.setMinutes': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var s = getSettings(ctx);
      if (s.editsLocked) throw new ApiError('The reading log is locked. Ask your teacher if something needs fixing.', 403);
      var date = str(req.date);
      if (loggableDays(s, ctx.env.today()).indexOf(date) < 0) {
        throw new ApiError('You can only log minutes for readathon days up to today.');
      }
      var minutes = Number(req.minutes);
      if (!isFinite(minutes) || minutes < 0 || Math.round(minutes) !== minutes) {
        throw new ApiError('Minutes must be a whole number.');
      }
      if (minutes > s.maxMinutesPerDay) {
        throw new ApiError('That is more than ' + s.maxMinutesPerDay + ' minutes in one day. Please double-check.');
      }
      var table = loadTable(ctx, 'Minutes');
      var id = st.info.studentId;
      var existing = null;
      for (var i = 0; i < table.records.length; i++) {
        var r = table.records[i];
        if (str(r.studentId) === id && str(r.date) === date) { existing = r; break; }
      }
      var now = ctx.env.now();
      if (existing) {
        existing.minutes = minutes;
        existing.updatedAt = now;
        saveRecord(ctx, table, existing);
      } else if (minutes > 0) {
        appendRecord(ctx, table, { studentId: id, date: date, minutes: minutes, updatedAt: now });
      }
      invalidateAggregates(ctx);
      var agg = getAggregates(ctx, false);
      var mine = agg.byStudent[id] || { minutes: 0, days: 0 };
      var cls = agg.byClass[classKey(st.info)] || { minutes: 0 };
      return { date: date, minutes: minutes, totalMinutes: mine.minutes, daysRead: mine.days, classMinutes: cls.minutes };
    });
  },

  'student.setPrefs': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var s = getSettings(ctx);
      var rec = st.rec;
      var current = prefsOf(rec, s);
      ['showReadingList', 'showTotalMinutes', 'showClassMinutes', 'showRaised'].forEach(function (k) {
        if (req[k] !== undefined) rec[k] = toBool(req[k], current[k]);
      });
      if (req.goalMinutes !== undefined) {
        var goal = toInt(req.goalMinutes, -1);
        if (goal < 0 || goal > 100000) throw new ApiError('Goal must be between 0 and 100,000 minutes.');
        rec.goalMinutes = goal;
      }
      rec.updatedAt = ctx.env.now();
      saveRecord(ctx, loadTable(ctx, 'Students'), rec);
      return { prefs: prefsOf(rec, s) };
    });
  },

  /** Replaces the student's contact emails and emails the links to any new address. */
  'student.setContacts': function (ctx, req) {
    var list = validateContacts(req.contacts);
    var st = null;
    var added = ctx.store.withLock(function () {
      st = requireStudent(ctx, req.token);
      return saveContacts(ctx, st.info.studentId, list);
    });
    // Anyone with the log link can add addresses, so cap how many link emails it can trigger.
    var key = 'linkmail:' + st.info.studentId + ':' + ctx.env.today();
    var used = Number(cacheGet(ctx, key)) || 0;
    var allowed = added.slice(0, Math.max(0, MAX_LINK_EMAILS_PER_DAY - used));
    var result = deliverLinks(ctx, allowed.map(function (c) { return contactItem(ctx, c); }).filter(Boolean));
    cachePut(ctx, key, used + allowed.length, 86400);
    if (allowed.length < added.length) result.remaining += added.length - allowed.length;
    delete result.quotaLeft; // organizers' business, not the student page's
    result.contacts = contactsFor(ctx, st.info.studentId).map(publicContact);
    return result;
  },

  'contact.unsubscribe': function (ctx, req) {
    var key = str(req.key);
    if (!/^[A-Za-z0-9]{12,64}$/.test(key)) throw new ApiError('This unsubscribe link is not valid.', 404);
    return ctx.store.withLock(function () {
      var table = loadTable(ctx, 'Contacts');
      var match = null;
      table.records.forEach(function (r) { if (str(r.unsubscribeKey) === key) match = r; });
      if (!match) throw new ApiError('This unsubscribe link is not valid. It may belong to an email address that was removed.', 404);
      // Stop weekly updates to this address for every student it follows.
      var email = normEmail(match.email);
      table.records.forEach(function (r) {
        if (normEmail(r.email) === email && toBool(r.weeklyUpdates, false)) {
          r.weeklyUpdates = false;
          saveRecord(ctx, table, r);
        }
      });
      return { email: email };
    });
  },

  'student.addBook': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var book = validateBook(req);
      var table = loadTable(ctx, 'Books');
      var id = st.info.studentId;
      var mine = table.records.filter(function (b) { return str(b.studentId) === id; });
      if (mine.length >= MAX_BOOKS_PER_STUDENT) throw new ApiError('That is a lot of books! The list is full.');
      if (book.status === 'reading') {
        // A student has one "currently reading" book; starting a new one replaces it.
        var stale = mine.filter(function (b) { return str(b.status) === 'reading'; }).map(function (b) { return b._i; });
        if (stale.length) {
          ctx.store.deleteRows('Books', stale);
          delete ctx.memo['table:Books'];
          table = loadTable(ctx, 'Books');
        }
      }
      var now = ctx.env.now();
      var rec = {
        bookId: randomString(ctx.env, 10, TOKEN_ALPHABET),
        studentId: id,
        title: book.title,
        author: book.author,
        status: book.status,
        coverId: book.coverId,
        isbn: book.isbn,
        addedAt: now,
        finishedAt: book.status === 'finished' ? now : '',
      };
      appendRecord(ctx, table, rec);
      return { book: publicBook(rec), books: booksFor(ctx, id) };
    });
  },

  'student.updateBook': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var table = loadTable(ctx, 'Books');
      var rec = findBook(table, st.info.studentId, req.bookId);
      if (req.status === 'finished' && str(rec.status) !== 'finished') {
        rec.status = 'finished';
        rec.finishedAt = ctx.env.now();
      } else if (req.status === 'reading') {
        rec.status = 'reading';
        rec.finishedAt = '';
      }
      saveRecord(ctx, table, rec);
      return { books: booksFor(ctx, st.info.studentId) };
    });
  },

  'student.deleteBook': function (ctx, req) {
    return ctx.store.withLock(function () {
      var st = requireStudent(ctx, req.token);
      var table = loadTable(ctx, 'Books');
      var rec = findBook(table, st.info.studentId, req.bookId);
      ctx.store.deleteRows('Books', [rec._i]);
      delete ctx.memo['table:Books'];
      return { books: booksFor(ctx, st.info.studentId) };
    });
  },

  'donation.get': function (ctx, req) {
    var code = str(req.code).toUpperCase();
    var rec = /^[A-Z0-9]{4,12}$/.test(code) ? findStudentRecord(ctx, 'code', code) : null;
    var info = rec ? getRoster(ctx).byId[str(rec.studentId)] : null;
    if (!info) throw new ApiError('We could not find that reader. Please check the link.', 404);
    var student = withCode(info, rec);
    var s = getSettings(ctx);
    var prefs = prefsOf(rec, s);
    var agg = getAggregates(ctx, true);
    var mine = agg.byStudent[info.studentId] || { minutes: 0, days: 0 };
    var cls = agg.byClass[classKey(info)] || { minutes: 0, students: 0 };
    var out = {
      settings: publicSettings(s),
      student: {
        name: displayName(student, s.nameFormat),
        firstName: student.firstName,
        grade: student.grade,
        teacher: student.teacher,
        code: student.code,
      },
      prefs: {
        showReadingList: prefs.showReadingList,
        showTotalMinutes: prefs.showTotalMinutes,
        showClassMinutes: prefs.showClassMinutes,
        showRaised: prefs.showRaised,
      },
      donateUrl: donateUrl(ctx, student.code),
    };
    // Sections the student hasn't filled in yet are left off rather than shown empty.
    if (prefs.showTotalMinutes && mine.days > 0) {
      out.totalMinutes = mine.minutes;
      out.daysRead = mine.days;
      out.goalMinutes = prefs.goalMinutes;
    }
    if (prefs.showClassMinutes) {
      out.classMinutes = cls.minutes;
      out.classSize = cls.students;
    }
    if (prefs.showReadingList) {
      var books = booksFor(ctx, info.studentId);
      if (books.length) out.books = books;
    }
    if (prefs.showRaised && donationTotalsVisible(ctx)) {
      out.raised = agg.raised.byStudent[info.studentId] || 0;
      out.donationCount = agg.raised.countByStudent[info.studentId] || 0;
    }
    return out;
  },

  'admin.login': function (ctx, req) {
    return { email: requireAdmin(ctx, req).email };
  },

  'admin.overview': function (ctx, req) {
    var admin = requireAdmin(ctx, req);
    var s = getSettings(ctx);
    var roster = getRoster(ctx, true);
    var agg = getAggregates(ctx, false);
    var recById = {};
    loadTable(ctx, 'Students').records.forEach(function (r) { recById[str(r.studentId)] = r; });
    var contactsById = {};
    loadTable(ctx, 'Contacts').records.forEach(function (r) {
      var id = str(r.studentId);
      (contactsById[id] = contactsById[id] || []).push(r);
    });
    var bookCounts = {};
    loadTable(ctx, 'Books').records.forEach(function (b) {
      var id = str(b.studentId);
      bookCounts[id] = (bookCounts[id] || 0) + 1;
    });
    var students = roster.list.map(function (st) {
      var rec = recById[st.studentId];
      var e = agg.byStudent[st.studentId] || { minutes: 0, days: 0 };
      return {
        studentId: st.studentId,
        firstName: st.firstName,
        lastName: st.lastName,
        grade: st.grade,
        teacher: st.teacher,
        token: rec ? str(rec.token) : '',
        code: rec ? str(rec.code) : '',
        minutes: e.minutes,
        days: e.days,
        books: bookCounts[st.studentId] || 0,
        raised: agg.raised.byStudent[st.studentId] || 0,
        contacts: cleanContacts(contactsById[st.studentId] || []).map(publicContact),
      };
    });
    var classes = Object.keys(agg.byClass).map(function (k) { return agg.byClass[k]; })
      .sort(function (a, b) { return compareGrades(a.grade, b.grade) || str(a.teacher).localeCompare(str(b.teacher)); });
    return {
      adminEmail: admin.email,
      settings: s,
      defaults: DEFAULT_SETTINGS,
      maxContacts: MAX_CONTACTS,
      emailQuotaLeft: emailQuotaLeft(ctx),
      donations: {
        total: agg.raised.total,
        count: agg.raised.count,
        stripeConfigured: !!(ctx.env.stripeGet && str(ctx.env.stripePaymentLinkId)),
        linkMode: donateUrl(ctx, 'X') ? (/\/test_/.test(str(ctx.env.donationLinkUrl)) ? 'test' : 'live') : '',
        syncedAt: str(getStatusValue(ctx, 'donationsSyncedAt')),
        syncError: str(getStatusValue(ctx, 'donationsSyncError')),
      },
      today: ctx.env.today(),
      students: students,
      classes: classes,
      unlinked: students.filter(function (x) { return !x.token; }).length,
    };
  },

  'admin.saveSettings': function (ctx, req) {
    requireAdmin(ctx, req);
    var incoming = req.settings || {};
    var updates = {};
    Object.keys(incoming).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) return;
      var v = incoming[k];
      if (SETTING_TYPES[k] === 'date' && str(v) && !isDateStr(str(v))) throw new ApiError('Dates must look like 2026-10-09.');
      if (k === 'emailReplyTo' && str(v) && !isReplyTo(normEmail(v))) {
        throw new ApiError('The reply-to address must be an @' + REPLY_TO_DOMAIN + ' email address.');
      }
      updates[k] = coerceSetting(k, v);
    });
    var merged = Object.assign({}, getSettings(ctx), updates);
    if (merged.startDate && merged.endDate && merged.startDate > merged.endDate) {
      throw new ApiError('The start date must be on or before the end date.');
    }
    return ctx.store.withLock(function () {
      putSettingsRows(ctx, updates);
      invalidateAggregates(ctx);
      return { settings: getSettings(ctx) };
    });
  },

  'admin.syncRoster': function (ctx, req) {
    requireAdmin(ctx, req);
    return ctx.store.withLock(function () {
      var result = syncRoster(ctx);
      invalidateAggregates(ctx);
      return result;
    });
  },

  'admin.regenerateToken': function (ctx, req) {
    requireAdmin(ctx, req);
    return ctx.store.withLock(function () {
      var rec = findStudentRecord(ctx, 'studentId', req.studentId);
      if (!rec) throw new ApiError('Student not found.', 404);
      rec.token = randomString(ctx.env, 24, TOKEN_ALPHABET);
      rec.updatedAt = ctx.env.now();
      saveRecord(ctx, loadTable(ctx, 'Students'), rec);
      return { studentId: str(rec.studentId), token: rec.token };
    });
  },

  /** Like student.setContacts; sendLinks: false saves without emailing. */
  'admin.setContacts': function (ctx, req) {
    requireAdmin(ctx, req);
    var list = validateContacts(req.contacts);
    var id = str(req.studentId);
    var added = ctx.store.withLock(function () {
      if (!findStudentRecord(ctx, 'studentId', id)) throw new ApiError('Student not found.', 404);
      return saveContacts(ctx, id, list);
    });
    var result = req.sendLinks === false ? { sent: 0, failed: [], remaining: 0 }
      : deliverLinks(ctx, added.map(function (c) { return contactItem(ctx, c); }).filter(Boolean));
    result.contacts = contactsFor(ctx, id).map(publicContact);
    return result;
  },

  /**
   * Emails each contact their student's log and donation links. With a
   * studentId, (re)sends to all of that student's contacts; otherwise sends to
   * every contact who hasn't been sent the links yet (e.g. rows pasted into the
   * Contacts tab).
   */
  'admin.emailLinks': function (ctx, req) {
    requireAdmin(ctx, req);
    ensureUnsubscribeKeys(ctx);
    return deliverLinks(ctx, planLinks(ctx, str(req.studentId)));
  },

  /**
   * Dry run for the organizer's confirmation: how many emails a bulk send
   * would use (kind 'links', optionally for one studentId, or 'weekly') and
   * how many Google still allows today.
   */
  'admin.previewEmails': function (ctx, req) {
    requireAdmin(ctx, req);
    var out = { emails: 0, students: 0, quotaLeft: emailQuotaLeft(ctx) };
    var groups;
    if (req.kind === 'weekly') {
      var plan = planWeekly(ctx);
      if (plan.skipped) { out.skipped = plan.skipped; return out; }
      groups = plan.groups;
    } else {
      groups = groupByEmail(planLinks(ctx, str(req.studentId)));
    }
    var students = {};
    groups.forEach(function (g) { g.items.forEach(function (it) { students[it.studentId] = true; }); });
    out.emails = groups.length;
    out.students = Object.keys(students).length;
    return out;
  },

  'admin.syncDonations': function (ctx, req) {
    requireAdmin(ctx, req);
    return syncDonations(ctx);
  },

  'admin.sendWeeklyUpdates': function (ctx, req) {
    requireAdmin(ctx, req);
    return runWeeklyUpdates(ctx);
  },

};

/**
 * Organizers sign in with Google. The browser sends Google's ID token; we
 * accept it only if Google vouches for it, it was issued to our OAuth client,
 * it hasn't expired, and the email is an owner/editor of the data spreadsheet.
 */
function requireAdmin(ctx, req) {
  if (ctx.admin) return ctx.admin;
  var clientId = str(ctx.env.googleClientId);
  if (!clientId) throw new ApiError('Google sign-in is not configured. Set GOOGLE_CLIENT_ID in Apps Script.', 500);
  var token = str(req.idToken);
  if (!token) throw new ApiError('Please sign in.', 401);
  var info = token.length <= 4096 ? ctx.env.verifyGoogleIdToken(token) : null;
  var nowSeconds = Date.parse(ctx.env.now()) / 1000;
  if (!info || str(info.aud) !== clientId || GOOGLE_ISSUERS.indexOf(str(info.iss)) < 0 ||
      !(Number(info.exp) > nowSeconds) || !toBool(info.email_verified, false) || !str(info.email)) {
    throw new ApiError('Your sign-in has expired. Please sign in again.', 401);
  }
  var email = str(info.email).toLowerCase();
  var allowed = (ctx.store.adminEmails() || []).map(function (e) { return str(e).toLowerCase(); });
  if (allowed.indexOf(email) < 0) {
    throw new ApiError(email + ' doesn\'t have edit access to the readathon data spreadsheet. ' +
      'Ask the organizer to share it with you as an editor.', 403);
  }
  ctx.admin = { email: email };
  return ctx.admin;
}

// ---------------------------------------------------------------------------
// Contact emails: link emails and weekly updates
// ---------------------------------------------------------------------------

function normEmail(v) {
  return str(v).toLowerCase();
}

function isEmail(s) {
  return s.length <= 254 && EMAIL_RE.test(s);
}

/** Valid, de-duplicated contact rows, at most MAX_CONTACTS (organizers may paste extra rows into the sheet). */
function cleanContacts(records) {
  var seen = {};
  return records.filter(function (r) {
    var email = normEmail(r.email);
    if (!isEmail(email) || seen[email]) return false;
    seen[email] = true;
    return true;
  }).slice(0, MAX_CONTACTS);
}

function contactsFor(ctx, studentId) {
  return cleanContacts(loadTable(ctx, 'Contacts').records.filter(function (r) { return str(r.studentId) === studentId; }));
}

function publicContact(r) {
  return { email: normEmail(r.email), weeklyUpdates: toBool(r.weeklyUpdates, false), linksSentAt: str(r.linksSentAt) };
}

function validateContacts(list) {
  if (!Array.isArray(list)) throw new ApiError('Please send a list of contacts.');
  var out = [];
  var seen = {};
  list.forEach(function (c) {
    var email = normEmail(c && c.email);
    if (!email || seen[email]) return;
    if (!isEmail(email)) throw new ApiError('"' + email.slice(0, 80) + '" doesn\'t look like an email address.');
    seen[email] = true;
    out.push({ email: email, weeklyUpdates: toBool(c.weeklyUpdates, false) });
  });
  if (out.length > MAX_CONTACTS) throw new ApiError('A student can have at most ' + MAX_CONTACTS + ' contact emails.');
  return out;
}

/**
 * Makes the student's Contacts rows match `list`: removes missing addresses,
 * updates the weekly flag, appends new ones. Returns the new rows. Call while
 * holding the lock.
 */
function saveContacts(ctx, studentId, list) {
  var table = loadTable(ctx, 'Contacts');
  var wanted = {};
  list.forEach(function (c) { wanted[c.email] = c; });
  var seen = {};
  var remove = [];
  table.records.forEach(function (r) {
    if (str(r.studentId) !== studentId) return;
    var email = normEmail(r.email);
    if (!wanted[email] || seen[email]) remove.push(r._i);
    seen[email] = true;
  });
  if (remove.length) {
    ctx.store.deleteRows('Contacts', remove);
    delete ctx.memo['table:Contacts'];
    table = loadTable(ctx, 'Contacts');
  }
  var now = ctx.env.now();
  var added = [];
  list.forEach(function (c) {
    var rec = null;
    table.records.forEach(function (r) {
      if (str(r.studentId) === studentId && normEmail(r.email) === c.email) rec = r;
    });
    if (!rec) {
      rec = { studentId: studentId, email: c.email, weeklyUpdates: c.weeklyUpdates,
        unsubscribeKey: randomString(ctx.env, 24, TOKEN_ALPHABET), linksSentAt: '', lastUpdateSentAt: '', addedAt: now };
      appendRecord(ctx, table, rec);
      added.push(rec);
    } else if (toBool(rec.weeklyUpdates, false) !== c.weeklyUpdates || !str(rec.unsubscribeKey)) {
      rec.weeklyUpdates = c.weeklyUpdates;
      if (!str(rec.unsubscribeKey)) rec.unsubscribeKey = randomString(ctx.env, 24, TOKEN_ALPHABET);
      saveRecord(ctx, table, rec);
    }
  });
  return added;
}

/** Rows pasted straight into the Contacts tab have no unsubscribe key yet; fill them in. */
function ensureUnsubscribeKeys(ctx) {
  ctx.store.withLock(function () {
    delete ctx.memo['table:Contacts'];
    var table = loadTable(ctx, 'Contacts');
    var changed = false;
    table.records.forEach(function (r) {
      if (str(r.unsubscribeKey) || !str(r.email)) return;
      r.unsubscribeKey = randomString(ctx.env, 24, TOKEN_ALPHABET);
      changed = true;
    });
    if (changed) ctx.store.replaceRows('Contacts', table.records.map(function (r) { return toRow(table, r); }));
  });
}

/** Sets `field` on the given {studentId, email} rows. Takes the lock itself. */
function markContacts(ctx, keys, field, value) {
  if (!keys.length) return;
  var want = {};
  keys.forEach(function (k) { want[k.studentId + '|' + k.email] = true; });
  ctx.store.withLock(function () {
    delete ctx.memo['table:Contacts'];
    var table = loadTable(ctx, 'Contacts');
    table.records.forEach(function (r) {
      if (want[str(r.studentId) + '|' + normEmail(r.email)]) r[field] = value;
    });
    ctx.store.replaceRows('Contacts', table.records.map(function (r) { return toRow(table, r); }));
  });
}

/** A contact row plus what an email about its student needs, or null if the student has no links. */
function contactItem(ctx, contact) {
  var id = str(contact.studentId);
  var rec = findStudentRecord(ctx, 'studentId', id);
  var info = rec && str(rec.token) ? getRoster(ctx).byId[id] : null;
  if (!info) return null;
  return {
    studentId: id,
    email: normEmail(contact.email),
    weeklyUpdates: toBool(contact.weeklyUpdates, false),
    unsubscribeKey: str(contact.unsubscribeKey),
    student: withCode(info, rec),
    rec: rec,
  };
}

/** Sends through env.sendEmail while the daily quota lasts. */
function mailer(ctx) {
  if (ctx.memo.mailer) return ctx.memo.mailer;
  if (!ctx.env.sendEmail) throw new ApiError('Email is not set up on this server.', 500);
  var s = getSettings(ctx);
  var quota = emailQuotaLeft(ctx);
  if (quota === null) quota = Infinity;
  var m = {
    sent: 0,
    canSend: function () { return m.sent < quota; },
    left: function () { return quota === Infinity ? null : Math.max(0, quota - m.sent); },
    send: function (msg) {
      try {
        ctx.env.sendEmail({ to: msg.to, subject: msg.subject, body: msg.body, htmlBody: msg.htmlBody,
          name: s.readathonTitle, replyTo: s.emailReplyTo || undefined });
        m.sent++;
        return true;
      } catch (err) {
        ctx.env.log('Email to ' + msg.to + ' failed: ' + ((err && err.message) || err));
        return false;
      }
    },
  };
  ctx.memo.mailer = m;
  return m;
}

/** Emails Google will still let this account send today, or null if unknown. */
function emailQuotaLeft(ctx) {
  return ctx.env.emailQuota ? Math.max(0, Number(ctx.env.emailQuota())) : null;
}

/** Groups items by address, keeping first-seen order: [{email, items}]. */
function groupByEmail(items) {
  var byEmail = {};
  var groups = [];
  items.forEach(function (it) {
    var g = byEmail[it.email];
    if (!g) { g = byEmail[it.email] = { email: it.email, items: [] }; groups.push(g); }
    g.items.push(it);
  });
  return groups;
}

/**
 * Sends one links email per address, listing every student in `items` that
 * address follows, and records linksSentAt. Call without holding the lock.
 * Returns {sent, failed: [emails], remaining, quotaLeft}; sent and remaining
 * count emails, and remaining is what the daily quota or time limit held back.
 */
function deliverLinks(ctx, items) {
  var started = Date.now();
  var m = mailer(ctx);
  var s = getSettings(ctx);
  var sent = [];
  var sentEmails = 0;
  var failed = [];
  var remaining = 0;
  groupByEmail(items).forEach(function (g) {
    if (!m.canSend() || Date.now() - started > SEND_TIME_LIMIT_MS) { remaining++; return; }
    var msg = linksEmail(s, g.items);
    msg.to = g.email;
    if (m.send(msg)) { sent = sent.concat(g.items); sentEmails++; } else { failed.push(g.email); }
  });
  markContacts(ctx, sent, 'linksSentAt', ctx.env.now());
  return { sent: sentEmails, failed: failed, remaining: remaining, quotaLeft: m.left() };
}

/** Contacts to send links to: all of one student's, or (no studentId) everyone not sent them yet. */
function planLinks(ctx, studentId) {
  var items = [];
  getRoster(ctx).list.forEach(function (st) {
    if (studentId && st.studentId !== studentId) return;
    contactsFor(ctx, st.studentId).forEach(function (c) {
      if (!studentId && str(c.linksSentAt)) return;
      var item = contactItem(ctx, c);
      if (item) items.push(item);
    });
  });
  return items;
}

function joinNames(names) {
  return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
}

function studentLinks(settings, student, rec) {
  var base = siteBase(settings);
  return { logUrl: base + '/s/' + str(rec.token), donationUrl: base + '/d/' + student.code };
}

function unsubscribeUrl(settings, key) {
  return siteBase(settings) + '/unsubscribe.html?k=' + encodeURIComponent(key);
}

function readathonDates(settings) {
  var fmt = function (d) {
    var p = d.split('-').map(Number);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p[1] - 1] + ' ' + p[2];
  };
  if (settings.startDate && settings.endDate) return fmt(settings.startDate) + ' – ' + fmt(settings.endDate);
  return '';
}

/** Wraps paragraphs of {html} or plain strings into a simple, inline-styled email. */
function emailHtml(title, blocks) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:560px">' +
    '<h2 style="color:#1d3c78;margin:0 0 12px">' + escapeHtml(title) + '</h2>' +
    blocks.map(function (b) { return typeof b === 'string' ? '<p style="margin:0 0 12px">' + escapeHtml(b) + '</p>' : b.html; }).join('') +
    '</div>';
}

function linkBlock(label, url, note) {
  return {
    html: '<p style="margin:0 0 12px"><strong>' + escapeHtml(label) + '</strong><br>' +
      '<a href="' + escapeHtml(url) + '">' + escapeHtml(url) + '</a>' +
      (note ? '<br><span style="color:#666;font-size:13px">' + escapeHtml(note) + '</span>' : '') + '</p>',
    text: label + '\n' + url + (note ? '\n(' + note + ')' : ''),
  };
}

function toText(blocks) {
  return blocks.map(function (b) { return typeof b === 'string' ? b : b.text; }).join('\n\n');
}

/** The links email for one address, covering each of its students in `items`. */
function linksEmail(settings, items) {
  var dates = readathonDates(settings);
  var fullNames = items.map(function (it) { return (it.student.firstName + ' ' + it.student.lastName).trim(); });
  var firstNames = items.map(function (it) { return it.student.firstName; });
  var one = items.length === 1;
  var blocks = ['Hello! You\'re listed as a contact for ' + joinNames(fullNames) + ' in the ' + settings.readathonTitle +
    (dates ? ' (' + dates + ')' : '') + '. Here are ' + (one ? firstNames[0] + '\'s' : 'their') + ' links.'];
  items.forEach(function (it) {
    var st = it.student;
    var links = studentLinks(settings, st, it.rec);
    if (!one) {
      blocks.push({
        html: '<h3 style="margin:16px 0 8px;color:#1d3c78">' + escapeHtml((st.firstName + ' ' + st.lastName).trim()) + '</h3>',
        text: '== ' + (st.firstName + ' ' + st.lastName).trim() + ' ==',
      });
    }
    blocks.push(linkBlock('Reading log — log minutes and books here', links.logUrl,
      'Private: anyone with this link can change ' + st.firstName + '\'s log, so please don\'t share it.'));
    blocks.push(linkBlock('Donation page — share this one', links.donationUrl,
      'Send it to family and friends who\'d like to support ' + st.firstName + '\'s reading.'));
  });
  var weekly = items.filter(function (it) { return it.weeklyUpdates; });
  if (weekly.length && settings.weeklyUpdatesEnabled) {
    var who = joinNames(weekly.map(function (it) { return it.student.firstName; }));
    var unsub = unsubscribeUrl(settings, weekly[0].unsubscribeKey);
    blocks.push({
      html: '<p style="margin:0 0 12px;color:#666;font-size:13px">You\'ll also get a weekly update on ' + escapeHtml(who) +
        '\'s reading. <a href="' + escapeHtml(unsub) + '">Stop weekly updates</a></p>',
      text: 'You\'ll also get a weekly update on ' + who + '\'s reading. To stop them: ' + unsub,
    });
  }
  blocks.push('Happy reading! — ' + settings.schoolName + ' PTO');
  return {
    subject: joinNames(firstNames) + '\'s ' + settings.readathonTitle + ' links',
    body: toText(blocks),
    htmlBody: emailHtml(settings.readathonTitle, blocks),
  };
}

/** One student's numbers for the 7 days ending `today`. */
function weeklyStats(ctx, studentId, today) {
  var s = getSettings(ctx);
  var weekStart = addDays(today, -6);
  var week = 0;
  loadTable(ctx, 'Minutes').records.forEach(function (r) {
    var d = str(r.date);
    if (str(r.studentId) !== studentId || d < weekStart || d > today) return;
    if ((s.startDate && d < s.startDate) || (s.endDate && d > s.endDate)) return;
    week += Math.max(0, toInt(r.minutes, 0));
  });
  var mine = getAggregates(ctx, false).byStudent[studentId] || { minutes: 0, days: 0 };
  var books = booksFor(ctx, studentId);
  var finishedThisWeek = books.filter(function (b) {
    return b.status === 'finished' && b.finishedAt.slice(0, 10) >= weekStart;
  });
  var current = books.filter(function (b) { return b.status === 'reading'; })[0];
  return {
    weekMinutes: week,
    totalMinutes: mine.minutes,
    daysRead: mine.days,
    finishedThisWeek: finishedThisWeek.map(function (b) { return b.title; }),
    finishedTotal: books.filter(function (b) { return b.status === 'finished'; }).length,
    currentBook: current ? current.title : '',
  };
}

function weeklyEmail(settings, entries, unsubKey, final) {
  var who = joinNames(entries.map(function (e) { return e.student.firstName; }));
  var blocks = [final
    ? 'The ' + settings.readathonTitle + ' is over! Here\'s how ' + who + ' did.'
    : 'Here\'s ' + who + '\'s reading this week in the ' + settings.readathonTitle + '.'];
  entries.forEach(function (e) {
    var st = e.stats;
    var lines = [];
    if (!final) lines.push(st.weekMinutes + ' minutes this week');
    lines.push(st.totalMinutes + ' minutes in total, on ' + st.daysRead + ' day' + (st.daysRead === 1 ? '' : 's') +
      (e.goalMinutes ? ' (' + Math.min(100, Math.round(st.totalMinutes / e.goalMinutes * 100)) + '% of a ' + e.goalMinutes + '-minute goal)' : ''));
    if (st.finishedThisWeek.length && !final) lines.push('Finished this week: ' + st.finishedThisWeek.join(', '));
    lines.push(st.finishedTotal + ' book' + (st.finishedTotal === 1 ? '' : 's') + ' finished so far');
    if (st.currentBook && !final) lines.push('Currently reading: ' + st.currentBook);
    var links = studentLinks(settings, e.student, e.rec);
    var name = (e.student.firstName + ' ' + e.student.lastName).trim();
    blocks.push({
      html: '<div style="border:1px solid #dde3ee;border-radius:8px;padding:12px 16px;margin:0 0 12px">' +
        '<strong style="font-size:17px">' + escapeHtml(name) + '</strong>' +
        '<ul style="margin:8px 0;padding-left:20px">' + lines.map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') + '</ul>' +
        '<a href="' + escapeHtml(links.logUrl) + '">Reading log</a> (private) · ' +
        '<a href="' + escapeHtml(links.donationUrl) + '">Donation page</a> (share it!)</div>',
      text: name + '\n' + lines.map(function (l) { return '- ' + l; }).join('\n') +
        '\nReading log (private): ' + links.logUrl + '\nDonation page (share it!): ' + links.donationUrl,
    });
  });
  blocks.push(final ? 'Thank you for cheering on our readers! — ' + settings.schoolName + ' PTO'
    : 'Keep up the great reading! — ' + settings.schoolName + ' PTO');
  var unsub = unsubscribeUrl(settings, unsubKey);
  blocks.push({
    html: '<p style="margin:16px 0 0;color:#666;font-size:12px">You get this because you signed up for weekly readathon updates. ' +
      '<a href="' + escapeHtml(unsub) + '">Unsubscribe</a></p>',
    text: 'You get this because you signed up for weekly readathon updates. Unsubscribe: ' + unsub,
  });
  return {
    subject: (final ? who + '\'s ' + settings.readathonTitle + ' results' : who + '\'s reading this week') + ' 📚',
    body: toText(blocks),
    htmlBody: emailHtml(settings.readathonTitle, blocks),
  };
}

/**
 * Who is due a weekly update: {skipped: reason} or {final, today, groups:
 * [{email, items}]}. Skips addresses updated in the last 5 days, so running it
 * twice in a week is harmless. After the end date, plans one final summary.
 */
function planWeekly(ctx) {
  var s = getSettings(ctx);
  var today = ctx.env.today();
  if (!s.weeklyUpdatesEnabled) return { skipped: 'Weekly updates are turned off in Settings.' };
  if (!s.startDate || today < s.startDate) return { skipped: 'The readathon hasn\'t started yet.' };
  if (s.endDate && today > addDays(s.endDate, 7)) return { skipped: 'The readathon ended more than a week ago.' };
  var final = !!(s.endDate && today >= s.endDate);
  var recentCutoff = addDays(today, -5);
  var items = [];
  getRoster(ctx).list.forEach(function (st) {
    contactsFor(ctx, st.studentId).forEach(function (c) {
      if (!toBool(c.weeklyUpdates, false)) return;
      var last = str(c.lastUpdateSentAt).slice(0, 10);
      if (last && last >= recentCutoff) return;
      if (final && last && last >= s.endDate) return;
      var item = contactItem(ctx, c);
      if (item) items.push(item);
    });
  });
  return { final: final, today: today, groups: groupByEmail(items) };
}

/**
 * Sends one weekly progress email per subscribed address, covering every
 * student it follows (see planWeekly). Returns {sent, failed, remaining,
 * quotaLeft} or {skipped}.
 */
function runWeeklyUpdates(ctx) {
  var started = Date.now();
  var s = getSettings(ctx);
  var plan = planWeekly(ctx);
  if (plan.skipped) return { sent: 0, failed: [], remaining: 0, skipped: plan.skipped };
  ensureUnsubscribeKeys(ctx);
  plan = planWeekly(ctx); // again, now that every row has an unsubscribe key

  var m = mailer(ctx);
  var sent = [];
  var sentEmails = 0;
  var failed = [];
  var remaining = 0;
  plan.groups.forEach(function (g) {
    if (!m.canSend() || Date.now() - started > SEND_TIME_LIMIT_MS) { remaining++; return; }
    var entries = g.items.map(function (it) {
      return { student: it.student, rec: it.rec, stats: weeklyStats(ctx, it.studentId, plan.today),
        goalMinutes: prefsOf(it.rec, s).goalMinutes };
    });
    var msg = weeklyEmail(s, entries, g.items[0].unsubscribeKey, plan.final);
    msg.to = g.email;
    if (m.send(msg)) { sent = sent.concat(g.items); sentEmails++; } else { failed.push(g.email); }
  });
  markContacts(ctx, sent, 'lastUpdateSentAt', plan.today);
  return { sent: sentEmails, failed: failed, remaining: remaining, quotaLeft: m.left() };
}

function withoutRaised(x) {
  var out = {};
  Object.keys(x).forEach(function (k) { if (k !== 'raised') out[k] = x[k]; });
  return out;
}

// ---------------------------------------------------------------------------
// Donations from Stripe
// ---------------------------------------------------------------------------

/** Converts a completed Checkout Session from the donation Payment Link into a Donations row. */
function donationRow(session) {
  // With Adaptive Pricing the donor may pay in their own currency; currency_conversion
  // holds the amount in the account's currency.
  var conv = session.currency_conversion;
  var currency = conv ? str(conv.source_currency) : str(session.currency);
  var cents = conv ? Number(conv.amount_total) : Number(session.amount_total);
  var refundedCents = 0;
  var pi = session.payment_intent;
  var charge = pi && typeof pi === 'object' ? pi.latest_charge : null;
  if (charge && typeof charge === 'object' && Number(charge.amount) > 0) {
    // The charge is in the donor's currency, so apply the refunded fraction.
    refundedCents = Math.round(cents * Math.min(1, Number(charge.amount_refunded || 0) / Number(charge.amount)));
  }
  return {
    sessionId: str(session.id),
    studentCode: str(session.client_reference_id).toUpperCase(),
    amount: (cents || 0) / 100,
    refunded: refundedCents / 100,
    currency: currency.toLowerCase(),
    paymentStatus: str(session.payment_status),
    createdAt: session.created ? new Date(Number(session.created) * 1000).toISOString() : '',
  };
}

/**
 * Rewrites the Donations tab from Stripe: every completed Checkout Session of
 * the donation Payment Link, with refunds applied. Re-reading everything each
 * time also picks up bank payments that clear later. No webhooks, because
 * Apps Script can't read the signature header needed to verify them.
 */
function syncDonations(ctx) {
  var linkId = str(ctx.env.stripePaymentLinkId);
  if (!ctx.env.stripeGet || !linkId) {
    throw new ApiError('Stripe isn\'t set up yet: add STRIPE_API_KEY and STRIPE_PAYMENT_LINK_ID in Apps Script.', 400);
  }
  var rows = [];
  try {
    var after = '';
    for (var page = 0; page < STRIPE_MAX_PAGES; page++) {
      var q = { payment_link: linkId, status: 'complete', limit: 100, 'expand[]': 'data.payment_intent.latest_charge' };
      if (after) q.starting_after = after;
      var res = ctx.env.stripeGet('/v1/checkout/sessions', q);
      (res.data || []).forEach(function (sess) {
        rows.push(donationRow(sess));
        after = sess.id;
      });
      if (!res.has_more || !after) break;
    }
  } catch (err) {
    var message = 'Could not read donations from Stripe: ' + ((err && err.message) || err);
    ctx.env.log(message);
    ctx.store.withLock(function () { putSettingsRows(ctx, { donationsSyncError: message }); });
    throw new ApiError(message, 502);
  }
  return ctx.store.withLock(function () {
    var table = loadTable(ctx, 'Donations');
    ctx.store.replaceRows('Donations', rows.map(function (r) { return toRow({ headers: table.headers }, r); }));
    delete ctx.memo['table:Donations'];
    putSettingsRows(ctx, { donationsSyncedAt: ctx.env.now(), donationsSyncError: '' });
    invalidateAggregates(ctx);
    var t = getAggregates(ctx, false).raised;
    return { sessions: rows.length, donations: t.count, total: t.total, syncedAt: ctx.env.now() };
  });
}

function validateBook(req) {
  var title = str(req.title).replace(/\s+/g, ' ');
  var author = str(req.author).replace(/\s+/g, ' ');
  if (!title) throw new ApiError('Please enter the book title.');
  if (title.length > 200) throw new ApiError('That title is too long.');
  if (author.length > 150) throw new ApiError('That author name is too long.');
  var coverId = str(req.coverId);
  var isbn = str(req.isbn).replace(/[^0-9Xx]/g, '').toUpperCase();
  return {
    title: title,
    author: author,
    status: req.status === 'reading' ? 'reading' : 'finished',
    coverId: /^\d{1,12}$/.test(coverId) ? coverId : '',
    isbn: isbn.length === 10 || isbn.length === 13 ? isbn : '',
  };
}

function findBook(table, studentId, bookId) {
  var id = str(bookId);
  for (var i = 0; i < table.records.length; i++) {
    var b = table.records[i];
    if (str(b.bookId) === id && str(b.studentId) === studentId) return b;
  }
  throw new ApiError('Book not found.', 404);
}

/**
 * Gives every roster student a private token and a short donation code, and
 * refreshes the informational name/grade/teacher columns. Rewrites the
 * Students tab in one batch. Call while holding the lock.
 */
function syncRoster(ctx) {
  var roster = getRoster(ctx, true);
  var table = loadTable(ctx, 'Students');
  var byId = {};
  var usedTokens = {};
  var usedCodes = {};
  table.records.forEach(function (r) {
    byId[str(r.studentId)] = r;
    usedTokens[str(r.token)] = true;
    usedCodes[str(r.code).toUpperCase()] = true;
  });
  var unique = function (len, alphabet, used) {
    for (;;) {
      var v = randomString(ctx.env, len, alphabet);
      if (!used[v]) { used[v] = true; return v; }
    }
  };
  var now = ctx.env.now();
  var created = 0;
  var updated = 0;
  roster.list.forEach(function (st) {
    var name = (st.firstName + ' ' + st.lastName).trim();
    var rec = byId[st.studentId];
    if (!rec) {
      rec = { _raw: null, studentId: st.studentId, token: '', code: '', goalMinutes: '', showReadingList: '',
        showTotalMinutes: '', showClassMinutes: '', showRaised: '', createdAt: now, updatedAt: now };
      table.records.push(rec);
      byId[st.studentId] = rec;
      created++;
    } else if (str(rec.studentName) !== name || str(rec.grade) !== st.grade || str(rec.teacher) !== st.teacher) {
      updated++;
    }
    if (!str(rec.token)) rec.token = unique(24, TOKEN_ALPHABET, usedTokens);
    if (!str(rec.code)) rec.code = unique(6, CODE_ALPHABET, usedCodes);
    rec.studentName = name;
    rec.grade = st.grade;
    rec.teacher = st.teacher;
  });
  ctx.store.replaceRows('Students', table.records.map(function (r) { return toRow(table, r); }));
  delete ctx.memo['table:Students'];
  var orphaned = table.records.filter(function (r) { return !roster.byId[str(r.studentId)]; }).length;
  return { created: created, updated: updated, total: roster.list.length, orphaned: orphaned };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    handleApi: handleApi,
    runWeeklyUpdates: runWeeklyUpdates,
    syncDonations: syncDonations,
    parseRoster: parseRoster,
    SCHEMA: SCHEMA,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    ApiError: ApiError,
  };
}
