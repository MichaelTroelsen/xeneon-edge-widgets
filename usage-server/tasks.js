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
  aggregateHistory, modelFamily, dayKey
};
