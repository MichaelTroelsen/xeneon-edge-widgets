#!/usr/bin/env node
/* Claude Code usage feed for the Xeneon Edge widget.
 *
 * An iCUE widget is a sandboxed web page: it cannot read files or run commands.
 * This serves everything it needs as JSON on 127.0.0.1.
 *
 * Nothing here touches credentials and nothing leaves the machine. Every number
 * is derived from files Claude Code already writes under ~/.claude.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CONFIG_PATH = path.join(__dirname, 'limits.json');

const WINDOW_DAYS = 8;                       /* transcripts older than this are ignored */
const SESSION_BLOCK_MS = 5 * 60 * 60 * 1000; /* the "current session" is a 5-hour block */
const REFRESH_MS = 20000;                    /* how often the index is rebuilt */
const MAX_WORKFLOWS = 24;
const MAX_SUBTASKS = 40;

let config = null;
let configMtime = 0;

/* Per-file cursor so a rebuild only parses bytes that are new. Transcript files
   run to hundreds of KB each and there are hundreds of them. */
const fileState = new Map(); /* path -> { size, mtime, records: [] } */

let snapshot = null;
let lastQuota = null; /* most recent 429 quotaLimits record seen, if any */

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

function parseLines(text, cfg, records) {
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
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
    records.push({ t, model, w: weightOf(obj.message.usage, model, cfg) });
  }
}

function readIncrement(entry, cfg) {
  const prev = fileState.get(entry.file);
  /* Unchanged since the last pass: reuse what we already parsed. */
  if (prev && prev.size === entry.size && prev.mtime === entry.mtime) return prev.records;

  const records = prev && entry.size > prev.size ? prev.records : [];
  const from = prev && entry.size > prev.size ? prev.size : 0;

  try {
    const fd = fs.openSync(entry.file, 'r');
    try {
      const length = entry.size - from;
      if (length > 0) {
        const buf = Buffer.allocUnsafe(length);
        fs.readSync(fd, buf, 0, length, from);
        parseLines(buf.toString('utf8'), cfg, records);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return records;
  }

  fileState.set(entry.file, { size: entry.size, mtime: entry.mtime, records });
  return records;
}

function collectRecords(cfg) {
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  const files = recentFiles(
    walk(PROJECTS_DIR, name => name.endsWith('.jsonl'), [], 0),
    cutoff
  );

  const all = [];
  for (const entry of files) {
    for (const rec of readIncrement(entry, cfg)) {
      if (rec.t >= cutoff) all.push(rec);
    }
  }

  /* Drop cursors for files that aged out, so memory tracks the window. */
  const live = new Set(files.map(f => f.file));
  for (const key of fileState.keys()) {
    if (!live.has(key)) fileState.delete(key);
  }

  all.sort((a, b) => a.t - b.t);
  return all;
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
  const records = collectRecords(cfg);

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

  return {
    generatedAt: now,
    estimated: true,
    plan: cfg.planLabel,
    session: {
      percent: pct(sessionUsed, cfg.sessionBudgetWeightedTokens),
      /* Raw totals so calibration is not limited by a rounded percentage. */
      usedWeighted: Math.round(sessionUsed),
      budgetWeighted: cfg.sessionBudgetWeightedTokens,
      resetsAt: quotaFresh && lastQuota.type === 'five_hour' ? lastQuota.resetsAt : (block ? block.end : null),
      blocked: !!(quotaFresh && lastQuota.status === 'rejected'),
      active: !!block
    },
    weekly: {
      percent: pct(weeklyUsed, weeklyBudget(cfg, cfg.weeklyBudgetWeightedTokens, now)),
      usedWeighted: Math.round(weeklyUsed),
      budgetWeighted: weeklyBudget(cfg, cfg.weeklyBudgetWeightedTokens, now),
      resetsAt: week.end,
      buckets
    },
    workflows,
    subtasks: subtasks.length ? subtasks : queued.slice(0, MAX_SUBTASKS),
    counts: {
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude usage feed on http://127.0.0.1:${PORT}/usage`);
  if (snapshot) {
    console.log(`  session ${snapshot.session.percent}%  weekly ${snapshot.weekly.percent}%  ` +
      `workflows ${snapshot.counts.workflows}  subtasks ${snapshot.counts.subtasks}  ` +
      `(from ${snapshot.counts.messages} messages)`);
  }
});
