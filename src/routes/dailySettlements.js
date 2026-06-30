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
    const entryByType = {};   // 入場收入細項（依入場類型）
    const ENTRY_LABEL = { single_ticket:'單次購票', single_entry_ticket:'單次入場券', pass:'定期票入場', vip:'VIP', course_access:'課程學員', discount_card:'優惠折扣券', black_card:'黑卡', child_free:'兒童免費', student_free:'學生免費', experience:'體驗' };
    checkinSnap.docs.forEach(d => {
      const data = d.data();
      const amount = data.amountPaid || 0;
      const entryAmt = data.entryFee ?? amount;
      entryIncome += entryAmt;
      const et = data.entryType || 'other';
      entryByType[et] = (entryByType[et] || 0) + entryAmt;
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
    // 改以認列日 recognitionDate 歸帳（課程預收期間不計入；單欄位範圍＋記憶體過濾避索引）
    const txnSnap = await db.collection('transactions')
      .where('recognitionDate', '>=', todayStart)
      .where('recognitionDate', '<=', todayEnd).get();

    let courseIncome = 0, cashCourse = 0;
    let passIncome = 0, cashPass = 0;
    const passByType = {};   // 定期票收入細項（依票種，從 notes「定期票購買：xxx」取名）
    txnSnap.docs.forEach(d => {
      const data = d.data();
      if (data.paymentStatus !== 'completed' || data.gymId !== gymId) return;
      const amount = data.totalAmount || 0;
      if (data.type === 'course') {
        courseIncome += amount;
        if (data.paymentMethod === 'cash') cashCourse += amount;
      } else if (data.type === 'pass') {
        passIncome += amount;
        if (data.paymentMethod === 'cash') cashPass += amount;
        const nm = ((data.notes || '').split('：')[1] || '定期票').trim() || '定期票';
        passByType[nm] = (passByType[nm] || 0) + amount;
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
      checkinCount: checkinSnap.size,   // 當日 check-in 人數（自動）
      prevCashBalance: prevBalance,
      income: {
        entry: entryIncome,
        shoeRental: shoeRentalIncome,
        product: productIncome,
        course: courseIncome,
        pass: passIncome,
        total: totalIncome,
        // 細項
        entryItems: Object.entries(entryByType).filter(([, v]) => v > 0).map(([k, v]) => ({ label: ENTRY_LABEL[k] || k, value: v })),
        passItems: Object.entries(passByType).filter(([, v]) => v > 0).map(([k, v]) => ({ label: k, value: v })),
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

    const { income, payment, deductions, denominations, invoiceLastNumber, notes,
      invoiceStartNumber, invoiceVoidNumbers, cardOrangeFirst, cardFullFirst, checkinCount } = req.body;

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
      // 月銷售紀錄用：發票起訖/作廢號、票卡最前號、當日 check-in 人數
      invoiceStartNumber: invoiceStartNumber || '',
      invoiceVoidNumbers: invoiceVoidNumbers || '',
      cardOrangeFirst: cardOrangeFirst || '',
      cardFullFirst: cardFullFirst || '',
      checkinCount: checkinCount ?? null,
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

// ── GET /daily-settlements/monthly-export?month=YYYY-MM ──────────────
// 管理員下載「月銷售紀錄」Excel：整月每日一欄，照原版型自動帶入每日結帳
router.get('/monthly-export', authenticate, async (req, res) => {
  try {
    const role = req.staff?.role;
    if (!['super_admin', 'gym_manager'].includes(role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '僅管理員可下載月銷售紀錄' });
    }
    const db = getDb();
    const XLSX = require('xlsx');
    const gymId = role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : dayjs().format('YYYY-MM');
    const start = `${month}-01`;
    const daysInMonth = dayjs(start).daysInMonth();
    const end = dayjs(start).endOf('month').format('YYYY-MM-DD');

    // 單欄位範圍 + 記憶體過濾 gym（避複合索引）
    const snap = await db.collection('dailySettlements').where('date', '>=', start).where('date', '<=', end).get();
    const byDate = {};
    snap.docs.forEach(d => { const s = d.data(); if (!gymId || s.gymId === gymId) byDate[s.date] = s; });

    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    const dates = [];
    for (let i = 1; i <= daysInMonth; i++) dates.push(dayjs(start).date(i).format('YYYY-MM-DD'));
    const dayCols = dates.map(dt => dayjs(dt).format('M/D'));
    const wdCols = dates.map(dt => WD[dayjs(dt).day()]);

    const val = (dt, fn) => { const s = byDate[dt]; return s ? (fn(s) ?? '') : ''; };
    const dedSum = (s, type) => { const v = (s.deductions || []).filter(x => x.type === type).reduce((a, x) => a + (Number(x.amount) || 0), 0); return v || ''; };
    const itemVal = (s, arr, label) => { const it = (s.income?.[arr] || []).find(x => x.label === label); return it ? it.value : ''; };

    // 收集整月出現過的「入場/票種」細項 label（動態列）
    const entryLabels = [], passLabels = [];
    dates.forEach(dt => { const s = byDate[dt]; if (!s) return;
      (s.income?.entryItems || []).forEach(it => { if (!entryLabels.includes(it.label)) entryLabels.push(it.label); });
      (s.income?.passItems || []).forEach(it => { if (!passLabels.includes(it.label)) passLabels.push(it.label); });
    });

    const R = (a, b, c, fn) => [a, b, c, ...dates.map(dt => fn ? val(dt, fn) : '')];
    const aoa = [];
    aoa.push(['項目', '', '', ...dayCols]);
    aoa.push(['', '星期', '', ...wdCols]);
    aoa.push(R('check-in 人數', '', '', s => s.checkinCount));
    aoa.push(R('發票', '起始號碼', '', s => s.invoiceStartNumber));
    aoa.push(R('', '結束號碼', '', s => s.invoiceLastNumber));
    aoa.push(R('', '作廢號碼', '', s => s.invoiceVoidNumbers));
    aoa.push(R('結帳報表', '實收總額', '', s => s.income?.total));
    aoa.push(R('', '退貨總額', '', s => dedSum(s, '其他退款')));
    aoa.push(R('票卡資訊', '優惠卡最前號', '', s => s.cardOrangeFirst));
    aoa.push(R('', '全票最前號', '', s => s.cardFullFirst));
    aoa.push(R('收支', '定線費', '', s => dedSum(s, '定線費')));
    aoa.push(R('', '教練費', '', s => dedSum(s, '教練費')));
    aoa.push(R('', '領取現金', '', s => dedSum(s, '現金領取')));
    aoa.push(R('行動支付', '台灣Pay', '', s => s.payment?.taiwanPay));
    aoa.push(R('', 'Line Pay', '', s => s.payment?.linePay));
    aoa.push(R('', '街口', '', s => s.payment?.jko));
    aoa.push(R('', '現金', '', s => s.payment?.cash));
    aoa.push(R('收銀機應有餘額', '', '', s => s.expectedCashBalance));
    aoa.push(['現金清點', '面額', '']);
    [['1', 'd1'], ['5', 'd5'], ['10', 'd10'], ['50', 'd50'], ['100', 'd100'], ['500', 'd500'], ['1000', 'd1000']]
      .forEach(([lbl, key]) => aoa.push(R('', lbl, '', s => s.denominations?.[key])));
    aoa.push(R('', '清點總計', '', s => s.actualCashBalance));
    aoa.push(R('差異(清點-應有)', '', '', s => s.difference));
    aoa.push(R('說明', '', '', s => s.notes));
    aoa.push(['品項銷售明細', '', '']);
    entryLabels.forEach(lb => aoa.push(R('入場費', lb, '', s => itemVal(s, 'entryItems', lb))));
    aoa.push(R('租借費', '岩鞋', '', s => s.income?.shoeRental));
    aoa.push(R('商品販售', '商品', '', s => s.income?.product));
    passLabels.forEach(lb => aoa.push(R('定期票', lb, '', s => itemVal(s, 'passItems', lb))));
    aoa.push(R('教學費', '課程', '', s => s.income?.course));
    aoa.push(R('總計', '', '', s => s.income?.total));

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 6 }, ...dates.map(() => ({ wch: 8 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, month);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const gymName = gymId === 'gym-hsinchu' ? '新竹' : gymId === 'gym-shilin' ? '士林' : '全館';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="sales_${gymName}_${month}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
