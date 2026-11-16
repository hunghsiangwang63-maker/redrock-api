/**
 * 小蜘蛛人制服（衣服）領取紀錄（collection: uniformIssues，每次發放一筆）
 *
 * 欄位：{ id, memberId, memberName, gymId, kind:'first'|'replacement'（首次／再次發放，滿 2 年可再發）, issuedAt:'YYYY-MM-DD'|'YYYY-MM'|null,
 *        datePrecision:'day'|'month'|null, size, note, rawText（匯入時的原始文字）, source:'xlsx-import'|'manual', voided, createdBy... }
 * 權限：查看／新增＝任何員工（含值班櫃檯、教練）；修改／作廢＝管理員、館長。會員端不顯示。
 * 匯入與註冊自動認領見 services/spiderImportService.js。
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, auditLog } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const { taiwanToday } = require('../utils/taiwanDate');
const { isManagerRole } = require('../utils/roles');

const COL = 'uniformIssues';
const KINDS = ['first', 'replacement'];
const requireAdmin = (req, res, next) => (isManagerRole(req.staff && req.staff.role)
  ? next() : res.status(403).json({ error: 'FORBIDDEN', message: '僅管理員／館長可修改或作廢' }));

const clean = (d) => ({
  id: d.id, memberId: d.memberId, kind: d.kind, issuedAt: d.issuedAt || null, datePrecision: d.datePrecision || null,
  size: d.size || null, note: d.note || null, rawText: d.rawText || null, source: d.source || 'manual', gymId: d.gymId || null,
  createdByName: d.createdByName || null,
  createdAt: d.createdAt && d.createdAt.toDate ? d.createdAt.toDate().toISOString() : null,
});
const sortIssues = (a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')) || (a.kind === 'first' ? -1 : 1);

// 某會員的領取紀錄（不含已作廢）
router.get('/member/:memberId', authenticate, async (req, res) => {
  try {
    const snap = await getDb().collection(COL).where('memberId', '==', req.params.memberId).get();
    const issues = snap.docs.map((d) => d.data()).filter((d) => !d.voided).map(clean).sort(sortIssues);
    res.json({ issues });
  } catch (e) { console.error('[uniforms] get:', e); res.status(500).json({ error: 'SERVER_ERROR', message: '讀取失敗' }); }
});

const parseIssuedAt = (v) => {
  if (v == null || v === '') return { issuedAt: null, datePrecision: null };
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s > taiwanToday() ? { error: '領取日期不可晚於今天' } : { issuedAt: s, datePrecision: 'day' };
  if (/^\d{4}-\d{2}$/.test(s)) return { issuedAt: s, datePrecision: 'month' };
  return { error: '領取日期格式不正確（YYYY-MM-DD）' };
};

// 新增一筆領取紀錄（任何員工）
router.post('/', authenticate, auditLog('uniform.create'), async (req, res) => {
  try {
    const db = getDb();
    const { memberId, kind = 'first', size, note } = req.body;
    const m = await db.collection('members').doc(String(memberId || '')).get();
    if (!m.exists) return res.status(404).json({ error: 'MEMBER_NOT_FOUND', message: '找不到會員' });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'INVALID_KIND', message: '發放類型不正確' });
    const dt = parseIssuedAt(req.body.issuedAt);
    if (dt.error) return res.status(400).json({ error: 'INVALID_DATE', message: dt.error });
    const id = uuidv4();
    const doc = {
      id, memberId: m.id, memberName: m.data().name || '', gymId: req.staff.gymId || req.body.gymId || 'gym-hsinchu',
      kind, ...dt, size: String(size || '').trim().slice(0, 20) || null, note: String(note || '').trim().slice(0, 300) || null,
      rawText: null, source: 'manual', voided: false, createdBy: req.staff.id, createdByName: req.staff.name || '', createdAt: new Date(),
    };
    await db.collection(COL).doc(id).set(doc);
    res.status(201).json({ issue: clean(doc) });
  } catch (e) { console.error('[uniforms] create:', e); res.status(500).json({ error: 'SERVER_ERROR', message: '新增失敗' }); }
});

// 修改（管理員／館長）
router.put('/:id', authenticate, requireAdmin, auditLog('uniform.update'), async (req, res) => {
  try {
    const ref = getDb().collection(COL).doc(req.params.id);
    const d = await ref.get();
    if (!d.exists || d.data().voided) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到這筆紀錄' });
    const patch = { updatedAt: new Date() };
    if ('kind' in req.body) { if (!KINDS.includes(req.body.kind)) return res.status(400).json({ error: 'INVALID_KIND', message: '發放類型不正確' }); patch.kind = req.body.kind; }
    if ('issuedAt' in req.body) { const dt = parseIssuedAt(req.body.issuedAt); if (dt.error) return res.status(400).json({ error: 'INVALID_DATE', message: dt.error }); Object.assign(patch, dt); }
    if ('size' in req.body) patch.size = String(req.body.size || '').trim().slice(0, 20) || null;
    if ('note' in req.body) patch.note = String(req.body.note || '').trim().slice(0, 300) || null;
    await ref.update(patch);
    res.json({ issue: clean({ ...d.data(), ...patch }) });
  } catch (e) { console.error('[uniforms] update:', e); res.status(500).json({ error: 'SERVER_ERROR', message: '修改失敗' }); }
});

// 作廢（管理員／館長；不刪除）
router.post('/:id/void', authenticate, requireAdmin, auditLog('uniform.void'), async (req, res) => {
  try {
    const ref = getDb().collection(COL).doc(req.params.id);
    const d = await ref.get();
    if (!d.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到這筆紀錄' });
    await ref.update({ voided: true, voidedAt: new Date(), voidedBy: req.staff.id, voidedReason: String(req.body.reason || '').slice(0, 200), updatedAt: new Date() });
    res.json({ success: true });
  } catch (e) { console.error('[uniforms] void:', e); res.status(500).json({ error: 'SERVER_ERROR', message: '作廢失敗' }); }
});

module.exports = router;
