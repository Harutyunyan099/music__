@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting muzzz...
py -3 server.py 2>nul || python server.py 2>nul || python3 server.py
if errorlevel 1 (
  echo.
  echo Python not found: https://www.python.org/downloads/
  pause
)
