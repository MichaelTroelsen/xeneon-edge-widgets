# iCUE widgets — TODO

## C64 Weather — 1.4.0

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

- [x] **Seven themes** (1.3.0). C64, Commodore PET, BBC Micro, Amstrad CPC, ZX
      Spectrum, Amiga and Modern, selected with a `combobox`. Each is a
      redefinition of the seven palette tokens plus a boot screen and cursor
      style; `modern` switches the renderer to system text. Palettes and screen
      furniture are the faithful part - the letterforms are still this project's
      own 8x8 set, and `PETSCII.setFont` now takes per-theme glyph overrides so
      ROM-accurate fonts can be added later without touching anything else.

### Open

- [ ] **Per-machine ROM letterforms.** Every retro theme still renders in one
      hand-authored 8x8 set. What is actually missing, per machine: the C64's
      4 KB character generator ROM, the PET's 2 KB character ROM, the BBC's font
      in the MOS ROM, the CPC's character matrix table in the lower ROM, the
      Spectrum's 768 bytes at 0x3D00, and the Amiga's Topaz 8 in Kickstart. The
      BBC and CPC offsets above are not verified — the other four are. Sourcing
      any of them is a licensing question as much as a technical one (Cloanto,
      Amstrad, Acorn/RISC OS Open), so it is not simply a matter of extraction.
      The hook exists (`PETSCII.setFont(mode, glyphs)`), so this stays additive.

- [ ] **Machine art on the boot screen.** Pixel art of each machine beside its
      startup text. The boot screen now has the room for it — it holds the whole
      slot for two seconds and then clears — which is what made this worth doing
      at all. Reference photos supplied for the CPC 464, the ZX Spectrum, and a
      CBM 8032; the BBC Micro and the C64 still need one.

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

## Claude Code Usage — 1.9.1

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
      subtasks), and a token breakdown behind the two bars (1.9.0), cycling
      through a three-dot indicator.
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

- [ ] **Show sessions from the other machine (`tdzlaptop`).** The Activity
      lists are this-machine-only by construction: the server walks
      `~/.claude/projects/**/*.jsonl` on the host it runs on, and Claude Code
      writes transcripts locally with no sync between machines. Verified
      2026-08-28 — all 13 indexed project directories are local (11 under
      `C:\Users\mit\...`, 2 from WSL on the same box), and `ListAgents` found no
      reachable remote session even with `remoteControlAtStartup: true`.
      **The usage bars already cover the laptop** and need no work: five-hour and
      weekly utilisation are server-side account figures counting every client
      on the account. Only the lists are local.
      Sketch: run the collector on `tdzlaptop`, have it POST its active sessions
      to this machine (or write somewhere both can read), tag every row with its
      host so `read what next · icue` is distinguishable from a laptop row, and
      decide what the widget shows when the peer is unreachable — silence is
      indistinguishable from idle, which is the trap the active-only filter was
      built to avoid. Needs the two machines to reach each other, and changes
      the widget's claim from "what this box is doing" to "what my account is
      doing": a deliberate scope change, not a setting.

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
      reset and the weighted-usage note moved in alongside it. The view
      indicator is now three dots, not two.
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
