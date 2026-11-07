// Public donation page: /d/<code>
(function () {
  var app = document.getElementById('app');
  var code = RA.routeParam('d', 'c');
  var config = window.READATHON_CONFIG || {};
  var query = new URLSearchParams(location.search);
  // ?checkout=embedded shows Stripe's payment form on this page instead of linking out,
  // once the Cloudflare Worker, Stripe publishable key and Turnstile site key are configured.
  var embedded = query.get('checkout') === 'embedded' &&
    !!(config.checkoutApiUrl && config.stripePublishableKey && config.turnstileSiteKey);

  if (!code) return RA.showError(app, 'This link is missing the reader code.');

  RA.donationData(code).then(render).catch(function (err) {
    RA.showError(app, err.message);
  });

  function $(sel) { return app.querySelector(sel); }
  function bind(name, value) {
    app.querySelectorAll('[data-bind="' + name + '"]').forEach(function (el) { el.textContent = value; });
  }

  function render(data) {
    var s = data.student;
    var settings = data.settings;
    document.title = 'Support ' + s.name + ' · ' + settings.readathonTitle;
    document.getElementById('site-title').textContent = settings.readathonTitle;
    app.innerHTML = '';
    app.appendChild(document.getElementById('page').content.cloneNode(true));

    bind('name', s.name);
    bind('firstName', s.firstName);
    bind('meta', [RA.gradeLabel(s.grade), s.teacher, settings.schoolName].filter(Boolean).join(' · '));
    bind('intro', s.firstName + ' is reading as much as possible during the ' + settings.readathonTitle +
      '. Your gift helps our school — and cheers ' + s.firstName + ' on!');

    renderStats(data);
    if (data.donateUrl) {
      bind('donateText', 'Every gift supports the ' + settings.schoolName + ' PTO. Thank you for cheering on ' + s.firstName + '!');
      $('#donate-link').href = data.donateUrl;
      $('#donate-link').textContent = 'Donate in honor of ' + s.firstName;
      $('#donate-card').hidden = false;
      if (embedded) setupEmbedded(s, data.donateUrl);
    }
    if (data.books) renderBooks(data.books);
  }

  // ---- Embedded Stripe Checkout (?checkout=embedded) ----

  var STRIPE_JS = 'https://js.stripe.com/endive/stripe.js';
  var TURNSTILE_JS = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

  function setupEmbedded(s, fallbackUrl) {
    var workerUrl = String(config.checkoutApiUrl).replace(/\/+$/, '');
    var studentCode = String(s.code || code).toUpperCase();
    var shell = $('#checkout-shell');
    var widgetId = null;
    var mounting = false;

    document.body.classList.add('has-embedded-checkout');
    $('#layout').classList.add('is-embedded');
    $('#donate-card h2').textContent = 'Donate in honor of ' + s.firstName;
    $('#donate-link').hidden = true;
    $('#embedded-donate').hidden = false;
    $('#checkout-fallback-link').href = fallbackUrl;
    var shareUrl = location.origin + '/d/' + encodeURIComponent(studentCode);
    bind('shareUrl', shareUrl);
    $('#share-copy').addEventListener('click', function (e) { RA.copyText(shareUrl, e.currentTarget); });

    var stripeReady = loadScript(STRIPE_JS);
    var sessionId = query.get('session_id');
    var check = sessionId ? checkReturn(sessionId) : Promise.resolve(false);
    check.then(function (done) {
      if (done) return;
      return loadScript(TURNSTILE_JS).then(function () {
        widgetId = window.turnstile.render($('#turnstile'), {
          sitekey: config.turnstileSiteKey,
          action: 'donate',
          appearance: 'interaction-only', // most visitors never see a challenge
          callback: mount,
          'error-callback': function () {
            fail(new Error('We could not confirm you are a person. Please try again.'));
            return true;
          },
        });
      });
    }).catch(fail);

    /** Back from a bank or wallet page: thank the donor, or show the form again if the payment didn't finish. */
    function checkReturn(id) {
      query.delete('session_id');
      history.replaceState(null, '', location.pathname + '?' + query.toString());
      return fetchStatus(id)
        .then(function (st) {
          if (st.status !== 'complete') {
            message('Your payment didn\'t go through. You can try again below.');
            return false;
          }
          showThanks(st.paymentStatus);
          return true;
        })
        .catch(function () { return false; }); // can't tell; offer the form again
    }

    function fetchStatus(id) {
      return fetch(workerUrl + '/session-status?session_id=' + encodeURIComponent(id)).then(readJson);
    }

    function mount(token) {
      if (mounting) return;
      mounting = true;
      shell.classList.remove('is-failed');
      $('#checkout-retry').hidden = true;
      var completedId = '';
      var checkout = null;
      var failed = false;
      function onError(err) {
        if (failed) return;
        failed = true;
        if (checkout) checkout.destroy();
        mounting = false;
        fail(err);
      }
      stripeReady.then(function () {
        // Resolves right away; Stripe shows its own placeholder until fetchClientSecret answers.
        return window.Stripe(config.stripePublishableKey).createEmbeddedCheckoutPage({
          fetchClientSecret: function () {
            return fetch(workerUrl + '/checkout-session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: studentCode, turnstileToken: token }),
            }).then(readJson).then(function (out) {
              completedId = String(out.clientSecret).split('_secret_')[0]; // the Checkout Session ID
              window.turnstile.remove(widgetId);
              widgetId = null;
              return out.clientSecret;
            }).catch(function (err) {
              setTimeout(function () { onError(err); }, 0); // after Stripe has the rejection
              throw err;
            });
          },
          // Card payments finish here without leaving the page (redirect_on_completion: if_required).
          onComplete: function () {
            if (checkout) checkout.destroy();
            fetchStatus(completedId)
              .then(function (st) { showThanks(st.paymentStatus); })
              .catch(function () { showThanks('paid'); }); // Stripe just told us it completed
          },
        });
      }).then(function (instance) {
        if (failed) return instance.destroy();
        checkout = instance;
        if ($('#checkout-msg').classList.contains('error')) message(''); // an earlier attempt's error
        checkout.mount('#checkout');
        return whenFrameLoads($('#checkout')).then(function () {
          if (failed) return;
          shell.classList.add('is-ready');
          shell.setAttribute('aria-busy', 'false');
          setTimeout(function () { shell.classList.add('is-gone'); }, 300); // after the fade
        });
      }).catch(onError);
    }

    // Turnstile tokens are single-use: a retry asks for a new one, and its callback mounts again.
    // Not automatic, so a lasting problem doesn't retry forever.
    $('#checkout-retry').addEventListener('click', function () {
      $('#checkout-retry').hidden = true;
      message('');
      shell.classList.remove('is-failed', 'is-ready', 'is-gone');
      shell.setAttribute('aria-busy', 'true');
      if (widgetId !== null) window.turnstile.reset(widgetId);
      else location.reload();
    });

    function showThanks(paymentStatus) {
      $('#donate-card h2').textContent = 'Thank you!';
      $('#donate-card [data-bind="donateText"]').hidden = true;
      $('#embedded-donate').hidden = true;
      bind('thanksText', paymentStatus === 'paid'
        ? 'Your gift in honor of ' + s.firstName + ' was received. Thank you for cheering on ' + s.firstName + '!'
        : 'Your gift in honor of ' + s.firstName + ' is processing. It will count once your bank payment clears.');
      $('#donate-thanks').hidden = false;
      var card = $('#donate-card');
      if (card.getBoundingClientRect().top < 0) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function fail(err) {
      message((err && err.message) || 'Something went wrong. Please try again.', true);
      shell.classList.add('is-failed');
      $('#checkout-fallback').hidden = false;
      $('#checkout-retry').hidden = false;
    }
  }

  /**
   * Stripe.js has no "ready" event for embedded Checkout, so wait for its iframe to load,
   * plus a moment to paint. Gives up waiting after 8 seconds and shows whatever is there.
   */
  function whenFrameLoads(container) {
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (!done) { done = true; setTimeout(resolve, 200); } }
      setTimeout(finish, 8000);
      (function look() {
        if (done) return;
        var frame = container.querySelector('iframe');
        if (frame) frame.addEventListener('load', finish, { once: true });
        else setTimeout(look, 100);
      })();
    });
  }

  function message(text, isError) {
    var el = $('#checkout-msg');
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('error', !!isError);
  }

  function readJson(res) {
    return res.json().catch(function () { return {}; }).then(function (out) {
      if (!res.ok) throw new Error(out.error || 'Could not reach the payment server. Please try again.');
      return out;
    });
  }

  var scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise(function (resolve, reject) {
        var el = document.createElement('script');
        el.src = src;
        el.async = true;
        el.onload = resolve;
        el.onerror = function () { delete scripts[src]; reject(new Error('Could not load the payment form. Please check your connection.')); };
        document.head.appendChild(el);
      });
    }
    return scripts[src];
  }

  function renderStats(data) {
    var tiles = [];
    if (data.raised !== undefined) tiles.push([RA.money(data.raised), 'raised for ' + data.student.firstName + "'s readathon"]);
    if (data.totalMinutes !== undefined) {
      tiles.push([RA.fmt(data.totalMinutes), 'minutes read']);
      tiles.push([RA.fmt(data.daysRead), 'days of reading']);
    }
    if (data.books) tiles.push([RA.fmt(data.books.filter(function (b) { return b.status === 'finished'; }).length), 'books finished']);
    if (data.classMinutes !== undefined) tiles.push([RA.fmt(data.classMinutes), 'minutes read by ' + (data.student.teacher ? data.student.teacher + "'s class" : 'the class')]);
    var stats = $('#stats');
    stats.hidden = !tiles.length;
    stats.innerHTML = tiles.map(function (t) {
      return '<div class="stat"><div class="value">' + RA.esc(t[0]) + '</div><div class="label">' + RA.esc(t[1]) + '</div></div>';
    }).join('');

    if (data.goalMinutes) {
      var pct = RA.percent(data.totalMinutes, data.goalMinutes);
      $('#goal-card').hidden = false;
      bind('goalText', data.student.firstName + "'s goal: " + RA.fmt(data.goalMinutes) + ' minutes');
      bind('goalPct', pct + '%');
      $('[data-bind="goalBar"]').style.width = pct + '%';
    }
  }

  function renderBooks(books) {
    var current = books.filter(function (b) { return b.status === 'reading'; })[0];
    var finished = books.filter(function (b) { return b.status === 'finished'; }).reverse();
    $('#reading').hidden = !current && !finished.length;
    if (current) {
      $('#current-card').hidden = false;
      var div = document.createElement('div');
      div.className = 'book book-current';
      div.appendChild(RA.coverEl(current, 'M'));
      var info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="title">' + RA.esc(current.title) + '</div><div class="author">' + RA.esc(current.author) + '</div>';
      div.appendChild(info);
      $('#current-book').appendChild(div);
    }
    if (finished.length) {
      $('#shelf-card').hidden = false;
      var shelf = $('#shelf');
      finished.forEach(function (b) {
        var li = document.createElement('li');
        li.appendChild(RA.coverEl(b, 'M'));
        var t = document.createElement('div');
        t.className = 'title';
        t.textContent = b.title;
        li.appendChild(t);
        if (b.author) {
          var a = document.createElement('div');
          a.className = 'muted';
          a.textContent = b.author;
          li.appendChild(a);
        }
        shelf.appendChild(li);
      });
    }
  }
})();
