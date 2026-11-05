// Shared helpers for every page.
(function () {
  var config = window.READATHON_CONFIG || {};
  var API_URL = config.apiUrl || '/api';

  /**
   * Calls the Apps Script API. text/plain keeps this a "simple" CORS request
   * (no preflight), which Apps Script web apps require.
   */
  async function api(action, params) {
    var res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action }, params || {})),
      redirect: 'follow',
    });
    var json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error('Could not reach the readathon server. Please try again.');
    }
    if (!json.ok) {
      var err = new Error(json.error || 'Something went wrong.');
      err.status = json.status;
      throw err;
    }
    return json.data;
  }

  /** Reads an id from /prefix/<id>, #<id>, or ?key=<id>. */
  function routeParam(prefix, queryKey) {
    var m = location.pathname.match(new RegExp('^/' + prefix + '/([^/]+)/?$'));
    if (m) return decodeURIComponent(m[1]);
    var q = new URLSearchParams(location.search).get(queryKey);
    if (q) return q;
    return location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  /** Cents to "$1,234" (or "$12.50" when there are cents). */
  function money(cents) {
    var n = Number(cents || 0) / 100;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }

  function prettyMinutes(n) {
    n = Number(n || 0);
    if (n < 120) return fmt(n) + ' min';
    var h = Math.floor(n / 60);
    var m = n % 60;
    return fmt(h) + ' hr' + (m ? ' ' + m + ' min' : '');
  }

  function parseDate(d) {
    var p = d.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function formatDate(d, opts) {
    return parseDate(d).toLocaleDateString('en-US', opts || { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function gradeLabel(g) {
    if (!g) return '';
    var s = String(g);
    if (/^(k|tk|pk|pre-?k)$/i.test(s)) return s.toUpperCase() === 'K' ? 'Kindergarten' : s.toUpperCase();
    if (/^\d+$/.test(s)) {
      var n = Number(s);
      var suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
      return n + suffix + ' grade';
    }
    return /grade/i.test(s) ? s : 'Grade ' + s;
  }

  function percent(part, whole) {
    if (!whole) return 0;
    return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
  }

  /** Book cover from Open Library: stored cover id first, then ISBN, then a title/author search. */
  var coverCache = {};
  async function findCoverUrl(book, size) {
    size = size || 'M';
    if (book.coverId) return 'https://covers.openlibrary.org/b/id/' + book.coverId + '-' + size + '.jpg';
    var key = (book.isbn || '') + '|' + book.title + '|' + (book.author || '');
    if (!(key in coverCache)) {
      coverCache[key] = (async function () {
        if (book.isbn) return 'https://covers.openlibrary.org/b/isbn/' + book.isbn + '-' + size + '.jpg?default=false';
        var q = new URLSearchParams({ title: book.title, limit: '1', fields: 'cover_i' });
        if (book.author) q.set('author', book.author);
        var res = await fetch('https://openlibrary.org/search.json?' + q);
        var json = await res.json();
        var doc = json.docs && json.docs[0];
        return doc && doc.cover_i ? 'https://covers.openlibrary.org/b/id/' + doc.cover_i + '-' + size + '.jpg' : null;
      })().catch(function () { return null; });
    }
    return coverCache[key];
  }

  /** Renders a cover placeholder now and swaps in the real image once found. */
  function coverEl(book, size, className) {
    var ph = document.createElement('div');
    ph.className = className || 'cover';
    ph.textContent = (book.title || '?').trim().charAt(0).toUpperCase();
    ph.setAttribute('aria-hidden', 'true');
    findCoverUrl(book, size).then(function (url) {
      if (!url) return;
      var img = new Image();
      img.className = ph.className;
      img.alt = 'Cover of ' + book.title;
      img.referrerPolicy = 'no-referrer';
      img.onload = function () { if (img.naturalWidth > 1) ph.replaceWith(img); };
      img.src = url;
    });
    return ph;
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (button) {
      var old = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(function () { button.textContent = old; }, 1500);
    }
  }

  /** The Cloudflare Worker's base URL (config.checkoutApiUrl), or '' when there isn't one. */
  function workerUrl() {
    return String(config.checkoutApiUrl || '').replace(/\/+$/, '');
  }

  /**
   * Donation-page data. Read through the Worker's cache when there is one (fast), and from
   * Apps Script when there isn't or the Worker answers anything else, even a 404: an older
   * Worker without /donation answers 404 too, and Apps Script gives the real error message.
   */
  async function donationData(code) {
    var base = workerUrl();
    if (base) {
      try {
        var res = await fetch(base + '/donation?c=' + encodeURIComponent(code));
        if (res.ok) return await res.json();
      } catch (e) { /* fall back below */ }
    }
    return api('donation.get', { code: code });
  }

  /** After a student saves something: refreshes their donation page in the Worker's cache. */
  function refreshDonationPage(code) {
    var base = workerUrl();
    if (!base || !code) return;
    fetch(base + '/donation/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // no CORS preflight
      body: JSON.stringify({ code: code }),
      keepalive: true, // still sent if the student closes the page right away
    }).catch(function () { /* the cache refreshes itself within a minute anyway */ });
  }

  function showError(container, message) {
    container.innerHTML = '<div class="notice error" role="alert">' + esc(message) + '</div>';
  }

  window.RA = {
    api: api, routeParam: routeParam, esc: esc, fmt: fmt, money: money, prettyMinutes: prettyMinutes,
    formatDate: formatDate, gradeLabel: gradeLabel, percent: percent, findCoverUrl: findCoverUrl,
    coverEl: coverEl, copyText: copyText, showError: showError,
    donationData: donationData, refreshDonationPage: refreshDonationPage,
  };
})();
