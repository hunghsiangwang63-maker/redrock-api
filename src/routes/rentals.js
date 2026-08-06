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
    if (!pickupDate) return res.status(400).json({ code: 'MISSING_DATE', message: '請選擇借出日期' });
    if (!items?.length) return res.status(400).json({ code: 'MISSING_ITEMS', message: '請選擇租借項目' });

    // 取費率設定
    const settingsDoc = await db.collection('systemSettings').doc('rentalItems').get();
    const settings = settingsDoc.exists ? settingsDoc.data() : defaultSettings();

    // 月租品項（置物櫃）：驗證館別/月數 → 到期日＝借出日＋月數（後端權威）；一般器材需自帶歸還日
    const monthlyItem = (items || []).map(it => ({ it, cfg: settings[it.type] })).find(x => x.cfg && x.cfg.mode === 'monthly');
    let effReturnDate = returnDate, effRentalType = rentalType;
    if (monthlyItem) {
      const months = Number(monthlyItem.it.months) || 0;
      if (!(monthlyItem.cfg.monthlyTiers || {})[months]) return res.status(400).json({ code: 'INVALID_MONTHS', message: '請選擇有效的租借月數' });
      const gyms = monthlyItem.cfg.gyms;
      if (Array.isArray(gyms) && gyms.length && !gyms.includes(gymId)) {
        return res.status(400).json({ code: 'GYM_NOT_ALLOWED', message: `${monthlyItem.cfg.name}目前僅 ${gyms.map(g => g === 'gym-shilin' ? '士林館' : g === 'gym-hsinchu' ? '新竹館' : g).join('、')} 提供` });
      }
      effRentalType = 'monthly';
      effReturnDate = dayjs(pickupDate).add(months, 'month').format('YYYY-MM-DD');
    } else if (!returnDate) {
      return res.status(400).json({ code: 'MISSING_DATE', message: '請選擇歸還日期' });
    }

    // 計算費用（共用 helper，與修改端點同一份）
    const { itemsWithFee, totalRentalFee, totalDeposit } = computeRentalItems(settings, items, effRentalType);

    const id = `rental_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    await db.collection('equipmentRentals').doc(id).set({
      id, memberId,
      // 家長代子女租借時，req.body.xxx 才是租借對象（子女）本人資料，優先信任明確送出的欄位
      memberName: req.body.memberName || req.member?.name || '',
      memberPhone: req.body.memberPhone || req.member?.phone || '',
      gymId, pickupDate, returnDate: effReturnDate, rentalType: effRentalType,
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
      message: monthlyItem
        ? `申請成功！月租 NT$${totalRentalFee}（到期日 ${effReturnDate}），請完成付款`
        : `申請成功！租金 NT$${totalRentalFee} + 押金 NT$${totalDeposit}，請完成付款` });
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
    const ref = db.collection('equipmentRentals').doc(req.params.id);
    const snap = await ref.get();
    const r = snap.exists ? snap.data() : {};
    // 管理員可編輯備註（選填；留空不動既有值）
    const noteUpdate = req.body.staffNote != null ? { staffNote: String(req.body.staffNote).trim() } : {};
    await ref.update({
      paymentStatus: 'confirmed', status: 'active', ...noteUpdate,
      confirmedBy: req.staff.id, confirmedByName: req.staff.name, confirmedAt: new Date(), updatedAt: new Date(),
    });
    try { await recordRentalRevenue(db, req.params.id, { staffId: req.staff.id, staffName: req.staff.name }); }
    catch (e) { console.error('器材租借記帳失敗', e.message); }
    // 押金收取（現金持有）→ 當日結帳加減項（＋押金收取，可於結帳頁編輯/移除；冪等）
    if (Number(r.totalDeposit) > 0 && !r.depositCashAdjDone) {
      try {
        await require('../services/settlementService').addCashAdjustment({
          gymId: r.gymId, sign: '+', type: '押金收取', amount: r.totalDeposit,
          note: `${r.memberName || ''} 器材押金`.trim(),
        });
        await ref.update({ depositCashAdjDone: true });
      } catch (e) { console.error('押金收取寫入結帳加減項失敗', e.message); }
    }
    res.json({ success: true, message: '已確認收款，器材已取件' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /rentals/:id/return - 歸還確認（退押金） ──
router.post('/:id/return', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('equipmentRentals').doc(req.params.id);
    const snap = await ref.get();
    const r = snap.exists ? snap.data() : {};
    const willReturn = req.body.depositReturned !== false;
    await ref.update({
      status: 'returned',
      depositReturned: willReturn,
      depositDeductNote: req.body.deductNote || null,
      returnedBy: req.staff.id, returnedByName: req.staff.name, returnedAt: new Date(), updatedAt: new Date(),
    });
    // 當場退押金（現金取出）→ 當日結帳加減項（−押金退還，部分退可於結帳頁改金額；冪等）
    if (willReturn && Number(r.totalDeposit) > 0 && !r.depositReturnAdjDone) {
      try {
        await require('../services/settlementService').addCashAdjustment({
          gymId: r.gymId, sign: '-', type: '押金退還', amount: r.totalDeposit,
          note: `${r.memberName || ''} 器材押金退還${req.body.deductNote ? '（' + req.body.deductNote + '）' : ''}`.trim(),
        });
        await ref.update({ depositReturnAdjDone: true });
      } catch (e) { console.error('押金退還寫入結帳加減項失敗', e.message); }
    }
    res.json({ success: true, message: '歸還已確認' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── 器材租借開立發票（預先建立，待日後發票機串接；手動記帳版，比照課程/比賽/入場同一套）──
// 底層共用 invoiceService（sourceType:'rental'，refId=rentalId）。金額只算租金、不含押金（見 §8）。
router.get('/:id/invoices', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('invoiceRecords')
      .where('sourceType', '==', 'rental').where('refId', '==', req.params.id).get();
    const invoices = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.issuedAt?._seconds || 0) - (a.issuedAt?._seconds || 0));
    res.json({ invoices });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

router.post('/:id/invoices', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const rentalDoc = await db.collection('equipmentRentals').doc(req.params.id).get();
    if (!rentalDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到租借紀錄' });
    const r = rentalDoc.data();
    const { itemName, amount, taxId, note, issuedAt, track, number } = req.body;
    const invoiceService = require('../services/invoiceService');
    const record = await invoiceService.createInvoice(db, {
      sourceType: 'rental', refId: req.params.id,
      memberId: r.memberId, memberName: r.memberName || '',
      itemName: itemName || '器材租借費', amount: amount ?? r.totalRentalFee, taxId, note, gymId: r.gymId, issuedAt, track, number,
      staffId: req.staff.id, staffName: req.staff.name || '',
      meta: { rentalId: req.params.id },
    });
    res.json({ success: true, invoice: record });
  } catch (err) {
    const map = { INVALID_AMOUNT: 400, MISSING_FIELDS: 400, ALREADY_INVOICED: 400, INVALID_TRACK: 400, INVALID_NUMBER: 400, INVALID_TAX_ID: 400 };
    if (err.code && map[err.code]) return res.status(map[err.code]).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.post('/invoices/:id/void', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const invoiceService = require('../services/invoiceService');
    await invoiceService.voidInvoice(db, req.params.id, req.staff.id, req.staff.name, req.body.voidReason);
    res.json({ success: true });
  } catch (err) {
    const map = { NOT_FOUND: 404, ALREADY_VOIDED: 400 };
    if (err.code && map[err.code]) return res.status(map[err.code]).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── 共用：依設定重算品項費用（金額後端權威，供 apply/修改共用） ──
function computeRentalItems(settings, items, rentalType) {
  let totalRentalFee = 0, totalDeposit = 0;
  const itemsWithFee = items.map(item => {
    const cfg = settings[item.type];
    if (!cfg) throw { code: 'INVALID_ITEM', message: `無效的器材類型: ${item.type}` };
    // 月租品項（置物櫃）：費用查 monthlyTiers[月數]、無押金
    if (cfg.mode === 'monthly') {
      const months = Number(item.months) || 0;
      const tier = (cfg.monthlyTiers || {})[months];
      if (!tier) throw { code: 'INVALID_MONTHS', message: `無效的租借月數（${cfg.name}）` };
      const qty = item.quantity || 1;
      const rentalFee = tier * qty;
      totalRentalFee += rentalFee;
      return { type: item.type, name: cfg.name, quantity: qty, months, rentalFee, deposit: 0, unitFee: tier, unitDeposit: 0, mode: 'monthly' };
    }
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
    let returnDate = req.body.returnDate || r.returnDate;
    let rentalType = req.body.rentalType || r.rentalType;
    const items = Array.isArray(req.body.items) && req.body.items.length ? req.body.items : r.items.map(i => ({ type: i.type, quantity: i.quantity, months: i.months }));
    if (!pickupDate) return res.status(400).json({ code: 'MISSING_DATE', message: '請選擇借出日期' });
    const settingsDoc = await db.collection('systemSettings').doc('rentalItems').get();
    const settings = settingsDoc.exists ? settingsDoc.data() : defaultSettings();
    // 月租品項（置物櫃）：到期日＝借出日＋月數（後端權威）；一般器材需自帶歸還日
    const monthlyItem = (items || []).map(it => ({ it, cfg: settings[it.type] })).find(x => x.cfg && x.cfg.mode === 'monthly');
    if (monthlyItem) {
      rentalType = 'monthly';
      returnDate = dayjs(pickupDate).add(Number(monthlyItem.it.months) || 0, 'month').format('YYYY-MM-DD');
    } else if (!returnDate) {
      return res.status(400).json({ code: 'MISSING_DATE', message: '請選擇歸還日期' });
    }
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
    // 補退押金（現金取出）→ 當日結帳加減項（−押金退還，部分退可於結帳頁改金額；冪等）
    if (Number(r.totalDeposit) > 0 && !r.depositReturnAdjDone) {
      try {
        await require('../services/settlementService').addCashAdjustment({
          gymId: r.gymId, sign: '-', type: '押金退還', amount: r.totalDeposit,
          note: `${r.memberName || ''} 器材押金退還${r.depositDeductNote ? '（' + r.depositDeductNote + '）' : ''}`.trim(),
        });
        await doc.ref.update({ depositReturnAdjDone: true });
      } catch (e) { console.error('押金退還寫入結帳加減項失敗', e.message); }
    }
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
    // 置物櫃：月租制（1/3/6 月）、無押金、限士林館；到期日＝借出日＋月數
    locker:   { name: '置物櫃', mode: 'monthly', monthlyTiers: { 1: 120, 3: 350, 6: 600 }, deposit: 0, gyms: ['gym-shilin'], description: '月租置物櫃', active: true },
  };
}

module.exports = router;
module.exports.recordRentalRevenue = recordRentalRevenue;
