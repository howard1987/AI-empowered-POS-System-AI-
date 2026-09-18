@echo off
setlocal
set NODE=C:\Users\YL\.workbuddy\binaries\node\versions\22.22.2-3\node.exe
set ROOT=%~dp0

REM V4.25.8: respawn ourselves minimized and close the original window immediately.
REM After that only one minimized startup window stays until services are ready.
if /I not "%~1"=="min" (
  start /min "" "%~f0" min
  exit /b
)

title Cashier Dev Environment

echo ============================================
echo   Cashier POS - Dev Environment
echo   Backend API   http://localhost:3100
echo   Web Admin     http://localhost:8088
echo   H5 Member     http://localhost:8089
echo   PWA Cashier   https://localhost:3443/pwa/
echo ============================================
echo.

REM V4.26.2: PostgreSQL refuses to start with Administrator privileges.
REM But first: if PG is already up, or the Windows service exists (watchdog
REM starts it with LocalService, which bypasses the admin-token restriction),
REM there is nothing to warn about - just carry on.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Test-NetConnection -ComputerName 127.0.0.1 -Port 54329 -InformationLevel Quiet -WarningAction SilentlyContinue" 2>nul | findstr /i "True" >nul
if not errorlevel 1 goto NO_ADMIN
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Service -Name 'pos-cashier-pg' -ErrorAction SilentlyContinue) { 'YES' }" 2>nul | findstr /i "YES" >nul
if not errorlevel 1 (
  echo   PostgreSQL will be started via Windows service "pos-cashier-pg".
  goto NO_ADMIN
)
REM net session succeeds only with an admin token. UAC may also be disabled
REM (EnableLUA=0), which forces EVERY process on this PC to run elevated.
net session >nul 2>&1
if errorlevel 1 goto NO_ADMIN
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v EnableLUA 2>nul | findstr /i "0x0" >nul
if not errorlevel 1 goto UAC_OFF
echo.
echo   [WARN] Administrator privileges detected.
echo   PostgreSQL REFUSES to start as Administrator, so DB will never
echo   become ready and this script would hang at [2/3].
echo.
echo   FIX: close this window, then double-click start-dev.bat
echo        normally in Explorer. Do NOT use "Run as administrator".
echo.
pause
goto NO_ADMIN
:UAC_OFF
echo.
echo   [WARN] UAC is DISABLED on this PC (EnableLUA=0), so EVERY program
echo   runs with full Administrator rights - double-clicking does not help.
echo   PostgreSQL REFUSES to start as Administrator, so DB will never
echo   become ready and this script would hang at [2/3].
echo.
echo   FIX A (recommended): re-enable UAC in an ADMIN PowerShell, then REBOOT:
echo     reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v EnableLUA /t REG_DWORD /d 1 /f
echo.
echo   FIX B: register PostgreSQL as a Windows service under a non-admin
echo   account (no reboot, no UAC change) - ask support for the setup script.
echo.
pause
:NO_ADMIN

REM The watchdog keeps PG/backend/web/h5 alive. Only its minimized window remains.
start "cashier-watchdog" /min cmd /k "cd /d %ROOT% && %NODE% runtime-watchdog.mjs"

echo [1/3] Waiting for PostgreSQL :54329 ...
set /a TRIES=0
:WAIT_PG
timeout /t 1 /nobreak >nul
set /a TRIES+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Test-NetConnection -ComputerName 127.0.0.1 -Port 54329 -InformationLevel Quiet -WarningAction SilentlyContinue" 2>nul | findstr /i "True" >nul
if errorlevel 1 (
  if %TRIES% geq 120 (
    echo   [WARN] PG not reachable after 120 retries. Backend may report DB error.
    goto WAIT_API
  )
  goto WAIT_PG
)
echo   OK - PostgreSQL is up

echo [2/3] Waiting for backend :3100 (DB ready) ...
set /a TRIES=0
:WAIT_API
timeout /t 1 /nobreak >nul
set /a TRIES+=1
set DBOK=
REM V4.26.2: health returns {code,msg,data:{db:'ok'}} - must read $h.data.db,
REM NOT $h.db (always empty) which made [2/3] wait forever even with a healthy backend.
for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$h=try{Invoke-RestMethod http://localhost:3100/health -TimeoutSec 2}catch{$null}; if($h.data.db -eq 'ok' -or $h.db -eq 'ok'){'OK'}" 2^>nul') do set DBOK=%%i
if "%DBOK%"=="OK" goto API_OK
if %TRIES% geq 90 goto API_FAIL
set /a "M=TRIES %% 20"
if "%M%"=="0" echo   ... still waiting (%TRIES%s)
goto WAIT_API
:API_FAIL
echo.
echo   [ERROR] Backend DB not ready after 90s.
echo   Most likely cause: PostgreSQL refuses to run with Administrator
echo   privileges. Other causes: PG crash-recovery still running, or the
echo   backend failed to start.
echo.
echo   FIX: close this window and double-click start-dev.bat normally
echo        (do NOT "Run as administrator").
echo   LOGS: runtime-watchdog.log
echo         %%TEMP%%\pg-cashier-dev.log
echo.
pause
exit /b 1
:API_OK
echo   OK - backend is up and DB is ready

echo [3/3] Waiting for web admin :8088 ...
set /a TRIES=0
:WAIT_WEB
timeout /t 1 /nobreak >nul
set /a TRIES+=1
set CODE=000
for /f %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 2 http://localhost:8088/ 2^>nul') do set CODE=%%i
if not "%CODE%"=="200" (
  if %TRIES% geq 60 (
    echo   [WARN] Web admin not ready yet. You can still open http://localhost:8088 manually.
    goto OPEN
  )
  goto WAIT_WEB
)
echo   OK - web admin is up

:OPEN
echo.
echo All ready. Opening browser ...
start "" http://localhost:8088/
echo.
echo To stop: run stop-dev.bat
echo (the watchdog keeps running in the minimized "cashier-watchdog" window;
echo  close that window, then run stop-dev.bat to stop all services incl. PG)
echo.
echo This window will close in 5 seconds ...
timeout /t 5 /nobreak >nul
exit
