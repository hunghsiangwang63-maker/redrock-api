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
const { isUnder5 } = require('../utils/age');
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
    body('price').isNumeric().withMessage('請輸入課程費用'),
    body('maxStudents').isInt({ min: 1 }).withMessage('請輸入最大人數'),
    body('maxWaitlist').optional({ checkFalsy: true }).isInt({ min: 0 }).withMessage('候補上限須為 0 以上整數'),
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
// 場次
// ══════════════════════════════════════════════════════

// GET /courses/sessions - 場次列表（可依日期區間）
router.get('/sessions', authenticateAny, async (req, res) => {
  try {
    const gymId = req.query.gymId || req.staff?.gymId;
    let sessions = await courseService.getSessions(gymId, req.query.fromDate || req.query.from, req.query.toDate || req.query.to);
    // 會員端過濾體驗課程場次（不出現在報名/課表；會員自己的體驗另由 /experience-bookings/my 顯示）
    if (req.member) sessions = sessions.filter(s => s.source !== 'experience');
    res.json({ sessions });
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
      // 後端權威：未滿 5 歲無法報名課程（實際上課者＝req.body.memberId，家長代子時已解析為子會員）
      const _attendee = await memberService.getMember(req.body.memberId).catch(() => null);
      if (isUnder5(_attendee)) return res.status(400).json({ code: 'AGE_UNDER_5', message: '未滿 5 歲無法報名課程' });
      const result = await courseService.enrollCourse({
        memberId: req.body.memberId,
        sessionId: req.params.sessionId,
        gymId: req.staff?.gymId || req.body.gymId,
        staffId: req.staff?.id || null,
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
        if (req.body.paymentPlan === 'installment' && !result.isWaitlist && result.feeInfo?.fee > 0) {
          const db2 = getDb();
          const sDoc = await db2.collection('courseSessions').doc(req.params.sessionId).get();
          const c = sDoc.exists ? (await db2.collection(COLLECTIONS.COURSES || 'courses').doc(sDoc.data().courseId).get()).data() : null;
          if (c?.installment?.enabled) {
            const installmentService = require('../services/installmentService');
            const today = taiwanToday();
            const periods = installmentService.buildPeriodsFromConfig(c.installment, result.feeInfo.fee, today);
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

      res.status(result.isWaitlist ? 200 : 201).json({ ...result, deferralRequest, installmentPlan });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

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
        .where('courseId', '==', courseId).where('status', '==', 'confirmed').get();
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

      const label = { present: '出席', absent: '缺席', late: '遲到' };
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const sessCol = (s) => s.date + (s.startTime ? ` ${s.startTime}` : '');
      const rows = [[q('學員姓名'), q('電話'), ...sessions.map(s => q(sessCol(s))), q('出席次數')].join(',')];
      memberIds.forEach(mid => {
        const nm = nameMap[mid] || {};
        let attended = 0;
        const cells = sessions.map(s => {
          const st = attBySession[s.id]?.[mid];
          if (st === 'present' || st === 'late') attended++; // 出席/遲到皆計為出席
          return q(label[st] || '');
        });
        rows.push([q(nm.name), q(nm.phone), ...cells, attended].join(','));
      });

      const csv = '\uFEFF' + rows.join('\n'); // BOM for Excel UTF-8
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="course_attendance_${courseId}.csv"`);
      res.send(csv);
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// 會員查詢自己的報名紀錄
// ══════════════════════════════════════════════════════

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
        const activeSnap = await db.collection('courseEnrollments')
          .where('courseId', '==', courseId)
          .where('status', 'in', ['confirmed', 'leave', 'waitlist'])
          .get();
        if (!activeSnap.empty) {
          return res.status(400).json({ error: 'HAS_ENROLLMENTS', message: `尚有 ${activeSnap.size} 筆有效報名，請先「取消課程」並處理退費後再刪除` });
        }
      }

      // 級聯刪除：場次、所有報名(含已取消)、補課額度、調整申請，最後刪課程本身
      let deleted = 0;
      for (const name of ['courseSessions', 'courseEnrollments', 'courseMakeupRights', 'courseAdjustmentRequests']) {
        const snap = await db.collection(name).where('courseId', '==', courseId).get();
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
        'name', 'cohortName', 'categoryId', 'description', 'imageUrl', 'price', 'maxStudents', 'maxWaitlist', 'reservedSlots', 'reservedSlotsNote', 'instructor',
        'startDate', 'endDate', 'startTime', 'endTime', 'weekdays',
        'leaveDeadlineHours', 'maxLeaves', 'allowMakeup', 'makeupDeadlineDays', 'handlingFeeRate', 'preStartFeeRate',
        'enrollOpenDate', 'alumniOpenDate', 'fullTermRenewalDiscount', 'alumniDiscount', 'renewalDeadline',
        'midpointSurcharge', 'gymAccessDaysAfter', 'gymAccessDaysBefore', 'status',
        'unlimitedPracticeStart', 'unlimitedPracticeEnd',
        'allowTrial', 'trialPrice', 'trialTarget', 'makeupTarget', 'isActive', // isActive：停用/啟用（會員課程總覽隱藏，不通知、不動報名）
      ];
      const updates = { updatedAt: new Date() };
      allowedFields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      // 梯次名稱/班別變更 → 顯示名 name 重組為「班別名 梯次名」
      if (updates.cohortName !== undefined || updates.categoryId !== undefined) {
        const curDoc = await db.collection('courses').doc(req.params.courseId).get();
        const cur = curDoc.exists ? curDoc.data() : {};
        const cohortName = updates.cohortName ?? cur.cohortName;
        const categoryId = updates.categoryId ?? cur.categoryId;
        if (cohortName && categoryId) {
          const cat = await courseService.getCategoryOf(db, categoryId);
          if (cat?.name) updates.name = `${cat.name} ${cohortName}`;
        }
      }
      // 候補上限：留空('')＝不限候補(null)，否則轉數字
      if (req.body.maxWaitlist !== undefined) {
        updates.maxWaitlist = (req.body.maxWaitlist === '' || req.body.maxWaitlist === null) ? null : Number(req.body.maxWaitlist);
      }
      // 已佔用名額：留空('')＝0
      if (req.body.reservedSlots !== undefined) {
        updates.reservedSlots = (req.body.reservedSlots === '' || req.body.reservedSlots === null) ? 0 : Number(req.body.reservedSlots);
      }
      // 分期規則
      if (req.body.installment !== undefined) {
        const inst = req.body.installment;
        updates.installment = (inst && inst.enabled)
          ? { enabled: true, periods: (inst.periods || []).map(p => ({ percent: Number(p.percent) || 0, dueOffsetDays: Number(p.dueOffsetDays) || 0 })) }
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
      const rules = courseService.resolveRules(course, await courseService.getCategoryOf(db, course.categoryId));
      const today = taiwanToday();

      const enSnap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS).where('courseId', '==', courseId).get();
      const byMember = {};
      enSnap.docs.forEach(d => {
        const e = d.data();
        if (e.isTrial) return; // 試上不列入請假補課
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

      const rows = memberIds.map(mid => {
        const ens = byMember[mid];
        const active = ens.filter(e => ['confirmed', 'leave', 'waitlist'].includes(e.status));
        if (!active.length) return null; // 全取消不列
        const rights = rightsByMember[mid] || [];
        const realLeaves = ens.filter(e => e.status === 'leave').map(e => e.date).filter(Boolean);
        const closureDays = rights.filter(r => r.source === 'closure' && r.closureDate).map(r => r.closureDate); // 停課日（豁免、不計請假數）
        const leaves = [...realLeaves, ...closureDays.map(d => `${d}（停課）`)].sort();
        const cap = ens.find(e => e.maxLeavesAllowed != null)?.maxLeavesAllowed ?? rules.maxLeaves;
        const avail = rights.filter(r => r.status === 'available');
        const used = rights.filter(r => r.status === 'used');
        const expiresAt = avail[0]?.expiresAt?.toDate?.() || null;
        const bookedMakeups = used.map(r => {
          const sx = sessMap[r.usedSessionId];
          return sx ? { date: sx.date, startTime: sx.startTime || '', courseName: sx.courseName || '', taken: !!sx.date && sx.date < today } : null;
        }).filter(Boolean).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
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
          makeupDeadline: course.endDate ? require('dayjs')(course.endDate).add(rules.makeupDeadlineDays, 'day').format('YYYY-MM-DD') : null,
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
        .filter(c => !gymId || c.gymId === gymId);
      const courseIds = new Set(courses.map(c => c.id));

      const enByCourse = {}, mkByCourse = {}, pcByCourse = {};
      enSnap.docs.forEach(d => { const e = d.data(); if (e.isTrial || !courseIds.has(e.courseId)) return; ((enByCourse[e.courseId] = enByCourse[e.courseId] || {})[e.memberId] = (enByCourse[e.courseId][e.memberId] || [])).push(e); });
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

      // 跨期補課（獨立一區）：載入未結案者，解析 booked 的 target session 課名（供顯示補課班級）
      const xmAllSnap = await db.collection('crossCohortMakeups').get();
      const xmActive = xmAllSnap.docs.map(d => d.data())
        .filter(x => x.status !== 'done')
        .filter(x => !gymId || x.gymId === gymId);
      const xmBookSessIds = [...new Set(xmActive.filter(x => x.targetSessionId).map(x => x.targetSessionId))];
      const xmSessName = {};
      for (let i = 0; i < xmBookSessIds.length; i += 20) {
        const refs = xmBookSessIds.slice(i, i + 20).map(id => db.collection('courseSessions').doc(id));
        (await db.getAll(...refs)).forEach(doc => { if (doc.exists) xmSessName[doc.id] = doc.data().courseName || ''; });
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
          const leaves = [...realLeaves, ...closureDays.map(d => `${d}（停課）`)].sort();
          const cap = ens.find(e => e.maxLeavesAllowed != null)?.maxLeavesAllowed ?? rules.maxLeaves;
          const avail = rights.filter(r => r.status === 'available');
          const used = rights.filter(r => r.status === 'used');
          const expiresAt = avail[0]?.expiresAt?.toDate?.() || null;
          const bookedMakeups = used.map(r => {
            const sx = sessMap[r.usedSessionId];
            return sx ? { date: sx.date, startTime: sx.startTime || '', courseName: sx.courseName || '', taken: !!sx.date && sx.date < today } : null;
          }).filter(Boolean).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
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
              makeupDeadline: c.endDate ? require('dayjs')(c.endDate).add(rules.makeupDeadlineDays, 'day').format('YYYY-MM-DD') : null,
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
      })).sort((a, b) => (a.sourceCourse || '').localeCompare(b.sourceCourse || '', 'zh-Hant') || (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
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
      res.json({ groups, crossMakeups, overdueMakeups });
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
      const snap = await db.collection('courseEnrollments')
        .where('courseId', '==', courseId)
        .get();
      // 課程層名單＝「常態學員」：confirmed/leave、排除已取消與補課/試上（單堂行為在場次名單看）
      // —— 與課程列表人數（3.72.0）同口徑；曾轉班者的 cancelled 紀錄不再出現在原班名單
      const rosterDocs = snap.docs.filter(d => {
        const e = d.data();
        return ['confirmed', 'leave'].includes(e.status) && !e.isMakeup && !e.isTrial;
      });
      // 姓名/電話以 members 集合權威補齊（enrollment 未存 memberPhone；比照 getSessionRoster）
      const memberIds = [...new Set(rosterDocs.map(d => d.data().memberId).filter(Boolean))];
      const memberInfoMap = {};
      if (memberIds.length) {
        const refs = memberIds.map(id => db.collection('members').doc(id));
        const docs = await db.getAll(...refs);
        docs.forEach(doc => { if (doc.exists) { const m = doc.data(); memberInfoMap[doc.id] = { name: m.name, phone: m.phone }; } });
      }
      const enrollments = rosterDocs.map(d => {
        const e = d.data();
        const info = memberInfoMap[e.memberId] || {};
        return {
          id: d.id,
          memberId: e.memberId,
          memberName: info.name || e.memberName || '',
          memberPhone: info.phone || e.memberPhone || '',
          status: e.status || 'confirmed',
          paymentMethod: e.paymentMethod || '',
          paymentConfirmed: e.paymentConfirmed !== false,
          memberPaidAmount: e.memberPaidAmount ?? null,
          bankLastFive: e.bankLastFive || '',
          paymentDate: e.paymentDate || '',
          enrolledAt: e.enrolledAt || e.createdAt || null,
          date: e.date || '',
          startTime: e.startTime || '',
          fee: e.fee || 0,
          maxLeavesAllowed: e.maxLeavesAllowed ?? null,  // 插班個別可請假次數（null=用課程整期預設）
        };
      });
      // Sort by enrolledAt desc
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
      const raw = req.body.maxLeavesAllowed;
      // 傳 null/空 = 清除覆蓋（回到課程整期預設）
      const value = (raw === null || raw === '' || raw === undefined) ? null : parseInt(raw, 10);
      if (value !== null && (isNaN(value) || value < 0)) {
        return res.status(400).json({ error: 'INVALID_VALUE', message: '可請假次數需為 0 或正整數' });
      }
      const snap = await db.collection('courseEnrollments')
        .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
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
router.post('/:courseId/enroll-all',
  authenticateAny,
  async (req, res) => {
    try {
      const db = getDb();
      const courseId = req.params.courseId;
      const memberId = req.body.memberId || req.member?.id;
      const gymId = req.body.gymId || req.staff?.gymId || null;
      const paymentMethod = req.body.paymentMethod || 'cash';

      if (!memberId) return res.status(400).json({ error: 'MISSING_MEMBER' });

      // 會員只能為自己或子會員整期報名（防帶他人 memberId；查無會員視為無權）
      const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 403 });
      if (deny) return res.status(deny.status).json(deny.body);
      // 後端權威：未滿 5 歲無法報名課程（實際上課者＝memberId，家長代子時已解析為子會員）
      const _attendee = await memberService.getMember(memberId).catch(() => null);
      if (isUnder5(_attendee)) return res.status(400).json({ code: 'AGE_UNDER_5', message: '未滿 5 歲無法報名課程' });

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
      const { v4: uuidv4 } = require('uuid');
      const { FieldValue } = require('firebase-admin').firestore;
      const now = new Date();
      const maxStudents = course.maxStudents || Infinity;

      // ── 舊生狀態（gate 與續報優惠共用）：同班別任一梯次曾有效報名（confirmed/leave、排除試上/補課）──
      // isCurrent＝該梯次未結束（當期在籍）；isPrev＝已結束（上一期/隔期學員）。
      const _needAlumni = (!req.staff && course.enrollOpenDate && today < course.enrollOpenDate)
        || (course.fullTermRenewalDiscount > 0) || (course.alumniDiscount > 0);
      // isFullTermRenewal＝續報資格（前一期/當期「整期」報名，插班不算）；isAlumni＝舊生（曾報名過或插班生）
      const alumni = { isFullTermRenewal: false, isAlumni: false };
      if (_needAlumni) {
        const myEn = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
          .where('memberId', '==', memberId).get();
        // 依課程彙整：active（confirmed/leave）＋全部堂數（含 cancelled，供「整期」判定——插班生堂數必不足）；排除試上/補課
        const byCourse = {};
        myEn.docs.forEach(d => {
          const e = d.data();
          if (e.isTrial || e.isMakeup) return;
          if (!e.courseId || e.courseId === courseId) return;
          const b = byCourse[e.courseId] || (byCourse[e.courseId] = { active: 0, total: 0 });
          b.total += 1;
          if (['confirmed', 'leave'].includes(e.status)) b.active += 1;
        });
        const otherIds = Object.keys(byCourse).filter(cid2 => byCourse[cid2].active > 0);
        // 「前一期」＝該梯結束日在目標梯開課前 60 天內（涵蓋進行中的當期）；更早期別的整期學員歸舊生
        const dayjs = require('dayjs');
        const prevTermCutoff = dayjs(course.startDate || today).subtract(60, 'day').format('YYYY-MM-DD');
        for (let i = 0; i < otherIds.length; i += 20) {
          const refs = otherIds.slice(i, i + 20).map(id => db.collection('courses').doc(id));
          (await db.getAll(...refs)).forEach(doc => {
            if (!doc.exists) return;
            const c2 = doc.data();
            if (!c2.categoryId || c2.categoryId !== course.categoryId) return;
            alumni.isAlumni = true;
            const fullTerm = !c2.totalSessions || byCourse[doc.id].total >= c2.totalSessions;
            const recent = !c2.endDate || c2.endDate >= prevTermCutoff;
            if (fullTerm && recent) alumni.isFullTermRenewal = true;
          });
        }
      }

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

      // 後端權威計算費用（不信任前端傳入的金額），邏輯與前端顯示一致：
      // 插班報名按剩餘場次比例計收，低於一半加成；隊員身份再套用九折（滿NT$100適用）
      // ── fee 為純讀取、與名額/候補無關 → 置於交易外先算好 ──
      const allActiveSessions = sessionsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const completedCount = allActiveSessions.filter(s => s.date < today).length;
      const totalCount = allActiveSessions.length;
      const isLateJoin = completedCount > 0;
      const remainingCount = totalCount - completedCount;
      const ratio = totalCount > 0 ? remainingCount / totalCount : 1;
      const isBelowHalf = ratio < 0.5;
      const surcharge = course.midpointSurcharge || 1.05;
      const baseFee = isLateJoin
        ? Math.round((course.price || 0) * ratio * (isBelowHalf ? surcharge : 1))
        : (course.price || 0);

      // ── 續報/舊生優惠（NT$ 折抵，後端權威）：續報（前一期整期）優先，其次舊生（曾報名/插班）；不疊加，折後再套隊員9折 ──
      // 期限＝續報截止日 renewalDeadline（含當日，兩種優惠共用）；過期不折。空＝不限期限。
      let renewalDiscount = 0, renewalDiscountType = null;
      const renewalOpen = !course.renewalDeadline || today <= course.renewalDeadline;
      if (renewalOpen && alumni.isFullTermRenewal && (course.fullTermRenewalDiscount > 0)) {
        renewalDiscount = Number(course.fullTermRenewalDiscount); renewalDiscountType = 'full_term_renewal';
      } else if (renewalOpen && alumni.isAlumni && (course.alumniDiscount > 0)) {
        renewalDiscount = Number(course.alumniDiscount); renewalDiscountType = 'alumni';
      }
      const feeAfterRenewal = Math.max(0, baseFee - renewalDiscount);

      const { isActiveTeamMember, applyTeamDiscount } = require('../services/teamMemberService');
      const { getMember } = require('../services/memberService');
      let isTeam = false;
      try {
        const member = await getMember(memberId);
        isTeam = isActiveTeamMember(member);
      } catch (e) { /* 查無會員不影響報名，視為非隊員 */ }
      const discountResult = applyTeamDiscount(feeAfterRenewal, isTeam);
      const fee = discountResult.discounted;
      const willInstallment = course.installment?.enabled && req.body.paymentPlan === 'installment' && !req.body.deferPayment;

      // ── 交易：去重 + 名額/候補判定 + 建立報名（原子，杜絕並發雙擊造成重複報名/重複收費）──
      // tx.get(query) 讓 Firestore 對查詢範圍做樂觀鎖：兩並發請求會有一方 abort+retry、
      // 重讀後看到對方寫入的報名 → 去重與候補位次皆正確。場次計數用 FieldValue.increment 避免並發丟失。
      let firstEnrollmentId = null;
      let enrollStatus = 'confirmed';
      let isWaitlist = false;
      let waitlistPosition = null;
      let paymentDeadline = null;
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
        const occupied = confirmedMembers.size + (course.reservedSlots || 0); // 含外部帶入的已佔用名額
        enrollStatus = 'confirmed';
        if (occupied >= maxStudents) {
          const wcap = (course.maxWaitlist === null || course.maxWaitlist === undefined) ? Infinity : course.maxWaitlist;
          if (waitlistMembers.size >= wcap) { const e = new Error('此課程正取與候補皆已額滿'); e.code = 'COURSE_FULL'; throw e; }
          enrollStatus = 'waitlist';
        }
        isWaitlist = enrollStatus === 'waitlist';
        waitlistPosition = isWaitlist ? waitlistMembers.size + 1 : null;

        // 轉帳付款期限：會員轉帳報名 → 報名時間 +2 天（僅主報名 idx===0、非候補、非分期、fee>0）。
        // 現金於櫃檯即時確認、不設期限。逾期未確認由每日 sweepExpiredCoursePayments 自動取消釋名額。
        const wantsPaymentDeadline = paymentMethod === 'transfer' && !isWaitlist && !req.body.deferPayment && !willInstallment && fee > 0;
        paymentDeadline = wantsPaymentDeadline ? require('dayjs')(now).add(2, 'day').toDate() : null;

        // 寫入
        firstEnrollmentId = null;
        futureSessions.forEach((s, idx) => {
          const enrollmentId = uuidv4();
          if (idx === 0) firstEnrollmentId = enrollmentId;
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
        const periods = installmentService.buildPeriodsFromConfig(course.installment, fee, today);
        if (periods) {
          coursePlan = await installmentService.createInstallmentPlan({
            memberId, memberName: req.member?.name || req.body.memberName || '',
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
          memberName: req.member?.name || req.body.memberName || '',
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
            memberId, memberName: req.member?.name || req.body.memberName || '',
            gymId: futureSessions[0].gymId || gymId,
            courseId, courseName: course.name, orderName: course.name,
            amount: fee, paymentMethod: 'cash', status: 'pending',
            submittedAt: now, createdAt: now, updatedAt: now,
          });
        } catch (e) { console.error('現金待收款建立失敗', e.message); }
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
);

module.exports = router;

