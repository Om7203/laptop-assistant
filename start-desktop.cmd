@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-desktop.ps1"
if errorlevel 1 (
  echo.
  echo Goffy could not start. The error is shown above.
  pause
  exit /b 1
)
endlocal
