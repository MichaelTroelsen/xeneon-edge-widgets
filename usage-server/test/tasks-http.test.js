#!/usr/bin/env node
/* Tests the /tasks route end to end against a spawned server.
 *
 * Port 41816: 41777 is the live feed serving the physical device and
 * 41798-41815 belong to the existing suites (see the comment in
 * http.test.js). One spawned server, torn down in a finally.
 *
 * Usage:  node usage-server/test/tasks-http.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 41816;
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

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-http-'));

function makeRepo(name, plan) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(path.join(dir, '.claude', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'tasks', 'whattask.json'), JSON.stringify(plan));
  return dir;
}

/* TWO repos, one NESTED a level deeper than the other. This is the shape the
   old collectQueuedTasks() scan got wrong: it walked one level of ~/claude, so
   a repo under c64server/ was invisible to it - 122 of 210 real open tasks
   sat in the two it could not see. */
const flat = makeRepo('flat-repo', {
  tasks: [{ id: 'a', mode: 'subtask', title: 'A flat task' }],
  closed: [{ id: 'z' }]
});
const nestedParent = path.join(WORK, 'group');
fs.mkdirSync(nestedParent, { recursive: true });
const nested = makeRepo(path.join('group', 'nested-repo'), {
  tasks: [{ id: 'b', mode: 'main', title: 'A nested task' },
          { id: 'c', mode: 'requires-user', title: 'A blocked one', blocked_on: 'a human' }],
  closed: []
});

const registry = path.join(WORK, 'registry.json');
const projects = {};
projects[flat] = {};
projects[nested] = {};
fs.writeFileSync(registry, JSON.stringify({ projects: projects }));

const projectsDir = path.join(WORK, 'projects');
fs.mkdirSync(projectsDir, { recursive: true });

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body,
                                    type: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

async function waitForServer(totalMs) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    try { await get('/health'); return true; } catch (err) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      CLAUDE_USAGE_NO_REMOTE: '1',
      CLAUDE_TASKS_REGISTRY: registry,
      CLAUDE_USAGE_PROJECTS_DIR: projectsDir
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    if (!await waitForServer(10000)) {
      console.log('  FAIL  the server never came up');
      failures++;
      return;
    }

    console.log('the /tasks route:');
    const res = await get('/tasks');
    check('/tasks answers 200', res.status, 200);
    check('and answers as JSON', /application\/json/.test(res.type), true);

    const body = JSON.parse(res.body);
    check('both fixture repos are served, the nested one included',
      body.repos.map(r => r.name).sort(), ['flat-repo', 'nested-repo']);
    check('open counts are summed across them', body.totals.open, 3);
    check('closed counts are summed across them', body.totals.closed, 1);
    check('blocked is counted', body.totals.blocked, 1);
    check('running is an array even when nothing is running',
      Array.isArray(body.running), true);
    check('history is the aggregate, not a record list',
      typeof body.history === 'object' && !Array.isArray(body.history), true);
    check('a payload with repos is not unavailable', body.unavailable, null);
    check('the raw records are not shipped by default',
      body.historyRecords, undefined);

    const raw = JSON.parse((await get('/tasks?raw=1')).body);
    check('?raw=1 adds them for debugging', Array.isArray(raw.historyRecords), true);

    console.log('one project over http:');
    const proj = JSON.parse((await get('/tasks?project=flat-repo')).body);
    check('the named project answers with its own task list', proj.tasks.length, 1);
    check('and carries only the fields a row draws',
      Object.keys(proj.tasks[0]).sort(),
      ['blocked', 'effort', 'id', 'lane', 'mode', 'model', 'title']);
    check('the nested project is reachable the same way',
      JSON.parse((await get('/tasks?project=nested-repo')).body).tasks.length, 2);
    const unknown = JSON.parse((await get('/tasks?project=nope')).body);
    check('an unknown name answers with an error rather than an empty success',
      typeof unknown.error === 'string' && unknown.error.length > 0, true);
    /* A malformed escape is the caller's mistake, and must not be allowed to
       throw inside the request handler - that tears the whole process down and
       the feed is launched with no restart supervision. */
    const bad = await get('/tasks?project=%');
    check('a malformed percent-escape is a 4xx, not a dead server', bad.status, 400);
    check('and the server is still answering afterwards',
      (await get('/tasks')).status, 200);

    console.log('the /usage route, which must not have moved:');
    const usage = await get('/usage');
    check('/usage still answers 200 alongside /tasks', usage.status, 200);
    const u = JSON.parse(usage.body);
    check('and its body is still an object, not null', typeof u, 'object');
    check('and it is not the task payload', u.repos, undefined);

    /* The scan behind /usage's queued count now shares the task feed's
       discovery, so it sees the nested repo it used to walk straight past.
       The count is all /usage exposes of it - collectQueuedTasks() builds a
       list but only its length reaches the payload - so the count is what
       this asserts: 1 task in the flat repo plus 2 in the nested one. A scan
       that could not see the nested repo would report 1. */
    check('the queued count covers BOTH repos, the nested one included',
      u.counts.queued, 3);
  } finally {
    server.kill();
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
