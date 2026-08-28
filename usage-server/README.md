# Claude Code usage feed

Serves the JSON that the **Claude Code Usage** Xeneon Edge widget renders. An
iCUE widget is a sandboxed web page — it cannot read files or run commands — so
everything it shows has to arrive over HTTP.

```bash
node server.js
# Claude usage feed on http://127.0.0.1:41777/usage
```

Bound to `127.0.0.1` only. No credentials are read and nothing leaves the
machine; every number comes from files Claude Code already writes under
`~/.claude`.

## Where each number comes from

| Shown | Source | Exact or estimated |
|---|---|---|
| 5-hour reset time | first message of the current block, floored to the hour, + 5h | **exact** |
| Weekly reset time | the weekly anchor in `limits.json` (default Thu 21:00 local) | exact once the anchor is right |
| 5-hour / weekly percentage | weighted token totals from `~/.claude/projects/**/*.jsonl` ÷ the budgets in `limits.json` | **estimated** |
| Workflow list | `~/.claude/projects/*/*/workflows/wf_*.json` | exact |
| Subtask list | the `workflow_agent` entries inside those files, falling back to open tasks in each repo's `.claude/tasks/whattask.json` | exact |

The widget carries a permanent `EST` badge because of row 3.

### Why the percentage is an estimate

Anthropic does not publish the plan limits, and there is no local record of your
consumption against them. `quotaLimits` only appears in a transcript once you
have *already* been rate-limited, and there is no `claude usage` subcommand.
So the server measures what you actually spent — every assistant message carries
a full `usage` block — and divides by a budget you set.

Weighted tokens are `output×5 + input×1 + cache_creation×1.25 + cache_read×0.1`,
then multiplied per model. Both tables live in `limits.json`.

## Calibrating

The shipped budgets were calibrated on 2026-08-28 against Claude Code's own
usage panel. To redo it when the numbers drift:

1. Open `/usage` in Claude Code. Note both percentages **and the session reset
   countdown** — that countdown is what pins the reading to a moment in time.
2. Work out the moment: `session reset time − countdown`. With a 21:00 reset and
   "Resets in 4 hr 43 min", the panel was showing 16:17.
3. Ask this server what it would have said then, and take the raw totals rather
   than the rounded percentages:
   ```bash
   curl "http://127.0.0.1:41777/usage?at=2026-08-28T16:17:00"
   ```
   Read `session.usedWeighted` and `weekly.usedWeighted`.
4. Divide by the panel's fractions:
   ```
   sessionBudgetWeightedTokens = session.usedWeighted / 0.06
   weeklyBudgetWeightedTokens  = weekly.usedWeighted  / 0.10
   ```
5. Put the results in `limits.json` and re-query the same `?at=` — it should now
   reproduce the panel's percentages exactly. That round-trip is the check that
   the calibration actually landed.

`limits.json` is re-read on every refresh, so no restart is needed.

### Temporary limit boosts

Anthropic runs promotions ("your weekly limit is 50% higher through August
31"). Calibrating against a boosted week and then forgetting makes every later
week read high, so declare the boost with an expiry instead of folding it into
the budget:

```json
"weeklyBudgetWeightedTokens": 178000000,
"weeklyBoost": { "multiplier": 1.5, "until": "2026-09-01T00:00:00" }
```

`weeklyBudgetWeightedTokens` is then the **standard** limit, and the multiplier
applies only while the promotion is live. Step 4 above gives you the boosted
figure, so divide it by the multiplier to get the standard one.

### The weekly anchor

The default is Thursday 21:00 local, matching the usage panel. If yours resets
on another day set `weekday` (0 = Sunday) and `hour`.

## Endpoints

- `GET /usage` — the full snapshot
- `GET /usage?at=<epoch-ms | ISO timestamp>` — the snapshot as it would have
  been at that moment, rebuilt on demand and never cached. Windows are capped at
  the given time, so it does not count usage from after it. This is what makes
  calibration against a timestamped screenshot possible.
- `GET /health` — liveness plus the last build time

## Cost

The index is incremental: a file is only re-parsed from the byte offset where it
last ended. On the machine it was developed on, the cold build took 389 ms over
10,411 messages and subsequent rebuilds 42 ms. It refreshes every 20 s.

## Running it in the background

The widget shows an actionable error state whenever the feed is down, so a
missed start is obvious rather than silent. To start it with Windows, point a
Task Scheduler entry at:

```
node <path-to-this-repo>\usage-server\server.js
```
