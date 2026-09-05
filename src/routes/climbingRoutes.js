/**
 * 抱石路線管理 + 完攀計分（2026-08-29 新增）+ 社交互動（2026-09-01 新增：讚/分享/tag朋友）
 * + 家長代子會員操作（2026-09-02 新增：完攀記錄/排名/暱稱/tag 皆可代子女操作）
 *
 * 集合：
 *   climbingRoutes  路線（gymId/area/color/grade V0~V10/setter/igUrl/setAt/status active|archived/
 *                    likes:{memberId:true}——內嵌 map，路線數量規模小，不比照肥集合另開子集合）
 *   routeAscents    完攀記錄（doc id = `${routeId}_${memberId}` 天然去重；points 記錄當下快照、後端權威；
 *                    memberId＝實際完攀者，家長代記錄時另存 recordedByMemberId 供稽核）
 *   routeTags       路線標記朋友（每筆一個 from→to 配對，供逐一通知與查詢「我被誰標記過」；家長代子女
 *                    發起標記時 fromMemberId＝子女、另存 taggedByMemberId 供稽核）
 *
 * 計分：分數 = 難度基本分 × 嘗試層級係數（四捨五入）。
 *   預設值寫死於 DEFAULT_SCORING，可由 systemSettings/routeScoring 覆寫（目前無 UI、走 API/資料設定）。
 *   points 為記錄當下快照——之後調整計分設定不追溯既有記錄（與全站 accrual 快照原則一致）。
 *
 * 記錄限制：完攀記錄——會員本人（或子會員，見下）、且「今日已於該路線所屬館別入場（未取消）」才能
 *   記錄/更改（DELETE 不限）。2026-09-01 拍板：讚/分享/tag朋友「不限入館時使用」，任何時候都可操作
 *   （跟完攀記錄的入館限制分開）。
 *
 * 家長代子會員操作（2026-09-02）：子會員無獨立登入（由家長用自己帳號代管），完攀記錄/排名/暱稱/tag
 *   皆支援家長代操作——各端點加 targetMemberId（ascents/member/ranking-settings）或 fromMemberId
 *   （tag）參數，未帶＝本人；共用 resolveActingMember() 驗證擁有權（本人或子會員，含共同家長
 *   coParentIds）＋抓取目標會員資料。⚠ 唯一例外＝「讚」（like）——刻意不支援代操作，讚是登入帳號
 *   本身對路線的收藏偏好、非特定完攀者的社交紀錄，一律算在 req.member.id 身上（見該端點註解）。
 *
 * 權限：
 *   路線編輯（POST/PUT/DELETE）＝管理員 / 場館電腦(operator·station) / 正職（比照 gyms.js requireAnnounceEditor）
 *   路線檢視（staff GET）＝任何登入員工；會員清單/排名/記錄＝會員 token。
 *
 * Tag 隱私：被標記人姓名對外顯示——有設定暱稱（members.nickname，2026-09-02 新增的一般會員資料
 *   欄位，也可在「個人資料」編輯）就直接顯示暱稱（自己選的公開稱呼、不需遮蔽）；沒設定則遮蔽本名
 *   中間字（見 maskName，如「王小明」→「王X明」，見 publicDisplayName）。tag 記錄是公開展示在路線
 *   頁面供大家看到「誰標記了誰」的社交功能，沒暱稱時不能完整曝光個資。
 *
 * ⚠ 路由順序：/scoring-config、/rankings、/member、/search-member 必須註冊在 /:id 之前（本專案踩過多次的參數路由雷）。
 * ⚠ routeAscents/routeTags 文件小（無簽名圖等大欄位），全集合掃描搭配 .select() 投影可接受；
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

// 難度基本分（2026-09-02 拉大級距）：原本 V0=100 每級線性 +100，同等級係數下「2 條簡單」
// 很容易追平甚至超過「1 條難一級」，稀釋了高難度的成就感。改為級距遞增、每級成長倍率皆 >2×，
// 使「同一嘗試層級」下 2×base(n) 恆小於 base(n+1)（即使簡單的用最佳倍率 flash 1.5、難的用最差
// 倍率 month 0.8 比，2×base(n)×1.5 對 base(n+1)×0.8 在 n=0~5 仍成立，n≥6 起差距更大更不成問題）。
const GRADE_BASE_POINTS = [100, 250, 600, 1500, 3500, 8000, 18000, 40000, 90000, 200000, 450000];
const DEFAULT_SCORING = {
  gradePoints: Object.fromEntries(GRADES.map((g, i) => [g, GRADE_BASE_POINTS[i]])),
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

// tag 顯示用姓名遮蔽——保留頭尾各一字，中間全部換成 X（如「王小明」→「王X明」、兩字名「王明」→「王X」、
// 單字/空字串原樣返回）。只用在 tag 相關的公開顯示（誰標記了誰），完攀排名/暱稱等既有顯示不受影響。
function maskName(name) {
  const s = String(name || '');
  const n = [...s]; // 用 code point 迭代避免把 emoji/組字字元切壞（姓名不太可能有，保險起見）
  if (n.length <= 1) return s;
  if (n.length === 2) return n[0] + 'X';
  return n[0] + 'X'.repeat(n.length - 2) + n[n.length - 1];
}
// 公開顯示名稱——會員自訂暱稱（2026-09-02 新增，會員資料的一般欄位，非路線專屬）是自己選擇要公開露出
// 的稱呼，直接顯示不需遮蔽；沒設定暱稱者一律回退顯示遮蔽後的本名（既有隱私預設不變）。
function publicDisplayName(name, nickname) {
  const n = String(nickname || '').trim();
  return n || maskName(name);
}

// 解析「為誰操作」（本人或子會員，含共同家長 coParentIds）——2026-09-02 新增，讓完攀記錄/排名/暱稱/
// tag 皆可由家長代子會員操作（子會員無獨立登入）。回傳 { ok:true, id, data } 或 { ok:false, status, body }。
// 未帶 targetMemberId 或帶自己 id → 直接用 req.member（已是新鮮讀出的完整資料，省一次查詢）；
// 帶子會員 id → 讀一次該子會員文件同時完成擁有權驗證＋資料抓取（不額外呼叫 utils/memberOwnership
// 的 checkMemberOwnership，避免驗證+抓資料各查一次 Firestore）。
async function resolveActingMember(db, member, targetMemberId) {
  const id = String(targetMemberId || '').trim() || member.id;
  if (id === member.id) return { ok: true, id, data: member };
  const doc = await db.collection('members').doc(id).get();
  if (!doc.exists) return { ok: false, status: 404, body: { error: 'MEMBER_NOT_FOUND', message: '查無此會員' } };
  const d = doc.data() || {};
  const isChild = d.parentMemberId === member.id || (Array.isArray(d.coParentIds) && d.coParentIds.includes(member.id));
  if (!isChild) return { ok: false, status: 403, body: { error: 'FORBIDDEN', message: '只能為自己或子會員操作' } };
  return { ok: true, id, data: d };
}
const TAG_LIMIT = 5; // 單次最多同時標記幾人，避免濫用洗版

// 未下架路線 id 集合——積分/排名只計 active 路線（2026-08-29 政策：下架＝換掉的線不再計分；
// 完攀記錄本身保留，重新上架即恢復計分）。路線集合小（數十~數百條），全掃投影可接受。
async function getActiveRouteIdSet(db) {
  const snap = await db.collection('climbingRoutes').select('status').get();
  const set = new Set();
  snap.docs.forEach(d => { if (d.data().status !== 'archived') set.add(d.id); });
  return set;
}

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
// gymId 不帶＝全館合併。只計「未下架路線」的成績；不參加排名（routeRankingOptOut）者不上榜、
// 本人仍可看到自己的積分（myStats）；顯示名＝會員自訂暱稱（一般會員資料欄位 nickname）優先、否則本名快照。
router.get('/rankings', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const { gymId, period } = req.query;
    const [snap, activeRoutes] = await Promise.all([
      db.collection('routeAscents')
        .select('routeId', 'memberId', 'memberName', 'gymId', 'points', 'recordedAt')
        .get(),
      getActiveRouteIdSet(db),
    ]);
    const monthStart = period === 'month' ? taiwanMonthStart() : null;
    const byMember = new Map();
    snap.docs.forEach(d => {
      const a = d.data();
      if (!activeRoutes.has(a.routeId)) return; // 下架/已刪路線不計分
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
    // join 會員排名設定（fieldMask 只抓兩欄，避免整份 member 文件流量）
    const ids = [...byMember.keys()].filter(Boolean);
    const settings = {};
    if (ids.length) {
      try {
        const docs = await db.getAll(...ids.map(id => db.collection('members').doc(id)), { fieldMask: ['routeRankingOptOut', 'nickname'] });
        docs.forEach(d => { if (d.exists) settings[d.id] = d.data() || {}; });
      } catch (e) { /* join 失敗不阻斷排名（全部視為參加、顯示本名） */ }
    }
    const all = [...byMember.values()].map(r => ({
      ...r,
      memberName: (settings[r.memberId]?.nickname || '').trim() || r.memberName,
      optOut: settings[r.memberId]?.routeRankingOptOut === true,
    }));
    const ranked = all.filter(r => !r.optOut).sort((x, y) => y.points - x.points || y.ascents - x.ascents);
    ranked.forEach((r, i) => { r.rank = i + 1; });
    // 2026-09-02：家長可查子女的排名（targetMemberId，未帶＝查自己）——子會員無獨立登入，
    // 完攀記錄本就可能是家長代為記錄在子女 memberId 下，排名頁需能切換檢視對象。
    let myId = req.member?.id || null;
    if (myId && req.query.targetMemberId) {
      const resolved = await resolveActingMember(db, req.member, req.query.targetMemberId);
      if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
      myId = resolved.id;
    }
    const mine = myId ? ranked.find(r => r.memberId === myId) || null : null;
    const myStatsRaw = myId ? all.find(r => r.memberId === myId) || null : null;
    const strip = ({ optOut, ...r }) => r;
    res.json({
      rankings: ranked.slice(0, 50).map(strip),
      total: ranked.length,
      myRank: mine ? strip(mine) : null,
      myOptedOut: !!(myStatsRaw && myStatsRaw.optOut),
      myStats: myStatsRaw ? { points: myStatsRaw.points, ascents: myStatsRaw.ascents } : null,
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET/PUT /climbing-routes/ranking-settings?targetMemberId=：會員排名偏好（參加與否）＋暱稱快速編輯 ──
// 2026-09-02 續：暱稱已升級為一般會員資料欄位（members.nickname，也可在「個人資料」編輯，見
// auth.js PUT /member/profile），這裡保留同一欄位的快速編輯入口（不用離開路線頁），寫入的是
// 同一份資料、非另一個獨立欄位——兩處編輯完全同步，無資料分歧風險。
// targetMemberId（選填，未帶＝本人）：家長可代子會員設定暱稱／參加排名與否（子會員無獨立登入）。
router.get('/ranking-settings', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const resolved = await resolveActingMember(db, req.member, req.query.targetMemberId);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
    res.json({ optOut: resolved.data.routeRankingOptOut === true, nickname: resolved.data.nickname || '', targetMemberId: resolved.id });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
router.put('/ranking-settings', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const resolved = await resolveActingMember(db, req.member, req.body.targetMemberId);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
    const updates = { updatedAt: new Date() };
    if (req.body.optOut !== undefined) updates.routeRankingOptOut = req.body.optOut === true;
    if (req.body.nickname !== undefined) {
      const nick = String(req.body.nickname || '').trim();
      if ([...nick].length > 10) return res.status(400).json({ error: 'NICKNAME_TOO_LONG', message: '暱稱最多 10 個字' });
      updates.nickname = nick || null;
    }
    await db.collection('members').doc(resolved.id).update(updates);
    res.json({
      success: true,
      targetMemberId: resolved.id,
      optOut: updates.routeRankingOptOut !== undefined ? updates.routeRankingOptOut : (resolved.data.routeRankingOptOut === true),
      nickname: updates.nickname !== undefined ? (updates.nickname || '') : (resolved.data.nickname || ''),
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /climbing-routes/member?gymId=&targetMemberId=：會員端路線清單（active）＋我的記錄＋今日入場狀態 ──
// targetMemberId（選填，未帶＝本人）：家長可切換檢視子會員的完攀記錄/積分/入場狀態（子會員無獨立
// 登入，記錄完攀本就可能是家長代為記錄在子女 memberId 下）。「讚」不隨此切換——讚是登入帳號本身
// 對路線的收藏偏好，不是特定完攀者的社交紀錄，一律用 req.member.id（見 like 端點註解）。
router.get('/member', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.query.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const resolved = await resolveActingMember(db, req.member, req.query.targetMemberId);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
    const targetId = resolved.id;
    const cfg = await getScoringConfig(db);
    const [routesSnap, mySnap, checkedIn, tagsSnap] = await Promise.all([
      db.collection('climbingRoutes').where('gymId', '==', gymId).get(),
      db.collection('routeAscents').where('memberId', '==', targetId).get(),
      checkedInTodayAt(db, targetId, gymId),
      // 該館所有路線的標記記錄一次撈完（避免逐條路線各查一次 /tags 的 N+1）；有暱稱顯示暱稱、否則遮蔽本名
      db.collection('routeTags').where('gymId', '==', gymId)
        .select('routeId', 'fromMemberName', 'fromMemberNickname', 'taggedMemberName', 'taggedMemberNickname').get(),
    ]);
    const tagsByRoute = {};
    tagsSnap.docs.forEach(d => {
      const t = d.data();
      if (!tagsByRoute[t.routeId]) tagsByRoute[t.routeId] = [];
      tagsByRoute[t.routeId].push({
        from: publicDisplayName(t.fromMemberName, t.fromMemberNickname),
        tagged: publicDisplayName(t.taggedMemberName, t.taggedMemberNickname),
      });
    });
    const routes = routesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r.status !== 'archived')
      .map(r => {
        const likes = r.likes || {};
        const { likes: _drop, ...rest } = r; // 不把完整 likes map（含所有按讚者 memberId）回傳給前端，只給統計值
        return {
          ...rest,
          basePoints: Number(cfg.gradePoints[r.grade]) || 0,
          likeCount: Object.keys(likes).length,
          liked: likes[req.member.id] === true,
          tags: tagsByRoute[r.id] || [],
        };
      })
      .sort((a, b) => (a.area || '').localeCompare(b.area || '', 'zh-Hant') || GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade));
    // 只計「未下架路線」的積分（2026-08-29 政策）；myAscents map 仍全量供個別路線顯示
    const activeRoutes = await getActiveRouteIdSet(db);
    const myAscents = {};
    const totals = { all: { points: 0, ascents: 0 }, byGym: {} };
    mySnap.docs.forEach(d => {
      const a = d.data();
      myAscents[a.routeId] = { tier: a.tier, points: a.points, recordedAt: a.recordedAt };
      if (!activeRoutes.has(a.routeId)) return;
      const pts = Number(a.points) || 0;
      totals.all.points += pts; totals.all.ascents += 1;
      const g = a.gymId || 'unknown';
      if (!totals.byGym[g]) totals.byGym[g] = { points: 0, ascents: 0 };
      totals.byGym[g].points += pts; totals.byGym[g].ascents += 1;
    });
    res.json({
      routes, myAscents,
      myTotals: totals, // { all, byGym }——僅計未下架路線（分館＋合併）
      checkedInToday: checkedIn,
      tiers: TIERS.map(t => ({ key: t.key, label: t.label, multiplier: Number(cfg.tierMultipliers[t.key]) || t.multiplier })),
      targetMemberId: targetId,
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /climbing-routes/search-member?phone=&name=&excludeMemberId=：搜尋會員供 tag 朋友用（authenticateMember）──
// 安全考量（避免被拿來枚舉他人個資）：phone 需 >=7 碼精確比對；name 需完全比對（不做模糊/前綴搜尋）。
// 回傳完整姓名/電話給「發起 tag 的人」自行核對是不是認識的那位——這裡不遮蔽，遮蔽只用在事後公開顯示
// tag 記錄時（見 maskName）。排除會員自己、上限 10 筆。
// excludeMemberId（選填）：家長代子女發起標記時，前端會帶目前操作對象的 id 一併排除（不讓子女出現
// 在自己的搜尋結果裡）——單純過濾用途、不需驗證擁有權（只會讓結果變少，不會多曝光任何資料）。
// 2026-09-05：name 參數同時精確比對「本名」與「暱稱」兩個欄位（前端無法區分使用者打的是本名還是
// 暱稱，故兩個欄位都查、依 doc id 去重合併）——暱稱本就是會員自己選的公開稱呼、非隱私欄位，用同一套
// 「完全比對、不做模糊/前綴」的安全規則即可，不需要額外的長度門檻（跟 name 一致）。
router.get('/search-member', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const phone = String(req.query.phone || '').trim();
    const name = String(req.query.name || '').trim();
    const excludeId = String(req.query.excludeMemberId || '').trim();
    if (!phone && !name) return res.status(400).json({ error: 'MISSING_QUERY', message: '請輸入電話、姓名或暱稱' });
    if (phone && phone.length < 7) return res.status(400).json({ error: 'PHONE_TOO_SHORT', message: '電話請輸入至少 7 碼' });
    let docs = [];
    if (phone) {
      const snap = await db.collection('members').where('phone', '==', phone).limit(10).get();
      docs = snap.docs;
    } else {
      const [nameSnap, nickSnap] = await Promise.all([
        db.collection('members').where('name', '==', name).limit(10).get(),
        db.collection('members').where('nickname', '==', name).limit(10).get(),
      ]);
      const seen = new Map();
      [...nameSnap.docs, ...nickSnap.docs].forEach(d => { if (!seen.has(d.id)) seen.set(d.id, d); });
      docs = [...seen.values()].slice(0, 10);
    }
    const results = docs
      .filter(d => d.id !== req.member.id && d.id !== excludeId)
      .map(d => ({ id: d.id, name: d.data().name || '', phone: d.data().phone || '', nickname: d.data().nickname || '' }));
    res.json({ results });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /climbing-routes?gymId=&includeArchived=1：員工路線清單（含完攀人數統計＋按讚總數）──
// 2026-09-02 修：原本直接把 likes（{memberId:true,...} 誰按過讚的完整清單）整包 spread 進回應，
// 比會員端 /member（早就拿掉這欄位、只給統計值）晚了一步——雖然畫面沒顯示，但任何登入員工開
// 瀏覽器開發者工具都看得到完整按讚者名單，非設計本意，改成只給彙總後的 likeCount。
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
    const routes = snap.docs.map(d => {
      const r = d.data();
      const { likes, ...rest } = r; // 不把完整 likes map（含所有按讚者 memberId）回傳給員工端，比照會員端 /member 的既有做法
      return { id: d.id, ...rest, likeCount: Object.keys(likes || {}).length, ascentCount: countByRoute[d.id] || 0 };
    })
      .filter(r => includeArchived ? true : r.status !== 'archived')
      .sort((a, b) => (a.area || '').localeCompare(b.area || '', 'zh-Hant') || GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade));
    res.json({ routes });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /climbing-routes：新增路線（支援批次）──
// 單條：{gymId, area, color, grade, ...}（向下相容）
// 批次：{gymId, area, setter, igUrl, setAt, plannedRemoveAt, routes:[{color,grade,name?,note?}]}
//   → 同一支 IG 影片對應多條路線的情境：共用欄位填一次、一次建 N 條（上限 20）。
//   備註 note 跟「每條路線」走（會員可見）；plannedRemoveAt 預計下架日＝共用（純提示、不自動下架）。
router.post('/', authenticate, routeEditorGate,
  [
    body('gymId').notEmpty(),
    body('area').trim().notEmpty().withMessage('請填寫牆面/區域'),
  ], validate,
  async (req, res) => {
    try {
      const db = getDb();
      // 非 super_admin 只能建自己館別的路線（比照公告館別隔離）
      if (req.staff.role !== 'super_admin' && req.staff.gymId && req.body.gymId !== req.staff.gymId) {
        return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '只能管理自己館別的路線' });
      }
      const items = Array.isArray(req.body.routes) && req.body.routes.length
        ? req.body.routes
        : [{ color: req.body.color, grade: req.body.grade, name: req.body.name, note: req.body.note }];
      if (items.length > 20) return res.status(400).json({ error: 'TOO_MANY_ROUTES', message: '一次最多建立 20 條路線' });
      for (const it of items) {
        if (!GRADES.includes(it.grade)) return res.status(400).json({ error: 'INVALID_GRADE', message: '難度須為 V0~V10' });
        if (!String(it.color || '').trim()) return res.status(400).json({ error: 'MISSING_COLOR', message: '每條路線請填寫岩點顏色' });
      }
      const now = new Date();
      const sharedNote = String(req.body.note || '').trim(); // 批次共用備註（會員可見）；每條可各自覆寫
      const batch = db.batch();
      const created = items.map(it => {
        const id = uuidv4();
        const route = {
          gymId: req.body.gymId,
          area: String(req.body.area).trim(),
          color: String(it.color).trim(),
          grade: it.grade,
          name: String(it.name || '').trim(),
          note: String(it.note !== undefined ? it.note : sharedNote).trim(),
          setter: String(req.body.setter || '').trim(),
          igUrl: String(req.body.igUrl || '').trim(),
          setAt: req.body.setAt || taiwanToday(),
          plannedRemoveAt: String(req.body.plannedRemoveAt || '').trim(),
          status: 'active',
          createdAt: now, createdBy: req.staff.id, createdByName: req.staff.name || '', updatedAt: now,
        };
        batch.set(db.collection('climbingRoutes').doc(id), route);
        return { id, ...route };
      });
      await batch.commit();
      res.status(201).json({ success: true, route: created[0], routes: created });
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
    const allowed = ['area', 'color', 'grade', 'name', 'note', 'setter', 'igUrl', 'setAt', 'plannedRemoveAt', 'status'];
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

// ── POST /climbing-routes/bulk-delete：批次刪除（路線管理整區/選取部分路線一起刪除）──
// 逐筆比照單筆刪除規則（跨館擋、已有完攀記錄擋），回傳成功/略過清單供前端顯示結果摘要；
// 略過的路線不影響其餘路線刪除（部分成功也算 200，細節看 skipped 陣列）。
router.post('/bulk-delete', authenticate, routeEditorGate,
  [body('ids').isArray({ min: 1 }).withMessage('請至少選擇一條路線')],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const ids = [...new Set(req.body.ids)].slice(0, 200); // 上限防呆，避免單次刪除過量
      const deleted = [];
      const skipped = [];
      for (const id of ids) {
        const ref = db.collection('climbingRoutes').doc(id);
        const doc = await ref.get();
        if (!doc.exists) { skipped.push({ id, reason: 'NOT_FOUND' }); continue; }
        const r = doc.data();
        if (req.staff.role !== 'super_admin' && req.staff.gymId && r.gymId !== req.staff.gymId) {
          skipped.push({ id, reason: 'CROSS_GYM_FORBIDDEN', area: r.area, color: r.color, grade: r.grade });
          continue;
        }
        const cnt = await db.collection('routeAscents').where('routeId', '==', id).count().get();
        if (cnt.data().count > 0) {
          skipped.push({ id, reason: 'ROUTE_HAS_ASCENTS', area: r.area, color: r.color, grade: r.grade });
          continue;
        }
        await ref.delete();
        deleted.push(id);
      }
      res.json({ success: true, deletedCount: deleted.length, deleted, skipped });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /climbing-routes/:id/ascents：會員記錄完攀（今日於該館入場才可；重複記錄＝更新層級）──
// targetMemberId（選填，未帶＝本人）：家長可代子會員記錄（子會員無獨立登入、入場檢查看子女自己
// 今日是否有入場，非家長）；代記錄時另存 recordedByMemberId 供稽核（比照體驗預約 bookedByMemberId）。
router.post('/:id/ascents', authenticateMember,
  [body('tier').isIn(TIER_KEYS).withMessage('無效的嘗試層級')], validate,
  async (req, res) => {
    try {
      const db = getDb();
      const routeDoc = await db.collection('climbingRoutes').doc(req.params.id).get();
      if (!routeDoc.exists) return res.status(404).json({ error: 'ROUTE_NOT_FOUND', message: '路線不存在' });
      const route = routeDoc.data();
      if (route.status === 'archived') return res.status(400).json({ error: 'ROUTE_ARCHIVED', message: '此路線已下架，無法記錄' });
      const resolved = await resolveActingMember(db, req.member, req.body.targetMemberId);
      if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
      const target = resolved.data;
      const ok = await checkedInTodayAt(db, resolved.id, route.gymId);
      if (!ok) return res.status(403).json({ error: 'NOT_CHECKED_IN', message: '需於入場當日才能記錄完攀（請先於該館完成入場）' });
      const cfg = await getScoringConfig(db);
      const points = computePoints(cfg, route.grade, req.body.tier);
      if (!points) return res.status(400).json({ error: 'INVALID_SCORING', message: '無法計算分數' });
      const docId = `${req.params.id}_${resolved.id}`; // 天然去重：一人一路線一筆
      const now = new Date();
      const ascent = {
        routeId: req.params.id, memberId: resolved.id, memberName: target.name || '',
        gymId: route.gymId, grade: route.grade, tier: req.body.tier, points,
        recordedAt: now, updatedAt: now,
      };
      if (resolved.id !== req.member.id) ascent.recordedByMemberId = req.member.id; // 家長代子女記錄留稽核
      await db.collection('routeAscents').doc(docId).set(ascent); // 已存在＝整筆覆寫（更新層級/分數）
      res.status(201).json({ success: true, ascent });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── DELETE /climbing-routes/:id/ascents?targetMemberId=：刪除完攀記錄（不限入場當日，供修正誤記）──
router.delete('/:id/ascents', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const resolved = await resolveActingMember(db, req.member, req.query.targetMemberId);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
    const ref = db.collection('routeAscents').doc(`${req.params.id}_${resolved.id}`);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'ASCENT_NOT_FOUND', message: '無此完攀記錄' });
    await ref.delete();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /climbing-routes/:id/like：按讚 toggle（不限入館，任何時候都可操作）──
// 內嵌於路線文件的 likes map（非獨立集合）——路線數量規模小，讀清單時單一查詢即可帶出讚數與「我是否已讚」，
// 不需要額外聚合查詢。
// ⚠ 刻意不支援 targetMemberId（不像 ascents/tag/ranking-settings 可代子會員操作）——讚是登入帳號本身
// 對路線的收藏偏好，不是特定完攀者的社交紀錄，一律算在 req.member.id（登入者本人）身上。
router.post('/:id/like', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('climbingRoutes').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'ROUTE_NOT_FOUND', message: '路線不存在' });
    const likes = doc.data().likes || {};
    const already = likes[req.member.id] === true;
    const admin = require('firebase-admin');
    await ref.update({ [`likes.${req.member.id}`]: already ? admin.firestore.FieldValue.delete() : true, updatedAt: new Date() });
    const newLikes = { ...likes };
    if (already) delete newLikes[req.member.id]; else newLikes[req.member.id] = true;
    res.json({ success: true, liked: !already, likeCount: Object.keys(newLikes).length });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /climbing-routes/:id/tag：標記朋友（不限入館）；建立 routeTags 記錄＋發送首頁提醒卡通知被標記者 ──
// fromMemberId（選填，未帶＝本人）：家長可代子女發起標記（例如小孩跟朋友一起完攀，由家長操作 App
// 標記對方）——公開顯示的「誰標記了誰」用子女自己的姓名/暱稱，非家長。
router.post('/:id/tag',
  authenticateMember,
  [body('taggedMemberIds').isArray({ min: 1, max: TAG_LIMIT }).withMessage(`請選擇 1~${TAG_LIMIT} 位朋友`)],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const routeDoc = await db.collection('climbingRoutes').doc(req.params.id).get();
      if (!routeDoc.exists) return res.status(404).json({ error: 'ROUTE_NOT_FOUND', message: '路線不存在' });
      const route = routeDoc.data();
      const resolved = await resolveActingMember(db, req.member, req.body.fromMemberId);
      if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
      const fromMember = resolved.data;
      const targetIds = [...new Set(req.body.taggedMemberIds)].filter(id => id && id !== resolved.id);
      if (!targetIds.length) return res.status(400).json({ error: 'NO_VALID_TARGET', message: '沒有可標記的對象' });
      const memberDocs = await db.getAll(...targetIds.map(id => db.collection('members').doc(id)), { fieldMask: ['name', 'nickname'] });
      const found = memberDocs.filter(d => d.exists);
      if (!found.length) return res.status(404).json({ error: 'MEMBERS_NOT_FOUND', message: '找不到指定的會員' });
      const now = new Date();
      const batch = db.batch();
      const created = found.map(d => {
        const id = uuidv4();
        const taggedName = d.data().name || '';
        const taggedNickname = d.data().nickname || '';
        const rec = {
          id, routeId: req.params.id, routeName: `${route.area || ''} ${route.color || ''} ${route.grade || ''}`.trim(),
          gymId: route.gymId,
          fromMemberId: resolved.id, fromMemberName: fromMember.name || '', fromMemberNickname: fromMember.nickname || '',
          taggedMemberId: d.id, taggedMemberName: taggedName, taggedMemberNickname: taggedNickname,
          createdAt: now,
        };
        if (resolved.id !== req.member.id) rec.taggedByMemberId = req.member.id; // 家長代子女標記留稽核
        batch.set(db.collection('routeTags').doc(id), rec);
        return rec;
      });
      await batch.commit();
      // 通知被標記者（首頁提醒卡，沿用既有機制；失敗不阻斷 tag 本身）
      try {
        const memberReminderService = require('../services/memberReminderService');
        await Promise.all(created.map(t => memberReminderService.createReminder({
          memberId: t.taggedMemberId,
          title: `${publicDisplayName(t.fromMemberName, t.fromMemberNickname)} 在路線上標記了你！`,
          subtitle: t.routeName || '快去看看是哪條路線～',
          icon: '🏷️',
          link: `/member/routes?route=${req.params.id}`,
        })));
      } catch (e) { console.error('[路線tag] 通知發送失敗', e.message); }
      res.status(201).json({ success: true, tagged: created.map(t => publicDisplayName(t.taggedMemberName, t.taggedMemberNickname)) });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── GET /climbing-routes/:id/tags：列出該路線的標記記錄（供公開顯示；有暱稱顯示暱稱，否則遮蔽本名）──
router.get('/:id/tags', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('routeTags').where('routeId', '==', req.params.id)
      .select('fromMemberName', 'fromMemberNickname', 'taggedMemberName', 'taggedMemberNickname', 'createdAt').get();
    const tags = snap.docs
      .map(d => d.data())
      .map(t => ({
        from: publicDisplayName(t.fromMemberName, t.fromMemberNickname),
        tagged: publicDisplayName(t.taggedMemberName, t.taggedMemberNickname),
        createdAt: t.createdAt,
      }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json({ tags });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
