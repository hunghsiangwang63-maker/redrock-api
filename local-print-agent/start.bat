@echo off
setlocal
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

REM English-only on purpose -- see install.bat for why (Big5/UTF-8 code page mismatch).

if exist "nodejs-portable\node.exe" (
  set "PATH=%SCRIPT_DIR%nodejs-portable;%PATH%"
)

if not exist ".env" (
  echo [ERROR] .env config file not found. Please run install.bat first.
  pause
  exit /b 1
)

echo Starting the invoice print agent, please DO NOT close this window
echo (closing it stops printing)...
echo.
node server.js

echo.
echo The program has stopped (it may have been closed, or an error occurred).
pause
