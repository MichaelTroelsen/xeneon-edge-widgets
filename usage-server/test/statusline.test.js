#!/usr/bin/env node
/* Tests the statusline path's freshness rules, and that no credential material
 * reaches the served payload.
 *
 * Both were previously only hand-checked. The freshness rules decide whether a
 * reading is shown as current, shown as stale, or withheld — an undercount
 * presented as live is the failure this project has already had once — and the
 * credential claim was written in the README with no test behind it at all.
 *
 * Everything here is hermetic. CLAUDE_USAGE_NO_REMOTE stops the server polling
 * Anthropic, which matters: without it a spawned test server makes a real
 * request to an endpoint that is already rate-limited.
 *
 * `?at=` is used rather than plain `/usage` because it rebuilds on demand, so
 * each fixture can be asserted without waiting out the 20s refresh.
 *
 * Usage:  node usage-server/test/statusline.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 41798;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-sl-test-'));
const PROJECTS = path.join(ROOT, 'projects');
const SL_FILE = path.join(ROOT, 'statusline-usage.json');
const CRED_FILE = path.join(ROOT, 'credentials.json');

/* Distinctive, obviously fake, and shaped like the real things. */
const FAKE_ACCESS = 'sk-ant-oat01-FAKEACCESSTOKEN-doNotLeak-0123456789';
const FAKE_REFRESH = 'sk-ant-ort01-FAKEREFRESHTOKEN-doNotLeak-9876543210';

const MINUTE = 60 * 1000;

function writeStatusline(obj) {
  fs.writeFileSync(SL_FILE, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}

function reading(ageMs, windows) {
  return {
    capturedAt: Date.now() - ageMs,
    rateLimits: windows,
    claudeCodeVersion: '2.1.251',
    sessionId: 'fixture'
  };
}

const BOTH = {
  five_hour: { used_percentage: 23.5, resets_at: Math.floor(Date.now() / 1000) + 3600 },
  seven_day: { used_percentage: 41.2, resets_at: Math.floor(Date.now() / 1000) + 86400 }
};

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

async function main() {
  fs.mkdirSync(PROJECTS, { recursive: true });

  /* A transcript whose prompt contains a key: labels are built from prompt
     text, so this is the realistic way a secret reaches the display. */
  const projDir = path.join(PROJECTS, 'C--fixture-secret');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'aaaabbbb-sess.jsonl'),
    JSON.stringify({ type: 'mode', mode: 'default' }) + '\n', 'utf8');

  fs.writeFileSync(CRED_FILE, JSON.stringify({
    claudeAiOauth: {
      accessToken: FAKE_ACCESS,
      refreshToken: FAKE_REFRESH,
      expiresAt: Date.now() + 8 * 3600 * 1000,
      scopes: ['user:profile']
    }
  }), 'utf8');

  writeStatusline(reading(0, BOTH));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: PROJECTS,
      CLAUDE_USAGE_STATUSLINE_FILE: SL_FILE,
      CLAUDE_USAGE_CREDENTIALS_FILE: CRED_FILE,
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

    console.log('statusline freshness:');
    let s = await snapshot();
    check('a fresh reading is served', s.official.ok, true);
    check('and named as the statusline', s.official.source, 'Claude Code statusline');
    check('with both windows', [s.official.fiveHour.percent, s.official.sevenDay.percent], [24, 41]);
    check('resets_at seconds become milliseconds',
      s.official.fiveHour.resetsAt, BOTH.five_hour.resets_at * 1000);
    check('a fresh reading is not marked stale', !s.official.stale, true);

    writeStatusline(reading(20 * MINUTE, BOTH));
    s = await snapshot();
    check('past 10 minutes it is marked stale', s.official.stale, true);
    check('but still served', s.official.ok, true);

    writeStatusline(reading(50 * MINUTE, BOTH));
    s = await snapshot();
    check('past 45 minutes it is withheld', s.official.ok, false);

    writeStatusline(reading(-5 * MINUTE, BOTH));
    s = await snapshot();
    check('a reading from the future is withheld', s.official.ok, false);

    writeStatusline('{ not json');
    s = await snapshot();
    check('a malformed file is withheld', s.official.ok, false);

    fs.unlinkSync(SL_FILE);
    s = await snapshot();
    check('an absent file is withheld', s.official.ok, false);

    writeStatusline(reading(0, { seven_day: BOTH.seven_day }));
    s = await snapshot();
    check('one window alone is still served', s.official.ok, true);
    check('the absent window is null, not zero', s.official.fiveHour, null);
    check('the present one is intact', s.official.sevenDay.percent, 41);

    writeStatusline(reading(0, {}));
    s = await snapshot();
    check('a reading with no windows at all is withheld', s.official.ok, false);

    console.log('credentials:');
    writeStatusline(reading(0, BOTH));
    const usage = await get('/usage?at=' + Date.now());
    const debug = await get('/usagehtml');
    for (const [label, needle] of [
      ['the access token', FAKE_ACCESS],
      ['the refresh token', FAKE_REFRESH]
    ]) {
      check(`${label} is absent from /usage`, usage.includes(needle), false);
      check(`${label} is absent from /usagehtml`, debug.includes(needle), false);
    }
    for (const needle of ['sk-ant-', 'Bearer ', 'accessToken', 'refreshToken']) {
      check(`no "${needle}" anywhere in /usage`, usage.includes(needle), false);
    }

    console.log('label redaction:');
    /* Subtask rows are named from the agent's prompt, so a key pasted into one
       would otherwise be rendered on the display. Build a live run whose prompt
       carries the key and read the label back out of the feed. */
    const runDir = path.join(PROJECTS, 'C--fixture-secret', 'sess-run', 'subagents', 'workflows', 'wf_secret001');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'agent-sec1.jsonl'), JSON.stringify({
      type: 'user', message: { role: 'user', content: 'rotate ' + FAKE_ACCESS + ' for me' }
    }) + '\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'agent-sec1.meta.json'),
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1, model: 'haiku' }), 'utf8');
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
      JSON.stringify({ type: 'started', agentId: 'sec1' }) + '\n', 'utf8');

    const withRun = await snapshot();
    const label = (withRun.subtasks[0] || {}).label || '';
    check('the run is picked up', withRun.subtasks.length, 1);
    check('the key is not in the label', label.includes('sk-ant-'), false);
    check('it is replaced, not silently dropped', label.includes('[redacted]'), true);
    check('the surrounding words survive', label.startsWith('rotate '), true);
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
