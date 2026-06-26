/**
 * 員工帳號管理路由（僅 super_admin 可用）
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { authenticate, checkPermission } = require('../middleware/auth');
const { getDb } = require('../config/firebase');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: errors.array().map(e => `${e.path}: ${e.msg}`).join('；'),
      details: errors.array(),
    });
  }
  next();
};

const ROLES = ['super_admin', 'gym_manager', 'full_time', 'part_time'];

// ── GET /staff - 員工帳號清單 ───────────────────────────────────────
router.get('/', authenticate, checkPermission('staff.manage'), async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('staff').get();
    const staffList = snap.docs.map(d => {
      const data = d.data();
      delete data.passwordHash; // 絕不回傳密碼雜湊值
      return { id: d.id, ...data };
    });
    res.json({ staffList });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /staff - 新增員工帳號 ───────────────────────────────────────
router.post('/',
  authenticate, checkPermission('staff.manage'),
  [
    body('name').notEmpty().withMessage('請輸入姓名'),
    body('email').isEmail().withMessage('請輸入有效的Email'),
    body('password').isLength({ min: 6 }).withMessage('密碼至少需要6個字元'),
    body('role').isIn(ROLES).withMessage('角色不正確'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { name, email, phone, role, gymId, notificationEmail } = req.body;

      const existing = await db.collection('staff').where('email', '==', email).limit(1).get();
      if (!existing.empty) {
        return res.status(400).json({ error: 'EMAIL_EXISTS', message: '此Email已被使用' });
      }
      if (role !== 'super_admin' && !gymId) {
        return res.status(400).json({ error: 'MISSING_GYM', message: '此角色需指定所屬場館' });
      }

      const passwordHash = await bcrypt.hash(req.body.password, 10);
      const now = new Date();
      const ref = db.collection('staff').doc();
      const staffDoc = {
        id: ref.id, name, email, phone: phone || '',
        role, gymId: role === 'super_admin' ? null : gymId,
        notificationEmail: notificationEmail || '',
        passwordHash,
        isActive: true,
        createdAt: now, updatedAt: now,
      };
      await ref.set(staffDoc);
      delete staffDoc.passwordHash;
      res.status(201).json({ staff: staffDoc, message: '員工帳號已建立' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /staff/:id - 編輯員工帳號（不含密碼） ─────────────────────────
router.put('/:id',
  authenticate, checkPermission('staff.manage'),
  [
    body('name').optional().notEmpty(),
    body('email').optional().isEmail(),
    body('role').optional().isIn(ROLES),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection('staff').doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此員工帳號' });

      if (req.body.email && req.body.email !== doc.data().email) {
        const existing = await db.collection('staff').where('email', '==', req.body.email).limit(1).get();
        if (!existing.empty) return res.status(400).json({ error: 'EMAIL_EXISTS', message: '此Email已被使用' });
      }

      const allowed = ['name', 'email', 'phone', 'role', 'gymId', 'notificationEmail'];
      const updates = { updatedAt: new Date() };
      allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      if (updates.role === 'super_admin') updates.gymId = null;

      await ref.update(updates);
      res.json({ message: '員工帳號已更新' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /staff/:id/reset-password - 重設密碼 ─────────────────────────
router.post('/:id/reset-password',
  authenticate, checkPermission('staff.manage'),
  [body('password').isLength({ min: 6 }).withMessage('密碼至少需要6個字元')],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection('staff').doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此員工帳號' });

      const passwordHash = await bcrypt.hash(req.body.password, 10);
      await ref.update({ passwordHash, updatedAt: new Date() });
      res.json({ message: '密碼已重設' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /staff/:id/toggle-active - 停用/啟用帳號 ─────────────────────
router.post('/:id/toggle-active', authenticate, checkPermission('staff.manage'), async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('staff').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此員工帳號' });

    if (doc.id === req.staff.id) {
      return res.status(400).json({ error: 'CANNOT_DEACTIVATE_SELF', message: '無法停用自己的帳號' });
    }

    const newStatus = !doc.data().isActive;
    await ref.update({ isActive: newStatus, updatedAt: new Date() });
    res.json({ isActive: newStatus, message: newStatus ? '帳號已啟用' : '帳號已停用' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── DELETE /staff/:id - 硬刪除員工帳號 ───────────────────────────
router.delete('/:id', authenticate, checkPermission('staff.manage'), async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('staff').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此員工帳號' });

    if (doc.id === req.staff.id) {
      return res.status(400).json({ error: 'CANNOT_DELETE_SELF', message: '無法刪除自己的帳號' });
    }
    if (doc.data().role === 'super_admin') {
      return res.status(400).json({ error: 'CANNOT_DELETE_SUPER_ADMIN', message: '無法刪除系統管理員帳號' });
    }

    await ref.delete();
    res.json({ message: '員工帳號已刪除' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
