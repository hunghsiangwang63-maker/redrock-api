/**
 * 攀岩等級考核（目前只有「小蜘蛛人」program=spider，1~16 級，16 最入門、1 最高）
 *
 * 資料：
 *  - climbLevelDefs/{program}_{level}：每級定義（練習項目 / 標準 / 體能 / 說明），管理員可編修
 *  - climbLevelRecords：每次考核紀錄（只增不改；誤登用 void 作廢，不刪除）。
 *      progress 為 50/75/90/100，100 才算通過；會員目前等級＝已通過紀錄中「級數最小」者（沒有則尚未通過任何級）
 *  - systemSettings/climbLevels：哪些班別（categoryIds）啟用等級制，沒設定用 DEFAULT_PROGRAMS
 *
 * 權限：登記考核＝任何員工（含值班 operator；教練/櫃檯/正職/管理員）；編修級別定義與作廢紀錄＝super_admin / gym_manager。
 * 會員只能看自己與自己名下子會員的等級。
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, authenticateAny } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const { taiwanToday } = require('../utils/taiwanDate');

const DEFS = 'climbLevelDefs';
const RECORDS = 'climbLevelRecords';
const PROGRESS_VALUES = [50, 75, 90, 100];

// 初階班 16~9、進階班 8~1（來源：小蜘蛛人上課紀錄表 V4）
const DEFAULT_PROGRAMS = {
  spider: {
    name: '小蜘蛛人',
    gymIds: ['gym-hsinchu'],
    categoryIds: ['ebf83b51-ae84-4aa5-975a-7c3050afa7ff', '48151e8e-884b-42aa-b368-bed118a48f14'], // 初級班、進階班
    minLevel: 1, maxLevel: 16,
  },
};

const isAdmin = (staff) => staff && ['super_admin', 'gym_manager'].includes(staff.role);
const requireAdmin = (req, res, next) => (isAdmin(req.staff)
  ? next()
  : res.status(403).json({ error: 'FORBIDDEN', message: '僅管理員可操作' }));

const getProgram = async (db, key) => {
  const base = DEFAULT_PROGRAMS[key];
  if (!base) return null;
  try {
    const s = await db.collection('systemSettings').doc('climbLevels').get();
    const o = s.exists ? (s.data()[key] || {}) : {};
    return { key, ...base, ...o };
  } catch (e) { return { key, ...base }; }
};

const defId = (program, level) => `${program}_${level}`;

const listDefs = async (db, program) => {
  const snap = await db.collection(DEFS).where('program', '==', program).get();
  return snap.docs.map(d => d.data()).sort((a, b) => b.level - a.level);
};

// 會員目前等級＋紀錄（紀錄新到舊）
const memberSummary = async (db, memberId, program) => {
  const snap = await db.collection(RECORDS).where('memberId', '==', memberId).get();
  const records = snap.docs.map(d => d.data()).filter(r => r.program === program)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || ((b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)));
  const valid = records.filter(r => !r.voided);
  const passed = valid.filter(r => r.passed).map(r => r.level);
  const currentLevel = passed.length ? Math.min(...passed) : null; // null＝尚未通過任何級
  // 各級最新進度（進行中的級別）
  const byLevel = {};
  valid.forEach(r => { if (!byLevel[r.level]) byLevel[r.level] = r; });
  return { memberId, program, currentLevel, passedLevels: [...new Set(passed)].sort((a, b) => b - a), byLevel, records };
};

// ── 級別定義 ───────────────────────────────────────────────
// GET /climb-levels/:program/defs（員工與會員皆可看）
router.get('/:program/defs', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const prog = await getProgram(db, req.params.program);
    if (!prog) return res.status(404).json({ error: 'PROGRAM_NOT_FOUND' });
    res.json({ program: prog, defs: await listDefs(db, prog.key) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

// PUT /climb-levels/:program/defs/:level（管理員編修）
router.put('/:program/defs/:level', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const prog = await getProgram(db, req.params.program);
    const level = parseInt(req.params.level, 10);
    if (!prog || !(level >= prog.minLevel && level <= prog.maxLevel)) return res.status(400).json({ error: 'INVALID_LEVEL' });
    const allowed = ['title', 'standard', 'fitness', 'description', 'group'];
    const upd = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) upd[k] = String(req.body[k] ?? '').slice(0, 1000); });
    upd.updatedAt = new Date(); upd.updatedBy = req.staff.id; upd.updatedByName = req.staff.name || '';
    await db.collection(DEFS).doc(defId(prog.key, level)).set({ id: defId(prog.key, level), program: prog.key, level, ...upd }, { merge: true });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

// ── 班級學員清單（登記考核用）──────────────────────────────
// GET /climb-levels/course/:courseId/students
router.get('/course/:courseId/students', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const cDoc = await db.collection('courses').doc(req.params.courseId).get();
    if (!cDoc.exists) return res.status(404).json({ error: 'COURSE_NOT_FOUND' });
    const course = cDoc.data();
    const prog = await getProgram(db, 'spider');
    const enabled = course.type !== 'workshop' && prog.categoryIds.includes(course.categoryId) && (!prog.gymIds?.length || prog.gymIds.includes(course.gymId));
    if (!enabled) return res.json({ enabled: false, course: { id: course.id, name: course.name }, students: [] });
    const enSnap = await db.collection('courseEnrollments').where('courseId', '==', course.id).where('status', '==', 'confirmed').select('memberId', 'memberName', 'isMakeup', 'isTrial').get();
    const names = {};
    enSnap.docs.forEach(d => { const e = d.data(); if (e.memberId && !e.isMakeup) names[e.memberId] = e.memberName || ''; });
    const students = [];
    for (const memberId of Object.keys(names)) {
      const sum = await memberSummary(db, memberId, 'spider');
      students.push({ memberId, name: names[memberId], currentLevel: sum.currentLevel, lastRecord: sum.records.find(r => !r.voided) || null });
    }
    students.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    res.json({ enabled: true, course: { id: course.id, name: course.name, instructor: course.instructor || '', gymId: course.gymId }, students });
  } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

// ── 登記考核（可批次）──────────────────────────────────────
// POST /climb-levels/records  body: { courseId, date, coachName, records:[{memberId, level, progress, description, note}] }
router.post('/records', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { courseId, coachName } = req.body;
    const date = req.body.date || taiwanToday();
    const items = Array.isArray(req.body.records) ? req.body.records : [];
    if (!items.length) return res.status(400).json({ error: 'NO_RECORDS', message: '沒有要登記的資料' });
    if (items.length > 100) return res.status(400).json({ error: 'TOO_MANY', message: '一次最多 100 筆' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > taiwanToday()) return res.status(400).json({ error: 'INVALID_DATE', message: '考核日期不可晚於今天' });
    const prog = await getProgram(db, 'spider');
    let course = null;
    if (courseId) {
      const cDoc = await db.collection('courses').doc(courseId).get();
      if (!cDoc.exists) return res.status(404).json({ error: 'COURSE_NOT_FOUND' });
      course = cDoc.data();
    }
    const coach = String(coachName ?? course?.instructor ?? '').trim().slice(0, 100);
    if (!coach) return res.status(400).json({ error: 'COACH_REQUIRED', message: '請填寫考核教練' });

    const batch = db.batch();
    const now = new Date();
    const created = [];
    for (const it of items) {
      const level = parseInt(it.level, 10);
      const progress = parseInt(it.progress, 10);
      if (!(level >= prog.minLevel && level <= prog.maxLevel)) return res.status(400).json({ error: 'INVALID_LEVEL', message: `級數需為 ${prog.minLevel}~${prog.maxLevel}` });
      if (!PROGRESS_VALUES.includes(progress)) return res.status(400).json({ error: 'INVALID_PROGRESS', message: '進度需為 50/75/90/100' });
      const mDoc = await db.collection('members').doc(String(it.memberId || '')).get();
      if (!mDoc.exists) return res.status(404).json({ error: 'MEMBER_NOT_FOUND', message: '找不到會員' });
      const id = uuidv4();
      const rec = {
        id, program: prog.key, memberId: mDoc.id, memberName: mDoc.data().name || '',
        level, progress, passed: progress === 100, date,
        coachName: coach, courseId: courseId || null, courseName: course?.name || '',
        gymId: course?.gymId || req.staff.gymId || null,
        description: String(it.description || '').slice(0, 500), note: String(it.note || '').slice(0, 500),
        voided: false, createdBy: req.staff.id, createdByName: req.staff.name || '', createdAt: now,
      };
      batch.set(db.collection(RECORDS).doc(id), rec);
      created.push(rec);
    }
    await batch.commit();
    res.status(201).json({ ok: true, count: created.length, records: created });
  } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

// POST /climb-levels/records/:id/void（管理員作廢誤登；不刪除）
router.post('/records/:id/void', authenticate, requireAdmin, async (req, res) => {
  try {
    const ref = getDb().collection(RECORDS).doc(req.params.id);
    const d = await ref.get();
    if (!d.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    await ref.update({ voided: true, voidedAt: new Date(), voidedBy: req.staff.id, voidedReason: String(req.body.reason || '').slice(0, 200) });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

// ── 會員等級 ───────────────────────────────────────────────
// GET /climb-levels/member/:memberId（員工；會員僅限本人或名下子會員）
router.get('/member/:memberId', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const { memberId } = req.params;
    if (req.member && req.member.id !== memberId) {
      const t = await db.collection('members').doc(memberId).get();
      if (!t.exists || t.data().parentMemberId !== req.member.id) return res.status(403).json({ error: 'FORBIDDEN', message: '無權限查看' });
    }
    const prog = await getProgram(db, 'spider');
    const [sum, defs] = await Promise.all([memberSummary(db, memberId, prog.key), listDefs(db, prog.key)]);
    // 會員端不顯示作廢紀錄與內部欄位
    const records = req.member ? sum.records.filter(r => !r.voided).map(({ createdBy, createdByName, voided, ...r }) => r) : sum.records;
    res.json({ ...sum, records, defs, program: { key: prog.key, name: prog.name } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

module.exports = router;
