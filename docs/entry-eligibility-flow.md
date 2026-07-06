# 入場資格判斷流程（後端權威）

> 本文件依「程式碼實際邏輯」整理，非推測。每條標明來源檔案與行號。
> 來源：`src/services/checkinService.js`、`src/routes/checkin.js`、`src/routes/stations.js`、`src/middleware/auth.js`。
> 權威判斷集中在 `checkinService.verifyEntry`（會員自助/資格顯示）與 `createPendingCheckIn`＋`confirmCheckIn`（實際建立入場、扣點）；前置關卡收斂在 `runEntryGates`。

---

## 1. 三條入場路徑比較

| 面向 | 會員 QR 自助 | 站台直接 `/checkin/direct` | 站台電話 `/checkin/phone` |
|---|---|---|---|
| 端點 | `/checkin/qr/create`（`checkin.js:65`）→ `/qr/scan`（`115`）→ `/qr/confirm`（`133`） | `/checkin/direct`（`checkin.js:235`） | `/checkin/phone`（`checkin.js:475`） |
| 認證 | `create`＝`authenticateAny`（會員或員工）；`scan`/`confirm`＝`authenticate`＋`checkPermission('checkin.create')` | `authenticate`（員工／值班 operator） | `authenticate`（員工／值班 operator） |
| 誰操作 | 會員本人，或家長代自己子女（`checkin.js:82-95`） | 值班員工（operator token）或管理員 | 值班員工（operator token）或管理員 |
| 有無 QR | 有：`create` 產券、30 分鐘效期（`checkinService.js:777` 起），出示後櫃檯 `scan` 預覽、`confirm` 入場 | 無：`create`＋`confirm` 一次串接（`checkin.js:246` 起） | 無：直接寫入場紀錄（`checkin.js:578` 起） |
| 前置關卡（關卡 0） | `createPendingCheckIn` → `runEntryGates`（`expTicketMode='using'`）（`checkinService.js:661`,`681`） | 同左（`/direct` 已移除自帶 dup 檢查，`checkin.js:245`） | 直接呼叫 `runEntryGates`（`expTicketMode='owns'`）（`checkin.js:496`） |
| 免費資格（VIP/定期票/課程） | `verifyEntry` 權威判定（`checkinService.js:436`） | 同 QR（`createPendingCheckIn`；身分由前端帶、金額後端權威） | **後端權威覆核**：呼叫 `verifyEntry`，前端偽造免費 `entryType` 會被改回付費（`checkin.js:504-518`） |
| 可用票券工具 | 全部：`pass`／`discount_card`／`black_card`／`single_entry_ticket`／`bonus`／`buy_pass`／`buy_discount_card`（`createPendingCheckIn` 參數，`checkinService.js:661` 起） | 全部：由前端帶 `instrument` → `createPendingCheckIn`（`checkin.js:238-249`） | ❌ 無票券工具：僅收 `entryType`＋`paymentMethod`（純付費）；使用票券由前端分流至 `/direct` |
| 舊折扣卡 8 折（轉換期） | ✅ 支援：`legacyDiscountCard` 旗標透傳 `createPendingCheckIn`（`checkin.js:78`,`102`；`checkinService.js:664`,`721`,`727`），後端 toggle 權威 | ✅ 支援：同左（`checkin.js:240`,`249`） | ✅ 支援：`legacyDiscountCard`（`checkin.js:523`,`536`），後端 toggle 權威 |
| 扣點時機 | 確認才扣：`confirmCheckIn`（`checkinService.js:864`）；QR 產券階段黑卡／單次券「不」預扣 | 立即：`confirm` 同步執行 | 立即：寫 `checkIns`（`checkin.js:578` 起），`amountPaid>0` 才記營收 |
| 專屬特性 / 限制 | 30 分鐘效期；10 分鐘內可取消（`cancelCheckIn` `checkinService.js:1000`,`1019-1020`）；家長可代子女產券 | 一次完成無等待；關卡 0 全由 `createPendingCheckIn` 的 `runEntryGates` 統一（無自帶查詢） | 已付費放行 `alreadyPaid`（`checkin.js:507`,`518`,`569`）；隊員 9 折；**無票券工具** |

### 站台帳號與值班（`stations.js` / `auth.js`）
- **館別電腦帳號**：`POST /stations/login`（`stations.js:34`），驗 `stations` 集合，發 `type:'station'` token（30 天，`stations.js:87-92`）。
- **值班打卡**：`POST /stations/shift/clockin`（`stations.js:111`），驗**員工** `staff` 帳號 → 建 `shiftLogs` → 發 `type:'operator'` token（含 `staffId`/`role`，16 小時，`stations.js:178-186`）。
- `authenticate`（`auth.js:50`）以 `decoded.staffId` 查 `staff` 文件 → `req.staff`。**純 `station` token（無 staffId）無法通過 `authenticate`**，必須先打卡轉成 `operator` 才能呼叫入場端點（`auth.js:59-63`、`215-216`）。
- 權限：`checkPermission`（`auth.js:161`，super_admin 全通過）；`requireManager`（`auth.js:232`，僅 super_admin/gym_manager）；`requireManagerOrStation`（`auth.js:217`，管理員或 operator/station）。

---

## 2. 關卡 0 — 前置關卡（單一權威 `runEntryGates`，依序，任一不過即擋下）

**`runEntryGates`（`checkinService.js:345`）**：依序檢查以下四關，三條路徑皆呼叫它——`verifyEntry`（`checkinService.js:436`）、`createPendingCheckIn`（`checkinService.js:661`,`681`，QR/direct 走此）、`/checkin/phone`（`checkin.js:496`）。各路徑僅「轉譯」擋下結果為自己的回應格式（verifyEntry 回物件、createPendingCheckIn throw、路由回 res）。

| 順序 | 關卡 | blockReason | 在 runEntryGates |
|---|---|---|---|
| 1 | 同日同館重複入場 | `already_checked_in` | `checkinService.js:349-368` |
| 2 | Waiver 未完成 | `waiver_required`（未簽）／`parent_waiver_pending`（本人簽完待家長） | `checkinService.js:372-382` |
| 3 | 墜落測驗未通過 | `fall_test_required`（`never_tested`）／`fall_test_expired`（`expired`）／`fall_test_consent_required`（見下） | `checkinService.js:385-419` |
| 4 | 分期付款逾期 | `installment_overdue`（`hasOverdueInstallment`，`checkinService.js:422-428`） | `checkinService.js:422-428` |

`runEntryGates` 選項（`checkinService.js:345`）：`skipDuplicate`、`expTicketMode`（`'owns'`/`'using'`）、`expTicketId`、`installmentMemberId`（子女入場查家長分期）。

### 體驗券墜測例外（`expTicketMode`，`checkinService.js:385-419`）
未通過墜測者，若符合體驗券條件則**仍可入場**，但須先簽墜落測驗同意書（未簽回 `fall_test_consent_required`，已簽 `hasFallTestSignature` 放行）。條件依模式：
- **`'owns'`**（`verifyEntry` 與 `/checkin/phone`）：會員**持有**當日有效體驗券（`getValidSingleEntryTickets` 已限 `validDate===今日`、`ticketType==='experience'`）。用於「顯示/純付費」情境。
- **`'using'`**（`createPendingCheckIn`，QR / `/direct`）：此次入場**實際使用**的券即為體驗券（較嚴謹，避免持券卻走別的付費類型也被豁免）。

三條路徑共用同一份判定（`runEntryGates`），僅模式參數不同。

---

## 3. 階段 1 — 免費入場資格（`verifyEntry`，由上而下，第一個命中即放行）

| 優先序 | 資格 | entryType | 行號 |
|---|---|---|---|
| 1 | VIP（`checkVip` `checkinService.js:206`） | `vip` | `466` |
| 2 | 定期票（`getValidPasses`；含臨時休館補償 `effectiveEndDate`） | `pass` | `476`（`getValidPasses` `111-126`） |
| 3 | 課程入館權益（`getCourseAccess`） | `course_access` | `487` |
| 4 | 免費短路：該身份適用的 `entryTypes` 中有 `price<=0`（如兒童/學生設 0） | 該 `type.id` | `536` |

- **攀岩隊員** `climbing_team`：**不免費**，往下走付費流程（付費時享隊員 9 折）（`498`）。
- 兒童/學生非固定免費，價格改由 `entryTypes` 設定決定。

---

## 4. 階段 2 — 付費入場（二段式：先選身分，再選票券）

### ① 身分入場價 · `entryTypeOptions`（`checkinService.js:543` 起）
- 來源 `systemSettings/entryTypes`，過濾 `active!==false`、身份適用（`memberTypes` 空＝不限；`course_member` 需有課程權益）（`527` 起）。
- 每項含 `price` 與 `discountedPrice`（隊員 9 折 `withTeam`，`524`）。
- 無適用類型時 fallback 依身份 `single_ticket`／`child_free`／`student_free`；fallback 價 `<=0` 亦免費放行。

### ② 付款工具 · `instruments`（`checkinService.js:582` 起）
| 工具 | 說明 | 限制 |
|---|---|---|
| `discountCard` | 優惠券 8 折（`rate=DISCOUNT_CARD_RATE=0.8`，`checkinService.js:27`） | 兒童不適用（`canUseDiscountCard` `519`） |
| `blackCard` | 黑卡（免費，扣次） | 需有剩餘次數 |
| `bonus` | 紅利（免費入場一次） | — |
| `singleEntryTicket` | 單次券／體驗券（`getValidSingleEntryTickets`，體驗券限當日 `validDate`） | — |
| `buyDiscountCard` | 入場當下購買優惠卡 | 兒童不可（`602`） |
| `buyPass` | 入場當下購買定期票 | 單館票僅該館可買（`createPendingCheckIn` `PASS_GYM_MISMATCH` `770`） |

### ③ 金額公式 · `computePaidEntryAmount`（`checkinService.js:84-106`）
- 基準金額 = `entryTypes[entryType].price`（`91`）。
- **兒童例外**：`entryType==='child_free'` → **一律原價、不套任何折扣**（`93-95`，權威擋、涵蓋電話與 QR）。
- 舊折扣卡 8 折：`opts.legacyDiscountCard` → `×0.8`（`99`）。
- 有效隊員且原價 `>= TEAM_DISCOUNT_MIN_AMOUNT` → `×0.9`（`96-97`,`100`）。
- 疊加＝`×0.8×0.9＝0.72`。
- 使用優惠券 `discount_card`：以所選 `baseEntryType` 原價 `×0.8`（＋隊員 `×0.9`），權威在 `createPendingCheckIn` `737` 起。

---

## 5. 階段 4 — `confirmCheckIn` 各 entryType 扣點動作（`checkinService.js:864`）

先扣券/卡（失敗即 throw、不建入場，避免「有入場沒扣點」孤兒）：

| entryType | 扣點動作 | 行號 |
|---|---|---|
| `buy_discount_card` | 建立新優惠卡（`purchaseDiscountCard`） | `884-892` |
| `buy_pass` | 開新定期票 `memberPass`（月數優先、否則天數效期） | `894-912` |
| `discount_card` | `useDiscountCard` 扣 1 次 | `913-914` |
| `black_card` | `useBlackCard` 扣 1 次 | `915-916` |
| `single_entry_ticket` | 重新驗證後標 `status='used'`（防重複用） | `917-927` |
| `bonus` | `useBonus` 用掉 | `928-929` |
| `pass` / `vip` / `course_access` / 免費 / 一般付費 | **不扣券**（定期票無限；付費類型僅記營收） | —（無對應分支） |

其後：
- 更新 pending `status='confirmed'`（`968`），建 `checkIns`，`amountPaid = amount + shoesPrice + chalkPrice`。
- 墜測遞延 `tryExtendFallTest`（`975`）。
- `amountPaid>0` 才 `recordTransaction` 記營收（`979-980` 起）。
- 取消：10 分鐘內 `cancelCheckIn`（`checkinService.js:1000`,`1019-1020`）還原卡/券/紅利（`buy_pass` 取消作廢定期票，`1075`）。

> QR 產券階段黑卡／單次券「不預扣、確認才扣」，故產 QR 未入場不會扣卡/鎖券。

---

## 6. 已修復（本輪重構完成，附修復方式與行號）

- ✅ **同日重複入場三份獨立實作 → 單一 `runEntryGates`**（原風險 4）
  - 修復方式：抽共用 `checkinService.runEntryGates`（`checkinService.js:345`），同日重複檢查在 `349-368`；`verifyEntry`（`436`）、`createPendingCheckIn`（`681`）、`/checkin/phone`（`496`）三路徑皆改呼叫；`/checkin/direct` 移除自帶 dup 查詢，改由 `createPendingCheckIn` 的 gate（`checkin.js:245`）。
- ✅ **`/checkin/phone` 免費資格改後端權威**（原風險 2）
  - 修復方式：`checkin.js:504-518` 呼叫 `verifyEntry`（`510`）；`elig.freeEntry && elig.entryType` → 覆寫為權威免費類型（`512`），前端送 `FREE_TYPES` 但實際非免費 → 改回權威付費身分（`513-515`）。合法者結果不變；已付費放行不覆核（`508`）。
- ✅ **舊折扣卡 8 折收斂進 `createPendingCheckIn`，三路徑一致**（原風險 3）
  - 修復方式：`createPendingCheckIn` 收 `legacyDiscountCard`（`checkinService.js:664`）、後端 toggle 權威檢查（`721`）、傳入 `computePaidEntryAmount({legacyDiscountCard})`（`727`）；`/qr/create`（`checkin.js:78`,`102`）與 `/direct`（`240`,`249`）透傳旗標；`/phone` 亦走同一份邏輯（`checkin.js:523`,`536`）。前端未送旗標→無折扣，行為不變。
- ✅ **`/checkin/direct` 補分期逾期擋**（連帶）
  - 修復方式：`runEntryGates` 第 4 關 `hasOverdueInstallment`（`checkinService.js:422-428`）；`/direct` 走 `createPendingCheckIn` 後即涵蓋，三路徑一致擋分期逾期。
- ✅ **`/checkin/eligibility` 底層查詢全面共用**（原風險 1 的「資料一致」部分）
  - 修復方式：Waiver 用 `checkWaiver`（`checkin.js:178`）、VIP 用 `checkVip`（`182`）、定期票用 `getValidPasses`（`191`，含場館限制/補償）、墜測用 `checkFallTest`（`194`）、可用券用 `getValidSingleEntryTickets`（`202`，體驗券限當日 `validDate`）。→ eligibility 回傳的**資源資料**（waiver/VIP/pass/墜測/券卡）與 `verifyEntry` 同源、一致，先前「單次券漏列/欄位不一致」漂移已消除。

---

## 7. 尚未修復 / 設計取捨

- ⚠️ **`/checkin/eligibility` 回傳形狀未與 `verifyEntry` 完全一致**（原風險 1 的「回傳結果一致」目標**尚未達成**）
  - 現況（`checkin.js:205-227`）：eligibility **僅回** `memberType`/`hasCourseAccess`/`waiverSigned`/`hasValidPass`/`isVip`/`fallTestPassed` 等**布林旗標** ＋ `instruments{discountCard, blackCard, bonus, singleEntryTicket}`。
  - **未包含** `verifyEntry` 才有的 `entryTypeOptions`（含隊員折扣）、`instruments.buyPass`、`instruments.buyDiscountCard`，也**不做免費短路**（不回單一 `freeEntry`/`entryType` 結果）。
  - 定位：目前作為「全部攤開供站台兩段流程挑選」的唯讀投影層，與 `verifyEntry`「命中第一個即短路、決定單一結果」用途不同。**底層函式已共用（資料一致），但回傳欄位非全等。**
  - 若要達成原風險 1 的「完全一致」：需在 eligibility 補回傳 `entryTypeOptions`／`buyPass`／`buyDiscountCard`／免費短路（屬**程式碼變更**，非文件層），目前尚未做。

- 設計特性（非 bug，維持現狀）：**`/checkin/phone` 不直接收票券工具**（`passId`/`singleEntryTicketId`/`discountCardId`/`blackCardId`/`bonusId`）。使用票券由前端分流至 `/checkin/direct`（走 `createPendingCheckIn`＋`confirmCheckIn`），功能上不缺；兩條站台路徑分工明確。
