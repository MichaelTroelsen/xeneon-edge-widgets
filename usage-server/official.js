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
const BACKUP = CREDENTIALS + '.before-usage-server';
const HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
const PROFILE_PATH = '/api/oauth/profile';
const TIMEOUT_MS = 8000;

/* Anthropic's public OAuth client for CLI tools, and the endpoint that mints a
   new access token from a refresh token. The scope set for this client is
   "org:create_api_key user:profile user:inference" — user:profile is the one
   /api/oauth/usage requires. */
const TOKEN_HOST = 'console.anthropic.com';
const TOKEN_PATH = '/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/* Refresh a minute early: a token that expires mid-request is a wasted round
   trip and a confusing 401. */
const EXPIRY_MARGIN_MS = 60000;

let refreshInFlight = null;
let lastRefresh = { at: null, ok: null, error: null };

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

function postJson(host, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      host,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json',
        'User-Agent': 'xeneon-edge-widgets/usage-server'
      }
    }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let detail = '';
          try {
            const parsed = JSON.parse(out);
            const msg = parsed && (parsed.error_description || parsed.error && parsed.error.message || parsed.error);
            if (typeof msg === 'string') detail = ' — ' + msg;
          } catch (err) { /* non-JSON error body */ }
          reject(new Error('HTTP ' + res.statusCode + detail));
          return;
        }
        try {
          resolve(JSON.parse(out));
        } catch (err) {
          reject(new Error('malformed JSON from ' + pathname));
        }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

/* Write the credentials file the way Claude Code would: same shape, same path,
   replaced atomically so a crash mid-write cannot truncate it. A one-time
   backup is kept beside it the first time this runs. */
function writeCredentials(parsed) {
  if (!fs.existsSync(BACKUP)) {
    try {
      fs.copyFileSync(CREDENTIALS, BACKUP);
    } catch (err) { /* best effort; not a reason to abort the refresh */ }
  }
  const tmp = CREDENTIALS + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDENTIALS);
}

/* Exchange the refresh token for a new access token.
 *
 * The response carries a NEW refresh token - refreshing rotates it - so the
 * result has to be written back to the same file Claude Code reads, or its copy
 * becomes the stale one. That write-back is what keeps both sides in sync.
 */
async function refreshCredentials() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
    } catch (err) {
      throw new Error('cannot read credentials file to refresh');
    }
    const o = parsed && parsed.claudeAiOauth;
    if (!o || !o.refreshToken) throw new Error('no refresh token in credentials file');
    if (o.refreshTokenExpiresAt && o.refreshTokenExpiresAt < Date.now()) {
      throw new Error('refresh token itself expired — run: claude auth login');
    }

    const tokens = await postJson(TOKEN_HOST, TOKEN_PATH, {
      grant_type: 'refresh_token',
      refresh_token: o.refreshToken,
      client_id: CLIENT_ID
    });

    if (!tokens || !tokens.access_token) throw new Error('refresh response had no access_token');

    o.accessToken = tokens.access_token;
    if (tokens.refresh_token) o.refreshToken = tokens.refresh_token;
    if (tokens.expires_in) o.expiresAt = Date.now() + tokens.expires_in * 1000;
    parsed.claudeAiOauth = o;

    writeCredentials(parsed);
    lastRefresh = { at: Date.now(), ok: true, error: null };
    return o.accessToken;
  })().catch(err => {
    lastRefresh = { at: Date.now(), ok: false, error: err.message };
    throw err;
  }).then(v => { refreshInFlight = null; return v; },
          e => { refreshInFlight = null; throw e; });

  return refreshInFlight;
}

/* Refresh ahead of expiry so the usual path never sees a 401 at all. */
async function refreshIfNeeded() {
  let o;
  try {
    o = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8')).claudeAiOauth;
  } catch (err) {
    return;
  }
  if (!o || !o.refreshToken) return;
  const due = !o.accessToken || !o.expiresAt || o.expiresAt < Date.now() + EXPIRY_MARGIN_MS;
  if (!due) return;
  try {
    await refreshCredentials();
  } catch (err) { /* reported through lastRefresh and the fetch error below */ }
}

/* Returns a plain object; never throws. Tries every available token source and
   reports the failure of the last one if none succeed. */
async function fetchOfficial() {
  await refreshIfNeeded();
  const sources = readTokens();
  if (!sources.length) {
    return {
      ok: false,
      fetchedAt: Date.now(),
      error: 'no token: neither ' + CREDENTIALS + ' nor CLAUDE_CODE_OAUTH_TOKEN'
    };
  }

  const failures = [];
  for (const source of sources) {
    let result = await trySource(source);

    /* A 401 despite a token that looked current means the server disagrees with
       our expiry - refresh once and retry rather than waiting out the backoff. */
    if (!result.ok && source.name === 'credentials file' && /HTTP 401/.test(result.error || '')) {
      try {
        const token = await refreshCredentials();
        result = await trySource({ name: 'credentials file (refreshed)', token, expiresAt: null });
      } catch (err) {
        result.error = result.error + '; refresh failed: ' + err.message;
      }
    }

    if (result.ok) return result;
    failures.push(result.error);

    /* A 429 is about the caller, not the credential. Trying the next token
       would add load and then report the wrong cause - the first run after
       this fix blamed a scope error on a token that was never the problem. */
    if (/HTTP 429/.test(result.error || '')) break;
  }

  return {
    ok: false,
    fetchedAt: Date.now(),
    error: failures.join(' | '),
    lastRefresh: lastRefresh
  };
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
