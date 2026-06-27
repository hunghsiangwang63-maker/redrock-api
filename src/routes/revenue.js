/**
 * 營收報表路由
 */
const express = require('express');
const router = express.Router();
const { authenticate, checkPermission } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');

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

      let ref = db.collection(COLLECTIONS.TRANSACTIONS)
        .where('paymentStatus', '==', 'completed');
      if (gymId) ref = ref.where('gymId', '==', gymId);

      // 查詢起點取「本週起」與「本月起」較早者，避免月初時本週橫跨上月而漏算
      const queryStart = weekStart < monthStart ? weekStart : monthStart;
      const dataSnap = await ref
        .where('paidAt', '>=', queryStart)
        .where('paidAt', '<=', todayEnd)
        .get();

      const all = dataSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const todayTxns = all.filter(t => t.paidAt?.toDate() >= todayStart);
      const weekTxns = all.filter(t => t.paidAt?.toDate() >= weekStart);
      const txns = all.filter(t => t.paidAt?.toDate() >= monthStart); // 本月統計用

      const sum = (arr) => arr.reduce((a, b) => a + (b.totalAmount || 0), 0);

      res.json({
        today: {
          total: sum(todayTxns),
          count: todayTxns.length,
          byType: groupByType(todayTxns),
          byPayment: groupByPayment(todayTxns),
        },
        week: {
          total: sum(weekTxns),
          count: weekTxns.length,
        },
        month: {
          total: sum(txns),
          count: txns.length,
        },
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

      let ref = db.collection(COLLECTIONS.TRANSACTIONS)
        .where('paymentStatus', '==', 'completed')
        .where('paidAt', '>=', startDate)
        .where('paidAt', '<=', endDate);
      if (gymId) ref = ref.where('gymId', '==', gymId);

      const snap = await ref.orderBy('paidAt', 'desc').get();
      const txns = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // 按日期分組
      const byDate = {};
      for (let i = 0; i < days; i++) {
        const date = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
        byDate[date] = { date, total: 0, byType: {}, count: 0 };
      }

      txns.forEach(t => {
        const date = dayjs(t.paidAt.toDate()).format('YYYY-MM-DD');
        if (byDate[date]) {
          byDate[date].total += t.totalAmount || 0;
          byDate[date].count += 1;
          const type = t.type || 'other';
          byDate[date].byType[type] = (byDate[date].byType[type] || 0) + (t.totalAmount || 0);
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

      let ref = db.collection(COLLECTIONS.TRANSACTIONS)
        .where('paymentStatus', '==', 'completed');
      if (gymId) ref = ref.where('gymId', '==', gymId);
      if (type) ref = ref.where('type', '==', type);
      if (paymentMethod) ref = ref.where('paymentMethod', '==', paymentMethod);
      if (dateFrom) ref = ref.where('paidAt', '>=', new Date(dateFrom));
      if (dateTo) ref = ref.where('paidAt', '<=', new Date(dateTo));

      const snap = await ref.orderBy('paidAt', 'desc').limit(parseInt(limit)).get();
      const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));

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

// ── GET /revenue/export-csv - 匯出 CSV ──────────────────────────
router.get('/export-csv',
  authenticate,
  checkPermission('revenue.report'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
      const { dateFrom, dateTo } = req.query;

      let ref = db.collection(COLLECTIONS.TRANSACTIONS)
        .where('paymentStatus', '==', 'completed');
      if (gymId) ref = ref.where('gymId', '==', gymId);
      if (dateFrom) ref = ref.where('paidAt', '>=', new Date(dateFrom));
      if (dateTo) ref = ref.where('paidAt', '<=', new Date(dateTo));

      const snap = await ref.orderBy('paidAt', 'desc').get();
      const txns = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      const TYPE_LABEL = {
        checkin: '入場', pass: '定期票', course: '課程',
        product: '商品', competition: '比賽', single_entry_ticket: '單次入場券',
      };
      const PAYMENT_LABEL = {
        cash: '現金', linepay: 'Line Pay', jkopay: '街口支付',
        taiwanpay: '台灣Pay', ecpay_atm: 'ATM轉帳',
      };

      const rows = [
        ['收據編號', '日期', '時間', '類型', '付款方式', '金額', '會員ID'].join(','),
        ...txns.map(t => [
          t.receiptNo || t.id,
          dayjs(t.paidAt.toDate()).format('YYYY-MM-DD'),
          dayjs(t.paidAt.toDate()).format('HH:mm'),
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
        child_free: '兒童免費', student_free: '學生免費',
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
    result[t.type] = (result[t.type] || 0) + (t.totalAmount || 0);
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
