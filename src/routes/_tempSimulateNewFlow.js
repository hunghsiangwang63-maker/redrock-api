// ⚠️ 臨時診斷路由（比照本專案既有慣例）——模擬「課程報名成功通知信附合約」與「定期票合約加cc館方」
// 兩種新版信件內容供審閱，super_admin 限定，用完即從 index.js 移除並刪除此檔。
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getDb } = require('../config/firebase');

// ── 模擬版：課程報名成功通知信（合併附上課程服務同意書 PDF），日期標註停課 ──
router.post('/course', authenticate, async (req, res) => {
  try {
    if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
    const db = getDb();
    const { memberId, courseId, demoEmail } = req.body;
    const courseService = require('../services/courseService');
    const { issueCourseContract } = require('../services/courseContractService');
    const { sendEmail } = require('../services/emailService');
    const { taiwanToday } = require('../utils/taiwanDate');

    const memberSnap = await db.collection('members').doc(memberId).get();
    const member = memberSnap.data();
    const courseSnap = await db.collection('courses').doc(courseId).get();
    const course = { id: courseId, ...courseSnap.data() };
    const category = await courseService.getCategoryOf(db, course.categoryId);
    const rules = courseService.resolveRules(course, category);
    const today = taiwanToday();

    // 1) 合約 PDF（供附件）——沿用真實學員的報名/簽名資料
    const enrollSnap = await db.collection('courseEnrollments')
      .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
    const enrollments = enrollSnap.docs.map(d => d.data()).filter(e => e.status !== 'cancelled' && !e.isMakeup && !e.isTrial);
    const futureEnrolled = enrollments.filter(e => !e.date || e.date >= today)
      .map(e => ({ date: e.date, startTime: e.startTime, endTime: e.endTime, gymId: e.gymId }));

    const headerSnap = await db.collection('courseRegistrations')
      .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
    const header = headerSnap.docs.map(d => d.data()).find(h => h.status !== 'cancelled');
    const fee = header?.fee ?? enrollments[0]?.enrollmentFee ?? 0;
    const paymentMethod = header?.paymentMethod || 'cash';

    const { pdfBuffer } = await issueCourseContract({
      memberId, memberName: member.name, isGuest: false,
      course, futureSessions: futureEnrolled.length ? futureEnrolled : [{ date: course.startDate, startTime: '', endTime: '' }],
      fee, paymentMethod, coursePlan: null,
      refundFeeRate: rules.handlingFeeRate, refundPreStartFeeRate: rules.preStartFeeRate,
      gymId: course.gymId,
      portraitSignature: header?.portraitSignature || null,
      guardianSignature: header?.guardianSignature || null,
      dryRun: true,
    });

    // 2) 完整場次清單（含已停課，來自 courseSessions 全部場次，非僅該學員自己的報名列）——模擬「一樣把停課標註出來」
    const allSessSnap = await db.collection('courseSessions').where('courseId', '==', courseId).get();
    const allSessions = allSessSnap.docs.map(d => d.data())
      .filter(s => s.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(s => ({ date: s.date, startTime: s.startTime, endTime: s.endTime, cancelled: s.status === 'cancelled' }));

    const REG_WD = ['日', '一', '二', '三', '四', '五', '六'];
    const fmtSession = (s) => {
      const [y, m, d] = String(s.date || '').split('-').map(Number);
      const wd = (y && m && d) ? REG_WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] : '';
      const md = (m && d) ? `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}` : (s.date || '');
      const time = s.startTime ? `${s.startTime}${s.endTime ? `–${s.endTime}` : ''}` : '';
      return `${md}${wd ? `（${wd}）` : ''}${time ? ` ${time}` : ''}`.trim();
    };
    const sessionsHtml = allSessions.map(s => s.cancelled
      ? `<div style="color:#B23A3A">${fmtSession(s)}　<strong>（停課）</strong></div>`
      : `<div>${fmtSession(s)}</div>`).join('');
    const sessionsBlock = `
        <div style="background:#F7F3F3;border-radius:8px;padding:16px;margin:12px 0;font-size:13px;line-height:1.9;text-align:left">
          <div style="font-weight:600;color:#8B1A1A;margin-bottom:6px">課程場次（共 ${allSessions.length} 堂，含已停課標註）</div>
          ${sessionsHtml}
        </div>`;

    // 3) 館方 email（供 cc）
    const gDoc = await db.collection('gyms').doc(course.gymId).get();
    const gymCc = gDoc.exists ? gDoc.data().email : null;
    const gymLabel = course.gymId === 'gym-hsinchu' ? '新竹館' : course.gymId === 'gym-shilin' ? '士林館' : '';

    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">課程報名成功</h2>
        <p>親愛的 ${member.name}，</p>
        <p>已收到您的課程報名：<strong>「${course.name}」</strong>（${gymLabel}）。</p>
        ${sessionsBlock}
        <div style="background:#FFF6E9;border:1px solid #E0C08A;border-radius:8px;padding:16px;margin:12px 0">
          <div style="font-size:16px;color:#8B1A1A"><strong>應繳金額：NT$${Number(fee).toLocaleString()}</strong></div>
          <div style="font-size:13px;color:#666;margin-top:4px">${paymentMethod === 'transfer' ? '請於 3 日內完成轉帳匯款' : '請至櫃檯完成繳費'}</div>
        </div>
        <p style="font-size:13px;color:#666"><strong>附件為您的課程服務同意書 PDF，請詳閱留存。</strong></p>
        <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
      </div>
    `;

    await sendEmail({
      to: demoEmail, cc: gymCc || undefined,
      subject: `【紅石攀岩】${course.name}報名成功，請完成繳費`,
      html,
      attachments: [{ filename: `課程服務同意書_${course.name}.pdf`, content: pdfBuffer.toString('base64') }],
    });

    res.json({ ok: true, sentTo: demoEmail, cc: gymCc, sessions: allSessions, courseName: course.name });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message, stack: err.stack }); }
});

// ── 模擬版：定期票服務同意書 email 加 cc 館方 ──
router.post('/pass', authenticate, async (req, res) => {
  try {
    if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
    const db = getDb();
    const { memberId, passId, demoEmail } = req.body;
    const { issuePassContract } = require('../services/passContractService');
    const { sendEmail } = require('../services/emailService');

    const memberSnap = await db.collection('members').doc(memberId).get();
    const member = memberSnap.data();
    const passSnap = await db.collection('memberPasses').doc(passId).get();
    const pass = passSnap.data();

    const { pdfBuffer } = await issuePassContract({
      memberId, memberName: member.name,
      passTypeName: pass.passTypeName, scope: pass.scope, targetGymId: pass.targetGymId,
      startDate: pass.startDate, endDate: pass.effectiveEndDate || pass.endDate,
      fee: 0, paymentMethod: 'cash', gymId: pass.gymId,
      portraitSignature: null, guardianSignature: null,
      dryRun: true,
    });

    const gDoc = await db.collection('gyms').doc(pass.gymId).get();
    const gymCc = gDoc.exists ? gDoc.data().email : null;

    await sendEmail({
      to: demoEmail, cc: gymCc || undefined,
      subject: `【紅石攀岩】${pass.passTypeName} 定期票服務同意書`,
      html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">定期票服務同意書</h2>
        <p>親愛的 ${member.name}，</p>
        <p>附件為您購買「<strong>${pass.passTypeName}</strong>」的定期票服務同意書 PDF（依購買資訊自動產生），請妥善保存，如有疑問請聯繫館方。</p>
        <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
      </div>
    `,
      attachments: [{ filename: `定期票服務同意書_${pass.passTypeName}.pdf`, content: pdfBuffer.toString('base64') }],
    });

    res.json({ ok: true, sentTo: demoEmail, cc: gymCc, passTypeName: pass.passTypeName });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message, stack: err.stack }); }
});

module.exports = router;
