@echo off
title PlanPilot (polish copy)
cd /d "%~dp0"
echo.
echo   Starting the PlanPilot POLISH COPY on port 3001...
echo   Your browser will open in a few seconds.
echo   Keep this window open while you use it. Close it to stop.
echo.
start "" cmd /c "timeout /t 10 >nul & start http://localhost:3001/"
npm run dev -- --port 3001
