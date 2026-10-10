# Perf Overlay — the NVIDIA overlay's Basic view as a widget, and a page

> **For agentic workers:** run these tasks through `/runtask` or `/runqueue`
> against `.claude/tasks/whattask.json`, which is generated from this file with
> `/whattask` focused on it. Each task below states its own done-condition.

**Goal:** Show the four values of the NVIDIA app's statistics overlay, *Basic*
view, on the Xeneon Edge — `FPS 60 | GPU 0 % | CPU 69 % | LAT 0 ms` — and serve
the same feed as a browser page, the way `/usagehtml` and `/taskshtml` already
are.

**Source of the numbers:** NVIDIA's **FrameView SDK**, installed with the NVIDIA
app at `C:\Program Files\NVIDIA Corporation\FrameViewSDK\SDK\Public_Release\`
(`FvSDK.h`, `FvSDK_x64.dll`, `FvSDK_x64.lib`). Its header defines exactly the
four Basic-view metrics:

| Overlay | FvSDK metric | struct field |
|---|---|---|
| Frame Rate (FPS) | `eAvgFPS` | `AvgFPS_v1::mFPS.AvgFPS` |
| GPU UTIL | `eGPUUtil` | `GPUUtil_v1::mGPUUtil` |
| CPU UTIL | `eCPUUtil` | `CPUUtil_v1::mCPUUtil` |
| PCL (av) | `eAvgSWPCLatency` | `AvgSWPCLatency_v1::mFPS` (unverified which field carries ms) |

Call sequence (from `FvSDK.h`): `FvSDK_Initialize` → `FvSDK_CreateSession` →
`FvSDK_EnableMetrics` → `FvSDK_StartSession` → loop `FvSDK_SampleData` +
`FvSDK_ReadData` → `FvSDK_StopSession` → `FvSDK_DestroySession` →
`FvSDK_Shutdown`.

**Unverified, and settled by Task 1 before anything depends on it:** whether
FvSDK works outside the NVIDIA app (admin rights? the `nvfvsdksvc_x64.exe`
service?), and whether `eAvgSWPCLatency` matches the overlay's PCL (av).

**Licence:** the FrameView SDK EULA is *internal use only*, no redistribution,
no modification. So the helper LOADS THE INSTALLED DLL and never copies it into
this repo or into an `.icuewidget` package.

## Architecture

```
FvSDK_x64.dll ──> tools/fvbridge/fvbridge.exe ──(1 JSON line/s on stdout)──┐
                                                                            v
nvidia-smi -lms 1000 ──(fallback GPU)──> usage-server/perf.js <── os.cpus() (fallback CPU)
                                              │  snapshot {fps,gpu,cpu,lat,process,source,at}
                         ┌────────────────────┴──────────────┐
                    GET /perf (JSON)                  GET /perfhtml (page)
                         │
                  PerfOverlay widget  (FPS falls back to iCUE's Fps plugin when perf.fps is null)
```

- `perf.js` owns sampling. It prefers fvbridge; when fvbridge is absent or dies
  it falls back per field and says so in `source` (`"fvsdk"` / `"fallback"`).
  A field that cannot be read is `null`, never `0` — `0 %` GPU is a real reading.
- The widget renders `N/A` for every `null`, exactly as NVIDIA's overlay does.

## Global Constraints

- **Zero dependencies.** No `package.json` in this repo; that is deliberate.
- **LF line endings** everywhere (`.gitattributes` pins it).
- **Same shape as `usagehtml.js` / `taskshtml.js`** for the page: `esc()` on every
  interpolation, one `<table class="grid">` idiom, meta refresh, no dependency.
- **Route ordering:** `/perf` and `/perfhtml` go ABOVE the `/usage` handler,
  which matches on a prefix; `/perfhtml` above `/perf` for the same reason.
- **`/usage` is untouched.** Its contract is what the Claude Usage widget reads.
- **Never copy FvSDK binaries into the repo** (EULA).

## Task 1: FvSDK spike (fork) — `fvsdk-spike`

Run NVIDIA's own `SDK\FvSDKTestClient_Public.exe` with a Reflex game running and
the overlay (Alt+R) visible. Record: does it start without admin; which of the
four metrics it reports; whether the latency value tracks PCL (av). Throwaway —
nothing lands in the repo. **Fork:** `fvsdk` (works, latency matches) or
`fallback` (does not work, or needs elevation we will not grant).

## Task 2: The sampler — `perf-sampler`

`usage-server/perf.js`: `cpuPercent(prev, next)` from `os.cpus()` time deltas;
`parseSmiLine(line)` for `nvidia-smi --query-gpu=utilization.gpu
--format=csv,noheader,nounits -lms 1000`; `parseBridgeLine(line)` for fvbridge's
JSON line; `start()/stop()/snapshot()`. Tests in `usage-server/test/perf.test.js`.
Correct under either fork branch — the fallback path is needed in both.

## Task 3: The routes and the page — `perf-routes-and-page`

`usage-server/perfhtml.js` with `render(snapshot)`; `GET /perf` and
`GET /perfhtml` in `server.js`. Tests in `usage-server/test/perfhtml.test.js`
and route cases in `usage-server/test/http.test.js`.

## Task 4: The native helper — `fvbridge-helper` (branch `fvsdk`)

`tools/fvbridge/` — one C++ file plus a build script using the VS 2022
toolchain (NOT `vswhere -latest`, which picks VS 2026 on this machine; constrain
to `[17.0,18.0)`). Includes `FvSDK.h` and links `FvSDK_x64.lib` from the
installed path; prints one JSON line per second:
`{"fps":..,"gpu":..,"cpu":..,"lat":..,"process":".."}`, `null` for any metric
the SDK returns no sample for. The built `.exe` is gitignored.

## Task 5: Wire fvbridge into the sampler — `perf-wire-fvbridge` (branch `fvsdk`)

`perf.js` spawns `tools/fvbridge/fvbridge.exe` when it exists, restarts it with
backoff if it exits, and reports `source: "fvsdk"` while its lines are fresh.

## Task 6: The widget — `perf-overlay-widget`

`PerfOverlay/` (`com.thordanielz.perfoverlay`, `dashboard_lcd`), laid out like
`TaskQueue/`: one strip, grey labels, bold white values, thin dividers. Polls
`127.0.0.1:41777/perf` once a second; FPS falls back to the iCUE Fps plugin
(`widgetbuilder.fpsdataprovider:Fps:1.0`) when `perf.fps` is null. Layout test
in `PerfOverlay/test/layout.test.js`.

## Task 7: Gates, deploy and docs — `perf-wire-into-gates-and-docs`

Add the new suites and `node --check` lines to `.github/workflows/tests.yml`
and `.githooks/pre-push`; add `PerfOverlay` to `tools/deploy.ps1`'s widget
table and ValidateSet; document `/perf`, `/perfhtml` and the widget in
`README.md`; add a Perf Overlay section to `TODO.md`.
