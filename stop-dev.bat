@echo off
title Cashier Dev - Stop
setlocal
echo Stopping dev environment (backend 3100 / web 8088 / h5 8089 / PG 54329) ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach($p in 3100,8088,8089){Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object {Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue}}; $pg=Join-Path '%~dp0backend' 'node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe'; if(Test-Path $pg){& $pg -D 'C:/Users/YL/pgdata-cashier-dev' stop -m fast -ErrorAction SilentlyContinue} else { Write-Host 'pg_ctl not found; skip PG stop. Please stop port 54329 manually.' }"
echo.
echo Stopped. If any node process remains, kill it in Task Manager.
pause
