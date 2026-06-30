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
      settlementManualInput: false,    // 結帳：所有項目手動輸入與系統值並列
      settlementShowCardNumbers: true, // 結帳：顯示優惠卡/全票最前號碼（之後拿掉）
      checkinAlreadyPaid: false,       // 入場電話搜尋：『已付費』直接放行選項
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT：管理員設定
router.put('/transition', authenticate, async (req, res) => {
  if (!['super_admin', 'admin', 'gym_manager'].includes(req.staff?.role))
    return res.status(403).json({ error: '權限不足' });
  try {
    const db = getDb();
    const { settlementManualInput, settlementShowCardNumbers, checkinAlreadyPaid } = req.body;
    await db.collection('systemSettings').doc('transitionSettings').set({
      settlementManualInput: !!settlementManualInput,
      settlementShowCardNumbers: !!settlementShowCardNumbers,
      checkinAlreadyPaid: !!checkinAlreadyPaid,
      updatedAt: new Date(),
    });
    res.json({ success: true });
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
