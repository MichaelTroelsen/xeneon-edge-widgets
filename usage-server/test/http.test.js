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
   failure in one never touches the others. 41804/41805 are two more for the
   credentials-watcher tests, same reasoning: each scenario primes a specific
   officialRateLimited state and must not leak into the other's process.
   41811 is the torn-append test further down. 41812/41813/41814 are the
   lastQuota tests, one server each for the same reason as the others. 41815
   is the workflowsSeen/subtasksSeen cap test further down. */
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

/* --- CLAUDE_USAGE_* env-override cross-check (CODE <-> DOCS) --------------
 *
 * BUG THIS GUARDS AGAINST: README.md:128 once named CLAUDE_USAGE_CREDENTIALS_FILE
 * as an override before server.js read it at all - `git show
 * 0a09297~1:usage-server/server.js | grep -c CLAUDE_USAGE_CREDENTIALS_FILE`
 * returns 0, and the pre-fix credentials watcher matched a hardcoded
 * '.credentials.json' instead. The doc asserted an override that did not
 * exist, and nothing noticed until the code happened to catch up.
 * Separately, CLAUDE_USAGE_FAKE_OFFICIAL_ERROR shipped in server.js (commit
 * 0a09297) undocumented and stayed that way until commit 642f80a. Both
 * directions below are asserted independently because they catch different
 * mistakes - see the two mutation tests further down for what each one
 * actually catches when it fires.
 *
 * EXTRACTION: a name counts as "read by server.js" only if it appears as the
 * literal expression process.env.CLAUDE_USAGE_<NAME> (or the bracketed form
 * process.env['CLAUDE_USAGE_<NAME>']) OUTSIDE any /* *\/ block comment.
 * Block comments are stripped from a copy of the source before matching, so
 * a name that is only discussed in prose inside one of server.js's comment
 * blocks about these overrides (there are three: ~line 41-46, ~164-170,
 * ~1437-1448) does not, by itself, count as a read. The mutation test below
 * proves this: it removes a real read and confirms the leftover comment
 * mention does NOT keep the check green, and separately shows a naive
 * anywhere-in-the-file scan WOULD have been fooled by it. Requiring the
 * literal process.env. prefix also means a bare string literal that happens
 * to mention a CLAUDE_USAGE_* name (e.g. the error text built at
 * server.js:178) is never mistaken for a read.
 *
 * WHAT THIS CANNOT SEE (stated, not implied):
 *   - A computed lookup such as process.env['CLAUDE_USAGE_' + suffix] would
 *     not be matched. server.js has none as of this writing (checked by
 *     hand: no `process.env[` of any form appears in server.js today except
 *     the literal-string ones this extraction already understands).
 *   - A name that is present on BOTH sides, correctly, but whose DOCUMENTED
 *     DESCRIPTION in README.md is stale or wrong. This is a name-presence
 *     check only - it cannot validate prose once a name is found.
 *   - CLAUDE_USAGE_STATUSLINE_FILE: real and documented, but read inside
 *     statusline.js (`process.env.CLAUDE_USAGE_STATUSLINE_FILE`, verified by
 *     hand) rather than in server.js's own source text - server.js only
 *     requires that module (`require('./statusline')`, server.js:21). This
 *     check is scoped to server.js's and README.md's own text (this task's
 *     declared touches include neither statusline.js nor any other sibling
 *     file), so it cannot confirm that read directly and carries this one
 *     name as an explicit, hand-verified exception rather than silently
 *     dropping it - a NEW name that isn't this one still fails DOCS -> CODE.
 */

function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractCodeReads(src) {
  const code = stripBlockComments(src);
  const names = new Set();
  const dotRe = /process\.env\.(CLAUDE_USAGE_[A-Z0-9_]+)/g;
  const bracketRe = /process\.env\[\s*['"](CLAUDE_USAGE_[A-Z0-9_]+)['"]\s*\]/g;
  let m;
  while ((m = dotRe.exec(code))) names.add(m[1]);
  while ((m = bracketRe.exec(code))) names.add(m[1]);
  return names;
}

/* Deliberately naive: matches the token anywhere at all, comments and
   strings included. Used both to derive "what README.md mentions" (docs are
   prose, there is no comment/code distinction to make) and, further down, to
   demonstrate what a careless CODE extractor would have gotten wrong. */
function extractAnyMention(src) {
  const names = new Set();
  const re = /CLAUDE_USAGE_[A-Z0-9_]+/g;
  let m;
  while ((m = re.exec(src))) names.add(m[0]);
  return names;
}

/* One verified, explicit exception - see the EXTRACTION comment block above. */
const KNOWN_CROSS_FILE_DOC_NAMES = new Set(['CLAUDE_USAGE_STATUSLINE_FILE']);

function mismatches(codeNames, docNames) {
  const undocumented = [...codeNames].filter(n => !docNames.has(n));
  const phantom = [...docNames].filter(n => !codeNames.has(n) && !KNOWN_CROSS_FILE_DOC_NAMES.has(n));
  return { undocumented, phantom };
}

function testEnvOverridesMatchDocs() {
  console.log('CLAUDE_USAGE_* overrides: server.js reads vs README.md documents:');

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const readmeSrc = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  console.log('  extraction self-checks (comment / string-literal / real read / bracketed):');
  checkTrue('extraction ignores a name that only appears inside a block comment',
    !extractCodeReads('/* process.env.CLAUDE_USAGE_COMMENT_ONLY_TEST */').has('CLAUDE_USAGE_COMMENT_ONLY_TEST'));
  checkTrue('extraction ignores a bare string literal - not a process.env read',
    !extractCodeReads("const s = 'CLAUDE_USAGE_STRING_ONLY_TEST';").has('CLAUDE_USAGE_STRING_ONLY_TEST'));
  checkTrue('extraction finds a genuine process.env.CLAUDE_USAGE_* read',
    extractCodeReads('const x = process.env.CLAUDE_USAGE_REAL_READ_TEST;').has('CLAUDE_USAGE_REAL_READ_TEST'));
  checkTrue("extraction finds a bracketed process.env['CLAUDE_USAGE_*'] read",
    extractCodeReads("const x = process.env['CLAUDE_USAGE_BRACKET_TEST'];").has('CLAUDE_USAGE_BRACKET_TEST'));

  const codeNames = extractCodeReads(serverSrc);
  const docNames = extractAnyMention(readmeSrc);

  console.log(`  server.js reads (${codeNames.size}): ${[...codeNames].sort().join(', ')}`);
  console.log(`  README.md mentions (${docNames.size}): ${[...docNames].sort().join(', ')}`);

  console.log('  CODE -> DOCS: every override server.js reads must be documented:');
  for (const name of [...codeNames].sort()) {
    check(`  ${name} (read in server.js) is documented in README.md`, docNames.has(name), true);
  }

  console.log('  DOCS -> CODE: every override README.md documents must actually exist:');
  for (const name of [...docNames].sort()) {
    check(`  ${name} (in README.md) is actually read in server.js`,
      codeNames.has(name) || KNOWN_CROSS_FILE_DOC_NAMES.has(name), true);
  }

  console.log('  mutation A: a brand-new override added to the code, left undocumented:');
  const mutatedA = serverSrc + '\nconst NEW = process.env.CLAUDE_USAGE_TOTALLY_NEW_OVERRIDE;\n';
  const mA = mismatches(extractCodeReads(mutatedA), docNames);
  checkTrue('mutation A: a new undocumented override IS caught by CODE -> DOCS',
    mA.undocumented.includes('CLAUDE_USAGE_TOTALLY_NEW_OVERRIDE'));

  console.log('  mutation B: the real historical bug, replayed - a documented override');
  console.log('  deleted from the live reads, with its comment mention left behind:');
  /* Renames every literal process.env.CLAUDE_USAGE_CREDENTIALS_FILE read (server.js
     lines 45 and 1448) to a different identifier. The prose mention at line
     ~1445 ("an explicit CLAUDE_USAGE_CREDENTIALS_FILE means a test opted in")
     has no process.env. prefix, so it is untouched by the rename and survives
     verbatim - reproducing exactly the shape of the real README:128 bug. */
  const mutatedB = serverSrc.split('process.env.CLAUDE_USAGE_CREDENTIALS_FILE')
    .join('process.env.CLAUDE_USAGE_CREDENTIALS_FILE_RENAMED_FOR_TEST');
  const mutatedBCode = extractCodeReads(mutatedB);
  checkTrue('mutation B: the comment-only mention is NOT treated as a read (extraction is comment-aware)',
    !mutatedBCode.has('CLAUDE_USAGE_CREDENTIALS_FILE'));
  const naiveScanOfMutatedB = extractAnyMention(mutatedB);
  checkTrue('mutation B: a naive anywhere-in-file scan WOULD have been fooled by the surviving comment',
    naiveScanOfMutatedB.has('CLAUDE_USAGE_CREDENTIALS_FILE'));
  const mB = mismatches(mutatedBCode, docNames);
  checkTrue('mutation B: a documented override removed from the code IS caught by DOCS -> CODE',
    mB.phantom.includes('CLAUDE_USAGE_CREDENTIALS_FILE'));

  console.log('  BLIND SPOT (by construction, not a bug): a name present on both sides is never');
  console.log('  checked for whether README.md\'s prose about it is still accurate, and a computed');
  console.log('  process.env[\'CLAUDE_USAGE_\' + x] access would not be matched.');
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

/* ------------------------------------------------------------------------
 * The incremental index and a TORN APPEND.
 *
 * readIncrement() re-reads only the bytes a transcript has grown by since the
 * last pass, resuming from a stored byte cursor. A transcript is appended to
 * by a live Claude Code session, so statSync can perfectly well see a size
 * that includes only PART of the JSON line currently being written.
 * parseLines already tolerates that - the fragment does not parse, so it is
 * skipped - but the cursor used to be stored as the stat size regardless.
 * The next pass therefore resumed in the MIDDLE of that line, and its
 * remainder was dropped for not starting with '{'. The record was never
 * counted again for the life of the process: not a delay, a permanent loss.
 *
 * This is the first append-based fixture in the suites. Before it, every
 * transcript fixture in every suite was written whole with writeFileSync, so
 * the `entry.size > prev.size` branch had never once executed under test.
 *
 * The sequence below is the repro exactly: one whole record, then HALF of a
 * second record's line, then the REST of that same line, then a third whole
 * record to prove the index is still alive and that record 2 alone was
 * destroyed. CLAUDE_USAGE_REFRESH_MS is pushed out to a minute so the only
 * rebuilds are the `?at=` ones this test asks for - a background rebuild
 * landing between the appends would decide for itself when the torn read
 * happened.
 * ---------------------------------------------------------------------- */
function assistantLine(tsMs, output) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: {
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 1,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }
  });
}

async function testTornAppend() {
  console.log('the incremental index across a torn append:');
  const port = 41811;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-test-torn-'));
  const configFile = path.join(root, 'limits.json');
  writeConfig(configFile, VALID_CONFIG);
  const projects = path.join(root, 'projects');
  const transcript = path.join(projects, 'proj-torn', '7f3a1c20-0000-4000-8000-0000000000ab.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: projects,
      CLAUDE_USAGE_STATUSLINE_FILE: path.join(root, 'no-statusline.json'),
      CLAUDE_USAGE_STATS_FILE: path.join(root, 'stats-cache.json'),
      CLAUDE_USAGE_CONFIG_PATH: configFile,
      CLAUDE_USAGE_NO_REMOTE: '1',
      CLAUDE_USAGE_REFRESH_MS: '60000',
      PORT: String(port)
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  /* `?at=<now>` forces a synchronous rebuild, so each step below is a real
     index pass rather than a wait on the refresh timer. The records are
     timestamped 30s in the past because sumTokens' upper bound is exclusive
     and equal to that same `now`. */
  const tokens = async () => {
    const r = await get('/usage?at=' + Date.now(), port);
    if (r.status !== 200) throw new Error('/usage answered ' + r.status);
    return JSON.parse(r.body).weekly.tokens;
  };

  try {
    await waitUntil(async () => {
      const r = await get('/health', port);
      return r.status === 200 && JSON.parse(r.body).state === 'healthy';
    }, 8000, 200);

    const base = Date.now() - 30000;

    fs.writeFileSync(transcript, assistantLine(base, 100) + '\n', 'utf8');
    let t = await tokens();
    check('baseline - one whole record is indexed', t.messages, 1);
    check('baseline - its output tokens are counted', t.output, 100);

    /* The torn write: statSync will see a size that stops mid-line. */
    const line2 = assistantLine(base + 1000, 777);
    const cut = Math.floor(line2.length / 2);
    fs.appendFileSync(transcript, line2.slice(0, cut), 'utf8');
    t = await tokens();
    check('a half-flushed record is not counted yet - correct', t.messages, 1);
    check('...and contributes no output tokens yet - correct', t.output, 100);

    /* The rest of the SAME line. Nothing about record 2 has changed except
       that it is now whole on disk, so it must now count. */
    fs.appendFileSync(transcript, line2.slice(cut) + '\n', 'utf8');
    t = await tokens();
    check('the completed record is counted once its line is whole', t.messages, 2);
    check('the completed record contributes its output tokens', t.output, 877);

    /* A third whole record: if this one indexes while record 2 did not, the
       index is alive and record 2 was specifically destroyed. */
    fs.appendFileSync(transcript, assistantLine(base + 2000, 5) + '\n', 'utf8');
    t = await tokens();
    check('a later whole record still indexes', t.messages, 3);
    check('the running output total is the sum of all three', t.output, 882);

    /* A WHOLE record with no trailing newline yet. It must count right away -
       waiting for a newline that may never arrive (a writer that died, or the
       last record of a transcript nothing will append to again) would be the
       same permanent loss in a different place. */
    fs.appendFileSync(transcript, assistantLine(base + 3000, 50), 'utf8');
    t = await tokens();
    check('a whole record with no trailing newline counts immediately', t.messages, 4);
    check('...and contributes its output tokens', t.output, 932);

    /* A pass over an UNCHANGED file must still report it. The cursor sits
       behind that record on purpose, so `cursor` and the stat size disagree
       and the state carries a record the cursor has not committed; a
       short-circuit that handed back only the committed ones would make the
       count flicker down and back up between rebuilds. (Verified by mutation:
       returning prev.records.slice(0, prev.committed) here fails these two
       and nothing else.) */
    t = await tokens();
    check('an unchanged pass still reports the uncommitted tail record', t.messages, 4);
    check('...with its output tokens intact', t.output, 932);

    /* Now it gets its newline, and another record after it. */
    fs.appendFileSync(transcript, '\n' + assistantLine(base + 4000, 7) + '\n', 'utf8');
    t = await tokens();
    check('the terminated record is still counted exactly once', t.messages, 5);
    check('the output total counts each record exactly once', t.output, 939);

    checkTrue('server process survived the whole append sequence', child.exitCode === null);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------
 * lastQuota: "most recent 429 quotaLimits record seen", not "farthest-future
 * resetsAt seen". The old predicate (`at > lastQuota.resetsAt`) kept whichever
 * record had the largest resetsAt forever - a seven_day 429 (reset days out)
 * permanently outranked every five_hour 429 seen after it, so session.blocked
 * and session.resetsAt went stale for the rest of the process's life. There
 * was also no check that a quotaLimits-bearing line was actually a 429 at
 * all: `obj.apiErrorStatus === 429` is the sibling field every real 429 line
 * in the wild carries (confirmed against ~/.claude/projects at the time of
 * this fix - see the task record), so its absence is the signal that a line
 * merely mentions quotaLimits without being a live rejection.
 *
 * No suite fixture wrote a quotaLimits record before this - these are the
 * first. A seven_day record has never been observed in real transcripts (all
 * evidence so far is five_hour/rejected), so it is synthesized here per the
 * task note; the five_hour/rejected shape mirrors the real thing exactly.
 *
 * Three cases, each isolating one thing:
 *   - testQuotaTaskRepro: the literal scenario from the task record (a
 *     seven_day/allowed record seen long ago, then a five_hour/rejected one
 *     seen recently) - an end-to-end regression check, but on its own it does
 *     NOT discriminate either defect in isolation (the seven_day record here
 *     carries no apiErrorStatus, so the 429 gate alone already excludes it
 *     regardless of the predicate).
 *   - testQuotaMostRecentWins: two GENUINE 429s (both carry apiErrorStatus)
 *     of different types and resetsAt, isolating the predicate alone.
 *   - testQuotaRequires429: a genuine 429 followed by a LATER quotaLimits
 *     line with no apiErrorStatus, isolating the 429 gate alone (the
 *     seenAt-based predicate would otherwise let the later, non-429 line
 *     win on recency).
 * ---------------------------------------------------------------------- */
function quotaLine(tsMs, type, status, resetsAtMs, withApiError) {
  const obj = {
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'rate limited' }] },
    quotaLimits: {
      status: status,
      resetsAt: Math.floor(resetsAtMs / 1000),
      unifiedRateLimitFallbackAvailable: false,
      rateLimitType: type,
      overageStatus: status,
      overageDisabledReason: 'org_level_disabled',
      upgradePaths: ['upgrade_plan'],
      isUsingOverage: false
    }
  };
  if (withApiError) {
    obj.error = 'rate_limit';
    obj.isApiErrorMessage = true;
    obj.apiErrorStatus = 429;
  }
  return JSON.stringify(obj);
}

async function runQuotaScenario(port, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-test-quota-'));
  const configFile = path.join(root, 'limits.json');
  writeConfig(configFile, VALID_CONFIG);
  const projects = path.join(root, 'projects');
  const transcript = path.join(projects, 'proj-quota', '33333333-0000-4000-8000-000000000003.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, lines.join('\n') + '\n', 'utf8');

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: projects,
      CLAUDE_USAGE_STATUSLINE_FILE: path.join(root, 'no-statusline.json'),
      CLAUDE_USAGE_STATS_FILE: path.join(root, 'stats-cache.json'),
      CLAUDE_USAGE_CONFIG_PATH: configFile,
      CLAUDE_USAGE_NO_REMOTE: '1',
      CLAUDE_USAGE_REFRESH_MS: '60000',
      PORT: String(port)
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    await waitUntil(async () => {
      const r = await get('/health', port);
      return r.status === 200 && JSON.parse(r.body).state === 'healthy';
    }, 8000, 200);
    const r = await get('/usage?at=' + Date.now(), port);
    if (r.status !== 200) throw new Error('/usage answered ' + r.status);
    return JSON.parse(r.body).session;
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testQuotaTaskRepro() {
  console.log('lastQuota - the exact task repro (a stale weekly record must not suppress a fresh five-hour 429):');
  const port = 41812;
  const now = Date.now();
  const blockAnchor = now - 2 * 3600000;
  const fiveHourResetsAt = now + 3600000;
  const session = await runQuotaScenario(port, [
    assistantLine(blockAnchor, 10),
    quotaLine(now - 110 * 60000, 'seven_day', 'allowed', now + 5 * 86400000, false),
    quotaLine(now - 1 * 60000, 'five_hour', 'rejected', fiveHourResetsAt, true)
  ]);
  check('blocked is true - the fresh five-hour 429 is not masked by the stale weekly record', session.blocked, true);
  check('resetsAt is the five-hour reset, not block.end', session.resetsAt, Math.floor(fiveHourResetsAt / 1000) * 1000);
}

async function testQuotaMostRecentWins() {
  console.log('lastQuota - picks the MOST RECENTLY SEEN 429, not the one with the farthest-future resetsAt:');
  const port = 41813;
  const now = Date.now();
  const blockAnchor = now - 2 * 3600000;
  const fiveHourResetsAt = now + 3600000;
  const session = await runQuotaScenario(port, [
    assistantLine(blockAnchor, 10),
    quotaLine(now - 110 * 60000, 'seven_day', 'rejected', now + 5 * 86400000, true),
    quotaLine(now - 1 * 60000, 'five_hour', 'rejected', fiveHourResetsAt, true)
  ]);
  check('resetsAt tracks the more recently seen five-hour 429, not the farther-future weekly one',
    session.resetsAt, Math.floor(fiveHourResetsAt / 1000) * 1000);
}

async function testQuotaRequires429() {
  console.log('lastQuota - a quotaLimits line with no apiErrorStatus:429 is not a real 429 and must not displace one:');
  const port = 41814;
  const now = Date.now();
  const blockAnchor = now - 2 * 3600000;
  const realResetsAt = now + 3600000;
  const session = await runQuotaScenario(port, [
    assistantLine(blockAnchor, 10),
    quotaLine(now - 30 * 60000, 'five_hour', 'rejected', realResetsAt, true),
    quotaLine(now - 5 * 60000, 'five_hour', 'allowed', now + 2 * 3600000, false)
  ]);
  check('blocked stays true - the later non-429 line does not overwrite the real one', session.blocked, true);
  check('resetsAt stays the real 429\'s reset, not the later non-429 line\'s', session.resetsAt, Math.floor(realResetsAt / 1000) * 1000);
}

/* ------------------------------------------------------------------------
 * The credentials watcher: a write must not wipe backoff EARNED by rate
 * limiting, and one rotation must not run its handler twice.
 *
 * watchCredentials() is normally only reached when CLAUDE_USAGE_NO_REMOTE is
 * unset - every suite in this repo sets it, since without it a spawned test
 * server makes a real request to an endpoint that is already rate-limited.
 * That makes the watcher unreachable under test by construction unless
 * something changes. server.js now honours CLAUDE_USAGE_CREDENTIALS_FILE
 * (already carried by statusline.test.js's spawn, previously inert) to point
 * the watcher at a fixture instead of the real ~/.claude, and its fetch step
 * (fetchOfficialResult()) stays hermetic under CLAUDE_USAGE_NO_REMOTE no
 * matter what triggers it - the boot call, the backoff timer, or the
 * watcher - resolving to a canned result instead of official.fetchOfficial().
 * CLAUDE_USAGE_FAKE_OFFICIAL_ERROR controls what that canned result says, so
 * a test can drive officialRateLimited into either state without ever
 * touching the network or a real credentials file. Each canned result also
 * carries a trailing "#N" call counter, so a test can tell "the watcher
 * fired again" apart from "the watcher left the last result alone" even
 * when both happen inside the same millisecond.
 *
 * Neither scenario below can go through official.js's real fetch, so this
 * cannot prove the exact HTTP 429/401 strings official.js emits still match
 * the /HTTP 429/ and /HTTP 401/ regexes server.js and official.js both use -
 * that coupling is exercised by reading official.js's own source (see the
 * task record) and is unchanged by this fix. What these prove is the
 * decision server.js makes once it has a result: reset+refetch immediately
 * for anything that is not a 429, and leave a 429 backoff alone. */

/* Replays official.js's own writeCredentials() write pattern: write a
   .tmp-<pid> file, then renameSync it onto the target, inside the directory
   server.js is watching. Measured directly against fs.watch on this
   platform (see the task record): this produces TWO fs.watch events whose
   filename passes server.js's '.credentials.json' filter for one logical
   rotation - which is exactly why watchCredentials() cannot treat "an event
   fired" as "a rotation happened" without deduping first. */
function rotateCredentials(file, tag) {
  const tmp = file + '.tmp-' + process.pid + '-' + tag;
  fs.writeFileSync(tmp, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-' + tag } }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function officialError(port) {
  const r = await get('/usage?at=' + Date.now(), port);
  return JSON.parse(r.body).official.error;
}

function waitForOfficialError(pattern, port, totalMs) {
  return waitUntil(async () => {
    const err = await officialError(port);
    return pattern.test(err || '') ? err : null;
  }, totalMs, 100);
}

/* Waits for official.error to become anything other than `baseline`, without
   asserting what it becomes. Used before checking a SETTLED value rather than
   matching an exact transient one: when a rotation double-fires (the dedup
   bug this suite guards against), the #1 result can be overwritten by #2
   within a millisecond - fast enough that a poll for the literal "#1" string
   can race past it and never observe it, timing the whole test out instead
   of failing the one assertion that actually distinguishes correct from
   buggy. Waiting for "not baseline any more", then settling before reading
   the final value, is robust to that race either way. */
function waitForOfficialErrorChange(baseline, port, totalMs) {
  return waitUntil(async () => {
    const err = await officialError(port);
    return err !== baseline ? err : null;
  }, totalMs, 50);
}

/* The bug: after two hours of 429s, officialFailures is 4 and the earned
   wait is min(15min*4, 60min) = 60min. Claude Code rewrites the same
   credentials file on its own cadence regardless of this server's backoff -
   the fix is that such a write must not clear officialFailures or fire an
   immediate extra request into a rate limit that is already live. */
async function testCredentialsWatcherRateLimited() {
  console.log('credentials watcher - a write during an earned 429 backoff must not reset it:');
  const port = 41804;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-test-cred429-'));
  const configFile = path.join(root, 'limits.json');
  writeConfig(configFile, VALID_CONFIG);
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const credentialsFile = path.join(root, '.credentials.json');
  fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-boot' } }), 'utf8');

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: projects,
      CLAUDE_USAGE_STATUSLINE_FILE: path.join(root, 'no-statusline.json'),
      CLAUDE_USAGE_STATS_FILE: path.join(root, 'stats-cache.json'),
      CLAUDE_USAGE_CONFIG_PATH: configFile,
      CLAUDE_USAGE_CREDENTIALS_FILE: credentialsFile,
      CLAUDE_USAGE_NO_REMOTE: '1',
      CLAUDE_USAGE_FAKE_OFFICIAL_ERROR: 'HTTP 429 too many requests',
      PORT: String(port)
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    await waitUntil(async () => {
      const r = await get('/health', port);
      return r.status === 200 ? true : null;
    }, 8000, 200);

    /* officialRateLimited starts false, so this first rotation takes the
       reset+refresh path - and the canned fetch it runs is the 429 that
       earns the backoff the next rotation must not clear. */
    rotateCredentials(credentialsFile, 'prime');
    const afterPrime = await waitForOfficialError(/#1$/, port, 5000);
    check('priming rotation earns the 429 backoff', afterPrime, 'HTTP 429 too many requests #1');

    /* This is the bug scenario: a credentials write while officialRateLimited
       is true. Long enough to catch a #2 if the guard is missing - the
       platform's two watch events per rotation fire within the same
       millisecond (measured), so any leak shows up almost immediately. */
    rotateCredentials(credentialsFile, 'duringBackoff');
    await new Promise(r => setTimeout(r, 800));
    const after = await officialError(port);
    check('a write during the earned 429 backoff does not clear it', after, afterPrime);
    checkTrue('...and does not fire a second fetch', !/#2/.test(after || ''));

    checkTrue('server process is still alive', child.exitCode === null);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* The behaviour the watcher exists to serve, which the discriminator above
   must not break: a dead token (401) gets a new one written to the same
   file, and the next request should use it now rather than wait out minutes
   of backoff. Also covers the dedup: official.js's write pattern fires two
   matching fs.watch events per rotation (see rotateCredentials above), and
   without the mtime check in watchCredentials() this runs the reset/refetch
   twice per rotation instead of once. */
async function testCredentialsWatcherResetsOnGenuineWrite() {
  console.log('credentials watcher - a genuine write (the 401-then-new-token case) still resets and refetches once per rotation:');
  const port = 41805;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-test-cred401-'));
  const configFile = path.join(root, 'limits.json');
  writeConfig(configFile, VALID_CONFIG);
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const credentialsFile = path.join(root, '.credentials.json');
  fs.writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-boot' } }), 'utf8');

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: projects,
      CLAUDE_USAGE_STATUSLINE_FILE: path.join(root, 'no-statusline.json'),
      CLAUDE_USAGE_STATS_FILE: path.join(root, 'stats-cache.json'),
      CLAUDE_USAGE_CONFIG_PATH: configFile,
      CLAUDE_USAGE_CREDENTIALS_FILE: credentialsFile,
      CLAUDE_USAGE_NO_REMOTE: '1',
      CLAUDE_USAGE_FAKE_OFFICIAL_ERROR: 'HTTP 401 unauthorized',
      PORT: String(port)
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    await waitUntil(async () => {
      const r = await get('/health', port);
      return r.status === 200 ? true : null;
    }, 8000, 200);

    const boot = await officialError(port);

    rotateCredentials(credentialsFile, 'r1');
    await waitForOfficialErrorChange(boot, port, 5000);
    /* Settle before reading: a doubled fetch from the same rotation (the bug
       this half guards against) would land within the same millisecond - see
       waitForOfficialErrorChange's comment. The exact final value is the real
       assertion, not how fast it arrived. */
    await new Promise(r => setTimeout(r, 800));
    let err = await officialError(port);
    check('rotation 1 triggers exactly one immediate refetch, and settles there',
      err, 'HTTP 401 unauthorized #1');

    rotateCredentials(credentialsFile, 'r2');
    await waitForOfficialErrorChange(err, port, 5000);
    await new Promise(r => setTimeout(r, 800));
    err = await officialError(port);
    check('a second, later rotation still resets and refetches once (the case this watcher exists to serve), and settles there - not #3 or #4 from doubled events',
      err, 'HTTP 401 unauthorized #2');

    checkTrue('server process is still alive', child.exitCode === null);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* collectWorkflows() in server.js slices its workflows/subtasks arrays down
 * to MAX_WORKFLOWS (24) / MAX_SUBTASKS (40) before returning them, because
 * the rendered lists must stay bounded. workflowsSeen/subtasksSeen exist so
 * a person looking at usagehtml.js's "Workflows (N active of M seen)" can
 * tell a genuinely-empty machine from a truncated list. Counting
 * workflows.length/subtasks.length AFTER that slice (the bug this guards
 * against) reports a number that can never exceed the cap, which is exactly
 * the case where the diagnostic is needed most. This writes comfortably more
 * than either cap and checks the Seen counts report the true, unclamped
 * total while the rendered lists (and their own counts.workflows /
 * counts.subtasks) stay capped. */
async function testSeenCountsSurviveTheCap() {
  console.log('workflowsSeen/subtasksSeen report the true pre-slice total, not the capped rendered list:');
  const port = 41815;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-test-seencap-'));
  const configFile = path.join(root, 'limits.json');
  writeConfig(configFile, VALID_CONFIG);
  const projects = path.join(root, 'projects');
  const wfDir = path.join(projects, 'C--fixture-seencap', 'sess-seencap', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });

  const TOTAL = 45; /* > MAX_WORKFLOWS (24) and > MAX_SUBTASKS (40) both */
  for (let i = 0; i < TOTAL; i++) {
    const id = 'wf_seencap' + String(i).padStart(3, '0');
    fs.writeFileSync(path.join(wfDir, id + '.json'), JSON.stringify({
      runId: id,
      workflowName: 'seencap-fixture',
      status: 'running', /* not in FINISHED_WORKFLOW -> counts as active */
      startTime: Date.now() - i * 1000,
      agentCount: 1,
      workflowProgress: [
        { type: 'workflow_agent', label: 'agent' + i, state: 'running' /* not in FINISHED_TASK -> active */ }
      ]
    }), 'utf8');
  }

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
    await waitUntil(async () => {
      const r = await get('/health', port);
      return r.status === 200 ? true : null;
    }, 8000, 200);

    const r = await get('/usage', port);
    check('/usage answers 200 for the seencap fixture', r.status, 200);
    const body = JSON.parse(r.body);
    const c = body.counts || {};

    check('workflowsSeen reports the true pre-slice total (45), not the MAX_WORKFLOWS cap (24)',
      c.workflowsSeen, TOTAL);
    check('subtasksSeen reports the true pre-slice total (45), not the MAX_SUBTASKS cap (40)',
      c.subtasksSeen, TOTAL);
    check('the rendered workflow list itself still stays capped at MAX_WORKFLOWS',
      (body.workflows || []).length, 24);
    check('the rendered subtask list itself still stays capped at MAX_SUBTASKS',
      (body.subtasks || []).length, 40);
    check('counts.workflows (active, rendered) is likewise capped at 24', c.workflows, 24);
    check('counts.subtasks (active, rendered) is likewise capped at 40', c.subtasks, 40);

    checkTrue('server process is still alive', child.exitCode === null);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  await runMalformedRequestSuite();
  await testNeverBuilt();
  await testStaleAfterHealthy();
  await testTornAppend();
  await testQuotaTaskRepro();
  await testQuotaMostRecentWins();
  await testQuotaRequires429();
  await testCredentialsWatcherRateLimited();
  await testCredentialsWatcherResetsOnGenuineWrite();
  await testSeenCountsSurviveTheCap();
  testEnvOverridesMatchDocs();

  console.log('');
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error('test harness error:', err.message);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
