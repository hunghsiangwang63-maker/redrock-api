@echo off
REM RedRock 發票列印代理 - 安裝成 Windows 服務（開機自動啟動 + 當掉自動重啟）
REM 用法：把 nssm.exe（https://nssm.cc/download 下載，32/64 位元視這台機器而定）放到
REM 跟這個 .bat 同一個資料夾（win7\），或先加進系統 PATH，再直接雙擊這個 .bat 執行。
REM 需要系統管理員權限——如果雙擊後立刻關閉視窗或出現「拒絕存取」，改成「以系統管理員身分執行」。

echo ===== RedRock 發票列印代理 - 安裝成 Windows 服務 =====
echo.

set NSSM=nssm.exe
where %NSSM% >nul 2>nul
if errorlevel 1 (
  if exist "%~dp0nssm.exe" (
    set NSSM=%~dp0nssm.exe
  ) else (
    echo 找不到 nssm.exe。
    echo 請先到 https://nssm.cc/download 下載，把裡面的 nssm.exe 複製到跟這個 .bat 同一個資料夾
    echo （win7\），或加進系統 PATH，再重新執行這個 .bat。
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
  echo 找不到 node.exe（跑 node -v 沒有反應）。請確認 Node.js 已安裝、且能在命令提示字元
  echo 正常執行 node -v 之後，再重新執行這個 .bat。
  pause
  exit /b 1
)

set SERVICE_NAME=RedRockPrintAgent
set SCRIPT_DIR=%~dp0
set SERVER_JS=%SCRIPT_DIR%server.js

echo 找到 Node.exe：%NODE_EXE%
echo 對應的 server.js：%SERVER_JS%
echo.

"%NSSM%" install %SERVICE_NAME% "%NODE_EXE%" "%SERVER_JS%"
"%NSSM%" set %SERVICE_NAME% AppDirectory "%SCRIPT_DIR%"
REM 開機自動啟動（不用等有人登入）
"%NSSM%" set %SERVICE_NAME% Start SERVICE_AUTO_START
REM 程式當掉／被關掉，3 秒後自動重啟（NSSM 內建行為，這裡只是明確設定間隔）
"%NSSM%" set %SERVICE_NAME% AppRestartDelay 3000
REM 把原本印在黑底視窗的訊息（開機banner、[執行前]/[執行後] 除錯記錄）改寫進這兩個檔案，
REM 因為裝成服務後背景執行、不再有終端機視窗可以看——事後排查問題要看這兩個 log 檔。
"%NSSM%" set %SERVICE_NAME% AppStdout "%SCRIPT_DIR%service-stdout.log"
"%NSSM%" set %SERVICE_NAME% AppStderr "%SCRIPT_DIR%service-stderr.log"
REM log 檔案輪替，避免長期執行後檔案無限長大（超過 1MB 自動輪替保留一份舊檔）
"%NSSM%" set %SERVICE_NAME% AppRotateFiles 1
"%NSSM%" set %SERVICE_NAME% AppRotateBytes 1048576

echo.
echo ===== 安裝完成，啟動服務中... =====
"%NSSM%" start %SERVICE_NAME%

echo.
echo 完成！之後這台電腦開機會自動啟動發票列印代理，不用再手動開命令提示字元打
echo node server.js；程式如果意外關閉或當掉，也會在 3 秒後自動重新啟動。
echo.
echo 驗證方式：重開機後，直接開瀏覽器到 http://localhost:3399/ 應該就能看到測試頁
echo （不需要先手動啟動任何東西）。
echo.
echo 如果要暫時停用／之後想移除服務，用同一個資料夾的 uninstall-service.bat。
pause
