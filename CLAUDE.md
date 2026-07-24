# RedRock 紅石攀岩館 — 系統說明

> 本檔已可安全提交（無機密）。測試帳號 / 金鑰等敏感資料見 `CLAUDE.local.md`（git-ignored）。
> 接手 / 維護這份 context 的方式見 `docs/maintaining-context.md`。
> 入場資格與金額的後端權威判斷（前置關卡 / 免費資格 / 付費二段式 / 折扣疊加 / 三條路徑）見 `docs/entry-eligibility-flow.md`。
> 建立家庭會員（子會員）的注意事項（年齡限制 / 入場前置 / 兒童消費限制 / 櫃檯操作）見 `docs/family-member-guide.md`。

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
- ⚠️ **改完 `CLAUDE.md`（或任何被多 session 併行碰的檔）後，一定要 `git status` 確認它真的顯示 modified，再 `git add && git commit`**——別假設「Edit 成功＝已落地」。2026-07-16 踩過雷：api CLAUDE.md 因多 session 併行/內存副本問題，Edit 看似成功但磁碟真檔從 7/4 起就沒被寫過（`git add CLAUDE.md` 每次無 diff＝等於沒 commit），兩週進度只活在 Claude Code file-history 快照（`~/.claude/file-history/<session>/<hash>@vN`）裡差點全失。**唯一可靠落地＝git commit 後 `git show HEAD:CLAUDE.md | wc -l` 核對行數**。若磁碟檔又被還原成舊版，用最新 file-history 快照重建。
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
  - dev service account json 在本機 `~/Documents/RedRock/憑證/redrock-dev-a35c1-firebase-adminsdk-*.json`（機密、不在版控；2026-07-18 自 Downloads 搬離）
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

## 系統依賴盤點＋路徑總表（2026-07-17 更新）
### 對外網址（正式）
| 站點 | 正式網址 | 底層 | 來源 |
|---|---|---|---|
| 會員端 | `app.redrocktaiwan.com` | `redrock-member.web.app`（Firebase Hosting） | 本機 `BUILD_TARGET=member` build + firebase deploy |
| 員工端 | `staff.redrocktaiwan.com` | `redrock-staff.web.app`（Firebase Hosting） | 本機 `BUILD_TARGET=staff` build + firebase deploy |
| 後端 API | `api.redrocktaiwan.com` | Railway `redrock-api-production.up.railway.app`（**Cloudflare** CNAME → `fox82bz0.up.railway.app`，**灰雲 DNS only** 直連、2026-07-22 為降延遲改回） | GitHub push 自動部署（~1-4 分） |
| **後端冷備** | `redrock-api-backup.onrender.com` | Render（免費層，閒置休眠、喚醒 ~50s） | 同 GitHub repo push 自動同步、與正式同版本 |
| 計分系統 | `comp.redrocktaiwan.com` | `redrock-comp.web.app`（獨立 Firebase 專案 `redrock-comp`） | 本機 repo `~/redrock-comp-livescore` firebase deploy |

### 服務與帳務
| 服務 | 用途 | 備註 |
|---|---|---|
| Firebase（`redrock-dev-a35c1`） | Firestore 資料庫／Hosting 前端兩站／Storage 圖檔 | 免費額度內；SA json 本機 `~/Documents/RedRock/憑證/redrock-dev-a35c1-firebase-adminsdk-*.json` |
| Railway | 後端 API 主站（24h 常駐、**區域 Singapore asia-southeast1**，2026-07-22 自 US West 搬遷、離台近、快約 2 倍） | **主要付費點**；用量警示 Compute hard $150/alert $25；7/14 額度下線事故 |
| **Render** | 後端冷備（2026-07-17 建置完成） | ✅ Firestore 憑證/JWT_SECRET 同值/custom domain `api.redrocktaiwan.com` 已預登記（Waiting for DNS＝正常待命）；**Railway 環境變數異動須手動同步** |
| Resend | 所有 Email（Railway 封鎖 SMTP 故走 REST API） | 免費 100 封/天；`RESEND_API_KEY` 在 Railway/Render 環境變數 |
| **Cloudflare** | 網域 `redrocktaiwan.com` DNS（2026-07-20 自 Porkbun 搬入；app./staff./comp.→Firebase、api→Railway，**全部灰雲 DNS only**） | 免費；**故障轉移＝Cloudflare 改 `api` CNAME 指 Render**。api 灰雲＝快但無 CF 邊緣防護（app 層限流仍在）；遇攻擊點回橘雲+Under Attack |
| Porkbun | 網域註冊商（nameserver 已指 Cloudflare） | 年費（僅續約網域，DNS 不在此管） |
| UptimeRobot | 監測 `redrock-api-production.up.railway.app/health`（5 分鐘） | 掛站 5 分內 email 通知 |
| GitHub | 兩 repo（`redrock-api` push 觸發 Railway+Render 雙部署；`redrock-web` 純版控） | 免費；push 走 macOS Keychain |

未啟用：LinePay/街口/台灣Pay（adapter 骨架待金鑰）；BeClass（逐步取代中）；Climbio（資料已移轉完）。金鑰全在 Railway 環境變數（Render 為手動同步副本）。
已下線：**Vercel（2026-07-18 專案已刪）**——早期原型 `redrock-web` 專案（6/14 建）連著 GitHub repo 持續影子自動部署（每次 push 都白跑一次 build），查證 0 自訂網域、DNS 無任何指向、CORS 殘留早已清 → `vercel project rm` 刪除，帳號現 0 專案。
**Railway 停機應變手冊：`docs/outage-playbook.md`**（櫃檯紙本 SOP／恢復程序／故障轉移＝純一筆 CNAME／PEM 踩雷備忘／長期 Cloud Run 選項）。

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

## 目前進度（2026-07-14 深夜）— 士林建課幽靈修復 + 入場頁右欄調整 + 比賽報名五連發
> 連續多項。後端 `/health` `2.67.0`→`2.72.0`；各項皆打 Railway E2E＋部分瀏覽器實機。
- ✅ **修：士林館「沒辦法建立課程」＝gymId 空值幽靈課**（`2.67.0`，commit 後端 `7935ddf`、前端 `f0d59a4`）：加開梯次 Modal 館別下拉「顯示」`effectiveGymId` fallback 但**表單值沒跟著設**——super_admin 沒手動點過下拉 → 送出 `gymId:''`、後端 `req.staff.gymId` 又是 null → 建出 **gymId=null 任何館別都看不到的課**。使用者當晚在士林中招 5 次（技巧班×3/入門班/矯正班全重試）。修：①前端開 Modal 預帶檢視館別＋送出 fallback ②後端 `POST /courses` 權威擋空 gymId → 400 `MISSING_GYM`。資料修復：「技巧班 7-8月週日班」＋8 場次歸士林館；重複嘗試（技巧班×2、矯正班×1，參數全同 0 報名）與使用者自刪的入門班清乾淨 → 課程分佈 新竹16/士林2、null 0。
- ✅ **入場頁右欄**（`2.68.0`，commit 後端 `1917a8c`、前端 `a4707f5`；實機驗證）：①移除右側「今日入場紀錄」卡（與「今日入場」分頁重複）②「每日入場數」super_admin 改**兩館分線（新竹紅 #8B1A1A／士林藍 #185FA5）**＋上月全館灰線——`monthly-daily-counts` 回傳補本月 `hsinchu/shilin` 每日序列（不受 gymId 過濾）；單館帳號維持本月/上月、線色依館別。③統計標籤補 `legacy_physical_card`實體優惠卡/`competition`比賽報到（前端 `79e8fe1`）。
- ✅ **比賽報名表加 性別/生日/手機/Email（四欄必填、自動帶入、進計分系統）**（`2.69.0`，commit 後端＋前端；E2E 11/11）：
  - **自動帶入**：route 讀報名對象 member doc（性別/生日/手機/Email；子女無手機Email帶家長）；表單開啟/切換對象時 prefill、可編輯。**會員資料缺性別/生日 → 表單補填、報名成功後回寫會員文件**（下次自動帶入）。
  - **後端權威必填**：`MISSING_GENDER/BIRTHDAY/PHONE/EMAIL`（gender 限 male/female、email regex）。
  - **計分系統**：`competitionSyncService.mapAthlete` athlete payload 補 `birthday/phone/email`（gender 原有）；名單 CSV 四欄（原本就有、現在有值）。
- ✅ **比賽現金＝臨櫃繳款**（`2.70.0`→`2.71.0`；E2E 8/8＋4/4）：名單 CSV 新增「匯款銀行」欄（現金→**臨櫃繳款**、轉帳→報名新存的 `bankName`）、「匯款/繳款日期」欄；**繳款日期由會員報名時自填**（付款步驟現金顯示「臨櫃繳款日期 *」必填、後端 `MISSING_PAYMENT_DATE` 權威擋、CSV 讀自填值）；我的比賽卡顯示「繳費方式：臨櫃繳款＋繳款日期」（未確認收款另標請至櫃檯繳費）。
- ✅ **修：家庭一人報名全家被擋「已報名」**（`2.72.0`，E2E 5/5）：
  - **前端**：`alreadyRegistered` 原把本人＋子女報名混在一起判 → 任一人報名整張賽事卡變「✓ 已報名」藏按鈕。改**按人判斷**——卡片列「已報名：名單」＋按鈕「為其他家庭成員報名」（全家報完才隱藏）；「為誰報名」picker 已報名者標「・已報名」反灰不可選、自動預選首位未報名成員；step1 驗證擋已報名對象。
  - **後端補真漏洞**：`registerForCompetition` **原本完全沒有重複報名檢查**（前端誤擋是唯一防線）→ 加權威去重：同會員同賽事有效（非取消）報名 → `ALREADY_REGISTERED`；家庭其他成員不受影響。E2E：家長報名→本人重複擋→**代子女報名成功**→子女重複擋。
- 🧪 **比賽測試會員**：`0900123123`/`test1234`（【練習】比賽報名測試，性別留空供實測補填流程、已注入緊急聯絡人供帶入實測）——**不用時記得刪**（member doc＋waiver＋fallTests）。

## 目前進度（2026-07-15）— 會員端英文版（第一層＋入場QR/註冊全英文）
> 使用者詢問英文版複雜度 → 拍板「第一層就好、千萬不動中文版」→ 追加入場 QR 流程與註冊頁全英文。純前端 `redrock-web`，實機中英來回切換驗證。
- ✅ **輕量雙語機制 `src/utils/memberI18n.js`**：`t(zh)` **以中文原文為 key**——中文模式或查無對照**一律原樣返回** → 中文版行為零改動（漏加對照最壞只是英文模式顯示中文）；帶變數句子用 `isEn()` 三元組字；切換後 `location.reload()` 全頁生效（存 `localStorage.memberLang`）。
- ✅ **第一層（功能鍵）**：首頁右上角（頭像旁）**🌐 EN/中文 切換鈕**；首頁六快速功能＋全部 11 頁底部導航（Home/Courses/My Passes/Me）雙語（每頁 `{t(n.label)}`）。
- ✅ **入場 QR 流程全英文**：五步（選館/身分/方式/租借/付款/QR）＋擋下畫面（waiver/墜測/已入場）＋續約卡＋分期/特約/證件提醒＋逾時取消提示全翻；帶數字句（剩 N 天/共 N 張/有效 N 分鐘/分期 N 期）用 isEn() 組字。**順修真 bug**：`select_method` 區塊 local `const t = selectedType` 會**遮蔽翻譯函式 t** → 改名 `st`（不修則該區塊一用翻譯即崩潰）。
- ✅ **註冊頁全英文**＋右上角自帶 🌐 切換鈕（登入前摸不到首頁切換鈕）；生日欄「年/月/日」為瀏覽器原生控件、跟隨裝置語言（翻不到、無礙）。
- ✅ **登入頁「立即註冊」→「立即註冊（Register）」**（靜態雙語，供外籍會員辨識入口）。
- ⚠️ 後端錯誤訊息仍中文（error code 對照翻譯屬下一層工程，未做）；資料內容（課程/票種/公告名）不翻。

## 目前進度（2026-07-15）— 比賽收款退回/重填 + 緊急聯絡人帶入 + 繳費日期3日限 + 待收款標籤
> 三項需求＋一項標籤。後端 `/health` `2.73.0-comp-payment-reject-refill`；E2E（打 Railway）**13/13**。commit 後端＋前端各兩筆。
- ✅ **緊急聯絡人自動帶入**：報名表開啟時依報名對象（本人/子女）會員資料帶入緊急聯絡人姓名/關係/電話（可修改；prefill useEffect 擴充）。
- ✅ **繳費日期限報名日起 3 日內**：臨櫃繳款/匯款日期 date input `min=今天 max=今天+3`＋**後端權威**（`INVALID_PAYMENT_DATE`，過去日期也擋）；會員重填端點同限制。
- ✅ **確認收款 Modal（`CompetitionActionModal`）加「退回」＋雙備註**：
  - **員工備註 `staffNote`**（內部）：確認收款/退回皆可填；`getMemberRegistrations` **過濾不回傳會員**（E2E 驗證看不到）；員工報名清單顯示「📝 員工備註」。
  - **退回** `POST /registrations/:regId/reject-payment`（competitions.manage）：**原因必填**（會員看得到）→ `paymentStatus:'transfer_rejected'`＋Email 通知＋首頁通知（沿用 /my/alerts）；已確認收款不可退回（400，要走退費）。
  - **會員重填** `POST /registrations/:regId/payment-info`（ownership 驗證）：新 Modal 可改付款方式（現金/轉帳）＋繳費日期＋銀行/末五碼 → 回 `pending`、清退回標記、待辦重新出現。**現金與轉帳都能補正**（原本只有轉帳走 /transfers/upload）。員工端狀態標籤加「已退回待補正」。
- ✅ **待辦頁待收款付款方式標籤**（純前端 `PendingTasksPage`）：轉帳確認/比賽收款/攀岩隊/租借任務標題旁顯示 藍「轉帳」/琥珀「臨櫃繳款」/電子支付標籤（`task.method || task.record?.paymentMethod`）。實機：現有 4 筆比賽待收款正確分標。

## 目前進度（2026-07-15）— 修：裝置驗證碼 Email 從未寄出（+重寄機制）
> 使用者問「resend 發送驗證信正常嗎（裝置綁定）」→ 查出**上線以來的真 bug**。後端 `/health` `2.74.0-device-otp-email-fix`；寄信實測使用者本人信箱收到兩封驗證信確認。
- 🔍 **根因**：`deviceAuthService.createDeviceVerification` 呼叫 `emailService.sendDeviceVerificationCode`，但 emailService **從未定義此函式**（與 1.48.0 分期提醒信同型 bug）→ TypeError 被 try/catch 吞、只留 log——**裝置驗證碼信從未寄出**，前端卻顯示「已發送驗證碼」；實際新裝置只能靠管理員審核放行。且原本無重寄：10 分鐘內重試登入沿用舊驗證單但不再寄信。
- ✅ **修**：①emailService 補 `sendDeviceVerificationCode`（6 位數大字、10 分鐘效期文案）②沿用未過期驗證單時**重寄同一組驗證碼**（再按一次登入＝重寄；登入本有限流防濫發）③登入頁 OTP 面板加「**沒收到驗證信？重新發送**」鈕（員工/站台皆適用，成功顯示綠提示）。
- ✅ **裝置審核全功能 E2E（打 Railway，15 項全過）**：總開關開啟；員工新裝置擋 403＋OTP（錯碼擋/對碼核發 token）；信任裝置直接放行；第二裝置再擋；管理員待審清單（回傳 key＝`devices`）/核准放行/拒絕仍擋；站台同套機制；super_admin 例外。臨時員工/站台/驗證單/信任裝置 0 殘留。
- 💡 **教訓（第二次踩同型雷）**：emailService 的呼叫端與函式定義易脫鉤——**新增「呼叫 emailService.xxx」時必先確認函式存在**；被 try/catch 包住的寄信失敗只會留 log、線上無感。

## 目前進度（2026-07-15）— 名單/數據查核 + 測試清理
- 📊 **認領進度**：隊員 **26/41**（未認領 15：新竹 10、士林 5——曾智妍/李宥儒/張景欣/丁宣勻/彭健鈞/黃芸茵/張芝翠/王妤㚬/蘇郁茹/羅俊逸Ethan；蔡至誠/賴維治/郭芳妤Kate/盧孟立Jeremy/周正晏）；90日票 **18/23**（未認領 5 皆新竹：**李應崇 7/18 到期最急**、謝佑欣/廖有福 9/8、曾宥勝 9/22、黃永豪 10/5——過期後系統不發）。
- 📊 **有效會員 121**（主帳號 119＋子會員 2；全自助註冊、Email 已驗證 118；隊員 26；前置全完成 118、3 位卡待辦）。
- 🧹 已清「【練習】V隊」（e2e-vt，連帶 waiver＋墜測 2 筆）；「【練習】比賽報名測試」保留測試用。

## 目前進度（2026-07-15 續）— 裝置驗證信收件人防呆 + 信任裝置管理 + 比賽現金收款
> 承裝置驗證信修復，處理王登第回報「重寄驗證信收不到」引出的資料/防呆，並補信任裝置清單管理、比賽現金收款開放值班+寫結帳。
- ✅ **修：王登第重寄驗證信收不到**（後端 `/health` `2.75.0`）：查出其員工帳號 `notificationEmail` 被誤填 `"see"`（非合法 email）→ 驗證碼寄到垃圾位址。**資料修復**：清除該 `notificationEmail`（回退主 email `tengti.wang0110@gmail.com`）。**程式防呆**：`auth.js` 建立裝置驗證時 `accountEmail` 改「`notificationEmail` 須通過 email regex 才用，否則退回主 `email`」（`5fd..` 同型：垃圾值不再吞驗證碼）。commit `redrock-api`。
- ✅ **信任裝置清單＋移除**（後端 `/health` `2.76.0`，commit 後端＋前端）：新增 `GET /auth/device/trusted`（回帳號名/裝置/核准/最後使用，權威補 staff/stations 名稱）＋`DELETE /auth/device/trusted/:id`（devices.manage）。設定 →「裝置審核」分頁待審核卡下方加「已核准裝置（N）」清單＋「移除」鈕（移除後該裝置下次登入需重新驗證）。實機驗證 8 筆＋移除鈕。
- 🧹 **清信任裝置殘留**：孤兒 3 筆（舊測試員工 `uuriibjJt24…`×2、`staff-ft-hc`）＋陳莉涵完全重複 1 筆＋現金 E2E 殘留 2 筆（`e2e-cash-station`/`e2e-cash-op`）。陳莉涵剩 2 筆為**不同 deviceToken**（同手機兩瀏覽器 session）＝合法多裝置、保留。現存 9 筆真實裝置。
- ✅ **比賽/課程臨櫃現金收款：開放值班確認＋自動寫結帳加減項**（後端 `/health` `2.77.0`，E2E 9/9）：
  - **比賽現金收款開放值班**：`POST /competitions/registrations/:id/confirm-payment` 由 `checkPermission('competitions.manage')`（管理員）→ 現金比照課程「值班 operator/館別電腦 或管理員」、轉帳仍限管理員；加**冪等**（已 confirmed 不重複記帳）。前端待辦頁 `competition_payment` 改 per-task 分權（現金→值班/管理員、轉帳→管理員）。
  - **現金收款→自動寫當日結帳加減項**：新增 `settlementService.addCashAdjustment({gymId,amount,note})`——比賽/課程臨櫃現金收款確認時，金額寫入該館**今日結帳** `deductions` 一筆「**＋現金補入**」（`note`＝人名＋活動名、`auto:true`）；無今日 doc → 建暫存檔（draft、店員開結帳頁自動載入）、已有 → 附加。接入 `transfers.js`（course/competition 現金 confirm）與 `competitions.js`（confirm-payment 現金）。
  - **E2E（9/9）**：值班 operator 確認比賽現金 200＋加減項寫入「＋現金補入 990 人名+賽名」、重複確認冪等、值班確認轉帳被擋 403、課程現金 confirm 寫假館結帳暫存加減項。
- ✅ **關閉員工體驗課程設定權限**（後端 `/health` `2.78.0`，E2E 5/5，commit 後端＋前端）：體驗課程設定（試上費/保費/課程類型/保險收件人）原 `PUT /experience-bookings/settings` 只 `authenticate`（**全員工含值班皆可改**）→ 改 `requireManager`（**僅系統/館別管理員**，正職/兼職/值班皆擋 403 `MANAGER_REQUIRED`）；GET 讀取不變（員工操作預約仍需讀設定）。前端「體驗課程」頁「⚙ 課程設定」分頁對非管理員隱藏＋防呆不渲染。E2E：正職讀取 200/改設定 403/管理員改 200。

## 📋 權限盤點（2026-07-15，無程式異動，供對照）
- **五角色**：`super_admin`（系統管理員·跨兩館）/ `gym_manager`（館別管理員·單館，**目前 0 位**）/ `full_time`（正職）/ `part_time`（兼職）/ `member`（會員）。實際員工 15：super 3（Sean/Debby/系統管理員）、full 5、part 7。
- **關鍵分水嶺＝值班**：正職/兼職個人帳號登入（type=staff）只能辦公類（課程/庫存/班表檢視）；櫃檯操作（入場/發券/收款/結帳/POS）須在館別電腦打卡值班（type=operator）取得整組 `COUNTER_PERMS`。管理員不受此限。
- **三層 gate**：`checkPermission`（矩陣，super 一律過、operator 值班享 COUNTER_PERMS）/ `requireManagerOrStation`（管理員或值班）/ `requireManager`（僅管理員，值班也擋）/ `requireStationAuth`（operator 或 super——**每日結帳連館別管理員也需值班**）。
- **產出兩份 Artifact**（依 `src/middleware/auth.js` 矩陣+各路由 gate）：①依功能分類 ②依頁面（每頁×5角色）。狀態 ●完整/◐需值班/◔檢視部分/—無。

## 目前進度（2026-07-15 續）— 開放場館電腦發佈該館公告（休館類留管理員）
> 需求：開放場館電腦（值班）發佈該館輪播公告。AskUserQuestion 先定「全部類型可發」→ 使用者後改「休館留給管理員」。後端 `/health` `2.79.0`→`2.80.0`；E2E（打 Railway）7/7＋10/10。
- ✅ **公告發布開放值班＋館別隔離（`2.79.0`）**：`POST/PUT/DELETE /gyms/:id/announcements` 由 `checkPermission('notifications.send_gym')`（僅管理員、operator 也擋）→ **`requireManagerOrStation`**（管理員或值班 operator）＋新增 `announceGymGuard`：**非 super_admin 只能對自己館發布，擋 `all`（全館）與他館 → 403 `CROSS_GYM_FORBIDDEN`**。super_admin 不限。（`notifications.send_gym` 權限 key 只被這 3 個公告端點用，改後已無引用。）
- ✅ **休館/特殊營業時間限管理員（`2.80.0`）**：**休館(closure)/特殊營業時間(special_hours) 有票期補償財務副作用**（休館日自動延長全館定期票效期）→ 新增 `announceTypeGuard`：非管理員（值班 operator 的 full/part 角色）發/改這兩類 → 403 `MANAGER_ONLY_TYPE`；**DELETE 也擋**（值班下架管理員發的休館會反向縮短已補償票期，handler 先讀 type 檢查）。值班僅可發 一般/輪播、路線更換。gym_manager 值班（role 仍 gym_manager）不受限。
- ✅ **前端**：設定頁 `TAB_GROUPS` 場館與帳號組加「📢 場館公告」分頁（`ownGymAnnounce`，可見條件＝非 super 的 `gym_manager` 或值班 operator；super 走既有「場館設置」）；`GymsPage` 非 super（`annOnly`）→ 只列自己館（`activeGymId`）、只顯示公告區塊（營業時間/銀行 super-only 藏起）、類型下拉移除休館/特殊時間＋提示「請由管理員發布」。角色改由 `operator?.role || staff?.role` 判定。
- **E2E**：`2.79.0` 值班發自己館輪播 201/他館 403/全館 403/自己館休館(當時)201/super 全館 201（7/7）；`2.80.0` 值班發一般·路線 OK/休館·特殊時間 403 `MANAGER_ONLY_TYPE`/值班下架管理員休館 403/值班下架自己一般 200/管理員發+下架休館 200（10/10）。臨時員工/值班/公告/shiftLog 全清。
- 📌 **使用**：館別電腦打卡值班 → 設定 → 📢 場館公告 → ＋新增 → 勾「輪播」→ 送出（該館會員首頁輪播出現）；休館公告仍須管理員發。

## 目前進度（2026-07-15 續）— 修：比賽退回通知導向錯 tab
> 回報：會員首頁「比賽轉帳被退回」通知點「前往處理」導向 `/member/competitions`，但比賽頁預設開「開放中報名」tab，被退回的報名在「我的比賽報名」tab → 會員看不到要補的那筆。後端 `/health` `2.81.0`。
- ✅ **修**：後端 `/members/my/alerts` 比賽退回通知＋未成年家長簽署通知的 `link` 改 `/member/competitions?tab=my`；前端 `MemberCompetitionsPage` tab 初始值讀 `?tab=my`（用 `window.location.search`，因 `useLocation()` 在 useState 之後才宣告，避免 TDZ）。→ 點通知直接開「我的比賽報名」看到退回原因＋「重新填寫繳費資訊」鈕。

## 目前進度（2026-07-15 續）— 新購優惠折扣卡使用期限改可設定（暫定無限期）
> 回報確認「新購優惠折扣卡有一年期限」（`CARD_VALIDITY_MONTHS=12` 寫死）→ 要求改可由系統管理員設定、暫定無限期、已售出的一起取消效期、設定只影響之後售出。後端 `/health` `2.82.0`；E2E 7/7。
- ✅ **可設定**：`discountCardService.getDiscountCardValidityMonths()` 讀 `systemSettings/discountCard.validityMonths`——未設定/0/讀取失敗 → **null（無限期，暫定）**、1~60 → 月數。`purchaseDiscountCard` 改 `expiresAt = validityMonths ? add(n,'month') : null`；**櫃檯新增（`POST /cards/discount/purchase`）與入場購買（`buy_discount_card`，flow.js 也呼叫 purchaseDiscountCard）兩入口共用**。`CARD_VALIDITY_MONTHS` 常數保留供參照、不再用作 fallback。
- ✅ **設定端點**（`settings.js`，照 bonus 模式）：`GET /settings/discount-card-validity`（公開讀，回 `{validityMonths: null|1~60}`）、`PUT`（super_admin，空/0＝無限期存 null、1~60、超範圍 400）。前端設定→入場規則加「🎟️ 優惠卡期限」分頁（superAdminOnly，留空＝無限期、顯示「目前：無限期/N 個月」、註明只影響之後售出、轉入卡本就無期限不受影響）。
- ✅ **一次性取消已售出卡效期**：firebase-admin 掃 `discountCards` `expiresAt!=null` 共 6 張（皆 `source:new` 真實會員 10 次卡、原一年期）→ 設 `expiresAt:null`＋`expiryCancelledNote`；清後 0 張有效期。轉入/綁定卡本就 null、不動。
- ✅ **不追溯**：`purchaseDiscountCard` 售出當下讀設定定 expiresAt，之後改設定不影響已售出（設計本然，UI 註明）。
- **E2E（7/7）**：GET 預設 null、PUT 12→存值、PUT 0/空→null、PUT 61→400、還原無限期。
- 📌 **現行卡效期規則更新**：新購優惠卡＝**依系統設定（目前無限期）**｜轉入/綁定優惠卡＝無限期｜綁定黑卡＝無限期｜點數移轉＝跟隨原卡。（原「新購＝一年」已作廢。）

## 目前進度（2026-07-15 續）— 墜測影片觀看進度定格排查（純前端 `redrock-web`）
> 回報：會員看安全墜落影片時影片有播、但完成度定格不動。墜測影片用 YouTube IFrame API 每秒讀 `getCurrentTime()` 累積「看過的整數秒集合 ÷ getDuration()」算 `watchPercent`（`MemberFallTestPage`）。分兩種定格：
- ✅ **卡 0%（讀不到進度）→ 偵測 in-app 瀏覽器提示改用 Safari/Chrome**：新增 `utils/inAppBrowser.js`（偵測 LINE/FB/Messenger/IG/微信/Threads/TikTok 內建 WebView 的 UA）；墜測影片區 in-app 時顯示琥珀提示橫幅＋「複製本頁網址」鈕（`navigator.clipboard`）。in-app WebView 常無法回報 YT 進度→進度卡 0 無法簽署。UA 偵測 8/8（in-app 提示、一般 Safari/Chrome 桌機手機不誤報）。commit（redrock-web）。
- ✅ **卡固定非零值（如 31%）→ 加 `playsinline: 1`**：`initPlayer` 的 `playerVars` 原 `{rel:0,modestbranding:1}` **缺 `playsinline:1`** → iOS Safari 點播放**強制跳原生全螢幕**、iframe 內 `getCurrentTime()` 停住 → 進度定格在跳全螢幕前的值。加 `playsinline:1` 讓 iOS 頁面內播放、進度持續前進。（桌機/Android 本就 inline、不受影響；需清快取/無痕重載。）commit（redrock-web）。
- 📌 **未做（使用者選只加 playsinline）**：進度算法仍是「累積實際經過的整數秒」→ 切背景/鎖屏（setInterval 被節流暫停）與快轉跳看仍會表現為卡住。若再有回報，方向＝改「已達最大播放時間÷總長」或「累計觀看秒數」寬容化。

## 狀態確認（2026-07-15）— 場館電腦看不到公告 UI ＝快取（無程式異動）
- 📋 回報館別電腦看不到「場館設置/公告」UI。查證：程式已上線（線上 bundle 確認含「場館公告」tab），值班 operator 邏輯正確（`canOwnGymAnnounce` 對 operator 為 true、`GymsPage` 會選到自己館、能發自己館公告）。**根因＝館別電腦載到舊版快取**（使用者確認「看到舊畫面」）。**無需改程式**——館別電腦網址加 `?v=1`/無痕/清快取重載即可（PWA 圖示開的要刪圖示重加）。前提：需先打卡值班（純站台被「請先打卡上班」遮罩擋住整個畫面）；後端公告端點用 `authenticate`（需 staffId）→ 純站台 token 無 staffId 本就打不到，須 operator。

## 目前進度（2026-07-15 續）— 修：入場統計/營收「學生免費·兒童免費」標籤誤導
> 回報：今日統計的「學生免費」是什麼狀況？查證——`student_free`/`child_free` 是 entryType 的**歷史 id**（早年可能免費），實際學生單次入場收 250、兒童 150（近3天 8 筆 student_free 全有收費、無 0 元）。純標籤誤導、計費正常。後端 `/health` `2.83.0`→`2.84.0`。
- ✅ **四處標籤 學生免費/兒童免費 → 學生入場/兒童入場**（純文字、不動計費）：①前端 `CheckinPage` 今日統計 typeLabel ②後端 `/checkin/today` 統計標籤（`2.83.0`）③前端 `RevenuePage` 入場分類 ④後端 `/revenue` byType 標籤（`2.84.0`）。全域掃描確認顯示層 0 殘留（僅 `checkin/pricing.js` 一行內部註解保留、不顯示）。系統其他處（掃碼預覽/今日紀錄/歷史/結帳/會員紀錄）本就用「學生入場/兒童入場」，現全一致。

## 目前進度（2026-07-15 續）— 每日入場數圖表：上月也拆兩館
> 承 `2.68.0`（本月拆兩館 新竹紅/士林藍）→ 要求上月資料也拆兩館、用淡紅/淡藍細虛線。後端 `/health` `2.85.0`；實機驗證圖例四項。
- ✅ **後端**：`/checkin/monthly-daily-counts` data 補 `hsinchuPrev`/`shilinPrev`（上月各館每日；`gymCountMap` 查詢範圍本就含上月，只是原本沒組進 data）。
- ✅ **前端**（`CheckinPage`，僅 super_admin 視角）：上月由單一灰線 → **上月新竹淡紅 `#E0A6A6`、上月士林淡藍 `#A6C3E5`，細虛線**（strokeWidth 1、`strokeDasharray 3 3`，畫在本月兩館實線後方當背景參考）；圖例四項（新竹/士林實線＋上月新竹/上月士林淡色虛線）。**單館帳號（站台/館長）維持本月實線＋上月灰線不變**。
- 📌 目前上月（6月）資料量少、虛線貼底不明顯；8 月看 7 月資料時會清楚。

## 目前進度（2026-07-15 續）— 修：會員端紅利轉移一直失效（Timo Volz 案例）
> 回報 Timo Volz 轉移紅利給 0963290219（黄倫玄）失效。查證：紅利完好（未用/未過期/isActive）、`ticketTransfers` 全空＝申請根本沒送出成功。後端 `/health` `2.86.0`；E2E（打 Railway）8/8。
- 🔍 **三個 bug（會員端紅利轉移從未成功過）**：會員 App 紅利走 `POST /ticket-transfers/request`（兩段式），但該端點對 `bonus` 型別——① `collectionMap` 把 bonus 對應到**`bonusCards`**（空集合），實際紅利在 **`discountBonuses`** → 申請即 404 `TICKET_NOT_FOUND`（Timo 卡在這）；② 擁有權檢查用 `ticket.memberId`，但紅利用 **`ownerMemberId`**（無 memberId 欄）→ `NOT_OWNER` 403；③ 接收時更新 `memberId`，但 `getMemberBonuses` 查 `ownerMemberId` → 收件人看不到。此通用流程為「用 memberId 的票券（單次券）」寫的，紅利欄位不同、三處皆錯。
- ✅ **修**（`ticketTransfers.js`，request＋accept）：bonus 集合改 `discountBonuses`（兩處）；擁有權與接收持有人更新改用 `ownerMemberId`（`ownerField = ticketType==='bonus' ? 'ownerMemberId':'memberId'`）。單次券等用 memberId 者不受影響。
- **E2E（8/8）**：臨時 A→B＋紅利（discountBonuses）→ A 申請 201 → B 接收 200 → 紅利 `ownerMemberId` 改 B、A 查無、B 查得到。fixtures 全清。
- 📌 Timo 紅利完好可用（到期 2027-01-15），請其自行在 App 重新申請轉移給黄倫玄（對方 24h 內接收）；未代操作。

## 目前進度（2026-07-15 續）— 補：整張券移轉「收件端 UI」（紅利/單次券/體驗券）
> 承上——`2.86.0` 修好紅利「送出」後，發現**收件端根本沒 UI**：後端有 `/ticket-transfers/pending`、`/accept`、`/reject`，但前端全站無任何呼叫 → 收件人看不到、無法接收 → 申請 pending 24h 後過期回沖、移轉仍完不成。優惠卡/黑卡「次數移轉」走另一套 `/cards/transfers` 本就有收件 UI（「🎁 待接收的卡片移轉」），這套 `/ticket-transfers`（紅利/單次券/體驗券）只做了送出。後端 `/health` `2.87.0`；E2E（打 Railway）8/8。
- ✅ **前端**（`MemberPassesPage`）：新增「🎁 待接收的票券移轉」區塊（列 `/ticket-transfers/pending`）——每筆顯示 類型（紅利入場/單次入場券/優惠卡…）＋來自誰＋24h 期限＋「接收」「拒絕」鈕；接收 `POST /ticket-transfers/:id/accept`、拒絕 `/reject`，完成後 `loadTransfers`＋`reloadCards` 刷新。`tXferIn` state、`loadTransfers` 併載 pending。
- ✅ **後端**：`/ticket-transfers/pending` 補 `fromMemberName`（批次反查 members，供顯示「來自 XXX」）。
- **E2E（8/8）**：A 申請紅利 → B pending 有此筆＋fromMemberName 正確 → B 接收 → 紅利 ownerMemberId 改 B、B pending 清空、B「我的票券」看得到。
- 📌 **紅利移轉現端到端完整**（`2.86.0` 送出＋`2.87.0` 收件）；一併修好單次券/體驗券收件（同走此套、原也缺 UI）。
- ✅ **實況（查證）**：Timo 已於修好後（7/15 11:53）**重新申請成功**——`ticketTransfers` 有 1 筆 pending bonus（Timo→黄倫玄，期限 7/16 11:53）；紅利 pending 階段仍掛 Timo 名下（兩段式正常）。**只差黄倫玄在「我的票券」頁上方按接收**（需載到新版；逾期回沖需再申請）。無代操作。

## 目前進度（2026-07-15 續）— 會員查詢效能優化 + 紀錄卡「載入中」修復 + 入場類型中文
> 三件：①清單/詳情 payload 與耗時優化 ②員工會員查詢左側「紀錄查詢」永遠卡載入中 ③紀錄入場類型改中文。後端 `/health` `2.88.0`→`2.91.0`。
- ✅ **任務1 清單移除靜態 qrCode**（`2.88.0`，commit `c739733`）：驗證全前端無人讀 `member.qrCode`（入場走動態 qrToken）→ `searchMembers` 用 `sanitizeMemberForList`（額外 delete qrCode），**詳情 getMember 保留**。量測：單筆 **5309→663 B**、50 筆 **257KB→31KB**。
- ✅ **任務2 詳情查詢並行 + 移簽名圖**（`2.89.0`→`2.91.0`，commit `32826b2`+`2926ddd`+`fb74d37`）：①GET /members/:id 的 waiver/fallTests/passes/children/sig/refreshBlockStatus 由**逐項序列 await 改 `Promise.all`**；定期票改單 `where(memberId)`+記憶體過濾（避複合索引 FAILED_PRECONDITION）②詳情 payload 66KB 是 `waiver.memberSignatureUrl` base64 簽名圖——詳情頁只讀狀態布林、簽名圖只在「查看副本」modal 另打 `/members/:id/waiver` 取 → **strip 簽名圖欄位＋跳過 signFields 網路簽章**③`getBlockReasons` 內部 waiver＋墜測查詢並行。量測：**1.96s→~1.2–1.4s、60–80KB→13–14KB**；副本 modal 的 `/waiver` 仍含簽名（未壞）。
- ✅ **任務3（前端）紀錄查詢卡載入中**（commit `redrock-web` `0ce7daa`）：根因＝`MembersPage.handleSelect` **從未呼叫 `loadMemberRecords`（dead code）** → `memberRecords` 恆 null，render 第三分支 `!loading && !records` 也寫成「載入中...」→ 永遠卡。修：handleSelect 選會員時 `setMemberRecords(null)+setRecordsLoading(true)`＋併發 `loadMemberRecords(id)`（含 `Promise.allSettled`+`finally`）、切換會員重載；render 假載入中改「紀錄載入失敗，請重新點選會員」。實機：黃耀弘 入場(1) 正常顯示、切林子雲 入場(3) 跟著換無殘留。
- ✅ **入場類型顯示中文**（前端 commit `51ba80f`）：`MembersPage` 的 `MemberRecords` 入場列原顯示原始 `c.entryType`（discount_card…）→ 套共用 `entryLabelOf`（discount_card→優惠折扣券/single_ticket→單次購票/實體優惠卡…）。實機：黃耀弘「新竹館 · 優惠折扣券」。
- 💡 教訓：後端「清單」與「詳情」共用 sanitize 時，大欄位（qrCode/簽名圖）應只在詳情/專屬端點回傳；序列 await 的多查詢 handler 優先 `Promise.all`；dead function（grep 只有定義）常是「該呼叫沒呼叫」的 bug 訊號。

## 目前進度（2026-07-15 續）— 會員詳情列全部有效票券 + 班別改名連帶重組梯次名
> 兩件連續小任務。後端 `/health` `2.94.0`→`2.95.0`。
- ✅ **會員詳情列各類有效票券**（`2.94.0-member-detail-all-tickets`，後端 commit「GET /members/:id 加各類有效票券摘要」、前端 `29b8b29`）：原 `GET /members/:id` 只回 `activePasses`（定期票）→ 有卡/券/紅利但無定期票者顯示「無有效票券」。加 `activeCards`（優惠卡 kind=discount／舊折扣卡 legacy／黑卡 black，含 remainingCredits/source/expiresAt）、`activeSingleTickets`、`activeBonuses`，**沿用既有權威 getter**（`getMemberDiscountCards`/`getMemberLegacyDiscountCards`/`getMemberBlackCards`/`getValidSingleEntryTickets`/`getMemberBonuses`，各 `.catch(()=>[])` 併入 Promise.all），`activePasses` 不變。前端 `MembersPage` 有效票券區塊列 定期票/優惠卡/黑卡/舊折扣卡/單次券/紅利（null 到期顯「無期限」、全空才「無有效票券」）。實機驗證：蘇玲巧（0988779228）顯示「🎟️ 優惠卡 · 剩 6 格 · 到期 無期限」。**不動發卡/使用/移轉邏輯**。
- ✅ **班別改名連帶重組梯次顯示名**（`2.95.0-category-rename-recompose-cohorts`，commit `bf5e45c`）：回報新竹館「小蜘蛛人入門班」要改「小蜘蛛人初級班」。查明班別（courseCategory `ebf83b51`）名稱**其實早已是初級班**，但梯次顯示名 `name` 是**建立時存死的**（`courseService` create 存 `班別名+梯次名`、getCourses 讀取不重組）、改名不回寫 → 新竹館 8 梯停在舊「小蜘蛛人入門班 週X班」（士林那筆後建、已正確）。根因＝`PUT /course-categories/:id` 只更 category 文件、不回寫子梯次。**修**：PUT 班別改名（`updates.name!==undefined`）時 batch 重組旗下所有有 `cohortName` 的梯次 `name`＝新班別名+梯次名；一次性校正現有 8 個 stale 梯次。
- 📋 **產出各館課程正確名稱清單（匯入課程學員用）**：`~/Downloads/課程名稱清單_<日期>.csv`（21 active 梯次，欄位 館別/大類/班別/梯次名/**課程完整名稱(匯入用)**/星期時間/開課迄日/教練/courseId）。匯入注意：①「小蜘蛛人初級班」新竹＋士林都有梯次 → 對應務必帶館別或用 courseId ②矯正班兩梯僅差括號教練名（晉瑋教練/閎聿教練）為不同梯次。腳本走 firebase-admin。

## 目前進度（2026-07-16）— 課程整期/比賽報名改 transaction 原子去重 + 課程去重補 leave 狀態
> 回報「課程或比賽會有重複報名嗎？」查證：兩者本有後端去重（課程 `ALREADY_ENROLLED`、比賽 `ALREADY_REGISTERED`），但都是**讀後寫、非交易** → 並發雙擊（同 ~100–300ms 兩請求都先過查詢才各自寫入）理論上仍可能各建一筆（2026-07-08 朱智萩重複收費事故即同型）。改成 transaction 杜絕。後端 `/health` `2.96.0-enroll-register-transaction-dedup`；E2E（打正式 API 並發）**9/9**。commit `8b4fca7`。
- ✅ **課程 `POST /courses/:courseId/enroll-all` 全面交易化**（`courses.js`）：去重查詢 + 名額/候補判定 + 建立整期報名 + 場次計數包進 `db.runTransaction`。用 **`tx.get(query)`**（Firestore 對查詢範圍做樂觀鎖）→ 兩並發請求會有一方 abort+retry、重讀後看到對方已寫入的報名 → **去重與候補位次皆正確**。fee 計算為純讀取（隊員折扣/插班比例）**移到交易外**先算好；`willInstallment` 交易外算、`paymentDeadline` 依 isWaitlist 交易內算。場次計數由 `(s.count||0)+1` 改 **`FieldValue.increment(1)`**（避免多會員並發時計數丟失）。業務錯誤（`ALREADY_ENROLLED`/`COURSE_FULL`）於交易內 `throw new Error` 帶 `.code`、catch 映射 **409**。
- ✅ **課程去重補 `leave`（請假中）狀態**：去重狀態由 `['confirmed','waitlist']` → `['confirmed','waitlist','leave']`（請假中也算已報名、擋重複；索引需求不變）。
- ✅ **比賽 `registerForCompetition` 去重移進既有交易**（`competitionService.js`）：原本容量判定已在 `runTransaction` 內，但**去重查詢在交易外**（191 行，僅快速失敗）→ 把「同會員同賽事非取消報名」的 `tx.get` 加進同一交易頂端當**權威把關**（並發雙擊只成立一筆）。交易外的快速失敗保留（避免對明顯重複者先上傳簽名）。
- **E2E（打正式 API，臨時會員注入 bcrypt 密碼登入，9/9）**：課程並發 6 請求 → **僅 1 成功、5 個 409 ALREADY_ENROLLED、DB 只建一組報名(=場次數)、場次計數=1**；`leave` 中再報名擋 409；比賽並發 6 請求 → 僅 1 成功(201)、5 個 ALREADY_REGISTERED、DB 只一筆有效報名。腳本 `scratchpad/dedup-tx-e2e.cjs`，測後 0 殘留。
- 💡 **教訓**：讀後寫的去重/名額判定在並發下不可靠；Firestore `tx.get(query)` 會把查詢結果納入交易讀取集，任何並發寫入落在查詢範圍 → abort+retry，天然序列化（同時解決去重 + 位次/計數正確）；跨文件計數優先 `FieldValue.increment`。E2E 繳費日期要用**台灣今天**（UTC 日期會早一天觸發 `INVALID_PAYMENT_DATE`）。

## 目前進度（2026-07-16 續）— 比賽退費/取消語意修正 + 轉帳補填 + 管理員退回/駁回報名表
> 由「莊振翔比賽退費申請看不到」一路查出並修的三件事。後端 `/health` `2.97.0`→`2.98.0`。
- ✅ **比賽未繳費取消＝純取消報名（不建退費申請）**（`2.97.0-competition-unpaid-cancel-no-refund`，commit 後端 `bf8f87c`）：**根因**——`POST /registrations/:id/cancel` 原本**無條件** `refundRequested:true`＋存退費帳號，但通知/待辦只在 `paymentStatus==='confirmed'` 觸發 → 未繳費（pending）取消的會員填了退費帳號、以為在等退費，櫃檯卻永遠看不到（無款可退不建待辦）。**修**：只有已繳費才標 `refundRequested`＋存退費帳號、回應「退費將於…處理」；未繳費不標記、回應「尚未繳費，無需退費」。前端 `MemberCompetitionsPage` 取消 modal 依 `paymentStatus` 分流——未繳費隱藏退費試算/退費帳號、標題「取消報名」、不要求填帳號、payload 不帶退費欄；已繳費維持「取消報名・申請退費」。清掉莊振翔那筆未繳費卻標 refundRequested 的舊資料。
- ✅ **比賽轉帳可先報名、之後補填轉帳資訊（方案 B）**（純前端 commit `20f8506`）：**根因**——報名選轉帳但末五碼/日期留空時，前端仍呼叫 `submitTransferRecord`→`/transfers/upload` 因「截圖或末五碼擇一」缺一 **NO_PROOF 失敗被 try/catch 吞** → 沒建待收款；而**待辦「比賽報名待收款」直接讀 `competitionRegistrations`（`paymentStatus='pending'`）**、報名文件本身末五碼空白 → 櫃檯看到空白無從核對。**修**：報名時空白就不 call submitTransferRecord；「待確認付款(pending+transfer)」加「填寫轉帳資訊」按鈕（複用 repay modal→既有 `POST /payment-info`，該端點已接受 pending、更新報名文件末五碼/日期），已填則顯示末五碼＋「修改」。→ 補填後櫃檯待辦即看到。
- ✅ **管理員退回/駁回報名表 + 會員修改重送**（`2.98.0-competition-admin-return-reject-form`，commit 後端 `1c74066`、前端 `1898563`；E2E 打正式 API **16/16**）：使用者要求「管理員要有退回報名表的功能」，確認**兩者皆要**——
  - **退回修改** `POST /registrations/:id/return-form`（manage，reason 必填）：標 `formReturned/formReturnReason`、**保留名額**、Email＋`/members/my/alerts` 首頁通知（新增 `competition_form_returned`）。會員端顯示退回原因＋「修改報名資料」→ 編輯 modal（組別/性別/生日/手機/Email/身分證/緊急聯絡/身高臂展/榮譽，**不重簽**）→ `POST /registrations/:id/update-form`（會員，限 `formReturned`；**後端權威重算費用**（生日→兒童、早鳥）與**改組別容量檢查**（滿轉候補）、清 formReturned）。
  - **駁回取消** `POST /registrations/:id/reject-form`（manage，reason 必填）：`status:cancelled`＋`formRejected`、**釋出名額＋遞補候補＋移除計分系統**、已收款標 `refundRequested`（走退費待辦）、Email 通知。
  - 前端 `CompetitionsPage` 每筆報名加「退回修改」「駁回取消」按鈕＋原因 modal、標籤「已退回待修改／已駁回」；`MemberCompetitionsPage` 加編輯 modal＋通知框。
  - **E2E（16/16）**：退回缺原因 400→退回 200＋formReturned＋名額保留＋首頁通知→會員改 B組＋改兒童生日→費用重算 990→**840**＋清 formReturned→未退回再改 400→駁回 200＋cancelled＋formRejected→已取消再駁回 400。腳本 `scratchpad/comp-returnreject-e2e.cjs`，0 殘留。
- 💡 **教訓**：`/transfers/upload` 要末五碼或截圖擇一，空白會 NO_PROOF；比賽待收款待辦讀 registration 文件（非 transferRecords），故補填只需更新 registration；「無條件設 refundRequested」是這次的根因型 bug（狀態旗標要跟實際金流狀態一致）。

## 目前進度（2026-07-16 續2）— 比賽退回/退費一輪打磨（承上）
> 由「莊振翔案例」延伸的一連串小修，前後端各自 commit/deploy。後端 `/health` `2.98.0`→`3.00.0`。
- ✅ **擋重複退回報名表**（`2.99.0-block-double-return-form`，commit 後端 `3158a12`、前端 `4ef245b`；正式 API 驗證 2/2）：已 `formReturned`（等會員修改中）再退回 → **400 `ALREADY_RETURNED`**；員工報名名單該筆「退回修改」按鈕收起、改顯示「已退回・等待會員修正」，**保留「駁回取消」**。會員修改重送清 `formReturned` 後按鈕復現。
- ✅ **已繳費取消（退費申請）後端強制退費帳號**（`3.00.0-refund-account-required`，commit `05d66d1`；E2E 3/3）：`cancel` 端點對 `paymentStatus==='confirmed'` 的取消，缺退費銀行代碼或帳號 → **400 `MISSING_REFUND_ACCOUNT`**（原本只有前端擋、後端信任前端；補上權威層，避免空白帳號退費申請進待辦、櫃檯無從匯款）。前端本就必填銀行代碼+帳號（戶名/銀行名選填）。
- ✅ **比賽報名名單加付款方式標籤**（純前端 commit `fd486e7`）：每筆報名顯示 **臨櫃繳款**（藍）/ **轉帳**（灰）標籤，一眼分辨。
- 🧹 **刪除莊振翔錯誤報名**：`75c0414c`（V2-V3 組・報錯組別・cancelled・未繳費）整筆刪除（無連帶 transferRecords）；保留有效的 V4-V5 組（confirmed、**繳費被退回 transfer_rejected**，待他重填繳費資訊）。
  - 📋 **釐清**：莊振翔那筆取消**本質是「取消報名」不是「退費申請」**——`paymentStatus=pending`（從未繳費），是舊版 bug（未繳費也無條件標 refundRequested+讓填退費帳號）誤導；`2.97.0` 已修，資料已清。
- 📌 **決策記錄**：使用者確認**「退回修改」與「退回繳費資訊」維持兩個分開、不整合**（一個修報名資料/`formReturned`、一個修匯款證明/`transfer_rejected`，修正對象不同）。**退費申請審核**（退回退費資訊/駁回退費申請）功能**暫不做**（莊振翔案例其實是取消報名、非退費，無此需求；日後有真正已繳費退費申請再議）。

## 目前進度（2026-07-16 續3）— 比賽報名付款狀態機：繳款期限＋逾期剔除＋依狀態顯示功能鍵
> 承上，把「會員報名→繳款→確認/退回/駁回」整條收斂成明確狀態機。使用者逐項確認流程。後端 `/health` `3.01.0`；完整狀態機 E2E（打正式 API）**13/13**；員工端實機四狀態逐一截圖驗證。
- ✅ **未繳費「退費」按鈕語意修正**（純前端 commit `9845f7e`）：名單上 `paymentStatus==='pending'` 的「退費」按鈕語意錯誤（未收款無款可退）→ 轉帳未繳費改「**要求重填轉帳**」走 `reject-payment`（`transfer_rejected`）；實際退費仍走待辦（`competition_refund`/`CompetitionActionModal`）。
- ✅ **繳款期限＋逾期自動剔除**（`3.01.0-competition-payment-deadline-sweep`，commit 後端 `aa8c9ad`、前端 `13ca0bd`）：
  - 賽事加 **`paymentDeadlineDays`（預設 3、員工建賽表單可設）**；報名**正取＋有費用**→ `paymentDeadline = 報名日 + N 天`（候補遞補為正取時才起算）。
  - **`sweepExpiredCompetitionPayments`**（每日排程＋`POST /competitions/sweep-expired-payments` super_admin 手動）：只剔除「**正取＋未繳費＋未填匯款資料（pending 無末五碼）＋有費用＋逾期**」→ 取消/釋名額/遞補候補/Email；**已填待確認（有末五碼/pending_confirm）、已收款、免費者不剔除**（球在櫃檯不冤枉會員）。
  - 會員報名付款步驟＋「我的比賽報名」卡顯示**繳款期限（含臨櫃繳款、逾期自動取消）**。
- ✅ **員工名單依狀態顯示功能鍵 + 狀態下拉篩選**（前端 `CompetitionsPage`）：`regState(r)` 六態——
  - **未填匯款(awaitPayment)**：只有「駁回報名」＋期限提示｜**待確認(awaitConfirm)**：確認收款／要求重填匯款(轉帳)／退回修改／駁回報名｜**已要求重填(rejected)**：只有駁回報名＋「已要求會員重填」｜**已收款(paid)**：退回修改／駁回報名｜**候補(waitlist)**：退回修改／駁回報名｜**已取消**：無按鈕。
  - 名單右上加**狀態下拉**（未填匯款/待確認/已收款/已要求重填/候補/已取消）。「確認收款」複用既有 `CompetitionActionModal` action=pay；原因 modal 改設定物件支援 return/reject/rejectPayment 三型。
- **E2E（13/13）**：一筆轉帳報名走 A(未填匯款,有期限)→會員填→B(待確認)→員工要求重填→rejected＋會員通知→會員重填→B→確認收款→paid→退回修改→formReturned＋會員通知→會員修改重送→駁回報名→cancelled；另驗**未填匯款逾期 sweep→剔除**、**已填待確認逾期→不剔除**、**已收款取消→退費申請**。腳本 `scratchpad/comp-states-e2e.cjs`。
- 🖥️ **員工端實機四狀態逐一確認**（202608 真實名單）：未填匯款(【練習】測試)只駁回報名｜待確認(洪紹祖/葉博榮)四鍵齊｜已要求重填(莊振翔/朱智萩)只駁回報名＋提示｜已收款(多筆)退回修改/駁回報名；狀態下拉＋臨櫃繳款藍標都正確。
- 🧹 **清除測試報名資訊**：刪 `【練習】比賽報名測試` 在 202608 的 1 筆報名（名單 18→17）＋12 筆 E2E 殘留的 `【練習】` 退費通知（通知數 6→5）；**真實會員報名全未動**；測試帳號 `0900123123` 保留（名下比賽報名歸 0）。
- 📌 **狀態機關鍵定義**：`hasInfo = bankLastFive || pending_confirm || 現金` 判「已填匯款」；sweep 只掃「未填」者（`pending` 無末五碼）→ 已提交待確認的不冤枉剔除；繳款期限走 `paymentDeadline`（報名日+N，遞補時起算），會員補填/退回不重設。

## 目前進度（2026-07-16 續4）— 比賽逾期取消後可用原資料重新報名（免重填/免重簽）
> 承繳款期限 sweep：逾期被自動剔除的報名，會員可一鍵用原資料重新報名。後端 `/health` `3.02.0-competition-reregister-expired`；E2E（打正式 API）**7/7**。commit 後端 `22a6b40`、前端 `40d232c`。
- ✅ **後端 `POST /registrations/:id/reregister`**（會員，限 `cancelReason==='payment_expired'`）：**沿用原簽名/個資/組別**（免重填免重簽）；交易內去重＋容量檢查→ confirmed/waitlist；**新繳款期限＝報名日 + 原賽事 `paymentDeadlineDays`**（比照原賽事規定）；費用重算（早鳥/兒童）、清逾期旗標（`cancelReason/paymentExpiredAt/cancelledAt`＋清 `bankLastFive/paymentDate` 需重繳）；正取＋已簽署→重推計分系統。**只允許賽事 `status==='open'` 且在報名期內**；已有有效報名→擋。
- ✅ **會員端**（`MemberCompetitionsPage`）：`status==='cancelled' && cancelReason==='payment_expired'` → 顯示「⏰ 繳費逾期，報名已自動取消」＋「**重新報名比賽（免重填）**」按鈕（`reregisterCompetition`）；其他取消仍顯示「已取消」。
- **E2E（7/7）**：報名→backdate 期限+sweep→`payment_expired`→reregister→confirmed/pending＋**原簽名/身分證/緊急聯絡人沿用**＋新繳款期限（N=3）＋費用重算 990＋清逾期旗標；已是有效報名再重報→400。腳本 inline。

## 目前進度（2026-07-16 續5）— 現金逾期改櫃檯人工處理 + 緊急聯絡人帶入修正
> 兩個由「填匯款＝已繳款？現金逾期怎麼算？」與「緊急聯絡人帶入會不會合併？」引出的釐清＋修正。
- 📋 **釐清：填寫匯款資訊 ≠ 已繳款**：會員填末五碼只進「待確認收款」（`paymentStatus` 仍 `pending`＋末五碼），**必須員工按「確認收款」（confirm-payment，核對末五碼/金額）才變 `confirmed`＝已繳款**；系統不會因填了末五碼自動當已收款。
- ✅ **現金逾期改「不自動剔除、櫃檯人工處理」**（`3.03.0-cash-no-autosweep`，commit 後端 `80613a2`、前端 `3b18cdf`；E2E 2/2）：使用者拍板選項 3。`sweepExpiredCompetitionPayments` 加 `paymentMethod!=='transfer' → 跳過` → **只自動剔除「轉帳且未填匯款資料且逾期」**；臨櫃現金永不自動剔除。前端提示區分：會員報名付款步驟「轉帳逾期自動取消／現金請至櫃檯繳費（不自動取消）」；會員卡「逾期自動取消」提示只對轉帳顯示；員工名單現金待確認顯示「臨櫃繳款・櫃檯人工處理」（不顯示期限）。E2E：現金逾期→不剔除、轉帳未填逾期→仍剔除。
  - **繳款期限總結**：轉帳＝報名日+N 天逾期自動剔除（未填末五碼者；已填待確認不剔除）；現金＝報名日+N 為軟性提示、**不自動剔除**、由櫃檯確認收款或人工取消。
- ✅ **修：比賽報名緊急聯絡人帶入欄位合併**（純前端 commit `ae87a98`）：**根因**——會員資料的緊急聯絡人存成**單一合併字串** `emergencyContact`＝「姓名 / 關係 / 電話」（`MemberProfilePage` `ecParts.join(' / ')`／`split('/')`，會員**無**獨立 relation/phone 欄），但比賽報名 prefill 直接 `setEmergencyContact(r.emergencyContact)` → **整串塞進「姓名」欄、關係/電話空白**（真實 4 位：吳旻珊/賴易涵/朱智萩/王潔）。**修**：prefill 無獨立欄時 `split('/')` 拆回三欄填正確位置；有獨立 relation/phone 欄則直接用。現有 16 筆有效報名 **0 筆合併殘留**（真實會員當初手填三格、未中 bug），無需清資料。

## 目前進度（2026-07-16 續6）— 比賽付款狀態機全狀態實機 E2E 驗證（3.03.0 後）
> 應要求對「所有狀態點」再做一次完整實機驗證（含現金新規則），無程式異動、純驗證。
- ✅ **API 狀態機 E2E 重跑 13/13**（`scratchpad/comp-states-e2e.cjs`）：未填→待確認→要求重填→確認收款→退回修改→駁回→逾期 sweep→退費申請＋會員通知，3.03.0 改動後邏輯完整。
- ✅ **現金專項 E2E 2/2**：現金逾期→不剔除；轉帳未填逾期→仍剔除。
- ✅ **員工端實機七狀態逐一截圖驗證**：firebase-admin 注入一場「【練習】狀態展示賽」含 7 筆各狀態報名 → 員工端查看名單，功能鍵全部正確——候補(退回修改/駁回)｜**待確認現金(確認收款/退回修改/駁回・無要求重填・標「臨櫃繳款・櫃檯人工處理」)**｜**待確認轉帳(確認收款/要求重填匯款/退回修改/駁回＋期限)**｜已要求重填(只駁回＋原因)｜未填匯款(只駁回＋繳款期限)｜逾期取消(無按鈕)｜已收款(退回修改/駁回)。現金 vs 轉帳差異化實機確認。
- ✅ **清理**：展示賽事＋7 筆報名全刪、0 殘留、待辦數回落（注入的待確認報名曾進待收款待辦、刪後歸零）。
- 📌 **比賽付款狀態機（`2.97`~`3.03`）至此完成**：未繳費取消≠退費／轉帳先報名後補填／管理員退回修改+駁回報名+會員重送／擋重複退回+退費帳號必填／繳款期限+逾期剔除（現金不自動剔除、櫃檯人工）/依狀態顯示功能鍵+狀態下拉／逾期免重填重新報名／緊急聯絡人拆欄帶入。API＋實機雙重驗證。

## 目前進度（2026-07-16 續7）— 計分系統對接：性別送中文 + 重新推送批次修 timeout 誤報
> 對接丟到計分系統的資料性別要中文；連帶查出「重新推送顯示不成功」其實是誤報。後端 `/health` `3.04.0`→`3.05.0`。
- ✅ **性別送中文男/女**（`3.04.0-scoring-gender-zh`，commit `bf14118`）：`competitionSyncService.mapAthlete` 加 `toGenderZh`（male→男、female→女、已中文/未知原樣），計分系統 athlete payload 不再送英文 male/female。既有已對接賽事需「重新推送」才會更新既有選手。
- ✅ **修「重新推送顯示不成功」＝前端 timeout 誤報**（`3.05.0-scoring-batch-resync`，commit `2bdc63d`）：**根因**——`startScoringSync` 原**逐一** `syncCompAthlete`（每位跨專案讀整個賽事文件＋寫入），16 位＝~32 次跨專案往返 → 太慢，RedRock 前端 `startScoring` catch timeout 顯示「對接失敗」，但**後端其實全部成功**（查 202608 16 位 `webhookStatus` 全 `sent`、性別已男/女）。**修**：新增 `syncAllAthletes`（讀一次 event doc、一次 `update` 全部 athletes 欄位，保留 bib/order/round）；`startScoringSync` 改批次＋`webhookStatus` 批次回寫。**正式 API 實測**：重推 202608 回 `synced:16/failed:0`、耗時 ~3.7s（原會 timeout）。
- 📌 **教訓**：跨專案（RedRock↔計分系統 redrock-comp）Firestore 逐一讀寫會累積大量往返→慢/timeout；批次「讀一次+寫一次」是正解。前端顯示「對接失敗」不代表後端沒成功——查 `webhookStatus` 才是真相。

## 目前進度（2026-07-16 續8）— 會員通知：處理完成(已取消)自動消失 + 現金退回文案修正
> 回報朱智萩比賽報名已取消但通知一直卡待處理、且現金卻顯示「轉帳被退回」。後端 `/health` `3.06.0-alerts-exclude-cancelled-method`；E2E 2/2。commit 後端 `e44c070`、前端 `cd61161`。
- ✅ **通知處理完成後自動消失**：**根因**——`/members/my/alerts` 的「轉帳/繳費被退回」通知（`paymentStatus==='transfer_rejected'`）**沒排除 `status==='cancelled'`** → 已取消報名（朱智萩 cash+cancelled+transfer_rejected）通知一直在。**修**：alert forEach 加 `if (o.status==='cancelled') return`（已取消/處理完成→通知消失）。通知為即時計算、無殘留，取消/補正/確認後自動消失；涵蓋 course/experience/competition/rental/team 全來源（formReturned/guardian_sign 本就已排除 cancelled）。
- ✅ **現金退回不再寫「轉帳被退回」**：alert 帶 `method: o.paymentMethod`；首頁通知（`MemberHomePage`）與「我的比賽」badge（`payStatusBadge`）依付款方式——**現金→「繳費資訊被退回」/「繳費被退回」**、轉帳→「轉帳被退回」（pending_confirm 同理：現金→「繳費確認中」）。
- **E2E（2/2）**：注入 cash+transfer_rejected 兩筆（一 cancelled 一 active）→ `/my/alerts` 只回未取消那筆、且帶 `method=cash`。
- 📌 朱智萩通知下次開首頁即消失（她不用動作）。

## 目前進度（2026-07-16 續9）— 待辦頁「退回追蹤」（管理者/值班退回件追蹤至結案）
> 需求：管理者/值班退回的申請或繳費確認，要能在一處追蹤到結案，並看到會員及管理者當初填寫/退回的資料。後端 `/health` `3.07.0-returned-tracking`；E2E（打正式 API）**6/6**。commit 後端 `1a87603`、前端 `423ff44`。
- ✅ **退回 metadata（3 端點標記）**：`transfers reject`（course/體驗/比賽/租借/入隊繳費退回）、比賽 `reject-payment`（要求重填匯款）、比賽 `return-form`（退回報名表）→ 於訂單標 `wasReturned:true`＋`lastReturnType`(payment/form)/`lastReturnReason`/`lastReturnByName`(退回人)/`lastReturnAt`。
- ✅ **`GET /pending-tasks/returned`**：查 5 集合（courseEnrollments/experienceBookings/competitionRegistrations/equipmentRentals/teamApplications）`wasReturned==true`；**結案判定分型**——繳費退回→`paymentStatus==='confirmed'` 結案；報名表退回→`formReturned` 清除結案；取消一律結案（皆濾除）。回子狀態（`awaiting_member` 待會員補正／`resubmitted` 已補正待確認）＋會員填寫資料（繳費：付款方式/金額/末五碼/銀行/日期；報名表：組別/性別/手機/Email/身分證/緊急聯絡）＋退回原因/人/時間。gymId 過濾（super_admin 可指定）。
- ✅ **前端**（`PendingTasksPage`）：待辦頁切換列加「↩️ 退回追蹤（N）」按鈕（N=件數）＋面板：每筆顯示 會員/類型/訂單名/退回原因/退回人/時間＋雙徽章（繳費退回·報名表退回 / 待會員補正·已補正待確認）；「詳情」modal 分兩區——👔管理者退回資料、🧑會員填寫資料。resolve/取消後自動從追蹤消失（＝結案）。
- **E2E（6/6）**：繳費退回→出現(待補正+會員末五碼+退回原因)→補正(pending_confirm)→仍追蹤(已補正待確認)→確認收款→結案消失；報名表退回(已付費也追蹤、不因 confirmed 誤判結案)→formReturned 清除→結案消失。腳本 inline。
- 📌 **設計**：結案＝自動移除（無永久已結案歷史）；「當初填寫資料」取訂單當前欄位（非歷史快照）＋退回 metadata。

## 目前進度（2026-07-16 續10）— 修：退回追蹤抓不到改版前退回件（蔡閔等）
> 回報退回追蹤沒資料（蔡閔的退回是要她提早繳費、不是不追蹤）。後端 `/health` `3.08.0-returned-tracking-legacy`。
- ✅ **根因**：`GET /pending-tasks/returned` 原只查 `wasReturned==true`，但該旗標 3.07.0 才加 → **改版前退回的 4 筆（蔡閔/劉昱辰/莊振翔/葉博榮，皆 202608 transfer_rejected 無旗標）查不到** → 追蹤空白。
- ✅ **修（commit `4953419`）**：查詢改**聯集去重**——`paymentStatus=='transfer_rejected'`（繳費退回，含改版前）＋`wasReturned==true`（補正後仍追蹤）＋`formReturned==true`（報名表退回，比賽）；`docMap` 依 doc id 去重後套原結案判定/子狀態。reason/time 對改版前 fallback `paymentRejectReason`/`paymentRejectedAt`（退回人 name 改版前無、顯示—）。
- ✅ **回填 4 筆**：現有 transfer_rejected 未結案者補 `wasReturned:true`＋`lastReturnType/Reason/At`（讓其補正後仍持續追蹤到結案）。
- **驗證（打正式 API）**：`/pending-tasks/returned?gymId=gym-hsinchu` 回 4 筆（含蔡閔 現金·「請於報名三日內完成繳費」），付款方式/末五碼/原因齊全。前端不用改（純後端查詢修正）。

## 目前進度（2026-07-16 續11）— 修：比賽報名費未套攀岩隊員 9 折
> 回報林祺堂是隊員報名卻沒 9 折。後端 `/health` `3.09.0-competition-team-discount`；E2E 2/2。commit `e584224`。
- ✅ **根因**：`registerForCompetition` 計費**從未讀 `fees.teamMemberDiscount`（0.9）** → 所有隊員收原價。（賽事 fees 有此欄位但只存不用。）
- ✅ **修（三處計費）**：`registerForCompetition`＋`update-form`（退回修改重送）＋`reregister`（逾期重報）——報名對象效期內隊員（`isActiveTeamMember`）→ `applyTeamDiscount`（共用，0.9＋最低金額門檻）套折、存 `isTeamDiscount`。**E2E**：隊員早鳥 990→891、一般 990 無折。
- ✅ **林祺堂資料修正**：202608 V4-V5（**pending 未繳費**）990→891＋isTeamDiscount:true；掃 202608 全部報名**僅他 1 人**受影響（已收款者不動、避免更動已收金額）。
- 📌 隊員折扣適用族群現況：按次入場×0.9、商品 POS、購優惠券/定期票（2.62.0）、**比賽報名費（本次補上）**；兒童入場不套折（比賽童折另計、隊員折疊在計算後）。

## 目前進度（2026-07-16 續12）— 比賽報名名單改精簡表格 + 組別分頁 + 詳細資料 modal
> 回報名單太亂、朱智萩取消被誤歸退費。純前端 `CompetitionsPage`。commit `a512b08`（分頁/退費取消分清）＋`7b55ff2`（精簡表格）＋`4392f4e`（修命名衝突崩潰）。
- ✅ **精簡表格 + 組別分頁**：分頁列＝**全部(N) + 各組別(N，點看該組名單) + 申請退費(N) + 已取消(N)**；每列僅 **姓名/組別/性別/費用/繳費狀態/報名日期 + 備註徽章**（榮譽/早鳥/隊員9折/臨櫃/候補#/退回修改中/待法代簽/申請退費/已駁回/逾期取消）；**依報名日期排序**；一行總計 有效/申請退費/已取消。
- ✅ **細項點「詳細資料」看**：點列開 modal——全欄位（付款方式/匯款末五碼/銀行/繳款日期/確認收款/身高臂展/身分證/緊急聯絡/手機Email/簽署狀態/退費帳號/退回原因/員工備註）+ 狀態動作鍵（確認收款/要求重填/退回修改/駁回報名）。
- ✅ **退費/取消分清**：分頁 申請退費＝`refundRequested`、已取消＝`cancelled && !refundRequested` → 朱智萩純取消不再誤歸退費申請（她另有一筆 confirmed 重報，正取顯示）。
- 🐞 **修自己引入的崩潰（命名衝突）**：新加的報名繳費狀態 `const STATUS_LABEL`（`{t,c}`）與**模組層既有 `STATUS_LABEL`（競賽狀態 draft/open/closed，`{type,label}`）同名** → 元件內 shadow 蓋掉 → 競賽列表 `STATUS_LABEL[c.status].type` 讀到 undefined.type → **CompetitionsPage 整頁白屏**。改名 `PAY_STATUS` 解決。**教訓**：元件內 const 勿與模組層同名（會 shadow）；vite build 不報此類 runtime 崩潰，改前端務必實機開該頁。附帶：期間一度誤判為 entryLabelOf 舊快取 bundle（CUTM_C8_）→ 實為新 bundle 的 `.type` shadow 崩潰，靠開新分頁載入最新 bundle + 讀 console 定位真兇。

## 目前進度（2026-07-16 續13）— 比賽駁回報名：會員首頁通知 + 我的比賽顯示已駁回
> 回報駁回報名沒在會員首頁通知、且我的比賽仍顯示「轉帳確認中」。後端 `/health` `3.10.0-reject-form-member-notify`；E2E 2/2。commit 後端 `abccf38`、前端 `25447fc`。
- ✅ **駁回→會員首頁通知**（原本無）：`/members/my/alerts` 加 `competition_rejected`（`status==='cancelled' && formRejected`，近 14 天，`kind:'reject'`）；`MemberHomePage` 支援 `kind:'reject'`（⛔「比賽報名已被駁回：賽名／原因：…／點此查看」）。逾 14 天自動消失（駁回為終態、非待辦、無 acknowledge 機制故以時間窗自然過期）。
- ✅ **我的比賽不再顯示「轉帳確認中」**：**根因**——`payStatusBadge` 只看 `paymentStatus`（pending_confirm→轉帳確認中），沒看 `status==='cancelled'`；reject-form 設 cancelled 但未清 paymentStatus。**修**：badge 先判 `status==='cancelled'`→顯示 已駁回／逾期取消／已取消；取消卡對 `formRejected` 顯示「⛔ 報名已被駁回＋原因」（原落入通用「已取消」）。
- **E2E（2/2）**：注入 cancelled+formRejected+pending_confirm → `/my/alerts` 回 `competition_rejected`（kind=reject＋原因）；cancelledAt 改 20 天前 → 通知消失。

## 目前進度（2026-07-16 續14）— 會員各頁右上角加登出圖示（純前端 `redrock-web`）
> 需求：會員頁面右上角都加簡單登出圖示。commit `9b2e1d5`，member 已 deploy。
- ✅ **新共用元件 `components/MemberLogoutButton.jsx`**：右上角登出鈕（**SVG 繪製登出圖示**避免缺字 tofu、見 [[ui-icon-css-not-glyph]]；點擊跳「確認登出？」modal → `useMember().logout()` + 導回 `/member/login`）。兩模式：**fixed 浮動**（預設，右上角固定）／**inline**（嵌入既有 header 列）。
- ✅ **加到 12 個會員 app 頁**：浮動於 11 頁（Courses/Competitions/Experience/QR/Passes/Records/Rental/Team/Gyms/FallTest/Profile，多數插在 `<NavBar/>`/`<BottomNav/>` 前）；**首頁**用 `inline` 嵌在 header 頭像旁（避免與 🌐EN 切換／頭像浮動重疊）。login/register/forgot/reset/verify/parent-waiver 等未登入頁不加。
- 📌 各頁無共用 MemberLayout（各自 standalone + 自帶 NavBar），故用「浮動 fixed 元件插各頁」達成統一右上角；未實機（會員登入需密碼），靠 12 頁 import/使用確認 + 兩端 build 通過。

## 目前進度（2026-07-16 續15）— 修：比賽駁回/取消後轉帳單殘留在待收款
> 回報朱智萩比賽報名已駁回卻仍在待收款。後端 `/health` `3.11.0-void-transfer-on-cancel`。
- ✅ **根因**：駁回報名（reject-form）/會員取消把報名標 cancelled，但**沒作廢連動的 `transferRecord`（status 仍 pending）** → 待辦 9b「轉帳待確認收款」直接讀 pending 轉帳單、不看報名是否取消 → 殘留在待收款（朱智萩 c8096f7f 駁回、轉帳單 8284b6b9 仍 pending）。
- ✅ **修（commit `942106c`）**：① **待辦 9b** 對每筆 pending 轉帳單查連動訂單（`ORDER_COLL` 5 型）——`status==='cancelled' || paymentStatus==='refunded'` → **跳過不列**（涵蓋所有取消路徑的安全網；forEach 改 for-of async）。② **reject-form + member cancel** 作廢該報名的 pending transferRecords（`where refId== + 記憶體濾 status`，資料清潔）。③ 回填作廢殘留的 1 筆（朱智萩）。
- **驗證（打正式 API）**：`/pending-tasks` 待辦 6 筆、轉帳待收款 0 筆、朱智萩 ✅ 已消失；端點正常。
- 📌 同類提醒：轉帳單（transferRecords）與訂單狀態需連動——訂單取消時務必作廢其 pending 轉帳單，否則待收款/報表殘留。

## 目前進度（2026-07-16 續14）— 修單日券誤判過期 + 保險名冊壞檔 + 首頁體驗提醒導向
> 三筆修復。後端 `/health` `3.12.0`→`3.13.0`；前端純導向。
- ✅ **修：單日入場券使用時誤判過期**（`3.12.0-single-ticket-expiry-dateonly`，commit 後端 `60a614b`）：回報王登翰體驗單日券有效日到 7/16、當天使用卻說「票券已過期」。**根因**：`checkin/flow.js` 兩處（`createPendingCheckIn`:73、`confirmCheckIn`:408）過期判斷用 `dayjs().isAfter(dayjs(ticket.expiresAt))`——`expiresAt` 是純日期字串（`2026-07-16`）被解析成當天 00:00，午夜後任何時刻的 `dayjs()` 都晚於它 → **有效日當天午夜過後整天都被誤判過期**（只有恰好 00:00 可用）。顯示用的 `getValidSingleEntryTickets`（eligibility.js）是字串比對（正確）→ 券「看得到、可選、一按下去就過期」。**修**：兩處改 `taiwanToday() > String(ticket.expiresAt)` 日期字串比對（當天 false 不擋、隔天 true 才擋）。黑卡（flow.js:58）與 QR pending（248/340）用 Firestore Timestamp `.toDate()`（完整 datetime）比對正確、不受影響。**體驗單日券本就全體受影響**（有效日僅當天、當天午夜後就不能用），非個案。
  - ✅ **實機驗證（測試帳號 0900123123 `【練習】比賽報名測試`）**：發體驗單日券（`validDate=當天`）＋刪 passed 墜測（保留墜測同意書）→ 會員產入場 QR → 走「持當日有效體驗券＋已簽墜測同意書 → 豁免墜測」放行 → 用券入場成功（券轉 `used`）→ 同時驗到 3.12.0（券在有效日當天不被誤判過期）。測後清票券/墜測申請/入場紀錄/pending QR、`recordFallTestResult` 還原 passed 墜測（至次年）。**關鍵提醒**：體驗券只在 `validDate === taiwanToday()` 當天生效（`getValidSingleEntryTickets` 過濾）→「明天的券今天測」會正確被墜測擋（非 bug）；要當天測就把券 `validDate` 設當天。
  - 🔍 **延伸稽核：定期票 / 比賽報到 QR / 其他票種同型 bug 全掃過 → 皆安全，無第三處**（無程式異動）。**定期票**效期判定（`checkin/eligibility.js` `getValidPasses`）用 `taiwanToday()` 字串比對（`endDate >= today`、`startDate <= today`）→ 到期日當天仍有效、免疫午夜。**比賽報到**（`competitions.js:899`）是 `comp.eventDate !== taiwanToday()` **字串相等**（非 `dayjs().isAfter`）→ 比賽日當天整天放行；報到 QR token（`compchk:`）無效期欄位不會過期。全域掃 `isAfter/isBefore(dayjs(...))` 逐一確認：**優惠卡/紅利/黑卡/QR pending(30分)/裝置 OTP 全存 Firestore Timestamp、用 `.toDate()` 真 datetime 比對**（正確）；續約基準（`passes.js:339`、`eligibility.js:74` `dayjs(endDate).isAfter(dayjs())`）只算基準日/剩餘天、不擋入場、無害。**成因**：單日券是唯一「效期存純日期字串＋又用 `dayjs().isAfter(dayjs(字串))` 比」的組合、且效期＝發券當天故一發即中；其他票種不是字串比對就是 Timestamp datetime，都避開了。
- ✅ **修：保險名冊下載/預覽壞檔**（`3.13.0-insurance-roster-sanitize-import`，commit 後端 `3da9cf9`）：回報保險名冊下載資料錯誤、預覽也錯誤。**根因**：7/13 後端拆檔把 `buildInsuranceXlsBuffer` 從 `experienceBookings.js` 搬進 `experienceService.js`，但 helper `sanitizeSheet` 只在原檔 import、沒跟著搬 → 產名冊時 `ReferenceError: sanitizeSheet is not defined` → 下載 route throw → 回 500 JSON，前端把錯誤 JSON 當 .xls 存下（開檔預覽看到的就是那段錯誤文字）→ 下載與預覽都錯。**修**：`experienceService.js` 補 `const { sanitizeSheet } = require('../utils/xlsxSafe')`。驗證：成人（15+）/未成年（<15）分頁依活動日算年齡、民國生日轉 7 位（`toRoc7`）皆正確。**教訓**：拆檔搬函式時，函式用到的 helper import 要一起搬（同型於 emailService 漏定義那類 bug，build 不會抓、要執行才炸）。
- ✅ **修：首頁課程活動提醒體驗預約卡導向錯誤**（純前端 commit `97c377c`）：會員首頁「課程活動提醒」的體驗預約卡點擊原跳 `/member/experience`（填寫預約頁）→ 改跳 `/member/experience?tab=my`（我的預約分頁）；`MemberExperiencePage` 初始 tab 讀 `?tab=my`（`URLSearchParams`）。build 兩 target + deploy。
- ✅ **修：員工入場今日統計顯示英文 `already_paid`**（純前端 commit `6a74cfe`）：`CheckinPage` 今日統計用 render 內**區域 `typeLabel` map**（`:1110`，非 module 層那份），漏 `already_paid` key；後端 `/checkin/today` counts 以 `entryType` 為 key、「已付費放行」入場 `entryType='already_paid'` → map 查無 → `|| key` fallback 顯示英文原文。補 `already_paid:'已付費放行'`（與入場按鈕用語一致）；確認該 map 已涵蓋所有會出現的 entryType。**教訓**：CheckinPage 有兩份 typeLabel（module 層 line18＋render 內 line1110），統計用的是後者，補標籤要補對地方。
- ✅ **修：課程「報名名單」modal 電話恆空白**（`3.14.0-course-enrollments-resolve-phone`，commit 後端 `31d85af`）：課程層級「查看名單」modal（`CoursesPage` `rosterModal`）來源 `GET /courses/:courseId/enrollments` 原讀 enrollment 文件的 `memberPhone` 欄，但**報名文件從不存 `memberPhone`** → 電話一律空白（**影響所有課程名單、非個案**）。修：比照 `getSessionRoster` 批次 `db.getAll(members)` 反查、以 members 集合權威補 name/phone。**場次名單** `getSessionRoster`（`rosterSession` modal）本就有反查、正確不受影響。純後端。
- ✅ **課程學員認領一律預設墜測通過**（`3.19.0-course-claim-autopass-falltest`，commit 後端 `ea1416c`；E2E 通過）：政策（2026-07-17 拍板）——`claimPendingCourseEnrollment` 認領到課程且該會員尚無 passed 墜測 → 建**移轉式 passed 墜測**（1 年、不需同意書，比照 `claimLegacyFallTest`；`source:'course-roster-claim'`）。**waiver 仍須簽署、不豁免**；只影響之後註冊認領者。已註冊者以 `recordFallTestResult` 手動登記（本日處理：簡芝珊/王雅茵 登記通過；李介中/劉家玉/何禹禎/鄭力溦/王秀慧/吳旻珊 本就已通過）。通用腳本 `/tmp/pass-by-name.cjs <姓名>`（自動判斷：已通過跳過/未簽同意書提示/可登記則登記）。
- ✅ **定期票 × 課程免費入場期間重疊補償（雙向）**（`3.20.0`→`3.21.0`，commit 後端 `37265f6`＋`3329fce`；E2E 5/5＋4/4）：政策（2026-07-17）——定期票有效區間與課程學員免費入場期間重疊 → 票到期日延長 overlap 天數。新 `passOverlapService`：
  - **公式** `newEnd = max(原到期日, 免費結束日) + overlapDays`（票在免費期間「暫停」、剩餘天數完整挪到免費期後；用 max 避免延長段又落在免費期內再被浪費）。overlap 含個別 `courseAccessStart` 插班覆寫（取較晚）。
  - **範圍**：僅**算天數**定期票（`credits==null`）；回數票不耗天、不延長。**冪等**：每票每課程一次（`pass.courseOverlapExt[courseId]` 存 days/prevEndDate/appliedAt＋備註）。
  - **雙向掛點**：①成為課程學員 → `applyCourseOverlapPassExtension`（名單自動認領 `claimPendingCourseEnrollment`、課程收款確認 `transfers.js` confirm course）②課程學員買票 → `applyCourseOverlapForMember`（櫃檯 `POST /passes`、入場 buy_pass `confirmCheckIn` 開票後）。**手動加名單需手動跑一次補償**（backfill 腳本模式）。
  - **回填**：掃 25 位有效天數票持有人，唯一命中 **Raissa：90日票 8/23→10/25（+49 天，重疊 7/6~8/23，入門班週一）**。
  - ✅ **退費自動還原延長（`3.22.0-overlap-revert-on-refund`，commit `46af9d2`；E2E 通過）**：①**課程退費核准** → `revertCourseOverlapExtension` 還原該會員票上「此課程」延長（其他課程延長保留）②**定期票退費核准** → `revertAllOverlapForPass` 先還原該票全部延長、再算退費——**修隱性多退錢**（原公式用延長後 endDate 算總天數/剩餘天數 → 補償天數被當付費價值多退）。還原量＝當時 `newEnd−prevEnd`（由已存 prevEndDate/freeEnd/days 重算），多課堆疊線性回推正確。掛點：`courseAdjustments` 核准退費（取消報名後）、`passAdjustmentService` 核准退費（算天數前）。E2E：票 10/14 疊兩課→1/27、課程A退費→12/06（B 保留）、票退費→**精確回原值 10/14**＋紀錄清空。
  - ⚠️ **剩餘已知邊界（未做）**：續約延長段再與課程期間重疊不另補（同課程冪等擋）；定期票轉讓後新持有人重疊不自動套。
  - 📋 **同日資料操作（名單三批）**：①新竹「入門班 7-8月週一班」加 **Raissa、黃詠慈**（各 8 堂、免費 7/06~9/06）＋**蔡逸夔** 待認領。⚠️ 使用者寫「Raissa Renata」、系統名「Raissa」當同一人處理（待確認）。②新竹「進階班 7-8月週二班」加 **王心怡**（8 堂、免費 7/07~9/07、墜測本就通過、無天數票）＋**劉宜珊、林耿民** 待認領。③新竹「矯正班 07-08月週三班(閎聿教練)」加 **熊紫希、張榕**（各 8 堂、免費 7/03~9/03、墜測皆本就通過、無天數票；矯正班週三有晉瑋/閎聿兩梯、對準閎聿）。④新竹「矯正班 07-08月週三班(晉瑋教練)」加 **陳莉庭、黃紹郡、許紘瑋、陳照昇**（各 8 堂、免費 7/08~8/28、墜測皆本就通過、無天數票）。⑤新竹「矯正班 7-8月週五班」加 **葉育昕、林祺堂、曾聖發**（各 8 堂、免費 7/03~8/22）＋**朱俐穎** 待認領——**首批實際觸發重疊補償**：林祺堂 90日票 +51 天 9/04→10/25、曾聖發 90日票 +51 天 9/10→10/31（兩位皆隊員、9 折不受影響）。
  - ✅ **温詩妤已註冊、全自動化成功**（7/17 08:33 自助註冊）：自動認領技巧班 8 堂＋**墜測自動預設通過（3.19.0 首個真實案例）**；技巧班 **7/7 滿額**（王秀慧/劉家玉/何禹禎/鄭力溦/吳旻珊/朱智萩/温詩妤）。她只剩自簽 waiver＋墜測同意書。⚠️ 待認領姓名比對是精確字元——建 claim 用「温」（异体）而她也用「温」註冊才命中；**建待認領時注意異體字（温/溫、犇/奔等），對不上就不會自動認領**（可 firebase-admin 改 claim 姓名或手動加名單）。
  - **現剩待認領 4 位**：蔡逸夔（入門週一）、劉宜珊/林耿民（進階週二）、朱俐穎（矯正週五）——註冊即自動：進名單＋墜測通過＋定期票重疊補償。
- ✅ **取消請假（銷假）＋請假超限放行不給補課**（`3.23.0-cancel-leave-overlimit-leave`，commit 後端 `925788e`、前端 `edb320c`；E2E **10/10**）：
  - **銷假**：新 `courseService.cancelLeave` + `POST /courses/enrollments/:id/cancel-leave`（authenticateAny＋ownership，家長可代子女）。**條件**：課未開始（`CLASS_PASSED` 以上課時間判）＋場次仍有名額（`SESSION_FULL`——請假時已自動遞補候補、名額可能被佔滿）。**連動**：補課資格作廢（`cancelReason:'leave_cancelled'`）；已用資格報名補課且**未上** → 補課報名一併取消＋釋放該堂名額；補課**已上過** → 整個銷假擋 `MAKEUP_TAKEN`。還原＝報名 leave→confirmed＋場次+1（保留 leaveReason/leaveAt 稽核、另記 leaveCancelledAt）。
  - **超限請假**：`requestLeave` 移除 `MAX_LEAVES_EXCEEDED` 硬擋——超過上限**仍可請假**但**不產生補課資格**（回 `overLimit` 旗標；補課次數上限不變）。
  - **前端**（`MemberCoursesPage`）：已請假列加「取消請假」鈕（課未開始才顯示）→ 確認 modal（說明補課連動/名額限制）；超限按「確認請假」→ 提醒框「⚠️ 已超過補課上限 N 次，此次請假不會產生補課資格」→「仍要請假」才送出。
  - **E2E 10/10**：限內請假有補課／超限請假放行無補課＋overLimit／補課資格用掉→銷假連動取消補課報名＋原場次還原+補課場次釋放／滿額擋／課過擋。
- ✅ **修：新增場次/編輯日期「沒有用」**（`3.25.0-session-create-gym-edit-cascade`，commit 後端 `a82a853`、前端 `db94fdf`）：回報新增場次與編輯日期無效。**三個問題疊加**：①`POST /:courseId/sessions` 用 `req.staff.gymId`（super_admin＝null）→ 建出 gymId=null 隱形場次（1.83.0 修過 generate-sessions、**單堂 createSession 漏修**）→ fallback `course.gymId`；②員工場次列表查詢 `toDate` 截在課程結束日 → 加開/改期到結束日之後的場次不顯示（「編輯日期沒有用」的觀感）→ 改取 max(課程結束日, 今日+180)；③**編輯場次日期/時段原不同步報名快照**（enrollment 存 date/startTime/endTime 副本）→ 會員端我的課程/請假判定停舊日期 → updateSession 連動 batch 同步非取消報名。資料修復：技巧班5-7月週五班 7/24 幽靈場次 gymId 補 gym-shilin。
- ✅ **新增場次可勾選帶入本課學員（個別勾選）**（`3.26.0-add-session-with-students`，commit 後端 `d3cdcbc`、前端 `6707f9c`；E2E 5/5）：`createSession` 收 `enrollMemberIds` → 為選定會員建此場次報名（**費用 0＋已確認**——整期已繳、加開不另計費；gymAccess 沿用課程無限練習期；notes「加開場次帶入」）＋場次計數。前端新增場次 Modal 列該課學員勾選區（confirmed/leave 去重、**預設全勾**、可個別勾/全選切換、顯示 N/M）。帶入後員工月曆/名單、會員月曆/我的課程、入場自動出席全連動；未勾選者不會看到該堂。**順修潛在 bug**：課程無 `tags` 欄位建場次 Firestore throw（`tags: course.tags||[]`）。
- ✅ **保險名冊寄送支援副本收件人（CC）**（`3.27.0-insurance-email-cc`，commit 後端 `33902f9`、前端 `787b74c`）：`emailService.sendEmail` 加 `cc` 參數（Resend `payload.cc`，字串/陣列）；`send-insurance-email` 讀 `settings.insuranceCcEmails`（逗號/分號/空白分隔、驗 email 格式）帶 CC、歷史 `insuranceExports` 補記 cc。前端體驗課程「⚙ 課程設定 → 保險名冊寄送設定」加「副本收件人（CC）」欄（全館共用、settings 整包存免改後端白名單）。
- ✅ **補課場次四項規則**（`3.30.0-makeup-dayonly-cancel`，commit 後端 `25a9bb7`、前端 `8eb227a`；E2E 6/6）：
  - ①**補課場次只能「取消補課」（上課一天前）**：新 `cancelMakeup` + `POST /courses/enrollments/:id/cancel-makeup`——限今天早於上課日（`CANCEL_DEADLINE`）→ 報名取消＋釋名額＋補課券還原 available（額度不變）。後端權威擋：補課場次請假 `MAKEUP_NO_LEAVE`、補課/試上-only 課程申請退費/暫停 `MAKEUP_NO_ADJUST`（courseAdjustments 兩端點）。
  - ②**補課/試上不繼承免費入場期**：`getCourseAccess` 對 `isMakeup`/`isTrial` 報名只在**上課當天**給入場資格（`dayOnly:true`、start=end=今天），不再給課程整段 unlimitedPractice。
  - ③**月曆補課標籤**：日格本有 `(補課)` 綠字；選日展開場次列補綠色「補課」標籤。
  - ④**補課選場次分兩區**：「已申請補課的場次」（綠卡+標籤+改期提示）／「可補課的場次」（照常可按）。會員端補課群組標「補課」、隱藏退費/暫停/請假、顯示「取消補課」鈕（確認 modal）。
- ✅ **課程認領支援 leaveDates——認領時自動登錄請假＋給補課券**（`3.33.0-claim-leave-dates`，commit `6e1cb06`；E2E 4/4）：`pendingCourseClaims` 加 `leaveDates[]`（認領前已請過假的日期）→ 認領時該堂直接標 `leave`（補登記、**不佔場次名額**）、其餘 confirmed，並跑 `reconcileMakeupEntitlement` 自動給補課券。**蔡逸夔** claim 已標 `leaveDates:['2026-07-13']`（入門班週一）→ 註冊即自動：入名單 7 堂＋7/13 請假＋補課 1 次＋墜測通過。通用功能：之後「未註冊但已請過假」的名單學員照標即可。
- 📋 **請假補登資料操作（2026-07-17）**：**朱俐穎**（矯正班週五）7/3 請假補登（過去日期走 firebase-admin：報名標 leave＋場次−1＋reconcile → 補課 1 次、券效期至 10/19）。**宋沛德**（前一期學員 7/15 補課認領）——做到一半使用者喊停、7/15 已過**整案取消**（claim 已刪、單堂認領程式改動已還原未部署，無殘留）。
- ✅ **Render 冷備建置完成（Railway 應變 ④，2026-07-17 晚）**：`redrock-api-backup.onrender.com` 與正式站同版本、GitHub push 雙部署。**根因排除**：`FIREBASE_PRIVATE_KEY` 當初貼上格式壞（Invalid PEM）→ 每次新部署開機 crash → 部署失敗、Render 留 7/14 舊版跑（症狀＝版本卡舊＋`Unable to detect a Project Id`）；以 SA json 的 private_key **多行原格式**重貼（pbcopy 給使用者、不落檔）→ 存檔自動重部署一次過。**三項驗證**：/health 同版本 ✓、Firestore 憑證（登入端點 401 INVALID_CREDENTIALS）✓、**JWT_SECRET 同值**（Railway 發的 token 在 Render 直接通過認證回真實資料→故障轉移登入不中斷）✓。**custom domain `api.redrocktaiwan.com` 已預登記**（Waiting for DNS＝待命正常）→ 故障轉移＝Porkbun 改一筆 CNAME（~1 分 TLS）。playbook 已更新；⚠️ 維運紀律：Railway 環境變數異動須手動同步 Render。Railway 應變 ①②③④ 全完成。
- ✅ **修：單一梯次課程報名頁看不到課程簡介**（純前端 commit `6b63815`）：回報會員報名完全看不到簡介。**根因＝兩條 7/9 設計疊加**——「單梯類別點卡直接跳報名頁（略過類別介紹層）」＋「梯次頁不重複顯示說明」→ 單梯課程（技巧班士林/入門班週一/進階班週二等）簡介永無機會顯示（說明資料其實都在，各班別 143~409 字）。**修**：報名頁依進入路徑判斷——直接跳進來（`selectedCategory` 空）→ 海報下補顯示簡介；從類別層進來→維持不重複。**資料現況**：週期訓練/青少年進階 兩班別無介紹（無梯次、影響小）；照片僅小蜘蛛人初級/進階有、其他班別可至班別管理上傳。
- ✅ **移除「退費-每堂扣除」欄位 UI**（純前端 commit `49e83f8`）：政府公式後 `perSessionDeduction` 棄用——班別表單/加開梯次覆寫/編輯梯次/班別列表摘要 4 處移除（摘要改「退費費率X%（政府公式）」含 20% 夾）；資料欄位保留相容、不再顯示不參與計算。**退費唯一可調參數＝手續費率（≤20%）**。
- ✅ **週課退費改政府公式**（`3.36.0-gov-refund-formula`，commit 後端 `4e0086d`、前端 `777671a`；算式驗證 5/5）：**退費＝剩餘堂數價金 − 手續費**（每堂單價＝已繳÷總堂數；剩餘堂數＝總堂數−已開課堂數不論出席/請假；手續費＝剩餘價金×費率、**法定上限 20% 系統硬夾**）。開課前＝剩餘全數、同一公式涵蓋（取代原「開課前扣5%／開課後扣每堂850」雙軌制）。費率走班別/梯次 `handlingFeeRate`（管理員班別管理可調、超過自動夾 20%）；`getCourses` 附掛 `refundFeeRate`（resolved+夾）；request 存明細（total/held/remaining/remainingValue/feeRate/fee）。**前端**：會員報名「規則確認」退費方框改政府規則動態文字（顯示該課費率＋範例）。驗證含使用者範例 30000/20堂/上10堂/20%→退 12000、25% 夾 20%、開課前退 80%、調低 5%、全上完 0。⚠️ `perSessionDeduction`（每堂扣除 850）不再用於退費計算（欄位保留）。
- ✅ **退費手續費預設 20% 可彈性調整**（`3.38.0-refund-fee-default-20-adjustable`，commit 後端 `41499a3`、前端 `a1cc372`；正式 API 驗證 18 門課 `refundFeeRate` 全 0.2）：拿掉「法定上限 20%」文字與**硬夾**（`Math.min(...,0.2)` 全移除）——`RULE_DEFAULTS.handlingFeeRate` 5%→**20%**、退費試算 `feeRate = handlingFeeRate ?? 0.2`（可調高調低）。**員工端班別/梯次費率欄位保留**（中途一度整組移除、使用者改口保留→revert）；會員規則方框動態顯示該課費率（無法定上限字樣）。**資料**：11 個班別費率 0.05→0.2、梯次覆寫 0 殘留——**順帶修正實際問題**：3.36.0 上線後班別都還存舊預設 5%，退費試算實際抓 5% 非 20%，現資料/程式兩邊一致 20%。
- ✅ **退費費率雙軌可調（開課前/開課後）**（`3.39.0`→`3.40.0-refund-fee-both-adjustable`，commit 後端 `47da98b`＋`9dcd2e4`、前端 `f012f88`＋`58d4fa9`；正式 API 驗證 18 門課 開課後 0.2/開課前 0.05）：承 3.38.0 追加——**開課前手續費 5%、開課後走可調費率（預設 20%）**，隨後兩個費率**都改可調欄位**：新增 `preStartFeeRate`（RULE_DEFAULTS 0.05、班別/梯次繼承覆寫，與 `handlingFeeRate` 對稱）。退費試算 `feeRate = preStart ? (preStartFeeRate??0.05) : (handlingFeeRate??0.2)`（開課前判定＝今天<課程 startDate，無起始日以已開課堂數推）；refundNote 標明（開課前/開課後）。`getCourses` 附掛 `refundPreStartFeeRate`；**會員報名規則方框兩費率皆動態公告**（開課前 X%、開課後 Y%）。員工端班別表單兩欄位並列＋加開/編輯梯次皆可覆寫。**順修既有 bug**：`PUT /courses` allowedFields 原漏 `handlingFeeRate` → 「編輯梯次」改費率其實被默默丟棄（僅加開梯次覆寫有效），一併補上兩欄位。
- ✅ **銷假確認 modal 預檢（名額/補課額度先看再按）**（`3.41.0-cancel-leave-precheck`，commit 後端 `3ddade3`、前端 `2b543b1`；E2E 打正式 API **8/8**）：承「取消請假流程」問答——結論：**不用先取消補課，先按取消請假即可**（`cancelLeave` 檢查順序 課已開始→原堂名額→補課額度，全過才寫入、被擋不動資料；先手動取消補課才發現原堂滿也非死局——補課券還原 available 可再約他堂）。小改善：新增**唯讀預檢** `GET /courses/enrollments/:id/cancel-leave-precheck`（`courseService.precheckCancelLeave` 鏡射三關、回 `{ok, blockCode, session{remaining,enrolledCount,maxStudents}, quota{usedMakeups,newEntitlement}}`；⚠與 `cancelLeave` 檢查邏輯**同步維護**）；會員銷假 modal 開啟即顯示「該堂剩 N 位/已滿＋取消後補課額度＋被擋原因」，被擋時確認鈕禁用顯示「無法取消」（預檢失敗 fallback 不擋、後端仍權威）。E2E：有名額 ok/已滿 SESSION_FULL/used 超額 MAKEUP_OVER_QUOTA/唯讀不動資料。
- ✅ **肖像權授權聲明文案調整**（純前端 commit `000ebad`，member/staff 已 deploy）：課程報名表「肖像權授權同意聲明」第二句「將進行局部拍攝與錄影」→「將**不定期進行拍攝或攝影**」（全站僅 `MemberCoursesPage` 一處，後句授權範圍不變）。
- ✅ **課程請假、補課方式彈窗改四段式＋動態追隨設定**（`3.42.0-courses-attach-leave-rules`，commit 後端 `7e1eae7`、前端 `9f5a74d`；正式 API 驗證）：報名表規則方框改四段新版——1.請假次數限制（N 次+特殊狀況展延）2.請假時限（課前 H 小時）3.**取消請假規則**（額度重算/名額滿無法取消/先取消已預約補課）4.補課安排與時限（他梯次自行申請/結束後 X 內完成）。**動態值追隨班別/梯次設定**：後端 `getCourses` 附掛 `ruleMaxLeaves`/`ruleLeaveDeadlineHours`/`ruleMakeupDeadlineDays`（走 `resolveRules` 一次解析、順帶收斂原 refundFeeRate 兩次呼叫）；補課期限 30 倍數顯示「N 個月」（60→2 個月）、非整月顯示「N 天」。順修舊文案過時的「補課 2 週內完成」（實際 60 天）。
- ✅ **銷假引導版（modal 內就地取消補課）＋SESSION_FULL 文案補齊**（`3.43.0-cancel-leave-guided`，commit 後端 `c0e8638`、前端 `3497bd4`；E2E 打正式 API **8/8**）：承 3.41.0 預檢——原本被 `MAKEUP_OVER_QUOTA` 擋下後要會員自己關 modal 找補課卡取消再回來（帶一半）。引導版：預檢回傳 **`bookedMakeups`**（此課程補課券對應的已預約未上補課：enrollmentId/課名/日期/`canCancel` 上課一天前；由 used 券 `rightIds` 對 enrollment `makeupId` 關聯）→ 銷假 modal 被擋時**就地列出**每筆＋「取消此補課」鈕（複用 cancel-makeup 端點）→ 取消後**預檢自動重跑**（`cancelLeavePreN` 計數器觸發 effect）、額度夠了確認鈕即解鎖，**同一視窗一路按到完**；已過取消期限顯示灰字不可按。文案：`SESSION_FULL` 兩處（cancelLeave＋precheck）由「可能已由候補遞補」→「可能已由候補遞補、**他人補課或試上**」（與報名規則彈窗對齊）。E2E：擋下→bookedMakeups 列出→就地取消→重跑 ok→銷假走完＋新文案驗證。
- ✅ **退費方式說明改三段式（依法令規定）**（純前端 commit `4a14f80`，member/staff 已 deploy）：報名表退費方框改——1.計算公式（剩餘堂數價金−手續費/每堂單價/剩餘堂數含「不論出席或請假皆以已開課天數計算」）2.手續費比例（**開課前收總課程費用之 P%／開課後收剩餘價金之 R%**，動態追隨班別/梯次設定）3.試算範例（8 堂 8,000、已開 2 堂 → 剩餘 6,000 − 手續費 20%＝退 4,800，手續費/退還隨 R 動態重算）。標題「依政府規定」→「依法令規定」。註：開課前「總課程費用之 P%」與後端「剩餘價金 × P%」數學等價（開課前剩餘＝總堂數），後端免改。
- ✅ **我的課程加「📋 課程規則」查看入口**（純前端 commit `8b12ffd`，member/staff 已 deploy）：原規則（請假補課四段＋退費三段）只在報名步驟 3 閃現一次、報名後無處可查 → 我的課程每張課卡統計列下加藍字「📋 課程規則（請假/補課/退費）」→ 唯讀 modal 顯示完整兩塊（候補/純補課群組不顯示）。**連動保證（單一來源）**：兩塊抽成模組層共用元件 `LeaveMakeupRulesBox`/`RefundRulesBox`——報名步驟 3 與規則 modal 用同一份 JSX，**改文字改一處兩邊同步**；動態值（N 次/課前 H 小時/補課 X 個月/兩費率）讀 `getCourses` 的 resolveRules 附掛欄位，**員工改班別/梯次設定即時反映**。course 物件 state 查無時現抓一次、仍無（已下架）顯示預設規則＋警語。
- ✅ **試上付款改共用元件＋體驗/試上只開放轉帳**（純前端 commit `088654e`，member/staff 已 deploy）：試上 modal 原手刻「銀行匯款＋日期/末五碼」→ 改共用 `PaymentSection`（**試上新顯示匯款帳號資訊**——原本沒告訴會員匯到哪；多「匯款銀行名稱」欄一併存轉帳單供待收款核對）。體驗預約與試上皆傳 `methods={['transfer']}` → **只顯示轉帳**（頁面層限制、與系統付款開關取交集——之後系統開電子支付這兩處仍只轉帳，要放寬改參數即可）。兩處付款預設本就 transfer、送出驗證不變。
- ✅ **修：器材租借「費率設定」按鈕跳去入場頁**（純前端 commit `0e036cb`）：`getRentalSettings` 誤用 `memberClient`——員工無會員 token → 401 → memberClient 攔截器踢 `/member/login` 再彈回員工預設頁（入場），看似「按鈕變超連結」。新增 `getRentalSettingsStaff`（staff client）員工頁改用；會員租借頁不動。同 7/7 CSV 下載 401 同型雷：**員工頁 API 一律走 `client`、會員頁走 `memberClient`**。
- ✅ **器材租借：取消/修改/員工備註＋付款方式標籤**（`3.44.0`，commit 後端 `3ed7aad`、前端 `0411d21`；E2E **11/11**）：後端 `POST /:id/cancel`（會員限 pending/confirmed＋ownership、員工亦可；連動作廢 pending 轉帳單）、`PUT /:id`（修改日期/方案/數量，**費用共用 `computeRentalItems` 後端重算**；會員限 pending、員工限取件前）、`PUT /:id/staff-note`（員工備註，**`/my` 端點層剔除**會員看不到）。前端：待辦/確認 modal/雙端卡片 現金(琥珀)/轉帳(藍)標籤；會員卡「修改申請/取消申請」鍵＋modal；員工卡 修改/取消/📝備註 三鍵。
- ✅ **租借通知保留到退畢押金＋歷史紀錄表**（`3.45.0`，commit 後端 `3584a32`、前端 `4f86c3e`；E2E 4/4）：員工通知分頁改四段生命週期——待確認申請→**待取件**(confirmed)→**使用中・待歸還**(active)→**已歸還・待退押金**（`💰 退回押金 NT$X` 鍵→`POST /:id/return-deposit` 結案）；歸還 modal 押金語意標注（勾＝當場退結案／不勾留待退／填扣除原因＝扣除結案）。**歷史紀錄新分頁**（表格：會員/館別/期間/器材/租金/押金/付款/狀態/押金處理/經手，結案自動移入）。
- ✅ **體驗/試上會員取消/修改＋員工備註**（`3.46.0`，commit 後端 `1fba252`、前端 `0c20b28`；E2E **8/8**）：會員「我的預約」卡加 修改/取消 鍵，**活動一天前鎖定**（`memberBookingGuard`：ownership＋`taiwanToday()>=bookingDate` 擋 `DEADLINE_PASSED`）。**取消**：已繳費必填退款帳號（銀行代碼+帳號）→ 存 `refundRequested`＋退款試算（已繳−手續費，手續費走體驗設定 `refundHandlingFee` 預設 100、員工課程設定頁可調）＋通知同館管理員；未繳費免帳號；連動同員工取消（作廢票券/釋試上名額/清課程排班/作廢轉帳單）。**修改**：體驗改日期時段（`updateExperienceSchedule` 連動）；試上換場次（同館同價、`enrollTrial` 權威、不同價擋 `PRICE_MISMATCH`）。員工端：📝備註（`staffNote`、`/my` 剔除）＋已繳費取消卡顯示待退款金額與帳號。
- ✅ **修：王之荷體驗教練費 0 元存檔變回 420**（資料修正＋前端 commit `743d746`）：根因＝存檔時教練費欄位為**清空**狀態（刪掉 420 沒輸入 0）→ 後端存 `null`＝「未設定」→ 顯示回預設 420（發票金額有輸入故正常；輸入 0 本就可存）。資料改回 0；前端存檔擋空值「金額不可留空（免收請輸入 0）」。
- ✅ **會員試上清單不顯示剩餘位數、額滿不列出**（純前端 commit `ccf52dc`）：場次卡只顯示試上費；額滿場次整張隱藏（分頁數/試上改期候選同步排除）；後端 `getTrialSessions` 不動（員工端仍看得到額滿）。
- ✅ **Climbio VIP 名單匯入＋自動認領（28 位，無期限）**（`3.47.0-legacy-vip-claim`，commit `adfa319`；E2E 全鏈通過）：新 `legacyVips` 集合＋`memberService.claimLegacyVip`（掛 createMember：有電話→電話+姓名、無電話→姓名 `legacyNameMatch` 比對，認領即通知兩館管理員核對）＋`POST /vip/import-legacy`（super_admin 冪等匯入，SA 憑證失蹤期間走 API 完成）。**全家 VIP**（杜林炘/黎思宇/黃芸茵/黃保瑞/陳美璇 5 位）：認領者標 `vipFamily` → 名下既有子帳號一併 VIP、**之後新建子帳號自動繼承**。已註冊 4 位立即生效（王登第/王登翰/黎思宇+子/黃芸茵+子，`vipMembers` 6 筆——黎芷芸在爸媽兩邊各有子帳號皆 VIP）；**待認領 24 位**（13 位帶 Climbio 電話、11 位姓名比對）。查進度：掃 `legacyVips.claimed`。
- ✅ **Downloads 資料夾整理＋SA 憑證搬家**（2026-07-18，commit `aaaa9ae`）：SA 金鑰被誤丟垃圾桶（已還原）引發整理——135 項目分類搬至 `~/Documents/RedRock/`（**憑證**/會員個資/保險名冊/比賽/財務報表/系統文件/素材圖片/舊備份）與 `~/Documents/個人文件/`（稅務/證券憑證/影片簡報）；安裝檔 11 個確認後刪除。**Downloads 現只剩 repo 兩個＋工作區 CLAUDE.md/CLAUDE.local.md**。⚠️ **SA 憑證新路徑：`~/Documents/RedRock/憑證/redrock-dev-a35c1-firebase-adminsdk-*.json`**（兩把皆可用、新位置實測過；CLAUDE.md/CLAUDE.local.md 已同步）——之後跑 firebase-admin 腳本用此路徑。
- ✅ **員工端體驗預約顯示 FB 名稱＋會員備註**（純前端 commit `94a4d59`）：預約卡主區（免展開）顯示 📘FB 名稱＋💬會員備註（原備註藏在展開名單底部）；待辦體驗詳情 modal 加 FB 列、備註標籤改「會員備註」（與員工備註 staffNote 區隔）。
- ✅ **實際匯款/收款金額＋體驗營收重大修復**（`3.48.0`→`3.49.0`，commit 後端 `6a413a1`＋`0803ea7`、前端 `d618410`）：
  - **真 bug：體驗/試上確認收款從上線以來不記營收交易** → 結帳「教學費」永遠沒有體驗的錢（今天新竹結帳課程 0 即此因）。修：新 `experienceService.recordExperienceRevenue`（冪等 `revenueRecorded`）——**一般體驗記發票金額**（`invoiceAmount ?? 總費−人數×175` 保險代收不計）、**試上記全額**，`type:'course'` → 結帳教學費/營收報表自動吃到；**兩條確認路徑**（體驗確認端點＋待辦轉帳確認 transfers confirm 的 experience side-effect）共用；**取消已確認 → `reverseExperienceRevenue` 負向同類別沖銷**（員工取消＋會員取消皆掛）。**認列在活動日**（`recognitionDate=bookingDate`，沖銷同日對沖）——比照課程認列最後一堂。回填：王之荷 1400（活動 7/18）＋蔡沂噥 800（活動 7/19 → 結 7/19 的帳）；**新竹 7/18 已先結帳（快照 course 0）→ 需「當日再次結帳」帶入 1400**。
  - **會員「實際匯款金額」欄（全訂單型別、選填）**：`PaymentSection` 轉帳區加欄（課程/體驗/試上/租借自動吃到）＋比賽報名/重填繳費、入隊、`TransferReuploadModal` 各自加；後端 `/transfers/upload` 存 `paidAmount`、體驗/比賽/租借訂單存 `memberPaidAmount`。
  - **員工確認收款 modal**：改列 應收金額／會員填實際匯款（**不符時琥珀警示「與應收不符」**）／**實際收款金額**（可編輯、預設帶會員值）→ confirm 存 `confirmedAmount` 供對帳。
- ✅ **當日再次結帳吃即時收入**（`3.50.0-resettle-live-income`，commit 後端 `6bbf046`、前端 `726716d`）：回報「再次結帳沒更新」——根因 `GET /daily-settlements/today` 已結帳時 early return **舊快照**、不重算 → 再次結帳預填舊 income 再存一次（結帳後新入帳永遠帶不進）。修：已結帳仍即時重算、回傳 `{settlement:快照, live:即時, alreadySettled:true}`；前端 `startResettle` **系統收入改吃 live**、點鈔/加減項/發票/手動值仍沿用快照預填。後續「入場收入岩鞋租借不見了」為誤會（手動框空白＝未填過、採系統值；總計 6,510 證明都有算），資料庫逐版查證零遺失。
- ✅ **蔡沂噥體驗時段修正＋員工編輯改起迄 time picker**（`3.51.0`→`3.52.0`，commit 後端 `0f8d590`＋`3764301`、前端 `a78ec30`＋`69aca3c`）：蔡沂噥預約只填「11:00」→ `parseBookingTime` 預設 +2h → 排班錯排 11:00~13:00；以既有 `/schedule` 連動端點修正為 11:00-12:00（課程/場次/**排班月曆**/票券四處同步、舊班已刪）。中途做過「價格表課程類型時長 durationMinutes 帶入」機制，**使用者拍板收掉**（只影響體驗但偏好簡單做法）→ 全數 revert（後端/設定 UI/Firestore 零殘留）；改為**員工「編輯預約」時段自由文字 → 開始/結束兩個 time picker**（擋結束早於開始、開啟自動解析帶入、存檔走既有四處連動）。之後單一時間的預約由員工編輯時點選起迄即可。按鈕「✏️ 編輯參加者」→「**✏️ 編輯資訊**」（modal 本就含日期/時段/參加者，commit 前端 `5fe0cc1`）。
- ✅ **課程「請假補課總表」（員工）**（`3.53.0`→`3.53.1`，commit 後端 `7186395`＋`0189128`、前端 `6016941`；正式資料驗證通過）：原本請假/補課只有分散單堂視角（場次名單/月曆補課數/出缺席CSV），無彙總。新 `GET /courses/:id/leave-makeup-summary`——每位學員：請假日期列表/次數/上限（含 `maxLeavesAllowed` 個別覆寫）、補課額度（剩/共/到期日）、**已排補課**（由 used 券 `usedSessionId` 反查場次，含補到他班別、標「已上」）；姓名/電話 members 權威補齊；**另附此課程 `pendingCourseClaims` 未認領名單的預標請假**（供處理未註冊者資料時核對）。前端課程梯次列加「**假補**」鈕 → modal 表格＋CSV 下載（未認領列琥珀底標註）。驗證：技巧班 4 位請假、朱智萩補課 剩1/共2＋7/17已上、入門班蔡逸夔未認領預標 7/13 全對。修 courses.js dayjs 未 import 500（該檔慣例 inline require）＋到期日 UTC 差一天。
- ✅ **休館停課（場次一鍵停課＋豁免補課券）**（`3.54.0-closure-cancel-session`，commit 後端 `1ebcaa1`、前端 `fc30eb5`；E2E **7/7**）：解「全館休館定期票會展延、當天課程沒機制」缺口。員工場次詳情加「**⛔ 休館停課**」鈕（確認 modal 列明後果）→ `POST /courses/sessions/:id/closure-cancel`（`courseService.closureCancelSession`）：①場次 cancelled(休館) → **退費公式自動不計此堂**（total/held 皆排除）②該堂正取自動發「**休館補課券**」`source:'closure'+exempt:true`——**豁免額度不變量**（reconcile 計算/作廢/復活全排除、cancelLeave/precheck usedQ 排除）＝不佔請假配額、不受上限 2 次，效期同一般補課（結束+N天）③補課學員報名取消＋原券還原 available ④該堂請假者報名取消＋配額 reconcile 收斂（課沒上成、請假不算也不補）⑤試上學員標取消、回報數請櫃檯另處理 ⑥**會員首頁通知**（`/my/alerts` 新 `course_closure_makeup`：🧗「休館停課補課通知」，券用掉/過期自動消失）。想全班統一補課時間 → 用既有「新增場次勾帶入學員」加開（券自動核銷連動屬後續、目前券留著會多一次，加開時記得口頭提醒學員擇一）。E2E：停課發券→exempt 券過 reconcile 不收斂→請假者配額收斂→首頁通知全對。
  - ✅ **停課券優先消耗**（`3.55.0-closure-makeup-priority`，commit `25948be`；E2E 2/2）：`enrollMakeup` **後端權威換券**——即使前端傳的是配額券，同課程還有可用停課券（source:'closure'）就改消耗停課券（多張取最早到期）；配額券保留（受不變量管、留著彈性大，停課券＝場館欠課先清）。即使已上過其他補課亦同。
  - ✅ **公告連動（純前端 commit `22d542a`）**：休館/特殊營業時間公告表單（限管理員、新增時）加「**是否影響該時段課程**」radio——**不影響**＝純公告課照上（休館不停課）；**影響**＝送出公告後自動列出該館生效期間內全部場次（勾選清單、預設全勾、顯示人數，特殊時間可取消勾不受影響的堂）→ 確認後逐堂呼叫 `closure-cancel` 停課發券、回報「停課 N 堂、發出 M 張券」。**停課不休館**＝不發公告、直接用場次「⛔ 休館停課」鈕。期間無場次自動提示免處理；批次失敗堂數會回報請至場次管理補按。⚠ 公告刪除/下架**不會**自動復課（需要時用「新增場次勾帶入學員」重建）。
- 📋 **7/10–7/11 停課/休館補登（2026-07-19 執行）**：使用者註記——**士林館休館停課、新竹館停課不休館**。處理：①**新竹 6 場次批次休館停課**（週五A/週五B/矯正班週五＠7/10、週六A/週六B進階/進階班週六＠7/11）→ 已認領 **13 位學員發停課補課券**（週六A 4/矯正週五 4/週五A 2/週六B進階 2/週五B 1；進階班週六 0 報名）②**士林補建追溯休館公告**（7/10~7/11、publishUntil 已過→會員端不顯示，休館判定/定期票補償生效——補償邏輯：士林單館票補 2 天、全館票因新竹有開不補 ✓）③士林那兩天僅一堂本就取消的舊技巧班（0 報名）、無需處理。
- ✅ **認領時補發停課券**（`3.56.0-claim-closure-rights`，commit `5e72b3c`；E2E 3/3）：`claimPendingCourseEnrollment` 擴充——認領時掃該課程「已休館停課」場次（cancelReason 含 休館/closure）→ **一併補發 exempt 停課補課券**（與已在名單學員待遇一致；claim `leaveDates` 落在停課日不發、比照請假者不補）。涵蓋孫筠棋（週五B 待認領）與之後所有認領、含未來休館。E2E：fixture claim → 建會員 → 只掛未取消場次＋自動補發 7/10 停課券。
- ✅ **修：通知面板「查看」鈕失效**（`3.57.0-notification-links`，commit 後端 `f9a0df9`、前端 `2270d2c`＋`9309cca`）：根因＝**通知從未帶 `link` 欄位**（notificationService 不支援、近 184 則全空）→ 查看鈕條件渲染 `i.link &&` 根本不出現。修：①前端 `NOTIF_LINK` 依 type 補預設導向（shift_*→排班、course_roster_claimed→課程、legacy_vip/pass_claimed→會員管理…）——**現有通知立即有查看鈕**、免回填 ②後端 `createNotification`/`notifyRoleInGym` 支援 `link` 透傳（之後可帶精準連結）。⚠ 過程踩雷：python regex 把 NOTIF_LINK 插進 NOTIF_CATS 陣列內 → **build 失敗但 firebase deploy 照樣部署了舊 dist**（`&&` 鏈中 build fail 應中止、但 tail pipe 吃掉 exit code）→ 教訓：**`vite build | tail` 的管線會吞失敗**，build 後必看「✓ built」字樣再 deploy。
- ✅ **兩則通知/名單顯示修復**（`3.57.1`＋`3.58.0`，commit `f7a859b`＋`094fa60`）：①課程報名通知「查看」分流——待收款→待辦頁（原行為）、**已確認/免費（後台處理、名單帶入）→課程頁**（原一律導待辦頁，人在待辦頁點了原地不動像沒功能，林依岑改掛通知即此案）②**士林技巧班名單出現 UUID**＝朱智萩 7/17 加開場補課報名——`enrollMakeup` 漏存 memberName、報表 fallback 顯示 memberId → 補課報名改以 members 權威補存姓名＋回填既有空白 3 筆。
- 📋 **林依岑改掛週五B班（2026-07-19 資料操作）**：週六A 8 堂取消（transferred_to_週五B）→ 週五B 全期 8 堂 confirmed（費用 0、免費入場期 7/01~8/31）。使用者確認 **7/03、7/17 實際已於週五B上課**（出席已補登 present）；7/10 該堂隨停課補登轉停課券（她即週五B那 1 張）。家長端現況：共 7 堂・已上 2・剩 5・可補課 1（停課券、效期 9/19）。改掛 SOP：原班報名 cancelled+場次−1 → 新班全期建報名+場次+1 → 過去堂數依實況補登出席或移除。
- ✅ **課程列表「📋 假補總表」（全部課程版）**（`3.59.0`→`3.59.1-lm-summary-all-bulk`，commit 後端 `e2330b0`＋`0d15578`、前端 `77f7f05`；正式資料 15 門課 2 秒）：課程列表右上新增按鈕 → modal 頂部下拉「全部課程／單一課程」切換；全部模式依課程分段（課名＋上限＋補課期限＋學員表＋未認領琥珀列）、CSV 多「課程」欄一份匯出全部。後端 `GET /courses/leave-makeup-summary/all`（可帶 gymId、只回有資料課程）。**踩雷修復**：初版逐課呼叫單課邏輯（19 門課串行 **15 秒**）→ 前端 axios timeout 10s 判「載入失敗」→ 改**整批一次撈**（5 集合各一查詢＋members/sessions getAll、記憶體組裝）15s→**2s**。教訓：彙總端點勿逐項複用單項邏輯，collection 級一次撈。
- 📋 **黃奕淇、莊孟貞 帶入新竹「青少年班 培訓班（週六班）」（2026-07-19）**：兩位未註冊 → 建待認領（註冊即自動入名單 7 堂＋7/11 停課券＋墜測預設通過）。該課今天才建、補把 **7/11 場次停課**（0 報名 0 發券；認領機制會自動補發停課券）。
- ✅ **5-7月小蜘蛛人請假補課資料全面處理（2026-07-19，來源 `~/Documents/RedRock/會員個資` 移入的 xlsx 明細 39 筆）**：
  - **已認領 13 位入帳**（請假補登＋補課核銷/預排＋出席，全數驗證）：李星諭/何宇涵/何宇澄（7/04 假→7/15 週三A 已上、各剩 1 券）、張羽希/喬（7/12→7/17 週五B 已上、結清）、陳威宇（密集班 7/10 停課發豁免券→7/17 已上、結清）、曾郁淇（停課券→7/24 週五A 已排）、許宸碩/廖彥澄（**7/24 預請假**＋7/21 週二B 已排、各剩 1 券）、林柏亘/洪紹祖/洪紹文（7/08 假、各 1 券待協調）、陳以喬（前一梯 5/30 豁免券＋停課券共 2 待協調）。
  - **待認領 4 位標到 claim**：黃勇淳（leaveDates 7/08+7/15；7/18 已補上與 5/13 前一梯記 notes 待認領後手動）、伍雪靜（leaveDates 7/19＋7/21 已排）、周詠弈（7/17 已補上＋7/14 課前2小時不予補課，notes 防誤發券）、莊孟貞（5/16 前一梯 notes）。
  - **已補完無欠（純記錄）**：黎芷芸、賴思妤、徐章齊、施予悅、劉理岸。樞紐表其餘名字不在明細＝舊梯已結、未動。
  - **跨期補課（本期名單沒有的 10 位）→ 新 `crossCohortMakeups` 集合**（`3.60.0-cross-cohort-makeups`，commit 後端 `3d9b447`、前端 `ee75dec`；roster 實測驗證）：booked 3 位（范語晨/黃彥凱→7/22 週三A、陳若僖→7/25 週六A）＋pending_arrange 7 位（榮謙如/宇 5/16、吳宇菲/商 5/29、**賴思綺×3**、陳宥希/宣妙 6/30）。**員工端顯示**：場次名單（getSessionRoster）與月曆名單附「跨期補課」紫標列、**今日課程學員**（today-course-students）同顯「跨期補課・櫃檯放行」且不可點快速入場（非會員、memberId null）。上完課於**場次名單點「✓ 補課完成結案」鈕**（`3.60.1`，`POST /courses/cross-makeups/:id/done`，結案後列上顯示 ✓ 已結案；commit 後端 `962c615`、前端 `b348902`）；pending 者家長來約時補 targetSessionId/targetDate 即自動出現在名單。
- ✅ **課程學員報表排除補課/試上**（`3.60.2`，commit `64a426b`）：`/members/reports/active-course-students` 原把 isMakeup/isTrial 報名列為該班學員（週五B 多出 3 位 7/17 補課者）→ 排除（單日行為、入場資格僅當天）；驗證週五B 只剩林依岑、總數 40→31。補課者於假補總表/場次名單（補課/跨期補課標籤）檢視。**課程學員頁另加班別下拉篩選**（`RowMemberList` 加 `groupFilterLabel` prop，選單列各班、與姓名搜尋並用；commit 前端 `9d92de5`）。
- ✅ **試上確認收款自動發當日體驗券**（`3.61.0-trial-auto-ticket`，commit `63e4283`；E2E **5/5**）：查證「報名試上會發單日券嗎」→ **原本不會自動發**（1.29 原設計自動、2.34 試上改制時 confirm 分支漏接，只剩員工手動「🎟️ 發放入場券」鈕）→ 無墜測的試上者入場會被擋（day-only 課程資格仍過墜測關卡；**當日體驗券才豁免墜測**）。修：兩條確認路徑（`/experience-bookings/:id/confirm` 試上兩分支＋ transfers confirm 的 experience side-effect `kind==='trial'`）確認收款即 `syncExperienceTickets` 自動發 1 張（冪等、依已發張數補差；一般體驗維持員工手動發放）。手動鈕保留作補發。E2E：確認→1 張當日券綁試上者→重複確認不重發→ticketsIssued=1。
- ✅ **修：手機會員詳情捲不動、底部「刪除會員」被切**（純前端 commit `8c57c16`）：`MembersPage` 手機版詳情為 `position:fixed inset:0 overflowY:auto`，但底部只 `padding:16` → 最後一顆「刪除會員」被員工端固定底部導覽列蓋住、且內容高度差不足以觸發捲動 → 卡住。修：底部 padding 加大為 `calc(96px + env(safe-area-inset-bottom))`＋`WebkitOverflowScrolling:touch`（iOS 慣性）。教訓：手機全螢幕 fixed 面板要留底部導覽列高度的 paddingBottom，否則最後內容被 tab bar 蓋住且無法捲到。
- 📋 **小蜘蛛人週三A班 手動設「強制開放」試上/補課（2026-07-20）**：回報已開放試上補課卻看不到——根因＝該梯只有 **1 位常態(整期)報名學員**（何宇澄；另 3 位是補課學員不計），`trialTarget/makeupTarget` 仍 `undefined`(=auto，需常態≥2 人)＋使用者存檔時頁面為開關上線前舊版 → 保持關。已 PUT 設 `trialTarget/makeupTarget='on'`（強制開，`trialTargetOpen/makeupTargetOpen=true` 即時生效）。備忘：**「開放試上」(allowTrial) 與「可作為試上/補課場次」(auto/on/off) 是兩層**——allowTrial 只允許試上、仍受 2 人門檻；要無視人數強制開放需設 on。改開關前員工端要無痕重整載新版。
- ✅ **試上/補課「可作為場次」兩獨立開關（auto達2人/on/off）**（`3.79.0-trial-makeup-target-switches`，commit 後端 `60d0f33`、前端 `c9aee23`；E2E 6/6）：承「未開課擋試上/補課」討論——收斂為**每梯次兩個獨立開關**（使用者拍板：試上、補課分開）：`trialTarget` / `makeupTarget`，值 **`auto`（預設，常態報名不重複人數達 2 人自動開放，不含試上/補課）｜`on`（強制開放）｜`off`（強制不開放，如密集班）**。共用 `isTargetOpen(mode, regularCount)`；`regularCount` 用 3.72.0 的常態報名口徑。
  - **後端**：`getCourses` 回 `trialTarget/makeupTarget` + effective `trialTargetOpen/makeupTargetOpen`；`getTrialSessions` 只列 `allowTrial && trialTargetOpen` 的梯次場次（另查常態報名數判 auto）；`enrollMakeup` 目標梯次 `makeupTargetOpen` 為 false → 擋 `MAKEUP_TARGET_CLOSED`「此梯次目前未開放作為補課場次」；PUT 白名單加兩欄。
  - **前端**：員工加開/編輯梯次表單加「可作為試上場次／可作為補課場次」下拉（自動達2人/強制開/不開放）；會員補課選單排除 `makeupTargetOpen===false` 的梯次（後端仍權威）。
  - **資料**：**密集班 3 梯 makeupTarget='off'**（不開放作補課；使用者指示「密集班不開作補課」）。
  - **E2E（6/6）**：A(auto,2人)→試上/補課皆開；B(auto,1人)→皆關；C(off,3人)→強制關；試上清單只含 A；補到 C(off)/B(1人) 皆擋 MAKEUP_TARGET_CLOSED。⚠ 測試踩雷：enrollMakeup 目標檢查在 `originalCourseDoc.exists && targetCourseDoc.exists` 內，補課券來源課程須真實存在才會觸發 gate。
- ✅ **課程試上移至「課程總覽」＋限報名日 2 週內＋階層瀏覽**（`3.78.0-trial-2week-hierarchy`，commit 後端 `1ecfb49`、前端 `c1e76bc`；後端驗證 27 場次全在窗口內）：
  - **後端**（`getTrialSessions`）：①試上場次 `to` 一律夾為 **today+14**（只開放報名日 2 週內；政策 2026-07-20）②回傳補 `categoryName`/`cohortName` 供前端建階層。
  - **會員端**（`MemberCoursesPage`）：分頁順序改 **總覽→試上→我的→月曆**；新增「試上」分頁——**階層 館別→班別(課程)→梯次→場次**（第一層館別 chip+班別卡、第二層梯次卡、第三層場次卡→點「試上」開報名 modal），modal 含 報名對象(本人/子女)+免責同意+付款(共用 PaymentSection，只轉帳)+送出（POST /experience-bookings trialSessionId）。橫幅提示「常態課程單堂體驗/另收試上費/保險自理/限 2 週內/額滿不顯示」（試上免責同意勾選文案同步統一為「常態課程單堂體驗、保險自理」，課程頁＋體驗頁 modal，commit 前端 `d21c690`/`3fe057f`；分頁改上圖下字四字標籤 📚課程總覽/🧗課程試上/📖我的課程/📅課程月曆 `22db5df`）。試上仍為 experienceBookings，狀態查詢在體驗頁「我的預約」。
  - **體驗頁**（`MemberExperiencePage`）：移除「課程試上」分頁與清單（只留 填寫預約+我的預約）；trial 相關 loadTrialSessions/openTrialSessions 保留（我的預約改期試上仍用）。
  - ⚠ 前端未瀏覽器實測（會員登入需密碼）；build 兩 target 通過、後端 API 實測（2週窗口+階層欄位）。附註：入門班 試上費 0（allowTrial 開但 trialPrice 未設）。
- ✅ **課程名稱一致性對齊（2026-07-20，純資料）**：統一格式＝**館別（前端 gymPrefix 自動）＋班別＋月份(7-8月)＋週幾＋A/B/C班**（例「【新竹館】小蜘蛛人初級班 7-8月週一A班」）。firebase-admin 改 23 門的 `name`+`cohortName`，**連動 courseSessions/courseEnrollments 的 courseName 快照**（兩者存快照、不自動跟）。規則：cohortName=月份+週幾+字母班；月份由起訖月推（`${sm}-${em}月`）；`07-08月`→`7-8月`；缺月份補、單梯補 A；矯正班週三兩梯依時段拆 **A(閎聿19:30)/B(晉瑋20:30)**、剝除 cohort 名的教練字樣（instructor 欄不動、月曆👟照顯示）。**例外決策（使用者拍板）**：①密集班**維持**「第N梯（日期）」梯次制（非週次結構）②青少年班培訓班→**班別改名「青少年初級班」**+梯次「7-8月週六A班」。腳本 `scratchpad/rename-courses.cjs`（dry-run 預設、`--commit` 寫入）。⚠ 教訓：改 course.name 要一併 cascade sessions+enrollments 的 courseName 快照。
- ✅ **比賽友館折扣（心流/爬森等，可增刪清單、人工核對）**（`3.77.0-competition-partner-gym-discount`，commit 後端 `659bca1`、前端 `bb01e83`；E2E 打正式 API **7/7**）：友館會員報名享折扣（預設 95 折），名單由友館提供、**櫃檯人工核對**。**設計決策**（使用者拍板）：**不疊加**（友館折 vs 隊員 9 折**擇優取較低價**）；**講座用工作坊開、之後再做**（本次只做比賽）；友館清單**管理員可增刪**。
  - **友館清單**（`systemSettings/partnerGyms`）：`GET/PUT /settings/partner-gyms`（GET 公開供會員報名頁讀、PUT 限管理員；每筆補 uuid）；設定頁「入場規則」群組加「🧗 友館折扣清單」分頁（superAdminOnly，增刪友館名稱）。
  - **賽事設定**：`fees.partnerGymDiscount`（率，如 0.95；空/0＝不開放）——建賽/編輯費用格加欄位。
  - **報名計費（後端權威、擇優不疊加）**：base（早鳥/兒童）後取 min(隊員9折候選, 友館折候選, 原價)；友館折需會員選清單內友館且賽事有設率。存 `partnerGym`/`partnerGymId`/`isPartnerGymDiscount`/`partnerGymPending`（待核對）。`update-form`/`reregister` 同邏輯（沿用原選友館、重報後仍待核對）。
  - **人工核對**：`POST /registrations/:regId/verify-partner-gym {approved}`（值班/管理員）——核准→清 pending（維持折後價）；駁回→移除友館折＋重算費用（隊員擇優/否則原價）。員工詳情 modal 顯示友館＋待核對狀態＋「核准友館折扣／取消友館折扣」鈕；名單列徽章「友館待核/友館」；CSV 加「友館折扣」欄（待核對標註）。
  - **會員端**：報名表備註欄後（賽事有開放且清單非空時）顯示「友館會員優惠」下拉→選友館先享折扣（付款步驟標「🧗 友館折扣」）＋說明「將由館方依友館名單核對、不在名單改回原價、與隊員折擇優不疊加」。
  - **E2E（7/7）**：清單 CRUD＋補 id／一般會員+友館→950(1000×0.95)待核對／**隊員+友館→擇優 900(9折)非友館**／核准→pending 清除費用維持／駁回→移除友館折費用改回 1000。⚠ E2E 會員 fixture 需帶 `teamMemberSince`+`teamMemberUntil` 才會被 `isActiveTeamMember` 判 true。
  - 📌 **待辦**：講座（工作坊課程）友館折扣未接——之後用工作坊開講座時，把同套折扣邏輯接到課程 enroll-all（清單已共用、只需課程加 partnerGymDiscount 欄＋報名擇優＋核對）。備註欄提示文字已依要求簡化為「備註（選填）」（commit `50b6639`）。 備註欄位置移到基本資料頁最下面（友館優惠之後，commit 前端 `f12ab84`）。
- ✅ **比賽報名表加會員備註欄**（`3.76.0-competition-member-note`，commit 後端 `32e70df`、前端 `9a6d820`；E2E 打正式 API **5/5**）：報名 doc 加 `memberNote`（選填，特殊需求/飲食/身體狀況）——`registerForCompetition`＋`update-form`（退回修改）收存；會員報名表 step1 臂展欄後加備註 textarea、退回修改表加備註欄、「我的比賽」卡顯示；員工詳情 modal 顯示「💬 會員備註」（員工備註 staffNote 之前）＋名單精簡列加「備註」徽章；名單 CSV「備註」欄改讀 `memberNote`（相容舊 `customFieldValues.notes`）。E2E：報名帶備註→registration 存值→CSV 含內容。⚠ 測試踩雷：比賽 fixture 少 `customFields:[]` 會 500「customFields is not iterable」（非本次改動、建賽必帶）。
- ✅ **實際匯款金額進課程名單＋密集班 BeClass 名單匯入**（`3.75.0-roster-paid-amount`，commit 後端 `09f4dc3`、前端 `3016468`；匯入驗證通過）：
  - **實際匯款欄**：課程列表「名單」modal 加「實際匯款」欄（讀 `enrollment.memberPaidAmount`，付款方式欄前）。管道三條：①會員 `/transfers/upload` 自填 paidAmount → 同步寫進訂單 `memberPaidAmount`（全訂單型別）②claim 認領時帶入 `claim.paidAmount`/`bankLastFive`/`paymentNote`/`healthNote` → enrollment ③外部匯入直接寫。
  - **密集班名單匯入（BeClass 15 列/13 童）**：**周詠弈**（唯一已註冊）直接入第一梯 4 堂（7/10 停課跳過、其補課 5-7月已處理 7/17 補上；paidAmount 3800）；**14 筆待認領 claim**（含 paidAmount/末五碼/paymentNote/parentEmail；劉理岸與辜宥翔各兩梯）——**leaveDates 防重複發券**：劉理岸・范語晨 第一梯標 7/10（補課已處理/已跨期安排 7/22 週三A）、辜宥翔 第二梯標 7/27（家長預告請假→認領自動補登＋發券）；施書琪 7/10 未曾安排 → 認領時正常補發停課券（效期至 8/9）。許宥昕金額欄 4000 vs 註記 3800 待退 200 → 照錄請櫃檯核對（他另有週一A claim、註冊時兩筆一起認領）。名單狀態：第一梯 周詠弈＋待認領3；第二梯 待認領6；第三梯 待認領5。
- ✅ **課程管理分頁順序調整**（純前端 commit `8edd057`）：員工課程管理頂部分頁由「課程列表→月曆→場次→班別」改**班別管理→課程列表→場次管理→月曆**（依使用者指定左至右順序；預設落點 tab 不變）。
- 📋 **建立「小蜘蛛人暑假密集班」班別＋二三梯（2026-07-20，依 BeClass rid=305264369e498fdf2913）**：**密集班設定法＝課程類型選「週課」＋上課星期勾滿週一~週五＋起訖設該週** → 產生場次即每日一堂（generate-sessions 需帶 `confirm:true`，且 super_admin 要帶 `gymId`，否則只回 preview——首跑踩雷）。建：班別 `340c1544`（youth、**maxLeaves:1**（BeClass 規則請假限1次）、補課類型掛「小蜘蛛人」可補初級/進階場次、介紹含對象中班~小六/師生比1:6）；**第二梯 7/27-31 10:00-12:00**（`faa2748e`）＋**第三梯 8/3-7 13:30-15:30**（`daa8e17a`），各 4000 元/正取6/候補2/5堂、無限練習期＝該梯當週、新竹館。第一梯 7/6-10 已結束不建。→ **後補建第一梯**（`ade9c71d`，7/6-10 13:30-15:30、5 場次；**7/10 標休館停課**對齊新竹停課日、0 報名無需發券；名單如需補登陳威宇等學員另行處理）。驗證：兩梯各 5 場次日期時段正確、ruleMaxLeaves=1 生效。⚠ BeClass 退費寫 5%-50% 分段手續費，系統退費走政府公式（開課前5%/開課後20%費率）——如需對齊 BeClass 分段可調梯次費率欄位。
- ✅ **體驗報名生日改西元、保險名冊維持民國 7 位**（`3.74.0-experience-birthday-gregorian`，commit 後端 `1beedd9`、前端 `ed25804`；名冊驗證 4 格式全對）：會員體驗報名表參加者生日由「民國文字框（920110）」改**西元 date picker**（存 ISO `YYYY-MM-DD`）；後端 `parseRocBirthday`/`toRoc7` 改**相容四種輸入**（西元 ISO／西元 8 位／民國 6 位／民國 7 位）→ **保險名冊 Excel 固定輸出民國 7 位**（如 2003-01-10→`0920110`）、成人/未成年 15 歲分頁判齡同步相容；舊預約的民國資料不受影響。員工「編輯資訊」參加者生日維持文字框、標籤改「西元或民國皆可」（舊資料民國數字無法塞 date input）；體驗報表 CSV header「生日（民國）」→「生日」（值原樣輸出）。報名年齡檢查（未滿5歲）前後端本就相容 ISO、不用改。
- ✅ **員工課程月曆加課程篩選（依班別）**（純前端 commit `e273a85`→`bbf6a87`）：月份切換列下加下拉「全部課程／各課程（班別）」——**依 categoryName 篩選（使用者指正：依課程不依梯次）**，選定後日格 pill 與點日場次詳情顯示該班別**全部梯次**場次（courseId→categoryName 對照走 courses state、查無歸「其他」）。切月份保留篩選。附帶查證：會員端課程總覽梯次排序**本就正確**（7/9 `e4a24be`，正式資料模擬輸出 週一→週日+時段無誤；全課程 weekdays 欄位無缺漏），「學員端也要」經確認無需改動。
- ✅ **員工課程列表梯次排序改 週幾→時段**（純前端 commit `9a53dcd`）：第二層梯次列由原分組順序改**週一→週日（週日排最後）、同日再依開始時間**——與會員端課程總覽既有排序（`e4a24be` 的 wkKey 邏輯）一致；無 weekdays 的課排最後。
- ✅ **課程列表「名單」modal 同步只列常態學員**（`3.73.0-course-roster-regular-only`，commit `a8cafaa`；正式驗證）：回報「林依岑已改週五B、名單請修正」——她的報名/報表/場次/App 其實全已正確，唯一殘留＝課程列表「名單」modal 的來源 `GET /courses/:id/enrollments` **回全部報名（含 cancelled 與補課/試上）**，前端 byMember 去重把她 8 筆 cancelled 週六A 紀錄又列了出來。修：端點過濾 **confirmed/leave＋排除 isMakeup/isTrial**（與 3.72.0 課程列表人數同口徑；轉班者不再殘留原班名單；補課/試上到場次名單看）。驗證：週六A 名單 4 人無林依岑、週五B＝孫筠棋＋林依岑（**孫筠棋 7/20 已完成註冊認領**）。附帶：加開場次「帶入學員」勾選清單同來源、自帶 confirmed/leave 過濾，行為不變。
- ✅ **課程層人數改只算「常態學員」（排除補課/試上）**（`3.72.0-course-count-regular-only`，commit `732fee3`；正式資料驗證 週二B 5/6→**3/6**）：回報課程列表人數（如週二B 5/6）混入了補課/試上的單堂學員、看不出常態上課人數。改**兩處口徑一致**：①`getCourses` 不重複會員計數 skip `isMakeup/isTrial` → 員工課程列表 N/上限、會員端「剩 N 位/額滿」都只反映常態報名（含插班；＋reservedSlots）②**enroll-all 名額判定同步排除**——補課/試上是單堂佔位，不佔整期名額（否則補課生多會把新整期報名誤推候補）。**場次層**（月曆/場次列表的剩N、佔位）維持含補課/試上（單堂實際佔位，昨日 sessionRemain 口徑），兩層語意：課程層＝整期名額、場次層＝當堂座位。
- ✅ **員工場次顯示剩餘名額（含請假/補課計算）**（純前端 commit `6c297e6`；正式資料驗算通過）：需求「快速看出每場次尚有名額（含原報名/請假/補課）」——資料本就齊（`getSessions` 回 registeredCount/leaveCount/makeupCount/trialCount/expectedCount），公式＝**剩餘＝maxStudents − expectedCount**（expectedCount＝原報名−請假＋補課＋試上＝實際佔位；候補不佔位）。`CoursesPage` 加模組層 `sessionRemain(s)` 套三處：①**月曆日格 pill** 尾端「·剩N」（滿＝「·滿」）②**月曆點日場次卡** Tag「剩 N」（琥珀）/「額滿」（紅）③**場次管理列表**每列綠/紅徽章「剩 N／額滿」。驗算例：週二B 原3＋補2＝佔5→剩1、週五A 原2−假2＋補1＝佔1→剩5。
- ✅ **公告支援圖片（無圖維持純文字）**（`3.71.0-announcement-image`，commit 後端 `50825fb`、前端 `2b0fc79`；E2E 打正式 API 全綠）：公告資料模型早有 `bannerImage` 欄位（POST/PUT 本就收）但從未接上傳與顯示 → 補齊三段：
  - **後端**：`POST /gyms/:id/announcements/:aid/image`（multer 10MB → Storage `announcements/` → getSignedUrl 2035 → 寫 bannerImage）；權限同公告編輯（`requireManagerOrStation`＋`announceGymGuard`；**休館/特殊時間公告限管理員**——handler 讀既有公告 type 判斷，比照 DELETE）。
  - **員工端**（`GymsPage` 公告表單）：「公告圖片（建議 **1200×400 橫幅**）」上傳＋預覽＋移除（移除＝`bannerImage:''` 走 PUT）；檔案於**儲存公告後上傳**（新增取 create 回傳 id；上傳失敗不阻斷公告本體）。
  - **會員端**（`MemberHomePage`）：輪播卡有圖 → **圖片鋪底（cover）＋左深右淺漸層疊字**（文字/指示器 zIndex 提上）；最新公告列表標題下顯示滿寬縮圖（maxHeight 120 cover）。**無圖＝原紅色漸層/純文字，行為不變**。
  - **E2E**：建公告→上傳 1px PNG→`bannerImage` 簽名 URL 200 可抓→會員端 `/gyms/announcements/all` 公告與 banner 清單皆帶圖→刪除清理。Storage 簽名 URL 於 Railway 正常（同課程海報）。
- 📋 **Render 冷備部署失敗信判讀 SOP（2026-07-20 兩封失敗信查證）**：收到「deploy error for redrock-api-backup」→ **先比對兩邊 `/health` version，別急著處理**——①同版本＝忽略（實例：7/14 舊 commit 的失敗信＝PEM 壞掉那段的舊事件延遲寄達；7/19 3.62.0 失敗信＝**單日連推十幾版時免費層偶發單次 build 失敗/被後續部署擠掉**，後面的 push 成功即直接帶到最新版，兩案實測 Render 皆已同步 3.70.0）②Render 落後且後續 push 沒追上＝才去 Render dashboard 看 log（多半是 Railway 環境變數改了沒手動同步）。**單封失敗信 ≠ 備援壞了；連續失敗＋版本落後才要處理**。失敗通知信維持開啟（金鑰失同步這類真故障靠它早發現）。Render 免費層休眠喚醒 ~50s 屬正常。
- ✅ **發票明細 Excel 移除三個卡號欄**（`3.70.0-invoice-export-drop-card-cols`，commit `8c394bd`；下載實測 7 欄）：問「集點卡最前號是什麼」——查明＝仿紙本「營業人使用二聯式收銀機統一發票明細表」保留的欄位：**集點卡最前號＝程式寫死空字串、恆空白**（無輸入無資料，純版面佔位）；優惠卡/全票最前號＝結帳頁手動輸入。使用者拍板三欄都從 Excel 拿掉 → `invoice-export` 表頭/空日列/資料列/欄寬全改 7 欄（開立日期/星期/交易客次/發票起迄號/總金額/作廢號碼）。註：結帳頁的優惠卡/全票最前號**輸入框保留**（仍存進結帳 doc、只是不再匯出；要一併移除再說）。
- ✅ **小蜘蛛人補課期限 30 天對齊（規則顯示＋既有券校正）**（前端 commit `3ccee5b`＋資料操作）：回報「補課期限 30 天為何規則寫 2 個月」——查明＝**班別設定 2026-07-19 22:31 才由使用者改成 30 天**（之前 60），先前看到 2 個月是當時設定的正確顯示、改完即時生效（規則文字動態讀 resolveRules）。收尾兩件：①規則顯示由「30 倍數換算 N 個月」改**一律顯示天數**（30 天≠1 個月、曆月有歧義）②掃描小蜘蛛人 26 張補課券——**9 張（多為進階班）效期仍按舊 60 天算 → 校正為結束後 30 天**（expiryNote 留稽核）。⚠ 給家長的請假補課文案「課程結束後 60 天內」該句請改「30 天內」（小蜘蛛人班別設定值；文案發送前修正）。
- ✅ **課程請假/銷假/補課異動通知管理員**（`3.69.0-course-leave-makeup-notify`，commit 後端 `b807767`、前端 `a7639a3`；E2E 打正式 API **4/4**）：問答查證——請假/銷假/補課預約/取消補課**原本全無管理員通知**（只有代班有）→ 過渡期（請假已系統化、**補課 7/27 起才開放系統自助、之前走舊表單**）櫃檯不知道哪堂釋出名額可安排補課。補 `notifyCourseManagers`（同館 gym_manager＋super_admin，try/catch 不阻斷）掛四處：**請假**（course_leave，「釋出 1 個名額（可安排補課）」；超限請假標註不產生資格）／**銷假**（course_leave_cancel，名額收回）／**補課預約**（course_makeup_booked，佔 1 名額）／**取消補課**（course_makeup_cancel，釋出名額）。前端待辦通知面板加「**課程**」分類 chip＋四型別歸類、查看導向課程頁。E2E：fixture 會員請假 → 3 位 super_admin 皆收到含「釋出 1 個名額」通知。
  - 📋 **過渡期補課安排備忘**：7/27（一）前補課由家長填舊表單、櫃檯手動安排（手動加名單後記得跑 enrolledCount 同步或用「新增場次帶入」）；7/27 起會員系統自助預約。已產出兩份家長文案（請假補課辦法＋家長主帳號註冊簡易版）於對話交付。
- ✅ **「個別使用優惠券」拆成「成人使用優惠券／學生使用優惠券」**（`3.83.0-coupon-entry-split-adult-student`，commit 後端 `dc29c27`、前端同 commit；7/20 驗證）：日結帳＋月銷售的入場優惠券分類，依**基礎入場類型**拆——`entryCategory` 的 coupon 分支：`student_free`→**學生使用優惠券**、其餘（single_ticket 舊折扣卡8折／discount_card 優惠折扣券入場）→**成人使用優惠券**。改三處：後端 `entryCategory`＋`ENTRY_ORDER`（日結帳 `GET /today` 與月銷售 `monthly-export` 共用），前端 `DailySettlementPage.ENTRY_CATS`（手動輸入固定分類）。**驗證 7/20**：原「個別使用優惠券 440」→ 成人使用優惠券 240（張宇弘 8折）＋學生使用優惠券 200（Spencer 8折）。⚠ 已結帳的舊日 `income.entryItems` 快照仍存舊 label「個別使用優惠券」（日結帳歷史檢視 fallback 顯示於 extra），但**月銷售 Excel 逐日重算 checkIns、所有日期都顯示新拆分**。（營收報表 RevenuePage 入場為單一欄、無此六分類、不受影響。）
- 📋 **抱石墊/岩盔租借查證（2026-07-20，無異動；訂正）**：**入場加購**只有岩鞋/粉袋（checkIn 僅 shoesPrice/chalkPrice 欄）→ 日結帳/月銷售「岩鞋(租借費)」列**只含岩鞋+粉袋**。**器材租借 `/rentals`（多日+押金）本就內建三品項**（`rentals.js` `defaultSettings`：**抱石墊 crashPad 週末400/七日800/押1000、岩盔 helmet 100/200/500、攀岩吊帶 harness 100/200/500**；`systemSettings/rentalItems` 未存時走此預設，故直接可租）→ 抱石墊/岩盔租出去**會列入營收報表「租借」欄**（rental* 交易），但**不進日結帳「岩鞋」列**（兩條不同流程）。**費率設定位置**：員工端器材租借頁 → 右上「⚙ 費率設定」（限管理員，`RentalsPage` settingsModal）→ 每品項可調週末/七日租金、押金、說明、開放與否 → PUT `/rentals/settings` 存 Firestore。⚠ 先前誤記「rentalItems 空＝未設品項」為查詢 key 看錯（結構是扁平 crashPad/helmet/harness、非 items/types 陣列），實際預設就有三品項。
- ✅ **修：月銷售表入場費把租借灌進去（成人/學生/購券虛高）**（`3.82.0-monthly-export-entryfee-minus-rental`，commit `2499748`；7 月新竹重下驗證）：回報 7/20 成人 400、學生 350（應 300/250）。根因＝**QR/直接入場（`confirmCheckIn`）建的 checkIn 文件沒存 `entryFee`**（只有交易記錄有；電話入場 `/checkin/phone` 有存），而月銷售表 `monthly-export` 用 `entryFee ?? amountPaid` → entryFee 缺就退回 `amountPaid`（**含岩鞋+粉袋**）→ 入場費虛高、租借重複計。**即時結帳(GET /today)本就正確**（`amountPaid−租借`），只有月銷售匯出這行沒扣。修：①`monthly-export` 改 `fee = entryFee ?? max(0, amountPaid−shoesPrice−chalkPrice)`（涵蓋所有歷史資料、所有入場類型）②`confirmCheckIn` checkIn 文件補存 `entryFee`（未來乾淨）。**驗證 7/20**：成人 400→300、學生 350→250、**購買優惠折扣券 700→600**（涂盛淮買券600+租岩鞋100）、岩鞋租借 500（5人×100）全部對帳。此類「租借灌入場費」bug 對所有入場類型（成人/學生/兒童/購券/購定期票）一併消除。
- ✅ **子會員（家長代子女）全流程 UI 稽核（2026-07-20，subagent 掃 6 個會員頁面）**：確認 12 流程對子女帳號正確——**11 完整、0 bug**。載入子女一律走 `/members/my/children`，動作帶子女 id（`childMemberId`/`forMemberId`/`group.memberId`/券擁有者 `_ownerId`/`registrationId` 天然歸屬）。逐項：報名課程(enrollForMemberId)●／請假(forMemberId)●／取消請假(三路徑都對)●／補課(c235b75)●／取消補課(group.memberId)●／退費暫停(group.memberId+凍結key)●／報名比賽(對象+資料/緊急聯絡人帶入)●／比賽取消退費重繳(registrationId)●／課程試上+體驗試上(childMemberId)●／票券(載入子女+👦標、唯讀設計移轉/申請綁本人)●／入場QR(可選子女入場、子女不可買卡票為業務限制)●／我的紀錄(檢視對象下拉五分項)●。**唯一註記非缺口**：體驗「填寫預約單」(`MemberExperiencePage.submitBooking`)寫死 `memberId:member.id`＋聯絡人取家長——但那是**「家長聯絡人預約團體體驗、participants 列參加者姓名」模型**（小孩列為參加者姓名、非綁子女帳號；綁子女帳號的是試上、已支援），設計本然、非 bug。**未發現其他寫死 member.id 應用子女 id 的殘留**。
- ✅ **修：子會員補課 UI 斷點（家長看不到/用不了子女補課券）**（純前端 commit `c235b75`）：查證——會員端補課流程**只支援本人**：`loadMakeupRights` 只查 `/makeup/member/{本人id}`、`handleMakeup` 寫死 `memberId:member.id` → 家長幫子女請假（產生子女補課券）後**卡死在補課這步**。實測當下 **32 張可用補課券中 19 張屬子會員**（小蜘蛛人小朋友）全被卡住。修（三處，後端本就吃參數 memberId 可代子女、無需改）：①`loadMakeupRights` 載入**本人＋子女**全部券（比照 loadMyEnrollments 的 /members/my/children），每張標 `_ownerId/_ownerName/_isSelf` ②「📋 補課資格」列表子女券顯示 **👦 子女名** ③`handleMakeup` 改用 `selectedMakeup._ownerId`（券擁有者）而非家長 ④順修取消補課後刷新用單一 member 覆蓋整份清單 → 改 `loadMakeupRights()`。取消補課本就帶 `group.memberId`（子女群組即子女）已支援。請假/我的課程早已支援子女，唯獨補課漏接、現補齊。
- ⚠️ **DDoS 防護：Cloudflare 前置完成，但 EDGE_ENFORCE 過早開啟致營業中斷（2026-07-20，已回退）**：網域 `redrocktaiwan.com` nameserver 已從 Porkbun 換到 **Cloudflare 免費版**（`graham.ns.cloudflare.com` / `journey.ns.cloudflare.com`），**營業中無縫切換**。
  - **🔴 事故＋回退（同日）**：DNS 搬 Cloudflare 當天就開 `EDGE_ENFORCE` → **櫃檯裝置 DNS 快取仍指舊「直連 Railway」位址、走直連被 403 擋** → 今日入場/隊員等資料大面積空白。**回退＝Railway `EDGE_ENFORCE=false`**（直連恢復為正常 401/200，服務即恢復；Cloudflare 橘雲主防護未動、DDoS 緩解仍在）。診斷確認 Transform Rule 注入穩定（兩邊緣 8/8 seen=true，先前 403 是 Rule 剛部署的短暫傳播延遲），根因純粹是**客戶端 DNS 尚未過期到 Cloudflare**。
  - **📌 EDGE_ENFORCE 重開條件（教訓）**：**DNS 遷移後至少等 1-2 天（客戶端快取全過期、所有裝置走 Cloudflare）** 再開；重開前先確認「直打 Railway 原始網址已無正常流量」；挑離峰時段；開後立即實測櫃檯。**切勿在 DNS 搬移同日開啟**。
  - **DNS 記錄（Cloudflare 代管）**：api→CNAME `fox82bz0.up.railway.app`｜app→`redrock-member.web.app`｜staff→`redrock-staff.web.app`｜comp→`redrock-comp.web.app`；MX fwd1/fwd2.porkbun+send(amazonses)、TXT(SPF/DKIM/DMARC/acme) 全數保留。⚠ Cloudflare 掃描**漏了 staff/comp**、且預設把 app 設橘雲——已手動補 staff/comp（灰雲）+ app 改灰雲。根網域 ALIAS(uixie.porkbun 轉址)換 CF 後失效、根網域未使用故不管。
  - **雲朵策略**：**只有 api 要橘雲(Proxied，DDoS 目標)**；app/staff/comp/根 A 全灰雲(DNS only，Firebase 自有 CDN/憑證、勿 Proxy)。SSL/TLS 模式設 **Full**。
  - **營業中安全切法（已用）**：換 NS 前先把 **api 也暫設灰雲** → 切 NS 後全灰雲＝Cloudflare 只當 DNS、api 直連 Railway 與原本一致、櫃檯零影響（驗證 api 仍 `server: railway-hikari`、四站 200、MX 在）。
  - **✅ 已完成閉環**：① api 翻橘雲(Proxied)→ DDoS 防護啟動（`server: cloudflare`、`cf-ray`）② Cloudflare Rules→Transform Rules 建 **`inject-edge-auth`**（`http.host eq "api.redrocktaiwan.com"` → Set static `X-Edge-Auth: <secret>`）③ Railway 設 `EDGE_SECRET=<secret>`+`EDGE_ENFORCE='true'`（3.80.0 中介層生效）④ 驗證：經 CF 全端點 200/401 正常、**直打 Railway 原始網址一般端點 403**（`/health` 刻意豁免供 UptimeRobot）。`/health` 加 `edge{seen,match,enforce}` 布林診斷（不外洩密鑰，3.81.0-edge-verify）。
  - **🔑 密鑰位置（不進版控）**：`EDGE_SECRET` 存於 **Railway 環境變數** + **Cloudflare Transform Rule `inject-edge-auth`**（兩邊須一致）。輪替＝兩邊同步換新值。**✅ Render 冷備已同步 `EDGE_SECRET`（2026-07-20）＋刻意保持 `EDGE_ENFORCE` 關閉**——故障轉移策略：Render 是冷備、`EDGE_ENFORCE` 不設（接受所有流量）→ 切 Render 時（Cloudflare 改 api CNAME 指 Render、仍走橘雲＋Transform Rule 注入 header）Render 一律放行、**永遠不會被自己的邊緣強制擋住**，最穩。`EDGE_SECRET` 已備妥供未來若要 Render 也強制。動 Railway/Cloudflare 密鑰時一併同步 Render。
  - **故障轉移更新**：DNS 現在 Cloudflare 管——切 Render 冷備＝在 **Cloudflare DNS** 改 api CNAME 指 Render（橘雲保留、Transform Rule 照套），非 Porkbun；playbook `docs/outage-playbook.md` 待同步（含上述 Render EDGE_SECRET 注意）。
  - **DDoS 防護總結（三層全上線）**：①應用層全域限流(3.68.0) ②**Cloudflare 邊緣 L3/4/7 緩解＋WAF＋Under Attack Mode**(api 橘雲) ③只認 CF 流量(EDGE_ENFORCE，堵繞過)。被攻擊時：Cloudflare → 該網域 → Security → 開 **Under Attack Mode**（訪客先過 JS 挑戰）。
- ✅ **DDoS 防護：邊緣防護中介層（預設關、零影響先上線）**（`3.80.0-edge-enforce-flag`，commit `f082aaf`）：為 Cloudflare 前置做準備——後端加「只認 Cloudflare 流量」中介層，**環境變數 `EDGE_ENFORCE='true'`＋`EDGE_SECRET` 才啟用，未設＝完全 no-op**（對現有營運零影響，先上線待命）。啟用後未帶 `X-Edge-Auth`(可改 `EDGE_HEADER`) header＝正確 secret 的請求一律 **403 DIRECT_ACCESS_FORBIDDEN**（堵繞過 Cloudflare 直打 Railway 原始網址）；`/health` 永遠放行（UptimeRobot 直打健檢）。⚠ **上線順序**：先 API 進 Cloudflare＋Transform Rule 注入 header→實測 header 有到→**才**在 Railway 設 `EDGE_ENFORCE='true'`（順序反了會擋掉全部正常流量、櫃檯全斷）。實測部署後服務正常（開關關閉、健檢/登入端點皆非 403）。
  - 📋 **DDoS 防護總進度**：①全域限流（3.68.0，已上線）②邊緣防護中介層（3.80.0，已上線待命、開關關）③**Cloudflare 免費版前置（待做，需使用者帳號操作）**——註冊 Cloudflare→加網域→Porkbun nameserver 改指 CF→DNS 記錄搬移（api 開 Proxy 橘雲）→Transform Rule 注入 `X-Edge-Auth` secret→實測→設 Railway `EDGE_ENFORCE=true`→WAF/Under Attack Mode。使用者指示「營業中先從不影響櫃檯的部分做」＝已完成②（程式先備好）。
- ✅ **DDoS 防護第一步：全域限流＋公開端點收緊**（`3.68.0-global-rate-limit`，commit `6cda96b`；正式環境實測通過）：承 DDoS 防護討論（完整建議＝**Cloudflare 免費版擋在 API 前**為根本解、全域限流為第一步）。
  - **全域限流 1200 次/分/IP**（`src/index.js` globalLimiter）：擋單一來源濫打/灌 Firestore 讀取費。**額度計算關鍵**：館內 WiFi 全部會員手機＋站台共用同一對外 IP、會員 QR 頁每 3 秒輪詢（50 人同時產 QR ≈ 1000 req/min）→ 1200 讓正常尖峰不誤傷。
  - **自助註冊 30 次/時/IP**（防大量開帳號＋濫發驗證信；現場幫多組家庭註冊仍夠用）＋**重寄驗證信 20 次/時/IP**。既有登入 30/15min、忘記密碼 5/hr 不變。
  - **實測**：`/health` 回 `RateLimit-*` headers（1200;w=60）；空 payload 連打註冊 → 額度耗盡後 **429 TOO_MANY_REQUESTS**。⚠ 觀察：**部署切換期新舊實例並存、各自 in-memory 計數**（測試時兩計數器輪流遞減）→ 限流額度短暫 ×2；穩態單 instance 即符設定。
  - 📌 **待辦（防 DDoS 根本解）**：DNS 搬 Cloudflare 免費版、api 開 Proxy（L3/4/7 緩解＋WAF＋Under Attack Mode、攻擊流量不燒 Railway 用量）；完成後後端加「只認 CF 秘密 header」擋直打 Railway 原始網址。需使用者於 Cloudflare/Porkbun 帳號操作。
- ✅ **修：士林課程場次/月曆點入顯示「尚無學員報名」**（`3.67.0-roster-view-permission`，commit 後端 `70becaf`、前端 `804254e`）：回報士林查場次或月曆點入都無學員。**資料完全正常**（技巧班每場 7 位、roster API admin 實測回傳正確）；根因＝**權限**——名單端點 `GET /courses/sessions/:id/roster` 掛 `courses.manage`（part_time ✗、且不在值班 COUNTER_PERMS）→ **兼職個人/兼職值班一律 403**，而前端 `loadRoster` 的 `catch(e){}` **默默吞掉錯誤** → 每場都顯示「尚無學員報名」（新竹由 super_admin 檢視故沒事，士林是兼職在看才中）。修：①名單唯讀 → gate 降為 **`courses.view`**（全角色＋值班皆可看，與課程月曆檢視一致；編輯/點名等仍 manage）②前端 loadRoster 不再吞錯——403 顯示紅字「無權限檢視名單」、其他顯示失敗原因（兩處空狀態：月曆名單 modal＋場次詳情）。
  - 🧹 **附帶資料修復**：①刪士林 E2E 殘留課程「【E2E】加開」（加開場次 E2E 漏清）②全庫掃描**同步 34 個場次的 `enrolledCount/waitlistCount` 為實數**（confirmed+waitlist live 計數）——先前手動加名單批次有漏加/多加（如矯正班 1→4、成人入門 1→2），儲存計數影響名額判定（月曆顯示本就 live 重算不受影響）。
  - 💡 **教訓**：①唯讀查詢端點權限別直接沿用管理權限（part/值班會被誤擋）②前端 `catch(e){}` 吞錯 + 空狀態文案＝把權限問題偽裝成「沒資料」，排查先打 API 分離資料/權限/顯示三層 ③手動維護名單後跑一次 enrolledCount 同步。
- ✅ **onboarding gate 加「不入場攀爬，暫不安排」跳過鈕（家長帳號免卡排測）**（`3.66.0-falltest-schedule-skip`，commit 後端 `ceed8c3`、前端 `e7d5c66`＋`434778d`；E2E 打正式 API **5/5**）：問答查證——gate 在「兩份文件簽完、未排測」時**每次進首頁都卡在排測畫面且無跳過鍵**；送出排測後即放行（但站台待辦掛一筆永遠 pending、被退回又會卡回來）。對「只替子女管帳號、本人不爬」的家長不理想 → 排測畫面（階段二）場館清單下加「**我不入場攀爬，暫不安排**」鈕：`POST /fall-test-bookings/skip-schedule`（authenticateMember）設 `member.fallTestScheduleSkipped=true`、**不建站台待辦**；`/auth/member/me` 回傳旗標、gate 放行判斷加 `skipped || member.fallTestScheduleSkipped`（排在 booking/testPassed 之後）並同步進本地 member 快取。**入場後端墜測關卡完全不動**（跳過者要入場仍會被擋）；之後想爬隨時從「墜落測驗」頁安排（建立 booking 本就放行）。附註：gate 只包首頁，課程/票券/個人頁本就不經過它。
- 📋 **家長誤用小孩名義註冊——兩家修正（2026-07-19 資料操作）**：
  - **陳佳汝家**（0988222161）：家長回報收不到驗證信——查出①email 打成 `gamil.com`（已更正 gmail 並請其自助重寄）②主帳號用了小孩名「陳若僖」→ 比照曾郁淇模式：主帳號改回**陳佳汝**（生日取 Climbio 1986-06-04、清自我指涉家長欄位）＋ **Climbio 墜測認領成功**（效期至 2026-09-29 免重測）＋ 另建子會員**陳若僖**（生日 2020-06-02 搬過去；7/25 週六A 跨期補課不受影響）。同電話 Climbio 另有**陳牧澤**（2015 年生、墜測效期 2027-02-01）未認領——若之後建子帳號需手動帶入（子帳號不自動認領）。
  - **曾煥錩**（曾郁淇家長，0958650506）：①墜測查證＝**未通過需現場測**——member 旗標殘留 `fallTestPassed=true`（當時把誤認領的墜測搬給曾郁淇、旗標漏清）已清除；同意書已簽、waiver 完成 ②回報「還是顯示未成年」＝殘值：生日本來就是大人的（1977-02-04），`isMinor:true`/自我指涉家長欄位/性別 female（小孩的）皆為小孩名義註冊殘留 → isMinor 改 false、清家長欄位、性別依「父女」宣告改 male、female 補到曾郁淇子帳號。
  - **曾煥錩後續（同日）**：③站台誤把他登記墜測通過 → **已取消**（刪 passed 紀錄、排測申請退回 pending、清旗標）④使用者指示改設「**不入場攀爬，暫不安排**」→ pending 排測改 cancelled（站台待辦清掉）＋`fallTestScheduleSkipped=true`（3.66.0 跳過旗標，櫃檯代設）。最終狀態＝兩份文件已簽、墜測未通過、App 不再被 gate 卡；想爬再從墜落測驗頁安排。
  - ✅ **員工端會員詳情顯示跳過狀態**（純前端 commit `528b4fc`）：`GET /members/:id` 本就透傳 `fallTestScheduleSkipped`（sanitize 只剔敏感欄）→ `MembersPage` 詳情「墜落測驗」列在未通過時加灰標籤「**🚫 暫不安排（不入場攀爬）**」（hover 註明僅影響 App 顯示、入場仍擋）；已通過者不顯示。API 實測曾煥錩詳情回傳旗標 true。
  - 💡 **「小孩名義註冊」修正 SOP**：主帳號改回家長本名＋家長生日（Climbio 可查）→ 清 isMinor/parent*/gender 殘值 → 手動跑 claimLegacyFallTest 認領家長墜測 → createMember（isChildAccount+parentMemberId）建子會員搬小孩生日/性別 → 檢查 waiver/報名/墜測歸屬。
- ✅ **續報/舊生優惠＋續報截止日（小蜘蛛人定價規則）**（`3.63.0`→`3.65.0-renewal-fullterm-alumni-tiers`，commit 後端 `d13ca81`＋`f22693f`＋`e6f84a6`、前端 `24e7701`＋`8ed9a85`；E2E 打正式 API 13/13＋**12/12**）：梯次加三欄——`fullTermRenewalDiscount`（**續報優惠**）/`alumniDiscount`（**舊生優惠**，皆 NT$ 定額折抵）/`renewalDeadline`（**續報截止日，兩種優惠共用**、含當日、空＝不限）。
  - **資格定義（使用者拍板，小蜘蛛人規則）**：**續報**＝「前一期**整期**」報名（插班不算）——整期判定＝該梯報名堂數（含 cancelled，插班生必不足）≥ 該梯 `totalSessions`；「前一期」＝該梯結束日在目標梯開課前 **60 天內**（涵蓋進行中當期）。**舊生**＝同班別（categoryId）曾有效報名（confirmed/leave、排除試上/補課），含插班生與更早期別整期學員。續報優先、不疊加；折後再套隊員9折；enrollment 主筆存 `renewalDiscount`/`renewalDiscountType`（full_term_renewal|alumni）稽核。報名開放日 gate 的舊生判定與此共用同一查詢。
  - **前端**：員工加開/編輯梯次表單三欄（續報優惠 hint 前一期整期插班不算／舊生優惠 hint 曾報名或插班）；會員課程詳情琥珀橫幅「🎁 續報優惠：前一期整期學員（續報）折 NT$X、舊生（曾報名/插班）折 NT$Y（截止日止，系統自動折抵）」。
  - **E2E（12/12）**：小蜘蛛人情境 4400/8堂——前一期整期(8/8堂)→**3960**(折440/full_term_renewal)／前一期插班(3/8堂)→**4200**(折200/alumni)／早期整期(結束>60天前)→**4200**(alumni)／純新生→4400；另 13/13（3.64 版）驗截止日過期不折。fixtures 全清。
  - 📋 **小蜘蛛人定價備忘（9-10月開梯時填欄位用）**：新生 550/堂（8堂 4400、9堂 4950）；續報 9 折＝495/堂 → 8堂折 **440**、9堂折 **495**；舊生 每4堂−100 → 8堂折 **200**、9堂折 **200**（floor(9/4)=2）。
- ✅ **課程報名開放日＋舊生續報窗**（`3.62.0-enroll-open-alumni-window`，commit 後端 `42cf6c7`、前端 `963c91b`；E2E **3/3**）：梯次加兩欄——`alumniOpenDate`（舊生續報開始日）/`enrollOpenDate`（公開報名開始日），皆空＝隨時開放（原行為）。**後端權威 gate**（enroll-all、員工代報不受限）：公開日前僅「**舊生**」可報——舊生＝**同班別（categoryId）任一梯次曾有效報名**（confirmed/leave、排除試上/補課），涵蓋「當期在籍」與「上一期學員」兩類；舊生日前全擋（訊息帶兩日期）。⚠ 上一期若未在系統（未移轉）自動判定不到 → 櫃檯代報（staff 不受 gate）。員工端加開/編輯梯次表單加兩個日期欄；會員課程詳情於公開日前顯示琥珀公告（舊生續報期間/開放日期）。E2E：新人擋 ENROLL_NOT_OPEN、上期學員（已結束課程報名）通過、舊生窗未開全擋。
- 📋 **士林小蜘蛛人名單（2026-07-18）**：**姜荷、施友芙、施予棠、葉菲芸** 4 位皆未註冊 → 建待認領（士林「小蜘蛛人初級班 7-8月週日班」；註冊＋建子會員填本名即自動入名單＋墜測通過）。已產出**士林版家長 LINE 文案**（補課段改「洽櫃檯安排」——士林僅一梯、系統擋補回原課程故無場次可補；要開放跨館補或加開場次再調規則）。
- ✅ **新竹小蜘蛛人 BeClass 報名匯入（30 位）＋認領開放子帳號**（`3.35.0-claim-child-accounts`，commit `cc30d72`；資料腳本 scratchpad `import-spider-roster.cjs`）：來源 `~/Downloads/新竹紅石7-8月小蜘蛛人報名.xlsx`（30 童、9 梯次）。
  - **程式**：`claimPendingCourseEnrollment` 移除「跳過子帳號」——兒童課程學員即子會員、認領以上課者姓名比對（墜測/隊員/90日票認領仍跳過子帳號防共用電話冒領）。
  - **已註冊 10 位直接入名單**（林依岑/張羽希/張羽喬/許宸碩/廖彥澄/王登第/洪紹文/洪紹祖/陳威宇/蔡和雅；各梯全期 confirmed 費用0；墜測 4 位本就通過、6 位依政策預設通過）。
  - **未註冊 20 位建待認領**（claim 帶家長電話/LINE 供核對）→ 家長註冊＋建子會員（**姓名＝小孩本名**）即自動入名單＋墜測預設通過。
  - **reservedSlots 全歸零 8 梯**（週一A3/週二B2/週三A1/週三B進階4/週五B1/週六A2/週六B進階2/週日A6，備註「BeClass 報名已匯入」）——原保留名額即為這批報名而設，匯入後以真實名單＋待認領取代。名額檢核：各梯 已入+待認領 ≤ 上限 6（週日A/週一A 剛好滿）。
  - 📣 **已產出「小蜘蛛人家長註冊通知」LINE 文案**（對話中交付）：家長註冊 6 步（本人簽兩份文件→建子會員**填小孩本名**→代簽兩份）＋小朋友有自己手機可**獨立註冊**（未滿18填家長資料、本人簽完→email 給家長遠端完成法定代理人簽署）＋請假（前2小時/上限2次）/補課（初級進階互補限新竹/結束後60天/取消補課一天前）/續課（App 課程總覽報名）＋叮嚀**簽名用正楷**＋家長不在時櫃檯電話搜尋協助入場。規則數字皆對過系統設定。
- ✅ **體驗預約加 教練費＋發票金額 欄位**（`3.34.0-experience-finance-fields`，commit 後端 `8a0098a`、前端 `38800d5`＋`fd7d2f5`）：預約管理已確認預約卡（試上除外）加琥珀區塊——**教練費**依人數表預填（1人400/2人420/3人660/4人720/5人780/6人840/7人900/8人960/**9~12人1300**；教練1人表）、**發票金額**預填＝總金額−人數×175（保險不開發票）。**權限**：管理員可改可存（`PUT /experience-bookings/:id/finance`，requireManager、驗非負數、記操作人）；**櫃檯（值班/站台）唯讀可見**（未存過標「（預設）」＝系統預填非管理員確認值）。
- ✅ **補課群組 UI 收尾（朱智萩截圖回報）**（純前端 commit `5c11756`）：3.30.0 漏兩處——①補課群組統計行「已請假 N 堂・可請假剩餘 N 次」隱藏（補課無請假額度概念、誤導）②收合狀態「申請請假（下一堂）」→ 補課改「取消補課（下一堂）」（上課一天前才顯示；當天起無按鈕）。**設計確認（使用者 OK）**：未來日期的補課，首頁**身份方框（入場效期）只在補課「當天」顯示**（當天~當天、隔天消失）；補課前的提醒由首頁「課程活動提醒」承擔（近一週場次、綠色「安排補課」標籤）——行程提醒與入場資格分工。**附帶查證**：朱智萩首頁「錯誤效期推播」＝她 19:57 報名今晚 7/17 加開場補課、當時 3.30.0（dayOnly）尚未部署 → 短暫顯示舊課整段免費期；部署後自動修正為 7/17~7/17、隔日消失，非資料錯誤。
- ✅ **今日課程學員名單加 補課/試上/試上費未收 標籤**（`3.32.0-course-students-tags`，commit 後端 `cd0335a`、前端 `8c1ae92`）：查證確認**補課與試上（正取）都會出現在「今日課程學員」快速入場名單**（查詢＝今日場次的 confirmed 報名，無排除；候補/請假不出現）。原名單分不出身分 → `today-course-students` 回傳補 `isMakeup`/`isTrial`/`trialUnpaid`（試上且 `paymentStatus!=='paid'`）三旗標；`CheckinPage` 名單列姓名旁顯示 綠「補課」/紫「試上」/紅「**試上費未收**」（點入場前提醒櫃檯先收試上費）。補課學員點名單快速入場＝當日課程學員免費，與 3.30.0 dayOnly 入場資格一致。
- ✅ **銷假改方案 B——不自動取消已訂補課、超額擋下由會員自選**（`3.31.0-cancel-leave-planB`，commit 後端 `6345eb0`、前端 `260f863`；E2E **7/7**；使用者拍板）：`cancelLeave` 移除「券血緣連動取消補課」（血緣在 reconcile 模型下不可靠：回填券 originalEnrollmentId null／復活券留舊連結 → 可能誤殺或漏動）。改**額度預檢**：取消後 `used > min(cap, 剩餘請假數)` → 擋 `MAKEUP_OVER_QUOTA`「已預約 X 堂、取消後額度剩 Y，請先取消一堂補課」（**會員自選**要放棄哪堂；補課已上過 used 永久成立、該請假不可取消）；額度足夠 → 放行、**已訂補課全保留**（修原血緣邏輯誤殺：請假2訂1取消1，補課現保留）。E2E：訂2取消擋+補課皆保留／自行取消一堂後放行／訂1取消放行保留／收斂正確。前端銷假 modal 文案對齊。
- ✅ **補課額度改「不變量重算」——取消請假不再永久吃掉額度**（`3.29.0-makeup-entitlement-invariant`，commit `df7c8f7`；E2E **10/10**；使用者拍板規則 2026-07-17）：
  - **不變量**：任一時刻 `補課總額(available+used) = min(cap, 目前有效請假數)`；cap＝`enrollment.maxLeavesAllowed ?? rules.maxLeaves`；`allowMakeup=false`→0；**used 絕不撤銷**。
  - **新 `reconcileMakeupEntitlement(db, memberId, courseId, rules?, enrollment?)`**（冪等、課程層級計數）：不足→先**復活** cancelled 券（重設效期＝endDate+makeupDeadlineDays）再新建（`source:'reconcile'`）；過多→只作廢多餘 available（`over_limit`）。
  - **requestLeave**：移除事件式發券→重算（超限請假仍放行、額度不超 cap）；**cancelLeave**：移除「無條件作廢券」→保留 `MAKEUP_TAKEN` 擋＋未上補課報名連動取消（used 券還原 available）→重算收斂。`originalEnrollmentId` 保留稽核、重算不依賴。
  - **核心修復**：取消請假→再請假，額度自動補回 min(cap,有效請假數)（原事件式發券被 cancelLeave 廢券後永久卡低）。
  - **回填**：全庫 3 組有請假 (member,course)，僅**朱智萩**（技巧班，請假4/cap2/**used1**）調整 available 0→1 → 總額 2=min(2,4) ✓（規格原假設 used=0 期望 available=2，實際她已用掉一張、以不變量為準）；吳旻珊/王秀慧本就正確。
  - **E2E 10/10**：請假1/2/3(超限)、取消收斂、**再請假額度還回**、補課 used、銷假連動（used 還原）、allowMakeup=false。前端免改（補課顯示讀 available 自動跟）。
- ✅ **補課規則收緊＋放寬（一問一答引出兩改）**（`3.28.0-makeup-backend-guards` commit 後端 `a9e8f51`；前端 `832a0de`）：
  - 📋 **規則確認**：不可補「自己報名的那個梯次」（整期報名每堂本有名額）；可補**同班別其他梯次**或**同補課類型班別**＋同館；期限＝課程結束日+N 天。
  - ✅ **後端權威雙擋**（原只前端排除）：`enrollMakeup` 加 ①補回原課程 → `SAME_COURSE` ②目標場次已有有效報名 → `ALREADY_IN_SESSION`（堵直打 API 同場次雙重佔位灌水）。E2E 3/3（擋原課/擋已在場次/同班別他梯正常）。
  - ✅ **課程結束後加開場次即時開放補課**（前端）：補課選單原以「課程起訖日」查場次 → 結束後加開的未來場次落在範圍外看不到 → 改一律查「今天~+180 天」再按候選課程過濾（已結束課 status 仍 active、候選不會被濾掉；後端無課程結束檢查不擋）；順帶 N 次請求合併 1 次。**整條鏈**：已結束課「新增場次」（可勾帶入學員）→ 員工列表/月曆即見 → 同班別/類型學員補課選單即時可選。
- ✅ **月曆兩修：課程月曆可橫向捲動＋表頭表身欄寬對齊**（純前端 commit `6546220`＋`138d28a`）：①員工課程月曆容器原 `overflow:hidden` 無 minWidth → 窄螢幕被壓扁鎖死（排班月曆可拉、課程不能）→ 比照排班改 `overflowX:auto`+`WebkitOverflowScrolling:touch`+內層 `minWidth:640`。②三月曆（排班/員工課程/會員課程）表頭（週日~週六）與表身為兩個獨立 grid、皆 `repeat(7,1fr)`——**`1fr`＝`minmax(auto,1fr)`，格子內容 min-content 會撐寬該欄**、表頭不會 → 欄寬各算各的不對齊 → 6 處 grid 全改 `repeat(7,minmax(0,1fr))` 嚴格等寬。**教訓**：分開的表頭/表身 grid 要對齊，欄寬必須 `minmax(0,1fr)`（或併成單一 grid）。
- ✅ **員工體驗預約列表：過期預約收折疊區**（純前端 commit `200a52d`）：`ExperienceBookingsPage` 列表分兩段——體驗日 ≥ 今天照常顯示；已過期收「已完成（過期）（N）▼」折疊鈕（預設收合、展開列日期新→舊、淡化、卡片功能照舊）。統計數字仍涵蓋全部。
- 📋 **零星資料操作（2026-07-17）**：優惠卡剩餘次數調整（皆原始格數不變＋卡片備註留稽核）——**陳頡** 10→9、**張凱雋** 5→4、**胡皓為** 9→8、**黃煒勛** 7→6；**吳慶荃** 9→8 **免調**（查證＝當晚 19:42 新竹入場系統已自動扣次、無移轉紀錄，再調會多扣）。**教訓**：調卡次前先比對現值與使用紀錄，現值已達目標＝櫃檯已用系統扣過、勿重複扣。**未認領盤點（7/17 晚）**：隊員 13/42（新竹9含手動加入的馮鏡潔、士林4）；課程學員 3（蔡逸夔/劉宜珊/林耿民；朱俐穎已認領）；90日票 4（**李應崇效期至 7/18 最急**、謝佑欣/廖有福 9/08、曾宥勝 9/22）。
- 📋 **手動掛攀岩隊員三位（2026-07-17，資料操作）**：**鍾昀達**（0963110707）、**杜冠勳**（0978906056）已註冊 → 直接 `setTeamMember`（隊籍至 2026-12-31）＋寫 `teamApplications` 2026 名冊（新竹紅石、已收款、source manual）；兩位墜測本就通過、9 折驗證生效。**馮鏡潔**（0972211914）未註冊 → 加入 `legacyTeamMembers` 待認領（rawName 標新竹、until 2026-12-31、source manual）→ 註冊時自動掛隊員＋名冊＋墜測同步。**手動掛隊員 SOP**：已註冊＝setTeamMember＋teamApplications upsert；未註冊＝加 legacyTeamMembers（rawName 含館別供名冊歸館）等自動認領；名冊 `primaryGym` 由 rawName 正則判（無「士林」→新竹紅石）。
- 📊 **會員數盤點（2026-07-17）**：**有效會員 250**（主帳號 240＋子會員 10；排除練習 fixture 1）——7/13 清空後全為真實自助註冊，7/15 盤點 121 → 兩天翻倍。Email 已驗證 238、攀岩隊員 28（認領 28/41）、入場前置未完成 12。
- ✅ **會員五頁通知一律改彈窗**（純前端 commit `d1b6ac7`→`192adf5`）：課程/體驗/比賽/租借/入隊 五頁的 `showMsg`（原頂部橫幅 3~6 秒消失易被忽略）改一律彈窗——新共用 `components/ErrorAlertModal`：`ok`=✅完成(綠)/`red`=⚠️無法完成操作(紅)/`orange`=⚠️提醒(琥珀)，「知道了」或點背景關閉。從 showMsg 源頭分流、90+ 處訊息一次涵蓋（額滿/請假上限/銷假被擋/報名補課失敗與各類成功訊息）。**範圍**：Passes/Profile 的訊息為視窗內就地顯示（非頂部橫幅）、不改。原 msg banner 程式留存但不再觸發。（演進：先只改錯誤類 `d1b6ac7` → 使用者拍板成功也彈窗 `192adf5`。）
- ✅ **修：課程改 maxStudents 未同步場次 → 朱智萩銷假被誤擋**（`3.24.0-sync-session-maxstudents`，commit 後端 `d49412b`）：回報朱智萩無法取消 8/9 請假。**根因**：**場次 `maxStudents` 是建課時快照**，課程層改名額（技巧班 6→7）只改課程文件、8 個場次全停留 6 → 銷假名額檢查比對場次 max：`enrolledCount 6 ≥ 6` 誤判滿、擋 `SESSION_FULL`（課程上限 7 其實沒滿）。**修**：①程式根治——`PUT /courses/:id` 改 `maxStudents` 時 batch 同步旗下未取消場次（此快照分岔同樣影響報名/候補遞補的名額判定，一併根治）②資料——全庫掃描僅技巧班不同步、8 場次 6→7 對齊；驗證 8/9 場次 6/7 → 銷假放行。**教訓**：手動/程式改課程名額，場次的 maxStudents 快照要一起動（3.24.0 起 PUT 自動同步；firebase-admin 直改課程仍需手動同步場次）。
- ✅ **課程免費入場起始可個別覆寫（插班學員）**（`3.18.0-course-access-start-override`，commit 後端 `a865135`）：免費入場（課程學員）原為**課程層級** `getCourseAccess` 用 `course.unlimitedPracticeStart`、全課程統一、無「單獨一人起始日」（enrollment 的 `gymAccessStart` 是每場次算、且未被 getCourseAccess 讀）。加**個別覆寫欄位 `enrollment.courseAccessStart`**：`getCourseAccess` 對「此人此課有 courseAccessStart 且晚於課程起始」時取較晚者（**只延後不提前、無覆寫者不受影響**）。用於插班——**劉家玉 8/2 起上課**：移除 8/2 前 3 堂場次報名（7/12/19/26，場次計數−1）、保留 8/2~8/30 五堂，並設 5 筆 enrollment `courseAccessStart=2026-08-02` → 免費入場 8/2 起（7/16 查 getCourseAccess 回空＝8/2 前無免費資格、正確）。**注意**：目前 courseAccessStart 為資料層設定、未做員工 UI；插班移除早場次亦為手動（firebase-admin）。
- ✅ **課程月曆依課程給不同淺色底**（純前端 commit `abd1cab`，員工+會員共用）：新 `utils/courseColor.js`（課程 key 雜湊→10 色淺底調色盤：紅/藍/綠/琥珀/紫/粉/青/靛/橄欖/棕，**全部淺色底+對應深字**）。員工 `CoursesPage` 日格場次 pill 由固定粉底改 `courseColor(courseId)`；會員 `MemberCoursesPage` 日格由「小圓點+文字」改淺色 pill 依課程配色（請假/補課/取消保留語意灰/綠色、體驗藍淺底、比賽琥珀淺底）。同課程各場次同色、不同課程不同色。
- ✅ **墜落測驗頁加「安排測驗（選場館）」**（純前端 commit `3531eb4`）：回報子會員簽完兩份文件後、墜測頁只顯示「尚未通過測驗」缺安排按鈕。根因＝`MemberFallTestPage` 狀態檢視原**只有測驗狀態+同意書兩張卡、無排測 UI**（排測原只在 onboarding gate 與 MemberProfilePage 家庭成員）。加「安排墜落測驗」卡：**同意書已簽（`hasSigned`）+ 尚未通過（`!testValid`）**時顯示——未排→選新竹/士林送出 `createFallTestBooking({gymId, targetMemberId: forChildId})`（子會員帶子帳號 id）、已排→「已安排 XX館，待現場測驗」+取消/更改場館。子會員（forChild 模式）與本人皆適用。
- ✅ **課程名單預留自動認領**（`3.17.0-course-roster-autoclaim`，commit 後端 `aa0437f`；E2E 通過）：店員把人加進課程名單但當時查無會員 → 存 `pendingCourseClaims`（`{courseId, courseName, gymId, name, claimed}`）；該人日後**自助註冊時以姓名比對（`legacyNameMatch`，name-only）自動加入該課程全部場次**（confirmed、費用 0、paymentConfirmed、gymAccess 跟課程 `unlimitedPractice`、通知同館 gym_manager+super_admin 核對）。`memberService.claimPendingCourseEnrollment` 掛在 `createMember`（接在墜測/隊員/90日票/比賽 claim 之後）；去重（已在名單只標 claimed 不重建）；子帳號不走此認領。**⚠ name-only 比對有同名碰撞低風險**（未對到者只有姓名無電話）→ 認領通知管理員核對。E2E：模擬「王秀慧」`createMember`→自動加入技巧班 8 堂、claim `claimed:true`+`claimedBy` 對上，測後全清、claim 還原。
  - 📋 **資料操作**：士林「抱石X肌力與體能特訓班 7-8月週日班」加 **黎根延**（對到，6 堂）；建 5 筆 `pendingCourseClaims`——李介中/簡芝珊/王雅茵→抱石X肌力班、温詩妤/王秀慧→技巧班（先前查無的 2 位）。**黎根延三項驗證**：課程學員 ✅（getCourseAccess 抱石X肌力）、隊員 ✅（`isActiveTeamMember` true、效期 2026-07-13~**2026-12-31**、9 折 300→270）、免費入場期間 ✅ **2026-07-05~2026-08-09**（＝課程 unlimitedPractice、非隊籍到期日）。**釐清**：隊員效期(→12/31)給「付費 9 折」、非免費；免費入場只來自課程學員身分、跟課程期間（隊員本身不免費入場）。（`isActiveTeamMember(member物件)` 吃物件非 id，查驗別傳 id。）
- ✅ **會員體驗課程「我的預約」加註冊提醒**（純前端 commit `d75be16`）：`MemberExperiencePage` 我的預約分頁（有預約時）最上方加琥珀橫幅「請所有參加體驗課程的朋友先註冊紅石會員，以加速入場流程（需完成風險安全聲明書及墜落測驗同意書簽署）」（靠左、空狀態不顯示）。用語對齊全站（waiver→風險安全聲明書、墜測同意→墜落測驗同意書）。
- ✅ **修：電話搜尋子會員不顯示兒童入場**（`3.16.0-eligibility-child-by-age`，commit 後端 `327ec4d`；純後端）：`GET /checkin/eligibility/:memberId`（電話搜尋資格預覽）原回 `memberType = member.memberType || 'general'`（raw 欄位）→ 子帳號 `memberType=undefined→'general'`；而 `child_free`（兒童單次入場 150）設定 `memberTypes:['child']` → 前端過濾 `['child'].includes('general')=false` 濾掉兒童入場（成人/學生因 memberTypes 含 `general` 有顯示，故只缺兒童）。**系統判兒童＝出生日期 age<13**（`checkin/pricing.getMemberType`，`verifyEntry` 走 `gate.memberType=getMemberType(member)` 本就正確），唯獨此 eligibility 端點漏掉。改用 `getMemberType(member)`。驗證：莊于寬(子,生日2016)→`child` 顯示兒童入場、家長吳思瑩(1985)→`general` 不誤顯示。**注意**：子帳號 `memberType` 常是 undefined，涉及兒童判定一律走 `getMemberType`/`isChild(birthday)`，勿信 raw memberType。
- ✅ **體驗預約可編輯課程日期/時段**（`3.15.0-experience-edit-schedule`，commit 後端 `f398f58`、前端 `1464a90`；E2E 6/6）：員工端「體驗課程預約管理」預約單編輯原只能「編輯參加者」→ 改「編輯預約」，加「課程日期／時段」欄。後端新 `PUT /experience-bookings/:id/schedule` + `experienceService.updateExperienceSchedule`——改日期/時段時**連動**：`courseSessions`（就地更新 date/startTime/endTime、保留 sessionId）+ `courses`（起訖日/時段）+ 教練排班（刪舊班→於新日期建新班，已指派教練才建）+ **已發 active 體驗入場券 validDate/expiresAt 同步改新日期**（否則券綁舊日期、當天不能用）。前端 `ExperienceBookingsPage` 編輯 modal 加 date+時段輸入，變更才打 schedule 端點再更參加者。E2E（`updateExperienceSchedule` 直呼）：改 7/20 16:00-17:30→7/25 18:00-19:30，session 日期/時段 + 票券 validDate/expiresAt 全連動。**注意**：`reassignExperienceCoach` 只更教練+重建班、**不**更 session/course 日期時段（故另做 `updateExperienceSchedule`）；bookingTime 是自由字串（`parseBookingTime` 解析 `HH:MM-HH:MM`）。
- ✅ **修：課程「報名名單」modal 標頭「共 N 人」數字灌 8 倍**（純前端 commit `5954110`）：`CoursesPage` `rosterModal` 標頭用 `enrollments.length`＝**報名筆數**（週課每人每堂各一筆）→ 4 人 × 8 堂顯示「共 32 人」。名單內容本身有依 memberId 去重（`byMember`）只列 4 列，僅標頭沒去重。改 `new Set(enrollments.map(e=>e.memberId)).size` 算不重複人數。
  - 📋 **附帶（資料操作）：手動加入士林館「技巧班 7-8月週日班」名單 4 位**（吳旻珊/何禹禎/劉家玉/鄭力溦，各 8 堂 confirmed，firebase-admin 直建 courseEnrollments；**費用先不寫**＝enrollmentFee 0、標 paymentConfirmed 不進待收款/不記帳）。另 2 位（温詩妤/王秀慧）系統查無會員、等其自行註冊再補。**要點**：手動加名單需照 courseService enrollment schema 建（memberId/sessionId/courseId/status confirmed/date/gymId…）＋逐場 `enrolledCount+N`；名單姓名/電話由後端反查 members，故 enrollment 不必存 phone。
- 📌 **本次修復 CLAUDE.md 磁碟檔退回事故**：發現 `redrock-api/CLAUDE.md` 磁碟工作檔停在 2026-07-04 版（35KB、mtime 7/4 16:34、git 最後 commit `dd285a4`），07-05→07-16 兩週進度只存在 Claude Code file-history 快照（`~/.claude/file-history/…/922af0b500db3347@v226`，366KB／1517 行）而**未落地磁碟、未進 git**。以 v226 快照重建完整長版並 commit 落地（git 一旦 commit 即永久保存，不受工作檔再被還原影響）。**成因查證**：`~/Downloads` **未走 iCloud 同步**（桌面與文件同步關閉、檔案無 `.icloud` 佔位）、檔案無鎖定旗標→排除 iCloud/權限。實況＝磁碟檔 mtime 卡 7/4 16:34、git 自 7/4 未再收到 CLAUDE.md 變更，但 file-history 有 226 版（最新今日）＝**Edit 被記進 file-history/harness 追蹤副本、卻沒落到磁碟真檔**。最可能：跨裝置同一台 Mac mini 多 session 併行（本檔守則早警告「別讓兩 session 同時寫同一檔＝編輯器層級覆蓋」），或早期一次 git checkout/stash 把工作檔退回 7/4 後，後續 session 都讀 harness 內存的長版（沒重讀磁碟）在改，且「git add CLAUDE.md」因磁碟無 diff 而每次都沒真的 commit 進去→兩週沒人察覺。**唯一可靠落地＝改完 `git status` 確認 CLAUDE.md 真的 modified 再 commit＋單 session 編輯**（本檔守則第 3 條）。

- ✅ **器材租借收入記入財報＋日結帳作廢票號碼總金額**（`3.84.0-equip-rental-income-void-invoice-amount`，commit 後端＋前端；E2E 打正式 API **9/9**）：
  - **器材租借（抱石墊/岩盔/吊帶）收入原本不進任何財報**——確認收款只翻狀態、不記交易 → 營收報表 `/^rental/` 分支查無、日結帳不讀 equipmentRentals。修（**a+b**）：新共用 `rentals.recordRentalRevenue`（`type:'rental'` 交易、`totalAmount=totalRentalFee` **只記租金不含押金**、`recognitionDate` 認列在確認收款當日、冪等旗標 `revenueRecorded`），接**現金確認** `/rentals/:id/confirm` 與**轉帳確認** `transfers.js` rental 分支兩路徑。日結帳 `GET /today` 交易迴圈加 `type==='rental'`→`income.equipmentRental`（計入 total、addPay 歸付款方式）；月銷售 Excel 加「器材租借」列、`manualIncomeTotal` 納入；前端 `DailySettlementPage` 今日收入卡＋摘要分項＋手動輸入加器材租借列。
  - **日結帳新增「作廢票號碼總金額」欄位**（打錯發票金額）：作廢發票號碼下方一欄手動輸入 → 存 `voidInvoiceAmount`、日結帳摘要/月銷售/發票明細顯示。**使用者拍板：僅備註、不扣總計**（原一度做扣除、後改回不扣，發票總金額/實收總額/總計皆維持 income.total）。
  - **E2E（9/9）**：注入待確認租借（現金租金 800 押金 1000）→ 確認收款 200→status active＋revenueRecorded→type:rental 交易 800（不含押金）→重複確認冪等（仍 1 筆）→日結帳 income.equipmentRental=800 計入 total→營收日報表 rental=800。fixtures 全清。

- ✅ **修：會員補課看不到「同補課類型」的其他班別（王登第案例）**（`3.85.0-makeup-candidate-by-type`，commit 後端＋前端；正式 API 驗證）：回報王登第（補課券屬**小蜘蛛人進階班**）補課選單看不到**小蜘蛛人初級班**，儘管班別設定裡兩者補課類型都掛「小蜘蛛人」。**根因**：後端 `enrollMakeup` 本就支援跨班別互補（`makeupTypeIds` 交集放行），但**會員端補課候選只用 `c.categoryId === makeup.categoryId`（同班別）過濾、完全沒看 makeupTypeIds** → 進階班的券永遠看不到初級班（又是前後端判定邏輯不一致）。**修**：①`getCourses` 附掛 `makeupTypeIds`/`makeupGroup`（原只回 categoryName）②前端 `openMakeupModal` 候選改「**同班別 或 同補課類型**」（由 courses 建 categoryId→makeupTypeIds 映射、取券所屬班別類型與候選課程類型交集，對齊後端；含舊制 makeupGroup 相容）③補課視窗副標改「可補課至**同補課類型**的班別場次」＋列出**可補課班別**清單（回答會員「怎麼知道自己屬哪類型」）。驗證：初級班/進階班/密集班共用補課類型「小蜘蛛人」（`9103f8f6`），初級班新竹多梯 `makeupTargetOpen=true` → 修後王登第補課券看得到初級班新竹場次（士林班仍由同館過濾排除）。
  - 📋 **補課類型（makeupTypes）觀念**：補課類型是**班別（courseCategory）層級**屬性（班別管理→補課類型可多選掛）；會員的補課券綁「請假的那門課所屬班別」，可補課至**任一共用同補課類型的班別**＋同館（後端 `enrollMakeup` 權威：同班別恆可、或兩班別 makeupTypeIds 有交集）。判斷「屬哪類型」＝看券所屬班別掛了哪些補課類型。

- ✅ **補課類型改「單向」（本班別類型 makeupSelfType）**（`3.86.0-makeup-directional-self-type`，commit 後端＋前端；正式資料驗證 10/10）：原補課類型是**雙向對稱**（兩班別有共同 makeupTypeIds 即互補）；使用者要**單向**——「青少年可到入門班補課、但入門班不能到青少年班補課」。**新模型**：班別加 `makeupSelfType`（本班別類型，單選＝別人補課過來時這班算哪一類）；現有 `makeupTypeIds` 語意改為**「可補課去的類型」（多選，本班學員能補去哪些類型）**。判定改單向：**A 能補去 B ⟺ B.makeupSelfType ∈ A.makeupTypeIds**（或同班別恆可）。`enrollMakeup`（DIFFERENT_CATEGORY 判定）／`getCourses`（附掛 makeupSelfType）／會員補課候選（`openMakeupModal` shareType 改單向）／員工班別表單（加「本班別類型」單選＋「可補課去的類型」多選 relabel＋列表摘要）全對齊；移除舊制 makeupGroup 相容判定。`makeupSelfType` 已依班別名回填（技巧班→技巧以及進階班、青少年→青少年班、小蜘蛛人3班→小蜘蛛人…；抱石X肌力/虹瑩/週期訓練無眼名類型＝null）。
  - **單向盤點現況**（可補課去，同館；另受目標梯次 makeupTarget 開關限制，如**密集班 makeupTarget=off 不接受補課**故實際無場次）：青少年初級/進階 → 入門班＋小蜘蛛人三班＋青少年互通｜小蜘蛛人三班互通｜進階班 → 技巧班、矯正班｜矯正班 → 進階班｜入門班/技巧班/抱石X肌力/虹瑩/週期＝僅本班別。⚠ **入門班單向補不到青少年/矯正（其 makeupTypeIds 僅「入門班」）**——要開放需在班別加對應「可補課去的類型」。
  - 📋 **兩層觀念**：①**補課類型相容**（makeupSelfType/makeupTypeIds，單向）決定「哪些班別可互補」②**makeupTarget 開關**（off/on/auto達2人）決定「該梯次是否接受補課」——兩者皆須通過才補得成。判斷「屬哪類型」＝看班別的 makeupSelfType（本班類型）與 makeupTypeIds（可補去）。

- 📋 **士林技巧班展延場次補課看不到＝makeupTarget 設定（非 bug，資料操作）**（2026-07-21）：回報「技巧班原 7/10 結束、展延到 7/24，補課單沒這些場次」。查明——技巧班 4 位補課券持有人（温詩妤/王秀慧/朱智萩/吳旻珊）都來自**週日A班(7-8月)**，補課候選只能是其他技巧班梯次＝**週五A班(5-7月，已加開 7/17+7/24)**；但週五A班**0 位常態學員**（僅朱智萩的補課紀錄）、`makeupTarget=auto`（需常態≥2人才自動開放）→ `makeupTargetOpen=false` 被前後端濾掉。**修＝把週五A班 `makeupTarget` 設 `on`（強制開放作為補課場次）**（firebase-admin 直改；亦可員工端「編輯梯次→可作為補課場次→強制開放」）。設定後 7/24 未來場次即出現（7/17 當時已過）。**慣例**：把「已結束/無常態學員的梯次」拿來當某類別的補課場地時，該梯次 `makeupTarget` 要設 `on`（auto 會因常態<2 人而關閉）。⚠ 兩層：補課類型相容（同班別恆可）＋目標梯次 makeupTarget 開放，兩者都要通過。

- 📋 **士林技巧班週五A班名單補登（3 位）＋修朱智萩補課掛在取消場次（2026-07-21，資料操作）**：承技巧班展延——查明週五A班(5-7月,`d2bae812`)**系統名單一直是空的**（報名從沒登進系統），所以「帶入本課學員」沒東西。使用者提供實際學員：**林柏宇/陳凱琪/邱鈺昇**（皆已註冊會員）。firebase-admin 全期補登（7 堂未取消場次×3 人＝21 筆 confirmed、費用 0＝已繳、`notes:名單補登`、`paymentMethod:roster-backfill`、gymAccess 5/22~7/25、各場次 enrolledCount 重算）。→ 名單/月曆/入場自動出席連動，之後新增場次「帶入本課學員」正常。**順修**：7/24 有**兩筆重複場次**（cancelled `044bd08a` + scheduled `a3050733`），朱智萩的補課(confirmed)掛在**取消**那筆＝無效場次 → 移到 scheduled 7/24（`a3050733` 現有 林柏宇/陳凱琪/邱鈺昇 正取＋朱智萩補課，enrolledCount 3）。cancelled 重複 7/24 留著（status=cancelled 各處自動濾除、無害）。**教訓**：搬遷/BeClass 課程若名單沒登進系統，該梯 enrollments 為空→「帶入本課學員」與課程列表人數皆 0，需補登；補課掛在重複/取消場次時要移到有效場次。

- ✅ **取消場次退回補課學員補課券**（`3.87.0-cancel-session-restore-makeup`，commit 後端＋前端；E2E **5/5**）：回報「刪除場次/停課時原補課學員應退回補課券」。查明——**休館停課** `closureCancelSession`(3.54.0) 本就處理（isMakeup→取消報名＋券還原 available、另發正取豁免券）；但**一般取消場次**（場次列表 ✕ → `updateSession(status='cancelled')`）**只改場次狀態、補課報名沒取消、補課券沒退回**（缺口）。修 `updateSession`：`status→cancelled` 時掃該場次報名，**isMakeup confirmed → 取消報名(cancelReason:session_cancelled)＋補課券還原 available（清 usedSessionId/usedAt，比照 cancelMakeup）**，回傳 `makeupRestored` 張數。**一般取消不發正取豁免券**（那是休館停課專屬；正取/試上/請假維持原行為不動，避免退費/課程資格副作用）。前端 `handleCancelSession` 確認文案加「補課學員會自動退回補課券」＋成功訊息顯示退回張數。E2E：注入補課券(used指向場次)+補課報名(isMakeup) → PUT 取消場次 → makeupRestored=1、報名 cancelled、券 available 清 usedSessionId、場次 cancelled。**兩條停課路徑（休館停課／一般取消）現在都會退回補課券。**

- ✅ **取消場次/停課 → 試上完整清理**（`3.88.0-cancel-session-trial-cleanup`，commit 後端＋前端；E2E **7/7**）：承取消場次退補課券——試上（isTrial）處理原本不完整（休館停課只取消名單、回報數；一般取消完全沒動 → 名單/票券/預約全掛著）。使用者拍板「完整取消＋通知＋列退費待辦」，兩條路徑一致。新 `experienceService.handleTrialSessionCancelled(db, bookingId, {reason})`：取消體驗預約(`cancelReason:session_cancelled`)＋`reverseExperienceRevenue` 沖銷營收＋`voidExperienceTickets` 作廢單日票券(`singleEntryTickets`)＋作廢 pending 轉帳單＋**已繳費列退費待辦**（`refundRequested`＋`refundAmount=全額`、**館方因素免手續費**、`notifyRoleInGym experience_refund` 通知管理員）。接進 `updateSession`(status→cancelled) 與 `closureCancelSession` 的 isTrial 分支（lazy require 避循環依賴、不刪週課、不 promoteWaitlist）；回傳 `trialAffected`。`/members/my/alerts` 加 `experience_cancelled` 首頁通知（近14天、`kind:reject`、導 `/member/experience?tab=my`）；`MemberHomePage` 標題專屬文案「課程試上/體驗預約因場次取消」。**E2E**：注入試上報名+已繳費體驗預約(800)+單日票券 → 取消場次 → trialAffected=1、報名/預約 cancelled、退費待辦(全額800免手續費)、票券作廢、首頁通知出現。**兩條停課路徑現在對補課券(退回)＋試上(完整清理)都一致處理。**⚠ 試上票券集合＝`singleEntryTickets`、關聯欄位 `experienceBookingId`（非 experienceTickets/bookingId）。

- ✅ **試上因場次取消寄 email 通知會員**（`3.89.0-trial-cancel-email`，commit 後端；E2E 7/7 無回歸）：承 3.88.0——除首頁通知＋管理員待辦，多加給會員的 email。`emailService.sendTrialCancelledNotice`（紅石格式：課程/原上課日+時段/已繳試上費；已繳費文案「全額退還、館方因素不收手續費、洽櫃檯退費或改約」，未繳費「洽櫃檯改約」）；`handleTrialSessionCancelled` 解析收件信箱（`contactEmail → memberEmail → 會員資料 email`，缺信箱只留首頁通知）寄送，try/catch 不阻斷取消流程。措辭經使用者確認。

- 📋 **修朱智萩補課單消失（刪除+重建場次殘留）＋通知信加兩館電話**（2026-07-21）：回報朱智萩補課單不見。查明——技巧班週五A班 7/24 有**三筆重複場次**（`044bd08a` 取消、`a3050733` 取消、`daabcbbd` scheduled live）。使用者把舊 7/24 取消、用「新增場次帶入學員」重建 live 7/24，但**「帶入本課學員」只帶正取(confirmed/leave)、不帶補課學員** → 朱智萩的補課被留在取消的 a3050733 → 補課單消失。firebase-admin 修復：朱智萩補課報名 a3050733→daabcbbd(live)、補課券 `a47885e1` usedSessionId 同步改 daabcbbd（先前移場次只改 enrollment 沒改券的 usedSessionId，一併補正）、清 a3050733(取消場次)上 3 位正取殘留報名。現 live 7/24 名單＝林柏宇/陳凱琪/邱鈺昇(正取)＋朱智萩(補課)。**教訓**：①「刪除+重建場次」會讓補課學員的預約殘留在舊(取消)場次——`帶入本課學員`不含補課/試上；3.87.0 起「取消場次」會退回補課券(available)讓補課生自行改約，但重建場次不會自動搬補課生。②移動補課報名場次時，補課券 `usedSessionId` 要一起改（否則券與報名指向不一致）。
- ✅ **試上取消通知信加兩館聯絡電話**（`3.90.0-trial-cancel-email-gym-phones`，commit 後端）：`sendTrialCancelledNotice` footer 加「新竹館 03-6686635／士林館 02-28837591」（硬編、電話變動時改 emailService）。

- ✅ **試上取消通知信：課名加館別前綴＋副本寄館方 email**（`3.91.0-trial-cancel-email-gym-prefix-cc`，commit 後端）：`sendTrialCancelledNotice` 課名前綴【新竹館】/【士林館】（依 gymId），`sendEmail` 帶 `cc`＝該館 `gyms.email`。**新增 `gyms.email` 欄位**（新竹 `redrocktaiwan.hc@gmail.com`／士林 `redrocktaiwan@gmail.com`，即館別電腦帳號信箱；firebase-admin 寫入、之後可改）。`handleTrialSessionCancelled` 讀 gym 文件取 label＋email。測試信寄送法：暫改 gym-hsinchu.email 為自己信箱→觸發→還原（避免打擾真實館方信箱）。

- 📐 **發票機串接架構設計（討論定案，尚未動工）**（2026-07-21）：`docs/invoice-integration-plan.md`。現況＝系統不開發票、店員每日結帳手動抄發票號。**拍板決策**：①**實體二聯式紙本發票**（WinPOS **WP-560**，9針/ESC-POS/RS-232，已查證可串；**不走電子發票/加值中心**）②橋接走**本地列印代理**（Windows exe/服務＋`serialport` 開 COM 埠＋localhost 給員工端網頁呼叫；不走 Web Serial）③號碼**後端計數**（換捲設起始號、每印+1、作廢跳號；紙捲號碼預印、機器只定位）④**收款當下開票**、四頁共用 `InvoiceCheckout`（入場/租借/銷售/課程；租借只租金不含押金）⑤二聯**選填統編**⑥**退費只作廢不折讓**（同期+全額+收得回兩聯→作廢跳號；否則直接退費、原發票不動標 refunded）⑦**驅動錢櫃**（現金收款/退費/點鈔，ESC p）⑧**退費/作廢報表**給會計對帳⑨櫃檯 **Windows**。**定位可自幹**（ESC/POS 游標控制＋練習紙捲試印校正，經銷商 DIP/範例只加速、非必要）。分階段 P1~P7，卡硬體到位（使用者採購舊機＋RS-232轉USB＋二聯練習紙捲）。

- ✅ **跨期補課（crossCohortMakeups）計入場次名額**（`3.92.0-cross-makeup-counts-capacity`，commit 後端；E2E 3/3）：查小蜘蛛人初級班週三A班 7/22 名額時發現——跨期補課（非會員名單，存 `crossCohortMakeups`、櫃檯放行）**不進場次 `enrolledCount`** → 補課名額閘門（`enrollMakeup` 的 `enrolledCount>=maxStudents`）與剩餘顯示都沒扣它們 → **會超收**（7/22 週三A 系統顯示剩 5、實際已有黃勇淳正取＋范語晨/黃彥凱跨期補課＝剩 3）。修：①`enrollMakeup` 容量檢查加「該場次 `crossCohortMakeups` status:booked 數」→ `enrolledCount+crossBooked>=max` 才擋 ②`getSessions` 批次計入 `crossMakeupCount`、加進 `expectedCount`（前端 `sessionRemain`＝max−expectedCount 自動扣）＋回傳 `crossMakeupCount`。E2E：7/22 週三A `crossMakeupCount=2`、`expectedCount=3`、剩餘 3。**跨期補課現在會正確佔名額、不再超收。**

- ✅ **修：會員 QR 優惠折扣券價未疊隊員 9 折（顯示 240 應 216）**（`3.93.0-qr-discountcard-team-rate`，commit 後端；正式 API 驗證）：回報隊員（周正晏 0928972742）會員 QR 一般入場顯示 270（隊員9折對），但**使用優惠折扣券顯示 240**（只 8 折、沒疊隊員）。根因：`verify.js` 回會員端的 `instruments.discountCard.rate` **寫死 `DISCOUNT_CARD_RATE`(0.8)、非 team-aware**，會員 QR 前端（`MemberQRPage`）用「原價 300 × rate(0.8) = 240」；而員工電話搜尋 `/checkin/eligibility` 的 rate 本就 `隊員?0.72:0.8`（正確）、實際扣款 flow.js 也疊隊員（216）→ 只有會員 QR 顯示層中招。修：`rate` 改 `isTeam ? round(0.8×0.9)=0.72 : 0.8`＋加 `teamStacked` 旗標 → 300×0.72=216，與實收/eligibility 一致。**純顯示層 bug、實際扣款本來就 216（未多收）**。驗證：POST /checkin/verify 周正晏回 rate 0.72/teamStacked true。（附：優惠卡=8折、黑卡=0元；`discount_card` 8折後疊隊員9折=216，`black_card` 免費。）

- ✅ **假補總表：停課日標（停課）＋跨期補課段標（前期）**（`3.94.0-lm-closure-crossterm-tags`，commit 後端＋前端；正式 API 驗證）：需求——停課提供的補課券在假補總表「請假」欄顯示**停課日期（停課）**；非當期課程學員（跨期補課）顯示**請假日期（前期）**。實作：①停課券（`courseMakeupRights source:'closure'` 的 `closureDate`）嵌入 member row 的 `leaves` 標「（停課）」，**`leaveCount` 維持真請假數**（停課豁免不計）②跨期補課（`crossCohortMakeups` status:'booked'）依 `targetSessionId`→course 對應到目標課程，`owedDates` 標「（前期）」加入新 `crossMakeups` 段（比照 pendingClaims、紫色）。單一課程 `buildLeaveMakeupSummary` 與全部課程 `/leave-makeup-summary/all` 兩端點都改；前端假補總表 modal（兩視圖）＋CSV 加跨期補課段。驗證：週六A班 rows「何宇澄 2026-07-11（停課）」、crossMakeups「陳若僖（前一梯小蜘蛛人週六A班、補課去 7/25）」。
  - ⚠️ **陳若僖跨期補課 `owedDates` 為空**（建 crossCohortMakeup 時漏記前期請假日）→ 假補總表她的（前期）日期空白；如需顯示要補 owedDates。她＝陳佳汝子女、當期無報名、僅前一梯小蜘蛛人週六A班補課排 7/25。

- ✅ **假補總表加「待安排跨期補課」＋「近三個月逾期未補課」兩段（全部課程視圖）**（`3.95.0-lm-pending-cross-overdue`，commit 後端＋前端；正式 API 驗證）：承 3.94.0——①**跨期補課待安排**：`crossCohortMakeups status:'pending_arrange'`（尚未排場次、無歸屬課程者）在「全部課程」假補總表頂層 `pendingCrossMakeups` 段列出（姓名/前一梯/前期請假日 owedDates 標「（前期）」，依 gymId 過濾）②**近三個月逾期未補課**：`courseMakeupRights status:'available'` 但 `expiresAt` 已過期且在近 90 天內 → `overdueMakeups` 段（姓名/課程/到期日）。`/leave-makeup-summary/all` 回這兩個頂層陣列；前端全部課程視圖加兩區塊（紫/紅）＋CSV。**驗證**：待安排 7 位（吳宇商/吳宇菲/陳宣妙/陳宥希/榮謙如/榮謙宇/賴思綺，含前期請假日）；逾期 0 位（現無過期未用券、功能備用）。單一課程視圖不含這兩段（待安排無課程歸屬、逾期為全域）。

- 📋 **小蜘蛛人 3 位補課排 7/22（Excel「0721 更新補課資訊」，2026-07-21 資料操作）**：何宇涵/何宇澄/李星諭（7/11 颱風停課）→ 用各自剩的 available 補課券，走正式 API `/courses/makeup/:id/use`（enrollMakeup 權威：名額/補課類型/計數）補課到 **7/22 小蜘蛛人初級班週三A班 14:30-16:00**（`cbf03dbf`）。三位現況＝7/04＋7/11 兩缺席、先前已補 7/15、各剩 1 券→這次排 7/22（兩缺席補完）。7/22 名單現滿 **6/6**：黃勇淳(正取)＋何宇澄/何宇涵/李星諭(補課)＋范語晨/黃彥凱(跨期補課)。⚠ 三位 home 梯：何宇澄=初級班週六A、何宇涵/李星諭=進階班週六B（進階→初級同「小蜘蛛人」補課類型放行）。

- ✅ **假補總表重整：以原班級為主＋跨期補課獨立一區**（`3.96.0-lm-cross-independent-by-origin`，commit 後端＋前端；正式 API 驗證）：依回饋——排列**以原班級為主**（學員列在自己原本班級下、後接補課班級+日期），跨期補課**不再塞進補課去的課程**，改**合併成獨立一區**（3.94/3.95 的 per-course crossMakeups＋pendingCrossMakeups 合併）。①per-course groups 移除 crossMakeups（純原班級學員+未認領）②頂層 `crossMakeups`＝所有未結案跨期補課（booked＋待安排），欄位 原班級(前一梯)→姓名→前期請假日(前期)→補課班級→補課日期(待安排)，依原班級排序③`overdueMakeups`（近90天逾期未補課）獨立一區保留。單一課程視圖也移除 crossMakeups（跨期屬全域獨立區）。驗證：groups 18 課皆無 crossMakeups；crossMakeups 10 位依原班級排（范語晨/黃彥凱→週三A、陳若僖→週六A、待安排 7 位）。⚠ 逾期天數維持 90 天（使用者寫 990 當 90 處理）；范語晨/黃彥凱/陳若僖 owedDates 空、前期請假日待補。

- ✅ **修：假補總表補課學員被誤列為該班學生＋跨期/逾期獨立區塊不顯示**（`3.97.0-lm-exclude-makeup-from-rows`＋前端）：回報「週三A班應只有一位學生」「前期課程學員沒看到獨立區塊」。兩個 bug：①後端 `byMember` 只排除試上、**沒排除補課** → 補課進某班的學員（何宇涵/何宇澄/李星諭補課到週三A班）被算成該班「學生」row（週三A顯示4位應1位）→ 兩端點 `byMember` 加排除 `isMakeup`（只列原班級整期學員；補課者列在其原班級、bookedMakeups 顯示補課去哪）。②前端 `loadLmAll` 抓了 `/leave-makeup-summary/all` 回應但 **`setLmSummary` 只存 `groups`、漏存 `crossMakeups`/`overdueMakeups`** → 跨期補課/逾期未補課獨立區塊**從來沒顯示過**（畫面讀 `lmSummary.crossMakeups` 但 state 沒有）→ 補上。驗證：週三A班 rows 只剩黃勇淳；all 視圖回傳 crossMakeups 10 位。⚠ **跨期/逾期獨立區塊只在「全部課程」視圖（📋 假補總表按鈕）顯示**，點單一課程的「假補」按鈕看不到（單一課程視圖無此兩區）。

- ✅ **假補總表排除工作坊/單堂體驗試上**（`3.98.0-lm-exclude-workshop`，commit 後端＋前端；正式 API 驗證）：工作坊/單堂體驗/試上無請假補課概念 → 排除。①all 端點課程過濾加 `type !== 'workshop'`（體驗 `source:experience` 本就排除、試上 `isTrial` 本就不列為學員）②單一課程 `buildLeaveMakeupSummary` 對 workshop/experience 回 null（route 404）③前端隱藏工作坊課的「假補」鈕。驗證：全部課程假補總表 22 門、運動按摩工作坊已排除。

- ✅ **課程「固定補課到期日」＋小蜘蛛人常態週課統一 9/30**（`3.99.0-course-fixed-makeup-deadline`，commit 後端；正式 API 驗證）：回報小蜘蛛人這期補課到期日應都 9/30，但假補總表散開（各梯結束日不同、+30天→9/19~9/30）。加課程欄位 `makeupDeadlineDate`（固定補課到期日，覆蓋「結束日+天數」）：`makeupExpiryDayjs(course,rules,fallback)` helper 套發券兩處（reconcile/closureCancel）＋假補總表顯示＋getCourses 回傳＋PUT 可編輯＋createCourse 存。**資料**：11 門常態週課小蜘蛛人（排除密集班）設 `makeupDeadlineDate=2026-09-30`＋回填 30 張現有券 expiresAt→9/30。密集班維持結束+30天（使用者選）。⚠ 假補總表「無到期日」列＝該生無補課券（沒請假）＝正常，非 bug。**未做前端表單欄位**（目前靠 API/資料設定；要員工端加開/編輯梯次可設固定到期日再說）。

- ✅ **假補總表跨期補課加「補課期限」欄＋小蜘蛛人前期一次性設 7/31**（`3.100.0-crossmakeup-deadline`，commit 後端＋前端）：`crossCohortMakeups` 原無到期日欄位 → 加 `deadline` 欄，`crossMakeups` 回傳＋假補總表跨期補課段顯示「補課期限」欄＋CSV。**資料（一次性）**：8 筆小蜘蛛人前期跨期補課（范語晨/黃彥凱/陳若僖/吳宇商/吳宇菲/陳宣妙/陳宥希/賴思綺）設 `deadline='2026-07-31'`；青少年班前一梯 2 位（榮謙如/榮謙宇）設 `deadline='2026-08-31'`（2026-07-22 補設，與小蜘蛛人 7/31 不同）。⚠ 一次性寫入、非自動機制（未來新跨期補課無 deadline 除非再設）。

- 📋 **全場次 enrolledCount 對齊（2026-07-22，資料操作）**：應要求把假補總表/課程學員/場次名單對齊——三視圖本就即時讀報名、天生一致，真正會漂移的是**場次儲存 `enrolledCount`**（大量手動補課/停課操作後計數沒同步，影響補課名額閘門）。掃全部 234 場次、重算 enrolledCount＝實際 confirmed+waitlist 非取消報名數（＋waitlistCount），修 **8 個漂移**（多為停課取消場次計數沒歸零＋技巧班週五A 7/17/7/24 差1）。腳本 `scratchpad/reconcile-counts.cjs`（dry-run 預設、--commit 寫入）。之後大量手動異動報名後可再跑一次對齊。

## 目前進度（2026-07-22）— 假補總表併入「前期補課」標記（跨期別補課呈現）
> 三位學員的上期(前一梯)補課需在假補總表呈現。後端 `/health` `3.101.0-lm-prevterm-makeup-note`。
- ✅ **bookedMakeups 併入「前期補課」**（`courses.js` 兩端點）：isMakeup 報名帶 `crossTermNote` 者 → 併入該生「已排補課」欄、標「上期」（不佔本期補課額度）；前端假補總表紫色註記（表格＋CSV）。
- ✅ **黃勇淳**（週三A班）：7/18 週六A補課**改記為前期(5/13)補課**（enrollment 加 `crossTermNote:'上期5/13'`、清 makeupId）→ 本期兩次請假(7/08、7/15)券恢復 available（剩2/共2 尚未補課）；假補總表「已排補課」顯示「7/18（上期5/13）（已上）」。
- ✅ **陳以喬**（小蜘蛛人前一梯）＋**莊孟貞**（青少年前一梯、5/16請假）：上期一次請假**待補課**（未排）→ 建 `crossCohortMakeups` pending_arrange（前期段呈現）；期限 陳以喬7/31（小蜘蛛人前期）、莊孟貞8/31（青少年前期）。⚠ 陳以喬上期請假**日期未提供**、暫標「待確認」（owedDates 空），日後補。

## 目前進度（2026-07-22 續）— 上期補課併入本期欄位（會員）＋停課補課標示
> 承前期補課呈現：現役會員的上期(前一梯)補課改「發本期券、列本期欄位」，非會員留跨期段。後端 `/health` `3.102.0`→`3.103.0`。
- ✅ **closure 補課標「補X停課」**（`3.102.0`）：`bookedMakeups` 對 closure 券的補課顯示補的是哪個停課日（兩端點＋前端 note）。
- ✅ **新券別「上期請假」`source:'prev_leave'`**（`3.103.0`）：`prevLeaveDate` 欄位、`exempt:true`（不佔本期額度）；假補總表 leaves 顯示「日期（上期請假）」、補掉時 bookedMakeups 標「補X上期請假」。
- ✅ **陳威宇**（週一A班）：空號 `2bee9873` 已清（+waiver）；7/17 補課**改記 5/26 上期停課**（5/26 券→used、7/10 券還原待補、剩1/共2），已排補課顯示「補05/26停課（已上）」。
- ✅ **陳以喬**（週六A班）：5/30 上期請假 → 移除跨期紀錄、發 `prev_leave` 券（期限7/31）→ 列本期（剩4/共4，含 5/30 上期請假+7/11停課+8/01請假）。
- ✅ **莊孟貞**（青少年初級班 週六A班）：5/16 上期請假 → 移除跨期紀錄、發 `prev_leave` 券（期限8/31）→ 列本期（剩2/共2）。
- 📌 **原則**：現役會員上期補課＝發本期券（closure 用 `closureDate`、請假用 `prev_leave`+`prevLeaveDate`，皆 exempt 不佔額度）列本期欄位；非會員（吳宇菲/吳宇商 5/26+5/29）留跨期補課(前期)段等認領。

## 目前進度（2026-07-22 續2）— 場次計數確認＋工作坊同日時間排序＋會員/員工補課一致
> 使用者要求再確認所有課程學員場次資訊、工作坊同日場次依時間排、會員端補課資訊與員工端一致。後端 `/health` `3.104.0-session-time-sort-makeup-consistency`。
- ✅ **全場次計數對齊確認**：以 live 語意（`enrolledCount=status==='confirmed'` 數含補課、請假 -1、候補另計 `waitlistCount`）重算 **222 個未取消場次 0 漂移**、已一致。⚠ 慣例備忘：enrolledCount **不含** leave（請假 -1）、**不含** waitlist（另計）、**含** isMakeup(confirmed)；跨期補課(crossCohortMakeups)不進 enrolledCount、由 `_crossBooked` 另計容量。（先前 drift 腳本誤把 leave 算進去→假象 17 筆漂移。）
- ✅ **場次同日依時間排序**（工作坊）：`getSessions` 排序加 `startTime`（原只 date）；前端 4 處日期-only 排序補時間（員工場次列表、會員梯次場次列表/補課候選/我的課程 future）。實例：運動按摩 8/23 五場次 12:00~17:00 依序。
- ✅ **會員↔員工補課資訊一致**：查證兩處潛在不一致——① `getMemberMakeupRights`（會員端）濾過期券，員工假補總表「剩」**不濾**→ 統一員工端 `avail` 也排除過期券（兩端點）；② `getMemberMakeupRights` 對 null 到期日 `.toDate()` 會炸→改 null-safe（null 視為無限期）。目前 30 張 available 券 **0 過期、0 無到期日** 故本就一致；改後未來也保證一致。實測比對陳以喬 會員端 API 3 張＝員工端假補總表 剩3/共3。**補課可補場次**兩端皆走後端 `enrollMakeup` 權威（單向補課類型 3.86.0），前端候選 filter 與後端一致。

## 目前進度（2026-07-22 續3）— 入場新增「友館隊員優惠」（9折，出示證明）
> 承特約廠商優惠：入場加一種**友館隊員優惠**＝全額入場費 ×0.9（成人300→270、學生250→225），自行出示證明、櫃檯查驗（比照特約廠商，只是折扣是率非定額）。後端 `/health` `3.106.0-partner-gym-member-entry-discount`；E2E 打正式 API 通過。
- ✅ **後端**：`pricing.computePaidEntryAmount` 加 `opts.partnerGymMember` 分支（×rate 預設0.9，全票/學生票，兒童不適用）；**互斥優先序 legacy(8折) > 隊員(9折) > 友館隊員(9折) > 特約廠商(−N)**（友館隊員與特約廠商擇一、友館隊員優先）。`getPartnerGymMemberConfig`（systemSettings/partnerGymMember{enabled,rate}，fallback 啟用+0.9）；`verifyEntry` 回 `partnerGymMemberEligible`(每選項)＋`partnerGymMemberRate`；`flow` 串接 createPending/confirm/scan（pending 存 partnerGymMember、掃碼回傳供提示）；`checkin.js` 兩路由參數；`settings.js` GET/PUT `/settings/partner-gym-member`（PUT 限 super_admin/admin，rate 0~1）。
- ✅ **前端**：`MemberQRPage` 付款步驟加「友館隊員優惠（N折）」勾選（與特約廠商**互斥**、勾一個清另一個）＋QR頁摘要「入場費（友館隊員 X折）」＋出示證明提示；`CheckinPage` 掃碼預覽「⚠ 友館隊員優惠（9折）：請出示友館隊員證明」；`SettingsPage` 入場規則加「🧗 友館隊員優惠」分頁（啟用+折扣率，superAdminOnly）。
- **E2E（打正式 API，成人非隊員會員）**：verify `partnerGymMemberRate:0.9`、single/student `pgmEligible:true`；建 QR 成人+友館隊員 pending **amount 270**（原300）、學生 **225**（原250）、不勾 300；`partnerGymMember` 旗標正確、pending 測後清。
- 📌 **與比賽「友館折扣」不同**：比賽 3.77.0 是友館清單+人工核對+0.95（擇優不疊隊員）；此入場友館隊員是**自行出示證明+0.9**（無清單、比照特約廠商自選），兩者獨立。

## 目前進度（2026-07-22 續4）— 工作坊分階段報名＋隊員分級定價
> 需求：工作坊某段時間先開放隊員報名（優惠價），之後開放一般會員（另一價）。決策（AskUserQuestion）：隊員任何時候都優惠價／專屬期只有隊員能報名／只套工作坊。後端 `/health` `3.107.0-workshop-team-staged-enroll`；E2E 打正式 API **8/8**。
- ✅ **課程 3 欄位（僅 workshop 生效、留空＝不限制）**：`teamOpenDate`（隊員報名開放日）／`generalOpenDate`（一般會員報名開放日）／`teamPrice`（隊員優惠價）。createCourse／getCourses／PUT allowedFields。
- ✅ **`enrollCourse` 權威 gate＋計價**（工作坊走 `POST /sessions/:sid/enroll`）：
  - **gate**（`!byStaff` 才限；店員代報不受限）：隊員 today<teamOpenDate 擋；一般會員 today<generalOpenDate 擋（專屬期訊息「攀岩隊員專屬報名期間，一般會員 X 起開放」）。
  - **計價**：工作坊隊員（`isActiveTeamMember`）任何時候報名 → `teamPrice`（存 `teamPriceApplied`）；一般 → 原價。
- ✅ **前端**：會員 `MemberCoursesPage` 工作坊場次卡顯示自己價格（隊員標🏅隊員價、一般顯示隊員價供參）＋未開放「⏳ X 起開放」＋按鈕禁用（依登入者 `member.isTeamMember`）；帶正確 fee 進報名 modal。員工 `CoursesPage` 編輯工作坊加「🏅 分階段報名/隊員優惠價」區塊（3 欄位）＋create/edit submit。
- **E2E（真會員 token，8/8）**：隊員專屬期→隊員201/800、一般擋；兩者皆開→一般201/1000、隊員201/800；隊員未開→擋。fixtures 全清。
- 📌 **範圍**：僅工作坊（type=workshop）；週課的隊員 9 折（enroll-all，既有）與此 teamPrice 獨立。目標即報名對象（家長代非隊員子女→一般價，後端依 memberId 判定；前端顯示以登入者隊員身份為主、後端權威）。

## 目前進度（2026-07-22 續5）— 課程/比賽報名連結（深連結分享）
> 需求：產生可分享的報名連結（比照 BeClass）。純前端 `redrock-web`；課程全梯次＋比賽皆支援。
- ✅ **登入後跳回原網址**（`App.jsx` MemberRoute 未登入導 `/member/login?redirect=<原路徑>`；`MemberLoginPage` 登入後讀 `?redirect=`（限 `/member/` 前綴）跳回）→ 深連結未登入也能用。
- ✅ **課程深連結** `?course=<courseId>`（`MemberCoursesPage`）：課程載入後自動切課程總覽＋開該課報名頁（useRef 只開一次）。員工 `CoursesPage` 梯次列加「🔗 連結」複製 `app.redrocktaiwan.com/member/courses?course=<id>`。
- ✅ **比賽深連結** `?comp=<compId>`（`MemberCompetitionsPage`）：賽事載入後自動開該賽事報名 modal（限 status=open、只開一次）。員工 `CompetitionsPage` 開放中賽事加「🔗 連結」複製 `app.redrocktaiwan.com/member/competitions?comp=<id>`。
- 📌 連結需先是會員（要登入）；家長點連結先到登入頁可註冊。工作坊連結亦適用（會員點進去依隊員身份看價格/開放狀態）。純前端、已部署。

## 目前進度（2026-07-22 續6）— 站台載入加速（api 改灰雲＋端點平行化＋圖表延後）
> 回報站台電腦「今日課程學員」等資訊 loading 很慢。實測後根因＝**網路路徑**（非程式/Firestore）。
- 🔍 **根因**：`/health`（不查 DB）經 Cloudflare 也要 0.85s、直連 Railway 僅 0.28s → **Cloudflare 免費版代理每請求 +約 0.5s**（邊緣→Railway 源站無優化路由）。Firestore 查詢只佔 ~0.5s。
- ✅ **① Cloudflare api 改灰雲（DNS only）**（Claude 用瀏覽器代改、已驗證）：api CNAME Proxy 橘雲→灰雲、直連 Railway。api 解析到 Railway IP（`69.46.46.29`、非 CF 104.x/172.67.x）、TLS 正常、`edge.seen:false`。**每請求 0.85s→0.28s（快 3 倍）**。DDoS 權衡：平時靠 app 層限流（3.68.0）；遇攻擊點回橘雲+Under Attack。⚠️ `EDGE_ENFORCE` 保持關（灰雲時開會全站被擋）。
- ✅ **② 今日課程學員查詢平行化**（`3.108.0`，checkin.js）：sessions 後 enrollments+checkIns+跨期補課 由序列 4 往返改 `Promise.all` 2 往返。
- ✅ **③ 入場頁每日入場圖表延後載入**（純前端 `CheckinPage`）：`requestIdleCallback` 閒置才抓 `monthly-daily-counts`，主內容（今日課程學員/統計）先顯示。
- **實測改善**：今日課程學員 1.7→**0.92s**、今日入場 1.3→**0.70s**、每日入場圖表 1.4→**0.76s**（灰雲+平行化+延後綜合）。
- 📄 `docs/outage-playbook.md` 加第六節「網路架構與 DDoS/延遲權衡」；故障轉移改 Cloudflare（非 Porkbun）改 CNAME、保持灰雲。依賴表 api/DNS 列同步更新。
- ⚠️ **本機/櫃檯舊快取**：Cloudflare 記錄 TTL ~5 分，切灰雲後幾分鐘或重開瀏覽器才走直連。
- ✅ **④ Railway 區域 US West → Singapore（asia-southeast1）**（2026-07-22 當日執行，Claude 用瀏覽器操作）：Hobby 方案即可改單一區域（多區域副本才需 Pro，不需要）。滾動部署（舊 US 撐到新 SG build 好才切、下線極短）。**淨效果全端點快約 2 倍**（怕 Firestore 在美國變慢→實測反而更快）：/health 0.28→**0.12s**、今日課程學員 0.92→**0.41s**、今日入場 0.70→**0.33s**、每日圖表 0.76→**0.35s**。CNAME 目標不變（`fox82bz0.up.railway.app`）、Cloudflare 不用動。⚠️ **Render 冷備仍在 US 區**（要一致可另搬，非必要）。

## 目前進度（2026-07-22 續7）— 公開體驗預約頁（免登入，訪客）
> 承「報名連結」：體驗客群多為非會員新客，登入型連結不適用 → 做免登入公開預約。使用者規格：先轉帳/訪客不建帳號/電話認領/IP限流。後端 `/health` `3.109.0-public-experience-booking`；E2E 打正式 API **10/10**。
- ✅ **後端**（`experienceBookings.js`）：`GET /public-settings`（**免登入**讀 active 課程類型/價格/場館，供公開頁）；`POST /public`（**免登入**建訪客預約：`memberId:null`/`isGuest`/`source:'public'`、**轉帳**、**後端權威計費**不信前端、擋未滿5歲/缺聯絡人/缺末五碼/未同意條款）。`index.js` `publicBookLimiter` **20/時/IP**（防機器人）。`memberService.createMember` 加 `claimGuestExperienceBookings`（註冊時**用電話比對認領**訪客預約→綁 memberId，之後「我的預約」看得到）。
- ✅ **前端**：新增公開頁 `src/pages/public/PublicExperienceBookingPage.jsx`（route `/book/experience`，**MemberRoutes 內免登入**，plain axios 不帶 token）——場館/課程/日期/參加者/聯絡人/轉帳末五碼/同意條款/送出→成功頁。員工 `ExperienceBookingsPage` 加「🔗 公開預約連結」複製 `app.redrocktaiwan.com/book/experience`。
- **E2E（10/10）**：public-settings 回課程/場館；未同意/缺末五碼/缺電話/未滿5歲 全擋 400；建立訪客預約(fee 後端算)、`memberId:null/isGuest/transfer/pending`；同電話 createMember → 預約認領綁定。fixtures 清。
- 📌 **比賽公開報名仍保留在待辦**（較複雜：組別/簽名/計分推送）。訪客體驗**免責現場簽**（線上僅勾同意）。

## 目前進度（2026-07-22 續8）— 柯昀彤額外補課券發放（資料操作）
- 📋 **柯昀彤（member `68edffa2`，0921091550）額外發放 2 張補課券**（入門班 7-8月週一A班 `a5216a13`，gym-hsinchu）：firebase-admin 建 `courseMakeupRights` 2 張——`status:'available'`、**`source:'manual'`＋`exempt:true`**（＝豁免券：不佔請假配額、不被 reconcile 不變量作廢，真正「額外」的兩次，與請假配額券獨立）、`courseId=a5216a13`、`expiresAt` **補課期限 2026-10-23**（課程 endDate 8/24 + 解析後 makeupDeadlineDays 60）。
- ⚠️ **目前無可補場次**：入門班「可補去類型（makeupTypeIds）」只設「入門班」自己、且系統中入門班**僅這一梯**（原課不能補回自己）→ 兩張券暫時無處可補。**使用者拍板：下一期補、沒關係。** 下一期入門班開課有場次（且落在 2026-10-23 前）即可用；若下期晚於 10/23，需將這兩張券 `expiresAt` 往後延（延長前跟使用者確認）。

## 目前進度（2026-07-23 續）— 子會員共同家長機制（coParentIds）＋重複會員清理
> 起因：家長回報同一個小孩被登在兩個家長帳號下（爸媽各建一次）。做「共同家長」讓一筆資料兩個家長都能管，並全庫掃重複清理。後端 `/health` `3.124.0-co-parent`。
- ✅ **共同家長機制 `coParentIds`（子會員可掛多個家長）**：一個小孩原本只能有單一 `parentMemberId`；新增 `coParentIds`（陣列）讓另一位家長也能查看/代操作同一子會員。改兩處（單一真相）——① `GET /members/my/children`：`parentMemberId==me` **併** `coParentIds array-contains me`（去重）② `checkMemberOwnership`（`utils/memberOwnership.js`）：`target.parentMemberId===me || coParentIds.includes(me)` 才放行。**兩家長皆可報名/請假/補課/退費/轉移/入場代操作同一小孩，資料統一不重複**。設共同家長＝`members.<childId>.coParentIds arrayUnion(另一家長id)`（firebase-admin）。
- ✅ **重複會員清理（firebase-admin，掃「同姓名＋同生日」分組）**：
  - **廖彥澄／許宸碩**（許哲嘉父0918620673 vs 廖家嘉母0937124706）：兩小孩各兩筆，父帳號下有料（各9報名/2補課券/1入場、7/17建）、母帳號下空（7/21建）→ **留父帳號有料那筆＋把母設為 coParent＋刪母帳號空重複**。
  - **黎芷芸**（VIP family，爸媽各建、皆VIP）：留有料 `52553e4c`（入場1）＋加共同家長 `4b9d1f7d`＋刪空 `8644e8bb`。
  - **謝明伶**（重複主帳號，電話差1碼/email差大小寫＝同一人打錯註冊兩次）：刪空 `65b3e677`、留有料 `cb669ab1`（入場2/卡1）。
  - **周鄺宏**（重複主帳號，nagisa信箱未驗證19:29建→3分鐘後elaine信箱驗證19:32建並19:45入場＝廢棄第一次註冊）：刪空未驗證 `c5fc1617`、留有料 `cb68961f`。
  - **刪前一律確認空**（courseEnrollments/checkIns/courseMakeupRights/memberPasses/discountCards/legacyBlackCards/singleEntryTickets 皆0才刪）。有效會員數因刪 5 筆重複而減 5。
- 📌 **重複掃描法（日後複用）**：全 members 依「姓名+生日」分組取 count>1；每筆查各集合資料量標「⬜空/✅有料」＋家長/電話/email/建立時間/emailVerified → 空的通常是重複空帳號、有料的保留；子會員雙親情況改 coParent（非刪），成人重複主帳號刪空的。

## 目前進度（2026-07-23 續）— 本人不入場流程（家長只建家庭成員）＋?sim= 自動登入 race 修復
> 需求：很多家長自己不入場、只幫小孩建資料。onboarding gate 加「本人不入場」選項→略過本人簽署→直接建家庭成員；入場 QR 家長反白；日後可重啟。後端 `/health` `3.123.0-self-entry-skip`。
- ✅ **`selfEntrySkipped` 旗標＋端點**：`POST /members/my/skip-self-entry`（設 true）／`/my/resume-self-entry`（設 false，重啟）；`/auth/member/me` 回 `selfEntrySkipped`。與 `fallTestScheduleSkipped`（3.66.0，階段二排測跳過）**是兩個不同旗標**。
- ✅ **onboarding gate（`MemberOnboardingGate`）**：`if (member?.selfEntrySkipped) return children` 直接放行；**階段一（兩大方框）底部**加第三選項「🙋 本人不入場，前往建立家庭成員」→ 確認彈窗 → `skip-self-entry` → `updateMember({selfEntrySkipped:true})` → 導 `/member/profile?family=1`（自動展開家庭成員面板）。⚠ 兩個「不入場」選項**不同階段、不會同畫面**：階段一＝本人不入場（連簽都不用簽）；階段二排測畫面＝「我不入場攀爬，暫不安排」（已簽兩份、只跳過排測）——使用者確認兩個都留。
- ✅ **`MemberProfilePage`**：`?family=1` 自動開家庭成員面板；`selfEntrySkipped` 時頭像卡下顯示琥珀橫幅「🙋 本人目前設定為不入場」＋「重啟入場文件簽署 →」（**確認彈窗**後 `resume-self-entry`→回首頁 gate 重新要簽）。
- ✅ **`MemberQRPage`**：入場人員選擇器對 `selfEntrySkipped` 的**家長本人反白不可選**（標「（本人不入場）」）＋入場對象**預設落在第一個家庭成員**。
- ✅ **兩入口都加確認彈窗（防誤觸）**：「本人不入場」與「重啟」按下都先跳確認、可取消；且**雙向可逆**（不入場↔重啟互切）。
- ✅ **驗證「家長不入場不影響幫小孩處理事務」（E2E 5/5）**：封鎖家長（`selfEntrySkipped`+`isBlocked`）幫小孩**報週課 201／報比賽 201／請假 200／登入正常**。根因：全系統**只有 `enrollCourse`（工作坊）檢查 isBlocked，且對象是 `getMember(memberId)`＝報名對象（小孩）非登入家長**；enroll-all／比賽／請假補課皆不檢查 isBlocked；無全域擋封鎖會員的中介層。所以家長 blocked 完全不影響代小孩操作。
- 🐞 **順修：`?sim=` 自動登入 race（前端，影響本人不入場測試連結＋模擬報名 deepLink）**：`MemberRoute` 在會員資料載入前（member=null）就 `Navigate` 去 `/member/login`，且導向後 `sim` 被包進 `redirect` 參數 → `params.get('sim')` 抓不到 → 卡登入頁。修：`memberStore` 於 **useState 同步初始化**時（首次 render 前）就把 `?sim=` token 寫入 localStorage 並設 `simResolving=true`；`/auth/member/me` 載完才 `setSimResolving(false)`；`MemberRoute`：`if (simResolving) return null`（先等、不導向）。→ deepLink（本人不入場測試、模擬報名）在無會員 session 的瀏覽器也能正常自動登入進頁。

## 目前進度（2026-07-24）— 員工入館QR pending sweep + 歷史/銷售區間查詢 + 下載明細/財務/結帳/設定權限收緊
> 一輪權限與查詢調整。後端 `/health` `3.125.0`→`3.127.0`；live smoke 驗證通過。
- ✅ **員工入館QR pending 排程 sweep（`3.125.0`，commit `d328055`）**：`staffEntry.js` 加 `sweepStaleStaffEntries`（每 30 分清 `pendingStaffEntries` 已過期/已使用者，self-contained setInterval＋global 旗標）；順手清當時 10 筆過期殘留。掃碼端本就擋過期，這只清底層垃圾。
- ✅ **歷史入場改區間查詢＋CSV（`3.126.0`）**：員工入場→歷史入場 由單日改「從～到」兩個 date picker（預設起訖=今天）；後端 `/checkin/history` 本就支援 `dateFrom/dateTo`，區間查詢上限 2000→**10000**；CSV 涵蓋整區間（檔名帶區間）。
- ✅ **銷售紀錄改區間查詢＋CSV（`3.127.0`）**：`SalesPage` 銷售紀錄由「近30天」改「從～到」（預設近30天）；後端 `/products/sales` 加 `dateFrom/dateTo`（優先於 days，上限 10000）；CSV 匯出**限管理員**（isAdmin，客戶端生成故隱藏按鈕＝enforcement）。
- ✅ **所有下載明細限管理員/系統管理員（除比賽名單/課程名單/假補名單）**：後端各匯出端點加 `requireManager`（super_admin/gym_manager；operator/full/part 皆擋）——`members/download`、`experience-bookings/download`＋`insurance-download`、`daily-settlements/monthly-export`＋`invoice-export`、`revenue/export-csv`＋`export-adjustments-csv`＋`export-checkin-csv`、`pass-adjustments/analytics/download`（原 requireManagerOrStation）、`team/members/download`（原 requireManagerOrStation）、`products/export`。**三例外不動**：比賽 `competitions/:id/registrations/download`（competitions.manage）、課程 `courses/:id/attendance/download`（courses.manage）、假補 `courses/leave-makeup-summary`（courses.view）。前端隱藏非管理員的下載鈕（歷史入場CSV/體驗名冊/保險/卡券統計/庫存匯出/隊員名單；MembersPage 下載本就已 manager-gated）。
- ✅ **財務＋結帳歷史限管理員（館別電腦也不行）**：財務（revenue.* 端點）本就 `revenue.report`＝{super_admin,gym_manager}、不在 COUNTER_PERMS→operator 進不了（已符合）；結帳歷史列表 `GET /daily-settlements/` 由 `authenticate`→`requireManager`（前端 `DailySettlementPage` 歷史 tab 本就 isAdmin-gated；順修 operator 進頁時不再誤呼叫 loadHistory）。nav 的 財務/結帳 本就 manager/station gated。
- ✅ **設定：僅新增/修改公告開放場館電腦＋正職員工，其餘限管理員**：`SettingsPage` 入場類型/Waiver/墜落測驗/岩鞋租借 4 個原本無 flag（人人可見）改 `managerOnly`（isManagerPlus＝super_admin/gym_manager）；預設分頁對非管理員自動切到第一個可見（＝場館公告）；`canOwnGymAnnounce` 加 `full_time`；`StaffLayout` PERSONAL_NAV.full_time 加 `/staff/settings`（否則正職個人帳號 nav 看不到設定）。**後端**：公告新增/修改 gate `requireManagerOrStation`→新 `requireAnnounceEditor`（管理員/場館電腦(operator·station)/正職(full_time) 皆可，part_time 擋；休館/特殊時間仍受 announceTypeGuard 限管理員；DELETE 不變）。
- **Live smoke**：super_admin 結帳歷史/會員下載/銷售區間/歷史入場區間 皆 200；站台 token 打 結帳歷史/會員下載/卡券統計下載 皆 **401 擋下**。commit 後端 `3.127.0`、前端已 deploy。

## 目前進度（2026-07-24 續）— 結帳摘要加現金清點 + 體驗預約寄信（報名+確認雙信、cc 該館）
- ✅ **結帳摘要加「現金清點」（點鈔明細）**（純前端 `DailySettlementPage`）：`SettlementSummary` 原只顯示「實際現金」總額 → 改「現金清點」區塊逐面額列出（`NT$1,000 × 3　NT$3,000`…只列 count>0）＋底部實際現金合計；無點鈔資料退回顯示總額。三處摘要都套用（歷史紀錄展開／今日已結帳／完成結帳確認 modal），資料取各筆 settlement 存的 `denominations`（本就存、只是摘要沒顯示明細）。器材租借本就在「總金額分項」cats（3.84.0），未變動。
- ✅ **體驗課程「報名當下寄繳費通知信」＋「確認信」雙信、皆 cc 該館**（後端 `/health` `3.128.0-exp-booking-received-email`）：
  - **報名收到信（新）**：`emailService.sendExperienceBookingReceived`——`POST /experience-bookings` 建立成功後寄給聯絡人（`contactEmail`），含 日期/時段/館別/人數 ＋ **應繳總額＝`booking.totalFee`**（級距價格「**已含保險**」，⚠ **不另加收 175/人**）＋ **該館匯款帳號**（讀 `systemSettings/experienceCourses.bankInfo[hsinchu|shilin]`）。信中標「N 人 × 每人單價，費用已含保險 `N×175`」（保險僅標示、不加總）。非同步、失敗不阻斷 201。
  - **確認信（原有，保留）**：`sendExperienceBookingConfirmation`（`POST /:id/confirm` 三處：試上兩分支＋一般）確認收款後寄。
  - **兩封都 cc 該館 email**：讀 `gyms.<gymId>.email`（新竹 `redrocktaiwan.hc@gmail.com`／士林 `redrocktaiwan@gmail.com`，3.91.0 建的欄位）；`sendExperienceBookingConfirmation` 加第 4 參數 cc、received 信 opts.cc。
  - **範圍**：只做一般體驗預約（general）；試上（trial）確認信本就有、不加報名收到信（試上另有發券流程）。
  - ⚠️ **金額修正（`3.128`→`3.129`→`3.130`）**：初版誤把保險當「另加收」（總額＝課程費＋175/人），錯報高 175/人；**修正＝級距價格本就含保險**，應繳＝`totalFee`。**體驗保險 175/人是「含在級距價內的代收」、非外加**（對照 3.48.0 發票金額＝總費−人數×175 的代收邏輯）。`3.130` 信中加標每人單價＋已含保險金額。commit 後端 `3.128`/`3.129`/`3.130`（前端無變動）。
- 📋 **實際操作：建立士林館 9 人團體體驗預約（鄒竣有團）**：士林館 2026-07-26 10:00–12:00、9 人（general，6–12 人級距 **775/人 × 9 ＝ 6,975，已含保險 9×175＝1,575**、應繳 6,975）、聯絡人 鄒竣有/0930303729/Vaneas0720@gmail.com、walk-in（memberId:null）、轉帳 pending。功能上線後「刪除+重建」補觸發繳費通知信（寄客人＋副本士林）；現行 id `exp_1784884341572_r47h`。⚠ 過程中第一封補寄信金額誤報 8,550（保險外加）、修正後補寄 6,975（含保險）＝客人收到 2 封、以第 2 封為準。⚠ walk-in 團體體驗＝`memberId:null`（Firestore 不吃 undefined，API 要顯式帶 `memberId:null`）；bookingTime 格式 `HH:MM-HH:MM`。

## 待辦
- 🔧 **【比賽部分暫緩】公開報名頁（免登入）**：讓非會員也能用連結預約/報名。規格已定：**先轉帳**（填末五碼→員工端待收款確認）、**訪客不建帳號**（存 guest 預約、無 memberId）、**之後註冊用電話認領**（沿用現有認領機制）、**IP 限流**（比照註冊）。①**體驗** ✅ 已完成（見上方續7）②**比賽**（待做） `/register/competition/<id>`（複雜：組別/早鳥兒童費/**免責簽名本人+法代**/推計分系統）——**待拍板**：比賽免責簽名要公開頁當場簽(A) 還是報名後補(B)。想做時從這開工。

- 🛡 **DDoS 防護現況（2026-07-22 更新）：api 已改灰雲（直連 Railway、快 3 倍），`EDGE_ENFORCE` 保持關**。原 2026-07-20 橘雲+EDGE_ENFORCE 因延遲（每請求+0.5s）與營業中斷回退 → 定調平時走**灰雲+app 層全域限流**（3.68.0）。**遇 DDoS 才恢復邊緣防護**：Cloudflare 把 `api` 點回橘雲 → Security 開 Under Attack Mode（攻擊過再點回灰雲）。⚠️ **`EDGE_ENFORCE=true` 只在 api 橘雲時能開**（靠 Transform Rule 注入 `X-Edge-Auth`）；**api 灰雲時務必保持 `EDGE_ENFORCE=false`**，否則直連無 header 會全站被擋。`EDGE_SECRET` 存 Railway+Cloudflare Transform Rule+Render（三處備妥、Render 端 enforce 保持關）。完整見 `docs/outage-playbook.md` 第六節。
- ⏰ **【待使用者確認】比賽「已駁回」首頁通知消失機制**：目前設「駁回後 14 天自動消失」（時間窗、無已讀鈕，見續13）。使用者說先維持、**之後要主動提醒他確認**是否調整（可選：改天數／加「知道了」關閉鈕需存已讀旗標／重新報名同賽事後消失）。下次談比賽通知時提出。
- 🔧 **【選做】比賽退費申請審核**：真正已繳費的退費申請，管理員可「退回給會員修正退費資訊」（退費帳號錯）/「駁回退費申請」（依政策不退）。本輪確認暫不做（無實際案例）；要做時後端加 `return-refund`/`reject-refund` + 會員端修正退費資訊 UI + `/my/alerts` 通知。
- 🛡 **Railway 應變**：①②③④ **全部完成**（2026-07-17 ④ Render 冷備上線）。長期：金流上線前評估遷 Cloud Run。

- 🖨 **【架構已定，待硬體】發票機串接（WP-560 二聯式）**：完整設計見 `docs/invoice-integration-plan.md`。決策全鎖定（實體二聯/本地代理/後端計數/收款當下開票/選填統編/退費只作廢/驅動錢櫃/退費報表/Windows）。**下一步 P1**：使用者買舊發票機＋RS-232轉USB＋二聯練習紙捲到位後，寫**本地代理骨架**（Node+serialport+express+開機自啟）＋ ESC/POS 列印/開櫃/**定位試印校正**（技術風險點先過）→ 再往上號碼管理→共用元件→四頁接線→結帳自動化→退費報表。
- 🔧 **【選做，2026-07-19 討論後暫緩】補課期限模式 B「請假日後 N 天」**：長期數（小蜘蛛人 9月~隔年1月）用「課程結束後 N 天」會讓 9 月的假拖到隔年 2 月才補 → 班別/梯次加「補課期限模式」下拉（A=課程結束後 N 天（現行）／B=請假堂日期後 N 天），天數共用 makeupDeadlineDays。**配對規則（已定案）**：不變量重算模型券不綁定特定請假 → 有效請假日期排序、跳過已用張數、剩餘可用券依序對應剩餘請假日＋N 天，每次 reconcile 重新配對；停課券＝停課堂日期＋N。現有 7-8 月券不受影響（預設 A）；9 月新期開班前把小蜘蛛人切 B。
- 🔧 **【選做】週課「候補→正取」自動遞補**：目前整門課候補遞補為手動（店員），可比照 per-session `promoteWaitlist` 做整門課版（有人退課/取消時自動遞補第一位候補、通知並轉為待收費）。
- 🧹 **一A `小蜘蛛人一A(7-8)閎`（`3f35216f`）**：使用者說「之後會刪除」自行處理（朱智萩報名在此門，刪前留意）。
- ✅（已完成 2026-07-11）**刪除測試會員**：21 筆 fixture 已硬刪、票券一併清、0 孤兒；**王大明與全部真實會員保留**（見上方 2026-07-11 進度）。原 7/14 提醒作廢。
- 各館申請 LinePay / 街口 / 台灣Pay 商戶 → 金鑰填入各 gym 的 `paymentSettings`
- LinePay sandbox 端到端測試 → 啟用線上付款 + 員工端 QR 前端
- 補街口 / 台灣Pay adapter 的 API TODO（依整合手冊 / 收單銀行）
- 資料移轉（Climbio 18,000+ 筆）——**墜測對照已完成**（2026-07-13：`legacyFallTests` 17,335 筆＋隊員名單 41 筆，新註冊自動認領）；會員基本資料不預先匯入（採「註冊時認領」模式，會員自行註冊＋重簽文件）
- ✅（已完成 2026-07-04 六）站台隊員 9 折端到端實測 → 見上方進度；**真站台帳號實機亦可直接做**（館別電腦帳號經 `/stations/login` 實測有效，見上方修正），後端邏輯已由 super_admin 打 `/checkin/phone` 等價驗證通過
- 會員端 UI 驗證：課程試上分頁 + 場次代班「（代班）」顯示（需會員帳號登入實測）
- 「試上人數」目前僅由試上報名流程產生 `isTrial` 名單；如需員工手動加試上者，需另做 UI
- 清理 dev Firebase 殘留測試會員：`【練習】…` 系列、`測試/測試API會員/管理員測試會員/Test1/Who` 等，以及測試用 `王大明`(0900222222)/子帳號 `小明明`；可用員工端「刪除會員」或 `DELETE /members/:id`（super_admin）清除（會一併刪子帳號、保留歷史紀錄）
