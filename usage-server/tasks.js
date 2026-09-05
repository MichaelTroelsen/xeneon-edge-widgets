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

/* Per-build read cache. `cache`, when a caller passes one, is a Map from
   absolute file path to { text } or { err } - built fresh by whoever starts a
   build (build() and projectTasks() below, and server.js's collectQueuedTasks,
   which shares one across its own readRepo() and readPlan() calls) and thrown
   away when that build finishes. whattask.json and runs.jsonl are each read
   from more than one place in a single build, and the files on disk change
   BETWEEN builds, ten seconds apart - a cache kept across builds would show a
   build a plan or a run log from before its own read, which is the same
   staleness doneIds() below exists to fix, one layer up. So there is no
   module-level default: no `cache` argument means no caching at all, one real
   read per call, which is what every caller not assembling a build already
   wants and gets today.

   `fileReadCount` is incremented on every actual disk read (a cache miss, or
   no cache at all) and never on a hit. It costs one integer add per read and
   production code never looks at it - exposed only so a test can assert "one
   read per file per build" without monkeypatching fs, the same shape
   `gitSpawnCount` further down already uses for the commit-time cache. */
let fileReadCount = 0;
function getFileReadCount() { return fileReadCount; }
function resetFileReadCount() { fileReadCount = 0; }

function readFileCached(cache, filePath) {
  if (cache && cache.has(filePath)) return cache.get(filePath);
  fileReadCount++;
  let result;
  try {
    result = { text: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    result = { err: err };
  }
  if (cache) cache.set(filePath, result);
  return result;
}

/* whattask.json, read and JSON.parsed once per (repoPath, cache) pair rather
   than once per call site: readRepo(), projectTasks() and server.js's
   collectQueuedTasks() all need the same plan and, within one build, are
   reading a file that cannot have changed between them. */
function readPlan(repoPath, cache) {
  const r = readFileCached(cache, whattaskFile(repoPath));
  if (r.err) return { tasks: [], closed: [], error: r.err };
  let plan;
  try {
    plan = JSON.parse(r.text);
  } catch (err) {
    return { tasks: [], closed: [], error: err };
  }
  return {
    tasks: (plan && Array.isArray(plan.tasks)) ? plan.tasks : [],
    closed: (plan && Array.isArray(plan.closed)) ? plan.closed : [],
    error: null
  };
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

/* The plan file lists what was open WHEN IT WAS WRITTEN. A runner that closes a
   task appends to runs.jsonl and does not rewrite the plan, so between a
   /runtask and the next /whattask the queue reads as larger than it is - the
   count says 18 while three of them are finished.
   Only `done` counts. `partial` is explicitly still open, which is the same
   rule the runners themselves apply when deciding whether a dependency is
   satisfied, so a task half-finished is not quietly retired here either. */
function doneIds(repoPath, cache) {
  const done = new Set();
  for (const run of readRuns(repoPath, cache).runs) {
    if (!run || typeof run.id !== 'string') continue;
    /* Append-only, so a later line supersedes an earlier one for the same id -
       a task can be recorded partial and then done, or done and then reopened. */
    if (run.outcome === 'done') done.add(run.id);
    else done.delete(run.id);
  }
  return done;
}

function readRepo(repo, cache) {
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
  const parsed = readPlan(repo.path, cache);
  if (parsed.error) {
    base.error = 'whattask.json could not be read: ' + parsed.error.message;
    return base;
  }
  const planned = parsed.tasks;
  const closed = parsed.closed;
  /* Finished since the plan was written, so not open however the file reads. */
  const finished = doneIds(repo.path, cache);
  const tasks = planned.filter(t => !(t && finished.has(t.id)));

  base.open = tasks.length;
  base.closed = closed.length;
  /* How many the plan still lists but a runner has already closed - the
     difference between the file and the truth, reported rather than hidden so
     a stale plan is visible instead of merely wrong. */
  base.doneSincePlan = planned.length - tasks.length;
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
function readRuns(repoPath, cache) {
  const r = readFileCached(cache, runsFile(repoPath));
  if (r.err) return { runs: [], error: null };   /* no runs yet is not a failure */
  const runs = [];
  for (const line of r.text.split('\n')) {
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
 * A commit's committer date is immutable once the object exists, so once a
 * repoPath+SHA pair has resolved to a time it never needs re-resolving. The
 * cache is keyed on the pair (not the SHA alone) since the same abbreviated
 * SHA could in principle mean different objects in different repos.
 *
 * Deliberately NOT caching misses: a SHA git doesn't know today (still being
 * pushed, or the object arrives after a rebase) must stay eligible to resolve
 * on a later rebuild, so unresolved SHAs are simply retried every call -
 * never written to the cache as a permanent negative.
 *
 * One `git cat-file --batch` process for the SHAs not already cached, not one
 * per record and not one per rebuild: 62 lines here carry only 23 distinct
 * heads, and re-resolving all of them every 10s would spawn git forever for
 * dates that can never change once cached. */
const commitTimeCache = new Map();
function cacheKey(repoPath, sha) { return repoPath + '\u0000' + sha; }

/* Exposed only so the test can assert "no git spawned" without monkeypatching
   child_process; production code never reads this. */
let gitSpawnCount = 0;

function commitTimes(repoPath, shas) {
  const unique = Array.from(new Set(shas.filter(s => typeof s === 'string' && s)));
  if (!unique.length) return { times: {}, error: null };

  const resolved = {};
  const toResolve = [];
  for (const sha of unique) {
    const key = cacheKey(repoPath, sha);
    if (commitTimeCache.has(key)) {
      resolved[sha] = commitTimeCache.get(key);
    } else {
      toResolve.push(sha);
    }
  }
  if (!toResolve.length) return { times: resolved, error: null };

  let out;
  try {
    gitSpawnCount++;
    out = execFileSync('git', ['cat-file', '--batch=%(objectname) %(objecttype)'], {
      cwd: repoPath,
      input: toResolve.join('\n') + '\n',
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
     resolved name it prefixes. Only resolved SHAs are cached - a miss is left
     uncached so the next call retries it. */
  for (const sha of toResolve) {
    let at = times[sha];
    if (at == null) {
      const full = Object.keys(times).find(f => f.startsWith(sha));
      if (full) at = times[full];
    }
    if (at != null) {
      commitTimeCache.set(cacheKey(repoPath, sha), at);
      resolved[sha] = at;
    }
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

/* 90 was WRONG, and wrong in an instructive way: it was "measured" by capping
   the titles at 90 and then reading back the longest, which is the cap
   measuring itself. The real distribution across all 210 open tasks is median
   79, p90 109, max 140 - so the old cap silently truncated about a third of
   them before the row ever saw the text.
   A row has 609px at the device slot, which fits roughly 80 characters, and
   CSS ellipsis already trims what does not fit. So the cap exists only to keep
   a pathological title out of the payload, and sits at the real maximum rather
   than below it: trimming in the feed throws away text the desktop dashboard
   has the width to show. A blocking reason IS a paragraph in these files, and
   the row has one line for it, so that cap is real. */
const TITLE_MAX = 140;
const BLOCKED_MAX = 110;

/* Done rows are history under the live queue. All 42 of SIDM2's would sit
   below 120 open ones, and the device slot shows FOUR rows - measured - so
   every one of them is unreachable there. The most recent handful is the part
   anyone reads; the count of the rest travels separately so the view can say
   how many it is not showing. Ordered by position in the closed array, which
   is appended to. */
const DONE_MAX = 10;

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
  /* This project's own build: whattask.json and runs.jsonl are each read once
     below (readPlan, then doneIds) rather than twice, and the cache is what
     would let a third read into either file, added later, share that read
     instead of costing a second one. Local to this call, thrown away when it
     returns - never kept across requests. */
  const cache = new Map();
  const parsed = readPlan(repo.path, cache);
  if (parsed.error) {
    return { project: name, tasks: [], error: 'whattask.json could not be read: ' + parsed.error.message };
  }
  const raw = parsed.tasks;
  const closed = parsed.closed;

  /* A holder names its task by the id the queue uses - verified against a real
     lock, where every holder's `task` matched an open task's id. A holder for a
     task the queue does not have adds no row: the lock is a claim about work,
     not a source of work. */
  const finishedSincePlan = doneIds(repo.path, cache);

  const held = new Set(readHolders(repo.path)
    .map(h => h && h.task)
    .filter(t => typeof t === 'string' && t));

  /* A task that depends on another OPEN task is not pickable, however ready it
     otherwise looks. Measured: 25 of 210 carry a depends_on and 20 of those
     name a task that is still open - so a fifth of what reads as "queued" is
     not actually available, and looked identical to what is. */
  const openIds = new Set(raw.map(t => t && t.id).filter(Boolean));

  function unmetDeps(t) {
    const deps = (t && Array.isArray(t.depends_on)) ? t.depends_on : [];
    return deps.filter(d => openIds.has(d));
  }

  const open = raw.map(t => {
    const waiting = unmetDeps(t);
    return {
      id: (t && t.id) || '',
      /* An id is a worse label than a title but a far better one than nothing,
         and every record has one. */
      title: clip((t && t.title) || (t && t.id) || '', TITLE_MAX) || '',
      mode: field(t, 'mode'),
      model: modelFamily(t && t.model),
      effort: field(t, 'effort'),
      lane: field(t, 'lane'),
      blocked: clip(t && t.blocked_on, BLOCKED_MAX),
      /* Running beats everything - it is a fact about now. Then a human
         blocker, then a dependency: both stop the task, but only one of them
         clears itself. */
      /* A task a runner has already finished is done, whatever the plan says.
         It sits above the closed-array rows and below the live ones, and its
         reason says the plan has not caught up rather than leaving the reader
         to wonder why a finished task is in the open list. */
      state: held.has(t && t.id) ? 'running'
        : (finishedSincePlan.has(t && t.id) ? 'done'
        : ((t && t.blocked_on) ? 'blocked'
        : (waiting.length ? 'waiting' : 'queued'))),
      /* 52 of 210 seize a stateful singleton and cannot be delegated to a
         subagent, which decides HOW the task can be run, not whether. */
      needsMain: !!(t && t.needs_main),
      waitingOn: waiting.length ? waiting : null,
      reason: finishedSincePlan.has(t && t.id)
        ? 'done in a run; the plan has not been rewritten yet' : null
    };
  });

  /* The closed array is a different shape - { id, title, closed_by, reason } -
     and was only ever counted before. It is listed now because a done task
     cannot be coloured differently from a queued one without being on screen.
     Its reason is short: 47 characters on average across the real corpus. */
  const finished = closed.slice(-DONE_MAX).reverse().map(t => ({
    id: (t && t.id) || '',
    title: clip((t && t.title) || (t && t.id) || '', TITLE_MAX) || '',
    mode: 'closed',
    model: 'unknown',
    effort: 'unknown',
    lane: 'unknown',
    blocked: null,
    state: 'done',
    needsMain: false,
    waitingOn: null,
    /* The reason if there is one, and otherwise the commit that closed it -
       which every record has, and which is the next most useful thing. */
    reason: clip(t && t.reason, BLOCKED_MAX) ||
      (t && t.closed_by ? 'closed by ' + t.closed_by : null)
  }));

  /* Running, then what is ready to be picked up, then what is stuck, then
     history. The order the reader cares about, not the order the file is in:
     blocked work sits below queued work because it is not actionable by the
     runner - it is waiting on a person, and grouping it just above the done
     rows keeps the actionable half of the list unbroken at the top. */
  const ORDER = { running: 0, queued: 1, blocked: 2, waiting: 3, done: 4 };

  /* Within the queued block only, most-startable first. The device slot shows
     FOUR rows, so the order of this block IS the interface - four arbitrary
     rows out of 147 is a worse answer than the four you could start now.
     Two keys, both grounded in the contention model rather than in taste:
       - delegable before main-only. 52 of 210 seize a stateful singleton, so
         picking one up costs the main session.
       - parallel before serial. A serial task waits on the lane; a parallel
         one can start beside whatever is already running.
       - and then cheapest first, on the same reading of "least friction".
     Measured over the 147 genuinely-queued tasks: 24 are delegable AND
     parallel, 83 delegable and serial, 40 main-only and serial.
     Zero for every other state, so this cannot reorder them; and the sort is
     stable, so file order survives as the tiebreak. */
  function startability(t) {
    if (t.state !== 'queued') return 0;
    return (t.needsMain ? 2 : 0) + (t.lane === 'serial' ? 1 : 0);
  }

  /* UNKNOWN SORTS LAST, and not because it is the largest bucket (65 of the
     147 queued tasks record no effort at all). The key is friction, and a task
     whose cost was never measured cannot claim a cheap slot on the strength of
     not having been measured - treating absent as "probably small" is exactly
     the inference the rest of this file refuses to make.
     Worth knowing what this does and does not change: every one of the 24
     delegable+parallel tasks is `medium`, so this reorders nothing the device
     slot shows. It orders the remainder, which is what the desktop dashboard
     scrolls through. */
  const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3 };

  function cost(t) {
    if (t.state !== 'queued') return 0;
    var rank = EFFORT_RANK[t.effort];
    return rank == null ? 4 : rank;
  }

  const tasks = open.concat(finished);
  tasks.sort((a, b) =>
    (ORDER[a.state] - ORDER[b.state]) ||
    (startability(a) - startability(b)) ||
    (cost(a) - cost(b)));

  return {
    project: name,
    tasks: tasks,
    /* How many were closed in total, against how many of them are listed - so
       the view can say what it is not showing rather than imply there is no
       more. */
    doneTotal: closed.length,
    doneShown: Math.min(closed.length, DONE_MAX),
    error: null
  };
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
  /* One cache for the whole build: whattask.json (inside readRepo, via
     readPlan) and runs.jsonl (inside readRepo's doneIds, and again below for
     datedHistory) are each read from two places here, and the files cannot
     change mid-build. Scoped to this call and discarded when it returns - the
     files DO change between builds, ten seconds apart, and a cache that
     outlived one build would show the next build a plan or a run log that is
     already stale, exactly what doneIds() above exists to prevent. */
  const cache = new Map();
  const repos = discover().map(repo => readRepo(repo, cache));
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

    const read = readRuns(repo.path, cache);
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

function getGitSpawnCount() { return gitSpawnCount; }
function resetCommitTimeCache() { commitTimeCache.clear(); gitSpawnCount = 0; }

module.exports = {
  REGISTRY_PATH, discover, readRepo, normalise, whattaskFile,
  runsFile, readRuns, commitTimes, datedHistory, readHolders, build,
  readFiles, readMutex, pidAlive, isOrphan, TASK_FILES, MUTEX_STALE_MS, THIS_HOST,
  projectTasks, TITLE_MAX, BLOCKED_MAX, DONE_MAX, doneIds,
  aggregateHistory, modelFamily, dayKey,
  getGitSpawnCount, resetCommitTimeCache,
  readPlan, getFileReadCount, resetFileReadCount
};
