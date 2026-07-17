/**
 * 入場登記路由 v2
 */
const { taiwanToday } = require('../utils/taiwanDate');
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAny, authenticateMember, checkPermission, requireManagerOrStation } = require('../middleware/auth');
const checkinService = require('../services/checkinService');
const memberService = require('../services/memberService');
const { checkMemberOwnership } = require('../utils/memberOwnership');
const { getDb, COLLECTIONS } = require('../config/firebase');
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
        passId, discountCardId, blackCardId, singleEntryTicketId, bonusId, buyPassTypeId,
        paymentMethod, amount, originalAmount, isTeamDiscount, legacyDiscountCard, partnerVendor, paymentPlan,
        rentShoes, shoesPrice, rentChalk, chalkPrice,
        renewPassId, renewPaymentPlan,
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
        entryType, baseEntryType, passId, discountCardId, blackCardId, singleEntryTicketId, bonusId, buyPassTypeId,
        paymentMethod, amount, originalAmount, isTeamDiscount, legacyDiscountCard, partnerVendor, paymentPlan,
        rentShoes, shoesPrice, rentChalk, chalkPrice,
        renewPassId, renewPaymentPlan,
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
  requireManagerOrStation,   // 入場動作限值班(operator)/管理員（比照發券；個人 full/part 未值班不可）
  [body('qrToken').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await checkinService.scanQrCode(
        req.body.qrToken, req.staff?.gymId || null, req.staff?.role === 'super_admin');
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
  requireManagerOrStation,   // 入場動作限值班(operator)/管理員
  [body('qrToken').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await checkinService.confirmCheckIn(
        req.body.qrToken, req.staff.id, req.staff.name,
        req.staff?.gymId || null, req.staff?.role === 'super_admin');
      res.status(201).json({ ...result, message: '入場登記成功' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /checkin/qr/status/:qrToken - 會員輪詢自己 QR 的入場狀態 ──
// 會員產 QR 後輪詢：pending→confirmed（店員已確認）/cancelled/expired。驗擁有權（本人或子女）。
router.get('/qr/status/:qrToken', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection(COLLECTIONS.PENDING_CHECK_INS).doc(req.params.qrToken).get();
    if (!doc.exists) return res.json({ status: 'expired' }); // QR 逾時後 pending 可能已清；視為過期
    const p = doc.data();
    // 擁有權：會員只能查自己或子女的 QR（員工 token 放行）
    if (req.member) {
      const deny = await checkMemberOwnership(req.member, p.memberId, { onMissing: 'allow' });
      if (deny) return res.status(deny.status).json(deny.body);
    }
    let status = p.status;
    // 仍 pending 但已過 expiresAt（30 分）→ 視為過期，讓前端停止輪詢
    if (status === 'pending' && p.expiresAt) {
      const exp = p.expiresAt.toDate ? p.expiresAt.toDate() : new Date(p.expiresAt);
      if (dayjs().isAfter(dayjs(exp))) status = 'expired';
    }
    res.json({ status, gymId: p.gymId || null, checkInId: p.checkInId || null });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /checkin/my-today - 會員首頁橫幅：今日是否已入場（台灣日、未取消）──
router.get('/my-today', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const todayStart = new Date(taiwanToday() + 'T00:00:00+08:00');
    // 單欄位等值查（memberId），記憶體過濾今日/未取消（避免 memberId+checkedInAt 複合索引）
    const snap = await db.collection(COLLECTIONS.CHECK_INS).where('memberId', '==', req.member.id).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.isCancelled !== true && c.checkedInAt && (c.checkedInAt.toDate ? c.checkedInAt.toDate() : new Date(c.checkedInAt)) >= todayStart)
      .sort((a, b) => (b.checkedInAt?.toMillis?.() || 0) - (a.checkedInAt?.toMillis?.() || 0));
    if (rows.length === 0) return res.json({ checkedIn: false });
    const latest = rows[0];
    res.json({ checkedIn: true, gymId: latest.gymId || null, checkedInAt: latest.checkedInAt, checkInId: latest.id });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

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

// ── GET /checkin/eligibility/:memberId - 查詢會員入場類型資格（手機入場篩選用）──
router.get('/eligibility/:memberId', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const memberDoc = await db.collection('members').doc(req.params.memberId).get();
    if (!memberDoc.exists) return res.status(404).json({ message: '會員不存在' });
    const member = memberDoc.data();
    const hasCourseAccess = (await checkinService.getCourseAccess(req.params.memberId)).length > 0;
    // Waiver 狀態（與 verifyEntry 同源 checkWaiver，不另外自寫）
    const waiverSigned = (await checkinService.checkWaiver(req.params.memberId)).complete === true;

    // 查詢 VIP 狀態（先查 vipMembers collection，再查 memberType 欄位）
    const { checkVip } = require('../services/checkinService');
    const vipFromCollection = await checkVip(req.params.memberId);
    const vipFromMemberType = member.memberType === 'vip';
    const isVip = !!(vipFromCollection || vipFromMemberType);
    const vip = vipFromCollection || (vipFromMemberType ? { note: member.vipNote || '' } : null);

    // 查詢有效定期票——與會員自助 verifyEntry 同源 getValidPasses（場館限制 shared/targetGymId
    // + 臨時休館補償後到期日 + credits），避免與權威版欄位不一致（原用 scope==='all'/gymId 為 bug：
    // 'all' 永不成立→雙館票被誤判無效；gymId 是售出館≠限制館 targetGymId）
    const today = taiwanToday();
    const hasValidPass = (await checkinService.getValidPasses(req.params.memberId, req.query.gymId || '')).length > 0;

    // 墜落測驗狀態（櫃檯入場閘門用，與會員自助 verifyEntry 一致）
    const fallTest = await checkinService.checkFallTest(req.params.memberId);

    // 可用票券（櫃檯兩段流程：選身分後可選用優惠券/黑卡/紅利/單次券）
    const discountCards = await require('../services/discountCardService').getValidDiscountCards(req.params.memberId);
    const blackCards = await require('../services/legacyCardService').getMemberBlackCards(req.params.memberId);
    const bonuses = await require('../services/bonusService').getMemberBonuses(req.params.memberId);
    // 與入場 confirmCheckIn 權威一致：體驗券限當日 validDate、一般單次券不受限
    // （改用 getValidSingleEntryTickets，避免電話搜尋列出不可用的票券／漏列當日體驗券）
    const validTickets = await checkinService.getValidSingleEntryTickets(req.params.memberId);
    // 兒童以出生日期 age<13 判定（非 raw memberType）——與 verifyEntry 的 getMemberType 一致，
    // 否則子帳號 memberType=undefined→'general'，兒童入場(memberTypes:['child']) 被前端過濾掉不顯示
    const { getMemberType } = require('../services/checkin/pricing');
    const memberType = getMemberType(member);

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
          // 有效隊員：優惠券 8 折再疊加隊員 9 折＝0.72（前端以 basePrice×rate 顯示，與後端實收一致）
          rate: require('../services/teamMemberService').isActiveTeamMember(member) ? 0.72 : 0.8,
          teamStacked: require('../services/teamMemberService').isActiveTeamMember(member),
          cards: discountCards.map(c => ({ id: c.id, remainingCredits: c.remainingCredits })),
        },
        blackCard: { available: blackCards.length > 0, cards: blackCards.map(c => ({ id: c.id, remainingCredits: c.remainingCredits })) },
        bonus: { available: bonuses.length > 0, bonuses: bonuses.map(b => ({ id: b.id, expiresAt: b.expiresAtFormatted })) },
        singleEntryTicket: { available: validTickets.length > 0, tickets: validTickets.map(t => ({ id: t.id, ticketType: t.ticketType || null, validDate: t.validDate || null })) },
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /checkin/direct - 員工端直接入場（兩段流程：身分＋票券）──────
// 重用 createPendingCheckIn + confirmCheckIn 的結算邏輯（金額後端權威、票券扣除、營收、墜測遞延）
router.post('/direct', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const {
      memberId, gymId, entryType, baseEntryType,
      discountCardId, blackCardId, singleEntryTicketId, bonusId, buyPassTypeId,
      paymentMethod, rentShoes, rentChalk, legacyDiscountCard, paymentPlan,
    } = req.body;
    if (!memberId || !entryType) return res.status(400).json({ message: '缺少會員或入場類型' });
    const effGym = req.staff?.role === 'super_admin' ? gymId : (req.staff?.gymId || gymId);

    // 同日重複、Waiver、墜測、分期逾期關卡由 createPendingCheckIn 的 runEntryGates 統一處理（避免多份實作漂移）
    const { qrToken } = await checkinService.createPendingCheckIn({
      memberId, gymId: effGym, entryType, baseEntryType,
      discountCardId, blackCardId, singleEntryTicketId, bonusId, buyPassTypeId,
      paymentMethod: paymentMethod || 'cash', rentShoes, rentChalk, legacyDiscountCard, paymentPlan,
    });
    const result = await checkinService.confirmCheckIn(
      qrToken, req.staff.id, req.staff.name,
      req.staff?.gymId || null, req.staff?.role === 'super_admin');
    res.status(201).json(result);
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /checkin/today-course-students - 今日課程學員名單（手機入場頁快速入場用）──
router.get('/today-course-students', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const { gymId } = req.query;
    if (!gymId) return res.status(400).json({ message: '缺少場館資訊' });
    const db = getDb();
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
    const todayStr0 = taiwanToday();
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
          isMakeup: e.isMakeup === true,                                  // 補課學員標籤
          isTrial: e.isTrial === true,                                    // 試上學員標籤
          trialUnpaid: e.isTrial === true && e.paymentStatus !== 'paid',  // 試上費未收提醒
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
      const db = getDb();
      // 「今日」以台灣時間(UTC+8)午夜為界（伺服器為 UTC，不可用 setHours 否則跨日不清空）
      const todayStr = taiwanToday();
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
        course_access: '課程學員', child_free: '兒童入場', student_free: '學生入場', other: '其他',
        pass: '定期票', discount_card: '優惠折扣券', single_entry_ticket: '單次入場券',
        buy_discount_card: '購買優惠券', buy_pass: '購買定期票',
        legacy_physical_card: '實體優惠卡', competition: '比賽報到',
      };

      const statsByGym = targetGyms.map(gym => {
        const gymRecords = records.filter(r => r.gymId === gym.id);
        const counts = {};
        gymRecords.forEach(r => {
          // 舊折扣卡 8 折（實體優惠卡）獨立一類，不混入「單次」
          const t = r.legacyDiscount === true ? 'legacy_physical_card' : (r.entryType || r.passType || 'other');
          counts[t] = (counts[t] || 0) + 1;
        });
        return { gymId: gym.id, gymName: gym.name, total: gymRecords.length, counts };
      });

      // 今日全部紀錄（依館分組排列；當日量級小、全量回傳讓清單與統計數一致）
      const recent = targetGyms.flatMap(gym =>
        records.filter(r => r.gymId === gym.id).map(r => ({
          id: r.id, memberName: r.memberName, gymId: r.gymId,
          entryType: r.entryType || r.passType, checkedInAt: r.checkedInAt,
          legacyDiscount: r.legacyDiscount === true,
        }))
      );

      res.json({ statsByGym, total: records.length, recent });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /checkin/monthly-daily-counts?gymId=&month=YYYY-MM ────────────
// 入場頁折線圖：本月與上月「每日入場數」（依台灣日期、排除取消）
router.get('/monthly-daily-counts', authenticate, checkPermission('checkin.read'), async (req, res) => {
  try {
    const db = getDb();
    const dayjs = require('dayjs');
    const gymId = req.query.gymId || (req.staff.role === 'super_admin' ? null : req.staff.gymId);
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
    const curStart = `${month}-01`;
    const prevMonth = dayjs(curStart).subtract(1, 'month').format('YYYY-MM');
    const prevStart = `${prevMonth}-01`;
    const curEnd = dayjs(curStart).endOf('month').format('YYYY-MM-DD');

    // 單欄位範圍（checkedInAt）＋記憶體過濾 gym/取消，避複合索引
    const snap = await db.collection('checkIns')
      .where('checkedInAt', '>=', new Date(`${prevStart}T00:00:00+08:00`))
      .where('checkedInAt', '<=', new Date(`${curEnd}T23:59:59+08:00`)).get();
    const countMap = {};
    const gymCountMap = { 'gym-hsinchu': {}, 'gym-shilin': {} }; // 本月各館每日（不受 gymId 過濾，供 super_admin 兩館分線）
    snap.docs.forEach(d => {
      const r = d.data();
      if (r.isCancelled === true || r.status === 'cancelled') return;
      if (!r.checkedInAt) return;
      const dt = new Date(r.checkedInAt.toDate().getTime() + 8 * 3600000).toISOString().slice(0, 10);
      if (gymCountMap[r.gymId]) gymCountMap[r.gymId][dt] = (gymCountMap[r.gymId][dt] || 0) + 1;
      if (gymId && r.gymId !== gymId) return;
      countMap[dt] = (countMap[dt] || 0) + 1;
    });
    const dCur = dayjs(curStart).daysInMonth(), dPrev = dayjs(prevStart).daysInMonth();
    const pad = n => String(n).padStart(2, '0');
    const data = [];
    for (let day = 1; day <= Math.max(dCur, dPrev); day++) {
      data.push({
        day,
        current: day <= dCur ? (countMap[`${month}-${pad(day)}`] || 0) : null,
        previous: day <= dPrev ? (countMap[`${prevMonth}-${pad(day)}`] || 0) : null,
        hsinchu: day <= dCur ? (gymCountMap['gym-hsinchu'][`${month}-${pad(day)}`] || 0) : null,
        shilin: day <= dCur ? (gymCountMap['gym-shilin'][`${month}-${pad(day)}`] || 0) : null,
        hsinchuPrev: day <= dPrev ? (gymCountMap['gym-hsinchu'][`${prevMonth}-${pad(day)}`] || 0) : null,
        shilinPrev: day <= dPrev ? (gymCountMap['gym-shilin'][`${prevMonth}-${pad(day)}`] || 0) : null,
      });
    }
    res.json({ month, prevMonth, curLabel: dayjs(curStart).format('M月'), prevLabel: dayjs(prevStart).format('M月'), data });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /checkin/history ─────────────────────────────────────────
router.get('/history',
  authenticateAny,
  async (req, res) => {
    try {
      const db = getDb();

      // 會員只能查自己或子會員的；員工可查指定館別
      const isMemberToken = !!req.member && !req.staff;
      let scopedMemberId = isMemberToken ? req.member.id : req.query.memberId;
      if (isMemberToken && req.query.memberId && req.query.memberId !== req.member.id) {
        // 家長代查子女入場紀錄：驗擁有權
        const deny = await checkMemberOwnership(req.member, req.query.memberId, { onMissing: 403 });
        if (deny) return res.status(deny.status).json(deny.body);
        scopedMemberId = req.query.memberId;
      }
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
      // checkIn 文件無 ticketId/ticketType 欄位；票券使用實記在各自 id 欄位
      // （discountCardId / blackCardId / singleEntryTicketId / bonusId / passId，UUID 不會撞）
      // → 有帶 ticketId 就比對任一票券 id 欄位（ticketType 不再拿來過濾，checkIn 沒這欄位否則恆空）
      if (ticketId) {
        checkIns = checkIns.filter(c =>
          c.discountCardId === ticketId ||
          c.blackCardId === ticketId ||
          c.singleEntryTicketId === ticketId ||
          c.bonusId === ticketId ||
          c.passId === ticketId
        );
      }
      checkIns = checkIns
        .sort((a, b) => (b.checkedInAt?._seconds||0) - (a.checkedInAt?._seconds||0))
        .slice(0, parseInt(limit));
      // records：會員端 MemberPassesPage 讀此 key；checkIns：員工端歷史入場讀此 key（同一份陣列）
      res.json({ records: checkIns, checkIns, count: checkIns.length });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);


// 手機號碼現場入場（單次、兒童、學生）
router.post('/phone', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    let { memberId, gymId, entryType, paymentMethod, childName, parentMemberId } = req.body;
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

    // ── 關卡 0（同日重複 / Waiver / 墜測含「持有」體驗券例外 / 分期逾期）：共用 runEntryGates ──
    // 電話為純付費路徑：墜測例外用 'owns' 語意（會員持有當日有效體驗券即豁免，須簽同意書）；
    // 子女入場的分期逾期查家長（parentMemberId）。與會員自助 verifyEntry 同一份關卡邏輯。
    const gate = await checkinService.runEntryGates(memberId, gymId, {
      expTicketMode: 'owns',
      installmentMemberId: parentMemberId || memberId,
    });
    if (gate.blocked) {
      return res.status(gate.httpStatus || 403).json({ reason: gate.reason, message: gate.message });
    }

    // ── 免費資格後端權威覆核（不單信前端送的 entryType；已付費放行不覆核）──
    // VIP / 定期票 / 課程學員 / 免費身分由 verifyEntry 權威判定：合法者結果不變；
    // 前端送了免費類型但權威判定「非免費」者，改用權威付費類型（防白嫖，判斷更安全）。
    const alreadyPaid = req.body.alreadyPaid === true;
    if (!alreadyPaid) {
      const FREE_TYPES = ['vip', 'pass'];
      const elig = await checkinService.verifyEntry(memberId, gymId);
      if (elig.freeEntry && elig.entryType) {
        entryType = elig.entryType;                     // 權威免費類型（覆寫前端值）
      } else if (entryType === 'course_access') {
        // 員工手動指定「課程學員」：尊重櫃檯判斷、以課程學員免費入場（0 元）。
        // 系統可能尚未匯入該期學員名單（如 Climbio/BeClass 搬遷期），權威查無報名不代表非學員；
        // 此路徑為值班/管理員限定（員工本就可用「已付費放行」0 元入場），非新的權限洞。
      } else if (FREE_TYPES.includes(entryType)) {
        const paidTypes = (elig.entryTypeOptions || []).map(o => o.type);
        entryType = paidTypes[0] || 'single_ticket';    // 前端偽造免費 → 改回權威付費身分
      }
    }
    if (alreadyPaid) entryType = 'already_paid';

    // 舊折扣卡 8 折（轉換期）：持實體舊折扣卡、未轉入新優惠卡者，員工可手動套 8 折（有效隊員再疊 9 折）。
    // 權威：須後端轉換期開關 checkinLegacyDiscountCard 開啟才生效，不單信前端旗標。
    let useLegacyDiscount = false;
    if (req.body.legacyDiscountCard === true && !alreadyPaid) {
      try {
        const ts = await db.collection('systemSettings').doc('transitionSettings').get();
        useLegacyDiscount = !!(ts.exists && ts.data().checkinLegacyDiscountCard);
      } catch {}
    }

    // 從 entryTypes 取得入場金額（權威計算，含舊折扣卡 8 折 + 有效隊員 9 折；與 QR 自助入場共用同一邏輯）
    let amountPaid = 0;
    let entryOriginal = 0;
    let isTeamDiscount = false;
    let legacyDiscount = false;
    if (!alreadyPaid) try {
      const computed = await checkinService.computePaidEntryAmount(entryType, member, { legacyDiscountCard: useLegacyDiscount });
      if (computed) {
        amountPaid = computed.amount;
        entryOriginal = computed.originalAmount;
        isTeamDiscount = computed.isTeamDiscount;
        legacyDiscount = computed.legacyDiscount;
      } else {
        amountPaid = entryType === 'single_ticket' ? 200 : 0;
        entryOriginal = amountPaid;
      }
    } catch { amountPaid = entryType === 'single_ticket' ? 200 : 0; entryOriginal = amountPaid; }

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

    // 已付費：入場費視為已付（0）。若無加購 → 付款方式記「已付費」（純放行）；
    // 若有加購岩鞋/粉袋 → 加購金額以員工實際收款方式（預設現金）另收，故用真實付款方式。
    const effectivePayment = (alreadyPaid && totalAmount === 0) ? 'already_paid' : (paymentMethod || 'cash');

    // 子會員若已滿18歲，入場時提示工作人員該升級為正式會員
    // (前端送來的 memberId 不論家長或子會員都是真實文件id，直接檢查已查到的 member 即可)
    const needsPromotion = member.isChildAccount === true && member.birthday
      && dayjs().diff(member.birthday, 'year') >= 18;

    const checkInData = {
      memberId, memberName, gymId,
      entryType,
      paymentMethod: effectivePayment,
      amountPaid: totalAmount,
      entryFee: amountPaid,
      entryOriginalFee: entryOriginal,
      isTeamDiscount,
      legacyDiscount,
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

    // 入場連動：今日有已報名課程場次 → 自動標記出席（present；不覆蓋員工已標；不阻斷入場）
    // memberId 為實際入場者（子女入場時已是子女 id，非家長）
    await require('../services/courseService').markTodayCourseAttendanceOnEntry({ memberId, gymId, staffId: req.staff.id });

    if (totalAmount > 0 && !req.body.deferPayment) {
      const { recordTransaction } = require('../utils/revenueLedger');
      const txn = await recordTransaction(db, {
        gymId, type: 'checkin',
        totalAmount,
        paymentMethod: effectivePayment,
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
