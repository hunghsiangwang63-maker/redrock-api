/**
 * 營收報表路由
 */
const express = require('express');
const router = express.Router();
const { authenticate, checkPermission, requireManager } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');

// 沖銷/退費歸回原類別，讓 byType 各分類為「淨額」（合計本就含負向沖銷、不受影響）：
//  - 'refund'（入場/定期票取消沖銷）：優先用 refundCategory；否則依 notes 推斷（入場→checkin、定期票/分期/續約→pass）
//  - '*_refund'（course_refund/competition_refund）：歸回前綴類別（course/competition）
// 這樣日報表的「入場/課程/定期票…」欄位會反映沖銷、與合計一致（原本欄位顯示 gross、只有合計淨額）。
const foldType = (t) => {
  const ty = t.type || 'other';
  if (ty === 'refund') {
    if (t.refundCategory) return t.refundCategory;
    const n = t.notes || '';
    if (n.includes('入場')) return 'checkin';
    if (n.includes('定期票') || n.includes('分期') || n.includes('續約')) return 'pass';
    return 'refund';
  }
  if (ty.endsWith('_refund')) return ty.slice(0, -7); // 'course_refund' → 'course'
  return ty;
};

// ── GET /revenue/summary - 今日/本週/本月統計 ────────────────────
router.get('/summary',
  authenticate,
  checkPermission('revenue.report'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;

      const _TZ = 8 * 60 * 60 * 1000;
      const _todayStrTW = new Date(Date.now() + _TZ).toISOString().slice(0, 10);
      const todayStart = new Date(_todayStrTW + 'T00:00:00+08:00');
      const todayEnd = new Date(_todayStrTW + 'T23:59:59+08:00');
      // 用 TW 日曆日計算週起點（避免在 UTC 伺服器上用 getDay 取到前一天的星期）
      const _dow = dayjs(_todayStrTW).day(); // 0=週日 .. 6=週六，對 TW 日期正確
      const weekStart = new Date(dayjs(_todayStrTW).subtract(_dow, 'day').format('YYYY-MM-DD') + 'T00:00:00+08:00');
      const monthStart = new Date(_todayStrTW.slice(0, 7) + '-01T00:00:00+08:00');

      // 改以「認列日 recognitionDate」歸帳（課程＝最後一堂課、比賽＝比賽前一天）。
      // 用單欄位範圍查 recognitionDate（避複合索引），gymId/paymentStatus 記憶體過濾；
      // recognitionDate 回填＝paidAt，舊資料相容。
      const recogOf = (t) => (t.recognitionDate || t.paidAt)?.toDate?.();
      const queryStart = weekStart < monthStart ? weekStart : monthStart;
      const dataSnap = await db.collection(COLLECTIONS.TRANSACTIONS)
        .where('recognitionDate', '>=', queryStart)
        .where('recognitionDate', '<=', todayEnd)
        .get();
      const all = dataSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(t => t.paymentStatus === 'completed' && (!gymId || t.gymId === gymId));

      const todayTxns = all.filter(t => recogOf(t) >= todayStart);
      const weekTxns = all.filter(t => recogOf(t) >= weekStart);
      const txns = all.filter(t => recogOf(t) >= monthStart); // 本月統計用

      const sum = (arr) => arr.reduce((a, b) => a + (b.totalAmount || 0), 0);

      // 預收貨款＝已收款但認列日在未來（課程/比賽；含負向退費自動抵減）
      let deferred = 0;
      try {
        const defSnap = await db.collection(COLLECTIONS.TRANSACTIONS)
          .where('recognitionDate', '>', todayEnd).get();
        deferred = defSnap.docs.map(d => d.data())
          .filter(t => t.paymentStatus === 'completed' && (!gymId || t.gymId === gymId))
          .reduce((a, t) => a + (t.totalAmount || 0), 0);
      } catch (e) {}

      res.json({
        today: {
          total: sum(todayTxns),
          count: todayTxns.length,
          byType: groupByType(todayTxns),
          byPayment: groupByPayment(todayTxns),
        },
        week: { total: sum(weekTxns), count: weekTxns.length },
        month: { total: sum(txns), count: txns.length },
        deferred, // 預收貨款（已收未認列）
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /revenue/daily - 日報表 ──────────────────────────────────
router.get('/daily',
  authenticate,
  checkPermission('revenue.report'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
      const days = parseInt(req.query.days) || 7;

      const startDate = dayjs().subtract(days - 1, 'day').startOf('day').toDate();
      const endDate = dayjs().endOf('day').toDate();

      // 按認列日歸帳（單欄位範圍查 recognitionDate，gymId/paymentStatus 記憶體過濾）
      const snap = await db.collection(COLLECTIONS.TRANSACTIONS)
        .where('recognitionDate', '>=', startDate)
        .where('recognitionDate', '<=', endDate)
        .get();
      const txns = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(t => t.paymentStatus === 'completed' && (!gymId || t.gymId === gymId));

      // 按日期分組
      const byDate = {};
      for (let i = 0; i < days; i++) {
        const date = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
        byDate[date] = { date, total: 0, byType: {}, count: 0 };
      }

      txns.forEach(t => {
        const date = dayjs((t.recognitionDate || t.paidAt).toDate()).format('YYYY-MM-DD');
        if (!byDate[date]) return;
        const amt = t.totalAmount || 0;
        byDate[date].total += amt;
        byDate[date].count += 1;
        const bt = byDate[date].byType;
        const add = (k, v) => { if (v) bt[k] = (bt[k] || 0) + v; };
        if ((t.type === 'checkin' || (t.type === 'refund' && t.entryFee != null)) && t.entryType === 'buy_pass') {
          // 入場購定期票：票款(entryFee)歸「定期票」欄（賣票收入統一一處）、租借照拆；沖銷(負值)對稱
          const bpEntry = (t.entryFee != null) ? t.entryFee : Math.max(0, amt - (t.shoesPrice || 0));
          add('pass', bpEntry);
          add('rental', amt - bpEntry);
        } else if (t.type === 'checkin' || (t.type === 'refund' && t.entryFee != null)) {
          // 入場費與租借拆開：入場＝純入場(entryFee)；岩鞋/粉袋一律歸「租借」、不算入場。
          // 入場取消退款(refund)也帶 entryFee/shoesPrice（負值）→ 用同一公式對稱沖銷 entry/rental。
          // 無 entryFee 的舊資料退回 totalAmount−岩鞋；租借＝totalAmount−入場（允許負值供退款沖銷）。
          const entry = (t.entryFee != null) ? t.entryFee : Math.max(0, amt - (t.shoesPrice || 0));
          add('checkin', entry);
          add('rental', amt - entry);   // 岩鞋 + 粉袋（退款時為負）
        } else if (/^rental/.test(t.type)) {
          add('rental', amt);           // 器材租借（/rentals）
        } else {
          add(foldType(t), amt);        // 沖銷歸回原類別；pass/course/product 等
        }
      });

      const daily = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
      res.json({ daily, totalDays: days });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /revenue/transactions - 交易明細 ─────────────────────────
router.get('/transactions',
  authenticate,
  checkPermission('revenue.report'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
      const { dateFrom, dateTo, type, paymentMethod, limit = 50, offset = 0 } = req.query;

      // 明細以認列日呈現（與報表一致）。單欄位範圍查 recognitionDate，其餘記憶體過濾
      let q = db.collection(COLLECTIONS.TRANSACTIONS);
      if (dateFrom) q = q.where('recognitionDate', '>=', new Date(dateFrom));
      if (dateTo) q = q.where('recognitionDate', '<=', new Date(dateTo));
      const snap = (dateFrom || dateTo)
        ? await q.get()
        : await q.orderBy('recognitionDate', 'desc').limit(parseInt(limit) * 3).get();
      let transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(t => t.paymentStatus === 'completed' && (!gymId || t.gymId === gymId)
          && (!type || t.type === type) && (!paymentMethod || t.paymentMethod === paymentMethod));
      transactions.sort((a, b) => ((b.recognitionDate || b.paidAt)?.toMillis?.() || 0) - ((a.recognitionDate || a.paidAt)?.toMillis?.() || 0));
      transactions = transactions.slice(0, parseInt(limit));

      res.json({ transactions, count: transactions.length });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /revenue/checkin-stats - 入場統計（含收費）───────────────
router.get('/checkin-stats',
  authenticate,
  checkPermission('revenue.report'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
      const days = parseInt(req.query.days) || 7;

      const startDate = dayjs().subtract(days - 1, 'day').startOf('day').toDate();
      const endDate = dayjs().endOf('day').toDate();

      let ref = db.collection(COLLECTIONS.CHECK_INS)
        .where('isCancelled', '==', false)
        .where('checkedInAt', '>=', startDate)
        .where('checkedInAt', '<=', endDate);
      if (gymId) ref = ref.where('gymId', '==', gymId);

      const snap = await ref.get();
      const checkIns = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // 按日期分組
      const byDate = {};
      for (let i = 0; i < days; i++) {
        const date = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
        byDate[date] = {
          date, count: 0, revenue: 0,
          byType: { pass: 0, vip: 0, course_access: 0, discount_card: 0,
                    black_card: 0, single_entry_ticket: 0, single_ticket: 0,
                    child_free: 0, student_free: 0 },
        };
      }

      checkIns.forEach(c => {
        const date = dayjs(c.checkedInAt.toDate()).format('YYYY-MM-DD');
        if (byDate[date]) {
          byDate[date].count += 1;
          byDate[date].revenue += c.amountPaid || 0;
          if (byDate[date].byType[c.entryType] !== undefined) {
            byDate[date].byType[c.entryType] += 1;
          }
        }
      });

      const daily = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
      res.json({ daily, totalCheckIns: checkIns.length });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /revenue/adjustments - 加減項明細（來源：dailySettlements.deductions）─────
// 加減項＝結帳時抽屜現金的手動加/減（非銷售收入），與交易營收「分開列、不併入營收總數」。
router.get('/adjustments',
  authenticate,
  checkPermission('revenue.report'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
      const days = parseInt(req.query.days) || 7;
      // 與 /revenue/daily 期間對齊（近 N 天、含今日）
      const fromDate = dayjs().subtract(days - 1, 'day').format('YYYY-MM-DD');

      // 單欄位範圍查 date（字串 YYYY-MM-DD 字典序即時間序），gymId / status 記憶體過濾避免複合索引
      const snap = await db.collection('dailySettlements').where('date', '>=', fromDate).get();
      const settlements = snap.docs.map(d => d.data())
        .filter(s => s.status !== 'draft' && (!gymId || s.gymId === gymId)); // 只計已結帳（settled/unlocked），排除暫存

      // 攤平每筆結帳的 deductions → 明細列
      const adjustments = [];
      settlements.forEach(s => {
        (s.deductions || []).forEach(d => {
          const sign = d.sign === '+' ? '+' : '-'; // 舊資料無 sign 視為 '-'（減），比對 dailySettlements.js:238
          adjustments.push({
            date: s.date,
            gymId: s.gymId || null,
            sign,
            type: d.type || '',
            amount: Number(d.amount) || 0,
            note: d.note || '',
          });
        });
      });

      // 淨額合計：'+' 加、'-' 減
      const netAdjust = adjustments.reduce((sum, a) => sum + ((a.sign === '+' ? 1 : -1) * a.amount), 0);

      // 新→舊（日期，同日館別）排序
      adjustments.sort((a, b) => b.date.localeCompare(a.date) || String(a.gymId).localeCompare(String(b.gymId)));

      res.json({ adjustments, netAdjust, count: adjustments.length });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /revenue/export-adjustments-csv - 加減項匯出 CSV ─────────
router.get('/export-adjustments-csv',
  authenticate,
  requireManager,
  checkPermission('revenue.report'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
      const days = parseInt(req.query.days) || 7;
      const fromDate = dayjs().subtract(days - 1, 'day').format('YYYY-MM-DD');

      const snap = await db.collection('dailySettlements').where('date', '>=', fromDate).get();
      const settlements = snap.docs.map(d => d.data())
        .filter(s => s.status !== 'draft' && (!gymId || s.gymId === gymId));

      const GYM_LABEL = { 'gym-hsinchu': '新竹館', 'gym-shilin': '士林館' };
      const adjustments = [];
      settlements.forEach(s => {
        (s.deductions || []).forEach(d => {
          const sign = d.sign === '+' ? '+' : '-';
          adjustments.push({
            date: s.date, gymId: s.gymId || null,
            sign, type: d.type || '', amount: Number(d.amount) || 0, note: d.note || '',
          });
        });
      });
      adjustments.sort((a, b) => b.date.localeCompare(a.date) || String(a.gymId).localeCompare(String(b.gymId)));

      const netAdjust = adjustments.reduce((sum, a) => sum + ((a.sign === '+' ? 1 : -1) * a.amount), 0);
      const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`; // 備註可能含逗號 → 加引號

      const rows = [
        ['日期', '館別', '類型', '加減', '金額', '備註'].join(','),
        ...adjustments.map(a => [
          a.date,
          csvCell(GYM_LABEL[a.gymId] || a.gymId || ''),
          csvCell(a.type),
          a.sign === '+' ? '加' : '減',
          (a.sign === '+' ? '' : '-') + a.amount,
          csvCell(a.note),
        ].join(',')),
        ['', '', '', '淨額小計', netAdjust, ''].join(','),
      ];

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="adjustments-${dayjs().format('YYYYMMDD')}.csv"`);
      res.send('﻿' + rows.join('\n')); // BOM for Excel
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /revenue/export-csv - 匯出 CSV ──────────────────────────
router.get('/export-csv',
  authenticate,
  requireManager,
  checkPermission('revenue.report'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
      const { dateFrom, dateTo } = req.query;

      // 以認列日匯出（與報表一致）
      let q = db.collection(COLLECTIONS.TRANSACTIONS);
      if (dateFrom) q = q.where('recognitionDate', '>=', new Date(dateFrom));
      if (dateTo) q = q.where('recognitionDate', '<=', new Date(dateTo));
      const snap = (dateFrom || dateTo) ? await q.get() : await q.orderBy('recognitionDate', 'desc').get();
      const txns = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(t => t.paymentStatus === 'completed' && (!gymId || t.gymId === gymId))
        .sort((a, b) => ((b.recognitionDate || b.paidAt)?.toMillis?.() || 0) - ((a.recognitionDate || a.paidAt)?.toMillis?.() || 0));

      const TYPE_LABEL = {
        checkin: '入場', pass: '定期票', course: '課程', course_refund: '課程退費',
        product: '商品', competition: '比賽', competition_refund: '比賽退費',
        single_entry_ticket: '單次入場券', refund: '退款',
      };
      const PAYMENT_LABEL = {
        cash: '現金', linepay: 'Line Pay', jkopay: '街口支付',
        taiwanpay: '台灣Pay', ecpay_atm: 'ATM轉帳', refund: '退款', transfer: '轉帳',
      };

      const rows = [
        ['收據編號', '認列日', '時間', '類型', '付款方式', '金額', '會員ID'].join(','),
        ...txns.map(t => [
          t.receiptNo || t.id,
          dayjs((t.recognitionDate || t.paidAt).toDate()).format('YYYY-MM-DD'),
          dayjs((t.recognitionDate || t.paidAt).toDate()).format('HH:mm'),
          TYPE_LABEL[t.type] || t.type,
          PAYMENT_LABEL[t.paymentMethod] || t.paymentMethod,
          t.totalAmount || 0,
          t.memberId || '訪客',
        ].join(',')),
      ];

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="revenue-${dayjs().format('YYYYMMDD')}.csv"`);
      res.send('\uFEFF' + rows.join('\n')); // BOM for Excel
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── 入場統計（checkIns）的 CSV 匯出 ─────────────────────────────
router.get('/export-checkin-csv',
  authenticate,
  requireManager,
  checkPermission('revenue.report'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
      const { dateFrom, dateTo } = req.query;

      let ref = db.collection(COLLECTIONS.CHECK_INS)
        .where('isCancelled', '==', false);
      if (gymId) ref = ref.where('gymId', '==', gymId);
      if (dateFrom) ref = ref.where('checkedInAt', '>=', new Date(dateFrom));
      if (dateTo) ref = ref.where('checkedInAt', '<=', new Date(dateTo));

      const snap = await ref.orderBy('checkedInAt', 'desc').get();
      const checkIns = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      const ENTRY_LABEL = {
        pass: '定期票', vip: 'VIP', course_access: '課程學員',
        discount_card: '優惠折扣券', black_card: '黑卡',
        single_entry_ticket: '單次入場券', single_ticket: '單次購票',
        child_free: '兒童入場', student_free: '學生入場',
      };

      const rows = [
        ['日期', '時間', '會員姓名', '入場類型', '付款方式', '金額', '岩鞋租借'].join(','),
        ...checkIns.map(c => [
          dayjs(c.checkedInAt.toDate()).format('YYYY-MM-DD'),
          dayjs(c.checkedInAt.toDate()).format('HH:mm'),
          c.memberName,
          ENTRY_LABEL[c.entryType] || c.entryType,
          c.paymentMethod || '—',
          c.amountPaid || 0,
          c.rentShoes ? `是(NT$${c.shoesPrice})` : '否',
        ].join(',')),
      ];

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="checkin-${dayjs().format('YYYYMMDD')}.csv"`);
      res.send('\uFEFF' + rows.join('\n'));
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── 輔助函數 ─────────────────────────────────────────────────────
function groupByType(txns) {
  const result = {};
  txns.forEach(t => {
    const type = foldType(t);   // 沖銷歸回原類別 → 各分類淨額
    result[type] = (result[type] || 0) + (t.totalAmount || 0);
  });
  return result;
}

function groupByPayment(txns) {
  const result = {};
  txns.forEach(t => {
    result[t.paymentMethod] = (result[t.paymentMethod] || 0) + (t.totalAmount || 0);
  });
  return result;
}

module.exports = router;
