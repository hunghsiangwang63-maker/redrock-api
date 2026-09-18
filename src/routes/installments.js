/**
 * 分期付款路由
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAny, checkPermission } = require('../middleware/auth');
const { checkMemberOwnership } = require('../utils/memberOwnership');
const installmentService = require('../services/installmentService');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// ── POST /installments - 建立分期付款計畫 ──────────────────────────
router.post('/',
  authenticate, checkPermission('installments.manage'),
  [
    body('memberId').notEmpty().withMessage('請指定會員'),
    body('relatedType').isIn(['course', 'pass']).withMessage('relatedType 必須為 course 或 pass'),
    body('relatedId').notEmpty().withMessage('請指定關聯項目'),
    body('itemName').notEmpty().withMessage('請輸入項目名稱'),
    body('installments').isArray({ min: 2 }).withMessage('分期至少需要2期'),
  ],
  validate,
  async (req, res) => {
    try {
      const plan = await installmentService.createInstallmentPlan({
        ...req.body,
        staffId: req.staff.id,
        staffName: req.staff.name,
      });
      res.status(201).json({ plan, message: '分期付款計畫已建立' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /installments/:planId/pay - 標記某期已繳款 ────────────────
router.post('/:planId/pay',
  authenticate, checkPermission('installments.manage'),
  [
    body('seq').isInt({ min: 1 }).withMessage('請指定期數'),
    body('paymentMethod').isIn(installmentService.VALID_PAYMENT_METHODS).withMessage('付款方式不正確'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await installmentService.markInstallmentPaid({
        planId: req.params.planId,
        seq: parseInt(req.body.seq),
        paymentMethod: req.body.paymentMethod,
        note: req.body.note || null,
        staffId: req.staff.id,
        staffName: req.staff.name,
      });
      res.json({
        message: result.allPaid ? '已完成最後一期繳款，分期計畫結清' : '已標記此期繳款完成',
        ...result,
      });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /installments/:planId/mark-paid-in-full - 整筆標記已一次繳清（非依原分期時間分次繳）──
router.post('/:planId/mark-paid-in-full',
  authenticate, checkPermission('installments.manage'),
  [
    body('paymentMethod').isIn(installmentService.VALID_PAYMENT_METHODS).withMessage('付款方式不正確'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await installmentService.markInstallmentPlanPaidInFull({
        planId: req.params.planId,
        paymentMethod: req.body.paymentMethod,
        note: req.body.note || null,
        staffId: req.staff.id,
        staffName: req.staff.name,
      });
      res.json({ message: `已標記整筆分期計畫繳清（補記 ${result.recordedCount} 期帳）`, ...result });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /installments/member/:memberId - 查詢會員的分期計畫 ────────
// 支援家長查子女（checkMemberOwnership，與「我的紀錄」其餘分頁一致），原本只認本人會漏掉子女
// 名下的分期計畫（如課程分期報名對象是子女時）。
router.get('/member/:memberId', authenticateAny, async (req, res) => {
  try {
    if (req.member) {
      const deny = await checkMemberOwnership(req.member, req.params.memberId, { message: '只能查看自己或子女的分期計畫' });
      if (deny) return res.status(deny.status).json(deny.body);
    }
    const plans = await installmentService.getMemberInstallmentPlans(req.params.memberId);
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /installments/:planId/:seq/report-payment - 會員自行回報某期已繳款 ──
// 純「通知館方核對」，不等於確認收款——館方仍須到本頁（或待辦頁「💰待收款」）實際按「確認收款」
// 才會真正記帳／解除入場限制。會員 App「我的紀錄→分期付款」使用；員工亦可代為登記（跳過擁有權檢查）。
router.post('/:planId/:seq/report-payment',
  authenticateAny,
  [
    body('paymentMethod').isIn(installmentService.VALID_PAYMENT_METHODS).withMessage('付款方式不正確'),
    body('note').optional({ checkFalsy: true }).isLength({ max: 200 }).withMessage('備註過長（上限200字）'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await installmentService.reportMemberPayment({
        planId: req.params.planId,
        seq: parseInt(req.params.seq),
        requestingMember: req.member || null,
        paymentMethod: req.body.paymentMethod,
        note: (req.body.note || '').trim(),
      });
      res.json({ message: '已通知館方核對，請等候確認收款', ...result });
    } catch (err) {
      if (err.code) return res.status(err.status || 400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /installments - 查詢所有分期計畫（管理端，可用 ?status= 篩選）──
router.get('/', authenticate, checkPermission('installments.manage'), async (req, res) => {
  try {
    const plans = await installmentService.getAllInstallmentPlans(req.query.status);
    res.json({ plans, count: plans.length });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /installments/run-overdue-check - 手動觸發逾期檢查（未來可接外部排程）──
router.post('/run-overdue-check', authenticate, checkPermission('installments.manage'), async (req, res) => {
  try {
    const result = await installmentService.runOverdueCheck();
    res.json({ message: `已檢查，新增 ${result.overdueCount} 筆逾期`, ...result });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /installments/send-reminders - 手動觸發提醒信發送（未來可接外部排程）──
router.post('/send-reminders', authenticate, checkPermission('installments.manage'), async (req, res) => {
  try {
    const result = await installmentService.sendInstallmentReminders();
    res.json({ message: `已發送 ${result.reminderSent} 封會員提醒信、${result.overdueSent} 封逾期通知、${result.adminNotified} 則管理員預警通知`, ...result });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
