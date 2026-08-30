# Handoff — Xeneon Edge widgets

Written 2026-08-30. Replaces the version written at f0c4a29, and updated again
after the usage-widget stats work landed.

Repo: `C:\Users\mit\claude\icue` → https://github.com/MichaelTroelsen/xeneon-edge-widgets
(public, `main`). The widgets are at **C64 Weather 1.5.4** and **Claude Code
Usage 1.10.0**.

**This file went stale within the hour three times earlier in the session.** The
lesson is in the conventions below and is worth repeating here: write the handoff
LAST, after the work is committed. This revision was written after the commits it
describes were made, and reconciled against `.claude/tasks/runs.jsonl`.

<original_task>
The session opened with **"read what next"**. Everything after came from the
user's follow-ups, in order:

1. **"please list the themes and the roms missing. Please make it so when you
   click on the c64 weather it changes them."**
2. Seven reference images, one per message, with no instruction attached — the
   PET, BBC, CPC and Spectrum startup screens, the Amiga Kickstart screen, then
   photographs of the CPC 464, the ZX Spectrum and a CBM 8032.
3. **"Everytime you switch theme to a new machine it should boot in 2 sec and
   then show the weather screen?"**
4. `/whattask`, `/runqueue`, `/runhuman`, `/runtask` — the task pipeline, several
   rounds.
5. **"can you make the font size larger (+1) on the C64 widget?"**, then three
   device crops and **"this is the text that is to small"**, then **"The
   tempuratur size is fine."**
6. **"i have reloaded the widgets"** (twice), **"please check all themes"**,
   **"any suggested improvements"**.
7. Two `/stats` screenshots with **"can you make stats like this be added? to
   the claude code widget?"** — the Overview heatmap and the Models chart.
8. **"add code review of server js to the todo list."**
9. **"loop 4 /runtask next"**, then **"commit and push"** and **"update docs."**
</original_task>

<work_completed>

## Commits

These were pushed and green. Everything from the drain that followed - the
boot-text scaling fix, the layout suite, the version caption and the redrawn
machine art, taking the widget from 1.5.1 to 1.5.4 - lands in the commit that
carries this file, so it is not listed below.

| SHA | What |
|---|---|
| `1710ee2` | Tap the weather widget to change theme (1.3.2) |
| `acfeee4` | Every machine boots before it shows the weather (1.4.0) |
| `0541d0f` | Docs: catch README and TODO up with 1.4.0 |
| `f0c4a29` | Handoff (superseded by this file) |
| `3dc0c4b` | Each machine appears beside its own boot screen (1.5.0) |
| `fb8520c` | Bigger small text on the weather widget (1.5.1) |
| `74ab741` | A test that looks at the widget, and the defects it found |
| `5cc7e20` | Serve Claude Code's own stats rollup from the feed |
| `200916e` | A fourth view for the usage widget: all time (1.10.0) |

## What the widget does now that it did not

- **Tap to change machine.** Steps through `THEME_ORDER` and wraps. The iCUE
  combobox is still the setting: a tap is an override remembered *alongside the
  property value it was made against*, so changing the setting drops the
  override rather than being outranked by it forever. Needs
  `"interactive": true` in `manifest.json` or iCUE forwards no touches at all.
- **Changing machine reboots it.** The new machine's startup screen holds the
  whole slot for `BOOT_MS` (2000) and then hands over to the weather screen.
  That reordering is what let the startup text become verbatim at full length.
- **Verbatim startup screens**, checked against the user's reference shots —
  four lines of Amstrad/Locomotive copyright, the Kickstart 3.1 ROM banner
  rather than Workbench 1.3, one Sinclair line at the *foot* of the screen.
- **Lowercase and `©` in the font** (27 glyphs). Case is a property of the
  machine: C64 and PET fold to their uppercase/graphics set, the other four do
  not.
- **A drawing of each machine below its boot screen** — `MACHINES` in
  petscii.js, rendered through the existing `artSVG` path. Drawn from
  photographs, never memory.
- **Bigger small text** (1.5.1): `--font-boot` +53%, `--font-label` +50%,
  `--font-hero` deliberately unchanged.

## What the USAGE widget does now that it did not

- **A `stats` block on `GET /usage`**, read from `~/.claude/stats-cache.json`
  through `CLAUDE_USAGE_STATS_FILE`, mtime-cached, gated on `version === 5`.
  Absent / unparseable / wrong-version each return
  `stats: {unavailable: "<reason>"}` with the rest of the payload intact.
- **A fourth view, All time** (1.10.0): a contribution heatmap plus eight
  headline figures — sessions, messages, active days, current and longest
  streak, busiest day, top model, total tokens. Tapping cycles four views and
  wraps; the indicator has four dots.
- **The heatmap is laid out by CALENDAR DATE, not array position.** The rollup
  writes a row only for a day that had activity, so it is sparse — 92 rows
  across a 284-day span here. This is the single most important thing to know
  before touching that view: packing the entries side by side draws a
  plausible-looking grid in which every date is wrong, and that is exactly what
  the first attempt did.
- **`stats.unavailable` prints the reason** rather than drawing an empty grid,
  which would read as months of silence instead of a missing file.

## Tests

`C64Weather/test/theme.test.js` is new this session — 65 checks over a stub DOM
and a fake timer queue: the tap cycle and its wrap, the drag and hold guards,
persistence, settings-outrank-a-tap, the boot on load and on change, its exact
duration, per-theme boot-line counts, letter case, and the machine drawings.
`font.test.js` gained lowercase, `©` and five machine-art checks.

Both were **mutation-checked**, and two of their assertions exist *because* a
mutation passed first: a data refresh must redraw WITHOUT rebooting, and
`font.test.js` was passing vacuously for lowercase until it was made to set
mixed case before probing.
</work_completed>

<work_remaining>

Everything open is in `.claude/tasks/whattask.json`, whose snapshot is keyed to
HEAD `74ab741` and is therefore now one commit behind - re-run `/whattask`
before trusting its readiness column.

Four tasks are open, and one more exists only in `runs.jsonl` because nothing
has re-planned since it was opened:

- **`server-js-code-review`** (opus, xhigh, subtask) - the user asked for this
  explicitly. `usage-server/server.js` is 1138 lines, 35 functions and **11
  module-level mutable variables**; it is framed in `TODO.md:208` as a
  falsification pass, not a tidy-up.
- **`usage-server-ci-add-stats-test`** (sonnet, low, subtask) - `stats.test.js`
  is hermetic and passes, but is NOT in `.github/workflows/tests.yml`, so it
  only runs when invoked by hand. The agent that wrote it stopped at the
  undeclared path rather than editing the workflow, which is the behaviour the
  touches rule exists to produce; this is the follow-up it opened.
- **`usage-widget-model-token-chart`** (opus, medium, main) - the second half of
  the user's `/stats` request: the Models chart. Its dependency
  `usage-widget-stats-view` is now `done`, so it is READY. `dailyModelTokens`
  (34 entries, fewer days than `dailyActivity`) is the source.
- **`usage-widget-stats-layout-test`** (opened 2026-08-30, not yet in the plan)
  - the render-and-probe harness for the All time view lives only in the
  scratchpad, so nothing in the repo would catch a regression in it. C64Weather
  has `test/layout.test.js` doing exactly this job; **ClaudeUsage has no test
  directory at all**. The harness already carries the two Chrome calibrations
  recorded below, which cost most of the time in that task.
- **`verify-touch-drag`** (requires-user) - needs a finger on the Edge. The real
  risk is the USAGE widget, not the weather one: its lists scroll AND it
  switches view on tap, both on the same 12px slop rule, so a webview delivering
  a drag without intermediate pointer positions would flip the view on every
  scroll. That risk is now larger, not smaller - there are four views to flip
  through instead of three.

Closed for the record: `polish-visual-seams`, `modern-theme-shows-no-version`,
`machine-art-distinctiveness`, `sync-docs-after-1-5-x`, `render-smoke-test-in-ci`,
`usage-server-expose-stats` and `usage-widget-stats-view`. See `runs.jsonl` for
what each actually found - several corrected their own brief rather than
following it.

## Known limitations, documented not fixed

- **The `©` glyph WAS muddy at boot size; the 1.5.1 font increase largely fixed
  it.** At `--font-boot` 3.4 each of the 8 rows was ~1.8px and the ring filled
  in; at 5.2 it is ~2.8px and the ring resolves, confirmed by a magnified
  render. Still cramped inside — 5px wide cannot do better — but no longer a
  blob. Do not re-report it as broken without looking first.
- **Subtask labels are the first line of the agent's prompt.** `opts.label` is
  never written to disk.
- **~20 s lag each way** — `REFRESH_MS` 10 s + widget poll 10 s. Both numbers
  must drop together.

## Deliberately not done, do not re-propose

- **ROM letterforms** — authorisation refused 2026-08-29. Six rights holders
  against a public repo for a cosmetic gain. `PETSCII.setFont(mode, glyphs,
  mixedCase)` stays as the hook if that ever changes.
- **tdzlaptop sessions in the activity lists** — declined 2026-08-29. The usage
  bars already cover the laptop; the lists' value is that an empty list means
  nothing is running HERE.
- **Changing the User-Agent** or refreshing the token to dodge the 429.
</work_remaining>

<attempted_approaches>

## Dead ends — do not repeat

- **Local percentage estimation.** Disproved arithmetically (growth floor 4.28×
  vs a 4.00× ceiling). Deleted from the code; the disproof stays in
  `usage-server/README.md`.
- **Filtering `wf_*.json` by status to find running work.** The file does not
  exist until the run ends. Shipped in `97942a9`; the lists were empty.
- **`Start-Sleep -Seconds 60` in a probe agent.** The harness blocks a standalone
  sleep; the agent backgrounded it and returned "done" in 13.8 s. Use
  `node -e "…setTimeout(…,60000)"` and have it print its own elapsed time.
- **`spawn(cmd, args, {shell:true})`** — concatenates without escaping (Node
  DEP0190); a spaced path is re-split. Build one quoted command string.
- **Backgrounding the probe checker inside a `run_in_background` Bash call** —
  the wrapper exits and kills the child.
- **Assuming a guard takes effect where you place it.** `CLAUDE_USAGE_NO_REMOTE`
  was set *after* `rebuild()`, so the cached snapshot still said "not fetched
  yet".
- **`order` alone to move a flex child to the bottom.** It reorders within the
  stack; items still pack from the top. The Spectrum's copyright needed
  `margin-top: auto` as well.
- **Trusting a mutation check that passes.** Two mutations passed the suite
  unchanged and both were missing tests, not safe code. A mutation that fails
  nothing is a gap in the tests, every time.
- **Believing a structural check about a picture.** Path counts, sprite-name
  existence and "no empty `d`" all passed on a snow icon that rendered as three
  dots. If the claim is about how something LOOKS, the check has to look.

## The recurring environment trap — EIGHT sightings

**A backslash escape (`\n`, `\\E`, `\U`) or a Windows path inside a heredoc'd or
`python -c` string gets mangled.** It has broken `live-detection.test.js`,
`statusline.test.js`, `usagehtml.js`, the `usage-server/README.md` edit (which
was committed *without* its documentation as a result), a `theme.test.js`
heredoc, a `python -c` regex that came back as a bare `re.PatternError` with
nothing pointing at the cause, and — the eighth, while editing THIS FILE to
record the seventh — a heredoc'd Python string containing `C:\Users`, which
died on `truncated \UXXXXXXXX escape`.

**Use the Write/Edit tools for any line containing a backslash escape or a
Windows path, or put the script in a scratch `.py` file and run it by path.**

## Headless-render gotchas

- **`file:///$PWD/...` fails with `ERR_FILE_NOT_FOUND`.** Git Bash's `pwd`
  returns a POSIX mount path, not the Windows path. Hardcode the Windows path.
- **A running Chrome on the default profile makes bare `--headless` misbehave.**
  Add `--user-data-dir=<scratch>/chromeprofile --no-sandbox`.
- Renders that all come back **identical in size** are copies of one failed
  page. Compare sizes before trusting a batch.
- To force a theme, inject `<script>window.theme='cpc';</script>` **before** the
  `petscii.js` tag; `getIcueProperty` reads `window[name]`.
- Budget past the 2-second boot (`--virtual-time-budget=6000`) for the settled
  screen, and inside it (~900) for the boot screen.
- **`--window-size` means different things in the two modes**, measured
  2026-08-30 with a 100vw/100vh marker box. Under `--dump-dom` it is the window
  and Chrome subtracts its chrome: `840,344` lays out at **824x193**, `856,495`
  at a true **840x344**. Under `--screenshot` the viewport is resized to the FULL
  window just before capture, so `840,344` is what gives an 840x344 page. A probe
  and a screenshot of the same layout therefore need DIFFERENT flags. Have the
  probe assert `window.innerWidth`/`innerHeight`. The figure the README carried
  before this (824x249) was simply wrong, and nothing caught it.
- **`window.innerWidth` read during load disagrees with what is painted** in
  screenshot mode, for the same reason — it is the pre-resize size. Measuring it
  early is how the wrong figure got recorded in the first place.
- **CSS transitions do not advance under `--virtual-time-budget`**, and
  `--force-prefers-reduced-motion` does not help. `getComputedStyle` returns the
  colour a transitioning property had BEFORE the change; this made the usage
  widget's view indicator look stuck on the first dot when it was in fact
  correct. Inject `* { transition: none !important }` in the harness.

## Task-pipeline traps, new this session

- **`partial` keeps a task selectable forever.** `boot-screen-machine-art` was
  recorded `partial` for a touches violation, not for missing work; its feature
  was complete and committed. The next `/runtask next` selected it again,
  because `partial` never satisfies. If the work is done and only the record is
  wrong, fix it in the plan rather than leaving the trap armed.
- **Reading `opened` from the LAST line per id loses ids.** An id recorded in an
  earlier line for the same task disappears. `modern-theme-shows-no-version` was
  lost that way and only recovered by scanning every line. Reconcile `opened`
  over the WHOLE file.
- **A verify that bundles another task's subject cannot pass.**
  `reload-widgets-in-icue` carried gesture clauses belonging to
  `verify-touch-drag`, which forced a `partial` when the re-add had entirely
  succeeded.

## Corrections made mid-session

- **A touches violation, twice.** Both `c64-retro-themes` and
  `boot-screen-machine-art` wrote a path they had not declared, and both times
  it was the same class: a task that adds a rendered element needs `rw:` on the
  page hosting it. Declare `index.html` for anything that renders.
- **The user's own references contradicted each other twice.** The PET startup
  shot is an 8K BASIC 2.0 machine while the photographed machine is a CBM 8032;
  the CPC startup shot is a 6128 while the photographed machine is a 464.
  Resolved toward the machines photographed, and recorded in the theme table so
  the next person does not "fix" it back.
- **"+1 on the font size" was read too broadly at first** — every token including
  the hero. The user's crops and then "The tempuratur size is fine" narrowed it
  to the small text only.
</attempted_approaches>

<critical_context>

## Environment

- `icuewidget` CLI at `C:\Program Files\Corsair\iCUE Widget CLI\` (v0.4.45).
  `validate` then `package`.
- Xeneon Edge is `\\.\DISPLAY2`, **2560×720 at X=-1881, Y=1440**; widgets sit in
  **840×344** slots. Capture with `System.Drawing` `CopyFromScreen`.
- Node `C:\Program Files\nodejs\node.exe`; Chrome at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- `gh` authenticated as `MichaelTroelsen`. Server runs under scheduled task
  **`ClaudeUsageFeed`**.
- The **tokensave MCP server failed to connect** all session; exploration was
  plain `grep`/`Read`.

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
| `--font-hero` / `--font-label` / `--font-boot` | 22 / 6 / 5.2 × layout-unit | C64Weather.css |
| `--font-secondary` | 7 — **declared, read by nothing** | C64Weather.css |
| `BOOT_MS` | 2000 | C64Weather/scripts/widget.js |
| `TAP_SLOP_PX` / `TAP_MAX_MS` | 12 px / 700 ms | both widgets |
| `REFRESH_MS` | 10 s | usage-server/server.js |
| `SESSION_ACTIVE_MS` / `LIVE_RUN_STALE_MS` | 15 min | server.js |
| `OFFICIAL_INTERVAL_MS` / `OFFICIAL_STALE_MS` | 12 min / 45 min | server.js |
| `HIGH_WATER` / `CRITICAL_WATER` | 80 / 95 | ClaudeUsage/scripts/widget.js |

## Non-obvious behaviours

- **`"interactive": true` in `manifest.json` is required** or iCUE forwards no
  touches at all. It is not implied by having a click handler.
- **A theme is live when its `theme-<name>` class is on `.widget-root`** — the
  only thing the stylesheet reads, so it is the right thing to assert on.
- **`setMachine` has NO fallback**, unlike `setSprite` which falls back to
  `cloud`. An unknown machine draws nothing, deliberately: the right startup
  screen beside the wrong machine is worse than no picture.
- **Modern prints no version** (`boot: []`, `load: ''`), so a device capture of
  the Modern theme cannot confirm which build is running. This is an open task.
- **iCUE caches the page**; the version on screen is the only reliable indicator
  of what is running. Re-adding mints a **new GUID and resets widget
  properties** — the theme goes back to `c64`. **Do not restart iCUE**; it
  orphaned the dashboard layout once.
- **`tab-buttons` is unusable and it is iCUE's bug** —
  `TabButtonsEditorSetting.qml:33` calls `rowCount()` on a QVariantList. Both
  settings are `combobox` now; do not switch back.
- **The 429 on `/api/oauth/usage` is not our fault** — anthropics/claude-code
  #30930, #31637, #31055. Cosmetic now: figures come from the statusline path.
- **`.icuewidget` packages are gitignored** — do not try to commit them.
- **Corsair's own stock Weather widget is also on this dashboard**, top-left,
  and looks superficially similar. Ours writes `17° | 19°` (degree only) and
  `17KM/H` uppercase; theirs writes `15°C | 18°C` and `9km/h`.

## Verification conventions

- Layout: exactly-sized render at 840×344; bare `--window-size` on a real window
  includes chrome.
- To test a payload variant, override `window.fetch` with a stub in an injected
  script; read `resolveLocation`/`fetchWeather` for the real response shape.
- **Mutation-check every new test** by reverting the fix — and treat a mutation
  that passes as a missing test, not as reassurance.
- **If the claim is visual, look at the picture.** Three defects this session
  passed every structural check.
- **A CSS rule that is never applied can still leave the page looking right.**
  A malformed comment (a closing `*/`, more prose, then another `*/`) silently
  ate a whole rule in `C64Weather.css`; every test stayed green because the
  tests measure the RESULT, and the result happened to be correct anyway. When
  a fix IS a CSS rule, confirm with `getComputedStyle` in the page that the
  rule is actually applied — don't infer it from a screenshot.
- **Write the handoff LAST.** This one was rewritten mid-drain and was stale
  within the hour, because findings kept landing after it was written.
</critical_context>

<current_state>

## Where the tree stands

- **C64 Weather 1.5.4**, **Claude Code Usage 1.9.1** in the repo.
- The DEVICE is on **1.5.1** — it was re-added twice on 2026-08-30 and has not
  been re-added since, so the boot-text scaling fix, the machine-art placement,
  the version caption and the redrawn machines are all NOT on it yet. Seeing
  them needs another remove-and-re-add, which resets the widget properties and
  mints a new GUID; it is worth batching.
- Installed GUIDs at the last re-add: weather
  `1f6c321f-2100-4b8d-a7c2-a042f589fc84`, usage
  `d8802bff-17c9-4c00-8f13-960532db8e2e` (unchanged — it did not need
  re-adding). The device is on the **C64 theme**, because re-adding reset it.
- Corsair's own stock Weather widget is also on this dashboard, top-left, and
  looks superficially similar. Ours writes `17° | 19°` and `17KM/H`; theirs
  writes `15°C | 18°C` and `9km/h`.

## Tests — all passing locally

```bash
node C64Weather/test/font.test.js        # font, art names, machine art
node C64Weather/test/theme.test.js       # 65 checks: tap, boot, case, machines, version
node C64Weather/test/layout.test.js      # renders 7 themes, measures every box
node usage-server/test/live-detection.test.js   # 18 checks
node usage-server/test/statusline.test.js       # 35 checks
node usage-server/test/stats.test.js            # 47 checks - NOT in CI yet
```

`layout.test.js` is the only suite that LOOKS at the widget rather than reading
it: it renders all seven themes at 840x344 booting and settled, and asserts
nothing overflows `.screen` and no inline-SVG text run is drawn below its
declared font-size. It carries its own two mutation checks. It has not run in CI
yet — the workflow step exists but needs a push.

`icuewidget validate C64Weather` → valid, 1.5.4.
`icuewidget validate ClaudeUsage` → valid, 1.10.0.

**The All time view has no test in the repo.** It was verified by a scratchpad
harness (render + `getComputedStyle` probe, 16 checks, three mutations) that is
not committed. See `usage-widget-stats-layout-test` above.

## Task queue

`.claude/tasks/whattask.json` (snapshot at `74ab741`, now one commit stale),
`runs.jsonl` and `decisions.jsonl` (5 lines, two of which cancelled tasks
outright). Three of the open tasks are runnable work; only `verify-touch-drag`
needs a human.

**Data bug in `runs.jsonl`, worth fixing before it misleads a runner:** several
earlier records put FILE PATHS in their `opened` array instead of task ids -
`C:/Program Files/Corsair/...HtmlWidgetCore.dll`, `.../widgets/Weather/index.html`,
`C:/Users/mit/claude/icue/ClaudeUsage/index.html` and others. Anything walking
`opened` to find newly-opened tasks will treat those as task ids.

## Open questions

- Does the iCUE webview forward touch **drags**? Answerable now. Matters most
  for the usage widget's scrolling lists, where a drag misread as a tap would
  flip the view.
- Should the 10 s / 10 s poll intervals be tightened? Cheap, still not asked for.
- ~~Can `/stats`-style history be added to the usage widget?~~ **ANSWERED and
  shipped** in `5cc7e20` + `200916e`. The Overview heatmap half is done; the
  Models chart half is `usage-widget-model-token-chart`, still open. Caveats
  that survive: `~/.claude/stats-cache.json` is an undocumented internal file
  already at `version: 5` (the server refuses any other version outright), it is
  a day stale between `/stats` runs, and `dailyModelTokens` covers fewer days
  (34) than `dailyActivity` (92).
- **The device will show "the feed is not serving a stats block"** until the
  `ClaudeUsageFeed` scheduled task is restarted. That process was started from
  the pre-`5cc7e20` `server.js`, so it serves no `stats` block at all. The view
  is behaving correctly, but it will look like a fault. Restarting the task is
  the fix, and it should happen before anyone judges the new view on hardware.

</current_state>
