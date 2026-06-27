# 金流串接架構設計（LinePay / 街口 JKOPay / 台灣Pay）

> 目標：把現有「手動記錄付款方式」升級為**真正的線上金流收款**，並先收斂分散的付款 UI，讓「一處串接、全站生效」。
> 前提：尚無正式商戶金鑰 → 以**沙箱/測試環境**開發。

---

## 0. 實作現況（2026-06-27 更新）

> 本節為「實際做到哪」的快照；下方第 1~9 節為原始設計（保留作參考）。

### 已完成
- **rail 核心**：`src/services/paymentService.js`
  - 生命週期 `pending→paid`，callback 用 Firestore transaction **冪等**（已付不重複請款/記帳）。
  - `orderResolvers[orderType]`：後端**權威**解析金額/場館/會員（前端不送這些值）。
  - `orderHandlers[orderType]`：付款成功的業務動作；成功後自動呼叫既有 `recordTransaction()` 進營收帳。
  - `loadGymPaymentSettings(db, gymId)`：載入**該館** `gyms/{gymId}.paymentSettings` 傳給 adapter（各館金鑰不同）。
  - `handleCallback`：`extractOrderId` → 載入 payment → 取該館 gymSettings → `verifyCallback`（LinePay 在此 Confirm 請款）。
- **路由**：`src/routes/payments.js` — `POST /payments`、`GET /payments/:id`、`POST /payments/:provider/callback`、`POST /payments/mock/pay`（mock 測試用）。
- **前端元件**：`src/components/PaymentFlow.jsx`（redrock-web）— 接 `client` prop，會員/員工通用；匯出 `ONLINE_PAYMENT_ENABLED`。**mock 僅 `import.meta.env.DEV` 啟用**（正式環境關閉，避免零元確認）。
- **adapters**（`src/services/paymentAdapters/`）— 介面一致 `createPayment / extractOrderId / verifyCallback`：
  | adapter | 狀態 | 金鑰（gymSettings） |
  |---|---|---|
  | `mock` | 測試用（dev only） | — |
  | `linepay` | ✅ 可運作實作（v3、HMAC、Confirm；待金鑰） | `linePayChannelId` / `linePayChannelSecret` |
  | `jkopay` | 🟡 骨架（待整合手冊） | `jkoPayStoreId` / `jkoPaySecret` |
  | `taiwanpay` | 🟡 骨架（待收單銀行 API） | `taiwanPayMerchantId` / `taiwanPayBankApiKey` |
- **收費點接線**（orderType → orderRef）：
  | 類型 | orderType / orderRef | 後端 | 前端 |
  |---|---|---|---|
  | 競賽報名 | `competition` / `{registrationId}` | ✅ | ✅ 會員端 |
  | 體驗預約 | `experience` / `{bookingId}` | ✅ | ✅ 會員端 |
  | 課程報名 | `course` / `{enrollmentId}` | ✅（enroll-all 加 deferPayment） | ✅ 會員端 |
  | 器材租借 | `rental` / `{rentalId}` | ✅ | ✅ 會員端 |
  | 定期票 | `pass` / `{passId}` | ✅（POST /passes 加 deferPayment） | ⏳ 員工 QR |
  | 分期 | `installment` / `{planId, seq}` | ✅ | ⏳ 員工 QR |
  | 入場 | `checkin` / `{checkInId}` | ✅（/phone 加 deferPayment） | ⏳ 員工 QR |
  | 商品 POS | — | 不做（依決定） | — |

  > 「會員自助」前端均受 `ONLINE_PAYMENT_ENABLED` 控管：正式環境在真實 gateway 上線前**不出現付款入口**，fallback 既有匯款流程。

### 待辦（多需先取得外部資源）
1. **各館**申請 LinePay / 街口 / 台灣Pay 商戶 → 金鑰填入各 gym 的 `paymentSettings`。
2. 環境變數：`LINEPAY_ENV`（sandbox/production）、`JKOPAY_ENV`、`API_URL`（confirmUrl）、`CLIENT_URL`（cancelUrl）。
3. LinePay sandbox 端到端測試 → 將 `PaymentFlow` 的 `linepay` `enabled` 改 `true` + 啟用 `ONLINE_PAYMENT_ENABLED`。
4. 員工端 QR PaymentFlow（pass / installment / checkin）。
5. 補街口 / 台灣Pay 的 adapter TODO（依整合手冊 / 收單銀行 API）。

---

## 1. 現況摘要（重要）

- **付款方式目前只是「標籤」**：`cash / transfer / linepay / jkopay / taiwanpay` 是員工/會員手動點選的記錄值，**後端沒有任何 gateway API 串接**。`transfer`＝匯款+上傳截圖+員工確認。
- **後端記帳已統一** ✅：所有收費點都呼叫 `src/utils/revenueLedger.js` 的 `recordTransaction(db, {...})` 寫入 `transactions`，欄位含 `gymId, type, totalAmount, paymentMethod, paymentStatus:'completed', memberId, relatedId, receiptNo, paidAt`。
- **付款 UI 分散** ❌：共用元件 `components/PaymentSection.jsx`（含五種方式）只被 ~5 個會員流程使用（競賽 import 了卻自己 inline）；MemberQRPage 與**所有員工端**各寫一套。
- **每個 gym 已有 `paymentSettings`** 欄位（ecpay/linePay/jkoPay…，多為空值），可作為各館商戶設定的存放處。
- **關鍵落差**：現在「收費」當下就記成 `completed`（假設已付）。線上金流需要 **pending → 使用者付款 → gateway callback → completed** 的非同步生命週期。

### 收費點清單（呼叫 recordTransaction 的地方）
| # | 流程 | 端點/檔案 | type |
|---|---|---|---|
| 1 | 入場（QR 確認） | checkinService.js:636 | checkin |
| 2 | 入場（電話） | checkin.js:472 | checkin |
| 3 | 商品銷售 | products.js:271 | product |
| 4 | 課程報名/插班 | courses.js:605 | course |
| 5 | 定期票 建立/續約/調整 | passes.js:173/220/346/459 | pass |
| 6 | 入場取消退款 | cancelCheckin.js:65/175 | refund |
| 7 | 競賽報名 | competitionService（付款另記於 registration） | competition |
| 8 | 體驗課/分期 | experienceBookings / installmentService | 各自 |

---

## 2. 目標架構

```
                    ┌─────────────────────────────────────────┐
   前端各收費點 ───▶ │  統一付款元件 PaymentFlow                  │
   (8 個流程)        │  - offline 方式(現金/轉帳)：沿用現行記錄    │
                    │  - online 方式：呼叫 /payments 建立付款    │
                    └───────────────┬─────────────────────────┘
                                    │ POST /payments  (amount 由後端權威計算)
                    ┌───────────────▼─────────────────────────┐
   後端            │  paymentService（抽象層）                  │
                   │   ├─ adapter: linepay                     │
                   │   ├─ adapter: jkopay                      │
                   │   └─ adapter: taiwanpay                   │
                   │  payments collection（pending/…/paid）    │
                   └───────┬───────────────────────┬──────────┘
                           │ 建立付款→回 paymentUrl/QR │ gateway callback/webhook
                           ▼                         ▼
                    使用者付款(導轉/掃碼)      POST /payments/:provider/callback
                                                 → 驗簽 → 冪等更新 paid
                                                 → 觸發既有 recordTransaction()
                                                 → 完成原本的業務動作(發票/報名確認…)
```

核心原則：**所有金額由後端權威計算**（沿用我們已做的體驗課/競賽模式），前端只送「要付哪一筆（orderType + 業務 id）」與選用的付款方式，不送金額。

---

## 3. 資料模型：新增 `payments` collection

```js
{
  id,                         // 內部付款單 id（= gateway orderId）
  provider: 'linepay'|'jkopay'|'taiwanpay'|'cash'|'transfer',
  status: 'pending'|'paid'|'failed'|'cancelled'|'expired'|'refunded',
  amount,                     // 後端權威計算
  currency: 'TWD',
  gymId, memberId, memberName,
  orderType: 'checkin'|'product'|'course'|'competition'|'experience'|'pass'|'rental'|'installment',
  orderRef: { ... },          // 還原業務動作所需的最小 payload（例如報名參數）
  relatedId,                  // 對應業務文件 id（建立後回填）
  providerTxnId,              // gateway 交易序號（confirm 用）
  paymentUrl,                 // online：導轉/QR 內容
  rawCallback,                // 稽核用（去敏）
  idempotencyKey,             // 防重複
  createdAt, paidAt, expiresAt, updatedAt,
}
```

狀態機：`pending →(callback成功)→ paid →(可)→ refunded` / `pending →(逾時/取消/失敗)→ expired|cancelled|failed`。
只有 `pending → paid` 那一刻才呼叫既有 `recordTransaction()` 與「完成業務動作」，且**冪等**（重複 callback 不重複記帳）。

---

## 4. 後端設計

### 4.1 paymentService 介面（adapter 統一簽名）
```js
// 每個 gateway 實作這三個方法
createPayment({ orderId, amount, productName, memberInfo, gymSettings, returnUrls }) → { paymentUrl, providerTxnId? }
verifyCallback(req) → { orderId, providerTxnId, success, raw }     // 驗簽 + 解析
confirmPayment({ providerTxnId, orderId, amount, gymSettings })     // 需二次確認的(如LinePay)
refund({ providerTxnId, amount, gymSettings })                     // 之後做
```

### 4.2 新端點
- `POST /payments` — 建立付款：收 `{ orderType, orderRef, gymId, method }`；**後端算金額** → 建 `payments(pending)` → 呼叫 adapter.createPayment → 回 `{ paymentId, paymentUrl }`。
- `POST /payments/:provider/callback` — gateway 通知（**公開但驗簽**）：adapter.verifyCallback → 冪等更新 paid →（LinePay 需）confirmPayment → recordTransaction + 完成業務動作。
- `GET /payments/:id` — 前端輪詢付款狀態（QR/導轉回來後用）。
- `POST /payments/:provider/return` — 使用者導轉回來的落地頁（確認狀態後導去成功/失敗畫面）。

### 4.3 商戶設定存放
沿用各 gym 的 `paymentSettings`（或集中於 `systemSettings/paymentProviders`）。**金鑰只存後端/環境變數，絕不進前端 bundle 或 CLAUDE.md**。

---

## 5. 前端設計

- 新建/擴充 `PaymentFlow` 元件，取代各處 inline 與舊 `PaymentSection`：
  - **offline（現金/轉帳）**：維持現行行為（記錄 + 轉帳截圖）。
  - **online（linepay/jkopay/taiwanpay）**：呼叫 `POST /payments` → 取得 `paymentUrl`：
    - 手機：導轉到 App/網頁付款；回來後輪詢 `GET /payments/:id`。
    - 桌機：顯示 QR + 輪詢狀態。
- 8 個收費點逐一改成「打開 PaymentFlow、傳 orderType + 業務參數」，**不再各自送金額/付款方式字串**。

---

## 6. 三家 Gateway 重點（沙箱優先）

| Gateway | 模式 | 串接重點 | 取得門檻 |
|---|---|---|---|
| **LINE Pay** | Online API v3：Request→(導轉)→Confirm | 文件最完整、有 sandbox（sandbox-api-pay.line.me）；HMAC 簽章（Channel ID/Secret）；**需 Confirm 二次確認** | LINE Pay 線上商戶帳號 |
| **街口 JKOPay** | 線上交易 API：建立訂單→QR/導轉→notify callback | 商戶號+API key+digest 簽章；文件需與街口簽約取得 | 街口特約商戶 |
| **台灣Pay / TWQR** | 產生 EMVCo TWQR → 銀行 App 掃 → 銀行 callback | 多由**收單銀行**提供 API（非單一窗口）；格式為 TWQR/EMVCo | 收單銀行合約 |

**建議起手式：先 LinePay**（沙箱與文件最友善），把 paymentService/adapter/callback/前端流程的「骨架」跑通，其餘兩家照同一 adapter 介面補上。

---

## 7. 安全 / 合規（必做）

1. **金額後端權威**：前端永不送金額（沿用體驗課/競賽已做的模式）。
2. **callback 驗簽**：每家 gateway 的簽章一律驗證，拒絕偽造通知。
3. **冪等**：callback 以 `orderId`/`idempotencyKey` 去重，重複通知不重複記帳/重複發貨。
4. **狀態以 callback 為準**：不可只信前端導轉結果（使用者可能中途關閉）。
5. **金鑰保護**：只存後端環境變數；撤換目前外洩的 PAT 同理（已處理）。
6. **對帳**：保留 `rawCallback`（去敏）與 `receiptNo`，與既有 `transactions`/單日結帳串接。

---

## 8. 分階段實作計畫

- **Phase 0（不需金鑰）✅ 完成**：`payments` collection + paymentService + mock adapter + PaymentFlow，全鏈路端到端驗證（含冪等）。
- **Phase 1 ✅ 大致完成**：收費點接 rail。會員自助（競賽/體驗/課程/租借）前後端皆接；櫃台（定期票/分期/入場）後端 rail 接好、前端員工 QR 待 Phase 2；商品 POS 不做。各收費點金額後端權威解析；建單即記帳的流程加 `deferPayment` 避免重複記帳。
- **Phase 2 🟡 進行中**：LinePay adapter 已寫成可運作實作（待各館金鑰 + sandbox 測試 + 啟用 `ONLINE_PAYMENT_ENABLED` + 員工端 QR 前端）。
- **Phase 3 🟡 骨架就緒**：街口、台灣Pay adapter 骨架已建並註冊（介面一致），待整合手冊/收單銀行 API + 金鑰補完 TODO。
- **Phase 4（未開始）**：退款、對帳報表、逾時自動取消、發票串接。

---

## 9. 需要你提供 / 決定

1. **商戶資格**：三家的線上收款帳號與沙箱金鑰（目前皆無 → 先做 Phase 0 mock）。
2. **導轉 vs QR**：會員端以手機為主（建議導轉），員工端櫃台收款是否需要 QR？
3. **哪些收費點要上線上付款**：全部 8 個，還是先會員自助的幾個（報名/購票/體驗）？
4. **發票**：是否同時要串電子發票（多數金流會搭配）？

> 在拿到金鑰前，**Phase 0（mock 全鏈路 + 前端收斂）完全可以先做**，金鑰到位後只需替換 adapter，不動其餘程式。
