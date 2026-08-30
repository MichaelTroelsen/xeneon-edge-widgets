# Handoff - Xeneon Edge widgets

Written 2026-08-30 at HEAD `7084246`, with the tree CLEAN and everything pushed.
Replaces the version written at `eb90dc3`, every item of which is now closed.

Repo: `C:\Users\mit\claude\icue` -> https://github.com/MichaelTroelsen/xeneon-edge-widgets
(public, `main`). Two iCUE HTML widgets for a Corsair Xeneon Edge, plus a local
feed server that supplies one of them.

**Versions, measured at the time of writing rather than remembered:**

| | repo | installed on the device |
|---|---|---|
| C64 Weather | 1.5.4 | 1.5.4 - matches, do not re-add |
| Claude Code Usage | **1.12.0** | **1.11.0** - one behind, has no self-paging lists |

**This file is written LAST, at a clean tree, after everything else is
committed.** It went stale within the hour three times in one session by being
written mid-drain, and the previous revision still claimed the device was on
1.10.0 against a repo at 1.11.0 when both figures had moved. If you are reading
this and the tree is dirty, the file is already older than the work.

<original_task>
The session opened with **"read what next"**. Everything after came from the
user's own follow-ups:

1. **"widget reloaded. no drag."** - a two-line report that settled a question
   this repo had carried for weeks and invalidated a design assumption in the
   usage widget. This is the most consequential thing in the session.
2. A choice between three remedies for the consequence, answered
   **"Auto-page on a timer"**.
3. Repeated `/loop 4 /runtask next` drains against the task plan, with
   **"commit and push"** standing between iterations.
4. Two `/whattask` regenerations.
</original_task>

<work_completed>

## Commits this session, newest first

| SHA | What |
|---|---|
| `7084246` | A check that the env overrides and the docs agree, and the gap it found |
| `642f80a` | Document the two overrides that made the credentials watcher testable |
| `2fac14b` | A second stale check-count, and the reason there will be a third |
| `92087d7` | The last two review findings, and the review is complete |
| `0a09297` | A credentials write no longer clears a backoff the rate limit earned |
| `3503452` | Lists nobody can scroll now page themselves |

## THE FINDING THAT MATTERS MOST

**The iCUE webview does NOT forward touch drags.** Settled on the device at
1.11.0 on 2026-08-30 by a human with a finger on the glass. A drag across an
activity list does not scroll it; the list stays put.

- **Taps ARE forwarded.** `TAP_SLOP_PX` (12) and `TAP_MAX_MS` (700) are correct
  and were NOT changed. The specific bug the test was written to catch - a drag
  misreading as a tap and flipping the view - **does not exist**. The view
  stayed put.
- What it falsified instead was a premise stated in `widget.js`'s own comment:
  *"lists scroll rather than being trimmed to fit, so nothing is unreachable."*
  On this device nothing scrolls by hand. Measured at a true 840x344, the
  Activity view showed **7 of up to 40 rows** per column and stranded the other
  33 behind a fade that promised content nobody could reach.

**Do not design anything for this device that depends on reaching a scrollable
region by hand, and do not re-ask this question.**

## The remedy: self-paging lists (`3503452`, widget 1.12.0)

An overflowing region advances one page every 5s and wraps. A region that fits
never moves. Driven off **computed overflow**, not a list of ids, so the Tokens
view's two columns page on the same mechanism without being named - they
overflow by 24px each, which only the measurement found.

Page boundaries snap to **row** boundaries. The rows do not divide the box
evenly (7.2 of them fit), so paging by a flat box-height step would slice a row
in half at every boundary. The fade now means "there is more below THIS PAGE"
and goes out on the last one; a dot per page rides in the heading, costing no
vertical space.

Layout suite 27 -> 51 checks, asserting per list that every one of its 40 rows
becomes fully readable, that the last page reaches the bottom, that the fade is
off there, and that the lit dot is the page actually shown.

## The server.js review is CLOSED: seven findings, seven fixed

Four landed before this session (`5d05fe1`, `2d6b5e9`, `2bb38f6`, `04f183d`).
This session took the last three:

- **Finding 5 (`0a09297`)** - a credentials write wiped rate-limit backoff, and
  each rotation fired it twice. `officialRateLimited` now comes from the same
  `/HTTP 429/` test already feeding `scheduleOfficial`; an mtime compare
  collapses the doubled `fs.watch` events. The 401-then-new-token path is
  unchanged and asserted.
- **Finding 6 (`92087d7`)** - `lastQuota` kept the farthest-future reset rather
  than the most recent. Predicate now compares `seenAt`, and admission requires
  `apiErrorStatus === 429`. **STILL LATENT**: 15 `quotaLimits` records in the
  corpus, all `five_hour`/`rejected`, still **zero** `seven_day`. Both fixtures
  are synthetic. The 429 gate is a **narrowing** - a genuine 429 without that
  field would now be ignored, under-reporting `blocked` rather than over.
- **Finding 7 (`92087d7`)** - `workflowsSeen`/`subtasksSeen` were counted after
  the cap, so the truncation diagnostic reported exactly the number that hides
  truncation. Counts now come out of `collectWorkflows()` pre-slice.

Six further candidates were falsified and are recorded as negative results.

## Tests, all measured at HEAD

| suite | checks |
|---|---|
| `usage-server/test/http.test.js` | **94** (49 -> 56 -> 61 -> 69 -> 94 this session) |
| `usage-server/test/stats.test.js` | 47 |
| `usage-server/test/statusline.test.js` | 35 |
| `usage-server/test/live-detection.test.js` | 25 |
| `ClaudeUsage/test/layout.test.js` | **51** (was 27) |
| `C64Weather/test/theme.test.js` | 54 |
| `C64Weather/test/font.test.js` | 26 |
| `C64Weather/test/layout.test.js` | renders 7 themes, measures every box |

All wired into `.github/workflows/tests.yml`, each as its own step.
</work_completed>

<work_remaining>

**Everything open is in `.claude/tasks/whattask.json`, keyed to `642f80a`
(one commit behind HEAD, docs-only drift). THREE tasks, ALL blocked on the
human.** There is no ready agent work left in the plan.

- **`reload-widgets-for-1-12-0`** (requires-user). The device reads 1.11.0
  against a repo at 1.12.0, so it does NOT have the self-paging lists. Re-add
  ONLY Claude Code Usage; C64 Weather matches at 1.5.4 and re-adding it costs a
  properties reset for no gain. Confirm from the RENDERED page - iCUE's page
  cache means the installed folder is not proof. Expect a third GUID folder;
  two already exist from earlier re-adds and are harmless.
- **`verify-paging-on-device`** (requires-user, depends on the above). **This
  one matters more than it looks.** Every claim about the pager was measured in
  headless Chrome, and this device has already diverged from a browser once -
  that divergence is why the feature exists. The pager moves `scrollTop`
  programmatically; nothing yet proves the webview honours a programmatic
  scroll on an `overflow-y: auto` element when it refuses a touch drag. If it
  does not, the lists sit frozen on page 1 with the dots advancing underneath
  them, **which looks like working software from a distance**. Check that the
  ROWS change, not just the dots. Fallback if they do not: page by translating
  the list content rather than by `scrollTop`.
- **`replace-prose-check-counts-in-usage-server-readme`** (requires-user). An
  editorial call: keep the prose check-counts and keep correcting them, or drop
  them for language about each suite's shape. Evidence for dropping is in the
  task and below.

</work_remaining>

<attempted_approaches>

## Traps that cost real time - do not repeat these

**The heredoc / `python -c` trap - EIGHT sightings and still live.** A backslash
escape or Windows path inside a heredoc'd or `python -c` string gets mangled.
It bit again this session inside a `sed` expression: a `|` delimiter collided
with the `||` in the JavaScript being matched, the command errored, and the
chained `grep` short-circuited so **no test ran while the output still looked
like a completed mutation check**. Caught only because the expected FAIL line
was missing. **Use a scratch `.py`/`.js` file run by path, or the file-editing
tools; and pick a `sed` delimiter that cannot appear in the pattern.**

**"It parses equal" is weaker than "the bytes are untouched."** Sanitising the
append-only run log, the first pass re-serialised each record with
`json.dumps`. Every field compared equal and the field-equality check PASSED -
but a byte diff showed an escaped `\u2014` had been silently re-encoded as a
literal UTF-8 em dash. Same value, different bytes, on a file whose entire worth
is that earlier records are immutable. **On an append-only log, verify at the
byte level.** Redone as a targeted substring replacement: exactly the two
intended lines changed, the other 44 byte-identical.

**A green test can hide a broken mechanism, and so can a broken mutation.** A
mutation that makes the harness TIME OUT looks nothing like a mutation that
fires, and one did exactly that this session when a test polled for a transient
value that was overwritten within the same millisecond. Fixed by waiting for a
change from a known baseline, then asserting the settled value. **A mutation
that does not fire cleanly is a missing test, not reassurance.**

**A screenshot can be painted from a layout that was never current.** The first
renders of the pager showed headings cut to "SESSIO..." and a 168px indicator,
which read as a design failure. It was the `--screenshot` viewport trap this
repo's own README documents: the paint came from the PRE-resize layout. The
README's iframe-slot recipe sidesteps it entirely and is what to use.

**Agent-reported numbers do not survive re-running, often enough that re-running
is the rule.** Most recently a delegated run reported "58 checks, 9 new" against
a measured 56 and 7. **Re-run every number a decision rests on.** Note also that
the *previous* handoff carried a statistic ("wrong in three of five runs") that
this one cannot verify and has therefore not repeated - carried statistics
inflate; carry the rule, not the tally.

**Measuring first has now corrected a stated mechanism five times.** Two from
this session: the page dots made a heading WRAP, taking one column's box from
232px to 210px - a whole row lost to the indicator meant to help (a loose text
node is an anonymous flex item that will not shrink; it needed a real element);
and `README:128` documented `CLAUDE_USAGE_CREDENTIALS_FILE` while `server.js`
never read it, proved by `git show 0a09297~1:usage-server/server.js | grep -c
CLAUDE_USAGE_CREDENTIALS_FILE` returning **0**.

**A commit message once claimed a wiring that did not exist.** `99e4489` said
`CLAUDE_USAGE_CREDENTIALS_FILE` was wired up; `server.js` did not read it until
`0a09297`, hours ago. Commit messages in this repo are unusually detailed, which
makes them worth reading - and worth checking.

## Alternatives considered and rejected

- **Trimming the lists to what fits with a "+33 more" row**, instead of paging.
  Rejected by the human in favour of paging, which reaches every row.
- **Tap zones to page a column.** Viable, since taps ARE forwarded, but it
  overloads the single established gesture.
- **Log scale for the Tokens-by-model chart.** Rejected: the bars are STACKED,
  so segments must sum to their column.
</attempted_approaches>

<critical_context>

## Environment

- Windows 11, Git Bash AND PowerShell. Prefer PowerShell for processes and
  scheduled tasks.
- Device: Xeneon Edge on `\\.\DISPLAY2`, 2560x720 at X=-1881, Y=1440. Widget
  slots are **840x344**. Capture with `System.Drawing` `CopyFromScreen`.
- `icuewidget validate|package` at `C:\Program Files\Corsair\iCUE Widget CLI\`.
- Installed widgets: `C:\Users\mit\AppData\Roaming\Corsair\CUE5\html_widgets\<guid>\`.
- The feed is the `ClaudeUsageFeed` scheduled task -> `wscript.exe` ->
  `usage-server/start-hidden.vbs` -> `node server.js` on **127.0.0.1:41777**.

## Headless Chrome - four calibrations, all still true

1. **`--window-size` means DIFFERENT things in the two modes.** Under
   `--dump-dom` it is the window and Chrome subtracts its own chrome:
   `856,495` is what yields a true **840x344**. Under `--screenshot` the
   viewport is resized to the full window just before capture.
2. **`window.innerWidth` read during load is the PRE-resize size.** This is not
   theoretical - it produced a screenshot this session that looked like a
   layout bug and was not.
3. **CSS transitions do not advance under `--virtual-time-budget`**, and
   `--force-prefers-reduced-motion` does not fix it. Inject
   `* { transition: none !important }`.
4. **`--user-data-dir` under a scratch directory is mandatory.**

**The recipe that sidesteps 1 and 2 entirely**, and the one to reach for: host
the widget in an exactly-sized `<iframe width="840" height="344">` inside a
larger window and screenshot that. Documented in `README.md`.

Also: `file:///$PWD/...` fails under Git Bash (POSIX mount path). Hardcode the
Windows path. And a page written OUTSIDE the widget directory needs a `<base
href>` or its relative `<script src>` 404s - **a script that fails to LOAD does
not reach a window `error` listener**, so the harness looks healthy and silently
measures a page where the widget never ran.

## Invariants a future edit must respect

- **`readIncrement`'s `size` vs `cursor`.** State carries `size` (the stat size)
  AND `cursor` (the resume offset, just past the last consumed newline), and
  they **deliberately differ while a torn tail exists**. Anything treating
  `state.size` as "how far we have read" reintroduces the record-loss bug
  `04f183d` fixed. The resume offset is `cursor`.
- **BOTH stats arrays are SPARSE BY DATE.** `dailyActivity` and
  `dailyModelTokens` each carry a row only for a day with activity, and they
  cover DIFFERENT spans. Anything indexing them by array POSITION puts every
  date in the wrong place. That defect shipped once in the heatmap and was
  caught only by looking at a render.
- **`server.js` line numbers in old records are WRONG.** The file has drifted
  every time it is touched, and a cited line has been stale four consecutive
  times. **Locate by content.**

## Verification conventions this repo has earned

- **If the claim is visual, look at the picture.**
- **Mutation-check every new assertion**, and prefer making the mutation a
  PERMANENT self-check rather than a one-off - `http.test.js`'s env-override
  checks do this, so they cannot rot into vacuous ones unnoticed.
- **Re-run reported numbers, never copy them.**
- **Confirm a CSS rule is APPLIED** with `getComputedStyle`.
- **`node --check`, never `node -e "require('.../server.js')"`** - server.js
  binds 41777 at require time and the live feed holds it.
- **An agent that hits an undeclared path should STOP and report.** That has now
  gone right every time it has come up.

## The task pipeline

`.claude/tasks/` holds `whattask.json` (keyed to a HEAD sha), `runs.jsonl`
(append-only, **50 lines**, last-line-per-id wins), `decisions.jsonl` (**6
lines**, outranks the plan) and `serial.lock` (a JSON array of holder records)
with a `serial.lock.d` mutex. **The whole `/.claude/` tree is gitignored**, so
none of it is committed and a task that only writes there leaves the git tree
clean.

- **Contention is computed from `touches`, never from `lane`.** A READER
  conflicts with a WRITER.
- **Claim and release under the mutex, against a registry re-read from disk.**
- **Record a pid that outlives the task.** `$PPID` under Git Bash returns **1**,
  which is not a real Windows process, so the record would be reaped as an
  orphan while the task still ran. Walk the process tree for the `claude.exe`
  pid instead.
- **`opened` may legitimately name an id that exists nowhere yet** - that is its
  entire purpose. A plan that demands every entry already be a known task is
  wrong, and one did; the shape check `^[a-z0-9-]+$` is the real invariant.
- **A starvation pattern:** `/runqueue` fills the delegable fan-out first, so a
  `main`-mode task that reads a file the fan-out writes is never scheduled. One
  task was refused four cycles running for exactly that.

## Decisions already taken - DO NOT RE-ASK

In `.claude/tasks/decisions.jsonl`:

- **Touch drags: the webview does not forward them** (2026-08-30). Settled at
  the hardware. See the top of this file.
- **ROM font bitmaps in this public repo: REFUSED** (2026-08-29). Six rights
  holders against a public repo for a cosmetic gain. `PETSCII.setFont()` stays
  as the hook if that ever changes. The BBC's font is VERIFIED at `&C000` in the
  OS ROM, 8 bytes/char, 768 bytes for chars 32-127; the CPC's offset remains
  unverified.
- **tdzlaptop sessions in the activity lists: DECLINED** (2026-08-29). The usage
  bars already cover the laptop; the lists' value is that an empty list means
  nothing is running HERE.
</critical_context>

<current_state>

- HEAD `7084246` == `origin/main`. **Working tree CLEAN.**
- `.claude/tasks/serial.lock` is an empty array - no locks held, no cycle in flight.
- The feed is **healthy**: pid **58812**, `/health` reads
  `{"ok":true,"state":"healthy","error":null}` with `generatedAt` 16:11 today.
- All eight suites pass at HEAD, counts as tabled above.

## Deliverable status

| | |
|---|---|
| C64 Weather (themes, boot, machine art, fonts) | COMPLETE and on the device |
| Usage widget: five views | COMPLETE, on the device at 1.11.0 |
| Usage widget: self-paging lists | COMPLETE in repo (1.12.0), **NOT on the device** |
| server.js review | **COMPLETE - 7 findings, 7 fixed** |
| Feed `stats` block | COMPLETE and live |

## Open questions

- **Does the webview honour a PROGRAMMATIC scroll?** Unanswered, and the pager
  depends on it. See `verify-paging-on-device`.
- **Should prose check-counts survive in `usage-server/README.md`?** Two drifts
  caught in two commits, and the suite that changes most (`http.test.js`, 49 ->
  94 in one session) never had a count at all. Recommendation on file: drop
  them.
- **Should `start-hidden.vbs` gain restart supervision?** The
  `uncaughtException` handler is a mitigation and is the right trade ONLY
  because nothing restarts this process. Revisit if a supervisor appears.

## Nothing is temporary or half-applied

No workarounds, nothing staged, no scratch artefacts in the repo. Everything
under the session scratchpad is disposable.
</current_state>
