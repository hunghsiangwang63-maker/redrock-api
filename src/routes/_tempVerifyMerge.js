// TEMP：驗證真實合併後程式碼（非模擬重寫）——用真實課程資料呼叫正式 issueCourseContract(attachOnly)
// + notifyRegReceived(attachments)，但收件人覆蓋成測試信箱、完事即刪除本檔。
const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const { authenticate } = require('../middleware/auth');
const courseService = require('../services/courseService');

router.get('/verify', authenticate, async (req, res) => {
  if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  const db = getDb();
  const courseId = req.query.courseId || '';
  let createdContractId = null;
  try {
    const courseDoc = await db.collection('courses').doc(courseId).get();
    if (!courseDoc.exists) return res.status(404).json({ error: 'COURSE_NOT_FOUND' });
    const course = { id: courseDoc.id, ...courseDoc.data() };
    const category = await courseService.getCategoryOf(db, course.categoryId);
    const contractRules = courseService.resolveRules(course, category);

    const today = require('../utils/taiwanDate').taiwanToday();
    const sessionsSnap = await db.collection('courseSessions').where('courseId', '==', courseId).where('status', '==', 'scheduled').get();
    const futureSessions = sessionsSnap.docs.map(d => d.data()).filter(s => s.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    if (!futureSessions.length) return res.status(400).json({ error: 'NO_FUTURE_SESSIONS' });

    // 找一位有簽名的真實學員（葉菲芸），用她的簽名/生日資料，但收件人覆蓋成測試信箱
    const enrSnap = await db.collection('courseRegistrations').where('courseId', '==', courseId).limit(20).get();
    const header = enrSnap.docs.map(d => d.data()).find(h => h.portraitSignature) || enrSnap.docs[0]?.data();
    if (!header) return res.status(404).json({ error: 'NO_REGISTRATION_FOUND' });

    const memberDoc = await db.collection('members').doc(header.memberId).get();
    const member = memberDoc.exists ? memberDoc.data() : null;

    const { issueCourseContract } = require('../services/courseContractService');
    const contractResult = await issueCourseContract({
      memberId: header.memberId, memberName: header.memberName || member?.name || '',
      isGuest: false,
      course, futureSessions, fee: header.fee || 0, paymentMethod: header.paymentMethod || 'cash',
      coursePlan: null,
      refundFeeRate: contractRules.handlingFeeRate ?? 0.2,
      refundPreStartFeeRate: contractRules.preStartFeeRate ?? 0,
      gymId: futureSessions[0].gymId || course.gymId,
      portraitSignature: header.portraitSignature || null,
      guardianSignature: header.guardianSignature || null,
      attachOnly: true,
    });
    createdContractId = contractResult.contractId;

    const allSnap = await db.collection('courseSessions').where('courseId', '==', courseId).get();
    const notifySessions = allSnap.docs.map(d => d.data())
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''))
      .map(s => ({ date: s.date, startTime: s.startTime, endTime: s.endTime, cancelled: s.status === 'cancelled' }));
    const validCount = notifySessions.filter(s => !s.cancelled).length;

    const _rn = require('../services/registrationNotify');
    await _rn.notifyRegReceived({
      memberId: header.memberId, memberName: header.memberName || member?.name || '',
      to: 'chihchiu_chu@yahoo.com.tw', // 覆蓋成測試信箱，不寄給真實會員
      typeLabel: '課程',
      itemName: course.name, gymId: futureSessions[0].gymId || course.gymId,
      fee: header.fee || 0, paymentMethod: header.paymentMethod || 'cash',
      massage: _rn.isMassage(course.name),
      sessions: notifySessions,
      installmentInfo: null,
      attachments: [{ filename: `課程服務同意書_${course.name}.pdf`, content: contractResult.pdfBuffer.toString('base64') }],
    });

    res.json({
      ok: true, sentTo: 'chihchiu_chu@yahoo.com.tw (覆蓋，非真實會員信箱)',
      courseId, courseName: course.name, memberName: header.memberName,
      pdfBytes: contractResult.pdfBuffer.length,
      totalSlots: notifySessions.length, validCount,
      contractIdCreated: createdContractId,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  } finally {
    // 清乾淨：不留驗證用的稽核紀錄（PDF Storage 檔一併刪，避免殘留）
    if (createdContractId) {
      try {
        const { getStorage } = require('../config/firebase');
        await getStorage().bucket().file(`course-contracts/${createdContractId}.pdf`).delete().catch(() => {});
        await db.collection('courseContracts').doc(createdContractId).delete();
      } catch (e2) { /* 清理失敗不影響回應 */ }
    }
  }
});

module.exports = router;
