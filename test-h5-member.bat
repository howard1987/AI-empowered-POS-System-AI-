@echo off
title POS Test - Member H5
setlocal
set NODE=C:\Users\YL\.workbuddy\binaries\node\versions\22.22.2-2\node.exe
if not exist "%NODE%" set NODE=node
set ROOT=%~dp0
set H5=%ROOT%frontend-h5

echo ============================================
echo   Test: MEMBER H5  -  http://localhost:8089
echo ============================================
echo.

REM --- H5 static server: start it if not already up ---
set CODE=000
for /f %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 3 http://localhost:8089/ 2^>nul') do set CODE=%%i
if "%CODE%"=="200" goto H5UP

echo [0/2] H5 server :8089 not running - starting it in a minimized window ...
start "cashier-h5" /min cmd /c "cd /d %H5% && "%NODE%" server.mjs"
set /a TRIES=0

:WAIT_H5
timeout /t 1 /nobreak >nul
set /a TRIES+=1
set CODE=000
for /f %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 2 http://localhost:8089/ 2^>nul') do set CODE=%%i
if "%CODE%"=="200" goto H5UP
if %TRIES% lss 15 goto WAIT_H5
echo   [ERROR] H5 server failed to start.
pause
exit /b 1

:H5UP
echo [0/2] H5 server :8089 is up.

REM --- Backend is needed for H5 API calls ---
set CODE=000
for /f %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 3 http://localhost:3100/health 2^>nul') do set CODE=%%i
if "%CODE%"=="200" goto BACKENDOK
echo [SKIP] Backend :3100 is not running - H5 API test needs it. Start dev environment first.
pause
exit /b 1

:BACKENDOK
set CDP=000
for /f %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 2 http://localhost:9222/json/version 2^>nul') do set CDP=%%i
if "%CDP%"=="200" goto CDPTEST

echo [1/2] No debug Chrome on :9222 - running HTTP smoke instead.
echo       For the full UI walkthrough, start Chrome with:
echo       chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdp-pos
echo [2/2] Checking H5 static assets and health ...
"%NODE%" "%ROOT%backend\tests\_smoke_http.mjs" ^
  "http://localhost:8089/|html" ^
  "http://localhost:8089/app.js|localStorage" ^
  "http://localhost:8089/styles.css|" ^
  "http://localhost:3100/health|"
set RC=%ERRORLEVEL%
goto RESULT

:CDPTEST
echo [1/2] Debug Chrome found on :9222 - running full H5 walkthrough _cdp_h5.mjs ...
echo       Member register + scan-to-buy + checkout + exit code, screenshot to backend\e2e-out-h5-scan.png
pushd "%ROOT%backend"
"%NODE%" tests\_cdp_h5.mjs
set RC=%ERRORLEVEL%
popd
goto RESULT

:RESULT
echo.
if "%RC%"=="0" echo MEMBER H5 TEST: ALL PASSED
if not "%RC%"=="0" echo MEMBER H5 TEST: FAILED - see output above
pause
exit /b %RC%
