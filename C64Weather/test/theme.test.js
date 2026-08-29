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
  return {
    style: {}, innerHTML: '', textContent: '', className: '',
    classes, attrs,
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
}

function makeDocument() {
  const byKey = {};
  const listeners = {};
  const el = key => (byKey[key] || (byKey[key] = makeElement()));
  return {
    byKey, listeners,
    querySelector: sel => el(sel),
    getElementById: id => el('#' + id),
    addEventListener: (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); }
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

  const noop = () => 0;
  new Function('window', 'document', 'localStorage', 'setTimeout', 'setInterval',
    'clearInterval', 'PETSCII', 'Date', widgetSrc)(
    window, document, localStorage, noop, noop, noop, PETSCII, makeDate(clock));

  const fire = (type, e) => (document.listeners[type] || []).forEach(fn => fn(e));

  return {
    store, window, PETSCII, clock,
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

console.log('the plumbing that makes taps arrive at all:');
check('the manifest declares the widget interactive', manifest.interactive, true);
check('a click fallback exists for contexts without pointer events',
  /addEventListener\('click', cycleTheme\)/.test(widgetSrc), true);

console.log('');
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
