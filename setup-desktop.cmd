@echo off
setlocal
cd /d "%~dp0"

echo Installing the Laptop Assistant desktop shell...
call npm install
if errorlevel 1 (
  echo.
  echo Desktop setup failed. Check your internet connection and try again.
  pause
  exit /b 1
)

echo.
echo Desktop setup complete. Double-click start-desktop.cmd to launch it.
pause
endlocal
