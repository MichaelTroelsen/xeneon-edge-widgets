#!/usr/bin/env node
/* Tests the raw HTTP layer in server.js against malformed requests.
 *
 * THE BUG THIS GUARDS AGAINST: `GET /usage?at=%` (an incomplete percent-escape)
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
 * Hermetic: CLAUDE_USAGE_NO_REMOTE stops the server polling Anthropic.
 * CLAUDE_USAGE_PROJECTS_DIR / _STATUSLINE_FILE / _STATS_FILE all point at a
 * throwaway fixture root so this never touches the real ~/.claude.
 *
 * Usage:  node usage-server/test/http.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

/* Spare port - 41777 is the live feed serving the physical device (never),
   41798/41799/41800 belong to statusline/live-detection/stats.test.js. */
const PORT = 41801;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-test-'));
const PROJECTS = path.join(ROOT, 'projects');

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
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

async function main() {
  fs.mkdirSync(PROJECTS, { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: PROJECTS,
      CLAUDE_USAGE_STATUSLINE_FILE: path.join(ROOT, 'no-statusline.json'),
      CLAUDE_USAGE_STATS_FILE: path.join(ROOT, 'stats-cache.json'),
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

  console.log('');
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error('test harness error:', err.message);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
