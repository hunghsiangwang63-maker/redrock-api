# 會員身分 / 入場審核 / 票券 / 課程 — 全流程參照

> 本文件為**只讀盤點**，逐條對應程式碼實際邏輯，不做任何推測；每條標註 `file:line`。
> 路徑前綴：後端 = `redrock-api/`，前端 = `redrock-web/`。
> 產出方式：6 個平行讀碼 agent 掃描後彙整（2026-07-06）。
> 相關權威文件：`docs/entry-eligibility-flow.md`（入場資格）、`docs/course-experience-features.md`（課程 / 體驗）。

> ⚠️ **本文件僅描述現狀，內含數個「已定義但未實際啟用 / 兩處實作可能不一致」的標註**（見各段與文末〈跨檔案風險清單〉），閱讀時請留意。

---

## 目錄
1. [會員身分與對應權限](#1-會員身分與對應權限)
2. [入場審核所有排列組合](#2-入場審核所有排列組合)
3. [會員端操作介面全功能](#3-會員端操作介面全功能)
4. [員工端操作介面全功能](#4-員工端操作介面全功能)
5. [附錄 A：票券 / 定期票 / 卡片 / 紅利狀態機](#附錄-a票券--定期票--卡片--紅利狀態機)
6. [附錄 B：課程 / 體驗 / 試上 / 排測 / 代班](#附錄-b課程--體驗--試上--排測--代班)
7. [附錄 C：跨檔案風險清單（定義但未啟用 / 平行實作）](#附錄-c跨檔案風險清單)

---

# 1. 會員身分與對應權限

## 1.1 員工 / 站台三種 token 類型

token 以 `decoded.type` 區分（`src/middleware/auth.js`）：

- **`staff`** — 個人帳號登入（`src/routes/auth.js:102-106`）。
- **`station`** — 館別電腦帳號，30 天效期（`src/routes/stations.js:87-92`）。
- **`operator`** — 已打卡上班（clock-in）身分，16 小時效期（`src/routes/stations.js:178-186`）。
- 註記：個人 `type:'staff'` 即使權限鍵符合，仍被擋在「站台限定」端點外；必須打卡成為 `operator`（`src/middleware/auth.js:213-216`）。

**認證 middleware**（`src/middleware/auth.js:229-231`）：
- `authenticate` — staff/operator token，載入 staff 文件，`!isActive` 直接拒（`:50-71`）
- `authenticateStation` — 只收 `station|operator`（`:87-105`）
- `authenticateMember` — 只收 `member`（`:108-129`）
- `authenticateAny` — member 或 staff，會員端入場流程用（`:132-159`）
- `requireStationAuth` — 只允許 `operator` 或 `super_admin`（`:74-83`）
- `requireManagerOrStation` — 允許 `super_admin/gym_manager` 或 token 型別 `operator/station`（`:217-227`；用於 rentals / passAdjustments / members / fallTests / courseAdjustments / teamMembers）
- `requireSameGym`（`:181-191`）、`auditLog`（非 GET 成功寫 `auditLog` collection，`:193-211`）

## 1.2 員工四種角色與權限矩陣

角色 enum：`super_admin | gym_manager | full_time | part_time`（`src/config/schema.js:192`、`src/routes/staff.js:23`）。

- **super_admin**：`checkPermission` 直接放行（`src/middleware/auth.js:165`）；跳過跨館限制（`:184`）；`gymId=null`（`src/routes/staff.js:69,108`）；唯一能遠端使用站台限定端點而不打卡（`:76`、`:218`）；唯一管理員工帳號 CRUD 與站台電腦帳號（`src/routes/stations.js:18-21`）；登入跳過裝置綁定（`src/routes/auth.js:82`）。
- **gym_manager / full_time / part_time**：權限由 `DEFAULT_PERMISSIONS` 矩陣決定（`src/middleware/auth.js:4-47`），查無鍵預設 `false`（`:168`）；限自己 `gymId`（`:184-188`）。
- **每館覆寫**：Firestore `permissionOverrides/{gymId}_{role}_{permKey}.allowed` 可翻轉任一權限（`src/middleware/auth.js:170-172`）。
- 登入後角色跳轉：super_admin→`/staff/dashboard/all`、gym_manager→`/staff/dashboard`、full_time/part_time→`/staff/checkin`（`src/routes/auth.js:110-115`）。

**權限鍵 → 角色**（`src/middleware/auth.js:5-46`，順序：super_admin / gym_manager / full_time / part_time）：

| 權限鍵 | SA | GM | FT | PT | 行 |
|---|---|---|---|---|---|
| `members.create` | ✓ | ✓ | ✓ | ✗ | :5 |
| `members.read` | ✓ | ✓ | ✓ | ✓ | :6 |
| `members.update` | ✓ | ✓ | ✓ | ✗ | :7 |
| `members.delete` | ✓ | ✗ | ✗ | ✗ | :8 |
| `members.read_all_gyms` | ✓ | ✗ | ✗ | ✗ | :9 |
| `waiver.sign` / `waiver.send_parent` | ✓ | ✓ | ✓ | ✓ | :10-11 |
| `checkin.create` / `checkin.read` | ✓ | ✓ | ✓ | ✓ | :12-13 |
| `checkin.read_all_gyms` | ✓ | ✗ | ✗ | ✗ | :14 |
| `passes.create` | ✓ | ✓ | ✓ | ✓ | :15 |
| `installments.manage` | ✓ | ✓ | ✓ | ✓ | :16 |
| `passes.update` | ✓ | ✓ | ✓ | ✓ | :17 |
| `passes.delete` | ✓ | ✓ | ✗ | ✗ | :18 |
| `passes.approve` | ✓ | ✓ | ✗ | ✗ | :19 |
| `vip.manage` | ✓ | ✗ | ✗ | ✗ | :20 |
| `pass_types.manage` | ✓ | ✓ | ✗ | ✗ | :21 |
| `courses.manage` / `create` / `update` / `delete` / `notify` | ✓ | ✓ | ✓ | ✗ | :22,26-28,30 |
| `courses.attendance` | ✓ | ✓ | ✓ | ✓ | :29 |
| `products.manage` / `inventory.manage` | ✓ | ✓ | ✓ | ✗ | :23,32 |
| `products.warehouse` | ✓ | ✗ | ✗ | ✗ | :24 |
| `products.sell` | ✓ | ✓ | ✓ | ✓ | :31 |
| `settings.manage` | ✓ | ✗ | ✗ | ✗ | :25 |
| `revenue.record` | ✓ | ✓ | ✓ | ✓ | :33 |
| `revenue.report` | ✓ | ✓ | ✗ | ✗ | :36 |
| `revenue.report_all` | ✓ | ✗ | ✗ | ✗ | :37 |
| `schedule.manage` | ✓ | ✓ | ✗ | ✗ | :34 |
| `schedule.read` | ✓ | ✓ | ✓ | ✓ | :35 |
| `notifications.send_gym` | ✓ | ✓ | ✓ | ✗ | :38 |
| `notifications.send_all` | ✓ | ✗ | ✗ | ✗ | :39 |
| `gyms.manage` / `permissions.manage` | ✓ | ✗ | ✗ | ✗ | :40-41 |
| `competitions.manage` | ✓ | ✓ | ✗ | ✗ | :42 |
| `competitions.entries` | ✓ | ✓ | ✓ | ✓ | :43 |
| `competitions.sync` | ✓ | ✓ | ✓ | ✗ | :44 |
| `staff.manage` | ✓ | ✓ | ✗ | ✗ | :45 |
| `devices.manage` | ✓ | ✗ | ✗ | ✗ | :46 |

## 1.3 站台帳號（館別電腦帳號）

- **collection**：`stations`（字串直查，無 `COLLECTIONS` 常數，`src/routes/stations.js:45`）。欄位：`name/email/passwordHash(bcrypt)/gymId/gymName/isActive/notificationEmail/...`（`:331-336`）。
- **`POST /stations/login`**（`:34-108`）：以 email 查（`:45`）、`!isActive` 拒（`:51`）、`loginLock` 節流（`:53-64`）、`bcrypt.compare`（`:58`）、選配裝置綁定（`:66-83`）→ 發 30 天 token `{stationId,gymId,gymName,type:'station'}`（`:87-92`）。
- **gymId**：直接取站台文件的 `gymId`，一台電腦固定綁一館（`:88-91`、建立/編輯時對 `gyms` 驗證 `:327-328,354-357`）。
- **打卡上班 `POST /stations/shift/clockin`**（`:111-202`）：驗 staff email+password（`:125-144`）→ 寫 `shiftLogs`（`:160-173`）→ 發 16 小時 `operator` token `{staffId,staffName,staffRole,gymId,stationId,shiftId,type:'operator'}`（`:178-186`）。
- 站台帳號 CRUD 為 super_admin only（`requireSuperAdmin`，`:18-21,298,311,343`）。

## 1.4 會員身分屬性

Member schema：`src/config/schema.js:35-76`；建立於 `createMember`（`src/services/memberService.js:103-168`）。

- **`memberType`** `general|child|student|vip`（`schema.js:51`）。**建立時不寫入**（`createMember` 未寫，`memberService.js:126-148`），改由 `getMemberType` 執行期推導（`src/services/checkinService.js:53-62`）：優先序 VIP > climbing_team > child(<13) > student(13–22，或 >22 且 `studentVerified`) > general。
  - ⚠️ **不一致**：`getMemberType` 會回傳 schema enum 沒有的 `'climbing_team'`（`checkinService.js:55`）。
- **`studentVerified` 等**（`schema.js:54-57`）：>22 歲主張學生價的關卡，`checkinService.js:60` 檢查。
- **`isMinor`**（<18，建立時由生日算，`memberService.js:119-120,136`）→ 決定家長 waiver（`src/routes/members.js:387`、`src/services/waiverService.js:48`）。
- **`isChildAccount`**（`schema.js:60`）：子帳號與家長共用電話 → 略過電話唯一檢查（`memberService.js:107-116`）、略過 legacy 墜測自動 claim（`:67`）；共用電話多筆時用於解析家長（`:244`）；子帳號滿 18 有 `needsPromotion` 提示（`checkinService.js:402`）。
- **`parentMemberId`**（`schema.js:61`）：家長 waiver email 路由（`members.js:382`）。
- **`registeredBy`** `self|staff|migration`（`schema.js:63`）：由 staffId 建立則 `staff`，否則 `self`（`memberService.js:139`）。`self`+未驗證 email → 觸發 block reason（`:31`）。⚠️ enum 有 `migration`，但 `createMember` 只寫 `staff|self`；移轉來源另由 `migratedFrom/legacyBarcode` 記（`schema.js:71-72`）。
- **`emailVerified`**（`schema.js:64`）：店員建立預設 `true`、自助註冊 `false`（`memberService.js:140`）；`verifyEmail` 驗證（`:264-291`）。
- **封鎖狀態**：實際欄位是 **`isBlocked`(bool) + `blockReasons`(string[])**（`schema.js:68-69`）。`getBlockReasons` 計算（`memberService.js:26-59`）：`email_unverified`（self+未驗證，`:31`）、`waiver_unsigned`/`parent_waiver_pending`（`:37-44`）、`fall_test_required`（無 `result=='passed'` 墜測，`:48-55`）。`refreshBlockStatus` 重算（`:249-261`）。
- **VIP 雙來源**：(1) `vipMembers` collection（`checkVip`，`checkinService.js:188-196`）；(2) `member.memberType==='vip'`（`checkinService.js:54`、`checkin.js:181-183`）。新增 VIP 兩者都寫（`src/routes/vip.js:62-74,137`），受 `vip.manage`（super_admin only）控管。⚠️ **程式碼中沒有「測試VIP」概念**，該字樣僅出現在 seed/測試資料註解，不是會員屬性。
- **攀岩隊員（隊員）**：由 member 文件旗標驅動（**不在 schema.js**）：`isTeamMember/teamMemberSince/teamMemberUntil/...`，`setTeamMember`/`removeTeamMember`（`src/services/teamMemberService.js:17-62`）。`isActiveTeamMember` = 旗標 true 且今日落在 since/until（`:65-70`）。享 9 折（`TEAM_DISCOUNT_RATE=0.9`），對象金額 ≥ NT$100（`TEAM_DISCOUNT_MIN_AMOUNT=100`）（`:12-13`）。設定端點 `POST /teamMembers/members` 受 `requireManagerOrStation`（`src/routes/teamMembers.js:166`）。⚠️ **兩套機制獨立且可能不一致**：`getMemberType` 回 `'climbing_team'`（`checkinService.js:55`）且入場流程有一段 `climbing_team` 明確 no-op（`:440-443`），但實際 9 折只看 `isTeamMember` 旗標，不看 `memberType`。
- **Waiver `isComplete`**（`schema.js:95`）：成人或子帳號代簽 → 立即 `true`（`waiverService.js:48`）；否則家長簽完才 true；已 true 擋重簽（`:27,98`）。
- **墜測 `result`** — ⚠️ **schema/程式不一致**：`fallTestSchema.result` 註為 `'pass|fail'`（`schema.js:105`），但全程式用 `'passed'|'failed'`（`fallTestService.js:35,57,61,66`；`memberService.js:50`；`fallTests.js:46`）。到期由 `resolveFallTestExpiry`/`checkFallTest` 決定（`checkinService.js:42-48,213`）；註冊時可依電話+姓名自動 claim legacy 墜測（`claimLegacyFallTest`，`memberService.js:65-101`）。

## 1.5 身分 → 入場特權對照（速查，完整見第 2 節）

- **VIP → 免費**：`checkVip` 或 `memberType==='vip'` → `entryType:'vip', freeEntry:true`（`checkinService.js:407-415`）。
- **定期票 / 課程 → 免費**：有效 pass（`:417-426`）；課程存取（`:428-437`）。
- **隊員 9 折**：不是免費，走 `computePaidEntryAmount` 內 `isActiveTeamMember`（`checkinService.js:96-100`），權威在 `teamMemberService.js:12-13,73`。
- **兒童 / 學生**：不再硬編免費，價格來自 `systemSettings/entryTypes`（`checkinService.js:445-446`）；兒童 `child_free` 明確不吃任何折扣（`:92-94`、`canUseDiscountCard` 排除 child `:459`）。
- **一般**：落入付費選項（優惠卡 / 黑卡 / 單次券 / 紅利，`:449-453`）。
- **員工入場**：由 staff token 決定，會員端函式不處理（`:448`）；schema 有 `staff_override` entryType（`schema.js:161`）。

---

# 2. 入場審核所有排列組合

> 執行期權威：`verifyEntry` / `computePaidEntryAmount` / `createPendingCheckIn` / `confirmCheckIn`（`src/services/checkinService.js`）；路由 `src/routes/checkin.js`。任一關卡失敗即 early-return，不再往下。

## 2.1 前置關卡（關卡 0，依執行順序）

1. **同日重複入場** — `checkinService.js:321-344`。查 `CHECK_INS` 同 `memberId`+`gymId`、`isCancelled==false`、`checkedInAt` 落在台灣日界內（`:323-333`）→ `status:'already_checked_in'`。**已啟用**。`/checkin/direct`（`checkin.js:255-262`）與 `/checkin/phone`（`checkin.js:508-517`）另有自己的重複檢查，但**只用 `checkedInAt>=today` 下界、無上界**。
2. **Waiver** — `checkinService.js:349-358`（`checkWaiver` `:309-316`）。讀 `WAIVERS/{memberId}`，不存在/`!isComplete` → 擋。`incomplete`→`parent_waiver_pending`，否則 `waiver_required`。**已啟用**；phone 路徑硬擋（`checkin.js:526-529`）。
3. **安全墜落測驗** — `checkinService.js:361-383`（`checkFallTest` `:213-247`）。查 `FALL_TESTS` `result=='passed'` 取最新，`resolveFallTestExpiry`（`:42-49`）判到期。未過→`fall_test_required`、過期→`fall_test_expired`。**已啟用**；phone 硬擋（`checkin.js:531-539`）。
   - **墜測例外（當日體驗券）** — `checkinService.js:363-374`：持**當日有效體驗券**（`getValidSingleEntryTickets` 濾 `ticketType==='experience'`）可略過墜測，但**必須簽過墜測同意書**（`hasFallTestSignature` 讀 `fallTestSignatures`，`:250-254`）；未簽→`fall_test_consent_required`。此例外在 `createPendingCheckIn`（`:613-625`）以**所選票券**的 `ticketType==='experience'` 為準。⚠️ **phone 路徑（`checkin.js:531-539`）無此體驗券例外，一律硬擋**。
4. **分期付款逾期** — `checkinService.js:385-395`（`hasOverdueInstallment`，`installmentService.js:255-262`）：任一 `INSTALLMENT_PLANS` `status=='overdue'` → `installment_overdue`。**已啟用**；phone 以 `parentMemberId||memberId` 重查（`checkin.js:520-523`）。

**⚠️ 定義但未在入場啟用：**
- **`email_unverified`** 只定義在 `memberService.getBlockReasons`（`memberService.js:30-33`）。`verifyEntry`/`createPendingCheckIn`/`/checkin/direct`/`/checkin/phone` **都沒讀 `isBlocked`/`blockReasons`**。它只在**會員登入**時生效 → `403 EMAIL_NOT_VERIFIED`（`auth.js:209`，受 `isEmailVerificationEnabled()` 控管）。文件已註此 caveat（`entry-eligibility-flow.md:26`）。
- 整個 `getBlockReasons`/`refreshBlockStatus`（含 `waiver_unsigned`/`fall_test_required` 等）是**與入場實時檢查平行、另存於 member 文件**的一套 reason；入場自己重算、不參考持久化旗標。

## 2.2 免費資格（階段 1）— 依序短路，第一個命中回 `freeEntry:true`

順序（`checkinService.js:407-480`）：

1. **VIP** — `checkVip`（`:188-196`）查 `VIP_MEMBERS`。命中→`entryType:'vip'`（`:408-415`）。（⚠️ `/eligibility` 另認 `member.memberType==='vip'`，`checkin.js:181-182`；`verifyEntry` 只查 collection。）
2. **定期票** — `getValidPasses`（`:111-126`）：`MEMBER_PASSES` `status=='active'`，再濾 `(effectiveEndDate||endDate)>=today`（臨時休館補償後到期日）、`scope==='shared'||targetGymId===gymId`、`credits===null||credits>0`。命中→`entryType:'pass'`（`:418-426`）。（⚠️ `/eligibility` 用 `scope==='all'||p.gymId===gymId` 且無 credits 檢查，`checkin.js:195-197` — 欄位/條件不同。）
3. **course_access** — `getCourseAccess`（`:129-185`）：`COURSE_ENROLLMENTS` `status=='confirmed'`、排除 `pauseStatus==='paused'`；今日落在無限練習窗、或今日有該員參加的場次 → 免費（`:429-437`）。
4. **攀岩隊員** — **明確不免費**（`:440-443` no-op），落入付費、僅享 9 折。
5. **免費短路（price ≤ 0）** — `:466-480`：由 `systemSettings/entryTypes` 建 `configuredTypes`（排除 course_access、`active!==false`、依 memberTypes 濾），第一個 `price<=0` 者 → 免費。fallback 路徑亦短路（`:498-507`）。

## 2.3 付費計算（階段 2/3）— `computePaidEntryAmount`（`checkinService.js:84-106`）

QR 自助（`createPendingCheckIn`）與站台電話（`/checkin/phone`）**共用同一權威**。

- 底價 = `systemSettings/entryTypes` 中 `id===entryType && active!==false` 的 `.price`（`:86-91`）；查無回 `null`（由呼叫端 fallback）。
- 折扣乘數（`:99-100`）：
  - **舊折扣卡** `opts.legacyDiscountCard` → `×0.8`（`DISCOUNT_CARD_RATE=0.8`，`:27,99`）
  - **隊員** `isActiveTeamMember(member)` 且 `originalAmount>=100` → `×0.9`（`:22,96-100`）
  - 兩者疊加 → `×0.72`（`:74` 註、`:99→100` 依序套用）
- **`child_free` 例外**（`:93-95`）：在任何乘數前回原價、`isTeamDiscount:false, legacyDiscount:false` → **兒童永不打折**（涵蓋 phone + QR）。
- **VIP**：永不進此函式（早在 `:408-415` 免費短路）。
- 旗標來源：`isActiveTeamMember` 來自 `member.isTeamMember`+期間（`teamMemberService.js:65-70`）；phone 路徑 `opts.legacyDiscountCard` 受後端開關 `systemSettings/transitionSettings.checkinLegacyDiscountCard` 把關，**不單信前端**（`checkin.js:547-553`）。
- **`discount_card` 加購重算**（`createPendingCheckIn`，`:668-687`）：底價 = 所選 `baseEntryType`（student→250 / child→100 / else `single_general`）→`×0.8`→隊員 `×0.9`(若 base≥100)。**`bonus`=0**（`:689-693`）。

## 2.4 票券 / 定期票 / 卡片在入場中的狀態與條件

- **單次入場券**：`pending_approval`→`active`→`used`/`cancelled`（`passes.js:383,462,508,815`）。可用查詢：`status=='active'` 且 `expiresAt>=today` 且 `!validDate||validDate===today`（`checkinService.js:199-210`）。**擁有權**：QR 建立時票券 `memberId` 必須等於入場者，否則 `TICKET_NOT_OWNED`（`:646-648`），並檢查 `active`（`:641`）與到期（`:649-651`）；confirm 時重驗並設 `used`+`usedCheckInId`（`:805-815`）防兩個 QR 重用同券。
- **定期票**：`status=='active'`+補償後到期+scope+credits（`:111-126`）。
- **黑卡**：QR 建立時**只驗不扣**（`isActive`/`remainingCredits>0`/未過期，`:629-637`）；confirm 才 `useBlackCard` 扣（`:803-804`）。
- **紅利**：confirm 才 `useBonus`（`:816-818`）；入場金額強制 0（`:689-693`）。
- **孤兒防護**：扣點/扣券在**寫入 check-in 紀錄之前**；失敗即 throw、不建 `CHECK_INS` → 杜絕「入場但沒扣費」（`:789-818`）。黑卡與單次券刻意延到 confirm（`:627-628,790`）。

## 2.5 三條入場路徑對照

**路徑 A — 會員 QR 自助**（`/checkin/verify`→`/checkin/qr/create`→`/checkin/qr/scan`→`/checkin/qr/confirm`）
- 發起：會員（家長代子女需 `parentMemberId===req.member.id`，否則 403，`checkin.js:38-52,82-95`）。
- `/verify` 用登入 token（`:34-52`）→ 回 `verifyEntry`。
- `/qr/create`→`createPendingCheckIn`：重驗 waiver+墜測、驗票券/黑卡可用性與擁有權、後端重算金額、**不扣**（`checkinService.js:608-733`）；產 `qrToken`、30 分鐘效期（`:697`）。
- `/qr/scan`→`scanQrCode`：僅預覽不扣；錯誤 `QR_NOT_FOUND`/`QR_ALREADY_USED`/`QR_CANCELLED`/`QR_EXPIRED`（`:736-772`）。
- `/qr/confirm`→`confirmCheckIn`：狀態須 `pending` 否則 `QR_INVALID_STATUS`、重驗到期（`:783-784`）→ **扣點+建檔+記營收都在此**（`:789-880`）。

**路徑 B — 站台直接 `/checkin/direct`**（`checkin.js:243-275`）
- 發起：員工。自帶同日/同館重複檢查（`:255-262`）。內部串接 `createPendingCheckIn` 後**立即** `confirmCheckIn`（`:264-269`），無 QR 等待；`paymentMethod` 預設 `cash`。扣點/營收在 confirm。

**路徑 C — 站台電話 `/checkin/phone`**（`checkin.js:490-653`）
- 發起：員工搜尋會員；**直接建 check-in 文件**（不走 pending/confirm，`:601-622`）。
- **已付費放行**（`alreadyPaid`）：`entryType='already_paid'`、入場費 0；無加購→`paymentMethod='already_paid'`，有加購（鞋/粉袋）→用真實付款方式（`:542-543,590-594`）。
- **舊折扣卡 8 折**（`legacyDiscountCard`）：僅後端開關開啟時生效（`:547-553`）。
- **隊員 9 折**：`computePaidEntryAmount` 自動套（`:560-571`）。
- **不支援卡 / 券 / 黑卡**（此路徑純付費入場）。
- 營收：`totalAmount>0 && !deferPayment` 才記（`:627-642`）。

**營收與取消：**
- 所有路徑僅金額 > 0 才 `recordTransaction(type:'checkin')`（`checkinService.js:864-880`、`checkin.js:627-642`）；0 元入場不記營收。
- **取消視窗有兩套**：service `cancelCheckIn` **10 分鐘**（super_admin `force` 可越過，`checkinService.js:886-980`，視窗 `:905-906`）；route `/cancel-checkins/direct` 會員自助 **30 分鐘**（`CANCEL_WINDOW_MINUTES=30`，`cancelCheckin.js:16,66`）。兩者都會還原黑卡/紅利/單次券/折扣卡並記退款。

## 2.6 員工審核分支 — 單次入場券（`src/routes/passes.js`）

- **發放** `/passes/single-entry`（`:355-436`）：建 `pending_approval`、`approvalDeadline=now+24h`（`:371,383-384`）、發放即記營收（`:403-417`）、通知 gym_manager/super_admin（`:419-425`）。
- **核准** `/approve`（`:439-486`）：須 `pending_approval` 否則 `INVALID_STATUS`（`:450-452`）；超過 deadline → 自動 `cancelled` + `approval_timeout` 回 `APPROVAL_TIMEOUT`（`:455-458`）；否則 → `active`（`:461-467`）。只有 `active` 券可入場（`checkinService.js:200-206,641`）。
- **拒絕** `/reject`（`:489-529`）：須 `pending_approval`；設 `cancelled`+原因並記退款負向交易（`:507-528`）。
- ⚠️ **24h 逾時無排程**，只在事後嘗試核准時 lazy 判定（`:455`）；`pendingTasks.js:223` 與 `/single-entry/pending`（`:338-353`）只列清單。
- 一般入場**沒有站台核准步驟**；只有單次券發放需主管核准。

## 2.7 最終放行 / 拒絕條件

**拒絕**（`allowed:false`，依序，`checkinService.js:334,350,362,388`）：
`already_checked_in` → `waiver_required`/`parent_waiver_pending` → `fall_test_required`/`fall_test_expired`/`fall_test_consent_required`（除非持當日有效體驗券且已簽同意書）→ `installment_overdue`。phone 路徑以 `403` 硬擋相同關卡（`checkin.js:517,523,528,538`）。

**放行**（通過所有關卡後恆 `allowed:true`，`checkinService.js:411,422,433,479,506,516`）：
- `freeEntry:true`：VIP / 有效定期票 / course_access / 某設定 entry type 價 ≤ 0。
- 否則 `freeEntry:false, requiresPayment:true` 附 `entryTypeOptions` + `instruments`（`:516-593`）；實際完成在 `confirmCheckIn`/direct/phone（扣費+扣點+營收）。
- **`email_unverified` 永不擋入場**（只擋登入）。

## 2.8 ⚠️ 平行實作風險：`/checkin/eligibility`

`GET /checkin/eligibility/:memberId`（`checkin.js:167-239`）**不呼叫 `verifyEntry`**，而是 inline 重寫資格判斷，已出現分歧：
- VIP 另認 `member.memberType==='vip'`（`:181-182`）vs `verifyEntry` 只查 `VIP_MEMBERS`（`checkinService.js:188-196`）。
- 定期票 scope 用 `scope==='all'||p.gymId===gymId`（`:195-197`）vs `verifyEntry` 的 `scope==='shared'||targetGymId===gymId`+credits 檢查（`checkinService.js:124-125`）。
- 折扣卡率 inline 硬編 0.72/0.8（`:227`）而非走 `computePaidEntryAmount`。
→ **任何 entryTypes / 折扣 / scope 規則改動，兩處都要同步**，否則站台查詢與會員自助會不一致（`entry-eligibility-flow.md:134`）。

---

# 3. 會員端操作介面全功能

> 全在 `redrock-web/src/pages/member/` + `src/components/`。底部導覽：首頁 `/member/home`、課程總覽 `/member/courses`、我的票券 `/member/passes`、我的 `/member/profile`。

## 3.1 入場相關 — `MemberQRPage.jsx`

單一狀態機 `step`：`loading → blocked | select_entry → select_method → select_payment → shoes → qr`。

- **驗票** — `:61-84`：掛載與換入場人時打 **`POST /checkin/verify`** `{identifier: phone, gymId, targetMemberId}`（`:69`）→ 回 `allowed/freeEntry/entryType/entryTypeOptions/instruments/member.isTeamMember/reason`。
- **親子入場人員選擇器** — `:51-56` 載 **`GET /members/my/children`**；picker `:167-187`；換人重驗（`:59`），為選定者產 QR。
- **Blocked 畫面**（顯示+導轉按鈕）— `:221-272`：依 `already_checked_in`/`waiver_required`/`parent_waiver_pending`/`fall_test_required`/`fall_test_expired` 顯示不同訊息；按鈕：前往簽 Waiver→`/member/waiver`（`:249`，子女帶 `?forChild=`）、查看簽署狀態（`:254`）、前往墜測同意書→`/member/fall-test`（`:259`）、重新驗票（`:264`）。
- **第一段 選身分** — `:275-309`：渲染 `entryTypeOptions` 卡，顯示 VIP/定期票/課程學員/兒童/單次購票 + 付費金額（折扣時劃線價 `:294-301`）；隊員 badge「NT$100 以上享九折」當 `member.isTeamMember`（`:282-286`）。
- **第二段 選入場方式** — `:312-368`：由 `instruments` 建：一般付款、優惠折扣券(8折)、黑卡(免費)、紅利(免費)、單次入場券(免費)、購買優惠折扣券入場；顯示免費/價格與「共 N 張可用」。
- **選付款方式**（現金/Line Pay/街口/台灣Pay）— `:370-394`，僅需付費時顯示。
- **租借器材**（岩鞋 NT$100 / 粉袋 NT$50 / 都不需要）— `:396-453`。
- **產生入場 QR** — `handleGenerateQR` `:86-130`：**`POST /checkin/qr/create`** 帶完整 payload（memberId/gymId/entryType/baseEntryType/各票券 id/租借/付款/amount/originalAmount/isTeamDiscount，`:90-117`）→ `QRCode.toDataURL` 畫出（`:119`）。
- **票券出示畫面** — `:455-512`：QR 圖、入場人、身分・方式、入場費/岩鞋/粉袋/合計、付款方式、「剩餘約 N 分鐘」倒數（`:500`）、「請出示給工作人員掃描」（`:503`）、重新產生（`:505`）。
- 註：**掃描 `/checkin/qr/scan`、確認 `/checkin/qr/confirm`、取消 `/checkin/cancel` 都是員工端**；會員只呼叫 verify + qr/create 並出示。

## 3.2 Onboarding Gate — `MemberOnboardingGate.jsx`（包住 `MemberHomePage`）

- **狀態刷新** `:30-66`：**`GET /auth/member/me`**、`GET /fall-tests/signature/:id`、`GET /fall-tests/member/:id`、`GET /fall-test-bookings/my`、`GET /experience-bookings/my`；載場館 `:69`。
- **放行條件** `:75`：`!needsWaiver && consentSigned && (testPassed || hasExperience)`（持有效體驗券豁免排測 `:56-59`）。
- **兩大方框**（waiver + 墜測同意書）`:95-126`：風險安全聲明→`/member/waiver?onboarding=1`（`:117`）；墜測同意書→`/member/fall-test?onboarding=1`（`:119`）；家長未簽顯示等待（`:120-124`）。
- **`?onboarding=1`**：告訴簽署頁簽完導回 `/member/home`（即回 gate）而非 profile（`MemberWaiverPage.jsx:11,69`、`MemberFallTestPage.jsx:23,141`）。
- **排測選場館** `:154-176`：兩簽完後渲染場館卡（含今日營業/休館），`pick(gymId)`→ **`POST /fall-test-bookings`**（`src/api/fallTestBookings.js:5`）。
- **已送出確認** `:131-146`「測驗通過前暫不可入場」；有 booking 或 testPassed 後渲染子頁（`:149-151`）。

## 3.3 課程相關 — `MemberCoursesPage.jsx`（三分頁：總覽/我的課程/月曆，`:404`）

- **瀏覽課程** `:413-575`：**`GET /courses`**（`:157-162`）+館別 filter；場次 **`GET /courses/sessions`**（`:164-172`）；週課顯示插班比例+隊員九折（`:479-537`）、工作坊顯示額滿/候補（`:540-571`）。
- **報名 4 步 modal** `:927-1101`：付款資訊/健康備註+得知管道/規則確認/肖像授權簽名。
  - **報名對象（為誰報名）** `:951-967`：由 **`GET /members/my/children`**（`:149-155`）；本人或子女。
  - Submit `handleEnroll` `:198-271`：週課→**`POST /courses/:courseId/enroll-all`**（`:218`）；工作坊→**`POST /courses/sessions/:id/enroll`**（`:227`）；轉帳上傳 **`POST /transfers/upload`**（`:255`）；線上付款 `PaymentFlow`（`orderType:'course'`）`:378-386`；未滿 18 法代簽名 `:1043-1071`。
- **請假**（可操作）`handleLeave` `:332-344`→**`POST /courses/enrollments/:id/leave`** `{reason}`；UI `:868-919`，顯示可請假剩餘次數 `:795,813`。
- **補課**（可操作）：資格 **`GET /courses/makeup/member/:id`**（`:280-286`）；選場次 modal `:1103-1134`；`handleMakeup` `:315-330`→**`POST /courses/makeup/:id/use`** `{memberId,targetSessionId}`。
- **申請退費 / 暫停** `:817-828`，modal `:1136-1163`；退費→**`POST /course-adjustments/enrollments/:id/refund-request`**、暫停→**`.../pause-request`**（`src/api/courseAdjustments.js:8-13`）；`pendingAdjustCourseIds` 防重複。
- **我的課程 record** `:751-924`：已上課(出席/缺席/未點名)/已請假/未來場次。
- **月曆** `:577-748`：合併 sessions/experiences/competitions（載 `GET /courses/sessions`、`/experience-bookings/my`、`/competitions/registrations/member/:id`、`/courses/member/:id/enrollments`，`:114-119`）；**顯示型**。

### 體驗 / 試上 — `MemberExperiencePage.jsx`（首頁「體驗課程」磚進入）

- **體驗預約** `:246-381`：場館/課程類型(**`GET /experience-bookings/settings`**)/日期時間/參加者名單(保險用)/費用/付款；`handleSubmit` `:107-148`→**`POST /experience-bookings`**（轉帳 `POST /transfers/upload`）。
- **課程試上** `:383-413`：**`GET /courses/trial-sessions`** `{gymId}`（`:52-55`）顯示試上費/剩餘位；試上 modal `:186-227`。
  - **報名對象（試上）** `:198-207`：本人 / 子女（**`GET /members/my/children`** `:61`）；`submitTrial` `:67-95`→**`POST /experience-bookings`** `{trialSessionId,consentSigned,childMemberId?}`；免責同意 checkbox 必勾（`:217-220`）。
- **我的預約** `:415-436`：待確認/已確認/已取消（顯示型）。

## 3.4 票券 / 定期票 — `MemberPassesPage.jsx`

掛載載入（`:280-300`）：**`GET /passes/member/:id`**、`/cards/discount/member/:id`、`/cards/black/member/:id`、`/cards/legacy-discount/member/:id`、`/passes/single-entry/member/:id`、`/pass-adjustments/requests/member/:id`、`/cards/bonus/member/:id`。分頁：定期票/優惠卡/黑卡/單日券/紅利（`:398-404`）。

- **定期票狀態** `passStatus` `:336-342`：已取消 / 已過期(`endDate<today`) / 剩 N 天(≤7) / 有效；卡顯示剩餘次數、日期進度條（`:476-505`）。
- **展延/退費/轉讓申請** 按鈕 `:497-500`（`hasRequestForPass` 時隱藏，限一次）；modal `:608-685`；`handleSubmitRequest` `:362-396`→**`POST /pass-adjustments/requests`**（事由來自 `GET /pass-adjustments/reasons`，證明文件 `POST /pass-adjustments/evidence`，轉讓需手機號）。
- **優惠卡 / 黑卡** `:508-546`；**單日券** `:549-562`；**紅利** `:565-581`；點擊開 `TicketDetailModal`（`:188-247`，使用紀錄 `GET /checkin/history?ticketId=&ticketType=`）。
- **TransferModal（收件人/家庭成員選擇器）** `:29-185`：
  - 優惠卡/黑卡（點數卡）：**`GET /cards/transfers/lookup`** 查電話（`:51`）→ **`POST /cards/transfers/initiate`**（兩段式、24h 自動回退，`:90`）。
  - 紅利/單次券/體驗券（整張）：**`GET /ticket-transfers/recipients`**（家長/子女下拉，`:66,157-163`）選 `toMemberId` → **`POST /ticket-transfers/request`**（`:98`）。
- **待接收 / 移轉中 banner** `:435-466`：`GET /cards/transfers/incoming`/`/outgoing`；接收 `POST /cards/transfers/:id/accept`、取消 `.../cancel`。

## 3.5 顯示型 vs 可操作（會員端）

- **顯示型（不可操作）**：`MemberRecordsPage.jsx` 整頁唯讀；`MemberHomePage.jsx` banners/場館狀態/提醒/公告；`MemberCoursesPage` 月曆與出席子清單；`MemberQRPage` blocked/QR 出示畫面；`MemberFallTestPage` 副本檢視與測驗狀態卡（結果由員工設定，會員不能自標通過）。
- **可操作（會員發起寫入）**：產生入場 QR、驗票、Waiver 簽署/重發家長連結、墜測同意書簽署(含代簽子帳號)、排測預約、課程報名/請假/補課/退費/暫停、體驗/試上報名、票券移轉/接收/取消 + 定期票展延/退費/轉讓申請。

---

# 4. 員工端操作介面全功能

> 全在 `redrock-web/src/pages/staff/` 與 `src/components/review/`。審核 modal 由 `PendingTasksPage.jsx` 串接（**不是**直接從三個主頁）。

## 4.1 入場操作流程 — `CheckinPage.jsx`

**搜尋 / 解析會員**
- 掃描入場 QR + 「掃描」→ **`POST /checkin/qr/scan`**（`:413-425`，handler `:216-232`）。
- 「📱 手機號碼入場」查詢 → **`GET /members?q=phone`** 再對子女 `GET /members/:id`（`:523-526`，handler `:250-281`，家長優先 `:266`）。
- 選入場人員 chips（家長+子女）→ 各自 **`GET /checkin/eligibility/:memberId?gymId=`**（`:539-563`，call `:545`）。

**資格顯示（顯示型）** `:578-589`：`👑 VIP 免費`、`✓ 持有效定期票免費`、`📚 課程學員免費`。

**入場類型 chips（第一段）** `:592-611`：來自 **`GET /settings/entry-types`**（fallback `single_ticket/course_access/child_free/student_free`），依 memberType 濾 → `phoneEntryType`。

**使用票券列（第二段）** `:612-644`：一般付款；優惠券8折(＋隊員9折)`discount_card`；黑卡(免費)；紅利(免費)；單次入場券(免費)；**舊折扣卡8折**(＋隊員9折)—受 `checkinLegacyDiscount` 開關+無新優惠卡+basePrice>0+非 `child_free` 把關（`:623-627`，開關來自 `GET /settings/transition`）。

**租借 / 金額** `:648-710`：岩鞋(`GET /settings/shoe-rental`)、粉袋(`GET /settings/chalk-rental`)、付款方式(僅 `single_ticket` 時)、合計（前端試算，顯示型）。

**送出**
- 「✓ 確認入場」`handlePhoneCheckin`（`:718-722`，handler `:283-335`）：
  - 有 instrument 且 kind≠legacyDiscount → **`POST /checkin/direct`**（帶 `entryType=instrument.type`、`baseEntryType`、各卡券 id、付款、租借）。
  - 否則 → **`POST /checkin/phone`**（`entryType`=vip/pass/course_access 或 `phoneEntryType`、付款、租借、`legacyDiscountCard`=是否舊折扣卡）。
- 「💳 已付費入場」`handlePhoneAlreadyPaid`（受 `checkinAlreadyPaid` 開關+未封鎖，`:723-732`，handler `:339-356`）→ **`POST /checkin/phone`** `{alreadyPaid:true, 租借, 付款}`。
- 掃描流程「✓ 確認入場」`handleConfirm` → **`POST /checkin/qr/confirm`**（`:483-486`）。

**取消 / 匯出**
- 確認後「取消入場（10 分鐘內）」`handleCancel` → **`POST /checkin/cancel`**（`:505-508`）。
- 今日入場 tab「取消入場」→ `POST /checkin/cancel {force:false}`；「強制取消」(super_admin，>10 分或歷史) → `{force:true}`（`:831-887`）。
- 歷史入場「↓ 匯出 CSV」（前端 blob，`:862`；資料 `GET /checkin/history`）。
- **targetGymId** = `activeGymId||staff.gymId||(super_admin?viewGym||gyms[0].id:'')`（`:25`）。

## 4.2 快速入場 — `MembersPage.jsx`

- 「入場登記」開 Modal（`:810`，modal `:900-1000`）；選人後 **`GET /checkin/eligibility/:id`**（`:302`）+ `GET /settings/transition`（`:315`）。
- 資格顯示分支（VIP/定期票/課程免費、Waiver 未簽）`:903-919`（顯示型）。
- 入場類型 chips（`checkinEntryType`）`:922-931`；付款方式 chips（僅無 VIP/pass/course 時）`:934-945`。
- 「套用舊折扣卡8折」（＋隊員9折）checkbox `useLegacyDiscount`—受 `checkinLegacyDiscountCard` 開關+非 vip/pass/course+非 child_free（`:947-960`）。
- 「確認入場」`handleQuickCheckin` → **`POST /checkin/phone`** `{entryType, paymentMethod, legacyDiscountCard}`（`:970-973`，handler `:336-353`）。
- 「💳 已付費入場（入場費 NT$0）」`handleAlreadyPaidCheckin`（受 `checkinAlreadyPaid && waiverSigned && fallTestPassed!==false`）→ **`POST /checkin/phone`** `{alreadyPaid:true}`（此處無加購，`:976-980`，handler `:319-330`）。
- `targetGymId` = `activeGymId||staff.gymId||(super_admin?viewGym:undefined)`（`:179`）；未解析 → 「無法判斷操作館別，請確認登入狀態」（`:321,337`）。
- **今日課程學員快速入場在 CheckinPage**（`今日課程學員` tab）：**`GET /checkin/today-course-students?gymId=`**（`:54-64,760-800`），「點擊入場」→ **`POST /checkin/phone`** `{entryType:'course_access',paymentMethod:'cash'}`（`:66-84,774-798`）。

## 4.3 審核操作（由 `PendingTasksPage.jsx` 串接）

**單次入場券核准/拒絕 — `TicketApprovalModal.jsx`**
- 「核准」`approve()` → **`POST /passes/single-entry/:id/approve`**（`:65-68`，handler `:27-36`）；顯示會員/金額/付款/開立日/有效期限/館別/審核期限（`:47-53`）。
- 「拒絕」(ReasonModal，必填原因) → **`POST /passes/single-entry/:id/reject`** `{reason}`。
- 發放端（PassesPage）：「發放」→ **`POST /passes/single-entry`**，提示「發放後需館長/管理員 24 小時內審核」（`PassesPage.jsx:360-375,911`）。

**定期票申請審核 — `PassRequestReviewModal.jsx`**（展延/退費/轉讓/course_practice_deferral）
- 「核准」→ **`POST /pass-adjustments/requests/:id/approve`** `{extensionMonths,hasInvoice}`（退費須勾 `hasInvoice`，否則「退費需先確認會員已提供發票正本」，`:16-23`）。
- 「拒絕」(需 `rejectReason`) → **`.../reject`**（`:25-32`）；型別顯示：展延月數(max 6)、退費費用、轉讓 NT$300。

**墜測排測 完成/退回 — `FallTestBookingModal.jsx`**
- 載 Waiver `GET /members/:id/waiver`（`:89`）+ 同意書簽名 `getStaffFallTestSignature`（`:91`），可展開檢視內容（顯示）。
- 「✓ 通過」→ **`POST /fall-test-bookings/:id/complete`** `{result:'passed'}`（`:157`）。
- 「未通過」→ `mode='fail'` → 「確認未通過」`{result:'failed',notes:reason}`（`:155-156,178`）。
- 「↩ 退回申請」→ `mode='return'` → 「確認退回」→ **`POST /fall-test-bookings/:id/return`** `{reason}`（`:162-164,178`）。

## 4.4 異常處理（顯示給員工的分支 / 訊息）

**CheckinPage 前端分支（顯示型警告）**
- 「⚠ 此會員尚未簽署 Waiver，無法完成入場」`:568-572`（`!waiverSigned`），並停用送出、按鈕改「⚠ Waiver 未簽署，無法入場」`:712-721`。
- 墜測：「墜落測驗已到期，需重新測驗才能入場」(reason==='expired') vs「尚未通過安全墜落測驗，無法完成入場」`:573-577`；`blocked` 停用送出 `:714-721`。
- 掃描 `confirmError` 盒 `:472-476`；掃描錯誤盒「✕ {error}」= 後端 `err.response.data.message`（**票券無效/已過期/待審核/擁有權不符**等 verbatim，handler `:226`、渲染 `:491-495`）。
- 手機搜尋錯誤「✕ {phoneError}」= 後端訊息（資格不足/票券無效，`:331/:354`，渲染 `:529-533`）。
- `needsPromotion`/`promotionMessage` 入場後提示 banner `:746-750`。

**MembersPage 前端分支**
- 「無法判斷操作館別，請確認登入狀態」(targetGymId 未解析) `:321,337`。
- 「⚠ 此會員尚未簽署 Waiver，無法完成入場」`:903-906`。
- 通用「入場失敗」= `err.response?.data?.message`（`:330,352`）。

**PassesPage 狀態標籤（顯示型）**
- 定期票：已取消 / 已過期(`endDate<today`) / 剩 N 天 / 有效（`passStatus()` `:336-342`）。
- 單次券：待審核(pending_approval) / 有效 / 已使用 / 已過期 / 已取消（`ticketStatusLabel()` `:377-384`）；待審核明細「等待審核中，截止：{approvalDeadline}」`:820-822`。
- 註：票券無效/過期/待審核/擁有權不符/資格不足作為**硬擋原因由後端把關**，前端只 verbatim 顯示 `err.response.data.message`（這些檔案沒有專屬的「擁有權不符/資格不足」前端字串）。

## 4.5 員工端 UI 角色門檻

- `PendingTasksPage.jsx:88-101` `perm` map（決定動作按鈕是否渲染，否則顯示「需主管審核」`:173-174`）：
  - `isManager=super_admin||gym_manager`（`:78,89`）；`isOpStation=operator||station`（`:90`）。
  - `ticket_approval: isManager`（`:100`）；`pass_adjustment: isManager||isOpStation`（`:97`）；`competition_payment: isManager`（`:99`）；`course_adjustment/team_member: isManager||isOpStation`（`:96,98`）；`fall_test_pending: true`（全員，`:101`）；`rental/rental_return/experience/transfer_confirm: true`（`:92-95`）。
  - 館別 filter 下拉僅 `isAdmin`（`:232-238`）；「我的近 7 日班表」僅 `isRealStaff = staff.id && !operator && !station`（`:117,260`）。
- `PassesPage.jsx`：`canManageTypes=['super_admin','gym_manager'].includes(role)`（`:63`）→ 票種新增/編輯（`:507,526`）；`canManagePass` gate 年假展延 tab（`:398`）。
- CheckinPage 強制取消按鈕受 `isSuperAdmin`（`:837,882`）；今日統計個人帳號登入顯示「個人帳號登入無法查看今日統計…」（`:901-904`）。

---

# 附錄 A：票券 / 定期票 / 卡片 / 紅利狀態機

## A.1 定期票（`memberPasses`）

- **票種 `passTypes`**（`src/routes/passes.js:83-99`）：`scope('single'|'shared')`、`price`、`durationDays`、`durationMonths`、`credits`、`installment{enabled,periods[]}`、`isActive`。`durationMonths` 優先於 `durationDays`（`computePassEndDate` `:15-21`，月底夾如 1/31+1mo→2/28）；建立時二擇一（`:75-77`）。⚠️ `scope:'all'` 只在 `passExpiryService.js:55` 讀側被當 shared 同義，**從不被寫入**。
- **實例 status**：只有 `active` / `cancelled`。建立 `active`（`:206`，另有 `paymentStatus:'pending'|'confirmed'` `:207`）；`DELETE` → `cancelled`（`:307-308`）；`PUT` renew 強制 `active`（`:272`）。
- **effectiveEndDate 補償**（`src/services/passExpiryService.js`）：存檔 `endDate` 不動，動態算 `effectiveEndDate` 回傳為 `endDate`、原值留 `baseEndDate`（`passes.js:173-176`）。可補償日=`gymAnnouncements type='closure'`（臨時休館）；每週固定公休不補（`:45-51,53-71`）。單館票看自館、全館票需「無任一館 open 且至少一館 closed」；迭代至穩定，上限 365 天（`:20,87-92`）。
- **續約**（`PUT /:id` `renew:true`+`passTypeId`）：基準=未過期則現 `endDate` 否則今日 → `computePassEndDate`；有 credits 則重置（`:262-293`）。

## A.2 單次入場券（`singleEntryTickets`）

schema `status:'active|used|expired|cancelled'`（`schema.js:243`），執行期另加 `pending_approval`。

- 發放 `pending_approval`+`approvalDeadline=now+24h`+`expiresAt=now+1yr`（`passes.js:383,371,370`），發放即記營收（`:403-417`）。
- `pending_approval → active`（`/approve` `:461-467`，過期則轉 `cancelled`+`approval_timeout` `:455-457`）。
- `pending_approval → cancelled`（`/reject`，退款負向交易 `:507-530`）。
- `active → used`（入場 confirm `checkinService.js:815`，寫 `usedAt/usedCheckInId`）。
- `used → active`（取消入場還原 `checkinService.js:920-921`、`cancelCheckin.js:28`）。
- ⚠️ **`expired` 於 schema 定義但從不被賦值**；到期只靠查詢 `expiresAt>=today` 過濾（`checkinService.js:205`），過期票仍留 `active`。
- ⚠️ **24h 審核逾時無排程**，只在事後嘗試核准時 lazy 判定（`passes.js:455-457`）。
- 擁有權欄位：`memberId`(現持有)/`originalMemberId`(原購)/`bookedByMemberId`(體驗預約端)。
- 轉移：staff `/transfer`(須 `active`)或兩方 ticket-transfers（見 A.5）。
- 體驗子型（`ticketType:'experience'`）：綁 `validDate` 當日可用（`checkinService.js:207-209`）；作廢只 `active→cancelled`（`experienceBookings.js:455,470-471`）。

## A.3 卡片（四種，各自 collection，狀態用 `remainingCredits`+`isActive` 布林）

- **新優惠卡 `discountCards`**（`discountCardService.js`）：`CARD_CREDITS=10`、`VALIDITY_MONTHS=12`；綁卡上限 10 格（route `min:1,max:10` `cards.js:41`）；用一格 `isActive=newCredits>0`；轉移不可超過 `remainingCredits`；紅利歸屬 `originalOwnerMemberId`。
- **舊優惠卡 `legacyDiscountCards`**：原卡 `expiresAt:null`；**首次移轉才設 +12mo，之後繼承**（`:171-173`，route 需 `confirmedExpiry` `cards.js:120`）。
- **黑卡 `legacyBlackCards`**：`BLACK_CARD_CREDITS=12`；原卡無到期；綁定重複條碼 → `CARD_ALREADY_BOUND` 409（`legacyCardService.js:28-31`）；首移轉 +1yr 後繼承；取消入場 `refundBlackCard` 補回 1 格。
- **不觸發紅利**：黑卡沒有 `totalIssuedCredits`/`bonusTriggered`，不呼叫 `triggerBonus`。三張「點數卡」在根卡 `totalUsedCredits>=totalIssuedCredits` 才觸發紅利。
- 兩段式員工移轉走 `cardTransferService`（見 A.5）。

## A.4 紅利（`discountBonuses`，`bonusService.js`）

- **獲得**：折扣卡根卡用畢觸發，`validityMonths=6`，歸屬 `originalOwnerMemberId`，`bonusTriggered` 防重複（`discountCardService.js:141-149`、`legacyDiscountCardService.js:93-101`）。
- **使用**：`useBonus` 須 `isActive && !isUsed` 未過期 → `isUsed:true,isActive:false`（`bonusService.js:70-83`）。
- **取消還原**：入場取消回復 `isUsed:false,isActive:true`（`checkinService.js:917`、`cancelCheckin.js:38`）。
- **移轉**：整張、繼承到期（`:87-132`，route 需 `confirmedExpiry`）。
- **每日到期清理**：`sweepExpiredBonuses` 標 `isActive:false,expiredAt`（軟刪留稽核，`:161-183`），每日 9am 排程（`src/index.js:143`）。
- ⚠️ **collection 名稱不一致**：ticket-transfers 的 `bonus` 對映 `'bonusCards'`（`ticketTransfers.js:79-80,137`），而 bonusService 用 `'discountBonuses'`（`bonusService.js:15`）→ 轉移紅利會操作到 bonusService 從不寫入的 collection。

## A.5 票券移轉兩套流程

- **`ticketTransfers`**（`src/routes/ticketTransfers.js`）：`pending → accepted|rejected`。5 型別 `discount_card/legacy_discount_card/black_card/bonus/single_entry`。收件解析：有 `toMemberId` 驗電話同家（`PHONE_MISMATCH`），否則 `getMemberByPhone`(家長優先)；家長可代子女 accept/reject（`actorCanActFor` `:38-44`）；`/recipients?phone=` 回家長+子女清單。⚠️ **建立時 `expiresAt=now+24h` 但無任何 handler/排程執行到期** → 未回應請求無限 pending。
- **`cardTransfers`**（`src/services/cardTransferService.js`，僅 discount/black 兩段式）：`pending → completed|cancelled|expired`。發起**即扣來源點數**、`expiresAt=now+24h`；`revertExpired` 每小時排程回補點數+`expired`（`src/index.js:148-152`），列 incoming 時亦 lazy 回退。

---

# 附錄 B：課程 / 體驗 / 試上 / 排測 / 代班

collections：`courses/courseSessions/courseEnrollments/courseAttendance/courseMakeupRights/courseAdjustmentRequests/experienceBookings/singleEntryTickets/fallTestBookings/fallTests/fallTestSignatures`。

## B.1 課程報名 / 名額 / 計費

- 單場報名 `POST /courses/sessions/:id/enroll`（`courses.js:134-244`）：擁有權檢查、擋 `isBlocked`/取消場次/重複；**名額** `enrolledCount>=maxStudents`→`waitlist` 否則 `confirmed`（`courseService.js:442,472`）。
- **插班計費** `calcEnrollmentFee`（`:405-417`）：`ratio=remaining/total`，`ratio>=0.5` 乘 1.0 否則 `midpointSurcharge`(1.05)；`remaining>4` 自動兩期分期。
- 整期報名 `POST /courses/:courseId/enroll-all`（`:638-792`）：後端權威費用=晚報比例+未過半加價+隊員 9 折（`applyTeamDiscount` `:677-700`）；末場認列營收。
- 取消：軟刪（課/場/報名連鎖），`cancelCourseEnrollments` 釋放名額並遞補候補（`:628-657`）。

## B.2 請假 / 補課 / 退費 / 暫停

- **請假** `POST /courses/enrollments/:id/leave`（`courseService.js:519-593`）：須 `confirmed`、須早於 `leaveDeadlineHours`(2)；上限 `maxLeavesAllowed ?? course.maxLeaves ?? 2`；→ `status:'leave'`、釋放名額、自動生補課權、遞補候補。
- **補課**：請假時自動建 `courseMakeupRights`（`status:'available'`，`expiresAt=leaveDate+makeupDeadlineDays(60)`）；`POST /courses/makeup/:id/use`（`:660-728`）須 available/未過期/目標場未滿/**同 categoryId**/**同 gym** → 建 `isMakeup:true` 報名，權利轉 `used`。
- **退費**（`courseAdjustments.js`）：開課前=paid−5% 手續費；開課後=已上堂數 × `perSessionDeduction`(850)；建 `refund` 請求 `pending`，核准 `finalRefund` clamp `[0,paid]` 並記負向交易。
- **暫停**：`pause` 請求，核准設未來 confirmed 報名 `pauseStatus:'paused'`；`restore` 清除。
- **預計上課公式**（`getSessions` `:844-879`）：`registeredCount=regular+leave`（報名，含請假）；`expectedCount=regular+makeup+trial`（**原報名 − 請假 + 補課 + 試上**）。

## B.3 試上（trial）

- 課程旗標 `allowTrial`/`trialPrice`（`courseService.js:69-70`）；`GET /courses/trial-sessions` 只回 `allowTrial===true`、未滿（試上佔名額）。
- `POST /experience-bookings` trial 分支（`experienceBookings.js:32-80`）：須登入、`allowTrial`、未滿、`consentSigned`；**家長代子女**驗 `child.parentMemberId===memberId`，booking/名單/券綁子女+`bookedByMemberId`=家長；`trialFee=course.trialPrice`（後端權威）。
- confirm → `enrollTrial`（`courseService.js:884-914`）：`isTrial:true`、`paymentStatus:'paid'`、佔名額、只計入 `expectedCount`。發單日券、入場不卡墜測。⚠️ **只有試上報名流程會產生 `isTrial`，無「員工手動加試上」UI**。

## B.4 體驗預約

- 建立 `POST /experience-bookings`（`:82-119`）：後端權威費用（`systemSettings/experienceCourses` 依人數分級）；`status:'pending'`。⚠️ 檔頭硬編 `COURSE_TYPES`（`:13-18`）已被 settings 取代、僅殘留於部分回應/下載標籤。
- 確認 `POST /:id/confirm`（`:310-388`）：`confirmed`；帶 `coachName` → 自動建 course(`type:'workshop'`,`source:'experience'`)+session+教練排班（`scheduleService.createShift`）；改教練刪舊班建新班；同教練 idempotent。
- 取消 `POST /:id/cancel`：`cancelled`、作廢 `active` 票券、清理場次/課/班；試上另 `removeTrialEnrollment`。
- 保險名冊 XLS（依 15 歲分成人/兒童）、一鍵寄信；狀態 `pending|confirmed|cancelled`。

## B.5 墜落測驗排測（`fallTestBookings`）

- 狀態 `pending|passed|failed|cancelled`（`:90`）+ `returned`（`:163`）。
- 前置 `checkPrereq`（`:29-40`）：waiver `isComplete` + 一筆 `fallTestSignatures`。
- `POST /`（`:43-102`）：場館必填、本人/子女（驗擁有權）、已通過擋 `ALREADY_PASSED`、擋重複 pending。
- `GET /my`、`DELETE /:id`(只 pending)、`POST /:id/return`(→`returned` 需重新申請)、`POST /:id/complete`(`result:passed|failed`)。
- **passed 刷新封鎖**：`recordFallTestResult`（`fallTestService.js:30-77`）：passed 須 `fallTestSignatures`；寫 `fallTests`(`expiresAt=now+validYears`,預設 1yr)；更新 `member.fallTestPassed:true` 並 `refreshBlockStatus`。
- 站台待辦：pending → `pendingTasks.js:241-259` `type:'fall_test_pending'`（依 gym）。

## B.6 代班教練

- 設定/更改 `PUT /courses/sessions/:id/substitute`（`courseService.js:936-973`）：覆寫 `session.instructor`、記 `isSubstitute/originalInstructor`；通知代班本人 + gym_manager。
- 取消 `DELETE .../substitute`（`:976-1001`）：還原 `originalInstructor`，通知 gym_manager。
- 月曆兩端以 `session.instructor` 優先顯示（`:871`）。

---

# 附錄 C：跨檔案風險清單

> 以下皆為**現狀事實**（非建議修改），供維護時注意；如需處理請另行確認。
> 🔄 **部分項目已於 2026-07-06 入場關卡收斂（後端 1.49→1.57）處理**，下方以 ✅ 標註；入場資格/關卡收斂詳見 `docs/entry-eligibility-flow.md`（§2 `runEntryGates`、§6 已修復、§7 尚未修復/設計取捨）。

1. **`email_unverified` 不擋入場**，只擋登入（`memberService.js:30-33` vs `auth.js:209`）；入場 4 個路徑都不讀 `isBlocked/blockReasons`。
2. **✅ 大幅收斂（原「`/checkin/eligibility` 平行複製、三處分歧」）**：eligibility 底層查詢已改與 `verifyEntry` 共用同一份權威函式（`checkWaiver`/`checkVip`/`getValidPasses`/`checkFallTest`/`getValidSingleEntryTickets`，`checkin.js:170-227`）→ VIP/pass scope/折扣率/單次券**資料已一致**、原漂移消除。**唯一保留**：eligibility 仍是「全部攤開」投影層，回傳**不含** `entryTypeOptions`/`buyPass`/`buyDiscountCard`/免費短路（刻意，非全等；風險低暫不補，見 `entry-eligibility-flow.md` §7）。
3. **兩套取消視窗**：service `cancelCheckIn` 10 分鐘 vs route `/cancel-checkins/direct` 30 分鐘。
4. **`singleEntryTickets` 的 `expired`** schema 有、程式從不賦值（靠查詢過濾）。
5. **單次券 24h 審核逾時無排程**，只 lazy 判定（`passes.js:455`）。
6. **`ticketTransfers.expiresAt`(24h) 無任何執行到期的程式**（對比 `cardTransfers` 有每小時 sweep）。
7. **紅利 collection 名稱不一致**：`ticketTransfers` 用 `'bonusCards'` vs `bonusService` 用 `'discountBonuses'`（§A.4）。
8. **隊員身分雙機制**：`memberType==='climbing_team'`（`checkinService.js:55`，有一段 no-op `:440-443`）與 `isTeamMember` 旗標獨立；實際 9 折只看旗標。
9. **schema/程式列舉不一致**：墜測 `result` schema 註 `pass|fail`、程式用 `passed|failed`（`schema.js:105` vs `fallTestService.js`）；`memberType` schema enum 無 `climbing_team`；`registeredBy` enum 有 `migration` 但 `createMember` 只寫 `staff|self`。
10. **✅ 已修復（原「phone 路徑無『當日體驗券』墜測例外」）**：`/checkin/phone` 現與 QR 路徑共用 `runEntryGates`（`checkin.js:496`，`expTicketMode='owns'`），持當日有效體驗券者未過墜測也可入場（須先簽同意書，否則 `fall_test_consent_required`）。三路徑墜測例外一致（後端 1.51、`5eddf9b`）。
11. **課程分期兩套**：`calcEnrollmentFee` 內建兩期 vs `installmentService` 計畫流程；enroll-all 用後端權威隊員折扣計算（`courseService.js:405-417` vs `courses.js:677-757`）。
12. **`promoteWaitlist` 有 TODO**：候補遞補不寄信（`courseService.js:622`）。
13. **「測試VIP」不是程式屬性**，僅 seed/測試資料註解字樣。
