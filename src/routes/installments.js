/**
 * 分期付款路由
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAny, checkPermission } = require('../middleware/auth');
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
        staffId: req.staff.id,
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

// ── GET /installments/member/:memberId - 查詢會員的分期計畫 ────────
router.get('/member/:memberId', authenticateAny, async (req, res) => {
  try {
    if (req.member && req.member.id !== req.params.memberId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '只能查看自己的分期計畫' });
    }
    const plans = await installmentService.getMemberInstallmentPlans(req.params.memberId);
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

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
