# Handoff — Xeneon Edge widgets

Written 2026-08-29 ~09:35 local. Replaces the version committed in `0c0b365`,
which stopped at `b69b22c`.

Repo: `C:\Users\mit\claude\icue` → https://github.com/MichaelTroelsen/xeneon-edge-widgets
(public, `main`, clean, pushed through `bb2ea7d`, CI green).

<original_task>
The session opened with **"read what next"** — read the previous handoff and
report. Everything else came from the user's follow-ups, in order:

1. Chase the three items the old handoff left pending (429, Stream Deck plugin,
   token refresh).
2. **"please check the interwebs for your assumption. please look in github
   answers"** — verify the 429 diagnosis externally.
3. **"yes, build the statusline route"**.
4. **"can we make the activity live? it is currently showing too many sessions,
   workflows and subtasks that are active."**
5. **"can you build a small test that add to subtask that do nothing for 60
   seconds..."**, later **"the widget does not update. i expected to be updated.
   please add this to the test."**
6. **"please make sure you can test the workflow also"**.
7. **"i have added a new session. why is it not showing?"**
8. **"update docs. commit and push."**
9. **"what suggested improvements do you have"** → then **"yes, do 1 and 2"**,
   **"do 3 and 4"**, **"do 5 and 6"** — the six-item list below.

One-offs: add the tdzlaptop question to TODO; reword and force-push `644b42d`.
</original_task>

<work_completed>

## Commits (all pushed, `main` == `origin/main` at `bb2ea7d`)

| SHA | What |
|---|---|
| `fae6cd5` | Reworded `644b42d` — 429 diagnosis (history rewrite, force-pushed) |
| `3022937` | Reworded `04db35a` — statusline route |
| `28bd772` | TODO: tdzlaptop + two stale entries |
| `97942a9` | Activity shows what is running (**shipped broken** — see `97a9229`) |
| `97a9229` | Read running work from the journal, not the end-of-run file |
| `63f1e45` | `live-detection.test.js` — fixture-based, no agent runner |
| `fb3b90e` | A session appears when opened, not when it first replies |
| `b69b22c` | Docs audit and fixes |
| `0c0b365` | Previous handoff (superseded by this file) |
| `7c259e5` | Per-meter provenance + **deleted the local estimate** |
| `99e4489` | Statusline/credential tests; stopped the tests phoning home |
| `fe5e558` | Unhooked-wrapper detection + CI |
| `bb2ea7d` | Docs for the above (dropped from `fe5e558` by an escaping bug) |

## 1. The 429 diagnosis (twice wrong, now verified)

Measured on this machine: **four** Stream Deck plugins called
`/api/oauth/usage`. `kr.co.postgresql.ai-limits` retried with **no backoff** —
~45 req/s, ~11,700 in six minutes, later ~140/s. Removing its *buttons* did not
stop it; killing its process made Stream Deck respawn it; only **uninstalling**
did. All four are now uninstalled.

But that is not why the endpoint 429s. Verified via `gh search issues`:
- **anthropics/claude-code#30930** — *open*, `bug`/`area:api`/`area:statusline`.
  Persistent 429 with `retry-after: 0` for Max users at 30s/60s/120s.
- **#31637** — 10-minute polling throttled within the hour; 30-minute backoff
  still failing for hours.
- **#31055** — 429 after a *single* request, including Claude Code's own
  `/usage` command.

**Do not re-derive this as "we polled too much".**

## 2. The statusline route (the actual fix)

Claude Code passes `rate_limits` to statusline scripts since **v2.1.80**;
verified against <https://code.claude.com/docs/en/statusline>, not just a
comment. `resets_at` is **epoch seconds** here (ISO string from the OAuth API).

- **`statusline-tee.js`** — wraps the configured statusline, saves `rate_limits`
  to `~/.claude/statusline-usage.json` (atomic temp+rename), passes stdin and
  stdout through. Every failure path still runs the wrapped command.
- **`statusline.js`** — reads it back in the same shape `official.js` returns,
  so the widget needed no change. Current ≤10 min, `stale` to 45 min, withheld
  past 45.
- **`server.js`** — `officialForSnapshot()` takes whichever path answered most
  recently.

`~/.claude/settings.json` `statusLine.command` is now:
`node C:/Users/mit/claude/icue/usage-server/statusline-tee.js npx -y ccstatusline@latest`

Closed a TODO for free: `seven_day.resets_at` = **Thu 21:00 local**, confirming
the weekly anchor.

## 3. Activity = what is running (two attempts)

**`97942a9` was wrong**: it filtered `wf_*.json` by status, and that file is
only written when a run **ends**. The lists stayed permanently empty; the user
spotted it before I did.

**`97a9229` is correct**: the live source is the run's transcript directory,
which exists from launch —
`subagents/workflows/wf_<runId>/journal.jsonl`; an agent with `started` and no
`result` is running. Bounded by `LIVE_RUN_STALE_MS` (15 min) on directory mtime.

Also: sessions appear when **opened** (`fb3b90e`) — a fresh transcript holds only
`mode`/`permission-mode`/`attachment`/`system`/`last-prompt` and no message at
all, so requiring a counted message hid it. Queued `whattask.json` tasks are no
longer shown as subtasks (86 planned tasks were reading as live work).

## 4. Tests

| File | What | Cost |
|---|---|---|
| `test/live-detection.test.js` | 18 checks — live/finished/stale/partial runs, sessions, nesting | ~2 s |
| `test/statusline.test.js` | 35 checks — freshness, credentials, redaction, unhooked wrapper | ~3 s |
| `test/activity-probe.workflow.js` + `activity-probe-check.js` | end-to-end with real agents | ~100 s, ~81k tokens |

All **mutation-checked** — reverting the live-run lookup fails 9, reverting the
just-opened-session rule fails 3, reverting the estimate deletion is N/A.

## 5. The six improvements (all done)

1. **Per-meter provenance** (`7c259e5`, widget **1.8.0**). Claude Code drops a
   window from `rate_limits` once its `resets_at` passes; the badge said `LIVE`
   while that meter silently showed measured tokens. Now the badge reads
   **`LIVE¹`** (amber, `.is-partial`) and the meter is marked **`· measured`**
   (`.name.is-measured::after`).
2. **Deleted the estimate** (`7c259e5`). It served `session.percent 34` /
   `weekly.percent 52` against real 25/18. Removed: those fields,
   `budgetWeighted`, `buckets`, `estimated`, `pct()`, `weeklyBudget()`, four
   `limits.json` keys, the debug page's warnbox and budget rows, and the
   startup-log percentages. `usedWeighted`/`peakWeighted` stay (measured).
3. **Credential test** (`99e4489`). Was a README claim with no test.
4. **Statusline tests** (`99e4489`).
5. **Unhooked-wrapper detection** (`fe5e558`). Active session + non-current file
   ⇒ `diagnostics.statusline.likelyUnhooked`, reason appended to
   `official.error` (so the widget's existing tooltip shows it, no widget
   change), plus a `Statusline feed` section on `/usagehtml`.
6. **CI** (`fe5e558`). `.github/workflows/tests.yml` — both hermetic suites,
   Ubuntu + Windows × Node 20 + 22, plus `node --check`. **Green, 35 s.**

## 6. Two isolation defects found in my own tests

- **The fixture tests were polling Anthropic.** `refreshOfficial()` runs
  unconditionally at startup, so every spawned test server read the real
  credentials and hit the rate-limited endpoint — from a test described as
  costing nothing, run ~6 times. Fixed with **`CLAUDE_USAGE_NO_REMOTE`**, placed
  **before the first `rebuild()`** (a snapshot cached earlier still carried
  `"not fetched yet"`). `live-detection.test.js` asserts the guard is in force.
- That assertion immediately caught a second leak: the test was reading the
  **real** `statusline-usage.json`, so its `official` block was the developer's
  own usage. Now pointed at a fixture path.

## 7. Label redaction (a real leak, not a tautology)

Labels are built from prompt text, so a pasted key would render on the display
and be served over HTTP. `redactSecrets()` in `server.js` replaces `sk-ant-…`,
long `sk-…`, `Bearer …`, `ghp_…` with `[redacted]`. Narrow on purpose —
`"fix the sk-ate parser"` survives untouched.
</work_completed>

<work_remaining>

## Immediate

1. **The Edge is still running widget 1.7.0.** Confirmed by screen capture — the
   header reads `v1.7.0` while the installed folder holds **1.8.0**. iCUE caches
   the page, so `LIVE¹` and `· measured` are **not yet visible on the device**.
   Needs a remove-and-re-add in iCUE (which also resets widget properties and
   mints a new GUID — the folder is currently
   `%APPDATA%\Corsair\CUE5\html_widgets\1dbc0a02-b2ef-4d46-9e9f-9f74348b3e4e`).

## Open TODO items (in `TODO.md`)

- **Show sessions from `tdzlaptop`.** Structural — the server walks
  `~/.claude/projects/**` on its own host. The usage bars already cover the
  laptop (server-side account figures); only the lists are machine-bound. Any
  design must decide what to show when the peer is unreachable: silence is
  indistinguishable from idle, the trap the active-only filter avoids.
- **Confirm touch drag on the device.** `interactive` is documented only for
  *click*. Fallback: page the lists on a timer.
- **`tab-buttons` throws in iCUE's settings panel** —
  `TabButtonsEditorSetting.qml:33: TypeError: Property 'rowCount' … is not a
  function`, for `tempUnit` and `colorTheme`. iCUE's own QML. Not investigated.

## Known limitations, documented not fixed

- **Subtask labels are the first line of the agent's prompt.** `opts.label` is
  never written to disk.
- **A workflow launched from a script outside the session's
  `workflows/scripts/`** falls back to its short run id (`wf f354826c-6c2`).
- **~40 s lag each way** — `REFRESH_MS` 20 s + widget poll 20 s. A run shorter
  than that can begin and end unseen. Tightening is cheap (~0.2% of a core at
  20 s) but **both** numbers must drop together.
- The credential test proves the payload does not echo the credentials file with
  remote polling **disabled**. It does not prove behaviour mid-request.

## Deliberately not done

- **Changing the User-Agent.** #30930 claims the API buckets by User-Agent; we
  send `xeneon-edge-widgets/usage-server`. Ruled out as working around a rate
  limit; flagged to the user, not acted on.
- **Refreshing the token to reset the rate-limit window** — deliberate evasion,
  and reported to break Claude Code's own auth.
</work_remaining>

<attempted_approaches>

## Dead ends — do not repeat

- **Local percentage estimation.** Disproved arithmetically (growth floor 4.28×
  vs a 4.00× ceiling). Now deleted from the code entirely; the disproof stays in
  `usage-server/README.md`.
- **Filtering `wf_*.json` by status to find running work.** The file does not
  exist until the run ends. Shipped in `97942a9`; the lists were empty.
- **`Start-Sleep -Seconds 60` in a probe agent.** The harness blocks a
  standalone sleep; the agent backgrounded it and returned "done" in **13.8 s**,
  reporting success without waiting. Use
  `node -e "…setTimeout(…,60000)"` and have it print its own elapsed time.
- **`spawn(cmd, args, {shell:true})`** — concatenates without escaping (Node
  DEP0190); a spaced path is re-split. Build one quoted command string.
- **Backgrounding the probe checker inside a `run_in_background` Bash call** —
  the wrapper exits and kills the child.
- **Assuming a guard takes effect where you place it.** `CLAUDE_USAGE_NO_REMOTE`
  was initially set *after* `rebuild()`, so the cached snapshot still said
  "not fetched yet" and the assertion failed.

## The recurring environment trap (hit four times)

**`\n`, `\\E`, `\U` inside a heredoc'd Python string that writes JS or Markdown.**
The heredoc mangles the escape, producing a literal newline or a Python
`SyntaxError`. It broke `live-detection.test.js`, `statusline.test.js`,
`usagehtml.js` and — worst — killed the `usage-server/README.md` edit *after*
`git add`, so `fe5e558` was committed and pushed **without its documentation**
(repaired in `bb2ea7d`).
**Use the Edit tool for any line containing a backslash escape or a Windows
path, and check `git status` before committing a scripted edit.**

## Corrections made mid-session

- Blamed the 429 on the wrong plugin, then on plugins generally; both wrong.
- Read a plugin log at 21:11 without noticing the machine had rebooted at
  21:07:16.
- A watcher printed "RECOVERED" — a false positive from my own fake test file,
  and it was reading snake_case fields (`five_hour.utilization`) that do not
  exist in the payload (`fiveHour.percent`).
- Described the fixture tests as costing nothing while they polled Anthropic.
</attempted_approaches>

<critical_context>

## Environment

- `icuewidget` CLI at `C:\Program Files\Corsair\iCUE Widget CLI\` (v0.4.45;
  0.4.47 available). `validate` then `package`.
- Xeneon Edge is `\\.\DISPLAY2`, **2560×720 at X=-1881, Y=1440**; widgets sit in
  **840×344** slots. Capture with `System.Drawing` `CopyFromScreen`.
- Node `C:\Program Files\nodejs\node.exe`; Chrome at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- Claude Code **2.1.251**; `gh` authenticated as `MichaelTroelsen`.
- Server runs under scheduled task **`ClaudeUsageFeed`** via `start-hidden.vbs`.

## Environment overrides (all unset in normal use)

| Variable | Purpose |
|---|---|
| `CLAUDE_USAGE_PROJECTS_DIR` | fixture projects tree |
| `CLAUDE_USAGE_STATUSLINE_FILE` | fixture statusline reading |
| `CLAUDE_USAGE_CREDENTIALS_FILE` | fixture credentials |
| `CLAUDE_USAGE_NO_REMOTE` | **stops the server polling Anthropic** |

## Key constants

| Constant | Value | File |
|---|---|---|
| `REFRESH_MS` | 20 s | server.js |
| `SESSION_ACTIVE_MS` | 15 min | server.js |
| `LIVE_RUN_STALE_MS` | 15 min | server.js |
| `OFFICIAL_INTERVAL_MS` | 12 min | server.js |
| `OFFICIAL_STALE_MS` | 45 min | server.js |
| `FRESH_MS` / `MAX_AGE_MS` | 10 min / 45 min | statusline.js |
| `EXPIRY_MARGIN_MS` | 30 min | official.js |
| `HIGH_WATER` / `CRITICAL_WATER` | 80 / 95 | widget.js |

## Non-obvious behaviours

- `wf_*.json` is written **only at completion**; the transcript directory exists
  from launch.
- A just-opened session's transcript contains **no message**.
- Claude Code **drops a window** from `rate_limits` once its `resets_at` passes,
  restoring it on the session's next API response — this is what makes the
  `LIVE¹` case real rather than theoretical.
- `resets_at` is epoch **seconds** in the statusline payload, an **ISO string**
  from `/api/oauth/usage`.
- `.icuewidget` packages are **gitignored** — do not try to commit them.
- Serving `/usage` never triggers an upstream fetch; polling the local feed is
  free. `?at=` rebuilds on demand, which is how the tests avoid waiting 20 s.
- **iCUE caches the page**; the header version is the only reliable indicator of
  what is running. Re-adding mints a new GUID and resets properties. **Do not
  restart iCUE** — it orphaned the dashboard layout once.

## Verification conventions

- Layout: exactly-sized `<iframe>` in a larger window (bare `--window-size`
  includes window chrome: `840,344` lays out at 824×249).
- To reach the Activity view headlessly, copy the widget to scratch and append a
  script dispatching `pointerdown`+`pointerup`; a `file://` iframe is
  cross-origin so the parent cannot drive it.
- To test a payload variant, append a script overriding `window.fetch` with a
  stub — this is how `LIVE¹` was verified.
- **Mutation-check every new test** by reverting the fix.
</critical_context>

<current_state>

## Complete and pushed

- `main` == `origin/main` at **`bb2ea7d`**; working tree clean.
- **CI green** across all four matrix jobs (Ubuntu/Windows × Node 20/22), 35 s.
- **C64 Weather 1.2.0** — unchanged all session, live on the Edge.
- **Claude Code Usage 1.8.0** — in the repo and in the installed folder;
  **the device is still showing 1.7.0** (see Work Remaining).
- `usage-server` — running under `ClaudeUsageFeed`.

## Live state, just measured

- `official.ok true`, `source: Claude Code statusline`, **29% / 19%**.
- `diagnostics.statusline`: `current true`, `likelyUnhooked false`, age 0.3 min.
- `counts`: `sessions 1, workflows 0, subtasks 0`, `sessionsSeen 20`,
  `workflowsSeen 18`, `subtasksSeen 30`, `queued 86`, `messages 11127`.
- `session.percent` is **absent** — the estimate is gone.

## Tests

```bash
node usage-server/test/live-detection.test.js   # 18 checks
node usage-server/test/statusline.test.js       # 35 checks
```
Both **all passed** at the time of writing, and in CI.

## The token refresh question — resolved, with a caveat

The old handoff asked whether the ~03:24 refresh would win the rotation race.
`.credentials.json` was **rewritten 03:29:27** with a new expiry of
**11:29:27**, and `.credentials.json.before-usage-server` (this server's
one-time backup, written 28 Aug 19:54) exists — so this server has written the
file back at least once, and the 03:29 write falls where its 30-minutes-ahead
refresh plus a 12-minute poll cadence would land. **Strong but not conclusive**:
`official` now comes from the statusline path, so `lastRefresh` is not visible
in `/usage` to confirm it directly.

It matters much less either way: the widget's figures need no token.

## Open questions

- Does `/api/oauth/usage` ever stop 429ing for this account? (Cosmetic now.)
- Does the iCUE webview forward touch **drags**?
- Should the 20 s/20 s intervals be tightened? Cheap, but not requested.
</current_state>
