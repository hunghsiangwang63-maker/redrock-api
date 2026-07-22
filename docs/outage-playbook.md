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

## 四、故障轉移準備（✅ 已完成）

> ⚠️ **DNS 已於 2026-07-20 從 Porkbun 搬到 Cloudflare**（nameserver `graham.ns.cloudflare.com` / `journey.ns.cloudflare.com`）。以下 DNS 操作**都在 Cloudflare dashboard**（不是 Porkbun）。
> ⚠️ **api 現為「灰雲 DNS only」**（2026-07-22 為降低延遲改回，見「六、網路架構與 DDoS/延遲權衡」）——直連 Railway、不經 Cloudflare 代理。故障轉移只改 CNAME 指向、**保持灰雲即可**。

### 步驟 A：API 自訂網域（讓轉移＝改一筆 DNS）✅ 已完成 2026-07-14
1. Railway → `redrock-api` service → Settings → Networking → **Custom Domain** `api.redrocktaiwan.com`（CNAME 目標 `fox82bz0.up.railway.app`；⚠️ Railway 另要求一筆 **TXT** `_railway-verify.api` 驗證）
2. **Cloudflare** → `redrocktaiwan.com` → DNS → `api` CNAME → `fox82bz0.up.railway.app`，**Proxy 狀態＝DNS only（灰雲）**
3. 前端 `src/api/client.js` `BASE` 已改 `https://api.redrocktaiwan.com`（含 6 處頁面 fallback）
4. 驗證：`https://api.redrocktaiwan.com/health` 回 JSON、解析到 Railway IP（非 Cloudflare 104.x/172.67.x）

### 步驟 B：Render 冷備（✅ 已建置完成 2026-07-17）
- **服務**：`redrock-api-backup.onrender.com`（GitHub push 自動同步、與正式站同版本）
- **已驗證**：/health 同版本 ✓、Firestore 憑證生效（登入端點 401）✓、**JWT_SECRET 與 Railway 同值**（Railway 發的 token 在 Render 直接通過認證）✓
- **切換時（純一筆 CNAME，在 Cloudflare）**：Cloudflare → DNS → `api` CNAME 改指 `redrock-api-backup.onrender.com`（**保持灰雲 DNS only**）→ Render 自動驗證＋簽 TLS（約 1 分鐘）→ 全站恢復（前端不用重發）
  - ✅ `api.redrocktaiwan.com` **已預先登記**為 Render custom domain（2026-07-17；平時顯示 Waiting for DNS 屬正常——DNS 正指著 Railway）
  - 切換後第一個請求可能等 ~50 秒（免費層休眠喚醒），之後正常
  - 復原（Railway 修好後）：Cloudflare 把 `api` CNAME 改回 `fox82bz0.up.railway.app`（灰雲）
  - ✅ Render 也已同步 `EDGE_SECRET`，但**刻意保持 `EDGE_ENFORCE` 關**（冷備一律放行、最穩，切過去永不被邊緣擋）
- ⚠️ **維運紀律**：每次 Railway 環境變數有新增/修改，**必須手動同步到 Render**（否則故障轉移時功能缺失）
- 📌 **踩雷備忘（2026-07-17 建置時）**：`FIREBASE_PRIVATE_KEY` 貼上格式壞掉（Invalid PEM）會讓**新部署開機即 crash → 部署失敗 → Render 留舊版繼續跑**，症狀是「版本停在舊版＋查 DB 回 Unable to detect a Project Id」。修法＝從 service account JSON 把 private_key 以**多行原格式**重貼（程式相容 \n 與真換行）。存檔即自動重部署。

## 五、長期選項（金流上線前評估）

- **遷 Google Cloud Run**：與 Firestore 同雲（憑證天然整合）、按請求計費（閒置近零）、可用性遠高於單一 Railway 服務；遷移工作量約 1–2 天。屆時本手冊的網域切換（步驟 A）直接沿用。

## 六、網路架構與 DDoS / 延遲權衡（2026-07-22）

- **現況：api＝灰雲（DNS only，直連 Railway）**。原本 2026-07-20 為 DDoS 防護設成橘雲（Cloudflare Proxied），但實測**每請求 +約 0.5s**（`/health` 0.85s vs 直連 0.28s；免費版 CF 邊緣→Railway 源站無優化路由），站台載入明顯變慢 → 改回灰雲，延遲降至 ~0.28s（快約 3 倍）。
- **平時防護**：靠 **app 層全域限流**（`src/index.js` globalLimiter 1200/分/IP、自助註冊 30/時、重寄驗證 20/時，`3.68.0`）。攀岩館非高價值 DDoS 目標，此層平時足夠。
- **遇攻擊時恢復邊緣防護（一次動作）**：Cloudflare → DNS → `api` 點回**橘雲（Proxied）**→ Security → 開 **Under Attack Mode**（訪客先過 JS 挑戰）。攻擊過後再點回灰雲恢復速度。
- ⚠️ **`EDGE_ENFORCE` 與雲朵狀態綁定**：`EDGE_ENFORCE=true`（Railway 環境變數）只在 **api 橘雲**時能用（靠 Cloudflare Transform Rule `inject-edge-auth` 注入 `X-Edge-Auth` header 才不被擋）。**api 灰雲時務必保持 `EDGE_ENFORCE=false`**（現況），否則直連請求無 header 會被全擋、全站斷線。切橘雲並確認 header 有到後，才可考慮開 `EDGE_ENFORCE`。
  - 密鑰 `EDGE_SECRET` 存於 Railway 環境變數 + Cloudflare Transform Rule（兩邊須一致）+ Render（同步備妥、但 Render 端 EDGE_ENFORCE 保持關）。
- **其餘網域維持灰雲**：app / staff / comp（Firebase Hosting 自有 CDN/憑證，勿 Proxy）；根網域 A 記錄灰雲。SSL/TLS 模式 Full。
