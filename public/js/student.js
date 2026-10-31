// Student reading log page: /s/<token>
(function () {
  var app = document.getElementById('app');
  var token = RA.routeParam('s', 't');
  var state = null;

  if (!token) return RA.showError(app, 'This page needs your private reading-log link. Ask your teacher for it.');

  RA.api('student.get', { token: token }).then(function (data) {
    state = data;
    render();
  }).catch(function (err) {
    RA.showError(app, err.message);
  });

  function $(sel) { return app.querySelector(sel); }
  function bind(name, value) {
    app.querySelectorAll('[data-bind="' + name + '"]').forEach(function (el) { el.textContent = value; });
  }
  function setStatus(el, text, ok) {
    el.textContent = text;
    el.className = 'status ' + (ok ? 'ok' : 'err');
    if (ok) setTimeout(function () { if (el.textContent === text) el.textContent = ''; }, 2500);
  }

  function render() {
    var s = state.student;
    var settings = state.settings;
    document.title = s.firstName + "'s Reading Log · " + settings.readathonTitle;
    document.getElementById('site-title').textContent = settings.readathonTitle;
    app.innerHTML = '';
    app.appendChild(document.getElementById('page').content.cloneNode(true));

    bind('firstName', s.firstName);
    bind('meta', [RA.gradeLabel(s.grade), s.teacher].filter(Boolean).join(' · '));
    renderBanner();
    renderTotals();
    renderToday();
    renderDays();
    renderBooks();
    renderPrefs();
    renderContacts();
    setupBookForms();
  }

  function renderBanner() {
    var st = state.settings;
    var msg = '';
    if (st.editsLocked) msg = 'The reading log is locked. Thanks for reading!';
    else if (!state.days.length && st.startDate) msg = 'The readathon starts on ' + RA.formatDate(st.startDate, { weekday: 'long', month: 'long', day: 'numeric' }) + '. Get your books ready!';
    else if (st.endDate && state.today > st.endDate) msg = 'The readathon has ended — great job! You can still fix any missing days.';
    $('#banner').innerHTML = msg ? '<div class="notice">' + RA.esc(msg) + '</div>' : '';
  }

  function renderTotals() {
    bind('totalMinutes', RA.fmt(state.totalMinutes));
    bind('daysRead', RA.fmt(state.daysRead));
    bind('classMinutes', RA.fmt(state.classMinutes));
    bind('booksFinished', RA.fmt(state.books.filter(function (b) { return b.status === 'finished'; }).length));
    $('#raised-stat').hidden = !state.donationTotalsEnabled;
    if (state.donationTotalsEnabled) bind('raised', RA.money(state.raised));
    var goal = state.prefs.goalMinutes;
    $('#goal-card').hidden = !goal;
    if (goal) {
      var pct = RA.percent(state.totalMinutes, goal);
      bind('goal', RA.fmt(goal));
      bind('goalPct', pct + '%' + (pct >= 100 ? ' 🎉' : ''));
      $('[data-bind="goalBar"]').style.width = pct + '%';
    }
  }

  function dayEntry(date) {
    for (var i = 0; i < state.days.length; i++) if (state.days[i].date === date) return state.days[i];
    return null;
  }

  function renderToday() {
    var today = dayEntry(state.today);
    var form = $('#today-form');
    var input = $('#today-minutes');
    var canEdit = today && !state.settings.editsLocked;
    bind('todayLabel', RA.formatDate(state.today, { weekday: 'long', month: 'long', day: 'numeric' }));
    form.hidden = !canEdit;
    $('#quick-add').hidden = !canEdit;
    if (!canEdit) {
      $('#today-status').className = 'status';
      $('#today-status').textContent = today ? 'Logging is closed.' : 'Today is not a readathon day.';
      return;
    }
    input.max = state.settings.maxMinutesPerDay;
    input.value = today.minutes || '';
    input.placeholder = '0';
    form.onsubmit = function (e) {
      e.preventDefault();
      saveMinutes(state.today, input.value, $('#today-status'));
    };
    app.querySelectorAll('#quick-add [data-add]').forEach(function (b) {
      b.onclick = function () {
        input.value = (Number(input.value) || 0) + Number(b.dataset.add);
        saveMinutes(state.today, input.value, $('#today-status'));
      };
    });
  }

  function renderDays() {
    var list = $('#days');
    list.innerHTML = '';
    var locked = state.settings.editsLocked;
    if (!state.days.length) {
      list.innerHTML = '<li class="muted">Nothing to log yet.</li>';
      return;
    }
    state.days.slice().reverse().forEach(function (d) {
      var li = document.createElement('li');
      var isToday = d.date === state.today;
      li.innerHTML = '<span class="date">' + RA.esc(RA.formatDate(d.date)) + (isToday ? ' <small>(today)</small>' : '') + '</span>' +
        '<input type="number" min="0" step="1" inputmode="numeric" aria-label="Minutes read on ' + RA.esc(RA.formatDate(d.date)) + '">' +
        '<span class="muted small">min</span><span class="status" role="status"></span>';
      var input = li.querySelector('input');
      input.value = d.minutes || '';
      input.placeholder = '0';
      input.max = state.settings.maxMinutesPerDay;
      input.disabled = locked;
      input.dataset.date = d.date;
      input.addEventListener('change', function () { saveMinutes(d.date, input.value, li.querySelector('.status')); });
      list.appendChild(li);
    });
  }

  async function saveMinutes(date, value, statusEl) {
    var minutes = value === '' ? 0 : Number(value);
    if (!Number.isInteger(minutes) || minutes < 0) return setStatus(statusEl, 'Whole numbers only', false);
    if (minutes > state.settings.maxMinutesPerDay) return setStatus(statusEl, 'Max ' + state.settings.maxMinutesPerDay + ' per day', false);
    statusEl.className = 'status';
    statusEl.textContent = 'Saving…';
    try {
      var r = await RA.api('student.setMinutes', { token: token, date: date, minutes: minutes });
      dayEntry(date).minutes = r.minutes;
      state.totalMinutes = r.totalMinutes;
      state.daysRead = r.daysRead;
      state.classMinutes = r.classMinutes;
      renderTotals();
      // Keep the "today" box and the log list in sync with each other.
      var dayInput = app.querySelector('#days input[data-date="' + date + '"]');
      if (dayInput && document.activeElement !== dayInput) dayInput.value = r.minutes || '';
      if (date === state.today) $('#today-minutes').value = r.minutes || '';
      setStatus(statusEl, 'Saved ✓', true);
    } catch (err) {
      setStatus(statusEl, err.message, false);
    }
  }

  function renderBooks() {
    var current = state.books.filter(function (b) { return b.status === 'reading'; })[0];
    var box = $('#current-book');
    box.innerHTML = '';
    if (current) {
      var div = document.createElement('div');
      div.className = 'book book-current';
      div.appendChild(RA.coverEl(current, 'M'));
      var info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="title">' + RA.esc(current.title) + '</div>' +
        '<div class="author">' + RA.esc(current.author) + '</div>' +
        '<div class="row" style="margin-top:.6rem">' +
        '<button class="btn btn-small btn-gold" type="button" data-act="finish">I finished it! 🎉</button>' +
        '<button class="btn btn-small btn-ghost" type="button" data-act="change">Switch book</button></div>';
      div.appendChild(info);
      box.appendChild(div);
      info.querySelector('[data-act=finish]').onclick = function () { updateBook(current.bookId, 'finished', $('#current-status')); };
      info.querySelector('[data-act=change]').onclick = function () { showCurrentForm(true); };
    } else {
      box.innerHTML = '<p class="muted">What are you reading right now?</p>' +
        '<button class="btn btn-primary" type="button" id="current-add">Add my book</button>';
      $('#current-add').onclick = function () { showCurrentForm(true); };
    }

    var finished = state.books.filter(function (b) { return b.status === 'finished'; });
    var list = $('#finished-books');
    list.innerHTML = '';
    if (!finished.length) list.innerHTML = '<li class="muted">No finished books yet — you can do it!</li>';
    finished.slice().reverse().forEach(function (b) {
      var li = document.createElement('li');
      li.className = 'book';
      li.appendChild(RA.coverEl(b, 'S'));
      var info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="title">' + RA.esc(b.title) + '</div><div class="author">' + RA.esc(b.author) + '</div>';
      li.appendChild(info);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-small btn-danger';
      del.textContent = 'Remove';
      del.setAttribute('aria-label', 'Remove ' + b.title);
      del.onclick = function () { confirmRemove(del, b); };
      li.appendChild(del);
      list.appendChild(li);
    });
    bind('booksFinished', RA.fmt(finished.length));
  }

  // Two-step remove (the page avoids confirm() dialogs).
  function confirmRemove(btn, book) {
    if (btn.dataset.armed) return deleteBook(book.bookId, $('#finished-status'));
    btn.dataset.armed = '1';
    btn.textContent = 'Really remove?';
    setTimeout(function () { delete btn.dataset.armed; btn.textContent = 'Remove'; }, 3000);
  }

  function showCurrentForm(show) {
    $('#current-form').hidden = !show;
    $('#current-book').hidden = show;
    if (show) $('#current-title').focus();
  }

  var currentSearch = null;
  var finishedSearch = null;

  function setupBookForms() {
    currentSearch = BookSearch.attach($('#current-title'), $('#current-author'), $('#current-suggest'));
    finishedSearch = BookSearch.attach($('#finished-title'), $('#finished-author'), $('#finished-suggest'));
    $('#current-cancel').onclick = function () { currentSearch.reset(); showCurrentForm(false); };
    $('#current-form').onsubmit = function (e) {
      e.preventDefault();
      addBook(Object.assign(currentSearch.value(), { status: 'reading' }), $('#current-status'), function () {
        currentSearch.reset();
        showCurrentForm(false);
      });
    };
    $('#finished-form').onsubmit = function (e) {
      e.preventDefault();
      addBook(Object.assign(finishedSearch.value(), { status: 'finished' }), $('#finished-status'), function () {
        finishedSearch.reset();
      });
    };
  }

  async function addBook(book, statusEl, done) {
    if (!book.title) return setStatus(statusEl, 'Please type the book title.', false);
    try {
      var r = await RA.api('student.addBook', Object.assign({ token: token }, book));
      state.books = r.books;
      renderBooks();
      done();
      setStatus(statusEl, 'Saved ✓', true);
    } catch (err) {
      setStatus(statusEl, err.message, false);
    }
  }

  async function updateBook(bookId, status, statusEl) {
    try {
      var r = await RA.api('student.updateBook', { token: token, bookId: bookId, status: status });
      state.books = r.books;
      renderBooks();
      setStatus(statusEl, status === 'finished' ? 'Nice work! Added to your books.' : 'Saved ✓', true);
    } catch (err) {
      setStatus(statusEl, err.message, false);
    }
  }

  async function deleteBook(bookId, statusEl) {
    try {
      var r = await RA.api('student.deleteBook', { token: token, bookId: bookId });
      state.books = r.books;
      renderBooks();
      setStatus(statusEl, 'Removed', true);
    } catch (err) {
      setStatus(statusEl, err.message, false);
    }
  }

  function renderPrefs() {
    var url = location.origin + '/d/' + state.student.code;
    $('#donation-link').textContent = url;
    $('#open-donation').href = url;
    $('#copy-donation').onclick = function () { RA.copyText(url, $('#copy-donation')); };

    var form = $('#prefs-form');
    $('#show-raised').hidden = !state.donationTotalsEnabled;
    ['showReadingList', 'showTotalMinutes', 'showClassMinutes', 'showRaised'].forEach(function (k) {
      form.elements[k].checked = !!state.prefs[k];
      form.elements[k].onchange = function () {
        var p = {};
        p[k] = form.elements[k].checked;
        savePrefs(p);
      };
    });
    form.elements.goalMinutes.value = state.prefs.goalMinutes || '';
    form.elements.goalMinutes.onchange = function () {
      savePrefs({ goalMinutes: form.elements.goalMinutes.value || 0 });
    };
    form.onsubmit = function (e) { e.preventDefault(); };
  }

  function renderContacts() {
    var rows = $('#contact-rows');
    rows.innerHTML = '';
    for (var i = 0; i < state.maxContacts; i++) {
      var c = state.contacts[i] || { email: '', weeklyUpdates: false };
      var row = document.createElement('div');
      row.className = 'row contact-row';
      row.innerHTML = '<input class="grow" type="email" autocomplete="email" maxlength="254" placeholder="name@example.com">' +
        '<label class="toggle"><input type="checkbox"> Weekly updates</label>';
      var email = row.querySelector('input[type=email]');
      var weekly = row.querySelector('input[type=checkbox]');
      email.value = c.email;
      email.setAttribute('aria-label', 'Family email ' + (i + 1));
      weekly.checked = c.weeklyUpdates;
      weekly.setAttribute('aria-label', 'Weekly updates for family email ' + (i + 1));
      weekly.parentNode.hidden = !state.weeklyUpdatesEnabled;
      rows.appendChild(row);
    }
    $('#contacts-form').onsubmit = function (e) {
      e.preventDefault();
      saveContacts();
    };
  }

  async function saveContacts() {
    var statusEl = $('#contacts-status');
    var contacts = Array.prototype.map.call(app.querySelectorAll('.contact-row'), function (row) {
      return { email: row.querySelector('input[type=email]').value.trim(), weeklyUpdates: row.querySelector('input[type=checkbox]').checked };
    });
    try {
      var r = await RA.api('student.setContacts', { token: token, contacts: contacts });
      state.contacts = r.contacts;
      renderContacts();
      var msg = 'Saved ✓';
      if (r.sent) msg += ' We emailed the links to ' + r.sent + ' new address' + (r.sent === 1 ? '' : 'es') + '.';
      if (r.failed.length || r.remaining) msg += ' Some emails couldn\'t be sent right now; ask your teacher to resend them.';
      setStatus(statusEl, msg, !(r.failed.length || r.remaining));
    } catch (err) {
      setStatus(statusEl, err.message, false);
    }
  }

  async function savePrefs(changes) {
    var statusEl = $('#prefs-status');
    try {
      var r = await RA.api('student.setPrefs', Object.assign({ token: token }, changes));
      state.prefs = r.prefs;
      renderTotals();
      setStatus(statusEl, 'Saved ✓', true);
    } catch (err) {
      setStatus(statusEl, err.message, false);
      renderPrefs();
    }
  }
})();
