# 紅石發票列印代理（本地代理，跑在櫃檯電腦）

驅動 WinPOS WP-560 二聯式發票機的小程式。跑在**每一台有接發票機的櫃檯電腦**上，
開一個 `http://localhost:3399`，供員工端網頁（`staff.redrocktaiwan.com`）呼叫來實際印票。

完整背景/決策見 `../docs/invoice-integration-plan.md`（第 3、5.1、5.5 節）。

## 目前狀態（2026-08-06）

- ✅ 通訊協定、中文列印、自動對位裁切，已於 2026-07-31 用舊機+USB轉RS232 實測驗證通過。
- ✅ 本檔（`server.js`）已把驗證結果整理成正式服務，含 `/print` `/status` `/open-drawer` 三端點。
- ✅ **`/open-drawer` 已於 2026-08-06 實機測試通過**——RJ11 錢櫃接上後，單獨開櫃、以及「現金付款列印發票同時開櫃」（`/print` 帶 `openDrawer:true`）皆一次測試成功。硬體/通訊層至此無殘留風險。
- ✅ **已接上 RedRock 系統一部分**：員工端「每日結帳」頁面的「💰 獨立開錢箱」按鈕會直接呼叫本代理的 `/open-drawer`（供找零準備/交接點鈔用），已上線可用（前提：這台代理要先啟動）。
- ⏳ **完整發票收款流程尚未接上**（`InvoiceCheckout`+`InvoicePrinter` adapter，P3/P4，見 `invoice-integration-plan.md` 第 6 節）——目前實際開立發票仍走現有的手動記帳 modal（不會真的列印），本代理目前只能用內建測試頁或「獨立開錢箱」按鈕手動觸發。
- ⏳ 還沒打包成 Windows 服務/開機自啟，目前是手動 `npm start` 跑在前景（且目前僅在開發者 Mac 上驗證，尚未部署到櫃檯正式電腦）。

## 安裝（Windows 櫃檯電腦）

1. **安裝 Node.js**（LTS 版即可）：<https://nodejs.org/> 下載安裝。
2. **插上 USB 轉 RS-232 轉接線**，接發票機，開機。
3. **查 COM 埠編號**：開始選單搜尋「裝置管理員」→「連接埠 (COM 與 LPT)」→ 應該會看到類似
   `USB-SERIAL CH340 (COM3)` 的項目，記下 `COM` 後面的數字。
4. 打開這個資料夾，複製 `.env.example` 改名成 `.env`，把 `SERIAL_PORT` 改成剛查到的 `COM3`（依實際數字）。
5. 開命令提示字元（cmd），`cd` 到這個資料夾，執行：
   ```
   npm install
   npm start
   ```
6. 看到 `✅ 發票列印代理已啟動：http://localhost:3399` 就是成功了。
7. 瀏覽器打開 `http://localhost:3399` 會看到內建測試頁，可以直接按「測試列印」印一張確認。

## 硬體確認事項（2026-07-31 已排查、正式機也要照做）

- **DIP2 開關第 3 顆（機身底部）務必撥到 OFF**——出廠預設是別的指令集，不撥的話機器完全不理會 ESC/POS
  指令（連進紙都沒反應）。斷電後翻到機身底部，用原子筆尖撥動。
- 面板紅燈是這台機器的**正常狀態**，不是錯誤燈號，不要拿它當診斷依據。
- 色帶（IR-71 相容）舊了會印得偏淡但堪讀；建議正式上線前換一捲新的。

## 錢櫃（已完成，2026-08-06）

- ✅ RJ11（4線）錢櫃已接上、`ESC p` 開櫃指令（脈衝參數 `0x1B, 0x70, 0x00, 25, 250`）第一次測試即成功，未調整參數。
- ✅ 單獨開櫃（測試頁按鈕／`POST /open-drawer`／員工端「今日結帳」頁「獨立開錢箱」按鈕）與「列印發票同時開櫃」（`POST /print` 帶 `openDrawer:true`）皆已驗證。
- 若之後換一台不同型號的錢櫃、開櫃沒反應：檢查 `server.js` 裡 `ESC_OPEN_DRAWER` 的脈衝參數，
  部分錢櫃需要不同的 `t1`/`t2` 時間值或不同的 `m` 接腳編號。

## API

- `GET /status` → `{ connected, port, baud, paperOk }`（`paperOk` 目前恆為 `null`，缺紙偵測未實作）
- `POST /print` → body `{ gymId, items:[{name,qty,price}], total?, date?, buyerTaxId?, openDrawer? }`
  → `{ ok: true }` 或 `{ ok: false, error }`
- `POST /open-drawer`（獨立開櫃，不夾帶列印）→ `{ ok: true }` 或 `{ ok: false, error }`

號碼由 RedRock 後端管理，這支代理**不處理發票號碼/金額邏輯**，純粹「收到內容就印」。
