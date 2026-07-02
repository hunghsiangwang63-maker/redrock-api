/**
 * 館別電腦帳號 & 值班打卡
 * POST /stations/login          電腦帳號登入（長期 session）
 * POST /stations/shift/clockin  值班打卡（email+password）
 * POST /stations/shift/clockout 交班（記錄備註）
 * GET  /stations/shift/current  取得目前值班人員
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');
const { authenticate, authenticateStation } = require('../middleware/auth');

// 僅系統管理員可管理館別電腦帳號
const requireSuperAdmin = (req, res, next) => {
  if (req.staff?.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN', message: '僅系統管理員可管理館別電腦帳號' });
  next();
};

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

const signToken = (payload, expiresIn) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: expiresIn || '30d' });

// ── POST /stations/login - 電腦帳號登入 ─────────────────────────
// 產生長期 token（30天），存在電腦瀏覽器 localStorage
router.post('/login',
  [
    body('email').isEmail().withMessage('請輸入有效的 Email'),
    body('password').notEmpty().withMessage('請輸入密碼'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { email, password } = req.body;

      const snap = await db.collection('stations').where('email', '==', email).limit(1).get();
      if (snap.empty) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' });

      const doc = snap.docs[0];
      const station = doc.data();

      if (!station.isActive) return res.status(401).json({ error: 'STATION_INACTIVE', message: '此電腦帳號已停用' });

      // 逐帳號登入鎖定（放寬門檻，見 utils/loginLock）
      const loginLock = require('../utils/loginLock');
      const lock = loginLock.checkLocked(station);
      if (lock.locked) return res.status(429).json({ error: 'ACCOUNT_LOCKED', message: `密碼錯誤次數過多，帳號已鎖定，請 ${lock.mins} 分鐘後再試` });

      const valid = await bcrypt.compare(password, station.passwordHash);
      if (!valid) {
        const r = await loginLock.registerFail('stations', doc.id, station);
        if (r.locked) return res.status(429).json({ error: 'ACCOUNT_LOCKED', message: `密碼錯誤次數過多，帳號鎖定 ${r.mins} 分鐘` });
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: `帳號或密碼錯誤（剩餘 ${r.remaining} 次）` });
      }
      await loginLock.clearFail('stations', doc.id);

      // 裝置綁定檢查（可經 systemSettings/security.deviceBindingEnabled 暫時停用）
      const deviceAuthService = require('../services/deviceAuthService');
      if (await deviceAuthService.isDeviceBindingEnabled()) {
        const trusted = await deviceAuthService.isDeviceTrusted('station', doc.id, req.body.deviceToken);
        if (!trusted) {
          const { verificationId } = await deviceAuthService.createDeviceVerification({
            accountType: 'station', accountId: doc.id,
            accountName: station.name, accountEmail: station.notificationEmail || station.email,
            deviceToken: req.body.deviceToken,
            deviceLabel: req.headers['user-agent'] || '',
          });
          return res.status(403).json({
            error: 'DEVICE_VERIFICATION_REQUIRED',
            verificationId,
            message: '此電腦尚未授權，已發送驗證碼至館別電腦Email，或請聯絡管理員審核此裝置',
          });
        }
      }

      await doc.ref.update({ lastLoginAt: new Date() });

      const token = signToken({
        stationId: doc.id,
        gymId: station.gymId,
        gymName: station.gymName,
        type: 'station',
      }, '30d');

      res.json({
        token,
        station: {
          id: doc.id,
          name: station.name,
          gymId: station.gymId,
          gymName: station.gymName,
        },
        message: '電腦帳號登入成功',
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /stations/shift/clockin - 值班打卡 ──────────────────────
router.post('/shift/clockin',
  [
    body('email').isEmail().withMessage('請輸入 Email'),
    body('password').notEmpty().withMessage('請輸入密碼'),
    body('stationId').notEmpty().withMessage('缺少電腦站 ID'),
    body('gymId').notEmpty().withMessage('缺少館別'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { email, password, stationId, gymId } = req.body;

      // 驗證 staff 帳號
      const staffSnap = await db.collection('staff').where('email', '==', email).limit(1).get();
      if (staffSnap.empty) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' });

      const staffDoc = staffSnap.docs[0];
      const staff = staffDoc.data();

      if (!staff.isActive) return res.status(401).json({ error: 'STAFF_INACTIVE', message: '帳號已停用' });

      // 逐帳號登入鎖定（與員工登入同源，放寬門檻）
      const loginLock = require('../utils/loginLock');
      const lock = loginLock.checkLocked(staff);
      if (lock.locked) return res.status(429).json({ error: 'ACCOUNT_LOCKED', message: `密碼錯誤次數過多，帳號已鎖定，請 ${lock.mins} 分鐘後再試` });

      const valid = await bcrypt.compare(password, staff.passwordHash);
      if (!valid) {
        const r = await loginLock.registerFail('staff', staffDoc.id, staff);
        if (r.locked) return res.status(429).json({ error: 'ACCOUNT_LOCKED', message: `密碼錯誤次數過多，帳號鎖定 ${r.mins} 分鐘` });
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: `帳號或密碼錯誤（剩餘 ${r.remaining} 次）` });
      }
      await loginLock.clearFail('staff', staffDoc.id);

      const now = new Date();

      // 結束上一個還在進行的班（若有）
      const activeSnap = await db.collection('shiftLogs')
        .where('stationId', '==', stationId)
        .where('clockOutAt', '==', null)
        .get();

      const batch = db.batch();
      activeSnap.docs.forEach(d => {
        batch.update(d.ref, { clockOutAt: now, autoClockOut: true });
      });

      // 建立新班次
      const shiftRef = db.collection('shiftLogs').doc();
      batch.set(shiftRef, {
        id: shiftRef.id,
        stationId,
        gymId,
        staffId: staffDoc.id,
        staffName: staff.name,
        staffEmail: staff.email,
        staffRole: staff.role,
        clockInAt: now,
        clockOutAt: null,
        notes: '',
        createdAt: now,
      });

      await batch.commit();

      // 產生值班 operator token（8小時）
      const operatorToken = signToken({
        staffId: staffDoc.id,
        staffName: staff.name,
        staffRole: staff.role,
        gymId,
        stationId,
        shiftId: shiftRef.id,
        type: 'operator',
      }, '16h'); // 值班 token 效期 16 小時（打卡後結帳時窗放寬）

      res.json({
        operatorToken,
        operator: {
          id: staffDoc.id,
          name: staff.name,
          role: staff.role,
          shiftId: shiftRef.id,
        },
        message: `${staff.name} 打卡成功`,
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /stations/shift/clockout - 交班 ─────────────────────────
router.post('/shift/clockout',
  authenticateStation,
  [
    body('shiftId').notEmpty(),
    body('stationId').notEmpty(),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { shiftId, stationId, notes } = req.body;

      const shiftDoc = await db.collection('shiftLogs').doc(shiftId).get();
      if (!shiftDoc.exists) return res.status(404).json({ error: '找不到班次紀錄' });

      const shift = shiftDoc.data();
      if (shift.stationId !== stationId) return res.status(403).json({ error: '班次不屬於此電腦' });
      if (shift.clockOutAt) return res.status(400).json({ error: '此班次已交班' });

      const now = new Date();
      await shiftDoc.ref.update({
        clockOutAt: now,
        notes: notes || '',
        updatedAt: now,
      });

      res.json({
        message: `${shift.staffName} 交班成功`,
        shift: {
          id: shiftId,
          staffName: shift.staffName,
          clockInAt: shift.clockInAt,
          clockOutAt: now,
          notes: notes || '',
        },
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /stations/shift/current - 取得目前值班人員 ───────────────
router.get('/shift/current/:stationId', authenticateStation, async (req, res) => {
  try {
    const db = getDb();
    const { stationId } = req.params;

    const snap = await db.collection('shiftLogs')
      .where('stationId', '==', stationId)
      .where('clockOutAt', '==', null)
      .orderBy('clockInAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return res.json({ operator: null });

    const shift = snap.docs[0].data();
    res.json({
      operator: {
        id: shift.staffId,
        name: shift.staffName,
        role: shift.staffRole,
        shiftId: shift.id,
        clockInAt: shift.clockInAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /stations/shift/history - 班次歷史 ───────────────────────
router.get('/shift/history/:stationId', authenticateStation, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('shiftLogs')
      .where('stationId', '==', req.params.stationId)
      .orderBy('clockInAt', 'desc')
      .limit(30)
      .get();

    res.json({ shifts: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// 館別電腦帳號管理（系統管理員）
// ══════════════════════════════════════════════════════════════════

// GET /stations - 列出所有館別電腦帳號（不含密碼）
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('stations').orderBy('createdAt', 'desc').get().catch(async () => await db.collection('stations').get());
    const stations = snap.docs.map(d => {
      const { passwordHash, ...rest } = d.data();
      return { id: d.id, ...rest };
    });
    res.json({ stations });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /stations - 新增館別電腦帳號
router.post('/',
  authenticate, requireSuperAdmin,
  [
    body('name').notEmpty().withMessage('請輸入電腦帳號名稱'),
    body('email').isEmail().withMessage('請輸入有效的登入 Email'),
    body('password').isLength({ min: 6 }).withMessage('密碼至少 6 碼'),
    body('gymId').notEmpty().withMessage('請選擇館別'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { name, email, password, gymId } = req.body;
      // Email 不可與現有電腦帳號重複
      const dup = await db.collection('stations').where('email', '==', email).limit(1).get();
      if (!dup.empty) return res.status(409).json({ error: 'EMAIL_EXISTS', message: '此登入 Email 已被使用' });
      const gymDoc = await db.collection('gyms').doc(gymId).get();
      if (!gymDoc.exists) return res.status(400).json({ error: 'INVALID_GYM', message: '館別不存在' });
      const passwordHash = await bcrypt.hash(password, 10);
      const id = uuidv4();
      await db.collection('stations').doc(id).set({
        name, email, passwordHash, gymId,
        gymName: gymDoc.data().name || '',
        isActive: true, notificationEmail: req.body.notificationEmail || null,
        createdAt: new Date(), lastLoginAt: null,
      });
      res.status(201).json({ id, message: '館別電腦帳號已建立' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// PUT /stations/:id - 編輯（名稱/館別/啟用/選填改密碼）
router.put('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('stations').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const updates = { updatedAt: new Date() };
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.isActive !== undefined) updates.isActive = !!req.body.isActive;
    if (req.body.notificationEmail !== undefined) updates.notificationEmail = req.body.notificationEmail || null;
    if (req.body.gymId) {
      const gymDoc = await db.collection('gyms').doc(req.body.gymId).get();
      if (!gymDoc.exists) return res.status(400).json({ error: 'INVALID_GYM', message: '館別不存在' });
      updates.gymId = req.body.gymId;
      updates.gymName = gymDoc.data().name || '';
    }
    if (req.body.password) {
      if (String(req.body.password).length < 6) return res.status(400).json({ error: 'WEAK_PASSWORD', message: '密碼至少 6 碼' });
      updates.passwordHash = await bcrypt.hash(req.body.password, 10);
    }
    await ref.update(updates);
    res.json({ message: '已更新' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
