// 課程服務同意書「重新簽署連結」：館方替既有報名產生一次性連結，由學員／家長自行線上簽名後重新產生合約。
// 用途：報名人改名（如楊佳穎→白孟儒）後，舊合約簽署人與學員不一致，需由正確的簽署人重簽。
const express = require('express');
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const { isManagerRole } = require('../utils/roles');
const { isMinor } = require('../utils/age');
const courseService = require('../services/courseService');

const router = express.Router();
const REQ = 'courseContractSignRequests';
const EXPIRE_DAYS = 7;
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const BASE_URL = process.env.MEMBER_APP_URL || 'https://app.redrocktaiwan.com';

const sigOk = (v) => typeof v === 'string' && v.startsWith('data:image/') && v.length > 2000 && v.length < 1500000;

async function loadContext(db, reqDoc) {
  const r = reqDoc;
  const regSnap = await db.collection('courseRegistrations').doc(r.registrationId).get();
  if (!regSnap.exists) throw Object.assign(new Error('報名紀錄不存在'), { status: 404, code: 'REGISTRATION_NOT_FOUND' });
  const reg = regSnap.data();
  const courseSnap = await db.collection('courses').doc(reg.courseId).get();
  if (!courseSnap.exists) throw Object.assign(new Error('課程不存在'), { status: 404, code: 'COURSE_NOT_FOUND' });
  const course = { id: courseSnap.id, ...courseSnap.data() };
  const enr = await db.collection('courseEnrollments')
    .where('courseId', '==', reg.courseId).where('memberId', '==', reg.memberId).get();
  const sessions = enr.docs.map(d => d.data()).filter(e => e.status !== 'cancelled')
    .map(e => ({ date: e.date, startTime: e.startTime, endTime: e.endTime, gymId: e.gymId || course.gymId }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const memberSnap = await db.collection('members').doc(reg.memberId).get();
  const member = memberSnap.exists ? memberSnap.data() : {};
  return { reg, course, sessions, member };
}

function checkRequest(rq) {
  if (!rq) return { status: 404, code: 'INVALID_TOKEN', message: '此連結無效' };
  if (rq.status === 'signed') return { status: 409, code: 'ALREADY_SIGNED', message: '已完成簽署' };
  if (rq.status === 'cancelled') return { status: 410, code: 'CANCELLED', message: '此連結已失效' };
  const exp = rq.expiresAt?.toDate ? rq.expiresAt.toDate() : new Date(rq.expiresAt);
  if (Date.now() > exp.getTime()) return { status: 410, code: 'TOKEN_EXPIRED', message: '此連結已過期' };
  return null;
}

// ── 館方：建立重簽連結（管理員／館長）──────────────────────────────
router.post('/requests', authenticate, async (req, res) => {
  try {
    if (!isManagerRole(req.staff?.role)) return res.status(403).json({ error: 'FORBIDDEN', message: '僅管理員／館長可建立' });
    const { registrationId } = req.body || {};
    if (!registrationId) return res.status(400).json({ error: 'MISSING_REGISTRATION' });
    const db = getDb();
    const regSnap = await db.collection('courseRegistrations').doc(registrationId).get();
    if (!regSnap.exists) return res.status(404).json({ error: 'REGISTRATION_NOT_FOUND' });
    const reg = regSnap.data();
    if (reg.status !== 'confirmed') return res.status(400).json({ error: 'NOT_CONFIRMED', message: '僅限已確認的報名' });
    // 同一筆報名的舊待簽連結一律作廢，避免多條有效連結
    const old = await db.collection(REQ).where('registrationId', '==', registrationId).where('status', '==', 'pending').get();
    const token = crypto.randomBytes(24).toString('hex');
    const now = new Date();
    const batch = db.batch();
    old.docs.forEach(d => batch.update(d.ref, { status: 'cancelled', cancelledAt: now }));
    batch.set(db.collection(REQ).doc(token), {
      token, registrationId, courseId: reg.courseId, memberId: reg.memberId, memberName: reg.memberName,
      status: 'pending', createdBy: req.staff.id, createdByName: req.staff.name || '',
      createdAt: now, expiresAt: new Date(now.getTime() + EXPIRE_DAYS * 86400000),
    });
    await batch.commit();
    res.status(201).json({ token, url: `${BASE_URL}/sign/course-contract/${token}`, expiresInDays: EXPIRE_DAYS });
  } catch (err) { res.status(err.status || 500).json({ error: err.code || 'SERVER_ERROR', message: err.message }); }
});

// ── 公開：讀取簽署頁資訊（不回傳任何既有簽名）────────────────────────
router.get('/:token', async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection(REQ).doc(req.params.token).get();
    const rq = snap.exists ? snap.data() : null;
    const bad = checkRequest(rq);
    if (bad) return res.status(bad.status).json({ error: bad.code, message: bad.message });
    const { reg, course, sessions, member } = await loadContext(db, rq);
    const { DEFAULT_COURSE_TERMS } = require('../utils/contractTermsDefaults');
    const termsSnap = await db.collection('systemSettings').doc('contractTerms').get();
    const td = termsSnap.exists ? termsSnap.data() : {};
    const first = sessions[0] || {};
    const minor = isMinor(member.birthday);
    let guardianName = member.parentName || '';
    if (!guardianName && member.parentMemberId) {
      const p = await db.collection('members').doc(member.parentMemberId).get();
      guardianName = p.exists ? (p.data().name || '') : '';
    }
    res.json({
      studentName: reg.memberName, courseName: course.name,
      startDate: course.startDate, endDate: course.endDate,
      weekdays: (course.weekdays || []).map(w => WEEKDAY_LABELS[w]).filter(Boolean).join('、'),
      startTime: first.startTime || course.startTime, endTime: first.endTime || course.endTime,
      totalSessions: sessions.length, fee: reg.fee, paymentMethod: reg.paymentMethod,
      isMinor: minor, guardianName,
      termsText: (typeof td.course === 'string' && td.course) ? td.course : DEFAULT_COURSE_TERMS,
      skipSignature: !!course.skipSignature,
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.code || 'SERVER_ERROR', message: err.message }); }
});

// ── 公開：送出簽名→更新報名簽名→作廢舊合約→產生新合約並寄出 ─────────────
router.post('/:token', async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection(REQ).doc(req.params.token);
    const snap = await ref.get();
    const rq = snap.exists ? snap.data() : null;
    const bad = checkRequest(rq);
    if (bad) return res.status(bad.status).json({ error: bad.code, message: bad.message });
    const { portraitSignature, guardianSignature, agreed } = req.body || {};
    if (!agreed) return res.status(400).json({ error: 'NOT_AGREED', message: '請先勾選同意' });
    const { reg, course, sessions, member } = await loadContext(db, rq);
    const minor = isMinor(member.birthday);
    if (!sigOk(portraitSignature)) return res.status(400).json({ error: 'SIGNATURE_REQUIRED', message: '請先簽名' });
    if (minor && !sigOk(guardianSignature)) return res.status(400).json({ error: 'GUARDIAN_SIGNATURE_REQUIRED', message: '請法定代理人簽名' });

    // 先以交易方式搶佔 token，防止同一連結被重複送出
    const claimed = await db.runTransaction(async (t) => {
      const s = await t.get(ref); if (!s.exists || s.data().status !== 'pending') return false;
      t.update(ref, { status: 'signing', signingAt: new Date() }); return true;
    });
    if (!claimed) return res.status(409).json({ error: 'ALREADY_SIGNED', message: '已完成簽署' });

    try {
      const cat = course.categoryId ? await db.collection('courseCategories').doc(course.categoryId).get() : null;
      const rules = courseService.resolveRules(course, cat && cat.exists ? cat.data() : null);
      const { issueCourseContract } = require('../services/courseContractService');
      const gymId = (sessions[0] && sessions[0].gymId) || course.gymId;
      const result = await issueCourseContract({
        memberId: reg.memberId, memberName: reg.memberName, isGuest: false,
        course, futureSessions: sessions, fee: reg.fee, paymentMethod: reg.paymentMethod,
        refundFeeRate: rules.handlingFeeRate ?? 0.2, refundPreStartFeeRate: rules.preStartFeeRate ?? 0,
        gymId, portraitSignature, guardianSignature: minor ? guardianSignature : null, attachOnly: true,
      });
      const now = new Date();
      // 舊合約（含原報名人名下）標示作廢
      const olds = await db.collection('courseContracts').where('courseId', '==', reg.courseId).get();
      const oldIds = olds.docs.filter(d => d.id !== result.contractId && !d.data().voided
        && [reg.memberId, reg.reassignedFrom].filter(Boolean).includes(d.data().memberId)).map(d => d.id);
      const batch = db.batch();
      oldIds.forEach(id => batch.update(db.collection('courseContracts').doc(id), { voided: true, voidedAt: now, voidedReason: '重新簽署，由新合約取代', replacedBy: result.contractId }));
      batch.update(db.collection('courseRegistrations').doc(rq.registrationId), {
        portraitSignature, guardianSignature: minor ? guardianSignature : null,
        confirmedContractTerms: true, contractResignedAt: now, contractResignedVia: 'resign-link',
      });
      batch.update(ref, { status: 'signed', signedAt: now, contractId: result.contractId, voidedContracts: oldIds });
      await batch.commit();
      // 寄出新合約（失敗不影響簽署結果，館方可由 emailError 追蹤）
      if (result.email && result.pdfBuffer) {
        try {
          const { sendCourseContractPdf } = require('../services/emailService');
          const { resolveGymEmail } = require('../utils/gymEmail');
          const cc = [await resolveGymEmail(db, gymId)].filter(Boolean);
          await sendCourseContractPdf({ to: result.email, cc, memberName: reg.memberName, courseName: course.name, pdfBuffer: result.pdfBuffer });
          await db.collection('courseContracts').doc(result.contractId).update({ emailedAt: new Date(), emailedVia: 'resign-link' });
        } catch (e) {
          console.error('[重簽合約] 寄信失敗:', e.message);
          await db.collection('courseContracts').doc(result.contractId).update({ emailError: e.message }).catch(() => {});
        }
      }
      res.json({ ok: true, emailed: !!result.email });
    } catch (e) {
      await ref.update({ status: 'pending' }).catch(() => {});   // 失敗時還原，讓客人可重試
      throw e;
    }
  } catch (err) { res.status(err.status || 500).json({ error: err.code || 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
