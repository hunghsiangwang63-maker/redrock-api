# 課程 / 體驗 — 教練排班・試上・代班 功能說明

> 本輪（2026-07）新增與修正的功能總覽。前端在 `redrock-web`，後端在 `redrock-api`。
> 金額 / 名額一律**後端權威計算**，不信任前端傳值。

## 目錄
1. [體驗預約 → 指定/改教練 → 自動排課排班](#1-體驗預約--指定改教練)
2. [員工本人待辦頁：近七日班表](#2-員工本人待辦頁近七日班表)
3. [課程月曆：教練 + 報名/預計上課；會員端隱藏人數](#3-課程月曆)
4. [排班表編輯可更改員工（bug 修正）](#4-排班表編輯可更改員工)
5. [週課「開放試上」→ 會員試上報名](#5-週課開放試上)
6. [課程場次「代班教練」](#6-課程場次代班教練)

---

## 1. 體驗預約 → 指定/改教練

確認體驗預約時可指定教練，系統自動把該體驗建成「課程 + 場次 + 教練當日排班」，並在兩端月曆呈現。

- **端點**：`POST /experience-bookings/:id/confirm`，body 可帶 `{ coachId, coachName }`
  - 未排課 + 指定教練 → 建立 course(`source:'experience'`) + session + 教練 shift
  - 已排課 + 換教練 → 同步既有 course/session + **刪舊班→建新班**（三邊一致，不重複建課）
  - 同一教練重複確認 → 冪等；未帶教練 → 不覆寫教練欄位（避免 desync）
- **取消**：`POST /experience-bookings/:id/cancel` → 取消 course/session、刪教練 shift、作廢未用票券
- **前端**：`components/CoachSelect.jsx`（館內員工清單 + 自訂輸入）、確認彈窗 `ExperienceDetailModal`、`ExperienceBookingsPage`（已確認卡片可「指定/改教練」「取消預約」）
- **檔案**：`routes/experienceBookings.js`、`services/scheduleService.js`（`deleteShift` 用於換班）

## 2. 員工本人待辦頁：近七日班表

員工本人登入（非場館電腦/站台帳號）時，待辦頁頂端顯示自己未來 7 天排班（日期・時間・備註）。

- **端點**：`GET /schedule/my-upcoming?from=YYYY-MM-DD&to=YYYY-MM-DD`（`authenticate` 即可，只回登入員工自己的班；站台/值班帳號→空）
  - 前端傳 from/to（用使用者本地時區計算，避開伺服器時區）
- **前端**：`PendingTasksPage.jsx`，僅在 `staff && !operator && !station` 顯示
- **檔案**：`routes/schedule.js`、`services/scheduleService.js`（`getUpcomingShiftsForStaff`）

## 3. 課程月曆

- **員工端**（`CoursesPage.jsx` 月曆）：場次卡顯示 **課程名稱 · 👟教練 · 報名 X · 預計上課 Y**（＋請假/補課/試上標籤）
  - **報名人數** = 週課原報名（含請假者）＝ `registeredCount`
  - **預計上課人數** = 原報名 − 請假 + 補課 + 試上 ＝ `expectedCount`
  - 教練存在「課程」層級；`getSessions` 會帶出（場次有 `instructor` 則優先，見代班）
- **會員端**（`MemberCoursesPage.jsx`）：課程月曆 / 課程總覽 / 補課場次**全部隱藏人數**，僅保留「額滿」狀態
- **檔案**：`services/courseService.js`（`getSessions` 統計 registeredCount/expectedCount/trialCount + 帶 instructor）

## 4. 排班表編輯可更改員工

**Bug 修正**：排班表點入場次改員工原本無效——後端 `updateShift` 漏了 `staffId/staffName`。

- **修正**：`services/scheduleService.js` `updateShift` 現接受並更新 `staffId/staffName`；整天班重複檢查改用新的 staffId
- 其餘欄位（日期/類型/時間/備註）本來就正常

## 5. 週課「開放試上」

週課可開放單堂「試上」，會員在「體驗課程」頁報名，流程比照體驗預約。

### 設定（員工）
- 課程表單（`CoursesPage.jsx`，僅週課）：「**開放試上**」勾選 + 「**試上費用**」
- 課程欄位：`allowTrial`(bool)、`trialPrice`(number)（`createCourse` + `PUT /courses/:id` 白名單）

### 會員報名
- **可試上場次**：`GET /courses/trial-sessions?gymId=` → 開放試上且**未額滿**的近期場次（含試上費/剩餘名額/教練）
  - 額滿（含補課佔滿）**自動排除**（試上佔名額）
- **報名**：`POST /experience-bookings`，body 帶 `{ trialSessionId, consentSigned, paymentMethod, paymentDate, bankLastFive }`
  - 費用 = `course.trialPrice`（**後端權威**）；`needsInsurance:false`（試上免保險）；需勾選免責同意
  - 會員端 `MemberExperiencePage.jsx`「課程試上」分頁 + 試上報名 modal
- **確認**：`POST /experience-bookings/:id/confirm`（kind=trial 分支）→ 呼叫 `enrollTrial` 把會員加入該場次名單（`isTrial:true`、**佔名額**、滿則候補），**不建課/排班**
  - 發單日體驗入場券沿用既有「發放入場券」流程；入場**不卡墜落測驗完成**（試上券＝體驗券）
- **取消**：`removeTrialEnrollment` 移除名單並釋放名額
- **人數影響**：試上者計入 `expectedCount`（預計上課），不計入 `registeredCount`（報名）
- **檔案**：`services/courseService.js`（`getTrialSessions`/`enrollTrial`/`removeTrialEnrollment`）、`routes/courses.js`、`routes/experienceBookings.js`

> ⚠️ **試上（試上人數）目前無獨立記錄機制**：`expectedCount` 公式含「+試上」，但系統以 `isTrial` 旗標計算，唯有透過上述試上報名流程才會產生 `isTrial` 名單。手動「把某人標為試上」尚無 UI。

## 6. 課程場次「代班教練」

教練請假找人代班：對**單一場次**指定代班教練，覆寫該堂教練，兩端月曆自動更新並發待辦提醒。

### 設定位置
員工端 → 課程活動 → 課程 → **月曆** → 點日期 → 場次卡：
- 無代班：「👟 設定代班」
- 有代班：「取消代班」＋「👟 更改代班」
（亦可從「場次管理」編輯場次講師，但用月曆的「設定代班」才會記錄原教練 + 發提醒）

### 端點
- **設定/更改**：`PUT /courses/sessions/:sessionId/substitute` body `{ coachId, coachName, reason }`
  - 覆寫 `session.instructor`、記錄 `originalInstructor`、`isSubstitute:true`
- **取消**：`DELETE /courses/sessions/:sessionId/substitute` → 還原原教練、清代班標記
- **待辦提醒**：`notifyRoleInGym`（館管理員）+ 直接通知代班教練本人（`type:'course_substitute'` / `course_substitute_cancel'`），出現在待辦頁「🔔 通知」

### 顯示（兩端月曆自動同步）
- `getSessions` 優先用 `session.instructor` → 員工/會員課程月曆同步顯示代班教練
- 員工月曆：橘標「代班（原 XX）」；會員月曆：「👟 教練（代班）」
- **檔案**：`services/courseService.js`（`setSessionSubstitute`/`clearSessionSubstitute`）、`routes/courses.js`、`CoursesPage.jsx`、`MemberCoursesPage.jsx`

---

## 驗證狀態（2026-07）
- 體驗指定/改教練/取消清理：✅ 實機驗證（含排班表對照）
- 待辦近七日班表：✅ 端點 200 + 卡片渲染（有資料畫面待員工帳號登入）
- 課程月曆教練+人數：✅ 實機驗證（報名/預計上課/試上標籤）
- 排班改員工 + 其餘欄位：✅ 實機驗證
- 週課試上：✅ 後端全流程 API 驗證（報名→確認→佔名額→預計上課→取消釋放）；會員端 UI 已部署（畫面待會員帳號登入）
- 場次代班：✅ 設定/更改/取消 + 待辦通知送達 + 員工月曆顯示皆驗證（會員端顯示已部署待點測）
