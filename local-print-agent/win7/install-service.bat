@echo off
REM RedRock Invoice Print Agent - Install as Windows Service (auto-start on boot + auto-restart on crash)
REM Usage: download nssm.exe from https://nssm.cc/download (win32 build works on both 32/64-bit Windows)
REM and put it in this same folder (win7\), next to server.js. Then right-click this .bat file and
REM choose "Run as administrator" (installing a service needs admin rights - double-clicking normally
REM will fail with an access-denied error).
REM
REM 2026-08-14 note: this file was rewritten in plain English after the Chinese-character version
REM caused the console window to close instantly with no output on this machine - same root cause
REM as the serial-bridge.ps1 encoding bug fixed earlier (non-ASCII text breaking non-interactive
REM file parsing on this old Windows 7 setup). Keep this file ASCII-only going forward.

echo ===== RedRock Invoice Print Agent - Install as Windows Service =====
echo.

set NSSM=nssm.exe
where %NSSM% >nul 2>nul
if errorlevel 1 (
  if exist "%~dp0nssm.exe" (
    set NSSM=%~dp0nssm.exe
  ) else (
    echo Could not find nssm.exe.
    echo Please download it from https://nssm.cc/download, copy nssm.exe into this same
    echo folder as this .bat file, or add it to your system PATH, then run this again.
    pause
    exit /b 1
  )
)

set NODE_EXE=
for /f "delims=" %%i in ('where node 2^>nul') do (
  set NODE_EXE=%%i
  goto :found_node
)
:found_node
if "%NODE_EXE%"=="" (
  echo Could not find node.exe - "node -v" did not return anything.
  echo Please make sure Node.js is installed and "node -v" works from a normal
  echo Command Prompt window, then run this again.
  pause
  exit /b 1
)

set SERVICE_NAME=RedRockPrintAgent
set SCRIPT_DIR=%~dp0
set SERVER_JS=%SCRIPT_DIR%server.js

echo Found node.exe at: %NODE_EXE%
echo Using server.js at: %SERVER_JS%
echo.

"%NSSM%" install %SERVICE_NAME% "%NODE_EXE%" "%SERVER_JS%"
"%NSSM%" set %SERVICE_NAME% AppDirectory "%SCRIPT_DIR%"
REM Start automatically on boot, before anyone logs in
"%NSSM%" set %SERVICE_NAME% Start SERVICE_AUTO_START
REM If the process crashes or is killed, restart it after 3 seconds
"%NSSM%" set %SERVICE_NAME% AppRestartDelay 3000
REM Once installed as a service there is no visible console window anymore, so redirect what
REM used to print there (startup banner, [before]/[after] debug logs) into these two log files
REM instead - check them if something needs troubleshooting later.
"%NSSM%" set %SERVICE_NAME% AppStdout "%SCRIPT_DIR%service-stdout.log"
"%NSSM%" set %SERVICE_NAME% AppStderr "%SCRIPT_DIR%service-stderr.log"
REM Rotate log files so they do not grow forever (auto-rotate past 1MB, keeps one old copy)
"%NSSM%" set %SERVICE_NAME% AppRotateFiles 1
"%NSSM%" set %SERVICE_NAME% AppRotateBytes 1048576

echo.
echo ===== Install complete, starting service now... =====
"%NSSM%" start %SERVICE_NAME%

echo.
echo Done! From now on this computer will start the invoice print agent automatically
echo on boot - no need to manually open Command Prompt and run "node server.js" anymore.
echo If the program closes unexpectedly or crashes, it will also restart itself after 3 seconds.
echo.
echo To verify: restart this computer, then just open a browser to http://localhost:3399/
echo without doing anything else manually - you should see the test page if it worked.
echo.
echo To temporarily stop or later remove the service, use uninstall-service.bat in this
echo same folder.
pause
