#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
export OPEN_BROWSER=1
echo "Starting muzzz..."
if command -v python3 >/dev/null 2>&1; then
  python3 server.py
elif command -v python >/dev/null 2>&1; then
  python server.py
else
  echo "Python is not installed: https://www.python.org/downloads/"
  read -r -p "Press Enter to close"
fi
