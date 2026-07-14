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
  - ✅（已處理 2026-07-11）**殘留重複課程 `cd430bd3` 成人入門班（gymId=null、0 報名）已刪除**：與新竹館 `a5216a13` 成人入門班(7-8) 同名同日期同類別、屬誤建重複。回報「全部館別課程總覽此門沒帶館別前綴」（因 gymId=null，前綴不亂標）→ 使用者確認刪除 → firebase-admin 硬刪課程＋8 空場次。現成人入門僅剩新竹館那門、前綴正常。
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

## 目前進度（2026-07-11）— 優惠卡/黑卡詳情加「移轉紀錄」（轉入/轉出）
> 承上：優惠卡/黑卡詳情原只有使用紀錄，加一段「移轉紀錄」列出轉入/轉出（含對方姓名/次數/日期）。後端 `/health` `2.18.0-card-transfer-history`；E2E（打 Railway）10/10。commit 後端 `0fe1724`、前端 `d5c8d96`。
- ✅ **後端**（`cardTransferService.getCardTransferHistory(cardId, memberId)` + `GET /cards/transfers/history/:cardId`，`authenticateAny` member）：查 `cardTransfers` 的 `fromCardId==cardId`（轉出、限 `status:completed`）與 `newCardId==cardId`（轉入，接收後產生的卡）→ 回 `{direction:'in'|'out', memberName(對方), credits, at}` 依日期新→舊；權限以 memberId 比對 from/to、非本人相關不回。
- ✅ **前端**（`MemberPassesPage` `TicketDetailModal`）：對 `discount_card`/`legacy_discount`/`black_card` 載入 `/cards/transfers/history/:id`，於使用紀錄上方顯示「移轉紀錄」——🔽 由 XX 轉入 +N 次 / 🔼 轉出給 XX -N 次 ＋日期（無紀錄則不顯示區塊）。單次券/紅利/定期票不走卡片移轉、不載入。
- **E2E（10/10）**：注入林怡君「轉出 3 格給收卡人」與「由收卡人轉入 5 格」兩筆 completed transfer + 對應卡 → `/cards/transfers/history/:card` 轉出卡回 out(對方名/3)、接收卡回 in(來源名/5)、無關卡片回空。測後清乾淨。腳本 `scratchpad/card-transfer-history-e2e.mjs`。

## 目前進度（2026-07-11）— 刪除測試會員（保留林怡君＋王大明＋真實會員）
> 使用者：「把先前建的測試會員都刪除，只留下林怡君跟王大明，測試會員手上的票券也都刪除」。**確認後只刪測試 fixture、保留非我建立的真實會員**（原 7/14 提醒的刪除提前於今日執行；範圍縮小為只刪 fixture、不刪真實會員、且**王大明改保留**）。
- ✅ **刪除 21 筆測試 fixture**（firebase-admin 硬刪，會員 34→13）：`【練習】…`×16（含子帳號 小孩安安/貝貝）＋`Test1/測試API會員/測試/Who/管理員測試會員`×5。連帶刪其**票券/移轉**（黑卡王 7 優惠卡+1 黑卡+5 cardTransfers、折扣卡姊 1 優惠卡、李定期月票 1 定期票、券券子/體驗生今日各 1 單日券、王小明 cardTransfers）。刪法：名稱以「【練習】」開頭 or 在測試名單 + 其子帳號，安全網排除保留名單。
- ✅ **保留 13 筆**：林怡君(member-001)、王大明(+子 小明明)、陳建宏(member-002)、以及**非我建立的真實會員**（陳莉涵/張元賓/朱小姐/朱智萩+3子女 王登第/登翰/登妹/八潔/張榕）——經 AskUserQuestion 確認「只刪 21 筆測試 fixture」，**不刪真實會員**（尤其朱智萩的小蜘蛛人課程資料保留）。
- ✅ **掃描 0 孤兒票券**（owner 已刪的殘留票券）：8 個票券集合全掃、無殘留。
- 📌 原「2026-07-14 刪除全部測試會員」待辦**已完成並移除**（提前執行、範圍與原規劃不同：保留王大明與全部真實會員）。

## 目前進度（2026-07-11 續）— 我的紀錄加家庭成員下拉（父子會員切換檢視）
> 回報：會員「我的紀錄」若有父子會員，五分項（入場/定期票/課程/退費請假/比賽）不會分開顯示、無切換。做法採「頂部下拉選單切換檢視對象」（方案 1）。後端 `/health` `2.19.0-records-child-query`；E2E（打 Railway）9/9。commit 後端 `aed60a1`、前端 `277c0a0`。
- 🔍 **五端點原本擋子女的 3 個**：`/checkin/history`（會員 token 硬綁 `req.member.id`、忽略 `query.memberId`）、`/course-adjustments/member/:id`（`req.member.id!==memberId → 403`）、`/competitions/registrations/member/:id`（同 403）。`/passes/member/:id`、`/courses/member/:id/enrollments` 本就 `where(memberId==)` 無擁有權限制、家長可查。
- ✅ **後端放行家長代查子女**（三端點改用 `checkMemberOwnership(req.member, targetId, {onMissing:403})`）：`checkin.js` history——會員 token 帶 `query.memberId` 且非本人時驗擁有權後才放行（否則沿用本人）；`courseAdjustments.js`、`competitions.js` 把原硬 403 換成 ownership 檢查。非子女他人仍擋（403／不外洩）。
- ✅ **前端**（`MemberRecordsPage`）：載入 `/members/my/children`→ 家庭成員清單（本人＋子女）；**有子女才顯示頂部「檢視對象」下拉**（本人／👦 子女），切換 `viewId` 重載該人五分項。無子女者畫面不變。
- **E2E（9/9）**：注入林怡君臨時子會員＋各集合一筆 → 家長查子女五分項全 200 有資料；查非子女他人 → 入場不外洩、退費請假/比賽 403。測後清乾淨。
- ✅ **入場 tab 標記已取消入場**（純前端 `MemberRecordsPage`，commit `5065c52`）：回報「我的紀錄的入場紀錄，取消入場看不出來」——原入場 tab 只列 館名/類型/日期、不分取消。`/checkin/history` 本就回 `isCancelled`（未過濾）→ 取消者館名加**刪除線淡化**＋灰底「已取消」徽章。
  - 📋 **入場取消「備註/原因」現況**（查證，未改）：checkIn 文件取消時只寫 `isCancelled/cancelledAt/cancelledBy`，**無原因欄**。三路徑中只有「員工申請取消→管理員核准」(`/cancel-checkins/request`) 帶 `reason`，但存在 `cancelCheckinRequests` 集合、**核准時未回填 checkIn** → 會員端查不到原因。若要顯示原因需另做（取消端點加 `cancelReason` 並回填）。

## 目前進度（2026-07-11 續）— 課程名稱前綴顯示館別（會員＋員工，排除課程月曆）
> 需求：課程前面固定顯示館別（會員課程月曆一律排除；AskUserQuestion 確認「會員端＋員工端都加」）。純前端 `redrock-web`，commit `b4e5a4a`，member/staff 皆 deploy。
- ✅ **共用 `src/utils/gymLabel.js`**：`GYM_LABEL`、`gymLabel(gymId)`、`gymPrefix(gymId)`→`【新竹館】`/`【士林館】`；**未知/雙館/空 gymId → 回空字串（不前綴）**。
- ✅ **會員端**（`MemberCoursesPage`）：課程總覽——第一層類別卡（該類別全屬同館才前綴、跨館不加）、第二層類別標題＋各梯次卡、課程詳情標題；我的課程卡（group 加 `gymId`，前綴 `group.courseName`，含逾期取消卡）。`MemberRecordsPage` 課程 tab（`gymPrefix(e.gymId)`）。**課程月曆 tab 不加**（依需求排除）。
- ✅ **員工端**（`CoursesPage`）：課程列表第一層類別卡（同館才前綴）、第二層類別標題、梯次卡；場次管理側欄課程列、場次詳情標題；名單 modal 標題。**課程月曆日格不加**（自行決定排除、避免洗版，與會員月曆一致）。
- **資料來源**：課程/場次/報名皆帶 `gymId`（enroll-all 存 `gymId: s.gymId||gymId`，courseService 回傳 enrollment 含 gymId）→ 前綴即時可用。build 兩 target 通過。

## 目前進度（2026-07-12）— 自助註冊：生日必填 + 未滿18歲家長資料必填
> 需求：帳號申請生日改必填、註明未滿18需家長簽名、家長資料（姓名/電話/關係）皆必填。後端 `/health` `2.20.0-register-birthday-parent-required`；E2E（打 Railway）10/10。commit 後端 `5fd43cb`、前端 `a175fc8`。
- ✅ **後端**：`self-register` validator 生日 `optional`→`notEmpty().bail().isDate()`（必填）；handler 開頭 `isMinor(birthday)`（<18）→ 家長 `parentName/parentPhone/parentRelation` 任一空 → **400 `PARENT_INFO_REQUIRED`**（權威把關）。`memberService.createMember` 儲存 `parentName/parentPhone/parentRelation`。`utils/age.js`（前後端）加 `isMinor(<18)`；`schema.js` memberSchema 補三欄。
- ✅ **前端**（`MemberRegisterPage`）：生日欄移除「選填」＋`required`＋紅字註明「未滿 18 歲需家長／法定代理人簽署風險安全聲明書，並填寫下方家長資料」；輸入未滿18生日 → 展開「家長／法定代理人資料」區塊（姓名/電話/關係，皆 `required`、擋送出）；未成年才帶 `parent*` 進 payload（成年自動移除）。沿用未滿5歲擋註冊。
- **範圍**：只改**自助註冊**（帳號申請）；店員建立會員 `POST /members` 不強制（可事後補）。家長資料供日後風險安全聲明書家長簽署流程使用（waiver 另收 parentEmail + 簽名）。
- **E2E（10/10）**：缺生日→400（生日必填）；成年無家長→201（isMinor=false、無 parentName）；未成年缺家長→400 `PARENT_INFO_REQUIRED`、只填姓名亦 400；未成年+完整家長→201（isMinor=true、三欄已存）；未滿5歲+家長→400 `AGE_UNDER_5`（年齡擋優先）。測後清乾淨。
- ✅ **修：墜落測驗同意書家長簽名門檻 12→18**（純前端 `MemberFallTestPage`，commit `0335d00`）：回報確認到此頁家長/監護人簽名還停在「未滿12歲」，與聲明書/課程/比賽/註冊的 18 歲不一致（純前端門檻，後端墜測流程無 12 歲檢查）。改用共用 `isMinor(<18)`：判定 `isUnder12`→`needGuardian`、錯誤訊息/標題/說明文字全部 12→18。build 兩 target 通過。

## 目前進度（2026-07-12）— 修 Invalid date（會員頁）+ 全前端日期渲染稽核
> 回報會員已簽署聲明書「簽署時間」顯示 Invalid date → 修，並全面稽核其他 Invalid date。純前端 `redrock-web`。
- ✅ **根因**：`MemberProfilePage` 讀 `memberSignedAt?.seconds`（無底線），但 Firestore Timestamp JSON 序列化為 `{_seconds}` → `.seconds` undefined → `dayjs({_seconds})` = **Invalid date**。同檔入場紀錄時間（`checkedInAt`，589 行）同型 bug。
- ✅ **修**：抽 `fmtTs(t, format, fallback)`（`_seconds ?? seconds` 解析、無效回 `—`/`''` 不顯示 Invalid date），簽署時間(641)＋入場紀錄時間(589)共用。commit `cea4db1`(簽署時間)＋`9af568b`(入場時間+helper)。
- ✅ **全前端稽核（無其他 Invalid date）**：
  - `.seconds` 無 `_seconds` fallback：全 src 僅 `MemberProfilePage` 589/641（已修）＋ `FallTestBookingModal.fmtTime`（**已正確**：`_seconds` 優先、`seconds` fallback）。
  - 直接 `dayjs(Timestamp欄位)`：`MemberFallTestPage` 的 `status.passedAt/expiresAt/expiredAt` 後端回 `YYYY-MM-DD` **字串**（安全）；`signedAt` 已預解析成 Date（安全）。
  - `CheckinPage` 入場歷史 `checkedInAt` 全部走 `_seconds` 解析（安全）；`PendingTasksPage` `i.ts` 為秒數（number，安全）；`MemberPassesPage` 走 `tsToDay` helper（安全）。
  - 其餘大量 `dayjs(x.date/startDate/endDate/dueDate…)` 皆為日期字串（安全）。
- ✅ **員工端稽核（無 Invalid date bug）**：`CheckinPage` 入場歷史 `checkedInAt` 全走 `_seconds`；`PassesPage` 展延歷史 `ts`＝`createdAt._seconds`；`MembersPage` `fmtDate` 吃 `startDate/endDate` 字串、另處 `raw._seconds` 判斷；review 元件 `TicketApprovalModal.fmtDeadline`/`TransferConfirmModal`（`createdAt._seconds`）/`FallTestBookingModal.fmtTime` 皆先 `_seconds`（無則回 null/空、不顯示 Invalid）；`SchedulePage` `rangeStart`、`PassRequestReviewModal` `passEndDateAtRequest`、`CardsPage` `expiresAtISO` 皆字串。**唯一理論風險** `PassAnalyticsPage:120`（`new Date(data.generatedAt)`）＝**未 route 的 dead code**（真實統計在 `PassesPage`）→ **已刪除該檔**（無任何 import/route、不在 bundle 內、build 通過；commit `dce61e7`）。

## 目前進度（2026-07-12）— 未成年家長簽名統一（一封 email、一頁一次簽 waiver＋墜測同意書）
> 原：未成年 waiver 家長走 email 遠端簽、墜測同意書家長現場簽。改：**兩份都改成家長遠端簽，且統一成一封 email、家長進同一頁簽一次名套用兩份**。後端 `/health` `2.22.0-parent-esign-notify-guard`；E2E（打 Railway）15/15。commit 後端 `1a8bc6a`＋`609596f`、前端 `a3a576e`。
- ✅ **統一 email 觸發**（`waiverService.maybeSendParentSignEmail`）：未成年會員**本人 waiver 已簽 + 本人墜測同意書已簽 + 家長未簽 + 尚未寄過**（`parentEmailSentAt` 冪等）才寄一封統一連結。在 waiver 簽署端（`signWaiver` 末，取代原本簽 waiver 當下立即寄）與墜測簽署端（`POST /fall-tests/sign` 後）各呼叫一次 → **兩份本人都簽完那刻才寄**（先簽哪份都可）。
- ✅ **墜測同意書本人簽署**（`POST /fall-tests/sign`）：移除現場家長簽名 pad/要求，改記 `parentRequired`（依 `isMinor(birthday)<18`）、`guardianSignedAt:null`；簽完觸發統一 email。前端 `MemberFallTestPage` 家長 pad → 改提示「完成本人簽署後寄 email 給家長，於同一連結一次簽兩份」。
- ✅ **家長頁同頁簽兩份**（`GET/POST /auth/waiver/parent/:token` + `ParentWaiverPage`）：GET 一併回傳墜測同意書內容＋`pending`；家長頁顯示 waiver＋墜測兩份文字、**一個簽名 pad**；POST 同一簽名套用兩份——waiver `parentSignedAt/isComplete`＋`fallTestSignatures.guardianSignatureData/guardianSignedAt/guardianName`（家長名）。email 文案改兩份文件、同頁一次簽。
- ✅ **不需改 gate 邏輯**：waiver gate（`parent_waiver_pending`）本就擋到家長簽 waiver；家長一次簽兩份，故 waiver complete 時墜測 guardian 同步完成。墜測同意書「本人已簽」即 gate 通過（家長簽與否不另擋，靠 waiver gate 卡）。
- ✅ **順修 pre-existing 500**（`2.22.0`）：`emailService.notifyParentWaiverComplete` **從未定義** → 家長簽署儲存後呼叫即 `TypeError`→500（資料已存、但家長看到錯誤頁）。包 `try/catch`＋`typeof` 檢查，缺函式/寄信失敗都不再 500。
- **E2E（15/15）**：未成年登入 → 簽 waiver（墜測未簽→**不寄**）→ 簽墜測（兩份完成→**寄統一 email**、`parentEmailSentAt`）→ GET 家長頁（含墜測內容、pending）→ 家長簽一次→ waiver `isComplete`＋墜測 `guardianSignedAt`＋簽名回填＋家長名 → token 用完 404。
- ⚠️ **家長 email 來源**：`parentEmail` 於 waiver 簽署步驟收集（註冊只收 parentName/phone/relation）；未成年簽 waiver 時仍需填家長 Email（`PARENT_EMAIL_REQUIRED`）。子會員（`isChildAccount`）不走此流程（家長帳號代管、waiver 直接完成）。

## 目前進度（2026-07-12）— 幽靈帳號自動清除（自助註冊滿15天未完成入場前置）
> 需求：註冊但一直沒完成 waiver＋墜測同意簽名的幽靈帳號，每 15 天清一次。AskUserQuestion 定調：**15 天寬限期**（註冊滿15天仍未完成才刪、每天檢查）＋**任一未完成即算**（waiver 未完成 或 未簽墜測同意書）。後端 `/health` `2.23.0-ghost-account-sweep`；E2E（打 Railway）dry-run 10/10＋commit 11/11。commit `5222f9b`。
- ✅ **`ghostAccountService.sweepGhostAccounts({graceDays=15, commit, limit})`**：`registeredBy==='self'` → 記憶體過濾 `createdAt>15天前`、排除 `isChildAccount`/`isTeamMember`/`memberType==='vip'` → 前置未完成（waiver `isComplete!==true` 或 無 `fallTestSignatures`）→ **安全把關**：名下有子女或任一集合有資料（`VALUE_COLLECTIONS` 14 個：checkIns/transactions/memberPasses/discountCards(ownerMemberId)/legacyBlackCards/legacyDiscountCards/singleEntryTickets/discountBonuses/courseEnrollments/experienceBookings/competitionRegistrations/installmentPlans/equipmentRentals/fallTestBookings/fallTests）即保留 → 只刪「真的空」的帳號（member + 殘留 waiver/墜測同意書簽署）。
- ✅ **排程**：掛每日 09:00（`index.js` `runDailyInstallmentJobs` 尾端，try/catch 不影響其他 sweep）。手動端點 `POST /members/sweep-ghosts`（super_admin，body `{dryRun, graceDays}`，dryRun 只回候選不刪）。
- **E2E**：dry-run 驗 7 fixtures 分類（無簽/半簽→候選；近期/有入場/已完成/店員建/有子女/子帳號→保留）；commit 驗實刪＋殘留 waiver 一併刪＋保留者不動。
- ✅ **順手清除真實幽靈 `朱小姐`（0999999999）**：dry-run 發現她符合幽靈條件（自助註冊 2026-06-19、無 waiver/墜測/任何資料），雖先前「刪測試會員」時列為保留，經使用者確認**一併清除**（commit sweep 已刪）。→ 現存會員少一筆；先前 CLAUDE.md「保留 6 筆非測試」中 `朱小姐` 已不適用。

## 目前進度（2026-07-12）— 入場前置兩大方框：本人簽完各別顯示「已簽署」
> 回報：風險安全聲明＋墜測同意簽完後首頁若仍卡兩大方框，各方框要顯示「已簽署」。純前端 `MemberOnboardingGate`，commit `07a3cc6`，member/staff 皆 deploy。
- 🔍 **根因**：未成年簽完本人 waiver 後仍卡兩大方框（`needsWaiver` 因 `parent_waiver_pending` 仍 true）。原 waiver 方框 `done={!needsWaiver}`＋`waiting={parentPending}`＋`doneText={parentPending?'':'已完成簽署'}` → 走 waiting 分支但文字為空 → **顯示空的橘色徽章**（看起來像沒簽/壞掉）。墜測方框 `done={consentSigned}` 本就顯示綠色「✓ 已簽署同意書」。
- ✅ **修**：waiver 方框 `done={!needsWaiver || parentPending}`（本人已簽即視為 done、不可再點）、`doneText={parentPending?'已簽署（待家長簽署）':'已完成簽署'}` → 本人簽完顯示綠色「✓ 已簽署（待家長簽署）」；下方「📧 等待家長簽署」橫幅維持。成年不受影響（parentPending 恆 false，同舊行為）。
- **效果**：兩大方框在本人簽完後**各別顯示已簽署狀態**（waiver「已簽署（待家長簽署）」/ 成年「已完成簽署」；墜測「已簽署同意書」），不再有空徽章。
- ✅ **續修：對齊「兩份都簽完才寄家長 email」**（commit `f0794f9`）：回報未成年應是 waiver＋墜測同意書**都簽完**才送家長簽名（後端 `maybeSendParentSignEmail` 本就如此）。但上一版 gate 只簽 waiver 就顯示「待家長簽署」→ 誤導（家長其實還沒被通知）。改 `awaitingParent = parentPending && consentSigned`（兩份本人皆簽完才算家長已被通知）：**只簽一份** → 該方框顯示「✓ 已簽署」（不提家長）；**兩份都簽完** → 兩方框皆「✓ 已簽署（待家長簽署）」＋橫幅「兩份文件已完成本人簽署，已寄 email 給家長，同頁一次簽署完成即可入場」。成年不受影響。

## 目前進度（2026-07-12）— 家長簽署後再點 email 連結顯示「已完成簽署」
> 回報：家長簽完後再點 email 連結顯示「此連結無效」，應顯示「已完成簽署」。後端 `/health` `2.24.0-parent-link-already-signed`；E2E（打 Railway）5/5。commit `4d90ca2`。
- 🔍 **根因**：家長簽署（`POST /auth/waiver/parent/:token`）後把 `parentSignToken` 設 `null`（用完即廢）→ 重訪 `GET` 以 token 查無 → 回 `404 INVALID_TOKEN`「此連結無效」，走不到 `ALREADY_SIGNED` 判斷。
- ✅ **修**（`auth.js`）：簽署後**保留 `parentSignToken`/expiry**（不再 null）——重簽由新加的 `parentSignedAt` 檢查擋 `409 ALREADY_SIGNED`（POST）；token 只剩唯讀查詢用途。GET 把「已簽 → 409 ALREADY_SIGNED」移到「過期 → 410」**之前** → 簽完後（即使逾 72h）都顯示「已完成簽署」。前端 `ParentWaiverPage` 本就把 `ALREADY_SIGNED` 顯示為「此聲明書已經完成簽署囉，感謝您！」。
- ✅ **競賽家長簽署同步修**（`competitionService.signParentCompetitionWaiver`）：同樣不再 null token；競賽 GET 本就先查 `isComplete`→ALREADY_SIGNED，保留 token 即可正確顯示。
- **E2E（5/5）**：未成年簽兩份 → 家長 GET 200 → 家長簽署 200 → **重訪同連結 409 `ALREADY_SIGNED`**（非 404）→ 重複 POST 409 → token 簽署後仍保留。

## 目前進度（2026-07-12）— 會員入場 QR 加場館選擇（修「一律新竹館」→士林館自助入場全被擋）
> 回報：賴維治產生入場 QR、在士林館掃碼被系統判為「新竹館 QR」擋下。查為會員端 QR 場館寫死問題。純前端 `MemberQRPage`，commit `b356a47`，member/staff 皆 deploy。
- 🔍 **根因**：`MemberQRPage` 的 `gymId = member?.defaultGymId || 'gym-hsinchu'`，但 **`defaultGymId` 全系統從未被設定過**（僅被讀）→ 每位會員的入場 QR **恆為新竹館**。站台掃碼有 `GYM_MISMATCH` 檢查（1.45.0：`pending.gymId !== staffGymId` 擋，super_admin 例外）→ **任何會員在士林館走自助 QR 一律被擋**（非賴維治個案，是全體士林自助入場壞掉）。
- **為何 QR 要分場館**：`/checkin/verify` 依「指定館」算資格並烘進 QR（單館定期票僅該館有效、購買定期票 target gym 等），站台掃碼比對同館以防「A 館算的資格拿到 B 館用」。設計本身合理，缺的是「讓會員選館」。
- ✅ **修（方案 A：會員產 QR 前先選場館）**：`gymId` 改 state（`localStorage.memberEntryGymId` 記住上次、預設新竹）；頂部加場館選擇器 `GymSelector`（新竹/士林，比照 `MemberSelector` 樣式），切換即 `changeGym`→重新 `doVerify`（verify useEffect 依賴加 `gymId`）＋依此館產碼；**QR 已產生的步驟（step==='qr'）不顯示**選擇器（避免誤觸重置）。後端 `gymId` 比對維持不動（防跨館誤用），本次純前端。
- **效果**：士林館會員在 QR 頁選「士林館」→ verify/產碼皆士林 → 士林站台掃碼通過；跨館防呆仍在（士林 QR 拿到新竹掃仍正確擋）。

## 目前進度（2026-07-12）— 會員入場流程：先問租借器材、再選付款方式（順序對調）
> 回報：入場現在先選付款方式、再跳租借岩鞋粉袋，希望對調。純前端 `MemberQRPage`，commit `b0019a6`，member/staff 皆 deploy。
- **原流程**：選身分 `select_entry` → 選付款/票券方式 `select_method` → **選付款方式 `select_payment` → 租借器材 `shoes`** → 產 QR（從 shoes 按鈕）。
- **改後**：選身分 → 選付款/票券方式 → **租借器材 `shoes` → 選付款方式 `select_payment`** → 產 QR（從 select_payment 點付款方式即產）。
- ✅ **改法**：① `select_method` 付費方式（一般付款/優惠券/購券/購定期票）一律先 `setStep('shoes')`（原 requiresPayment→select_payment）；② `shoes` 按鈕：付費入場（`requiresPayment && !freeEntry`）改「下一步：選擇付款方式 →」進 `select_payment`；**免費入場（含加租器材/續約）維持在 shoes 選租借/續約付款後產 QR**（不受影響）；③ `select_payment` 移到 shoes 之後：`onBack` 回 shoes、點付款方式即 `handleGenerateQR(rentShoes,rentChalk,pm.key)`（handleGenerateQR 加 `payMethod` 參數，避免 `setSelectedPayment` 非同步取不到值）、金額摘要補顯示「＋租借器材 NT$X」小計。
- **不受影響**：免費入場/黑卡/紅利/單次券（本就無 select_payment）、續約付款（在 shoes）、特約廠商勾選與 buy_pass 分期選擇（仍在 select_payment，現為最後一步）。build 兩 target 通過。

## 目前進度（2026-07-12）— 會員入場 QR 提醒出示證件（特約廠商/學生）
> 需求：使用特約廠商折扣時，會員端入場 QR 提醒出示廠商證件（與學生一樣）；櫃檯員工端也提醒檢查證件。純前端 `MemberQRPage`，commit `6e7ee8b`，member/staff deploy。
- ✅ **會員端**（`MemberQRPage` QR 頁）：`pvActive`（特約廠商）或 `entryType==='student_free'`（學生入場）→ 顯示琥珀提醒「🪪 入場時請於櫃檯出示 學生證／特約廠商證件 供核對，未出示或不符將以原價計」（兩者皆符時一起列）。
- ✅ **員工端**（`CheckinPage` 掃碼預覽，本就有、確認到位）：特約廠商「⚠ 特約廠商優惠（−20）：請會員出示特約廠商證件確認後再放行」（2.00.0）＋學生「🎓 學生入場：請查驗學生證後再放行」（前段新增）。→ 會員端出示、櫃檯端查驗兩邊對齊。

## 目前進度（2026-07-12）— 商品銷售購物車：清空鍵 + 查證全列
> 需求：銷售頁若有選取未結帳品項要全部列出、加清空購物車鍵。純前端 `SalesPage`，commit `032f21c`，staff/member deploy。
- ✅ **查證「全部列出」**：`cart.map(...)`（`SalesPage:548`）本就渲染所有已加入未結帳品項，cart 為 state、結帳/移除前持續保留、無截斷或 maxHeight 隱藏 → 已正確全列（無 bug）。
- ✅ **加「清空購物車」鍵**：購物車標題右側「🗑 清空購物車」，點擊 → **二次確認**（確定清空／取消，`confirmClear` state），避免誤觸清掉整車；加新品（`addToCart`）自動取消殘留確認；標題另顯示總件數（Σ quantity）。原本僅逐項 ✕（`removeFromCart`）、無清空全部。

## 目前進度（2026-07-12）— 修：商品變體無唯一 id（購物車「已加入」與購物車件數對不起來）
> 回報：銷售頁變體 modal「已加入」總數（6 件）與購物車件數（2 件）對不起來、且已加入>庫存。後端 `/health` `2.25.0-product-variant-id-unique`；commit 後端 `3ea8154`＋資料修復。
- 🔍 **根因**：`PUT /products/:id`（`products.js:109`）直接存 `req.body.variants`——前端**新增變體時未帶 id** → 存成 `id: undefined`。購物車 key＝`${productId}_${variant.id}`＝`${productId}_undefined` → **所有 undefined-id 變體衝突成同一購物車項**；`inCart = cart.find(c => c.variantId === v.id)`＝`undefined===undefined` → modal 多個變體列都誤配到同一筆 → 「已加入」件數灌大（3 列各顯 2＝6）、購物車實際只有 1 項（2 件）。全庫多數商品都中（後續加的變體無 id）。**建立（`POST`）本就補 uuid（:82），只有更新漏了**。
- ✅ **後端修**（`PUT /products/:id`）：儲存前對每個變體補「唯一」id——缺 id 或與同商品其他變體重複 → `uuidv4()`（`seen` 去重）。
- ✅ **資料修復**（firebase-admin 全庫掃描）：**23 個商品、補 75 個變體 id、負庫存夾 0 共 4 筆**（即先前回報的 −1）；驗證全庫變體 id 皆唯一、無 undefined。
- ⚠️ **前端無需改**（購物車 key/inCart 以 variant.id 比對，id 唯一後即正確）；但**使用者需清空舊購物車＋重新載入**商品頁（舊 cart 仍握舊的 undefined-id 快照）→ 用先前加的「🗑 清空購物車」即可。
- 附帶：先前回報的「負庫存 −1」＝手動編輯設入（後端結帳有擋超賣 `products.js:237`、賣不到負），本次一併夾 0。
- ✅ **庫存不接受負數（前後端夾 ≥0，`2.26.0`，commit 後端 `e3d74ef`/前端 `94d7413`）**：前端 `VariantForm` 數字欄位加 `min=0`＋onChange 負值即夾 0、存檔 `stockNum` 走 `Math.max(0,…)`；後端 `PUT` 變體正規化夾 `stock/gymStock/warehouseStock ≥0`、`POST` 建立夾、`restock` 結果夾 ≥0（`warehouse-stock` 端點本就擋負）。

## 目前進度（2026-07-12）— 課程退費申請審核中「凍結」（取消學員資格＋擋請假/補課/暫停/重複退費）
> 由「退費 pending 期間會員能做什麼」查證引出三個縫隙（前端灰鍵不跨重整、後端無重複 pending 擋、重複核准＝重複退款），使用者加碼定調：**送出退費申請後即凍結該課**——取消課程學員入場資格、擋上課/請假/補課/申請暫停/再申請退費；退回（reject）自動全面恢復、核准則取消報名。後端 `/health` `2.27.0-refund-pending-freeze`；E2E（打 Railway）**17/17**。commit 後端 `30b99b2`、前端 `99b9fdf`。
- ✅ **凍結機制（enrollments.refundPending 旗標）**：`refund-request` 建立後批次標該課所有有效報名 `refundPending:true`＋`refundRequestId`；**reject 清旗標恢復**；approve 走既有 `cancelCourseEnrollments`。
- ✅ **重複申請擋**：`refund-request`／`pause-request` 建立時查同課程＋同會員已有 `pending` 申請 → **409 `REQUEST_PENDING`**（查詢用 courseId+memberId 兩等值、status 記憶體過濾，避複合索引）；pause 另擋 `refundPending` 報名 → 400 `REFUND_PENDING`。
- ✅ **權威 gate**：`checkinService.getCourseAccess` 過濾 `refundPending`（**課程學員免費入場資格即時取消**，退回恢復）；`courseService.requestLeave` 擋 `REFUND_PENDING`；`courseService.enrollMakeup` 查原課程有 pending 退費 → 擋 `REFUND_PENDING`（凍結該課衍生補課資格）。
- ✅ **防重複退款**（approve）：核准退費當下該會員此課程已無有效報名（confirmed/leave/waitlist）→ **400 `NO_ACTIVE_ENROLLMENT`**（堵 legacy 重複 pending 被連續核准 → 重複入帳）。reject 亦補 `ALREADY_PROCESSED` 擋。
- ✅ **前端**（`MemberCoursesPage`）：`pendingAdjustCourseIds`(Set) → `pendingAdjust`(Map，key=`courseId__memberId`→type)；**載入時從 `/course-adjustments/member/:id`（本人＋子女）回填 pending**（修「重整後灰鍵消失、可重複申請」）；退費審核中課卡顯示「退費審核中」徽章＋紅色說明（操作已暫停、退回自動恢復）、**隱藏請假入口**（展開場次＋下一堂）、補課資格該課顯示「退費審核中」不可用；退費/暫停鍵依型別顯示「退費審核中／暫停審核中」。
- **E2E（17/17）**：退費前 course_access 免費入場 → 申請 201＋兩筆報名皆凍結 → verify 即失去學員資格 → 重複退費 409／暫停擋／請假 400／補課 400（皆 REFUND_PENDING）→ 退回後旗標清除＋資格恢復＋可請假 → 再申請 201 → 核准後報名取消 → 注入 legacy 重複 pending 再核准 → 400 NO_ACTIVE_ENROLLMENT。fixtures 全清。
- 📌 **語意**：凍結只在「審核中」；核准＝報名取消（原有流程）；退回＝完全恢復（含入場資格/請假/補課，額度不受影響）。暫停申請 pending 不觸發凍結（僅退費）。

## 目前進度（2026-07-13）— 全會員資料清空 + 付款方式系統開關
> 兩項：①刪除所有會員資料（含票券/課程報名，AskUserQuestion 確認「全部刪＋連帶歷史全刪」）②付款方式（現金/轉帳/LinePay/街口/台灣Pay）改由系統管理員設定控制，先只開現金+轉帳。後端 `/health` `2.28.0-payment-method-toggles`；E2E 7/7。commit 後端 `a997737`、前端 `627139e`。
- ✅ **全會員資料清空（firebase-admin，dry-run→commit）**：**15 會員＋連帶共 693 筆**——members/waivers/墜測(4集合)/checkIns/pendingCheckIns/cancelCheckinRequests/**transactions/productSales（營收歸零）**/memberPasses/passRequests/各式卡券(5集合)/cardTransfers/ticketTransfers/courseEnrollments/courseMakeupRights/courseAdjustmentRequests/experienceBookings/competitionRegistrations/installmentPlans/equipmentRentals/transferRecords 全清空、0 殘留；**42 個課程場次人數歸零**。保留：課程/場次/票種/商品/staff/gyms/設定/公告/排班/dailySettlements（員工結帳快照，非會員資料）。→ **先前「保留真實會員」清單全數作廢**（含林怡君 member-001、朱智萩小蜘蛛人報名）。之後測試需重新註冊帳號。
- ✅ **付款方式開關**（`GET/PUT /settings/payment-methods`，`systemSettings/paymentMethods.enabled`）：GET 公開（各付款頁讀）、PUT 限 super_admin/admin、**至少須開一種**（全關 400）。**預設僅 現金+轉帳**；LinePay/街口/台灣Pay 待金流 API 對接後由管理員在「系統設定 → 入場規則 → 💳 付款方式」開啟。
- ✅ **前端統一 gate**（`utils/paymentMethods.js`：`useEnabledPayments` hook＋`filterPayments`，模組快取、讀取失敗安全預設現金/轉帳）。**套用 10 處**：`PaymentSection`（課程/體驗/比賽waiver付款/租借/團隊共用）、`PaymentPlanChoice`（分期）、`MemberQRPage`（入場/續約/免費租借 3 處 render）、`MemberRentalPage`、`MemberCompetitionsPage`、staff `SalesPage` POS、`CheckinPage` 電話入場、`CoursesPage` 員工報名、`InstallmentsPage`（select+chips）、`MembersPage` 入場登記 Modal。關閉的方式全站不顯示；開啟即自動出現（免改码）。
- ✅ **rail 層權威驗證**（`2.29.0-payment-rail-toggle-enforce`，commit `5b358c0`；E2E 4/4）：`paymentService.createPayment` 對非 mock provider 讀 `getEnabledPaymentToggles`（與 `/settings/payment-methods` 同源），未開放 → **400 `METHOD_DISABLED`**（不信前端顯示層）；`getAvailableMethods`（線上付款方式清單）同步以開關過濾。E2E：關閉時 linepay 走 rail 被擋 → 開啟後放行（換 INVALID_ORDER 非開關擋）→ 還原後再擋。**離線方式（現金/轉帳）記錄端點分散、未逐一驗**（顯示層 gate；金額仍後端權威）。
- **E2E（7/7）**：GET 預設現金+轉帳、未登入 PUT 401、PUT 開 linepay 生效+讀回、全關 400、還原僅現金/轉帳。
- 📌 **admin 帳號**（`admin@redrock.app`）曾被停用致 E2E 401 `STAFF_INACTIVE`，使用者已重新啟用並指定**留作測試用**。

## 目前進度（2026-07-13）— 強制登出全員工/站台 + 開始裝置認證管制
> 需求：員工（super_admin 除外）與館別電腦全部強制登出，開始裝置認證管制。後端 `/health` `2.30.0`→`2.31.0`；E2E 通過；commit `6a16e54`＋`546b3a9`。**已實際執行：12 員工＋2 站台全數登出、裝置綁定開關＝開啟。**
- ✅ **強制登出機制（`forceLogoutAfter`）**：帳號文件設此時戳後，**之前簽發的 token 一律 401 `SESSION_REVOKED`**——`authenticate`（staff/operator token，本就每請求讀 staff 文件）＋`authenticateStation`（改 async：station token 查 `stations`、operator token 查 `staff`）都檢查 `decoded.iat*1000 < forceLogoutAfter`。前端 401 interceptor 本就清 token 回登入頁 → 立即登出生效。
- ✅ **`POST /auth/staff/force-logout-all`**（super_admin）：全部員工（**super_admin 除外**）＋全部館別電腦設 `forceLogoutAfter=now`。可重複執行（重新蓋時戳）。
- ✅ **裝置綁定管制已開啟**（`systemSettings/security.deviceBindingEnabled=true`；使用者測試期間已先開過一次）：員工/站台**下次登入**須裝置驗證——未授權裝置 → `403 DEVICE_VERIFICATION_REQUIRED`＋寄 OTP 至帳號 Email（自助 `POST /auth/device/verify-otp`）或管理員審核；**super_admin 登入不受綁定影響**（原設計例外）。關閉入口：系統設定 → 員工帳號 → 裝置綁定 toggle。
- **E2E（實測 Railway）**：force-logout 執行（12 staff＋2 stations）→ 舊站台 token `SESSION_REVOKED`；super_admin token 不受影響；綁定開啟後 站台/員工登入皆 `DEVICE_VERIFICATION_REQUIRED`、super_admin 登入 200。測試臨時員工已刪；測試期間簽發 token 已由最終一次 force-logout 全數作廢。
- ✅ **順修既有 bug：`GET /stations/shift/current/:stationId` 500**（`2.31.0`）：查詢 `stationId+clockOutAt+orderBy(clockInAt)` 缺複合索引 → `FAILED_PRECONDITION`（E2E 撞見、與本次改動無關）。改單一 where＋記憶體過濾排序（專案慣例）。
- ⚠️ **實務提醒**：兩館電腦與所有員工下次登入都要走一次裝置驗證（Email OTP 或管理員在裝置審核頁核准）；若現場卡住可暫時關閉裝置綁定開關再排查。

## 目前進度（2026-07-13）— 結帳「購買定期票 vs 定期票」查證 + 月銷售 Excel 列手動輸入金額
> 兩問：①結帳歷史「購買定期票」與「定期票」是否重複 ②月銷售 Excel 要列手動輸入金額。後端 `/health` `2.32.0-monthly-export-manual-amounts`；E2E 8/8。commit `5d92c99`。
- 📋 **①查證結論：不重複（金額互斥、總計只算一次），但屬「依購買通路分家」的顯示設計**：
  - **入場細項「購買定期票」**（`income.entryItems`，來源 `checkIns`）＝會員**入場當下購買定期票、一次付清**的票款（buy_pass 的 `amountPaid`，記 `type:'checkin'` 交易、**不會**產生 type:'pass' 交易）。
  - **獨立大項「定期票」**（`income.pass`/`passItems`，來源 `transactions type='pass'`）＝**櫃檯新增定期票（POST /passes）＋分期首期＋續約款**。buy_pass 分期時 checkin 的 amountPaid 不含票價（首期由分期計畫記 type:'pass'）→ 兩邊互斥。
  - ✅ **已統一（`2.33.0-buypass-under-pass-category`，commit `c3fa356`；E2E 11/11）**：使用者拍板「賣票收入全在一處」——buy_pass 票款改歸「定期票」大項，三處對齊：
    - **交易補 `entryType`**：`confirmCheckIn` 的 checkin 交易＋`cancelCheckIn`/`cancelCheckin.js` 的沖銷交易皆存 `entryType`（供營收分類與取消對稱；歷史交易已全清、無相容包袱）。
    - **結帳 `/today`**：buy_pass 票款（一次付清 `amountPaid−租借`）併入 `passIncome`/`passItems`（**依票種名**，`getAll passTypes` 補名、fallback「購買定期票」）；岩鞋/粉袋照歸出租；分期不變（票款本就由分期計畫記 type:'pass'）。`entryItems` 不再出現「購買定期票」。
    - **月銷售 Excel**：入場費細項（由 checkIns 重算）排除 buy_pass；票款由結帳存檔 `passItems` 呈現於「定期票」列。
    - **營收 `/revenue/daily`**：`entryType==='buy_pass'` 的 checkin/沖銷交易 → 票款(`entryFee`)歸「定期票」欄、租借照拆、取消沖銷對稱歸零。
    - **E2E（11/11）**：假館注入 buy_pass(7700=票7600+鞋100)＋成人300＋buy_pass 沖銷 → 結帳 入場300/出租100/定期票7600（passItems 票種名）/總計8000；營收 入場300、租借與定期票沖銷對稱歸 0；Excel 入場費無「購買定期票」列、成人列仍在。
- ✅ **②月銷售 Excel「手動輸入金額」區**（`monthly-export`）：當月任一天結帳存有 `incomeManual` → 品項銷售明細後輸出——`入場費(手動)` 逐分類列（當月手動分類聯集、固定六分類序）、`租借費(手動)`/`商品販售(手動)`/`定期票(手動)`/`教學費(手動)`、**手計總額**（與前端 `manualIncomeTotal` 同邏輯：逐項 手動 ?? 系統回退）。無手動輸入的月份不輸出此區（版面不變）。**E2E（8/8）**：注入含 incomeManual 的假館結帳 → 下載解析——手動分類值/租借/定期票手動值正確、手計總額=3200（含空值回退系統）、原系統列不變。

## 目前進度（2026-07-13）— 員工課程月曆殘留清理（士林館 test 課程）
> 回報：員工端課程月曆士林館還有「test」（已刪除），要清空對齊、月曆與現有資料完全吻合。firebase-admin 清理＋驗證。
- 🔍 **查明**：「test」課程（`e647cce8`，士林館）**其實仍存在** courses 集合（使用者以為已刪但未刪成）——月曆忠實顯示它，非月曆 bug。另掃到 **1 筆孤兒場次**（【練習】初級攀岩入門班 7/12，課程已不存在）。
- ✅ **清理**：硬刪 test 課程＋其 **8 場次**（先驗 0 報名）；清 1 筆孤兒場次。
- ✅ **驗證對齊**：場次 109→**100 筆**、全部對應到現有 12 門課程（0 未對齊）；各館分佈＝**新竹館 100、士林館 0**（現有課程全在新竹）→ 月曆與資料完全吻合。

## 目前進度（2026-07-13）— 試上名額改「報名即佔位、額滿候補、逾期釋放轉正」
> 承「週課開放試上名額流程」查證，使用者拍板改制：**報名後名額先佔著、後續報名列候補、繳費期限過後釋出名額候補轉正**。後端 `/health` `2.34.0-trial-seat-hold-waitlist`；E2E **13/13**。commit 後端 `454d78e`、前端 `af2c580`；`docs/course-experience-features.md` 第 5 節已同步改版。
- ✅ **報名即佔位**（`POST /experience-bookings` trial 分支）：報名當下呼叫 `enrollTrial`（`paymentStatus:'pending'`）——有位→正取保留、滿→**候補**（不再擋 SESSION_FULL）、候補也滿（`course.maxWaitlist`）→ 400 `WAITLIST_FULL`。**繳費期限＝min(報名+48h, 上課開始)**（`trialPaymentDeadline`）；booking 存 `trialEnrollmentId/isWaitlist/paymentDeadline`。
- ✅ **確認收款**（confirm trial 分支）：名單已存在 → 只標 `paymentStatus:'paid'`＋清期限；名單已因逾期釋放 → **400 `TRIAL_EXPIRED`** 請重新報名。（無 `trialEnrollmentId` 的舊預約沿用舊路徑。）
- ✅ **逾期釋放＋候補轉正**（`sweepExpiredTrialPayments`，掛**每小時**排程）：期限過仍 pending → 名單取消 `payment_expired`＋釋放名額＋預約標逾期取消＋`promoteWaitlist` 轉正；**遞補者取得新期限**（遞補時起算 min(+48h, 上課前)）。冪等。取消預約（`removeTrialEnrollment`）釋位也自動遞補。
- ✅ **試上列表**（`getTrialSessions`）：額滿但候補未滿**仍列出**（回 `isFull`）；前端場次卡標「**額滿・可候補**」；報名成功訊息帶繳費期限／候補說明。
- **E2E（13/13）**：max1/候補1 場次——M1 報名即佔位(期限≈+48h)→額滿列表 isFull→M2 候補→M3 WAITLIST_FULL→M1 期限改過去+sweep→M1 名單/預約標 payment_expired、**M2 轉正＋新期限**、計數正取1/候補0→confirm M2 → paid＋期限清除→逾期 M1 再確認 → TRIAL_EXPIRED。fixtures 全清。

## 目前進度（2026-07-13）— refactor：後端大檔案拆分（checkinService＋experienceBookings）
> 使用者指定「後端大檔案拆分」。原則：**函式本體逐字搬移、行為零改動、對外門面/路徑不變**（外部引用檔零修改）。後端 `/health` `2.35.0`→`2.36.0`；commit `a64621e`＋`35dc69f`。
- ✅ **checkinService.js 1523 行 → 門面（33 行）＋ 6 模組**（`src/services/checkin/`）：
  - `pricing`(110)＝票價/會員身份/折扣（隊員9折・舊卡8折・特約）｜`eligibility`(193)＝定期票（購買/續約資訊）/課程學員/VIP/單次券｜`gates`(234)＝墜測（效期/遞延/同意書）/waiver/runEntryGates｜`verify`(256)＝verifyEntry 權威判定｜`flow`(592)＝QR 建立/掃碼/確認/今日統計｜`cancel`(181)＝取消入場/續約還原。
  - 相依為**單向 DAG**（pricing←eligibility←gates←verify/flow/cancel，無循環）；`checkinService.js` 門面 re-export 原 19 個 API，4 個引用路由（checkin/members/fallTests/cancelCheckin）**零改動**。
  - **驗證**：拆前先建 smoke 基準（16 項唯讀呼叫＋fixture，輸出 286 行 JSON）→ 拆後 diff **完全一致**（僅隨機 fixture id 差異）；`loop-test` 90/90；部署後打正式 API 全鏈 E2E（verify→QR 建立→掃碼→確認→取消→沖銷 −400）**6/6**。
- ✅ **experienceBookings.js 896 行 → 路由 551 行＋`services/experienceService.js` 359 行**：搬出 課程/排班建立與清理（add/reassign/cleanup）、體驗入場券（sync/void）、保險名冊 Excel（buildInsuranceXlsBuffer）、`COURSE_TYPES`/`courseTypeLabel`/`parseBookingTime`/`defaultSettings`。部署後 E2E（settings/試上報名佔位/確認/列表 courseTypes/取消釋位）**7/7**。
- 🛠 **拆分技法備忘**：python 以「頂層 binding 行號區間」逐字搬移；跨模組引用偵測**須先去除註解**（否則註解提到函式名會誤判循環相依）；模組深一層時 lazy `require('../…')`→`require('../../…')` 批次改寫；第二層拆分時注意別把第一層產生的同儕 require 當外部 import 複製（會重複宣告）。
- 📌 **courseService.js（1314 行）不拆**——使用者明確決定「課程先不做」（2026-07-13）。除非使用者再開口，不要主動拆；屆時循同法（先 smoke 基準→逐字搬移→diff）。

## 目前進度（2026-07-13）— 會員首頁顯示身份別與效期（攀岩隊員/課程學員）
> 需求：效期內攀岩隊員與課程學員，會員登入後首頁看得到身份別與有效期。後端 `/health` `2.37.0-member-identity-home`；E2E 5/5。commit 後端 `a531853`、前端 `bd3f7f0`。
- ✅ **後端 `GET /members/my/identity`**（會員本人，authenticateAny＋member guard；置於 `/:id` 之前）：`teamMember`＝`isActiveTeamMember` 權威判定（**效期內才回** `{since, until}`，過期回 null）；`courseAccess`＝`checkinService.getCourseAccess`（本就只回有效入館權益）映射 `{courseName, gymAccessStart, gymAccessEnd}`。
- ✅ **前端**（`MemberHomePage`）：已入場橫幅下方顯示身份卡——🏅 **攀岩隊員**（藍卡，效期 since～until）、📚 **課程學員 · 課名**（琥珀卡，入館效期起訖，每門課一張）；效期內才出現、一般會員不顯示。
- **E2E（5/5）**：效期內隊員回 since/until 正確、課程學員含課名＋入館效期（無限練習期間）、**效期外隊員回 null 不顯示**、未登入 401。
- ✅ **使用者實機驗證通過**（建臨時展示帳號 0900101101 登入正式站）：首頁兩張身份卡（🏅隊員效期／📚課程學員入館效期）顯示正確。附帶釐清：**首頁右上角圓圈＝頭像（姓名第一個字、點入個人頁）**——展示帳號名「【練習】…」故顯示「【」，正式會員顯示姓氏，非 bug、使用者確認不改。展示資料（會員/waiver/墜測/課程/場次/報名/pendingCheckIn 共 8 筆）測後全清、0 殘留。

## 目前進度（2026-07-13）— 攀岩隊員入會自動認領（Climbio 對照：墜測＋隊員標記）
> 需求：開始讓攀岩隊員建立會員資料，從 Climbio 抓對照——建好個人資料時自動帶上墜測＋標記隊員（隊籍至 2026/12/31）。後端 `/health` `2.38.0-climbio-team-falltest-claim`；E2E 7/7。commit `dff4900`。
- 🔍 **Climbio 資料源**：本機 `~/Downloads/Customer-2020-06-01-2026-06-06.csv`（18,156 列：日期/姓名/電話/Email/生日/**墜落測驗(通過日)**/親子）。**隊員標在姓名後綴**——如「Allen林祺堂(新竹攀岩隊-2026/12/31)」，共 **41 位**（新竹29/士林11/雙館1，全部 -2026/12/31）。
- ✅ **資料匯入**（firebase-admin，一次性）：`legacyFallTests` **17,335 筆**（去重同電話+姓名取最新；**隊員效期=2026-12-31 與隊籍同步、一般=通過日+1年**；效期內可認領 3,499）＋ `legacyTeamMembers` **41 筆**（{phone, name(去括號), until:'2026-12-31', claimed:false}）。舊 2 筆測試 fixture 已清。
- ✅ **`claimLegacyTeamMember`**（`memberService`，接在 createMember 的 claimLegacyFallTest 之後）：電話+姓名比對 → `isTeamMember:true`＋`teamMemberSince=今日`＋`teamMemberUntil=2026-12-31`；**墜測同步**（尚無 passed 紀錄才建，效期=隊籍到期日）；`claimed` 一次性防冒領；子帳號不認領；隊籍過期名單不認領。
- ✅ **姓名比對放寬**（`cleanLegacyName`＋`legacyNameMatch`，claimLegacyFallTest 同步採用）：去除括號註記後**包含式比對（≥2字）**——Climbio 名常帶英文暱稱（Allen林祺堂/郭芳妤Kate），會員用本名註冊完全相等會漏配；包含式仍防共用電話冒領。
- **E2E（7/7，假 fixtures 不動真名單）**：註冊「測試隊」命中「Allen測試隊」→ 隊員標記 until=2026-12-31＋墜測同步 12-31＋名單 claimed；一般會員「測試妮」命中「測試妮Kate」墜測認領（暱稱包含）且不誤標隊員；過期墜測不認領；同電話重複建 409 PHONE_EXISTS（claimed 為第二道保險）。
- 📌 **隊員入會流程（現在可以開始）**：隊員自助註冊（或店員建）→ 電話+姓名自動命中 → 隊員標記＋墜測帶入 → 只需在 App 簽 waiver＋墜測同意書（onboarding gate）即完成，**不用重測、首頁即顯示 🏅隊員身份卡**。
- ⚠️ **注意**：認領是一次性——若隊員註冊時**電話打錯**或姓名對不上而沒命中，可由店員手動設隊員（團隊管理）＋登記墜測；名單 `claimed` 可 firebase-admin 重置。
- 📋 **已產出「隊員註冊說明」文案**（供使用者貼 LINE 群）：網址 app.redrocktaiwan.com → 註冊；填 姓名/手機/Email/密碼/生日；**強調姓名填中文本名＋手機須與館內登記同號**（比對 key，錯了不帶身份）；註冊後 Email 驗證 → 簽兩份文件；**未成年段**：註冊多填家長姓名/電話/關係、waiver 時填家長 Email、兩份簽完寄一封統一信家長同頁一次簽（72h 效期）、家長簽完前不可入場；自動帶入＝隊員身份(至2026/12/31、9折)＋墜測免重測＋首頁身份卡；沒帶到→聯絡櫃檯手動補。文案在對話中交付、未存檔。
- 📋 **墜測遞延對移轉紀錄同樣適用（查證確認）**：隊員墜測帶到 2026-12-31 只是「起始值」——`tryExtendFallTest`（QR confirm 與電話入場兩路都觸發、取消不計）**每累積 2 次入場自動延 1 年**（從目前到期日往後加、跨門檻一次補齊、留 extensionLog）→ 第 2 次入場即延至 2027-12-31，持續來爬的隊員效期實務上不會到期；只有完全不來的人才會過期需重測。

## 目前進度（2026-07-13）— 會員首頁顯示墜測有效期限
> 需求：首頁「嗨 XXX」下方一排小字顯示墜測有效期限。後端 `/health` `2.39.0-home-falltest-expiry`；E2E 2/2。commit 後端 `7c7ba3b`、前端 `b68b31f`。
- ✅ **`/members/my/identity` 加 `fallTest`**（權威 `checkFallTest`，**含遞延後 `currentExpiresAt`**）：passed→`{status:'passed', expiresAt}`；過期→`{status:'expired', expiredAt}`；未測→null。
- ✅ **首頁**（`MemberHomePage` 問候語下）：通過→小字「🧗 墜落測驗有效至 YYYY-MM-DD」（灰綠）；過期→紅字「🧗 墜落測驗已到期，請重新測驗」；未測不顯示（onboarding gate 本就會擋）。
- **E2E（2/2）**：有效會員回 passed+2026-12-31、過期會員回 expired。
- ✅ **使用者實機驗證通過**（臨時隊員展示帳號 0900202202 登入正式站）：首頁墜測效期小字＋🏅隊員身份卡顯示正確。依回饋調整字級（commit 前端 `610a9e2`）：**問候語名字 12→15px 加粗深色**（「嗨，」維持灰）、**墜測效期 11→10px**。展示資料（會員/waiver/墜測/同意書 4 筆）測後全清、0 殘留。

## 目前進度（2026-07-13）— 首頁身份資訊合併單一方框（隊員/課程學員/定期票，10px）
> 需求：定期票有效期也與課程學員、隊員期限一起顯示在首頁，三項合在一個方框、字級 10px。後端 `/health` `2.40.0-identity-passes`；E2E 通過。commit 後端 `bbfb8b9`、前端 `24da2d7`。
- ✅ **`/members/my/identity` 加 `passes`**：`memberPasses` active＋**已生效（startDate<=今日，未來票不列）**＋未過期；到期日走 `attachEffectiveEndDates`（**臨時休館補償後**，與入場資格同源）；回 `{passTypeName, startDate, endDate, credits(回數票剩次)}`。
- ✅ **首頁**（`MemberHomePage`）：原本隊員/課程學員分開的兩種卡片 → **合併為單一白底方框**，每列 10px——🏅 攀岩隊員 效期 since～until（藍）｜📚 課程學員·課名 入館效期起訖（琥珀）｜🎫 票種名 有效至 endDate（剩 N 次）（紅）。任一存在才顯示方框。
- **E2E**：隊員/課程/定期票三合一正確、未來票不列；「endDate 比存值 +1 天」查明＝**臨時休館補償**（先前颱風休館日落在票期內），設計行為、與入場資格一致（首頁顯示的是實際可用到期日）。

## 目前進度（2026-07-13）— 隊員註冊認領進度統計（17/41）
> 說明貼出後約 1.5 小時內，**41 位隊員已對上 17 位**（另 10 位一般會員也註冊，members 共 27）。**零誤配零漏配**——棘手案例全命中：「Allen林祺堂」→註冊「林祺堂」（英文前綴）、「張祐瑄(…)-ERICA」（括號後綴）、「彭芮妍(妍友)((士林…」（原始資料括號打壞）、榮譽隊員（林芝儀）、雙館（鄧鼎弘）。
- **未註冊 24 位**（士林 9／新竹 15，含賴維治——其早上舊帳號已隨全清空刪除）名單已列給使用者供群組點名；已確認**無漏網**（未認領名單中無人已註冊，不存在「先註冊後上機制」的漏標）。
- 📌 之後查最新進度：掃 `legacyTeamMembers` 的 `claimed` 旗標即可（claimedBy/claimedAt 有完整記錄）。

## 目前進度（2026-07-13）— 認領隊員同步寫入員工端「2026 攀岩隊員名單」
> 需求：已註冊的隊員也要出現在員工端攀岩隊員管理的 2026 名單。名單資料源＝`teamApplications`（year=2026），自動認領原只寫 member 文件 → 補。後端 `/health` `2.41.0-team-claim-roster`；commit `081a6cb`。
- ✅ **`claimLegacyTeamMember` 擴充**：認領時同步 upsert `teamApplications/team_{memberId}_{year}`——`status:active`＋`paymentStatus:confirmed`（隊費舊系統已繳）＋`source:'climbio-migration'`＋`primaryGym` 依 Climbio 標記（新竹紅石／士林紅石／士林/新竹）；已存在不覆寫。之後註冊的隊員自動出現在名單。
- ✅ **回填已認領 19 位**（firebase-admin，`paidAt/createdAt` 沿用認領時間）；驗證 `GET /team-members/members?year=2026` 回 **20 筆**（19 Climbio 移轉＋1 既有陳品翰）、館別/狀態正確。
- 📌 認領進度此時 **19/41**（陳楚狄於統計後註冊完成）。

## 目前進度（2026-07-13）— 2026 隊員名冊精簡（✅/❌ 欄）＋隊服領取欄位
> 需求：名冊的已收款/正式隊員/隊服領取改 ✅❌ 顯示、縮小列面積。後端 `/health` `2.42.0-jersey-received`；commit 後端 `5661fb9`＋`db1155b`、前端 `35c8454`。
- ✅ **名冊列精簡**（`VipPage` 攀岩隊員管理）：原「繳費兩行＋狀態兩顆膠囊＋隊服文字」→ 繳費壓成單行小字（NT$金額·日期）＋三個置中窄欄 **已收款／正式隊員／隊服領取** 用 ✅/❌（hover title 顯示完整狀態；用 emoji 非 ✓✗ 字元、避 tofu，見 [[ui-icon-css-not-glyph]] 慣例例外：彩色 emoji 安全）。
- ✅ **隊服領取（新欄位 `jerseyReceived`）**：名冊列**直接點 ✅/❌ 切換**（樂觀更新＋PUT）；尺寸以 9px 小字附註於 icon 下；`noJersey` 顯示「—」不可點。編輯 Modal 加「隊服已領取」勾選（不拿隊服時 disabled）。後端 `PUT /team-members/applications/:id` allowed 加 `jerseyReceived`。
- ✅ **點列開動作 Modal**（依回饋補回動作鍵，commit 前端 `73c9272`）：移除「操作」欄 → **點會員列**跳 Modal——顯示 收款/隊籍/隊服 三狀態摘要＋動作鍵：**💵 確認收款**（未收款且未退隊才顯示，走既有 `confirm-payment` 端點、冪等）、**✏️ 編輯資料**（開既有編輯 Modal）、**🗑 刪除**（沿用確認流程）。隊服 ✅/❌ 直點切換保留（`stopPropagation` 不觸發列點擊）。
- ✅ **繳費欄兩列＋表頭對齊**（`dfe5e0a`）：金額（粗體千分位）/日期 上下兩列；會員/繳費 th 與 td padding 統一。
- ✅ **會員欄三列＋修「編輯存了沒生效」**（`52ee00a`）：會員欄改 姓名/電話/場館 三列。查陳品翰「2700 與隊服存了仍錯」——後端 PUT 實測正常，**根因在前端輸入層**：①繳費金額 `type="number"` 遇無效輸入（貼「2,700」等）onChange 回空字串 → 後端 `Number('')||0` 存 **0**、畫面回退顯示應繳像沒存；②他原勾「不拿隊服」→ 尺寸/已領取欄位**反灰禁用**、改了不進狀態。修：金額輸入改 `text+inputMode numeric`＋onChange 濾非數字。⚠ 除錯過程以 PUT 測試寫入陳品翰＝`paymentAmount 2700、noJersey:false、jerseySize M、jerseyReceived:true`——**隊服部分為測試猜值，請使用者核對**（若他實際不拿隊服需改回）。
- ✅ **繳費欄區分實繳/應繳**（`7ccaae0`）：使用者追問「金額 0 為何顯示 1700」——原 `paymentAmount || expectedFee` 回退把實繳 0 無標示地顯示成應繳（1700＝陳品翰自助申請算的 年中2000−不拿隊服300），混淆兩者。改：**實繳>0 → 深色「NT$X」；實繳 0 → 琥珀色「應繳 NT$Y」**（明確標示未收）。備忘：`expectedFee`（應繳）與 `paymentAmount`（實繳）為獨立欄位，顯示時不可無標示混用。

## 目前進度（2026-07-13）— 入隊申請退回流程補齊（已退回狀態＋Email 通知＋重新上傳）
> 回報（陳品翰案例）：入隊申請被退回會員零通知；申請後應為「待審核」；退回後應為「已退回」。後端 `/health` `2.43.0-team-apply-reject-flow`；E2E **8/8**。commit 後端 `3907609`、前端 `727109c`。
- 🔍 **根因**：`transfers` 退回連動的 `REJECTABLE_COLL` **刻意排除 team_member**（1.91.0 註記「活動化流程另計」）→ 員工在待辦退回入隊轉帳單時，`teamApplications` 完全不動、會員零通知。（申請端點本就正確寫 `pending/pending`＝待審核；陳品翰名冊顯示「已收款/正式隊員」是編輯視窗手動誤設，非流程自動。）
- ✅ **後端**（`transfers.js`）：`REJECTABLE_COLL` 納入 `team_member→teamApplications` —— **退回**：申請標 `status:'rejected'`（已退回）＋`paymentRejectReason`＋**Email 通知會員**（含原因，寄信失敗不阻斷）；**會員重新上傳**：申請回 `status:'pending'`（待審核）＋清退回標記（upload 擁有權檢查一併生效）；**確認收款** side-effect 原本就有（active＋setTeamMember 開通資格）不變。
- ✅ **前端**：`MemberTeamPage` STATUS 加 `rejected`「已退回」（紅）、pending 文案改「**待審核**」；當年度申請被退回 → 顯示原因＋**匯款日期/末五碼重新上傳表單**（`/transfers/upload` type team_member）。`VipPage` 名冊 stTag／編輯選項／動作 Modal 補「已退回」。
- ✅ **陳品翰資料修正**：申請改 `rejected/transfer_rejected`＋原因（「不用測試囉!!」，取自被退回的轉帳單）、繳費/隊服欄位還原、**撤銷誤開的隊員資格**（編輯視窗設 active 時 PUT 會 setTeamMember 同步，已 remove）。
- **E2E（8/8）**：申請→待審核 → 上傳轉帳（FormData，multer 端點）→ 退回→已退回＋原因 → 重新上傳→回待審核＋清標記 → 確認收款→正式隊員＋資格開通 until=2026-12-31。
- 💡 **教訓**：`/transfers/upload` 走 multer → 測試/呼叫須用 **FormData**（urlencoded 不會被解析、回 NO_PROOF）。

## 目前進度（2026-07-13）— 轉帳退回：會員首頁通知 + 全類型 Email 通知
> 承入隊申請退回流程（2.43.0）：使用者要求「退回的資訊，在會員首頁都加入通知，同時 email 通知會員」→ 擴及**全部訂單類型**（課程/體驗/比賽/租借/入隊）。後端 `/health` `2.44.0-reject-home-alerts-email`；E2E（打 Railway）**15/15**。commit 後端 `c39ebc0`、前端已 deploy。
- ✅ **退回 Email 全類型通用**（`transfers.js` reject）：原只 team_member 寄信 → 改所有 `REJECTABLE_COLL` 類型都寄——email 解析順序 `order.memberEmail || order.contactEmail || members 集合（依 memberId 權威反查）`；主旨「【紅石攀岩】<類型>轉帳確認未通過」含訂單名稱＋退回原因；try/catch 寄信失敗不阻斷退回。
- ✅ **首頁退回通知端點 `GET /members/my/alerts`**（`members.js`，authenticateAny member、放在 `/:id` 之前）：查**本人＋子女**（`parentMemberId==本人`）五訂單集合（courseEnrollments/experienceBookings/competitionRegistrations/equipmentRentals/teamApplications）`paymentStatus=='transfer_rejected'` → 回 `{type,label,link,name,reason,memberName(子女才有)}`；course 依 courseId 去重。**重新上傳補正（→pending_confirm）後端點即不再回傳、通知自動消失**。
- ✅ **前端首頁橫幅**（`MemberHomePage`）：紅色警示卡（⚠️「<類型>轉帳被退回：<名稱>（👦 子女名）／原因：<原因>，請點此重新上傳」）置於今日已入場橫幅下、身份方框上；點擊導向對應頁（course→/member/courses、experience→/member/experience、competition→/member/competitions、rental→/member/rental、team_member→/member/team）。
- **E2E（15/15）**：注入練習會員A＋子女C＋體驗訂單(A)/課程報名(C) → 退回兩筆（訂單 transfer_rejected＋原因）→ alerts 回 2 筆（子女標 memberName、link/原因正確）→ 未登入 401 → 會員 FormData 補正體驗（`/transfers/upload`）→ 訂單回 pending_confirm、alerts 剩 1 筆 → 清理 0 殘留。腳本 `scratchpad/reject-alerts-e2e.cjs`。
- ⚠️ **E2E 細節**：`/transfers/upload` 欄位名是 `bankLastFive`/`paymentDate`（非 last5/transferDate），漏帶且無截圖 → 400 `NO_PROOF`。
- ✅ **體驗/比賽/租借 補正 UI 已補齊**（純前端，commit `c0f43f9`，member/staff 已 deploy；E2E 12/12）：新共用元件 `TransferReuploadModal`（退回原因＋匯款日期/末五碼/截圖擇一，走 `/transfers/upload`）；三頁「我的」清單卡片對 `paymentStatus==='transfer_rejected'` 顯示紅框退回原因＋「重新上傳轉帳」鈕、`pending_confirm` 顯示「轉帳確認中」；比賽 `payStatusBadge` 加對應徽章。course/team 沿用各自既有補正表單。→ **五類型退回→補正 UI 全數到位**。E2E（比賽+租借，打 Railway）：退回→alerts 2 筆→會員補正→pending_confirm＋清標記→alerts 清空→0 殘留。腳本 `scratchpad/reject-reupload-comp-rental-e2e.cjs`。三個「我的」端點（`/experience-bookings/my`、`/competitions/registrations/member/:id`、`/rentals/my`）本就回完整 doc，後端免改。

## 目前進度（2026-07-13）— 家庭成員文件簽名標籤改「法定代理人簽名」（純前端）
> 需求：家庭成員（子會員）的風險安全聲明書/墜落測驗同意書，簽名欄不寫「本人簽名」、改「法定代理人簽名」，轉出（列印/PDF）文件也是。純前端 `redrock-web`，commit `0e7e8f7`，member/staff 皆 deploy。
- ✅ **會員端代簽頁**（`?forChild` 模式）：`MemberWaiverPage` 簽名區加標題（代簽→「✍️ 法定代理人簽名」、本人→「✍️ 本人簽名」）；`MemberFallTestPage` 簽名區標題/已簽檢視標籤/錯誤訊息三處依 `forChildId` 切換。
- ✅ **員工端副本＋列印**（`MembersPage`）：Waiver 副本 Modal 與 🖨️ 列印/PDF、墜測同意書副本 Modal 與列印——簽名標題依 `detail.member.isChildAccount` 顯示「法定代理人簽名」（成人維持「本人簽名」）。
- 📌 **判定依據**：waiver/簽署文件本身無 isChildAccount 欄位 → 檢視/列印時以**會員文件的 `isChildAccount`** 判定；會員端以 URL `forChild` 參數判定。未成年本人帳號的家長遠端共簽（`ParentWaiverPage`）本就標「家長／監護人簽名」、不在此範圍。

## 目前進度（2026-07-13 續）— 全站「家長／監護人簽名」統一改「法定代理人簽名」＋修比賽家長簽署信連結
> 承子會員標籤改法定代理人：使用者要求**其他需要法定代理人簽名處全部寫清楚、既有「家長／監護人簽名」一律改「法定代理人簽名」**。後端 `/health` `2.45.0-legal-guardian-labels`；commit 後端 `990bb12`、前端 `e51f6d7`，兩端已 deploy。
- ✅ **前端全面改標籤**（14 檔）：家長遠端簽署頁 `ParentWaiverPage`/`ParentCompetitionWaiverPage`（標題「法定代理人簽署」、聲明「本人作為法定代理人（家長／監護人）」、簽名欄「法定代理人簽名：」）；`MemberFallTestPage`（簽名區/已簽檢視/未成年說明）；`MemberWaiverPage`（未成年資訊區「法定代理人資訊/Email/姓名/聯絡電話」、錯誤與提示文案）；`MemberProfilePage`（已簽檢視「法定代理人簽名」、等待徽章、relation fallback）；`MemberHomePage`/`MemberQRPage`/`MemberOnboardingGate` 等待簽署文案；`MemberRegisterPage`（未成年區塊標題/欄位全改法定代理人）；`MemberCompetitionsPage`/`MemberCoursesPage`「✓ 法定代理人已儲存簽名」；員工端 `MembersPage`（待辦標籤「待法定代理人簽署」、waiver/墜測副本 Modal＋列印、家長簽名區 h3）、`CompetitionsPage`（「待法定代理人簽」）、`FallTestBookingModal`（審核簽名 label）。
- ✅ **後端使用者可見文案**：`members.js`（PARENT_EMAIL_REQUIRED 訊息、簽署成功訊息）、`checkin/gates.js`（waiver 關卡等待訊息）、`competitions.js`（報名清單「待法定代理人簽名」）、`waiverService`（重發連結訊息）、`emailService`（waiver 家長信主旨「請完成 X 的法定代理人簽署」、稱謂 fallback）。
- 🐞 **順修 pre-existing bug：比賽未成年報名家長簽署信連結無效**——原呼叫 `sendParentWaiverLink`（連 `/waiver/parent/:token`，該頁查 members 的 waiver token），但**比賽 token 存在 `competitionRegistrations`、專屬頁是 `/competitions/waiver/parent/:token`** → 家長點信中連結必顯示「此連結無效」。新增 `emailService.sendParentCompetitionWaiverLink`（正確 URL、主旨帶賽名、比賽專屬文案），`competitionService` 報名改用之。waiver 流程的 `sendParentWaiverLink` 呼叫端（簽署觸發/重發）不受影響。
- 📌 DB 欄位（`parentName`/`guardianSignatureData` 等）與 API 參數皆不動、純文案；`parentRelation` 顯示 fallback「監護人」→「法定代理人」。

## 目前進度（2026-07-13 續）— 會員自助註冊電話開放國際格式
> 原自助註冊只收台灣手機 `^09\d{8}$`（外籍會員只能由店員建立）。改與店員建立會員同規則。後端 `/health` `2.46.0-self-register-intl-phone`；E2E 4/4。commit 後端 `48fd2b1`、前端 `6476726`。
- ✅ **`POST /members/self-register` 與 `/:id/promote`（子會員升級）**：電話 regex 改 `^09\d{8}$|^\+\d{7,15}$`（台灣手機 或 `+` 開頭 7~15 碼國際格式），錯誤訊息一併說明兩種格式。店員 `POST /members` 本就支援、不動。
- ✅ **前端**（`MemberRegisterPage`）：電話欄 placeholder 加註「外籍：+ 開頭國際格式」。
- **E2E（打 Railway）**：`+85291234567` 註冊 201、台灣 `09…` 仍 201、`12345`／`+123` 皆 400；測試會員已 DELETE 清乾淨。
- 📌 電話唯一性、子會員共用電話、登入 identifier 解析皆不受影響（存字串比對、與格式無關）。

## 目前進度（2026-07-13 續）— 修 Email 驗證「要試好幾次才成功」（姜凱文/王內均回報）
> 回報：點信箱驗證連結後，登入資料要重填、重新驗證連續試好幾次才成功。查明為三個缺陷疊加的故障鏈。後端 `/health` `2.47.0-email-verify-result-page`；E2E（打 Railway）**13/13**。commit 後端 `1e65779`、前端 `c3bed01`。
- 🔍 **根因（三缺陷疊加）**：
  1. **前端根本沒有 `/member/verify` 這個 route**——後端驗證後 redirect 到 `CLIENT_URL/member/verify?status=…`，被 SPA catch-all 丟回登入頁 → **驗證成功或失敗零回饋**，會員以為沒成功。
  2. **重寄驗證信每次換新 token** → 舊信連結全部失效；信箱裡多封信點到舊的 → 「無效」（也一樣被丟回登入頁看不到錯誤）。
  3. **token 用完即毀 + 不冪等**：驗證成功把 token 設 null，重複點擊/信箱安全掃描預抓 → 查無 token → INVALID_TOKEN。
  - 「資料要重填」＝每輪重試都回到空白登入頁重打帳密＋重寄面板；「試好幾次」＝多封信只有最新一封有效。兩位會員資料最終皆 `emailVerified:true`、各僅一帳號，無資料損壞。
- ✅ **修法**：
  1. **新增前端結果頁 `MemberVerifyResultPage`**（route `/member/verify`，公開）：成功／已驗證過（`already=1`）／連結無效／連結過期 四態＋「前往登入」。
  2. **重寄沿用未過期原 token**（`sendEmailVerification` 先讀既有 token，未過期就沿用、效期展延 24h）→ 多封信連結一致、點任一封皆有效；過期才換新。
  3. **驗證冪等**（`memberService.verifyEmail`）：已驗證再點任何連結 → 回成功（帶 already）；token 保留不再 null（重複點擊由 emailVerified 冪等擋，預抓消耗 token 的誤判消失）。
- **E2E（13/13）**：註冊→未驗證登入 403→重寄 token 沿用→點連結 302 success→emailVerified/token 保留→重複點 success&already→登入 200→假 token error 頁→前端頁 200；測試會員清乾淨。

## 目前進度（2026-07-13 續）— 單次入場券發放：備註必填 + 審核可見發放值班人員
> 需求：票券單次發放要多備註說明填寫、自動記錄值班人員、管理員審核通知看得到。查證：發放表單本有選填備註、後端本就存 `soldByStaffId/Name`（值班 operator token 即該員工）——缺的是**必填**與**審核端顯示**。後端 `/health` `2.48.0-ticket-issue-notes-required`；E2E 10/10。commit 後端 `99c9f62`、前端 `631d1bd`。
- ✅ **備註改必填**（後端權威）：`POST /passes/single-entry` validator `notes` trim 後不可空 → 400「請填寫備註說明（發放原因）」；前端發放 Modal 標籤改「備註說明（必填，發放原因；管理員審核時會看到）」＋送出前擋。
- ✅ **管理員審核三處可見**：①站內**通知內文**帶「（備註：…）」（原本只有發放人＋會員名）②**待辦清單** desc 帶「（XX 發放）」③**審核 Modal**（`TicketApprovalModal`）加「發放人員（值班登記）」與「備註說明」兩列（未填寫顯紅字——僅舊資料會出現）。
- **E2E（10/10）**：無備註/空白備註 400 → 有備註 201 → 票券存 notes＋soldByStaffName → 待辦 task.record 含兩者、desc 帶發放人 → 通知內文含備註；測試資料（會員/票券/通知/交易）清乾淨。

## 目前進度（2026-07-13 續）— 商品促銷價改「有填即生效」（修結帳仍原價）
> 回報：商品已設促銷價、銷售結帳仍原價。查明＝原設計**兩段式**：填促銷價只是設金額，還要在商品清單按各變體「促銷狀態→開啟」（`promoActive`）才生效——實掃正式庫**45 個設促銷價變體（15 款鞋）`promoActive` 全為 undefined、0 個開啟**＝整批卡在沒開。AskUserQuestion 拍板：**改「有填促銷價即生效」**。後端 `/health` `2.49.0-promo-price-auto-active`；E2E 5/5。commit 後端 `885f6b4`、前端 `6e21114`。
- ✅ **後端**（`products.js`）：`POST /products/sell` 結帳單價與匯出 CSV「促銷狀態」改以 `promoPrice` 有無判定（不再看 `promoActive`）；**移除** `PUT /:id/variants/:variantId/promo` 開關端點。→ 既有 45 個變體**自動生效**、無需資料 migration（promoActive 欄位留存但全系統不再讀）。
- ✅ **前端**（`SalesPage`）：POS 加購物車單價、商品卡價格範圍、購物車促銷標示、變體 modal 價格全改 `promoPrice` 判定；商品清單「開啟/促銷中」toggle 按鈕改**靜態「促銷中」標籤**（有填即顯示）、移除 `handleTogglePromo`。要停促銷＝編輯變體清空促銷價。
- **E2E（打 Railway 假商品，5/5）**：v1 促銷 1800/v2 無促銷 3000 → `/products/sell` 收 **1800＋3000＝4800**（促銷生效、無促銷原價）；測後 sale/交易/商品清乾淨。

## 目前進度（2026-07-13 續）— 課程樹狀架構全面改造（大類→班別→梯次＋規則繼承）
> 使用者逐項確認後的大改造（趁零報名窗口）。後端 `/health` `2.50.0-course-tree-category-rules`；E2E（打 Railway）**25/25**。commit 後端 `289dc73`、前端 `ed4f4bc`；資料歸位腳本 `scratchpad/course-tree-migrate.cjs`（已 commit 執行）。
- **最終規格（五點+追加確認）**：樹＝館別→**大類四個**（adult 成人班／youth 青少年兒童班／special 專班課程／workshop 工作坊）→班別→梯次（自訂名稱 `cohortName`，顯示名 `name`＝班別名+梯次名，改名自動重組）→場次；兩館共用班別定義。
- ✅ **班別層（courseCategories 重寫）＝共用**：課程介紹＋廣告照片（上傳走 Storage `/course-categories/:id/image`）＋八項規則（試上開關/試上費、請假截止/次數、補課開關/期限、退費每堂扣除/手續費率）＋**補課群組 `makeupGroup`**＋大類 `group`＋`sortOrder`；`DELETE ?permanent=1`（底下有梯次擋 409）。
- ✅ **規則繼承（courseService `RULE_DEFAULTS`+`resolveRules`）**：梯次欄位 **null＝繼承班別、有值＝覆寫**；讀取點全改——請假（`requestLeave` 截止/次數）、補課（產生開關/期限）、試上（`getTrialSessions`＋experience 試上分支）、退費（`courseAdjustments` 每堂扣除/費率）、會員報名卡請假上限顯示。**勿再直接讀 course 規則欄位**。
- ✅ **補課兩變更**：期限改「**課程結束日**＋N天」（原請假堂日期起算）；範圍改「**同補課群組**＋同館」（原同類別）——小蜘蛛人入門+進階同群組 `makeup-spider` 可互補。
- ✅ **體驗預約只留「抱石體驗課程」**：children/skill_fri/skill_sun14 標 `active:false`（settings+defaultSettings），建立預約後端擋 `INVALID_COURSE_TYPE`；由班別試上承接（小蜘蛛人入門班試上600、技巧班1075 週日梯開梯時覆寫900）。試上流程沿用（佔位/候補/發單日券不卡墜測）。
- ✅ **資料歸位（migrate 腳本，已執行）**：建 9 班別（成人5：入門/進階/技巧/週期訓練/矯正；青少年兒童4：青少年/青少年進階/小蜘蛛人入門/小蜘蛛人進階）；11 梯 reassign＋`cohortName`＋規則歸零(null)；小蜘蛛人海報/介紹（276字）搬入門+進階班別；**刪一A(7-8)閎重複梯＋9場次、刪全部舊類別**；佔用名額/教練/價格不動。
- ✅ **員工端**（`CoursesPage`）：「類別管理」→「**班別管理**」（大類分組列表＋完整班別表單 Modal：大類/名稱/介紹/照片/規則/補課群組）；「新增課程」→「**加開梯次**」兩步 Modal（1 班別 optgroup+梯次名稱+類型+館別+複製 → 2 梯次資料+插班加成+分期+**收合「覆寫班別規則」區**，placeholder 顯示班別預設值）；編輯梯次改覆寫語意（留空=班別預設、三態 select）、移除說明/海報；課程列表加大類分區。
- ✅ **會員端**（`MemberCoursesPage`）：課程總覽**三層**（大類標題→班別卡→梯次列→報名）；班別層海報/介紹改讀 `categoryImageUrl/categoryDescription`（getCourses 新回傳，fallback 舊 course 欄位）；體驗頁 fallback 類型只留抱石體驗。
- **E2E（25/25）**：9班別/大類/補課群組/試上費600·1075 → 課程帶班別資訊/海報 → 入門班53場進試上清單$600、進階班不在 → 請假繼承（2次上限、第3次擋）→ 補課期限=結束日+60 → **補課跨群組驗證**（補成人入門擋 DIFFERENT_CATEGORY、補小蜘蛛人進階 200）→ 退費 850×2堂 → 加開梯次 name 組合/覆寫 maxLeaves=5 其餘 null/改名重組 → 體驗 children 擋。fixtures 全清（含進階場次計數還原）。
- ⚠️ **注意**：①規則读取一律走 `resolveRules`（course 欄位 null 是常態）；②工作坊未來開設放 workshop 大類；③`docs/course-experience-features.md` 尚未依新架構改寫（下次動課程文件時一併）。

## 目前進度（2026-07-13 續）— 課程樹改造收尾：班別管理實機驗證＋編輯鈕顏色修復
> 上線後使用者實測回饋兩項，皆已處理。純前端 `redrock-web`，commit `2f2849e`，已 deploy＋瀏覽器實機驗證。
- ✅ **「沒地方建專班課程/新增班別」→ 位置確認**：員工端 課程 → 「🏷️ 班別管理」分頁 → 右上「＋新增班別」，大類下拉含 專班課程/工作坊；課程介紹與廣告照片也在此（該班別「編輯」Modal），非梯次編輯。使用者已找到。
- ✅ **修：班別列表「編輯」鈕文字看不見**：按鈕漏設 `color`，使用者系統為深色模式（index.css `color-scheme: light dark`）→ 按鈕文字繼承白色、白字白底隱形（「停用」有設紅色故正常）。補 `color:'#444'`；全檔掃描 0 個其他漏設 color 的按鈕。瀏覽器實機確認編輯/停用並排可見。
- ✅ **按鈕文字對齊新架構**（commit 前端 `6ef6b4f`）：課程列表右上「＋ 新增課程」→「**＋ 加開梯次**」（該鈕開的本就是加開梯次兩步 Modal，僅文字漏改）。語意定案：建班別＝班別管理「＋新增班別」；開梯次＝課程列表「＋加開梯次」。
- 💡 **教訓**：白底/無底按鈕必須顯式設 `color`——專案 root 有 `color-scheme: light dark`，深色模式下未設色的按鈕文字會變白（同 [[ui-icon-css-not-glyph]] 類的裝置差異坑）。

## 目前進度（2026-07-13 續）— 體驗類型徹底清除 + 編輯梯次下拉修復
> 兩件收尾。後端 `/health` `2.51.0-experience-general-only`；commit 後端 `895a0db`、前端 `0290904`。
- ✅ **體驗課程只留「抱石專班體驗課程」（徹底移除、非停用）**：`experienceService.defaultSettings` 刪除 children/skill_fri/skill_sun14 三entry；Firestore `systemSettings/experienceCourses.courseTypes` 同步清除（僅剩 `general`，其 label 本就是「抱石專班體驗課程」）。打正式 API 驗證 courseTypes 只回一種；員工體驗設定頁/會員預約頁皆動態讀設定、自動只剩一種。三種由班別試上承接。歷史 booking 無殘留引用（7/13 會員清空時已清）。
- ✅ **修：編輯梯次「開放補課/開放試上」下拉改了會跳回**：三態 select 的 value 判斷只認布林（`=== true/false`），但 onChange 存字串 `'true'/'false'` → 一選顯示就回跳「班別預設」（存檔其實會生效、純顯示 bug）。改 `String(v)` 相容布林與字串。加開梯次 Modal 的同型下拉直接綁字串、本就正常。

## 目前進度（2026-07-14）— 舊系統 90 日票名單移轉（BeClass Numbers 檔 → 註冊認領＋回填）
> 使用者提供 `~/Downloads/294fdfd677f8ff564b6d83958178.numbers`（BeClass 90日票購買名單，Numbers 檔以 `numbers-parser` 解析）。定案：**註冊時自動認領＋發 90 日定期票（全館通用、沿用名單原起訖日、嚴格檢查效期）＋通知系統管理員＋進會員定期票列表**。後端 `/health` `2.52.0-legacy-90day-pass-claim`；E2E（打 Railway）**10/10**。commit `1d8a3ef`。
- **名單內容**：23 筆有效 90 日票（新竹 21／士林 2；效期 2026-07-14 ~ 10-05 之間到期；另 1 筆 2025 舊紀錄忽略）。
- ✅ **`legacyPasses` 集合**（doc id `90day-<項次>`，冪等匯入）：seq/name/phone/email/gymId/invoice/paymentMethod/startDate/endDate/claimed。腳本 `scratchpad/import-legacy-passes.cjs`。
- ✅ **`memberService.claimLegacyPass`**（createMember 內、接在隊員認領後）：電話+`legacyNameMatch` 比對、`claimed!==true`、**`endDate>=今日` 才發**（過期不發不標記）→ 建 memberPass（票種對照「90日定期票」、`scope:'shared'` 全館、**startDate/endDate 沿用名單原值不重算**、`source:'legacy-90day'`、notes 帶 BeClass 項次+發票號）→ 名單標 claimed → `notifyRoleInGym` 通知同館 gym_manager＋super_admin（type `legacy_pass_claimed`）。全程 try/catch 不阻斷註冊。
- ✅ **回填已註冊 15 位**（柯景倫/黃凱聖/傅伊雯/黃淵暐/黎家豪/李錦州/Raissa/丁厚獻/陳錦漩/林祺堂/曾聖發/田一宏/楊雅雯/曹惟森/謝旻恩）：直接發放＋標記＋通知 3 位管理員；**未註冊 8 位**（李應崇/林芝韻/劉泓予/謝佑欣/廖有福/曾宥勝/林修維/黃永豪）待註冊自動認領。
- **E2E（10/10）**：注入有效/過期兩筆假名單 → 自助註冊 → 有效者自動發票（原效期/shared/active）＋名單標記＋管理員通知 3 則；過期者不發不標記；會員 `/passes/member/:id` 列表可見（顯示為**臨時休館補償後**到期日、`baseEndDate` 保留原值）。fixtures 全清。
- 📣 **已產出 8 位未註冊者群組通知文案**（內部含電話對照表＋隱電話群組版；依票到期排序，**李應崇 7/18 最急**）：李應崇/林芝韻/劉泓予(士林)/謝佑欣/廖有福/曾宥勝/林修維/黃永豪。查最新認領進度：掃 `legacyPasses` 的 `claimed` 旗標。
- 📌 **Numbers 檔解析法**：`.numbers` 為 IWA zip，本機無 Apple Numbers → scratchpad venv `pip install numbers-parser` 直接讀表格（`Document(...).sheets[0].tables[0].rows(values_only=True)`）。

## 目前進度（2026-07-14）— 隊員認領進度 23/41 + 名冊同步查核 + 催註冊文案
> 純查核與文案產出、無程式異動。
- 📊 **隊員認領進度 23/41**（7/13 統計 19 → +4）：未註冊 **18 位**——士林 7（黃培倫/蔡至誠/賴維治/郭芳妤/盧孟立/周正晏/潘柏甫）、新竹 11（曾智妍/李宥儒/張景欣/丁宣勻/彭健鈞/黃芸茵/張芝翠/王妤㚬/蘇郁茹/陳莉庭/羅俊逸）。
- ✅ **員工端 2026 名冊全同步**（查核）：23 位已認領隊員全部在 `teamApplications`（2.41.0 認領即自動寫入，之後新認領即時進名冊）；名冊共 24 筆＝23 移轉＋陳品翰（自走申請、退回後已補正、**pending 待確認收款**）。
- 📣 **已產出隊員版群組催註冊文案**（列 18 位姓名、強調本名+館內登記手機、自動帶隊員資格/墜測免重測、未成年家長簽署說明）；連同 90 日票 8 位文案於對話中交付。查最新進度：`legacyTeamMembers.claimed`。

## 目前進度（2026-07-14）— Railway 服務短暫下線事故（已恢復）
> 回報「隊員名冊/定期票名單不見」→ 查明＝**整個後端 API 下線**（Railway edge 回 404「Application not found」，非資料問題）。使用者於 Railway dashboard 恢復服務後全面驗證正常。
- 🔍 **排查**：Railway 平台無事故（官方狀態頁）、程式碼無問題（掛掉前最後三次部署皆純文件）；「Application not found」＝服務被下線的典型回應（最可能為 Hobby 方案用量額度用罄自動暫停——本月部署極頻繁）。
- ✅ **恢復後驗證**：`/health` `2.52.0`（免重部署）；隊員名冊 25 筆（停機期間又 +1 認領）、定期票報表正常（90日票 16 人＋半年票 1 人）、班別 9 個、體驗設定正常。**資料零遺失**（Firestore 不受影響）。
- 📋 **Railway 用量組成釐清**：大宗＝**服務 24h 常駐（RAM/CPU × 時間）**，與流量/會員數幾乎無關；頻繁部署有小幅貢獻（build 分鐘＋切換期新舊實例並存）、會員註冊/API 流量可忽略。確認：dashboard Usage 頁看 Compute/Egress/Build 拆分。**用量警示設定**：Workspace Settings → Usage → Usage Limits——Soft Limit（email 警示，建議額度 7 成）＋ Hard Limit（到達直接停服務，**建議不設或設很高**，這次下線即此效果）。正式營運建議升級按量計費（小服務約 $5–10/月），避免無預警斷線。
- ⚠️ **提醒**：Railway 額度用罄會直接下線服務 → 兩館入場/登入/POS 全停。建議 dashboard 設用量警示或升級方案；日後再遇「所有名單同時消失」先打 `/health` 判斷是否服務層問題。

## 系統依賴盤點（2026-07-14）
| 服務 | 用途 | 備註 |
|---|---|---|
| Firebase（`redrock-dev-a35c1`） | Firestore 資料庫／Hosting 前端兩站／Storage 圖檔 | 免費額度內 |
| Railway | 後端 API（GitHub push 自動部署，24h 常駐） | **主要付費點＋唯一全站單一故障點**（7/14 額度下線事故） |
| Resend | 所有 Email（Railway 封鎖 SMTP 故走 REST API） | 免費 100 封/天 |
| Porkbun | 網域 `redrocktaiwan.com`（app./staff. DNS → Firebase Hosting） | 年費 |
| GitHub | 兩 repo（api push 觸發 Railway 部署） | 免費 |

未啟用：LinePay/街口/台灣Pay（adapter 骨架待金鑰）；BeClass（逐步取代中）；Climbio（資料已移轉完）。金鑰全在 Railway 環境變數。
**Railway 停機應變手冊：`docs/outage-playbook.md`**（櫃檯紙本 SOP／管理員恢復程序／用量警示與 UptimeRobot 設定／api.redrocktaiwan.com 自訂網域＋Render 冷備的故障轉移步驟／長期 Cloud Run 選項）。

## 目前進度（2026-07-14）— 員工端課程列表條列式 + 佔用名額透明化
> 兩項 UI/資料改善。後端 `/health` `2.53.0-reserved-slots-note`；commit 後端 `5fb142f`、前端 `3a9b523`＋`1fe0a5d`；瀏覽器實機驗證通過。
- ✅ **課程列表改條列式**（原名片式難閱讀）：第一層班別列（名稱｜梯數｜價格範圍｜正取合計｜›）、第二層梯次列（名稱+徽章＋小字 時段/起訖/教練｜價格｜人數｜動作鈕 場次/名單/停用/取消/刪除）；**點梯次列直接開編輯 Modal**（動作鈕 stopPropagation；已取消梯次不可點）。
- ✅ **佔用名額透明化**（回報「6/6、1/6 是什麼」「查詢為何被佔用」）：人數欄拆兩行「N/上限 人」＋小字「**系統 X＋佔用 Y ⓘ**」（hover 顯示佔用說明）；梯次新增 **`reservedSlotsNote` 佔用說明欄位**（create/PUT 支援、編輯 Modal 可改）；現有 9 個有佔用梯次回填「BeClass 舊系統報名帶入（2026-07-09…實際名單在 BeClass）」。
- 📋 **人數語意備忘**：`enrolledCount`＝系統實報名＋`reservedSlots`（BeClass 靜態帶入、不自動同步）；會員端「剩 N 位/額滿」同源。佔用「逐人名單」系統沒有——若要可再匯 BeClass 報名表（塞說明或做註冊認領）。

## 目前進度（2026-07-14 續）— 加開梯次入口調整＋空班別顯示（純前端）
> 兩項動線修正，commit 前端 `e3d89cf`＋`4adfd2a`，已 deploy＋瀏覽器實機驗證。
- ✅ **「＋加開梯次」只在點入班別（第二層）顯示**：課程總頁（第一層）不再出現；按鈕固定預帶當前班別（Modal 開啟即選好、直接填梯次名稱）。
- ✅ **四大類固定顯示＋士林館可見全樹**（commit 前端 `aa66850`，實機驗證）：專班課程/工作坊（暫無班別）也顯示大類區塊＋「尚無班別——到班別管理新增」佔位；**移除「0 門課→目前沒有課程」提早空狀態**——士林館檢視（0 梯次）也完整顯示 四大類→九班別（全標尚未開課），點入即可為該館加開梯次。
- ✅ **空班別也列在課程總頁**：啟用但尚無梯次的班別（進階/技巧/週期訓練/矯正/青少年/青少年進階）顯示於對應大類下，標「尚未開課」、0 梯、價格 —、列淡化；點入顯示空狀態提示＋右上加開第一梯。→ 建班別→開第一梯動線打通（先前空班別無入口）。

## 目前進度（2026-07-14 續）— 場次鍵直達 + 小蜘蛛人無限練習統一
- ✅ **課程列「場次」鍵直達該梯次**（commit 前端 `c59dbbe`，實機驗證）：場次管理側欄「選擇課程」平鋪清單改**下拉選單**，從課程列按「場次」進頁即鎖定該梯（實測週日A班直達 8 堂列表）；按鍵時重置前梯殘留的場次/名單選取。
- ✅ **小蜘蛛人 10 梯無限練習統一 2026-07-01~08-31**（firebase-admin 直改，入門8+進階2；原各梯依開課日參差 7/1~9/1）：期間內報名學員任日入場皆「課程學員」免費身份。個別調整走編輯梯次「無限練習期間」。

## 目前進度（2026-07-14 續）— 補課群組改「補課類型」二層模型
> 使用者指正設計：先建「補課類型」（named 實體）、班別再各自**多選**掛類型（取代中途做過的班別互勾單群組版）。後端 `/health` `2.54.0-makeup-types`；E2E（打 Railway）**10/10**。commit 後端 `c791108`、前端 `5c8f156`＋`ba6c941`；實機驗證通過。
- ✅ **`makeupTypes` 集合 + CRUD**（`/course-categories/makeup-types`，**路由須在 `/:id` 之前**）：GET/POST（重名 409）/DELETE（仍有班別掛 → 409 `TYPE_IN_USE` 列班別名）。
- ✅ **班別 `makeupTypeIds`（多選陣列）**：EDITABLE/POST 支援；**補課判定（`enrollMakeup`）＝同班別 恆可 or 兩班別有任一共同類型**（＋同館）；舊 `makeupGroup` 同 key 仍相容放行（欄位保留不再主用）。
- ✅ **遷移**：建類型「小蜘蛛人」掛到入門/進階兩班別（行為與先前群組版一致）；其餘班別 `makeupTypeIds:[]`。
- ✅ **前端**（`CoursesPage` 班別管理）：頂部「補課類型」管理區（chip 列表＋新增/刪除）；班別 Modal「適用補課類型（可多選）」勾選；列表標籤顯示掛的類型名。
- **E2E（10/10）**：類型 CRUD/重名/使用中刪除 → 掛類型 → 實測補課「無共同類型擋 DIFFERENT_CATEGORY／同類型（小蜘蛛人入門→進階）通過」→ 卸除後刪除成功；fixtures 全清（含場次計數還原）。

## 狀態確認（2026-07-14）— QR 入場付款方式（無異動）
- 📋 **入場 QR 不顯示「轉帳」**：`MemberQRPage` 的付款選項清單本身只有 現金/LinePay/街口/台灣Pay（無 transfer），再與系統付款開關（現開 現金+轉帳）取交集 → **目前入場/續約頭款/免費入場租借實際只顯示「現金」**。「轉帳」只出現在走 `PaymentSection` 的預約型流程（課程/體驗/比賽/租借/入隊，先報名後匯款、員工確認收款）。使用者確認維持現狀。

## 目前進度（2026-07-14 續）— 清除舊制 makeupGroup 殘留（純資料）
> 使用者查「makeup-spider 在哪」→ 查明＝小蜘蛛人入門/進階兩班別文件上第一版（班別互勾）遷移殘留的 `makeupGroup:'makeup-spider'`，與新制 `makeupTypeIds` 並存。經確認清除（設 null，全庫 0 殘留）。
- **理由**：補課判定留有「舊 makeupGroup 同 key 放行」相容邏輯——若不清，日後 UI 取消勾選類型想退出互補，舊欄位仍會悄悄放行、行為與畫面不符。新制類型「小蜘蛛人」已完整覆蓋互補（保留不動）。
- 📌 現全系統無任何班別使用 `makeupGroup`（欄位與相容判斷保留供未來相容，資料面已歸零）；`makeup-spider` 僅存於本文件歷史記錄。

## 目前進度（2026-07-14 續）— 建立「202608 紅石成人抱石賽」+ 賽事顯示三項調整
> 依 BeClass 報名表（rid=305270d6a37bc115eb50）建正式賽事，會員實測報名流程後清理，並依回饋調三處顯示。commit 前端 `b0a0522`＋`f4d6f15`＋`8f6eed6`；賽事為資料建立（API）。
- ✅ **賽事建立（open 開放報名中）**：202608 紅石成人抱石賽（新竹館）——比賽日 2026-08-30 09:00-18:00；報名 7/14~8/23、早鳥至 8/1；組別 V2-V3/V4-V5（各 40+候補5）；費用 成人早鳥990/一般1100、兒童(<15)早鳥840/一般950、隊員9折；說明含賽制（初賽大亂鬥、決賽8人）；waiver 沿用測試賽範本（160字）；計分 `competition_management_v2`。**退費政策（分日期多段，本就支援）**：8/16 前全額扣100、8/23 前 50% 扣100、之後不退。id `ced676c3`。
- 📋 **報名流程確認**：四步（基本資料[對象/組別/榮譽參賽/身分證/緊急聯絡人姓名關係電話/身高臂展]→付款[現金/轉帳，轉帳填銀行/末五碼/日期建待確認單]→同意書→簽名）；「取消報名」＝退費申請（顯示分段政策+必填退費帳號）；轉帳被退回有「重新上傳」（末五碼或截圖）。實測報名 OK，測試會員/報名/轉帳單清 0 殘留（通知為即時計算無殘留）。
- ✅ **顯示調整（會員+員工端）**：①比賽日/報名截止/早鳥 分三行（🗓/⏰/🐦）②同意書 1-5 點分行靠左（內容本有換行、顯示層漏 `pre-wrap`）③組別逐行（員工端帶候補數）。

## 目前進度（2026-07-14 續）— 比賽三項補齊：未成年簽署修復＋退費流程＋下載/對接確認
> 針對「202608 紅石成人抱石賽」逐項確認引出的修復與補齊。後端 `/health` `2.55.0`→`2.56.0`；E2E 11/11＋7/7。commit 後端 `27324da`＋`1c6519b`＋`0b3e43d`、前端 `28abcb9`。
- 🐞 **修：未成年報名家長簽署卡死（三段落差）**（`2.55.0`，E2E 11/11）：前端收「法定代理人現場簽名」但後端參數**未接收**（被丟棄）；後端標 `parentRequired/isComplete:false` 且遠端信只在有 parentEmail 才寄、前端**從未收集** → 未成年報名永遠卡「待法定代理人簽」。修：**雙路徑**——現場簽（`guardianSignature` 存檔 `uploadSignature guardian` → `isComplete:true` 直接 webhook，主路徑）；無現場簽＋parentEmail → 遠端簽署信（備用，沿用 2.45.0 比賽專用連結）。回應訊息依 isComplete 判斷（`1c6519b`）。E2E：現場簽即完成+兒童早鳥840正確；遠端路徑產 token→家長頁簽→完成。
- ✅ **比賽退費流程補齊**（`2.56.0`，E2E 7/7）：①會員取消 modal 加**今日試算可退金額**（依政策段+報名費；未繳費顯示無需退費；補列最後段之後不予退費）②取消**已收款**報名 → 站內通知同館管理員＋**待辦新增「🏆 比賽退費」**（desc 含已收金額+退費帳號；員工按退費處理→負向沖銷→待辦消失；未繳費取消不產生）。退費填寫欄位＝原因（選填）+銀行名稱/代碼(必)/帳號(必)/戶名。
- ✅ **下載名單確認**：`GET /:id/registrations/download` 200、UTF-8 BOM CSV、22 欄（含簽署狀態/候補/緊急聯絡人三欄組）。
- ✅ **計分系統對接確認＋正式賽已啟動**：金鑰 `COMP_FIREBASE_SA` 有效（測試賽有成功紀錄）；202608 已對接（`compDocId EofnXQf4ArzTNgqNP2pR`、兩組別帶入、scoringEnabled 由計分端開）→ 之後完成簽署的正取即時推送、取消同步移除、候補遞補自動補推。

## 目前進度（2026-07-14 續）— 全館輪播公告＋賽事說明全文＋比賽報到 QR
> 三項連續需求。後端 `/health` `2.57.0-competition-checkin-qr`；E2E 8/8。commit 後端 `16b1531`、前端 `6e8c839`＋`3670dd6`。
- ✅ **全館首頁輪播公告**（純資料）：「202608 紅石成人抱石賽 開放報名！」（`gymId:null` 全館＋`showOnBanner:true`；**`publishUntil` 8/23 23:59 報名截止自動下架**）。會員首頁輪播/最新公告已確認顯示（標【全館】）。id `b012a629`。
- ✅ **會員賽事卡說明欄完整顯示**：原硬截 120 字加「...」→ 全文＋pre-wrap 分行＋靠左＋底色區塊。
- ✅ **比賽報到 QR（不卡墜測）**：
  - **後端**：`POST /registrations/:regId/checkin-token`（本人/子女，`compchk:<uuid>` 存 registration）；`/checkin/scan`（值班/管理員，預覽 選手/賽事/比賽日/繳費/簽署/已報到）；`/checkin/confirm`——驗 **正取＋isComplete＋比賽日當天（NOT_EVENT_DAY）＋未重複（ALREADY_CHECKED_IN 409）**，標記 `checkedInAt` ＋ 建 **0 元 checkIns**（`entryType:'competition'`、`isCompetitionCheckin`）；**刻意不走 runEntryGates＝不卡墜測/waiver**（參賽同意書已涵蓋風險）。結帳/入場統計標籤補「比賽報到」。
  - **會員端**：我的比賽報名正取卡「🎫 比賽報到 QR」→ Modal 顯示 QR（已報到顯示 ✅）；**員工端**：入場頁掃描器（掃描槍/相機同一入口）掃到 `compchk:` 前綴自動分流「比賽報到」預覽（未收款紅字警示）→「確認報到」；報到成功面板無 checkin id 時隱藏取消鈕。
  - **E2E（8/8）**：取 token→掃描預覽→**非比賽日擋**→暫改比賽日今天→報到成功（**會員無墜測紀錄仍通過＝豁免驗證**）→checkedInAt+0元入場紀錄→重複報到 409；測後比賽日還原 8/30。
- 🧹 測試會員（0900123123）連同報名/退費通知3則/收款交易/waiver/墜測全清 0 殘留；賽事回到 0 報名乾淨狀態。

## 目前進度（2026-07-14 續）— 隊員購買優惠券/定期票 9 折
> 先查證：原本隊員 9 折只適用 按次入場/商品POS/比賽報名費，購券購票皆原價。使用者拍板：**購買優惠折扣券與定期票都套隊員 9 折**。後端 `/health` `2.62.0-team-discount-buy-card-pass`；E2E 實質 12/12（半年票無分期設定屬正確行為非 bug）。commit `37ec77e`。
- ✅ **入場購券 buy_discount_card**：改**後端權威計價**（原「維持呼叫端帶入值」）——券價 600、有效隊員 ×0.9＝540（沿用 `TEAM_DISCOUNT_MIN_AMOUNT` 門檻）；pending 帶 `isTeamDiscount`。
- ✅ **入場購票 buy_pass**：票種原價→隊員 ×0.9（pending 權威）；**掃碼預覽/確認開票/分期計畫全部以折後價**（`pending.amount ?? pt.price` 相容舊 pending）。
- ✅ **櫃檯賣票 POST /passes**：依買者 `isActiveTeamMember` 折價 `salePrice`；分期 `buildPeriodsFromConfig` 與交易記帳皆用折後、備註標「（隊員9折）」。
- ✅ **verify 顯示價**：`buyDiscountCard.price`／`buyPass.passTypes[].price` 帶折後（附 `originalPrice`），會員 QR 介面自動顯示折後價、免改前端。
- 📌 **範圍決策**：續約**不疊**隊員折（走票種續約折扣，避免折上折）——**要不要疊之後再議**；櫃檯購優惠卡（10格卡）為店員自由輸入價、無定價來源可自動折（店員輸入折後價；要固定卡價+自動折再說）。
- **E2E**：隊員/一般 verify 顯示 540/600、3600/4000 → 購券 pending 540+標記 → 購半年票 pending 6840、掃碼全額 6840 → 櫃檯賣 90 日票隊員 3600（備註隊員9折）/一般 4000；fixtures 全清。

## 目前進度（2026-07-14 晚）— Railway 應變執行（①②完成、③進行中）
> 依 `docs/outage-playbook.md` 逐步執行（使用者帳號後台操作、Claude 盯流程）。
- ✅ **① Railway 用量警示**：Compute hard limit $150（實質不觸發、不再無預警斷站）＋ email alert $25；Agent hard $5/alert $10（Agent 未使用、警示高於上限不會響，無妨）。
- ✅ **② UptimeRobot**：監控 `https://redrock-api-production.up.railway.app/health`，5 分鐘間隔＋email——任何原因掛站 5 分鐘內通知（上次事故靠現場發現的空窗解決）。
- 🔄 **③ API 自訂網域 `api.redrocktaiwan.com`**（進行中）：Railway custom domain 已加（CNAME 目標 `fox82bz0.up.railway.app`、port 8080 與 magic domain 一致）；Porkbun CNAME 已設、公網 DNS 已解析（21:01）、無 CAA 阻擋——**等 Railway DNS 檢查轉綠＋簽憑證**。⚠️ **通了之後要改前端 `src/api/client.js` BASE → `https://api.redrocktaiwan.com` 並 build/deploy**（背景監測 `/health` 200 觸發）。之後故障轉移＝Porkbun 改一筆 CNAME。
- 🔄 **附帶：計分系統自訂網域 `comp.redrocktaiwan.com`**（進行中）：Firebase Console（計分系統專案）custom domain 走新版單筆 CNAME 流程（`comp` → `redrock-comp.web.app`）；Porkbun 已設、DNS 已解析，等 Firebase 簽憑證。（原議 score. 後定案 comp.）
- ⬜ **④ Render 冷備**：待 ③ 完成後擇日（同 GitHub repo 自動雙部署、環境變數需手動同步——之後動環境變數時提醒同步）。

## 目前進度（2026-07-14 晚）— 計分系統 favicon + 源碼基準釐清
> 計分系統（redrock-comp.web.app）加 favicon。⚠️ **重要發現**：本機所有計分系統源碼副本（`~/redrock-comp-livescore` git repo、iCloud、Downloads 快照）**都比線上舊**（線上 246,755 bytes vs 本機最大 228,913）——線上版由別處部署。處理：**抓線上版當基準**覆蓋回 repo（單檔 HTML 應用，零回退風險）再加 favicon 部署。
- ✅ **favicon＝琥珀水晶 R**（使用者提供 IMG_0199.PNG）：512px favicon.png＋180px apple-touch-icon，`<head>` 加 link 標籤；與主系統紅 R 區分。已部署＋repo commit。
- 📌 **計分系統源碼位置備忘**：`~/redrock-comp-livescore`（git repo，deploy `firebase deploy --only hosting --project redrock-comp`）；`~/redrock-comp` 為空殼。**動它之前先比對線上 index.html 的 md5**（本機可能落後線上）；現 repo 已同步至線上版＋favicon（此後以 repo 為準）。

## 目前進度（2026-07-14 晚）— 刪除 livescore 舊專案
> 使用者刪除 Firebase 舊原型專案 livescore（30 天緩衝期內可還原）。**刪前查證安全**：計分系統前端＋Firestore 都在 `redrock-comp` 專案（index.html `projectId:"redrock-comp"`）、對接不受影響。本機作廢金鑰檔 `~/Downloads/livescore-master-2d181-…json` 已刪；舊原型源碼 `~/livescore-master` 保留由使用者決定。
- 🔄 兩條自訂網域仍等憑證（api=Railway／comp=Firebase）；Railway 若「Waiting for DNS update」逾時建議刪掉 domain 重加。

## 目前進度（2026-07-14 晚）— ③自訂網域完成＋前端切換＋今日入場清單修正
> Railway 應變 ③ 完成；順修 super_admin 今日入場顯示兩項。後端 `/health` `2.63.0`→`2.64.0`。
- ✅ **`api.redrocktaiwan.com` 生效（22:02）**：卡點＝Railway 要求 **CNAME＋TXT 兩筆**（TXT 名稱 `_railway-verify.api`，與 CNAME 不同名故無衝突；先前只設 CNAME 等了近 1 小時）。**教訓：Railway custom domain 要看「Configure DNS Records」是否列了 TXT 驗證列。**
- ✅ **前端 API 位址全面切換**（commit 前端 `b4cb1d2`）：`src/api/client.js` BASE＋6 處頁面 fallback（Competitions/DailySettlement/Passes/Finance×2/ExperienceBookings）→ `https://api.redrocktaiwan.com`；新網域全鏈驗證（登入/今日入場/班別/賽事 200）。**故障轉移現在＝Porkbun 改一筆 CNAME、前端免重發**。
- ✅ **`comp.redrocktaiwan.com` 生效（21:49）**：計分系統自訂網域（Firebase 單筆 CNAME 流程）。
- ✅ **修 super_admin 今日入場**（後端 `86860d9`＋前端 `7d927f3`/`a9bfee0`）：①紀錄清單依館別**上下分段**（館名標頭＋件數；站台/館長單館不變）②回報「統計 25/18 但清單 15/15 名單不齊」→ 改**全量回傳**（清單數＝統計數）、每館區塊內捲動。
- 📌 建議待辦：UptimeRobot 加第二個監測 `api.redrocktaiwan.com/health`（DNS 層故障也可偵測）；④ Render 冷備擇日。

## 目前進度（2026-07-14 晚）— 實體優惠卡入場標籤 + 入場/結帳全對帳
> 回報查 Sergio/潘彥宇 入場方式（皆士林櫃檯「舊折扣卡8折」現金 240）引出：8 折入場顯示為「單次」不易辨識。後端 `/health` `2.65.0-legacy-card-label`；commit 後端 `3153e37`、前端 `e5f3d52`。
- ✅ **實體優惠卡獨立標籤**（顯示層看 `legacyDiscount` 旗標、不動資料）：今日統計 counts 獨立一類 `legacy_physical_card`「實體優惠卡」（不再混入單次）；今日紀錄/歷史入場/CSV 匯出/會員端紀錄三處 → 共用 `entryLabelOf(rec)`（`utils/entryLabel.js`：legacyDiscount 優先於 entryType）。驗證：士林今日 7 筆正確歸類。
- ✅ **入場 vs 結帳全對帳（兩館逐類核對，全部吻合）**：士林 entry 3750（成人1200/優惠券1680/隊員270/購券600）＋商品220=3970 ✓；新竹 entry 4455＋出租300＋定期票10840=15595 ✓。註：結帳「個別使用優惠券」＝系統優惠卡入場＋實體卡8折**兩者合計**（既定定義）；**隊員買半年票 9 折（6840）當天上線當天即有真實成交**、正確落定期票大項。
- ⏰ 另 Render 冷備延後（見待辦）。

## 目前進度（2026-07-14 晚）— 修入場頁黑屏 + 電話入場「課程學員」尊重櫃檯判斷
> 兩事故連續處理。後端 `/health` `2.66.0-phone-course-access-honored`；E2E（打 Railway）6/6。commit 後端 `820896e`、前端 hotfix `4c3973a`＋`79e8fe1`。
- 🐞 **修：員工入場頁整頁黑屏**（回報「突然黑屏？」）：實體優惠卡標籤功能（`e5f3d52`）在 `CheckinPage` 加了 `entryLabelOf(c)` 用法，但 **import 注入的 python regex 沒匹配到就默默跳過**（該檔用 local `ENTRY_TYPE_LABEL`、原本沒 import utils/entryLabel）→ 開頁即 `ReferenceError: entryLabelOf is not defined` → React 整樹崩潰黑屏。**vite/rolldown build 對自由識別字不報錯**（當 global），build 過了不代表沒 ReferenceError。hotfix 補 import（`4c3973a`），瀏覽器實測恢復。
  - 💡 **教訓**：python 批次改碼的「import 注入」regex **絕不能 `if m:` 默默跳過**——要 `assert` 匹配（同 heredoc 慣例）；改完前端最好瀏覽器實際開那頁（build 通過抓不到 ReferenceError）。
- ✅ **附帶修：今日統計顯示原始 `legacy_physical_card`**：`CheckinPage` 統計側欄 local `typeLabel` map 缺新 key → 補 `legacy_physical_card:'實體優惠卡'`、`competition:'比賽報到'`（前端 `79e8fe1`）。
- ✅ **電話入場員工選「課程學員」改記學員免費**（回報「應計入學員免費而非單次入場」）：
  - **根因**：`/checkin/phone` 的免費資格權威覆核（1.56 防白嫖）把 `course_access` 也列入——員工選課程學員、後端查 `courseEnrollments` 無報名（**7-8月學員名單尚未匯入、系統現 0 筆有效報名**）→ 判「偽造免費」自動降成 `single_ticket` 收費。
  - **修**：員工手動選 `course_access` → **尊重櫃檯判斷**，記課程學員、費 0（`computePaidEntryAmount('course_access')` 依 entryTypes price 0）。此路徑限值班/管理員（員工本可用「已付費放行」0 元），非新權限洞；**偽 VIP／偽定期票降級防護保留**（FREE_TYPES 剩 `['vip','pass']`）。
  - **E2E 6/6**：fixture 會員（waiver 需 `waivers.doc(memberId)` keyed，非 add）選課程學員 → `course_access`/fee 0；偽 VIP 仍降 `single_ticket`；0 殘留。
- ✅ **更正當日被誤收的 3 筆**（使用者指認 林子雲/吳旻珊/彭芮妍，皆士林 phone 入場）：checkIn 改 `course_access`/fee 0/`correctionNote`，刪誤記 checkin 交易（300/300/270，款項實際未收）→ 統計 +3 課程學員、營收/結帳 −870。林子雲另兩筆已取消紀錄（+300/−300 成對沖銷、淨 0）保留當稽核軌跡。
- 📌 學員名單匯入後系統即可自動認出課程學員（電話搜尋/會員 QR 皆免費）；名單匯入仍待使用者提供（先前「先不做」）。

## 待辦
- 🛡 **Railway 應變**：①②③✅ 完成（用量警示＋UptimeRobot 雙監測＋api.redrocktaiwan.com 已切前端）；**④ Render 冷備【7/21 左右再處理】**——現況：服務 `redrock-api-backup.onrender.com` 已建、程式部署成功（/health 200、push 自動同步），**卡點＝runtime 讀不到 FIREBASE_* 環境變數**（頁面看得到但空的；最可疑：存成 Environment Group 未 Link 到服務、或貼上格式）。接手步驟：確認變數在服務自身 Environment 清單 → Manual Deploy → 測 `/auth/staff/login`。長期：金流上線前評估遷 Cloud Run。

- 🔧 **【選做】週課「候補→正取」自動遞補**：目前整門課候補遞補為手動（店員），可比照 per-session `promoteWaitlist` 做整門課版（有人退課/取消時自動遞補第一位候補、通知並轉為待收費）。
- 🧹 **一A `小蜘蛛人一A(7-8)閎`（`3f35216f`）**：使用者說「之後會刪除」自行處理（朱智萩報名在此門，刪前留意）。
- ✅（已完成 2026-07-11）**刪除測試會員**：21 筆 fixture 已硬刪、票券一併清、0 孤兒；**王大明與全部真實會員保留**（見上方 2026-07-11 進度）。原 7/14 提醒作廢。
- 各館申請 LinePay / 街口 / 台灣Pay 商戶 → 金鑰填入各 gym 的 `paymentSettings`
- 清理 E2E 測試殘留：`【練習】體驗生今日` 名下的 failed/returned `fallTestBookings` + 一筆 failed `fallTests`（練習 fixture，無害）
- LinePay sandbox 端到端測試 → 啟用線上付款 + 員工端 QR 前端
- 補街口 / 台灣Pay adapter 的 API TODO（依整合手冊 / 收單銀行）
- 資料移轉（Climbio 18,000+ 筆）——**墜測對照已完成**（2026-07-13：`legacyFallTests` 17,335 筆＋隊員名單 41 筆，新註冊自動認領）；會員基本資料不預先匯入（採「註冊時認領」模式，會員自行註冊＋重簽文件）
- ✅（已完成 2026-07-04 六）站台隊員 9 折端到端實測 → 見上方進度；**真站台帳號實機亦可直接做**（館別電腦帳號經 `/stations/login` 實測有效，見上方修正），後端邏輯已由 super_admin 打 `/checkin/phone` 等價驗證通過
- 會員端 UI 驗證：課程試上分頁 + 場次代班「（代班）」顯示（需會員帳號登入實測）
- 「試上人數」目前僅由試上報名流程產生 `isTrial` 名單；如需員工手動加試上者，需另做 UI
- 清理 dev Firebase 殘留測試會員：`【練習】…` 系列、`測試/測試API會員/管理員測試會員/Test1/Who` 等，以及測試用 `王大明`(0900222222)/子帳號 `小明明`；可用員工端「刪除會員」或 `DELETE /members/:id`（super_admin）清除（會一併刪子帳號、保留歷史紀錄）
