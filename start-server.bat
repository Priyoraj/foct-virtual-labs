@echo off
rem FoCT Virtual Labs - start the lab web server (Windows).
rem Students then open the address printed below in Chrome or Edge.
title FoCT Virtual Labs server
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  where py >nul 2>nul
  if errorlevel 1 (
    echo Python 3 is required. Install it from https://www.python.org/downloads/
    echo and tick "Add python.exe to PATH" during installation.
    pause
    exit /b 1
  )
  set PY=py -3
) else (
  set PY=python
)

if not exist "web\runtimes\pyodide\pyodide.mjs" (
  echo The lab runtimes are not installed yet. Downloading them now ^(about 860 MB, needs internet once^)...
  %PY% tools\setup.py
  if errorlevel 1 (
    echo Setup failed. Check the internet connection and run start-server.bat again.
    pause
    exit /b 1
  )
)

rem Add  --https  below to also serve secure mode on port 8443 (see Help > Secure mode).
%PY% server\serve.py %*
pause
