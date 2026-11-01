@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" bridge.js run >> "logs\run.log" 2>&1
