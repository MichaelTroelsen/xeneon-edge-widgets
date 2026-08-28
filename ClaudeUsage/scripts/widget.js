/* Claude Code usage widget.
   All data comes from the local feed (usage-server/server.js) on 127.0.0.1;
   the widget itself is a sandboxed page and reads nothing from disk. */
(function () {
  'use strict';

  /* Keep in step with manifest.json - shown in the header on the device. */
  var WIDGET_VERSION = '1.7.0';
  var DEFAULT_FEED = 'http://127.0.0.1:41777/usage';
  var REQUEST_TIMEOUT_MS = 6000;
  var MAX_ROWS = 40;          /* lists scroll, so render everything the feed sends */
  var TAP_SLOP_PX = 12;       /* movement beyond this is a scroll, not a tap */
  var TAP_MAX_MS = 700;
  var HIGH_WATER = 80;        /* percent at which a bar turns amber */
  var CRITICAL_WATER = 95;    /* and red */

  var els = {};
  var timer = null;
  var data = null;
  var lastError = '';
  var view = 'usage';   /* 'usage' | 'detail' — toggled by tapping the widget */

  var TITLES = { usage: 'Claude Code usage', detail: 'Activity' };

  /* ---------- iCUE property access ---------- */

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
    return clampRange(getIcueProperty('refreshSeconds'), 5, 120, 20);
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

  function stateClass(state) {
    return 'state-' + String(state || 'queued').toLowerCase().replace(/[^a-z_]/g, '');
  }

  /* The heading carries the count of what is running, so you can tell at a
     glance whether the visible rows are all of them or the top of a longer
     list - and, when there are none, that the empty list is the real state
     rather than a feed that failed. */
  function setHeading(ul, total) {
    var h = ul.parentNode && ul.parentNode.querySelector('h2');
    if (!h) return;
    if (!h.getAttribute('data-base')) h.setAttribute('data-base', h.textContent);
    var base = h.getAttribute('data-base');
    h.textContent = base + ' · ' + (total ? total + ' active' : 'none active');
  }

  function renderList(ul, items, describe, emptyNote) {
    var scrollTop = ul.scrollTop; /* keep the reader's place across a refresh */
    ul.textContent = '';
    setHeading(ul, items ? items.length : 0);
    if (!items || !items.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      /* "Nothing running" rather than "Nothing recent": the lists no longer
         carry finished work, so an empty one means idle, not missing data. */
      empty.textContent = emptyNote || 'Nothing running';
      ul.appendChild(empty);
      return;
    }
    items.slice(0, MAX_ROWS).forEach(function (item) {
      var li = document.createElement('li');
      li.className = stateClass(item.state || item.status);

      var dot = document.createElement('span');
      dot.className = 'dot';

      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.label || item.name || item.summary || '';

      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = describe(item);

      li.appendChild(dot);
      li.appendChild(label);
      li.appendChild(meta);
      ul.appendChild(li);
    });
    ul.scrollTop = scrollTop;
  }

  function render() {
    if (!data) return;

    els.plan.textContent = data.plan || '';

    els.updated.textContent = formatStamp(data.generatedAt);
    /* Three missed refresh cycles is well past coincidence: the feed has
       stopped and these numbers are frozen. */
    var staleAfter = readRefreshSeconds() * 3000;
    els.updated.classList.toggle('is-stale',
      !!data.generatedAt && (Date.now() - data.generatedAt) > staleAfter);

    /* Anthropic's own utilisation when the feed could reach the OAuth endpoint;
       the measured token counts when it could not. Never both, and never a
       locally invented percentage. */
    /* The server keeps the last good reading when a poll is throttled, marking
       it stale rather than dropping it - so a rate limit no longer swaps the
       display over to a different metric for a few minutes. */
    var official = data.official || {};
    var live = (official.ok || official.stale) ? official : null;

    /* Always say which mode is on screen. Falling back silently makes measured
       token counts look like they came from Anthropic. */
    els.live.textContent = live ? (official.stale ? 'LIVE·' : 'LIVE') : 'LOCAL';
    els.live.className = live ? (official.stale ? 'live is-stale' : 'live') : 'live is-local';
    els.live.title = live
      ? (official.stale
          ? ('Anthropic figures from ' + formatStamp(official.staleSince).replace('Updated ', '') +
             ', not refreshed since: ' + (official.error || 'unknown'))
          : ('Utilisation read from Anthropic via ' + (official.source || 'OAuth')))
      : ('Anthropic figures unavailable: ' + (official.error || 'unknown') +
         ' — showing locally measured tokens');

    var s = data.session || {};
    var st = s.tokens || {};

    if (live && live.fiveHour) {
      els.sessionValue.textContent = live.fiveHour.percent + '% used';
      els.sessionSub.textContent = formatCountdown(live.fiveHour.resetsAt);
    } else {
      els.sessionValue.textContent = compact(st.total) + ' tok';
      els.sessionSub.textContent = s.active ? formatCountdown(s.resetsAt) : 'No active session';
    }
    /* With live data the bar is the real utilisation. Without it, the bar is
       this block against your own busiest recent block — never a plan limit,
       which is why the note spells out which one you are looking at. */
    var peak = s.peakWeighted || 0;
    var frac = peak > 0 ? Math.min(100, (s.usedWeighted / peak) * 100) : 0;
    setBar(els.mSession, els.sessionFill, (live && live.fiveHour) ? live.fiveHour.percent : frac);

    els.sessionNote.textContent = num(st.messages) + ' msgs · ' + compact(st.output) + ' out' +
      (live ? '' : (peak > 0 ? ' · ' + Math.round(frac) + '% of peak block' : ''));

    var w = data.weekly || {};
    var wt = w.tokens || {};

    if (live && live.sevenDay) {
      els.weeklyValue.textContent = live.sevenDay.percent + '% used';
      els.weeklySub.textContent = formatWeekday(live.sevenDay.resetsAt);
      els.weeklyTrack.style.display = '';
      setBar(els.mWeekly, els.weeklyFill, live.sevenDay.percent);
    } else {
      els.weeklyValue.textContent = compact(wt.total) + ' tok';
      els.weeklySub.textContent = formatWeekday(w.resetsAt);
      /* No bar without live data: a week has no honest local reference the way
         a block can be measured against your busiest recent one. */
      els.weeklyTrack.style.display = 'none';
    }
    els.weeklyNote.textContent = num(wt.messages) + ' msgs · ' + compact(wt.output) + ' out';

    var describeWorkflow = function (wf) {
      return wf.project + ' · ' + compact(wf.tokens);
    };
    var describeSubtask = function (task) {
      return (task.model || '') + (task.tokens ? ' · ' + compact(task.tokens) : '');
    };
    var describeSession = function (s) {
      return s.project + ' · ' + s.messages;
    };

    /* A backlog is worth saying out loud: an empty subtask list with 86 tasks
       waiting is a different situation from an empty one with none. */
    var queued = (data.counts && data.counts.queued) || 0;
    var noSubtasks = queued ? 'Nothing running · ' + queued + ' queued' : 'Nothing running';

    renderList(els.workflows, data.workflows, describeWorkflow);
    renderList(els.subtasks, data.subtasks, describeSubtask, noSubtasks);

    renderList(els.dSessions, data.sessions, describeSession);
    renderList(els.dWorkflows, data.workflows, describeWorkflow);
    renderList(els.dSubtasks, data.subtasks, describeSubtask, noSubtasks);

    showState('content');
    markScrollable();
  }

  /* Lists scroll rather than being trimmed to fit, so nothing is unreachable.
     A partly visible row at the bottom edge is the point: together with the
     fade it says there is more below. */
  function markScrollable() {
    [els.workflows, els.subtasks, els.dSessions, els.dWorkflows, els.dSubtasks].forEach(function (ul) {
      if (!ul || !ul.parentNode) return;
      var more = ul.scrollHeight > ul.clientHeight + 1; /* +1 absorbs sub-pixel rounding */
      ul.parentNode.classList.toggle('can-scroll', more);
    });
  }

  function applyView() {
    els.title.textContent = TITLES[view];
    els.viewUsage.classList.toggle('is-active', view === 'usage');
    els.viewDetail.classList.toggle('is-active', view === 'detail');
    Array.prototype.forEach.call(document.querySelectorAll('.dots .dot'), function (d) {
      d.classList.toggle('is-active', d.getAttribute('data-view') === view);
    });
    /* Row trimming depends on the box each list actually got, which only
       exists once the view is displayed. */
    if (data) markScrollable();
  }

  function toggleView() {
    view = (view === 'usage') ? 'detail' : 'usage';
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
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        data = json;
        lastError = '';
        render();
      })
      .catch(function (err) {
        clearTimeout(timeout);
        lastError = err && err.message ? err.message : 'request failed';
        /* Keep the last good reading on screen rather than blanking it. */
        if (data) {
          render();
        } else {
          els.errorHint.textContent = 'Start it with: node usage-server/server.js — ' + url + ' (' + lastError + ')';
          showState('error-state');
        }
      });
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(fetchFeed, readRefreshSeconds() * 1000);
  }

  /* Reset captions are relative, so tick them between polls. */
  function startClock() {
    setInterval(function () {
      if (data && data.session && data.session.active) {
        els.sessionSub.textContent = formatCountdown(data.session.resetsAt);
      }
    }, 30000);
  }

  /* ---------- iCUE lifecycle ---------- */

  function onIcueDataUpdated() {
    applyTheme();
    render();
    schedule();
    fetchFeed();
  }

  function onIcueInitialized() {
    onIcueDataUpdated();
  }

  window.ClaudeUsage = {
    onDataUpdated: onIcueDataUpdated,
    onICUEInitialized: onIcueInitialized
  };

  function cacheElements() {
    els.title = document.getElementById('title');
    els.viewUsage = document.querySelector('.view-usage');
    els.viewDetail = document.querySelector('.view-detail');
    els.dSessions = document.getElementById('d-sessions');
    els.dWorkflows = document.getElementById('d-workflows');
    els.dSubtasks = document.getElementById('d-subtasks');
    els.plan = document.getElementById('plan');
    els.mSession = document.getElementById('m-session');
    els.sessionFill = document.getElementById('session-fill');
    els.sessionValue = document.getElementById('session-value');
    els.sessionSub = document.getElementById('session-sub');
    els.mWeekly = document.getElementById('m-weekly');
    els.weeklyValue = document.getElementById('weekly-value');
    els.weeklySub = document.getElementById('weekly-sub');
    els.weeklyTrack = document.getElementById('weekly-track');
    els.weeklyFill = document.getElementById('weekly-fill');
    els.sessionNote = document.getElementById('session-note');
    els.weeklyNote = document.getElementById('weekly-note');
    els.workflows = document.getElementById('workflows');
    els.subtasks = document.getElementById('subtasks');
    els.errorHint = document.getElementById('error-hint');
    els.updated = document.getElementById('updated');
    els.live = document.getElementById('live');
    els.version = document.getElementById('version');
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
      if (!moved && (Date.now() - startT) <= TAP_MAX_MS) toggleView();
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
  startClock();
  fetchFeed();
  bootCheck();
})();
