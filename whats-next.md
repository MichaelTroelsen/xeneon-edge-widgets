# Handoff - Xeneon Edge widgets

Written 2026-08-30 at HEAD `76be7d8`, with the tree CLEAN and everything pushed.
Replaces the version written at `d313631`.

Repo: `C:\Users\mit\claude\icue` -> https://github.com/MichaelTroelsen/xeneon-edge-widgets
(public, `main`). Two iCUE HTML widgets for a Corsair Xeneon Edge, plus a local
feed server that supplies one of them.

**Versions, all measured rather than remembered:**

| | repo | installed on the device |
|---|---|---|
| C64 Weather | 1.5.4 | 1.5.4 - matches, do not re-add |
| Claude Code Usage | **1.11.0** | **1.10.0** - one behind, missing the fifth view |

**This file is written LAST on purpose.** It went stale within the hour three
times earlier in the session because it was written mid-drain. The convention
that came out of that: write the handoff after the work is committed, never
during. This revision was written at a clean tree.

<original_task>
The session opened with **"read what next"**. Everything after came from the
user's own follow-ups, in order:

1. "please list the themes and the roms missing. Please make it so when you
   click on the c64 weather it changes them."
2. Seven reference images (PET/BBC/CPC/Spectrum startup screens, the Amiga
   Kickstart screen, photographs of a CPC 464, a ZX Spectrum, a CBM 8032), plus
   "picture of BBC Micro machine." as a request for me to supply one.
3. "Everytime you switch theme to a new machine it should boot in 2 sec and
   then show the weather screen?"
4. "can you make the font size larger (+1) on the C64 widget?", narrowed by
   three device photographs and "this is the text that is to small it needs to
   be bigger.", then "The tempuratur size is fine."
5. "please check all themes" / "any suggested improvements"
6. **"can you make stats like this be added? to the claude code widget?"** with
   two `/stats` screenshots - the Overview heatmap and the Models chart. THIS IS
   THE LARGEST SINGLE THREAD OF THE SESSION and it is now COMPLETE: the heatmap
   shipped as the widget's fourth view (`200916e`) and the Models chart as its
   fifth (`76be7d8`).
7. "add code review of server js to the todo list." - which became a
   falsification pass that found seven defects, four of them now fixed.
8. "please restart the service." - the usage feed.
9. Repeated "commit and push" and "update docs." instructions, and a long run of
   the `/whattask` -> `/runqueue` -> `/runtask` task pipeline.

SCOPE NOTE: items 1-5 are the weather widget and are all finished and shipped.
Items 6-7 are the usage widget and its server, and are where the remaining work
is.
</original_task>

<work_completed>

## Commits this session, newest first

| SHA | What |
|---|---|
| `76be7d8` | A fifth view: tokens by model (ClaudeUsage 1.11.0) |
| `fdc13ba` | The README described the liveness bug as the design |
| `04f183d` | A record torn across a read boundary is no longer lost |
| `8b09af4` | The usage widget's layout suite passes, and its checks are not vacuous |
| `bf35c36` | WIP: the first test in the usage widget, which EXITS 1 |
| `c40979a` | Warn that PowerShell cannot reproduce a malformed-URL bug |
| `2bb38f6` | A run is live if anything inside it moved, not if its directory did |
| `d313631` | Handoff: the server.js review is the backlog now |
| `2d6b5e9` | /health tells you which of three things is wrong |
| `bc407e1` | Record what the server.js review actually found |
| `5d05fe1` | One bad query string no longer kills the feed |
| `d42b3bf` | Run the stats suite in CI |
| `ad9592a` | Handoff: catch up with the stats work |
| `200916e` | A fourth view for the usage widget: all time (1.10.0) |
| `5cc7e20` | Serve Claude Code's own stats rollup from the feed |
| `74ab741` | A test that looks at the widget, and the defects it found |

Earlier in the session and already described in the previous handoff:
`fb8520c`, `3dc0c4b`, `f0c4a29`, `0541d0f`, `acfeee4`, `1710ee2`.

## The /stats request, start to finish

**The server half** (`5cc7e20`). `GET /usage` gained a `stats` block read from
`~/.claude/stats-cache.json` through a new `CLAUDE_USAGE_STATS_FILE` override,
mtime-cached, gated on `version === 5`. Absent / unparseable / wrong-version each
return `stats: {unavailable: "<reason>"}` with the rest of the payload intact.
`usage-server/test/stats.test.js` is new (47 checks).

Crucially this needed NO backfill: the rollup already holds the whole thing, and
its `totalSessions` (296) matches what `/stats` itself prints, which is what
confirms it is the same source.

**The fourth view, All time** (`200916e`). A contribution heatmap over the whole
recorded span plus eight headline figures - sessions, messages, active days,
current and longest streak, busiest day, top model, total tokens.

**The fifth view, Tokens by model** (`76be7d8`). One stacked bar per calendar day
from `stats.dailyModelTokens`, models ordered by total descending and coloured
from a fixed five-entry categorical palette so a colour means the same model in
every column. Legend carries each model's total.

## THE SINGLE MOST IMPORTANT THING IN THIS FILE

**`stats.dailyActivity` and `stats.dailyModelTokens` are BOTH SPARSE BY DATE.**
The rollup writes a row only for a day that had activity:

- `dailyActivity`: 92 rows across a **284-day** span (2025-11-19 -> 2026-08-29)
- `dailyModelTokens`: 34 rows across a **39-day** span (2026-07-22 -> 2026-08-29)

Anything that indexes these by ARRAY POSITION puts every date in the wrong place.
That defect shipped once in the heatmap and was caught only by looking at the
render - the "busiest day" read `26 Dec` inside what the heading called a 92-day
window. Both views now lay out by calendar position and draw empty days as real
gaps. The gap in the Tokens-by-model chart around early August is that working.

They also cover DIFFERENT spans, so the chart has its own axis and heading and is
NOT plotted against the heatmap's or zero-filled to match.

## The server.js code review

Read-only falsification pass over 1138 lines / 35 functions / 11 module-level
mutable variables. **Seven findings, four now fixed.** Detail lives in
`.claude/tasks/runs.jsonl` under `server-js-code-review`; a one-line-each summary
is in `TODO.md` around line 208.

FIXED:
1. **(critical, `5d05fe1`)** `GET /usage?at=%` threw `URIError` uncaught out of
   the HTTP handler and killed the process. `start-hidden.vbs` is fire-and-forget
   with no restart supervision, so the feed and BOTH widgets stayed dead until
   the next logon. Now 400 for a malformed escape, 500 for our own bugs after
   checking `res.headersSent`, with an `uncaughtException` net behind both.
4. **(high, `2d6b5e9`)** A failed rebuild was invisible: `/usage` served the
   four-byte body `null` with 200 while `/health` reported `ok:true`. `/health`
   now reports three states.
2. **(high, `2bb38f6`)** Liveness was judged on the run DIRECTORY's mtime, which
   NTFS does not move on an append - so a fanned-out workflow vanished from the
   widget at 15 minutes while still running.
3. **(high, `04f183d`)** A record torn across a read boundary was lost for the
   life of the process.

STILL OPEN: findings 5, 6 and 7 - see `<work_remaining>`.

FALSIFIED, and worth as much as the findings. Six candidates were investigated
and killed, including the one `TODO.md:208` itself asked about: **"a reader sees
a half-built snapshot mid-rebuild" is FALSE**, because `build()` is entirely
synchronous and cannot be observed torn. The danger there is a FROZEN snapshot,
which is finding 4. Also false: `/usagehtml` crashing on a null snapshot,
`MAX_WORKFLOWS` truncating a live workflow, `officialInFlight` sticking true, and
a redaction gap that has no served path.

## Tests: from three suites to six, all in CI

| suite | checks | notes |
|---|---|---|
| `usage-server/test/http.test.js` | 49 | NEW this session |
| `usage-server/test/live-detection.test.js` | 25 | was 18 |
| `usage-server/test/statusline.test.js` | 35 | |
| `usage-server/test/stats.test.js` | 47 | NEW this session |
| `ClaudeUsage/test/layout.test.js` | 27 | NEW - the widget's FIRST test of any kind |
| `C64Weather/test/layout.test.js` | - | renders 7 themes, measures every box |
| `C64Weather/test/font.test.js` | 26 | |
| `C64Weather/test/theme.test.js` | 54 | |

All wired into `.github/workflows/tests.yml`, green on ubuntu/windows x node
20/22.

## The three-state /health contract

`healthy` (ok:true), `stale` (ok:true - a snapshot exists but rebuilds are
failing) and `unbuilt` (ok:false - nothing ever built). `/usage` answers 503
naming the failure rather than `200 null` in that last case.

**`stale` deliberately keeps `ok:true`.** The feed is still serving real data,
just ageing, and `generatedAt` pins to the last GOOD build so the staleness is
visible. A monitor that wants to act on it watches `state !== "healthy"`. Paging
someone at 3am because a working feed stopped rebuilding would be its own bug.
That reasoning is in a code comment and in `usage-server/README.md`, not only
here.

## Two new test-only env overrides

`CLAUDE_USAGE_CONFIG_PATH` (points `limits.json` at a fixture - it had NO
override before, so the stale/unbuilt states could not be tested without writing
the real file) and `CLAUDE_USAGE_REFRESH_MS` (shortens the rebuild cadence so a
test waits milliseconds rather than 10s). Both unset in normal use, both
documented, both in the style of the existing `CLAUDE_USAGE_PROJECTS_DIR` /
`STATS_FILE` / `STATUSLINE_FILE` family.

## The feed was restarted twice

Now pid **58812**, started 2026-08-30 12:49, running the build with both server
fixes. `/health` reads `{"ok":true,"state":"healthy","error":null}`.

**`Stop-ScheduledTask` does NOT work for this.** The `ClaudeUsageFeed` task
executes `wscript.exe` running `start-hidden.vbs`, which spawns node and exits -
so the task reads `State=Ready` even while the feed is up, and stopping it never
touches the node process. Kill by pid, then `Start-ScheduledTask`.
</work_completed>

<work_remaining>

Everything open is in `.claude/tasks/whattask.json`, keyed to HEAD `76be7d8`
(current as of writing). **7 open, 39 closed. 5 of 7 ready.**

## The three remaining server.js findings

All three write `usage-server/server.js`, so they SERIALISE - one per cycle, and
that is arithmetic from `touches` rather than a scheduling preference.

- **`fix-official-backoff-reset-on-credentials-write`** (sonnet, high, finding 5).
  The credentials watcher resets `officialFailures = 0` on ANY write to
  `.credentials.json`, with no 429-vs-401 distinction, and each token rotation
  fires it TWICE (verified: the write-tmp-then-rename pattern produces two events
  passing the filename filter). After two hours of 429s the backoff would be 60
  min; a rotation drops it to 15, a 4x rate increase against the endpoint whose
  own comment says "retrying a dead token every minute is how a 401 turns into a
  429 - which is exactly what happened". THE HARD PART IS TESTABILITY:
  `watchCredentials()` is only reached when `CLAUDE_USAGE_NO_REMOTE` is unset and
  every suite sets it, so it is unreachable under test by construction. A third
  env override in the existing family may be the honest way in.
- **`fix-lastquota-most-recent-not-max-resetsat`** (sonnet, medium, finding 6).
  `lastQuota` keeps the farthest-future reset forever rather than the most recent
  record. **LATENT, NOT FIRING** - every `quotaLimits` record observed in the wild
  is `five_hour`, and it needs a `seven_day` one to trigger. Re-check that first;
  the corpus has grown. Second, separate defect in the same lines: there is no
  429 check at all, contradicting the variable's own name.
- **`fix-seen-counts-taken-after-slice`** (sonnet, low, finding 7).
  `workflowsSeen`/`subtasksSeen` are counted from the already-sliced arrays, so
  the truncation diagnostic can never report truncation. Certain from the code.

## Everything else

- **`audit-check-counts-in-usage-server-readme`** (sonnet, low, PARALLEL - the
  only task with no contention). Prose check-counts in the README go stale every
  time a suite grows; two have been caught one at a time already. Also asks
  whether prose counts are worth keeping at all.
- **`sanitise-opened-arrays-in-runs-log`** (sonnet, low, MUST RUN ALONE). Several
  `runs.jsonl` records put FILE PATHS in their `opened` array instead of task ids.
  It rewrites the append-only log that every runner - including an orchestrator at
  join time - appends to, so it cannot share a cycle with anything.
- **`verify-touch-drag`** (requires-user). **The device precondition is GONE.**
  It reads 1.10.0, so it HAS the tap handler, four cycling views and the
  scrolling lists this question is about. The only blocker left is a finger on
  the glass: drag-scroll an activity list and confirm the view does NOT change.
  Lists scroll AND tap switches view, both gated on the same 12px slop and 700ms
  hold, so a webview delivering pointerdown/pointerup with no intermediate
  positions reads every scroll as a tap.
- **`reload-widgets-for-1-11-0`** (requires-user). The device is one version
  behind. Re-add ONLY Claude Code Usage; C64 Weather is 1.5.4 on both and
  re-adding it would cost a properties reset for no gain. Confirm from the
  RENDERED page, not the installed folder - iCUE's page cache means the folder is
  not proof. Re-adding resets widget properties and mints a new GUID; that cost
  is known and was accepted once already.
</work_remaining>

<attempted_approaches>

## Dead ends and corrections - do not repeat these

**The heredoc / `python -c` trap - EIGHT sightings.** A backslash escape or a
Windows path inside a heredoc'd or `python -c` string gets mangled. The eighth
sighting was while editing THIS FILE to record the seventh: `C:\Users` inside a
heredoc'd Python string died on `truncated \UXXXXXXXX escape`. **Use a scratch
`.py` file run by path, or the file-editing tools.**

**Three times a plan's stated mechanism was WRONG and measuring first saved it:**

1. I wrote, twice, that an agent's real start time "is already parsed and
   discarded - `readJournal` keeps the whole `started` record but the caller takes
   only `.keys()`". FALSE. Journal records carry NO timestamp - measured across
   234 records in 40 real journals, `started` has only
   `['agentId','key','type']`. The only on-disk source is the first record of
   `agent-<id>.jsonl`.
2. The "obvious" fix for the liveness bug - stat `journal.jsonl` instead of the
   directory - does NOT work. The journal takes its `started` lines at fan-out and
   then nothing until a result lands, so a 40-minute agent leaves it as frozen as
   the directory. The agent TRANSCRIPTS are what move mid-run.
3. The vacuity check that would not fire was NOT the specificity loss I guessed
   (that failure has happened in this repo before, which is why it was the obvious
   hypothesis). `getComputedStyle` falsified it: the injected `!important` rule
   does win. The real cause was `flex-shrink: 1` collapsing the injected 300%
   width back to fit - measured 647.6px, not the ~2343px implied.

**A green test can hide a broken mechanism.** A malformed CSS comment (a closing
`*/`, more prose, then another `*/`) silently ate a whole rule in
`C64Weather.css`. Every suite passed because they measure the RESULT and the
result happened to be right. Convention that came out of it: when a fix IS a CSS
rule, confirm with `getComputedStyle` that the rule is applied.

**A near-repeat of that, caught before rendering:** writing CSS tokens with a
nested Python `.replace()` produced the literal line
`--heat-2: #35five".replace(...)` in the stylesheet. Found by reading the file
back rather than trusting the write.

**Two vacuous checks shipped before they were caught:** an alternation grep
without `-E` (searches for literal pipe characters, returns 0 whatever the file
holds), and a mutation check that did not fire. **A mutation that does not fire
is a MISSING TEST, not a passing one.**

**A CI clause that no runner can satisfy, TWICE.** I wrote "green on all four
matrix jobs" into two tasks' verify strings and ran them under commands whose
contract is that they never commit or push. Both recorded `partial` for a clause
that was structurally unsatisfiable. Every task in the current plan now says
local pass plus the step present in `tests.yml` is the bar.

**A committed test that exits 1.** `bf35c36` deliberately committed
`ClaudeUsage/test/layout.test.js` red, after a session limit killed the agent
~700 lines in, because losing the harness would have cost more. It was NOT wired
into CI, so nothing broke, and `8b09af4` fixed it. Recorded because a red test in
a tree is a trap for anyone who runs it.

**PowerShell cannot reproduce a malformed-URL bug at all.** `Invoke-WebRequest
'.../usage?at=%'` returns 200 with a full payload, which reads as "the crash fix
is not there". .NET's `Uri` class normalises the bare `%` to `%25` before the
request leaves. Documented in `usage-server/README.md`; use `curl --path-as-is`
or a raw `http.client` connection.

**`node -e "require('.../server.js')"` is NOT a safe syntax check.** server.js
binds its port at require time, so it tries to take 41777 - the live feed. Use
`node --check`.

**A backgrounded `node ... &` is not killed by `kill %1` from a later Bash call.**
Each invocation is a fresh shell with no job-control memory. A stray server kept
its port and made a mutation check pass against the WRONG binary. Use
`netstat -ano | grep <port>` then `taskkill //F //PID <pid>`.

## Alternatives considered and rejected

- **Log scale for the Tokens-by-model chart.** Rejected: the bars are STACKED,
  so segments have to sum to their column, and a log axis breaks that arithmetic.
  Per-day totals span 43x and a quiet day genuinely was 2% of a loud one.
- **Adding the Models chart to the All time view** rather than a fifth view.
  Rejected by measurement: the layout suite puts All time's tightest fit at
  +7.2px of headroom at 840x344.
- **Measuring overflow against the nearest scrolling ancestor's box** in the
  layout suite. The alternative - skip descendants of scrollers, assert the
  scroller itself - was chosen because nothing in this widget nests scrollers.
</attempted_approaches>

<critical_context>

## Environment

- Windows 11, Git Bash AND PowerShell both available. Prefer PowerShell for
  anything touching processes or scheduled tasks.
- Device: Xeneon Edge on `\\.\DISPLAY2`, 2560x720 at X=-1881, Y=1440. Widget
  slots are **840x344**. Capture with `System.Drawing` `CopyFromScreen`.
- `icuewidget validate|package` at `C:\Program Files\Corsair\iCUE Widget CLI\`.
- Installed widgets live under
  `C:\Users\mit\AppData\Roaming\Corsair\CUE5\html_widgets\<guid>\`.
- The feed is the `ClaudeUsageFeed` scheduled task -> `wscript.exe` ->
  `usage-server/start-hidden.vbs` -> `node server.js` on **127.0.0.1:41777**.

## Headless Chrome - all four calibrations, hard-won

These are written up in `README.md`'s "Verifying a layout" section too.

1. **`--window-size` means DIFFERENT things in the two modes.** Under
   `--dump-dom` it is the window and Chrome subtracts chrome: `840,344` lays out
   at **824x193**, and `856,495` is needed for a true **840x344**. Under
   `--screenshot` the viewport is resized to the full window just before capture,
   so `840,344` is what gives an 840x344 page. A probe and a screenshot of the
   same layout need DIFFERENT flags.
2. **`window.innerWidth` read during load is the PRE-resize size** and disagrees
   with what is painted. Measuring it early is how the wrong figure got into the
   README originally (it said 824x249; it is 824x193).
3. **CSS transitions do not advance under `--virtual-time-budget`**, and
   `--force-prefers-reduced-motion` does NOT fix it. `getComputedStyle` returns
   the pre-change colour - this made the view indicator look stuck on the first
   dot when it was correct. Inject `* { transition: none !important }`.
4. **`--user-data-dir` under a scratch directory is mandatory** - a running
   Chrome on the default profile breaks bare `--headless`.

Also: `file:///$PWD/...` fails with `ERR_FILE_NOT_FOUND` because Git Bash's `pwd`
returns a POSIX mount path. Hardcode the Windows path.

## server.js: the one invariant a future edit must respect

`readIncrement`'s state now carries `size` (the stat size) AND `cursor` (the
resume offset, just past the last consumed newline), and **they deliberately
differ while a torn tail exists**. Anything that treats `state.size` as "how far
we have read" silently reintroduces the record-loss bug `04f183d` fixed. The
resume offset is `cursor`.

## Line numbers in older records are WRONG

`usage-server/server.js` has grown 1138 -> 1277 -> 1338 -> **1376** lines across
four commits this session. Every citation in the review record has moved at least
once. The current plan re-anchors them, but **locate by CONTENT** (grep the quoted
expression) rather than trusting any line number.

## The task pipeline

`.claude/tasks/` holds `whattask.json` (the plan, keyed to a HEAD sha),
`runs.jsonl` (append-only, **39 lines**, last-line-per-id wins), `decisions.jsonl`
(**5 lines**, outranks the plan) and `serial.lock` (currently **0 bytes** - nothing
held) with a `serial.lock.d` mutex.

**Contention is computed from `touches`, never from `lane`.** A READER conflicts
with a WRITER. Two floors the arithmetic cannot see: a resource that is exclusive
by nature (the device, a single dev port), and a task whose `needs_main_reason`
says it must run alone.

**A lock-release bug worth not repeating:** matching records on
`pid == os.getpid()` fails, because claim and release run as separate short-lived
processes. Match on task id + host, then prove the claiming pid is dead.

**A starvation pattern worth knowing.** `/runqueue` step 4 fills the delegable
fan-out first, then takes a main task that conflicts with nothing in it. A
`main`-mode task that reads a file the delegable tasks write is therefore starved
FOREVER. `usage-widget-model-token-chart` was refused four cycles running for
exactly that reason and only ran when I deliberately left the fan-out empty. Its
`r:usage-server/server.js` was a WEAK dependency - it read the server only to
check a payload shape the live feed already serves.

## Decisions already taken - DO NOT RE-ASK

Recorded in `.claude/tasks/decisions.jsonl`:

- **ROM font bitmaps in this public repo: REFUSED** (2026-08-29). Six rights
  holders against a public repo for a cosmetic gain. `PETSCII.setFont(mode,
  glyphs, mixedCase)` stays as the hook if that ever changes. Research kept
  anyway: the BBC's font is VERIFIED at `&C000` in the OS ROM, 8 bytes per
  character, 768 bytes for chars 32-127 (tobylobster MOS 1.20 disassembly,
  stardot). The CPC's offset remains unverified.
- **tdzlaptop sessions in the activity lists: DECLINED** (2026-08-29). The usage
  bars already cover the laptop because five-hour and weekly utilisation are
  server-side account figures counting every client. Only the lists are
  machine-bound, and their value is that an empty list means nothing is running
  HERE.
- **Machine art placement: "Beside the text" + "Use Wikimedia photos"**, since
  superseded by measurement - the art moved BOTTOM-right because the boot lines
  are top-anchored and centring the art was what caused the text to scale down.

## Verification conventions this repo has earned

- **If the claim is visual, look at the picture.** Several defects passed every
  structural check and were caught only by rendering and reading the image.
- **Mutation-check every new assertion**, and treat a mutation that does not fire
  as a missing test rather than reassurance.
- **Re-run reported numbers, never copy them.** Agent-reported counts have been
  wrong in three of five runs; one reported 58 against a measured 47.
- **Confirm a CSS rule is APPLIED** with `getComputedStyle`, not just that the
  page looks right.
- **An agent that hits an undeclared path should STOP and report**, not take it.
  That has now gone right four times.
</critical_context>

<current_state>

## Everything is committed and pushed

- HEAD `76be7d8` == `origin/main`. **Working tree CLEAN.**
- CI green on all four matrix jobs at `76be7d8`; six suites run there.
- `.claude/tasks/serial.lock` is 0 bytes - no locks held, no cycle in flight.
- `.claude/tasks/whattask.json` is keyed to `76be7d8` and is CURRENT.

## The feed is healthy and current

pid **58812**, started 2026-08-30 12:49, running the build with both server
fixes. `/health` -> `{"ok":true,"state":"healthy","generatedAt":1788091380165,
"error":null}`. It serves the `stats` block; `totalSessions` 296 matches
`~/.claude/stats-cache.json`.

## The device is one version behind

C64 Weather 1.5.4 matches the repo. Claude Code Usage reads **1.10.0** against a
repo at 1.11.0 - it has the All time view but not Tokens by model. Both GUIDs are
newer than the ones the previous handoff recorded, so a re-add has happened since
that file was written.

## Deliverable status

| | |
|---|---|
| C64 Weather (themes, boot, machine art, fonts) | COMPLETE and on the device |
| Usage widget: All time view | COMPLETE, on the device |
| Usage widget: Tokens by model | COMPLETE in repo, NOT yet on the device |
| Feed `stats` block | COMPLETE and live |
| server.js review | COMPLETE - 7 findings, 4 fixed, 3 open |
| Test coverage | 6 suites in CI, up from 3 |

## Open questions

- **Does the iCUE webview forward touch DRAGS?** Unanswered and now answerable -
  the device has everything needed. This is `verify-touch-drag`.
- **Are prose check-counts in `usage-server/README.md` worth keeping?** Two have
  gone stale and been fixed one at a time. `audit-check-counts-in-usage-server-readme`
  asks for a recommendation, not just a third correction.
- **Should `start-hidden.vbs` gain restart supervision?** The `uncaughtException`
  handler added in `5d05fe1` is a mitigation, not a replacement, and it is the
  right trade ONLY because nothing restarts this process. If a supervisor ever
  appears, revisit it - a process staying up in an unknown state is worse than one
  restarting clean. Not currently a task.

## Nothing is temporary or half-applied

No workarounds are in place, no files are staged, no scratch artefacts were left
in the repo. Everything under
`C:\Users\mit\AppData\Local\Temp\claude\...\scratchpad\` is disposable.
</current_state>
