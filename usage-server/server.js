#!/usr/bin/env node
/* Claude Code usage feed for the Xeneon Edge widget.
 *
 * An iCUE widget is a sandboxed web page: it cannot read files or run commands.
 * This serves everything it needs as JSON on 127.0.0.1.
 *
 * The activity data - sessions, workflows, subtasks, token counts - is derived
 * from files Claude Code already writes under ~/.claude and never leaves the
 * machine. The two usage percentages cannot be derived locally, so those are
 * fetched from Anthropic with the OAuth token in ~/.claude/.credentials.json;
 * see official.js and the Authentication section of README.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const usagehtml = require('./usagehtml');
const official = require('./official');
const statusline = require('./statusline');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
/* Overridable so the detection can be tested against a fixture tree instead of
   the real one. Without this the only way to exercise the live-run path is to
   actually run agents - which costs real tokens, takes minutes, and briefly
   puts fabricated rows on the user's screen if the fixtures go in the real
   directory. Unset in normal use. */
const PROJECTS_DIR = process.env.CLAUDE_USAGE_PROJECTS_DIR ||
  path.join(CLAUDE_DIR, 'projects');
const CONFIG_PATH = path.join(__dirname, 'limits.json');

const WINDOW_DAYS = 8;                       /* transcripts older than this are ignored */
const SESSION_BLOCK_MS = 5 * 60 * 60 * 1000; /* the "current session" is a 5-hour block */
const REFRESH_MS = 20000;                    /* how often the index is rebuilt */
const MAX_WORKFLOWS = 24;
const MAX_SUBTASKS = 40;
const MAX_SESSIONS = 20;
const SESSION_ACTIVE_MS = 15 * 60 * 1000; /* a session is "live" if it spoke this recently */

/* The activity lists show what is running now, not a history of what ran. A
   finished run is not activity, and a list of six-day-old completed workflows
   told you nothing about the machine in front of you.

   Terminal states are matched by name rather than "running" by name, so a
   status this code has never seen is treated as still in flight and shows up,
   instead of being silently dropped. Every wf_*.json on the machine this was
   written against had status "completed" and every step was "done" or "error",
   so the in-flight spellings are unverified - erring toward showing an unknown
   state is the safer direction of the two. */
const FINISHED_WORKFLOW = new Set([
  'completed', 'complete', 'done', 'finished', 'failed', 'error', 'errored',
  'cancelled', 'canceled', 'aborted', 'stopped', 'timeout', 'timed_out'
]);
const FINISHED_TASK = new Set([
  'done', 'complete', 'completed', 'error', 'errored', 'failed', 'cancelled',
  'canceled', 'skipped', 'stopped', 'timeout', 'timed_out'
]);
/* A crashed run can leave a non-terminal status on disk forever. Requiring the
   file to have been touched recently bounds that, at the cost of hiding a run
   whose file goes untouched for longer than this - workflows here have taken
   minutes, so the trade favours not showing a ghost as live. */
const WORKFLOW_ACTIVE_MS = 60 * 60 * 1000;
/* How long a transcript directory with unfinished agents keeps counting as a
   live run. Long enough for a slow agent, short enough that a killed run stops
   being advertised as running. */
const LIVE_RUN_STALE_MS = 15 * 60 * 1000;

let config = null;
let configMtime = 0;

/* Per-file cursor so a rebuild only parses bytes that are new. Transcript files
   run to hundreds of KB each and there are hundreds of them. */
const fileState = new Map(); /* path -> { size, mtime, records: [] } */

let snapshot = null;
let lastQuota = null; /* most recent 429 quotaLimits record seen, if any */

/* Anthropic's own figures, refreshed on their own slower timer. The index
   rebuilds every 20s but this is an undocumented endpoint on someone else's
   server, so it is polled far less often and always from cache in between. */
/* Twelve minutes. One-minute polling drew a 429 within the hour, and the budget
   is shared: the AI Limits Stream Deck plugin polls the same endpoint every two
   minutes on this machine, so anything here adds to that rather than being
   measured on its own. Utilisation moves slowly and reset times are absolute
   timestamps rendered locally, so a longer interval costs the display nothing.
   */
const OFFICIAL_INTERVAL_MS = 12 * 60 * 1000;
const OFFICIAL_MAX_BACKOFF_MS = 30 * 60 * 1000;
/* A rate limit deserves a bigger first step than an ordinary failure, and its
   own ceiling: these windows are commonly hourly, and a 30-minute retry that
   keeps landing inside the window just keeps the penalty alive. */
const OFFICIAL_RATE_LIMIT_MS = 15 * 60 * 1000;
const OFFICIAL_RATE_LIMIT_MAX_MS = 60 * 60 * 1000;
/* Past this, a cached reading stops being worth showing. Comfortably longer
   than the poll interval so an ordinary miss never drops the display to LOCAL. */
const OFFICIAL_STALE_MS = 45 * 60 * 1000;

let officialState = { ok: false, error: 'not fetched yet', fetchedAt: null };
let officialGood = null;   /* last successful reading, kept across failures */
let officialInFlight = false;
let officialFailures = 0;
let officialTimer = null;

/* Retrying a dead token every minute is how a 401 turns into a 429 — which is
   exactly what happened. Failures back off exponentially to half an hour;
   success returns to the normal cadence. */
function scheduleOfficial(rateLimited, retryAfterMs) {
  if (officialTimer) clearTimeout(officialTimer);
  let delay;
  /* If the server said when to come back, believe it over any local guess. */
  if (retryAfterMs) {
    officialTimer = setTimeout(refreshOfficial, retryAfterMs + 5000);
    if (officialTimer.unref) officialTimer.unref();
    return;
  }
  if (officialFailures === 0) {
    delay = OFFICIAL_INTERVAL_MS;
  } else if (rateLimited) {
    delay = Math.min(OFFICIAL_RATE_LIMIT_MS * officialFailures, OFFICIAL_RATE_LIMIT_MAX_MS);
  } else {
    delay = Math.min(OFFICIAL_INTERVAL_MS * Math.pow(2, officialFailures), OFFICIAL_MAX_BACKOFF_MS);
  }
  officialTimer = setTimeout(refreshOfficial, delay);
  if (officialTimer.unref) officialTimer.unref();
}

function refreshOfficial() {
  if (officialInFlight) return;
  officialInFlight = true;
  let rateLimited = false;
  let retryAfterMs = null;
  official.fetchOfficial()
    .then(result => {
      officialState = result;
      officialFailures = result.ok ? 0 : officialFailures + 1;
      rateLimited = !result.ok && /HTTP 429/.test(result.error || '');
      retryAfterMs = result.retryAfterMs || null;
      /* Keep the last good reading. Utilisation only climbs within a window and
         the reset times are absolute, so a few-minute-old figure is far better
         than dropping to a different metric because one poll was throttled. */
      if (result.ok) officialGood = result;
    })
    .catch(err => {
      officialState = { ok: false, error: String(err && err.message || err), fetchedAt: Date.now() };
      officialFailures++;
    })
    .then(() => {
      officialInFlight = false;
      scheduleOfficial(rateLimited, retryAfterMs);
    });
}

/* The OAuth endpoint's reading, or the most recent good one flagged as stale. */
function officialFromApi(now) {
  if (officialState.ok) return officialState;
  if (officialGood && (now - officialGood.fetchedAt) < OFFICIAL_STALE_MS) {
    return Object.assign({}, officialGood, {
      stale: true,
      staleSince: officialGood.fetchedAt,
      error: officialState.error || null
    });
  }
  return null;
}

/* What the snapshot should carry: whichever of the two paths to Anthropic's
   own figures answered most recently, and only the failure itself if neither
   did.

   Two paths, because they fail in opposite conditions. The OAuth endpoint
   answers whether or not anyone is using Claude Code, but is throttled hard
   enough that a 429 can persist for hours. The statusline costs no request and
   so cannot be throttled, but only updates while a session is rendering one.
   Between them something is usually current, and preferring the newer reading
   needs no rule about which source is better. */
function officialForSnapshot(now) {
  const fromStatusline = statusline.read(now);
  const fromApi = officialFromApi(now);
  if (fromStatusline && fromApi) {
    const a = fromStatusline.staleSince || fromStatusline.fetchedAt;
    const b = fromApi.staleSince || fromApi.fetchedAt;
    return a >= b ? fromStatusline : fromApi;
  }
  /* officialState last: it is the failure, and worth showing only when there
     is no reading of either kind to show instead. */
  return fromStatusline || fromApi || officialState;
}

/* The hint rides on official.error so it reaches the widget's tooltip without
   the widget needing to know about it - and only when there is no live reading
   to show, since a working display does not need to be explained. */
function withHint(official, hint) {
  if (!hint || (official && official.ok && !official.stale)) return official;
  return Object.assign({}, official, {
    error: official && official.error ? official.error + ' · ' + hint : hint
  });
}

/* The credentials file being rewritten is the signal that a retry is worth
   making immediately, rather than waiting out a long backoff. */
function watchCredentials() {
  try {
    fs.watch(path.join(HOME, '.claude'), (event, filename) => {
      if (filename !== '.credentials.json') return;
      officialFailures = 0;
      refreshOfficial();
    }).unref();
  } catch (err) {
    /* Watching is an optimisation; the backoff still recovers on its own. */
  }
}

/* ------------------------------------------------------------------ config */

function loadConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (config && stat.mtimeMs === configMtime) return config;
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    configMtime = stat.mtimeMs;
  } catch (err) {
    if (!config) {
      console.error('Could not read limits.json, using built-in defaults:', err.message);
      config = {
        planLabel: 'Unknown plan',
        weeklyAnchor: { weekday: 4, hour: 21 },
        tokenWeights: { output: 5, input: 1, cacheCreation: 1.25, cacheRead: 0.1 },
        modelWeights: {},
        defaultModelWeight: 1,
        port: 41777
      };
    }
  }
  return config;
}

/* ------------------------------------------------------------- file walking */

function walk(dir, matcher, out, depth) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, matcher, out, depth + 1);
    } else if (matcher(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function recentFiles(files, cutoff) {
  const kept = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs >= cutoff) kept.push({ file, size: stat.size, mtime: stat.mtimeMs });
    } catch (err) { /* file vanished between readdir and stat */ }
  }
  return kept;
}

/* --------------------------------------------------------- transcript index */

function weightOf(usage, model, cfg) {
  const w = cfg.tokenWeights;
  const raw =
    (usage.output_tokens || 0) * w.output +
    (usage.input_tokens || 0) * w.input +
    (usage.cache_creation_input_tokens || 0) * w.cacheCreation +
    (usage.cache_read_input_tokens || 0) * w.cacheRead;
  const multiplier = Object.prototype.hasOwnProperty.call(cfg.modelWeights, model)
    ? cfg.modelWeights[model]
    : cfg.defaultModelWeight;
  return raw * multiplier;
}

/* A session's first user message is the best human label available: usually a
   slash command, otherwise the opening words of the prompt. Slugs exist on only
   a couple of transcripts, and a UUID says nothing. */
function extractTitle(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (err) {
    return null;
  }
  const content = obj && obj.message && obj.message.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && content[0] && typeof content[0].text === 'string') text = content[0].text;
  if (!text) return null;

  const command = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (command) return command[1].trim();

  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  return plain.length > 52 ? plain.slice(0, 52) + '…' : plain;
}

function parseLines(text, cfg, records, meta) {
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    /* The slug is a far better session label than a UUID. It has to be looked
       for before the prefilter below, because it does not ride on the lines
       that carry usage - checking only those left most sessions unnamed. The
       indexOf costs nothing and stops once a slug is found. */
    if (meta && !meta.slug && line.indexOf('"slug"') >= 0) {
      const slug = /"slug":"([^"]+)"/.exec(line);
      if (slug) meta.slug = slug[1];
    }
    /* Capped: without a limit a transcript whose user records never yield text
       would be JSON.parsed on every one of them, every rebuild. */
    if (meta && !meta.title && (meta.titleTries || 0) < 5 && line.indexOf('"type":"user"') >= 0) {
      meta.titleTries = (meta.titleTries || 0) + 1;
      meta.title = extractTitle(line);
    }
    /* Cheap prefilter: skip the ~90% of lines that cannot contribute. */
    if (line.indexOf('"usage"') < 0 && line.indexOf('"quotaLimits"') < 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      continue; /* a partially flushed final line */
    }
    if (obj.quotaLimits && obj.quotaLimits.resetsAt) {
      const at = obj.quotaLimits.resetsAt * 1000;
      if (!lastQuota || at > lastQuota.resetsAt) {
        lastQuota = {
          resetsAt: at,
          type: obj.quotaLimits.rateLimitType || null,
          status: obj.quotaLimits.status || null,
          seenAt: Date.parse(obj.timestamp) || Date.now()
        };
      }
    }
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
    const t = Date.parse(obj.timestamp);
    if (!Number.isFinite(t)) continue;
    const model = obj.message.model || 'unknown';
    const u = obj.message.usage;
    records.push({
      t, model,
      w: weightOf(u, model, cfg),
      /* Raw class counts kept alongside the weighted figure: the weighted one
         is only meaningful relative to itself, these are what a human reads. */
      i: u.input_tokens || 0,
      o: u.output_tokens || 0,
      cc: u.cache_creation_input_tokens || 0,
      cr: u.cache_read_input_tokens || 0
    });
  }
}

function readIncrement(entry, cfg) {
  const prev = fileState.get(entry.file);
  /* Unchanged since the last pass: reuse what we already parsed. */
  if (prev && prev.size === entry.size && prev.mtime === entry.mtime) return prev;

  const records = prev && entry.size > prev.size ? prev.records : [];
  const meta = (prev && entry.size > prev.size) ? prev.meta : {};
  const from = prev && entry.size > prev.size ? prev.size : 0;

  try {
    const fd = fs.openSync(entry.file, 'r');
    try {
      const length = entry.size - from;
      if (length > 0) {
        const buf = Buffer.allocUnsafe(length);
        fs.readSync(fd, buf, 0, length, from);
        parseLines(buf.toString('utf8'), cfg, records, meta);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return prev || { size: 0, mtime: 0, records, meta };
  }

  const state = { size: entry.size, mtime: entry.mtime, records, meta };
  fileState.set(entry.file, state);
  return state;
}

/* A transcript sitting directly under projects/<project>/ is a session; the
   ones nested deeper belong to subagents and workflows. */
function isSessionFile(file) {
  const rel = path.relative(PROJECTS_DIR, file);
  return rel.split(path.sep).length === 2;
}

function collectRecords(cfg) {
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  const files = recentFiles(
    walk(PROJECTS_DIR, name => name.endsWith('.jsonl'), [], 0),
    cutoff
  );

  const all = [];
  const sessions = [];
  for (const entry of files) {
    const state = readIncrement(entry, cfg);
    let lastAt = 0;
    let messages = 0;
    let weighted = 0;
    for (const rec of state.records) {
      if (rec.t < cutoff) continue;
      all.push(rec);
      messages++;
      weighted += rec.w;
      if (rec.t > lastAt) lastAt = rec.t;
    }
    /* A session that has just been opened has no message to count yet - its
       transcript holds only startup bookkeeping (mode, permission-mode,
       attachments) - so requiring a counted message hid it until its first
       exchange finished. Someone who has just opened a session expects to see
       it, so a recently written transcript is enough on its own; `lastAt` then
       falls back to the file's own mtime, which is what makes it read as
       running. It ages out on the same 15-minute rule as everything else, so a
       session left open and untouched does eventually drop off. */
    const startedRecently = (Date.now() - entry.mtime) <= SESSION_ACTIVE_MS;
    if ((messages || startedRecently) && isSessionFile(entry.file)) {
      const id = path.basename(entry.file, '.jsonl');
      sessions.push({
        id: id,
        label: redactSecrets((state.meta && (state.meta.title || state.meta.slug)) || id.slice(0, 8)),
        project: projectLabel(path.basename(path.dirname(entry.file))),
        lastAt: lastAt || entry.mtime,
        messages: messages,
        tokens: Math.round(weighted)
      });
    }
  }

  /* Drop cursors for files that aged out, so memory tracks the window. */
  const live = new Set(files.map(f => f.file));
  for (const key of fileState.keys()) {
    if (!live.has(key)) fileState.delete(key);
  }

  all.sort((a, b) => a.t - b.t);
  sessions.sort((a, b) => b.lastAt - a.lastAt);
  return { records: all, sessions: sessions.slice(0, MAX_SESSIONS) };
}

/* ------------------------------------------------------------ time windows */

/* Blocks follow Claude Code's own 5-hour session model: a block opens at the
   top of the hour containing its first message, and closes 5 hours later or
   after a 5-hour gap in activity, whichever comes first. */
function currentBlock(records, now) {
  let start = null;
  let last = null;
  for (const rec of records) {
    if (start === null || rec.t - start >= SESSION_BLOCK_MS || rec.t - last >= SESSION_BLOCK_MS) {
      const d = new Date(rec.t);
      d.setMinutes(0, 0, 0);
      start = d.getTime();
    }
    last = rec.t;
  }
  if (start === null) return null;
  if (now - start >= SESSION_BLOCK_MS) return null; /* the last block already expired */
  return { start, end: start + SESSION_BLOCK_MS };
}

function weeklyWindow(anchor, now) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(0);
  d.setHours(anchor.hour);
  /* Walk back to the most recent anchor weekday at or before now. */
  let delta = (d.getDay() - anchor.weekday + 7) % 7;
  d.setDate(d.getDate() - delta);
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  const start = d.getTime();
  return { start, end: start + 7 * 86400000 };
}

function sumWeighted(records, from, to, models) {
  let total = 0;
  for (const rec of records) {
    if (rec.t < from || rec.t >= to) continue;
    if (models && models.indexOf(rec.model) < 0) continue;
    total += rec.w;
  }
  return total;
}

/* The raw counts behind a window, which is what the debug page shows and what
   the widget reports now that the percentage turned out to be unreproducible. */
function sumTokens(records, from, to) {
  const acc = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, messages: 0, byModel: {} };
  for (const rec of records) {
    if (rec.t < from || rec.t >= to) continue;
    acc.messages++;
    acc.input += rec.i;
    acc.output += rec.o;
    acc.cacheCreation += rec.cc;
    acc.cacheRead += rec.cr;
    const m = acc.byModel[rec.model] || (acc.byModel[rec.model] = { messages: 0, output: 0, weighted: 0 });
    m.messages++;
    m.output += rec.o;
    m.weighted += rec.w;
  }
  acc.total = acc.input + acc.output + acc.cacheCreation + acc.cacheRead;
  return acc;
}

/* Every 5-hour block in the window, so the current one can be shown against the
   user's own history instead of against a limit nobody publishes. */
function blockHistory(records, now) {
  const blocks = [];
  let start = null;
  let last = null;
  for (const rec of records) {
    if (start === null || rec.t - start >= SESSION_BLOCK_MS || rec.t - last >= SESSION_BLOCK_MS) {
      const d = new Date(rec.t);
      d.setMinutes(0, 0, 0);
      start = d.getTime();
      blocks.push({ start, end: start + SESSION_BLOCK_MS, weighted: 0, messages: 0 });
    }
    const b = blocks[blocks.length - 1];
    b.weighted += rec.w;
    b.messages++;
    last = rec.t;
  }
  return blocks;
}

/* "default_claude_max_5x" -> "Max (5x)", matching how the panel words it. */
function planLabelFromTier(tier) {
  const m = /claude_(max|pro)(?:_(\d+)x)?/.exec(String(tier));
  if (!m) return tier;
  const name = m[1] === 'max' ? 'Max' : 'Pro';
  return m[2] ? name + ' (' + m[2] + 'x)' : name;
}

/* --------------------------------------------- workflows and their subtasks */

/* Labels are built from prompt text, and people paste keys into prompts. A
   label is cosmetic; a credential rendered on a desk display is not, so anything
   key-shaped is replaced before it can reach the widget or the debug page.
   Deliberately narrow - broad entropy heuristics would mangle ordinary text. */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{6,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
  /gh[pousr]_[A-Za-z0-9]{16,}/g
];

function redactSecrets(text) {
  let out = String(text == null ? '' : text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

function projectLabel(dirName) {
  const parts = dirName.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dirName;
}

function collectWorkflows() {
  const cutoff = Date.now() - 7 * 86400000;
  const files = recentFiles(
    walk(PROJECTS_DIR, name => /^wf_.*\.json$/.test(name), [], 0),
    cutoff
  );

  const workflows = [];
  const subtasks = [];

  for (const entry of files) {
    let wf;
    try {
      wf = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
    } catch (err) {
      continue;
    }
    /* .../projects/<encoded-project>/<session>/workflows/wf_x.json */
    const project = projectLabel(path.basename(
      path.dirname(path.dirname(path.dirname(entry.file)))
    ));
    const startedAt = wf.startTime || Date.parse(wf.timestamp) || entry.mtime;
    const status = wf.status || 'unknown';
    const wfActive = !FINISHED_WORKFLOW.has(String(status).toLowerCase()) &&
      (Date.now() - entry.mtime) <= WORKFLOW_ACTIVE_MS;

    workflows.push({
      active: wfActive,
      id: wf.runId || path.basename(entry.file, '.json'),
      name: wf.workflowName || 'workflow',
      summary: wf.summary || '',
      status: status,
      project,
      startedAt,
      durationMs: wf.durationMs || 0,
      agents: wf.agentCount || 0,
      tokens: wf.totalTokens || 0,
      toolCalls: wf.totalToolCalls || 0
    });

    for (const step of wf.workflowProgress || []) {
      if (step.type !== 'workflow_agent') continue;
      subtasks.push({
        /* A step cannot be running if the workflow around it has finished,
           whatever the step's own recorded state says. */
        active: wfActive && !FINISHED_TASK.has(String(step.state || '').toLowerCase()),
        label: step.label || step.agentId || 'agent',
        model: (step.model || '').replace(/^claude-/, '').replace(/-\d{8}$/, ''),
        state: step.state || 'queued',
        phase: step.phaseTitle || '',
        tokens: step.tokens || 0,
        toolCalls: step.toolCalls || 0,
        workflow: wf.workflowName || '',
        project,
        startedAt: step.startedAt || step.queuedAt || startedAt,
        source: 'workflow'
      });
    }
  }

  workflows.sort((a, b) => b.startedAt - a.startedAt);
  subtasks.sort((a, b) => b.startedAt - a.startedAt);
  return { workflows: workflows.slice(0, MAX_WORKFLOWS), subtasks: subtasks.slice(0, MAX_SUBTASKS) };
}

/* ------------------------------------------------------------- live runs */

/* A running workflow leaves no wf_*.json. That file is written when the run
   ENDS, which is why filtering it by a non-terminal status matched nothing and
   the widget sat empty through a whole 60-second probe run - verified
   2026-08-28 by watching both paths during one.

   What does exist while a run is in flight is its transcript directory:

     subagents/workflows/wf_<runId>/
       journal.jsonl              {"type":"started",...} per agent,
                                  {"type":"result",...} when it finishes
       agent-<id>.jsonl           the agent's messages, first one is its prompt
       agent-<id>.meta.json       {"agentType","spawnDepth","model"}

   So an agent that has started and has no result is running, and a run with
   any such agent is running. That is the only live source, and it is the one
   the activity lists use. */
function readJournal(dir) {
  const started = new Map();
  const finished = new Set();
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
  } catch (err) {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (err) { continue; }
    if (!rec.agentId) continue;
    if (rec.type === 'started') started.set(rec.agentId, rec);
    else if (rec.type === 'result' || rec.type === 'error') finished.add(rec.agentId);
  }
  return { started, finished };
}

/* The agent's own prompt is the only human-readable thing about it on disk
   while it runs - opts.label never lands there - so the first line of it names
   the row, the same way a session is named by its first user message. */
function agentLabel(dir, agentId) {
  try {
    const fd = fs.openSync(path.join(dir, 'agent-' + agentId + '.jsonl'), 'r');
    const buf = Buffer.alloc(8192);
    const read = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const line = buf.slice(0, read).toString('utf8').split('\n')[0];
    const rec = JSON.parse(line);
    const content = rec && rec.message && rec.message.content;
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? (content.find(c => c.type === 'text') || {}).text || '' : '');
    const first = String(text).split('\n').find(l => l.trim());
    return first ? redactSecrets(first.trim()).slice(0, 60) : agentId.slice(0, 8);
  } catch (err) {
    return agentId.slice(0, 8);
  }
}

function agentModel(dir, agentId) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'agent-' + agentId + '.meta.json'), 'utf8'));
    return String(meta.model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  } catch (err) {
    return '';
  }
}

/* A run whose script file is still on disk can be named properly; a rerun
   against an edited script cannot, because the script keeps the name of the
   run that first created it. The short run id is the honest fallback. */
function runName(sessionDir, runId) {
  try {
    const scripts = fs.readdirSync(path.join(sessionDir, 'workflows', 'scripts'));
    const match = scripts.find(f => f.endsWith('-' + runId + '.js'));
    if (match) return match.slice(0, -(runId.length + 4));
  } catch (err) { /* no scripts directory */ }
  return runId.replace(/^wf_/, 'wf ');
}

function collectLiveRuns() {
  const workflows = [];
  const subtasks = [];
  const cutoff = Date.now() - LIVE_RUN_STALE_MS;
  let roots;
  try {
    roots = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch (err) {
    return { workflows, subtasks };
  }

  for (const project of roots) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(PROJECTS_DIR, project.name);
    let sessions;
    try { sessions = fs.readdirSync(projectDir, { withFileTypes: true }); } catch (err) { continue; }

    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(projectDir, session.name);
      const runsDir = path.join(sessionDir, 'subagents', 'workflows');
      let runs;
      try { runs = fs.readdirSync(runsDir, { withFileTypes: true }); } catch (err) { continue; }

      for (const run of runs) {
        if (!run.isDirectory() || !/^wf_/.test(run.name)) continue;
        const dir = path.join(runsDir, run.name);
        /* A killed run leaves "started" with no result forever. Recency of the
           directory bounds that, so a dead run stops being reported as live. */
        let stat;
        try { stat = fs.statSync(dir); } catch (err) { continue; }
        if (stat.mtimeMs < cutoff) continue;

        const journal = readJournal(dir);
        if (!journal) continue;
        const running = [...journal.started.keys()].filter(id => !journal.finished.has(id));
        if (!running.length) continue;

        const name = runName(sessionDir, run.name);
        const project_ = projectLabel(project.name);
        workflows.push({
          active: true,
          id: run.name,
          name,
          summary: '',
          status: 'running',
          project: project_,
          startedAt: stat.birthtimeMs || stat.mtimeMs,
          durationMs: 0,
          agents: journal.started.size,
          tokens: 0,
          toolCalls: 0
        });
        for (const id of running) {
          subtasks.push({
            active: true,
            label: agentLabel(dir, id),
            model: agentModel(dir, id),
            state: 'running',
            phase: '',
            tokens: 0,
            toolCalls: 0,
            workflow: name,
            project: project_,
            startedAt: stat.mtimeMs,
            source: 'live'
          });
        }
      }
    }
  }
  workflows.sort((a, b) => b.startedAt - a.startedAt);
  subtasks.sort((a, b) => b.startedAt - a.startedAt);
  return { workflows, subtasks };
}

/* Queued work from the whattask.json task plans, so the subtask list still says
   something useful when no workflow is currently running. */
function collectQueuedTasks() {
  const roots = [path.join(HOME, 'claude')];
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, '.claude', 'tasks', 'whattask.json');
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (err) {
        continue;
      }
      let plan;
      try {
        plan = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        continue;
      }
      for (const task of plan.tasks || []) {
        found.push({
          label: task.title || task.id,
          model: (task.model || '').replace(/^claude-/, ''),
          state: task.blocked_on ? 'blocked' : 'queued',
          phase: task.lane || '',
          tokens: 0,
          toolCalls: 0,
          workflow: 'whattask',
          project: entry.name,
          startedAt: stat.mtimeMs,
          source: 'whattask'
        });
      }
    }
  }
  return found;
}

/* ----------------------------------------------------------------- snapshot */

/* nowOverride answers "what would this have said at time T", which is what
   makes calibration against a timestamped screenshot possible. Windows are
   always capped at `now`, so a past T does not count usage from after it. */
function build(nowOverride) {
  const cfg = loadConfig();
  const now = nowOverride || Date.now();
  const collected = collectRecords(cfg);
  const records = collected.records;
  const sessions = collected.sessions.map(s => Object.assign({}, s, {
    state: (now - s.lastAt) <= SESSION_ACTIVE_MS ? 'running' : 'done'
  }));
  const activeSessions = sessions.filter(s => s.state === 'running');

  const block = currentBlock(records, now);
  const sessionUsed = block ? sumWeighted(records, block.start, Math.min(block.end, now), null) : 0;

  const week = weeklyWindow(cfg.weeklyAnchor, now);
  const weeklyEnd = Math.min(week.end, now);
  const weeklyUsed = sumWeighted(records, week.start, weeklyEnd, null);

  const { workflows, subtasks } = collectWorkflows();
  const queued = collectQueuedTasks();
  /* If Claude Code is being used right now, the statusline should be writing.
     When it is not, the likely cause is that statusLine.command no longer runs
     the wrapper - changing your statusline or reinstalling ccstatusline silently
     unhooks it, and the symptom is indistinguishable from an idle machine. Say
     so, rather than leaving the reading to age out with no explanation. */
  const slHealth = statusline.health(now);
  const slCurrent = slHealth.present && slHealth.ageMs != null && slHealth.ageMs <= statusline.FRESH_MS;
  const wrapperSuspect = activeSessions.length > 0 && !slCurrent;
  const wrapperHint = !wrapperSuspect ? null
    : (slHealth.present
        ? ('a Claude Code session is active but ' + statusline.FILE + ' is ' +
           Math.round(slHealth.ageMs / 60000) + ' min old - is statusline-tee.js still wired into statusLine.command?')
        : ('a Claude Code session is active but ' + statusline.FILE + ' does not exist - ' +
           'statusline-tee.js is probably not wired into statusLine.command'));

  /* Live runs are the activity. The wf_*.json files are the record of runs
     that have already ended, kept for the counts and the debug page. */
  const live = collectLiveRuns();
  const activeWorkflows = live.workflows.concat(workflows.filter(w => w.active));
  const activeSubtasks = live.subtasks.concat(subtasks.filter(t => t.active));

  /* A 429 seen inside the current block is authoritative: prefer its reset. */
  const quotaFresh = lastQuota && block && lastQuota.seenAt >= block.start && lastQuota.resetsAt > now;

  const sessionTokens = block ? sumTokens(records, block.start, Math.min(block.end, now)) : sumTokens(records, 0, 0);
  const weeklyTokens = sumTokens(records, week.start, weeklyEnd);

  /* Busiest complete block in the window, used as the bar's reference. Complete
     only: the block in progress would otherwise scale against itself. */
  const history = blockHistory(records, now);
  const peak = history
    .filter(b => !block || b.start !== block.start)
    .reduce((max, b) => Math.max(max, b.weighted), 0);

  return {
    generatedAt: now,
    /* Anthropic's own numbers when the endpoint answered, so the widget can
       prefer them and fall back to the measured view when it did not. */
    official: withHint(officialForSnapshot(now), wrapperHint),
    /* Machine-readable version of the same thing, for the debug page. */
    diagnostics: {
      statusline: Object.assign({}, slHealth, {
        current: slCurrent,
        likelyUnhooked: wrapperSuspect,
        hint: wrapperHint
      })
    },
    plan: (officialGood && officialGood.planTier) ? planLabelFromTier(officialGood.planTier) : cfg.planLabel,
    session: {
      /* Weighted totals are measured, and the bar is drawn against the user's
         own busiest recent block. There is deliberately no percentage here:
         dividing these by a guessed plan limit produced a number that was
         wrong by 20 points and looked authoritative. */
      usedWeighted: Math.round(sessionUsed),
      /* Exact, unlike percent: measured counts and a reference drawn from the
         user's own history rather than an unpublished limit. */
      tokens: sessionTokens,
      peakWeighted: Math.round(peak),
      startsAt: block ? block.start : null,
      resetsAt: quotaFresh && lastQuota.type === 'five_hour' ? lastQuota.resetsAt : (block ? block.end : null),
      blocked: !!(quotaFresh && lastQuota.status === 'rejected'),
      active: !!block
    },
    weekly: {
      usedWeighted: Math.round(weeklyUsed),
      tokens: weeklyTokens,
      startsAt: week.start,
      resetsAt: week.end,
    },
    /* Only what is running. Queued tasks are deliberately not folded in here:
       waiting to start is not the same as running, and the previous fallback
       made a backlog of 86 planned tasks look like live work. The count is
       still reported so the widget can say the backlog exists. */
    sessions: activeSessions,
    workflows: activeWorkflows,
    subtasks: activeSubtasks,
    counts: {
      sessions: activeSessions.length,
      workflows: activeWorkflows.length,
      subtasks: activeSubtasks.length,
      /* Totals behind the live view, for /usagehtml and for anyone diagnosing
         why a list is empty. */
      sessionsSeen: sessions.length,
      workflowsSeen: workflows.length,
      subtasksSeen: subtasks.length,
      queued: queued.length,
      messages: records.length
    }
  };
}

function rebuild() {
  const started = Date.now();
  try {
    snapshot = build();
    if (process.env.CLAUDE_USAGE_VERBOSE) {
      console.log(`rebuilt in ${Date.now() - started}ms  ` +
        `sessions=${snapshot.counts.sessions} workflows=${snapshot.counts.workflows} ` +
        `subtasks=${snapshot.counts.subtasks}`);
    }
  } catch (err) {
    console.error('rebuild failed:', err.message);
  }
}

/* --------------------------------------------------------------- http layer */

const cfgBoot = loadConfig();
const PORT = Number(process.env.PORT) || cfgBoot.port || 41777;

const server = http.createServer((req, res) => {
  /* The widget runs from a file:// or iCUE-internal origin, so it arrives as
     Origin: null. Bound to loopback only. */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  /* Human-readable debug view. An addition alongside /usage, which is
     deliberately left exactly as the widget expects it. */
  if (req.url === '/usagehtml' || req.url.startsWith('/usagehtml?')) {
    if (!snapshot) rebuild();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(usagehtml.render(snapshot, loadConfig()));
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, generatedAt: snapshot ? snapshot.generatedAt : null }));
    return;
  }
  if (req.url === '/' || req.url.startsWith('/usage')) {
    /* ?at=<epoch ms | ISO> rebuilds as of a past moment, for calibrating
       against a timestamped screenshot. Never cached. */
    const q = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const atMatch = /(?:^|&)at=([^&]+)/.exec(q);
    if (atMatch) {
      const raw = decodeURIComponent(atMatch[1]);
      const at = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      if (Number.isFinite(at)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(build(at)));
        return;
      }
    }
    if (!snapshot) rebuild();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

/* A test server must not poll Anthropic. Without this guard every spawned test
   server made a real request to an endpoint that is already rate-limited - which
   is exactly what the fixture tests were doing while being described as costing
   nothing. Unset in normal use. */
if (process.env.CLAUDE_USAGE_NO_REMOTE) {
  officialState = { ok: false, fetchedAt: Date.now(), error: 'remote polling disabled (CLAUDE_USAGE_NO_REMOTE)' };
} else {
  refreshOfficial();   /* schedules its own next run, with backoff on failure */
  watchCredentials();
}

/* The guard above runs first on purpose: rebuild() caches a snapshot, and one
   built before officialState was set would carry "not fetched yet" until the
   next refresh. */
rebuild();
setInterval(rebuild, REFRESH_MS).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude usage feed on http://127.0.0.1:${PORT}/usage`);
  if (snapshot) {
    console.log(`  sessions ${snapshot.counts.sessions}  ` +
      `workflows ${snapshot.counts.workflows}  subtasks ${snapshot.counts.subtasks}  ` +
      `(from ${snapshot.counts.messages} messages)`);
  }
});
