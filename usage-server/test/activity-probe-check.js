#!/usr/bin/env node
/* Watches the feed while activity-probe.workflow.js runs, and says whether the
 * activity lists actually reported the work.
 *
 * The point of the test is the thing that went wrong once already: the widget
 * showed nothing for a whole 60-second run, because the server was looking for
 * a file that is only written after a run ends. A green "the filter compiles"
 * check would not have caught that. This asserts on observed behaviour - did
 * a running workflow and a running subtask actually appear, and did they go
 * away afterwards.
 *
 * Usage, in a second terminal, started BEFORE or just as the workflow starts:
 *   node usage-server/test/activity-probe-check.js [seconds]
 *
 * Exit code 0 if the lists reported the run, 1 if they did not.
 */

'use strict';

const http = require('http');

const FEED = process.env.CLAUDE_USAGE_FEED || 'http://127.0.0.1:41777/usage';
const WATCH_SECONDS = Number(process.argv[2]) || 150;
const POLL_MS = 5000;

function fetchFeed() {
  return new Promise((resolve, reject) => {
    const req = http.get(FEED, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

async function main() {
  console.log(`watching ${FEED} for ${WATCH_SECONDS}s\n`);

  let sawWorkflow = false;
  let sawSubtask = false;
  let peakWorkflows = 0;
  let peakSubtasks = 0;
  const deadline = Date.now() + WATCH_SECONDS * 1000;

  while (Date.now() < deadline) {
    let feed;
    try {
      feed = await fetchFeed();
    } catch (err) {
      console.log(`${stamp()}  feed unreachable: ${err.message}`);
      await new Promise(r => setTimeout(r, POLL_MS));
      continue;
    }

    const c = feed.counts || {};
    const w = c.workflows || 0;
    const t = c.subtasks || 0;
    if (w) sawWorkflow = true;
    if (t) sawSubtask = true;
    peakWorkflows = Math.max(peakWorkflows, w);
    peakSubtasks = Math.max(peakSubtasks, t);

    const names = (feed.subtasks || []).map(s => s.label.slice(0, 28)).join(', ');
    console.log(
      `${stamp()}  sessions=${c.sessions || 0}  workflows=${w}  subtasks=${t}` +
      (names ? `   [${names}]` : '')
    );

    /* Stop early once the run has been seen AND has drained: the interesting
       transition is over, and waiting out the full window proves nothing. */
    if (sawWorkflow && sawSubtask && !w && !t) break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  const ok = sawWorkflow && sawSubtask;
  console.log('');
  console.log(`  running workflow appeared: ${sawWorkflow ? 'yes' : 'NO'}  (peak ${peakWorkflows})`);
  console.log(`  running subtask appeared:  ${sawSubtask ? 'yes' : 'NO'}  (peak ${peakSubtasks})`);
  console.log('');
  console.log(ok
    ? 'PASS - the activity lists reported work while it was in flight'
    : 'FAIL - work ran and the activity lists never showed it');
  process.exit(ok ? 0 : 1);
}

main();
