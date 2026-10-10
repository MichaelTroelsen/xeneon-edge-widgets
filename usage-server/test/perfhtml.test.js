'use strict';
/* Unit tests for the /perfhtml renderer. */

const perfhtml = require('../perfhtml');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

const NOW = 1788680000000;
function snap(over) {
  return Object.assign({ fps: 144, gpu: 37, cpu: 12.4, lat: 8.5, process: 'game.exe',
    source: 'fvsdk', at: NOW - 3000 }, over || {});
}
/* The text of the value cell for a metric label. */
function cellFor(html, label) {
  const m = new RegExp('<td>' + label + '</td><td>(.*?)</td>').exec(html);
  return m ? m[1].replace(/<[^>]*>/g, '') : null;
}

console.log('values:');
{
  const html = perfhtml.render(snap(), NOW);
  check('it is a complete document', /^<!doctype html>/i.test(html), true);
  check('fps is shown', cellFor(html, 'FPS'), '144');
  check('gpu is shown with a unit', cellFor(html, 'GPU'), '37 %');
  check('cpu is rounded', cellFor(html, 'CPU'), '12 %');
  check('latency is shown', cellFor(html, 'Latency'), '8.5 ms');
  check('the process name is shown', cellFor(html, 'Process'), 'game.exe');
}

console.log('null is N/A, never 0:');
{
  const html = perfhtml.render(snap({ fps: null, gpu: null, cpu: null, lat: null, process: null }), NOW);
  for (const l of ['FPS', 'GPU', 'CPU', 'Latency', 'Process']) {
    check(l + ' null renders N/A', cellFor(html, l), 'N/A');
  }
  check('a real 0 is still 0, not N/A',
    cellFor(perfhtml.render(snap({ gpu: 0 }), NOW), 'GPU'), '0 %');
}

console.log('escaping:');
{
  const html = perfhtml.render(snap({ process: '<script>alert(1)</script>' }), NOW);
  check('a process name carrying markup is escaped', html.indexOf('<script>alert(1)') === -1, true);
  check('and its text still reaches the page', /&lt;script&gt;/.test(html), true);
  const h2 = perfhtml.render(snap({ source: '<b>x</b>' }), NOW);
  check('a source carrying markup is escaped', h2.indexOf('<b>x') === -1, true);
}

console.log('source and sample age:');
{
  const html = perfhtml.render(snap(), NOW);
  check('the source is shown', /<td>Source<\/td><td>fvsdk<\/td>/.test(html), true);
  check('the sample age is shown', /<td>Sample age<\/td><td>3s ago<\/td>/.test(html), true);
  const none = perfhtml.render(snap({ at: null, source: 'fallback' }), NOW);
  check('no sample says so instead of an age', /no sample yet/.test(none), true);
  check('a null snapshot does not throw', typeof perfhtml.render(null, NOW), 'string');
}

console.log('');
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
