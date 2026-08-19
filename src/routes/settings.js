/**
 * 系統設定
 * GET  /settings/bank-accounts       取得各館銀行帳號
 * PUT  /settings/bank-accounts/:gymId 更新場館銀行帳號
 */
const express = require('express');
const router = express.Router();
const { authenticate, authenticateAny, checkPermission } = require('../middleware/auth');
const { getDb } = require('../config/firebase');

// GET /settings/bank-accounts
router.get('/bank-accounts', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('systemSettings').doc('bankAccounts').get();
    res.json({ bankAccounts: snap.exists ? snap.data() : {} });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT /settings/bank-accounts/:gymId
router.put('/bank-accounts/:gymId',
  authenticate, checkPermission('settings.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const { gymId } = req.params;
      const { bankName, accountNumber, accountName, notes } = req.body;
      const ref = db.collection('systemSettings').doc('bankAccounts');
      const snap = await ref.get();
      const current = snap.exists ? snap.data() : {};
      current[gymId] = { bankName, accountNumber, accountName, notes: notes || '', updatedAt: new Date() };
      await ref.set(current);
      res.json({ message: '銀行帳號已更新', data: current[gymId] });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// GET /settings/bank-accounts/member - 會員可以取得（不需要 staff token）
router.get('/bank-accounts/member', async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('systemSettings').doc('bankAccounts').get();
    const data = snap.exists ? snap.data() : {};
    // 只回傳必要欄位
    const safe = {};
    Object.entries(data).forEach(([gymId, info]) => {
      safe[gymId] = {
        bankName: info.bankName,
        accountNumber: info.accountNumber,
        accountName: info.accountName,
        notes: info.notes,
      };
    });
    res.json({ bankAccounts: safe });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/entry-types ────────────────────────────────────
router.get('/entry-types', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('entryTypes').get();
    const types = doc.exists ? (doc.data().types || []) : getDefaultEntryTypes();
    res.json(types);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /settings/entry-types ───────────────────────────────────
router.post('/entry-types', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const { types } = req.body;
    await db.collection('systemSettings').doc('entryTypes').set({ types, updatedAt: new Date() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

function getDefaultEntryTypes() {
  return [
    { id: 'single_ticket',  name: '單次入場', price: 200, active: true },
    { id: 'course_access',  name: '課程學員', price: 0,   active: true },
    { id: 'child_free',     name: '兒童入場', price: 100, active: true },
    { id: 'student_free',   name: '學生入場', price: 250, active: true },
  ];
}

// ── GET /settings/waiver ─────────────────────────────────────────
router.get('/waiver', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('waiver').get();
    res.json(doc.exists ? doc.data() : { zh: '', en: '' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/waiver ─────────────────────────────────────────
router.put('/waiver', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const { zh, en } = req.body;
    await db.collection('systemSettings').doc('waiver').set({ zh, en, updatedAt: new Date() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/shoe-rental ────────────────────────────────────
router.get('/shoe-rental', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('shoeRental').get();
    res.json(doc.exists ? doc.data() : { price: 100, active: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/shoe-rental ─────────────────────────────────────
router.put('/shoe-rental', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const { price, active } = req.body;
    await db.collection('systemSettings').doc('shoeRental').set({ price: Number(price) || 100, active: !!active, updatedAt: new Date() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/bonus - 紅利（免費入場）使用期限（月）─────────────
router.get('/bonus', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('bonus').get();
    res.json(doc.exists ? { validityMonths: doc.data().validityMonths ?? 6 } : { validityMonths: 6 });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/bonus（僅 super_admin）─────────────────────────────
router.put('/bonus', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const n = Math.round(Number(req.body.validityMonths));
    if (!Number.isFinite(n) || n < 1 || n > 60)
      return res.status(400).json({ error: 'INVALID_MONTHS', message: '紅利使用期限請填 1~60 個月' });
    await db.collection('systemSettings').doc('bonus').set({ validityMonths: n, updatedAt: new Date() }, { merge: true });
    res.json({ success: true, validityMonths: n });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/discount-card-validity - 新購優惠折扣卡使用期限（月；null=無限期）──
router.get('/discount-card-validity', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('discountCard').get();
    const n = doc.exists ? Number(doc.data().validityMonths) : NaN;
    res.json({ validityMonths: Number.isFinite(n) && n >= 1 ? n : null }); // null = 無限期
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/discount-card-validity（僅 super_admin）；空/0 = 無限期、1~60 = 月數 ──
// 僅影響設定後「之後售出」的卡，不追溯已售出。
router.put('/discount-card-validity', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const raw = req.body.validityMonths;
    let validityMonths = null; // 預設無限期
    if (raw !== null && raw !== '' && raw !== undefined) {
      const n = Math.round(Number(raw));
      if (!Number.isFinite(n) || n < 0 || n > 60)
        return res.status(400).json({ error: 'INVALID_MONTHS', message: '請填 0（無限期）或 1~60 個月' });
      validityMonths = n >= 1 ? n : null; // 0 → 無限期
    }
    await db.collection('systemSettings').doc('discountCard').set({ validityMonths, updatedAt: new Date() }, { merge: true });
    res.json({ success: true, validityMonths });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/card-transfer-limit - 會員自助卡券移轉單次上限（黑卡/優惠卡點數＋單次入場券批次張數共用）──
router.get('/card-transfer-limit', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('cardTransferLimit').get();
    const n = doc.exists ? Number(doc.data().maxCredits) : NaN;
    res.json({ maxCredits: Number.isFinite(n) && n >= 1 ? n : 10 }); // 預設 10
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/card-transfer-limit（僅 super_admin/admin）；1~100 ──
router.put('/card-transfer-limit', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const n = Math.round(Number(req.body.maxCredits));
    if (!Number.isFinite(n) || n < 1 || n > 100)
      return res.status(400).json({ error: 'INVALID_LIMIT', message: '請填 1~100 之間的數字' });
    await db.collection('systemSettings').doc('cardTransferLimit').set({ maxCredits: n, updatedAt: new Date() }, { merge: true });
    res.json({ success: true, maxCredits: n });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/payment-methods - 付款方式開關（公開；各付款頁讀取）──────
// 現金/轉帳預設開放；LinePay/街口/台灣Pay 待金流 API 對接後由管理員開啟。
const PAYMENT_DEFAULTS = { cash: true, transfer: true, linepay: false, jkopay: false, taiwanpay: false };
// 各流程「是否開放線上支付入口」（見 docs/payment-integration-plan.md §11）；
// 刻意不含 product(POS)——POS 行動支付走實體收款QR+店員目視確認，不經 paymentService/gateway。
// installment 獨立一個開關，不隨其來源（pass/course/rental）——見文件說明。
const ONLINE_FLOW_DEFAULTS = { entry: false, course: false, experience: false, competition: false, rental: false, pass: false, installment: false };
router.get('/payment-methods', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('paymentMethods').get();
    const data = doc.exists ? doc.data() : {};
    const enabled = { ...PAYMENT_DEFAULTS, ...(data.enabled || {}) };
    const onlineFlows = { ...ONLINE_FLOW_DEFAULTS, ...(data.onlineFlows || {}) };
    res.json({ enabled, onlineFlows });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/payment-methods（僅 super_admin）───────────────────────
// 可只送 enabled、只送 onlineFlows、或兩者都送；省略的那個沿用資料庫既有值（向下相容舊呼叫端）。
router.put('/payment-methods', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const ref = db.collection('systemSettings').doc('paymentMethods');
    const cur = await ref.get();
    const curData = cur.exists ? cur.data() : {};
    const updates = { updatedAt: new Date() };

    if (req.body.enabled !== undefined) {
      const body = req.body.enabled || {};
      const enabled = {};
      for (const k of Object.keys(PAYMENT_DEFAULTS)) enabled[k] = body[k] === true;
      if (!Object.values(enabled).some(Boolean))
        return res.status(400).json({ error: 'NO_METHOD', message: '至少須開放一種付款方式' });
      updates.enabled = enabled;
    }

    if (req.body.onlineFlows !== undefined) {
      const body = req.body.onlineFlows || {};
      const onlineFlows = {};
      for (const k of Object.keys(ONLINE_FLOW_DEFAULTS)) onlineFlows[k] = body[k] === true;
      updates.onlineFlows = onlineFlows;
    }

    if (updates.enabled === undefined && updates.onlineFlows === undefined)
      return res.status(400).json({ error: 'NO_UPDATE', message: '未提供任何更新內容' });

    await ref.set(updates, { merge: true });
    const enabled = { ...PAYMENT_DEFAULTS, ...(updates.enabled || curData.enabled || {}) };
    const onlineFlows = { ...ONLINE_FLOW_DEFAULTS, ...(updates.onlineFlows || curData.onlineFlows || {}) };
    res.json({ success: true, enabled, onlineFlows });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/partner-vendor - 特約廠商入場優惠（啟用 + 折扣金額）──────
router.get('/partner-vendor', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('partnerVendor').get();
    const d = doc.exists ? doc.data() : {};
    res.json({ enabled: d.enabled !== false, discount: Number.isFinite(d.discount) ? d.discount : 20 });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── 友館清單（比賽/講座友館折扣用；管理員可增刪）────────────────────────
// GET 公開（會員報名頁讀清單顯示）；PUT 限管理員。結構 { gyms:[{id,name}] }。
router.get('/partner-gyms', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('partnerGyms').get();
    const gyms = doc.exists && Array.isArray(doc.data().gyms) ? doc.data().gyms : [];
    res.json({ gyms });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
router.put('/partner-gyms', authenticate, async (req, res) => {
  if (!['super_admin', 'admin', 'gym_manager'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const { v4: uuidv4 } = require('uuid');
    const raw = Array.isArray(req.body.gyms) ? req.body.gyms : [];
    // 正規化：每筆需 name；補 id；去空白與空名
    const gyms = raw.map(g => ({ id: g.id || uuidv4(), name: String(g.name || '').trim() }))
      .filter(g => g.name);
    await db.collection('systemSettings').doc('partnerGyms').set({ gyms, updatedAt: new Date() }, { merge: true });
    res.json({ success: true, gyms });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/partner-vendor（僅 super_admin/admin）──────────────────
router.put('/partner-vendor', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const n = Math.round(Number(req.body.discount));
    if (!Number.isFinite(n) || n < 0 || n > 1000)
      return res.status(400).json({ error: 'INVALID_DISCOUNT', message: '特約折扣金額請填 0~1000 元' });
    const enabled = !!req.body.enabled;
    await db.collection('systemSettings').doc('partnerVendor').set({ enabled, discount: n, updatedAt: new Date() }, { merge: true });
    res.json({ success: true, enabled, discount: n });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── 比賽保險名冊「承保範圍」固定文字（可從後台調整，不需改程式碼）────────────
// 結構：ageLabelUnder/ageLabelOver＝年齡分界兩欄標題；rows＝每項保險名稱＋兩欄金額文字。
const DEFAULT_COMP_INSURANCE = {
  ageLabelUnder: '限15足歲以下',
  ageLabelOver: '滿15足歲以上~未滿80歲',
  rows: [
    { label: '特定活動死亡及失能保險', under: '無', over: '100萬' },
    { label: '特定活動醫療保險(實支實付型)', under: '10萬', over: '10萬' },
    { label: '特定活動緊急救援費用保險', under: '50萬', over: '50萬' },
  ],
};
router.get('/competition-insurance', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('competitionInsurance').get();
    const d = doc.exists ? doc.data() : {};
    res.json({
      ageLabelUnder: d.ageLabelUnder || DEFAULT_COMP_INSURANCE.ageLabelUnder,
      ageLabelOver: d.ageLabelOver || DEFAULT_COMP_INSURANCE.ageLabelOver,
      rows: Array.isArray(d.rows) && d.rows.length ? d.rows : DEFAULT_COMP_INSURANCE.rows,
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
router.put('/competition-insurance', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const ageLabelUnder = String(req.body.ageLabelUnder || '').trim() || DEFAULT_COMP_INSURANCE.ageLabelUnder;
    const ageLabelOver = String(req.body.ageLabelOver || '').trim() || DEFAULT_COMP_INSURANCE.ageLabelOver;
    const rows = Array.isArray(req.body.rows)
      ? req.body.rows.map(r => ({ label: String(r.label || '').trim(), under: String(r.under || '').trim(), over: String(r.over || '').trim() })).filter(r => r.label)
      : DEFAULT_COMP_INSURANCE.rows;
    if (!rows.length) return res.status(400).json({ error: 'MISSING_ROWS', message: '請至少填寫一項保險內容' });
    await db.collection('systemSettings').doc('competitionInsurance').set({ ageLabelUnder, ageLabelOver, rows, updatedAt: new Date() }, { merge: true });
    res.json({ success: true, ageLabelUnder, ageLabelOver, rows });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/partner-gym-member - 友館隊員入場優惠（啟用 + 折扣率，預設9折）──────
router.get('/partner-gym-member', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('partnerGymMember').get();
    const d = doc.exists ? doc.data() : {};
    res.json({ enabled: d.enabled !== false, rate: (Number.isFinite(d.rate) && d.rate > 0 && d.rate < 1) ? d.rate : 0.9 });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/partner-gym-member（僅 super_admin/admin）──────────────────
router.put('/partner-gym-member', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const r = Number(req.body.rate);
    if (!Number.isFinite(r) || r <= 0 || r >= 1)
      return res.status(400).json({ error: 'INVALID_RATE', message: '友館隊員折扣率請填 0~1 之間（如 0.9＝九折）' });
    const enabled = !!req.body.enabled;
    await db.collection('systemSettings').doc('partnerGymMember').set({ enabled, rate: r, updatedAt: new Date() }, { merge: true });
    res.json({ success: true, enabled, rate: r });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/chalk-rental ────────────────────────────────────
router.get('/chalk-rental', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('chalkRental').get();
    res.json(doc.exists ? doc.data() : { price: 50, active: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/chalk-rental ─────────────────────────────────────
router.put('/chalk-rental', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const { price, active } = req.body;
    await db.collection('systemSettings').doc('chalkRental').set({ price: Number(price) || 50, active: !!active, updatedAt: new Date() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── 系統轉換期設定（結帳手動輸入並列、入場已付費）──────────────
// GET：任何登入員工/站台可讀（結算頁、入場頁需依此切換）
router.get('/transition', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('transitionSettings').get();
    res.json(doc.exists ? doc.data() : {
      settlementManualInput: false,          // 結帳：收入（六大類）手動輸入與系統值並列
      settlementPaymentManualInput: false,   // 結帳：付款方式（LinePay/街口/台灣Pay/轉帳）手動輸入與系統值並列
      // 2026-08-15 拆分自 settlementManualInput——原本收入/付款方式共用一顆開關，因付款方式相關
      // 的多個既有計算 bug（無來源發票漏記付款方式、體驗改期未同步認列日等）已修復，使用者確認
      // 系統計算的付款方式可信、要求「一切以系統為準」單獨關掉付款方式手動輸入，收入手動輸入維持不動。
      checkinAlreadyPaid: false,        // 入場電話搜尋：『已付費』直接放行選項
      checkinLegacyDiscountCard: false, // 入場電話搜尋：可手動套『舊折扣卡 8 折』（持實體舊卡未轉入者）
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT：管理員設定
router.put('/transition', authenticate, async (req, res) => {
  if (!['super_admin', 'admin', 'gym_manager'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const { settlementManualInput, settlementPaymentManualInput, checkinAlreadyPaid, checkinLegacyDiscountCard } = req.body;
    await db.collection('systemSettings').doc('transitionSettings').set({
      settlementManualInput: !!settlementManualInput,
      settlementPaymentManualInput: !!settlementPaymentManualInput,
      checkinAlreadyPaid: !!checkinAlreadyPaid,
      checkinLegacyDiscountCard: !!checkinLegacyDiscountCard,
      updatedAt: new Date(),
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── 裝置綁定總開關（systemSettings/security.deviceBindingEnabled）──
// GET：目前狀態（預設啟用；僅明確設 false 才停用）
router.get('/device-binding', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('security').get();
    const enabled = !(doc.exists && doc.data().deviceBindingEnabled === false);
    res.json({ enabled });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
// PUT：開啟/關閉（僅 super_admin；控制 staff/station 登入是否強制裝置驗證）
router.put('/device-binding', authenticate, async (req, res) => {
  if (req.staff?.role !== 'super_admin')
    return res.status(403).json({ error: '權限不足', message: '僅系統管理員可調整裝置綁定' });
  try {
    const db = getDb();
    const enabled = !!req.body.enabled;
    await db.collection('systemSettings').doc('security').set({
      deviceBindingEnabled: enabled,
      updatedAt: new Date(),
      updatedBy: req.staff.id,
    }, { merge: true });
    res.json({ success: true, enabled });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── Email 認證總開關（systemSettings/security.emailVerificationEnabled）──
// GET：目前狀態（預設啟用；僅明確設 false 才停用）
router.get('/email-verification', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('security').get();
    const enabled = !(doc.exists && doc.data().emailVerificationEnabled === false);
    res.json({ enabled });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
// PUT：開啟/關閉（僅 super_admin；控制自助註冊會員是否須驗證 Email 才能登入）
router.put('/email-verification', authenticate, async (req, res) => {
  if (req.staff?.role !== 'super_admin')
    return res.status(403).json({ error: '權限不足', message: '僅系統管理員可調整 Email 認證' });
  try {
    const db = getDb();
    const enabled = !!req.body.enabled;
    await db.collection('systemSettings').doc('security').set({
      emailVerificationEnabled: enabled,
      updatedAt: new Date(),
      updatedBy: req.staff.id,
    }, { merge: true });
    res.json({ success: true, enabled });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/team-fees ─────────────────────────────────────────
router.get('/team-fees', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('teamFees').get();
    res.json(doc.exists ? doc.data() : {
      fullYearFee: 3000,      // 年費（3/15前加入）
      midYearFee: 2000,       // 3/15後加入
      lateYearFee: 1000,      // 9/15後加入
      midYearCutoff: '03-15', // MM-DD
      lateYearCutoff: '09-15',
      jerseyDiscount: 300,    // 舊隊員不拿隊服減免
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/team-fees ─────────────────────────────────────────
router.put('/team-fees', authenticate, async (req, res) => {
  if (!['super_admin', 'admin', 'gym_manager'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const { fullYearFee, midYearFee, lateYearFee, midYearCutoff, lateYearCutoff, jerseyDiscount } = req.body;
    await db.collection('systemSettings').doc('teamFees').set({
      fullYearFee: Number(fullYearFee) || 3000,
      midYearFee: Number(midYearFee) || 2000,
      lateYearFee: Number(lateYearFee) || 1000,
      midYearCutoff: midYearCutoff || '03-15',
      lateYearCutoff: lateYearCutoff || '09-15',
      jerseyDiscount: Number(jerseyDiscount) || 300,
      updatedAt: new Date(),
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /settings/usage-stats?days=N - 會員端／員工端流量拆分統計（super_admin，技術診斷用）──
// 讀 index.js 全域中介層每分鐘 flush 的 apiUsageStats/{date} 逐日彙總；用來回答
// 「流量/傳輸費用大概是會員端還是員工端在用」，不用每次都手動查腳本。
router.get('/usage-stats', authenticate, async (req, res) => {
  if (req.staff?.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN', message: '僅系統管理員可查看' });
  try {
    const db = getDb();
    const dayjs = require('dayjs');
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 60);
    const dates = Array.from({ length: days }, (_, i) => dayjs().subtract(days - 1 - i, 'day').format('YYYY-MM-DD'));
    const docs = await db.getAll(...dates.map(d => db.collection('apiUsageStats').doc(d)));
    const daily = docs.map((doc, i) => {
      const d = doc.exists ? doc.data() : {};
      return {
        date: dates[i],
        member: { count: d.member?.count || 0, bytes: d.member?.bytes || 0 },
        staff: { count: d.staff?.count || 0, bytes: d.staff?.bytes || 0 },
        unknown: { count: d.unknown?.count || 0, bytes: d.unknown?.bytes || 0 },
      };
    });
    const total = daily.reduce((acc, d) => {
      ['member', 'staff', 'unknown'].forEach(k => { acc[k].count += d[k].count; acc[k].bytes += d[k].bytes; });
      return acc;
    }, { member: { count: 0, bytes: 0 }, staff: { count: 0, bytes: 0 }, unknown: { count: 0, bytes: 0 } });
    const totalBytes = total.member.bytes + total.staff.bytes + total.unknown.bytes;
    const pct = (b) => totalBytes > 0 ? Math.round(b / totalBytes * 1000) / 10 : 0;
    res.json({
      daily,
      total,
      summary: {
        memberBytesPct: pct(total.member.bytes),
        staffBytesPct: pct(total.staff.bytes),
        unknownBytesPct: pct(total.unknown.bytes),
        note: 'unknown＝尚未帶 X-Client-App 標頭的呼叫（多為部署前的舊前端快取），會隨時間降到接近0。此為回應給前端的位元組數，非 Firestore 本身讀取的位元組數（兩者高度相關但非完全相同）。',
      },
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
