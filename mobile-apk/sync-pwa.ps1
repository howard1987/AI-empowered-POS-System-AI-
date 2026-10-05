<#
  sync-pwa.ps1 - stage PWA sources into Capacitor's www/ dir (frontend bundled inside the APK)

  Why stage instead of pointing webDir at the source folder:
    1) must exclude vendor/zxing-wasm (3.1 MB) - the APK will use native scanning (ML Kit/ZXing)
    2) Capacitor expects webDir to be a build output dir, not the source tree
    3) keeps the source folder clean

  Usage: powershell -File sync-pwa.ps1
  ASCII-only output on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI,
  which corrupts non-ASCII string literals and breaks parsing.
#>
param(
  [string]$Src = (Join-Path $PSScriptRoot '..\backend\public\pwa'),
  [string]$Dest = (Join-Path $PSScriptRoot 'www'),
  # V5.0.10: zxing-wasm is included by default again (see note below).
  # Pass -SlimScan to drop it and save 3.1 MB.
  [switch]$SlimScan
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Src)) { throw "PWA source not found: $Src" }

# NOTE on /XD: pass the BARE directory name. A relative path such as
# 'vendor\zxing-wasm' is resolved against the current working directory by
# robocopy and silently fails to match, which previously left 3.1 MB of wasm
# files in www/ (a bare name matches at any depth).
$excludedDirs  = @('node_modules', '.playwright-cli')
$excludedFiles = @('*.log', 'Thumbs.db')

# V5.0.10 note:
#   zxing-wasm was excluded earlier to shrink the APK, but that left barcode scanning
#   depending on only two channels: the Capacitor ZXing plugin (APK only) and the web
#   BarcodeDetector. BarcodeDetector is NOT universally present (it is already
#   undefined on desktop Chrome/Edge), and the native plugin path cannot be verified
#   without a physical device. So the wasm engine - which works in ANY WebView - is
#   restored as the final safety net. For a POS app, reliability beats 3.1 MB.
#   Use -SlimScan only after confirming native scanning on your actual hardware.
if ($SlimScan) {
  $excludedDirs += 'zxing-wasm'
  Write-Host '[sync-pwa] SlimScan: excluding vendor/zxing-wasm (-3.1MB); native scanning MUST be verified on device'
} else {
  Write-Host '[sync-pwa] including vendor/zxing-wasm as the final fallback engine'
}

Write-Host "[sync-pwa] source : $Src"
Write-Host "[sync-pwa] dest   : $Dest"

# 1) clean dest so a build never keeps stale files
if (Test-Path $Dest) {
  Write-Host "[sync-pwa] cleaning dest ..."
  Remove-Item -Recurse -Force $Dest
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# 2) copy (/E recursive, plus /XD /XF exclusions)
$rcArgs = @($Src, $Dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
if ($excludedDirs.Count)  { $rcArgs += '/XD'; $rcArgs += $excludedDirs }
if ($excludedFiles.Count) { $rcArgs += '/XF'; $rcArgs += $excludedFiles }
& robocopy @rcArgs | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { throw "robocopy failed with exit code $rc" }

# 3) report
$files   = Get-ChildItem $Dest -Recurse -File
$totalMB = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 2)
Write-Host "[sync-pwa] done: $($files.Count) files, $totalMB MB (robocopy rc=$rc)"

# 4) fail fast if critical entry files are missing (better now than a white screen on device)
$required = @('index.html', 'app.js', 'manifest.webmanifest', 'sw.js')
$missing  = $required | Where-Object { -not (Test-Path (Join-Path $Dest $_)) }
if ($missing) { throw ("critical files missing: " + ($missing -join ', ')) }

Write-Host "[sync-pwa] self-check OK: index.html / app.js / manifest.webmanifest / sw.js present"

# tts.js (voice announcement) lives at the SITE ROOT (backend/public/tts.js) because the PWA
# is served from /pwa/ and references it as "../tts.js". Inside the APK, www/ IS the root, so
# "../tts.js" escapes the web root and 404s. Copy it to www/ so "./tts.js" resolves.
$tts = Join-Path (Split-Path $Src -Parent) 'tts.js'
if (Test-Path $tts) {
  Copy-Item $tts (Join-Path $Dest 'tts.js') -Force
  Write-Host "[sync-pwa] copied tts.js (voice announcement) into www/"
} else {
  Write-Warning "[sync-pwa] tts.js not found at $tts - voice announcement will be unavailable in the APK"
}

# The boss terminal is a SEPARATE app that already existed (backend/public/boss/index.html).
# The backend QR login points at /boss/index.html, so the APK must bundle it too, otherwise
# an admin logging in on the phone would be redirected to a missing page.
# Layout inside the APK:  www/index.html  = PWA (staff)   www/boss/index.html = boss terminal
# They are same-origin, so they share localStorage and can hand the token back and forth.
$bossSrc = Join-Path (Split-Path $Src -Parent) 'boss'
if (Test-Path $bossSrc) {
  $bossDst = Join-Path $Dest 'boss'
  & robocopy $bossSrc $bossDst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy boss failed ($LASTEXITCODE)" }
  $bf = Get-ChildItem $bossDst -File | ForEach-Object { $_.Name }
  if ($bf -notcontains 'index.html') { throw 'boss app copied but index.html missing' }
  Write-Host "[sync-pwa] copied boss terminal into www/boss/ ($($bf -join ', '))"
} else {
  Write-Warning "[sync-pwa] boss app not found at $bossSrc - admin login will have nowhere to land"
}
