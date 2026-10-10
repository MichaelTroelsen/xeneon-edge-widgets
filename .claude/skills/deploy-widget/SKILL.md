---
name: deploy-widget
description: Put a rebuilt widget onto the Xeneon Edge and prove it landed by reading the rendered page. Use when the device needs to catch up with the repo.
disable-model-invocation: true
---

# Deploy a widget to the Xeneon Edge

`tools/deploy.ps1` mirrors the unpacked files onto the **already-registered GUID
folder** with iCUE stopped, then restarts it. Registration, placement and every
widget property survive. The manual package-and-re-import route in the iCUE UI
does not: it mints a NEW GUID and resets every property, so it is never the
right call for an update.

## The invocation

**One run per widget, with the version pinned:**

```powershell
pwsh tools/deploy.ps1 -Widget TaskQueue   -SkipTests -Version 1.4.0
pwsh tools/deploy.ps1 -Widget ClaudeUsage -SkipTests -Version 1.15.0
```

Substitute the version each widget **already declares** — read it from
`<Widget>/manifest.json`, do not guess.

### Why the version is stated explicitly

`-SkipTests` now means what it says: it deploys what is on disk and does **not**
bump. So the `-Version` argument is belt-and-braces rather than load-bearing —
state it anyway, because it makes the intended version visible in the command
and in the shell history, and it is the difference between "I meant 1.4.0" and
"whatever happened to be there".

**This was not always true, and the history is worth keeping.** Until
2026-09-06 the Version step ran unconditionally: `-SkipTests` skipped only the
tests, while the flag's own doc comment claimed "the version is then whatever it
already was". Plain `-SkipTests` reported `1.6.0 -> 1.6.1`, `1.15.0 -> 1.15.1`,
`1.4.0 -> 1.4.1` under `-DryRun`. That mismatch produced a decision record which
would have deployed a bump the human had explicitly forbidden. The gate exists
now, and an explicit `-Version` still wins over it — so if you are reading an
older deploy record that pinned versions defensively, that is why.

Left unpinned AND unbumped, deploy would leave a version on the panel that
matches no commit — the drift several commits were spent guarding against.

**`-Version` applies to EVERY selected widget**, which is why this is one run per
widget rather than one run for both — they need different values.

**`-Widget` defaults to `all`.** Without it you also rebuild and reinstall
C64Weather, which is usually unchanged and was not asked for.

### Before you start

- **Commit or stash first.** Deploy mirrors what is on disk, not what is
  committed. A dirty tree ships uncommitted work to the panel.
- **Run the suites** if you did not just run them, since `-SkipTests` skips the
  gate: `node <Widget>/test/layout.test.js`.
- **`-DryRun` is safe to probe with** — the version write returns early at `:132`
  and the iCUE stop is guarded at `:260`. Use it whenever unsure.

## Verifying it landed

**The installed folder is not proof.** iCUE caches the page it loaded at startup,
so a mirror onto a live install changes nothing anybody can see until it
restarts. This trap is recorded four times in this repo's history. The rendered
page is the only witness.

Capture the panel — `\\.\DISPLAY2`, 2560x720 at `-1881,1440` (confirm with
`[System.Windows.Forms.Screen]::AllScreens`, the origin moves):

```powershell
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 2560, 720
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(-1881, 1440, 0, 0, $bmp.Size)
$bmp.Save('<scratchpad>\edge.png', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
```

Then READ the image and check each widget's own header version — `Task queue …
v1.4.0`, `Claude Code usage … v1.15.0`. Give iCUE a few seconds to repaint first.

### The version is not always a witness

Pinning means a **re-deploy at the same version cannot be distinguished from the
build before it** by the number alone. It worked on 2026-09-06 only because the
device was on 1.3.8/1.14.1 and moved to 1.4.0/1.15.0.

When the version cannot witness the change, confirm a **behaviour** that only
exists in the new build. Ones that read clearly from across the room:

- queue rows carry an age, and a never-run repo says `never run` rather than a
  fabricated one
- repos are ordered most-open-first, and the list fades where it overflows
- the Updated stamp goes amber after three missed refreshes *(degraded state)*
- a row that fails to draw leaves a visible marker *(degraded state)*
- the corner clock gives way to the fallback-reason strip *(degraded state —
  only visible when the OAuth endpoint is unreachable, so it usually cannot be
  checked on demand; say so rather than claiming it was verified)*

State plainly which ones you could not observe. A degraded-state behaviour that
did not appear on a healthy panel is not evidence either way.

## Known GUIDs

Resolved by `deploy.ps1` at run time; listed only to spot a re-import that
minted a new one.

| Widget | GUID |
|---|---|
| TaskQueue | `c9dbcdf3-76d3-489f-ac45-e816f1a9f4cc` |
| ClaudeUsage | `c1f9c7fa-3bae-4968-bf1c-ff4e0342e86d` |
| C64Weather | `f62d1532-a562-43cf-b1fa-1d3d86616c3e` |

Each install writes a timestamped backup to
`%LOCALAPPDATA%\icue-deploy-backups\`.

## Fixed at source

`-SkipTests` not gating the bump, with a comment asserting the opposite, was the
same defect class this repo keeps removing from the widgets: a claim the code
cannot support. It was fixed rather than documented around — the Version step is
gated now, and the comment that was false became true without being edited.

The general lesson, which is why this note survives the fix: when prose and code
disagree, the code is usually the thing to change. Correcting the comment would
have left a flag that still did the surprising thing, and a reader who trusted
either one would still have been wrong half the time.
