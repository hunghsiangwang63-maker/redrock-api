// ⚠️ 臨時診斷路由（比照本專案既有慣例）——僅供本次重新寄送葉菲芸課程合約 demo（帶入真實簽名），
// super_admin 限定，用完即從 index.js 移除並刪除此檔。
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

    const { pdfBuffer } = await issueCourseContract({
      memberId, memberName: member.name, isGuest: false,
      course, futureSessions: futureSessions.length ? futureSessions : [{ date: course.startDate, startTime: '', endTime: '' }],
      fee, paymentMethod, coursePlan: null,
      refundFeeRate: rules.handlingFeeRate, refundPreStartFeeRate: rules.preStartFeeRate,
      gymId: course.gymId,
      portraitSignature: header?.portraitSignature || null,
      guardianSignature: header?.guardianSignature || null,
      dryRun: true,
    });

    if (req.query.raw === '1') {
      res.set('Content-Type', 'application/pdf');
      return res.send(pdfBuffer);
    }

    await sendCourseContractPdf({ to: demoEmail, memberName: member.name, courseName: course.name, pdfBuffer });
    res.json({ ok: true, bytes: pdfBuffer.length, sentTo: demoEmail, memberName: member.name, courseName: course.name });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message, stack: err.stack }); }
});

module.exports = router;
