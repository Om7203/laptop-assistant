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

echo Applying the Windows permission required by Electron's secure sandbox...
icacls "%~dp0node_modules\electron\dist" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /T /C >nul
if errorlevel 1 (
  echo.
  echo Windows could not apply the Electron sandbox permission.
  echo Right-click this setup file and select "Run as administrator", then try again.
  pause
  exit /b 1
)

echo.
echo Desktop setup complete. Double-click start-desktop.cmd to launch it.
pause
endlocal
