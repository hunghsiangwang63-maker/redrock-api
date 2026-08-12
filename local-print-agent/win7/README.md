# 發票列印代理 · Windows 7 版

這是 `../server.js`（Mac/Win10+，用 `serialport` 套件直接讀寫序列埠）的 **Windows 7 專用替代版本**。

## 為什麼要分開一份

`serialport` npm 套件需要 **Node.js >=20** 才能編譯它的原生模組；但 Node.js 從 v14 起就不再支援
Windows 7（**v13.14.0 是最後一個官方支援 Win7 的版本**）——兩者要求互相衝突，`../server.js` 那份
在 Win7 上完全裝不起來。

這份改成：
- 序列埠 I/O 完全不用 `serialport` 套件，改呼叫 `serial-bridge.ps1`（PowerShell 內建的
  `System.IO.Ports.SerialPort`，Win7 機器上的 .NET Framework 本來就有，不用另外裝任何東西）。
- HTTP 層用 **Express 4**（相容非常舊的 Node，不像 `../server.js` 用的 Express 5 要求 Node>=18）。

發票版面排版、測試頁跟 `../server.js` 共用同一份程式碼（`../lib/`），行為應該一致；只有「怎麼把
位元組送到 COM 埠」這件事的實作不同。

## 安裝步驟

### 1. 在這台 Win7 電腦裝 Node.js v13.14.0

到 `https://nodejs.org/dist/v13.14.0/` 下載對應版本的安裝檔（32/64 位元視這台機器而定，裝置管理員
或「系統資訊」可查）。**不要裝最新版**，新版 Node 裝不上 Win7（安裝檔會直接拒絕執行或裝完無法啟動）。

裝完後開「命令提示字元」跑 `node -v` 確認顯示 `v13.14.0`。

### 2. 確認印表機 COM 埠編號

USB 轉 RS-232 轉接線插上這台電腦 → 控制台 → 裝置管理員 → 展開「連接埠 (COM 與 LPT)」→ 找到類似
「USB Serial Port (COM3)」的項目，記下 COM 編號（等一下要填進 `.env`）。

### 3. 把整個 `local-print-agent` 資料夾複製過來

**在別台正常的電腦上**（Mac／Win10／Win11 皆可）先把整個 `local-print-agent` 資料夾（含這個
`win7` 子資料夾）裝好套件，再整包複製到這台 Win7 電腦（USB 隨身碟或內部網路芳鄰都可以）——
**不要在 Win7 上直接跑 `npm install`**，這台機器的 npm 版本太舊，連線 npm 官方套件庫時很容易因為
系統內建的舊憑證（CA 憑證）過期而失敗；先在別台正常機器裝好，Win7 這邊只需要「執行」不需要
「安裝」，就不會撞到這個問題。

在**別台機器**上（不是 Win7）依序執行：

```bash
cd local-print-agent/lib
npm install
cd ../win7
npm install
```

確認 `lib/node_modules` 跟 `win7/node_modules` 都有東西之後，把**整個 `local-print-agent` 資料夾**
複製到 Win7 電腦（例如 `C:\redrock-print-agent\`）。這兩個套件都是純 JavaScript、沒有任何需要編譯
的原生模組，跨平台複製 `node_modules` 是安全的（這也是這份 Win7 版本刻意完全避開 `serialport`
這類原生模組套件的原因之一）。

**不需要**動到根目錄的 `../server.js`、`../package.json`、`../node_modules`（那些是給 Mac/Win10+
機器用的，在 Win7 上放著不會被用到、也不會出錯，忽略即可）。

### 4. 設定 `.env`

在 Win7 電腦的 `local-print-agent\win7\` 資料夾裡，把 `.env.example` 複製一份改名 `.env`，
把 `SERIAL_PORT` 改成步驟 2 查到的實際 COM 編號（例如 `SERIAL_PORT=COM3`）。

### 5. 啟動測試

在 Win7 電腦開命令提示字元：

```
cd C:\redrock-print-agent\win7
npm start
```

看到「✅ 發票列印代理已啟動（Windows 7 版）」代表啟動成功。**在這台 Win7 電腦自己的瀏覽器**
（不是遠端別台機器）開 `http://localhost:3399/`，會看到內建的測試頁——先點「🔌 檢查連線狀態」
確認 `connected:true`，再試「🖨️ 測試列印」跟「💰 單獨開錢櫃」，確認紙有正確印出、錢櫃有彈開。

## 已知風險 / 尚未實機驗證的部分

- **`serial-bridge.ps1` 這支腳本目前只在程式碼審閱層面驗證過協定正確性，尚未在真實 Windows 7 +
  WP-560 上實機測試過**（開發機是 Mac，跑不了 PowerShell）。所用的通訊協定（ESC/POS 位元組序列、
  `DLE EOT n` 查詢、紙張感應器判讀極性）跟 `../server.js` 已實機驗證過的版本完全相同，理論上行為
  一致，但 PowerShell 的 `System.IO.Ports.SerialPort` 跟 Node 的 `serialport` 套件底層實作不同，
  **第一次在真機測試時請務必照上面「5. 啟動測試」的步驟走一次、確認三個按鈕都正常**，如果有任何
  一步跟預期不同（例如紙張定位查詢結果相反、開錢櫃沒反應），把錯誤訊息或現象回報回來再一起排查。
- **Windows 7 本身已於 2020 年停止微軟安全更新（EOL）**，用來跑 POS/收款相關程式存在一定資安風險
  （作業系統層級的已知漏洞不會再修補）。這不是這份程式能解決的問題，只是提醒——長期建議評估是否
  能換一台支援中的作業系統的機器。
- 目前**尚未**把這個版本裝成 Windows 服務開機自動啟動（根目錄的 `install-service.js` 是為
  `../server.js` 那份寫的，且它依賴的 `node-windows` 套件在這麼舊的 Node/Windows 組合上未經測試）。
  先確認上面「5. 啟動測試」都正常運作後，再討論要不要疊加開機自啟——如果 `node-windows` 在這台機器
  上有問題，NSSM（Non-Sucking Service Manager，一個獨立小工具、不依賴 Node 生態系）是對舊
  Windows 更成熟穩妥的替代方案。
