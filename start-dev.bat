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

REM ----------------------------------------------------------------------
REM PostgreSQL is provided ONLY by the stable Windows service pos-cashier-pg.
REM The service runs as LocalService, unaffected by UAC/admin tokens, and does
REM not pop a console window -- this avoids the old watchdog wrongly thinking
REM PG is dead and restarting postgres every minute (the "cmd flash" storm).
REM ----------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Service -Name 'pos-cashier-pg' -ErrorAction SilentlyContinue) { 'YES' }" 2>nul | findstr /i "YES" >nul
if errorlevel 1 (
  echo   [ERROR] Windows service "pos-cashier-pg" not found.
  echo   Please register the PostgreSQL service first - see docs / support.
  pause
  exit /b 1
)
net start pos-cashier-pg >nul 2>&1
if errorlevel 1 (
  echo   [note] net start returned %errorlevel% - service may already be running.
)

REM ----------------------------------------------------------------------
REM Backend / Web / H5 are taken over by a lightweight hidden launcher,
REM dev-launch.mjs. It uses detached + windowsHide so there is no visible
REM window, it does not manage PG, and it will not trigger a restart storm.
REM dev-launch probes by port, so running this script repeatedly will not
REM start duplicate child services.
REM ----------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%launch-dev.ps1"

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
for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$h=try{Invoke-RestMethod http://localhost:3100/health -TimeoutSec 2}catch{$null}; if($h.data.db -eq 'ok' -or $h.db -eq 'ok'){'OK'}" 2^>nul') do set DBOK=%%i
if "%DBOK%"=="OK" goto API_OK
if %TRIES% geq 90 goto API_FAIL
set /a "M=TRIES %% 20"
if "%M%"=="0" echo   ... still waiting (%TRIES%s)
goto WAIT_API
:API_FAIL
echo.
echo   [ERROR] Backend DB not ready after 90s.
echo   Most likely cause: PostgreSQL service not running, or the backend failed
echo   to start. Check logs:
echo     backend\logs\dev-launch.err.log
echo     backend\logs\error.log
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
echo   (dev-launch.mjs keeps backend/web/h5 alive in the background;
echo    stop-dev.bat stops them AND the pos-cashier-pg service)
echo.
echo This window will close in 5 seconds ...
timeout /t 5 /nobreak >nul
exit
