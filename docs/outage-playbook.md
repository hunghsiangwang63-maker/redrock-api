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

### 步驟 B：Render 冷備（✅ 已建置完成 2026-07-17）
- **服務**：`redrock-api-backup.onrender.com`（GitHub push 自動同步、與正式站同版本）
- **已驗證**：/health 同版本 ✓、Firestore 憑證生效（登入端點 401）✓、**JWT_SECRET 與 Railway 同值**（Railway 發的 token 在 Render 直接通過認證）✓
- **切換時**：Porkbun 把 `api` CNAME 改指 `redrock-api-backup.onrender.com` → 幾分鐘內全站恢復（前端不用重發）
  - 切換後第一個請求可能等 ~50 秒（免費層休眠喚醒），之後正常
  - Render 服務需已加 `api.redrocktaiwan.com` 為 custom domain 才能吃該網域流量（未加則切換時到 Render 後台補加，TLS 憑證約 1 分鐘簽發）
- ⚠️ **維運紀律**：每次 Railway 環境變數有新增/修改，**必須手動同步到 Render**（否則故障轉移時功能缺失）
- 📌 **踩雷備忘（2026-07-17 建置時）**：`FIREBASE_PRIVATE_KEY` 貼上格式壞掉（Invalid PEM）會讓**新部署開機即 crash → 部署失敗 → Render 留舊版繼續跑**，症狀是「版本停在舊版＋查 DB 回 Unable to detect a Project Id」。修法＝從 service account JSON 把 private_key 以**多行原格式**重貼（程式相容 \n 與真換行）。存檔即自動重部署。

## 五、長期選項（金流上線前評估）

- **遷 Google Cloud Run**：與 Firestore 同雲（憑證天然整合）、按請求計費（閒置近零）、可用性遠高於單一 Railway 服務；遷移工作量約 1–2 天。屆時本手冊的網域切換（步驟 A）直接沿用。
