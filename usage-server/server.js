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
const tasks = require('./tasks');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
/* Overridable so the detection can be tested against a fixture tree instead of
   the real one. Without this the only way to exercise the live-run path is to
   actually run agents - which costs real tokens, takes minutes, and briefly
   puts fabricated rows on the user's screen if the fixtures go in the real
   directory. Unset in normal use. */
const PROJECTS_DIR = process.env.CLAUDE_USAGE_PROJECTS_DIR ||
  path.join(CLAUDE_DIR, 'projects');
/* Same reasoning as PROJECTS_DIR above: a fixture path lets a test exercise a
   broken limits.json (e.g. one missing weeklyAnchor) without ever touching
   the real file operators hand-edit. Unset in normal use. */
const CONFIG_PATH = process.env.CLAUDE_USAGE_CONFIG_PATH ||
  path.join(__dirname, 'limits.json');
/* Same reasoning as PROJECTS_DIR above: fixtures go through this override so a
   test never reads (or worse, requires) the developer's real stats-cache.json. */
const STATS_FILE = process.env.CLAUDE_USAGE_STATS_FILE ||
  path.join(CLAUDE_DIR, 'stats-cache.json');
/* Same reasoning as PROJECTS_DIR above, and the one watchCredentials() needs:
   a fixture path lets a test exercise the credentials watcher itself (the
   directory it watches and the filename it filters on) without ever pointing
   at the real ~/.claude/.credentials.json. Unset in normal use. */
const CREDENTIALS_FILE = process.env.CLAUDE_USAGE_CREDENTIALS_FILE ||
  path.join(CLAUDE_DIR, '.credentials.json');

const WINDOW_DAYS = 8;                       /* transcripts older than this are ignored */
const SESSION_BLOCK_MS = 5 * 60 * 60 * 1000; /* the "current session" is a 5-hour block */
/* 10s rather than 20s, which halves the delay before a new session or a
   starting workflow appears. Measured over 11,146 messages: ~70 ms per
   incremental rebuild through the HTTP path, so under 0.7% of one core - and
   that is an upper bound, since the timer's rebuild neither serialises nor
   sends. The widget polls on the same interval, so the two together bound the
   lag at roughly 20s rather than 40s. */
/* Overridable so a test can wait out a background rebuild in well under a
   second instead of the real 10s cadence - needed to exercise the STALE
   /health state, which only appears after a rebuild has actually run and
   failed on the timer, not via the on-demand ?at= path. Unset in normal use. */
const REFRESH_MS = Number(process.env.CLAUDE_USAGE_REFRESH_MS) || 10000;
                                               /* how often the index is rebuilt */
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
/* Message of the most recent FAILED rebuild attempt, or null if the most
   recent attempt succeeded. This is what lets /health tell a snapshot that
   simply hasn't refreshed apart from one that is refreshing and failing -
   see the /health handler below for the three states this drives. */
let lastRebuildError = null;

/* Cumulative across the process, like tasks.js's own gitSpawnCount - so the
   verbose rebuild line below reports the DELTA for just this rebuild, which
   is what "one read per file per build" is actually a claim about. Read only
   under CLAUDE_USAGE_VERBOSE; production rebuilds never touch it. */
let lastTaskFileReads = 0;

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
/* Whether the CURRENT officialFailures count was earned by a 429 rather than
   some other failure (401, network error, ...). watchCredentials() below
   reads this to decide whether a credentials write is evidence worth acting
   on immediately, or noise during a backoff that must run its course. */
let officialRateLimited = false;

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

/* A test server must not poll Anthropic (see the CLAUDE_USAGE_NO_REMOTE guard
   at the bottom of this file), and that must hold no matter what triggers a
   refresh - the boot call, the backoff timer, or watchCredentials() below.
   Checking it here rather than only at the caller means a credentials-watch
   test can exercise the reset/discriminator logic below via a canned result
   instead of a real request to the already-rate-limited endpoint. Unset in
   normal use, where this is exactly official.fetchOfficial(). */
let fakeOfficialCalls = 0;   /* test-only: lets a test tell distinct fake fetches apart */
function fetchOfficialResult() {
  if (process.env.CLAUDE_USAGE_NO_REMOTE) {
    fakeOfficialCalls++;
    return Promise.resolve({
      ok: false,
      fetchedAt: Date.now(),
      error: (process.env.CLAUDE_USAGE_FAKE_OFFICIAL_ERROR || 'remote polling disabled (CLAUDE_USAGE_NO_REMOTE)') +
        ' #' + fakeOfficialCalls
    });
  }
  return official.fetchOfficial();
}

function refreshOfficial() {
  if (officialInFlight) return;
  officialInFlight = true;
  let rateLimited = false;
  let retryAfterMs = null;
  fetchOfficialResult()
    .then(result => {
      officialState = result;
      officialFailures = result.ok ? 0 : officialFailures + 1;
      rateLimited = !result.ok && /HTTP 429/.test(result.error || '');
      officialRateLimited = rateLimited;
      retryAfterMs = result.retryAfterMs || null;
      /* Keep the last good reading. Utilisation only climbs within a window and
         the reset times are absolute, so a few-minute-old figure is far better
         than dropping to a different metric because one poll was throttled. */
      if (result.ok) officialGood = result;
    })
    .catch(err => {
      officialState = { ok: false, error: String(err && err.message || err), fetchedAt: Date.now() };
      officialFailures++;
      officialRateLimited = false;
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

/* Resume offset for the credentials watcher's own dedup, not readIncrement's -
   this just remembers the mtime of the last write this function acted on. */
let lastCredentialsMtime = null;

/* The credentials file being rewritten is the signal that a retry is worth
   making immediately, rather than waiting out a long backoff - but only for
   the 401 case this exists to serve: a dead token got a new one, so the next
   request should use it now rather than waiting out minutes of backoff.
   A 429 is not that. It means the caller (not the credential) is the
   problem, and Claude Code rewrites this same file on its own cadence
   whether or not this server is in a 429 backoff - officialRateLimited (set
   in refreshOfficial() above from the same 429 check official.js and this
   file already use elsewhere) is what tells the two apart. Clearing the
   count and firing an immediate request during an earned 429 backoff would
   send exactly the extra request that turned a 401 into a 429 in the first
   place - see OFFICIAL_RATE_LIMIT_MS above. Left untouched, the backoff
   still recovers on its own once the window passes.

   Separately: official.js's own write pattern (write .tmp-<pid>, renameSync
   onto the target) fires TWO fs.watch events that pass the filename filter
   below for one logical rotation (measured on this platform - see the task
   record). Comparing the file's mtime collapses that pair into one action;
   without it a single rotation would run this handler, and any immediate
   refetch it triggers, twice. */
function watchCredentials() {
  const dir = path.dirname(CREDENTIALS_FILE);
  const base = path.basename(CREDENTIALS_FILE);
  try {
    fs.watch(dir, (event, filename) => {
      if (filename !== base) return;
      let mtime;
      try {
        mtime = fs.statSync(CREDENTIALS_FILE).mtimeMs;
      } catch (err) {
        return; /* mid-rename or briefly absent; the settled event covers it */
      }
      if (mtime === lastCredentialsMtime) return;
      lastCredentialsMtime = mtime;
      if (officialRateLimited) return;
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

/* -------------------------------------------------------------------- stats */

/* Claude Code maintains its own /stats rollup at ~/.claude/stats-cache.json -
   the same source its own /stats screen reads, so this only serves it, never
   recomputes it. It is an UNDOCUMENTED internal file already at `version: 5`;
   the shape has changed five times and can change again without warning. A
   served block built from a schema this code does not recognise would draw a
   confident, wrong picture on the widget, so an unrecognised version - or
   anything that fails the shape check below - is treated as fully
   unavailable rather than parsed best-effort. Only the fields this server
   actually serves are checked; a field Claude Code adds elsewhere does not
   require a matching change here. */
const STATS_SUPPORTED_VERSION = 5;

let statsCache = null;
let statsCacheMtime = 0;

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function validStats(raw) {
  return isPlainObject(raw) &&
    raw.version === STATS_SUPPORTED_VERSION &&
    Array.isArray(raw.dailyActivity) &&
    Array.isArray(raw.dailyModelTokens) &&
    isPlainObject(raw.modelUsage) &&
    typeof raw.totalSessions === 'number' &&
    typeof raw.totalMessages === 'number' &&
    typeof raw.firstSessionDate === 'string' &&
    isPlainObject(raw.hourCounts) &&
    (raw.longestSession == null || isPlainObject(raw.longestSession));
}

/* Mirrors loadConfig()'s and statusline.read()'s mtime-cached-read idiom: the
   file is only re-parsed when it has actually changed, so a rebuild every
   REFRESH_MS does not mean a re-parse every REFRESH_MS. Never throws - every
   failure path returns an explicit unavailable reason instead. */
function readStats() {
  let stat;
  try {
    stat = fs.statSync(STATS_FILE);
  } catch (err) {
    return { unavailable: 'stats-cache.json not found at ' + STATS_FILE };
  }

  if (statsCache && stat.mtimeMs === statsCacheMtime) return statsCache;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch (err) {
    const result = { unavailable: 'stats-cache.json could not be parsed: ' + err.message };
    statsCache = result;
    statsCacheMtime = stat.mtimeMs;
    return result;
  }

  if (!validStats(raw)) {
    const result = {
      unavailable: 'stats-cache.json has version ' + JSON.stringify(raw && raw.version) +
        ', not the supported ' + STATS_SUPPORTED_VERSION + ' (or an unrecognised shape)'
    };
    statsCache = result;
    statsCacheMtime = stat.mtimeMs;
    return result;
  }

  const result = {
    dailyActivity: raw.dailyActivity,
    dailyModelTokens: raw.dailyModelTokens,
    modelUsage: raw.modelUsage,
    totalSessions: raw.totalSessions,
    totalMessages: raw.totalMessages,
    longestSession: raw.longestSession || null,
    firstSessionDate: raw.firstSessionDate,
    hourCounts: raw.hourCounts
  };
  statsCache = result;
  statsCacheMtime = stat.mtimeMs;
  return result;
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
    /* apiErrorStatus sits alongside quotaLimits as a sibling field on a real
       429 line, not inside it - every quotaLimits record seen in the wild so
       far carries it (see the task note). Without this check any line that
       merely mentions quotaLimits would qualify, contradicting this
       variable's own name and the comment below. */
    if (obj.quotaLimits && obj.quotaLimits.resetsAt && obj.apiErrorStatus === 429) {
      const seenAt = Date.parse(obj.timestamp) || Date.now();
      /* The MOST RECENT record wins, not whichever has the farthest-future
         resetsAt. Comparing on resetsAt let a seven_day 429 (reset days out)
         permanently outrank every five_hour 429 seen after it, forever. */
      if (!lastQuota || seenAt > lastQuota.seenAt) {
        lastQuota = {
          resetsAt: obj.quotaLimits.resetsAt * 1000,
          type: obj.quotaLimits.rateLimitType || null,
          status: obj.quotaLimits.status || null,
          seenAt
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

  const grew = !!(prev && entry.size > prev.size);
  const records = grew ? prev.records : [];
  const meta = grew ? prev.meta : {};
  /* Resume from the last COMPLETE line, not from the stat size. A transcript
     is appended to by a live session, so statSync routinely reports a size
     that stops in the middle of the JSON line being written. Resuming at that
     size put the next read mid-line, and the remainder was dropped for not
     starting with '{' - the record was never counted again for the life of
     the process. */
  const from = grew ? prev.cursor : 0;
  /* The tail after that last newline was parsed speculatively last pass (see
     below) and is about to be re-read, so drop those records first or they
     are counted twice. `committed` is how many of `records` came from bytes
     at or before `cursor`. */
  if (grew && records.length > prev.committed) records.length = prev.committed;

  let cursor = from;
  let committed = records.length;
  try {
    const fd = fs.openSync(entry.file, 'r');
    try {
      const length = entry.size - from;
      if (length > 0) {
        const buf = Buffer.allocUnsafe(length);
        fs.readSync(fd, buf, 0, length, from);
        /* Byte offset just past the last newline. Searched in the Buffer, not
           the decoded string, because the cursor has to be a byte position;
           and a byte 0x0A can never be part of a multi-byte UTF-8 sequence,
           so splitting here never cuts a character in half. */
        const nl = buf.lastIndexOf(10);
        const whole = nl >= 0 ? nl + 1 : 0;
        parseLines(buf.toString('utf8', 0, whole), cfg, records, meta);
        cursor = from + whole;
        committed = records.length;
        /* Whatever follows is a line with no newline YET. It is still parsed,
           so a record that is complete but not yet newline-terminated is
           counted immediately rather than waiting - and if it never gets a
           newline (a writer that died mid-record, or the final record of a
           transcript nothing will append to again) it keeps being counted on
           every pass instead of being lost. It is simply not committed: the
           cursor stays behind it, so the next pass re-reads those same bytes
           after the rollback above. A fragment still parses to nothing, which
           is the pre-existing behaviour. */
        if (whole < length) parseLines(buf.toString('utf8', whole, length), cfg, records, meta);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return prev || { size: 0, mtime: 0, cursor: 0, committed: 0, records, meta };
  }

  /* `size` stays the stat size - it is what the unchanged-since-last-pass
     check above compares against, and what decides grow vs. rewrite. `cursor`
     is the separate, possibly smaller, byte offset that reading resumes from.
     While a torn tail exists the two differ, so the unchanged check cannot
     fire and the tail is retried every pass, which is what makes the loss
     self-healing. */
  const state = { size: entry.size, mtime: entry.mtime, cursor, committed, records, meta };
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
  /* workflowsSeen/subtasksSeen must be the pre-slice totals: they exist so
     anyone diagnosing why a list is empty (or capped) can tell the two apart.
     Counting workflows.length/subtasks.length AFTER the slice below reports a
     number that can never exceed the cap, which hides truncation from the
     person reading it. */
  return {
    workflows: workflows.slice(0, MAX_WORKFLOWS),
    subtasks: subtasks.slice(0, MAX_SUBTASKS),
    workflowsSeen: workflows.length,
    subtasksSeen: subtasks.length
  };
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
   the row, the same way a session is named by its first user message.
   That same first record is also the only place the agent's real start time is
   written: the journal carries nothing but type/key/agentId (checked across
   234 records in 40 real journals), so an agent's start cannot be recovered
   from it. Read both out of the one open. */
function agentHead(dir, agentId) {
  const head = { label: agentId.slice(0, 8), startedAt: null };
  let fd;
  try {
    fd = fs.openSync(path.join(dir, 'agent-' + agentId + '.jsonl'), 'r');
  } catch (err) {
    return head;
  }
  try {
    /* The transcript is created when the agent is spawned and only appended to
       afterwards, so its birthtime is the agent's start even when the first
       record turns out to be unreadable or timestamp-less. mtime would not be:
       it moves with every message the agent writes, which would make a
       long-running agent read as permanently just-started. */
    try {
      const st = fs.fstatSync(fd);
      head.startedAt = st.birthtimeMs || st.mtimeMs || null;
    } catch (err) { /* keep null; the caller falls back to the run's start */ }
    try {
      const buf = Buffer.alloc(8192);
      const read = fs.readSync(fd, buf, 0, 8192, 0);
      const line = buf.slice(0, read).toString('utf8').split('\n')[0];
      const rec = JSON.parse(line);
      const content = rec && rec.message && rec.message.content;
      const text = typeof content === 'string'
        ? content
        : (Array.isArray(content) ? (content.find(c => c.type === 'text') || {}).text || '' : '');
      const first = String(text).split('\n').find(l => l.trim());
      if (first) head.label = redactSecrets(first.trim()).slice(0, 60);
      const at = Date.parse(rec && rec.timestamp);
      if (Number.isFinite(at)) head.startedAt = at;
    } catch (err) { /* unparseable first line: keep the id and the birthtime */ }
  } finally {
    fs.closeSync(fd);
  }
  return head;
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

/* Liveness is the newest write anywhere inside the run, not the run
   directory's own mtime.
   On this filesystem appending to a file leaves the containing directory's
   mtime byte-identical - measured, 1788087551287972400ns before and after an
   append - while creating a new file does move it. A workflow that fans all
   its agents out at the start (the /runbatch and /runqueue shape) therefore
   creates its last agent-*.jsonl in the first minute and only appends
   afterwards, so its directory mtime freezes there and the whole run
   disappears from the feed at t+15min while it is still writing.
   journal.jsonl alone does not fix that: the journal takes its "started"
   lines at the fan-out and then nothing until an agent finishes, so a
   40-minute agent leaves it exactly as frozen. The agent transcripts are what
   moves while work is in flight; the journal is what moves when a result
   lands. Take the newest of the two, with the directory's own mtime as the
   floor so a run whose files have all been removed behaves as it did before.
   A directory with no journal.jsonl at all is not rescued by this: readJournal
   still returns null for it below and the run is skipped, as before. */
function runActivityMs(dir, dirStat) {
  let newest = dirStat.mtimeMs;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (err) { return newest; }
  for (const name of entries) {
    if (name !== 'journal.jsonl' && !/^agent-.+\.jsonl$/.test(name)) continue;
    try {
      const ms = fs.statSync(path.join(dir, name)).mtimeMs;
      if (ms > newest) newest = ms;
    } catch (err) { /* deleted between readdir and stat */ }
  }
  return newest;
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
           run's newest write bounds that, so a dead run stops being reported
           as live - see runActivityMs for why the directory's own mtime is
           not that signal. */
        let stat;
        try { stat = fs.statSync(dir); } catch (err) { continue; }
        if (runActivityMs(dir, stat) < cutoff) continue;

        const journal = readJournal(dir);
        if (!journal) continue;
        const running = [...journal.started.keys()].filter(id => !journal.finished.has(id));
        if (!running.length) continue;

        const name = runName(sessionDir, run.name);
        const project_ = projectLabel(project.name);
        const runStartedAt = stat.birthtimeMs || stat.mtimeMs;
        workflows.push({
          active: true,
          id: run.name,
          name,
          summary: '',
          status: 'running',
          project: project_,
          startedAt: runStartedAt,
          durationMs: 0,
          agents: journal.started.size,
          tokens: 0,
          toolCalls: 0
        });
        for (const id of running) {
          const head = agentHead(dir, id);
          subtasks.push({
            active: true,
            label: head.label,
            model: agentModel(dir, id),
            state: 'running',
            phase: '',
            tokens: 0,
            toolCalls: 0,
            workflow: name,
            project: project_,
            /* Not the directory's mtime: that is whenever the LAST agent file
               happened to be created, so every agent in a fan-out reported the
               same start and a 40-minute one read as just-started. */
            startedAt: head.startedAt || runStartedAt,
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
   something useful when no workflow is currently running.

   This WAS a one-level readdirSync of ~/claude, which found 3 of the 5 repos
   that actually have queues - it walked straight past the two nested under
   c64server/, and with them 122 of 210 open tasks. tasks.discover() reads the
   real project registry in ~/.claude.json instead, so this list and the /tasks
   feed can never disagree about which repos exist. */
function collectQueuedTasks() {
  const found = [];
  for (const repo of tasks.discover()) {
    /* One cache per repo, shared between this readRepo() call and the
       readPlan() call right after it, so whattask.json - already read once
       inside readRepo() - is not read a second time here for the same repo.
       tasks.js's own build() scopes its cache the same way, per build, for
       the reason given there: the file changes between rebuilds, so nothing
       here keeps this cache past the one repo it was made for. */
    const cache = new Map();
    const read = tasks.readRepo(repo, cache);
    if (read.error) continue;
    const parsed = tasks.readPlan(repo.path, cache);
    if (parsed.error) continue;
    for (const task of parsed.tasks) {
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

  const { workflows, subtasks, workflowsSeen, subtasksSeen } = collectWorkflows();
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
    /* Claude Code's own /stats rollup, read but never recomputed - see
       readStats() above for why an unrecognised shape is withheld rather than
       best-effort parsed. */
    stats: readStats(),
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
      workflowsSeen: workflowsSeen,
      subtasksSeen: subtasksSeen,
      queued: queued.length,
      messages: records.length
    }
  };
}

function rebuild() {
  const started = Date.now();
  try {
    snapshot = build();
    /* A rebuild that succeeds clears any earlier failure - the config (or
       whatever threw) is evidently fine again. Leaving a stale error behind
       here would be its own version of this task's bug: /health lying about
       the current state instead of just the current numbers. */
    lastRebuildError = null;
    if (process.env.CLAUDE_USAGE_VERBOSE) {
      const reads = tasks.getFileReadCount();
      console.log(`rebuilt in ${Date.now() - started}ms  ` +
        `sessions=${snapshot.counts.sessions} workflows=${snapshot.counts.workflows} ` +
        `subtasks=${snapshot.counts.subtasks} taskFileReads=${reads - lastTaskFileReads}`);
      lastTaskFileReads = reads;
    }
  } catch (err) {
    /* This used to be the whole handler: log to stderr - which
       start-hidden.vbs discards - and otherwise do nothing, leaving
       `snapshot` at whatever it was before (null at boot, since this can
       fire on the very first rebuild if e.g. limits.json is missing a field
       weeklyWindow() needs). /health and /usage read `snapshot` and
       `lastRebuildError` below, not this catch block, so recording the
       failure here is what makes both endpoints able to tell the truth. */
    console.error('rebuild failed:', err.message);
    lastRebuildError = err.message;
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

  /* Everything below can throw on input we did not anticipate. This used to
     be unguarded: a single `?at=%` (an incomplete percent-escape) made
     decodeURIComponent throw synchronously inside this callback, which node
     has no default recovery for - it tears down the whole process, and
     start-hidden.vbs launches this with no restart supervision, so the feed
     and both widgets stayed dead until the next sign-in. One request from
     one bad `at=` link killed everything. */
  try {
    /* Human-readable debug view. An addition alongside /usage, which is
       deliberately left exactly as the widget expects it. */
    if (req.url === '/usagehtml' || req.url.startsWith('/usagehtml?')) {
      if (!snapshot) rebuild();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(usagehtml.render(snapshot, loadConfig()));
      return;
    }

    /* The whattask feed. Its own endpoint rather than a block inside /usage:
       the /usage contract is what the Claude Code Usage widget reads and is
       deliberately left exactly as that widget expects it.
       Placed above the /usage handler below, which matches on a prefix, so
       this route can never be shadowed by it. */
    if (req.url === '/tasks' || req.url.startsWith('/tasks?')) {
      /* The live block is handed over rather than recomputed, so the task
         widget's running view shows the same activity /usage does. Without it
         that view would be blank whenever no /runqueue holds a lock, which is
         nearly always. */
      const live = snapshot
        ? { sessions: snapshot.sessions, workflows: snapshot.workflows,
            subtasks: snapshot.subtasks }
        : null;
      /* ?project=<name> answers with just that project's task list, and
         nothing else. Its own response rather than a block in the overview:
         the five real queues hold 210 tasks and 297KB, of which 295KB is prose
         no 840x344 slot can show; trimmed they are still 49KB against the
         overview's 2.4KB, and the widget only ever looks at one project at a
         time. So the overview stays small and this is fetched on demand.
         Percent-decoded inside the same try as everything else - a malformed
         escape is the caller's mistake, answered 4xx below, never a throw that
         takes the process down. */
      const q = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '';
      const projectMatch = /(?:^|&)project=([^&]*)/.exec(q);
      if (projectMatch) {
        let name;
        try {
          name = decodeURIComponent(projectMatch[1]);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'project= is not valid percent-encoding' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tasks.projectTasks(name)));
        return;
      }

      const raw = /(?:\?|&)raw=1(?:&|$)/.test(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tasks.build(live, { raw: raw })));
      return;
    }

    if (req.url === '/health') {
      /* Three states this feed can be in, and the bug this endpoint exists
         to fix was collapsing all three into a blanket {ok:true}:

           (a) healthy - a snapshot exists and the most recent rebuild
               attempt succeeded. The common case.
           (b) stale   - a snapshot exists (some earlier rebuild succeeded)
               but the most recent rebuild attempt(s) have failed since, so
               the numbers being served are real but ageing - e.g. someone
               hand-edited limits.json into a shape weeklyWindow() cannot
               use, and every rebuild since has thrown. The feed is still
               genuinely useful here: it is showing real, if slightly
               stale, data, not nothing.
           (c) unbuilt - no snapshot has EVER been produced; `snapshot` is
               still at its boot value of null. There is nothing behind the
               feed. This is the exact state the bug produced: /usage
               answering 200 with the literal 4-byte body `null` while
               /health answered {ok:true}.

         Decision: `ok` is false ONLY for (c) - there is nothing to serve,
         which is the one state where a monitor SHOULD treat this as down.
         (b) keeps `ok:true` because the feed is still working and serving
         real numbers; a monitor that pages someone at 3am because a
         still-working feed's LAST rebuild attempt failed, while a perfectly
         good snapshot from minutes ago is being served, would be a bug of
         its own. (b) is not silently equated with (a) either, though:
         `state` says "stale" (not "healthy") and `error` names the failing
         rebuild, so anyone who wants to alert on staleness specifically -
         or just go fix limits.json - can see it without it reading as an
         outage. */
      const healthState = !snapshot ? 'unbuilt' : (lastRebuildError ? 'stale' : 'healthy');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: healthState !== 'unbuilt',
        state: healthState,
        generatedAt: snapshot ? snapshot.generatedAt : null,
        error: lastRebuildError
      }));
      return;
    }
    if (req.url === '/' || req.url.startsWith('/usage')) {
      /* ?at=<epoch ms | ISO> rebuilds as of a past moment, for calibrating
         against a timestamped screenshot. Never cached. */
      const q = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : '';
      const atMatch = /(?:^|&)at=([^&]+)/.exec(q);
      if (atMatch) {
        /* atMatch[1] is caller-supplied and still percent-encoded off the
           wire. decodeURIComponent throws URIError on a malformed escape
           (a bare "%", "%zz", an unpaired surrogate, ...) - that is the
           caller sending nonsense, not this server being broken, so it is a
           4xx answered right here. It must not be allowed to fall into the
           outer catch below, which exists for OUR bugs and answers 5xx. */
        let raw;
        try {
          raw = decodeURIComponent(atMatch[1]);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'malformed at= value' }));
          return;
        }
        const at = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
        if (Number.isFinite(at)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(build(at)));
          return;
        }
        /* Decoded fine but is neither an epoch nor a date Date.parse
           recognises (e.g. ?at=notadate) - also a caller mistake, not a
           decode error. Existing behaviour: fall through and serve the live
           snapshot below, same as if ?at= had been absent. */
      }
      if (!snapshot) rebuild();
      /* Even after that attempt, `snapshot` can still be null: state (c)
         above, nothing has ever built successfully. Serving 200 with the
         four-byte body `null` here is exactly the bug this task fixes - a
         caller doing `JSON.parse(body).session` gets a TypeError, or worse,
         a falsy-but-"successful" read that looks like zero usage. Answer a
         5xx that names the failure instead, so a caller can tell "nothing
         built yet" apart from "here is a real snapshot". */
      if (!snapshot) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'no snapshot has ever been built' +
            (lastRebuildError ? ': ' + lastRebuildError : '')
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    /* Reaching here means OUR code threw on a request we thought we handled
       correctly - not a caller-input problem, which is caught and answered
       above and never falls through to here. build() is the likeliest
       source: a transcript/fixture shape this server does not expect. Answer
       5xx and keep the process alive for the next request, rather than
       taking the whole feed down over it. */
    console.error('request handler error:', (err && err.stack) || err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    } else {
      res.end();
    }
  }
});

/* Last-resort net, not the primary fix - the try/catch above is, since it
   answers the right status code and knows which request failed. This
   exists for whatever is NOT inside that try/catch: an exception thrown
   asynchronously (e.g. after res.end() has already returned control, or from
   a callback the http/net internals invoke outside this request's own call
   stack) still reaches node as 'uncaughtException' and would otherwise take
   the whole process down exactly like the bug this task fixes.
   start-hidden.vbs runs this with no restart supervision (a separate,
   deliberately out-of-scope change - see the task notes), so for THIS
   process, staying up in a possibly-degraded state is strictly better than
   the guaranteed alternative: total silence until the next sign-in. This
   must not silently swallow - it logs with a stack - and it must not paper
   over a truly broken process: it does not touch res/req (that request is
   already lost, and guessing at its state would be the "worse than the
   crash" bug this task explicitly warns against), it does not retry
   anything, and rebuild()'s own try/catch plus the 10s setInterval already
   self-heal the one piece of process-wide state (snapshot) that a stray
   throw could leave stale. */
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (process kept alive):', (err && err.stack) || err);
});

/* A test server must not poll Anthropic. Without this guard every spawned test
   server made a real request to an endpoint that is already rate-limited - which
   is exactly what the fixture tests were doing while being described as costing
   nothing. Unset in normal use. */
if (process.env.CLAUDE_USAGE_NO_REMOTE) {
  officialState = { ok: false, fetchedAt: Date.now(), error: 'remote polling disabled (CLAUDE_USAGE_NO_REMOTE)' };
  /* Still lets a test reach watchCredentials() itself - fetchOfficialResult()
     above already keeps every fetch it triggers hermetic under NO_REMOTE, and
     an explicit CLAUDE_USAGE_CREDENTIALS_FILE means a test opted in and is
     pointing it at a fixture, never the real ~/.claude. Without that opt-in
     (every other suite) this is unreached, exactly as before. */
  if (process.env.CLAUDE_USAGE_CREDENTIALS_FILE) watchCredentials();
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
