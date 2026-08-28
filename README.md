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
| `cityName` | text | `Copenhagen` — city name or `lat,lon` |
| `tempUnit` | tabs | `auto` (follows iCUE) / C / F |
| `refreshMinutes` | slider 5–120 | 15 |

Detail shown per slot, largest first: `HI LO FEELS` and `WIND HUM UP DN`, down
to `HI LO` on 696×416, down to nothing on 840×344 — hide, don't shrink.

## Claude Code Usage

Plan usage limits for Claude Code: the 5-hour session window and the weekly
window with their reset times, plus live lists of recent workflows and their
subtasks.

A widget is a sandboxed web page and cannot read files, so `usage-server/`
serves what it needs on `127.0.0.1`. No credentials are read and nothing leaves
the machine — every number is derived from files Claude Code already writes
under `~/.claude`.

```bash
node usage-server/server.js   # http://127.0.0.1:41777/usage
```

Reset times are exact. **The percentages are estimates** — Anthropic does not
publish the plan limits, so the server divides measured token usage by a budget
you calibrate once. The widget carries a permanent `EST` badge for that reason.
See [usage-server/README.md](usage-server/README.md).

| Setting | Type | Default |
|---|---|---|
| `feedUrl` | text | `http://127.0.0.1:41777/usage` |
| `colorTheme` | tabs | `dark` / `light` |
| `refreshSeconds` | slider 5–120 | 20 |

## Layout notes

Both widgets follow the same rules, which are what make them survive a 344px
slot and a 2536px one:

- One baseline variable (`--layout-unit`) drives every size; components consume
  semantic tokens, never raw viewport units.
- Layout changes come from CSS aspect-ratio media queries, not from JavaScript
  measuring the viewport.
- Vertical slots keep the 696×416 baseline, so a taller slot buys spacing and
  density rather than inflated text.
- When space runs out, elements are hidden outright. The hero value — the
  temperature, the session percentage — is the last thing to go.
