/**
 * 人事報酬記錄（2026-09-14 新增）——教練費/定線費/拆點費等給付紀錄，供日後申報所得時查資料清楚用。
 *
 * 集合：payoutRecords（date/payeeName/amount/category/gymId/note/recordedBy/recordedByName）。
 *
 * ⚠ 與每日結帳「加減項」是兩個獨立機制、刻意不互相寫入：結帳加減項（教練費/定線費類型）是為了抽屜
 *   現金對帳，這裡是為了報稅查詢乾淨的結構化紀錄（可依姓名/日期區間查詢加總）——同一筆真實支出目前
 *   仍需兩邊各記一次，暫不做自動同步（2026-09-14 與使用者確認過的取捨，見 CLAUDE.md）。
 *
 * 權限：全部端點限管理員（super_admin/gym_manager，requireManager）——薪資性質資料，不對值班/一般
 *   員工開放。gym_manager 只能查詢/寫入自己館別；super_admin 可指定館別或省略查全部。
 */
const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const { authenticate, requireManager } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const { taiwanToday } = require('../utils/taiwanDate');
const { v4: uuidv4 } = require('uuid');

const COLL = 'payoutRecords';
const GYM_IDS = ['gym-hsinchu', 'gym-shilin'];
const GYM_LABEL = { 'gym-hsinchu': '新竹館', 'gym-shilin': '士林館' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// 依角色決定實際查詢/寫入用的 gymId：gym_manager 一律鎖自己館（忽略 request 帶的值）；
// super_admin 用 request 指定的值（可為 undefined＝不限館別）。
const resolveGymId = (req, requested) => (req.staff.role === 'super_admin' ? (requested || null) : req.staff.gymId);

const fetchFiltered = async (db, { gymId, dateFrom, dateTo, category, name }) => {
  const snap = gymId
    ? await db.collection(COLL).where('gymId', '==', gymId).get()
    : await db.collection(COLL).get();
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (dateFrom) rows = rows.filter(r => r.date >= dateFrom);
  if (dateTo) rows = rows.filter(r => r.date <= dateTo);
  if (category) rows = rows.filter(r => r.category === category);
  if (name) {
    const kw = String(name).trim();
    rows = rows.filter(r => (r.payeeName || '').includes(kw));
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.createdAtMs - b.createdAtMs);
  return rows;
};

// ── GET /payouts - 列表（含篩選）──────────────────────────
router.get('/', authenticate, requireManager, async (req, res) => {
  try {
    const db = getDb();
    const gymId = resolveGymId(req, req.query.gymId);
    const rows = await fetchFiltered(db, {
      gymId, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
      category: req.query.category, name: req.query.name,
    });
    rows.sort((a, b) => b.date.localeCompare(a.date)); // 列表畫面：最新在前
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    res.json({ records: rows, total });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /payouts - 新增一筆 ──────────────────────────
router.post('/',
  authenticate, requireManager,
  body('date').matches(DATE_RE).withMessage('日期格式須為 YYYY-MM-DD'),
  body('payeeName').trim().notEmpty().withMessage('請輸入姓名'),
  body('amount').isFloat({ min: 0.01 }).withMessage('金額須大於 0'),
  body('category').trim().notEmpty().withMessage('請輸入付款項目'),
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = resolveGymId(req, req.body.gymId);
      if (!gymId || !GYM_IDS.includes(gymId)) {
        return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
      }
      const now = new Date();
      const id = uuidv4();
      const record = {
        id, date: req.body.date, payeeName: String(req.body.payeeName).trim(),
        amount: Number(req.body.amount), category: String(req.body.category).trim(),
        gymId, note: req.body.note ? String(req.body.note).trim() : '',
        recordedBy: req.staff.id, recordedByName: req.staff.name || '',
        createdAt: now, updatedAt: now, createdAtMs: now.getTime(),
      };
      await db.collection(COLL).doc(id).set(record);
      res.json({ success: true, record });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── PUT /payouts/:id - 修改 ──────────────────────────
router.put('/:id',
  authenticate, requireManager,
  body('date').optional().matches(DATE_RE).withMessage('日期格式須為 YYYY-MM-DD'),
  body('payeeName').optional().trim().notEmpty().withMessage('姓名不可空白'),
  body('amount').optional().isFloat({ min: 0.01 }).withMessage('金額須大於 0'),
  body('category').optional().trim().notEmpty().withMessage('付款項目不可空白'),
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection(COLL).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此筆紀錄' });
      const existing = doc.data();
      if (req.staff.role !== 'super_admin' && existing.gymId !== req.staff.gymId) {
        return res.status(403).json({ error: 'GYM_MISMATCH', message: '無法修改其他館別的紀錄' });
      }
      const updates = { updatedAt: new Date() };
      if (req.body.date !== undefined) updates.date = req.body.date;
      if (req.body.payeeName !== undefined) updates.payeeName = String(req.body.payeeName).trim();
      if (req.body.amount !== undefined) updates.amount = Number(req.body.amount);
      if (req.body.category !== undefined) updates.category = String(req.body.category).trim();
      if (req.body.note !== undefined) updates.note = String(req.body.note).trim();
      if (req.body.gymId !== undefined && req.staff.role === 'super_admin') {
        if (!GYM_IDS.includes(req.body.gymId)) return res.status(400).json({ error: 'INVALID_GYM', message: '館別不正確' });
        updates.gymId = req.body.gymId;
      }
      await ref.update(updates);
      res.json({ success: true, record: { ...existing, ...updates } });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── DELETE /payouts/:id - 刪除 ──────────────────────────
router.delete('/:id', authenticate, requireManager, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection(COLL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此筆紀錄' });
    if (req.staff.role !== 'super_admin' && doc.data().gymId !== req.staff.gymId) {
      return res.status(403).json({ error: 'GYM_MISMATCH', message: '無法刪除其他館別的紀錄' });
    }
    await ref.delete();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /payouts/export - 匯出 xlsx（明細＋依姓名加總兩個工作表）──────────────────────────
router.get('/export', authenticate, requireManager, async (req, res) => {
  try {
    const db = getDb();
    const gymId = resolveGymId(req, req.query.gymId);
    const rows = await fetchFiltered(db, {
      gymId, dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
      category: req.query.category, name: req.query.name,
    });

    const XLSX = require('xlsx');
    const { sanitizeSheet } = require('../utils/xlsxSafe');

    const detailRows = rows.map((r, i) => ({
      '序號': i + 1, '日期': r.date, '館別': GYM_LABEL[r.gymId] || r.gymId || '',
      '姓名': r.payeeName, '付款項目': r.category, '金額': r.amount,
      '備註': r.note || '', '登記人': r.recordedByName || '',
    }));

    const byName = new Map();
    rows.forEach(r => {
      const cur = byName.get(r.payeeName) || { 姓名: r.payeeName, 總金額: 0, 筆數: 0 };
      cur.總金額 += Number(r.amount) || 0;
      cur.筆數 += 1;
      byName.set(r.payeeName, cur);
    });
    const summaryRows = [...byName.values()].sort((a, b) => b.總金額 - a.總金額);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sanitizeSheet(XLSX.utils.json_to_sheet(detailRows)), '明細');
    XLSX.utils.book_append_sheet(wb, sanitizeSheet(XLSX.utils.json_to_sheet(summaryRows)), '依姓名加總');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const rangeLabel = (req.query.dateFrom || req.query.dateTo)
      ? `${req.query.dateFrom || ''}_${req.query.dateTo || ''}` : taiwanToday();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payouts_${rangeLabel}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
