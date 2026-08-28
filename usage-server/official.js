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

function readToken() {
  let raw;
  try {
    raw = fs.readFileSync(CREDENTIALS, 'utf8');
  } catch (err) {
    return { error: 'no credentials file at ' + CREDENTIALS };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: 'credentials file is not valid JSON' };
  }
  const o = parsed && parsed.claudeAiOauth;
  if (!o || !o.accessToken) return { error: 'no claudeAiOauth.accessToken in credentials' };
  return { token: o.accessToken, expiresAt: o.expiresAt || null };
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
          /* Deliberately does not include the body verbatim in case an error
             response echoes anything sensitive. */
          reject(new Error('HTTP ' + res.statusCode));
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

/* Returns a plain object; never throws. */
async function fetchOfficial() {
  const cred = readToken();
  if (cred.error) return { ok: false, error: cred.error, fetchedAt: Date.now() };

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
      tokenExpiresAt: cred.expiresAt || null,
      /* A 401 on an expired token is the ordinary case, worth saying plainly:
         Claude Code rewrites the file when it next refreshes. */
      error: expired
        ? 'access token expired ' + new Date(cred.expiresAt).toISOString() + ' (' + err.message + ')'
        : err.message
    };
  }
}

module.exports = { fetchOfficial };
