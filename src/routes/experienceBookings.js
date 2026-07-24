const { taiwanToday } = require('../utils/taiwanDate');
const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { authenticate, authenticateAny, requireManager } = require('../middleware/auth');
const { getDb, getStorage } = require('../config/firebase');
const XLSX = require('xlsx');
const { sanitizeSheet } = require('../utils/xlsxSafe');
const emailService = require('../services/emailService');
const courseService = require('../services/courseService');
const scheduleService = require('../services/scheduleService');
const memberService = require('../services/memberService');
const { COURSE_TYPES, parseBookingTime, courseTypeLabel, addExperienceToCourseAndSchedule, reassignExperienceCoach,
        updateExperienceSchedule,
        cleanupExperienceCourseAndSchedule, syncExperienceTickets, voidExperienceTickets, buildInsuranceXlsBuffer,
        defaultSettings, recordExperienceRevenue, reverseExperienceRevenue } = require('../services/experienceService');
const { isUnder5 } = require('../utils/age');
const { checkMemberOwnership } = require('../utils/memberOwnership');
const { notifyRoleInGym } = require('../services/notificationService');

router.post('/', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id || req.body.memberId;
    // 🧪 模擬報名：短路，不建真實預約/課程/排班（不佔名額）
    {
      const _sm = memberId ? await require('../services/memberService').getMember(memberId).catch(() => null) : null;
      if (_sm?.isSimulation) return res.json(await require('../services/simulationService').handleSimulatedRegistration(getDb(), { type: 'experience', member: _sm, targetId: req.body.courseType, payload: req.body }));
    }
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
      // 試上開關/試上費走班別規則繼承（梯次可覆寫）
      const trialRules = courseService.resolveRules(course, await courseService.getCategoryOf(db, course.categoryId));
      if (trialRules.allowTrial !== true) return res.status(400).json({ code:'TRIAL_NOT_ALLOWED', message:'此課程未開放試上' });
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

      const trialFee = trialRules.trialPrice || 0;
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
        memberPaidAmount: req.body.paidAmount ? Number(req.body.paidAmount) : null, // 會員自填實際匯款金額
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
    if (!_ct || _ct.active === false) return res.status(400).json({ code:'INVALID_COURSE_TYPE', message:'此體驗課程類型未開放（請改由課程試上報名）' });
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
      memberPaidAmount: req.body.paidAmount ? Number(req.body.paidAmount) : null, // 會員自填實際匯款金額
      notes: notes||'',
      status: 'pending', // pending | confirmed | cancelled
      createdAt: new Date(), updatedAt: new Date(),
    });
    // 報名收到 → 寄「繳費通知」給聯絡人（cc 該館）；含應繳金額＋該館匯款帳號。非同步、失敗不阻斷。
    const _bookingEmail = contactEmail || req.member?.email;
    if (_bookingEmail) {
      try {
        const _bankKey = gymId === 'gym-hsinchu' ? 'hsinchu' : 'shilin';
        const _bank = (_settings.bankInfo || _settings.bank || {})[_bankKey] || null;
        const _gymDoc2 = await db.collection('gyms').doc(gymId).get();
        const _gymCc2 = _gymDoc2.exists ? _gymDoc2.data().email : undefined;
        emailService.sendExperienceBookingReceived(
          _bookingEmail, contactName || req.member?.name || '',
          { bookingDate, bookingTime, gymId, numParticipants: participants.length, totalFee: computedFee },
          { bank: _bank, insuranceFee: _settings.insuranceFee ?? 175, cc: _gymCc2 }
        ).catch(e => console.error('[Email] 體驗報名通知', e.message));
      } catch (e) { console.error('[Email] 體驗報名通知', e.message); }
    }
    res.status(201).json({ success:true, id, message:'預約已送出，請於3日內完成匯款' });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── GET /experience-bookings/public-settings - 公開讀取（免登入，供公開預約頁顯示課程類型/價格/場館）──
router.get('/public-settings', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('experienceCourses').get();
    const settings = doc.exists ? doc.data() : defaultSettings();
    const courseTypes = (settings.courseTypes || defaultSettings().courseTypes)
      .filter(c => c.active !== false)
      .map(c => ({ id: c.id, name: c.name, pricingType: c.pricingType || 'fixed', price: c.price || 0, tiers: c.tiers || null }));
    const gymsSnap = await db.collection('gyms').get();
    const gyms = gymsSnap.docs.map(d => ({ id: d.id, name: d.data().name })).filter(g => g.name);
    const bank = settings.bankInfo || settings.bank || null; // 匯款帳號資訊（若有設定）
    res.json({ courseTypes, gyms, insuranceFee: settings.insuranceFee ?? 175, bankInfo: bank });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /experience-bookings/public - 公開預約（免登入、訪客、先轉帳；IP 限流見 index.js）──
// 非會員也能預約體驗課；不建帳號（memberId:null、isGuest），之後註冊用電話認領。金額後端權威。
router.post('/public', async (req, res) => {
  try {
    const db = getDb();
    const {
      gymId, bookingDate, bookingTime, courseType,
      contactName, contactEmail, contactPhone, facebookName,
      participants, paymentDate, bankLastFive, paidAmount, notes, agreedTerms,
    } = req.body;
    if (!contactName || !String(contactName).trim()) return res.status(400).json({ code:'MISSING_CONTACT', message:'請填寫聯絡人姓名' });
    if (!contactPhone || !String(contactPhone).trim()) return res.status(400).json({ code:'MISSING_PHONE', message:'請填寫聯絡電話' });
    if (!gymId) return res.status(400).json({ code:'MISSING_GYM', message:'請選擇場館' });
    if (!bookingDate) return res.status(400).json({ code:'MISSING_DATE', message:'請選擇體驗日期' });
    if (!participants?.length) return res.status(400).json({ code:'MISSING_PARTICIPANTS', message:'請填寫參加人員資料' });
    if (!bankLastFive || !String(bankLastFive).trim()) return res.status(400).json({ code:'MISSING_TRANSFER', message:'請填寫匯款帳號末五碼' });
    if (agreedTerms !== true) return res.status(400).json({ code:'TERMS_REQUIRED', message:'請閱讀並同意注意事項' });

    // 未滿 5 歲擋（參加者生日；公開頁送 ISO 西元 YYYY-MM-DD）
    const _under5 = (s) => { const d = s ? require('dayjs')(String(s)) : null; return d && d.isValid() && require('dayjs')().diff(d, 'year') < 5; };
    if ((participants || []).some(p => _under5(p?.birthday))) return res.status(400).json({ code:'AGE_UNDER_5', message:'未滿 5 歲無法報名體驗' });

    // 後端權威計費（同會員預約邏輯）
    const _sDoc = await db.collection('systemSettings').doc('experienceCourses').get();
    const _settings = _sDoc.exists ? _sDoc.data() : defaultSettings();
    const _courseTypes = _settings.courseTypes || defaultSettings().courseTypes;
    const _ct = _courseTypes.find(c => c.id === (courseType || 'general'));
    if (!_ct || _ct.active === false) return res.status(400).json({ code:'INVALID_COURSE_TYPE', message:'此體驗課程類型未開放' });
    const _n = participants.length;
    let _unit = 0;
    if (_ct.pricingType === 'tiered' && Array.isArray(_ct.tiers)) {
      const _t = _ct.tiers.find(t => _n >= t.min && _n <= t.max);
      _unit = _t ? _t.price : (_ct.tiers[_ct.tiers.length - 1]?.price || 0);
    } else { _unit = _ct.price || 0; }
    const computedFee = _unit * _n;

    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    await db.collection('experienceBookings').doc(id).set({
      id, memberId: null, isGuest: true, source: 'public',
      gymId, bookingDate, bookingTime: bookingTime || '', courseType: courseType || 'general',
      contactName: String(contactName).trim(),
      contactEmail: (contactEmail || '').trim(),
      contactPhone: String(contactPhone).trim(),
      facebookName: facebookName || '',
      participants, numParticipants: _n,
      totalFee: computedFee,
      paymentMethod: 'transfer',
      paymentDate: paymentDate || null,
      bankLastFive: String(bankLastFive).trim(),
      memberPaidAmount: paidAmount ? Number(paidAmount) : null,
      notes: notes || '',
      agreedTerms: true,
      status: 'pending',
      createdAt: new Date(), updatedAt: new Date(),
    });
    res.status(201).json({ success: true, id, totalFee: computedFee, message: '預約已送出！請於 3 日內完成匯款，我們確認後會與您聯繫。' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
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
    const bookings = snap.docs.map(d=>{
      const { staffNote, staffNoteBy, staffNoteAt, ...rest } = d.data(); // 員工備註不回傳會員端
      return { id:d.id, ...rest };
    }).sort((a,b)=>(b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
    res.json({ bookings });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── 解析預約時間字串 → { startTime, endTime } ─────────────────────
// 預約時間為自由文字（如 "16:00-17:30"、"14:00"、"下午兩點"）。
// 抓得到兩個時刻→視為起訖；只有一個→以該時刻起、+2 小時為迄；抓不到→null（改用整天班）。
router.post('/:id/confirm', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('experienceBookings').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此預約' });
    const booking = { id: doc.id, ...doc.data() };
    const _gymCcDoc = await db.collection('gyms').doc(booking.gymId).get();
    const _gymCc = _gymCcDoc.exists ? _gymCcDoc.data().email : undefined; // 確認信副本給該館

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
        await recordExperienceRevenue(db, ref, booking, req.staff).catch(e => console.error('[體驗營收]', e.message));
        // 試上確認收款 → 自動發 1 張當日體驗券（冪等：sync 依已發張數補差；入場當日豁免墜測）
        await syncExperienceTickets(db, booking, req.staff, true).catch(e => console.error('[試上發券]', e.message));
        if (booking.contactEmail) {
          emailService.sendExperienceBookingConfirmation(booking.contactEmail, booking.contactName, booking, _gymCc).catch(e => console.error('[Email]', e.message));
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
      await recordExperienceRevenue(db, ref, booking, req.staff).catch(e => console.error('[體驗營收]', e.message));
      await syncExperienceTickets(db, booking, req.staff, true).catch(e => console.error('[試上發券]', e.message));
      if (booking.contactEmail) {
        emailService.sendExperienceBookingConfirmation(booking.contactEmail, booking.contactName, booking, _gymCc).catch(e => console.error('[Email]', e.message));
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
    await recordExperienceRevenue(db, ref, booking, req.staff).catch(e => console.error('[體驗營收]', e.message));

    // 發送確認信
    if (booking.contactEmail) {
      emailService.sendExperienceBookingConfirmation(booking.contactEmail, booking.contactName, booking, _gymCc).catch(e => console.error('[Email]', e.message));
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
    await reverseExperienceRevenue(db, ref, booking).catch(e => console.error('[體驗沖銷]', e.message));
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

// ── 會員端操作共用：擁有權 + 活動一天前鎖定 ─────────────────────
async function memberBookingGuard(req, res) {
  const db = getDb();
  const ref = db.collection('experienceBookings').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) { res.status(404).json({ error:'NOT_FOUND', message:'查無此預約' }); return null; }
  const booking = { id: snap.id, ...snap.data() };
  // 擁有權：本人／家長代訂（bookedByMemberId）／子女（checkMemberOwnership）
  const me = req.member?.id;
  if (booking.memberId !== me && booking.bookedByMemberId !== me) {
    const deny = await checkMemberOwnership(req.member, booking.memberId, { onMissing: 403 });
    if (deny) { res.status(deny.status).json(deny.body); return null; }
  }
  if (!['pending','confirmed'].includes(booking.status)) {
    res.status(400).json({ error:'INVALID_STATUS', message:'此預約已取消或已結束' }); return null;
  }
  // 活動一天前鎖定：今天需早於活動日
  if (!booking.bookingDate || taiwanToday() >= booking.bookingDate) {
    res.status(400).json({ error:'DEADLINE_PASSED', message:'活動一天前已鎖定，如需異動請洽櫃檯' }); return null;
  }
  return { ref, booking };
}

// ── POST /experience-bookings/:id/member-cancel - 會員取消（已繳費須留退款帳號，扣手續費退回） ──
router.post('/:id/member-cancel', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const g = await memberBookingGuard(req, res);
    if (!g) return;
    const { ref, booking } = g;
    const paid = ['confirmed','paid'].includes(booking.paymentStatus);
    const upd = { status:'cancelled', cancelReason:'會員自行取消', cancelledAt:new Date(), cancelledBy:'member', updatedAt:new Date() };
    let refundAmount = 0, fee = 0;
    if (paid && (booking.totalFee || 0) > 0) {
      const { refundBankCode, refundAccount, refundAccountName, refundBankName } = req.body;
      if (!refundBankCode || !refundAccount) {
        return res.status(400).json({ error:'MISSING_REFUND_ACCOUNT', message:'已繳費之預約取消需填寫退款帳號（銀行代碼＋帳號）' });
      }
      const _sd = await db.collection('systemSettings').doc('experienceCourses').get();
      fee = Number((_sd.exists ? _sd.data() : {}).refundHandlingFee ?? 100);
      refundAmount = Math.max(0, (booking.totalFee || 0) - fee);
      Object.assign(upd, {
        refundRequested: true, refundBankCode, refundAccount,
        refundAccountName: refundAccountName || '', refundBankName: refundBankName || '',
        refundHandlingFee: fee, refundAmount, refundStatus: 'pending',
      });
    }
    await ref.update(upd);
    await reverseExperienceRevenue(db, ref, booking).catch(e => console.error('[體驗沖銷]', e.message));
    // 與員工取消同一套清理：作廢未用票券、釋放試上名額、清課程/場次/排班
    const voided = await voidExperienceTickets(db, booking.id, '會員取消預約');
    if (booking.kind === 'trial' && booking.trialEnrollmentId) {
      await courseService.removeTrialEnrollment(booking.trialEnrollmentId).catch(e => console.error('[會員取消試上] 移除名單失敗', e.message || e.code));
    }
    await cleanupExperienceCourseAndSchedule(db, booking, null).catch(e => console.error('[會員取消] 清理失敗', e.message));
    // 作廢 pending 轉帳單（避免殘留待收款）
    try {
      const ts = await db.collection('transferRecords').where('refId','==',booking.id).get();
      const batch = db.batch();
      ts.docs.filter(d=>d.data().status==='pending')
        .forEach(d=>batch.update(d.ref,{ status:'void', voidReason:'booking_cancelled', updatedAt:new Date() }));
      await batch.commit();
    } catch(e) {}
    // 已繳費退款 → 通知同館管理員處理
    if (upd.refundRequested) {
      try {
        await notifyRoleInGym({ gymId: booking.gymId, role:'gym_manager', type:'experience_refund',
          title:'體驗/試上取消退款', body:`${booking.memberName || booking.contactName} 取消 ${booking.bookingDate} 預約，應退 NT$${refundAmount}（已扣手續費 NT$${fee}），退款帳號 ${upd.refundBankCode}-${upd.refundAccount}`,
          referenceId: booking.id, referenceType:'experienceBooking' });
      } catch(e) {}
    }
    res.json({ success:true, voidedTickets: voided, refundRequested: !!upd.refundRequested, refundAmount, fee,
      message: upd.refundRequested ? `已取消，退款 NT$${refundAmount}（已扣手續費 NT$${fee}）將由館方匯至您提供的帳號` : '預約已取消' });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── PUT /experience-bookings/:id/member-edit - 會員修改（體驗改日期/時段；試上換場次同價） ──
router.put('/:id/member-edit', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const g = await memberBookingGuard(req, res);
    if (!g) return;
    const { ref, booking } = g;
    if (booking.kind === 'trial') {
      // 試上：換場次（新場次須同試上費；名額/候補由 enrollTrial 權威判定）
      const newSessionId = req.body.sessionId;
      if (!newSessionId) return res.status(400).json({ error:'MISSING_SESSION', message:'請選擇新場次' });
      if (newSessionId === booking.sessionId) return res.status(400).json({ error:'SAME_SESSION', message:'已是此場次' });
      const sDoc = await db.collection('courseSessions').doc(newSessionId).get();
      if (!sDoc.exists) return res.status(400).json({ error:'SESSION_NOT_FOUND', message:'找不到新場次' });
      const sess = sDoc.data();
      if (!sess.date || taiwanToday() >= sess.date) return res.status(400).json({ error:'INVALID_DATE', message:'新場次需晚於今天' });
      // 同館 + 同試上費才可直接改期（費用不同請取消後重新報名）
      if (sess.gymId && booking.gymId && sess.gymId !== booking.gymId) {
        return res.status(400).json({ error:'GYM_MISMATCH', message:'僅能改期至同館場次' });
      }
      const targetCourse = sess.courseId ? (await db.collection('courses').doc(sess.courseId).get()).data() : null;
      const targetRules = courseService.resolveRules(targetCourse || {}, await courseService.getCategoryOf(db, targetCourse?.categoryId));
      const targetPrice = targetRules.trialPrice || 0;
      if ((booking.totalFee || 0) !== targetPrice) {
        return res.status(400).json({ error:'PRICE_MISMATCH', message:'新場次試上費不同，請取消後重新報名' });
      }
      const enDoc = booking.trialEnrollmentId ? await db.collection('courseEnrollments').doc(booking.trialEnrollmentId).get() : null;
      const curPayStatus = enDoc?.exists ? (enDoc.data().paymentStatus || 'pending') : 'pending';
      const curDeadline = enDoc?.exists ? (enDoc.data().paymentDeadline || null) : null;
      const trial = await courseService.enrollTrial({
        memberId: booking.memberId, memberName: booking.memberName || booking.contactName || '',
        sessionId: newSessionId, gymId: booking.gymId, trialFee: booking.totalFee || 0,
        bookingId: booking.id, paymentStatus: curPayStatus, paymentDeadline: curDeadline,
      });
      if (booking.trialEnrollmentId) {
        await courseService.removeTrialEnrollment(booking.trialEnrollmentId).catch(e => console.error('[試上改期] 移除原名單失敗', e.message || e.code));
      }
      const isWaitlist = trial.status === 'waitlist';
      await ref.update({
        sessionId: newSessionId, courseId: sess.courseId || booking.courseId,
        bookingDate: sess.date || booking.bookingDate,
        bookingTime: `${sess.startTime||''}~${sess.endTime||''}`,
        trialEnrollmentId: trial.enrollmentId, isWaitlist,
        editedAt: new Date(), editedBy: 'member', updatedAt: new Date(),
      });
      return res.json({ success:true, isWaitlist,
        message: isWaitlist ? '已改期（該場次額滿，已列入候補）' : '已改期至新場次' });
    }
    // 一般體驗：改日期/時段（連動課程/場次/教練排班/票券效期）
    const bookingDate = (req.body.bookingDate || '').trim();
    const bookingTime = (req.body.bookingTime || '').trim();
    if (!bookingDate) return res.status(400).json({ error:'MISSING_DATE', message:'請填寫體驗日期' });
    if (taiwanToday() >= bookingDate) return res.status(400).json({ error:'INVALID_DATE', message:'新日期需晚於今天' });
    await ref.update({ bookingDate, bookingTime, editedAt:new Date(), editedBy:'member', updatedAt:new Date() });
    const b = { id: booking.id, ...booking, bookingDate, bookingTime };
    const r = await updateExperienceSchedule(db, b, null);
    if ((r.scheduleShiftId || null) !== (booking.scheduleShiftId || null)) {
      await ref.update({ scheduleShiftId: r.scheduleShiftId || null });
    }
    res.json({ success:true, bookingDate, bookingTime, message:'已更新預約日期/時段' });
  } catch(err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error:'SERVER_ERROR', message:err.message });
  }
});

// ── PUT /experience-bookings/:id/staff-note - 員工備註（會員看不到；/my 已剔除） ──
router.put('/:id/staff-note', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('experienceBookings').doc(req.params.id).update({
      staffNote: String(req.body.staffNote || ''),
      staffNoteBy: req.staff.name || req.staff.id, staffNoteAt: new Date(), updatedAt: new Date(),
    });
    res.json({ success:true, message:'備註已儲存' });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

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

// ── PUT /experience-bookings/:id/schedule - 編輯課程日期/時段（連動 課程/場次/教練排班/入場券）──
router.put('/:id/schedule', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('experienceBookings').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此預約' });
    const bookingDate = (req.body.bookingDate || '').trim();
    const bookingTime = (req.body.bookingTime || '').trim();
    if (!bookingDate) return res.status(400).json({ error: 'MISSING_DATE', message: '請填寫體驗日期' });
    await ref.update({ bookingDate, bookingTime, updatedAt: new Date() });
    const b = { id: doc.id, ...doc.data(), bookingDate, bookingTime };
    const r = await updateExperienceSchedule(db, b, req.staff);
    if ((r.scheduleShiftId || null) !== (b.scheduleShiftId || null)) {
      await ref.update({ scheduleShiftId: r.scheduleShiftId || null });
    }
    res.json({ success: true, bookingDate, bookingTime, ...r });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /experience-bookings/:id/finance - 管理員填教練費/發票金額 ──
router.put('/:id/finance', authenticate, requireManager, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('experienceBookings').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此預約' });
    const coachFee = req.body.coachFee === '' || req.body.coachFee == null ? null : Number(req.body.coachFee);
    const invoiceAmount = req.body.invoiceAmount === '' || req.body.invoiceAmount == null ? null : Number(req.body.invoiceAmount);
    if (coachFee != null && (!Number.isFinite(coachFee) || coachFee < 0)) return res.status(400).json({ error: 'INVALID_VALUE', message: '教練費無效' });
    if (invoiceAmount != null && (!Number.isFinite(invoiceAmount) || invoiceAmount < 0)) return res.status(400).json({ error: 'INVALID_VALUE', message: '發票金額無效' });
    await ref.update({
      coachFee, invoiceAmount,
      financeUpdatedBy: req.staff.id, financeUpdatedByName: req.staff.name || '', financeUpdatedAt: new Date(),
      updatedAt: new Date(),
    });
    res.json({ success: true, coachFee, invoiceAmount });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /experience-bookings/download - 下載 XLS 名單 ─────────────
router.get('/download', authenticate, requireManager, async (req, res) => {
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
          '生日': p.birthday||'',
          '國籍': p.nationality||'台灣',
          '費用': idx===0 ? b.totalFee : '',
          '匯款末五碼': idx===0 ? (b.bankLastFive||'') : '',
          '備註': idx===0 ? (b.notes||'') : '',
        });
      });
    });

    if (rows.length===0) rows.push({ '場館':'無資料','預約日期':'','預約時間':'','課程類型':'','總人數':'','狀態':'','聯絡人':'','聯絡電話':'','序號':'','參加者姓名':'','身分證字號':'','生日':'','國籍':'','費用':'','匯款末五碼':'','備註':'' });

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
router.get('/insurance-download', authenticate, requireManager, async (req, res) => {
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
    // 副本收件人（選填；逗號/分號/空白分隔多個）
    const cc = String(settings.insuranceCcEmails || '').split(/[,;\s]+/).map(s => s.trim()).filter(s => /.+@.+\..+/.test(s));

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
      to, cc, subject: title,
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
      title, recipient: to, cc, bookingDate: b.bookingDate, count, firstName,
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
router.put('/settings', authenticate, requireManager, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('systemSettings').doc('experienceCourses').set({
      ...req.body, updatedAt: new Date(), updatedBy: req.staff.id,
    });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

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
