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
const { getDb, COLLECTIONS } = require('../config/firebase');

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
  ],
  validate,
  async (req, res) => {
    try {
      // 館別隔離：非 super_admin 只能在自己館建立課程，不可用 req.body.gymId 覆蓋到他館
      if (req.body.gymId && req.body.gymId !== req.staff.gymId && req.staff.role !== 'super_admin') {
        return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '不可為其他館別建立課程' });
      }
      const course = await courseService.createCourse({
        gymId: req.body.gymId || req.staff.gymId,
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

// GET /courses/sessions/:sessionId/roster - 學員名單
router.get('/sessions/:sessionId/roster',
  authenticate, checkPermission('courses.manage'),
  async (req, res) => {
    try {
      const roster = await courseService.getSessionRoster(req.params.sessionId);
      res.json({ roster, count: roster.length });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

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

// PUT /courses/:courseId - 更新課程
router.put('/:courseId',
  authenticate, checkPermission('courses.manage'), auditLog('course.update'),
  async (req, res) => {
    try {
      const db = getDb();
      const allowedFields = [
        'name', 'description', 'price', 'maxStudents', 'instructor',
        'startDate', 'endDate', 'startTime', 'endTime', 'weekdays',
        'leaveDeadlineHours', 'maxLeaves', 'allowMakeup', 'makeupDeadlineDays',
        'midpointSurcharge', 'gymAccessDaysAfter', 'gymAccessDaysBefore', 'status',
        'unlimitedPracticeStart', 'unlimitedPracticeEnd',
        'allowTrial', 'trialPrice', 'isActive', // isActive：停用/啟用（會員課程總覽隱藏，不通知、不動報名）
      ];
      const updates = { updatedAt: new Date() };
      allowedFields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      // 分期規則
      if (req.body.installment !== undefined) {
        const inst = req.body.installment;
        updates.installment = (inst && inst.enabled)
          ? { enabled: true, periods: (inst.periods || []).map(p => ({ percent: Number(p.percent) || 0, dueOffsetDays: Number(p.dueOffsetDays) || 0 })) }
          : { enabled: false, periods: [] };
      }

      await db.collection('courses').doc(req.params.courseId).update(updates);
      res.json({ message: '課程已更新', updates });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);



// GET /courses/:courseId/enrollments - 取得課程所有報名名單（員工用）
router.get('/:courseId/enrollments',
  authenticate, checkPermission('courses.view'),
  async (req, res) => {
    try {
      const db = getDb();
      const { courseId } = req.params;
      const snap = await db.collection('courseEnrollments')
        .where('courseId', '==', courseId)
        .get();
      const enrollments = snap.docs.map(d => {
        const e = d.data();
        return {
          id: d.id,
          memberId: e.memberId,
          memberName: e.memberName || '',
          memberPhone: e.memberPhone || '',
          status: e.status || 'confirmed',
          paymentMethod: e.paymentMethod || '',
          paymentConfirmed: e.paymentConfirmed !== false,
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

      // 去重防護：此會員已在本課程有 confirmed 報名 → 擋下（避免前端重複送出造成整期重複報名+重複收費）
      const existing = await db.collection('courseEnrollments')
        .where('memberId', '==', memberId)
        .where('courseId', '==', courseId)
        .where('status', '==', 'confirmed')
        .limit(1).get();
      if (!existing.empty) {
        return res.status(409).json({ error: 'ALREADY_ENROLLED', message: '您已報名此課程，請勿重複報名' });
      }

      const courseDoc = await db.collection('courses').doc(courseId).get();
      const course = courseDoc.data();
      const { v4: uuidv4 } = require('uuid');
      const now = new Date();
      const batch = db.batch();

      // 後端權威計算費用（不信任前端傳入的金額），邏輯與前端顯示一致：
      // 插班報名按剩餘場次比例計收，低於一半加成；隊員身份再套用九折（滿NT$100適用）
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

      const { isActiveTeamMember, applyTeamDiscount } = require('../services/teamMemberService');
      const { getMember } = require('../services/memberService');
      let isTeam = false;
      try {
        const member = await getMember(memberId);
        isTeam = isActiveTeamMember(member);
      } catch (e) { /* 查無會員不影響報名，視為非隊員 */ }
      const discountResult = applyTeamDiscount(baseFee, isTeam);
      const fee = discountResult.discounted;

      let firstEnrollmentId = null;
      futureSessions.forEach((s, idx) => {
        const enrollmentId = uuidv4();
        if (idx === 0) firstEnrollmentId = enrollmentId;
        batch.set(db.collection('courseEnrollments').doc(enrollmentId), {
          id: enrollmentId,
          memberId,
          memberName: req.member?.name || req.body.memberName || '',
          sessionId: s.id,
          courseId,
          courseName: course.name,
          gymId: s.gymId || gymId,
          date: s.date,
          startTime: s.startTime,
          endTime: s.endTime,
          status: 'confirmed',
          enrollmentFee: futureSessions.indexOf(s) === 0 ? fee : 0,
          paymentMethod: futureSessions.indexOf(s) === 0 ? paymentMethod : null,
          paymentStatus: futureSessions.indexOf(s) === 0 ? 'pending' : 'na',
          gymAccessStart: s.date,
          gymAccessEnd: require('dayjs')(s.date).add(course.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD'),
          enrolledBy: memberId,
          enrolledAt: now,
          createdAt: now,
          updatedAt: now,
        });
        batch.update(db.collection('courseSessions').doc(s.id), {
          enrolledCount: (s.enrolledCount || 0) + 1,
          updatedAt: now,
        });
      });

      await batch.commit();

      // 營收認列在最後一堂課（course.endDate；無則用無限練習迄日/最後場次日）
      const courseRecognitionDate = course.endDate
        || course.unlimitedPracticeEnd
        || (futureSessions.length ? futureSessions[futureSessions.length - 1].date : null);
      // 分期：課程有開分期規則且會員選「分期」→ 建立分期計畫（第一期簽約當下收，各期記帳認列最後一堂）
      const useCourseInstallment = course.installment?.enabled && req.body.paymentPlan === 'installment' && !req.body.deferPayment;
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
      // 記錄交易（一次付清；分期改由計畫逐期記帳，此處略過；deferPayment 由付款 callback 記）
      if (fee > 0 && !req.body.deferPayment && !coursePlan) {
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

      res.status(201).json({
        enrollmentId: firstEnrollmentId,
        installmentPlan: coursePlan,
        message: isTeam && discountResult.discount > 0
          ? `報名成功，已加入 ${futureSessions.length} 個場次（已套用攀岩隊員折扣，折抵 NT$${discountResult.discount}）`
          : `報名成功，已加入 ${futureSessions.length} 個場次`,
        count: futureSessions.length,
        fee,
        originalFee: baseFee,
        teamDiscountApplied: discountResult.applied,
        teamDiscountAmount: discountResult.discount,
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

module.exports = router;

