// ⚠️ 臨時診斷路由（比照本專案既有慣例，如街口 UAT 驗測路由）——僅供本次驗證合約 PDF 修正並寄送
// demo 信件用，super_admin 限定，用完即從 index.js 移除並刪除此檔。
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getDb } = require('../config/firebase');

router.post('/course', authenticate, async (req, res) => {
  try {
    if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
    const db = getDb();
    const { memberId, courseId, demoEmail } = req.body;
    const courseService = require('../services/courseService');
    const { issueCourseContract } = require('../services/courseContractService');
    const { sendCourseContractPdf } = require('../services/emailService');

    const memberSnap = await db.collection('members').doc(memberId).get();
    const member = memberSnap.data();
    const courseSnap = await db.collection('courses').doc(courseId).get();
    const course = { id: courseId, ...courseSnap.data() };
    const category = await courseService.getCategoryOf(db, course.categoryId);
    const rules = courseService.resolveRules(course, category);

    const enrollSnap = await db.collection('courseEnrollments')
      .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
    const enrollments = enrollSnap.docs.map(d => d.data()).filter(e => e.status !== 'cancelled');
    const { taiwanToday } = require('../utils/taiwanDate');
    const today = taiwanToday();
    const futureSessions = enrollments.filter(e => !e.date || e.date >= today)
      .map(e => ({ date: e.date, startTime: e.startTime, endTime: e.endTime, gymId: e.gymId }));

    const headerSnap = await db.collection('courseRegistrations')
      .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
    const header = headerSnap.docs.map(d => d.data()).find(h => h.status !== 'cancelled');
    const fee = header?.fee ?? enrollments[0]?.enrollmentFee ?? 0;
    const paymentMethod = header?.paymentMethod || 'cash';
    let coursePlan = null;
    if (header?.installmentPlanId) {
      const planSnap = await db.collection('installmentPlans').doc(header.installmentPlanId).get();
      if (planSnap.exists) coursePlan = planSnap.data();
    }

    const { pdfBuffer } = await issueCourseContract({
      memberId, memberName: member.name, isGuest: false,
      course, futureSessions: futureSessions.length ? futureSessions : [{ date: course.startDate, startTime: '', endTime: '' }],
      fee, paymentMethod, coursePlan,
      refundFeeRate: rules.handlingFeeRate, refundPreStartFeeRate: rules.preStartFeeRate,
      gymId: course.gymId,
      portraitSignature: null, guardianSignature: null,
      dryRun: true,
    });
    await sendCourseContractPdf({ to: demoEmail, memberName: member.name, courseName: course.name, pdfBuffer });
    res.json({ ok: true, bytes: pdfBuffer.length, sentTo: demoEmail, memberName: member.name, courseName: course.name });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message, stack: err.stack }); }
});

router.post('/pass', authenticate, async (req, res) => {
  try {
    if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
    const db = getDb();
    const { memberId, passId, demoEmail, fee } = req.body;
    const { issuePassContract } = require('../services/passContractService');
    const { sendPassContractPdf } = require('../services/emailService');

    const memberSnap = await db.collection('members').doc(memberId).get();
    const member = memberSnap.data();
    const passSnap = await db.collection('memberPasses').doc(passId).get();
    const pass = passSnap.data();

    const { pdfBuffer } = await issuePassContract({
      memberId, memberName: member.name,
      passTypeName: pass.passTypeName, scope: pass.scope, targetGymId: pass.targetGymId,
      startDate: pass.startDate, endDate: pass.endDate,
      fee: fee || 0, paymentMethod: 'cash',
      gymId: pass.gymId || 'gym-hsinchu',
      portraitSignature: null, guardianSignature: null,
      installments: null,
      dryRun: true,
    });
    await sendPassContractPdf({ to: demoEmail, memberName: member.name, passTypeName: pass.passTypeName, pdfBuffer });
    res.json({ ok: true, bytes: pdfBuffer.length, sentTo: demoEmail, memberName: member.name, passTypeName: pass.passTypeName });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message, stack: err.stack }); }
});

module.exports = router;
