# `/taskshtml` — a browser view of the task feed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the `/tasks` feed as a readable HTML page, so the feed can be
inspected without the widget that consumes it.

**Architecture:** A new `usage-server/taskshtml.js` exporting a single
`render(feed, project)`, mirroring `usagehtml.js` exactly — same `esc()`
discipline, same `<table class="grid">` markup, same 30-second meta refresh,
no dependency. A new route in `server.js` placed *above* the `/tasks` handler,
because `/tasks` matches on a prefix and would otherwise shadow it. The page is
DIAGNOSTIC: it shows what the feed says, not what the panel shows.

**Tech Stack:** Node.js, CommonJS, `'use strict'`, zero dependencies. Tests are
plain scripts counting into `let failures = 0` and run with `node <file>`.

**Spec:** `TODO.md`, Task Queue → Open → *"A browser view of the task feed, like
`/usagehtml`"*. That entry carries the scope decision and its reasoning.

## Global Constraints

- **Zero dependencies.** Nothing may be added to this repo; it has no
  `package.json` and that is deliberate.
- **Diagnostic, not a mirror.** Do NOT reimplement the widget's five views. Two
  renderers of the same data drift apart and neither becomes authoritative. The
  page must say what it is, in its own subtitle.
- **LF line endings.** Every file in this repo is LF; `.gitattributes` pins it
  and `core.autocrlf` is true, so `git checkout --` and `git stash pop`
  reintroduce CRLF. Write bytes, and byte-check after any restore.
- **Escape everything.** Repo names, task titles, error strings and mutex owners
  are all attacker-adjacent free text from disk. Every interpolation goes
  through `esc()`. This is the one security-relevant property of the page.
- **Node ≥ 22.** The CI matrix is `[22, 24]`.
- **Never tune a threshold to the smallest value that fires here.** Two CI
  failures this month came from assertions sitting on a boundary measured on one
  machine.

---

### Task 1: The renderer, with the overview table

**Files:**
- Create: `usage-server/taskshtml.js`
- Create: `usage-server/test/taskshtml.test.js`

**Interfaces:**
- Consumes: the `/tasks` payload shape, verified live on 2026-09-06:
  `{generatedAt, repos, totals, running, alarms, history, unavailable}` where
  `repos[]` is
  `{name, path, open, closed, blocked, byMode, byLane, holders, files, mutex, lastRunAt, error, doneSincePlan, historyError}`
  and `totals` is `{open, closed, repos, blocked, byMode}`.
- Produces: `module.exports = { render }` where
  `render(feed, project)` returns a complete HTML document as a string.
  `feed` is the `/tasks` payload; `project` is the `/tasks?project=` payload or
  `null`. Task 3 calls it; Task 4 extends it.

- [ ] **Step 1: Write the failing test**

Create `usage-server/test/taskshtml.test.js`:

```js
'use strict';
/* Unit tests for the HTML renderer. The route itself is tested end-to-end in
   test/tasks-http.test.js; this file tests rendering against fixtures, so a
   markup regression does not need a spawned server to catch. */

const taskshtml = require('../taskshtml');

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

function feedFixture() {
  return {
    generatedAt: 1788680000000,
    repos: [
      { name: 'SIDM2', path: 'C:/x/SIDM2', open: 44, closed: 69, blocked: 30,
        byMode: { main: 20, subtask: 24 }, byLane: {}, holders: [], files: {},
        mutex: { held: false, stale: false, since: null, owner: null, reason: null },
        lastRunAt: 1788679000000, error: null, doneSincePlan: 0, historyError: null },
      { name: 'icue', path: 'C:/x/icue', open: 2, closed: 31, blocked: 0,
        byMode: {}, byLane: {}, holders: [], files: {},
        mutex: { held: false, stale: false, since: null, owner: null, reason: null },
        lastRunAt: null, error: null, doneSincePlan: 0, historyError: null }
    ],
    totals: { open: 46, closed: 100, repos: 2, blocked: 30, byMode: {} },
    running: [], alarms: [],
    history: { runs: 0, days: [], outcome: {}, model: {}, effort: {}, span: null },
    unavailable: null
  };
}

console.log('the overview:');
{
  const html = taskshtml.render(feedFixture(), null);
  check('it is a complete document', /^<!doctype html>/i.test(html), true);
  check('it names itself as the feed, not the panel',
    /not what the panel shows/i.test(html), true);
  check('every repo appears', /SIDM2/.test(html) && /icue/.test(html), true);
  check('the totals are rendered', /\b46\b/.test(html), true);
  check('a repo that has never run says so rather than showing a date',
    /never run/i.test(html), true);
}

console.log('escaping:');
{
  const f = feedFixture();
  f.repos[0].name = '<script>alert(1)</script>';
  const html = taskshtml.render(f, null);
  check('a repo name carrying markup is escaped', html.indexOf('<script>alert(1)') === -1, true);
  check('and its text still reaches the page', /&lt;script&gt;/.test(html), true);
}

console.log('the empty case:');
{
  const html = taskshtml.render({ repos: [], totals: {}, running: [], alarms: [],
                                  history: {}, unavailable: 'no registry' }, null);
  check('an unavailable feed says why instead of drawing an empty table',
    /no registry/.test(html), true);
  check('and does not claim zero repos as a finding',
    /<table/.test(html), false);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node usage-server/test/taskshtml.test.js`
Expected: FAIL — `Cannot find module '../taskshtml'`

- [ ] **Step 3: Write minimal implementation**

Create `usage-server/taskshtml.js`:

```js
/* A DIAGNOSTIC view of the /tasks feed.
 *
 * It exists because a panel showing nothing and a feed serving nothing look
 * identical from across the room, and the only other way to tell them apart is
 * to read raw JSON. It deliberately does NOT mirror the widget's five views: two
 * renderers of the same data drift apart and neither stays authoritative. This
 * one shows what the FEED says. The panel is the widget's job.
 *
 * Same shape as usagehtml.js on purpose - esc() on every interpolation, one
 * <table class="grid"> idiom, a meta refresh, no dependency.
 */
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(n) {
  return (n == null || Number.isNaN(n)) ? '—' : Math.round(n).toLocaleString('en-US');
}

/* null is a real reading here, not missing data: a repo with no runs has never
   been run, and saying "never run" is the whole point - a fabricated age would
   be the panel claiming something it cannot support. */
function ago(ms) {
  if (ms == null) return 'never run';
  const d = Date.now() - ms;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}

const STYLE =
  'body{font:13px/1.45 system-ui,sans-serif;margin:24px;background:#14161a;color:#e8e6e1}' +
  'h1{font-size:18px;margin:0 0 2px}' +
  'p.sub{color:#8d949e;margin:0 0 18px}' +
  'h2{font-size:14px;margin:22px 0 6px}' +
  'table.grid{border-collapse:collapse;margin:0 0 8px;width:100%;max-width:900px}' +
  'table.grid th,table.grid td{border-bottom:1px solid #2a2f37;padding:4px 10px 4px 0;text-align:left}' +
  'table.grid th{color:#8d949e;font-weight:600}' +
  'td.n,th.n{text-align:right}' +
  '.muted{color:#8d949e}' +
  '.warn{color:#e0a458}';

function table(cols, rows) {
  return '<table class="grid"><thead><tr>' +
    cols.map(c => '<th' + (c.n ? ' class="n"' : '') + '>' + esc(c.label) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + cols.map(c =>
      '<td' + (c.n ? ' class="n"' : '') + '>' + c.get(r) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table>';
}

function render(feed, project) {
  const f = feed || {};
  const head = '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<title>Task feed — debug</title>' +
    '<meta http-equiv="refresh" content="30" />' +
    '<style>' + STYLE + '</style></head><body>' +
    '<h1>Task feed</h1>' +
    '<p class="sub">This page shows what the <code>/tasks</code> feed says, not ' +
    'what the panel shows. If they disagree, the widget is the thing to look at.</p>';
  const tail = '</body></html>';

  if (f.unavailable) {
    return head + '<p class="warn">Feed unavailable: ' + esc(f.unavailable) + '</p>' + tail;
  }

  const totals = f.totals || {};
  let out = head +
    '<h2>Totals</h2>' +
    '<p>' + num(totals.open) + ' open · ' + num(totals.closed) + ' closed · ' +
    num(totals.blocked) + ' blocked · across ' + num(totals.repos) + ' repos</p>' +
    '<h2>Repos</h2>' +
    table([
      { label: 'repo', get: r => esc(r.name) },
      { label: 'open', n: true, get: r => num(r.open) },
      { label: 'closed', n: true, get: r => num(r.closed) },
      { label: 'blocked', n: true, get: r => num(r.blocked) },
      { label: 'last run', get: r => esc(ago(r.lastRunAt)) },
      { label: 'error', get: r => r.error ? '<span class="warn">' + esc(r.error) + '</span>' : '' }
    ], f.repos || []);

  return out + tail;
}

module.exports = { render };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node usage-server/test/taskshtml.test.js`
Expected: PASS — `all passed`

- [ ] **Step 5: Prove the escaping check can fail**

Temporarily change `esc(r.name)` to `r.name` in the repos table, re-run, and
confirm exactly the two escaping checks fail. Restore, re-run, confirm green.
An assertion that cannot fail is worse than none.

- [ ] **Step 6: Commit**

```bash
git add usage-server/taskshtml.js usage-server/test/taskshtml.test.js
git commit -m "Render the task feed as a page, so it can be read without the widget"
```

---

### Task 2: The running block, the mutex state, and the alarms

**Files:**
- Modify: `usage-server/taskshtml.js`
- Modify: `usage-server/test/taskshtml.test.js`

**Interfaces:**
- Consumes: `render(feed, project)` from Task 1.
- Produces: no new exports. `render` gains three sections.

Real shapes, read from a live feed on 2026-09-06:
`running[]` is `{kind, label, repo, since, detail}` with `kind` one of
`session` / `workflow` / `subtask`. `repos[].mutex` is
`{held, stale, since, owner, reason}`. `alarms` is an array (empty in the
healthy case).

- [ ] **Step 1: Write the failing test**

Append to `usage-server/test/taskshtml.test.js`, before the final
`console.log(failures ? ...)` line:

```js
console.log('the running block:');
{
  const f = feedFixture();
  f.running = [
    { kind: 'session', label: 'a long label that the page shows in full',
      repo: 'icue', since: Date.now() - 120000, detail: '' },
    { kind: 'subtask', label: 'reviewing', repo: 'SIDM2',
      since: Date.now() - 30000, detail: 'sonnet' }
  ];
  const html = taskshtml.render(f, null);
  check('both running rows appear', /a long label/.test(html) && /reviewing/.test(html), true);
  check('the kind is shown, so a session is not read as a subtask',
    /session/.test(html) && /subtask/.test(html), true);
  check('an age is shown rather than a raw epoch',
    /\b2m ago\b/.test(html), true);
}

console.log('mutex and alarms:');
{
  const f = feedFixture();
  f.repos[0].mutex = { held: true, stale: true, since: Date.now() - 3600000,
                       owner: 'runqueue', reason: 'pid 999 not running' };
  f.alarms = ['SIDM2: mutex held for 60m'];
  const html = taskshtml.render(f, null);
  check('a held mutex is reported', /runqueue/.test(html), true);
  check('a STALE mutex is marked, not just reported as held',
    /stale/i.test(html), true);
  check('the alarm text is shown', /held for 60m/.test(html), true);
  check('and the alarm is marked as a warning, not plain text',
    /class="warn"[^>]*>[^<]*held for 60m|held for 60m[^<]*<\/span>/.test(html), true);
}

console.log('the quiet case:');
{
  const html = taskshtml.render(feedFixture(), null);
  check('nothing running says so rather than drawing an empty table',
    /nothing running/i.test(html), true);
  check('no alarms says so too', /no alarms/i.test(html), true);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node usage-server/test/taskshtml.test.js`
Expected: FAIL on the running, mutex and alarm checks; the Task 1 checks still pass.

- [ ] **Step 3: Write minimal implementation**

In `usage-server/taskshtml.js`, add a `since`-formatting reuse of `ago()` and
insert these sections into `render`, between the Repos table and `return out + tail`:

```js
  const running = f.running || [];
  out += '<h2>Running</h2>' +
    (running.length
      ? table([
          { label: 'kind', get: r => esc(r.kind) },
          { label: 'repo', get: r => esc(r.repo) },
          { label: 'label', get: r => esc(r.label) },
          { label: 'detail', get: r => esc(r.detail) },
          { label: 'since', get: r => esc(ago(r.since)) }
        ], running)
      : '<p class="muted">nothing running</p>');

  /* A held mutex is ordinary - a drain is working. A STALE one is not: it means
     the holder is gone and its paths are refused until someone clears it. The
     two must not read alike, which is why stale gets the warn treatment and
     held alone does not. */
  const mutexRows = (f.repos || []).filter(r => r.mutex && (r.mutex.held || r.mutex.stale));
  out += '<h2>Mutex</h2>' +
    (mutexRows.length
      ? table([
          { label: 'repo', get: r => esc(r.name) },
          { label: 'state', get: r => r.mutex.stale
              ? '<span class="warn">stale</span>' : 'held' },
          { label: 'owner', get: r => esc(r.mutex.owner) },
          { label: 'since', get: r => esc(ago(r.mutex.since)) },
          { label: 'reason', get: r => esc(r.mutex.reason) }
        ], mutexRows)
      : '<p class="muted">no mutex held</p>');

  const alarms = f.alarms || [];
  out += '<h2>Alarms</h2>' +
    (alarms.length
      ? '<ul>' + alarms.map(a => '<li class="warn">' + esc(a) + '</li>').join('') + '</ul>'
      : '<p class="muted">no alarms</p>');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node usage-server/test/taskshtml.test.js`
Expected: PASS — `all passed`

- [ ] **Step 5: Prove the stale-mutex check can fail**

Temporarily render `'held'` unconditionally instead of branching on
`r.mutex.stale`, re-run, and confirm the stale check fails and nothing else
does. Restore and re-run.

- [ ] **Step 6: Commit**

```bash
git add usage-server/taskshtml.js usage-server/test/taskshtml.test.js
git commit -m "Show what is running, what holds a mutex, and what is alarming"
```

---

### Task 3: The route

**Files:**
- Modify: `usage-server/server.js` (add a route immediately above the `/tasks`
  handler at `server.js:1345`)
- Modify: `usage-server/test/tasks-http.test.js`

**Interfaces:**
- Consumes: `taskshtml.render(feed, project)` from Tasks 1–2, and
  `tasks.build(live, {raw})` — the same call `/tasks` already makes at
  `server.js:1381`.
- Produces: `GET /taskshtml` → `200 text/html; charset=utf-8`.

**Route ordering matters and is the one way to get this wrong.** The `/usage`
handler matches on a PREFIX (`req.url.startsWith('/usage')`, `server.js:1425`),
which is why `/tasks` is deliberately placed above it — see the comment at
`server.js:1343`. `/taskshtml` must sit above the `/tasks` handler for the same
reason: `req.url === '/tasks'` will not match it, but any future prefix match
would, and the ordering should not depend on that staying an exact comparison.

- [ ] **Step 1: Write the failing test**

In `usage-server/test/tasks-http.test.js`, add after the existing `/tasks`
assertions inside the same `try` block:

```js
    const html = await get('/taskshtml');
    check('/taskshtml answers 200', html.status, 200);
    check('and answers as HTML, not JSON',
      /text\/html/.test(html.type), true);
    check('it is a complete document',
      /^<!doctype html>/i.test(html.body), true);
    check('both fixture repos are on the page',
      /repo-a/.test(html.body) && /nested-repo/.test(html.body), true);
    check('it says it is the feed rather than the panel',
      /shows what the .*tasks.* feed says/i.test(html.body), true);
    check('and /tasks still answers JSON, so the new route shadows nothing',
      /application\/json/.test((await get('/tasks')).type), true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node usage-server/test/tasks-http.test.js`
Expected: FAIL — `/taskshtml answers 200` gets 404, and the HTML checks fail.

- [ ] **Step 3: Write minimal implementation**

At the top of `usage-server/server.js`, beside the existing requires:

```js
const taskshtml = require('./taskshtml');
```

Then insert immediately BEFORE the `if (req.url === '/tasks' ...)` handler:

```js
    /* The HTML view of the task feed. Above /tasks for the same reason /tasks is
       above /usage: a route that matches on a prefix must never be given the
       chance to shadow a longer one. /tasks is an exact comparison today, and
       this ordering means it can stop being one safely. */
    if (req.url === '/taskshtml' || req.url.startsWith('/taskshtml?')) {
      const live = snapshot
        ? { sessions: snapshot.sessions, workflows: snapshot.workflows,
            subtasks: snapshot.subtasks }
        : null;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(taskshtml.render(tasks.build(live, { raw: false }), null));
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node usage-server/test/tasks-http.test.js`
Expected: PASS — `all passed`

- [ ] **Step 5: Check it by eye, once**

```bash
node usage-server/server.js &
```

Open `http://127.0.0.1:41777/taskshtml`. Confirm the repo table matches what
`http://127.0.0.1:41777/tasks` reports. Stop the server. This is the only manual
step in the plan and it exists because the page's whole purpose is being read by
a human — a suite can prove the markup is present and cannot prove it is legible.

- [ ] **Step 6: Commit**

```bash
git add usage-server/server.js usage-server/test/tasks-http.test.js
git commit -m "Serve the task feed at /taskshtml, above the route that would shadow it"
```

---

### Task 4: `?project=` on the page

**Files:**
- Modify: `usage-server/taskshtml.js`
- Modify: `usage-server/server.js`
- Modify: `usage-server/test/taskshtml.test.js`
- Modify: `usage-server/test/tasks-http.test.js`

**Interfaces:**
- Consumes: `tasks.projectTasks(name)`, which returns
  `{project, tasks, doneTotal, doneShown, error}` where each task is
  `{id, title, mode, model, effort, lane, blocked, state, needsMain, waitingOn, reason}`
  — verified live 2026-09-06.
- Produces: `GET /taskshtml?project=<name>` → the same page with a per-project
  task table appended.

- [ ] **Step 1: Write the failing test**

Append to `usage-server/test/taskshtml.test.js`, before the final summary line:

```js
console.log('a single project:');
{
  const project = {
    project: 'icue',
    tasks: [
      { id: 'a-task', title: 'A thing to do', mode: 'subtask', model: 'sonnet',
        effort: 'low', lane: 'parallel', blocked: false, state: 'ready',
        needsMain: false, waitingOn: null, reason: null },
      { id: 'blocked-task', title: 'Waiting on a human', mode: 'requires-user',
        model: 'sonnet', effort: 'low', lane: 'serial', blocked: true,
        state: 'blocked', needsMain: true, waitingOn: 'a decision', reason: null }
    ],
    doneTotal: 31, doneShown: 0, error: null
  };
  const html = taskshtml.render(feedFixture(), project);
  check('the project name is shown', /icue/.test(html), true);
  check('every task id appears',
    /a-task/.test(html) && /blocked-task/.test(html), true);
  check('a blocked task says what it waits on, not just that it is blocked',
    /a decision/.test(html), true);
  check('the done count is shown so the list is not read as the whole queue',
    /\b31\b/.test(html), true);
}

console.log('a project that failed to read:');
{
  const html = taskshtml.render(feedFixture(),
    { project: 'broken', tasks: [], doneTotal: 0, doneShown: 0,
      error: 'whattask.json could not be parsed' });
  check('the error is shown rather than an empty task list',
    /could not be parsed/.test(html), true);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node usage-server/test/taskshtml.test.js`
Expected: FAIL on the project checks; every earlier check still passes.

- [ ] **Step 3: Write minimal implementation**

In `usage-server/taskshtml.js`, insert before `return out + tail`:

```js
  if (project) {
    out += '<h2>Project: ' + esc(project.project) + '</h2>';
    if (project.error) {
      out += '<p class="warn">' + esc(project.error) + '</p>';
    } else {
      /* doneShown/doneTotal is stated because the list is TRIMMED - reading it
         as the whole queue is the misreading this line exists to prevent. */
      out += '<p class="muted">' + num(project.doneTotal) + ' done, ' +
        num(project.doneShown) + ' of them shown</p>' +
        table([
          { label: 'id', get: t => esc(t.id) },
          { label: 'title', get: t => esc(t.title) },
          { label: 'mode', get: t => esc(t.mode) },
          { label: 'model', get: t => esc(t.model) },
          { label: 'effort', get: t => esc(t.effort) },
          { label: 'state', get: t => t.blocked
              ? '<span class="warn">' + esc(t.state) + '</span>' : esc(t.state) },
          { label: 'waiting on', get: t => esc(t.waitingOn) }
        ], project.tasks || []);
    }
  }
```

In `usage-server/server.js`, replace the body of the `/taskshtml` route with:

```js
    if (req.url === '/taskshtml' || req.url.startsWith('/taskshtml?')) {
      const live = snapshot
        ? { sessions: snapshot.sessions, workflows: snapshot.workflows,
            subtasks: snapshot.subtasks }
        : null;
      /* Percent-decoded inside the same try as everything else, and answered
         4xx rather than thrown - a malformed escape is the caller's mistake and
         must never take the process down. Same rule as the /tasks route. */
      const hq = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '';
      const hm = /(?:^|&)project=([^&]*)/.exec(hq);
      let proj = null;
      if (hm) {
        let name;
        try {
          name = decodeURIComponent(hm[1]);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('project= is not valid percent-encoding');
          return;
        }
        proj = tasks.projectTasks(name);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(taskshtml.render(tasks.build(live, { raw: false }), proj));
      return;
    }
```

- [ ] **Step 4: Add the route test**

In `usage-server/test/tasks-http.test.js`, after the existing `/taskshtml` checks:

```js
    const one = await get('/taskshtml?project=repo-a');
    check('/taskshtml?project= answers 200', one.status, 200);
    check('and names the project', /repo-a/.test(one.body), true);
    const bad = await get('/taskshtml?project=%ZZ');
    check('a malformed percent-escape is a 400, not a crash', bad.status, 400);
    check('and the server is still up afterwards',
      (await get('/taskshtml')).status, 200);
```

- [ ] **Step 5: Run both suites**

Run: `node usage-server/test/taskshtml.test.js && node usage-server/test/tasks-http.test.js`
Expected: PASS — `all passed` from both.

- [ ] **Step 6: Commit**

```bash
git add usage-server/taskshtml.js usage-server/server.js \
        usage-server/test/taskshtml.test.js usage-server/test/tasks-http.test.js
git commit -m "Show one project's tasks on the page, and refuse a bad escape with a 400"
```

---

### Task 5: Wire it into CI, the pre-push hook, and the docs

**Files:**
- Modify: `.github/workflows/tests.yml`
- Modify: `.githooks/pre-push`
- Modify: `usage-server/README.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: `usage-server/test/taskshtml.test.js` from Task 1.
- Produces: nothing new; the new suite becomes part of both gates.

**A suite that is not in CI is a suite that stops running.** This repo already
learned that the hard way: CI only triggered on `main` for a week, so nine
commits never met it.

- [ ] **Step 1: Add the suite to CI**

In `.github/workflows/tests.yml`, after the `task feed over http` step:

```yaml
      - name: task feed html
        run: node usage-server/test/taskshtml.test.js
```

- [ ] **Step 2: Add it to the pre-push hook**

In `.githooks/pre-push`, add to the suite list, keeping the cheapest-first
ordering (this one spawns no browser and no server, so it belongs beside the
other fast suites):

```sh
  usage-server/test/taskshtml.test.js \
```

- [ ] **Step 3: Document the route**

In `usage-server/README.md`, beside the existing `/usagehtml` entry, add a row
saying `/taskshtml` renders the task feed as a page and takes the same
`?project=<name>` as `/tasks`. Say in one clause that it is a diagnostic view of
the feed and not a copy of the widget — that sentence is what stops the next
person growing it into a second renderer.

- [ ] **Step 4: Close the TODO item**

In `TODO.md`, move the `- [ ]` item under Task Queue → Open to `- [x]`, keeping
the scope reasoning (the diagnostic-vs-mirror decision) as the record of why it
looks the way it does.

- [ ] **Step 5: Verify both gates actually run it**

```bash
sh .githooks/pre-push </dev/null
grep -c taskshtml .github/workflows/tests.yml
```

Expected: the hook lists `usage-server/test/taskshtml.test.js` among its ticks,
and the grep returns at least 1.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/tests.yml .githooks/pre-push \
        usage-server/README.md TODO.md
git commit -m "Put the new suite in both gates, and say what the page is for"
```

---

## Notes for whoever runs this

- **Do not add a dependency.** No templating library, no HTML builder. `esc()`
  plus string concatenation is the established idiom here and the reason this
  repo has no `package.json`.
- **The page has one job.** If you find yourself reproducing the widget's tabs,
  its paging, or its colour coding, stop — that is the mirror this plan
  explicitly rejects, and the TODO entry records why.
- **`/tasks` already carries the live block** that `/usage` computes, so
  sessions, workflows and subtasks need no extra work; Task 3 hands the same
  `live` object `/tasks` uses.
- **Check the fixtures against a live feed before trusting them.** Every shape in
  this plan was read from a running server on 2026-09-06. If `tasks.js` has
  moved since, the fixtures are the first thing to re-verify — a fixture that
  has drifted from the real payload makes a suite that passes and proves nothing.
