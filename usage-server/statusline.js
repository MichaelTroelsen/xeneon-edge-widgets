/* Reading Anthropic's utilisation without asking Anthropic for it.
 *
 * Claude Code hands its statusline script a JSON object on stdin, and since
 * v2.1.80 that object carries `rate_limits` - the same five-hour and seven-day
 * figures the /usage panel shows, already fetched by Claude Code itself. A
 * statusline wrapper (statusline-tee.js) writes them to a file; this module
 * reads it back.
 *
 * Why this exists at all: /api/oauth/usage rate-limits so aggressively that a
 * single request can exhaust it, and the resulting 429 carries `retry-after: 0`
 * and persists for hours - anthropics/claude-code#30930, still open. Backing
 * off further does not help, because the limit is not really about our cadence.
 * This path costs zero requests, so it cannot be throttled at all.
 *
 * The catch, and the reason the OAuth path stays: these figures only arrive
 * while a Claude Code session is open and rendering its statusline. With no
 * session running the file simply stops being updated, which is why a reading
 * ages out here rather than being trusted indefinitely.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/* Overridable so the freshness rules can be tested against fixtures rather
   than against whatever the real statusline happens to have written. */
const FILE = process.env.CLAUDE_USAGE_STATUSLINE_FILE ||
  path.join(os.homedir(), '.claude', 'statusline-usage.json');

/* Past this a reading stops being shown at all. Utilisation only climbs within
   a window, so an old reading is not wrong so much as an undercount - but an
   undercount presented as live is exactly the failure mode this project spent
   a session removing. */
const MAX_AGE_MS = 45 * 60 * 1000;
/* Before this it is simply current: a statusline re-renders constantly while a
   session is open, so anything recent is as live as the panel itself. */
const FRESH_MS = 10 * 60 * 1000;

let cache = null;
let cacheMtime = 0;

/* The statusline gives percentages and an epoch-seconds reset. official.js
   produces percent/utilisation/resetsAt-in-milliseconds, and the widget reads
   that shape - so convert here rather than teaching the widget two dialects. */
function window_(w) {
  if (!w || typeof w.used_percentage !== 'number') return null;
  return {
    percent: Math.round(w.used_percentage),
    utilization: w.used_percentage,
    resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null
  };
}

/* Returns a reading in the same shape official.js returns on success, or null
   when there is nothing usable. Never throws: a missing or half-written file is
   an ordinary state, not an error worth propagating into the snapshot. */
function read(now) {
  let raw;
  try {
    const stat = fs.statSync(FILE);
    if (cache && stat.mtimeMs === cacheMtime) {
      raw = cache;
    } else {
      raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cache = raw;
      cacheMtime = stat.mtimeMs;
    }
  } catch (err) {
    return null;
  }

  const at = Number(raw && raw.capturedAt);
  if (!Number.isFinite(at)) return null;
  const age = now - at;
  /* A clock that moved backwards, or a file written by a future run, would
     otherwise read as infinitely fresh. */
  if (age < 0 || age > MAX_AGE_MS) return null;

  const limits = raw.rateLimits || {};
  const fiveHour = window_(limits.five_hour);
  const sevenDay = window_(limits.seven_day);
  /* Claude Code drops a window once its resets_at passes, and omits both until
     the first API response of a session, so neither is guaranteed. */
  if (!fiveHour && !sevenDay) return null;

  const stale = age > FRESH_MS;
  return {
    ok: true,
    fetchedAt: at,
    source: 'Claude Code statusline',
    tokenExpiresAt: null,
    fiveHour,
    sevenDay,
    buckets: null,
    extraUsage: null,
    planTier: null,
    stale: stale || undefined,
    staleSince: stale ? at : undefined,
    error: stale ? 'no Claude Code session has rendered a statusline since' : undefined
  };
}

module.exports = { read, FILE, MAX_AGE_MS };
