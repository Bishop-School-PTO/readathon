const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { handleApi, parseRoster } = require('../../apps-script/Core.js');
const { createFileStore } = require('../../dev/store.js');

const ROSTER = {
  headers: ['Student ID', 'First Name', 'Last Name', 'Grade', 'Teacher'],
  rows: [
    [1, 'Avery', 'Example', 'K', 'Ms. Rivera'],
    [2, 'Jordan', 'Sample', '3', 'Mr. Chen'],
    [3, 'Riley', 'Test', '3', 'Mr. Chen'],
  ],
};

const NOW = Date.parse('2026-10-09T12:00:00.000Z') / 1000;
const CLIENT_ID = 'client-123.apps.googleusercontent.com';

// Claims Google's tokeninfo would return for each fake ID token.
const TOKENS = {
  organizer: { aud: CLIENT_ID, iss: 'https://accounts.google.com', exp: String(NOW + 3000), email: 'Organizer@Example.com', email_verified: 'true' },
  stranger: { aud: CLIENT_ID, iss: 'accounts.google.com', exp: String(NOW + 3000), email: 'parent@example.com', email_verified: 'true' },
  otherApp: { aud: 'someone-else', iss: 'accounts.google.com', exp: String(NOW + 3000), email: 'organizer@example.com', email_verified: 'true' },
  expired: { aud: CLIENT_ID, iss: 'accounts.google.com', exp: String(NOW - 10), email: 'organizer@example.com', email_verified: 'true' },
  unverified: { aud: CLIENT_ID, iss: 'accounts.google.com', exp: String(NOW + 3000), email: 'organizer@example.com', email_verified: 'false' },
  badIssuer: { aud: CLIENT_ID, iss: 'evil.example', exp: String(NOW + 3000), email: 'organizer@example.com', email_verified: 'true' },
};
const ADMIN = { idToken: 'organizer' };

function setup(today = '2026-10-09') {
  const store = createFileStore(null, ROSTER, ['organizer@example.com', 'cochair@example.com']);
  const outbox = [];
  const env = {
    today: () => today,
    now: () => '2026-10-09T12:00:00.000Z',
    randomBytes: (n) => [...crypto.randomBytes(n)],
    googleClientId: CLIENT_ID,
    verifyGoogleIdToken: (t) => TOKENS[t] || null,
    sendEmail: (msg) => {
      if (msg.to.startsWith('bounce')) throw new Error('Invalid email');
      outbox.push(msg);
    },
    emailQuota: () => env.quota - outbox.length,
    quota: 100,
    // Fake Stripe: lists `sessions` (set by tests) two per page, newest first.
    stripeGet: (path, q) => {
      env.stripeCalls.push(q);
      if (env.stripeError) throw new Error(env.stripeError);
      assert.strictEqual(path, '/v1/checkout/sessions');
      assert.strictEqual(q.payment_link, 'plink_test');
      assert.strictEqual(q.status, 'complete');
      const start = q.starting_after ? env.sessions.findIndex((x) => x.id === q.starting_after) + 1 : 0;
      return { data: env.sessions.slice(start, start + 2), has_more: start + 2 < env.sessions.length };
    },
    stripePaymentLinkId: 'plink_test',
    donationLinkUrl: 'https://donate.stripe.com/test_abc123',
    stripeCalls: [],
    sessions: [],
    log: () => {},
  };
  const call = (action, params) => handleApi(store, env, { action, ...params });
  const ok = (action, params) => {
    const r = call(action, params);
    assert.ok(r.ok, `${action} failed: ${r.error}`);
    return r.data;
  };
  ok('admin.saveSettings', { ...ADMIN, settings: { startDate: '2026-10-05', endDate: '2026-10-15' } });
  ok('admin.syncRoster', ADMIN);
  const students = ok('admin.overview', ADMIN).students;
  return { store, env, call, ok, students, outbox };
}

test('sync gives each student a unique token and short code', () => {
  const { students } = setup();
  assert.strictEqual(students.length, 3);
  const tokens = new Set(students.map((s) => s.token));
  const codes = new Set(students.map((s) => s.code));
  assert.strictEqual(tokens.size, 3);
  assert.strictEqual(codes.size, 3);
  students.forEach((s) => {
    assert.match(s.token, /^[A-Za-z0-9]{24}$/);
    assert.match(s.code, /^[A-Z2-9]{6}$/);
  });
});

test('sync is idempotent', () => {
  const { ok, students } = setup();
  const r = ok('admin.syncRoster', ADMIN);
  assert.strictEqual(r.created, 0);
  const again = ok('admin.overview', ADMIN).students;
  assert.deepStrictEqual(again.map((s) => s.token), students.map((s) => s.token));
});

test('student logs minutes for today and past days, totals add up', () => {
  const { ok, students } = setup();
  const [, jordan, riley] = students;
  ok('student.setMinutes', { token: jordan.token, date: '2026-10-09', minutes: 30 });
  ok('student.setMinutes', { token: jordan.token, date: '2026-10-06', minutes: 20 });
  const r = ok('student.setMinutes', { token: jordan.token, date: '2026-10-09', minutes: 45 }); // update, not add
  assert.strictEqual(r.totalMinutes, 65);
  ok('student.setMinutes', { token: riley.token, date: '2026-10-08', minutes: 10 });
  const view = ok('student.get', { token: jordan.token });
  assert.strictEqual(view.totalMinutes, 65);
  assert.strictEqual(view.daysRead, 2);
  assert.strictEqual(view.classMinutes, 75); // Mr. Chen's class
  assert.strictEqual(view.days.length, 5); // Oct 5..9
  assert.strictEqual(view.days.find((d) => d.date === '2026-10-06').minutes, 20);
});

test('minutes are rejected for future days, outside the range, bad values, or when locked', () => {
  const { call, ok, students } = setup();
  const t = students[0].token;
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-10', minutes: 10 }).ok);
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-01', minutes: 10 }).ok);
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-09', minutes: -5 }).ok);
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-09', minutes: 2.5 }).ok);
  assert.ok(!call('student.setMinutes', { token: t, date: '2026-10-09', minutes: 9999 }).ok);
  ok('admin.saveSettings', { ...ADMIN, settings: { editsLocked: true } });
  const r = call('student.setMinutes', { token: t, date: '2026-10-09', minutes: 10 });
  assert.ok(!r.ok);
  assert.match(r.error, /locked/);
});

test('unknown tokens and codes are not found', () => {
  const { call } = setup();
  assert.strictEqual(call('student.get', { token: 'x'.repeat(24) }).status, 404);
  assert.strictEqual(call('student.get', { token: '' }).status, 404);
  assert.strictEqual(call('donation.get', { code: 'ZZZZZZ' }).status, 404);
});

test('donation page respects the student privacy toggles', () => {
  const { ok, students } = setup();
  const s = students[1];
  ok('student.setMinutes', { token: s.token, date: '2026-10-09', minutes: 30 });
  ok('student.addBook', { token: s.token, title: 'Charlotte\'s Web', author: 'E. B. White', status: 'finished' });

  let d = ok('donation.get', { code: s.code.toLowerCase() });
  assert.strictEqual(d.student.name, 'Jordan S.');
  assert.strictEqual(d.totalMinutes, 30);
  assert.strictEqual(d.classMinutes, 30);
  assert.strictEqual(d.books.length, 1);
  assert.ok(!('token' in d.student));

  ok('student.setPrefs', { token: s.token, showReadingList: false, showTotalMinutes: false, showClassMinutes: false });
  d = ok('donation.get', { code: s.code });
  assert.strictEqual(d.totalMinutes, undefined);
  assert.strictEqual(d.classMinutes, undefined);
  assert.strictEqual(d.books, undefined);
});

test('books: one current book, finish it, delete it, other students cannot touch it', () => {
  const { ok, call, students } = setup();
  const [a, b] = students;
  ok('student.addBook', { token: a.token, title: 'Book One', status: 'reading', coverId: '12345' });
  let r = ok('student.addBook', { token: a.token, title: 'Book Two', status: 'reading' });
  assert.deepStrictEqual(r.books.map((x) => x.title), ['Book Two']);
  const id = r.books[0].bookId;
  assert.ok(!call('student.deleteBook', { token: b.token, bookId: id }).ok);
  r = ok('student.updateBook', { token: a.token, bookId: id, status: 'finished' });
  assert.strictEqual(r.books[0].status, 'finished');
  r = ok('student.deleteBook', { token: a.token, bookId: id });
  assert.strictEqual(r.books.length, 0);
  assert.ok(!call('student.addBook', { token: a.token, title: '   ' }).ok);
});

test('the donate button is the Stripe link from Script Properties, tagged with the student code', () => {
  const { ok, env, students } = setup();
  const code = students[0].code;
  assert.strictEqual(ok('donation.get', { code }).donateUrl, 'https://donate.stripe.com/test_abc123?client_reference_id=' + code);
  assert.strictEqual(ok('admin.overview', ADMIN).donations.linkMode, 'test');
  env.donationLinkUrl = 'https://donate.stripe.com/live9XYZ';
  assert.strictEqual(ok('admin.overview', ADMIN).donations.linkMode, 'live');
  // Anything that isn't a Stripe-hosted Payment Link is ignored.
  for (const bad of ['', 'https://evil.example/pay', 'https://donate.stripe.com.evil.example/x', 'http://donate.stripe.com/x',
    'https://donate.stripe.com/x?client_reference_id=1', 'javascript:alert(1)//https://donate.stripe.com/x']) {
    env.donationLinkUrl = bad;
    assert.strictEqual(ok('donation.get', { code }).donateUrl, '', bad);
  }
  assert.strictEqual(ok('admin.overview', ADMIN).donations.linkMode, '');
});

test('organizers cannot change where email links point or send replies off the PTO domain', () => {
  const { ok, call, store, students, outbox } = setup();
  // Old settings that used to be editable are ignored, whether saved or typed into the sheet.
  ok('admin.saveSettings', { ...ADMIN, settings: { siteUrl: 'https://evil.example', donationWidgetHtml: '<script>x</script>' } });
  store.appendRows('Settings', [['siteUrl', 'https://evil.example']]);
  assert.strictEqual(ok('admin.overview', ADMIN).settings.siteUrl, 'https://readathon.bishopschoolpto.com');
  assert.ok(!('donationWidgetHtml' in ok('admin.overview', ADMIN).settings));

  assert.match(call('admin.saveSettings', { ...ADMIN, settings: { emailReplyTo: 'someone@gmail.com' } }).error, /@bishopschoolpto\.com/);
  assert.match(call('admin.saveSettings', { ...ADMIN, settings: { emailReplyTo: 'x@bishopschoolpto.com.evil.example' } }).error, /@bishopschoolpto/);
  ok('admin.saveSettings', { ...ADMIN, settings: { emailReplyTo: 'Readathon@BishopSchoolPTO.com' } });
  assert.strictEqual(ok('admin.overview', ADMIN).settings.emailReplyTo, 'readathon@bishopschoolpto.com');
  ok('admin.saveSettings', { ...ADMIN, settings: { emailReplyTo: '' } });
  store.appendRows('Settings', [['emailReplyTo', 'thief@gmail.com']]);
  assert.strictEqual(ok('admin.overview', ADMIN).settings.emailReplyTo, '');

  ok('admin.setContacts', { ...ADMIN, studentId: students[0].studentId, contacts: [{ email: 'mom@example.com' }] });
  assert.strictEqual(outbox.length, 1);
  assert.strictEqual(outbox[0].replyTo, undefined);
  assert.ok(outbox[0].body.includes('https://readathon.bishopschoolpto.com/s/'));
  assert.ok(!outbox[0].body.includes('evil'));
});

test('admin actions require a Google sign-in from a spreadsheet editor', () => {
  const { call, ok } = setup();
  assert.strictEqual(ok('admin.login', ADMIN).email, 'organizer@example.com'); // case-insensitive match
  assert.strictEqual(call('admin.overview', {}).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'forged' }).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'otherApp' }).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'expired' }).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'unverified' }).status, 401);
  assert.strictEqual(call('admin.overview', { idToken: 'badIssuer' }).status, 401);
  const r = call('admin.syncRoster', { idToken: 'stranger' });
  assert.strictEqual(r.status, 403);
  assert.match(r.error, /parent@example\.com doesn't have edit access/);
  assert.ok(!call('admin.saveSettings', { ...ADMIN, settings: { startDate: '2026-10-20', endDate: '2026-10-01' } }).ok);
});

test('regenerating a token invalidates the old link but keeps the donation code', () => {
  const { ok, call, students } = setup();
  const s = students[0];
  const r = ok('admin.regenerateToken', { ...ADMIN, studentId: s.studentId });
  assert.notStrictEqual(r.token, s.token);
  assert.strictEqual(call('student.get', { token: s.token }).status, 404);
  assert.strictEqual(ok('student.get', { token: r.token }).student.code, s.code);
});

test('roster parsing tolerates header variants and "Last, First" names', () => {
  const r = parseRoster({
    headers: ['ID', 'Student Name', 'Grade Level', 'Homeroom Teacher'],
    rows: [['7', 'Lopez, Maya', '2', 'Ms. Lee'], ['8', 'Leo Kim', '2', 'Ms. Lee'], ['', 'No Id', '2', 'x']],
  });
  assert.deepStrictEqual(r.list.map((s) => [s.studentId, s.firstName, s.lastName, s.teacher]), [
    ['7', 'Maya', 'Lopez', 'Ms. Lee'],
    ['8', 'Leo', 'Kim', 'Ms. Lee'],
  ]);
});

test('admin sign-in fails closed when GOOGLE_CLIENT_ID is not configured', () => {
  const { store, env } = setup();
  const r = handleApi(store, { ...env, googleClientId: '' }, { action: 'admin.overview', ...ADMIN });
  assert.strictEqual(r.status, 500);
  assert.match(r.error, /GOOGLE_CLIENT_ID/);
});

test('contacts: up to 5 emails per student, new ones get the log and donation links', () => {
  const { ok, call, students, outbox } = setup();
  const s = students[1];
  let r = ok('student.setContacts', { token: s.token, contacts: [
    { email: ' Mom@Example.com ', weeklyUpdates: true }, { email: 'dad@example.com' }, { email: '' },
  ] });
  assert.deepStrictEqual(r.contacts.map((c) => [c.email, c.weeklyUpdates]), [['mom@example.com', true], ['dad@example.com', false]]);
  assert.strictEqual(r.sent, 2);
  assert.ok(r.contacts.every((c) => c.linksSentAt));
  assert.deepStrictEqual(outbox.map((m) => m.to), ['mom@example.com', 'dad@example.com']);
  const mail = outbox[0];
  assert.match(mail.subject, /^Jordan's Bishop Readathon links$/);
  assert.ok(mail.body.includes('https://readathon.bishopschoolpto.com/s/' + s.token));
  assert.ok(mail.htmlBody.includes('https://readathon.bishopschoolpto.com/d/' + s.code));
  assert.match(mail.body, /unsubscribe\.html\?k=[A-Za-z0-9]{24}/); // subscribed to weekly updates
  assert.doesNotMatch(outbox[1].body, /unsubscribe/);

  // Changing only the weekly flag, or re-saving, doesn't email again; a new address does.
  r = ok('student.setContacts', { token: s.token, contacts: [
    { email: 'mom@example.com', weeklyUpdates: false }, { email: 'dad@example.com', weeklyUpdates: true }, { email: 'gran@example.com' },
  ] });
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(outbox.length, 3);
  assert.deepStrictEqual(r.contacts.map((c) => c.weeklyUpdates), [false, true, false]);

  assert.match(call('student.setContacts', { token: s.token, contacts: [
    { email: 'a@example.com' }, { email: 'b@example.com' }, { email: 'c@example.com' }, { email: 'd@example.com' },
    { email: 'e@example.com' }, { email: 'f@example.com' },
  ] }).error, /at most 5/);
  assert.match(call('student.setContacts', { token: s.token, contacts: [{ email: 'not-an-email' }] }).error, /doesn't look like an email/);

  r = ok('student.setContacts', { token: s.token, contacts: [{ email: 'dad@example.com', weeklyUpdates: true }] });
  assert.deepStrictEqual(r.contacts.map((c) => c.email), ['dad@example.com']);
  assert.strictEqual(ok('student.get', { token: s.token }).contacts.length, 1);
  assert.deepStrictEqual(ok('admin.overview', ADMIN).students[1].contacts.map((c) => c.email), ['dad@example.com']);
  assert.strictEqual(ok('donation.get', { code: s.code }).contacts, undefined);
});

test('the student page can only trigger a few link emails per day', () => {
  const { ok, students, outbox } = setup();
  const t = students[0].token;
  for (let i = 0; i < 6; i++) {
    ok('student.setContacts', { token: t, contacts: [{ email: `a${i}@example.com` }, { email: `b${i}@example.com` }] });
  }
  assert.strictEqual(outbox.length, 10);
});

test('organizers manage contacts and (re)send link emails', () => {
  const { ok, call, store, students, outbox } = setup();
  const [a, b] = students;
  let r = ok('admin.setContacts', { ...ADMIN, studentId: a.studentId, sendLinks: false, contacts: [{ email: 'p@example.com' }] });
  assert.strictEqual(r.sent, 0);
  assert.strictEqual(outbox.length, 0);
  // Rows pasted straight into the Contacts tab, including a bad address and a 6th address.
  store.appendRows('Contacts', [
    [b.studentId, 'Q@example.com', 'yes', '', '', '', ''],
    [b.studentId, 'bounce@example.com', '', '', '', '', ''],
    [b.studentId, 'junk', '', '', '', '', ''],
    [b.studentId, 'r@example.com', '', '', '', '', ''],
    [b.studentId, 's@example.com', '', '', '', '', ''],
    [b.studentId, 't@example.com', '', '', '', '', ''],
    [b.studentId, 'u@example.com', '', '', '', '', ''],
  ]);
  r = ok('admin.emailLinks', ADMIN); // everyone not emailed yet
  assert.strictEqual(r.sent, 5);
  assert.deepStrictEqual(r.failed, ['bounce@example.com']);
  assert.deepStrictEqual(outbox.map((m) => m.to).sort(),
    ['p@example.com', 'q@example.com', 'r@example.com', 's@example.com', 't@example.com']); // u is over the limit
  assert.match(outbox.find((m) => m.to === 'q@example.com').body, /unsubscribe\.html\?k=[A-Za-z0-9]{24}/);
  assert.strictEqual(ok('admin.emailLinks', ADMIN).sent, 0); // only the bounced one is left, and it fails again
  assert.strictEqual(ok('admin.emailLinks', { ...ADMIN, studentId: a.studentId }).sent, 1); // explicit resend
  assert.strictEqual(call('admin.emailLinks', { idToken: 'stranger' }).status, 403);
  assert.strictEqual(call('admin.setContacts', { ...ADMIN, studentId: 'nope', contacts: [] }).status, 404);
});

test('weekly updates: one email per address, skipped if sent this week, final summary after the end', () => {
  const { ok, call, store, env, students, outbox } = setup('2026-10-11');
  const [a, b, c] = students;
  ok('student.setMinutes', { token: b.token, date: '2026-10-06', minutes: 30 });
  ok('student.setMinutes', { token: b.token, date: '2026-10-10', minutes: 20 });
  ok('student.setMinutes', { token: c.token, date: '2026-10-09', minutes: 15 });
  ok('student.addBook', { token: b.token, title: 'Frog and Toad', status: 'finished' });
  ok('student.setPrefs', { token: b.token, goalMinutes: 100 });
  ok('admin.setContacts', { ...ADMIN, studentId: b.studentId, sendLinks: false, contacts: [{ email: 'fam@example.com', weeklyUpdates: true }] });
  ok('admin.setContacts', { ...ADMIN, studentId: c.studentId, sendLinks: false, contacts: [{ email: 'FAM@example.com', weeklyUpdates: true }] });
  ok('admin.setContacts', { ...ADMIN, studentId: a.studentId, sendLinks: false, contacts: [{ email: 'quiet@example.com' }] });

  let r = ok('admin.sendWeeklyUpdates', ADMIN);
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(outbox.length, 1);
  const mail = outbox[0];
  assert.strictEqual(mail.to, 'fam@example.com');
  assert.strictEqual(mail.subject, 'Jordan and Riley\'s reading this week 📚');
  assert.match(mail.body, /Jordan Sample\n- 50 minutes this week\n- 50 minutes in total, on 2 days \(50% of a 100-minute goal\)\n- Finished this week: Frog and Toad/);
  assert.match(mail.body, /Riley Test\n- 15 minutes this week/);
  assert.ok(mail.body.includes('/s/' + b.token) && mail.body.includes('/d/' + c.code));

  assert.strictEqual(ok('admin.sendWeeklyUpdates', ADMIN).sent, 0); // already sent this week

  // A week later, after the readathon ended on the 15th: one final summary, then nothing.
  const later = (today) => (action, params) => handleApi(store, { ...env, today: () => today }, { action, ...params });
  r = later('2026-10-18')('admin.sendWeeklyUpdates', ADMIN).data;
  assert.strictEqual(r.sent, 1);
  assert.match(outbox[1].subject, /results/);
  assert.match(outbox[1].body, /is over/);
  assert.strictEqual(later('2026-10-22')('admin.sendWeeklyUpdates', ADMIN).data.sent, 0);
  assert.match(later('2026-10-30')('admin.sendWeeklyUpdates', ADMIN).data.skipped, /ended/);

  // Unsubscribe turns off weekly updates for that address across students.
  const key = /unsubscribe\.html\?k=([A-Za-z0-9]+)/.exec(mail.body)[1];
  assert.strictEqual(ok('contact.unsubscribe', { key }).email, 'fam@example.com');
  assert.ok(ok('admin.overview', ADMIN).students.every((s) => s.contacts.every((x) => !x.weeklyUpdates)));
  assert.strictEqual(call('contact.unsubscribe', { key: 'x'.repeat(24) }).status, 404);
});

test('weekly updates wait for the readathon to start and can be turned off', () => {
  const { ok, students } = setup('2026-10-01');
  ok('admin.setContacts', { ...ADMIN, studentId: students[0].studentId, sendLinks: false, contacts: [{ email: 'x@example.com', weeklyUpdates: true }] });
  assert.match(ok('admin.sendWeeklyUpdates', ADMIN).skipped, /hasn't started/);
  ok('admin.saveSettings', { ...ADMIN, settings: { weeklyUpdatesEnabled: false } });
  assert.match(ok('admin.sendWeeklyUpdates', ADMIN).skipped, /turned off/);
});

function session(id, code, cents, extra = {}) {
  return { id, client_reference_id: code, amount_total: cents, currency: 'usd', payment_status: 'paid', created: 1791500000, ...extra };
}

test('donations sync from Stripe: refunds, unpaid and foreign-currency payments, totals by student, grade and class', () => {
  const { ok, env, students } = setup();
  const [avery, jordan, riley] = students; // K/Ms. Rivera, 3/Mr. Chen, 3/Mr. Chen
  env.sessions = [
    session('cs_1', jordan.code, 2500),
    session('cs_2', jordan.code.toLowerCase(), 5000),
    session('cs_3', riley.code, 1000, { payment_intent: { latest_charge: { amount: 1000, amount_refunded: 400 } } }),
    session('cs_4', avery.code, 3000, { payment_status: 'unpaid' }), // bank payment not cleared yet
    session('cs_5', null, 2000), // no student: still counts school-wide
    session('cs_6', avery.code, 920, { currency: 'eur', currency_conversion: { source_currency: 'usd', amount_total: 1000 } }),
    session('cs_7', avery.code, 4000, { payment_intent: { latest_charge: { amount: 4000, amount_refunded: 4000 } } }),
  ];
  const r = ok('admin.syncDonations', ADMIN);
  assert.strictEqual(r.sessions, 7);
  assert.strictEqual(r.total, 2500 + 5000 + 600 + 2000 + 1000);
  assert.strictEqual(r.donations, 5);
  assert.strictEqual(env.stripeCalls.length, 4); // paged
  assert.strictEqual(env.stripeCalls[1].starting_after, 'cs_2');

  const o = ok('admin.overview', ADMIN);
  assert.deepStrictEqual(o.students.map((x) => x.raised), [1000, 7500, 600]);
  assert.deepStrictEqual(o.classes.map((c) => [c.teacher, c.raised]), [['Ms. Rivera', 1000], ['Mr. Chen', 8100]]);
  assert.strictEqual(o.donations.total, 11100);
  assert.ok(o.donations.syncedAt && o.donations.stripeConfigured);

  const home = ok('home', {});
  assert.strictEqual(home.donations.total, 11100);
  assert.deepStrictEqual(home.donations.grades, [{ grade: 'K', raised: 1000 }, { grade: '3', raised: 8100 }]);
  assert.deepStrictEqual(home.donations.classes.map((c) => [c.teacher, c.raised]), [['Mr. Chen', 8100], ['Ms. Rivera', 1000]]);

  // A refund made later is picked up by the next sync.
  env.sessions[0].payment_intent = { latest_charge: { amount: 2500, amount_refunded: 2500 } };
  assert.strictEqual(ok('admin.syncDonations', ADMIN).total, 8600);
});

test('donation totals: hidden until synced, organizers can turn them off, per-student amounts are opt-in', () => {
  const { ok, env, students } = setup();
  const s = students[1];
  env.sessions = [session('cs_1', s.code, 2500)];
  assert.strictEqual(ok('home', {}).donations, null); // never synced
  ok('admin.syncDonations', ADMIN);

  let home = ok('home', {});
  assert.strictEqual(home.donations.total, 2500);
  assert.ok(home.grades.every((g) => !('raised' in g)));
  let view = ok('student.get', { token: s.token });
  assert.strictEqual(view.raised, 2500);
  assert.strictEqual(view.prefs.showRaised, false); // off by default
  assert.strictEqual(ok('donation.get', { code: s.code }).raised, undefined);

  ok('student.setPrefs', { token: s.token, showRaised: true });
  const d = ok('donation.get', { code: s.code });
  assert.strictEqual(d.raised, 2500);
  assert.strictEqual(d.donationCount, 1);

  ok('admin.saveSettings', { ...ADMIN, settings: { showDonationTotals: false } });
  home = ok('home', {});
  assert.strictEqual(home.donations, null);
  assert.ok((home.classes || []).every((c) => !('raised' in c)));
  assert.strictEqual(ok('donation.get', { code: s.code }).raised, undefined);
  view = ok('student.get', { token: s.token });
  assert.strictEqual(view.raised, undefined);
  assert.strictEqual(view.donationTotalsEnabled, false);
  assert.strictEqual(ok('admin.overview', ADMIN).donations.total, 2500); // organizers still see it
});

test('donation sync reports Stripe problems and needs Stripe settings', () => {
  const { ok, call, store, env } = setup();
  env.stripeError = 'Invalid API Key provided';
  const r = call('admin.syncDonations', ADMIN);
  assert.strictEqual(r.status, 502);
  assert.match(r.error, /Invalid API Key/);
  assert.match(ok('admin.overview', ADMIN).donations.syncError, /Invalid API Key/);
  env.stripeError = null;
  ok('admin.syncDonations', ADMIN);
  assert.strictEqual(ok('admin.overview', ADMIN).donations.syncError, '');

  const noStripe = handleApi(store, { ...env, stripeGet: null }, { action: 'admin.syncDonations', ...ADMIN });
  assert.match(noStripe.error, /STRIPE_API_KEY/);
  assert.strictEqual(call('admin.syncDonations', { idToken: 'stranger' }).status, 403);
});

test('donation page leaves off minutes and books until the student has entered some', () => {
  const { ok, students } = setup();
  const s = students[0];
  ok('student.setPrefs', { token: s.token, goalMinutes: 300 });
  let d = ok('donation.get', { code: s.code });
  assert.strictEqual(d.totalMinutes, undefined);
  assert.strictEqual(d.goalMinutes, undefined);
  assert.strictEqual(d.books, undefined);
  assert.strictEqual(d.classMinutes, 0); // class totals aren't the student's own data

  ok('student.setMinutes', { token: s.token, date: '2026-10-09', minutes: 20 });
  ok('student.addBook', { token: s.token, title: 'Frog and Toad', status: 'reading' });
  d = ok('donation.get', { code: s.code });
  assert.strictEqual(d.totalMinutes, 20);
  assert.strictEqual(d.goalMinutes, 300);
  assert.strictEqual(d.books.length, 1);
});

test('links emails: one per address, listing every student that address follows', () => {
  const { ok, students, outbox } = setup();
  const [a, b, c] = students;
  const add = (st, contacts) => ok('admin.setContacts', { ...ADMIN, studentId: st.studentId, sendLinks: false, contacts });
  add(a, [{ email: 'parent@example.com', weeklyUpdates: true }, { email: 'grandma@example.com' }]);
  add(b, [{ email: 'parent@example.com' }]);
  add(c, [{ email: 'other@example.com' }]);

  const preview = ok('admin.previewEmails', { ...ADMIN, kind: 'links' });
  assert.deepStrictEqual(preview, { emails: 3, students: 3, quotaLeft: 100 });
  const r = ok('admin.emailLinks', ADMIN);
  assert.strictEqual(r.sent, 3);
  assert.strictEqual(r.quotaLeft, 97);
  const mail = outbox.find((m) => m.to === 'parent@example.com');
  assert.strictEqual(mail.subject, 'Avery and Jordan\'s Bishop Readathon links');
  assert.match(mail.body, /contact for Avery Example and Jordan Sample/);
  assert.ok(mail.body.includes('/s/' + a.token) && mail.body.includes('/s/' + b.token));
  assert.ok(mail.body.includes('/d/' + a.code) && mail.body.includes('/d/' + b.code));
  assert.match(mail.body, /weekly update on Avery's reading/); // only Avery's contact row is subscribed
  assert.ok(ok('admin.overview', ADMIN).students.every((s) => s.contacts.every((x) => x.linksSentAt)));
  assert.deepStrictEqual(ok('admin.previewEmails', { ...ADMIN, kind: 'links' }), { emails: 0, students: 0, quotaLeft: 97 });
  assert.strictEqual(ok('admin.previewEmails', { ...ADMIN, kind: 'links', studentId: a.studentId }).emails, 2); // resend
});

test('bulk sends stop at the daily quota and pick up the rest later', () => {
  const { ok, env, students, outbox } = setup();
  students.forEach((st, i) => ok('admin.setContacts', {
    ...ADMIN, studentId: st.studentId, sendLinks: false, contacts: [{ email: `fam${i}@example.com`, weeklyUpdates: true }],
  }));
  env.quota = 2;
  let r = ok('admin.emailLinks', ADMIN);
  assert.deepStrictEqual([r.sent, r.remaining, r.quotaLeft], [2, 1, 0]);
  assert.strictEqual(ok('admin.overview', ADMIN).emailQuotaLeft, 0);
  env.quota = 10; // "tomorrow"
  r = ok('admin.emailLinks', ADMIN);
  assert.deepStrictEqual([r.sent, r.remaining], [1, 0]);
  assert.deepStrictEqual(outbox.map((m) => m.to), ['fam0@example.com', 'fam1@example.com', 'fam2@example.com']);

  assert.deepStrictEqual(ok('admin.previewEmails', { ...ADMIN, kind: 'weekly' }), { emails: 3, students: 3, quotaLeft: 7 });
  env.quota = outbox.length + 1;
  r = ok('admin.sendWeeklyUpdates', ADMIN);
  assert.deepStrictEqual([r.sent, r.remaining, r.quotaLeft], [1, 2, 0]);
  assert.strictEqual(ok('admin.previewEmails', { ...ADMIN, kind: 'weekly' }).emails, 2);

  ok('admin.saveSettings', { ...ADMIN, settings: { weeklyUpdatesEnabled: false } });
  assert.match(ok('admin.previewEmails', { ...ADMIN, kind: 'weekly' }).skipped, /turned off/);
});

