/**
 * 課程班別管理（課程樹：館別 → 大類 → 班別 → 梯次 → 場次）
 * 班別＝共用層：課程介紹、廣告照片、試上/請假/補課/退費規則、補課群組；兩館共用。
 * 大類 group：adult=成人班 | youth=青少年兒童班 | special=專班課程 | workshop=工作坊
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, checkPermission } = require('../middleware/auth');
const { getDb, getStorage } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const GROUPS = ['adult', 'youth', 'special', 'workshop'];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// 班別可編輯欄位（規則欄位＝該班別所有梯次的預設，梯次可個別覆寫）
const EDITABLE = [
  'name', 'group', 'description', 'color', 'isActive', 'makeupGroup',
  'allowTrial', 'trialPrice',
  'leaveDeadlineHours', 'maxLeaves',
  'allowMakeup', 'makeupDeadlineDays',   // 補課期限＝課程「結束日」+ N 天
  'perSessionDeduction', 'handlingFeeRate',
  'sortOrder',
];

// GET /course-categories
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('courseCategories').get();
    const categories = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || String(a.name).localeCompare(b.name));
    res.json({ categories });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /course-categories
router.post('/',
  authenticate, checkPermission('courses.manage'),
  [
    body('name').notEmpty().withMessage('請輸入班別名稱'),
    body('group').isIn(GROUPS).withMessage('請選擇所屬大類'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const id = uuidv4();
      const now = new Date();
      const category = {
        id,
        name: req.body.name,
        group: req.body.group,
        description: req.body.description || '',
        imageUrl: req.body.imageUrl || '',
        color: req.body.color || '#8B1A1A',
        makeupGroup: req.body.makeupGroup || id,   // 預設自成一組（同群組班別可互補課）
        // 規則預設（null＝用系統預設；梯次可再覆寫）
        allowTrial: req.body.allowTrial ?? null,
        trialPrice: req.body.trialPrice ?? null,
        leaveDeadlineHours: req.body.leaveDeadlineHours ?? null,
        maxLeaves: req.body.maxLeaves ?? null,
        allowMakeup: req.body.allowMakeup ?? null,
        makeupDeadlineDays: req.body.makeupDeadlineDays ?? null,
        perSessionDeduction: req.body.perSessionDeduction ?? null,
        handlingFeeRate: req.body.handlingFeeRate ?? null,
        sortOrder: req.body.sortOrder ?? null,
        isActive: true,
        createdBy: req.staff.id,
        createdAt: now, updatedAt: now,
      };
      await db.collection('courseCategories').doc(id).set(category);
      res.status(201).json({ category, message: '班別建立成功' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// PUT /course-categories/:id
router.put('/:id',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      if (req.body.group !== undefined && !GROUPS.includes(req.body.group)) {
        return res.status(400).json({ error: 'INVALID_GROUP', message: '大類不正確' });
      }
      const updates = { updatedAt: new Date() };
      EDITABLE.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      await db.collection('courseCategories').doc(req.params.id).update(updates);
      res.json({ message: '班別已更新' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// POST /course-categories/:id/image - 上傳班別廣告照片（同班別所有梯次共用）
router.post('/:id/image',
  authenticate, checkPermission('courses.manage'),
  uploadImage.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'NO_FILE', message: '請選擇圖片' });
      if (!(req.file.mimetype || '').startsWith('image/')) {
        return res.status(400).json({ error: 'NOT_IMAGE', message: '只能上傳圖片檔' });
      }
      const db = getDb();
      const doc = await db.collection('courseCategories').doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到班別' });

      const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const bucket = getStorage().bucket();
      const fileName = `courseCategories/poster_${req.params.id}_${uuidv4()}.${ext}`;
      const file = bucket.file(fileName);
      await file.save(req.file.buffer, { contentType: req.file.mimetype });
      const [url] = await file.getSignedUrl({ action: 'read', expires: '2035-01-01' });

      await db.collection('courseCategories').doc(req.params.id).update({ imageUrl: url, updatedAt: new Date() });
      res.json({ message: '班別照片已上傳', imageUrl: url });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// DELETE /course-categories/:id - 停用（軟刪）；?permanent=1 且底下無課程 → 硬刪
router.delete('/:id',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      if (req.query.permanent === '1') {
        const used = await db.collection('courses').where('categoryId', '==', req.params.id).limit(1).get();
        if (!used.empty) return res.status(409).json({ error: 'CATEGORY_IN_USE', message: '此班別下仍有梯次，請先移除或改掛其他班別' });
        await db.collection('courseCategories').doc(req.params.id).delete();
        return res.json({ message: '班別已永久刪除' });
      }
      await db.collection('courseCategories').doc(req.params.id).update({
        isActive: false, updatedAt: new Date(),
      });
      res.json({ message: '班別已停用' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

module.exports = router;
