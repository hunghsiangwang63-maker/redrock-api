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

// ── POST /vip/import-legacy - 一次性匯入 Climbio VIP 名單（super_admin）──
// body: { entries: [{ name, phone?, family? }] }。冪等：doc id 以姓名 slug；已存在不覆寫 claimed。
// 已註冊者立即套 VIP（含全家子帳號）；未註冊者留待 claimLegacyVip 註冊時自動認領（無期限）。
router.post('/import-legacy', authenticate, async (req, res) => {
  try {
    if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
    const db = getDb();
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (!entries.length) return res.status(400).json({ error: 'MISSING_ENTRIES' });
    const clean = (n) => String(n || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s/g, '').trim();
    const ms = await db.collection(COLLECTIONS.MEMBERS).get();
    const members = ms.docs.map(d => ({ id: d.id, ...d.data() }));
    const results = [];
    for (const e of entries) {
      const nm = clean(e.name);
      if (!nm) continue;
      const docId = 'vip-' + Buffer.from(nm).toString('hex').slice(0, 40);
      const ref = db.collection('legacyVips').doc(docId);
      const cur = await ref.get();
      if (cur.exists && cur.data().claimed === true) { results.push({ name: e.name, status: 'already-claimed' }); continue; }
      await ref.set({
        id: docId, name: e.name, cleanName: nm, phone: e.phone || null, family: e.family === true,
        claimed: false, source: 'climbio-vip', createdAt: cur.exists ? cur.data().createdAt : new Date(), updatedAt: new Date(),
      }, { merge: true });
      // 已註冊 → 立即認領（精確 clean 姓名比對；同名多人跳過留人工）
      const hits = members.filter(m => clean(m.name) === nm && m.isActive !== false);
      if (hits.length === 1) {
        const m = hits[0];
        const dup = await db.collection(COLLECTIONS.VIP_MEMBERS).where('memberId', '==', m.id).limit(1).get();
        if (dup.empty) {
          const { v4: uuidv4 } = require('uuid');
          const vid = uuidv4();
          await db.collection(COLLECTIONS.VIP_MEMBERS).doc(vid).set({
            id: vid, memberId: m.id, memberName: m.name,
            note: `climbio-vip 匯入${e.family ? '（全家）' : ''}`, createdBy: req.staff.id,
            createdAt: new Date(), updatedAt: new Date(),
          });
        }
        const upd = { memberType: 'vip', updatedAt: new Date() };
        if (e.family === true) upd.vipFamily = true;
        await db.collection(COLLECTIONS.MEMBERS).doc(m.id).update(upd);
        let kids = 0;
        if (e.family === true) {
          const ks = await db.collection(COLLECTIONS.MEMBERS).where('parentMemberId', '==', m.id).get();
          for (const k of ks.docs) {
            const kd = await db.collection(COLLECTIONS.VIP_MEMBERS).where('memberId', '==', k.id).limit(1).get();
            if (kd.empty) {
              const { v4: uuidv4 } = require('uuid');
              const kv = uuidv4();
              await db.collection(COLLECTIONS.VIP_MEMBERS).doc(kv).set({
                id: kv, memberId: k.id, memberName: k.data().name, note: 'climbio-vip-family',
                createdBy: req.staff.id, createdAt: new Date(), updatedAt: new Date(),
              });
            }
            await db.collection(COLLECTIONS.MEMBERS).doc(k.id).update({ memberType: 'vip', updatedAt: new Date() });
            kids++;
          }
        }
        await ref.update({ claimed: true, claimedBy: m.id, claimedByName: m.name, claimedAt: new Date() });
        results.push({ name: e.name, status: 'applied', memberId: m.id, phone: m.phone, family: e.family === true, kidsApplied: kids });
      } else if (hits.length > 1) {
        results.push({ name: e.name, status: 'ambiguous', count: hits.length });
      } else {
        results.push({ name: e.name, status: 'pending-claim' });
      }
    }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

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
