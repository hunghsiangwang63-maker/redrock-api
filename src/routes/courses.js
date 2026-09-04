/**
 * 課程管理路由
 *
 * 課程     GET/POST /courses
 * 場次     GET/POST /courses/:courseId/sessions
 * 報名     POST /courses/sessions/:sessionId/enroll
 * 請假     POST /courses/enrollments/:enrollmentId/leave
 * 補課     GET  /courses/makeup/:memberId
 *          POST /courses/makeup/:makeupId/use
 * 出席     POST /courses/sessions/:sessionId/attendance
 * 名單     GET  /courses/sessions/:sessionId/roster
 */
const { taiwanToday } = require('../utils/taiwanDate');
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAny, authenticateMember, checkPermission, auditLog } = require('../middleware/auth');
const { checkMemberOwnership } = require('../utils/memberOwnership');
const courseService = require('../services/courseService');
const { createWeeklySessions, updateSession } = courseService;
const memberService = require('../services/memberService');
const { isUnder4, isMinor } = require('../utils/age');
const { getDb, getStorage, COLLECTIONS } = require('../config/firebase');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// ══════════════════════════════════════════════════════
// 課程 CRUD
// ══════════════════════════════════════════════════════

// GET /courses - 課程列表
router.get('/', authenticateAny, async (req, res) => {
  try {
    const gymId = req.query.gymId || req.staff?.gymId;
    let courses = await courseService.getCourses(gymId);
    // 會員端不顯示已取消課程與體驗課程（source:experience 由確認體驗預約自動建立，不開放報名）
    if (req.member) courses = courses.filter(c => c.status !== 'cancelled' && c.source !== 'experience' && c.isActive !== false);
    res.json({ courses });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /courses - 建立課程
router.post('/',
  authenticate, checkPermission('courses.manage'), auditLog('course.create'),
  [
    body('name').notEmpty().withMessage('請輸入課程名稱'),
    // 工作坊：手填總價 price；週課：手填單堂價 pricePerSession（整期總價由產生場次時連動算出）
    body('price').custom((value, { req }) => {
      if (req.body.type === 'workshop' && (value === undefined || value === null || isNaN(Number(value)))) throw new Error('請輸入課程費用');
      return true;
    }),
    body('pricePerSession').custom((value, { req }) => {
      if (req.body.type !== 'workshop' && (value === undefined || value === null || isNaN(Number(value)))) throw new Error('請輸入單堂費用');
      return true;
    }),
    body('maxStudents').isInt({ min: 1 }).withMessage('請輸入最大人數'),
    // 候補上限 2026 拍板取消「留空＝不限」，一律須明確填數字（0＝不開放候補）
    body('maxWaitlist').isInt({ min: 0 }).withMessage('請填寫候補上限（不開放候補請填 0）'),
    body('gymAccessDays').isInt({ min: 1 }).withMessage('請填寫入館有效天數'),
    body('startDate').notEmpty().withMessage('請填寫課程開始日期'),
    body('endDate').notEmpty().withMessage('請填寫課程結束日期'),
    body('startTime').notEmpty().withMessage('請填寫上課開始時間'),
    body('endTime').notEmpty().withMessage('請填寫上課結束時間'),
    body('instructor').trim().notEmpty().withMessage('請填寫教練'),
    // 上課星期僅週課適用（工作坊無此概念、畫面也不顯示此欄位）
    body('weekdays').custom((value, { req }) => {
      if (req.body.type !== 'workshop' && (!Array.isArray(value) || value.length === 0)) throw new Error('請至少選擇一個上課星期');
      return true;
    }),
  ],
  validate,
  async (req, res) => {
    try {
      // 館別隔離：非 super_admin 只能在自己館建立課程，不可用 req.body.gymId 覆蓋到他館
      if (req.body.gymId && req.body.gymId !== req.staff.gymId && req.staff.role !== 'super_admin') {
        return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '不可為其他館別建立課程' });
      }
      // super_admin 個人帳號 staff.gymId 為 null：前端漏帶 gymId 時會建出 gymId=null 幽靈課
      // （任何館別檢視都看不到）→ 權威擋下，要求明確指定館別
      const resolvedGymId = req.body.gymId || req.staff.gymId;
      if (!resolvedGymId) {
        return res.status(400).json({ error: 'MISSING_GYM', message: '請指定課程所屬館別' });
      }
      const course = await courseService.createCourse({
        gymId: resolvedGymId,
        staffId: req.staff.id,
        data: req.body,
      });
      res.status(201).json({ course, message: '課程已建立' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// 公開讀取（免登入，供公開報名頁顯示課程/場次資訊）
// ══════════════════════════════════════════════════════

// GET /courses/public/:courseId — 課程詳情+未來場次（免登入）
router.get('/public/:courseId', async (req, res) => {
  try {
    const db = getDb();
    const courseDoc = await db.collection('courses').doc(req.params.courseId).get();
    if (!courseDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此課程' });
    const raw = courseDoc.data();
    if (raw.status !== 'active' || raw.isActive === false) return res.status(404).json({ error: 'NOT_ACTIVE', message: '此課程目前未開放報名' });

    // 沿用既有 getCourses（單一真相：類別介紹/海報/規則解析皆在裡面），取這一門即可
    const all = await courseService.getCourses(raw.gymId);
    const enriched = all.find(c => c.id === req.params.courseId) || { id: req.params.courseId, ...raw };

    const today = taiwanToday();
    // 免登入公開頁純供瀏覽（實際報名須登入）——完整場次清單（含已取消/已上課）供顯示排課全貌+停課標示，
    // 與登入會員端 MemberCoursesPage 的「此梯次上課場次」同一套資料口徑（該頁走 GET /courses/sessions?courseId= 亦不過濾狀態/日期）
    const sessSnap = await db.collection('courseSessions')
      .where('courseId', '==', req.params.courseId)
      .get();
    const allSessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const sessions = allSessions.map(s => ({
      id: s.id, date: s.date, startTime: s.startTime, endTime: s.endTime, gymId: s.gymId,
      status: s.status || 'scheduled', instructor: s.instructor || null,
    }));
    // 費用試算用：僅未來、未取消場次（與實際報名扣款口徑一致，不受上面完整清單影響）
    const futureActiveCount = allSessions.filter(s => s.status !== 'cancelled' && s.date >= today).length;

    res.json({
      course: {
        id: enriched.id, name: enriched.name, type: enriched.type,
        description: enriched.description || '',
        categoryName: enriched.categoryName || null,
        categoryDescription: enriched.categoryDescription || null,
        categoryImageUrl: enriched.categoryImageUrl || null,
        price: enriched.price, pricePerSession: enriched.pricePerSession || 0, gymId: enriched.gymId,
        startDate: enriched.startDate, endDate: enriched.endDate,
        enrollOpenDate: enriched.enrollOpenDate || null,
      },
      sessions,
      futureActiveCount,
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /courses/public/category/:categoryId — 班別詳情+底下全部梯次（免登入，供「一個班別多梯次」的公開報名頁使用）
// 例：入門班有三個梯次（週一/週三/週五），這裡一次列出，訪客自己挑要報哪一梯。
router.get('/public/category/:categoryId', async (req, res) => {
  try {
    const db = getDb();
    const catDoc = await db.collection('courseCategories').doc(req.params.categoryId).get();
    if (!catDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此班別' });
    const cat = catDoc.data();
    if (cat.isActive === false) return res.status(404).json({ error: 'NOT_ACTIVE', message: '此班別目前未開放' });

    // 沿用既有 getCourses（單一真相：類別介紹/海報/規則解析、尚有名額判斷、statusLabel 皆在裡面）；不分館別，兩館的梯次都列出
    // 排除 statusLabel==='ended'（已結束的梯次，即使 status 欄位仍是 active 也不該顯示可報名）；
    // 'ongoing'（已開課、插班中）、'enrolling'/'starting_soon'/'full' 皆保留——插班與候補本就支援。
    const all = await courseService.getCourses(null);
    const cohorts = all.filter(c => c.categoryId === req.params.categoryId && c.status === 'active' && c.isActive !== false && c.statusLabel !== 'ended');

    // 工作坊型梯次另附未來場次清單（供訪客在同一頁挑選具體場次）
    const today = taiwanToday();
    const withSessions = await Promise.all(cohorts.map(async (c) => {
      if (c.type !== 'workshop') return { ...c, sessions: null };
      const sessSnap = await db.collection('courseSessions')
        .where('courseId', '==', c.id).where('status', '==', 'scheduled').get();
      const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(s => ({ id: s.id, date: s.date, startTime: s.startTime, endTime: s.endTime }));
      return { ...c, sessions };
    }));

    res.json({
      category: {
        id: catDoc.id, name: cat.name, description: cat.description || '', imageUrl: cat.imageUrl || null,
      },
      cohorts: withSessions.map(c => ({
        id: c.id, name: c.name, type: c.type, price: c.price, gymId: c.gymId,
        startDate: c.startDate, endDate: c.endDate, statusLabel: c.statusLabel || null,
        sessions: c.sessions,
      })),
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /courses/public/session/:sessionId — 試上場次詳情（免登入，供公開試上預約頁顯示）
router.get('/public/session/:sessionId', async (req, res) => {
  try {
    const db = getDb();
    const sDoc = await db.collection('courseSessions').doc(req.params.sessionId).get();
    if (!sDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此場次' });
    const session = sDoc.data();
    const cDoc = await db.collection('courses').doc(session.courseId).get();
    const course = cDoc.exists ? cDoc.data() : {};
    const trialRules = courseService.resolveRules(course, await courseService.getCategoryOf(db, course.categoryId));
    res.json({
      session: {
        id: sDoc.id, date: session.date, startTime: session.startTime, endTime: session.endTime,
        gymId: session.gymId, courseName: session.courseName,
      },
      allowTrial: trialRules.allowTrial === true,
      trialPrice: courseService.getEffectiveTrialPrice(course, trialRules),
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ══════════════════════════════════════════════════════
// 場次
// ══════════════════════════════════════════════════════

// GET /courses/sessions - 場次列表（可依日期區間）
// GET /courses/:courseId/quote — 這位會員這門課的「最終應繳」（後端權威，與 enroll-all 同規則）
// 供報名 modal 顯示＝實收，避免插班/隊員/續報折扣的顯示與實收落差造成溢繳。
router.get('/:courseId/quote', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.query.memberId || req.member?.id;
    if (!memberId) return res.status(400).json({ error: 'MISSING_MEMBER' });
    // 會員只能查自己或子會員的報價
    if (req.member) {
      const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 403 });
      if (deny) return res.status(deny.status).json(deny.body);
    }
    const quote = await courseService.computeCourseFeeForMember(db, { courseId: req.params.courseId, memberId, byStaff: !!req.staff });
    res.json(quote);
  } catch (err) {
    if (err.code === 'COURSE_NOT_FOUND') return res.status(404).json({ error: 'COURSE_NOT_FOUND' });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.get('/sessions', authenticateAny, async (req, res) => {
  try {
    // 快速路徑：帶 courseId → 只查該課程場次（單一等值查詢、極小 payload），供報名時算插班費用即時取得
    if (req.query.courseId) {
      const db = getDb();
      const snap = await db.collection('courseSessions').where('courseId', '==', req.query.courseId).get();
      let sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));
      if (req.member) sessions = sessions.filter(s => s.source !== 'experience');
      return res.json({ sessions });
    }
    const gymId = req.query.gymId || req.staff?.gymId;
    let sessions = await courseService.getSessions(gymId, req.query.fromDate || req.query.from, req.query.toDate || req.query.to);
    // 會員端過濾體驗課程場次（不出現在報名/課表；會員自己的體驗另由 /experience-bookings/my 顯示）
    if (req.member) sessions = sessions.filter(s => s.source !== 'experience');
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /courses/makeup-candidates - 補課候選場次（會員「選擇補課場次」彈窗專用，輕量版，
// 不掃描 courseEnrollments，見 courseService.getMakeupCandidateSessions 檔頭說明）
router.get('/makeup-candidates', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const result = await courseService.getMakeupCandidateSessions(db, {
      categoryId: req.query.categoryId || null,
      gymId: req.query.gymId || null,
      excludeCourseId: req.query.excludeCourseId || null,
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /courses/trial-sessions - 開放試上的週課近期場次（會員「體驗課程」頁）
router.get('/trial-sessions', authenticateAny, async (req, res) => {
  try {
    const gymId = req.query.gymId || req.staff?.gymId;
    const sessions = await courseService.getTrialSessions(gymId, req.query.from, req.query.to);
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /courses/:courseId/sessions - 建立場次
router.post('/:courseId/sessions',
  authenticate, checkPermission('courses.manage'), auditLog('session.create'),
  [
    body('date').isDate().withMessage('請輸入日期（YYYY-MM-DD）'),
    body('startTime').notEmpty().withMessage('請輸入開始時間'),
    body('endTime').notEmpty().withMessage('請輸入結束時間'),
  ],
  validate,
  async (req, res) => {
    try {
      const session = await courseService.createSession({
        courseId: req.params.courseId,
        gymId: req.staff.gymId,
        staffId: req.staff.id,
        data: req.body,
      });
      res.status(201).json({ session, message: '場次已建立' });
    } catch (err) {
      if (err.code === 'COURSE_NOT_FOUND') return res.status(404).json(err);
      if (err.code === 'DUPLICATE_SESSION') return res.status(409).json(err);
      if (err.code) return res.status(400).json(err); // SESSION_DATE_OUT_OF_RANGE / INVALID_SESSION_TIME
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// POST /courses/sessions/:sessionId/closure-cancel - 休館停課（場次取消＋正取自動發豁免補課券）
router.post('/sessions/:sessionId/closure-cancel',
  authenticate, checkPermission('courses.manage'), auditLog('session.closure_cancel'),
  async (req, res) => {
    try {
      const result = await courseService.closureCancelSession({
        sessionId: req.params.sessionId,
        staffId: req.staff.id, staffName: req.staff.name,
        reason: req.body.reason || '休館停課',
      });
      res.json({ success: true, ...result,
        message: `已停課：發放 ${result.issued} 張休館補課券${result.makeupRestored ? `、還原 ${result.makeupRestored} 張補課券` : ''}${result.trialAffected ? `、${result.trialAffected} 位試上學員請另行處理` : ''}` });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// POST /courses/cross-makeups/:id/done - 跨期補課結案（上完課標 done；名單顯示為出席）
router.post('/cross-makeups/:id/done',
  authenticate, checkPermission('courses.manage'), auditLog('cross_makeup.done'),
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection('crossCohortMakeups').doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
      await ref.update({ status: 'done', doneAt: new Date(), doneBy: req.staff.name || req.staff.id, updatedAt: new Date() });
      res.json({ success: true, message: `${doc.data().name} 跨期補課已結案` });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// GET /courses/sessions/:sessionId/roster - 學員名單（唯讀 → courses.view：全角色＋值班皆可看，
// 原 courses.manage 讓 part_time／值班 403、前端吞錯誤顯示「尚無學員報名」誤導）
router.get('/sessions/:sessionId/roster',
  authenticate, checkPermission('courses.view'),
  async (req, res) => {
    try {
      const roster = await courseService.getSessionRoster(req.params.sessionId);
      res.json({ roster, count: roster.length });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// POST /courses/sweep-expired-payments - 手動觸發「逾期未付款自動取消」（super_admin，供排程外測試/補跑）
router.post('/sweep-expired-payments', authenticate, checkPermission('super_admin'), async (req, res) => {
  try {
    const result = await courseService.sweepExpiredCoursePayments();
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ══════════════════════════════════════════════════════
// 報名
// ══════════════════════════════════════════════════════

// POST /courses/sessions/:sessionId/enroll - 報名
router.post('/sessions/:sessionId/enroll',
  authenticateAny,
  auditLog('course.enroll'),
  [
    body('memberId').notEmpty().withMessage('請指定會員'),
  ],
  validate,
  async (req, res) => {
    try {
      // 驗證：會員只能為自己或子會員報名
      const deny = await checkMemberOwnership(req.member, req.body.memberId, { onMissing: 404 });
      if (deny) return res.status(deny.status).json(deny.body);
      // 後端權威：未滿 4 歲無法報名課程（實際上課者＝req.body.memberId，家長代子時已解析為子會員）
      const _attendee = await memberService.getMember(req.body.memberId).catch(() => null);
      if (isUnder4(_attendee)) return res.status(400).json({ code: 'AGE_UNDER_5', message: '未滿 4 歲無法報名課程' });
      // 🧪 模擬報名：短路，不建真實報名（不佔名額）
      if (_attendee?.isSimulation) return res.json(await require('../services/simulationService').handleSimulatedRegistration(getDb(), { type: 'course', member: _attendee, targetId: null, payload: { ...req.body, sessionId: req.params.sessionId } }));
      const result = await courseService.enrollCourse({
        memberId: req.body.memberId,
        sessionId: req.params.sessionId,
        gymId: req.staff?.gymId || req.body.gymId,
        staffId: req.staff?.id || null,
        byStaff: !!req.staff,
        enrollGender: req.body.enrollGender,
        enrollAge: req.body.enrollAge,
        enrollNote: req.body.enrollNote,
        paymentId: req.body.paymentId,
        paymentDate: req.body.paymentDate,
        bankLastFive: req.body.bankLastFive,
        healthNote: req.body.healthNote,
        referralSource: req.body.referralSource,
        confirmedLeavePolicy: req.body.confirmedLeavePolicy,
        confirmedRefundPolicy: req.body.confirmedRefundPolicy,
        portraitSignature: req.body.portraitSignature,
        guardianSignature: req.body.guardianSignature,
      });

      // ── 課程練習期遞延：若課程有無限練習期，且會員有有效定期票，自動建立遞延申請 ──
      let deferralRequest = null;
      try {
        const db = getDb();

        // 取得課程資訊
        const sessionDoc = await db.collection('courseSessions').doc(req.params.sessionId).get();
        if (sessionDoc.exists) {
          const session = sessionDoc.data();
          const courseDoc = await db.collection(COLLECTIONS.COURSES || 'courses').doc(session.courseId).get();
          const course = courseDoc.exists ? courseDoc.data() : null;
          const practiceEnd = course?.unlimitedPracticeEnd;

          if (practiceEnd && !result.isWaitlist) {
            const today = taiwanToday();
            // 找會員有效定期票
            const passSnap = await db.collection(COLLECTIONS.MEMBER_PASSES).where('memberId', '==', req.body.memberId).where('status', '==', 'active').get();
            const validPasses = passSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.endDate >= today && p.endDate < practiceEnd);
            // 只對到期日早於練習結束日的票建立遞延
            for (const pass of validPasses) {
              const remainingDays = require('dayjs')(pass.endDate).diff(require('dayjs')(today), 'day') + 1;
              const newEndDate = require('dayjs')(practiceEnd).add(remainingDays, 'day').format('YYYY-MM-DD');
              const reqId = `defer_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
              await db.collection(COLLECTIONS.PASS_ADJUSTMENTS || 'passAdjustmentRequests').doc(reqId).set({
                id: reqId,
                type: 'course_practice_deferral',
                passId: pass.id,
                memberId: req.body.memberId,
                memberName: pass.memberName || '',
                passTypeName: pass.passTypeName || '',
                courseId: session.courseId,
                courseName: course?.name || '',
                practiceEnd,
                remainingDays,
                currentEndDate: pass.endDate,
                proposedEndDate: newEndDate,
                status: 'pending',
                reason: `報名「${course?.name || '課程'}」無限練習期（至 ${practiceEnd}），定期票剩餘 ${remainingDays} 天遞延至練習結束後`,
                createdAt: new Date(),
                updatedAt: new Date(),
              });
              deferralRequest = { passId: pass.id, currentEndDate: pass.endDate, proposedEndDate: newEndDate, remainingDays };
            }
          }
        }
      } catch (deferErr) { /* 遞延申請建立失敗不影響報名主流程 */ }

      // ── 插班分期：課程有開分期規則且會員選「分期」→ 依規則(比例)建立分期計畫 ──
      // 以插班實收費用(feeInfo.fee)為總額；第一期簽約當下收、記帳認列課程最後一堂
      let installmentPlan = null;
      try {
        if (req.body.paymentPlan === 'installment' && !result.isWaitlist && result.enrollment?.enrollmentFee > 0) {
          const db2 = getDb();
          const sDoc = await db2.collection('courseSessions').doc(req.params.sessionId).get();
          const c = sDoc.exists ? (await db2.collection(COLLECTIONS.COURSES || 'courses').doc(sDoc.data().courseId).get()).data() : null;
          if (c?.installment?.enabled) {
            const installmentService = require('../services/installmentService');
            const today = taiwanToday();
            const courseSessionsSnap = await db2.collection('courseSessions')
              .where('courseId', '==', sDoc.data().courseId).where('status', '==', 'scheduled').get();
            const sessionDates = courseSessionsSnap.docs.map(d => d.data().date).filter(d => d >= today).sort();
            const periods = installmentService.buildCoursePeriodsFromConfig(c.installment, result.enrollment.enrollmentFee, today, sessionDates);
            if (periods) {
              const mDoc = await db2.collection(COLLECTIONS.MEMBERS).doc(req.body.memberId).get();
              installmentPlan = await installmentService.createInstallmentPlan({
                memberId: req.body.memberId,
                memberName: mDoc.exists ? (mDoc.data().name || '') : '',
                gymId: req.staff?.gymId || req.body.gymId || c?.gymId || null,
                relatedType: 'course', relatedId: sDoc.data().courseId, itemName: c?.name || '課程插班',
                recognitionDate: c?.endDate || c?.unlimitedPracticeEnd || null,
                installments: periods,
                firstPaymentMethod: req.member ? null : (req.body.paymentMethod || 'cash'),
                staffId: req.staff?.id || null, staffName: req.staff?.name || '',
              });
            }
          }
        }
      } catch (planErr) { console.error('[分期串接] 插班分期計畫建立失敗', planErr.message); }

      // 報名收到通知信（工作坊/課程單場；非候補；運動按摩不附匯款帳號；非同步、失敗不阻斷）
      if (!result.isWaitlist) {
        try {
          const db3 = getDb();
          const sDoc = await db3.collection('courseSessions').doc(req.params.sessionId).get();
          const sd = sDoc.exists ? sDoc.data() : null;
          const c = sd ? (await db3.collection(COLLECTIONS.COURSES || 'courses').doc(sd.courseId).get()).data() : null;
          if (c) {
            const _rn = require('../services/registrationNotify');
            const mDoc = await db3.collection(COLLECTIONS.MEMBERS).doc(req.body.memberId).get();
            // 分期時通知信「應繳金額」改顯示第一期（簽約當下實收），避免誤導成要一次繳全期總額
            const _instInfo = installmentPlan ? { firstAmount: installmentPlan.installments[0].amount, totalAmount: installmentPlan.totalAmount, totalPeriods: installmentPlan.installments.length } : null;
            _rn.notifyRegReceived({
              memberId: req.body.memberId,
              memberName: mDoc.exists ? (mDoc.data().name || '') : '',
              typeLabel: c.type === 'workshop' ? '工作坊' : '課程',
              itemName: c.name, gymId: c.gymId || req.staff?.gymId || req.body.gymId,
              fee: _instInfo ? _instInfo.firstAmount : (result.enrollment?.enrollmentFee ?? 0), paymentMethod: req.body.paymentMethod || 'transfer',
              massage: _rn.isMassage(c.name),
              sessions: sd ? [{ date: sd.date, startTime: sd.startTime, endTime: sd.endTime }] : null,
              installmentInfo: _instInfo,
            });
          }
        } catch (e) { console.error('[Email] 工作坊報名通知', e.message); }
      }

      res.status(result.isWaitlist ? 200 : 201).json({ ...result, deferralRequest, installmentPlan });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /courses/public/sessions/:sessionId/enroll - 訪客報名單堂工作坊（免登入，先轉帳）────
// 不建帳號（memberId 用不會碰撞的 guest_<uuid> 佔位字串，避免與其他訪客誤判重複報名/名額計算漂移）；
// 一律轉帳、無分期/無定期票練習期遞延（訪客沒有既有票券關係）；未成年一律要求本人+法定代理人皆線上簽名。
router.post('/public/sessions/:sessionId/enroll', async (req, res) => {
  try {
    const { guestName, guestPhone, guestEmail, guestBirthday, portraitSignature, guardianSignature,
      healthNote, referralSource, enrollGender, enrollAge, enrollNote,
      bankLastFive, paymentDate } = req.body;
    if (!guestName || !String(guestName).trim()) return res.status(400).json({ code:'MISSING_CONTACT', message:'請填寫姓名' });
    if (!guestPhone || !String(guestPhone).trim()) return res.status(400).json({ code:'MISSING_PHONE', message:'請填寫聯絡電話' });
    if (!guestBirthday) return res.status(400).json({ code:'MISSING_BIRTHDAY', message:'請填寫生日' });
    if (isUnder4(guestBirthday)) return res.status(400).json({ code:'AGE_UNDER_5', message:'未滿 4 歲無法報名課程' });
    if (!portraitSignature) return res.status(400).json({ code:'CONSENT_REQUIRED', message:'請先完成簽名' });
    if (isMinor(guestBirthday) && !guardianSignature) return res.status(400).json({ code:'GUARDIAN_SIGNATURE_REQUIRED', message:'未滿 18 歲需法定代理人簽名' });
    if (!bankLastFive || !String(bankLastFive).trim()) return res.status(400).json({ code:'MISSING_TRANSFER', message:'請填寫匯款帳號末五碼' });
    if (!paymentDate || !String(paymentDate).trim()) return res.status(400).json({ code:'MISSING_PAYMENT_DATE', message:'請填寫轉帳日期' });

    const sessionDoc = await getDb().collection('courseSessions').doc(req.params.sessionId).get();
    if (!sessionDoc.exists) return res.status(404).json({ code:'SESSION_NOT_FOUND', message:'找不到此場次' });
    const session = sessionDoc.data();

    const memberId = `guest_${uuidv4()}`;
    const result = await courseService.enrollCourse({
      memberId,
      isGuestBooking: true, guestName: String(guestName).trim(), guestPhone: String(guestPhone).trim(), guestEmail: (guestEmail||'').trim(),
      sessionId: req.params.sessionId,
      gymId: session.gymId,
      staffId: null, byStaff: false,
      enrollGender, enrollAge, enrollNote,
      paymentDate, bankLastFive,
      healthNote, referralSource,
      confirmedLeavePolicy: req.body.confirmedLeavePolicy,
      confirmedRefundPolicy: req.body.confirmedRefundPolicy,
      portraitSignature, guardianSignature,
    });

    // 報名收到通知信（非候補；運動按摩不附匯款帳號；非同步、失敗不阻斷）
    if (!result.isWaitlist) {
      try {
        const courseDoc = await getDb().collection(COLLECTIONS.COURSES || 'courses').doc(session.courseId).get();
        const c = courseDoc.exists ? courseDoc.data() : null;
        if (c) {
          const _rn = require('../services/registrationNotify');
          _rn.notifyRegReceived({
            to: (guestEmail||'').trim(), memberId, memberName: String(guestName).trim(),
            typeLabel: c.type === 'workshop' ? '工作坊' : '課程',
            itemName: c.name, gymId: c.gymId || session.gymId,
            fee: result.enrollment?.enrollmentFee ?? 0, paymentMethod: 'transfer',
            massage: _rn.isMassage(c.name),
            sessions: [{ date: session.date, startTime: session.startTime, endTime: session.endTime }],
          });
        }
      } catch (e) { console.error('[Email] 訪客工作坊報名通知', e.message); }
    }

    res.status(result.isWaitlist ? 200 : 201).json({ ...result, message: result.isWaitlist ? result.message : '報名成功！請於期限內完成匯款，之後若在 app.redrocktaiwan.com 註冊會員（用同一支電話），此報名會自動歸入您的帳號。' });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ══════════════════════════════════════════════════════
// 請假
// ══════════════════════════════════════════════════════

// POST /courses/enrollments/:enrollmentId/leave - 請假
router.post('/enrollments/:enrollmentId/leave',
  authenticateAny,
  auditLog('course.leave'),
  async (req, res) => {
    try {
      let memberId = req.body.memberId || req.member?.id;
      // 驗證：會員只能為自己或子會員報名（查無會員時沿用原行為：放行交由後續服務處理）
      const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 'allow' });
      if (deny) return res.status(deny.status).json(deny.body);
      const result = await courseService.requestLeave({
        enrollmentId: req.params.enrollmentId,
        memberId,
        reason: req.body.reason,
      });
      res.json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// GET /courses/enrollments/:enrollmentId/cancel-leave-precheck - 銷假預檢（唯讀）
// 供會員按取消請假前先看：原堂剩餘名額／取消後補課額度，不動任何資料
router.get('/enrollments/:enrollmentId/cancel-leave-precheck',
  authenticateAny,
  async (req, res) => {
    try {
      let memberId = req.query.memberId || req.member?.id;
      const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 'allow' });
      if (deny) return res.status(deny.status).json(deny.body);
      const result = await courseService.precheckCancelLeave({
        enrollmentId: req.params.enrollmentId,
        memberId,
      });
      res.json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// POST /courses/enrollments/:enrollmentId/cancel-leave - 取消請假（銷假）
// 條件：課未開始+場次仍有名額；連動作廢補課資格、取消已報名未上的補課（已上過擋 MAKEUP_TAKEN）
router.post('/enrollments/:enrollmentId/cancel-leave',
  authenticateAny,
  auditLog('course.cancel_leave'),
  async (req, res) => {
    try {
      let memberId = req.body.memberId || req.member?.id;
      const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 'allow' });
      if (deny) return res.status(deny.status).json(deny.body);
      const result = await courseService.cancelLeave({
        enrollmentId: req.params.enrollmentId,
        memberId,
      });
      res.json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// POST /courses/enrollments/:enrollmentId/cancel-makeup - 取消補課（會員；上課一天前）
router.post('/enrollments/:enrollmentId/cancel-makeup',
  authenticateAny,
  auditLog('course.cancel_makeup'),
  async (req, res) => {
    try {
      let memberId = req.body.memberId || req.member?.id;
      const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 'allow' });
      if (deny) return res.status(deny.status).json(deny.body);
      const result = await courseService.cancelMakeup({ enrollmentId: req.params.enrollmentId, memberId });
      res.json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// POST /courses/enrollments/:enrollmentId/choose-cash - 候補遞補為正取後選擇現金付款（走既有待收款流程）
// 轉帳付款走既有 /transfers/upload（不用此端點）；此端點僅供「候補遞補、尚未選擇付款方式」時
// 選現金——比照 enroll-all 現金分支，直接建 transferRecords 待收款單，供值班/管理員在櫃檯確認收款。
router.post('/enrollments/:enrollmentId/choose-cash', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    let memberId = req.body.memberId || req.member?.id;
    const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 'allow' });
    if (deny) return res.status(deny.status).json(deny.body);

    const ref = db.collection('courseEnrollments').doc(req.params.enrollmentId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
    const e = doc.data();
    if (e.memberId !== memberId) return res.status(403).json({ error: 'FORBIDDEN' });
    if (e.status !== 'confirmed') return res.status(400).json({ error: 'INVALID_STATUS', message: '此報名狀態無法選擇付款方式' });
    if (e.paymentMethod) return res.status(400).json({ error: 'ALREADY_CHOSEN', message: '已選擇付款方式' });
    const fee = Number(e.enrollmentFee) || 0;
    if (fee <= 0) return res.status(400).json({ error: 'NO_FEE', message: '此報名無需付款' });

    const now = new Date();
    const trId = uuidv4();
    await db.collection('transferRecords').doc(trId).set({
      id: trId, orderType: 'course', refId: req.params.enrollmentId,
      memberId, memberName: e.memberName || '',
      gymId: e.gymId, courseId: e.courseId, courseName: e.courseName, orderName: e.courseName,
      amount: fee, paymentMethod: 'cash', status: 'pending',
      submittedAt: now, createdAt: now, updatedAt: now,
    });
    await ref.update({ paymentMethod: 'cash', updatedAt: now });
    res.json({ success: true, message: '已選擇現金付款，請至櫃檯繳費，工作人員將為您確認' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── 工作坊保證金：退還／沒收（店員獨立動作，與出席標記無關）───────────
// 兩者互斥、皆冪等（depositResolved 只能被其中一個消耗一次）；提前取消走 course-adjustments
// 退費申請的分級比例（見該路由 workshop 分支），不透過這兩個端點。
router.post('/enrollments/:enrollmentId/refund-deposit',
  authenticate, checkPermission('courses.manage'), auditLog('course.refund_deposit'),
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection('courseEnrollments').doc(req.params.enrollmentId);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
      const e = doc.data();
      if (!(Number(e.depositAmount) > 0)) return res.status(400).json({ error: 'NO_DEPOSIT', message: '此報名無保證金' });
      if (!e.depositCollectedAdjDone) return res.status(400).json({ error: 'DEPOSIT_NOT_COLLECTED', message: '保證金尚未收款確認，無法退還' });
      if (e.depositResolved) return res.status(400).json({ error: 'ALREADY_RESOLVED', message: '此保證金已處理過（退還或沒收）' });

      const now = new Date();
      await require('../services/settlementService').addCashAdjustment({
        gymId: e.gymId, sign: '-', type: '保證金退還', amount: e.depositAmount,
        note: `${e.memberName || ''}（${e.courseName || ''}）`,
      });
      await ref.update({
        depositResolved: true, depositResolution: 'refunded', depositRefundedAmount: e.depositAmount,
        depositResolvedBy: req.staff.name || req.staff.id, depositResolvedAt: now, updatedAt: now,
      });
      res.json({ success: true, message: `保證金 NT$${e.depositAmount} 已退還` });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

router.post('/enrollments/:enrollmentId/forfeit-deposit',
  authenticate, checkPermission('courses.manage'), auditLog('course.forfeit_deposit'),
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection('courseEnrollments').doc(req.params.enrollmentId);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
      const e = doc.data();
      if (!(Number(e.depositAmount) > 0)) return res.status(400).json({ error: 'NO_DEPOSIT', message: '此報名無保證金' });
      if (!e.depositCollectedAdjDone) return res.status(400).json({ error: 'DEPOSIT_NOT_COLLECTED', message: '保證金尚未收款確認，無法沒收' });
      if (e.depositResolved) return res.status(400).json({ error: 'ALREADY_RESOLVED', message: '此保證金已處理過（退還或沒收）' });

      const now = new Date();
      // 沒收不需另記帳——金額已在收款確認當下記過「+保證金收取」，錢留在抽屜即等於已沒收；
      // 且該筆從未進過教學費營收（保證金本就不是 recordTransaction 的一部分），符合「不算收入」。
      await ref.update({
        depositResolved: true, depositResolution: 'forfeited', depositRefundedAmount: 0,
        depositResolvedBy: req.staff.name || req.staff.id, depositResolvedAt: now, updatedAt: now,
        depositResolveReason: req.body.reason || null,
      });
      res.json({ success: true, message: `保證金 NT$${e.depositAmount} 已沒收（會員未出席）` });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// 補課
// ══════════════════════════════════════════════════════

// GET /courses/makeup/member/:memberId - 查詢補課資格
router.get('/makeup/member/:memberId', authenticateAny, async (req, res) => {
  try {
    const rights = await courseService.getMemberMakeupRights(req.params.memberId);
    res.json({ rights });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /courses/makeup/:makeupId/use - 使用補課資格
router.post('/makeup/:makeupId/use',
  authenticateAny,
  auditLog('course.makeup'),
  [
    body('targetSessionId').notEmpty().withMessage('請指定補課場次'),
    body('memberId').notEmpty().withMessage('請指定會員'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await courseService.enrollMakeup({
        makeupId: req.params.makeupId,
        memberId: req.body.memberId,
        targetSessionId: req.body.targetSessionId,
      });
      res.json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ══════════════════════════════════════════════════════
// 出席
// ══════════════════════════════════════════════════════

// POST /courses/sessions/:sessionId/attendance - 出席簽到
router.post('/sessions/:sessionId/attendance',
  authenticate, checkPermission('courses.manage'),
  auditLog('course.attendance'),
  [
    body('memberId').notEmpty().withMessage('請指定會員'),
    body('status').isIn(['present', 'absent', 'late']).withMessage('狀態必須為 present/absent/late'),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await courseService.markAttendance({
        sessionId: req.params.sessionId,
        memberId: req.body.memberId,
        staffId: req.staff.id,
        status: req.body.status,
      });
      res.json(result);
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── GET /courses/:courseId/attendance/download - 出缺席點名表 CSV（管理員）──
// 矩陣：每列一位正取學員、每欄一個場次（依日期），格值 出席/缺席/遲到/空白 + 出席次數小計。
router.get('/:courseId/attendance/download',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const courseId = req.params.courseId;
      const courseDoc = await db.collection('courses').doc(courseId).get();
      if (!courseDoc.exists) return res.status(404).json({ error: 'COURSE_NOT_FOUND', message: '找不到課程' });

      // 場次（排除已取消，依日期→開始時間排序）
      const sessSnap = await db.collection('courseSessions').where('courseId', '==', courseId).get();
      const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.status !== 'cancelled')
        .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));

      // 正取學員（去重 memberId）
      const enrollSnap = await db.collection('courseEnrollments')
        .where('courseId', '==', courseId).where('status', '==', 'confirmed')
        .select('memberId').get();
      const memberIds = [...new Set(enrollSnap.docs.map(d => d.data().memberId).filter(Boolean))];

      // 姓名以 members 集合為權威補齊
      const nameMap = {};
      if (memberIds.length) {
        const mdocs = await db.getAll(...memberIds.map(id => db.collection('members').doc(id)));
        mdocs.forEach(d => { if (d.exists) nameMap[d.id] = { name: d.data().name || '', phone: d.data().phone || '' }; });
      }

      // 出席紀錄：{ sessionId: { memberId: status } }
      const attBySession = {};
      for (const s of sessions) {
        const aSnap = await db.collection('courseAttendance').where('sessionId', '==', s.id).get();
        const m = {};
        aSnap.docs.forEach(d => { m[d.data().memberId] = d.data().status; });
        attBySession[s.id] = m;
      }

      // 報名備註（Phase 3：改讀 courseRegistrations header，一次報名一筆、天生無重複，不用再逐筆掃 slot 撿非空值）
      const noteMap = {};
      if (memberIds.length) {
        for (let i = 0; i < memberIds.length; i += 30) {
          const batch = memberIds.slice(i, i + 30);
          const hSnap = await db.collection('courseRegistrations')
            .where('courseId', '==', courseId).where('memberId', 'in', batch)
            // header 內嵌簽名圖，只取備註欄位（2026-08-27 補投影）
            .select('memberId', 'enrollNote', 'healthNote', 'referralSource', 'staffNote')
            .get();
          hSnap.forEach(d => {
            const h = d.data();
            noteMap[h.memberId] = { enrollNote: h.enrollNote || '', healthNote: h.healthNote || '', referralSource: h.referralSource || '', staffNote: h.staffNote || '' };
          });
        }
      }

      const label = { present: '出席', absent: '缺席', late: '遲到' };
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const sessCol = (s) => s.date + (s.startTime ? ` ${s.startTime}` : '');
      const rows = [[q('學員姓名'), q('電話'), q('備註'), q('健康備註'), q('如何得知'), q('員工備註'), ...sessions.map(s => q(sessCol(s))), q('出席次數')].join(',')];
      memberIds.forEach(mid => {
        const nm = nameMap[mid] || {};
        const nt = noteMap[mid] || {};
        let attended = 0;
        const cells = sessions.map(s => {
          const st = attBySession[s.id]?.[mid];
          if (st === 'present' || st === 'late') attended++; // 出席/遲到皆計為出席
          return q(label[st] || '');
        });
        rows.push([q(nm.name), q(nm.phone), q(nt.enrollNote || ''), q(nt.healthNote || ''), q(nt.referralSource || ''), q(nt.staffNote || ''), ...cells, attended].join(','));
      });

      const csv = '\uFEFF' + rows.join('\n'); // BOM for Excel UTF-8
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="course_attendance_${courseId}.csv"`);
      res.send(csv);
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── GET /courses/:courseId/roster/download - 完整報名名單下載（主要供工作坊用；每筆報名一列，
//    含場次日期時段/狀態/出席/付款/金額/各類備註，非出缺席矩陣。任何課程類型皆可呼叫）───────
router.get('/:courseId/roster/download',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const courseId = req.params.courseId;
      const courseDoc = await db.collection('courses').doc(courseId).get();
      if (!courseDoc.exists) return res.status(404).json({ error: 'COURSE_NOT_FOUND', message: '找不到課程' });

      // 全部報名（不篩狀態——含正取/候補/請假/取消，才算「完整資料」），依日期→時段→報名時間排序
      // ⚠️ .select() 排除內嵌簽名圖等大欄位，只投影此 CSV 實際用到的欄位（見下方 rows.push 使用的 e.*）
      const enrollSnap = await db.collection('courseEnrollments').where('courseId', '==', courseId)
        .select('isGuest', 'memberId', 'memberName', 'contactPhone', 'sessionId', 'date', 'startTime', 'endTime',
          'status', 'paymentMethod', 'enrollmentFee', 'paymentDate', 'bankLastFive',
          'enrollGender', 'enrollAge', 'healthNote', 'enrollNote', 'referralSource', 'createdAt', 'enrolledAt')
        .get();
      const enrolls = enrollSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const secOf = ts => ts?._seconds || (ts?.toDate ? Math.floor(ts.toDate().getTime() / 1000) : 0);
      enrolls.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || '') || (secOf(a.createdAt) - secOf(b.createdAt)));

      // 會員姓名/電話以 members 集合為權威補齊（訪客 isGuest 直接用 enrollment 快照，不查會員）
      const memberIds = [...new Set(enrolls.filter(e => !e.isGuest && e.memberId).map(e => e.memberId))];
      const nameMap = {};
      if (memberIds.length) {
        const mdocs = await db.getAll(...memberIds.map(id => db.collection('members').doc(id)));
        mdocs.forEach(d => { if (d.exists) nameMap[d.id] = { name: d.data().name || '', phone: d.data().phone || '' }; });
      }

      // 報名 header（courseRegistrations）：staffNote/會員填實際匯款/管理員編修實收金額，用 sourceEnrollmentIds 對回各筆報名
      const headerByEnrollId = {};
      // header 內嵌簽名圖，只取 CSV 用到的欄位（2026-08-27 補投影）
      const hSnap = await db.collection('courseRegistrations').where('courseId', '==', courseId)
        .select('sourceEnrollmentIds', 'memberPaidAmount', 'receivedAmountOverride', 'healthNote', 'enrollNote', 'referralSource', 'staffNote')
        .get();
      hSnap.forEach(d => {
        const h = d.data();
        (h.sourceEnrollmentIds || []).forEach(eid => { headerByEnrollId[eid] = h; });
      });

      // 出席紀錄（依場次逐一查，courseAttendance 以 sessionId+memberId 為鍵）
      const sessionIds = [...new Set(enrolls.map(e => e.sessionId).filter(Boolean))];
      const attMap = {}; // `${sessionId}_${memberId}` -> status
      for (const sid of sessionIds) {
        const aSnap = await db.collection('courseAttendance').where('sessionId', '==', sid).get();
        aSnap.forEach(d => { const a = d.data(); attMap[`${sid}_${a.memberId}`] = a.status; });
      }

      const STATUS_LABEL = { confirmed: '正取', waitlist: '候補', leave: '請假', cancelled: '已取消' };
      const ATT_LABEL = { present: '出席', absent: '缺席', late: '遲到' };
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['場次日期', '時段', '姓名', '電話', '報名狀態', '出席', '付款方式', '應繳金額', '會員填實際匯款', '確認實收金額',
        '匯款日期', '匯款末五碼', '性別', '年齡', '健康備註', '自訂備註', '如何得知', '員工備註', '報名時間'];
      const rows = [header.map(q).join(',')];
      enrolls.forEach(e => {
        const h = headerByEnrollId[e.id] || {};
        const nm = e.isGuest ? { name: e.memberName || '', phone: e.contactPhone || '' } : (nameMap[e.memberId] || { name: e.memberName || '', phone: '' });
        const att = ATT_LABEL[attMap[`${e.sessionId}_${e.memberId}`]] || '';
        const enrolledAtSec = secOf(e.createdAt || e.enrolledAt);
        const enrolledAtStr = enrolledAtSec ? new Date(enrolledAtSec * 1000 + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '';
        rows.push([
          e.date || '', `${e.startTime || ''}~${e.endTime || ''}`,
          nm.name, nm.phone,
          STATUS_LABEL[e.status] || e.status || '',
          att,
          e.paymentMethod || '', e.enrollmentFee ?? '', h.memberPaidAmount ?? '', h.receivedAmountOverride ?? e.enrollmentFee ?? '',
          e.paymentDate || '', e.bankLastFive || '',
          e.enrollGender || '', e.enrollAge ?? '',
          e.healthNote || h.healthNote || '', e.enrollNote || h.enrollNote || '', e.referralSource || h.referralSource || '',
          h.staffNote || '',
          enrolledAtStr,
        ].map(q).join(','));
      });

      const csvBom = String.fromCharCode(0xFEFF) + rows.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="course_roster_${courseId}.csv"`);
      res.send(csvBom);
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// 會員查詢自己的報名紀錄
// ══════════════════════════════════════════════════════

// POST /courses/enrollments/:enrollmentId/resend-notification - 重新寄送「報名收到」通知信
// （super_admin 專用；用於資料修正後補寄正確金額的通知信，讀取當下 enrollment 的最新 fee）
router.post('/enrollments/:enrollmentId/resend-notification', authenticate, checkPermission('super_admin'), async (req, res) => {
  try {
    const db = getDb();
    const enrollDoc = await db.collection('courseEnrollments').doc(req.params.enrollmentId).get();
    if (!enrollDoc.exists) return res.status(404).json({ error: 'ENROLLMENT_NOT_FOUND' });
    const e = enrollDoc.data();
    const courseDoc = await db.collection('courses').doc(e.courseId).get();
    if (!courseDoc.exists) return res.status(404).json({ error: 'COURSE_NOT_FOUND' });
    const c = courseDoc.data();
    const mDoc = await db.collection('members').doc(e.memberId).get();
    const _rn = require('../services/registrationNotify');
    let sessions = null;
    if (e.sessionId) {
      const sDoc = await db.collection('courseSessions').doc(e.sessionId).get();
      if (sDoc.exists) sessions = [{ date: sDoc.data().date, startTime: sDoc.data().startTime, endTime: sDoc.data().endTime }];
    }
    if (!sessions && e.date) sessions = [{ date: e.date, startTime: e.startTime, endTime: e.endTime }];
    // 若此會員此課程有分期計畫，「應繳金額」改顯示第一期，避免補寄信誤導成要一次繳全期總額
    const planSnap = await db.collection('installmentPlans')
      .where('memberId', '==', e.memberId).where('relatedId', '==', e.courseId).get();
    const plan = planSnap.docs.map(d => d.data()).find(p => p.status !== 'cancelled') || null;
    const instInfo = plan ? { firstAmount: plan.installments[0].amount, totalAmount: plan.totalAmount, totalPeriods: plan.installments.length } : null;
    const feeToShow = instInfo ? instInfo.firstAmount : (e.enrollmentFee ?? e.fee ?? 0);
    await _rn.notifyRegReceived({
      memberId: e.memberId,
      memberName: mDoc.exists ? (mDoc.data().name || '') : (e.memberName || ''),
      typeLabel: c.type === 'workshop' ? '工作坊' : '課程',
      itemName: c.name, gymId: c.gymId || e.gymId,
      fee: feeToShow,
      paymentMethod: (c.paymentMethods && c.paymentMethods.length === 1) ? c.paymentMethods[0] : (e.paymentMethod && e.paymentMethod !== 'pending' ? e.paymentMethod : 'transfer'),
      massage: _rn.isMassage(c.name),
      sessions,
      installmentInfo: instInfo,
    });
    res.json({ success: true, fee: feeToShow });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /courses/member/:memberId/enrollments
router.get('/member/:memberId/enrollments', authenticateAny, async (req, res) => {
  try {
    const enrollments = await courseService.getMemberEnrollments(req.params.memberId);
    res.json({ enrollments });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

router.post('/:courseId/generate-sessions',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const result = await createWeeklySessions({
        courseId: req.params.courseId,
        gymId: req.staff.gymId || req.body.gymId || null,
        staffId: req.staff.id,
        confirm: req.body.confirm === true,
      });
      res.status(result.preview ? 200 : 201).json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /courses/sessions/:sessionId - 更新單一場次 ──────────────
router.put('/sessions/:sessionId',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const session = await updateSession({
        sessionId: req.params.sessionId,
        staffId: req.staff.id,
        data: req.body,
      });
      res.json({ session, message: '場次已更新' });
    } catch (err) {
      if (err.code === 'DUPLICATE_SESSION') return res.status(409).json(err);
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /courses/sessions/:sessionId/substitute - 設定該堂代班教練（更新月曆+待辦提醒）──
router.put('/sessions/:sessionId/substitute',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const coachName = (req.body.coachName || '').trim();
      if (!coachName) return res.status(400).json({ code: 'MISSING_COACH', message: '請指定代班教練' });
      const result = await courseService.setSessionSubstitute({
        sessionId: req.params.sessionId,
        coachId: req.body.coachId || null,
        coachName, reason: req.body.reason || '', staff: req.staff,
      });
      res.json({ success: true, ...result, message: '已設定代班教練並發送待辦提醒' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── DELETE /courses/sessions/:sessionId/substitute - 取消代班（還原原教練）──
router.delete('/sessions/:sessionId/substitute',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const result = await courseService.clearSessionSubstitute({ sessionId: req.params.sessionId, staff: req.staff });
      res.json({ success: true, ...result, message: '已取消代班，恢復原教練' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);


// DELETE /courses/:courseId - 刪除課程（含所有場次）
router.delete('/:courseId',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const dayjs = require('dayjs');
      const courseId = req.params.courseId;
      const now = new Date();

      // 取消所有尚未開始的場次（已開始/已結束的場次保留歷史紀錄）
      const today = taiwanToday(); // 台灣日期
      const sessionsSnap = await db.collection('courseSessions')
        .where('courseId', '==', courseId)
        .where('date', '>=', today)
        .get();
      const batch = db.batch();
      sessionsSnap.docs.forEach(d => {
        if (d.data().status !== 'cancelled') batch.update(d.ref, { status: 'cancelled', updatedAt: now });
      });

      // 課程標記為已取消（保留歷史紀錄，不再硬刪除）
      batch.update(db.collection('courses').doc(courseId), { status: 'cancelled', cancelledAt: now, cancelledBy: req.staff.id, updatedAt: now });
      await batch.commit();

      // 將未來場次的 enrollment 標記為 course_cancelled，保留名單供退費作業
      const enrollSnap = await db.collection('courseEnrollments')
        .where('courseId', '==', courseId)
        .where('status', 'in', ['confirmed', 'leave'])
        .where('date', '>=', today)
        .select('memberId', 'courseName')
        .get();
      const enrollBatch = db.batch();
      const notifyMembers = new Map(); // memberId → { name, email, courseName }
      for (const d of enrollSnap.docs) {
        enrollBatch.update(d.ref, { status: 'course_cancelled', updatedAt: now });
        const e = d.data();
        if (e.memberId && !notifyMembers.has(e.memberId)) {
          // 取得會員 email
          try {
            const mSnap = await db.collection('members').doc(e.memberId).get();
            if (mSnap.exists && mSnap.data().email) {
              notifyMembers.set(e.memberId, {
                name: mSnap.data().name || '',
                email: mSnap.data().email,
                courseName: e.courseName || '',
              });
            }
          } catch(e) {}
        }
      }
      await enrollBatch.commit();

      // 寄通知信給所有已報名會員
      const emailService = require('../services/emailService');
      const courseSnap = await db.collection('courses').doc(courseId).get();
      const courseName = courseSnap.exists ? courseSnap.data().name : courseId;
      for (const [, m] of notifyMembers) {
        emailService.sendEmail({
          to: m.email,
          subject: `【紅石攀岩】課程取消通知：${courseName}`,
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="color:#8B1A1A">課程取消通知</h2>
            <p>親愛的 ${emailService.esc(m.name)}，</p>
            <p>很抱歉通知您，您報名的課程 <strong>「${emailService.esc(courseName)}」</strong> 已取消。</p>
            <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0;color:#666;font-size:13px">
              退費將由館方人工處理，如有疑問請聯繫館方。
            </div>
            <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
          </div>`,
        }).catch(() => {});
      }

      res.json({ message: '課程已取消', notifiedCount: notifyMembers.size });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /courses/:courseId/reopen - 取消課程後重新開啟（還原場次/報名，與 DELETE /:courseId 對稱）──
// 還原此課程「取消且無其他明確原因」的場次（不動休館停課 closureCancelSession 設的 cancelReason:'closure'
// 場次，那批已各自走過補償/發券流程）；報名則靠 DELETE /:courseId 專屬寫入的 status:'course_cancelled'
// 辨識（此狀態值只有課程整體取消這條路徑會寫，不會與其他取消原因混淆，不需比對時間戳）。
router.post('/:courseId/reopen',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const courseId = req.params.courseId;
      const courseRef = db.collection('courses').doc(courseId);
      const courseDoc = await courseRef.get();
      if (!courseDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到課程' });
      const course = courseDoc.data();
      if (course.status !== 'cancelled') return res.status(400).json({ error: 'NOT_CANCELLED', message: '此課程未取消，無需重新開啟' });
      const now = new Date();

      // 還原場次：狀態為取消、且無明確其他原因（休館停課等）者
      const sessSnap = await db.collection('courseSessions').where('courseId', '==', courseId).where('status', '==', 'cancelled').get();
      const sessBatch = db.batch();
      let sessionsReopened = 0;
      const reopenedSessionIds = new Set();
      sessSnap.docs.forEach(d => {
        const s = d.data();
        if (s.cancelReason) return; // 休館停課等有明確原因者不還原
        sessBatch.update(d.ref, { status: 'scheduled', updatedAt: now });
        reopenedSessionIds.add(d.id);
        sessionsReopened++;
      });
      if (sessionsReopened > 0) await sessBatch.commit();

      // 還原報名：這次課程整體取消時被標記 course_cancelled、且對應場次確實有被還原者
      // 注意：取消課程（DELETE /:courseId）當初標記 course_cancelled 時**不會**去動場次的
      // enrolledCount（該欄位在課程/場次取消時本就沒被扣減）——因此這裡還原報名狀態時也**不能**
      // 反向 +1，否則會與從未被扣減過的原值重複疊加（實測驗證過：若還原時 +1，人數會從 1 累加成 2）。
      const enrollSnap = await db.collection('courseEnrollments').where('courseId', '==', courseId).where('status', '==', 'course_cancelled')
        .select('sessionId', 'leaveAt', 'leaveReason').get();
      const enrollBatch = db.batch();
      let enrollmentsRestored = 0;
      enrollSnap.docs.forEach(d => {
        const e = d.data();
        if (e.sessionId && !reopenedSessionIds.has(e.sessionId)) return; // 對應場次沒被還原就不還原報名
        const restoreStatus = (e.leaveAt || e.leaveReason) ? 'leave' : 'confirmed';
        enrollBatch.update(d.ref, { status: restoreStatus, updatedAt: now });
        enrollmentsRestored++;
      });
      if (enrollmentsRestored > 0) await enrollBatch.commit();

      await courseRef.update({
        status: 'active', cancelledAt: null, cancelledBy: null,
        reopenedAt: now, reopenedBy: req.staff.id, updatedAt: now,
      });

      res.json({ message: '課程已重新開啟', sessionsReopened, enrollmentsRestored });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);


// DELETE /courses/:courseId/permanent - 永久刪除課程（含場次/報名，僅限無在籍學員）
router.delete('/:courseId/permanent',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const courseId = req.params.courseId;

      // 防呆：僅「開放中」課程要求先取消；已取消的課程可直接永久刪除
      const courseSnap = await db.collection('courses').doc(courseId).get();
      const isCancelled = courseSnap.exists && courseSnap.data().status === 'cancelled';
      if (!isCancelled) {
        const activeCnt = await db.collection('courseEnrollments')
          .where('courseId', '==', courseId)
          .where('status', 'in', ['confirmed', 'leave', 'waitlist'])
          .count().get();
        if (activeCnt.data().count > 0) {
          return res.status(400).json({ error: 'HAS_ENROLLMENTS', message: `尚有 ${activeCnt.data().count} 筆有效報名，請先「取消課程」並處理退費後再刪除` });
        }
      }

      // 級聯刪除：場次、所有報名(含已取消)、補課額度、調整申請，最後刪課程本身
      let deleted = 0;
      for (const name of ['courseSessions', 'courseEnrollments', 'courseMakeupRights', 'courseAdjustmentRequests']) {
        const snap = await db.collection(name).where('courseId', '==', courseId).select().get(); // key-only：只要 ref 供刪除
        for (let i = 0; i < snap.docs.length; i += 450) {
          const batch = db.batch();
          snap.docs.slice(i, i + 450).forEach(d => { batch.delete(d.ref); deleted++; });
          await batch.commit();
        }
      }
      await db.collection('courses').doc(courseId).delete();

      res.json({ success: true, message: '課程已永久刪除', deletedDocs: deleted });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// GET /courses/:courseId/participant-emails - 開課前通知用：目前有效報名者 email 清單
// （完整比照 competitions.js 的賽前通知，見 courseService.getCourseParticipantEmails）
// ?onlyNew=1 → 只預覽「上次通知後才報名」的名單（無上次通知紀錄則等同全部）
router.get('/:courseId/participant-emails', authenticate, checkPermission('courses.manage'), async (req, res) => {
  try {
    let sinceDate = null;
    if (req.query.onlyNew === '1') {
      const doc = await getDb().collection('courses').doc(req.params.courseId).get();
      sinceDate = doc.exists ? (doc.data().lastNoticeSentAt || null) : null;
    }
    const list = await courseService.getCourseParticipantEmails(req.params.courseId, { sinceDate });
    res.json({ recipients: list, count: list.length });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// POST /courses/:courseId/send-notice - 開課前通知：櫃檯編輯草稿後發送給全部有效報名者（BCC）
router.post('/:courseId/send-notice', authenticate, checkPermission('courses.manage'), async (req, res) => {
  try {
    const { subject, body, onlyNew } = req.body;
    const result = await courseService.sendCourseNotice({
      courseId: req.params.courseId, subject, html: body, onlyNew: !!onlyNew,
      staffId: req.staff.id, staffName: req.staff.name,
    });
    res.json({ ...result, message: `已寄出給 ${result.recipientCount} 位學員` });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// GET /courses/participant-emails-batch?courseIds=a,b,c - 多梯次合併預覽收件名單（去重後）
router.get('/participant-emails-batch', authenticate, checkPermission('courses.manage'), async (req, res) => {
  try {
    const courseIds = String(req.query.courseIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!courseIds.length) return res.status(400).json({ error: 'MISSING_COURSES', message: '請至少選擇一個梯次' });
    const onlyNew = req.query.onlyNew === '1';
    const db = getDb();
    const docs = await db.getAll(...courseIds.map(id => db.collection('courses').doc(id)));
    const seenEmail = new Set();
    const recipients = [];
    for (let i = 0; i < courseIds.length; i++) {
      if (!docs[i].exists) continue;
      const sinceDate = onlyNew ? (docs[i].data().lastNoticeSentAt || null) : null;
      const list = await courseService.getCourseParticipantEmails(courseIds[i], { sinceDate });
      list.forEach(x => { if (!seenEmail.has(x.email)) { seenEmail.add(x.email); recipients.push(x); } });
    }
    res.json({ recipients, count: recipients.length });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// POST /courses/send-notice-batch - 多梯次一次發送同一份開課通知（合併名單去重、BCC 一次寄出）
router.post('/send-notice-batch', authenticate, checkPermission('courses.manage'), async (req, res) => {
  try {
    const { courseIds, subject, body, onlyNew } = req.body;
    const result = await courseService.sendCourseNoticeBatch({
      courseIds, subject, html: body, onlyNew: !!onlyNew,
      staffId: req.staff.id, staffName: req.staff.name,
    });
    res.json({ ...result, message: `已寄出給 ${result.recipientCount} 位學員（共 ${result.courseCount} 個梯次）` });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// POST /courses/:courseId/image - 上傳課程海報（單張，存 Firebase Storage、回 signed URL 並寫入課程 imageUrl）
router.post('/:courseId/image',
  authenticate, checkPermission('courses.manage'), auditLog('course.image.upload'),
  uploadImage.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'NO_FILE', message: '請選擇圖片' });
      if (!(req.file.mimetype || '').startsWith('image/')) {
        return res.status(400).json({ error: 'NOT_IMAGE', message: '只能上傳圖片檔' });
      }
      const db = getDb();
      const doc = await db.collection('courses').doc(req.params.courseId).get();
      if (!doc.exists) return res.status(404).json({ error: 'COURSE_NOT_FOUND', message: '找不到課程' });

      const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const bucket = getStorage().bucket();
      const fileName = `courses/poster_${req.params.courseId}_${uuidv4()}.${ext}`;
      const file = bucket.file(fileName);
      await file.save(req.file.buffer, { contentType: req.file.mimetype });
      const [url] = await file.getSignedUrl({ action: 'read', expires: '2035-01-01' });

      await db.collection('courses').doc(req.params.courseId).update({ imageUrl: url, updatedAt: new Date() });
      res.json({ message: '課程海報已上傳', imageUrl: url });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// PUT /courses/:courseId - 更新課程
router.put('/:courseId',
  authenticate, checkPermission('courses.manage'), auditLog('course.update'),
  async (req, res) => {
    try {
      const db = getDb();
      const allowedFields = [
        'name', 'cohortName', 'categoryId', 'description', 'imageUrl', 'price', 'pricePerSession', 'maxStudents', 'maxWaitlist', 'instructor',
        'startDate', 'endDate', 'startTime', 'endTime', 'weekdays',
        'leaveDeadlineHours', 'maxLeaves', 'allowMakeup', 'makeupDeadlineDays', 'makeupDeadlineDate', 'handlingFeeRate', 'preStartFeeRate',
        'enrollOpenDate', 'alumniOpenDate', 'fullTermRenewalDiscount', 'alumniDiscount', 'renewalDeadline',
        'fullTermRenewalDiscountEnabled', 'fullTermRenewalDiscountRate', 'alumniDiscountEnabled', 'alumniDiscountRate',
        'teamOpenDate', 'generalOpenDate', 'teamPrice',
        'skipSignature', 'collectGenderAge', 'enrollNoteLabel', 'enrollNoteRequired', 'refundTiers', 'depositAmount',
        'midpointSurcharge', 'gymAccessDaysAfter', 'gymAccessDaysBefore', 'status',
        'unlimitedPracticeStart', 'unlimitedPracticeEnd',
        'allowTrial', 'trialPrice', 'trialTarget', 'makeupTarget', 'isActive', 'paymentMethods', // isActive：停用/啟用（會員課程總覽隱藏，不通知、不動報名）
      ];
      const updates = { updatedAt: new Date() };
      allowedFields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      // 梯次名稱/班別變更、週課調整單堂價、或上課時段變更（需比對是否真的改變才決定是否連動場次/報名）→ 讀一次現有文件
      let _curDoc = null;
      if (updates.cohortName !== undefined || updates.categoryId !== undefined || updates.pricePerSession !== undefined
        || updates.startTime !== undefined || updates.endTime !== undefined) {
        _curDoc = await db.collection('courses').doc(req.params.courseId).get();
      }
      const cur = _curDoc && _curDoc.exists ? _curDoc.data() : {};
      if (updates.cohortName !== undefined || updates.categoryId !== undefined) {
        const cohortName = updates.cohortName ?? cur.cohortName;
        const categoryId = updates.categoryId ?? cur.categoryId;
        if (cohortName && categoryId) {
          const cat = await courseService.getCategoryOf(db, categoryId);
          if (cat?.name) updates.name = `${cat.name} ${cohortName}`;
        }
      }
      // 週課調整單堂價 → 整期總價（快取欄位 price）同步重算＝單堂價×目前總堂數（不重新產生場次）
      if (updates.pricePerSession !== undefined) {
        updates.price = Math.round((Number(updates.pricePerSession) || 0) * (cur.totalSessions || 0));
      }
      // 候補上限：留空('')＝不限候補(null)，否則轉數字
      if (req.body.maxWaitlist !== undefined) {
        updates.maxWaitlist = (req.body.maxWaitlist === '' || req.body.maxWaitlist === null) ? null : Number(req.body.maxWaitlist);
      }
      // 工作坊退費分級：空陣列/未提供有效項目＝清空（套回系統預設）
      if (req.body.refundTiers !== undefined) {
        updates.refundTiers = Array.isArray(req.body.refundTiers) && req.body.refundTiers.length
          ? req.body.refundTiers.map(t => ({ daysBefore: Number(t.daysBefore) || 0, rate: Number(t.rate) || 0 }))
          : null;
      }
      if (req.body.depositAmount !== undefined) {
        updates.depositAmount = req.body.depositAmount !== '' ? (Number(req.body.depositAmount) || 0) : 0;
      }
      // 分期規則（dueAtSession：0＝報名當天、N(>=1)＝第N堂課到期）
      if (req.body.installment !== undefined) {
        const inst = req.body.installment;
        updates.installment = (inst && inst.enabled)
          ? { enabled: true, periods: (inst.periods || []).map(p => ({ percent: Number(p.percent) || 0, dueAtSession: Number(p.dueAtSession) || 0 })) }
          : { enabled: false, periods: [] };
      }

      await db.collection('courses').doc(req.params.courseId).update(updates);
      // maxStudents 變更 → 同步旗下未取消場次（場次名額是建立時快照；不同步會讓 報名/候補遞補/銷假 的
      // 名額判定停留在舊值——實例：課程 6→7 後場次仍 6，銷假被誤擋 SESSION_FULL）
      if (updates.maxStudents !== undefined) {
        const ssnap = await db.collection('courseSessions').where('courseId', '==', req.params.courseId).get();
        const batch = db.batch();
        let synced = 0;
        ssnap.forEach(d => { if (d.data().status !== 'cancelled') { batch.update(d.ref, { maxStudents: Number(updates.maxStudents), updatedAt: new Date() }); synced++; } });
        if (synced) await batch.commit();
      }
      // 上課時段（startTime/endTime）變更且真的與原值不同 → 同步旗下未取消場次＋其報名快照。
      // 場次的時段是「加開場次/產生場次」當下的快照，課程層級事後改時段本來就不會回頭改場次
      // （比照 maxStudents 同一類問題）——之前發生過課程改了 15:00~16:30，但整梯 9 場全部場次
      // 仍停在建立當下的空白時段，導致月曆排序把它排到最前面、時段完全看不出來。
      // enrollment 也要跟著同步（存 date/startTime/endTime 快照，用於請假時限「課前 N 小時」判定，
      // 不同步會讓已報名學員的請假期限算成錯的時間，比純顯示問題更嚴重）。
      if ((updates.startTime !== undefined && updates.startTime !== cur.startTime)
        || (updates.endTime !== undefined && updates.endTime !== cur.endTime)) {
        const timeUpd = {};
        if (updates.startTime !== undefined) timeUpd.startTime = updates.startTime;
        if (updates.endTime !== undefined) timeUpd.endTime = updates.endTime;
        const tsnap = await db.collection('courseSessions').where('courseId', '==', req.params.courseId).get();
        const tBatch = db.batch();
        let tSynced = 0;
        tsnap.forEach(d => { if (d.data().status !== 'cancelled') { tBatch.update(d.ref, { ...timeUpd, updatedAt: new Date() }); tSynced++; } });
        if (tSynced) await tBatch.commit();

        const ensnap = await db.collection('courseEnrollments').where('courseId', '==', req.params.courseId).select('status').get();
        const eBatch = db.batch();
        let eSynced = 0;
        ensnap.forEach(d => { if (d.data().status !== 'cancelled') { eBatch.update(d.ref, { ...timeUpd, updatedAt: new Date() }); eSynced++; } });
        if (eSynced) await eBatch.commit();
      }
      res.json({ message: '課程已更新', updates });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);



// GET /courses/:courseId/enrollments - 取得課程所有報名名單（員工用）
// ── 請假補課總表共用邏輯（單一課程）──────────────────────────────
async function buildLeaveMakeupSummary(db, courseId, courseDataOpt) {
      const courseDoc = courseDataOpt ? null : await db.collection('courses').doc(courseId).get();
      if (!courseDataOpt && !courseDoc.exists) return null;
      const course = courseDataOpt || courseDoc.data();
      if (course.type === 'workshop' || course.source === 'experience') return null; // 工作坊/體驗無請假補課
      const rules = courseService.resolveRules(course, await courseService.getCategoryOf(db, course.categoryId));
      const today = taiwanToday();

      const enSnap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).where('courseId', '==', courseId).get();
      const byMember = {};
      enSnap.docs.forEach(d => {
        const e = d.data();
        if (e.isTrial || e.isMakeup) return; // 試上/補課(單堂)不算該班學員；只列原班級整期學員（補課者列在其原班級）
        (byMember[e.memberId] = byMember[e.memberId] || []).push(e);
      });

      const rightsSnap = await db.collection('courseMakeupRights').where('courseId', '==', courseId).get();
      const rightsByMember = {};
      rightsSnap.docs.forEach(d => {
        const r = { id: d.id, ...d.data() };
        (rightsByMember[r.memberId] = rightsByMember[r.memberId] || []).push(r);
      });

      // 已排補課：用 used 券的 usedSessionId 反查場次（含補到其他班別的場次）
      const usedSessionIds = [...new Set(Object.values(rightsByMember).flat()
        .filter(r => r.status === 'used' && r.usedSessionId).map(r => r.usedSessionId))];
      const sessMap = {};
      for (let i = 0; i < usedSessionIds.length; i += 20) {
        const refs = usedSessionIds.slice(i, i + 20).map(id => db.collection('courseSessions').doc(id));
        (await db.getAll(...refs)).forEach(doc => { if (doc.exists) sessMap[doc.id] = doc.data(); });
      }

      // 姓名/電話以 members 集合權威補齊
      const memberIds = Object.keys(byMember);
      const nameMap = {};
      for (let i = 0; i < memberIds.length; i += 20) {
        const refs = memberIds.slice(i, i + 20).map(id => db.collection(COLLECTIONS.MEMBERS).doc(id));
        (await db.getAll(...refs)).forEach(doc => { if (doc.exists) nameMap[doc.id] = { name: doc.data().name, phone: doc.data().phone }; });
      }

      // 前期補課（跨期，isMakeup+crossTermNote）→ 併入 bookedMakeups 標「上期」；不佔當期補課額度
      const crossTermByMember = {};
      for (let i = 0; i < memberIds.length; i += 10) {
        const chunk = memberIds.slice(i, i + 10);
        if (!chunk.length) break;
        const q = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).where('memberId', 'in', chunk).get();
        q.docs.forEach(d => { const e = d.data(); if (e.isMakeup && e.crossTermNote && e.status !== 'cancelled') (crossTermByMember[e.memberId] = crossTermByMember[e.memberId] || []).push({ date: e.date, startTime: e.startTime || '', courseName: e.courseName || '', taken: !!e.date && e.date < today, note: e.crossTermNote }); });
      }

      const rows = memberIds.map(mid => {
        const ens = byMember[mid];
        const active = ens.filter(e => ['confirmed', 'leave', 'waitlist'].includes(e.status));
        if (!active.length) return null; // 全取消不列
        const rights = rightsByMember[mid] || [];
        const realLeaves = ens.filter(e => e.status === 'leave').map(e => e.date).filter(Boolean);
        const closureDays = rights.filter(r => r.source === 'closure' && r.closureDate).map(r => r.closureDate); // 停課日（豁免、不計請假數）
        const prevLeaveDays = rights.filter(r => r.source === 'prev_leave' && r.prevLeaveDate).map(r => `${r.prevLeaveDate}（上期請假${r.redemptionType === 'cash_credit' ? `・${r.status === 'used' ? '已折抵' : '待折抵'}NT$${r.cashCreditAmount || ''}` : ''}）`); // 上一期請假、列本期補課
        const leaves = [...realLeaves, ...closureDays.map(d => `${d}（停課）`), ...prevLeaveDays].sort();
        const cap = ens.find(e => e.maxLeavesAllowed != null)?.maxLeavesAllowed ?? rules.maxLeaves;
        // 現金折抵（redemptionType:'cash_credit'，如無可補課時段改折抵費用）不算補課次數，僅列在 leaves 供查核
        const avail = rights.filter(r => r.status === 'available' && r.redemptionType !== 'cash_credit' && (!r.expiresAt || require('dayjs')().isBefore(require('dayjs')(r.expiresAt.toDate()))));
        const used = rights.filter(r => r.status === 'used' && r.redemptionType !== 'cash_credit');
        const expiresAt = avail[0]?.expiresAt?.toDate?.() || null;
        const bookedMakeups = [...used.map(r => {
          const sx = sessMap[r.usedSessionId];
          return sx ? { date: sx.date, startTime: sx.startTime || '', courseName: sx.courseName || '', taken: !!sx.date && sx.date < today, note: (r.source === 'closure' && r.closureDate) ? '補' + String(r.closureDate).slice(5).replace('-', '/') + '停課' : ((r.source === 'prev_leave' && r.prevLeaveDate) ? '補' + String(r.prevLeaveDate).slice(5).replace('-', '/') + '上期請假' : undefined) } : null;
        }).filter(Boolean), ...(crossTermByMember[mid] || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        return {
          memberId: mid,
          memberName: nameMap[mid]?.name || ens[0].memberName || '',
          memberPhone: nameMap[mid]?.phone || '',
          leaves, leaveCount: realLeaves.length, leaveCap: cap,
          makeupAvailable: avail.length, makeupUsed: used.length, makeupTotal: avail.length + used.length,
          makeupExpiresAt: expiresAt ? new Date(expiresAt.getTime() + 8 * 3600000).toISOString().slice(0, 10) : null, // 台灣日期
          bookedMakeups,
        };
      }).filter(Boolean).sort((a, b) => a.memberName.localeCompare(b.memberName, 'zh-Hant'));

      // 未認領（此課程的 pendingCourseClaims）
      const pcSnap = await db.collection('pendingCourseClaims').where('courseId', '==', courseId).get();
      const pendingClaims = pcSnap.docs.map(d => d.data()).filter(x => x.claimed !== true)
        .map(x => ({ name: x.name, leaveDates: x.leaveDates || [] }));

      return {
        course: {
          id: courseId, name: course.name, gymId: course.gymId || null,
          maxLeaves: rules.maxLeaves,
          makeupDeadline: course.makeupDeadlineDate || (course.endDate ? require('dayjs')(course.endDate).add(rules.makeupDeadlineDays, 'day').format('YYYY-MM-DD') : null),
        },
        rows, pendingClaims,
      };
}

// GET /courses/leave-makeup-summary/all - 全部課程假補總表（可帶 gymId；只回有資料的課程）
// 效能：整批一次撈（courses/enrollments/rights/claims/categories 各一查詢＋members/sessions getAll），
// 勿逐課呼叫 buildLeaveMakeupSummary（19 門課串行 15 秒 → 前端 timeout）。
router.get('/leave-makeup-summary/all',
  authenticate, checkPermission('courses.view'),
  async (req, res) => {
    try {
      const db = getDb();
      const gymId = req.query.gymId || null;
      const today = taiwanToday();
      const [csSnap, enSnap, mkSnap, pcSnap, catSnap] = await Promise.all([
        db.collection('courses').get(),
        db.collection(COLLECTIONS.COURSE_ENROLLMENTS).get(),
        db.collection('courseMakeupRights').get(),
        db.collection('pendingCourseClaims').get(),
        db.collection('courseCategories').get(),
      ]);
      const cats = {}; catSnap.docs.forEach(d => { cats[d.id] = { id: d.id, ...d.data() }; });
      const courses = csSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(c => c.status !== 'cancelled' && c.isActive !== false && c.source !== 'experience')
        .filter(c => c.type !== 'workshop')   // 工作坊單堂、無請假補課概念 → 排除（體驗課 source:experience 已排除、試上 isTrial 已排除）
        .filter(c => !gymId || c.gymId === gymId);
      const courseIds = new Set(courses.map(c => c.id));

      const enByCourse = {}, mkByCourse = {}, pcByCourse = {};
      enSnap.docs.forEach(d => { const e = d.data(); if (e.isTrial || e.isMakeup || !courseIds.has(e.courseId)) return; ((enByCourse[e.courseId] = enByCourse[e.courseId] || {})[e.memberId] = (enByCourse[e.courseId][e.memberId] || [])).push(e); });
      mkSnap.docs.forEach(d => { const r = { id: d.id, ...d.data() }; if (!courseIds.has(r.courseId)) return; ((mkByCourse[r.courseId] = mkByCourse[r.courseId] || {})[r.memberId] = (mkByCourse[r.courseId][r.memberId] || [])).push(r); });
      pcSnap.docs.forEach(d => { const x = d.data(); if (x.claimed === true || !courseIds.has(x.courseId)) return; (pcByCourse[x.courseId] = pcByCourse[x.courseId] || []).push({ name: x.name, leaveDates: x.leaveDates || [] }); });

      // 姓名/場次批次補齊
      const allMemberIds = [...new Set(Object.values(enByCourse).flatMap(m => Object.keys(m)))];
      const nameMap = {};
      for (let i = 0; i < allMemberIds.length; i += 20) {
        const refs = allMemberIds.slice(i, i + 20).map(id => db.collection(COLLECTIONS.MEMBERS).doc(id));
        (await db.getAll(...refs)).forEach(doc => { if (doc.exists) nameMap[doc.id] = { name: doc.data().name, phone: doc.data().phone }; });
      }
      const usedSessionIds = [...new Set(mkSnap.docs.map(d => d.data()).filter(r => courseIds.has(r.courseId) && r.status === 'used' && r.usedSessionId).map(r => r.usedSessionId))];
      const sessMap = {};
      for (let i = 0; i < usedSessionIds.length; i += 20) {
        const refs = usedSessionIds.slice(i, i + 20).map(id => db.collection('courseSessions').doc(id));
        (await db.getAll(...refs)).forEach(doc => { if (doc.exists) sessMap[doc.id] = doc.data(); });
      }

      // 跨期補課（獨立一區）：含已結案(done)者一併顯示（供查核已完成補課），解析 booked 的 target session 課名（供顯示補課班級）
      const xmAllSnap = await db.collection('crossCohortMakeups').get();
      const xmActive = xmAllSnap.docs.map(d => d.data())
        .filter(x => !gymId || x.gymId === gymId);
      const xmBookSessIds = [...new Set(xmActive.filter(x => x.targetSessionId).map(x => x.targetSessionId))];
      const xmSessName = {};
      for (let i = 0; i < xmBookSessIds.length; i += 20) {
        const refs = xmBookSessIds.slice(i, i + 20).map(id => db.collection('courseSessions').doc(id));
        (await db.getAll(...refs)).forEach(doc => { if (doc.exists) xmSessName[doc.id] = doc.data().courseName || ''; });
      }

      // 前期補課（跨期，isMakeup+crossTermNote）→ 併入 bookedMakeups 標「上期」
      const crossTermByMember = {};
      for (let i = 0; i < allMemberIds.length; i += 10) {
        const chunk = allMemberIds.slice(i, i + 10);
        if (!chunk.length) break;
        const q = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).where('memberId', 'in', chunk).get();
        q.docs.forEach(d => { const e = d.data(); if (e.isMakeup && e.crossTermNote && e.status !== 'cancelled') (crossTermByMember[e.memberId] = crossTermByMember[e.memberId] || []).push({ date: e.date, startTime: e.startTime || '', courseName: e.courseName || '', taken: !!e.date && e.date < today, note: e.crossTermNote }); });
      }

      const groups = [];
      for (const c of courses) {
        const rules = courseService.resolveRules(c, cats[c.categoryId] || null);
        const byMember = enByCourse[c.id] || {};
        const rows = Object.keys(byMember).map(mid => {
          const ens = byMember[mid];
          const active = ens.filter(e => ['confirmed', 'leave', 'waitlist'].includes(e.status));
          if (!active.length) return null;
          const rights = (mkByCourse[c.id] || {})[mid] || [];
          const realLeaves = ens.filter(e => e.status === 'leave').map(e => e.date).filter(Boolean);
          const closureDays = rights.filter(r => r.source === 'closure' && r.closureDate).map(r => r.closureDate);
          const prevLeaveDays = rights.filter(r => r.source === 'prev_leave' && r.prevLeaveDate).map(r => `${r.prevLeaveDate}（上期請假${r.redemptionType === 'cash_credit' ? `・${r.status === 'used' ? '已折抵' : '待折抵'}NT$${r.cashCreditAmount || ''}` : ''}）`);
          const leaves = [...realLeaves, ...closureDays.map(d => `${d}（停課）`), ...prevLeaveDays].sort();
          const cap = ens.find(e => e.maxLeavesAllowed != null)?.maxLeavesAllowed ?? rules.maxLeaves;
          // 現金折抵（redemptionType:'cash_credit'，如無可補課時段改折抵費用）不算補課次數，僅列在 leaves 供查核
          const avail = rights.filter(r => r.status === 'available' && r.redemptionType !== 'cash_credit' && (!r.expiresAt || require('dayjs')().isBefore(require('dayjs')(r.expiresAt.toDate()))));
          const used = rights.filter(r => r.status === 'used' && r.redemptionType !== 'cash_credit');
          const expiresAt = avail[0]?.expiresAt?.toDate?.() || null;
          const bookedMakeups = [...used.map(r => {
            const sx = sessMap[r.usedSessionId];
            return sx ? { date: sx.date, startTime: sx.startTime || '', courseName: sx.courseName || '', taken: !!sx.date && sx.date < today, note: (r.source === 'closure' && r.closureDate) ? '補' + String(r.closureDate).slice(5).replace('-', '/') + '停課' : ((r.source === 'prev_leave' && r.prevLeaveDate) ? '補' + String(r.prevLeaveDate).slice(5).replace('-', '/') + '上期請假' : undefined) } : null;
          }).filter(Boolean), ...(crossTermByMember[mid] || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
          return {
            memberId: mid,
            memberName: nameMap[mid]?.name || ens[0].memberName || '',
            memberPhone: nameMap[mid]?.phone || '',
            leaves, leaveCount: realLeaves.length, leaveCap: cap,
            makeupAvailable: avail.length, makeupUsed: used.length, makeupTotal: avail.length + used.length,
            makeupExpiresAt: expiresAt ? new Date(expiresAt.getTime() + 8 * 3600000).toISOString().slice(0, 10) : null,
            bookedMakeups,
          };
        }).filter(Boolean).sort((a, b) => a.memberName.localeCompare(b.memberName, 'zh-Hant'));
        const pendingClaims = pcByCourse[c.id] || [];
        if (rows.length || pendingClaims.length) {
          groups.push({
            course: {
              id: c.id, name: c.name, gymId: c.gymId || null,
              maxLeaves: rules.maxLeaves,
              makeupDeadline: c.makeupDeadlineDate || (c.endDate ? require('dayjs')(c.endDate).add(rules.makeupDeadlineDays, 'day').format('YYYY-MM-DD') : null),
            },
            rows, pendingClaims,
          });
        }
      }
      groups.sort((a, b) => (a.course.name || '').localeCompare(b.course.name || '', 'zh-Hant'));
      // 待安排跨期補課（pending_arrange，尚未排到場次、無歸屬課程）→ 頂層總覽，含前期請假日
      // 跨期補課獨立一區：以原班級(前一梯)為主排序，後接補課班級+日期；未排定＝待安排
      const crossMakeups = xmActive.map(x => ({
        name: x.name, sourceCourse: x.courseName || '',
        leaveDates: (x.owedDates || []).map(d => `${d}（前期）`),
        targetCourse: x.targetSessionId ? (xmSessName[x.targetSessionId] || '') : '',
        targetDate: x.targetDate || null,
        deadline: x.deadline || null,   // 前期補課期限（一次性設定）
        status: x.status || 'pending_arrange',   // pending_arrange | booked | done（已結案仍列出供查核）
        doneAt: x.doneAt ? (x.doneAt.toDate ? x.doneAt.toDate().toISOString().slice(0, 10) : String(x.doneAt).slice(0, 10)) : null,
      })).sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.sourceCourse || '').localeCompare(b.sourceCourse || '', 'zh-Hant') || (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
      // 近三個月逾期未補課：補課券 available（未用）但已過期、到期日在近 90 天內
      const d90 = require('dayjs')(today).subtract(90, 'day').format('YYYY-MM-DD');
      const overdueRights = mkSnap.docs.map(d => d.data())
        .filter(r => courseIds.has(r.courseId) && r.status === 'available' && r.expiresAt)
        .map(r => ({ ...r, expDate: r.expiresAt.toDate ? new Date(r.expiresAt.toDate().getTime() + 8 * 3600000).toISOString().slice(0, 10) : String(r.expiresAt).slice(0, 10) }))
        .filter(r => r.expDate < today && r.expDate >= d90);
      const odMissing = [...new Set(overdueRights.map(r => r.memberId))].filter(id => !nameMap[id]);
      for (let i = 0; i < odMissing.length; i += 20) {
        const refs = odMissing.slice(i, i + 20).map(id => db.collection(COLLECTIONS.MEMBERS).doc(id));
        (await db.getAll(...refs)).forEach(doc => { if (doc.exists) nameMap[doc.id] = { name: doc.data().name, phone: doc.data().phone }; });
      }
      const overdueMakeups = overdueRights
        .map(r => ({ memberName: nameMap[r.memberId]?.name || '', courseName: r.courseName || '', expiredDate: r.expDate }))
        .sort((a, b) => (a.expiredDate || '').localeCompare(b.expiredDate || ''));

      // 歷史請假匯入（如舊 BeClass 表單資料）：對不到系統現有場次、不發補課券，純記錄供查——
      // 獨立一區、附在最後面，依姓名排序。已比對到會員標 memberId；查無會員只顯示姓名/電話。
      const hlQuery = gymId ? db.collection('historicalLeaveRecords').where('gymId', '==', gymId) : db.collection('historicalLeaveRecords');
      const hlSnap = await hlQuery.get();
      const hlByPerson = {};
      hlSnap.docs.forEach(d => {
        const x = d.data();
        const key = x.memberId || `u:${x.name}:${x.phone || ''}`;
        if (!hlByPerson[key]) hlByPerson[key] = { memberId: x.memberId || null, name: x.name, phone: x.phone || '', registered: !!x.memberId, records: [] };
        hlByPerson[key].records.push({ date: x.leaveDate, courseType: x.courseType || '', weekday: x.weekday || '', reason: x.reason || '' });
      });
      const historicalLeaves = Object.values(hlByPerson)
        .map(p => ({ ...p, records: p.records.sort((a, b) => (a.date || '').localeCompare(b.date || '')) }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));

      res.json({ groups, crossMakeups, overdueMakeups, historicalLeaves });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// GET /courses/:courseId/leave-makeup-summary - 單一課程請假補課總表
router.get('/:courseId/leave-makeup-summary',
  authenticate, checkPermission('courses.view'),
  async (req, res) => {
    try {
      const db = getDb();
      const result = await buildLeaveMakeupSummary(db, req.params.courseId, null);
      if (!result) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json(result);
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

router.get('/:courseId/enrollments',
  authenticate, checkPermission('courses.view'),
  async (req, res) => {
    try {
      const db = getDb();
      const { courseId } = req.params;
      // ⚠️ .select() 排除內嵌簽名圖等大欄位——此為「課程管理→報名名單」核心查詢，courses.view 權限
      // 開放全體員工、呼叫頻率高，2026-08-19 查獲是流量異常最大宗來源之一（見 getCourses 同型註解）。
      const snap = await db.collection('courseEnrollments')
        .where('courseId', '==', courseId)
        .select('memberId', 'memberName', 'status', 'isMakeup', 'isTrial', 'waitlistPosition',
          'maxLeavesAllowed', 'enrolledAt', 'createdAt', 'depositAmount',
          'depositCollectedAdjDone', 'depositResolved', 'depositResolution')
        .get();
      // 課程層名單＝「常態學員」：confirmed/leave + 候補(waitlist)、排除已取消與補課/試上（單堂行為在場次名單看）
      // —— confirmed/leave 與課程列表人數（3.72.0）同口徑；候補另外附上供名單顯示，不計入正取人數
      const rosterDocs = snap.docs.filter(d => {
        const e = d.data();
        return ['confirmed', 'leave', 'waitlist'].includes(e.status) && !e.isMakeup && !e.isTrial;
      });
      // 姓名/電話以 members 集合權威補齊（enrollment 未存 memberPhone；比照 getSessionRoster）
      const memberIds = [...new Set(rosterDocs.map(d => d.data().memberId).filter(Boolean))];
      const memberInfoMap = {};
      if (memberIds.length) {
        const refs = memberIds.map(id => db.collection('members').doc(id));
        const docs = await db.getAll(...refs);
        docs.forEach(doc => { if (doc.exists) { const m = doc.data(); memberInfoMap[doc.id] = { name: m.name, phone: m.phone }; } });
      }
      // 報名 header（courseRegistrations，一人一課一筆）：權威來源——經查證真實資料，courseEnrollments
      // 每堂場次副本的 fee/paymentMethod/bankLastFive/paymentDate 並非每筆都可靠填寫（週課常見全 0/null），
      // 實際應繳總額/付款資訊以 header 為準（與 members.js buildCourseMemberList 同一套權威來源，
      // 見 members.js:361-376）；header 缺（少數無 header 的舊資料）才退回場次副本值。
      const headerMap = {};
      if (memberIds.length) {
        for (let i = 0; i < memberIds.length; i += 30) {
          const batch = memberIds.slice(i, i + 30);
          const hSnap = await db.collection('courseRegistrations')
            .where('courseId', '==', courseId).where('memberId', 'in', batch)
            // header 內嵌簽名圖，只取名單顯示欄位（2026-08-27 補投影，與下方 headerMap 取用欄位一一對應）
            .select('memberId', 'paymentStatus', 'receivedAmountOverride', 'payEnrollmentId', 'fee', 'paymentMethod',
              'bankLastFive', 'paymentDate', 'memberPaidAmount', 'enrolledAt', 'enrollNote', 'healthNote', 'referralSource', 'staffNote',
              'contactPhone', 'isGuest')
            .get();
          hSnap.forEach(hd => {
            const h = hd.data();
            headerMap[h.memberId] = {
              paymentStatus: h.paymentStatus || '', receivedAmountOverride: h.receivedAmountOverride ?? null, payEnrollmentId: h.payEnrollmentId || null,
              fee: h.fee, paymentMethod: h.paymentMethod, bankLastFive: h.bankLastFive, paymentDate: h.paymentDate,
              memberPaidAmount: h.memberPaidAmount, enrolledAt: h.enrolledAt,
              enrollNote: h.enrollNote, healthNote: h.healthNote, referralSource: h.referralSource, staffNote: h.staffNote,
              // 免登入公開報名（guest_ 開頭假 memberId，members 集合查無此人）：電話存在報名當下填的
              // contactPhone——供下方電話補齊 fallback 用（2026-09-03 查獲：公開報名學員名單缺電話）。
              contactPhone: h.contactPhone || '', isGuest: h.isGuest === true,
            };
          });
        }
      }
      // 店員核對收款金額（transferRecords.confirmedAmount）＋匯款證明（末五碼/銀行/日期，比照 members.js
      // attachReceivedAmounts 同一套邏輯）——header 的 bankLastFive/paymentDate 只在 enroll-all 報名當下
      // 直接填寫轉帳資訊時才有值，會員走 /transfers/upload 提交（含退回重補）從未同步回 header，
      // 故一律改從 transferRecords 撈「最新一筆」（不限 confirmed）蓋過 header/場次副本的值。
      const payEnrollmentIds = [...new Set(Object.values(headerMap).map(h => h.payEnrollmentId).filter(Boolean))];
      const confirmedMap = {};
      const proofMap = {}; // payEnrollmentId -> {bankLastFive, bankName, paymentDate, at}
      for (let i = 0; i < payEnrollmentIds.length; i += 30) {
        const chunk = payEnrollmentIds.slice(i, i + 30);
        const tSnap = await db.collection('transferRecords').where('refId', 'in', chunk).get();
        tSnap.docs.forEach(td => {
          const t = td.data();
          if (t.status === 'confirmed' && t.confirmedAmount != null) {
            const at = t.confirmedAt?._seconds || t.confirmedAt?.seconds || 0;
            const prev = confirmedMap[t.refId];
            if (!prev || at >= prev.at) confirmedMap[t.refId] = { amount: Number(t.confirmedAmount), at };
          }
          if (t.bankLastFive || t.paymentDate) {
            const at2 = t.submittedAt?._seconds || t.submittedAt?.seconds || t.createdAt?._seconds || t.createdAt?.seconds || 0;
            const prev2 = proofMap[t.refId];
            if (!prev2 || at2 >= prev2.at) proofMap[t.refId] = { bankLastFive: t.bankLastFive || '', bankName: t.bankName || '', paymentDate: t.paymentDate || '', at: at2 };
          }
        });
      }
      // 依會員聚合（一人一列，取代原本「一場次一列＋前端 byMember 去重」——週課一位學員原本會回傳
      // N 筆幾乎重複的列，只有 count/leaveUsed/waitlistPosition 這幾個「本質上是逐場次聚合」的欄位
      // 需要真的掃過 rosterDocs；其餘報名層級欄位一律只取 header/transferRecords，不再逐場次挑值）。
      const byMember = new Map();
      rosterDocs.forEach(d => {
        const e = d.data();
        if (!e.memberId) return;
        const m = byMember.get(e.memberId) || {
          memberId: e.memberId, memberName: e.memberName || '',
          count: 0, leaveUsed: 0, isWaitlist: false, waitlistPosition: null, maxLeavesAllowed: null,
          fallbackEnrolledAt: null,
          // 保證金（僅工作坊有意義；工作坊一人一筆 enrollment，第一筆即唯一一筆，first-wins 天然正確）
          enrollmentId: null, depositAmount: 0, depositCollectedAdjDone: false, depositResolved: false, depositResolution: null,
        };
        m.count++;
        if (e.status === 'waitlist') { m.isWaitlist = true; if (e.waitlistPosition != null) m.waitlistPosition = e.waitlistPosition; }
        if (e.status === 'leave') m.leaveUsed++;
        if (e.maxLeavesAllowed != null) m.maxLeavesAllowed = e.maxLeavesAllowed;
        if (!m.fallbackEnrolledAt && (e.enrolledAt || e.createdAt)) m.fallbackEnrolledAt = e.enrolledAt || e.createdAt;
        if (!m.enrollmentId) {
          m.enrollmentId = d.id;
          m.depositAmount = Number(e.depositAmount) || 0;
          m.depositCollectedAdjDone = !!e.depositCollectedAdjDone;
          m.depositResolved = !!e.depositResolved;
          m.depositResolution = e.depositResolution || null;
        }
        byMember.set(e.memberId, m);
      });

      const enrollments = [...byMember.values()].map(m => {
        const info = memberInfoMap[m.memberId] || {};
        const header = headerMap[m.memberId] || {};
        const confirmedAmount = header.payEnrollmentId && confirmedMap[header.payEnrollmentId] != null
          ? confirmedMap[header.payEnrollmentId].amount : null;
        const proof = header.payEnrollmentId ? proofMap[header.payEnrollmentId] : null;
        const paymentMethod = header.paymentMethod || '';
        const bankLastFive = proof?.bankLastFive || header.bankLastFive || '';
        const bankName = proof?.bankName || '';
        const paymentDate = proof?.paymentDate || header.paymentDate || '';
        const memberPaidAmount = header.memberPaidAmount ?? null;
        const fee = header.fee ?? 0;
        // 「實收金額」最終採用值：管理員直接編修 > 店員核對 > 會員自報 > 報名應繳費用（與 members.js attachReceivedAmounts 同一套優先序）
        const receivedAmount = header.receivedAmountOverride ?? confirmedAmount ?? memberPaidAmount ?? fee ?? 0;
        return {
          memberId: m.memberId,
          memberName: info.name || m.memberName || '',
          memberPhone: info.phone || header.contactPhone || '',
          isWaitlist: m.isWaitlist,
          waitlistPosition: m.waitlistPosition,
          count: m.count,           // 此人這門課有幾筆場次報名（含請假），供前端顯示「N 堂」
          leaveUsed: m.leaveUsed,   // 已請假堂數
          maxLeavesAllowed: m.maxLeavesAllowed,  // 插班個別可請假次數（null=用課程整期預設）
          paymentMethod,
          paymentStatus: header.paymentStatus || '',
          memberPaidAmount,
          confirmedAmount,
          receivedAmountOverride: header.receivedAmountOverride ?? null,
          receivedAmount,
          bankLastFive,
          bankName,
          paymentDate,
          enrolledAt: header.enrolledAt || m.fallbackEnrolledAt || null,
          fee,
          // 報名備註：一律讀 header（單一真相；idx0-only 寫入後場次副本不再可靠，見 courseService.js getSessionRoster 的同型 fallback）
          enrollNote: header.enrollNote || null,
          healthNote: header.healthNote || null,
          referralSource: header.referralSource || null,
          staffNote: header.staffNote || null,   // 管理員收款確認時填的備註
          // 工作坊保證金（週課恆為 0/false，前端只在 course.type==='workshop' 時顯示）
          enrollmentId: m.enrollmentId,
          depositAmount: m.depositAmount, depositCollectedAdjDone: m.depositCollectedAdjDone,
          depositResolved: m.depositResolved, depositResolution: m.depositResolution,
        };
      });
      // 依報名時間排序（越後面越新；原註解誤寫 desc，實際比較式為 asc，修正註解與行為一致）
      enrollments.sort((a, b) => {
        const ta = a.enrolledAt?._seconds || 0;
        const tb = b.enrolledAt?._seconds || 0;
        return ta - tb;
      });
      res.json({ enrollments, total: enrollments.length });
    } catch(err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// PUT /courses/:courseId/members/:memberId/max-leaves - 管理員為（插班）學員個別填寫可請假次數
// 整期＝課程 maxLeaves（課程設定）；此端點覆蓋單一學員（套用到該員此課所有報名場次）
router.put('/:courseId/members/:memberId/max-leaves',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const { courseId, memberId } = req.params;
      const courseSnap = await db.collection('courses').doc(courseId).get();
      if (courseSnap.exists && courseSnap.data().type === 'workshop') {
        return res.status(400).json({ error: 'WORKSHOP_NO_LEAVE', message: '工作坊活動不提供請假功能' });
      }
      const raw = req.body.maxLeavesAllowed;
      // 傳 null/空 = 清除覆蓋（回到課程整期預設）
      const value = (raw === null || raw === '' || raw === undefined) ? null : parseInt(raw, 10);
      if (value !== null && (isNaN(value) || value < 0)) {
        return res.status(400).json({ error: 'INVALID_VALUE', message: '可請假次數需為 0 或正整數' });
      }
      const snap = await db.collection('courseEnrollments')
        .where('courseId', '==', courseId).where('memberId', '==', memberId).select().get(); // key-only：只要 ref 供批次更新
      if (snap.empty) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此學員報名' });
      const now = new Date();
      const batch = db.batch();
      snap.docs.forEach(d => batch.update(d.ref, { maxLeavesAllowed: value, updatedAt: now }));
      await batch.commit();
      res.json({ success: true, maxLeavesAllowed: value, updated: snap.size, message: value === null ? '已清除，回到課程整期預設' : `已設定可請假 ${value} 次` });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// POST /courses/:courseId/cancel-waitlist - 會員取消自己的候補（僅 waitlist 狀態、未收費）
router.post('/:courseId/cancel-waitlist', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const courseId = req.params.courseId;
    const memberId = req.body.memberId || req.member?.id;
    if (!memberId) return res.status(400).json({ error: 'MISSING_MEMBER' });
    // 只能取消自己或子會員的候補
    const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 403 });
    if (deny) return res.status(deny.status).json(deny.body);

    const snap = await db.collection('courseEnrollments')
      .where('courseId', '==', courseId)
      .where('memberId', '==', memberId)
      .where('status', '==', 'waitlist')
      .select('sessionId')
      .get();
    if (snap.empty) return res.status(404).json({ error: 'NO_WAITLIST', message: '查無候補紀錄' });

    const now = new Date();
    const batch = db.batch();
    const sessionIds = [];
    snap.forEach(d => {
      batch.update(d.ref, { status: 'cancelled', cancelledAt: now, updatedAt: now });
      if (d.data().sessionId) sessionIds.push(d.data().sessionId);
    });
    // 場次候補數 -1
    for (const sid of sessionIds) {
      const sref = db.collection('courseSessions').doc(sid);
      const sdoc = await sref.get();
      if (sdoc.exists) batch.update(sref, { waitlistCount: Math.max(0, (sdoc.data().waitlistCount || 0) - 1), updatedAt: now });
    }
    await batch.commit();
    res.json({ success: true, cancelled: snap.size, message: '已取消候補' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /courses/:courseId/enroll-all - 報名整個週課（自動加入所有場次）
// 週課整期報名核心邏輯：登入會員路徑（authenticateAny）與訪客公開路徑（POST /public/:courseId/enroll-all）共用同一份，
// 差異只在 req.body 於呼叫前是否已被公開路由預先塞入 memberId=guest_<uuid>／memberName／_isGuestEnroll 等旗標——
// memberId/memberName/paymentMethod 的解析本就優先讀 req.body，訪客路由只要在呼叫前寫好 req.body 即可共用，
// 不需要另外複製一份費用/名額/候補計算（避免重蹈本檔案已知的「同段邏輯平行複製、日後漏同步」教訓）。
async function handleEnrollAll(req, res) {
    try {
      const db = getDb();
      const courseId = req.params.courseId;
      const memberId = req.body.memberId || req.member?.id;
      const gymId = req.body.gymId || req.staff?.gymId || null;
      const paymentMethod = req.body.paymentMethod || 'cash';
      const isGuestEnroll = !!req.body._isGuestEnroll;

      if (!memberId) return res.status(400).json({ error: 'MISSING_MEMBER' });

      if (isGuestEnroll) {
        // 訪客：未滿 4 歲擋（無會員文件可讀，用送出的生日直接判）；未成年（<18）一律要求本人+法定代理人皆已線上簽名
        if (isUnder4(req.body._guestBirthday)) return res.status(400).json({ code: 'AGE_UNDER_5', message: '未滿 4 歲無法報名課程' });
        if (!req.body.portraitSignature) return res.status(400).json({ code: 'CONSENT_REQUIRED', message: '請先完成簽名' });
        if (isMinor(req.body._guestBirthday) && !req.body.guardianSignature) return res.status(400).json({ code: 'GUARDIAN_SIGNATURE_REQUIRED', message: '未滿 18 歲需法定代理人簽名' });
      } else {
        // 會員只能為自己或子會員整期報名（防帶他人 memberId；查無會員視為無權）
        const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 403 });
        if (deny) return res.status(deny.status).json(deny.body);
      }
      // 後端權威：未滿 4 歲無法報名課程（實際上課者＝memberId，家長代子時已解析為子會員；訪客無會員文件、上面已另外擋過）
      const _attendee = isGuestEnroll ? null : await memberService.getMember(memberId).catch(() => null);
      if (isUnder4(_attendee)) return res.status(400).json({ code: 'AGE_UNDER_5', message: '未滿 4 歲無法報名課程' });
      // 🧪 模擬報名：短路，不建真實報名（不佔名額）
      if (_attendee?.isSimulation) return res.json(await require('../services/simulationService').handleSimulatedRegistration(db, { type: 'course', member: _attendee, targetId: courseId, payload: req.body }));

      // 取得課程所有未取消場次
      const sessionsSnap = await db.collection('courseSessions')
        .where('courseId', '==', courseId)
        .where('status', '==', 'scheduled')
        .get();

      const today = taiwanToday(); // 台灣日期
      const futureSessions = sessionsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date));

      if (futureSessions.length === 0) {
        return res.status(400).json({ error: 'NO_SESSIONS', message: '此課程已無未來場次' });
      }

      const courseDoc = await db.collection('courses').doc(courseId).get();
      const course = courseDoc.data();
      // 供青少年年齡防呆＋專班課程排除隊員/續報優惠共用（後者不限會員自助，店員代報同樣排除）
      const category = await courseService.getCategoryOf(db, course.categoryId);

      // 防呆：小蜘蛛人／青少年（班別大類 group==='youth'）限未滿18歲報名——避免家長忘記選子女、
      // 用自己身分報名這類課程（僅擋會員自助/訪客；店員代辦不受限，見 !req.staff 用法同上方開放日 gate）。
      if (!req.staff && category?.group === 'youth') {
        const birthdayForCheck = isGuestEnroll ? req.body._guestBirthday : _attendee;
        if (!isMinor(birthdayForCheck)) {
          return res.status(400).json({ code: 'YOUTH_COURSE_AGE_LIMIT', message: '此課程限未滿 18 歲學員報名，請確認報名對象是否正確選擇子女／生日是否填寫正確' });
        }
      }

      const { v4: uuidv4 } = require('uuid');
      const { FieldValue } = require('firebase-admin').firestore;
      const now = new Date();
      const maxStudents = course.maxStudents || Infinity;

      // ── 舊生/續報狀態（後端權威，courseService 單一實作；gate 與續報優惠共用）──
      const alumni = await courseService.computeAlumniStatus(db, course, courseId, memberId);

      // ── 報名開放日 gate（後端權威；員工代報不受限）──
      // 公開開放日前：僅舊生（isCurrent 或 isPrev）可報；舊生開放日前全擋。兩欄皆空＝隨時開放。
      if (!req.staff && course.enrollOpenDate && today < course.enrollOpenDate) {
        const alumniOk = course.alumniOpenDate && today >= course.alumniOpenDate && alumni.isAlumni;
        if (!alumniOk) {
          const msg = course.alumniOpenDate && today < course.alumniOpenDate
            ? `此課程 ${course.alumniOpenDate} 起開放舊生續報、${course.enrollOpenDate} 全面開放報名`
            : course.alumniOpenDate
              ? `目前為舊生續報期間（${course.enrollOpenDate} 全面開放）；您非本班別舊生，請於開放日後報名`
              : `此課程 ${course.enrollOpenDate} 開放報名`;
          return res.status(400).json({ error: 'ENROLL_NOT_OPEN', message: msg });
        }
      }

      // 後端權威計算費用（不信任前端傳入的金額）：週課單堂價×場次數（插班直接乘剩餘堂數，無加成）、
      // 續報/舊生比率折扣（各自開關，續報優先不疊加）、隊員9折——唯一算式見 courseService.computeWeeklyCourseFee。
      // ── fee 為純讀取、與名額/候補無關 → 置於交易外先算好 ──
      const allActiveSessions = sessionsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const completedCount = allActiveSessions.filter(s => s.date < today).length;
      const totalCount = allActiveSessions.length;

      const { isActiveTeamMember } = require('../services/teamMemberService');
      const { getMember } = require('../services/memberService');
      let isTeam = false;
      try {
        const member = await getMember(memberId);
        isTeam = isActiveTeamMember(member);
      } catch (e) { /* 查無會員不影響報名，視為非隊員 */ }

      const {
        fee, baseFee, renewalDiscount, renewalDiscountType, discountResult,
      } = courseService.computeWeeklyCourseFee(course, { completedCount, totalCount, alumni, isTeam, categoryGroup: category?.group });

      const willInstallment = course.installment?.enabled && req.body.paymentPlan === 'installment' && !req.body.deferPayment;

      // ── 交易：去重 + 名額/候補判定 + 建立報名（原子，杜絕並發雙擊造成重複報名/重複收費）──
      // tx.get(query) 讓 Firestore 對查詢範圍做樂觀鎖：兩並發請求會有一方 abort+retry、
      // 重讀後看到對方寫入的報名 → 去重與候補位次皆正確。場次計數用 FieldValue.increment 避免並發丟失。
      let firstEnrollmentId = null;
      let enrollStatus = 'confirmed';
      let isWaitlist = false;
      let waitlistPosition = null;
      let paymentDeadline = null;
      const allEnrollmentIds = []; // 雙寫用：本次報名建立的全部 courseEnrollments id（供 header 的 sourceEnrollmentIds 稽核比對）
      await db.runTransaction(async (tx) => {
        // 讀取（交易內所有讀取須在寫入之前）
        // 去重：本課程已有 confirmed / waitlist / leave（請假中）報名 → 擋（避免重複報名+重複收費）
        const dupSnap = await tx.get(
          db.collection('courseEnrollments')
            .where('memberId', '==', memberId)
            .where('courseId', '==', courseId)
            .where('status', 'in', ['confirmed', 'waitlist', 'leave'])
        );
        if (!dupSnap.empty) { const e = new Error('您已報名此課程，請勿重複報名'); e.code = 'ALREADY_ENROLLED'; throw e; }

        // 名額 / 候補（以整門課「不重複會員數」為準）：滿 maxStudents → 候補；候補也滿(maxWaitlist；null=不限) → COURSE_FULL
        const courseEnrollSnap = await tx.get(
          db.collection('courseEnrollments')
            .where('courseId', '==', courseId)
            .where('status', 'in', ['confirmed', 'waitlist'])
        );
        const confirmedMembers = new Set(), waitlistMembers = new Set();
        courseEnrollSnap.forEach(d => {
          const e = d.data();
          if (e.isMakeup || e.isTrial) return; // 課程名額以「常態學員」計：補課/試上單堂佔位不佔整期名額
          (e.status === 'waitlist' ? waitlistMembers : confirmedMembers).add(e.memberId);
        });
        const occupied = confirmedMembers.size;
        enrollStatus = 'confirmed';
        if (occupied >= maxStudents) {
          const wcap = (course.maxWaitlist === null || course.maxWaitlist === undefined) ? Infinity : course.maxWaitlist;
          if (waitlistMembers.size >= wcap) { const e = new Error('此課程正取與候補皆已額滿'); e.code = 'COURSE_FULL'; throw e; }
          enrollStatus = 'waitlist';
        }
        isWaitlist = enrollStatus === 'waitlist';
        waitlistPosition = isWaitlist ? waitlistMembers.size + 1 : null;

        // 政策（2026-07-27）：移除轉帳付款自動期限/自動取消機制——曾發生真實有轉帳/已上傳證明的
        // 會員因櫃檯逾 2 天沒點「確認」就被排程自動取消整期報名的誤傷案例。改為一律不設期限，
        // 轉帳/現金皆由管理員在待收款頁人工「確認」或「退回」（沿用既有待收款/退回流程，不受影響）。
        // sweepExpiredCoursePayments 函式與手動觸發端點保留（供極端情況人工補跑），但不再排程自動執行。
        paymentDeadline = null;

        // 寫入
        firstEnrollmentId = null;
        futureSessions.forEach((s, idx) => {
          const enrollmentId = uuidv4();
          if (idx === 0) firstEnrollmentId = enrollmentId;
          allEnrollmentIds.push(enrollmentId);
          tx.set(db.collection('courseEnrollments').doc(enrollmentId), {
            id: enrollmentId,
            memberId,
            // 報名對象姓名：優先用傳入的 targetName（子女報名時＝子女名），否則登入者本人
            memberName: req.body.memberName || req.member?.name || '',
            sessionId: s.id,
            courseId,
            courseName: course.name,
            gymId: s.gymId || gymId,
            date: s.date,
            startTime: s.startTime,
            endTime: s.endTime,
            status: enrollStatus,
            waitlistPosition: isWaitlist ? waitlistPosition : null,
            // 候補不收費（遞補為正取後才收）；正取維持原本第一筆收費、其餘 0
            enrollmentFee: isWaitlist ? 0 : (idx === 0 ? fee : 0),
            renewalDiscount: idx === 0 && renewalDiscount > 0 ? renewalDiscount : null, // 續報折抵（稽核）
            renewalDiscountType: idx === 0 && renewalDiscount > 0 ? renewalDiscountType : null, // full_term_renewal | alumni
            paymentMethod: (isWaitlist || idx !== 0) ? null : paymentMethod,
            paymentStatus: isWaitlist ? 'na' : (idx === 0 ? 'pending' : 'na'),
            // 付款期限只掛在主報名（idx===0）；sweep 依此取消整門課、釋放各場次名額
            paymentDeadline: idx === 0 ? paymentDeadline : null,
            gymAccessStart: s.date,
            gymAccessEnd: require('dayjs')(s.date).add(course.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD'),
            // 報名備註：健康備註/如何得知/自訂備註/性別/年齡——比照 enrollmentFee/paymentMethod 只寫在主報名（idx===0）；
            // 其餘場次的名單/CSV 讀取一律靠 courseRegistrations header 補回（getSessionRoster 已加 header fallback，
            // 課程層報名名單/出缺席CSV/報名名單CSV 三處本就已是 header-first），不再逐堂複製同一份值。
            healthNote: idx === 0 ? (req.body.healthNote || null) : null,
            referralSource: idx === 0 ? (req.body.referralSource || null) : null,
            enrollNote: idx === 0 ? (req.body.enrollNote || null) : null,
            enrollGender: idx === 0 ? (req.body.enrollGender || null) : null,
            enrollAge: idx === 0 ? (req.body.enrollAge != null ? req.body.enrollAge : null) : null,
            // 規則確認打勾／肖像權・法定代理人簽名：全站無任何讀取點需要逐堂複本（僅供稽核），idx0-only。
            confirmedLeavePolicy: idx === 0 ? !!req.body.confirmedLeavePolicy : false,
            confirmedRefundPolicy: idx === 0 ? !!req.body.confirmedRefundPolicy : false,
            portraitSignature: idx === 0 ? (req.body.portraitSignature || null) : null,
            guardianSignature: idx === 0 ? (req.body.guardianSignature || null) : null,
            isGuest: isGuestEnroll,
            contactPhone: isGuestEnroll ? (req.body._guestPhone || null) : null,
            contactEmail: isGuestEnroll ? (req.body._guestEmail || null) : null,
            enrolledBy: memberId,
            enrolledAt: now,
            createdAt: now,
            updatedAt: now,
          });
          tx.update(db.collection('courseSessions').doc(s.id),
            isWaitlist
              ? { waitlistCount: FieldValue.increment(1), updatedAt: now }
              : { enrolledCount: FieldValue.increment(1), updatedAt: now });
        });
      });

      // ── 雙寫（Phase 1，課程報名資料模型重構）：與上方 courseEnrollments 平行建立 courseRegistrations header ──
      // 純新增、不讀取、不影響任何既有功能；失敗只記 log、絕不阻斷報名本身。
      try {
        const { createRegistrationHeader } = require('../services/courseRegistrationService');
        await createRegistrationHeader(db, {
          memberId, memberName: req.body.memberName || req.member?.name || '',
          courseId, courseName: course.name, gymId: futureSessions[0]?.gymId || gymId,
          status: enrollStatus,
          paymentMethod: isWaitlist ? null : paymentMethod,
          paymentStatus: isWaitlist ? null : 'pending',
          fee: isWaitlist ? 0 : fee, originalFee: baseFee,
          renewalDiscount: renewalDiscount > 0 ? renewalDiscount : null,
          renewalDiscountType: renewalDiscount > 0 ? renewalDiscountType : null,
          teamDiscountApplied: !isWaitlist && discountResult.applied,
          healthNote: req.body.healthNote || null,
          referralSource: req.body.referralSource || null,
          enrollNote: req.body.enrollNote || null,
          enrollGender: req.body.enrollGender || null,
          enrollAge: req.body.enrollAge != null ? req.body.enrollAge : null,
          confirmedLeavePolicy: !!req.body.confirmedLeavePolicy,
          confirmedRefundPolicy: !!req.body.confirmedRefundPolicy,
          portraitSignature: req.body.portraitSignature || null,
          guardianSignature: req.body.guardianSignature || null,
          waitlistPosition: isWaitlist ? waitlistPosition : null,
          paymentDeadline,
          sessionCount: futureSessions.length,
          sourceEnrollmentIds: allEnrollmentIds,
          payEnrollmentId: firstEnrollmentId,
          enrolledBy: memberId,
          isGuest: isGuestEnroll, contactPhone: isGuestEnroll ? (req.body._guestPhone || null) : null,
        });
      } catch (e) { console.error('[雙寫] courseRegistrations header 建立失敗（不影響報名）:', e.message); }

      // 營收認列在最後一堂課（course.endDate；無則用無限練習迄日/最後場次日）
      const courseRecognitionDate = course.endDate
        || course.unlimitedPracticeEnd
        || (futureSessions.length ? futureSessions[futureSessions.length - 1].date : null);
      // 分期：課程有開分期規則且會員選「分期」→ 建立分期計畫（第一期簽約當下收，各期記帳認列最後一堂）
      const useCourseInstallment = !isWaitlist && course.installment?.enabled && req.body.paymentPlan === 'installment' && !req.body.deferPayment;
      let coursePlan = null;
      if (fee > 0 && useCourseInstallment) {
        const installmentService = require('../services/installmentService');
        const today = taiwanToday();
        const periods = installmentService.buildCoursePeriodsFromConfig(course.installment, fee, today, futureSessions.map(s => s.date));
        if (periods) {
          coursePlan = await installmentService.createInstallmentPlan({
            // 家長代子女報名時 req.body.memberName 才是報名對象（子女）本名，req.member?.name 是登入者（家長）——
            // 優先信任明確送出的 memberName，避免顯示成家長名（req.member 對 staff 呼叫恆為 undefined，行為不變）。
            memberId, memberName: req.body.memberName || req.member?.name || '',
            gymId: futureSessions[0].gymId || gymId,
            relatedType: 'course', relatedId: courseId, itemName: course.name,
            recognitionDate: courseRecognitionDate, installments: periods,
            // 員工櫃檯：頭款當下收（自動記帳）；會員自助：第一期留 pending（待轉帳確認後由員工標記）
            firstPaymentMethod: req.member ? null : paymentMethod,
            staffId: req.staff?.id || null, staffName: req.staff?.name || '',
          });
        }
      }
      // 記錄交易（一次付清；分期改由計畫逐期記帳，此處略過；deferPayment 由付款 callback 記）候補不記帳
      if (fee > 0 && !isWaitlist && !req.body.deferPayment && !coursePlan) {
        const { recordTransaction } = require('../utils/revenueLedger');
        await recordTransaction(db, {
          gymId: futureSessions[0].gymId || gymId,
          type: 'course',
          totalAmount: fee,
          paymentMethod,
          memberId,
          memberName: req.body.memberName || req.member?.name || '', // 同上，優先用報名對象本名
          relatedId: courseId,
          notes: `課程報名：${course.name}（整堂課，共${futureSessions.length}場）`,
          staffId: req.staff?.id || null,
          staffName: req.staff?.name || '',
          recognitionDate: courseRecognitionDate,
        });
      }

      // 課程報名一律經「待收款」核對（營收為 accrual、已於上方認列；此為收款確認追蹤）：
      // 現金→值班 operator 確認；轉帳→管理員確認（轉帳的待收款由前端 /transfers/upload 建立，此處只建現金）
      if (fee > 0 && !isWaitlist && !req.body.deferPayment && !coursePlan && paymentMethod === 'cash') {
        try {
          const trId = uuidv4();
          await db.collection('transferRecords').doc(trId).set({
            id: trId, orderType: 'course', refId: firstEnrollmentId,
            memberId, memberName: req.body.memberName || req.member?.name || '', // 同上，優先用報名對象本名
            gymId: futureSessions[0].gymId || gymId,
            courseId, courseName: course.name, orderName: course.name,
            amount: fee, paymentMethod: 'cash', status: 'pending',
            submittedAt: now, createdAt: now, updatedAt: now,
          });
        } catch (e) { console.error('現金待收款建立失敗', e.message); }
      }

      // 報名收到通知信（非候補；非同步、失敗不阻斷；運動按摩不附匯款帳號）
      // 訪客沒有會員文件可查 email，直接帶 to 覆蓋（notifyRegReceived 的 to 優先於用 memberId 查會員 email）
      if (!isWaitlist) {
        const _rn = require('../services/registrationNotify');
        // 分期時通知信「應繳金額」改顯示第一期（簽約當下實收），避免誤導成要一次繳全期總額
        const _instInfo = coursePlan ? { firstAmount: coursePlan.installments[0].amount, totalAmount: coursePlan.totalAmount, totalPeriods: coursePlan.installments.length } : null;
        _rn.notifyRegReceived({
          memberId, memberName: req.body.memberName || req.member?.name || '', // 同上，優先用報名對象本名
          to: isGuestEnroll ? (req.body._guestEmail || null) : undefined,
          typeLabel: course.type === 'workshop' ? '工作坊' : '課程',
          itemName: course.name, gymId: futureSessions[0].gymId || gymId,
          fee: req.body.deferPayment ? 0 : (_instInfo ? _instInfo.firstAmount : fee), paymentMethod,
          massage: _rn.isMassage(course.name),
          sessions: futureSessions.map(s => ({ date: s.date, startTime: s.startTime, endTime: s.endTime })),
          installmentInfo: _instInfo,
        });
      }

      res.status(201).json({
        enrollmentId: firstEnrollmentId,
        installmentPlan: coursePlan,
        isWaitlist,
        waitlistPosition,
        paymentDeadline: paymentDeadline ? paymentDeadline.toISOString() : null,
        message: isWaitlist
          ? `課程正取已額滿，已加入候補名單（第 ${waitlistPosition} 位）；遞補為正取後再行收費`
          : (isTeam && discountResult.discount > 0
            ? `報名成功，已加入 ${futureSessions.length} 個場次（已套用攀岩隊員折扣，折抵 NT$${discountResult.discount}）`
            : `報名成功，已加入 ${futureSessions.length} 個場次`),
        count: futureSessions.length,
        fee: isWaitlist ? 0 : fee,
        originalFee: baseFee,
        teamDiscountApplied: !isWaitlist && discountResult.applied,
        teamDiscountAmount: isWaitlist ? 0 : discountResult.discount,
      });
    } catch (err) {
      if (err && err.code === 'ALREADY_ENROLLED') {
        return res.status(409).json({ error: 'ALREADY_ENROLLED', message: err.message || '您已報名此課程，請勿重複報名' });
      }
      if (err && err.code === 'COURSE_FULL') {
        return res.status(409).json({ error: 'COURSE_FULL', message: err.message || '此課程正取與候補皆已額滿' });
      }
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
}

router.post('/:courseId/enroll-all', authenticateAny, handleEnrollAll);

// ── POST /courses/public/:courseId/enroll-all - 訪客整期報名（免登入，先轉帳）───────────
// 不建帳號（memberId 用不會碰撞的 guest_<uuid> 佔位字串，避免與其他訪客誤判重複報名/名額計算漂移）；
// 一律轉帳、無分期、無舊生/隊員折扣（訪客沒有既有會員關係，這些折扣天生就不會命中，見上方 handleEnrollAll 共用邏輯）；
// 未成年一律要求本人+法定代理人皆線上完成簽名。把 guest 欄位塞進 req.body 後直接委派給共用核心邏輯。
router.post('/public/:courseId/enroll-all', async (req, res) => {
  const { guestName, guestPhone, guestEmail, guestBirthday, bankLastFive, paymentDate } = req.body;
  if (!guestName || !String(guestName).trim()) return res.status(400).json({ code: 'MISSING_CONTACT', message: '請填寫姓名' });
  if (!guestPhone || !String(guestPhone).trim()) return res.status(400).json({ code: 'MISSING_PHONE', message: '請填寫聯絡電話' });
  if (!guestBirthday) return res.status(400).json({ code: 'MISSING_BIRTHDAY', message: '請填寫生日' });
  if (!bankLastFive || !String(bankLastFive).trim()) return res.status(400).json({ code: 'MISSING_TRANSFER', message: '請填寫匯款帳號末五碼' });
  if (!paymentDate || !String(paymentDate).trim()) return res.status(400).json({ code: 'MISSING_PAYMENT_DATE', message: '請填寫轉帳日期' });

  req.body.memberId = `guest_${uuidv4()}`;
  req.body.memberName = String(guestName).trim();
  req.body.paymentMethod = 'transfer';
  req.body._isGuestEnroll = true;
  req.body._guestPhone = String(guestPhone).trim();
  req.body._guestEmail = (guestEmail || '').trim();
  req.body._guestBirthday = guestBirthday;
  delete req.body.paymentPlan; // 訪客不提供分期（沒有既有會員關係）

  return handleEnrollAll(req, res);
});

module.exports = router;

