#!/usr/bin/env node
/* Tests what the widget LOOKS like, not what it is made of.
 *
 * Every other suite here is structural: it checks names, counts and state. All
 * of them stayed green while three visual defects reached the device, because
 * counting SVG paths cannot see that three dots read as light rain, and reading
 * a stylesheet cannot see that a line of text no longer fits its column.
 *
 * The seam this file exists for is the third one, and it is the sort that never
 * throws: every text run is inline SVG sized `height:1em; width:auto;
 * max-width:100%`, so a run too wide for its column is silently SCALED DOWN by
 * max-width instead of overflowing. The glyphs stay crisp, the line stays on
 * screen, and the only symptom is that the text is smaller than its declared
 * font-size - which is exactly what the CPC's two 38-character copyright lines
 * do beside the machine art, inside a boot column capped at 56%.
 *
 * So this renders the real page in a real browser and measures the real boxes:
 *
 *   OVERFLOW  no element's box extends outside .screen
 *   SCALING   no text run is rendered narrower than its declared font-size
 *             implies. petscii.js draws a run of N characters into a viewBox
 *             N*ADVANCE-1 wide by CELL_H tall (6 and 8), and CSS gives it
 *             height:1em, so its honest width is (viewBox width / CELL_H) *
 *             font-size. Anything narrower is max-width having shrunk it.
 *
 * All seven themes, at 840x344 (the S-H slot), in both the booting and the
 * settled state - fourteen renders. Chrome is driven headless with
 * --virtual-time-budget to sit inside or past the 2000ms boot, and the
 * measurements come back through --dump-dom in a data-layout attribute, which
 * is the pattern already used in this repo and needs no CDP client.
 *
 * Everything Chrome writes - its profile above all - goes under os.tmpdir().
 * Nothing is written inside the repo.
 *
 * Usage:  node C64Weather/test/layout.test.js
 *         CHROME_PATH=/path/to/chrome node C64Weather/test/layout.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WIDTH = 840;
const HEIGHT = 344;
const THEMES = ['c64', 'pet', 'bbc', 'cpc', 'spectrum', 'amiga', 'modern'];

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

/* ------------------------------------------------------- metrics, not guesses */

/* Read out of the sources rather than copied: a duplicated constant that drifts
   would make every expectation below quietly wrong, and the extraction is
   asserted so a rename fails loudly instead of defaulting to nothing. */
const petsciiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'petscii.js'), 'utf8');
const widgetSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'widget.js'), 'utf8');

function num(src, name, what) {
  const m = src.match(new RegExp('var ' + name + ' = (\\d+)'));
  return m ? Number(m[1]) : null;
}
const CELL_H = num(petsciiSrc, 'CELL_H');
const GLYPH_W = num(petsciiSrc, 'GLYPH_W');
const ADVANCE = num(petsciiSrc, 'ADVANCE');
const BOOT_MS = num(widgetSrc, 'BOOT_MS');

console.log('metrics:');
check('the glyph metrics were read out of petscii.js',
  [CELL_H, GLYPH_W, ADVANCE], [8, 5, 6]);
check('BOOT_MS was read out of widget.js', BOOT_MS, 2000);
if (failures) {
  console.log('\nthe source constants could not be read; every expectation below would be vacuous');
  console.log(`${failures} FAILED`);
  process.exit(1);
}

/* ---------------------------------------------------------------- tolerances */

/* Chrome lays out on a 1/64px grid, and a text run's width is its height times
   an aspect ratio that reaches ~28 for the CPC's 38-character copyright, so a
   single LayoutUnit of snapping in the height shows up as nearly half a pixel
   of width. Add the rounding in the computed font-size itself and a flat 0.5px
   is too tight to be stable across platforms. 1px or 1% of the expected width,
   whichever is larger, keeps that noise out while staying far below any real
   defect: max-width only ever engages once a run is wider than its column, and
   the shrink it applies is then tens of percent, not one. */
const SCALE_EPS_PX = 1;
const SCALE_EPS_REL = 0.01;
/* Overflow is compared against a box that is laid out, not scaled, so the only
   error is the same subpixel snapping; 1px, and the report prints the real
   amount so a marginal miss is legible rather than mysterious. */
const OVERFLOW_EPS_PX = 1;

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

/* The whole widget is copied out of the repo so the injected harness never
   touches a tracked file, and so the overflow mutation check has somewhere to
   scribble. Copying the tree rather than rewriting paths keeps the relative
   <script>/<link> hrefs in index.html working untouched. */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'c64weather-layout-'));
const PAGES = path.join(WORK, 'widget');
const PROFILE = path.join(WORK, 'chrome-profile');
fs.cpSync(ROOT, PAGES, {
  recursive: true,
  filter: src => !src.split(/[\\/]/).includes('test')
});

function fileUrl(p) {
  return 'file:///' + encodeURI(path.resolve(p).replace(/\\/g, '/'));
}

/* Measured inside the page. Kept as one string so what runs in the browser is
   visible here in one piece; __THEME__ and __AT__ are substituted per render. */
const HARNESS = `<script>
window.theme = '__THEME__';
window.cityName = 'Copenhagen';
(function () {
  /* A fresh profile per run should be enough, but file:// storage behaves
     differently across platforms and a leaked theme override would silently
     render the wrong machine. An in-memory stub removes the question. */
  try {
    var mem = {};
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; },
        clear: function () { mem = {}; }
      }
    });
  } catch (e) { /* leave the real one; the profile is disposable anyway */ }

  /* Shapes taken from resolveLocation() and fetchWeather() in widget.js, not
     invented: the geocoder answers {results:[...]}, the forecast answers
     {current:{...},daily:{...}} and fetchWeather throws unless
     current.temperature_2m is a number. */
  var GEO = { results: [{ latitude: 55.68, longitude: 12.57, name: 'Copenhagen', country_code: 'DK' }] };
  var WX = {
    current: {
      temperature_2m: -12.4, apparent_temperature: -18.2, relative_humidity_2m: 93,
      wind_speed_10m: 128.6, weather_code: 86, is_day: 1
    },
    daily: {
      temperature_2m_max: [-8.1], temperature_2m_min: [-19.7],
      sunrise: ['2026-01-14T08:37'], sunset: ['2026-01-14T16:02']
    }
  };
  window.fetch = function (url) {
    var body = (String(url).indexOf('geocoding') >= 0) ? GEO : WX;
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(body); }
    });
  };

  var CELL_H = __CELL_H__, ADVANCE = __ADVANCE__;

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
    return '.screen > ' + parts.join(' > ');
  }

  function measure() {
    var out = {
      theme: '__THEME__', at: __AT__, overflow: [], runs: [], notes: [],
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
    var root = document.querySelector('.widget-root');
    var screen = document.querySelector('.screen');
    if (!root || !screen) { out.notes.push('no .widget-root or .screen in the page'); return out; }

    out.booting = root.classList.contains('is-booting');
    out.rootClass = root.getAttribute('class') || '';
    var sr = screen.getBoundingClientRect();
    out.screen = { left: sr.left, top: sr.top, right: sr.right, bottom: sr.bottom,
                   width: sr.width, height: sr.height };

    var all = screen.querySelectorAll('*');
    for (var n = 0; n < all.length; n++) {
      var el = all[n];
      /* Geometry inside an <svg> is clipped to its own viewport by the SVG
         overflow default, so it cannot leave .screen without its root leaving
         first - and reporting every one of a glyph's rects would bury the
         finding that matters. The roots themselves are still measured. */
      if (el.ownerSVGElement) continue;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;

      var over = {
        left: sr.left - r.left, top: sr.top - r.top,
        right: r.right - sr.right, bottom: r.bottom - sr.bottom
      };
      var worst = Math.max(over.left, over.top, over.right, over.bottom);
      if (worst > 0) {
        out.overflow.push({ path: pathOf(el, screen), by: worst, sides: over,
                            width: r.width, height: r.height });
      }
      /* The closest any box came to the edge, overflowing or not. A layout that
         clears .screen by a tenth of a pixel is a defect waiting for a font
         substitution, and this is the only place it is visible. */
      if (!out.tightest || worst > out.tightest.by) {
        out.tightest = { path: pathOf(el, screen), by: worst };
      }

      if (el.tagName.toLowerCase() !== 'svg') continue;
      /* textSVG() emits class="px" alone; sprites, stat glyphs and machine art
         all carry a second class and are sized by different rules. */
      var cls = (el.getAttribute('class') || '').trim();
      if (cls !== 'px') continue;
      var vb = (el.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
      var vbW = vb[2], vbH = vb[3];
      if (!(vbW > 0) || vbH !== CELL_H) { out.notes.push('unexpected text viewBox ' + cls + ' ' + vb.join(' ')); continue; }
      if ((vbW + 1) % ADVANCE !== 0) continue;   /* the width-1 empty-string placeholder */
      out.runs.push({
        path: pathOf(el, screen),
        chars: (vbW + 1) / ADVANCE,
        vbW: vbW,
        label: el.parentElement ? (el.parentElement.getAttribute('aria-label') || '') : '',
        fontSize: parseFloat(cs.fontSize),
        width: r.width,
        height: r.height
      });
    }
    return out;
  }

  setTimeout(function () {
    var payload;
    try { payload = JSON.stringify(measure()); }
    catch (e) { payload = JSON.stringify({ notes: ['measure threw: ' + e] }); }
    document.documentElement.setAttribute('data-layout', encodeURIComponent(payload));
  }, __AT__);
})();
</script>
`;

const SCRIPT_TAG = '<script type="text/javascript" src="scripts/petscii.js"></script>';
const indexSrc = fs.readFileSync(path.join(PAGES, 'index.html'), 'utf8');
check('the petscii script tag was found, so the harness has somewhere to go',
  indexSrc.includes(SCRIPT_TAG), true);

function writePage(name, theme, at, mutate) {
  let html = indexSrc.replace(SCRIPT_TAG, HARNESS
    .replace(/__THEME__/g, theme)
    .replace(/__AT__/g, String(at))
    .replace(/__CELL_H__/g, String(CELL_H))
    .replace(/__ADVANCE__/g, String(ADVANCE)) + SCRIPT_TAG);
  if (mutate) html = mutate(html);
  const p = path.join(PAGES, name + '.html');
  fs.writeFileSync(p, html);
  return p;
}

/* --window-size sizes the WINDOW, and Chrome's current headless mode still
   builds one with browser UI in it: asking for 840x344 gets a 824x193 viewport
   here, and the deficit differs by platform and Chrome version. Hard-coding the
   difference would rot, and a widget measured in the wrong slot is a test that
   measures nothing, so the deficit is found by asking a blank page how big it
   ended up and correcting until the viewport is exactly the slot. */
let winW = WIDTH, winH = HEIGHT;

function render(page, at, sizeW, sizeH) {
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
    `--window-size=${sizeW || winW},${sizeH || winH}`,
    `--virtual-time-budget=${at + 800}`,
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

/* Inside the boot window and well past it. The widget starts its boot during
   the load pass, so 45% of BOOT_MS is comfortably mid-boot. */
const STATES = [
  { name: 'booting', at: Math.round(BOOT_MS * 0.45), booting: true },
  { name: 'settled', at: BOOT_MS + 1500, booting: false }
];

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
  const probe = render(CALIBRATE, 0, winW, winH);
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
const results = [];
for (const theme of THEMES) {
  for (const st of STATES) {
    const page = writePage(`${theme}-${st.name}`, theme, st.at);
    const r = render(page, st.at);
    r.theme = theme;
    r.state = st.name;
    r.wantBooting = st.booting;
    results.push(r);
    if (r.error) fail(`${theme}/${st.name}: ${r.error}`);
  }
}
const ok = results.filter(r => !r.error);
check('all fourteen renders came back', ok.length, THEMES.length * STATES.length);
if (!ok.length) {
  console.log('\nnothing rendered, so nothing below was tested');
  console.log(`${failures} FAILED`);
  process.exit(1);
}

/* --------------------------------------------------------- the renders are real */

/* A render that measured the wrong thing would report no overflow and no
   scaling for a very dull reason, so the shape of every capture is asserted
   before anything is concluded from it. */
console.log('the captures are of what they claim to be:');
check('every render is the theme it asked for',
  ok.filter(r => !r.rootClass.split(/\s+/).includes('theme-' + r.theme)).map(r => `${r.theme}/${r.state}`), []);
check('the booting captures are inside the boot window and the settled ones past it',
  ok.filter(r => {
    /* Modern has no startup screen to play, so it is never in the booting
       class - that is the theme, not a miscapture. */
    const want = r.wantBooting && r.theme !== 'modern';
    return r.booting !== want;
  }).map(r => `${r.theme}/${r.state}`), []);
/* The slot is the whole point: measured at the wrong size, every box below
   would be measured against the wrong screen. */
check('every render happened at the 840x344 slot',
  ok.filter(r => !r.viewport || r.viewport.width !== WIDTH || r.viewport.height !== HEIGHT)
    .map(r => `${r.theme}/${r.state} ${r.viewport ? r.viewport.width + 'x' + r.viewport.height : 'unknown'}`), []);
check('.screen was measured at the slot it was rendered at',
  ok.filter(r => !(r.screen && r.screen.width > 700 && r.screen.height > 200)).map(r => `${r.theme}/${r.state}`), []);
check('every pixel-font theme produced text runs to measure',
  ok.filter(r => r.theme !== 'modern' && r.runs.length === 0).map(r => `${r.theme}/${r.state}`), []);
/* Modern renders its text as real DOM text, so it has no runs by design;
   asserting that keeps the exemption above honest. */
check('and modern, which uses the system font, produced none',
  ok.filter(r => r.theme === 'modern' && r.runs.length > 0).map(r => `${r.theme}/${r.state}`), []);
const noted = ok.flatMap(r => r.notes.map(n => `${r.theme}/${r.state}: ${n}`));
check('no render reported an unreadable box', noted, []);
console.log(`  note  ${ok.reduce((n, r) => n + r.runs.length, 0)} text runs measured across ${ok.length} renders`);

/* ------------------------------------------------------------------- overflow */

function overflowsIn(r) {
  return (r.overflow || []).filter(o => o.by > OVERFLOW_EPS_PX);
}

console.log('overflow — nothing reaches outside .screen:');
{
  let bad = 0;
  for (const r of ok) {
    for (const o of overflowsIn(r)) {
      bad++;
      const side = ['left', 'top', 'right', 'bottom']
        .filter(s => o.sides[s] > OVERFLOW_EPS_PX).join('/');
      fail(`${r.theme}/${r.state}: ${o.path} is ${o.by.toFixed(1)}px past the ${side} of .screen` +
        ` (its box is ${o.width.toFixed(1)}x${o.height.toFixed(1)})`);
    }
  }
  if (!bad) console.log(`  pass  every box in all ${ok.length} renders is inside .screen`);
  const tight = ok.filter(r => r.tightest).sort((a, b) => b.tightest.by - a.tightest.by)[0];
  if (tight) {
    console.log(`  note  tightest fit: ${tight.theme}/${tight.state} ${tight.tightest.path}` +
      `, ${(-tight.tightest.by).toFixed(1)}px of headroom`);
  }
}

/* -------------------------------------------------------------------- scaling */

/* The one that matters. A run of N characters is drawn into a viewBox
   N*ADVANCE-1 by CELL_H and given height:1em, so at font-size F its honest
   width is vbW/CELL_H * F. Narrower means max-width:100% scaled it down to fit
   a column it does not fit - the text is quietly smaller than the size the
   stylesheet declares, which is invisible to every structural test and to a
   screenshot glanced at. */
function expectedWidth(run) {
  return run.vbW / CELL_H * run.fontSize;
}
function scaledRuns(r) {
  return (r.runs || []).filter(run => {
    const want = expectedWidth(run);
    return (want - run.width) > Math.max(SCALE_EPS_PX, want * SCALE_EPS_REL);
  });
}

console.log('scaling — no text run is smaller than its declared font-size:');
{
  let bad = 0;
  for (const r of ok) {
    for (const run of scaledRuns(r)) {
      bad++;
      const want = expectedWidth(run);
      const pct = (run.width / want * 100).toFixed(1);
      fail(`${r.theme}/${r.state}: ${run.path} is scaled to ${pct}% of its declared size`);
      console.log(`        ${run.chars} chars at font-size ${run.fontSize.toFixed(2)}px` +
        ` wants ${want.toFixed(1)}px wide, measured ${run.width.toFixed(1)}px` +
        (run.label ? `\n        text: "${run.label}"` : ''));
    }
  }
  if (!bad) console.log(`  pass  every text run in all ${ok.length} renders is drawn at its declared size`);
}

/* ----------------------------------------------------- the assertions can fail */

/* A green suite proves nothing unless the checks are known to be capable of
   going red, and both of these are cheap to make vacuous by accident - an
   epsilon one order too generous, a selector that matches nothing. So each is
   fired once at a deliberately broken copy of the page, in the temp tree. The
   test fails if a mutation does NOT trip it. */
console.log('the checks are not vacuous:');
{
  /* A boot line wider than the screen. .boot is a flex column at width:100%,
     so forcing one line's box past .screen's right edge is a pure overflow,
     with no scaling involved. */
  const page = writePage('mutation-overflow', 'c64', STATES[0].at, html =>
    html.replace('</head>',
      '<style>.widget-root.is-booting .boot { max-width: none; width: 220%; }' +
      '.widget-root.is-booting .boot-line { width: 100%; }</style></head>'));
  const r = render(page, STATES[0].at);
  const found = r.error ? [] : overflowsIn(r);
  check('widening a boot line past .screen trips the overflow check',
    r.error ? `render failed: ${r.error}` : found.length > 0, true);
  if (found.length) console.log(`        caught ${found.length}, worst ${found[0].path} by ${found[0].by.toFixed(1)}px`);
}
{
  /* A boot column too narrow for its text. This is the CPC seam in miniature,
     applied to a theme that does not have it, so the check is shown to fire on
     a page that is otherwise clean. */
  const page = writePage('mutation-scaling', 'c64', STATES[0].at, html =>
    html.replace('</head>',
      '<style>.widget-root.is-booting .boot { max-width: 20%; }</style></head>'));
  const r = render(page, STATES[0].at);
  const found = r.error ? [] : scaledRuns(r);
  check('narrowing the boot column trips the scaling check',
    r.error ? `render failed: ${r.error}` : found.length > 0, true);
  if (found.length) {
    const w = expectedWidth(found[0]);
    console.log(`        caught ${found.length}, worst ${found[0].path} at ` +
      `${(found[0].width / w * 100).toFixed(1)}% of ${w.toFixed(1)}px`);
  }
}

/* ------------------------------------------------------------------- teardown */

try { fs.rmSync(WORK, { recursive: true, force: true }); }
catch (e) { console.log(`  note  temp tree left behind at ${WORK}: ${e.message}`); }

console.log('');
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
