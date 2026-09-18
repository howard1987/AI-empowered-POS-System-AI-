@echo off
title POS Test - Staff Mobile PWA
setlocal
set NODE=C:\Users\YL\.workbuddy\binaries\node\versions\22.22.2-2\node.exe
if not exist "%NODE%" set NODE=node
set ROOT=%~dp0
set BACKEND=%ROOT%backend

echo ============================================
echo   Test: STAFF MOBILE  -  PWA http://localhost:3100/pwa/
echo ============================================
echo.

set CODE=000
for /f %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 3 http://localhost:3100/health 2^>nul') do set CODE=%%i
if not "%CODE%"=="200" goto NOBACKEND

set CDP=000
for /f %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 2 http://localhost:9222/json/version 2^>nul') do set CDP=%%i
if "%CDP%"=="200" goto CDPTEST

echo [1/1] No debug Chrome on :9222 - running HTTP smoke instead.
echo       For the full UI walkthrough, start Chrome with:
echo       chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdp-pos
echo.
"%NODE%" "%BACKEND%\tests\_smoke_http.mjs" ^
  "http://localhost:3100/pwa/index.html|html" ^
  "http://localhost:3100/pwa/app.js|PWA" ^
  "http://localhost:3100/pwa/work.js|inventory" ^
  "http://localhost:3100/pwa/checkout.js|IndexedDB" ^
  "http://localhost:3100/pwa/ops2.js|" ^
  "http://localhost:3100/pwa/sign-pad.js|" ^
  "http://localhost:3100/pwa/ai-scan.js|" ^
  "http://localhost:3100/pwa/manifest.webmanifest|name"
set RC1=%ERRORLEVEL%
echo.
echo [2/2] Running full feature simulation pwa_full.mjs - 56 checks, HTTP-only ...
"%NODE%" "%BACKEND%\tests\pwa_full.mjs"
set RC=%ERRORLEVEL%
if not "%RC1%"=="0" set RC=%RC1%
goto RESULT

:CDPTEST
echo [1/1] Debug Chrome found on :9222 - running full PWA walkthrough _cdp_pwa.mjs ...
pushd "%BACKEND%"
"%NODE%" tests\_cdp_pwa.mjs
set RC=%ERRORLEVEL%
popd
goto RESULT

:NOBACKEND
echo [SKIP] Backend :3100 is not running. Start dev environment first.
pause
exit /b 1

:RESULT
echo.
if "%RC%"=="0" echo MOBILE PWA TEST: ALL PASSED
if not "%RC%"=="0" echo MOBILE PWA TEST: FAILED - see output above
pause
exit /b %RC%
