# Task Queue widget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third iCUE widget for the Xeneon Edge that shows how much whattask work is left, what is running, and what has been finished, across every repo on this machine that has a queue.

**Architecture:** A new `usage-server/tasks.js` module discovers queues from the `projects` map in `~/.claude.json`, reads each repo's `whattask.json`, `runs.jsonl` and `serial.lock`, and dates run records from git commit times. It is mounted at `GET /tasks` on the existing server on port 41777. A new `TaskQueue/` widget directory, structured and styled like `ClaudeUsage/`, renders three tap-cycled views against that feed.

**Tech Stack:** Node.js (no dependencies, CommonJS, `'use strict'`), plain HTML/CSS/JS widget, headless Chrome for layout tests, PowerShell for deploy.

**Spec:** `docs/superpowers/specs/2026-09-05-task-queue-widget-design.md`

## Global Constraints

- **No dependencies.** This repo has no `package.json`. Everything is Node built-ins (`fs`, `path`, `os`, `http`, `child_process`) plus what is already in `usage-server/`. Do not add a package manager, a test framework, or a bundler.
- **Tests are plain scripts.** Every test file is `#!/usr/bin/env node`, `'use strict'`, run as `node <path>`, counting into a `let failures = 0` and ending `process.exit(failures ? 1 : 0)`. Follow the `check(name, actual, expected)` helper shape in `usage-server/test/stats.test.js` and `ClaudeUsage/test/layout.test.js`. No `assert` module, no `describe`/`it`.
- **Tests must be hermetic.** No test may read the real `~/.claude`, the real `~/.claude.json`, or any real repo. Every path is injected via an environment variable pointing at a `fs.mkdtempSync` fixture root, following the `CLAUDE_USAGE_PROJECTS_DIR` / `CLAUDE_USAGE_STATS_FILE` / `CLAUDE_USAGE_CONFIG_PATH` pattern already in `usage-server/server.js:30-45`.
- **Port 41777 is the live feed serving the physical device. No test may bind it.** Ports 41798–41815 are taken by existing suites (see the comment at `usage-server/test/http.test.js:63-75`). New suites use **41816 and upward**, one port per spawned server.
- **Every field of a run or task record is optional.** Measured: `lane` is in 38 of 62 `icue` lines and 0 of `h2g`'s 107; `effort` is absent from `h2g` entirely; `tdz-c64-knowledge` adds `runner` and `decision`. A missing field becomes the string `unknown`, never a default value.
- **Never render unavailability as absence.** A repo that cannot be read is listed with its `error`; a view with no data prints the reason. An empty grid must never be mistakable for real emptiness.
- **Widget version string lives in two places and must match:** `manifest.json`'s `version` and `WIDGET_VERSION` at the top of `scripts/widget.js`. `tools/deploy.ps1` bumps both together.
- **`icueEvents` is assigned bare, never declared.** `var`/`let`/`const` would keep the binding local if iCUE evaluates the script in a sandboxed function context and the runtime bridge would never see the handlers. Copy the pattern from `ClaudeUsage/index.html`.
- **Commit messages** are a plain descriptive sentence in the style of this repo's log (`git log --oneline`), and end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `usage-server/tasks.js` | Discovery, per-repo reading, aggregation, git dating. The whole feed payload. Exports `build()`, `discover()`, `readRepo()`, `datedHistory()`. |
| `usage-server/test/tasks.test.js` | Everything in `tasks.js`, against fixture repos. |
| `TaskQueue/manifest.json` | iCUE registration. |
| `TaskQueue/index.html` | Markup, iCUE property metas, `icueEvents` bridge. |
| `TaskQueue/styles/TaskQueue.css` | All styling. |
| `TaskQueue/scripts/widget.js` | Fetch, render, view cycling, pager, clock. |
| `TaskQueue/resources/icon.svg` | Preview icon. |
| `TaskQueue/translation.json` | Strings, mirroring `ClaudeUsage/translation.json`. |
| `TaskQueue/test/layout.test.js` | Layout at 840×344 across all three views. |

**Modify:**

| File | Change |
|---|---|
| `usage-server/server.js` | Require `tasks.js`; add the `/tasks` route; repoint `collectQueuedTasks()` (line 1087) at `tasks.discover()`. |
| `tools/deploy.ps1` | One widget-table row (line ~82), one `ValidateSet` value (line 40). |
| `.github/workflows/tests.yml` | Two `run:` steps for the new suites. |
| `README.md` | A section for the widget. |

`tasks.js` is one file rather than three because discovery, reading and dating are a single responsibility — producing the feed payload — and they share the repo list. It is expected to land around 350 lines, comparable to `usagehtml.js` (286).

---

## Task 1: Discovery and queue aggregation

Read the project registry, find the repos with queues, and count their tasks.

**Files:**
- Create: `usage-server/tasks.js`
- Create: `usage-server/test/tasks.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `discover()` → `Array<{ name: string, path: string }>`, sorted by `name`. Reads the registry at `REGISTRY_PATH`.
  - `readRepo(repo)` → `{ name, path, open, closed, byMode, byLane, blocked, holders, lastRunAt, error }`. `byMode` and `byLane` are plain objects keyed by the value found, with an `unknown` key for absent fields. `holders` and `lastRunAt` are filled in Task 3; in this task they are `[]` and `null`.
  - `REGISTRY_PATH` — the module-level constant, overridable by `CLAUDE_TASKS_REGISTRY`.

- [ ] **Step 1: Write the failing test**

Create `usage-server/test/tasks.test.js`:

```javascript
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

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node usage-server/test/tasks.test.js`
Expected: FAIL — `Cannot find module '../tasks.js'`

- [ ] **Step 3: Write minimal implementation**

Create `usage-server/tasks.js`:

```javascript
/* The whattask feed: how much queued work exists across every repo on this
 * machine that has a queue, what is holding a lock right now, and what has
 * been finished.
 *
 * Discovery reads the `projects` map in ~/.claude.json, which carries real,
 * unmangled project paths. The per-project directory names under
 * ~/.claude/projects/ are NOT usable: the mangling replaces every path
 * separator with '-', which is lossy against directory names that themselves
 * contain '-'. "C--Users-mit-claude-c64server-tdz-c64-knowledge" cannot be
 * demangled back to a path unambiguously.
 *
 * The scan this replaces (collectQueuedTasks in server.js) walked one level of
 * ~/claude and so found 3 of the 5 repos that actually have queues - it missed
 * the two nested under c64server/, which between them hold 122 of 210 open
 * tasks.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY_PATH = process.env.CLAUDE_TASKS_REGISTRY ||
  path.join(os.homedir(), '.claude.json');

/* Registered paths differ only by slash style often enough to matter: the
   same project appears in ~/.claude.json as both C:\a\b and C:/a/b. */
function normalise(p) {
  return path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
}

function whattaskFile(repoPath) {
  return path.join(repoPath, '.claude', 'tasks', 'whattask.json');
}

function discover() {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
  const projects = (registry && registry.projects) || {};
  const seen = new Set();
  const found = [];
  for (const raw of Object.keys(projects)) {
    const key = normalise(raw);
    if (seen.has(key)) continue;
    try {
      if (!fs.statSync(whattaskFile(raw)).isFile()) continue;
    } catch (err) {
      continue;
    }
    seen.add(key);
    found.push({ name: path.basename(path.normalize(raw)), path: raw });
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found;
}

/* Every field of a task record is optional - measured across four repos, whose
   schemas genuinely differ - so an absent one is counted as "unknown" rather
   than defaulted to a value the record never claimed. */
function tally(items, field) {
  const out = {};
  for (const item of items) {
    const key = (item && item[field]) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function readRepo(repo) {
  const base = {
    name: repo.name,
    path: repo.path,
    open: 0,
    closed: 0,
    byMode: {},
    byLane: {},
    blocked: 0,
    holders: [],
    lastRunAt: null,
    error: null
  };
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(whattaskFile(repo.path), 'utf8'));
  } catch (err) {
    base.error = 'whattask.json could not be read: ' + err.message;
    return base;
  }
  const tasks = (plan && Array.isArray(plan.tasks)) ? plan.tasks : [];
  const closed = (plan && Array.isArray(plan.closed)) ? plan.closed : [];
  base.open = tasks.length;
  base.closed = closed.length;
  base.byMode = tally(tasks, 'mode');
  base.byLane = tally(tasks, 'lane');
  base.blocked = tasks.filter(t => t && t.blocked_on).length;
  return base;
}

module.exports = { REGISTRY_PATH, discover, readRepo, normalise, whattaskFile };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node usage-server/test/tasks.test.js`
Expected: PASS on every line, ending `all passed`

- [ ] **Step 5: Commit**

```bash
git add usage-server/tasks.js usage-server/test/tasks.test.js
git commit -F - <<'MSG'
Find every repo with a queue by asking the registry, not by guessing at paths

~/.claude.json carries real project paths; the mangled directory names under
~/.claude/projects/ cannot be demangled, because the separator and a literal
dash in a directory name are the same character once mangled.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 2: Run history, dated from git

Read each repo's `runs.jsonl` and give every record a time, taken from the commit its `head` names.

**Files:**
- Modify: `usage-server/tasks.js`
- Modify: `usage-server/test/tasks.test.js`

**Interfaces:**
- Consumes: `discover()`, `readRepo()` from Task 1.
- Produces:
  - `readRuns(repoPath)` → `{ runs: Array<record>, error: string|null }`. Records are the parsed JSONL lines; an unparseable line is skipped, not fatal.
  - `commitTimes(repoPath, shas)` → `{ times: { [sha]: number }, error: string|null }`. One `git cat-file --batch` process for the whole set.
  - `datedHistory(repoPath, runs)` → `{ history: Array<{ at, atSource, outcome, model, effort, mode, repo }>, error: string|null }`.

- [ ] **Step 1: Write the failing test**

Append to `usage-server/test/tasks.test.js`, before the final summary lines:

```javascript
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
  /* A torn or half-written final line must cost that line, not the file -
     runs.jsonl is appended to by concurrent runners. */
  const { dir, shas } = makeGitRepo('torn', s => ([
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
  const { dir, shas } = makeGitRepo('unknown-sha', s => ([
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node usage-server/test/tasks.test.js`
Expected: FAIL — `tasks.readRuns is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `usage-server/tasks.js`, above `module.exports`:

```javascript
const { execFileSync } = require('child_process');

function runsFile(repoPath) {
  return path.join(repoPath, '.claude', 'tasks', 'runs.jsonl');
}

/* runs.jsonl is appended to by concurrent runners, so its last line can be a
   torn partial write. That costs the line, never the file. */
function readRuns(repoPath) {
  let text;
  try {
    text = fs.readFileSync(runsFile(repoPath), 'utf8');
  } catch (err) {
    return { runs: [], error: null };   /* no runs yet is not a failure */
  }
  const runs = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      runs.push(JSON.parse(trimmed));
    } catch (err) {
      /* skip */
    }
  }
  return { runs: runs, error: null };
}

/* NO RUN RECORD CARRIES A TIMESTAMP. Measured across four repos and 603
   lines: the key union is id, head, model, effort, mode, lane, outcome,
   evidence, verify_output, notes, opened, decision, runner - and no date.
   `head` is a commit SHA, so the commit's own date is the closest honest
   time available, and it travels labelled as such (atSource: "commit") so a
   view never presents it as when the run happened.
   
   One `git cat-file --batch` process for the whole set, not one per record:
   62 lines here carry only 23 distinct heads, and spawning git per line
   would cost seconds on every rebuild. */
function commitTimes(repoPath, shas) {
  const unique = Array.from(new Set(shas.filter(s => typeof s === 'string' && s)));
  if (!unique.length) return { times: {}, error: null };
  let out;
  try {
    out = execFileSync('git', ['cat-file', '--batch=%(objectname) %(objecttype)'], {
      cwd: repoPath,
      input: unique.join('\n') + '\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    return { times: {}, error: 'git could not be read in ' + repoPath + ': ' + err.message };
  }
  /* --batch prints a header line then the object body; for a commit the body
     carries "committer <name> <email> <epoch> <tz>". Parse the epoch out of
     it rather than shelling out again per SHA. */
  const times = {};
  let current = null;
  for (const line of out.split('\n')) {
    const header = /^([0-9a-f]{40})\s+(\S+)/.exec(line);
    if (header) {
      current = header[2] === 'commit' ? header[1] : null;
      continue;
    }
    if (current) {
      const committer = /^committer .*? (\d+) [+-]\d{4}\s*$/.exec(line);
      if (committer) {
        times[current] = Number(committer[1]) * 1000;
        current = null;
      }
    }
  }
  /* The caller passed abbreviated or full SHAs; --batch echoes the full one.
     Map each requested SHA onto whichever resolved name it prefixes. */
  const resolved = {};
  for (const sha of unique) {
    if (times[sha] != null) { resolved[sha] = times[sha]; continue; }
    const full = Object.keys(times).find(f => f.startsWith(sha));
    if (full) resolved[sha] = times[full];
  }
  return { times: resolved, error: null };
}

function field(record, name) {
  const v = record && record[name];
  return (typeof v === 'string' && v) ? v : 'unknown';
}

function datedHistory(repoPath, runs) {
  const { times, error } = commitTimes(repoPath, runs.map(r => r && r.head));
  if (error) return { history: [], error: error };
  const name = path.basename(path.normalize(repoPath));
  const history = [];
  let undated = 0;
  for (const run of runs) {
    const at = run && times[run.head];
    if (at == null) { undated++; continue; }
    history.push({
      at: at,
      atSource: 'commit',
      outcome: field(run, 'outcome'),
      model: field(run, 'model'),
      effort: field(run, 'effort'),
      mode: field(run, 'mode'),
      repo: name
    });
  }
  history.sort((a, b) => a.at - b.at);
  return {
    history: history,
    error: undated
      ? undated + ' run record(s) name a commit this repo no longer has, and are not shown'
      : null
  };
}
```

Extend the exports line:

```javascript
module.exports = {
  REGISTRY_PATH, discover, readRepo, normalise, whattaskFile,
  readRuns, commitTimes, datedHistory
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node usage-server/test/tasks.test.js`
Expected: PASS, ending `all passed`

- [ ] **Step 5: Commit**

```bash
git add usage-server/tasks.js usage-server/test/tasks.test.js
git commit -F - <<'MSG'
Date a run by the commit it names, and say that is what the date is

No run record in any repo carries a timestamp - 603 lines across four repos,
and the key union has no date field. The head SHA does resolve, so every entry
is dated from its commit and carries atSource:"commit", because commit time and
run time are close but not the same thing and the view must not claim they are.

One batched git cat-file per repo rather than one process per record: 62 lines
here name only 23 distinct commits.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 3: Lock holders and the assembled payload

Read `serial.lock`, and assemble everything into the object the route will serve.

**Files:**
- Modify: `usage-server/tasks.js`
- Modify: `usage-server/test/tasks.test.js`

**Interfaces:**
- Consumes: `discover()`, `readRepo()`, `readRuns()`, `datedHistory()`.
- Produces: `build(live)` → the full feed payload. `live` is an optional `{ sessions, workflows, subtasks }` object supplied by `server.js` in Task 4; when omitted, those parts of `running` are simply absent.

Payload shape:

```javascript
{
  generatedAt: <epoch ms>,
  repos: [ { name, path, open, closed, byMode, byLane, blocked,
             holders, lastRunAt, error, historyError } ],
  totals: { open, closed, repos, blocked, byMode, byOutcome },
  running: [ { kind, label, repo, since, detail } ],
  history: [ { at, atSource, outcome, model, effort, mode, repo } ],
  unavailable: null
}
```

`running[].kind` is one of `holder`, `session`, `workflow`, `subtask`. `since` is epoch ms or `null`.

- [ ] **Step 1: Write the failing test**

Append to `usage-server/test/tasks.test.js`, before the summary:

```javascript
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
  check('an empty lock reads as no holders, with no error',
    [tasks.readRepo(tasks.discover()[0]).holders.length,
     tasks.readRepo(tasks.discover()[0]).error], [0, null]);
}

{
  const noLock = makeRepo('no-lock', { tasks: [], closed: [] });
  const tasks = load(writeRegistry([noLock]));
  check('an absent serial.lock is not an error either',
    [tasks.readRepo(tasks.discover()[0]).holders.length,
     tasks.readRepo(tasks.discover()[0]).error], [0, null]);
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
  check('holders sort ahead of live activity',
    snap.running[0].kind, 'holder');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node usage-server/test/tasks.test.js`
Expected: FAIL — the holder checks fail (`r.holders.length` is `0`), then `tasks.build is not a function`

- [ ] **Step 3: Write minimal implementation**

In `usage-server/tasks.js`, add the lock reader and have `readRepo` call it. Insert above `readRepo`:

```javascript
function lockFile(repoPath) {
  return path.join(repoPath, '.claude', 'tasks', 'serial.lock');
}

/* serial.lock is the REGISTRY of holder records, not a lock - the lock itself
   is the directory serial.lock.d/, taken for milliseconds around each update.
   See the mit-setup LOCKING.md. Its resting state is [], which is what all
   five real repos hold right now, so an empty or absent file is normal. */
function readHolders(repoPath) {
  let text;
  try {
    text = fs.readFileSync(lockFile(repoPath), 'utf8');
  } catch (err) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}
```

In `readRepo`, replace `holders: []` in the `base` object with `holders: readHolders(repo.path)`, and after the `blocked` line add:

```javascript
  try {
    base.lastRunAt = fs.statSync(runsFile(repo.path)).mtimeMs;
  } catch (err) {
    base.lastRunAt = null;
  }
```

Then add `build()` above `module.exports`:

```javascript
function mergeCounts(into, from) {
  for (const key of Object.keys(from)) into[key] = (into[key] || 0) + from[key];
  return into;
}

function toMs(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/* `live` is the sessions/workflows/subtasks block server.js already computes
   for /usage. It is passed in rather than recomputed: serial.lock is empty
   whenever no /runqueue is mid-flight, which is nearly always, and a live view
   backed by holders alone would be blank almost every time it is looked at. */
function build(live) {
  const repos = discover().map(readRepo);
  const totals = { open: 0, closed: 0, repos: repos.length, blocked: 0, byMode: {}, byOutcome: {} };
  const running = [];
  let history = [];

  for (const repo of repos) {
    totals.open += repo.open;
    totals.closed += repo.closed;
    totals.blocked += repo.blocked;
    mergeCounts(totals.byMode, repo.byMode);

    for (const holder of repo.holders) {
      running.push({
        kind: 'holder',
        label: holder.task || holder.cmd || holder.run || 'a held task',
        repo: repo.name,
        since: toMs(holder.at),
        detail: Array.isArray(holder.paths) ? holder.paths.join(', ') : ''
      });
    }

    const read = readRuns(repo.path);
    for (const run of read.runs) {
      const outcome = field(run, 'outcome');
      totals.byOutcome[outcome] = (totals.byOutcome[outcome] || 0) + 1;
    }
    const dated = datedHistory(repo.path, read.runs);
    repo.historyError = dated.error;
    history = history.concat(dated.history);
  }

  if (live) {
    for (const s of live.sessions || []) {
      running.push({ kind: 'session', label: s.label || s.id || 'a session',
                     repo: s.project || '', since: toMs(s.lastAt), detail: '' });
    }
    for (const w of live.workflows || []) {
      running.push({ kind: 'workflow', label: w.label || w.id || 'a workflow',
                     repo: w.project || '', since: toMs(w.startedAt), detail: '' });
    }
    for (const t of live.subtasks || []) {
      running.push({ kind: 'subtask', label: t.label || t.id || 'a subtask',
                     repo: t.project || '', since: toMs(t.startedAt), detail: '' });
    }
  }

  history.sort((a, b) => a.at - b.at);

  return {
    generatedAt: Date.now(),
    repos: repos,
    totals: totals,
    running: running,
    history: history,
    unavailable: repos.length ? null
      : 'no repo on this machine has a .claude/tasks/whattask.json - run /whattask in one to create a queue'
  };
}
```

Extend the exports:

```javascript
module.exports = {
  REGISTRY_PATH, discover, readRepo, normalise, whattaskFile,
  readRuns, commitTimes, datedHistory, readHolders, build
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node usage-server/test/tasks.test.js`
Expected: PASS, ending `all passed`

- [ ] **Step 5: Commit**

```bash
git add usage-server/tasks.js usage-server/test/tasks.test.js
git commit -F - <<'MSG'
Assemble the feed, and keep a lock holder distinguishable from a live session

serial.lock is [] in every repo right now - that is its resting state, since it
holds records only while a /runqueue is mid-flight - so the running list also
carries the sessions and workflows the usage feed already computes. Each entry
says which kind it is, because a held lock and an open session are different
claims about the machine and must never be summed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 4: Serve it, and fix the scan that under-reports

Mount `/tasks`, and repoint `collectQueuedTasks()` at the shared discovery.

**Files:**
- Modify: `usage-server/server.js` — require at line ~21; route before the `/usage` handler at line 1345; `collectQueuedTasks()` at lines 1087-1129
- Create: `usage-server/test/tasks-http.test.js`

**Interfaces:**
- Consumes: `tasks.build(live)` from Task 3.
- Produces: `GET /tasks` returning the Task 3 payload as JSON; `GET /tasks` is the URL the widget defaults to.

- [ ] **Step 1: Write the failing test**

Create `usage-server/test/tasks-http.test.js`:

```javascript
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

const repo = path.join(WORK, 'fixture-repo');
fs.mkdirSync(path.join(repo, '.claude', 'tasks'), { recursive: true });
fs.writeFileSync(path.join(repo, '.claude', 'tasks', 'whattask.json'),
  JSON.stringify({ tasks: [{ id: 'a', mode: 'subtask' }], closed: [{ id: 'z' }] }));

const registry = path.join(WORK, 'registry.json');
fs.writeFileSync(registry, JSON.stringify({ projects: { [repo]: {} } }));

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

    const res = await get('/tasks');
    check('/tasks answers 200', res.status, 200);
    check('and answers as JSON', /application\/json/.test(res.type), true);

    const body = JSON.parse(res.body);
    check('the fixture repo is served', body.repos.map(r => r.name), ['fixture-repo']);
    check('its open count is served', body.totals.open, 1);
    check('its closed count is served', body.totals.closed, 1);
    check('running is an array even when nothing is running',
      Array.isArray(body.running), true);

    /* The route must not shadow /usage, and /usage must be untouched by it -
       the widget contract for /usage is deliberately frozen. */
    const usage = await get('/usage');
    check('/usage still answers 200 alongside /tasks', usage.status, 200);
    check('and its body is still an object, not null',
      typeof JSON.parse(usage.body), 'object');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node usage-server/test/tasks-http.test.js`
Expected: FAIL — `/tasks` answers 200 fails, because the unmatched URL falls through to the `/usage` catch-all or a 404

- [ ] **Step 3: Write minimal implementation**

In `usage-server/server.js`, after the `statusline` require (line 21):

```javascript
const tasks = require('./tasks');
```

Add the route immediately before the `if (req.url === '/health')` block, so it can never be shadowed by the `/usage` catch-all below it:

```javascript
    /* The whattask feed. Its own endpoint rather than a block inside /usage:
       the /usage contract is what the Claude Code Usage widget reads and is
       deliberately left exactly as that widget expects it. */
    if (req.url === '/tasks' || req.url.startsWith('/tasks?')) {
      /* The live block is handed over rather than recomputed, so the task
         widget's running view shows the same activity /usage does. */
      const live = snapshot
        ? { sessions: snapshot.sessions, workflows: snapshot.workflows,
            subtasks: snapshot.subtasks }
        : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tasks.build(live)));
      return;
    }
```

Then replace the body of `collectQueuedTasks()` (lines 1087-1129) with a version built on the shared discovery:

```javascript
/* Was a one-level readdirSync of ~/claude, which found 3 of the 5 repos that
   actually have queues - it missed the two nested under c64server/, and with
   them 122 of 210 open tasks. tasks.discover() reads the real project registry
   instead, so this list and the /tasks feed can never disagree about which
   repos exist. */
function collectQueuedTasks() {
  const found = [];
  for (const repo of tasks.discover()) {
    const read = tasks.readRepo(repo);
    if (read.error) continue;
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(tasks.whattaskFile(repo.path), 'utf8'));
    } catch (err) {
      continue;
    }
    for (const task of (plan.tasks || [])) {
      found.push({
        label: task.title || task.id,
        model: (task.model || '').replace(/^claude-/, ''),
        state: task.blocked_on ? 'blocked' : 'queued',
        phase: task.lane || '',
        tokens: 0,
        toolCalls: 0,
        workflow: 'whattask',
        project: repo.name,
        startedAt: read.lastRunAt || Date.now(),
        source: 'whattask'
      });
    }
  }
  return found;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run each; all must pass:

```bash
node usage-server/test/tasks.test.js
node usage-server/test/tasks-http.test.js
node usage-server/test/http.test.js
node usage-server/test/stats.test.js
node usage-server/test/live-detection.test.js
node usage-server/test/statusline.test.js
```

Expected: PASS. The existing four are run because `collectQueuedTasks()` feeds `/usage`, and this task changed it.

- [ ] **Step 5: Commit**

```bash
git add usage-server/server.js usage-server/test/tasks-http.test.js
git commit -F - <<'MSG'
Serve the queue at /tasks, and stop missing 58% of it

The scan collectQueuedTasks() used walked one level of ~/claude, so it found
3 of the 5 repos with queues and 88 of 210 open tasks - the two under
c64server/ sit a level deeper than it looked. Both it and the new endpoint now
read the same registry, so they cannot disagree about which repos exist.

/usage is untouched; the task feed is its own route because the usage widget's
contract with /usage is deliberately frozen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 5: The widget shell and the Queue view

A working widget on the glass showing how much work is left.

**Files:**
- Create: `TaskQueue/manifest.json`, `TaskQueue/index.html`, `TaskQueue/styles/TaskQueue.css`, `TaskQueue/scripts/widget.js`, `TaskQueue/resources/icon.svg`, `TaskQueue/translation.json`
- Create: `TaskQueue/test/layout.test.js`
- Reference: `ClaudeUsage/index.html`, `ClaudeUsage/scripts/widget.js`, `ClaudeUsage/styles/ClaudeUsage.css`, `ClaudeUsage/test/layout.test.js`

**Interfaces:**
- Consumes: `GET /tasks` from Task 4.
- Produces:
  - `window.TaskQueue.onDataUpdated()` and `.onICUEInitialized()` — the iCUE bridge.
  - `VIEWS = ['queue', 'live', 'history']` and `var view = 'queue'` — read out of the source by the layout test, so the names must be exactly these.
  - `WIDGET_VERSION = '1.0.0'`, matching `manifest.json`.

- [ ] **Step 1: Write the failing test**

Create `TaskQueue/test/layout.test.js` by copying `ClaudeUsage/test/layout.test.js` and adapting it. Keep verbatim: `findChrome()`, the viewport-correction routine that drives the slot to exactly 840×344, `OVERFLOW_EPS_PX = 1`, `ELLIPSIS_EPS_PX = 1`, the `* { transition: none !important }` injection, the disposable `--user-data-dir`, and `extractArray`/`extractString`.

Replace the fixture builders with ones producing the `/tasks` payload, and start with these checks:

```javascript
const VIEWS = extractArray(widgetSrc, 'VIEWS');
const START_VIEW = extractString(widgetSrc, 'view');
check('VIEWS was read out of widget.js', VIEWS, ['queue', 'live', 'history']);
check('the widget starts on the "queue" view', START_VIEW, 'queue');
if (failures) {
  console.log('\nthe source constants could not be read; every tap count below would be aimed at the wrong view');
  console.log(`${failures} FAILED`);
  process.exit(1);
}
```

The fixture, matching the real feed's measured proportions so the layout is
exercised against realistic magnitudes rather than toy ones:

```javascript
/* Modelled on what the real feed serves: five repos, one of them holding
   more open tasks than the other four together, and repo names as long as
   the longest real one. */
function baseFixture() {
  const repos = [
    { name: 'SIDM2', open: 120, closed: 42, blocked: 3,
      byMode: { subtask: 90, main: 27, 'requires-user': 3 },
      byLane: { serial: 60, parallel: 60 }, holders: [], lastRunAt: 1757000000000,
      error: null, historyError: null },
    { name: 'h2g', open: 83, closed: 105, blocked: 0,
      byMode: { subtask: 83 }, byLane: { unknown: 83 }, holders: [],
      lastRunAt: 1757000000000, error: null, historyError: null },
    { name: 'claude-setup', open: 3, closed: 0, blocked: 0,
      byMode: { unknown: 3 }, byLane: { unknown: 3 }, holders: [],
      lastRunAt: null, error: null, historyError: null },
    { name: 'icue', open: 2, closed: 63, blocked: 2,
      byMode: { 'requires-user': 2 }, byLane: { serial: 2 }, holders: [],
      lastRunAt: 1757000000000, error: null, historyError: null },
    { name: 'tdz-c64-knowledge', open: 2, closed: 97, blocked: 0,
      byMode: { subtask: 2 }, byLane: { unknown: 2 }, holders: [],
      lastRunAt: 1757000000000, error: null, historyError: null }
  ];
  return {
    generatedAt: Date.now(),
    repos: repos,
    totals: {
      open: 210, closed: 307, repos: 5, blocked: 5,
      byMode: { subtask: 175, main: 27, 'requires-user': 5, unknown: 3 },
      byOutcome: { done: 555, partial: 48 }
    },
    running: [],
    history: [],
    unavailable: null
  };
}

/* No repo has a queue at all: the view must SAY so, not draw an empty meter. */
function unavailableFixture() {
  return {
    generatedAt: Date.now(), repos: [], running: [], history: [],
    totals: { open: 0, closed: 0, repos: 0, blocked: 0, byMode: {}, byOutcome: {} },
    unavailable: 'no repo on this machine has a .claude/tasks/whattask.json'
  };
}
```

**The harness measures; the test asserts over what it measured.** The suite's
shape is `writePage(name, taps, fixture)` → a file path → `render(path)` → the
object the injected `HARNESS` encoded into `data-layout`. There is no
`render(fixture, taps)`. Extend `measure()` inside `HARNESS` with the fields
this widget needs, alongside the existing `overflow`/`figs` collection which is
carried over unchanged:

```javascript
    /* --- Task Queue additions to measure() --- */
    out.repoRowCount = document.querySelectorAll('#repo-rows li').length;
    out.repoRowNames = Array.prototype.map.call(
      document.querySelectorAll('#repo-rows li .row-name'), function (e) { return e.textContent; });
    out.repoRowErrors = document.querySelectorAll('#repo-rows li .row-error').length;
    var doneFill = document.getElementById('done-fill');
    out.doneFillWidth = doneFill ? doneFill.getBoundingClientRect().width : null;
    var doneTrack = doneFill ? doneFill.parentElement.getBoundingClientRect().width : null;
    out.doneFillPercent = (doneFill && doneTrack)
      ? Math.round((doneFill.getBoundingClientRect().width / doneTrack) * 100) : null;
    out.doneValueText = (document.getElementById('done-value') || {}).textContent || null;
    var queueNote = document.getElementById('queue-note');
    out.queueNoteText = queueNote ? queueNote.textContent : null;
    out.queueNoteDisplay = queueNote ? window.getComputedStyle(queueNote).display : null;
    var meters = document.querySelector('.view-queue .meters');
    out.metersDisplay = meters ? window.getComputedStyle(meters).display : null;
```

Then the assertions, over rendered pages collected the way the existing suite
collects them:

```javascript
const CASES = [
  { name: 'queue', taps: 0, fixture: baseFixture() },
  { name: 'queue-unavailable', taps: 0, fixture: unavailableFixture() }
];

const ok = [];
for (const c of CASES) {
  const r = render(writePage(c.name, c.taps, c.fixture));
  if (r.error) { fail(`${c.name}: ${r.error}`); continue; }
  r.name = c.name;
  ok.push(r);
}
const byName = {};
for (const r of ok) byName[r.name] = r;

console.log('the queue view:');
/* overflowsIn() and the loop that reports each offender are carried over from
   ClaudeUsage/test/layout.test.js unchanged - it names the element, the side
   and the overshoot, which is what makes a failure actionable. */
{
  let bad = 0;
  for (const r of ok) {
    for (const o of overflowsIn(r)) {
      bad++;
      const side = ['left', 'top', 'right', 'bottom']
        .filter(s => o.sides[s] > OVERFLOW_EPS_PX).join('/');
      fail(`${r.name}: ${o.path} is ${o.by.toFixed(1)}px past the ${side} of .widget-root`);
    }
  }
  if (!bad) console.log(`  pass  every box in all ${ok.length} renders is inside .widget-root`);
}

check('every repo reaches the screen', byName['queue'].repoRowCount, 5);
check('the busiest repo is listed first',
  byName['queue'].repoRowNames[0], 'SIDM2');
check('the completion figure is drawn from open and closed',
  byName['queue'].doneValueText, '59%');   /* 307 / (210+307) */
check('and the bar is filled to match, within a pixel of rounding',
  Math.abs(byName['queue'].doneFillPercent - 59) <= 1, true);

check('an unavailable feed prints the reason instead of an empty meter',
  byName['queue-unavailable'].queueNoteText,
  'no repo on this machine has a .claude/tasks/whattask.json');
check('and draws no meter at all in that state',
  byName['queue-unavailable'].metersDisplay, 'none');
check('while a feed that does have repos shows no note',
  byName['queue'].queueNoteDisplay, 'none');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node TaskQueue/test/layout.test.js`
Expected: FAIL — `ENOENT` reading `TaskQueue/scripts/widget.js`

- [ ] **Step 3: Write minimal implementation**

`TaskQueue/manifest.json`:

```json
{
  "author": "Thordanielz",
  "id": "com.thordanielz.taskqueue",
  "name": "Task Queue",
  "description": "How much whattask work is left across every repo on this machine, what is holding a lock right now, and what has been finished. Reads a local feed on 127.0.0.1; nothing leaves the machine.",
  "version": "1.0.0",
  "interactive": true,
  "preview_icon": "resources/icon.svg",
  "min_app_version": "5.47",
  "min_framework_version": "1.0.0",
  "os": [
    {
      "platform": "windows"
    }
  ],
  "supported_devices": [
    {
      "type": "dashboard_lcd"
    }
  ]
}
```

`TaskQueue/index.html` — mirror `ClaudeUsage/index.html`'s head exactly, changing only the title, stylesheet href, feed default and group title, and give the body three view divs:

```html
  <meta name="x-icue-property" content="feedUrl" data-label="tr('Feed URL')" data-type="textfield" data-default="'http://127.0.0.1:41777/tasks'" />
  <meta name="x-icue-property" content="colorTheme" data-label="tr('Theme')" data-type="combobox" data-default="'dark'" data-values="[{'key':'dark','value':tr('Dark')},{'key':'light','value':tr('Light')}]" />
  <meta name="x-icue-property" content="timeFormat" data-label="tr('Clock')" data-type="combobox" data-default="'auto'" data-values="[{'key':'auto','value':tr('Auto')},{'key':'12','value':tr('12-hour')},{'key':'24','value':tr('24-hour')}]" />
  <meta name="x-icue-property" content="refreshSeconds" data-label="tr('Refresh Interval')" data-type="slider" data-default="15" data-min="5" data-max="120" data-step="5" data-unit-label="tr('sec')" />
```

Body structure, with the queue view filled in and the other two left as empty
shells for Tasks 6 and 7:

```html
  <div class="widget-root">
    <div class="content">
      <header class="head">
        <span class="title" id="title">Task queue</span>
        <span class="repos" id="repos"></span>
        <span class="updated" id="updated"></span>
        <span class="dots" aria-hidden="true"><i class="dot" data-view="queue"></i><i class="dot" data-view="live"></i><i class="dot" data-view="history"></i></span>
        <span class="version" id="version"></span>
      </header>

      <div class="view view-queue">
        <section class="meters">
          <div class="meter" id="m-done">
            <div class="meter-top">
              <span class="name">Finished</span>
              <span class="value" id="done-value">--</span>
            </div>
            <div class="track"><div class="fill" id="done-fill"></div></div>
            <div class="sub" id="done-sub"></div>
          </div>
        </section>
        <section class="lists">
          <div class="list" id="list-repos">
            <h2>Repos</h2>
            <ul id="repo-rows"></ul>
          </div>
        </section>
        <div class="queue-note" id="queue-note"></div>
      </div>

      <div class="view view-live">
        <section class="lists lists-live">
          <div class="list"><h2>Holding a lock</h2><ul id="holders"></ul></div>
          <div class="list"><h2>Claude activity</h2><ul id="activity"></ul></div>
        </section>
      </div>

      <div class="view view-history">
        <section class="history">
          <div class="heat-wrap">
            <h2 id="heat-head">Runs</h2>
            <div class="heat" id="heat"></div>
          </div>
          <div class="figs" id="figs"></div>
        </section>
        <div class="history-note" id="history-note"></div>
      </div>
    </div>

    <div class="loading-state"><div class="msg">Connecting to the task feed…</div></div>
    <div class="error-state">
      <div class="msg">Task feed unreachable</div>
      <div class="hint" id="error-hint"></div>
    </div>
    <div class="clock" id="clock"></div>
  </div>

  <script type="text/javascript" src="scripts/widget.js"></script>
  <script>
    // Bare assignment is intentional: var/let/const would keep the binding local
    // if iCUE evaluates this script in a sandboxed function context, and the
    // runtime bridge would never see the handlers.
    icueEvents = {
      onDataUpdated: function () { if (window.TaskQueue) window.TaskQueue.onDataUpdated(); },
      onICUEInitialized: function () { if (window.TaskQueue) window.TaskQueue.onICUEInitialized(); }
    };
  </script>
```

`TaskQueue/scripts/widget.js` — port these functions from `ClaudeUsage/scripts/widget.js` unchanged, since they are widget-shell concerns, not usage concerns: `getIcueProperty`, `clampRange`, `readFeedUrl`, `readTheme`, `readRefreshSeconds`, `readTimeFormat`, `systemPrefers12Hour`, `timeString`, `formatStamp`, `num`, `compact`, `setBar`, `applyView`, `toggleView`, `showState`, `applyTheme`, `schedule`, `renderTimeOfDay`, `startTimeOfDay`, `startClock`, `onIcueDataUpdated`, `onIcueInitialized`, `bootCheck`, and the whole pager block (`pageOffsets`, `markFade`, `headingBody`, `setPageDots`, `refreshPaging`, `advancePages`, `startPaging`).

`cacheElements` is **rewritten, not ported** — it maps `els.*` onto this
widget's element IDs, which are not the usage widget's. Every `els.` name used
anywhere in this file must be assigned there, or it is `undefined` at render
time and the failure is a silent blank rather than an error. The ones this plan
uses: `queueNote`, `meters`, `listRepos`, `doneValue`, `doneFill`, `mDone`,
`doneSub`, `repos`, `repoRows`, `holders`, `activity`, `heatHead`, `heat`,
`figs`, `historyNote`, `history`, plus the shell's `title`, `updated`,
`version`, `clock`, `errorHint`.

`window.ClaudeUsage` becomes `window.TaskQueue` at the bottom of the file, matching the `icueEvents` bridge in `index.html`.

Change the constants at the top:

```javascript
  var WIDGET_VERSION = '1.0.0';
  var DEFAULT_FEED = 'http://127.0.0.1:41777/tasks';
  var VIEWS = ['queue', 'live', 'history'];
  var view = 'queue';   /* tapping the widget cycles through VIEWS */
  var TITLES = { queue: 'Task queue', live: 'Running now', history: 'Runs' };
```

Port `fetchFeed` verbatim including its body-carried-error branch — reading `res.json()` before throwing on a non-2xx, so the feed's own words are shown and the fixed start-the-server hint survives only for a genuine connection failure, which is the behaviour `2fe3364` established.

Write `renderQueue()` fresh:

```javascript
  function renderQueue() {
    if (data.unavailable) {
      els.queueNote.textContent = data.unavailable;
      els.queueNote.style.display = '';
      els.meters.style.display = 'none';
      els.listRepos.style.display = 'none';
      return;
    }
    els.queueNote.style.display = 'none';
    els.meters.style.display = '';
    els.listRepos.style.display = '';

    var t = data.totals;
    var total = t.open + t.closed;
    var percent = total ? Math.round((t.closed / total) * 100) : 0;
    els.doneValue.textContent = percent + '%';
    setBar(els.mDone, els.doneFill, percent);
    els.doneSub.textContent = num(t.closed) + ' closed · ' + num(t.open) + ' open';

    /* requires-user gets its own line: it is the count where the human is the
       blocker, which is the one number on this view that asks something of
       whoever is reading it. */
    var waiting = t.byMode['requires-user'] || 0;
    els.repos.textContent = t.repos + (t.repos === 1 ? ' repo' : ' repos') +
      (waiting ? ' · ' + waiting + ' waiting on you' : '');

    var rows = data.repos.slice().sort(function (a, b) { return b.open - a.open; });
    renderRepoRows(els.repoRows, rows);
  }

  function renderRepoRows(ul, rows) {
    ul.textContent = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = r.name;
      li.appendChild(name);
      var figure = document.createElement('span');
      figure.className = 'row-figure';
      /* A repo that could not be read says so in place of its counts, rather
         than showing a zero that would read as an empty queue. */
      figure.textContent = r.error ? r.error : (num(r.open) + ' open · ' + num(r.closed) + ' closed');
      if (r.error) figure.classList.add('row-error');
      li.appendChild(figure);
      ul.appendChild(li);
    }
    setHeading(ul, rows.length);
  }
```

`TaskQueue/styles/TaskQueue.css` — copy `ClaudeUsage/styles/ClaudeUsage.css` and keep its palette tokens, `.widget-root`, `.head`, `.dots`, `.clock`, `.meter`/`.track`/`.fill`, `.list`, `.loading-state`/`.error-state` and both theme blocks verbatim. Delete the rules for classes this widget has no markup for (`.tok`, `.mdl`, `.why`, `.cols`, `.models`, `.legend`) and add `.row-name`, `.row-figure`, `.row-error`, `.queue-note`, `.history-note`.

`TaskQueue/resources/icon.svg` — a simple checklist glyph in the same stroke weight as `ClaudeUsage/resources/icon.svg`.

`TaskQueue/translation.json` — mirror `ClaudeUsage/translation.json`'s structure with this widget's strings.

- [ ] **Step 4: Run test to verify it passes**

Run: `node TaskQueue/test/layout.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add TaskQueue
git commit -F - <<'MSG'
A third widget: how much of the queue is finished, everywhere at once

The shell is the usage widget's, so the two read as a pair on the dashboard and
the pager comes across with it - the webview forwards taps but not drags, so a
list that does not page itself has rows nobody can reach.

The queue view calls out requires-user separately, because that is the count
where the person reading the glass is the blocker.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 6: The Live view

**Files:**
- Modify: `TaskQueue/scripts/widget.js`, `TaskQueue/styles/TaskQueue.css`
- Modify: `TaskQueue/test/layout.test.js`

**Interfaces:**
- Consumes: `data.running` from the feed; `setHeading(ul, total)`, `renderRepoRows`, `cacheElements`, `num`, and the pager, all from Task 5.
- Produces: `renderLive()`, called from `render()` when `view === 'live'`.

- [ ] **Step 1: Write the failing test**

Add to `TaskQueue/test/layout.test.js`:

```javascript
function runningFixture() {
  const f = baseFixture();
  f.running = [
    { kind: 'holder', label: 'fix-the-pager-for-tall-children', repo: 'icue',
      since: Date.now() - 252000, detail: 'ClaudeUsage/scripts, ClaudeUsage/test' },
    { kind: 'holder', label: 'surface-the-feeds-own-error', repo: 'icue',
      since: Date.now() - 48000, detail: 'ClaudeUsage/scripts' },
    { kind: 'session', label: '/runqueue', repo: 'SIDM2', since: Date.now() - 600000, detail: '' },
    { kind: 'workflow', label: 'review-changes', repo: 'h2g', since: Date.now() - 120000, detail: '' },
    { kind: 'subtask', label: 'verify:bugs', repo: 'h2g', since: Date.now() - 60000, detail: '' }
  ];
  return f;
}

/* The state the machine is actually in almost all the time: serial.lock is []
   because no /runqueue is mid-flight, but Claude is still doing things. This is
   the fixture that proves the live view is worth having - without the enriched
   activity it would be a blank page here. */
function idleFixture() {
  const f = runningFixture();
  f.running = f.running.filter(r => r.kind !== 'holder');
  return f;
}

Add to `measure()` in `HARNESS`:

```javascript
    /* --- live view --- */
    out.holderKinds = Array.prototype.map.call(
      document.querySelectorAll('#holders li'), function (e) { return e.getAttribute('data-kind'); });
    out.activityKinds = Array.prototype.map.call(
      document.querySelectorAll('#activity li'), function (e) { return e.getAttribute('data-kind'); });
    out.headings = Array.prototype.map.call(
      document.querySelectorAll('.view-live h2'), function (e) { return e.textContent.trim(); });
```

`taps: 1` reaches the live view, since `VIEWS` starts on `queue` and one tap
advances one place. Add to `CASES`:

```javascript
  { name: 'live',      taps: 1, fixture: runningFixture() },
  { name: 'live-idle', taps: 1, fixture: idleFixture() },
```

Then:

```javascript
console.log('the live view:');
check('holders and activity land in different columns, and are not summed',
  [byName['live'].holderKinds.length, byName['live'].activityKinds.length], [2, 3]);
check('every row in the holders column is a holder',
  byName['live'].holderKinds, ['holder', 'holder']);
check('and no holder leaks into the activity column',
  byName['live'].activityKinds.indexOf('holder'), -1);
check('the holders heading carries its own count',
  byName['live'].headings[0], 'HOLDING A LOCK · 2');
/* [] is serial.lock's resting state, not a measurement of zero, so the
   heading must read NONE rather than 0 - the same distinction the usage
   widget's "WORKFLOWS · NONE ACTIVE" already draws. */
check('an idle lock says NONE rather than showing a blank column',
  byName['live-idle'].headings[0], 'HOLDING A LOCK · NONE');
check('and the activity column still carries its rows, so the view is not blank',
  byName['live-idle'].activityKinds.length, 3);
```

Overflow for these renders is covered by the shared loop already added in Task
5, because they are in the same `ok` array.

- [ ] **Step 2: Run test to verify it fails**

Run: `node TaskQueue/test/layout.test.js`
Expected: FAIL — the live-view checks fail; both columns render empty

- [ ] **Step 3: Write minimal implementation**

Add to `TaskQueue/scripts/widget.js`:

```javascript
  function elapsed(since) {
    if (since == null) return '';
    var secs = Math.max(0, Math.round((Date.now() - since) / 1000));
    if (secs < 60) return secs + 's';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm' + (secs % 60) + 's';
    return Math.floor(mins / 60) + 'h' + (mins % 60) + 'm';
  }

  /* A held lock and an open Claude session are DIFFERENT CLAIMS about the
     machine - one says a runner owns some paths, the other says a person or an
     agent is talking to the API - so they get separate columns and separate
     counts and are never added together. */
  function renderLive() {
    var running = data.running || [];
    var holders = running.filter(function (r) { return r.kind === 'holder'; });
    var activity = running.filter(function (r) { return r.kind !== 'holder'; });
    renderRunning(els.holders, holders, true);
    renderRunning(els.activity, activity, false);
  }

  function renderRunning(ul, rows, showPaths) {
    ul.textContent = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var li = document.createElement('li');
      li.setAttribute('data-kind', r.kind);

      var name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = r.label;
      li.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'row-figure';
      var parts = [];
      if (r.repo) parts.push(r.repo);
      var age = elapsed(r.since);
      if (age) parts.push(age);
      if (showPaths && r.detail) parts.push(r.detail);
      meta.textContent = parts.join(' · ');
      li.appendChild(meta);

      ul.appendChild(li);
    }
    setHeading(ul, rows.length);
  }
```

`setHeading` as ported from the usage widget already renders `NONE` for a zero count; confirm it does, and if it renders `0` instead, change it to `NONE` — an idle lock is the resting state, not a measurement of zero.

In the CSS, give `li[data-kind="holder"]` a distinct accent from the other kinds, using an existing palette token rather than a new colour.

- [ ] **Step 4: Run test to verify it passes**

Run: `node TaskQueue/test/layout.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add TaskQueue
git commit -F - <<'MSG'
What is running now, with a held lock kept distinct from an open session

serial.lock is empty except while a /runqueue is mid-flight, so the view also
carries the sessions and workflows the usage feed already computes - without
which it would be blank almost every time anyone looked at it. Two columns, two
counts, never summed: they are different claims about the machine.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 7: The History view

**Files:**
- Modify: `TaskQueue/scripts/widget.js`, `TaskQueue/styles/TaskQueue.css`
- Modify: `TaskQueue/test/layout.test.js`

**Interfaces:**
- Consumes: `data.history` and `data.totals.byOutcome`; `svg()`, `heatLevel()`, `dayNumber()`, `buildHeatmap()`, `fig()` ported from `ClaudeUsage/scripts/widget.js:286-470`.
- Produces: `renderHistory()`, called from `render()` when `view === 'history'`.

- [ ] **Step 1: Write the failing test**

Add to `TaskQueue/test/layout.test.js`:

```javascript
/* Runs on 40 days spread across a 96-day span, so the heatmap is SPARSE -
   which is the shape the real data has, and the shape that catches a grid laid
   out by array position instead of by date. */
function historyFixture() {
  const f = baseFixture();
  const start = Date.UTC(2026, 5, 1);
  const history = [];
  for (let d = 0; d < 96; d += 2.4) {
    const day = Math.floor(d);
    const n = 1 + (day % 5);
    for (let i = 0; i < n; i++) {
      history.push({
        at: start + day * 86400000 + i * 3600000,
        atSource: 'commit',
        outcome: (day + i) % 9 === 0 ? 'partial' : 'done',
        model: i % 3 === 0 ? 'opus' : 'sonnet',
        effort: ['low', 'medium', 'high', 'unknown'][i % 4],
        mode: 'subtask',
        repo: 'icue'
      });
    }
  }
  f.history = history;
  return f;
}

function noHistoryFixture() {
  const f = baseFixture();
  f.history = [];
  f.repos[0].historyError = 'git could not be read in C:/repo';
  return f;
}

Add to `measure()` in `HARNESS`:

```javascript
    /* --- history view --- */
    var heat = document.getElementById('heat');
    out.heatCellsTotal = heat ? heat.querySelectorAll('rect[data-day]').length : null;
    out.heatCellsEmpty = heat ? heat.querySelectorAll('rect[data-day][data-level="0"]').length : null;
    out.heatHeadText = (document.getElementById('heat-head') || {}).textContent || null;
    var histNote = document.getElementById('history-note');
    out.historyNoteText = histNote ? histNote.textContent : null;
    var hist = document.querySelector('.view-history .history');
    out.historyGridDisplay = hist ? window.getComputedStyle(hist).display : null;
    out.figLabels = Array.prototype.map.call(
      document.querySelectorAll('#figs .fig .k'), function (e) { return e.textContent; });
    out.figValues = Array.prototype.map.call(
      document.querySelectorAll('#figs .fig .v'), function (e) { return e.textContent; });
```

`buildHeatmap()` as ported must therefore give every cell a `data-day` and a
`data-level`; check that it does when porting it, and add them if it does not —
a grid the harness cannot count is a grid this suite cannot defend.

`taps: 2` reaches the history view. Add to `CASES`:

```javascript
  { name: 'history',      taps: 2, fixture: historyFixture() },
  { name: 'history-none', taps: 2, fixture: noHistoryFixture() },
```

Then:

```javascript
console.log('the history view:');

/* The rule the usage widget's stats view already carries, for the same
   reason: run records are sparse in time - 40 active days across a 96-day
   span here - so a grid packed by array position draws a solid block and puts
   every date in the wrong column. A grid laid out correctly has MORE cells
   than there are active days, and some of them empty. */
check('the heatmap spans the calendar, not the record count',
  byName['history'].heatCellsTotal >= 96, true);
check('and quiet days are drawn as empty cells',
  byName['history'].heatCellsEmpty > 0, true);

/* No run record carries a timestamp; the date is the commit each record's
   head names. The heading must say so, or the view is claiming something the
   data cannot support. */
check('the axis is labelled as commit time, not run time',
  /commit/i.test(byName['history'].heatHeadText), true);

check('the outcome split reaches the screen',
  byName['history'].figLabels.indexOf('done') >= 0 &&
  byName['history'].figLabels.indexOf('partial') >= 0, true);
check('no headline figure is truncated', ellipsisedFigsIn(byName['history']), []);

check('history that could not be dated says why instead of drawing a grid',
  byName['history-none'].historyNoteText, 'git could not be read in C:/repo');
check('and draws no grid at all in that state',
  byName['history-none'].historyGridDisplay, 'none');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node TaskQueue/test/layout.test.js`
Expected: FAIL — the history-view checks fail; the heat container is empty

- [ ] **Step 3: Write minimal implementation**

Port `SVG_NS`, `svg()`, `dayNumber()`, `shortDate()`, `heatLevel()`, `HEAT_CELL`/`HEAT_GAP`/`HEAT_LABEL`, `WEEKDAY_LABEL`, `buildHeatmap()`, `fig()` and `big()` from `ClaudeUsage/scripts/widget.js:286-470` unchanged. Then:

```javascript
  /* Bucket by LOCAL calendar date, keyed by YYYY-MM-DD, then hand
     buildHeatmap the same day-keyed structure the usage widget's stats view
     uses. Laid out by calendar position, not array position: run records are
     sparse - 40 active days across a 96-day span in the fixture, and 92 across
     284 on the real account - so packing them side by side would draw a solid
     block with every date in the wrong column. */
  function byDay(history) {
    var days = {};
    for (var i = 0; i < history.length; i++) {
      var d = new Date(history[i].at);
      var key = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      days[key] = (days[key] || 0) + 1;
    }
    return days;
  }

  function renderHistory() {
    var history = data.history || [];
    var reasons = (data.repos || [])
      .map(function (r) { return r.historyError; })
      .filter(function (e) { return !!e; });

    if (!history.length) {
      /* An empty grid would read as months of silence rather than as history
         that could not be dated, which is the one failure this view must not
         have. */
      els.historyNote.textContent = reasons.length ? reasons.join(' · ')
        : 'no run has been recorded in any queue yet';
      els.historyNote.style.display = '';
      els.history.style.display = 'none';
      return;
    }
    els.historyNote.style.display = 'none';
    els.history.style.display = '';

    var days = byDay(history);
    var counts = Object.keys(days).map(function (k) { return days[k]; });
    var max = counts.reduce(function (a, b) { return Math.max(a, b); }, 0);

    /* Says which clock this is. The records carry no time of their own - the
       date is the commit their `head` names - and a view that showed it as
       when the run happened would be claiming something the data cannot
       support. */
    els.heatHead.textContent = 'Runs, by commit time';
    els.heat.textContent = '';
    els.heat.appendChild(buildHeatmap(days, max));

    var out = data.totals.byOutcome || {};
    var models = tallyField(history, 'model');
    var efforts = tallyField(history, 'effort');
    els.figs.textContent = '';
    els.figs.appendChild(fig('runs', big(history.length)));
    els.figs.appendChild(fig('done', big(out.done || 0)));
    els.figs.appendChild(fig('partial', big(out.partial || 0)));
    els.figs.appendChild(fig('days', big(Object.keys(days).length)));
    els.figs.appendChild(fig('top model', topKey(models)));
    els.figs.appendChild(fig('top effort', topKey(efforts)));
  }

  function tallyField(rows, name) {
    var out = {};
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i][name] || 'unknown';
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  function topKey(counts) {
    var best = '', bestN = -1;
    for (var k in counts) {
      if (counts[k] > bestN) { best = k; bestN = counts[k]; }
    }
    return best || '—';
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node TaskQueue/test/layout.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add TaskQueue
git commit -F - <<'MSG'
The run history, on the calendar it actually happened on

Laid out by date rather than by array position, because run records are sparse
- packing them side by side draws a solid block with every date in the wrong
column, which is the same trap the usage widget's heatmap already learned.

The heading says "by commit time" because that is what the date is: no run
record carries a timestamp, so each is dated from the commit its head names.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 8: Deploy, CI and docs

**Files:**
- Modify: `tools/deploy.ps1:40` (`ValidateSet`), `tools/deploy.ps1:81-82` (widget table)
- Modify: `.github/workflows/tests.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `pwsh tools/deploy.ps1 -Widget TaskQueue` works; CI runs both new suites.

- [ ] **Step 1: Verify the whole suite passes before touching deploy**

Run every suite:

```bash
node usage-server/test/tasks.test.js
node usage-server/test/tasks-http.test.js
node usage-server/test/http.test.js
node usage-server/test/stats.test.js
node usage-server/test/live-detection.test.js
node usage-server/test/statusline.test.js
node C64Weather/test/font.test.js
node C64Weather/test/theme.test.js
node C64Weather/test/layout.test.js
node ClaudeUsage/test/layout.test.js
node TaskQueue/test/layout.test.js
```

Expected: every one PASS. `deploy.ps1` runs tests before bumping a version, so a red suite here would leave the tree byte-identical anyway — but the failure is cheaper to read from the direct run.

- [ ] **Step 2: Add the widget to deploy.ps1**

At line 40, extend the `ValidateSet`:

```powershell
  [ValidateSet('C64Weather', 'ClaudeUsage', 'TaskQueue', 'all')]
```

After line 82, add the table row:

```powershell
  [pscustomobject]@{ Name = 'TaskQueue';   Id = 'com.thordanielz.taskqueue';   Package = 'task-queue.icuewidget' }
```

Read `tools/deploy.ps1:204` before editing — it carries a `ClaudeUsage`-specific branch. Determine what it does; if it is version-stamping `scripts/widget.js`, widen its condition to include `TaskQueue`, since this widget has the same two-place version. If it is something usage-specific, leave it alone.

- [ ] **Step 3: Add both suites to CI**

In `.github/workflows/tests.yml`, after the existing `usage-server` steps (around line 49):

```yaml
      - name: tasks feed
        run: node usage-server/test/tasks.test.js

      - name: tasks feed over http
        run: node usage-server/test/tasks-http.test.js
```

And after the `ClaudeUsage` layout step (around line 68):

```yaml
      - name: TaskQueue layout
        run: node TaskQueue/test/layout.test.js
```

`tasks.test.js` shells out to `git`, which the runner has. It creates its repos under `mkdtemp`, so nothing touches the checkout.

- [ ] **Step 4: Verify the deploy script sees the new widget**

Run: `pwsh tools/deploy.ps1 -Widget TaskQueue -DryRun`
Expected: it prints every step without changing anything, and reports that `TaskQueue` has never been imported — the one manual step. Do not run it without `-DryRun` in this task.

- [ ] **Step 5: Document it in README.md**

Add a `## Task Queue` section after `## Claude Code Usage`, following that section's voice. It must state:

- what the widget shows, and that the feed is the same `usage-server` on 41777 at `/tasks`;
- that discovery reads the `projects` map in `~/.claude.json`, and **why the mangled `~/.claude/projects/` names cannot be used** — the separator and a literal dash become the same character;
- that **no run record carries a timestamp**, so the history axis is the commit named by each record's `head`, labelled as such;
- that `serial.lock`'s resting state is `[]`, which is why the live view also carries the usage feed's session and workflow activity;
- the settings table (`feedUrl`, `colorTheme`, `timeFormat`, `refreshSeconds`) in the same format the other two widgets use.

Also add one line to the `## Deploying` section noting the third widget name.

- [ ] **Step 6: Commit**

```bash
git add tools/deploy.ps1 .github/workflows/tests.yml README.md
git commit -F - <<'MSG'
Deploy, test and document the third widget alongside the other two

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Task 9: See it on the glass

The layout suite renders in headless Chrome. That is not the device, and this repo's history has a standing task for exactly the gap between the two.

**Files:** none — this is a verification task.

- [ ] **Step 1: Start the feed and read it by hand**

```bash
node usage-server/server.js
```

Then, in another shell:

```bash
curl -s http://127.0.0.1:41777/tasks | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log('repos',d.repos.length,'open',d.totals.open,'closed',d.totals.closed,'history',d.history.length,'running',d.running.length);console.log(d.repos.map(r=>r.name+' '+r.open+'/'+r.closed+(r.error?' ERR '+r.error:'')).join('\n'))})"
```

Expected, against the state measured while this was designed — treat a difference as something to explain, not to wave through: **5 repos**, roughly **210 open** and **307 closed**, `running` empty unless a `/runqueue` is mid-flight, `history` non-empty for the repos that are git checkouts.

- [ ] **Step 2: Confirm /usage did not regress**

```bash
curl -s http://127.0.0.1:41777/usage | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log('queued', (d.queued||[]).length)})"
```

Expected: **more** queued entries than before this work, because `collectQueuedTasks()` now sees all five repos rather than three. If the count is unchanged, the repoint in Task 4 did not take effect.

- [ ] **Step 3: Install and look at it**

```bash
pwsh tools/deploy.ps1 -Widget TaskQueue
```

The first run will stop and tell you to import `task-queue.icuewidget` once through iCUE's UI — Dashboard, add a widget — because a mirror needs a registered GUID folder to mirror onto. Do that, then run the command again.

- [ ] **Step 4: Capture the device and check all three views**

```powershell
pwsh tools/capture-device.ps1
```

Read `tools/capture-device.ps1` first for its actual parameters. It captures `\\.\DISPLAY2` (2560×720 at X=-1881, Y=1440).

Confirm **from the rendered page, not from the installed folder** — iCUE caches the page it loaded at startup, so the folder is not proof of what is running:

- the header reads `v1.0.0`;
- the queue view's repo list matches the counts from Step 1;
- tapping cycles queue → live → history → queue, and the header dot follows;
- the history heatmap has gaps in it. A solid block means the grid is laid out by array position and the calendar-date rule was lost somewhere.

- [ ] **Step 5: Report what the glass showed**

Write up what each view actually looked like, including anything that differed from the headless renders. Do not mark this task done on the strength of the layout suite passing — the suite renders in Chrome, and every device-only defect in this repo's history was invisible to it.
