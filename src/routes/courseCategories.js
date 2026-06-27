/**
 * 課程類別管理
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, checkPermission } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// GET /course-categories
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('courseCategories').orderBy('createdAt', 'asc').get();
    res.json({ categories: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /course-categories
router.post('/',
  authenticate, checkPermission('courses.manage'),
  [body('name').notEmpty().withMessage('請輸入類別名稱')],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const id = uuidv4();
      const now = new Date();
      const category = {
        id, name: req.body.name,
        description: req.body.description || '',
        color: req.body.color || '#8B1A1A',
        isActive: true,
        createdBy: req.staff.id,
        createdAt: now, updatedAt: now,
      };
      await db.collection('courseCategories').doc(id).set(category);
      res.status(201).json({ category, message: '類別建立成功' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// PUT /course-categories/:id
router.put('/:id',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const updates = { updatedAt: new Date() };
      ['name', 'description', 'color', 'isActive'].forEach(f => {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
      });
      await db.collection('courseCategories').doc(req.params.id).update(updates);
      res.json({ message: '類別已更新' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// DELETE /course-categories/:id
router.delete('/:id',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      await db.collection('courseCategories').doc(req.params.id).update({
        isActive: false, updatedAt: new Date(),
      });
      res.json({ message: '類別已停用' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

module.exports = router;
