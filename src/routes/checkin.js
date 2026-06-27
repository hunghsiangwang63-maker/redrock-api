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
      const { identifier, gymId } = req.body;
      const effectiveGymId = req.staff?.role === 'super_admin' ? gymId : (req.staff?.gymId || gymId);

      let member;
      if (identifier.startsWith('RR-')) {
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
        memberId, gymId, entryType,
        passId, discountCardId, blackCardId, singleEntryTicketId,
        paymentMethod, amount, originalAmount, isTeamDiscount,
        rentShoes, shoesPrice, rentChalk, chalkPrice,
      } = req.body;

      const effectiveMemberId = req.member ? req.member.id : memberId;
      const effectiveGymId = req.staff?.role === 'super_admin' ? gymId : (req.staff?.gymId || gymId);

      const result = await checkinService.createPendingCheckIn({
        memberId: effectiveMemberId,
        gymId: effectiveGymId,
        entryType, passId, discountCardId, blackCardId, singleEntryTicketId,
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

    res.json({
      memberType: member.memberType || 'general',
      hasCourseAccess,
      waiverSigned,
      hasValidPass,
      isVip,
      vipNote: vip?.note || null,
    });
  } catch (err) {
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

    // 今日已入場名單（用於標註禁止重複點選）
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
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
      const today = new Date();
      today.setHours(0, 0, 0, 0);

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

      let ref = db.collection(COLLECTIONS.CHECK_INS);
      if (gymId) ref = ref.where('gymId', '==', gymId);
      if (scopedMemberId) ref = ref.where('memberId', '==', scopedMemberId);
      if (ticketId) ref = ref.where('ticketId', '==', ticketId);
      if (ticketType) ref = ref.where('ticketType', '==', ticketType);
      if (dateFrom) ref = ref.where('checkedInAt', '>=', new Date(dateFrom));
      if (dateTo) ref = ref.where('checkedInAt', '<=', new Date(dateTo));

      // 避免複合索引錯誤：client-side sort
      const snapshot = await ref.limit(parseInt(limit) * 3).get();
      const checkIns = snapshot.docs.map(d => ({ id: d.id, ...d.data() }))
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

    // 同日同館只能入場一次（用isCancelled而非status，才能同時擋下QR入場與電話入場）
    const today = new Date();
    today.setHours(0,0,0,0);
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
      ...(childName ? { childName, parentMemberId } : {}),
    };

    const docRef = await db.collection('checkIns').add(checkInData);

    if (totalAmount > 0) {
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
