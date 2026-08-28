/* Anthropic's own utilisation figures — the numbers Claude Code's /usage panel
 * shows, rather than anything inferred from local transcripts.
 *
 * GET https://api.anthropic.com/api/oauth/usage with the OAuth access token
 * Claude Code already stores in ~/.claude/.credentials.json.
 *
 * This is an UNDOCUMENTED internal endpoint. It can change or disappear without
 * notice, so every failure is non-fatal: the caller keeps serving the measured
 * numbers and records why this went missing.
 *
 * The token is read into memory, used for one Authorization header, and never
 * logged, echoed into the JSON, or written anywhere.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');
const HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const PROFILE_PATH = '/api/oauth/profile';
const TIMEOUT_MS = 8000;

/* Two possible sources, tried in this order.
 *
 * 1. ~/.claude/.credentials.json — written by `claude auth login`. Its token
 *    carries user:profile, which this endpoint requires, so it is the one that
 *    actually works. It expires, and Claude Code does not always rewrite the
 *    file when it refreshes.
 * 2. CLAUDE_CODE_OAUTH_TOKEN — from `claude setup-token`. Long-lived, but as of
 *    testing it is inference-scoped and the endpoint rejects it with
 *    "OAuth token does not meet scope requirement user:profile". Kept as a
 *    fallback so a profile-scoped token would be picked up automatically.
 */
function readTokens() {
  const sources = [];

  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
    const o = parsed && parsed.claudeAiOauth;
    if (o && o.accessToken) {
      sources.push({
        name: 'credentials file',
        token: o.accessToken,
        expiresAt: o.expiresAt || null,
        scopes: Array.isArray(o.scopes) ? o.scopes : null
      });
    }
  } catch (err) {
    /* Missing or unreadable is normal on a machine that uses the env var. */
  }

  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (fromEnv) {
    sources.push({ name: 'CLAUDE_CODE_OAUTH_TOKEN', token: fromEnv, expiresAt: null, scopes: null });
  }

  return sources;
}

function get(pathname, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST,
      path: pathname,
      method: 'GET',
      headers: {
        /* Mirrors what Claude Code itself sends. The beta header is what marks
           the request as OAuth rather than API-key authenticated. */
        'Authorization': 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'xeneon-edge-widgets/usage-server',
        'Accept': 'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          /* Anthropic's structured error message is the most useful thing here
             - a 403 names the missing scope - so it is extracted rather than
             swallowed. Only error.message is taken, never the raw body, so a
             response cannot echo anything unexpected into logs. */
          let detail = '';
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.error && typeof parsed.error.message === 'string') {
              detail = ' — ' + parsed.error.message;
            }
          } catch (err) { /* non-JSON error body */ }
          reject(new Error('HTTP ' + res.statusCode + detail));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('malformed JSON from ' + pathname));
        }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function window_(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  const resets = w.resets_at ? Date.parse(w.resets_at) : null;
  return {
    percent: Math.round(w.utilization),
    utilization: w.utilization,
    resetsAt: Number.isFinite(resets) ? resets : null
  };
}

/* Returns a plain object; never throws. Tries every available token source and
   reports the failure of the last one if none succeed. */
async function fetchOfficial() {
  const sources = readTokens();
  if (!sources.length) {
    return {
      ok: false,
      fetchedAt: Date.now(),
      error: 'no token: neither ' + CREDENTIALS + ' nor CLAUDE_CODE_OAUTH_TOKEN'
    };
  }

  let last = null;
  for (const source of sources) {
    const result = await trySource(source);
    if (result.ok) return result;
    last = result;
  }
  return last;
}

async function trySource(cred) {
  const expired = cred.expiresAt && cred.expiresAt < Date.now();

  try {
    const usage = await get(USAGE_PATH, cred.token);

    /* Anything the panel breaks out separately - Opus, Sonnet, Fable, Cowork -
       arrives as its own seven_day_* key, present only when it applies. */
    const buckets = Object.keys(usage)
      .filter(k => k.indexOf('seven_day_') === 0 && usage[k])
      .map(k => {
        const w = window_(usage[k]);
        if (!w) return null;
        w.label = k.replace('seven_day_', '').replace(/_/g, ' ');
        return w;
      })
      .filter(Boolean);

    let plan = null;
    try {
      const profile = await get(PROFILE_PATH, cred.token);
      const org = profile && profile.organization;
      if (org && org.rate_limit_tier) plan = org.rate_limit_tier;
    } catch (err) {
      /* The plan label is a nicety; usage is the point. */
    }

    return {
      ok: true,
      fetchedAt: Date.now(),
      source: cred.name,
      tokenExpiresAt: cred.expiresAt || null,
      fiveHour: window_(usage.five_hour),
      sevenDay: window_(usage.seven_day),
      buckets,
      extraUsage: usage.extra_usage || null,
      planTier: plan
    };
  } catch (err) {
    return {
      ok: false,
      fetchedAt: Date.now(),
      source: cred.name,
      tokenExpiresAt: cred.expiresAt || null,
      /* A 401 on an expired token is the ordinary case, worth saying plainly:
         Claude Code rewrites the file when it next refreshes. */
      error: cred.name + ': ' + (expired
        ? 'access token expired ' + new Date(cred.expiresAt).toISOString() + ' (' + err.message + ')'
        : err.message)
    };
  }
}

module.exports = { fetchOfficial };
