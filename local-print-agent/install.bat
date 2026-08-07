@echo off
setlocal
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo 已建立 .env 設定檔（等一下要記得改 COM 埠編號，見下方說明）
  echo.
)

if exist "nodejs-portable\node.exe" (
  set "PATH=%SCRIPT_DIR%nodejs-portable;%PATH%"
  echo 使用隨附的免安裝版 Node.js
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [錯誤] 找不到 Node.js。
    echo.
    echo 請到 https://nodejs.org/en/download 下載「Windows Binary (.zip)」版本，
    echo 解壓縮後，把裡面那個資料夾（裡面應該要看得到 node.exe）整個改名為
    echo   nodejs-portable
    echo 然後搬到跟這個 install.bat 同一層資料夾裡，再重新執行一次這個檔案。
    echo.
    pause
    exit /b 1
  )
  echo 使用系統已安裝的 Node.js
)

echo.
echo 正在安裝套件，請稍候（第一次可能要一兩分鐘）...
call npm install
if errorlevel 1 (
  echo.
  echo [錯誤] 安裝失敗，請把這個視窗的內容截圖回報。
  pause
  exit /b 1
)

echo.
echo ================================================
echo 安裝完成！接下來：
echo   1. 用記事本打開這個資料夾裡的 .env 檔案
echo   2. 把 SERIAL_PORT 改成正確的 COM 埠編號（去「裝置管理員」查）
echo   3. 存檔後，雙擊 start.bat 啟動
echo ================================================
pause
