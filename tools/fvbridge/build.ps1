# Builds tools/fvbridge/fvbridge.exe with the VS 2022 toolchain against the
# installed NVIDIA FrameView SDK. Nothing from the SDK is copied into the repo.
#   vswhere -latest returns VS 2026 on this machine (no v143 / ClangCL), so the
#   lookup is constrained to [17.0,18.0).
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$sdk  = 'C:\Program Files\NVIDIA Corporation\FrameViewSDK\SDK\Public_Release'
foreach ($f in 'FvSDK.h', 'FvSDK_x64.lib') {
    if (-not (Test-Path (Join-Path $sdk $f))) { throw "FrameView SDK file missing: $sdk\$f" }
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -version '[17.0,18.0)' -products '*' `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath |
      Select-Object -First 1
if (-not $vs) { throw 'No VS 2022 (17.x) installation with the x64 C++ tools found' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found under $vs" }

$src = Join-Path $here 'fvbridge.cpp'
$exe = Join-Path $here 'fvbridge.exe'
$obj = Join-Path $here 'fvbridge.obj'
$cmd = "`"$vcvars`" >nul && cl /nologo /std:c++17 /EHsc /O2 /W4 /MT /I`"$sdk`" " +
       "/Fo`"$obj`" /Fe`"$exe`" `"$src`" `"$sdk\FvSDK_x64.lib`" " +
       "user32.lib advapi32.lib version.lib /link /INCREMENTAL:NO"
Write-Host "VS 2022: $vs"
$bat = Join-Path ([IO.Path]::GetTempPath()) 'fvbridge-build.cmd'
Set-Content -Path $bat -Value "@echo off`r`n$cmd" -Encoding ascii
cmd.exe /d /c $bat
$rc = $LASTEXITCODE
Remove-Item -ErrorAction SilentlyContinue $bat
if ($rc -ne 0) { throw "cl.exe failed with exit code $rc" }
Remove-Item -ErrorAction SilentlyContinue $obj
Write-Host "Built $exe"
