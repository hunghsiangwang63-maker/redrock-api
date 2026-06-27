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

### 一句話原則
> 「會跟著 repo 的檔案（CLAUDE.md / docs）＝可分享、無機密；機密只放 CLAUDE.local.md（本機）。」

---

## 部署備忘（常忘）
- **後端**：`git push` → Railway 自動部署（約 1 分鐘）。
- **前端**：**本機** `BUILD_TARGET=staff/member npx vite build` → `firebase deploy --only hosting --project redrock-dev-a35c1`（**非自動**，git push 不會部署前端）。
