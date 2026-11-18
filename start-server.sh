#!/usr/bin/env sh
# FoCT Virtual Labs - start the lab web server (Linux / macOS).
# Students then open the address printed below in Chrome, Edge or Firefox.
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else
  echo "Python 3 is required (for example: sudo apt install python3)."
  exit 1
fi

if [ ! -f web/runtimes/pyodide/pyodide.mjs ]; then
  echo "The lab runtimes are not installed yet. Downloading them now (about 860 MB, needs internet once)..."
  "$PY" tools/setup.py || { echo "Setup failed. Check the internet connection and try again."; exit 1; }
fi

# Add  --https  to also serve secure mode on port 8443 (see Help > Secure mode).
# Ports below 1024 (e.g. --port 80) need root on Linux.
exec "$PY" server/serve.py "$@"
