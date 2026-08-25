const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { authenticate, authenticateAny, requireManagerOrStation } = require('../middleware/auth');
const memberReminderService = require('../services/memberReminderService');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

const dateOrEmpty = (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);

// ── GET /member-reminders/member/:memberId — 員工端管理清單（含已過期/未來） ──
router.get('/member/:memberId',
  authenticate, requireManagerOrStation,
  param('memberId').notEmpty(),
  validate,
  async (req, res) => {
    try {
      const reminders = await memberReminderService.getRemindersForMember(req.params.memberId);
      res.json({ reminders });
    } catch (err) {
      res.status(500).json({ error: err.code || 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /member-reminders — 新增一則 ──
router.post('/',
  authenticate, requireManagerOrStation,
  body('memberId').notEmpty(),
  body('title').trim().notEmpty().withMessage('標題不可空白').isLength({ max: 100 }),
  body('subtitle').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('icon').optional({ checkFalsy: true }).isLength({ max: 8 }),
  body('link').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('showFrom').optional({ checkFalsy: true }).custom(dateOrEmpty),
  body('showUntil').optional({ checkFalsy: true }).custom(dateOrEmpty),
  validate,
  async (req, res) => {
    try {
      const { memberId, title, subtitle, icon, link, showFrom, showUntil } = req.body;
      const reminder = await memberReminderService.createReminder({
        memberId, title, subtitle, icon, link, showFrom, showUntil,
        staffId: req.staff.id, staffName: req.staff.name,
      });
      res.status(201).json({ reminder });
    } catch (err) {
      res.status(500).json({ error: err.code || 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /member-reminders/:id — 編輯 ──
router.put('/:id',
  authenticate, requireManagerOrStation,
  param('id').notEmpty(),
  body('title').optional().trim().notEmpty().withMessage('標題不可空白').isLength({ max: 100 }),
  body('subtitle').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('icon').optional({ checkFalsy: true }).isLength({ max: 8 }),
  body('link').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('showFrom').optional({ checkFalsy: true }).custom(dateOrEmpty),
  body('showUntil').optional({ checkFalsy: true }).custom(dateOrEmpty),
  validate,
  async (req, res) => {
    try {
      const { title, subtitle, icon, link, showFrom, showUntil } = req.body;
      const reminder = await memberReminderService.updateReminder(req.params.id, {
        title, subtitle, icon, link, showFrom, showUntil,
        staffId: req.staff.id, staffName: req.staff.name,
      });
      res.json({ reminder });
    } catch (err) {
      const status = err.code === 'REMINDER_NOT_FOUND' ? 404 : 500;
      res.status(status).json({ error: err.code || 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── DELETE /member-reminders/:id — 刪除 ──
router.delete('/:id',
  authenticate, requireManagerOrStation,
  param('id').notEmpty(),
  validate,
  async (req, res) => {
    try {
      await memberReminderService.deleteReminder(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.code || 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /member-reminders/broadcast/competition/:competitionId — 對該賽事全部正取報名者各建一則 ──
router.post('/broadcast/competition/:competitionId',
  authenticate, requireManagerOrStation,
  param('competitionId').notEmpty(),
  body('title').trim().notEmpty().withMessage('標題不可空白').isLength({ max: 100 }),
  body('subtitle').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('icon').optional({ checkFalsy: true }).isLength({ max: 8 }),
  body('link').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('showFrom').optional({ checkFalsy: true }).custom(dateOrEmpty),
  body('showUntil').optional({ checkFalsy: true }).custom(dateOrEmpty),
  validate,
  async (req, res) => {
    try {
      const { title, subtitle, icon, link, showFrom, showUntil } = req.body;
      const result = await memberReminderService.broadcastToCompetitionRegistrants(
        req.params.competitionId,
        { title, subtitle, icon, link, showFrom, showUntil },
        req.staff
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.code || 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /member-reminders/broadcast/course/:courseId — 對該梯次目前正取常態學員各建一則 ──
router.post('/broadcast/course/:courseId',
  authenticate, requireManagerOrStation,
  param('courseId').notEmpty(),
  body('title').trim().notEmpty().withMessage('標題不可空白').isLength({ max: 100 }),
  body('subtitle').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('icon').optional({ checkFalsy: true }).isLength({ max: 8 }),
  body('link').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('showFrom').optional({ checkFalsy: true }).custom(dateOrEmpty),
  body('showUntil').optional({ checkFalsy: true }).custom(dateOrEmpty),
  validate,
  async (req, res) => {
    try {
      const { title, subtitle, icon, link, showFrom, showUntil } = req.body;
      const result = await memberReminderService.broadcastToCourseEnrollees(
        req.params.courseId,
        { title, subtitle, icon, link, showFrom, showUntil },
        req.staff
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.code || 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /member-reminders/my — 會員端首頁：只回顯示期間內的提醒 ──
router.get('/my', authenticateAny, async (req, res) => {
  try {
    if (!req.member?.id) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const reminders = await memberReminderService.getActiveRemindersForMember(req.member.id);
    res.json({ reminders });
  } catch (err) {
    res.status(500).json({ error: err.code || 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
