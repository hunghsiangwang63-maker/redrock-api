# 入場資格判斷流程

> RedRock 紅石攀岩館 — 入場資格與金額的**後端權威**判斷。
> 金額 / 場館一律後端計算，不信前端傳值。
>
> **來源**：`src/services/checkinService.js`（`verifyEntry` / `computePaidEntryAmount` / `createPendingCheckIn` / `confirmCheckIn`）、`src/routes/checkin.js`（`/checkin/phone`）。
> 互動流程圖（Artifact）：https://claude.ai/code/artifact/4b09e686-b99a-46b8-a69d-cfd05e11c2bf

會員／站台入場時，後端 `verifyEntry` 依序跑三段：**前置關卡**（任一不過即擋下）→ **免費資格**（由上而下命中即放行）→ **付費入場**（選身分價 + 付款工具）。

---

## 關卡 0 — 前置關卡（依序，任一不過即擋下）

不通過即回對應 `blockReason`，不進入後續判斷。

| 順序 | 檢查 | 不通過 → blockReason | 備註 |
|---|---|---|---|
| 0 | **同日重複入場**：本館當日已有未取消入場紀錄（台灣時間 UTC+8） | `already_checked_in` | 需先取消今日入場才能重新入場 |
| 1 | **Waiver 免責同意書** | `waiver_required` | 子女已簽、等家長補簽 → `parent_waiver_pending` |
| 2 | **安全墜落測驗** | `fall_test_required`（從未測）／ `fall_test_expired`（過期） | 見下方體驗券例外 |
| 2.5 | **分期付款未逾期**（課程／定期票分期） | `installment_overdue` | 入場資格暫停，須至櫃檯繳款 |

**墜測例外（體驗券）**：持「**當日有效體驗券**」者未通過墜測也可入場，但須先簽墜落測驗同意書；未簽 → 擋下 `fall_test_consent_required`，簽了即續行。

---

## 階段 1 — 免費入場資格（由上而下，第一個命中即放行）

關卡全過後，命中即回傳對應 `entryType` 並 `freeEntry: true`。

| 順序 | 條件 | 命中 → entryType |
|---|---|---|
| 3 | **VIP**（`vipMembers` 名單內） | `vip` |
| 4 | **有效定期票**：active、未到期、範圍含本館（`shared` 或指定館）、次數 > 0 | `pass` |
| 5 | **課程入館權益**：今日在無限練習期內，或今天有報名的課程場次 | `course_access` |
| 7 | **免費短路**：`entryTypes` 設定中適用本身分的類型價格 ≤ 0（如兒童／學生設 0 元） | 該 `entryType` |

- **攀岩隊員**（`climbing_team`）**不免費**：僅標記身分後進入付費流程，享有效隊員 9 折（原價 ≥ 門檻時）。

---

## 階段 2 — 付費入場（二段式）

無任何免費資格 → 回傳**可選身分價（`entryTypeOptions`）**＋**付款工具（`instruments`）**，前端先選身分、再選要不要用票券。

### ① 身分入場價 · `entryTypeOptions`
依 `systemSettings/entryTypes` 動態產生（過濾停用 / 不適用身分），僅列 `price > 0`；有效隊員自動疊 9 折顯示 `discountedPrice`。設定缺失時 fallback 成單一「單次購票入場」（兒童→`child_free`、學生→`student_free`）。

### ② 付款工具 · `instruments`

| 工具 | entryType | 規則 |
|---|---|---|
| 使用優惠折扣券 | `discount_card` | 原價 **×0.8**；**兒童不適用**；有效隊員再疊 9 折 = **×0.72** |
| 黑卡 | `black_card` | 扣一點入場（次數卡，取消可還原） |
| 紅利 | `bonus` | 扣一次紅利入場，金額 = 0（取消還原） |
| 單次入場券 | `single_entry_ticket` | **擁有權須＝入場者**（家長代子→子女；轉贈→受贈者） |
| 購優惠折扣券入場 | `buy_discount_card` | 含本次入場 ＋ 10 次八折 ＋ 紅利 |

---

## 階段 3 — 付費金額後端權威計算

`computePaidEntryAmount(entryType, member, opts)` — QR 自助與站台電話入場**共用同一份折扣邏輯**，避免站台漏帶折扣。

```
最終金額 = 原價(entryTypes 該身分設定價)
         × 0.8   （opts.legacyDiscountCard：舊實體折扣卡，轉換期，只折入場費）
         × 0.9   （有效隊員 team discount，原價 ≥ TEAM_DISCOUNT_MIN_AMOUNT 才套）
```

- 兩者可疊加 = **×0.72**。
- **兒童 `child_free` 例外**：一律原價，**任何折扣都不套**（舊折扣卡 8 折與隊員 9 折皆不適用）—— 後端權威擋，涵蓋電話入場與 QR 自助。

---

## 會員自助 QR（產券 → 出示 → 掃碼預覽）

會員在手機上自助完成資格確認與選方式、產生入場 QR；**家長可為自己的子會員代驗、代產券**（驗擁有權）。此段全程**只驗不扣**，扣點在階段 4。

1. **驗資格** · `POST /checkin/verify`：以會員 token 為準（不用電話反查，避免親子共用電話誤判）；家長帶 `targetMemberId` 驗子女。回 `verifyEntry` 結果（見上方關卡 0／階段 1–3）。代驗非自己子女 → `403 FORBIDDEN`。
2. **選方式**：免費資格 → 直接產券；無免費資格 → 選身分價（`entryTypeOptions`）＋要不要用票券工具（`instruments`）→ 決定 `entryType`（+ `baseEntryType` / 票券 id）。
3. **產券** · `POST /checkin/qr/create`：`createPendingCheckIn` —— 再驗 waiver＋墜測、驗券可用性與擁有權、**後端權威重算金額**（**不預扣**）；家長可為子女產券。回 `qrToken`，手機顯示動態 QR（30 分效期）。
4. **出示掃碼** · `POST /checkin/qr/scan`（櫃檯）：`scanQrCode` 讀出待確認入場，**只預覽、不確認、不扣點**（會員／金額／加購／`totalAmount`）。已用 → `QR_ALREADY_USED`；已取消 → `QR_CANCELLED`；過期 → `QR_EXPIRED`。

預覽無誤 → 櫃檯按確認，進入 **階段 4 `confirmCheckIn`**（扣點 + 建入場 + 記帳）。

---

## 階段 4 — 站台掃 QR 確認入場（`confirmCheckIn`）

會員 QR 產生後（前置關卡與金額已定），櫃檯掃描跑 `confirmCheckIn(qrToken, staffId)` —— **扣點與記帳都發生在這一步**。

1. **驗 QR**：不存在 → `QR_NOT_FOUND`；狀態非 pending → `QR_INVALID_STATUS`；過 30 分效期 → `QR_EXPIRED`。
2. **先扣點（孤兒防護）**：依 `entryType` 先扣卡／券／紅利／建卡，**失敗即 throw、不建入場紀錄** → 杜絕「有入場、沒扣點」孤兒記錄。黑卡／單次券刻意延後到此刻才扣（產生 QR 但未確認入場 → 不扣卡、不鎖券）。

   | entryType | 動作 |
   |---|---|
   | `buy_discount_card` | 建一張新優惠卡（`purchaseDiscountCard`） |
   | `discount_card` | 扣一格（`useDiscountCard`） |
   | `black_card` | 扣一點（`useBlackCard`） |
   | `single_entry_ticket` | **重驗後**標記 `used`（防兩張 QR 重複用同券；無效／過期 → throw） |
   | `bonus` | 用掉紅利（`useBonus`） |

3. **建入場紀錄**：寫入 `checkIns`，`amountPaid = 入場費 + 岩鞋 + 粉袋`。
4. **收尾**：pending → `confirmed`（回填 `confirmedBy`／`checkInId`）；`tryExtendFallTest` 遞延墜落測驗效期。
5. **記營收**：`amountPaid > 0` 才寫 `recordTransaction(type: checkin)`（記 `entryFee`／`shoesPrice`），回填 `transactionId`；免費入場（0 元）不寫營收。

**取消入場**：`cancelCheckIn` 入場後 10 分鐘內可取消（super_admin 可 `force`），連帶**還原**已扣的卡／券／紅利（`restoreEntryCredits`）。

---

## 三條入場路徑

同一套資格與金額邏輯，三種進入方式（會員自助 QR／站台電話／站台直接）。差別在**扣點時機**與**站台專屬能力**。

| 路徑 | 觸發 | 資格判斷 | 金額計算 | 卡／券／紅利扣點時機 | 專屬能力 |
|---|---|---|---|---|---|
| **會員 QR 自助**<br>`createPendingCheckIn` | 會員出示動態 QR，櫃檯掃描 | 產生 QR 前**再驗一次** waiver＋墜測；驗券可用性與擁有權（**不預扣**） | `computePaidEntryAmount`；`discount_card` 走 8 折＋隊員；`bonus`＝0 | **確認才扣** — 產生 QR（30 分效期）不扣；櫃檯掃描 `confirmCheckIn` 才真正扣卡／鎖券／建卡 | — |
| **站台直接入場**<br>`POST /checkin/direct` | 員工端一次完成，支援卡／券／黑卡／紅利工具（前端先選好） | 內部走 `createPendingCheckIn` 的完整驗證（含 waiver／墜測、擁有權） | `computePaidEntryAmount`；`discount_card` 8 折＋隊員；`bonus`＝0 | **即時扣** — 產券後**立即** `confirmCheckIn`，無 QR 中介與 30 分等待 | 同日同館防重複；無實體 QR |
| **站台電話搜尋**<br>`POST /checkin/phone` | 員工搜會員電話，純付費入場（未選卡／券工具） | 沿用前置關卡結果；直接建立入場 | `computePaidEntryAmount`（可帶 `legacyDiscountCard` 旗標） | 即時建立入場紀錄；此路徑本就不走卡／券工具 | **已付費放行**、**舊折扣卡 8 折**、隊員 9 折 |

**共用核心**：`verifyEntry`（關卡 0 + 免費資格 + 付費選項）與 `computePaidEntryAmount`（折扣疊加、兒童例外）三路徑**同源一份**。

### 快速入場（今日課程學員名單）· `GET /checkin/today-course-students`

員工手機入場頁的一鍵名單。**本身只讀名單、不建入場、不扣點**；點選學員後才觸發實際入場（省去搜尋會員）。

1. **撈名單**：今日該館 `scheduled` 場次的 `confirmed` 報名者（排除候補／請假）；無場次／無報名 → 回空陣列。
2. **標已入場**：對照今日該館未取消入場者 → 標 `alreadyCheckedIn`（已入場者禁止重複點選）。
3. **點選入場**：依開課時間排序（附姓名／課名／時段）；員工點未入場學員 → 走既有入場流程。

點選後走 **階段 4 `confirmCheckIn`** 或 **站台直接 `/checkin/direct`**；課程學員在階段 1 命中 `course_access` → 免費放行，此捷徑只是一鍵入口。

### 站台直接入場 · `/checkin/direct`

員工端一次完成、**不產實體 QR、無會員掃碼等待**；前端已選身分價 + 卡／券工具。內部把「會員自助 QR」的產券與階段 4 的確認串成一次呼叫：

1. **防重複**：同日同館重複入場檢查 → 已入場回 `400`。
2. **產券（內部）** `createPendingCheckIn`：驗 waiver／墜測、算金額、不扣。
3. **立即確認** `confirmCheckIn`：扣點 · 建入場 · 記帳。

與階段 4 **共用同一套結算**（金額後端權威、票券／黑卡／紅利扣除、營收、墜落測驗遞延）；差別只在**沒有 QR 中介與 30 分等待**，`paymentMethod` 預設 `cash`。

### 站台電話入場專屬變形 · `/checkin/phone`

| 操作 | 旗標 | 行為 |
|---|---|---|
| **已付費放行** | `alreadyPaid` | 「已付費」只指**入場費**已收 → 入場費記 0（`already_paid`）；加購岩鞋／粉袋仍以**真實付款方式**另收 |
| **舊折扣卡 8 折** | `legacyDiscountCard` | 只折入場費；須後端開關 `checkinLegacyDiscountCard` 開啟才生效（**不單信前端旗標**） |
| **隊員 9 折** | （自動） | 與 QR 路徑同源自動套；寫入折後金額（`isTeamDiscount: true`），營收不高報 |
