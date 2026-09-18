@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 20 LTS or newer, then retry.
  echo         Download: https://nodejs.org/
  pause
  exit /b 1
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [INFO] Created .env from .env.example
)

echo [INFO] Starting server... first run may take 1-3 minutes to initialize the database.
echo.
node "scripts\server-up.mjs" up
if errorlevel 1 (
  echo.
  echo [ERROR] Startup failed. See the message above.
  pause
)
endlocal
