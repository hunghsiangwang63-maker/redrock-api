// ⚠️ 臨時診斷路由（比照本專案既有慣例）——批次補寄士林紅石9月課程（技巧班/小蜘蛛人）課程服務同意書，
// super_admin 限定，用完即從 index.js 移除並刪除此檔。
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getDb } = require('../config/firebase');

const COURSE_IDS = [
  '78f3b70e-0e81-424c-b59c-6e8b4fd483e4', // 技巧班 9-10月週五A班
  '63951125-500a-485f-af48-99e14499fd74', // 技巧班 9-10月週日A班
  '53a7efdc-fc8d-4d8d-8229-9983bbbb0168', // 小蜘蛛人初級班 9-1月週日A班
];
// 王秀慧的 header.isGuest 為舊資料殘留（已認領為真實會員，memberId 非 guest_ 開頭）
const FORCE_REAL_MEMBER = new Set(['c48448a8-53e5-44db-acf3-7590e69da1ba']);

router.post('/', authenticate, async (req, res) => {
  if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  const db = getDb();
  const courseService = require('../services/courseService');
  const { issueCourseContract } = require('../services/courseContractService');
  const { taiwanToday } = require('../utils/taiwanDate');
  const today = taiwanToday();
  const results = [];

  for (const courseId of COURSE_IDS) {
    const courseSnap = await db.collection('courses').doc(courseId).get();
    const course = { id: courseId, ...courseSnap.data() };
    const category = await courseService.getCategoryOf(db, course.categoryId);
    const rules = courseService.resolveRules(course, category);

    const hSnap = await db.collection('courseRegistrations').where('courseId', '==', courseId).get();
    const headers = hSnap.docs.map(d => d.data()).filter(h => h.status !== 'cancelled');

    for (const h of headers) {
      const trueGuest = h.isGuest && !FORCE_REAL_MEMBER.has(h.memberId);
      const enSnap = await db.collection('courseEnrollments')
        .where('courseId', '==', courseId).where('memberId', '==', h.memberId).get();
      const enrollments = enSnap.docs.map(d => d.data()).filter(e => e.status !== 'cancelled' && !e.isMakeup && !e.isTrial);
      const futureSessions = enrollments.filter(e => !e.date || e.date >= today)
        .map(e => ({ date: e.date, startTime: e.startTime, endTime: e.endTime, gymId: e.gymId }));

      let guestEmail = null, guestPhone = null;
      if (trueGuest) {
        const anyEn = enrollments[0];
        guestEmail = anyEn?.contactEmail || null;
        guestPhone = anyEn?.contactPhone || h.contactPhone || null;
        if (!guestEmail) { results.push({ name: h.memberName, course: course.name, ok: false, reason: 'NO_GUEST_EMAIL' }); continue; }
      }

      try {
        await issueCourseContract({
          memberId: h.memberId, memberName: h.memberName,
          isGuest: trueGuest,
          guestEmail, guestPhone, guestBirthday: null,
          course, futureSessions: futureSessions.length ? futureSessions : [{ date: course.startDate, startTime: '', endTime: '' }],
          fee: h.fee, paymentMethod: h.paymentMethod,
          coursePlan: null,
          refundFeeRate: rules.handlingFeeRate, refundPreStartFeeRate: rules.preStartFeeRate,
          gymId: course.gymId,
          portraitSignature: h.portraitSignature || null,
          guardianSignature: h.guardianSignature || null,
        });
        results.push({ name: h.memberName, course: course.name, ok: true, sessions: futureSessions.length });
      } catch (e) {
        results.push({ name: h.memberName, course: course.name, ok: false, reason: e.message });
      }
    }
  }
  res.json({ results });
});

module.exports = router;
