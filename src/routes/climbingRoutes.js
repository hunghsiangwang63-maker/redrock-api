/**
 * 抱石路線管理 + 完攀計分（2026-08-29 新增）
 *
 * 集合：
 *   climbingRoutes  路線（gymId/area/color/grade V0~V10/setter/igUrl/setAt/status active|archived）
 *   routeAscents    完攀記錄（doc id = `${routeId}_${memberId}` 天然去重；points 記錄當下快照、後端權威）
 *
 * 計分：分數 = 難度基本分 × 嘗試層級係數（四捨五入）。
 *   預設值寫死於 DEFAULT_SCORING，可由 systemSettings/routeScoring 覆寫（目前無 UI、走 API/資料設定）。
 *   points 為記錄當下快照——之後調整計分設定不追溯既有記錄（與全站 accrual 快照原則一致）。
 *
 * 記錄限制：會員本人、且「今日已於該路線所屬館別入場（未取消）」才能記錄/更改（DELETE 不限）。
 *
 * 權限：
 *   路線編輯（POST/PUT/DELETE）＝管理員 / 場館電腦(operator·station) / 正職（比照 gyms.js requireAnnounceEditor）
 *   路線檢視（staff GET）＝任何登入員工；會員清單/排名/記錄＝會員 token。
 *
 * ⚠ 路由順序：/scoring-config、/rankings、/member 必須註冊在 /:id 之前（本專案踩過多次的參數路由雷）。
 * ⚠ routeAscents 文件小（無簽名圖等大欄位），全集合掃描搭配 .select() 投影可接受；
 *   若日後記錄量大（數萬筆）再考慮聚合快取。
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateMember, authenticateAny, requireManager } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const { taiwanToday } = require('../utils/taiwanDate');
const { v4: uuidv4 } = require('uuid');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// 路線編輯 gate（比照 gyms.js requireAnnounceEditor：管理員/場館電腦/正職；part_time 個人擋）
const routeEditorGate = (req, res, next) => {
  const role = req.staff?.role;
  const isManager = ['super_admin', 'gym_manager'].includes(role);
  const isStation = ['operator', 'station'].includes(req.staff?.type);
  if (isManager || isStation || role === 'full_time') return next();
  return res.status(403).json({ error: 'ROUTE_EDIT_FORBIDDEN', message: '路線編輯僅限管理員、場館電腦或正職員工' });
};

const GRADES = ['V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10'];

// 嘗試層級（由難到易的完攀效率；multiplier 為預設值、可被 systemSettings/routeScoring 覆寫）
const TIERS = [
  { key: 'flash',  label: 'Flash（第一次嘗試就完攀）', multiplier: 1.5 },
  { key: 'tries3', label: '3 次以內',                  multiplier: 1.3 },
  { key: 'min10',  label: '10 分鐘以內',               multiplier: 1.2 },
  { key: 'min30',  label: '30 分鐘以內',               multiplier: 1.1 },
  { key: 'day',    label: '一天內',                    multiplier: 1.0 },
  { key: 'week',   label: '一週內',                    multiplier: 0.9 },
  { key: 'month',  label: '一個月內',                  multiplier: 0.8 },
];
const TIER_KEYS = TIERS.map(t => t.key);

const DEFAULT_SCORING = {
  // V0=100、每級 +100 → V10=1100
  gradePoints: Object.fromEntries(GRADES.map((g, i) => [g, (i + 1) * 100])),
  tierMultipliers: Object.fromEntries(TIERS.map(t => [t.key, t.multiplier])),
};

// 讀計分設定（覆寫合併預設；讀取失敗回預設，安全 fallback）
async function getScoringConfig(db) {
  try {
    const doc = await db.collection('systemSettings').doc('routeScoring').get();
    if (!doc.exists) return DEFAULT_SCORING;
    const d = doc.data() || {};
    return {
      gradePoints: { ...DEFAULT_SCORING.gradePoints, ...(d.gradePoints || {}) },
      tierMultipliers: { ...DEFAULT_SCORING.tierMultipliers, ...(d.tierMultipliers || {}) },
    };
  } catch (e) { return DEFAULT_SCORING; }
}

function computePoints(cfg, grade, tier) {
  const base = Number(cfg.gradePoints[grade]) || 0;
  const mult = Number(cfg.tierMultipliers[tier]);
  if (!base || !mult) return 0;
  return Math.round(base * mult);
}

// 今日於指定館別是否有未取消入場（比照 /checkin/my-today 同一套查詢邏輯）
async function checkedInTodayAt(db, memberId, gymId) {
  const todayStart = new Date(taiwanToday() + 'T00:00:00+08:00');
  const snap = await db.collection('checkIns')
    .where('memberId', '==', memberId)
    .select('gymId', 'isCancelled', 'checkedInAt')
    .get();
  return snap.docs.some(d => {
    const c = d.data();
    if (c.isCancelled === true || c.gymId !== gymId) return false;
    const at = c.checkedInAt && (c.checkedInAt.toDate ? c.checkedInAt.toDate() : new Date(c.checkedInAt));
    return at && at >= todayStart;
  });
}

// 台灣當月起始（月排名用）
function taiwanMonthStart() {
  return new Date(taiwanToday().slice(0, 7) + '-01T00:00:00+08:00');
}

const ascentDate = (a) => a.recordedAt && (a.recordedAt.toDate ? a.recordedAt.toDate() : new Date(a.recordedAt));

// ── GET /climbing-routes/scoring-config：計分規則（供前端顯示各層級分數）──
router.get('/scoring-config', authenticateAny, async (req, res) => {
  try {
    const cfg = await getScoringConfig(getDb());
    res.json({ grades: GRADES, tiers: TIERS.map(t => ({ key: t.key, label: t.label })), ...cfg });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /climbing-routes/scoring-config：調整計分（僅管理員；只影響之後的新記錄）──
router.put('/scoring-config', authenticate, requireManager, async (req, res) => {
  try {
    const db = getDb();
    const updates = {};
    if (req.body.gradePoints && typeof req.body.gradePoints === 'object') {
      const gp = {};
      for (const g of GRADES) {
        const v = Number(req.body.gradePoints[g]);
        if (Number.isFinite(v) && v >= 0) gp[g] = Math.round(v);
      }
      updates.gradePoints = gp;
    }
    if (req.body.tierMultipliers && typeof req.body.tierMultipliers === 'object') {
      const tm = {};
      for (const t of TIER_KEYS) {
        const v = Number(req.body.tierMultipliers[t]);
        if (Number.isFinite(v) && v > 0 && v <= 10) tm[t] = v;
      }
      updates.tierMultipliers = tm;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'NO_UPDATES', message: '無有效的計分設定' });
    updates.updatedAt = new Date();
    updates.updatedBy = req.staff.id;
    await db.collection('systemSettings').doc('routeScoring').set(updates, { merge: true });
    res.json({ success: true, config: await getScoringConfig(db) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /climbing-routes/rankings?gymId=&period=month|all：排名（top 50＋呼叫者本人名次）──
router.get('/rankings', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const { gymId, period } = req.query;
    const snap = await db.collection('routeAscents')
      .select('memberId', 'memberName', 'gymId', 'points', 'recordedAt')
      .get();
    const monthStart = period === 'month' ? taiwanMonthStart() : null;
    const byMember = new Map();
    snap.docs.forEach(d => {
      const a = d.data();
      if (gymId && a.gymId !== gymId) return;
      if (monthStart) {
        const at = ascentDate(a);
        if (!at || at < monthStart) return;
      }
      const cur = byMember.get(a.memberId) || { memberId: a.memberId, memberName: a.memberName || '', points: 0, ascents: 0 };
      cur.points += Number(a.points) || 0;
      cur.ascents += 1;
      if (a.memberName) cur.memberName = a.memberName; // 取最新快照姓名
      byMember.set(a.memberId, cur);
    });
    const sorted = [...byMember.values()].sort((x, y) => y.points - x.points || y.ascents - x.ascents);
    sorted.forEach((r, i) => { r.rank = i + 1; });
    const myId = req.member?.id || null;
    const mine = myId ? sorted.find(r => r.memberId === myId) || null : null;
    res.json({ rankings: sorted.slice(0, 50), total: sorted.length, myRank: mine });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /climbing-routes/member?gymId=：會員端路線清單（active）＋我的記錄＋今日入場狀態 ──
router.get('/member', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.query.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const cfg = await getScoringConfig(db);
    const [routesSnap, mySnap, checkedIn] = await Promise.all([
      db.collection('climbingRoutes').where('gymId', '==', gymId).get(),
      db.collection('routeAscents').where('memberId', '==', req.member.id).get(),
      checkedInTodayAt(db, req.member.id, gymId),
    ]);
    const routes = routesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r.status !== 'archived')
      .map(r => ({ ...r, basePoints: Number(cfg.gradePoints[r.grade]) || 0 }))
      .sort((a, b) => (a.area || '').localeCompare(b.area || '', 'zh-Hant') || GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade));
    const myAscents = {};
    let myTotalPoints = 0, myTotalAscents = 0;
    mySnap.docs.forEach(d => {
      const a = d.data();
      myAscents[a.routeId] = { tier: a.tier, points: a.points, recordedAt: a.recordedAt };
      myTotalPoints += Number(a.points) || 0;
      myTotalAscents += 1;
    });
    res.json({
      routes, myAscents,
      myTotals: { points: myTotalPoints, ascents: myTotalAscents }, // 含他館與已下架路線（總累積）
      checkedInToday: checkedIn,
      tiers: TIERS.map(t => ({ key: t.key, label: t.label, multiplier: Number(cfg.tierMultipliers[t.key]) || t.multiplier })),
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /climbing-routes?gymId=&includeArchived=1：員工路線清單（含完攀人數統計）──
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { gymId, includeArchived } = req.query;
    let q = db.collection('climbingRoutes');
    if (gymId) q = q.where('gymId', '==', gymId);
    const [snap, ascentsSnap] = await Promise.all([
      q.get(),
      db.collection('routeAscents').select('routeId').get(),
    ]);
    const countByRoute = {};
    ascentsSnap.docs.forEach(d => {
      const rid = d.data().routeId;
      countByRoute[rid] = (countByRoute[rid] || 0) + 1;
    });
    const routes = snap.docs.map(d => ({ id: d.id, ...d.data(), ascentCount: countByRoute[d.id] || 0 }))
      .filter(r => includeArchived ? true : r.status !== 'archived')
      .sort((a, b) => (a.area || '').localeCompare(b.area || '', 'zh-Hant') || GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade));
    res.json({ routes });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /climbing-routes：新增路線 ──
router.post('/', authenticate, routeEditorGate,
  [
    body('gymId').notEmpty(),
    body('grade').isIn(GRADES).withMessage('難度須為 V0~V10'),
    body('area').trim().notEmpty().withMessage('請填寫牆面/區域'),
    body('color').trim().notEmpty().withMessage('請填寫岩點顏色'),
  ], validate,
  async (req, res) => {
    try {
      const db = getDb();
      // 非 super_admin 只能建自己館別的路線（比照公告館別隔離）
      if (req.staff.role !== 'super_admin' && req.staff.gymId && req.body.gymId !== req.staff.gymId) {
        return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '只能管理自己館別的路線' });
      }
      const id = uuidv4();
      const now = new Date();
      const route = {
        gymId: req.body.gymId,
        area: String(req.body.area).trim(),
        color: String(req.body.color).trim(),
        grade: req.body.grade,
        name: String(req.body.name || '').trim(),
        setter: String(req.body.setter || '').trim(),
        igUrl: String(req.body.igUrl || '').trim(),
        setAt: req.body.setAt || taiwanToday(),
        status: 'active',
        createdAt: now, createdBy: req.staff.id, createdByName: req.staff.name || '', updatedAt: now,
      };
      await db.collection('climbingRoutes').doc(id).set(route);
      res.status(201).json({ success: true, route: { id, ...route } });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── PUT /climbing-routes/:id：編輯路線（含 status: active|archived 下架/重新上架）──
router.put('/:id', authenticate, routeEditorGate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('climbingRoutes').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'ROUTE_NOT_FOUND', message: '路線不存在' });
    if (req.staff.role !== 'super_admin' && req.staff.gymId && doc.data().gymId !== req.staff.gymId) {
      return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '只能管理自己館別的路線' });
    }
    const allowed = ['area', 'color', 'grade', 'name', 'setter', 'igUrl', 'setAt', 'status'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] === undefined) continue;
      if (k === 'grade' && !GRADES.includes(req.body[k])) return res.status(400).json({ error: 'INVALID_GRADE', message: '難度須為 V0~V10' });
      if (k === 'status' && !['active', 'archived'].includes(req.body[k])) return res.status(400).json({ error: 'INVALID_STATUS' });
      updates[k] = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'NO_UPDATES' });
    if (updates.status === 'archived' && doc.data().status !== 'archived') updates.archivedAt = new Date();
    updates.updatedAt = new Date();
    await ref.update(updates);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── DELETE /climbing-routes/:id：刪除路線（已有完攀記錄 → 409，請改用下架保留成績）──
router.delete('/:id', authenticate, routeEditorGate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('climbingRoutes').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'ROUTE_NOT_FOUND', message: '路線不存在' });
    if (req.staff.role !== 'super_admin' && req.staff.gymId && doc.data().gymId !== req.staff.gymId) {
      return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '只能管理自己館別的路線' });
    }
    const cnt = await db.collection('routeAscents').where('routeId', '==', req.params.id).count().get();
    if (cnt.data().count > 0) {
      return res.status(409).json({ error: 'ROUTE_HAS_ASCENTS', message: '此路線已有會員完攀記錄，請改用「下架」保留成績' });
    }
    await ref.delete();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /climbing-routes/:id/ascents：會員記錄完攀（今日於該館入場才可；重複記錄＝更新層級）──
router.post('/:id/ascents', authenticateMember,
  [body('tier').isIn(TIER_KEYS).withMessage('無效的嘗試層級')], validate,
  async (req, res) => {
    try {
      const db = getDb();
      const routeDoc = await db.collection('climbingRoutes').doc(req.params.id).get();
      if (!routeDoc.exists) return res.status(404).json({ error: 'ROUTE_NOT_FOUND', message: '路線不存在' });
      const route = routeDoc.data();
      if (route.status === 'archived') return res.status(400).json({ error: 'ROUTE_ARCHIVED', message: '此路線已下架，無法記錄' });
      const ok = await checkedInTodayAt(db, req.member.id, route.gymId);
      if (!ok) return res.status(403).json({ error: 'NOT_CHECKED_IN', message: '需於入場當日才能記錄完攀（請先於該館完成入場）' });
      const cfg = await getScoringConfig(db);
      const points = computePoints(cfg, route.grade, req.body.tier);
      if (!points) return res.status(400).json({ error: 'INVALID_SCORING', message: '無法計算分數' });
      const docId = `${req.params.id}_${req.member.id}`; // 天然去重：一人一路線一筆
      const now = new Date();
      const ascent = {
        routeId: req.params.id, memberId: req.member.id, memberName: req.member.name || '',
        gymId: route.gymId, grade: route.grade, tier: req.body.tier, points,
        recordedAt: now, updatedAt: now,
      };
      await db.collection('routeAscents').doc(docId).set(ascent); // 已存在＝整筆覆寫（更新層級/分數）
      res.status(201).json({ success: true, ascent });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── DELETE /climbing-routes/:id/ascents：會員刪除自己的完攀記錄（不限入場當日，供修正誤記）──
router.delete('/:id/ascents', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('routeAscents').doc(`${req.params.id}_${req.member.id}`);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'ASCENT_NOT_FOUND', message: '無此完攀記錄' });
    await ref.delete();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
