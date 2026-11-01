@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" bridge.js set-key
echo.
pause
