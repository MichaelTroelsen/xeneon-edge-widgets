/* Task Queue — how much whattask work is left across every repo on this
 * machine, what is holding a lock right now, and what has been finished.
 *
 * The shell (property readers, clock, theme, tap-to-cycle, the pager, the
 * heatmap builder) is the Claude Code Usage widget's, so the two read as a
 * pair on the dashboard. The pager in particular is not optional: the iCUE
 * webview forwards taps but NOT touch drags, so a list that does not page
 * itself has rows nobody can reach by any means.
 *
 * Everything it draws comes from http://127.0.0.1:41777/tasks. A widget is a
 * sandboxed page and cannot read files, which is why the feed exists.
 */
(function () {
  'use strict';

  var WIDGET_VERSION = '1.3.3';
  var DEFAULT_FEED = 'http://127.0.0.1:41777/tasks';
  var REQUEST_TIMEOUT_MS = 6000;
  var MAX_ROWS = 40;          /* lists page themselves, so render everything the feed sends */
  var TAP_SLOP_PX = 12;       /* movement beyond this is a scroll, not a tap */
  var TAP_MAX_MS = 700;
  var PAGE_MS = 5000;         /* dwell on each page of an overflowing region */
  var HIGH_WATER = 80;        /* percent at which a bar turns amber */
  var CRITICAL_WATER = 95;    /* and red */

  var els = {};
  var timer = null;
  var data = null;
  var lastError = '';
  var VIEWS = ['queue', 'live', 'history', 'files', 'projects'];
  var view = 'queue';   /* tapping the widget cycles through VIEWS */

  var TITLES = { queue: 'Task queue', live: 'Running now', history: 'Runs',
                 files: 'Task files', projects: 'Projects' };
  function getIcueProperty(name) {
    if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, name)) {
      var value = window[name];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    try {
      var sandboxed = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
      if (sandboxed !== undefined && sandboxed !== null && sandboxed !== '') return sandboxed;
    } catch (e) { /* not injected in this context */ }
    return undefined;
  }

  function clampRange(v, min, max, d) {
    v = Number(v);
    if (!Number.isFinite(v)) return d;
    return Math.max(min, Math.min(max, v));
  }

  function readFeedUrl() {
    var raw = getIcueProperty('feedUrl');
    return (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_FEED;
  }

  function readTheme() {
    return getIcueProperty('colorTheme') === 'light' ? 'light' : 'dark';
  }

  function readRefreshSeconds() {
    return clampRange(getIcueProperty('refreshSeconds'), 5, 120, 10);
  }

  /* 'auto' means the runtime's own locale rather than a hard default, so the
     corner clock matches the machine the dashboard is plugged into. */
  function readTimeFormat() {
    var pref = String(getIcueProperty('timeFormat') || 'auto');
    if (pref === '12' || pref === '24') return pref;
    return systemPrefers12Hour() ? '12' : '24';
  }

  /* resolvedOptions().hour12 is the direct answer but is not reported by every
     engine, so fall back to formatting an afternoon and looking for a meridiem
     in it. Neither working means 24-hour. */
  function systemPrefers12Hour() {
    try {
      var opts = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
      if (typeof opts.hour12 === 'boolean') return opts.hour12;
    } catch (e) { /* no Intl in this context */ }
    try {
      return /[ap]\.?m/i.test(new Date(2000, 0, 1, 13, 0).toLocaleTimeString());
    } catch (e) { /* no locale data either */ }
    return false;
  }

  function timeString(now, format) {
    var h = now.getHours();
    var m = now.getMinutes();
    var mm = (m < 10 ? '0' : '') + m;
    if (format === '12') {
      var h12 = h % 12;
      return (h12 === 0 ? 12 : h12) + ':' + mm + ' ' + (h < 12 ? 'AM' : 'PM');
    }
    return (h < 10 ? '0' : '') + h + ':' + mm;
  }

  /* ---------- formatting ---------- */

  function formatCountdown(target) {
    if (!target) return '';
    var ms = target - Date.now();
    if (ms <= 0) return 'Resetting now';
    var mins = Math.floor(ms / 60000);
    var hrs = Math.floor(mins / 60);
    mins -= hrs * 60;
    if (hrs > 0) return 'Resets in ' + hrs + ' hr ' + mins + ' min';
    return 'Resets in ' + mins + ' min';
  }

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function formatWeekday(target) {
    if (!target) return '';
    var d = new Date(target);
    var h = d.getHours();
    var suffix = h >= 12 ? 'PM' : 'AM';
    var hour12 = h % 12;
    if (hour12 === 0) hour12 = 12;
    var mins = d.getMinutes();
    var minPart = mins ? ':' + (mins < 10 ? '0' + mins : mins) : ':00';
    return 'Resets ' + DAYS[d.getDay()] + ' ' + hour12 + minPart + ' ' + suffix;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Built from parts rather than toLocaleString: the widget runs in an embedded
     webview whose locale is not the one the user picked in iCUE. */
  function formatStamp(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var h = d.getHours();
    var suffix = h >= 12 ? 'PM' : 'AM';
    var hour12 = h % 12;
    if (hour12 === 0) hour12 = 12;
    var mins = d.getMinutes();
    return 'Updated ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' +
      hour12 + ':' + (mins < 10 ? '0' + mins : mins) + ' ' + suffix;
  }

  function num(n) {
    return (n == null) ? '—' : Math.round(n).toLocaleString('en-US');
  }

  function compact(n) {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  /* ---------- rendering ---------- */

  /* One place decides bar width and colour, so the session and week bars cannot
     drift apart on their thresholds. */
  function setBar(meterEl, fillEl, percent) {
    var p = clampRange(percent, 0, 100, 0);
    fillEl.style.width = p + '%';
    meterEl.classList.toggle('is-high', p >= HIGH_WATER && p < CRITICAL_WATER);
    meterEl.classList.toggle('is-critical', p >= CRITICAL_WATER);
  }
  function cell(tag, text, cls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  }

  /* ---------- all-time stats ---------- */
  /* The heading carries the count, so an empty column reads as the real state
     rather than as a feed that failed. The suffix differs per column because
     a held lock and an open session are different things: "2 held" and
     "3 active" must not be mistakable for two halves of one number. */
  function setHeading(ul, total, suffix, base) {
    var h = ul.parentNode && ul.parentNode.querySelector('h2');
    if (!h) return;
    /* The base is cached because most headings are fixed words in the markup
       and re-reading them after the first render would compound the count into
       itself. A caller whose heading CHANGES - the projects view, whose
       heading is the selected project's name - passes the new base explicitly;
       without that the cache pinned the first project's name to every other
       project's count. */
    if (base != null) h.setAttribute('data-base', base);
    else if (!h.getAttribute('data-base')) h.setAttribute('data-base', h.textContent);
    var word = suffix || 'active';
    h.textContent = h.getAttribute('data-base') + ' · ' +
      (total ? total + ' ' + word : 'none ' + word);
  }

  /* The note's own box fills the view so its text can be centred in it, which
     means the BOX overlaps the clock even when the text does not. The text goes
     in a child, so what is padded away from the clock and what is measured
     against it are the same thing. */
  function setNote(el, text) {
    el.textContent = '';
    var span = document.createElement('span');
    span.className = 'note-text';
    span.textContent = text;
    el.appendChild(span);
    el.style.display = 'flex';
  }

  /* ---------- the queue view ---------- */

  function renderQueue() {
    var t = data.totals || {};
    if (data.unavailable) {
      /* Say why there is nothing rather than drawing a meter at zero, which
         would read as a queue that is empty rather than as no queue at all. */
      setNote(els.queueNote, data.unavailable);
      els.meters.style.display = 'none';
      els.listRepos.style.display = 'none';
      return;
    }
    els.queueNote.style.display = 'none';
    els.meters.style.display = '';
    els.listRepos.style.display = '';

    var total = (t.open || 0) + (t.closed || 0);
    var percent = total ? Math.round((t.closed / total) * 100) : 0;
    els.doneValue.textContent = percent + '%';
    setBar(els.mDone, els.doneFill, percent);
    els.doneSub.textContent = num(t.closed || 0) + ' closed · ' + num(t.open || 0) + ' open';

    /* requires-user is called out on its own: it is the one count on this
       view that asks something of whoever is reading the glass. */
    var waiting = (t.byMode && t.byMode['requires-user']) || 0;
    els.repos.textContent = (t.repos || 0) + ((t.repos === 1) ? ' repo' : ' repos') +
      (waiting ? ' · ' + waiting + ' waiting on you' : '');

    var rows = (data.repos || []).slice().sort(function (a, b) { return b.open - a.open; });
    renderRepoRows(els.repoRows, rows);
  }

  function renderRepoRows(ul, rows) {
    ul.textContent = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var li = document.createElement('li');

      var name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = r.name;
      li.appendChild(name);

      var figure = document.createElement('span');
      figure.className = 'row-figure';
      /* A repo that could not be read says so in place of its counts, rather
         than showing a zero that would read as an empty queue. */
      if (r.error) {
        figure.classList.add('row-error');
        figure.textContent = r.error;
      } else {
        figure.textContent = num(r.open) + ' open · ' + num(r.closed) + ' closed' +
          (r.blocked ? ' · ' + r.blocked + ' blocked' : '');
      }
      li.appendChild(figure);
      ul.appendChild(li);
    }
    setHeading(ul, rows.length, 'with queues');
  }

  /* ---------- the live view ---------- */

  function elapsed(since) {
    if (since == null) return '';
    var secs = Math.max(0, Math.round((Date.now() - since) / 1000));
    if (secs < 60) return secs + 's';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm' + (secs % 60) + 's';
    return Math.floor(mins / 60) + 'h' + (mins % 60) + 'm';
  }

  /* A held lock and an open Claude session are DIFFERENT CLAIMS about the
     machine - one says a runner owns some paths, the other says an agent is
     talking to the API - so they get separate columns and separate counts and
     are never added together. */
  function renderLive() {
    var running = data.running || [];
    var holders = [], activity = [];
    for (var i = 0; i < running.length; i++) {
      (running[i].kind === 'holder' ? holders : activity).push(running[i]);
    }
    renderRunning(els.holders, holders, true, 'held');
    renderRunning(els.activity, activity, false, 'active');
  }

  function renderRunning(ul, rows, showPaths, word) {
    ul.textContent = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var li = document.createElement('li');
      li.setAttribute('data-kind', r.kind);

      var name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = r.label;
      li.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'row-figure';
      var parts = [];
      if (r.kind !== 'holder') parts.push(r.kind);
      if (r.repo) parts.push(r.repo);
      var age = elapsed(r.since);
      if (age) parts.push(age);
      if (showPaths && r.detail) parts.push(r.detail);
      meta.textContent = parts.join(' · ');
      li.appendChild(meta);

      ul.appendChild(li);
    }
    setHeading(ul, rows.length, word);
  }

  /* ---------- the history view ---------- */

  /* buildHeatmap wants an array in calendar order; the feed sends a map keyed
     by date, because that is the shape that survives being aggregated. */
  function dayArray(days) {
    return Object.keys(days || {}).sort().map(function (k) {
      return { date: k, count: days[k] };
    });
  }

  function topKey(counts) {
    var best = '', bestN = -1;
    for (var k in counts) {
      if (counts[k] > bestN) { best = k; bestN = counts[k]; }
    }
    return best || '—';
  }

  function renderHistory() {
    var h = data.history || {};
    var reasons = [];
    var repos = data.repos || [];
    for (var i = 0; i < repos.length; i++) {
      if (repos[i].historyError) reasons.push(repos[i].historyError);
    }

    if (!h.runs) {
      /* An empty grid would read as months of silence rather than as history
         that could not be dated, which is the one failure this view must not
         have. */
      setNote(els.historyNote, reasons.length ? reasons.join(' · ')
        : 'no run has been recorded in any queue yet');
      els.history.style.display = 'none';
      return;
    }
    els.historyNote.style.display = 'none';
    els.history.style.display = '';

    var days = dayArray(h.days);
    var max = 0;
    for (var d = 0; d < days.length; d++) max = Math.max(max, days[d].count);

    /* Says which clock this is. The records carry no time of their own - the
       date is the commit each record's `head` names - and a view that showed
       it as when the run happened would be claiming something the data cannot
       support. */
    els.heatHead.textContent = 'Runs, by commit time';
    els.heat.textContent = '';
    els.heat.appendChild(buildHeatmap(days, max));

    els.figs.textContent = '';
    els.figs.appendChild(fig('runs', big(h.runs)));
    els.figs.appendChild(fig('days', big(days.length)));
    els.figs.appendChild(fig('top model', topKey(h.model)));
    els.figs.appendChild(fig('top effort', topKey(h.effort)));

    /* The outcome split is drawn from whatever the records name, not from a
       fixed pair: the corpus has FIVE (done, partial, blocked, failed,
       inconclusive), and hardcoding two would silently hide 41 runs.
       A strip of chips rather than one headline figure each, MEASURED: nine
       .fig blocks overflow the 840x344 slot by 46.6px, and the outcomes are a
       related set that reads better on one line than as five headlines
       competing with the run and day totals. */
    els.outcomes.textContent = '';
    var names = Object.keys(h.outcome || {}).sort(function (a, b) {
      return h.outcome[b] - h.outcome[a];
    });
    for (var o = 0; o < names.length; o++) {
      var chip = document.createElement('span');
      chip.className = 'oc oc-' + names[o].replace(/[^a-z]/gi, '');
      chip.setAttribute('data-outcome', names[o]);
      chip.appendChild(cell('span', big(h.outcome[names[o]]), 'n'));
      chip.appendChild(cell('span', names[o], 'k'));
      els.outcomes.appendChild(chip);
    }
  }

  /* ---------- the task files view ---------- */

  var FILE_COLUMNS = [
    { key: 'whattask.json',   head: 'queue' },
    { key: 'runs.jsonl',      head: 'runs' },
    { key: 'serial.lock',     head: 'lock' },
    { key: 'decisions.jsonl', head: 'decis' },
    { key: 'interview.json',  head: 'interv' }
  ];

  function kb(bytes) {
    if (bytes == null) return '–';          /* absent, not zero */
    if (bytes < 1024) return bytes + 'b';
    var k = bytes / 1024;
    return (k >= 1000 ? Math.round(k / 1024) + 'm' : Math.round(k) + 'k');
  }

  function renderFiles() {
    var repos = data.repos || [];
    var alarms = data.alarms || [];

    /* The alarms are the reason this view exists, so they go ABOVE the table
       and are never a column in it - a red cell in a grid of sizes is exactly
       the thing an eye skates past. */
    els.alarms.textContent = '';
    for (var a = 0; a < alarms.length; a++) {
      var al = alarms[a];
      var row = document.createElement('div');
      row.className = 'alarm alarm-' + al.kind;
      row.appendChild(cell('span', '⚠', 'sign'));
      row.appendChild(cell('span', al.repo + ' · ' + al.task, 'who'));
      row.appendChild(cell('span', al.message, 'what'));
      els.alarms.appendChild(row);
    }
    els.alarms.style.display = alarms.length ? '' : 'none';

    /* The header says the machine is clean when it is, rather than leaving the
       absence of an alarm to be inferred from an empty strip. */
    var stuck = 0;
    for (var m = 0; m < repos.length; m++) if (repos[m].mutex && repos[m].mutex.held) stuck++;
    els.repos.textContent = repos.length + (repos.length === 1 ? ' repo' : ' repos') +
      ' · ' + (alarms.length
        ? alarms.length + (alarms.length === 1 ? ' alarm' : ' alarms')
        : (stuck ? stuck + ' mutex held' : 'all clear'));

    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    hr.appendChild(cell('th', '', 'name'));
    for (var c = 0; c < FILE_COLUMNS.length; c++) {
      hr.appendChild(cell('th', FILE_COLUMNS[c].head, 'n'));
    }
    hr.appendChild(cell('th', 'mutex', 'n'));
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var i = 0; i < repos.length; i++) {
      var r = repos[i];
      var tr = document.createElement('tr');
      tr.appendChild(cell('td', r.name, 'name'));
      for (var j = 0; j < FILE_COLUMNS.length; j++) {
        var f = (r.files || {})[FILE_COLUMNS[j].key] || {};
        var td = cell('td', kb(f.present ? f.bytes : null), 'n');
        if (!f.present) td.classList.add('absent');
        tr.appendChild(td);
      }
      var mx = r.mutex || {};
      var mtd = cell('td', mx.held ? '●' : '○', 'n mx');
      if (mx.stale) mtd.classList.add('mx-stale');
      else if (mx.held) mtd.classList.add('mx-held');
      tr.appendChild(mtd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    els.filetable.textContent = '';
    els.filetable.appendChild(table);
  }

  /* ---------- the projects view ---------- */

  /* A marker as well as a colour. The panel is read from across a room and at
     an angle, where a hue difference is the first thing to go. */
  var STATE_MARK = { running: '▶ ', blocked: '⚠ ', done: '✓ ', queued: '' };

  var selectedProject = null;   /* survives a refresh; falls back if it vanishes */
  var projectData = null;
  var projectError = '';
  var projectPending = null;

  /* The overview's repo list is the source of truth for which tabs exist, so a
     project that disappears from the feed cannot stay selected. */
  function projectNames() {
    return (data && data.repos ? data.repos : []).map(function (r) { return r.name; });
  }

  function currentProject() {
    var names = projectNames();
    if (!names.length) return null;
    if (selectedProject && names.indexOf(selectedProject) >= 0) return selectedProject;
    return names[0];
  }

  function selectProject(name) {
    if (name === selectedProject) return;
    selectedProject = name;
    projectData = null;      /* do not show one project's tasks under another's tab */
    projectError = '';
    render();
    fetchProject();
  }

  /* Its own request, on the same cadence as the overview but only while this
     view is showing. The response is ~24KB for the largest queue against the
     overview's 2.4KB, which is exactly why it is not folded into it. */
  function fetchProject() {
    var name = currentProject();
    if (!name) return;
    var url = readFeedUrl() + (readFeedUrl().indexOf('?') >= 0 ? '&' : '?') +
      'project=' + encodeURIComponent(name);
    if (projectPending === name) return;
    projectPending = name;

    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, REQUEST_TIMEOUT_MS);

    fetch(url, controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (res) {
        clearTimeout(timeout);
        return res.json();
      })
      .then(function (json) {
        projectPending = null;
        /* A late answer for a tab the reader has already left must not
           overwrite the one they are looking at now. */
        if (json && json.project !== currentProject()) return;
        projectData = json;
        projectError = (json && json.error) || '';
        if (view === 'projects') render();
      })
      .catch(function (err) {
        clearTimeout(timeout);
        projectPending = null;
        projectError = (err && err.message) ? err.message : 'request failed';
        if (view === 'projects') render();
      });
  }

  function renderProjects() {
    var names = projectNames();
    var current = currentProject();

    els.tabs.textContent = '';
    for (var i = 0; i < names.length; i++) {
      var tab = document.createElement('button');
      tab.className = 'tab' + (names[i] === current ? ' is-active' : '');
      tab.setAttribute('data-project', names[i]);
      tab.textContent = names[i];
      els.tabs.appendChild(tab);
    }

    if (!names.length) {
      setNote(els.projectsNote, (data && data.unavailable) ||
        'no repo on this machine has a queue to show');
      els.listTasks.style.display = 'none';
      return;
    }
    els.projectsNote.style.display = 'none';
    els.listTasks.style.display = '';

    if (projectError) {
      /* The feed's own words, not a guess at what went wrong. */
      setNote(els.projectsNote, projectError);
      els.listTasks.style.display = 'none';
      return;
    }

    var tasks = (projectData && projectData.tasks) || [];
    var open = 0, blocked = 0, running = 0;
    for (var b = 0; b < tasks.length; b++) {
      if (tasks[b].state === 'done') continue;
      open++;
      if (tasks[b].state === 'blocked') blocked++;
      if (tasks[b].state === 'running') running++;
    }
    /* The count is of OPEN work: the done rows are history underneath it, and
       folding them into one total would make the queue look larger than it is. */
    setHeading(els.taskRows, open, 'open' +
      (running ? ' · ' + running + ' running' : '') +
      (blocked ? ' · ' + blocked + ' blocked' : ''), current);

    els.taskRows.textContent = '';
    for (var t = 0; t < tasks.length; t++) {
      var task = tasks[t];
      var li = document.createElement('li');
      li.className = 'st-' + (task.state || 'queued');
      li.setAttribute('data-state', task.state || 'queued');

      var top = document.createElement('span');
      top.className = 'row-name';
      top.textContent = STATE_MARK[task.state] + (task.title || task.id);
      li.appendChild(top);

      var meta = document.createElement('span');
      meta.className = 'row-figure';
      /* Whatever decides what happens to this task NEXT displaces the model and
         effort rather than joining them, because the row has one line: the
         blocking reason for a blocked one, and why it closed for a done one. */
      meta.textContent = task.blocked ? task.blocked
        : (task.state === 'done' ? (task.reason || 'closed')
        : [task.mode, task.model + '/' + task.effort].join(' · '));
      li.appendChild(meta);

      els.taskRows.appendChild(li);
    }
  }

  /* ---------- the dispatcher ---------- */

  function render() {
    if (!data) return;
    showState('content');

    els.updated.textContent = data.generatedAt ? formatStamp(data.generatedAt) : '';

    if (view === 'queue') renderQueue();
    else if (view === 'live') renderLive();
    else if (view === 'history') renderHistory();
    else if (view === 'files') renderFiles();
    else renderProjects();

    refreshPaging();
  }

  function applyView() {
    els.title.textContent = TITLES[view];
    els.viewQueue.classList.toggle('is-active', view === 'queue');
    els.viewLive.classList.toggle('is-active', view === 'live');
    els.viewHistory.classList.toggle('is-active', view === 'history');
    els.viewFiles.classList.toggle('is-active', view === 'files');
    els.viewProjects.classList.toggle('is-active', view === 'projects');
    /* The project detail is only fetched while its view is on screen. */
    if (view === 'projects') fetchProject();
    Array.prototype.forEach.call(document.querySelectorAll('.dots .dot'), function (d) {
      d.classList.toggle('is-active', d.getAttribute('data-view') === view);
    });
    /* Which regions overflow depends on the box each one actually got, which
       only exists once the view is displayed. Page positions are cleared
       rather than kept, so a view always opens at the top of its lists. */
    if (data) { pageIndex = {}; render(); }
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* Days since the epoch, from the YYYY-MM-DD the rollup writes. Parsed by
     hand rather than through Date(string): the widget's webview is not
     guaranteed to read a bare date as UTC, and an hour of drift would split
     a streak. */
  function dayNumber(iso) {
    var p = String(iso).split('-');
    if (p.length !== 3) return NaN;
    var n = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return Number.isFinite(n) ? Math.floor(n / 86400000) : NaN;
  }

  function shortDate(iso) {
    var p = String(iso).split('-');
    if (p.length !== 3) return iso;
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1];
  }

  function svg(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  /* Four filled levels plus an empty one, keyed off the busiest day. The
     square root pulls the middle of the range apart: message counts are
     heavily skewed, and a linear scale leaves almost every day on level 1. */
  function heatLevel(count, max) {
    if (!count || !max) return 0;
    return Math.max(1, Math.min(4, Math.ceil(4 * Math.sqrt(count / max))));
  }

  var HEAT_CELL = 12, HEAT_GAP = 2.4, HEAT_LABEL = 16;
  var WEEKDAY_LABEL = { 1: 'M', 3: 'W', 5: 'F' };

  /* A column per week, a row per weekday, drawn as SVG so the whole grid
     scales to whatever width the slot gives it rather than being clipped or
     wrapped.
     Laid out by CALENDAR position, not by array position: a run is recorded only on a day
     that had one, so `days` is sparse. Packing the
     entries side by side would draw a solid block with no quiet days in it and
     put every date in the wrong column. */
  function buildHeatmap(days, max) {
    var step = HEAT_CELL + HEAT_GAP;
    var first = dayNumber(days[0].date);
    var span = dayNumber(days[days.length - 1].date) - first + 1;
    var counts = {};
    days.forEach(function (d) { counts[dayNumber(d.date) - first] = d.count; });
    /* 1970-01-01 was a Thursday, so +4 lands day 0 on a Sunday column. */
    var offset = (first + 4) % 7;
    var cols = Math.ceil((offset + span) / 7);
    var w = HEAT_LABEL + cols * step;
    var h = 7 * step;
    var root = svg('svg', {
      viewBox: '0 0 ' + w.toFixed(1) + ' ' + h.toFixed(1),
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img'
    });

    Object.keys(WEEKDAY_LABEL).forEach(function (row) {
      var t = svg('text', {
        x: 0, y: (Number(row) * step + HEAT_CELL * 0.8).toFixed(1),
        class: 'heat-day', 'font-size': HEAT_CELL * 0.8
      });
      t.textContent = WEEKDAY_LABEL[row];
      root.appendChild(t);
    });

    for (var i = 0; i < span; i++) {
      var slot = offset + i;
      root.appendChild(svg('rect', {
        x: (HEAT_LABEL + Math.floor(slot / 7) * step).toFixed(1),
        y: ((slot % 7) * step).toFixed(1),
        width: HEAT_CELL, height: HEAT_CELL, rx: 2,
        'data-day': i,
        'data-level': heatLevel(counts[i], max),
        class: 'cell l' + heatLevel(counts[i], max)
      }));
    }
    return root;
  }
  function fig(key, value) {
    var d = document.createElement('div');
    d.className = 'fig';
    d.appendChild(cell('span', key, 'k'));
    d.appendChild(cell('span', value, 'v'));
    return d;
  }

  /* Streaks are counted over calendar dates rather than array positions: the
     rollup only writes a row for a day that had activity, so consecutive
     entries are not necessarily consecutive days. */
  function big(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    return compact(n);
  }
  /* The pager's state. An overflowing region advances ITSELF, one page every
     PAGE_MS, wrapping at the end, because the iCUE webview forwards taps but
     NOT touch drags - measured on the device - so a region that relies on
     being scrolled by hand strands every row below the fold. A region that
     fits never moves. Driven off computed overflow rather than off a list of
     known selectors. */
  var paged = [];          /* the overflowing regions of the active view */
  var pageIndex = {};      /* page per region, kept ACROSS a re-render */
  var pageTimer = null;

  function pageOffsets(el) {
    var kids = el.children;
    if (!kids.length) return [0];
    var max = el.scrollHeight - el.clientHeight;
    var savedScrollTop = el.scrollTop;
    el.scrollTop = 0;
    var elTop = el.getBoundingClientRect().top;
    var boundaries = [];
    function collect(node) {
      var kidsN = node.children;
      if (node.offsetHeight <= el.clientHeight + 0.5 || !kidsN.length) {
        var r = node.getBoundingClientRect();
        boundaries.push({ top: r.top - elTop, height: r.height });
        return;
      }
      for (var i = 0; i < kidsN.length; i++) collect(kidsN[i]);
    }
    for (var i = 0; i < kids.length; i++) collect(kids[i]);
    el.scrollTop = savedScrollTop;
    /* A line of inline content can render with its rect starting a hair
       above el's own padding-box top (font-metric overshoot, MEASURED at a
       consistent -1px here) - normalizing every boundary against the first
       one, rather than against el's rect directly, cancels that constant
       exactly the way the old base-from-kids[0] subtraction did. */
    if (boundaries.length) {
      var base = boundaries[0].top;
      for (var b = 0; b < boundaries.length; b++) boundaries[b].top -= base;
    }

    var offsets = [0];
    var top = 0;
    for (var i = 0; i < boundaries.length; i++) {
      var t = boundaries[i].top;
      var bottom = t + boundaries[i].height;
      if (bottom > top + el.clientHeight + 0.5) {
        top = t;
        offsets.push(Math.min(top, max));
        while (bottom > top + el.clientHeight + 0.5) {
          top += el.clientHeight;
          offsets.push(Math.min(top, max));
        }
      }
    }
    /* Clamping can collapse the last two boundaries onto the same offset. */
    var out = [offsets[0]];
    for (var j = 1; j < offsets.length; j++) {
      if (offsets[j] > out[out.length - 1] + 0.5) out.push(offsets[j]);
    }
    return out;
  }

  /* The fade now means "there is content BELOW WHERE YOU ARE", not "this box
     overflows somewhere" - on the last page there is nothing more to come and
     drawing it would be the same false promise in a smaller form. */
  function markFade(el) {
    var box = el.classList.contains('col') ? el : el.parentNode;
    if (!box) return;
    var more = el.scrollHeight - el.clientHeight - el.scrollTop > 1; /* +1 absorbs sub-pixel rounding */
    box.classList.toggle('can-scroll', more);
  }

  /* One dot per page in the region's own heading, which costs no vertical
     space - the box is 232px and a row is 32px, so an indicator on its own
     line would have cost a row of the very content it describes. Same idiom
     as the view dots in the header. */
  /* The heading's own text has to become a real element before the dots go
     beside it. Left as a loose text node it is an anonymous flex item that
     will not shrink, so the heading wrapped to a second line and took 22px
     off the list below it - MEASURED: d-workflows' box fell from 232px to
     210px, one whole row, the first time the dots were added. */
  function headingBody(h) {
    var body = h.querySelector('.htext');
    if (body) return body;
    body = document.createElement('span');
    body.className = 'htext';
    while (h.firstChild) body.appendChild(h.firstChild);
    h.appendChild(body);
    return body;
  }

  function setPageDots(el, i, pages) {
    var h = (el.classList.contains('col') ? el : el.parentNode);
    h = h && h.querySelector('h2');
    if (!h) return;
    var old = h.querySelector('.pages');
    if (old) h.removeChild(old);
    headingBody(h);
    if (pages < 2) return;
    var wrap = document.createElement('span');
    wrap.className = 'pages';
    for (var p = 0; p < pages; p++) {
      var d = document.createElement('i');
      if (p === i) d.className = 'is-active';
      wrap.appendChild(d);
    }
    h.appendChild(wrap);
  }

  /* Rebuilt whenever the data or the view changes, because both change which
     regions overflow and by how much. Driven off getComputedStyle rather than
     a list of ids so a future view is covered without being named here. */
  /* The projects view does not page itself. Every other list here is short
     enough that a page or two covers it, so nothing is stranded by advancing
     them; the project task list is up to 162 rows and is meant to be read at
     the reader's own pace rather than moved out from under them. It keeps its
     overflow-y so a wheel or trackpad still reaches the rest - and note the
     measurement in README.md: the Edge webview forwards taps but NOT drags, so
     on the panel itself this list shows what fits and no more. */
  var NO_PAGING = { projects: true };

  function refreshPaging() {
    paged = [];
    var av = document.querySelector('.view.is-active');
    if (!av) return;
    if (NO_PAGING[view]) {
      /* Clear any dots and fade a previous view left behind. */
      var stale = av.querySelectorAll('.pages');
      for (var p = 0; p < stale.length; p++) stale[p].parentNode.removeChild(stale[p]);
      return;
    }
    var all = av.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.clientHeight === 0) continue;
      var oy = window.getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      /* DOM order is stable, so a positional key survives a re-render and
         keeps a list on the page it was showing. */
      if (!el.id && !el.getAttribute('data-page-key')) {
        el.setAttribute('data-page-key', view + ':' + i);
      }
      var key = el.id || el.getAttribute('data-page-key');
      var offsets = pageOffsets(el);
      var at = Math.min(pageIndex[key] || 0, offsets.length - 1);
      pageIndex[key] = at;
      el.scrollTop = offsets[at];
      setPageDots(el, at, offsets.length);
      markFade(el);
      if (offsets.length > 1) paged.push({ el: el, key: key, offsets: offsets });
    }
  }

  function advancePages() {
    for (var i = 0; i < paged.length; i++) {
      var p = paged[i];
      /* A region that has since been re-rendered smaller is left to the next
         refreshPaging() rather than scrolled to a stale offset. */
      if (!p.el.isConnected || p.el.clientHeight === 0) continue;
      var at = (pageIndex[p.key] + 1) % p.offsets.length;
      pageIndex[p.key] = at;
      p.el.scrollTop = p.offsets[at];
      setPageDots(p.el, at, p.offsets.length);
      markFade(p.el);
    }
  }

  function startPaging() {
    if (pageTimer) clearInterval(pageTimer);
    pageTimer = setInterval(advancePages, PAGE_MS);
  }
  function toggleView() {
    view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
    applyView();
  }

  function showState(state) {
    ['loading-state', 'error-state', 'content'].forEach(function (name) {
      var el = document.querySelector('.' + name);
      if (el) el.style.display = (name === state) ? '' : 'none';
    });
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', readTheme());
  }

  /* ---------- fetching ---------- */

  function fetchFeed() {
    var url = readFeedUrl();
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, REQUEST_TIMEOUT_MS);

    fetch(url, controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (res) {
        clearTimeout(timeout);
        if (!res.ok) {
          /* The feed answers a non-2xx with a JSON body carrying the real
             cause (the three-state /health contract) - read it before
             throwing, rather than discarding the body and falling back to
             a fixed "start the server" hint that is wrong when the server
             IS running but has no snapshot yet, or every rebuild failed. */
          return res.json().catch(function () { return null; }).then(function (body) {
            var err = new Error('HTTP ' + res.status);
            if (body && typeof body.error === 'string' && body.error) {
              err.message = body.error;
              err.fromResponseBody = true;
            }
            throw err;
          });
        }
        return res.json();
      })
      .then(function (json) {
        data = json;
        lastError = '';
        render();
        /* The project task list is its own request, so a poll that refreshes
           the overview leaves it untouched. Without this the list freezes at
           whatever it held when the view was opened: a task that starts
           running afterwards never turns green, and one that closes never
           moves down. fetchProject() no-ops if a request for the same project
           is already in flight. */
        if (view === 'projects') fetchProject();
      })
      .catch(function (err) {
        clearTimeout(timeout);
        lastError = err && err.message ? err.message : 'request failed';
        /* Keep the last good reading on screen rather than blanking it. */
        if (data) {
          render();
        } else {
          els.errorHint.textContent = (err && err.fromResponseBody)
            ? lastError
            : 'Start it with: node usage-server/server.js — ' + url + ' (' + lastError + ')';
          showState('error-state');
        }
      });
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(fetchFeed, readRefreshSeconds() * 1000);
  }

  function renderTimeOfDay() {
    if (els.clock) els.clock.textContent = timeString(new Date(), readTimeFormat());
  }

  /* Once a second, not once a minute: a minute-aligned timer drifts on a device
     that suspends its page, and the redraw is one text node. */
  function startTimeOfDay() {
    renderTimeOfDay();
    setInterval(renderTimeOfDay, 1000);
  }

  /* ---------- iCUE lifecycle ---------- */

  function onIcueDataUpdated() {
    applyTheme();
    renderTimeOfDay();
    if (data) render();
    schedule();
    fetchFeed();
  }

  function onIcueInitialized() {
    onIcueDataUpdated();
  }

  window.TaskQueue = {
    onDataUpdated: onIcueDataUpdated,
    onICUEInitialized: onIcueInitialized
  };

  /* The elapsed times in the live view are relative, so tick them between
     polls - otherwise a held lock reads as the same age for a whole refresh
     interval. Only the live view has them, so nothing else is touched. */
  function startClock() {
    setInterval(function () {
      if (data && view === 'live') renderLive();
    }, 5000);
  }

  /* Every els.* name used anywhere in this file is assigned here. One that is
     not becomes `undefined` at render time, and the failure is a silent blank
     rather than an error. */
  function cacheElements() {
    els.title = document.getElementById('title');
    els.repos = document.getElementById('repos');
    els.updated = document.getElementById('updated');
    els.version = document.getElementById('version');
    els.clock = document.getElementById('clock');
    els.errorHint = document.getElementById('error-hint');

    els.viewQueue = document.querySelector('.view-queue');
    els.meters = document.querySelector('.view-queue .meters');
    els.listRepos = document.getElementById('list-repos');
    els.repoRows = document.getElementById('repo-rows');
    els.mDone = document.getElementById('m-done');
    els.doneFill = document.getElementById('done-fill');
    els.doneValue = document.getElementById('done-value');
    els.doneSub = document.getElementById('done-sub');
    els.queueNote = document.getElementById('queue-note');

    els.viewLive = document.querySelector('.view-live');
    els.holders = document.getElementById('holders');
    els.activity = document.getElementById('activity');

    els.viewHistory = document.querySelector('.view-history');
    els.history = document.querySelector('.view-history .history');
    els.heat = document.getElementById('heat');
    els.heatHead = document.getElementById('heat-head');
    els.figs = document.getElementById('figs');
    els.outcomes = document.getElementById('outcomes');
    els.historyNote = document.getElementById('history-note');

    els.viewFiles = document.querySelector('.view-files');
    els.alarms = document.getElementById('alarms');
    els.filetable = document.getElementById('filetable');

    els.viewProjects = document.querySelector('.view-projects');
    els.tabs = document.getElementById('tabs');
    els.listTasks = document.getElementById('list-tasks');
    els.taskRows = document.getElementById('task-rows');
    els.tasksHead = document.getElementById('tasks-head');
    els.projectsNote = document.getElementById('projects-note');

    if (els.version) els.version.textContent = 'v' + WIDGET_VERSION;
  }
  /* A single false read of iCUE_initialized is a race, not proof of a browser. */
  var bootAttempts = 0, BOOT_RETRY_MS = 100, BOOT_RETRY_MAX = 15;
  function bootCheck() {
    if (typeof iCUE_initialized !== 'undefined' && iCUE_initialized) {
      onIcueInitialized();
      return;
    }
    if (bootAttempts < BOOT_RETRY_MAX) {
      bootAttempts++;
      setTimeout(bootCheck, BOOT_RETRY_MS);
      return;
    }
    onIcueDataUpdated();
  }

  cacheElements();
  applyTheme();
  applyView();

  /* Tap anywhere to swap views. Needs "interactive": true in manifest.json,
     without which iCUE never forwards touches to the page.
     A plain click listener would also fire at the end of a scroll drag, so a
     gesture only counts as a tap if the pointer barely moved and was not held.
     Pointer events cover mouse and touch alike; the click fallback is for any
     context that does not deliver them. */
  (function bindTap() {
    var startX = 0, startY = 0, startT = 0, tracking = false;

    function down(e) {
      tracking = true;
      startX = e.clientX;
      startY = e.clientY;
      startT = Date.now();
    }

    function up(e) {
      if (!tracking) return;
      tracking = false;
      var moved = Math.abs(e.clientX - startX) > TAP_SLOP_PX ||
                  Math.abs(e.clientY - startY) > TAP_SLOP_PX;
      if (moved || (Date.now() - startT) > TAP_MAX_MS) return;

      /* A tap that lands on a project tab selects it; anything else still
         cycles the views. Resolved by elementFromPoint rather than by trusting
         e.target: the pointerup can be delivered on a different element from
         the pointerdown, and the tab's own text node is not the button. */
      var hit = document.elementFromPoint(e.clientX, e.clientY);
      var tab = hit && hit.closest ? hit.closest('.tab') : null;
      if (tab && view === 'projects') {
        selectProject(tab.getAttribute('data-project'));
        return;
      }
      toggleView();
    }

    if (typeof window.PointerEvent === 'function') {
      document.addEventListener('pointerdown', down);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', function () { tracking = false; });
    } else {
      document.addEventListener('click', toggleView);
    }
  })();

  showState('loading-state');
  startTimeOfDay();
  startClock();
  startPaging();
  fetchFeed();
  bootCheck();
})();
