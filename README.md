# iCUE widgets for the CORSAIR Xeneon Edge

Two HTML widgets for the Xeneon Edge dashboard display, plus the local feed one
of them needs. Both target `dashboard_lcd` and adapt across every Edge slot
size in both orientations.

Build and install with the [iCUE Widget CLI](https://www.corsair.com/us/en/s/downloads):

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
