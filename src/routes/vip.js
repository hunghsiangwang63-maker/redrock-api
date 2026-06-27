/**
 * VIP 管理路由（super_admin 專用）
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, checkPermission } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const memberService = require('../services/memberService');
const { v4: uuidv4 } = require('uuid');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// ── GET /vip - 取得 VIP 名單 ────────────────────────────────────
router.get('/',
  authenticate,
  checkPermission('vip.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const snap = await db.collection(COLLECTIONS.VIP_MEMBERS)
        .orderBy('createdAt', 'desc')
        .get();
      const vips = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json({ vips, count: vips.length });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /vip - 新增 VIP ────────────────────────────────────────
router.post('/',
  authenticate,
  checkPermission('vip.manage'),
  [
    body('memberId').notEmpty().withMessage('請指定會員'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();

      // 確認會員存在
      const member = await memberService.getMember(req.body.memberId);

      // 檢查是否已是 VIP
      const existing = await db.collection(COLLECTIONS.VIP_MEMBERS)
        .where('memberId', '==', req.body.memberId)
        .limit(1)
        .get();
      if (!existing.empty) {
        return res.status(409).json({ error: 'ALREADY_VIP', message: '此會員已在 VIP 名單中' });
      }

      const vipId = uuidv4();
      const now = new Date();
      const vip = {
        id: vipId,
        memberId: member.id,
        memberName: member.name,
        note: req.body.note || '',
        createdBy: req.staff.id,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection(COLLECTIONS.VIP_MEMBERS).doc(vipId).set(vip);
      // 同步更新 member document 的 memberType
      await db.collection(COLLECTIONS.MEMBERS).doc(member.id).update({ memberType: 'vip', updatedAt: now });
      res.status(201).json({ vip, message: 'VIP 新增成功' });
    } catch (err) {
      if (err.code === 'MEMBER_NOT_FOUND') return res.status(404).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /vip/:id - 更新備註 ─────────────────────────────────────
router.put('/:id',
  authenticate,
  checkPermission('vip.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      await db.collection(COLLECTIONS.VIP_MEMBERS).doc(req.params.id).update({
        note: req.body.note || '',
        updatedAt: new Date(),
      });
      res.json({ message: 'VIP 資料更新成功' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── DELETE /vip/:id - 移除 VIP ──────────────────────────────────
router.delete('/:id',
  authenticate,
  checkPermission('vip.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const vipDoc = await db.collection(COLLECTIONS.VIP_MEMBERS).doc(req.params.id).get();
      await db.collection(COLLECTIONS.VIP_MEMBERS).doc(req.params.id).delete();
      // 同步清除 member document 的 memberType
      if (vipDoc.exists && vipDoc.data().memberId) {
        await db.collection(COLLECTIONS.MEMBERS).doc(vipDoc.data().memberId)
          .update({ memberType: 'general', updatedAt: new Date() });
      }
      res.json({ message: 'VIP 已移除' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

module.exports = router;

// ── POST /vip/sync-member-types - 一次性同步所有 VIP 的 memberType ──
router.post('/sync-member-types',
  authenticate,
  checkPermission('vip.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const snap = await db.collection(COLLECTIONS.VIP_MEMBERS).get();
      let updated = 0;
      for (const doc of snap.docs) {
        const { memberId } = doc.data();
        if (memberId) {
          await db.collection(COLLECTIONS.MEMBERS).doc(memberId)
            .update({ memberType: 'vip', updatedAt: new Date() });
          updated++;
        }
      }
      res.json({ success: true, updated, message: `已同步 ${updated} 位 VIP 會員的 memberType` });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);
