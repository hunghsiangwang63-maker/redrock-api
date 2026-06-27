/**
 * 轉帳確認
 * POST /transfers/upload      上傳截圖
 * GET  /transfers/pending     待確認列表（工作人員）
 * PUT  /transfers/:id/confirm 確認收款
 * PUT  /transfers/:id/reject  拒絕
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate, authenticateAny } = require('../middleware/auth');
const { getDb, getStorage } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /transfers/upload - 會員上傳截圖
router.post('/upload', authenticateAny, upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'NO_FILE', message: '請上傳截圖' });
    const db = getDb();
    const storage = getStorage();
    const id = uuidv4();
    const { memberName, gymId, enrollmentId, courseId, courseName, amount, paymentMethod } = req.body;
    // 會員 token 一律用自己的 id，避免偽造他人 memberId
    const memberId = req.member?.id || req.body.memberId;

    // 上傳到 Firebase Storage
    const bucket = storage.bucket();
    const fileName = `transfers/${id}_${Date.now()}.jpg`;
    const file = bucket.file(fileName);
    await file.save(req.file.buffer, { metadata: { contentType: req.file.mimetype } });
    const [url] = await file.getSignedUrl({ action: 'read', expires: '2030-01-01' });

    // 建立轉帳紀錄
    const now = new Date();
    const transfer = {
      id, memberId, memberName: memberName || '',
      gymId, enrollmentId: enrollmentId || null,
      courseId: courseId || null, courseName: courseName || '',
      amount: parseInt(amount) || 0,
      paymentMethod: paymentMethod || 'cash',
      screenshotUrl: url, screenshotPath: fileName,
      status: 'pending',
      submittedAt: now, createdAt: now, updatedAt: now,
    };
    await db.collection('transferRecords').doc(id).set(transfer);
    res.status(201).json({ transfer, message: '截圖已上傳，等待工作人員確認' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /transfers/pending - 待確認列表
router.get('/pending', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? req.query.gymId : req.staff?.gymId;
    let ref = db.collection('transferRecords').where('status', '==', 'pending');
    if (gymId) ref = ref.where('gymId', '==', gymId);
    const snap = await ref.get();
    res.json({ transfers: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT /transfers/:id/confirm
router.put('/:id/confirm', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('transferRecords').doc(req.params.id).update({
      status: 'confirmed', confirmedBy: req.staff.id,
      confirmedAt: new Date(), updatedAt: new Date(),
      notes: req.body.notes || '',
    });
    res.json({ message: '已確認收款' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT /transfers/:id/reject
router.put('/:id/reject', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('transferRecords').doc(req.params.id).update({
      status: 'rejected', rejectedBy: req.staff.id,
      rejectedAt: new Date(), updatedAt: new Date(),
      rejectReason: req.body.reason || '',
    });
    res.json({ message: '已拒絕' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
