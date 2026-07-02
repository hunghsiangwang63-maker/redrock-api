/**
 * 定期票 + 單次入場券路由
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAny, checkPermission, auditLog } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

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

// ════════════════════════════════════════════════════════════════
// 定期票
// ════════════════════════════════════════════════════════════════

router.get('/types', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const isSuper = req.staff.role === 'super_admin';
    const gymId = isSuper ? req.query.gymId : req.staff.gymId;
    const snapshot = await db.collection(COLLECTIONS.PASS_TYPES).where('isActive', '==', true).get();
    let types = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    // super_admin 選「全館」（未帶 gymId）→ 回全部；否則只留 全館通用 + 該館單館票種
    if (!(isSuper && !gymId)) {
      types = types.filter(t => !t.gymId || t.gymId === gymId);
    }
    res.json({ passTypes: types });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.post('/types',
  authenticate, checkPermission('pass_types.manage'), auditLog('pass_type.create'),
  [
    body('name').notEmpty(),
    body('scope').isIn(['single', 'shared']),
    body('price').isNumeric(),
    body('durationDays').isInt({ min: 1 }),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const typeId = uuidv4();
      const now = new Date();
      if (req.body.scope === 'single' && !req.body.targetGymId && !req.staff.gymId) {
        return res.status(400).json({ error: 'MISSING_TARGET_GYM', message: '請選擇票種適用的場館' });
      }
      // 館別隔離：非 super_admin 不可為其他館建立單館票種
      if (req.body.scope === 'single' && req.body.targetGymId && req.body.targetGymId !== req.staff.gymId && req.staff.role !== 'super_admin') {
        return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '不可為其他館別建立票種' });
      }
      const resolvedGymId = req.body.scope === 'single' ? (req.body.targetGymId || req.staff.gymId) : null;
      const passType = {
        id: typeId,
        gymId: resolvedGymId,
        name: req.body.name,
        scope: req.body.scope,
        targetGymId: resolvedGymId,
        price: parseInt(req.body.price),
        durationDays: parseInt(req.body.durationDays),
        credits: req.body.credits ? parseInt(req.body.credits) : null,
        // 分期規則（此票種可分期）：購買時會員可選一次付清或分期
        installment: (req.body.installment && req.body.installment.enabled)
          ? { enabled: true, periods: (req.body.installment.periods || []).map(p => ({ percent: Number(p.percent) || 0, dueOffsetDays: Number(p.dueOffsetDays) || 0 })) }
          : { enabled: false, periods: [] },
        isActive: true,
        createdAt: now, updatedAt: now,
      };
      await db.collection(COLLECTIONS.PASS_TYPES).doc(typeId).set(passType);
      res.status(201).json({ passType, message: '票種建立成功' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /passes/types/:id - 修改票種 ──────────────────────────────
router.put('/types/:id',
  authenticate, checkPermission('pass_types.manage'), auditLog('pass_type.update'),
  [
    body('name').optional().notEmpty(),
    body('price').optional().isNumeric(),
    body('durationDays').optional().isInt({ min: 1 }),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection(COLLECTIONS.PASS_TYPES).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此票種' });

      const allowed = ['name', 'price', 'durationDays', 'credits'];
      const updates = {};
      allowed.forEach(f => {
        if (req.body[f] !== undefined) {
          updates[f] = (f === 'price' || f === 'durationDays' || f === 'credits') ? parseInt(req.body[f]) : req.body[f];
        }
      });
      if (req.body.installment !== undefined) {
        const inst = req.body.installment;
        updates.installment = (inst && inst.enabled)
          ? { enabled: true, periods: (inst.periods || []).map(p => ({ percent: Number(p.percent) || 0, dueOffsetDays: Number(p.dueOffsetDays) || 0 })) }
          : { enabled: false, periods: [] };
      }
      updates.updatedAt = new Date();

      await ref.update(updates);
      res.json({ message: '票種已更新' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── DELETE /passes/types/:id - 停用票種（軟刪除，既有已購買的定期票不受影響）──
router.delete('/types/:id',
  authenticate, checkPermission('pass_types.manage'), auditLog('pass_type.deactivate'),
  async (req, res) => {
    try {
      const db = getDb();
      await db.collection(COLLECTIONS.PASS_TYPES).doc(req.params.id).update({
        isActive: false, deactivatedAt: new Date(), deactivatedBy: req.staff.id,
      });
      res.json({ message: '票種已停用' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

router.get('/member/:memberId', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const snapshot = await db.collection(COLLECTIONS.MEMBER_PASSES)
      .where('memberId', '==', req.params.memberId)
      .orderBy('createdAt', 'desc').get();
    res.json({ passes: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.post('/',
  authenticate, checkPermission('passes.create'), auditLog('pass.create'),
  [
    body('memberId').notEmpty(),
    body('passTypeId').notEmpty(),
    body('startDate').isDate(),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const passTypeDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(req.body.passTypeId).get();
      if (!passTypeDoc.exists) return res.status(404).json({ error: 'PASS_TYPE_NOT_FOUND' });
      const passType = passTypeDoc.data();
      const passId = uuidv4();
      const now = new Date();
      const endDate = dayjs(req.body.startDate).add(passType.durationDays, 'day').format('YYYY-MM-DD');
      const pass = {
        id: passId, memberId: req.body.memberId,
        gymId: req.staff.gymId, passTypeId: req.body.passTypeId,
        passTypeName: passType.name, scope: passType.scope,
        targetGymId: passType.targetGymId,
        startDate: req.body.startDate, endDate,
        credits: passType.credits, originalCredits: passType.credits,
        status: 'active', paymentId: req.body.paymentId || null,
        paymentStatus: req.body.deferPayment ? 'pending' : 'confirmed',
        soldByStaffId: req.staff.id, notes: req.body.notes || '',
        createdAt: now, updatedAt: now,
      };
      await db.collection(COLLECTIONS.MEMBER_PASSES).doc(passId).set(pass);

      // 分期：票種有開分期規則且會員選「分期」→ 建立分期計畫（各期收款日即時認列），第一期簽約當下收
      const usePassInstallment = passType.installment?.enabled && req.body.paymentPlan === 'installment' && !req.body.deferPayment;
      let passPlan = null;
      if (passType.price > 0 && usePassInstallment) {
        const installmentService = require('../services/installmentService');
        const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
        const periods = installmentService.buildPeriodsFromConfig(passType.installment, passType.price, today);
        if (periods) {
          passPlan = await installmentService.createInstallmentPlan({
            memberId: req.body.memberId, memberName: req.body.memberName || '',
            gymId: req.staff.gymId, relatedType: 'pass', relatedId: passId, itemName: passType.name,
            recognitionDate: null, installments: periods,
            firstPaymentMethod: req.body.paymentMethod || 'cash', staffId: req.staff.id, staffName: req.staff.name,
          });
        }
      }
      // 記錄交易（一次付清；分期改由計畫逐期記帳，此處略過；deferPayment 由付款 callback 記）
      if (passType.price > 0 && !req.body.deferPayment && !passPlan) {
        const { recordTransaction } = require('../utils/revenueLedger');
        await recordTransaction(db, {
          gymId: req.staff.gymId,
          type: 'pass',
          totalAmount: passType.price,
          paymentMethod: req.body.paymentMethod || 'cash',
          memberId: req.body.memberId,
          memberName: req.body.memberName || '',
          relatedId: passId,
          notes: `定期票購買：${passType.name}`,
          staffId: req.staff.id,
          staffName: req.staff.name,
        });
      }

      res.status(201).json({ pass, installmentPlan: passPlan, message: '定期票建立成功' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

router.put('/:id',
  authenticate, checkPermission('passes.update'), auditLog('pass.update'),
  async (req, res) => {
    try {
      const db = getDb();
      const allowedFields = ['endDate', 'credits', 'status', 'notes'];
      const updates = {};
      allowedFields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      updates.updatedAt = new Date();
      if (req.body.renew && req.body.passTypeId) {
        const passTypeDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(req.body.passTypeId).get();
        if (passTypeDoc.exists) {
          const passDoc = await db.collection(COLLECTIONS.MEMBER_PASSES).doc(req.params.id).get();
          if (!passDoc.exists) return res.status(404).json({ error: 'PASS_NOT_FOUND', message: '找不到此定期票' });
          const passData = passDoc.data();
          const passType = passTypeDoc.data();
          const currentEnd = passData.endDate;
          const baseDate = dayjs(currentEnd).isAfter(dayjs()) ? currentEnd : dayjs().format('YYYY-MM-DD');
          updates.endDate = dayjs(baseDate).add(passType.durationDays, 'day').format('YYYY-MM-DD');
          updates.status = 'active';
          if (passType.credits) {
            updates.credits = passType.credits;
            updates.originalCredits = passType.credits;
          }
          if (passType.price > 0) {
            const { recordTransaction } = require('../utils/revenueLedger');
            await recordTransaction(db, {
              gymId: passData.gymId || req.staff.gymId,
              type: 'pass',
              totalAmount: passType.price,
              paymentMethod: req.body.paymentMethod || 'cash',
              memberId: passData.memberId,
              memberName: req.body.memberName || '',
              relatedId: req.params.id,
              notes: `定期票續約：${passType.name}`,
              staffId: req.staff.id,
              staffName: req.staff.name,
            });
          }
        }
      }
      await db.collection(COLLECTIONS.MEMBER_PASSES).doc(req.params.id).update(updates);
      res.json({ message: '定期票更新成功', updates });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

router.delete('/:id',
  authenticate, checkPermission('passes.delete'), auditLog('pass.delete'),
  async (req, res) => {
    try {
      const db = getDb();
      await db.collection(COLLECTIONS.MEMBER_PASSES).doc(req.params.id).update({
        status: 'cancelled', updatedAt: new Date(),
      });
      res.json({ message: '定期票已取消' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ════════════════════════════════════════════════════════════════
// 單次入場券（含審核流程）
// ════════════════════════════════════════════════════════════════

// ── GET /passes/single-entry/member/:memberId ────────────────────
router.get('/single-entry/member/:memberId',
  authenticateAny,
  async (req, res) => {
    try {
      const db = getDb();
      const snap = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS)
        .where('memberId', '==', req.params.memberId)
        .orderBy('createdAt', 'desc').get();
      res.json({ tickets: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /passes/single-entry/pending - 待審核清單 ────────────────
router.get('/single-entry/pending',
  authenticate, checkPermission('passes.approve'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
      let query = db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS)
        .where('status', '==', 'pending_approval');
      if (gymId) query = query.where('gymId', '==', gymId);
      const snap = await query.orderBy('createdAt', 'desc').get();
      res.json({ tickets: snap.docs.map(d => ({ id: d.id, ...d.data() })), count: snap.size });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /passes/single-entry - 發放單次入場券（需審核）──────────
router.post('/single-entry',
  authenticate, checkPermission('passes.create'),
  [body('memberId').notEmpty().withMessage('請指定會員')],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { notifySingleEntryTicketApproval } = require('../services/notificationService');
      const memberService = require('../services/memberService');

      const member = await memberService.getMember(req.body.memberId);
      const ticketId = uuidv4();
      const now = new Date();
      const issuedAt = dayjs().format('YYYY-MM-DD');
      const expiresAt = dayjs().add(1, 'year').format('YYYY-MM-DD');
      const approvalDeadline = dayjs().add(24, 'hour').toDate();
      const amount = req.body.amount !== undefined ? parseInt(req.body.amount) : 200;
      const paymentMethod = req.body.paymentMethod || 'cash';

      const ticket = {
        id: ticketId,
        memberId: req.body.memberId,
        memberName: member.name,
        originalMemberId: req.body.memberId,
        gymId: req.staff.gymId,
        issuedAt, expiresAt,
        amount, paymentMethod,
        status: 'pending_approval',      // 待審核，不可使用
        approvalDeadline,                 // 24小時後自動取消
        approvedAt: null,
        approvedBy: null,
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        transferHistory: [],
        usedAt: null,
        usedCheckInId: null,
        soldByStaffId: req.staff.id,
        soldByStaffName: req.staff.name,
        paymentId: req.body.paymentId || null,
        notes: req.body.notes || '',
        createdAt: now, updatedAt: now,
      };

      await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(ticketId).set(ticket);

      // 記錄交易（發放時即記錄，因為款項於發放時收取）
      if (amount > 0) {
        const { recordTransaction } = require('../utils/revenueLedger');
        await recordTransaction(db, {
          gymId: req.staff.gymId,
          type: 'single_entry_ticket',
          totalAmount: amount,
          paymentMethod,
          memberId: req.body.memberId,
          memberName: member.name,
          relatedId: ticketId,
          notes: '單次入場券發放',
          staffId: req.staff.id,
          staffName: req.staff.name,
        });
      }

      // 發送審核通知給 gym_manager 和 super_admin
      await notifySingleEntryTicketApproval({
        ticketId,
        memberName: member.name,
        gymId: req.staff.gymId,
        issuedByStaffName: req.staff.name,
      });

      res.status(201).json({
        ticket,
        message: '單次入場券已發放，等待館長或管理員審核（24小時內）',
      });
    } catch (err) {
      if (err.code === 'MEMBER_NOT_FOUND') return res.status(404).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /passes/single-entry/:id/approve - 審核通過 ────────────
router.post('/single-entry/:id/approve',
  authenticate, checkPermission('passes.approve'),
  async (req, res) => {
    try {
      const db = getDb();
      const ticketRef = db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(req.params.id);
      const ticketDoc = await ticketRef.get();

      if (!ticketDoc.exists) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
      const ticket = ticketDoc.data();

      if (ticket.status !== 'pending_approval') {
        return res.status(400).json({ error: 'INVALID_STATUS', message: `目前狀態為 ${ticket.status}，無法審核` });
      }

      // 檢查是否已超過 24 小時
      if (dayjs().isAfter(dayjs(ticket.approvalDeadline.toDate()))) {
        await ticketRef.update({ status: 'cancelled', cancelReason: 'approval_timeout', updatedAt: new Date() });
        return res.status(400).json({ error: 'APPROVAL_TIMEOUT', message: '已超過24小時審核期限，入場券已自動取消' });
      }

      const now = new Date();
      await ticketRef.update({
        status: 'active',
        approvedAt: now,
        approvedBy: req.staff.id,
        approvedByName: req.staff.name,
        updatedAt: now,
      });

      // 通知發放人員
      const { createNotification } = require('../services/notificationService');
      await createNotification({
        gymId: ticket.gymId,
        targetStaffId: ticket.soldByStaffId,
        type: 'single_entry_ticket_approved',
        title: '單次入場券審核通過',
        body: `${req.staff.name} 已審核通過 ${ticket.memberName} 的單次入場券。`,
        referenceId: ticket.id,
        referenceType: 'singleEntryTicket',
      });

      res.json({ message: '審核通過，入場券已啟用', ticketId: req.params.id });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /passes/single-entry/:id/reject - 審核拒絕 ─────────────
router.post('/single-entry/:id/reject',
  authenticate, checkPermission('passes.approve'),
  [body('reason').notEmpty().withMessage('請填寫拒絕原因')],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const ticketRef = db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(req.params.id);
      const ticketDoc = await ticketRef.get();

      if (!ticketDoc.exists) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
      const ticket = ticketDoc.data();

      if (ticket.status !== 'pending_approval') {
        return res.status(400).json({ error: 'INVALID_STATUS', message: `目前狀態為 ${ticket.status}，無法拒絕` });
      }

      const now = new Date();
      await ticketRef.update({
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: req.staff.id,
        cancelReason: req.body.reason,
        updatedAt: now,
      });

      // 退回交易紀錄（發放時已收款，拒絕後需退款）
      if (ticket.amount > 0) {
        const { recordTransaction } = require('../utils/revenueLedger');
        await recordTransaction(db, {
          gymId: ticket.gymId,
          type: 'refund',
          totalAmount: -ticket.amount,
          paymentMethod: ticket.paymentMethod || 'cash',
          memberId: ticket.memberId,
          memberName: ticket.memberName,
          relatedId: ticket.id,
          notes: `單次入場券審核拒絕退款：${req.body.reason}`,
          staffId: req.staff.id,
          staffName: req.staff.name,
        });
      }

      // 通知發放人員
      const { createNotification } = require('../services/notificationService');
      await createNotification({
        gymId: ticket.gymId,
        targetStaffId: ticket.soldByStaffId,
        type: 'single_entry_ticket_rejected',
        title: '單次入場券審核未通過',
        body: `${req.staff.name} 拒絕了 ${ticket.memberName} 的單次入場券。原因：${req.body.reason}`,
        referenceId: ticket.id,
        referenceType: 'singleEntryTicket',
      });

      res.json({ message: '已拒絕，入場券已取消', ticketId: req.params.id });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /passes/single-entry/:id/transfer - 轉移 ───────────────
router.post('/single-entry/:id/transfer',
  authenticate, checkPermission('passes.create'),
  [body('toMemberId').notEmpty().withMessage('請指定轉移對象')],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const ticketRef = db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(req.params.id);
      const ticketDoc = await ticketRef.get();

      if (!ticketDoc.exists) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
      const ticket = ticketDoc.data();
      if (ticket.status !== 'active') {
        return res.status(400).json({ error: 'TICKET_NOT_ACTIVE', message: '此入場券狀態不可轉移（需為已審核通過）' });
      }

      const now = new Date();
      const transferHistory = ticket.transferHistory || [];
      transferHistory.push({
        fromMemberId: ticket.memberId,
        toMemberId: req.body.toMemberId,
        transferredAt: now,
      });

      await ticketRef.update({
        memberId: req.body.toMemberId,
        transferHistory,
        updatedAt: now,
      });

      res.json({ message: '單次入場券轉移成功', expiresAt: ticket.expiresAt });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

module.exports = router;
