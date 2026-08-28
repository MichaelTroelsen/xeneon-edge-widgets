#!/usr/bin/env node
/* A statusline wrapper that keeps a copy of the rate-limit figures.
 *
 * Claude Code pipes a JSON session object into whatever `statusLine.command`
 * names, and expects the command's stdout back. This script sits in front of
 * the real statusline: it saves `rate_limits` from that JSON to a file for
 * usage-server to read, then runs the original command with the same stdin and
 * passes its output straight through.
 *
 * Usage, as statusLine.command:
 *
 *   node <path>/statusline-tee.js npx -y ccstatusline@latest
 *
 * Everything after the script path is the real statusline command. With no
 * command it just captures and prints nothing, which is a valid statusline.
 *
 * The one rule here: never break the statusline. Every failure path still runs
 * the wrapped command, because a missing usage figure on a widget is a small
 * problem and a broken status bar in every session is not.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const OUT = path.join(os.homedir(), '.claude', 'statusline-usage.json');

function save(json) {
  const limits = json && json.rate_limits;
  /* Absent for API-key users, and for subscribers until the session's first
     API response. Keeping the previous file is right: it is a real reading
     that has not been superseded, and statusline.js ages it out on its own. */
  if (!limits || typeof limits !== 'object') return;

  const payload = {
    capturedAt: Date.now(),
    rateLimits: limits,
    /* Provenance, so the file is diagnosable on its own. */
    claudeCodeVersion: json.version || null,
    sessionId: json.session_id || null
  };

  /* Written atomically because usage-server reads this on a timer and would
     otherwise eventually catch a half-written file. The temp name carries the
     pid so two sessions rendering at once cannot collide. */
  const tmp = OUT + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, OUT);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* nothing left to clean up */ }
  }
}

/* spawn() with shell:true does not escape an args array, it concatenates it -
   so a wrapped command containing a spaced path would be re-split by the shell
   into the wrong arguments. Rebuild one command string with the quoting the
   platform's shell actually uses, and hand over that. */
function quote(arg) {
  if (!/[\s"'&|<>^()%!]/.test(arg)) return arg;
  if (process.platform === 'win32') return '"' + arg.replace(/"/g, '""') + '"';
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function run(input) {
  const argv = process.argv.slice(2);
  if (!argv.length) return;

  /* shell:true because the usual inner command is `npx`, which on Windows is a
     .cmd shim that CreateProcess will not run directly. */
  const child = spawn(argv.map(quote).join(' '), {
    shell: true,
    stdio: ['pipe', 'inherit', 'inherit']
  });
  child.on('error', () => process.exit(0));
  child.on('close', code => process.exit(code === null ? 0 : code));
  child.stdin.on('error', () => { /* inner command exited without reading */ });
  child.stdin.end(input);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    save(JSON.parse(input));
  } catch (err) {
    /* Not JSON, or no rate limits in it. Pass it on regardless. */
  }
  run(input);
});
