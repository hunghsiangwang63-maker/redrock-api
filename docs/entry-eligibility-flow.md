# 入場資格判斷流程（後端權威）

> 本文件依「程式碼實際邏輯」整理，非推測。每條標明來源檔案與行號。
> 來源：`src/services/checkinService.js`、`src/routes/checkin.js`、`src/routes/stations.js`、`src/middleware/auth.js`。
> 權威判斷集中在 `checkinService.verifyEntry`（會員自助/資格顯示）與 `createPendingCheckIn`＋`confirmCheckIn`（實際建立入場、扣點）。

---

## 1. 三條入場路徑比較

| 面向 | 會員 QR 自助 | 站台直接 `/checkin/direct` | 站台電話 `/checkin/phone` |
|---|---|---|---|
| 端點 | `/checkin/qr/create`（`checkin.js:65`）→ `/qr/scan`（`115`）→ `/qr/confirm`（`133`） | `/checkin/direct`（`checkin.js:236`） | `/checkin/phone`（`checkin.js:486`） |
| 認證 | `create`＝`authenticateAny`（會員或員工）；`scan`/`confirm`＝`authenticate`＋`checkPermission('checkin.create')` | `authenticate`（員工／值班 operator） | `authenticate`（員工／值班 operator） |
| 誰操作 | 會員本人，或家長代自己子女（`checkin.js:82-95`） | 值班員工（operator token）或管理員 | 值班員工（operator token）或管理員 |
| 有無 QR | 有：`create` 產券、30 分鐘效期（`checkinService.js:739`），出示後櫃檯 `scan` 預覽、`confirm` 入場 | 無：`create`＋`confirm` 一次串接（`checkin.js:257-264`） | 無：直接寫入場紀錄（`checkin.js:631`） |
| 可用票券工具 | 全部：`pass`／`discount_card`／`black_card`／`single_entry_ticket`／`bonus`／`buy_pass`／`buy_discount_card`（`createPendingCheckIn` 參數，`checkinService.js:620-626`） | 全部：由前端帶 `instrument` → `createPendingCheckIn`（`checkin.js:239-261`） | ❌ 無：僅收 `entryType`＋`paymentMethod`（純付費）。VIP／定期票／課程免費靠前端送 `entryType`（見風險 §6-3） |
| 扣點時機 | 確認才扣：`confirmCheckIn`（`checkinService.js:822`）；QR 產券階段黑卡／單次券「不」預扣（`655-680`） | 立即：`confirm` 同步執行（`checkin.js:262`） | 立即：寫 `checkIns`（`checkin.js:631`），`amountPaid>0` 才記營收（`636-651`） |
| 專屬特性 / 限制 | 30 分鐘效期；10 分鐘內可取消（`cancelCheckIn` `checkinService.js:957`）；家長可代子女產券 | 自查同日重複入場（`checkin.js:247-255`）；一次完成無等待 | 已付費放行 `alreadyPaid`（`checkin.js:553-603`）；轉換期舊折扣卡 8 折 `legacyDiscountCard`（`559-565`,`570`）；隊員 9 折；**無票券工具** |

### 站台帳號與值班（`stations.js` / `auth.js`）
- **館別電腦帳號**：`POST /stations/login`（`stations.js:34`），驗 `stations` 集合，發 `type:'station'` token（30 天，`stations.js:87-92`）。
- **值班打卡**：`POST /stations/shift/clockin`（`stations.js:111`），驗**員工** `staff` 帳號 → 建 `shiftLogs` → 發 `type:'operator'` token（含 `staffId`/`role`，16 小時，`stations.js:178-186`）。
- `authenticate`（`auth.js:50`）以 `decoded.staffId` 查 `staff` 文件 → `req.staff`。**純 `station` token（無 staffId）無法通過 `authenticate`**，必須先打卡轉成 `operator` 才能呼叫入場端點（`auth.js:59-63`、`215-216`）。
- 權限：`checkPermission`（`auth.js:161`，super_admin 全通過）；`requireManager`（`auth.js:232`，僅 super_admin/gym_manager）；`requireManagerOrStation`（`auth.js:217`，管理員或 operator/station）。

---

## 2. 關卡 0 — 前置關卡（依序，任一不過即擋下）

權威在 `verifyEntry`（`checkinService.js:338`）；QR/`direct` 於 `createPendingCheckIn` 再查一次；`/phone` 於路由內自查。

| 順序 | 關卡 | blockReason | verifyEntry | createPendingCheckIn（QR/direct） | /checkin/phone |
|---|---|---|---|---|---|
| 1 | 同日同館重複入場 | `already_checked_in` | `checkinService.js:345-362` | —（`/direct` 於路由自查 `checkin.js:247-255`） | `checkin.js:508-513` |
| 2 | Waiver 未完成 | `waiver_required`（未簽）／`parent_waiver_pending`（本人簽完待家長） | `checkinService.js:366-376` | `checkinService.js:637-638` | `checkin.js:522-524` |
| 3 | 墜落測驗未通過 | `fall_test_required`（`never_tested`）／`fall_test_expired`（`expired`）／`fall_test_consent_required`（見下） | `checkinService.js:378-401` | `checkinService.js:640-653` | `checkin.js:527-548` |
| 4 | 分期付款逾期 | `installment_overdue` | `checkinService.js:403-413` | `checkinService.js:655-659` | `checkin.js:516-521` |

`checkFallTest` 回傳 `reason`：`never_tested`（`checkinService.js:238`）、`expired`（`256`）。

### 體驗券墜測例外（三條路徑現皆一致）
條件：該會員有「當日有效體驗券」（`getValidSingleEntryTickets` 已限 `validDate===今日`，`checkinService.js:217-227`）且該券 `ticketType==='experience'`。
行為：未通過墜測**仍可入場**，但須先簽墜落測驗同意書；未簽回 `fall_test_consent_required`，已簽（`hasFallTestSignature`）放行。
- `verifyEntry`：`checkinService.js:382-392`
- `createPendingCheckIn`（QR / `/direct`）：`checkinService.js:644-652`
- `/checkin/phone`：`checkin.js:530-542`

> 註：`/checkin/phone` 的此例外於 commit `795c43d` 補上；在此之前電話路徑無此例外、曾與 QR 路徑不一致。**目前三條路徑已一致。**

---

## 3. 階段 1 — 免費入場資格（由上而下，第一個命中即放行）

`verifyEntry`（`checkinService.js`），順序如下：

| 優先序 | 資格 | entryType | 行號 |
|---|---|---|---|
| 1 | VIP | `vip` | `425-433` |
| 2 | 定期票（`getValidPasses`；含臨時休館補償 `effectiveEndDate`） | `pass` | `435-444`（`getValidPasses` `111-126`） |
| 3 | 課程入館權益（`getCourseAccess`） | `course_access` | `446-455` |
| 4 | 免費短路：該身份適用的 `entryTypes` 中有 `price<=0`（如兒童/學生設 0） | 該 `type.id` | `496-499`；fallback `524-526` |

- **攀岩隊員** `climbing_team`：**不免費**，往下走付費流程（付費時享隊員 9 折）（`457-461`）。
- 兒童/學生非固定免費，價格改由 `entryTypes` 設定決定（`463-464`）。

---

## 4. 階段 2 — 付費入場（二段式：先選身分，再選票券）

### ① 身分入場價 · `entryTypeOptions`（`checkinService.js:502-533`）
- 來源 `systemSettings/entryTypes`，過濾 `active!==false`、身份適用（`memberTypes` 空＝不限；`course_member` 需有課程權益）（`486-493`）。
- 每項含 `price` 與 `discountedPrice`（隊員 9 折 `withTeam`，`483-484`）。
- 無適用類型時 fallback 依身份 `single_ticket`／`child_free`／`student_free`（`514-533`）；fallback 價 `<=0` 亦免費放行（`524-526`）。

### ② 付款工具 · `instruments`（`checkinService.js:541-564`）
| 工具 | 說明 | 限制 |
|---|---|---|
| `discountCard` | 優惠券 8 折（`rate=DISCOUNT_CARD_RATE=0.8`，`checkinService.js:27`） | 兒童不適用（`canUseDiscountCard` `478`） |
| `blackCard` | 黑卡（免費，扣次） | 需有剩餘次數 |
| `bonus` | 紅利（免費入場一次） | — |
| `singleEntryTicket` | 單次券／體驗券（`getValidSingleEntryTickets`，體驗券限當日 `validDate`） | — |
| `buyDiscountCard` | 入場當下購買優惠卡 | 兒童不可（`561`） |
| `buyPass` | 入場當下購買定期票 | 單館票僅該館可買（`createPendingCheckIn:729-731`） |

### ③ 金額公式 · `computePaidEntryAmount`（`checkinService.js:84-106`）
- 基準金額 = `entryTypes[entryType].price`（`91`）。
- **兒童例外**：`entryType==='child_free'` → **一律原價、不套任何折扣**（`93-95`，權威擋、涵蓋電話與 QR）。
- 舊折扣卡 8 折：`opts.legacyDiscountCard` → `×0.8`（`99`）。
- 有效隊員且原價 `>= TEAM_DISCOUNT_MIN_AMOUNT` → `×0.9`（`96-97`,`100`）。
- 疊加＝`×0.8×0.9＝0.72`。
- 使用優惠券 `discount_card`：以所選 `baseEntryType` 原價 `×0.8`（＋隊員 `×0.9`），權威在 `createPendingCheckIn:697-715`。

---

## 5. 階段 4 — `confirmCheckIn` 各 entryType 扣點動作（`checkinService.js:822`）

先扣券/卡（失敗即 throw、不建入場，避免「有入場沒扣點」孤兒）（`840-888`）：

| entryType | 扣點動作 | 行號 |
|---|---|---|
| `buy_discount_card` | 建立新優惠卡（`purchaseDiscountCard`） | `842-851` |
| `buy_pass` | 開新定期票 `memberPass`（月數優先、否則天數效期） | `852-870` |
| `discount_card` | `useDiscountCard` 扣 1 次 | `871-872` |
| `black_card` | `useBlackCard` 扣 1 次 | `873-874` |
| `single_entry_ticket` | 重新驗證後標 `status='used'`（防重複用） | `875-885` |
| `bonus` | `useBonus` 用掉 | `886-887` |
| `pass` / `vip` / `course_access` / 免費 / 一般付費 | **不扣券**（定期票無限；付費類型僅記營收） | —（無對應分支） |

其後：
- 建 `checkIns`，`amountPaid = amount + shoesPrice + chalkPrice`（`891-921`,`905`）。
- 墜測遞延 `tryExtendFallTest`（`932`）。
- `amountPaid>0` 才 `recordTransaction` 記營收（`935-951`）。
- 取消：10 分鐘內 `cancelCheckIn` 還原卡/券/紅利（`checkinService.js:957`）。

> QR 產券階段黑卡／單次券「不預扣、確認才扣」（`createPendingCheckIn:655-680` 註解），故產 QR 未入場不會扣卡/鎖券。

---

## 6. 已知風險（僅列程式碼實際存在的不一致）

1. **`/checkin/eligibility` 是 `verifyEntry` 的平行簡化實作。**
   `checkin.js:170` vs `checkinService.js:338`。eligibility 只回 `instruments`（discountCard/blackCard/bonus/singleEntryTicket）＋`hasValidPass`，**不回** `entryTypeOptions`／`buyPass`／`buyDiscountCard` 與免費短路邏輯；`entryTypes`／折扣規則改動須兩邊各自維護。（單次券已改為呼叫權威 `getValidSingleEntryTickets`，`checkin.js:203`。）

2. **`/checkin/phone` 不獨立驗證免費資格。**
   `checkin.js:486` 依前端傳入的 `entryType` 計價；VIP／定期票／課程免費靠前端送 `entryType='vip'/'pass'/'course_access'`（`computePaidEntryAmount` 回 `null` → `amountPaid=0`，`checkin.js:566-582`）。後端未於 `/phone` 重新確認 VIP/pass/course 資格。

3. **`/checkin/phone` 無法直接使用會員票券。**
   `checkin.js:486` 未收 `passId`/`singleEntryTicketId`/`discountCardId`/`blackCardId`/`bonusId`；使用票券須改走 `/checkin/direct`（前端據 `instrument` 分流，`checkin.js:239-261`）。

4. **舊折扣卡 8 折僅 `/checkin/phone` 支援。**
   `legacyDiscountCard` 選項只有 `/phone` 傳入 `computePaidEntryAmount`（`checkin.js:570`）；`createPendingCheckIn:688` 呼叫時未帶 `opts` → QR／`/direct` 路徑不支援舊折扣卡 8 折。

5. **同日重複入場檢查有三份獨立實作。**
   `verifyEntry`（`checkinService.js:345-362`）、`/direct`（`checkin.js:247-255`）、`/phone`（`checkin.js:508-513`）各自查詢，邏輯需手動保持一致。

> 已修復（不再是風險）：`/checkin/direct`（經 `createPendingCheckIn`）原先未擋分期逾期，已於 `checkinService.js:655-659` 補上 `hasOverdueInstallment` 檢查，三條路徑現皆擋分期逾期。
