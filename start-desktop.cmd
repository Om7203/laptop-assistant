@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo The desktop shell is not installed yet.
  echo Double-click setup-desktop.cmd first.
  pause
  exit /b 1
)

start "Laptop Assistant" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\main.js"
endlocal
