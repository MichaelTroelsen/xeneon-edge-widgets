/* Human-readable debug view of the feed, served at /usagehtml.
 *
 * An addition to the JSON, not a replacement: /usage is unchanged and remains
 * what the widget consumes. This page exists to answer "what does the server
 * actually think, and where does that disagree with Claude's own panel" without
 * reading raw JSON.
 */
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(n) {
  return (n == null || Number.isNaN(n)) ? '—' : Math.round(n).toLocaleString('en-US');
}

function compact(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

function clock(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = n => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function ago(ms) {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function until(ms) {
  if (!ms) return '—';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'now';
  const h = Math.floor(s / 3600);
  const m = Math.round((s - h * 3600) / 60);
  return h > 0 ? ('in ' + h + 'h ' + m + 'm') : ('in ' + m + 'm');
}

function bar(value, reference) {
  const pct = reference > 0 ? Math.min(100, (value / reference) * 100) : 0;
  return '<div class="track"><div class="fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
    '<div class="barnote">' + pct.toFixed(0) + '% of ' + compact(reference) + '</div>';
}

function tokenTable(t) {
  if (!t) return '<p class="muted">no data</p>';
  const rows = [
    ['output', t.output],
    ['cache creation', t.cacheCreation],
    ['cache read', t.cacheRead],
    ['input', t.input]
  ];
  const total = t.total || 1;
  return '<table class="tok"><tbody>' + rows.map(function (r) {
    return '<tr><th>' + r[0] + '</th><td class="n">' + num(r[1]) + '</td>' +
      '<td class="n muted">' + (r[1] / total * 100).toFixed(1) + '%</td></tr>';
  }).join('') +
    '<tr class="sum"><th>total</th><td class="n">' + num(t.total) + '</td><td></td></tr>' +
    '<tr><th>messages</th><td class="n">' + num(t.messages) + '</td><td></td></tr>' +
    '</tbody></table>';
}

function modelTable(t) {
  if (!t || !t.byModel) return '';
  const names = Object.keys(t.byModel).sort(function (a, b) {
    return t.byModel[b].weighted - t.byModel[a].weighted;
  });
  if (!names.length) return '';
  return '<table class="grid"><thead><tr><th>model</th><th class="n">messages</th>' +
    '<th class="n">output</th><th class="n">weighted</th></tr></thead><tbody>' +
    names.map(function (m) {
      const v = t.byModel[m];
      return '<tr><td>' + esc(m) + '</td><td class="n">' + num(v.messages) + '</td>' +
        '<td class="n">' + num(v.output) + '</td><td class="n">' + num(v.weighted) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function listTable(rows, cols) {
  if (!rows || !rows.length) return '<p class="muted">nothing recent</p>';
  return '<table class="grid"><thead><tr>' +
    cols.map(function (c) { return '<th' + (c.n ? ' class="n"' : '') + '>' + esc(c.label) + '</th>'; }).join('') +
    '</tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr>' + cols.map(function (c) {
        return '<td' + (c.n ? ' class="n"' : '') + '>' + c.get(r) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table>';
}

function render(snapshot, cfg) {
  const s = snapshot || {};
  const session = s.session || {};
  const weekly = s.weekly || {};

  const head = '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<title>Claude usage feed — debug</title>' +
    '<meta http-equiv="refresh" content="30" />' +
    '<style>' +
    ':root{--bg:#16161a;--panel:#1e1e23;--line:#2e2e35;--text:#eceaf3;--muted:#9a98a6;' +
    '--fill:#5b8def;--ok:#57c785;--warn:#e0a458;--bad:#e0685f}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;padding:28px;background:var(--bg);color:var(--text);' +
    'font:14px/1.55 "Segoe UI",system-ui,sans-serif}' +
    'h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;' +
    'letter-spacing:.08em;color:var(--muted);margin:28px 0 10px}' +
    '.sub{color:var(--muted);margin:0 0 22px}' +
    '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}' +
    '.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}' +
    '.card h3{margin:0 0 2px;font-size:15px}' +
    '.big{font-size:30px;font-weight:600;font-variant-numeric:tabular-nums;margin:6px 0 2px}' +
    '.track{height:8px;border-radius:99px;background:var(--line);overflow:hidden;margin:10px 0 4px}' +
    '.fill{height:100%;background:var(--fill);border-radius:99px}' +
    '.barnote,.muted{color:var(--muted);font-size:12px}' +
    'table{border-collapse:collapse;width:100%;margin-top:8px}' +
    'th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}' +
    'thead th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}' +
    '.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}' +
    '.tok th{color:var(--muted);font-weight:400}' +
    '.tok .sum th,.tok .sum td{border-top:1px solid var(--line);font-weight:600}' +
    '.pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;' +
    'border:1px solid var(--line);color:var(--muted)}' +
    '.pill.running{color:var(--ok);border-color:var(--ok)}' +
    '.warnbox{background:#2a2118;border:1px solid var(--warn);border-radius:10px;' +
    'padding:12px 14px;margin:18px 0;color:#f0d9b8}' +
    '.warnbox b{color:var(--warn)}' +
    'code{background:#000;padding:1px 5px;border-radius:4px;font-size:12px}' +
    'a{color:var(--fill)}' +
    '</style></head><body>';

  const generated = s.generatedAt;

  let html = head +
    '<h1>Claude usage feed — debug</h1>' +
    '<p class="sub">' + esc(s.plan || '') + ' · rebuilt ' + clock(generated) + ' (' + ago(generated) + ')' +
    ' · reading ' + num((s.counts || {}).messages) + ' messages · page refreshes every 30s</p>';

  /* --- Anthropic's own figures --- */
  const off = s.official || {};
  if (off.ok) {
    html += '<h2>Anthropic (live)</h2><div class="cards">';
    const rows = [];
    if (off.fiveHour) rows.push(['5-hour session', off.fiveHour]);
    if (off.sevenDay) rows.push(['7-day, all models', off.sevenDay]);
    (off.buckets || []).forEach(function (b) { rows.push(['7-day, ' + b.label, b]); });
    html += '<div class="card"><h3>Utilisation</h3><table class="grid"><thead><tr>' +
      '<th>window</th><th class="n">used</th><th class="n">resets</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + esc(r[0]) + '</td><td class="n">' + r[1].utilization + '%</td>' +
          '<td class="n">' + esc(clock(r[1].resetsAt)) + ' (' + until(r[1].resetsAt) + ')</td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="muted" style="margin-top:8px">read ' + ago(off.fetchedAt) +
      ' from <code>api.anthropic.com/api/oauth/usage</code>' +
      (off.planTier ? ' · tier ' + esc(off.planTier) : '') + '</div></div>';
    if (off.extraUsage) {
      html += '<div class="card"><h3>Extra usage</h3><table class="grid"><tbody>' +
        '<tr><th>enabled</th><td>' + (off.extraUsage.is_enabled ? 'yes' : 'no') + '</td></tr>' +
        '<tr><th>monthly limit</th><td class="n">' + num(off.extraUsage.monthly_limit) + '</td></tr>' +
        '<tr><th>used credits</th><td class="n">' + num(off.extraUsage.used_credits) + '</td></tr>' +
        '</tbody></table></div>';
    }
    html += '</div>';
  } else {
    html += '<div class="warnbox"><b>Anthropic\'s own figures are unavailable.</b> ' +
      esc(off.error || 'not fetched') +
      '. The widget is showing measured token counts instead. The OAuth token is read from ' +
      '<code>~/.claude/.credentials.json</code>; Claude Code rewrites that file when it refreshes, ' +
      'and this recovers on its own once it does.</div>';
  }

  html += '<div class="warnbox"><b>The local percentages below are not reliable.</b> They divide ' +
    'measured tokens by a budget calibrated at one moment. Checked against Claude\'s own panel, no ' +
    'weighting of these token counts reproduces it — measured growth between two windows was ' +
    '4.3×–9.2× per class while the panel charged 3.5×. Everything else on this page is measured.</div>';

  /* --- windows --- */
  html += '<h2>Windows</h2><div class="cards">';

  html += '<div class="card"><h3>Current 5-hour block</h3>' +
    '<div class="muted">' + (session.active ? clock(session.startsAt) + ' → ' + clock(session.resetsAt) : 'no active block') + '</div>' +
    '<div class="big">' + compact((session.tokens || {}).total) + ' tokens</div>' +
    '<div class="muted">resets ' + until(session.resetsAt) + '</div>' +
    bar(session.usedWeighted, session.peakWeighted || session.usedWeighted) +
    '<div class="barnote">bar is against your busiest complete block in the last 8 days — not a limit</div>' +
    tokenTable(session.tokens) +
    '<div class="muted" style="margin-top:8px">weighted ' + num(session.usedWeighted) +
    ' · estimated ' + (session.percent == null ? '—' : session.percent + '%') + '</div>' +
    modelTable(session.tokens) +
    '</div>';

  html += '<div class="card"><h3>This week</h3>' +
    '<div class="muted">' + clock(weekly.startsAt) + ' → ' + clock(weekly.resetsAt) + '</div>' +
    '<div class="big">' + compact((weekly.tokens || {}).total) + ' tokens</div>' +
    '<div class="muted">resets ' + until(weekly.resetsAt) + '</div>' +
    tokenTable(weekly.tokens) +
    '<div class="muted" style="margin-top:8px">weighted ' + num(weekly.usedWeighted) +
    ' · estimated ' + (weekly.percent == null ? '—' : weekly.percent + '%') + '</div>' +
    modelTable(weekly.tokens) +
    '</div>';

  html += '</div>';

  /* --- sessions --- */
  html += '<h2>Sessions (' + ((s.sessions || []).length) + ' active of ' +
    num((s.counts || {}).sessionsSeen) + ' seen)</h2>' +
    listTable(s.sessions, [
      { label: '', get: r => '<span class="pill ' + esc(r.state) + '">' + esc(r.state) + '</span>' },
      { label: 'label', get: r => esc(r.label) },
      { label: 'project', get: r => esc(r.project) },
      { label: 'messages', n: true, get: r => num(r.messages) },
      { label: 'weighted', n: true, get: r => num(r.tokens) },
      { label: 'last activity', n: true, get: r => esc(clock(r.lastAt) + ' (' + ago(r.lastAt) + ')') }
    ]);

  /* --- workflows --- */
  html += '<h2>Workflows (' + ((s.workflows || []).length) + ' active of ' +
    num((s.counts || {}).workflowsSeen) + ' seen)</h2>' +
    listTable(s.workflows, [
      { label: '', get: r => '<span class="pill ' + esc(r.status) + '">' + esc(r.status) + '</span>' },
      { label: 'name', get: r => esc(r.name) },
      { label: 'summary', get: r => esc(r.summary) },
      { label: 'project', get: r => esc(r.project) },
      { label: 'agents', n: true, get: r => num(r.agents) },
      { label: 'tokens', n: true, get: r => num(r.tokens) },
      { label: 'started', n: true, get: r => esc(clock(r.startedAt)) }
    ]);

  /* --- subtasks --- */
  html += '<h2>Subtasks (' + ((s.subtasks || []).length) + ' active of ' +
    num((s.counts || {}).subtasksSeen) + ' seen, ' + num((s.counts || {}).queued) + ' queued)</h2>' +
    listTable(s.subtasks, [
      { label: '', get: r => '<span class="pill ' + esc(r.state) + '">' + esc(r.state) + '</span>' },
      { label: 'label', get: r => esc(r.label) },
      { label: 'model', get: r => esc(r.model) },
      { label: 'workflow', get: r => esc(r.workflow) },
      { label: 'project', get: r => esc(r.project) },
      { label: 'tokens', n: true, get: r => num(r.tokens) },
      { label: 'tools', n: true, get: r => num(r.toolCalls) }
    ]);

  /* --- config in force --- */
  const w = (cfg && cfg.tokenWeights) || {};
  html += '<h2>Config in force</h2><table class="grid"><tbody>' +
    '<tr><th>plan label</th><td>' + esc(cfg.planLabel) + '</td></tr>' +
    '<tr><th>weights</th><td>output ×' + w.output + ' · input ×' + w.input +
      ' · cache creation ×' + w.cacheCreation + ' · cache read ×' + w.cacheRead + '</td></tr>' +
    '<tr><th>session budget</th><td class="n">' + num(cfg.sessionBudgetWeightedTokens) + '</td></tr>' +
    '<tr><th>weekly budget</th><td class="n">' + num(cfg.weeklyBudgetWeightedTokens) +
      (cfg.weeklyBoost ? ' (×' + cfg.weeklyBoost.multiplier + ' until ' + esc(cfg.weeklyBoost.until) + ')' : '') + '</td></tr>' +
    '<tr><th>weekly anchor</th><td>weekday ' + (cfg.weeklyAnchor || {}).weekday +
      ' at ' + (cfg.weeklyAnchor || {}).hour + ':00 local</td></tr>' +
    '</tbody></table>';

  html += '<h2>Endpoints</h2><table class="grid"><tbody>' +
    '<tr><th><code>/usage</code></th><td>the JSON the widget reads — unchanged</td></tr>' +
    '<tr><th><code>/usage?at=…</code></th><td>snapshot as of a past moment, for calibration</td></tr>' +
    '<tr><th><code>/health</code></th><td>liveness and last build time</td></tr>' +
    '<tr><th><code>/usagehtml</code></th><td>this page</td></tr>' +
    '</tbody></table>';

  return html + '</body></html>';
}

module.exports = { render };
