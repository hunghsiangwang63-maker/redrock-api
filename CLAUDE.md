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

## 目前進度（2026-06）
- ✅ **竹北館 → 士林館**全面改名（前後端 + Firestore migration，已驗證）
- ✅ **全面 bug 健檢**：修復約 43 項邏輯 bug（金流安全 / 崩潰 / 邊界），含並發超賣改 transaction、競賽候補自動遞補、營收週統計時區、墜落測驗遞延數學、站台 shift 端點認證等
- 🟡 **線上金流串接（進行中）**：統一付款 rail（`paymentService` + 前端 `PaymentFlow` + 每館商戶設定）
  - 已接：競賽 / 體驗 / 課程 / 租借（會員自助，前後端皆接）；定期票 / 分期 / 入場（後端 rail 已接，員工 QR 前端待 Phase 2）；商品 POS 不做
  - adapter：`mock`(dev)、`linepay`(可運作，待金鑰)、`jkopay` / `taiwanpay`(骨架待規格)
  - 正式環境付款入口受 `ONLINE_PAYMENT_ENABLED` 控管，真實 gateway 金鑰到位前不啟用（fallback 匯款）
  - **完整設計與現況見 `docs/payment-integration-plan.md`**

## 待辦
- 各館申請 LinePay / 街口 / 台灣Pay 商戶 → 金鑰填入各 gym 的 `paymentSettings`
- LinePay sandbox 端到端測試 → 啟用線上付款 + 員工端 QR 前端
- 補街口 / 台灣Pay adapter 的 API TODO（依整合手冊 / 收單銀行）
- 資料移轉（Climbio 18,000+ 筆）
