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

function relAge(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}

/* null is a real reading here, not missing data: a repo with no runs has never
   been run, and saying "never run" is the whole point - a fabricated age would
   be the panel claiming something it cannot support. */
function ago(ms) {
  return ms == null ? 'never run' : relAge(ms);
}

/* A running-table row's `since` can be null for a reason that has nothing to
   do with "never run": a holder comes from the mutex registry, which records
   no timestamp at all (tasks.js has no `at` for a holder), so a row that is
   running RIGHT NOW can still have since === null. Reusing ago()'s "never
   run" text here would tell the reader a thing that is running has never run
   - the exact misreading a "Running" table must not produce. */
function sinceOrUnknown(ms) {
  return ms == null ? 'unknown' : relAge(ms);
}

/* mutex.owner is the parsed contents of the owner file: {pid, host, cmd, at},
   an object - not a string. esc() on an object stringifies it via
   String(owner), which yields the literal text "[object Object]". Pull out
   the fields a human actually wants (which command, which pid, which host)
   instead of stringifying the object directly. */
function mutexOwnerLabel(owner) {
  if (owner == null) return '';
  if (typeof owner !== 'object') return String(owner);
  const parts = [];
  if (typeof owner.cmd === 'string') parts.push(owner.cmd);
  if (typeof owner.pid === 'number') parts.push('pid ' + owner.pid);
  if (typeof owner.host === 'string') parts.push(owner.host);
  return parts.join(' · ');
}

/* An alarm is {kind, repo, task, pid, pathCount, message} - an object, not a
   string. The naive `alarms.map(a => esc(a))` from the plan stringifies that
   object and renders the literal text "[object Object]". Every field here is
   free text from disk (repo names, task ids, the message itself) so each one
   gets its own esc(), not one esc() on the whole row. */
function alarmLine(a) {
  if (a == null) return '';
  const repo = esc(a.repo);
  const task = a.task ? ' · ' + esc(a.task) : '';
  const kind = a.kind ? ' <span class="muted">[' + esc(a.kind) + ']</span>' : '';
  const message = esc(a.message);
  return '<strong>' + repo + '</strong>' + task + kind + ': ' + message;
}

/* A holder whose pid is dead (orphan === true) is not doing any work - it is
   a stale claim that leaves its paths refused until someone reaps it. That is
   the same class of problem as a stale mutex, and for the same reason it must
   not be listed the way a live holder is: a reader seeing it unmarked would
   take it for something in progress. */
function holderState(r) {
  if (r.kind !== 'holder') return '';
  return r.orphan
    ? '<span class="warn">orphaned — pid ' + esc(r.pid) + ' is gone, paths refused</span>'
    : 'live';
}

/* A task from tasks.js's projectTasks() can be stuck for two DIFFERENT
   reasons that must not read alike: `blocked` is a human blocker (free text
   from the plan's blocked_on field - "waiting on a decision from someone"),
   `waitingOn` is an array of unmet dependency task ids (also free text - ids
   are author-chosen strings). `reason` explains a task the runner already
   finished but the plan has not caught up on yet. All three are free text
   from disk, so each gets its own esc() call rather than one esc() shared
   across the row - the mistake this repo's own history keeps finding. */
function taskStuckLabel(t) {
  const parts = [];
  if (t.blocked) parts.push(esc(t.blocked));
  if (Array.isArray(t.waitingOn) && t.waitingOn.length) {
    parts.push('waiting on ' + t.waitingOn.map(esc).join(', '));
  }
  if (t.reason) parts.push(esc(t.reason));
  return parts.join(' · ');
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

  const running = f.running || [];
  out += '<h2>Running</h2>' +
    (running.length
      ? table([
          { label: 'kind', get: r => esc(r.kind) },
          { label: 'repo', get: r => esc(r.repo) },
          { label: 'label', get: r => esc(r.label) },
          { label: 'detail', get: r => esc(r.detail) },
          { label: 'since', get: r => esc(sinceOrUnknown(r.since)) },
          { label: 'state', get: r => holderState(r) }
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
          { label: 'owner', get: r => esc(mutexOwnerLabel(r.mutex.owner)) },
          { label: 'since', get: r => esc(ago(r.mutex.since)) },
          { label: 'reason', get: r => esc(r.mutex.reason) }
        ], mutexRows)
      : '<p class="muted">no mutex held</p>');

  const alarms = f.alarms || [];
  out += '<h2>Alarms</h2>' +
    (alarms.length
      ? '<ul>' + alarms.map(a => '<li class="warn">' + alarmLine(a) + '</li>').join('') + '</ul>'
      : '<p class="muted">no alarms</p>');

  if (project) {
    out += '<h2>Project: ' + esc(project.project) + '</h2>';
    if (project.error) {
      out += '<p class="warn">' + esc(project.error) + '</p>';
    } else {
      const projectTasks = project.tasks || [];
      /* doneTotal/doneShown is stated because tasks.js TRIMS the closed list
         to DONE_MAX rows - reading the table as the whole queue is exactly
         the misreading this line exists to prevent, the same defect this
         repo has removed from other panels before. */
      out += '<p class="muted">' + num(project.doneTotal) + ' done in total, ' +
        num(project.doneShown) + ' of them shown below</p>' +
        (projectTasks.length
          ? table([
              { label: 'id', get: t => esc(t.id) },
              { label: 'title', get: t => esc(t.title) },
              { label: 'mode', get: t => esc(t.mode) },
              { label: 'model', get: t => esc(t.model) },
              { label: 'effort', get: t => esc(t.effort) },
              { label: 'lane', get: t => esc(t.lane) },
              { label: 'state', get: t => (t.state === 'blocked' || t.state === 'waiting')
                  ? '<span class="warn">' + esc(t.state) + '</span>' : esc(t.state) },
              { label: 'stuck on / reason', get: t => taskStuckLabel(t) }
            ], projectTasks)
          : '<p class="muted">no tasks</p>');
    }
  }

  return out + tail;
}

module.exports = { render };
