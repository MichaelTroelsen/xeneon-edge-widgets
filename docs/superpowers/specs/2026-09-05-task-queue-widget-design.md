# Task Queue widget — design

A third iCUE widget for the Xeneon Edge showing the progress of whattask work
across every repo that has a queue, fed by a new endpoint on the existing
`usage-server`.

## Why this shape

Three things were measured before the design was fixed. Each falsified an
assumption the prose in this repo supported, and each changed what can be
built.

**No run record carries a timestamp.** Across four repos' `runs.jsonl` — 603
lines — the key union is `id, head, model, effort, mode, lane, outcome,
evidence, verify_output, notes, opened, decision, runner`. There is no date
field anywhere. `head` is a commit SHA and resolves cleanly, so a
history-over-time view is buildable, but its axis is commit time and must be
labelled as such.

**The record schema is not uniform across repos.** `lane` appears in 38 of 62
lines in `icue` and in none of `h2g`'s 107. `effort` is absent from `h2g`
entirely. `tdz-c64-knowledge` adds `runner` and `decision`. Every field is
therefore optional; a missing field is reported as unknown, never defaulted.

**An existing function already does a weaker version of this, incorrectly.**
`server.js:1087 collectQueuedTasks()` scans one level of `~/claude` and so
finds 3 of the 5 repos that have queues, missing `SIDM2` (120 open) and
`tdz-c64-knowledge` (2 open) because they sit two levels down under
`c64server/`. It sees 88 of 210 open tasks.

**`serial.lock` is `[]` in every repo.** That is its resting state — it holds
records only while a `/runqueue` is mid-flight. A live view backed by it alone
would be empty almost always, which is why the live view is enriched with the
session and workflow activity `build()` already computes.

## Discovery

`~/.claude.json` carries a `projects` map of real, unmangled project paths (19
unique). This is the registry. The per-project directory names under
`~/.claude/projects/` are NOT usable for this: the path mangling replaces every
path separator with `-` and is lossy against directory names that themselves
contain `-`, so `C--Users-mit-claude-c64server-tdz-c64-knowledge` cannot be
demangled unambiguously.

Discovery keeps the registry entries where `<path>/.claude/tasks/whattask.json`
exists, deduped by normalised path — `SIDM2` is registered under both slash
styles. Measured result: 5 repos, 210 open, 307 closed.

`collectQueuedTasks()` is repointed at this same discovery so the usage
widget's queued list stops under-reporting. That is the only change to
`server.js` beyond the route.

## The feed

`usage-server/tasks.js`, mounted at `GET /tasks` on port 41777 in the existing
router alongside `usagehtml`, `official` and `statusline`. One process, one
port, one startup story. Rebuilt on the server's existing 10s cadence.

```
{
  generatedAt: <ms>,
  repos: [ { name, path, open, closed,
             byMode:  { subtask, main, "requires-user", unknown },
             byLane:  { serial, parallel, unknown },
             blocked: <count of tasks with blocked_on>,
             holders: [ <serial.lock records> ],
             lastRunAt: <ms|null>,
             error: <string|null> } ],
  totals: { open, closed, byMode, byOutcome },
  running: [ { kind: "holder"|"session"|"workflow"|"subtask", ... } ],
  history: [ { at, atSource: "commit", outcome, model, effort, mode, repo } ],
  unavailable: <string|null>
}
```

A repo whose whattask file is missing, unreadable or malformed contributes an
`error` string and is still listed. The feed never omits a repo silently.

### Timestamps

`history[].at` comes from git: the unique `head` values per repo (23 for 62
lines in `icue`) resolved in one batched `git cat-file --batch` call per repo,
not one process per record. `atSource: "commit"` travels with every entry and
the view labels its axis commit time, not run time. When git is unavailable or
a SHA does not resolve, that repo's history is omitted with a stated reason.

## The widget

`TaskQueue/`, mirroring `ClaudeUsage/`'s structure: `index.html`,
`manifest.json` (`com.thordanielz.taskqueue`, `interactive: true`,
`dashboard_lcd`), `scripts/widget.js`, `styles/TaskQueue.css`,
`resources/icon.svg`, `translation.json`, `test/layout.test.js`.

Settings: `feedUrl` (default `http://127.0.0.1:41777/tasks`), `colorTheme`
(dark/light), `timeFormat`, `refreshSeconds`.

Visual treatment matches Claude Code Usage so the two read as a pair, and the
header, clock and pager come across with it.

### Views — tap to cycle

**Queue.** Total open and closed with a completion meter, then a per-repo table
sorted by open count. `requires-user` is called out on its own, being the count
where the human is the blocker.

**Live.** `serial.lock` holder records where a `/runqueue` holds them, rendered
above the active sessions, workflows and subtasks that `build()` already
computes. The two kinds of "running" are visually distinct and never summed:
a task-queue holder and a Claude session are different claims about the
machine.

**History.** Outcome split across the 603 run records (`done` 55, `partial` 7
in `icue`; no repo has ever recorded a `failed`), a calendar heatmap over
commit time, and breakdowns by model and effort.

The heatmap is laid out **by calendar date, not by array position** — the same
rule the usage widget's stats view already carries, for the same reason: run
records are sparse in time, and packing them side by side would draw a solid
block with every date in the wrong column.

`byLane` is served but shown only where present. One repo of five records
lanes at all, which is not enough to design a view around.

## Failure behaviour

Every unavailability is stated rather than rendered as absence, following the
rule the usage widget's stats view established: an empty heatmap reads as
months of silence rather than as a missing file.

- Feed unreachable: the widget shows the feed's own error body when it carries
  one, and the fixed start-the-server hint only for a genuine connection
  failure — the behaviour `2fe3364` established for the usage widget.
- A repo that cannot be read: listed with its error, not dropped.
- History unavailable for a repo: the view says why, and does not draw an
  empty grid.

## Testing

`usage-server/test/tasks.test.js` — discovery from a fixture registry,
dedupe across slash styles, absent optional fields, missing and malformed
whattask files, `serial.lock` present and empty, git failure, and the
`collectQueuedTasks()` repoint finding all fixture repos rather than the
top-level ones.

`TaskQueue/test/layout.test.js` — ported from the usage widget's suite. It
asserts the **840×344 S-H slot**, which is what both existing suites do; a
wider slot matrix is not invented here, because neither shipped widget has one
and inventing one for the third would be a new, unvalidated harness rather than
a port. Carried across verbatim: `OVERFLOW_EPS_PX = 1`, the viewport driven to
exactly 840×344 by correction rather than by a hard-coded Chrome deficit, `* {
transition: none !important }` injected because transitions do not advance
under `--virtual-time-budget`, `--screenshot` flags for renders kept distinct
from `--dump-dom` flags for probes, and `--user-data-dir` pointed somewhere
disposable.

## Deploy

One entry in `tools/deploy.ps1`'s widget table and one value in its
`ValidateSet`. The machinery is otherwise generic. The widget needs one manual
import through iCUE's UI before `deploy.ps1` can mirror onto its GUID folder;
the script already detects and reports that case.
