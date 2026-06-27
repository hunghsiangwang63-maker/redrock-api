/**
 * 單日結帳路由
 * GET  /daily-settlements/today          取得今日結帳資料（自動帶入）
 * POST /daily-settlements                建立結帳
 * GET  /daily-settlements                查詢結帳紀錄
 * PUT  /daily-settlements/:id/unlock     管理員解鎖重新結帳
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const { authenticate, checkPermission, requireStationAuth } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

// ── GET /daily-settlements/today ─────────────────────────────────
router.get('/today', authenticate, requireStationAuth, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    const today = dayjs().format('YYYY-MM-DD');

    // 查今日是否已結帳
    const existSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId)
      .where('date', '==', today)
      .limit(1).get();
    if (!existSnap.empty)
      return res.json({ settlement: { id: existSnap.docs[0].id, ...existSnap.docs[0].data() }, alreadySettled: true });

    // 取前日餘額
    const prevSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId)
      .where('date', '<', today)
      .orderBy('date', 'desc')
      .limit(1).get();
    const prevBalance = prevSnap.empty ? 0 : (prevSnap.docs[0].data().closingCashBalance || 0);

    // 統計今日五大類收入
    const todayStart = dayjs().startOf('day').toDate();
    const todayEnd = dayjs().endOf('day').toDate();

    // 入場收入（用isCancelled而非status，才能同時涵蓋QR入場與電話入場）
    const checkinSnap = await db.collection('checkIns')
      .where('gymId', '==', gymId)
      .where('isCancelled', '==', false)
      .where('checkedInAt', '>=', todayStart)
      .where('checkedInAt', '<=', todayEnd).get();

    let entryIncome = 0, shoeRentalIncome = 0;
    let cashEntry = 0, linePayEntry = 0, jkoEntry = 0, twPayEntry = 0;
    checkinSnap.docs.forEach(d => {
      const data = d.data();
      const amount = data.amountPaid || 0;
      entryIncome += data.entryFee ?? amount;
      shoeRentalIncome += data.shoesPrice || 0;
      if (data.paymentMethod === 'cash') cashEntry += amount;
      else if (data.paymentMethod === 'linepay') linePayEntry += amount;
      else if (data.paymentMethod === 'jkopay') jkoEntry += amount;
      else if (data.paymentMethod === 'taiwanpay') twPayEntry += amount;
    });

    // 商品銷售
    const salesSnap = await db.collection('productSales')
      .where('gymId', '==', gymId)
      .where('soldAt', '>=', todayStart)
      .where('soldAt', '<=', todayEnd).get();
    let productIncome = 0, cashProduct = 0, linePayProduct = 0, jkoProduct = 0, twPayProduct = 0;
    salesSnap.docs.forEach(d => {
      const data = d.data();
      productIncome += data.totalAmount || 0;
      if (data.paymentMethod === 'cash') cashProduct += data.totalAmount || 0;
      else if (data.paymentMethod === 'linepay') linePayProduct += data.totalAmount || 0;
      else if (data.paymentMethod === 'jkopay') jkoProduct += data.totalAmount || 0;
      else if (data.paymentMethod === 'taiwanpay') twPayProduct += data.totalAmount || 0;
    });

    // 課程／定期票收入：統一從 transactions 撈今日已完成交易，再依type分類
    // （改用單一查詢重用既有索引 transactions(gymId, paymentStatus, paidAt)，
    //   避免為 course_enrollment / pass_purchase 各建一個從未被寫入過的舊索引）
    const txnSnap = await db.collection('transactions')
      .where('gymId', '==', gymId)
      .where('paymentStatus', '==', 'completed')
      .where('paidAt', '>=', todayStart)
      .where('paidAt', '<=', todayEnd).get();

    let courseIncome = 0, cashCourse = 0;
    let passIncome = 0, cashPass = 0;
    txnSnap.docs.forEach(d => {
      const data = d.data();
      const amount = data.totalAmount || 0;
      if (data.type === 'course') {
        courseIncome += amount;
        if (data.paymentMethod === 'cash') cashCourse += amount;
      } else if (data.type === 'pass') {
        passIncome += amount;
        if (data.paymentMethod === 'cash') cashPass += amount;
      }
      // type === 'checkin' / 'product' / 'single_entry_ticket' / 'refund' 等
      // 已分別由 checkinSnap / salesSnap 統計，此處不重複加總，僅作為交叉驗證來源
    });

    const totalIncome = entryIncome + shoeRentalIncome + productIncome + courseIncome + passIncome;
    const totalCash = cashEntry + cashProduct + cashCourse + cashPass;
    const totalElectronic = linePayEntry + linePayProduct + jkoEntry + jkoProduct + twPayEntry + twPayProduct;

    const settlement = {
      date: today,
      gymId,
      prevCashBalance: prevBalance,
      income: {
        entry: entryIncome,
        shoeRental: shoeRentalIncome,
        product: productIncome,
        course: courseIncome,
        pass: passIncome,
        total: totalIncome,
      },
      payment: {
        cash: totalCash,
        linePay: linePayEntry + linePayProduct,
        jko: jkoEntry + jkoProduct,
        taiwanPay: twPayEntry + twPayProduct,
        electronic: totalElectronic,
      },
      deductions: [],
      expectedCashBalance: prevBalance + totalCash,
      actualCashBalance: null,
      denominations: { d1:0, d5:0, d10:0, d50:0, d100:0, d500:0, d1000:0 },
      invoiceLastNumber: '',
      difference: null,
      status: 'draft',
    };

    res.json({ settlement, alreadySettled: false });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /daily-settlements ───────────────────────────────────────
router.post('/', authenticate, requireStationAuth, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? (req.body.gymId || req.staff?.gymId) : req.staff?.gymId;
    const today = dayjs().format('YYYY-MM-DD');

    // 確認今日未結帳
    const existSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId).where('date', '==', today).limit(1).get();
    if (!existSnap.empty)
      return res.status(400).json({ error: 'ALREADY_SETTLED', message: '今日已結帳' });

    const { income, payment, deductions, denominations, invoiceLastNumber, notes } = req.body;

    // 計算實際現金
    const d = denominations || {};
    const actualCash = (d.d1||0)*1 + (d.d5||0)*5 + (d.d10||0)*10 +
      (d.d50||0)*50 + (d.d100||0)*100 + (d.d500||0)*500 + (d.d1000||0)*1000;

    // 前日餘額
    const prevSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId).where('date', '<', today)
      .orderBy('date', 'desc').limit(1).get();
    const prevBalance = prevSnap.empty ? 0 : (prevSnap.docs[0].data().closingCashBalance || 0);

    // 計算減項總額
    const totalDeductions = (deductions || []).reduce((sum, d) => sum + (d.amount || 0), 0);
    const expectedCash = prevBalance + (payment?.cash || 0) - totalDeductions;
    const difference = actualCash - expectedCash;

    const id = uuidv4();
    const settlement = {
      id, date: today, gymId,
      staffId: req.staff.id, staffName: req.staff.name,
      prevCashBalance: prevBalance,
      income, payment, deductions: deductions || [],
      denominations, actualCashBalance: actualCash,
      expectedCashBalance: expectedCash,
      closingCashBalance: actualCash,
      difference,
      differenceAlert: Math.abs(difference) > 200,
      invoiceLastNumber: invoiceLastNumber || '',
      notes: notes || '',
      status: 'settled',
      settledAt: new Date(),
      createdAt: new Date(),
    };

    await db.collection('dailySettlements').doc(id).set(settlement);

    // 警示通知
    if (Math.abs(difference) > 200) {
      const managersSnap = await db.collection('staff').where('role', 'in', ['super_admin', 'gym_manager']).get();
      const batch = db.batch();
      managersSnap.docs.forEach(m => {
        const ref = db.collection('notifications').doc();
        batch.set(ref, {
          type: 'settlement_difference',
          title: '結帳差異警示',
          message: `${gymId === 'gym-hsinchu' ? '新竹館' : '士林館'} ${today} 結帳差異 NT$${difference}，請確認`,
          targetStaffId: m.id,
          isRead: false,
          createdAt: new Date(),
        });
      });
      await batch.commit();
    }

    res.status(201).json({ settlement, message: Math.abs(difference) > 200 ? `結帳完成，差異 NT$${difference} 已通知管理員` : '結帳完成' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /daily-settlements ────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? req.query.gymId : req.staff?.gymId;
    const days = parseInt(req.query.days) || 30;
    const fromDate = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    let ref = db.collection('dailySettlements').where('date', '>=', fromDate);
    if (gymId) ref = ref.where('gymId', '==', gymId);
    const snap = await ref.orderBy('date', 'desc').get();
    res.json({ settlements: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /daily-settlements/:id/unlock ────────────────────────────
router.put('/:id/unlock', authenticate, checkPermission('super_admin'), async (req, res) => {
  try {
    const db = getDb();
    await db.collection('dailySettlements').doc(req.params.id).update({
      status: 'unlocked',
      unlockedBy: req.staff.id,
      unlockedAt: new Date(),
    });
    res.json({ message: '結帳已解鎖，可重新結帳' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
