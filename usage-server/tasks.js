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
 * the two nested under c64server/, and with them 122 of 210 open tasks.
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

/* The files /whattask, /runtask and the run commands keep in .claude/tasks/.
   serial.lock.d is deliberately not here: it is a DIRECTORY and the mutex, not
   a file, and it is reported separately. */
const TASK_FILES = [
  'whattask.json',    /* the queue itself - tasks (open) and closed */
  'runs.jsonl',       /* one appended line per run attempt */
  'serial.lock',      /* the registry of holder records */
  'decisions.jsonl',  /* answered questions, from /runhuman */
  'interview.json'    /* the open questions it works from */
];

const THIS_HOST = process.env.CLAUDE_TASKS_HOST || os.hostname();

/* A mutex is held for MILLISECONDS around one registry update, so minutes
   already mean something went wrong. LOCKING.md's own number, not a guess. */
const MUTEX_STALE_MS = 15 * 60 * 1000;

/* signal 0 does no killing - it only asks whether the pid can be signalled.
   ESRCH means no such process; EPERM means it exists and belongs to someone
   else, which is still alive. Cheaper than spawning a shell per pid, and this
   runs on every rebuild. */
function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

/* Whether a record's pid can be judged AT ALL. A pid on another host cannot be
   checked from here, so the answer is null - unknowable - and never false.
   LOCKING.md is explicit that such a record is always treated as live. */
function isOrphan(record) {
  if (!record || record.host !== THIS_HOST) return null;
  const alive = pidAlive(record.pid);
  if (alive === null) return null;
  return !alive;
}

function readFiles(repoPath) {
  const dir = path.join(repoPath, '.claude', 'tasks');
  const out = {};
  for (const name of TASK_FILES) {
    try {
      const st = fs.statSync(path.join(dir, name));
      out[name] = { present: true, bytes: st.size, mtime: st.mtimeMs };
    } catch (err) {
      /* Absence is real state - h2g has no serial.lock, claude-setup no
         runs.jsonl - so it is reported as absent rather than as zero bytes,
         which would read as an empty file that exists. */
      out[name] = { present: false, bytes: null, mtime: null };
    }
  }
  return out;
}

/* serial.lock.d/ is the actual mutex: a directory, created with mkdir because
   the check-and-create is atomic in the filesystem. Because it is held for
   milliseconds, a feed polling every ten seconds will essentially never catch
   it legitimately held - so in practice this reports a STUCK one. */
function readMutex(repoPath) {
  const dir = path.join(repoPath, '.claude', 'tasks', 'serial.lock.d');
  let st;
  try {
    st = fs.statSync(dir);
    if (!st.isDirectory()) return { held: false, stale: false, since: null, owner: null, reason: null };
  } catch (err) {
    return { held: false, stale: false, since: null, owner: null, reason: null };
  }

  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner'), 'utf8'));
  } catch (err) {
    owner = null;
  }

  /* "A reader can see the directory for a moment with no owner file in it -
     that is HELD by someone still starting up, not stale. Never treat a
     missing owner as an invitation to take the lock." Report it, do not
     conclude from it. */
  if (!owner || typeof owner !== 'object') {
    const age = Date.now() - st.mtimeMs;
    return {
      held: true, stale: false, since: st.mtimeMs, owner: null,
      reason: age > MUTEX_STALE_MS
        ? 'held with no readable owner file for ' + Math.round(age / 60000) +
          ' min - past the staleness window, but a missing owner is not proof of death; check it by hand'
        : 'held with no owner file yet - someone is still starting up'
    };
  }

  const at = Date.parse(owner.at);
  const age = Number.isNaN(at) ? null : Date.now() - at;
  const alive = owner.host === THIS_HOST ? pidAlive(owner.pid) : null;

  /* BOTH conditions, and neither alone is enough: the pid is dead on this
     machine, AND the recorded time is past the window. A live pid is never
     stale at any age - that is a hung run and a question for the human. */
  const stale = alive === false && age !== null && age > MUTEX_STALE_MS;

  let reason = null;
  if (stale) {
    reason = 'pid ' + owner.pid + ' is not running and the lock is ' +
      Math.round(age / 60000) + ' min old (over 15 min)';
  } else if (alive === true && age !== null && age > MUTEX_STALE_MS) {
    reason = 'pid ' + owner.pid + ' is alive and has held this for ' +
      Math.round(age / 60000) + ' min - a hung run, not a stale lock';
  } else if (alive === null) {
    reason = 'held by ' + owner.host + ', which cannot be checked from here';
  }

  return { held: true, stale: stale, since: Number.isNaN(at) ? st.mtimeMs : at,
           owner: owner, reason: reason };
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
    holders: readHolders(repo.path),
    files: readFiles(repo.path),
    mutex: readMutex(repo.path),
    lastRunAt: null,
    error: null
  };
  try {
    base.lastRunAt = fs.statSync(runsFile(repo.path)).mtimeMs;
  } catch (err) {
    base.lastRunAt = null;
  }
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
   `head` is a commit SHA, so the commit's own date is the closest honest time
   available, and it travels labelled as such (atSource: "commit") so a view
   never presents it as when the run happened.
 *
 * One `git cat-file --batch` process for the whole set, not one per record:
 * 62 lines here carry only 23 distinct heads, and spawning git per line would
 * cost seconds on every rebuild. */
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
     carries "committer <name> <email> <epoch> <tz>". Parse the epoch out of it
     rather than shelling out again per SHA. A name git does not know comes
     back as "<name> missing", whose type is not "commit" and is skipped. */
  const times = {};
  let current = null;
  for (const line of out.split('\n')) {
    const header = /^([0-9a-f]{40}) (\S+)$/.exec(line);
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
  /* Records carry abbreviated heads (7 characters, as git log --oneline
     prints them) but --batch echoes the FULL objectname, so a lookup by the
     requested key alone finds nothing. Map each requested SHA onto whichever
     resolved name it prefixes. */
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

/* Measured, not chosen by eye: 90 is the longest title in the real queues, and
   a blocking reason is a paragraph there - the glass has one line for it. */
const TITLE_MAX = 90;
const BLOCKED_MAX = 110;

function clip(value, max) {
  if (typeof value !== 'string' || !value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/* One project's open tasks, trimmed to what a row actually draws.
 *
 * Its own call rather than a block inside build(): the five real queues hold
 * 210 tasks and 297KB, of which 295KB is prose - verify, why_model, why_lane,
 * evidence - that cannot be shown on an 840x344 slot at any size. Trimmed they
 * are still 49KB, twenty times the whole overview payload, and the widget only
 * ever looks at one project at a time. So the overview stays 2.4KB and this is
 * fetched on demand.
 */
function projectTasks(name) {
  const repo = discover().find(r => r.name === name);
  if (!repo) {
    return {
      project: name, tasks: [],
      error: 'no project called "' + name + '" has a .claude/tasks/whattask.json'
    };
  }
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(whattaskFile(repo.path), 'utf8'));
  } catch (err) {
    return { project: name, tasks: [], error: 'whattask.json could not be read: ' + err.message };
  }
  const raw = (plan && Array.isArray(plan.tasks)) ? plan.tasks : [];
  const tasks = raw.map(t => ({
    id: (t && t.id) || '',
    /* An id is a worse label than a title but a far better one than nothing,
       and every record has one. */
    title: clip((t && t.title) || (t && t.id) || '', TITLE_MAX) || '',
    mode: field(t, 'mode'),
    model: modelFamily(t && t.model),
    effort: field(t, 'effort'),
    lane: field(t, 'lane'),
    blocked: clip(t && t.blocked_on, BLOCKED_MAX)
  }));
  return { project: name, tasks: tasks, error: null };
}

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
/* The LOCAL calendar date, which is the one the heatmap is drawn on and the
   one the person reading the display is living in. The server and the display
   are the same machine, so there is no timezone to reconcile. */
function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/* The widget only ever aggregates the run records, so they are aggregated once
   here rather than shipped whole for the device to re-bucket on every refresh:
   605 records is ~75KB of the payload and collapses to a few hundred bytes.
   Every tally enumerates what it finds - the real corpus names five outcomes
   (done, partial, blocked, failed, inconclusive), not the two the icue repo
   alone shows, and a fixed pair would hide 41 records. */
/* `model` is FREE TEXT, not an enumeration. Measured across the real corpus:
   16 distinct values, of which 12 are one-off sentences - "opus (recorded) /
   ran on Fable 5, which sits above Opus - substitution stated before work
   began, not a downgrade" is a single record's value. Tallying the raw strings
   puts a paragraph where a model name belongs, so each is reduced to the
   family it names. Anything that names no known family is grouped rather than
   guessed at. */
const MODEL_FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

function modelFamily(value) {
  if (typeof value !== 'string' || !value) return 'unknown';
  const lower = value.toLowerCase();
  const head = MODEL_FAMILIES.find(f => lower.startsWith(f));
  if (head) return head;
  const anywhere = MODEL_FAMILIES.find(f => lower.includes(f));
  return anywhere || (lower === 'unknown' ? 'unknown' : 'other');
}

function aggregateHistory(records) {
  const days = {};
  const outcome = {};
  const model = {};
  const effort = {};
  for (const r of records) {
    const key = dayKey(r.at);
    days[key] = (days[key] || 0) + 1;
    outcome[r.outcome] = (outcome[r.outcome] || 0) + 1;
    const family = modelFamily(r.model);
    model[family] = (model[family] || 0) + 1;
    effort[r.effort] = (effort[r.effort] || 0) + 1;
  }
  const keys = Object.keys(days).sort();
  return {
    runs: records.length,
    days: days,
    outcome: outcome,
    model: model,
    effort: effort,
    span: { from: keys[0] || null, to: keys[keys.length - 1] || null }
  };
}

function build(live, opts) {
  const repos = discover().map(readRepo);
  const totals = {
    open: 0, closed: 0, repos: repos.length, blocked: 0, byMode: {}
  };
  const running = [];
  const alarms = [];
  let history = [];

  for (const repo of repos) {
    totals.open += repo.open;
    totals.closed += repo.closed;
    totals.blocked += repo.blocked;
    mergeCounts(totals.byMode, repo.byMode);

    /* MEASURED against a real lock rather than assumed from LOCKING.md's
       example: a registry record is { task, head, touches, pid, host }. It
       carries NO timestamp - the mutex owner file has an `at`, the registry
       records do not - so a holder has no age to show, and claiming one would
       be inventing it. `touches` is the path list; the earlier guess of
       `paths` came from the owner file's shape and matched nothing.
       The count leads, because the joined list is long enough to be
       ellipsised away and the number of locked paths is the part that must
       survive truncation. */
    for (const holder of repo.holders) {
      const touches = Array.isArray(holder.touches) ? holder.touches
        : (Array.isArray(holder.paths) ? holder.paths : []);
      const detail = touches.length
        ? touches.length + (touches.length === 1 ? ' path' : ' paths') + ' · ' + touches.join(', ')
        : '';
      const label = holder.task || holder.cmd || holder.run || 'a held task';
      const orphan = isOrphan(holder);
      running.push({
        kind: 'holder',
        label: label,
        repo: repo.name,
        since: toMs(holder.at),
        head: typeof holder.head === 'string' ? holder.head : null,
        pid: typeof holder.pid === 'number' ? holder.pid : null,
        host: typeof holder.host === 'string' ? holder.host : null,
        orphan: orphan,
        pathCount: touches.length,
        detail: detail
      });
      /* The failure nothing else on this machine surfaces. A registry record
         outlives the mutex by design, so a session that dies holding one
         leaves no trace on the mutex path - and every path it names is
         refused for every later run until someone reaps it. */
      if (orphan === true) {
        alarms.push({
          kind: 'orphan',
          repo: repo.name,
          task: label,
          pid: holder.pid,
          pathCount: touches.length,
          message: 'pid ' + holder.pid + ' is not running, so ' + touches.length +
            (touches.length === 1 ? ' path stays' : ' paths stay') + ' refused until it is reaped'
        });
      }
    }

    if (repo.mutex.stale) {
      alarms.push({
        kind: 'stale-mutex',
        repo: repo.name,
        task: (repo.mutex.owner && repo.mutex.owner.cmd) || 'unknown',
        pid: repo.mutex.owner ? repo.mutex.owner.pid : null,
        pathCount: 0,
        message: repo.mutex.reason
      });
    }

    const read = readRuns(repo.path);
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

  const payload = {
    generatedAt: Date.now(),
    repos: repos,
    totals: totals,
    running: running,
    alarms: alarms,
    history: aggregateHistory(history),
    unavailable: repos.length ? null
      : 'no repo on this machine has a .claude/tasks/whattask.json - run /whattask in one to create a queue'
  };
  /* Aggregating is not a one-way door: the records that went into it stay
     reachable behind an argument, for the debug page and for anyone checking
     the arithmetic. */
  if (opts && opts.raw) payload.historyRecords = history;
  return payload;
}

module.exports = {
  REGISTRY_PATH, discover, readRepo, normalise, whattaskFile,
  runsFile, readRuns, commitTimes, datedHistory, readHolders, build,
  readFiles, readMutex, pidAlive, isOrphan, TASK_FILES, MUTEX_STALE_MS, THIS_HOST,
  projectTasks, TITLE_MAX, BLOCKED_MAX,
  aggregateHistory, modelFamily, dayKey
};
