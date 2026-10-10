/* A DIAGNOSTIC view of the /perf feed: what the sampler says, with the source
 * and the age of the sample next to it. A reading that was not taken is null
 * and renders as N/A - never 0, because 0 % GPU is a real reading.
 *
 * Same shape as taskshtml.js: esc() on every interpolation, one
 * <table class="grid">, a meta refresh, no dependency.
 */
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function val(v, unit, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'N/A';
  return v.toFixed(digits) + unit;
}

function age(at, now) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'no sample yet';
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s + 's ago';
}

const STYLE =
  'body{font:13px/1.45 system-ui,sans-serif;margin:24px;background:#14161a;color:#e8e6e1}' +
  'h1{font-size:18px;margin:0 0 2px}' +
  'p.sub{color:#8d949e;margin:0 0 18px}' +
  'table.grid{border-collapse:collapse;margin:0 0 8px;width:100%;max-width:600px}' +
  'table.grid th,table.grid td{border-bottom:1px solid #2a2f37;padding:4px 10px 4px 0;text-align:left}' +
  'table.grid th{color:#8d949e;font-weight:600}' +
  '.na{color:#8d949e}';

function render(snapshot, now) {
  const s = snapshot || {};
  const t = typeof now === 'number' ? now : Date.now();
  const rows = [
    ['FPS', val(s.fps, '', 0)],
    ['GPU', val(s.gpu, ' %', 0)],
    ['CPU', val(s.cpu, ' %', 0)],
    ['Latency', val(s.lat, ' ms', 1)],
    ['Process', s.process == null ? 'N/A' : esc(s.process)]
  ];
  const cell = (v) => v === 'N/A' ? '<span class="na">N/A</span>' : v;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<title>Performance — debug</title>' +
    '<meta http-equiv="refresh" content="5" />' +
    '<style>' + STYLE + '</style></head><body>' +
    '<h1>Performance</h1>' +
    '<p class="sub">This page shows what the <code>/perf</code> feed says.</p>' +
    '<table class="grid"><thead><tr><th>metric</th><th>value</th></tr></thead><tbody>' +
    rows.map(r => '<tr><td>' + esc(r[0]) + '</td><td>' + cell(r[1]) + '</td></tr>').join('') +
    '<tr><td>Source</td><td>' + esc(s.source == null ? 'N/A' : s.source) + '</td></tr>' +
    '<tr><td>Sample age</td><td>' + esc(age(s.at, t)) + '</td></tr>' +
    '</tbody></table></body></html>';
}

module.exports = { render };
