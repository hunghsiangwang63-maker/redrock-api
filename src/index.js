// 全系統時間一律台灣時間（Railway 預設 UTC）：影響 dayjs()/new Date() 本地方法/setHours/startOf 等。
// 須在任何 Date/dayjs 使用前設定。明確 +8 補償(Date.now()+8h→toISOString、'T..+08:00')屬 epoch/ISO，與此無關、不會雙重位移。
process.env.TZ = process.env.TZ || 'Asia/Taipei';

require('dotenv').config();
const { taiwanToday } = require('./utils/taiwanDate');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { initFirebase } = require('./config/firebase');

// ── 初始化 Firebase ───────────────────────────────────────────────
initFirebase();

const app = express();

// ── Middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174',
    'https://app.redrocktaiwan.com', 'https://staff.redrocktaiwan.com',
    'https://redrock-member.web.app', 'https://redrock-staff.web.app',
    'https://redrock-dev-a35c1.web.app', 'https://redrock-dev-a35c1.firebaseapp.com',
    // 計分系統（redrock-comp，獨立 Firebase 專案）：2026-08-15 起呼叫 /comp-auth 身分驗證橋接
    'https://comp.redrocktaiwan.com', 'https://redrock-comp.web.app',
  ],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' })); // 需要較大限制以支援 base64 簽名圖
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// API 一律不快取：保證瀏覽器/任何中介層絕不快取回應內容（資料改由前端主動重抓解決，見 useRefetchOnFocus）
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Railway 在反向代理後方：信任第一層 proxy 以取得真實 client IP（供限流正確計數）
app.set('trust proxy', 1);

// ── 邊緣防護：只認 Cloudflare 流量（DDoS 防備第二步；預設「關閉」，對現有營運零影響）──
// 啟用條件：環境變數 EDGE_ENFORCE='true' 且設定 EDGE_SECRET。
//   啟用後，未帶正確 X-Edge-Auth header（由 Cloudflare Transform Rule 注入）的請求一律 403，
//   堵住「繞過 Cloudflare、直打 Railway 原始網址」的漏洞。EDGE_ENFORCE 未設＝中介層 no-op。
// ⚠ 上線流程：先把 API 放到 Cloudflare 後面 + 設好 Transform Rule 注入 header → 實測 header 有到 →
//   才在 Railway 設 EDGE_ENFORCE='true'。順序顛倒會擋掉所有正常流量（櫃檯全斷）。
// /health 永遠放行（UptimeRobot 直打健檢、切換期驗證用）。
if (process.env.EDGE_ENFORCE === 'true' && process.env.EDGE_SECRET) {
  const EDGE_SECRET = process.env.EDGE_SECRET;
  const EDGE_HEADER = (process.env.EDGE_HEADER || 'x-edge-auth').toLowerCase();
  app.use((req, res, next) => {
    if (req.path === '/health') return next();               // 健檢直打放行
    if (req.headers[EDGE_HEADER] === EDGE_SECRET) return next();
    return res.status(403).json({ error: 'DIRECT_ACCESS_FORBIDDEN', message: '請透過正式網域存取' });
  });
  console.log('🛡  邊緣防護已啟用（只認 Cloudflare 流量）');
}

// ── 限流（僅認證敏感端點，避免影響同一 IP 多員工的正常操作）──────────
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, // 每 IP 每 15 分鐘 30 次登入嘗試（足夠正常櫃檯、擋暴力破解）
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS', message: '嘗試次數過多，請稍後再試' },
});
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, // 每 IP 每小時 5 次（防 Email 枚舉/濫發）
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS', message: '請求過於頻繁，請稍後再試' },
});
// 全域限流（防單一來源濫打/灌 Firestore 讀取費；分散式 DDoS 靠邊緣層另擋）。
// ⚠ 額度要寬：館內 WiFi 全部會員手機＋站台共用同一對外 IP，會員 QR 頁每 3 秒輪詢一次
//   （50 人同時產 QR ≈ 1000 req/min）→ 設 1200/min，正常尖峰不會踩到、單機 flood 仍被擋。
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 1200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS', message: '請求過於頻繁，請稍後再試' },
});
// 會寄信/建資料的公開端點另收緊（同館 WiFi 幫多組家庭現場註冊仍夠用）
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30, // 每 IP 每小時 30 次自助註冊
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS', message: '註冊過於頻繁，請稍後再試' },
});
const publicBookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, // 每 IP 每小時 20 次公開體驗預約（免登入，防濫填/機器人）
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS', message: '預約次數過多，請稍後再試' },
});
const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, // 每 IP 每小時 20 次重寄驗證信（防濫發 Email）
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS', message: '請求過於頻繁，請稍後再試' },
});
app.use(globalLimiter);
app.use('/members/self-register', registerLimiter);
app.use('/auth/member/resend-verification', resendLimiter);
app.use('/experience-bookings/public', publicBookLimiter); // 含訪客單次體驗預約與訪客試上預約（trialSessionId 分支）
app.use('/courses/public/:courseId/enroll-all', publicBookLimiter); // 訪客週課整期公開報名
app.use('/courses/public/sessions/:sessionId/enroll', publicBookLimiter); // 訪客單堂工作坊公開報名
app.use('/competitions/public/:id/register', publicBookLimiter); // 訪客比賽公開報名
app.use('/auth/staff/login', authLimiter);
app.use('/auth/member/login', authLimiter);
app.use('/auth/device/verify-otp', authLimiter);
app.use('/stations/login', authLimiter);
app.use('/stations/shift/clockin', authLimiter);
app.use('/auth/member/forgot-password', forgotLimiter);
app.use('/comp-auth/login', authLimiter); // 計分系統密碼驗證，防暴力破解

// ── 會員端／員工端流量拆分統計（2026-08-20）──────────────────────────
// GCP 帳單本身只到 SKU/服務層級，看不出「這筆流量是哪邊 App 打的」。前端 client.js／
// memberClient.js 各自送 X-Client-App: staff／member 標頭，這裡統計請求數與回應位元組數。
// ⚠ 不對每個請求各寫一次 Firestore（會自己變成新的寫入費用來源）——先累積在記憶體，
// 每分鐘 flush 一次（FieldValue.increment 累加，不覆蓋），單日最多 ~1440 次寫入、遠低於免費額度。
// Railway 重啟會遺失當下未 flush 的緩衝（至多 1 分鐘資料），可接受。
const usageBuffer = { member: { count: 0, bytes: 0 }, staff: { count: 0, bytes: 0 }, unknown: { count: 0, bytes: 0 } };
app.use((req, res, next) => {
  const hdr = String(req.headers['x-client-app'] || '').toLowerCase();
  const bucket = (hdr === 'member' || hdr === 'staff') ? hdr : 'unknown';
  res.on('finish', () => {
    const bytes = Number(res.getHeader('content-length')) || 0;
    usageBuffer[bucket].count += 1;
    usageBuffer[bucket].bytes += bytes;
  });
  next();
});
setInterval(async () => {
  const snapshot = { member: { ...usageBuffer.member }, staff: { ...usageBuffer.staff }, unknown: { ...usageBuffer.unknown } };
  if (!snapshot.member.count && !snapshot.staff.count && !snapshot.unknown.count) return;
  usageBuffer.member = { count: 0, bytes: 0 };
  usageBuffer.staff = { count: 0, bytes: 0 };
  usageBuffer.unknown = { count: 0, bytes: 0 };
  try {
    const admin = require('firebase-admin');
    const { getDb } = require('./config/firebase');
    const db = getDb();
    // ⚠ 用巢狀物件（非 'member.count' 這種點號字串 key）——點號字串 key 只有 .update() 才會
    //   解析成欄位路徑，.set(...,{merge:true}) 會把它當成字面上帶點的欄位名稱直接存成扁平
    //   key（曾實測踩雷：Firestore 真的存出 "member.count" 這個奇怪的欄位名，巢狀物件才會被
    //   正確合併進 member:{count,bytes}）。
    const update = {};
    Object.entries(snapshot).forEach(([bucket, v]) => {
      if (v.count > 0) {
        update[bucket] = {
          count: admin.firestore.FieldValue.increment(v.count),
          bytes: admin.firestore.FieldValue.increment(v.bytes),
        };
      }
    });
    await db.collection('apiUsageStats').doc(taiwanToday()).set(update, { merge: true });
  } catch (e) { console.error('[usage-stats flush]', e.message); }
}, 60 * 1000);

// ── Routes ────────────────────────────────────────────────────────
app.use('/auth',         require('./routes/auth'));
app.use('/members',      require('./routes/members'));
app.use('/checkin',      require('./routes/checkin'));
app.use('/passes',       require('./routes/passes'));
app.use('/installments', require('./routes/installments'));
app.use('/schedule',     require('./routes/schedule'));
app.use('/competitions', require('./routes/competitions'));
app.use('/staff',        require('./routes/staff'));
app.use('/pass-adjustments', require('./routes/passAdjustments'));
app.use('/course-adjustments', require('./routes/courseAdjustments'));
app.use('/team', require('./routes/teamMembers'));
app.use('/rentals', require('./routes/rentals'));
app.use('/pending-tasks', require('./routes/pendingTasks'));
app.use('/comp-auth', require('./routes/compAuth'));
app.use('/experience-bookings', require('./routes/experienceBookings'));
app.use('/staff-entry', require('./routes/staffEntry'));
app.use('/simulate', require('./routes/simulateRegistration'));
app.use('/cards',        require('./routes/cards'));
app.use('/team-members', require('./routes/teamMembers'));
app.use('/gyms',         require('./routes/gyms'));
app.use('/courses',      require('./routes/courses'));
app.use('/vip',          require('./routes/vip'));
app.use('/course-categories', require('./routes/courseCategories'));
app.use('/products',      require('./routes/products'));
app.use('/settings',       require('./routes/settings'));
app.use('/stations',       require('./routes/stations'));
app.use('/transfers',      require('./routes/transfers'));
app.use('/notifications', require('./routes/notifications'));
app.use('/payments',      require('./routes/payments'));
app.use('/invoices',      require('./routes/invoices'));
app.use('/member-reminders', require('./routes/memberReminders'));

// Phase 2 以後的路由（預留）
// app.use('/courses',   require('./routes/courses'));
// app.use('/waivers',   require('./routes/waivers'));
app.use('/revenue',      require('./routes/revenue'));
app.use('/ticket-transfers', require('./routes/ticketTransfers'));
app.use('/daily-settlements', require('./routes/dailySettlements'));
app.use('/fall-tests',   require('./routes/fallTests'));
app.use('/fall-test-bookings', require('./routes/fallTestBookings'));
// app.use('/gyms',      require('./routes/gyms'));
// app.use('/staff',     require('./routes/staff'));
// app.use('/notifications', require('./routes/notifications'));
// app.use('/competitions',  require('./routes/competitions'));
// app.use('/permissions',   require('./routes/permissions'));

// ── Health Check ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    tz: process.env.TZ,
    serverTime: new Date().toString(),   // 應顯示 GMT+0800（台灣）
    env: process.env.NODE_ENV,
    version: '3.364.0-competition-invoice-week-early',
    // 邊緣密鑰驗證輔助（供啟用 EDGE_ENFORCE 前確認 Transform Rule 有正確注入 header；不外洩密鑰值）
    edge: {
      header: (process.env.EDGE_HEADER || 'x-edge-auth').toLowerCase(),
      seen: !!req.headers[(process.env.EDGE_HEADER || 'x-edge-auth').toLowerCase()],
      match: process.env.EDGE_SECRET
        ? req.headers[(process.env.EDGE_HEADER || 'x-edge-auth').toLowerCase()] === process.env.EDGE_SECRET
        : null,
      enforce: process.env.EDGE_ENFORCE === 'true',
    },
  });
});

// ── 404 Handler ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', path: req.path });
});

// ── Error Handler ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.code || 'SERVER_ERROR',
    message: process.env.NODE_ENV === 'production' ? '伺服器發生錯誤' : err.message,
  });
});

// ── Start Server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🏔  RedRock API Server running on port ${PORT}`);
  });

  // ── 每日排程（台灣 09:00）：分期逾期檢查 + 到期/逾期提醒 ──
  // 無外部 cron：每小時檢查一次，以台灣日期防重複（單一 instance 假設）。TZ=Asia/Taipei 故 getHours()=台灣時。
  let lastInstallmentRunDate = null;
  const runDailyInstallmentJobs = async () => {
    try {
      const installmentService = require('./services/installmentService');
      const ov = await installmentService.runOverdueCheck();
      const rm = await installmentService.sendInstallmentReminders();
      console.log(`[分期排程] 逾期 ${ov.overdueCount} 筆；會員提醒 ${rm.reminderSent || 0}、逾期通知 ${rm.overdueSent || 0}、管理員預警 ${rm.adminNotified || 0}`);
    } catch (e) { console.error('[分期排程] 失敗', e.message); }
    // 過期紅利清除（標記 inactive，保留文件）
    try {
      const { expiredCount } = await require('./services/bonusService').sweepExpiredBonuses();
      if (expiredCount > 0) console.log(`[紅利排程] 過期停用 ${expiredCount} 筆`);
    } catch (e) { console.error('[紅利排程] 過期清除失敗', e.message); }
    // 政策（2026-07-27）：課程轉帳逾期自動取消排程已移除——曾誤傷已上傳證明只是櫃檯忘記確認的
    // 會員（整期報名被自動取消）。改為一律人工：待收款頁由管理員/值班「確認」或「退回」，
    // sweepExpiredCoursePayments 函式與手動觸發端點 POST /courses/sweep-expired-payments 保留但不排程。
    // 比賽報名逾繳款期限未填匯款資料：自動取消、釋名額、遞補候補
    try {
      const r = await require('./services/competitionService').sweepExpiredCompetitionPayments();
      if (r.cancelled > 0) console.log(`[比賽逾期] 取消 ${r.cancelled} 筆未繳費報名`);
    } catch (e) { console.error('[比賽逾期排程] 失敗', e.message); }
    // 結帳暫存檔（draft）清理：只保留今天與最近三天，刪更舊的未結帳暫存（settled 永不刪）
    try {
      await require('./services/settlementService').sweepStaleSettlementDrafts();
    } catch (e) { console.error('[結帳暫存清理] 失敗', e.message); }
    // 幽靈帳號清除：自助註冊滿 15 天仍未完成入場前置（waiver 或 墜測同意書任一未完成）
    // 且名下無任何資料（子女/入場/交易/票券/報名/租借…）→ 刪除空帳號。每日檢查、15 天寬限期。
    try {
      const g = await require('./services/ghostAccountService').sweepGhostAccounts();
      if (g.deleted > 0) console.log(`[幽靈帳號] 刪除 ${g.deleted} 筆（掃描 ${g.scanned}、有資料保留 ${g.skippedWithValue}）`);
    } catch (e) { console.error('[幽靈帳號清除] 失敗', e.message); }
  };
  // 卡片移轉逾期回沖：每小時掃描（24h 未接收 → 次數回沖來源）
  const runCardTransferExpiry = async () => {
    try {
      const n = await require('./services/cardTransferService').revertExpired();
      if (n > 0) console.log(`[卡片移轉] 逾期自動回沖 ${n} 筆`);
    } catch (e) { console.error('[卡片移轉] 回沖失敗', e.message); }
  };
  // 值班前 2 天提醒（每日 9 點，冪等：已送過的班略過）
  const runShiftReminderJob = async () => {
    try {
      const r = await require('./services/scheduleService').runShiftReminders();
      console.log(`[值班提醒] 目標日 ${r.targetDate}：發送 ${r.sent}、略過(已送) ${r.skipped}、共 ${r.total} 班`);
    } catch (e) { console.error('[值班提醒] 失敗', e.message); }
  };
  setInterval(() => {
    const dateStr = taiwanToday();
    if (new Date().getHours() === 9 && lastInstallmentRunDate !== dateStr) {
      lastInstallmentRunDate = dateStr;
      runDailyInstallmentJobs();
      runShiftReminderJob();
    }
    runCardTransferExpiry(); // 每小時掃一次逾期移轉
    // 試上逾期未繳費：釋放名額 + 取消預約 + 候補轉正（每小時）
    require('./services/courseService').sweepExpiredTrialPayments()
      .then(r => { if (r.cancelled > 0) console.log(`[試上逾期] 釋放 ${r.cancelled} 筆、遞補 ${r.promotedSessions} 場次`); })
      .catch(e => console.error('[試上逾期] 失敗', e.message));
  }, 60 * 60 * 1000);
}

module.exports = app;
