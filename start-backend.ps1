<#
.SYNOPSIS
  POS cashier - dev environment launcher (PowerShell twin of start-dev.bat)

.DESCRIPTION
  Launches runtime-watchdog.mjs, which brings up:
      PostgreSQL(54329) + Backend API(3100) + Web Admin(8088) + Member H5(8089)
  and runs the idempotent DB migration on boot. This script then waits until every
  service is actually ready (DB included, via /health db:ok) and opens the browser -
  the same end result as start-dev.bat.

  Reusing the watchdog (instead of starting services itself) guarantees the SAME
  startup order and the SAME embedded PostgreSQL binary as start-dev.bat, so the
  "database not ready" problem cannot happen.

.PARAMETER Rebuild
  Recompile backend (tsc) before launching.

.PARAMETER Stop
  Stop backend/Web/H5 and the watchdog (PostgreSQL is left running, like stop-dev.bat).

.PARAMETER NoBrowser
  Do not auto-open the browser.

.PARAMETER Full
  Kept for backward compatibility. The watchdog always starts the full set
  (Web + H5), so this switch has no effect.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\start-backend.ps1
  powershell -ExecutionPolicy Bypass -File .\start-backend.ps1 -Rebuild
  powershell -ExecutionPolicy Bypass -File .\start-backend.ps1 -Stop
#>
param(
    [switch]$Rebuild,
    [switch]$Stop,
    [switch]$NoBrowser,
    [switch]$Full
)

# NOTE: EAP=Stop is intentionally NOT used. Under PS5.1 native commands write to
# stderr which would be misread as a terminating error and kill the whole script.
$ErrorActionPreference = 'Continue'

$Root = $PSScriptRoot

# ---------- locate node (managed first, system fallback) ----------
$NodeCandidates = @(
    'C:\Users\YL\.workbuddy\binaries\node\versions\22.22.2-3\node.exe',
    'C:\Program Files\nodejs\node.exe'
)
$Node = $NodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Node) { Write-Host '[ERROR] node.exe not found' -ForegroundColor Red; exit 1 }

# ---------- ports ----------
$PgPort  = 54329
$ApiPort = 3100
$WebPort = 8088
$H5Port  = 8089

function Test-Port([int]$Port) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $Port); return $true } catch { return $false }
    finally { $c.Close() }
}

# ---------- Stop mode ----------
if ($Stop) {
    Write-Host '== Stopping backend / Web / H5 and the watchdog ==' -ForegroundColor Yellow
    # 1) watchdog process (matched by its command line)
    try {
        Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%runtime-watchdog.mjs%'" -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host ("  stop watchdog  PID {0}" -f $_.ProcessId) -ForegroundColor Gray
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch { }
    # 2) services bound to the known ports
    foreach ($port in $ApiPort, $WebPort, $H5Port) {
        Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
            $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
            if ($p) {
                Write-Host ("  stop port {0}: {1} PID {2}" -f $port, $p.ProcessName, $p.Id) -ForegroundColor Gray
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Write-Host 'Done. PostgreSQL is left running (stop it manually if needed).' -ForegroundColor Green
    exit 0
}

Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  POS cashier - dev environment (PowerShell)' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan

# V4.26.2: PostgreSQL refuses to start with Administrator privileges.
# Detect elevation early and warn, otherwise the script hangs waiting for DB ready.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
# V4.26.2: warn only when it actually matters - if PG is already up, or the
# Windows service exists (watchdog starts it with LocalService, bypassing the
# admin-token restriction), there is nothing to warn about.
$pgUp  = Test-NetConnection -ComputerName 127.0.0.1 -Port 54329 -InformationLevel Quiet -WarningAction SilentlyContinue
$pgSvc = Get-Service -Name 'pos-cashier-pg' -ErrorAction SilentlyContinue
if (-not $pgUp -and $pgSvc) {
    Write-Host '  PostgreSQL will be started via Windows service "pos-cashier-pg" (LocalService account).' -ForegroundColor Gray
}
if ($isAdmin -and -not $pgUp -and -not $pgSvc) {
    Write-Host ''
    Write-Host '  [WARN] UAC is DISABLED or you are running as Administrator.' -ForegroundColor Red
    Write-Host '  PostgreSQL REFUSES to start with Administrator rights, so the' -ForegroundColor Red
    Write-Host '  DB will never become ready and this script will hang at [3/4].' -ForegroundColor Red
    Write-Host ''
    Write-Host '  FIX A: re-enable UAC in an ADMIN PowerShell, then REBOOT:' -ForegroundColor Yellow
    Write-Host '    reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v EnableLUA /t REG_DWORD /d 1 /f' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  FIX B: register PostgreSQL as a Windows service under a non-admin' -ForegroundColor Yellow
    Write-Host '         account (no reboot, no UAC change).' -ForegroundColor Yellow
    Write-Host ''
    Read-Host 'Press Enter to continue anyway, or Ctrl+C to abort'
}

# ---------- optional rebuild ----------
if ($Rebuild) {
    Write-Host '[0/4] Rebuilding backend (tsc) ...' -ForegroundColor Yellow
    Push-Location (Join-Path $Root 'backend')
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { Write-Host '[ERROR] backend build failed' -ForegroundColor Red; Pop-Location; exit 1 }
    } finally { Pop-Location }
}

# ---------- 1) launch the watchdog (it owns PG + backend + Web + H5 + migration) ----------
Write-Host '[1/4] Launching runtime-watchdog (PG / backend / Web / H5 + migration) ...' -ForegroundColor Yellow
$wproc = Start-Process -FilePath $Node -ArgumentList @('runtime-watchdog.mjs') -WorkingDirectory $Root -WindowStyle Minimized -PassThru
if ($wproc -and -not $wproc.HasExited) {
    Write-Host ('      watchdog started (PID {0})' -f $wproc.Id) -ForegroundColor Green
} else {
    Write-Host '      [WARN] watchdog did not start - check node path / permissions' -ForegroundColor Yellow
}

# ---------- 2) wait for PostgreSQL ----------
Write-Host ('[2/4] Waiting for PostgreSQL :{0} ...' -f $PgPort) -ForegroundColor Yellow
$ok = $false
for ($i = 0; $i -lt 480; $i++) {
    if (Test-Port $PgPort) { $ok = $true; break }
    if ($i % 60 -eq 0) { Write-Host ('      PG not ready yet ... {0}s' -f [int]($i / 2)) -ForegroundColor DarkGray }
    Start-Sleep -Milliseconds 500
}
if (-not $ok) {
    Write-Host '      [ERROR] PostgreSQL not up after 240s. Check runtime-watchdog.log and the embedded PG binary.' -ForegroundColor Red
    exit 1
}
Write-Host '      PostgreSQL is up' -ForegroundColor Green

# ---------- 3) wait for backend with DB ready ----------
Write-Host ('[3/4] Waiting for backend :{0} (DB ready) ...' -f $ApiPort) -ForegroundColor Yellow
$ok = $false
for ($i = 0; $i -lt 360; $i++) {
    try {
        $h = Invoke-RestMethod -Uri 'http://localhost:3100/health' -TimeoutSec 2 -ErrorAction SilentlyContinue
        # V4.26.2: db lives in $h.data.db (health wraps response in {code,msg,data}); accept both shapes
        if ($h -and ($h.data.db -eq 'ok' -or $h.db -eq 'ok')) { $ok = $true; break }
    } catch { }
    if ($i % 10 -eq 0) { Write-Host ('      waiting for /health db:ok ... ({0}/360)' -f $i) -ForegroundColor DarkGray }
    Start-Sleep -Milliseconds 500
}
if (-not $ok) {
    Write-Host '      [ERROR] backend / DB not ready. See backend/logs/error.log' -ForegroundColor Red
    exit 1
}
Write-Host '      backend is up and database is ready' -ForegroundColor Green

# ---------- 4) wait for Web admin (H5 is also brought up by the watchdog) ----------
Write-Host ('[4/4] Waiting for Web admin :{0} ...' -f $WebPort) -ForegroundColor Yellow
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:8088/' -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
}
if ($ok) { Write-Host '      Web admin is up' -ForegroundColor Green }
else     { Write-Host '      [WARN] Web admin not ready yet, open http://localhost:8088 manually' -ForegroundColor Yellow }

# ---------- done ----------
Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  Services ready:' -ForegroundColor Cyan
Write-Host '    Backend API   : http://localhost:3100'
Write-Host '    Web Admin     : http://localhost:8088'
Write-Host '    Member H5     : http://localhost:8089'
Write-Host '    PWA Cashier   : https://localhost:3443/pwa/'
Write-Host '  Stop: .\start-backend.ps1 -Stop   (also closes the watchdog window)'
Write-Host '============================================' -ForegroundColor Cyan

if (-not $NoBrowser) { Start-Process 'http://localhost:8088/' }
