const { taiwanToday } = require('../utils/taiwanDate');
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { authenticate, authenticateAny, checkPermission, requireManagerOrStation, auditLog } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');
const courseService = require('../services/courseService');
const courseRegistrationService = require('../services/courseRegistrationService');
const { recordTransaction } = require('../utils/revenueLedger');
const { checkMemberOwnership } = require('../utils/memberOwnership');

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
      // 支援家長代子女：優先用 body.memberId（前端傳報名對象），驗擁有權；否則用登入者本人
      const memberId = req.body.memberId || req.member?.id;
      const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 403 });
      if (deny) return res.status(deny.status).json(deny.body);

      // 解析 courseId（route param 可能是 enrollmentId 或 courseId）
      let courseId = req.params.enrollmentId;
      const directDoc = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).doc(req.params.enrollmentId).get();
      if (directDoc.exists) courseId = directDoc.data().courseId;

      // 取該會員此課程「所有」有效報名（週課為多筆；含請假/候補）
      const allSnap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
        .where('courseId', '==', courseId)
        .where('memberId', '==', memberId)
        .where('status', 'in', ['confirmed', 'leave', 'waitlist'])
        .get();
      if (allSnap.empty) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到有效的報名記錄' });
      const all = allSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      // 補課/試上場次＝當天行為，不可申請退費（政策 2026-07-17；如無法出席請取消補課）
      if (all.every(e => e.isMakeup || e.isTrial)) {
        return res.status(400).json({ error: 'MAKEUP_NO_ADJUST', message: '補課／試上場次不可申請退費；如無法出席請於上課一天前取消補課' });
      }
      const rep = all[0];
      if (rep.pauseStatus === 'paused') return res.status(400).json({ error: 'IS_PAUSED', message: '暫停中的課程請先恢復再申請退費' });

      // 重複申請擋：此課程已有審核中的退費/暫停申請 → 不可再送（避免重複 pending → 重複核准重複退款）
      const dupSnap = await db.collection('courseAdjustmentRequests')
        .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
      if (dupSnap.docs.some(d => d.data().status === 'pending')) {
        return res.status(409).json({ error: 'REQUEST_PENDING', message: '此課程已有審核中的申請，請等待審核結果' });
      }

      const courseDoc = await db.collection('courses').doc(courseId).get();
      const course = courseDoc.exists ? courseDoc.data() : null;
      // 已付金額（Phase 3：改讀 courseRegistrations header.fee，不用再加總 N 筆 slot——
      // 原本 all.reduce(...paidAmount) 這個欄位在課程從未被寫入、恆為 0，實際一路都是走 enrollmentFee 那個 fallback）
      let paidAmount = 0;
      try {
        const hSnap = await db.collection('courseRegistrations')
          .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
        const h = hSnap.docs.map(d => d.data()).find(x => x.status !== 'cancelled');
        paidAmount = h ? (h.fee || 0) : all.reduce((s, e) => s + (e.enrollmentFee || 0), 0);
      } catch (e) { paidAmount = all.reduce((s, e) => s + (e.enrollmentFee || 0), 0); }

      // 實際已收金額（2026-08-09 修）：若此會員此課程有分期計畫，退款上限只能是「分期實際已收」，
      // 不可用 paidAmount（課程總費用，僅供下面每堂單價計算用）——避免分期還沒繳完就退費時，
      // 退得比實收金額還多。無分期計畫（一次付清）時 actuallyPaid 就等於 paidAmount，行為不變。
      let actuallyPaid = paidAmount;
      let installmentPlanId = null;
      try {
        const planSnap = await db.collection('installmentPlans')
          .where('relatedType', '==', 'course').where('relatedId', '==', courseId).where('memberId', '==', memberId).get();
        const plan = planSnap.docs.map(d => ({ id: d.id, ...d.data() })).find(p => p.status !== 'cancelled');
        if (plan) {
          installmentPlanId = plan.id;
          actuallyPaid = (plan.installments || []).filter(i => i.status === 'paid').reduce((s, i) => s + (i.amount || 0), 0);
        }
      } catch (e) {}
      const today = taiwanToday(); // 台灣日期
      const courseStartDate = course?.startDate || null;

      // 週課／工作坊退費計算式完全不同：週課看「剩餘堂數價金」，工作坊整筆退課、看「距開課天數」比例。
      let suggestedRefund, refundNote;
      let totalSessions = null, heldSessions = null, remainingSessions = null, remainingValue = null, feeRate = null, fee = null, perSessionDeduction = null, handlingFeeRate = null;

      if (course?.type === 'workshop') {
        // 工作坊：整筆退課，依距開課天數分級比例退費（梯次可個別設定 course.refundTiers；見 computeWorkshopRefund）
        const startDates = all.map(e => e.date).filter(Boolean).sort();
        const workshopStart = startDates[0] || courseStartDate || today;
        const wr = courseService.computeWorkshopRefund(course, { paidAmount, actuallyPaid, startDate: workshopStart, today });
        suggestedRefund = wr.suggestedRefund;
        refundNote = wr.refundNote;
      } else {
        // 週課退費（2026-07-18 改版）：退費＝剩餘堂數價金 − 手續費（剩餘價金 × 費率）
        // 每堂單價＝已繳金額 ÷ 總堂數；剩餘堂數＝總堂數 − 已開課堂數（日期已過，不論出席/請假）。
        // 費率雙軌（皆班別/梯次可調）：開課前 preStartFeeRate 預設 5%；開課後 handlingFeeRate 預設 20%。
        const _refundRules = courseService.resolveRules(course || {}, await courseService.getCategoryOf(db, course?.categoryId));
        perSessionDeduction = _refundRules.perSessionDeduction;
        handlingFeeRate = _refundRules.handlingFeeRate;
        const sessionSnap = await db.collection('courseSessions')
          .where('courseId', '==', courseId)
          .get();
        const _allSess = sessionSnap.docs.map(d => d.data()).filter(s => s.status !== 'cancelled');
        totalSessions = _allSess.length || 1;
        heldSessions = _allSess.filter(s => s.date && s.date <= today).length;
        remainingSessions = Math.max(0, totalSessions - heldSessions);
        const perSession = paidAmount / totalSessions;
        remainingValue = Math.round(perSession * remainingSessions);
        const preStart = courseStartDate ? (today < courseStartDate) : (heldSessions === 0); // 開課前判定（無起始日以已開課堂數推）
        feeRate = preStart ? (_refundRules.preStartFeeRate ?? 0.05) : (handlingFeeRate ?? 0.2); // 開課前預設 5%／開課後預設 20%，皆班別/梯次可調
        fee = Math.round(remainingValue * feeRate);
        const rawSuggestedRefund = Math.max(0, remainingValue - fee);
        // 退款上限＝實際已收金額（分期未繳完時），避免退得比實收的錢還多；一次付清情境 actuallyPaid===paidAmount，不受影響
        suggestedRefund = Math.min(rawSuggestedRefund, actuallyPaid);
        const cappedByInstallment = installmentPlanId && suggestedRefund < rawSuggestedRefund;
        refundNote = `剩餘 ${remainingSessions}/${totalSessions} 堂 × 每堂 NT$${Math.round(perSession)} ＝ 剩餘價金 NT$${remainingValue}；手續費 ${Math.round(feeRate * 100)}%（${preStart ? '開課前' : '開課後'}）＝NT$${fee}`
          + (cappedByInstallment ? `；因分期尚未繳完，退款上限為實收金額 NT$${actuallyPaid}` : '');
      }
      // 建議退費佔已繳金額比例（供審核 modal 顯示「建議 NT$X，Y%」；週課/工作坊通用）
      const suggestedPercentage = paidAmount > 0 ? Math.round((suggestedRefund / paidAmount) * 100) : 0;

      const reqId = `crefund_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      await db.collection('courseAdjustmentRequests').doc(reqId).set({
        id: reqId,
        type: 'refund',
        enrollmentId: rep.id,
        courseId,
        courseName: rep.courseName || course?.name || '',
        gymId: rep.gymId || null,
        memberId,
        memberName: rep.memberName || '',
        paidAmount,
        actuallyPaid, installmentPlanId, // 2026-08-09：分期退款上限依據，approve 時作廢分期計畫用
        suggestedRefund,
        suggestedPercentage,
        refundNote,
        courseType: course?.type || 'weekly', // 供審核端知道套用哪套公式（週課/工作坊），供稽核
        totalSessions, heldSessions, remainingSessions, remainingValue, feeRate, fee, // 政府公式明細（週課專用，工作坊為 null）
        perSessionDeduction,
        handlingFeeRate,
        reason: req.body.reason,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // 凍結該課程所有有效報名（refundPending）：審核中即取消課程學員入場資格，
      // 並擋 請假/補課/申請暫停/再申請退費；退回（reject）時清旗標恢復、核准則取消報名。
      const frz = db.batch();
      const now = new Date();
      allSnap.docs.forEach(d => frz.update(d.ref, { refundPending: true, refundRequestId: reqId, updatedAt: now }));
      await frz.commit();

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
      // 支援家長代子女：優先 body.memberId + 驗擁有權
      const memberId = req.body.memberId || req.member?.id;
      const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 403 });
      if (deny) return res.status(deny.status).json(deny.body);

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
      // 補課/試上場次＝當天行為，不可申請暫停（政策 2026-07-17）
      {
        const _adjAll = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
          .where('courseId', '==', enrollment.courseId).where('memberId', '==', enrollment.memberId)
          .where('status', 'in', ['confirmed', 'leave', 'waitlist']).get();
        if (_adjAll.docs.length && _adjAll.docs.every(d => d.data().isMakeup || d.data().isTrial)) {
          return res.status(400).json({ error: 'MAKEUP_NO_ADJUST', message: '補課／試上場次不可申請暫停；如無法出席請於上課一天前取消補課' });
        }
      }
      if (enrollment.pauseStatus === 'paused') return res.status(400).json({ error: 'ALREADY_PAUSED', message: '此課程報名已在暫停中' });
      if (enrollment.refundPending) return res.status(400).json({ error: 'REFUND_PENDING', message: '此課程退費申請審核中，暫不可申請暫停' });

      // 重複申請擋：此課程已有審核中的申請（退費/暫停）→ 不可再送
      const dupSnap = await db.collection('courseAdjustmentRequests')
        .where('courseId', '==', enrollment.courseId).where('memberId', '==', enrollment.memberId).get();
      if (dupSnap.docs.some(d => d.data().status === 'pending')) {
        return res.status(409).json({ error: 'REQUEST_PENDING', message: '此課程已有審核中的申請，請等待審核結果' });
      }

      const courseDoc = await db.collection('courses').doc(enrollment.courseId).get();
      const course = courseDoc.exists ? courseDoc.data() : null;
      if (course && course.pauseAllowed === false) return res.status(400).json({ error: 'PAUSE_NOT_ALLOWED', message: '此課程不允許申請暫停' });

      const reqId = `cpause_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      await db.collection('courseAdjustmentRequests').doc(reqId).set({
        id: reqId,
        type: 'pause',
        enrollmentId: enrollment.id,
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
        let finalRefund = req.body.finalRefund !== undefined ? Number(req.body.finalRefund) : request.suggestedRefund;
        // 退款金額 clamp：不可為負、不可超過「實際已收金額」（有分期計畫時用 actuallyPaid，避免店員把
        // finalRefund 改高繞過申請當下算好的分期上限；無分期計畫時 actuallyPaid 缺省回退 paidAmount，行為不變）
        if (!Number.isFinite(finalRefund)) return res.status(400).json({ error: 'INVALID_REFUND', message: '退款金額無效' });
        const refundCap = request.actuallyPaid != null ? Number(request.actuallyPaid) : (Number(request.paidAmount) || 0);
        finalRefund = Math.max(0, Math.min(finalRefund, refundCap));
        // 防重複退款：核准當下該會員此課程須仍有有效報名（若已被另一筆申請核准退費/取消 → 擋）
        const activeSnap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
          .where('courseId', '==', request.courseId).where('memberId', '==', request.memberId).get();
        const hasActive = activeSnap.docs.some(d => ['confirmed', 'leave', 'waitlist'].includes(d.data().status));
        if (!hasActive) {
          return res.status(400).json({ error: 'NO_ACTIVE_ENROLLMENT', message: '此會員於本課程已無有效報名（可能已退費或取消），不可重複核准退費' });
        }
        // 取消該會員此課程「所有」有效報名，釋放名額並遞補候補
        const cancelled = await courseService.cancelCourseEnrollments({
          courseId: request.courseId,
          memberId: request.memberId,
          reason: `退費申請核准（退款 NT$${finalRefund}）`,
        });
        // 課程退費 → 還原定期票「此課程」重疊補償延長（政策 2026-07-17；不阻斷）
        try { await require('../services/passOverlapService').revertCourseOverlapExtension({ memberId: request.memberId, courseId: request.courseId }); }
        catch (e) { console.error('重疊補償還原失敗（退費已核准）:', e.message); }
        // 分期計畫整筆作廢（2026-08-09；若有）：已繳期數各自沖銷一筆負向 refund 交易、未繳期數直接作廢，
        // 避免會員退掉課程後仍背負分期債務（不論 finalRefund 是否為 0 都要作廢，課程本身都已取消）
        if (request.installmentPlanId) {
          // skipPaidReversal:true——已繳期數的退款已經算在下面的 course_refund 交易裡，這裡只作廢未繳期數，
          // 避免跟 cancelInstallmentPlan 預設的「已繳期數也沖銷」重複退款
          try { await require('../services/installmentService').cancelInstallmentPlan(db, request.installmentPlanId, { reason: '課程退費核准', skipPaidReversal: true }); }
          catch (e) { console.error('分期計畫作廢失敗（退費已核准）:', e.message); }
        }
        // 記負向交易（退款），記帳失敗不阻擋核准。認列日＝該課程最後一堂課（與報名費同時結算）
        if (finalRefund > 0) {
          try {
            let recognitionDate = null;
            try {
              const cd = await db.collection('courses').doc(request.courseId).get();
              if (cd.exists) { const c = cd.data(); recognitionDate = c.endDate || c.unlimitedPracticeEnd || null; }
            } catch (e) {}
            await recordTransaction(db, {
              gymId: request.gymId || null,
              type: 'course_refund',
              totalAmount: -Math.abs(finalRefund),
              paymentMethod: 'refund',
              memberId: request.memberId,
              memberName: request.memberName || '',
              relatedId: request.id,
              notes: `課程退費（${request.courseName || ''}）`,
              staffId: req.staff.id,
              staffName: req.staff.name,
              recognitionDate,
            });
          } catch (e) { console.error('退費記帳失敗', e.message); }
        }
        await db.collection('courseAdjustmentRequests').doc(req.params.id).update({
          status: 'approved', finalRefund, cancelledCount: cancelled,
          approvedBy: req.staff.id, approvedByName: req.staff.name, approvedAt: new Date(), updatedAt: new Date(),
        });
        return res.json({ success: true, message: `退費申請已核准，退款 NT$${finalRefund}（已取消 ${cancelled} 堂報名）` });
      }

      if (request.type === 'pause') {
        const today = taiwanToday(); // 台灣日期
        const now = new Date();
        // 暫停該會員此課程「所有未來」有效報名
        const snap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
          .where('courseId', '==', request.courseId)
          .where('memberId', '==', request.memberId)
          .where('status', '==', 'confirmed')
          .get();
        let paused = 0;
        for (const d of snap.docs) {
          if ((d.data().date || '') < today) continue; // 已上的堂不動
          await d.ref.update({ pauseStatus: 'paused', pausedAt: now, pauseRequestId: req.params.id, updatedAt: now });
          paused++;
        }
        // 同步 header（供 members.js buildCourseMemberList 改讀 header 後仍正確排除暫停中會員）
        if (paused > 0) {
          try { await courseRegistrationService.updateHeaderPauseStatus(db, request.memberId, request.courseId, 'paused'); }
          catch (e) { console.error('header pauseStatus 同步失敗（暫停）', e.message); }
        }
        await db.collection('courseAdjustmentRequests').doc(req.params.id).update({
          status: 'approved', pausedCount: paused,
          approvedBy: req.staff.id, approvedByName: req.staff.name, approvedAt: new Date(), updatedAt: new Date(),
        });
        return res.json({ success: true, message: `課程已暫停（${paused} 堂未來場次）` });
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
      const reqDoc = await db.collection('courseAdjustmentRequests').doc(req.params.id).get();
      if (!reqDoc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
      const request = reqDoc.data();
      if (request.status !== 'pending') return res.status(400).json({ error: 'ALREADY_PROCESSED', message: '此申請已處理' });

      await reqDoc.ref.update({
        status: 'rejected',
        rejectReason: req.body.reason || '',
        rejectedBy: req.staff.id, rejectedByName: req.staff.name, rejectedAt: new Date(), updatedAt: new Date(),
      });

      // 退費申請被退回 → 解除凍結（refundPending），會員恢復課程學員資格與請假/補課等操作
      if (request.type === 'refund') {
        const snap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
          .where('courseId', '==', request.courseId).where('memberId', '==', request.memberId).get();
        const batch = db.batch();
        const now = new Date();
        snap.docs.filter(d => d.data().refundPending === true)
          .forEach(d => batch.update(d.ref, { refundPending: false, refundRequestId: null, updatedAt: now }));
        await batch.commit();
      }
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
      // 同步 header：此 API 只恢復單一 enrollmentId（暫停時可能一次暫停多堂未來場次），
      // 要先確認該會員此課程「已無其他仍暫停中的場次」才把 header 的 pauseStatus 清掉，
      // 否則只恢復其中一堂時會誤把 header 標成「已恢復」。
      try {
        // 單一等值查詢＋記憶體過濾（避免 courseId+memberId+pauseStatus 三欄複合索引，本專案慣例）
        const remainSnap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
          .where('memberId', '==', enrollment.memberId).get();
        const stillPaused = remainSnap.docs.some(d => {
          const x = d.data();
          return x.courseId === enrollment.courseId && x.pauseStatus === 'paused';
        });
        if (!stillPaused) {
          await courseRegistrationService.updateHeaderPauseStatus(db, enrollment.memberId, enrollment.courseId, null);
        }
      } catch (e) { console.error('header pauseStatus 同步失敗（恢復）', e.message); }
      res.json({ success: true, message: '課程已恢復，學員已重新加回場次名單' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

module.exports = router;

// ── GET /course-adjustments/member/:memberId - 查詢會員申請紀錄 ──
router.get('/member/:memberId', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const { memberId } = req.params;
    // 會員只能查自己或子會員的
    const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 403 });
    if (deny) return res.status(deny.status).json(deny.body);
    const snap = await db.collection(COLLECTIONS.COURSE_ADJUSTMENTS || 'courseAdjustmentRequests')
      .where('memberId', '==', memberId).get();
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json({ requests });
  } catch(err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
