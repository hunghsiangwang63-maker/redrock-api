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

## 目前進度（2026-07-06 續）— 定期票流程釐清 + 分期提醒 Email 修復
> 應要求釐清「定期票展延/退費申請」與「分期第二期通知/收款/逾期」流程，過程中發現並修一個真 bug。後端 `/health` `1.48.0-installment-reminder-emails`。
- 📋 **流程釐清（無異動，僅記錄）**：
  - **展延/退費/轉讓申請**：會員 App 或櫃檯 `POST /pass-adjustments/requests`（限四種法定事由 + 上傳證明 `evidenceUrl`）→ 每張票三選一、限一次（`pass.requestUsed`）→ 管理員待辦頁 `pass_adjustment` → `requireManagerOrStation` 審核。**展延** `endDate += extensionMonths`（上限 6 月）；**退費** `netRefund = round(原價/總天數 × 剩餘天數) − 手續費 600`，票 `cancelled`、需 `hasInvoice`（**只計算不自動記帳，退款櫃檯人工**）；**轉讓**手續費 300。年假批次 `holiday-batch` 不佔個人一次額度。
  - **分期**：`POST /passes` 帶 `paymentPlan:'installment'` → `createInstallmentPlan`（第一期簽約當下收+記帳，2…n 期 pending）。**每日台灣 09:00 in-process 排程**（`src/index.js`，每小時檢查、單一 instance）跑 `runOverdueCheck`（過期未繳→`overdue`、擋入場）+ `sendInstallmentReminders`（會員到期前 3 天提醒、逾期通知；管理員到期前 14 天站內預警）。收款 `POST /installments/:planId/pay`（`markInstallmentPaid`，補一期若仍有他期逾期則維持 `overdue`）或線上 rail 回呼；入場擋在 `verifyEntry` 關卡 2.5 `hasOverdueInstallment` → `installment_overdue`。
- ✅ **修 bug：分期到期/逾期提醒 Email 呼叫不存在的函式**（`/health 1.48.0`；E2E 10/10）：`installmentService.sendInstallmentReminders` 呼叫 `emailService.sendInstallmentDueReminder` / `sendInstallmentOverdueNotice`，但 emailService **根本沒這兩個函式** → 排程一碰到有 email 的到期/逾期會員就 `TypeError`、整批中斷（連管理員 `notifBatch` 都沒 commit）。補上兩函式（物件參數、含期數、走 `sendEmail`/Resend）+ 寄送包 `try/catch`（單筆失敗不中斷、不標 `sentAt` 下次重試）。**逾期標記與擋入場原本就正常，只壞「通知」**。正式 API E2E：`send-reminders` 200（原 500）、`reminderSent/overdueSent/adminNotified` 各 ≥1、計畫轉 `overdue`。commit `96a02a9`（純後端）。
- ✅ **查證：展延/退費證明文件上傳 Storage 不需改**（原疑慮誤報）：實測 `POST /pass-adjustments/evidence` 上傳 200、簽名 URL 可抓回原圖。Railway 有 `FIREBASE_PRIVATE_KEY` → `getSignedUrl` 本地簽章，**不觸發** waiver 當年失敗的 IAM oauth2。故**不改**（硬套 base64 會踩 Firestore 1MB 上限）。
- ✅ **展延/退費申請 E2E（打 Railway，後端 20/20 + 會員端 14/14）**：
  - **後端流程**（admin token）：上傳證明 → 建申請 → 同票再申請擋 `REQUEST_PENDING` → 待審核清單 → 核准展延（endDate 延長、月數正確）→ 用過的票 `REQUEST_ALREADY_USED` → 退費需 `hasInvoice`（否則 `INVOICE_REQUIRED`）→ 核准退費金額算式對上（剩91天 gross 2967 − 手續費600 = net 2367）、票 `cancelled` → 拒絕後票不變且可重申請 → 缺證明 400。
  - **會員端**（真會員 token，`POST /auth/member/login`；測試會員以 firebase-admin 注入 `passwordHash`）：會員從「我的票券」上傳證明+建申請，`memberId` 綁登入身分；**IDOR** 對他人票提申請 → `FORBIDDEN`；只能查自己申請（查他人 403）；**不能自審**（打核准端點 401，審核走 staff-only）；店員核准展延/退費結果同後端。腳本 `scratchpad/pass-request-e2e.mjs`、`pass-request-member-e2e.cjs`。
- 附帶：`cleanupOrphans.js` 孤兒集合加 `installmentPlans`、`passRequests`。

## 目前進度（2026-07-06 續）— 會員入場 QR 介面調整（純前端 `redrock-web`）
> 三項 UI 調整，build + firebase deploy，並用真會員帳號在正式站瀏覽器實機走完整流程逐頁驗證。commit（redrock-web）`40af8f1`。
- ✅ **身分選項只顯示名稱、不帶金額**：`MemberQRPage` `select_entry` 步驟改用 `entryIdLabel`——`single_ticket→成人入場`、`student_free→學生入場`、`child_free→兒童入場`（其餘去除「單次」字樣），並**移除該步驟的金額顯示**（金額於後續付款步驟才呈現）。
- ✅ **購買定期票改下拉選單**：`select_method` 原本「每個票種一張卡」平鋪 → 改為單一「購買定期票入場」下拉選單（`<select>`，選取即進入付款步驟），不再把所有定期票方案堆在選擇畫面。
- ✅ **後續步驟不再殘留定期票清單**：根因是上述平鋪卡片塞在付款方式頁；下拉化後收乾淨。步驟本就分離（`shoes`/`qr` 不渲染方案清單），實機確認**付款方式頁 / 租借器材頁 / QR 頁** 頂部皆無定期票清單。
- **瀏覽器實機驗證（redrock-member.web.app，真會員登入）**：身分頁顯示「成人入場／學生入場」無金額 → 付款頁定期票為下拉 → 一般付款 → 現金 → 器材頁 → QR 頁，各頁截圖確認無殘留。測試會員（`【練習】QR測試` 0900123789，firebase-admin 注入密碼）＋其 pending QR／waiver／墜測 已清乾淨。

## 目前進度（2026-07-06 續）— 入場三路徑收斂 + 分期修正（後端 1.49→1.56）
> 將入場三條路徑（會員 QR 自助 / 站台直接 `/checkin/direct` / 站台電話 `/checkin/phone`）收斂為單一權威關卡並補齊一致性，另修分期兩處。commit `e0b0696`→`87f203f`。多為統一/補漏/防偽造，**行為對合法輸入不變**。（此段依 git log 補記，前一輪之後由並行 session 完成。）
- ✅ **分期修正**：
  - `1.49` 修 `GET /installments/member` 缺 Firestore 複合索引 → 正式環境 `FAILED_PRECONDITION` 500（會員「我的分期」頁壞）→ 改只 `where` + 記憶體排序（比照 `getAllInstallmentPlans`）。commit `e0b0696`
  - `1.50` 分期管理員站內預警由到期前 14 天改 **7 天**（會員 +3 天提醒、逾期通知不變）。commit `191f8e1`
- ✅ **站台體驗券墜測例外 + 資格查詢權威化**：
  - `1.51` `/checkin/phone` 補「持當日有效體驗券者未過墜測也可入場（須先簽墜測同意書，否則 `fall_test_consent_required`）」例外，與 `createPendingCheckIn` 一致；`checkinService` export `hasFallTestSignature`。commit `795c43d`
  - `1.52` `/checkin/eligibility` 單次券改用權威 `getValidSingleEntryTickets`（原自帶查詢漏體驗券 `validDate=今日`／未帶 `ticketType`，與 `confirmCheckIn` 不一致）→ 電話搜尋當日體驗券端到端可用、回 `ticketType/validDate`。commit `6d9c345`
- ✅ **三路徑收斂重構（A/B/C）+ 逾期補擋**（行為對合法輸入不變）：
  - `1.53` `createPendingCheckIn` 補 `hasOverdueInstallment`——**站台直接 `/checkin/direct` 原本可讓分期逾期會員入場**（`verifyEntry`/`phone` 皆有擋），現三路徑一致擋。commit `926e42d`
  - `1.54`（refactor C）舊折扣卡 8 折收斂進 `createPendingCheckIn`（`/qr/create`、`/direct` 亦支援；權威讀 `transitionSettings.checkinLegacyDiscountCard`、不單信旗標；pending/checkIn 加 `legacyDiscount` 欄）。commit `1774d22`
  - `1.55`（refactor A）新增 `checkinService.runEntryGates`（同日重複／Waiver／墜測含體驗券例外／分期逾期），`verifyEntry`／`createPendingCheckIn`／`/checkin/phone` 皆改呼叫；`/direct` 移除自帶 dup 檢查。保留路徑差異（墜測例外 `owns` vs `using`、子女分期逾期以 `parentMemberId` 查家長）；副帶 QR/direct 現也做同日重複檢查。commit `5eddf9b`
  - `1.56`（refactor B + 防白嫖）`/checkin/eligibility` waiver 布林改用共用 `checkWaiver`（export）；**`/checkin/phone` 免費資格（VIP/定期票/課程）改呼叫 `verifyEntry` 權威判定**——前端偽造免費 `entryType` 但實際非免費者改用權威付費類型（合法者不變、已付費放行不覆核）。commit `c7c07e5`
- 📄 `docs/entry-eligibility-flow.md` 同步更新（關卡0 改單一 `runEntryGates` 含 `owns/using` 體驗券模式、風險段標「已收斂」、重構後行號）。commit `994ea54`、`87f203f`
- 📄 **文件重產（依四風險核對修復後現狀，全依程式碼行號、無推測）**：三路徑比較表補「關卡0共用 `runEntryGates`／`/phone` 免費資格後端權威／舊折扣卡8折三路徑一致／`/direct` 移除自帶 dup」、修正 `cancelCheckIn` 行號（→1000）；風險段拆成 **「已修復」**（風險 2/3/4 + eligibility 底層函式共用，附修復方式與行號）與 **「尚未修復/設計取捨」**。commit `5fa3a9d`。
  - ⚠️ **eligibility 未達「回傳全等」**：`/checkin/eligibility`（`checkin.js:205-227`）底層查詢已與 `verifyEntry` 共用（**資料一致**），但**只回布林旗標＋`instruments{discountCard/blackCard/bonus/singleEntryTicket}`**，**不含** `entryTypeOptions`/`buyPass`/`buyDiscountCard`/免費短路。定位為「全部攤開供站台挑選」投影層（不決定單一結果、由站台人員選），**誤放/誤收風險低、暫不補齊**；若要全等需另做程式碼變更。

## 目前進度（2026-07-06 續）— 入場購定期票（buy_pass）支援分期付款
> 「入場當下購買定期票」原只能一次付清，補上分期（比照 `POST /passes` 的 `usePassInstallment`）。金額後端權威、營收不雙重記帳。後端 `/health` `1.57.0-buy-pass-installment`；E2E（打 Railway，`/checkin/direct`）16/16。
- ✅ **後端**（`checkinService.js` + `checkin.js`）：
  - `getBuyablePassTypes` 回傳補 `installment`（前端判斷可否分期）。
  - `createPendingCheckIn` 收 `paymentPlan` 寫進 pending（`'full'|'installment'`）；`/checkin/qr/create`、`/checkin/direct` 透傳。
  - `confirmCheckIn` buy_pass 分支：`paymentPlan==='installment' && pt.installment.enabled && price>0` → `buildPeriodsFromConfig` + `createInstallmentPlan(relatedType:'pass', firstPaymentMethod=pending.paymentMethod)`；memberPass 記 `installmentPlanId`。
  - **營收不雙重記帳**：分期時票價由分期計畫第一期記帳，**本次入場交易排除票價**（`checkIn.amountPaid` 與 `recordTransaction entryFee` 皆扣掉，比照 `POST /passes` 的 `!passPlan` 條件）；一次付清維持原行為（記全額）。
  - `cancelCheckIn` buy_pass：取消一併作廢分期計畫（`status:'cancelled'`），避免孤兒欠款/逾期擋入場。
- ✅ **會員端**（`redrock-web` `MemberQRPage`）：選定期票方案後、付款方式頁若該票種可分期 → 顯示現成 `PaymentPlanChoice`（一次付清/分期＋各期預覽），下方付款方式即「頭款（第一期）」；payload 帶 `paymentPlan`。
- ⛔ **站台端（CheckinPage）刻意不做**：站台走 `/checkin/eligibility`（投影層、不回傳 `buyPass`，見上一段風險 1 決定），本就無 buy_pass 入口。後端 `/checkin/direct` 已支援 `buy_pass+paymentPlan`（E2E 即打此條），未來要接站台 UI 隨時可用。
- **E2E（16/16）**：分期→`/checkin/direct` 201、`checkIn.paymentPlan=installment`、**`amountPaid=0`**（票價不重複記）、memberPass 有 `installmentPlanId`、分期計畫 3 期（第1期 paid 2534、2/3 pending、合計 7600）；一次付清→`amountPaid=7600`、無計畫。commit 後端 `e18ea4f`、前端 `2736121`。腳本 `scratchpad/buypass-installment-e2e.mjs`；殘留已 `cleanupOrphans` 清。
- ✅ **修：分期時 QR 合計顯示「頭款（第一期）」而非全額**（前端 `MemberQRPage` qr 步驟）：原用 `selectedEntry.price`（全額 7600）顯示，分期時應只顯示本次收的第一期。改：`buy_pass && 分期`時 `entryPrice=round(全額×第1期%)`、標籤「定期票（頭款・第1期）」＋註「分期 N 期 · 全額 NT$X」；合計＝頭款＋加購。後端本就只收第一期（顯示對齊，無金流變動）。瀏覽器實機確認：頭款 NT$2,534、合計 NT$2,534、註「分期 3 期 · 全額 NT$7,600」。commit 前端 `27a4001`。
  - ⚠️ **快取提醒**：`firebase deploy` 後普通 hard reload 常不夠，需**加 query 參數**（如 `?x=1`）或無痕視窗強制重抓 `index.html` 才會載到新 bundle（此次即因舊 bundle 仍顯示 7600 而誤判）。
- ✅ **選擇階段顯示「可分期」標示**（前端）：有開分期規則（`installment.enabled`）的項目在挑選當下即標示——`MemberQRPage` 購定期票下拉 option 尾端加「· 可分期」；`MemberCoursesPage` 課程總覽卡片類型徽章旁加琥珀色「可分期」tag。資料本就都在（票種來自 `getBuyablePassTypes`、課程來自清單物件）。commit 前端 `25d524c`。

## 目前進度（2026-07-07）— 員工端入場動作限值班(operator)/管理員
> 回報：櫃檯電話搜尋入場與掃 QR 入場的差別？是否關掉電話入場？結論：**兩條互補、不關**（QR＝會員自助、電話＝櫃檯代辦：沒 App/臨櫃/已付費放行/舊折扣卡；1.49–1.57 已收斂降低分歧風險）。改採「加權限」——入場動作限值班/管理員（比照發券 Group A）。後端 `/health` `1.59.0-checkin-preview-restricted`；E2E 12/12＋6/6。
- ✅ **入場動作限 `requireManagerOrStation`**（`checkin.js`）：`/checkin/qr/scan`、`/qr/confirm`、`/direct`、`/phone` 由 `checkPermission('checkin.create')`（4 角色）→ 值班 operator 或 `gym_manager`/`super_admin`；**個人 `full_time`/`part_time` 未打卡值班不可**。commit `2ee5f41`（`1.58.0`）。
- ✅ **資格預覽讀取也一併限**：`/checkin/eligibility`（電話搜尋資格預覽）、`/checkin/today-course-students`（今日課程學員名單，入場 tab 資料來源）加 `requireManagerOrStation`。commit `1ea81e2`（`1.59.0`）。
- ⭕ **不受影響**：`/checkin/qr/create`、`/verify`（會員自助，`authenticateAny`）；`/checkin/today`、`/history`（報表純檢視）；`/checkin/cancel`（維持 `checkin.create`，取消非入場動作）。
- ✅ **前端**（`CheckinPage`）：`canCheckin = 管理員 或 operator 值班`；「掃描入場」與「今日課程學員」入場 tab 僅 `canCheckin` 時顯示，否則顯示 🔒「入場功能限值班/管理員」提示；報表 tab 不限。commit `56fd32d`。
- **E2E**：入場動作 12/12（PT 個人 scan/confirm/direct/phone 皆 403 `MANAGER_OR_STATION_REQUIRED`、OP/MGR 成功、`qr/create` 不受限）；預覽讀取 6/6（PT eligibility/course-students 403、OP/MGR 200、報表 `/today` PT 仍 200）。腳本 `scratchpad/checkin-perm-e2e.mjs`。
- ⚠️ **行為變更**：個人 `full_time`/`part_time` 帳號（未在館別電腦打卡值班）現在**不能做任何入場**，需先打卡值班(operator) 或用管理員帳號。

## 維護腳本（`scripts/`）
- **`cleanupOrphans.js`** — 清 dev 殘留：owner 會員已不存在的孤兒（優惠卡/舊優惠卡/黑卡/單次入場券/定期票/分期計畫/定期票異動申請）+ 測試 shiftLog（`stationId` 前綴，預設 `e2e-`）。**dry-run 為預設，`--commit` 才刪**；`owner=null`（未指派）不算孤兒、不刪；憑證走 `initFirebase()`（env `FIREBASE_*` 或 `GOOGLE_APPLICATION_CREDENTIALS`）。E2E 後清殘留用。
  - 預覽：`GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/cleanupOrphans.js`
  - 刪除：`… node scripts/cleanupOrphans.js --commit`
  - 選項：`--no-shifts`（只清孤兒、不動 shiftLog）、`--station-prefix=test-`（自訂測試站前綴）
  - dev service account json 在本機 `~/Downloads/redrock-dev-a35c1-firebase-adminsdk-*.json`（機密、不在版控）
- **`seedTestMembers.js`** — 建/清「【練習】」測試會員（`--commit` 寫入、`--clean` 只清）；**`loop-test.js`** — 卡片/紅利/入場/課程/分期狀態機回歸（90 斷言）。

## 目前進度（2026-07-07）— 定期票會員端續約（產生入場 QR 時勾選）
> 需求：續約只放**會員端**（員工端不做）；**到期前 14 天**開放；於**產生入場 QR 時**勾選；票種多一個**續約折扣**（%或NT$兩種格式擇一）；分期時**折後差價全部集中在最後一期扣掉**。前後端各自 commit/deploy、打 Railway 正式 API E2E 通過。後端 `/health` `1.62.0-pass-renewal-at-entry`。
- ✅ **票種續約折扣欄位（批次A）**：`passes.js` 加 `normalizeRenewalDiscount`（`{mode:'percent'|'amount', value}`，percent 夾 ≤100、value≤0 視為 null）＋ `computeRenewalPrice`；`POST/PUT /passes/types` 收 `renewalDiscount`；`checkinService.getBuyablePassTypes` 一併回傳。前端 `PassesPage` 票種表單加「續約折扣」（折%/折抵NT$ 切換＋數值，留空＝原價續約）。commit 後端 `c01fd32`、前端 `ddcc826`。E2E：建 percent 10 / 改 amount 800 / value 0→null 全綠。
- ✅ **後端續約端點 + 分期末期折扣（批次B）**：
  - `verifyEntry` 定期票免費短路加**續約偵測**：有效票中任一到期 ≤14 天 → 回 `renewal{passId,passTypeName,daysLeft,currentEndDate,newEndDate,fullPrice,renewalPrice,renewalDiscount,installment}`（`getRenewalInfo`，`RENEWAL_WINDOW_DAYS=14`）。
  - `createPendingCheckIn` 收 `renewPassId`/`renewPaymentPlan`：**後端權威**驗票屬本人 / 有效 / 場館（單館票限適用館）/ 到期窗（`RENEW_NOT_OPEN`），快照折後價與新到期日到 pending（`renewSnapshot`）。續約**獨立於 entryType**（附加在免費入場定期票上）。
  - `confirmCheckIn` 續約處理：延長票期（現到期日未過→以之為基準加月/日；已過→今日）、重置次數、`status:'active'`；一次付清記 `type:'pass'` 交易、分期建 `installmentService.buildRenewalPeriods`（前 n-1 期照原價比例、**末期＝續約總價−前期已分配**吸收折扣）計畫（首期由計畫記帳）。續約款**不併入 checkin 交易**（各自記帳、避免雙重）。
  - `scanQrCode` 預覽續約應收 `renewal.dueNow`（一次付清＝折後全額；分期＝首期）計入 `totalAmount`。
  - 取消：`revertRenewal`（`checkinService` 匯出，`cancelCheckIn` 與 `cancelCheckin.js` 路由共用）→ 還原票期/次數/既有分期計畫、作廢續約分期計畫、一次付清記負向 refund 沖銷。
  - **E2E（打 Railway，23/23 綠）**：半年票 7600、續約9折 6840、3期 40/40/20 → 一次付清 scan `dueNow=6840`、confirm 延到 2027-01-12、`renewalAmount=6840`、取消還原 2026-07-12；分期 scan 首期 3040、各期 **[3040,3040,760]**（760 折扣集中末期）、票期延長、取消還原＋計畫作廢；到期30天 → `RENEW_NOT_OPEN`。commit `550cd6c`。腳本 `scratchpad/renewal-e2e.mjs`。
  - **verify 附帶 renewal E2E（9/9 綠）**：建成人練習會員（非 VIP，簽 waiver＋墜測 passed 過關卡）→ 給到期今+5天的票 → `POST /checkin/verify` 到達**定期票免費區塊**且回傳完整 `renewal`（`renewalPrice 6840`/`newEndDate 2027-01-12`/`daysLeft 5`/`installment.enabled`）。測後清乾淨。
- ✅ **會員端 UI（批次C）**：`MemberQRPage` 免費入場定期票路徑，`verify` 回 `renewal` 時於「租借器材」步驟上方顯示**續約卡片**（剩 N 天／折後價含原價刪除線／延長至新到期日）；可勾選順便續約；票種開分期時提供「一次付清／分期 N 期」（首期金額前端與後端同算法、顯示末期折扣）；續約需選付款方式（頭款），QR 合計加入續約應收、摘要顯示續約行。commit 前端 `c3bb60d`，已 firebase deploy。
- ✅ **會員端 UI 瀏覽器實測（redrock-member.web.app 真登入）**：以成人非 VIP 練習會員（持到期剩 5 天半年票＋續約9折＋3期；`firebase-admin` 注入 passwordHash 可登入）逐頁確認——首頁無 onboarding gate →「租借器材」步驟頂部續約卡片顯示「剩 5 天・順便續約（延長至 2027-01-12）・~~7,600~~ **6,840** 續約優惠」→ 勾選展開「一次付清 6,840／分期 3 期 首期 3,040」＋付款方式，未選付款方式時「請先選擇續約付款方式」擋確認鈕 → 選分期＋現金後鈕啟用「確認（+NT$3,040）」→ QR 頁「定期票續約（頭款・第1期）3,040」＋「分期 3 期 · 折後全額 6,840（**末期 NT$760**）」＋合計 3,040。前端首期/末期折扣與後端 `[3040,3040,760]` 完全一致。測試會員/票/票種測後 `DELETE` 清乾淨（pending QR 30 分自動失效）。
- ⚠️ **E2E 測試細節（新學到）**：bodyless `DELETE` 若帶 `Content-Type: application/json` 會被 express.json() 當空 body 解析失敗 → 回 400 `SERVER_ERROR`（假清理成功、留殘留）。E2E 清理的 DELETE **不要帶 Content-Type**（或帶 body）。本次殘留已補清乾淨。

## 目前進度（2026-07-07 續）— 票種編輯加刪除鍵（純前端 `redrock-web`）
> 需求：定期票「票種編輯」多一個刪除鍵、加 Modal 確認。純前端（後端 `DELETE /passes/types/:id` 軟停用早已存在）。build + firebase deploy + 員工端瀏覽器實測通過。commit（redrock-web）`9d85168`。
- ✅ **編輯票種 Modal 加「刪除此票種」鍵**（`PassesPage`，只在編輯模式顯示，紅框全寬）；點擊跳自訂確認 Modal（取代原 `window.confirm`）。
- ✅ **票種列表按鈕「停用」改「刪除」**，與編輯 Modal 共用同一確認 Modal；全面移除 `window.confirm`。
- ✅ **確認 Modal 文案誠實對齊後端語意**：刪除＝**軟停用**（`isActive:false`）——之後**無法再選購**（新增定期票／入場購票／續約皆不出現），**已購買會員不受影響**、既有票照常使用。
- **瀏覽器實測（staff.web.app，super_admin）**：建練習票種 → 票種定義列表按鈕顯示「刪除」→ 編輯 Modal 底部「刪除此票種」→ 確認 Modal 文案正確 → 確定刪除 → 卡片消失、後端 `isActive=false`；測試票種硬刪清乾淨、無殘留。

## 目前進度（2026-07-07 續）— 墜測通過鎖定文件退回 + 會員封鎖改列待辦
> 兩個小需求：①墜落測驗已通過時，waiver／墜測同意書不可退回重簽（避免誤觸把在籍會員踢回入場前置）②會員資料頁不再顯示「封鎖中」、改直接列出待完成事項。後端 `/health` `1.63.0-reset-locked-when-falltest-passed`。
- ✅ **墜測通過 → 鎖定兩份文件退回**（後端）：`POST /members/:id/waiver/reset` 與 `POST /fall-tests/signature/:memberId/reset` 退回前用權威 `checkinService.checkFallTest(memberId)` 檢查——`passed` → **409 `FALL_TEST_PASSED_LOCKED`**。僅 **super_admin 帶 `force:true`** 可強制覆寫（供條款改版等正當重簽）。commit 後端 `ea4610e`。
  - **前端（`MembersPage`）**：`detail.latestFallTest.result==='passed'` 時，兩個「退回重簽」鍵改顯示 **🔒 已鎖定**（前端 api 不送 force，UI 無覆寫路徑＝完全避免誤觸）。commit 前端 `91fdbe7`。
  - **E2E（打 Railway，8/8 綠）**：會員A(墜測passed) → waiver/同意書退回皆 **409 LOCKED**、`force:true` 皆 200；會員B(墜測未過) → 兩者退回皆 200 允許。測後清乾淨。腳本 inline。
  - ⚠️ **鎖定條件用權威 `checkFallTest`（含過期判定）**：曾通過但**已過期** → `passed:false` → **可**退回（該會員本就要重測）；前端 UI 鎖定看 `latestFallTest.result==='passed'`（不含過期），故過期會員 UI 仍顯示🔒但後端會放行——以後端為準。
- ✅ **會員資料頁「封鎖中」→ 直接列待完成事項**（純前端 `MembersPage`）：原單一「封鎖中」紅標改為讀 `member.blockReasons` 逐項顯示——`waiver_unsigned`→待簽免責聲明、`parent_waiver_pending`→待家長簽署、`fall_test_required`→待通過墜落測驗、`email_unverified`→待驗證 Email；全完成則無標籤。commit 前端 `88c2e40`。
  - 📋 **「封鎖中」判斷邏輯備忘**（`memberService.getBlockReasons`，開會員詳情時 `refreshBlockStatus` 即時重算）：三條任一成立即封鎖——① Email 未驗證（**僅自助註冊** `registeredBy==='self'` 且 `emailVerified=false`；店員/遷移建立不算）② Waiver 未完成 ③ 從未通過墜落測驗（無 `result:'passed'` 紀錄）。**caveat**：此旗標＝「入場前置完成度」，**非**即時入場資格——**墜測過期**（有 passed 紀錄）與**分期逾期**都不進 blockReasons、不顯示待辦，但入場仍由 `runEntryGates` 即時擋；`email_unverified` 會顯示待辦但入場關卡實際不擋（只擋登入）。

## 目前進度（2026-07-07 續）— 加到手機主畫面顯示 RedRock 圖示（PWA manifest，純前端 `redrock-web`）
> 需求：會員把網址加到手機主畫面時，圖示要顯示我們的 Favicon。關鍵：主畫面圖示**不讀 favicon**——iOS 讀 `apple-touch-icon`、Android 讀 **Web App Manifest** 的 `icons`。原本缺 manifest（Android 不顯示）。build 兩 target + firebase deploy。commit（redrock-web）`d0b60c1`。
- ✅ **新增 `public/manifest.webmanifest`**：`name`「RedRock 紅石攀岩館」/`short_name`「RedRock」/`display:standalone`/`theme_color:#8B1A1A`/`background_color:#F7F3F3`/`icons`（192 + 512 + 512 maskable）。
- ✅ **由 `favicon.png`(512 彩色 R，白底不透明) 產各尺寸**：`apple-touch-icon.png`(180)、`icon-192.png`、`icon-512.png`（`sips -z`）。
- ✅ **`index.html` head 補**：`<link rel="manifest">`、`theme-color`、`apple-mobile-web-app-capable/status-bar-style/title(RedRock)`、`mobile-web-app-capable`；`apple-touch-icon` 改指 180 版。
- ⚠️ **iOS 會快取主畫面圖示**：之前加過舊的要先刪主畫面圖示再重加（或無痕）才會更新。
- ⚠️ **`index.html` 兩站共用** → 員工站加到主畫面也顯示同一 R 圖示與「RedRock」名稱（同品牌，通常 OK）。要員工站不同名稱/圖示需做**分 target 的 manifest**（目前未做）。

## 目前進度（2026-07-07 續）— 定期票持有人報表顯示 memberId + 未來票提前生效 + 列表排序
> 回報：員工會員頁點「定期票」，下方持有人列表**月票的人名顯示原始 UUID**（如 `e01e3390…`＝【練習】李定期月票）。連帶修兩個相關項。後端 `/health` `1.64.0-active-passes-membername-startdate`。
- ✅ **主 bug：報表姓名顯示原始 memberId**（`GET /members/reports/active-passes`）：根因是報表直接用定期票文件的 `p.memberName`，但 **`POST /passes` / seed 建立的定期票根本沒存 `memberName`** → 回空字串 → 前端 `RowMemberList` 的 `memberName || memberId` fallback 成 UUID。修法：報表改用 **`members` 集合權威補齊姓名**（批次 `db.getAll`），查無會員顯示「(已刪除會員)」。commit 後端 `223151e`。E2E（打 Railway）：所有群組姓名正常、**UUID 當姓名 0 筆**（`e01e3390` 正確顯示「【練習】李定期月票」）。
- ✅ **附帶邊界：未來起始日的票提前生效**（`checkinService.getValidPasses`）：原只看 `endDate>=today`、**沒看 `startDate`** → 起始日在未來的定期票現在就被當有效、可免費入場。加 `!startDate || startDate<=today` 判斷（合法票不受影響）。⚠️ 報表 `/reports/active-passes` **未**加 startDate 過濾（仍列出未來票＝「持有」，只是入場資格不提前生效）。
- ✅ **會員定期票列表排序（純前端 `PassesPage`）**：`memberPasses` 改**有效優先、已取消/過期收到底部並淡化**（`opacity:0.5`），同組內到期日新→舊；不再讓「已取消」蓋過有效票。commit 前端 `64b48ad`。
- 🧹 **清掉 E2E 定期票殘留**：先前 renewal/verify E2E 用 `DELETE /passes/:id`（軟刪＝`status:cancelled`、不移除）留下林怡君名下 2 張 + 2 張孤兒（會員已刪）共 4 張 `【練習】` 定期票，已 `firebase-admin` 硬刪清乾淨（全域掃描 0 殘留）。**教訓：E2E 定期票清理要硬刪或事後掃 `cleanupOrphans`，軟刪會殘留在持有人列表/會員定期票頁。**

### 📋 定期票「入場購買 buy_pass」語意確認（僅釐清、無程式異動）
> 針對「起訖日怎麼決定」「已有有效票時會怎樣」的一輪確認，結論記錄如下（皆對照程式碼）。
- **起訖日**（`confirmCheckIn`，`checkinService.js:1001-1036`）：**在櫃檯「確認入場/收款」當下才開票**——`startDate = taiwanToday()`（＝確認那天，**不是**產生 QR 那天；QR 30 分過期故實務多同日），`endDate = startDate + 效期`（有 `durationMonths` 用月數、月底自動夾，否則 `durationDays` 曆日）。與 `POST /passes` 的 `computePassEndDate` **等價**（buy_pass 為 inline 重寫）。分期只影響金流、**不影響起訖日**。buy_pass 一律「今天起算」，故**不會**產生未來起始日的票（未來票只來自店員 `POST /passes` 手動指定）。
- **已有有效定期票時**：`verifyEntry` 在「定期票免費短路」就 `return`（`checkinService.js:529-544`），`buyPass` 是**付費階段才組**（`:664`）→ **同館有可用票的人根本走不到、選不到「購買定期票」**（會員端 `MemberQRPage` 免費入場直接跳租借步驟、無 `select_method`）。判斷基準是**「入場當館、當下有無可用覆蓋」**，不是「名下有無任何 active 票」。
- **仍會出現購買選項的三種情形**（皆因「這一館其實沒覆蓋」）：① 手上是**他館單館票**、這次進另一館；② **回數票次數用完**（`credits<=0`）；③ 站台 `/checkin/direct` 硬帶 `entryType=buy_pass`（繞過 verify）。→ 買了都是**今天起算**、不會自動接在舊票後（無排隊/去重邏輯）。
- **決策：維持現狀（方案 A）** ——以「入場當館的有效覆蓋」為準，他館單館票/回數票用完時仍可購買，視為合理。（未採方案 B「名下有任何 active 票就一律禁購」。）續約（到期≤14天）才是「已有票要延長」的正解，且**接在原到期日後延長、不重疊**。

## 目前進度（2026-07-07 續）— 票種 & 課程：編輯／停用／刪除 三功能
> 需求：票種與課程都要「編輯／停用／刪除」，**停用後會員看不到、可逆保留**；刪除＝真的移除。後端 `/health` `1.65.0-passtype-course-enable-disable-delete`；E2E（打 Railway）**14/14 綠**。commit 後端 `d3be571`、前端 `6caf5e3`。
- ✅ **票種（`passes.js` + `PassesPage`）**：
  - **停用/啟用**：`PUT /passes/types/:id` 收 `isActive`（true 清 deactivatedAt / false 記）；停用後會員**購買/挑選清單看不到**（`getBuyablePassTypes` 本就濾 active）、**既有已購買的定期票不受影響**、可再啟用。
  - **管理頁含停用票種**：`GET /passes/types?includeInactive=1`；前端 `loadPassTypes` 帶此參數載全部、另用 `activePassTypes` 過濾給「票種一覽 / 新增定期票選單」（不列停用）。
  - **刪除改硬刪除**：`DELETE /passes/types/:id` 改真刪；**仍有會員持有此票種「有效」定期票 → 409 `PASS_TYPE_IN_USE` 擋下**，提示改用停用。
  - 前端票種定義卡：三鍵 編輯／停用⇄啟用／刪除；停用卡淡化＋「已停用」標籤；刪除確認 Modal 改「永久刪除、有效持有者會被擋」。（附帶：`includeInactive` 撈出**本來就停用**的兒童月票/10次回數票竹北，現可於管理頁啟用/刪除。）
- ✅ **課程（`courses.js` + `CoursesPage`）**：
  - **停用/啟用**：`PUT /courses/:courseId` 允許 `isActive`；`GET /courses` 會員端過濾 `isActive!==false` → 停用後**會員課程總覽看不到**、**不通知學員、不動報名**、可再啟用。
  - 課程卡加 停用⇄啟用（淡化＋「已停用」標籤）。
  - ⚠️ **與既有「取消課程」不同**：`DELETE /:courseId`（取消課程）＝**寄信通知學員＋取消未來報名**，仍保留為獨立動作；**永久刪除** `/permanent`（硬刪、有在籍報名會擋）**限 super_admin**。停用則所有課程管理員可用。
- **E2E 重點**：票種停用→GET 預設不含、includeInactive 含、啟用復現；硬刪成功、有效持有者 409、票券作廢後可刪；課程停用→**真會員（林怡君）登入實測看不到、員工端仍看得到、啟用後又看得到**。票種 UI 三鍵瀏覽器實機確認。測試殘留（含順手硬刪一批舊 `【練習】` 停用票種）已清乾淨。

## 目前進度（2026-07-07 續）— 定期票票種顯示順序
> 需求：定期票排列依「效期短→長」，「算次數（回數票）」排在「算時間」之後。**純後端**（前端吃 API 順序、無自行 sort）。後端 `/health` `1.66.0-passtype-sort-duration-credits-last`；commit `feb4054`。
- ✅ **`passes.js` 加 `sortPassTypes()`**，排序鍵：① `credits!=null`（回數票）排後 → ② 效期短→長（`durationMonths×30` vs `durationDays` 比較）→ ③ 同效期再依次數。套在 `GET /passes/types`；`checkinService.getBuyablePassTypes` 同排序（會員購買下拉一致）。
- **驗證（打 Railway，含停用）**：30天月票群 → 90日定期票 → 半年票(180天) → **回數票（90天）排最後**（算次數一律排時間票之後，不看自身天數）。
- 註：持有人報表 `/reports/active-passes` 維持**依人數排序**（不受此影響）。

## 目前進度（2026-07-07 續）— 票券統計/下載 CSV 補管理員權限
> 查證：優惠卡/黑卡「票券統計＋下載 CSV」在員工端 定期票 →「📊 票券統計」分頁（`PassAnalyticsPage`）。UI tab 有 gate（`canManagePass`＝管理員或值班 operator），但**後端 `/analytics`、`/analytics/download` 原本只 `authenticate`**（註解寫「管理員」卻沒 role 檢查）→ 任何員工 token（含個人 full/part 未值班）可直打 API 下載全館會員姓名/手機/卡號。→ 補上權限。後端 `/health` `1.67.0-card-analytics-manager-only`；E2E 9/9；commit `c0533b4`。
- ✅ **`GET /pass-adjustments/analytics` 與 `/analytics/download` 加 `requireManagerOrStation`**（值班 operator 或 `gym_manager`/`super_admin`），與 UI tab gate 一致。
- **下載內容備忘**（供日後查）：CSV UTF-8 帶 BOM、檔名 `<type>_<日期>.csv`；`?type=discounts`（優惠卡）欄位＝序號/姓名/手機/卡號(barcode)/狀態/剩餘格數/原始格數/已用格數/**紅利已送**/到期日/綁定日/館別；`?type=blacks`（黑卡）**無「紅利已送」欄**、到期日可為「無期限」。資料源：優惠卡 `discountCards`（`ownerMemberId`，預設10格）、黑卡 `legacyBlackCards`（`memberId`，預設12格）；姓名/手機由 memberId 反查 members 補齊。統計「已使用」＝發出−剩餘，「發出」只算原始卡（`source!=='transferred'`）。
- **E2E（打 Railway，9/9）**：admin/值班 operator → analytics + download(discounts/blacks) 皆 200；個人 part_time（未值班）→ 三者皆 **403**。
- ✅ **修：下載 CSV 內容變成「unauthorized/請先登入」**（前端既有 bug，與上面權限改動無關）：`PassesPage.downloadAnalyticsCSV` 原自己讀 `localStorage.getItem('staffToken')`——但這個 key **根本不存在**（axios `client` interceptor 用的是 `operatorToken`／`token`／`stationToken`）→ 送空 token → 後端 `authenticate` 回 **401**，那段 JSON 被當 CSV 存下。改用 `client.get(..., {responseType:'blob'})`（與能正常載入統計的 `loadAnalytics` 同一 client/token 來源），並加錯誤提示（403 權限不足／其他 重新登入）。純前端 commit（redrock-web）`aedff18`。瀏覽器實機：統計分頁載入正常、點下載無錯誤 banner。（standalone `PassAnalyticsPage.jsx` 為未 route 的 dead code，不影響。）
  - ⚠️ **教訓**：前端下載/檔案類請求要走 axios `client`（自動帶對的 token），別自己 `fetch` + 手讀 localStorage key；token key 是 `operatorToken/token/stationToken`（見 `api/client.js`），**沒有 `staffToken`**。
  - ✅ **瀏覽器實機下載驗證（優惠卡）**：員工端點「優惠卡 下載」產出 `~/Downloads/discounts_2026-07-07.csv`（1389 bytes）——**不含** unauthorized 錯誤字、表頭 12 欄正確（含「紅利已送」）、15 筆與畫面統計一致、狀態/格數/日期/館別皆正常。附帶確認：優惠卡「卡號(barcode)」欄為空屬正常（barcode 用於舊實體卡，一般 `discountCards` 無掃碼卡號）。
  - ✅ **瀏覽器實機下載驗證（黑卡）**：「黑卡 下載」產出 `~/Downloads/blacks_2026-07-07.csv`（340 bytes）——不含錯誤字、表頭 **11 欄**（**無「紅利已送」欄**，符黑卡規格）、3 筆與統計一致、原始格數皆 12、**到期日皆「無期限」**。黑卡**有卡號 barcode**（實體舊卡如 `A019-0001`/`BC-2024-00123`，練習卡才空），與優惠卡差異都對上規格。非缺陷觀察：少數卡「綁定日/館別」空＝來源資料未填 `boundAt`/`gymId`。

## 目前進度（2026-07-07 續）— 卡片效期規則：綁定/轉入無期限 + 移轉跟隨原卡
> 需求：黑卡綁定、優惠卡轉入取消一年期限（無期限）；購買優惠卡入場仍維持一年；點數移轉一律跟隨原卡效期。後端 `/health` `1.68.0`→`1.69.0`；E2E 8/8＋7/7。
- **現行效期規則總表**：綁定黑卡＝無期限｜轉入優惠卡＝無期限｜**購買優惠卡（入場/POS）＝一年**｜點數移轉＝**跟隨原卡效期（不自設）**。
- ✅ **綁定/轉入無期限（`1.68.0`，commit 後端 `eb22368`/前端 `710e051`）**：
  - `discountCardService.bindDiscountCard`（優惠卡轉入）：`expiresAt = null`（原本 1 年）；`purchaseDiscountCard` 維持 1 年。
  - 查證：**`bindBlackCard` 本就 `expiresAt:null`**（黑卡的 1 年只在移轉時才有）→ 黑卡綁定不用改。
  - 配套 null-safe：`useDiscountCard` 過期檢查、`getMemberDiscountCards` **移除 `orderBy('expiresAt')`**（Firestore 會把 null 卡排除、查不到）改記憶體排序＋null 過濾、transfer preview/return。前端優惠卡/黑卡 `expiresAt` 為 null → 顯示「無期限」（`CardsPage`/`MemberPassesPage`）。
  - E2E 8/8：轉入卡=null、購買卡≈+365天、無期限卡仍在清單、黑卡綁定=null。
- ✅ **移轉跟隨原卡效期（`1.69.0`，commit 後端 `da8cbc4`/前端 `409fc2b`）**：
  - **實際移轉走兩段式 `cardTransferService`（initiate→會員 App 接收），非** `transferDiscountCard`/`transferBlackCard`（那兩個是 dead code）。
  - `acceptTransfer` 黑卡分支：`targetExpiresAt || +1年` → **`targetExpiresAt || null`**（`targetExpiresAt = 原卡.expiresAt || null`）；優惠卡分支本就 `expiresAt: t.targetExpiresAt`。→ 綁定黑卡/轉入優惠卡（null）移轉子卡無期限；購買優惠卡（1年）移轉子卡繼承原卡到期日、不延長。
  - `legacyCardService` 黑卡移轉預覽：原卡無期限 → 接收方無期限（不再 +1 年）＋無期限 warning。
  - **E2E 7/7（完整 initiate→真會員接收 實測）**：綁定黑卡移轉子卡=無期限、轉入優惠卡移轉子卡=無期限、購買優惠卡移轉子卡≈+365天跟隨原卡。測試卡片＋`cardTransfers` 記錄硬刪清乾淨。

## 目前進度（2026-07-07 續）— 課程出缺席：入場自動標記 + 可點簽到 UI + CSV 下載
> 三部分：入場連動自動出席、員工端可點簽到、出缺席點名表 CSV。後端 `/health` `1.70.0`→`1.71.0`；E2E 8/8＋8/8；瀏覽器實機通過。
- ✅ **入場自動標記出席（`1.70.0`，後端 `2fd5ee6`）**：`courseService.markTodayCourseAttendanceOnEntry({memberId,gymId,staffId})`——撈 confirmed 未暫停報名 → 課程屬入場館別 → 今日場次(date===今天、非取消) → 該 (sessionId,memberId) **無出席紀錄才** `markAttendance present`（**不覆蓋**員工已標）。判斷基準是「今天有已報名場次」**與 entryType 無關**；全程 try/catch **不阻斷入場**。接入 `confirmCheckIn`(QR/direct) 與 `/checkin/phone`（建 checkIns＋墜測遞延後、lazy require 避免循環依賴）。E2E 8/8：入場→present、先標 absent 不被覆蓋、跨館不誤記。
- ✅ **可點簽到 UI（`1.71.0`，純前端 `CoursesPage`，commit `2bc1e98`）**：場次名單正取列唯讀標籤 → 三顆按鈕「出席/遲到/缺席」（當前狀態高亮），呼叫既有 `handleMarkAttendance(selectedSession.id, memberId, status)`（⚠ session id 用 `selectedSession.id` 非課程 id，否則標到別堂）；已取消場次禁用。瀏覽器實機：點「出席」即高亮綠、roster 即時刷新。
- ✅ **出缺席 CSV 下載（`1.71.0`，後端 `9c25e01`＋前端）**：`GET /courses/:courseId/attendance/download`（`courses.manage`）→ 點名矩陣：每列一位正取學員、每欄一場次(依日期)、格值 出席/缺席/遲到/空白 ＋ **出席次數小計**（present+late 計入）；姓名以 members 集合權威補齊；UTF-8 BOM；`filename course_attendance_<courseId>.csv`。前端名單標題「⬇ 下載出缺席」→ `downloadAttendanceCSV`（走 axios `client` blob、自動帶正確 token，檔名 `<課程名>_出缺席_<日期>.csv`）。E2E 8/8：矩陣/BOM/小計皆正確。

## 目前進度（2026-07-08）— 紅利使用期限改系統可設定
> 紅利（優惠卡用完→原購買者免費入場一次）原寫死 6 個月；改為 super_admin 於員工端可調。後端 `/health` `1.72.0-bonus-validity-configurable`；E2E 11/11。commit 後端 `31e905e`、前端 `2bd8e30`。
- **紅利期限規格備忘**：觸發＝優惠卡（新 `discount_card`／舊 `legacy_discount_card`）**所有次數用完** → 原購買者（`originalOwnerMemberId`）得一筆免費入場紅利（一次、兩館皆可）；到期＝**發出日 + N 個月**（`bonusService.triggerBonus`）；移轉繼承到期日不延長；過期由每日 `sweepExpiredBonuses` 標 `inactive`（保留文件）。
- ✅ **後端可設定**：`GET/PUT /settings/bonus`（`systemSettings/bonus.validityMonths`，PUT 限 `super_admin`/`admin`、值 1~60）；`bonusService.triggerBonus` 未帶 `validityMonths` 時讀 `getBonusValidityMonths()`（設定；讀不到/失敗 fallback 6）；discount/legacyDiscount 兩呼叫端移除寫死的 `6`。**只影響之後新發的紅利，既有不變**。
- ✅ **前端 UI 入口**：員工端 **⚙️ 系統設定 →「入場規則」群組 →「🎁 紅利期限」分頁（superAdminOnly）** → 填「紅利使用期限（個月）」1~60 → 儲存。（`SettingsPage`）
- **E2E 11/11**：設定 GET/PUT/驗證（0/61/abc→400）；設 3 個月 → 用完 1 格優惠卡入場觸發 → 紅利 `validityMonths=3`、到期 ≈+92 天（3 個月）。測後設定復原 6、練習資料清乾淨。

## 目前進度（2026-07-08）— 課程整期報名重複送出→重複報名+重複收費（真實事故）
> 回報：朱智萩報名「小蜘蛛人一A(7-8)」簽名送出後**一直跳回第一頁**。查明＝Modal 沒關使用者重複送出、後端整期報名無去重 → 被建 **3 批×8場=24 筆報名 + 3×NT$4,400 交易 + 場次人數灌 3 倍**。後端 `/health` `1.73.0-enroll-all-dedup`；E2E 4/4。commit 後端 `131c60e`、前端 `6c3f83b`。
- **根因（前端，真正根因）**：`MemberCoursesPage.resetEnrollModal` **漏 `setShowEnrollModal(false)`**——6/27 commit `5195852` 修「resetEnrollModal 自我遞迴崩潰」時，把原本應是關閉 Modal 的那行**整行刪掉**（原碼疑為 `setShowEnrollModal(false)` 誤打成 `resetEnrollModal()`）→ 送出成功後只重置步驟1、Modal 不關 → 使用者以為失敗重複送出、每次都成功。**修**：補回 `setShowEnrollModal(false)` + 清 `enrollSession`。
- **放大（後端）**：`POST /courses/:courseId/enroll-all` **完全沒查已報名**（單堂 `enroll` 本有 `ALREADY_ENROLLED` 防護、整期漏了）→ 每次呼叫都建整批+記帳。**修**：加「已 confirmed 報名此課程 → **409 `ALREADY_ENROLLED`**」。E2E 4/4（第一次 201、第二次 409、無重複）。
- **朱智萩資料清理**（firebase-admin）：報名 24→8（保留她最早、用**轉帳**那批；刪 16 筆誤觸）、交易 3→1（保留 transfer 4400、刪 2 筆重複 cash）、8 場次 `enrolledCount` 3→1。她正確狀態＝一整期(8場)、應繳 NT$4,400 轉帳待櫃檯確認（重複的都已作廢、無實收）。
- 💡 **教訓**：① 多步驟表單送出成功務必**關閉/離開 Modal**，只 reset 步驟會讓人重複送出；② **會員自助批次建立類端點（整期報名/多筆）一定要加去重防護**（前端擋不夠、後端才權威）；③ 診斷「跳回第一頁」先看 reset 函式有無關閉、再查是否已產生重複資料。
- ✅ **後續：報名成功跳出確認彈窗**（純前端 `MemberCoursesPage`，commit `34158ac`，member 已 deploy）：報名成功（非線上付款流程）→ `setEnrollSuccess` 彈窗「✅ 已報名成功／可至『我的課程』中查詢」＋按鈕「知道了」「前往我的課程」(`setTab('my')`)，取代原 3 秒自動消失 toast → 給明確成功回饋、進一步降低重複送出。⚠ 未瀏覽器實機（報名流程含簽名 canvas 難自動化、會建真資料）；掛在既有成功路徑、build 通過。

## 目前進度（2026-07-08 續）— 報名法定代理人簽名 + 多梯次依類別分組
- ✅ **法定代理人簽名改以「報名對象」判定未成年**（純前端 `MemberCoursesPage`，commit `e1a2c9c`，member 已 deploy）：原用登入者 `member?.isMinor` → 家長(成人)代未成年子女報名不出現監護人簽名欄。改 `targetIsMinor`（報名對象＝本人或所選子會員，取其 `isMinor`，無則由 `birthday` 算 <18），簽名欄顯示＋送出必填皆改用之。（未成年自己報名本就有此欄、不受影響。）
- ✅ **多梯次依「類別」分組（1.74.0，已上線）**：`courseService.getCourses` 補 `categoryName`（讀 `courseCategories` 對照，commit 後端 `6f40b18`）；`MemberCoursesPage` 課程總覽依 `categoryName` 分組成「類別名（N 梯）」區塊＋底下該類別梯次課程卡（commit 前端 `3f963bf`）。瀏覽器實機：「小蜘蛛人 3 梯」正常。⚠ **使用者回饋「這樣呈現不好」→ 要改兩層式**（見待辦）。

## 目前進度（2026-07-09）— 排班月曆顯示微調（純前端 `SchedulePage`）
- ✅ **全天班淡色填滿 + 排序**（commit `328e988`，staff 已 deploy）：排班月曆日格子——① 全天班（`type==='full_day'`）填滿改**員工色 25% 透明淡色塊**（`${staffColor}40`）＋員工色文字（原為實色填滿＋白字）；② 排序改「**全天班置頂**（同全天依 `staffName`）→ **自由時段(`custom`)依 `startTime` 先後上下排列**」。時段班維持外框樣式。瀏覽器實機確認三項到位。
- ✅ **月曆班別文字改粗體**（`fontWeight:700`，commit `65ab607`）。

## 目前進度（2026-07-09）— 排班通知（純後端）
> 排班/改班即時 + 值班前 2 天提醒，站內通知到**被排班員工的個人帳號**（`targetStaffId`）。前端不用改：員工個人待辦頁已渲染 `getUnreadNotifications(req.staff.id)`，純館別電腦 token 無 staffId 撈不到→天生只在員工個人帳號出現。後端 `/health` `1.75.0-shift-notifications`；E2E 11/11；commit `d1d1258`。
- ✅ **A. 排班/改班即時通知**（`scheduleService`，走 `notificationService.createNotification({targetStaffId,...})`，全程 try/catch 不阻斷排班）：
  - `createShift` → `shift_assigned`「新排班通知：你被排班：<date> <全天|start~end> @ <館名>」。
  - `createRecurringShifts` → **只發一則彙總** `shift_assigned`「你被排定 <rangeStart>~<rangeEnd> 每週 <weekdays> …共 N 個班」（**避免一班一則洗版**）；`createdCount===0` 不發。
  - `updateShift` → 對目前 `staffId` 發 `shift_updated`；**換人（staffId 變更）另通知原 staffId**「你的 <date> 班已被調整（改由他人值班）」。
- ✅ **B. 值班前 2 天提醒**（`scheduleService.runShiftReminders`，掛進 `index.js` 每日 9 點排程）：查 `SCHEDULE_SHIFTS` 中 `date===taiwanToday()+2` 的班發 `shift_reminder`「後天(<date>)有班：…」；**`reminderSentAt` 旗標冪等**防重送（比照分期 adminNotifiedAt）。
- **E2E 11/11**：createShift 1 則、recurring 8 班只發 1 則彙總、改時間/換人通知皆正確、runShiftReminders 發送+標記+重跑 skipped 不重送。測試員工/班次/通知清乾淨。
- ⚠️ **E2E 附帶（非 bug）**：`runShiftReminders` 打正式 Firestore 跑，`今天+2` 那天含 3 位真實員工真實班次 → 他們**現時就收到各自的正確「值班提醒」**（＝該功能該做的事、只是由 E2E 提早觸發、`reminderSentAt` 已標記不重送），無害。
- ✅ **待辦頁通知面板加「排班」類別**（純前端 `PendingTasksPage`，commit `2e24c18`，staff 已 deploy）：`NOTIF_CAT` 加 `shift_assigned/updated/reminder → 'shift'`，`NOTIF_CATS` 加 `{key:'shift',label:'排班'}`（置「全部」後）。員工個人待辦頁「🔔 通知」面板即可用「排班」chip 單獨過濾（原本落在「系統」）。

## 目前進度（2026-07-09 續）— 課程總覽多梯次兩層式 + BeClass 課程介紹擷取（純前端 `redrock-web`）
> 承 7/8 待辦。使用者回答兩題後定案：① 梯次列欄位＝班別名/星期時間/開課迄日/教練/名額(剩N位或額滿)/價格/類型（**加了名額、教練**）② **只有一梯的課點卡直接進報名、跳過中間層**。
- ✅ **多梯次兩層式**（`MemberCoursesPage` 課程總覽 browse，commit `a9ebbdd`，member 已 deploy＋push）：原「每梯次一張大卡平鋪」→ 改**兩層**：
  - **第一層**（依 `categoryName` 分組，`其他` 墊底）：一課(類別)一張卡，顯示 類別名／價格範圍(min~max)／類型(週課/工作坊)／可分期 tag。**只有一梯者卡片右上顯「報名 ›」點卡直接 `setSelectedCourse`（跳過中間層）**；多梯顯「N 梯 ›」點卡進第二層。
  - **第二層**（`selectedCategory` 狀態，← 返回類別）：列該類別各梯次，每列＝班別名／🗓每週星期時間／📅開課迄日／👟教練＋名額(`enrolledCount/maxStudents`)／NT$價格／類型／可分期；右上**額滿**(`statusLabel==='full'`或剩0)或綠**剩 N 位**。點列 `setSelectedCourse` 進既有報名場次頁（報名頁「←」因 `selectedCategory` 仍在→回第二層；單梯 skip 時 `selectedCategory` 為 null→回第一層）。
  - 館別 chip 僅第一層顯示、切館一併 `setSelectedCategory(null)`。名額/額滿資料來自 `courseService.getCourses` 既有 `enrolledCount`(distinct 報名人數)/`maxStudents`/`statusLabel`。
- ✅ **BeClass 課程介紹擷取（供貼入「說明」欄）**：WebFetch 抓 `beclass.com/rid=294fdfc677e66cbc1072` →「小蜘蛛人 2026 7-8月」課程介紹（宗旨/適合對象 5–12歲/課程內容/三期制安排）整理成純文字回給使用者自行貼入課程 `description`。**尚未寫入 DB**——待使用者決定要套用到哪些課程（可 `PUT /courses/:id` 批次填入小蜘蛛人各梯 `description`）。

## 目前進度（2026-07-09 續）— 課程海報圖片（Firebase Storage）
> 承 7/8 待辦②。使用者要「抓小蜘蛛人的圖片」放進課程。走 Storage（非 base64，海報常超 1MB）。後端 `/health` `1.76.0-course-image`；commit 後端 `8b052b7`、前端 `4b6aab7`；兩端已 deploy。
- ✅ **後端**（`courses.js` + `courseService.js`）：course 加 `imageUrl` 欄；`PUT /courses/:id` allowedFields 加 `imageUrl`；新增 `POST /courses/:courseId/image`（`courses.manage`，`multer` memoryStorage → `getStorage().bucket().file().save()` → `getSignedUrl` expires 2035 → 寫入課程 `imageUrl` 並回傳；非圖片檔擋 `NOT_IMAGE`）。
- ✅ **會員端**（`MemberCoursesPage`）：**類別卡頂部**（`g.map(c=>c.imageUrl).find(Boolean)`，program 級同類別共用）＋**課程詳情**顯示海報；詳情另補顯示 `description`（說明，`pre-wrap`）。
- ✅ **員工端**（`CoursesPage` 編輯 Modal）：加「課程海報」區——預覽 + 上傳/更換（即傳即存，`POST /courses/:id/image`）+ 移除（改 `editForm.imageUrl=''`、按儲存才寫）。
- 🐞 **附帶修 latent bug**：`CoursesPage.jsx` 用了 `client.get/put`（下載出缺席 CSV `aedff18`前後、名單 roster、max-leaves）但**從未 import `client`** → 那三條路徑本會 `ReferenceError`（各自 try/catch 吞成「下載失敗/載入失敗」）。補 `import client from '../../api/client'`。
- ✅ **小蜘蛛人海報已上線**：WebFetch 抓 `beclass.com/rid=294fdfc677e66cbc1072` 主視覺「攀岩的好處」infographic（850×699 JPEG，RedRock 自有）→ 打 `POST /courses/.../image` 掛到真實課程 `小蜘蛛人一A(7-8)閎`（`3f35216f…`）；驗證 `imageUrl` 已存、圖 http 200 可抓（62838 bytes）。**Storage getSignedUrl 在 Railway 正常**（`FIREBASE_PRIVATE_KEY` 本地簽章，同 `/pass-adjustments/evidence`）。
- 📌 BeClass「說明」文字先前已擷取（見前一段），使用者最後決定**只抓圖片**、說明暫不自動寫入 DB（可自行貼）。

## 目前進度（2026-07-09 續）— 依 BeClass 建 10 門小蜘蛛人真實梯次 + 週課名額/候補控管
> 使用者澄清：先前掛海報到【練習】是錯的，正解＝**依 BeClass 報名表建真實梯次**（新竹館 only）。指示：一A 不用管（之後自刪）、另建 10 梯、maxStudents 預設 6、候補上限預設 2（可留空）、兩門練習直接刪。後端 `/health` `1.77.0-course-waitlist-cap`；commit 後端 `73d895d`、前端 `b7cc4d4`；waitlist E2E 8/8。
- ✅ **候補上限 `maxWaitlist` 欄位**（`courseService`/`courses.js`）：`null`＝不限候補、`0`＝不開放、正整數＝候補名額。`POST /courses` validator optional、`PUT` 允許並正規化（`''`→null）。前端 `CoursesPage` 建立/編輯/複製表單加「候補上限（留空＝不限、0＝不開放）」欄；**建立表單 maxStudents 預設 6、maxWaitlist 預設 2**。
- ✅ **週課名額/候補控管（原本零控管！）**：`POST /courses/:id/enroll-all` 原本報名一律 `confirmed`、`maxStudents` 只影響 UI 不擋人。補：以「整門課不重複會員數」為準——滿 `maxStudents`→進**候補**（`waitlist`，不收費/不記帳、佔 `waitlistCount`、`waitlistPosition`）；候補也滿(`maxWaitlist`)→擋 `409 COURSE_FULL`；**遞補為正取後才收費（店員手動）**。去重擋改含 waitlist。workshop 單場 `enrollSession` 亦補候補上限擋（`WAITLIST_FULL`）。
  - ⚠️ **週課候補遞補為手動**：per-session 有 `promoteWaitlist`，但**整門課候補→正取自動遞補未接**；候補者付款也待遞補後由店員處理。（本次範圍：控管+擋人+不誤收，遞補自動化屬後續。）
- ✅ **建 10 門真實梯次**（新竹館・類別小蜘蛛人・海報＋說明・maxStudents 6・maxWaitlist 2）：週一A(9堂4950)/週二A・B(8堂4400)/週三A・B進階(9堂4950)/週五A・B(8堂4400)/週六A・B進階(8堂4400)/週日A(8堂4400)；`POST /courses`＋`generate-sessions`，**場次數全部對上預期**。腳本 `scratchpad/create-spider-cohorts.mjs`。
- ✅ **刪兩門練習**（`2afece80`、`345bab45`）`DELETE /permanent`。現「小蜘蛛人」類別＝10 真實梯 + `小蜘蛛人一A(7-8)閎`（使用者留著待自刪）。
- **waitlist E2E 8/8**（`scratchpad/waitlist-e2e.mjs`，throwaway 課 max1/wait1）：第1位正取→第2位候補#1(fee=0)→第3位 `COURSE_FULL`→重複 `ALREADY_ENROLLED`→場次計數 正取1/候補1；測後硬刪清乾淨。

## 目前進度（2026-07-09 續）— 課程剩餘名額對齊 BeClass（reservedSlots）
> 使用者：剩餘名額要照 BeClass 報名表實際顯示（例 週日A 剩 0＝已滿）。這些梯次是搬遷、已有人佔位。後端 `/health` `1.78.0-course-reserved-slots`；commit 後端 `fdb42c5`、前端 `2092536`。
- ✅ **`reservedSlots` 欄位**（外部帶入的已佔用正取名額）：`getCourses` 回傳 `enrolledCount = 實報名 + reservedSlots`（另回 `realEnrolled`），故會員/員工顯示「剩餘、額滿」正確；`computeStatusLabel` 一併吃到。`enroll-all` 名額判斷改 `confirmedMembers + reservedSlots >= maxStudents`（滿→候補/`COURSE_FULL`）。create 預設 0、`PUT` 可調；`CoursesPage` 建立/編輯表單加「已佔用名額」欄。
- ✅ **10 梯 reservedSlots 已設**（= maxStudents 6 − BeClass 剩餘）：週一A剩3/週二A剩6/週二B剩4/週三A剩5/週三B剩2/週五A剩6/週五B剩5/週六A剩4/週六B剩4/**週日A剩0(額滿)**——驗證回傳剩餘與 BeClass 完全一致。
  - 註：這 10 梯 startDate 為 7/1–7/6（相對系統今日 7/9 已開始）→ `statusLabel` 顯示 `ongoing`；會員報名即走**插班**比例計費（符合搬遷中途課實況）。週日A remaining=0 → 會員端顯示「額滿」。
- ⚠️ **reservedSlots 是靜態帶入值**：實際 BeClass 報名數變動不會同步；之後有真人報名，remaining 會在 reserved 基礎上再減。要調整佔用數到員工端課程編輯改「已佔用名額」。

## 目前進度（2026-07-09 續）— 課程總覽微調 + 全系統段落置左盤點
> 兩件事。前端 `redrock-web`，member/staff 皆 deploy。
- ✅ **課程總覽多梯次微調**（`MemberCoursesPage`，commit `e4a24be`；瀏覽器實機驗證通過）：
  - **梯次依週一→週日排序**（週日排最後 `weekday 0→7`），同日再依開始時間。
  - **名額只顯示剩餘**（拿掉「已報名/上限」比例），保留「剩 N 位／額滿」徽章。
  - **流程改**：第一層類別卡**移除海報**（改點進去才顯示）；點進類別**先看到海報＋課程說明**（左對齊）再列各梯；**點入梯次後不再重複顯示說明**（梯次 detail 移除 description 區塊，保留海報＋時段＋報名）。
  - 10 梯**教練**已補（`PUT instructor`）：週一A=閎聿、週日A=品翰、其餘=晉瑋（依 BeClass 報名表師資）。
- ✅ **全系統「段落內文置左、標題置中」盤點**（commit `835ff9b`；三支平行 subagent 掃 member/staff/components）：把置中的**段落/描述/提醒/條款類內文**改 `textAlign:left`，**保留**標題/空狀態/按鈕/徽章/數字置中。實改 10 檔 12 處（會員 Waiver/Register/Login/Forgot/QR/Parent waiver 說明與提醒、員工 Checkin 統計提示 & DailySettlement 限制說明、元件 OnboardingGate 卡片內文）。`SettingsPage` 轉換頁先前已左對齊、無需改。**規則已存記憶** `[[ui-text-alignment]]`：日後新畫面段落一律置左、只有標題置中。

## 目前進度（2026-07-09 續）— 額滿課程報名顯示候補提醒、不問繳費
> 回報：小蜘蛛人週日班已額滿、可報名候補，但報名時**沒有任何提醒、且直接問繳費方式**。純前端 `MemberCoursesPage`，commit `6e23ed8`，member 已 deploy＋瀏覽器實機驗證通過。
- ✅ **週課 detail 名額滿偵測**：`isCourseFull = statusLabel==='full' || (maxStudents − enrolledCount) <= 0`（`enrolledCount` 已含 `reservedSlots`）。滿時：顯示**候補提醒橫幅**（「正取已額滿，報名將加入候補、候補期間不需付款、遞補為正取後另行通知繳費」）、價格標「（遞補後收費）」、按鈕改**「加入候補名單」**（琥珀色）；`enrollSession.isWaitlist=true`。
- ✅ **報名 Modal 候補化**：`isWaitlist` 時——標題「候補報名」、步驟1 標籤「候補說明」、**付款區塊改候補說明**（不顯示 `PaymentPlanChoice`/`PaymentSection`/繳費方式，只說明遞補後才收費＋約略金額）、送出鈕「✓ 確認加入候補」、成功彈窗改「已加入候補名單」文案。`handleEnroll` 依 `res.data.isWaitlist` 設 flag、候補**不觸發轉帳上傳**。
- **實機驗證**：週日A班 detail 顯示候補橫幅＋「加入候補名單」；點入 Modal 顯示「候補報名 — 小蜘蛛人 週日A班」、候補說明（遞補後約 NT$3,850）、無繳費欄位。未實際送出（避免建真資料）。
- ⚠️ 沿用先前缺口：**週課候補→正取自動遞補仍為手動**（見下方待辦）。workshop 單場額滿在會員端仍為 disabled（不開放候補 UI），非本次範圍。

## 目前進度（2026-07-09 續）— 我的課程候補顯示 + 取消候補
> 回報：報名已額滿課程（候補）後，「我的課程」仍顯示「已報名」且出現正取功能（請假/退費/暫停）。要顯示候補狀態、隱藏非正式學員功能，並可「取消候補」。後端 `/health` `1.79.0-cancel-waitlist`；commit 後端 `c9315a3`、前端 `b2469bb`；正式 API E2E＋瀏覽器實機驗證通過。
- ✅ **候補群組顯示**（`MemberCoursesPage` 我的課程）：`isWaitlistGroup = 無 confirmed/leave 且有 waitlist`——徽章改**「候補中・第 N 位」**（琥珀）、資訊列改候補說明（左對齊）、**隱藏 請假/申請退費/申請暫停**、改顯示**「取消候補」**。另**全數已取消/失效的群組不再顯示幽靈卡**（`confirmed+leave+waitlist===0` → 不 render）。
- ✅ **取消候補端點**（後端 `POST /courses/:courseId/cancel-waitlist`，`authenticateAny`）：驗擁有權（本人/子女）→ 將該會員此課程 `status:'waitlist'` 報名標 `cancelled` + 場次 `waitlistCount-1`；無候補回 404 `NO_WAITLIST`。前端 `handleCancelWaitlist`（`window.confirm` 確認）。
- **E2E（打 Railway，林怡君）**：報名 週日A(額滿) → `isWaitlist=true` pos2 fee0、7 筆 waitlist 場次 → `/member/enrollments` 顯示候補 → `cancel-waitlist` 取消 7 筆 → 0 筆殘留。瀏覽器：我的課程顯示「候補中・第2位」＋候補說明＋「取消候補」、無退費/暫停/請假。測試資料已清。
- ✅ **取消候補改自訂確認 Modal**（commit 前端 `2a8789a`→`51e95f7`）：`window.confirm` → 自訂 Modal（標題/說明置左、「返回」/「確定取消」紅鈕），與專案他處一致；成功後**樂觀移除該課候補列**（`setMyEnrollments` filter）避免 Firestore 讀寫延遲卡片短暫殘留，再 `loadMyEnrollments` reconcile。瀏覽器實機：候補卡 → 取消候補 → 自訂確認 → 確定取消 → 綠「已取消候補」＋卡片即時消失。

## 目前進度（2026-07-09 續）— 修 Firebase Hosting 快取（部署後自動載新版）
> 長期痛點：`firebase deploy` 後常拿到舊 bundle、需手動硬重載/`?v=`。從源頭修：`redrock-web/firebase.json` 兩站加 `headers`。commit 前端 `4fc121f`，已 deploy＋curl 驗證。
- ✅ **`index.html`**：`Cache-Control: no-cache, must-revalidate`（每次重新驗證 → 部署後**自動載新版**，仍走 ETag 304 不浪費流量）。
- ✅ **`/assets/**`**（Vite 內容雜湊檔）：`public, max-age=31536000, immutable`（永久快取、載入快；改版檔名變自動失效）。
- 🐞 **補修真正漏洞（commit `7807562`）**：第一版 header `source:'/index.html'` **只匹配字面路徑**——直接開 `/staff/activities`、`/member/courses` 等 SPA 路由時，Firebase 經 rewrite 回 index.html 內容卻套預設 `max-age=3600`（仍快取 1 小時→舊版）。改 `source:'**'` no-cache（`/assets/**` immutable 列後覆蓋）。curl 驗證：路由（含自訂網域 `staff.redrocktaiwan.com/staff/activities`）皆 `no-cache`、雜湊資產 `immutable`。
- ⚠️ **這次修復部署前就已快取的舊頁** 仍需最後一次硬重載/`?v=` 才生效，之後自動；**PWA 主畫面圖示**快取更頑固，改版需刪圖示重加。
- 記憶 [[testing-live-system]] 已更新（原「部署後需硬重載」改為「已從源頭修、一般不需」）。

## 目前進度（2026-07-09 續）— 我的課程含子女報名（家長帳號）
> 回報：朱智萩幫家庭成員王登第報名課程，在「我的課程」看不到。查明＝**我的課程只載入登入者本人的報名**（`/courses/member/{本人id}/enrollments`），子女報名 memberId 是子女→不顯示。後端 `/health` `1.81.0-enroll-target-name`；commit 後端 `ef19b5b`＋`81f3a79`、前端 `49464c4`＋`df432b7`；瀏覽器實機驗證通過。
- 🔍 **資料現況**：朱智萩(`d633effc`) 名下＝一A confirmed×8＋週日A **waitlist×7**；子女 王登第(`17f4cf6c`)＝週二B confirmed×7＋週三B(進階) confirmed×7。修好後朱智萩「我的課程」會看到自己 2 筆＋王登第 2 筆（標「👦 王登第」）。
- ✅ **顯示子女報名**（`MemberCoursesPage`）：`loadMyEnrollments` 改**一併載入子女報名**（`/members/my/children` → 各自 `/courses/member/:id/enrollments` 合併）；分組 key 改 **`courseId+memberId`**（家長與子女同課不合併，`expandedCourseId`/React key/退費暫停旗標同步改 composite）；子女課卡標 **「👦 <子女名>」**（姓名以家庭成員清單解析，不信 `enrollment.memberName`）。
- ✅ **退費/暫停/請假支援家長代子女**：後端 `course-adjustments` refund/pause-request 與 `courses` leave 改 `memberId = body.memberId||本人` ＋ `checkMemberOwnership`（原用 `req.member.id`→查無子女報名 404/FORBIDDEN）；前端退費/暫停/請假帶 `group.memberId`。
- 🐞 **附帶修**：`enroll-all` 儲存 `memberName` 原 `req.member.name` 優先 → 子女報名存成**家長名**。改 `req.body.memberName||req.member.name`（前端本就傳子女名）。既有錯名資料：**staff roster 本就以 members 集合權威解析姓名（`getSessionRoster:845`）顯示不受影響**；會員端標籤已改為查家庭成員清單，故既有資料也正確顯示。
- **驗證**：以可控帳號林怡君＋其子女 `test` 報 週五A → 我的課程顯示「小蜘蛛人 週五A班 👦 test」＋退費/暫停/請假；測試報名已 firebase-admin 硬刪清乾淨（含場次 enrolledCount 回復）。

## 目前進度（2026-07-09 續）— 會員月曆只顯示自己報名 + 我的課程 tab 改「N 門進行中」
> 兩項純前端（`MemberCoursesPage`），commit `1802771`，member 已 deploy。
- ✅ **我的課程 tab 標籤**：原 `(${myEnrollments.length})` ＝**報名場次列數**（每堂一列、含 cancelled 殘列→數字虛高，如 33）。改 **`(N 門進行中)`**：以「課程＋報名對象」分組、計有效報名(confirmed/leave/waitlist)且未結束（有候補或 date≥今日場次）的**門數**。實機驗證：林怡君子女報 1 門 → 顯示「我的課程 (1 門進行中)」。
- ✅ **會員月曆只顯示自己（含子女）報名的課程**：`loadCalendarSessions` 原抓全館 `/courses/sessions` 全部顯示（僅標記有無報名）→ 改**帶子女報名建 enrollMap（僅 confirmed/leave/waitlist）並 `filter(s => enrollMap[s.id])`**，只留有報名的場次。體驗預約/競賽本就是本人資料、保留。
  - ⚠️ 月曆網格瀏覽器截圖驗證未完成（Chrome 擴充當下 screenshot/read_page 回鏈結錯誤/0x0）；改動為單純 filter、tab 門數已實機確認，程式邏輯確定。
- 測試（林怡君子女 test 報 週五A）已 firebase-admin 硬刪清乾淨。

## 目前進度（2026-07-09 續）— 課程報名收款核對（現金也走待收款、分角色）
> 回報：報名課程應經管理員核對，但只收到通知、點查看進到課程總覽。定調：①課程端隱藏電子支付 ②報名通知查看→待辦頁待收款 ③現金由值班 operator 確認、匯款由管理員確認 ④**櫃檯現金也進待收款**（使用者「進待收款」）。後端 `/health` `1.82.0-course-cash-collection`；E2E（打 Railway）通過。
- **重要前提（先查清楚才動）**：課程營收是 **accrual**——`enroll-all` 報名當下就 `recordTransaction`（認列在最後一堂），`轉帳確認收款`只是把 enrollment 標 `paymentConfirmed:true`（`transfers.js:118`），**不重複記帳**。故本次**不動營收記帳時機**，只補「收款確認（待收款）」這層追蹤。
- ✅ **① 課程端隱藏電子支付**（前端）：`PaymentSection` 加 `methods` prop；會員課程報名 modal 傳 `['cash','transfer']`（只留現金/轉帳，藏 LinePay/街口/台灣Pay）。commit `53493d8`。
- ✅ **② 現金也走待收款**（後端 `enroll-all`）：`paymentMethod==='cash'`（且非候補/分期/deferPayment、fee>0）→ 建 `transferRecords{orderType:'course', paymentMethod:'cash', status:'pending', amount:fee}`。轉帳的待收款仍由前端 `/transfers/upload` 建（不重複）。
- ✅ **③ 待收款分角色確認**：`PUT /transfers/:id/confirm` 依 `record.paymentMethod` gate——**現金→值班 operator 或管理員**（`type∈[operator,station]` 或 `role∈[super_admin,gym_manager]`）、**轉帳→僅管理員**。`pending-tasks` 待收款帶 `method`＋標題「現金待收款／轉帳待確認收款」。前端 `PendingTasksPage` 對應顯示 gate（無權淡化「需值班或管理員確認／需管理員確認」）；`TransferConfirmModal` 現金顯示「確認現金收款」、隱藏匯款欄位/截圖。
- ✅ **④ 報名通知「查看」→ 待辦頁**：`pending-tasks` 課程報名 `link` 由 `/staff/courses` 改 `/staff/pending-tasks`（原本點查看進到課程總覽的問題）。
- **E2E**：會員報子女(現金 3850) → `/pending-tasks` 出現「現金待收款」method:cash → admin `PUT /confirm` 成功、待收款消失。測試 enrollment/transferRecord/**transaction** 全 firebase-admin 硬刪清乾淨。
- ⛔ **分期不變**：分期第一期維持既有 installment 計畫流程（未納入待收款）。commit 後端 `a253c4d`、前端 `53493d8`＋`72d06cb`。
- ✅ **回填舊未確認報名（一次性）**：改版前的報名不會自動出現在待收款（無 transferRecords）。應要求回填 3 筆為**現金**待收款：朱智萩 週一A班(4400)、王登第 週二B班(3850,原LinePay)、王登第 週三B班(3850,原街口)。firebase-admin 建 `transferRecords{paymentMethod:cash, origPaymentMethod, notes, backfilled:true, createdAt=原報名時間}`。**test 練習課(#1周銷售/#3張元賓) 不回填**。
- ✅ **確認彈窗顯示報名資料供核對**（`TransferConfirmModal`，commit `3ba0559`）：加「原報名選」(`origPaymentMethod`，如原選街口/LinePay)＋備註(`notes`)顯示；現金隱藏匯款欄位、轉帳顯示匯款銀行/末五碼/日期/截圖。滿足「點進去看到當初報名資料才能核對金額/匯款」。
- ⚠️ 回填的 3 筆現在是 pending 待收款，等值班 operator／管理員實際收款後「確認收款」。
- ✅ **實機驗證（staff.redrocktaiwan.com，super_admin）**：待辦頁「💰 待收款」顯示 3 筆現金待收款（王登第 週二B/週三B、朱智萩 週一A）＋確認/退回鈕；點確認彈窗＝「💵 確認現金收款」顯示 會員/課程/金額 3850/付款現金/**原報名選 LinePay**/報名時間/📝備註 → 符合「核對金額+看報名資料」。未真的按確認（待實際收款）。
- ✅ **附帶修徽章**（`PendingTasksPage`，commit `8b75079`）：現金待收款徽章原顯示「轉帳確認」→ 依 `task.method==='cash'` 改「💵 現金確認」。

## 目前進度（2026-07-09 續）— 員工課程列表改兩層（比照會員端）
> 需求：staff 課程頁也要分兩層——先課程總頁（類別），第二層才各梯資訊。純前端 `CoursesPage`，commit `939f4c5`，staff 已 deploy＋瀏覽器實機驗證。
- ✅ **兩層結構**（`tab==='courses'`，新增 `selectedCategory` state）：**第一層** 依 `categoryName` 分組一卡（類別名／`N 梯 ›`／價格範圍 min~max／正取合計 enrolled/cap／含已停用註記）；**第二層**（← 返回課程總頁）列該類別各梯次卡，**保留原有動作**（編輯／停用⇄啟用／取消課程／查看名單／刪除、點卡進場次管理）。無類別歸「其他」。
- **實機驗證**：課程總頁顯示「小蜘蛛人 11梯 NT$4,400~4,950 正取25/66」＋「其他 1梯」→ 點小蜘蛛人 → 11 個梯次卡（週日A/週六B進階/…）動作齊全。
- ✅ **修：員工課程頁 super_admin 未依館別過濾**（commit `31242ba`＋`7ea6c3b`）：回報「士林館的小蜘蛛人課程要移除」→ 查明**士林館 0 門小蜘蛛人**（全 11 門在新竹館），會看到是因為 `CoursesPage` 兩個 bug：① `loadCourses` useEffect 空依賴、切館別不重載 ② `effectiveGymId = activeGymId||staff.gymId` **漏了 super_admin 的 `viewGym`**（頂部檢視場館選單走 viewGym，非 activeGymId）→ super_admin 恆 null→getCourses(all)→顯示全館課程。修：`effectiveGymId` 補 `(isSuperAdmin ? viewGym : '')`＋useEffect 依賴 `effectiveGymId`（切館重載+回類別總頁）。實機驗證：切士林館→只剩「其他 1 梯」、小蜘蛛人消失；切新竹館→11 梯回來。（比照 CheckinPage 的 viewGym 用法。）
- ✅ **銷售紀錄每品項列各館+倉庫存貨（0 紅字）**（純前端 `SalesPage`，commit `e29f39c`）：每筆銷售的每個品項下方顯示「存貨 新竹館 X 士林館 Y 倉庫 Z」——依 item 的 `productId/variantId` 從 `products` state 找變體、讀 `variant.gymStock[gymId]` 與 `variant.warehouseStock`（`getProducts` 回傳 variant 有帶這兩欄）；數量 **0 以紅色粗體**。另**品項顯示品牌**（`i.brand` 前綴，commit `72a580f`）。實機驗證：「Mad Rock Drifter US9×1　存貨 新竹館 **0** 士林館 2 倉庫 **0**」（0 紅字）。
- ✅ **修：商品銷售頁「銷售紀錄」白屏**（純前端 `SalesPage`，commit `67fb2b9`）：回報點「銷售紀錄」白屏。console 抓到 `ReferenceError: dayjs is not defined`——`SalesPage.jsx` line 626 用 `dayjs(sale.soldAt…)` 但**整個檔案沒 import dayjs** → 有銷售紀錄時 render 崩潰白屏（0 筆則顯示空狀態、不崩）。補 `import dayjs`。附帶修**日期 Invalid Date**（commit `2e03843`）：`soldAt` Firestore timestamp 序列化為 `{_seconds}`，原只讀 `.seconds` → 補 `_seconds` fallback。實機驗證：銷售紀錄正常顯示「07/09 17:58 · 王潔 · 現金 · NT$2,480 · Drifter US9×1」。
- ✅ **墜測過期列入員工端顯示**（後端 `/health` `1.84.0`，commit `06a837e`／前端 `238b332`）：回報「過期會員 App 會被 gate 擋（顯示請安排墜測），但員工端／`getBlockReasons` 不顯示」。原 `getBlockReasons` 墜測只看「從未通過」；改：曾通過但**所有 passed 紀錄皆過期** → 加 **`fall_test_expired`**（效期比照 `calcFallTestStatus` 的 `currentExpiresAt||expiresAt`）。前端 `MembersPage` 待完成事項加標籤「墜測已過期・待重新測驗」。**不影響**：入場（`runEntryGates` 權威、依效期即時擋）、登入（不看 blockReasons）、App onboarding gate（`/auth/member/me` 另算 waiver、墜測走 `getMyFallTestStatus`）。副作用：`isBlocked` 對過期會員變 true（CSV 狀態欄顯示「封鎖」）。實機驗證：`【練習】林志明墜測過期`(到期2026-06-02) → `GET /members/:id` 回 `blockReasons:['fall_test_expired'] isBlocked:true`。
- ✅ **修：super_admin 建課場次 gymId=null → 月曆看不到**（後端 `/health` `1.83.0`，commit `da4f47d`）：回報「成人入門班在月曆看不到」。根因＝`createWeeklySessions` 用 caller 傳的 `gymId`（super_admin 的 `req.staff.gymId` 為 null）→ 場次 `gymId:null`，月曆依館別過濾→排除。修：`gymId = gymId || course.gymId || null`。回填現有 null 場次 gymId＝其課程 gymId（17 筆，含成人入門班(7-8) 8 堂→gym-hsinchu）。實機驗證：新竹館月曆週一出現「成人入門班(7-8) 👟閎聿」。
  - ⚠️ **殘留**：另有一門「成人入門班」`cd430bd3` **課程本身 gymId=null**（重複/誤建）→ 8 場次仍 null、哪館都不顯示。待使用者決定刪除或指定館別。
- ✅ **員工課程月曆日格顯示各場次資訊**（commit `9db8386`）：原日格只「N堂·M人」→ 改逐場次（依開始時間）列出 **課程名稱＋👟教練·報名人數**（`registeredCount ?? enrolledCount`）；日格 minHeight 74→90。實機驗證：7/1 顯示「小蜘蛛人 週三A班 👟晉瑋·0人／週三B班(進階) 👟晉瑋」、週日 👟品翰、週一 👟閎聿。（人數為該場次實際報名數；課程卡的人數含 reservedSlots，兩者定義不同。）
- ✅ **新增課程也改兩步**（`createStep` state，commit `a417aac`→`8ff0ddb`）：**步驟1＝課程通用資訊**（同門課各梯共用性質）＝類別＋類型＋館別＋複製 ＋ **課程名稱/課程說明/課程海報(建立後上傳)/插班加成/請假截止/整期可請假次數/補課期限/退費每堂扣除/退費手續費率/開放補課/開放試上(+試上費)/是否分期**；**步驟2＝此梯次專屬**＝費用/最多人數(正取)/候補上限/已佔用名額/入館天數/課程起訖日/上課時段/教練/上課星期。頂部顯示「類別 · 類型 · 名稱」。從某類別第二層按新增會**預帶該類別**；super_admin 未選館別 / 未填名稱擋下一步。海報用 `createImageFile` state，建立成功後 `POST /courses/:id/image`（失敗不阻斷）。實機驗證：步驟1填通用+海報→下一步→步驟2只剩梯次專屬欄位。

## 目前進度（2026-07-09 續）— 每日結帳強化（暫存檔 / 完成結帳確認 modal / 多段發票 / 當日再次結帳）
> 四項一起做：後端 `/health` `1.85.0-settlement-draft-resettle-segments`（commit `edd6bd5`）＋前端（commit `249072d`，兩 target build＋firebase deploy）。金額一律**後端權威**、modal 僅前端預覽。後端 E2E（假館 `gym-e2e-test`，測後 DELETE）全綠；前端瀏覽器實機驗證（走「當日再次結帳」預填→確認 modal→取消，不動真實結帳）。
- ✅ **(1) 暫存檔（draft）**：新增 `PUT /daily-settlements/draft`（`requireStationAuth`）——upsert 今日 gym+date 一筆 `status:'draft'`，**不擋 ALREADY_SETTLED、不發差異通知**；已是 `settled` 則回 `{alreadySettled:true}` 不覆寫。`GET /today` 擴充：無正式結帳但有 draft → 回 `{settlement, draft:{...}}`。前端「💾 存暫存檔」→ PUT draft 顯示「已暫存」；進頁 `loadToday` 從 `res.data.draft` 預填（點鈔/加減項/多段發票/作廢/卡號/備註/手動輸入，showMsg「已載入暫存檔」）。
- ✅ **(2) 完成結帳確認 modal（純前端）**：「完成結帳」不再直接送出 → 先跳 `Modal`（`src/components/Modal.jsx`）顯示 `SettlementSummary` 五項（下同）；「確認結帳」才 POST、「取消」關閉。
- **結帳摘要五項（確認 modal 與「今日已結帳」畫面共用同一元件、同順序，千分位＋NT$）**：① **發票總金額**＝收入項加總（`settlementManualInput` 開啟時用 incomeManual 加總、**不從發票號推算**）② **加減項**（每列 ±號/類型/金額/備註 ＋ 淨額小計，無則「無」）③ **實際現金**（點鈔加總）④ **差異**＝實際−預期，`abs>200` 紅字＋「⚠將通知管理員」⑤ **發票起末號碼**（多段逐段列 ＋ 作廢號碼）。
- ✅ **(3) 更換/新增發票序號（多段）**：資料模型 `invoiceSegments:[{start,last}]`。POST/PUT/draft 收陣列；**向下相容**仍寫 `invoiceStartNumber=首段.start`、`invoiceLastNumber=末段.last`；`voidNumbers` 共用。`invoice-export` 逐段各出一列（當日總計如客次/發票總額/作廢/卡片只掛首段列），無 segments 才 fallback 舊單段。前端多段列（第N段 start～last、>1 可✕）＋「＋新增發票序號」（自動帶前段 last+1）；至少一段、末段的 last 必填。
- ✅ **(4) 當日再次結帳**：POST 移除 `ALREADY_SETTLED` 硬擋 → 已結帳則**更新同一 doc**（一天一 doc 供月報/發票）：舊狀態 push 進 `revisions[]`、更新欄位＋`settledAt`＋`staffId`＋`resettleCount+1`＋選填 `resettleReason`。差異/前日餘額**以前一天為基準**（非自身）；差異>200 重新通知。前端已結帳畫面「🔁 當日再次結帳」→ 預填表單（`startResettle`）→ 同一確認 modal（帶 `resettleReason`）→ POST。另加 `DELETE /:id`（super_admin，供 E2E 清理）。
- 🖥️ **前端實機驗證**：新竹館今日已結帳 → 已結帳畫面正確顯示五項摘要（發票總額 NT$2,780／加減項3列＋淨額−3,320／實際現金 42,519／差異 +39,299 紅字⚠將通知／發票 34372002～34372027）＋「當日再次結帳」→ 點開預填（含多段發票區＋新增序號鈕）→「更新結帳」→ 確認 modal 五項正確（發票總額改 NT$11,430＝手動收入加總）＋再次結帳原因欄 →「取消」關閉（未動真實資料）。
- ⚠️ **E2E 提醒**：兩實體館今日皆已結帳，直接 E2E 會覆寫/加 revision 真實資料 → 後端 E2E 改用假館 `gym-e2e-test`、測後 `DELETE`；前端只走到確認 modal 取消、不送出。

## 目前進度（2026-07-09 續）— 營收總覽列出「加減項」（來源每日結帳 deductions）
> 需求：營收總覽除交易收入外，也要列出結帳時的加減項（抽屜現金手動加/減）。**關鍵：與交易營收分開列、不併入營收總數**（它是抽屜現金加減、非銷售收入）。後端 `/health` `1.86.0-revenue-adjustments`；E2E 15/15；commit 後端 `e1e33e2`、前端 `d516760`。
- ✅ **後端 `GET /revenue/adjustments`**（`revenue.js`，`revenue.report` 權限）：撈期間內 `dailySettlements`（`date>=fromDate` 單欄位查、`gymId`/`status` 記憶體過濾）、**只計已結帳**（`status!=='draft'`，含 settled/unlocked，排除暫存）→ 攤平每筆 `deductions` 為明細列 `{date, gymId, sign, type, amount, note}`；`netAdjust` 淨額（`'+'`加`'-'`減，**舊資料無 sign 視為減**，比對 `dailySettlements.js:238`）。期間對齊營收總覽（`days` 近 N 天、含今日）；super_admin 可 `gymId` 指定館別、否則全館。**不動既有交易營收數字**。
- ✅ **前端（`RevenuePage.jsx` 營收總覽）**：日報表下方加「加減項（近 N 天結帳）」表格——逐條列 日期・館別・類型・**±金額**（+綠 −紅）・備註 ＋ 淨額小計；沿用該頁期間/館別篩選；千分位 NT$；加註「抽屜現金加減、非銷售收入、不併入上方營收總數」。`api/revenue.js` 加 `getAdjustments`。
- **E2E（打 Railway，假館 `gym-e2e-test`，測後 DELETE）15/15**：造含 3 筆 deductions（+800其他/−420教練費/−3700定線費、皆帶備註）的結帳（`paymentManual.cash` 抵銷 netAdjust→difference 0 不通知）→ `/revenue/adjustments` 回 3 列、`netAdjust=-3320`、備註/±號/金額/gymId/date 皆正確；指定他館(新竹)不含假館資料（gymId 過濾）；DELETE 後 0 列。腳本 `scratchpad/revenue-adjustments-e2e.mjs`。
- 🖥️ **瀏覽器實機驗證**（staff 營收總覽，新竹館）：加減項區塊顯示今日結帳 3 筆（教練費 −420 / 定線費 −3,700 / 其他 +800，備註齊全）＋淨額小計 **−NT$3,320**；與上方日報表 7 天合計 NT$27,134 各自獨立、未互相併入。
- ✅ **加減項匯出 CSV**（後端 `/health` `1.87.0-revenue-adjustments-csv`，commit 後端 `509777b`、前端 `495ef12`）：新增 `GET /revenue/export-adjustments-csv`（同 `/adjustments` 來源與過濾）——欄位 日期/館別/類型/加減/金額(帶負號)/備註 ＋ 末列淨額小計；UTF-8 BOM、備註加引號防逗號。前端加減項表頭右上加「↓ 匯出 CSV」鈕（有資料才顯示，走 axios `client` blob 帶對的 token，檔名 `adjustments-<日期>.csv`）。**瀏覽器實機下載驗證**：新竹館下載 `adjustments-20260710.csv`（284 bytes）內容正確（BOM＋表頭＋3 列＋淨額小計 −3320、備註帶引號保留），測試檔已清。

## 目前進度（2026-07-10）— 三組年齡限制（後端權威 + 前端友善提示）
> 未滿 5 歲不能成會員/報課程體驗；未滿 13 歲（兒童）不能買定期票/優惠卡/接受點數轉移。一律後端權威擋、不信前端。後端 `/health` `1.88.0-age-restrictions`；E2E（打 Railway）22/22。commit 後端 `63bd1e2`＋`11590be`、前端 `c94b047`。
- ✅ **共用年齡工具 `src/utils/age.js`（前後端各一份）**：`ageOf(birthday)`→整數歲、`isUnder5`、`isChild`（**兒童＝出生日期年齡<13，刻意不用 `getMemberType`**，避免小孩掛 VIP/隊員時 memberType 覆蓋 'child' 而繞過限制）。`memberService` isMinor 計算改用 `ageOf`。
- ✅ **限制 1 未滿 5 歲不能成會員（含子會員）**：`memberService.createMember`（所有建立入口共用：`POST /members`、`/self-register`、`/my/children`、`/:id/children`）有 birthday 且 `isUnder5` → throw `AGE_UNDER_5`，各 route 回 400。birthday 選填→有填才判。
- ✅ **限制 2 未滿 5 歲不能報課程/體驗**：課程 `POST /sessions/:id/enroll` 與 `enroll-all` 解析實際上課者（`memberId`／家長代子的 `childMemberId`）`isUnder5`→400；體驗 `POST /experience-bookings` 試上擋 `trialMemberId`、一般擋 `childMemberId||memberId` **與 participants 各自 birthday**（前端送**民國格式** `920110`＝民國92，後端做 ROC 相容解析）。
- ✅ **限制 3 未滿 13 歲（兒童）三擋**：
  - **買定期票**：`POST /passes`（店員賣票）目標會員 `isChild`→400 `CHILD_NO_PASS`；入場 `buy_pass`（`checkinService.createPendingCheckIn` 頂端、runEntryGates 之前）`isChild`→throw `CHILD_NO_PASS`。既有 `buy_discount_card` 兒童擋改用 `isChild`（原 `memberType==='child'`）對齊。
  - **買優惠卡**：`POST /cards/discount/purchase` 會員 `isChild`→400 `CHILD_NOT_ALLOWED`。
  - **接受點數轉移**：`cards.js` 抽 `childBlock(toMemberId)` 套 6 端點（優惠卡/舊優惠卡/黑卡各 transfer + transfer-preview），受贈者 `isChild`→400 `CHILD_NOT_ALLOWED`；`cardTransferService.initiateTransfer` 再保險一層。
- ✅ **前端友善提示（`redrock-web`，後端仍權威）**：`src/utils/age.js`；會員自助註冊(`MemberRegisterPage`)、新增子會員(`MemberProfilePage`)前端先擋<5；課程報名 modal(`MemberCoursesPage`)以「報名對象」年齡禁用送出+紅字提示；體驗(`MemberExperiencePage`)試上依對象、一般依 participants 民國生日禁用+提示；入場 QR(`MemberQRPage`)對兒童入場者隱藏「購買定期票/優惠折扣券」選項。後端 400 訊息各頁既有 catch 顯示。
- **E2E（打 Railway，22/22 綠）**：R1 4歲 `POST /members`/`self-register`/`:id/children` 皆 400 `AGE_UNDER_5`、10/20歲建立 OK；R2 注入 legacy 4歲會員→課程報名 400、體驗 participant 民國4歲 400、10歲對照非年齡擋（10歲課程回 `MEMBER_BLOCKED`＝waiver、體驗201）；R3 10歲 `POST /passes`/buy_pass/優惠卡購買/轉移(preview+transfer) 全擋、20歲對照放行（buy_pass 20歲回 `WAIVER_REQUIRED`＝通過年齡檢查）。腳本 `scratchpad/age-restrictions-e2e.mjs`（firebase-admin 注入/清理）；測試會員/卡/票/孤兒交易已清乾淨（`cleanupOrphans` 0 殘留）。
- 🖥️ **前端實機驗證**：會員自助註冊填 ~2 歲生日→按「註冊」顯示紅字「未滿 5 歲無法成為會員」、未送出。
- ⚠️ **決策點記錄**：① 兒童一律用出生日期 age<13（非 memberType）→ VIP/隊員身分的小孩仍受限；② 課程/體驗/轉移都解析「真正對象」（childMemberId/toMemberId），非登入者本人。
- 🧹 **順手清 7/7 殘留的 5 筆 `e2e-` shiftLogs**（`cleanupOrphans.js --commit`；與年齡任務無關的舊 E2E 值班殘留）→ shiftLogs 34→29、`e2e-` 0 筆，孤兒卡/票/定期票全 0。

## 目前進度（2026-07-10 續）— 會員首頁公告（館別標示 + 空心方框指示器）+ 公告發布結束時間
> 三項一起做。後端 `/health` `1.89.0-announcement-publish-until`；C 段 E2E（打 Railway）13/13 實質斷言綠。commit 後端 `a2fd97d`、前端 `308e77d`。公告物件 `gymId`＝`gym-hsinchu`/`gym-shilin`/`null`（全館）。
- ✅ **A. 輪播指示器改方框指示（純前端 `MemberHomePage`）**：原實心圓/膠囊 → 改 **14×14 方框**（`borderRadius:3`＋`border:1px 白`）；**未選取＝空心（`background:transparent`）、選取＝白底 + 打勾**。保留點擊切換/cursor/transition。
  - ⚠️ **打勾用「純 CSS 繪製」（旋轉 border 的 tick），不用 `✓` 字型字元**——回報某些裝置缺字會把 `✓` 渲染成黑色豆腐方框（tofu）；改 CSS 後任何裝置都不會出現黑方塊。（迭代：填滿白 → `✓` 字元 → 純 CSS 打勾。）
  - 💡 使用者若「一直看到舊樣式/黑方塊」＝裝置載到舊 bundle：正式站實測無 Service Worker、無 cacheStorage、index.html no-cache，故線上版正確；需**無痕/`?v=` 強制重抓**，PWA 主畫面圖示要**刪除重加**（獨立快取最頑固）。見 [[testing-live-system]]。
- ✅ **B. 輪播 + 最新公告標題前加館別**（純前端 `MemberHomePage`）：`annGymLabel(gymId)`＝`新竹館`/`士林館`/**`全館`（null，非二元寫法，避免全館誤標士林）**；輪播標題與 `announcements.map` 清單標題皆前綴 `【館別】`。
- ✅ **C. 公告新增「發布結束時間」`publishUntil`**（後端 `gyms.js` + 前端 `GymsPage`）：
  - **概念釐清（文案對齊）**：`effectiveFrom/effectiveTo`＝休館/營業調整**生效**起訖日（前端標籤「生效開始/結束日期」）；`publishAt`/新增 `publishUntil`＝公告**顯示給會員的發布時段**（標籤「發布開始時間（排程上架）」/「發布結束時間」）。
  - 後端建立（`POST`）/更新（`PUT` allowed 加 `publishUntil` + Date 轉換）收 `publishUntil`；抽共用 `isPublishedNow(a,now)=(publishAt<=now)&&(publishUntil>=now)`（皆選填）套**會員可見 3 處**：`GET /:id/announcements`、`GET /announcements/all` 清單 + banner 過濾。
  - ⚠️ **`getGymStatusForDate`（休館判定／定期票臨停補償來源，`gyms.js:56`）維持只看 `publishAt`、不套 `isPublishedNow`**——否則發布時段一過會讓休館「不算數」、補償錯亂。
  - 前端 `GymsPage` 表單加「發布結束時間」`datetime-local`（state/reset/編輯載入 `tsToLocalInput(a.publishUntil)`，null→''）；`createAnnouncement/updateAnnouncement` 傳整個 annForm、自動帶 `publishUntil`。
- **C 段 E2E（打 Railway，13/13 實質斷言綠）**：建 `publishUntil`＝過去/未來/無 三公告 → 會員端 `/announcements/all`＋`/:id/announcements` **過期不顯示、未來顯示、無結束時間顯示**；建今日休館 `publishUntil`＝過去 → **`today-status`＝closed（休館不受 publishUntil 過期影響）**、但該公告會員端不顯示。測試 4 公告測後 DELETE、0 殘留。（腳本 `scratchpad/announce-publish-until-e2e.mjs`；第 14 條「清理後非 closed」為誤判——當日 gym-hsinchu 有**真實 `颱風休館`** closure，與測試無關。）
- 🖥️ **前端實機驗證**（會員 林怡君 首頁）：輪播兩指示器為**空心方框、當前頁填滿**；輪播標題 `【新竹館】颱風休館`、最新公告 `【新竹館】颱風休館`/`【新竹館】營業時間調整` 皆帶館別前綴。

## 目前進度（2026-07-10 續）— 課程轉帳付款期限（+2天）+ 退回待補正 + 逾期自動釋名額
> 規則：會員轉帳報名 → 付款期限＝報名時間+2天；員工「退回」保留報名（不釋名額）、標待補正、會員可重新上傳但**期限追溯原值不重算**；期限到仍未確認（含退回未補正）→ 自動取消釋名額。後端 `/health` `1.90.0-course-payment-deadline`；E2E（打 Railway）**32/32**；瀏覽器實機驗證通過。commit 後端 `20e46ce`、前端 `f56d604`。
- ✅ **1) 報名設付款期限**（`courses.js` enroll-all）：`paymentMethod==='transfer' && !候補 && !分期 && !deferPayment && fee>0` → 主報名（idx0）`paymentDeadline=報名時間+2天`（現金櫃檯即時確認、不設）；回前端 `paymentDeadline`。
- ✅ **2) 退回連動**（`transfers.js` `PUT /:id/reject`）：先讀 transferRecord，標 rejected 後——`orderType==='course' && refId` → enrollment `paymentStatus:'transfer_rejected'`＋`paymentRejectReason`＋`paymentRejectedAt`＋`paymentConfirmed:false`；**保留 status、不釋名額、【不動 paymentDeadline】**（try/catch 不阻斷）。
- ✅ **3) 重新補正**（`transfers.js` `/transfers/upload`）：course 單先驗**擁有權**（`checkMemberOwnership`，本人/子女，他人 403）再建**新** transferRecord(pending)；enrollment 回 `pending_confirm`、清退回標記，**【paymentDeadline 不變】**（退回→補正不延長）。前端 `MemberCoursesPage` 重用此端點。
- ✅ **4) 逾期 sweep**（`courseService.sweepExpiredCoursePayments`）：掃 `paymentDeadline<now && paymentConfirmed!==true && status!=='cancelled'`，依 (courseId,memberId) 去重 → `cancelCourseEnrollments` 取消整門課、**釋名額並遞補候補**、作廢該報名未確認 transferRecords（→`expired`）、`cancelReason:'payment_expired'`；**冪等**（已取消者被過濾）。掛每日 9 點排程（`index.js`）＋ `POST /courses/sweep-expired-payments`（super_admin 手動觸發，供測試/補跑）。
- ✅ **5) 前端**（`MemberCoursesPage` 我的課程）：待付款群組顯示「⏳ 請於 <期限> 前完成付款」（含「轉帳待確認」）；被退回顯示紅框「轉帳被退回：<原因>，請於 <期限> 前重新上傳」＋「重新上傳轉帳」按鈕（開 Modal：末五碼/日期/截圖，標「不會延長付款期限」）；逾期取消群組顯示「因逾期未付款已自動取消」卡（**其他取消仍不顯示幽靈卡**，只 `cancelReason==='payment_expired'` 顯示）。付款期限 `{_seconds}` 以 `tsToDay` 解析。
- **E2E（打 Railway，firebase-admin 建練習課/會員/backdate/清理，32/32 綠）**：轉帳報名→`paymentDeadline`≈+2天、`enrolledCount=1`；上傳→`pending_confirm`（期限不變）；退回→`transfer_rejected`+原因、`status`仍 confirmed、名額未釋放、期限不變；補正→新單 pending、清標記、期限不變、**他人補正 403**；confirm→`paymentConfirmed`；backdate+sweep→取消、`payment_expired`、名額 2→1、舊單`expired`、**再 sweep 冪等**、已付款會員不受影響。腳本 `_course-payment-e2e.mjs`（測後全清）。
- 🖥️ **前端實機**（林怡君注入 transfer_rejected 報名）：我的課程顯示「轉帳被退回：匯款末五碼與帳單不符／請於 2026-07-11 23:08 前重新上傳」＋按鈕 → Modal（應付 NT$3,850、末五碼/日期/截圖、「不會延長付款期限」）→ 取消（未送出、測資已清）。
- ⚠️ **範圍/易錯提醒**：① 退回與補正都**沿用**原 `paymentDeadline`（否則會員退→補永不過期）；② 釋名額走既有 `cancelCourseEnrollments`（含候補遞補），非只扣人數；③ sweep 冪等＋順手把未確認 transferRecords 標 `expired`（不留孤兒單）。單堂 workshop（`enrollCourse`）未設 paymentDeadline（主流程走 enroll-all）。**（experience/competition/rental 退回連動已於 1.91.0 補上，見下。）**

## 目前進度（2026-07-10 續）— 轉帳退回連動擴及 experience/competition/rental
> 承上：原「退回」只連動 course，補上 experience/competition/rental（比照 course 標記待補正、可重新上傳）。純後端 `transfers.js`。後端 `/health` `1.91.0-transfer-reject-all-orders`；E2E（打 Railway）**35/35**；commit `f6998aa`。
- ✅ **抽 `REJECTABLE_COLL`**（course/experience/competition/rental → 各底層集合；team_member 不納入，其活動化流程另計）。三處通用化：
  - **退回** `PUT /transfers/:id/reject`：訂單 `paymentStatus:'transfer_rejected'`＋`paymentRejectReason`＋`paymentRejectedAt`＋`paymentConfirmed:false`；**保留訂單狀態、不釋放/不作廢**（course 另不動 `paymentDeadline`）。
  - **重新補正** `/transfers/upload`：通用驗**擁有權**（`checkMemberOwnership` 訂單 `memberId`，本人/子女，他人 403）→ 建新單 + 訂單回 `pending_confirm`、清退回標記（course 仍不動 `paymentDeadline`）。
  - **確認收款** `PUT /:id/confirm`：各型別確認 side-effect 一併清退回標記（`paymentConfirmed:true`、清 `paymentRejectReason`、`paymentStatus:'confirmed'`）→ 避免曾退回的訂單確認後殘留 `transfer_rejected`。
- **E2E（打 Railway，35/35 綠）**：experience/competition/rental 各跑 上傳→退回(訂單 `transfer_rejected`+原因、status 未變/未釋放)→**他人補正 403**→重新上傳(回 `pending_confirm`、清原因)→確認(→`confirmed`+`paymentConfirmed`+清標記)。firebase-admin 注入最小訂單、測後全清、0 殘留。腳本 `_transfer-reject-all-e2e.mjs`。
- 註：本次為**後端連動**；experience/competition/rental 會員端「被退回→重新上傳」的**前端 UI 未做**（course 已做，其餘沿用 `/transfers/upload` 端點、要接前端隨時可用）。

## 目前進度（2026-07-10 續）— 會員「我的票券」一併列出本人＋子會員票券（標持有人）
> 需求：`MemberPassesPage` 把「本人＋子會員」票券一起列，每筆標持有人。純前端 `redrock-web`；commit `3b40175`，member/staff 皆 deploy＋瀏覽器實機驗證。
- ✅ **載入改多持有人合併**：先 `GET /members/my/children` → 持有人清單 `[{本人,self:true}, ...子女]`；對**每位持有人**打 6 個票券端點（`/passes/member/:id`、`/cards/discount|black|legacy-discount/member/:id`、`/passes/single-entry/member/:id`、`/cards/bonus/member/:id`）＋各自 `.catch` 空陣列，攤平合併，每筆附 `_ownerId/_ownerName/_isSelf`（**本人優先**排序）。
  - ⚠️ **定期票異動申請 `/pass-adjustments/requests/member/:id` 後端限本人**（帶子女 id → 403）→ **只對本人載入**，子女視為無（其餘 6 端點皆 `where(memberId==param)` 無擁有權限制，帶子女 id 可查）。
  - `reloadCards`（移轉/接收後）改重跑完整 `loadAll()`，避免只刷新本人卡而漏掉子女票券。
- ✅ **每筆卡片標持有人**：`ownerTag()`——**本人不標、子女顯示藍/白徽章「👦 姓名」**（深色卡如優惠卡/黑卡用半透明白底）。定期票/優惠卡/黑卡/單次/紅利各分頁卡片都加；分頁 count 自然含子女（陣列已合併）。
- ✅ **子女票券唯讀**（避免送出打不過的請求）：定期票子女卡隱藏「申請展延/退費/轉讓」鈕→改「家庭成員持有·僅供檢視」；詳情 Modal 傳 `canTransfer={_isSelf!==false}`，子女票券隱藏「申請移轉」鈕→改「家庭成員持有·僅供檢視（移轉需由持有者本人操作）」。**移轉/申請動作只綁本人票券**。
- 🖥️ **瀏覽器實機驗證**（林怡君＋子帳號 `test`，firebase-admin 注入子女 1 優惠卡＋1 單次券）：分頁數 優惠卡 3(本2+子1)/單日券 11(本10+子1)；子女優惠卡顯示「👦 test」徽章、本人卡無徽章；點子女卡詳情**無移轉鈕、顯示「家庭成員持有·僅供檢視」**；子女單次券排在本人之後（本人優先）。測試票券已清。
- 📌 **後端未改**（純前端）；子女票券的**移轉/使用動作暫不接**（後端擁有權綁登入者本人，之後要接需後端支援家長代子女移轉）。

## 目前進度（2026-07-10 續）— 課程/比賽報名三項 UI 微調（純前端 `redrock-web`）
- ✅ **課程用語「講師」統一改「教練」**（commit `cbb2605`）：`MemberCoursesPage`（課程詳情「· 教練：」）＋ `CoursesPage`（場次資訊「· 教練：」、新增/編輯課程表單「教練」欄位標籤）共 4 處。DB 欄位 `instructor` 不變、後端無「講師」字樣。原本月曆「👟教練」/代課「代班教練」就已用教練，這次把殘留 4 處補齊、全系統一致。
- ✅ **課程/比賽報名簽名欄放大**（commit `a4a7b0d`）：`SignaturePad` height —— 課程 120→**200**、比賽 130→**200**（本人＋法定代理人共 4 個；寬度本就滿版）。
- ✅ **課程報名「如何得知本課程？」問卷改多選**（commit `f2e0b35`）：`MemberCoursesPage` 報名步驟2 由 radio 單選 → checkbox **可複選**（標籤加註「（可複選）」）；state `referralSource`(字串)→`referralSources`(陣列)，送出以「、」串接存回 `referralSource`（後端欄位/報表不變），modal 關閉一併重置。

## 目前進度（2026-07-10 續）— 會員課程月曆展開加「報名課程／報名單次體驗」按鈕（純前端）→ **已移除**
> ⚠️ **後來移除**（commit `cdea339`）：月曆只顯示「已報名」課程，兩按鈕只在展開**已報名**課時出現（已報名了才看得到報名鈕、反了），使用者決定移除。展開現只顯示場次表。以下為原實作記錄（已 revert）。
> `MemberCoursesPage` 月曆分頁：點日期→課程卡「查看場次表 ▼」展開後，場次列表下方加兩顆按鈕。commit `960a68c`，member/staff 皆 deploy＋瀏覽器實機驗證。
- ✅ **報名課程**（紅）：`setSelectedCategory(null)`＋`setSelectedCourse(courses.find(c=>c.id===group.courseId))`＋`setTab('browse')`＋捲頂 → 切「課程總覽」並開啟**該堂課報名頁**（課程已下架/不在 browse 清單則 fallback 類別總覽）。
- ✅ **報名單次體驗**（外框）：`navigate('/member/experience')` → 體驗課程預約頁。
- 🖥️ **瀏覽器實機**（林怡君注入月曆課程）：展開「小蜘蛛人 週三B班(進階)」→ 兩按鈕出現；「報名課程」跳課程總覽該堂報名頁、「報名單次體驗」跳 `/member/experience` 體驗預約頁。測試注入資料已清。
- 附帶：三項 UI 微調（講師→教練 `cbb2605`／簽名欄放大 `a4a7b0d`／得知管道多選 `f2e0b35`）已於前段記錄，並全數瀏覽器實機驗證通過（教練文字、簽名 200px 放大、可複選同時勾兩項）。

## 目前進度（2026-07-10 續）— 會員課程月曆「空白」排查（測試殘留 + 顯示 bug）
> 回報：會員課程月曆不能選日期、沒顯示任何課程。排查結論：**月曆本身沒壞**，是「只顯示自己已報名課程」設計（7/9 決策）＋測試殘留造成。
- 🔍 **根因**：測試帳號林怡君(member-001)累積 **26 筆已取消**課程報名（5×【練習】初級攀岩入門班＋21×小蜘蛛人週日A班候補取消，皆 E2E 殘留）→ 月曆只顯示 active(confirmed/leave) 課程故全空、無日期可點；「我的課程」因 26 筆全取消被過濾成 null 但筆數≠0 → **整頁空白**（連空狀態都沒顯示）。
- ✅ **清掉 26 筆已取消殘留**（member-001 firebase-admin 硬刪，現 0 筆）。
- ✅ **修「全部報名皆已取消→整頁空白」bug**（`MemberCoursesPage`，commit `942b510`）：`我的課程`空狀態判斷由 `myEnrollments.length===0` 改為「無任何可顯示報名」（confirmed/leave/waitlist 或 payment_expired 取消卡）→ 皆無則顯示「尚未報名任何課程」。實機驗證：林怡君 我的課程正確顯示空狀態、月曆正常渲染（空、無課程故不可點）。
- 📌 **月曆設計維持不變**（使用者確認）：**只顯示自己（含子女）已報名的課程**；沒報名任何課程→空月曆為正常，報名按鈕只在自己已報名的課展開時出現。要瀏覽全部班表另循「課程總覽」。

## 目前進度（2026-07-10 續）— 員工端入場「相機掃描」（iPad/手機相機掃會員 QR，純前端）
> 原員工端「掃描入場」只吃**掃描槍**（文字輸入框，無相機）。加相機掃碼讓 iPad/手機直接掃。commit `ad11cfd`，staff/member 皆 deploy。
- ✅ **`CheckinPage` 掃描 tab 加「📷 用相機掃描」**：`getUserMedia({video:{facingMode:'environment'}})` 開後鏡頭 → `requestAnimationFrame` 逐幀畫到 canvas → **`jsQR`** 解碼（純 JS，iOS Safari 相容；BarcodeDetector 在 Safari 不支援故不用）。掃到即停鏡頭、關視窗，token 走**共用 `runScan`** → `/checkin/qr/scan` 顯示入場預覽 → 既有「確認入場」。
- ✅ 會員入場 QR 內容＝`QRCode.toDataURL(qrToken)` 純 token 字串（`MemberQRPage:156`），故相機解出的字串直接可用。
- ✅ iOS 相容：`<video playsInline muted autoPlay>`＋JS 設 `playsinline`；權限拒絕/無裝置/非 HTTPS 各有錯誤提示；元件卸載與「關閉」自動 `stop()` 所有 track。新增依賴 `jsqr`。
- 🖥️ **驗證**：staff 入場頁「掃描入場」tab「📷 用相機掃描」按鈕正常渲染、頁面無 console error（jsQR import OK）。**相機實掃需真機（iPad/手機）測**——自動化環境無相機且會觸發原生權限對話框（會凍結 session）故未實掃；使用方式：員工端→入場→掃描入場→📷 用相機掃描→允許相機→對準會員 QR→自動帶入→確認入場。要 HTTPS（firebase hosting 已是）。

## 目前進度（2026-07-10 續）— 修：會員「我的票券」使用紀錄恆空（純後端）
> 回報：會員在「我的票券」點票券看「使用紀錄」永遠「尚無使用紀錄」，但點數其實有扣。純後端只改 `checkin.js` `GET /checkin/history`。後端 `/health` `1.92.0-checkin-history-ticket-usage`；E2E 17/17；commit `ad91a2e`。
- 🔍 **雙根因**：① 後端回 `{ checkIns }`，會員端 `MemberPassesPage` 讀 `r.data.records`（key 不符）；② 後端用 `c.ticketId`/`c.ticketType` 過濾，但 **checkIn 文件根本沒這兩個欄位**——票券使用實記在 `discountCardId`/`blackCardId`/`singleEntryTicketId`/`bonusId`/`passId` ＋ `entryType` → 清單恆空。四種票券（優惠卡/黑卡/紅利/單次券）全中。
- ✅ **修**：`ticketId` 帶入時改**比對任一票券 id 欄位**（UUID 不會撞，`discountCardId||blackCardId||singleEntryTicketId||bonusId||passId===ticketId`），移除恆空的 `ticketType` 過濾；回傳補 `records` key（會員端讀）＋保留 `checkIns`（員工端歷史入場讀，相容）。
- **E2E（打 Railway，17/17，用既有真實 checkIns、唯讀不改資料）**：優惠卡/黑卡/單次券/紅利各以真實票券 id 查 → `records` 有紀錄（原本恆空）、每筆對應 id 欄位相符、`checkIns` key 仍在；不存在票券 id → 0 筆（過濾正確非全回）。
- ✅ **附帶修使用紀錄顯示（純前端 `MemberPassesPage` TicketDetailModal，commit `b185378`）**：原顯示「gym-hsinchu Invalid date」→ ① `gymId`→`GYM_LABEL` 顯示**新竹館/士林館**；② `checkedInAt` 以 `_seconds/seconds` 解析（原恆 Invalid date，Firestore Timestamp 序列化為 `{_seconds}`）；③ `isCancelled` 的紀錄顯示琥珀「**入場取消返還**」＋綠「**+1 次**」（返還），一般用「-1 次」。瀏覽器實機驗證（林怡君優惠卡 7次 的取消入場紀錄）：顯示「新竹館 入場取消返還 / 2026/07/10 18:42 / +1 次」正確。

## 目前進度（2026-07-10 續）— 我的票券：分頁數字只算有效 + 失效收折疊 + 補定期票/舊折扣卡使用紀錄（純前端）
> 純前端 `MemberPassesPage`；commit `9978862`，member/staff 皆 deploy＋瀏覽器實機驗證。
- ✅ **A. 分頁數字只算「有效」張數**：抽 `isValidTicket(item,type)`——定期票 `active && endDate>=今天`；單日券 `active && (無 expiresAt||未過期)`；優惠卡/黑卡/舊折扣卡 `未取消 && isActive!==false && remainingCredits>0 && 未過期`；紅利 `未用 && 未過期`。TABS count 改 `splitValid(...).valid.length`。（例：林怡君單日券 10 筆(9 取消+1 有效)→**顯示 1**）。
- ✅ **B. 失效票券收折疊區**：每分頁 `splitValid` 分有效/失效；有效正常顯示、失效（已過期/已使用/已取消/已用完）收進**「已失效（N）」折疊區**（放底部、**預設收合**、可展開）；失效卡淡化＋小標籤（`invalidReason`）、**仍可點開詳情**。抽 `renderPassCard/DiscountCard/BlackCard/SingleCard/BonusCard` 共用於有效與失效區（`renderExpiredSection`/`invalidBadge` 用函式回傳 JSX，避免元件內定義元件 remount）。
- ✅ **C. 補定期票/舊折扣卡使用紀錄**：詳情 Modal 白名單加 `'pass'`＋`'legacy_discount'`。**定期票卡改可點開詳情**（保留申請鈕、`stopPropagation`），Modal 標題顯示票種+效期、歷程標「**入場紀錄**」且**無限次不顯示 -1 次**（取消只標「入場取消」）；**舊折扣卡**以 `source==='legacy'` 判定→卡片標「舊折扣卡」、`ticketType='legacy_discount'`、Modal 標題「舊折扣卡」、可移轉。history 走 1.92.0（`ticket.id` 比對 passId/discountCardId 任一欄位）。
- 🖥️ **瀏覽器實機驗證**（林怡君）：單日券分頁數字 **1**（非 10）、失效 9 筆收「已失效（9）」折疊、展開見淡化卡＋「已取消」；注入半年票→定期票卡「點擊查看使用紀錄」→Modal「半年票（全館）/入場紀錄/新竹館 2026-07-08 10:30（無 -1 次）」；注入 `source:legacy` 卡→顯示「舊折扣卡 3 次」、Modal 標題「舊折扣卡·剩餘3次」＋申請移轉鈕。測試注入資料已清。

## 目前進度（2026-07-10 續）— 會員 QR 入場：掃描確認後自動跳首頁 + 首頁「已入場」橫幅
> 會員產 QR 後無從得知店員是否已確認入場；補會員輪詢＋首頁今日入場橫幅。後端 `/health` `1.93.0-checkin-qr-status-my-today`；E2E 11/11；commit 後端 `ef0c013`、前端 `bad8577`。
- ✅ **後端兩端點**（`checkin.js`）：
  - `GET /checkin/qr/status/:qrToken`（`authenticateAny`，會員輪詢）：讀 `pendingCheckIns.doc(qrToken)`→回 `{status,gymId,checkInId}`；**驗擁有權**（本人/子女 `checkMemberOwnership`，他人 403）；仍 `pending` 但過 `expiresAt`(30 分)→`expired`；不存在→`expired`。
  - `GET /checkin/my-today`（`authenticateMember`）：查 `checkIns where memberId==` + 記憶體過濾（今日台灣日、`isCancelled!==true`）取最新→`{checkedIn,gymId,checkedInAt,checkInId}`（避複合索引）。
- ✅ **前端 A（`MemberQRPage`）**：產 QR 後每 3 秒輪詢 status——`confirmed`→清 interval→`navigate('/member/home')`；`cancelled`/`expired`→停並提示；**卸載/QR 變更 `clearInterval`**（不無限輪詢）。文案改「掃描確認後會自動完成入場並跳回首頁」。
- ✅ **前端 B（`MemberHomePage`）**：進頁抓 `/checkin/my-today`，`checkedIn`→頂部綠橫幅「✅ 已於 <館名> 完成入場」。**全天顯示、資料源自後端 checkIns**（非前端旗標）→隔日午夜後自然消失、入場被取消則橫幅消失。`api/checkin.js` 加 `getQrStatus/getMyToday`。
- **E2E（打 Railway，11/11）**：status pending 本人回 pending+gymId、他人 **403**、confirmed 回 checkInId、過期→expired、不存在→expired；my-today 無入場 false、今日入場 true+gymId、取消後 false、昨日不算、未登入擋。
- 🖥️ **瀏覽器實機全流程**（林怡君）：產 QR（新文案）→ 模擬店員確認+建今日 checkIn → **頁面 3 秒內自動跳 `/member/home`** → 綠橫幅「✅ 已於 新竹館 完成入場」；刪 checkIn 重整→**橫幅消失**（證資料源自 my-today）。測試資料已清、0 殘留。

## 目前進度（2026-07-10 續）— 每日結帳摘要：手計/系統並列 + 總金額分項 + 歷史單天下拉（純前端）
> 純前端 `DailySettlementPage`（後端已算 `income.entryItems`、`GET /daily-settlements` 回完整 doc）；commit `e503da0`，staff/member 皆 deploy＋瀏覽器實機驗證。
- ✅ **結帳摘要「手計 vs 系統紀錄」並列**：`SettlementSummary` 加 `manualTotal`——發票總金額下方顯示「手計 NT$X · 系統 NT$Y」＋差額（紅字）。手計＝`incomeManual` 各項（缺項回退系統，同 `invoiceTotal` 邏輯，抽 `manualIncomeTotal`）；系統＝`income.total`。三處（確認 modal／今日已結帳／歷史下拉）都帶。
- ✅ **入場費拆細項**：`SettlementSummary` 新增「總金額分項（系統紀錄）」——**入場（含 `entryItems` 細項：成人單次購票/學生/兒童/優惠券…）**／課程／裝備銷售／出租／定期票（含 `passItems`）。（今日收入卡本就渲染 entryItems，這次摘要/確認/歷史也一併有）。
- ✅ **歷史紀錄單天下拉結帳摘要**：`歷史紀錄` 每天卡片可點展開（`expandedDay`）→ 顯示完整 `SettlementSummary`（發票總金額手計/系統、**總金額分項 入場/課程/裝備銷售/出租/定期票**、加減項、實際現金、差異、發票號碼）。super_admin 於歷史點單天即可下拉核對。
- 🖥️ **瀏覽器實機驗證**（Sean/新竹館）：今日已結帳摘要顯示「手計 7,081·系統 2,480·差 4,601」＋分項（裝備銷售 2,480）；歷史 2026-07-09 展開→「手計 11,430·系統 2,780·差 8,650」＋**入場 300·單次購票 300**（細項）＋裝備銷售 2,480。
- ✅ **總金額分項並列手動/系統**（純前端 `DailySettlementPage`，commit `fc318e1`）：`SettlementSummary` 加 `incomeManual`，轉換期各分項（入場/課程/裝備/出租/定期票）顯示「手動 X · 系統 Y」（不一致紅字）；無手動輸入則只顯示系統。三處摘要都帶。

## 目前進度（2026-07-10 續）— 診斷「營收報表今日營收 ≠ 結帳」→ 修取消入場不沖銷 bug
> 使用者問為何營收報表今日營收與結帳不吻合。查底層資料釐清「結構性差異」vs「實質 bug」，清掉測試殘留，並修好一個真 bug。後端 `/health` `1.94.0-cancel-checkin-refund`；E2E（打 Railway）8/8。
- 📋 **不吻合的兩層原因**（新竹 7/10 實查：營收報表 3,270 vs 結帳 2,480，差額全在「入場」）：
  - **① 測試殘留（本次差額主因）**：當天 9 筆入場中 8 筆已取消（我做入場 E2E 建了又清的），但取消是用 firebase-admin 直接清、**沒走正式取消流程沖銷交易**（當天 refund 交易 0 筆）→ 那些 `completed` 的 checkin 交易留著灌水 690＋殘留 100。已 firebase-admin 硬刪 8 筆已取消入場＋8 筆孤兒 checkin 交易 → 營收報表回到實際 **2,480**、與結帳吻合。
  - **② 結構性差異（設計本然、就算沒殘留也不會恆等）**：結帳入場走 `checkIns` 集合（排除取消）、商品走 `productSales`；營收報表一律走 `transactions`（認列制）＋可切全館＋含比賽/退款沖銷/購票等類別；且結帳是「settle 當下快照」，之後收款不自動更新（要當日再次結帳）。
- ✅ **修真 bug：取消入場不沖銷入場費交易**（`checkinService.cancelCheckIn`，commit `a715a85`）：
  - **根因**：兩條取消路徑帳務分岔——`routes/cancelCheckin.js`（`/cancel-checkins/` 自助送審＋`/:id/approve` 管理員核准）在 `amountPaid>0` **有**記負向 refund；但**主要路徑** `POST /checkin/cancel`→`checkinService.cancelCheckIn`（員工入場頁「取消入場/強制取消」按鈕、會員自助 `api/checkin.js` 都走這條）只退票券/卡、**沒對入場費記負向 refund** → 已取消的付費入場仍留 `completed` 交易 → **營收報表(認列制)多算**（結帳讀 checkIns 排除取消、不受影響）。
  - **修**：`cancelCheckIn` 標記取消後補「`amountPaid>0` → 記 `type:'refund', totalAmount:-amountPaid, relatedId:checkInId`」（續約款已由 `revertRenewal` 沖銷、票券退回不涉金流，故只沖 `amountPaid`），與 `cancelCheckin.js` 對齊。
  - **E2E（打 Railway，8/8）**：注入付費入場（現金 300）＋checkin 交易 → `POST /checkin/cancel force` 200 → checkIn `isCancelled`、產生 refund `-300`（relatedId 對上、completed）、此筆對營收淨貢獻 checkin(+300)+refund(-300)=**0**、營收 total 較取消前下降 300。腳本 `scratchpad/cancel-refund-e2e.mjs`，測後 0 殘留。
  - ℹ️ **更正**：原以為「buy_pass 一次付清票價記在另一筆 `type:'pass'` 交易、未沖」——查證後**錯**：buy_pass 一次付清票價其實在 `amountPaid` 內（`checkinService.js:1159`）、由 `type:'checkin'` 交易記，**已由本次沖銷涵蓋**。真正未沖的是**分期首期**（見下一段修復）。
- ✅ **續補：取消入場沖銷定期票分期首期營收**（`/health 1.95.0-cancel-pass-installment-refund`，commit `d43b6a5`；E2E 10/10）：
  - **釐清四種定期票收款的沖銷歸屬**：`buy_pass` 一次付清＝票價在 `amountPaid`→checkin 交易（1.94 已沖）｜`buy_pass` 分期＝首期由 `createInstallmentPlan` 記 `type:'pass'`（**原未沖**）｜續約一次付清＝`revertRenewal` full 分支記 −renewalPrice（已沖）｜續約分期＝首期由 `createInstallmentPlan` 記（**原未沖**）。分期時 `amountPaid` 只含加購（岩鞋/粉袋），與首期票價不重疊。
  - **修**：新增 `installmentService.cancelInstallmentPlan(db, planId, {reason})`——作廢計畫 + 逐期把 `status:'paid'` 的期數記負向 `type:'refund'` 沖銷（`relatedId=plan.relatedId`）；**冪等**（已 cancelled 不重複沖）。接入三處取消路徑：`checkinService.cancelCheckIn` 的 buy_pass 分支、`revertRenewal` 續約分期分支、`cancelCheckin.js` `restoreEntryCredits` buy_pass 分支（後者原本連分期計畫都沒作廢→順手補上）。
  - **E2E（打 Railway，10/10）**：A. buy_pass 分期（首期 2534）→ `/checkin/cancel force` → 定期票+計畫 cancelled、產生 refund −2534、passA 營收淨額 **0**；B. 續約分期（首期 3040）→ 計畫 cancelled、票期還原 2026-07-12、refund −3040、passB 淨額 **0**。腳本 `scratchpad/cancel-pass-installment-e2e.mjs`，測後 0 殘留。

## 目前進度（2026-07-10 續）— 我的票券失效區拆「已使用/已用完」與「已失效」兩獨立折疊區（純前端 `redrock-web`）
> 讓用過的票券（有使用紀錄）不再被埋在單一混合「已失效」清單最底。純前端 `MemberPassesPage.jsx`，commit `8765d1e`，member/staff 皆 deploy。
- ✅ **折疊區泛化**：`renderExpiredSection` → `renderCollapseSection(items, type, keySuffix, title, render)`，展開 state key 用 `${type}:${keySuffix}`（`type:used` / `type:expired` **各自獨立展開、不連動**）。
- ✅ **失效再細分**：`splitInvalid` 以**單一真相** `invalidReason` 分——**consumed**（已使用/已用完）vs **dead**（已取消/已過期/已失效）；`sortConsumed` 讓 consumed 依 `usedAt`（單日券/紅利）或 `updatedAt`（優惠卡/黑卡）desc 排序（最近用的在最上）。
- ✅ **5 分頁 body** 改「有效 → 已使用/已用完 → 已失效」三段；consumed 為空該區自動隱藏 → **定期票/紅利無 consumed 時只剩「已失效」、行為不變**。單日券/紅利 consumed 標題「已使用」、優惠卡/黑卡「已用完」。
- **不動**：`isValidTicket`/`splitValid`/`invalidReason`/`TicketDetailModal`；有效券區塊原樣。
- ⚠️ **驗證**：build 兩 target 通過、資料側以複製前端 `invalidReason` 打正式資料分類驗證（林怡君單日券 10→有效 1、失效 9 正確歸 dead）。**瀏覽器實機未跑**——Claude 瀏覽器擴充當下未連線，且林怡君帳上目前 0 筆 consumed（全為已取消）→ 無法呈現兩區並列；使用者確認驗證沒問題、免實機。

## 目前進度（2026-07-10 續）— 修：結帳「月銷售/發票」Excel 下載 500（Content-Disposition 中文館名）
> 回報結帳頁下載歷史紀錄 Excel 失敗。查為 HTTP header 含中文致 500。後端 `/health` `1.96.0-settlement-export-header-ascii`；commit `89e285f`。
- 🔍 **根因**：`GET /daily-settlements/monthly-export` 與 `/invoice-export` 的 `Content-Disposition` 用 `filename="sales_${gymName}_…"`，`gymName`＝中文（新竹/士林/**全館**）→ Node 丟 `Invalid character in header content ["Content-Disposition"]`（HTTP header 值須 ASCII/latin1）→ 500（且因 Content-Type 已設 xlsx，前端把那段 JSON 錯誤當檔案 → 「下載失敗」）。**兩館皆中，含 super_admin 全館**。
- ✅ **修**：改 **ASCII fallback filename**（`sales_hsinchu_…` / `invoice_hsinchu_…`，slug 由 gymId 對應 hsinchu/shilin/all）**＋ RFC 5987 `filename*=UTF-8''<percent-encoded 中文名>`**。兩個 export route 同修。前端 `DailySettlementPage.downloadMonthly` 本就自訂 `a.download='月銷售紀錄_<月>.xlsx'`，header filename 只是 fallback、不影響實際下載檔名。
- **驗證（打 Railway，皆 200 合法 xlsx）**：月銷售 新竹 59KB／月銷售 全館(super_admin 無 gymId)／發票明細 新竹 皆 `HTTP 200` + `Microsoft Excel 2007+`；header 為 `filename="sales_hsinchu_2026-07.xlsx"; filename*=UTF-8''月銷售紀錄_新竹_…`。（修前 monthly-export 新竹實測 500 `Invalid character in header`。）

## 目前進度（2026-07-10 續）— 結帳入場費細分（成人/學生/兒童/優惠券/隊員折扣/疊加）
> 需求：結帳入場費再細分成人、學生、兒童、個別使用優惠券、隊員折扣。折扣是 checkIn 旗標非獨立類型，故需改分類鍵。後端 `/health` `1.97.0-settlement-entry-discount-breakdown`；E2E（打 Railway）10/10。commit `3d9e776`。
- 📋 **兩個定義（使用者拍板）**：①「個別使用優惠券」＝**兩種都算**——舊折扣卡8折 `legacyDiscount`（套單次入場個別 8 折）+ 優惠折扣券卡 `discount_card` 入場（後者 entryFee 0、不產生營收行）②疊加（成人＋隊員9折＋舊折扣卡8折）**另拆一類「隊員＋優惠券」**。
- ✅ **`GET /daily-settlements/today` 入場分類**（`dailySettlements.js`）：`entryCategory(data)`——`team=isTeamDiscount`、`coupon=legacyDiscount||entryType==='discount_card'`；`team&&coupon→隊員＋優惠券`｜`team→隊員折扣`｜`coupon→個別使用優惠券`｜否則依原類型（`single_ticket→成人`/`student_free→學生`/`child_free→兒童`/其餘 VIP/課程學員/定期票入場/單次入場券/黑卡/紅利/體驗）。`entryItems` 依固定順序 `ENTRY_ORDER` 排序。
- **流向**：GET /today 算好 `income.entryItems` → 前端 `SettlementSummary` 直接渲染（label+value，無硬編分類）＋結帳時 `POST /` 原封存入 `income`（line 251，非重算）→ 摘要顯示與已結帳存檔一致。**歷史已結帳 doc 維持舊分類**（用當時算的存值、不追溯）。
- **E2E（打 Railway，假館 `gym-e2e-test`，10/10）**：注入 8 筆（成人×2=600/學生250/兒童150/舊折扣卡8折240/隊員9折270/隊員+舊卡216/discount_card 0）→ `GET /today?gymId=gym-e2e-test` → entryItems 六類金額全對、排序正確、0 元 discount_card 不顯示、`income.entry` 總額 1726。腳本 `scratchpad/settlement-entry-breakdown-e2e.mjs`，測後 0 殘留。
- ✅ **月銷售 Excel 對齊同一套六分類**（`/health 1.98.0-monthly-export-entry-six-category`，commit `c6cbb27`；E2E 9/9）：抽 `entryCategory`/`ENTRY_LABEL`/`ENTRY_ORDER`/`entryOrderSort` 到**模組頂共用**，`GET /today` 與 `monthly-export` 同一套。月銷售 Excel「入場費」列由原「入場類型＋（隊員9折）」改為六分類（成人/學生/兒童/個別使用優惠券/隊員折扣/隊員＋優惠券/其餘類型）、只列有金額分類（value>0）、固定序排列。（移除原 `entryName`/systemSettings ET_NAME 依賴。）**E2E**：注入 8 情境 → 下載 xlsx 解析「入場費」列六類金額全對、0 元 discount_card 不出現、列序正確。腳本 `scratchpad/monthly-export-entry-e2e.mjs`，測後 0 殘留。→ **結帳摘要與月銷售 Excel 入場分類現已完全一致。**
- ✅ **入場費六分類欄位「預設就顯示 + 逐類手動輸入」**（純前端 `DailySettlementPage.jsx`，commit `148fcee`）：回報「結帳畫面沒出細項」——查為當天無付費入場（唯一一筆是 0 元單次入場券）＋歷史是舊格式快照，非 bug。使用者要「default 就有這些欄位、即使沒收入、旁邊可手動輸入」，拍板**每分類各一輸入框、固定六分類**。
  - 模組頂加 `ENTRY_CATS`(六類)＋`sysEntryVal`/`entryCatList`(固定六＋其他有系統值分類)/`manEntryVal`/`entryManualTotal`；`manualIncomeTotal` 入場改走 `entryManualTotal`（逐類 Σ手動缺回退系統）。
  - **今日收入卡**：入場收入下**恆顯示六分類列**（即使系統 0）；轉換期手動模式每類各一輸入框（值存 `incomeManual.entryItems[label]`），入場收入總額＝各類手動加總、底部總計走 `manualIncomeTotal`。其餘四項（岩鞋/商品/課程/定期票）維持單一手動框。
  - **SettlementSummary（確認 modal／已結帳／歷史）**：入場分項改逐類顯示——手動模式全六類「手動·系統」（不一致紅字）、純系統檢視只列系統值>0；`invoiceTotal` 改用 `manualIncomeTotal`。
  - **向下相容**：舊 `incomeManual.entry`（單一手動值、無 entryItems）→ `entryManualTotal` 回退舊值，歷史顯示不變。`incomeManual.entryItems` 隨 buildBody 存入結帳 doc。
  - ⚠️ **未跑瀏覽器實機**（擴充未連線）；build 兩 target 通過、邏輯逐案推演（空手動→系統值、輸入單類→該類手動＋餘類系統、顯式 0 生效、舊 doc 回退）。使用者可到轉換期手動模式實測。

## 目前進度（2026-07-10 續）— 結帳暫存檔(draft)只保留三天（每日排程自動清理）
> 需求：結帳暫存檔只留三天，逾期未結帳暫存自動刪；正式結帳永不刪。純後端。`/health` `1.99.0-settlement-draft-sweep`；E2E 9/9。commit `89c3165`。
- 🔍 **現況**：暫存檔存 `dailySettlements`（gymId+date 鍵、`status:'draft'`），原**無 TTL、無清理**；`GET /today` 只抓 date==今天 → 跨日後舊 draft 不再載入但 doc 永久殘留。
- ✅ **新增 `settlementService.sweepStaleSettlementDrafts()`**：`cutoff = 今天−3`（保留今天與最近三天），`where('status','==','draft')` 單一查詢 + 記憶體過濾 `date < cutoff`（避複合索引）→ batch 刪；回 `{deleted}` + log。**只刪 `draft`；`settled`/`unlocked` 正式結帳一律不動、永不刪。**
- ✅ **掛進每日 9 點排程**（`index.js` `runDailyInstallmentJobs` 尾端，try/catch 不影響其他 sweep）。
- ✅ **手動端點 `POST /daily-settlements/sweep-stale-drafts`**（super_admin，供補跑/測試，呼叫同一函式）。
- **不動**：`GET /today`、`PUT /draft`、`POST /`（結帳）行為；draft「當天載回」語意不變。
- **E2E（打 Railway，假館 `gym-e2e-test`，9/9）**：注入 draft d0/d2/d5 + settled d5（cutoff=今天−3）→ sweep → **只刪 d5 draft**（deleted:1），d0/d2 draft、d5 **settled** 全保留；二次冪等；無認證 401。腳本 `scratchpad/draft-sweep-e2e.mjs`，測後 0 殘留。

## 目前進度（2026-07-10 續）— 修：營收日報表各分類欄位未反映沖銷（顯示 gross）
> 回報「今日營收已同步結算，但下面日報表還是抓沒沖銷的金額」。純後端 `revenue.js`。`/health` `1.100.0-revenue-fold-refunds`；打正式 API 實資料驗證。commit `f91a9db`。
- 🔍 **根因**：`/revenue/daily` 與 summary 的 `byType` 直接用 `t.type` 累加 → 沖銷交易自成 `refund`/`*_refund` 類別（前端日報表**無此欄**）→ **入場/課程/定期票 欄位顯示 gross（未沖銷）**，只有「合計」`d.total` 有淨額（本就 Σ 全部含負向）。實例：7/11 `byType{checkin:5290, refund:-5290}` → 入場欄顯 5290、合計 0；7/07 定期票欄 9880（實際 −6840 續約沖銷後應 3040）。
- ✅ **修**：加 `foldType(t)`——`'refund'` 優先用 `refundCategory`，否則依 notes 推斷（含「入場」→checkin、「定期票/分期/續約」→pass）；`'*_refund'`（course_refund/competition_refund）歸回前綴類別（course/competition）。套用於 `groupByType`（summary 今日/本週/本月 byType）與 `/revenue/daily` 逐日 byType。**合計不變**（本就含負向沖銷）。
- **驗證（打 Railway 新竹近7天實資料）**：修後 7/11 入場 **5290→0**（合計 0）；7/07 定期票 **9880→3040**（合計 4240＝入場1200＋定期票3040）；各日「殘留 refund」欄全 0，欄位加總＝合計（7/06 差 400 為 `single_entry_ticket` 無獨立欄、非沖銷問題）。
- 註：export-csv 明細（逐筆列 refund/退費）**不套 fold**（明細本就該逐筆顯示沖銷列，非彙總）；日報表 `count` 仍計入沖銷交易筆數。

## 目前進度（2026-07-10 續）— 特約廠商入場優惠（全票/學生票無其他折扣 −20）
> 全票/學生票在「無其他折扣」時入場費定額 −20；會員 QR 自選、員工掃碼提示出示證件。金額後端權威。後端 `/health` `2.00.0-partner-vendor-discount`；E2E（打 Railway）12/12。commit 後端 `efc94fc`、前端 `8c7b333`。
- **規則**：適用 `single_ticket`/`student_free`（兒童 `child_free` 不適用）；定額常數 `PARTNER_VENDOR_DISCOUNT=20`（只折入場費、加購原價）；**互斥優先序 legacy(8折) > team(9折) > partner(−20)**——隊員或舊折扣卡任一成立 → 特約忽略（partnerVendor:false）；優惠卡/黑卡/紅利/單次券走各自 entryType 不在此路徑。
- ✅ **後端**（`checkinService.js` + `checkin.js`）：`computePaidEntryAmount` 加 `opts.partnerVendor`——僅當 `!legacyDiscountCard && !teamEligible && partnerVendor && entryType∈{single_ticket,student_free}` → `amount=max(0,原價−20)`、回 `partnerVendor:true`（否則 false，child_free 分支亦回 false）。`createPendingCheckIn` 收 `partnerVendor`→帶入 compute→存 `finalPartnerVendor` 進 pending；`confirmCheckIn` 寫入 checkIn；`verifyEntry` 每 `entryTypeOptions` 加 `partnerVendorEligible=(single/student && !isTeam)`＋頂層 `partnerVendorDiscount:20`；`scanQrCode` 回 `partnerVendor` 供掃碼提示；`/checkin/qr/create` 透傳。**後端權威**：前端勾了但判定隊員/舊卡/兒童 → 不套。（`/checkin/direct` 未帶 partnerVendor，站台無此入口、預設 false。）
- ✅ **前端**：會員 `MemberQRPage` 付款步驟——一般付款且 `partnerVendorEligible` → 顯示可勾選「特約廠商（−NT$20，需出示證件）」，勾選則金額 −20、payload 帶 `partnerVendor:true`；兒童/隊員/卡券/定期票路徑不顯示；QR 頁摘要標「入場費（特約 −20）」。員工 `CheckinPage` 掃碼預覽 `partnerVendor:true` → 顯眼琥珀提示「⚠ 特約廠商優惠（−20）：請會員出示證件確認」。
- **E2E（打 Railway，練習會員 super_admin 驅動 `/qr/create`→pending→scan→confirm，12/12）**：成人 300→**280**/pv:true、學生 250→**230**、兒童帶特約 **150**/pv:false、成人不勾 300/pv:false、隊員帶特約 **270**(9折)/pv:false、舊折扣卡開+特約 **240**(8折)/pv:false；scan 有/無特約回 true/false；confirm `amountPaid 280`/pv:true；verify 頂層 `partnerVendorDiscount:20`、成人選項 eligible:true、隊員選項 eligible:false。腳本 `scratchpad/partner-vendor-e2e.mjs`，練習會員/pending/checkIn/交易測後清乾淨、轉換期設定還原、0 殘留。
- ✅ **特約優惠改可設定（金額 + 啟用開關）**（後端 `/health` `2.01.0-partner-vendor-configurable`，commit 後端 `1ffbbb3`、前端 `3f3ebad`；E2E 9/9）：金額 20 原為寫死常數 → 改可於員工端「系統設定 → 入場規則 → 🤝 特約廠商優惠」設定。
  - **後端**：`GET/PUT /settings/partner-vendor`（`systemSettings/partnerVendor{enabled,discount}`，PUT 限 `super_admin`/`admin`、金額 0~1000）。`checkinService.getPartnerVendorConfig()`（讀不到/失敗 fallback `{enabled:true,discount:20}`）；`computePaidEntryAmount` 依設定套用（**停用或金額 0 → 不套、partnerVendor:false**）；`verifyEntry` 回 `partnerVendorDiscount=設定值`、`partnerVendorEligible` 受開關控制（停用→全 false）。常數 `PARTNER_VENDOR_DISCOUNT=20` 保留為 fallback。
  - **前端**：`SettingsPage` 入場規則群組加「特約廠商優惠」分頁（superAdminOnly）——啟用開關 + 折扣金額輸入（0~1000，停用時輸入框淡化）。會員 QR／員工掃碼本就讀後端回傳的 `partnerVendorDiscount`/`partnerVendorEligible`，自動吃新設定、免改。
  - **E2E（打 Railway，練習會員，9/9）**：GET 回 `{enabled:true,discount:20}`；PUT 金額 30 → 入場 300→**270**、verify `discount:30`/eligible:true；**停用** → 特約 300 不套/pv:false、verify eligible:false；金額 2000/−5 → 400。腳本 `scratchpad/partner-vendor-config-e2e.mjs`，測後還原設定（原未設→刪回 fallback）、0 殘留。

## 目前進度（2026-07-10 續）— 修：家長「我的票券/課程」看不到部分子女（子會員判定改用 parentMemberId）
> 回報父子會員在「我的票券」「我的課程」要列出不同人的項目。查：功能**早已實作**（`MemberPassesPage.loadAll`／`MemberCoursesPage.loadMyEnrollments` 都載入本人＋子女並標持有人），但後端 `/members/my/children` 有 bug。純後端 `/health` `2.02.0-child-by-parentid`；commit `7fcdddd`。
- 🔍 **根因**：`/members/my/children`（`members.js:48`）與 `checkMemberOwnership`（`utils/memberOwnership.js:35`）都要求 **`parentMemberId==家長` 且 `isChildAccount==true` 雙條件**。有 `parentMemberId` 但**漏設 `isChildAccount:true`** 旗標的子會員 → 家長 `/my/children` 撈不到 → 我的票券/課程**看不到該子女**、也**無法代操作**（退費/請假/轉移 會 403）。實資料 7 名子會員中 6 名有旗標（王登第/王登翰/王登妹＠朱智萩、小明明、貝貝/安安）正常，唯 **林小明（member-003，＠林怡君 member-001）`isChildAccount:false`** → 用測試帳號 林怡君 驗就是空的，才誤以為功能沒做。
- ✅ **修**：兩處子會員判定**改單以 `parentMemberId===家長`**（唯一定義關係，旗標冗餘）——`/my/children` 移除 `isChildAccount` where（順帶少一個複合索引需求）；`checkMemberOwnership` 條件改 `target.parentMemberId !== member.id`。非子會員（`parentMemberId==null`）不受影響。
- **驗證（打 Railway，林怡君 member token）**：修前 `/my/children` 回 **(無)**；修後回 **林小明(member-003)**，其 `passes/member` 2 筆、`single-entry` 1 筆可載 → 家長「我的票券」會顯示林小明的票（前端本就標「👦 林小明」）。**前端無需改動/部署**（載入子女邏輯早在 `3b40175`／`ef19b5b` 完成並部署）。
- 📌 **附記**：`memberService.getMemberByPhone` 的 `isChildAccount` 判斷（挑主帳號用）維持不動、正確；本次只改「列子女／代操作權限」兩處。

## 目前進度（2026-07-10 續）— 子會員 ≥18 硬擋收斂進 createMember + 前端超齡 modal
> 申請子會員頁強調未滿 18 歲、超齡送出跳 modal（前端）；後端把 ≥18 硬擋收斂進共用 `createMember`（涵蓋店員路徑）。後端 `/health` `2.03.0-child-under18-authoritative`；E2E 打 Railway 通過。
- ✅ **前端**（`MemberProfilePage`，commit `e7a2304`）：新增家庭成員表單加醒目提示「僅限未滿 18 歲」＋生日欄標註；`handleAddChild` 對 `age>=18` 由 inline 訊息改跳**置中「超過年齡限制」modal**（🔞、顯示填寫歲數、提示改註冊正式會員、「我知道了」關閉）。未滿 5 歲等其他檢查不變。
- ✅ **後端**（`memberService.createMember` + `members.js`，commit `824ff08`）：原 `>=18` 檢查只在 `POST /members/my/children` 路由層，**店員 `POST /:id/children` 與共用 `createMember` 沒擋**。改在 `createMember` 對 `options.isChildAccount` 加 `ageOf>=18 → throw AGE_RESTRICTION`（比照 `AGE_UNDER_5`），兩路由 catch 皆改回 400（`['AGE_UNDER_5','AGE_RESTRICTION']`）。一般成人會員（非子帳號）不受影響。
- **E2E（打 Railway）**：會員自助 `/my/children` 成人(≥18) → **400 AGE_RESTRICTION**；店員 `/:id/children` 成人 → **400 AGE_RESTRICTION**（新覆蓋）；未滿 18（11 歲）→ 201 建立成功。測試資料測後清、0 殘留。

## 目前進度（2026-07-10 續）— 全站「免責聲明書」改名「風險安全聲明書」
> 使用者要求全面改名。純文案（waiver 英文 key/欄位/路由不動）。前端 commit `9a1f0bb`（member/staff deploy）、後端 commit `0c33fce`（`/health` `2.04.0-waiver-rename-risk-safety`）。
- ✅ **全域替換 `免責聲明`→`風險安全聲明`**（含 `免責聲明書`→`風險安全聲明書`、無「書」的 3 處標籤/訊息一併）：前端 9 檔（OnboardingGate、Waiver/ParentWaiver 頁、QR/Home/Profile/Competitions、員工 MembersPage 待辦標籤、墜測預約 modal）、後端 3 檔（members.js 註解＋墜測鎖定訊息、fallTests.js 鎖定訊息、fallTestBookings.js「請先完成風險安全聲明書簽署」）。
- **查證不需改**：`systemSettings/waiver` 存的 zh/en 內容**不含**「免責聲明」（本就用風險字樣）；全專案（排 node_modules/dist）除 CLAUDE.md 進度史外 0 殘留。
- ⚠️ 後端 `0c33fce` 已 push 到 GitHub（Railway 監看），提交時 Railway 部署較慢、未即時上 2.04.0；文案類低風險，稍後自動部署。前端已生效。

## 目前進度（2026-07-10 續）— 定期票展延改「會員填停用期間」（後端權威順延）
> 展延由「店員填月數」改為「會員自填停用期間（起訖日）」，後端依停用天數順延票期。後端 `/health` `2.05.0-pass-extension-suspend-period`；E2E 13/13。commit 後端 `d80e87e`、前端 `b3c7311`。
- **規則（使用者拍板）**：新到期日 = **原到期日 + 停用天數**；6 個月上限判斷基準 = **新到期日 ≤ 原到期日 + 6 個月**。開始日不可早於申請日。拒絕不佔「限一次」額度。
- ✅ **後端**（`passAdjustmentService.createPassRequest` + `passAdjustments.js`）：extension 收 `suspendStart`/`suspendEnd`——驗開始日≥今天(`SUSPEND_START_TOO_EARLY`)、結束>開始(`INVALID_SUSPEND_PERIOD`)、缺期間(`MISSING_SUSPEND_PERIOD`)；`extensionDays=結束−開始`、`newEnd=原到期日+天數`，`newEnd>原到期日+6月`→`EXTENSION_EXCEEDS_LIMIT`。存 `suspendStart/End/extensionDays/passEndDateAtRequest`。`approvePassRequest` extension 改用 `request.extensionDays` 順延（核准當下再守 6 月上限），**舊申請無 extensionDays 沿用店員月數**（相容）。
- ✅ **拒絕不佔額度**：查證原本即是——`requestUsed` 只在**核准**時設 true，`rejectPassRequest` 不動它、createPassRequest 也不設 → 拒絕後可重申請。E2E 實證。
- ✅ **前端**：會員 `MemberPassesPage` 展延表單加「停用期間」起訖日（`min=今天`）+ 即時預覽「停用 N 天 → 到期日順延為 X」、超 6 月上限紅字擋 submit；帶 `suspendStart/End`。員工 `PassRequestReviewModal` 展延審核由「填月數」改**唯讀顯示會員停用期間 + 順延後到期日**（舊申請無停用期間才顯示月數輸入）。
- **E2E（打 Railway，練習會員/票，13/13）**：缺期間/早於今天/結束≤開始/超6月 各自 400 對應 code；45 天 → `extensionDays:45`、核准後票期 2026-10-01→**2026-11-15**、`requestUsed:true`、再申請 `REQUEST_ALREADY_USED`；另一票 拒絕後 `requestUsed` 仍 false、可再次申請 201。腳本 `scratchpad/pass-extension-suspend-e2e.mjs`，測後 0 殘留。

## 目前進度（2026-07-10 續）— 櫃檯掃碼確認：購買定期票標示票種與金額
> 掃碼「入場資訊確認」入場資格為「購買定期票」時，加標示票種名稱與金額。後端 `/health` `2.07.0-scan-buypass-installment-first-period`；E2E 9/9。commit 後端 `dc53a68`、前端 `9a4c509`。
- ✅ **後端**（`scanQrCode`）：buy_pass 解析 `buyPassTypeId` → 回 `buyPass{passTypeName, fullPrice, plan, dueNow}`。`dueNow`＝一次付清全額／**分期取首期**（`buildPeriodsFromConfig`，與 confirm 同源）；`totalAmount` 改用 `entryDueNow`（買定期票分期＝首期+加購，修掉原本 pending.amount 存全額致分期顯示全額的問題；一般入場不變）。純掃碼預覽顯示、不影響金流（confirm 另重算）。
- ✅ **前端**（員工 `CheckinPage` 掃碼預覽）：`scanResult.buyPass` → 入場資格下方加「購買票種」「票種金額」（分期顯示「分期首期 NT$X（全額 NT$Y）」）。
- **E2E（打 Railway，練習會員/票種，9/9）**：一次付清 → 票種名稱正確、fullPrice/dueNow/totalAmount=7600；分期 40% → plan=installment、fullPrice 7600、dueNow=首期 **3040**、totalAmount 取首期 3040（非全額）。腳本 `scratchpad/scan-buypass-e2e.mjs`，測後 0 殘留。

## 目前進度（2026-07-10 續）— 修：定期票退回後前端仍顯示「已申請過」不能再申請
> 回報林怡君一張定期票展延被退回，會員畫面仍顯示「已申請過展延」不能再申請。後端本就允許（前一段已驗），純前端 bug。commit 前端 `9e79a81`。
- 🔍 **根因**（`MemberPassesPage`）：`hasRequestForPass(passId)=myRequests.some(r=>r.passId===passId)` 對**任何**申請（含 `rejected`）都回 true → 退回後按鈕被藏、顯示「已申請過展延/退費/轉讓（限一次）」。與後端不一致（後端 `requestUsed` 只核准時設、退回不佔額度、可重申請）。
- ✅ **修**：改 `passRequestState(passId)`——有 `approved`→`used`（顯示「已申請過（限一次）」）、有 `pending`→顯示「申請審核中，請等待審核結果」、其餘（**rejected 或無**）→顯示「申請展延／退費／轉讓」鈕。
- **驗證**（打 Railway，林怡君真資料）：active 學生30日票（extension rejected）→ `none`→**顯示申請鈕**；approved 的 transfer 票→`used`→擋。純前端、已 deploy（快取可能需 `?v=`/無痕）。

## 目前進度（2026-07-10 續）— 營收日報表把定期票/租借從入場拆開
> 回報營收報表日報表要把定期票、租借費用跟入場拆開。後端 `/health` `2.08.0-revenue-daily-split-rental-pass`；commit 後端 `cf012a1`、前端 `4fc0c78`。
- 🔍 **現況**：`/revenue/daily` byType 原只 `checkin/course/product`（前端只 3 欄）；**入場(checkin)交易的 totalAmount 含岩鞋租借**（`shoesPrice` 綁在內），且 `pass`/`rental` 有值卻無欄位（只進合計、看不到）。
- ✅ **後端**（`/revenue/daily`）：checkin 交易依分開存的 `entryFee`/`shoesPrice` 拆——`入場=entryFee`、`租借=totalAmount−entryFee`（岩鞋+粉袋）；`rental*` 類型（器材租借 `/rentals`）進「租借」；`pass` 進「定期票」；其餘沿用 `foldType`（沖銷歸類）。**合計不變**。
- ✅ **前端**（`RevenuePage` 日報表）：欄位由 入場/課程/商品 改為 **入場/租借/定期票/課程/商品**（`DAILY_COLS`），tfoot 逐欄合計、表格 `overflow-x` 可橫捲、`min-width 560`。
- **驗證（打 Railway 全館近14天實資料）**：7/11 合計 4150＝入場 **3300**＋租借 **850**（原入場 4150 綁租借）；7/07 合計 4240＝入場 1200＋**定期票 3040**；7/05 入場 300＋租借 100＋商品 4880＝5280；各日欄位加總＝合計（`single_entry_ticket` 無獨立欄、仍計入合計，屬既有小類別未拆）。

## 目前進度（2026-07-10 續）— 定期票轉讓：送出即驗接收對象 + 可選子會員（防誤轉）
> 回報轉讓打錯電話/非會員的行為。原本送出不驗、只在核准查電話（`limit(1)` 有共用電話誤解析、打成他人電話會誤轉）。改為送出時就驗＋顯示/選定接收人。後端 `/health` `2.09.0-pass-transfer-validate-recipient`；E2E 8/8。commit 後端 `1bcbd5f`、前端 `9d25483`。
- ✅ **後端**（`passAdjustmentService` + `passAdjustments.js`）：`createPassRequest` transfer 收 `transferToMemberId`——驗證為有效會員(`TARGET_MEMBER_NOT_FOUND`)、非本人(`CANNOT_TRANSFER_SELF`)、必選(`MISSING_TRANSFER_TARGET`)→ 存 `transferToMemberId/transferToName/transferToPhone`。`approvePassRequest` **優先用 `transferToMemberId`**（依 id 直接取，避開共用電話誤解析）；舊申請無 id 才退回依電話查。
- ✅ **前端**（`MemberPassesPage` 轉讓表單）：輸入電話（≥10碼、debounce）→ 打 `/ticket-transfers/recipients?phone=` 查該電話會員（含家庭成員、排除本人）→ 單人顯示「✅ 接收人：姓名（家長/子女）」、**多人下拉選**、查無紅字擋送出；payload 帶 `transferToMemberId`。`PassRequestReviewModal` 顯示「將轉讓至：姓名（電話）」供店員核對。
- **E2E（打 Railway，8/8）**：未選對象/非會員 id/轉給自己 各自對應 code；轉給 B → 201 存姓名、核准後票 memberId→B、requestUsed=true；**轉給「與家長 B 共用電話的子女 C」→ 核准後票正確落在 C（非 B）**。腳本 `scratchpad/pass-transfer-recipient-e2e.mjs`，測後 0 殘留。

## 目前進度（2026-07-10 續）— 定期票轉讓禁止轉給未滿 13 歲（補齊兒童規則）
> 回報轉讓可否選 13 歲以下。查：定期票轉讓原**無**年齡擋（與「兒童不能買定期票/接受點數轉移」不一致，卡片轉移早有 `childBlock`）。補上。後端 `/health` `2.10.0-pass-transfer-block-child`；E2E 4/4。commit 後端 `a5070aa`、前端 `fddeabc`。
- ✅ **後端**：`passAdjustmentService` 引入 `isChild`——`createPassRequest` transfer 驗接收對象 `isChild`→`CHILD_NOT_ALLOWED`「未滿 13 歲無法接收定期票轉讓」；`approvePassRequest` transfer 亦擋（涵蓋舊申請/電話路徑）。`/ticket-transfers/recipients` 回傳加 `under13` 旗標（**附加、不排除**——體驗券可轉子女的用途不受影響，由各消費端自行取捨）。
- ✅ **前端**（`MemberPassesPage` 轉讓 picker）：依 `recipients.under13` 排除未滿 13 歲、自動選第一位可接收者；全為未滿 13 歲顯示「此電話的會員未滿 13 歲，無法接收定期票轉讓」擋送出；多人時附註「未滿 13 歲已排除」。
- **E2E（打 Railway，4/4）**：轉給 6 歲子女 C → `CHILD_NOT_ALLOWED`；轉給成人家長 B → 201；recipients `under13`（C=true、B=false）。腳本 `scratchpad/pass-transfer-child-e2e.mjs`，測後 0 殘留。
- ⚠️ **政策**：以「兒童不能買定期票/接受點數轉移」一致性為由**禁止**轉給未滿 13 歲。若之後要開放（例如家庭把票給小孩用）再調整此擋。

## 目前進度（2026-07-10 續）— 定期票轉入卡片註記 + 轉出紀錄（會員端）
> 需求：轉出/轉入在會員端定期票上做註記。轉入＝收票人卡片標「由 XXX 轉入」；轉出＝票已離開帳號、用申請紀錄呈現「已轉出給 XXX」（方案 A）。後端 `/health` `2.11.0-pass-transfer-in-out-mark`；E2E 6/6。commit 後端 `20538d9`、前端 `8bedb73`。
- ✅ **後端**（`approvePassRequest` transfer）：除 `transferredFrom`(id) 另存 **`transferredFromName`（原持有人姓名）＋`transferredAt`（轉讓日期）** 到轉入後的票（收票人卡片顯示用）。轉出紀錄不需改後端——直接用會員既有的「定期票異動申請」（`type=transfer, status=approved` 帶 `transferToName`）。
- ✅ **前端**（`MemberPassesPage`）：
  - **轉入**：`renderPassCard` 對 `p.transferredFrom` 顯示藍色標記「🔄 由 {transferredFromName} 轉入（{transferredAt}）」。
  - **轉出（方案 A）**：定期票分頁底部加「轉出紀錄（N）」區——列本人 `myRequests` 中 `transfer+approved`，顯示「↗ 已轉出給 {transferToName}（核准日期）」＋「已轉出」徽章。**票已離開帳號故以紀錄呈現**；passes 全空但有轉出紀錄時不顯示空狀態（原本會提早 return）。
- **E2E（打 Railway，6/6）**：A→B 轉讓核准 → 票 memberId=B、`transferredFrom=A`、`transferredFromName=原持有人`、`transferredAt=今天`；A 的申請 `approved`＋`transferToName=接收人`（轉出紀錄資料源）。腳本 `scratchpad/pass-transfer-mark-e2e.mjs`，測後 0 殘留。
- 註：轉出紀錄只列**本人**（`getMyPassRequests` 後端限本人）；子女的轉讓不在此列（子女票券本就唯讀）。
- 🧹 **回填舊轉入票姓名（一次性）**：改版前轉讓的票只存 `transferredFrom`(id)、無 `transferredFromName` → 前端顯示「由**他人**轉入」（回報：王大明的票應是林怡君轉入）。firebase-admin 掃全庫「有 `transferredFrom` 缺 `transferredFromName`」的票，以 id 反查原持有人姓名回填（順補 `transferredAt`＝該票已核准 transfer 申請的 reviewedAt）。回填 2 筆：王大明←林怡君(2026-07-11)、另一張←陳建宏(2026-06-25)。純資料、無程式變動。

## 目前進度（2026-07-10 續）— 掃碼確認：使用既有定期票入場標示票種
> 掃已有定期票者入場，入場資訊確認的「入場資格」也要寫出定期票票種。後端 `/health` `2.12.0-scan-use-pass-type`；E2E 3/3。commit 後端 `b643afa`、前端 `f61bd5b`。
- ✅ **後端**（`scanQrCode`）：`entryType==='pass'` 時解析 `passId` → 回 `usePass{passTypeName}`（讀 `memberPasses.passTypeName`）。與買定期票 `buyPass` 並列。
- ✅ **前端**（員工 `CheckinPage` 掃碼預覽）：`scanResult.usePass` → 入場資格顯示「定期票（半年票）」（票種以藍字附註）。
- **E2E（打 Railway，3/3）**：半年票會員產「使用定期票」入場 QR → scan 回 `entryType=pass`、`usePass.passTypeName=半年票`。腳本 `scratchpad/scan-usepass-e2e.mjs`，測後 0 殘留。

## 目前進度（2026-07-10 續）— 岩鞋/粉袋一律歸租借（結帳＝營收對齊）
> 回報結帳與營收細項不對齊、連帶岩鞋粉袋要算租借不算入場。後端 `/health` `2.14.0-settlement-entry-minus-rental`。
- 🔍 **兩個根因**：① **粉袋(chalk)漏歸租借**——結帳 `entryFee??amountPaid`（buy_pass 的 checkIn 未存 entryFee → 岩鞋+粉袋留在入場）、`shoeRental` 只算岩鞋不含粉袋（粉袋整個漏計）；營收舊資料 entry 也含岩鞋。② **測試殘留**——營收讀 `transactions`、結帳讀 `checkIns`，當日 9 筆 checkin 交易中 7 筆對應**已取消**入場（我今天 E2E 的 checkin+refund 對，該沖但殘留），營收計入、結帳排除 → 數字差很大。
- ✅ **修（`2.13.0`→`2.14.0`）**：結帳 `dailySettlements`＝**租借=岩鞋+粉袋、入場=amountPaid−租借**（直接用 checkIn 的 shoesPrice/chalkPrice，不倚賴 buy_pass 未存的 entryFee）；營收 `revenue/daily`＝**入場=entryFee（完整）、租借=totalAmount−entryFee（含岩鞋+粉袋）**，舊資料 fallback `amt−岩鞋`。**粉袋原本會漏計、現補回**。commit `f81da00`（revenue+初版）、`278d03a`（結帳改減租借）。
- 🧹 **清測試殘留**：刪掉近14天孤兒 checkin/refund 交易 3 筆＋當日新竹「對應已取消入場」的 checkin+refund 對 14 筆（net 0，但營收 entry/rental 欄被拆歪）。清後**新竹今日 營收＝結帳＝入場4000/租借(出租)300/合計4300**，完全對齊。
- ✅ **補上 refund 明細對稱拆分**（`/health` `2.15.0-refund-split-rental`，commit `d75125f`；E2E 5/5）：入場取消退款的 `type:'refund'` 交易補存 `entryFee`(負)、`shoesPrice`(負，=岩鞋+粉袋)——`cancelCheckIn`（checkinService）與 `cancelCheckin.js`（自助/管理員核准）三處；`revenue/daily` 對「有 entryFee 的 refund」套 checkin 同一拆分公式（rental 允許負值）→ 入場取消時 **entry/rental 欄對稱歸零**，與結帳（排除已取消）完全一致。`pass`/課程退費（`type:'refund'` 無 entryFee 或 `*_refund`）不受影響、仍 foldType 歸原類別。**E2E**：付費入場300+岩鞋100+粉袋50 → 營收 入場300/租借150 → 取消 → refund(entryFee-300/shoes-150/total-450) → 營收 入場0/租借0/合計0。腳本 `scratchpad/refund-split-e2e.mjs`，測後 0 殘留。

## 目前進度（2026-07-10 續）— 結帳「今日收入」≠「付款方式」修正（A 免費入場租借預設現金 + B 付款方式涵蓋全方式）
> 回報結帳今日收入與付款方式金額不一致。查：① 免費入場(定期票等)加租借岩鞋粉袋時 `paymentMethod:null` → 收入算(出租)、付款方式漏；② 付款方式只有 現金/LinePay/街口/台灣Pay、**無轉帳欄**，且**課程/定期票只累加現金**（電子/轉帳漏）。後端 `/health` `2.16.0-settlement-payment-all-methods`；E2E 5/5。commit 後端 `88efb6d`、前端 `3896f15`。
- ✅ **B 付款方式涵蓋全部方式**（`dailySettlements` GET /today）：改用 `payByMethod` 累加**所有來源**（入場/租借/商品/課程/定期票）的**所有付款方式**——`payment` 加 `transfer` 欄；課程/定期票的 LinePay/街口/台灣Pay/轉帳不再漏（原只 `cashCourse`/`cashPass`）。`totalCash/electronic/transfer` 皆由 payByMethod 導出。前端 `DailySettlementPage` 付款方式統計加「轉帳」列（含手動輸入）。
- ✅ **A 免費入場租借預設現金**：`addPay` 對 `paymentMethod` 為 null（免費入場但加租岩鞋粉袋）**預設歸現金**（櫃檯實收）→ 收入的出租金額在付款方式現金欄計入。`confirmCheckIn` 亦對「有實收金額但無付款方式」的 checkIn 存 `paymentMethod:'cash'`（資料本身也記，非只報表）。使用者拍板可「預設現金」。
- **結果**：**付款方式合計 ＝ 今日收入 total**（每筆收款都歸到某付款方式）。**E2E（打 Railway 假館，5/5）**：入場300現金 + 免費入場租借150(null) + 商品500轉帳 + 課程1000 LinePay + 定期票2000轉帳 → income total **3950**；payment 現金**450**(300+150)、LinePay 1000、轉帳 2500(500+2000)、合計 **3950 ＝ 收入**。腳本 `scratchpad/settlement-payment-e2e.mjs`，測後 0 殘留。
- ✅ **免費入場租借可選付款方式**（純前端 `MemberQRPage`，commit `03c7777`；E2E 3/3）：租借步驟——免費入場（定期票/VIP/黑卡/紅利/單次券等）且加租岩鞋/粉袋 → 顯示「租借付款方式」選擇（現金/LinePay/街口/台灣Pay/轉帳），未選擋確認；`handleGenerateQR` 對免費入場+租借帶 `paymentMethod`。→ 結帳付款方式**依實選歸類**（不再一律現金；未帶時後端仍 fallback 現金）。E2E：免費 pass 入場+租岩鞋100+指定 transfer → checkIn 及 checkin 交易 `paymentMethod=transfer`、amountPaid 100。腳本 `scratchpad/free-rental-paymethod-e2e.mjs`。

## 目前進度（2026-07-10 續）— 統一入場標籤 pass→定期票、buy_pass→購買定期票
> 回報入場有些寫 pass/buy_pass（原始英文）、有些寫定期票，要統一。後端 `/health` `2.17.0-unify-pass-labels`；commit 後端 `149b042`、前端 `3ef7a80`。
- ✅ **後端結帳**（`dailySettlements` ENTRY_LABEL）：`pass` 由「定期票入場」→「**定期票**」；補上 `buy_pass`→「**購買定期票**」＋`buy_discount_card`→「購買優惠折扣券」（原缺 buy_pass → entryItems 顯示原始 `buy_pass`）。驗證：新竹結帳 entryItems 由 `buy_pass` → **「購買定期票」**。
- ✅ **前端共用表**：新增 `utils/entryLabel.js`（`ENTRY_TYPE_LABEL` + `entryTypeLabel()`，pass=定期票、buy_pass=購買定期票…）；修原本直接顯示原始 `entryType` 的 4 處——`MemberRecords`、`MemberRecordsPage`、`MemberProfilePage`（原只判 monthly_pass/single_ticket、其餘顯原始）、`CheckinPage` 入場歷史列（`c.entryType`）→ 全走共用表。（各頁既有 ENTRY_TYPE_LABEL 已含 pass/buy_pass、不受影響。）
- ✅ **員工今日統計補標籤**（commit `eb81793`）：`CheckinPage` 今日統計（`statsByGym.counts` 由 `/checkin/today` 動態 `counts[entryType]++`、帶原始 key）用的 local `typeLabel` 缺 `buy_pass` → 顯示原文。補 `buy_pass=購買定期票`、`buy_discount_card=購買優惠折扣券`、`vip=VIP`（此 map 刻意用短標籤如「單次/兒童免費」，故不換共用表、只補缺項）。純前端。

## 待辦
- 🔧 **【選做】週課「候補→正取」自動遞補**：目前整門課候補遞補為手動（店員），可比照 per-session `promoteWaitlist` 做整門課版（有人退課/取消時自動遞補第一位候補、通知並轉為待收費）。
- 🧹 **一A `小蜘蛛人一A(7-8)閎`（`3f35216f`）**：使用者說「之後會刪除」自行處理（朱智萩報名在此門，刪前留意）。
- ⏰ **2026-07-14 到期提醒：刪除全部測試會員**（使用者 7/8 交代「7/14 提醒我全部刪除」）。範圍＝dev 24 筆固定 fixtures：`【練習】…`×14（王小明一般/陳美麗未簽/林志明墜測過期/張家豪未墜測/李定期月票/黑卡王/紅利妹/折扣卡姊/券券子/VIP尊爵/隊員阿凱/家長爸爸+小孩安安+小孩貝貝/體驗生今日/周銷售）＋`測試/測試API會員/管理員測試會員/Test1/Who`＋`王大明`(0900222222)+子`小明明`＋林怡君底下子帳號`test`(0912345678)。**保留**：林怡君(member-001)＋6 筆非測試(陳莉涵/張元賓/朱小姐/朱智萩/陳建宏/林小明)。刪法：`DELETE /members/:id`(super_admin，先刪家長會連帶刪子)。→ **7/14（或之後）開此專案時執行；使用者先前已三次延後，動手前再跟他確認一次**。
- 各館申請 LinePay / 街口 / 台灣Pay 商戶 → 金鑰填入各 gym 的 `paymentSettings`
- 清理 E2E 測試殘留：`【練習】體驗生今日` 名下的 failed/returned `fallTestBookings` + 一筆 failed `fallTests`（練習 fixture，無害）
- LinePay sandbox 端到端測試 → 啟用線上付款 + 員工端 QR 前端
- 補街口 / 台灣Pay adapter 的 API TODO（依整合手冊 / 收單銀行）
- 資料移轉（Climbio 18,000+ 筆）
- ✅（已完成 2026-07-04 六）站台隊員 9 折端到端實測 → 見上方進度；**真站台帳號實機亦可直接做**（館別電腦帳號經 `/stations/login` 實測有效，見上方修正），後端邏輯已由 super_admin 打 `/checkin/phone` 等價驗證通過
- 會員端 UI 驗證：課程試上分頁 + 場次代班「（代班）」顯示（需會員帳號登入實測）
- 「試上人數」目前僅由試上報名流程產生 `isTrial` 名單；如需員工手動加試上者，需另做 UI
- 清理 dev Firebase 殘留測試會員：`【練習】…` 系列、`測試/測試API會員/管理員測試會員/Test1/Who` 等，以及測試用 `王大明`(0900222222)/子帳號 `小明明`；可用員工端「刪除會員」或 `DELETE /members/:id`（super_admin）清除（會一併刪子帳號、保留歷史紀錄）
