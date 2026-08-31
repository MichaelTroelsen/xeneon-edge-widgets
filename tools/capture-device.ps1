<#
.SYNOPSIS
  Screenshot the Xeneon Edge dashboard.

.DESCRIPTION
  The version printed on the widget is the only honest witness to what iCUE is
  actually running: the installed folder can hold a new build while the page
  iCUE loaded at startup is still the old one. So a deploy is not verified by
  reading manifest.json back - it is verified by looking at the panel.

  The Edge is found by its geometry (2560x720) rather than by a hard-coded
  origin, which is negative on this machine and would change the moment the
  displays are rearranged.

.EXAMPLE
  pwsh tools/capture-device.ps1 -Path edge.png
#>

[CmdletBinding()]
param(
  [string] $Path = "$env:TEMP\xeneon-edge.png",

  # Override if the panel is ever not the 2560x720 one.
  [int] $Width = 2560,
  [int] $Height = 720
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$screen = [System.Windows.Forms.Screen]::AllScreens |
  Where-Object { $_.Bounds.Width -eq $Width -and $_.Bounds.Height -eq $Height } |
  Select-Object -First 1

if (-not $screen) {
  Write-Host 'No matching display. Screens seen:' -ForegroundColor Red
  [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    Write-Host ("  {0}  {1}x{2} at {3},{4}" -f $_.DeviceName, $_.Bounds.Width, $_.Bounds.Height, $_.Bounds.X, $_.Bounds.Y)
  }
  exit 1
}

$b = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $gfx.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $gfx.Dispose()
  $bmp.Dispose()
}

Write-Host ("{0}  {1}x{2} at {3},{4} -> {5}" -f $screen.DeviceName, $b.Width, $b.Height, $b.X, $b.Y, $Path)
