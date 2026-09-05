# iCUE widgets — TODO

## C64 Weather — 1.5.3

### Done

- [x] **Sunrise / sunset, wind, high / low.** All three requested additions are
      rendered. Sun times are taken as an `HH:MM` substring of the ISO string,
      not parsed into a `Date` — `timezone=auto` already returns them in the
      location's own timezone, so parsing would re-shift them into ours. Wind
      follows the temperature unit: `13KM/H` beside °C, `8MPH` beside °F.
- [x] **Three-column readout**, after the arrangement of Corsair's stock weather
      widget: temperature and place left, condition sprite with the day's
      low/high beneath it centre, timed readings right. Each right-hand row is
      an 8×8 glyph plus a value, drawn on the same cell as the font.
- [x] **Everything fits the smallest slot.** The three columns fit 840×344 with
      room over, so no column is dropped for width; only `FEELS` and `HUM` are
      conditional.

Detail shown per slot:

| Slot | Right column |
|---|---|
| 840×344, 696×416 and up | `UP` `DN` `WIND` |
| ≥600px tall | plus `FEELS` |
| ≥1000px wide | plus `HUM` |

The condition sprite is already weather-driven — sun, moon, partly, cloud, fog,
drizzle, rain, snow, thunderstorm — with a palette colour per condition.
- [x] **Font and art regression test** (2026-08-29). `test/font.test.js` checks
      every rendered string is spellable in the hand-built font, every sprite
      and glyph name the widget asks for exists, and the extraction itself is
      checked so the test can't pass vacuously against an empty match list —
      14 checks. Mutation-checked (deleting `|` from the font fails the
      punctuation check). Added to CI alongside the two usage-server suites.
- [x] **Layout regression test** (2026-08-30). `test/layout.test.js` renders
      all seven themes headless at 840×344 in both booting and settled states
      and asserts, from `getBoundingClientRect`, that nothing overflows
      `.screen` and that no inline-SVG text run is drawn below its declared
      font-size. Carries its own two mutation checks. Caught a real defect on
      its first run that eye inspection had missed.

- [x] **Seven themes** (1.3.0). C64, Commodore PET, BBC Micro, Amstrad CPC, ZX
      Spectrum, Amiga and Modern, selected with a `combobox`. Each is a
      redefinition of the seven palette tokens plus a boot screen and cursor
      style; `modern` switches the renderer to system text. Palettes and screen
      furniture are the faithful part - the letterforms are still this project's
      own 8x8 set, and `PETSCII.setFont` now takes per-theme glyph overrides so
      ROM-accurate fonts can be added later without touching anything else.

### Closed, and decided against

- [x] **Per-machine ROM letterforms — DECIDED AGAINST** (2026-08-29). Asked
      whether extracted ROM font bitmaps could go into this public repo; the
      answer was no, keep the hand-authored set. Six separate rights holders
      (Cloanto, Amstrad, Acorn/RISC OS Open) against a public repo for a
      cosmetic gain isn't worth it, and the honest "these are not ROM dumps"
      note already covers the current set. `PETSCII.setFont(mode, glyphs,
      mixedCase)` stays in place as the hook, so this is reversible if the
      licensing answer ever changes. Research worth keeping either way: the
      BBC's font location is now verified at `&C000` in the OS ROM, 8 bytes
      per character, 768 bytes for chars 32-127 (tobylobster MOS 1.20
      disassembly, stardot). The CPC's remains unverified — the set is
      confirmed to live in the lower ROM `&0000-&3FFF` but no source consulted
      pins the matrix table's offset within it. Do not ask again.

- [x] **Machine art on the boot screen** (1.5.0). Each machine is drawn beside
      its own startup text for the two seconds it boots, on the right, with the
      text unreduced on the left. The art is absolutely positioned inside
      `.screen` rather than being a flex sibling, which is what keeps the
      Spectrum's copyright line at the foot of the screen where it belongs.

      Every drawing is from a photograph, never from memory: the CPC 464, ZX
      Spectrum and CBM 8032 from references supplied for this project, and the
      BBC Micro, Commodore 64 and Amiga 1200 from public-domain photographs on
      Wikimedia Commons (`Commodore-64-Computer-FL.jpg`, `BBC Micro left.jpeg`,
      `Commodore Amiga 1200 Tietokonemuseo.JPG`). The Amiga is a 1200 rather
      than the more iconic A500 because the theme shows the Kickstart 3.1 ROM
      screen, and the A500 shipped with Kickstart 1.3.

      They render in `currentColor` like every other sprite, so a machine has
      to be told apart by silhouette and internal structure rather than by its
      case colour — hence the PET's monitor on its body, the CPC's cassette
      deck, the BBC's solid function-key strip, the Spectrum's corner flash,
      the C64's stacked function keys and the Amiga's numeric keypad. Modern
      has no startup screen and gets no machine; `setMachine` deliberately has
      no fallback, because a wrong machine beside the right boot screen is
      worse than no picture at all.

- [x] **Smooth condition art for the Modern theme** (1.3.0, `3214d2b`). Nine
      stroked 24x24 condition sets on `fontMode === 'system'`. Eight of the nine
      were checked structurally rather than visually; that is where to look
      first if one renders wrong on the device.

- [x] **Boot-accurate startup screens** (1.4.0). Every theme's startup text is
      now the machine's own, verbatim and at its real length — four lines for
      the CPC 464, one for the Spectrum, at the foot of the screen where the
      real one sat. The homage wording that said WEATHER where the machine said
      BASIC is gone; the widget's own line is `load`, which on all six machines
      was something the user typed. That line also carries the version, so the
      device still states which build it is running.

- [x] **Lowercase and `©` in the font** (1.4.0). 27 new glyphs. The BBC, CPC,
      Spectrum and Amiga all boot in mixed case, so rendering them in capitals
      was an inaccuracy, not a stylistic choice. Case is now a property of the
      machine: the C64 and PET fold to their uppercase/graphics set, the rest do
      not. The font test sets mixed case before probing — without that it would
      have passed vacuously, reporting every missing lowercase glyph as present.

- [x] **Three palettes corrected against sampled references** (1.4.0). The Amiga
      theme was Workbench 1.3 blue while the reference is the Kickstart 3.1 ROM
      screen: `#411040` on `#e9a888`, both sampled. The CPC's blue is `#000088`,
      not `#000080`. The Spectrum's paper is `#d0d0d0`, not white.

- [x] **Tap to change theme** (1.3.2, `1710ee2`). Steps through THEME_ORDER and
      wraps; the iCUE combobox still wins when it changes. Also fixed a theme
      picked in the settings panel not appearing until the widget reloaded.

- [x] **`tab-buttons` throws in iCUE's settings panel** (`c1f7644`). Moved
      `tempUnit` and `colorTheme` to `combobox`. iCUE's own
      TabButtonsEditorSetting.qml:33 calls `rowCount()` on a QVariantList, which
      throws for every possible payload — Corsair's bundled widgets included.

## Claude Code Usage — 1.11.0

### Done

- [x] **Calibrated the budgets** (2026-08-28) against the real usage panel, using
      `/usage?at=<timestamp>` for a same-moment comparison. Session 54M, weekly
      178M standard, with the +50% promotional boost declared separately so it
      expires on its own.
- [x] **Autostart.** `ClaudeUsageFeed` scheduled task runs `start-hidden.vbs` at
      logon; verified by killing the server and letting the task restart it with
      no console window.
- [x] **`translation.json` format.** Was a flat map, which iCUE reads as a map of
      *languages*; now nested under `en.translation` per `docs/translations.md`
      and Corsair's own bundled widgets.
- [x] **Version and last-updated in the header.** The timestamp is the feed's
      `generatedAt`, and turns amber after three missed refresh cycles so a dead
      feed is distinguishable from live numbers that are not moving.
- [x] **Tap to switch views** — usage bars, activity (sessions, workflows,
      subtasks), a token breakdown behind the two bars (1.9.0), and all-time
      stats (1.10.0), and tokens by model (1.11.0), cycling through a
      five-dot indicator.
- [x] **Scrollable lists**, replacing the row trimming that made anything past
      the first handful unreachable. Headings carry totals, a fade marks an
      overflowing list, and scroll position survives a refresh.
- [x] **Self-paging lists** (1.12.0), because the scrolling above turned out to
      be unreachable on the device — see the drag finding below. An overflowing
      region advances one page every 5s and wraps; boundaries snap to rows so
      none is sliced; a dot per page rides in the heading; the fade now means
      "more below *this page*" and goes out on the last one. Driven off computed
      overflow rather than a list of ids, so the Tokens view's two columns page
      on the same mechanism. Measured: 7 of 40 rows per column were reachable
      before, 40 of 40 after.

- [x] **Dropped the estimated percentage** (1.3.0). Proved it cannot be made to
      work: between two windows the measured growth was 4.28×–9.18× per token
      class while Claude's panel charged 3.5×, and a weighted sum cannot grow
      more slowly than its slowest component. The widget now shows measured
      token and message counts, with the bar scaled against the user's own
      busiest recent block.
- [x] **Real numbers from Anthropic** (1.4.0). Found via GitHub search: the
      `/usage` panel reads `api.anthropic.com/api/oauth/usage`, authenticated
      with the OAuth token in `~/.claude/.credentials.json`. The feed now reads
      it directly, so the widget shows the panel's own percentages with a `LIVE`
      badge, falling back to measured counts when the endpoint is unreachable.
      Undocumented endpoint — the measured path stays as the guaranteed one.
- [x] **`/usagehtml` debug page** on the server — both windows with full token
      breakdowns, per-model splits, and every session/workflow/subtask as a
      table. An addition alongside `/usage`, which is untouched.
- [x] **The percentages without an API request** (1.7.0). Claude Code hands its
      statusline script a `rate_limits` object (v2.1.80+); `statusline-tee.js`
      wraps the configured statusline, saves it and passes stdin through. It
      cannot be rate-limited, which matters because `/api/oauth/usage` throttles
      clients far politer than ours — anthropics/claude-code#30930 is open on
      persistent 429s with `retry-after: 0`. Both paths stay; the snapshot takes
      whichever answered most recently.
- [x] **Activity shows only what is running** (1.7.0). The lists were a
      seven-day archive: twenty sessions with one running, eighteen finished
      workflows, twenty-three finished subtasks. The live source turned out
      **not** to be `wf_*.json` — that is written when a run *ends*, so the first
      attempt matched nothing and the widget sat empty through a whole 60-second
      probe run. It is the run's transcript directory: an agent with a `started`
      line in `journal.jsonl` and no `result` is running.
- [x] **Tests for it.** `test/live-detection.test.js` runs the server against a
      fixture tree via `CLAUDE_USAGE_PROJECTS_DIR` — 18 checks, ~2 seconds, no
      tokens. `test/activity-probe.workflow.js` plus `test/activity-probe-check.js`
      is the end-to-end version: N subtasks that genuinely block for S seconds,
      with the feed watched while they do. Both were mutation-checked — reverting
      the live-run lookup fails 9 checks, reverting the just-opened-session rule
      fails 3.

- [x] **Tested the statusline path and the credential claim** (2026-08-29).
      `test/statusline.test.js` — 35 checks covering the freshness rules and
      asserting no credential material reaches `/usage` or `/usagehtml`. Added
      `CLAUDE_USAGE_STATUSLINE_FILE` and `CLAUDE_USAGE_CREDENTIALS_FILE` to make
      it hermetic, and **`CLAUDE_USAGE_NO_REMOTE`** because the fixture tests
      were making a real request to the rate-limited endpoint on every run while
      being described as costing nothing.
- [x] **Redact key-shaped text from labels** (2026-08-29). Rows are named from
      prompt text, so a pasted key would have been rendered on the display.
      `sk-ant-…`, long `sk-…`, `Bearer …` and `ghp_…` become `[redacted]`.

- [x] **Detect an unhooked statusline wrapper** (2026-08-29). An active session
      plus a file that is not current means `statusLine.command` probably no
      longer runs `statusline-tee.js`. Reported as
      `diagnostics.statusline.likelyUnhooked`, appended to `official.error` so
      the widget's existing tooltip shows it without a widget change, and given
      its own section on `/usagehtml`.
- [x] **CI** (2026-08-29). `.github/workflows/tests.yml` — both hermetic suites
      on Ubuntu and Windows, Node 20 and 22, plus `node --check` over every
      source file, on push and pull request.

### Open

- [x] **Code review of `usage-server/server.js`** (2026-08-30, at `ad9592a`).
      Falsification pass, read-only, seven findings — one line each, detail in
      `.claude/tasks/runs.jsonl` (id `server-js-code-review`):

      - **Finding 1** (critical) — FIXED in `5d05fe1`. server.js:1097: one
        malformed `?at=` query string threw uncaught out of the HTTP handler
        and killed the process; no restart supervision until next logon. A
        malformed escape is now answered 400 and anything else 500, with an
        `uncaughtException` net behind both. `test/http.test.js` is new and
        covers it. → `fix-usage-server-request-handler-crash`
      - **Finding 2** (high, still open) server.js:838-842 — live-run staleness is judged
        on the run directory's mtime, which NTFS does not move on an append, so
        a long-running fanned-out workflow drops out at 15 minutes while still
        writing. → `fix-live-run-staleness-uses-dir-mtime`
      - **Finding 3** (high, still open) server.js:462-484 — a record torn across a read
        boundary is permanently lost: the byte cursor advances past it and
        never revisits. → `fix-incremental-index-torn-line-loss`
      - **Finding 4** (high) — FIXED in this change. server.js:1061-1063: a
        failed rebuild was invisible - `/usage` served literal `null` with 200
        and `/health` reported `ok:true`. `/health` now reports three states
        rather than one: `healthy`, `stale` (a snapshot exists but rebuilds are
        failing - stays `ok:true`, because the data is real if ageing and
        paging on a still-working feed is its own bug) and `unbuilt`
        (`ok:false`, nothing has ever built). `/usage` answers 503 naming the
        failure instead of `200 null` in that last case.
        → `surface-rebuild-failure-in-health`
      - **Finding 5** (medium, still open) server.js:213-223 — `watchCredentials` resets
        rate-limit backoff unconditionally on any `.credentials.json` write,
        including the server's own token-rotation writes, twice per rotation.
        → `fix-official-backoff-reset-on-credentials-write`
      - **Finding 6** (medium, still open, evidence gap — latent, not currently firing:
        every `quotaLimits` record observed in the wild is `five_hour`, so the
        defect has no `seven_day` record to trigger it yet) server.js:430-437
        — `lastQuota` keeps whichever record has the farthest-future
        `resetsAt` rather than the most recently seen one.
        → `fix-lastquota-most-recent-not-max-resetsat`
      - **Finding 7** (low, still open, certain) server.js:727/1044-1045 —
        `workflowsSeen`/`subtasksSeen` are counted from the already-sliced
        arrays, so the diagnostic can never report truncation past the cap.
        → `fix-seen-counts-taken-after-slice`

      Findings 1 and 2 were independently re-confirmed by the orchestrator.
      Six other candidates were investigated and FALSIFIED (negative results,
      not filed): `/usagehtml` does not crash on a null snapshot (guarded);
      **a reader does NOT see a half-built snapshot mid-rebuild — `build()` is
      entirely synchronous, so `snapshot = build()` can't be observed torn**,
      which was exactly this box's original question and the answer is not
      the one it assumed (the actual danger is a *frozen* snapshot, Finding 4,
      not a torn one); `MAX_WORKFLOWS` cannot truncate away a live workflow
      (the live-run collector is uncapped); `officialInFlight` cannot stick
      true (the `.catch` is attached before the final `.then`); an unparsed
      `limits.json` does not advance `configMtime` but causes no wrong output,
      only a re-parse loop; and `?at=<past>` is present-tense for
      `workflows`/`subtasks`/`counts` despite the docstring's claim, but it's
      a debug-only affordance, not filed.

- [x] **Show sessions from the other machine (`tdzlaptop`) — DECIDED AGAINST**
      (2026-08-29). Asked whether the Activity lists should show tdzlaptop's
      sessions too; the answer was to leave it local. The usage bars already
      cover the laptop — five-hour and weekly utilisation are server-side
      account figures counting every client, so only the activity lists are
      machine-bound — and that is their value: an empty list means nothing is
      running HERE, a claim a flaky peer would quietly break. Background kept
      for if this is ever revisited: the Activity lists are this-machine-only
      by construction, since the server walks `~/.claude/projects/**/*.jsonl`
      on the host it runs on and Claude Code writes transcripts locally with
      no sync between machines. Verified 2026-08-28 — all 13 indexed project
      directories are local (11 under `C:\Users\mit\...`, 2 from WSL on the
      same box), and `ListAgents` found no reachable remote session even with
      `remoteControlAtStartup: true`. Sketch it would have taken: run the
      collector on `tdzlaptop`, have it POST its active sessions to this
      machine (or write somewhere both can read), tag every row with its host
      so `read what next · icue` is distinguishable from a laptop row, and
      decide what the widget shows when the peer is unreachable — silence is
      indistinguishable from idle, which is the trap the active-only filter
      was built to avoid. Do not ask again.

- [x] **The iCUE webview does NOT forward touch drags** (2026-08-30). Measured
      on the device at 1.11.0: a finger dragged across an activity list does not
      scroll it, the list stays put. Taps *are* forwarded and the 12px/700ms tap
      gate does not misfire — the view did not change — so the specific bug this
      was written to catch does not exist. What it broke instead was the premise
      that a scrolling list keeps every row reachable: 33 of 40 rows per column
      were stranded behind a fade promising content nobody could get to. Fixed
      by the self-paging lists above. Do not design anything for this device
      that depends on reaching a scrollable region by hand.
- [x] **Confirmed the weekly anchor** (2026-08-28). Thu 21:00 local was taken
      from the usage panel; the statusline's `seven_day.resets_at` — Anthropic's
      own value — agrees. Only affects the measured `LOCAL` fallback anyway.
- [x] **The stale access token resolved itself** (2026-08-28). The credentials
      file was rewritten 19:54 local with an expiry of 29 Aug 03:54, so the
      `HTTP 401` is gone — no `claude auth login` was needed. It also matters
      much less now: the widget's figures come from the statusline path, which
      uses no token at all, so a stale credential no longer costs the live view.
      The refresh-token rotation race is still real and still worth watching
      (see the Authentication section of `usage-server/README.md`).
- [x] **Removed the dead budget config** (1.8.0). `sessionBudgetWeightedTokens`,
      `weeklyBudgetWeightedTokens`, `weeklyBoost` and `weeklyBuckets` are gone
      from `limits.json`, and `pct()`/`weeklyBudget()` with them. `/usage` no
      longer carries `session.percent`, `weekly.percent`, `budgetWeighted`,
      `buckets` or `estimated`; the debug page and the startup log stopped
      printing them. It was reading 34%/52% against the real 25%/18% — wrong by
      enough to mislead anyone who read the JSON. `usedWeighted` and
      `peakWeighted` stay: that ratio is a real measurement.
- [x] **Each meter states its own provenance** (1.8.0). Anthropic can answer for
      one window and not the other, and the badge said `LIVE` while a meter
      quietly showed measured tokens — the exact silent fallback this project
      had already removed once. Now the badge reads `LIVE¹` and the meter is
      marked `· measured`.
- [x] **Third view: the token breakdown** (1.9.0). Cycling past the usage bars
      and activity lists reaches a per-window token and per-model breakdown
      (`renderTokens`/`renderModels` in `widget.js`), with the countdown to
      reset and the weighted-usage note moved in alongside it.

- [x] **Fifth view: tokens by model** (1.11.0). A stacked bar per calendar day
      from `stats.dailyModelTokens`, ordered and coloured by each model's total
      so a colour means the same model in every column, with a legend carrying
      those totals. A SEPARATE view rather than an addition to All time, and
      that was settled by measurement rather than taste: the layout suite puts
      All time's tightest fit at +7.2px of headroom at 840x344, so there was no
      room in it.

      Two properties of this data drove the implementation. It is SPARSE BY
      DATE — 34 rows across a 39-day span — so the chart is laid out by
      calendar position exactly as the heatmap is, and a day with no row is
      drawn as a real gap rather than closed up; indexing by array position
      would put every bar on the wrong day, which is the defect that shipped
      once already in the heatmap. And it covers a DIFFERENT, shorter span than
      `dailyActivity` (2026-07-22 onward, not 2025-11-19), so it has its own
      axis and its own heading rather than borrowing All time's.

      The scale is LINEAR despite per-day totals spanning 43x, because the bars
      are stacked: segments have to sum to the column, and a log axis breaks
      that. A quiet day genuinely was 2% of a loud one.

      `stats.unavailable` replaces the view with the reason, as All time does.
      The four existing views are pixel-identical outside the header — checked
      by pinning WIDGET_VERSION and diffing, zero body pixels changed. The
      layout suite pins five views now and renders all of them.

- [x] **Fourth view: all-time stats** (1.10.0). A contribution heatmap over the
      whole recorded span plus eight headline figures — sessions, messages,
      active days, current and longest streak, busiest day, top model and total
      tokens — read from the `stats` block `/usage` now serves out of
      `~/.claude/stats-cache.json`, the same rollup `/stats` prints. The grid is
      laid out by CALENDAR date rather than by array position: the rollup writes
      a row only for a day that had activity, so its entries are sparse (92 rows
      across a 284-day span here). When the feed reports `stats.unavailable` the
      view says so in words instead of drawing an empty grid, which would read
      as months of silence rather than as a missing file. The view indicator is
      now four dots.
- [x] **Layout regression test — the widget's first test suite** (2026-08-30).
      `test/layout.test.js`, modelled on C64Weather's: renders all four views
      plus two stats-availability fixtures headless at 840×344 and asserts,
      from `getBoundingClientRect`, that nothing overflows `.widget-root`,
      that no all-time-stats headline figure (`.fig .v`) is truncated, and
      that the stats grid and its "unavailable" note never show together.
      Reads `VIEWS` and the starting view out of `widget.js` rather than
      copying them, and hashes the three widget sources before and after to
      prove a run mutates nothing. Carries two mutation checks.

      The overflow check is scroll-aware: `.cols .col` and `.list ul` are the
      two selectors ClaudeUsage.css deliberately makes `overflow-y: auto`, so
      a descendant of either is allowed to run past its own clipped box —
      that is what a scroller is for — while the scroller's own box is still
      measured against `.widget-root`. Without that rule the suite opened at
      73 false failures, every one a descendant of `.cols .col` or `.list
      ul`; with it, 0.

      One of the two mutation checks was found to be vacuous on the first
      pass — widening `.meter .name` past `.widget-root` reported no overflow
      — and diagnosed rather than papered over: not a specificity loss (the
      injected `!important` rule was winning), but the flex algorithm's
      default `flex-shrink: 1` quietly shrinking the forced `width: 300%`
      back down to fit `.meter-top` alongside `.meter .value`. Adding
      `flex-shrink: 0 !important` to the injected style makes the mutation
      actually widen the box, and the check now fires.
- [ ] **If the real formula is ever wanted**, it needs several panel readings at
      known times across one block, then candidate models tested against them —
      cache reads free, per-request cost, non-linear curve, reporting lag. Two
      readings cannot separate those.

## Task Queue — 1.3.6

### Done

- [x] **Five views on one page** (2026-09-05): queue, running now, run history,
      task files, and one project's task list behind a tab strip. Fed by
      `/tasks` and `/tasks?project=<name>` on the usage server. Every view says
      why when it has nothing honest to draw, rather than drawing an empty one.
- [x] **Two faults nothing else on the machine reports**, per `LOCKING.md`'s
      own tests: an orphaned `serial.lock` holder (host is this machine, pid
      not running — age deliberately not a factor) and a stale mutex (dead pid
      AND `at` over 15 minutes). Found a real orphan in SIDM2 on first run.
- [x] **Task states with a marker each**: running, queued, blocked, waiting on
      another open task, done. Queued block sorted delegable → parallel →
      cheapest; done capped at ten with the omitted count stated.
- [x] **Layout suite** at 840×344, 107 checks, including visible-row counts
      (not DOM counts), resolved colours for the states that carry meaning, and
      a refresh driven through `onDataUpdated()` with a different second body.

### Open

Falsification pass on 2026-09-05 at `a4baaf0`, whole widget read end to end
and every claim below re-verified against the file. Ranked: the widget is
currently saying something untrue in the first three; the rest are gaps.

- [ ] **The "Finished" meter turns amber at 80% and red at 95%** (high).
      `TaskQueue/scripts/widget.js:23` `HIGH_WATER`/`CRITICAL_WATER` and the
      `setBar` call at `:196` were ported from the usage widget, where a high
      percentage means running out. Here 95% finished is the BEST state and
      the bar would go red — unseen only because the queue sits at 59%.
      Remove the thresholds or invert them; `.meter.is-high`/`.is-critical` in
      `TaskQueue/styles/TaskQueue.css:461-465` are the colours.
      → `taskqueue-finished-meter-thresholds-inverted`
- [ ] **The header subtitle goes stale across views** (high). Only Queue
      (`widget.js:202`) and Files (`widget.js:407`) write `els.repos`; Live,
      History and Projects leave whatever the previous view put there, so
      History can read `5 repos · 1 alarm` or `44 waiting on you` depending on
      the route taken to it. Each view should own that line, or the dispatcher
      should clear it. → `taskqueue-header-subtitle-stale-across-views`
- [ ] **Every tab press flashes a false heading** (high). `selectProject()` at
      `widget.js:471` nulls `projectData` and re-renders before the fetch
      lands, so `renderProjects()` (`:516`) prints `h2g · none open` for the
      request's duration and then corrects. Same on first entry. "None open"
      is a claim about the queue, not a loading state — needs a distinct
      pending rendering. → `taskqueue-tab-switch-flashes-none-open`
- [ ] **Refresh default is 10 in code, 15 everywhere else** (low).
      `widget.js:63` falls back to 10; `index.html` declares
      `data-default="15"` and README says 15. Whichever is meant, make them
      agree. → `taskqueue-refresh-default-mismatch`
- [ ] **Tabs and the repo list are in different orders, and neither is
      alphabetical to a human** (medium). `usage-server/tasks.js:57` sorts
      case-sensitively, so tabs read `SIDM2, claude-setup, h2g, icue,
      tdz-c64-knowledge`; the Queue list (`widget.js:205`) sorts by open
      count; `currentProject()` (`:464`) defaults to whatever sorts first in
      ASCII. Pick one order (case-insensitive, or by open count) and use it
      for both, and default the selection to something meaningful.
      → `taskqueue-consistent-repo-order`
- [ ] **The Live view will snap to page 0 every five seconds** (medium,
      reasoned from DOM semantics, NOT measured on the device). `startClock()`
      at `widget.js:1019` — a misnomer now — calls `renderLive()` directly
      every 5s to tick elapsed times. It empties and rebuilds both lists;
      clearing a scroller collapses `scrollTop` and rebuilding does not
      restore it, so a paged list jumps to the top on each tick and the pager
      moves it back. Only visible when a live list overflows. Fix: update the
      elapsed text in place, or go through `render()` so `refreshPaging()`
      restores the page. → `taskqueue-live-tick-resets-scroll`
- [ ] **`fetchProject` swallows some errors and can double-fetch** (medium).
      `widget.js:483`: no `res.ok` check (the overview fetch at `:951` has the
      body-carried-error branch; this one does not); a response with no
      `project` field fails the guard at `:503` and is silently dropped,
      leaving stale rows with no indication. And `projectPending = null` at
      `:500` runs before the project check, so a late answer for an abandoned
      tab clears the flag while the current tab's request is still in flight,
      letting the next poll start a duplicate.
      → `taskqueue-fetchproject-error-handling`
- [ ] **Two unguarded lookups that would kill a render** (low, defensive —
      cannot fire from the current feed). `STATE_MARK[task.state]` at
      `widget.js:582` yields `"undefined"` prepended to the title for any
      state not in the map; `task.waitingOn.join()` at `:597` throws if
      `waitingOn` is null. → `taskqueue-guard-state-mark-and-waitingon`
- [ ] **The overlap check is vacuous** (test debt, high). When the clock was
      removed the probe was repointed at
      `.widget-root > [style*="position: absolute"]`
      (`TaskQueue/test/layout.test.js:763`) — an INLINE style nothing sets —
      so it finds no element and the assertion at `:1133` passes
      unconditionally. Probe computed `position` instead, or delete it and
      say so. → `taskqueue-overlap-probe-cannot-fail`
- [ ] **Nothing verifies any slot but 840×344, while README.md:4 claims every
      slot size in both orientations** (test debt, medium). The inherited
      media queries in `TaskQueue.css:662-689` reference `.body` and
      `#list-subtasks`, which this widget does not have — behaviour at any
      other slot is unknown, not merely untested. Either render the other
      slots in the suite (696×416, 840×696, 1400×344 …) or drop the claim
      for this widget. → `taskqueue-verify-other-slots-or-drop-claim`
- [ ] **Show how stale each queue is** (improvement). `lastRunAt` is computed
      at `tasks.js:231` and never drawn. h2g's last run was 22 Aug — two weeks
      without a run is a different kind of queue from one that ran this
      morning, and it is the one signal that separates "abandoned" from
      "active" on the Queue view. → `taskqueue-show-queue-staleness`
- [ ] **Cache commit times in the feed** (improvement). `commitTimes()` at
      `tasks.js:290` shells out to `git cat-file` per repo on every 10s
      rebuild (`:695`), over up to 326 SHAs. A SHA's commit time never
      changes: one map filled on first sight, and the rebuild does no git work
      until a new head appears. → `taskqueue-cache-commit-times`
- [ ] **`whattask.json` is parsed three times per rebuild** (improvement).
      `readRepo` (`tasks.js:237`), `projectTasks` (`:416`) and
      `collectQueuedTasks` in `usage-server/server.js:1101` each read the
      200KB file independently. → `taskqueue-read-whattask-once`
- [ ] **Mark the feed stale when a poll fails** (improvement). On error with
      data present (`widget.js:981`) the widget silently re-renders the old
      reading; the usage widget turns its `Updated` stamp amber. This one
      gives no sign. → `taskqueue-stale-indicator-on-poll-failure`
- [ ] **The unpaged projects list has no "more below" hint** (improvement).
      `NO_PAGING` at `widget.js:871` also skips `markFade()`, so on the
      desktop dashboard — the only place the list scrolls — nothing says there
      are ~150 rows under the six. → `taskqueue-fade-hint-on-unpaged-list`
- [ ] **Dead weight** (improvement). `widget.js`: `MAX_ROWS` (`:19`),
      `formatCountdown` (`:73`), `DAYS` (`:84`), `formatWeekday` (`:86`),
      `shortDate` (`:669`), `els.tasksHead` (`:1065`) — defined, never used;
      two orphaned comment fragments about the clock's locale at `:66-70`;
      `startClock` no longer names what it does. `TaskQueue.css`: roughly
      300 inherited lines (`.cols`, `.why`, `.models`, `.tok`, `.mdl`,
      `.lists-detail`) matching nothing. → `taskqueue-remove-dead-code`
- [ ] **Orphan detection has a documented blind spot** (note, not a fix).
      `pidAlive()`/`isOrphan()` at `tasks.js:117-135`: Windows reuses PIDs
      aggressively, so a dead runner's PID taken by an unrelated process reads
      as alive and the alarm stays quiet. `LOCKING.md` accepts this
      deliberately — better than reaping live work. Worth one line in the
      README so nobody trusts a silent Files view more than it deserves.
      → `taskqueue-document-pid-reuse-blind-spot`

## All three widgets

- [x] **tab-buttons throws in iCUE's settings panel** (fixed in `c1f7644` by
      moving off the control; the underlying bug is iCUE's):
      `TabButtonsEditorSetting.qml:33: TypeError: Property 'rowCount' of object
      [object Object],[object Object],[object Object] is not a function`. Fires
      for C64 Weather's `tempUnit` and the usage widget's `colorTheme`. It is in
      iCUE's own QML, so it may be their bug rather than a malformed
      `data-values` — not yet investigated.

## Notes for future work

- **Updating is a file mirror, not a re-import** — `tools/deploy.ps1`. The three
  notes below are why, and all three are now avoided rather than lived with:
  the GUID folder that is already registered is mirrored from the repo
  directory, so the registration, its place on the dashboard and its properties
  are never touched. MEASURED: `cityName` was still `Hammel, DK` across a
  1.5.4 → 1.6.0 deploy.
- **Re-importing a `.icuewidget` mints a new registration** under a fresh GUID in
  `%APPDATA%\Corsair\CUE5\html_widgets\` and leaves the old one behind, unplaced.
  Removing a widget from the dashboard deletes its folder, so remove-then-re-add
  is the clean way to reload; re-importing is what accumulates duplicates.
- **Widget properties reset on re-add** — `cityName` goes back to Copenhagen
  every time.
- **iCUE caches the loaded page.** Updating files on disk does nothing while it
  runs. Remove-and-re-add is NOT the only way to clear it, which is what this
  note used to say: **restarting iCUE.exe is enough**, measured — both widgets
  went from 1.5.4/1.12.0 to 1.6.0/1.14.0 on the panel across one stop/start,
  with no dashboard edit. `deploy.ps1` mirrors while it is stopped, which also
  keeps the copy clear of any file handle. The version on the widget is still
  the quickest way to tell which build is actually running, and
  `tools/capture-device.ps1` is how to read it without leaving the terminal.
- **Headless Chrome's `--window-size` includes window chrome** — see the
  verification section in `README.md` before trusting any layout screenshot.
