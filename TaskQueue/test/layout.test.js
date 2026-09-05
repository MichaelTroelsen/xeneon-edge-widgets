#!/usr/bin/env node
/* Tests what the Task Queue widget LOOKS like, not what it is made of.
 *
 * Ported from ClaudeUsage/test/layout.test.js, whose calibrations are carried
 * across rather than rediscovered - they were paid for once already and are
 * documented in the "Verifying a layout" section of README.md:
 *
 *   1. --window-size means something different to --dump-dom than to
 *      --screenshot (it is the WINDOW, and headless Chrome's chrome eats part
 *      of it), so the slot is found by asking a blank page how big it came out
 *      and correcting until the viewport is exactly 840x344 - not by
 *      hard-coding a deficit that is Chrome-version-dependent.
 *   2. window.innerWidth read during load is the PRE-resize size in
 *      --screenshot mode; the 840x344 assertion is kept anyway so a harness
 *      that drifts fails loudly rather than reporting on a slot that was never
 *      rendered.
 *   3. CSS transitions do not advance under --virtual-time-budget, and
 *      --force-prefers-reduced-motion does not fix it, so
 *      `* { transition: none !important }` is injected into every page.
 *   4. an already-running Chrome on the default profile breaks bare
 *      --headless, so --user-data-dir points somewhere disposable.
 *
 * The three views this widget puts behind one page each have a failure shape
 * that only a rendered measurement can see:
 *
 *   OVERFLOW     no element's box extends outside .widget-root, in any view -
 *                except a descendant of a deliberately-scrolling container
 *                (.list ul), whose content is SUPPOSED to run past its own
 *                clipped box. The scroller itself is still measured.
 *   AVAILABILITY a queue view with no queues anywhere, and a history view
 *                whose records could not be dated, must PRINT THE REASON and
 *                draw no meter and no grid. An empty grid reads as months of
 *                silence rather than as a missing file, which is the one
 *                failure these views must not have.
 *   CALENDAR     the heatmap is laid out by date, not by array position. Runs
 *                are sparse in time, so a grid packed by position draws a
 *                solid block with every date in the wrong column - which is
 *                why the fixture is sparse and the assertion is that there
 *                are MORE cells than active days, some of them empty.
 *   COUNTS       a held lock and a Claude session are different claims about
 *                the machine, so the live view's two columns are counted
 *                separately and their headings say so in different words.
 *
 * Usage:  node TaskQueue/test/layout.test.js
 *         CHROME_PATH=/path/to/chrome node TaskQueue/test/layout.test.js
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
  path.join(ROOT, 'styles', 'TaskQueue.css')
];
const sourceHashesBefore = SOURCE_FILES.map(hashFile);

/* ------------------------------------------------------- metrics, not guesses */
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
check('VIEWS was read out of widget.js', VIEWS, ['queue', 'live', 'history', 'files', 'projects']);
check('the widget starts on the "queue" view', START_VIEW, 'queue');
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
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'taskqueue-layout-'));
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
/* --------------------------------------------------------------- fixtures */

/* Modelled on what the real feed serves - five repos, one holding more open
   tasks than the other four together, and repo names as long as the longest
   real one - so the layout is exercised against realistic magnitudes rather
   than toy ones. */
function repo(name, open, closed, blocked, byMode, extra) {
  return Object.assign({
    name: name, path: 'C:/Users/x/' + name,
    open: open, closed: closed, blocked: blocked,
    byMode: byMode, byLane: { unknown: open },
    holders: [], lastRunAt: 1757000000000, error: null, historyError: null
  }, extra || {});
}

function baseFixture() {
  return {
    generatedAt: Date.now(),
    repos: [
      repo('SIDM2', 120, 42, 3, { subtask: 90, main: 27, 'requires-user': 3 }),
      repo('h2g', 83, 105, 0, { subtask: 83 }),
      repo('claude-setup', 3, 0, 0, { unknown: 3 }),
      repo('icue', 2, 63, 2, { 'requires-user': 2 }),
      repo('tdz-c64-knowledge', 2, 97, 0, { subtask: 2 })
    ],
    totals: {
      open: 210, closed: 307, repos: 5, blocked: 5,
      byMode: { subtask: 175, main: 27, 'requires-user': 5, unknown: 3 }
    },
    running: [],
    history: emptyHistory(),
    unavailable: null
  };
}

function emptyHistory() {
  return { runs: 0, days: {}, outcome: {}, model: {}, effort: {},
           span: { from: null, to: null } };
}

/* A queue that is nearly DONE - 96% closed. Finished is the best state this
   meter can be in, so its fill must never pick up a warning or danger colour
   the way a plan-utilisation meter's would at the same percentage. */
function finishedFixture() {
  const f = baseFixture();
  f.repos = [repo('SIDM2', 4, 96, 0, { subtask: 4 })];
  f.totals = { open: 4, closed: 96, repos: 1, blocked: 0, byMode: { subtask: 4 } };
  return f;
}

/* No repo on this machine has a queue: the view must SAY so rather than draw
   a meter at zero, which would read as a queue that is finished. */
function unavailableFixture() {
  return {
    generatedAt: Date.now(), repos: [], running: [], history: emptyHistory(),
    totals: { open: 0, closed: 0, repos: 0, blocked: 0, byMode: {} },
    unavailable: 'no repo on this machine has a .claude/tasks/whattask.json - run /whattask in one to create a queue'
  };
}

/* A repo whose whattask.json could not be read is LISTED, with its reason,
   rather than dropped or shown as zero. The message is as long as a real
   filesystem error, because that is what has to fit. */
const REPO_ERROR =
  'whattask.json could not be read: Unexpected token } in JSON at position 4127';

function repoErrorFixture() {
  const f = baseFixture();
  f.repos[2] = repo('claude-setup', 0, 0, 0, {}, { error: REPO_ERROR });
  return f;
}

function runningFixture() {
  const f = baseFixture();
  const now = Date.now();
  f.running = [
    { kind: 'holder', label: 'fix-the-pager-for-children-taller-than-the-box',
      repo: 'icue', since: now - 252000,
      detail: 'ClaudeUsage/scripts, ClaudeUsage/test, ClaudeUsage/styles' },
    { kind: 'holder', label: 'surface-the-feeds-own-error-not-a-fixed-hint',
      repo: 'icue', since: now - 48000, detail: 'ClaudeUsage/scripts' },
    { kind: 'session', label: '/runqueue', repo: 'SIDM2', since: now - 600000, detail: '' },
    { kind: 'workflow', label: 'review-changes', repo: 'h2g', since: now - 120000, detail: '' },
    { kind: 'subtask', label: 'verify:bugs', repo: 'h2g', since: now - 60000, detail: '' }
  ];
  return f;
}

/* The state the machine is in almost all the time: serial.lock is [] because
   no /runqueue is mid-flight, but Claude is still doing things. This is the
   fixture that proves the live view is worth having - without the enriched
   activity it would be a blank page here. */
function idleFixture() {
  const f = runningFixture();
  f.running = f.running.filter(r => r.kind !== 'holder');
  return f;
}

/* Runs on 40 days spread across a 96-day span, so the heatmap is SPARSE -
   which is the shape the real data has (20 active days across a 29-day span),
   and the shape that catches a grid laid out by array position. */
function historyFixture() {
  const f = baseFixture();
  const days = {};
  let runs = 0;
  const start = Date.UTC(2026, 5, 1);
  for (let d = 0; d < 96; d += 2.4) {
    const day = Math.floor(d);
    const when = new Date(start + day * 86400000);
    const key = when.getUTCFullYear() + '-' +
      String(when.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(when.getUTCDate()).padStart(2, '0');
    const n = 1 + (day % 5);
    days[key] = (days[key] || 0) + n;
    runs += n;
  }
  const keys = Object.keys(days).sort();
  f.history = {
    runs: runs,
    days: days,
    /* All five outcomes the real corpus actually names. A view built for two
       would silently drop the other three. */
    outcome: { done: 453, partial: 111, blocked: 22, failed: 10, inconclusive: 9 },
    model: { sonnet: 314, opus: 283, fable: 8 },
    effort: { unknown: 317, high: 101, medium: 88, low: 64, xhigh: 35 },
    span: { from: keys[0], to: keys[keys.length - 1] }
  };
  return f;
}

/* History that could not be dated: git unreachable in one repo. The view must
   print the reason, because an empty grid reads as months of silence. */
const HISTORY_ERROR = 'git could not be read in C:/Users/x/SIDM2: spawnSync git ENOENT';

/* Files present, sizes as they really are, nothing wrong: the all-clear state
   the view spends most of its life in. */
function filesFixture() {
  const f = baseFixture();
  const sizes = {
    SIDM2: [208896, 1896448, 1024, 12288, 32768],
    h2g: [159744, 835584, null, null, null],
    'claude-setup': [8192, null, null, null, null],
    icue: [32768, 307200, 1024, 7168, 11264],
    'tdz-c64-knowledge': [45056, 380928, 1024, 9216, 20480]
  };
  const names = ['whattask.json', 'runs.jsonl', 'serial.lock', 'decisions.jsonl', 'interview.json'];
  for (const r of f.repos) {
    r.files = {};
    names.forEach((n, i) => {
      const b = sizes[r.name][i];
      r.files[n] = b == null
        ? { present: false, bytes: null, mtime: null }
        : { present: true, bytes: b, mtime: 1757000000000 };
    });
    r.mutex = { held: false, stale: false, since: null, owner: null, reason: null };
  }
  f.alarms = [];
  return f;
}

/* The state this view exists for, taken from the real one found on this
   machine: SIDM2 holding a record whose pid is dead, plus a stuck mutex. */
function alarmFixture() {
  const f = filesFixture();
  f.repos[0].mutex = {
    held: true, stale: true, since: Date.now() - 22 * 60 * 1000,
    owner: { pid: 26852, host: 'TDZDesktop', cmd: '/runqueue' },
    reason: 'pid 26852 is not running and the lock is 22 min old (over 15 min)'
  };
  f.alarms = [
    { kind: 'orphan', repo: 'SIDM2', task: 'sdi-control-rerun-at-j8', pid: 26852,
      pathCount: 8,
      message: 'pid 26852 is not running, so 8 paths stay refused until it is reaped' },
    { kind: 'stale-mutex', repo: 'SIDM2', task: '/runqueue', pid: 26852, pathCount: 0,
      message: 'pid 26852 is not running and the lock is 22 min old (over 15 min)' }
  ];
  return f;
}

/* One project's task list, as ?project= answers it. Titles at the measured
   90-character cap and a blocking reason at 110, because those are the widths
   that have to fit. */
function projectFixture(name, count, blockedEvery, running, done, waitingCount, doneTotal) {
  const tasks = [];
  for (let r = 0; r < (running || 0); r++) {
    tasks.push({
      id: name + '-running-' + r, title: 'sdi-control-rerun-at-j8-' + r,
      mode: 'subtask', model: 'sonnet', effort: 'medium', lane: 'serial',
      blocked: null, state: 'running', reason: null, needsMain: false, waitingOn: null
    });
  }
  /* Built queued-first then blocked, matching the order the feed serves - the
     fixture must not assert an ordering the feed does not produce. */
  const queued = [], stuck = [];
  for (let i = 0; i < count; i++) {
    const blocked = blockedEvery && i % blockedEvery === 0;
    (blocked ? stuck : queued).push({
      id: name + '-task-' + i,
      title: blocked
        ? 'A blocked one whose title runs the full ninety characters the feed caps them at, pad'
        : 'sdi-corpus-part-count-anomaly-non-descending-' + i,
      mode: blocked ? 'requires-user' : (i % 3 === 0 ? 'main' : 'subtask'),
      model: i % 2 ? 'sonnet' : 'opus',
      effort: ['low', 'medium', 'high', 'unknown'][i % 4],
      lane: i % 2 ? 'serial' : 'parallel',
      blocked: blocked
        ? 'a remove-and-re-add in the iCUE desktop UI, which no agent can perform, and which resets'
        : null,
      state: blocked ? 'blocked' : 'queued',
      reason: null,
      needsMain: i % 5 === 0,
      waitingOn: null
    });
  }
  for (const t of queued) tasks.push(t);
  for (const t of stuck) tasks.push(t);
  /* Done rows sit under the open ones, the way the feed orders them. */
  for (let d = 0; d < (done || 0); d++) {
    tasks.push({
      id: name + '-done-' + d, title: 'The one that landed, number ' + d,
      mode: 'closed', model: 'unknown', effort: 'unknown', lane: 'unknown',
      blocked: null, state: 'done', needsMain: false, waitingOn: null,
      reason: d % 2 ? 'closed by eaa9f97' : 'Shipped as a fifth view rather than an addition'
    });
  }
  /* Waiting rows sit between blocked and done, the way the feed orders them. */
  const stuckOnDeps = [];
  for (let w = 0; w < (waitingCount || 0); w++) {
    stuckOnDeps.push({
      id: name + '-waiting-' + w, title: 'The one waiting on another task ' + w,
      mode: 'subtask', model: 'sonnet', effort: 'low', lane: 'serial',
      blocked: null, state: 'waiting', reason: null, needsMain: false,
      waitingOn: [name + '-task-0']
    });
  }
  const ordered = tasks.filter(t => t.state !== 'done')
    .concat(stuckOnDeps)
    .concat(tasks.filter(t => t.state === 'done'));
  return {
    project: name, tasks: ordered,
    doneTotal: (doneTotal == null ? (done || 0) : doneTotal),
    doneShown: done || 0,
    error: null
  };
}

/* done is what the feed SHIPS (capped at 10); doneTotal is how many exist, so
   the "older not shown" line has something to say. */
const PROJECT_BODIES = {
  SIDM2: projectFixture('SIDM2', 120, 4, 2, 10, 20, 42),
  h2g: projectFixture('h2g', 83, 0, 0, 10, 0, 105),
  'claude-setup': projectFixture('claude-setup', 3, 3, 0, 0, 0, 0),
  icue: projectFixture('icue', 2, 1, 0, 10, 0, 63),
  'tdz-c64-knowledge': projectFixture('tdz-c64-knowledge', 2, 0, 0, 10, 0, 97)
};

/* Eight projects, to prove the tab strip narrows rather than overflowing. Five
   fit at 840px today and that is not a property worth depending on. */
function manyProjectsFixture() {
  const f = baseFixture();
  const extra = ['another-long-project-name', 'sixth-project', 'seventh-one'];
  for (const n of extra) {
    f.repos.push({ name: n, path: 'C:/x/' + n, open: 1, closed: 1, blocked: 0,
      byMode: { subtask: 1 }, byLane: { unknown: 1 }, holders: [],
      lastRunAt: 1, error: null, historyError: null,
      files: {}, mutex: { held: false, stale: false, since: null, owner: null, reason: null } });
  }
  f.totals.repos = f.repos.length;
  return f;
}

/* A reading old enough that no reasonable person would call the feed live:
   45s, against the default 10s refresh interval's 30s (3-cycle) threshold.
   Used with a rejecting poll, below, to prove a dead feed is marked as one
   rather than quietly kept looking current. */
function staleFixture() {
  const f = baseFixture();
  f.generatedAt = Date.now() - 45000;
  return f;
}

function noHistoryFixture() {
  const f = baseFixture();
  f.repos[0].historyError = HISTORY_ERROR;
  f.history = emptyHistory();
  return f;
}

const HARNESS = `<script>
window.__FIXTURE__ = __PAYLOAD__;
window.__PROJECTS__ = __PROJECT_BODIES__;
window.__PROJECTS_AFTER__ = __PROJECT_BODIES_AFTER__;
/* How the ?project= stub is allowed to misbehave: a status other than 200 with
   a body of its own, or - for the race - an answer that is never given at all
   until the timeline below hands it over. */
window.__PROJECT_CONTROL__ = __CONTROL_JSON__;
/* How the OVERVIEW poll is allowed to misbehave: 0 means every call succeeds;
   an N > 0 makes the Nth call to the overview endpoint (1-indexed, so 2 is
   "the poll after the first good one") reject outright - a dropped
   connection, not an HTTP error with a body, which is the shape a rejected
   fetch() promise actually has. */
window.__FEED_FAIL_AT__ = __FEED_FAIL_ON__;
window.__FEED_CALLS__ = 0;
(function () {
  var style = document.createElement('style');
  /* Calibration 3: transitions do not advance under --virtual-time-budget, and
     getComputedStyle then reports the pre-change value. Nothing here reads a
     transitioning colour, but geometry can still be mid-animation (the meter
     fill's width transitions), so this is unconditional rather than scoped. */
  style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(style);

  /* A throw inside the widget's own boot or render leaves the page sitting in
     its loading state, which every assertion below then reports as its own
     failure. Capturing it means the suite names the real cause once instead of
     failing twenty times about symptoms. */
  window.__ERRORS__ = [];
  window.addEventListener('error', function (e) {
    window.__ERRORS__.push(String(e.message) + ' @ ' + (e.filename || '?') + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__ERRORS__.push('unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });

  /* Two endpoints now: the overview, and ?project=<name> for one project's
     task list. The stub routes on the query string exactly as the server does,
     so a widget asking the wrong one would show the wrong thing here too. */
  window.fetch = function (url) {
    var m = /[?&]project=([^&]*)/.exec(String(url || ''));
    if (m) {
      var name = decodeURIComponent(m[1]);
      window.__PROJECT_FETCHES__ = (window.__PROJECT_FETCHES__ || 0) + 1;
      /* WHICH project was asked for, and in what order. A bare count cannot
         tell a first request for the tab the reader moved TO from a second one
         fired on top of it, and those are different defects. */
      window.__PROJECT_LOG__ = window.__PROJECT_LOG__ || [];
      window.__PROJECT_LOG__.push(name);
      /* A second body for the second request, so "did it refetch" is
         answerable from what is on screen rather than from a call count. */
      var later = window.__PROJECTS_AFTER__ || {};
      var body = (window.__PROJECT_FETCHES__ > 1 && later[name]) ||
        (window.__PROJECTS__ || {})[name] ||
        { project: name, tasks: [], error: 'no project called "' + name + '"' };
      var ctl = window.__PROJECT_CONTROL__ || {};
      var status = ctl.status || 200;
      var answer = {
        ok: status >= 200 && status < 300, status: status,
        json: function () { return Promise.resolve(ctl.body || body); }
      };
      /* HELD, not answered. The race below needs one request still outstanding
         while the next goes out, which a stub that resolves immediately can
         never produce - every interleaving collapses to the same one. */
      if (ctl.hold) {
        window.__HELD__ = window.__HELD__ || [];
        return new Promise(function (resolve) {
          window.__HELD__.push({
            name: name, settled: false,
            release: function () { resolve(answer); }
          });
        });
      }
      return Promise.resolve(answer);
    }
    window.__FEED_CALLS__ += 1;
    if (window.__FEED_FAIL_AT__ && window.__FEED_CALLS__ === window.__FEED_FAIL_AT__) {
      return Promise.reject(new Error('network error'));
    }
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
    out.taskQueue = {
      meters: edgesOf('.view-queue .meters'),
      lists: edgesOf('.view-queue .lists')
    };

    /* --- queue view --- */
    /* VISIBLE rows, not rows in the DOM. A display:none inherited from the
       usage widget's stylesheet blanked this whole list on the device while a
       querySelectorAll count still reported five - the defect reached the
       glass because the probe could not tell the difference. offsetParent is
       null for anything display:none, itself or via an ancestor. */
    out.repoRowCount = Array.prototype.filter.call(
      document.querySelectorAll('#repo-rows li'), function (e) { return e.offsetParent !== null; }).length;
    out.repoRowsInDom = document.querySelectorAll('#repo-rows li').length;
    var listEl = document.getElementById('list-repos');
    out.repoListDisplay = listEl ? window.getComputedStyle(listEl).display : null;
    out.repoRowNames = Array.prototype.map.call(
      document.querySelectorAll('#repo-rows li .row-name'), function (e) { return e.textContent; });
    out.repoRowErrors = document.querySelectorAll('#repo-rows li .row-figure.row-error').length;
    var doneFill = document.getElementById('done-fill');
    var doneTrack = doneFill ? doneFill.parentElement : null;
    out.doneFillPercent = (doneFill && doneTrack && doneTrack.getBoundingClientRect().width)
      ? Math.round((doneFill.getBoundingClientRect().width /
                    doneTrack.getBoundingClientRect().width) * 100) : null;
    var doneMeter = document.getElementById('m-done');
    out.doneMeterClasses = doneMeter ? Array.prototype.slice.call(doneMeter.classList) : [];
    out.doneValueText = (document.getElementById('done-value') || {}).textContent || null;
    out.doneSubText = (document.getElementById('done-sub') || {}).textContent || null;
    out.reposText = (document.getElementById('repos') || {}).textContent || null;
    var queueNote = document.getElementById('queue-note');
    out.queueNoteText = queueNote ? queueNote.textContent : null;
    out.queueNoteDisplay = queueNote ? window.getComputedStyle(queueNote).display : null;
    var metersEl = document.querySelector('.view-queue .meters');
    out.metersDisplay = metersEl ? window.getComputedStyle(metersEl).display : null;

    /* --- live view --- */
    out.holderKinds = Array.prototype.map.call(
      Array.prototype.filter.call(document.querySelectorAll('#holders li'),
        function (e) { return e.offsetParent !== null; }),
      function (e) { return e.getAttribute('data-kind'); });
    out.activityKinds = Array.prototype.map.call(
      document.querySelectorAll('#activity li'), function (e) { return e.getAttribute('data-kind'); });
    out.liveHeadings = Array.prototype.map.call(
      document.querySelectorAll('.view-live h2'), function (e) { return e.textContent.trim(); });

    /* --- history view --- */
    var heat = document.getElementById('heat');
    out.heatCellsTotal = heat ? heat.querySelectorAll('rect[data-day]').length : null;
    out.heatCellsEmpty = heat ? heat.querySelectorAll('rect[data-day][data-level="0"]').length : null;
    out.heatHeadText = (document.getElementById('heat-head') || {}).textContent || null;
    var histNote = document.getElementById('history-note');
    out.historyNoteText = histNote ? histNote.textContent : null;
    out.historyNoteDisplay = histNote ? window.getComputedStyle(histNote).display : null;
    var hist = document.querySelector('.view-history .history');
    out.historyGridDisplay = hist ? window.getComputedStyle(hist).display : null;
    out.figLabels = Array.prototype.map.call(
      document.querySelectorAll('#figs .fig .k'), function (e) { return e.textContent; });
    out.figValues = Array.prototype.map.call(
      document.querySelectorAll('#figs .fig .v'), function (e) { return e.textContent; });
    out.outcomeNames = Array.prototype.map.call(
      document.querySelectorAll('#outcomes .oc'), function (e) { return e.getAttribute('data-outcome'); });
    out.outcomeCounts = Array.prototype.map.call(
      document.querySelectorAll('#outcomes .oc .n'), function (e) { return e.textContent; });

    /* --- task files view --- */
    out.alarmCount = document.querySelectorAll('#alarms .alarm').length;
    out.alarmKinds = Array.prototype.map.call(
      document.querySelectorAll('#alarms .alarm'), function (e) {
        return (e.getAttribute('class') || '').replace('alarm ', ''); });
    out.alarmTexts = Array.prototype.map.call(
      document.querySelectorAll('#alarms .alarm'), function (e) { return e.textContent; });
    var alarmsEl = document.getElementById('alarms');
    out.alarmsDisplay = alarmsEl ? window.getComputedStyle(alarmsEl).display : null;
    out.fileRowNames = Array.prototype.map.call(
      Array.prototype.filter.call(document.querySelectorAll('#filetable tbody td.name'),
        function (e) { return e.offsetParent !== null; }),
      function (e) { return e.textContent; });
    out.fileHeads = Array.prototype.map.call(
      document.querySelectorAll('#filetable thead th'), function (e) { return e.textContent; });
    out.fileAbsentCells = document.querySelectorAll('#filetable td.absent').length;
    out.mutexCells = Array.prototype.map.call(
      document.querySelectorAll('#filetable td.mx'), function (e) {
        return e.textContent + ':' + (e.classList.contains('mx-stale') ? 'stale'
          : e.classList.contains('mx-held') ? 'held' : 'free'); });

    /* An undefined CSS custom property makes the whole declaration invalid and
       the element silently keeps its inherited value - no error, no visual cue,
       and nothing a geometry measurement can see. var(--accent) shipped that
       way and went unnoticed. Resolve the ones that carry meaning. */
    function resolved(sel, prop) {
      var e = document.querySelector(sel);
      if (!e) return null;
      var v = window.getComputedStyle(e).getPropertyValue(prop);
      return v ? v.trim() : null;
    }
    out.colours = {
      holderName: resolved('.lists-live li[data-kind="holder"] .row-name', 'color'),
      sessionName: resolved('.lists-live #activity li .row-name', 'color'),
      alarmSign: resolved('#alarms .alarm .sign', 'color'),
      staleMutex: resolved('#filetable td.mx-stale', 'color'),
      bodyText: resolved('.widget-root', 'color')
    };

    var errorHintEl = document.getElementById('error-hint');
    var errorStateEl = document.querySelector('.error-state');
    out.errorHintText = errorHintEl ? errorHintEl.textContent : null;
    out.errorStateVisible = errorStateEl ?
      window.getComputedStyle(errorStateEl).display !== 'none' : null;

    /* A failed poll must not silently re-render the old reading with no sign
       it is stale - see .head .updated.is-stale in TaskQueue.css. */
    var updatedEl = document.getElementById('updated');
    out.updatedIsStale = updatedEl ? updatedEl.classList.contains('is-stale') : null;
    out.updatedText = updatedEl ? updatedEl.textContent : null;
    out.feedCalls = window.__FEED_CALLS__ || 0;

    var activeView = document.querySelector('.view.is-active');
    out.activeViewClasses = activeView ? activeView.getAttribute('class') : null;
    var activeDot = document.querySelector('.dots .dot.is-active');
    out.activeDotView = activeDot ? activeDot.getAttribute('data-view') : null;

    /* THE CLOCK COVERS NOTHING. An overlap is not an overflow: the clock is
       absolutely positioned over the views, so when it lands on a row both
       boxes are still legitimately inside .widget-root and every edge is
       correct. The queue view shipped drawing the time across the last repo's
       figures and 62 geometry checks saw nothing wrong. Collect any visible
       leaf that carries text and intersects the clock's box. */
    var clockEl = document.getElementById('clock');
    out.clockPresent = !!clockEl;
    out.clockOverlaps = [];
    /* An inline style attribute is not how anything here gets positioned - the
       stylesheet does that - so probing for one always misses. What actually
       takes an element out of flow and over its siblings is a COMPUTED
       position of absolute or fixed; that is what must be probed for. */
    var overlay = clockEl;
    if (!overlay) {
      var overlayCandidates = document.querySelectorAll('.widget-root *');
      for (var oi = 0; oi < overlayCandidates.length; oi++) {
        var candidatePos = window.getComputedStyle(overlayCandidates[oi]).position;
        if (candidatePos === 'absolute' || candidatePos === 'fixed') {
          overlay = overlayCandidates[oi];
          break;
        }
      }
    }
    if (overlay && window.getComputedStyle(overlay).display !== 'none') {
      var c = overlay.getBoundingClientRect();
      if (c.width > 0 && c.height > 0) {
        var all = document.querySelectorAll('.content *');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el === overlay || el.children.length) continue;
          if (!(el.textContent || '').trim()) continue;
          if (el.offsetParent === null) continue;
          var r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          /* A row scrolled out of view inside a paging list still reports its
             unclipped layout rect, which can sit anywhere - including over the
             clock. It is not PAINTED there, so it is not an overlap. Measure
             only what its scrolling ancestor actually shows. */
          var sc = scrollingAncestor(el);
          if (sc) {
            var sr = sc.getBoundingClientRect();
            if (r.bottom <= sr.top + 0.5 || r.top >= sr.bottom - 0.5) continue;
          }
          var over = r.left < c.right && r.right > c.left &&
                     r.top < c.bottom && r.bottom > c.top;
          if (over) {
            out.clockOverlaps.push(pathOf(el, document.querySelector('.widget-root')) +
              ' ("' + (el.textContent || '').trim().slice(0, 32) + '")');
          }
        }
      }
    }

    /* --- projects view --- */
    out.tabNames = Array.prototype.map.call(
      document.querySelectorAll('#tabs .tab .tab-name'), function (e) { return e.textContent; });
    out.tabActive = Array.prototype.map.call(
      document.querySelectorAll('#tabs .tab.is-active .tab-name'), function (e) { return e.textContent; });
    out.taskRowCount = Array.prototype.filter.call(
      document.querySelectorAll('#task-rows li'), function (e) { return e.offsetParent !== null; }).length;
    out.taskRowsInDom = document.querySelectorAll('#task-rows li').length;
    out.rowNames = Array.prototype.map.call(
      document.querySelectorAll('#task-rows li[data-state] .row-name'), function (e) { return e.textContent; });
    out.rowStates = Array.prototype.map.call(
      document.querySelectorAll('#task-rows li[data-state]'), function (e) { return e.getAttribute('data-state'); });
    out.stateColours = {};
    ['running', 'blocked', 'waiting', 'queued', 'done'].forEach(function (st) {
      var e = document.querySelector('#task-rows li.st-' + st + ' .row-name');
      out.stateColours[st] = e ? window.getComputedStyle(e).color : null;
    });
    out.stateMarks = {};
    ['running', 'blocked', 'waiting', 'done', 'queued'].forEach(function (st) {
      var e = document.querySelector('#task-rows li.st-' + st + ' .row-name');
      out.stateMarks[st] = e ? (e.textContent || '').slice(0, 2) : null;
    });
    /* Page dots are what an advancing region grows. Their absence is how this
       asserts the projects list does not page itself. */
    out.tabCounts = Array.prototype.map.call(
      document.querySelectorAll('#tabs .tab .tab-count'), function (e) { return e.textContent; });
    out.moreLine = (function () {
      var e = document.querySelector('#task-rows li.st-more');
      return e ? e.textContent : null;
    })();
    out.waitingMeta = (function () {
      var e = document.querySelector('#task-rows li.st-waiting .row-figure');
      return e ? e.textContent : null;
    })();
    out.mainOnlyRows = Array.prototype.filter.call(
      document.querySelectorAll('#task-rows li.st-queued .row-figure'),
      function (e) { return /main only/.test(e.textContent); }).length;
    out.projectPageDots = document.querySelectorAll('.view-projects .pages').length;
    out.otherPageDots = document.querySelectorAll('.view-queue .pages, .view-live .pages').length;
    out.taskHeadingText = (function () {
      var h = document.querySelector('#list-tasks h2');
      return h ? h.textContent.trim() : null;
    })();
    var pnote = document.getElementById('projects-note');
    out.projectsNoteText = pnote ? pnote.textContent : null;
    out.projectsNoteDisplay = pnote ? window.getComputedStyle(pnote).display : null;
    out.queuedTaskMeta = (function () {
      var e = document.querySelector('#task-rows li.st-queued .row-figure');
      return e ? e.textContent : null;
    })();
    out.blockedTaskMeta = (function () {
      var e = document.querySelector('#task-rows li.st-blocked .row-figure');
      return e ? e.textContent : null;
    })();
    out.doneTaskMeta = (function () {
      var e = document.querySelector('#task-rows li.st-done .row-figure');
      return e ? e.textContent : null;
    })();

    /* --- what was actually asked of the feed, and what is still unanswered --- */
    out.projectFetchLog = (window.__PROJECT_LOG__ || []).slice();
    out.raceInFlightAtRelease = window.__RACE_INFLIGHT__ || null;
    out.raceReleased = window.__RACE_RELEASED__ || null;
    out.projectsUnanswered = (window.__HELD__ || [])
      .filter(function (h) { return !h.settled; })
      .map(function (h) { return h.name; });

    out.pageErrors = (window.__ERRORS__ || []).slice(0, 5);
    return out;
  }


  /* Tap at a POINT, the way a finger does. The widget resolves which tab was
     hit with elementFromPoint, so aiming at coordinates is what exercises that
     path; dispatching a click on the button would prove nothing about it. */
  function tapAt(x, y) {
    var opts = { clientX: x, clientY: y, bubbles: true, cancelable: true };
    document.dispatchEvent(new PointerEvent('pointerdown', opts));
    document.dispatchEvent(new PointerEvent('pointerup', opts));
  }

  setTimeout(function () {
    for (var i = 0; i < __TAPS__; i++) tap();
    var wantTab = __TAB_INDEX__;
    if (wantTab >= 0) {
      var tabs = document.querySelectorAll('#tabs .tab');
      if (tabs[wantTab]) {
        var tb = tabs[wantTab].getBoundingClientRect();
        tapAt(tb.left + tb.width / 2, tb.top + tb.height / 2);
      }
    }
    /* A real refresh, through the entry point iCUE itself calls - which is
       what re-fetches the feed - rather than by poking the widget's internals.
       The 15s poll is far too long for a harness, and asserting that the
       source contains a call would prove nothing about whether it runs. */
    /* THE INTERLEAVING. Two requests are outstanding - one for the tab the
       reader left, one for the tab they are on. The ABANDONED one is answered
       first, and only after that does the poll come round again. Every step is
       on its own timeout rather than left to microtask order, so this is the
       sequence that runs rather than whichever one the engine happens to pick.
       Both requests answering instantly, as they do everywhere else in this
       file, makes the defect this constructs unreachable. */
    var release = __RACE_RELEASE__;
    if (release) {
      var held = window.__HELD__ || [];
      window.__RACE_INFLIGHT__ = held.filter(function (h) { return !h.settled; })
        .map(function (h) { return h.name; });
      window.__RACE_RELEASED__ = null;
      for (var hi = 0; hi < held.length; hi++) {
        if (held[hi].name === release && !held[hi].settled) {
          held[hi].settled = true;
          window.__RACE_RELEASED__ = release;
          held[hi].release();
          break;
        }
      }
      /* The poll, after the stale answer has been fully handled. */
      setTimeout(function () { window.TaskQueue.onDataUpdated(); }, 40);
    }
    if (__REFRESH__) window.TaskQueue.onDataUpdated();
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

function writePage(name, taps, fixture, mutate, projects, tabIndex, projectsAfter, refresh, opts) {
  const o = opts || {};
  const payloadJson = JSON.stringify(fixture).replace(/<\/script/gi, '<\\/script');
  const projectsJson = JSON.stringify(projects || {}).replace(/<\/script/gi, '<\\/script');
  const afterJson = JSON.stringify(projectsAfter || {}).replace(/<\/script/gi, '<\\/script');
  let html = indexSrc.replace(SCRIPT_TAG, HARNESS
    .replace('__TAB_INDEX__', String(tabIndex == null ? -1 : tabIndex))
    .replace('__REFRESH__', refresh ? 'true' : 'false')
    .replace('__CONTROL_JSON__', () => JSON.stringify(o.control || {}))
    .replace('__FEED_FAIL_ON__', String(o.feedFailOn || 0))
    .replace('__RACE_RELEASE__', () => JSON.stringify(o.release || null))
    .replace('__PROJECT_BODIES_AFTER__', afterJson)
    .replace('__PROJECT_BODIES__', projectsJson)
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
  return writePage(name, 0, baseFixture(), htmlMutate);
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

const CASES = [
  { name: 'queue', taps: 0, want: 'queue', fixture: baseFixture() },
  { name: 'queue-finished', taps: 0, want: 'queue', fixture: finishedFixture() },
  { name: 'queue-unavailable', taps: 0, want: 'queue', fixture: unavailableFixture() },
  { name: 'queue-repo-error', taps: 0, want: 'queue', fixture: repoErrorFixture() },
  { name: 'live', taps: 1, want: 'live', fixture: runningFixture() },
  { name: 'live-idle', taps: 1, want: 'live', fixture: idleFixture() },
  { name: 'history', taps: 2, want: 'history', fixture: historyFixture() },
  { name: 'history-none', taps: 2, want: 'history', fixture: noHistoryFixture() },
  { name: 'files', taps: 3, want: 'files', fixture: filesFixture() },
  { name: 'files-alarms', taps: 3, want: 'files', fixture: alarmFixture() },
  /* THE STALE READING. Data older than 3 refresh cycles is already rendered,
     and the poll that comes after it rejects outright - a dropped connection,
     not a bad HTTP status. The old reading must stay on screen (2fe3364's
     "keep the last good reading" rule still holds) but marked stale, so the
     panel does not claim a dead queue is a live one. */
  { name: 'queue-stale-after-reject', taps: 0, want: 'queue', fixture: staleFixture(),
    refresh: true, feedFailOn: 2 },
  /* THE OPPOSITE CLAIM. A fresh reading, refreshed again successfully, must
     NOT be marked stale - otherwise "is-stale" could be passing above for the
     wrong reason (always on) rather than because the poll actually failed. */
  { name: 'queue-fresh-after-refresh', taps: 0, want: 'queue', fixture: baseFixture(),
    refresh: true }
];

/* The projects view needs the second endpoint stubbed and, for the tab test, a
   tap aimed at a tab's centre after the view taps. */
/* The same project, but with a task that has STARTED RUNNING since the view
   was opened. This is the state the widget froze out of: the list is fetched
   separately from the overview, so a poll that refreshed the overview left it
   holding whatever it had on arrival, and nothing ever turned green. */
const PROJECT_BODIES_AFTER = {
  SIDM2: (function () {
    const b = projectFixture('SIDM2', 120, 4, 2, 10, 20, 42);
    b.tasks.unshift({
      id: 'sf2-automation-stubs', title: 'sf2-automation-stubs',
      mode: 'subtask', model: 'sonnet', effort: 'medium', lane: 'serial',
      blocked: null, state: 'running', reason: null, needsMain: false, waitingOn: null
    });
    return b;
  })()
};

/* What the server answers a project request with when it cannot serve one -
   the same shape the overview's 503 carries, because it is the same contract.
   As long as a real filesystem error, because that is what has to fit. */
const PROJECT_ERROR_TEXT =
  'whattask.json could not be read for SIDM2: EBUSY, resource busy or locked';

/* A 200 whose body is not a task list at all: a proxy's own JSON, a half-built
   snapshot, a renamed field. There is no `project` in it, so nothing can match
   it to the tab on screen - and the tab on screen already has rows. */
const SHAPELESS_AFTER = {
  SIDM2: { ok: true, generatedAt: Date.now(), items: [] }
};

const PROJECT_CASES = [
  { name: 'projects', taps: 4, want: 'projects', fixture: baseFixture(), tab: null },
  { name: 'projects-tab-2', taps: 4, want: 'projects', fixture: baseFixture(), tab: 1 },
  { name: 'projects-many', taps: 4, want: 'projects', fixture: manyProjectsFixture(), tab: null },
  { name: 'projects-none', taps: 4, want: 'projects', fixture: unavailableFixture(), tab: null },
  { name: 'projects-refreshed', taps: 4, want: 'projects', fixture: baseFixture(),
    tab: null, after: PROJECT_BODIES_AFTER, refresh: true },
  /* The project endpoint's own three-state contract, same as the overview's:
     a non-2xx carries the real reason in a JSON body. Read it. */
  { name: 'projects-http-error', taps: 4, want: 'projects', fixture: baseFixture(),
    tab: null, control: { status: 503, body: { error: PROJECT_ERROR_TEXT } } },
  /* A 200 that is not a task list. The first answer is a real one, so there
     ARE rows on screen for the second - shapeless - answer to leave standing. */
  { name: 'projects-shapeless', taps: 4, want: 'projects', fixture: baseFixture(),
    tab: null, after: SHAPELESS_AFTER, refresh: true },
  /* Two requests outstanding at once, the abandoned tab's answered first. */
  { name: 'projects-race', taps: 4, want: 'projects', fixture: baseFixture(),
    tab: 1, control: { hold: true }, release: 'SIDM2' },
  /* THE GAP. `control: { hold: true }` with no `release` never answers at
     all within the render, which is exactly "the fetch resolves LATE" as far
     as anything measured here can tell - there is no data yet and there is
     not going to be one before the page measures itself. First entry into
     the view: the very first ?project= request the widget ever makes. */
  { name: 'projects-pending-first', taps: 4, want: 'projects', fixture: baseFixture(),
    tab: null, control: { hold: true } },
  /* Same gap, reached the other way: a tab already showing SIDM2 is pressed
     to h2g, whose own request is the one left outstanding. */
  { name: 'projects-pending-tab', taps: 4, want: 'projects', fixture: baseFixture(),
    tab: 1, control: { hold: true } }
];

const results = [];
for (const c of CASES) {
  const r = render(writePage(c.name, c.taps, c.fixture, null, null, null, null, c.refresh,
                             { feedFailOn: c.feedFailOn }));
  r.name = c.name;
  r.wantView = c.want;
  results.push(r);
  if (r.error) fail(`${c.name}: ${r.error}`);
}
for (const c of PROJECT_CASES) {
  const r = render(writePage(c.name, c.taps, c.fixture, null, PROJECT_BODIES, c.tab,
                             c.after, c.refresh,
                             { control: c.control, release: c.release }));
  r.name = c.name;
  r.wantView = c.want;
  results.push(r);
  if (r.error) fail(`${c.name}: ${r.error}`);
}

/* The feed's own error, boot-order case: server up, no snapshot, answered as a
   503 with { error: '...' }. The rendered hint must carry that text and must
   NOT carry the fixed start-the-server advice - the server IS running, so that
   advice is wrong. This is the behaviour 2fe3364 established for the usage
   widget, ported with the code. */
const FEED_ERROR_TEXT = 'no snapshot has ever been built: rebuild threw TypeError at line 12';
const feedErrorResult = render(writeErrorBodyPage('feed-error-body', 503, FEED_ERROR_TEXT));
if (feedErrorResult.error) fail(`feed-error-body: ${feedErrorResult.error}`);
check('a 503 with an error body is shown as error-state',
  feedErrorResult.errorStateVisible, true);
check('the rendered hint contains the feed\'s own error text',
  (feedErrorResult.errorHintText || '').includes(FEED_ERROR_TEXT), true);
check('the rendered hint does NOT carry the fixed start-the-server advice',
  (feedErrorResult.errorHintText || '').includes('Start it with'), false);

const ok = results.filter(r => !r.error);
check('every render came back', ok.length, results.length);
if (!ok.length) {
  console.log('\nnothing rendered, so nothing below was tested');
  console.log(`${failures} FAILED`);
  process.exit(1);
}
const byName = {};
for (const r of ok) byName[r.name] = r;

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
check('no render reported an unreadable box',
  ok.flatMap(r => r.notes.map(n => `${r.name}: ${n}`)), []);
check('no page threw while booting or rendering',
  ok.flatMap(r => (r.pageErrors || []).map(e => `${r.name}: ${e}`)), []);
/* Not covered by the overflow check: the clock sits OVER the views, so
   overlapping a row breaks no box. It reached the device that way. */
/* The clock is gone. The overlap probe stays, because it is not about the
   clock - it is about anything positioned OVER the views, which breaks no box
   and so is invisible to the overflow check. It reports nothing while there is
   nothing overlaid, and will report the next thing that is. */
check('nothing is drawn over the content, in any view',
  ok.flatMap(r => (r.clockOverlaps || []).map(o => `${r.name}: ${o}`)), []);
check('and the clock really is gone rather than merely hidden',
  ok.every(r => r.clockPresent === false), true);

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

console.log('the task files view:');
check('every repo gets a row', byName['files'].fileRowNames.length, 5);
check('with a column per task file plus the mutex',
  byName['files'].fileHeads, ['', 'queue', 'runs', 'lock', 'decis', 'interv', 'mutex']);
/* Absence is real state: h2g has no serial.lock, claude-setup no runs.jsonl.
   A dash, not a zero, which would read as a file that exists and is empty. */
/* h2g is missing three (lock, decisions, interview) and claude-setup four
   (runs and the same three). */
check('a file that is not there is marked absent rather than shown as zero',
  byName['files'].fileAbsentCells, 7);
check('a clean machine shows no alarm strip at all',
  byName['files'].alarmsDisplay, 'none');
check('and says so in the header rather than leaving it to be inferred',
  byName['files'].reposText, '5 repos · all clear');
check('every mutex reads free when nothing is held',
  byName['files'].mutexCells.every(c => c === '○:free'), true);

console.log('when something is wrong:');
check('both faults are raised, above the table',
  byName['files-alarms'].alarmCount, 2);
/* An orphan and a stuck mutex are different faults - one refuses a named set
   of paths, the other blocks everything - so they must not look alike. */
check('and are distinguishable from each other',
  byName['files-alarms'].alarmKinds, ['alarm-orphan', 'alarm-stale-mutex']);
check('the orphan names the dead pid and what it is holding up',
  /pid 26852 is not running, so 8 paths stay refused/.test(byName['files-alarms'].alarmTexts[0]), true);
check('the header counts them instead of saying all clear',
  byName['files-alarms'].reposText, '5 repos · 2 alarms');
check('and the stale mutex is marked in its own cell too',
  byName['files-alarms'].mutexCells[0], '●:stale');

/* An undefined custom property is silently invalid - the declaration is
   dropped and the element keeps its inherited colour. var(--accent) shipped
   like that and nothing caught it, because geometry cannot see a colour. */
console.log('colours that carry meaning actually resolve:');
{
  /* Read from the render where each element actually exists: the holder rows
     are only built on the live view, the alarm strip only on the files one. */
  const live = byName['live'].colours;
  const files = byName['files-alarms'].colours;
  check('a lock holder row resolves a colour at all', !!live.holderName, true);
  check('and is coloured differently from a session row',
    live.holderName !== live.sessionName, true);
  check('an alarm sign is not just body text', files.alarmSign !== files.bodyText, true);
  check('a stale mutex cell is not just body text', files.staleMutex !== files.bodyText, true);
}

console.log('the projects view:');
check('a tab per project', byName['projects'].tabNames, 
  ['SIDM2', 'h2g', 'claude-setup', 'icue', 'tdz-c64-knowledge']);
check('exactly one is selected', byName['projects'].tabActive.length, 1);
/* Which project has work, without pressing through all five. */
check('each tab carries its open count',
  byName['projects'].tabCounts, ['120', '83', '3', '2', '2']);
check('and it is the first until something is pressed',
  byName['projects'].tabActive[0], 'SIDM2');
/* The count is of OPEN work - 120 queued/blocked plus 2 running - with the 42
   done rows below it as history. Folding those in would make the queue look
   larger than it is. */
/* Waiting is called out because it changes what "open" means: a fifth of it
   may not be pickable at all. */
check('whose tasks are what is listed, counted as open work',
  byName['projects'].taskHeadingText,
  'SIDM2 · 142 open · 2 running · 20 waiting · 30 blocked');
check('rows render rather than merely existing',
  byName['projects'].taskRowCount, byName['projects'].taskRowsInDom);
check('a queued row shows its mode, model and effort',
  /^(subtask|main) · (sonnet|opus)\/(low|medium|high|unknown)$/
    .test(byName['projects'].queuedTaskMeta || ''), true);
/* The reason DISPLACES the model and effort rather than joining them: it is
   what decides what happens to the task next, and the row has one line. */
check('a blocked row shows the reason instead',
  /remove-and-re-add/.test(byName['projects'].blockedTaskMeta || ''), true);

console.log('task state, told four ways:');
{
  const st = byName['projects'];
  /* The feed orders running, then blocked, then queued, then done, and the
     view must not reshuffle that - the top of the list is what is happening
     now and the bottom is history. */
  check('running rows come first', st.rowStates.slice(0, 2), ['running', 'running']);
  check('done rows come last', st.rowStates[st.rowStates.length - 1], 'done');
  /* Running, queued, blocked, done. Blocked sits below queued because it is
     not actionable by the runner, which keeps the actionable half of the list
     unbroken at the top. */
  check('queued comes before blocked',
    st.rowStates.indexOf('queued') < st.rowStates.indexOf('blocked'), true);
  check('and blocked before done',
    st.rowStates.indexOf('blocked') < st.rowStates.indexOf('done'), true);
  check('each state is one unbroken run, not interleaved',
    st.rowStates.filter((v, i) => i === 0 || v !== st.rowStates[i - 1]),
    ['running', 'queued', 'blocked', 'waiting', 'done']);

  /* A dependency on a still-open task is not the same as a human blocker: it
     clears itself when the other task lands. 20 of 210 real open tasks are in
     this state and read as plain queued before it existed. */
  check('a waiting row is coloured unlike every other state',
    new Set(['running', 'blocked', 'queued', 'done', 'waiting']
      .map(function (k) { return st.stateColours[k]; })).size, 5);
  check('and carries its own marker', st.stateMarks.waiting, '⋯ ');
  check('saying WHICH task it waits on, not merely that it does',
    /^waiting on SIDM2-task-0$/.test(st.waitingMeta || ''), true);

  /* 52 of 210 seize a stateful singleton. It decides HOW a task runs, so it
     rides with the other run attributes instead of displacing them. */
  check('a main-only task says so alongside its model and effort',
    st.mainOnlyRows > 0, true);

  /* Each state is a COLOUR and a MARKER. The panel is read from across a room
     and at an angle, where hue is the first thing to go - and colour alone is
     nothing to a reader who cannot separate red from green. */
  const c = st.stateColours;
  check('running, blocked and done each resolve a colour',
    [!!c.running, !!c.blocked, !!c.done], [true, true, true]);
  check('running is not the colour of a queued row', c.running !== c.queued, true);
  check('blocked is not the colour of a queued row', c.blocked !== c.queued, true);
  check('done is not the colour of a queued row', c.done !== c.queued, true);
  check('and no two states share a colour',
    new Set([c.running, c.blocked, c.queued, c.done]).size, 4);

  check('running carries its own marker', st.stateMarks.running, '▶ ');
  check('blocked carries its own marker', st.stateMarks.blocked, '⚠ ');
  check('done carries its own marker', st.stateMarks.done, '✓ ');
  check('a queued row carries none, so the markers mean something',
    /^[▶⚠✓]/.test(st.stateMarks.queued || ''), false);

  check('a done row says why it closed rather than a model and effort',
    /Shipped as a fifth view|closed by/.test(st.doneTaskMeta || ''), true);

  /* The device slot shows FOUR rows, measured, so 42 done rows under 120 open
     ones are unreachable there. Only the recent handful travels - and the list
     says what it is leaving out rather than just ending. */
  check('the list says how much history it is not showing',
    st.moreLine, '32 older done tasks not shown');
}

/* The list is fetched separately from the overview, so a poll that refreshes
   the overview has to refresh it too. It did not: the list froze at whatever
   it held when the view was opened, and a task that started running afterwards
   never turned green. Driven through onDataUpdated(), the entry point iCUE
   itself calls. */
console.log('a refresh reaches the task list, not just the overview:');
/* Named, not merely counted: the fixture already had two running rows, so
   "row 0 is running" passes whether or not anything refreshed. */
check('the task that started running since the view opened is on screen',
  byName['projects-refreshed'].rowNames[0], '▶ sf2-automation-stubs');
check('and it was NOT there before the refresh',
  byName['projects'].rowNames.indexOf('▶ sf2-automation-stubs'), -1);
check('three running rows now, where the first fetch had two',
  byName['projects-refreshed'].rowStates.filter(v => v === 'running').length, 3);
check('while a view that was never refreshed still shows the first answer',
  byName['projects'].rowStates.filter(v => v === 'running').length, 2);

/* The project endpoint gets the same three-state treatment the overview got in
   2fe3364: a non-2xx carries the reason in a JSON body, and dropping it left
   the tab showing an empty list, which reads as "this project has no work". */
console.log('the project endpoint answers with an error:');
{
  const e = byName['projects-http-error'];
  check('the reason is on screen rather than an empty list',
    { shown: e.projectsNoteDisplay !== 'none', text: e.projectsNoteText },
    { shown: true, text: PROJECT_ERROR_TEXT });
  check('and no task rows are drawn under it', e.taskRowCount, 0);
}

/* A 200 whose body is not a task list matched no tab, so it was dropped in
   silence and the previous project's rows stayed on screen underneath - a
   stale list that looks live, which is worse than an empty one. */
console.log('the project endpoint answers 200 with something else:');
{
  const s = byName['projects-shapeless'];
  check('the rows the shapeless answer replaced are gone',
    { rows: s.taskRowCount, noteShown: s.projectsNoteDisplay !== 'none' },
    { rows: 0, noteShown: true });
  check('and the note names the project it could not get a list for',
    s.projectsNoteText, 'the feed answered without a task list for SIDM2');
  /* The first answer WAS a real one, so there were rows to leave standing -
     without this the check above could pass on a view that never had any. */
  check('while the same page before the second answer did have rows',
    byName['projects'].taskRowCount > 0, true);
}

/* THE RACE. Both requests are in flight; the abandoned tab's answers first.
   Clearing projectPending on it reports the CURRENT tab's request as finished
   while it is still outstanding, so the next poll fires a second one on top of
   it - two requests for one tab, and whichever lands last wins. */
console.log('a late answer for a tab the reader left:');
{
  const q = byName['projects-race'];
  check('two requests really were outstanding at once',
    q.raceInFlightAtRelease, ['SIDM2', 'h2g']);
  check('and it was the abandoned tab\'s that was answered',
    { released: q.raceReleased, onScreen: q.tabActive }, { released: 'SIDM2', onScreen: ['h2g'] });
  check('the current tab\'s request was still unanswered when the poll came round',
    q.projectsUnanswered.indexOf('h2g') >= 0, true);
  /* The assertion this case exists for: after the poll, the feed has been
     asked for h2g ONCE. Twice means the stale answer cleared the in-flight
     marker. Named in order rather than counted, so a run that asked for the
     wrong project cannot pass. */
  check('so the poll did not fire a second request on top of it',
    q.projectFetchLog, ['SIDM2', 'h2g']);
}

console.log('the projects list does not page itself:');
/* Every other list advances because the webview forwards no drags and a row
   below the fold would otherwise be unreachable. This one is long and meant to
   be read at the reader's own pace, so it holds still. */
check('it grows no page dots', byName['projects'].projectPageDots, 0);
check('while the lists that do page still have theirs',
  byName['queue'].otherPageDots > 0, true);

/* The tap is aimed at the tab's centre in page coordinates, so this exercises
   the elementFromPoint path the device will take - not a synthetic click. */
console.log('pressing a tab:');
check('selects that project instead of cycling the view',
  byName['projects-tab-2'].tabActive, ['h2g']);
check('the view did NOT advance', byName['projects-tab-2'].activeDotView, 'projects');
check('and the list follows the tab',
  byName['projects-tab-2'].taskHeadingText, 'h2g · 83 open');

/* "X · none open" is a claim about the queue - it says the feed was asked and
   answered empty. During the gap before an answer exists at all, that claim
   is false: showing it here is the bug this file exists to catch, not a
   cosmetic one - the panel is read from across a room with no way to tell a
   flash from a fact. */
console.log('the gap before an answer exists:');
{
  const first = byName['projects-pending-first'];
  check('first entry into the view reads as pending, not as an empty project',
    { headingSaysNoneOpen: /none open/.test(first.taskHeadingText || ''),
      headingSaysChecking: /checking/i.test(first.taskHeadingText || '') },
    { headingSaysNoneOpen: false, headingSaysChecking: true });
  check('naming the tab it is checking',
    first.taskHeadingText, 'SIDM2 · checking…');
  check('and no task rows are drawn as if the list had already answered',
    first.taskRowCount > 0 && first.rowStates.length === 0, true);

  const tabP = byName['projects-pending-tab'];
  check('the tab really did switch to the one pressed', tabP.tabActive, ['h2g']);
  check('a tab press with its own request still in flight reads as pending too',
    { headingSaysNoneOpen: /none open/.test(tabP.taskHeadingText || ''),
      headingSaysChecking: /checking/i.test(tabP.taskHeadingText || '') },
    { headingSaysNoneOpen: false, headingSaysChecking: true });
  check('naming the tab just pressed, not the one left',
    tabP.taskHeadingText, 'h2g · checking…');
}

console.log('more projects than fit comfortably:');
check('every tab is still present', byName['projects-many'].tabNames.length, 8);
check('and none of them is pushed off the edge - they narrow instead',
  overflowsIn(byName['projects-many']).map(o => o.path).filter(p => /tab/.test(p)), []);

console.log('no project to show:');
check('says so rather than drawing an empty tab strip',
  /no repo on this machine/.test(byName['projects-none'].projectsNoteText || ''), true);
check('and lists nothing', byName['projects-none'].taskRowCount, 0);

/* THE HEADER SUBTITLE, #repos, across all five views reached by 0-4 taps.
   Only renderQueue and renderFiles ever wrote it, so on the other three it
   held whatever the LAST view to draw it left behind - a sentence about a
   view the reader is no longer looking at. "changed since the last view"
   would pass on two wrong strings; "non-empty" would pass on stale text
   itself. The real property: under view N, #repos is either blank or a
   statement about N - so only queue's and files' own shapes are accepted,
   and anything under live/history/projects that is not blank is, by
   construction, some other view's sentence. */
console.log('the header subtitle does not go stale across views:');
{
  const NAMES = ['queue', 'live', 'history', 'files', 'projects'];
  check('all five view renders came back with no error',
    NAMES.map(n => !!byName[n] && !byName[n].error), NAMES.map(() => true));
  check('and the tap sequence actually landed on each one',
    NAMES.map(n => byName[n] && byName[n].activeDotView), NAMES);

  function subtitleIsAboutItsOwnView(view, text) {
    if (!text) return true;                 /* silence is never stale */
    if (view === 'queue') return /^\d+ repos? · /.test(text);
    if (view === 'files') return /^\d+ repos? · (all clear|\d+ alarms?|\d+ mutex held)$/.test(text);
    return false;   /* live, history and projects have nothing of their own to say here */
  }
  const stale = NAMES
    .map(n => ({ n, text: byName[n] && byName[n].reposText }))
    .filter(({ n, text }) => !subtitleIsAboutItsOwnView(n, text));
  check('#repos names its own view, or says nothing, in every one of the five',
    stale.map(s => `${s.n}: saw "${s.text}"`), []);

  /* Not vacuous: queue and files really do carry their own non-empty
     subtitle here, so the check above is not merely confirming #repos is
     blank everywhere or that the views never rendered. */
  check('queue and files really do have their own subtitle (the check above is not just "always blank")',
    { queue: byName['queue'].reposText, files: byName['files'].reposText },
    { queue: '5 repos · 5 waiting on you', files: '5 repos · all clear' });
}

/* -------------------------------------------------------------------- ellipsis */

function ellipsisedFigsIn(r) {
  return (r.figs || []).filter(f => (f.scrollWidth - f.clientWidth) > ELLIPSIS_EPS_PX);
}

/* ------------------------------------------------------------------ the views */

console.log('the queue view:');
check('every repo reaches the screen', byName['queue'].repoRowCount, 5);
/* The two must agree. When they diverge, rows exist and are not rendered -
   which is exactly how the repo list arrived on the device blank. */
check('and none of them is in the DOM but invisible',
  byName['queue'].repoRowCount, byName['queue'].repoRowsInDom);
check('the list itself is not display:none at the device slot',
  byName['queue'].repoListDisplay !== 'none', true);
check('the busiest repo is listed first', byName['queue'].repoRowNames[0], 'SIDM2');
check('the completion figure is drawn from open and closed',
  byName['queue'].doneValueText, '59%');   /* 307 / (210 + 307) */
check('and the bar is filled to match, within a pixel of rounding',
  Math.abs(byName['queue'].doneFillPercent - 59) <= 1, true);
check('both raw counts are shown, not only the percentage',
  byName['queue'].doneSubText, '307 closed · 210 open');
/* The one count on this view that asks something of whoever is reading it. */
check('the count the human is blocking is called out on its own',
  byName['queue'].reposText, '5 repos · 5 waiting on you');

console.log('a nearly-finished queue:');
/* Finished is the BEST state this meter can be in - it is not a plan
   utilisation gauge running out of room, it is closed / (open + closed).
   A high percentage must never pick up the amber/red styling a high-is-bad
   meter would use at the same number. */
check('96% closed carries neither is-high nor is-critical',
  byName['queue-finished'].doneMeterClasses.filter(c => c === 'is-high' || c === 'is-critical'),
  []);

console.log('a repo that could not be read:');
check('is still listed rather than dropped',
  byName['queue-repo-error'].repoRowCount, 5);
check('and shows its reason instead of a zero that would read as an empty queue',
  byName['queue-repo-error'].repoRowErrors, 1);

/* A failed poll must not silently re-render the old reading with no sign it
   is stale - the usage widget's .head .updated.is-stale is the precedent
   (2fe3364's sibling). Three missed refresh cycles (30s at the 10s default),
   not one: a single dropped poll on a flaky connection is not the same event
   as a feed that has actually gone quiet, and the panel must not cry wolf on
   the first miss. */
console.log('a poll that fails leaves a visible mark on the Updated stamp:');
check('the second poll (the one made to reject) actually ran',
  byName['queue-stale-after-reject'].feedCalls, 2);
check('the rejection was caught rather than left unhandled',
  byName['queue-stale-after-reject'].pageErrors, []);
check('the stamp is marked stale rather than looking current',
  byName['queue-stale-after-reject'].updatedIsStale, true);
check('and the reading itself is still shown, not blanked',
  !!byName['queue-stale-after-reject'].updatedText, true);
/* THE OPPOSITE CLAIM: could the check above pass because is-stale is set on
   EVERY render, poll outcome be damned? A fresh reading, refreshed again
   successfully, proves it is not - if it were unconditional this would also
   read stale. */
check('a healthy poll of fresh data leaves the stamp unmarked',
  byName['queue-fresh-after-refresh'].updatedIsStale, false);
check('and the plain first render of fresh data is unmarked too',
  byName['queue'].updatedIsStale, false);

console.log('no queue anywhere:');
check('the reason replaces the meter',
  byName['queue-unavailable'].queueNoteText,
  'no repo on this machine has a .claude/tasks/whattask.json - run /whattask in one to create a queue');
check('and no meter is drawn at all in that state',
  byName['queue-unavailable'].metersDisplay, 'none');
check('while a feed that does have repos shows no note',
  byName['queue'].queueNoteDisplay, 'none');

console.log('the live view:');
check('holders and activity land in different columns, and are not summed',
  [byName['live'].holderKinds.length, byName['live'].activityKinds.length], [2, 3]);
check('every row in the holders column is a holder',
  byName['live'].holderKinds, ['holder', 'holder']);
check('and no holder leaks into the activity column',
  byName['live'].activityKinds.indexOf('holder'), -1);
check('the holders heading carries its own count, in its own words',
  byName['live'].liveHeadings[0], 'Holding a lock · 2 held');
check('and the activity heading its own',
  byName['live'].liveHeadings[1], 'Claude activity · 3 active');
/* [] is serial.lock's resting state, not a measurement of zero, so the
   heading says "none held" - the same distinction the usage widget's
   "WORKFLOWS · NONE ACTIVE" already draws. */
check('an idle lock says none rather than showing a bare empty column',
  byName['live-idle'].liveHeadings[0], 'Holding a lock · none held');
check('and the activity column still carries its rows, so the view is not blank',
  byName['live-idle'].activityKinds.length, 3);

console.log('the history view:');
/* The rule the usage widget's stats view already carries, for the same
   reason: runs are sparse in time, so a grid packed by array position draws a
   solid block and puts every date in the wrong column. A grid laid out by
   calendar has MORE cells than there are active days, and some of them
   empty. */
{
  /* The property that matters is not a particular cell count - it is that the
     grid covers the CALENDAR SPAN rather than the number of active days. A
     grid packed by array position would have exactly as many cells as there
     are days with runs, and no empty ones. */
  const h = historyFixture().history;
  const keys = Object.keys(h.days).sort();
  const span = (Date.parse(keys[keys.length - 1]) - Date.parse(keys[0])) / 86400000 + 1;
  check('the heatmap covers the whole calendar span between first run and last',
    byName['history'].heatCellsTotal, span);
  check('which is more cells than there are days with runs',
    byName['history'].heatCellsTotal > keys.length, true);
  check('and the days between are drawn as empty cells',
    byName['history'].heatCellsEmpty, span - keys.length);
}
/* No run record carries a timestamp; the date is the commit each record's
   head names. The heading must say so, or the view claims something the data
   cannot support. */
check('the axis is labelled as commit time, not run time',
  /commit/i.test(byName['history'].heatHeadText), true);
/* Five outcomes, not two. A view built for done/partial would drop 41. */
/* Five outcomes, not two. Trimming to the two that fit as headline figures
   would have hidden 41 runs, so they share a strip instead. */
check('every outcome the feed sends reaches the screen',
  ['done', 'partial', 'blocked', 'failed', 'inconclusive']
    .filter(o => byName['history'].outcomeNames.indexOf(o) < 0), []);
check('ordered with the commonest first',
  byName['history'].outcomeNames,
  ['done', 'partial', 'blocked', 'failed', 'inconclusive']);
check('each carrying its own count',
  byName['history'].outcomeCounts, ['453', '111', '22', '10', '9']);
check('alongside the run and day totals',
  ['runs', 'days', 'top model', 'top effort']
    .filter(k => byName['history'].figLabels.indexOf(k) < 0), []);
check('the busiest model is named, not a raw free-text model string',
  byName['history'].figValues[byName['history'].figLabels.indexOf('top model')], 'sonnet');

console.log('history that could not be dated:');
check('says why instead of drawing a grid',
  byName['history-none'].historyNoteText, HISTORY_ERROR);
check('and draws no grid at all in that state',
  byName['history-none'].historyGridDisplay, 'none');
check('while a view with history shows no note',
  byName['history'].historyNoteDisplay, 'none');

/* -------------------------------------------------------------------- ellipsis */

console.log('ellipsis — no headline figure is truncated:');
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

/* ----------------------------------------------------------------- untouched */

console.log('the suite left the widget alone:');
check('no source file was modified by this run',
  SOURCE_FILES.map(hashFile), sourceHashesBefore);

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
