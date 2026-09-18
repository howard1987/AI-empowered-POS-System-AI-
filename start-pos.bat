@echo off
rem ============================================================
rem  POS System One-Click Starter
rem  Starts the runtime watchdog, which checks every 5 seconds:
rem    - PostgreSQL      : 127.0.0.1:54329  (auto start if down)
rem    - Backend API     : http://localhost:3100  (+ HTTPS :3443)
rem    - Web Admin       : http://localhost:8088
rem  Any downed service is restarted automatically.
rem  Keep this window open (minimized is fine), or close it -
rem  the watchdog and services keep running in background.
rem ============================================================
setlocal
cd /d "%~dp0"

set NODEEXE=node
where node >nul 2>nul || set NODEEXE=C:\Users\YL\.workbuddy\binaries\node\versions\22.22.2-2\node.exe

rem avoid duplicate watchdog: exit if port 3100 already served
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',3100);$c.Close();exit 0}catch{exit 1}" >nul 2>nul
if %errorlevel%==0 (
  echo [INFO] POS backend already running on port 3100. Nothing to do.
  timeout /t 3 >nul
  exit /b 0
)

echo [INFO] Starting POS runtime watchdog...
start "POS-Watchdog" /min "%NODEEXE%" runtime-watchdog.mjs
timeout /t 6 >nul

echo [INFO] Done. Services:
echo    Backend API : http://localhost:3100
echo    Web Admin   : http://localhost:8088
echo    PWA mobile  : https://192.168.0.5:3443/pwa/  (or https://pos-server.local:3443/pwa/)
echo [INFO] Watchdog auto-restarts any crashed service. You can close this window.
timeout /t 8 >nul
endlocal
