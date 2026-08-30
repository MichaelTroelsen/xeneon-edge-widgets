# Handoff - Xeneon Edge widgets

Repo: `C:\Users\mit\claude\icue` -> https://github.com/MichaelTroelsen/xeneon-edge-widgets
(public, `main`). Two iCUE HTML widgets for a Corsair Xeneon Edge, plus a local
feed server that supplies one of them.

**THIS FILE STATES NO FACT THAT A COMMAND CAN ANSWER.** No HEAD, no version
numbers, no pids, no check counts, no open-task list. Every one of those has
gone stale here - three times in one day, the last time within TWO COMMITS of a
rewrite that followed the rule this file used to prescribe: written last, at a
clean tree, every figure measured minutes before writing. Five of them were
wrong anyway.

That was never carelessness. It is what happens because work continues, which it
always does, so no amount of care fixes it. The volatile half is now a set of
commands instead. Run them. Do not trust a number written down anywhere,
this file included.

## Measure the current state first

```bash
git log --oneline -5 && git status -sb          # HEAD, and whether the tree is clean

# repo versions
node -e "for (const p of ['ClaudeUsage','C64Weather']) console.log(p, require('./'+p+'/manifest.json').version)"
# device versions - the pair that has gone stale most often. iCUE's page cache
# means the FOLDER is not proof of what is running; confirm from the rendered
# page (capture DISPLAY2, see the device note below) before believing it.
ls C:/Users/mit/AppData/Roaming/Corsair/CUE5/html_widgets/*/manifest.json

curl -s http://127.0.0.1:41777/health           # feed state
netstat -ano | grep 41777 | grep LISTENING      # and its pid

for t in usage-server/test/*.test.js ClaudeUsage/test/*.test.js C64Weather/test/*.test.js; do
  printf '%-44s ' "$t"; node "$t" >/dev/null 2>&1 && echo OK || echo FAIL
done
```

And `/whattask --dry-run` for what is open and what blocks it - the plan file
plus the run log are the only current answer to that, never this document.

Everything below is the part that does not go stale: what was decided, what was
measured once and still holds, and the traps that cost real time.

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

The layout suite gained a whole section for it, asserting per list that every
row becomes fully readable at some page, that the last page reaches the bottom,
that the fade is off there, and that the lit dot is the page actually shown -
sampling the rendered page over virtual time rather than asserting on the
pager's arithmetic, because the arithmetic was not what broke.

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

## Tests

Every suite is wired into `.github/workflows/tests.yml` as its own step. The
loop in the command block above runs them all; each prints its own count and
ends with `all passed`.

No count is written here on purpose. `usage-server/README.md` used to state them
in prose and they drifted twice in two commits, which is why ce8e4bf replaced
those numbers with descriptions of what each suite COVERS - the same argument
this file is now applying to itself.

What is worth knowing and does not drift: `http.test.js` is the largest and most
active, and is the meta one - it carries the check that cross-references
`usage-server/README.md`'s `CLAUDE_USAGE_*` names against what server.js
actually reads, in both directions. `ClaudeUsage/test/layout.test.js` and
`C64Weather/test/layout.test.js` drive real headless Chrome and measure boxes,
so they are the slow ones and the ones that catch what no DOM assertion can.
</work_completed>

<work_remaining>

**Run `/whattask --dry-run`.** The plan file and the run log are the only
current answer; a list written here is wrong within about two commits, which is
the whole reason this file was restructured.

One durable caution that belongs with the work rather than with the status,
because it is a technical trap rather than a state of play:

**`verify-paging-on-device` cannot be answered by watching the dots.** The pager
moves `scrollTop` PROGRAMMATICALLY. Touch drags are known not to be forwarded
(see the finding above); nothing yet proves the webview honours a programmatic
scroll on an `overflow-y: auto` element either. If it does not, the lists sit
frozen on page one while the dot indicator advances underneath them - which
looks like working software from across the room. **Check that the ROWS change.**
The recorded fallback, if they do not, is to page by translating the list
content rather than by `scrollTop`.

It also cannot be observed on an idle machine BY DESIGN: a region that fits
never pages, and the Activity lists only overflow when work is actually in
flight. It wants doing during a `/runqueue` or `/runbatch` fan-out - which is
the same command that would otherwise be draining the plan.

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
(append-only, last-line-per-id wins), `decisions.jsonl` (outranks the plan) and
`serial.lock` (a JSON array of holder records) with a `serial.lock.d` mutex. **The whole `/.claude/` tree is gitignored**, so
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
  Put that pattern **in the fan-out's tool-call schema itself**
  (`{type: 'array', items: {type: 'string', pattern: '^[a-z0-9-]+$'}}`), not in
  a filter the orchestrator runs afterward. `sanitise-opened-arrays-in-runs-log`
  cleaned eleven paths out of the run log one morning; hours later, on the very
  same day, a fanned-out agent returned eight more - absolute Windows paths to
  `widget.js`, a CSS file, `index.html` and others - kept out of the log only
  because the orchestrator happened to filter them by hand at write time. The
  schema those agents were given had no `pattern`, so a path was a
  well-formed answer and the model had no reason not to give one; a schema
  with the pattern makes an invalid `opened` entry fail at the tool-call
  layer, so the AGENT retries instead of the orchestrator cleaning up after
  it - a workflow script written fresh per invocation has nothing durable
  telling it to include the constraint unless this file says so. The pattern
  does not make `opened` trustworthy, only well-shaped: it forbids a path but
  cannot tell a real task id from a plausible-looking slug that names
  nothing, so the entries still want checking against the plan before they
  are believed.
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

Measure it with the command block at the top of this file - HEAD, tree, both
widgets' versions, the feed's health and pid, and the suites. Nothing here.

## What is built

Stated as capability rather than as status, since capability does not drift:

| | |
|---|---|
| C64 Weather | seven themes, boot sequence, machine art, fonts - feature-complete |
| Usage widget | five tap-cycled views, and lists that page themselves |
| server.js review | seven findings, seven fixed - the review is CLOSED |
| Feed `stats` block | served from `~/.claude/stats-cache.json`, gated on `version === 5` |

Whether the DEVICE is running any given one of those is a different question,
and the answer is on the glass, not in this table. Capture it:

```powershell
Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap 2560,720
[System.Drawing.Graphics]::FromImage($b).CopyFromScreen(-1881,1440,0,0,$b.Size)
$b.Save("$env:TEMP\edge.png")
```

The usage widget prints its own version in its header, so the capture answers
"what is actually running" in a way the installed folder cannot.

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
