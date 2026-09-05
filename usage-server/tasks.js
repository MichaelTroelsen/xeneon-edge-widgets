/* The whattask feed: how much queued work exists across every repo on this
 * machine that has a queue, what is holding a lock right now, and what has
 * been finished.
 *
 * Discovery reads the `projects` map in ~/.claude.json, which carries real,
 * unmangled project paths. The per-project directory names under
 * ~/.claude/projects/ are NOT usable: the mangling replaces every path
 * separator with '-', which is lossy against directory names that themselves
 * contain '-'. "C--Users-mit-claude-c64server-tdz-c64-knowledge" cannot be
 * demangled back to a path unambiguously.
 *
 * The scan this replaces (collectQueuedTasks in server.js) walked one level of
 * ~/claude and so found 3 of the 5 repos that actually have queues - it missed
 * the two nested under c64server/, and with them 122 of 210 open tasks.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY_PATH = process.env.CLAUDE_TASKS_REGISTRY ||
  path.join(os.homedir(), '.claude.json');

/* Registered paths differ only by slash style often enough to matter: the
   same project appears in ~/.claude.json as both C:\a\b and C:/a/b. */
function normalise(p) {
  return path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
}

function whattaskFile(repoPath) {
  return path.join(repoPath, '.claude', 'tasks', 'whattask.json');
}

function discover() {
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
  const projects = (registry && registry.projects) || {};
  const seen = new Set();
  const found = [];
  for (const raw of Object.keys(projects)) {
    const key = normalise(raw);
    if (seen.has(key)) continue;
    try {
      if (!fs.statSync(whattaskFile(raw)).isFile()) continue;
    } catch (err) {
      continue;
    }
    seen.add(key);
    found.push({ name: path.basename(path.normalize(raw)), path: raw });
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found;
}

/* Every field of a task record is optional - measured across four repos, whose
   schemas genuinely differ - so an absent one is counted as "unknown" rather
   than defaulted to a value the record never claimed. */
function tally(items, field) {
  const out = {};
  for (const item of items) {
    const key = (item && item[field]) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function readRepo(repo) {
  const base = {
    name: repo.name,
    path: repo.path,
    open: 0,
    closed: 0,
    byMode: {},
    byLane: {},
    blocked: 0,
    holders: [],
    lastRunAt: null,
    error: null
  };
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(whattaskFile(repo.path), 'utf8'));
  } catch (err) {
    base.error = 'whattask.json could not be read: ' + err.message;
    return base;
  }
  const tasks = (plan && Array.isArray(plan.tasks)) ? plan.tasks : [];
  const closed = (plan && Array.isArray(plan.closed)) ? plan.closed : [];
  base.open = tasks.length;
  base.closed = closed.length;
  base.byMode = tally(tasks, 'mode');
  base.byLane = tally(tasks, 'lane');
  base.blocked = tasks.filter(t => t && t.blocked_on).length;
  return base;
}

module.exports = { REGISTRY_PATH, discover, readRepo, normalise, whattaskFile };
