<#
.SYNOPSIS
  Build, version, package and install the widgets into the running iCUE.

.DESCRIPTION
  The manual route is: bump two version strings by hand, `icuewidget package`,
  then remove and re-add the widget in iCUE's UI. That last step is what makes
  it cumbersome, and it is also destructive: re-importing a .icuewidget mints a
  NEW registration under a fresh GUID and resets every widget property, so
  cityName goes back to Copenhagen on every update.

  This script skips the import entirely. An installed widget in
  %APPDATA%\Corsair\CUE5\html_widgets\<guid>\ is a plain unpacked copy of the
  widget directory, so an update is a file mirror onto the GUID folder that is
  already registered. The registration, its dashboard placement and its
  properties all survive, because none of them are touched.

  What a copy alone cannot do is make iCUE re-read the page - it holds the one
  it loaded at startup - so the mirror happens with iCUE stopped and iCUE is
  started again afterwards. That is also why the copy cannot hit a file lock.

  Order matters and is deliberate: tests run BEFORE the version bump, so a red
  suite leaves the working tree exactly as it found it.

.EXAMPLE
  pwsh tools/deploy.ps1
  Bump the patch version of both widgets, test, package, install, restart iCUE.

.EXAMPLE
  pwsh tools/deploy.ps1 -Widget C64Weather -Bump minor
  One widget, minor bump.

.EXAMPLE
  pwsh tools/deploy.ps1 -DryRun
  Print every step and change nothing.
#>

[CmdletBinding()]
param(
  [ValidateSet('C64Weather', 'ClaudeUsage', 'all')]
  [string] $Widget = 'all',

  # Explicit version, e.g. 1.6.0. Applied to every selected widget and wins
  # over -Bump. Mostly useful for putting a version back after a bad deploy.
  [string] $Version,

  [ValidateSet('patch', 'minor', 'major', 'none')]
  [string] $Bump = 'patch',

  # Deploy exactly what is on disk now. The version is then whatever it already
  # was, which on the device is indistinguishable from the build before it -
  # see the version-is-the-only-witness note in TODO.md.
  [switch] $SkipTests,

  # Mirror the files but leave iCUE alone. The new build sits on disk unread
  # until iCUE restarts on its own.
  [switch] $NoRestart,

  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$WidgetRoot = Join-Path $env:APPDATA 'Corsair\CUE5\html_widgets'
$BackupRoot = Join-Path $env:LOCALAPPDATA 'icue-deploy-backups'
$CliPath = 'C:\Program Files\Corsair\iCUE Widget CLI\icuewidget.exe'
$ICuePath = 'C:\Program Files\Corsair\Corsair iCUE5 Software\iCUE.exe'

function Write-Step { param([string] $Text) Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Info { param([string] $Text) Write-Host "   $Text" }
function Write-Warn { param([string] $Text) Write-Host "   $Text" -ForegroundColor Yellow }
function Write-Ok { param([string] $Text) Write-Host "   $Text" -ForegroundColor Green }

function Fail { param([string] $Text) Write-Host "`nFAILED: $Text" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- the widgets

$All = @(
  [pscustomobject]@{ Name = 'C64Weather';  Id = 'com.thordanielz.c64weather';  Package = 'c64-weather.icuewidget' }
  [pscustomobject]@{ Name = 'ClaudeUsage'; Id = 'com.thordanielz.claudeusage'; Package = 'claude-code-usage.icuewidget' }
)
$Selected = if ($Widget -eq 'all') { $All } else { $All | Where-Object Name -eq $Widget }

# ------------------------------------------------------------------- versions

# Edited as text, not as parsed-and-reserialised JSON: the manifest is a file a
# human reads and diffs, and round-tripping it through ConvertTo-Json would
# reformat every other line of it for the sake of one field.
function Get-WidgetVersion {
  param([string] $Dir)
  $manifest = Get-Content (Join-Path $Dir 'manifest.json') -Raw
  $m = [regex]::Match($manifest, '"version"\s*:\s*"([^"]+)"')
  if (-not $m.Success) { Fail "no version field in $Dir\manifest.json" }
  return $m.Groups[1].Value
}

function Step-Version {
  param([string] $Current, [string] $How)
  if ($How -eq 'none') { return $Current }
  $p = $Current.Split('.')
  if ($p.Count -ne 3) { Fail "version '$Current' is not x.y.z, so it cannot be bumped" }
  $major, $minor, $patch = [int]$p[0], [int]$p[1], [int]$p[2]
  switch ($How) {
    'major' { $major++; $minor = 0; $patch = 0 }
    'minor' { $minor++; $patch = 0 }
    'patch' { $patch++ }
  }
  return "$major.$minor.$patch"
}

# manifest.json and scripts/widget.js each carry the version, and the widget
# prints the one from widget.js. They are asserted equal afterwards because a
# drift between them means the device shows a version that no package ever had.
function Set-WidgetVersion {
  param([string] $Dir, [string] $New)

  $manifestPath = Join-Path $Dir 'manifest.json'
  $scriptPath = Join-Path $Dir 'scripts\widget.js'

  $manifest = Get-Content $manifestPath -Raw
  $manifest = [regex]::Replace($manifest, '("version"\s*:\s*")[^"]+(")', "`${1}$New`${2}", 1)

  $script = Get-Content $scriptPath -Raw
  if ($script -notmatch "var WIDGET_VERSION = '[^']+';") {
    Fail "no WIDGET_VERSION in $scriptPath"
  }
  $script = [regex]::Replace($script, "(var WIDGET_VERSION = ')[^']+(';)", "`${1}$New`${2}", 1)

  if ($DryRun) { return }

  # -NoNewline: both files already end in their own newline, and Set-Content
  # would otherwise add a second one on every deploy.
  Set-Content $manifestPath $manifest -NoNewline -Encoding utf8
  Set-Content $scriptPath $script -NoNewline -Encoding utf8

  $back = Get-WidgetVersion $Dir
  $inScript = [regex]::Match((Get-Content $scriptPath -Raw), "var WIDGET_VERSION = '([^']+)';").Groups[1].Value
  if ($back -ne $New -or $inScript -ne $New) {
    Fail "version did not take: manifest=$back widget.js=$inScript wanted=$New"
  }
}

# --------------------------------------------------------------------- checks

if (-not (Test-Path $CliPath)) { Fail "iCUE Widget CLI not found at $CliPath" }
if (-not (Test-Path $WidgetRoot)) { Fail "no installed-widget root at $WidgetRoot" }
foreach ($w in $Selected) {
  if (-not (Test-Path (Join-Path $RepoRoot $w.Name))) { Fail "$($w.Name) is not in $RepoRoot" }
}

# Which GUID folder is each widget registered under. Resolved BEFORE anything is
# built, so a widget that has never been imported stops the run early rather
# than after it has already bumped versions and stopped iCUE.
function Get-Installed {
  param([string] $Id)
  $hits = @()
  foreach ($dir in Get-ChildItem $WidgetRoot -Directory) {
    $manifest = Join-Path $dir.FullName 'manifest.json'
    if (-not (Test-Path $manifest)) { continue }
    try { $m = Get-Content $manifest -Raw | ConvertFrom-Json } catch { continue }
    if ($m.id -eq $Id) {
      $hits += [pscustomobject]@{ Path = $dir.FullName; Guid = $dir.Name; Version = $m.version }
    }
  }
  return $hits
}

Write-Step 'Registrations'
foreach ($w in $Selected) {
  $hits = @(Get-Installed $w.Id)
  if ($hits.Count -eq 0) {
    Fail @"
$($w.Name) has never been imported, so there is no registration to update.
Import $($w.Package) once through iCUE's UI - Dashboard, add a widget, Import -
and every update after that one can come through this script.
"@
  }
  # Re-importing rather than removing first leaves the old registration behind,
  # unplaced. Both get the new build: whichever one is on the dashboard is then
  # right, and neither is left as a stale copy that boots an old version.
  if ($hits.Count -gt 1) {
    Write-Warn "$($w.Name) is registered $($hits.Count) times (past re-imports); all of them get the update"
  }
  foreach ($h in $hits) { Write-Info "$($w.Name) $($h.Version) -> $($h.Guid)" }
  $w | Add-Member -NotePropertyName Installed -NotePropertyValue $hits
  $w | Add-Member -NotePropertyName Dir -NotePropertyValue (Join-Path $RepoRoot $w.Name)
}

# ---------------------------------------------------------------------- tests

# Before the bump on purpose: a red suite must leave the tree byte-identical.
if ($SkipTests) {
  Write-Step 'Tests'
  Write-Warn 'skipped (-SkipTests)'
} else {
  Write-Step 'Tests'
  $suites = @()
  foreach ($w in $Selected) {
    $suites += Get-ChildItem (Join-Path $w.Dir 'test') -Filter '*.test.js' -ErrorAction SilentlyContinue
    # The usage widget renders what the feed serves, so the feed's suites are
    # part of its gate, not a separate concern.
    if ($w.Name -eq 'ClaudeUsage') {
      $suites += Get-ChildItem (Join-Path $RepoRoot 'usage-server\test') -Filter '*.test.js' -ErrorAction SilentlyContinue
    }
  }
  foreach ($s in $suites) {
    $rel = $s.FullName.Substring($RepoRoot.Length + 1)
    Write-Host ("   {0,-46} " -f $rel) -NoNewline
    if ($DryRun) { Write-Host 'skipped (dry run)' -ForegroundColor DarkGray; continue }
    $out = & node $s.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'FAIL' -ForegroundColor Red
      $out | Select-Object -Last 25 | ForEach-Object { Write-Host "        $_" }
      Fail "$rel failed; nothing has been changed"
    }
    Write-Host 'pass' -ForegroundColor Green
  }
}

# ----------------------------------------------------------- bump and package

Write-Step 'Version'
foreach ($w in $Selected) {
  $current = Get-WidgetVersion $w.Dir
  $next = if ($Version) { $Version } else { Step-Version $current $Bump }
  Write-Info "$($w.Name) $current -> $next$(if ($DryRun) { ' (dry run)' })"
  Set-WidgetVersion $w.Dir $next
  $w | Add-Member -NotePropertyName NewVersion -NotePropertyValue $next
}

Write-Step 'Package'
foreach ($w in $Selected) {
  if ($DryRun) { Write-Info "$($w.Name): validate + package (dry run)"; continue }
  Push-Location $RepoRoot
  try {
    $out = & $CliPath validate $w.Name 2>&1
    if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Write-Host "        $_" }; Fail "$($w.Name) failed validation" }
    $out = & $CliPath package $w.Name 2>&1
    if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Write-Host "        $_" }; Fail "$($w.Name) failed to package" }
  } finally { Pop-Location }
  $pkg = Join-Path $RepoRoot $w.Package
  if (Test-Path $pkg) {
    Write-Ok "$($w.Package) $([math]::Round((Get-Item $pkg).Length / 1KB)) KB"
  } else {
    Write-Warn "$($w.Package) was not written where expected; the install below is still the file mirror, not this package"
  }
}

# -------------------------------------------------------------- stop, install

# iCUE holds the page it loaded at startup, so a mirror onto a live install
# changes nothing anybody can see. Stopping it first drops that page AND takes
# any file handle out of the way of the copy.
$wasRunning = [bool] (Get-Process iCUE -ErrorAction SilentlyContinue)

if (-not $NoRestart -and $wasRunning -and -not $DryRun) {
  Write-Step 'Stopping iCUE'
  Get-Process iCUE | Stop-Process -Force
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Process iCUE -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process iCUE -ErrorAction SilentlyContinue) { Fail 'iCUE would not stop; nothing was installed' }
  Write-Ok 'stopped'
}

Write-Step 'Install'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($w in $Selected) {
  foreach ($h in $w.Installed) {
    $backup = Join-Path $BackupRoot "$stamp-$($w.Name)-$($h.Guid)"
    if ($DryRun) {
      Write-Info "$($w.Name) -> $($h.Guid)  (dry run; backup would be $backup)"
      continue
    }
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    # /MIR both ways: the backup is the folder as it was, and the install ends
    # up as an exact copy of the repo directory - a file deleted in the repo
    # has to disappear from the install too, or a stale script keeps loading.
    $null = robocopy $h.Path $backup /MIR /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { Fail "could not back up $($h.Guid) (robocopy $LASTEXITCODE)" }
    $null = robocopy $w.Dir $h.Path /MIR /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) {
      Write-Warn "install failed; restoring $($h.Guid) from $backup"
      $null = robocopy $backup $h.Path /MIR /NFL /NDL /NJH /NJS /NP
      Fail "could not install into $($h.Guid) (robocopy $LASTEXITCODE)"
    }
    $now = Get-WidgetVersion $h.Path
    if ($now -ne $w.NewVersion) { Fail "installed $($h.Guid) reads $now, wanted $($w.NewVersion)" }
    Write-Ok "$($w.Name) $($w.NewVersion) -> $($h.Guid)  (backup: $backup)"
  }
}

# --------------------------------------------------------------------- restart

if ($DryRun) {
  Write-Step 'Done (dry run)'
  exit 0
}

if ($NoRestart) {
  Write-Step 'iCUE'
  Write-Warn 'left running (-NoRestart): it is still showing the page it loaded, not the build just installed'
} elseif ($wasRunning) {
  Write-Step 'Starting iCUE'
  if (-not (Test-Path $ICuePath)) { Fail "iCUE was stopped but $ICuePath does not exist, so it cannot be started again" }
  Start-Process $ICuePath | Out-Null
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Get-Process iCUE -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process iCUE -ErrorAction SilentlyContinue) {
    Write-Ok 'started; the dashboard takes a few seconds to repaint'
  } else {
    Fail 'iCUE did not come back up'
  }
} else {
  Write-Step 'iCUE'
  Write-Info 'was not running, so nothing to restart; it will load the new build when you next open it'
}

Write-Step 'Installed'
foreach ($w in $Selected) {
  foreach ($h in $w.Installed) {
    Write-Info ("{0,-14} {1,-8} {2}" -f $w.Name, (Get-WidgetVersion $h.Path), $h.Guid)
  }
}
Write-Host ''
