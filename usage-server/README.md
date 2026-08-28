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
| Token counts per window | summed straight from the `usage` block of every assistant message | **exact** |
| 5-hour / weekly percentage | weighted totals ÷ the budgets in `limits.json` | **unreliable — see below** |
| Session list | transcripts directly under `~/.claude/projects/<project>/`, as opposed to the nested ones belonging to subagents and workflows | exact |
| Workflow list | `~/.claude/projects/*/*/workflows/wf_*.json` | exact |
| Subtask list | the `workflow_agent` entries inside those files, falling back to open tasks in each repo's `.claude/tasks/whattask.json` | exact |

A session counts as `running` if it produced a message in the last 15 minutes.
Its label comes from the first user message — usually a slash command, otherwise
the opening words of the prompt. The `slug` some transcripts carry is absent from
most of them and a UUID says nothing, so the first message is the only label that
names every session.

## Anthropic's own figures

The numbers Claude Code's `/usage` panel shows come from an **undocumented**
OAuth endpoint, and the server now reads them directly:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <token from ~/.claude/.credentials.json>
anthropic-beta: oauth-2025-04-20
```

```json
{
  "five_hour":        { "utilization": 33.0, "resets_at": "…" },
  "seven_day":        { "utilization": 13.0, "resets_at": "…" },
  "seven_day_opus":   null,
  "seven_day_sonnet": { "utilization": 2.0,  "resets_at": "…" },
  "extra_usage":      { "is_enabled": true, "monthly_limit": 1000, "used_credits": 0.0 }
}
```

`five_hour.utilization` and `seven_day.utilization` are exactly the panel's two
percentages, and the `seven_day_*` keys are its per-model rows. `/api/oauth/profile`
returns `organization.rate_limit_tier`, which is where `Max (5x)` comes from
instead of being hardcoded.

This is the same approach as
[jens-duttke/usage-monitor-for-claude](https://github.com/jens-duttke/usage-monitor-for-claude),
which documents the response shape.

**Handling of the token.** It is read from `~/.claude/.credentials.json` into
memory, used for one `Authorization` header per request, and never logged,
written anywhere, or included in `/usage`'s output. Requests go only to
`api.anthropic.com`. The endpoint is polled once a minute regardless of how often
the index rebuilds.

**When it fails, nothing breaks.** Every error is non-fatal: `official.ok` goes
false with the reason, and the widget falls back to the measured token counts.
The common failure is an expired access token — Claude Code does not always
rewrite the credentials file when it refreshes, and a stale file gives `HTTP 401`.
It recovers on its own the next time Claude Code writes the file.

**It is undocumented and may vanish.** Treat the measured path as the one that is
guaranteed to keep working.

### Why the local estimate was abandoned

It is still in the JSON, and the debug page still shows it, but **the widget
stopped displaying it in 1.3.0** and you should not rely on it.

Calibrated at 16:17 on 2026-08-28 it matched Claude's own panel exactly, 6% vs
6%. Eighty minutes later it read 47% against the panel's 27%. The token mix had
barely moved — ~84% cache reads and Opus-only in both windows — so this is not a
mix effect.

The arithmetic rules out fixing it by re-weighting. Between those two windows the
measured growth per class was:

| Class | Growth |
|---|---|
| input | 4.28× |
| output | 5.40× |
| cache read | 6.88× |
| cache creation | 9.18× |

The panel charged the second window 21 points against the first's 6 — a growth of
3.5×, or 3.08–4.00× allowing for rounding. A weighted sum can only grow somewhere
between its slowest and fastest component, so the least this model can report is
4.28× — above the 4.00× ceiling. **No non-negative weighting of these token
counts can reproduce Anthropic's accounting.** The model is structurally wrong,
not mis-parameterised.

What that leaves unexplained is what Anthropic actually counts. Cache reads
charged far below their token count, a per-request component that does not scale
with tokens, a non-linear curve, and reporting lag in the panel are all
consistent with the data; two readings cannot distinguish them.

Everything else the server reports is measured, so the widget now shows token
counts, message counts and the reset times, with the bar scaled against your own
busiest recent block rather than against a limit nobody publishes.

### How the estimate was meant to work

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
- `GET /usagehtml` — **a human-readable debug page**: both windows with their
  full token breakdown and per-model split, every session, workflow and subtask
  as a table, and the config actually in force. An addition alongside `/usage`,
  which is unchanged and remains what the widget reads. Self-refreshes every 30s.

## Cost

The index is incremental: a file is only re-parsed from the byte offset where it
last ended. On the machine it was developed on, a cold build takes about 480 ms
over ~10,600 messages; incremental rebuilds are far cheaper. It refreshes every
20 s.

## Running it at logon

`start-hidden.vbs` launches the server with no console window, and a Task
Scheduler entry runs it at sign-in. Register it once:

```powershell
$vbs = "<path-to-this-repo>\usage-server\start-hidden.vbs"
$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -StartWhenAvailable `
              -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
              -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "ClaudeUsageFeed" -Action $action `
  -Trigger $trigger -Settings $settings -Force
```

`ExecutionTimeLimit` must be zero — the default three-day cap would otherwise
kill a long-running server. `MultipleInstances IgnoreNew` stops a second copy
fighting for the port if the task is triggered again.

The wrapper exists because Task Scheduler's "Hidden" setting hides the *task*,
not the window: pointing the trigger straight at `node.exe` flashes a console on
every sign-in. `wscript` with window style 0 avoids that. The script derives its
paths from its own location, so moving the repo does not break the task.

Useful commands:

```powershell
Start-ScheduledTask   -TaskName ClaudeUsageFeed   # start now
Get-ScheduledTaskInfo -TaskName ClaudeUsageFeed   # last run time and result
Unregister-ScheduledTask -TaskName ClaudeUsageFeed -Confirm:$false
```

To stop the server without removing the task:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*usage-server*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

If it is ever down, the widget says so with the command to start it, rather than
showing stale numbers as if they were current.

### Running it manually instead

```
node <path-to-this-repo>\usage-server\server.js
```
