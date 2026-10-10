#!/usr/bin/env node
/* Tests what the Perf Overlay widget LOOKS like, not what it is made of.
 *
 * Structure and calibrations carried over from TaskQueue/test/layout.test.js:
 *   1. the slot is found by asking a blank page how big its viewport came out
 *      and correcting the window size until innerWidth/innerHeight are exact
 *      (--window-size / createTarget sizes the WINDOW, not the viewport);
 *   2. an already-running Chrome on the default profile breaks bare
 *      --headless, so --user-data-dir points somewhere disposable;
 *   3. one Chrome, driven over DevTools through Node's global WebSocket
 *      (Node 22+), so the repo keeps zero dependencies.
 *
 * The widget's two inputs are stubbed before any page script runs
 * (Page.addScriptToEvaluateOnNewDocument): window.fetch answers /perf from the
 * scenario, and window.plugins.Fpsdataprovider is iCUE's Fps plugin.
 *
 * Usage:  node PerfOverlay/test/layout.test.js
 *         CHROME_PATH=/path/to/chrome node PerfOverlay/test/layout.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        want ${JSON.stringify(want)}`);
    console.log(`        got  ${JSON.stringify(got)}`);
  }
}

/* ---------------------------------------------------------------- manifest */

console.log('manifest:');
let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')); }
catch (e) { /* reported by the check below */ }
check('manifest.json parses', manifest !== null, true);
manifest = manifest || {};
check('id is com.thordanielz.perfoverlay', manifest.id, 'com.thordanielz.perfoverlay');
check('supported_devices declares dashboard_lcd',
  (manifest.supported_devices || []).map(d => d.type), ['dashboard_lcd']);
check('required_plugins declares the Fps plugin (widgetbuilder.fpsdataprovider:Fps:1.0)',
  manifest.required_plugins, ['widgetbuilder.fpsdataprovider:Fps:1.0']);

/* ----------------------------------------------------------------- browser */

function findChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']]
      .filter(Boolean);
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

console.log('browser:');
const CHROME = findChrome();
check('a chrome-family browser was found', CHROME !== null, true);
if (!CHROME || typeof WebSocket === 'undefined') {
  if (CHROME) console.log('        this suite needs a global WebSocket (Node 22+)');
  console.log(`\n${failures + (CHROME ? 1 : 0)} FAILED`);
  process.exit(1);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'perfoverlay-layout-'));
const PROFILE = path.join(WORK, 'chrome-profile');
const INDEX_URL = 'file:///' + encodeURI(path.join(ROOT, 'index.html').replace(/\\/g, '/'));

let child = null;
let ws = null;
let nextId = 1;
const pending = new Map();

function send(method, params, sessionId) {
  const id = nextId++;
  const msg = { id, method, params: params || {} };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify(msg));
  });
}

function stopBrowser() {
  try { if (ws) ws.close(); } catch (e) { /* gone */ }
  try { if (child) child.kill(); } catch (e) { /* gone */ }
}
process.on('exit', stopBrowser);

async function startBrowser() {
  child = spawn(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-sync', '--mute-audio', '--force-device-scale-factor=1',
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let buf = '';
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('chrome printed no DevTools URL in time')), 15000);
    child.stderr.on('data', d => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    child.on('exit', code => { clearTimeout(t); reject(new Error(`chrome exited early (code ${code})`)); });
  });
  ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('websocket error')); });
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The stub script runs before the widget's own. `scenario` is spliced in as
   JSON. fetch counts its calls so the test knows the first poll happened. */
function stubScript(scenario) {
  return `(function () {
    var s = ${JSON.stringify(scenario)};
    window.__fetches = 0;
    window.fetch = function () {
      window.__fetches++;
      if (s.perf === 'fail') return Promise.reject(new Error('stubbed network failure'));
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(s.perf); } });
    };
    if (s.plugin) {
      window.plugins = { Fpsdataprovider: {
        currentFps: s.plugin.fps, fpsAvailable: s.plugin.available !== false,
        fpsUpdated: { connect: function () {} }
      } };
    }
  })();`;
}

const MEASURE = `(function () {
  var q = function (s) { return document.querySelector(s); };
  var cells = Array.prototype.map.call(document.querySelectorAll('.cell'), function (c) {
    var r = c.getBoundingClientRect();
    var l = c.querySelector('.label'), v = c.querySelector('.value');
    return {
      label: l.textContent, value: v.textContent,
      box: { l: r.left, t: r.top, r: r.right, b: r.bottom },
      valueClip: v.scrollWidth - v.clientWidth,
      labelClip: l.scrollWidth - l.clientWidth,
      cellClip: c.scrollWidth - c.clientWidth
    };
  });
  var root = q('.widget-root').getBoundingClientRect();
  return JSON.stringify({
    cells: cells,
    root: { w: root.width, h: root.height },
    vw: window.innerWidth, vh: window.innerHeight,
    fetches: window.__fetches,
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    docOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight
  });
})()`;

/* Opens a fresh window of (winW, winH), loads the widget with the scenario's
   stubs, waits for the first poll, returns the measurement. */
async function render(scenario, winW, winH) {
  const { targetId } = await send('Target.createTarget',
    { url: 'about:blank', width: winW, height: winH, newWindow: true });
  try {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: stubScript(scenario) }, sessionId);
    await send('Page.navigate', { url: INDEX_URL }, sessionId);
    let m = null;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      try {
        const r = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true }, sessionId);
        if (r.result && typeof r.result.value === 'string') {
          m = JSON.parse(r.result.value);
          if (m.fetches >= 1) { await sleep(150); break; }
        }
      } catch (e) { /* page not ready */ }
    }
    const r = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true }, sessionId);
    return JSON.parse(r.result.value);
  } finally {
    try { await send('Target.closeTarget', { targetId }); } catch (e) { /* gone */ }
  }
}

/* Find the window size that yields an exact innerWidth x innerHeight. */
async function calibrate(w, h) {
  let winW = w, winH = h + 87;
  let seen = null;
  for (let i = 0; i < 5; i++) {
    const { targetId } = await send('Target.createTarget',
      { url: 'about:blank', width: winW, height: winH, newWindow: true });
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Runtime.enable', {}, sessionId);
      await sleep(250);
      const r = await send('Runtime.evaluate',
        { expression: 'JSON.stringify([innerWidth, innerHeight])', returnByValue: true }, sessionId);
      seen = JSON.parse(r.result.value);
    } finally {
      try { await send('Target.closeTarget', { targetId }); } catch (e) { /* gone */ }
    }
    if (seen[0] === w && seen[1] === h) return { winW, winH, seen };
    winW += w - seen[0];
    winH += h - seen[1];
  }
  return { winW, winH, seen };
}

/* ------------------------------------------------------------- scenarios */

const FULL = { fps: 144, gpu: 37, cpu: 12, lat: 8, process: 'game.exe', source: 'fvsdk', at: 1 };
const ALL_NULL = { fps: null, gpu: null, cpu: null, lat: null, process: null, source: 'fallback', at: 1 };
const WORST = { fps: 999, gpu: 100, cpu: 100, lat: 9999, process: 'x', source: 'fvsdk', at: 1 };

const SLOTS = [
  { w: 840, h: 344, label: '840x344 (S-H)' },
  { w: 696, h: 416, label: '696x416 (S-V)' },
  { w: 840, h: 696, label: '840x696 (M-H)' },
  { w: 696, h: 840, label: '696x840 (portrait)' }
];

(async () => {
  await startBrowser();

  console.log('slot:');
  const win = {};
  for (const s of SLOTS) {
    const c = await calibrate(s.w, s.h);
    win[s.label] = c;
    check(`viewport driven to exactly ${s.label}`, c.seen, [s.w, s.h]);
  }
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }

  const first = SLOTS[0];
  const run = (scenario, slot) => render(scenario, win[(slot || first).label].winW, win[(slot || first).label].winH);
  const values = m => m.cells.map(c => c.value);

  console.log('labels:');
  const full = await run({ perf: FULL, plugin: null });
  check('window.innerWidth/innerHeight are 840x344', [full.vw, full.vh], [840, 344]);
  check('the four labels render in order FPS, GPU, CPU, LAT', full.cells.map(c => c.label), ['FPS', 'GPU', 'CPU', 'LAT']);
  check('a full /perf body renders its four values', values(full), ['144', '37 %', '12 %', '8 ms']);

  console.log('null is N/A:');
  const nul = await run({ perf: ALL_NULL, plugin: null });
  check('every null field renders N/A', values(nul), ['N/A', 'N/A', 'N/A', 'N/A']);
  const zero = await run({ perf: { fps: 0, gpu: 0, cpu: 0, lat: 0 }, plugin: null });
  check('a real zero reading stays a zero, not N/A', values(zero), ['0', '0 %', '0 %', '0 ms']);
  const part = await run({ perf: { fps: null, gpu: 41, cpu: null, lat: null }, plugin: null });
  check('null is judged per field, not per body', values(part), ['N/A', '41 %', 'N/A', 'N/A']);

  console.log('fetch failure:');
  const down = await run({ perf: 'fail', plugin: { fps: 75 } });
  check('a failed /perf renders GPU, CPU and LAT as N/A while the plugin FPS still shows',
    values(down), ['75', 'N/A', 'N/A', 'N/A']);
  const downNoPlugin = await run({ perf: 'fail', plugin: null });
  check('a failed /perf with no plugin renders everything N/A', values(downNoPlugin), ['N/A', 'N/A', 'N/A', 'N/A']);

  console.log('plugin FPS fallback:');
  const fb = await run({ perf: Object.assign({}, FULL, { fps: null }), plugin: { fps: 60 } });
  check('perf.fps null with the Fps plugin reporting 60 renders 60', fb.cells[0].value, '60');
  check('the other fields still come from /perf', values(fb).slice(1), ['37 %', '12 %', '8 ms']);
  const pref = await run({ perf: FULL, plugin: { fps: 60 } });
  check('perf.fps wins over the plugin when /perf has one', pref.cells[0].value, '144');
  const unavail = await run({ perf: Object.assign({}, FULL, { fps: null }), plugin: { fps: 60, available: false } });
  check('a plugin that reports fpsAvailable=false is not shown as 60', unavail.cells[0].value, 'N/A');

  console.log('fit:');
  for (const s of SLOTS) {
    for (const [name, scenario] of [['worst-case values', WORST], ['all N/A', ALL_NULL]]) {
      const m = await run({ perf: scenario, plugin: null }, s);
      check(`${s.label} ${name}: viewport was exact`, [m.vw, m.vh], [s.w, s.h]);
      const out = [];
      for (const c of m.cells) {
        if (c.box.l < -1 || c.box.t < -1 || c.box.r > s.w + 1 || c.box.b > s.h + 1) out.push(`${c.label} outside the slot ${JSON.stringify(c.box)}`);
        if (c.valueClip > 1) out.push(`${c.label} value clipped by ${c.valueClip}px`);
        if (c.labelClip > 1) out.push(`${c.label} label clipped by ${c.labelClip}px`);
        if (c.cellClip > 1) out.push(`${c.label} cell overflows by ${c.cellClip}px`);
      }
      if (m.docOverflowX > 1 || m.docOverflowY > 1) out.push(`document scrolls (${m.docOverflowX}x${m.docOverflowY})`);
      check(`${s.label} ${name}: no overflow`, out, []);
    }
  }

  stopBrowser();
  console.log(failures ? `\n${failures} FAILED` : '\n0 FAILED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.log('suite crashed: ' + (e && e.stack || e)); stopBrowser(); process.exit(1); });
