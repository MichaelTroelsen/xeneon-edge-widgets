/* Claude Code usage widget.
   All data comes from the local feed (usage-server/server.js) on 127.0.0.1;
   the widget itself is a sandboxed page and reads nothing from disk. */
(function () {
  'use strict';

  /* Keep in step with manifest.json - shown in the header on the device. */
  var WIDGET_VERSION = '1.0.3';
  var DEFAULT_FEED = 'http://127.0.0.1:41777/usage';
  var REQUEST_TIMEOUT_MS = 6000;
  var MAX_ROWS = 12;          /* CSS hides the overflow; this just caps DOM churn */
  var HIGH_WATER = 80;        /* percent at which a bar turns amber */

  var els = {};
  var timer = null;
  var data = null;
  var lastError = '';

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

  function compact(n) {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  /* ---------- rendering ---------- */

  function setMeter(meterEl, fillEl, valueEl, percent, blocked) {
    var p = clampRange(percent, 0, 100, 0);
    fillEl.style.width = p + '%';
    valueEl.textContent = p + '% used';
    meterEl.classList.toggle('is-high', !blocked && p >= HIGH_WATER);
    meterEl.classList.toggle('is-blocked', !!blocked);
  }

  function stateClass(state) {
    return 'state-' + String(state || 'queued').toLowerCase().replace(/[^a-z_]/g, '');
  }

  function renderList(ul, items, describe) {
    ul.textContent = '';
    if (!items || !items.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Nothing recent';
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
  }

  function render() {
    if (!data) return;

    els.plan.textContent = data.plan || '';

    setMeter(els.mSession, els.sessionFill, els.sessionValue,
      data.session ? data.session.percent : 0,
      data.session && data.session.blocked);
    els.sessionSub.textContent = data.session && data.session.active
      ? formatCountdown(data.session.resetsAt)
      : 'No active session';

    setMeter(els.mWeekly, els.weeklyFill, els.weeklyValue,
      data.weekly ? data.weekly.percent : 0, false);
    els.weeklySub.textContent = formatWeekday(data.weekly ? data.weekly.resetsAt : null);

    var bucket = data.weekly && data.weekly.buckets && data.weekly.buckets[0];
    if (bucket) {
      els.mBucket.style.display = '';
      els.bucketName.textContent = bucket.label;
      setMeter(els.mBucket, els.bucketFill, els.bucketValue, bucket.percent, false);
    } else {
      els.mBucket.style.display = 'none';
    }

    renderList(els.workflows, data.workflows, function (wf) {
      return wf.project + ' · ' + compact(wf.tokens);
    });

    renderList(els.subtasks, data.subtasks, function (task) {
      return (task.model || '') + (task.tokens ? ' · ' + compact(task.tokens) : '');
    });

    showState('content');
    trimLists();
  }

  /* A row sliced in half by the panel edge reads as a rendering fault on a
     hardware display, so drop rows until the list fits its own box. */
  function trimLists() {
    [els.workflows, els.subtasks].forEach(function (ul) {
      if (!ul || getComputedStyle(ul).display === 'none') return;
      var guard = 0;
      while (ul.scrollHeight > ul.clientHeight && ul.children.length > 1 && guard++ < MAX_ROWS) {
        ul.removeChild(ul.lastChild);
      }
    });
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
    els.plan = document.getElementById('plan');
    els.mSession = document.getElementById('m-session');
    els.sessionFill = document.getElementById('session-fill');
    els.sessionValue = document.getElementById('session-value');
    els.sessionSub = document.getElementById('session-sub');
    els.mWeekly = document.getElementById('m-weekly');
    els.weeklyFill = document.getElementById('weekly-fill');
    els.weeklyValue = document.getElementById('weekly-value');
    els.weeklySub = document.getElementById('weekly-sub');
    els.mBucket = document.getElementById('m-bucket');
    els.bucketName = document.getElementById('bucket-name');
    els.bucketFill = document.getElementById('bucket-fill');
    els.bucketValue = document.getElementById('bucket-value');
    els.workflows = document.getElementById('workflows');
    els.subtasks = document.getElementById('subtasks');
    els.errorHint = document.getElementById('error-hint');
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
  showState('loading-state');
  startClock();
  fetchFeed();
  bootCheck();
})();
