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

## Calibrating (once, ~2 minutes)

The default budgets are guesses. To make the bars match what `/usage` reports:

1. Run `/usage` in Claude Code and note the **session** percentage.
2. `curl http://127.0.0.1:41777/usage` and note the session percentage.
3. Scale the budget by the ratio:
   `new = sessionBudgetWeightedTokens × (mine ÷ theirs)`
4. Repeat for `weeklyBudgetWeightedTokens`.

`limits.json` is re-read on every refresh, so no restart is needed.

Also check `weeklyAnchor` — the default is Thursday 21:00 local because that is
what the usage panel showed. If yours resets on another day, set `weekday`
(0 = Sunday) and `hour` to match.

## Endpoints

- `GET /usage` — the full snapshot
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
