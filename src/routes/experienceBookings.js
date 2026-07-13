const { taiwanToday } = require('../utils/taiwanDate');
const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { authenticate, authenticateAny } = require('../middleware/auth');
const { getDb, getStorage } = require('../config/firebase');
const XLSX = require('xlsx');
const { sanitizeSheet } = require('../utils/xlsxSafe');
const emailService = require('../services/emailService');
const courseService = require('../services/courseService');
const scheduleService = require('../services/scheduleService');
const memberService = require('../services/memberService');
const { isUnder5 } = require('../utils/age');

const COURSE_TYPES = [
  { id:'general',   label:'抱石體驗課程',          priceMap:{ 1:975, 2:875, 3:875, '4-5':825, '6-8':775, '9-12':775 } },
  { id:'children',  label:'小蜘蛛人（兒童）',        price: 600 },
  { id:'skill_fri', label:'抱石技巧班（週五20:00）', price:1075 },
  { id:'skill_sun14',label:'抱石技巧班（週日14:00）',price: 900 },
];

// ── POST /experience-bookings - 送出預約 ──────────────────────────
router.post('/', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id || req.body.memberId;
    const {
      gymId, bookingDate, bookingTime, courseType,
      contactName, contactEmail, contactPhone, facebookName,
      participants, // [{ name, idNumber, birthday, nationality }]
      totalFee, paymentDate, bankLastFive, notes,
    } = req.body;

    // ── 試上：綁定週課場次（另收試上費、免保險、佔名額）───────────────
    if (req.body.trialSessionId) {
      if (!memberId) return res.status(401).json({ code:'UNAUTHORIZED', message:'請先登入會員' });
      const sDoc = await db.collection('courseSessions').doc(req.body.trialSessionId).get();
      if (!sDoc.exists) return res.status(404).json({ code:'SESSION_NOT_FOUND', message:'找不到試上場次' });
      const session = sDoc.data();
      const cDoc = await db.collection('courses').doc(session.courseId).get();
      const course = cDoc.exists ? cDoc.data() : {};
      if (course.allowTrial !== true) return res.status(400).json({ code:'TRIAL_NOT_ALLOWED', message:'此課程未開放試上' });
      // 額滿不再直接擋：報名即佔位、滿了列候補（候補也滿由 enrollTrial 擋 WAITLIST_FULL）
      if (req.body.consentSigned !== true) return res.status(400).json({ code:'CONSENT_REQUIRED', message:'請先簽署免責同意書' });
      // 家長代子帳號報名試上：綁定到子會員（驗證擁有權，比照 /checkin/qr/create）。
      // booking / 名單 / 單日券的 memberId 皆綁子會員，入場時子帳號才拿得到自己的券。
      let trialMemberId = memberId;
      let trialName = contactName || req.member?.name || '';
      let trialEmail = contactEmail || req.member?.email || '';
      let trialPhone = contactPhone || req.member?.phone || '';
      if (req.body.childMemberId && req.body.childMemberId !== memberId) {
        const childDoc = await db.collection('members').doc(req.body.childMemberId).get();
        if (!childDoc.exists || childDoc.data().parentMemberId !== memberId) {
          return res.status(403).json({ code:'FORBIDDEN', message:'只能為自己或自己的子會員報名試上' });
        }
        const child = childDoc.data();
        trialMemberId = req.body.childMemberId;
        trialName = contactName || child.name || '';
        trialEmail = contactEmail || child.email || req.member?.email || '';
        trialPhone = contactPhone || child.phone || req.member?.phone || '';
      }

      // 後端權威：未滿 5 歲無法報名試上（實際參加者＝trialMemberId，家長代子時為子會員）
      const _trialMember = await memberService.getMember(trialMemberId).catch(() => null);
      if (isUnder5(_trialMember)) return res.status(400).json({ code:'AGE_UNDER_5', message:'未滿 5 歲無法報名課程/體驗' });

      const trialFee = course.trialPrice || 0;
      const id = `trial_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

      // 報名當下即佔名額（pending 待繳費）：滿→候補；逾繳費期限由排程釋放並候補轉正
      const paymentDeadline = courseService.trialPaymentDeadline(session);
      let trialEnroll;
      try {
        trialEnroll = await courseService.enrollTrial({
          memberId: trialMemberId, memberName: trialName,
          sessionId: req.body.trialSessionId, gymId: session.gymId,
          trialFee, bookingId: id, staffId: null,
          paymentStatus: 'pending', paymentDeadline,
          maxWaitlist: course.maxWaitlist ?? null,
        });
      } catch (e) {
        const code = e.code || 'TRIAL_ENROLL_FAILED';
        return res.status(400).json({ code, message: e.message || '試上報名失敗' });
      }
      const isWaitlist = trialEnroll.status === 'waitlist';
      await db.collection('experienceBookings').doc(id).set({
        id, memberId: trialMemberId, bookedByMemberId: memberId, gymId: session.gymId, kind: 'trial',
        trialCourseId: session.courseId, trialSessionId: req.body.trialSessionId, courseName: session.courseName,
        bookingDate: session.date, bookingTime: `${session.startTime||''}~${session.endTime||''}`,
        courseType: 'trial',
        contactName: trialName,
        contactEmail: trialEmail,
        contactPhone: trialPhone,
        participants: [{ name: trialName }],
        numParticipants: 1,
        totalFee: trialFee,
        paymentDate: paymentDate||null, bankLastFive: bankLastFive||null, paymentMethod: req.body.paymentMethod || 'transfer',
        consentSigned: true, needsInsurance: false,
        notes: notes||'',
        trialEnrollmentId: trialEnroll.enrollmentId,
        isWaitlist, paymentDeadline,
        status: 'pending', createdAt: new Date(), updatedAt: new Date(),
      });
      return res.status(201).json({
        success:true, id, isTrial:true, totalFee: trialFee,
        isWaitlist, paymentDeadline: paymentDeadline.toISOString(),
        message: isWaitlist
          ? '此場次已額滿，已為您排入候補；有名額釋出將依序轉正'
          : '試上預約已送出，名額已為您保留，請於期限內完成付款',
      });
    }

    if (!gymId) return res.status(400).json({ code:'MISSING_GYM', message:'請選擇場館' });
    if (!bookingDate) return res.status(400).json({ code:'MISSING_DATE', message:'請填寫體驗日期' });
    if (!participants?.length) return res.status(400).json({ code:'MISSING_PARTICIPANTS', message:'請填寫參加人員資料' });

    // 後端權威：未滿 5 歲無法報名體驗。解析參加者——
    //  1) 若帶 childMemberId → 該子會員；否則登入會員本人（memberId）。
    //  2) 參加者名單 participants 各自帶 birthday（含非會員 walk-in）→ 任一未滿 5 歲亦擋。
    //     參加者生日為前端民國格式（如 "920110"＝民國92年）；也相容 ISO YYYY-MM-DD。
    const _partUnder5 = (s) => {
      if (!s) return false;
      const str = String(s).trim();
      let d;
      if (str.includes('-')) d = dayjs(str);                 // ISO
      else {
        const digits = str.replace(/\D/g, '');
        if (digits.length < 5) return false;                 // 需 年(2-3碼)+MMDD(4碼)
        const year = parseInt(digits.slice(0, -4), 10) + 1911; // 民國→西元
        const mmdd = digits.slice(-4);
        d = dayjs(`${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2, 4)}`);
      }
      return d.isValid() && dayjs().diff(d, 'year') < 5;
    };
    const _bookerId = req.body.childMemberId || memberId;
    if (_bookerId) {
      const _bookerMember = await memberService.getMember(_bookerId).catch(() => null);
      if (isUnder5(_bookerMember)) return res.status(400).json({ code:'AGE_UNDER_5', message:'未滿 5 歲無法報名課程/體驗' });
    }
    if ((participants || []).some(p => _partUnder5(p?.birthday))) {
      return res.status(400).json({ code:'AGE_UNDER_5', message:'未滿 5 歲無法報名課程/體驗' });
    }

    // 後端權威計算費用（不信任前端傳入的 totalFee）：用與前端相同的設定來源
    const _settingsDoc = await db.collection('systemSettings').doc('experienceCourses').get();
    const _settings = _settingsDoc.exists ? _settingsDoc.data() : defaultSettings();
    const _courseTypes = _settings.courseTypes || defaultSettings().courseTypes;
    const _ct = _courseTypes.find(c => c.id === (courseType || 'general'));
    if (!_ct) return res.status(400).json({ code:'INVALID_COURSE_TYPE', message:'課程類型不正確' });
    const _n = participants.length;
    let _unitPrice = 0;
    if (_ct.pricingType === 'tiered' && Array.isArray(_ct.tiers)) {
      const _tier = _ct.tiers.find(t => _n >= t.min && _n <= t.max);
      _unitPrice = _tier ? _tier.price : (_ct.tiers[_ct.tiers.length - 1]?.price || 0);
    } else {
      _unitPrice = _ct.price || 0;
    }
    const computedFee = _unitPrice * _n;

    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    await db.collection('experienceBookings').doc(id).set({
      id, memberId, gymId, bookingDate, bookingTime, courseType: courseType||'general',
      contactName: contactName || req.member?.name || '',
      contactEmail: contactEmail || req.member?.email || '',
      contactPhone: contactPhone || req.member?.phone || '',
      facebookName: facebookName||'',
      participants, // 含姓名/身分證/生日/國籍
      numParticipants: participants.length,
      totalFee: computedFee,
      paymentDate: paymentDate||null,
      bankLastFive: bankLastFive||null,
      notes: notes||'',
      status: 'pending', // pending | confirmed | cancelled
      createdAt: new Date(), updatedAt: new Date(),
    });
    res.status(201).json({ success:true, id, message:'預約已送出，請於3日內完成匯款' });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── GET /experience-bookings - 員工查詢 ────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { gymId, status, from, to } = req.query;
    const effectiveGymId = req.staff.role==='super_admin' ? gymId : req.staff.gymId;
    let ref = db.collection('experienceBookings');
    if (effectiveGymId) ref = ref.where('gymId','==',effectiveGymId);
    if (status) ref = ref.where('status','==',status);
    const snap = await ref.get();
    let bookings = snap.docs.map(d=>({ id:d.id,...d.data() }));
    if (from) bookings = bookings.filter(b=>b.bookingDate>=from);
    if (to)   bookings = bookings.filter(b=>b.bookingDate<=to);
    bookings.sort((a,b)=>a.bookingDate.localeCompare(b.bookingDate));
    res.json({ bookings, courseTypes: COURSE_TYPES });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── GET /experience-bookings/my - 會員查自己的 ─────────────────────
router.get('/my', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id;
    if (!memberId) return res.status(401).json({ error:'UNAUTHORIZED' });
    const snap = await db.collection('experienceBookings').where('memberId','==',memberId).get();
    const bookings = snap.docs.map(d=>({ id:d.id,...d.data() }))
      .sort((a,b)=>(b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
    res.json({ bookings });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── 解析預約時間字串 → { startTime, endTime } ─────────────────────
// 預約時間為自由文字（如 "16:00-17:30"、"14:00"、"下午兩點"）。
// 抓得到兩個時刻→視為起訖；只有一個→以該時刻起、+2 小時為迄；抓不到→null（改用整天班）。
function parseBookingTime(bookingTime) {
  const matches = String(bookingTime || '').match(/(\d{1,2}):(\d{2})/g) || [];
  const norm = (t) => { const [h, m] = t.split(':'); return `${String(parseInt(h, 10)).padStart(2, '0')}:${m}`; };
  if (matches.length >= 2) {
    const start = norm(matches[0]), end = norm(matches[1]);
    return start < end ? { startTime: start, endTime: end } : { startTime: start, endTime: null };
  }
  if (matches.length === 1) {
    const start = norm(matches[0]);
    return { startTime: start, endTime: dayjs(`2000-01-01T${start}`).add(2, 'hour').format('HH:mm') };
  }
  return { startTime: null, endTime: null };
}

async function courseTypeLabel(db, courseType) {
  const doc = await db.collection('systemSettings').doc('experienceCourses').get();
  const s = doc.exists ? doc.data() : defaultSettings();
  const ct = (s.courseTypes || []).find(c => c.id === courseType);
  return ct?.label || courseType || '體驗課程';
}

// ── 確認體驗預約時：建立課程 + 場次 + 教練當日排班 ───────────────────
// 課程/場次皆標記 source:'experience'，供會員端過濾（不出現在報名目錄）。
async function addExperienceToCourseAndSchedule(db, booking, staff, coachId, coachName) {
  const gymId = booking.gymId;
  const label = await courseTypeLabel(db, booking.courseType);
  const numPeople = booking.numParticipants || (booking.participants || []).length || 1;
  const { startTime, endTime } = parseBookingTime(booking.bookingTime);
  const name = `體驗課程・${label}・${booking.contactName || ''}`.trim();

  // 1) 建立課程（工作坊）
  const course = await courseService.createCourse({
    gymId, staffId: staff?.id || null,
    data: {
      name, description: `體驗課程預約（${numPeople} 人）`,
      type: 'workshop', category: 'experience',
      instructor: coachName || '',
      startDate: booking.bookingDate, endDate: booking.bookingDate,
      startTime, endTime,
      maxStudents: numPeople, price: booking.totalFee || 0, totalSessions: 1,
    },
  });
  await db.collection('courses').doc(course.id).update({
    source: 'experience', experienceBookingId: booking.id,
    coachId: coachId || null, coachName: coachName || '',
  });

  // 2) 建立場次
  const session = await courseService.createSession({
    courseId: course.id, gymId, staffId: staff?.id || null,
    data: {
      date: booking.bookingDate, startTime: startTime || '', endTime: endTime || '',
      maxStudents: numPeople,
      note: `體驗課程・教練：${coachName || '—'}・${numPeople} 人`,
    },
  });
  await db.collection('courseSessions').doc(session.id).update({
    source: 'experience', experienceBookingId: booking.id,
    instructor: coachName || '', coachId: coachId || null,
  });

  // 3) 排班行事曆：指派教練當日班表（重複整天班等狀況不阻斷主流程）
  let scheduleShiftId = null;
  try {
    const staffIdForShift = coachId || `expcoach_${String(coachName || 'coach').replace(/\s+/g, '')}`;
    const useCustom = !!(startTime && endTime && startTime < endTime);
    const shift = await scheduleService.createShift({
      gymId, staffId: staffIdForShift, staffName: coachName || '教練',
      date: booking.bookingDate,
      type: useCustom ? 'custom' : 'full_day',
      startTime: useCustom ? startTime : null,
      endTime: useCustom ? endTime : null,
      note: `體驗課程・${label}・${numPeople} 人`,
      createdBy: staff?.id || null,
    });
    scheduleShiftId = shift.id;
  } catch (e) {
    console.error('[體驗排班] 建立班表失敗（不阻斷）', e.message || e.code);
  }

  return { courseId: course.id, sessionId: session.id, scheduleShiftId };
}

// ── 重新指派教練：同步既有課程/場次 + 換教練排班（保證三邊一致）──────
// 用於已排課後改教練。updateShift 無法改教練，故刪舊班→建新班。
async function reassignExperienceCoach(db, booking, staff, coachId, coachName) {
  const label = await courseTypeLabel(db, booking.courseType);
  const numPeople = booking.numParticipants || (booking.participants || []).length || 1;
  const { startTime, endTime } = parseBookingTime(booking.bookingTime);

  // 1) 更新課程教練
  if (booking.courseId) {
    await db.collection('courses').doc(booking.courseId).update({
      instructor: coachName || '', coachId: coachId || null, coachName: coachName || '',
      updatedAt: new Date(),
    });
  }
  // 2) 更新場次教練
  if (booking.sessionId) {
    await db.collection('courseSessions').doc(booking.sessionId).update({
      instructor: coachName || '', coachId: coachId || null,
      note: `體驗課程・教練：${coachName || '—'}・${numPeople} 人`,
      updatedAt: new Date(),
    });
  }
  // 3) 換教練排班：刪舊班→建新班（任一步失敗只記 log，不阻斷）
  let scheduleShiftId = booking.scheduleShiftId || null;
  if (booking.scheduleShiftId) {
    try { await scheduleService.deleteShift(booking.scheduleShiftId); scheduleShiftId = null; }
    catch (e) { console.error('[體驗改教練] 刪舊班失敗（續建新班）', e.message || e.code); }
  }
  try {
    const staffIdForShift = coachId || `expcoach_${String(coachName || 'coach').replace(/\s+/g, '')}`;
    const useCustom = !!(startTime && endTime && startTime < endTime);
    const shift = await scheduleService.createShift({
      gymId: booking.gymId, staffId: staffIdForShift, staffName: coachName || '教練',
      date: booking.bookingDate,
      type: useCustom ? 'custom' : 'full_day',
      startTime: useCustom ? startTime : null,
      endTime: useCustom ? endTime : null,
      note: `體驗課程・${label}・${numPeople} 人`,
      createdBy: staff?.id || null,
    });
    scheduleShiftId = shift.id;
  } catch (e) {
    console.error('[體驗改教練] 建新班失敗（不阻斷）', e.message || e.code);
  }

  return { scheduleShiftId };
}

// ── 取消體驗：清理自動建立的課程/場次/教練排班（不阻斷退券主流程）──────
async function cleanupExperienceCourseAndSchedule(db, booking, staff) {
  const result = { courseCancelled: false, sessionCancelled: false, shiftDeleted: false };
  if (booking.sessionId) {
    try {
      await courseService.updateSession({ sessionId: booking.sessionId, staffId: staff?.id || null, data: { status: 'cancelled' } });
      result.sessionCancelled = true;
    } catch (e) { console.error('[體驗取消] 取消場次失敗', e.message || e.code); }
  }
  if (booking.courseId) {
    try {
      await db.collection('courses').doc(booking.courseId).update({ status: 'cancelled', updatedAt: new Date() });
      result.courseCancelled = true;
    } catch (e) { console.error('[體驗取消] 取消課程失敗', e.message || e.code); }
  }
  if (booking.scheduleShiftId) {
    try { await scheduleService.deleteShift(booking.scheduleShiftId); result.shiftDeleted = true; }
    catch (e) { console.error('[體驗取消] 刪教練班失敗', e.message || e.code); }
  }
  return result;
}

// ── POST /experience-bookings/:id/confirm - 確認收款（可指定教練→排課/排班/改教練）──
router.post('/:id/confirm', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('experienceBookings').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此預約' });
    const booking = { id: doc.id, ...doc.data() };

    // ── 試上預約：確認收款 ──
    // 新流程：報名當下已佔位（pending）→ 確認收款只標 paymentStatus:'paid'；
    // 若名單已因逾期釋放（cancelled）→ 擋，請會員重新報名。
    if (booking.kind === 'trial') {
      if (booking.trialEnrollmentId) {
        const enDoc = await db.collection('courseEnrollments').doc(booking.trialEnrollmentId).get();
        if (!enDoc.exists || enDoc.data().status === 'cancelled') {
          return res.status(400).json({ error: 'TRIAL_EXPIRED', message: '此試上名額已因逾期未繳費釋出，請會員重新報名' });
        }
        await enDoc.ref.update({ paymentStatus: 'paid', paymentDeadline: null, updatedAt: new Date() });
        await ref.update({ status: 'confirmed', confirmedBy: req.staff.id, confirmedByName: req.staff.name, confirmedAt: new Date(), updatedAt: new Date() });
        if (booking.contactEmail) {
          emailService.sendExperienceBookingConfirmation(booking.contactEmail, booking.contactName, booking).catch(e => console.error('[Email]', e.message));
        }
        return res.json({ success:true, isTrial:true, enrollmentStatus: enDoc.data().status, message: enDoc.data().status === 'waitlist' ? '已確認收款（目前為候補，名額釋出將自動轉正）' : '已確認收款' });
      }
      let trialResult;
      try {
        trialResult = await courseService.enrollTrial({
          memberId: booking.memberId, memberName: booking.contactName,
          sessionId: booking.trialSessionId, gymId: booking.gymId,
          trialFee: booking.totalFee, bookingId: booking.id, staffId: req.staff.id,
        });
      } catch (e) {
        return res.status(400).json({ error: 'TRIAL_ENROLL_FAILED', message: e.message || e.code });
      }
      await ref.update({
        status: 'confirmed', confirmedBy: req.staff.id, confirmedByName: req.staff.name,
        confirmedAt: new Date(), updatedAt: new Date(), trialEnrollmentId: trialResult.enrollmentId,
      });
      if (booking.contactEmail) {
        emailService.sendExperienceBookingConfirmation(booking.contactEmail, booking.contactName, booking).catch(e => console.error('[Email]', e.message));
      }
      return res.json({
        success: true, isTrial: true, ...trialResult,
        message: trialResult.status === 'waitlist' ? '已確認收款（場次已滿，列入候補）' : '已確認收款，已加入試上名單',
      });
    }

    const coachId = req.body.coachId || null;
    const coachName = (req.body.coachName || '').trim();

    const update = {
      status: 'confirmed', confirmedBy: req.staff.id, confirmedByName: req.staff.name,
      confirmedAt: new Date(), updatedAt: new Date(),
    };

    // 教練處理（僅在有帶 coachName 時動教練相關欄位，避免覆蓋成空值造成 desync）：
    //   1) 尚未排課 → 建立課程/場次/排班
    //   2) 已排課且教練變更 → 同步既有課程/場次 + 換教練排班
    //   3) 同一教練重複確認 → 只更新收款欄位
    let created = null, reassigned = null;
    const coachChanged = coachName !== (booking.coachName || '') || (coachId || null) !== (booking.coachId || null);
    try {
      if (coachName && !booking.courseId) {
        created = await addExperienceToCourseAndSchedule(db, booking, req.staff, coachId, coachName);
        Object.assign(update, {
          coachId, coachName,
          courseId: created.courseId, sessionId: created.sessionId, scheduleShiftId: created.scheduleShiftId,
        });
      } else if (coachName && booking.courseId && coachChanged) {
        reassigned = await reassignExperienceCoach(db, booking, req.staff, coachId, coachName);
        Object.assign(update, { coachId, coachName, scheduleShiftId: reassigned.scheduleShiftId });
      } else if (coachName) {
        Object.assign(update, { coachId, coachName });
      }
    } catch (e) {
      return res.status(500).json({ error: 'COURSE_CREATE_FAILED', message: '排課/排班失敗：' + (e.message || e.code) });
    }

    await ref.update(update);

    // 發送確認信
    if (booking.contactEmail) {
      emailService.sendExperienceBookingConfirmation(booking.contactEmail, booking.contactName, booking).catch(e => console.error('[Email]', e.message));
    }
    res.json({
      success: true, coachName, ...(created || {}), ...(reassigned || {}),
      message: reassigned ? '已更新教練與排班'
        : created ? '已確認收款，並加入課程與教練排班'
        : '已確認收款',
    });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── POST /experience-bookings/:id/cancel - 取消預約 ────────────────
router.post('/:id/cancel', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('experienceBookings').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此預約' });
    const booking = { id: snap.id, ...snap.data() };

    await ref.update({
      status:'cancelled', cancelReason:req.body.reason||'', cancelledAt:new Date(), updatedAt:new Date(),
    });
    // 退費/取消 → 該預約所有「未使用」體驗入場券作廢（含已轉出未用）；已使用不動
    const voided = await voidExperienceTickets(db, req.params.id, '體驗退費/取消');
    // 試上預約：移除該場次試上名單並釋放名額
    if (booking.kind === 'trial' && booking.trialEnrollmentId) {
      await courseService.removeTrialEnrollment(booking.trialEnrollmentId).catch(e => console.error('[試上取消] 移除名單失敗', e.message || e.code));
    }
    // 清理自動建立的課程/場次/教練排班（若當初有指定教練排課）
    const cleanup = await cleanupExperienceCourseAndSchedule(db, booking, req.staff);
    res.json({ success:true, voidedTickets: voided, cleanup });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── 體驗入場券：發放/同步（員工手動）與作廢 helper ──────────────────
const { v4: _uuid } = require('uuid');
const EXP_TICKET_COLL = 'singleEntryTickets';

// 依 numParticipants 同步體驗入場券數量。allowInitialIssue=true 才允許從 0 發放；
// 否則只在「已發過券」時同步（加人補發 active、減人作廢多餘 active；不動 used）。
async function syncExperienceTickets(db, booking, staff, allowInitialIssue) {
  const target = booking.numParticipants || (booking.participants || []).length || 0;
  const snap = await db.collection(EXP_TICKET_COLL).where('experienceBookingId', '==', booking.id).get();
  const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const active = tickets.filter(t => t.status === 'active');
  const usedCount = tickets.filter(t => t.status === 'used').length;
  const currentTotal = active.length + usedCount;
  if (currentTotal === 0 && !allowInitialIssue) return { issued: 0, voided: 0, total: currentTotal };
  const now = new Date();
  const todayTW = taiwanToday();
  let issued = 0, voided = 0;
  if (target > currentTotal) {
    const batch = db.batch();
    for (let i = 0; i < target - currentTotal; i++) {
      const id = _uuid();
      batch.set(db.collection(EXP_TICKET_COLL).doc(id), {
        id, memberId: booking.memberId || null, memberName: booking.contactName || '',
        originalMemberId: booking.memberId || null, gymId: booking.gymId || null,
        ticketType: 'experience', validDate: booking.bookingDate || null, experienceBookingId: booking.id,
        issuedAt: todayTW, expiresAt: booking.bookingDate || todayTW,
        amount: 0, paymentMethod: 'free', status: 'active',
        approvalDeadline: null, approvedAt: now, approvedBy: staff?.id || null,
        cancelledAt: null, cancelledBy: null, cancelReason: null,
        transferHistory: [], usedAt: null, usedCheckInId: null,
        soldByStaffId: staff?.id || null, soldByStaffName: staff?.name || '',
        notes: `體驗入場券：${booking.courseType || ''} ${booking.bookingDate || ''}`,
        createdAt: now, updatedAt: now,
      });
      issued++;
    }
    await batch.commit();
  } else if (target < currentTotal) {
    const toVoid = Math.min(currentTotal - target, active.length);
    const batch = db.batch();
    for (let i = 0; i < toVoid; i++) {
      batch.update(db.collection(EXP_TICKET_COLL).doc(active[i].id), { status: 'cancelled', cancelledAt: now, cancelReason: '參加人數調整', updatedAt: now });
      voided++;
    }
    if (toVoid) await batch.commit();
  }
  // 回寫「已發放張數」到預約（供前端按鈕切換為「已發放入場券」）
  const ticketsIssued = currentTotal + issued - voided;
  await db.collection('experienceBookings').doc(booking.id).update({ ticketsIssued, ticketsIssuedAt: now, updatedAt: now });
  return { issued, voided, total: target, ticketsIssued };
}

async function voidExperienceTickets(db, bookingId, reason) {
  const snap = await db.collection(EXP_TICKET_COLL).where('experienceBookingId', '==', bookingId).get();
  const batch = db.batch(); let n = 0;
  snap.docs.forEach(d => {
    if (d.data().status === 'active') { // 只作廢未使用；已 used 不動
      batch.update(d.ref, { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason || '體驗取消', updatedAt: new Date() });
      n++;
    }
  });
  if (n) await batch.commit();
  return n;
}

// ── POST /experience-bookings/:id/issue-tickets - 發放體驗入場券（員工手動）──
router.post('/:id/issue-tickets', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('experienceBookings').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此預約' });
    const b = { id: doc.id, ...doc.data() };
    if (b.status === 'cancelled') return res.status(400).json({ error: 'CANCELLED', message: '此預約已取消，無法發放' });
    if (b.status !== 'confirmed') return res.status(400).json({ error: 'NOT_CONFIRMED', message: '請先確認收款再發放入場券' });
    const r = await syncExperienceTickets(db, b, req.staff, true);
    res.json({ success: true, ...r, message: r.issued > 0 ? `已發放 ${r.issued} 張體驗入場券` : '已是最新（無需補發）' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /experience-bookings/:id/participants - 編輯參加人員（連動票券）──
router.put('/:id/participants', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('experienceBookings').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此預約' });
    const participants = Array.isArray(req.body.participants) ? req.body.participants : [];
    await ref.update({ participants, numParticipants: participants.length, updatedAt: new Date() });
    const b = { id: doc.id, ...doc.data(), participants, numParticipants: participants.length };
    // 已發過券才連動（加人補發/減人作廢未用票）
    const r = await syncExperienceTickets(db, b, req.staff, false);
    res.json({ success: true, numParticipants: participants.length, ...r });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /experience-bookings/download - 下載 XLS 名單 ─────────────
router.get('/download', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { gymId, from, to } = req.query;
    const effectiveGymId = req.staff.role==='super_admin' ? gymId : req.staff.gymId;
    let ref = db.collection('experienceBookings');
    if (effectiveGymId) ref = ref.where('gymId','==',effectiveGymId);
    const snap = await ref.get();
    let bookings = snap.docs.map(d=>({ id:d.id,...d.data() }));
    if (from) bookings = bookings.filter(b=>b.bookingDate>=from);
    if (to)   bookings = bookings.filter(b=>b.bookingDate<=to);
    bookings.sort((a,b)=>a.bookingDate.localeCompare(b.bookingDate));

    // 展開每位參加者
    const rows = [];
    bookings.forEach(b => {
      const gymLabel = b.gymId==='gym-hsinchu'?'新竹館':'士林館';
      const statusLabel = { pending:'待確認', confirmed:'已確認', cancelled:'已取消' }[b.status]||b.status;
      (b.participants||[]).forEach((p, idx) => {
        rows.push({
          '場館': gymLabel,
          '預約日期': b.bookingDate,
          '預約時間': b.bookingTime||'',
          '課程類型': b.courseType||'',
          '總人數': b.numParticipants,
          '狀態': statusLabel,
          '聯絡人': b.contactName,
          '聯絡電話': b.contactPhone,
          '序號': idx+1,
          '參加者姓名': p.name||'',
          '身分證字號': p.idNumber||'',
          '生日（民國）': p.birthday||'',
          '國籍': p.nationality||'台灣',
          '費用': idx===0 ? b.totalFee : '',
          '匯款末五碼': idx===0 ? (b.bankLastFive||'') : '',
          '備註': idx===0 ? (b.notes||'') : '',
        });
      });
    });

    if (rows.length===0) rows.push({ '場館':'無資料','預約日期':'','預約時間':'','課程類型':'','總人數':'','狀態':'','聯絡人':'','聯絡電話':'','序號':'','參加者姓名':'','身分證字號':'','生日（民國）':'','國籍':'','費用':'','匯款末五碼':'','備註':'' });

    const ws = sanitizeSheet(XLSX.utils.json_to_sheet(rows));
    // 欄位寬度
    ws['!cols'] = [8,12,10,12,8,8,10,12,6,12,14,12,8,8,12,14].map(w=>({wch:w}));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '體驗課程名單');
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });

    const today = taiwanToday();
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="experience_bookings_${today}.xlsx"`);
    res.send(buf);
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

module.exports = router;

// ── 保險名冊 XLS 產生（下載與一鍵寄送共用）──────────────────────
function buildInsuranceXlsBuffer(bookings) {
    // 工具函式
    const parseRocBirthday = (bStr) => {
      // 輸入可能是 920110(6位) 或 0920110(7位)，統一轉為 Date
      const s = String(bStr).replace(/\D/g, '');
      if (!s) return null;
      let rocYear, mm, dd;
      if (s.length <= 6) {
        const yy = parseInt(s.slice(0, 2));
        rocYear = yy <= 20 ? 100 + yy : yy; // 00-20 → 100-120
        mm = parseInt(s.slice(2, 4)) || 1;
        dd = parseInt(s.slice(4, 6)) || 1;
      } else {
        rocYear = parseInt(s.slice(0, 3));
        mm = parseInt(s.slice(3, 5)) || 1;
        dd = parseInt(s.slice(5, 7)) || 1;
      }
      return new Date(rocYear + 1911, mm - 1, dd);
    };

    const toRoc7 = (bStr) => {
      // 轉成 7 位民國格式 YYYMMDD
      const s = String(bStr).replace(/\D/g, '');
      if (!s) return '';
      if (s.length <= 6) {
        const yy = parseInt(s.slice(0, 2));
        const rocYear = yy <= 20 ? 100 + yy : yy;
        return String(rocYear).padStart(3, '0') + s.slice(2).padStart(4, '0');
      }
      return s.padStart(7, '0');
    };

    const calcAge = (birthdayDate, onDate) => {
      if (!birthdayDate || isNaN(birthdayDate)) return 99;
      let age = onDate.getFullYear() - birthdayDate.getFullYear();
      const m = onDate.getMonth() - birthdayDate.getMonth();
      if (m < 0 || (m === 0 && onDate.getDate() < birthdayDate.getDate())) age--;
      return age;
    };

    // 彙整所有參加者，並依活動日計算年齡
    const adults = [];   // 15歲以上
    const children = []; // 未滿15歲
    bookings.forEach(b => {
      const activityDate = new Date(b.bookingDate);
      (b.participants || []).forEach(p => {
        const bd = parseRocBirthday(p.birthday);
        const age = calcAge(bd, activityDate);
        const row = {
          name: p.name || '',
          idNumber: p.idNumber || '',
          birthday: toRoc7(p.birthday),
        };
        if (age >= 15) adults.push(row);
        else children.push(row);
      });
    });

    // 產生 XLS（使用 xlsx 套件）
    const headers = [
      '被保險人姓名\n(必填)\n※主被保險人放第一列',
      '被保險人ID\n(必填)',
      '出生日期\n(必填)',
      '英文姓名\n',
      '護照號碼\n',
      '投保實支\n',
      '監護宣告\n',
      '受益人姓名\n(法定繼承人不須輸入)',
      '行動電話廠牌型號',
      '受益人ID\n(超過二等親時必入)',
      '受益人與被保險人關係(請填寫代碼)\n01 本人、02 配偶、03 子女、04 父母、05 配偶父母、06 兄弟姐妹、07 (外)祖父母、08 (外)孫子女、09 其他、13 父子、14 父女、15 母子、16 母女、17 (外)祖孫',
      '受益人備註',
      '自主管理',
      '投保法傳',
    ];

    const makeSheet = (rows) => {
      const data = [headers, ...rows.map(r => [r.name, r.idNumber, r.birthday, '', '', '', '', '', '', '', '', '', '', ''])];
      return sanitizeSheet(XLSX.utils.aoa_to_sheet(data));
    };

    const wb = XLSX.utils.book_new();
    const ws1 = makeSheet(adults);
    const ws2 = makeSheet(children);
    ws1['!cols'] = [14, 14, 10, 12, 12, 8, 8, 14, 14, 14, 40, 12, 8, 8].map(w => ({ wch: w }));
    ws2['!cols'] = ws1['!cols'];
    XLSX.utils.book_append_sheet(wb, ws1, '成人名冊（15歲以上）');
    XLSX.utils.book_append_sheet(wb, ws2, '未成年名冊（未滿15歲）');

    return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

// ── GET /experience-bookings/insurance-download - 下載保險名冊 XLS ──
router.get('/insurance-download', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { bookingId, gymId, from, to } = req.query;
    const effectiveGymId = req.staff.role === 'super_admin' ? gymId : req.staff.gymId;
    let bookings = [];
    if (bookingId) {
      const doc = await db.collection('experienceBookings').doc(bookingId).get();
      if (doc.exists) bookings = [{ id: doc.id, ...doc.data() }];
    } else {
      let ref = db.collection('experienceBookings').where('status', '!=', 'cancelled');
      if (effectiveGymId) ref = ref.where('gymId', '==', effectiveGymId);
      const snap = await ref.get();
      bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (from) bookings = bookings.filter(b => b.bookingDate >= from);
      if (to)   bookings = bookings.filter(b => b.bookingDate <= to);
    }
    const buf = buildInsuranceXlsBuffer(bookings);
    const today = taiwanToday().replace(/-/g, '');
    res.setHeader('Content-Type', 'application/vnd.ms-excel');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`旅平險名冊_${today}.xls`)}`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /experience-bookings/:id/send-insurance-email - 一鍵寄送單筆保險名冊 ──
router.post('/:id/send-insurance-email', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('experienceBookings').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此預約' });
    const b = { id: doc.id, ...doc.data() };

    const sdoc = await db.collection('systemSettings').doc('experienceCourses').get();
    const settings = sdoc.exists ? sdoc.data() : {};
    const to = (settings.insuranceRecipientEmail || '').trim();
    if (!to) return res.status(400).json({ error: 'NO_RECIPIENT', message: '尚未設定保險名冊收件人 email（請至體驗課程設定填寫）' });

    // 標題：紅石攀岩{館}{年}年{月}月{日}日{首位姓名}等{N}人保險名冊
    const gymName = b.gymId === 'gym-hsinchu' ? '新竹館' : b.gymId === 'gym-shilin' ? '士林館' : '';
    const [yy, mm, dd] = String(b.bookingDate || '').split('-');
    const firstName = (b.participants && b.participants[0]?.name) || b.contactName || '';
    const count = b.numParticipants || (b.participants || []).length || 0;
    const title = `紅石攀岩${gymName}${yy || ''}年${mm ? parseInt(mm) : ''}月${dd ? parseInt(dd) : ''}日${firstName}等${count}人保險名冊`;

    const tpl = settings.insuranceEmailTemplate || '{title}';
    const body = tpl.replace(/{title}/g, title).replace(/{gym}/g, gymName)
      .replace(/{date}/g, b.bookingDate || '').replace(/{name}/g, firstName).replace(/{count}/g, count);

    const buf = buildInsuranceXlsBuffer([b]);
    const fileName = `${title}.xls`;

    const result = await emailService.sendEmail({
      to, subject: title,
      html: `<div style="font-family:sans-serif;white-space:pre-wrap;font-size:14px">${emailService.esc(body)}</div>`,
      text: body,
      attachments: [{ filename: fileName, content: buf.toString('base64') }],
    });
    if (result.error) return res.status(502).json({ error: 'EMAIL_FAILED', message: '寄送失敗：' + result.error });

    // 上傳 Storage + 保存歷史紀錄
    let fileUrl = null, filePath = null;
    try {
      const bucket = getStorage().bucket();
      filePath = `insurance-rosters/${b.gymId}/${b.id}_${Date.now()}.xls`;
      const f = bucket.file(filePath);
      await f.save(buf, { metadata: { contentType: 'application/vnd.ms-excel' } });
      [fileUrl] = await f.getSignedUrl({ action: 'read', expires: '2035-01-01' });
    } catch (e) { console.error('insurance storage:', e.message); }

    await db.collection('insuranceExports').add({
      bookingId: b.id, gymId: b.gymId, courseType: b.courseType,
      title, recipient: to, bookingDate: b.bookingDate, count, firstName,
      fileName, filePath, fileUrl,
      emailId: result.id || null, skipped: !!result.skipped,
      sentBy: req.staff.id, sentByName: req.staff.name, createdAt: new Date(),
    });

    res.json({ success: true, title, message: result.skipped ? '已建立名冊並保存（Email 未設定 RESEND_API_KEY，未實際寄出）' : `已寄送至 ${to}` });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /experience-bookings/insurance-history - 歷史保險名冊（分館）──
router.get('/insurance-history', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff.role === 'super_admin' ? (req.query.gymId || null) : req.staff.gymId;
    const snap = await db.collection('insuranceExports').get();
    let records = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (gymId) records = records.filter(r => r.gymId === gymId);
    records.sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json({ records: records.slice(0, 200) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /experience-bookings/settings - 取得課程設定 ──────────────
router.get('/settings', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('experienceCourses').get();
    if (doc.exists) return res.json(doc.data());
    // 預設值
    res.json(defaultSettings());
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── PUT /experience-bookings/settings - 更新課程設定 ──────────────
router.put('/settings', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('systemSettings').doc('experienceCourses').set({
      ...req.body, updatedAt: new Date(), updatedBy: req.staff.id,
    });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

function defaultSettings() {
  return {
    description: '想要攀岩，卻總是不得其門而入？紅石抱石體驗課程專為新手設計，從安全守則、攀爬規則、熱身、手/腳動作技巧到路線示範，由教練全程指導。',
    notice: '請先透過粉絲頁確認日期時間後再填寫。費用含入場、岩鞋租借、教練費及一日活動保險，一經投保恕無法退保。',
    paymentDeadlineDays: 3,
    bankInfo: {
      hsinchu: { bankName: '台新銀行(812)', branch: '關東橋分行', account: '21000100211430', accountName: '紅石攀岩有限公司' },
      shilin:  { bankName: '富邦銀行(012)', branch: '竹北分行', account: '746102003014', accountName: '紅石攀岩有限公司' },
    },
    courseTypes: [
      { id:'general',    label:'抱石體驗課程',           active:true, needsInsurance:true,
        pricingType:'tiered',
        tiers:[{min:1,max:1,price:975},{min:2,max:3,price:875},{min:4,max:5,price:825},{min:6,max:12,price:775}],
        durationNote:'1~2小時' },
      { id:'children',   label:'小蜘蛛人（兒童）',         active:true, needsInsurance:false, pricingType:'fixed', price:600, durationNote:'1小時' },
      { id:'skill_fri',  label:'抱石技巧班（週五20:00）',   active:true, needsInsurance:true, pricingType:'fixed', price:1075, durationNote:'2小時' },
      { id:'skill_sun14',label:'抱石技巧班（週日14:00）',   active:true, needsInsurance:true, pricingType:'fixed', price:900,  durationNote:'1.5小時' },
    ],
    // 保險名冊一鍵寄送設定
    insuranceRecipientEmail: '',   // 全館共用收件人 email
    insuranceEmailTemplate: '{title}', // 信件內容公版（可用 {title} {gym} {date} {name} {count}）
    hsinchu: { bankInfo: null }, // 新竹館可覆蓋匯款帳號
  };
}

// ── POST /experience-bookings/expire-unpaid - 到期未付款自動取消 ──
// 可設定 cron 每天執行，或加入待辦總覽手動觸發
router.post('/expire-unpaid', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const settings = await db.collection('systemSettings').doc('experienceCourses').get();
    const deadlineDays = settings.exists ? (settings.data().paymentDeadlineDays || 3) : 3;
    const cutoff = new Date(Date.now() - deadlineDays * 24 * 3600000);

    const snap = await db.collection('experienceBookings').where('status', '==', 'pending').get();
    let cancelled = 0;
    for (const doc of snap.docs) {
      const createdAt = doc.data().createdAt?.toDate?.() || new Date(0);
      if (createdAt < cutoff) {
        await doc.ref.update({ status: 'cancelled', cancelReason: `超過 ${deadlineDays} 日未付款自動取消`, cancelledAt: new Date(), updatedAt: new Date() });
        cancelled++;
      }
    }
    res.json({ success: true, cancelled, message: `已取消 ${cancelled} 筆逾期未付款預約` });
  } catch(err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
