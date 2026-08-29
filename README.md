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
**** COMMODORE 64 WEATHER V1.2.0 ****
LOAD"WEATHER",8,1

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

| Theme | Screen | Boot line |
|---|---|---|
| `c64` | light blue on blue | `**** COMMODORE 64 WEATHER V1.3.0 ****` |
| `pet` | green phosphor on black | `*** COMMODORE WEATHER BASIC ***` |
| `bbc` | white on black, teletext accents | `BBC COMPUTER 32K` |
| `cpc` | bright yellow on blue | `AMSTRAD 64K MICROCOMPUTER  (V1)` |
| `spectrum` | black on white, grey border | `(C) 1982 SINCLAIR RESEARCH LTD` |
| `amiga` | white on Workbench blue, orange accents | `WORKBENCH RELEASE 1.3` |
| `modern` | system type, white and orange on black | none |

Each theme is a redefinition of the seven palette tokens plus a boot screen and
a cursor style — block, underline for the BBC's prompt, or none for Amiga and
Modern, which had no console conceit to keep. `modern` additionally switches the
renderer from the 8×8 set to real system text, because there is no pixel font
for it to be faithful to.

**What is and is not authentic.** The palettes and the screen furniture are the
faithful part. The boot lines are a homage in the same spirit as the original
C64 one — they say WEATHER where the real machine said BASIC — and the
letterforms in every pixel theme are **this project's own hand-authored 8×8
set, not a ROM dump**. Per-machine ROM fonts would be the next step in
authenticity and are deliberately not claimed here; `petscii.js` takes per-theme
glyph overrides (`PETSCII.setFont`) so they can be added a letterform at a time
without touching anything else.

The setting is a `combobox` rather than `tab-buttons` for two reasons: seven
options do not fit tab buttons, and iCUE's `TabButtonsEditorSetting.qml:33`
throws on every payload — see `TODO.md`.

## Claude Code Usage

Plan usage limits for Claude Code: the 5-hour session window and the weekly
window with their reset times, plus live lists of the sessions, workflows and
subtasks that are **running right now**.

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

**Tap the widget** to cycle three views: the usage bars, an activity view, and
a token breakdown; a third tap returns to the start. The **Tokens** view carries
what the bars are drawn from — output, cache creation, cache read and input for
both windows with each class's share of the total, the weighted figure, and a
per-model table. On this account cache reads are ~98% of every window, which is
the single most useful thing the page says. This needs `"interactive": true` in the manifest, without which
iCUE never forwards touches to the page.

**The activity view shows only what is running** — not a history of what ran. A
session appears as soon as it is opened, and drops off 15 minutes after it last
did anything; a workflow and its subtasks appear while their agents are in
flight. Sessions are labelled with the prompt or slash command that started them,
prefixed by their project — the same slash command runs in several repos, so the
label alone does not say which one you are looking at.
Expect up to ~20s of lag in each direction: the feed re-indexes every 10s and the
widget polls every 10s, so a very short run can still begin and end unseen.

**The lists scroll.** Each column scrolls independently, the heading carries the
count (`SESSIONS · 1 ACTIVE`, or `WORKFLOWS · NONE ACTIVE` when idle) and a fade
marks a list with more below. A gesture only counts as a tap if the pointer moved
less than 12px and was held under 700ms, so scrolling does not flip the view.

> Whether the iCUE webview forwards touch *drags* to the page is not documented —
> `interactive` is described only as enabling click handling. Scrolling is
> verified in a browser; if a drag does nothing on the device, the fallback is to
> page the lists automatically on a timer.

## Verifying a layout

Headless Chrome's `--window-size` includes window chrome, so `--window-size=840,344`
lays the page out at **824x249** — 95px shorter than the slot. Screenshots taken
that way silently test the wrong dimensions.

Host the widget in an exactly-sized iframe inside a larger window instead:

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
  exception is the usage widget's activity lists, which scroll instead, because
  hiding a row there would put it out of reach entirely.
