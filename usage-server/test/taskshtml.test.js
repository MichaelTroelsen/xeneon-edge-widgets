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
{
  /* THE ERROR COLUMN IS FREE TEXT FROM DISK TOO - it carries repo paths and
     parse output - and it was rendered UNASSERTED: every fixture above has
     error null, so dropping esc() from that column produced zero failures.
     Escaping proven on one field and assumed on its neighbour is the shape this
     repo keeps finding, so the second field gets its own case rather than
     riding on the first. */
  const f = feedFixture();
  f.repos[1].error = '<img src=x onerror=alert(2)>';
  const html = taskshtml.render(f, null);
  check('a repo ERROR carrying markup is escaped as well as the name',
    html.indexOf('<img src=x') === -1, true);
  check('and the error text still reaches the page',
    /&lt;img src=x/.test(html), true);
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

/* Real shapes below are copied from a live `/tasks` fetch on 2026-09-06, plus
   the alarm/holder-building code in tasks.js (build(), readMutex()) - NOT from
   the plan's fixtures, which use the wrong shape for `alarms` (strings, not
   objects) and for `running` (kinds session/workflow/subtask only, no
   `holder`, and an assumption that `since` is always a timestamp). */

console.log('the running block:');
{
  const f = feedFixture();
  f.running = [
    { kind: 'holder', label: 'taskshtml-running-mutex-alarms', repo: 'icue',
      since: Date.now() - 120000, head: 'b543fc1', pid: 53076, host: 'TDZDesktop',
      orphan: false, pathCount: 2, detail: '2 paths · rw:usage-server/taskshtml.js' },
    { kind: 'session', label: '/mit-setup:whattask', repo: 'setup',
      since: Date.now() - 30000, detail: '' }
  ];
  const html = taskshtml.render(f, null);
  check('both running rows appear',
    /taskshtml-running-mutex-alarms/.test(html) && /mit-setup:whattask/.test(html), true);
  check('the kind is shown, so a holder is not read as a session',
    /holder/.test(html) && /session/.test(html), true);
  check('an age is shown rather than a raw epoch',
    /\b2m ago\b/.test(html), true);
}

console.log('an orphaned holder is not a live one:');
{
  /* Real orphan row, from a live /tasks fetch: since is null (the mutex
     registry records no timestamp for a holder at all) and orphan is true
     (its pid is dead). A live holder, right beside it, has a real since and
     orphan: false - the two must not read alike. */
  const f = feedFixture();
  f.running = [
    { kind: 'holder', label: 'locking-md-reap-section-names-two-different-liveness-probes',
      repo: 'claude-setup', since: null, head: 'b543fc1', pid: 865, host: 'TDZDesktop',
      orphan: true, pathCount: 8, detail: '8 paths · rw:plugins/mit-setup/LOCKING.md' },
    { kind: 'holder', label: 'a live holder', repo: 'icue', since: Date.now() - 60000,
      head: null, pid: 53076, host: 'TDZDesktop', orphan: false, pathCount: 2, detail: '' }
  ];
  const html = taskshtml.render(f, null);
  /* Scoped to the Running section, not the whole page: this fixture's icue
     repo legitimately has never run, so the Repos table says "never run" too
     - that is correct there and would be a false failure if checked globally. */
  const runningSection = html.slice(html.indexOf('<h2>Running</h2>'), html.indexOf('<h2>Mutex</h2>'));
  check('a running row with a null since is never reported as "never run"',
    /never run/i.test(runningSection), false);
  check('and it says something else instead, such as unknown',
    /unknown/i.test(runningSection), true);
  check('the orphaned holder is marked as orphaned',
    /orphan/i.test(runningSection), true);
  check('the live holder is not marked the same way as the orphan one',
    (runningSection.match(/orphan/gi) || []).length, 1);
}

console.log('running rows are escaped too:');
{
  /* label/repo/detail are free text from the registry, same as the repo name
     and error columns above - each gets its own case rather than riding on
     the coverage of a sibling field. */
  const f = feedFixture();
  f.running = [
    { kind: 'holder', label: '<b>lbl</b>', repo: '<i>rpo</i>', since: null,
      head: null, pid: 1, host: 'h', orphan: false, pathCount: 0, detail: '<u>dtl</u>' }
  ];
  const html = taskshtml.render(f, null);
  check('label, repo and detail on a running row are all escaped',
    html.indexOf('<b>lbl</b>') === -1 &&
    html.indexOf('<i>rpo</i>') === -1 &&
    html.indexOf('<u>dtl</u>') === -1, true);
}

console.log('a stale mutex, in the real shape:');
{
  /* mutex.owner is {pid, host, cmd, at} (an object), read straight from
     readMutex() in tasks.js - not the plain string the plan's fixture used. */
  const f = feedFixture();
  f.repos[0].mutex = {
    held: true, stale: true, since: Date.now() - 3600000,
    owner: { pid: 999, host: 'TDZDesktop', cmd: '/runqueue',
             at: new Date(Date.now() - 3600000).toISOString() },
    reason: 'pid 999 is not running and the lock is 60 min old (over 15 min)'
  };
  const html = taskshtml.render(f, null);
  const mutexSection = html.slice(html.indexOf('<h2>Mutex</h2>'), html.indexOf('<h2>Alarms</h2>'));
  check('a held mutex reports its owner', /runqueue/.test(mutexSection), true);
  check('the owner object never leaks as [object Object]',
    /\[object Object\]/.test(mutexSection), false);
  check('a STALE mutex is marked, not just reported as held', /stale/i.test(mutexSection), true);
  check('the reason is shown', /60 min old/.test(mutexSection), true);
}

console.log('an alarm, in the real shape:');
{
  /* Real orphan alarm, read from a live /tasks fetch: {kind, repo, task, pid,
     pathCount, message} - an object, not the plan's fixture string
     'SIDM2: mutex held for 60m'. Its message text is deliberately distinct
     from anything used in the mutex fixtures above, so a check that matches
     it cannot pass by accident against unrelated markup elsewhere on the page. */
  const f = feedFixture();
  f.alarms = [
    { kind: 'orphan', repo: 'claude-setup',
      task: 'locking-md-reap-section-names-two-different-liveness-probes',
      pid: 865, pathCount: 8,
      message: 'pid 865 is not running, so 8 paths stay refused until it is reaped' }
  ];
  const html = taskshtml.render(f, null);
  const alarmsSection = html.slice(html.indexOf('<h2>Alarms</h2>'));
  check('the alarm message is shown', /stay refused until it is reaped/.test(alarmsSection), true);
  check('the alarm names which repo is alarming', /claude-setup/.test(alarmsSection), true);
  check('and it is marked as a warning',
    /class="warn"[^>]*>(?:(?!<\/li>)[\s\S])*stay refused until it is reaped/.test(alarmsSection), true);
}

console.log('a held-but-not-stale mutex does not carry the stale warning:');
{
  /* The discrimination that matters, proven in both directions: a stale
     mutex is marked (above) and an ordinary held one is not (here). A renderer
     that prints 'held' unconditionally would still pass the check above's
     substring test by accident if this case were missing - this is the case
     that catches it. */
  const f = feedFixture();
  f.repos[0].mutex = {
    held: true, stale: false, since: Date.now() - 60000,
    owner: { pid: 111, host: 'TDZDesktop', cmd: '/runtask',
             at: new Date().toISOString() },
    reason: null
  };
  const html = taskshtml.render(f, null);
  check('a held-not-stale mutex is reported', /runtask/.test(html), true);
  check('and does not carry the stale warning',
    /class="warn">stale/i.test(html), false);
}

console.log('alarm fields are escaped too:');
{
  const f = feedFixture();
  f.alarms = [
    { kind: '<script>k</script>', repo: '<script>r</script>',
      task: '<script>t</script>', pid: 1, pathCount: 1,
      message: '<script>m</script>' }
  ];
  const html = taskshtml.render(f, null);
  check('every alarm field carrying markup is escaped, not just one of them',
    html.indexOf('<script>k') === -1 &&
    html.indexOf('<script>r') === -1 &&
    html.indexOf('<script>t') === -1 &&
    html.indexOf('<script>m') === -1, true);
}

console.log('the quiet case:');
{
  const html = taskshtml.render(feedFixture(), null);
  check('nothing running says so rather than drawing an empty table',
    /nothing running/i.test(html), true);
  check('no mutex held is reported when none is', /no mutex held/i.test(html), true);
  check('no alarms says so too', /no alarms/i.test(html), true);
}

console.log('every kind the feed can emit:');
{
  /* tasks.js emits FOUR running kinds - holder (:802), session (:849),
     workflow (:853) and subtask (:857) - but only holder and session are in the
     live feed on an ordinary day, so a fixture built by reading that feed covers
     half of them. The table is kind-agnostic today and all four render; this
     pins that. It matters because the file now special-cases holder to mark
     orphans, and the obvious next edit is an if/else chain on kind that quietly
     drops the two nobody ever sees. */
  const f = feedFixture();
  f.running = [
    { kind: 'holder', label: 'H-row', repo: 'a', since: null, detail: '', orphan: false, pid: 1, host: 'x' },
    { kind: 'session', label: 'S-row', repo: 'a', since: Date.now() - 60000, detail: '' },
    { kind: 'workflow', label: 'W-row', repo: 'a', since: Date.now() - 60000, detail: '' },
    { kind: 'subtask', label: 'T-row', repo: 'a', since: Date.now() - 60000, detail: '' }
  ];
  const html = taskshtml.render(f, null);
  const missing = ['H-row', 'S-row', 'W-row', 'T-row'].filter(function (l) {
    return html.indexOf(l) === -1;
  });
  check('all four running kinds reach the page, not just the two the feed shows today',
    missing, []);
}

console.log('no project means no project section:');
{
  const html = taskshtml.render(feedFixture(), null);
  check('nothing project-shaped appears when no project was requested',
    /<h2>Project:/.test(html), false);
}

console.log('a single project, in the real shape:');
{
  /* Task shape read from a live /tasks?project=icue fetch on 2026-09-06:
     `blocked` is the blocked_on TEXT (or null), not a boolean, and
     `waitingOn` is an ARRAY of dependency task ids (or null) - not the single
     string 'a decision' the plan's own fixture used. Both drifted the same
     way `alarms` and `mutex.owner` did earlier in this feature, so this
     fixture follows tasks.js's projectTasks() rather than the plan. */
  const project = {
    project: 'icue',
    tasks: [
      { id: 'a-task', title: 'A thing to do', mode: 'subtask', model: 'sonnet',
        effort: 'low', lane: 'parallel', blocked: null, state: 'queued',
        needsMain: false, waitingOn: null, reason: null },
      { id: 'human-blocked-task', title: 'Waiting on a human', mode: 'requires-user',
        model: 'sonnet', effort: 'low', lane: 'serial', blocked: 'a decision',
        state: 'blocked', needsMain: true, waitingOn: null, reason: null },
      { id: 'dep-blocked-task', title: 'Waiting on another task', mode: 'subtask',
        model: 'sonnet', effort: 'low', lane: 'serial', blocked: null,
        state: 'waiting', needsMain: false, waitingOn: ['a-task'], reason: null }
    ],
    doneTotal: 87, doneShown: 5, error: null
  };
  const html = taskshtml.render(feedFixture(), project);
  const projectSection = html.slice(html.indexOf('<h2>Project:'));
  check('the project name is shown', /icue/.test(projectSection), true);
  check('every task id appears',
    /a-task/.test(projectSection) && /human-blocked-task/.test(projectSection) &&
    /dep-blocked-task/.test(projectSection), true);
  check('a human-blocked task says what it is waiting on, not just that it is blocked',
    /a decision/.test(projectSection), true);
  check('a dependency-blocked task names the dependency, not just the state',
    /waiting on[^<]*a-task/.test(projectSection), true);
  check('the total done count is shown so the list is not read as the whole queue',
    /\b87\b/.test(projectSection), true);
  check('and how many of them are shown right now is stated alongside it',
    /\b5\b/.test(projectSection), true);
}

console.log('a stuck task state is marked as a warning, a ready one is not:');
{
  /* Proven in both directions, same discipline as the mutex stale/held pair
     above: a renderer that marks EVERY state as a warning would still pass a
     check that only looks for the positive case. */
  const project = {
    project: 'icue',
    tasks: [
      { id: 'ready', title: 'Ready to go', mode: 'subtask', model: 'sonnet',
        effort: 'low', lane: 'parallel', blocked: null, state: 'queued',
        needsMain: false, waitingOn: null, reason: null },
      { id: 'stuck', title: 'Stuck', mode: 'requires-user', model: 'sonnet',
        effort: 'low', lane: 'serial', blocked: 'a decision', state: 'blocked',
        needsMain: true, waitingOn: null, reason: null }
    ],
    doneTotal: 0, doneShown: 0, error: null
  };
  const html = taskshtml.render(feedFixture(), project);
  const projectSection = html.slice(html.indexOf('<h2>Project:'));
  check('the blocked state is marked as a warning',
    /class="warn">blocked</.test(projectSection), true);
  check('the queued state is not marked the same way',
    /class="warn">queued</.test(projectSection), false);
}

console.log('project task fields are escaped:');
{
  const project = {
    project: 'icue',
    tasks: [
      { id: '<i>id</i>', title: '<b>title</b>', mode: 'subtask', model: 'sonnet',
        effort: 'low', lane: 'parallel', blocked: '<u>blocked</u>', state: 'blocked',
        needsMain: false, waitingOn: ['<mark>dep</mark>'], reason: '<s>reason</s>' }
    ],
    doneTotal: 1, doneShown: 1, error: null
  };
  const html = taskshtml.render(feedFixture(), project);
  const projectSection = html.slice(html.indexOf('<h2>Project:'));
  check('the task title is escaped', projectSection.indexOf('<b>title</b>') === -1, true);
  check('and its text still reaches the page', /&lt;b&gt;title&lt;\/b&gt;/.test(projectSection), true);
  check('the done-reason text is escaped', projectSection.indexOf('<s>reason</s>') === -1, true);
  check('and its text still reaches the page too', /&lt;s&gt;reason&lt;\/s&gt;/.test(projectSection), true);
  check('the task id is escaped', projectSection.indexOf('<i>id</i>') === -1, true);
  check('the blocked reason is escaped', projectSection.indexOf('<u>blocked</u>') === -1, true);
  check('a waitingOn dependency id is escaped', projectSection.indexOf('<mark>dep</mark>') === -1, true);
}

console.log('a project with no tasks at all:');
{
  const html = taskshtml.render(feedFixture(),
    { project: 'quiet-repo', tasks: [], doneTotal: 0, doneShown: 0, error: null });
  const projectSection = html.slice(html.indexOf('<h2>Project:'));
  check('an empty task list says so rather than drawing an empty table',
    /no tasks/i.test(projectSection), true);
  check('and does not draw an empty table for it',
    /<table/.test(projectSection), false);
}

console.log('a project that failed to read:');
{
  /* Matches the real error shape from tasks.js's projectTasks(): only
     {project, tasks: [], error} - no doneTotal/doneShown keys at all, since
     the error branch returns before either is computed. */
  const html = taskshtml.render(feedFixture(),
    { project: 'broken', tasks: [], error: 'whattask.json could not be read: quota exceeded' });
  const projectSection = html.slice(html.indexOf('<h2>Project:'));
  check('the error is shown rather than an empty task list',
    /could not be read/.test(projectSection), true);
  check('and does not draw an empty table for it',
    /<table/.test(projectSection), false);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
