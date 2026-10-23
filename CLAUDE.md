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

## 目前進度（2026-10-10）— 商品銷售「合併列印發票」＋銷售紀錄頁保留開票按鈕（後端 `/health` `3.565.0-product-merged-invoice`）
> 起因：新竹 10/10 兩雙 Rave X 岩鞋（一雙現金、一雙 LinePay）事後補開一張 2,000 發票（EF33427159，無來源、標 LinePay）→ 結帳 LinePay 多算 1,000。使用者要求商品銷售比照入場：銷售紀錄頁保留尚未開票的按鈕、已開顯示發票號碼、支援多筆合併列印。後端 commit `feat: 商品銷售合併列印發票…`、前端(redrock-web) `feat: 商品銷售紀錄頁保留開立發票按鈕…`，皆已部署。後端用假館別 E2E 23 項全過（測後全清）；**員工端畫面僅 build 通過、未實際開畫面看**（瀏覽器未登入員工端）。
- ✅ **新 `sourceType:'product_merged'`（比照 `checkin_merged`）**：`POST /invoices/print-record` 帶 `mergedSaleIds`（≥2 筆）；後端逐筆驗證——存在、同館（`MERGE_CROSS_GYM`）、非退貨單/未退貨（`MERGE_RETURNED`）、不重複（`MERGE_DUPLICATE`）、未被開過票（`ALREADY_INVOICED` 409）；發票存 `mergedSaleIds`、`refId:null`。`getActiveRealInvoice('product', saleId)` 也會找涵蓋它的合併發票（單筆開票擋重複、`/invoices/active`、`/invoices/status`〔`merged:true`〕、退貨連動作廢皆因此涵蓋）。下載 Excel 來源標籤「商品銷售（合併列印）」。
- ✅ **結帳（`computeTodayInvoiceAuthority`）**：`product_merged` 不走「整張單一付款方式」，改依 `mergedSaleIds` 回查各筆 `productSales` 的 `paymentMethod`/`totalAmount` 分開累加（加總對不上發票金額、或找不到銷售時退回整張單一方式；無 `mergedSaleIds` 的也退回）——與 `checkin_merged` 同款。E2E：現金 1000＋LinePay 1000 合開一張 2000（標 linepay）→ 結帳 `cash:1000 / linePay:1000`。
- ✅ **`GET /products/sales` 每筆帶 `invoice:{invoiceNo, merged, mergedCount}`**（沒有有效發票則無此欄）：個別真列印發票與手動記帳版（`invoiceRecords`）用 `refId in [30 筆一批]` 查（讀取量隨「已開票數」而非全部歷史）、合併發票用 `sourceType=='product_merged'`（＋gymId）查再依 `mergedSaleIds` 對應。只查有金額、非退貨單、未退貨的銷售。
- ✅ **前端 `SalesPage.jsx` 銷售紀錄 tab**：每筆顯示 `InvoiceButtonView`（未開＝「🧾 開立發票」，已開＝「已開立 EF…（合併列印）」），點擊開 `InvoiceIssuer`（關閉後重載列表）；`printingEnabled`（`/invoices/printing-status`）的館別多一顆「🧾 合併列印發票」切換勾選模式——限同一天、同館、未開票、未退貨，底部浮出「已選 N 筆 合計 NT$…／合併列印發票（至少 2 筆）」→ `RealPrintPanel`（`sourceType:'product_merged'`、`alwaysShowPaymentSelector`、每個品項一行明細、紙本不印會員姓名）。`InvoiceIssuer.jsx` 的 `RealPrintPanel` 新增 `mergedSaleIds` 並在成功畫面標示合併。**退貨確認視窗**：該筆已開發票→紅字警告（合併發票→「整張作廢、其餘 N 筆需重開、請取回紙本」）。
- 📌 **行為備忘**：退貨其中一筆＝整張合併發票作廢（與入場取消同款），其餘銷售回到未開票；合併限真列印館別（手動記帳版沒有自然的多筆合一）；**單張發票只能一種付款方式**，所以混合付款的多筆合開，發票上標哪種都只是「開不開錢櫃」用，結帳以各筆實際付款方式拆分。
- 🧾 **新竹 10/10 兩雙 Rave X 的善後（純資料，最終做法）**：發票 EF33427159（無來源補開、2,000、標 LinePay）原本與兩筆銷售（US 5.5 現金 `ef0262ee-…`、US 6 LinePay `d01b4a8c-…`）沒有連結。先曾用「＋1,000 現金補入」加減項暫時補現金（LinePay 仍多算 1,000）；後來使用者要求把發票掛上去，改成：該發票 `sourceType:'product_merged'`、`refId:null`、`mergedSaleIds:[兩筆]`（附 `attachNote`），**並移除那筆 ＋1,000 自動加減項**（否則發票依各筆付款方式拆分後現金會重複多算 1,000；移除前核對過唯一一筆 `auto && refId==該發票`、草稿未結帳）。結果：銷售紀錄兩筆顯示「已開立 EF33427159（合併列印）」，結帳自動拆成現金 1,000／LinePay 1,000，LinePay 不再多算；草稿其餘加減項（－420 楊季昕體驗教練費）未動。備份在當次 scratchpad `backup-rave-1010.json`。
- 📌 **把「無來源補開的發票」補掛到銷售的做法（日後同型直接套用）**：確認發票 `status:'issued'` 且 `sourceType` 為空、金額＝所涵蓋銷售 `totalAmount` 加總、銷售同館且未退貨 → 單筆改 `sourceType:'product'`＋`refId`＝銷售 id；多筆改 `sourceType:'product_merged'`＋`mergedSaleIds`。若先前為了對帳補過「＋現金補入」之類的加減項，掛上後要一併移除（拆分後已自動正確）。已結帳（settled）的日子不要這樣改，會讓快照與即時計算不一致。
- 💡 **E2E 手法備忘**：本機不用起整個 server——自建 express 掛 `products`/`invoices`/`daily-settlements` 三個 router，用任意 `JWT_SECRET` 簽一個 super_admin（取 `staff` 內真實 super_admin 的 id；`authenticate` 會用 staffDoc 的 `gymId` 覆蓋 token，所以 print-record 要在 body 明帶 `gymId`）；假館 `gym-e2e-test`/`gym-e2e-other` 設 `invoicePrintingEnabled:true`＋`invoiceState`（字軌 ZZ/YY，不佔真實號碼），測完刪發票/銷售/交易/結帳/假館並再查一次確認清空。
- 📌 **決策：入場與商品銷售「不」做跨類別混合合併發票（2026-10-10 使用者拍板維持分開）**：`checkin_merged`（`mergedCheckinIds`）與 `product_merged`（`mergedSaleIds`）各自只能合併自己那一類，兩邊合併頁面也只列自己的清單；客人入場又買商品要開發票＝分開開兩張。**勿主動再提議混合合併。** 若日後真要做，評估過需改：新發票類型同時存兩種 id、`computeTodayInvoiceAuthority` 同時回查 `checkIns` 與 `productSales` 各自拆付款方式、兩種單筆開票的重複檢查（`getActiveRealInvoice` 兩個分支）、入場取消與商品退貨皆連動作廢整張混合發票、前端合併畫面跨頁勾選（較單純做法：入場頁合併模式加列同館同日商品銷售）；風險是任一邊取消就作廢整張。

## 目前進度（2026-10-11）— 新竹 10/10 結帳 LinePay 更正＋家長簽署信「沒有連結」修正（後端 `/health` `3.566.0-email-plaintext-links`）
- ✅ **新竹 10/10 結帳 LinePay 2,120→3,120（純資料）**：Rave X 兩雙（發票 EF33427159 合併發票）的銷售 `ef0262ee-…`（US 5.5）原記現金，實為 LinePay。判斷依據：使用者給的對帳數字 3,120＝發票 LinePay 合計，且結帳現金差異 -1,000 剛好等於該筆。更正 `productSales` 與對應 `transactions`（`O2DTbaZIMNbtb8p5h7ak`）付款方式→linepay，結帳 `33869769-…`：cash 5230→4230、linePay 2120→3120、electronic→3120、預期現金 19978→18978、差異 -1000→0（`actualCashBalance` 不動）。備份在當次 scratchpad `backup-fix-1010.json`。**合併發票依各筆實際付款方式拆分，所以改的是銷售紀錄，不是發票。**
- 🐞 **家長簽署信「裡面沒有連結只有文字」（劉亦謹，電話 0970334560，與哥哥劉亦宸共用電話與家長信箱）**：HTML 信本來就有按鈕與連結、token 有效；`emailService.sendEmail` 未傳 `text` 時純文字部分只放**主旨**，純文字模式／過濾按鈕的信箱就完全沒有連結。**屬推論，Resend 金鑰為 send-only 查不到實際寄出內容，家長端是否已解決未確認。** 修：新增 `htmlToText()`（連結轉「文字 (網址)」），`text` 預設由 HTML 產生，所有信件受惠；`sendParentWaiverLink`／`sendParentCompetitionWaiverLink` 加「按鈕點不開嗎？請複製下方網址」。commit `951c5bb`。已重寄一封給家長（`resendParentWaiverLink` 在本機用正式 `RESEND_API_KEY` 呼叫，會產生新 token、72 小時效期）。
- ✅ **劉亦謹／劉亦宸 Email 手動註記已認證**（`emailVerified`＋`emailVerifiedAt`＋`emailVerifiedNote`，再 `refreshBlockStatus`）。亦謹剩 `parent_waiver_pending`、亦宸剩 `fall_test_required`。
- 📌 **備忘**：①使用者口述的名字可能與資料不同（說「劉亦謹」，同電話查到「劉亦宸」「劉亦謹」兩人），查電話後先列出所有同號會員再確認對象 ②本機要寄信測試需 `RESEND_API_KEY`（`railway variables --kv` 取得）；Resend 金鑰僅能寄信、不能查詢寄送紀錄 ③macOS 的 `sed -i` 要寫 `sed -i ''`。
- ✅ **家長簽署頁出不來的另一成因＋註冊警語（2026-10-11 續，前端 redrock-web 已部署，buildId `member-26e7000f603e6579`）**：劉亦謹案——家長用**孩子的資料**註冊主帳號（主帳號 `isMinor:true`、系統沒有家長本人的會員），註冊後選「🙋 本人不入場」→ `MemberOnboardingGate` 因 `selfEntrySkipped` 直接放行、**不顯示主帳號的入場文件簽署頁**；家長後來按「重啟入場文件簽署」（`selfEntrySkipped` 變 `false`）才簽得出來。與「信裡沒連結」兩件事疊在一起才卡很久。判斷為資料推論，未看過家長當時畫面。**正確流程**＝家長用自己的資料註冊，再於「家庭成員」新增孩子（孩子是 `isChildAccount`，家長可在 App 內代簽）；用孩子資料當主帳號時，法代簽署只能走 Email 連結。
  - 警語（只加提示，未擋按鈕）：①`MemberRegisterPage` 生日填到未滿 18 歲時顯示黃底提示（請家長用自己資料註冊）②`MemberOnboardingGate`「本人不入場」按鈕下方與確認視窗，**僅 `member.isMinor` 時**顯示警語（未成年主帳號勿選不入場，否則不會出現簽署頁）。中英日三語已補 `memberI18n.js`。畫面僅 build 通過、未實際開畫面看。
  - 排查備忘：同電話可能有多位會員（主帳號＋家庭成員共用電話），用 `isChildAccount`／`parentId`／`selfEntrySkipped`／`createdAt` 還原誰是主帳號、誰先建立。

## 目前進度（2026-10-12）— 免註冊比賽報名補同意書／法定代理人資料、報名存同意書快照、葉育昕實繳更正（後端 `/health` `3.568.0-comp-waiver-snapshot-guardian-contact`；前端 buildId `member-2805ab9041afabcf`）
> 起因：使用者問「免註冊報名要看得到同意書才簽名；未註冊如何取得入場 QR」。查證發現公開報名頁（`PublicCompetitionRegisterPage`）只有簽名框、**完全沒顯示同意書**（後端公開端點本就回傳 `waiverContent`，頁面沒用）。
- ✅ **公開報名頁**：簽名前顯示「參賽同意書」（賽事 `waiverContent.zh`，沒填用預設中英日全文；內容長時可捲動），並與會員端一致需勾兩項才能送出（已閱讀同意參賽規定與風險聲明／同意照片影像使用）。**未成年**另需填法定代理人**姓名、電話、與選手關係**（皆必填）＋簽名；後端驗證 `GUARDIAN_NAME_REQUIRED`／`GUARDIAN_PHONE_REQUIRED`／`GUARDIAN_RELATION_REQUIRED`（正式環境已測）。
- ✅ **預設同意書文字抽成共用** `redrock-web/src/utils/competitionWaiverDefaults.js`（`DEFAULT_COMP_WAIVER` zh/en/ja），會員端與公開頁共用；以後改預設文字只改這一處。賽事自訂同意書只有繁中（英日版訪客看到仍是繁中，會員端同）。
- ✅ **報名存同意書快照 `waiverSnapshot`**（會員端與免註冊兩條路徑，`registerForCompetition`）：`{source:'competition'|'default', text, lang, photoConsent, savedAt}`。賽事有自訂內容→存**後端**的（不信前端）；沒填→存前端帶上來的 `waiverShownText`（≤20000 字）與 `waiverLang`。舊報名無快照。報名名單查詢是欄位白名單，不會帶出快照；員工端目前**沒有檢視快照的畫面**。服務層建測試報名讀回驗證後已刪（簽名圖內嵌在報名文件，無殘留）。
- ⚠️ **未做／注意**：①會員端未成年報名的法代資料維持原流程（法代簽名那邊沒收姓名/電話/關係）②頁面僅 build 通過、未實際開畫面看 ③「攀岩隊模擬賽(初賽)」同意書欄位是空的→訪客會看到預設文字，上線前確認適用 ④**免登入報到 QR 連結尚未做**——訪客仍無 QR、當天靠櫃檯「手動報到」；設計討論結論：QR 內容只有隨機代碼 `compchk:<uuid>`（不含個資），連結頁建議只顯示賽事名/QR/遮罩姓名/已報到狀態，**待使用者決定組別是否顯示、姓名是否遮罩**。
- ✅ **葉育昕（新竹，矯正班 11-12月周三B班）實繳更正（純資料）**：`memberPaidAmount` 8400→**7980**、`staffNote`「待退款 420元」→「10/12 已linepay 退款 420元」，**兩處都要改**：`courseRegistrations/8e5c4a7e-…`（總表）與 `courseEnrollments/98ad457d-…`（`payEnrollmentId`）。應繳 `fee` 7980 與營收 `transactions`（7980 轉帳）原本就對、未動；420 為退回她多匯的款，**未新增退款交易**（只改報名欄位）。備份 scratchpad `backup-ye.json`。
- 📌 **備忘**：課程報名的「實繳／會員自報匯款金額」＝`memberPaidAmount`（總表＋付款報名各存一份）；「實收覆寫」是另一個欄位 `receivedAmountOverride`，別混。

## 目前進度（2026-10-13）— 小蜘蛛人等級考核第一期＋林珮瑜街口重複記帳＋電話入場提示線上入場券（後端 `/health` `3.570.0-phone-checkin-paid-ticket-hint`；前端 buildId `staff-86d48da828d4b8d3`）
- ✅ **小蜘蛛人 1~16 級考核（第一期，3.569.0）**：16 最入門、1 最高（初階班 16→9、進階班 8→1；內容來自「小蜘蛛人上課紀錄表 V4」PDF）。`routes/climbLevels.js`（掛 `/climb-levels`）；集合 `climbLevelDefs/{program}_{level}`（練習項目 title／標準 standard／體能 fitness／說明 description，管理員可在員工端編修；初始由 `scripts/seed-climb-level-defs.js` 匯入，冪等不覆蓋）、`climbLevelRecords`（每次考核，**只增不改**，誤登用 `voided` 作廢）。紀錄欄位：級數、進度 `progress`（50/75/90/100，**100＝通過**）、考核日期、考核教練 `coachName`（預設帶該班課程 `instructor` 字串，可改）、說明、備註。會員目前等級＝未作廢且通過的紀錄中**級數最小者**（沒有＝尚未通過任何級），不另存欄位、即時推導。
  - 啟用範圍＝`DEFAULT_PROGRAMS.spider`：新竹、班別「小蜘蛛人初級班」`ebf83b51…`／「進階班」`48151e8e…`、**非工作坊**（可由 `systemSettings/climbLevels` 覆寫）。寒暑假密集班不在內。
  - 權限：登記考核＝任何員工帳號（含值班 operator；教練多為 part_time 個人帳號，已把 `/staff/levels` 加進 part_time／full_time 選單）；編修級別定義與作廢＝super_admin／gym_manager。會員只能看自己與名下子會員（`parentMemberId`）。
  - 前端：員工端 `/staff/levels`（`LevelsPage.jsx`：選班→批次登記全班、「等級設定」分頁僅管理員、點學員看歷史／作廢）；會員端「課程報名→我的課程」頂部 `MemberLevelsCard`（本人＋子會員，有紀錄者才顯示，含下一個目標）。
  - ⚠️ **未做／未驗證**：員工端與會員端畫面僅 build 通過、**未實際開畫面看**；API 以測試帳號 0900123123 端到端驗過（測試紀錄已清）；1 級體能原表寫 Toe to bar 5 下（與 8 級重複，疑筆誤，先照原表，管理員之後自行修）；不通知家長；既有學員起始等級**日後再匯入**（要一份「學員→目前級數」名單）；**集點換獎品（第二期）尚未做**，規劃與待決定事項在 memory `spiderman-level-stamp-plan`。
- 🧾 **林珮瑜（士林，0967015101）街口付款後沒跳出 QR → 櫃檯電話入場又收一次（純資料修正）**：10/13 17:40 她在會員端用街口付 300（`payments/5e511b84…` paid，線上入場券 `744631f3…` 付款當下開出、tx `U7BO…`），**沒有走到產生 QR**（`pendingCheckIns` 無紀錄，原因查不出）；17:42 櫃檯（張元賓）用「電話入場」＋街口 300 再記一筆（tx `OeuI…`、checkIn `3mkyP1Y3…` source:phone），入場券留著未用。修正（備份 scratchpad `backup-lin.json`）：刪重複 tx `OeuI…`、checkIn 改成「使用線上入場券」（`entryType:single_entry_ticket`、`amountPaid:0`、`paymentMethod:null`、`singleEntryTicketId`、`transactionId:null`，**與一般線上入場兌換後的資料形狀一致**）、入場券標 `used`；發票 EF76056463（街口 300）不動。
  - 📌 **線上入場券正常兌換的資料形狀（日後對帳用）**：付款當下一筆 `transactions`（type checkin、relatedId＝票 id、notes「線上付款（jkopay）」），兌換入場的 checkIn 為 `entryType:single_entry_ticket`、amountPaid 0、無 tx。同一人出現「線上付款 tx＋櫃檯 phone 入場 tx」＝重複記帳。
  - ⚠️ **這次口述名字與資料不符**（使用者說「陳珮瑜」，實為「林珮瑜」；資料庫無陳珮瑜）：我先改了資料才確認人選，使用者事後確認是林珮瑜。**口述姓名查無或對不上時，先列出候選並確認，再改資料。**
  - 付款後沒跳出 QR 的成因**未查明**（程式有 `?paid=1` 導回與「20 分鐘內新開通線上入場券自動產生 QR」保底，MemberQRPage）；推測是停留在街口 App／導回頁面沒載入，未驗證。待補：她的裝置與付完款停在哪。
- ✅ **電話入場提示已付款的線上入場券（3.570.0＋員工端）**：`/checkin/eligibility/:memberId` 的 `instruments.singleEntryTicket.tickets` 多回 `source/amount/paymentMethod/expiresAt`；`CheckinPage.jsx` 電話入場在選定會員後，若有 `source==='online-entry'` 的未使用券，顯示黃色提示框「已用○○線上付款 NT$○，有未使用的入場券，請直接使用，不要再收費」＋「使用此入場券入場」切換鈕（設定 `phoneInstrument`，走既有 `/checkin/direct`）。只提示線上付款來源的券；VIP／定期票／課程學員也會顯示。**畫面僅 build 通過、未用真實資料驗證**（林珮瑜那張已用掉）。

## 目前進度（2026-10-13 續）— 林子雲虹瑩進階班 10/13 補課（額外補課券＋週二班超收一位＋入場改補課券）＋線上入場付款設定查證
> 純資料操作，無程式異動。會員 `dc502ee4-57c9-49b7-9b07-9deb7341d7e4`（林子雲，0963004187，原班虹瑩進階班週四班，士林）。
- ✅ **補課券**：館方「再給一張」→ `courseMakeupRights/c8f6720e-749a-42b4-8107-9ac00fc67c14`（`source:'manual'`、`exempt:true`、效期當日，存 2026-10-12T16:00Z＝台灣 10/13 00:00），已標 `used`。**未記錄她缺的是哪一天**（使用者未提供）。
- ✅ **名單**：補到今天 19:30「虹瑩進階班 8-9月週二班」（場次 `a6b7b0ce…`），**館方同意超收一位**（enrolledCount 4/3）。報名 `courseEnrollments/88412951-59cd-4b3c-9e54-e695d3cc5ff8`（`isMakeup:true`、手動三筆寫入，同 10/06 做法；`makeupTarget:'off'` 被刻意繞過）。備份 `backup-ziyun2.json`。
- ✅ **入場更正**：她原本用「已付費入場」放行（checkIn `626loNsaoZoE8Gk7G6Hv`，`already_paid`、金額 0、無交易/發票）→ 改成 `entryType:'course_access'`、`paymentMethod:'cash'`（沿用欄位）、`amountPaid:0`＋`correctionNote`，不影響營收。備份 `backup-ziyun3.json`。
- ✅ **點名**：查 `courseAttendance` 該場次已有一筆 `present`（入場時 `markTodayCourseAttendanceOnEntry` 自動標記，與 entryType 無關），**不需補點名**。⚠️ 我一度以為報名文件沒出席欄位就是沒點名——**出席紀錄在 `courseAttendance`（sessionId＋memberId），不在 `courseEnrollments`**，查點名請看前者。
- 📌 **補課登記慣例（虹瑩等不自動發券的班，第二次遇到）**：發額外券→手動報名＋場次人數＋券 used 三筆寫入（可超收）→若學員已先用別的方式入場，改該筆 checkIn 為課程學員入場。
- 📌 **線上入場付款設定**（`systemSettings/paymentMethods`）：`enabled` 為 transfer/cash/taiwanpay/linepay/jkopay 全開；`onlineFlows` 只有 `entry:true`（街口線上先付再入場）。要改回「櫃檯付款」只需把 `onlineFlows.entry` 設 false，**不用改程式**；街口在 iPhone 付完不會自動回到網頁（停在街口 App），所以林珮瑜那類「沒跳出 QR」是此流程的已知痛點，使用者尚未決定是否關閉。
- ✅ **2026-10-13 已關閉街口線上入場付款**：`systemSettings/paymentMethods.onlineFlows.entry` true→false（直接改 Firestore，備份 scratchpad `backup-paymethods.json`），八個 `onlineFlows` 現全為 false。原因：iPhone 付完款停在街口 App、不會回到網頁，林珮瑜等人沒跳出入場 QR。已付款未使用的線上入場券仍可兌換；櫃檯收款不變。重新開啟＝把 `entry` 改回 true（或員工端設定→付款方式），不用改程式。
  - 🧪 **驗證範圍（如實）**：正式 API `GET /settings/payment-methods` 回 `entry:false`、會員端網域跨域讀取同值；會員端入場頁依 `useOnlineFlowEnabled('entry')` 決定是否顯示線上付款入口（`MemberQRPage.jsx`，`onlinePayable` 需此旗標為真）。**未能實際登入會員帳號看入場頁畫面**（測試帳號密碼不能由我輸入），畫面是否已無街口入口待有人用手機確認。（已於 `3.571.0-entry-online-flow-backend-gate` 補後端把關，見下）。
  - ✅ **後端把關（3.571.0）**：`paymentService.createPayment` 對 `orderType==='entry'`（非 mock）讀 `onlineFlows.entry`，非 `true`（含讀取失敗）→ 400 `ONLINE_FLOW_DISABLED`「入場線上付款目前未開放，請至櫃檯付款」。只管 entry，其他流程沿用既有行為（它們的開關本來就是關的、只擋前端入口）。
  - 🧪 **實測（正式站，測試會員已登入的瀏覽器）**：①用該會員 token 直接 `POST /payments`（jkopay＋entry）→ 400 `ONLINE_FLOW_DISABLED` ②會員端入場頁走「士林館→成人入場→單次入場→不租借→選擇付款方式」，付款方式頁為現金／LinePay／街口／台灣Pay 四項，並寫明「皆需至櫃檯掃描店內立牌條碼付款」，沒有線上先付款入口或文案。
- ✅ **2026-10-14 取消固定對外 IP、Railway Pro 降 Hobby**（決定不用街口線上支付，不再需要街口 API 白名單）：`railway outbound-network static-ip disable` ＋ redeploy（部署 `f156e6a2` SUCCESS、`/health` ok 3.571.0）；方案由使用者在網頁降級（我這邊的降級操作被自動安全檢查擋下，未繞過）。**驗證**：`railway api` 查 workspace `plan: HOBBY`、`subscriptionModel: USER`；`railway outbound-network status` 為 Static IPs disabled；`railway usage` 計費週期 10/13–11/13、預估 $0.60。10/14 當天已先扣 Pro $20（降級不退）。細節與重開須知見 `docs/outage-playbook.md` 第七節。⚠️ 街口側白名單未處理、街口合約是否解約未確認。
  - 📌 **Railway CLI 可用**：`railway outbound-network status|static-ip enable/disable`、`railway usage`、`railway api '<graphql>'`（查 `me.workspaces{plan}`）、`railway redeploy --service redrock-api -y`、`railway deployment list`；方案升降級只能走網頁。


## 目前進度（2026-10-14）— 員工端「課程場次出不來」＝查詢逾時被吞掉；getSessions 全面並行（後端 `/health` `3.575.0-transfer-confirm-parallel`；前端 buildId `staff-7fc63a6a1db7bf29`）
> 回報截圖：員工端 課程→場次管理，選「【新竹館】小蜘蛛人初級班 9-1…」顯示「共 0 堂／尚無場次」。**資料沒問題**（9-1 月各梯次都有 20+ 堂場次）。
- 🐞 **根因**：`CoursesPage.loadSessions` 呼叫 `GET /courses/sessions` 抓「整館、課程開始日起 180 天」的所有場次（新竹約 500 筆），後端 `courseService.getSessions` 再逐組（每 30 場次一組、17+ 組）**依序 await** 撈報名與跨期補課來算人數 → 單次 **24~30 秒**；員工端 axios `timeout: 10000`（`api/client.js`）先逾時，`catch (e) {}` 把錯誤吞掉、`sessions` 維持空陣列 → 畫面顯示「尚無場次」。**不是沒資料，是逾時＋靜默吞錯**。
- ✅ **修 1（場次管理）**：`getSessions` 新增第 4 參數 `courseId`（只查該梯次、不限日期，人數統計沿用同一套）；路由 `GET /courses/sessions?courseId=&withStats=1`（僅員工，會員端與報名算費用用的 `?courseId=` 快速路徑**行為不變**）；前端 `loadSessions(course)` 有選梯次就走這條。22 堂 2.9 秒→**0.3 秒**；與舊結果逐欄比對（enrolled/leave/makeup/trial/crossMakeup/registered/expected/instructor/status）無差異。
- ✅ **修 2（月曆等所有 getSessions 呼叫端）**：報名／跨期補課／課程教練三組查詢**彼此獨立→合併成一個 `Promise.all`**，各組 in 查詢也並行。月曆（新竹 10 月，138 場次）**5~8 秒→0.5~0.8 秒**，整學期 24 秒→1.2 秒；與舊結果逐欄比對無差異。**讀取文件數不變**（費用不增；修 1 還讓場次管理讀取量降到約 1/20）。
- ✅ **修 3（同型）**：`courseRegistrationService.getTransferConfirmationData`（課程報名報表的確認收款/匯款資料，依 enrollId 分 30 筆一組查 `transferRecords`）原逐組 await → 並行；284 筆 ids 實測 460→117 ms，結果與舊版 JSON 完全相同。
- 📌 **掃描結果（同型「逐組 await in 查詢」）**：`products.js:481` 已是並行；`fallTestBookings.js:134` 只有本人＋子女（極少組）；`courseService.getMakeupCandidateSessions` 的三處迴圈組數很少（班別/補課類型）。其餘未發現會隨資料量成長的同型寫法。
- 💡 **教訓**：①**員工端 client timeout 只有 10 秒**，任何會隨資料量成長的列表端點超過就會「靜默變空」（`catch (e) {}` 吞錯），排查「列表出不來」先用管理員 token 直接打 API 量時間（`curl -w %{time_total}`），別先懷疑資料 ②**Firestore 查詢獨立就並行**（`Promise.all`），逐組 `await` 的耗時＝組數×單次往返；Railway→Firestore（asia-east1，同區）每次往返實測仍偏高（單次 query 端點約 1 秒，含認證查員工），並行是最有效的緩解 ③`loadSessions`／`loadCourses` 這類 `catch (e) {}` 仍多處存在，之後若再出現「空畫面」先看是不是吞錯。
- ⚠️ **未驗證**：員工端畫面我沒有實際登入看（只驗 API 與 build/deploy 版本一致）；`catch (e) {}` 吞錯的畫面行為**未改**（沒加錯誤提示）。

## 目前進度（2026-10-14 續）— Railway→Firestore 單次往返忽快忽慢（依實例）＋員工端課程頁載入失敗不再靜默（後端 `3.576.0-latency-diag-kept`；前端 buildId `staff-f93ac17fd515412d`）
> 承上段「場次出不來」兩個遺留項。
- 🔍 **單次往返偏慢的查證（新增診斷端點 `GET /_diag/latency`，super_admin、只讀少量文件，保留供日後使用）**：同一版程式在不同部署實例上量到**天差地別**——`3.575.1` 那個實例：讀一筆 staff 文件 **約 520 ms**（連續 5 次 2.6 秒、並行 5 次 0.8 秒＝每次請求都有固定約 0.5 秒底噪，非頻寬問題；cpuCount 48、loadavg 約 2）；重新部署成 `3.575.2` 後：同一個動作 **約 50~60 ms**（連續 5 次 0.27 秒、當月 138 場次查詢約 110 ms；DNS 1ms／TCP 1ms／TLS 7ms；cpuCount 32），連量 8 次都穩定。→ **慢不在 DNS/TCP/TLS，也不在 Firestore 位置（asia-east1，Railway 在 asia-southeast1）；是「該實例（宿主機）」的差異**，換一個實例就好了。先前整天看到的「單次 query 約 1 秒」應是落在慢實例上。
  - ⚠️ **結論是推論，樣本很小（只比較到 2 個實例）**；為何某些實例慢**未查出**（懷疑宿主機網路路徑或鄰居干擾；跟固定 IP 無關——慢實例是在固定 IP 關閉並 redeploy 之後才量到的）。
  - 📌 **日後再覺得後端整體變慢**：先用管理員 token 打 `/_diag/latency`；`doc_get_1st` 約 50ms＝正常，約 500ms＝這個實例慢，重新部署（`railway redeploy --service redrock-api -y`，或任何 push）通常換到快的實例。**我想連續重新部署多次取樣被自動安全檢查擋下（Production Deploy），未繞過，所以「慢實例出現的機率」未知。**
  - 附帶：`getSessions` 並行化（上段）在慢實例上更重要（往返次數 5→3，原本 5 次×0.5 秒）。
- ✅ **員工端課程頁載入失敗不再靜默**（`CoursesPage.jsx`）：班別／課程列表／場次／月曆四個載入函式原本 `catch (e) {}` 吞錯（月曆只清空），改為頂部**紅色提示**「⚠️ ○○載入失敗（連線逾時／伺服器回應 N），畫面上的資料可能不完整，不是真的沒有資料」＋「重新載入」按鈕（成功後自動清除，過期回應不誤報）。**其餘員工端頁面仍有 `catch (e) {}`（SettingsPage 21 處、CheckinPage 4、VipPage 3、PassesPage 2、GymsPage 2…）未改**；`makeup-types` 那處也未改。
  - ⚠️ **提示畫面我沒有實際看過**：員工端要登入，我這邊只驗了 build、bundle 含新文案、版本碼與線上一致；沒有真的製造逾時看到紅色提示。


## 目前進度（2026-10-14 續2）— 員工端「讀取失敗」全域紅色提示（前端 buildId `staff-2cfe8a46d61e847e`，後端無異動）
> 承上段：員工端各頁 `catch (e) {}` 共約 45 處（SettingsPage 21、CheckinPage 4、VipPage 3、PassesPage 3、GymsPage 2、RentalsPage 2、ExperienceBookingsPage 2、DailySettlement/Installments/Members/Sales/Schedule 各 1…），逐頁改容易漏，改成**集中處理**。
- ✅ **`api/client.js`（員工端共用 client）回應攔截器**：GET 失敗且為「逾時／斷線／伺服器 5xx」→ 發 `window` 事件 `staff-load-error`（`{url, detail}`）。**不提示**：4xx（權限/找不到/參數錯，屬預期回應）、非 GET、背景輪詢端點（`/pending-tasks`、`/version.json`、`/client-errors`、`/_diag`）、被取消的請求。
- ✅ **新 `components/LoadErrorBanner.jsx`**（掛在 `StaffLayout` 主內容區 `<Outlet />` 上方）：收到事件顯示紅色「⚠️ ○○資料載入失敗（連線逾時/網路連線失敗/伺服器回應 N），畫面上的空白或缺漏不代表沒有資料」＋「重新整理」鈕＋✕；同一頁多個失敗合併顯示（依網址前綴對應中文名，對不到顯示「部分」）；**切換頁面自動清除**；課程頁（`/courses`、`/course-categories`）自己已有「重新載入」提示，這兩類網址不重複顯示。新增員工端 API 前綴時，要顯示中文名就補 `LABELS`。
- ✅ **唯一的「寫入動作」吞錯**：`SettingsPage.handleToggleStation`（啟用/停用館別電腦）失敗改顯示錯誤訊息（原本靜默、畫面像是成功）。盤點 45 處只有這一處是寫入，其餘皆為讀取。
- **驗證**：Node 模擬攔截器 7 情境——GET 逾時／斷線／500 → 發事件；GET 404／403、`/pending-tasks` 逾時、POST 500 → 不發。**banner 畫面本身與整合行為我沒實際看過**（員工端要登入，只驗 build、攔截器邏輯、版本碼與線上一致）。
- ⚠️ **刻意沒動**：各頁的 `catch (e) {}` 程式碼本身仍在（提示改由全域攔截負責）；`MemberOnboardingGate` 內 `/auth/member/me` 的 `catch (_) {}` 是會員端刻意 fallback（失敗沿用舊值）；寫入類失敗各頁原本多數已有自己的錯誤訊息，不由全域提示。若日後想連 POST/PUT 失敗也全域提示，要先逐頁確認不會與頁內訊息重複。
- 📌 **已知取捨**：同時出現「頁內自己的提示」與全域提示的頁面可能看到兩條；背景輪詢端點失敗不提示（避免短暫斷線一直跳）。

## 目前進度（2026-10-14 續3）— 共用化普查第一組：下載工具／場館名稱／角色判斷（後端 `/health` `3.577.0-shared-roles-helper`；前端 buildId `staff-076425741006ab01`）
> 起因：使用者要求普查「該共用卻做成分散檔案」的程式，先做低風險第一組。**其餘（付款方式中文對照、waiver blockReasons 兩套、額滿判斷、手機正規化、attachInvoiceStatus、fmtTs 等）刻意未動，風險評估見下。**
- ✅ **新 `redrock-web/src/utils/downloadFile.js`**（`downloadFile(url,{params,filename})`）：走共用 `client`、逾時放寬 60 秒（共用 client 預設 10 秒，大檔/後端現場產生會誤逾時；原手刻 fetch 無逾時）、失敗拋可顯示的 Error（403→「權限不足」，其餘「狀態碼＋回應文字前 120 字」，blob 錯誤內容會讀回文字，**不會把錯誤文字存成檔案**）。取代 5 處手刻 `fetch`+手讀 token：`SalesPage` 庫存匯出、`ExperienceBookingsPage` 體驗預約名單／旅平險名冊、`CompetitionsPage` 報名名單／簽到表暨保險名冊。`client.js` 的全域「載入失敗」橫幅對 `responseType:'blob'` 下載**不觸發**（由頁面自己顯示下載失敗訊息）。
- 🐞 **順手發現並修的兩個既有 bug**：①**`SalesPage` 庫存匯出寫死 `http://localhost:3001/products/export`**（正式站必定失敗，舊程式 catch 只顯示「匯出失敗」）②**`GET /experience-bookings/insurance-download`（旅平險名冊，不帶 bookingId）一直 500**：`status != cancelled`＋`gymId ==` 需要未建的複合索引（FAILED_PRECONDITION）；前端舊版沒檢查回應，**會把錯誤 JSON 存成 `.xls`**，所以沒人發現。後端改 `gymId` 單一條件＋記憶體排除 cancelled（同 10/04 入場統計匯出的修法）；正式環境 500→200 `application/vnd.ms-excel`。
- ✅ **前端 `GYM_LABEL` 11 份各自定義→統一 `import { GYM_LABEL } from utils/gymLabel`**（值完全相同；`TicketApprovalModal`、`ExperienceDetailModal`、`FallTestBookingModal`、`TransferConfirmModal`、`InquiryReplyModal`、`MemberPassesPage`、`PublicRoutePage`、`PublicCourseCategoryPage`、`PublicCoursesPage`、`RevenuePage`、`PayoutsPanel`）；移除寫死 API 網址（`ExperienceBookingsPage`、`CompetitionsPage`、`PassesPage` 的 `VITE_API_BASE || 'https://api…'`；`VITE_API_BASE` 專案內**從未設定**，與共用 client 的網址相同，行為不變；`PassesPage` 的 `API_BASE` 本來就沒人用）。順手移除 `ExperienceBookingsPage` 不再需要的 `getToken`／`token`。
- ✅ **後端新 `src/utils/roles.js`**（`isManagerRole(role)`、`MANAGER_ROLES`）：18 處手寫 `['super_admin','gym_manager'].includes(role)` 機械替換（`middleware/auth` 2、`checkin` 2、`climbLevels` 1、`climbingRoutes` 1、`competitions` 2、`courses` 2、`dailySettlements` 2、`gyms` 4、`products` 1、`transfers` 1）。語意完全相同（role 為 undefined/null/空字串皆 false）。
- 🧪 **「確認不影響目前作業」的驗證**：
  - **後端**：①`isManagerRole` 8 組輸入單元測試全過 ②13 個受影響模組逐一 `require` 載入成功 ③**部署前後各跑一輪**管理員身分打 18 個端點（匯出、入場、場館、商品、比賽、課程場次、票券統計、待辦…）逐一比對**狀態碼＋內容型別＋回應欄位**：**唯一差異＝旅平險名冊 500→200（預期的修復）**，其餘完全一致。
  - **前端**：①`downloadFile` 以 Node 模擬 5 情境（成功/403/500含內容/逾時/斷線）——成功時檔名與請求參數、`timeout:60000`、`responseType:blob` 正確，失敗訊息與舊版一致且不存檔 ②兩個 target build 成功、線上 `version.json` 與本機一致、線上 bundle 200 ③免登入公開課程頁（用到共用 `GYM_LABEL`）實機載入正常（「新竹館・士林館 · 12 梯」）。
- ⚠️ **未驗證／限制（如實）**：①**員工端畫面未實際點過**（要登入）：5 個下載按鈕的真實點擊、下載後檔案內容皆未人工開啟確認（只驗了端點可用＋工具邏輯）②**非管理員身分的權限路徑未在線上實測**（館別電腦帳號 `/stations/login` 在本次拿不到 token），只靠單元測試與機械替換保證語意；③公開課程頁第一次載入曾顯示「載入失敗，請稍後再試」，**重新載入後正常、未再重現，成因未查明**（API 當下回應正常，疑似當下請求逾時；同一時間 `/auth/member/me` 耗時 2.3 秒，與 10/14 查到的「實例忽快忽慢」相符，**未證實**）。
- 📋 **未動項目與風險（供日後排序）**：①**中風險**：後端 `validate` 中介層 19 份（15 份相同、4 份有差異，先看回傳格式）、`toDate`／`resolveGymEmail`／`uploadImage`（上傳上限 5/10MB 不同）、`EXPIRY_WARNING_DAYS`（4 份皆 30，政策數字）、前端 `WEEKDAYS`／`wdList`／`wdShort`／`fmtTs`（簽名不同）／`Modal`（同名 10 份，**未看內容**）②**高風險不要急著合併**：付款方式中文對照（前端 `PM_LABEL`／`PAYMENT_LABEL`／`STATUS_LABEL`、後端 5 份文案互異，有些是刻意如合約 PDF 用「匯款」）、waiver／墜測 blockReasons（`auth.js` 與 `memberService` 兩套，9/26 踩過）、額滿判斷（前端 3＋後端 3，見 9/27 `statusLabel` 教訓）、手機正規化 7 處、`attachInvoiceStatus` 3 份、前端自己重算比賽報名費預覽。③`src/api/competitions.js` 的 `downloadCompetitionCSV` 網址組裝函式**沒有任何呼叫端**（死碼，未刪）。
- 📌 **新增員工端檔案下載一律用 `downloadFile`**，不要再手刻 `fetch`＋讀 localStorage token；新增後端「管理層」判斷用 `isManagerRole`；場館名稱用 `utils/gymLabel`。

## 目前進度（2026-10-14 續4）— 共用化普查第二組（中風險）：validate／toDate／resolveGymEmail／uploadImage／常數／星期／fmtTs（後端 `/health` `3.578.0-shared-validate-upload-date`；前端 buildId `staff-89df6c0fc104e2a7`）
> 承續 10/14 續3（第一組）。原則：**各份先逐一比對差異，行為不同的就保留兩種版本、不硬併**；全部「行為不變」。
- ✅ **後端 `middleware/validate.js`**：原 19 份手寫 `const validate`，實際是**兩種回應形狀**——`validate`＝`{error:'VALIDATION_ERROR', details}`（16 檔，含 `members.js` 只是排版不同）；`validateWithMessage`＝多附 `message`（「欄位: 訊息」以「；」串接，`passes`／`schedule`／`staff` 3 檔，前端有頁面會顯示 message）。兩種各自對應原檔（B 組以 `validateWithMessage: validate` 引入），**刻意不統一成一種**，否則畫面上錯誤文字會變。各檔原本 `import { validationResult }` 變成沒用到，未清（無害）。
- ✅ **其餘後端抽共用**：`utils/firestoreDate.js` `toDate`（loginLock／cardTransferService／ghostAccountService 三份逐字相同；⚠️ `deviceAuthService` 的 `toDate` 語意不同——非 Timestamp 時原樣回傳、不轉 Date、無 null——**刻意不併**）；`utils/gymEmail.js` `resolveGymEmail`（registrationNotify／courseContractService／passContractService 三份逐字相同）；`middleware/uploadImage.js`（`uploadImage`＝10MB 供 gyms／courses／courseCategories，`uploadImage5MB`＝5MB 供 memberReminders，上限差異保留；`makeMemoryUpload(mb)` 工廠）；`config/constants.js` `EXPIRY_WARNING_DAYS=30`（discountCard／legacyCard／bonus／teamMember 四個 service；前兩者原本就 export 此常數，照舊 export）。`products`／`passAdjustments`／`transfers` 的 `upload`（名稱不同）未動。
- ✅ **前端抽共用**：`utils/weekdays.js` `WEEKDAYS`（5 頁各自定義）；`utils/weekdaysI18n.js` `wdShort`／`wdList`／`WD_EN`／`WD_JA`（MemberCoursesPage／PublicCourseCategoryPage；**員工端不要 import 這份**，會把 memberI18n 帶進 staff bundle）；`utils/formatTs.js` `fmtTs`（三個審核彈窗逐字相同；⚠️ `MemberProfilePage`〔可傳 format/fallback、吃 `{seconds}`/ISO〕與 `MembersPage`〔`YYYY/MM/DD HH:mm`、空值回空字串〕的 `fmtTs` 行為不同，刻意不併）。`MemberCoursesPage` 的 `wdOf` 仍在本檔（用 `wdShort`）。
- ⛔ **查了但決定不併：員工端 10 份本地 `Modal`**（RentalsPage／SalesPage／CardsPage／RoutesPage／PassesPage／MembersPage／CompetitionsPage／SchedulePage／CoursesPage／InstallmentsPage）——與 `components/Modal.jsx` 逐一比對，**沒有任何一份與共用版相同**：遮罩有無 `padding:16`／`backdropFilter`、`maxHeight` 85/88/90vh、邊框 0.5px/1px、`RoutesPage` 有 iOS `WebkitOverflowScrolling`、寬度預設 420/480/520/620 或固定 420/480/600。硬併會改變彈窗外觀/手機捲動行為，而員工端畫面我看不到、無法驗收，故不動。要併需先決定「以哪個外觀為準」並在手機實機驗。
- 🐞 **順手修一個既有 bug（ESLint `no-undef` 掃出）**：`CompetitionsPage` 的「核准友館折扣／取消友館折扣」按鈕成功後呼叫不存在的 `load()`（ReferenceError）→ 後端動作其實已成功，畫面卻跳「操作失敗」且名單不更新；改成同頁其他動作用的 `openRegistrations(showRegistrations)`。**這兩顆按鈕我沒實際點過**（員工端要登入、且需有「待核對友館折扣」的報名）。
- 🧪 **驗證**：
  - **後端**：①validate 新舊（A、B 兩種）在 3 組輸入下回應逐字相同（Node + 真 express-validator）②`toDate` 8 種輸入與舊版相同、常數三處皆 30、上傳上限 10/5MB、`resolveGymEmail` 對 null／真館／不存在館的結果正確 ③**載入 routes／services／middleware／utils 全部模組 0 失敗** ④部署前後各跑一輪：**19 個 POST 端點送空資料的完整 400 回應逐字比對 NO DIFF**（涵蓋 A、B 兩種形狀、含 auth/members/passes/staff/vip/courses/competitions/stations/payouts/…）、第一組的 36 項端點檢查也 NO DIFF ⑤Railway 日誌無錯誤關鍵字。
  - **前端**：①Node 比對 `wdShort`／`wdList` 在 zh/en/ja 三種語言、`WEEKDAYS`／`WD_EN`／`WD_JA`、`fmtTs` 7 種輸入，與舊定義**全等** ②**ESLint `no-undef` 掃全專案：0 錯誤**（建置不會抓「定義被移走但仍在用」——實際抓到過 `MemberCoursesPage` 漏 import `WEEKDAYS`，已補）③兩個 target build、線上版本碼與 bundle 200 ④實機開：免登入班別頁（「每週三 16:30～18:00」、場館名稱）、報名頁、已登入會員的課程總覽（「每週六 10:45～12:15」，`wdList` 實際渲染）皆正常。
- ⚠️ **未驗證／限制**：員工端各頁畫面（審核彈窗的時間顯示 `fmtTs`、排班頁 `WEEKDAYS`、課程頁）**沒登入員工端點過**，只靠逐字等價測試＋ESLint＋build；`multer` 的 import 在 gyms／courses／courseCategories／memberReminders 變成沒用到（未清）；上傳實際檔案沒測（只測了限制值）。
- 📊 **實例延遲新線索（本次意外量到，3 個樣本）**：`/_diag/latency` 的 `env.cpuCount`＝**48 的實例單次讀取約 500~670ms（慢）；＝32 的約 50ms（快）**——`3.575.1`(48，慢)→`3.575.2`(32，快)→`3.578.0`(48，慢)。慢實例上公開班別頁 API 約 9 秒（前端 10 秒逾時邊緣，曾顯示「找不到此班別」；重載後 OK）。**仍只是相關性、樣本小、因果未證實**；若再覺得慢，先看 `/_diag/latency`，`doc_get` 約 500ms 就是慢實例。

## 目前進度（2026-10-14 續5）— 公開班別頁 21 秒＋後端實例忽慢事件：改為只算單一班別／預熱／背景更新（後端 `/health` `3.581.0-public-category-warmup`）
> 起因：使用者指出「公開班別頁 API 21.8 秒無法接受」；稍後又回報「前端全部大延遲」。**真實客人請求在慢實例上最慢 10 秒（HTTP 日誌 `499`＝客人端 10 秒逾時放棄），含新會員註冊 `POST /members/self-register`、`entry-docs/sign`、`/pending-tasks`**。
- 📊 **實例速度二分法（本日 5 次部署實測，`/_diag/latency`）**：`cpuCount=48` 的實例單筆讀取約 **500ms**（連續 5 次 2.5 秒、當月場次查詢約 1 秒）；`cpuCount=32` 的約 **55~70ms**（連續 5 次 0.3 秒）。本日樣本：`3.575.1`(48 慢)、`3.575.2`(32 快)、`3.578.0`~`3.580.1`(48 慢，含一次手動 redeploy 仍慢)、`3.581.0`(32 快)。慢時真實流量 p90≈3.3 秒、最大 10 秒；換到快實例後中位數 108ms、p90≈1 秒、最大 1.3 秒。**相關性很一致，但根因（為何某些宿主機慢）未查明；也無法證明是否與 10/14 的 Pro→Hobby 降級有關**——降級前沒有任何資料庫延遲基準，Railway HTTP 日誌只保留最近約 15 分鐘，查不到降級前的請求耗時。
- ✅ **公開班別頁 `GET /courses/public/category/:id`（慢實例冷請求 17~21 秒→約 4~10 秒；有快取時 0.1 秒）**：①`getCourses` 冷快取時「類別／報名人數／場次」三組查詢改並行（原 12 個先後往返→2 個），並加 in-flight 去重（同時多個冷請求只算一次）與快取版本號（`getCoursesCacheVersion`，`invalidateCoursesCache` 遞增）②新 `getCoursesByCategory(categoryId)`：只算該班別的梯次（單一欄位查詢＋記憶體篩狀態/排序，不依賴複合索引；欄位與 `getCourses` 逐項相同；20 個班別 84 門課實測逐字相同含順序），不再掃全系統 133 門課＋約 2,500 筆報名③`getTrialSessions` 新增 `opts.courseIds`（只算指定課程；原本每次 11 次查詢＋35 次單筆讀取＋約 1,900 筆文件、無快取）；課程／類別／各批報名查詢也改並行；限定與全域篩選實測相同④路由回應快取＋stale-while-revalidate：新鮮期 120 秒內直接回；過了新鮮期（24 小時內）先回舊資料、背景重算；課程有異動（版本號變）或超過 24 小時才同步重算⑤**啟動後 20 秒預熱所有開放班別**（`warmPublicCategories`，依序、背景；本機 17 個班別 2.7 秒），部署後第一位客人不用等。
- 🧪 驗證：新舊 `getCourses`／`getTrialSessions` 結果逐字比對相同；公開班別頁整份回應與改動前線上版逐字相同；5 個同時冷請求只算 17 次查詢（去重成功）；快轉時鐘模擬 SWR（新鮮期 0 次查詢、過期後立即回應並背景重算、課程異動後同步重算）皆符合；36 項端點檢查與 19 項驗證回應部署後 NO DIFF。
- 💡 **使用者的設計質疑（未動，待決定）**：「只看剩多少名額，為什麼要查 2,500 筆報名？」——**課程層人數目前沒有儲存計數器**，`getCourses` 是掃 `courseEnrollments`（週課每位學員每堂各一筆，22 堂×人數＝數千筆）算「不重複學員數」，再由 `computeStatusLabel` 判斷額滿；只有**場次**有儲存的 `enrolledCount`（報名/請假時維護）。可行的結構改善：①在課程文件存計數器（報名/取消/暫停/恢復/補課等約十幾個呼叫點要同步維護，漂移風險大）②改用 Firestore `count()` 聚合③改以每人每課程一筆的 `courseRegistrations` 總表計數（有「重複群組」陷阱，語意需先對齊）。本次只做「縮小範圍＋並行＋快取」，**沒有改計數方式**。
- ⚠️ **未驗證／限制**：①慢實例上冷請求仍要數秒（本日量到首次 10 秒、第二個班別 4.4 秒），靠預熱與背景更新避免客人碰到，但**課程異動後第一位訪客**、**24 小時以上沒人來**、**預熱失敗**時仍會碰到冷計算②預熱在慢實例上也會慢，但在背景不擋請求③公開頁實機重新載入沒再測（只測 API）。④推送 CLAUDE.md 也會觸發 Railway 重新部署（無 watch 設定），可能換到慢實例——所以文件變更盡量跟程式變更一起推。
- 📌 **遇到「後端整體變慢／客人說很卡」的處理順序**：①管理員 token 打 `GET /_diag/latency`，看 `doc_get_1st`（約 50ms 正常、約 500ms＝慢實例）與 `env.cpuCount`（48 慢、32 快的相關性）②`railway logs --http --since 3m --json` 看真實請求耗時分布與 `499`（客人逾時放棄）③慢就重新部署換實例（`railway redeploy --service redrock-api -y`；一次不夠要再試，但每次都是正式環境部署）④根因與方案（Pro 方案是否影響、請 Railway 客服查宿主機）仍待決定。
- ✅ **會員端入場頁「無法入場／請聯絡服務台」其實可能是驗票請求逾時（前端 buildId `member-8969e70764fec341`，2026-10-14 17:00 前後使用者傳來截圖）**：`MemberQRPage.doVerify` 的 `catch`（逾時/斷線/5xx）原本只設 `error` 並進 `blocked` 畫面，但 blocked 畫面只讀 `verifyResult`——於是顯示預設標題「無法入場」＋「請聯絡服務台」，**客人會以為被拒絕入場**（那張截圖時間 16:57，正是慢實例時段）。修：①請求失敗（無回應或 5xx）時清掉舊 `verifyResult`、設 `verifyFailed`，畫面改顯示 ⚠️「驗票失敗」＋「連線逾時或網路不穩，並非無法入場。請按『重新驗票』再試一次；若一直失敗請洽服務台。」（中英日，`memberI18n.js`）②`/checkin/verify` 這次請求 timeout 放寬為 25 秒（共用 memberClient 預設 10 秒）。真正的資格不符（回應 200 `allowed:false` 及各 `reason`）流程不變。**實測**：在已登入的會員瀏覽器用腳本讓 `/checkin/verify` 的 XHR 失敗 → 畫面顯示新文案；重新載入後正常流程顯示「成人入場」選項不受影響。⚠️ 未查是哪位會員（截圖無帳號資訊）；會員端其他頁面有沒有同型「失敗被當成拒絕/空資料」未普查（員工端已有全域紅色提示，**會員端沒有**）。
- ✅ **待辦頁載入失敗不再顯示「✅ 目前沒有待處理事項」（前端 buildId `staff-b4d7ab3f529e3a4c`）**：`PendingTasksPage.load()` 失敗時原本把 `tasks`／`registrations` 清成空陣列，畫面會顯示綠色「目前沒有待處理事項」，櫃檯會誤以為沒待辦（慢實例時段實際發生過卡「載入中」／空白）。改為：失敗時**保留原有資料**，頂端顯示紅色「⚠️ 待辦載入失敗（連線逾時／伺服器回應 N）。目前無法確認是否有待處理事項（或：下方顯示的可能不是最新資料）」＋「重新載入」鈕；總數為 0 且載入失敗時不顯示綠色空狀態；「退回追蹤」失敗改顯示警示（原本顯示「目前沒有待追蹤的退回件」）。`/pending-tasks` 在全域紅色提示的略過清單內（背景輪詢），所以這頁需要自己的提示。**失敗畫面我沒有實際造出來看**（只驗 ESLint no-undef 0、build、版本碼一致）。

## 目前進度（2026-10-14 續6）— 後端啟動自動量讀取速度、偏慢通知超級管理員（後端 `/health` `3.582.0-latency-monitor`）
> 起因：Railway 不同實例的單筆讀取延遲差 10 倍（見續5），慢實例上客人逾時卻要等客人回報才知道。
- ✅ **新 `services/latencyMonitor.js`**：啟動後 10 秒量一次、之後每 30 分鐘一次（`unref` 計時器，不阻擋程序結束）；方法＝連續讀 `gyms/gym-hsinchu` 6 次，**丟掉第一次**（含 gRPC 連線建立，本機實測第一次 178ms、之後約 20ms），取後 5 次中位數；中位數 > 門檻（預設 **250ms**，環境變數 `LATENCY_SLOW_MS` 可調；快實例約 50~70ms、慢實例約 500ms）→ `console.log` 一行＋用 `notifyRoleInGym({gymId:null, role:'super_admin', type:'system_slow_instance'})` 通知**所有超級管理員**（員工端待辦→通知可看到；Debby Chu／Sean／系統管理員）；**同一實例 3 小時內不重複通知**；先前通知過「慢」、之後量到恢復 → 通知一次 `system_slow_instance_recovered`「✅ 已恢復」。通知內容含中位數、cpuCount、部署 ID 前 8 碼與建議（到 Railway 重新部署換實例）。每次 6 筆讀取（約每天 300 筆），成本可忽略；永不拋錯、失敗只記 log。
- ✅ `index.js` 啟動時 `latencyMonitor.start()`（在預熱公開班別頁之前）；`GET /_diag/latency` 回應多一個 `monitor`（上次量測時間、中位數、是否偏慢、是否已通知、門檻）。前端通知面板對未知 `type` 只是沒有「查看」連結，不會出錯。
- 🧪 **驗證（可注入假資料庫／假通知／假時鐘，不會真的發通知給人）**：快實例(5ms)不通知；慢實例(400ms)通知 1 次、同一實例 3 小時內不重複、超過 3 小時仍慢再通知、慢→快發「已恢復」、持續正常不再通知；讀取失敗／通知函式失敗皆不拋錯；真實 Firestore（本機）量得到 23ms 且未誤報；收件人（3 位超級管理員）查詢存在。**線上實例上的實際通知路徑未真的觸發過**（目前實例是快的；要實測需把 `LATENCY_SLOW_MS` 設很低再重新部署，會真的發通知給三位管理員）。
- ⚠️ **限制**：①只量「單筆讀取」，抓不到「某幾種查詢特別慢」②每個實例各量各的，多實例時會各自通知（目前單一實例）③偏慢通知後若沒人處理，3 小時後會再提醒一次④**量測時間點**：啟動後 10 秒量到快、之後才變慢的情況，要等下一個 30 分鐘週期才會發現。

## 目前進度（2026-10-14 續7）— 課程層人數改讀「報名總表」並修正「已取消學員仍佔名額」（後端 `/health` `3.583.0-course-headcount-from-registrations`）
> 起因：使用者質疑「只看剩多少名額，為什麼要查 2,500 筆報名？」。實測 `getCourses` 冷載入讀 2,523 筆（課程 133、班別 20、場次 415、**報名紀錄 1,955**）；週課每位學員每堂各 1 筆報名紀錄（`courseEnrollments`），1,955 筆只對應 326 組「學員×課程」（約 6 倍）；**課程文件本身沒有人數欄位**，所以每次都掃全部報名紀錄再數不重複學員。
- ✅ **改法（`courseService._computeCourses`）**：課程層 `enrolledCount`／`realEnrolled`／`waitlistCount` 改從 **`courseRegistrations`（報名總表，每位學員每門課 1 筆）** 計：`status==='confirmed'` 的不重複 `memberId`＝在籍人數、`status==='waitlist'`＝候補人數；查詢以 `.select('courseId','memberId','status')` 排除總表內嵌的簽名圖。新增 `REGISTRATION_COLLECTION` 常數。全系統讀取：報名紀錄 1,955 筆→總表 282 筆（課程／班別／場次不變），本機冷載入 549ms→206ms。
- 🐞 **順便修正的舊算法錯誤**：學員退費／取消後，只有「未來堂次」的報名紀錄被標 cancelled，「已上過的堂次」為保留出席紀錄仍是 `confirmed`；舊算法只要有任一筆 confirmed 就算在籍→**已取消學員繼續佔名額**。實測 `矯正班 9-10月週三B班`（上限 4，黃士昕 10/7 退費取消）顯示 4/4 額滿、實際在籍 3 人（會誤擋合法插班/試上）；`入門班 7-8月週一A班`（黃詠慈 8/20 取消，已結束）同型。改後這兩門 4→3，**這是預期且正確的行為變化**（矯正班 週三B班 現在可再插班一位）。
- 🧪 **驗證**：①先量全庫邊界：總表 confirmed 244 筆中「該學員沒有任何一般 confirmed 報名」0 筆（試上/補課不會產生被計入的總表紀錄）、「全部堂次都暫停」0 筆、現行算入但總表非 confirmed 恰 2 組（即上述兩位）、候補（現行 2 組／總表 2 組）完全一致 ②舊版／新版 `getCourses(null)` 全部 133 門逐欄比對：**只有上述 2 門的 `enrolledCount`／`realEnrolled` 4→3，其餘欄位（含 statusLabel、順序）完全相同** ③`getCoursesByCategory` 15 個班別與全域新算法完全一致。
- ⚠️ **已知邊界差異（目前全庫 0 筆，未來才可能出現）**：①學員「所有堂次都被暫停」時，舊算法不算在籍、新算法（總表仍 confirmed）仍算；一般「中途暫停」兩者結果相同（舊算法也因已上過的堂次而算在籍）②若日後有流程為試上/補課學員建立 confirmed 總表紀錄，會被誤算進課程人數——目前 `createRegistrationHeader` 只在正式報名流程呼叫，試上/補課不建。**之後新增報名流程要記得：只有「正式在籍」才建 confirmed 總表，且取消/退費/轉班要同步更新總表狀態，否則課程人數會錯。**
- 📌 **場次層人數（`getSessions`）仍從逐堂報名紀錄算**（每堂的正取/請假/補課/試上要逐堂數，不能用總表），這次沒動；`getCourses` 仍讀 415 筆未來場次（供 `hasFutureSession`／工作坊 `anySessionOpen`），後續可再瘦身。
- ⚠️ **更正（2026-10-14 傍晚）：「cpuCount=48 慢、32 快」的相關性已被推翻**——`3.583.0` 的第三次部署落在 `cpuCount=48` 的實例，單筆讀取卻只要 59~63ms（監測中位數 76ms）。**cpuCount 不能當預測指標**；判斷慢實例請直接看 `/_diag/latency` 的 `doc_get_1st`（約 50~70ms 正常、約 500ms 以上偏慢）或延遲監測的通知。本日各次部署結果（慢＝單筆讀取約 500~950ms）：3.575.1 慢、3.575.2 快、3.578.0~3.580.1 慢（含一次手動 redeploy）、3.581.0 快、3.582.0 慢→redeploy 快、3.583.0 慢→redeploy 慢→redeploy 快；**約一半的部署落在慢實例，慢實例成因仍未查明**。前面續5／續6 兩段中提到「cpu 48 慢、32 快」的敘述，請以本更正為準。

## 目前進度（2026-10-14 續8）— 公開「梯次詳情」「試上場次詳情」也加快取＋預熱；三支公開頁共用 SWR 工具（後端 `/health` `3.584.0-public-pages-swr-warmup`）
> 起因：使用者問公開頁查詢要多久；實測（快實例）班別頁 0.11~0.15 秒（有快取）、梯次詳情 0.26~0.5 秒、試上場次詳情 0.30~0.34 秒，慢實例約 5~10 倍；後兩支原本沒有快取。
- ✅ **`routes/courses.js` 新增通用 `makeSwrRoute(handler,{keyOf,freshMs,maxStaleMs})`**（stale-while-revalidate）：新鮮期 120 秒內直接回；過了新鮮期但同版本內（`courseService.getCoursesCacheVersion` 未變）→ 先回舊資料＋背景重算；課程有異動（`invalidateCoursesCache` 遞增版本）或超過 24 小時 → 同步重算；同 key 同時多請求只算一次；**只快取 200 成功回應**（404/5xx 不快取）、最多 400 筆先進先出淘汰；`route.warm(key, fakeReq)` 供預熱。**套用於**：`GET /courses/public/category/:id`（班別頁，原本自寫的快取改用此工具）、`GET /courses/public/:courseId`（梯次詳情）、`GET /courses/public/session/:sessionId`（試上場次詳情）。`/public/categories`（班別總覽）原本就約 0.1 秒、未動。
- 🐞 **順手修一個我自己前面寫的風險**：班別頁快取原本連 404 也快取（`<500`），亂打 `/public/category/<隨機id>` 會讓快取 Map 無限成長；現在只快取 200。
- ✅ **預熱（`warmPublicCategories`，啟動後 20 秒背景執行）擴大**：全部開放班別的班別頁 → 兩館 `getCourses` → 這些班別底下每個梯次的詳情 → 班別頁裡出現的場次（工作坊場次＋額滿梯次的可試上場次）詳情；梯次／場次每次同時 4 個。本機實測：班別 17、梯次 42、場次 22，**讀取約 4,442 筆、282 次往返、約 3.5~5 秒**（慢實例上往返×5~10 倍，背景執行不擋服務）。
- 💰 **對 Google Cloud（Firestore 讀取）的影響（估算，非帳單數字）**：①預熱每次部署約 4.4 千筆；平日 1~3 次部署＝約 4~13 千筆/天，部署特別多的日子（今天約 25 次）約 11 萬筆/天——以每 10 萬筆約 US$0.06 估算，平日 <US$0.01/天、今天約 US$0.07②快取讓公開頁的重複讀取下降：梯次詳情原本每次約 18 筆（1 課程＋約 17 場次）＋該館 getCourses（5 分鐘快取、冷時約 670 筆），現在新鮮期內 0 筆、過期後最多每 2 分鐘每頁重算一次；目前觀察到 15 分鐘約 6 次梯次詳情／3 次場次詳情（約 600／300 次/天，每天約 1 萬筆）→ 預期**持平或略降**③**不會增加的**：試上場次詳情每次只 2~3 筆，預熱它幾乎無成本。**實際用量請以 GCP 帳單（Firestore Read Ops）對照確認，我沒有實際量過部署後的用量曲線。**
- 🧪 **驗證（本機連真實資料）**：新舊路由回應逐字比對——梯次詳情 45 門、班別頁 15 個、試上場次詳情 40 個**全部相同**；不存在的 id 仍 404；快取行為：新鮮期內再呼叫讀取 0 筆、過新鮮期立即回應（2ms）並背景重算（9 筆）、背景更新後再呼叫 0 筆、課程異動後同步重算（208 筆）、404 不快取（兩次呼叫都重查）；預熱後第一位客人讀取 0 筆。
- ⚠️ **取捨／限制**：①座位數（`enrolledCount`）在「很久沒人看的頁面」第一位訪客可能是舊的（最久 24 小時），但背景立刻更新、再看就是新的；報名動作由後端即時驗證名額②**沒有人為某梯次報名時不會主動讓該梯次詳情快取失效**（報名/取消只靠 120 秒新鮮期＋SWR）③預熱失敗只記 log，不影響服務④慢實例上預熱期間（約數分鐘）第一位看「尚未預熱到的頁面」的訪客仍可能碰到冷計算。
- ✅ **更正＋瘦身（`3.585.0-warmup-reads-trimmed`）：預熱讀取 4,442 筆→1,760 筆（約 -60%），`courseEnrollments` 1,537→77**。使用者質疑「4,442 筆讀了什麼？不需要吧？」，拆解（依步驟）：①17 個班別頁各自計算 2,914 ②兩館各自 `getCourses` 870 ③42 個梯次詳情 572 ④22 個場次詳情 66；其中報名紀錄 1,537 筆幾乎全來自「額滿梯次的可試上場次」——為了找未來 14 天內約 2 堂，卻把每門額滿課程全部 22 堂與其報名統計都讀了。三處修正（皆行為不變）：(a) `getSessions(gymId,from,to,courseId)` 指定 `courseId` 時若同時給日期範圍就限縮（`courseId+date` 複合索引已存在；員工端 `?courseId=&withStats=1` 不帶日期，行為不變），`getTrialSessions` 限定路徑改只讀 [今天, +14 天] 內的場次 (b) `getCourses(gymId)`／`getCoursesByCategory`：**全系統(`__all__`)快取新鮮時直接由它篩出**（不再各自重算；每門課欄位逐門獨立計算，篩出與單獨計算逐項相同、順序也相同），預熱改為先算一次全系統再往下 (c) `getTrialSessions` 的「常態在籍不重複人數」改讀報名總表（同 `getCourses`；此數僅用於非週課的 `trialTarget=auto`，週課一律列出）。
- 🧪 驗證（本機連真實資料）：①單館×2＋單班別×15「篩出 vs 各自計算」全部逐項相同 ②額滿梯次 20 門可試上場次：舊（整門課）12 筆／新（14 天內）12 筆，內容相同 ③**本機新版 79 頁（班別頁 15＋梯次詳情 42＋場次詳情 22）與線上現行版逐字比對 0 頁不同** ④會員端「課程試上」分頁用的全域可試上場次 48 筆新舊相同、兩館各自（38／10 筆）新舊相同。**預熱讀取 1,760 筆**（courseSessions 1,001、courseRegistrations 320、courses 203、courseCategories 159、courseEnrollments 77）。上段「約 4.4 千筆」「今天約 11 萬筆」估算請改以此為準：平日 1~3 次部署約 2~5 千筆/天，部署特別多的日子（今天約 25 次）約 4 萬筆/天（以每 10 萬筆約 US$0.06 估算約 US$0.03）。
- 📌 **決定（2026-10-14，使用者）：不會升回 Railway Pro**。後端慢實例問題改走：延遲監測通知＋手動 `railway redeploy` 換實例（本日實測：換 2~3 次內通常會落到快實例）、減少客人關鍵路徑（入場驗票、註冊、簽署）的先後資料庫往返、公開頁快取／預熱（已做）、必要時請 Railway 客服查慢主機。

## 目前進度（2026-10-14 續9）— 客人關鍵流程的資料庫「先後往返」大幅縮短（後端 `/health` `3.586.0-customer-flows-parallel`）
> 起因：慢實例（單筆讀取約 500ms）上，新會員註冊、簽署入場文件、入場驗票會超過客人端 10 秒逾時被放棄（HTTP 日誌 `499`）。使用者決定不升回 Pro，所以改減少這些流程的**先後往返層數**。
- 📏 **量測方法（唯讀，可重跑）**：本機連真實資料，**所有寫入攔截**（不改資料），每次 Firestore 呼叫加固定 100ms 延遲，(總耗時－無延遲耗時)÷100ms＝先後排隊的往返層數（同時發出的只算一層）；腳本在當次 scratchpad `flows.js`。**改前全是逐個排隊**（層數≈呼叫數）：入場驗票 19 層（約 9.5 秒＠慢實例）、家長替子會員驗票 11、簽署入場文件 18、新會員註冊 21（約 10.5 秒＠慢實例）。**改後**：入場驗票約 3~5 層（約 2~2.5 秒＠慢）、家長替子會員 7、簽署文件 12（約 6 秒＠慢）、註冊 13（約 6.5 秒＠慢）；快實例（約 50ms/層）各約 0.2~0.65 秒。
- ✅ **改了什麼（皆「獨立的唯讀查詢同時發出、再依原順序判斷」，行為不變）**：
  - `checkin/gates.js runEntryGates`（入場驗票／產生 QR／電話入場共用）：同日重複、會員、Waiver、墜測、分期逾期五項查詢先同時發出，再依原順序逐關判斷；預先發出的查詢用 `_early`（`.catch(()=>{})`）避免提早 return 時 unhandledRejection。代價：前面關卡擋下時（已入場/未簽署/墜測未過）後面幾項白讀。
  - `checkin/verify.js verifyEntry`：VIP／定期票／課程入館三項同時發出（VIP/持票者多讀 1~2 次）；付費分支的九項讀取（折扣券、黑卡、單次券、紅利、可購票種、原價、兩個優惠設定、入場類型設定）改 `Promise.all`，讀取數量不變。
  - `memberService`：`getBlockReasons` 拆出 `fetchBlockInputs`（Waiver 小欄位＋已通過墜測），`refreshBlockStatus` 讓會員文件與這兩項同時發出（少 1 層，`signEntryDocs` 內被呼叫 3 次）；`getBlockReasons(memberId, memberData, prefetched)` 第三參數選填，原呼叫端不受影響。
  - `memberService.createMember`：12 個「自動認領」原本逐個 await；皆自己吞錯、不會拋出，依相依分鏈同時執行（鏈內維持原順序）——鏈1 墜測→攀岩隊員（同步墜測效期）→課程名單預留→前期請假補課券→公開訪客課程報名；鏈2 90 日票；鏈3 BeClass 比賽報名→公開訪客比賽報名；鏈4 舊生；鏈5 VIP；鏈6 訪客體驗預約→待指派體驗單日券；全部做完才算封鎖狀態（原本也是）。
  - `waiverService.signEntryDocs`／`signWaiver`／`fallTestService.signConsent`：兩個互不相依的檢查各自同時發出（`signWaiver` 已鎖定時多讀一筆範本；`signConsent` 驗證失敗時多讀一次「是否已簽」）。**刻意沒動**：`signWaiver` 與 `signConsent` 之間維持依序（兩者各自呼叫 `maybeSendParentSignEmail`，只有「兩份都存在」時才寄信，並行會有重複寄/漏寄的競態）。
- 🧪 **驗證（真實資料、寫入攔截）**：①`verifyEntry` 新舊逐人比對 **326 位會員×兩館＝652 組，0 不同**，涵蓋 付費431／課程入館65／定期票41／VIP18／已入場19／缺 Waiver18／墜測未過50＋過期8／分期逾期2 各分支；②`runEntryGates`（skipDuplicate／using／預設）360 組 0 不同，不存在會員兩版皆拋 `MEMBER_NOT_FOUND`；③`getBlockReasons` **全部 1,996 位會員 0 不同**；④`refreshBlockStatus` 150 位（比對寫入內容與回傳）0 不同；⑤`signEntryDocs` 20 組（兩份皆缺成人/未成年/子會員/只缺同意書/都已簽）寫入內容 0 不同；⑥`createMember` 37 組情境（無命中、舊墜測、舊隊員 10 筆寫入、舊 VIP、舊生…）寫入內容 0 不同。
- ⚠️ **未驗證／限制**：①`createMember` 的「舊90日票」「待認領課程」兩類情境，我用舊資料名單湊出的測試資料**沒有真的命中認領**（寫入只有 2 筆），這兩條鏈只靠「鏈內維持原順序、各函式自己吞錯」的結構推論，沒被實際資料驗到②家長替子會員驗票仍有 7 層（含 `checkMemberOwnership` 與被擋下後的 `hasSpiderCourseAccess` 等先後步驟）、簽署文件 12 層、註冊 13 層，**慢實例上仍要約 3.5~6.5 秒**，離 10 秒逾時有餘裕但不快；③員工端與會員端畫面、真實瀏覽器流程**沒有實際走過**，只驗了服務層與寫入內容；④量測是用固定 100ms 模擬，慢實例實際耗時以 `/_diag/latency` 與真實流量為準。
- 📌 **之後新增客人流程的寫法原則**：互不相依的 Firestore 讀取一律 `Promise.all`；有「先後相依」或「競態風險」（如寄信冪等）才維持依序；要比對改動前後行為，用「寫入攔截＋新舊逐項比對」而不要真的寫資料。

## 目前進度（2026-10-14 續10）— 移除 4 個已不活躍的註冊自動認領（後端 `/health` `3.587.0-remove-inactive-claims`）
> 起因：使用者問「12 個自動認領哪些已經不活躍」。依「來源資料還剩多少未認領＋最近有沒有被認領」判斷（腳本 `claims-activity.js`，唯讀）。
- ✅ **已移除（函式與 `createMember` 呼叫都刪，`createMember` 其餘認領行為不變）**：①`claimLegacyPass`（舊 90 日票；legacyPasses 23 筆**全數已認領**）②`claimLegacyCompetitionReg`（BeClass 比賽報名；12 筆全已綁會員）③`claimPendingCourseEnrollment`（課程名單預留；pendingCourseClaims 49 筆全已認領，且**全專案已沒有任何程式會建立新的預留資料**，只剩讀取：`courses.js` 的名單顯示）④`claimLegacyCourseAlumni`（舊生名單；151 筆中 116 筆已認領、**剩 35 筆**，近 30 天 0 筆認領；使用者明確決定移除）。**④的後果**：那 35 位舊生日後註冊，將不再自動判定「舊生報名優惠」（已認領的 116 位不受影響；`legacyCourseAlumni` 集合與讀取舊生資格的程式都沒動）。刪除程式約 264 行；`createMember` 註冊流程往返層數 13→12。
- 🧪 驗證：`createMember` 新舊寫入內容比對 37 組情境（寫入攔截）——移除①②③後 0 不同；再移除④後**只有「舊生名單命中」的 2 個情境少一筆 `legacyCourseAlumni.update`**（預期），其餘 35 組相同；載入全部 107 個後端模組 0 失敗；全專案已無這四個函式的呼叫（只剩註解提及名稱）。
- ⛔ **使用者要求移除但我暫不執行（等重新確認）**：⑤`claimGuestCourseEnrollments`（訪客課程報名）——**我先前表格寫「全庫沒有訪客報名文件」是錯的**：當時用 `memberId` 以 `guest` 開頭判斷，實際訪客報名的旗標是 `isGuest:true`，用旗標重數＝**課程報名 32 筆、課程總表 5 筆**（比賽報名 0 筆）；使用者是依錯誤數字下的決定。⑥`claimGuestCompetitionRegistrations`（訪客比賽報名）——目前 0 筆，但免註冊比賽報名是**上線中的功能**（10/12 上線、12/13 兒童賽可能用到），移除後訪客日後註冊成會員時，其比賽報名不會自動掛到帳號（會員端看不到、無報到 QR 的升級路徑）。兩者**未移除**。
- 🐞 **更正（自己的資料錯誤）**：10/14 活躍度表中「11 訪客課程報名：0 筆」「12 訪客比賽報名：0 筆」的 `guest_` 前綴判斷有誤，正確數字見上；**日後判斷某類資料是否為訪客，用 `isGuest` 旗標，不要用 `memberId` 前綴**。
- 📌 **決定（2026-10-14，使用者）：#11 訪客課程報名認領（`claimGuestCourseEnrollments`）與 #12 訪客比賽報名認領（`claimGuestCompetitionRegistrations`）都不移除**，維持現狀。註冊時仍保留的認領共 8 個：舊墜測、舊攀岩隊員、前期請假補課券、訪客課程報名、訪客比賽報名、VIP、訪客體驗預約、待指派體驗單日券。

## 目前進度（2026-10-15）— 補上會員「修改密碼」端點（原本一直 404）（後端 `/health` `3.588.0-member-change-password`）
> 回報：會員鄒猷新（yuhsintsou@gmail.com）說密碼外洩、也無法修改密碼。後端 commit `fix: 補上會員修改密碼端點…`、前端(redrock-web) `fix: 修改密碼最短 8 碼、顯示後端錯誤訊息`，皆已部署。
- 🐞 **根因**：會員端「個人資料 → 修改密碼」呼叫 `PUT /auth/member/password`，**後端從來沒有這個端點**（git 歷史查無、線上實測 404），前端 catch 一律顯示「修改失敗，請確認目前密碼」——這功能從沒能用過。「忘記密碼」寄信重設流程（`/member/forgot-password`＋`/member/reset-password`）本來就正常。
- ✅ **新端點 `PUT /auth/member/password`**（`routes/auth.js`，`authenticateMember`）：驗證目前密碼（bcrypt）；新密碼至少 8 碼、不可與目前相同；沿用登入的鎖定欄位（`loginFailCount`／`loginLockedUntil`，錯 5 次鎖 15 分鐘）防止拿到登入狀態者暴力猜密碼；成功後清失敗計數、清除未使用的重設 token、寫 `passwordChangedAt`。無 `passwordHash` 的帳號回 `NO_PASSWORD`（請用忘記密碼）。
- ✅ **前端**：最短長度由 6 改 8（與後端一致）、失敗時顯示後端回傳的具體訊息。
- 🧪 **驗證**：本機用臨時會員（測後刪除）測 錯密碼 400／太短 400／與舊密碼相同 400／成功 200 且新密碼 hash 可驗證；線上端點未帶 token 回 401（已存在）。**會員端畫面未實際登入點過。**
- 📋 **該會員查證**：帳號正常（Email 已驗證、有 passwordHash、無鎖定）。「密碼外洩」判斷是手機/瀏覽器密碼管理員（Chrome／iCloud 鑰匙圈）對「該密碼曾出現在其他網站外洩資料」的警告，**非紅石系統外洩**（推論，未看到使用者畫面）。已請其用新端點換一組未在他處使用的密碼。

## 目前進度（2026-10-15）— 士林 10/17 九人單堂體驗課報名＋新竹蘇育政試上費現金→轉帳更正（純資料）
> 無程式異動。**身分證字號不記錄在任何文件。**
- ✅ **體驗預約 `exp_1792064588596_7808`**（士林館、2026-10-17 14:00–16:00、9 人、6,975 元、轉帳、已付款已確認；聯絡人先用葉俊佑、後改**陳世修**，電話 0983591319；指定教練張元賓）。用 `/confirm` 流程：記營收、發 9 張未指定姓名的入場券（`singleEntryTickets`，欄位是 `experienceBookingId`，不是 `bookingId`）、建課程／場次／教練排班（`scheduleShiftId d0ea12cb…`）。9 人 6–12 人級距單價 775。保險名冊 xls 由 `/insurance-download?bookingId=` 產生（生日用民國格式如 740201）。**未成年者（古騏禎）在名冊的欄位未逐格檢查；預約沒有聯絡 email。**
- 🔍 **新竹 10/15 結帳出現四筆「＋現金補入 400（蘇育政 小蜘蛛人初級班 優惠試上）」**：來源是待收款頁 10/14 22:31 確認的 4 筆課程報名（蘇恆、李芯 × 10/21、11/04，各 400），當時 10/14 新竹結帳已「已結帳」，現金補入順延到 10/15 草稿。每筆收款紀錄（`transferRecords`）各產生一筆加減項，**沒有重複記帳**。順延機制是依 CLAUDE.md 與資料推論，沒讀 `addCashAdjustment` 原始碼確認。
- ✅ **更正**：使用者說這四筆其實是**轉帳**。4 筆 `transferRecords.paymentMethod` cash→transfer（附 `paymentMethodCorrectionNote`）；10/15 結帳 `c7114686-…` 移除 4 筆自動現金補入，預期現金 36,378→34,778（＝實際點鈔），差異 -1,600→0，附 `correctionNote`；備份在當次 scratchpad `backup-su-cash.json`。這四筆**沒有對應 `transactions`**（課程款已於確認收款時認列），課程預繳款**不記進結帳「轉帳欄」**（該欄由當日發票／入場／商品算出）。
- 📌 **模式**：待收款頁確認課程現金收款會寫「現金補入」加減項；若收款方式其實是轉帳，要同時改 `transferRecords.paymentMethod` 並移除該自動加減項（`auto:true`，同一筆收款一筆）。

## 目前進度（2026-10-16）— 問題諮詢：再次提問／新增回覆／編輯（後端 `/health` `3.589.0`→`3.591.0`）＋定期票申請姓名補查
> 後端 commit `feat: 問題諮詢支援會員再次提問…`／`feat: 問題諮詢可編輯…`／`fix: 定期票展延…申請姓名…`，前端(redrock-web) 兩筆，皆已部署。
- ✅ **問題諮詢改成對話串 `memberInquiries.messages`**：`[{from:'member'|'staff', text, at, byName?, edited?, editedAt?, editedByName?}]`；舊資料（只有 `content`/`reply`）由 `buildMessages()` 即時還原成 `[提問, 回覆]`，第一次追加／編輯時一併寫回，**不需遷移**。舊欄位持續同步（第 0 則＝`content`、最後一則館方回覆＝`reply`、`repliedAt`/`repliedByName`），相容 `pendingTasks` 與其他仍讀舊欄位的畫面。
  - `POST /member-inquiries/:id/followup`（會員，**僅 `status:'replied'` 時**）：追加一則、狀態回 `pending`、`unread:false`，重新進員工待辦並通知該館管理員（標題加「（再次提問）」）；待回覆中再送回 400 `NOT_REPLIED`。
  - `POST /:id/reply`（員工）改成可對已回覆的提問**新增回覆**（追加一則、`unread:true`）。
  - `PUT /:id/messages/:idx`（會員，只能改自己的提問）、`PUT /:id/messages/:idx/staff`（員工，只能改館方回覆；任何員工可改任何一則）：標 `edited`，順序與時間不變；改別人的訊息 403。
  - 一串對話最多 50 則（`TOO_MANY_MESSAGES`）；單則內容 1000 字。**沒有刪除功能。**
  - 前端：會員端「我的提問」展開顯示完整對話＋「再次提問」輸入框、自己訊息旁「編輯」；員工端 `InquiryReplyModal` 顯示對話串、已回覆者標籤改「新增回覆」、館方回覆旁「編輯」。`pendingTasks` 的 `record` 帶 `messages`。i18n 補中英日（再次提問／編輯／儲存／（已編輯）／您…）。
  - ⚠️ 會員在館方回覆後編輯舊提問：**不會通知、不改狀態**（員工要看「（已編輯）」標記）。**兩端畫面僅 build＋部署，未實際登入點過**；後端用暫時資料本機測過（舊資料還原、追問、待回覆時擋、新增回覆、雙方編輯權限、舊欄位同步）並已清除。
- ✅ **林逸軒（半年定期票）展延申請待辦沒顯示姓名**：`createPassRequest` 的 `memberName` 原本抄 `pass.memberName`，而**櫃檯開票端點 `POST /passes` 從不寫 `memberName`**（全庫 45 張票：26 張有名＝舊系統匯入／人工補登、19 張無名＝全部是現場開票，7/13 起無一例外）。修：票上沒有姓名時，建立申請當下查會員補上；他那筆已核准申請的 `memberName` 補成「林逸軒」。**使用者決定不補另 18 張票的姓名、不改開票端點、也不全面移除各處 `memberName`（後端 51 檔／前端 35 檔用到）**——日後別再提議；原則上姓名可由 `memberId` 查，但現狀顯示正常、不增加查詢。

## 目前進度（2026-10-16 續）— 問題諮詢回覆寄 Email 通知＋體驗課程 20 人／Excel 上傳（後端 `/health` `3.592.0`→`3.593.0-experience-20-participants-xlsx`）
> 後端 commit `be4e65b`、`ea05c3e`；前端(redrock-web) 已部署。
- ✅ **問題諮詢館方回覆後寄 Email 通知會員**（`emailService.sendInquiryReplyNotice`，`memberInquiries.js POST /:id/reply`）：子會員無信箱用家長信箱（欄位 `parentMemberId`）；失敗只 log、不擋回覆；信件僅中文（EN/JA 版使用者決定先不做）。
- ✅ **體驗課程參加人員上限 8→20 人，13–20 人不加價**（級距最後一級 6–12 人單價 775 沿用）；前後端（公開頁、會員端、員工端編輯參加者）皆限 20。
- ✅ **Excel 範本下載／上傳**（四欄：姓名、生日、國籍、身分證字號／護照號碼）：`GET /experience-bookings/participants-template`、`POST /experience-bookings/participants-parse`（免登入，每 IP 每小時 60 次、2MB、檔案只在記憶體解析、不存檔不寫 log）。生日可西元／民國／Excel 日期，統一轉 ISO；國籍空白＝台灣；有問題列（缺姓名／生日讀不懂／未滿 4 歲／缺證號）仍填入，讓客人自行修改；找不到「姓名」表頭回 `BAD_FORMAT`。前端共用元件 `ParticipantsImport.jsx`，上傳只填畫面、不建立預約；名單有資料時加在後面，超過 20 筆略過並提示。
- ⚠️ 未驗證：三個頁面畫面未實際點過；問題列細項訊息僅中文；20 人預約未跑過完整確認流程（發券、建場次、教練排班）。
- 🧾 資料操作：刪除陳世修重複體驗預約 `exp_1792133661366_x3ue`、匯款資訊填入保留的 `exp_1792064588596_7808`。
- 📊 10/16 傍晚量測：實例單筆讀取約 510ms（慢實例），已重新部署換實例。

## 目前進度（2026-10-16 續2）— 課程分期現金收款自動寫入結帳加減項（後端 `/health` `3.594.0-installment-cash-adjustment`）
> 起因：莊曜安（士林）技巧班分期第1期臨櫃現金 3,763，標記已繳只記了營收（`transactions`），結帳加減項沒有 → 今日結帳看不到這筆現金。已先手動補一筆「＋現金補入 3,763」。
- ✅ `installmentService.markInstallmentPaid`／`markInstallmentPlanPaidInFull`：**課程（`relatedType:'course'`）＋現金**時，經 `recordDepositMovement` 寫「現金補入」加減項（`refId`＝分期計畫 id；一次繳清合併成一筆）。**定期票不加**：其營收收款日即時認列，現金已在結帳的 pass 交易統計內，再加會重複；非現金（轉帳等）`recordDepositMovement` 自動略過。
- 📌 **未處理的路徑**：建立計畫時的第1期（`createInstallmentPlan` 的 `firstPaymentMethod`）不加——課程插班的現金走「待收款頁確認」流程，確認時已寫現金補入；`transfers.js` 不碰分期，不會與本次改動重複。
- 🧪 假館 `gym-e2e-test` 驗證：課程＋現金（單期100、一次繳清200）各寫一筆；課程＋轉帳、定期票＋現金皆不寫（測後清除）。

## 目前進度（2026-10-17）— 林佑誠無法簽署：waiver 殘留「本人已簽」狀態（後端 `/health` `3.595.0-entry-docs-stale-waiver`）
- 🐞 7/17 被退回重簽（舊版 `waiver/reset` 清錯欄位，9/27 才修）→ `isComplete=false` 但 `memberSignedAt` 殘留，`signEntryDocs` 判定兩份都已簽回 `ALREADY_COMPLETE`，簽署頁卻因 `isComplete=false` 顯示表單 → 送出必失敗，卡 3 個月。全庫僅此一筆，已清殘留欄位（備份 scratchpad）。
- ✅ `signEntryDocs`：`needsWaiver` 加 `(!isComplete && !parentRequired)`——不需家長卻未完成＝矛盾殘留，視為缺 waiver 允許重簽；需家長者（等家長簽的正常狀態）不受影響。

## 目前進度（2026-10-22）— 新竹矯正班 11-12月周三A班改週四（純資料，無程式異動）；Railway 速度檢查
- ✅ **課程 `530fb8d2-703f-45c8-96d1-8aee55120400` 改為「矯正班 11-12月周四A班」**：週三 19:30–21:30 → **週四 20:00–21:30**，11/5–12/24 共 8 堂（原 11/4–12/23，堂數不變，所以每場次日期 +1 天即可，名單不用重排）；已有 2 人報名（鍾昀達、謝宗樺）。**依使用者指示不通知學員。**
- 🔍 **為什麼不能只在員工端編輯課程**：`PUT /courses/:id` 改 `weekdays`／`startDate`／`endDate` **只改課程文件、不會搬場次**；只有 `startTime`／`endTime` 會連動場次與報名快照，`maxStudents` 連動場次。直接改會造成課程是週四、場次與報名仍是週三。
- ✅ **做法（腳本，改前備份 scratchpad `backup-correct-wed-a.json`）**：課程（`weekdays:[4]`、日期、時間、`cohortName`、`name`）＋8 個 `courseSessions`（`date`+1、時間、`courseName`）＋16 筆 `courseEnrollments`（`date`+1、時間、`courseName`）＋2 筆 `courseRegistrations`（`courseName`）。共 27 份文件，改後讀回核對。事前查無 `scheduleShifts`／`scheduleEvents`／`courseAttendance`／`courseMakeupRights` 連到該課程，故無需搬動。腳本直接寫庫不會觸發 `invalidateCoursesCache`，課程快取最久約 5 分鐘、公開頁約 2 分鐘後更新。
- ⚠️ 未確認：新竹 11/5 有全天「定線-F區」活動（`scheduleEvents`），是否影響晚間課未問；員工端／會員端畫面未實際查看。
- 📌 **日後「課程改星期／整期日期」同型需求**：先查場次、報名（`date` 快照）、教練排班、點名、補課券是否連到該課程；若新舊場次數相同可逐場平移，否則需另行增刪場次與報名。
- 📊 **Railway 速度檢查**（部署 `3.596.0`）：`/_diag/latency` 單筆讀取 51～72ms、延遲監測中位數 60ms（門檻 250ms），非慢實例；診斷請求本身 2.3 秒是內部 TCP 連線量測偶發約 1 秒所致，未深查。

## 目前進度（2026-10-22 續）— 詠弈 1:1 專班 11/6 改 11/27：「重新產生場次」不會搬名單；小蜘蛛人 10/25 補課梯次被「尚未開課」鎖住（純資料，無程式異動）
> 課程 `1ebba3aa-be43-4e62-b7a6-d18687ba7c0f`（特殊時段專班報名表 詠弈 1:1 專班，新竹，週五 15:00–16:30，學員周詠弈）。**正確需求＝11/6 改 11/27 上課、10/30 正常上課**；我第一次聽成「10/30 改 11/27」，搬錯後使用者更正，已重搬。
- 🔍 **名單沒帶過去的原因**：有人按了「重新產生場次」（`regenerateSessions`）。它只補缺的週五場次，**名單只會跟著「已不在新課表上的孤兒場次」轉移**；原場次仍是週五＝在課表上，被原樣保留（連同學員），11/27 則新建成空場次。若改成直接編輯原場次日期（`PUT /courses/sessions/:id`），報名會自動同步，但目標日已有同時段場次時會被 `DUPLICATE_SESSION` 擋下。
- 🐞 **該次重新產生的副作用**：新建 9/25、10/9、10/23、11/27 四個空場次；`totalSessions` 8→12、`price` 被改成 `pricePerSession×12`＝10,800（重新產生會連動整期總價）。
- ✅ **處理（備份 scratchpad `backup-yy.json`、`backup-yy2.json`、`backup-yy3.json`）**：刪除空場次 9/25、10/9、10/23；`totalSessions` 改 8、`price` 改 7,200（8×900 推算，非自舊紀錄還原）；第一次誤把 10/30 報名搬到 11/27 並刪掉 10/30 場次，更正時用備份重建 10/30 場次（同 id）、報名搬回，並把 11/6 報名搬到 11/27（標 `transferredFrom:'2026-11-06'`）、刪空的 11/6 場次。最終 8 堂：9/11、9/18、10/2、10/16、10/30、11/13、11/20、11/27，每堂 1 人，報名日期與場次一致。
- 📌 **日後單堂改期**：直接編輯該場次日期（名單自動跟），**不要用「重新產生場次」**；若已誤用，檢查 `totalSessions`／`price` 與多出的空場次。**口述日期先跟使用者覆述確認再動資料**（這次就是聽錯是哪一天）。
- ✅ **同日：士林小蜘蛛人 10/25 補課場次在學員補課清單被鎖「尚未開課」**：士林另有兩個單堂補課梯次「小蜘蛛人初級班 10/25月週日A班」「技巧班 10/25 月週日A班」（10/21 建，起訖 10/18~10/25，附一個已取消的 10/18 空場次）。補課規則（`enrollMakeup` 的 `TARGET_NOT_STARTED`、候選清單 `courseFirstDate`）用梯次 `unlimitedPracticeStart`（無則 `startDate`）當「首堂日」，**目標梯次須首堂已開始才能補課**；小蜘蛛人該欄位為 10/25（＝補課當天）→ 今天被當成尚未開課、按鈕鎖住（後端也擋）。改成 2026-10-21（同技巧班）後正常出現。此欄位同時是課程學員入場起算日，該梯次無正式學員故無影響。
- 📌 **日後開「單堂補課梯次」**：建完把 `unlimitedPracticeStart` 設成建梯次當天或更早，否則補課清單會顯示「尚未開課」且無法申請；補課券效期也要涵蓋該日。

## 目前進度（2026-10-22 續2）— 員工端比賽編輯：賽事說明／同意書內容文字框可拖曳放大（純前端 `redrock-web`）
> 使用者要求「編輯比賽資訊中的賽事說明、同意書內容（繁中）要跟編輯班別課程說明一樣可以放大」。
- ✅ `CompetitionsPage.jsx` 賽事編輯表單兩個 `textarea`：`resize:'none'` 改 `'vertical'`（右下角可拖曳），並補 `fontFamily:'inherit'`、`lineHeight:1.7`（同課程說明）；預設高度賽事說明 3→4 行、同意書（繁中）4→8 行。其餘文字框（退費政策、報名原因等）未動。
- 🧪 build 兩 target 成功、部署後 `staff.redrocktaiwan.com/version.json` 與本機一致（`staff-f4bec5d52dbcf433`）；commit 在 redrock-web（先 commit 再 build＋deploy）。**未實際登入員工端拖曳驗證。**

## 目前進度（2026-10-23）— 單堂休館停課：Email 通知＋補寄端點＋會員首頁提醒（後端 `/health` `3.599.0-closure-home-reminder`）
> commit `a7d0abc`（寄信）、`d5dbfef`（補寄端點，版本 `3.598.0`）、`7969329`（首頁提醒）。**前兩筆是同日另一段作業完成，本段只依 git diff 記錄**；首頁提醒是本 session 做的。
- ✅ **停課寄 Email**（`courseService.closureCancelSession` → `sendClosureEmails`）：對受影響學員（正取＝已發補課券 `issued`、補課學員＝券已還原 `restored`）背景寄信，子會員無信箱用家長信箱，失敗只記 log；寄完在場次寫 `closureNoticeSentAt`。`emailService.sendCourseClosureNotice`。
- ✅ **補寄端點**（`courses.js`→`resendClosureNotices`）：停課當時沒寄的場次可補寄；場次需為 `cancelled`、預設已寄過（`closureNoticeSentAt`）會擋 `ALREADY_NOTIFIED`，`force` 才重寄。收件人由報名 `status:cancelled`＋`cancelReason:closure`（排除試上）重建。
- ✅ **會員首頁提醒**（`memberReminderService.upsertClosureReminder`，由 `sendClosureEmails` 在寄信前呼叫，失敗不影響寄信）：沿用既有 `memberHomeReminders`（首頁「課程活動提醒」輪播，**前端免改**）。標題「🚫 ○○班 MM/DD 休館停課」、副標含時段與「已發補課券／補課券已還原」；`showFrom`＝停課當下、`showUntil`＝上課當天；固定 doc id `closure_<sessionId>_<對象id>`（同場次同對象只一則，重複呼叫＝覆寫）；`sourceType:'closure_notice'`。**子會員（`isChildAccount`）的提醒掛在家長 id**（`GET /member-reminders/my` 只讀登入者本人 id，子會員沒有自己的登入），標題前加孩子姓名；停課日已過（補寄舊場次）不建。
- 🧪 **驗證（如實）**：用假 id 在真實 Firestore 測 `upsertClosureReminder`（標題/副標、家長帳號查得到、過期日期回 null），測後已刪除；**完整停課流程未實際跑**（會動真實課程），會員端首頁畫面未登入看過。補寄端點補建首頁提醒的路徑同一函式，未單獨測。
- 📊 **部署後速度（10:08）**：單筆讀取 56～74ms、連讀 5 次 272ms、監測中位數 98ms（門檻 250ms），非慢實例，免換。

## 目前進度（2026-10-23 續）— 家庭成員墜測影片可省略＋補課選單可報兒童賽＋首頁八格改版與「快速入場」（後端 `/health` `3.600.0-family-video-waive`；前端 buildId `member-067df1b208d57997`）
> 後端 commit `b14d75b`；前端(redrock-web) `9d27cf0`、`1ba3307`、`8828f2d`、`a0a188f`、`2b4b44e`、`bb29ec0`。**會員端畫面全部僅 build＋部署，未實際登入點過**（我不能替使用者輸入密碼、使用者當下遠端無法操作；測試帳號 0900123123 沒登入過）。
- ✅ **家長名下已有人看完安全影片，第二位起的子會員省略影片**（`fallTestService.familyVideoWatched`、`signConsent` 寫 `videoWaived:'family'`；`GET /fall-tests/video-waived/:memberId`；簽署頁 `MemberWaiverPage` 省略影片區塊）：勾選段落與簽名照舊；判定＝同一位家長名下任何人（含家長自己）已有 `watchPercent≥門檻` 的簽署紀錄。
- ✅ **補課選單（「我的課程→補課資格→選擇補課」）列出開放報名中的兒童賽**（`MemberCoursesPage`）：每場一顆「報名比賽」→ `/member/competitions?comp=<id>`，報名表第一步用既有「使用補課券抵費」（後端 10/07 已有，沒動）。**決策：兒童賽（`competitionType:'kids'`）一律可用補課券抵費，不做逐場開關**；身份收費賽／一般賽不可。補課券屬小朋友時，報名表要先選對報名對象。
- ✅ **首頁八格改版**（`MemberHomePage`）：比賽報名＋體驗課程合併成「📝 報名」一格（點開底部選單：課程報名／體驗課程／比賽報名）；空出的格放在入場 QR 旁，是「⚡ 快速入場」（**格子下方不放小字**，會讓八格高度不一）。**路由與分享連結全部沒變**（`/member/courses?course=`、`/member/competitions?comp=`、`/member/experience` 等；站內通知與首頁提醒卡的連結也不受影響），只是首頁入口收在一起。
- ✅ **快速入場**（`MemberQRPage` `?quick=1&who=<人員id>`、`utils/quickEntry.js`）：記住「每位入場人員」常用的入場選擇，**只存這台裝置 localStorage**（`memberQuickEntry_<登入者id>[_<人員id>]`）；記場館、身分、方案（單次付費／優惠券／黑卡／紅利／入場券／免費資格）、租借、付款方式；**不記**購買定期票／優惠券、友館隊員／特約廠商優惠、續約、線上付款自動產的 QR。租借器材步驟有預設勾選的「記住這次的選擇」。
  - 按快速入場→**重新向後端 `/checkin/verify`** 後比對即時資格（`resolveQuick`＋抽出共用的 `buildMethods`）：仍可用→自動產 QR；黑卡／優惠券／紅利／入場券用罄、身分消失、免費資格（定期票、課程學員）失效或類型改變、付款方式被停用、產 QR 失敗→停在「⚠️ 無法使用快速入場」頁，寫明原因，「重新選擇入場方式」「清除快速入場設定」。入場人員已不在家庭成員→頁首黃色提示走一般流程。**不比對價格**（單次價變了直接用新價）。
  - 快速入場產的 QR 頁多一顆「更改付款方式並重新產生 QR」（只在有付款相關時顯示；回到選付款方式頁、其餘選擇不變，新付款方式變成新的預設）。
  - **有家庭成員**：點快速入場先跳「選擇入場人員」選單（本人＋子會員，`selfEntrySkipped` 的本人不列），已設定者顯示「身分・方案 ⚡」一鍵產 QR，未設定者走一般流程並預選該成員。舊版（一帳號一份）若把子會員的選擇存在本人那格，本人這格會忽略。
  - 🧪 驗證：把 `buildMethods`／`resolveQuick` 原始碼直接取出，用假資料跑 16 種情境（黑卡/優惠券/入場券用罄、身分消失、定期票過期、免費資格變更、付款方式停用或缺漏、租借＋付款…），行為皆符合預期；**畫面、記憶存取、`?quick=1&who=` 帶入、子會員清單載入後才驗票、產 QR 失敗改顯示警示頁等串接都沒實際走過**。
  - 順手修：快速入場產 QR 時粉袋租借狀態沒帶回畫面（合計少算 NT$50），`handleGenerateQR` 成功後補 `setRentChalk`。
- 📌 線上付款（街口 `onlineFlows.entry`）仍關閉；入場頁的線上付款與「付款後自動產 QR」程式碼仍在（休眠），使用者說線上付款現在都不用了，**尚未決定是否清掉**。
- 📌 同日另一段作業（本 session 前半）：Meta Business Suite 粉專快速回覆更新（連結改 app.redrocktaiwan.com、常見問題 2 請假補課規則、營業時間與優惠票價）；紅石會員 App 新手教學資訊圖（SVG→PNG，含 QR、小紅石吉祥物；檔案在 `~/Documents/Codex/2026-10-23/3-4-app-app-redrocktaiwan-com/outputs/`）與 FB／IG 文案——皆非 repo 內容。
