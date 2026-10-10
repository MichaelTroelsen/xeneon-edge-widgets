/* Performance sampler for /perf: CPU from os.cpus() deltas, GPU from a
 * long-running `nvidia-smi -lms 1000`, plus a parser for the future fvbridge
 * helper's JSON line. A reading that was not taken is null, NEVER 0 (0 % GPU is
 * a real reading).
 */

'use strict';

const os = require('os');
const { spawn } = require('child_process');

const INTERVAL_MS = 1000;
const SMI_ARGS = ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits', '-lms', '1000'];

function cpuTotals(cpus) {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c && c.times;
    if (!t) return null;
    idle += t.idle;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total };
}

/* Total CPU utilisation in percent between two os.cpus() snapshots, or null. */
function cpuPercent(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return null;
  const a = cpuTotals(prev);
  const b = cpuTotals(next);
  if (!a || !b) return null;
  const total = b.total - a.total;
  const idle = b.idle - a.idle;
  if (!(total > 0)) return null;
  return ((total - idle) / total) * 100;
}

/* One line of nvidia-smi csv,noheader,nounits utilization.gpu output. */
function parseSmiLine(line) {
  if (typeof line !== 'string') return null;
  const s = line.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* One JSON line from fvbridge: {"fps","gpu","cpu","lat","process"}. */
function parseBridgeLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch (e) {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  return {
    fps: num(o.fps),
    gpu: num(o.gpu),
    cpu: num(o.cpu),
    lat: num(o.lat),
    process: typeof o.process === 'string' ? o.process : null,
  };
}

/* Default smi factory: spawns nvidia-smi, calls onLine per stdout line and
 * onGone() if it is missing or exits. Returns { kill() }. */
function spawnSmi(onLine, onGone) {
  let child;
  try {
    child = spawn('nvidia-smi', SMI_ARGS, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    onGone();
    return { kill() {} };
  }
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.on('error', onGone);
  child.on('exit', onGone);
  return { kill() { try { child.kill(); } catch (e) { /* already gone */ } } };
}

/* opts: { cpus: () => os.cpus()-shaped, smi: factory(onLine, onGone) -> {kill},
 *         now: () => ms, intervalMs } — all injectable so tests spawn nothing. */
function createSampler(opts) {
  const o = opts || {};
  const readCpus = o.cpus || os.cpus;
  const smiFactory = o.smi || spawnSmi;
  const now = o.now || Date.now;
  const intervalMs = o.intervalMs || INTERVAL_MS;

  let timer = null;
  let smi = null;
  let prevCpus = null;
  const state = { gpu: null, cpu: null, at: null };

  function sample() {
    let cur = null;
    try { cur = readCpus(); } catch (e) { cur = null; }
    if (cur) {
      const p = cpuPercent(prevCpus, cur);
      if (p !== null) state.cpu = p;
      prevCpus = cur;
      state.at = now();
    }
  }

  function start() {
    if (timer) return;
    sample();
    timer = setInterval(sample, intervalMs);
    if (timer.unref) timer.unref();
    smi = smiFactory(
      (line) => {
        const v = parseSmiLine(line);
        state.gpu = v;
        if (v !== null) state.at = now();
      },
      () => { state.gpu = null; }
    );
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (smi) smi.kill();
    smi = null;
    prevCpus = null;
  }

  function snapshot() {
    return {
      fps: null,
      gpu: state.gpu,
      cpu: state.cpu,
      lat: null,
      process: null,
      source: 'fallback',
      at: state.at,
    };
  }

  return { start, stop, snapshot };
}

const shared = createSampler();

module.exports = {
  cpuPercent,
  parseSmiLine,
  parseBridgeLine,
  createSampler,
  start: shared.start,
  stop: shared.stop,
  snapshot: shared.snapshot,
};
