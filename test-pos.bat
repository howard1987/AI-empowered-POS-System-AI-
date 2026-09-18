@echo off
title POS Test - Cashier Desktop, Electron POS
setlocal
set NODE=C:\Users\YL\.workbuddy\binaries\node\versions\22.22.2-2\node.exe
if not exist "%NODE%" set NODE=node
set ROOT=%~dp0
set DESK=%ROOT%frontend-desktop

echo ============================================
echo   Test: CASHIER DESKTOP  -  Electron POS
echo ============================================
echo.

echo [1/2] Print template smoke - 58/80mm receipt and A5, no Electron needed ...
pushd "%DESK%"
"%NODE%" src\print\smoke.js
if errorlevel 1 goto PRINTFAIL
echo.

REM UI smoke drives the real Electron window; it needs the backend on :3100.
set CODE=000
for /f %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 3 http://localhost:3100/health 2^>nul') do set CODE=%%i
if "%CODE%"=="200" goto UISMOKE

echo [2/2] SKIPPED: backend :3100 is not running. Start dev environment first, then re-run.
popd
pause
exit /b 0

:UISMOKE
REM Some host environments export ELECTRON_RUN_AS_NODE=1 which turns electron.exe
REM into plain node - clear it so the real Electron UI can start.
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
echo [2/2] Electron UI smoke - screenshots go to frontend-desktop\smoke-out ...
"%NODE%" node_modules\electron\cli.js ui-smoke.js
set RC=%ERRORLEVEL%
popd
echo.
if "%RC%"=="0" echo DESKTOP TEST: ALL PASSED - check smoke-out for screenshots
if not "%RC%"=="0" echo DESKTOP TEST: FAILED - see frontend-desktop\smoke-debug.log
pause
exit /b %RC%

:PRINTFAIL
echo PRINT SMOKE FAILED
popd
pause
exit /b 1
