#!/usr/bin/env node
/* Tests live workflow/subtask detection against a fixture tree.
 *
 * The end-to-end probe (activity-probe.workflow.js) proves the real thing, but
 * it needs an agent runner, costs real tokens and takes minutes, so it is not
 * something you run after every edit. This exercises the same code path in a
 * couple of seconds by pointing the server at a fabricated projects directory
 * via CLAUDE_USAGE_PROJECTS_DIR.
 *
 * The cases are the ones that were actually got wrong or could be:
 *   - a run in flight            -> must appear (this is the bug that shipped)
 *   - a finished run             -> must not appear, though its file exists
 *   - a killed run, gone stale   -> must not appear, despite unfinished agents
 *   - a partly finished run      -> only the unfinished agents appear
 *   - a run with an errored agent-> error counts as finished
 *
 * Usage:  node usage-server/test/live-detection.test.js
 * Exit 0 if every case passes.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 41799;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-live-test-'));
const PROJECTS = path.join(ROOT, 'projects');

/* --------------------------------------------------------------- fixtures */

function writeRun(opts) {
  const sessionDir = path.join(PROJECTS, opts.project, opts.session);
  const runDir = path.join(sessionDir, 'subagents', 'workflows', opts.runId);
  fs.mkdirSync(runDir, { recursive: true });

  const journal = [];
  for (const agent of opts.agents) {
    journal.push(JSON.stringify({ type: 'started', agentId: agent.id }));
    if (agent.finished) {
      journal.push(JSON.stringify({ type: agent.finished, agentId: agent.id, result: 'x' }));
    }
    /* The label comes from the first line of the agent's first message. */
    fs.writeFileSync(
      path.join(runDir, 'agent-' + agent.id + '.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: agent.prompt } }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(runDir, 'agent-' + agent.id + '.meta.json'),
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1, model: agent.model || 'haiku' }),
      'utf8'
    );
  }
  fs.writeFileSync(path.join(runDir, 'journal.jsonl'), journal.join('\n') + '\n', 'utf8');

  /* A finished run also has its wf_*.json — written only when the run ends,
     which is the whole reason the first implementation saw nothing. */
  if (opts.completed) {
    const wfDir = path.join(sessionDir, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, opts.runId + '.json'), JSON.stringify({
      runId: opts.runId, workflowName: opts.name || 'fixture', status: 'completed',
      startTime: Date.now() - 60000, durationMs: 60000, agentCount: opts.agents.length,
      workflowProgress: opts.agents.map(a => ({
        type: 'workflow_agent', label: a.id, state: 'done'
      }))
    }), 'utf8');
  }

  if (opts.ageMs) {
    const when = new Date(Date.now() - opts.ageMs);
    fs.utimesSync(runDir, when, when);
  }
  return runDir;
}

/* A session transcript is a .jsonl directly under the project directory; one
   nested deeper belongs to a subagent. A session that has only just been
   opened contains no message at all - just startup bookkeeping - which is
   exactly the case that used to be invisible. */
function writeSession(project, sessionId, opts) {
  const dir = path.join(PROJECTS, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  const lines = (opts.records || [
    { type: 'mode', mode: 'default' },
    { type: 'permission-mode', permissionMode: 'auto' },
    { type: 'system', subtype: 'informational', content: 'started', isMeta: true }
  ]).map(r => JSON.stringify(r));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  if (opts.ageMs) {
    const when = new Date(Date.now() - opts.ageMs);
    fs.utimesSync(file, when, when);
  }
  return file;
}

function writeNested(project, sessionId) {
  const dir = path.join(PROJECTS, project, sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested.jsonl'),
    JSON.stringify({ type: 'mode', mode: 'default' }) + '\n', 'utf8');
}

/* ------------------------------------------------------------------ server */

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, res => {
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

async function waitForServer(child) {
  for (let i = 0; i < 50; i++) {
    try { return await get('/usage'); } catch (err) { /* not up yet */ }
    if (child.exitCode !== null) throw new Error('server exited early, code ' + child.exitCode);
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server never answered');
}

/* -------------------------------------------------------------------- run */

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

async function main() {
  console.log(`fixtures in ${ROOT}\n`);

  writeRun({
    project: 'C--fixture-live', session: 'sess-live', runId: 'wf_live0001',
    agents: [
      { id: 'aaa1', prompt: 'live-one: still going\nmore text' },
      { id: 'aaa2', prompt: 'live-two: still going' }
    ]
  });
  writeRun({
    project: 'C--fixture-done', session: 'sess-done', runId: 'wf_done0001', completed: true,
    agents: [{ id: 'bbb1', prompt: 'finished work', finished: 'result' }]
  });
  writeRun({
    project: 'C--fixture-stale', session: 'sess-stale', runId: 'wf_stale001',
    ageMs: 60 * 60 * 1000,   /* an hour old, past the 15-minute liveness bound */
    agents: [{ id: 'ccc1', prompt: 'killed mid-flight' }]
  });
  writeRun({
    project: 'C--fixture-partial', session: 'sess-partial', runId: 'wf_part0001',
    agents: [
      { id: 'ddd1', prompt: 'partial-done: this one finished', finished: 'result' },
      { id: 'ddd2', prompt: 'partial-live: this one has not' }
    ]
  });
  writeRun({
    project: 'C--fixture-errored', session: 'sess-errored', runId: 'wf_err00001',
    agents: [{ id: 'eee1', prompt: 'errored out', finished: 'error' }]
  });

  writeSession('C--fixture-fresh', '0abb6d2c-fresh', {});
  writeSession('C--fixture-oldidle', 'cafebabe-idle', { ageMs: 60 * 60 * 1000 });
  writeNested('C--fixture-nested', 'deadbeef-parent');

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CLAUDE_USAGE_PROJECTS_DIR: PROJECTS,
      PORT: String(PORT)
    }),
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    const feed = await waitForServer(child);
    const wfNames = feed.workflows.map(w => w.id).sort();
    const taskLabels = feed.subtasks.map(t => t.label).sort();

    console.log('detection:');
    check('a run in flight is reported', wfNames.includes('wf_live0001'), true);
    check('both of its unfinished agents are reported',
      taskLabels.filter(l => l.startsWith('live-')), ['live-one: still going', 'live-two: still going']);
    check('the label is the prompt\'s first line only',
      taskLabels.includes('live-one: still going'), true);
    check('a finished run is not reported', wfNames.includes('wf_done0001'), false);
    check('a stale killed run is not reported', wfNames.includes('wf_stale001'), false);
    check('a partly finished run is reported', wfNames.includes('wf_part0001'), true);
    check('only its unfinished agent is reported',
      taskLabels.filter(l => l.startsWith('partial-')), ['partial-live: this one has not']);
    check('an errored agent counts as finished', wfNames.includes('wf_err00001'), false);
    check('workflow count matches', feed.counts.workflows, 2);
    check('subtask count matches', feed.counts.subtasks, 3);
    check('every reported subtask says running',
      [...new Set(feed.subtasks.map(t => t.state))], ['running']);
    check('the model comes from meta.json',
      [...new Set(feed.subtasks.map(t => t.model))], ['haiku']);

    console.log('sessions:');
    const sessionIds = feed.sessions.map(s => s.id).sort();
    check('a just-opened session with no messages is reported',
      sessionIds.includes('0abb6d2c-fresh'), true);
    check('it is reported as running',
      (feed.sessions.find(s => s.id === '0abb6d2c-fresh') || {}).state, 'running');
    check('with a zero message count, not a fabricated one',
      (feed.sessions.find(s => s.id === '0abb6d2c-fresh') || {}).messages, 0);
    check('an old idle session is not reported',
      sessionIds.includes('cafebabe-idle'), false);
    check('a nested subagent transcript is not a session',
      sessionIds.includes('nested'), false);
  } finally {
    child.kill();
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  console.log('');
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error('test harness error:', err.message);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
