<#
  build-apk.ps1 - one-command APK build (V5.0.9)
  See README-APK.md for details.
#>
param(
  [string]$BuildRoot = 'D:\pos-apk-build',
  [switch]$SkipSync,
  [string]$Task = 'assembleDebug'
)

$ErrorActionPreference = 'Stop'
$Root       = $PSScriptRoot
$AndroidSrc = Join-Path $Root 'android'
$DistDir    = Join-Path $Root 'dist'
$Npx        = 'C:\Users\YL\.workbuddy\binaries\node\versions\22.22.2-3\npx.cmd'

$env:ANDROID_SDK_ROOT = 'D:\Software\android-tools\Sdk'
$env:ANDROID_HOME     = $env:ANDROID_SDK_ROOT
$env:JAVA_HOME        = 'D:\Software\android-tools\jdk-17.0.20.1+1'
$env:GRADLE_USER_HOME = 'D:\Software\android-tools\gradle-home'

Write-Host '=== 1/4 stage PWA + pin cert + cap sync ==='
if (-not $SkipSync) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'sync-pwa.ps1')
  if ($LASTEXITCODE -ne 0) { throw "sync-pwa failed ($LASTEXITCODE)" }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'sync-cert.ps1')
  if ($LASTEXITCODE -ne 0) { throw "sync-cert failed ($LASTEXITCODE)" }
  Push-Location $Root
  & $Npx cap sync android
  $rc = $LASTEXITCODE
  Pop-Location
  if ($rc -ne 0) { throw "cap sync failed ($rc)" }
} else {
  Write-Host '  (skipped: -SkipSync)'
}

Write-Host '=== 2/4 mirror to ASCII build root ==='
if ($BuildRoot -match '[^\x00-\x7F]') { throw "BuildRoot must be ASCII-only: $BuildRoot" }
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
$BuildAndroid = Join-Path $BuildRoot 'android'
# /MIR mirrors (and prunes stale files) without a separate Remove-Item, which matters
# because the build root lives outside the workspace.
& robocopy $AndroidSrc $BuildAndroid /MIR /NFL /NDL /NJH /NJS /NP /XD '.gradle' 'build' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy android failed ($LASTEXITCODE)" }
# node_modules MUST be mirrored too: capacitor.settings.gradle points at
# '../node_modules/@capacitor/android/capacitor' via a relative path, and without it
# Gradle fails with "Could not resolve project :capacitor-android".
& robocopy (Join-Path $Root 'node_modules') (Join-Path $BuildRoot 'node_modules') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy node_modules failed ($LASTEXITCODE)" }
$lp = 'sdk.dir=' + ($env:ANDROID_SDK_ROOT -replace '\\', '/')
Set-Content -Path (Join-Path $BuildAndroid 'local.properties') -Value $lp -Encoding ASCII

Write-Host "=== 3/4 gradle $Task ==="
Push-Location $BuildAndroid
& powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "chcp 65001 > `$null; & '.\gradlew.bat' $Task --no-daemon --console=plain"
$rcg = $LASTEXITCODE
Pop-Location
if ($rcg -ne 0) { throw "gradle $Task failed ($rcg)" }

Write-Host '=== 4/4 collect APK ==='
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
Get-ChildItem $DistDir -Filter *.apk -ErrorAction SilentlyContinue | Remove-Item -Force
$apks = Get-ChildItem (Join-Path $BuildAndroid 'app\build\outputs') -Recurse -Filter *.apk -ErrorAction SilentlyContinue
if (-not $apks) { throw 'gradle succeeded but no APK was produced' }
foreach ($a in $apks) {
  $dest = Join-Path $DistDir $a.Name
  Copy-Item $a.FullName $dest -Force
  $mb = [math]::Round((Get-Item $dest).Length / 1MB, 2)
  Write-Host ("  APK: $dest  ($mb MB)")
}
Write-Host '=== build-apk done ==='
