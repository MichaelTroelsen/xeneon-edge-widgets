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
  /* A codepoint compare sorts every capital ahead of every lowercase letter,
     so 'SIDM2' would land before 'claude-setup' - not how a person
     alphabetises. Registered in the "wrong" order on purpose (SIDM2 first),
     so a comparator that merely preserved input order could not fake a
     pass here. */
  const sidm2 = makeRepo('SIDM2', { tasks: [], closed: [] });
  const claudeSetup = makeRepo('claude-setup', { tasks: [], closed: [] });
  const tasks = load(writeRegistry([sidm2, claudeSetup]));
  check('discover() sorts case-insensitively: claude-setup before SIDM2',
    tasks.discover().map(r => r.name), ['claude-setup', 'SIDM2']);
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

console.log('commit time caching:');

{
  /* The point of the cache: a commit's committer date cannot change once the
     object exists, so a SHA that resolved on one build must not cost a git
     process on the next. Five real repos rebuilding every 10s, forever, is
     the cost this removes. */
  const { dir, shas } = makeGitRepo('cache-repo', s => ([
    { id: 'one', head: s[0], outcome: 'done' },
    { id: 'two', head: s[1], outcome: 'done' }
  ]));
  const tasks = load(writeRegistry([dir]));

  tasks.resetCommitTimeCache();
  const first = tasks.build();
  const spawnsAfterFirst = tasks.getGitSpawnCount();
  check('the first build over a fresh cache does spawn git', spawnsAfterFirst > 0, true);

  const second = tasks.build();
  check('a second build over the SAME unchanged repo spawns NO git process',
    tasks.getGitSpawnCount(), spawnsAfterFirst);
  check('and still dates every record from the cache',
    second.history.runs, first.history.runs);

  /* A new head - a real /runtask appending a fresh line - must still resolve,
     never permanently hidden by the cache. */
  fs.writeFileSync(path.join(dir, 'f-new.txt'), 'y');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'c-new'], {
    cwd: dir, stdio: 'pipe',
    env: Object.assign({}, process.env, {
      GIT_AUTHOR_DATE: '2026-03-01T12:00:00+00:00',
      GIT_COMMITTER_DATE: '2026-03-01T12:00:00+00:00'
    })
  });
  const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  fs.appendFileSync(path.join(dir, '.claude', 'tasks', 'runs.jsonl'),
    JSON.stringify({ id: 'three', head: newHead, outcome: 'done' }) + '\n');

  const spawnsBeforeThird = tasks.getGitSpawnCount();
  const third = tasks.build();
  check('a NEW head still resolves, growing runs.jsonl is not permanently undated',
    third.history.runs, 3);
  check('resolving the new head spawns git again (it was never in the cache)',
    tasks.getGitSpawnCount() > spawnsBeforeThird, true);

  const spawnsAfterThird = tasks.getGitSpawnCount();
  tasks.build();
  check('once the new head is cached too, the next build again spawns no git',
    tasks.getGitSpawnCount(), spawnsAfterThird);
}

{
  /* A SHA git does not know yet must be retried every call, not cached as a
     permanent negative - a rebase or a slow push can make it resolvable
     later, and a negative cache would hide it forever. */
  const { dir } = makeGitRepo('cache-miss-repo', s => ([
    { id: 'known', head: s[0], outcome: 'done' },
    { id: 'unknown', head: '1111111111111111111111111111111111111111', outcome: 'done' }
  ]));
  const tasks = load(writeRegistry([dir]));
  tasks.resetCommitTimeCache();

  tasks.build();
  const spawnsAfterFirst = tasks.getGitSpawnCount();
  tasks.build();
  check('an unresolved SHA is retried on every build, so git is spawned again',
    tasks.getGitSpawnCount() > spawnsAfterFirst, true);
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
  /* THE REAL RECORD SHAPE, copied from a live serial.lock rather than inferred
     from LOCKING.md - whose example is the MUTEX OWNER file, a different thing
     with different fields. A registry record is { task, head, touches, pid,
     host }: the path list is `touches`, not `paths`, and there is no
     timestamp at all, so a holder has no age and claiming one would be
     inventing it. The first version of this code read holder.paths and
     holder.at, and rendered neither. */
  const live = makeRepo('live-lock', { tasks: [], closed: [] });
  fs.writeFileSync(path.join(live, '.claude', 'tasks', 'serial.lock'), JSON.stringify([
    { task: 'sdi-control-rerun-at-j8', head: 'ff52cb4',
      touches: ['r:pyscript/sdi_native_sweep.py', 'rw:drivers_src/mon/layout.inc',
                'rw:out/romuzak_driver.prg'],
      pid: 26852, host: 'TDZDesktop' }
  ]));
  const tasks = load(writeRegistry([live]));
  const run = tasks.build().running[0];
  check('a real holder is labelled by its task', run.label, 'sdi-control-rerun-at-j8');
  check('its locked paths come from `touches`, and lead with the count',
    run.detail,
    '3 paths · r:pyscript/sdi_native_sweep.py, rw:drivers_src/mon/layout.inc, rw:out/romuzak_driver.prg');
  check('a single path is not called "1 paths"',
    tasks.build().running[0].detail.startsWith('3 paths'), true);
  check('it carries the commit it is working from', run.head, 'ff52cb4');
  /* Not "0", not Date.now() - the record has no time in it. */
  check('and has NO age, because the record carries no timestamp', run.since, null);
}

{
  const one = makeRepo('one-path-lock', { tasks: [], closed: [] });
  fs.writeFileSync(path.join(one, '.claude', 'tasks', 'serial.lock'), JSON.stringify([
    { task: 't', touches: ['rw:a.js'] }
  ]));
  const tasks = load(writeRegistry([one]));
  check('one locked path is singular', tasks.build().running[0].detail, '1 path · rw:a.js');
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

  /* The widget only ever aggregates these, so the feed aggregates them once
     rather than shipping 605 records for the device's webview to re-bucket
     every refresh. */
  check('history is aggregated, not a list of records',
    Array.isArray(snap.history), false);
  check('every run is counted', snap.history.runs, 4);
  check('outcomes are tallied from what the records name, not a fixed pair',
    snap.history.outcome, { done: 2, partial: 1, unknown: 1 });
  check('models are tallied', snap.history.model, { unknown: 4 });
  check('efforts are tallied', snap.history.effort, { unknown: 4 });
  check('days are keyed by calendar date',
    Object.keys(snap.history.days).sort(), ['2026-01-01', '2026-02-01']);
  check('and count the runs that fall on each',
    snap.history.days['2026-01-01'], 2);
  check('the span names the first and last day seen',
    [snap.history.span.from, snap.history.span.to], ['2026-01-01', '2026-02-01']);
}

{
  /* `model` is free text in the real records - 16 distinct values, 12 of them
     one-off sentences - so it is reduced to the family it names rather than
     tallied raw, which would put a paragraph where a model name belongs. */
  const tasks = load(writeRegistry([]));
  check('a bare family name is itself', tasks.modelFamily('sonnet'), 'sonnet');
  check('a versioned id reduces to its family',
    tasks.modelFamily('claude-opus-4-1-20250805'), 'opus');
  check('a sentence reduces to the family it starts with',
    tasks.modelFamily('sonnet (subagent) + Opus 5 orchestrator re-verification'), 'sonnet');
  check('a sentence that only mentions a family later still finds it',
    tasks.modelFamily('ran inline on Fable 5'), 'fable');
  check('an absent model is unknown, not other', tasks.modelFamily(undefined), 'unknown');
  check('something naming no family at all is grouped, not guessed at',
    tasks.modelFamily('a bespoke local model'), 'other');
}

{
  /* The full outcome set is FIVE across the real corpus - done, partial,
     blocked, failed, inconclusive - not the two the icue repo alone shows.
     A tally written to a fixed pair would silently hide 41 records. */
  const { dir } = makeGitRepo('five-outcomes', s => ([
    { id: 'a', head: s[0], outcome: 'done' },
    { id: 'b', head: s[0], outcome: 'partial' },
    { id: 'c', head: s[0], outcome: 'blocked' },
    { id: 'd', head: s[1], outcome: 'failed' },
    { id: 'e', head: s[1], outcome: 'inconclusive' }
  ]));
  const tasks = load(writeRegistry([dir]));
  check('every outcome the records name is counted',
    tasks.build().history.outcome,
    { done: 1, partial: 1, blocked: 1, failed: 1, inconclusive: 1 });
}

{
  /* The raw records stay reachable for debugging, behind an argument, so the
     aggregation is not a one-way door. */
  const { dir } = makeGitRepo('raw', s => ([
    { id: 'a', head: s[0], outcome: 'done' }
  ]));
  const tasks = load(writeRegistry([dir]));
  const raw = tasks.build(null, { raw: true });
  check('raw:true adds the underlying records', Array.isArray(raw.historyRecords), true);
  check('and they are still there in full', raw.historyRecords.length, 1);
  check('while the default payload carries none',
    tasks.build().historyRecords, undefined);
}

console.log('the task files:');

const os2 = require('os');
const THIS_HOST = os2.hostname();
const DEAD_PID = 999999;      /* far above the Windows and Linux pid ranges in use */
const LIVE_PID = process.pid; /* this test process is unambiguously alive */

{
  const full = makeRepo('all-files', { tasks: [], closed: [] });
  const dir = path.join(full, '.claude', 'tasks');
  fs.writeFileSync(path.join(dir, 'runs.jsonl'), '{"id":"a"}\n');
  fs.writeFileSync(path.join(dir, 'serial.lock'), '[]');
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), '{"d":1}\n');
  fs.writeFileSync(path.join(dir, 'interview.json'), '{}');
  const tasks = load(writeRegistry([full]));
  const f = tasks.readRepo(tasks.discover()[0]).files;
  check('every task file is reported',
    Object.keys(f).sort(),
    ['decisions.jsonl', 'interview.json', 'runs.jsonl', 'serial.lock', 'whattask.json']);
  check('a present file says so and carries its size',
    [f['runs.jsonl'].present, f['runs.jsonl'].bytes > 0], [true, true]);
  check('and when it was last written', typeof f['runs.jsonl'].mtime, 'number');
}

{
  /* Absence is real state, not an error: h2g has no serial.lock and
     claude-setup has no runs.jsonl. */
  const sparse = makeRepo('sparse', { tasks: [], closed: [] });
  const tasks = load(writeRegistry([sparse]));
  const f = tasks.readRepo(tasks.discover()[0]).files;
  check('a file that is not there is absent, not zero-sized',
    [f['runs.jsonl'].present, f['runs.jsonl'].bytes], [false, null]);
  check('while the one that is there is present', f['whattask.json'].present, true);
}

console.log('the mutex:');

function writeMutex(repoDir, owner) {
  const d = path.join(repoDir, '.claude', 'tasks', 'serial.lock.d');
  fs.mkdirSync(d, { recursive: true });
  if (owner !== null) fs.writeFileSync(path.join(d, 'owner'), JSON.stringify(owner));
  return d;
}

{
  const free = makeRepo('mutex-free', { tasks: [], closed: [] });
  const tasks = load(writeRegistry([free]));
  const m = tasks.readRepo(tasks.discover()[0]).mutex;
  check('no serial.lock.d means the mutex is free', [m.held, m.stale], [false, false]);
}

{
  /* Held by something alive is NORMAL - it is taken for milliseconds around a
     registry update. Never stale at any age while the pid lives. */
  const live = makeRepo('mutex-live', { tasks: [], closed: [] });
  writeMutex(live, { pid: LIVE_PID, host: THIS_HOST, cmd: '/runqueue',
                     at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const tasks = load(writeRegistry([live]));
  const m = tasks.readRepo(tasks.discover()[0]).mutex;
  check('a mutex held by a live pid is held', m.held, true);
  check('and is NOT stale even an hour old - a live pid is never broken', m.stale, false);
  check('its owner is reported so the human can see who holds it', m.owner.pid, LIVE_PID);
}

{
  /* Both conditions, per LOCKING.md: the pid is dead on THIS host AND the
     recorded `at` is more than 15 minutes old. Neither alone is enough. */
  const stale = makeRepo('mutex-stale', { tasks: [], closed: [] });
  writeMutex(stale, { pid: DEAD_PID, host: THIS_HOST, cmd: '/runqueue',
                      at: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
  const tasks = load(writeRegistry([stale]));
  const m = tasks.readRepo(tasks.discover()[0]).mutex;
  check('a dead pid past the staleness window is stale', m.stale, true);
  check('and says why', /15 min|not running/.test(m.reason || ''), true);
}

{
  const young = makeRepo('mutex-young-dead', { tasks: [], closed: [] });
  writeMutex(young, { pid: DEAD_PID, host: THIS_HOST, cmd: '/runqueue',
                      at: new Date(Date.now() - 60 * 1000).toISOString() });
  const tasks = load(writeRegistry([young]));
  check('a dead pid INSIDE the window is not yet stale - the age test is required too',
    tasks.readRepo(tasks.discover()[0]).mutex.stale, false);
}

{
  const elsewhere = makeRepo('mutex-other-host', { tasks: [], closed: [] });
  writeMutex(elsewhere, { pid: DEAD_PID, host: 'SomeOtherMachine', cmd: '/runqueue',
                          at: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
  const tasks = load(writeRegistry([elsewhere]));
  check('a pid on another host cannot be checked from here, so it is never stale',
    tasks.readRepo(tasks.discover()[0]).mutex.stale, false);
}

{
  /* "A reader can see the directory for a moment with no owner file in it -
     that is HELD by someone still starting up, not stale." */
  const starting = makeRepo('mutex-no-owner', { tasks: [], closed: [] });
  writeMutex(starting, null);
  const tasks = load(writeRegistry([starting]));
  const m = tasks.readRepo(tasks.discover()[0]).mutex;
  check('a directory with no owner file is held, not stale', [m.held, m.stale], [true, false]);
  check('and that is reported as the startup window rather than as an unknown',
    /starting up|no owner/.test(m.reason || ''), true);
}

console.log('orphaned holder records:');

{
  /* The failure the mutex path NEVER notices: a session dies holding a
     registry record and no mutex, and the paths it names are refused forever.
     Age is not part of the test - a long task holds a record for hours. */
  const orph = makeRepo('orphaned', { tasks: [], closed: [] });
  fs.writeFileSync(path.join(orph, '.claude', 'tasks', 'serial.lock'), JSON.stringify([
    { task: 'dead-one', head: 'abc1234', touches: ['rw:a.js', 'rw:b.js'],
      pid: DEAD_PID, host: THIS_HOST },
    { task: 'live-one', head: 'def5678', touches: ['rw:c.js'],
      pid: LIVE_PID, host: THIS_HOST },
    { task: 'far-away', head: 'aaa1111', touches: ['rw:d.js'],
      pid: DEAD_PID, host: 'SomeOtherMachine' }
  ]));
  const tasks = load(writeRegistry([orph]));
  const running = tasks.build().running;
  const by = {};
  for (const r of running) by[r.label] = r;
  check('a record whose pid is dead on this host is an orphan', by['dead-one'].orphan, true);
  check('a record whose pid is alive is not', by['live-one'].orphan, false);
  /* null, never false: unknowable is not the same as fine, and the protocol
     says a record from another host is always treated as live. */
  check('a record from another host is unknowable, not declared healthy',
    by['far-away'].orphan, null);
  check('an orphan says how many paths it is refusing', by['dead-one'].pathCount, 2);

  const snap = tasks.build();
  check('orphans are collected as alarms rather than left in a column',
    snap.alarms.map(a => a.kind), ['orphan']);
  check('and the alarm names the repo, the task and the dead pid',
    [snap.alarms[0].repo, snap.alarms[0].task, snap.alarms[0].pid],
    ['orphaned', 'dead-one', DEAD_PID]);
  check('a clean machine raises no alarms', tasks.build().alarms.length, 1);
}

{
  const clean = makeRepo('no-alarms', { tasks: [], closed: [] });
  fs.writeFileSync(path.join(clean, '.claude', 'tasks', 'serial.lock'), '[]');
  const tasks = load(writeRegistry([clean]));
  check('nothing held and nothing dead means no alarms', tasks.build().alarms, []);
}

console.log('one project\'s task list:');

const LONG_TITLE = 'A title that runs on well past a hundred and forty characters so the cap can be seen doing its work rather than assumed, with padding on the end to carry it past the limit and then some more still';
const LONG_BLOCK = 'A blocking reason that also runs on well past a hundred and ten characters, because the real ones in this repo are paragraphs and the glass has one line for them';

{
  const proj = makeRepo('detailed', {
    tasks: [
      { id: 'a', title: 'A plain task', mode: 'subtask', model: 'sonnet',
        effort: 'medium', lane: 'parallel',
        /* The prose fields are what make the file 297KB and none of them fit
           on an 840x344 slot, so none of them may travel. */
        verify: 'x'.repeat(4000), why_model: 'y'.repeat(2000),
        why_effort: 'z'.repeat(2000), why_lane: 'w'.repeat(2000),
        evidence: 'e'.repeat(2000), touches: ['a', 'b'], depends_on: ['q'] },
      { id: 'b', title: LONG_TITLE, mode: 'requires-user',
        blocked_on: LONG_BLOCK },
      { id: 'c' }
    ],
    closed: [{ id: 'z' }]
  });
  const tasks = load(writeRegistry([proj]));

  const got = tasks.projectTasks('detailed');
  check('the named project answers', got.project, 'detailed');
  /* Three open plus the one closed: a done task has to be listed to be
     coloured differently from a queued one. */
  check('with a row per task, open and closed alike', got.tasks.length, 4);
  check('and no error', got.error, null);

  /* Looked up by id, not by position: the list is ordered by state now. */
  const byId = {};
  for (const t of got.tasks) byId[t.id] = t;
  const a = byId['a'];
  check('the fields the view draws are carried',
    Object.keys(a).sort(),
    ['blocked', 'effort', 'id', 'lane', 'mode', 'model', 'needsMain', 'reason',
     'state', 'title', 'waitingOn']);
  check('the prose fields are NOT - they are 297KB of the 300KB and unshowable',
    [a.verify, a.why_model, a.evidence, a.touches], [undefined, undefined, undefined, undefined]);
  check('a task with no blocked_on carries null, not a string', a.blocked, null);

  const b = byId['b'];
  /* The cap is the real maximum (140), not below it: 90 was the cap measuring
     itself, and truncated about a third of real titles. */
  check('an over-long title is capped at 140', b.title.length, 140);
  check('and an over-long blocking reason at 110', b.blocked.length, 110);

  const c = byId['c'];
  check('a task with nothing on it still renders as something',
    [c.title, c.mode, c.model, c.effort], ['c', 'unknown', 'unknown', 'unknown']);
}

{
  const tasks = load(writeRegistry([makeRepo('known', { tasks: [], closed: [] })]));
  const missing = tasks.projectTasks('not-a-project');
  check('an unknown project name is an error, not a crash', missing.tasks, []);
  check('and says which name it could not find',
    /not-a-project/.test(missing.error || ''), true);
}

{
  /* The whole point of the separate endpoint: asking for the overview must not
     start shipping every task with it. */
  const big = makeRepo('big', {
    tasks: Array.from({ length: 50 }, (_, i) => ({ id: 't' + i, title: 'T' + i, verify: 'v'.repeat(500) })),
    closed: []
  });
  const tasks = load(writeRegistry([big]));
  const base = tasks.build();
  check('the overview carries no task list', base.repos[0].tasks, undefined);
  check('and stays small even beside a fat queue',
    JSON.stringify(base).length < 4096, true);
}

console.log('what state each task is in:');

{
  const st = makeRepo('stated', {
    tasks: [
      { id: 'holding', title: 'The one with the lock', mode: 'subtask' },
      { id: 'waiting', title: 'The one on a human', mode: 'requires-user',
        blocked_on: 'a decision' },
      { id: 'plain', title: 'The one just sitting there', mode: 'subtask' },
      { id: 'later', title: 'The one waiting on plain', mode: 'subtask',
        depends_on: ['plain'] }
    ],
    closed: [
      { id: 'finished', title: 'The one that landed', closed_by: 'eaa9f97',
        reason: 'Shipped as a fifth view rather than an addition' },
      { id: 'finished-quietly', title: 'The one with no reason', closed_by: 'abc1234',
        reason: null }
    ]
  });
  /* A holder names its task by the same id the queue uses - verified against a
     real lock, where every holder's task matched an open task's id. */
  fs.writeFileSync(path.join(st, '.claude', 'tasks', 'serial.lock'), JSON.stringify([
    { task: 'holding', head: 'ff52cb4', touches: ['rw:a.js'], pid: LIVE_PID, host: THIS_HOST }
  ]));
  const tasks = load(writeRegistry([st]));
  const got = tasks.projectTasks('stated');
  const by = {};
  for (const t of got.tasks) by[t.id] = t;

  check('a task holding a lock is running', by['holding'].state, 'running');
  check('a task with a blocked_on is blocked', by['waiting'].state, 'blocked');
  check('an open task with neither is queued', by['plain'].state, 'queued');
  check('a task in the closed array is done', by['finished'].state, 'done');

  /* Colouring a done task means listing it: `closed` is a separate array that
     the overview only ever counted. */
  check('closed tasks join the list', got.tasks.length, 6);
  check('a done task keeps the reason it was closed for',
    by['finished'].reason, 'Shipped as a fifth view rather than an addition');
  check('and falls back to the commit that closed it when there is no reason',
    by['finished-quietly'].reason, 'closed by abc1234');

  /* Running, then what is ready to pick up, then what is stuck, then history.
     Blocked sits below queued because it is not actionable by the runner, so
     the actionable half of the list stays unbroken at the top. */
  /* All five states in one fixture, so the assertion covers every position -
     an order check that omits a state cannot catch that state being misplaced. */
  check('ordered by state: running, queued, blocked, waiting, done',
    got.tasks.map(t => t.state),
    ['running', 'queued', 'blocked', 'waiting', 'done', 'done']);
}

{
  /* A holder naming a task that is not in the queue must not invent a row. */
  const ghost = makeRepo('ghost-holder', {
    tasks: [{ id: 'real', title: 'Real', mode: 'subtask' }], closed: []
  });
  fs.writeFileSync(path.join(ghost, '.claude', 'tasks', 'serial.lock'), JSON.stringify([
    { task: 'not-in-the-queue', pid: LIVE_PID, host: THIS_HOST }
  ]));
  const tasks = load(writeRegistry([ghost]));
  const got = tasks.projectTasks('ghost-holder');
  check('a holder for a task the queue does not have adds no row', got.tasks.length, 1);
  check('and leaves the real one queued', got.tasks[0].state, 'queued');
}

console.log('a task waiting on another task:');

{
  /* Measured across the real queues: 25 of 210 carry a depends_on and 20 of
     those name a task that is STILL OPEN. Those twenty read as queued and are
     not pickable - the difference between a queue of 108 and one of 88. */
  const dep = makeRepo('depends', {
    tasks: [
      { id: 'first', title: 'The one nothing waits for', mode: 'subtask' },
      { id: 'second', title: 'The one waiting on first', mode: 'subtask',
        depends_on: ['first'] },
      { id: 'third', title: 'The one whose dependency is already closed',
        mode: 'subtask', depends_on: ['long-since-done'] },
      { id: 'fourth', title: 'Waiting AND blocked on a human', mode: 'requires-user',
        depends_on: ['first'], blocked_on: 'a decision' }
    ],
    closed: [{ id: 'long-since-done', title: 'Done ages ago', closed_by: 'aaa1111' }]
  });
  const tasks = load(writeRegistry([dep]));
  const by = {};
  for (const t of tasks.projectTasks('depends').tasks) by[t.id] = t;

  check('a task depending on an OPEN task is waiting', by['second'].state, 'waiting');
  check('and says which task it is waiting on', by['second'].waitingOn, ['first']);
  check('a task whose dependency is already closed is queued', by['third'].state, 'queued');
  check('and carries no waitingOn', by['third'].waitingOn, null);
  check('nothing waits on it, so the first one is queued', by['first'].state, 'queued');
  /* A human blocker outranks a dependency: the dependency clears itself when
     the other task lands, the human does not. */
  check('blocked outranks waiting when a task is both', by['fourth'].state, 'blocked');
}

{
  const nm = makeRepo('needs-main', {
    tasks: [
      { id: 'seizes', title: 'Seizes a singleton', mode: 'main', needs_main: true },
      { id: 'free', title: 'Delegable', mode: 'subtask', needs_main: false }
    ],
    closed: []
  });
  const tasks = load(writeRegistry([nm]));
  const by = {};
  for (const t of tasks.projectTasks('needs-main').tasks) by[t.id] = t;
  /* 52 of 210 seize a stateful singleton: it decides HOW a task can be run. */
  check('a needs_main task says so', by['seizes'].needsMain, true);
  check('and one that does not, does not', by['free'].needsMain, false);
}

console.log('how much history is shown:');

{
  const many = makeRepo('lots-closed', {
    tasks: [{ id: 'open-one', title: 'Still open', mode: 'subtask' }],
    closed: Array.from({ length: 42 }, (_, i) => ({
      id: 'closed-' + i, title: 'Closed number ' + i, closed_by: 'sha' + i, reason: null
    }))
  });
  const tasks = load(writeRegistry([many]));
  const got = tasks.projectTasks('lots-closed');
  const done = got.tasks.filter(t => t.state === 'done');
  /* The device slot shows FOUR rows - measured - so 42 done rows under 120
     open ones are unreachable there. The recent handful is what anyone reads. */
  check('only the most recent handful of done rows travel', done.length, 10);
  check('the total is still reported, so the view can say what it omits',
    [got.doneTotal, got.doneShown], [42, 10]);
  check('and they are the most recently closed, newest first',
    [done[0].id, done[9].id], ['closed-41', 'closed-32']);
}

console.log('which queued task is most startable:');

{
  /* The device slot shows FOUR rows, so the order of the queued block IS the
     interface. Two keys, both from the contention model: delegable before
     main-only (52 of 210 seize a stateful singleton), and parallel before
     serial (a serial task waits on the lane). Measured over the 147 genuinely
     queued tasks: 24 delegable+parallel, 83 delegable+serial, 40 main+serial. */
  const q = makeRepo('startable', {
    tasks: [
      { id: 'main-serial', title: 'Main only, serial', mode: 'main',
        needs_main: true, lane: 'serial' },
      { id: 'del-serial', title: 'Delegable, serial', mode: 'subtask',
        needs_main: false, lane: 'serial' },
      { id: 'main-par', title: 'Main only, parallel', mode: 'main',
        needs_main: true, lane: 'parallel' },
      { id: 'del-par', title: 'Delegable, parallel', mode: 'subtask',
        needs_main: false, lane: 'parallel' }
    ],
    closed: []
  });
  const tasks = load(writeRegistry([q]));
  check('most startable first: delegable+parallel, delegable+serial, main+parallel, main+serial',
    tasks.projectTasks('startable').tasks.map(t => t.id),
    ['del-par', 'del-serial', 'main-par', 'main-serial']);
}

{
  /* Cheapest first WITHIN a contention tier, on the same reading of "least
     friction to start". Unknown sorts last: 65 of the 147 queued tasks record
     no effort, and a cost that was never measured cannot claim a cheap slot on
     the strength of not having been measured. */
  const e = makeRepo('by-effort', {
    tasks: ['unknown', 'xhigh', 'high', 'medium', 'low'].map(function (eff, i) {
      const t = { id: 'e-' + eff, title: 'Effort ' + eff, mode: 'subtask',
                  needs_main: false, lane: 'parallel' };
      if (eff !== 'unknown') t.effort = eff;
      return t;
    }),
    closed: []
  });
  const tasks = load(writeRegistry([e]));
  check('cheapest first, with unrecorded effort last',
    tasks.projectTasks('by-effort').tasks.map(t => t.effort),
    ['low', 'medium', 'high', 'xhigh', 'unknown']);
}

{
  /* Contention outranks cost: a cheap task that needs the main session still
     sits below an expensive one that can be delegated. Ordering by effort
     first would put a low-effort singleton-seizing task at the top of a list
     whose whole point is what can be started now. */
  const both = makeRepo('cost-vs-contention', {
    tasks: [
      { id: 'cheap-but-main', title: 'Low effort, main only', mode: 'main',
        needs_main: true, lane: 'serial', effort: 'low' },
      { id: 'dear-but-free', title: 'Extra-high effort, delegable', mode: 'subtask',
        needs_main: false, lane: 'parallel', effort: 'xhigh' }
    ],
    closed: []
  });
  const tasks = load(writeRegistry([both]));
  check('contention outranks cost',
    tasks.projectTasks('cost-vs-contention').tasks.map(t => t.id),
    ['dear-but-free', 'cheap-but-main']);
}

{
  /* Stable within a tier: two tasks that are equally startable keep the order
     the file put them in, rather than being shuffled by the sort. */
  const tie = makeRepo('ties', {
    tasks: [
      { id: 'first', title: 'First in the file', mode: 'subtask',
        needs_main: false, lane: 'parallel' },
      { id: 'second', title: 'Second in the file', mode: 'subtask',
        needs_main: false, lane: 'parallel' },
      { id: 'third', title: 'Third in the file', mode: 'subtask',
        needs_main: false, lane: 'parallel' }
    ],
    closed: []
  });
  const tasks = load(writeRegistry([tie]));
  check('equally startable tasks keep their file order',
    tasks.projectTasks('ties').tasks.map(t => t.id), ['first', 'second', 'third']);
}

{
  /* The sort must not reach outside the queued block. A blocked task that is
     delegable and parallel is still blocked, and still below every queued one. */
  const mix = makeRepo('mixed-states', {
    tasks: [
      { id: 'blocked-but-easy', title: 'Blocked, delegable, parallel',
        mode: 'requires-user', needs_main: false, lane: 'parallel',
        blocked_on: 'a human' },
      { id: 'queued-but-awkward', title: 'Queued, main only, serial',
        mode: 'main', needs_main: true, lane: 'serial' }
    ],
    closed: []
  });
  const tasks = load(writeRegistry([mix]));
  check('startability never lifts a task out of its state',
    tasks.projectTasks('mixed-states').tasks.map(t => t.state), ['queued', 'blocked']);
}

{
  /* The state guard's real job. Cross-state order is already settled by the
     primary key, so the guard only matters WITHIN the other blocks: without
     it, two blocked tasks would be reordered by how startable they would have
     been, which is meaningless for work that cannot be started at all. */
  const blockedPair = makeRepo('blocked-pair', {
    tasks: [
      { id: 'awkward-first', title: 'Blocked, main only, serial', mode: 'requires-user',
        needs_main: true, lane: 'serial', blocked_on: 'a human' },
      { id: 'easy-second', title: 'Blocked, delegable, parallel', mode: 'requires-user',
        needs_main: false, lane: 'parallel', blocked_on: 'a human' }
    ],
    closed: []
  });
  const tasks = load(writeRegistry([blockedPair]));
  check('blocked tasks keep their file order, unsorted by startability',
    tasks.projectTasks('blocked-pair').tasks.map(t => t.id),
    ['awkward-first', 'easy-second']);
}

{
  /* Same guard, same reason, for the cost key: sorting blocked work by how
     cheap it would have been is meaningless for work that cannot start. */
  const effortPair = makeRepo('blocked-efforts', {
    tasks: [
      { id: 'dear-first', title: 'Blocked, extra-high effort', mode: 'requires-user',
        needs_main: false, lane: 'parallel', effort: 'xhigh', blocked_on: 'a human' },
      { id: 'cheap-second', title: 'Blocked, low effort', mode: 'requires-user',
        needs_main: false, lane: 'parallel', effort: 'low', blocked_on: 'a human' }
    ],
    closed: []
  });
  const tasks = load(writeRegistry([effortPair]));
  check('blocked tasks keep their file order, unsorted by cost too',
    tasks.projectTasks('blocked-efforts').tasks.map(t => t.id),
    ['dear-first', 'cheap-second']);
}

console.log('tasks a runner has already finished:')

{
  /* The plan lists what was open WHEN IT WAS WRITTEN. A runner appends to
     runs.jsonl and does not rewrite the plan, so between a /runtask and the
     next /whattask the count reads larger than the truth. Measured on the real
     repos when this was added: SIDM2 120 -> 58, h2g 83 -> 71, icue 18 -> 15. */
  const r = makeRepo('finished-since-plan', {
    tasks: [
      { id: 'already-done', title: 'Finished by a runner', mode: 'subtask' },
      { id: 'half-done', title: 'Recorded partial', mode: 'subtask' },
      { id: 'still-open', title: 'Never run', mode: 'subtask' },
      { id: 'done-then-reopened', title: 'Done, then run again badly', mode: 'subtask' }
    ],
    closed: []
  });
  const runs = [
    { id: 'already-done', outcome: 'done', head: 'aaa1111' },
    { id: 'half-done', outcome: 'partial', head: 'bbb2222' },
    { id: 'done-then-reopened', outcome: 'done', head: 'ccc3333' },
    { id: 'done-then-reopened', outcome: 'failed', head: 'ddd4444' }
  ];
  fs.writeFileSync(path.join(r, '.claude', 'tasks', 'runs.jsonl'),
    runs.map(x => JSON.stringify(x)).join('\n') + '\n');
  const tasks = load(writeRegistry([r]));
  const repo = tasks.readRepo(tasks.discover()[0]);

  /* Of the four, only `already-done` retires: partial is still open and the
     reopened one came back on its later failure line. */
  check('a task with a done record is not counted as open', repo.open, 3);
  check('and the gap between the plan and the truth is reported', repo.doneSincePlan, 1);
  /* partial is explicitly still open - the same rule the runners apply when
     deciding whether a dependency is satisfied. */
  check('a partial record does NOT retire a task', 
    tasks.doneIds(r).has('half-done'), false);
  /* Append-only: a later line supersedes an earlier one for the same id. */
  check('a done record superseded by a later failure reopens the task',
    tasks.doneIds(r).has('done-then-reopened'), false);

  const list = tasks.projectTasks('finished-since-plan').tasks;
  const by = {};
  for (const t of list) by[t.id] = t;
  check('the finished task is listed as done, not queued', by['already-done'].state, 'done');
  check('and says the plan has not caught up rather than leaving it unexplained',
    /plan has not been rewritten/.test(by['already-done'].reason || ''), true);
  check('the partial one is still queued', by['half-done'].state, 'queued');
  check('and so is the one that was reopened', by['done-then-reopened'].state, 'queued');
}

console.log('per-build read cache:');

{
  /* Plain fixtures, no git: this section is about disk reads, not commit
     resolution, and a runs.jsonl naming a head with no matching commit just
     leaves that record undated - already covered above. */
  const dir = makeRepo('read-count', { tasks: [{ id: 'a' }], closed: [] });
  fs.writeFileSync(path.join(dir, '.claude', 'tasks', 'runs.jsonl'),
    JSON.stringify({ id: 'z', head: 'deadbeef', outcome: 'done' }) + '\n');
  const tasks = load(writeRegistry([dir]));

  tasks.resetFileReadCount();
  tasks.build();
  check('one repo, one build: whattask.json and runs.jsonl are read once EACH',
    tasks.getFileReadCount(), 2);

  tasks.build();
  check('a SECOND build reads both files again, not from a leftover cache',
    tasks.getFileReadCount(), 4);

  /* The scoping requirement itself: a cache that outlived its build would
     show this second edit stale data, same as the bug doneIds() exists to
     fix one layer up. */
  fs.writeFileSync(path.join(dir, '.claude', 'tasks', 'whattask.json'),
    JSON.stringify({ tasks: [{ id: 'a' }, { id: 'b' }], closed: [] }));
  const after = tasks.build();
  check('a plan edited BETWEEN builds is reflected in the very next one - the cache did not hide it',
    after.repos[0].open, 2);
  check('and that third build still cost exactly one read per file, not zero',
    tasks.getFileReadCount(), 6);
}

{
  /* projectTasks() is its own build (a per-project one), so it gets the same
     treatment: readPlan() then doneIds() must not cost whattask.json or
     runs.jsonl a second read between them. */
  const dir = makeRepo('project-read-count', {
    tasks: [{ id: 'a', title: 'A' }], closed: []
  });
  fs.writeFileSync(path.join(dir, '.claude', 'tasks', 'runs.jsonl'), '');
  const tasks = load(writeRegistry([dir]));

  tasks.resetFileReadCount();
  tasks.projectTasks('project-read-count');
  check('projectTasks() reads whattask.json and runs.jsonl once EACH',
    tasks.getFileReadCount(), 2);
}

{
  /* This is the exact pattern server.js's collectQueuedTasks() now uses:
     readRepo() for the aggregate, then readPlan() for the raw task list it
     alone needs, sharing one cache so the second call is a hit, not a second
     read of the same whattask.json. */
  const dir = makeRepo('shared-cache', {
    tasks: [{ id: 'a', title: 'A' }], closed: []
  });
  const tasks = load(writeRegistry([dir]));
  const repo = tasks.discover()[0];

  tasks.resetFileReadCount();
  const cache = new Map();
  const read = tasks.readRepo(repo, cache);
  const plan = tasks.readPlan(repo.path, cache);
  check('readRepo() alone already cost one read of each file',
    tasks.getFileReadCount(), 2);
  check('readPlan() sharing that cache raw-lists the same tasks readRepo saw',
    plan.tasks.map(t => t.id), ['a']);
  check('and calling it did not cost a second whattask.json read',
    tasks.getFileReadCount(), 2);
  check('readRepo() itself is unaffected by the cache being shared', read.open, 1);

  /* Without a cache at all, the same two calls really do read twice - proving
     the count above is the cache doing something, not a coincidence. */
  tasks.resetFileReadCount();
  tasks.readRepo(repo);
  tasks.readPlan(repo.path);
  check('the SAME two calls with no cache passed cost two whattask.json reads',
    tasks.getFileReadCount(), 2 + 1);
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
