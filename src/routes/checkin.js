/**
 * 入場登記路由 v2
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAny, checkPermission } = require('../middleware/auth');
const checkinService = require('../services/checkinService');
const memberService = require('../services/memberService');
const dayjs = require('dayjs');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// ── POST /checkin/verify ─────────────────────────────────────────
// 會員端或工作人員端皆可呼叫
router.post('/verify',
  authenticateAny,
  [
    body('identifier').notEmpty().withMessage('請輸入 QR Code ID 或手機號碼'),
    body('gymId').notEmpty().withMessage('請指定場館'),
  ],
  validate,
  async (req, res) => {
    try {
      const { identifier, gymId, targetMemberId } = req.body;
      const effectiveGymId = req.staff?.role === 'super_admin' ? gymId : (req.staff?.gymId || gymId);

      // 會員自助驗票一律以登入身分(token)為準，不用電話反查，
      // 避免家長與子會員共用同一支電話時被誤判為對方（電話非唯一，反查不可靠）
      // 親子帳號：家長可帶 targetMemberId 為「自己的子會員」驗票
      let member;
      if (req.member) {
        let targetId = req.member.id;
        if (targetMemberId && targetMemberId !== req.member.id) {
          const child = await memberService.getMember(targetMemberId);
          if (!child || child.parentMemberId !== req.member.id) {
            return res.status(403).json({ error: 'FORBIDDEN', message: '只能查詢自己或自己子會員的入場資格' });
          }
          targetId = targetMemberId;
        }
        member = await memberService.getMember(targetId);
      } else if (identifier.startsWith('RR-')) {
        member = await memberService.getMemberByQRCode(identifier);
      } else {
        member = await memberService.getMemberByPhone(identifier);
      }

      const result = await checkinService.verifyEntry(member.id, effectiveGymId);
      res.json(result);
    } catch (err) {
      if (err.code === 'MEMBER_NOT_FOUND') return res.status(404).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /checkin/qr/create ──────────────────────────────────────
// 會員端或工作人員端皆可呼叫
router.post('/qr/create',
  authenticateAny,
  [
    body('memberId').notEmpty(),
    body('gymId').notEmpty(),
    body('entryType').notEmpty(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        memberId, gymId, entryType, baseEntryType,
        passId, discountCardId, blackCardId, singleEntryTicketId, bonusId,
        paymentMethod, amount, originalAmount, isTeamDiscount,
        rentShoes, shoesPrice, rentChalk, chalkPrice,
      } = req.body;

      // 親子帳號：家長可為「自己的子會員」產生入場 QR（需驗證擁有權）
      let effectiveMemberId;
      if (req.member) {
        effectiveMemberId = req.member.id;
        if (memberId && memberId !== req.member.id) {
          const child = await memberService.getMember(memberId);
          if (!child || child.parentMemberId !== req.member.id) {
            return res.status(403).json({ error: 'FORBIDDEN', message: '只能為自己或自己子會員產生入場 QR' });
          }
          effectiveMemberId = memberId;
        }
      } else {
        effectiveMemberId = memberId;
      }
      const effectiveGymId = req.staff?.role === 'super_admin' ? gymId : (req.staff?.gymId || gymId);

      const result = await checkinService.createPendingCheckIn({
        memberId: effectiveMemberId,
        gymId: effectiveGymId,
        entryType, baseEntryType, passId, discountCardId, blackCardId, singleEntryTicketId, bonusId,
        paymentMethod, amount, originalAmount, isTeamDiscount,
        rentShoes, shoesPrice, rentChalk, chalkPrice,
      });

      res.status(201).json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /checkin/qr/scan ────────────────────────────────────────
router.post('/qr/scan',
  authenticate,
  checkPermission('checkin.create'),
  [body('qrToken').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await checkinService.scanQrCode(req.body.qrToken);
      res.json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /checkin/qr/confirm ─────────────────────────────────────
router.post('/qr/confirm',
  authenticate,
  checkPermission('checkin.create'),
  [body('qrToken').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await checkinService.confirmCheckIn(req.body.qrToken, req.staff.id, req.staff.name);
      res.status(201).json({ ...result, message: '入場登記成功' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /checkin/cancel ─────────────────────────────────────────
router.post('/cancel',
  authenticate,
  checkPermission('checkin.create'),
  [body('checkInId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const force = req.body.force === true && req.staff.role === 'super_admin';
      const result = await checkinService.cancelCheckIn(req.body.checkInId, req.staff.id, force);
      res.json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /checkin/record ─────────────────────────────────────────
router.post('/record',
  authenticate,
  checkPermission('checkin.create'),
  [body('memberId').notEmpty(), body('gymId').notEmpty(), body('entryType').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const effectiveGymId = req.staff.role === 'super_admin' ? req.body.gymId : req.staff.gymId;
      const checkIn = await checkinService.recordCheckIn({
        memberId: req.body.memberId,
        gymId: effectiveGymId,
        staffId: req.staff.id,
        entryType: req.body.entryType,
        passId: req.body.passId,
        courseEnrollmentId: req.body.courseEnrollmentId,
        transactionId: req.body.transactionId,
        notes: req.body.notes,
      });
      res.status(201).json({ checkIn, message: '入場登記成功' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /checkin/eligibility/:memberId - 查詢會員入場類型資格（手機入場篩選用）──
router.get('/eligibility/:memberId', authenticate, async (req, res) => {
  try {
    const db = require('../config/firebase').getDb();
    const memberDoc = await db.collection('members').doc(req.params.memberId).get();
    if (!memberDoc.exists) return res.status(404).json({ message: '會員不存在' });
    const member = memberDoc.data();
    const hasCourseAccess = (await checkinService.getCourseAccess(req.params.memberId)).length > 0;
    // 即時查詢 Waiver 狀態
    const waiverDoc = await db.collection('waivers').doc(req.params.memberId).get();
    const waiverSigned = waiverDoc.exists && waiverDoc.data().isComplete === true;

    // 查詢 VIP 狀態（先查 vipMembers collection，再查 memberType 欄位）
    const { checkVip } = require('../services/checkinService');
    const vipFromCollection = await checkVip(req.params.memberId);
    const vipFromMemberType = member.memberType === 'vip';
    const isVip = !!(vipFromCollection || vipFromMemberType);
    const vip = vipFromCollection || (vipFromMemberType ? { note: member.vipNote || '' } : null);

    // 查詢有效定期票
    const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
    const passSnap = await db.collection('memberPasses')
      .where('memberId', '==', req.params.memberId)
      .where('status', '==', 'active')
      .get();
    const hasValidPass = passSnap.docs.some(d => {
      const p = d.data();
      return p.endDate >= today && (p.scope === 'all' || p.gymId === (req.query.gymId || ''));
    });

    // 墜落測驗狀態（櫃檯入場閘門用，與會員自助 verifyEntry 一致）
    const fallTest = await checkinService.checkFallTest(req.params.memberId);

    // 可用票券（櫃檯兩段流程：選身分後可選用優惠券/黑卡/紅利/單次券）
    const discountCards = await require('../services/discountCardService').getValidDiscountCards(req.params.memberId);
    const blackCards = await require('../services/legacyCardService').getMemberBlackCards(req.params.memberId);
    const bonuses = await require('../services/bonusService').getMemberBonuses(req.params.memberId);
    const setSnap = await db.collection('singleEntryTickets')
      .where('memberId', '==', req.params.memberId)
      .where('status', '==', 'active')
      .where('expiresAt', '>=', today)
      .get();
    const memberType = member.memberType || 'general';

    res.json({
      memberType,
      hasCourseAccess,
      waiverSigned,
      hasValidPass,
      isVip,
      vipNote: vip?.note || null,
      fallTestPassed: fallTest.passed,
      fallTestReason: fallTest.passed ? null : fallTest.reason, // 'never_tested' | 'expired'
      // 票券（兒童不適用折扣券）
      instruments: {
        discountCard: {
          available: memberType !== 'child' && discountCards.length > 0,
          rate: 0.8,
          cards: discountCards.map(c => ({ id: c.id, remainingCredits: c.remainingCredits })),
        },
        blackCard: { available: blackCards.length > 0, cards: blackCards.map(c => ({ id: c.id, remainingCredits: c.remainingCredits })) },
        bonus: { available: bonuses.length > 0, bonuses: bonuses.map(b => ({ id: b.id, expiresAt: b.expiresAtFormatted })) },
        singleEntryTicket: { available: !setSnap.empty, tickets: setSnap.docs.map(d => ({ id: d.id })) },
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /checkin/direct - 員工端直接入場（兩段流程：身分＋票券）──────
// 重用 createPendingCheckIn + confirmCheckIn 的結算邏輯（金額後端權威、票券扣除、營收、墜測遞延）
router.post('/direct', authenticate, async (req, res) => {
  try {
    const db = require('../config/firebase').getDb();
    const {
      memberId, gymId, entryType, baseEntryType,
      discountCardId, blackCardId, singleEntryTicketId, bonusId,
      paymentMethod, rentShoes, rentChalk,
    } = req.body;
    if (!memberId || !entryType) return res.status(400).json({ message: '缺少會員或入場類型' });
    const effGym = req.staff?.role === 'super_admin' ? gymId : (req.staff?.gymId || gymId);

    // 同日同館重複入場檢查
    const todayStr = new Date(Date.now() + 8*3600000).toISOString().slice(0, 10);
    const dup = await db.collection('checkIns')
      .where('memberId', '==', memberId).where('gymId', '==', effGym)
      .where('isCancelled', '==', false)
      .where('checkedInAt', '>=', new Date(todayStr + 'T00:00:00+08:00'))
      .where('checkedInAt', '<=', new Date(todayStr + 'T23:59:59+08:00'))
      .get();
    if (!dup.empty) return res.status(400).json({ message: '今日已入場，不可重複入場' });

    const { qrToken } = await checkinService.createPendingCheckIn({
      memberId, gymId: effGym, entryType, baseEntryType,
      discountCardId, blackCardId, singleEntryTicketId, bonusId,
      paymentMethod: paymentMethod || 'cash', rentShoes, rentChalk,
    });
    const result = await checkinService.confirmCheckIn(qrToken, req.staff.id, req.staff.name);
    res.status(201).json(result);
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /checkin/today-course-students - 今日課程學員名單（手機入場頁快速入場用）──
router.get('/today-course-students', authenticate, async (req, res) => {
  try {
    const { gymId } = req.query;
    if (!gymId) return res.status(400).json({ message: '缺少場館資訊' });
    const db = require('../config/firebase').getDb();
    const today = dayjs().format('YYYY-MM-DD');

    // 今日該館所有場次
    const sessionsSnap = await db.collection('courseSessions')
      .where('gymId', '==', gymId)
      .where('date', '==', today)
      .where('status', '==', 'scheduled')
      .get();
    const sessions = sessionsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (sessions.length === 0) return res.json({ students: [] });

    // 各場次的報名者（正取，不含候補/請假）
    const sessionIds = sessions.map(s => s.id);
    const chunks = [];
    for (let i = 0; i < sessionIds.length; i += 30) chunks.push(sessionIds.slice(i, i + 30));
    const enrollments = [];
    for (const chunk of chunks) {
      const snap = await db.collection('courseEnrollments')
        .where('sessionId', 'in', chunk)
        .where('status', '==', 'confirmed')
        .get();
      snap.docs.forEach(d => enrollments.push({ id: d.id, ...d.data() }));
    }
    if (enrollments.length === 0) return res.json({ students: [] });

    // 今日已入場名單（用於標註禁止重複點選）；以台灣時間午夜為界
    const todayStr0 = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const todayStart = new Date(todayStr0 + 'T00:00:00+08:00');
    const checkedInSnap = await db.collection('checkIns')
      .where('gymId', '==', gymId)
      .where('isCancelled', '==', false)
      .where('checkedInAt', '>=', todayStart)
      .get();
    const checkedInMemberIds = new Set(checkedInSnap.docs.map(d => d.data().memberId));

    const sessionMap = {};
    sessions.forEach(s => { sessionMap[s.id] = s; });

    const students = enrollments
      .filter(e => sessionMap[e.sessionId])
      .map(e => {
        const s = sessionMap[e.sessionId];
        return {
          memberId: e.memberId,
          memberName: e.memberName || '',
          courseId: s.courseId,
          courseName: s.courseName || e.courseName || '',
          startTime: s.startTime, endTime: s.endTime,
          alreadyCheckedIn: checkedInMemberIds.has(e.memberId),
        };
      })
      .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    res.json({ students });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /checkin/today ───────────────────────────────────────────
router.get('/today',
  authenticate,
  checkPermission('checkin.read'),
  async (req, res) => {
    try {
      const { getDb } = require('../config/firebase');
      const db = getDb();
      // 「今日」以台灣時間(UTC+8)午夜為界（伺服器為 UTC，不可用 setHours 否則跨日不清空）
      const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      const today = new Date(todayStr + 'T00:00:00+08:00');

      // 個人帳號登入(非館別電腦值班、非管理層)完全看不到今日統計，僅館別電腦值班/各館管理員/總管理員可見
      const isPersonalLogin = req.staff.type === 'staff';
      const isManagement = ['super_admin', 'gym_manager'].includes(req.staff.role);
      if (isPersonalLogin && !isManagement) {
        return res.json({ statsByGym: [], total: 0, recent: [], restricted: true });
      }

      // 取得所有館
      const gymsSnap = await db.collection('gyms').get();
      const allGyms = gymsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const targetGyms = req.staff.role === 'super_admin'
        ? allGyms
        : allGyms.filter(g => g.id === req.staff.gymId);
      const gymIds = targetGyms.map(g => g.id);
      if (!gymIds.length) return res.json({ statsByGym: [], total: 0, recent: [] });

      // 取得今日所有入場
      const snap = await db.collection('checkIns')
        .where('checkedInAt', '>=', today)
        .where('gymId', 'in', gymIds)
        .orderBy('checkedInAt', 'desc')
        .get();

      const records = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(r => r.isCancelled !== true && r.status !== 'cancelled');

      const typeLabel = {
        monthly_pass: '定期票', new_discount_card: '新優惠卡', legacy_discount_card: '舊優惠卡',
        black_card: '黑卡', bonus: '紅利入場', single_ticket: '單次',
        course_access: '課程學員', child_free: '兒童免費', student_free: '學生免費', other: '其他',
        pass: '定期票', discount_card: '優惠折扣券', single_entry_ticket: '單次入場券',
      };

      const statsByGym = targetGyms.map(gym => {
        const gymRecords = records.filter(r => r.gymId === gym.id);
        const counts = {};
        gymRecords.forEach(r => {
          const t = r.entryType || r.passType || 'other';
          counts[t] = (counts[t] || 0) + 1;
        });
        return { gymId: gym.id, gymName: gym.name, total: gymRecords.length, counts };
      });

      const recent = records.slice(0, 20).map(r => ({
        id: r.id, memberName: r.memberName, gymId: r.gymId,
        entryType: r.entryType || r.passType, checkedInAt: r.checkedInAt,
      }));

      res.json({ statsByGym, total: records.length, recent });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /checkin/history ─────────────────────────────────────────
router.get('/history',
  authenticateAny,
  async (req, res) => {
    try {
      const { getDb, COLLECTIONS } = require('../config/firebase');
      const db = getDb();

      // 會員只能查自己的；員工可查指定館別
      const isMemberToken = !!req.member && !req.staff;
      const scopedMemberId = isMemberToken ? req.member.id : req.query.memberId;
      const gymId = isMemberToken ? null : (req.staff?.role === 'super_admin' ? req.query.gymId : req.staff?.gymId);
      const { ticketId, ticketType, dateFrom, dateTo, limit = 50 } = req.query;

      // 避免複合索引：查詢端只放單一條件（有日期→日期範圍；否則→memberId/gymId 等值），其餘記憶體過濾
      let ref = db.collection(COLLECTIONS.CHECK_INS);
      if (dateFrom || dateTo) {
        if (dateFrom) ref = ref.where('checkedInAt', '>=', new Date(dateFrom));
        if (dateTo) ref = ref.where('checkedInAt', '<=', new Date(dateTo));
      } else if (scopedMemberId) {
        ref = ref.where('memberId', '==', scopedMemberId);
      } else if (gymId) {
        ref = ref.where('gymId', '==', gymId);
      }
      const snapshot = await ref.limit(2000).get();
      let checkIns = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      if (gymId) checkIns = checkIns.filter(c => c.gymId === gymId);
      if (scopedMemberId) checkIns = checkIns.filter(c => c.memberId === scopedMemberId);
      if (ticketId) checkIns = checkIns.filter(c => c.ticketId === ticketId);
      if (ticketType) checkIns = checkIns.filter(c => c.ticketType === ticketType);
      checkIns = checkIns
        .sort((a, b) => (b.checkedInAt?._seconds||0) - (a.checkedInAt?._seconds||0))
        .slice(0, parseInt(limit));
      res.json({ checkIns, count: checkIns.length });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);


// 手機號碼現場入場（單次、兒童、學生）
router.post('/phone', authenticate, async (req, res) => {
  try {
    let { memberId, gymId, entryType, paymentMethod, childName, parentMemberId } = req.body;
    const { getDb } = require('../config/firebase');
    const db = getDb();

    // 子會員入場：無獨立 id，用 parentId+childName 當識別
    if (!memberId && parentMemberId && childName) {
      memberId = `${parentMemberId}_child_${childName}`;
    }
    if (!memberId) return res.status(400).json({ message: '缺少會員資訊' });

    // 查會員（子會員用父會員查）
    const lookupId = parentMemberId || memberId;
    const memberDoc = await db.collection('members').doc(lookupId).get();
    if (!memberDoc.exists) return res.status(404).json({ message: '會員不存在' });
    const member = memberDoc.data();
    const memberName = childName ? `${member.name}（${childName}）` : member.name;

    // 同日同館只能入場一次（用isCancelled而非status，才能同時擋下QR入場與電話入場）；台灣時間午夜為界
    const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const today = new Date(todayStr + 'T00:00:00+08:00');
    const existing = await db.collection('checkIns')
      .where('memberId', '==', memberId)
      .where('gymId', '==', gymId)
      .where('isCancelled', '==', false)
      .where('checkedInAt', '>=', today)
      .get();
    if (!existing.empty) return res.status(400).json({ message: '今日已入場，不可重複入場' });

    // 分期付款逾期檢查
    const { hasOverdueInstallment } = require('../services/installmentService');
    if (await hasOverdueInstallment(parentMemberId || memberId)) {
      return res.status(403).json({ message: '分期付款已逾期，入場資格已暫停，請至櫃檯完成繳款' });
    }

    // Waiver 硬擋（與會員自助入場一致；子會員代簽後 isComplete:true）
    const waiverDoc = await db.collection('waivers').doc(memberId).get();
    if (!waiverDoc.exists || waiverDoc.data().isComplete !== true) {
      return res.status(403).json({ message: 'Waiver 尚未完成簽署，無法入場，請先完成簽署' });
    }

    // 墜落測驗硬擋（與會員自助 verifyEntry 一致）
    const fallTestCheck = await checkinService.checkFallTest(memberId);
    if (!fallTestCheck.passed) {
      return res.status(403).json({
        message: fallTestCheck.reason === 'expired'
          ? '墜落測驗已到期，請至服務台重新進行測驗'
          : '尚未通過安全墜落測驗，請先至服務台完成同意書簽署及測驗',
      });
    }

    // 從 entryTypes 取得入場金額
    let amountPaid = 0;
    try {
      const etDoc = await db.collection('systemSettings').doc('entryTypes').get();
      if (etDoc.exists) {
        const etData = etDoc.data().types || [];
        const et = etData.find(t => t.id === entryType);
        amountPaid = et ? (et.price || 0) : (entryType === 'single_ticket' ? 200 : 0);
      } else {
        amountPaid = entryType === 'single_ticket' ? 200 : 0;
      }
    } catch { amountPaid = entryType === 'single_ticket' ? 200 : 0; }

    // 岩鞋租借
    const { rentShoes, rentChalk } = req.body;
    let shoesPrice = 0;
    if (rentShoes) {
      try {
        const shoeDoc = await db.collection('systemSettings').doc('shoeRental').get();
        shoesPrice = shoeDoc.exists ? (shoeDoc.data().price || 100) : 100;
      } catch { shoesPrice = 100; }
    }
    let chalkPrice = 0;
    if (rentChalk) {
      try {
        const chalkDoc = await db.collection('systemSettings').doc('chalkRental').get();
        chalkPrice = chalkDoc.exists ? (chalkDoc.data().price || 50) : 50;
      } catch { chalkPrice = 50; }
    }

    const totalAmount = amountPaid + shoesPrice + chalkPrice;

    // 子會員若已滿18歲，入場時提示工作人員該升級為正式會員
    // (前端送來的 memberId 不論家長或子會員都是真實文件id，直接檢查已查到的 member 即可)
    const needsPromotion = member.isChildAccount === true && member.birthday
      && dayjs().diff(member.birthday, 'year') >= 18;

    const checkInData = {
      memberId, memberName, gymId,
      entryType,
      paymentMethod: paymentMethod || 'cash',
      amountPaid: totalAmount,
      entryFee: amountPaid,
      rentShoes: !!rentShoes,
      shoesPrice: rentShoes ? shoesPrice : 0,
      rentChalk: !!rentChalk,
      chalkPrice: rentChalk ? chalkPrice : 0,
      checkedInAt: new Date(),
      status: 'checked_in',
      isCancelled: false,
      source: 'phone',
      paymentStatus: req.body.deferPayment ? 'pending' : 'confirmed',
      ...(childName ? { childName, parentMemberId } : {}),
    };

    const docRef = await db.collection('checkIns').add(checkInData);

    // 墜落測驗遞延（電話入場路徑；失敗不阻斷入場）
    try { await checkinService.tryExtendFallTest(memberId, docRef.id); } catch (e) {}

    if (totalAmount > 0 && !req.body.deferPayment) {
      const { recordTransaction } = require('../utils/revenueLedger');
      const txn = await recordTransaction(db, {
        gymId, type: 'checkin',
        totalAmount,
        paymentMethod: paymentMethod || 'cash',
        memberId, memberName,
        relatedId: docRef.id,
        entryFee: amountPaid,
        shoesPrice: rentShoes ? shoesPrice : 0,
        chalkPrice: rentChalk ? chalkPrice : 0,
        staffId: req.staff.id,
        staffName: req.staff.name,
      });
      await docRef.update({ transactionId: txn.id });
    }

    res.json({
      message: '入場成功',
      checkIn: { id: docRef.id, ...checkInData },
      ...(needsPromotion ? { needsPromotion: true, promotionChildId: memberId, promotionMessage: `${member.name} 已滿18歲，建議升級為正式會員（獨立手機/Email登入）` } : {}),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: '入場失敗', error: e.message });
  }
});

module.exports = router;
