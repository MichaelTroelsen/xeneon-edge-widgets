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

const ok = results.filter(r => !r.error);
check('all six renders came back', ok.length, results.length);
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
      for (var r = 0; r < el.children.length; r++) {
        var c = el.children[r];
        var t = c.offsetTop - base;
        if (t >= el.scrollTop - 0.5 &&
            t + c.offsetHeight <= el.scrollTop + el.clientHeight + 0.5) visible.push(r);
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

function writePagingPage(name, taps, fixture, mutate) {
  return writePage(name, taps, fixture, html => {
    const withSampler = html.replace('</head>', SAMPLER
      .replace('__SAMPLE_COUNT__', String(SAMPLE_COUNT))
      .replace('__SAMPLE_STEP__', String(SAMPLE_STEP)) + '</head>');
    return mutate ? mutate(withSampler) : withSampler;
  });
}

function renderPaging(page) {
  const budget = PRE_TAP_MS + POST_TAP_MS + SAMPLE_STEP * SAMPLE_COUNT + 2000;
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
      fadeAtBottom: null
    });
    s.visible.forEach(v => r.seen.add(v));
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
