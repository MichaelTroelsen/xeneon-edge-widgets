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

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CONFIG_PATH = path.join(__dirname, 'limits.json');

const WINDOW_DAYS = 8;                       /* transcripts older than this are ignored */
const SESSION_BLOCK_MS = 5 * 60 * 60 * 1000; /* the "current session" is a 5-hour block */
const REFRESH_MS = 20000;                    /* how often the index is rebuilt */
const MAX_WORKFLOWS = 24;
const MAX_SUBTASKS = 40;
const MAX_SESSIONS = 20;
const SESSION_ACTIVE_MS = 15 * 60 * 1000; /* a session is "live" if it spoke this recently */

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
/* Five minutes, not one. At one-minute polling the endpoint started returning
   429 after roughly nine requests - its limit is far tighter than the rebuild
   cadence, and utilisation moves slowly enough that this loses nothing. */
const OFFICIAL_INTERVAL_MS = 5 * 60 * 1000;
const OFFICIAL_MAX_BACKOFF_MS = 30 * 60 * 1000;
/* A rate limit deserves a bigger first step than an ordinary failure, and its
   own ceiling: these windows are commonly hourly, and a 30-minute retry that
   keeps landing inside the window just keeps the penalty alive. */
const OFFICIAL_RATE_LIMIT_MS = 15 * 60 * 1000;
const OFFICIAL_RATE_LIMIT_MAX_MS = 60 * 60 * 1000;
/* Past this, a cached reading stops being worth showing. */
const OFFICIAL_STALE_MS = 30 * 60 * 1000;

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

/* What the snapshot should carry: the live reading if the last poll worked,
   otherwise the most recent good one flagged as stale, and only after that the
   failure itself. */
function officialForSnapshot(now) {
  if (officialState.ok) return officialState;
  if (officialGood && (now - officialGood.fetchedAt) < OFFICIAL_STALE_MS) {
    return Object.assign({}, officialGood, {
      stale: true,
      staleSince: officialGood.fetchedAt,
      error: officialState.error || null
    });
  }
  return officialState;
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
        sessionBudgetWeightedTokens: 90000000,
        weeklyBudgetWeightedTokens: 900000000,
        weeklyAnchor: { weekday: 4, hour: 21 },
        tokenWeights: { output: 5, input: 1, cacheCreation: 1.25, cacheRead: 0.1 },
        modelWeights: {},
        defaultModelWeight: 1,
        weeklyBuckets: [],
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
    if (messages && isSessionFile(entry.file)) {
      const id = path.basename(entry.file, '.jsonl');
      sessions.push({
        id: id,
        label: (state.meta && (state.meta.title || state.meta.slug)) || id.slice(0, 8),
        project: projectLabel(path.basename(path.dirname(entry.file))),
        lastAt: lastAt,
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

function pct(used, budget) {
  if (!budget || budget <= 0) return 0;
  return Math.min(100, Math.round((used / budget) * 100));
}

/* Anthropic runs temporary weekly boosts ("your weekly limit is 50% higher
   through August 31"). Calibrating against a boosted week and then leaving it
   would make every later week read high, so the boost is declared with an
   expiry and applied only while it is live. */
function weeklyBudget(cfg, base, now) {
  const boost = cfg.weeklyBoost;
  if (!boost || !boost.multiplier || !boost.until) return base;
  const until = Date.parse(boost.until);
  if (!Number.isFinite(until) || now >= until) return base;
  return base * boost.multiplier;
}

/* --------------------------------------------- workflows and their subtasks */

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

    workflows.push({
      id: wf.runId || path.basename(entry.file, '.json'),
      name: wf.workflowName || 'workflow',
      summary: wf.summary || '',
      status: wf.status || 'unknown',
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

  const block = currentBlock(records, now);
  const sessionUsed = block ? sumWeighted(records, block.start, Math.min(block.end, now), null) : 0;

  const week = weeklyWindow(cfg.weeklyAnchor, now);
  const weeklyEnd = Math.min(week.end, now);
  const weeklyUsed = sumWeighted(records, week.start, weeklyEnd, null);

  const buckets = (cfg.weeklyBuckets || []).map(bucket => {
    const used = sumWeighted(records, week.start, weeklyEnd, bucket.models);
    return {
      label: bucket.label,
      percent: pct(used, weeklyBudget(cfg, bucket.budgetWeightedTokens, now)),
      resetsAt: week.end
    };
  });

  const { workflows, subtasks } = collectWorkflows();
  const queued = collectQueuedTasks();

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
    estimated: true,
    /* Anthropic's own numbers when the endpoint answered, so the widget can
       prefer them and fall back to the measured view when it did not. */
    official: officialForSnapshot(now),
    plan: (officialGood && officialGood.planTier) ? planLabelFromTier(officialGood.planTier) : cfg.planLabel,
    session: {
      percent: pct(sessionUsed, cfg.sessionBudgetWeightedTokens),
      /* Raw totals so calibration is not limited by a rounded percentage. */
      usedWeighted: Math.round(sessionUsed),
      budgetWeighted: cfg.sessionBudgetWeightedTokens,
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
      percent: pct(weeklyUsed, weeklyBudget(cfg, cfg.weeklyBudgetWeightedTokens, now)),
      usedWeighted: Math.round(weeklyUsed),
      budgetWeighted: weeklyBudget(cfg, cfg.weeklyBudgetWeightedTokens, now),
      tokens: weeklyTokens,
      startsAt: week.start,
      resetsAt: week.end,
      buckets
    },
    sessions,
    workflows,
    subtasks: subtasks.length ? subtasks : queued.slice(0, MAX_SUBTASKS),
    counts: {
      sessions: sessions.length,
      sessionsActive: sessions.filter(s => s.state === 'running').length,
      workflows: workflows.length,
      subtasks: subtasks.length,
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
      console.log(`rebuilt in ${Date.now() - started}ms  session=${snapshot.session.percent}%  weekly=${snapshot.weekly.percent}%`);
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

rebuild();
setInterval(rebuild, REFRESH_MS).unref();
refreshOfficial();   /* schedules its own next run, with backoff on failure */
watchCredentials();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude usage feed on http://127.0.0.1:${PORT}/usage`);
  if (snapshot) {
    console.log(`  session ${snapshot.session.percent}%  weekly ${snapshot.weekly.percent}%  ` +
      `workflows ${snapshot.counts.workflows}  subtasks ${snapshot.counts.subtasks}  ` +
      `(from ${snapshot.counts.messages} messages)`);
  }
});
