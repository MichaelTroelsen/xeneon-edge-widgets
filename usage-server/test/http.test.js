#!/usr/bin/env node
/* Tests the raw HTTP layer in server.js against malformed requests, and the
 * /health and /usage contract when a rebuild fails.
 *
 * BUG #1 THIS GUARDS AGAINST: `GET /usage?at=%` (an incomplete percent-escape)
 * used to make decodeURIComponent throw a URIError synchronously inside the
 * http.createServer callback. Node has no default recovery for a throw in that
 * callback - it tears the whole process down. start-hidden.vbs launches this
 * server fire-and-forget at logon with no restart supervision, so one bad
 * `at=` link (a stray `%` from a URL a person half-typed, or truncated by a
 * chat client) killed the feed AND both widgets until the next sign-in.
 *
 * The fix distinguishes whose fault a given failure is:
 *   - decodeURIComponent throwing on a malformed ?at= is the CALLER's mistake
 *     -> 4xx, and the process must still be serving requests afterward.
 *   - an exception from build() itself would be OUR bug -> 5xx (not exercised
 *     here directly - this suite has no fixture that makes build() throw -
 *     but the 5xx path exists in server.js and is documented there).
 * A handler that swallows the error and answers 200 with a broken/absent body
 * would be a worse bug than the crash (a widget drawing a silently wrong
 * picture), so this suite asserts the status code, not just "didn't crash".
 *
 * BUG #2 THIS GUARDS AGAINST: rebuild() used to swallow a thrown build() (e.g.
 * weeklyWindow() reading `anchor.hour` off a limits.json missing
 * `weeklyAnchor` - a file the docs invite operators to hand-edit) and just log
 * to stderr, which start-hidden.vbs discards. `snapshot` was left at whatever
 * it was before - null if this was the very first rebuild - so /usage kept
 * answering 200 with the literal 4-byte body `null` and /health kept
 * answering {ok:true}. The monitoring endpoint reported healthy while the
 * feed served nothing.
 *
 * The fix distinguishes three states (see server.js's /health handler for the
 * full reasoning) and this suite exercises the two failure ones directly,
 * each against its own spawned server so it doesn't disturb the main
 * malformed-request suite below:
 *   - "unbuilt" (rebuildFailsFromBoot* tests): every rebuild has failed,
 *     nothing has ever built. /health must answer ok:false and name the
 *     failure; /usage must NOT answer 200 with a body that parses as null.
 *   - "stale" (rebuildFailsAfterHealthy* tests): a snapshot built
 *     successfully, then subsequent rebuilds started failing. /health must
 *     say ok:true (the feed is still serving real, if ageing, data) but
 *     state:"stale" with the failure named - distinct from both "healthy"
 *     and "unbuilt" - and /usage must keep serving the last good snapshot.
 *
 * Hermetic: CLAUDE_USAGE_NO_REMOTE stops the server polling Anthropic.
 * CLAUDE_USAGE_PROJECTS_DIR / _STATUSLINE_FILE / _STATS_FILE / _CONFIG_PATH
 * all point at a throwaway fixture root so this never touches the real
 * ~/.claude or the real usage-server/limits.json.
 *
 * Usage:  node usage-server/test/http.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

/* Spare ports - 41777 is the live feed serving the physical device (never),
   41798/41799/41800 belong to statusline/live-detection/stats.test.js. 41801
   is this suite's main server; 41802/41803 are two more spawned further down
   for the /health failure-state tests, each in its own process so a rebuild
   failure in one never touches the others. */
const PORT = 41801;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-test-'));
const PROJECTS = path.join(ROOT, 'projects');

/* A config shaped like the real limits.json (see usage-server/limits.json),
   used as the fixture for every server this suite spawns so none of them
   ever read the real file. BROKEN_CONFIG mirrors the exact repro from the
   task this suite guards against: weeklyAnchor missing, which throws inside
   weeklyWindow() at server.js's `d.setHours(anchor.hour)`. */
const VALID_CONFIG = {
  planLabel: 'Test plan',
  weeklyAnchor: { weekday: 4, hour: 21 },
  tokenWeights: { output: 5, input: 1, cacheCreation: 1.25, cacheRead: 0.1 },
  modelWeights: {},
  defaultModelWeight: 1,
  port: 0 /* overridden by PORT env in every spawn below */
};
const BROKEN_CONFIG = Object.assign({}, VALID_CONFIG);
delete BROKEN_CONFIG.weeklyAnchor;

function writeConfig(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function get(pathname, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port || PORT, path: pathname }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* Polls `check()` (which must return truthy on success) every intervalMs
   until it does, or throws once totalMs has elapsed. Used to wait out a
   background rebuild without hardcoding a sleep long enough to always cover
   it, or so short it flakes. */
async function waitUntil(check, totalMs, intervalMs) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    let result;
    try { result = await check(); } catch (err) { result = null; }
    if (result) return result;
    if (Date.now() >= deadline) throw new Error('waitUntil timed out after ' + totalMs + 'ms');
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function checkTrue(name, actual) {
  check(name, actual, true);
}

async function runMalformedRequestSuite() {
  fs.mkdirSync(PROJECTS, { recursive: true });
  const configFile = path.join(ROOT, 'limits.json');
  writeConfig(configFile, VALID_CONFIG);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: PROJECTS,
      CLAUDE_USAGE_STATUSLINE_FILE: path.join(ROOT, 'no-statusline.json'),
      CLAUDE_USAGE_STATS_FILE: path.join(ROOT, 'stats-cache.json'),
      /* Fixture config so this suite never reads the real
         usage-server/limits.json - see the two dedicated servers further
         down for the tests that actually exercise a broken one. */
      CLAUDE_USAGE_CONFIG_PATH: configFile,
      /* Without this the test server polls Anthropic on startup with the
         developer's real credentials. Must be set before the server's first
         rebuild(), hence part of the spawned child's env. */
      CLAUDE_USAGE_NO_REMOTE: '1',
      PORT: String(PORT)
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    for (let i = 0; i < 50; i++) {
      try { await get('/health'); break; } catch (err) { /* not up */ }
      if (child.exitCode !== null) throw new Error('server exited before startup, code ' + child.exitCode);
      await new Promise(r => setTimeout(r, 200));
    }

    console.log('the exact request that used to crash the process:');
    /* This is the literal repro: an incomplete percent-escape. Before the
       fix this made decodeURIComponent throw inside http.createServer's
       callback with no try/catch and no process.on('uncaughtException'),
       and the connection reset (ECONNRESET / WinError 10054 on Windows) as
       the process died. */
    let r = await get('/usage?at=%');
    check('a malformed at= is answered as a client error (4xx), not a crash',
      r.status >= 400 && r.status < 500, true);
    check('the 4xx body is valid JSON', (() => { try { JSON.parse(r.body); return true; } catch { return false; } })(), true);
    checkTrue('exitCode is still null - the process did not die answering it', child.exitCode === null);

    r = await get('/usage?at=%zz');
    check('a different malformed escape is also a 4xx, not a crash',
      r.status >= 400 && r.status < 500, true);
    checkTrue('exitCode is still null after the second malformed request', child.exitCode === null);

    console.log('the process is still fully serving requests afterward:');
    /* The crash this task fixes did not just fail one request - it took the
       whole feed down for both widgets until the next sign-in. The real
       assertion is that normal traffic keeps working right after the bad
       request, not merely that the process object still exists. */
    r = await get('/health');
    check('/health still answers 200 after the malformed requests', r.status, 200);
    check('/health body still parses and reports ok', JSON.parse(r.body).ok, true);

    console.log('other ?at= edge cases that must NOT crash or regress:');

    r = await get('/usage?at=');
    check('?at= empty (no atMatch - regex requires 1+ chars) still serves 200', r.status, 200);
    checkTrue('empty at= still returns a real snapshot body', JSON.parse(r.body).generatedAt != null);

    r = await get('/usage?at=notadate');
    check('?at=notadate (decodes fine, Date.parse fails) still serves 200', r.status, 200);
    checkTrue('?at=notadate still returns a real snapshot body, not an error', JSON.parse(r.body).generatedAt != null);

    const epoch = Date.now();
    r = await get('/usage?at=' + epoch);
    check('a valid ?at=<epoch> still works', r.status, 200);
    check('a valid ?at=<epoch> rebuilds as of that moment', JSON.parse(r.body).generatedAt, epoch);

    r = await get('/does-not-exist');
    check('an unknown path still 404s', r.status, 404);

    console.log('final health check - the server survived the whole run:');
    r = await get('/health');
    check('/health still 200 at the end', r.status, 200);
    checkTrue('process never exited during the whole suite', child.exitCode === null);
  } finally {
    child.kill();
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

/* State (c) "unbuilt": every rebuild has failed since boot, using the exact
   repro from the task - weeklyAnchor missing from limits.json, which throws
   inside weeklyWindow(). Own root, own port, own server: this must never
   share a process with a server expected to be healthy. */
async function testNeverBuilt() {
  console.log('/health and /usage when every rebuild has failed since boot (state: unbuilt):');
  const port = 41802;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-test-unbuilt-'));
  const configFile = path.join(root, 'limits.json');
  writeConfig(configFile, BROKEN_CONFIG);
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: projects,
      CLAUDE_USAGE_STATUSLINE_FILE: path.join(root, 'no-statusline.json'),
      CLAUDE_USAGE_STATS_FILE: path.join(root, 'stats-cache.json'),
      CLAUDE_USAGE_CONFIG_PATH: configFile,
      CLAUDE_USAGE_NO_REMOTE: '1',
      PORT: String(port)
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    const health = await waitUntil(async () => {
      const r = await get('/health', port);
      return r.status === 200 ? JSON.parse(r.body) : null;
    }, 8000, 200);

    check('/health reports ok:false - nothing has ever built', health.ok, false);
    check('/health names the state as "unbuilt"', health.state, 'unbuilt');
    check('/health has no generatedAt - no snapshot exists', health.generatedAt, null);
    checkTrue('/health names the actual failure (the missing weeklyAnchor)',
      typeof health.error === 'string' && /hour/.test(health.error));

    const r = await get('/usage', port);
    checkTrue('/usage does NOT answer 200 while nothing has ever built', r.status !== 200);
    let parsed, parseFailed = false;
    try { parsed = JSON.parse(r.body); } catch (err) { parseFailed = true; }
    checkTrue('/usage body is not the literal 4-byte `null` body', !(parsed === null && !parseFailed));
    checkTrue('/usage body is still valid JSON (an error object), not garbage', !parseFailed);

    checkTrue('server process is still alive - a failed rebuild must not crash it', child.exitCode === null);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* State (b) "stale": a snapshot built successfully, then limits.json is
   hand-edited into the same broken shape mid-flight and a later rebuild
   fails. The feed must keep serving the last good snapshot - not the bug
   this task fixes, and not the "unbuilt" state either. CLAUDE_USAGE_REFRESH_MS
   is shortened so the test does not need a real 10s wait for the background
   rebuild to notice the edit. */
async function testStaleAfterHealthy() {
  console.log('/health and /usage after a previously-healthy server starts failing rebuilds (state: stale):');
  const port = 41803;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-test-stale-'));
  const configFile = path.join(root, 'limits.json');
  writeConfig(configFile, VALID_CONFIG);
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: projects,
      CLAUDE_USAGE_STATUSLINE_FILE: path.join(root, 'no-statusline.json'),
      CLAUDE_USAGE_STATS_FILE: path.join(root, 'stats-cache.json'),
      CLAUDE_USAGE_CONFIG_PATH: configFile,
      CLAUDE_USAGE_NO_REMOTE: '1',
      CLAUDE_USAGE_REFRESH_MS: '250',
      PORT: String(port)
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    const healthy = await waitUntil(async () => {
      const r = await get('/health', port);
      if (r.status !== 200) return null;
      const body = JSON.parse(r.body);
      return body.state === 'healthy' ? body : null;
    }, 8000, 200);
    checkTrue('server reached "healthy" before the config was broken', healthy.state === 'healthy');
    checkTrue('healthy snapshot has a real generatedAt', healthy.generatedAt != null);

    /* Break the config the exact way the task repro does, live, after a good
       snapshot already exists - this is what state (b) actually is. */
    writeConfig(configFile, BROKEN_CONFIG);

    const stale = await waitUntil(async () => {
      const r = await get('/health', port);
      if (r.status !== 200) return null;
      const body = JSON.parse(r.body);
      return body.state === 'stale' ? body : null;
    }, 8000, 200);

    check('/health reports ok:true - the feed is still serving real data', stale.ok, true);
    check('/health names the state as "stale", not "healthy" or "unbuilt"', stale.state, 'stale');
    check('/health keeps the LAST GOOD generatedAt, unchanged by the failing rebuild',
      stale.generatedAt, healthy.generatedAt);
    checkTrue('/health names the failure that is currently happening',
      typeof stale.error === 'string' && /hour/.test(stale.error));

    const r = await get('/usage', port);
    check('/usage keeps answering 200 while stale - the feed is still working', r.status, 200);
    const body = JSON.parse(r.body);
    checkTrue('/usage body is the real last-good snapshot, not null', body !== null && typeof body === 'object');
    check('/usage body\'s generatedAt matches the last good build, not a new one',
      body.generatedAt, healthy.generatedAt);

    checkTrue('server process is still alive after rebuilds started failing', child.exitCode === null);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  await runMalformedRequestSuite();
  await testNeverBuilt();
  await testStaleAfterHealthy();

  console.log('');
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error('test harness error:', err.message);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
