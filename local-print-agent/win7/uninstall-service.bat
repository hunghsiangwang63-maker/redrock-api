@echo off
REM RedRock 發票列印代理 - 移除 Windows 服務（還原成手動 node server.js 執行）
REM 需要系統管理員權限——如果雙擊後立刻關閉視窗或出現「拒絕存取」，改成「以系統管理員身分執行」。

set NSSM=nssm.exe
where %NSSM% >nul 2>nul
if errorlevel 1 (
  if exist "%~dp0nssm.exe" (
    set NSSM=%~dp0nssm.exe
  ) else (
    echo 找不到 nssm.exe（跟安裝時用的要是同一個，或至少同版本）。
    pause
    exit /b 1
  )
)

set SERVICE_NAME=RedRockPrintAgent

echo 停止服務中...
"%NSSM%" stop %SERVICE_NAME%
echo 移除服務中...
"%NSSM%" remove %SERVICE_NAME% confirm

echo.
echo 已移除。之後要跑發票列印代理，需要重新手動執行 node server.js（或重新跑
echo install-service.bat 裝回服務）。
pause
