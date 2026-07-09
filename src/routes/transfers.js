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

// POST /transfers/upload - 會員提交轉帳待確認（截圖或填寫資料皆可，擇一即可）
router.post('/upload', authenticateAny, upload.single('screenshot'), async (req, res) => {
  try {
    const db = getDb();
    const id = uuidv4();
    const {
      memberName, gymId, enrollmentId, courseId, courseName, amount,
      orderType, refId, orderName, bankLastFive, bankName, paymentDate,
    } = req.body;
    // 會員 token 一律用自己的 id，避免偽造他人 memberId
    const memberId = req.member?.id || req.body.memberId;

    // 截圖或填寫資料(末五碼)至少其一
    const last5 = (bankLastFive || '').trim();
    if (!req.file && !last5) {
      return res.status(400).json({ error: 'NO_PROOF', message: '請上傳轉帳截圖，或填寫帳號末五碼' });
    }

    // 有截圖才上傳到 Firebase Storage
    let url = null, fileName = null;
    if (req.file) {
      const storage = getStorage();
      const bucket = storage.bucket();
      fileName = `transfers/${id}_${Date.now()}.jpg`;
      const file = bucket.file(fileName);
      await file.save(req.file.buffer, { metadata: { contentType: req.file.mimetype } });
      [url] = await file.getSignedUrl({ action: 'read', expires: '2030-01-01' });
    }

    // 建立轉帳紀錄
    const now = new Date();
    const transfer = {
      id, memberId, memberName: memberName || '',
      gymId,
      // 訂單型別（course/experience/...）；相容舊欄位 enrollmentId/courseId
      orderType: orderType || (enrollmentId ? 'course' : null),
      refId: refId || enrollmentId || null,
      orderName: orderName || courseName || '',
      enrollmentId: enrollmentId || null,
      courseId: courseId || null, courseName: courseName || '',
      amount: Math.max(0, Math.min(parseInt(amount) || 0, 1000000)), // clamp：非負、上限 100 萬（防負數/超大值污染報表）
      paymentMethod: 'transfer',
      screenshotUrl: url, screenshotPath: fileName,   // 無截圖則為 null
      bankLastFive: last5 || null,
      bankName: (bankName || '').trim() || null,
      paymentDate: paymentDate || null,
      status: 'pending',
      submittedAt: now, createdAt: now, updatedAt: now,
    };
    await db.collection('transferRecords').doc(id).set(transfer);
    res.status(201).json({ transfer, message: '已提交，等待工作人員確認收款' });
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
    const ref = db.collection('transferRecords').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此轉帳紀錄' });
    const t = doc.data();
    // 收款確認權限：現金→值班 operator 或管理員；轉帳→僅管理員
    const isManager = ['super_admin', 'gym_manager'].includes(req.staff?.role);
    const isStationMode = ['operator', 'station'].includes(req.staff?.type);
    if (t.paymentMethod === 'cash') {
      if (!isManager && !isStationMode) return res.status(403).json({ error: 'MANAGER_OR_STATION_REQUIRED', message: '現金收款確認限值班人員或管理員' });
    } else {
      if (!isManager) return res.status(403).json({ error: 'MANAGER_REQUIRED', message: '轉帳收款確認限管理員' });
    }
    if (t.status === 'confirmed') return res.json({ message: '已確認收款' }); // 冪等：避免重複確認
    const now = new Date();

    // 硬化：確認收款前先檢查連動訂單是否存在，避免「轉帳已標確認、訂單卻沒開通」
    const ORDER_COLL = {
      experience: 'experienceBookings', course: 'courseEnrollments',
      competition: 'competitionRegistrations', rental: 'equipmentRentals', team_member: 'teamApplications',
    };
    if (t.orderType && t.refId && ORDER_COLL[t.orderType]) {
      const orderSnap = await db.collection(ORDER_COLL[t.orderType]).doc(t.refId).get();
      if (!orderSnap.exists) {
        return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: '查無對應的訂單（可能已刪除），無法確認收款。如需處理請改用「退回」。' });
      }
    }

    await ref.update({
      status: 'confirmed', confirmedBy: req.staff.id,
      confirmedAt: now, updatedAt: now, notes: req.body.notes || '',
    });
    // 依訂單型別確認底層付款（side-effect 失敗不阻斷收款確認）
    try {
      const by = req.staff.id, byName = req.staff.name;
      if (t.orderType === 'experience' && t.refId) {
        await db.collection('experienceBookings').doc(t.refId).update({
          status: 'confirmed', confirmedBy: by, confirmedByName: byName, confirmedAt: now, updatedAt: now,
        });
      } else if (t.orderType === 'course' && t.refId) {
        // 課程營收已於報名時(courses.js enroll, deferPayment=false)記入(認列＝最後一堂課)，此處僅標記付款確認
        await db.collection('courseEnrollments').doc(t.refId).update({ paymentConfirmed: true, updatedAt: now });
      } else if (t.orderType === 'competition' && t.refId) {
        await db.collection('competitionRegistrations').doc(t.refId).update({
          paymentStatus: 'confirmed', paidAt: now, paidConfirmedBy: by, paidConfirmedByName: byName, updatedAt: now,
        });
        // 記比賽營收（預收，認列在比賽前一天）；helper 冪等
        try { await require('../services/competitionService').recordCompetitionRevenue({ db, regId: t.refId, sign: 1, staffId: by, staffName: byName }); }
        catch (e) { console.error('比賽轉帳記帳失敗', e.message); }
      } else if (t.orderType === 'rental' && t.refId) {
        await db.collection('equipmentRentals').doc(t.refId).update({
          paymentStatus: 'confirmed', status: 'active', confirmedBy: by, confirmedByName: byName, confirmedAt: now, updatedAt: now,
        });
      } else if (t.orderType === 'team_member' && t.refId) {
        const appRef = db.collection('teamApplications').doc(t.refId);
        await appRef.update({
          paymentStatus: 'confirmed', status: 'active', paidAt: now, paidConfirmedBy: by, paidConfirmedByName: byName, updatedAt: now,
        });
        // 開通隊員折扣資格（依年度）
        const app = (await appRef.get()).data();
        if (app?.memberId && app?.year) {
          await require('../services/teamMemberService').setTeamMember({
            memberId: app.memberId, since: `${app.year}-01-01`, until: `${app.year}-12-31`, staffId: by,
          });
        }
      }
    } catch (e) { console.error('transfer confirm side-effect:', e.message); }
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
