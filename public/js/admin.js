// Organizer dashboard: /admin
(function () {
  var TOKEN_STORAGE = 'readathon.idToken';
  var config = window.READATHON_CONFIG || {};
  var idToken = '';
  var data = null;

  function $(id) { return document.getElementById(id); }
  function getStored() { try { return sessionStorage.getItem(TOKEN_STORAGE) || ''; } catch (e) { return ''; } }
  function setStored(v) { try { v ? sessionStorage.setItem(TOKEN_STORAGE, v) : sessionStorage.removeItem(TOKEN_STORAGE); } catch (e) { /* ignore */ } }
  async function adminApi(action, params) {
    try {
      return await RA.api(action, Object.assign({ idToken: idToken }, params || {}));
    } catch (err) {
      // Google ID tokens last about an hour; ask the organizer to sign in again.
      if (err.status === 401) showLogin(err.message);
      throw err;
    }
  }
  function setStatus(el, text, ok) {
    el.textContent = text;
    el.className = 'status ' + (ok ? 'ok' : 'err');
  }
  function studentUrl(s) { return location.origin + '/s/' + s.token; }
  function donateUrl(s) { return location.origin + '/d/' + s.code; }

  // --- Sign in ------------------------------------------------------------
  // Organizers sign in with Google. The server checks Google's ID token and
  // that the account can edit the readathon data spreadsheet.

  function showLogin(message) {
    idToken = '';
    setStored('');
    $('login').hidden = false;
    $('dash').hidden = true;
    $('logout').hidden = true;
    $('who').textContent = 'Organizer';
    setStatus($('login-status'), message || '', false);
    setupSignInButton();
  }

  var buttonReady = false;
  function setupSignInButton() {
    if (buttonReady) return;
    buttonReady = true;
    if (config.devSignIn) {
      $('dev-signin').hidden = false;
      $('dev-signin').onsubmit = function (e) {
        e.preventDefault();
        signIn('dev:' + $('dev-email').value.trim());
      };
      return;
    }
    if (!config.googleClientId || /REPLACE_WITH/.test(config.googleClientId)) {
      setStatus($('login-status'), 'Google sign-in is not set up yet: add googleClientId to config.js.', false);
      return;
    }
    var script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = function () {
      google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: function (response) { signIn(response.credential); },
        auto_select: true,
      });
      google.accounts.id.renderButton($('google-button'), { theme: 'filled_blue', size: 'large', text: 'signin_with' });
      google.accounts.id.prompt(); // One Tap: returning organizers may be signed straight back in
    };
    script.onerror = function () { setStatus($('login-status'), 'Could not load Google sign-in. Check your connection.', false); };
    document.head.appendChild(script);
  }

  $('logout').onclick = function () {
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    setStored('');
    location.reload();
  };

  async function signIn(token) {
    idToken = token;
    setStatus($('login-status'), '', true);
    try {
      await load();
      setStored(token);
      $('login').hidden = true;
      $('dash').hidden = false;
      $('logout').hidden = false;
      $('who').textContent = data.adminEmail;
    } catch (err) {
      showLogin(err.message);
    }
  }

  var stored = getStored();
  if (stored) signIn(stored); else showLogin('');

  async function load() {
    data = await adminApi('admin.overview');
    $('site-title').textContent = data.settings.readathonTitle;
    renderOverview();
    renderStudents();
    renderSettings();
    renderQuota();
  }

  // --- Tabs ----------------------------------------------------------------

  document.querySelectorAll('[data-tab]').forEach(function (btn) {
    btn.onclick = function () {
      document.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b === btn)); });
      document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== btn.dataset.tab; });
    };
  });

  // --- Overview ------------------------------------------------------------

  function renderOverview() {
    var total = 0, readers = 0, books = 0;
    data.students.forEach(function (s) {
      total += s.minutes;
      books += s.books;
      if (s.minutes > 0) readers++;
    });
    var tiles = [
      [RA.fmt(total), 'total minutes'],
      [RA.fmt(readers) + ' / ' + RA.fmt(data.students.length), 'students reading'],
      [RA.fmt(books), 'books logged'],
      [data.settings.schoolGoalMinutes ? RA.percent(total, data.settings.schoolGoalMinutes) + '%' : '—', 'of school goal'],
      [RA.money(data.donations.total), RA.fmt(data.donations.count) + ' donation(s)'],
    ];
    $('overview-stats').innerHTML = tiles.map(function (t) {
      return '<div class="stat"><div class="value">' + RA.esc(t[0]) + '</div><div class="label">' + RA.esc(t[1]) + '</div></div>';
    }).join('');
    $('class-rows').innerHTML = data.classes.map(function (c) {
      return '<tr><td>' + RA.esc(c.grade) + '</td><td>' + RA.esc(c.teacher) + '</td><td class="num">' + RA.fmt(c.students) +
        '</td><td class="num">' + RA.fmt(c.readers) + '</td><td class="num">' + RA.fmt(c.minutes) +
        '</td><td class="num">' + (c.readers ? RA.fmt(Math.round(c.minutes / c.readers)) : '—') +
        '</td><td class="num">' + RA.money(c.raised) + '</td></tr>';
    }).join('');
    renderDonationStatus();
  }

  function renderDonationStatus() {
    var d = data.donations;
    var el = $('donation-status');
    var link = $('donation-link-status');
    link.className = d.linkMode === 'live' ? 'small muted' : 'small status err';
    link.textContent = d.linkMode === 'live' ? 'Donate buttons use your live Stripe Payment Link.'
      : d.linkMode === 'test' ? 'Donate buttons use a Stripe test-mode link: donors can only pay with test cards. ' +
        'Set STRIPE_PAYMENT_LINK_URL to your live link before the readathon.'
      : 'Donation pages have no donate button: set STRIPE_PAYMENT_LINK_URL in Apps Script (see the README).';
    if (!d.stripeConfigured) {
      el.className = 'small muted';
      el.textContent = 'Stripe isn\'t connected yet: set STRIPE_API_KEY and STRIPE_PAYMENT_LINK_ID in Apps Script (see the README).';
    } else if (d.syncError) {
      el.className = 'small status err';
      el.textContent = d.syncError;
    } else {
      el.className = 'small muted';
      el.textContent = d.syncedAt ? 'Last synced ' + new Date(d.syncedAt).toLocaleString() + '. ' +
        (data.settings.showDonationTotals ? 'Totals are shown on the site.' : 'Totals are hidden from the site (Settings).')
        : 'Not synced yet.';
    }
    $('sync-donations').hidden = !d.stripeConfigured;
  }

  $('sync-donations').onclick = async function () {
    var btn = $('sync-donations');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      await adminApi('admin.syncDonations');
      await load();
    } catch (err) {
      setStatus($('donation-status'), err.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sync donations now';
    }
  };

  // --- Students --------------------------------------------------------------

  function className(s) { return [s.grade, s.teacher].filter(Boolean).join(' · '); }

  function renderStudents() {
    var select = $('student-class');
    var current = select.value;
    var classes = [];
    data.students.forEach(function (s) { if (classes.indexOf(className(s)) < 0) classes.push(className(s)); });
    select.innerHTML = '<option value="">All classes</option>' + classes.map(function (c) {
      return '<option>' + RA.esc(c) + '</option>';
    }).join('');
    select.value = current;
    $('sync-notice').innerHTML = data.unlinked
      ? '<div class="notice" style="margin:1rem 0 0">' + data.unlinked + ' student(s) in the roster don\'t have links yet. Click <strong>Sync roster</strong>.</div>'
      : '';
    filterStudents();
  }

  function visibleStudents() {
    var q = $('student-search').value.trim().toLowerCase();
    var cls = $('student-class').value;
    return data.students.filter(function (s) {
      if (cls && className(s) !== cls) return false;
      if (!q) return true;
      return [s.firstName, s.lastName, s.grade, s.teacher, s.code, s.studentId].concat(s.contacts.map(function (c) { return c.email; }))
        .join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }

  function filterStudents() {
    var rows = visibleStudents();
    var body = $('student-rows');
    body.innerHTML = '';
    rows.forEach(function (s) {
      var tr = document.createElement('tr');
      tr.dataset.studentId = s.studentId;
      tr.innerHTML = '<td>' + RA.esc(s.firstName + ' ' + s.lastName) + '</td><td>' + RA.esc(s.grade) + '</td><td>' + RA.esc(s.teacher) +
        '</td><td class="num">' + RA.fmt(s.minutes) + '</td><td class="num">' + RA.fmt(s.books) + '</td><td class="num">' + RA.money(s.raised) + '</td><td><code>' + RA.esc(s.code || '—') + '</code></td><td></td><td></td>';
      var emailCell = tr.children[7];
      if (s.token) {
        var toggle = document.createElement('button');
        toggle.className = 'btn btn-small';
        toggle.textContent = s.contacts.length ? 'Emails (' + s.contacts.length + ')' : 'Add emails';
        toggle.title = s.contacts.map(function (c) { return c.email; }).join(', ');
        toggle.onclick = function () { toggleContacts(s, tr); };
        emailCell.appendChild(toggle);
      }
      var cell = tr.lastChild;
      if (s.token) {
        cell.innerHTML = '<div class="row">' +
          '<button class="btn btn-small" data-act="copy-log">Copy log link</button>' +
          '<button class="btn btn-small" data-act="copy-donate">Copy donation link</button>' +
          '<a class="btn btn-small btn-ghost" target="_blank" rel="noopener" href="' + RA.esc(studentUrl(s)) + '">Open log</a>' +
          '<button class="btn btn-small btn-danger" data-act="regen" title="Use if the private link was shared by mistake">New log link</button></div>';
        cell.querySelector('[data-act=copy-log]').onclick = function (e) { RA.copyText(studentUrl(s), e.target); };
        cell.querySelector('[data-act=copy-donate]').onclick = function (e) { RA.copyText(donateUrl(s), e.target); };
        cell.querySelector('[data-act=regen]').onclick = function (e) { regenerate(s, e.target); };
      } else {
        cell.innerHTML = '<span class="muted small">Sync roster to create</span>';
      }
      body.appendChild(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="9" class="muted">No students match.</td></tr>';
  }

  // Inline editor row for a student's family emails.
  function toggleContacts(s, tr) {
    var next = tr.nextElementSibling;
    if (next && next.classList.contains('contacts-editor')) return next.remove();
    var row = document.createElement('tr');
    row.className = 'contacts-editor';
    var td = document.createElement('td');
    td.colSpan = 9;
    var html = '<form><p class="small muted" style="margin:0 0 .5rem">Family emails for <strong>' + RA.esc(s.firstName + ' ' + s.lastName) +
      '</strong>. They get the log and donation links by email' + (data.settings.weeklyUpdatesEnabled ? ', and weekly updates if ticked' : '') + '.</p>';
    for (var i = 0; i < data.maxContacts; i++) {
      var c = s.contacts[i] || { email: '', weeklyUpdates: false };
      html += '<div class="row contact-row"><input class="grow" type="email" maxlength="254" placeholder="name@example.com" aria-label="Family email ' + (i + 1) +
        '" value="' + RA.esc(c.email) + '"><label class="toggle"><input type="checkbox"' + (c.weeklyUpdates ? ' checked' : '') +
        '> Weekly updates</label><span class="muted small">' + (c.linksSentAt ? 'links sent ' + RA.esc(c.linksSentAt.slice(0, 10)) : c.email ? 'links not sent yet' : '') + '</span></div>';
    }
    html += '<label class="toggle"><input type="checkbox" name="sendLinks" checked> Email the links to new addresses</label>' +
      '<div class="row"><button class="btn btn-primary btn-small" type="submit">Save emails</button>' +
      (s.contacts.length ? '<button class="btn btn-small" type="button" data-act="resend">Resend links to all</button>' : '') +
      '<span class="status" role="status"></span></div></form>';
    td.innerHTML = html;
    row.appendChild(td);
    tr.after(row);
    var form = td.querySelector('form');
    var status = td.querySelector('.status');
    form.onsubmit = async function (e) {
      e.preventDefault();
      var contacts = Array.prototype.map.call(td.querySelectorAll('.contact-row'), function (r) {
        return { email: r.querySelector('input[type=email]').value.trim(), weeklyUpdates: r.querySelector('input[type=checkbox]').checked };
      });
      try {
        var r = await adminApi('admin.setContacts', { studentId: s.studentId, contacts: contacts, sendLinks: form.elements.sendLinks.checked });
        s.contacts = r.contacts;
        renderQuota(r.quotaLeft);
        filterStudents();
        var newTr = Array.prototype.find.call($('student-rows').children, function (x) { return x.dataset.studentId === s.studentId; });
        if (newTr) {
          toggleContacts(s, newTr);
          setStatus(newTr.nextElementSibling.querySelector('.status'), 'Saved ✓' + sendSummary(r), !r.failed.length && !r.remaining);
        }
      } catch (err) {
        setStatus(status, err.message, false);
      }
    };
    var resend = td.querySelector('[data-act=resend]');
    if (resend) resend.onclick = async function () {
      if (!await confirmSend({ kind: 'links', studentId: s.studentId }, status)) return;
      try {
        var r = await adminApi('admin.emailLinks', { studentId: s.studentId });
        renderQuota(r.quotaLeft);
        setStatus(status, sendSummary(r).trim() || 'Nothing to send.', !r.failed.length && !r.remaining);
      } catch (err) {
        setStatus(status, err.message, false);
      }
    };
  }

  // --- Email quota -----------------------------------------------------------
  // Google limits how many emails the script's account can send per day, so
  // bulk sends show the count and ask first.

  function renderQuota(left) {
    if (left !== undefined && left !== null) data.emailQuotaLeft = left;
    var q = data.emailQuotaLeft;
    document.querySelectorAll('.quota').forEach(function (el) {
      el.hidden = q === null || q === undefined;
      el.textContent = 'Emails left today: ' + RA.fmt(q) + ' (Google\'s daily limit for the account that runs the app).';
    });
  }

  /** Asks the server how many emails a bulk send would use, then asks the organizer. Returns true to go ahead. */
  async function confirmSend(params, statusEl) {
    var p;
    try {
      p = await adminApi('admin.previewEmails', params);
    } catch (err) {
      setStatus(statusEl, err.message, false);
      return false;
    }
    renderQuota(p.quotaLeft);
    if (p.skipped || !p.emails) {
      setStatus(statusEl, p.skipped || 'Nothing to send: everyone has already been emailed.', true);
      return false;
    }
    var msg = 'Send ' + RA.fmt(p.emails) + ' email(s) to the families of ' + RA.fmt(p.students) + ' student(s)?';
    if (p.quotaLeft !== null) {
      msg += '\n\nEmails left today: ' + RA.fmt(p.quotaLeft) + '.';
      if (p.emails > p.quotaLeft) {
        msg += ' Only ' + RA.fmt(p.quotaLeft) + ' can go out today. Run this again tomorrow to send the rest; ' +
          'families who already got theirs are skipped.';
      }
    }
    return window.confirm(msg);
  }

  function sendSummary(r) {
    var parts = [];
    if (r.sent) parts.push(r.sent + ' email(s) sent');
    if (r.failed.length) parts.push('could not send to ' + r.failed.join(', '));
    if (r.remaining) parts.push(r.remaining + ' not sent yet (daily email limit or time limit reached; try again later)');
    return parts.length ? ' ' + parts.join('; ') + '.' : '';
  }

  $('email-links').onclick = async function () {
    var btn = $('email-links');
    var notice = document.createElement('p');
    $('sync-notice').innerHTML = '';
    $('sync-notice').appendChild(notice);
    if (!await confirmSend({ kind: 'links' }, notice)) return;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      var r = await adminApi('admin.emailLinks');
      await load();
      renderQuota(r.quotaLeft);
      $('sync-notice').innerHTML = '<div class="notice" style="margin:1rem 0 0">' +
        RA.esc(r.sent || r.failed.length || r.remaining ? sendSummary(r).trim() : 'Every family email has already been sent its links.') + '</div>';
    } catch (err) {
      $('sync-notice').innerHTML = '<div class="notice error" style="margin:1rem 0 0">' + RA.esc(err.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Email links to families';
    }
  };

  $('student-search').oninput = filterStudents;
  $('student-class').onchange = filterStudents;

  async function regenerate(s, btn) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Old link stops working — confirm?';
      setTimeout(function () { delete btn.dataset.armed; btn.textContent = 'New log link'; }, 4000);
      return;
    }
    try {
      var r = await adminApi('admin.regenerateToken', { studentId: s.studentId });
      s.token = r.token;
      filterStudents();
    } catch (err) {
      btn.textContent = err.message;
    }
  }

  $('sync').onclick = async function () {
    var btn = $('sync');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      var r = await adminApi('admin.syncRoster');
      await load();
      $('sync-notice').innerHTML = '<div class="notice" style="margin:1rem 0 0">Roster synced: ' + r.total + ' students, ' +
        r.created + ' new link(s) created' + (r.orphaned ? ', ' + r.orphaned + ' student(s) no longer in the roster (their data is kept)' : '') + '.</div>';
    } catch (err) {
      $('sync-notice').innerHTML = '<div class="notice error" style="margin:1rem 0 0">' + RA.esc(err.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sync roster';
    }
  };

  $('export').onclick = function () {
    var head = ['Student ID', 'First Name', 'Last Name', 'Grade', 'Teacher', 'Minutes', 'Books', 'Raised', 'Donation Code', 'Private Log Link', 'Donation Link', 'Family Emails'];
    var lines = [head].concat(visibleStudents().map(function (s) {
      return [s.studentId, s.firstName, s.lastName, s.grade, s.teacher, s.minutes, s.books, (s.raised / 100).toFixed(2), s.code,
        s.token ? studentUrl(s) : '', s.code ? donateUrl(s) : '', s.contacts.map(function (c) { return c.email; }).join('; ')];
    }));
    var csv = lines.map(function (r) {
      return r.map(function (v) {
        v = String(v === null || v === undefined ? '' : v);
        if (/^[=+\-@]/.test(v)) v = "'" + v; // keep spreadsheets from treating values as formulas
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'readathon-links.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  $('print').onclick = function () {
    var title = data.settings.readathonTitle;
    $('slips').innerHTML = '<div class="slips">' + visibleStudents().filter(function (s) { return s.token; }).map(function (s) {
      return '<div class="slip"><strong>' + RA.esc(title) + '</strong><div class="slip-name">' + RA.esc(s.firstName + ' ' + s.lastName) +
        '</div><div class="muted small">' + RA.esc(className(s)) + '</div>' +
        '<div class="small"><b>My reading log (keep private):</b><br>' + RA.esc(studentUrl(s)) + '</div>' +
        '<div class="small"><b>My donation page (share this!):</b><br>' + RA.esc(donateUrl(s)) + '</div></div>';
    }).join('') + '</div>';
    window.print();
  };

  // --- Settings --------------------------------------------------------------

  function renderSettings() {
    var form = $('settings-form');
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || !(el.name in data.settings)) return;
      if (el.type === 'checkbox') el.checked = !!data.settings[el.name];
      else el.value = data.settings[el.name];
    });
  }

  $('settings-form').onsubmit = async function (e) {
    e.preventDefault();
    var settings = {};
    Array.prototype.forEach.call(e.target.elements, function (el) {
      if (!el.name) return;
      settings[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    try {
      var r = await adminApi('admin.saveSettings', { settings: settings });
      data.settings = r.settings;
      setStatus($('settings-status'), 'Saved ✓', true);
      await load();
    } catch (err) {
      setStatus($('settings-status'), err.message, false);
    }
  };

  $('send-weekly').onclick = async function () {
    var btn = $('send-weekly');
    if (!await confirmSend({ kind: 'weekly' }, $('weekly-status'))) return;
    btn.disabled = true;
    try {
      var r = await adminApi('admin.sendWeeklyUpdates');
      renderQuota(r.quotaLeft);
      setStatus($('weekly-status'), r.skipped || sendSummary(r).trim() ||
        'Nothing to send: everyone subscribed has already had this week\'s update.', !r.failed.length && !r.remaining);
    } catch (err) {
      setStatus($('weekly-status'), err.message, false);
    } finally {
      btn.disabled = false;
    }
  };
})();
