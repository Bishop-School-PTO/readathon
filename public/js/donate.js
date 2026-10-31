// Public donation page: /d/<code>
(function () {
  var app = document.getElementById('app');
  var code = RA.routeParam('d', 'c');

  if (!code) return RA.showError(app, 'This link is missing the reader code.');

  RA.api('donation.get', { code: code }).then(render).catch(function (err) {
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
    }
    if (data.books) renderBooks(data.books);
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
