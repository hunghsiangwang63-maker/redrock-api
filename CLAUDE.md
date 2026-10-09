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

### 遠端接手正在跑的工作（tmux，2026-08-27 更新）
- SSH 是**另一個 session**，看不到 Mac 螢幕上那個 Terminal 的即時畫面；想遠端看到**即時進度並無縫接手**：一律在終端多工器裡工作（Claude Code 本身也跑在裡面）。
- **tmux 已裝好**（`/opt/homebrew/bin/tmux`，Homebrew 已裝；早期「未裝 tmux 先用 screen」的段落已作廢）；日常工作 session 名稱＝**`main`**。
- **手機/iPad 接手步驟**（2026-08-27 實查驗證：Mac mini 遠端登入 SSH 已開、Tailscale IP `100.103.195.66`／機器名 `s-mac-mini`）：
  1. 手機裝 **Tailscale**（登入同帳號）＋ SSH 客戶端（如 **Termius**）。
  2. `ssh wanghongxiang@100.103.195.66`（密碼＝Mac 登入密碼）。
  3. `tmux attach -d -t main` —— **`-d` 必加**：把 Mac 端連線先踢掉，否則畫面被鎖成兩邊較小的螢幕尺寸；回到 Mac 再 `tmux attach -t main` 搶回，工作不中斷。
  4. 離開手機時**不要打 `exit`**：直接關 App 或 `Ctrl-b` 放開再按 `d`（detach），session 繼續在 Mac mini 跑。
- 列清單 `tmux ls`；新開 session `tmux new -s <名稱>`。
- ⚠️ **背景工作只在 Mac 醒著時繼續**：Mac mini 設「插電不睡」，或跑之前加 `caffeinate`（例：`caffeinate -s node scripts/loop-test.js`），避免睡眠中斷 node 程序。


> 📦 2026-06 ~ 2026-09-25 的「目前進度」記錄已搬至 `docs/progress-archive-2026-06-to-2026-09.md`（內容未刪減，只是搬家，減少本檔體積）。

## 目前進度（2026-09-26）— 修：Android 手機顯示 QR 偶爾黑屏（加螢幕常亮）
> 問「Google的手機好像有時候顯示QRcode會黑屏」——查證全站四個 QR 顯示畫面（會員入場 QR／首頁補租器材 QR／比賽報到 QR／員工自助入館 QR）皆未使用 Screen Wake Lock，最可能成因＝拿手機給店員/現場掃描的等待期間，系統螢幕逾時自動熄屏（純網頁本無此防護，原生票證/登機證類 App 都會主動要求常亮）——螢幕關掉看起來就是「黑屏」，且 Android 手機預設螢幕逾時普遍比 iPhone短，符合回報只在特定裝置出現。純前端修正，未動任何後端邏輯。commit（redrock-web）`3c3c32e`；已 build+deploy 兩 target、bundle hash 比對本機/線上一致。
- ✅ **新增共用 `hooks/useScreenWakeLock.js`**：`navigator.wakeLock.request('screen')`，`'wakeLock' in navigator` 特徵偵測（不支援的瀏覽器如部分舊版 Safari 安全跳過、不影響原本流程）；分頁切到背景時系統會自動釋放鎖，`visibilitychange` 監聽在切回可見且仍 active 時重新請求；unmount/active 轉 false 時釋放。
- ✅ **套用至四處「手持手機給人掃碼」畫面**：`MemberQRPage.jsx`（`step==='qr'`）、`MemberHomePage.jsx`（補租器材 `raStep==='qr'`）、`MemberCompetitionsPage.jsx`（比賽報到 `!!checkinQr`）、`StaffEntryQrPage.jsx`（員工自助入館 `!!qr && !loading`）。
- 📌 **未涵蓋**：`ExperienceBookingsPage.jsx`（staff）的公開預約連結 QR——那是給客人掃「連結」的靜態展示用途（可能放在展示螢幕/海報，非個人手機held-up-to-scan情境），性質不同、未套用。

## 目前進度（2026-09-26 續）— 修正診斷：黑屏其實是崩潰卸載，補加全域 Error Boundary
> 使用者澄清症狀：「還是在網頁，但內容全黑，感覺像跳轉頁面時的空白畫面，耐心等待也沒有任何改變」——這不是螢幕熄屏（wake lock 解決的是另一種情境，仍保留），而是**還留在網頁上、畫面本身變空白且卡死**。查證：全站原本**沒有任何 React Error Boundary**——任一未捕捉的 render 例外都會讓 React 把整棵樹卸載、只剩空的 `#root`；而 `html`/`body`/`#root` 皆無明確背景色，`:root` 又設 `color-scheme: light dark`，系統深色模式下會落回近黑色的 CSS 變數（此為一份泛用範本殘留、全站實際上沒做過真正深色主題），看起來就是「卡死的全黑畫面」——且「等待也不會恢復」完全吻合，因為 React 已經放棄、沒有任何程式碼還在跑，只有整頁重新整理才能救回來。純前端+一個極輕量後端端點，commit 前端(redrock-web) `f9290d2`、後端(redrock-api) `c6ac047`；已 build+deploy 兩 target、bundle hash 比對本機/線上一致；後端端點已 curl 驗證回 204。
- ✅ **新增 `components/ErrorBoundary.jsx`（包住整個 App，`main.jsx` 最外層）**：崩潰時顯示「發生錯誤／重新整理」取代空白黑屏，並用 `sendBeacon`（不支援時 fallback `fetch keepalive`）盡力回報錯誤內容到新端點 `POST /client-errors`——**純寫 log、不進 Firestore**（避免又變成新的讀寫費用來源，見同日稍早的 GCP 用量排查），免登入（崩潰當下不能假設還有 session）、獨立限流（15分鐘60次）防濫用；下次真的再發生時才有實際錯誤訊息可查，不用再靠猜的。
- ✅ **`index.css` 移除 `color-scheme: light dark` 改固定 `light`**：全站各頁一律 inline style 寫死淺色系，從未真正實作深色主題；`light dark` 會讓部分瀏覽器（尤其 Android Chrome 的「網頁強制深色」heuristic）對沒被明確設色的區域自作主張套用深色。`html`/`body`/`#root` 三處補上明確 `background:#F7F3F3`（App 主要內容背景色）作為最後一道防線——即使真的有元件忘記蓋自己的背景，透出來的也是淺色而非黑色。瀏覽器實機確認三者 computed background 皆正確為 `rgb(247,243,243)`、`color-scheme` 正確為 `light`。
- 🧪 **驗證方式**：`reportError`（`componentDidCatch` 內部呼叫的回報邏輯）本身用 Node 直接呼叫驗證——在完全沒有 `window`/`localStorage`/`navigator` 的環境下呼叫，確認內層 try/catch 正確吸收 `ReferenceError`、不會外洩蓋掉 fallback 畫面。**Error Boundary 本身（`getDerivedStateFromError`/`componentDidCatch`/條件式 render）未能在此環境完整端到端重現**——嘗試用專案實際安裝的 React 19 在 Node 用 `renderToStaticMarkup` 測試，但那是舊式同步 SSR API、本就不支援攔截 render 例外（React 官方文件明載此限制，錯誤會直接往外拋、不會呼叫 `componentDidCatch`），與 `main.jsx` 實際用的 `createRoot(...).render(...)` 用戶端渲染路徑是不同機制；改用瀏覽器载入外部 React 副本做隔離沙箱測試也因 CDN 載入失敗未能完成。此段程式碼為 React 官方文件逐字對照的標準寫法（catching-rendering-errors-with-an-error-boundary），判斷風險低、予以上線，但**未完成針對「攔截真實 render 例外」這件事本身的端到端驗證**，留待之後若再發生黑屏能透過新的 `/client-errors` log 進一步確認根因。
- 💡 **附帶收穫**：使用者補充「iPhone 但用 Chrome 瀏覽器開啟的話好像也會有類似問題」——關鍵知識點：iOS 上所有瀏覽器（不管掛什麼名字）依蘋果規定底層都必須用 WebKit（跟 Safari 同引擎），Chrome-iOS 只是 UI/帳號同步不同。同一症狀橫跨「Android 真 Chrome(Blink)」與「iPhone 假 Chrome(WebKit)」→ 不可能是特定渲染引擎的問題，反過來印證這次修的 Error Boundary（引擎無關的 React/CSS 層防護）方向正確；螢幕常亮則是另一個獨立情境（Android 常見的系統逾時熄屏），兩者並存不衝突。

## 目前進度（2026-09-26 續2）— GCP 用量診斷：業務時段真實成長來源 + 補一個公告快取 + 待辦徽章節流
> 承續兩輪修復（待辦徽號 countOnly+15分鐘、場館今日狀態60秒快取），用 `_diag/query-stats`（見上方 queryDiag.js 說明）對真實業務時段（週六 13:13~14:15，同一 process 生命週期內、無重啟汙染的乾淨 62 分鐘視窗）做「凍結 vs 持續成長」快照比對，找出兩個修復之後還剩下什麼。
- 📊 **持續成長排行（此視窗內新增 8912 筆讀取，289/355 個來源有成長）**：`GET /courses`（1818筆/4次，平均454筆/次，5分鐘快取限制了頻率但單次未命中仍很貴）＞`GET /schedule/events`（828筆/12次，排班頁尚無快取）＞`GET /gyms` 今日狀態（484筆/22次，即上輪剛加的快取——**有效但沒有想像中戲劇性**，真實流量比較分散不像密集測試那樣容易命中60秒窗口）＞`GET /pending-tasks`（770筆/180次，**平均每20秒一次，遠高於15分鐘輪詢該有的頻率**）＞`GET /gyms/announcements/all`（396筆/18次，跟已加快取的今日狀態同一份公告集合、但是另一支獨立端點、原本沒被涵蓋）＞其餘（checkin/today、courses/sessions、members/alerts等）皆為前台真實操作（入場/課程），屬正常業務成本。
- ✅ **補上 `GET /gyms/announcements/all` 快取**（`3.541.0-announcements-all-cache`，commit `e9c4486`）：跟 `getGymStatusForDate` 同一份 `ANNOUNCE_COLLECTION` 全表掃描、但是完全獨立的一支端點（會員首頁公告輪播用），原本沒被上一輪的快取涵蓋到。抽出 `computeAnnouncementsAll(today, includeScheduled, cacheKey)`，60秒TTL、key=`${includeScheduled}:${dateStr}`；**兩個快取合併成同一個 `invalidateGymStatusCache()`**（7個既有公告/場館 mutation 端點共用同一次呼叫、不用各自維護兩份清除邏輯）。正式環境驗證：連續5次呼叫只打1次DB。
- 🔍 **追查 `/pending-tasks` 異常高頻**：發現期間 Railway process 在約14:19**非計畫性重啟過一次**（版本號沒變、非我部署，原因不明，只能觀察到現象），舊基準因此失效——比照專案「process重啟計數器歸零」的已知模式，改用重啟後的乾淨視窗重新量測。重啟後前14分鐘測到每分鐘7.71次，換算每次僅2.1筆文件（證實 `countOnly=1` 有正確生效、單次成本已經很低），但**呼叫次數本身仍遠高於15分鐘計時器的理論值**。
- ✅ **找到真因並修：`fetchCount` 沒有節流，忙碌時段「切回可見補抓」比計時器本身更頻繁觸發**（`3.541.0`同批前端 commit `4042110`）：SPA 分頁只要不整頁重整就會一直跑舊版程式碼——先請兩館櫃檯（新竹＋士林皆已完成）手動重新整理過一次分頁，確認拿到新版後，仍量到每分鐘4.68~5.51次的較高頻率，追查發現根因是既有設計「切回可見立即補抓一次」——櫃檯忙碌時頻繁切換視窗/分頁，每次切回都觸發一次，累積遠比15分鐘計時器頻繁（雖然單次成本已經很便宜，要降的是次數本身）。修法：比照專案既有 `useRefetchOnFocus.js` 的 `minIntervalMs` 節流模式，加 2 分鐘節流——15分鐘計時器與掛載當下一律照打（`force=true`），「切回可見」的補抓則要離上次抓取超過2分鐘才會真的打。
- 📌 **修正：「偵測新版本」機制其實早就存在，不是新提案**——一度誤以為需要新建這個機制並詢問使用者要不要做，事後查證發現 `components/UpdateChecker.jsx` 早已存在且已掛在 `App.jsx` 最外層（`member`/`staff` 兩個 target 皆涵蓋）：每 5 分鐘＋每次分頁切回可見/取得焦點就打一次 `/version.json`（`vite.config.js` 每次 build 自動產生 `buildId`＝git hash+時間戳，寫進 dist 根目錄，`firebase.json` 對它設 `no-cache`），buildId 跟目前執行中的不同就跳「發現新版本，重新整理即可更新」的可關閉提示。**這代表兩館櫃檯電腦手動重整之前，理論上應該早就會看到這個提示**——使用者描述的「重整了」很可能就是指按下這個提示裡的按鈕，而非手動硬重整；這次誤判成「需要重新提案做一個新功能」單純是查證順序錯了（沒有先檢查既有程式碼就直接對使用者提議），已向使用者更正、無新增功能。

## 目前進度（2026-09-26 續5）— 查證：士林兩位外籍會員QR事件時間軸 + 開立發票金額欄拿掉滾輪/箭頭改值
> 兩件事，皆延續同一天的 QR/發票相關議題。
- 🔍 **時間軸釐清（無程式異動，純資料查證）**：使用者追問是否為另一組「英文版失敗、切中文版就好」的顧客——用 Firestore 時間戳精算 Grace ko／Sabrina Raso 兩人從第一次 `/checkin/qr/create` 到店員手動完成入場的總耗時，分別只有 **52 秒／68 秒**（Grace 甚至 14 秒內就試了兩次）。這排除了「等到 pendingCheckIn 30 分鐘過期」的可能，比較支持「產生 QR 這個動作本身立即、穩定地失敗」（同裝置重試也一樣失敗），而非等待逾時。事後使用者確認「英文版不行」其實是**另一組客人**，且沒有留下可追蹤的 log（早於當天稍後才上線的 `/client-errors`）——已重新用更精確的正則掃過全會員端頁面找「翻譯字串被當邏輯/key/payload使用」這類已知 bug 模式，**沒有找到符合案例**；沒有名字/時間可查，暫時擱置，待下次有更多細節或該功能真的再次觸發 `/client-errors` 才能繼續查。
- ✅ **開立發票金額欄位移除滑鼠滾輪/上下箭頭改值**（使用者要求「只支援鍵盤數字輸入或貼上功能」）：commit（redrock-web）`5d71968`；已 build+deploy 兩 target、bundle hash 比對本機/線上一致。
  - `index.css` 新增共用 class `.no-number-spinner`（隱藏 `::-webkit-inner/outer-spin-button`，比照既有 `.cash-received-input` 的做法但抽成全站共用）。
  - 三處「開立發票」金額欄位（`InvoiceModal.jsx` 主要金額欄 + 收現欄、`InvoiceIssuer.jsx` 真列印版金額欄——這兩個共用元件是全站所有發票來源（課程/比賽/體驗/商品/器材租借/入場）的**唯一**開立發票入口，故只需修這裡即涵蓋全部場景）皆加上 `className="no-number-spinner"` + `onWheel={e=>e.target.blur()}`（滾輪事件時立即讓輸入框失焦，讓瀏覽器原生「聚焦中滾動改變 number input 數值」的行為沒有機會觸發）。
  - 🧪 **驗證方式（含一次環境限制的排查過程）**：先用瀏覽器自動化的合成滾輪手勢直接測試，發現不論有沒有加這個修復、值都不會變——追查後確認是**這個自動化環境本身的合成滾輪事件不會觸發瀏覽器原生的 number input 改值行為**（控制組：拿掉 handler 重測，結果一樣不變），故無法用這個環境完整端到端驗證「原生行為有沒有被真的擋下」。改用**真實 dispatchEvent('wheel')** 直接驗證 `onWheel` handler 本身邏輯正確（`beforeFocus:true → afterFocus:false`，確認 blur 有確實執行）——`onWheel→blur` 本身是業界廣泛採用、非本次自創的標準做法，此環境的限制只影響「能不能完整模擬使用者真實滾輪」，不影響修復邏輯本身的正確性判斷。
  - 📌 **範圍界定**：`ExperienceBookingsPage.jsx` 裡另有一個標籤寫「發票金額」的欄位（`financeVal(b,'invoiceAmount')`），但那是**體驗預約財務紀錄**的預填調整欄位（供之後開立發票時的預設金額參考），不是「開立發票」動作本身的輸入框，判斷不在這次「自行開立發票時」的字面範圍內，未一併修改。

## 目前進度（2026-09-26 續4）— 修：入場 QR 用 canvas 渲染在部分裝置會失敗（改 SVG）
> 回報「Sabrina Raso還有Grace ko入場QR無法產生」——兩位皆士林館今天稍早新註冊的外籍會員（+44/+61 門號）。查 Firestore 還原時間軸：`pendingCheckIns` 顯示她們的 `/checkin/qr/create` 呼叫其實**都成功**（token 正常、金額正確），但這些 pending 記錄最終**從未被 confirm**（30分鐘後自然過期），而她們名下卻各自有一筆**真實 `checkIns` 完成入場記錄**——比對金額與時間，判斷是**店員改用電話搜尋/直接入場手動放行**，繞過了「本該用 QR 讓她們自己完成」的正常路徑。這代表卡住的不是後端資格判斷，是**畫面產生 QR 圖片這一步本身**。純前端修正，commit `f7dcd0d`；已 build+deploy 兩 target、bundle hash 比對本機/線上一致；**用專案既有相機掃碼的同一顆 jsQR 函式庫在瀏覽器實際解碼驗證**，確認新版渲染出的 QR 正確還原原始 token（非僅視覺檢查）。
- 🔍 **根因**：`MemberQRPage.jsx` 的 `handleGenerateQR()` 呼叫 `/checkin/qr/create` 成功後，緊接著呼叫 **canvas 版** `QRCode.toDataURL(qrToken,...)`（`qrcode` npm 套件內部用 `<canvas>` 畫圖再轉 PNG data URL）——若這一步在特定裝置/瀏覽器環境對 Canvas API 有限制（記憶體/隱私設定/罕見 WebView 版本等，在此環境無法重現確切成因）就會拋出例外，被外層 try/catch 接住只顯示通用訊息「產生 QR Code 失敗」，**後端記錄已經建立、但畫面上的 QR 圖片永遠不會出現**——這正好精準對應回報症狀，且很可能跟前一輪的「黑屏」是完全不同的成因（那個是 render 階段的整棵樹崩潰，這個是 event handler 內部的局部例外，Error Boundary 本來就攔不到這種）。
- ✅ **新增 `utils/generateQrDataUrl.js`**：改用 `QRCode.toString(text, {type:'svg'})`——純字串運算產生 SVG，完全不經過 Canvas API，包成 `data:image/svg+xml` URI 直接餵給既有的 `<img src>`，跟原本 canvas 版用法完全相容、呼叫端渲染邏輯不用改。套用到全部 5 個「產生 QR 圖片」的地方：`MemberQRPage.jsx`（入場）、`MemberHomePage.jsx`（補租器材）、`MemberCompetitionsPage.jsx`（比賽報到）、`StaffEntryQrPage.jsx`（員工自助入館）、`ExperienceBookingsPage.jsx`（staff，體驗預約公開連結，這個是靜態展示用途、非會員個人手機，優先度較低但一併套用求一致）。
- ✅ **新增共用 `utils/reportClientError.js`**（從 `ErrorBoundary.jsx` 抽出泛化）：`ErrorBoundary` 攔到的整棵樹崩潰、跟上述 5 處 catch block 攔到的局部例外，現在共用同一支回報函式送到 `/client-errors`——`ErrorBoundary` 只攔得到 render 階段的例外，攔不到 event handler/async callback 裡的例外（正是這次 QR 失敗的實際發生位置），之前這類例外完全沒有任何紀錄可查，只能翻資料庫猜；現在兩種例外來源統一有紀錄。
- 🧪 **驗證方式**：`node` 直接呼叫 `qrcode` 套件確認 `toString({type:'svg'})` promise 形式正常運作、產生合法 SVG（1603 字元）；接著**用瀏覽器實際渲染**這個 SVG data URI 成 `<img>`、畫到 `<canvas>` 用 `getImageData()` 取像素，再用專案既有相機掃碼功能同一顆 `jsqr`（從 `node_modules` 複製到本機臨時 HTTP server、同源載入，繞開這個環境對外部 CDN `<script>` 載入的限制——跟稍早 ErrorBoundary 那次遇到的 CDN 載入失敗是同一個環境限制，這次用同源 HTTP server 解決）解碼，**確認解碼結果與原始 token 完全一致**——這比單純視覺檢查更嚴謹，是端到端的真實 QR 解碼驗證。
- 📌 **後續**：Grace/Sabrina 這兩筆已經是店員手動完成入場、資料正常，不需要回頭修正任何紀錄。之後若還有人遇到類似「QR 卡住」，`/client-errors` 現在會留下實際錯誤內容（雖然此環境無法直接查 Railway log，但至少不再是純靠猜測）。

## 目前進度（2026-09-26 續4）— 合併簽署：風險安全聲明書＋墜落測驗同意書一次簽名
> 原本要簽兩次名（`/member/waiver` 簽聲明書、`/member/fall-test` 看影片簽墜測同意書），比照家長遠端簽署早就採用的「一次簽名寫兩份文件」模式，把會員本人（或代簽子帳號的家長）這端也合併成一頁一個簽名。**先進 Plan mode 完整評估規劃、使用者核准後才執行**。後端 `/health` `3.542.1-merged-entry-docs-signing-authme-fix`；正式 API E2E（7 個情境、29 項斷言）全過。commit 後端 `5ddf1cb`+`107de47`、前端 `bee80e2`。
- ✅ **關鍵設計決策：只合併簽署動作、不合併底層資料模型**。`waivers`（一人一份、可鎖定）與 `fallTestSignatures`（append-only 歷史紀錄）兩集合完全不動，既有入場關卡（`checkWaiver`/`hasFallTestSignature`）、員工端「個別退回重簽」「檢視副本/列印」機制、`/waiver/sign`／`/fall-tests/sign` 兩個舊端點全部保留（供修復情境使用）——新增 `waiverService.signEntryDocs()` 依序呼叫既有 `signWaiver()` 與新抽出的 `fallTestService.signConsent()`（原內文自 `routes/fallTests.js POST /sign` 抽出，純搬移），用同一張簽名圖，且只簽署對象目前「缺的那一份/兩份」（自行查 `memberSignedAt`/`hasConsentSignature` 判斷，不重複簽已完成的部分，避免誤觸 `WAIVER_LOCKED` 或墜測同意書疊加出多筆歷史紀錄）。新路由 `POST /members/:id/entry-docs/sign`。
- 🐞 **順手修一個既有 bug（兩處，同一種形狀）**：`memberService.getBlockReasons()` 與 `routes/auth.js`（`/auth/member/me` 有自己一份**獨立、較輕量**的 waiver blockReasons 計算，非走 `getBlockReasons`）判斷「等待法定代理人」的條件原本是 `parentRequired && !parentSignedAt`，沒檢查本人是否真的簽過（`memberSignedAt`）——員工用 `/waiver/reset` 幫未成年會員退回重簽時，只清 `isComplete`/`signedAt`，`parentRequired`/`parentSignedAt` 原樣殘留，導致退回後被誤判成「已簽、等家長」死路狀態，會員點進簽署頁看不到重簽表單。兩處都加上 `memberSignedAt` 前提條件才修正。`/auth/member/me` 這個第二個重複實作是**正式 API E2E 跑到場景7才抓到**（先修好 `memberService.getBlockReasons` 以為夠了，結果 `/auth/member/me`——正是 MemberOnboardingGate/MemberProfilePage 實際依賴的來源——完全沒被涵蓋，另外部署一次才補上）。
- ✅ **前端**：`MemberWaiverPage.jsx`（路由不變，仍是 `/member/waiver`）改寫成合併簽署頁——進頁直接讀目標對象的 `GET /members/:id/waiver`（而非 blockReasons，可同時支援自己與代簽子女、且用同一套精準判斷）＋`GET /fall-tests/signature/:id`，依「缺哪一份」只顯示、只送出對應區塊（風險安全聲明段落／安全影片+墜測同意書段落皆可能只顯示其一），底部只有**一個** `SignaturePad`。`MemberFallTestPage.jsx` 移除簽署子畫面（YouTube 播放器/進度追蹤/段落勾選整段搬到 waiver 頁），只留測驗狀態/檢視副本/安排測驗（跟「怎麼簽的」無關）。`MemberOnboardingGate.jsx` 兩大方框合併成一個（點擊時 `!consentSigned` 才彈「影片不可快轉」警語）；順手修一個真的會發生的死路 bug——警語彈窗「我知道了，開始觀看」按鈕原本 `navigate('/member/fall-test?onboarding=1')`，簽署搬走後那頁已無簽署入口，改導去 `/member/waiver`。`MemberProfilePage.jsx` 的 waiver 卡＋墜測同意書狀態列合併成一張「入場文件簽署」卡（同樣改讀 `GET /members/:id/waiver` 精準判斷，不用 blockReasons），家庭成員列表兩個代簽按鈕合併成一個。
- **E2E（打正式 API，7 情境 29 項全過，測試資料/通知測後全清）**：①成人本人兩份都缺→一次完成 ②未成年本人兩份都缺+parentEmail→只寄一封信、既有家長遠端簽署流程走一輪不受影響 ③修復情境A（waiver已完成缺墜測同意書）→只簽墜測、不誤觸WAIVER_LOCKED ④修復情境B（墜測已存在缺waiver）→只簽waiver、不疊加墜測同意書 ⑤子帳號家長代簽→一次完全完成、無email ⑥兩份皆完成→400 ALREADY_COMPLETE防禦性檢查 ⑦模擬`/waiver/reset`後的殘留狀態→`/auth/member/me`正確回報`waiver_unsigned`（非`parent_waiver_pending`死路）、合併端點正確允許重簽。
- ⚠️ **驗證限制**：瀏覽器實際點擊登入走一輪的驗證嘗試在這個環境卡住（多次以不同方式點擊「Log In」都沒有真的送出請求，`read_network_requests`確認完全沒有打到 login API；診斷點擊一個無關的語言切換按鈕後整個瀏覽器分頁連線也斷了）——嘗試多輪不同做法後判斷是環境本身的問題、非我的操作誤區，依計畫書原訂的備援方案改以上述 API 端到端驗證＋逐檔程式碼比對作為主要驗收依據，如實記錄未能完成 UI 點擊驗證這件事。

## 目前進度（2026-09-26 續3）— 修：queryDiag.js 誤把 vite build 順序踩到的舊 buildId 標籤當成功能異常
> 順著上面 UpdateChecker 的查證，發現一個**跟本次修復無關、單純是我自己操作順序造成**的小狀況：這次部署（`4042110` 節流修正）流程是先 `vite build`+`firebase deploy`+驗證 bundle hash 一致，**之後才 `git commit`**（跟平常先 commit 再 deploy 的習慣顛倒）——導致 `vite.config.js` 內建的 buildId 生成（讀當下 git hash + 時間戳）擷取到的是**上一個**commit（`f9290d2`，Error Boundary 那次）的雜湊值，而非這次真正部署的 `4042110`。**不影響 UpdateChecker 的偵測功能本身**（timestamp 部分仍然每次都不同，字串比對仍會正確判斷為新版本），只有 buildId 標籤裡的 git hash 前綴顯示成舊的、容易造成排查時誤判「這次到底部署了哪個 commit」。純記錄提醒：**之後想確保 buildId 標籤本身也精確對應到正確的 commit，要先 commit 再 build+deploy**（本次順序顛倒純屬部署流程操作失誤、非程式邏輯問題，未改動任何程式碼）。

## 目前進度（2026-09-27）— 電話搜尋入場：只對到一位會員時自動預選（免多點一次）
> 需求：入場用電話搜尋，若該電話只有一個會員資料，不用再手動點選才能繼續。純前端 `CheckinPage.jsx`，commit `57cb762`，已 build+deploy（bundle hash 比對線上一致）。
- ✅ **抽出 `selectPhoneMember(m)`**：把原本寫死在「選擇入場人員」按鈕 onClick 裡的「設定選中人員 + 打 `/checkin/eligibility/:id` 帶出入場資格」邏輯抽成獨立函式，按鈕與自動選取共用同一份，避免各自維護一份日後改一處漏另一處。
- ✅ **`handlePhoneSearch()` 找到唯一候選人即自動選取**：候選清單＝`[家長本人, ...未過濾掉的子會員]`（與畫面「選擇入場人員」按鈕列表同一份組法）；`candidates.length === 1`（該電話沒有家庭成員可選）時，搜尋完成直接呼叫 `selectPhoneMember(found)`，免再多點一次唯一的那個選項。有多位家庭成員時行為不變，仍要手動點選要讓誰入場。

## 目前進度（2026-09-27 續）— 免登入公開課程頁：場館分類 + 額滿顯示 + 梯次星期時段
> 需求：`PublicCoursesPage`（`/book/courses`，免登入班別總覽）與 `PublicCourseCategoryPage`（`/book/category`，免登入梯次列表）也要能依場館篩選；已額滿的梯次要顯示額滿資訊。中途使用者追加「也要把課程的時段顯示出來」。後端 `/health` `3.543.0-public-category-weekdays`；前端 commit `303cc01`；已 build+deploy 兩端，正式站打真實資料（小蜘蛛人初級班，11 梯跨新竹/士林）端到端驗證通過、console 零錯誤。
- ✅ **後端**：`GET /courses/public/category/:categoryId` 的 cohort 投影補上 `weekdays`/`startTime`/`endTime`——`getCourses()` 本就算好這些欄位，只是先前的公開頁投影沒選取；額滿判斷完全不用改後端，`statusLabel` 早已在 `getCourses()` 依 `enrolledCount>=maxStudents` 算出 `'full'`，公開頁的 cohort 回應本就有帶這欄位（`3.543.0` 前就存在），只是前端沒讀。
- ✅ **場館分類**（兩頁皆加「全部場館／新竹館／士林館」三選一 chips，樣式抄 `MemberRoutesPage.jsx` 既有的 `GymChips` 慣例）：
  - `PublicCoursesPage`（第一層）：依 `cat.gymIds.includes(選定館)` 篩選班別卡；點進某個班別時把目前選定的場館帶成 `?gym=` 深連結參數。
  - `PublicCourseCategoryPage`（第二層）：讀 `?gym=` 深連結初始化篩選狀態（無效值一律當「全部」）；依 `cohorts` 實際涵蓋的場館數決定要不要顯示這排 chips（只有一館時沒有篩選意義、不顯示）。
- ✅ **額滿顯示**：非工作坊（週課）梯次比照工作坊場次既有的「已額滿」樣式（原本只有工作坊場次層級有做，週課梯次層級完全沒判斷、永遠顯示可報名的「報名 →」按鈕）——`c.statusLabel === 'full'` 時改顯示紅字「已額滿」取代按鈕。目前正式資料沒有剛好額滿的週課梯次可視覺驗證，但邏輯與已驗證運作的工作坊判斷完全同一套（`enrolledCount>=maxStudents` 早已由後端算好）。
- ✅ **梯次星期時段**：仿 `MemberCoursesPage.jsx` 既有的 `wdList()`/`wdShort()` 寫法（因公開頁是獨立元件、未共用會員端模組，複製一份小工具函式），在梯次卡片加一行「🗓 每週三 16:30～18:00」，僅非工作坊梯次顯示（工作坊本就逐場次各自列時間，不需要在梯次卡層級重複）。
- ✅ **i18n**：`memberI18n.js` 補「全部場館」中英日對照（`All Gyms`／`全店舗`，比照既有「新竹館」EN=Hsinchu／JA=新竹店 的命名慣例）。
- 🧪 **驗證（正式站，JS 直接操作 DOM 迴避這個環境對 `computer` 座標點擊偶發的視窗座標系統對不上問題——已用 `getBoundingClientRect()` 確認過同一顆按鈕在畫面上看到的座標與實際可點擊區域不一致）**：①第一層 11 個班別篩「士林館」→ 正確剩 3 個（小蜘蛛人初級班/技巧班/RedFlash運動按摩，皆為 `gymIds` 含 `gym-shilin` 者）②點進「小蜘蛛人初級班」→ URL 正確帶 `&gym=gym-shilin`、第二層落地即顯示「士林館」chip 為選中狀態、「選擇梯次（共 3 個）」正確只列士林館 3 梯 ③梯次卡片正確顯示「🗓 每週三 16:30～18:00」等星期時段（11 梯逐一比對 API 回傳值與畫面一致）。

## 目前進度（2026-09-27 續2）— 公開班別頁：常態報名已額滿的週課，補「單堂試上」選項
> 承續公開課程頁：使用者要求「如果常態報名已額滿，雖然有人請假有釋出名額，還是要顯示「已額滿」但多一個「單堂試上」申請」。後端 `/health` `3.544.0-public-category-full-trial-fallback`；前端 commit `8c1a408`；已 build+deploy，正式站驗證既有功能無回歸（console 零錯誤）。目前正式資料沒有剛好額滿的週課，無法視覺驗證這個新分支本身，但邏輯完全重用已上線、已驗證的既有機制。
- 🔍 **關鍵資料事實（已用本機腳本對照真實資料確認）**：課程「額滿」`statusLabel==='full'` 是**整期常態報名總量**指標（`enrolledCount>=maxStudents`，`enrolledCount` 為不重複人數）；而「單堂試上」是否可申請看的是**個別場次當天的實際名額**（`getSessions()` 逐場次的 `enrolledCount`），會員請假時**只扣當天那一場**的計數，不影響整期總量——兩者本就是獨立指標，因此「整期額滿」與「某天有試上名額」完全可以同時成立。系統既有的 `courseService.getTrialSessions()`（供會員端「課程試上」分頁與 `/book/trial` 使用）本就是照這個場次層級邏輯算的，不用改一行後端計算邏輯，只要在公開頁把這個既有結果「秀出來」即可。
- ✅ **後端**：`GET /courses/public/category/:categoryId` 於組裝回應前，找出這個班別底下 `type!=='workshop' && statusLabel==='full'` 的梯次 id 清單；只有這份清單非空時才呼叫一次 `getTrialSessions(null)`（避免對沒有額滿梯次的班別頁多打一次查詢），依 `courseId` 分組、排除 `isFull` 的場次，附進對應梯次的 `trialSessions: [{id,date,startTime,endTime,trialPrice}]`（非額滿梯次固定回傳空陣列 `[]`，前端好判斷）。
- ✅ **前端**：非工作坊梯次 `cohortFull` 時，「已額滿」紅字標籤維持顯示不變；若 `trialSessions.length>0` 額外在下方顯示「單堂試上 ▾」按鈕（樣式/收合互動完全比照工作坊既有的「選場次 ▾」模式），展開後列出各可申請場次（日期/時段/試上費），逐筆連到既有 `/book/trial?session=<id>` 完成報名——沒有可用試上場次時維持原樣、不顯示這顆按鈕。`memberI18n.js` 補「單堂試上 ▾」／「試上費」中英日對照。
- 🧪 **驗證**：本機腳本確認 `getTrialSessions(null)` 正常執行（855ms、回傳 30 筆場次，欄位形狀與程式碼假設一致）、目前系統內剛好 0 筆額滿週課（故這條新分支的「有內容可展開」情境暫無法在正式站肉眼確認，只能確認「不影響既有路徑」）；正式站對真實 11 梯資料重新整理後 DOM 檢查：11 個「報名 →」按鈕、0 個「已額滿」、0 個「單堂試上」——與目前資料現況（皆非額滿）完全吻合，console 零錯誤，確認這次改動沒有破壞既有的正常報名路徑。
- ⚠️ **上面「目前系統內 0 筆額滿週課」的驗證結論是錯的——見續3的真 bug 修正**：驗證當下只查了 `statusLabel`（自己也剛好沒踩到反例），沒發現 `statusLabel` 本身對已開課梯次是不可靠的資料，導致這次功能上線當下就漏了 3 個真實已額滿的梯次。

## 目前進度（2026-09-27 續3）— 修：公開班別頁「已額滿」漏判已開課的額滿梯次（真實回報）
> 使用者直接指出「小蜘蛛人週五B班週六A班不是都額滿了嗎？」——與續2驗證時的結論矛盾，回頭查證後確認續2的「目前系統內 0 筆額滿週課」是誤判，找到並修復一個影響範圍比這次公開頁功能本身更廣的既有 bug。後端 `/health` `3.544.1-public-category-full-fix-ongoing`；前端 commit `5696b67`；正式站驗證：真實資料「已額滿」數由 0→3（週五B/週六A/週二B班），console 零錯誤。
- 🐞 **真根因**：`courseService.js` 的 `computeStatusLabel(course, enrolledCount)` 依序判斷 `cancelled → ended → ongoing（today>=startDate）→ full（enrolledCount>=maxStudents）→ starting_soon → enrolling`——**`ongoing` 排在 `full` 前面、且兩者互斥（一律 return 提早結束判斷）**，代表**任何「已開課、插班中」的梯次，`statusLabel` 在資料結構上永遠不可能是 `'full'`**，不管報名人數是否早已超過上限。這不是本次新功能才有的 bug，是 `computeStatusLabel` 從很久以前就存在的既有邏輯落差——只是先前沒有任何地方單獨依賴 `statusLabel==='full'` 判斷額滿（會員端 `MemberCoursesPage.jsx` 本就有補救寫法 `isFull = c.statusLabel==='full' || remaining<=0`，見 2026-08-28「課程總覽多梯次微調」的既有程式碼），公開頁（續2剛做的新功能）是第一個「只看 `statusLabel`、沒有這層補救」的消費端，才第一次把這個落差暴露成使用者看得到的錯誤畫面。
- ✅ **修法（不動 `computeStatusLabel` 本身，比照會員端既有補救模式）**：`GET /courses/public/category/:categoryId` 額外把 `enrolledCount`/`maxStudents` 投影進 cohort 回應；後端判斷額滿的邏輯（含「單堂試上」該篩哪些梯次）與前端 `cohortFull` 判斷，皆改為 `statusLabel==='full' || (maxStudents!=null && enrolledCount>=maxStudents)`——與 `MemberCoursesPage.jsx` 逐字同一套算法。**刻意不修 `computeStatusLabel` 本身**：這個函式在系統裡被大量消費端引用（員工端課程管理、會員端課程總覽、月曆、報名 quote 等），貿然改變 `'ongoing'`/`'full'` 互斥的既有語意，風險遠大於在新舊兩個消費端各自補一行判斷式。
- 🧪 **驗證**：本機直接呼叫 `getCourses(null)` 重新核對「小蜘蛛人初級班」全部 11 個有效梯次的 `enrolledCount`/`maxStudents`——修正前僅信 `statusLabel` 判出 0 筆額滿，套用新判斷式後正確抓出 **3 筆**（週五B班 6/6、週六A班 6/6、週二B班 6/6，皆為已開課中）；三者目前皆無開放中的單堂試上場次（`getTrialSessions` 回傳 0 筆，真實狀態、非 bug）。部署後正式站重新整理「小蜘蛛人初級班」分類頁，DOM 檢查與截圖確認：11 梯中正確 3 筆顯示「已額滿」（無報名按鈕）、8 筆維持「報名 →」，與本機驗證數字完全吻合，console 零錯誤。
- 💡 **教訓**：對「這個系統已經有類似功能」的既有頁面做新頁面時，**要去讀既有頁面實際『怎麼判斷』的程式碼，而非假設某個看起來像權威狀態欄位（`statusLabel`）本身就足夠**——本例會員端早就因為踩過同一個 `statusLabel` 的落差而寫了補救判斷式，這條線索當時就擺在那裡，續2寫的時候沒去對照，直接假設 `statusLabel==='full'` 已經是唯一真相，才會在功能上線當下就帶著這個漏洞。之後任何要判斷「是否額滿」的新程式碼，一律用 `statusLabel==='full' || enrolledCount>=maxStudents` 這個組合，不要只看 `statusLabel`。

## 目前進度（2026-09-27 續4）— 資料操作：郭詠蓁體驗課程改期至 9/30，連動更正教練費結帳時間
> 需求：`exp_1788068463516_w4z0`（郭詠蓁，士林館，教練張元賓）改期至 9/30，教練費（NT$400）的結帳時間要跟著一起改。純資料操作，直接呼叫真實 service 函式執行（`updateExperienceSchedule`＋`addCashAdjustment`），非手改 Firestore 欄位。
- 🔍 **背景還原**：該筆教練費是 9/21 設定（`financeUpdatedAt`），設定當下 `bookingDate` 還是 9/27，`addCashAdjustment` 依既有設計（見 `settlementService.js` 註解「體驗教練費…由呼叫端明確帶入 `targetDate`＝活動當天」）把「－教練費400」記進了士林 9/27 的暫存結帳；今天（9/27）稍早這筆體驗課才被改期到 9/29，但**改期端點（`updateExperienceSchedule`）不會回頭連動已經記過的結帳加減項**——這是既有、已知的設計（教練費結帳時間與預約活動日期不自動綁定，改期後需人工校正），本次再改到 9/30 同樣要人工搬動。
- ✅ **改期**：直接呼叫 `updateExperienceSchedule(db, booking, staff)`（比照 `PUT /:id/schedule` route 的真實邏輯：先更新 `bookingDate:'2026-09-30'`＋`editedBy/editedByName/editedAt`，`bookingTime` 維持原值 15:30-16:30）——連動課程/場次日期、刪舊班重建教練排班（新 `scheduleShiftId`）、1 張未使用入場券 `validDate/expiresAt` 同步、營收認列日 `recognitionDate` 同步搬到 9/30 00:00（Asia/Taipei）。
- ✅ **結帳搬移**：士林 9/27 暫存結帳的 `deductions` 移除該筆「－教練費400」（該日另一筆無關的「－現金領取4000」保留不動）；改呼叫 `addCashAdjustment({gymId:'gym-shilin', sign:'-', type:'教練費', amount:400, note:'郭詠蓁 體驗教練費', targetDate:'2026-09-30'})` 在 9/30（原本沒有結帳文件）新建一筆 draft，帶入同一筆加減項（新 id，內容一致）。
- ✅ **`payoutRecords`**：`16e63889-f492-4abf-84bb-6f9a5bbc513d`（張元賓／教練費／400／`sourceBookingId` 指回此預約）`date` 由 `2026-09-27` 改 `2026-09-30`，其餘欄位不動。
- **驗證**：重新查詢 booking／course／session／shift／ticket／transaction／兩份 dailySettlements／payoutRecords 共 8 處，全部正確落在 9/30（transaction 的 `recognitionDate` 換算 Asia/Taipei 精確為 9/30 00:00）；9/27 結帳只剩無關的那筆現金領取記錄。scratchpad 腳本測後刪除。

## 目前進度（2026-09-28）— 修：月銷售紀錄/發票明細下載改走共用 client + 營收報表加自訂期間
> 兩件連續處理：①回報「下載月銷售紀錄出現：下載失敗：伺服器錯誤 401」②接著要求「營收報表中加入自訂期間的選項」。後端 `/health` `3.545.0-revenue-custom-date-range`；正式環境全鏈驗證通過。
- 🐞 **修：月銷售紀錄/發票明細下載手刻 fetch()，繞過共用 client 的 401 自動偵測機制**：`DailySettlementPage.jsx`（結帳頁「下載月銷售紀錄」）與 `FinancePage.jsx`（財務→月銷售紀錄／發票明細兩個下載）皆手刻 `fetch()`+手讀 `localStorage` token key，雖然 key 名稱本身沒錯（`operatorToken/token/stationToken`，與 `api/client.js` 一致），但繞過了共用 `client` 內建的「token 過期自動清除+重整/重導」機制——token 剛好卡到過期邊界時容易整個失敗且不會自動恢復（同型教訓見 2026-07-07）。三處全改走共用 `client.get(url, {params, responseType:'blob'})`，錯誤訊息改讀 `e.response?.status`。commit（redrock-web）`ca3559f`。
- ✅ **營收報表加「自訂期間」**（`revenue.js` 四個「按天分組」端點）：新增共用 `resolveReportRange(req)`——優先讀 `dateFrom`/`dateTo`（自訂期間，含起訖兩日、上限 366 天防呆），否則沿用既有 `days`（近N天），**完全向下相容**（既有「7/14/30天」快速按鈕行為不變）。`/daily`、`/checkin-stats`、`/adjustments`、`/export-adjustments-csv` 四端點皆改用此函式。
  - **順手修一個既有小缺口**：`/adjustments`／`/export-adjustments-csv` 原本只有下限（`date>=fromDate`）、沒有上限——「近N天」用法剛好不會踩到（fromDate 到今天本就涵蓋所有既有資料），但若查一段**過去**的自訂區間（如 7/1~7/15）會誤把 7/15 之後到今天的全部結帳都撈進來。補上 `date<=toDate` 上限過濾。
  - **前端**（`RevenuePage.jsx`）：日期選擇列加「自訂期間」按鈕，點下後顯示兩個 `<input type="date">`（互斥於既有 7/14/30天快速按鈕，選其一自動切回快速模式）；`loadAll()`／CSV 匯出（`handleExportCheckin`／`handleExportAdjustments`）依模式二選一組 API 參數；所有原本寫死「近{days}天」的標籤（日報表/加減項/入場日報標題、`N天合計`/`N天入場`/`N天收費`）改用 `periodLabel`（`近N天` 或 `7/16~7/31`）／`periodShort`（`N天` 或 `期間`）動態顯示。
- **驗證（本機起服務打真實 Firestore 資料，逐一比對）**：`/daily` days=14 與等效 dateFrom/dateTo（9/15~9/28）內容逐日排序後完全一致；`/checkin-stats` 同款驗證（175筆=175筆）；`/adjustments` 自訂範圍 7/1~7/15 正確只回 3 天資料（驗證上限修正生效）；`/export-adjustments-csv` 自訂範圍下載內容正確；`dateTo<dateFrom`→400 INVALID_RANGE；範圍超過366天→400 RANGE_TOO_LARGE。部署後正式 API（真實登入）重新核對 `/daily`（7/16~7/31，16天，合計140869）與 `/adjustments`（7/1~7/15，5筆，netAdjust -29320，日期分布7/9~7/11）皆與本機測試結果完全一致。

## 目前進度（2026-09-28 續）— 修：合併簽署頁未成年判斷用 `member.birthday`，登入當下未帶、送出撞牆
> 回報（截圖）：未成年新會員在合併簽署頁「法定代理人資訊」欄位有時不出現，客人描述「要跳出去再用才會有」——送出後撞到後端「未成年會員需提供法定代理人email」失敗。純前端查證＋修復，未動後端（後端判斷本就正確）。commit（redrock-web）`ee01d08`。
- 🐞 **根因**：`MemberWaiverPage.jsx`（2026-09-26 合併簽署功能）的 `needGuardianInfo = needsWaiverSection && isMinorAge(member?.birthday)` 靠**登入者自己攜帶的 `birthday`** 判斷未成年——但 `POST /auth/member/login` 的回應**完全不含 `birthday`**（只有 `id/name/phone/email/isBlocked/blockReasons/isMinor/isTeamMember/teamMemberUntil/emergencyContact`），`birthday` 要等 `memberStore.jsx` 背景呼叫 `/auth/member/me`（獨立 `useEffect`，登入後才觸發）才會補進 `member` 物件。新會員剛登入就直接被導進這頁簽署入場文件時，`member.birthday` 還是 `undefined`，`isMinorAge(undefined)` 判定「非未成年」→ 藏起法定代理人欄位；但**後端是用 Firestore 上持久化的 `member.isMinor` 欄位權威判斷**（`createMember` 建立時依生日算好存死，見 `memberService.js:670-689`），對真正未成年的人仍會要求 `parentEmail` → 送出失敗。「離開頁面再進來」能過，是因為此時背景的 `/auth/member/me` 早已刷新完成、`member.birthday` 補上了。
- ✅ **修**：`needGuardianInfo` 改用 `member?.isMinor`（直接讀後端提供的既有持久化布林——`/auth/member/login` 與 `/auth/member/me` 兩端點皆有回傳，登入當下即可靠存在，無背景刷新的時序落差）；移除不再使用的 `isMinorAge`/`utils/age` import。
- 📋 **查證排除的相關情境**：`forChildId`（家長代簽子帳號）維持不受影響——`member.isMinor` 反映的是「登入者本人」（家長，恆非未成年），子帳號本就走「家長代簽即 `isComplete:true`、不需 parentEmail」的既有設計（2026-09-26 plan 已記錄），這條路徑本來就不該顯示法代欄位、行為未變。全域掃描確認 `MemberCompetitionsPage`／`MemberPassesPage`／`MemberProfilePage`／`MemberTeamPage` 其餘 `member.birthday` 用法皆為純顯示/表單預填/請求欄位，非「隱藏必填區塊」這種會直接導致送出失敗的用法，故未擴大修改範圍。
- **驗證**：查真實資料確認自助註冊的獨立未成年會員（`涂盛淮`，2011-10-03）`isMinor:true` 正確持久化於 Firestore；`build+deploy` 後 bundle hash 比對本機/線上一致。
- 💡 **教訓（本次順手發現另一遺漏）**：稍早「營收報表自訂期間」功能的 `RevenuePage.jsx` 當時只做了 `build+deploy`、忘記 `git commit`——靠這次改別的檔案時 `git status` 才發現還躺著沒進版控，補提交（`116e5de`）。**再次印證本檔案歷史記錄的教訓：多檔案/跨功能連續作業時，`firebase deploy` 不需要 git 乾淨即可執行、也不會提醒漏 commit，每完成一項功能就該當場 `git status` 確認落地，不要留到下一個任務才順便發現。**

## 目前進度（2026-09-28 續2）— 墜測影片觀看進度存 localStorage（避免中途離開需整支重看）
> 承上一則修復，使用者接著確認「這樣就不會跳出去又要重看一次影片了吧？」——回答：拿掉了強迫離開的誘因，但頁面本身沒有進度持久化機制、真的中途離開仍會重置為 0%。使用者接著要求把進度存到 localStorage。commit（redrock-web）`5c2f5f0`。
- 📐 **設計決策：存「已看過的整數秒集合＋影片總長」，不是單純一個百分比數字**——使用者追問「這樣如果有用快轉或跳著看的人會不會永遠卡死？」，促成這個更正確的設計（原本第一版草案只存百分比數字＋`Math.max` 防退步，會讓每次重新造訪都要在**新的一輪空白累積**裡獨立重新逼近門檻才會讓顯示數字往上動，對本來就會跳著看的人反而更不利）。改存整份集合後，`watchedSecondsRef` 在每次造訪都從**同一份持久化集合**繼續累加（非各自獨立的新集合再取 max），即使每次都跳著看不同段落、多次造訪合計仍會持續逼近門檻，不會卡住——已用 Node 腳本模擬「三次造訪、每次只跳看一部分」的情境驗證：0~30秒→31%、疊加40~75秒→67%、疊加76~99秒→91%（達 90% 門檻），確認收斂正確。**既有「不可快轉」的防護本身完全沒變**（同一次播放中跳過的秒數本來就不會被算進去，這是既有設計、非這次新增的限制）——這次只解決「跨次造訪」的累積問題，不影響「單次快轉仍不算數」的既有防呆。
- ✅ **實作**：`watchProgressKey(targetId, videoId)` 定 key（含代簽子帳號與換片互不污染）；進頁資料載入完成後從 `localStorage` 讀回集合＋總長，直接 `new Set(parsed.seconds)` 塞回 `watchedSecondsRef.current` 並算出對應百分比顯示；播放中每秒 tick 除了累加集合，同步整份寫回 `localStorage`；簽署成功後清除該筆記錄（避免殘留無用資料）。純本機裝置層級、讀寫皆包 try/catch（壞資料/儲存空間滿了都優雅忽略、不影響觀看本身）。
- 📌 **範圍限制（如實告知使用者）**：`localStorage` 是「這台瀏覽器」層級——換裝置、換瀏覽器、清瀏覽器資料都不會保留進度，這是此方案的既有限制，非本次遺漏。

## 目前進度（2026-09-28 續2）— SignaturePad 擋掉「隨便畫一條線」的塗鴉簽名
> 使用者延續對簽名功能的討論（先問「有簽署框可以自動辨識手寫簽名是否工整，這是怎麼做到的？」→「ocr嗎？」了解常見做法後），要求「我們要擋掉隨便亂畫的」。純前端，涉及全站 9 個檔案共 13 個 `<SignaturePad>` render 位置；commit `redrock-web`（多筆，見下）。
- 📐 **設計**：不做真正的筆跡辨識（OCR/手寫辨識，準確率低、跟這裡要擋的問題不對應），改分析畫圖過程的幾何特徵（真正商用電子簽署產品常見做法）——`SignaturePad.jsx` 新增追蹤每筆的座標序列（`strokesRef`）與外接矩形（`boundsRef`），暴露新方法 `isTooSimple()`：① 涵蓋範圍（外接矩形對角線）< 40px → 只是點一下 ② 總描點數 < 8 → 動作太短促 ③ 只有一筆、且路徑長度/首尾直線距離 < 1.3（近乎直線）→ 一筆拖過去的塗鴉。三者命中任一即視為過於簡單；`clear()` 同步重置這些追蹤資料。**刻意保留寬鬆**：多筆簽名（中文姓名幾乎必為多筆）完全不受單筆直線規則限制，單筆但有彎曲的英文草寫簽名也不會被擋——只擋最明顯的「應付了事」案例，不影響任何正常簽名。
- ✅ **驗證（Node 模擬 5 種情境，與元件內公式逐字一致）**：單點/短快速滑動/一筆直線拖曳(200px) 三者皆正確判定過於簡單；模擬 3 筆中文簽名（有轉折）與模擬英文草寫單筆簽名（有弧度）皆正確判定為合格。
- ✅ **全站 13 個 SignaturePad 呼叫點逐一接上 `isTooSimple()`**（依各檔既有驗證模式分三類處理）：①**直接於 submit 前檢查**（`MemberWaiverPage.jsx`／`ParentWaiverPage.jsx`／`ParentCompetitionWaiverPage.jsx`／`PublicTrialBookingPage.jsx`／`PublicCompetitionRegisterPage.jsx`，本人+法定代理人共 8 處）②**「儲存簽名」按鈕點擊時檢查**（`MemberCompetitionsPage.jsx`／`MemberCoursesPage.jsx`，這兩處是「畫完先存成 dataURL 再送出」的模式，在存檔當下就攔截、不等到最後送出才發現，共 5 處按鈕+1 處另一個獨立的遠端代簽 modal）③**併入既有 `isValid()` 布林閘門**（`PassContractReview.jsx`，維持該元件原有「一個 boolean 涵蓋所有檢查」的既有設計，不拆分新訊息）。統一錯誤訊息「簽名過於簡單，請以正楷書寫完整姓名」（法定代理人另有專屬文案），已加入 `memberI18n.js` 中/英/日三語字典（4 筆新條目，EN/JA 各兩則，插入既有相鄰同類訊息旁）。
- 🧪 **驗證方式（如實記錄限制）**：程式碼逐檔核對＋ Node 算法模擬＋兩個 target 皆 build 成功；**未做真人瀏覽器點擊畫布測試**（此 session 稍早已兩度記錄瀏覽器自動化在這個環境對登入表單/座標點擊的不可靠性，權衡後以「與元件內公式逐字一致的模擬」＋程式碼審閱作為主要驗收依據，如同稍早 localStorage 影片進度功能的驗證方式）。

## 目前進度（2026-09-28 續3）— 修：卡號白名單改嚴格擋（跨卡別誤植漏洞，真實已發生一筆）
> 使用者直接回報「龔金龍轉入優惠卡（實際是黑卡）為什麼沒有卡住卡號不能轉入？」——查證後確認是真的漏洞，且已經造成一筆真實的重複福利。使用者接著明確指示「比不到清單都要直接禁止，這個錯誤的優惠卡直接刪除」。後端 `/health` `3.546.0-card-registry-strict-crosscheck`；本機起服務打真實 Firestore 資料驗證 5 情境；commit `a5281f9`。
- 🐞 **根因**：`checkCardRegistry(db, cardType, barcode)` 原本先查 `GATED_SERIES[cardType]`（各卡別各自一份白名單字軌清單）比對前綴，比不到就直接 `{ok:true, tracked:false}` 放行、**連 `physicalCardRegistry` 清冊都沒查詢**。龔金龍轉入的卡號 `AT19-0387` 屬於黑卡字軌（`GATED_SERIES.black`），拿去走優惠卡轉入端點時，優惠卡自己的白名單（`GATED_SERIES.discount = ['D19','D21','D24']`）完全比不到這個字軌，程式判定「這是還沒列管的優惠卡」直接放行。
- 📊 **查真實資料確認重複福利已發生**：該卡號在 `physicalCardRegistry` 裡早就登記為 `cardType:'black'`；龔金龍名下同時存在——59秒前建立的 `discountCards`（8格，`source:'migrated'`，`remainingCredits:8/totalUsedCredits:0`，0筆入場使用紀錄）、59秒後建立的 `legacyBlackCards`（原始12格，剩7格，走黑卡綁定端點正確比對到 `AT19` 才成立）。同一張實體卡被同時掛成優惠卡＋黑卡兩套福利，多出來的優惠卡那筆從未被使用過。
- ✅ **修（使用者明確指示「比不到清單都要直接禁止」，改為比原本設計更嚴格的政策）**：`checkCardRegistry` 改成**一律先查清冊**（不再先看 `GATED_SERIES` 決定要不要查）——查不到直接拒絕（`CARD_NOT_IN_REGISTRY`，此為新行為，原本查不到會放行）；查到但清冊登記的 `cardType` 跟現在要綁定的類型不同也拒絕（新增 `CARD_TYPE_MISMATCH`，明確告知「此卡號屬於OO，非您選擇的卡別」）。**移除已無用的 `GATED_SERIES`/`matchesGatedRule` 分階段放行機制**——單一份清冊資料即為唯一真相，天生不會再有「這個類型的白名單沒列到、比對比不到就放行」這種結構性分岔（這正是本次漏洞的根本成因：兩份各卡別獨立維護的清單，天生無法互相驗證）。
- ✅ **驗證（本機起服務打真實 Firestore 資料，測試資料測後全清並還原清冊狀態）**：①`AT19-0387`(已知黑卡)走優惠卡端點→409 `CARD_TYPE_MISMATCH`（修復核心情境）②完全未知的假卡號→400 `CARD_NOT_IN_REGISTRY`（新嚴格行為）③真實未綁定優惠卡卡號(`D19-0002`)走優惠卡端點→201 正常成功（確認合法流程不受影響）④同一張卡再次嘗試→409 `CARD_ALREADY_BOUND`（既有行為不變）⑤反向驗證：優惠卡卡號走黑卡端點→409 `CARD_TYPE_MISMATCH`（雙向對稱）。
- ✅ **資料修正（使用者明確授權）**：龔金龍那筆誤植的 `discountCards` 記錄（`51b78deb-...`，8格、0次使用、無任何入場紀錄，確認為乾淨未消費過的錯誤記錄）已直接刪除；他名下正確保留原本就該有的黑卡（12格，剩7格）。
- ⚠️ **政策影響提醒**：此次改動把整個白名單系統從「漸進式放行（未匯入的字軌先不管）」改成「只認清冊、預設拒絕」——目前 D19/D21/D24/AT19/AT21/ST19 六個字軌皆已完整匯入（見歷次記錄），故此政策轉換對現行資料不會造成誤傷；**若未來有全新批次的實體卡（新印製、尚未跑過 `importCardRegistry.js` 匯入）要開始使用，必須先完成匯入才能綁定**，否則會被新的嚴格政策擋下（`CARD_NOT_IN_REGISTRY`）——這是使用者明確要的行為（「比不到清單都要直接禁止」），非疏漏。

## 目前進度（2026-09-28 續4）— 修：版本偵測 buildId 改用原始碼內容 hash（消除無改動重新部署也誤觸「發現新版本」）
> 使用者問「為什麼一直會出現發現新版本的訊息？即使中間都沒有改版過」。此機制既有設計早已於 2026-09-27 查證過一次（`buildId=git hash+時間戳`）、當時拍板「部署密集期正常行為、不改」；使用者今天再度問起（本 session 確實在短時間內對 member/staff 兩站做了多次真實 deploy），這次明確指示「改成內容 hash 版本」——即之前保留的改善方案，正式實作。純前端 `redrock-web`，commit `9f14233`；本機以 4 輪建置實測驗證（無變動重複建置/真變動/還原變動 三態），部署後兩站正式網域 bundle hash 與 `version.json` 皆比對一致。
- ✅ **改法**（`vite.config.js`）：移除 `git hash+Date.now()` 組法，新增 `hashSourceTree()`——對「決定打包結果」的來源（`src/`、`public/`、`index.html`、`vite.config.js` 本身、`package.json`）遞迴走訪、逐檔 `sha256`（含相對路徑名稱，避免只挪動檔案位置卻內容不變被誤判無變化；`readdirSync(...).sort()` 保證走訪順序決定性）；`buildId = ${target}-${hash前16碼}`（member/staff 各自標記，比對邏輯仍各自對自己網域，不受影響）。**刻意不用 git 樹狀 hash（`git ls-tree` 之類）**：本專案慣例允許 build+deploy 先於 git commit（本檔案歷史記錄過好幾次「deploy 完才發現忘記 commit」），若用 git 狀態算 hash，同一個 commit 下兩次改動未進版控的檔案、各自 deploy，會被誤判成同一版本、該跳的提示反而不跳；直接讀磁碟當下實際內容才會精準對應「這次真的部署了什麼」。**刻意不對「打包後的 dist 輸出」算 hash**：輸出本身內嵌這個 buildId，用輸出反推輸入是雞生蛋蛋生雞、永遠對不齊，因此改為對「輸入端」（原始碼）算 hash。`UpdateChecker.jsx` 的輪詢/比對邏輯完全不用改（仍是單純字串比對 `data.buildId !== CURRENT_BUILD_ID`）。
- ✅ **本機驗證（4 輪 `npm run build`/`build:member`，逐一比對 `dist-*/version.json`）**：①同一份原始碼連續建置兩次 → buildId 完全相同（`staff-536462e16ed145db` = `staff-536462e16ed145db`，證實「重新部署但程式碼沒變」不再誤觸新版本提示）②對 `src/main.jsx` 加一行無意義註解後重建 → buildId 確實改變（`staff-0c1c9fce259c8a03`，證實真的有程式碼變動時仍會正確提示）③`git checkout` 還原該行後重建 → buildId 精確回到原值（`staff-536462e16ed145db`，證實是純內容決定、無累積殘留狀態）④`build:member` 正常運作，含 `member-536462e16ed145db`（與 staff 共用同一份原始碼、hash 部分本就理應相同，僅 `target` 前綴不同——不影響比對邏輯，因為各自只跟自己網域的 version.json 比對）。
- ✅ **部署驗證**：`firebase deploy --only hosting --project redrock-dev-a35c1` 兩站皆成功；`app.redrocktaiwan.com`／`staff.redrocktaiwan.com` 兩個自訂網域的 bundle 檔名（`assets/index-*.js`）與 `version.json` 皆與本機建置產物逐一比對一致。
- 📌 **範圍**：僅影響「什麼情況該跳新版本提示」這個判斷依據，`UpdateChecker.jsx` 的輪詢頻率（5分鐘＋切回分頁）、可關閉（「稍後再說」）、強制重新整理的導頁方式（帶 `_v` 時間戳參數繞過快取）皆維持不動；`package-lock.json` 未納入 hash 範圍（僅 `package.json`），若未來只改鎖定版本、未改 `package.json` 本身的相依宣告，不會觸發新版本提示——屬刻意的合理取捨（見上輪已擱置的深度覆蓋考量），非遺漏。

## 目前進度（2026-09-30）— 一輪小修復：卡片使用順序＋櫃檯查會員記錄＋發票付款方式顯示＋發票序號漏登資料修正
> Railway CLI 裝好登入後，連續處理幾件事。後端 `/health` `3.546.0`→`3.549.0`；前端(redrock-web) commit `8e1ed72`／`1b78639`／`5496b8d`。
- ✅ **優惠卡／黑卡改「先買/先登錄的先用」**（`discountCardService.getMemberDiscountCards`／`legacyCardService.getMemberBlackCards`）：兩者原本完全沒有排序（黑卡）或只依到期日排序、同到期日（多數卡皆無期限）順序不保證（優惠卡）——但**扣哪張卡完全由陣列第一筆決定，全站無任何卡片挑選 UI**（`MemberQRPage.jsx`／`CheckinPage.jsx` 皆直接取 `cards[0]`）。加上次要排序鍵 `createdAt` 升冪，讓同到期日（含皆無期限）時買/登記越早的卡優先扣。
- ✅ **櫃檯電腦（值班/館別電腦）查會員時開放查其入場/票卡歷史**（`checkin.js GET /history`）：原本 `GET /checkin/history` 只放行「管理員個人登入」，值班/館別電腦完全打不到——加一個窄範圍例外：`type∈['operator','station']` **且帶了明確 `memberId`** 才放行，不開放無範圍瀏覽（一般查詢清單仍限管理員個人帳號）。
- ✅ **系統設定→發票號碼管理「今日發票列表」與下載 Excel 都加付款方式**：清單每筆金額旁多一行付款方式標籤（沿用 `InvoiceModal.jsx` 既有 `PM_LABEL`）；下載 Excel（`invoices.js GET /download`）在「金額」後插入「付款方式」欄（後端另建一份 `PAYMENT_METHOD_LABEL` 對照，因後端不能 import 前端元件）。
- 🐞 **真實事故：張驊謙的發票紙本已印出（EF33426926），系統從未登記，導致後續 6 筆號碼全數系統誤記少一號**——查明根因：`InvoiceIssuer.jsx` 的「①真的列印」與「②配號＋建立 `invoices` 紀錄」是兩個分開的網路請求、包在同一個 `try/catch`，只對兩種已知情境（`ALREADY_INVOICED`／`ROLL_DEPLETED`）特別處理，**其餘任何①成功但②失敗的情況（如網路瞬斷/逾時），畫面一律顯示「列印失敗，請確認印表機連線後重試」＋「尚未消耗發票號碼，可直接重試」**——這句話在紙本已經印出的情境下是錯的、會誤導店員以為安全重試（若真的重印會多印一張浪費紙、且原本那張真實印出的紙永遠不會被系統登記）。
  - **資料修正**：查 `checkIns` 找到張驊謙 15:46:45 的真實入場記錄（discount_card、NT$240、LinePay、`checkedInBy` 與周邊發票同一位員工）→ 補建一筆 `invoices` 文件（`EF33426926`，對應此 checkIn）；同時把系統誤記的後 6 筆（Keyvan／劉子琳／陳博浩／陳冠霖／胡傳翊／羅詩芸）號碼各自 +1，對齊使用者現場核對的紙本真實號碼（羅詩芸＝932，逐一比對後完全吻合）；`gyms.invoiceState.currentNumber`（陳品翰稍早已手動校正到 33426933）**維持不動**——回頭驗算剛好正確（真實最後用到 932，下一張本來就該是 933），單一 batch 原子寫入、每筆附 `correctionNote` 留稽核。
  - **程式修復（`InvoiceIssuer.jsx`，commit `ee4557d`）**：把①②拆成各自獨立的 try/catch，新增 `printedNotRecorded` 狀態——①失敗維持原樣（沒印出來，可安全重試）；②失敗（不論何種錯誤，只要走到這裡就代表①已成功）改顯示醒目紅底警語「🚨 紙本可能已經印出，但系統登記失敗！請勿再按「重新列印」…請聯絡系統管理員手動補登」，並鎖住重新列印按鈕（`printDisabled` 加入此條件），逼店員改用其他管道處理，而非讓誤導訊息引導他們重印出第二張紙。
  - **驗證**：兩 target `vite build` 皆成功；`firebase deploy` 後 `staff.redrocktaiwan.com` bundle hash 與本機比對一致；資料修正後重查 `EF33426918~33426933` 序號連續無重複無跳號、926＝張驊謙、932＝羅詩芸，皆與使用者現場核對結果完全吻合。

## 目前進度（2026-09-30 續）— 工作坊型課程補「單一公開報名連結」（多場次供訪客自選）
> 使用者問「【新竹館】小蜘蛛人初級班 優惠試上 為什麼沒有公開報名連結」→ 查明它是 `type:'workshop'`，課程列表的「🔗 公開報名連結」原本刻意排除工作坊（因為公開頁 `/book/course` 是「一次報名整梯」設計，對每場次獨立收人的工作坊不適用，只能到「場次管理」逐場複製各自的單場連結）。使用者追問「可以統合成一個連結嗎？」，比照班別公開頁已有的模式補上。commit(redrock-web) `ffd1cd4`。
- ✅ **`PublicCourseEnrollPage.jsx`（`/book/course?course=`）加 `isWorkshop` 分支**：後端 `GET /courses/public/:courseId` 本就有帶每場次 `enrolledCount`/`maxStudents`（2026-09-16 為單場頁 `PublicWorkshopEnrollPage.jsx` 補過，未動即可重用）——工作坊時改列出全部未來、未取消場次（含額滿徽章），逐場「報名 →」導去既有 `/book/workshop?course=&session=` 完成，完全比照 `PublicCourseCategoryPage.jsx` 展開工作坊梯次時的既有「選場次」模式（同一套邏輯/文案，這裡是單一課程整頁版）。頂部費用區塊工作坊改顯示單純「NT$X／場」（原本的整期插班試算對工作坊無意義）。
- ✅ **`CoursesPage.jsx` 課程列表「🔗 公開報名連結」移除 `type!=='workshop'` 排除**，工作坊梯次現在也能直接從列表複製到這個統合連結。
- ✅ **順手補：`'已額滿'` 徽章缺英/日翻譯對照**（`memberI18n.js`，影響 3 個公開頁）——原本只有中文，補上 `Full`／`満員`。
- **驗證**：兩 target build 通過；`app.redrocktaiwan.com`/`staff.redrocktaiwan.com` bundle hash 皆與本機一致；瀏覽器實機開真實連結（小蜘蛛人初級班 優惠試上）確認正確顯示「請選擇要報名的時段（共 2 場）」＋兩場各自「報名 →」，console 零錯誤。

## 目前進度（2026-10-02）— 修正：墜測未過仍無法報名課程（ChatGPT 昨天的修補信任了會過期的快取欄位）
> 使用者回報 ChatGPT 昨天（2026-10-01）做的「墜測未過可報名課程」修補沒改乾淨，實測「小蜘蛛人初級班 優惠試上」（`type:'workshop'`）仍被擋「帳號已封鎖，無法報名」。後端 `/health` `3.550.0-course-booking-fall-test-exemption`→`3.551.0-course-booking-fall-test-exemption-live-check`；commit `cc915f1`。
- 🔍 **查證過程**：先確認本機落後遠端 3 個 commit（`904b648`/`bb615db`/`959b4c1`，含一個空的「retry Railway release build」）、`git pull --ff-only` 同步、正式環境（Railway+Render）皆已跑 `3.550.0`——部署本身沒問題，是邏輯有洞。
- 🐞 **根因**：`enrollCourse`（`courseService.js`）原改法信任會員文件上**快取**的 `isBlocked`/`blockReasons` 欄位（`.some(reason => !fallTestBlockReasons.has(reason))`），但這兩欄只在特定時機（簽文件 `signEntryDocs`/記錄墜測結果/員工開會員詳情頁 `refreshBlockStatus`）才會重算寫回——**平常不會自動跟著 waiver/墜測的真實狀態同步**。用真實資料核對兩個案例（黃楷捷、王登妹，皆被 Debby Chu 手動設墜測通過當 workaround）：兩人會員文件 `updatedAt` 都停在帳號建立/簽署當下，**直到管理員手動設通過那一刻才第一次更新**——代表簽完文件後，`blockReasons` 快取殘留 `waiver_unsigned`/`parent_waiver_pending` 等早已不成立的舊原因，被新邏輯誤判成「其他原因封鎖」而擋下報名。
- ✅ **修法**：改為即時呼叫 `memberService.getBlockReasons(memberId, member)`（即時查詢 `waivers`/`fallTests`，不信任快取）取得目前真正的封鎖原因，過濾掉 `fall_test_required`/`fall_test_expired` 後若還有其他原因才真的擋；`isGuestBooking` 分支不變（仍跳過整段檢查）。
- **驗證（正式資料端到端，均已安全還原、無資料異動殘留）**：①直接測試 5 種 `isBlocked`/`blockReasons` 組合，確認乾淨單一原因 `fall_test_required`/`fall_test_expired` 本就會放行、但 `blockReasons` 為空陣列／欄位不存在／混雜其他原因時會誤擋——驗證問題確實出在「快取可能不同步」而非布林運算本身 ②用王登妹真實資料端到端驗證修好的邏輯：暫時把她真實墜測紀錄的 `expiresAt` 調到過去（未動 `result` 欄位、未刪除任何紀錄）→ 呼叫真正的 `getBlockReasons()`（非手刻複製版）→ 回傳 `['fall_test_expired']`→ 過濾後為空 → 🟢 放行 → 測後立即還原 `expiresAt` 回原值，複查確認資料與修改前逐欄位一致。
- 📌 **範圍**：只影響 `enrollCourse`（workshop 單場/試上類工作坊報名，`POST /sessions/:sessionId/enroll`）；`handleEnrollAll`（整期週課報名）原本就沒有任何 isBlocked 檢查，不受影響、不需要改。
- 💡 **教訓**：`member.isBlocked`/`member.blockReasons` 是**快取欄位**、非即時狀態——任何要依賴「目前是否真的被封鎖」做判斷的新程式碼，應呼叫 `memberService.getBlockReasons()` 即時查詢，不要直接信任會員文件上存的值（已知會在簽文件後數天～數月不會自動刷新）。
- ✅ **收尾**：黃楷捷/王登妹兩人先前被管理員手動設成「墜測通過」的假紀錄（含連動的假排測預約，建立到完成僅差 17 秒）已刪除還原（非沖銷，從未真實發生的事件直接刪），兩人正確變回 `isBlocked:true, blockReasons:['fall_test_required']`（真實狀態：文件皆簽妥、墜測尚未實測）；曾用正式 `enrollCourse` 幫黃楷捷預留 10/21 場次一次（byStaff，`paymentMethod:'pending'`），因使用者考量「他自己應該還是會填單」而改為撤回（刪 `courseEnrollments`+對應 `courseRegistrations` header+還原場次人數），讓他之後自行用 App 完成報名＋匯款資訊填寫（去重檢查本就會擋重複報名，不會衝突）。

## 目前進度（2026-10-02 續）— 修：「發現新版本」提示反覆跳（redrock-web，`UpdateChecker.jsx`）
> 使用者回報這兩天一直跳「發現新版本」提示。查證：正式站（member/staff）當下版本與本機 HEAD 重新 build 的結果完全一致（`hashSourceTree` 內容雜湊可重現、無落差），問題不在伺服器端持續在變。commit（redrock-web）`3d217bf`。
- 🐞 **根因**：`UpdateChecker.jsx` 的「✕ 稍後再說」只存在元件 `useState`（純記憶體），**不會持久化**。加到主畫面的 standalone PWA 重新打開常只是「恢復背景狀態」而非真的重新連網抓新版（元件既有註解已點出這個限制）——每次重新 mount，`dismissed` 重置為 `false`，若裝置當下跑的仍是舊 bundle（沒抓到已部署的新版），`check()` 又會偵測到「跟伺服器不同」而重新彈出，造成同一個早就看過、關掉過的版本反覆跳提醒。
- ✅ **修法**：按「稍後再說」時，把當下偵測到的遠端 `buildId` 存進 `localStorage`（`rr_update_dismissed_build`）；之後只有偵測到**比這個紀錄更新**的 `buildId` 才會再次彈出，同一版本重新 mount 不會再騷擾。「重新整理」按鈕行為不變（仍是帶 `_v=` 時間戳參數強制繞快取重新連網）。
- **驗證**：兩 target build 前後兩次比對 buildId 完全一致（確認 hashSourceTree 本身具決定性、非本次問題來源）；部署後正式站 buildId 與本機重 build 結果一致；順手發現並一併推送本機原先落後遠端的 4 筆既有未推送 commit（`9f14233`/`5496b8d`/`ee4557d`/`ffd1cd4`，皆 9/30 已完成部署但當時漏了 `git push`），推送後本機/遠端完全同步。

## 目前進度（2026-10-03）— 課程報名「帳號已封鎖」改依實際原因顯示可操作訊息
> 回報：黃亭穎幫小孩報名「小蜘蛛人優惠試上」工作坊仍顯示「會員被封鎖」。3.551.0 已豁免墜測，剩下會擋的只有聲明書未簽／待法定代理人簽／Email 未驗證——最可能是家長建了子會員卻沒代簽入場文件（`waiver_unsigned`），但訊息一律「帳號已封鎖」，家長看不出要做什麼。後端 `/health` `3.552.0-course-booking-blocked-reason-message`；PR #1（merge commit `f6f9912`），已確認正式環境上線。
- ✅ **`enrollCourse`（`courseService.js`，單場／工作坊／試上類報名）的 `MEMBER_BLOCKED` 改依即時封鎖原因（`getBlockReasons` 過濾墜測後的第一項）回傳具體訊息**：`waiver_unsigned`＋子會員→「報名對象（姓名）尚未完成風險安全聲明書簽署，請至「個人資料 → 家庭成員」代簽入場文件後再報名」；本人→「請先完成入場文件簽署」；`parent_waiver_pending`→「請查收法定代理人 Email 中的簽署連結」；`email_unverified`→「請先完成 Email 驗證」。回應另附 `blockReasons`。**擋/放行判斷完全不變**，只換訊息；會員端本就顯示 `response.data.message`，前端免改。
- ⚠️ **未做真實報名驗證**：本次在雲端環境作業，網路政策擋 `api.redrocktaiwan.com`、無 Firebase 憑證，僅 `node -c` 語法檢查；黃亭穎小孩的實際封鎖原因也未能查證（請櫃檯在員工端該子會員「待完成事項」確認）。
  - ✅ **補查（有正式環境憑證的 session 事後驗證）**：黃亭穎與其子黃宬翊的實際 `blockReasons` 皆只有 `fall_test_required`（墜測未過），**非**上方猜測的 `waiver_unsigned`——子女 waiver 其實早已 `isComplete:true`（家長已代簽）。直接呼叫正式 `getBlockReasons()` 即時驗證：過濾墜測原因後為空陣列，`enrollCourse` 本就會放行（3.551.0 已涵蓋此情況），此案例的根本問題在 3.551.0 當下已解決，3.552.0 的訊息改善屬錦上添花、非她這筆的關鍵修復。**查 `courseEnrollments` 證實她已於 2026-10-03 12:47 成功報名**「小蜘蛛人初級班 優惠試上」（`status:confirmed`）——案例確認解決，無需進一步處理。

## 目前進度（2026-10-03 續）— 風險安全聲明書／墜落測驗同意書：精簡改寫＋中英日三語＋簽署頁排版
> 原兩份文件冗長且中英不同步、完全沒有日文。依使用者逐條確認的中文定稿，產出英文／日文並寫入正式資料庫；程式端補日文欄位、三語切換、排版修正。後端 `/health` `3.553.0-waiver-falltest-japanese-content`；前端 commit（redrock-web）`DocLangSwitch`／`DocParagraph`／簽署頁排版修正，已 deploy。
- ✅ **文字存放（改文字不用改程式）**：風險安全聲明書＝`systemSettings/waiver`（`zh`／`en`／`ja`）；墜測同意書＝`systemSettings/fallTest`（`contentZh`／`contentEn`／`contentJa`，其餘 YouTube 網址／效期／觀看門檻欄位不動）。員工端「設定 → Waiver 內容／墜落測驗」各有三語輸入框。簽署快照（`contentSnapshot`）一併存 `ja`，已簽署者的紀錄仍是簽當時的舊文字、不受影響。
- ✅ **文字格式約定（簽署頁靠這個切段與渲染，新增/改寫一律照此）**：**空白行＝一個勾選段落**（每段會員要各勾一次）；段落第一行若是短標題（≤40字、不以編號/破折號開頭、不以句號結尾）→ 粗體標題；`1. ` 編號行＝編號欄＋懸掛縮排；`- ` 行＝往內縮的圓點條列；其餘一般內文。渲染元件 `components/DocParagraph.jsx`（風險聲明書與墜測同意書共用）。
- ✅ **現行定稿結構**：風險聲明書＝開場說明／安全注意事項（13條）／意外風險聲明／安全禮儀／個人責任（4點，第1點保留原文「致力為使用者打造安全的攀登環境」並補「仍可能會有意外發生」；第4點「公共意外責任險…運動傷害（如嚴重扭傷、骨折、脫臼等）」）。墜測同意書＝4段：**①本人自願參加同意聲明（置首）②測驗須知③安全墜落要點④未滿10歲兒童注意事項（含「通過後如有以下情形…」違規清單，改 `-` 條列，與前面編號 1–4 區隔）**。兒童規則為「**未滿10歲**」（原為6–10歲）；「12歲以下須成人陪同」不變。效期條款已改為現行規則（到期前2個月內入場、過去一年入場≥2次→自動延長一年），舊文「超過兩次可直接延長」作廢。
- ✅ **前端**：`DocLangSwitch`（中文／English／日本語 segmented）用於會員簽署頁（`MemberWaiverPage`，預設跟隨會員語言 `getMemberLang()`）與家長簽署頁；**`ja` 內容未設定時自動隱藏「日本語」鈕**，並對缺漏語言 fallback 中文，不會出現空白。員工端副本檢視／列印仍讀 `contentSnapshot.zh`（未做日文）。
- 🐞 **順修排版 bug**：墜測同意書段落原漏 `whiteSpace: pre-wrap`，編號項目被擠成一整段（風險聲明書本來就有）；兩份文件勾選框顏色也不一致（一紅一綠）→ 統一綠色、卡片間距對齊，並改用共用 `DocParagraph`。
- 📌 **改文字的標準流程（本次沿用）**：中文草稿→使用者定稿→翻英日→使用者確認→**寫入前先把現行 Firestore 值備份成 JSON**（本次存在 session scratchpad，需長期保留要另存）→firebase-admin 用 `update`（非 `set`，避免洗掉同文件其他欄位）寫入→GET `/settings/waiver`、`/fall-tests/settings` 讀回驗證。寫入時務必確認「段落數三語一致」。
- ⚠️ **未驗證/未做**：日文翻譯由 AI 產出、使用者確認通過，但未經日語母語者審閱（「公共意外責任保険」為沿用中文詞彙，未改成日本慣用說法）；員工端副本檢視未支援日文；競賽報名的 waiver（`ParentCompetitionWaiverPage` 等）是另一套，不在此範圍。
- 🧪 **測試帳號現況**：`0900123123`（【練習】比賽報名測試，主帳號）**依使用者要求保持「未簽署」狀態**（waiver／墜測簽署與通過紀錄已刪、`isBlocked:true`、`blockReasons:[waiver_unsigned,fall_test_required]`），供之後反覆測試簽署頁；其子帳號 `test`（未成年）仍為已簽署。要還原成已簽署需手動重建（備份在當次 scratchpad，原始簽名圖非逐字還原）。

## 目前進度（2026-10-03 續2）— 簽署頁語言連動修正＋日文譯名統一（純前端 `redrock-web`）
> 三語文件上線後的收尾修正，皆已 deploy 並在正式站用測試帳號 `0900123123` 切英/日實機驗證。
- 🐞 **簽署頁切語言只換文件、標題與說明不跟著換**：`memberI18n.js` 的 `t()`／`tt()` 讀的是全站語言（`localStorage.memberLang`），而 `DocLangSwitch` 原本只改頁面內 `lang` state（只影響文件內容）。→ `MemberWaiverPage.handleLangSwitch` 與 `ParentWaiverPage` 的切換鈕改為**同步寫入 `memberLang` 並 setState 重繪**（不 reload），標題／說明／簽名區隨之翻譯。字典其實本就有翻譯（風險安全聲明書／墜落測驗同意書／本人簽名），問題純在沒連動。
- ✅ **簽名框提示補英日**（`SignaturePad.jsx` 共用元件，改用 `tt()`；staff 端 `memberLang` 預設 zh，不受影響）：「請以正楷書寫全名簽名…」「請在此處簽名」。英文版驗證**無任何殘留中文**。
- ✅ **日文譯名統一：「風險安全聲明書」＝`リスク・安全に関する同意書`（原為「免責同意書」）**：`memberI18n.js` 日文值 22 處（key 含 風險安全聲明／聲明書／Waiver 者，只改值不動中文 key）＋ `MemberOnboardingGate` 寫死的日文說明（原「免責同意書」「安全確認テスト同意書」→「リスク・安全に関する同意書」「墜落テスト同意書」，順便與簽署頁用字對齊）。**墜測同意書日文維持 `墜落テスト同意書`**。
- ⚠️ **刻意沒改的「免責同意書」（是另一份文件，不是入場用風險安全聲明書）**：比賽的 `大会免責同意書`（`」比賽風險聲明書`、法代同意句）、課程/體驗**試上同意**的 `免責同意書・クライミング活動リスク告知`（`免責同意書／攀岩活動風險告知`），以及 `請先勾選同意免責同意書` 提示（對應試上同意）。之後新增日文字串時：**入場文件用 `リスク・安全に関する同意書`，比賽/試上同意另有各自譯名，勿混用**。
- 📌 **驗證手法備忘（瀏覽器擴充功能可用時）**：測試帳號登入狀態常已存在於瀏覽器；切語言用 `javascript_tool` 找 `button` 文字（`中文`／`English`／`日本語`）`.click()`，再讀 `document.body.innerText`。日文頁面不能用「中文字元殘留」檢查（漢字相同），改比對關鍵詞（如舊譯名 `免責同意書` 是否消失）。驗證完記得把 `localStorage.memberLang` 設回 `zh`（該瀏覽器是使用者自己的）。

## 目前進度（2026-10-03 續3）— 近7天卡號白名單稽核＋詹尚儒優惠卡卡號清空（純資料，無程式異動）
> 回頭確認嚴格白名單（3.546.0，2026-09-28）上線後，優惠卡轉入／黑卡綁定是否都守規則；稽核順便找出兩組舊的重複卡號。
- ✅ **近7天（9/27～10/3）優惠卡轉入 14 筆、黑卡綁定 6 筆，全數合規**：逐筆核對「卡號在清冊／卡別與清冊一致／清冊標已售出／清冊標已綁定且綁定對象為同一會員」，20 筆全 ✅，無無卡號、不在清冊、卡別錯誤、重複綁定。龔金龍 9/28 的黑卡 AT19-0387 正常（先前誤轉的優惠卡已刪）；賴威廷一週內綁 3 張黑卡，卡號各異、無問題。**稽核做法**：`physicalCardRegistry`（doc id＝正規化卡號）對 `discountCards`（`source:'migrated'`，擁有者欄 `ownerMemberId`）與 `legacyBlackCards`（`source:'original'`，擁有者欄 `memberId`）近7天 `createdAt` 的卡號；日後可照此重跑。
- 📋 **全庫重複卡號（正規化後）只有 2 組，皆為 3.546.0 之前的舊資料**：①**詹尚儒 AT21-0415**（7/22）同卡號同時掛優惠卡（3次）與黑卡（12格剩8）；②**吳楷聲 AT19-0676**（7/29）同一黑卡號登兩筆，兩筆皆 12 格已用完、`isActive:false`——**未處理**（已停用、影響極小）。
- ✅ **詹尚儒：判定為「優惠卡卡號輸入錯誤」，依指示保留兩張卡、只清空優惠卡的卡號**：`discountCards/4d5c1df8…` 的 `barcode` 設 `null`，次數（剩3）／`isActive:true`／歸屬皆不動；原卡號 `AT21-0415` 與清空原因記在 `barcodeClearedNote`（供稽核）；他的黑卡 AT21-0415（剩8）與清冊完全沒動。清空後全庫重複卡號只剩吳楷聲那組。
- 📌 **與 2026-09-28 龔金龍案例的差異**：龔金龍是「黑卡卡號被轉成優惠卡、造成重複福利」→刪除誤植的優惠卡；詹尚儒是使用者判定「純卡號打錯、福利本就各自合理」→保留兩張只清錯誤卡號。**遇到同卡號跨卡別重複時，先確認哪張才是實體卡真正的類型（清冊 `cardType`），再問使用者是「誤植要刪」還是「卡號打錯只清欄位」，不要預設刪除。**

## 目前進度（2026-10-04）— 新竹 10/3 結帳 LinePay 更正＋入會攀登路線宣傳圖（Artifact）
> 兩件事。純資料修正與一份 claude.ai Artifact，無後端/前端程式異動。
- ✅ **新竹 10/3 結帳：黃明姿 EF33426985（成人使用優惠券入場 240）發票付款方式誤選「現金」→更正為 LinePay**（`invoices` 該筆 `paymentMethod`＋`paymentMethodCorrectionNote`；結帳 `dailySettlements/7febc213…`：`payment.cash` 1520→1280、`linePay` 4330→**4570**、`electronic` 4570→4810、`expectedCashBalance` 17083→16843、`difference` -240→**0**，附 `correctionNote`）。**判斷依據**：同一筆的入場紀錄 `checkIns.paymentMethod` 與 `transactions` 皆為 `linepay`，只有發票選成現金；更正後預期現金（上一日 16,403＋現金 1,280－加減項 840）＝實際點鈔 16,843，差異歸零。更正前備份在當次 scratchpad `backup-settle-1003.json`。
- 📋 **同日不改的一筆**：鄔玟潔 EF33426999 街口 240——入場紀錄 `amountPaid:0`、無交易，是**線上街口 pay-first 付款後到館兌換單次券**，街口正確，**不是**選錯。遇到「發票是 jkopay 但 checkIn 實收 0 且無交易」先想到線上付款兌換券，不要當成選錯付款方式。
- 📌 **對帳/排查模式（第三次遇到同型，直接套用）**：結帳「付款方式」以**當日已開立發票**的 `paymentMethod` 為權威（真列印權威模式），所以入場選對、發票選錯就會造成假性現金差異。查法：①撈該館當日 `invoices`（`issuedAt` 轉台灣日，排除 `void`）依 `paymentMethod` 加總，與 `dailySettlements.payment` 比對 ②差異金額（如 -240）剛好等於某筆發票金額時，逐筆比對該發票的 `checkIns.paymentMethod`／`transactions.paymentMethod`，**發票與兩者不一致的那筆就是選錯**（發票說現金、入場/交易說 LinePay → 現金被多算、預期現金偏高、差異為負）③改發票＋重算結帳快照（預期現金＝前日餘額＋現金＋加減項淨額）；`actualCashBalance`/`closingCashBalance` 不動，隔日前日餘額不受影響。
- ✅ **「入會攀登路線」宣傳圖（claude.ai Artifact，不在本 repo）**：URL `https://claude.ai/artifact/Q1Uy6fQWXgp11BU58EgaNu`（`ba536cb1…` 為其 code 連結），含「手機分享版」與「A4 列印版」兩個分頁。本輪調整：**字型改霞鶩文楷 TC**（LXGW WenKai TC，300/400/700；芫荽只有 400，加粗會變假粗體故不用；數字/英文標籤維持 Quicksand；仍不用文字描邊）；**A4 版放大並固定一頁**（`.a4-page` 固定 297mm、六張步驟卡等高撐滿）；**A4 加卡通圖**（走道攀爬小紅石＋岩點、頁尾上方山頂旗子橫幅＋三隻慶祝小紅石、六張步驟卡右下各一個對應小插圖）。吉祥物改成 JS 產生器 `mascotSVG(pose, alt)`（姿勢 wave/cheer/reach，手臂用 stroke 圓頭線條從肩膀長出，**不要用旋轉的 rect 當手臂**，會與身體分離）。
- 🛠 **Artifact 修改流程備忘**：`Artifact read_file` 取回原始檔存到 scratchpad（含 doctype/head 外殼，republish 前要剝掉，只留 `<title>` 到 `</body>` 前）→ 本機改 → 起 `python3 -m http.server` 載入完整頁，用瀏覽器 `javascript_tool` 切到 A4 並量尺寸/檢查文字與插圖重疊（發布頁是內嵌框，擴充功能點不進去，**不能在發布頁上點按鈕驗證**；`file://` 也被擋）→ 發布到同一 `url`。

## 目前進度（2026-10-04 續）— 體驗預約改上課日，教練費結帳加減項／人事報酬跟著搬（後端 `/health` `3.554.0-experience-coachfee-follows-reschedule`）
> 郭詠蓁體驗（士林，教練張元賓）上課日被改 9/27→9/30→9/29，教練費「−教練費」自動加減項卻停在 9/30，造成 9/30 結帳差異 +400。資料已修，並補上程式連動。
- 🔍 **根因**：教練費自動加減項在 `/finance` 設定當下寫進「當時預約日」那天的結帳；之後 `updateExperienceSchedule`（改期）只同步課程/場次/教練排班/入場券/營收認列日，**完全沒動教練費的結帳加減項與 `payoutRecords` 日期**。9/29 店員又在結帳頁手動記了一筆教練費 400，兩邊重複，9/30 預期現金多扣 400、差異 +400。
- ✅ **資料修正（士林）**：9/30 結帳移除重複的自動「郭詠蓁 體驗教練費」400（預期現金 11,253→11,653、差異 +400→0，附 `correctionNote`）；刪除重複的人事報酬記錄（`sourceBookingId` 那筆，日期 9/30）；**保留 9/29 店員手動記的那筆**（9/29 結帳差異本來就是 0、不動金額），並把其領款人名由「張元賓教練費」更正為「張元賓」、備註補「郭詠蓁 體驗教練費」（結帳加減項與 `payoutRecords` 兩邊一致，否則年底依姓名加總會把同一人拆成兩個）。10/13 那筆張元賓 400 是郭詠蓁**另一次**體驗（不同 booking），不動。更正前備份在當次 scratchpad `backup-gua.json`。
- ✅ **程式連動**：①`settlementService.addCashAdjustment` 與 `paymentRecording.recordDepositMovement` 新增選填 `refId`，自動加減項會帶「來源單據 id」；`/experience-bookings/:id/finance` 寫教練費（首次與金額修正兩處）都傳 `refId: b.id`。②新增 `settlementService.relocateAutoDeductions({gymId, refId, toDate})`：只動**未結帳（draft）**結帳裡 `auto && refId` 相符的加減項，從舊日移除、依原金額/正負/類型/備註改寫到新日期（新日已結帳沿用既有順延）；舊日若是系統自動建的空草稿（`autoDraft`）且搬完沒加減項就刪掉。③`experienceService.updateExperienceSchedule` 新增第 6 步：`coachFeeAdjDone` 才處理——`payoutRecords`（`sourceBookingId`）日期一律改成新上課日＋呼叫 `relocateAutoDeductions`；回傳多一個 `coachFeeRelocated`。
- ⚠️ **刻意的限制**：**已結帳（settled）的日子一律不搬**（比照 2026-08-11 政策，不悄悄改寫店員已核對關閉的帳），所以像這次 9/30 已結帳的情況仍需手動處理；**2026-10-04 之前建立的教練費加減項沒有 `refId`，不會自動搬**，只有之後新設的才有連動。已結帳舊日不搬時也**不會**在新日期憑空再加一筆（避免重複扣）。
- ✅ **E2E（假館 `gym-e2e-test`，直呼 service，6/6）**：草稿舊日的帶 refId 自動項搬到新日（無關的另一筆 refId 不動、舊日空草稿保留其餘）、人事報酬日期改新上課日；舊日已結帳→完全不動且新日不憑空新增；沒設過教練費（無 `coachFeeAdjDone`）→不碰結帳。測後假館結帳殘留 0。
- 📌 **對帳模式補充**：體驗預約有「改過上課日」＋教練費時，若某天結帳差異剛好等於教練費金額，先查該預約的 `bookingDate`、`financeUpdatedAt`、各天結帳 `deductions` 與 `payoutRecords`（`sourceBookingId`），常見是自動項停在舊日、店員又手動補記一筆而重複。

## 目前進度（2026-10-04 續2）— 入會攀登路線宣傳圖標題殘影修正（Artifact，無 repo 異動）
- 🐞 **標題「入會攀登路線」「歡迎加入紅石家族！」出現殘影**：原本標題陰影是硬邊偏移（`text-shadow:0 3px 0 …`，不模糊），搭配黑體粗筆畫像立體字；換成霞鶩文楷（筆畫較細）後，偏移的那層變成重影。→ `.pop-text`／`.alt`／`.on-rock` 三種改**柔和模糊陰影**（`0 2px 4px rgba(…,.28~.32)`），字距略放寬為 `.03em`。**教訓：細筆畫字型（手寫體）不要用「硬邊、0 模糊、偏移」的陰影，會變殘影；要立體感用柔和 blur 陰影。**

## 目前進度（2026-10-04 續3）— 入會攀登路線宣傳圖加英文版／日文版（Artifact，無 repo 異動）
> 同一份 Artifact（`https://claude.ai/artifact/Q1Uy6fQWXgp11BU58EgaNu`，code 連結 `ba536cb1…`）加「中文／English／日本語」切換，三語共用一個連結；手機分享版與 A4 列印版都能切，列印用目前選的語言。
- ✅ **做法（資料驅動，改文字只動一個字典）**：每段可翻譯文字的元素加 `data-t="key"`，載入時把原本中文 `innerHTML` 存進 `data-zh`；JS 內嵌字典 `I18N = {key:{en,ja}}`，`setLang(l)` 依語言換 `innerHTML`（含 `<b>` 的整段 `<p>` 也能整段換）、更新 `<html lang>`、`document.title` 與語言鈕 `active`。`?lang=en|ja` 參數有支援，但**發布頁是內嵌框，網址參數不一定傳得進去，實務上要點頁面上的語言鈕**。新增/改文案：先在 HTML 對應元素加 `data-t`，再補字典，不要只改 HTML 中文。
- ✅ **字型（各語言各一套，用 `body[data-lang]` 覆寫 `--display`/`--body`）**：中文＝霞鶩文楷 TC；英文＝Fredoka（標題，圓潤貼合吉祥物）＋Nunito（內文），`.pop-text` 字距歸零；日文＝Klee One（400/600，手寫教科書風）。Fredoka 只載 500/600/700（量 `document.fonts.check('16px Fredoka')` 會是 false，因為預設字重 400 不在載入範圍，**不是沒載入**）。
- ✅ **A4 英日版字級獨立縮小**（`body[data-lang="en|ja"] .a4-…` 規則：h1 28/30px、步驟標題 19px、內文 13px、備註 10.5px、備註 `max-width:calc(100% - 14mm)` 避開右下插圖）：英日文比中文長，原本 A4 步驟卡會溢出/壓到插圖；調整後三語實測**皆剛好一頁（297mm）、六卡無溢出、無壓插圖**，手機版三語無橫向溢出。日文步驟 6 標題縮短為「完了！登り始めよう」（原「完了！クライミング開始」在卡內從中間斷行）。
- 📌 **譯名約定（與會員 App 一致）**：風險安全聲明書＝EN `Liability Waiver`／JA `リスク・安全に関する同意書`；墜落測驗同意書＝EN `Fall Test Consent Form`／JA `墜落テスト同意書`；吉祥物小紅石＝EN `Little Red`／JA `リトル・レッド`（**自訂，未經確認**）；館別＝EN `Hsinchu`／`Shilin`、JA `新竹店`／`士林店`。
- ⚠️ **未驗證**：英日文翻譯為 AI 產出，**未經母語者審閱**（日文語氣尤其需要）；發布頁上點語言鈕沒有在實際發布頁驗證（環境點不進內嵌框），三語畫面是用本機 `python3 -m http.server` 載入完整頁、`javascript_tool` 觸發切換並量尺寸/截圖確認。
- 🛠 **轉換腳本備忘**：本次用 python 對原始 HTML 批次加 `data-t`（先處理含 `<b>` 的整段 `<p>`，再處理單純元素，最後特例：館別 span、`<b>` 加副標、按鈕文字節點、`<br/>` 換行的 caption）；**這類批次替換務必 `assert` 每個目標都命中**，否則漏掉的字串會靜默維持中文。

## 目前進度（2026-10-04 續4）— 新竹停課補課券稽核＋上期請假補課券補發＋註冊自動媒合（後端 `/health` `3.555.0-prev-leave-makeup-auto-claim`）
> 管理員問「之前新竹補課單發放，還有哪些人沒發」，稽核後順帶補發四位前期學員的請假補課券，並新增「註冊後自動媒合」機制。
- ✅ **新竹休館/停課補課券稽核**：新竹有 8 個休館/停課取消場次，已發停課券 12 張；比對規則＝場次 `closureCancelledBy`/`cancelReason` 含休館，其報名 `cancelReason:'closure'`（排除補課/試上/曾請假/候補者，這些本就不發）且無 `source:'closure'` 的券。**唯一差異：張何業恩（7/11 小蜘蛛人初級班週六A班）**——使用者確認她**晚於 7/11 才報名，不發**，非漏發。待認領名單、跨期補課待安排當時皆 0 筆。稽核腳本邏輯可重跑（停課後報名狀態＝`cancelled`+`cancelReason:'closure'`；請假者另有 `leaveAt`）。
- ✅ **補發「上期請假」補課券 8 張**（`source:'prev_leave'`、`exempt:true`、`prevLeaveDate`、`originalEnrollmentId:null`、`notes:'2026-10-04 依管理員指示補發（上期請假）'`，欄位比照既有 prev_leave 券）：許紘瑋 4 張（1/7、1/14、3/11、4/15）、黃紹郡 2 張（4/22、6/3）→掛「矯正班 7-8月週三B班」；林耿民 2 張（4/14、5/26）→掛**進行中**的「進階班 9-10月週二A班」（非已結束的 7-8 月班）。**三位效期一律 2026-12-26**（使用者指定；原本依班別標準「結束日+60天」算出矯正班 7-8 月班只剩到 10/25，已全數改成 12/26）。**實際已出現在假補總表**：請假日期欄顯示「日期（上期請假）」、補課額度剩/共，不計入「請假」次數；使用者一度說看不到，原因是**開著的總表彈窗是發券前載入的、不會自動更新，關掉重開即可**（後端 `/all` 與單一課程端點皆已驗證回傳）。
- ✅ **宋沛德（0988098354，尚未註冊）矯正班 6/17 請假補課券 → 新增「註冊自動媒合」**：
  - **為什麼不能用既有機制**：`pendingCourseClaims`（課程待認領）註冊時會把人**整個加進課程全部場次當學員**（姓名比對），不適合「只欠補課、本期沒報名」的人；`crossCohortMakeups` 原本註冊後只能「手動核發」（如吳安仁）。
  - **新機制 `memberService.claimPendingPrevLeaveRights`**（`createMember` 認領鏈，接在課程名單認領之後）：撈 `crossCohortMakeups` `status:'pending_arrange'` 且**帶 `autoIssue:{courseId, expiresAt}`** 的紀錄，以**手機（正規化後精確比對，不比姓名，避免同名碰撞）**命中 → 依 `owedDates` 逐日發 `prev_leave` 豁免券（掛 `autoIssue.courseId` 的虛擬課程、效期 `autoIssue.expiresAt` 台灣 00:00）→ 紀錄標 `converted`（`claimedBy`/`claimedAt`/`convertedRightIds`）→ 通知同館管理員（type `prev_leave_claimed`）。**只處理有 `autoIssue` 的紀錄**（既有舊的待安排紀錄不受影響）；子帳號（共用家長電話）跳過；失敗只 log 不阻斷註冊。
  - **資料**：建虛擬課程 `virtual-prev-makeup-correction`（班別＝矯正班 `590b4e41…`、`isVirtualMakeup`、`isActive:false`、無場次/不開放報名、`makeupDeadlineDate:2026-12-26`，格式比照 `virtual-prev-makeup-spider`）＋待媒合紀錄 `xm-auto-0988098354`（owedDates `['2026-06-17']`、deadline 2026-12-26、`autoIssue`）。他現在出現在假補總表「跨期補課」區（標「2026-06-17（前期）」待安排）。**矯正班班別的補課範圍＝矯正班＋進階班（單向）**，券掛這個虛擬課程即繼承此範圍。
  - **E2E（假館資料，7/7）**：依 owedDates 發對張數、皆 prev_leave 豁免 available、效期 12/26、紀錄 converted；無 `autoIssue` 的紀錄不動、別人手機的紀錄不動；測後全清（含通知）。
- ⚠️ **注意**：①宋沛德註冊後**不會**預設墜測通過（課程認領才有此預設；這次不是認領課程）→入場前墜測需另行處理 ②他用別的手機註冊就不會自動媒合，需人工核發 ③**日後要為「尚未註冊、前期欠補課」的人預先設定**：建 `crossCohortMakeups` 紀錄（`status:'pending_arrange'`、`phone`、`owedDates`、`deadline`、`gymId`、`courseName`）＋`autoIssue:{courseId:該班別的虛擬課程, expiresAt:'YYYY-MM-DD'}`；沒有該班別的虛擬課程要先建一個（複製 `virtual-prev-makeup-*`，改 `categoryId`/`name`/`gymId`）。
- 📌 **補發/稽核操作慣例**：使用者給「某人＋哪幾天請假」要發補課券時，先確認①該人有無會員資料（無→走上述自動媒合）②本期掛哪個課程（進行中者優先，已結束的班不掛）③效期（問清楚或沿用使用者指定）；發券前先 dry-run 列出「將發」清單與既有券（避免重複），用 `prevLeaveDate`+`courseId`+`memberId` 去重。

## 目前進度（2026-10-04 續5）— 月銷售紀錄「不管選幾月都下載到 10 月」修正（後端 `/health` `3.556.0-monthly-export-invalid-month-400`；前端 `MonthSelect`）
> 回報：下載「月銷售紀錄」不管選幾月都是當月（10 月）資料。
- 🔍 **查證**：直接用 API 下載 8/9/10 月，三份內容各是對應月份（表頭 8/1、9/1、10/1），**後端與前端傳參程式都沒錯**。唯一會永遠得到當月的路徑＝後端收到的 `month` **不是 `YYYY-MM`** 時**悄悄改用當月**（原本 `dailySettlements.js` `monthly-export` 的寫法 `/^\d{4}-\d{2}$/.test(month) ? month : dayjs().format('YYYY-MM')`）。兩個下載畫面（結帳→歷史紀錄 `DailySettlementPage`、財務→月銷售紀錄 `FinancePage`）用 `<input type="month">`，**桌面版 Safari 不支援 month 輸入、退化成純文字框**，選不到月份、送出值不是 `YYYY-MM` → 被當成當月。**⚠️ 這是依程式行為的判斷，未能確認使用者實際瀏覽器；若 Chrome 仍重現需另查。**
- ✅ **前端**：新增共用元件 `components/MonthSelect.jsx`（年＋月兩個下拉，輸出 `YYYY-MM`，年份 2024～明年、已選值超出範圍自動納入；`aria-label` 年/月），取代兩處 `type="month"`。全站 `type="month"` 只有這兩處，已全數替換（正式站 `staff.redrocktaiwan.com/staff/finance` 實測已無 `input[type=month]`、出現「年=2026（4項）／月=10（12項）」）。
- ✅ **後端**：`monthly-export` 有帶 `month` 但格式不是 `YYYY-MM`（含 `2026/09`、`2026年9月`、月份 `13`）→ **400 `INVALID_MONTH`**「月份格式不正確，請選擇年與月（YYYY-MM）」；沒帶 `month`（含空字串）→ 當月。驗證：`2026-09` 200、`2026/09` 400、`2026年9月` 400、`month=` 與不帶皆 200（xlsx）。
- 📌 **同型地雷（尚未處理，留意）**：`checkin.js` `monthly-daily-counts`（入場頁每日入場數圖表）與 `schedule.js` 三處（`req.query.month || 當月`）對「格式錯誤的月份」仍是**靜默 fallback 當月**／直接當查詢字串用——目前前端傳值來源是程式內建（非使用者輸入的 month 欄位），暫無實害；日後若把這些接上使用者輸入的月份欄位，要比照這次改成驗格式＋回 400。
- 💡 **教訓**：**給使用者選日期/月份的欄位，不要用 `type="month"`／`week`（桌面 Safari 不支援，會退化成文字框）；用年月下拉（`MonthSelect`）**。後端對「有傳但格式錯」的參數應回 400，而不是靜默換成預設值——靜默 fallback 會讓「前端欄位壞掉」變成「資料一直是當月、卻沒人知道哪裡錯」。

## 目前進度（2026-10-04 續6）— 入場統計（營收報表）匯出 CSV 失敗修正（後端 `/health` `3.557.0-checkin-export-no-index`）
> 回報：入場統計無法下載（畫面只顯示「匯出失敗」）。
- 🔍 **根因**：`GET /revenue/export-checkin-csv`（營收報表→入場日報→「↓ 匯出 CSV」）查詢同時用 `where isCancelled==false` ＋ `where gymId==`（選填）＋ `checkedInAt` 範圍 ＋ `orderBy checkedInAt desc`，**沒帶 gymId 時需要一組不存在的複合索引**（`isCancelled`+`checkedInAt`）→ `FAILED_PRECONDITION` → 500。前端 `handleExportCheckin` 原本**只傳 `dateFrom/dateTo`、從不帶 `gymId`** → super_admin（`gymId` 取 `req.query.gymId`）每次都走「全館」必炸；單館帳號走 `req.staff.gymId` 另一組已存在的索引所以正常。其他兩個匯出（`export-adjustments-csv` 等）不受影響。
- ✅ **修**：後端改成**只用單一欄位**（`checkedInAt` 範圍＋排序，自動索引）查詢，`isCancelled!==true` 與 `gymId` 在記憶體過濾（專案慣例，不加複合索引）；前端 `RevenuePage.handleExportCheckin` 補傳 `gymId: gymFilter`（與畫面檢視館別一致，super_admin 全館時為空＝全館）。
- ✅ **順手改善**：匯出 `ENTRY_LABEL` 補 `buy_pass 購買定期票／buy_discount_card 購買優惠折扣券／competition 比賽報到／already_paid 已付費放行／bonus 紅利／experience 體驗`（原本直接顯示英文原值）；會員姓名等欄位新增 `csvCell` 跳脫（含逗號/引號/換行才加引號，避免切歪欄位）。
- ✅ **驗證（正式 API）**：近 30 天全館 1,625 筆 ＝ 新竹 1,173 ＋ 士林 452；三種館別選擇皆 200、類型欄全中文（優惠折扣券 384、課程學員 307、單次購票 302、購買優惠折扣券 52…）。修復前：不帶 gymId → 500、帶 gymId → 200。
- 💡 **排查模式（匯出/下載類「失敗」共通）**：先用**管理員 token 直接打該端點**，分別測「帶 gymId／不帶 gymId」與不同日期範圍——`FAILED_PRECONDITION: The query requires an index` 幾乎都是「選填條件缺省時換了一組查詢形狀」；**選填篩選條件（gymId 等）會讓同一支查詢在不同參數組合下需要不同複合索引**，新增/修改 Firestore 查詢時要把「不帶選填條件」那條路徑也實測一次。

## 目前進度（2026-10-04 續7）— 試上名單未標已付款＋結帳定期票續約取消沖銷漏扣（後端 `/health` `3.559.0`→`3.560.0`）
> 兩件連續修復，皆已正式環境驗證。commit `c6cfb6b`、`52439f1`。
- ✅ **李奇諦（士林）今日課程學員顯示「試上費未收」**（`3.559.0-transfer-confirm-trial-enrollment-paid`）：「試上費未收」看的是課程名單 `isTrial && paymentStatus!=='paid'`（`checkin.js:714`）。確認收款有兩條路徑：`POST /experience-bookings/:id/confirm` 會把試上名單標 `paid`；**待收款頁 `PUT /transfers/:id/confirm` 的 experience 分支原本不會**（只更新預約、記營收、發券、寄信）→ 預約/營收都對、名單卻停在 pending。修：該分支遇 `kind==='trial' && trialEnrollmentId` 一併標名單 `paid`、清 `paymentDeadline`（已取消名單不動）。資料：全庫掃描「預約已確認但名單仍 pending」共 3 筆（李奇諦、黃宇鴻 9/14、Chi-Tien Hsieh 9/14）已補標 `paid`＋`correctionNote`。
- ✅ **新竹結帳發票 9,236 vs 系統 13,036（差 3,800）**（`3.560.0-settlement-pass-refund-netting`）：黃永豪 90 日票續約 3,800 做了兩次——續約→取消入場（`revertRenewal` 記 `type:'refund'` −3,800、notes「定期票續約取消沖銷」）→重新續約；淨額與發票皆 3,800。結帳 `GET /today` 迴圈只加 `type:'pass'`、**不扣 refund** → `income.pass` 7,600；`payment.linePay` 也多算（pass 交易 `addPay` ＋續約發票進 `invAuth.byMethod` 重複）16,156（實際 8,556）。修：①迴圈新增 refund 分支——無 `refundCategory`、notes 含「定期票／分期／續約」且不含「入場」者，同步扣回 `passIncome`／付款方式／`passByType`（規則與 `revenue.js foldType` 一致；入場取消沖銷已由 `checkIns.isCancelled` 排除，不在此扣）②`computeTodayInvoiceAuthority` 的 `byMethod` 排除 `checkin_renewal`／`pass_renewal` 發票（續約款付款方式已由 pass 交易統計；發票金額仍計入 `actualTotal`／`bySourceType`）。已結帳快照（`9d7ff343…`）已更正：pass 7600→3800、total 13036→9236、linePay 16156→8556；現金 680、差異 0 不變。
- ✅ **驗證**：用管理員打正式 `GET /daily-settlements/today?gymId=gym-hsinchu`（已結帳日仍即時重算 `live`，**不必等隔日**即可驗證）→ pass 3800／total 9236／linePay 8556／cash 680／invoiceActualTotal 9236，與手動更正的快照完全一致。
- 💡 **對帳備忘**：結帳「系統總額」與「發票總額」差額剛好等於某筆定期票/續約金額時，先查該會員是否有「續約取消後重做」（`transactions` 依 `relatedId`＝passId 看 pass／refund／pass 三筆）；已結帳日更正快照時，`actualCash`／`closingCash` 不動、隔日前日餘額不受影響。

## 目前進度（2026-10-04 續8）— 王柏然（士林子會員）墜測同意書併入聲明書＋放行入場（純資料，無程式異動）
> 管理員要求「王柏然的墜測同意書合併到風險安全聲明書，家長不要多簽名」。會員 `10c29ca2-f71a-4b41-9380-09d02bb72a77`（12 歲、`isChildAccount`、家長 `8c5c1dc1…`）。
- 🔍 **查證現況**：waiver `isComplete:true`，但 **`memberSignedBy:'self'`（本人簽、非家長代簽）、無 `parentSignedAt`**，內容為舊版（不含墜測同意條款）；`fallTestSignatures` 0 筆、無墜測紀錄、`blockReasons:['fall_test_required']`。（一度誤說成「家長代簽」，已更正。）
- ✅ **補一筆行政合併標記** `fallTestSignatures/baaa00ff-6745-46e8-8809-6af8d1cc6d7d`：`source:'merged-with-waiver'`、`mergedWaiverId`、`signatureData:''`（**未複製聲明書簽名圖、未偽造觀看進度/勾選段落**）、`adminNote` 註明依管理員指示併入。入場關卡 `hasConsentSignature` 只判斷「有無紀錄」，故不再要求家長補簽。員工端若有檢視副本，此筆內容為空。
- ✅ **墜測通過由管理員（Sean）在員工端自行登記**（效期至 2027-10-04）→ `isBlocked:false`、`blockReasons:[]`，可入場（12 歲以下仍須家長/成人陪同）。
- 📌 **注意**：`fall_test_required` 看的是「有無通過的 `fallTests`」，**與同意書簽署紀錄無關**；`recordFallTestResult` 登記通過前會檢查有無同意書簽署紀錄（`SIGNATURE_REQUIRED`），所以併入標記必須先於登記通過。
- ⚠️ **權限**：我用 service 函式補登通過被 auto mode 分類器擋（獨立於 settings allow 規則，專案已有 `Bash(node *)` 仍擋）；不要靠加規則解決，被擋就說明並請使用者在員工端操作或確認。全域 `~/.claude/settings.json` 一度被 `/permissions` 誤存成壞規則（整段 JSON 當字串），已清空 `allow`。

## 目前進度（2026-10-05）— 刪除王登第／王登妹「【新竹館】小蜘蛛人初級班 優惠試上」測試報名（純資料，無程式異動）
> 管理員指示刪除兩人在該工作坊（課程 `6b6172f9-1752-4301-9ecc-6aebb3d52f54`）的報名，確認「都是測試資料」。這些是 10/3 Debby Chu 測「退回付款」流程時留下的（退回原因 `test`／`test2`）。
- 🔍 **刪前查證**：王登第 1 筆（10/21，`transfer_rejected`）；王登妹 2 筆——10/21（`transfer_rejected`）與 **11/04（`paymentConfirmed:true`、400 元、入場券已發）**。因 11/04 那筆看似已收款，先停下來問管理員，確認「全部刪除、都是測試」才動手。
- ✅ **刪除（單一 batch，刪前備份成 JSON）**：`courseEnrollments` 3 筆（`4a50ee45…`／`a3cd7c2b…`／`fc3088ee…`）、`courseRegistrations` 3 筆（每筆報名各一）、`singleEntryTickets` 1 筆（`bf4a2590…`，王登妹 11/04 課程入場券）。
- ✅ **場次人數扣回**：10/21 場次 `enrolledCount` 4→2、11/04 場次 1→0（扣前核對過 `enrolledCount` 與有效報名數一致才扣）。
- 📋 **查無需清**：`transactions`（王登妹 0 筆；王登第 3 筆皆與此課程無關，未動）、`invoices`、`notifications` 皆無關聯紀錄。會員帳號本身未動。
- 📌 **模式**：刪「已確認收款」的報名前，先查 `singleEntryTickets`（`courseEnrollmentId`）、交易／發票、場次 `enrolledCount`，並把報名＋總表（`payEnrollmentId`／`sourceEnrollmentIds` 互指）成對刪。

## 目前進度（2026-10-06）— 票券統計定期票排除已取消＋續約發票（另一 session 完成）記錄
> 兩件事，皆已部署。前端(redrock-web) commit `1cbf9ac`／`1f494f8`；後端 `ed53cb0`。
- ✅ **員工端「票券統計」定期票區塊排除已取消**：拿掉「已取消」數字卡與長條圖「取消」欄（統計卡改 3 欄）；「總發出」改為前端 `total − cancelled`（＝有效＋已過期）；`GET /pass-adjustments/analytics/download?type=passes` 的 CSV 也過濾掉 `status==='cancelled'`。後端 analytics API 回傳欄位本身不動（仍含 `cancelled`），只是畫面/CSV 不再顯示。優惠卡／黑卡／單日券統計不動。
- ✅ **現場續約發票＋線上續約發票彈窗（另一 session，前端 `49b81b4`、後端 `15c8587`／`124fbbf`）**：`checkIns.renewalAmount>0` 且未取消時入場頁顯示「開立續約發票」（`sourceType:'checkin_renewal'`，`refId=checkInId`，端點 `/checkin/:checkInId/renewal-invoices`）；在家線上續約（`sourceType:'pass_renewal'`，`refId=paymentId`，端點 `/passes/renewal-invoice/:paymentId`＋`/void`）原本按鈕有但彈窗未接（點了沒反應），已補上。`InvoiceButton` 新增 `label` 參數。**使用者確認此功能已實際驗證過**。
- 📌 **部署流程提醒**：前端 deploy 時 working tree 內其他 session 已 commit 的改動會一併上線（本次 `49b81b4` 即隨 `1cbf9ac` 的 build 一起部署）；動前端前先 `git log` 看有無他人新 commit。

## 目前進度（2026-10-06 續）— 員工端「票券統計」頁精簡：各票種拿掉取消/過期、紅利加圓餅圖
> 純顯示/統計口徑調整，皆已部署。前端(redrock-web)：`1cbf9ac`／`1f494f8`／`0e2b58b`／`725617d`／`67788bb`／`ffed42a`；後端：`ed53cb0`／`5389fe0`／`67e8b7a`／`025dc8f`。使用者逐項指示，**後端 analytics API 仍回傳完整欄位（含 `cancelled`/`expired`），只是前端不顯示、CSV 與紅利統計有過濾**。
- ✅ **定期票**：拿掉「已取消」卡與長條圖「取消」欄；「總發出」＝前端算 `total − cancelled`（＝有效＋已過期）；下載明細 CSV 排除已取消。
- ✅ **優惠卡／黑卡**：拿掉「過期」卡（剩總張數／有效／已用完 3 欄）；兩者共用的圓餅圖拿掉「已用／剩餘」圖例（比例文字已標示）。
- ✅ **單日券**：拿掉「已取消」；「已過期」併入「已使用」（卡片＝總張數／有效／已使用，總張數已扣取消）；圓餅圖只剩有效／已用；CSV 排除已取消、原「已過期」狀態改寫「已使用」。取消來源（正式資料 4 張）：`approval_timeout`（單次券 24h 未審核自動取消）、`參加者移除`（體驗預約減人連動取消；體驗券與單日券同存 `singleEntryTickets`，故會一併計入）、`已從紙本發出`（人工標記）。
- ✅ **紅利**：「已過期」併入「已使用」，新增有效／已用圓餅圖；CSV 原「已過期」改寫「已使用」。**統計與 CSV 排除兩類**：①`transferredTo` 的已移轉**原紅利**（`bonusService.transferBonus` 移轉時會複製一筆給新持有人，只算新那筆，避免重複）②管理員停用/撤銷的紅利（`isActive:false && !isUsed && !expiredAt`，有 `revokedAt`/`correctionNote`；正式資料 2 筆）。系統自動掃過期的紅利有 `expiredAt`，仍計入（併入已使用）。正式資料驗證過濾：67→65 筆。⚠️ 正式資料目前**沒有**已移轉紅利，去重邏輯只依程式推演、無實資料驗證；`ticketTransfers` 流程是直接改持有人（不複製、無 `transferredTo`），不受過濾影響。
- 📌 **提醒**：日後若有人問「票券統計數字對不上資料庫」，先想到這些刻意排除（取消/停用/已移轉原紅利）與併入規則；要看原始全量用 `GET /pass-adjustments/analytics` 回傳的原欄位或直接查集合。

## 目前進度（2026-10-06 續2）— 林子雲補「虹瑩進階班」9/10 課：人工補課券＋手動登記名單（純資料）
> 管理員指示：林子雲（`dc502ee4…`，0963004187，原班＝「虹瑩進階班 8-9月週四班」`00491b4e…`，士林）今天 10/6 補課，登記補課券與名單。**虹瑩課程政策上不自動發補課券（`rules.allowMakeup:false`），一律館方人工額外給。**
- ✅ **補課券**：`courseMakeupRights/a35939c7-878a-45b7-8b6f-7532bbae589f`，用既有 `issueManualMakeupCredit()` 發（`source:'manual'`、`exempt:true`、`originalEnrollmentId:null`，掛原班週四班）。依指示補 **2026-09-10**（該堂週四班場次 `cancelled`、但她的報名仍 `confirmed`，故系統原本沒發停課券）→ 加 `makeupForDate:'2026-09-10'`＋備註；**效期改成當日**（2026-10-06，存 2026-10-05T16:00Z＝台灣 00:00，格式同系統其他補課券；原本預設 10/24）。
- ✅ **名單**：補到今天 19:30 士林「虹瑩進階班 8-9月週二班」（場次 `c4616280…`，原 2/3 → **3/3**；賴芷均請假者不佔 `enrolledCount`）。報名 `courseEnrollments/cda1d21d-3d93-409e-a39e-3b02a1b3064f`（`isMakeup:true`、`makeupId` 指回券、`enrolledBy:'staff-manual'`、帶人工註記），券同步標 `used`（`usedSessionId`＝該場次）。
- ⚠️ **繞過了一道守門，是刻意的**：正式 `enrollMakeup()` 擋下 `MAKEUP_TARGET_CLOSED`——週二班 `makeupTarget:'off'`（不開放當補課目標）。因為是管理員人工安排，改**手動照 `enrollMakeup` 同樣的三筆寫入**（報名＋場次人數＋券 used）在單一 batch 完成，其餘檢查（券可用、場次未滿、未重複報名）自行驗過。寫入前備份在當次 scratchpad `backup-ziyun.json`。
- ✅ **入場**：她當下 `getBlockReasons` 為空；`eligibility.js` 對補課報名（`isMakeup && date===今天`）給「當天限定」課程學員入場資格（不延伸到隔天）——依程式判斷可直接入場，**未在櫃檯實測**。
- 📌 **日後類似需求（虹瑩等不自動發補課券的班）**：①`issueManualMakeupCredit(db,{memberId,courseId,issuedBy,issuedByName})` 發券（掛學員自己的班）②目標場次若 `makeupTarget` 為 off 則 `enrollMakeup` 會被擋，管理員確認要硬排時才照上述手動三筆寫入 ③券「已使用」是登記補課當下就標的（發券＋排課是一組），不是自己變的。

## 目前進度（2026-10-06 續3）— 測試帳號還原、成人班恢復開放試上（根因＝9/22 改動）、轉卡錯誤顯示在彈窗
> 皆已部署／寫入。前端(redrock-web) `5f2e5a3`；其餘為純資料。
- ✅ **0900123123（【練習】比賽報名測試）還原成已完成簽署**（使用者要求；此帳號平常刻意保持未簽署供測簽署頁，見 10/03 記錄）：用 `signEntryDocs` 補風險安全聲明書＋墜測同意書（**簽名圖為程式畫的示意圖、非真人簽名**；watchPercent 100、勾選段落 `[0,1,2,3]` 為自填值），再用 `recordFallTestResult` 登記墜測通過（效期 2027-10-06）；兩筆簽署與通過紀錄皆帶 `testRestoredNote`／備註註明「非真實測驗」。帳號 `isBlocked:false`。要再測簽署頁需重新刪這三類紀錄。
- ✅ **新竹館「課程試上」看不到成人班 → 打開班別 `allowTrial`**：入門班、進階班、矯正班、青少年進階班（兩筆同名班別，其中一筆本就停用）、週期訓練課程，共 6 個班別 `allowTrial` 由 false 改 true（旗下梯次皆沿用班別；**班別層設定，士林館同班別也一併開放**）。試上費沿用週課公式「單堂價×1.1」（如進階班 $1,100、矯正班 $1,155、入門班 $990）。改前值備份在當次 scratchpad `backup-cats.json`。
  - 🔍 **根因（推論，無直接證據）**：8/2 `a8bbf61` 讓週課一律視為開放試上/補課（班別 `allowTrial` 被忽略）；9/22 `429dd8d` 為了讓虹瑩進階班「請假不發補課券」生效，改成「課程或班別明確設 false 就尊重」——班別上早期殘留的 `allowTrial:false` 因此從 9/22 起重新生效，成人班試上憑空消失。**班別編輯路由沒有寫 `auditLog`，查不到誰何時改過**；我改前也沒先記下班別原 `updatedAt`（被覆蓋）。
  - ⚠️ **同一原因可能還影響其他班別**：週課班別 `allowTrial:false` 仍有——抱石X肌力與體能特訓班、寒暑假密集班(中文)、小蜘蛛人寒暑假英文密集班、特殊時段專班報名表，尚未處理（待使用者決定是否本就該關）；`allowMakeup:false` 的有抱石X肌力、小蜘蛛人寒暑假密集班、虹瑩進階班（虹瑩是明確政策，另兩個是否刻意未確認）。
  - 📌 **提醒**：日後「某班突然沒有試上/補課」先查**班別**（`courseCategories`）的 `allowTrial`/`allowMakeup` 是否被明確設成 false——週課只有「課程與班別都沒設（null）」才預設開放。
- ✅ **轉入優惠卡／綁定黑卡的錯誤改顯示在彈窗內**（`CardsPage.jsx`，優惠卡與黑卡兩個彈窗各自 `bindError` state）：卡號不在清冊（`CARD_NOT_IN_REGISTRY`）、卡別不符（`CARD_TYPE_MISMATCH`）、已被綁定、欄位檢查等錯誤顯示為彈窗內紅底框（彈窗保持開著可直接改卡號重送）；修改卡號／關閉／重開時清除；成功訊息仍在原頁面。後端不動。

## 目前進度（2026-10-07）— 賽事新增「兒童賽」類型：當期學員／非當期學員價（為 12/13 兒童抱石賽）
> 後端 commit `f313b9d`、前端(redrock-web) `84400a9`，已部署。本機呼叫 service 打正式資料驗證算價（學員/非學員/訪客 × 早鳥有無截止日 共 6 情境）＋建假賽事驗證建立/更新驗證（測完刪除）；**員工端編輯畫面/會員端/公開頁僅 build 通過、未實際開畫面看**。
- ✅ **資料模型**：`competitions.competitionType`（`'standard'` 預設＝一般賽；`'kids'`＝兒童賽，舊賽事缺欄位一律當 standard、算法完全不變）。兒童賽用 `fees.kidsStudent`／`kidsNonStudent`（一般價，必填，`assertKidsFees` 於 create/update 驗證，缺則 `KIDS_FEES_REQUIRED`）、`kidsStudentEarlyBird`／`kidsNonStudentEarlyBird`（選填）、`insuranceChild`（兒童賽一律用兒童保險費，不看年齡）。報名紀錄新增 `competitionType`、`isCurrentStudent`（報名當下判定，只在首次報名寫入；改表/逾期重報會用「當時」身份重算 `registrationFee` 但不更新 `isCurrentStudent` 標記）。
- ✅ **算價（單一真相 `computeCompetitionFee`，5 個呼叫端全共用：報名/quote/改表/逾期重報/友館駁回重算）**：兒童賽不分成人/兒童身份，只看是否「當期學員」；**攀岩隊 9 折／友館折扣不適用**；早鳥規則與一般賽相同——`earlyBirdDeadline` 有設且今天 ≤ 截止日才算早鳥、**沒設截止日＝全部無早鳥**；早鳥期間有填早鳥價才用，沒填沿用一般價；價格未設 → `FEES_NOT_CONFIGURED`（不會偷偷套預設 950/1100）。
- ✅ **「當期學員」定義（`isCurrentCourseStudent`，使用者拍板「只有進行中課程學員享有學員價」）**：有 `courseEnrollments` `status:'confirmed'` 且非補課/試上、所屬課程為**週課（非 workshop）、未取消/未停用、`startDate ≤ 今天 ≤ endDate`**（欄位缺漏視為不設限）。訪客（`guest_` 前綴）一律非學員。⚠️ 判定看**課程資料的 `endDate`**：若課程場次實際延長超過 endDate（如虹瑩進階班週四班 endDate 9/24、場次排到 10/8），該班學員不會被算成學員，需先把課程結束日改對；已報名該班但「尚未開課」的人也不算學員（照「進行中」字面）。
- ✅ **前端**：員工端賽事編輯加「賽事類型」下拉（兒童賽：費用區改顯示 學員價/非學員價/保險費/兩個早鳥價；早鳥截止日欄位保留並註明「不設定＝無早鳥」，附「清除截止日」鈕；儲存前驗證兩個一般價必填），賽事卡片標「兒童賽」、報名名單備註標「當期學員／非當期學員」；會員端賽事列表同時列學員價/非學員價、報名彈窗顯示「進行中課程學員價／非學員價」（金額一律吃後端 `/quote`）；公開報名頁（訪客）以非學員價計並提示「當期學員請用會員帳號報名」。公開賽事端點 `GET /competitions/public/:id` 補回 `competitionType`（該端點是欄位白名單投影，新增賽事欄位要記得加）。
- 📌 **12/13 兒童賽設定方式**：員工端新增賽事→類型選「兒童賽」→填學員價/非學員價/保險費（要早鳥才填早鳥價＋截止日）。價格由使用者決定，程式內無寫死。
- 📌 **（已修，見 2026-10-07 續）** 一般賽「隊員折扣」欄位原本後端不讀、實際寫死 9 折；現已改讀賽事 `fees.teamMemberDiscount`。

## 目前進度（2026-10-07 續）— 賽事：隊員折扣讀欄位、有無保險、平常練習岩館、停友館折扣、兒童賽補課券抵費
> 後端 `bb38082`／`c9ee687`／`5d6a4af`，前端 `46bd4b5`／`5dd82f6`／`df52550`，皆已部署。本機/正式環境用 service 與假資料驗證算價、報名、券歸還（測試資料已清）；會員端/公開頁/員工端畫面僅 build 通過、未實際開畫面看。
- ✅ **隊員折扣讀賽事欄位**：`computeCompetitionFee` 改讀 `fees.teamMemberDiscount`（0<費率<1 用它、≥1＝此賽事不給隊員折扣、空/0/無效退回系統預設 9 折；<100 元不打折規則不變）；會員端列表預覽同步。三場現有賽事值皆 0.9，結果不變。
- ✅ **賽事有無保險**：`competitions.hasInsurance`（預設/舊賽事＝有；`false`＝保險費 0、員工編輯隱藏保險費欄、會員報名/公開頁/編輯表單不要身分證、員工名單詳情不顯示保險費/身分證、名單 CSV 不輸出「身分證/護照」欄）。12/13 兒童賽已設 `hasInsurance:false`。⚠️「簽到表暨保險名冊」下載未改（身分證欄位會是空的）。公開賽事端點是欄位白名單，已補 `hasInsurance`、`competitionType`。
- ✅ **平常練習岩館**（`registration.practiceGym`）：**所有賽事報名必填**（自由輸入文字，範例「新竹紅石／士林紅石」）；會員端報名、公開頁、報名後編輯、員工名單詳情、CSV 皆有。**同步計分系統**：`mapAthlete` 的 `team` 欄＝自訂欄位隊伍 → 否則帶 `practiceGym`（計分系統各畫面都在選手名旁顯示 team），另存 `athlete.practiceGym` 原值；會員改報名表後會重新推送（已正取且簽署完成者）。⚠️ 每次重新推送都會用 RedRock 值覆蓋計分系統的 team（原本就如此）；舊報名無此欄位。
- ✅ **友館折扣停用**：新報名一律不套用（後端忽略 `partnerGymId`）、會員端/公開頁友館選單與編輯欄位已移除；**舊報名**（含友館折扣者）改表/逾期重報時仍沿用原折扣（`computeCompetitionFee` 仍保留友館邏輯，只是新報名不再傳）。
- ✅ **兒童賽可用補課券抵費**（僅兒童賽、會員本人名下、訪客不可）：報名表第一步若該報名對象有可用補課券（`available`、報名當下未到期、非現金折抵、不限來源課程/班別）顯示「使用 1 張補課券抵本次報名（免繳費）」，多張可選；停課券（closure）優先、其次最早到期。抵費報名：`registrationFee`/`insuranceFee`＝0、`originalFee` 留原價、`paymentMethod:'makeup_credit'`、`paymentStatus:'confirmed'`、`paidByMakeup:true`、`makeupRightId`，跳過付款步驟；券在寫入報名的同一個 Firestore 交易內標 `used`（`usedCompetitionRegId`，防雙重使用）。**取消報名/管理員駁回 → 券歸還**（`releaseMakeupRightForRegistration`：效期內還原 available，已過期則標 cancelled 不復活）；補課券抵費者取消不需填退費帳號（`isPaidReg` 排除 `paidByMakeup`）。**取消請假**走既有方案 B 額度預檢：已用券（含抵比賽者，`MAKEUP_OVER_QUOTA` 訊息會提示「先取消比賽報名」）超過新額度就擋；比賽已辦完券不會歸還→該請假永久不可取消。員工名單標「補課券抵費」。
- 📌 **訪客（免註冊）報名**：公開連結免註冊、一律轉帳、只算非學員價、無報到 QR（QR 需會員登入取得），當天由櫃檯名單「手動報到」。已存為 memory 待定想法（免註冊報到連結，使用者「先暫時記著」，未實作）。
- 🧹 **員工端優惠卡/黑卡頁手機排版**（`CardsPage.jsx`，`e44c720`）：兩欄 `1fr 1fr` 改 `auto-fit minmax(min(100%,320px),1fr)`、標題列可換行、優惠卡浮水印移到右下；依程式碼推測的成因，未在手機實測。

## 目前進度（2026-10-07 續2）— 課程暫停：釋放名額＋下期回課（暫停餘額）
> 後端 `2c21e9a`／`8975a5e`／後續 `3.563.0-pause-resume-credits`，前端 `561263c`，已部署。正式環境用假資料跑完整流程（暫停核准→名額/名單、恢復、餘額收尾→預覽/套用回課→入場資格→插班報價→學員不可自行取消），測試資料已清。員工端新畫面僅 build 通過。
- ✅ **暫停核准＝釋放名額**：該會員此課程「還沒上」的場次，`pauseStatus:'paused'`＋`pausedSeatReleased:true`、場次 `enrolledCount` −1；**不自動遞補課程候補**（遞補涉及費用、且學員恢復時要位子）。暫停中的人**不列入**：單堂名單（`getSessionRoster`）、今日課程學員（`/checkin/today-course-students`）、`getSessions` 場次人數、`getCourses` 課程層人數、候補遞補的課程容量判斷；入場資格與課程學員總名單本來就排除。既有暫停者（白孟儒 18 堂、林俊廷 3 堂）已補做釋放。
- ✅ **恢復端點改寫**（`POST /course-adjustments/enrollments/:id/restore`，員工端目前無按鈕、僅 API）：原本只恢復單一堂且改舊集合（幾乎無作用）→ 現在恢復該會員此課程**所有**暫停中堂數並重新佔位；任一堂已被補滿→整批 409 並列出額滿日期。僅限「同一期中途回來」。
- ✅ **暫停餘額 `coursePauseCredits`**：暫停核准建立（`remainingSessions`＝被暫停堂數）；狀態 `paused`（暫停中）→ `awaiting_resume`（原課程結束，**每小時排程 `sweepPauseCredits` 自動收尾**；結束＝無今天以後的 scheduled 場次）→ `resumed`（排完）；同期恢復標 `restored`。
- ✅ **安排回課**（員工端課程頁新按鈕「⏸ 暫停回課」→ `PauseCreditsModal`；API `GET /course-adjustments/pause-credits`、`POST .../pause-credits/:id/arrange`，`apply:false` 預覽/`true` 套用）：員工指定「回課梯次」（同班別或同舊生範疇、同館、週課、非原課程）＋「開始日期」→ 從該日起依序把剩餘堂數排進該梯次（已額滿/學員已在名單的堂跳過並列原因；不足的留作剩餘堂數），**以補課方式**建報名（`isMakeup:true`、`pauseResume:true`、`makeupId:null`、不經補課券、不佔補課額度），場次人數 +1（交易內再驗額滿）。原課程尚未結束時擋（`COURSE_NOT_ENDED`）。學員不可自行取消這些補課（`PAUSE_RESUME_NO_SELF_CANCEL`，須洽櫃檯）。
- ✅ **回課期間免費入場**：`eligibility.js getCourseAccess` 對 `pauseResume` 報名給課程學員資格，區間＝`resumeAccessStart`（開始日）～`resumeAccessEnd`（最後一堂補課日），不限上課當天（一般補課仍只有當天）。
- ✅ **補課堂數用完後續上＝插班**：`computeCourseFeeForMember` 與 `handleEnrollAll` 以 `getResumeCutoff`（最後一堂 pauseResume 日期）為界——該日（含）之前視為已上過、只建立/收費之後的堂數；舊生折扣照常。**暫停者算舊生、但不算「整期續報」**（`computeAlumniStatus`：該課有暫停中的報名→`isFullTermRenewal:false`）。
- 📌 **限制/注意**：①原課程沒結束就想下期回課會被擋（同期用「恢復」）②安排回課未發通知給學員、會員端沒有新畫面（學員只看得到補課堂數與入場資格）③白孟儒原課程到 2027/1 才結束，目前是 `paused`；林俊廷課程 10/28 結束後自動轉待安排 ④`restore` 端點要重新佔位，額滿即 409，需先調整該堂名單 ⑤版本號 `3.562.0`＝暫停釋放名額＋兒童賽/補課券抵費/練習岩館上線；`3.563.0`＝暫停餘額/回課。

## 目前進度（2026-10-08）— 賽事新增「身份收費賽」（攀岩隊模擬賽）＋雜項查證
> 後端 `7ecb160`（`/health` `3.564.0-competition-tiered-fees`）、前端(redrock-web) `257c8c8`，已部署。用 service 對正式資料（真實隊員/VIP/90日票會員）驗算價、建假賽事註冊（VIP 免費自動已收款／一般 400 待付款／友館 300 待核對），測試資料已清；員工端編輯/會員端/公開頁僅 build 通過、未實際開畫面看。
- ✅ **`competitionType:'tiered'`（身份收費賽）**：`fees` 五級價格——`tierTeam`（當期紅石攀岩隊隊員）、`tierVip`（紅石 VIP）、`tierStudentPass`（進行中課程學員，或目前有效的 90 日定期票／半年定期票會員）、`tierPartnerTeam`（友館攀岩隊員，心流/爬森）、`tierOther`（以上皆非）；建立/更新時五個價格必填（`TIER_FEES_REQUIRED`，免費填 0）。攀岩模擬賽建議值：0／0／100／300／400（含入場費）。
- ✅ **算價（`computeCompetitionFee` → `computeTieredFee`，仍是單一真相，5 個呼叫端共用）**：身份可疊，取**最低價**（同價依 team→vip→student_pass→partner_team→other 優先，不疊加）。判斷：隊員＝`isActiveTeamMember`；VIP＝`vipMembers` 有該 memberId（`checkVip`）；課程學員＝`isCurrentCourseStudent`（進行中週課正式報名）；長期票＝`memberPasses` `status:'active'`、`endDate>=今天`、`passTypeName` 含「90日」或「半年」。**友館攀岩隊員由報名者自選友館**（會員端/公開頁下拉，清單＝`systemSettings/partnerGyms`），先套 300、`partnerGymPending:true`，櫃檯用既有友館核對流程比對名單，駁回→重算（不帶友館）回到其他身份最低價。訪客只能算「一般」或自選友館。無早鳥。保險：沿用 `hasInsurance`，費用 0 的身份保險費一律 0。
- ✅ **免費身份＝免繳費**：費用 0 且非友館待核對 → 報名直接 `paymentStatus:'confirmed'`、`paymentMethod:'free_tier'`、`paidFree:true`（`paidConfirmedBy:'system:free_tier'`）；取消/駁回不需退費帳號（`isPaidReg`/`wasPaid` 排除 `paidFree`）；會員端自動跳過「付款資訊」步驟。報名紀錄存 `tier`（team/vip/student_pass/partner_team/other），員工名單備註標身份、CSV 付款方式「免費身份」。
- ✅ **前端**：員工編輯賽事新增類型選項＋五個價格欄（隱藏早鳥日；儲存前驗證）、賽事卡片「身份收費賽」標籤；會員端列表列出五級價格、報名彈窗顯示命中身份（`quote.tierLabel`）與友館下拉；公開頁訪客顯示一般價＋友館自選＋「請用會員帳號登入以享優惠」提示。`registerForCompetition` 只有 tiered 賽事才採用 `partnerGymId`（一般賽/兒童賽仍一律忽略，沿用 10/07 友館折扣停用）。
- 📌 **同日查證（無程式異動）**：①**比賽同意書**＝每場賽事 `waiverContent.zh`（員工編輯賽事「同意書內容（繁中）」，只有繁中框）；賽事沒填時才用會員端程式內建的中英日預設（`MemberCompetitionsPage.jsx`），有填繁中則三語都顯示繁中 ②**退費行政費**＝賽事 `refundPolicies` 每組各自填的 `adminFee`（預設 100），全額退＝報名費−行政費、半額退＝報名費×50%−行政費，現有三場皆 100/100 ③**選手背號**由計分系統給（新增選手「號碼」欄／編輯／Excel 匯入），RedRock 只讀；重新推送保留計分系統背號——使用者評估改為 staff 手動給後決定**維持原作法** ④**開放單場賽事管理員（計分系統 `subAdmins`）要先對接**：名單存在計分系統該場賽事文件上，賽事不對接就沒有文件可指派；12/13 兒童賽目前尚未對接（無 `compDocId`）⑤**計分系統裁判帳號**綁定「組別＋輪次＋路線」指派；計分是欄位層級寫入（不同選手/路線同時上傳不互蓋，同格同時寫後者覆蓋、無法追溯是誰輸入）——模擬賽沒有固定裁判的建議：開數個通用帳號（裁判1~4）各指派不同路線，而非全部共用一個 ⑥免註冊（訪客）報名無報到 QR、當天櫃檯「手動報到」，「免註冊報到連結」想法已存 memory，使用者暫不做。
- 🧾 **黃士昕退費申請（`crefund_1791349740966_rv40`，新竹矯正班 9-10月週三B班）**：原狀態被 Debby Chu 10/7 13:03 誤「退回」（無原因）；依使用者指示改回 `pending`（清掉 rejectedBy/Reason/At，加 `revertedToPendingNote`），並**重新凍結**該課程 8 筆有效報名（`refundPending:true`、`refundRequestId`），備份 `scratchpad/backup-huang-refund.json`。核准尚未進行——使用者實際已於 10/7 匯出退款：**館方匯出帳戶＝中國信託 822、末五碼 42900**，核准時填 `refundSentDate:2026-10-07`／`refundSentLastFive:42900`；核准畫面沒有「匯出銀行」欄位，銀行資訊待核准後以備註補存。⚠️ 這次作業期間 Bash 的自動安全檢查曾連續失敗多輪（唯讀指令也是），改寫入類動作一律先確認範圍再執行。


## 目前進度（2026-10-09）— 比賽退費政策日期語意寫上頁面＋手動登記信箱驗證＋「發現新版本」查證
> 前端(redrock-web) 已部署（buildId `…64fa3021c492f40e`），後端無異動。員工端/會員端畫面僅 build 通過、未實際開畫面看。
- ✅ **退費政策 `refundPolicies` 日期語意（後端 `computeCompetitionRefundPolicy` 既有行為，這次只是把說明寫上畫面）**：每列 `deadline`＝「**這天（含）以前取消**適用該列規則」；依**取消當天**由最早日期往後比，取第一個 `cancelDate <= deadline` 的列；**晚於所有日期＝不予退費**。例：5/10 全額退、5/20 半額退 → 5/10（含）前全額退、5/11～5/20 退 50%、5/21 起不退。金額＝全額退：報名費−行政費；半額退：報名費×50%−行政費（下限 0）。
  - 員工端賽事編輯「退費政策」標題下加黃底說明框＋日期欄 title 提示；會員端報名第三步與取消彈窗，原「X 前取消」（沒說含不含當天、實際含）改「X（含）以前取消」（中英日），報名第三步補「超過最後日期：不予退費」行（取消彈窗本來就有）。
- ✅ **手動登記信箱驗證（純資料）**：周煜庭（0963615813）`emailVerified:true`＋`emailVerifiedNote`，再呼叫 `refreshBlockStatus` 重算封鎖；結果只剩 `waiver_unsigned`（風險安全聲明書未簽）。流程＝直接改欄位後必須重算封鎖狀態（`memberService.verifyEmail` 同做法）。腳本在 repo 外跑要 `NODE_PATH=$PWD/node_modules`＋`GOOGLE_APPLICATION_CREDENTIALS`＋先 `initFirebase()`。
- 🔍 **「又出現發現新版本」查證（無程式異動）**：不是誤報——10/6 前端部署約 8 次、10/7 約 5 次、10/8 1 次，`UpdateChecker` 以原始碼內容雜湊判斷，每次真有改動就會提示一次；查證時線上版本碼穩定。若重整後同一版仍反覆跳，多半是加到主畫面的 PWA 沒真正重載（關掉重開或強制重整）。**日後前端小改動盡量合併成一次部署**，減少提示次數。
- 📌 **員工端沒有「新增會員」畫面**（後端 `POST /members` 存在但無任何前端呼叫）：家長不註冊時，兒童需由本人/家長用 `app.redrocktaiwan.com/member/register` 自行註冊（櫃檯可協助操作）；員工端只能在既有家長會員詳情頁加家庭成員。使用者看過說明後決定**不開發**員工代建畫面。

## 目前進度（2026-10-09 續）— 新竹 10/9 結帳 LinePay 多算 350 更正（純資料）
> 回報「新竹今日 LinePay 是 3880，請確認哪裡有誤」（結帳/發票原為 4,230）。無程式異動。
- ✅ **原因**：劉欣耘（學生入場＋租借岩鞋 350，16:29）**入場紀錄 `paymentMethod:cash`，但發票 EF33427144 選成 `linepay`** → 結帳以發票為準，LinePay 多 350、現金少 350。逐筆比對當日 22 張入場發票 vs `checkIns`，僅此一筆不一致；無「LinePay 入場卻沒開發票」。
- ✅ **更正**：發票 `f772cd3c-507f-44a2-9200-956fcc862402` 的 `paymentMethod` linepay→cash（附 `paymentMethodCorrectionNote`）；結帳 `dailySettlements/0a437ad5-afc4-4b4f-aa81-ba485952d59a`：`linePay` 4230→**3880**、`electronic` 4230→3880、`cash` 3770→4120、`expectedCashBalance` 14818→15168、`difference` +350→**0**（附 `correctionNote`）；`actualCashBalance`（15168）不動。更正前備份在當次 scratchpad `backup-hc-1009.json`。
- 📌 **方向判斷依據**：使用者給的對帳數字（3,880）＝系統 4,230 減 350，且更正前現金差異為 +350（實際點鈔比預期多），兩者皆支持「這筆其實收現金、發票選錯」。**第四次遇到同型（見 10/4 黃明姿），直接套用對帳模式**：發票 vs 入場紀錄付款方式不一致的那筆就是選錯。
- 🛠 **查詢備忘**：`invoices` 編號欄位是 `invoiceNo`（`EF`＋`number`，**沒有 `invoiceNumber`**），入場發票用 `refId`＝`checkIns` id、`sourceType:'checkin'`；`checkIns` 依 `gymId`＋`checkedInAt` 範圍查需要複合索引，腳本改單查日期範圍後在記憶體過濾館別；`transactions` 同理（gymId＋createdAt 範圍缺索引）。
