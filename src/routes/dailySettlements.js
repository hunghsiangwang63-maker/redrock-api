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

// ── 入場費六分類（結帳摘要 GET /today 與月銷售 Excel monthly-export 共用）──────────
// 折扣為 checkIn 旗標（隊員 isTeamDiscount、優惠券＝舊折扣卡 legacyDiscount 或優惠折扣券卡
// discount_card 入場），疊加另拆「隊員＋優惠券」；無折扣才依原入場類型（成人/學生/兒童/…）。
const ENTRY_LABEL = { single_ticket:'成人', single_entry_ticket:'單次入場券', pass:'定期票入場', vip:'VIP', course_access:'課程學員', discount_card:'優惠折扣券', black_card:'黑卡', child_free:'兒童', student_free:'學生', bonus:'紅利', experience:'體驗' };
const ENTRY_ORDER = ['成人', '學生', '兒童', '個別使用優惠券', '隊員折扣', '隊員＋優惠券'];
const entryCategory = (data) => {
  const team = data.isTeamDiscount === true;
  const coupon = data.legacyDiscount === true || data.entryType === 'discount_card';
  if (team && coupon) return '隊員＋優惠券';
  if (team) return '隊員折扣';
  if (coupon) return '個別使用優惠券';
  return ENTRY_LABEL[data.entryType] || data.entryType || '其他入場';
};
const entryOrderSort = (a, b) => {
  const ia = ENTRY_ORDER.indexOf(a), ib = ENTRY_ORDER.indexOf(b);
  return ((ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)) || String(a).localeCompare(String(b));
};

// ── GET /daily-settlements/today ─────────────────────────────────
router.get('/today', authenticate, requireStationAuth, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'GYM_REQUIRED', message: '請選擇館別' });
    const today = dayjs().format('YYYY-MM-DD');

    // 查今日 gym+date 的結帳 doc（同一 doc 承載 draft / settled）
    const existSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId)
      .where('date', '==', today)
      .limit(1).get();
    const existDoc = existSnap.empty ? null : existSnap.docs[0];
    // 已正式結帳 → 直接回摘要（含 revisions/resettleCount）
    if (existDoc && existDoc.data().status === 'settled')
      return res.json({ settlement: { id: existDoc.id, ...existDoc.data() }, alreadySettled: true });

    // 取前日餘額
    const prevSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId)
      .where('date', '<', today)
      .orderBy('date', 'desc')
      .limit(1).get();
    const prevBalance = prevSnap.empty ? 0 : (prevSnap.docs[0].data().closingCashBalance || 0);
    // 發票起始號＝前一天結算的最後一張發票號碼 +1（前端可手動修改）
    const prevInvoiceLast = prevSnap.empty ? '' : String(prevSnap.docs[0].data().invoiceLastNumber || '');
    const suggestedInvoiceStart = /^\d+$/.test(prevInvoiceLast)
      ? String(Number(prevInvoiceLast) + 1).padStart(prevInvoiceLast.length, '0')
      : '';

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
    const entryByType = {};   // 入場收入細項（依折扣分類，見模組頂 entryCategory）
    checkinSnap.docs.forEach(d => {
      const data = d.data();
      const amount = data.amountPaid || 0;
      const entryAmt = data.entryFee ?? amount;
      entryIncome += entryAmt;
      const cat = entryCategory(data);
      entryByType[cat] = (entryByType[cat] || 0) + entryAmt;
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
        entryItems: Object.entries(entryByType).filter(([, v]) => v > 0)
          .map(([k, v]) => ({ label: k, value: v }))   // k 已是分類標籤
          .sort((a, b) => entryOrderSort(a.label, b.label)),
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
      suggestedInvoiceStart,   // 前一天最後發票號+1（前端帶入，可改）
      difference: null,
      status: 'draft',
    };

    // 有暫存檔（status:'draft'）→ 一併回傳供前端載回續填（收入等仍用即時重算的 settlement）
    if (existDoc && existDoc.data().status === 'draft') {
      return res.json({ settlement, draft: { id: existDoc.id, ...existDoc.data() }, alreadySettled: false });
    }
    res.json({ settlement, alreadySettled: false });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /daily-settlements/draft ── 暫存檔（不擋已結帳判斷、不發差異通知）──
router.put('/draft', authenticate, requireStationAuth, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? (req.body.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'GYM_REQUIRED', message: '請選擇館別' });
    const today = dayjs().format('YYYY-MM-DD');

    const existSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId).where('date', '==', today).limit(1).get();
    const existDoc = existSnap.empty ? null : existSnap.docs[0];
    if (existDoc && existDoc.data().status === 'settled')
      return res.json({ alreadySettled: true, message: '今日已結帳，暫存未儲存（請用「當日再次結帳」）' });

    const id = existDoc ? existDoc.id : uuidv4();
    const b = req.body;
    const draft = {
      id, date: today, gymId, status: 'draft',
      // 暫存表單欄位（不做金額權威計算，僅保存續填）
      income: b.income || null, payment: b.payment || null,
      deductions: b.deductions || [], denominations: b.denominations || null,
      invoiceSegments: Array.isArray(b.invoiceSegments) ? b.invoiceSegments : null,
      invoiceStartNumber: b.invoiceStartNumber || '', invoiceLastNumber: b.invoiceLastNumber || '',
      invoiceVoidNumbers: b.invoiceVoidNumbers || '',
      cardOrangeFirst: b.cardOrangeFirst || '', cardFullFirst: b.cardFullFirst || '',
      checkinCount: b.checkinCount ?? null, notes: b.notes || '',
      incomeManual: b.incomeManual || null, paymentManual: b.paymentManual || null,
      savedBy: req.staff.id, savedByName: req.staff.name, updatedAt: new Date(),
      createdAt: existDoc ? (existDoc.data().createdAt || new Date()) : new Date(),
    };
    await db.collection('dailySettlements').doc(id).set(draft);
    res.json({ draft, message: '已暫存' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /daily-settlements ───────────────────────────────────────
router.post('/', authenticate, requireStationAuth, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? (req.body.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'GYM_REQUIRED', message: '請選擇館別' });
    const today = dayjs().format('YYYY-MM-DD');

    // 今日 gym+date doc（可能是 draft 或已 settled）；當日再次結帳＝更新同一 doc + revisions
    const existSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId).where('date', '==', today).limit(1).get();
    const existDoc = existSnap.empty ? null : existSnap.docs[0];
    const wasSettled = existDoc && existDoc.data().status === 'settled';

    const { income, payment, deductions, denominations, invoiceLastNumber, notes,
      invoiceStartNumber, invoiceVoidNumbers, cardOrangeFirst, cardFullFirst, checkinCount,
      incomeManual, paymentManual, invoiceSegments, resettleReason } = req.body;  // 轉換期手動輸入並列（系統值與手動值都存）

    // 發票多段：優先 invoiceSegments 陣列；否則回退舊單段欄位。相容性：仍寫 invoiceStartNumber=首段.start、invoiceLastNumber=末段.last
    const segments = (Array.isArray(invoiceSegments) && invoiceSegments.length
      ? invoiceSegments.map(sg => ({ start: String(sg.start ?? '').trim(), last: String(sg.last ?? '').trim() }))
      : ((invoiceStartNumber || invoiceLastNumber)
        ? [{ start: String(invoiceStartNumber || '').trim(), last: String(invoiceLastNumber || '').trim() }]
        : [])
    ).filter(sg => sg.start || sg.last);
    const firstStart = segments.length ? segments[0].start : (invoiceStartNumber || '');
    const lastLast = segments.length ? segments[segments.length - 1].last : (invoiceLastNumber || '');

    // 計算實際現金
    const d = denominations || {};
    const actualCash = (d.d1||0)*1 + (d.d5||0)*5 + (d.d10||0)*10 +
      (d.d50||0)*50 + (d.d100||0)*100 + (d.d500||0)*500 + (d.d1000||0)*1000;

    // 前日餘額
    const prevSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId).where('date', '<', today)
      .orderBy('date', 'desc').limit(1).get();
    const prevBalance = prevSnap.empty ? 0 : (prevSnap.docs[0].data().closingCashBalance || 0);

    // 計算加減項淨額：sign '+' 加入抽屜（預期上升）、'-' 取出（預期下降）；舊資料無 sign 視為 '-'（減）
    const netAdjust = (deductions || []).reduce((sum, d) => sum + ((d.sign === '+' ? 1 : -1) * (Number(d.amount) || 0)), 0);
    // 手動輸入模式：現金以手動值為準（轉換期系統交易不完整），否則用系統算的
    const manualCash = paymentManual && paymentManual.cash !== undefined && paymentManual.cash !== '' && paymentManual.cash !== null
      ? Number(paymentManual.cash) || 0 : null;
    const effectiveCash = manualCash != null ? manualCash : (payment?.cash || 0);
    const expectedCash = prevBalance + effectiveCash + netAdjust;
    const difference = actualCash - expectedCash;

    const id = existDoc ? existDoc.id : uuidv4();
    const settlement = {
      id, date: today, gymId,
      staffId: req.staff.id, staffName: req.staff.name,
      prevCashBalance: prevBalance,
      income, payment, deductions: deductions || [],
      incomeManual: incomeManual || null, paymentManual: paymentManual || null,  // 轉換期手動值（兩者都存）
      denominations, actualCashBalance: actualCash,
      expectedCashBalance: expectedCash,
      closingCashBalance: actualCash,
      difference,
      differenceAlert: Math.abs(difference) > 200,
      invoiceSegments: segments,   // 多段發票
      invoiceLastNumber: lastLast || '',
      // 月銷售紀錄用：發票起訖/作廢號、票卡最前號、當日 check-in 人數
      invoiceStartNumber: firstStart || '',
      invoiceVoidNumbers: invoiceVoidNumbers || '',
      cardOrangeFirst: cardOrangeFirst || '',
      cardFullFirst: cardFullFirst || '',
      checkinCount: checkinCount ?? null,
      notes: notes || '',
      status: 'settled',
      settledAt: new Date(),
      createdAt: existDoc ? (existDoc.data().createdAt || new Date()) : new Date(),
    };

    // 當日再次結帳：把上一版存入 revisions（稽核），更新同一 doc、resettleCount+1
    if (wasSettled) {
      const p = existDoc.data();
      const revisions = Array.isArray(p.revisions) ? [...p.revisions] : [];
      revisions.push({
        settledAt: p.settledAt || null, staffId: p.staffId || null, staffName: p.staffName || null,
        income: p.income || null, payment: p.payment || null, deductions: p.deductions || [],
        denominations: p.denominations || null,
        actualCashBalance: p.actualCashBalance ?? null, expectedCashBalance: p.expectedCashBalance ?? null,
        difference: p.difference ?? null,
        invoiceSegments: p.invoiceSegments || null, invoiceStartNumber: p.invoiceStartNumber || '',
        invoiceLastNumber: p.invoiceLastNumber || '', invoiceVoidNumbers: p.invoiceVoidNumbers || '',
      });
      settlement.revisions = revisions;
      settlement.resettleCount = (p.resettleCount || 0) + 1;
      if (resettleReason) settlement.resettleReason = resettleReason;
    } else {
      settlement.revisions = (existDoc && existDoc.data().revisions) || [];
      settlement.resettleCount = 0;
    }

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

    const doneWord = wasSettled ? '已更新今日結帳' : '結帳完成';
    res.status(201).json({ settlement, resettled: wasSettled, message: Math.abs(difference) > 200 ? `${doneWord}，差異 NT$${difference} 已通知管理員` : `${doneWord}！` });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── DELETE /daily-settlements/:id ── 僅 super_admin，供清理測試資料 ──
router.delete('/:id', authenticate, checkPermission('super_admin'), async (req, res) => {
  try {
    const db = getDb();
    await db.collection('dailySettlements').doc(req.params.id).delete();
    res.json({ message: '已刪除結帳紀錄' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /daily-settlements/sweep-stale-drafts（super_admin，手動補跑/測試）──
// 清理逾期暫存檔（date < 今天−3 的 status:'draft'）；settled 永不刪。與每日排程同一函式。
router.post('/sweep-stale-drafts', authenticate, checkPermission('super_admin'), async (req, res) => {
  try {
    const r = await require('../services/settlementService').sweepStaleSettlementDrafts();
    res.json(r);
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

    // 票種細項（沿用結帳已存的 passItems）
    const passLabels = [];
    dates.forEach(dt => { const s = byDate[dt]; if (!s) return;
      (s.income?.passItems || []).forEach(it => { if (!passLabels.includes(it.label)) passLabels.push(it.label); });
    });

    // 入場細項「拆分」：依模組頂 entryCategory 六分類（成人/學生/兒童/個別使用優惠券/隊員折扣/
    // 隊員＋優惠券/…）逐日彙整，與結帳摘要 income.entryItems 同一套分類。
    const ciSnap = await db.collection('checkIns')
      .where('checkedInAt', '>=', new Date(`${start}T00:00:00+08:00`))
      .where('checkedInAt', '<=', new Date(`${end}T23:59:59+08:00`)).get();
    const entryGroups = {}; // category -> { label, byDate }
    ciSnap.docs.forEach(d => {
      const c = d.data();
      if (c.isCancelled) return;
      if (gymId && c.gymId !== gymId) return;
      if (!c.checkedInAt) return;
      const dt = new Date(c.checkedInAt.toDate().getTime() + 8 * 3600000).toISOString().slice(0, 10);
      const cat = entryCategory(c);
      const fee = (c.entryFee ?? c.amountPaid ?? 0);
      if (!entryGroups[cat]) entryGroups[cat] = { label: cat, byDate: {} };
      entryGroups[cat].byDate[dt] = (entryGroups[cat].byDate[dt] || 0) + fee;
    });
    // 只列有金額的分類（比照結帳摘要 value>0）；固定六分類序在前、其餘 fallback 依名稱
    const entryKeys = Object.keys(entryGroups)
      .filter(k => Object.values(entryGroups[k].byDate).some(v => v > 0))
      .sort(entryOrderSort);

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
    entryKeys.forEach(k => { const g = entryGroups[k]; aoa.push(['入場費', g.label, '', ...dates.map(dt => g.byDate[dt] || '')]); });
    aoa.push(R('租借費', '岩鞋', '', s => s.income?.shoeRental));
    aoa.push(R('商品販售', '商品', '', s => s.income?.product));
    passLabels.forEach(lb => aoa.push(R('定期票', lb, '', s => itemVal(s, 'passItems', lb))));
    aoa.push(R('教學費', '課程', '', s => s.income?.course));
    aoa.push(R('總計', '', '', s => s.income?.total));

    const ws = require('../utils/xlsxSafe').sanitizeSheet(XLSX.utils.aoa_to_sheet(aoa));
    ws['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 6 }, ...dates.map(() => ({ wch: 8 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, month);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const gymName = gymId === 'gym-hsinchu' ? '新竹' : gymId === 'gym-shilin' ? '士林' : '全館';
    const gymSlug = gymId === 'gym-hsinchu' ? 'hsinchu' : gymId === 'gym-shilin' ? 'shilin' : 'all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // HTTP header 必須 ASCII：ASCII fallback filename + RFC 5987 filename*（中文館名 percent-encode）
    res.setHeader('Content-Disposition',
      `attachment; filename="sales_${gymSlug}_${month}.xlsx"; filename*=UTF-8''${encodeURIComponent(`月銷售紀錄_${gymName}_${month}.xlsx`)}`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /daily-settlements/invoice-export?year=YYYY&bimonth=1..6 ──────
// 管理員下載「統一發票明細表（FOR 記帳士）」：每兩個月一期，逐日列發票資料
const GYM_TAX = {
  'gym-hsinchu': { taxId: '87549069', bizName: '紅石攀岩有限公司新竹館' },
  'gym-shilin':  { taxId: '',         bizName: '紅石攀岩有限公司士林館' },
};
router.get('/invoice-export', authenticate, async (req, res) => {
  try {
    const role = req.staff?.role;
    if (!['super_admin', 'gym_manager'].includes(role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '僅管理員可下載' });
    }
    const db = getDb();
    const XLSX = require('xlsx');
    const gymId = role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    const year = parseInt(req.query.year, 10) || dayjs().year();
    const bimonth = Math.min(6, Math.max(1, parseInt(req.query.bimonth, 10) || 1));
    const m1 = (bimonth - 1) * 2 + 1, m2 = m1 + 1;
    const start = `${year}-${String(m1).padStart(2, '0')}-01`;
    const end = dayjs(`${year}-${String(m2).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');
    const track = (req.query.track || '').trim();
    const def = GYM_TAX[gymId] || { taxId: '', bizName: '紅石攀岩有限公司' };
    const taxId = req.query.taxId || def.taxId || '';
    const bizName = req.query.bizName || def.bizName;

    const snap = await db.collection('dailySettlements').where('date', '>=', start).where('date', '<=', end).get();
    const byDate = {};
    snap.docs.forEach(d => { const s = d.data(); if (!gymId || s.gymId === gymId) byDate[s.date] = s; });

    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    const rocYear = year - 1911;
    const aoa = [];
    aoa.push(['', '', '', '營業人使用二聯式收銀機統一發票明細表']);
    aoa.push(['', '', '', '中 華 民 國', '', `${rocYear}年`, `${m1}/${m2}月`]);
    aoa.push(['統一編號', '', '', taxId]);
    aoa.push(['營業人名稱', '', '', bizName]);
    aoa.push(['發票字軌', '', '', track]);
    aoa.push(['開立日期', '星期', '交易客次', '開立發票起號', '開立發票迄號', '發票總金額', '作廢發票號碼', '集點卡最前號', '優惠卡最前號', '全票最前號']);

    const segCount = (st, en) => (/^\d+$/.test(String(st)) && /^\d+$/.test(String(en))) ? (parseInt(en, 10) - parseInt(st, 10) + 1) : 0;
    let d = dayjs(start); const last = dayjs(end);
    while (d.isBefore(last.add(1, 'day'))) {
      const dt = d.format('YYYY-MM-DD'); const s = byDate[dt];
      if (!s) { aoa.push([d.format('YYYY/MM/DD'), WD[d.day()], '', '', '', '', '', '', '', '']); d = d.add(1, 'day'); continue; }
      // 多段發票逐段列（無 invoiceSegments 則回退舊單段）；日彙總（客次/金額/卡號）放第一段列
      const segs = (Array.isArray(s.invoiceSegments) && s.invoiceSegments.length)
        ? s.invoiceSegments : [{ start: s.invoiceStartNumber || '', last: s.invoiceLastNumber || '' }];
      const totalCnt = segs.reduce((a, sg) => a + segCount(sg.start, sg.last), 0) || '';
      segs.forEach((sg, idx) => {
        aoa.push([
          idx === 0 ? d.format('YYYY/MM/DD') : '', idx === 0 ? WD[d.day()] : '', idx === 0 ? totalCnt : '',
          sg.start || '', sg.last || '', idx === 0 ? (s.income?.total ?? '') : '',
          idx === 0 ? (s.invoiceVoidNumbers || '') : '',
          '', idx === 0 ? (s.cardOrangeFirst || '') : '', idx === 0 ? (s.cardFullFirst || '') : '',
        ]);
      });
      d = d.add(1, 'day');
    }

    const ws = require('../utils/xlsxSafe').sanitizeSheet(XLSX.utils.aoa_to_sheet(aoa));
    ws['!cols'] = [{ wch: 12 }, { wch: 5 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    const sheetName = `${year}${String(m1).padStart(2, '0')}${String(m2).padStart(2, '0')}`;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const gymName = gymId === 'gym-hsinchu' ? '新竹' : gymId === 'gym-shilin' ? '士林' : '全館';
    const gymSlug = gymId === 'gym-hsinchu' ? 'hsinchu' : gymId === 'gym-shilin' ? 'shilin' : 'all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // HTTP header 必須 ASCII：ASCII fallback + RFC 5987 filename*（中文館名 percent-encode）
    res.setHeader('Content-Disposition',
      `attachment; filename="invoice_${gymSlug}_${sheetName}.xlsx"; filename*=UTF-8''${encodeURIComponent(`發票明細_${gymName}_${sheetName}.xlsx`)}`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
