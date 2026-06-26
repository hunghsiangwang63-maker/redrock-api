const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { authenticate, authenticateAny, checkPermission, requireManagerOrStation, auditLog } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');

// ══════════════════════════════════════════════════════
// GET /course-adjustments/requests - 取得所有課程調整申請
// ══════════════════════════════════════════════════════
router.get('/requests', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    let ref = db.collection('courseAdjustmentRequests');
    if (status) ref = ref.where('status', '==', status);
    const snap = await ref.get();
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json({ requests });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ══════════════════════════════════════════════════════
// POST /course-adjustments/enrollments/:enrollmentId/refund-request
// ══════════════════════════════════════════════════════
router.post('/enrollments/:enrollmentId/refund-request',
  authenticateAny,
  [body('reason').notEmpty().withMessage('請填寫退費原因')],
  async (req, res) => {
    try {
      const db = getDb();
      const memberId = req.member?.id || req.body.memberId;

      // 先嘗試直接用 enrollmentId 找，找不到則用 courseId+memberId 找第一筆有效 enrollment
      let enrollDoc = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).doc(req.params.enrollmentId).get();
      if (!enrollDoc.exists) {
        // enrollmentId 可能是 courseId，改為查詢
        const snap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
          .where('courseId', '==', req.params.enrollmentId)
          .where('memberId', '==', memberId)
          .where('status', '==', 'confirmed')
          .limit(1).get();
        if (snap.empty) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名記錄' });
        enrollDoc = snap.docs[0];
      }
      const enrollment = { id: enrollDoc.id, ...enrollDoc.data() };

      if (enrollment.status === 'cancelled') return res.status(400).json({ error: 'ALREADY_CANCELLED', message: '此報名已取消' });
      if (enrollment.pauseStatus === 'paused') return res.status(400).json({ error: 'IS_PAUSED', message: '暫停中的課程請先恢復再申請退費' });

      const courseDoc = await db.collection('courses').doc(enrollment.courseId).get();
      const course = courseDoc.exists ? courseDoc.data() : null;
      const paidAmount = enrollment.paidAmount || 0;
      const today = dayjs().utcOffset(8).format('YYYY-MM-DD');
      const courseStartDate = course?.startDate || null;
      const perSessionDeduction = course?.perSessionDeduction ?? 850; // 每堂扣除金額，預設850
      const handlingFeeRate = course?.handlingFeeRate ?? 0.05; // 手續費率，預設5%

      let suggestedRefund = 0;
      let refundNote = '';

      if (!courseStartDate || today < courseStartDate) {
        // 開課前：扣5%手續費
        const fee = Math.ceil(paidAmount * handlingFeeRate);
        suggestedRefund = Math.max(0, paidAmount - fee);
        refundNote = `開課前申請，扣除手續費 NT$${fee}（${Math.round(handlingFeeRate * 100)}%）`;
      } else {
        // 開課後：計算已開課堂數（日期已過的場次，不論有無出席/請假）
        const sessionSnap = await db.collection('courseSessions')
          .where('courseId', '==', enrollment.courseId)
          .get();
        const heldSessions = sessionSnap.docs
          .map(d => d.data())
          .filter(s => s.date && s.date <= today).length;
        const deduction = heldSessions * perSessionDeduction;
        suggestedRefund = Math.max(0, paidAmount - deduction);
        refundNote = `開課後申請，已開課 ${heldSessions} 堂 × NT$${perSessionDeduction} = 扣除 NT$${deduction}`;
      }

      const reqId = `crefund_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      await db.collection('courseAdjustmentRequests').doc(reqId).set({
        id: reqId,
        type: 'refund',
        enrollmentId: req.params.enrollmentId,
        courseId: enrollment.courseId,
        courseName: enrollment.courseName || course?.name || '',
        memberId: enrollment.memberId,
        memberName: enrollment.memberName || '',
        paidAmount,
        suggestedRefund,
        refundNote,
        perSessionDeduction,
        handlingFeeRate,
        reason: req.body.reason,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      res.status(201).json({ success: true, requestId: reqId, suggestedRefund, refundNote });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// POST /course-adjustments/enrollments/:enrollmentId/pause-request
// ══════════════════════════════════════════════════════
router.post('/enrollments/:enrollmentId/pause-request',
  authenticateAny,
  [body('reason').notEmpty().withMessage('請填寫暫停原因')],
  async (req, res) => {
    try {
      const db = getDb();
      const memberId = req.member?.id || req.body.memberId;

      let enrollDoc = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).doc(req.params.enrollmentId).get();
      if (!enrollDoc.exists) {
        const snap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
          .where('courseId', '==', req.params.enrollmentId)
          .where('memberId', '==', memberId)
          .where('status', '==', 'confirmed')
          .limit(1).get();
        if (snap.empty) return res.status(404).json({ error: 'NOT_FOUND' });
        enrollDoc = snap.docs[0];
      }
      const enrollment = { id: enrollDoc.id, ...enrollDoc.data() };

      if (enrollment.status === 'cancelled') return res.status(400).json({ error: 'ALREADY_CANCELLED', message: '此報名已取消' });
      if (enrollment.pauseStatus === 'paused') return res.status(400).json({ error: 'ALREADY_PAUSED', message: '此課程報名已在暫停中' });

      const courseDoc = await db.collection('courses').doc(enrollment.courseId).get();
      const course = courseDoc.exists ? courseDoc.data() : null;
      if (course && course.pauseAllowed === false) return res.status(400).json({ error: 'PAUSE_NOT_ALLOWED', message: '此課程不允許申請暫停' });

      const reqId = `cpause_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      await db.collection('courseAdjustmentRequests').doc(reqId).set({
        id: reqId,
        type: 'pause',
        enrollmentId: req.params.enrollmentId,
        courseId: enrollment.courseId,
        courseName: enrollment.courseName || course?.name || '',
        memberId: enrollment.memberId,
        memberName: enrollment.memberName || '',
        reason: req.body.reason,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      res.status(201).json({ success: true, requestId: reqId });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// POST /course-adjustments/requests/:id/approve - 核准（退費或暫停）
// ══════════════════════════════════════════════════════
router.post('/requests/:id/approve',
  authenticate, requireManagerOrStation,
  async (req, res) => {
    try {
      const db = getDb();
      const reqDoc = await db.collection('courseAdjustmentRequests').doc(req.params.id).get();
      if (!reqDoc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
      const request = reqDoc.data();
      if (request.status !== 'pending') return res.status(400).json({ error: 'ALREADY_PROCESSED', message: '此申請已處理' });

      if (request.type === 'refund') {
        const finalRefund = req.body.finalRefund !== undefined ? Number(req.body.finalRefund) : request.suggestedRefund;
        // 標記報名取消
        await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).doc(request.enrollmentId).update({
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: `退費申請核准（退款 NT$${finalRefund}）`,
          updatedAt: new Date(),
        });
        // 從所有場次名單移除
        const sessionEnrollSnap = await db.collection('courseSessionEnrollments')
          .where('enrollmentId', '==', request.enrollmentId).get();
        const batch = db.batch();
        sessionEnrollSnap.docs.forEach(d => batch.update(d.ref, { status: 'cancelled', updatedAt: new Date() }));
        await batch.commit();
        // 更新申請狀態
        await db.collection('courseAdjustmentRequests').doc(req.params.id).update({
          status: 'approved', finalRefund,
          approvedBy: req.staff.id, approvedByName: req.staff.name, approvedAt: new Date(), updatedAt: new Date(),
        });
        return res.json({ success: true, message: `退費申請已核准，退款 NT$${finalRefund}` });
      }

      if (request.type === 'pause') {
        // 標記報名為暫停，並從所有未來場次移除
        await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).doc(request.enrollmentId).update({
          pauseStatus: 'paused',
          pausedAt: new Date(),
          pauseRequestId: req.params.id,
          updatedAt: new Date(),
        });
        // 從所有未來場次名單移除
        const today = new Date();
        const sessionEnrollSnap = await db.collection('courseSessionEnrollments')
          .where('enrollmentId', '==', request.enrollmentId)
          .where('status', '==', 'confirmed').get();
        const batch = db.batch();
        sessionEnrollSnap.docs.forEach(d => {
          batch.update(d.ref, { status: 'paused', updatedAt: new Date() });
        });
        await batch.commit();
        await db.collection('courseAdjustmentRequests').doc(req.params.id).update({
          status: 'approved',
          approvedBy: req.staff.id, approvedByName: req.staff.name, approvedAt: new Date(), updatedAt: new Date(),
        });
        return res.json({ success: true, message: '課程已暫停，學員已從場次名單移除' });
      }

      res.status(400).json({ error: 'UNKNOWN_TYPE' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// POST /course-adjustments/requests/:id/reject - 拒絕
// ══════════════════════════════════════════════════════
router.post('/requests/:id/reject',
  authenticate, requireManagerOrStation,
  async (req, res) => {
    try {
      const db = getDb();
      await db.collection('courseAdjustmentRequests').doc(req.params.id).update({
        status: 'rejected',
        rejectReason: req.body.reason || '',
        rejectedBy: req.staff.id, rejectedByName: req.staff.name, rejectedAt: new Date(), updatedAt: new Date(),
      });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// POST /course-adjustments/enrollments/:enrollmentId/restore - 管理員手動恢復暫停
// ══════════════════════════════════════════════════════
router.post('/enrollments/:enrollmentId/restore',
  authenticate, requireManagerOrStation,
  async (req, res) => {
    try {
      const db = getDb();
      const enrollDoc = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).doc(req.params.enrollmentId).get();
      if (!enrollDoc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
      const enrollment = enrollDoc.data();
      if (enrollment.pauseStatus !== 'paused') return res.status(400).json({ error: 'NOT_PAUSED', message: '此報名並非暫停狀態' });

      // 恢復報名狀態
      await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).doc(req.params.enrollmentId).update({
        pauseStatus: null,
        restoredAt: new Date(),
        restoredBy: req.staff.id,
        updatedAt: new Date(),
      });
      // 將 paused 的場次恢復（未來場次）
      const today = new Date();
      const sessionEnrollSnap = await db.collection('courseSessionEnrollments')
        .where('enrollmentId', '==', req.params.enrollmentId)
        .where('status', '==', 'paused').get();
      const batch = db.batch();
      sessionEnrollSnap.docs.forEach(d => {
        batch.update(d.ref, { status: 'confirmed', updatedAt: new Date() });
      });
      await batch.commit();
      res.json({ success: true, message: '課程已恢復，學員已重新加回場次名單' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

module.exports = router;

// ── GET /course-adjustments/member/:memberId - 查詢會員申請紀錄 ──
router.get('/member/:memberId', authenticateAny, async (req, res) => {
  try {
    const db = require('../config/firebase').getDb();
    const { COLLECTIONS } = require('../config/firebase');
    const { memberId } = req.params;
    // 會員只能查自己的
    if (req.member && req.member.id !== memberId) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }
    const snap = await db.collection(COLLECTIONS.COURSE_ADJUSTMENTS || 'courseAdjustmentRequests')
      .where('memberId', '==', memberId).get();
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json({ requests });
  } catch(err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
