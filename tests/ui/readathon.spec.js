// End-to-end flows against the dev server (fresh in-memory data, today = 2026-10-09).
const { test, expect } = require('@playwright/test');

// Tiny 2x3 PNG so cover images "load" without hitting Open Library
// (the app ignores 1x1 images, which Open Library returns for missing covers).
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGMQ1vQGIgYUCgAf/gMrQrmzIAAAAABJRU5ErkJggg==', 'base64');

async function stubOpenLibrary(page) {
  await page.route('https://openlibrary.org/search.json**', (route) => route.fulfill({
    json: { docs: [{ title: 'Charlotte\'s Web', author_name: ['E. B. White'], cover_i: 8228691, isbn: ['9780064400558'] }] },
  }));
  await page.route('https://covers.openlibrary.org/**', (route) => route.fulfill({ body: PIXEL, contentType: 'image/png' }));
}

async function students(request) {
  const res = await request.post('/api', { data: { action: 'admin.overview', idToken: 'dev:organizer@example.com' } });
  return (await res.json()).data.students;
}

test.beforeEach(async ({ page }) => {
  await stubOpenLibrary(page);
});

test('student logs minutes, picks a book, and hides things from the donation page', async ({ page, request }) => {
  // The dev seed gives every other student demo minutes; use one without any.
  const s = (await students(request))[1];
  await page.goto('/s/' + s.token);
  await expect(page.getByRole('heading', { name: `Hi, ${s.firstName}!` })).toBeVisible();

  await page.getByLabel('Minutes read today').fill('25');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#today-status')).toHaveText('Saved ✓');
  await page.getByRole('button', { name: '+10' }).click();
  await expect(page.locator('#today-status')).toHaveText('Saved ✓');
  await expect(page.getByLabel('Minutes read on Thu, Oct 8')).toBeVisible();
  await page.getByLabel('Minutes read on Thu, Oct 8').fill('15');
  await page.getByLabel('Minutes read on Thu, Oct 8').press('Tab');
  await expect(page.locator('[data-bind=totalMinutes]')).toHaveText('50');
  await expect(page.getByLabel('Minutes read on Fri, Oct 9')).toHaveValue('35');

  await page.getByRole('button', { name: 'Add my book' }).click();
  await page.locator('#current-title').fill('charlotte');
  await page.getByRole('button', { name: /Charlotte's Web/ }).click();
  await expect(page.locator('#current-author')).toHaveValue('E. B. White');
  await page.getByRole('button', { name: 'Save book' }).click();
  await expect(page.locator('#current-book .title')).toHaveText("Charlotte's Web");
  await expect(page.locator('#current-book img.cover')).toBeVisible();

  await page.getByRole('button', { name: /I finished it/ }).click();
  await expect(page.locator('#finished-books .title')).toHaveText("Charlotte's Web");

  await page.getByLabel('My reading goal (minutes)').fill('300');
  await page.getByLabel('My reading goal (minutes)').press('Tab');
  await expect(page.locator('#prefs-status')).toHaveText('Saved ✓');

  // Donation page shows everything by default.
  const donate = await page.context().newPage();
  await stubOpenLibrary(donate);
  await donate.goto('/d/' + s.code);
  await expect(donate.getByRole('heading', { name: `Support ${s.firstName} ${s.lastName[0]}.'s reading!` })).toBeVisible();
  await expect(donate.locator('.stat').first()).toContainText('50');
  await expect(donate.locator('#shelf .title')).toHaveText("Charlotte's Web");
  await expect(donate.locator('#shelf img.cover')).toBeVisible();
  await expect(donate.locator('#goal-card')).toContainText('300 minutes');
  await expect(donate.locator('#donate-link')).toHaveText(`Donate in honor of ${s.firstName}`);
  await expect(donate.locator('#donate-link')).toHaveAttribute('href',
    `https://donate.stripe.com/test_00wbJ2ebP3zB8pObgZcjS00?client_reference_id=${s.code}`);

  // Hide the reading list and minutes, then check the donation page again.
  await page.getByLabel('Show my reading list').uncheck();
  await expect(page.locator('#prefs-status')).toHaveText('Saved ✓');
  await page.getByLabel("Show how many minutes I've read").uncheck();
  await expect(page.locator('#prefs-status')).toHaveText('Saved ✓');
  await donate.reload();
  await expect(donate.locator('#donate-link')).toBeVisible();
  await expect(donate.locator('#reading')).toBeHidden();
  await expect(donate.locator('#goal-card')).toBeHidden();
  await expect(donate.locator('.stat')).toHaveCount(1); // class minutes only
});

test('bad links show a friendly error', async ({ page }) => {
  await page.goto('/s/notARealTokenAtAll1234');
  await expect(page.getByRole('alert')).toContainText('could not find');
  await page.goto('/d/NOPE99');
  await expect(page.getByRole('alert')).toContainText('could not find');
});

test('organizer signs in, sees the donation link status, and can only use a PTO reply-to', async ({ page, request }) => {
  const s = (await students(request))[2];
  await page.goto('/admin');
  // The dev server stands in for Google: only DEV_ADMINS count as spreadsheet editors.
  await page.getByLabel('Email', { exact: true }).fill('parent@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#login-status')).toContainText("doesn't have edit access");
  await page.getByLabel('Email', { exact: true }).fill('organizer@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#overview-stats')).toContainText('total minutes');
  await expect(page.locator('#who')).toHaveText('organizer@example.com');

  // The session survives a reload (sessionStorage) and ends on sign out.
  await page.reload();
  await expect(page.locator('#overview-stats')).toContainText('total minutes');

  await page.getByRole('tab', { name: 'Students & links' }).click();
  await page.getByPlaceholder(/Search by name/).fill(s.code);
  await expect(page.locator('#student-rows tr')).toHaveCount(1);

  // Donate buttons come from Script Properties; the dev server uses the test-mode link.
  await expect(page.locator('#donation-link-status')).toContainText('test-mode link');

  // Replies can only go to the PTO's own domain.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel(/Reply-to address/).fill('someone@gmail.com');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#settings-status')).toHaveText('The reply-to address must be an @bishopschoolpto.com email address.');
  await page.getByLabel(/Reply-to address/).fill('readathon@bishopschoolpto.com');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#settings-status')).toHaveText('Saved ✓');
  await expect(page.getByLabel(/Site URL/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Organizer sign in' })).toBeVisible();
});

test('home page shows school totals', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bishop Readathon' })).toBeVisible();
  await expect(page.getByText('minutes read school-wide')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Class leaderboard' })).toBeVisible();
});

test('family emails get the links, organizers resend them, and weekly updates can be stopped', async ({ page, request }) => {
  const s = (await students(request))[3];
  await page.goto('/s/' + s.token);
  await page.getByLabel('Family email 1', { exact: true }).fill('mom@example.com');
  await page.getByLabel('Weekly updates for family email 1').check();
  await page.getByLabel('Family email 2', { exact: true }).fill('dad@example.com');
  await page.getByRole('button', { name: 'Save emails' }).click();
  await expect(page.locator('#contacts-status')).toContainText('emailed the links to 2 new addresses');

  const outbox = async () => (await (await request.get('/dev/outbox')).json()).filter((m) => m.body.includes(s.token));
  let mail = await outbox();
  expect(mail.map((m) => m.to).sort()).toEqual(['dad@example.com', 'mom@example.com']);
  expect(mail[0].body).toContain('/d/' + s.code);

  // Organizer sees the emails and resends the links, confirming the count first.
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('organizer@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('tab', { name: 'Students & links' }).click();
  await expect(page.locator('[data-panel=students] .quota')).toContainText('Emails left today:');
  await page.getByPlaceholder(/Search by name/).fill('mom@example.com');
  await expect(page.locator('#student-rows > tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Emails (2)' }).click();
  await expect(page.getByLabel('Family email 1', { exact: true })).toHaveValue('mom@example.com');
  await page.getByRole('button', { name: 'Resend links to all' }).click();
  await expect(page.locator('.contacts-editor .status')).toHaveText('2 email(s) sent.');
  expect(dialogs.pop()).toMatch(/^Send 2 email\(s\) to the families of 1 student\(s\)\?\n\nEmails left today: \d+\.$/);
  expect((await outbox()).length).toBe(4);

  // Bulk send: everyone with an address already has their links.
  await page.getByRole('button', { name: 'Email links to families' }).click();
  await expect(page.locator('#sync-notice')).toContainText('Nothing to send');

  // The weekly update's unsubscribe link (dev seed: the readathon is under way).
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: "Send this week's updates now" }).click();
  await expect(page.locator('#weekly-status')).toContainText('email(s) sent');
  expect(dialogs.pop()).toMatch(/^Send \d+ email\(s\) to the families of \d+ student\(s\)\?/);
  mail = (await outbox()).find((m) => m.to === 'mom@example.com' && /this week/.test(m.subject));
  const link = /(\/unsubscribe\.html\?k=\w+)/.exec(mail.body)[1];
  await page.goto(link);
  await page.getByRole('button', { name: 'Stop weekly updates' }).click();
  await expect(page.locator('#status')).toContainText("mom@example.com won't get weekly updates");
  await page.goto('/s/' + s.token);
  await expect(page.getByLabel('Weekly updates for family email 1')).not.toBeChecked();
});

test('money raised: school totals by grade and class, and per student only when the student opts in', async ({ page, request }) => {
  // Dev server's fake Stripe: $25 for the first student, a fully refunded gift, one unattributed $20...
  const s = (await students(request))[0];
  await page.goto('/');
  await expect(page.locator('.stat').filter({ hasText: 'raised for the PTO' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Raised by grade' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Raised by class' })).toBeVisible();
  await expect(page.locator('tr', { hasText: s.teacher }).last()).toContainText('$');

  await page.goto('/d/' + s.code);
  await expect(page.locator('#donate-link')).toHaveAttribute('href', /donate\.stripe\.com\/.*client_reference_id=/);
  await expect(page.getByText(/raised for/)).toHaveCount(0); // off by default

  await page.goto('/s/' + s.token);
  await expect(page.locator('#raised-stat')).toContainText('$25');
  await page.getByLabel('Show how much money has been raised for me').check();
  await expect(page.locator('#prefs-status')).toHaveText('Saved ✓');
  await page.goto('/d/' + s.code);
  await expect(page.locator('.stat').first()).toContainText('$25');
  await expect(page.locator('.stat').first()).toContainText(`raised for ${s.firstName}'s readathon`);

  // Organizers can hide totals from the site.
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('organizer@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#donation-status')).toContainText('Last synced');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel(/Show money raised on the site/).uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#settings-status')).toHaveText('Saved ✓');
  await page.goto('/');
  await expect(page.getByText('minutes read school-wide')).toBeVisible();
  await expect(page.getByText(/raised/i)).toHaveCount(0);
  await page.goto('/d/' + s.code);
  await expect(page.locator('#donate-link')).toBeVisible();
  await expect(page.getByText(/raised for/)).toHaveCount(0);
});

test('a donation page with no minutes or books yet shows neither section', async ({ page, request }) => {
  const s = (await students(request))[5]; // odd index: no demo minutes
  await page.goto('/d/' + s.code);
  await expect(page.locator('#donate-link')).toBeVisible();
  await expect(page.getByText('minutes read', { exact: true })).toHaveCount(0);
  await expect(page.getByText('books finished')).toHaveCount(0);
  await expect(page.locator('#reading')).toBeHidden();
  await expect(page.locator('.stat')).toHaveCount(1); // the class's minutes
});


// Embedded donation form (?checkout=embedded), with the Worker, Turnstile and Stripe.js faked.
const WORKER = 'https://checkout.example.workers.dev';

async function stubEmbeddedCheckout(page, { configured = true, sessionStatus = 'complete', createError = null } = {}) {
  const seen = { created: [], statusChecks: [] };
  await page.route('**/config.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'window.READATHON_CONFIG = ' + JSON.stringify(configured
      ? { apiUrl: '/api', checkoutApiUrl: WORKER, stripePublishableKey: 'pk_test_x', turnstileSiteKey: '1x00000000000000000000AA' }
      : { apiUrl: '/api' }) + ';',
  }));
  await page.route('https://challenges.cloudflare.com/turnstile/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.turnstile = {
      render: function (el, opts) { window.__turnstileOpts = opts; setTimeout(function () { opts.callback('ts-token'); }, 0); return 'w1'; },
      reset: function () { window.__turnstileResets = (window.__turnstileResets || 0) + 1; },
      remove: function () {},
    };`,
  }));
  await page.route('https://js.stripe.com/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.Stripe = function (pk) {
      return { createEmbeddedCheckoutPage: function (opts) {
        return opts.fetchClientSecret().then(function (secret) {
          return { mount: function (sel) { document.querySelector(sel).textContent = 'Stripe form for ' + secret + ' with ' + pk; } };
        });
      } };
    };`,
  }));
  await page.route(WORKER + '/**', async (route) => {
    const req = route.request();
    if (req.url().includes('/checkout-session')) {
      seen.created.push(req.postDataJSON());
      return createError
        ? route.fulfill({ status: 403, json: { error: createError } })
        : route.fulfill({ json: { clientSecret: 'cs_test_1_secret_x' } });
    }
    seen.statusChecks.push(new URL(req.url()).searchParams.get('session_id'));
    return route.fulfill({ json: { status: sessionStatus, paymentStatus: 'paid' } });
  });
  return seen;
}

test('embedded donation form: only with ?checkout=embedded and a configured Worker', async ({ page, request }) => {
  const s = (await students(request))[0];
  let seen = await stubEmbeddedCheckout(page);

  // No URL param: the usual Payment Link button.
  await page.goto('/d/' + s.code);
  await expect(page.locator('#donate-link')).toBeVisible();
  await expect(page.locator('#embedded-donate')).toBeHidden();

  // With it: Turnstile, then Stripe's form, created for this student with the Turnstile token.
  await page.goto('/d/' + s.code + '?checkout=embedded');
  await expect(page.locator('#checkout')).toHaveText('Stripe form for cs_test_1_secret_x with pk_test_x');
  await expect(page.locator('#donate-link')).toBeHidden();
  expect(seen.created).toEqual([{ code: s.code, turnstileToken: 'ts-token' }]);
  expect(await page.evaluate(() => window.__turnstileOpts.action)).toBe('donate');

  // Back from Stripe: thank you, and the session id is dropped from the address bar.
  await page.goto('/donate.html?c=' + s.code + '&checkout=embedded&session_id=cs_test_abc');
  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  await expect(page.locator('#donate-card')).toContainText(`in honor of ${s.firstName} was received`);
  await expect(page.locator('#checkout')).toBeEmpty();
  expect(seen.statusChecks).toEqual(['cs_test_abc']);
  expect(new URL(page.url()).searchParams.get('session_id')).toBeNull();

  // Not configured: the URL param is ignored.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await stubOpenLibrary(page);
  seen = await stubEmbeddedCheckout(page, { configured: false });
  await page.goto('/d/' + s.code + '?checkout=embedded');
  await expect(page.locator('#donate-link')).toBeVisible();
  await expect(page.locator('#embedded-donate')).toBeHidden();
  expect(seen.created).toEqual([]);
});

test('embedded donation form: unfinished payments and Worker errors offer a way to retry', async ({ page, request }) => {
  const s = (await students(request))[0];
  await stubEmbeddedCheckout(page, { sessionStatus: 'open' });
  await page.goto('/donate.html?c=' + s.code + '&checkout=embedded&session_id=cs_test_abc');
  await expect(page.locator('#checkout-msg')).toHaveText(/didn't go through/);
  await expect(page.locator('#checkout')).toContainText('Stripe form for');

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await stubOpenLibrary(page);
  await stubEmbeddedCheckout(page, { createError: 'We could not confirm you are a person.' });
  await page.goto('/d/' + s.code + '?checkout=embedded');
  await expect(page.locator('#checkout-msg')).toHaveText('We could not confirm you are a person.');
  await expect(page.locator('#checkout-fallback-link')).toHaveAttribute('href', /donate\.stripe\.com\/.*client_reference_id=/);
  expect(await page.evaluate(() => window.__turnstileResets)).toBe(1);
});
