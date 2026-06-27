const express = require('express');
const router = express.Router();
const { authenticate, authenticateAny, requireManagerOrStation } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const dayjs = require('dayjs');

// ── GET /rentals/settings - 取得器材設定（費率、庫存） ──
router.get('/settings', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('rentalItems').get();
    res.json(doc.exists ? doc.data() : defaultSettings());
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /rentals/settings - 更新器材設定 ──
router.put('/settings', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('systemSettings').doc('rentalItems').set({
      ...req.body, updatedAt: new Date(),
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /rentals/apply - 會員送出租借申請 ──
router.post('/apply', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id || req.body.memberId;
    if (!memberId) return res.status(401).json({ error: 'UNAUTHORIZED' });

    const {
      gymId, pickupDate, returnDate, rentalType,
      items, // [{ type, quantity }]
      paymentMethod, paymentDate, bankLastFive,
    } = req.body;

    if (!gymId) return res.status(400).json({ code: 'MISSING_GYM', message: '請選擇取貨館別' });
    if (!pickupDate || !returnDate) return res.status(400).json({ code: 'MISSING_DATE', message: '請選擇借出/歸還日期' });
    if (!items?.length) return res.status(400).json({ code: 'MISSING_ITEMS', message: '請選擇租借項目' });

    // 取費率設定
    const settingsDoc = await db.collection('systemSettings').doc('rentalItems').get();
    const settings = settingsDoc.exists ? settingsDoc.data() : defaultSettings();

    // 計算費用
    let totalRentalFee = 0, totalDeposit = 0;
    const itemsWithFee = items.map(item => {
      const cfg = settings[item.type];
      if (!cfg) throw { code: 'INVALID_ITEM', message: `無效的器材類型: ${item.type}` };
      const rentalFee = (rentalType === 'weekend' ? cfg.weekendFee : cfg.sevenDayFee) * item.quantity;
      const deposit = cfg.deposit * item.quantity;
      totalRentalFee += rentalFee;
      totalDeposit += deposit;
      return { type: item.type, name: cfg.name, quantity: item.quantity, rentalFee, deposit, unitFee: rentalType === 'weekend' ? cfg.weekendFee : cfg.sevenDayFee, unitDeposit: cfg.deposit };
    });

    const id = `rental_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    await db.collection('equipmentRentals').doc(id).set({
      id, memberId,
      memberName: req.member?.name || req.body.memberName || '',
      memberPhone: req.member?.phone || req.body.memberPhone || '',
      gymId, pickupDate, returnDate, rentalType,
      items: itemsWithFee,
      totalRentalFee, totalDeposit,
      paymentMethod: paymentMethod || 'transfer',
      paymentDate: paymentDate || null,
      bankLastFive: bankLastFive || null,
      status: 'pending',        // pending | confirmed | active | returned | cancelled
      paymentStatus: 'pending', // pending | confirmed
      depositReturned: false,
      confirmedBy: null, confirmedAt: null,
      returnedAt: null, returnedBy: null,
      createdAt: new Date(), updatedAt: new Date(),
    });

    res.status(201).json({ success: true, id, totalRentalFee, totalDeposit,
      message: `申請成功！租金 NT$${totalRentalFee} + 押金 NT$${totalDeposit}，請完成付款` });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /rentals - 員工查詢租借列表 ──
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { status, from, to } = req.query;
    // 非 super_admin 強制只看自己館別，避免省略 gymId 就看到全館租借（含會員個資）
    const gymId = req.staff?.role === 'super_admin' ? req.query.gymId : req.staff?.gymId;
    let ref = db.collection('equipmentRentals');
    if (gymId) ref = ref.where('gymId', '==', gymId);
    if (status) ref = ref.where('status', '==', status);
    const snap = await ref.get();
    let rentals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (from) rentals = rentals.filter(r => r.pickupDate >= from);
    if (to) rentals = rentals.filter(r => r.pickupDate <= to);
    rentals.sort((a, b) => a.pickupDate.localeCompare(b.pickupDate));
    res.json({ rentals });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /rentals/my - 會員查自己的申請 ──
router.get('/my', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id;
    if (!memberId) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const snap = await db.collection('equipmentRentals').where('memberId', '==', memberId).get();
    const rentals = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => b.createdAt?._seconds - a.createdAt?._seconds);
    res.json({ rentals });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /rentals/stats - 備貨統計（指定日期段） ──
router.get('/stats', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { gymId, from, to } = req.query;
    const fromDate = from || dayjs().format('YYYY-MM-DD');
    const toDate = to || dayjs().add(14, 'day').format('YYYY-MM-DD');

    let ref = db.collection('equipmentRentals')
      .where('status', 'in', ['pending', 'confirmed', 'active']);
    if (gymId) ref = ref.where('gymId', '==', gymId);
    const snap = await ref.get();

    // 找出在查詢日期段內有重疊的租借
    const overlapping = snap.docs.map(d => d.data()).filter(r =>
      r.pickupDate <= toDate && r.returnDate >= fromDate
    );

    // 統計每種器材最大需求
    const stats = {};
    overlapping.forEach(r => {
      r.items?.forEach(item => {
        if (!stats[item.type]) stats[item.type] = { name: item.name, type: item.type, total: 0, records: [] };
        stats[item.type].total += item.quantity;
        stats[item.type].records.push({ memberName: r.memberName, quantity: item.quantity, pickupDate: r.pickupDate, returnDate: r.returnDate, status: r.status });
      });
    });

    // 待取件（今天要取的）
    const today = dayjs().format('YYYY-MM-DD');
    const pickupToday = overlapping.filter(r => r.pickupDate === today);
    const returnToday = overlapping.filter(r => r.returnDate === today);

    res.json({ stats: Object.values(stats), pickupToday, returnToday, from: fromDate, to: toDate, total: overlapping.length });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /rentals/:id/confirm - 確認收款/取件 ──
router.post('/:id/confirm', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('equipmentRentals').doc(req.params.id).update({
      paymentStatus: 'confirmed', status: 'active',
      confirmedBy: req.staff.id, confirmedByName: req.staff.name, confirmedAt: new Date(), updatedAt: new Date(),
    });
    res.json({ success: true, message: '已確認收款，器材已取件' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /rentals/:id/return - 歸還確認（退押金） ──
router.post('/:id/return', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('equipmentRentals').doc(req.params.id).update({
      status: 'returned',
      depositReturned: req.body.depositReturned !== false,
      depositDeductNote: req.body.deductNote || null,
      returnedBy: req.staff.id, returnedByName: req.staff.name, returnedAt: new Date(), updatedAt: new Date(),
    });
    res.json({ success: true, message: '歸還已確認' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

function defaultSettings() {
  return {
    crashPad: { name: '抱石墊', weekendFee: 400, sevenDayFee: 800, deposit: 1000, description: 'MadRock 兩折式 120×90×12.5cm', active: true },
    helmet:   { name: '岩盔',   weekendFee: 100, sevenDayFee: 200, deposit: 500,  description: '攀岩安全帽', active: true },
    harness:  { name: '攀岩吊帶', weekendFee: 100, sevenDayFee: 200, deposit: 500, description: '攀岩吊帶', active: true },
  };
}

module.exports = router;
