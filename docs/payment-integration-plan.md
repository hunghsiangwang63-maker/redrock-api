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
- **前端元件**：`src/components/PaymentFlow.jsx`（redrock-web）— 接 `client` prop，會員/員工通用；匯出 `ONLINE_PAYMENT_ENABLED`。**mock 僅 `import.meta.env.DEV` 啟用**（正式環境關閉，避免零元確認）。**⚠️ `ONLINE_PAYMENT_ENABLED` 這個單一 build-time 常數將被 §11 的「各流程獨立開關」取代**（現況是 course/experience/rental/competition 四處共用同一個開關、管理員無法在後台個別調整——見 §11 定案設計）。
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
  | 商品 POS | — | **永久不做（2026-08-04 再確認）** | — |

  > 「會員自助」前端均受 `ONLINE_PAYMENT_ENABLED` 控管：正式環境在真實 gateway 上線前**不出現付款入口**，fallback 既有匯款流程。

  > **商品 POS 為何不接（2026-08-04 定案，非暫緩）**：POS 是全系統唯一「店員發起付款、會員自己付款」的場景（其餘收費點都是會員自助、發起與完成付款是同一支手機，才需要上面這套 Request→導轉→輪詢的 adapter 機制）。**現場已有各行動支付商家的實體收款 QR**（固定貼在櫃檯，非系統動態產生）→ 會員自己掃碼、在自己的付款 App 內完成付款（全程在 RedRock 之外）→ 店員目視確認會員手機的付款成功畫面後，直接按下（未來的）「列印發票」鍵——**這個動作本身就是收款確認，不需要另外接 API 去驗證這筆錢真的進來了**。行動支付在 POS 這裡因此永遠只是店員手動選的付款方式標籤，跟現金/轉帳同一層級，差別只在列印發票時**依錢櫃規則不開櫃**。詳見 `docs/invoice-integration-plan.md` §4。

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

---

## 10. 入場（checkin）LinePay 設計決策（2026-07-25 拍板）

> 承會員自助入場 QR：線上款（LinePay/街口/台灣Pay）**只能 pay-first**（線上款是會員在 App 主動付、無法在櫃檯掃碼當下自動收），與現金/免費/票券的「掃碼→確認時扣款」不同節奏。

### 流程（LinePay 入場）
1. 會員選**場館**（rail 依 `gyms/{gymId}.paymentSettings` 帶該館 LinePay 帳號）→ 選入館身份 → 選 LinePay。
2. 跳 LinePay 付款 → Confirm 請款成功 → **產生「已付款」入場 QR**。
3. 櫃檯掃碼 → `confirmCheckIn`（**不再收費**，已付；仍跑既有孤兒防護/墜測遞延/出席等）。

### 「付了款但沒入場」處理 → **A：轉單次入場券、效期 30 天**（拍板；2026-08-04 實作時修正欄位語意，見下）
- 付款成功 → **當下直接開一張 `singleEntryTickets`**（採用原文兩選項的「二擇一」中的**開券制**，非「pending+sweep」——理由見下方實作段）。
- **不做位置限制**（GPS/現場）：在家先付＝線上預購一次入場，允許；30 天內任一天到場都能用同一張券（非僅限購買當天）。
- 錢不會不見、免退款作業。

### ✅ 實作（2026-08-04 已上線，commit `447ddfe`，`/health` `3.208.0-entry-linepay-orderhandler`；正式環境以 `provider:'mock'` 直呼 service 層驗證，9 項情境全過，測後 0 殘留）
- **新 orderType `entry`**（未沿用既有 `checkin` orderType）：`orderResolvers.checkin`/`orderHandlers.checkin` 是「更新一筆已存在的 `checkIns` 文件」，跟 pay-first「付款當下還沒有任何入場紀錄」的前提完全不符，套不進去——這點原文字未明確定案（寫「`checkin`/新 `entry` orderType」二擇一），實作時確認只有新開 `entry` 才可行。
- **`orderResolvers.entry`**（`paymentService.js`）：`orderRef:{gymId, entryType}`（會員選館+選身份，付款前尚無任何既有紀錄可查）；`entryType` 限 `single_ticket`/`student_free`/`child_free` 三種**純付費**身份（卡/券/免費資格本就有自己的免費入場路徑，不需要線上付款）；**付款前先跑 `runEntryGates`**（同日重複/Waiver/墜測/分期逾期）擋下，避免付了錢卻卡在入場關卡用不了；金額走 `computePaidEntryAmount` 後端權威計算（含符合資格的隊員 9 折，**不含**需現場出示證件的舊卡 8 折/特約廠商/友館隊員——這些線上場景無法驗證）。`createPayment` 呼叫 resolver 處補了第三參數（呼叫端認證的 `memberId`，不信 `orderRef` 內容），僅 `entry` 使用，其餘既有 resolver 不受影響（JS 對未宣告的多餘參數安全忽略）。
- **`orderHandlers.entry`**：付款成功**直接開券**（`status:'active'`，免櫃檯審核——跟店員發放的贈券/招待券不同，這是真的收了錢，沒有濫用疑慮）。
  - 🐞 **修正原文的欄位語意錯誤**：原文寫「`validDate`=購買日」，但 `getValidSingleEntryTickets`（`checkin/eligibility.js`）的規則是「**有 `validDate` 的券只能在那一天用**」（此規則是給體驗課程當日券設計的）——若照原文設定，轉出的券只能在「已經過去的購買日」使用，等於**永久不能用、錢真的不見了**，直接牴觸「錢不會不見」的核心訴求。實作改為**`validDate` 留空（null）**、只設 `expiresAt`＝購買日+30 天——這樣券在 30 天效期內任一天都能用（含購買當天），單一機制同時涵蓋「當天用」與「之後 30 天內任一天用」兩種情境，**不需要**原文構想的「pending 入場+排程 sweep 轉券」兩階段狀態機。
  - 其餘欄位：`amount`/`paymentMethod`（存 `payment.provider`，如 `'linepay'`）/`paymentId` 記錄實際收款；`source:'linepay-entry'`（原文 `linepay-entry-unused` 的「unused」語意已不成立，因為現在是每筆都這樣開，非僅限未使用的補救分支）；`baseEntryType` 記錄線上選購當下的入館身份（供追蹤，兌換時走一般單次券流程、不受此欄位限制）。
  - `TYPE_MAP.entry='checkin'`（營收報表分類比照一般入場費）。
- **正式環境驗證（9 項情境，`provider:'mock'` 直呼 service 層＋HTTP 皆測，因 `/payments/mock/pay` 路由本身在 `NODE_ENV==='production'` 會回 404，故完成付款那步改直接呼叫 `paymentService.handleCallback('mock', ...)`）**：single_ticket/student_free/child_free 金額分別 300/250/150 正確；`vip`/`discount_card`（免費/卡券類）與缺欄位皆擋 `400 INVALID_ENTRY_TYPE`/`INVALID_ORDER`；無 waiver 會員擋 `400 WAIVER_REQUIRED`（付款前失敗，未收費）；付款完成後票券 `status:active`／`validDate:null`／`expiresAt`=今日+30天，且**確認可被 `getValidSingleEntryTickets` 判定為可用**（與真實兌換走同一份權威邏輯）；`transactions` 正確記一筆 `type:checkin`/金額相符。

### 現金/免費/票券 維持原樣
掃碼 → 櫃檯確認時扣款/扣券（不走 pay-first）。→ 入場流程**依付款方式分兩種節奏**。

### 待辦（實作順序）
1. 先跑通 **LinePay sandbox**（見第 0 節待辦，等 Channel ID/Secret）。
2. ✅ **入場 orderType/orderHandler + 「未用轉券」邏輯**（2026-08-04 已完成，見上方實作段）。
3. ✅ **會員端入場 QR 的 LinePay PaymentFlow**（2026-08-04 已上線，commit `8888602`；`docs/payment-integration-plan.md` §11 的 `onlineFlows.entry` 開關即控制此按鈕是否顯示，同步改名對齊）：`MemberQRPage.jsx` 「選擇付款方式」頁，僅單純付費身份（成人/學生/兒童單次購票）在開關開啟時，於既有現金/標籤式選項下方多一顆「🌐 線上支付」按鈕（與友館隊員/特約廠商優惠互斥，兩者需現場核對、線上付款不支援）。**設計簡化**：沒有另外做「已付款 QR」這個新畫面——付款成功（`PaymentFlow` 的 `onPaid`）後直接重新驗票、導回選身分頁，此時後端已開通的單次入場券會出現在「使用單次入場券（免費）」選項，會員照原本既有、已測試過的票券兌換掃碼流程操作即可，避免重複造一套 QR 產生邏輯。**畫面要真的被使用仍需等 §0 待辦 1「LinePay sandbox 金鑰」到位**（金鑰未設定時 `getAvailableMethods` 不會列出 linepay，`select_payment` 這顆按鈕點下去雖然會開 Modal，但 `PaymentFlow` 本身的付款方式清單會是空的）。

---

## 11. 「各流程是否開放線上支付」管理員開關（2026-08-04 定案，取代 `ONLINE_PAYMENT_ENABLED`）

> 起因：管理員要在哪裡設定入場/課程/比賽報名是否開放線上支付？現況 `ONLINE_PAYMENT_ENABLED` 是**寫死在前端 build 時的環境變數**（`import.meta.env.VITE_ONLINE_PAYMENT`），course/experience/rental/competition 四處共用同一個常數，**管理員完全無法在後台調整、也無法讓不同流程各自不同**。本節把它改成後台可調、每個流程各自獨立的開關。

### 現況：一筆線上付款實際會經過幾層 gate（釐清，供理解本節改動位置）
一個付款方式要在某館某流程真的能被選到，目前已有三層（本節新增第四層）：
1. **`PAYMENT_PROVIDERS` 環境變數**（Railway，部署層級的 provider allowlist）。
2. **`systemSettings/paymentMethods.enabled.{cash,transfer,linepay,jkopay,taiwanpay}`**（既有，`GET/PUT /settings/payment-methods`，員工端「系統設定→付款方式」）——**site-wide**，這個 provider 在全站是否存在。
3. **該館 `gyms/{gymId}.paymentSettings` 是否已填該 provider 的商戶金鑰**（`PROVIDER_META.credKeys`，缺金鑰的館即使開關開了也不會出現）。
4. **（本節新增）`systemSettings/paymentMethods.onlineFlows.<flow>`**——這個「流程」是否要顯示線上支付入口。

第 1~3 層決定「這個 provider 存不存在」；第 4 層決定「這個流程要不要秀出來讓會員選」。兩者是不同軸，**都要通過才會出現線上支付選項**。

### 新增：per-flow 開關 `onlineFlows`
```
systemSettings/paymentMethods {
  enabled: { cash, transfer, linepay, jkopay, taiwanpay },   // 既有，不動
  onlineFlows: {                                              // 新增，預設全部 false
    checkin: false, course: false, experience: false,
    competition: false, rental: false, pass: false, installment: false,
  }
}
```
- **7 個 flow key，對齊 `paymentService.js` 的 `orderType`**（checkin/course/experience/competition/rental/pass/installment）。
- **刻意不含 `product`（POS）**——POS 的行動支付選項走「實體收款 QR＋店員目視確認」（見 `docs/invoice-integration-plan.md` §4 2026-08-04 定案），從頭到尾不呼叫 `paymentService`/gateway API，跟這個開關機制無關；POS 的行動支付顯示與否仍只受第 2 層（`enabled`）控制，不受本節影響。
- **`installment` 獨立一個開關，不跟隨其來源（pass/course/rental）**：分期計畫可能因購買/續約定期票、課程插班、或器材租借而建立，但對 `paymentService` 而言都是同一種 `orderType:'installment'`（`orderRef:{planId, seq}`），機制完全一致。**每一期是各自獨立的一筆付款請求，不會自動扣下一期**——付完第 N 期只標記該期 `paid`，第 N+1 期到期時需要**另一次獨立觸發**（例如既有的到期提醒 email/站內通知，未來加一個連結導去「付這一期」的畫面）才會產生新的付款請求。因此開放與否跟「這筆分期原本是哪個流程建立的」無關，用單一開關統一控管。

### 現況盤點：哪些流程今天真的有前端能吃到這個開關
| flow key | 後端 rail | 前端是否已有 PaymentFlow 入口 | 開了 `onlineFlows` 今天會發生什麼 |
|---|---|---|---|
| `course` | ✅ | ✅ 會員端（課程報名/插班） | 立即生效 |
| `experience` | ✅ | ✅ 會員端（體驗預約/試上） | 立即生效 |
| `competition` | ✅ | ✅ 會員端（比賽報名） | 立即生效 |
| `rental` | ✅ | ✅ 會員端（器材租借） | 立即生效 |
| `pass` | ✅ | ⏳ 未接 | 開了也不會出現任何 UI（等前端做出來才有作用） |
| `installment` | ✅ | ⏳ 未接（連提醒信的付款連結都還沒做） | 同上 |
| `entry`（原 `checkin`，2026-08-04 改名對齊） | ✅ | ✅ 會員端入場 QR（2026-08-04 上線，見 §10 待辦第3項） | 立即生效（惟金鑰未設定前 `PaymentFlow` 內的付款方式清單會是空的） |

### 實作方向
- ✅ **後端（2026-08-04 已上線，commit `1616c23`，`/health` `3.207.0-payment-methods-online-flows`）**：`GET /settings/payment-methods` 回應同時含 `enabled`（不動）與 `onlineFlows`（新，缺值 fallback 全 false）；`PUT` 對應收兩者，任一個省略則沿用資料庫既有值（向下相容既有呼叫端，不會因為這次擴充而讓舊的 `PUT { enabled }` 呼叫把 `onlineFlows` 洗掉）。正式 API 已驗證：GET 預設值正確、PUT 只送 `onlineFlows` 不動 `enabled`、PUT 內 `onlineFlows` 為整份覆寫（跟既有 `enabled` 語意一致——省略的 key 視為 false，非合併，前端每次都會送完整物件不受影響）。
- ✅ **管理員 UI（2026-08-04 已上線，commit `ab01fc1`）**：`SettingsPage.jsx` 既有「💳 付款方式」分頁下方新增「🌐 各流程線上支付」子卡片，7 個 toggle（課程/體驗/比賽/租借/定期票/分期/入場），對尚未接前端的 3 項（定期票/分期/入場）標註「前端尚未接，開啟暫無效果」的琥珀提示，避免管理員誤以為開了就能用；獨立存檔按鈕，與上方「付款方式開關」卡片分開儲存。
- ✅ **前端消費端（2026-08-04 已上線，commit `9c08ade`，已 firebase deploy 並比對 bundle hash 確認線上為此版本）**：`utils/paymentMethods.js` 新增 `useOnlineFlowEnabled(flowKey)`（本機開發 `import.meta.env.DEV` 恆真，維持原本搭配 mock 免額外設定即可測的行為；正式環境改讀 `fetchEnabledPayments()` 快取的 `onlineFlows`）；`PaymentFlow.jsx` 移除匯出的 `ONLINE_PAYMENT_ENABLED` 常數；四個既有呼叫點（`MemberCoursesPage`/`MemberExperiencePage`/`MemberCompetitionsPage`/`MemberRentalPage`）改成 `useOnlineFlowEnabled('course'|'experience'|'competition'|'rental')`。**管理員在 SettingsPage 開關這四項的 `onlineFlows` 現在會直接生效**（`pass`/`installment`/`checkin` 三項仍是後端 rail 已接、前端尚未有消費端，開了目前還不會出現任何畫面，等各自的前端做出來才有作用）。`onlineFlows` 預設全 false，行為與改版前一致（原本 `ONLINE_PAYMENT_ENABLED` 在正式環境未設 `VITE_ONLINE_PAYMENT` 時本就是 false），需管理員手動開啟才會顯示線上支付入口。
- ✅ **`entry`（入場）消費端 + 開關改名（2026-08-04 已上線，commit `8888602`/`bfbc2ee`）**：`onlineFlows.checkin` 改名為 `onlineFlows.entry`（正式環境確認改名前無人設定過、安全）；`MemberQRPage.jsx` 接上 `useOnlineFlowEnabled('entry')`，詳見 §10 待辦第3項。
- **上線提醒**：這組開關只決定「要不要秀出來」，**不代表付款會成功**——沒有金鑰/沒有前端的組合，開了也不會發生任何事（見上表）。之後每接完一個流程的前端，這個開關才真的開始有意義。

---

## 12. 分期付款「線上繳費」流程設計（2026-08-04 定案）

> 起因：分期到期提醒信/逾期通知信文案已經寫「請至櫃檯或線上完成繳款」，但**「線上」目前是一句空話**——完全沒有任何路徑能讓會員真的線上繳這一期。本節把這段路接起來的設計定案。

### 現況（今天實際發生的事，逐項對照程式碼）
1. **到期前提醒**：`installmentService.sendInstallmentReminders`（每日排程）在到期前 3 天呼叫 `emailService.sendInstallmentDueReminder` 寄一封**純文字提醒信**（項目/期數/金額/到期日），內文「請至櫃檯或線上完成繳款」——**信件本身沒有任何連結**。
2. **逾期通知**：同一支排程，逾期後呼叫 `sendInstallmentOverdueNotice`，同樣**沒有連結**；`runOverdueCheck` 另外標記逾期、擋入場（`checkin/gates.js` `hasOverdueInstallment`）。
3. **會員實際能繳款的路，今天只有一條**：到櫃檯給店員手動點「標記已繳」——`POST /installments/:planId/pay`（`installments.js`，`checkPermission('installments.manage')`，**僅限員工**）。
4. **會員讀自己分期計畫的 API 其實已經存在**：`GET /installments/member/:memberId`（`authenticateAny`，已有擁有權檢查「只能查看自己的分期計畫」）——**但目前系統裡沒有任何前端頁面呼叫它**，`redrock-web/src/pages` 底下只有 `staff/InstallmentsPage.jsx`（管理端），沒有 member 對應頁面。資料讀得到、卻無處顯示。
5. **線上金流 rail 早就接好**：`paymentService.js` 的 `orderResolvers.installment`／`orderHandlers.installment` 已經是完整實作（`orderRef:{planId, seq}` → 權威解析該期金額 → 付款成功呼叫 `markInstallmentPaid`）。這段**不需要改後端**，缺的純粹是前端「怎麼觸發這支 API」。
6. **`useOnlineFlowEnabled('installment')`**（見 §11）已經做好、管理員也能在後台開關，但**目前沒有任何畫面在讀它**——因為根本沒有「我的分期」這個畫面存在。

### 目標流程
```
到期前3天/逾期 → 提醒信（補上深連結）
  → 會員點連結 → 前往「我的分期」頁（新，帶 planId/seq 定位到那一期）
  → 該期顯示「線上繳費」按鈕（受 useOnlineFlowEnabled('installment') 控制）
  → 開 PaymentFlow（orderType:'installment', orderRef:{planId, seq}）→ 選付款方式 → 完成
  → onPaid callback → 重新整理該筆計畫 → 該期顯示「已繳款」
```

### 要做的事（後端幾乎不用動，主力在前端）
1. **會員端新增「我的分期」畫面**：可獨立成頁面（`MemberInstallmentsPage.jsx`），或嵌入既有頁面（例如 `MemberProfilePage` 或票券頁旁邊加一個分頁/區塊——分期計畫的 `relatedType` 是 `course`/`pass`，兩者的會員主要停留頁面不同，獨立頁面比嵌入更不會有「該放哪一頁」的爭議，傾向獨立頁）。呼叫既有 `GET /installments/member/:memberId`（免改後端），逐一列出各 plan：項目名稱、各期狀態（已繳/待繳/逾期）、金額、到期日；待繳/逾期的那期在 `useOnlineFlowEnabled('installment')` 為 true 時顯示「線上繳費」按鈕。
2. **深連結**：新頁面支援 URL query（如 `?planId=xxx&seq=2`）定位到特定一筆，開啟時自動捲到/展開那一期，比照既有其他頁面深連結的做法（如課程/比賽報名連結，見 CLAUDE.md「課程/比賽報名連結」段落，同一套 pattern）。
3. **提醒信加連結**：`sendInstallmentDueReminder`／`sendInstallmentOverdueNotice`（`emailService.js`）內文補一顆「前往繳費」按鈕，連到 `${CLIENT_URL}/member/installments?planId=${plan.id}&seq=${i.seq}`。
4. **付款按鈕接 `PaymentFlow`**：`<PaymentFlow orderType="installment" orderRef={{planId, seq}} amount={i.amount} gymId={plan.gymId} onPaid={...} onCancel={...} />`（沿用既有元件，不用改）；`onPaid` 重新呼叫 `GET /installments/member/:memberId` 刷新畫面。
5. **未開放線上支付時的 fallback**：`useOnlineFlowEnabled('installment')` 為 false（現況預設）時，該期只顯示「請至櫃檯繳款」文字，不顯示按鈕——跟課程/體驗/比賽/租借四個已接流程的既有行為一致（見 §11 現況盤點表）。

### 範圍/不做的事
- **不改變分期本身的機制**：每期仍是各自獨立的付款請求，不會因為做了這個頁面就出現「自動扣款/自動收下一期」的功能（見 §11 對 `installment` 的說明）。
- **不做管理端改動**：員工端 `staff/InstallmentsPage.jsx`（櫃檯手動標記已繳）維持不動，兩條路徑（線上/櫃檯）並存，跟課程/比賽等其他流程的「線上或臨櫃」並存模式一致。
