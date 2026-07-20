const express = require('express');
const router = express.Router();
const { authenticate, authenticateAny, requireManagerOrStation } = require('../middleware/auth');
const { checkMemberOwnership } = require('../utils/memberOwnership');
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

    // 計算費用（共用 helper，與修改端點同一份）
    const { itemsWithFee, totalRentalFee, totalDeposit } = computeRentalItems(settings, items, rentalType);

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
      memberPaidAmount: req.body.paidAmount ? Number(req.body.paidAmount) : null, // 會員自填實際匯款金額
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
    const rentals = snap.docs.map(d => {
      const { staffNote, ...rest } = d.data(); // 員工備註不回傳會員端
      return { id: d.id, ...rest };
    }).sort((a, b) => b.createdAt?._seconds - a.createdAt?._seconds);
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
    try { await recordRentalRevenue(db, req.params.id, { staffId: req.staff.id, staffName: req.staff.name }); }
    catch (e) { console.error('器材租借記帳失敗', e.message); }
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

// ── 共用：依設定重算品項費用（金額後端權威，供 apply/修改共用） ──
function computeRentalItems(settings, items, rentalType) {
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
  return { itemsWithFee, totalRentalFee, totalDeposit };
}

// ── 共用：器材租借確認收款記帳（type:'rental'，租金不含押金；冪等 revenueRecorded）──
async function recordRentalRevenue(db, id, { staffId, staffName }) {
  const ref = db.collection('equipmentRentals').doc(id);
  const doc = await ref.get();
  if (!doc.exists) return;
  const r = doc.data();
  if (r.revenueRecorded) return;              // 冪等：已記過不重複
  const fee = Number(r.totalRentalFee) || 0;
  if (fee > 0) {
    await db.collection('transactions').add({
      type: 'rental',
      totalAmount: fee,                        // 租金（押金為保證金、不記收入）
      gymId: r.gymId,
      memberId: r.memberId || null,
      memberName: r.memberName || '',
      paymentMethod: r.paymentMethod || 'cash',
      relatedType: 'equipmentRental', relatedId: id,
      notes: `器材租借：${(r.items || []).map(i => i.name).join('、')}`,
      paymentStatus: 'completed',
      recognitionDate: new Date(),             // 認列在確認收款（取件）當日
      staffId: staffId || null, staffName: staffName || null,
      createdAt: new Date(),
    });
  }
  await ref.update({ revenueRecorded: true, updatedAt: new Date() });
}

// ── POST /rentals/:id/cancel - 取消申請（會員本人限 pending/confirmed；員工亦可） ──
router.post('/:id/cancel', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('equipmentRentals').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const r = doc.data();
    const isStaff = !!req.staff;
    if (!isStaff) {
      const deny = await checkMemberOwnership(req.member, r.memberId, { onMissing: 403 });
      if (deny) return res.status(deny.status).json(deny.body);
    }
    if (!['pending', 'confirmed'].includes(r.status)) {
      return res.status(400).json({ error: 'INVALID_STATUS', message: '器材已取件或已結案，無法取消（請洽櫃檯辦理歸還）' });
    }
    await doc.ref.update({
      status: 'cancelled', cancelledAt: new Date(),
      cancelledBy: isStaff ? (req.staff.name || req.staff.id) : 'member',
      updatedAt: new Date(),
    });
    // 作廢連動的 pending 轉帳單（避免殘留在待收款）
    try {
      const ts = await db.collection('transferRecords').where('refId', '==', req.params.id).get();
      const batch = db.batch();
      ts.docs.filter(d => d.data().status === 'pending')
        .forEach(d => batch.update(d.ref, { status: 'void', voidReason: 'rental_cancelled', updatedAt: new Date() }));
      await batch.commit();
    } catch (e) {}
    res.json({ success: true, message: '租借申請已取消' });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── PUT /rentals/:id - 修改申請（會員限 pending；員工限 pending/confirmed）費用後端重算 ──
router.put('/:id', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('equipmentRentals').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const r = doc.data();
    const isStaff = !!req.staff;
    if (!isStaff) {
      const deny = await checkMemberOwnership(req.member, r.memberId, { onMissing: 403 });
      if (deny) return res.status(deny.status).json(deny.body);
      if (r.status !== 'pending') return res.status(400).json({ error: 'INVALID_STATUS', message: '館方已確認收款，如需修改請洽櫃檯' });
    } else if (!['pending', 'confirmed'].includes(r.status)) {
      return res.status(400).json({ error: 'INVALID_STATUS', message: '器材已取件或已結案，無法修改' });
    }
    const pickupDate = req.body.pickupDate || r.pickupDate;
    const returnDate = req.body.returnDate || r.returnDate;
    const rentalType = req.body.rentalType || r.rentalType;
    const items = Array.isArray(req.body.items) && req.body.items.length ? req.body.items : r.items.map(i => ({ type: i.type, quantity: i.quantity }));
    if (!pickupDate || !returnDate) return res.status(400).json({ code: 'MISSING_DATE', message: '請選擇借出/歸還日期' });
    const settingsDoc = await db.collection('systemSettings').doc('rentalItems').get();
    const settings = settingsDoc.exists ? settingsDoc.data() : defaultSettings();
    const { itemsWithFee, totalRentalFee, totalDeposit } = computeRentalItems(settings, items, rentalType);
    await doc.ref.update({
      pickupDate, returnDate, rentalType,
      items: itemsWithFee, totalRentalFee, totalDeposit,
      editedAt: new Date(), editedBy: isStaff ? (req.staff.name || req.staff.id) : 'member',
      updatedAt: new Date(),
    });
    res.json({ success: true, totalRentalFee, totalDeposit, message: `已更新申請（租金 NT$${totalRentalFee} + 押金 NT$${totalDeposit}）` });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /rentals/:id/return-deposit - 退回押金（歸還後補退；退畢租借結案進歷史） ──
router.post('/:id/return-deposit', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('equipmentRentals').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const r = doc.data();
    if (r.status !== 'returned') return res.status(400).json({ error: 'INVALID_STATUS', message: '器材尚未歸還，請先確認歸還' });
    if (r.depositReturned) return res.status(400).json({ error: 'ALREADY_RETURNED', message: '押金已退回' });
    await doc.ref.update({
      depositReturned: true,
      depositReturnedBy: req.staff.name || req.staff.id, depositReturnedAt: new Date(), updatedAt: new Date(),
    });
    res.json({ success: true, message: `押金 NT$${r.totalDeposit} 已退回，租借結案` });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /rentals/:id/staff-note - 員工備註（會員看不到；/my 已剔除） ──
router.put('/:id/staff-note', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('equipmentRentals').doc(req.params.id).update({
      staffNote: String(req.body.staffNote || ''),
      staffNoteBy: req.staff.name || req.staff.id, staffNoteAt: new Date(), updatedAt: new Date(),
    });
    res.json({ success: true, message: '備註已儲存' });
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
module.exports.recordRentalRevenue = recordRentalRevenue;
