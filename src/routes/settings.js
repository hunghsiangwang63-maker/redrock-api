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

// ── GET /settings/payment-methods - 付款方式開關（公開；各付款頁讀取）──────
// 現金/轉帳預設開放；LinePay/街口/台灣Pay 待金流 API 對接後由管理員開啟。
const PAYMENT_DEFAULTS = { cash: true, transfer: true, linepay: false, jkopay: false, taiwanpay: false };
router.get('/payment-methods', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('paymentMethods').get();
    const enabled = { ...PAYMENT_DEFAULTS, ...(doc.exists ? (doc.data().enabled || {}) : {}) };
    res.json({ enabled });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /settings/payment-methods（僅 super_admin）───────────────────────
router.put('/payment-methods', authenticate, async (req, res) => {
  if (!['super_admin', 'admin'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const body = req.body.enabled || {};
    const enabled = {};
    for (const k of Object.keys(PAYMENT_DEFAULTS)) enabled[k] = body[k] === true;
    if (!Object.values(enabled).some(Boolean))
      return res.status(400).json({ error: 'NO_METHOD', message: '至少須開放一種付款方式' });
    await db.collection('systemSettings').doc('paymentMethods').set({ enabled, updatedAt: new Date() }, { merge: true });
    res.json({ success: true, enabled });
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

// ── 系統轉換期設定（結帳手動輸入並列／卡號顯示、入場已付費）──────────────
// GET：任何登入員工/站台可讀（結算頁、入場頁需依此切換）
router.get('/transition', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('transitionSettings').get();
    res.json(doc.exists ? doc.data() : {
      settlementManualInput: false,     // 結帳：所有項目手動輸入與系統值並列
      settlementShowCardNumbers: true,  // 結帳：顯示優惠卡/全票最前號碼（之後拿掉）
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
    const { settlementManualInput, settlementShowCardNumbers, checkinAlreadyPaid, checkinLegacyDiscountCard } = req.body;
    await db.collection('systemSettings').doc('transitionSettings').set({
      settlementManualInput: !!settlementManualInput,
      settlementShowCardNumbers: !!settlementShowCardNumbers,
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

module.exports = router;
