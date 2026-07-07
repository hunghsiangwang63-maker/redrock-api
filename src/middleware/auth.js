const jwt = require('jsonwebtoken');
const { getDb, COLLECTIONS } = require('../config/firebase');

// 權限矩陣＝「個人帳號(type:'staff')登入」的能力。
// 值班 operator 另享「櫃檯權限」(COUNTER_PERMS，見下)一律放行，不受此矩陣 full/part 收窄影響。
// 分工：part_time 個人＝排班/課程檢視；full_time 個人＝＋課程/比賽設定、庫存(products/inventory)。
// 櫃檯類（入場/會員/發券/POS/點名/記帳/分期收款/續約/報名經手…）在此對 full/part 設 false，改由 operator 值班或管理員做。
const DEFAULT_PERMISSIONS = {
  'members.create':        { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'members.read':          { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'members.update':        { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'members.delete':        { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'members.read_all_gyms': { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'waiver.sign':           { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'waiver.send_parent':    { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'checkin.create':        { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'checkin.read':          { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'checkin.read_all_gyms': { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'passes.create':         { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'installments.manage':   { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'passes.update':         { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'passes.delete':         { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'passes.approve':        { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'vip.manage':            { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'pass_types.manage':     { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  // ── full_time 個人辦公權限 ──
  'courses.view':          { super_admin: true, gym_manager: true, full_time: true,  part_time: true  }, // 課程月曆檢視（part 也可）
  'courses.manage':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'courses.create':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'courses.update':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'courses.delete':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'courses.notify':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'competitions.manage':   { super_admin: true, gym_manager: true, full_time: true,  part_time: false }, // 比賽設定（full 新增）
  'competitions.sync':     { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'products.manage':       { super_admin: true, gym_manager: true, full_time: true,  part_time: false }, // 完整商品/庫存（含清點/進貨/CRUD）
  'inventory.manage':      { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'products.warehouse':    { super_admin: true, gym_manager: false, full_time: false, part_time: false },
  // ── 排班檢視（part/full 皆可）──
  'schedule.read':         { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'schedule.manage':       { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  // ── 櫃檯類（full/part 個人不可；operator 值班或管理員做）──
  'courses.attendance':    { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'products.sell':         { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'revenue.record':        { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'competitions.entries':  { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  // ── 純管理員（super/gym_manager）──
  'revenue.report':        { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'revenue.report_all':    { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'notifications.send_gym':  { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'notifications.send_all':  { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'gyms.manage':           { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'permissions.manage':    { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'settings.manage':       { super_admin: true, gym_manager: false, full_time: false, part_time: false },
  'staff.manage':          { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'devices.manage':        { super_admin: true, gym_manager: false,full_time: false, part_time: false },
};

// 「櫃檯權限」：值班 operator（打卡上班）一律放行，不受個人角色矩陣收窄影響。
// 個人 staff 登入（未值班）仍依上方矩陣 → full/part 皆 false → 擋。管理員(super/gym_manager)本就放行。
const COUNTER_PERMS = new Set([
  'members.create', 'members.read', 'members.update',
  'waiver.sign', 'waiver.send_parent',
  'checkin.create', 'checkin.read',
  'passes.create', 'passes.update', 'installments.manage',
  'courses.attendance', 'products.sell', 'revenue.record', 'competitions.entries',
]);

// ── Staff token 驗證 ─────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '請先登入' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDb();
    const staffDoc = await db.collection(COLLECTIONS.STAFF).doc(decoded.staffId).get();
    if (!staffDoc.exists || !staffDoc.data().isActive) {
      return res.status(401).json({ error: 'STAFF_INACTIVE', message: '帳號已停用' });
    }
    req.staff = { id: decoded.staffId, gymId: decoded.gymId, role: decoded.role, ...staffDoc.data(), type: decoded.type || 'staff', stationId: decoded.stationId || null };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'TOKEN_EXPIRED', message: '登入已過期，請重新登入' });
    }
    return res.status(401).json({ error: 'INVALID_TOKEN', message: '無效的驗證資訊' });
  }
};

// ── 限制只能透過館別電腦值班(operator) token 使用，個人帳號登入不可用 ──
const requireStationAuth = (req, res, next) => {
  // 站台 operator（已打卡值班），或系統管理員 super_admin 遠端操作（自選館別、不需在本館電腦）皆可
  if (req.staff?.type === 'operator' || req.staff?.role === 'super_admin') {
    return next();
  }
  return res.status(403).json({
    error: 'STATION_REQUIRED',
    message: '此功能僅限館別電腦登入並打卡值班後使用，請改用館別電腦帳號登入',
  });
};

// ── 館別電腦驗證：接受 station（電腦登入）或 operator（已打卡值班）token ──
// 用於打卡前後都需可呼叫的 shift 端點，避免無認證被任意人查詢/交班
const authenticateStation = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '請先登入' });
    }
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.type !== 'station' && decoded.type !== 'operator') {
      return res.status(403).json({ error: 'STATION_REQUIRED', message: '此功能僅限館別電腦使用' });
    }
    req.station = { stationId: decoded.stationId || null, gymId: decoded.gymId || null, type: decoded.type };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'TOKEN_EXPIRED', message: '登入已過期，請重新登入' });
    }
    return res.status(401).json({ error: 'INVALID_TOKEN', message: '無效的驗證資訊' });
  }
};

// ── Member token 驗證 ────────────────────────────────────────────
const authenticateMember = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '請先登入' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'member') {
      return res.status(403).json({ error: 'FORBIDDEN', message: '權限不足' });
    }
    const db = getDb();
    const memberDoc = await db.collection(COLLECTIONS.MEMBERS).doc(decoded.memberId).get();
    if (!memberDoc.exists) {
      return res.status(401).json({ error: 'MEMBER_NOT_FOUND' });
    }
    req.member = { id: decoded.memberId, ...memberDoc.data() };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'INVALID_TOKEN' });
  }
};

// ── Staff 或 Member 皆可（會員端入場流程用）─────────────────────
const authenticateAny = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '請先登入' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDb();

    if (decoded.type === 'member') {
      const memberDoc = await db.collection(COLLECTIONS.MEMBERS).doc(decoded.memberId).get();
      if (!memberDoc.exists) return res.status(401).json({ error: 'MEMBER_NOT_FOUND' });
      req.member = { id: decoded.memberId, ...memberDoc.data() };
    } else if (decoded.staffId) {
      const staffDoc = await db.collection(COLLECTIONS.STAFF).doc(decoded.staffId).get();
      if (!staffDoc.exists || !staffDoc.data().isActive) {
        return res.status(401).json({ error: 'STAFF_INACTIVE' });
      }
      req.staff = { id: decoded.staffId, gymId: decoded.gymId, role: decoded.role, ...staffDoc.data() };
    } else {
      return res.status(401).json({ error: 'INVALID_TOKEN' });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'INVALID_TOKEN' });
  }
};

const checkPermission = (permKey) => {
  return async (req, res, next) => {
    try {
      const { role, gymId, type } = req.staff;
      if (role === 'super_admin') return next();
      // 值班 operator：櫃檯權限一律放行（個人 staff 登入未值班則依矩陣，full/part 已收窄為 false）
      if (type === 'operator' && COUNTER_PERMS.has(permKey)) return next();
      const permDef = DEFAULT_PERMISSIONS[permKey];
      if (!permDef) return res.status(403).json({ error: 'UNKNOWN_PERMISSION', permission: permKey });
      let hasPermission = permDef[role] ?? false;
      const db = getDb();
      const overrideDoc = await db.collection(COLLECTIONS.PERMISSION_OVERRIDES)
        .doc(`${gymId}_${role}_${permKey}`).get();
      if (overrideDoc.exists) hasPermission = overrideDoc.data().allowed;
      if (!hasPermission) {
        return res.status(403).json({ error: 'FORBIDDEN', message: '您沒有執行此操作的權限', permission: permKey, role });
      }
      next();
    } catch (err) { next(err); }
  };
};

const requireSameGym = (gymIdParam = 'gymId') => {
  return (req, res, next) => {
    const { role, gymId } = req.staff;
    if (role === 'super_admin') return next();
    const targetGymId = req.params[gymIdParam] || req.body[gymIdParam] || req.query[gymIdParam];
    if (targetGymId && targetGymId !== gymId) {
      return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '只能操作本館資料' });
    }
    next();
  };
};

const auditLog = (action) => {
  return async (req, res, next) => {
    const original = res.json.bind(res);
    res.json = async (data) => {
      if (res.statusCode < 400 && req.method !== 'GET') {
        try {
          const db = getDb();
          await db.collection(COLLECTIONS.AUDIT_LOG).add({
            action, staffId: req.staff?.id, staffName: req.staff?.name,
            gymId: req.staff?.gymId, method: req.method, path: req.path,
            body: req.body, statusCode: res.statusCode, timestamp: new Date(),
          });
        } catch (e) { console.error('Audit log error:', e); }
      }
      return original(data);
    };
    next();
  };
};

// ── 限制僅管理員(super_admin/gym_manager)或館別電腦值班(operator)可用 ──
// 一般員工個人帳號登入(type==='staff')即使有對應permission key也會被擋下
// 註：純station token(僅stationId無staffId)無法通過上層authenticate查到staff文件，
//     必須先打卡值班轉換成operator身份才能呼叫此類API，故此處同時保留station判斷為防禦性寫法
const requireManagerOrStation = (req, res, next) => {
  const isManager = ['super_admin', 'gym_manager'].includes(req.staff?.role);
  const isStationMode = ['operator', 'station'].includes(req.staff?.type);
  if (!isManager && !isStationMode) {
    return res.status(403).json({
      error: 'MANAGER_OR_STATION_REQUIRED',
      message: '此功能僅限管理員或館別電腦登入使用',
    });
  }
  next();
};

// ── 限制僅管理員(super_admin/gym_manager)可用 ──
// 與 requireManagerOrStation 不同：operator/station 值班身份、full_time/part_time 個人帳號皆擋下，
// 只認角色。gym_manager 即使在 operator 值班模式(type==='operator')也放行（其 role 仍為 gym_manager）。
const requireManager = (req, res, next) => {
  if (['super_admin', 'gym_manager'].includes(req.staff?.role)) return next();
  return res.status(403).json({
    error: 'MANAGER_REQUIRED',
    message: '此功能僅限管理員（館別管理員或系統管理員）使用',
  });
};

module.exports = {
  authenticate, authenticateMember, authenticateAny,
  checkPermission, requireSameGym, auditLog, requireStationAuth, authenticateStation, requireManagerOrStation, requireManager, DEFAULT_PERMISSIONS,
};
