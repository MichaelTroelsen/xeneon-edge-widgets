# iCUE widgets — TODO

## C64 Weather

### Done in 1.1.0

- [x] **Sunrise / sunset.** `sunrise,sunset` added to the `daily=` request. Rendered
      as `UP 06:07  DN 20:14`, taken as an `HH:MM` substring of the ISO string —
      `timezone=auto` already returns it in the location's own timezone, so
      parsing it into a `Date` would re-shift it into ours.
- [x] **Wind speed.** Now rendered, and follows the temperature unit: `22KM/H`
      alongside °C, `14MPH` alongside °F.
- [x] **Max / min temperature.** `HI`/`LO` promoted to every slot at least 400px
      tall, so S-V and M-H now show them; only S-H (344px) still omits them.

The one growing detail string was replaced by two rows of independent chips,
each shown or hidden on its own:

| Slot | Detail shown |
|---|---|
| S-H 840x344 | none — hide, don't shrink |
| S-V 696x416 | `HI` `LO` |
| M-H 840x696, M-V, L-H | `HI` `LO` `FEELS` / `WIND` `UP` `DN` |
| L-H, XL-H, L-V, XL-V (≥1000px wide) | the above plus `HUM` |

Humidity is width-gated because on an 840px slot the condition row would
otherwise run past the screen edge.

### Open

- [ ] Nothing outstanding.

## Claude Code Usage

- [ ] **Calibrate the budgets.** `usage-server/limits.json` ships with guessed
      `sessionBudgetWeightedTokens` / `weeklyBudgetWeightedTokens`, so the bars
      are proportionally right but absolutely off. Compare once against `/usage`
      and scale — procedure in `usage-server/README.md`.
- [ ] **Confirm the weekly anchor.** Defaults to Thu 21:00 local, taken from the
      usage panel screenshot. Verify against a real weekly reset.
- [ ] **Autostart the feed.** The widget shows an actionable error when the feed
      is down, but a Task Scheduler entry would avoid the manual start.
