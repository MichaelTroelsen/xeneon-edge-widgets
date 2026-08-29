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

The two **usage percentages** cannot be derived locally, so they come from
Anthropic — by two routes. The preferred one reads them from what Claude Code
already hands its statusline script, which makes **no request at all**. The
fallback fetches them with your OAuth token, and is the only outbound traffic
there is: only to `api.anthropic.com` and `console.anthropic.com`, and optional.
See [Anthropic's own figures](#anthropics-own-figures) and
[Authentication](#authentication).

## Where each number comes from

| Shown | Source | Exactness |
|---|---|---|
| 5-hour reset time | `five_hour.resets_at` when authenticated | **exact** |
| ↳ fallback without auth | first local message of the block, floored to the hour, + 5h | **approximate — can be ~30 min out** |
| Weekly reset time | `seven_day.resets_at` when authenticated, otherwise the anchor in `limits.json` | exact when authenticated |
| Token counts per window | summed straight from the `usage` block of every assistant message | **exact** |
| 5-hour / weekly **percentage** | Claude Code's statusline `rate_limits`, or Anthropic's `/api/oauth/usage` — see [below](#anthropics-own-figures) | **exact — the same numbers as Claude Code's own panel** |
| Plan label, e.g. `Max (5x)` | `/api/oauth/profile` → `rate_limit_tier` | exact when authenticated |
| Session list | transcripts directly under `~/.claude/projects/<project>/`, as opposed to the nested ones belonging to subagents and workflows | exact |
| Workflow list | running: `~/.claude/projects/*/*/subagents/workflows/wf_*/journal.jsonl` | exact |
| Subtask list | running: the agents in that journal with a `started` line and no `result` | exact |

A session counts as `running` if it produced a message in the last 15 minutes,
**or** if its transcript was written that recently even with no message in it
at all. The second half matters more than it sounds: a session that has just
been opened contains only startup bookkeeping — `mode`, `permission-mode`, an
attachment or two — and no user or assistant message, so requiring a counted
message hid it until its first exchange had finished. Until that exchange it
shows its short id (`0abb6d2c`) and a message count of 0.

Its label is then the first user message — usually a slash command, otherwise
the opening words of the prompt. The `slug` some transcripts carry is absent
from most of them and a UUID says nothing, so the first message is the only
label that names every session.

### The lists show what is running, not what has run

They used to show everything from the last seven days, which on an idle machine
meant twenty sessions, eighteen finished workflows and twenty-three finished
subtasks — a busy-looking panel describing nothing that was happening.

The live source is **not** `wf_*.json`. That file is written when a run *ends*,
so a filter that reads its `status` can never match a run in flight; the first
attempt at this did exactly that and the widget sat empty through a whole
60-second probe run. What exists while a run is going is its transcript
directory:

```
subagents/workflows/wf_<runId>/
  journal.jsonl          {"type":"started",…} per agent, {"type":"result",…} when it ends
  agent-<id>.jsonl       the agent's messages; the first is its prompt
  agent-<id>.meta.json   {"agentType","spawnDepth","model"}
```

An agent with a `started` line and no `result` is running, and a run with any
such agent is running. A killed run would otherwise advertise itself as live
forever, so the directory must also have been touched within 15 minutes.

Two labelling limits follow from what is actually on disk. A subtask row is
named by the **first line of the agent's prompt** — a workflow's `opts.label`
names the row in `/workflows` but is never written to disk, so it cannot name
anything here. And a workflow is named from the script file in the session's
`workflows/scripts/`; a run launched from a script kept elsewhere (this repo's
`test/` directory, say) falls back to its short run id, as in `wf f354826c-6c2`.

Queued `whattask.json` tasks are deliberately **not** shown as subtasks. Waiting
to start is not running. The count is reported instead, so an empty list reads
`Nothing running · 86 queued`.

Two tests cover this, because they catch different things.

```bash
node usage-server/test/live-detection.test.js
```

runs in a couple of seconds and needs nothing but node. It points the server at
a fixture tree via `CLAUDE_USAGE_PROJECTS_DIR` (unset in normal use) and asserts
the cases that were got wrong or could be: a run in flight is reported, a
finished one is not despite its `wf_*.json` existing, a killed run gone stale is
not, a partly finished run reports only its unfinished agents, and an errored
agent counts as finished, plus the session cases: a just-opened session with no
messages yet is reported, an old idle one is not, and a transcript nested under
a session directory belongs to a subagent rather than being a session. Seventeen
checks. Reverting the live-run lookup fails 9 of them and reverting the
just-opened-session rule fails 3 more, which is the point of having them.

The end-to-end probe needs an agent runner and real tokens, so it is the one you
run when changing how the widget renders rather than after every edit. Launch
`test/activity-probe.workflow.js` with the Workflow tool (`args: {agents, seconds}`)
and run `node usage-server/test/activity-probe-check.js` alongside it: the probe
makes N subtasks that genuinely block for S seconds, and the checker watches the
feed and fails if the lists never reported them. Allow ~40 seconds for work to
appear and the same for it to clear — the server re-indexes every 20s and the
widget polls every 20s, so a run shorter than that can finish unseen.

## Anthropic's own figures

The same figures reach this server two ways. They fail in opposite conditions,
so the snapshot takes whichever answered most recently and the widget shows
`LIVE` either way. `official.source` in `/usage` says which one you are looking
at.

### 1. The statusline (no request, preferred)

Claude Code hands its statusline script a JSON object on stdin, and since
**v2.1.80** that object carries `rate_limits` — the five-hour and seven-day
windows, already fetched by Claude Code itself:

```json
"rate_limits": {
  "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
}
```

`statusline-tee.js` wraps whatever statusline you already run: it saves those
figures to `~/.claude/statusline-usage.json` and passes stdin through to the
real command unchanged, so your status bar is unaffected. Point
`statusLine.command` in `~/.claude/settings.json` at it, with your existing
command as the arguments:

```json
"statusLine": {
  "type": "command",
  "command": "node <repo>/usage-server/statusline-tee.js npx -y ccstatusline@latest",
  "padding": 0
}
```

This costs **zero API requests**, so it cannot be rate-limited. Its limits are
the ones the [statusline
docs](https://code.claude.com/docs/en/statusline) state: the field appears only
for Pro/Max subscribers, only after the session's first API response, each
window can be absent independently, and a window disappears once its
`resets_at` passes. The practical one is that nothing updates it while no
Claude Code session is open — so `statusline.js` shows a reading as current for
10 minutes, degrades it to stale after that, and stops serving it entirely at
45 minutes rather than presenting an undercount as live.

### 2. The OAuth endpoint (a request, and heavily throttled)

The numbers Claude Code's `/usage` panel shows come from an **undocumented**
OAuth endpoint, which the server also reads directly:

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
| `LIVE·` (amber) | Anthropic's numbers, but the last poll failed — showing the most recent good reading, up to 45 minutes old. Hover for when and why |
| `LIVE¹` (amber) | Anthropic answered for only one of the two windows — Claude Code drops a window from `rate_limits` once its `resets_at` passes and restores it on the session's next API response. The meter without a figure is marked `· measured` |
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
  `429` within the hour. Be aware that no polite cadence necessarily fixes this:
  [anthropics/claude-code#30930](https://github.com/anthropics/claude-code/issues/30930)
  (open) reports persistent 429s with `retry-after: 0` on this endpoint for Max
  users at 30s/60s/120s, #31637 reports 10-minute polling throttled within the
  hour and 30-minute backoff still failing for hours, and #31055 reports a 429
  after a *single* request. That is why the statusline path above is preferred
  and this one is the backstop, not the reverse. The budget is also **shared across everything on the
  machine using your account**, and there is usually more of that than you
  expect: this machine had **four** Stream Deck plugins calling the same
  `/api/oauth/usage` endpoint (`com.singerous.ai-limits`,
  `kr.co.postgresql.ai-limits`, `com.len.limits`, `com.lloyds.headroom`).
  Polling interval is the smaller half of the problem. One of them retried
  immediately on failure with no backoff, which turned a single `429` into
  roughly **45 requests per second** — ~11,700 in the six minutes after a
  reboot, counted from its own log, rising to ~140/s later — and kept the
  window open indefinitely. A client without backoff can hold an account
  throttled by itself. So when you run another usage tool, count its polling
  interval *and* check what it does when a request fails.
- **Removing a plugin's buttons from your profile is not enough**, and neither
  is killing its process. Some plugins do go quiet when their actions are
  removed, but `kr.co.postgresql.ai-limits` resumed at full rate afterwards,
  and killing its node process only made Stream Deck respawn it and restart
  the loop from zero. What actually stopped it was uninstalling the plugin, so
  that its folder left `%APPDATA%\Elgato\StreamDeck\Plugins\`. The process
  list is not how you tell whether one is active — the process stays resident
  either way. Use the plugin's own log under that folder, or, for a plugin
  that keeps no log, sample its outbound connections by PID.
- Backs off on failure: exponentially to 30 minutes normally, starting at 15
  minutes for a `429` since that one is explicitly about request volume.
- Keeps the last successful reading. If a poll fails, the widget keeps showing
  those percentages marked stale for up to 45 minutes rather than swapping to a
  different metric — utilisation only climbs within a window and the reset times
  are absolute, so a few-minute-old figure is still the right answer. The cache
  is in memory, so a server restart during an outage falls back to `LOCAL` until
  the next successful poll.

### Staying authenticated

The access token lasts about eight hours, and Claude Code does not reliably
rewrite the credentials file when it refreshes — so without help the live path
would die the same evening you set it up.

The server therefore refreshes the token itself, half an hour before expiry:

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

> **Anything else reading the same stored login is part of this.** All four
> Stream Deck plugins above read the same credentials file and carry refresh
> logic. `com.singerous.ai-limits` contains no file-write call anywhere, so it
> refreshes and never writes the rotated token back — after it refreshes, the
> file holds a refresh token Anthropic has already invalidated. That is exactly the
> `Refresh token not found or invalid` seen here, and the reason a
> `claude auth login` token could appear to die overnight.
>
> This server is the only participant that writes back, so it refreshes **30
> minutes ahead of expiry** to win that race and persist the result. The
> read-only tools then just read a fresh token and never need to refresh at all.
> If something else refreshes first anyway, recovery is another
> `claude auth login`.

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

### Why there is no local percentage

The widget stopped showing one in 1.3.0, and **1.8.0 removed it from the JSON,
the debug page and `limits.json` entirely** — along with the budgets, the
promotional-boost block and the per-model buckets that fed it. Nothing divides
measured tokens by a guessed limit any more. Kept here because the disproof is
worth not re-deriving.

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

Everything the server reports is now measured: token counts, message counts and
reset times, with the session bar scaled against your own busiest recent block
rather than against a limit nobody publishes. `session.usedWeighted` and
`peakWeighted` remain, because that ratio is a real measurement of your own
history; `percent`, `budgetWeighted`, `estimated` and `buckets` are gone.

## The weekly anchor

The default is Thursday 21:00 local. This is now **confirmed** rather than
copied from the panel: the statusline's `seven_day.resets_at`, which is
Anthropic's own value, came back as Thursday 21:00 local. It only affects the
measured `LOCAL` fallback anyway — both live paths carry absolute reset
timestamps. If yours resets on another day set `weekday` (0 = Sunday) and
`hour`.

## Endpoints

- `GET /usage` — the full snapshot
- `GET /usage?at=<epoch-ms | ISO timestamp>` — the snapshot as it would have
  been at that moment, rebuilt on demand and never cached. Windows are capped at
  the given time, so it does not count usage from after it. Useful for comparing
  a past moment against a timestamped screenshot.
- `GET /health` — liveness plus the last build time
- `GET /usagehtml` — **a human-readable debug page**: both windows with their
  full token breakdown and per-model split, every session, workflow and subtask
  as a table, and the config actually in force. An addition alongside `/usage`,
  which is unchanged and remains what the widget reads. Self-refreshes every 30s.

## Cost

The index is incremental: a file is only re-parsed from the byte offset where it
last ended. Measured on the machine it was developed on, over 10,685 messages:
a cold build takes **~440 ms**, an incremental rebuild **~40 ms**, and serving
the cached snapshot ~0.8 ms. It refreshes every 20 s, so the steady-state cost
is roughly 0.2% of one core.

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
