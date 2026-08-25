const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { authenticate, authenticateAny, requireManagerOrStation } = require('../middleware/auth');
const { getStorage } = require('../config/firebase');
const memberReminderService = require('../services/memberReminderService');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

const dateOrEmpty = (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);

// 圖片欄位共用驗證：signed URL 可能較長（含查詢字串簽章），放寬到 2000 字
const imageUrlValidator = body('imageUrl').optional({ checkFalsy: true }).isLength({ max: 2000 });
// 圖片欄位共用擷取：一則提醒最多帶一張圖，此陣列供各路由 handler 共用抽取
const REMINDER_FIELDS = ['title', 'subtitle', 'icon', 'link', 'imageUrl', 'showFrom', 'showUntil'];
const pickFields = (body) => REMINDER_FIELDS.reduce((o, k) => { o[k] = body[k]; return o; }, {});

const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB 上限（建議 500KB 內，見前端提示）

// ── POST /member-reminders/upload-image — 上傳提醒圖片（先傳圖拿 URL，再放進新增/推播的表單一起送出） ──
router.post('/upload-image',
  authenticate, requireManagerOrStation,
  uploadImage.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'NO_FILE', message: '請選擇圖片' });
      if (!(req.file.mimetype || '').startsWith('image/')) {
        return res.status(400).json({ error: 'NOT_IMAGE', message: '只能上傳圖片檔' });
      }
      const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const bucket = getStorage().bucket();
      const fileName = `member-reminders/${uuidv4()}.${ext}`;
      const file = bucket.file(fileName);
      await file.save(req.file.buffer, { contentType: req.file.mimetype });
      const [url] = await file.getSignedUrl({ action: 'read', expires: '2035-01-01' });
      res.json({ imageUrl: url });
    } catch (err) {
      res.status(500).json({ error: err.code || 'SERVER_ERROR', message: err.message });
    }
  }
);

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
  imageUrlValidator,
  body('showFrom').optional({ checkFalsy: true }).custom(dateOrEmpty),
  body('showUntil').optional({ checkFalsy: true }).custom(dateOrEmpty),
  validate,
  async (req, res) => {
    try {
      const reminder = await memberReminderService.createReminder({
        memberId: req.body.memberId, ...pickFields(req.body),
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
  imageUrlValidator,
  body('showFrom').optional({ checkFalsy: true }).custom(dateOrEmpty),
  body('showUntil').optional({ checkFalsy: true }).custom(dateOrEmpty),
  validate,
  async (req, res) => {
    try {
      const reminder = await memberReminderService.updateReminder(req.params.id, {
        ...pickFields(req.body),
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
  imageUrlValidator,
  body('showFrom').optional({ checkFalsy: true }).custom(dateOrEmpty),
  body('showUntil').optional({ checkFalsy: true }).custom(dateOrEmpty),
  validate,
  async (req, res) => {
    try {
      const result = await memberReminderService.broadcastToCompetitionRegistrants(
        req.params.competitionId,
        pickFields(req.body),
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
  imageUrlValidator,
  body('showFrom').optional({ checkFalsy: true }).custom(dateOrEmpty),
  body('showUntil').optional({ checkFalsy: true }).custom(dateOrEmpty),
  validate,
  async (req, res) => {
    try {
      const result = await memberReminderService.broadcastToCourseEnrollees(
        req.params.courseId,
        pickFields(req.body),
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
