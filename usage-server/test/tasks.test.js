#!/usr/bin/env node
/* Tests usage-server/tasks.js against fixture repos.
 *
 * Hermetic: CLAUDE_TASKS_REGISTRY points at a throwaway registry file whose
 * `projects` map names directories under a mkdtemp root, so this never reads
 * the real ~/.claude.json or any real repo.
 *
 * Usage:  node usage-server/test/tasks.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-feed-'));

/* Writes <root>/<name>/.claude/tasks/whattask.json and returns the repo dir. */
function makeRepo(name, plan) {
  const dir = path.join(WORK, name);
  const tasksDir = path.join(dir, '.claude', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (plan !== null) {
    fs.writeFileSync(path.join(tasksDir, 'whattask.json'),
      typeof plan === 'string' ? plan : JSON.stringify(plan));
  }
  return dir;
}

/* A registry in the shape of ~/.claude.json: a `projects` object whose KEYS
   are absolute project paths. Only the keys matter. */
function writeRegistry(paths) {
  const projects = {};
  for (const p of paths) projects[p] = { lastCost: 0 };
  const file = path.join(WORK, 'registry-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(file, JSON.stringify({ numStartups: 1, projects: projects }));
  return file;
}

function load(registryFile) {
  process.env.CLAUDE_TASKS_REGISTRY = registryFile;
  delete require.cache[require.resolve('../tasks.js')];
  return require('../tasks.js');
}

console.log('discovery:');

const alpha = makeRepo('alpha', { tasks: [], closed: [] });
const beta = makeRepo('beta', { tasks: [], closed: [] });
const noQueue = path.join(WORK, 'no-queue');
fs.mkdirSync(noQueue, { recursive: true });

{
  const tasks = load(writeRegistry([alpha, beta, noQueue]));
  check('only repos with a whattask.json are discovered',
    tasks.discover().map(r => r.name), ['alpha', 'beta']);
}

{
  /* ~/.claude.json really does register the same project under both slash
     styles - SIDM2 appears as C:\...\SIDM2 and C:/.../SIDM2 - so a naive
     pass counts it twice and doubles its open count. */
  const both = [alpha, alpha.replace(/\\/g, '/'), alpha.replace(/\//g, path.sep)];
  const tasks = load(writeRegistry(both));
  check('a repo registered under two slash styles is discovered once',
    tasks.discover().length, 1);
}

{
  const tasks = load(writeRegistry([path.join(WORK, 'gone')]));
  check('a registered path that no longer exists is skipped, not thrown on',
    tasks.discover(), []);
}

{
  const missing = path.join(WORK, 'no-registry.json');
  const tasks = load(missing);
  check('a missing registry yields no repos rather than throwing',
    tasks.discover(), []);
}

console.log('reading a repo:');

const counted = makeRepo('counted', {
  tasks: [
    { id: 'a', title: 'A', mode: 'subtask', lane: 'parallel' },
    { id: 'b', title: 'B', mode: 'requires-user', lane: 'serial', blocked_on: 'a human' },
    { id: 'c', title: 'C', mode: 'requires-user', blocked_on: 'also a human' },
    { id: 'd', title: 'D' }
  ],
  closed: [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
});

{
  const tasks = load(writeRegistry([counted]));
  const r = tasks.readRepo(tasks.discover()[0]);
  check('open counts the tasks array', r.open, 4);
  check('closed counts the closed array', r.closed, 3);
  check('byMode groups by mode, absent mode becoming unknown',
    r.byMode, { subtask: 1, 'requires-user': 2, unknown: 1 });
  check('byLane groups by lane, absent lane becoming unknown',
    r.byLane, { parallel: 1, serial: 1, unknown: 2 });
  check('blocked counts the tasks carrying a blocked_on', r.blocked, 2);
  check('a readable repo reports no error', r.error, null);
}

console.log('a repo that cannot be read:');

{
  const broken = makeRepo('broken', '{ this is not json');
  const tasks = load(writeRegistry([broken]));
  const r = tasks.readRepo(tasks.discover()[0]);
  check('a malformed whattask.json is still listed', r.name, 'broken');
  check('and its counts are zero rather than absent', [r.open, r.closed], [0, 0]);
  check('and it carries an error string naming the problem',
    typeof r.error === 'string' && r.error.length > 0, true);
}

{
  /* A file whose top level is valid JSON but not the expected shape - an
     array, or an object with no tasks key - must not throw either. */
  const wrongShape = makeRepo('wrong-shape', [1, 2, 3]);
  const tasks = load(writeRegistry([wrongShape]));
  const r = tasks.readRepo(tasks.discover()[0]);
  check('a whattask.json of the wrong shape reads as an empty queue',
    [r.open, r.closed, r.error], [0, 0, null]);
}

console.log('run history:');

const { execFileSync } = require('child_process');

/* A real git repo with two commits, so commitTimes() is tested against git
   rather than against a stub of it - the batching is the part that can be
   wrong, and a stub would not exercise it. */
function makeGitRepo(name, lines) {
  const dir = makeRepo(name, { tasks: [], closed: [] });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  const shas = [];
  for (let i = 0; i < 2; i++) {
    fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), 'x');
    git('add', '-A');
    execFileSync('git', ['commit', '-q', '-m', 'c' + i], {
      cwd: dir,
      stdio: 'pipe',
      env: Object.assign({}, process.env, {
        GIT_AUTHOR_DATE: '2026-0' + (i + 1) + '-01T12:00:00+00:00',
        GIT_COMMITTER_DATE: '2026-0' + (i + 1) + '-01T12:00:00+00:00'
      })
    });
    shas.push(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
  }
  const runsPath = path.join(dir, '.claude', 'tasks', 'runs.jsonl');
  fs.writeFileSync(runsPath, lines(shas).map(o => JSON.stringify(o)).join('\n') + '\n');
  return { dir, shas };
}

{
  const { dir, shas } = makeGitRepo('history', s => ([
    { id: 'one', head: s[0], outcome: 'done', model: 'sonnet', effort: 'low', mode: 'subtask' },
    { id: 'two', head: s[0], outcome: 'done', model: 'sonnet', effort: 'low', mode: 'subtask' },
    { id: 'three', head: s[1], outcome: 'partial', model: 'opus', mode: 'main' }
  ]));
  const tasks = load(writeRegistry([dir]));

  const read = tasks.readRuns(dir);
  check('every well-formed line is read', read.runs.length, 3);
  check('reading runs reports no error', read.error, null);

  const t = tasks.commitTimes(dir, [shas[0], shas[1]]);
  check('both SHAs resolve to a commit time', Object.keys(t.times).length, 2);
  check('the time is the commit date, in epoch ms',
    new Date(t.times[shas[0]]).toISOString(), '2026-01-01T12:00:00.000Z');

  const h = tasks.datedHistory(dir, read.runs);
  check('every run gets an entry', h.history.length, 3);
  check('the source of the time is named as the commit, not the run',
    h.history.every(e => e.atSource === 'commit'), true);
  check('an absent effort reads as unknown rather than a default',
    h.history.find(e => e.outcome === 'partial').effort, 'unknown');
  check('entries are ordered oldest first',
    h.history[0].at <= h.history[2].at, true);
}

{
  /* An abbreviated head - runs.jsonl records them 7 characters long - must
     resolve, because git echoes the FULL objectname back and a naive lookup
     by the requested key finds nothing. */
  const { dir, shas } = makeGitRepo('abbrev', s => ([
    { id: 'short', head: s[0].slice(0, 7), outcome: 'done' }
  ]));
  const tasks = load(writeRegistry([dir]));
  const h = tasks.datedHistory(dir, tasks.readRuns(dir).runs);
  check('an abbreviated SHA resolves to its commit time', h.history.length, 1);
}

{
  /* A torn or half-written final line must cost that line, not the file -
     runs.jsonl is appended to by concurrent runners. */
  const { dir } = makeGitRepo('torn', s => ([
    { id: 'ok', head: s[0], outcome: 'done' }
  ]));
  fs.appendFileSync(path.join(dir, '.claude', 'tasks', 'runs.jsonl'), '{"id":"tor');
  const tasks = load(writeRegistry([dir]));
  check('a torn last line is skipped and the rest survive',
    tasks.readRuns(dir).runs.length, 1);
}

{
  /* A SHA that git does not know - history rewritten, or the record predates
     a rebase - must drop that entry with a reason, not date it wrongly. */
  const { dir } = makeGitRepo('unknown-sha', s => ([
    { id: 'ok', head: s[0], outcome: 'done' },
    { id: 'gone', head: '0000000000000000000000000000000000000000', outcome: 'done' }
  ]));
  const tasks = load(writeRegistry([dir]));
  const h = tasks.datedHistory(dir, tasks.readRuns(dir).runs);
  check('a run whose SHA git cannot resolve is dropped', h.history.length, 1);
  check('and the drop is reported rather than silent',
    typeof h.error === 'string' && /1/.test(h.error), true);
}

{
  /* Not a git repo at all: history is unavailable with a stated reason, and
     nothing throws. */
  const plain = makeRepo('not-git', { tasks: [], closed: [] });
  fs.writeFileSync(path.join(plain, '.claude', 'tasks', 'runs.jsonl'),
    JSON.stringify({ id: 'a', head: 'deadbeef', outcome: 'done' }) + '\n');
  const tasks = load(writeRegistry([plain]));
  const h = tasks.datedHistory(plain, tasks.readRuns(plain).runs);
  check('a repo that is not a git checkout yields no history', h.history, []);
  check('and says why', typeof h.error === 'string' && h.error.length > 0, true);
}

{
  const noRuns = makeRepo('no-runs', { tasks: [], closed: [] });
  const tasks = load(writeRegistry([noRuns]));
  check('a repo with no runs.jsonl yet is not an error',
    tasks.readRuns(noRuns), { runs: [], error: null });
}

console.log('lock holders:');

{
  const held = makeRepo('held', { tasks: [{ id: 'a', mode: 'subtask' }], closed: [] });
  fs.writeFileSync(path.join(held, '.claude', 'tasks', 'serial.lock'), JSON.stringify([
    { run: 'runqueue', task: 'fix-the-pager', paths: ['ClaudeUsage/scripts'],
      at: '2026-09-05T10:00:00Z' }
  ]));
  const tasks = load(writeRegistry([held]));
  const r = tasks.readRepo(tasks.discover()[0]);
  check('a holder record is read off serial.lock', r.holders.length, 1);
  check('and keeps the task it names', r.holders[0].task, 'fix-the-pager');
}

{
  /* [] is serial.lock's RESTING state - it is empty in all five real repos
     right now, and only fills while a /runqueue is mid-flight. An empty lock
     is not an error and not an absence. */
  const idle = makeRepo('idle', { tasks: [], closed: [] });
  fs.writeFileSync(path.join(idle, '.claude', 'tasks', 'serial.lock'), '[]');
  const tasks = load(writeRegistry([idle]));
  const r = tasks.readRepo(tasks.discover()[0]);
  check('an empty lock reads as no holders, with no error',
    [r.holders.length, r.error], [0, null]);
}

{
  const noLock = makeRepo('no-lock', { tasks: [], closed: [] });
  const tasks = load(writeRegistry([noLock]));
  const r = tasks.readRepo(tasks.discover()[0]);
  check('an absent serial.lock is not an error either',
    [r.holders.length, r.error], [0, null]);
}

{
  const badLock = makeRepo('bad-lock', { tasks: [], closed: [] });
  fs.writeFileSync(path.join(badLock, '.claude', 'tasks', 'serial.lock'), '{ torn');
  const tasks = load(writeRegistry([badLock]));
  check('a malformed lock costs the holders, not the whole repo reading',
    tasks.readRepo(tasks.discover()[0]).holders, []);
}

console.log('the assembled payload:');

{
  const one = makeRepo('one', {
    tasks: [{ id: 'a', mode: 'subtask' }, { id: 'b', mode: 'requires-user', blocked_on: 'x' }],
    closed: [{ id: 'z' }]
  });
  const two = makeRepo('two', {
    tasks: [{ id: 'c', mode: 'subtask' }],
    closed: [{ id: 'y' }, { id: 'w' }]
  });
  const tasks = load(writeRegistry([one, two]));
  const snap = tasks.build();

  check('every discovered repo is in the payload',
    snap.repos.map(r => r.name), ['one', 'two']);
  check('totals sum the open counts', snap.totals.open, 3);
  check('totals sum the closed counts', snap.totals.closed, 3);
  check('totals count the repos', snap.totals.repos, 2);
  check('totals sum the blocked counts', snap.totals.blocked, 1);
  check('totals merge byMode across repos',
    snap.totals.byMode, { subtask: 2, 'requires-user': 1 });
  check('the payload is stamped', typeof snap.generatedAt, 'number');
  check('a payload with repos is not unavailable', snap.unavailable, null);
}

{
  const tasks = load(writeRegistry([]));
  const snap = tasks.build();
  check('no repos at all is stated, not served as an empty success',
    typeof snap.unavailable === 'string' && snap.unavailable.length > 0, true);
  check('and the repo list is still an array', Array.isArray(snap.repos), true);
}

{
  /* The live block server.js supplies is merged in beside the holders, and
     the two kinds of "running" stay distinguishable by kind - a lock holder
     and a Claude session are different claims about the machine. */
  const mixed = makeRepo('mixed', { tasks: [], closed: [] });
  fs.writeFileSync(path.join(mixed, '.claude', 'tasks', 'serial.lock'), JSON.stringify([
    { run: 'runqueue', task: 'a-task', at: '2026-09-05T10:00:00Z' }
  ]));
  const tasks = load(writeRegistry([mixed]));
  const snap = tasks.build({
    sessions: [{ label: 'a session', project: 'mixed', lastAt: 1 }],
    workflows: [{ label: 'a workflow', project: 'mixed', startedAt: 2 }],
    subtasks: []
  });
  check('holders and live activity are both in running',
    snap.running.map(r => r.kind).sort(), ['holder', 'session', 'workflow']);
  check('holders sort ahead of live activity', snap.running[0].kind, 'holder');
  check('a holder keeps its start time, parsed from the ISO string it records',
    snap.running[0].since, Date.parse('2026-09-05T10:00:00Z'));
}

{
  /* Outcomes are tallied across every repo, from records that may name an
     outcome this machine has never seen before. */
  const { dir } = makeGitRepo('outcomes', s => ([
    { id: 'a', head: s[0], outcome: 'done' },
    { id: 'b', head: s[0], outcome: 'done' },
    { id: 'c', head: s[1], outcome: 'partial' },
    { id: 'd', head: s[1] }
  ]));
  const tasks = load(writeRegistry([dir]));
  const snap = tasks.build();
  check('byOutcome counts every run, an absent outcome becoming unknown',
    snap.totals.byOutcome, { done: 2, partial: 1, unknown: 1 });
  check('history reaches the payload', snap.history.length, 4);
  check('and is ordered oldest first across repos',
    snap.history.every((e, i) => i === 0 || snap.history[i - 1].at <= e.at), true);
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
