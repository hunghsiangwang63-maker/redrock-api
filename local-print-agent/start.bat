@echo off
setlocal
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

if exist "nodejs-portable\node.exe" (
  set "PATH=%SCRIPT_DIR%nodejs-portable;%PATH%"
)

if not exist ".env" (
  echo [錯誤] 找不到 .env 設定檔，請先雙擊 install.bat 完成安裝。
  pause
  exit /b 1
)

echo 啟動發票列印代理中，請「不要關閉」這個黑色視窗（關掉列印功能就會停止）...
echo.
node server.js

echo.
echo 程式已結束（可能是被關閉，或發生錯誤）。
pause
