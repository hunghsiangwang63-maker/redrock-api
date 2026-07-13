# Railway 停機應變手冊（Outage Playbook）

> 後端 API 掛在 Railway 單一服務上＝全站唯一單一故障點。**Firestore 資料獨立、掛點不掉資料**，只影響可用性（登入/入場/POS/名單全停）。
> 2026-07-14 曾因用量額度下線一次（edge 回 404「Application not found」）。

## 一、櫃檯現場 SOP（掛點當下）

1. **判斷**：畫面上「所有名單/登入同時失效」→ 手機開 `https://redrock-api-production.up.railway.app/health`
   - 有回 JSON ＝ API 活著，是個別頁面問題 → 回報管理員即可
   - 回 404「Application not found」或連不上 ＝ **服務下線** → 走下面步驟
2. **通知**：立刻通知系統管理員（Sean）
3. **入場改紙本**：登記 姓名／電話／入場身分（單次/學生/兒童/定期票/隊員…）／加購（岩鞋/粉袋）／收款金額與方式／時間
4. **商品銷售**：紙本記 品項/數量/金額/付款方式（恢復後從 POS 補結）
5. **恢復後**：管理員依紙本補登入場（員工端入場登記）與銷售

## 二、管理員恢復程序

1. 開 [railway.app](https://railway.app) dashboard → `redrock-api` 專案
2. 看狀態：
   - **usage limit / paused** → 加值或升級方案 → Redeploy
   - **crashed** → 看 Deploy Logs 找錯誤 → 必要時 rollback 上一版（Deployments → 舊版 → Redeploy）
   - **正常但打不到** → 檢查 domain 設定／Railway 狀態頁 status.railway.com
3. 恢復後打 `/health` 確認版本，並抽查：員工登入、隊員名冊、定期票列表、入場 QR

## 三、預防設定（帳號後台，一次性）

### Railway 用量警示（防額度下線）
- Workspace Settings → Usage → **Usage Limits**
- **Soft Limit**（email 警示）：設額度 7 成
- **Hard Limit**（到達直接停服務）：**不設或設很高**（7/14 的下線即此效果）
- 建議升級按量計費（小服務約 $5–10/月），營運期不要用固定額度方案

### UptimeRobot 外部監控（第一時間知道）
1. [uptimerobot.com](https://uptimerobot.com) 免費註冊
2. Add Monitor → HTTP(s) → URL `https://redrock-api-production.up.railway.app/health`（改自訂網域後換掉）
3. Interval 5 分鐘、Alert 寄到常用 email（可加 LINE Notify webhook）

## 四、故障轉移準備（建議近期完成）

### 步驟 A：API 改自訂網域（讓轉移＝改一筆 DNS）
1. Railway → `redrock-api` service → Settings → Networking → **Custom Domain** 加 `api.redrocktaiwan.com`（會給一組 CNAME 目標值）
2. Porkbun → `redrocktaiwan.com` DNS → 加 **CNAME**：`api` → Railway 給的目標值
3. 等生效後打 `https://api.redrocktaiwan.com/health` 確認
4. 通知 Claude 改前端 `src/api/client.js` 的 `BASE` → `https://api.redrocktaiwan.com`（build + deploy）
   - ⚠️ 未完成 1–3 前不可先改前端，會全站斷線

### 步驟 B：Render 冷備（掛點 10 分鐘內復站）
1. [render.com](https://render.com) 註冊 → New Web Service → 連 GitHub `redrock-api` repo
2. 環境變數複製 Railway 全部（`JWT_SECRET`、`FIREBASE_*`、`RESEND_API_KEY`、`CLIENT_URL`、`API_URL`…）
3. 部署成功後打其 `/health` 驗證，之後**留著不用**（免費層閒置會休眠，無妨）
4. **切換時**：Porkbun 把 `api` CNAME 改指 Render 網址 → 幾分鐘內全站恢復（前提：已完成步驟 A）
5. 每次 Railway 環境變數有新增，記得同步到 Render

## 五、長期選項（金流上線前評估）

- **遷 Google Cloud Run**：與 Firestore 同雲（憑證天然整合）、按請求計費（閒置近零）、可用性遠高於單一 Railway 服務；遷移工作量約 1–2 天。屆時本手冊的網域切換（步驟 A）直接沿用。
