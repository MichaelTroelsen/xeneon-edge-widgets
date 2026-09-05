# iCUE widgets for the CORSAIR Xeneon Edge

Three HTML widgets for the Xeneon Edge dashboard display, plus the local feed
two of them need. All target `dashboard_lcd` and adapt across every Edge slot
size in both orientations.

## Deploying

```powershell
pwsh tools/deploy.ps1                      # all three widgets, patch bump
pwsh tools/deploy.ps1 -Widget C64Weather -Bump minor
pwsh tools/deploy.ps1 -Widget TaskQueue    # or ClaudeUsage
pwsh tools/deploy.ps1 -DryRun              # print every step, change nothing
```

One command replaces the whole manual round: test, bump the version in
`manifest.json` **and** `scripts/widget.js` together, `icuewidget validate` +
`package`, then install.

Installing is a file mirror onto the GUID folder that is already registered in
`%APPDATA%\Corsair\CUE5\html_widgets\`, **not** a re-import. That matters:
importing a `.icuewidget` mints a new registration under a fresh GUID, leaves
the old one behind unplaced, and resets every widget property — `cityName` goes
back to Copenhagen on every update. Mirroring keeps the registration, its place
on the dashboard, and its settings.

iCUE holds the page it loaded at startup, so the mirror happens with iCUE
stopped and iCUE is started again after — which is also why the copy can never
hit a file lock. `-NoRestart` skips that and leaves the new build sitting unread
on disk.

The previous contents of each GUID folder are copied to
`%LOCALAPPDATA%\icue-deploy-backups\<timestamp>-<widget>-<guid>` first, and a
failed install is rolled back from there.

Tests run *before* the version bump, so a red suite leaves the working tree
byte-identical. A widget that has never been imported stops the run early with
the one thing that does have to be done by hand, once:

```
Import c64-weather.icuewidget once through iCUE's UI — Dashboard, add a
widget, Import — and every update after that one can come through this script.
```

To check what is genuinely running, screenshot the panel rather than reading
`manifest.json` back — the folder can hold a new build while iCUE is still
showing the page it loaded:

```powershell
pwsh tools/capture-device.ps1 -Path edge.png
```

The [iCUE Widget CLI](https://www.corsair.com/us/en/s/downloads) can also be
driven directly:

```bash
icuewidget validate C64Weather
icuewidget package  C64Weather
```

## C64 Weather

Current conditions rendered as a Commodore 64 boot screen — light-blue-on-blue,
a blinking cursor, and real C64 error messages (`?DEVICE NOT PRESENT  ERROR`)
when the network is down.

No web font is used. `scripts/petscii.js` carries a hand-authored 8×8 glyph set
and 16×16 weather sprites, drawn as inline SVG with `shape-rendering:
crispEdges`, so the pixel look is identical on any device and scales purely
from the layout baseline.

Weather comes from [Open-Meteo](https://open-meteo.com) — no account, no API
key. Temperatures are always fetched in Celsius and converted at render time,
so switching °C/°F costs no request and works from cache while offline.

| Setting | Type | Default |
|---|---|---|
| `theme` | combobox | `c64` — seven machines, below |
| `cityName` | text | `Copenhagen` — city name or `lat,lon` |
| `tempUnit` | tabs | `auto` (follows iCUE) / C / F |
| `refreshMinutes` | slider 5–120 | 15 |

The readout follows the arrangement of Corsair's stock weather widget:
temperature and place on the left, the condition sprite with the day's low and
high beneath it in the middle, the timed readings stacked on the right.

```
**** COMMODORE 64 BASIC V2 ****
64K RAM SYSTEM  38911 BASIC BYTES FREE

LOAD"WEATHER 1.4.0",8,1

  18°C              ☁            ↑ 06:16
                                 ↓ 20:26
  HAMMEL, DK      17° | 18°      ≈ 13KM/H

READY.█
```

The right-hand column always carries `UP`, `DN` and `WIND`. `FEELS` is added
above 600px of height, and `HUM` above 1000px of width — `HUM` is the one row
that would otherwise push the column past the screen edge on an 840px slot.
Nothing is dropped at 840×344: the three columns fit that width with room over,
confirmed on the device.

The sprite follows the conditions: sun, moon, partly cloudy, overcast, fog,
drizzle, rain, snow and thunderstorm, each in its own palette colour, with the
sun swapped for a moon after sunset via the API's `is_day` flag.

### Themes

Seven, chosen from the widget's settings:

| Theme | Screen | First boot line |
|---|---|---|
| `c64` | light blue on blue | `**** COMMODORE 64 BASIC V2 ****` |
| `pet` | green phosphor on black | `*** COMMODORE BASIC 4.0 ***` |
| `bbc` | white on black, teletext accents | `BBC Computer 32K` |
| `cpc` | bright yellow on `#000088` blue | `Amstrad 64K Microcomputer  (v1)` |
| `spectrum` | black on `#d0d0d0` paper, grey border | `© 1982 Sinclair Research Ltd` |
| `amiga` | Kickstart 3.1 ROM screen — `#e9a888` on `#411040` | `3.1 ROM  40.063` |
| `modern` | system type, white and orange on black | none |

Each theme is a redefinition of the seven palette tokens plus a boot screen and
a cursor style — block, underline for the BBC's prompt, or none for Amiga and
Modern, which had no console conceit to keep. Changing theme (in settings, or
by tapping the widget) replays that machine's boot screen for two seconds
before handing over to the weather readout. `modern` additionally switches the
renderer from the 8×8 set to real system text, because there is no pixel font
for it to be faithful to.

**What is and is not authentic.** The palettes and the boot screens are the
faithful part: `boot` is each machine's real startup text, verbatim and at its
real length, and the widget's own line — the one carrying the version, e.g.
`LOAD"WEATHER 1.4.0",8,1` — is `load`, which on every one of these machines was
something the user typed, not something the ROM printed. Case follows the
machine: the C64 and the PET boot in their uppercase/graphics character set and
are folded to capitals, while the BBC, CPC, Spectrum and Amiga printed mixed
case and are rendered as written. What is **not** authentic is the font itself:
the letterforms in every pixel theme, uppercase, lowercase and the `©` sign
alike, are **this project's own hand-authored 8×8 set, not a ROM dump**.
Per-machine ROM fonts would be the next step in authenticity and are
deliberately not claimed here; `petscii.js` takes per-theme glyph overrides
(`PETSCII.setFont`) so they can be added a letterform at a time without
touching anything else.

The setting is a `combobox` rather than `tab-buttons` for two reasons: seven
options do not fit tab buttons, and iCUE's `TabButtonsEditorSetting.qml:33`
throws on every payload — see `TODO.md`.

## Claude Code Usage

Plan usage limits for Claude Code: the 5-hour session window and the weekly
window with their reset times, live lists of the sessions, workflows and
subtasks that are **running right now**, and an all-time view built from the
same rollup `/stats` prints.

A widget is a sandboxed web page and cannot read files, so `usage-server/`
serves what it needs on `127.0.0.1`. No credentials are read and nothing leaves
the machine — every number is derived from files Claude Code already writes
under `~/.claude`.

```bash
node usage-server/server.js   # http://127.0.0.1:41777/usage
```

The activity data is read from local files.

**The percentages are Anthropic's own**, and reach the feed two ways. The
preferred one costs no API request at all: Claude Code hands its statusline
script a `rate_limits` object, and `statusline-tee.js` wraps whatever statusline
you already run to save it. The fallback fetches the same figures from the
undocumented OAuth endpoint the `/usage` panel uses, which needs
`claude auth login` — and which is heavily throttled, so it is the backstop
rather than the main path. Either way the widget shows what the panel shows,
badged `LIVE`.

When neither answers, the widget falls back to locally measured token counts
rather than to a guess, and the badge switches to `LOCAL` with the reason in its
tooltip. It never falls back silently. Setup and the throttling story are in
[usage-server/README.md](usage-server/README.md#anthropics-own-figures).

Both windows get a bar, coloured by how close you are: blue, **amber from 80%**,
**red from 95%**. In `LOCAL` mode the session bar falls back to your busiest
recent 5-hour block and the weekly bar is hidden — a week has no honest local
reference to scale against.

**Each meter says which kind of number it is showing.** Anthropic can answer for
one window and not the other — Claude Code drops a window from `rate_limits`
once its reset passes, and restores it on the session's next API response. When
that happens the badge reads `LIVE¹` in amber and the meter without a figure is
marked `· measured`, so a percentage and a token count are never presented as
the same kind of number.

Nothing is estimated. A local estimate was tried and abandoned — no weighting of
local token counts reproduces Anthropic's accounting — and 1.8.0 removed the last
of it from the JSON, the debug page and the config. The arithmetic that killed it
is in [usage-server/README.md](usage-server/README.md).

For a full human-readable view — token breakdown per class, per-model split, and
the activity tables with their totals (`3 active of 24 seen`) — open
**<http://127.0.0.1:41777/usagehtml>**.

| Setting | Type | Default |
|---|---|---|
| `feedUrl` | text | `http://127.0.0.1:41777/usage` |
| `colorTheme` | tabs | `dark` / `light` |
| `refreshSeconds` | slider 5–120 | 10 |

**Tap the widget** to cycle five views: the usage bars, an activity view, a
token breakdown, all-time stats and tokens by model; a fifth tap returns to the
start. The
**Tokens** view carries
what the bars are drawn from — output, cache creation, cache read and input for
both windows with each class's share of the total, the weighted figure, and a
per-model table. On this account cache reads are ~98% of every window, which is
the single most useful thing the page says. This needs `"interactive": true` in the manifest, without which
iCUE never forwards touches to the page.

**The All time view** is a contribution heatmap over the whole recorded span
with eight headline figures beneath it — sessions, messages, active days,
current and longest streak, busiest day, top model and total tokens. It reads
the `stats` block the feed serves out of `~/.claude/stats-cache.json`.

The grid is laid out by **calendar date, not by array position**. The rollup
writes a row only for a day that had activity, so its entries are sparse — 92
rows across a 284-day span on this account — and packing them side by side
would draw a solid block with no quiet days in it and put every date in the
wrong column. Empty days are drawn as empty cells, so the shape you see is the
real history.

When the feed cannot read the rollup it serves `stats: {unavailable: "<reason>"}`
and the view prints that reason instead of drawing a grid. An empty heatmap
would read as months of silence rather than as a missing file, which is the one
failure this view must not have.

**The activity view shows only what is running** — not a history of what ran. A
session appears as soon as it is opened, and drops off 15 minutes after it last
did anything; a workflow and its subtasks appear while their agents are in
flight. Sessions are labelled with the prompt or slash command that started them,
prefixed by their project — the same slash command runs in several repos, so the
label alone does not say which one you are looking at.
Expect up to ~20s of lag in each direction: the feed re-indexes every 10s and the
widget polls every 10s, so a very short run can still begin and end unseen.

**The lists page themselves.** Each column that overflows advances one page
every five seconds and wraps at the end, so every row reaches the screen without
anyone touching the glass. The heading carries the count (`SESSIONS · 1 ACTIVE`,
or `WORKFLOWS · NONE ACTIVE` when idle) and, when there is more than one page, a
dot per page with the current one lit. The fade at the bottom edge means there
is more *below the page you are on*, so it goes out on the last one.

Page boundaries snap to row boundaries, so a row is never sliced across the
fold — the rows do not divide the box evenly (7.2 of them fit at 840×344), so
paging by a flat box-height step would cut one in half at every boundary.

> **The iCUE webview does not forward touch drags.** Measured on the device on
> 2026-08-30: a finger dragged across a list does not scroll it, the list simply
> stays put. Taps *are* forwarded, so tap-to-cycle works — a gesture counts as a
> tap only if the pointer moved less than 12px and was held under 700ms, and the
> drag test confirmed that gate does not misfire.
>
> This is why the lists page themselves rather than relying on `overflow-y:
> auto`. Before the pager, the Activity view showed 7 of up to 40 rows per
> column at 840×344 and the other 33 were unreachable by any means. **Do not
> design anything for this device that depends on a scrollable region being
> reachable by hand.**

## Task Queue

How much `/whattask` work is left across every repo on this machine, what is
holding a lock right now, and what has been finished. Same feed process as the
usage widget, on its own endpoint:

```bash
node usage-server/server.js   # http://127.0.0.1:41777/tasks
```

`/usage` is untouched by it — that contract is what the usage widget reads and
is deliberately frozen — and `/tasks?raw=1` adds the underlying run records for
debugging.

| Setting | Type | Default |
|---|---|---|
| `feedUrl` | text | `http://127.0.0.1:41777/tasks` |
| `colorTheme` | tabs | `dark` / `light` |
| `timeFormat` | combobox | `auto` / `12` / `24` |
| `refreshSeconds` | slider 5–120 | 15 |

**Tap the widget** to cycle five views: the queue, what is running, the run
history, the state of the task files, and one project's task list.

### Which repos it finds

Discovery reads the `projects` map in `~/.claude.json`, which carries real,
unmangled project paths. The per-project directory names under
`~/.claude/projects/` are **not** usable for this: the mangling replaces every
path separator with `-`, which is lossy against directory names that themselves
contain one, so `C--Users-mit-claude-c64server-tdz-c64-knowledge` cannot be
demangled back to a path unambiguously.

This replaced a one-level `readdirSync` of `~/claude` that `collectQueuedTasks()`
in the usage feed had been using. Measured: it found 3 of the 5 repos that have
queues and 88 of 210 open tasks, because two of them sit a level deeper under
`c64server/`. Both now read the same registry, so the two feeds cannot disagree
about which repos exist.

### Queue

Total open against closed with a completion meter, then a row per repo sorted by
open count. `requires-user` is called out on its own in the header — it is the
one figure on the view that asks something of whoever is reading the glass.

A repo whose `whattask.json` cannot be read is **listed with its reason**, not
dropped and not shown as zero, which would read as an empty queue rather than an
unreadable one.

### Running now

Two columns, counted separately and worded differently — `Holding a lock · 2
held` against `Claude activity · 3 active`. A `serial.lock` holder record and an
open Claude session are different claims about the machine, and a single summed
figure would assert something untrue.

The second column is why the view is worth having. `serial.lock` is the
*registry* of holder records, not the lock itself (that is the directory
`serial.lock.d/`, held for milliseconds around each update — see the mit-setup
`LOCKING.md`), and its resting state is `[]`. It is empty in all five repos
except while a `/runqueue` is mid-flight, so a view backed by holders alone
would be blank almost every time anyone looked at it. The sessions, workflows
and subtasks the usage feed already computes fill it the rest of the time.

### Runs

**No run record carries a timestamp.** Measured across four repos and 605 lines:
the key union is `id, head, model, effort, mode, lane, outcome, evidence,
verify_output, notes, opened, decision, runner` — and no date field anywhere.
`head` is a commit SHA, so each run is dated from the commit it names, and the
heading says **"Runs, by commit time"** rather than presenting it as when the run
happened. All 605 real records date cleanly, spanning 2026-08-08 to 2026-09-05.

One batched `git cat-file --batch` per repo, not one process per record: 62
lines in this repo name only 23 distinct commits. Heads are recorded
abbreviated while git echoes the full objectname, so requested names are matched
by prefix. A record whose SHA git no longer has is dropped **with a stated
count**, never dated wrongly.

The heatmap is laid out **by calendar date, not by array position** — the same
rule the usage widget's All time view carries, for the same reason: runs are
sparse in time (20 active days across a 29-day span here), and packing them side
by side would draw a solid block with every date in the wrong column.

**Two things the real corpus settled that one repo had not.** Outcomes are
**five** — `done` 453, `partial` 111, `blocked` 22, `failed` 10, `inconclusive`
9 — so the tally enumerates what it finds rather than a fixed pair. They are
drawn as one strip rather than five headline figures because nine `.fig` blocks
overflow the 840×344 slot by 46.6px; trimming to the two that fit would have
hidden 41 runs, so the layout changed instead of the data. And `model` is free
text, not an enumeration: 16 distinct values, 12 of them one-off sentences, one
reading `opus (recorded) / ran on Fable 5, which sits above Opus — substitution
stated before work began, not a downgrade`. Each is reduced to the family it
names, which collapses to sonnet 314, opus 283, fable 8.

### Task files

The state of the files `/whattask` and the run commands keep in
`.claude/tasks/` — `whattask.json`, `runs.jsonl`, `serial.lock`,
`decisions.jsonl` and `interview.json` — per repo, with sizes. **Absence is
real state**, drawn as a dash rather than a zero: `h2g` has no `serial.lock`
and `claude-setup` no `runs.jsonl`, and a zero would read as a file that exists
and is empty.

The point of the view is the alarm strip above the table, which carries two
faults the machine does not otherwise surface. Both tests come from the
mit-setup `LOCKING.md` rather than being invented here:

**An orphaned holder record.** A registry record in `serial.lock` outlives the
mutex by design — minutes or hours, while its task runs — so the common crash
is a session dying while holding one and no mutex at all. Nothing on the mutex
path ever notices, and every path that record names is refused for every later
run until someone reaps it. A record is an orphan when its `host` is this
machine **and** its `pid` is not running. **Age is deliberately not part of the
test**: a long task legitimately holds a record for hours, and the pid is the
only evidence that matters. A record from another host is reported as
*unknowable*, never as healthy — it cannot be checked from here.

This was not hypothetical. The first time the view ran against real data it
found `SIDM2` holding `sdi-control-rerun-at-j8` under a pid that was not
running, with eight paths refused behind it.

**A stale mutex.** `serial.lock.d/` is the actual lock — a directory, because
`mkdir` fails atomically if it exists. It is held for *milliseconds* around a
single registry update, so a feed polling every ten seconds will essentially
never catch it legitimately held; in practice this reports a stuck one. It is
stale only on proof: the `pid` is not running on this host **and** the recorded
`at` is more than **15 minutes** old. Neither alone is enough, and a live pid is
never called stale at any age — that is a hung run, which the view says instead.
A directory with no `owner` file in it is *held by someone still starting up*,
not stale, and is reported as exactly that.

### Projects

One project at a time, chosen by tapping its tab. The tabs run across the top,
one per repo with a queue; the selected one is filled rather than merely
outlined, because a border-only treatment is the first thing to disappear at
the distance this display is read from. More projects narrow the tabs rather
than pushing one off the edge — five fit at 840px today and that is not a
property worth depending on.

Underneath, that project's tasks — **open and closed alike**, ordered running,
queued, blocked, then done, so the top of the list is what is happening now and
the bottom is history. Blocked sits below queued because it is not actionable
by the runner — it is waiting on a person — which keeps the actionable half of
the list unbroken at the top. The heading counts open work only; folding the done rows
into one total would make the queue look larger than it is.

| State | Colour | Marker |
|---|---|---|
| running | green, at full weight — the one row saying what the machine is doing this second | `▶` |
| queued | body text | none |
| blocked | amber | `⚠` |
| done | receded to muted, its figures dimmer still | `✓` |

**Every state carries a marker as well as a colour.** This panel is read from
across a room and at an angle, where a hue difference is the first thing to go,
and colour on its own says nothing to a reader who cannot separate red from
green.

`running` is derived from `serial.lock`: a holder record names its task by the
same id the queue uses, verified against a real lock. A holder naming a task
the queue does not have adds no row — the lock is a claim about work, not a
source of it.

A queued row carries its mode, model and effort. Whatever decides what happens
to the task **next** displaces those, because the row has one line for it: the
blocking reason for a blocked one, and why it closed — or the commit that
closed it — for a done one.

**This list does not page itself**, unlike every other list here. The others
are short enough that a page or two covers them, so advancing them strands
nothing; this one runs to 162 rows and is meant to be read at the reader's own
pace. It keeps its `overflow-y`, so a wheel or trackpad reaches the rest in the
iCUE desktop dashboard. Note the measurement in the box above, though: **the
Edge webview forwards taps but not drags**, so on the panel itself this list
shows what fits and no more.

**A tap on a tab selects; a tap anywhere else still cycles the views.** The hit
is resolved with `elementFromPoint` rather than by trusting the event target —
the `pointerup` can be delivered on a different element from the `pointerdown`,
and a tab's text node is not the button.

**The task list is fetched separately**, at `/tasks?project=<name>`, and only
while this view is on screen. The five real queues hold 210 tasks across 297KB,
of which about 295KB is prose — `verify`, `why_model`, `why_lane`, `evidence` —
that no 840×344 slot can show at any size. Trimmed to what a row draws they are
still 49KB against the overview's 2.4KB, and the widget only ever looks at one
project at a time, so the overview stays small and this is pulled on demand.
Titles are capped at 90 characters and blocking reasons at 110; 90 is the
longest title that actually occurs.

### What the feed sends

The run history is **aggregated in the feed**, not shipped whole: the widget only
ever buckets it into daily counts and three tallies, so doing that once takes the
payload from 79KB to 2.4KB and stops the Edge's webview re-deriving the same
buckets every refresh.

Every unavailability is stated rather than rendered as absence — no repo with a
queue, a repo that cannot be read, history that cannot be dated. An empty grid
reads as months of silence rather than as a missing file, which is the one
failure these views must not have.

## Verifying a layout

Headless Chrome's `--window-size` does not mean the same thing in its two modes,
and the difference is large enough to invalidate a render silently.

| mode | `--window-size=840,344` gives | `--window-size=856,495` gives |
|---|---|---|
| `--dump-dom` | a page laid out at **824x193** | a page laid out at **840x344** |
| `--screenshot` | an **840x344** page and PNG | an 856x495 page and PNG |

In `--dump-dom` the flag is the window and Chrome subtracts its chrome; the
figures above were measured on this machine and are version-dependent, so
re-measure rather than copying them. In `--screenshot` the viewport is resized
to the full window just before capture — which is why `window.innerWidth` read
during the page's own load reports the smaller, pre-resize size and disagrees
with what is actually painted.

So a probe and a screenshot of the same layout need **different** flags. Have
the probe assert `window.innerWidth`/`innerHeight` are the slot size; a harness
that measures the wrong viewport reports confidently about a layout that was
never rendered.

Two more traps in the same place:

- **CSS transitions do not advance under `--virtual-time-budget`**, and
  `--force-prefers-reduced-motion` does not help. `getComputedStyle` then returns
  the colour a transitioning property had *before* the change — which made the
  usage widget's view indicator look stuck on the first dot when it was in fact
  correct. Inject `* { transition: none !important }` in the harness.
- An already-running Chrome on the default profile breaks bare `--headless`;
  always pass `--user-data-dir` pointing somewhere disposable.

Alternatively, host the widget in an exactly-sized iframe inside a larger window,
which is immune to all of the above:

```html
<iframe width="840" height="344" src="ClaudeUsage/index.html"></iframe>
```

```bash
chrome --headless=new --hide-scrollbars --virtual-time-budget=9000 \
       --window-size=1000,500 --screenshot=slot.png slot.html
```

The iframe gets the true slot viewport whatever the outer window does. Note that
`file://` iframes are cross-origin, so a parent page cannot click into one — put
any interaction script inside the widget page itself.

## Layout notes

Both widgets follow the same rules, which are what make them survive a 344px
slot and a 2536px one:

- One baseline variable (`--layout-unit`) drives every size; components consume
  semantic tokens, never raw viewport units.
- Layout changes come from CSS aspect-ratio media queries, not from JavaScript
  measuring the viewport.
- Vertical slots keep the 696×416 baseline, so a taller slot buys spacing and
  density rather than inflated text.
- When space runs out, elements are hidden outright rather than shrunk. The hero
  value — the temperature, the session percentage — is the last thing to go. The
  exception is the usage widget's activity lists, which page through their rows
  instead, because hiding a row there would put it out of reach entirely — and
  so would leaving it below a fold on a device that forwards no drags.
