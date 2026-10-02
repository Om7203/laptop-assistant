@echo off
setlocal
cd /d "%~dp0"

if not defined OPENAI_API_KEY if not exist "config\openai-key.dpapi" (
  echo First-time setup is required.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
  if errorlevel 1 pause & exit /b 1
)

start "Laptop Assistant" /min node src\server.js
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3199"
endlocal
