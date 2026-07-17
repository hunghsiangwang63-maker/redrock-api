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
const { taiwanToday } = require('../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../config/firebase');
const { getMember } = require('./memberService');
const { createNotification, notifyRoleInGym } = require('./notificationService');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const COURSE_COLLECTION     = 'courses';
const SESSION_COLLECTION    = 'courseSessions';
const ENROLLMENT_COLLECTION = 'courseEnrollments';
const ATTENDANCE_COLLECTION = 'courseAttendance';
const MAKEUP_COLLECTION     = 'courseMakeupRights';
const CATEGORY_COLLECTION   = 'courseCategories';

// ── 班別規則繼承 ─────────────────────────────────────────────────
// 規則存在班別（category）層＝同班別所有梯次共用預設；梯次（course）欄位為 null/undefined＝繼承，
// 有值＝該梯次個別覆寫。所有讀規則的地方一律走 resolveRules，勿直接讀 course 欄位。
const RULE_DEFAULTS = {
  leaveDeadlineHours: 2,       // 上課前 N 小時前須請假
  maxLeaves: 2,                // 整期可請假次數
  allowMakeup: true,           // 開放補課
  makeupDeadlineDays: 60,      // 課程「結束日」後 N 天內補完
  allowTrial: false,           // 開放試上
  trialPrice: 0,               // 試上費
  perSessionDeduction: 850,    // 退費：開課後每堂扣除
  handlingFeeRate: 0.05,       // 退費：開課前手續費率
};
const resolveRules = (course, category) => {
  const pick = (k) => {
    const cv = course?.[k];
    if (cv !== undefined && cv !== null) return cv;
    const gv = category?.[k];
    if (gv !== undefined && gv !== null) return gv;
    return RULE_DEFAULTS[k];
  };
  return Object.fromEntries(Object.keys(RULE_DEFAULTS).map(k => [k, pick(k)]));
};
const getCategoryOf = async (db, categoryId) => {
  if (!categoryId) return null;
  const d = await db.collection(CATEGORY_COLLECTION).doc(categoryId).get();
  return d.exists ? { id: d.id, ...d.data() } : null;
};

// ── 建立課程 ──────────────────────────────────────────────────────
const createCourse = async ({ gymId, staffId, data }) => {
  const db = getDb();
  const id = uuidv4();
  const now = new Date();

  // 梯次名稱：新架構下 name＝「班別名 梯次名」組合（相容：無 cohortName 則沿用 data.name）
  let composedName = data.name;
  let cohortName = data.cohortName || null;
  if (cohortName && data.categoryId) {
    const cat = await getCategoryOf(db, data.categoryId);
    if (cat?.name) composedName = `${cat.name} ${cohortName}`;
  }
  const course = {
    id,
    gymId,
    name: composedName,
    cohortName,                          // 梯次自訂名稱（顯示名 name＝班別名+梯次名）
    description: data.description || '',
    imageUrl: data.imageUrl || '',      // 課程海報（單張，會員卡片＋詳情顯示；走 Storage signed URL）
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
    // 候補上限：留空(''/null/undefined)＝不限候補；0＝不開放候補；正整數＝候補名額
    maxWaitlist: (data.maxWaitlist === '' || data.maxWaitlist === null || data.maxWaitlist === undefined)
      ? null : Number(data.maxWaitlist),
    // 已佔用正取名額（外部帶入，如 BeClass 既有報名）：剩餘＝maxStudents−實報名−reservedSlots
    reservedSlots: data.reservedSlots ? Number(data.reservedSlots) : 0,
    reservedSlotsNote: data.reservedSlotsNote || '',   // 佔用原因說明（誰佔的/來源，員工端顯示）
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
    // 退費設定（null＝繼承班別）
    perSessionDeduction: data.perSessionDeduction ?? null,
    handlingFeeRate: data.handlingFeeRate ?? null,
    // 暫停規則
    pauseAllowed: data.pauseAllowed !== false,
    // 請假規則（null＝繼承班別）
    leaveDeadlineHours: data.leaveDeadlineHours ?? null,
    maxLeaves: data.maxLeaves ?? null,
    // 補課規則（null＝繼承班別；期限＝課程結束日+N天）
    allowMakeup: data.allowMakeup ?? null,
    makeupDeadlineDays: data.makeupDeadlineDays ?? null,
    // 試上規則（null＝繼承班別；試上比照體驗發單日券、不卡墜測）
    allowTrial: data.allowTrial ?? null,
    trialPrice: data.trialPrice ?? null,
    // 上課星期（週課用）0=日 1=一 ... 6=六
    weekdays: data.weekdays || [],
    // 插班加成（剩餘堂數低於一半時）
    midpointSurcharge: data.midpointSurcharge || 1.05,
    // 分期規則（此課程可分期＋各期比例/間隔）：報名時會員可選一次付清或分期
    installment: (data.installment && data.installment.enabled)
      ? { enabled: true, periods: (data.installment.periods || []).map(p => ({ percent: Number(p.percent) || 0, dueOffsetDays: Number(p.dueOffsetDays) || 0 })) }
      : { enabled: false, periods: [] },
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
    gymId: gymId || course.gymId || null, // super_admin 的 staff.gymId 為 null → fallback 課程館別（否則場次被館別過濾隱形，同 1.83.0 generate-sessions 修法）
    courseName: course.name,
    tags: course.tags || [], // 課程無 tags 欄位時 undefined 會讓 Firestore set 直接 throw
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

  // 帶入學員（新增場次時可個別勾選）：為選定會員建立此場次報名
  // 費用 0＋已確認（學員整期費用已繳，加開場次不另計費）；gymAccess 沿用課程無限練習期
  const ids = Array.isArray(data.enrollMemberIds) ? [...new Set(data.enrollMemberIds.filter(Boolean))] : [];
  if (ids.length) {
    const gymAccessStart = course.unlimitedPracticeStart || course.startDate || data.date;
    const gymAccessEnd = course.unlimitedPracticeEnd ||
      (course.endDate ? dayjs(course.endDate).add(course.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD') : data.date);
    const memberDocs = await db.getAll(...ids.map(mid => db.collection('members').doc(mid)));
    const batch = db.batch(); let enrolled = 0;
    for (const mDoc of memberDocs) {
      if (!mDoc.exists) continue;
      const eid = uuidv4();
      batch.set(db.collection(ENROLLMENT_COLLECTION).doc(eid), {
        id: eid, memberId: mDoc.id, memberName: mDoc.data().name || '', sessionId: id,
        courseId, courseName: course.name, gymId: session.gymId,
        date: data.date, startTime: data.startTime, endTime: data.endTime,
        status: 'confirmed', waitlistPosition: null, paymentId: null, paymentMethod: 'added-session',
        originalPrice: 0, enrollmentFee: 0, installment: false, firstPayment: 0, secondPayment: 0,
        paymentStatus: 'confirmed', paymentConfirmed: true, paymentDeadline: null,
        gymAccessStart, gymAccessEnd, enrolledBy: staffId || null, enrolledAt: now,
        notes: '加開場次帶入', createdAt: now, updatedAt: now,
      });
      enrolled++;
    }
    if (enrolled) {
      batch.update(db.collection(SESSION_COLLECTION).doc(id), { enrolledCount: enrolled, updatedAt: now });
      await batch.commit();
      session.enrolledCount = enrolled;
    }
  }
  return session;
};

// ── 報名課程 ──────────────────────────────────────────────────────


// ── 週課批次建立場次 ──────────────────────────────────────────────
// 依新課表掃出目標上課日（0=日…6=六）。
const computeTargetDates = (course) => {
  const dates = [];
  let current = dayjs(course.startDate);
  const end = dayjs(course.endDate);
  while (current.isBefore(end) || current.isSame(end, 'day')) {
    if (course.weekdays.includes(current.day())) dates.push(current.format('YYYY-MM-DD'));
    current = current.add(1, 'day');
  }
  return dates;
};

// 為孤兒場次挑「最接近的新場次日期」：同週優先，其次日數差最小，再以較早日期為先。
const pickNearestDate = (orphanDate, targetDates) => {
  if (!targetDates.length) return null;
  const od = dayjs(orphanDate);
  const sameWeek = targetDates.filter(t => dayjs(t).startOf('week').isSame(od.startOf('week'), 'day'));
  const pool = sameWeek.length ? sameWeek : targetDates;
  let best = null, bestDiff = Infinity;
  for (const t of pool) {
    const diff = Math.abs(dayjs(t).diff(od, 'day'));
    if (diff < bestDiff || (diff === bestDiff && (best === null || t < best))) { best = t; bestDiff = diff; }
  }
  return best;
};

// 一個場次是否「有學員」（confirmed 或 waitlist），有的話不可直接刪除。
const sessionHasStudents = (s) => (s.enrolledCount || 0) > 0 || (s.waitlistCount || 0) > 0;

// 規劃重產：純計算、不寫入。預覽與執行共用，確保兩者一致。
// 回傳：targetDates / createDates(需新建) / keptMatching(留用) / emptyToDelete(可刪)
//        / orphanPlan[{ session, enrollments, members, confirmedCount, waitlistCount,
//                       leaveCount, targetDate, willTransfer, reason }]
const planRegenerate = async ({ db, course, existingSessions }) => {
  const targetDates = computeTargetDates(course);
  const targetSet = new Set(targetDates);

  const emptyToDelete = [];
  const keptMatching = [];
  const orphanSessions = [];
  existingSessions.forEach(s => {
    if (!sessionHasStudents(s)) emptyToDelete.push(s);
    else if (targetSet.has(s.date)) keptMatching.push(s);
    else orphanSessions.push(s);
  });

  // 目標日期已被「留用場次」佔用的，不需新建。
  const coveredDates = new Set(keptMatching.map(s => s.date));
  const createDates = targetDates.filter(d => !coveredDates.has(d));

  // 模擬各目標場次的 confirmed 佔用，逐一規劃孤兒轉移（與執行同序：依日期）。
  const maxStudents = course.maxStudents || 0;
  const targetEnrolled = {}; // date -> 目前 confirmed 數
  targetDates.forEach(d => { targetEnrolled[d] = 0; });
  keptMatching.forEach(s => { targetEnrolled[s.date] = s.enrolledCount || 0; });

  const orphanPlan = [];
  const sortedOrphans = [...orphanSessions].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const s of sortedOrphans) {
    const enrollSnap = await db.collection(ENROLLMENT_COLLECTION)
      .where('sessionId', '==', s.id).get();
    const enrollments = enrollSnap.docs
      .map(d => ({ ref: d.ref, ...d.data() }))
      .filter(e => ['confirmed', 'waitlist', 'leave'].includes(e.status));
    const confirmedCount = enrollments.filter(e => e.status === 'confirmed').length;
    const waitlistCount  = enrollments.filter(e => e.status === 'waitlist').length;
    const leaveCount     = enrollments.filter(e => e.status === 'leave').length;
    const members = enrollments.map(e => e.memberName).filter(Boolean);

    const targetDate = pickNearestDate(s.date, targetDates);
    let willTransfer = false, reason = '';
    if (!targetDate) {
      reason = '新課表無任何場次';
    } else if ((targetEnrolled[targetDate] || 0) + confirmedCount > maxStudents) {
      reason = '最接近場次已額滿，保留原場次';
    } else {
      willTransfer = true;
      targetEnrolled[targetDate] += confirmedCount; // 佔用名額，供後續孤兒判斷
    }

    orphanPlan.push({
      session: s, enrollments, members,
      confirmedCount, waitlistCount, leaveCount,
      targetDate, willTransfer, reason,
    });
  }

  return { targetDates, createDates, keptMatching, emptyToDelete, orphanPlan, targetEnrolled };
};

const buildSession = (course, courseId, gymId, staffId, date, now) => ({
  id: uuidv4(),
  courseId,
  gymId: gymId || null,
  courseName: course.name,
  tags: course.tags || [],
  date,
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
});

// 把孤兒清單整理成前端要的簡潔格式。
const orphanSummary = (orphanPlan) => orphanPlan.map(o => ({
  sessionId: o.session.id,
  date: o.session.date,
  startTime: o.session.startTime,
  endTime: o.session.endTime,
  confirmedCount: o.confirmedCount,
  waitlistCount: o.waitlistCount,
  leaveCount: o.leaveCount,
  members: o.members,
  targetDate: o.targetDate,
  willTransfer: o.willTransfer,
  reason: o.reason,
}));

const createWeeklySessions = async ({ courseId, gymId, staffId, confirm = false }) => {
  const db = getDb();
  const courseDoc = await db.collection(COURSE_COLLECTION).doc(courseId).get();
  if (!courseDoc.exists) throw { code: 'COURSE_NOT_FOUND' };
  const course = courseDoc.data();
  // 場次館別回退到課程館別：super_admin 建課時 req.staff.gymId 為 null，若不回退則場次 gymId=null → 月曆(依館別過濾)看不到
  gymId = gymId || course.gymId || null;

  if (!course.startDate || !course.endDate || !course.weekdays?.length) {
    throw { code: 'MISSING_COURSE_INFO', message: '課程需設定起訖日期與上課星期' };
  }

  const existingSnap = await db.collection(SESSION_COLLECTION)
    .where('courseId', '==', courseId).get();
  const existingSessions = existingSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const plan = await planRegenerate({ db, course, existingSessions });
  const orphans = plan.orphanPlan.filter(o => o.confirmedCount + o.waitlistCount + o.leaveCount > 0);

  // ── 預覽：不寫入，回傳將建立／刪除／孤兒清單供員工確認 ──
  if (!confirm) {
    return {
      preview: true,
      willCreate: plan.createDates.length,
      willKeep: plan.keptMatching.length,
      willDelete: plan.emptyToDelete.length,
      orphans: orphanSummary(orphans),
      message: orphans.length
        ? `偵測到 ${orphans.length} 個已有學員、但不在新課表的場次`
        : '無孤兒場次，可直接重新產生',
    };
  }

  // ── 執行：刪空場次 → 建新場次 → 轉移孤兒報名 ──
  const now = new Date();

  // 1) 刪除無學員的舊場次
  if (plan.emptyToDelete.length) {
    const delBatch = db.batch();
    plan.emptyToDelete.forEach(s => delBatch.delete(db.collection(SESSION_COLLECTION).doc(s.id)));
    await delBatch.commit();
  }

  // 2) 建立缺少的目標場次（已留用的日期不重建）
  const created = plan.createDates.map(d => buildSession(course, courseId, gymId, staffId, d, now));
  const BATCH_SIZE = 400;
  for (let i = 0; i < created.length; i += BATCH_SIZE) {
    const chunk = created.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach(s => batch.set(db.collection(SESSION_COLLECTION).doc(s.id), s));
    await batch.commit();
  }

  // 目標日期 → 場次 id（留用 + 新建），供孤兒轉入
  const sessionIdByDate = {};
  plan.keptMatching.forEach(s => { sessionIdByDate[s.date] = s.id; });
  created.forEach(s => { sessionIdByDate[s.date] = s.id; });
  // 目標場次的累計人數（轉入後一次寫回）
  const targetCounts = {};
  plan.targetDates.forEach(d => { targetCounts[d] = { enrolled: 0, waitlist: 0 }; });
  plan.keptMatching.forEach(s => { targetCounts[s.date] = { enrolled: s.enrolledCount || 0, waitlist: s.waitlistCount || 0 }; });

  // 3) 轉移孤兒報名
  const transferred = [];
  const keptOrphans = [];
  const touchedDates = new Set(); // 僅轉入過的目標場次需回寫人數
  for (const o of plan.orphanPlan) {
    if (!o.willTransfer) {
      if (o.confirmedCount + o.waitlistCount + o.leaveCount > 0) {
        keptOrphans.push({ date: o.session.date, members: o.members, reason: o.reason });
      }
      continue;
    }
    const targetDate = o.targetDate;
    const targetId = sessionIdByDate[targetDate];
    const tc = targetCounts[targetDate];
    const gymAccessStart = dayjs(targetDate).subtract(course.gymAccessDaysBefore || 0, 'day').format('YYYY-MM-DD');
    const gymAccessEnd   = dayjs(targetDate).add(course.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD');

    let waitSeq = tc.waitlist;
    const moveBatch = db.batch();
    o.enrollments.forEach(e => {
      const upd = {
        sessionId: targetId,
        date: targetDate,
        startTime: course.startTime || '',
        endTime: course.endTime || '',
        gymAccessStart, gymAccessEnd,
        transferredFrom: o.session.date,
        transferredAt: now,
        updatedAt: now,
      };
      if (e.status === 'waitlist') upd.waitlistPosition = ++waitSeq;
      moveBatch.update(e.ref, upd);
    });
    // 孤兒場次已清空 → 刪除
    moveBatch.delete(db.collection(SESSION_COLLECTION).doc(o.session.id));
    await moveBatch.commit();

    tc.enrolled += o.confirmedCount;
    tc.waitlist = waitSeq;
    touchedDates.add(targetDate);
    transferred.push({ from: o.session.date, to: targetDate, count: o.enrollments.length, members: o.members });
  }

  // 4) 寫回「有轉入」的目標場次人數（其餘場次人數不變，免動）
  const touched = [...touchedDates];
  for (let i = 0; i < touched.length; i += BATCH_SIZE) {
    const chunk = touched.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    chunk.forEach(date => {
      const tc = targetCounts[date];
      batch.update(db.collection(SESSION_COLLECTION).doc(sessionIdByDate[date]),
        { enrolledCount: tc.enrolled, waitlistCount: tc.waitlist, updatedAt: now });
    });
    await batch.commit();
  }

  // 5) 更新課程總堂數（目標場次 + 保留的孤兒）
  const totalSessions = plan.targetDates.length + keptOrphans.length;
  await db.collection(COURSE_COLLECTION).doc(courseId).update({ totalSessions, updatedAt: now });

  return {
    preview: false,
    count: created.length,
    kept: plan.keptMatching.length,
    deleted: plan.emptyToDelete.length,
    transferred,
    keptOrphans,
    message: `已產生 ${created.length} 個場次`
      + (transferred.length ? `，轉移 ${transferred.length} 個孤兒場次報名` : '')
      + (keptOrphans.length ? `，${keptOrphans.length} 個因額滿保留原場次` : ''),
  };
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

  // 日期/時段變更 → 同步該場次報名的快照（enrollment 存 date/startTime/endTime 快照，
  // 不同步會讓會員端「我的課程/請假判定」停在舊日期）
  if (updates.date || updates.startTime || updates.endTime) {
    const enSnap = await db.collection(ENROLLMENT_COLLECTION).where('sessionId', '==', sessionId).get();
    const batch = db.batch(); let n = 0;
    enSnap.forEach(d => {
      if (d.data().status === 'cancelled') return;
      const u = { updatedAt: new Date() };
      if (updates.date) u.date = updates.date;
      if (updates.startTime) u.startTime = updates.startTime;
      if (updates.endTime) u.endTime = updates.endTime;
      batch.update(d.ref, u); n++;
    });
    if (n) await batch.commit();
  }

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
  // 候補上限：正取已滿且候補也滿(maxWaitlist；null=不限) → 擋下
  if (isFull) {
    const wcap = (course.maxWaitlist === null || course.maxWaitlist === undefined) ? Infinity : course.maxWaitlist;
    if ((session.waitlistCount || 0) >= wcap) {
      throw { code: 'WAITLIST_FULL', message: '此場次正取與候補皆已額滿' };
    }
  }
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
  if (enrollment.refundPending) throw { code: 'REFUND_PENDING', message: '此課程退費申請審核中，暫不可請假' };

  const courseDoc = await db.collection(COURSE_COLLECTION).doc(enrollment.courseId).get();
  const course = courseDoc.exists ? courseDoc.data() : {};
  const rules = resolveRules(course, await getCategoryOf(db, course.categoryId));

  // 請假截止：上課前 leaveDeadlineHours 小時（以台灣時間為準）
  const deadlineHours = rules.leaveDeadlineHours;
  if (enrollment.date && enrollment.startTime) {
    const classTime = dayjs(`${enrollment.date}T${enrollment.startTime}:00+08:00`);
    if (classTime.isValid() && dayjs().add(deadlineHours, 'hour').isAfter(classTime)) {
      throw { code: 'LEAVE_DEADLINE_PASSED', message: `需於上課前 ${deadlineHours} 小時提出請假` };
    }
  }

  // 請假次數上限：整期＝班別/梯次規則；插班＝管理員個別填寫的 maxLeavesAllowed（覆蓋預設）
  // 政策（2026-07-17）：超過上限「仍允許請假」，但超限的請假不產生補課資格（補課次數上限不變）
  const maxLeaves = enrollment.maxLeavesAllowed ?? rules.maxLeaves;
  const usedLeaves = await db.collection(ENROLLMENT_COLLECTION)
    .where('memberId', '==', memberId)
    .where('courseId', '==', enrollment.courseId)
    .where('status', '==', 'leave')
    .get().then(s => s.size);
  const overLimit = usedLeaves >= maxLeaves;

  const now = new Date();

  // 更新報名狀態
  await enrollDoc.ref.update({ status: 'leave', leaveReason: reason || '', leaveAt: now, updatedAt: now });

  // 更新場次人數
  const sessionDoc = await db.collection(SESSION_COLLECTION).doc(enrollment.sessionId).get();
  if (sessionDoc.exists) {
    await sessionDoc.ref.update({
      enrolledCount: Math.max(0, (sessionDoc.data().enrolledCount || 0) - 1),
      updatedAt: now,
    });
  }

  // 自動產生補課資格（期限＝課程「結束日」+ makeupDeadlineDays 天；無結束日 fallback 請假堂日期起算）
  // 超過請假上限的請假不產生補課資格（政策 2026-07-17）
  let makeup = null;
  if (rules.allowMakeup !== false && !overLimit) {
    const makeupId = uuidv4();
    const makeupDays = rules.makeupDeadlineDays;
    makeup = {
      id: makeupId,
      memberId,
      originalEnrollmentId: enrollmentId,
      courseId: enrollment.courseId,
      courseName: enrollment.courseName,
      categoryId: course.categoryId || null, // 補課篩選同類別用
      gymId: enrollment.gymId,
      tags: course.tags || [],
      status: 'available',
      expiresAt: dayjs(course.endDate || enrollment.date).add(makeupDays, 'day').toDate(),
      usedSessionId: null,
      usedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(MAKEUP_COLLECTION).doc(makeupId).set(makeup);
  }

  // 自動遞補候補者（遞補失敗不中斷請假）
  try { await promoteWaitlist(enrollment.sessionId); } catch (err) { console.error('promoteWaitlist 失敗', err.message); }

  return {
    makeup, overLimit,
    message: overLimit ? '請假成功（已超過補課上限，此次請假不產生補課資格）'
      : (makeup ? '請假成功，補課資格已產生' : '請假成功'),
  };
};

// ── 取消請假（銷假）────────────────────────────────────────────────
// 條件：該堂課尚未開始、該場次仍有名額（可能已被候補遞補佔滿）。
// 連動：補課資格作廢；若補課資格已用（已報補課且補課那堂未上）→ 補課報名一併取消並釋放名額；
//       補課那堂已上過 → 擋（MAKEUP_TAKEN，不可反悔）。
const cancelLeave = async ({ enrollmentId, memberId }) => {
  const db = getDb();
  const enrollDoc = await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).get();
  if (!enrollDoc.exists) throw { code: 'ENROLLMENT_NOT_FOUND' };
  const enrollment = enrollDoc.data();
  if (enrollment.memberId !== memberId) throw { code: 'FORBIDDEN' };
  if (enrollment.status !== 'leave') throw { code: 'INVALID_STATUS', message: '此報名並非請假狀態' };

  // 課已開始/結束不可銷假（以上課時間為準；無時間則整日視為當日 23:59 前可銷）
  if (enrollment.date) {
    const classTime = dayjs(`${enrollment.date}T${enrollment.startTime || '23:59'}:00+08:00`);
    if (classTime.isValid() && dayjs().isAfter(classTime)) {
      throw { code: 'CLASS_PASSED', message: '該堂課已開始或結束，無法取消請假' };
    }
  }

  // 名額檢查：請假時已自動遞補候補，名額可能被佔滿
  const sessionDoc = await db.collection(SESSION_COLLECTION).doc(enrollment.sessionId).get();
  if (!sessionDoc.exists) throw { code: 'SESSION_NOT_FOUND' };
  const session = sessionDoc.data();
  if ((session.enrolledCount || 0) >= (session.maxStudents || 0)) {
    throw { code: 'SESSION_FULL', message: '該堂名額已滿（可能已由候補遞補），無法取消請假' };
  }

  const now = new Date();

  // 補課資格連動（先驗證再動手：補課已上過 → 整個銷假擋下）
  const mkSnap = await db.collection(MAKEUP_COLLECTION)
    .where('originalEnrollmentId', '==', enrollmentId).get();
  const makeupEnrollDocs = [];
  for (const mk of mkSnap.docs) {
    if (mk.data().status !== 'used') continue;
    const meSnap = await db.collection(ENROLLMENT_COLLECTION).where('makeupId', '==', mk.id).get();
    for (const me of meSnap.docs) {
      const m = me.data();
      if (m.status !== 'confirmed') continue;
      const mTime = dayjs(`${m.date}T${m.startTime || '00:00'}:00+08:00`);
      if (m.date && mTime.isValid() && dayjs().isAfter(mTime)) {
        throw { code: 'MAKEUP_TAKEN', message: '此請假的補課已上課，無法取消請假' };
      }
      makeupEnrollDocs.push(me);
    }
  }
  let makeupEnrollmentCancelled = 0, makeupRightCancelled = 0;
  for (const me of makeupEnrollDocs) {
    const m = me.data();
    await me.ref.update({ status: 'cancelled', cancelReason: 'leave_cancelled', cancelledAt: now, updatedAt: now });
    const msd = await db.collection(SESSION_COLLECTION).doc(m.sessionId).get();
    if (msd.exists) await msd.ref.update({ enrolledCount: Math.max(0, (msd.data().enrolledCount || 0) - 1), updatedAt: now });
    makeupEnrollmentCancelled++;
  }
  for (const mk of mkSnap.docs) {
    if (mk.data().status === 'cancelled') continue;
    await mk.ref.update({ status: 'cancelled', cancelReason: 'leave_cancelled', updatedAt: now });
    makeupRightCancelled++;
  }

  // 還原報名 + 場次人數（保留 leaveReason/leaveAt 供稽核，另記 leaveCancelledAt）
  await enrollDoc.ref.update({ status: 'confirmed', leaveCancelledAt: now, updatedAt: now });
  await sessionDoc.ref.update({ enrolledCount: (session.enrolledCount || 0) + 1, updatedAt: now });

  return {
    makeupEnrollmentCancelled, makeupRightCancelled,
    message: makeupEnrollmentCancelled ? '已取消請假；已報名的補課一併取消'
      : (makeupRightCancelled ? '已取消請假；補課資格已作廢' : '已取消請假'),
  };
};

// ── 自動遞補候補 ──────────────────────────────────────────────────
const promoteWaitlist = async (sessionId) => {
  const db = getDb();
  // 注意：不用 orderBy 以免需要 (sessionId,status,waitlistPosition) 複合索引；改在記憶體排序
  const waitlistSnap = await db.collection(ENROLLMENT_COLLECTION)
    .where('sessionId', '==', sessionId)
    .where('status', '==', 'waitlist')
    .get();

  if (waitlistSnap.empty) return null;

  const first = waitlistSnap.docs
    .sort((a, b) => (a.data().waitlistPosition || 0) - (b.data().waitlistPosition || 0))[0];
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

  // 試上候補轉正且尚未繳費 → 給「新的繳費期限」（遞補時起算，min(+48h, 上課前)），逾期同樣由 sweep 釋放
  const promoted = first.data();
  if (promoted.isTrial === true && promoted.paymentStatus === 'pending') {
    const sd = sessionDoc.data();
    const deadline = trialPaymentDeadline(sd);
    await first.ref.update({ paymentDeadline: deadline, updatedAt: new Date() });
  }

  // TODO: 發 Email 通知遞補成功
  console.log(`✅ 候補遞補：${promoted.memberName} → confirmed`);
  return promoted;
};

// ── 退費：取消某會員某課程所有有效報名並釋放名額 ──────────────────
const cancelCourseEnrollments = async ({ courseId, memberId, reason }) => {
  const db = getDb();
  const now = new Date();
  const today = taiwanToday(); // 台灣日期
  const snap = await db.collection(ENROLLMENT_COLLECTION)
    .where('courseId', '==', courseId)
    .where('memberId', '==', memberId)
    .where('status', 'in', ['confirmed', 'leave', 'waitlist'])
    .get();
  let cancelled = 0;
  for (const d of snap.docs) {
    const e = d.data();
    const prevStatus = e.status;
    await d.ref.update({ status: 'cancelled', cancelledAt: now, cancelReason: reason || '退費取消', updatedAt: now });
    const sDoc = await db.collection(SESSION_COLLECTION).doc(e.sessionId).get();
    if (sDoc.exists) {
      const sd = sDoc.data();
      if (prevStatus === 'confirmed') {
        // confirmed 占名額 → 釋放並遞補候補
        await sDoc.ref.update({ enrolledCount: Math.max(0, (sd.enrolledCount || 0) - 1), updatedAt: now });
        if ((sd.date || '') >= today) { try { await promoteWaitlist(e.sessionId); } catch (err) { console.error('promoteWaitlist 失敗', err.message); } }
      } else if (prevStatus === 'waitlist') {
        await sDoc.ref.update({ waitlistCount: Math.max(0, (sd.waitlistCount || 0) - 1), updatedAt: now });
      }
      // leave：請假時已釋放名額，這裡不重複扣
    }
    cancelled++;
  }
  return cancelled;
};

// ── 逾期未付款自動取消（每日排程）────────────────────────────────
// 掃 paymentDeadline 已過、仍未確認收款（含被退回未補正）的課程轉帳報名 → 取消整門課、
// 釋放名額並遞補候補（走 cancelCourseEnrollments）、作廢該報名未確認的轉帳單、記 cancelReason:'payment_expired'。
// 冪等：cancelCourseEnrollments 只動 active 狀態；已取消者被 status 過濾掉、不重複處理。
const sweepExpiredCoursePayments = async () => {
  const db = getDb();
  const now = new Date();
  // paymentDeadline 只掛在主報名(idx0)。單欄位範圍查 < now，記憶體過濾「未確認 + 未取消」。
  const snap = await db.collection(ENROLLMENT_COLLECTION).where('paymentDeadline', '<', now).get();
  const expired = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(e => e.paymentDeadline && e.paymentConfirmed !== true && e.status !== 'cancelled');

  let cancelledGroups = 0, cancelledEnrollments = 0, voidedTransfers = 0;
  const seen = new Set(); // 以 (courseId, memberId) 去重，避免同群組重複處理
  for (const e of expired) {
    const key = `${e.courseId}__${e.memberId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const n = await cancelCourseEnrollments({ courseId: e.courseId, memberId: e.memberId, reason: 'payment_expired' });
      cancelledEnrollments += n; cancelledGroups++;
      // 作廢該報名（主報名 id === transferRecords.refId）尚未確認的轉帳單，別留孤兒單
      const trSnap = await db.collection('transferRecords').where('refId', '==', e.id).get();
      for (const td of trSnap.docs) {
        if (['pending', 'rejected'].includes(td.data().status)) {
          await td.ref.update({ status: 'expired', expiredAt: now, updatedAt: now });
          voidedTransfers++;
        }
      }
    } catch (err) { console.error('sweepExpiredCoursePayments 單筆失敗', e.id, err.message); }
  }
  if (cancelledGroups) console.log(`[課程逾期未付款] 取消 ${cancelledGroups} 門課報名（${cancelledEnrollments} 堂）、作廢 ${voidedTransfers} 筆轉帳單`);
  return { cancelledGroups, cancelledEnrollments, voidedTransfers };
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

  // 退費審核中（原課程有 pending 退費申請）→ 凍結此課程衍生的補課資格（退回後恢復可用）
  if (makeup.courseId) {
    const reqSnap = await db.collection('courseAdjustmentRequests')
      .where('courseId', '==', makeup.courseId).where('memberId', '==', memberId).get();
    if (reqSnap.docs.some(d => { const r = d.data(); return r.type === 'refund' && r.status === 'pending'; })) {
      throw { code: 'REFUND_PENDING', message: '此課程退費申請審核中，暫不可使用補課資格' };
    }
  }

  const sessionDoc = await db.collection(SESSION_COLLECTION).doc(targetSessionId).get();
  if (!sessionDoc.exists) throw { code: 'SESSION_NOT_FOUND' };
  const session = sessionDoc.data();

  if (session.enrolledCount >= session.maxStudents) {
    throw { code: 'SESSION_FULL', message: '此場次已額滿' };
  }

  // 驗證同「補課群組」同館（班別可設 makeupGroup 讓多班別互補，如小蜘蛛人入門+進階；未設＝各班別自成一組）
  const originalCourseDoc = await db.collection(COURSE_COLLECTION).doc(makeup.courseId).get();
  const targetCourseDoc = await db.collection(COURSE_COLLECTION).doc(session.courseId).get();
  if (originalCourseDoc.exists && targetCourseDoc.exists) {
    const origCourse = originalCourseDoc.data();
    const targetCourse = targetCourseDoc.data();
    if (origCourse.categoryId) {
      const [origCat, targetCat] = await Promise.all([
        getCategoryOf(db, origCourse.categoryId), getCategoryOf(db, targetCourse.categoryId),
      ]);
      const sameCategory = targetCourse.categoryId === origCourse.categoryId;
      // 補課類型（named 實體、班別多選）：兩班別有任一共同類型即可互補
      const origTypes = origCat?.makeupTypeIds || [];
      const targetTypes = targetCat?.makeupTypeIds || [];
      const sharedType = origTypes.some(t => targetTypes.includes(t));
      // 舊制相容：同 makeupGroup key 亦放行
      const legacyGroup = origCat?.makeupGroup && origCat.makeupGroup !== origCourse.categoryId
        && origCat.makeupGroup === targetCat?.makeupGroup;
      if (!sameCategory && !sharedType && !legacyGroup) {
        throw { code: 'DIFFERENT_CATEGORY', message: '補課只能選擇相同班別（或同補課類型）的課程' };
      }
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

// ── 入場連動：今日有已報名場次 → 自動標記出席（present）────────────────
// 由入場落點（confirmCheckIn / /checkin/phone）於建立 checkIns 後呼叫。
// 判斷基準是「今天有已報名場次」，與 entryType 無關（課程學員也可能用定期票/VIP 入場）。
// ⚠ 全程 try/catch、永不 throw——任何失敗都不可阻斷入場（只 console.error）。
// ⚠ 已有出席紀錄（員工已標 present/absent/late）不覆蓋。
const markTodayCourseAttendanceOnEntry = async ({ memberId, gymId, staffId }) => {
  try {
    const db = getDb();
    const today = taiwanToday();

    // 1. 該會員 confirmed 且未暫停的報名 → 取課程 id 集合
    const enrollSnap = await db.collection(ENROLLMENT_COLLECTION)
      .where('memberId', '==', memberId)
      .where('status', '==', 'confirmed')
      .get();
    const courseIds = [...new Set(
      enrollSnap.docs.map(d => d.data())
        .filter(e => e.pauseStatus !== 'paused')  // 暫停中不算
        .map(e => e.courseId).filter(Boolean)
    )];
    if (courseIds.length === 0) return { marked: 0 };

    let marked = 0;
    for (const courseId of courseIds) {
      // 2. 課程須屬入場館別（避免跨館誤記）
      const courseDoc = await db.collection(COURSE_COLLECTION).doc(courseId).get();
      if (!courseDoc.exists) continue;
      if (gymId && courseDoc.data().gymId !== gymId) continue;

      // 3. 今日場次（date===台灣今天；跳過已取消場次）
      const sessSnap = await db.collection(SESSION_COLLECTION)
        .where('courseId', '==', courseId)
        .where('date', '==', today)
        .get();
      for (const s of sessSnap.docs) {
        if (s.data().status === 'cancelled') continue;
        const sessionId = s.id;
        // 4. 尚無出席紀錄才標 present（不覆蓋員工已標的）
        const exist = await db.collection(ATTENDANCE_COLLECTION)
          .where('sessionId', '==', sessionId)
          .where('memberId', '==', memberId)
          .limit(1).get();
        if (!exist.empty) continue;
        await markAttendance({ sessionId, memberId, staffId, status: 'present' });
        marked++;
      }
    }
    return { marked };
  } catch (err) {
    console.error('markTodayCourseAttendanceOnEntry 失敗（不阻斷入場）:', err.message);
    return { marked: 0, error: err.message };
  }
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
  const today = taiwanToday(); // 台灣日期
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

  // 類別名對照（供會員端「課程總覽」依類別分組顯示；課程只存 categoryId）
  const catMap = {};
  try {
    (await db.collection('courseCategories').get()).docs.forEach(d => { catMap[d.id] = d.data(); });
  } catch (e) {}

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
    const realEnrolled = enrolledByCourse[c.id]?.size || 0;
    // reservedSlots：從 BeClass 等外部帶入的「已佔用正取名額」，計入佔用數（剩餘=max−實報名−reserved）
    const enrolledCount = realEnrolled + (c.reservedSlots || 0);
    const cat = catMap[c.categoryId] || null;
    return {
      ...c, enrolledCount, realEnrolled,
      categoryName: cat?.name || null,
      categoryGroup: cat?.group || null,               // adult | youth | special（大類）
      categoryDescription: cat?.description || null,   // 班別共用課程介紹
      categoryImageUrl: cat?.imageUrl || null,         // 班別共用廣告照片
      statusLabel: computeStatusLabel(c, enrolledCount),
    };
  });
};

// ── 查詢場次列表 ──────────────────────────────────────────────────
const getSessions = async (gymId, fromDate, toDate) => {
  const db = getDb();
  let ref = db.collection(SESSION_COLLECTION);
  if (gymId) ref = ref.where('gymId', '==', gymId);
  ref = ref
    .where('date', '>=', fromDate || taiwanToday())
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
    if (!statsBySession[e.sessionId]) statsBySession[e.sessionId] = { enrolledCount: 0, leaveCount: 0, makeupCount: 0, trialCount: 0, regularCount: 0 };
    const st = statsBySession[e.sessionId];
    if (e.status === 'leave') {
      st.leaveCount++;                     // 請假（原週課學員）
    } else if (e.status === 'confirmed' || e.status === 'waitlist') {
      st.enrolledCount++;                  // 沿用：confirmed + waitlist
      if (e.isMakeup) st.makeupCount++;    // 補課
      else if (e.isTrial) st.trialCount++; // 試上（目前無資料來源，預留 isTrial）
      else st.regularCount++;              // 週課原報名（非補課非試上）
    }
  });

  // 教練存在「課程」上（場次未存 instructor），批次帶出
  const courseIds = [...new Set(sessions.map(s => s.courseId).filter(Boolean))];
  const courseDocs = await Promise.all(courseIds.map(id => db.collection(COURSE_COLLECTION).doc(id).get()));
  const instructorByCourse = {};
  courseDocs.forEach(d => { if (d.exists) instructorByCourse[d.id] = d.data().instructor || ''; });

  return sessions.map(s => {
    const st = statsBySession[s.id] || { enrolledCount: 0, leaveCount: 0, makeupCount: 0, trialCount: 0, regularCount: 0 };
    // 報名人數＝週課原報名（含請假者）；預計上課人數＝原報名−請假＋補課＋試上
    const registeredCount = st.regularCount + st.leaveCount;
    const expectedCount = st.regularCount + st.makeupCount + st.trialCount;
    return {
      ...s,
      instructor: s.instructor || instructorByCourse[s.courseId] || '',
      enrolledCount: st.enrolledCount,
      leaveCount: st.leaveCount,
      makeupCount: st.makeupCount,
      trialCount: st.trialCount,
      registeredCount,
      expectedCount,
    };
  });
};

// ── 試上報名：將會員加入某場次名單（isTrial，佔名額）──────────────────
// 輕量版（不含分期/插班費計算）；計入預計上課、佔名額；防止重複試上同一場。
const enrollTrial = async ({ memberId, memberName, sessionId, gymId, trialFee, bookingId, staffId, paymentStatus = 'paid', paymentDeadline = null, maxWaitlist = null }) => {
  const db = getDb();
  const now = new Date();
  const sessionDoc = await db.collection(SESSION_COLLECTION).doc(sessionId).get();
  if (!sessionDoc.exists) throw { code: 'SESSION_NOT_FOUND', message: '找不到試上場次' };
  const session = sessionDoc.data();

  const dup = await db.collection(ENROLLMENT_COLLECTION)
    .where('memberId', '==', memberId).where('sessionId', '==', sessionId)
    .where('status', 'in', ['confirmed', 'waitlist']).get();
  if (!dup.empty) throw { code: 'ALREADY_ENROLLED', message: '此會員已在該場次名單中' };

  const isFull = (session.enrolledCount || 0) >= (session.maxStudents || 0);
  // 候補上限（course.maxWaitlist）：滿了且候補也滿 → 擋
  if (isFull && maxWaitlist != null && (session.waitlistCount || 0) >= maxWaitlist) {
    throw { code: 'WAITLIST_FULL', message: '此場次正取與候補皆已額滿' };
  }
  const enrollmentId = uuidv4();
  const enrollment = {
    id: enrollmentId, memberId, memberName: memberName || '',
    sessionId, courseId: session.courseId, courseName: session.courseName, gymId: gymId || session.gymId,
    date: session.date, startTime: session.startTime, endTime: session.endTime,
    status: isFull ? 'waitlist' : 'confirmed',
    waitlistPosition: isFull ? (session.waitlistCount || 0) + 1 : null,
    isTrial: true, trialFee: trialFee || 0,
    experienceBookingId: bookingId || null,
    paymentStatus,                          // 'pending'＝報名即佔位、待繳費（逾期由 sweep 釋放）；'paid'＝已收款
    paymentDeadline: paymentDeadline || null, // 繳費期限（pending 時有值；逾期釋放名額、候補轉正）
    enrolledBy: staffId || memberId, enrolledAt: now, createdAt: now, updatedAt: now,
  };
  await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).set(enrollment);
  await db.collection(SESSION_COLLECTION).doc(sessionId).update(
    isFull ? { waitlistCount: (session.waitlistCount || 0) + 1, updatedAt: now }
           : { enrolledCount: (session.enrolledCount || 0) + 1, updatedAt: now });
  return { enrollmentId, sessionId, status: enrollment.status };
};

// ── 取消試上名單（退費/取消預約時）：移除名單並釋放名額 ───────────────
const removeTrialEnrollment = async (enrollmentId) => {
  const db = getDb();
  const now = new Date();
  const ref = db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId);
  const doc = await ref.get();
  if (!doc.exists) return { removed: false };
  const e = doc.data();
  await ref.update({ status: 'cancelled', cancelledAt: now, updatedAt: now });
  const sDoc = await db.collection(SESSION_COLLECTION).doc(e.sessionId).get();
  let releasedConfirmed = false;
  if (sDoc.exists) {
    const s = sDoc.data();
    if (e.status === 'confirmed') { releasedConfirmed = true; await sDoc.ref.update({ enrolledCount: Math.max(0, (s.enrolledCount || 0) - 1), updatedAt: now }); }
    else if (e.status === 'waitlist') await sDoc.ref.update({ waitlistCount: Math.max(0, (s.waitlistCount || 0) - 1), updatedAt: now });
  }
  // 釋出正取名額 → 未過期場次自動遞補第一位候補（試上遞補者在 promoteWaitlist 內取得新繳費期限）
  if (releasedConfirmed && sDoc.exists && (sDoc.data().date || '') >= taiwanToday()) {
    try { await promoteWaitlist(e.sessionId); } catch (err) { console.error('promoteWaitlist 失敗', err.message); }
  }
  return { removed: true };
};

// ── 試上繳費期限：報名/遞補當下起算 48 小時，且不得晚於上課開始時間 ─────
const trialPaymentDeadline = (session) => {
  const plus48 = new Date(Date.now() + 48 * 3600 * 1000);
  const start = session?.date
    ? new Date(`${session.date}T${session.startTime || '00:00'}:00+08:00`)
    : null;
  return (start && start < plus48) ? start : plus48;
};

// ── 試上逾期未繳費清理（每小時排程）：釋放名額 + 取消預約 + 候補轉正 ─────
// 冪等：只處理 status 仍 confirmed/waitlist 且 paymentStatus='pending' 且期限已過者。
const sweepExpiredTrialPayments = async () => {
  const db = getDb();
  const now = new Date();
  const snap = await db.collection(ENROLLMENT_COLLECTION)
    .where('isTrial', '==', true)
    .where('paymentStatus', '==', 'pending')
    .get();
  const toMs = (v) => (v?.toDate ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0));
  const expired = snap.docs.filter(d => {
    const e = d.data();
    return ['confirmed', 'waitlist'].includes(e.status) && toMs(e.paymentDeadline) && toMs(e.paymentDeadline) < now.getTime();
  });
  const affectedSessions = new Set();
  let cancelled = 0;
  for (const d of expired) {
    const e = d.data();
    await d.ref.update({ status: 'cancelled', cancelReason: 'payment_expired', cancelledAt: now, updatedAt: now });
    const sDoc = await db.collection(SESSION_COLLECTION).doc(e.sessionId).get();
    if (sDoc.exists) {
      const sd = sDoc.data();
      if (e.status === 'confirmed') { await sDoc.ref.update({ enrolledCount: Math.max(0, (sd.enrolledCount || 0) - 1), updatedAt: now }); affectedSessions.add(e.sessionId); }
      else await sDoc.ref.update({ waitlistCount: Math.max(0, (sd.waitlistCount || 0) - 1), updatedAt: now });
    }
    // 對應體驗預約標逾期取消（會員端可見原因）
    if (e.experienceBookingId) {
      await db.collection('experienceBookings').doc(e.experienceBookingId)
        .update({ status: 'cancelled', cancelReason: 'payment_expired', cancelledAt: now, updatedAt: now })
        .catch(() => {});
    }
    cancelled++;
  }
  // 釋出的場次（未過期者）候補轉正
  for (const sid of affectedSessions) {
    try {
      const sDoc = await db.collection(SESSION_COLLECTION).doc(sid).get();
      if (sDoc.exists && (sDoc.data().date || '') >= taiwanToday()) await promoteWaitlist(sid);
    } catch (err) { console.error('試上逾期遞補失敗', err.message); }
  }
  return { cancelled, promotedSessions: affectedSessions.size };
};

// ── 設定某場次代班教練（覆寫該堂 instructor + 記錄原教練 + 通知）──────
// 兩邊月曆自動顯示：getSessions 優先用 session.instructor。
const setSessionSubstitute = async ({ sessionId, coachId, coachName, reason, staff }) => {
  const db = getDb();
  const now = new Date();
  const sRef = db.collection(SESSION_COLLECTION).doc(sessionId);
  const sDoc = await sRef.get();
  if (!sDoc.exists) throw { code: 'SESSION_NOT_FOUND', message: '找不到場次' };
  const session = sDoc.data();

  // 原教練：優先沿用已記錄的 originalInstructor；否則場次現有 instructor；再否則課程 instructor
  let originalInstructor = session.originalInstructor;
  if (originalInstructor === undefined || originalInstructor === null) {
    if (session.instructor) originalInstructor = session.instructor;
    else {
      const cDoc = await db.collection(COURSE_COLLECTION).doc(session.courseId).get();
      originalInstructor = cDoc.exists ? (cDoc.data().instructor || '') : '';
    }
  }

  await sRef.update({
    instructor: coachName, coachId: coachId || null,
    isSubstitute: true, originalInstructor, substituteReason: reason || '',
    substitutedBy: staff?.id || null, substitutedAt: now, updatedAt: now,
  });

  // 待辦提醒：通知代班教練本人 + 館管理員
  const timeStr = `${session.startTime || ''}${session.endTime ? '~' + session.endTime : ''}`;
  const title = '課程代班通知';
  const body = `${session.courseName}（${session.date} ${timeStr}）由 ${coachName} 代班`
    + `${originalInstructor ? `（原教練：${originalInstructor}）` : ''}${reason ? `，原因：${reason}` : ''}`;
  try {
    if (coachId) {
      await createNotification({ gymId: session.gymId, targetStaffId: coachId, type: 'course_substitute', title, body, referenceId: sessionId, referenceType: 'courseSession' });
    }
    await notifyRoleInGym({ gymId: session.gymId, role: 'gym_manager', type: 'course_substitute', title, body, referenceId: sessionId, referenceType: 'courseSession' });
  } catch (e) { console.error('[代班通知] 失敗（不阻斷）', e.message || e.code); }

  return { sessionId, instructor: coachName, originalInstructor };
};

// ── 取消該場次代班：還原原教練 + 通知 ───────────────────────────────
const clearSessionSubstitute = async ({ sessionId, staff }) => {
  const db = getDb();
  const now = new Date();
  const sRef = db.collection(SESSION_COLLECTION).doc(sessionId);
  const sDoc = await sRef.get();
  if (!sDoc.exists) throw { code: 'SESSION_NOT_FOUND', message: '找不到場次' };
  const session = sDoc.data();
  if (!session.isSubstitute) return { sessionId, instructor: session.instructor || '', alreadyCleared: true };
  const original = session.originalInstructor || '';

  // 還原：instructor 設回原教練（空字串→getSessions 自動 fallback 課程 instructor）
  await sRef.update({
    instructor: original, coachId: null, isSubstitute: false,
    originalInstructor: null, substituteReason: null,
    substitutedBy: null, substitutedAt: null, updatedAt: now,
  });

  const timeStr = `${session.startTime || ''}${session.endTime ? '~' + session.endTime : ''}`;
  const title = '課程代班取消';
  const body = `${session.courseName}（${session.date} ${timeStr}）代班已取消，恢復原教練${original ? `：${original}` : ''}`;
  try {
    await notifyRoleInGym({ gymId: session.gymId, role: 'gym_manager', type: 'course_substitute_cancel', title, body, referenceId: sessionId, referenceType: 'courseSession' });
  } catch (e) { console.error('[代班取消通知] 失敗（不阻斷）', e.message || e.code); }

  return { sessionId, instructor: original };
};

// ── 開放試上的週課近期場次（會員「體驗課程」頁列出）─────────────────
// 回傳每個可試上場次：課名/教練/日期時間/試上費/剩餘名額/是否額滿。
const getTrialSessions = async (gymId, fromDate, toDate) => {
  const db = getDb();
  let cq = db.collection(COURSE_COLLECTION);
  if (gymId) cq = cq.where('gymId', '==', gymId);
  const courseSnap = await cq.get();
  const catSnap = await db.collection(CATEGORY_COLLECTION).get();
  const cats = {}; catSnap.docs.forEach(d => { cats[d.id] = d.data(); });
  const trialCourses = {};
  courseSnap.docs.forEach(d => {
    const c = d.data();
    const rules = resolveRules(c, cats[c.categoryId]);
    if (rules.allowTrial === true && c.status !== 'cancelled' && c.isActive !== false) {
      trialCourses[d.id] = { trialPrice: rules.trialPrice || 0, courseName: c.name, instructor: c.instructor || '', maxWaitlist: (c.maxWaitlist ?? null) };
    }
  });
  if (Object.keys(trialCourses).length === 0) return [];

  const from = fromDate || taiwanToday();
  const to = toDate || dayjs(from).add(60, 'day').format('YYYY-MM-DD');
  const sessions = await getSessions(gymId, from, to);
  return sessions
    // 額滿仍可候補（waitlist 未滿）→ 保留列出（前端標「額滿・可候補」）；正取+候補皆滿才排除
    .filter(s => {
      if (!trialCourses[s.courseId] || s.status === 'cancelled') return false;
      const full = (s.enrolledCount || 0) >= (s.maxStudents || 0);
      if (!full) return true;
      const mw = trialCourses[s.courseId].maxWaitlist;
      return mw == null || (s.waitlistCount || 0) < mw; // 候補未滿仍列出
    })
    .map(s => ({
      ...s,
      trialPrice: trialCourses[s.courseId].trialPrice,
      remaining: Math.max(0, (s.maxStudents || 0) - (s.enrolledCount || 0)),
      isFull: (s.enrolledCount || 0) >= (s.maxStudents || 0),
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

  // 各課程的「可請假次數上限」與「已用次數」，供會員端課程卡顯示剩餘
  const courseIds = [...new Set(enrollments.map(e => e.courseId).filter(Boolean))];
  const courseMaxLeaves = {};
  await Promise.all(courseIds.map(async cid => {
    const cd = await db.collection(COURSE_COLLECTION).doc(cid).get();
    if (!cd.exists) { courseMaxLeaves[cid] = RULE_DEFAULTS.maxLeaves; return; }
    const c = cd.data();
    courseMaxLeaves[cid] = resolveRules(c, await getCategoryOf(db, c.categoryId)).maxLeaves;
  }));
  const usedByCourse = {};
  enrollments.forEach(e => { if (e.status === 'leave') usedByCourse[e.courseId] = (usedByCourse[e.courseId] || 0) + 1; });

  return enrollments.map(e => {
    // 插班學員 maxLeavesAllowed 覆蓋；否則用課程整期預設
    const leaveLimit = e.maxLeavesAllowed ?? courseMaxLeaves[e.courseId] ?? RULE_DEFAULTS.maxLeaves;
    const leaveUsed = usedByCourse[e.courseId] || 0;
    return {
      ...e,
      attendanceStatus: attendanceMap[e.sessionId] || null,
      leaveLimit,
      leaveUsed,
      leaveRemaining: Math.max(0, leaveLimit - leaveUsed),
    };
  });
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
  RULE_DEFAULTS, resolveRules, getCategoryOf,
  createWeeklySessions,
  updateSession,
  createCourse,
  createSession,
  enrollCourse,
  requestLeave,
  cancelLeave,
  promoteWaitlist,
  trialPaymentDeadline,
  sweepExpiredTrialPayments,
  cancelCourseEnrollments,
  sweepExpiredCoursePayments,
  enrollMakeup,
  markAttendance,
  markTodayCourseAttendanceOnEntry,
  getSessionRoster,
  getCourses,
  getSessions,
  getTrialSessions,
  enrollTrial,
  removeTrialEnrollment,
  setSessionSubstitute,
  clearSessionSubstitute,
  getMemberEnrollments,
  getMemberMakeupRights,
};
