# 如何接手 / 維護專案 context（給人與 Claude）

目的：讓「下一個接手的人或 AI」最快理解專案現況，並知道**改了東西後該更新哪裡**。

---

## 三個 context 來源（重要性 / 可攜性不同）

| 來源 | 位置 | 何時被讀到 | 跟著 repo？ |
|---|---|---|---|
| **`CLAUDE.md`** | 各 repo 根目錄 + `~/Downloads` | Claude 開新對話**自動載入** | ✅ 已 commit |
| **`docs/`** | `redrock-api/docs/` | 需主動開檔（或被 CLAUDE.md 指到） | ✅ 已 commit |
| **`CLAUDE.local.md`** | 各 repo 根目錄 | 自動載入（本機） | ❌ git-ignored，**僅本機** |
| **AI 記憶檔** | `~/.claude/projects/<proj>/memory/` | Claude 自動帶回相關記憶 | ❌ 綁本機+帳號 |

> 結論：**會跟著 repo、隊友 clone 得到的只有 `CLAUDE.md` 與 `docs/`。** 機密與 AI 記憶都只在原作者那台機器。

---

## 接手時：先看這三個

1. **`CLAUDE.md`**（各 repo）—「目前進度 / 待辦」是現況快照。
2. **`docs/payment-integration-plan.md`**—線上金流串接的完整設計與現況（rail 架構、adapter、各收費點接線表、待辦）。
3. **`docs/maintaining-context.md`**（本檔）。
4. 機密（測試帳號等）：複製/索取 `CLAUDE.local.md`（不在 git）。

---

## 維護時：改了東西後更新哪裡

- **有重大進展 / 待辦變動** → 更新對應 repo 的 **`CLAUDE.md`「目前進度 / 待辦」**（效益最高，每次自動載入、且跟著 repo）。
- **架構 / 串接細節** → 更新 **`docs/`** 對應文件（例如金流接新收費點、補 adapter，更新 `payment-integration-plan.md` 第 0 節）。
- **新的機密 / 帳號** → 只寫進 `CLAUDE.local.md`（git-ignored）；**永遠不要**把金鑰、密碼、PAT 放進 CLAUDE.md / docs / 程式 / 版控。
- **金鑰一律走**環境變數（Railway）/ Firestore；GitHub push 走 macOS Keychain。

### ⚠️ CLAUDE.md 落地驗證（2026-07-16 踩雷後新增）
- 更新 `CLAUDE.md` 後 **務必 `git status` 確認該檔真的 modified，再 `git add && git commit`**；commit 完 `git show HEAD:CLAUDE.md | wc -l` 核對行數是否吻合。**別假設「Edit 成功＝已落地磁碟」**。
- 曾發生：api CLAUDE.md 磁碟真檔自 2026-07-04 起再沒被寫過（多 session 併行／harness 內存副本未落磁碟），`git add CLAUDE.md` 每次無 diff＝實際沒 commit，兩週進度只存於 Claude Code file-history（`~/.claude/file-history/<session>/<pathhash>@vN`），差點全失。
- **救援法**：磁碟檔被還原成舊版時，取最新 `file-history` 快照（依 mtime）重建，再 commit 落地。**一次只讓一個 session 編輯 CLAUDE.md**。

### 一句話原則
> 「會跟著 repo 的檔案（CLAUDE.md / docs）＝可分享、無機密；機密只放 CLAUDE.local.md（本機）。」

---

## 部署備忘（常忘）
- **後端**：`git push` → Railway 自動部署（約 1 分鐘）。
- **前端**：**本機** `BUILD_TARGET=staff/member npx vite build` → `firebase deploy --only hosting --project redrock-dev-a35c1`（**非自動**，git push 不會部署前端）。

---

## 給其他人 / 其他 AI（含 ChatGPT）接手前必讀（2026-10-02 新增）

> 背景：同一天內撞到兩種分岔——① ChatGPT 改完 `redrock-api` 有 push，但本機沒拉、落後遠端 3 個 commit ②反過來，`redrock-web` 本機有 4 筆 commit 早就 build+deploy 上線，卻忘了 `git push`，遠端是舊的。兩個方向都要查。

### 1. Git 同步：開工前後都要雙向確認
- 開始前：`git fetch origin` → 看 `git log origin/main..HEAD`（本機領先）**和** `git log HEAD..origin/main`（遠端領先，代表本機沒拉到）。兩邊都空才算同步，只查一邊會漏掉另一種分岔。
- `firebase deploy`（前端）**完全不檢查 git 是否乾淨**——commit/push 跟部署是兩件完全獨立的事。**deploy 成功 ≠ 已經 commit，更不等於已經 push**。收尾前兩個 repo 都要跑一次上面的雙向比對，確認沒有「本機做完部署卻忘了推上去」或「遠端有別人/別的 AI 推的東西我沒拉」。
- `redrock-api`／`redrock-web` 是**兩個獨立 git repo**；本工具的 shell 不會記住 `cd`（每次呼叫結束會重置回預設目錄），改完某個 repo 的檔案後，**務必明確對那個 repo 路徑跑 `git status`／`git add`／`git commit`／`git push`**，不要假設前一步的 `cd` 還有效——這個專案的 CLAUDE.md 歷史記錄過好幾次因此漏 commit 的案例。

### 2. 不要只憑「邏輯看起來對」就收工——這次真實踩到的坑
- **`member.isBlocked` / `member.blockReasons` 是快取欄位，不是即時狀態**：只在簽文件（`signEntryDocs`）、記錄墜測結果、員工開會員詳情頁等特定時機才會重算寫回 Firestore，平常不會自動跟著 waiver/墜測的真實狀態同步，實測過案例卡住數天到 77 天沒更新。任何要判斷「現在是否真的被封鎖」的新程式碼，一律呼叫 `memberService.getBlockReasons(memberId, member)` 即時查詢，別信任文件上存的值。
- **同一種業務邏輯常有兩條以上平行、各自獨立維護的程式碼路徑**（例：課程報名的 `enrollCourse`〔工作坊單場〕vs `handleEnrollAll`〔整期週課〕；比賽報名費/折扣計算曾一度四處各複製一份）。改任何一處業務規則前，**先全域搜尋有沒有另一份長得很像的邏輯**，否則會出現「改了 A 沒改到 B」的半套修復——CLAUDE.md 進度記錄裡這類教訓出現過不只一次。
- **邏輯推演「應該沒問題」不夠，要拿真實資料驗證**。優先順序：①先查真實資料重現問題（不要憑空猜）②用非破壞性方式驗證修復（暫時調整單一欄位、測完立刻還原、逐欄位比對確認還原乾淨）③絕不在未確認安全的情況下對真實會員/館別跑有副作用的測試。

### 3. Firestore 成本意識
這個專案對讀取次數／egress 流量費用很敏感（過去有多輪 session 專門處理帳單暴增，單日費用曾從 $9-15 降到 $3-6）。新寫 Firestore 查詢務必：
- 用 `.select()` 只投影需要的欄位——尤其是內嵌簽名圖的肥集合（`courseEnrollments`／`courseRegistrations`／`competitionRegistrations`／`experienceBookings`，平均每筆 70-170KB）。
- 純存在性檢查用 `.count().get()`，不要整批拉文件只為了算有沒有資料。
- 避免寫無範圍限制（無 courseId/sessionId/memberId 等條件）的全表掃描。

### 4. 測試資料衛生
- 結帳／發票／營收相關測試**一律用假館 `gym-e2e-test`**，絕不能對真實館別（`gym-hsinchu`／`gym-shilin`）測——會真的佔用發票號碼、污染真實財務數字。
- 任何測試建立的資料，收尾要清到**連動的所有集合**（不是只刪主文件——常見漏的：場次人數/enrolledCount、`courseRegistrations` header、`transferRecords`、對應的 `transactions`），並**複查 0 殘留**，不要只信任「清理程式碼有寫」就當已經清乾淨。

### 5. 交接時的具體建議
- 請對方先讀該 repo 的 `CLAUDE.md`「目前進度」區塊跟本檔，了解現有慣例與已知的坑，不要假設對方（尤其不同 AI 工具）會自動知道這些專案特有的慣例。
- 改完東西要求**明確驗證**：git push 真的到位（雙向比對）、正式環境 `/health` 版本號或 bundle hash 對上部署結果、有沒有平行的程式碼路徑忘了同步改——不要只憑「程式邏輯看起來對」就當完成。
- 重大/有風險的改動完成後，補一筆對應 repo 的 CLAUDE.md 進度記錄（延續性），但遵守既有守則：**一次只讓一個 session 編輯 CLAUDE.md**。
