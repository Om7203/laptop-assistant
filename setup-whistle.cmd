@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-whistle.ps1"
if errorlevel 1 pause
