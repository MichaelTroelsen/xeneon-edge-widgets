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

## Claude Code Usage — 1.10.0

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
      stats (1.10.0), cycling through a four-dot indicator.
- [x] **Scrollable lists**, replacing the row trimming that made anything past
      the first handful unreachable. Headings carry totals, a fade marks an
      overflowing list, and scroll position survives a refresh.

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

- [ ] **Confirm touch drag works on the device.** Scrolling is verified in a
      browser, but `interactive` is documented only as enabling *click*
      handling — whether the iCUE webview forwards drags is unknown. If it does
      not, page the lists on a timer instead.
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

## Both widgets

- [x] **tab-buttons throws in iCUE's settings panel** (fixed in `c1f7644` by
      moving off the control; the underlying bug is iCUE's):
      `TabButtonsEditorSetting.qml:33: TypeError: Property 'rowCount' of object
      [object Object],[object Object],[object Object] is not a function`. Fires
      for C64 Weather's `tempUnit` and the usage widget's `colorTheme`. It is in
      iCUE's own QML, so it may be their bug rather than a malformed
      `data-values` — not yet investigated.

## Notes for future work

- **Re-importing a `.icuewidget` mints a new registration** under a fresh GUID in
  `%APPDATA%\Corsair\CUE5\html_widgets\` and leaves the old one behind, unplaced.
  Removing a widget from the dashboard deletes its folder, so remove-then-re-add
  is the clean way to reload; re-importing is what accumulates duplicates.
- **Widget properties reset on re-add** — `cityName` goes back to Copenhagen
  every time.
- **iCUE caches the loaded page.** Updating files on disk does nothing until the
  widget is removed and re-added; the version in the header is the quickest way
  to tell which build is actually running.
- **Headless Chrome's `--window-size` includes window chrome** — see the
  verification section in `README.md` before trusting any layout screenshot.
