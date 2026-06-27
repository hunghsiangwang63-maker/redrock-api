const jwt = require('jsonwebtoken');
const { getDb, COLLECTIONS } = require('../config/firebase');

const DEFAULT_PERMISSIONS = {
  'members.create':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'members.read':          { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'members.update':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'members.delete':        { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'members.read_all_gyms': { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'waiver.sign':           { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'waiver.send_parent':    { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'checkin.create':        { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'checkin.read':          { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'checkin.read_all_gyms': { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'passes.create':         { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'installments.manage':   { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'competitions.manage':   { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'passes.update':         { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'passes.delete':         { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'passes.approve':        { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'vip.manage':            { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'pass_types.manage':     { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'courses.manage':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'products.manage':       { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'products.warehouse':    { super_admin: true, gym_manager: false, full_time: false, part_time: false },
  'settings.manage':       { super_admin: true, gym_manager: false, full_time: false, part_time: false },
  'courses.create':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'courses.update':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'courses.delete':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'courses.attendance':    { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'courses.notify':        { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'products.sell':         { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'inventory.manage':      { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'revenue.record':        { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'schedule.manage':       { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'schedule.read':         { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'revenue.report':        { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'revenue.report_all':    { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'notifications.send_gym':  { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'notifications.send_all':  { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'gyms.manage':           { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'staff.manage':          { super_admin: true, gym_manager: false, full_time: false, part_time: false },
  'permissions.manage':    { super_admin: true, gym_manager: false,full_time: false, part_time: false },
  'competitions.manage':   { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'competitions.entries':  { super_admin: true, gym_manager: true, full_time: true,  part_time: true  },
  'competitions.sync':     { super_admin: true, gym_manager: true, full_time: true,  part_time: false },
  'staff.manage':          { super_admin: true, gym_manager: true, full_time: false, part_time: false },
  'devices.manage':        { super_admin: true, gym_manager: false,full_time: false, part_time: false },
};

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
  if (req.staff?.type !== 'operator') {
    return res.status(403).json({
      error: 'STATION_REQUIRED',
      message: '此功能僅限館別電腦登入並打卡值班後使用，請改用館別電腦帳號登入',
    });
  }
  next();
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
      const { role, gymId } = req.staff;
      if (role === 'super_admin') return next();
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

module.exports = {
  authenticate, authenticateMember, authenticateAny,
  checkPermission, requireSameGym, auditLog, requireStationAuth, requireManagerOrStation, DEFAULT_PERMISSIONS,
};
