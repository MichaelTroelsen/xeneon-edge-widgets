# Claude Code usage feed

Serves the JSON that the **Claude Code Usage** Xeneon Edge widget renders. An
iCUE widget is a sandboxed web page — it cannot read files or run commands — so
everything it shows has to arrive over HTTP.

```bash
node server.js
# Claude usage feed on http://127.0.0.1:41777/usage
```

Bound to `127.0.0.1` only. The activity data — sessions, workflows, subtasks,
token counts — is read from files Claude Code already writes under `~/.claude`
and never leaves the machine.

The two **usage percentages** are different: they are fetched from Anthropic
using your Claude Code OAuth token, because they cannot be derived locally. That
is the only outbound traffic, it goes only to `api.anthropic.com` and
`console.anthropic.com`, and it is optional — see [Authentication](#authentication).

## Where each number comes from

| Shown | Source | Exact or estimated |
|---|---|---|
| 5-hour reset time | `five_hour.resets_at` when authenticated | **exact** |
| ↳ fallback without auth | first local message of the block, floored to the hour, + 5h | **approximate — can be ~30 min out** |
| Weekly reset time | `seven_day.resets_at` when authenticated, otherwise the anchor in `limits.json` | exact when authenticated |
| Token counts per window | summed straight from the `usage` block of every assistant message | **exact** |
| 5-hour / weekly **percentage** | Anthropic's `/api/oauth/usage`, needs [authentication](#authentication) | **exact — the same numbers as Claude Code's own panel** |
| Plan label, e.g. `Max (5x)` | `/api/oauth/profile` → `rate_limit_tier` | exact when authenticated |
| *(legacy)* locally estimated percentage | weighted totals ÷ budgets in `limits.json` | **unreliable, no longer shown — see below** |
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

**It is undocumented and may vanish.** Treat the measured path as the one that is
guaranteed to keep working.

## Authentication

### Setting it up

One command, once:

```
claude auth login
```

That writes `~/.claude/.credentials.json` with a token carrying the five scopes
Claude Code uses, including the **`user:profile`** scope this endpoint requires.
The server notices the file being written and picks it up within a second — no
restart, no configuration, nothing to paste anywhere.

You can tell which mode you are in from the widget's header badge:

| Badge | Meaning |
|---|---|
| `LIVE` (green) | percentages are Anthropic's own, freshly fetched |
| `LIVE·` (amber) | Anthropic's numbers, but the last poll failed — showing the most recent good reading, up to 30 minutes old. Hover for when and why |
| `LOCAL` (grey) | no usable reading; measured token counts shown instead. Hover for the reason |

Skipping this entirely is a valid choice. Everything except the two percentages
works without any credential.

### What the server does with the token

- Reads it from `~/.claude/.credentials.json` into memory.
- Sends it as one `Authorization: Bearer` header per request, only to
  `api.anthropic.com` (usage, profile) and `console.anthropic.com` (refresh).
- **Never** logs it, prints it, or includes it in `/usage`'s output. The served
  payload is scanned for `accessToken`, `refreshToken`, `Bearer` and `sk-ant` as
  part of testing.
- Polls **every twelve minutes**, not every rebuild. One-minute polling drew a
  `429` within the hour. The budget is also **shared across everything on the
  machine using your account** — the AI Limits Stream Deck plugin polls the same
  endpoint every two minutes, and when both were running they throttled each
  other. If you run another usage tool, count its polling too.
- Backs off on failure: exponentially to 30 minutes normally, starting at 15
  minutes for a `429` since that one is explicitly about request volume.
- Keeps the last successful reading. If a poll fails, the widget keeps showing
  those percentages marked stale for up to 30 minutes rather than swapping to a
  different metric — utilisation only climbs within a window and the reset times
  are absolute, so a few-minute-old figure is still the right answer. The cache
  is in memory, so a server restart during an outage falls back to `LOCAL` until
  the next successful poll.

### Staying authenticated

The access token lasts about eight hours, and Claude Code does not reliably
rewrite the credentials file when it refreshes — so without help the live path
would die the same evening you set it up.

The server therefore refreshes the token itself, a minute before expiry:

```
POST https://console.anthropic.com/v1/oauth/token
{ "grant_type": "refresh_token", "refresh_token": "…",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }
```

The response contains a **new refresh token** — refreshing rotates it — so the
result is written back to the same file Claude Code reads. Without that
write-back, Claude Code's copy would become the stale one. The write is atomic
(temp file, then rename) and a one-time backup is kept at
`.credentials.json.before-usage-server`.

> Claude Code and the server share one rotating credential. If Claude Code
> refreshes in memory without persisting, its rotation can invalidate the copy on
> disk and the badge drops to `LOCAL`. Another `claude auth login` restores it.

### Troubleshooting

| Error in `official.error` | What it means | Fix |
|---|---|---|
| `HTTP 401` / `access token expired` | the stored token is stale | usually self-heals via refresh; otherwise `claude auth login` |
| `Refresh token not found or invalid` | the refresh token was rotated away by Claude Code and never persisted | `claude auth login` — nothing can recover from this automatically |
| `HTTP 403 — …scope requirement user:profile` | a token without the profile scope was used, e.g. from `setup-token` | `claude auth login` |
| `HTTP 429 — Rate limited` | too many requests; about the caller, not the credential | wait — the backoff clears it |
| `no token: neither … nor CLAUDE_CODE_OAUTH_TOKEN` | never authenticated | `claude auth login` |

Read the current state at any time on the [debug page](#endpoints),
`http://127.0.0.1:41777/usagehtml`.

### What does not work

Two plausible shortcuts, both tested and both dead ends:

- **`CLAUDE_CODE_OAUTH_TOKEN`** (from `claude setup-token`) — long-lived, but
  inference-scoped. The endpoint rejects it: `HTTP 403 — OAuth token does not
  meet scope requirement user:profile`, and `setup-token` offers no way to
  request other scopes. The server still tries it as a fallback, so a
  profile-scoped token would be picked up automatically.
- **`CLAUDE_CODE_API_KEY` / any `sk-ant-api…` key** — rejected as
  `HTTP 401 Invalid bearer token`; the same key returns `200` on `/v1/models`,
  so the key is valid and simply the wrong credential type. It also measures the
  wrong thing: an API key bills pay-per-token against your organisation's API
  account, while these percentages are your **subscription** limits.

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
