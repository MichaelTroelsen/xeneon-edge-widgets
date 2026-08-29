# Handoff — Xeneon Edge widgets

Written 2026-08-29 ~16:55 local. Replaces the version written at ~09:35, which
stopped at `bb2ea7d` and described a tree six commits old.

Repo: `C:\Users\mit\claude\icue` → https://github.com/MichaelTroelsen/xeneon-edge-widgets
(public, `main`). **`HEAD` is `acfeee4` and `origin/main` is `3214d2b` — the last
two commits are LOCAL ONLY.** `README.md` and `TODO.md` are modified and
uncommitted. See Current State before doing anything.

<original_task>
The session opened with **"read what next"**. Everything after that came from the
user's follow-ups, in order:

1. **"please list the themes and the roms missing. Please make it so when you
   click on the c64 weather it changes them."**
2. Seven reference images, one per message, with no instruction attached: the
   PET, BBC, CPC and Spectrum startup screens, the Amiga Kickstart screen, then
   photographs of the CPC 464, the ZX Spectrum and a CBM 8032. One asked message
   was **"picture of BBC Micro machine."** — a request for a photo, not an
   attachment.
3. A scoping question was put to the user, who chose **boot-screen-accurate
   themes with machine art**, and **keep the CPC as a 464**.
4. **"Everytime you switch theme to a new machine it should boot in 2 sec and
   then show the weather screen?"** — the shape the rest of the work took.
5. `/whattask`, then `/runqueue --until-blocked`.
</original_task>

<work_completed>

## Commits (both LOCAL, not pushed)

| SHA | What |
|---|---|
| `1710ee2` | Tap the weather widget to change theme (1.3.2) |
| `acfeee4` | Every machine boots before it shows the weather (1.4.0) |

## 1. Tap to change theme (`1710ee2`, C64 Weather 1.3.2)

Tapping steps through `THEME_ORDER` and wraps. The iCUE combobox is still the
setting: a tap is an override remembered **alongside the property value it was
made against**, so when that value changes the settings panel wins and the
override is dropped. Without that rule the combobox looks broken forever after
one tap. Persisted under its own `localStorage` key, apart from the reading cache.

`manifest.json` needed **`"interactive": true`** — without it iCUE never forwards
touches to the page at all. 12px slop / 700ms, same rule as the usage widget.

Fixed alongside, same code path: **`renderStatic()` ran once at boot and never
again**, so a theme picked in the settings panel did not appear until reload.

## 2. The boot sequence and the accurate startup screens (`acfeee4`, 1.4.0)

Changing theme now **reboots the machine**: its real startup screen holds the
whole slot for `BOOT_MS` (2000) and then the weather screen takes over. That
reordering is what made the rest possible — the startup text no longer shares the
slot with the readout, so it can be the real thing at its real length.

- **Startup text is now verbatim**, per machine, checked against the user's
  reference shots. Four lines of Amstrad/Locomotive copyright for the CPC 464;
  `BBC Computer 32K / Acorn DFS / BASIC`; the Kickstart 3.1 ROM banner rather
  than Workbench 1.3; one Sinclair line at the **foot** of the screen, where the
  real one sat (`order: 3` plus `margin-top: auto` — `order` alone only reorders,
  it does not drop to the bottom).
- **The WEATHER-for-BASIC homage is gone.** Beside the real screens it read as a
  mistake rather than a joke. The widget's own line is `load`, which on all six
  machines was something the user *typed* — and it carries the version, so the
  device still states which build it is running.
- **The font gained 26 lowercase letters and `©`.** Four of the six machines boot
  in mixed case, so capitals were an inaccuracy, not a style. Case is a property
  of the machine: C64 and PET fold to their uppercase/graphics set, the rest do
  not. Descenders reach row 7, which is why `.boot` needed a row gap — "plc" ran
  into the line below it.
- **Three palettes were wrong** and are now *sampled* from the reference images
  rather than guessed: Amiga `#411040` on `#e9a888`, CPC `#000088` (not
  `#000080`), Spectrum paper `#d0d0d0` (not white).

## 3. Tests

| File | What | Notes |
|---|---|---|
| `C64Weather/test/theme.test.js` | **NEW**, 39 checks | stub DOM + fake timer queue |
| `C64Weather/test/font.test.js` | extended | now sets mixed case before probing |

`theme.test.js` runs `widget.js` against a stub DOM. It covers the cycle and its
wrap, the drag and hold guards, persistence across a reload, the
settings-outrank-a-tap rule, the boot on load and on change, its exact duration,
the CPC's four lines and the Spectrum's one, Modern playing no boot at all, and a
second tap restarting the clock rather than inheriting the old timer.

**Mutation-checked six ways** (fails: uncleared timer 1, redraw-reboots 2,
boot-with-no-screen 1, case flag dropped 4, always-uppercase 6, one lowercase
glyph deleted 7).

Two of those tests exist because the mutation check found the gap first:
- **"a data refresh redraws WITHOUT rebooting"** — removing the `bootedTheme ===
  name` guard initially passed every test. Without it the weather would vanish
  behind the startup screen on every refresh cycle, all day.
- **`font.test.js` was passing vacuously for lowercase.** Its probe ran in the
  default uppercase mode, so every lowercase probe folded to a capital that
  already existed. It now calls `setFont('pixel', null, true)` first and asserts
  `letterCase() === 'mixed'`.

## 4. The `/runqueue` cycle (this session, after the commits)

Two delegated agents ran concurrently; both recorded `done` in `runs.jsonl`.

- **`verify-modern-condition-art`** closed the gap `3214d2b` left: all nine Modern
  conditions rendered and looked at as images, not counted as paths. **Eight of
  nine read correctly. `snow` does not** — cloud plus three plain dots, which
  reads as light rain or hail. Confirmed independently by the orchestrator.
  Opened `fix-modern-snow-glyph-legibility`.
- **`sync-docs-after-1-4-0`** rewrote README's banner example, its seven-row theme
  table and its authenticity paragraph against `widget.js`, and bumped TODO's
  usage header to 1.9.1. Four of the six theme rows were wrong in substance, not
  just in version. **These edits are uncommitted.**
</work_completed>

<work_remaining>

## Immediate, and in this order

1. **Push.** `origin/main` is at `3214d2b`; `1710ee2` and `acfeee4` are local
   only. **CI has therefore never run `theme.test.js`** — the last green run is
   for `3214d2b`. Both suites pass locally on Windows/Node 22; the matrix
   (Ubuntu × Node 20/22) is unproven for the new test, and it uses `Proxy`,
   `Object.defineProperty` and a fake timer queue, so a platform difference is
   not impossible.
2. **Review and commit `README.md` and `TODO.md`.** Written by a subagent, spot-
   checked by the orchestrator (every theme's `boot[0]` verified verbatim against
   `widget.js`), but not read line by line by a human.
3. **The device is two versions behind, on both widgets.** Installed folders hold
   C64 Weather **1.3.0** and Claude Code Usage **1.9.0**; the repo is **1.4.0**
   and **1.9.1**. Nothing from the last four commits is visible on the Edge.
   Needs a remove-and-re-add in iCUE, which mints a new GUID and resets widget
   properties.

## Open tasks (see `.claude/tasks/whattask.json`, generated at `acfeee4`)

Five of the eight are `requires-user` — they are waiting on a decision, not on
work:

- **`boot-screen-machine-art`** — the piece the reference photos were for. Blocked
  on two answers: does the art sit BESIDE the startup text for the two booting
  seconds or REPLACE it, and there are no reference photos yet for the BBC Micro
  or the C64. Drawing those two from memory is the same fiction the ROM task
  refuses.
- **`c64-rom-letterforms`** — blocked on a licensing decision (Cloanto, Amstrad,
  Acorn/RISC OS Open), not a technical one. Two of the six offsets are also
  unverified: the BBC's font in the MOS ROM and the CPC's character matrix table.
- **`reload-widgets-in-icue`** and **`verify-touch-drag`** — both need a human at
  the device. Touch drag matters more than it did: tap-to-change-theme uses the
  same 12px slop rule as the usage widget's scrolling lists, so if the webview
  forwards drags as taps, the theme could change during a scroll.
- **`tdzlaptop-remote-sessions`** — blocked on whether the widget's claim changes
  from "what this box is doing" to "what my account is doing".

Not yet in the plan, opened by this session's run log:

- **`fix-modern-snow-glyph-legibility`** — the snow glyph needs a snowflake or
  asterisk mark instead of three dots. A `petscii.js` change; small, and now
  evidenced by a rendered image rather than a suspicion.

## Known limitations, documented not fixed

- **The `©` glyph is muddy at boot-line size.** At `--font-boot` each of the 8
  rows is ~1.8px, so a 1px feature blurs; the ring reads as a blob. Inherent to
  5×7, not a bug — the letters survive because they are simpler.
- **Subtask labels are the first line of the agent's prompt.** `opts.label` is
  never written to disk.
- **A workflow launched from a script outside the session's `workflows/scripts/`**
  falls back to its short run id.
- **~20 s lag each way** — `REFRESH_MS` 10 s + widget poll 10 s. Tightening is
  cheap but **both** numbers must drop together.

## Deliberately not done

- **Changing the User-Agent**, or refreshing the token to reset the rate-limit
  window. Both are working around a rate limit; the second reportedly breaks
  Claude Code's own auth. It matters less than it did — the widget's figures come
  from the statusline path, which uses no token at all.
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
  unchanged and both were real gaps in the tests, not proof the code was safe.
  A mutation that does not fail anything is a missing test, every time.

## The recurring environment trap — SIX sightings, twice this session

**A backslash escape (`\n`, `\\E`, `\U`) or a Windows path inside a heredoc'd
Python or shell string gets mangled.** It has broken `live-detection.test.js`,
`statusline.test.js`, `usagehtml.js`, the `usage-server/README.md` edit (which
was committed *without* its documentation as a result), and this session it ate
both a `theme.test.js` heredoc and a verification regex — the second producing a
bare `re.PatternError` with no hint of the cause.

**Use the Write/Edit tools for any line containing a backslash escape or a
Windows path, and check `git status` before committing a scripted edit.**

## Headless-render gotchas, found this session

- **`file:///$PWD/...` fails with `ERR_FILE_NOT_FOUND`.** Git Bash's `pwd`
  returns a POSIX mount path (`/tmp/claude/...`), not the Windows path, even
  though the cwd is a real Windows directory. Hardcode the Windows absolute path.
- **A running Chrome on the default profile makes bare `--headless` misbehave.**
  Add `--user-data-dir=<scratch>/chromeprofile --no-sandbox` for an isolated
  instance.
- Nine renders that all came back **identical in size** were nine copies of one
  failed page. Compare file sizes before trusting a batch.

## Corrections made mid-session

- The user's own references **contradict each other**, twice: the PET startup
  shot is an 8K BASIC 2.0 machine while the photographed machine is a CBM 8032
  (BASIC 4.0, 31743 bytes); the CPC startup shot is a 6128 while the photographed
  machine is a 464. Resolved toward the machines photographed, and recorded in
  the theme table so the next person does not "fix" it back.
- The plan marked both delegated tasks `lane: serial`, but their only shared
  paths were `r:` on both sides. The lanes had been computed against
  `requires-user` tasks that can never be scheduled. The arithmetic was followed
  and they ran concurrently.
</attempted_approaches>

<critical_context>

## Environment

- `icuewidget` CLI at `C:\Program Files\Corsair\iCUE Widget CLI\` (v0.4.45;
  0.4.47 available). `validate` then `package`.
- Xeneon Edge is `\\.\DISPLAY2`, **2560×720 at X=-1881, Y=1440**; widgets sit in
  **840×344** slots. Capture with `System.Drawing` `CopyFromScreen`.
- Node `C:\Program Files\nodejs\node.exe`; Chrome at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- `gh` authenticated as `MichaelTroelsen`.
- Server runs under scheduled task **`ClaudeUsageFeed`** via `start-hidden.vbs`.
- The **tokensave MCP server failed to connect** this session; all exploration
  was plain `grep`/`Read`.

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
| `BOOT_MS` | 2000 | C64Weather/scripts/widget.js |
| `TAP_SLOP_PX` / `TAP_MAX_MS` | 12 px / 700 ms | both widgets |
| `REFRESH_MS` | 10 s | usage-server/server.js |
| `SESSION_ACTIVE_MS` | 15 min | server.js |
| `LIVE_RUN_STALE_MS` | 15 min | server.js |
| `OFFICIAL_INTERVAL_MS` | 12 min | server.js |
| `OFFICIAL_STALE_MS` | 45 min | server.js |
| `FRESH_MS` / `MAX_AGE_MS` | 10 min / 45 min | statusline.js |
| `HIGH_WATER` / `CRITICAL_WATER` | 80 / 95 | ClaudeUsage/scripts/widget.js |

## Non-obvious behaviours

- **`"interactive": true` in `manifest.json` is required** or iCUE forwards no
  touches at all. It is not implied by having a click handler.
- A theme is live when its `theme-<name>` class is on `.widget-root`; that class
  is the only thing the stylesheet reads, which is what makes it the right thing
  to assert on.
- `wf_*.json` is written **only at completion**; the transcript directory exists
  from launch.
- A just-opened session's transcript contains **no message**.
- Claude Code **drops a window** from `rate_limits` once its `resets_at` passes,
  which is what makes the `LIVE¹` partial-provenance case real.
- `resets_at` is epoch **seconds** in the statusline payload, an **ISO string**
  from `/api/oauth/usage`.
- **The 429 on `/api/oauth/usage` is not our fault** — verified against
  anthropics/claude-code#30930, #31637, #31055. Do not re-derive it as "we polled
  too much". It is cosmetic now: the figures come from the statusline path.
- `.icuewidget` packages are **gitignored** — do not try to commit them.
- **iCUE caches the page**; the version on screen is the only reliable indicator
  of what is running. Re-adding mints a new GUID and resets properties. **Do not
  restart iCUE** — it orphaned the dashboard layout once.
- **`tab-buttons` is unusable and it is iCUE's bug**, not ours:
  `TabButtonsEditorSetting.qml:33` calls `rowCount()` on a QVariantList, which
  crosses into QML as a plain array. It throws for every possible `data-values`
  payload, Corsair's own bundled widgets included. Both settings are `combobox`
  now (`c1f7644`); do not switch back.

## Verification conventions

- Layout: exactly-sized `<iframe>` in a larger window (bare `--window-size`
  includes window chrome).
- To force a theme headlessly, inject `<script>window.theme='cpc';</script>`
  **before** the `petscii.js` tag — `getIcueProperty` reads `window[name]`.
- To reach a specific view or state, append a script that dispatches real
  `PointerEvent`s, or overrides `window.fetch` with a stub.
- Budget past the 2-second boot: `--virtual-time-budget=6000`.
- **Mutation-check every new test** by reverting the fix — and treat a mutation
  that passes as a missing test, not as reassurance.
</critical_context>

<current_state>

## Not clean, not pushed

- `HEAD` **`acfeee4`**, `origin/main` **`3214d2b`** — two commits ahead, unpushed.
- Working tree: **`README.md` and `TODO.md` modified**, uncommitted, written by
  the `/runqueue` doc agent.
- **CI's last green run is `3214d2b`.** It has never seen `theme.test.js`.

## Versions

| | Repo | Installed | Device |
|---|---|---|---|
| C64 Weather | **1.4.0** | 1.3.0 | not re-checked; was 1.2.0-era |
| Claude Code Usage | **1.9.1** | 1.9.0 | last seen 1.7.0 |

## Tests — all passing locally

```bash
node C64Weather/test/font.test.js        # extended, mixed-case probe
node C64Weather/test/theme.test.js       # 39 checks, NEW
node usage-server/test/live-detection.test.js   # 18 checks
node usage-server/test/statusline.test.js       # 35 checks
```

`icuewidget validate C64Weather` → valid, 1.4.0.

## Task queue

`.claude/tasks/whattask.json` was generated at `acfeee4`: **8 tasks, 9 closed**.
`/runqueue --until-blocked` drained both runnable delegated tasks and this
handoff; **the remaining five are all `requires-user`**, so the queue is blocked
on decisions rather than on work. `runs.jsonl` has 11 lines.

## Open questions

- Does the iCUE webview forward touch **drags**? Now load-bearing for two widgets.
- Should the 10 s / 10 s intervals be tightened? Cheap, still not requested.
- Does `/api/oauth/usage` ever stop 429ing for this account? Cosmetic.
</current_state>
