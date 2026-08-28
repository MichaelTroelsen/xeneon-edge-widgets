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

### Done

- [x] **Calibrated the budgets** on 2026-08-28 against the real usage panel,
      using `/usage?at=<timestamp>` to get a same-moment comparison. Session
      54M, weekly 178M standard with the +50% promotional boost declared
      separately so it expires on its own.
- [x] **Autostart.** `ClaudeUsageFeed` scheduled task runs `start-hidden.vbs`
      at logon; verified by killing the server and letting the task restart it
      with no console window.

### Open

- [ ] **Confirm the weekly anchor.** Thu 21:00 local, taken from the usage
      panel. Verify against a real weekly reset.
- [ ] **Re-check the calibration after August 31**, when the +50% weekly boost
      ends. The expiry is already in `limits.json`, so this is a verification
      rather than a change.
- [ ] **The Fable weekly bar is not calibrated** — there was no Fable usage to
      compare against, so its budget is only scaled from the old guess.
- [ ] **Lists are hidden at 840x344.** Both widgets sit in that slot. Showing
      workflows there needs a decision about what to drop — probably the Fable
      bar and the reset captions.

## Both widgets

- [ ] **tab-buttons throws in iCUE's settings panel:**
      `TabButtonsEditorSetting.qml:33: TypeError: Property 'rowCount' of object
      [object Object],[object Object],[object Object] is not a function`. Fires
      for C64 Weather's `tempUnit` and the usage widget's `colorTheme`. It is in
      iCUE's own QML, so it may be their bug rather than a malformed
      `data-values` — not yet investigated.
