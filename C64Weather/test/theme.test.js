#!/usr/bin/env node
/* Tests tapping the widget to change theme.
 *
 * The tap is easy to get subtly wrong in ways that look fine in a screenshot:
 * the cycle can skip or fail to wrap, a drag across the dashboard can register
 * as a tap, the chosen theme can fail to survive a reload, and - the one that
 * matters most - a tap can go on outranking the settings panel forever, so the
 * combobox appears broken.
 *
 * widget.js is a browser IIFE, so it runs here against a stub DOM rather than a
 * real one. That is deliberate: what is under test is the tap-to-theme state
 * machine, and the class the theme puts on .widget-root is exactly what the
 * stylesheet consumes, so asserting on it is asserting on the real contract.
 *
 * Usage:  node C64Weather/test/theme.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const petsciiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'petscii.js'), 'utf8');
const widgetSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'widget.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ stub DOM */

function makeElement() {
  const classes = new Set();
  const attrs = {};
  const kids = {};
  const children = [];
  const el = {
    style: {}, textContent: '', className: '',
    classes, attrs, children,
    appendChild: c => { children.push(c); return c; },
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, on) => {
        const want = (on === undefined) ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      }
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: k => { delete attrs[k]; },
    getAttribute: k => (k in attrs ? attrs[k] : null),
    querySelector: sel => (kids[sel] || (kids[sel] = makeElement()))
  };
  /* renderBootLines empties the host with innerHTML = '' before refilling it,
     so the stub has to treat that as "drop the children" or every redraw would
     look like it appended a second copy. */
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: v => { html = v; if (!v) children.length = 0; }
  });
  return el;
}

function makeDocument() {
  const byKey = {};
  const listeners = {};
  const el = key => (byKey[key] || (byKey[key] = makeElement()));
  return {
    byKey, listeners,
    querySelector: sel => el(sel),
    getElementById: id => el('#' + id),
    createElement: () => makeElement(),
    addEventListener: (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); }
  };
}

/* A timer queue, so the two-second boot can be tested without waiting two
   seconds. bootCheck also schedules on this queue; that is why fetch is stubbed
   out below rather than left undefined. */
function makeTimers(clock) {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeout: (fn, ms) => { pending.set(nextId, { at: clock.now + (ms || 0), fn }); return nextId++; },
    clearTimeout: id => { pending.delete(id); },
    advance(ms) {
      clock.now += ms;
      for (let guard = 0; guard < 1000; guard++) {
        let dueId = null;
        for (const [id, t] of pending) if (t.at <= clock.now) { dueId = id; break; }
        if (dueId === null) return;
        const t = pending.get(dueId);
        pending.delete(dueId);
        t.fn();
      }
      throw new Error('timer queue did not drain');
    },
    get size() { return pending.size; }
  };
}

/* Date.now() is the only clock the tap consults; a proxy keeps `new Date(...)`
   working for everything else while letting a held press be tested without
   actually holding one for 700ms. */
function makeDate(clock) {
  return new Proxy(Date, {
    get: (t, p) => (p === 'now' ? () => clock.now : Reflect.get(t, p))
  });
}

/* Boot the widget against a fresh DOM. `store` is the localStorage backing
   object, passed back in to simulate a reload. */
function boot(opts) {
  opts = opts || {};
  const store = opts.store || {};
  const clock = { now: Date.now() };
  const document = makeDocument();
  const window = { PointerEvent: function PointerEvent() {} };
  const localStorage = {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  if (opts.theme !== undefined) window.theme = opts.theme;

  const petsciiWindow = {};
  new Function('window', petsciiSrc)(petsciiWindow);
  const PETSCII = petsciiWindow.PETSCII;

  const timers = makeTimers(clock);
  const noop = () => 0;
  /* A fetch that never settles: the widget may reach refresh() once the boot
     retries drain, and this keeps it from touching the network or throwing. */
  const fetchStub = () => new Promise(() => {});
  new Function('window', 'document', 'localStorage', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'PETSCII', 'Date', 'fetch', widgetSrc)(
    window, document, localStorage, timers.setTimeout, timers.clearTimeout,
    noop, noop, PETSCII, makeDate(clock), fetchStub);

  const fire = (type, e) => (document.listeners[type] || []).forEach(fn => fn(e));

  return {
    store, window, PETSCII, clock, timers, document,
    booting: () => document.querySelector('.widget-root').classes.has('is-booting'),
    bootLines: () => document.getElementById('boot').children.length,
    machine: () => document.getElementById('machine').innerHTML,
    advance: ms => timers.advance(ms),
    /* A theme is live when its class is on .widget-root - the one thing the
       stylesheet actually reads. */
    theme() {
      const cls = [...document.querySelector('.widget-root').classes]
        .filter(c => c.indexOf('theme-') === 0);
      return cls.length === 1 ? cls[0].slice(6) : cls;
    },
    tap(dx, dy, heldMs) {
      fire('pointerdown', { clientX: 100, clientY: 100 });
      clock.now += (heldMs || 20);
      fire('pointerup', { clientX: 100 + (dx || 0), clientY: 100 + (dy || 0) });
    }
  };
}

/* ------------------------------------------------------------------- the cycle */

/* Read the order out of widget.js rather than restating it: a copy here would
   agree with itself while the widget cycled differently. */
const ORDER = JSON.parse(
  (widgetSrc.match(/var THEME_ORDER = (\[[^\]]+\]);/) || [])[1].replace(/'/g, '"'));

console.log('extraction:');
check('THEME_ORDER was found and covers every theme', ORDER.length,
  (widgetSrc.match(/^ {4}[a-z0-9]+: \{$/gm) || []).length);

console.log('the cycle:');
{
  const w = boot();
  check('starts on the default theme', w.theme(), 'c64');

  const seen = [];
  for (let i = 0; i < ORDER.length; i++) { w.tap(); seen.push(w.theme()); }
  check('one tap per theme walks the whole order and wraps',
    seen, ORDER.slice(1).concat(ORDER[0]));
}

{
  const w = boot({ theme: 'bbc' });
  check('the setting is where the cycle starts from', w.theme(), 'bbc');
  w.tap();
  check('the first tap steps on from the setting', w.theme(), 'cpc');
}

{
  const w = boot({ theme: 'modern' });
  check('the font mode follows the theme (system for Modern)',
    w.PETSCII.fontMode(), 'system');
  w.tap();
  check('and back to pixels on the next theme', w.PETSCII.fontMode(), 'pixel');
}

console.log('what counts as a tap:');
{
  const w = boot();
  w.tap(40, 0);
  check('a horizontal drag is not a tap', w.theme(), 'c64');
  w.tap(0, 40);
  check('a vertical drag is not a tap', w.theme(), 'c64');
  w.tap(0, 0, 2000);
  check('a held press is not a tap', w.theme(), 'c64');
  w.tap(4, 4, 100);
  check('a small, brief press is a tap', w.theme(), 'pet');
}

console.log('persistence:');
{
  const w = boot();
  w.tap(); w.tap();
  check('two taps reach bbc', w.theme(), 'bbc');
  const again = boot({ store: w.store });
  check('the chosen theme survives a reload', again.theme(), 'bbc');
  check('and it is stored apart from the reading cache',
    Object.keys(w.store).filter(k => k.endsWith(':theme')).length, 1);
}

console.log('the settings panel outranks a tap:');
{
  const w = boot({ theme: 'c64' });
  w.tap();
  check('tapped away from the setting', w.theme(), 'pet');

  /* Each reload gets its own copy of the stored state: dropping the override is
     a write, so a shared object would let one branch decide the other. */
  const changed = boot({ store: Object.assign({}, w.store), theme: 'spectrum' });
  check('changing the setting drops the stale override', changed.theme(), 'spectrum');
  check('and forgets it rather than re-applying it later',
    Object.keys(changed.store).filter(k => k.endsWith(':theme')).length, 0);

  const kept = boot({ store: Object.assign({}, w.store), theme: 'c64' });
  check('an unchanged setting leaves the tap in force', kept.theme(), 'pet');
}

console.log('the boot sequence:');
const BOOT_MS = Number((widgetSrc.match(/var BOOT_MS = (\d+);/) || [])[1]);
check('BOOT_MS was found', BOOT_MS > 0, true);
{
  const w = boot();
  check('the machine boots on first load', w.booting(), true);
  check('and shows its whole startup screen while it does', w.bootLines(), 2);
  w.advance(BOOT_MS - 1);
  check('it is still booting just before the timer', w.booting(), true);
  w.advance(1);
  check('and the weather screen takes over on it', w.booting(), false);

  w.tap();
  check('changing machine reboots it', [w.theme(), w.booting()], ['pet', true]);
  w.advance(BOOT_MS);
  check('that boot ends too', w.booting(), false);
}

{
  /* Every iCUE data update redraws the static text. If a redraw counted as a
     reboot, the weather would vanish behind the startup screen on every
     refresh cycle for the rest of the day. */
  const w = boot();
  w.advance(BOOT_MS);
  w.window.C64Weather.onDataUpdated();
  check('a data refresh redraws without rebooting', w.booting(), false);
  w.window.C64Weather.onDataUpdated();
  check('and keeps not rebooting', w.booting(), false);
}

{
  /* The CPC prints four lines and the Spectrum one; a fixed two-line header
     could show neither honestly, which is what the boot screen is for. */
  const w = boot({ theme: 'cpc' });
  check('the CPC shows all four of its startup lines', w.bootLines(), 4);
  const s = boot({ theme: 'spectrum' });
  check('the Spectrum shows its single line', s.bootLines(), 1);
}

{
  const w = boot({ theme: 'modern' });
  check('a theme with no startup screen does not play one',
    [w.bootLines(), w.booting()], [0, false]);
  check('and shows no machine either', w.machine(), '');
}

console.log('the machine beside the boot screen:');
{
  /* The drawing is keyed on the theme id, so the failure this catches is a
     theme changing without its picture changing with it - which would show the
     previous machine beside the new one's startup text. */
  const seen = {};
  for (const t of ORDER) {
    seen[t] = boot({ theme: t }).machine();
  }
  const withArt = ORDER.filter(t => seen[t] !== '');
  check('every theme but Modern draws a machine', withArt, ORDER.filter(t => t !== 'modern'));
  const distinct = new Set(withArt.map(t => seen[t]));
  check('and no two machines are the same drawing', distinct.size, withArt.length);

  const w = boot({ theme: 'c64' });
  const before = w.machine();
  w.tap();
  check('tapping to the next machine swaps the drawing too',
    [w.theme(), w.machine() !== before, w.machine() === seen.pet], ['pet', true, true]);
}

{
  const w = boot();
  w.advance(BOOT_MS);
  check('settled after the first boot', w.booting(), false);
  w.tap();
  w.advance(BOOT_MS - 500);
  w.tap();   /* second machine, mid-boot */
  check('a second tap restarts the boot rather than inheriting the old timer',
    w.booting(), true);
  w.advance(BOOT_MS - 500);
  check('the first timer does not cut the second boot short', w.booting(), true);
  w.advance(500);
  check('the second boot ends on its own clock', w.booting(), false);
}

console.log('letter case is a property of the machine:');
{
  check('the C64 folds to its uppercase set', boot({ theme: 'c64' }).PETSCII.letterCase(), 'upper');
  check('the PET does too', boot({ theme: 'pet' }).PETSCII.letterCase(), 'upper');
  for (const t of ['bbc', 'cpc', 'spectrum', 'amiga']) {
    check(`the ${t} keeps mixed case`, boot({ theme: t }).PETSCII.letterCase(), 'mixed');
  }
}

console.log('the version on the device:');
{
  /* Walks every element the widget touched (top-level cached elements plus
     anything appended under them, e.g. the boot lines) and collects the
     aria-label PETSCII.setText always stamps regardless of font mode - that
     is the one property that reliably carries the source string whether the
     visible glyphs are an SVG (pixel themes) or a text node (Modern), so
     reading it alone avoids double-counting a single caption that also sets
     textContent. */
  function renderedText(document) {
    const seen = new Set();
    let out = '';
    function walk(el) {
      if (!el || seen.has(el)) return;
      seen.add(el);
      if (el.attrs && el.attrs['aria-label']) out += ' ' + el.attrs['aria-label'];
      (el.children || []).forEach(walk);
    }
    Object.keys(document.byKey).forEach(k => walk(document.byKey[k]));
    return out;
  }

  const VERSION = (widgetSrc.match(/var WIDGET_VERSION = '([^']+)';/) || [])[1];
  check('WIDGET_VERSION was found', !!VERSION, true);

  for (const t of ORDER) {
    const w = boot({ theme: t });
    const text = renderedText(w.document);
    const hits = (text.match(new RegExp(VERSION.replace(/\./g, '\\.'), 'g')) || []).length;
    check(`the ${t} theme surfaces the version exactly once`, hits, 1);
  }
}

console.log('the plumbing that makes taps arrive at all:');
check('the manifest declares the widget interactive', manifest.interactive, true);
check('a click fallback exists for contexts without pointer events',
  /addEventListener\('click', cycleTheme\)/.test(widgetSrc), true);

console.log('');
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
