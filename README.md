# Bishop School Readathon

A school-wide readathon app for **readathon.bishopschoolpto.com**:

- **Students** get a private link (`/s/<token>`) where they log daily minutes, fix past days, record the book they're reading and books they've finished, set a goal, and choose what their donation page shows.
- **Families** can add up to 5 email addresses per student, on the student's page or in `/admin`. Each address is emailed the student's log link and donation link, and can opt in to a weekly progress update.
- **Donors** visit a short link (`/d/<CODE>`) showing the student, their progress, and their bookshelf with covers from Open Library, plus a **Donate** button that opens a Stripe-hosted donation page tagged with the student's code.
- **Money raised** is copied from Stripe every 10 minutes and shown school-wide, by grade and by class. Students can choose to show their own amount on their donation page (off by default), and organizers can hide all totals from the site.
- **Organizers** use `/admin` to sync the roster, hand out links (CSV or printable slips), see totals by class, and change settings.
- **The home page** (`/`) shows school-wide totals and an optional class leaderboard.

## How it fits together

```
readathon.bishopschoolpto.com  (static files in public/)
        │  fetch, JSON
        ▼
Google Apps Script web app      (apps-script/, deployed with clasp)
        │
        ├── Roster spreadsheet  ← the school's data; the app only reads it
        └── Data spreadsheet    ← everything the app writes
```

All app logic is in `apps-script/Core.js`. Apps Script runs it, and so does the local dev server, so local behavior matches production.

### Roster spreadsheet (you maintain it)

The first tab, or the one named in `ROSTER_SHEET_NAME`, with a header row:

| Student ID | First Name | Last Name | Grade | Teacher |
|---|---|---|---|---|
| 1001 | Avery | Example | K | Ms. Rivera |

- **Student ID** is required and must be unique and stable. If you don't have school IDs, number the rows 1, 2, 3… and never reuse a number.
- Common variations are recognized, e.g. `ID`, `Student Name` (as "First Last" or "Last, First"), `Grade Level`, `Homeroom`.
- "Classmates" means students who share the same Teacher value.

### Data spreadsheet (the app maintains it)

| Tab | One row per | Columns |
|---|---|---|
| Settings | setting | key, value |
| Students | student | studentId, name/grade/teacher (for reference), private **token**, donation **code**, goal, donation-page toggles |
| Minutes | student per day | studentId, date, minutes, updatedAt |
| Books | book | bookId, studentId, title, author, status (`reading`/`finished`), coverId, isbn |
| Contacts | family email per student | studentId, email, weeklyUpdates, unsubscribeKey, linksSentAt, lastUpdateSentAt |
| Donations | completed Stripe payment | sessionId, studentCode, amount, refunded (US dollars), currency, paymentStatus, createdAt. **Rewritten on every sync, so don't edit it or add columns.** |

`Minutes` uses one row per student per day, so pivot tables work directly. You can add your own columns to the right; the app keeps them. Don't rename the existing headers.

## Setup

### 1. Create the Apps Script backend

```bash
npm install
npm run gas:login        # sign in with the Google account that will own the spreadsheets
npm run gas:create       # creates the Apps Script project and .clasp.json
npm run gas:push
```

The first time, enable the Apps Script API at https://script.google.com/home/usersettings.

Then open the project (`npx clasp open-script`), choose **setup** in the function dropdown, and click **Run**. Approve the permission prompt. `setup()`:

- creates a **Readathon Roster** spreadsheet with sample rows, unless you've already set `ROSTER_SPREADSHEET_ID`
- creates the **Readathon Data** spreadsheet and its tabs
- gives every roster student a token and code
- installs the donation-sync trigger (every 10 minutes; it does nothing until the Stripe properties are set)
- installs the weekly-update trigger (Sundays around 5pm, in the script's time zone; change it under **Triggers** in the editor)
- asks for permission to send email as you

The execution log at the bottom of the editor shows the spreadsheet URLs. These values live under **Project Settings → Script properties**:

| Property | Meaning |
|---|---|
| `ROSTER_SPREADSHEET_ID` | ID from the roster's URL (`/spreadsheets/d/<ID>/edit`). Set this before running `setup()` to use an existing roster. |
| `ROSTER_SHEET_NAME` | Optional tab name; defaults to the first tab. |
| `DATA_SPREADSHEET_ID` | Created by `setup()`. |
| `GOOGLE_CLIENT_ID` | OAuth client ID for organizer sign-in (next step). |
| `STRIPE_API_KEY` | Restricted, read-only Stripe key for donation totals (see **Donations with Stripe**). |
| `STRIPE_PAYMENT_LINK_URL` | The donation Payment Link's `https://donate.stripe.com/…` URL. Every donation page's donate button points here. Without it, donation pages have no donate button. |
| `STRIPE_PAYMENT_LINK_ID` | The same Payment Link's ID (`plink_…`). Only payments through this link are counted. |

### 2. Set up "Sign in with Google" for organizers

Organizers sign in to `/admin` with Google. **Anyone who can edit the Readathon Data spreadsheet is an organizer.** To add an organizer, share the sheet with them as an editor; to remove one, unshare it. Changes take effect within 5 minutes.

To create the sign-in client (once, in the same Google account):

1. Open https://console.cloud.google.com, then create or pick a project.
2. Go to **APIs & Services → OAuth consent screen** (also called "Google Auth Platform → Branding"). Choose **External**, enter an app name such as "Bishop Readathon" and your email, then save. Sign-in uses only basic scopes (email, profile), so Google doesn't need to review the app.
3. Go to **Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins**, add `https://readathon.bishopschoolpto.com`.
4. Copy the client ID (`…apps.googleusercontent.com`) into two places:
   - the `GOOGLE_CLIENT_ID` script property
   - `googleClientId` in `public/config.js`

   Client IDs aren't secret.

How the server checks each admin request:

- Google confirms the ID token is genuine and unexpired.
- The token was issued to *this* client ID, so a sign-in token from another site won't work.
- The email is verified.
- The email is the data spreadsheet's owner or one of its editors.

A few cases don't work:

- Sharing with a **Google Group** doesn't grant access, because the script sees only the group's address. Share with individual people instead.
- "Anyone with the link can edit" doesn't grant access either.
- Viewers and commenters on the spreadsheet aren't organizers.

### 3. Deploy the web app

```bash
npm run gas:deploy
```

Or in the editor: **Deploy → New deployment → Web app**, *Execute as: Me*, *Who has access: Anyone*. Copy the `/exec` URL into `public/config.js`.

Ship later backend changes with `npm run gas:push && npm run gas:redeploy -- <deploymentId>`. Updating the existing deployment keeps the same URL. If an update adds a tab or needs a new permission (the family-emails update adds the **Contacts** tab and email sending; the Stripe update adds the **Donations** tab, a `showRaised` column on **Students**, and permission to call Stripe), run `setup()` again after pushing and before redeploying.

Google's login isn't required for students or donors: the web app runs as you, and the spreadsheets stay private to you.

### 4. Host the site at readathon.bishopschoolpto.com

`public/` is a plain static site with no build step.

- **Cloudflare Pages or Netlify (recommended):** publish `public/`. `_redirects` maps `/s/*`, `/d/*` and `/admin` to the right pages. Add `readathon.bishopschoolpto.com` as a custom domain and create the CNAME record they give you.
- **GitHub Pages:** publish `public/`. `CNAME` is included, and `404.html` redirects the pretty URLs, since GitHub Pages has no rewrites.

### 5. Run the readathon

1. Fill in the roster. In `/admin`: set the dates, title and goal under **Settings**, then click **Sync roster** under **Students & links**. Sync again whenever students are added.
2. Give each student their private log link via **Download CSV** (e.g. for a mail merge to families) or **Print link slips**.
3. Set up donations (see **Donations with Stripe**). The **Overview** tab says whether donate buttons use a test-mode or live link.
4. Collect family emails. Families can add them on the student's page, organizers can add them under **Students & links → Add emails**, or you can paste `studentId, email` rows (plus `TRUE` in `weeklyUpdates` for opted-in addresses) straight into the **Contacts** tab and then click **Email links to families**. That sends the links to every address that hasn't been sent them yet.
5. When the readathon ends, tick **Lock reading logs** so totals stop changing.

## Family emails

- Each student can have up to 5 addresses. When an address is added, it's emailed the student's private log link and donation link. Bulk sends group by address: a parent listed for two children gets one email with both children's links. The student page can trigger at most 10 of these emails per student per day. Organizers can resend them, for example after **New log link**.
- **Weekly updates** go to opted-in addresses on Sundays. Each email covers every student that address follows: minutes this week and in total, goal progress, and books finished. An address that already got an update in the last 5 days is skipped, so **Send this week's updates now** (under Settings) and the trigger won't double-send. Updates start once the start date has passed. After the end date, each address gets one final summary. Turn updates off under Settings.
- Every weekly email has an unsubscribe link (`/unsubscribe.html?k=…`). It stops weekly updates for that address for all the students it follows.
- Before **Email links to families**, **Resend links to all** and **Send this week's updates now**, `/admin` shows how many emails will go out and how many Google still allows today, and asks to confirm. **Emails left today** also appears under Students & links and Settings.
- Emails come from the Google account that deployed the script, named after the readathon title. Set a **reply-to** under Settings if replies should go somewhere else. It must be an `@bishopschoolpto.com` address. Google limits how many emails a script can send each day: about **100 recipients for a Gmail account** and 1,500 for Google Workspace. A weekly run that hits Apps Script's 6-minute limit continues on its own a few minutes later. Addresses skipped because the quota ran out get their update when you click **Send this week's updates now** the next day, or at the next Sunday run. If you have more families than that, deploy from a Workspace account.
- Locally, nothing is sent. Emails are printed to the console and can be read at `http://localhost:8082/dev/outbox`.

## Donations with Stripe

Donors pay on a Stripe-hosted **Payment Link** where they choose the amount: $25 suggested, $5 minimum, $1,000 maximum. Each donation page's **Donate in honor of {first name}** button adds `?client_reference_id=<student code>` to the link, so Stripe records which student each gift was for. Taking donations needs no secret key, and the site never sees card details.

The link comes from the `STRIPE_PAYMENT_LINK_URL` script property, not from the spreadsheet or `/admin`, so someone who takes over an organizer account can't point donors somewhere else. Only `https://donate.stripe.com/…` and `https://buy.stripe.com/…` URLs are accepted.

A **test-mode** link already exists in the PTO's Stripe sandbox: `https://donate.stripe.com/test_00wbJ2ebP3zB8pObgZcjS00` (`plink_1UVseEK9lkVDlZj3Ah70Jh7I`). Set it as `STRIPE_PAYMENT_LINK_URL` to try donations, and use [test cards](https://docs.stripe.com/testing) such as `4242 4242 4242 4242`.

**Show money raised (optional).** Apps Script can't verify Stripe webhooks because it can't read request headers. Instead, a trigger asks Stripe for the link's completed payments every 10 minutes and rewrites the **Donations** tab.

1. In Stripe, go to **Developers → API keys → Create restricted key**. Give it **Read** access to **Checkout Sessions**, **PaymentIntents** and **Charges** (the last two are needed to subtract refunds), and nothing else.
2. In Apps Script, under **Project Settings → Script properties**, add `STRIPE_API_KEY` (the `rk_…` key) and `STRIPE_PAYMENT_LINK_ID` (`plink_…`). Run `setup()` again.
3. In `/admin`, the **Overview** tab shows totals and when they were last synced. Click **Sync donations now** to refresh right away.

Only payments that Stripe marks `paid` count, minus refunds. Bank payments that are still clearing appear once they clear. Payments without a student code (for example, someone using the bare link) count toward the school total only. Organizers always see totals in `/admin`. **Settings → Show money raised on the site** controls everything public: the school total and the grade and class breakdowns on the home page, the student's own total on their log page, and per-student amounts on donation pages. Per-student amounts appear only for students who tick **Show how much money has been raised for me**, which is off by default. Organizers can change that default under Settings.

**Going live:**

1. Activate the PTO's Stripe account, then confirm whether the PTO has its own 501(c)(3) status or is covered by the district. Check what Stripe requires for [accepting donations](https://support.stripe.com/questions/requirements-for-accepting-tips-or-donations).
2. Turn on **Settings → Customer emails → Successful payments** so donors get a receipt. Add the PTO's EIN and tax-deductibility wording to the receipt or the link's custom text.
3. Create the same Payment Link in live mode ("Customers choose what to pay", call to action **Donate**).
4. Create a live restricted key as in step 1 above. Replace `STRIPE_PAYMENT_LINK_URL`, `STRIPE_PAYMENT_LINK_ID` and `STRIPE_API_KEY` with the live values, then click **Sync donations now**. The **Overview** tab should say the donate buttons use your live link.

Locally, the dev server fakes Stripe with a few demo donations.

### Embedded donation form (optional)

Adding `?checkout=embedded` to a donation link (`/d/<code>?checkout=embedded`) shows Stripe's payment form on the donation page instead of the **Donate** button. Without the parameter, or until everything below is set up, donation pages keep using the Payment Link. Both count toward the same totals.

The form needs a small server to create each Stripe Checkout Session, and Apps Script can't do that from a static page. So it runs as a **Cloudflare Worker** (`worker/`, free plan). The Worker:

- checks a **Cloudflare Turnstile** token before every session, so bots can't use the form to test stolen cards;
- creates the session for the same "customer chooses what to pay" price as the Payment Link, tagged with the student code and `metadata.app = readathon.bishopschoolpto.com`;
- tells the page whether a returning donor's payment went through.

It stores nothing. The Apps Script sync counts sessions from the Payment Link and sessions with that tag. To do that, it reads all of the Stripe account's completed Checkout Sessions, so on an account with many other sales it takes longer.

Set it up:

1. **Turnstile:** in the Cloudflare dashboard, go to **Turnstile → Add widget**. Add the hostname `readathon.bishopschoolpto.com` and choose **Managed** mode. Note the site key and secret key.
2. **Stripe key for the Worker:** create a restricted key with **Checkout Sessions: Write** and nothing else. If creating a session fails with a permissions error in the Worker's logs, also give it **Read** on **Prices** and **Products**. Use a sandbox key (`rk_test_…`) until you go live.
3. **Deploy the Worker:**
   ```bash
   npx wrangler login
   npx wrangler secret put STRIPE_SECRET_KEY --config worker/wrangler.jsonc
   npx wrangler secret put TURNSTILE_SECRET_KEY --config worker/wrangler.jsonc
   npm run worker:deploy
   ```
   `worker/wrangler.jsonc` holds the non-secret settings: the price ID (sandbox now, so change it when going live), the site URL, and the allowed origin and Turnstile hostname.
4. **Turn it on in `public/config.js`:** set `checkoutApiUrl` to the Worker's URL (`https://readathon-checkout.<account>.workers.dev`), `stripePublishableKey` to the `pk_test_…`/`pk_live_…` key from **Developers → API keys** (same mode as the Worker's key), and `turnstileSiteKey`. Push to deploy the site.
5. **Push the Apps Script code** so its donation sync counts the embedded sessions.

Going live means a live price ID in `wrangler.jsonc`, a live restricted key as the Worker's `STRIPE_SECRET_KEY`, and a live publishable key in `config.js`, all at the same time.

**Locally:** copy `worker/.dev.vars.example` to `worker/.dev.vars` and put a sandbox key in it. Run `npm run worker:dev`, then `DEV_CHECKOUT_API_URL=http://localhost:8787 DEV_STRIPE_PK=pk_test_… npm run dev`. The dev server uses Turnstile's always-passes test key. Open a donation page with `?checkout=embedded` and pay with `4242 4242 4242 4242`.

## Privacy and security

- **Private log links:** 24 random characters per student. They're never shown on donation pages, the pages send no `Referer`, and they're excluded from search engines. If one leaks, **New log link** in admin replaces it; the donation link stays the same.
- **Donation links:** they use a separate 6-character code and show only first name + last initial by default, plus whatever the student chose to show.
- **Spreadsheet safety:** all text is stored with a leading apostrophe, so student input can never become a spreadsheet formula.
- **Stripe key:** the only Stripe secret is a restricted, read-only key in Script Properties. It can't charge, refund or change anything. Donor names and emails aren't copied out of Stripe.
- **What a compromised organizer account can't do:** where the donate button points (`STRIPE_PAYMENT_LINK_URL`) and the site address in emails (always `https://readathon.bishopschoolpto.com`) aren't settings, so an organizer account or a spreadsheet editor can't change them. Email reply-to addresses must be `@bishopschoolpto.com`, and that's checked again before every send, so typing another address into the Settings tab does nothing. Script Properties can only be changed by people who can edit the Apps Script project, so keep that list to one or two people.
- **Organizer access:** organizers are the data spreadsheet's editors, signed in with Google and checked on every admin request (see step 2). Google's ID token lasts about an hour. The browser keeps it in `sessionStorage` until the tab closes, and when it expires the page asks the organizer to sign in again.
- **Family emails** are visible only on the student's private page and to organizers, never on donation pages. Emails carry the private log link, so they go only to the addresses listed for that student.
- **Spreadsheet editors see everything:** they can read every private log link in the Students tab whether or not they use `/admin`, so share the data spreadsheet only with organizers. The roster spreadsheet is separate and can be shared more widely.

## Local development

```bash
npm run dev        # http://localhost:8082 with a fake roster and demo data
```

The console prints the admin URL and some student and donation links. Google sign-in isn't used locally. Instead, the admin page offers an email box, and any address in `DEV_ADMINS` (default `organizer@example.com`) counts as a spreadsheet editor. Data is saved in `dev/data.json`; delete that file to start over. Book search and covers use Open Library directly, so they need internet access.

```bash
npm test           # unit tests for apps-script/Core.js
npm run test:ui    # Playwright browser tests (fresh in-memory data, fixed date)
```

## Limits

Apps Script handles a school of several hundred students comfortably. Each request takes ~1–2 s, and Google allows about 30 simultaneous executions per script. Totals are cached for 60 seconds and the roster for 5 minutes, so donation pages and the home page may lag slightly behind.
