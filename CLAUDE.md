# RedRock 紅石攀岩館 — 系統說明

> 本檔已可安全提交（無機密）。測試帳號 / 金鑰等敏感資料見 `CLAUDE.local.md`（git-ignored）。
> 接手 / 維護這份 context 的方式見 `docs/maintaining-context.md`。
> 入場資格與金額的後端權威判斷（前置關卡 / 免費資格 / 付費二段式 / 折扣疊加 / 三條路徑）見 `docs/entry-eligibility-flow.md`。

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

## 目前進度（2026-07-04）— 新會員入場前置流程（墜落測驗自助排測）
> 前後端一起做、各自 repo 分開 commit、E2E 打 Railway 驗證通過。
- ✅ **墜落測驗自助排測 + 站台待辦**：email 認證 → 簽 waiver + 墜測同意書 → 自助「安排墜落測驗」選場館 → 進該館站台電腦待辦 → 站台員工現場測驗按通過/未通過。
  - 新集合 `fallTestBookings`（`memberId`/`memberName`/`gymId`/`status`(pending|passed|failed|returned|cancelled)/`completedBy`/`fallTestId`…）
  - 新路由 `/fall-test-bookings`：`POST /`（本人/子女、驗 waiver+同意書前置、擋重複 pending、驗場館）、`GET /my`、`DELETE /:id`、`POST /:id/complete`（站台/值班登記結果）、`POST /:id/return`（**退回申請** → 會員需重新申請）
  - 抽 `src/services/fallTestService.recordFallTestResult` 共用給 `POST /fall-tests` 與排測完成端點；passed 改呼叫 `refreshBlockStatus` 正確重算（保留 waiver 等關卡）
  - `pendingTasks` 加 `fall_test_pending` 來源（依 `gymId`）
  - **入場擋到通過為止**沿用既有 `fall_test_required`；持當日體驗券者豁免沿用 `1.7.1`
  - `/health` `1.34.0-falltest-booking-return`
- ✅ **修 waiver 簽名 Storage 依賴（瀏覽器實測發現）**：`waiverService.uploadSignature` 原硬上傳 Firebase Storage，但正式環境 Storage 取 token 失敗（oauth2 token 錯誤）→ 簽署整個 throw 且發生在寫入 waiver 前 → **完全沒建 waiver 記錄，新會員卡死在入場前置第一步**。比照會員 QR 去 Storage，簽名改直接內嵌 base64 存 Firestore（`signedRead` 對 `data:` 原樣放行；舊 Storage 路徑仍正常簽名）；一併修好家長 / 競賽 waiver（共用 `uploadSignature`）。`/health` `1.35.0-waiver-signature-base64`。**瀏覽器 E2E 全流程實測通過**：新會員 → 兩大方框 gate → 選場館 → 送出回正常首頁 → 站台待辦出現該筆

## 目前進度（2026-07-04 續）— onboarding gate 跳轉修正（純前端 `redrock-web`）
> 兩方框 gate（`MemberOnboardingGate.jsx`）只包在 `MemberHomePage`；問題是簽署頁簽完後導去「內容頁」而非跳回 gate。前端改 + build/deploy + commit/push，**瀏覽器 E2E 全流程實測通過**。
- ✅ **簽完 waiver / 墜測同意書跳回兩方框 gate**：gate 導去簽署頁時帶 `?onboarding=1`（`/member/waiver`、`/member/fall-test`）；`MemberWaiverPage` / `MemberFallTestPage` 讀此參數，簽完改 `navigate('/member/home')`（否則維持原本回 profile / 停原頁，非 onboarding 情境不受影響）→ 不論先簽哪個都跳回 gate（已簽變 ✓），兩者皆簽完自動進「安排墜落測驗（選場館）」並卡到送出申請
- ✅ **排測確認畫面補場館名**：`pick()` 內 `setJustBooked(true)` 早於 `await refresh()`，此時 `state.booking` 仍 null → 館名空白；改 pick 時記 `bookedGymId`，確認畫面用 `gymName(booking?.gymId || bookedGymId)`
- 實測：API 建 `【練習】Gate測試`(0900123457) → 登入 → 兩方框 → 簽 waiver（跳回 gate、box ✓）→ 簽墜測（跳回 gate 進選場館）→ 選新竹館送出 → 確認畫面 → 回正常首頁；測後已清理（取消排測 + `DELETE /members/:id`）。**註**：墜測「觀看影片 90%」關無法瀏覽器自動化，該步同意書改用 `POST /fall-tests/sign` API 完成；導向邏輯與 waiver 同段程式、已由 waiver 路徑端到端證明
- commit（redrock-web）：`e8e5598` 跳轉修正、`a346ed8` 補館名

## 目前進度（2026-07-04 六）— Email 未驗證擋登入 + 站台隊員 9 折
> 兩個回報問題排查 → 修復 → 前後端各自 commit/deploy → 正式環境 API E2E 實測通過。後端 `/health` `1.36.0-email-verify-login-gate-team-discount`。
- ✅ **Email 未驗證擋登入（源頭一卡，後面連鎖問題消失）**：回報「用舊 Email 註冊、沒點驗證信就能登入」。追查發現 `email_unverified` 這個 blockReason **後端各入場關卡（`verifyEntry` / `createPendingCheckIn` / `/checkin/phone`）實際都沒在讀**，唯一真實漏洞是**登入不檢查驗證**（`auth.js` 密碼對就發 token）。
  - 定調：**Email 可共用**（親子本就共用；一般帳號也允許），**但註冊一定要卡認證**。
  - 登入 gate（`auth.js` member/login，密碼驗證後、發 token 前）：`registeredBy==='self' && !emailVerified` → `403 EMAIL_NOT_VERIFIED`（帶 `needsEmailVerification`/`email`），不發 token。**店員建立 `emailVerified:true`、遷移帳號 `registeredBy:'migration'` 皆不受影響**。
  - 新增 `POST /auth/member/resend-verification`（帶 identifier+密碼防對外濫發）→ 重寄驗證信（`sendEmailVerification` 每次換新 token）；已驗證回 `alreadyVerified`。
  - **重寄可帶選填 `newEmail` 順便更正當初打錯的信箱**（共用已允許，故不做唯一性檢查）→ 更新會員 email 後改寄新地址、回 `emailUpdated`。
  - 前端（`redrock-web`）：`MemberLoginPage` 收 403 → 切「請先完成 Email 驗證」面板（顯示寄達 Email、「重寄驗證信」、「Email 打錯了？點此更正」展開改信、「返回登入」）；`memberAuth.js` 加 `resendMemberVerification()`。註冊頁「驗證完成後即可登入」文案本就對上，不用改。
- ✅ **站台電話搜尋入場漏帶隊員 9 折**（會員自助 QR 有折、站台沒折）：站台「純付費入場（沒選卡/券工具）」走 `/checkin/phone`，該 handler **從不查隊員身分**直接寫原價；QR 路徑走 `createPendingCheckIn` 才有折。
  - 抽出唯一權威 `checkinService.computePaidEntryAmount(entryType, member)`（依 entryTypes 算價 + 有效隊員 `×0.9`，找不到付費類型回 null 由呼叫端 fallback）。
  - `createPendingCheckIn`（QR）與 `/checkin/phone`（站台）**共用同一份折扣邏輯**；站台純入場現正確套 9 折並寫 `isTeamDiscount`/`entryOriginalFee`，`recordTransaction` 吃折後金額（不再高報營收）。
- **實測（打 Railway 正式 API，練習帳號 `0900333399` 測後已 `DELETE`）**：註冊 201 → 未驗證登入 **403 `EMAIL_NOT_VERIFIED`** → 重寄錯密碼 401 / 對密碼 200 / 帶 newEmail 200 `emailUpdated`。前端面板本機 dev 截圖確認三態。站台 9 折邏輯已上線（後續已用真站台帳號 `/stations/login` 驗證帳號有效，見 2026-07-04 六段落）。
- commit：後端 `redrock-api` `1d37fab`；前端 `redrock-web` `7c0b8e7`
- ⚠️ **注意**：既有 `registeredBy:'self'` 且 `emailVerified:false` 的真實會員，上線後下次登入會被要求先驗證（可自助重寄）；遷移 / 員工建立帳號不受影響。
- ✅ **Email 認證總開關（super_admin，比照裝置綁定）**：後端 `auth.js` 加 `isEmailVerificationEnabled()`（`systemSettings/security.emailVerificationEnabled`，預設 true、讀取失敗回 true 安全預設），登入 gate 改「未驗證 && 開關開啟」才擋；`settings.js` `GET/PUT /settings/email-verification`（PUT 僅 super_admin）與 device-binding 對稱。前端員工設定頁「員工帳號」分頁裝置綁定卡片下方加「✉️ Email 認證」toggle。**關掉即可讓資料移轉/測試期免驗證登入，開回恢復強制**。`/health` `1.37.0-email-verify-toggle`；commit 後端 `b20e5cc`、前端 `8c0fdd2`。正式 API 8 步 E2E（讀狀態→ON 擋→OFF 放行→ON 恢復擋→清理）全綠。
- ✅ **修 super_admin 會員管理頁快速入場「無法判斷操作館別」**（純前端 `redrock-web`）：`MembersPage` 的 `targetGymId` 只取 `activeGymId||staff.gymId`，super_admin 不綁館、個人帳號登入又無 `activeGymId` → 兩者皆空誤報「無法判斷操作館別，請確認登入狀態」。比照 `CheckinPage` 補 super_admin fallback 沿用畫面選的檢視館別 `viewGym`。commit `ecdc431`，已 firebase deploy。（入場頁 `CheckinPage` 原已處理、不受影響）

## 目前進度（2026-07-04 六）— 已付費放行(加購仍收) + 舊折扣卡8折轉換期設定
> 一問兩改：①「已付費放行」在 MembersPage 入場登記看不到（該 Modal 原無此按鈕；CheckinPage 手機號碼入場則有）②系統轉換三項文字沒對齊 ③新增「舊折扣卡8折」轉換期設定。兩個入場流程都補齊。後端 `/health` `1.38.0-checkin-alreadypaid-rentals-legacy-discount`。瀏覽器實測通過。
- ✅ **已付費放行語意修正 + 加購仍收費**：使用者澄清「已付費」只指**入場費**已付，加購岩鞋/粉袋仍要另收。原 `/checkin/phone` 的 alreadyPaid 會強制 `paymentMethod='already_paid'`、且前端 `handlePhoneAlreadyPaid` 根本沒帶加購 → 加購漏收。改：入場費記 0，加購以真實付款方式另收（`effectivePayment`：無加購→already_paid 純放行；有加購→真實付款方式）；前端已付費按鈕改帶 `rentShoes/rentChalk/paymentMethod`，按鈕顯示「入場費 NT$0，加購另收 NT$X」。
- ✅ **舊折扣卡8折（轉換期）**：持實體舊折扣卡、未轉入新優惠卡者，員工電話搜尋入場可手動套 8 折（**只折入場費**，加購原價；有效隊員再疊 9 折=0.72）。
  - 後端：`transitionSettings` 加 `checkinLegacyDiscountCard`（GET 預設/PUT）；`computePaidEntryAmount(entryType, member, {legacyDiscountCard})` 先 8 折(`DISCOUNT_CARD_RATE`)、隊員疊 9 折，回 `legacyDiscount`；`/checkin/phone` 收 `legacyDiscountCard` 旗標但**權威檢查後端開關開啟才生效**（不單信前端）。
  - 前端：`CheckinPage` 使用票券列加「舊折扣卡8折」選項（無新優惠卡且開關開時，走 /checkin/phone 帶旗標）；`MembersPage` 入場登記 Modal 加「套用舊折扣卡8折」勾選（只折入場費）+「已付費入場」按鈕。
- ✅ **系統轉換三項文字對齊**：`SettingsPage` 轉換分頁容器有祖層 `text-align:center` 讓標題置中、與 checkbox/描述不齊 → 容器補 `textAlign:'left'`。同時新增第四項「入場：電話搜尋可用舊折扣卡8折」開關。
- **瀏覽器實測（super_admin，未送出真實入場）**：設定頁四項對齊正確、第四項開關存檔 OK；CheckinPage 搜林怡君選成人單次入場→「舊折扣卡8折 NT$240」（300×0.8）、勾岩鞋→合計 NT$340（入場240＋岩鞋100，8折只折入場費）、已付費按鈕顯示「入場費 NT$0，加購另收 NT$100」；MembersPage 入場登記 Modal「已付費入場（入場費 NT$0）」按鈕出現。
- commit：後端 `redrock-api` `beb0224`；前端 `redrock-web` `67a5b9c`
- ⚠️ 已在正式環境開啟 `checkinLegacyDiscountCard`（測試用）；如尚未要對外啟用可到「系統轉換」關閉。`checkinAlreadyPaid` 先前已開。
- ✅ **入場情境衝突模擬（打正式 API，每筆 checkin→讀金額→取消，測後清乾淨）**：涵蓋一般/折扣卡/隊員/已付費/加購/雙旗標/開關關閉等組合。
  - **通過**：成人/學生/兒童 現場 300/250/150；成人/學生+舊折扣卡 240/200；已付費(0)、已付費+岩鞋(入場0+加購100 走真實付款)、已付費+legacy雙旗標(legacy 正確被忽略)、**開關 OFF 仍送 legacy 旗標→後端不折(權威把關過)**、隊員疊加 216/180。
  - ⚠️ **找到並修復**：兒童+舊折扣卡被折成 120、兒童+隊員被折成 135，與「兒童不適用折扣券」衝突 → `computePaidEntryAmount` 對 `child_free` **一律原價、不套 legacy 8 折與隊員 9 折**（權威，涵蓋電話入場與 QR 自助）；前端 CheckinPage/MembersPage 兒童不顯示舊折扣卡選項。重測兒童全部 150。`/health` `1.39.0-child-no-discount`；commit 後端 `a282689`、前端 `27e97f2`。
  - 觀察（非 bug）：`/checkin/phone` 依前端傳的 entryType 計費、不會自動覆蓋成 VIP/免費；VIP 免費靠前端送 `entryType=vip`（eligibility 顯示 VIP 徽章時才送）。測試會員林怡君(member-001) 為 `測試VIP` 資料。

## 目前進度（2026-07-04 六）— 入場流程圖 / 分期 loop 覆蓋 / 死碼清理
> 產出入場資格全流程視覺化 + 版控文件；補分期回歸測試；清掉失效端點。皆對到程式碼、非憑印象。
- ✅ **入場資格判斷流程圖 + 版控文件**：新增 `docs/entry-eligibility-flow.md`（另有互動版 Artifact），涵蓋完整入場鏈——
  - **關卡 0**（同日重複 / waiver / 墜測 / 分期逾期，含「當日體驗券」墜測例外、`email_unverified` 非入場關卡的 caveat）→ **階段 1 免費資格**（VIP → 定期票 → `course_access` → 免費短路；攀岩隊員不免費、走付費享 9 折）→ **階段 2/3 付費**（`entryTypeOptions` + `instruments`；`computePaidEntryAmount` 折扣疊加 ×0.8（舊折扣卡）×0.9（隊員）=0.72，兒童 `child_free` 一律原價不套折）
  - **會員自助 QR**（`/checkin/verify`→選方式→`/checkin/qr/create` 產券不扣→櫃檯 `/checkin/qr/scan` 預覽）→ **階段 4 `confirmCheckIn`**（先扣點孤兒防護、黑卡/單次券延後至此才扣 → 建入場 → `amountPaid>0` 才記營收；取消 10 分鐘還原卡券紅利）
  - **三條入場路徑對照**：會員 QR 自助 / 站台直接 `/checkin/direct`（create+confirm 一次串接即時扣、無 QR 等待）/ 站台電話 `/checkin/phone`（已付費放行、舊折扣卡、隊員折）；另含站台資格查詢 `/checkin/eligibility`（⚠**平行複製** verifyEntry、非同一實作，entryTypes/折扣規則改動須兩邊同步）與快速入場名單 `today-course-students`（唯讀、不建入場不扣點）
  - CLAUDE.md 開頭加指向連結。commit `fdb9dcf`→`b7c8abd`→`54a4dec`→`ffa5f1d`→`d1feaff`→`1020006`
- ✅ **課程分期付款 loop 回歸覆蓋**：`scripts/loop-test.js` 補 F 段分期狀態機 29 條斷言（建計畫/頭款→`markInstallmentPaid`→`runOverdueCheck` 逾期→`hasOverdueInstallment` 擋入場→補一期不解限→結清；`buildPeriodsFromConfig` 比例拆分/末期吸收餘數）。配套修 mock Firestore：`batch()` 從 no-op 改可運作、collection 加 `.add()`、docRef 加 `.delete()`（既有 A–E 不受影響）。**90 斷言全綠**（原 61+29）。commit `1214330`
- ✅ **清掉失效 legacy 端點 `POST /checkin/record`**：route 以物件參數呼叫 `recordCheckIn`（= `confirmCheckIn` 相容別名），但 `confirmCheckIn(qrToken,…)` 首參要 qrToken 字串 → 實際只回 `QR_NOT_FOUND`，**本就失效**；前端 `redrock-web` 無任何 caller。移除後端路由 + service 別名（`redrock-api` `c3e6708`，已 Railway 部署）；移除前端 dead export `recordCheckIn`（`redrock-web` `8dffdcf`，**已 push、未 firebase deploy**，純刪 dead export 不影響 runtime）
- ✅ **站台隊員 9 折 端到端實測通過（打 Railway 正式 API）**：建【練習】隊員（簽 waiver + 墜測同意書 + 墜測 passed + 設 2026 年度隊員）→ `/checkin/phone` 純付費入場（`entryType=single_ticket`）→ **原價 300 → `entryFee 270`（×0.9）、`isTeamDiscount:true`、`amountPaid 270`**；測後清乾淨（取消入場/票券退回、移除隊員、`DELETE /members/:id`）。腳本 `scratchpad/team-discount-e2e.sh`。
  - ✅ **站台帳號其實有效（修正先前誤判）**：站台帳號是**「館別電腦帳號」**（獨立 `stations` 集合、登入走 `POST /stations/login`，**不是** `staff` 集合 / `/auth/staff/login`）。先前記「站台帳號 `INVALID_CREDENTIALS`」是拿去打錯端點所致；用正確的 `/stations/login` 實測，`redrocktaiwan.hc@gmail.com`/`hsinchu2026`（→`station-hsinchu`）與 `redrocktaiwan@gmail.com`/`shilin2026`（→`station-zhubei`）**皆 200 登入成功**（裝置綁定開關目前關閉，免裝置驗證即可用）。→ **站台隊員 9 折現在就能用真站台帳號實機測**。
  - ❌ 真正失效的只有員工 `wang@redrock.app`：不在 `staff` 集合 14 筆內（帳號已不存在，非密碼問題）。本次隊員 9 折以 super_admin token 打 `/checkin/phone` 等價驗證（折扣邏輯 `computePaidEntryAmount` 與 staff 角色無關）。

## 目前進度（2026-07-06）— 定期票效期支援「月數」計算
> 回報：定期票 90 日用曆日算，希望改「一個月一個月」（例 7/6→10/6、8/5→11/5）。前後端一起做、各自 commit/deploy、打 Railway 正式 API E2E 驗證通過。後端 `/health` `1.42.0-pass-duration-months`。
- ✅ **票種新增 `durationMonths` 欄位（月數優先、向下相容）**：`passes.js` 抽 `computePassEndDate(startDate, passType)`——有 `durationMonths` 就 `dayjs().add(n,'month')`（月底自動夾，如 1/31＋1月→2/28），否則沿用 `durationDays` 曆日。建立（`POST /passes`）與續約（`PUT /:id` renew）共用；**既有 90 天票種完全不受影響**。
  - `POST /passes/types`：月/日擇一（皆空 → 400 `MISSING_DURATION`）；`PUT /types/:id`：可改月數、傳空清除（切回天數）；validator 用 `optional({checkFalsy:true})` 讓空字串正確跳過。
  - 臨時休館補償（`passExpiryService`）仍以算好的 `endDate` 為基準逐日加，**不受影響**；`schema.js` 補 `durationMonths` 文件。
- ✅ **前端（`redrock-web` `PassesPage`）**：票種表單「有效天數」→ 數字＋單位（**個月／天**）選擇器，新票種預設「個月」；清單顯示改用 `durationLabel`（月數顯示「N 個月」）。送出時月數走 `durationMonths`、天數走 `durationDays`（另一項送空清除）。
- **正式 API E2E（打 Railway，9/9 全綠）**：7/6+3月→**10/6**、8/5+3月→**11/5**、1/31+1月→2/28（月底夾）、7/6+90天→10/4（天數票種照舊）、月/日皆空→`MISSING_DURATION`、PUT 天數票種切 2 月→7/6→9/6。腳本 `scratchpad/pass-months-e2e.mjs`；測試殘留（林怡君 5 票 + 3 票種）已用 `firebase firestore:delete` 硬刪清乾淨。
- commit：後端 `redrock-api` `1cb31d1`；前端 `redrock-web` `eb0614d`

## 目前進度（2026-07-06 續）— 入場付款/卡券五項（兒童禁購折扣券 · 入場購定期票 · 掃碼場館比對 · 發放權限分級）
> 一輪連續需求，前後端各自 commit/deploy、每項打 Railway 正式 API E2E 驗證通過。後端 `/health` 最終 `1.47.0-legacy-bind-group-a`。金額/資格/場館一律後端權威、不信前端。
- ✅ **兒童不可購買折扣券**（`/health 1.43.0`；E2E 11/11）：`verifyEntry` 對 `child` 隱藏 `instruments.buyDiscountCard`（`available:false`）與舊式 `availableOptions` 的 `buy_discount_card`；`createPendingCheckIn` 權威擋 `buy_discount_card + child` → `CHILD_NO_DISCOUNT_CARD`（涵蓋 QR 自助與 `/checkin/direct`）。前端 `MemberQRPage` 改看 `buyDiscountCard?.available`。commit 後端 `13f3cb1`、前端 `6e18d1b`。
- ✅ **入場可購買新定期票 `buy_pass`**（比照 `buy_discount_card`）＋**修 eligibility 定期票場館 bug**（`/health 1.44.0`；E2E 22/22）：
  - `verifyEntry` 新增 `getBuyablePassTypes(gymId)`（該館適用：雙館 `shared` 或該館單館票種）→ `instruments.buyPass.passTypes`；`createPendingCheckIn` 收 `buyPassTypeId`，**後端權威取票種原價**、**單館票僅限目標館**否則 `PASS_GYM_MISMATCH`；`confirmCheckIn` 確認收款當下開立 `memberPass`（scope/targetGymId/效期/credits）；取消（`cancelCheckIn`＋`restoreEntryCredits`）作廢該定期票。前端 `MemberQRPage` 每票種一選項。
  - **Bug 修復**：`GET /checkin/eligibility` 的 `hasValidPass` 原用 `p.scope==='all' || p.gymId===gymId`（`'all'` 永不成立→雙館票誤判無效、可能誤收費；`gymId` 是售出館≠限制館 `targetGymId`）→ 改直接呼叫權威 `checkinService.getValidPasses`（單一真相來源）。commit 後端 `cd2dd22`、前端 `985739a`。
  - 註：**會員自助 `buy_pass` 不受下方發放權限限制**（那是會員本人付費購買，非店員「給會員」；店員代發定期票才走 `POST /passes` 管理員限制）。
- ✅ **入場 QR 掃碼比對場館**（`/health 1.45.0`；E2E 13/13）：`scanQrCode`/`confirmCheckIn` 加 `(staffGymId, isSuperAdmin)`，`pending.gymId !== staffGymId` → `GYM_MISMATCH`「此 QR 為「X館」入場碼，請至該館掃碼入場」；super_admin 例外、無站台館別不擋（防呆）；`confirm` 同檢查為權威後盾。路由 `/checkin/qr/scan`、`/qr/confirm`、`/direct` 傳入 `req.staff.gymId`＋role。前端既有 `err.message` 顯示即可（純後端）。commit 後端 `5095456`。
- ✅ **卡券/定期票發放權限分級 + 綁定揭露通知**（`/health 1.46.0→1.47.0`；E2E 20/20＋9/9）：政策 **管理員＝`gym_manager`/`super_admin`**、**場館電腦＝operator（打卡值班）**。
  - **Group A（值班或管理員；個人 full/part 未值班不可）**：發放單日券/體驗券 `POST /passes/single-entry`（維持發放→待審核）、轉入優惠卡 `POST /cards/discount/bind`、黑卡綁定 `POST /cards/black/bind`、舊優惠卡綁定/拍照歸檔 `POST /cards/legacy-discount/bind` → gate 改 `requireManagerOrStation`；後三者**立即生效＋`notifyCardBindDisclosure` 揭露到管理員通知頁**（通知同館 `gym_manager`＋`super_admin`）。
  - **Group B（僅管理員）**：新增優惠卡 `POST /cards/discount/purchase`、新增定期票 `POST /passes` → gate 改新增的 `requireManager`（operator 值班、full/part 皆擋；`gym_manager` 值班亦可）。
  - 前端按鈕依角色顯示（`CardsPage`/`PassesPage` 用 `useAuth`）；順手修 `PendingTasksPage` 通知內文空白（原只讀 `n.message`，服務端存 `body` → 改 `n.message || n.body`，一併修好舊有審核通知）。
  - **⚠️ 行為變更**：個人 `full_time`/`part_time` 帳號（未在館別電腦打卡值班）**不能**再發單日券/轉入優惠卡/黑卡綁定/舊卡綁定——需改用館別電腦值班(operator) 或管理員帳號。
  - **拍照歸檔位置**：後端 `legacyDiscountCardService.bindLegacyDiscountCard` 存 `legacyDiscountCards.photoUrl`（`source:'legacy'`、無期限）；**前端尚未接**拍照/上傳 UI，將來要接照片走 base64 內嵌（勿上 Storage）。
  - commit 後端 `40c4c63`（權限）＋`41f86e9`（舊卡納入）、前端 `3c69f22`。
- E2E 腳本：`scratchpad/`（child-nobuy / buy-pass / scan-gym / perm / legacy-bind），皆打正式 API、測後清理；殘留少量 dev 孤兒卡（已刪會員），無害。

## 維護腳本（`scripts/`）
- **`cleanupOrphans.js`** — 清 dev 殘留：孤兒卡/券/定期票（owner 會員已不存在）+ 測試 shiftLog（`stationId` 前綴，預設 `e2e-`）。**dry-run 為預設，`--commit` 才刪**；`owner=null`（未指派）不算孤兒、不刪；憑證走 `initFirebase()`（env `FIREBASE_*` 或 `GOOGLE_APPLICATION_CREDENTIALS`）。E2E 後清殘留用。
  - 預覽：`GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/cleanupOrphans.js`
  - 刪除：`… node scripts/cleanupOrphans.js --commit`
  - 選項：`--no-shifts`（只清孤兒、不動 shiftLog）、`--station-prefix=test-`（自訂測試站前綴）
  - dev service account json 在本機 `~/Downloads/redrock-dev-a35c1-firebase-adminsdk-*.json`（機密、不在版控）
- **`seedTestMembers.js`** — 建/清「【練習】」測試會員（`--commit` 寫入、`--clean` 只清）；**`loop-test.js`** — 卡片/紅利/入場/課程/分期狀態機回歸（90 斷言）。

## 待辦
- 各館申請 LinePay / 街口 / 台灣Pay 商戶 → 金鑰填入各 gym 的 `paymentSettings`
- 清理 E2E 測試殘留：`【練習】體驗生今日` 名下的 failed/returned `fallTestBookings` + 一筆 failed `fallTests`（練習 fixture，無害）
- LinePay sandbox 端到端測試 → 啟用線上付款 + 員工端 QR 前端
- 補街口 / 台灣Pay adapter 的 API TODO（依整合手冊 / 收單銀行）
- 資料移轉（Climbio 18,000+ 筆）
- ✅（已完成 2026-07-04 六）站台隊員 9 折端到端實測 → 見上方進度；**真站台帳號實機亦可直接做**（館別電腦帳號經 `/stations/login` 實測有效，見上方修正），後端邏輯已由 super_admin 打 `/checkin/phone` 等價驗證通過
- ⚠️ 更新 `CLAUDE.local.md`：站台帳號（新竹/士林）**其實有效**（走 `/stations/login`，非 `/auth/staff/login`）；真正失效的只有員工 `wang@redrock.app`（不在 `staff` 集合，帳號已不存在）→ 需重建或改用現有真人員工帳號測試
- 會員端 UI 驗證：課程試上分頁 + 場次代班「（代班）」顯示（需會員帳號登入實測）
- 「試上人數」目前僅由試上報名流程產生 `isTrial` 名單；如需員工手動加試上者，需另做 UI
- 清理 dev Firebase 殘留測試會員：`【練習】…` 系列、`測試/測試API會員/管理員測試會員/Test1/Who` 等，以及測試用 `王大明`(0900222222)/子帳號 `小明明`；可用員工端「刪除會員」或 `DELETE /members/:id`（super_admin）清除（會一併刪子帳號、保留歷史紀錄）
