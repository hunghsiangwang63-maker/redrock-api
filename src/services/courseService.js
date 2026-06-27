/**
 * 課程管理 Service
 *
 * 功能：
 * - 課程 CRUD（含標籤系統）
 * - 場次管理
 * - 報名 / 候補 / 自動遞補
 * - 請假（自動核准 + 補課資格產生）
 * - 補課（同期類似課程 / 下期補課）
 * - 出席簽到
 * - 課程入館權益自動產生
 */
const { getDb, COLLECTIONS } = require('../config/firebase');
const { getMember } = require('./memberService');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const COURSE_COLLECTION     = 'courses';
const SESSION_COLLECTION    = 'courseSessions';
const ENROLLMENT_COLLECTION = 'courseEnrollments';
const ATTENDANCE_COLLECTION = 'courseAttendance';
const MAKEUP_COLLECTION     = 'courseMakeupRights';

// ── 建立課程 ──────────────────────────────────────────────────────
const createCourse = async ({ gymId, staffId, data }) => {
  const db = getDb();
  const id = uuidv4();
  const now = new Date();

  const course = {
    id,
    gymId,
    name: data.name,
    description: data.description || '',
    type: data.type || 'weekly',        // weekly | workshop
    tags: data.tags || [],
    category: data.category || 'general',
    instructor: data.instructor || '',
    categoryId: data.categoryId || null,
    startDate: data.startDate || null,
    endDate: data.endDate || null,
    startTime: data.startTime || null,
    endTime: data.endTime || null,
    maxStudents: data.maxStudents || 12,
    price: data.price || 0,
    totalSessions: data.totalSessions || 0,   // 總堂數（建立後可更新）
    durationMinutes: data.durationMinutes || 90,
    // 入館權益
    gymAccessDaysBefore: data.gymAccessDaysBefore || 0,
    gymAccessDaysAfter: data.gymAccessDaysAfter || 1,
    // 無限練習期間（課程學員身份的有效區間，管理員可手動調整，預設依開課日~最後一堂課+入館緩衝天數計算）
    unlimitedPracticeStart: data.unlimitedPracticeStart || data.startDate || null,
    unlimitedPracticeEnd: data.unlimitedPracticeEnd ||
      (data.endDate ? dayjs(data.endDate).add(data.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD') : null),
    // 退費設定
    perSessionDeduction: data.perSessionDeduction ?? 850, // 開課後每堂扣除金額
    handlingFeeRate: data.handlingFeeRate ?? 0.05,        // 開課前手續費率（預設5%）
    // 暫停規則
    pauseAllowed: data.pauseAllowed !== false,
    // 請假規則
    leaveDeadlineHours: data.leaveDeadlineHours || 2,   // 幾小時前截止請假
    maxLeaves: data.maxLeaves || 2,                      // 整期最多請假次數
    // 補課規則
    allowMakeup: data.allowMakeup !== false,
    makeupDeadlineDays: data.makeupDeadlineDays || 60,  // 課程結束後幾天內補課
    // 上課星期（週課用）0=日 1=一 ... 6=六
    weekdays: data.weekdays || [],
    // 插班加成（剩餘堂數低於一半時）
    midpointSurcharge: data.midpointSurcharge || 1.05,
    // 狀態
    status: 'active',
    createdBy: staffId,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COURSE_COLLECTION).doc(id).set(course);
  return course;
};

// ── 建立課程場次 ──────────────────────────────────────────────────
const createSession = async ({ courseId, gymId, staffId, data }) => {
  const db = getDb();
  const id = uuidv4();
  const now = new Date();

  const courseDoc = await db.collection(COURSE_COLLECTION).doc(courseId).get();
  if (!courseDoc.exists) throw { code: 'COURSE_NOT_FOUND' };
  const course = courseDoc.data();

  const session = {
    id,
    courseId,
    gymId,
    courseName: course.name,
    tags: course.tags,
    date: data.date,
    startTime: data.startTime,
    endTime: data.endTime,
    maxStudents: data.maxStudents || course.maxStudents,
    enrolledCount: 0,
    waitlistCount: 0,
    status: 'scheduled',
    note: data.note || '',
    createdBy: staffId,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(SESSION_COLLECTION).doc(id).set(session);
  return session;
};

// ── 報名課程 ──────────────────────────────────────────────────────


// ── 週課批次建立場次 ──────────────────────────────────────────────
const createWeeklySessions = async ({ courseId, gymId, staffId }) => {
  const db = getDb();
  const courseDoc = await db.collection(COURSE_COLLECTION).doc(courseId).get();
  if (!courseDoc.exists) throw { code: 'COURSE_NOT_FOUND' };
  const course = courseDoc.data();

  if (!course.startDate || !course.endDate || !course.weekdays?.length) {
    throw { code: 'MISSING_COURSE_INFO', message: '課程需設定起訖日期與上課星期' };
  }

  // 先刪除現有場次（無學員的）
  const existingSnap = await db.collection(SESSION_COLLECTION)
    .where('courseId', '==', courseId).get();
  const deleteBatch = db.batch();
  let skipped = 0;
  existingSnap.docs.forEach(doc => {
    if ((doc.data().enrolledCount || 0) === 0) {
      deleteBatch.delete(doc.ref);
    } else {
      skipped++;
    }
  });
  if (existingSnap.size > 0) await deleteBatch.commit();
  if (skipped > 0) console.log(`⚠️ 跳過 ${skipped} 個已有學員的場次`);

  const sessions = [];
  let current = dayjs(course.startDate);
  const end = dayjs(course.endDate);
  const now = new Date();

  while (current.isBefore(end) || current.isSame(end, 'day')) {
    if (course.weekdays.includes(current.day())) {
      const id = uuidv4();
      const session = {
        id,
        courseId,
        gymId: gymId || null,
        courseName: course.name,
        tags: course.tags || [],
        date: current.format('YYYY-MM-DD'),
        startTime: course.startTime || '',
        endTime: course.endTime || '',
        instructor: course.instructor || '',
        maxStudents: course.maxStudents,
        enrolledCount: 0,
        waitlistCount: 0,
        status: 'scheduled',
        createdBy: staffId,
        notes: '',
        createdAt: now,
        updatedAt: now,
      };
      sessions.push(session);
    }
    current = current.add(1, 'day');
  }

  // 分批寫入（每批 400 筆）
  const BATCH_SIZE = 400;
  for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
    const chunk = sessions.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach(s => {
      batch.set(db.collection(SESSION_COLLECTION).doc(s.id), s);
    });
    await batch.commit();
    console.log(`✅ 寫入場次 ${i+1}~${Math.min(i+BATCH_SIZE, sessions.length)}`);
  }

  // 更新課程總堂數
  await db.collection(COURSE_COLLECTION).doc(courseId).update({
    totalSessions: sessions.length,
    updatedAt: now,
  });

  return { sessions, count: sessions.length };
};

// ── 取消/修改單一場次 ─────────────────────────────────────────────
const updateSession = async ({ sessionId, staffId, data }) => {
  const db = getDb();
  const ref = db.collection(SESSION_COLLECTION).doc(sessionId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'SESSION_NOT_FOUND' };

  const updates = { updatedAt: new Date() };
  if (data.status) updates.status = data.status;       // cancelled
  if (data.date) updates.date = data.date;
  if (data.startTime) updates.startTime = data.startTime;
  if (data.endTime) updates.endTime = data.endTime;
  if (data.instructor !== undefined) updates.instructor = data.instructor;
  if (data.notes !== undefined) updates.notes = data.notes;

  await ref.update(updates);
  return { id: sessionId, ...doc.data(), ...updates };
};

// ── 插班費用計算 ──────────────────────────────────────────────────
const calcEnrollmentFee = (course, completedSessions) => {
  const total = course.totalSessions || 1;
  const remaining = Math.max(0, total - completedSessions);
  const ratio = remaining / total;
  const midpoint = course.midpointSurcharge || 1.05;
  const multiplier = ratio >= 0.5 ? 1.0 : midpoint;
  const fee = Math.round(course.price * ratio * multiplier);
  // 分期判斷：超過一個月（4堂以上）分兩期
  const installment = remaining > 4;
  const firstPayment = installment ? Math.ceil(fee / 2) : fee;
  const secondPayment = installment ? fee - firstPayment : 0;
  return { fee, ratio, remaining, total, installment, firstPayment, secondPayment, multiplier };
};

const enrollCourse = async ({ memberId, sessionId, gymId, staffId, paymentId,
  paymentDate, bankLastFive, healthNote, referralSource,
  confirmedLeavePolicy, confirmedRefundPolicy, portraitSignature, guardianSignature,
}) => {
  const db = getDb();

  const member = await getMember(memberId);
  if (member.isBlocked) throw { code: 'MEMBER_BLOCKED', message: '帳號已封鎖，無法報名' };

  const sessionDoc = await db.collection(SESSION_COLLECTION).doc(sessionId).get();
  if (!sessionDoc.exists) throw { code: 'SESSION_NOT_FOUND' };
  const session = sessionDoc.data();

  if (session.status === 'cancelled') throw { code: 'SESSION_CANCELLED', message: '此場次已取消' };

  // 檢查是否已報名
  const existingSnap = await db.collection(ENROLLMENT_COLLECTION)
    .where('memberId', '==', memberId)
    .where('sessionId', '==', sessionId)
    .where('status', 'in', ['confirmed', 'waitlist'])
    .get();
  if (!existingSnap.empty) throw { code: 'ALREADY_ENROLLED', message: '您已報名此場次' };

  const isFull = session.enrolledCount >= session.maxStudents;
  const enrollmentId = uuidv4();
  const now = new Date();

  // 計算入館權益日期
  const courseDoc = await db.collection(COURSE_COLLECTION).doc(session.courseId).get();
  const course = courseDoc.data();
  const gymAccessStart = dayjs(session.date)
    .subtract(course.gymAccessDaysBefore || 0, 'day').format('YYYY-MM-DD');
  const gymAccessEnd = dayjs(session.date)
    .add(course.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD');

  // 計算插班費用
  const completedSessions = await db.collection(SESSION_COLLECTION)
    .where('courseId', '==', session.courseId)
    .where('date', '<', session.date)
    .get().then(s => s.size);
  const feeInfo = calcEnrollmentFee(course, completedSessions);

  const enrollment = {
    id: enrollmentId,
    memberId,
    memberName: member.name,
    sessionId,
    courseId: session.courseId,
    courseName: session.courseName,
    gymId,
    date: session.date,
    startTime: session.startTime,
    endTime: session.endTime,
    status: isFull ? 'waitlist' : 'confirmed',
    waitlistPosition: isFull ? session.waitlistCount + 1 : null,
    paymentId: paymentId || null,
    paymentMethod: paymentId ? null : 'pending',
    // 費用資訊
    originalPrice: course.price,
    enrollmentFee: feeInfo.fee,
    installment: feeInfo.installment,
    firstPayment: feeInfo.firstPayment,
    secondPayment: feeInfo.secondPayment,
    paymentStatus: 'pending',
    gymAccessStart,
    gymAccessEnd,
    enrolledBy: staffId || memberId,
    enrolledAt: now,
    // 報名附加資訊
    paymentDate: paymentDate || null,
    bankLastFive: bankLastFive || null,
    healthNote: healthNote || null,
    referralSource: referralSource || null,
    confirmedLeavePolicy: confirmedLeavePolicy || false,
    confirmedRefundPolicy: confirmedRefundPolicy || false,
    portraitSignature: portraitSignature || null,
    guardianSignature: guardianSignature || null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).set(enrollment);

  // 更新場次人數
  const updateData = isFull
    ? { waitlistCount: session.waitlistCount + 1, updatedAt: now }
    : { enrolledCount: session.enrolledCount + 1, updatedAt: now };
  await sessionDoc.ref.update(updateData);

  return {
    enrollment,
    feeInfo,
    isWaitlist: isFull,
    message: isFull
      ? `已加入候補名單（第 ${session.waitlistCount + 1} 位）`
      : `報名成功，應繳 NT$${feeInfo.firstPayment}${feeInfo.installment ? `（共兩期，第二期 NT$${feeInfo.secondPayment}）` : ''}`,
  };
};

// ── 請假 ──────────────────────────────────────────────────────────
const requestLeave = async ({ enrollmentId, memberId, reason }) => {
  const db = getDb();
  const enrollDoc = await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).get();
  if (!enrollDoc.exists) throw { code: 'ENROLLMENT_NOT_FOUND' };

  const enrollment = enrollDoc.data();
  if (enrollment.memberId !== memberId) throw { code: 'FORBIDDEN' };
  if (enrollment.status !== 'confirmed') throw { code: 'INVALID_STATUS', message: '此報名狀態無法請假' };

  const now = new Date();
  const makeupId = uuidv4();

  // 更新報名狀態
  await enrollDoc.ref.update({ status: 'leave', leaveReason: reason || '', leaveAt: now, updatedAt: now });

  // 更新場次人數
  const sessionDoc = await db.collection(SESSION_COLLECTION).doc(enrollment.sessionId).get();
  await sessionDoc.ref.update({
    enrolledCount: Math.max(0, sessionDoc.data().enrolledCount - 1),
    updatedAt: now,
  });

  // 自動產生補課資格（有效期：同期課程結束後 60 天）
  const makeup = {
    id: makeupId,
    memberId,
    originalEnrollmentId: enrollmentId,
    courseId: enrollment.courseId,
    courseName: enrollment.courseName,
    gymId: enrollment.gymId,
    tags: [], // 之後從 course 取
    status: 'available',
    expiresAt: dayjs(enrollment.date).add(60, 'day').toDate(),
    usedSessionId: null,
    usedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(MAKEUP_COLLECTION).doc(makeupId).set(makeup);

  // 自動遞補候補者
  await promoteWaitlist(enrollment.sessionId);

  return { makeup, message: '請假成功，補課資格已產生（60天有效）' };
};

// ── 自動遞補候補 ──────────────────────────────────────────────────
const promoteWaitlist = async (sessionId) => {
  const db = getDb();
  const waitlistSnap = await db.collection(ENROLLMENT_COLLECTION)
    .where('sessionId', '==', sessionId)
    .where('status', '==', 'waitlist')
    .orderBy('waitlistPosition', 'asc')
    .limit(1)
    .get();

  if (waitlistSnap.empty) return null;

  const first = waitlistSnap.docs[0];
  await first.ref.update({
    status: 'confirmed',
    waitlistPosition: null,
    promotedAt: new Date(),
    updatedAt: new Date(),
  });

  const sessionDoc = await db.collection(SESSION_COLLECTION).doc(sessionId).get();
  await sessionDoc.ref.update({
    enrolledCount: sessionDoc.data().enrolledCount + 1,
    waitlistCount: Math.max(0, sessionDoc.data().waitlistCount - 1),
    updatedAt: new Date(),
  });

  // TODO: 發 Email 通知遞補成功
  console.log(`✅ 候補遞補：${first.data().memberName} → confirmed`);
  return first.data();
};

// ── 補課報名 ──────────────────────────────────────────────────────
const enrollMakeup = async ({ makeupId, memberId, targetSessionId }) => {
  const db = getDb();
  const makeupDoc = await db.collection(MAKEUP_COLLECTION).doc(makeupId).get();
  if (!makeupDoc.exists) throw { code: 'MAKEUP_NOT_FOUND' };

  const makeup = makeupDoc.data();
  if (makeup.memberId !== memberId) throw { code: 'FORBIDDEN' };
  if (makeup.status !== 'available') throw { code: 'MAKEUP_USED', message: '補課資格已使用' };
  if (dayjs().isAfter(dayjs(makeup.expiresAt.toDate()))) {
    throw { code: 'MAKEUP_EXPIRED', message: '補課資格已過期' };
  }

  const sessionDoc = await db.collection(SESSION_COLLECTION).doc(targetSessionId).get();
  if (!sessionDoc.exists) throw { code: 'SESSION_NOT_FOUND' };
  const session = sessionDoc.data();

  if (session.enrolledCount >= session.maxStudents) {
    throw { code: 'SESSION_FULL', message: '此場次已額滿' };
  }

  // 驗證同類別同館
  const originalCourseDoc = await db.collection(COURSE_COLLECTION).doc(makeup.courseId).get();
  const targetCourseDoc = await db.collection(COURSE_COLLECTION).doc(session.courseId).get();
  if (originalCourseDoc.exists && targetCourseDoc.exists) {
    const origCourse = originalCourseDoc.data();
    const targetCourse = targetCourseDoc.data();
    if (origCourse.categoryId && targetCourse.categoryId !== origCourse.categoryId) {
      throw { code: 'DIFFERENT_CATEGORY', message: '補課只能選擇相同類別的課程' };
    }
    const origGym = makeup.gymId || origCourse.gymId;
    const targetGym = session.gymId || targetCourse.gymId;
    if (origGym && targetGym && origGym !== targetGym) {
      throw { code: 'DIFFERENT_GYM', message: '補課只能在同一場館進行' };
    }
  }

  const now = new Date();

  // 建立補課報名
  const enrollmentId = uuidv4();
  await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).set({
    id: enrollmentId,
    memberId,
    sessionId: targetSessionId,
    courseId: session.courseId,
    courseName: session.courseName,
    gymId: session.gymId,
    date: session.date,
    startTime: session.startTime,
    endTime: session.endTime,
    status: 'confirmed',
    isMakeup: true,
    makeupId,
    gymAccessStart: session.date,
    gymAccessEnd: dayjs(session.date).add(1, 'day').format('YYYY-MM-DD'),
    enrolledBy: memberId,
    enrolledAt: now,
    createdAt: now,
    updatedAt: now,
  });

  // 更新場次人數
  await sessionDoc.ref.update({ enrolledCount: session.enrolledCount + 1, updatedAt: now });

  // 標記補課資格已使用
  await makeupDoc.ref.update({ status: 'used', usedSessionId: targetSessionId, usedAt: now, updatedAt: now });

  return { message: '補課報名成功' };
};

// ── 出席簽到 ──────────────────────────────────────────────────────
const markAttendance = async ({ sessionId, memberId, staffId, status = 'present' }) => {
  const db = getDb();
  const existing = await db.collection(ATTENDANCE_COLLECTION)
    .where('sessionId', '==', sessionId)
    .where('memberId', '==', memberId)
    .limit(1).get();

  const now = new Date();
  const data = { sessionId, memberId, status, markedBy: staffId, markedAt: now, updatedAt: now };

  if (!existing.empty) {
    await existing.docs[0].ref.update(data);
  } else {
    await db.collection(ATTENDANCE_COLLECTION).doc(uuidv4()).set({ ...data, createdAt: now });
  }

  return { status, message: `出席狀態已更新：${status}` };
};

// ── 查詢場次學員名單 ──────────────────────────────────────────────
const getSessionRoster = async (sessionId) => {
  const db = getDb();
  const snap = await db.collection(ENROLLMENT_COLLECTION)
    .where('sessionId', '==', sessionId)
    .where('status', 'in', ['confirmed', 'waitlist', 'leave'])
    .orderBy('enrolledAt', 'asc')
    .get();

  const attendanceSnap = await db.collection(ATTENDANCE_COLLECTION)
    .where('sessionId', '==', sessionId).get();

  const attendanceMap = {};
  attendanceSnap.docs.forEach(d => { attendanceMap[d.data().memberId] = d.data().status; });

  // 補上會員姓名/電話，方便工作人員端直接顯示完整名單，不需要再額外查會員資料
  const roster = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const memberIds = [...new Set(roster.map(r => r.memberId))];
  const memberInfoMap = {};
  for (const mid of memberIds) {
    try {
      const m = await getMember(mid);
      memberInfoMap[mid] = { name: m.name, phone: m.phone };
    } catch (e) { memberInfoMap[mid] = { name: '（會員資料異常）', phone: '' }; }
  }

  return roster.map(r => ({
    ...r,
    memberName: memberInfoMap[r.memberId]?.name || r.memberName || '',
    memberPhone: memberInfoMap[r.memberId]?.phone || '',
    attendanceStatus: attendanceMap[r.memberId] || 'pending',
  }));
};

// ── 查詢課程列表 ──────────────────────────────────────────────────
// ── 課程狀態標籤（報名中/即將開始/進行中/已滿/已結束/已取消）──────
const computeStatusLabel = (course, enrolledCount) => {
  if (course.status === 'cancelled') return 'cancelled';
  const today = dayjs().format('YYYY-MM-DD');
  if (course.endDate && today > course.endDate) return 'ended';
  if (course.startDate && today >= course.startDate) return 'ongoing';
  if (enrolledCount >= (course.maxStudents || Infinity)) return 'full';
  if (course.startDate && dayjs(course.startDate).diff(dayjs(), 'day') <= 7) return 'starting_soon';
  return 'enrolling';
};

const getCourses = async (gymId) => {
  const db = getDb();
  let ref = db.collection(COURSE_COLLECTION).where('status', 'in', ['active', 'cancelled']);
  if (gymId) ref = ref.where('gymId', '==', gymId);
  ref = ref.orderBy('createdAt', 'desc');
  const snap = await ref.get();
  const courses = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 計算各課程目前報名人數（不重複計算同一會員，weekly課程會有多筆場次報名紀錄）
  const enrollSnap = await db.collection(ENROLLMENT_COLLECTION)
    .where('status', '==', 'confirmed').get();
  const enrolledByCourse = {};
  enrollSnap.docs.forEach(d => {
    const e = d.data();
    if (!enrolledByCourse[e.courseId]) enrolledByCourse[e.courseId] = new Set();
    enrolledByCourse[e.courseId].add(e.memberId);
  });

  return courses.map(c => {
    const enrolledCount = enrolledByCourse[c.id]?.size || 0;
    return { ...c, enrolledCount, statusLabel: computeStatusLabel(c, enrolledCount) };
  });
};

// ── 查詢場次列表 ──────────────────────────────────────────────────
const getSessions = async (gymId, fromDate, toDate) => {
  const db = getDb();
  let ref = db.collection(SESSION_COLLECTION);
  if (gymId) ref = ref.where('gymId', '==', gymId);
  ref = ref
    .where('date', '>=', fromDate || dayjs().format('YYYY-MM-DD'))
    .where('date', '<=', toDate || dayjs().add(30, 'day').format('YYYY-MM-DD'));
  const snap = await ref.get();
  const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sessions.length === 0) return sessions;

  // 批次查詢這批場次的所有報名紀錄，計算每場的報名/請假/補課人數（月曆檢視用）
  const sessionIds = sessions.map(s => s.id);
  const chunks = [];
  for (let i = 0; i < sessionIds.length; i += 30) chunks.push(sessionIds.slice(i, i + 30)); // Firestore 'in' 上限30
  const allEnrollments = [];
  for (const chunk of chunks) {
    const enrollSnap = await db.collection(ENROLLMENT_COLLECTION).where('sessionId', 'in', chunk).get();
    enrollSnap.docs.forEach(d => allEnrollments.push(d.data()));
  }

  const statsBySession = {};
  allEnrollments.forEach(e => {
    if (!statsBySession[e.sessionId]) statsBySession[e.sessionId] = { enrolledCount: 0, leaveCount: 0, makeupCount: 0 };
    if (e.status === 'confirmed' || e.status === 'waitlist') {
      statsBySession[e.sessionId].enrolledCount++;
      if (e.isMakeup) statsBySession[e.sessionId].makeupCount++;
    } else if (e.status === 'leave') {
      statsBySession[e.sessionId].leaveCount++;
    }
  });

  return sessions.map(s => ({
    ...s,
    enrolledCount: statsBySession[s.id]?.enrolledCount || 0,
    leaveCount: statsBySession[s.id]?.leaveCount || 0,
    makeupCount: statsBySession[s.id]?.makeupCount || 0,
  }));
};

// ── 查詢會員報名紀錄 ──────────────────────────────────────────────
const getMemberEnrollments = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(ENROLLMENT_COLLECTION)
    .where('memberId', '==', memberId)
    .orderBy('date', 'desc')
    .get();
  const enrollments = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 補上實際出席狀態（present/absent/pending），讓會員能分辨「已上課」與「尚未到的未來場次」
  const attendanceSnap = await db.collection(ATTENDANCE_COLLECTION)
    .where('memberId', '==', memberId).get();
  const attendanceMap = {};
  attendanceSnap.docs.forEach(d => { attendanceMap[d.data().sessionId] = d.data().status; });

  return enrollments.map(e => ({
    ...e,
    attendanceStatus: attendanceMap[e.sessionId] || null,
  }));
};

// ── 查詢會員補課資格 ──────────────────────────────────────────────
const getMemberMakeupRights = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(MAKEUP_COLLECTION)
    .where('memberId', '==', memberId)
    .where('status', '==', 'available')
    .get();

  const today = dayjs();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(m => today.isBefore(dayjs(m.expiresAt.toDate())))
    .map(m => ({
      ...m,
      expiresAtFormatted: dayjs(m.expiresAt.toDate()).format('YYYY-MM-DD'),
      daysLeft: dayjs(m.expiresAt.toDate()).diff(today, 'day'),
    }));
};

module.exports = {
  createWeeklySessions,
  updateSession,
  createCourse,
  createSession,
  enrollCourse,
  requestLeave,
  promoteWaitlist,
  enrollMakeup,
  markAttendance,
  getSessionRoster,
  getCourses,
  getSessions,
  getMemberEnrollments,
  getMemberMakeupRights,
};
