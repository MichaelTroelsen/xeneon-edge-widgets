# Handoff — Xeneon Edge widgets

Written 2026-08-28 ~22:40 local (20:40 UTC). **Supersedes the previous
`whats-next.md`**, whose two headline claims are now both wrong: the 429 was not
caused by a neighbouring plugin alone, and the activity lists are no longer a
seven-day view.

Repo: `C:\Users\mit\claude\icue` → https://github.com/MichaelTroelsen/xeneon-edge-widgets
(public, `main`, clean apart from this file, pushed through `b69b22c`).

<original_task>
This session opened with **"read what next"** — i.e. read the previous handoff
and report. Everything after that came from the user's follow-ups, in order:

1. Investigate the three items the old handoff left pending (429, Stream Deck
   plugin, token refresh).
2. **"please check the interwebs for your assumption. please look in github
   answers"** — verify the 429 diagnosis against external sources.
3. **"yes, build the statusline route"** — implement the no-API-request path to
   the usage percentages.
4. **"can we make the activity live? it is currently showing too many sessions,
   workflows and subtasks that are active."**
5. **"can you build a small test that add to subtask that do nothing for 60
   seconds and then return. then create a test the create a workflow of 3 test
   that wait 60 seconds and then return?"** — later extended with *"the widget
   does not update. i expected to be updated. please add this to the test."*
6. **"please make sure you can test the workflow also"** — make the detection
   testable without an agent runner.
7. **"i have added a new session. why is it not showing?"**
8. **"update docs. commit and push."**

Also, as one-off requests along the way: put the tdzlaptop question on the TODO
list; fix and force-push the commit message on `644b42d`.
</original_task>

<work_completed>

## Commits (all pushed; `main` == `origin/main` at `b69b22c`)

| SHA | What |
|---|---|
| `fae6cd5` | Reworded `644b42d` — the 429 diagnosis (history rewrite, force-pushed) |
| `3022937` | Reworded `04db35a` — the statusline route |
| `28bd772` | TODO: tdzlaptop item + two stale entries corrected |
| `97942a9` | Activity shows what is running, not what has run |
| `97a9229` | Read running work from the journal, not the end-of-run file |
| `63f1e45` | `live-detection.test.js` — fixture-based, no agent runner |
| `fb3b90e` | A session appears when opened, not when it first replies |
| `b69b22c` | Docs audit and fixes |

## 1. The 429 diagnosis was wrong twice, and the second correction is the durable one

**First (wrong) story**, written into `644b42d`: a runaway Stream Deck plugin
caused the throttling, and stopping it would clear the window.

What was actually measured on this machine, and is still true:
- **Four** Stream Deck plugins called `https://api.anthropic.com/api/oauth/usage`
  — `com.singerous.ai-limits`, `kr.co.postgresql.ai-limits`, `com.len.limits`,
  `com.lloyds.headroom`.
- `kr.co.postgresql.ai-limits` retried with **no backoff** after each failure:
  ~45 req/s, ~11,700 in six minutes after a reboot, later ~140/s (counted from
  its own log by sampling line counts over fixed intervals).
- Removing its **buttons** did not stop it. Killing its node process made Stream
  Deck **respawn** it and restart the loop from zero. Only **uninstalling** did —
  the folder leaving `%APPDATA%\Elgato\StreamDeck\Plugins\`.
- A resident plugin process proves nothing either way; its log does. For a
  plugin with no log (`com.lloyds.headroom`), sample outbound connections by PID
  (`Get-NetTCPConnection -OwningProcess <pid>`).

**Second (verified) story**, now in `fae6cd5` and the README: the endpoint
throttles clients far politer than ours regardless. Sources, found via
`gh search issues`:
- **anthropics/claude-code#30930** — *open*, labelled `bug`/`area:api`/
  `area:statusline`. Exactly our symptom: persistent 429 with `retry-after: 0`
  for Max users on a valid token, at 30s/60s/120s.
- **#31637** (closed as stale, not fixed) — backoff ladder 30→60→120→240→300s
  "stuck at 300 forever"; another reporter at **10-minute** polling throttled
  within the hour, 30-minute backoff still failing for hours.
- **#31055** — 429 after a *single* request, including Claude Code's own
  `/usage` command.

**Do not** re-derive this as "we polled too much". Our cadence was never the
main variable.

## 2. The statusline route — the actual fix (widget 1.7.0)

Claude Code hands its statusline script a `rate_limits` object on stdin since
**v2.1.80**. Verified against the official docs
(<https://code.claude.com/docs/en/statusline>), not just a GitHub comment:

```
rate_limits.five_hour.used_percentage   0–100
rate_limits.five_hour.resets_at         Unix epoch SECONDS
rate_limits.seven_day.{used_percentage,resets_at}
```

Docs caveat, verbatim: *"appears only for Claude.ai subscribers (Pro/Max) after
the first API response in the session. Each window may be independently absent,
and Claude Code drops a window once its `resets_at` time passes."*

Built:
- **`usage-server/statusline-tee.js`** — wraps the configured statusline. Saves
  `rate_limits` to `~/.claude/statusline-usage.json` (atomic: temp + rename,
  pid in the temp name), then runs the wrapped command with the same stdin and
  passes stdout/exit code through. Every failure path still runs the wrapped
  command — a missing usage figure is a small problem, a broken status bar in
  every session is not.
- **`usage-server/statusline.js`** — reads it back in the **same shape
  `official.js` returns on success**, so the widget needed no change at all
  (its badge/tooltip already key off `official.source`). Current for 10 min,
  `stale` to 45 min, dropped entirely past 45.
- **`server.js`** — `officialForSnapshot()` now takes whichever of the two paths
  answered **most recently**. They fail in opposite conditions: the endpoint
  answers with no session running but gets throttled; the statusline can't be
  throttled but only updates while a session renders one.

`~/.claude/settings.json` `statusLine.command` changed (nothing else in that
file touched; it parses; hooks and plugins intact):

```
node C:/Users/mit/claude/icue/usage-server/statusline-tee.js npx -y ccstatusline@latest
```

**Closed a TODO for free:** the statusline's `seven_day.resets_at` came back as
**Thu 21:00 local**, confirming the weekly anchor `limits.json` had guessed.

## 3. Activity = what is running (the part that took two attempts)

**Attempt 1 (`97942a9`) was wrong.** It filtered `wf_*.json` by non-terminal
status. That file is written when a run **ends**, so it can never describe a run
in flight — the lists stayed permanently empty. The user spotted it before I did
("the widget does not update").

**Attempt 2 (`97a9229`) is correct.** The live source is the run's transcript
directory, which exists from launch:

```
~/.claude/projects/<project>/<session>/subagents/workflows/wf_<runId>/
  journal.jsonl          {"type":"started",…} per agent; {"type":"result",…} when it ends
  agent-<id>.jsonl       the agent's messages; the first is its prompt
  agent-<id>.meta.json   {"agentType","spawnDepth","model"}
```

An agent with `started` and no `result` is running; a run with any such agent is
running. Bounded by `LIVE_RUN_STALE_MS = 15 min` on the directory mtime so a
killed run stops advertising itself. `wf_*.json` remains the record of finished
runs, for `counts.*Seen` and `/usagehtml`.

Also in `97942a9`/`fb3b90e`:
- Sessions: active on the existing 15-min rule, **or** a transcript written that
  recently even with no message in it (`fb3b90e` — see §5).
- Queued `whattask.json` tasks are no longer substituted into the subtask list;
  86 planned tasks were reading as live work. Count still reported, so the empty
  list says `Nothing running · 86 queued`.
- Widget: headings `N active` / `none active`; empty row `Nothing running`.
  `/usagehtml` says `N active of M seen`.

## 4. Tests

- **`usage-server/test/live-detection.test.js`** — spawns the real server against
  a fixture tree via the new **`CLAUDE_USAGE_PROJECTS_DIR`** env override (unset
  in normal use), on `PORT=41799`. **17 checks, ~2s, no tokens.** Fixtures: a run
  in flight, a finished run *with* its `wf_*.json`, a killed run aged past the
  bound, a partly finished run, an errored agent, a just-opened session, an old
  idle session, a nested subagent transcript.
- **`usage-server/test/activity-probe.workflow.js`** — Workflow script,
  `args: {agents, seconds}`. N agents that genuinely block for S seconds.
- **`usage-server/test/activity-probe-check.js`** — polls the feed and exits
  non-zero if the lists never reported the run.

**Both mutation-checked** (this matters — a test that only passes on correct
code proves nothing): reverting the live-run lookup fails 9 checks; reverting
the just-opened-session rule fails 3; restored code passes both times.

## 5. The just-opened session (`fb3b90e`)

User asked why a new session wasn't showing. Its transcript had **6 records and
no message at all** — `last-prompt`, `mode`, `permission-mode`, two `attachment`,
one `system` (a Remote Control notice). The session list required ≥1 counted
message, so a session showed only after its first exchange finished. Now a
transcript written inside the 15-min window is enough on its own, with `lastAt`
falling back to file mtime. Such a session shows its short id and `0` messages
until its first exchange gives it a real label.

## 6. Docs audit (`b69b22c`)

Read `README.md`, `TODO.md`, `usage-server/README.md` in full; verified against
code and fresh measurements. Corrected:

| Claim | Reality |
|---|---|
| `LIVE·` cache "up to 30 minutes" (×2) | `OFFICIAL_STALE_MS = 45 min` |
| "fails 9 of its 12 checks" | 17 checks; 9 from one rule, 3 from the other |
| "cold build ~480 ms" | measured 440 ms cold / 40 ms incremental / 0.8 ms cached, over 10,685 messages |
| percentages come from the OAuth endpoint | two paths, statusline preferred |
| `claude auth login` shown as required | optional — only the fallback uses it |
| lists show "recent" sessions/workflows/subtasks | only what is running |
| heading "carries the total (`SESSIONS · 20`)" | `SESSIONS · 1 ACTIVE` / `NONE ACTIVE` |

**One finding was self-inflicted**: inserting the tests block into
`usage-server/README.md` earlier the same day orphaned a paragraph about session
labelling, leaving it after the probe description where it read as describing the
probe. Same failure the previous audit recorded — recently edited text is not
thereby correct.

Verified clean: bar thresholds 80/95, all six widget settings defaults against
the `x-icue-property` tags, C64 version string, manifest/TODO versions (1.7.0),
and all 9 file paths the docs name.

## 7. History rewrite

`644b42d` and `04db35a` were reworded to `fae6cd5` and `3022937` (content
byte-identical — verified with `git diff backup-before-reword HEAD`), then
**force-pushed with `--force-with-lease`** at the user's explicit instruction.
The `backup-before-reword` branch was created and later deleted on request.
</work_completed>

<work_remaining>

## Verify on the next opportunity

1. **The ~03:24 token refresh.** `~/.claude/.credentials.json` expires
   **2026-08-29 03:54:40 local**; the server refreshes 30 min ahead
   (`EXPIRY_MARGIN_MS`). Check `official.lastRefresh.ok` and that `expiresAt`
   moved forward. This is now a **fair** test — every other client that rotated
   the token without persisting it has been uninstalled. It also **matters much
   less**: the widget's figures come from the statusline path, which uses no
   token.

2. **Whether `/api/oauth/usage` ever recovers.** It has been 429 since ~18:05
   UTC. Now cosmetic: `official.source` reads `Claude Code statusline`, and the
   endpoint is the backstop. Do **not** poll it manually.

## Open TODO items (in `TODO.md`)

- **Show sessions from `tdzlaptop`.** Structural: the server walks
  `~/.claude/projects/**` on its own host. Verified 2026-08-28 — all 13 project
  dirs are local, `ListAgents` found no reachable remote session despite
  `remoteControlAtStartup: true`. **The usage bars already cover the laptop**
  (server-side account figures); only the lists are machine-bound. Any design
  must decide what to show when the peer is unreachable — silence is
  indistinguishable from idle, the exact trap the active-only filter avoids.
- **Confirm touch drag on the device.** Still unverified; `interactive` is
  documented only for *click*. Fallback: page the lists on a timer.
- **Dead budget config in `limits.json`** — `sessionBudgetWeightedTokens`,
  `weeklyBudgetWeightedTokens`, `weeklyBoost`, `weeklyBuckets` drive only the
  discredited percentage. Delete or mark diagnostic-only.
- **`tab-buttons` throws in iCUE's settings panel** —
  `TabButtonsEditorSetting.qml:33: TypeError: Property 'rowCount' … is not a
  function`, for `tempUnit` and `colorTheme`. iCUE's own QML. Not investigated.

## Known limitations, documented not fixed

- **Subtask rows are labelled by the first line of the agent's prompt.** A
  workflow's `opts.label` names the row in `/workflows` but is never written to
  disk, so it cannot name anything in the widget.
- **A workflow launched from a script outside the session's
  `workflows/scripts/`** (e.g. this repo's `test/`) falls back to its short run
  id — `wf f354826c-6c2`.
- **~40s lag in each direction**: server re-indexes every 20s
  (`REFRESH_MS`), widget polls every 20s (`refreshSeconds`, 5–120). A run
  shorter than ~40s can begin and end unseen. Measured costs make tightening
  cheap (~0.2% of a core at 20s); **both** numbers must drop together.

## Possible, deliberately not done

- **Changing the User-Agent.** A commenter on #30930 claims the API buckets by
  User-Agent (`claude-code/<version>` generous, `curl/x` strict); we send
  `xeneon-edge-widgets/usage-server`. An earlier session ruled this out as
  working around a rate limit. Flagged to the user, **not acted on** — it still
  means presenting as a client we are not, and another commenter reports it only
  partly helps.
- **Refreshing the token to reset the rate-limit window** (the widely shared
  #30930 workaround). Deliberate limit evasion, and a commenter reports it broke
  Claude Code's own auth badly enough to force re-login every few minutes.
</work_remaining>

<attempted_approaches>

## Dead ends — do not repeat

- **Local percentage estimation.** Disproved arithmetically by an earlier
  session (growth floor 4.28× vs a 4.00× ceiling). No non-negative weighting
  exists.
- **Filtering `wf_*.json` by status to find running work.** The file does not
  exist until the run ends. This shipped in `97942a9` and made the lists
  permanently empty.
- **`Start-Sleep -Seconds 60` / bare `sleep` in a probe agent.** The harness
  blocks a standalone sleep; the agent then backgrounded it and returned "done"
  in **13.8s**, reporting success without waiting. Fixed with a node one-liner
  (`node -e "…setTimeout(…,60000)"`) that also prints its own elapsed time, so a
  shortcut shows up in the result instead of passing silently.
- **`spawn(cmd, args, {shell:true})`** — concatenates without escaping (Node
  DEP0190); an inner command with a spaced path is re-split wrongly. Build one
  properly quoted command string instead.
- **Backgrounding the probe checker inside a `run_in_background` Bash call.**
  The wrapper exited and killed the child. Run it in the foreground.
- **`\n` inside a heredoc'd python string** that writes JS — came out as a real
  newline and broke the file. Use the Edit tool for those lines.

## Corrections made mid-session (all real, all mine)

- Told the user the Stream Deck plugin's 2-minute polling was likely holding the
  429 open. Wrong by three orders of magnitude — a different plugin at ~45–140/s.
- Read the plugin log at 21:11 and called it "still polling", not noticing the
  machine had rebooted at 21:07:16 — the lines were from a fresh Stream Deck.
- Told the user the 429 would drain once the plugin stopped. Not supported;
  #30930 is open and unfixed.
- A watcher printed **"RECOVERED"** — a false positive from my own fake test
  file arriving through the new statusline path, and it was reading snake_case
  field names (`five_hour.utilization`) that do not exist in this payload
  (`fiveHour.percent`), so it could never have printed real values.
</attempted_approaches>

<critical_context>

## Environment

- `icuewidget` CLI at `C:\Program Files\Corsair\iCUE Widget CLI\` (v0.4.45;
  0.4.47 available). `validate` then `package`.
- Xeneon Edge is `\\.\DISPLAY2`, **2560×720 at X=-1881, Y=1440** — capture with
  `System.Drawing` `CopyFromScreen`. Both widgets sit in **840×344** slots.
- Node at `C:\Program Files\nodejs\node.exe`; Chrome at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- Claude Code **2.1.251**. `gh` authenticated as `MichaelTroelsen`.
- Server runs under scheduled task **`ClaudeUsageFeed`** via
  `usage-server/start-hidden.vbs`.

## iCUE behaviours (unchanged, still expensive to relearn)

- **iCUE caches the loaded page.** File edits do nothing until the widget is
  removed and re-added. The header version tells you which build is live.
- **Re-importing mints a new GUID folder**; removing from the dashboard deletes
  the folder. Remove-then-re-add is the clean reload.
- **Widget properties reset on re-add.**
- **Do not restart iCUE** — it re-registered widgets under new GUIDs once and
  orphaned the dashboard layout.
- `<head>` must be XML well-formed; `icueEvents` must be a bare assignment in an
  inline script in `index.html`.

## Verification conventions

- Layout: an exactly-sized `<iframe>` in a larger window. Bare `--window-size`
  includes window chrome (`840,344` lays out at 824×249).
- To reach the **Activity** view in a headless harness, copy the widget to
  scratch and append a script that dispatches `pointerdown`+`pointerup` — a
  `file://` iframe is cross-origin, so the parent cannot drive it.
- On-device: screen capture of `\\.\DISPLAY2`.
- **Mutation-check any new test** by reverting the fix and confirming it fails.

## Non-obvious behaviours discovered this session

- `wf_*.json` is written **only at completion**.
- The Workflow transcript dir exists **from launch**; `journal.jsonl` gets
  `started` immediately and `result` at the end.
- A just-opened Claude Code session's transcript contains **no message** — only
  `mode`, `permission-mode`, `attachment`, `system`, `last-prompt` records.
- `resets_at` is **epoch seconds** in the statusline payload but an **ISO
  string** from `/api/oauth/usage`; both are converted to ms internally.
- `.icuewidget` packages are **gitignored** — do not try to commit them.
- Serving `/usage` never triggers an upstream fetch; only the timer and the
  credentials-file watcher do. Polling the local feed is free.

## Key constants (`usage-server/server.js`)

| Constant | Value |
|---|---|
| `REFRESH_MS` | 20 s |
| `SESSION_ACTIVE_MS` | 15 min |
| `LIVE_RUN_STALE_MS` | 15 min |
| `WORKFLOW_ACTIVE_MS` | 60 min |
| `OFFICIAL_INTERVAL_MS` | 12 min |
| `OFFICIAL_STALE_MS` | 45 min |
| `EXPIRY_MARGIN_MS` (`official.js`) | 30 min |
| `CLAUDE_USAGE_PROJECTS_DIR` | env override, unset normally |
</critical_context>

<current_state>

## Complete and pushed

- `main` == `origin/main` at **`b69b22c`**. Only `whats-next.md` is untracked.
- **C64 Weather 1.2.0** — unchanged this session, live on the Edge, no known
  defects.
- **Claude Code Usage 1.7.0** — live on the Edge (the user re-added it, so the
  device is running 1.7.0), showing the Activity view.
- **usage-server** — running under `ClaudeUsageFeed`, serving `/usage`,
  `/health`, `/usagehtml`, `/usage?at=`.
- Docs current as of `b69b22c`. `DOC-AUDIT.md` is on disk and **gitignored**;
  it was **not** regenerated this session (the audit was run inline).

## Verified working, on the device

- `official.ok = true`, `official.source = "Claude Code statusline"` — badge
  `LIVE`, **zero API requests**.
- Last reading: five-hour **13%**, seven-day **16%**, plan `Max (5x)`.
- Activity end-to-end, captured on `\\.\DISPLAY2` during a probe run:
  `SESSIONS · 1 ACTIVE`, `WORKFLOWS · 1 ACTIVE` (`wf 3f711fbc-1da`),
  `SUBTASKS · 3 ACTIVE` (probe-wait-1/2/3), returning to `NONE ACTIVE` after.
- Feed right now: `sessions: 2, workflows: 0, subtasks: 0`, with
  `sessionsSeen: 20, workflowsSeen: 23, subtasksSeen: 36, queued: 86`.

## Test status

```bash
node usage-server/test/live-detection.test.js     # 17/17, ~2s, no tokens
```
Last run: **all passed**. The end-to-end probe last ran `PASS` (3 agents ×
60s: 0 → 1 workflow / 3 subtasks → 0).

## Environment left in this state

- `~/.claude/settings.json` `statusLine.command` points at `statusline-tee.js`
  wrapping `npx -y ccstatusline@latest`.
- `~/.claude/statusline-usage.json` exists (256 bytes, written 22:38) and is
  being refreshed by this session's statusline renders.
- **All four Claude usage Stream Deck plugins are uninstalled.** Nine unrelated
  plugins remain.
- Credentials expire **2026-08-29 03:54:40 local**.

## Open questions

- Does the ~03:24 refresh win the rotation race? (Now low-stakes.)
- Does `/api/oauth/usage` ever stop 429ing for this account?
- Does the iCUE webview forward touch **drags**?
- Should the 20s/20s intervals be tightened? Measured cost says it is cheap;
  the user has not asked for it.
</current_state>
