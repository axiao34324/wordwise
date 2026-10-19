@echo off
rem WordWise launcher
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
where node >nul 2>nul || (
  echo Node.js not found in PATH. Please install Node.js first.
  pause
  exit /b 1
)
node node_modules\electron\cli.js .
