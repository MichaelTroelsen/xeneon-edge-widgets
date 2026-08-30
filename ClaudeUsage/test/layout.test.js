#!/usr/bin/env node
/* Tests what the widget LOOKS like, not what it is made of.
 *
 * ClaudeUsage had no test directory at all before this file. Modelled on
 * C64Weather/test/layout.test.js, which found the seam this file exists for:
 * counting DOM nodes or reading the stylesheet cannot see that a run of text
 * no longer fits its column, or that a box has quietly grown past its parent.
 * Both of those are invisible to every other kind of check and to a
 * screenshot glanced at, and both throw nothing.
 *
 * The widget puts four views behind one page and cycles them by TAP (pointer
 * events on `document`, not a click on any one element), and it has a second
 * failure shape C64Weather does not: a stats view that swaps between a real
 * grid and a text-only "unavailable" note depending on what the feed sends.
 * So this file measures four things:
 *
 *   OVERFLOW     no element's box extends outside .widget-root, in any of
 *                the four views - except a descendant of one of the two
 *                deliberately-scrolling containers (.cols .col, .list ul),
 *                whose content is SUPPOSED to run past its own clipped box.
 *                The scroller itself is still checked: it has no scrolling
 *                ancestor of its own, so it is measured like everything else.
 *   ELLIPSIS     no .fig .v (an all-time-stats headline figure) is rendered
 *                narrower than its own text - that column is sized for a
 *                "six-figure message count" (see the comment on .figs in
 *                ClaudeUsage.css) and is never supposed to truncate, unlike
 *                the list-row labels and table cells, which are DESIGNED to
 *                ellipsis when a project name or session label is long and
 *                are not checked here.
 *   AVAILABILITY stats.unavailable and a feed with no stats block at all both
 *                collapse the grid (`.stats { display: none }`) and show the
 *                reason instead, rather than an empty heatmap that would read
 *                as months of silence.
 *   the boot     window.innerWidth/innerHeight are asserted to be 840x344 on
 *                the way, not assumed - see "the slot" below.
 *
 * Chrome is driven headless with --window-size and --dump-dom, per the
 * "Verifying a layout" section of README.md, and four calibrations already
 * paid for there are carried in rather than rediscovered:
 *
 *   1. --window-size means something different to --dump-dom than to
 *      --screenshot (it is the WINDOW, and headless Chrome's chrome eats part
 *      of it), so the slot is found by asking a blank page how big it came
 *      out and correcting until the viewport is exactly 840x344 - not by
 *      hard-coding a deficit that is Chrome-version-dependent.
 *   2. window.innerWidth read during load is the PRE-resize size in
 *      --screenshot mode; --dump-dom does not have that trap, but the 840x344
 *      assertion below is kept anyway so a harness that drifts fails loudly
 *      instead of reporting on a slot that was never rendered.
 *   3. CSS transitions do not advance under --virtual-time-budget, and
 *      --force-prefers-reduced-motion does not fix it - getComputedStyle then
 *      returns the colour a transitioning property had BEFORE the change,
 *      which is what made this exact widget's view-indicator dot look stuck
 *      on the first view when it was in fact correct. `* { transition: none
 *      !important }` is injected into every page this file renders.
 *   4. a `node ... &` backgrounded from one shell survives `kill %1` run from
 *      another - not a risk here (nothing is backgrounded), noted because it
 *      is the fourth calibration and easy to lose track of.
 *
 * Usage:  node ClaudeUsage/test/layout.test.js
 *         CHROME_PATH=/path/to/chrome node ClaudeUsage/test/layout.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WIDTH = 840;
const HEIGHT = 344;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function fail(line) {
  failures++;
  console.log(`  FAIL  ${line}`);
}

/* ------------------------------------------------- source files, unmodified */

/* Hashed before anything below touches a temp copy of the tree, and again at
   the very end, so "the mutation checks only ever wrote into os.tmpdir()" is
   a verified fact rather than an assumption - the repo convention here is to
   hash rather than eyeball. */
function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
const SOURCE_FILES = [
  path.join(ROOT, 'index.html'),
  path.join(ROOT, 'scripts', 'widget.js'),
  path.join(ROOT, 'styles', 'ClaudeUsage.css')
];
const sourceHashesBefore = SOURCE_FILES.map(hashFile);

/* ------------------------------------------------------- metrics, not guesses */

/* The tap-to-view mapping below depends on VIEWS starting with 'usage' and
   being exactly these four in this order; read out of widget.js rather than
   copied, so a reordering here fails loudly instead of silently mismeasuring
   the wrong view. */
const widgetSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'widget.js'), 'utf8');

function extractArray(src, varName) {
  const m = src.match(new RegExp('var ' + varName + ' = \\[([^\\]]*)\\]'));
  if (!m) return null;
  try { return JSON.parse('[' + m[1].replace(/'/g, '"') + ']'); }
  catch (e) { return null; }
}
function extractString(src, varName) {
  const m = src.match(new RegExp('var ' + varName + ' = \'([^\']*)\''));
  return m ? m[1] : null;
}

const VIEWS = extractArray(widgetSrc, 'VIEWS');
const START_VIEW = extractString(widgetSrc, 'view');

console.log('metrics:');
check('VIEWS was read out of widget.js', VIEWS, ['usage', 'detail', 'tokens', 'stats', 'models']);
check('the widget starts on the "usage" view', START_VIEW, 'usage');
if (failures) {
  console.log('\nthe source constants could not be read; every tap count below would be aimed at the wrong view');
  console.log(`${failures} FAILED`);
  process.exit(1);
}

/* --------------------------------------------------------------- tolerances */

/* Subpixel layout-grid snapping, same reasoning and same size as
   C64Weather/test/layout.test.js: real defects are tens of percent or whole
   pixels, not fractions of one. */
const OVERFLOW_EPS_PX = 1;
const ELLIPSIS_EPS_PX = 1;

/* --------------------------------------------------------------- find chrome */

function findChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['LOCALAPPDATA']
    ].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium');
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* next */ }
  }
  return null;
}

const CHROME = findChrome();
console.log('browser:');
check('a chrome-family browser was found', CHROME !== null, true);
if (!CHROME) {
  console.log('        set CHROME_PATH to a chrome/chromium binary.');
  console.log('        a render test that cannot render is not a passing render test.');
  console.log('\n1 FAILED');
  process.exit(1);
}
console.log(`  note  using ${CHROME}`);

/* ------------------------------------------------------------ the page harness */

/* Copied out of the repo, like C64Weather, so nothing below ever writes into
   a tracked file - the mutation checks scribble on this copy only. */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeusage-layout-'));
const PAGES = path.join(WORK, 'widget');
const PROFILE = path.join(WORK, 'chrome-profile');
fs.cpSync(ROOT, PAGES, {
  recursive: true,
  filter: src => !src.split(/[\\/]/).includes('test')
});

function fileUrl(p) {
  return 'file:///' + encodeURI(path.resolve(p).replace(/\\/g, '/'));
}

/* --------------------------------------------------------------- fixtures */

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function addDaysISO(startISO, days) {
  const p = startISO.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/* A wide, sparse span - the shape buildHeatmap() is written for (a row only
   for a day that had activity), not a solid block. One day is pushed into six
   figures on purpose: that is the exact worst case the .figs comment in
   ClaudeUsage.css names ("a six-figure message count"), so this fixture
   exercises the real ceiling the layout was designed against, not an
   arbitrary one. */
const STATS_DAYS = 96;
function buildDailyActivity() {
  const days = [];
  for (let i = 0; i < STATS_DAYS; i++) {
    let count = (i % 3 === 0) ? 0 : ((i * 53 + 7) % 480) + 4;
    days.push({ date: addDaysISO('2026-01-01', i), messageCount: count });
  }
  days[50].messageCount = 128743; /* the six-figure day */
  return days;
}

const PROJECTS = [
  'icue-widgets', 'claude-code-internal-tooling',
  'xeneon-edge-firmware-bridge', 'usage-server-stats-rollup',
  'c64weather-petscii-glyphset'
];
const ROW_STATES = ['running', 'in_progress', 'queued', 'done', 'blocked', 'failed'];
const MODEL_A = 'claude-opus-4-1-20250805';
const MODEL_B = 'claude-sonnet-4-5-20250929';

function buildRows(n, prefix, withModel) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = {
      project: PROJECTS[i % PROJECTS.length],
      label: prefix + ' task ' + (i + 1) + ' - a moderately long description of the work being done, long enough to test the ellipsis',
      state: ROW_STATES[i % ROW_STATES.length],
      tokens: 1000 + i * 3771,
      messages: 3 + (i % 40)
    };
    if (withModel) row.model = (i % 2 === 0) ? MODEL_A : MODEL_B;
    rows.push(row);
  }
  return rows;
}

function tokenBlock(total, output, cacheCreation, cacheRead, input, messages) {
  return {
    total, output, cacheCreation, cacheRead, input, messages,
    byModel: {
      [MODEL_A]: { messages: Math.round(messages * 0.3), output: Math.round(output * 0.6) },
      [MODEL_B]: { messages: Math.round(messages * 0.7), output: Math.round(output * 0.4) }
    }
  };
}

/* Two models sized so their total lands right at the number the ClaudeUsage.css
   comment on .figs and the big()/compact() split in widget.js were both
   written against: "44534.5M" is what compact() would print for this exact
   total, which is why big() exists (it prints "44.5B" instead). Using the
   documented value ties the fixture to the source instead of inventing one. */
function buildStatsModelUsage() {
  return {
    [MODEL_A]: {
      outputTokens: 18000000000, inputTokens: 900000000,
      cacheReadInputTokens: 20000000000, cacheCreationInputTokens: 3000000000
    },
    [MODEL_B]: {
      outputTokens: 1500000000, inputTokens: 134500000,
      cacheReadInputTokens: 900000000, cacheCreationInputTokens: 100000000
    }
  };
}

function baseFixture() {
  const now = Date.now();
  return {
    plan: 'Max 20x',
    generatedAt: now,
    official: {
      ok: true,
      fiveHour: { percent: 62, resetsAt: now + 2 * 3600000 + 14 * 60000 },
      sevenDay: { percent: 81, resetsAt: now + 3 * 86400000 },
      source: 'OAuth'
    },
    session: {
      active: true,
      resetsAt: now + 2 * 3600000,
      peakWeighted: 480000,
      usedWeighted: 210000,
      tokens: tokenBlock(1842650, 342650, 100000, 1300000, 100000, 428)
    },
    weekly: {
      resetsAt: now + 4 * 86400000,
      tokens: tokenBlock(9304221, 1804221, 900000, 6200000, 400000, 2431)
    },
    workflows: buildRows(12, 'workflow'),
    subtasks: buildRows(18, 'subtask', true),
    sessions: buildRows(9, 'session'),
    counts: { queued: 17 },
    stats: null /* filled in per-fixture below */
  };
}

function fullStatsFixture() {
  const f = baseFixture();
  const days = buildDailyActivity();
  f.stats = {
    dailyActivity: days,
    lastComputedDate: days[days.length - 1].date,
    totalSessions: 128456,
    totalMessages: days.reduce((n, d) => n + d.messageCount, 0),
    modelUsage: buildStatsModelUsage()
  };
  return f;
}
function unavailableStatsFixture() {
  const f = baseFixture();
  f.stats = { unavailable: 'stats-cache.json unreadable: ENOENT' };
  return f;
}
function missingStatsFixture() {
  const f = baseFixture();
  delete f.stats;
  return f;
}

/* ------------------------------------------- the reading is not Anthropic's own

   The three fallback states. The widget badges all three (LOCAL / LIVE· /
   LIVE¹) and used to put the REASON in the badge's title attribute only - and
   a title needs a cursor to hover, which the Xeneon Edge does not have, so on
   the device the reason could not be read in any of them. The checks below
   measure the reason as RENDERED TEXT, never as an attribute.

   The error string is a real one in shape: usage-server/official.js joins each
   credential's failure with ' | ' (fetchOfficial) and server.js appends the
   statusline hint with ' · ' (withHint), so a genuine one runs to a couple of
   hundred characters and cannot be made to fit one line of an 840px slot. That
   is the point: the fix has to make a LONG reason readable, not a short one. */
const LONG_ERROR =
  'credentials file: access token expired 2026-08-30T09:14:02.000Z (HTTP 401 Unauthorized)' +
  ' | CLAUDE_CODE_OAUTH_TOKEN: HTTP 429 Too Many Requests' +
  ' · a Claude Code session is active but statusline-tee.json does not exist -' +
  ' statusline-tee.js is probably not wired into statusLine.command';

function localFixture() {
  const f = fullStatsFixture();
  f.official = { ok: false, error: LONG_ERROR };
  return f;
}
function staleFixture() {
  const f = fullStatsFixture();
  f.official = Object.assign({}, f.official, {
    ok: false, stale: true, staleSince: f.generatedAt - 15 * 60000, error: LONG_ERROR
  });
  return f;
}
function partialFixture() {
  const f = fullStatsFixture();
  f.official = Object.assign({}, f.official);
  delete f.official.sevenDay;
  return f;
}

/* --------------------------------------------------------------- the harness */

/* Runs before scripts/widget.js (inserted ahead of its <script> tag), so
   window.fetch is stubbed before the widget's own boot sequence calls it. One
   JSON body answers every request: the widget only ever calls one URL. */
const HARNESS = `<script>
window.__FIXTURE__ = __PAYLOAD__;
(function () {
  var style = document.createElement('style');
  /* Calibration 3: transitions do not advance under --virtual-time-budget, and
     getComputedStyle then reports the pre-change value. Nothing here reads a
     transitioning colour, but geometry can still be mid-animation (the meter
     fill's width transitions), so this is unconditional rather than scoped. */
  style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(style);

  window.fetch = function () {
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(window.__FIXTURE__); }
    });
  };

  function pathOf(el, stop) {
    var parts = [];
    while (el && el !== stop) {
      var seg = el.tagName.toLowerCase();
      if (el.id) {
        seg += '#' + el.id;
      } else {
        var cls = (el.getAttribute('class') || '').trim();
        if (cls) seg += '.' + cls.split(/\\s+/).join('.');
      }
      var i = 1, s = el;
      while (s.previousElementSibling) { s = s.previousElementSibling; i++; }
      if (el.parentElement && el.parentElement.children.length > 1) seg += ':nth-child(' + i + ')';
      parts.unshift(seg);
      el = el.parentElement;
    }
    return '.widget-root > ' + parts.join(' > ');
  }

  /* The widget cycles views by tapping anywhere on the document - pointerdown
     then pointerup within TAP_SLOP_PX and TAP_MAX_MS, not a click on any one
     element - so that is what is dispatched here rather than calling into the
     widget's internals. */
  function tap() {
    var opts = { clientX: 4, clientY: 4, bubbles: true, cancelable: true };
    document.dispatchEvent(new PointerEvent('pointerdown', opts));
    document.dispatchEvent(new PointerEvent('pointerup', opts));
  }

  function measure() {
    var out = {
      taps: __TAPS__, overflow: [], figs: [], notes: [],
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
    var root = document.querySelector('.widget-root');
    if (!root) { out.notes.push('no .widget-root in the page'); return out; }
    var rr = root.getBoundingClientRect();
    out.root = { width: rr.width, height: rr.height };

    /* ClaudeUsage.css puts overflow-y:auto on exactly two selectors (.cols
       .col and .list ul) to make long tables/lists scroll instead of being
       trimmed. Content inside one of those is SUPPOSED to extend past its
       own box - that is what a scroller is - so it must not be measured
       against .widget-root at all. The scroller element itself still must:
       walking up from it finds no scrolling ancestor of its own (nothing
       here nests scrollers), so it is measured normally through the same
       loop below. This is the "skip descendants of scrollers, assert the
       scroller itself" choice, not the "measure against the nearest
       scrolling ancestor's box" one - the widget has no case where a
       scroller's content has its own overflow limit narrower than
       .widget-root, so there is nothing for that second box to catch here. */
    function scrollingAncestor(el) {
      var p = el.parentElement;
      while (p) {
        var pcs = window.getComputedStyle(p);
        if (pcs.overflowY === 'auto' || pcs.overflowY === 'scroll') return p;
        if (p === root) break;
        p = p.parentElement;
      }
      return null;
    }

    var all = root.querySelectorAll('*');
    for (var n = 0; n < all.length; n++) {
      var el = all[n];
      /* Geometry inside an <svg> (the heatmap's cells and weekday labels) is
         clipped to its own viewport, so it cannot leave .widget-root without
         the <svg> root leaving first - which is still measured. */
      if (el.ownerSVGElement) continue;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (scrollingAncestor(el)) continue;

      var over = {
        left: rr.left - r.left, top: rr.top - r.top,
        right: r.right - rr.right, bottom: r.bottom - rr.bottom
      };
      var worst = Math.max(over.left, over.top, over.right, over.bottom);
      if (worst > 0) {
        out.overflow.push({ path: pathOf(el, root), by: worst, sides: over,
                            width: r.width, height: r.height });
      }
      if (!out.tightest || worst > out.tightest.by) {
        out.tightest = { path: pathOf(el, root), by: worst };
      }

      /* Only the eight all-time-stats figures (.fig > .v) are checked for
         ellipsis - see the file header for why list/table labels are exempt. */
      if (el.tagName.toLowerCase() === 'span' && el.classList.contains('v') &&
          el.parentElement && el.parentElement.classList.contains('fig')) {
        out.figs.push({
          path: pathOf(el, root), text: el.textContent,
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth
        });
      }
    }

    /* Why-this-is-not-live. Captured as three separate things on purpose:
       what the badge SAYS (the state, which was never the problem), what the
       badge's title holds (the desktop-only affordance, which must not be
       regressed but proves nothing about the device), and what is actually
       RENDERED - text in the page, in a box with a size, inside .widget-root.
       Only the third of those can be read on a screen with no cursor. */
    var badge = document.getElementById('live');
    out.badgeText = badge ? badge.textContent : null;
    out.badgeTitle = badge ? badge.getAttribute('title') : null;
    var why = document.getElementById('why');
    var whyWrap = document.getElementById('why-wrap');
    if (why && whyWrap) {
      var wcs = window.getComputedStyle(whyWrap);
      var wr = why.getBoundingClientRect();
      out.why = {
        /* U+200B is inserted between the pieces of an over-long token so the
           line can break BETWEEN spans and never inside one; it is not part of
           the message, so it comes out before anything is compared. */
        text: why.textContent.replace(/\\u200b/g, ''),
        spans: why.children.length,
        wrapDisplay: wcs.display,
        clientHeight: why.clientHeight,
        scrollHeight: why.scrollHeight,
        onScreen: wcs.display !== 'none' && wcs.visibility !== 'hidden' &&
          why.clientHeight > 0 && wr.width > 0 &&
          wr.top >= rr.top - 0.5 && wr.bottom <= rr.bottom + 0.5 &&
          wr.left >= rr.left - 0.5 && wr.right <= rr.right + 0.5
      };
    } else {
      out.why = null;
    }

    /* The strip is not free: it takes its line out of the usage view's body,
       and the meters are what is left. .widget-root has 21.5px of padding, so
       a meter squeezed out of its own box does NOT reach outside the widget
       and the overflow check above cannot see it - these three edges can.
       MEASURED at 840x344 in the LOCAL state: the weekly note ends at 293.3,
       .meters ends at 303.3, the strip starts at 305.8. */
    function edgesOf(sel) {
      var e = document.querySelector(sel);
      if (!e) return null;
      var cs2 = window.getComputedStyle(e);
      if (cs2.display === 'none') return null;
      var b = e.getBoundingClientRect();
      return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1) };
    }
    out.usage = {
      meters: edgesOf('.view-usage .meters'),
      weeklyNote: edgesOf('#weekly-note'),
      whyWrap: edgesOf('#why-wrap')
    };

    var errorHintEl = document.getElementById('error-hint');
    var errorStateEl = document.querySelector('.error-state');
    out.errorHintText = errorHintEl ? errorHintEl.textContent : null;
    out.errorStateVisible = errorStateEl ?
      window.getComputedStyle(errorStateEl).display !== 'none' : null;

    var activeView = document.querySelector('.view.is-active');
    out.activeViewClasses = activeView ? activeView.getAttribute('class') : null;
    var activeDot = document.querySelector('.dots .dot.is-active');
    out.activeDotView = activeDot ? activeDot.getAttribute('data-view') : null;

    var viewStats = document.querySelector('.view-stats');
    out.statsUnavailable = viewStats ? viewStats.classList.contains('is-unavailable') : null;
    var statsGrid = document.querySelector('.stats');
    var statsNote = document.querySelector('.stats-note');
    out.statsGridDisplay = statsGrid ? window.getComputedStyle(statsGrid).display : null;
    out.statsNoteDisplay = statsNote ? window.getComputedStyle(statsNote).display : null;
    out.statsNoteText = statsNote ? statsNote.textContent : null;

    return out;
  }

  setTimeout(function () {
    for (var i = 0; i < __TAPS__; i++) tap();
    setTimeout(function () {
      var payload;
      try { payload = JSON.stringify(measure()); }
      catch (e) { payload = JSON.stringify({ notes: ['measure threw: ' + e] }); }
      document.documentElement.setAttribute('data-layout', encodeURIComponent(payload));
    }, __POST_TAP_MS__);
  }, __PRE_TAP_MS__);
})();
</script>
`;

const SCRIPT_TAG = '<script type="text/javascript" src="scripts/widget.js"></script>';
const indexSrc = fs.readFileSync(path.join(PAGES, 'index.html'), 'utf8');
check('the widget script tag was found, so the harness has somewhere to go',
  indexSrc.includes(SCRIPT_TAG), true);

const PRE_TAP_MS = 200;   /* time for the stubbed fetch's microtask chain and first render */
const POST_TAP_MS = 150;  /* time for the tap(s) to be handled and the DOM to settle */

function writePage(name, taps, fixture, mutate) {
  const payloadJson = JSON.stringify(fixture).replace(/<\/script/gi, '<\\/script');
  let html = indexSrc.replace(SCRIPT_TAG, HARNESS
    .replace('__PAYLOAD__', payloadJson)
    .replace(/__TAPS__/g, String(taps))
    .replace('__PRE_TAP_MS__', String(PRE_TAP_MS))
    .replace('__POST_TAP_MS__', String(POST_TAP_MS)) + SCRIPT_TAG);
  if (mutate) html = mutate(html);
  const p = path.join(PAGES, name + '.html');
  fs.writeFileSync(p, html);
  return p;
}

/* Same page, but the stubbed fetch answers a non-2xx with a JSON body
   carrying an `error` string - the three-state /health contract's boot-order
   case (server up, no snapshot yet / every rebuild failed). Used to prove the
   widget surfaces THAT string rather than its fixed "start the server" hint. */
const FETCH_STUB_OK = 'ok: true, status: 200,\n      json: function () { return Promise.resolve(window.__FIXTURE__); }';
function writeErrorBodyPage(name, status, errorText, srcMutate) {
  const stub = 'ok: false, status: ' + status +
    ',\n      json: function () { return Promise.resolve(' + JSON.stringify({ error: errorText }) + '); }';
  const htmlMutate = html => {
    if (!html.includes(FETCH_STUB_OK)) {
      fail(`${name}: the fetch stub text moved, so the error-body substitution matched nothing`);
    }
    return html.replace(FETCH_STUB_OK, stub);
  };
  if (srcMutate) return writePageWithMutatedScript(name, 0, FULL, srcMutate, htmlMutate);
  return writePage(name, 0, FULL, htmlMutate);
}

/* Same page, but with widget.js INLINED and its source put through srcMutate
   first. A CSS override can only break how a thing looks; some of the
   mutations below have to break what the widget DOES - "set the title but
   never put the reason in the page" is the exact pre-fix behaviour and cannot
   be expressed as a stylesheet. Reads its copy out of the temp tree and writes
   only into the temp tree; the hash check at the end of this file proves the
   repo's own widget.js was never touched. */
function writePageWithMutatedScript(name, taps, fixture, srcMutate, htmlMutate) {
  const src = fs.readFileSync(path.join(PAGES, 'scripts', 'widget.js'), 'utf8');
  const mutated = srcMutate(src);
  if (mutated === src) {
    fail(`${name}: the source mutation matched nothing, so it would have tested a clean build`);
  }
  /* Function form: a `$` in the widget's source would otherwise be read as a
     replacement pattern by String.replace. */
  const inlined = '<script type="text/javascript">' +
    mutated.replace(/<\/script/gi, '<\\/script') + '</scr' + 'ipt>';
  return writePage(name, taps, fixture, html => {
    const withScript = html.replace(SCRIPT_TAG, () => inlined);
    return htmlMutate ? htmlMutate(withScript) : withScript;
  });
}

let winW = WIDTH, winH = HEIGHT;

function render(page) {
  const budget = PRE_TAP_MS + POST_TAP_MS + 800;
  const args = [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--force-device-scale-factor=1',
    `--user-data-dir=${PROFILE}`,
    `--window-size=${winW},${winH}`,
    `--virtual-time-budget=${budget}`,
    '--dump-dom',
    fileUrl(page)
  ];
  const res = spawnSync(CHROME, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { error: String(res.error) };
  const dom = res.stdout || '';
  const m = dom.match(/data-layout="([^"]*)"/);
  if (!m) return { error: 'no data-layout in the dumped DOM (the page never measured itself)' };
  try {
    return JSON.parse(decodeURIComponent(m[1]));
  } catch (e) {
    return { error: 'data-layout did not parse: ' + e };
  }
}

/* ------------------------------------------------------------- calibrate the slot */

const CALIBRATE = path.join(PAGES, 'calibrate.html');
fs.writeFileSync(CALIBRATE,
  '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  '<style>html,body{margin:0;padding:0;overflow:hidden}</style></head><body><script>' +
  'document.documentElement.setAttribute("data-layout", encodeURIComponent(JSON.stringify(' +
  '{viewport:{width:window.innerWidth,height:window.innerHeight}})));' +
  '</scr' + 'ipt></body></html>');

console.log('slot:');
let seen = null;
for (let i = 0; i < 4; i++) {
  const probe = render(CALIBRATE);
  if (probe.error) { seen = probe; break; }
  seen = probe.viewport;
  if (seen.width === WIDTH && seen.height === HEIGHT) break;
  winW += WIDTH - seen.width;
  winH += HEIGHT - seen.height;
}
check('the viewport can be driven to exactly 840x344',
  seen && seen.width === WIDTH && seen.height === HEIGHT, true);
if (!(seen && seen.width === WIDTH && seen.height === HEIGHT)) {
  console.log(`        best the browser would give: ${JSON.stringify(seen)}`);
  console.log('        measuring a widget in the wrong slot proves nothing, so stopping here');
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log(`  note  --window-size=${winW},${winH} yields an ${WIDTH}x${HEIGHT} viewport`);

/* ------------------------------------------------------------------ the renders */

console.log('renders:');
const FULL = fullStatsFixture();
const UNAVAILABLE = unavailableStatsFixture();
const MISSING = missingStatsFixture();

const results = [];
VIEWS.forEach((name, idx) => {
  const page = writePage('view-' + name, idx, FULL);
  const r = render(page);
  r.name = 'view-' + name;
  r.wantView = name;
  results.push(r);
  if (r.error) fail(`${r.name}: ${r.error}`);
});
[
  { name: 'stats-unavailable', fixture: UNAVAILABLE },
  { name: 'stats-missing-block', fixture: MISSING }
].forEach(({ name, fixture }) => {
  const page = writePage(name, VIEWS.indexOf('stats'), fixture);
  const r = render(page);
  r.name = name;
  r.wantView = 'stats';
  results.push(r);
  if (r.error) fail(`${name}: ${r.error}`);
});
/* The four states of the live/local badge, all on the usage view (0 taps) -
   the view that carries the meters whose meaning changes. They join `results`
   so the overflow and headroom measurements below cover them too: the reason
   strip is the newest thing competing for the tightest slot in the widget. */
const WHY_STATES = [
  { name: 'why-live', fixture: FULL },
  { name: 'why-local', fixture: localFixture() },
  { name: 'why-stale', fixture: staleFixture() },
  { name: 'why-partial', fixture: partialFixture() }
];
WHY_STATES.forEach(({ name, fixture }) => {
  const page = writePage(name, VIEWS.indexOf('usage'), fixture);
  const r = render(page);
  r.name = name;
  r.wantView = 'usage';
  results.push(r);
  if (r.error) fail(`${name}: ${r.error}`);
});

/* The feed's own error, boot-order case: server up, no snapshot / every
   rebuild failed, answered as a 503 with { error: '...' }. The rendered hint
   must contain that text and must NOT contain the fixed "Start it with"
   advice - the server IS running, so that advice is wrong. */
const FEED_ERROR_TEXT = 'no snapshot has ever been built: rebuild threw TypeError at line 12';
const feedErrorPage = writeErrorBodyPage('feed-error-body', 503, FEED_ERROR_TEXT);
const feedErrorResult = render(feedErrorPage);
if (feedErrorResult.error) fail(`feed-error-body: ${feedErrorResult.error}`);
check('a 503 with an error body is shown as error-state',
  feedErrorResult.errorStateVisible, true);
check('the rendered hint contains the feed\'s own error text',
  (feedErrorResult.errorHintText || '').includes(FEED_ERROR_TEXT), true);
check('the rendered hint does NOT carry the fixed start-the-server advice',
  (feedErrorResult.errorHintText || '').includes('Start it with'), false);

/* Mutation check: restore the discard ("if (!res.ok) throw new Error('HTTP '
   + res.status)", the pre-fix line) and confirm the same fixture now DOES
   show the fixed hint and DOES NOT show the feed's own text - i.e. this
   assertion actually fires rather than passing vacuously. */
const mutatedFeedErrorPage = writeErrorBodyPage('feed-error-body-mutated', 503, FEED_ERROR_TEXT, src => {
  const needle = "if (!res.ok) {\n          /* The feed answers a non-2xx with a JSON body carrying the real\n             cause (the three-state /health contract) - read it before\n             throwing, rather than discarding the body and falling back to\n             a fixed \"start the server\" hint that is wrong when the server\n             IS running but has no snapshot yet, or every rebuild failed. */\n          return res.json().catch(function () { return null; }).then(function (body) {\n            var err = new Error('HTTP ' + res.status);\n            if (body && typeof body.error === 'string' && body.error) {\n              err.message = body.error;\n              err.fromResponseBody = true;\n            }\n            throw err;\n          });\n        }";
  return src.replace(needle, "if (!res.ok) throw new Error('HTTP ' + res.status);");
});
const mutatedResult = render(mutatedFeedErrorPage);
if (mutatedResult.error) fail(`feed-error-body-mutated: ${mutatedResult.error}`);
const mutationCaught =
  !(mutatedResult.errorHintText || '').includes(FEED_ERROR_TEXT) &&
  (mutatedResult.errorHintText || '').includes('Start it with');
check('mutation check: restoring the body-discard brings back the fixed hint (the new assertions above would have failed against it)',
  mutationCaught, true);

const ok = results.filter(r => !r.error);
check('every render came back', ok.length, results.length);
if (!ok.length) {
  console.log('\nnothing rendered, so nothing below was tested');
  console.log(`${failures} FAILED`);
  process.exit(1);
}

/* --------------------------------------------------------- the renders are real */

console.log('the captures are of what they claim to be:');
check('window.innerWidth/innerHeight were 840x344 for every render',
  ok.filter(r => !r.viewport || r.viewport.width !== WIDTH || r.viewport.height !== HEIGHT)
    .map(r => `${r.name} ${r.viewport ? r.viewport.width + 'x' + r.viewport.height : 'unknown'}`), []);
check('.widget-root was measured at a real size, not a collapsed one',
  ok.filter(r => !(r.root && r.root.width > 700 && r.root.height > 200)).map(r => r.name), []);
check('the tap sequence landed on the view it was aimed at',
  ok.filter(r => r.activeDotView !== r.wantView ||
    !String(r.activeViewClasses).split(/\s+/).includes('view-' + r.wantView) ||
    !String(r.activeViewClasses).split(/\s+/).includes('is-active'))
    .map(r => `${r.name}: dot=${r.activeDotView} class=${r.activeViewClasses}`), []);
const noted = ok.flatMap(r => r.notes.map(n => `${r.name}: ${n}`));
check('no render reported an unreadable box', noted, []);

const statsRender = ok.find(r => r.name === 'view-stats');
check('the stats view produced all eight headline figures to measure',
  statsRender ? statsRender.figs.length : -1, 8);

/* ------------------------------------------------------------------- overflow */

function overflowsIn(r) {
  return (r.overflow || []).filter(o => o.by > OVERFLOW_EPS_PX);
}

console.log('overflow — nothing reaches outside .widget-root:');
{
  let bad = 0;
  for (const r of ok) {
    for (const o of overflowsIn(r)) {
      bad++;
      const side = ['left', 'top', 'right', 'bottom']
        .filter(s => o.sides[s] > OVERFLOW_EPS_PX).join('/');
      fail(`${r.name}: ${o.path} is ${o.by.toFixed(1)}px past the ${side} of .widget-root` +
        ` (its box is ${o.width.toFixed(1)}x${o.height.toFixed(1)})`);
    }
  }
  if (!bad) console.log(`  pass  every box in all ${ok.length} renders is inside .widget-root`);
  const tight = ok.filter(r => r.tightest).sort((a, b) => b.tightest.by - a.tightest.by)[0];
  if (tight) {
    console.log(`  note  tightest fit: ${tight.name} ${tight.tightest.path}` +
      `, ${(-tight.tightest.by).toFixed(1)}px of headroom`);
  }
}

/* -------------------------------------------------------------------- ellipsis */

function ellipsisedFigsIn(r) {
  return (r.figs || []).filter(f => (f.scrollWidth - f.clientWidth) > ELLIPSIS_EPS_PX);
}

console.log('ellipsis — no all-time-stats figure is truncated:');
{
  let bad = 0;
  for (const r of ok) {
    for (const f of ellipsisedFigsIn(r)) {
      bad++;
      fail(`${r.name}: ${f.path} ("${f.text}") is ${f.scrollWidth}px of text in a ${f.clientWidth}px box`);
    }
  }
  if (!bad) console.log(`  pass  every .fig .v in all ${ok.length} renders shows its full text`);
}

/* -------------------------------------------------------------- stats availability */

console.log('stats availability — the grid and the reason never show together:');
{
  const full = ok.find(r => r.name === 'view-stats');
  if (full) {
    check('with a real stats block, the grid is shown', full.statsGridDisplay, 'flex');
    check('with a real stats block, .is-unavailable is not set', full.statsUnavailable, false);
    check('with a real stats block, the note is hidden', full.statsNoteDisplay, 'none');
  } else {
    fail('view-stats did not render, so availability could not be checked against it');
  }
  for (const name of ['stats-unavailable', 'stats-missing-block']) {
    const r = ok.find(x => x.name === name);
    if (!r) { fail(`${name} did not render`); continue; }
    check(`${name}: the grid is display:none`, r.statsGridDisplay, 'none');
    check(`${name}: .is-unavailable is set`, r.statsUnavailable, true);
    check(`${name}: the note is shown`, r.statsNoteDisplay, 'block');
    check(`${name}: the note names a reason`, typeof r.statsNoteText === 'string' &&
      r.statsNoteText.indexOf('No all-time stats') === 0, true);
  }
}

/* ------------------------------------- why a reading is not Anthropic's own

   THE DEVICE HAS NO CURSOR. Confirmed with the touch-drag finding on the
   Xeneon Edge on 2026-08-30: the webview forwards taps, there is no pointer,
   and :hover never fires - so a `title` attribute renders for nobody. The
   badge already carried the STATE (LIVE / LIVE· / LIVE¹ / LOCAL); the REASON
   lived only in that title and was therefore unreadable on the hardware in
   every one of the three fallback states.

   So every check here is against RENDERED TEXT in a box with a size, inside
   .widget-root. `badgeTitle` is asserted separately and only to prove the
   desktop affordance was not thrown away - it is never accepted as the
   reason being conveyed. */

console.log('the reason a reading is not live is on screen, not in a tooltip:');
{
  const byName = {};
  ok.forEach(r => { byName[r.name] = r; });

  const EXPECT = {
    'why-live': { badge: 'LIVE', shown: false, must: null },
    'why-local': { badge: 'LOCAL', shown: true, must: LONG_ERROR },
    'why-stale': { badge: 'LIVE·', shown: true, must: LONG_ERROR },
    'why-partial': { badge: 'LIVE¹', shown: true, must: 'the other meter shows measured tokens' }
  };

  Object.keys(EXPECT).forEach(name => {
    const r = byName[name];
    const e = EXPECT[name];
    if (!r) { fail(`${name} did not render, so its fallback state was not checked`); return; }
    check(`${name}: the badge says ${e.badge}`, r.badgeText, e.badge);

    if (!e.shown) {
      /* Fully live: there is nothing to explain, and the strip must be out of
         the layout entirely rather than an empty box taking a line. */
      check(`${name}: no reason strip is rendered`,
        r.why ? { display: r.why.wrapDisplay, height: r.why.clientHeight, text: r.why.text } : null,
        { display: 'none', height: 0, text: '' });
      check(`${name}: the badge still carries a title for a desktop reader`,
        typeof r.badgeTitle === 'string' && r.badgeTitle.length > 0, true);
      return;
    }

    check(`${name}: the reason is IN THE DOM as text, not only in an attribute`,
      r.why ? r.why.text.indexOf(e.must) !== -1 : 'no #why element at all', true);
    check(`${name}: that text is actually visible - a real box, on screen, inside .widget-root`,
      r.why ? r.why.onScreen : false, true);
    /* A strip that renders but shows none of the message is the tooltip bug
       again in a different shape. */
    check(`${name}: at least one whole line of it is showing`,
      !!(r.why && r.why.clientHeight > 0 && r.why.scrollHeight >= r.why.clientHeight), true);
    check(`${name}: the badge's title still holds the same reason for a desktop reader`,
      typeof r.badgeTitle === 'string' && r.badgeTitle.indexOf(e.must) !== -1, true);
    if (r.why) {
      console.log(`        ${name}: ${r.why.clientHeight}px box, ${r.why.scrollHeight}px of text, ` +
        `${r.why.spans} spans — "${r.why.text.slice(0, 64)}${r.why.text.length > 64 ? '…' : ''}"`);
    }
  });

  /* The one fact that makes the strip worth building rather than truncating:
     a real error does not fit, so the paging section below has work to do. */
  const local = byName['why-local'];
  check('a realistic reason genuinely overflows one line, so paging is required',
    local && local.why ? local.why.scrollHeight > local.why.clientHeight : false, true);

  /* And the line it takes must come out of slack, not out of a meter. */
  const squeezed = WHY_STATES.map(s => byName[s.name]).filter(Boolean).filter(r => {
    const u = r.usage;
    if (!u || !u.meters || !u.weeklyNote) return false;
    if (u.weeklyNote.bottom > u.meters.bottom + 0.5) return true;
    return !!(u.whyWrap && u.weeklyNote.bottom > u.whyWrap.top + 0.5);
  }).map(r => `${r.name}: weekly note ends ${r.usage.weeklyNote.bottom}, ` +
    `.meters ends ${r.usage.meters.bottom}` +
    (r.usage.whyWrap ? `, the strip starts ${r.usage.whyWrap.top}` : ''));
  check('the strip is not paid for by squeezing a meter out of its own box', squeezed, []);
  const shownLocal = byName['why-local'];
  if (shownLocal && shownLocal.usage.whyWrap) {
    console.log(`        why-local: weekly note ends ${shownLocal.usage.weeklyNote.bottom}, ` +
      `.meters ends ${shownLocal.usage.meters.bottom}, ` +
      `the strip runs ${shownLocal.usage.whyWrap.top}–${shownLocal.usage.whyWrap.bottom}`);
  }
}

/* ----------------------------------------------------- the assertions can fail */

console.log('the checks are not vacuous:');
{
  /* .meter .name is intentionally ellipsised (a long section label is allowed
     to truncate); forcing it wide and un-clipped is a pure overflow with no
     ellipsis involved, on the usage view where the meters actually render.
     .name is an unshrunk-looking but ordinary flex item (.meter-top is
     display:flex, and .name gets the initial flex-shrink:1) - probed with a
     standalone render, width:300% alone measured at 647.6px, not the ~2343px
     300% implies, because the flex algorithm shrinks it right back down to
     fit .meter-top's 781px alongside .meter .value. That is not a
     specificity loss (the injected rule was winning, verified via
     getComputedStyle), it is flex-shrink quietly absorbing the forced width.
     flex-shrink:0 is required for the mutation to actually widen the box
     instead of being shrunk back to fit. */
  const page = writePage('mutation-overflow', VIEWS.indexOf('usage'), FULL, html =>
    html.replace('</head>',
      '<style>.meter .name { max-width: none !important; width: 300% !important; ' +
      'flex-shrink: 0 !important; white-space: nowrap !important; overflow: visible !important; ' +
      'text-overflow: clip !important; }</style></head>'));
  const r = render(page);
  const found = r.error ? [] : overflowsIn(r);
  check('widening .meter .name past .widget-root trips the overflow check',
    r.error ? `render failed: ${r.error}` : found.length > 0, true);
  if (found.length) console.log(`        caught ${found.length}, worst ${found[0].path} by ${found[0].by.toFixed(1)}px`);
}
{
  /* Shrinking the grid's own columns, not adding a width cap to .fig .v: the
     real risk is the grid running out of room, and .fig .v already stretches
     to whatever column width it is given (flex align-items:stretch), so this
     exercises the actual layout path rather than a shortcut around it. */
  const page = writePage('mutation-ellipsis', VIEWS.indexOf('stats'), FULL, html =>
    html.replace('</head>',
      '<style>.figs { grid-template-columns: repeat(4, 20px) !important; }</style></head>'));
  const r = render(page);
  const found = r.error ? [] : ellipsisedFigsIn(r);
  check('narrowing .figs to 20px columns trips the ellipsis check',
    r.error ? `render failed: ${r.error}` : found.length > 0, true);
  if (found.length) {
    console.log(`        caught ${found.length}, worst ${found[0].path} ` +
      `("${found[0].text}") ${found[0].scrollWidth}px into a ${found[0].clientWidth}px box`);
  }
}

/* ------------------------------------------------------------------- paging */

/* THE DEVICE FORWARDS NO TOUCH DRAGS. Confirmed on the Xeneon Edge on
   2026-08-30: a finger dragged across an activity list does not scroll it.
   So "the row is there, just scroll to it" is not a defence any more - a row
   the pager never brings into view is a row nobody can ever read, and that is
   what this section measures.
 *
 * It samples the real page over virtual time rather than asserting on the
 * pager's arithmetic, because the arithmetic was not the thing that broke
 * when this was written: adding the page indicator to the heading made one
 * heading WRAP, which took 22px off that column's list and silently cost it a
 * row. Only measuring the rendered boxes catches that. */

const PAGE_MS = Number(extractString(widgetSrc, 'PAGE_MS') ||
  (widgetSrc.match(/var PAGE_MS = (\d+)/) || [])[1]);

console.log('paging — the drag-less device can still reach every row:');
check('PAGE_MS was read out of widget.js', Number.isFinite(PAGE_MS) && PAGE_MS > 0, true);

const PAGING_ROWS = 40;
function pagingFixture() {
  const f = fullStatsFixture();
  f.workflows = buildRows(PAGING_ROWS, 'workflow');
  f.subtasks = buildRows(PAGING_ROWS, 'subtask', true);
  f.sessions = buildRows(PAGING_ROWS, 'session');
  return f;
}

/* No list caps here: renderModels() emits one row per key in byModel with no
   MAX_ROWS, so a fixture with many models is the only way `.mdl` - a single
   <table> child of `.col` - ever grows taller than the box itself. The live
   feed only ever carries a handful of models, so this shape does not occur
   without deliberately building it. */
const MANY_MODELS = 30;
function manyModelByModel() {
  const by = {};
  for (let i = 0; i < MANY_MODELS; i++) {
    by['claude-model-' + i + '-20260101'] = {
      messages: 3 + i, output: 1000 + i * 777, weighted: MANY_MODELS - i
    };
  }
  return by;
}
function manyModelsFixture() {
  const f = fullStatsFixture();
  f.session.tokens.byModel = manyModelByModel();
  f.weekly.tokens.byModel = manyModelByModel();
  return f;
}
function shortFixture() {
  const f = fullStatsFixture();
  f.workflows = buildRows(2, 'workflow');
  f.subtasks = buildRows(2, 'subtask', true);
  f.sessions = buildRows(2, 'session');
  return f;
}

const SAMPLE_STEP = Math.max(1, Math.round(PAGE_MS / 2));
const SAMPLE_COUNT = 16;   /* 8 dwells - more than the 6 pages 40 rows produce */

/* Sampled with the same measure-the-box discipline as everything above: a row
   counts as readable only when its whole height is inside the scroller. */
const SAMPLER = `<script>
(function () {
  function snap() {
    var av = document.querySelector('.view.is-active');
    if (!av) return null;
    var out = [];
    var all = av.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.clientHeight === 0) continue;
      var oy = window.getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      var box = el.classList.contains('col') ? el : el.parentNode;
      var h = box ? box.querySelector('h2') : null;
      var pg = h ? h.querySelector('.pages') : null;
      var active = -1;
      if (pg) {
        for (var k = 0; k < pg.children.length; k++) {
          if (pg.children[k].className === 'is-active') active = k;
        }
      }
      var visible = [];
      var base = el.children.length ? el.children[0].offsetTop : 0;
      /* A child taller than the box (e.g. .mdl, one <table> per model with no
         cap) has no boundary of its own past its top, so "the child started"
         is not "its content is reachable" - the rows living INSIDE it are the
         thing that actually has to surface. Measured by rect, not offsetTop,
         because the repeated rows are grandchildren (table > tbody > tr), an
         extra level offsetTop-from-base does not walk through. */
      var deep = [];
      var deepTotal = {};
      var elRect = el.getBoundingClientRect();
      for (var r = 0; r < el.children.length; r++) {
        var c = el.children[r];
        var t = c.offsetTop - base;
        if (t >= el.scrollTop - 0.5 &&
            t + c.offsetHeight <= el.scrollTop + el.clientHeight + 0.5) visible.push(r);
        if (c.offsetHeight > el.clientHeight + 0.5) {
          var host = c;
          while (host.children.length === 1) host = host.children[0];
          deepTotal[r] = host.children.length;
          for (var g = 0; g < host.children.length; g++) {
            var gr = host.children[g].getBoundingClientRect();
            var gTop = gr.top - elRect.top + el.scrollTop;
            var gBottom = gTop + gr.height;
            if (gTop >= el.scrollTop - 0.5 &&
                gBottom <= el.scrollTop + el.clientHeight + 0.5) deep.push(r + '.' + g);
          }
        }
      }
      out.push({
        id: el.id || el.getAttribute('data-page-key'),
        rows: el.children.length,
        clientHeight: el.clientHeight,
        scrollTop: Math.round(el.scrollTop),
        maxScroll: Math.round(el.scrollHeight - el.clientHeight),
        dots: pg ? pg.children.length : 0,
        activeDot: active,
        visible: visible,
        deep: deep,
        deepTotal: deepTotal,
        fade: box ? box.classList.contains('can-scroll') : null
      });
    }
    return out;
  }
  var samples = [], n = 0;
  var iv = setInterval(function () {
    samples.push(snap());
    if (++n >= __SAMPLE_COUNT__) {
      clearInterval(iv);
      document.documentElement.setAttribute('data-paging',
        encodeURIComponent(JSON.stringify(samples)));
    }
  }, __SAMPLE_STEP__);
})();
</script>`;

function writePagingPage(name, taps, fixture, mutate, srcMutate, sampleStep, sampleCount) {
  const inject = html => {
    const withSampler = html.replace('</head>', SAMPLER
      .replace('__SAMPLE_COUNT__', String(sampleCount || SAMPLE_COUNT))
      .replace('__SAMPLE_STEP__', String(sampleStep || SAMPLE_STEP)) + '</head>');
    return mutate ? mutate(withSampler) : withSampler;
  };
  /* srcMutate breaks what the widget DOES rather than how it looks - see
     writePageWithMutatedScript. Still temp-tree only. */
  if (!srcMutate) return writePage(name, taps, fixture, inject);
  return writePageWithMutatedScript(name, taps, fixture, srcMutate, inject);
}

function renderPaging(page, sampleStep, sampleCount) {
  const budget = PRE_TAP_MS + POST_TAP_MS +
    (sampleStep || SAMPLE_STEP) * (sampleCount || SAMPLE_COUNT) + 2000;
  const args = [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--mute-audio',
    '--force-device-scale-factor=1',
    `--user-data-dir=${PROFILE}`,
    `--window-size=${winW},${winH}`,
    `--virtual-time-budget=${budget}`,
    '--dump-dom',
    fileUrl(page)
  ];
  const res = spawnSync(CHROME, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { error: String(res.error) };
  const m = (res.stdout || '').match(/data-paging="([^"]*)"/);
  if (!m) return { error: 'no data-paging in the dumped DOM (the page never sampled itself)' };
  try {
    const samples = JSON.parse(decodeURIComponent(m[1])).filter(Boolean);
    return samples.length ? { samples } : { error: 'every sample was empty (no active view)' };
  } catch (e) {
    return { error: 'data-paging did not parse: ' + e };
  }
}

/* Folds the per-sample snapshots into one record per scroller. */
function byScroller(samples) {
  const out = {};
  samples.forEach(snap => (snap || []).forEach(s => {
    const r = out[s.id] || (out[s.id] = {
      id: s.id, rows: s.rows, clientHeight: s.clientHeight, maxScroll: s.maxScroll,
      dots: s.dots, seen: new Set(), offsets: new Set(), states: [], reachedBottom: false,
      fadeAtBottom: null, deepSeen: new Set(), deepTotal: {}
    });
    s.visible.forEach(v => r.seen.add(v));
    (s.deep || []).forEach(v => r.deepSeen.add(v));
    Object.assign(r.deepTotal, s.deepTotal || {});
    r.offsets.add(s.scrollTop);
    r.states.push({ scrollTop: s.scrollTop, activeDot: s.activeDot, fade: s.fade });
    if (s.scrollTop === s.maxScroll && s.maxScroll > 0) {
      r.reachedBottom = true;
      r.fadeAtBottom = s.fade;
    }
  }));
  return out;
}

const DETAIL_TAPS = VIEWS.indexOf('detail');

{
  const r = renderPaging(writePagingPage('paging-full', DETAIL_TAPS, pagingFixture()));
  check('the Activity view sampled itself over several page dwells',
    r.error ? r.error : true, true);
  if (!r.error) {
    const lists = byScroller(r.samples);
    const ids = Object.keys(lists);
    check('all three activity lists were found scrolling', ids.length, 3);

    /* The three columns are structurally identical, so an unequal box means
       one of the headings wrapped - the exact regression the page indicator
       caused when it was first added. */
    const heights = ids.map(id => lists[id].clientHeight);
    check('every activity column got the same box height, so no heading wrapped',
      heights.every(h => h === heights[0]), true);
    console.log(`        boxes ${heights.join(', ')}px`);

    ids.forEach(id => {
      const l = lists[id];
      const missing = [];
      for (let i = 0; i < l.rows; i++) if (!l.seen.has(i)) missing.push(i);
      check(`${id}: every one of its ${l.rows} rows became fully readable`,
        missing.length ? `never fully visible: ${missing.join(',')}` : true, true);

      check(`${id}: the last page reaches the bottom of the content`,
        l.reachedBottom, true);

      /* On the last page there is nothing below, so the fade would be the same
         false promise the drag-less device made in the first place. */
      check(`${id}: the fade is off once the bottom is reached`,
        l.fadeAtBottom, false);

      const offsets = Array.from(l.offsets).sort((a, b) => a - b);
      check(`${id}: one dot per page (${offsets.length} pages)`, l.dots, offsets.length);

      const wrong = l.states.filter(s => s.activeDot !== offsets.indexOf(s.scrollTop));
      check(`${id}: the lit dot is the page actually shown, in every sample`,
        wrong.length ? `${wrong.length} of ${l.states.length} samples disagreed` : true, true);
    });
  }
}

{
  const r = renderPaging(writePagingPage('paging-short', DETAIL_TAPS, shortFixture()));
  check('a two-row Activity view sampled itself', r.error ? r.error : true, true);
  if (!r.error) {
    const lists = byScroller(r.samples);
    const ids = Object.keys(lists);
    /* A list that fits is not a scroller at all, so it should not even appear
       - and if it does, it must never move and must carry no dots. */
    const moved = ids.filter(id => lists[id].offsets.size > 1);
    check('a list that fits its box never pages', moved.length ? moved.join(',') : true, true);
    const dotted = ids.filter(id => lists[id].dots > 0);
    check('a list that fits its box shows no page indicator',
      dotted.length ? dotted.join(',') : true, true);
  }
}

/* ------------------------------------------------------------- tokens paging

   The Activity checks above only ever exercise `.list ul`, where every child
   is one row shorter than the box. `.cols .col` is the other scroller
   ClaudeUsage.css pages, and its shape is different: h2, .col-sub, table.tok,
   .col-note, table.mdl - five children, and .mdl is a SINGLE child whose row
   count is renderModels()'s `Object.keys(t.byModel).length`, uncapped. A
   fixture carrying enough models (MANY_MODELS) makes .mdl itself taller than
   the box, which the Activity fixtures never do - so this is the only path
   that reaches the bug the pager had: a child taller than clientHeight
   contributed exactly one offset (its own top), and everything below
   top+clientHeight inside it was unreachable no matter how long paging ran. */
const TOKENS_TAPS = VIEWS.indexOf('tokens');
/* .mdl's own row height is much smaller than an activity li, so MANY_MODELS
   rows need more page-dwells to cycle through than the Activity fixture's 40
   rows do - sampled generously rather than tuned to a measured page count,
   so a future MANY_MODELS change does not silently starve this window. */
const TOKENS_SAMPLE_STEP = SAMPLE_STEP;
const TOKENS_SAMPLE_COUNT = 60;
console.log('paging — a column with more models than fit still reaches the last one:');
{
  const r = renderPaging(
    writePagingPage('paging-tokens', TOKENS_TAPS, manyModelsFixture(), null, null,
      TOKENS_SAMPLE_STEP, TOKENS_SAMPLE_COUNT),
    TOKENS_SAMPLE_STEP, TOKENS_SAMPLE_COUNT);
  check('the Tokens view sampled itself over several page dwells',
    r.error ? r.error : true, true);
  if (!r.error) {
    const cols = byScroller(r.samples);
    const ids = Object.keys(cols);
    check('both token columns were found scrolling', ids.length, 2);

    ids.forEach(id => {
      const c = cols[id];
      /* The oversized child is `.mdl` at column index 4 (h2, col-sub, tok,
         col-note, mdl); deepTotal is only populated for a child that did not
         fit, so this also confirms the fixture actually produced one. */
      const total = c.deepTotal[4];
      check(`${id}: .mdl was measured as an oversized child`, total > 0, true);
      if (total) {
        const missing = [];
        for (let g = 0; g < total; g++) if (!c.deepSeen.has('4.' + g)) missing.push(g);
        check(`${id}: every one of .mdl's ${total} rows became fully readable`,
          missing.length ? `never fully visible: ${missing.join(',')}` : true, true);
      }

      check(`${id}: the last page reaches the bottom of the content`,
        c.reachedBottom, true);
      check(`${id}: the fade is off once the bottom is reached`,
        c.fadeAtBottom, false);
    });
  }
}

console.log('the paging checks are not vacuous:');
{
  /* A row taller than its own box can never be fully visible on any page, so
     the reachability check MUST fail here. A mutation that does not fire is a
     missing test, not a passing one. */
  const page = writePagingPage('mutation-unreachable-row', DETAIL_TAPS, pagingFixture(), html =>
    html.replace('</head>',
      '<style>#d-sessions li:nth-child(9) { height: 400px !important; flex: 0 0 400px !important; }' +
      '</style></head>'));
  const r = renderPaging(page);
  const lists = r.error ? {} : byScroller(r.samples);
  const l = lists['d-sessions'];
  const missing = [];
  if (l) for (let i = 0; i < l.rows; i++) if (!l.seen.has(i)) missing.push(i);
  check('a row taller than its box trips the reachability check',
    r.error ? `render failed: ${r.error}` : missing.length > 0, true);
  if (missing.length) console.log(`        caught ${missing.length} unreachable row(s): ${missing.join(',')}`);
}
{
  /* The 400px-row mutation above proves the reachability check fires for
     `.list ul`, where every child is one row shorter than the box. It proves
     nothing about a DIRECT child taller than the box, which is the shape
     `.mdl` actually has - so this disables pageOffsets()'s recursive descent
     into an oversized child's own children (every collect() call is forced
     to treat its node as a leaf, regardless of height), leaving only the
     flat clientHeight-step fallback to reach through .mdl. That fallback
     alone cuts rows at unaligned seams - MEASURED, it left exactly one model
     row (of the 31) never fully on screen on any page before recursion was
     added - so the Tokens reachability check above MUST fail against it. */
  const page = writePagingPage('mutation-tall-child-not-recursed', TOKENS_TAPS, manyModelsFixture(),
    null, src => src.replace(
      'if (node.offsetHeight <= el.clientHeight + 0.5 || !kidsN.length) {',
      'if (true) {'),
    TOKENS_SAMPLE_STEP, TOKENS_SAMPLE_COUNT);
  const r = renderPaging(page, TOKENS_SAMPLE_STEP, TOKENS_SAMPLE_COUNT);
  const cols = r.error ? {} : byScroller(r.samples);
  const ids = Object.keys(cols);
  const missing = [];
  ids.forEach(id => {
    const total = cols[id].deepTotal[4];
    if (!total) return;
    for (let g = 0; g < total; g++) if (!cols[id].deepSeen.has('4.' + g)) missing.push(`${id}:${g}`);
  });
  check('a child taller than its box, stepped through no further, trips the .mdl reachability check',
    r.error ? `render failed: ${r.error}` : missing.length > 0, true);
  if (missing.length) console.log(`        caught ${missing.length} unreachable .mdl row(s)`);
}
{
  /* Restores the pre-fix heading: a loose text node beside the dots is an
     anonymous flex item that will not shrink, so the longest heading wraps and
     its column loses a row. This is the regression itself, re-created. */
  const page = writePagingPage('mutation-wrapping-heading', DETAIL_TAPS, pagingFixture(), html =>
    html.replace('</head>',
      /* flex: 0 1 auto, NOT 0 0 auto - an item that cannot shrink sizes to
         max-content and never wraps, so the mutation would not fire at all.
         This is the loose-text-node behaviour the fix replaced. */
      '<style>.list h2 .htext { white-space: normal !important; overflow: visible !important; ' +
      'text-overflow: clip !important; flex: 0 1 auto !important; }</style></head>'));
  const r = renderPaging(page);
  const lists = r.error ? {} : byScroller(r.samples);
  const heights = Object.keys(lists).map(id => lists[id].clientHeight);
  check('a heading allowed to wrap trips the equal-box-height check',
    r.error ? `render failed: ${r.error}` : (heights.length > 1 && !heights.every(h => h === heights[0])), true);
  if (heights.length) console.log(`        boxes ${heights.join(', ')}px`);
}

/* ------------------------------------- the reason is readable IN FULL, not just
   its first line

   Same argument as the activity lists above: no drags, so "the rest is there,
   scroll to it" is not a defence. A reason that only ever shows its first line
   loses the actual cause - which for these errors is at the END of the string
   (official.js joins the credential failures with ' | ' and server.js appends
   the statusline hint with ' · '). The strip is a scroller like the lists, so
   the widget's own pager drives it and the same sampler measures it. */

console.log('paging — the whole reason becomes readable without a drag:');
{
  const r = renderPaging(writePagingPage('why-paging-local', VIEWS.indexOf('usage'), localFixture()));
  check('the usage view sampled itself with a fallback reason on screen',
    r.error ? r.error : true, true);
  if (!r.error) {
    const strips = byScroller(r.samples);
    const w = strips['why'];
    check('the reason strip was found paging itself', !!w, true);
    if (w) {
      /* Every child span is a word (or a piece of an over-long token), so
         "every span became fully visible" is "every word of the reason can be
         read on the device". */
      const missing = [];
      for (let i = 0; i < w.rows; i++) if (!w.seen.has(i)) missing.push(i);
      check(`why: every one of its ${w.rows} words became fully readable`,
        missing.length ? `never fully visible: ${missing.join(',')}` : true, true);
      check('why: the last page reaches the end of the reason', w.reachedBottom, true);
      check('why: the "more below" marker is off once the end is reached', w.fadeAtBottom, false);
      console.log(`        ${w.clientHeight}px box, ${w.maxScroll}px of scroll, ` +
        `${Array.from(w.offsets).sort((a, b) => a - b).join('/')} page offsets`);
    }
  }
}

console.log('the reason checks are not vacuous:');
{
  /* The pre-fix behaviour, exactly: compute the reason, set it as the badge's
     title, and put nothing in the page. A source mutation rather than a
     stylesheet one because that is a behaviour, not an appearance - and the
     title check must go on passing while the DOM check fails, which is the
     whole point of the DONE criterion. */
  const page = writePageWithMutatedScript('mutation-why-title-only', VIEWS.indexOf('usage'),
    localFixture(), src => src.replace('setWhy(reason);', 'setWhy(\'\');'));
  const r = render(page);
  const inDom = r.error ? null : (r.why ? r.why.text.indexOf(LONG_ERROR) !== -1 : false);
  const inTitle = r.error ? null : (typeof r.badgeTitle === 'string' && r.badgeTitle.indexOf(LONG_ERROR) !== -1);
  check('putting the reason only in the title trips the in-the-DOM check',
    r.error ? `render failed: ${r.error}` : inDom === false, true);
  check('...while the title itself still holds it, so the DOM check is the one doing the work',
    r.error ? `render failed: ${r.error}` : inTitle === true, true);
  if (!r.error) console.log(`        badge "${r.badgeText}", strip text ${JSON.stringify(r.why && r.why.text)}`);
}
{
  /* Rendered but not visible: the strip exists with its text, and a reader on
     the device still gets nothing. */
  const page = writePage('mutation-why-hidden', VIEWS.indexOf('usage'), localFixture(), html =>
    html.replace('</head>',
      '<style>.view-usage.has-why .why-wrap { display: none !important; }</style></head>'));
  const r = render(page);
  const hasText = r.error ? null : (r.why ? r.why.text.indexOf(LONG_ERROR) !== -1 : false);
  check('hiding the strip trips the visibility check',
    r.error ? `render failed: ${r.error}` : (r.why ? r.why.onScreen === false : 'no #why'), true);
  check('...while the text is still in the DOM, so visibility is checked separately from presence',
    r.error ? `render failed: ${r.error}` : hasText === true, true);
}
{
  /* The strip is sized in whole lines, and at 840x344 there is room for
     exactly one - so --why-lines is the number that decides whether the strip
     costs slack or costs a meter. This is NOT caught by the overflow check:
     .widget-root has 21.5px of padding, so a meter pushed out of .meters is
     still inside the widget and every box measures clean. MEASURED: at two
     lines the meters still fit (weekly note ends 282.2, .meters 286.6); at
     three they do not (273.5 against 269.9), which is the smallest value that
     makes this fire. */
  const page = writePage('mutation-why-three-lines', VIEWS.indexOf('usage'), localFixture(), html =>
    html.replace('</head>', '<style>:root { --why-lines: 3 !important; }</style></head>'));
  const r = render(page);
  const u = r.error ? null : r.usage;
  const squeezed = !!(u && u.meters && u.weeklyNote && u.weeklyNote.bottom > u.meters.bottom + 0.5);
  check('giving the strip three lines at 840x344 trips the squeezed-meter check',
    r.error ? `render failed: ${r.error}` : squeezed, true);
  if (u && u.meters) {
    console.log(`        weekly note ends ${u.weeklyNote.bottom}, .meters ends ${u.meters.bottom}` +
      `, the strip starts ${u.whyWrap ? u.whyWrap.top : '?'}` +
      ` — and overflowsIn() saw ${overflowsIn(r).length}, which is why this check exists`);
  }
}
{
  /* One <span> per word is the thing that makes a long reason reachable: the
     pager snaps a page to a CHILD boundary, so a reason rendered as one block
     of text is one unsplittable child and pages nowhere. That is the shape the
     obvious implementation would have had, so it is the one mutated in. */
  const page = writePagingPage('mutation-why-one-block', VIEWS.indexOf('usage'), localFixture(),
    null, src => src.replace('var words = text.split(/\\s+/);',
      'var one = document.createElement("span"); one.className = "w";' +
      ' one.style.display = "block"; one.textContent = text;' +
      ' els.why.appendChild(one); return;' +
      ' var words = text.split(/\\s+/);'));
  const r = renderPaging(page);
  const w = r.error ? null : byScroller(r.samples)['why'];
  const missing = [];
  if (w) for (let i = 0; i < w.rows; i++) if (!w.seen.has(i)) missing.push(i);
  check('rendering the reason as one block instead of word spans trips the readability check',
    r.error ? `render failed: ${r.error}` : missing.length > 0, true);
  if (w) {
    console.log(`        ${w.rows} child(ren), ${missing.length} never fully visible, ` +
      `${Array.from(w.offsets).join('/')} page offsets (a box that never moves)`);
  }
}

/* ------------------------------------------------------------------- teardown */

try { fs.rmSync(WORK, { recursive: true, force: true }); }
catch (e) { console.log(`  note  temp tree left behind at ${WORK}: ${e.message}`); }

console.log('source files:');
const sourceHashesAfter = SOURCE_FILES.map(hashFile);
check('index.html, widget.js and ClaudeUsage.css are byte-identical to before the run',
  sourceHashesAfter, sourceHashesBefore);

console.log('');
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
