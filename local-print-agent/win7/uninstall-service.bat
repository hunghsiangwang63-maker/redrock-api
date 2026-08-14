@echo off
REM RedRock Invoice Print Agent - Uninstall Windows Service (revert to manually running node server.js)
REM Needs administrator rights - right-click this file and choose "Run as administrator". If the
REM window closes immediately or shows "Access is denied", that is why - try again as administrator.
REM
REM 2026-08-14 note: rewritten in plain English, see install-service.bat for why (encoding issue).

set NSSM=nssm.exe
where %NSSM% >nul 2>nul
if errorlevel 1 (
  if exist "%~dp0nssm.exe" (
    set NSSM=%~dp0nssm.exe
  ) else (
    echo Could not find nssm.exe - it should be the same one (or at least the same
    echo version) you used when you first installed the service.
    pause
    exit /b 1
  )
)

set SERVICE_NAME=RedRockPrintAgent

echo Stopping service...
"%NSSM%" stop %SERVICE_NAME%
echo Removing service...
"%NSSM%" remove %SERVICE_NAME% confirm

echo.
echo Removed. If you need to run the invoice print agent again after this, you will
echo need to either manually run "node server.js" again, or run install-service.bat
echo again to reinstall it as a service.
pause
