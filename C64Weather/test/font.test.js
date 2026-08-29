#!/usr/bin/env node
/* Tests the hand-authored font and art against what the widget actually asks
 * for.
 *
 * petscii.js has three silent fallbacks:
 *
 *   FONT[ch]      || MISSING        -> an unspellable character renders as a box
 *   SPRITES[name] || SPRITES.cloud  -> a mistyped condition renders as cloud
 *   GLYPHS[name]  || GLYPHS.wind    -> a mistyped stat glyph renders as wind
 *
 * All three fail quietly and look plausible, which is how a missing `|` once
 * shipped as a missing-glyph box on the device. Nothing validated that a string
 * was spellable in the font, so this does.
 *
 * The strings are read out of widget.js rather than duplicated here: a copy
 * would drift, and a test that agrees with a stale copy of the truth is worse
 * than none. That means the extraction itself has to be checked - if the
 * regexes stop matching, the test fails loudly instead of passing vacuously.
 *
 * Usage:  node C64Weather/test/font.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const petsciiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'petscii.js'), 'utf8');
const widgetSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'widget.js'), 'utf8');

/* petscii.js is a browser IIFE that hangs itself off `window`; give it one. */
const win = {};
new Function('window', petsciiSrc)(win);
const PETSCII = win.PETSCII;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------ the font itself */

/* FONT is private to the IIFE, so probe it the way the widget does: a glyph
   the font lacks renders identically to any other glyph it lacks, and both
   differ from a glyph it has. */
const MISSING_MARKER = PETSCII.textSVG('');
function spellable(ch) {
  return PETSCII.textSVG(ch) !== MISSING_MARKER;
}
function unspellable(text) {
  return Array.from(String(text)).filter(ch => !spellable(ch));
}

console.log('font:');
check('the missing-glyph probe itself works',
  [spellable('A'), spellable(''), spellable('')], [true, false, false]);

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
check('every letter, digit and space is spellable', unspellable(ALPHABET), []);

/* Punctuation the widget is known to use. The `|` is listed because its
   absence is the bug this file exists for. */
const PUNCTUATION = '.,:"°*?/-|()';
check('the punctuation the widget uses is spellable', unspellable(PUNCTUATION), []);

/* -------------------------------------------------- strings widget.js renders */

/* Literals passed straight to setText, e.g. PETSCII.setText(els.ready, 'READY.') */
const literals = [...widgetSrc.matchAll(/PETSCII\.setText\([^,]+,\s*'((?:[^'\\]|\\.)*)'\s*\)/g)]
  .map(m => m[1].replace(/\\'/g, "'"));

/* Every theme's boot screen. This is where an unspellable character now enters:
   a theme is authored as plain text, and nothing else looks at it before it
   reaches the device. */
const themeStrings = [...widgetSrc.matchAll(/^\s*(?:banner|ram|load|ready):\s*'((?:[^'\\]|\\.)*)'/gm)]
  .map(m => m[1].replace(/\\'/g, "'"))
  .filter(Boolean);

const themeIds = [...widgetSrc.matchAll(/^ {4}([a-z0-9]+): \{$/gm)].map(m => m[1]);

/* The weather-code table: ['LIGHT DRIZZLE', 'drizzle'] */
const conditions = [...widgetSrc.matchAll(/\[\s*'([A-Z ]+)'\s*,\s*(?:isDay \? )?'([a-z]+)'/g)]
  .map(m => ({ text: m[1], sprite: m[2] }));

/* Both branches of the day/night entries, which the regex above sees only the
   day half of. */
const nightSprites = [...widgetSrc.matchAll(/isDay \? '([a-z]+)' : '([a-z]+)'/g)]
  .flatMap(m => [m[1], m[2]]);

console.log('extraction:');
/* A check that did not run is not a pass: if these stop matching, everything
   below would succeed against an empty list. */
/* 7 today: the loading, error, empty and offline lines. The four boot lines
   moved into the theme table and are counted as themeStrings instead. */
check('setText literals were found', literals.length >= 7, true);
check('every theme was found', themeIds.length >= 7, true);
check('theme boot strings were found', themeStrings.length >= 15, true);
check('the condition table was found', conditions.length >= 25, true);
check('day/night sprite pairs were found', nightSprites.length >= 4, true);

console.log('spellability:');
for (const text of [...literals, ...themeStrings]) {
  const bad = unspellable(text);
  if (bad.length) failures++;
  if (bad.length) console.log(`  FAIL  "${text}" needs ${JSON.stringify(bad)}`);
}
console.log(`  ${failures ? 'see above' : 'pass'}  all ${literals.length + themeStrings.length} literals and theme strings are spellable`);

const badConditions = conditions.filter(c => unspellable(c.text).length);
check('every weather-code description is spellable', badConditions.map(c => c.text), []);

/* The banner is built from the version, so digits and dots must survive it. */
const version = (widgetSrc.match(/var WIDGET_VERSION = '([^']+)'/) || [])[1];
check('a version string was found', typeof version === 'string' && version.length > 0, true);
check('the boot banner is spellable',
  unspellable('**** COMMODORE 64 WEATHER V' + version + ' ****'), []);

/* ------------------------------------------------------------- art name checks */

console.log('art names:');
const usedSprites = [...new Set(conditions.map(c => c.sprite).concat(nightSprites))].sort();
const missingSprites = usedSprites.filter(n => !PETSCII.spriteNames.includes(n));
check('every sprite the widget asks for exists', missingSprites, []);

const usedGlyphs = [...new Set(
  [...widgetSrc.matchAll(/setGlyph\([^,]+,\s*'([a-z]+)'\s*\)/g)].map(m => m[1])
    .concat([...widgetSrc.matchAll(/glyph:\s*'([a-z]+)'/g)].map(m => m[1]))
)].sort();
const missingGlyphs = usedGlyphs.filter(n => !PETSCII.glyphNames.includes(n));
check('every stat glyph the widget asks for exists', missingGlyphs, []);
check('at least one sprite and glyph name were checked',
  usedSprites.length > 0 && PETSCII.glyphNames.length > 0, true);

/* Unused art is not a failure, but it is worth seeing: it is usually either a
   name that was renamed on one side only, or dead weight. */
const unusedSprites = PETSCII.spriteNames.filter(n => !usedSprites.includes(n));
if (unusedSprites.length) console.log(`  note  sprites defined but never asked for: ${unusedSprites.join(', ')}`);

console.log('');
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
