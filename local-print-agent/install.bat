@echo off
setlocal
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

REM NOTE: This file is intentionally English-only. Traditional Chinese Windows
REM defaults cmd.exe to the Big5 (CP950) code page, but this file is saved as
REM UTF-8 -- cmd would misread Chinese text (comments, echo, etc.) as garbled
REM bytes and try to run them as commands, producing endless
REM "not recognized as an internal or external command" errors. Keep this
REM file free of any non-ASCII characters so it runs correctly on any PC
REM regardless of its code page setting (this tool gets deployed to multiple
REM store computers).

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env config file (remember to set the COM port below)
  echo.
)

if exist "nodejs-portable\node.exe" (
  set "PATH=%SCRIPT_DIR%nodejs-portable;%PATH%"
  echo Using bundled portable Node.js
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo.
    echo Please download the "Windows Binary (.zip)" from https://nodejs.org/en/download
    echo Unzip it, rename the folder inside (the one containing node.exe) to
    echo   nodejs-portable
    echo then move it next to this install.bat, and run this file again.
    echo.
    pause
    exit /b 1
  )
  echo Using system-installed Node.js
)

echo.
echo Installing packages, please wait (first run may take a minute or two)...
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] Install failed. Please screenshot this window and report it.
  pause
  exit /b 1
)

echo.
echo ================================================
echo Install complete! Next steps:
echo   1. Open the .env file in this folder with Notepad
echo   2. Set SERIAL_PORT to the correct COM port (check Device Manager)
echo   3. Save, then double-click start.bat to launch
echo ================================================
pause
