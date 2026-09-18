@echo off
title POS Test - Server (backend e2e)
setlocal
set NODE=C:\Users\YL\.workbuddy\binaries\node\versions\22.22.2-2\node.exe
if not exist "%NODE%" set NODE=node
set ROOT=%~dp0
set BACKEND=%ROOT%backend

echo ============================================
echo   Test: SERVER  -  backend :3100
echo ============================================
echo.

set CODE=000
for /f %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 3 http://localhost:3100/health 2^>nul') do set CODE=%%i

if not "%CODE%"=="200" goto STANDALONE

echo [1/1] Backend is up - running e2e_full.mjs, 51 checks, HTTP-only, read-only DB audit ...
pushd "%BACKEND%"
"%NODE%" tests\e2e_full.mjs
set RC=%ERRORLEVEL%
popd
goto RESULT

:STANDALONE
echo [1/3] Backend NOT running - running standalone integration test instead.
echo [1/3] Compiling backend with tsc ...
pushd "%BACKEND%"
call npm run build
if errorlevel 1 goto BUILDFAIL
echo [2/3] Running e2e.mjs - spins up its own embedded PG 54329 and backend 3100 ...
"%NODE%" tests\e2e.mjs
set RC=%ERRORLEVEL%
popd
goto RESULT

:BUILDFAIL
echo BUILD FAILED
popd
pause
exit /b 1

:RESULT
echo.
if "%RC%"=="0" echo SERVER TEST: ALL PASSED
if not "%RC%"=="0" echo SERVER TEST: FAILED - see output above
pause
exit /b %RC%
