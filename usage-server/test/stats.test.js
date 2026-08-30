#!/usr/bin/env node
/* Tests the /usage `stats` block, sourced from Claude Code's own
 * ~/.claude/stats-cache.json rollup.
 *
 * THE DEGRADATION IS THE POINT. stats-cache.json is an UNDOCUMENTED Claude
 * Code internal already at `version: 5` - the shape has changed five times
 * and will change again without warning. A server that serves a half-built
 * block from a schema it does not understand would draw a confident, wrong
 * picture on the widget, which is worse than showing nothing. So this suite
 * spends most of its checks on the ways the file can go wrong - absent,
 * unparseable, an unrecognised `version` - and asserts that in every one of
 * them /usage still answers with the rest of its payload intact and
 * `stats.unavailable` set, rather than throwing or serving a partial block.
 * The happy path is one case among several, not the point of the file.
 *
 * Everything here is hermetic. CLAUDE_USAGE_NO_REMOTE stops the server
 * polling Anthropic - without it a spawned test server makes a real request
 * to an endpoint that is already rate-limited, using the developer's real
 * credentials. CLAUDE_USAGE_STATS_FILE, CLAUDE_USAGE_PROJECTS_DIR and
 * CLAUDE_USAGE_STATUSLINE_FILE all point at a fixture root so this never
 * touches the real ~/.claude.
 *
 * `?at=` is used rather than plain `/usage` because it rebuilds on demand, so
 * each fixture can be asserted without waiting out the 10s refresh.
 *
 * Usage:  node usage-server/test/stats.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 41800;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stats-test-'));
const PROJECTS = path.join(ROOT, 'projects');
const STATS_FILE = path.join(ROOT, 'stats-cache.json');

/* Shaped like the real thing (confirmed against the real
   ~/.claude/stats-cache.json before writing this), trimmed to a couple of
   entries - the exact counts are not the point, the shape is. */
function validStats(overrides) {
  return Object.assign({
    version: 5,
    lastComputedDate: '2026-08-29',
    dailyActivity: [
      { date: '2026-08-28', messageCount: 40, sessionCount: 2, toolCallCount: 15 },
      { date: '2026-08-29', messageCount: 55, sessionCount: 3, toolCallCount: 22 }
    ],
    dailyModelTokens: [
      { date: '2026-08-29', tokensByModel: { 'claude-sonnet-5': 858086407 } }
    ],
    dailyModelTokensVersion: 5,
    modelUsage: {
      'claude-sonnet-5': {
        inputTokens: 1924626,
        outputTokens: 14773841,
        cacheReadInputTokens: 6106768218,
        cacheCreationInputTokens: 447672332,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0
      }
    },
    totalSessions: 296,
    totalMessages: 292800,
    longestSession: {
      sessionId: 'ff0ff92d-332c-4dc8-90ff-c60d8a0cbc75',
      timestamp: '2026-07-29T19:34:12.117Z',
      duration: 826626980,
      messageCount: 333
    },
    firstSessionDate: '2025-11-19T15:27:20.311Z',
    hourCounts: { '5': 1, '6': 8, '20': 31, '21': 31 }
  }, overrides);
}

function writeStats(obj) {
  fs.writeFileSync(STATS_FILE, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* Each call rebuilds, so it picks up whatever the fixture file now holds. */
async function snapshot() {
  return JSON.parse(await get('/usage?at=' + Date.now()));
}

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

/* The rest of the payload must be there and sane, whatever stats did. This is
   the assertion that matters most in every degradation case: a stats failure
   must never take the rest of /usage down with it. */
function checkPayloadIntact(s) {
  check('the rest of the payload is intact: session block present', typeof s.session, 'object');
  check('the rest of the payload is intact: counts block present', typeof s.counts, 'object');
  check('the rest of the payload is intact: sessions array present', Array.isArray(s.sessions), true);
  check('the rest of the payload is intact: workflows array present', Array.isArray(s.workflows), true);
}

async function main() {
  fs.mkdirSync(PROJECTS, { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: PROJECTS,
      CLAUDE_USAGE_STATUSLINE_FILE: path.join(ROOT, 'no-statusline.json'),
      CLAUDE_USAGE_STATS_FILE: STATS_FILE,
      /* Without this the test server polls Anthropic on startup with the
         developer's real credentials - this has actually happened. It must be
         set before the server's first rebuild(), which is why it is part of
         the spawned child's env rather than set after the fact. */
      CLAUDE_USAGE_NO_REMOTE: '1',
      PORT: String(PORT)
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    for (let i = 0; i < 50; i++) {
      try { await get('/usage'); break; } catch (err) { /* not up */ }
      if (child.exitCode !== null) throw new Error('server exited, code ' + child.exitCode);
      await new Promise(r => setTimeout(r, 200));
    }

    console.log('hermetic:');
    /* Proves the guard is in force, the same way live-detection.test.js does -
       without it this test would poll Anthropic for real, every run. */
    const boot = await snapshot();
    check('the server did not poll Anthropic',
      /CLAUDE_USAGE_NO_REMOTE/.test((boot.official && boot.official.error) || ''), true);

    console.log('degradation - file absent:');
    /* No file has been written yet at all. */
    let s = await snapshot();
    check('stats is withheld', s.stats == null || !!s.stats.unavailable, true);
    check('an explicit reason is given', typeof s.stats.unavailable, 'string');
    check('the reason names the missing file', s.stats.unavailable.includes('not found'), true);
    checkPayloadIntact(s);

    console.log('degradation - unparseable file:');
    writeStats('{ this is not json');
    s = await snapshot();
    check('stats is withheld', !!s.stats.unavailable, true);
    check('the reason says it could not be parsed', s.stats.unavailable.includes('could not be parsed'), true);
    checkPayloadIntact(s);

    console.log('degradation - unrecognised version:');
    writeStats(validStats({ version: 6 }));
    s = await snapshot();
    check('stats is withheld', !!s.stats.unavailable, true);
    check('the reason names the offending version', s.stats.unavailable.includes('6'), true);
    checkPayloadIntact(s);

    writeStats(validStats({ version: 1 }));
    s = await snapshot();
    check('an older unrecognised version is withheld too', !!s.stats.unavailable, true);
    checkPayloadIntact(s);

    console.log('degradation - version present but shape missing a required field:');
    /* A `version: 5` file that is missing a field this server reads is exactly
       the "shape changed without warning" case the version check exists to
       catch when the version itself does not move. */
    const broken = validStats({});
    delete broken.dailyActivity;
    writeStats(broken);
    s = await snapshot();
    check('stats is withheld', !!s.stats.unavailable, true);
    checkPayloadIntact(s);

    console.log('happy path:');
    const good = validStats({});
    writeStats(good);
    s = await snapshot();
    check('stats is served', !!s.stats && !s.stats.unavailable, true);
    check('dailyActivity carries through', s.stats.dailyActivity, good.dailyActivity);
    check('dailyModelTokens carries through', s.stats.dailyModelTokens, good.dailyModelTokens);
    check('modelUsage carries through', s.stats.modelUsage, good.modelUsage);
    check('totalSessions carries through', s.stats.totalSessions, good.totalSessions);
    check('totalMessages carries through', s.stats.totalMessages, good.totalMessages);
    check('longestSession carries through', s.stats.longestSession, good.longestSession);
    check('firstSessionDate carries through', s.stats.firstSessionDate, good.firstSessionDate);
    check('hourCounts carries through', s.stats.hourCounts, good.hourCounts);
    checkPayloadIntact(s);

    console.log('recovery:');
    /* A file that goes bad and then comes back must be re-served, not stuck
       on a cached failure - and a valid file that is edited must be picked
       up, not stuck on a cached success. Proves the mtime cache invalidates
       both directions. */
    writeStats('{ broken again');
    s = await snapshot();
    check('goes back to withheld', !!s.stats.unavailable, true);

    writeStats(validStats({ totalSessions: 999 }));
    s = await snapshot();
    check('recovers once the file is valid again', s.stats.totalSessions, 999);

    console.log('no session or run has to exist for stats to serve:');
    /* stats-cache.json is independent of the transcript-derived activity
       feed - an idle machine with no recent sessions must still get a
       stats block if the file is there. */
    check('sessions is empty on this fixture tree', s.sessions.length, 0);
    check('stats is still served', !!s.stats && !s.stats.unavailable, true);
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
