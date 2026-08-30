/* Claude Code usage widget.
   All data comes from the local feed (usage-server/server.js) on 127.0.0.1;
   the widget itself is a sandboxed page and reads nothing from disk. */
(function () {
  'use strict';

  /* Keep in step with manifest.json - shown in the header on the device. */
  var WIDGET_VERSION = '1.11.0';
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
  var VIEWS = ['usage', 'detail', 'tokens', 'stats', 'models'];
  var view = 'usage';   /* tapping the widget cycles through VIEWS */

  var TITLES = { usage: 'Claude Code usage', detail: 'Activity', tokens: 'Tokens',
                 stats: 'All time', models: 'Tokens by model' };

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
    return clampRange(getIcueProperty('refreshSeconds'), 5, 120, 10);
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
      /* Sessions lead with their project: the same slash command runs in
         several repos, so the label alone does not say which one this is. */
      var text = item.label || item.name || item.summary || '';
      if (item.project && item.messages !== undefined) {
        var proj = document.createElement('span');
        proj.className = 'proj';
        proj.textContent = item.project + ' · ';
        label.appendChild(proj);
      }
      label.appendChild(document.createTextNode(text));

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

  /* One row per token class, with its share of the total - the share is what
     makes a cache-read-dominated window obvious at a glance. */
  function renderTokens(tbody, t) {
    tbody.textContent = '';
    if (!t) return;
    var total = t.total || 0;
    var rows = [
      ['output', t.output], ['cache creation', t.cacheCreation],
      ['cache read', t.cacheRead], ['input', t.input]
    ];
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.appendChild(cell('th', r[0], ''));
      tr.appendChild(cell('td', num(r[1]), 'n'));
      tr.appendChild(cell('td', total ? (r[1] / total * 100).toFixed(1) + '%' : '—', 'pct'));
      tbody.appendChild(tr);
    });
    var sum = document.createElement('tr');
    sum.className = 'sum';
    sum.appendChild(cell('th', 'total', ''));
    sum.appendChild(cell('td', num(total), 'n'));
    sum.appendChild(cell('td', '', 'pct'));
    tbody.appendChild(sum);
    var msgs = document.createElement('tr');
    msgs.appendChild(cell('th', 'messages', ''));
    msgs.appendChild(cell('td', num(t.messages), 'n'));
    msgs.appendChild(cell('td', '', 'pct'));
    tbody.appendChild(msgs);
  }

  function renderModels(tbody, t) {
    tbody.textContent = '';
    var by = t && t.byModel;
    if (!by) return;
    var names = Object.keys(by).sort(function (a, b) { return by[b].weighted - by[a].weighted; });
    if (!names.length) return;
    var head = document.createElement('tr');
    /* Not 'head': the page header is .head { display: flex }, which also
       matched this row and destroyed its table layout. */
    head.className = 'mdl-head';
    head.appendChild(cell('th', 'model', ''));
    head.appendChild(cell('td', 'msgs', 'n'));
    head.appendChild(cell('td', 'output', 'n'));
    tbody.appendChild(head);
    names.forEach(function (m) {
      var tr = document.createElement('tr');
      /* The dated suffix on some model ids costs a third of the column. */
      tr.appendChild(cell('th', m.replace(/^claude-/, '').replace(/-\d{8}$/, ''), ''));
      tr.appendChild(cell('td', num(by[m].messages), 'n'));
      tr.appendChild(cell('td', compact(by[m].output), 'n'));
      tbody.appendChild(tr);
    });
  }

  function cell(tag, text, cls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  }

  /* ---------- all-time stats ---------- */

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
     Laid out by CALENDAR position, not by array position: the rollup writes a
     row only for a day that had activity, so `days` is sparse. Packing the
     entries side by side would draw a solid block with no quiet days in it and
     put every date in the wrong column. */
  function buildHeatmap(days, max) {
    var step = HEAT_CELL + HEAT_GAP;
    var first = dayNumber(days[0].date);
    var span = dayNumber(days[days.length - 1].date) - first + 1;
    var counts = {};
    days.forEach(function (d) { counts[dayNumber(d.date) - first] = d.messageCount; });
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
  function streaks(days, lastDay) {
    var active = days.filter(function (d) { return d.messageCount > 0; })
      .map(function (d) { return dayNumber(d.date); })
      .filter(function (n) { return Number.isFinite(n); })
      .sort(function (a, b) { return a - b; });
    if (!active.length) return { current: 0, longest: 0 };
    var longest = 1, run = 1;
    for (var i = 1; i < active.length; i++) {
      run = (active[i] - active[i - 1] === 1) ? run + 1 : 1;
      if (run > longest) longest = run;
    }
    /* Today with nothing logged yet should not break yesterday's streak, so
       the run counts as current if it reaches either day. */
    var last = active[active.length - 1];
    var current = (lastDay - last <= 1) ? run : 0;
    return { current: current, longest: longest };
  }

  function topModel(modelUsage) {
    var names = Object.keys(modelUsage || {});
    if (!names.length) return null;
    names.sort(function (a, b) {
      return (modelUsage[b].outputTokens || 0) - (modelUsage[a].outputTokens || 0);
    });
    return names[0];
  }

  /* All-time token counts run to eleven figures, where compact() would print
     '44534.5M'. Kept separate from compact() so the token tables, whose windows
     never reach a billion, are formatted exactly as before. */
  function big(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    return compact(n);
  }

  function totalTokens(modelUsage) {
    var sum = 0;
    Object.keys(modelUsage || {}).forEach(function (m) {
      var u = modelUsage[m];
      sum += (u.inputTokens || 0) + (u.outputTokens || 0) +
        (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0);
    });
    return sum;
  }

  function renderStats(s) {
    els.heat.textContent = '';
    els.figs.textContent = '';

    /* Say why there is nothing rather than drawing an empty grid, which would
       read as months of inactivity instead of a feed that cannot see the
       rollup. */
    var days = (s && Array.isArray(s.dailyActivity)) ? s.dailyActivity : null;
    if (!s || s.unavailable || !days || !days.length) {
      els.statsNote.textContent = (s && s.unavailable)
        ? 'No all-time stats: ' + s.unavailable
        : 'No all-time stats: the feed is not serving a stats block.';
      els.viewStats.classList.add('is-unavailable');
      return;
    }
    els.viewStats.classList.remove('is-unavailable');
    els.statsNote.textContent = '';

    var max = 0, busiest = days[0];
    days.forEach(function (d) {
      if (d.messageCount > max) { max = d.messageCount; busiest = d; }
    });
    var span = dayNumber(days[days.length - 1].date) - dayNumber(days[0].date) + 1;
    els.heatHead.textContent = 'Activity · ' + span + ' days';
    els.heat.appendChild(buildHeatmap(days, max));

    var lastDay = dayNumber(s.lastComputedDate || days[days.length - 1].date);
    var st = streaks(days, lastDay);
    var activeDays = days.filter(function (d) { return d.messageCount > 0; }).length;
    var model = topModel(s.modelUsage);

    [
      ['sessions', num(s.totalSessions)],
      ['messages', num(s.totalMessages)],
      ['active days', activeDays + ' of ' + span],
      ['current streak', st.current + (st.current === 1 ? ' day' : ' days')],
      ['longest streak', st.longest + (st.longest === 1 ? ' day' : ' days')],
      ['busiest day', shortDate(busiest.date) + ' · ' + compact(busiest.messageCount)],
      ['top model', model ? model.replace(/^claude-/, '').replace(/-\d{8}$/, '') : '—'],
      ['tokens', big(totalTokens(s.modelUsage))]
    ].forEach(function (r) { els.figs.appendChild(fig(r[0], r[1])); });
  }

  /* ---------- tokens by model ---------- */

  /* Up to five model families have appeared in this data. Ordered by total
     tokens descending and assigned from this palette, so the biggest
     contributor is always the same colour from one render to the next -
     a legend that reshuffles is worse than no legend. */
  var MODEL_COLOURS = ['m0', 'm1', 'm2', 'm3', 'm4'];

  function shortModel(name) {
    return String(name).replace(/^claude-/, '').replace(/-\d{8}$/, '');
  }

  var CHART_H = 100;      /* user units; the SVG scales to its box */
  var BAR_GAP = 0.18;     /* fraction of a column left as gutter */

  /* Laid out by CALENDAR date like the heatmap, and for the same reason:
     dailyModelTokens is SPARSE - 34 rows across a 39-day span here - so
     indexing by array position puts every bar on the wrong day. A day with no
     row is a real gap and is drawn as one. */
  function buildModelChart(days, models) {
    var first = dayNumber(days[0].date);
    var span = dayNumber(days[days.length - 1].date) - first + 1;
    var byDay = {};
    var max = 0;
    days.forEach(function (d) {
      var total = 0;
      Object.keys(d.tokensByModel).forEach(function (m) { total += d.tokensByModel[m]; });
      byDay[dayNumber(d.date) - first] = d.tokensByModel;
      if (total > max) max = total;
    });

    var w = span;
    var root = svg('svg', {
      viewBox: '0 0 ' + w + ' ' + CHART_H,
      preserveAspectRatio: 'none',
      role: 'img'
    });
    if (!max) return root;

    for (var i = 0; i < span; i++) {
      var row = byDay[i];
      if (!row) continue;              /* a real gap, drawn as one */
      var y = CHART_H;
      /* Stacked in the legend's order so a colour sits in the same place in
         every column. */
      models.forEach(function (m, mi) {
        var v = row[m];
        if (!v) return;
        var h = (v / max) * CHART_H;
        y -= h;
        root.appendChild(svg('rect', {
          x: (i + BAR_GAP / 2).toFixed(3), y: y.toFixed(3),
          width: (1 - BAR_GAP).toFixed(3), height: h.toFixed(3),
          class: 'bar ' + MODEL_COLOURS[mi % MODEL_COLOURS.length]
        }));
      });
    }
    return root;
  }

  function renderModelChart(s) {
    els.modelChart.textContent = '';
    els.modelLegend.textContent = '';

    var days = (s && Array.isArray(s.dailyModelTokens)) ? s.dailyModelTokens : null;
    if (!s || s.unavailable || !days || !days.length) {
      els.modelsNote.textContent = (s && s.unavailable)
        ? 'No per-model history: ' + s.unavailable
        : 'No per-model history: the feed is not serving a stats block.';
      els.viewModels.classList.add('is-unavailable');
      return;
    }
    els.viewModels.classList.remove('is-unavailable');
    els.modelsNote.textContent = '';

    /* Totals decide both the stacking order and the legend order. */
    var totals = {};
    days.forEach(function (d) {
      Object.keys(d.tokensByModel).forEach(function (m) {
        totals[m] = (totals[m] || 0) + d.tokensByModel[m];
      });
    });
    var models = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });

    var span = dayNumber(days[days.length - 1].date) - dayNumber(days[0].date) + 1;
    /* The header already says "Tokens by model", so the heading spends its
       width on the range instead of repeating it. */
    els.modelsHead.textContent = shortDate(days[0].date) + ' – ' +
      shortDate(days[days.length - 1].date) + ' · ' + span + ' days';
    els.modelChart.appendChild(buildModelChart(days, models));

    models.forEach(function (m, i) {
      var row = document.createElement('span');
      row.className = 'lg';
      var sw = document.createElement('i');
      sw.className = 'sw ' + MODEL_COLOURS[i % MODEL_COLOURS.length];
      row.appendChild(sw);
      row.appendChild(cell('span', shortModel(m), 'n'));
      row.appendChild(cell('span', big(totals[m]), 'v'));
      els.modelLegend.appendChild(row);
    });
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
    /* Computed before the badge, which reports it: a live reading can cover
       only one of the two windows. */
    var liveWindows = live ? (live.fiveHour ? 1 : 0) + (live.sevenDay ? 1 : 0) : 0;
    var partial = !!live && liveWindows < 2;

    /* Always say which mode is on screen. Falling back silently makes measured
       token counts look like they came from Anthropic. */
    els.live.textContent = live ? (official.stale ? 'LIVE·' : (partial ? 'LIVE¹' : 'LIVE')) : 'LOCAL';
    els.live.className = live
      ? (official.stale ? 'live is-stale' : (partial ? 'live is-partial' : 'live'))
      : 'live is-local';
    els.live.title = live
      ? (official.stale
          ? ('Anthropic figures from ' + formatStamp(official.staleSince).replace('Updated ', '') +
             ', not refreshed since: ' + (official.error || 'unknown'))
          : (partial
              ? ('Only one of the two windows has an Anthropic figure right now (via ' +
                 (official.source || 'OAuth') + '); the other meter shows measured tokens')
              : ('Utilisation read from Anthropic via ' + (official.source || 'OAuth'))))
      : ('Anthropic figures unavailable: ' + (official.error || 'unknown') +
         ' — showing locally measured tokens');

    /* A live reading can be missing one window: Claude Code drops a window from
       rate_limits once its resets_at passes, and does not restore it until the
       session's next API response. The badge then says LIVE while that meter
       quietly shows measured tokens instead - two different metrics side by
       side with nothing to tell them apart. So each meter says for itself which
       one it is showing, and the badge reports partial cover rather than
       claiming the whole panel is Anthropic's. */
    function markMeter(nameEl, isLive) {
      nameEl.classList.toggle('is-measured', !!live && !isLive);
      nameEl.title = (live && !isLive)
        ? 'Anthropic has no figure for this window right now - showing measured tokens'
        : '';
    }

    var s = data.session || {};
    var st = s.tokens || {};

    if (live && live.fiveHour) {
      els.sessionValue.textContent = live.fiveHour.percent + '% used';
      els.sessionSub.textContent = formatCountdown(live.fiveHour.resetsAt);
    } else {
      els.sessionValue.textContent = compact(st.total) + ' tok';
      els.sessionSub.textContent = s.active ? formatCountdown(s.resetsAt) : 'No active session';
    }
    markMeter(els.sessionName, !!(live && live.fiveHour));
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
    markMeter(els.weeklyName, !!(live && live.sevenDay));
    els.weeklyNote.textContent = num(wt.messages) + ' msgs · ' + compact(wt.output) + ' out';

    var describeWorkflow = function (wf) {
      return wf.project + ' · ' + compact(wf.tokens);
    };
    var describeSubtask = function (task) {
      return (task.model || '') + (task.tokens ? ' · ' + compact(task.tokens) : '');
    };
    /* The project now leads the row, so the meta column carries only the
       message count - repeating the project there would say it twice. */
    var describeSession = function (s) {
      return String(s.messages);
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

    /* Third view: the token breakdown behind the two bars. */
    renderTokens(els.tokSession, st);
    renderTokens(els.tokWeekly, wt);
    renderModels(els.mdlSession, st);
    renderModels(els.mdlWeekly, wt);
    els.tokSessionSub.textContent = s.active
      ? (formatCountdown(s.resetsAt) || '') : 'No active block';
    els.tokWeeklySub.textContent = formatWeekday(w.resetsAt);
    els.tokSessionNote.textContent = 'weighted ' + num(s.usedWeighted) +
      (s.peakWeighted ? ' · peak block ' + compact(s.peakWeighted) : '');
    els.tokWeeklyNote.textContent = 'weighted ' + num(w.usedWeighted);

    renderStats(data.stats);
    renderModelChart(data.stats);

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
    els.viewTokens.classList.toggle('is-active', view === 'tokens');
    els.viewStats.classList.toggle('is-active', view === 'stats');
    els.viewModels.classList.toggle('is-active', view === 'models');
    Array.prototype.forEach.call(document.querySelectorAll('.dots .dot'), function (d) {
      d.classList.toggle('is-active', d.getAttribute('data-view') === view);
    });
    /* Row trimming depends on the box each list actually got, which only
       exists once the view is displayed. */
    if (data) markScrollable();
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
    els.viewTokens = document.querySelector('.view-tokens');
    els.viewStats = document.querySelector('.view-stats');
    els.heat = document.getElementById('heat');
    els.heatHead = document.getElementById('heat-head');
    els.figs = document.getElementById('figs');
    els.statsNote = document.getElementById('stats-note');
    els.viewModels = document.querySelector('.view-models');
    els.modelsHead = document.getElementById('models-head');
    els.modelChart = document.getElementById('model-chart');
    els.modelLegend = document.getElementById('model-legend');
    els.modelsNote = document.getElementById('models-note');
    els.tokSession = document.getElementById('tok-session');
    els.tokWeekly = document.getElementById('tok-weekly');
    els.mdlSession = document.getElementById('mdl-session');
    els.mdlWeekly = document.getElementById('mdl-weekly');
    els.tokSessionSub = document.getElementById('tok-session-sub');
    els.tokWeeklySub = document.getElementById('tok-weekly-sub');
    els.tokSessionNote = document.getElementById('tok-session-note');
    els.tokWeeklyNote = document.getElementById('tok-weekly-note');
    els.sessionName = document.querySelector('#m-session .name');
    els.weeklyName = document.querySelector('#m-weekly .name');
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
