@echo off
title PlanPilot
cd /d "%~dp0"
echo.
echo   Starting PlanPilot...
echo   Your browser will open in a few seconds.
echo   Keep this window open while you use the app. Close it to stop PlanPilot.
echo.
start "" cmd /c "timeout /t 10 >nul & start http://localhost:3000/"
npm run dev
