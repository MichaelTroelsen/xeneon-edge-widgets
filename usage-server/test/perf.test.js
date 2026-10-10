#!/usr/bin/env node
/* Tests usage-server/perf.js. Never spawns nvidia-smi: the sampler gets an
 * injected os.cpus() and an injected smi factory.
 *
 * Usage:  node usage-server/test/perf.test.js
 */

'use strict';

const perf = require('../perf');

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

function core(user, sys, idle) {
  return { model: 'x', speed: 1, times: { user, nice: 0, sys, idle, irq: 0 } };
}

/* prev: total 2000, idle 1500. next: total 3000, idle 1900 -> delta total 1000,
 * idle 400, busy 600 -> 60 %. next alone would be (3000-1900)/3000 = 36.67 %. */
const prev = [core(200, 100, 700), core(100, 100, 800)];
const next = [core(400, 200, 900), core(300, 200, 1000)];

console.log('cpuPercent');
check('two-core delta', perf.cpuPercent(prev, next), 60);
check('identical samples (zero delta) -> null', perf.cpuPercent(prev, prev), null);
check('missing prev -> null', perf.cpuPercent(null, next), null);
check('missing next -> null', perf.cpuPercent(prev, undefined), null);
check('fully idle delta -> 0, not null',
  perf.cpuPercent([core(0, 0, 100)], [core(0, 0, 200)]), 0);

console.log('parseSmiLine');
check("'37' -> 37", perf.parseSmiLine('37'), 37);
check("'0' -> 0", perf.parseSmiLine('0'), 0);
check('padded line with CR -> 12', perf.parseSmiLine(' 12\r'), 12);
check("'[N/A]' -> null", perf.parseSmiLine('[N/A]'), null);
check('garbage -> null', perf.parseSmiLine('NVIDIA-SMI has failed'), null);
check('empty -> null', perf.parseSmiLine(''), null);

console.log('parseBridgeLine');
check('valid line',
  perf.parseBridgeLine('{"fps":60,"gpu":0,"cpu":69,"lat":0,"process":"game.exe"}'),
  { fps: 60, gpu: 0, cpu: 69, lat: 0, process: 'game.exe' });
check('non-numbers -> null',
  perf.parseBridgeLine('{"fps":"60","gpu":null,"cpu":69,"lat":true,"process":5}'),
  { fps: null, gpu: null, cpu: 69, lat: null, process: null });
let threw = false;
let bad;
try { bad = perf.parseBridgeLine('{"fps":'); } catch (e) { threw = true; }
check('malformed JSON -> null', bad, null);
check('malformed JSON does not throw', threw, false);
check('JSON non-object -> null', perf.parseBridgeLine('42'), null);

console.log('sampler / snapshot');
const KEYS = ['at', 'cpu', 'fps', 'gpu', 'lat', 'process', 'source'];

const fresh = perf.createSampler({ cpus: () => prev, smi: () => ({ kill() {} }) });
const s0 = fresh.snapshot();
check('snapshot keys', Object.keys(s0).sort(), KEYS);
check('unread fields are null, source fallback', s0,
  { fps: null, gpu: null, cpu: null, lat: null, process: null, source: 'fallback', at: null });

let smiOnLine = null;
let smiGone = null;
let killed = 0;
let t = 1000;
let cur = prev;
const sampler = perf.createSampler({
  cpus: () => cur,
  now: () => t,
  intervalMs: 5,
  smi: (onLine, onGone) => { smiOnLine = onLine; smiGone = onGone; return { kill() { killed++; } }; },
});
sampler.start();
const s1 = sampler.snapshot();
check('after first sample: cpu still null (no delta), gpu null', [s1.cpu, s1.gpu], [null, null]);
check('after first sample: at is the timestamp', s1.at, 1000);
smiOnLine('0');
check('gpu 0 is kept as 0', sampler.snapshot().gpu, 0);
smiOnLine('[N/A]');
check('gpu [N/A] -> null, not 0', sampler.snapshot().gpu, null);
smiOnLine('41');
check('gpu 41', sampler.snapshot().gpu, 41);
smiGone();
check('smi gone -> gpu null', sampler.snapshot().gpu, null);

cur = next;
t = 2000;
setTimeout(() => {
  const s2 = sampler.snapshot();
  check('cpu from injected delta', s2.cpu, 60);
  check('at updated', s2.at, 2000);
  check('snapshot keys after sampling', Object.keys(s2).sort(), KEYS);
  sampler.stop();
  check('stop kills the smi child', killed, 1);
  console.log(failures === 0 ? '\nall passed' : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}, 60);
