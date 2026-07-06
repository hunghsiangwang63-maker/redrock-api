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
| 有無 QR | 有：`create` 產券、30 分鐘效期（`checkinService.js:777` 起），出示後櫃檯 `scan` 預覽、`confirm` 入場 | 無：`create`＋`confirm` 一次串接（`checkin.js:246` 起） | 無：直接寫入場紀錄（`checkin.js:597`） |
| 可用票券工具 | 全部：`pass`／`discount_card`／`black_card`／`single_entry_ticket`／`bonus`／`buy_pass`／`buy_discount_card`（`createPendingCheckIn` 參數，`checkinService.js:661` 起） | 全部：由前端帶 `instrument` → `createPendingCheckIn`（`checkin.js:239-247`） | ❌ 無：僅收 `entryType`＋`paymentMethod`（純付費）。VIP／定期票／課程免費由 `verifyEntry` 後端權威覆核（`checkin.js:504`，非信前端） |
| 扣點時機 | 確認才扣：`confirmCheckIn`（`checkinService.js:864`）；QR 產券階段黑卡／單次券「不」預扣 | 立即：`confirm` 同步執行 | 立即：寫 `checkIns`（`checkin.js:597`），`amountPaid>0` 才記營收 |
| 專屬特性 / 限制 | 30 分鐘效期；10 分鐘內可取消（`cancelCheckIn` `checkinService.js:957`）；家長可代子女產券 | 自查同日重複入場（`checkin.js:247-255`）；一次完成無等待 | 已付費放行 `alreadyPaid`（`checkin.js:553-603`）；轉換期舊折扣卡 8 折 `legacyDiscountCard`（`559-565`,`570`）；隊員 9 折；**無票券工具** |

### 站台帳號與值班（`stations.js` / `auth.js`）
- **館別電腦帳號**：`POST /stations/login`（`stations.js:34`），驗 `stations` 集合，發 `type:'station'` token（30 天，`stations.js:87-92`）。
- **值班打卡**：`POST /stations/shift/clockin`（`stations.js:111`），驗**員工** `staff` 帳號 → 建 `shiftLogs` → 發 `type:'operator'` token（含 `staffId`/`role`，16 小時，`stations.js:178-186`）。
- `authenticate`（`auth.js:50`）以 `decoded.staffId` 查 `staff` 文件 → `req.staff`。**純 `station` token（無 staffId）無法通過 `authenticate`**，必須先打卡轉成 `operator` 才能呼叫入場端點（`auth.js:59-63`、`215-216`）。
- 權限：`checkPermission`（`auth.js:161`，super_admin 全通過）；`requireManager`（`auth.js:232`，僅 super_admin/gym_manager）；`requireManagerOrStation`（`auth.js:217`，管理員或 operator/station）。

---

## 2. 關卡 0 — 前置關卡（依序，任一不過即擋下）

**單一權威來源 `runEntryGates`（`checkinService.js:345`）**：依序檢查以下四關，三條路徑皆呼叫它——`verifyEntry`（`checkinService.js:436`）、`createPendingCheckIn`（`checkinService.js:661`，QR/direct 走此）、`/checkin/phone`（`checkin.js:496`）。各路徑僅「轉譯」擋下結果為自己的回應格式（verifyEntry 回物件、createPendingCheckIn throw、路由回 res）。

| 順序 | 關卡 | blockReason | 在 runEntryGates |
|---|---|---|---|
| 1 | 同日同館重複入場 | `already_checked_in` | `checkinService.js:349-368` |
| 2 | Waiver 未完成 | `waiver_required`（未簽）／`parent_waiver_pending`（本人簽完待家長） | `checkinService.js:372-382` |
| 3 | 墜落測驗未通過 | `fall_test_required`（`never_tested`）／`fall_test_expired`（`expired`）／`fall_test_consent_required`（見下） | `checkinService.js:385-419` |
| 4 | 分期付款逾期 | `installment_overdue` | `checkinService.js:422-428` |

`checkFallTest` 回傳 `reason`：`never_tested`、`expired`。`runEntryGates` 選項：`expTicketMode`（`'owns'`/`'using'`，見下）、`installmentMemberId`（子女入場查家長分期）、`skipDuplicate`。

### 體驗券墜測例外（runEntryGates `expTicketMode`，`checkinService.js:385-419`）
未通過墜測者，若符合體驗券條件則**仍可入場**，但須先簽墜落測驗同意書（未簽回 `fall_test_consent_required`，已簽 `hasFallTestSignature` 放行）。條件依模式：
- **`'owns'`**（`verifyEntry` 與 `/checkin/phone`）：會員**持有**當日有效體驗券（`getValidSingleEntryTickets` 已限 `validDate===今日`、`ticketType==='experience'`）。用於「顯示/純付費」情境。
- **`'using'`**（`createPendingCheckIn`，QR / `/direct`）：此次入場**實際使用**的券即為體驗券（較嚴謹，避免持券卻走別的付費類型也被豁免）。

三條路徑共用同一份判定（`runEntryGates`），僅模式參數不同。

---

## 3. 階段 1 — 免費入場資格（由上而下，第一個命中即放行）

`verifyEntry`（`checkinService.js`），順序如下：

| 優先序 | 資格 | entryType | 行號 |
|---|---|---|---|
| 1 | VIP（`checkVip`） | `vip` | `466` |
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
- 建 `checkIns`，`amountPaid = amount + shoesPrice + chalkPrice`（`947`）。
- 墜測遞延 `tryExtendFallTest`（`975`）。
- `amountPaid>0` 才 `recordTransaction` 記營收（`980` 起）。
- 取消：10 分鐘內 `cancelCheckIn` 還原卡/券/紅利。

> QR 產券階段黑卡／單次券「不預扣、確認才扣」，故產 QR 未入場不會扣卡/鎖券。

---

## 6. 已知風險與收斂現況

**已收斂（本輪重構完成）：**
- ✅ **關卡 0 三份實作 → 單一 `runEntryGates`**（`checkinService.js:345`）：同日重複／Waiver／墜測／分期逾期，三路徑共用；`/direct` 移除自帶 dup 檢查。（原風險「同日重複三份實作」「/direct 不擋分期逾期」消除。）
- ✅ **`/checkin/phone` 免費資格改後端權威**：`checkin.js:504` 呼叫 `verifyEntry` 權威判定 VIP/定期票/課程，前端偽造免費 `entryType` 會被改回付費（防白嫖）。合法者結果不變。
- ✅ **舊折扣卡 8 折收斂進 `createPendingCheckIn`**（`checkinService.js` 算金額段帶 `legacyDiscountCard` 權威 toggle），QR/`direct` 亦支援，單一份折扣邏輯。
- ✅ **`/checkin/eligibility` 已全面共用**：`getCourseAccess`／`checkVip`／`getValidPasses`／`checkFallTest`／`checkWaiver`／`getValid*`（券卡）皆為共用函式；eligibility 僅為「全部攤開供店員選」的投影層（刻意不短路，與 verifyEntry 用途不同）。

**設計特性（非 bug，維持現狀）：**
1. **`/checkin/phone` 不直接收票券工具**（`passId`/`singleEntryTicketId`/`discountCardId`/`blackCardId`/`bonusId`）。使用票券由前端分流至 `/checkin/direct`（走 `createPendingCheckIn`＋`confirmCheckIn`），功能上不缺；兩條站台路徑分工明確。
2. **`/checkin/eligibility` 與 `verifyEntry` 用途不同**：前者「全部攤開」、後者「命中第一個即短路」。兩者共用相同底層函式，但回傳形狀刻意不同，屬設計而非漂移。
