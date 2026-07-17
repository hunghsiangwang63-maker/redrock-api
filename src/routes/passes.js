/**
 * 定期票 + 單次入場券路由
 */
const { taiwanToday } = require('../utils/taiwanDate');
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAny, checkPermission, requireManagerOrStation, requireManager, auditLog } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const memberService = require('../services/memberService');
const { isChild } = require('../utils/age');

// 由票種效期算到期日：優先「月數」（一個月一個月算，7/6→10/6；月底自動夾到當月最後一天，
// 例 1/31＋1月→2/28），未設月數則沿用「天數」（曆日）。
function computePassEndDate(startDate, passType) {
  const start = dayjs(startDate);
  if (passType && passType.durationMonths) {
    return start.add(passType.durationMonths, 'month').format('YYYY-MM-DD');
  }
  return start.add((passType && passType.durationDays) || 0, 'day').format('YYYY-MM-DD');
}

// 定期票排序：效期短→長；「算次數（回數票，credits 非 null）」一律排在「算時間」之後。
// 效期以天數估比：月數 × 30 vs 天數；同組再依效期、次數。就地排序（mutates）。
const passDurationDays = (t) => (t && t.durationMonths) ? t.durationMonths * 30 : ((t && t.durationDays) || 0);
function sortPassTypes(types) {
  return types.sort((a, b) => {
    const ca = (a.credits != null) ? 1 : 0;
    const cb = (b.credits != null) ? 1 : 0;
    if (ca !== cb) return ca - cb;                          // 算次數的排後面
    const da = passDurationDays(a), db = passDurationDays(b);
    if (da !== db) return da - db;                          // 效期短→長
    return (a.credits || 0) - (b.credits || 0);             // 同效期再依次數少→多
  });
}

// 續約折扣：支援百分比(percent，例 value=10＝折10%→×0.9)或固定折抵金額(amount，例 value=800→原價−800)。
// 無設定/值<=0 → 回 null（續約以原價計）。
function normalizeRenewalDiscount(rd) {
  if (!rd || !['percent', 'amount'].includes(rd.mode)) return null;
  const value = Number(rd.value) || 0;
  if (value <= 0) return null;
  return { mode: rd.mode, value: rd.mode === 'percent' ? Math.min(100, value) : value };
}
// 依票種算續約價（原價套續約折扣）
function computeRenewalPrice(passType) {
  const price = passType.price || 0;
  const rd = passType.renewalDiscount;
  if (!rd) return price;
  return rd.mode === 'percent'
    ? Math.max(0, Math.round(price * (100 - rd.value) / 100))
    : Math.max(0, price - rd.value);
}

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
    // 管理頁需含停用票種（供啟用/刪除）；一般（會員可購/挑選）維持只回啟用中
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const snapshot = includeInactive
      ? await db.collection(COLLECTIONS.PASS_TYPES).get()
      : await db.collection(COLLECTIONS.PASS_TYPES).where('isActive', '==', true).get();
    let types = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    // super_admin 選「全館」（未帶 gymId）→ 回全部；否則只留 全館通用 + 該館單館票種
    if (!(isSuper && !gymId)) {
      types = types.filter(t => !t.gymId || t.gymId === gymId);
    }
    sortPassTypes(types);
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
    body('durationDays').optional({ checkFalsy: true }).isInt({ min: 1 }),
    body('durationMonths').optional({ checkFalsy: true }).isInt({ min: 1 }),
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
      // 效期：月數或天數擇一（月數優先），至少要有一個
      if (!req.body.durationMonths && !req.body.durationDays) {
        return res.status(400).json({ error: 'MISSING_DURATION', message: '請設定效期（月數或天數擇一）' });
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
        durationDays: req.body.durationDays ? parseInt(req.body.durationDays) : null,
        durationMonths: req.body.durationMonths ? parseInt(req.body.durationMonths) : null,
        credits: req.body.credits ? parseInt(req.body.credits) : null,
        // 分期規則（此票種可分期）：購買時會員可選一次付清或分期
        installment: (req.body.installment && req.body.installment.enabled)
          ? { enabled: true, periods: (req.body.installment.periods || []).map(p => ({ percent: Number(p.percent) || 0, dueOffsetDays: Number(p.dueOffsetDays) || 0 })) }
          : { enabled: false, periods: [] },
        renewalDiscount: normalizeRenewalDiscount(req.body.renewalDiscount), // 續約折扣（percent/amount 或 null）
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
    body('durationDays').optional({ checkFalsy: true }).isInt({ min: 1 }),
    body('durationMonths').optional({ checkFalsy: true }).isInt({ min: 1 }),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection(COLLECTIONS.PASS_TYPES).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此票種' });

      // durationMonths / durationDays 可傳空清除（切回另一種效期計法）；數字則存數字
      const allowed = ['name', 'price', 'durationDays', 'durationMonths', 'credits'];
      const updates = {};
      allowed.forEach(f => {
        if (req.body[f] === undefined) return;
        if (f === 'name') { updates[f] = req.body[f]; return; }
        const n = parseInt(req.body[f]);
        updates[f] = Number.isNaN(n) ? null : n;
      });
      if (req.body.installment !== undefined) {
        const inst = req.body.installment;
        updates.installment = (inst && inst.enabled)
          ? { enabled: true, periods: (inst.periods || []).map(p => ({ percent: Number(p.percent) || 0, dueOffsetDays: Number(p.dueOffsetDays) || 0 })) }
          : { enabled: false, periods: [] };
      }
      if (req.body.renewalDiscount !== undefined) updates.renewalDiscount = normalizeRenewalDiscount(req.body.renewalDiscount);
      // 停用/啟用（isActive）：停用後會員購買/挑選清單看不到，可再啟用；不影響既有已購買的定期票
      if (req.body.isActive !== undefined) {
        updates.isActive = !!req.body.isActive;
        if (updates.isActive) { updates.deactivatedAt = null; updates.deactivatedBy = null; }
        else { updates.deactivatedAt = new Date(); updates.deactivatedBy = req.staff.id; }
      }
      updates.updatedAt = new Date();

      await ref.update(updates);
      res.json({ message: req.body.isActive === false ? '票種已停用' : req.body.isActive === true ? '票種已啟用' : '票種已更新' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── DELETE /passes/types/:id - 永久刪除票種（硬刪除）──
// 安全防護：仍有會員持有此票種的「有效」定期票時擋下，避免刪掉票種後續約/報表對不到（改用停用）。
router.delete('/types/:id',
  authenticate, checkPermission('pass_types.manage'), auditLog('pass_type.delete'),
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection(COLLECTIONS.PASS_TYPES).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此票種' });

      const activeSnap = await db.collection(COLLECTIONS.MEMBER_PASSES)
        .where('passTypeId', '==', req.params.id)
        .where('status', '==', 'active')
        .get();
      if (!activeSnap.empty) {
        return res.status(409).json({
          error: 'PASS_TYPE_IN_USE',
          message: `尚有 ${activeSnap.size} 位會員持有此票種的有效定期票，無法刪除。請改用「停用」（會員即看不到、既有票不受影響）。`,
        });
      }
      await ref.delete();
      res.json({ message: '票種已刪除' });
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
    // 顯示補償後到期日（臨時休館延長、公休不補）；保留 baseEndDate 供參考
    const withEff = await require('../services/passExpiryService').attachEffectiveEndDates(
      snapshot.docs.map(d => ({ id: d.id, ...d.data() }))
    );
    res.json({ passes: withEff.map(p => ({ ...p, baseEndDate: p.endDate, endDate: p.effectiveEndDate || p.endDate })) });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// 新增定期票給會員 = Group B：僅管理員（gym_manager / super_admin）
router.post('/',
  authenticate, requireManager, auditLog('pass.create'),
  [
    body('memberId').notEmpty(),
    body('passTypeId').notEmpty(),
    body('startDate').isDate(),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      // 後端權威：未滿 13 歲（兒童）不可購買定期票（用出生日期判定，不受 VIP/隊員 memberType 影響）
      const _buyer = await memberService.getMember(req.body.memberId).catch(() => null);
      if (isChild(_buyer)) return res.status(400).json({ code: 'CHILD_NO_PASS', message: '未滿 13 歲無法購買定期票' });
      const passTypeDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(req.body.passTypeId).get();
      if (!passTypeDoc.exists) return res.status(404).json({ error: 'PASS_TYPE_NOT_FOUND' });
      const passType = passTypeDoc.data();
      // 有效隊員購買定期票 9 折（後端權威，依買者身份）
      const { isActiveTeamMember, TEAM_DISCOUNT_MIN_AMOUNT } = require('../services/teamMemberService');
      const _isTeamBuyer = _buyer && isActiveTeamMember(_buyer);
      const salePrice = (_isTeamBuyer && (passType.price || 0) >= TEAM_DISCOUNT_MIN_AMOUNT)
        ? Math.round(passType.price * 0.9) : (passType.price || 0);
      const passId = uuidv4();
      const now = new Date();
      const endDate = computePassEndDate(req.body.startDate, passType);
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
      if (salePrice > 0 && usePassInstallment) {
        const installmentService = require('../services/installmentService');
        const today = taiwanToday();
        const periods = installmentService.buildPeriodsFromConfig(passType.installment, salePrice, today);
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
      if (salePrice > 0 && !req.body.deferPayment && !passPlan) {
        const { recordTransaction } = require('../utils/revenueLedger');
        await recordTransaction(db, {
          gymId: req.staff.gymId,
          type: 'pass',
          totalAmount: salePrice,
          paymentMethod: req.body.paymentMethod || 'cash',
          memberId: req.body.memberId,
          memberName: req.body.memberName || '',
          relatedId: passId,
          notes: `定期票購買：${passType.name}${_isTeamBuyer && salePrice < (passType.price||0) ? '（隊員9折）' : ''}`,
          staffId: req.staff.id,
          staffName: req.staff.name,
        });
      }

      // 定期票 × 課程免費期間重疊補償（買票方向；買者已是課程學員 → 新票期間重疊即延長，冪等不阻斷）
      try { await require('../services/passOverlapService').applyCourseOverlapForMember(req.body.memberId); }
      catch (e) { console.error('課程重疊補償失敗（票已建立）:', e.message); }

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
          updates.endDate = computePassEndDate(baseDate, passType);
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
// Group A：館別電腦(值班)或管理員；發放後為 pending_approval，管理員審核才生效（已有通知）
router.post('/single-entry',
  authenticate, requireManagerOrStation,
  [
    body('memberId').notEmpty().withMessage('請指定會員'),
    body('notes').trim().notEmpty().withMessage('請填寫備註說明（發放原因）'),
  ],
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
        notes: req.body.notes || '',
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
