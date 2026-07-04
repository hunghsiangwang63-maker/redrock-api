# RedRock 紅石攀岩館 — 系統說明

> 本檔已可安全提交（無機密）。測試帳號 / 金鑰等敏感資料見 `CLAUDE.local.md`（git-ignored）。
> 接手 / 維護這份 context 的方式見 `docs/maintaining-context.md`。

## 專案概述
RedRock 紅石攀岩館管理系統，服務兩個場館：新竹館（`gym-hsinchu`）和士林館（`gym-shilin`）。

## 架構
- **前端**：`~/Downloads/redrock-web`（React 18 + Vite）
  - 會員端：`redrock-member.web.app` → `app.redrocktaiwan.com`
  - 員工端：`redrock-staff.web.app` → `staff.redrocktaiwan.com`
  - 部署：`BUILD_TARGET=staff npx vite build && BUILD_TARGET=member npx vite build && firebase deploy --only hosting --project redrock-dev-a35c1`
- **後端**：`~/Downloads/redrock-api`（Node.js + Express）
  - Railway 自動部署：`https://redrock-api-production.up.railway.app`
  - 部署：git push 到 `https://github.com/hunghsiangwang63-maker/redrock-api`
- **資料庫**：Firebase Firestore（專案：`redrock-dev-a35c1`）
- **認證**：JWT（secret 存於環境變數 `JWT_SECRET`，不寫在版控）

## 機密管理
- **本檔不放任何機密**。測試帳號見 `CLAUDE.local.md`（git-ignored，僅本機）。
- 後端機密（`JWT_SECRET`、各館金流 `paymentSettings`、Firebase 憑證 json）走環境變數 / Firestore，不進版控、不進前端 bundle。
- GitHub 認證走 `gh auth login` 或 macOS Keychain（本機已設定 osxkeychain）；勿在任何檔案明文放 PAT。

## 重要注意事項
1. **前端 build 在本機執行**，不用 GitHub Actions（Linux rolldown bug）；前端是本機 build + `firebase deploy`（非自動部署）
2. **後端 push 到 GitHub** → Railway 自動部署（約 1 分鐘）
3. Firebase Storage bucket：`redrock-dev-a35c1.firebasestorage.app`
4. 路由順序：`/my/children` 必須在 `/:id` 路由之前
5. 子會員（`isChildAccount`）代簽 waiver / 墜落測驗同意書直接 `isComplete: true`
6. 金額 / 場館一律**後端權威計算**，不信前端傳值

## 跨裝置工作（SSH 回 Mac mini）
- 開發主機是 **Mac mini**；iPad / iPhone 遠端時走 **SSH 連回同一台 Mac mini**（非雲端環境）。
- 因此操作的是**同一份實體檔案、同一個 git clone** → 天生無 git 分岔 / merge 衝突；`CLAUDE.local.md`（機密）與前端本機 build / `firebase deploy` 也都在同一台，皆可正常使用。
- 守則：**一次只讓一個 session 在動**、**切裝置前先存檔**、**別讓兩個 session 同時寫同一檔**（編輯器層級覆蓋，與 git 無關）。
- 背景程序（Railway 部署、firebase、`loop-test.js`、Claude session）是共用的，切裝置後仍在跑。
- Mac mini 保持開機 + 遠端登入（sshd）；連線建議走 **Tailscale**（免公網 IP / 免開 port，比 port forwarding 安全）。

### 遠端接手正在跑的工作（screen / tmux）
- SSH 是**另一個 session**，看不到 Mac 螢幕上那個 Terminal 的即時畫面；只看得到結果（`git status`/`git diff`、commit、log 檔、`ps aux | grep node`）。
- 想遠端看到**即時進度並無縫接手**：一律在終端多工器裡工作（Claude Code 本身也跑在裡面）。
- **目前 Mac mini 未裝 tmux / Homebrew → 先用內建 `screen`（`/usr/bin/screen`，零安裝）：**
  - Mac 開始：`screen -S work`；離開（背景續跑）：`Ctrl-a` 放開再按 `d`；直接關 Terminal 也 OK。
  - iPad SSH 進來接手：`screen -r work`（卡住就 `screen -d -r work` 強制搶回）；列清單 `screen -ls`。
- **（可選）改用 tmux**：先裝 Homebrew（互動式、需登入密碼，自行執行）再 `brew install tmux`；之後 `tmux new -s work` / `Ctrl-b` `d` / `tmux attach -t work`。
- ⚠️ **背景工作只在 Mac 醒著時繼續**：Mac mini 設「插電不睡」，或跑之前加 `caffeinate`（例：`caffeinate -s node scripts/loop-test.js`），避免睡眠中斷 node 程序。

## 目前進度（2026-06）
- ✅ **竹北館 → 士林館**全面改名（前後端 + Firestore migration，已驗證）
- ✅ **全面 bug 健檢**：修復約 43 項邏輯 bug（金流安全 / 崩潰 / 邊界），含並發超賣改 transaction、競賽候補自動遞補、營收週統計時區、墜落測驗遞延數學、站台 shift 端點認證等
- 🟡 **線上金流串接（進行中）**：統一付款 rail（`paymentService` + 前端 `PaymentFlow` + 每館商戶設定）
  - 已接：競賽 / 體驗 / 課程 / 租借（會員自助，前後端皆接）；定期票 / 分期 / 入場（後端 rail 已接，員工 QR 前端待 Phase 2）；商品 POS 不做
  - adapter：`mock`(dev)、`linepay`(可運作，待金鑰)、`jkopay` / `taiwanpay`(骨架待規格)
  - 正式環境付款入口受 `ONLINE_PAYMENT_ENABLED` 控管，真實 gateway 金鑰到位前不啟用（fallback 匯款）
  - **完整設計與現況見 `docs/payment-integration-plan.md`**

## 目前進度（2026-07）— 課程 / 體驗
> **完整說明見 `docs/course-experience-features.md`**
- ✅ **體驗預約 → 指定/改教練**：確認時自動建 course/session/教練排班；改教練刪舊班建新班；取消一併清理（含票券作廢）
- ✅ **員工本人待辦頁近七日班表**：`GET /schedule/my-upcoming`（只回自己，站台/值班帳號不顯示）
- ✅ **課程月曆**：員工端顯示課名/👟教練/報名(原報名)/預計上課(原報名−請假+補課+試上)；會員端全面隱藏人數（保留「額滿」）
- ✅ **排班表編輯可改員工**（bug 修正：`updateShift` 補 `staffId/staffName`）
- ✅ **週課「開放試上」**：課程加 `allowTrial/trialPrice`；會員「體驗課程」頁報名（比照體驗，另收試上費、免保險、需簽署）→ 確認收款後加入場次名單（`isTrial`、佔名額）+ 發單日券（不卡墜落測驗）；額滿自動排除
- ✅ **課程場次「代班教練」**：月曆場次卡設定/更改/取消代班；覆寫該堂 instructor（兩端月曆自動同步）+ 待辦提醒（管理員 + 代班本人）

## 目前進度（2026-07-03）— 親子試上 / 票券轉移 / 入場擁有權
> 全面 E2E 健檢（打 Railway 正式 API）後修復；後端六大流程（認證/體驗預約/試上/代班/班表/付款 rail）邏輯皆正確，付款「後端權威金額、不信前端」已驗證。
- ✅ **試上支援家長代子女報名**：`POST /experience-bookings` 試上分支收 `childMemberId`（驗證 `parentMemberId` 擁有權）→ booking/名單/單日券的 `memberId` 綁**子女**，另存 `bookedByMemberId`；會員端試上 modal 加「報名對象」選擇器（讀 `/members/my/children`）
- ✅ **入場單日券擁有權檢查**：`createPendingCheckIn` 補「券 `memberId` 須等於入場者」（家長代子時已解析為子女；轉贈後為受贈者）→ 堵「帶他人有效券入場」漏洞
- ✅ **票券轉移可指定收件人（親子共用電話）**：`/ticket-transfers/request` 收選填 `toMemberId`（驗證電話同家）→ 可轉給**指定子女**；新增 `GET /ticket-transfers/recipients?phone=`（回家長+子女清單）；`accept`/`reject` 放寬為家長可**代子女**處理、`/pending` 納入子女待接收 → 「體驗券轉給指定子女上課」整條走通（前端轉移 modal 加家庭成員挑選器）
- ✅ **轉移收件人解析修正**：`ticketTransfers` 收件查詢改用 `memberService.getMemberByPhone`（優先家長，避開共用電話子帳號誤解析，與 `cards.js` 一致）
- ✅ **會員 QR 圖檔移除 Storage 上傳**：`generateQRCode` 改直接內嵌 base64（入場走動態 `qrToken` 前端繪製，此靜態圖無人讀取）→ 消除 Storage 依賴，Storage 異常不再卡死建立會員；一併修 seed(base64)/createMember(路徑) 不一致
- ✅ **員工月曆過濾已取消場次**（前端 `redrock-web`）：`CoursesPage` 月曆 `sessionsForDate` 加 `status!=='cancelled'`，取消的體驗場次不再殘留為幽靈場次（會員端原已過濾）

## 目前進度（2026-07-03 晚）— 卡片 / 紅利 / 迴圈測試
> 針對卡片（優惠卡 / 黑卡）、紅利、入場狀態機的迴圈回歸健檢與修補。
- ✅ **綁卡前驗證會員存在**：綁定優惠卡 / 黑卡前先確認會員存在，避免綁到不存在會員產生孤兒卡
- ✅ **卡片統計下載 / 圖表**：優惠卡 + 黑卡統計資料的下載與圖表資料；優惠卡轉入上限 10 格
- ✅ **卡片首次移轉崩潰修復** + **紅利入場取消未還原修復**：卡片第一次移轉的崩潰、以及紅利入場取消時未還原紅利的 bug
- ✅ **每日排程清除過期紅利**：標記 `inactive` 保留文件（不刪除，留稽核）
- ✅ **迴圈回歸測試**：`scripts/loop-test.js` 涵蓋卡片 / 紅利 / 入場 + 課程（報名 / 請假 / 補課 / 退費 / 插班計費）狀態機，**61 斷言全綠**，未發現新 bug

## 待辦
- 各館申請 LinePay / 街口 / 台灣Pay 商戶 → 金鑰填入各 gym 的 `paymentSettings`
- LinePay sandbox 端到端測試 → 啟用線上付款 + 員工端 QR 前端
- 補街口 / 台灣Pay adapter 的 API TODO（依整合手冊 / 收單銀行）
- 資料移轉（Climbio 18,000+ 筆）
- 會員端 UI 驗證：課程試上分頁 + 場次代班「（代班）」顯示（需會員帳號登入實測）
- 「試上人數」目前僅由試上報名流程產生 `isTrial` 名單；如需員工手動加試上者，需另做 UI
- 清理 dev Firebase 殘留測試會員：`【練習】…` 系列、`測試/測試API會員/管理員測試會員/Test1/Who` 等，以及測試用 `王大明`(0900222222)/子帳號 `小明明`；可用員工端「刪除會員」或 `DELETE /members/:id`（super_admin）清除（會一併刪子帳號、保留歷史紀錄）
