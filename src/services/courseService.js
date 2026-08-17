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
// 補課到期日：課程有「固定補課到期日 makeupDeadlineDate」就用它，否則結束日(或 fallback)+補課期限天數
const makeupExpiryDayjs = (course, rules, fallbackBase) => {
  if (course && course.makeupDeadlineDate) return dayjs(course.makeupDeadlineDate);
  return dayjs((course && course.endDate) || fallbackBase || taiwanToday()).add(rules.makeupDeadlineDays, 'day');
};

const RULE_DEFAULTS = {
  leaveDeadlineHours: 2,       // 上課前 N 小時前須請假
  maxLeaves: 2,                // 整期可請假次數
  allowMakeup: true,           // 開放補課
  makeupDeadlineDays: 60,      // 課程「結束日」後 N 天內補完
  allowTrial: false,           // 開放試上
  trialPrice: 0,               // 試上費
  perSessionDeduction: 850,    // 退費：開課後每堂扣除
  handlingFeeRate: 0.2,        // 退費：開課後手續費率（預設 20%，班別/梯次可調）
  preStartFeeRate: 0.05,       // 退費：開課前手續費率（預設 5%，班別/梯次可調）
};
const resolveRules = (course, category) => {
  const pick = (k) => {
    const cv = course?.[k];
    if (cv !== undefined && cv !== null) return cv;
    const gv = category?.[k];
    if (gv !== undefined && gv !== null) return gv;
    return RULE_DEFAULTS[k];
  };
  const rules = Object.fromEntries(Object.keys(RULE_DEFAULTS).map(k => [k, pick(k)]));
  // 週課一律開放補課／試上（2026-08 起簡化：只要課程開放、班別彼此可互相補課即可選，不再受個別開關限制）
  if (course?.type === 'weekly') { rules.allowMakeup = true; rules.allowTrial = true; }
  return rules;
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
    price: data.price || 0,             // 工作坊：店員手填總價；週課：由 createWeeklySessions 依 pricePerSession×totalSessions 連動算出
    pricePerSession: data.pricePerSession != null ? Number(data.pricePerSession) || 0 : 0, // 週課單堂價（工作坊不用）
    totalSessions: data.totalSessions || 0,   // 總堂數（建立後可更新）
    durationMinutes: data.durationMinutes || 90,
    // 入館權益
    gymAccessDaysBefore: data.gymAccessDaysBefore || 0,
    gymAccessDaysAfter: data.gymAccessDaysAfter || 1, // 舊：結束後緩衝天數（保留供 per-session 快照相容）
    gymAccessDays: data.gymAccessDays != null ? Number(data.gymAccessDays) : 60, // 入館有效天數＝自開課日起算的總有效天數
    // 無限練習期間（課程學員身份的有效區間，管理員可手動覆寫）：預設 開課日 ~ 開課日+入館有效天數
    unlimitedPracticeStart: data.unlimitedPracticeStart || data.startDate || null,
    unlimitedPracticeEnd: data.unlimitedPracticeEnd ||
      (data.startDate ? dayjs(data.startDate).add(data.gymAccessDays != null ? Number(data.gymAccessDays) : 60, 'day').format('YYYY-MM-DD') : null),
    // 報名開放（null＝隨時開放）：公開開放日前僅「舊生」（同班別任一梯次曾有效報名）可報
    enrollOpenDate: data.enrollOpenDate || null,
    alumniOpenDate: data.alumniOpenDate || null,
    // 工作坊分階段報名＋隊員分級定價（僅 workshop 生效；留空＝不限制）：
    // 隊員專屬期(teamOpenDate ~ generalOpenDate)只有隊員可報名；一般會員 generalOpenDate 起開放；隊員任何時候都用 teamPrice
    teamOpenDate: data.teamOpenDate || null,
    generalOpenDate: data.generalOpenDate || null,
    teamPrice: (data.teamPrice === '' || data.teamPrice === null || data.teamPrice === undefined) ? null : Number(data.teamPrice),
    // 報名流程客製（如運動按摩）：略過簽名、收集性別/年齡、自訂必填備註欄
    skipSignature: data.skipSignature === true,
    collectGenderAge: data.collectGenderAge === true,
    enrollNoteLabel: data.enrollNoteLabel || null,
    enrollNoteRequired: data.enrollNoteRequired === true,
    // 工作坊退費分級（僅 workshop 用；null/空陣列＝套用系統預設 DEFAULT_WORKSHOP_REFUND_TIERS）
    refundTiers: Array.isArray(data.refundTiers) && data.refundTiers.length
      ? data.refundTiers.map(t => ({ daysBefore: Number(t.daysBefore) || 0, rate: Number(t.rate) || 0 }))
      : null,
    // 工作坊保證金（僅 workshop 用；0/null＝不收保證金。免費工作坊仍可收保證金，報到後由店員退還/沒收；
    // 提前取消時比照 refundTiers 同一套時間分級比例部分退還，見 computeWorkshopRefund 呼叫端）
    depositAmount: data.depositAmount != null && data.depositAmount !== '' ? Number(data.depositAmount) || 0 : 0,
    // 續報/舊生優惠（比率折扣，各自開關；週課專用）：續報＝前一期整期報名（插班不算）；舊生＝曾報名過或插班生
    fullTermRenewalDiscountEnabled: data.fullTermRenewalDiscountEnabled === true,
    fullTermRenewalDiscountRate: data.fullTermRenewalDiscountRate != null ? Number(data.fullTermRenewalDiscountRate) : 0.9,
    alumniDiscountEnabled: data.alumniDiscountEnabled === true,
    alumniDiscountRate: data.alumniDiscountRate != null ? Number(data.alumniDiscountRate) : 0.95,
    // 舊：NT$ 折抵欄位（停止讀取，留供稽核；遷移前既有課程可能仍有值）
    fullTermRenewalDiscount: data.fullTermRenewalDiscount != null ? Number(data.fullTermRenewalDiscount) || 0 : null,
    alumniDiscount: data.alumniDiscount != null ? Number(data.alumniDiscount) || 0 : null,
    renewalDeadline: data.renewalDeadline || null, // 續報截止日：兩種續報優惠皆只到此日（含當日）；空＝不限
    // 退費設定（null＝繼承班別）
    perSessionDeduction: data.perSessionDeduction ?? null,
    handlingFeeRate: data.handlingFeeRate ?? null,
    preStartFeeRate: data.preStartFeeRate ?? null,
    // 暫停規則
    pauseAllowed: data.pauseAllowed !== false,
    // 請假規則（null＝繼承班別）
    leaveDeadlineHours: data.leaveDeadlineHours ?? null,
    maxLeaves: data.maxLeaves ?? null,
    // 補課規則（null＝繼承班別；期限＝課程結束日+N天）
    allowMakeup: data.allowMakeup ?? null,
    makeupDeadlineDays: data.makeupDeadlineDays ?? null,
    makeupDeadlineDate: data.makeupDeadlineDate ?? null,   // 固定補課到期日(覆蓋結束日+天數)
    // 試上規則（null＝繼承班別；試上比照體驗發單日券、不卡墜測）
    allowTrial: data.allowTrial ?? null,
    trialTarget: data.trialTarget || 'auto',   // 可作為「試上」場次：auto(達2人自動開)|on|off
    makeupTarget: data.makeupTarget || 'auto', // 可作為「補課」場次：auto(達2人自動開)|on|off(如密集班)
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

// ── 同步課程總堂數快取（新增/取消場次皆呼叫，delta=+1/-1）──────────────
// ⚠ course.totalSessions 若不同步：①工作坊插班費用 calcEnrollmentFee 會用到過期堂數算錯
// ②週課的整期總價快取 price（=pricePerSession×totalSessions）也會跟著過期。
// 注意：這只影響「顯示」（課程列表價格／管理頁堂數）——真正收費的 computeWeeklyCourseFee
// 是即時查詢未取消場次數去算，不受此快取影響，故此函式非交易式（低頻管理動作，比照既有慣例）。
const syncCourseSessionCount = async (db, courseId, delta, now) => {
  const cDoc = await db.collection(COURSE_COLLECTION).doc(courseId).get();
  if (!cDoc.exists) return;
  const course = cDoc.data();
  const newTotalSessions = Math.max(0, (course.totalSessions || 0) + delta);
  const updates = { totalSessions: newTotalSessions, updatedAt: now };
  if (course.type !== 'workshop') {
    updates.price = Math.round((Number(course.pricePerSession) || 0) * newTotalSessions);
  }
  await cDoc.ref.update(updates);
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

  // 同步課程總堂數（此端點也用於「新增場次」單堂加開，含週課與工作坊）
  await syncCourseSessionCount(db, courseId, 1, now);

  // 帶入學員（新增場次時可個別勾選）：為選定會員建立此場次報名
  // 費用 0＋已確認（學員整期費用已繳，加開場次不另計費）；gymAccess 沿用課程無限練習期
  const ids = Array.isArray(data.enrollMemberIds) ? [...new Set(data.enrollMemberIds.filter(Boolean))] : [];
  if (ids.length) {
    const gymAccessStart = course.unlimitedPracticeStart || course.startDate || data.date;
    const gymAccessEnd = course.unlimitedPracticeEnd ||
      (course.startDate ? dayjs(course.startDate).add(course.gymAccessDays != null ? Number(course.gymAccessDays) : 60, 'day').format('YYYY-MM-DD') : data.date);
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

  // 5) 更新課程總堂數（目標場次 + 保留的孤兒）；週課同步連動整期總價＝單堂價×總堂數
  const totalSessions = plan.targetDates.length + keptOrphans.length;
  const pricePerSession = Number(course.pricePerSession) || 0;
  const updates = { totalSessions, updatedAt: now };
  if (course.type !== 'workshop') updates.price = Math.round(pricePerSession * totalSessions);
  // 首次產生場次（尚無任何既有場次）才用第一堂真實日期覆寫無限練習期起訖；
  // 日後改課表重產不動（可能已被人工手動調整過，不應每次改課表就覆蓋掉）
  if (existingSessions.length === 0 && plan.targetDates.length) {
    const firstDate = plan.targetDates[0];
    updates.unlimitedPracticeStart = firstDate;
    updates.unlimitedPracticeEnd = dayjs(firstDate)
      .add(course.gymAccessDays != null ? Number(course.gymAccessDays) : 60, 'day').format('YYYY-MM-DD');
  }
  await db.collection(COURSE_COLLECTION).doc(courseId).update(updates);

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

  // 場次取消/復原 → 同步課程總堂數快取（與新增場次對稱；真正收費不受影響，見 syncCourseSessionCount 註解）
  const prevStatus = doc.data().status;
  if (data.status === 'cancelled' && prevStatus !== 'cancelled') {
    await syncCourseSessionCount(db, doc.data().courseId, -1, new Date());
  } else if (data.status && data.status !== 'cancelled' && prevStatus === 'cancelled') {
    await syncCourseSessionCount(db, doc.data().courseId, 1, new Date());
  }

  // 場次取消 → 補課學員退回補課券（比照 cancelMakeup / closureCancelSession；
  // 一般取消不發正取豁免券，那是「休館停課」的專屬行為）
  let makeupRestored = 0, trialAffected = 0;
  if (data.status === 'cancelled' && prevStatus !== 'cancelled') {
    const enSnap = await db.collection(ENROLLMENT_COLLECTION).where('sessionId', '==', sessionId).get();
    const now = new Date();
    for (const d of enSnap.docs) {
      const e = d.data();
      if (!['confirmed', 'leave', 'waitlist'].includes(e.status)) continue;
      // 補課學員：取消報名＋補課券還原 available
      if (e.isMakeup && e.status === 'confirmed') {
        await d.ref.update({ status: 'cancelled', cancelReason: 'session_cancelled', cancelledAt: now, updatedAt: now });
        if (e.makeupId) {
          const mk = await db.collection(MAKEUP_COLLECTION).doc(e.makeupId).get();
          if (mk.exists && mk.data().status === 'used') {
            await mk.ref.update({ status: 'available', usedSessionId: null, usedAt: null, updatedAt: now });
            makeupRestored++;
          }
        }
        continue;
      }
      // 試上學員：完整清理（取消預約＋沖銷＋作廢票券＋已繳費列退費待辦＋通知）＋取消報名
      if (e.isTrial) {
        try {
          const experienceService = require('./experienceService');
          await experienceService.handleTrialSessionCancelled(db, e.experienceBookingId, { reason: '場次取消' });
        } catch (err) { console.error('[取消場次-試上清理]', err.message); }
        await d.ref.update({ status: 'cancelled', cancelReason: 'session_cancelled', cancelledAt: now, updatedAt: now });
        trialAffected++;
        continue;
      }
    }
  }

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

  return { id: sessionId, ...doc.data(), ...updates, makeupRestored, trialAffected };
};

// ── 單堂報名費用計算（2026-08-03 修正：一律收全額）──────────────────────
// 這支只給「單堂報名」路徑用（enrollCourse，即 workshop 的 /sessions/:sessionId/enroll）。
// 舊版依「這個場次日期是全課程第幾堂／還剩幾堂」按比例打折＋自動分兩期——是給「連續多週課程、
// 中途插班加入」設計的邏輯，但被誤用在「運動按摩/肢體評估」這類每個時段各自獨立可預約的工作坊上，
// 造成同一人在同一個月訂越晚的時段、系統自動幫他打越多折（如 NT$300 的時段被算成 150、75）。
// 使用者拍板：這類單堂報名一律收 course.price 全額，不看場次日期位置；隊員優惠改由下方
// 獨立的 course.teamPrice 機制處理（見本函式呼叫端），不再套用這裡的比例折扣。
const calcEnrollmentFee = (course) => {
  const fee = course.price || 0;
  return { fee, firstPayment: fee, secondPayment: 0, installment: false };
};

const enrollCourse = async ({ memberId, sessionId, gymId, staffId, byStaff, paymentId,
  paymentDate, bankLastFive, healthNote, referralSource,
  confirmedLeavePolicy, confirmedRefundPolicy, portraitSignature, guardianSignature,
  enrollGender, enrollAge, enrollNote,
  // 訪客（免登入公開報名，見 POST /courses/public/sessions/:sessionId/enroll）：memberId 為 guest_<uuid> 佔位字串，
  // 沒有會員文件可讀 → 跳過 getMember，用呼叫端傳入的聯絡資訊組一個最小 member 物件，隊員/員工優惠一律不適用。
  isGuestBooking = false, guestName, guestPhone, guestEmail,
}) => {
  const db = getDb();

  const member = isGuestBooking
    ? { id: memberId, name: guestName || '', isBlocked: false, isStaff: false }
    : await getMember(memberId);
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

  // gymId 權威 fallback：呼叫端（含 super_admin 個人帳號 staff.gymId=null）未明確帶入時，
  // 用場次自身的 gymId（場次建立時已定，比照 enrollTrial/createSession 的既有 fallback 慣例）——
  // 避免建出 gymId 缺失的報名，讓收款確認當下的保證金記帳（settlement 加減項）靜默失敗。
  const resolvedGymId = gymId || session.gymId || null;

  const feeInfo = calcEnrollmentFee(course);

  // 工作坊分階段報名＋隊員分級定價（僅 workshop、且設了 team/general 開放日或隊員價時生效；店員代報 byStaff 不受 gate 限）
  // 訪客沒有會員記錄，一律視為非隊員/非員工（不套用相關優惠，也不受 teamOpenDate 專屬期限制）
  const _isTeam = isGuestBooking ? false : require('../services/teamMemberService').isActiveTeamMember(member);
  const _isStaff = isGuestBooking ? false : member.isStaff === true; // 員工會員（比對到員工帳號者）——比照隊員，於 teamOpenDate 起可報
  if (course.type === 'workshop' && !byStaff && (course.teamOpenDate || course.generalOpenDate)) {
    const _t = taiwanToday();
    if (_isTeam || _isStaff) {
      if (course.teamOpenDate && _t < course.teamOpenDate)
        throw { code: 'ENROLL_NOT_OPEN', message: `${_isStaff ? '員工' : '隊員'}報名將於 ${course.teamOpenDate} 開放` };
    } else {
      if (course.generalOpenDate && _t < course.generalOpenDate) {
        const msg = (course.teamOpenDate && _t >= course.teamOpenDate)
          ? `目前為攀岩隊員專屬報名期間，一般會員將於 ${course.generalOpenDate} 開放報名`
          : `一般會員報名將於 ${course.generalOpenDate} 開放`;
        throw { code: 'ENROLL_NOT_OPEN', message: msg };
      }
    }
  }
  // 隊員優惠價（工作坊；隊員任何時候報名都用 teamPrice）；否則沿用 feeInfo
  let _fee = feeInfo.fee, _first = feeInfo.firstPayment, _second = feeInfo.secondPayment, _inst = feeInfo.installment, _teamPriceApplied = false;
  if (course.type === 'workshop' && _isTeam && course.teamPrice != null && course.teamPrice >= 0) {
    _fee = course.teamPrice; _first = course.teamPrice; _second = 0; _inst = false; _teamPriceApplied = true;
  }

  const enrollment = {
    id: enrollmentId,
    memberId,
    memberName: member.name,
    sessionId,
    courseId: session.courseId,
    courseName: session.courseName,
    gymId: resolvedGymId,
    date: session.date,
    startTime: session.startTime,
    endTime: session.endTime,
    status: isFull ? 'waitlist' : 'confirmed',
    waitlistPosition: isFull ? session.waitlistCount + 1 : null,
    paymentId: paymentId || null,
    paymentMethod: paymentId ? null : 'pending',
    // 費用資訊
    originalPrice: course.price,
    enrollmentFee: _fee,
    installment: _inst,
    firstPayment: _first,
    secondPayment: _second,
    teamPriceApplied: _teamPriceApplied,   // 工作坊隊員優惠價
    isTeamMemberEnroll: _isTeam,
    paymentStatus: 'pending',
    // 保證金（快照自 course.depositAmount；免費工作坊也可收）。實際收取（settlement 加減項）在收款確認當下才記，
    // 見 transfers.js course 分支；退還/沒收為店員獨立動作，見 refund-deposit/forfeit-deposit 端點。
    depositAmount: course.depositAmount || 0,
    depositCollectedAdjDone: false,
    depositResolved: false,
    depositResolution: null,   // 'refunded' | 'forfeited' | 'cancel_partial'（提前取消依分級比例部分退還）
    depositRefundedAmount: 0,
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
    enrollGender: enrollGender || null,   // 報名收集：性別（供講師參考）
    enrollAge: (enrollAge != null && enrollAge !== '') ? Number(enrollAge) : null, // 年齡
    enrollNote: enrollNote || null,       // 自訂備註（如想特別處理的部位）
    isGuest: !!isGuestBooking,
    contactPhone: isGuestBooking ? (guestPhone || null) : null,
    contactEmail: isGuestBooking ? (guestEmail || null) : null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).set(enrollment);

  // 更新場次人數
  const updateData = isFull
    ? { waitlistCount: session.waitlistCount + 1, updatedAt: now }
    : { enrolledCount: session.enrolledCount + 1, updatedAt: now };
  await sessionDoc.ref.update(updateData);

  // 雙寫（Phase 1）：工作坊單場報名，一筆 enrollment 對應一筆 header（純新增、失敗不阻斷報名）
  try {
    const { createRegistrationHeader } = require('./courseRegistrationService');
    await createRegistrationHeader(db, {
      memberId, memberName: member.name,
      courseId: session.courseId, courseName: session.courseName, gymId: enrollment.gymId,
      status: enrollment.status,
      paymentMethod: enrollment.paymentMethod, paymentStatus: enrollment.paymentStatus,
      fee: _fee, originalFee: course.price,
      teamDiscountApplied: _teamPriceApplied,
      bankLastFive, paymentDate,
      healthNote, referralSource, enrollNote, enrollGender,
      enrollAge: enrollment.enrollAge,
      confirmedLeavePolicy, confirmedRefundPolicy, portraitSignature, guardianSignature,
      waitlistPosition: enrollment.waitlistPosition,
      sessionCount: 1,
      sourceEnrollmentIds: [enrollmentId],
      payEnrollmentId: enrollmentId,
      enrolledBy: staffId || memberId,
      isGuest: enrollment.isGuest, contactPhone: enrollment.contactPhone,
    });
  } catch (e) { console.error('[雙寫] courseRegistrations header 建立失敗（不影響報名）:', e.message); }

  return {
    enrollment,
    feeInfo,
    isWaitlist: isFull,
    message: isFull
      ? `已加入候補名單（第 ${session.waitlistCount + 1} 位）`
      : `報名成功，應繳 NT$${_first}${_inst ? `（共兩期，第二期 NT$${_second}）` : ''}`,
  };
};

// ── 補課額度重算（不變量，政策 2026-07-17）────────────────────────
// 任一時刻：補課總額(available+used) = min(cap, 目前有效請假數)；cap = enrollment.maxLeavesAllowed ?? rules.maxLeaves。
// 取消請假不再永久吃掉額度：只要有效請假數仍足夠，額度自動補回（先復活 cancelled 券、不夠再新建）；
// 過多只作廢多餘 available（over_limit）、絕不動 used。冪等。
const reconcileMakeupEntitlement = async (db, memberId, courseId, rules = null, enrollment = null) => {
  const cDoc = await db.collection(COURSE_COLLECTION).doc(courseId).get();
  const course = cDoc.exists ? cDoc.data() : {};
  if (!rules) rules = resolveRules(course, await getCategoryOf(db, course.categoryId));

  const enSnap = await db.collection(ENROLLMENT_COLLECTION)
    .where('memberId', '==', memberId).where('courseId', '==', courseId).get();
  const enDocs = enSnap.docs.map(d => d.data());
  const activeLeaves = enDocs.filter(e => e.status === 'leave').length;
  const capOverride = enrollment?.maxLeavesAllowed ?? enDocs.find(e => e.maxLeavesAllowed != null)?.maxLeavesAllowed;
  const cap = capOverride ?? rules.maxLeaves;
  const entitlement = rules.allowMakeup === false ? 0 : Math.min(cap, activeLeaves);

  const mkSnap = await db.collection(MAKEUP_COLLECTION)
    .where('memberId', '==', memberId).where('courseId', '==', courseId).get();
  // 豁免券（休館停課發放 exempt:true）不參與不變量：不計 used/available、不被作廢、不被復活
  const mkDocs = mkSnap.docs.filter(d => d.data().exempt !== true);
  const used = mkDocs.filter(d => d.data().status === 'used').length;
  const availDocs = mkDocs.filter(d => d.data().status === 'available');
  const targetAvailable = Math.max(0, entitlement - used);

  const now = new Date();
  const expiresAt = makeupExpiryDayjs(course, rules).toDate();
  let delta = targetAvailable - availDocs.length;

  if (delta > 0) {
    // 先復活 cancelled 券（leave_cancelled / over_limit），不夠再新建
    for (const r of mkDocs.filter(d => d.data().status === 'cancelled')) {
      if (delta <= 0) break;
      await r.ref.update({ status: 'available', cancelReason: null, usedSessionId: null, usedAt: null, expiresAt, updatedAt: now });
      delta--;
    }
    while (delta > 0) {
      const id = uuidv4();
      await db.collection(MAKEUP_COLLECTION).doc(id).set({
        id, memberId, originalEnrollmentId: enrollment?.id || null,
        courseId, courseName: course.name || '', categoryId: course.categoryId || null,
        gymId: course.gymId || null, tags: course.tags || [],
        status: 'available', expiresAt, usedSessionId: null, usedAt: null,
        source: 'reconcile', createdAt: now, updatedAt: now,
      });
      delta--;
    }
  } else if (delta < 0) {
    // 作廢多餘 available（不動 used）
    for (const r of availDocs.slice(0, -delta)) {
      await r.ref.update({ status: 'cancelled', cancelReason: 'over_limit', updatedAt: now });
    }
  }
  return { entitlement, used, available: targetAvailable, cap, activeLeaves };
};

// ── 請假 ──────────────────────────────────────────────────────────
const requestLeave = async ({ enrollmentId, memberId, reason }) => {
  const db = getDb();
  const enrollDoc = await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).get();
  if (!enrollDoc.exists) throw { code: 'ENROLLMENT_NOT_FOUND' };

  const enrollment = enrollDoc.data();
  if (enrollment.memberId !== memberId) throw { code: 'FORBIDDEN' };
  if (enrollment.status !== 'confirmed') throw { code: 'INVALID_STATUS', message: '此報名狀態無法請假' };
  if (enrollment.isMakeup) throw { code: 'MAKEUP_NO_LEAVE', message: '補課場次不可請假；如無法出席請於上課一天前取消補課' };
  if (enrollment.refundPending) throw { code: 'REFUND_PENDING', message: '此課程退費申請審核中，暫不可請假' };

  const courseDoc = await db.collection(COURSE_COLLECTION).doc(enrollment.courseId).get();
  const course = courseDoc.exists ? courseDoc.data() : {};
  if (course.type === 'workshop') throw { code: 'WORKSHOP_NO_LEAVE', message: '工作坊活動不提供請假功能' };
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

  // 補課額度重算（不變量：available+used = min(cap, 有效請假數)；取代原事件式發券，政策 2026-07-17）
  const rec = await reconcileMakeupEntitlement(db, memberId, enrollment.courseId, rules, { ...enrollment, id: enrollmentId });

  // ⚠ 刻意不呼叫候補遞補：單堂請假釋出的是「當堂座位」供安排補課/試上（見上方通知文案），
  // 該會員仍是本課程正取學員、只是這一堂缺席——不是整門課退課，不該把候補者遞補進「僅這一堂」
  // 而在其餘場次仍卡在候補（會造成同一人某些堂 confirmed、某些堂 waitlist 的破碎狀態）。
  // 整門課級的候補遞補只在「整門課退課/取消」時觸發，見 cancelCourseEnrollments → promoteWaitlistForCourse。

  // 通知同館管理員：釋出名額（過渡期補課由櫃檯以舊表單安排，需知道哪堂空出位子）
  await notifyCourseManagers({
    gymId: enrollment.gymId, type: 'course_leave',
    title: '課程請假',
    body: `${enrollment.memberName || '學員'} 已請假：${enrollment.courseName || ''} ${enrollment.date} ${enrollment.startTime || ''}` +
      (overLimit ? '（超過上限，不產生補課資格）' : '，釋出 1 個名額（可安排補課）'),
    referenceId: enrollmentId,
    link: `/staff/courses?course=${enrollment.courseId}`,
  });

  return {
    makeup: null, overLimit, entitlement: rec,
    message: overLimit ? `請假成功（已達補課上限 ${rec.cap} 次，此次請假不增加補課資格）`
      : (rec.available > 0 ? `請假成功，目前可補課 ${rec.available} 次` : '請假成功'),
  };
};

// ── 取消請假（銷假）────────────────────────────────────────────────
// 條件：該堂課尚未開始、該場次仍有名額（可能已被候補遞補佔滿）。
// 連動：補課資格作廢；若補課資格已用（已報補課且補課那堂未上）→ 補課報名一併取消並釋放名額；
//       補課那堂已上過 → 擋（MAKEUP_TAKEN，不可反悔）。
// ── 課程異動通知（同館 gym_manager＋super_admin；失敗不阻斷主流程）───────
const notifyCourseManagers = async ({ gymId, type, title, body, referenceId, link }) => {
  for (const role of ['gym_manager', 'super_admin']) {
    try {
      await notifyRoleInGym({ gymId, role, type, title, body, referenceId, referenceType: 'courseEnrollment', link });
    } catch (e) { console.error('notifyCourseManagers 失敗', e.message); }
  }
};

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
    throw { code: 'SESSION_FULL', message: '該堂名額已滿（可能已由候補遞補、他人補課或試上），無法取消請假' };
  }

  const now = new Date();

  // 【方案 B（政策 2026-07-17）】取消請假「一律不自動取消任何已訂補課」（used 不撤銷、不看券血緣）。
  // 額度預檢：取消後 newEntitlement = min(cap, 有效請假數-1)；若 已訂補課(used) > newEntitlement →
  // 擋下銷假，請會員先自行「取消補課」選擇要放棄哪堂（系統不猜）。補課已上過者 used 永久成立，
  // 請假數不足以支撐時該請假即不可取消（消費已發生、不可反悔）。
  {
    const courseDocQ = await db.collection(COURSE_COLLECTION).doc(enrollment.courseId).get();
    const courseQ = courseDocQ.exists ? courseDocQ.data() : {};
    const rulesQ = resolveRules(courseQ, await getCategoryOf(db, courseQ.categoryId));
    const enSnapQ = await db.collection(ENROLLMENT_COLLECTION)
      .where('memberId', '==', memberId).where('courseId', '==', enrollment.courseId).get();
    const enDocsQ = enSnapQ.docs.map(d => d.data());
    const activeLeavesQ = enDocsQ.filter(e => e.status === 'leave').length;
    const capQ = enDocsQ.find(e => e.maxLeavesAllowed != null)?.maxLeavesAllowed ?? rulesQ.maxLeaves;
    const newEntitlement = rulesQ.allowMakeup === false ? 0 : Math.min(capQ, Math.max(0, activeLeavesQ - 1));
    const mkSnapQ = await db.collection(MAKEUP_COLLECTION)
      .where('memberId', '==', memberId).where('courseId', '==', enrollment.courseId).get();
    const usedQ = mkSnapQ.docs.filter(d => d.data().status === 'used' && d.data().exempt !== true).length; // 豁免券不佔配額
    if (usedQ > newEntitlement) {
      throw {
        code: 'MAKEUP_OVER_QUOTA',
        message: `已預約 ${usedQ} 堂補課、取消此請假後補課額度只剩 ${newEntitlement} 堂，請先取消一堂補課再取消請假（補課已上過則無法取消）`,
      };
    }
  }

  // 還原報名 + 場次人數（保留 leaveReason/leaveAt 供稽核，另記 leaveCancelledAt）
  await enrollDoc.ref.update({ status: 'confirmed', leaveCancelledAt: now, updatedAt: now });
  await sessionDoc.ref.update({ enrolledCount: (session.enrolledCount || 0) + 1, updatedAt: now });

  // 補課額度重算（不變量）
  const courseDoc2 = await db.collection(COURSE_COLLECTION).doc(enrollment.courseId).get();
  const course2 = courseDoc2.exists ? courseDoc2.data() : {};
  const rules2 = resolveRules(course2, await getCategoryOf(db, course2.categoryId));
  const rec = await reconcileMakeupEntitlement(db, memberId, enrollment.courseId, rules2, { ...enrollment, id: enrollmentId });

  await notifyCourseManagers({
    gymId: enrollment.gymId, type: 'course_leave_cancel',
    title: '取消請假（銷假）',
    body: `${enrollment.memberName || '學員'} 已取消請假、恢復上課：${enrollment.courseName || ''} ${enrollment.date} ${enrollment.startTime || ''}（名額收回）`,
    referenceId: enrollmentId,
    link: `/staff/courses?course=${enrollment.courseId}`,
  });

  return {
    entitlement: rec,
    message: `已取消請假（目前可補課 ${rec.available} 次；已預約的補課不受影響）`,
  };
};

// ── 取消請假預檢（唯讀，供銷假確認 modal 先顯示名額/額度；與 cancelLeave 三關檢查同步維護）──
const precheckCancelLeave = async ({ enrollmentId, memberId }) => {
  const db = getDb();
  const enrollDoc = await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).get();
  if (!enrollDoc.exists) throw { code: 'ENROLLMENT_NOT_FOUND' };
  const enrollment = enrollDoc.data();
  if (enrollment.memberId !== memberId) throw { code: 'FORBIDDEN' };

  const result = { ok: true, blockCode: null, blockMessage: null, session: null, quota: null };
  const block = (code, message) => { if (result.ok) { result.ok = false; result.blockCode = code; result.blockMessage = message; } };

  if (enrollment.status !== 'leave') block('INVALID_STATUS', '此報名並非請假狀態');

  // 關1：課已開始/結束
  if (enrollment.date) {
    const classTime = dayjs(`${enrollment.date}T${enrollment.startTime || '23:59'}:00+08:00`);
    if (classTime.isValid() && dayjs().isAfter(classTime)) block('CLASS_PASSED', '該堂課已開始或結束，無法取消請假');
  }

  // 關2：原堂名額
  const sessionDoc = await db.collection(SESSION_COLLECTION).doc(enrollment.sessionId).get();
  if (sessionDoc.exists) {
    const session = sessionDoc.data();
    const enrolled = session.enrolledCount || 0;
    const max = session.maxStudents || 0;
    result.session = { date: session.date, startTime: session.startTime || null, enrolledCount: enrolled, maxStudents: max, remaining: Math.max(0, max - enrolled) };
    if (enrolled >= max) block('SESSION_FULL', '該堂名額已滿（可能已由候補遞補、他人補課或試上），無法取消請假');
  } else {
    block('SESSION_NOT_FOUND', '找不到該場次');
  }

  // 關3：補課額度（同 cancelLeave 方案 B 預檢）
  const courseDocQ = await db.collection(COURSE_COLLECTION).doc(enrollment.courseId).get();
  const courseQ = courseDocQ.exists ? courseDocQ.data() : {};
  const rulesQ = resolveRules(courseQ, await getCategoryOf(db, courseQ.categoryId));
  const enSnapQ = await db.collection(ENROLLMENT_COLLECTION)
    .where('memberId', '==', memberId).where('courseId', '==', enrollment.courseId).get();
  const enDocsQ = enSnapQ.docs.map(d => d.data());
  const activeLeavesQ = enDocsQ.filter(e => e.status === 'leave').length;
  const capQ = enDocsQ.find(e => e.maxLeavesAllowed != null)?.maxLeavesAllowed ?? rulesQ.maxLeaves;
  const newEntitlement = rulesQ.allowMakeup === false ? 0 : Math.min(capQ, Math.max(0, activeLeavesQ - 1));
  const mkSnapQ = await db.collection(MAKEUP_COLLECTION)
    .where('memberId', '==', memberId).where('courseId', '==', enrollment.courseId).get();
  const usedRights = mkSnapQ.docs.filter(d => d.data().status === 'used' && d.data().exempt !== true); // 豁免券不佔配額
  const usedQ = usedRights.length;
  result.quota = { usedMakeups: usedQ, newEntitlement };
  if (usedQ > newEntitlement) {
    block('MAKEUP_OVER_QUOTA', `已預約 ${usedQ} 堂補課、取消此請假後補課額度只剩 ${newEntitlement} 堂，請先取消一堂補課再取消請假`);
  }

  // 引導版：列出「此課程補課券」對應的已預約補課報名（未上完才可就地取消；已上過 used 永久成立）
  result.bookedMakeups = [];
  if (usedQ > 0) {
    const rightIds = new Set(usedRights.map(d => d.id));
    const mkEnSnap = await db.collection(ENROLLMENT_COLLECTION)
      .where('memberId', '==', memberId).where('isMakeup', '==', true).get();
    const today = taiwanToday();
    result.bookedMakeups = mkEnSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(e => e.status === 'confirmed' && e.makeupId && rightIds.has(e.makeupId))
      .map(e => ({
        enrollmentId: e.id,
        courseName: e.courseName || '',
        date: e.date || null,
        startTime: e.startTime || null,
        canCancel: !!e.date && today < e.date, // 取消補課限上課一天前（與 cancelMakeup 同規則）
      }))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  return result;
};

// ── 休館停課（員工）：場次取消＋該堂正取自動發「豁免補課券」（不佔請假配額）──
// 補課學員→報名取消+原券還原；試上學員→報名取消（費用/退費由櫃檯另處理，回報 trialAffected）。
// 場次 cancelled → 退費公式自動不計此堂（total/held 皆排除）。
const closureCancelSession = async ({ sessionId, staffId, staffName, reason }) => {
  const db = getDb();
  const sDoc = await db.collection(SESSION_COLLECTION).doc(sessionId).get();
  if (!sDoc.exists) throw { code: 'SESSION_NOT_FOUND' };
  const session = sDoc.data();
  if (session.status === 'cancelled') throw { code: 'ALREADY_CANCELLED', message: '此場次已取消' };
  const cDoc = await db.collection(COURSE_COLLECTION).doc(session.courseId).get();
  const course = cDoc.exists ? cDoc.data() : {};
  const rules = resolveRules(course, await getCategoryOf(db, course.categoryId));
  const expiresAt = makeupExpiryDayjs(course, rules, session.date).toDate();

  const enSnap = await db.collection(ENROLLMENT_COLLECTION).where('sessionId', '==', sessionId).get();
  const now = new Date();
  let issued = 0, makeupRestored = 0, trialAffected = 0;
  for (const d of enSnap.docs) {
    const e = d.data();
    if (!['confirmed', 'leave', 'waitlist'].includes(e.status)) continue;
    if (e.isTrial) {
      // 試上：完整清理（取消預約＋沖銷＋作廢票券＋已繳費列退費待辦＋通知）＋取消報名
      try {
        const experienceService = require('./experienceService');
        await experienceService.handleTrialSessionCancelled(db, e.experienceBookingId, { reason: '休館停課' });
      } catch (err) { console.error('[休館停課-試上清理]', err.message); }
      await d.ref.update({ status: 'cancelled', cancelReason: 'closure', cancelledAt: now, updatedAt: now });
      trialAffected++;
      continue;
    }
    if (e.isMakeup) {
      // 補課學員：取消報名、原補課券還原 available（比照 cancelMakeup）
      await d.ref.update({ status: 'cancelled', cancelReason: 'closure', cancelledAt: now, updatedAt: now });
      if (e.makeupId) {
        const mk = await db.collection(MAKEUP_COLLECTION).doc(e.makeupId).get();
        if (mk.exists && mk.data().status === 'used') {
          await mk.ref.update({ status: 'available', usedSessionId: null, usedAt: null, updatedAt: now });
          makeupRestored++;
        }
      }
      continue;
    }
    if (e.status === 'confirmed') {
      // 正取：報名標休館取消＋發豁免補課券（不佔請假配額、不受上限、reconcile 不收斂）
      await d.ref.update({ status: 'cancelled', cancelReason: 'closure', cancelledAt: now, updatedAt: now });
      const rid = uuidv4();
      await db.collection(MAKEUP_COLLECTION).doc(rid).set({
        id: rid, memberId: e.memberId, originalEnrollmentId: d.id,
        courseId: session.courseId, courseName: course.name || session.courseName || '',
        categoryId: course.categoryId || null, gymId: course.gymId || session.gymId || null, tags: course.tags || [],
        status: 'available', expiresAt, usedSessionId: null, usedAt: null,
        source: 'closure', exempt: true, closureDate: session.date || null,
        createdAt: now, updatedAt: now,
      });
      issued++;
    }
    // leave/waitlist：一併標休館取消（請假者本就有配額補課券、reconcile 會依剩餘請假數收斂）
    if (e.status !== 'confirmed') {
      await d.ref.update({ status: 'cancelled', cancelReason: 'closure', cancelledAt: now, updatedAt: now });
    }
  }
  await sDoc.ref.update({
    status: 'cancelled', cancelReason: reason || '休館停課', closureCancelledBy: staffName || staffId || null,
    cancelledAt: now, updatedAt: now,
  });
  // 同步課程總堂數快取（與新增場次對稱；真正收費不受影響，見 syncCourseSessionCount 註解）
  await syncCourseSessionCount(db, session.courseId, -1, now);
  // 請假者配額重算（該堂請假因場次取消而失效 → 額度收斂）
  const leaveMembers = [...new Set(enSnap.docs.map(d => d.data()).filter(e => e.status === 'leave').map(e => e.memberId))];
  for (const mid of leaveMembers) {
    await reconcileMakeupEntitlement(db, mid, session.courseId).catch(() => {});
  }
  return { issued, makeupRestored, trialAffected, sessionDate: session.date, courseName: course.name || '' };
};

// ── 取消補課（會員；上課一天前）────────────────────────────────────
// 補課場次不可退費/暫停/請假，只能取消補課：報名取消＋釋放名額＋補課券還原 available（額度不變）。
const cancelMakeup = async ({ enrollmentId, memberId }) => {
  const db = getDb();
  const enrollDoc = await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).get();
  if (!enrollDoc.exists) throw { code: 'ENROLLMENT_NOT_FOUND' };
  const enrollment = enrollDoc.data();
  if (enrollment.memberId !== memberId) throw { code: 'FORBIDDEN' };
  if (enrollment.isMakeup !== true) throw { code: 'NOT_MAKEUP', message: '此報名不是補課場次' };
  if (enrollment.status !== 'confirmed') throw { code: 'INVALID_STATUS', message: '此補課報名狀態無法取消' };
  // 一天前：上課日前一天（含）可取消 → 今天需早於上課日
  if (!enrollment.date || taiwanToday() >= enrollment.date) {
    throw { code: 'CANCEL_DEADLINE', message: '需於上課一天前取消補課' };
  }
  const now = new Date();
  await enrollDoc.ref.update({ status: 'cancelled', cancelReason: 'makeup_cancelled', cancelledAt: now, updatedAt: now });
  const sd = await db.collection(SESSION_COLLECTION).doc(enrollment.sessionId).get();
  if (sd.exists) await sd.ref.update({ enrolledCount: Math.max(0, (sd.data().enrolledCount || 0) - 1), updatedAt: now });
  // 補課券還原 available（請假數未變 → 額度不變，不需 reconcile）
  if (enrollment.makeupId) {
    const mk = await db.collection(MAKEUP_COLLECTION).doc(enrollment.makeupId).get();
    if (mk.exists && mk.data().status === 'used') {
      await mk.ref.update({ status: 'available', usedSessionId: null, usedAt: null, updatedAt: now });
    }
  }
  await notifyCourseManagers({
    gymId: enrollment.gymId, type: 'course_makeup_cancel',
    title: '取消補課',
    body: `${enrollment.memberName || '學員'} 已取消補課：${enrollment.courseName || ''} ${enrollment.date} ${enrollment.startTime || ''}（釋出 1 個名額）`,
    referenceId: enrollmentId,
    link: `/staff/courses?course=${enrollment.courseId}`,
  });

  return { message: '已取消補課，補課資格已退回，可重新選擇場次' };
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

// ── 週課「候補→正取」整門課自動遞補 ─────────────────────────────
// 與 promoteWaitlist（per-session，供試上單堂用）不同：週課候補是「整門課」候補資格
// （enroll-all 一次為候補會員的每個未來場次各建一筆副本、共用同一個 waitlistPosition）。
// 一位候補會員代表對整門課的候補，遞補須讓其「所有未來場次」一次轉正，而非只轉正單一場次
// （否則會出現同一人某些堂 confirmed、某些堂仍 waitlist 的破碎狀態）。
// 觸發時機：有人「整門課退課/取消」釋出名額（見 cancelCourseEnrollments）；
// 單堂請假（requestLeave）釋出的是「當堂座位」供安排補課，不觸發此整門課遞補（見上該處說明）。
const promoteWaitlistForCourse = async (courseId) => {
  const db = getDb();
  const today = taiwanToday();
  const now = new Date();

  const courseDoc = await db.collection(COURSE_COLLECTION).doc(courseId).get();
  if (!courseDoc.exists) return null;
  const course = courseDoc.data();
  const maxStudents = course.maxStudents || Infinity;

  // 課程級容量：以「不重複常態學員數」計（比照 enroll-all 判定準則，補課/試上單堂佔位不算）
  const allSnap = await db.collection(ENROLLMENT_COLLECTION)
    .where('courseId', '==', courseId).where('status', 'in', ['confirmed', 'waitlist']).get();
  const confirmedMembers = new Set();
  allSnap.forEach(d => {
    const e = d.data();
    if (e.isMakeup || e.isTrial) return;
    if (e.status === 'confirmed') confirmedMembers.add(e.memberId);
  });
  if (confirmedMembers.size >= maxStudents) return null; // 沒有空位，不遞補

  // 候補文件依日期分過去/未來；過去場次的候補文件視為過期候補（未來已無機會補上），
  // 標記過期並釋出 waitlistCount，避免永久殘留污染日後的候補人數判斷。
  const waitDocs = allSnap.docs.filter(d => d.data().status === 'waitlist').map(d => ({ ref: d.ref, id: d.id, ...d.data() }));
  const future = waitDocs.filter(e => e.date >= today);
  const past = waitDocs.filter(e => e.date < today);
  for (const e of past) {
    await e.ref.update({ status: 'cancelled', cancelReason: 'waitlist_expired', cancelledAt: now, updatedAt: now });
    const sDoc = await db.collection(SESSION_COLLECTION).doc(e.sessionId).get();
    if (sDoc.exists) await sDoc.ref.update({ waitlistCount: Math.max(0, (sDoc.data().waitlistCount || 0) - 1), updatedAt: now });
  }
  if (!future.length) return null;

  // 依 waitlistPosition 選出第一位候補會員（同一人各堂副本理論上位次相同，取最小值防呆）
  const byMember = new Map();
  future.forEach(e => {
    const pos = e.waitlistPosition ?? Infinity;
    if (!byMember.has(e.memberId) || pos < byMember.get(e.memberId)) byMember.set(e.memberId, pos);
  });
  const winnerMemberId = [...byMember.entries()].sort((a, b) => a[1] - b[1])[0][0];
  const winnerDocs = future.filter(e => e.memberId === winnerMemberId).sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // 費用：比照插班同一套權威算式（單堂價×剩餘場次數；續報/舊生比率折扣＋隊員9折）
  const allSessSnap = await db.collection(SESSION_COLLECTION).where('courseId', '==', courseId).where('status', '==', 'scheduled').get();
  const allSess = allSessSnap.docs.map(d => d.data());
  const completedCount = allSess.filter(s => s.date < today).length;
  const totalCount = allSess.length;
  const alumni = await computeAlumniStatus(db, course, courseId, winnerMemberId);
  const { isActiveTeamMember } = require('./teamMemberService');
  const { getMember } = require('./memberService');
  let isTeam = false;
  try { isTeam = isActiveTeamMember(await getMember(winnerMemberId)); } catch (e) { /* 查無會員視為非隊員 */ }
  const promoteCategory = await getCategoryOf(db, course.categoryId);
  const { fee } = computeWeeklyCourseFee(course, { completedCount, totalCount, alumni, isTeam, categoryGroup: promoteCategory?.group });

  const { FieldValue } = require('firebase-admin').firestore;
  let firstDoc = null;
  for (const [i, d] of winnerDocs.entries()) {
    if (i === 0) firstDoc = d;
    await d.ref.update({
      status: 'confirmed', waitlistPosition: null, promotedAt: now, updatedAt: now,
      enrollmentFee: i === 0 ? fee : 0,
      paymentMethod: null,
      paymentStatus: i === 0 ? (fee > 0 ? 'pending' : null) : 'na',
    });
    const sDoc = await db.collection(SESSION_COLLECTION).doc(d.sessionId).get();
    if (sDoc.exists) {
      await sDoc.ref.update({ enrolledCount: FieldValue.increment(1), waitlistCount: FieldValue.increment(-1), updatedAt: now });
    }
  }

  // 營收認列（比照 enroll-all：候補轉正等同一筆新的確定報名，收入在遞補當下認列，與付款方式無關）
  if (fee > 0) {
    try {
      const { recordTransaction } = require('../utils/revenueLedger');
      await recordTransaction(db, {
        gymId: firstDoc.gymId, type: 'course', totalAmount: fee, paymentMethod: null,
        memberId: winnerMemberId, memberName: firstDoc.memberName || '',
        relatedId: courseId,
        notes: `課程候補遞補為正取：${course.name}（整堂課，共${winnerDocs.length}場）`,
        recognitionDate: course.endDate || course.unlimitedPracticeEnd || winnerDocs[winnerDocs.length - 1]?.date || null,
      });
    } catch (e) { console.error('候補遞補營收記帳失敗（不影響遞補）:', e.message); }
  }

  // 雙寫 header（courseRegistrations）
  try {
    const { updateRegistrationStatusByCourseMember } = require('./courseRegistrationService');
    await updateRegistrationStatusByCourseMember(db, winnerMemberId, courseId, { status: 'confirmed', promotedAt: now });
  } catch (e) { console.error('[雙寫] header 遞補狀態更新失敗:', e.message); }

  // 通知同館管理員（會員本人透過 /members/my/alerts 讀 promotedAt 顯示首頁提醒，見 members.js）
  await notifyCourseManagers({
    gymId: firstDoc.gymId, type: 'course_waitlist_promoted',
    title: '候補轉正',
    body: `${firstDoc.memberName || '學員'} 候補已自動遞補為正取：${course.name}，應繳 NT$${fee}（待收款）`,
    referenceId: firstDoc.id,
    link: `/staff/courses?course=${courseId}`,
  });

  console.log(`✅ 整門課候補遞補：${firstDoc.memberName} → confirmed（${course.name}，NT$${fee}）`);
  return { memberId: winnerMemberId, fee, sessionsPromoted: winnerDocs.length };
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
  let freedAnyFutureSeat = false;
  for (const d of snap.docs) {
    const e = d.data();
    const prevStatus = e.status;
    await d.ref.update({ status: 'cancelled', cancelledAt: now, cancelReason: reason || '退費取消', updatedAt: now });
    const sDoc = await db.collection(SESSION_COLLECTION).doc(e.sessionId).get();
    if (sDoc.exists) {
      const sd = sDoc.data();
      if (prevStatus === 'confirmed') {
        // confirmed 占名額 → 釋放（整門課候補遞補於迴圈結束後統一處理一次，見下）
        await sDoc.ref.update({ enrolledCount: Math.max(0, (sd.enrolledCount || 0) - 1), updatedAt: now });
        if ((sd.date || '') >= today) freedAnyFutureSeat = true;
      } else if (prevStatus === 'waitlist') {
        await sDoc.ref.update({ waitlistCount: Math.max(0, (sd.waitlistCount || 0) - 1), updatedAt: now });
      }
      // leave：請假時已釋放名額，這裡不重複扣
    }
    cancelled++;
  }
  // 雙寫（Phase 1）：連動更新對應 header 狀態（查無 header 屬正常，雙寫剛起步時舊報名尚無對應 header）
  try {
    const { updateRegistrationStatusByCourseMember } = require('./courseRegistrationService');
    await updateRegistrationStatusByCourseMember(db, memberId, courseId, { status: 'cancelled', cancelledAt: now, cancelReason: reason || '退費取消' });
  } catch (e) { console.error('[雙寫] header 取消狀態更新失敗（不影響取消）:', e.message); }
  // 整門課退課釋出名額 → 候補遞補第一位（一次處理全部未來場次，避免同一人分堂被拆成破碎狀態；
  // 內部會再次確認課程級容量，freedAnyFutureSeat 只是快速判斷是否值得呼叫，非必要條件）
  if (freedAnyFutureSeat) {
    try { await promoteWaitlistForCourse(courseId); } catch (err) { console.error('promoteWaitlistForCourse 失敗', err.message); }
  }
  return cancelled;
};

// ── 逾期未付款自動取消（每日排程）────────────────────────────────
// 掃 paymentDeadline 已過、仍未確認收款（含被退回未補正）的課程轉帳報名 → 取消整門課、
// 釋放名額並遞補候補（走 cancelCourseEnrollments）、作廢該報名未確認的轉帳單、記 cancelReason:'payment_expired'、
// 沖銷報名當下已記帳的營收（enroll-all 是 accrual 制、報名時就記帳，取消若不沖銷會虛增未來營收）。
// 冪等：cancelCourseEnrollments 只動 active 狀態；已取消者被 status 過濾掉、不重複處理；
// 沖銷交易另以 relatedId===e.id 檢查是否已存在，避免排程重跑/單筆重試造成重複沖銷。
const sweepExpiredCoursePayments = async () => {
  const db = getDb();
  const now = new Date();
  // paymentDeadline 只掛在主報名(idx0)——與 enrollmentFee 同一筆，故 e.enrollmentFee 即為當初記帳金額。
  const snap = await db.collection(ENROLLMENT_COLLECTION).where('paymentDeadline', '<', now).get();
  const expired = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(e => e.paymentDeadline && e.paymentConfirmed !== true && e.status !== 'cancelled');

  let cancelledGroups = 0, cancelledEnrollments = 0, voidedTransfers = 0, reversedRevenue = 0;
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
      // 沖銷報名時已記帳的營收（enrollmentFee>0 才有；冪等：查是否已沖銷過同一筆）
      if (e.enrollmentFee > 0) {
        try {
          const alreadyReversed = await db.collection('transactions')
            .where('relatedId', '==', e.courseId).where('memberId', '==', e.memberId)
            .where('type', '==', 'course_refund').where('notes', '==', `課程逾期未付款自動取消・沖銷 ${e.id}`).limit(1).get();
          if (alreadyReversed.empty) {
            let recognitionDate = null;
            try {
              const cd = await db.collection(COURSE_COLLECTION).doc(e.courseId).get();
              if (cd.exists) { const c = cd.data(); recognitionDate = c.endDate || c.unlimitedPracticeEnd || null; }
            } catch (err) {}
            const { recordTransaction } = require('../utils/revenueLedger');
            await recordTransaction(db, {
              gymId: e.gymId || null,
              type: 'course_refund',
              totalAmount: -Math.abs(e.enrollmentFee),
              paymentMethod: 'refund',
              memberId: e.memberId,
              memberName: e.memberName || '',
              relatedId: e.courseId,
              notes: `課程逾期未付款自動取消・沖銷 ${e.id}`,
              staffId: null,
              staffName: '系統自動（逾期未付款）',
              recognitionDate,
            });
            reversedRevenue += e.enrollmentFee;
          }
        } catch (err) { console.error('sweepExpiredCoursePayments 沖銷記帳失敗', e.id, err.message); }
      }
    } catch (err) { console.error('sweepExpiredCoursePayments 單筆失敗', e.id, err.message); }
  }
  if (cancelledGroups) console.log(`[課程逾期未付款] 取消 ${cancelledGroups} 門課報名（${cancelledEnrollments} 堂）、作廢 ${voidedTransfers} 筆轉帳單、沖銷營收 NT$${reversedRevenue}`);
  return { cancelledGroups, cancelledEnrollments, voidedTransfers, reversedRevenue };
};

// ── 補課報名 ──────────────────────────────────────────────────────
const enrollMakeup = async ({ makeupId, memberId, targetSessionId }) => {
  const db = getDb();
  let makeupDoc = await db.collection(MAKEUP_COLLECTION).doc(makeupId).get();
  if (!makeupDoc.exists) throw { code: 'MAKEUP_NOT_FOUND' };

  let makeup = makeupDoc.data();
  if (makeup.memberId !== memberId) throw { code: 'FORBIDDEN' };
  if (makeup.redemptionType === 'cash_credit') throw { code: 'CASH_CREDIT_NOT_BOOKABLE', message: '此為現金折抵資格（非到課補課），請洽櫃檯處理折抵' };

  // 後端權威：停課補課券（source:'closure'）優先消耗——即使前端傳的是配額券，
  // 只要同課程還有可用停課券就改用它（配額券受不變量管、留著彈性較大；停課券為場館欠課、先清）。
  if (makeup.source !== 'closure') {
    const altSnap = await db.collection(MAKEUP_COLLECTION)
      .where('memberId', '==', memberId).where('courseId', '==', makeup.courseId).get();
    const closureAvail = altSnap.docs
      .filter(d => { const r = d.data(); return r.source === 'closure' && r.status === 'available' && !(r.expiresAt?.toDate && dayjs().isAfter(dayjs(r.expiresAt.toDate()))); })
      .sort((a, b) => (a.data().expiresAt?.toDate?.()?.getTime() || 0) - (b.data().expiresAt?.toDate?.()?.getTime() || 0))[0];
    if (closureAvail) { makeupDoc = closureAvail; makeup = closureAvail.data(); makeupId = closureAvail.id; }
  }

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

  // 跨期補課（非會員名單，另存 crossCohortMakeups，不進 enrolledCount）也佔實體名額 → 計入容量判斷
  const _xmSnap = await db.collection('crossCohortMakeups').where('targetSessionId', '==', targetSessionId).get();
  const _crossBooked = _xmSnap.docs.filter(d => d.data().status === 'booked').length;
  if ((session.enrolledCount || 0) + _crossBooked >= session.maxStudents) {
    throw { code: 'SESSION_FULL', message: '此場次已額滿' };
  }

  // 後端權威：不可補回自己請假的課程（同 courseId；整期報名每堂本有名額，前端選單亦排除）
  if (makeup.courseId && session.courseId === makeup.courseId) {
    throw { code: 'SAME_COURSE', message: '不可補課至原課程，請選同班別其他梯次或同補課類型的課程' };
  }
  // 後端權威：目標場次已有有效報名 → 擋（避免同一人同場次雙重佔位、人數灌水）
  const dupSnap = await db.collection(ENROLLMENT_COLLECTION)
    .where('sessionId', '==', targetSessionId)
    .where('memberId', '==', memberId).get();
  if (dupSnap.docs.some(d => ['confirmed', 'leave', 'waitlist'].includes(d.data().status))) {
    throw { code: 'ALREADY_IN_SESSION', message: '你已在此場次名單中，無需補課' };
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
      // 補課類型（單向）：來源班別的「可補課去類型」(makeupTypeIds) 含目標班別的「本班別類型」(makeupSelfType) 才放行。
      // 例：青少年掛「入門班」類型 → 可補入門班；入門班未掛「青少年班」類型 → 不能補青少年（單向）。
      const origDestTypes = origCat?.makeupTypeIds || [];        // 來源班可補課去的類型
      const targetSelfType = targetCat?.makeupSelfType || null;  // 目標班本身的類型
      const directedOk = !!targetSelfType && origDestTypes.includes(targetSelfType);
      if (!sameCategory && !directedOk) {
        throw { code: 'DIFFERENT_CATEGORY', message: '補課只能選擇相同班別、或本班別可補課去的類型的課程' };
      }
    }
    const origGym = makeup.gymId || origCourse.gymId;
    const targetGym = session.gymId || targetCourse.gymId;
    if (origGym && targetGym && origGym !== targetGym) {
      throw { code: 'DIFFERENT_GYM', message: '補課只能在同一場館進行' };
    }
    // 目標梯次「可作為補課場次」——週課一律開放（2026-08 起簡化）；非週課仍走 makeupTarget 開關
    const tRegSnap = await db.collection(ENROLLMENT_COLLECTION)
      .where('courseId', '==', session.courseId).where('status', '==', 'confirmed').get();
    const tReg = new Set(); tRegSnap.docs.forEach(x => { const e = x.data(); if (!e.isMakeup && !e.isTrial) tReg.add(e.memberId); });
    if (!isTargetOpen(targetCourse.makeupTarget, tReg.size, targetCourse.type)) {
      throw { code: 'MAKEUP_TARGET_CLOSED', message: '此梯次目前未開放作為補課場次，請改選其他梯次' };
    }
    // 目標梯次「第一堂課已正式開始」才開放補課申請（2026-08-13 拍板）：避免補課提前佔用尚未
    // 開課梯次的名額、排擠該梯次正在進行中的正式報名。用該梯次首堂真實日期（unlimitedPracticeStart，
    // 首次產生場次時寫入，見 createWeeklySessions）判斷；缺此欄位（極舊/手動建立的課程）才退回
    // startDate，兩者皆無則不擋（放行，避免因資料缺漏誤傷合法申請）。同班別補課因來源梯次本身
    // 已開課過（否則不會有請假紀錄），天然不受此限。
    const targetFirstDate = targetCourse.unlimitedPracticeStart || targetCourse.startDate || null;
    if (targetFirstDate && taiwanToday() < targetFirstDate) {
      throw { code: 'TARGET_NOT_STARTED', message: `此梯次尚未開課（首堂 ${targetFirstDate}），須等第一堂課正式開始後才開放補課申請，避免佔用正式報名名額` };
    }
  }

  const now = new Date();

  // 建立補課報名（memberName 權威補齊——報表/名單顯示用，缺了會 fallback 成 memberId）
  const _mDoc = await db.collection('members').doc(memberId).get();
  const _mName = _mDoc.exists ? (_mDoc.data().name || '') : '';
  const enrollmentId = uuidv4();
  await db.collection(ENROLLMENT_COLLECTION).doc(enrollmentId).set({
    id: enrollmentId,
    memberId,
    memberName: _mName,
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

  await notifyCourseManagers({
    gymId: session.gymId, type: 'course_makeup_booked',
    title: '補課預約',
    body: `${_mName || '學員'} 已預約補課：${session.courseName || ''} ${session.date} ${session.startTime || ''}（佔 1 個名額）`,
    referenceId: enrollmentId,
    link: `/staff/courses?course=${session.courseId}`,
  });

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

  // 報名層級欄位（enrollGender/enrollAge/enrollNote/healthNote/referralSource）header fallback：
  // 這幾個欄位只寫在該會員這門課的「第一堂」場次文件（idx===0，見 enroll-all/claimPendingCourseEnrollment），
  // 查看的若不是第一堂，slot 本身會是 null，要靠 courseRegistrations header 補回同一筆值。
  const courseId = roster[0]?.courseId;
  const headerMap = {};
  if (courseId && memberIds.length) {
    for (let i = 0; i < memberIds.length; i += 30) {
      const batch = memberIds.slice(i, i + 30);
      const hSnap = await db.collection('courseRegistrations')
        .where('courseId', '==', courseId).where('memberId', 'in', batch).get();
      hSnap.forEach(hd => { headerMap[hd.data().memberId] = hd.data(); });
    }
  }

  const result = roster.map(r => {
    const header = headerMap[r.memberId] || {};
    return {
      ...r,
      memberName: memberInfoMap[r.memberId]?.name || r.memberName || '',
      memberPhone: memberInfoMap[r.memberId]?.phone || '',
      attendanceStatus: attendanceMap[r.memberId] || 'pending',
      enrollGender: r.enrollGender || header.enrollGender || null,
      enrollAge: r.enrollAge ?? header.enrollAge ?? null,
      enrollNote: r.enrollNote || header.enrollNote || null,
      healthNote: r.healthNote || header.healthNote || null,
      referralSource: r.referralSource || header.referralSource || null,
    };
  });
  // 跨期補課（上一梯/密集班學員補到此場次，非會員名單）→ 名單附註記列
  try {
    const xm = await db.collection('crossCohortMakeups')
      .where('targetSessionId', '==', sessionId).get();
    xm.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => x.status !== 'cancelled').forEach(x => {
      result.push({
        id: 'xm_' + x.id, memberId: null, memberName: x.name, memberPhone: '',
        status: 'confirmed', isMakeup: true, isCrossMakeup: true,
        crossNote: x.note || '', attendanceStatus: x.status === 'done' ? 'present' : 'pending',
      });
    });
  } catch (e) {}
  return result;
};

// ── 查詢課程列表 ──────────────────────────────────────────────────
// ── 課程狀態標籤（報名中/即將開始/進行中/已滿/已結束/已取消）──────
// 可作為試上/補課場次（開關 mode）：'off'=強制不開放｜'on'=強制開放｜'auto'/未設=常態報名達 2 人自動開放。
// 試上、補課為「兩個獨立開關」（trialTarget / makeupTarget）。regularCount＝常態報名不重複人數（不含試上/補課）。
// 週課預設一律開放（2026-08 起簡化，不再受「常態報名達 2 人」門檻限制），
// 但仍尊重明確設為 'off' 的特殊情況（如密集班刻意不開放作補課）。
// courseType 未帶入時沿用舊開關邏輯（供未遷移的呼叫端相容）。
const isTargetOpen = (mode, regularCount, courseType) => {
  if (courseType === 'weekly') return mode !== 'off';
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return (regularCount || 0) >= 2;
};

// 批次取出多個 categoryId 對應的 alumniGroup（舊生資格互通標籤）；未設定者為 null。
const getAlumniGroupMap = async (db, categoryIds) => {
  const ids = [...new Set((categoryIds || []).filter(Boolean))];
  const map = {};
  for (let i = 0; i < ids.length; i += 20) {
    const refs = ids.slice(i, i + 20).map(id => db.collection(CATEGORY_COLLECTION).doc(id));
    (await db.getAll(...refs)).forEach(doc => { if (doc.exists) map[doc.id] = doc.data().alumniGroup || null; });
  }
  return map;
};

// 判斷兩個班別是否視為「同一舊生範疇」：完全同一 categoryId，或雙方都設了同一個 alumniGroup
// （雙向對稱標籤——如小蜘蛛人/青少年/成人共用同一 alumniGroup，任一旁舊生互通其他班別）。
const sameAlumniScope = (catA, catB, groupMap) => {
  if (!catA || !catB) return false;
  if (catA === catB) return true;
  const ga = groupMap[catA], gb = groupMap[catB];
  return !!ga && ga === gb;
};

// ── 舊生/續報狀態（後端權威）──────────────────────────────────────
// isAlumni＝同班別（或同 alumniGroup 互通班別）任一梯次曾有效報名（confirmed/leave，排除試上/補課）；
// isFullTermRenewal＝其中有「前一期(結束<開課前60天內)整期(堂數達 totalSessions)」報名。
// ⚠ 與 courses.js handleEnrollAll 共用同一份（皆呼叫此函式，勿另外複製一份判定邏輯）。
const computeAlumniStatus = async (db, course, courseId, memberId) => {
  const today = taiwanToday();
  const alumni = { isAlumni: false, isFullTermRenewal: false };
  const need = course.fullTermRenewalDiscountEnabled || course.alumniDiscountEnabled || !!course.enrollOpenDate;
  if (!need || !memberId) return alumni;
  const myEn = await db.collection(ENROLLMENT_COLLECTION).where('memberId', '==', memberId).get();
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
  const prevTermCutoff = dayjs(course.startDate || today).subtract(60, 'day').format('YYYY-MM-DD');

  const otherCourseCats = {}; // courseId -> 課程文件
  for (let i = 0; i < otherIds.length; i += 20) {
    const refs = otherIds.slice(i, i + 20).map(id => db.collection(COURSE_COLLECTION).doc(id));
    (await db.getAll(...refs)).forEach(doc => { if (doc.exists) otherCourseCats[doc.id] = doc.data(); });
  }
  const groupMap = await getAlumniGroupMap(db, [course.categoryId, ...Object.values(otherCourseCats).map(c => c.categoryId)]);
  Object.entries(otherCourseCats).forEach(([cid2, c2]) => {
    if (!sameAlumniScope(c2.categoryId, course.categoryId, groupMap)) return;
    alumni.isAlumni = true;
    const fullTerm = !c2.totalSessions || byCourse[cid2].total >= c2.totalSessions;
    const recent = !c2.endDate || c2.endDate >= prevTermCutoff;
    if (fullTerm && recent) alumni.isFullTermRenewal = true;
  });

  // 舊系統（BeClass 等）舊生名單匯入補判：僅補「舊生(isAlumni)」，不補「續報(isFullTermRenewal)」
  // （匯入資料只證明曾報名繳費、無法確認整期出席，續報仍須系統內實際紀錄佐證）。
  if (!alumni.isAlumni && course.categoryId) {
    try {
      const mDoc = await db.collection(COLLECTIONS.MEMBERS).doc(memberId).get();
      const legacyCats = mDoc.exists ? (mDoc.data().legacyAlumniCategoryIds || []) : [];
      const legacyGroupMap = await getAlumniGroupMap(db, [course.categoryId, ...legacyCats]);
      if (legacyCats.some(lc => sameAlumniScope(lc, course.categoryId, legacyGroupMap))) alumni.isAlumni = true;
    } catch (e) { /* 查詢失敗不影響其他判斷 */ }
  }
  return alumni;
};

// ── 週課單一報名對象的費用計算（純函式）─────────────────────────────
// 插班直接按剩餘場次計、無加成；續報/舊生為乘法折扣（各自開關+比率，續報優先、不疊加）；最後套隊員9折。
// 專班課程（categoryGroup==='special'，如個人化的「XX專班」）政策一律不適用隊員9折與續報/舊生優惠，
// 後端強制關閉、不管單一課程 fullTermRenewalDiscountEnabled/alumniDiscountEnabled 設定為何。
// ⚠ 全系統唯一算式，quote 端點與 courses.js handleEnrollAll 皆呼叫此函式，勿在別處重寫。
const computeWeeklyCourseFee = (course, { completedCount, totalCount, alumni, isTeam, categoryGroup }) => {
  const { applyTeamDiscount } = require('./teamMemberService');
  const isSpecial = categoryGroup === 'special';
  const today = taiwanToday();
  const pricePerSession = Number(course.pricePerSession) || 0;
  const isLateJoin = completedCount > 0;
  const remainingCount = totalCount - completedCount;
  const baseFee = Math.round(pricePerSession * (isLateJoin ? remainingCount : totalCount));

  const renewalOpen = !course.renewalDeadline || today <= course.renewalDeadline;
  let renewalDiscountType = null, renewalRate = null;
  if (!isSpecial && renewalOpen && alumni.isFullTermRenewal && course.fullTermRenewalDiscountEnabled) {
    renewalRate = course.fullTermRenewalDiscountRate ?? 0.9; renewalDiscountType = 'full_term_renewal';
  } else if (!isSpecial && renewalOpen && alumni.isAlumni && course.alumniDiscountEnabled) {
    renewalRate = course.alumniDiscountRate ?? 0.95; renewalDiscountType = 'alumni';
  }
  const feeAfterRenewal = renewalRate != null ? Math.round(baseFee * renewalRate) : baseFee;
  const renewalDiscount = baseFee - feeAfterRenewal;

  const teamRes = applyTeamDiscount(feeAfterRenewal, isTeam && !isSpecial);
  const fee = teamRes.discounted;
  const teamDiscount = feeAfterRenewal - fee;

  return {
    fee, baseFee,
    renewalDiscount, renewalDiscountType, renewalRate,
    isTeam, teamApplied: teamDiscount > 0, teamDiscount,
    discountResult: teamRes, // 原始隊員折扣結果物件（{original,discounted,discount,applied,...}），供呼叫端相容既有欄位名
    isLateJoin, completedCount, totalCount, remainingCount,
  };
};

// ── 工作坊退費（整筆退課，依「距開課天數」比例；每個工作坊梯次可個別設定分級，見 course.refundTiers）──
// tiers 依 daysBefore 由大到小排序，daysUntilStart（距開課天數）≥ tier.daysBefore 的第一個（最大）
// 級距即為適用比例；全部不符（開課當天或之後、或不足最低級距天數）→ 比例 0（不退）。
// 無收費工作坊（如費用直接付給講師、paidAmount=0）比例算出的金額本就是 0，不特別處理、仍走同一套核准流程。
const DEFAULT_WORKSHOP_REFUND_TIERS = [
  { daysBefore: 7, rate: 1.0 },  // 距開課 ≥7 天：全額退費
  { daysBefore: 3, rate: 0.5 },  // 3~6 天前：退 50%
  { daysBefore: 1, rate: 0.2 },  // 1~2 天前：退 20%
];                                 // 開課當天或之後：不退（無對應級距 → rate 0）

const computeWorkshopRefund = (course, { paidAmount, actuallyPaid, startDate, today }) => {
  const daysUntilStart = dayjs(startDate).diff(dayjs(today), 'day');
  const tiers = (Array.isArray(course.refundTiers) && course.refundTiers.length ? course.refundTiers : DEFAULT_WORKSHOP_REFUND_TIERS)
    .slice().sort((a, b) => b.daysBefore - a.daysBefore);
  const matchedTier = tiers.find(t => daysUntilStart >= t.daysBefore) || null;
  const rate = matchedTier ? matchedTier.rate : 0;
  const rawSuggestedRefund = Math.round((paidAmount || 0) * rate);
  const cap = actuallyPaid != null ? actuallyPaid : (paidAmount || 0);
  const suggestedRefund = Math.min(rawSuggestedRefund, cap);
  const refundNote = !paidAmount
    ? '此工作坊未收費（費用另計），無退費金額'
    : `距開課 ${daysUntilStart} 天，適用退費比例 ${Math.round(rate * 100)}%（已繳 NT$${paidAmount} × ${Math.round(rate * 100)}% = NT$${rawSuggestedRefund}）`
      + (suggestedRefund < rawSuggestedRefund ? `；因分期尚未繳完，退款上限為實收金額 NT$${suggestedRefund}` : '');
  return { suggestedRefund, suggestedPercentage: Math.round(rate * 100), refundNote, daysUntilStart, rate, tier: matchedTier };
};

// ── 試上費有效值 ──────────────────────────────────────────────────
// 梯次覆寫(trialPrice非null) > 週課單堂價公式(×1.1，四捨五入) > 班別/預設繼承（工作坊恆走此層，無單堂價概念）
const getEffectiveTrialPrice = (course, rules) => {
  if (course.trialPrice != null) return Number(course.trialPrice);
  if (course.type !== 'workshop' && course.pricePerSession) {
    return Math.round(Number(course.pricePerSession) * 1.1);
  }
  return rules.trialPrice || 0;
};

// ── 課程報名「這位會員的最終應繳」（後端權威報價，供前端顯示＝實收）──────
// 週課專用（工作坊/單場費用另走 calcEnrollmentFee）；實際算式見 computeWeeklyCourseFee。
const computeCourseFeeForMember = async (db, { courseId, memberId, byStaff = false, course = null, scheduledSessions = null }) => {
  if (!course) {
    const cDoc = await db.collection(COURSE_COLLECTION).doc(courseId).get();
    if (!cDoc.exists) throw { code: 'COURSE_NOT_FOUND' };
    course = cDoc.data();
  }
  const today = taiwanToday();
  // 場次（scheduled，與 enroll-all 同一口徑）→ 插班比例
  let sess = scheduledSessions;
  if (!sess) {
    const ss = await db.collection(SESSION_COLLECTION).where('courseId', '==', courseId).where('status', '==', 'scheduled').get();
    sess = ss.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  const completedCount = sess.filter(s => s.date < today).length;
  const totalCount = sess.length;

  const alumni = await computeAlumniStatus(db, course, courseId, memberId);

  const { isActiveTeamMember } = require('./teamMemberService');
  let isTeam = false;
  try { const m = await require('./memberService').getMember(memberId); isTeam = isActiveTeamMember(m); } catch (e) {}

  const quoteCategory = await getCategoryOf(db, course.categoryId);
  const result = computeWeeklyCourseFee(course, { completedCount, totalCount, alumni, isTeam, categoryGroup: quoteCategory?.group });

  return { ...result, price: course.price || 0, alumni, courseType: course.type };
};

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
    if (e.isMakeup || e.isTrial) return; // 常態上課人數：補課/試上為單堂行為，不計入課程層人數（場次層另有計）
    if (!enrolledByCourse[e.courseId]) enrolledByCourse[e.courseId] = new Set();
    enrolledByCourse[e.courseId].add(e.memberId);
  });

  // 課程層候補人數（不重複計算同一會員，同一位候補會員在週課每個未來場次各有一筆 waitlist 副本）
  const waitlistSnap = await db.collection(ENROLLMENT_COLLECTION)
    .where('status', '==', 'waitlist').get();
  const waitlistByCourse = {};
  waitlistSnap.docs.forEach(d => {
    const e = d.data();
    if (!waitlistByCourse[e.courseId]) waitlistByCourse[e.courseId] = new Set();
    waitlistByCourse[e.courseId].add(e.memberId);
  });

  // 工作坊：名額以「場次層」判斷——course 層 enrolledCount 是彙總，不反映各場次；
  // 只要任一「未取消、今日(含)以後」場次未滿 → 視為尚有名額（部分場次額滿不算整體額滿）。
  const workshopIds = courses.filter(c => c.type === 'workshop').map(c => c.id);
  const workshopAnyOpen = {};
  const _todayW = taiwanToday();
  for (let i = 0; i < workshopIds.length; i += 30) {
    const chunk = workshopIds.slice(i, i + 30);
    try {
      const ss = await db.collection(SESSION_COLLECTION).where('courseId', 'in', chunk).get();
      ss.docs.forEach(d => {
        const s = d.data();
        if (s.status === 'cancelled' || (s.date && s.date < _todayW)) return;
        if ((s.enrolledCount || 0) < (s.maxStudents || 0)) workshopAnyOpen[s.courseId] = true;
      });
    } catch (e) { /* 場次查詢失敗不阻斷課程列表 */ }
  }

  return courses.map(c => {
    const realEnrolled = enrolledByCourse[c.id]?.size || 0;
    const enrolledCount = realEnrolled;
    const waitlistCount = waitlistByCourse[c.id]?.size || 0;
    const cat = catMap[c.categoryId] || null;
    const _rules = resolveRules(c, cat); // 班別繼承+梯次覆寫解析後的規則（供會員端顯示，勿直接讀 course 欄位）
    return {
      ...c, enrolledCount, realEnrolled, waitlistCount,
      categoryName: cat?.name || null,
      categoryGroup: cat?.group || null,               // adult | youth | special（大類）
      categoryDescription: cat?.description || null,   // 班別共用課程介紹
      categoryImageUrl: cat?.imageUrl || null,         // 班別共用廣告照片
      makeupTypeIds: cat?.makeupTypeIds || [],         // 可補課去的類型（本班學員能補去哪些類型的課；單向）
      makeupSelfType: cat?.makeupSelfType || null,     // 本班別類型（別人補課過來時算哪一類）
      makeupGroup: cat?.makeupGroup || null,           // 舊制補課群組（相容）
      paymentMethods: c.paymentMethods || null,        // 課程層付款方式覆寫（null＝預設現金/轉帳；如運動按摩=['cash']）
      teamOpenDate: c.teamOpenDate || null,            // 工作坊隊員專屬報名開始日
      generalOpenDate: c.generalOpenDate || null,      // 工作坊一般會員報名開始日
      teamPrice: c.teamPrice != null ? c.teamPrice : null,  // 工作坊隊員優惠價
      skipSignature: c.skipSignature === true,         // 報名略過簽名流程（如運動按摩）
      collectGenderAge: c.collectGenderAge === true,   // 報名收集性別/年齡（供講師參考）
      enrollNoteLabel: c.enrollNoteLabel || null,      // 自訂備註欄標題（如「想要特別處理的部位」）
      enrollNoteRequired: c.enrollNoteRequired === true,
      refundFeeRate: _rules.handlingFeeRate ?? 0.2, // 開課後退費手續費率（預設 20%，班別/梯次可調）
      refundPreStartFeeRate: _rules.preStartFeeRate ?? 0.05, // 開課前退費手續費率（預設 5%，班別/梯次可調）
      ruleMaxLeaves: _rules.maxLeaves,                       // 整期可請假次數（報名規則方框顯示）
      ruleLeaveDeadlineHours: _rules.leaveDeadlineHours,     // 請假截止（課前 N 小時）
      ruleMakeupDeadlineDays: _rules.makeupDeadlineDays,     // 補課期限（結束後 N 天）
      makeupDeadlineDate: c.makeupDeadlineDate || null,     // 固定補課到期日（覆蓋結束+天數）
      trialTarget: c.trialTarget || 'auto',
      makeupTarget: c.makeupTarget || 'auto',
      trialTargetOpen: isTargetOpen(c.trialTarget, realEnrolled, c.type),   // effective：可否被當試上場次
      makeupTargetOpen: isTargetOpen(c.makeupTarget, realEnrolled, c.type), // effective：可否被當補課場次
      statusLabel: computeStatusLabel(c, enrolledCount),
      // 工作坊專用：任一未取消未來場次仍有名額（部分場次額滿不算整體額滿）
      anySessionOpen: c.type === 'workshop' ? !!workshopAnyOpen[c.id] : undefined,
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
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''));

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
  const _initStat = () => ({ enrolledCount: 0, leaveCount: 0, makeupCount: 0, trialCount: 0, regularCount: 0, crossMakeupCount: 0 });
  allEnrollments.forEach(e => {
    if (!statsBySession[e.sessionId]) statsBySession[e.sessionId] = _initStat();
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
  // 跨期補課（crossCohortMakeups，非會員名單）也佔名額 → 批次計入
  for (const chunk of chunks) {
    const xs = await db.collection('crossCohortMakeups').where('targetSessionId', 'in', chunk).get();
    xs.docs.forEach(d => {
      const x = d.data();
      if (x.status !== 'booked' || !x.targetSessionId) return;
      if (!statsBySession[x.targetSessionId]) statsBySession[x.targetSessionId] = _initStat();
      statsBySession[x.targetSessionId].crossMakeupCount++;
    });
  }

  // 教練存在「課程」上（場次未存 instructor），批次帶出
  const courseIds = [...new Set(sessions.map(s => s.courseId).filter(Boolean))];
  const courseDocs = await Promise.all(courseIds.map(id => db.collection(COURSE_COLLECTION).doc(id).get()));
  const instructorByCourse = {};
  courseDocs.forEach(d => { if (d.exists) instructorByCourse[d.id] = d.data().instructor || ''; });

  return sessions.map(s => {
    const st = statsBySession[s.id] || { enrolledCount: 0, leaveCount: 0, makeupCount: 0, trialCount: 0, regularCount: 0, crossMakeupCount: 0 };
    // 報名人數＝週課原報名（含請假者）；預計上課人數＝原報名−請假＋補課＋試上＋跨期補課
    const registeredCount = st.regularCount + st.leaveCount;
    const expectedCount = st.regularCount + st.makeupCount + st.trialCount + (st.crossMakeupCount || 0);
    return {
      ...s,
      instructor: s.instructor || instructorByCourse[s.courseId] || '',
      enrolledCount: st.enrolledCount,
      leaveCount: st.leaveCount,
      makeupCount: st.makeupCount,
      trialCount: st.trialCount,
      crossMakeupCount: st.crossMakeupCount || 0,   // 跨期補課（非會員名單）也佔名額
      registeredCount,
      expectedCount,
    };
  });
};

// ── 補課候選場次（會員端「選擇補課場次」彈窗專用，輕量版）──────────────
// ⚠️ 背景：原本此彈窗呼叫通用的 getCourses(全部課程)+getSessions(180天全館全課程)，
// 兩者都會全表掃描 courseEnrollments 計算報名/候補人數（供列表頁顯示用，此彈窗根本
// 不需要）——正式環境資料量成長後單次呼叫常 10~14 秒、超過前端 10 秒逾時，補課彈窗
// 靜默失敗顯示「目前沒有可補課的場次」（實際上有場次，只是查詢逾時，2026-08-17 查獲
// 王登第案例）。此函式改為：只查「補課類型相容的目標班別」底下的課程（依 categoryId
// in 查詢直接縮小範圍），週課的 makeupTargetOpen 只需看 makeupTarget!=='off'（2026-08
// 簡化後不再需要常態報名人數），完全不掃描 courseEnrollments，大幅縮小查詢量。
const getMakeupCandidateSessions = async (db, { categoryId, gymId, excludeCourseId, fromDate, toDate }) => {
  // 1) 找出「可補課去的類型」對應的目標班別（含來源班別本身）
  const destCategoryIds = new Set([categoryId].filter(Boolean));
  if (categoryId) {
    const srcCatDoc = await db.collection(CATEGORY_COLLECTION).doc(categoryId).get();
    const destTypes = srcCatDoc.exists ? (srcCatDoc.data().makeupTypeIds || []) : [];
    if (destTypes.length) {
      for (let i = 0; i < destTypes.length; i += 10) {
        const chunk = destTypes.slice(i, i + 10);
        const catSnap = await db.collection(CATEGORY_COLLECTION).where('makeupSelfType', 'in', chunk).get();
        catSnap.docs.forEach(d => destCategoryIds.add(d.id));
      }
    }
  }
  if (destCategoryIds.size === 0) return { sessions: [] }; // 補課券未存 categoryId（極舊資料）→ 交由前端 fallback 全查

  // 2) 該範圍內的課程（依 categoryId in + gymId，跳過工作坊/已取消）
  const catIds = [...destCategoryIds];
  const categoryNameById = {};
  for (let i = 0; i < catIds.length; i += 10) {
    const refs = catIds.slice(i, i + 10).map(id => db.collection(CATEGORY_COLLECTION).doc(id));
    (await db.getAll(...refs)).forEach(d => { if (d.exists) categoryNameById[d.id] = d.data().name || ''; });
  }
  const courses = [];
  for (let i = 0; i < catIds.length; i += 10) {
    const chunk = catIds.slice(i, i + 10);
    let ref = db.collection(COURSE_COLLECTION).where('categoryId', 'in', chunk).where('status', '==', 'active');
    if (gymId) ref = ref.where('gymId', '==', gymId);
    const snap = await ref.get();
    snap.docs.forEach(d => {
      const c = { id: d.id, ...d.data() };
      if (c.type === 'workshop' || c.id === excludeCourseId) return;
      // 週課補課場次開放：只看 makeupTarget!=='off'（2026-08 簡化，不需常態報名人數）
      if ((c.makeupTarget || 'auto') === 'off') return;
      courses.push(c);
    });
  }
  if (courses.length === 0) return { sessions: [] };

  // 3) 這些候選課程在日期範圍內的場次
  const courseIds = courses.map(c => c.id);
  const from = fromDate || taiwanToday();
  const to = toDate || dayjs().add(180, 'day').format('YYYY-MM-DD');
  const sessions = [];
  for (let i = 0; i < courseIds.length; i += 10) {
    const chunk = courseIds.slice(i, i + 10);
    const snap = await db.collection(SESSION_COLLECTION)
      .where('courseId', 'in', chunk).where('date', '>=', from).where('date', '<=', to).get();
    snap.docs.forEach(d => {
      const s = d.data();
      if (s.status === 'cancelled') return;
      sessions.push({ id: d.id, ...s });
    });
  }

  const courseById = {};
  courses.forEach(c => { courseById[c.id] = c; });
  const enriched = sessions.map(s => {
    const c = courseById[s.courseId] || {};
    return {
      ...s,
      courseName: c.name || '',
      categoryName: categoryNameById[c.categoryId] || '',
      courseFirstDate: c.unlimitedPracticeStart || c.startDate || null,
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''));

  return { sessions: enriched };
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
    const link = `/staff/courses?course=${session.courseId}`;
    if (coachId) {
      await createNotification({ gymId: session.gymId, targetStaffId: coachId, type: 'course_substitute', title, body, referenceId: sessionId, referenceType: 'courseSession', link });
    }
    await notifyRoleInGym({ gymId: session.gymId, role: 'gym_manager', type: 'course_substitute', title, body, referenceId: sessionId, referenceType: 'courseSession', link });
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
    await notifyRoleInGym({ gymId: session.gymId, role: 'gym_manager', type: 'course_substitute_cancel', title, body, referenceId: sessionId, referenceType: 'courseSession', link: `/staff/courses?course=${session.courseId}` });
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
  // 候選：開放試上（allowTrial）且未取消/未停用
  const candidates = courseSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.status !== 'cancelled' && c.isActive !== false && resolveRules(c, cats[c.categoryId]).allowTrial === true);
  if (candidates.length === 0) return [];
  // 各候選課「常態報名不重複人數」（不含試上/補課）→ 供 trialTarget=auto 的達 2 人判定
  const regularByCourse = {};
  const enrSnap = await db.collection(ENROLLMENT_COLLECTION).where('status', '==', 'confirmed').get();
  enrSnap.docs.forEach(x => { const e = x.data(); if (e.isMakeup || e.isTrial) return; (regularByCourse[e.courseId] = regularByCourse[e.courseId] || new Set()).add(e.memberId); });
  const trialCourses = {};
  candidates.forEach(c => {
    if (!isTargetOpen(c.trialTarget, regularByCourse[c.id]?.size || 0, c.type)) return; // 週課一律列出；非週課仍走開關
    const rules = resolveRules(c, cats[c.categoryId]);
    trialCourses[c.id] = { trialPrice: getEffectiveTrialPrice(c, rules), courseName: c.name, instructor: c.instructor || '', maxWaitlist: (c.maxWaitlist ?? null), categoryName: cats[c.categoryId]?.name || '其他', categoryGroup: cats[c.categoryId]?.group || null, cohortName: c.cohortName || '' };
  });
  if (Object.keys(trialCourses).length === 0) return [];

  const from = fromDate || taiwanToday();
  // 試上只開放「報名日 2 週內」的場次（政策 2026-07-20）→ to 一律夾為 today+14
  const cap = dayjs(taiwanToday()).add(14, 'day').format('YYYY-MM-DD');
  const rawTo = toDate || dayjs(from).add(60, 'day').format('YYYY-MM-DD');
  const to = rawTo < cap ? rawTo : cap;
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
      categoryName: trialCourses[s.courseId].categoryName,
      categoryGroup: trialCourses[s.courseId].categoryGroup,
      cohortName: trialCourses[s.courseId].cohortName,
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
    // 現金折抵（redemptionType:'cash_credit'，如無可補課時段改折抵費用）不是可到課補課的資格，
    // 不列入會員端「補課資格」（否則會誤以為可以點去約課）
    .filter(m => m.redemptionType !== 'cash_credit')
    .filter(m => !m.expiresAt || today.isBefore(dayjs(m.expiresAt.toDate())))
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
  precheckCancelLeave,
  cancelMakeup,
  closureCancelSession,
  reconcileMakeupEntitlement,
  promoteWaitlist,
  promoteWaitlistForCourse,
  trialPaymentDeadline,
  sweepExpiredTrialPayments,
  cancelCourseEnrollments,
  sweepExpiredCoursePayments,
  enrollMakeup,
  markAttendance,
  markTodayCourseAttendanceOnEntry,
  getSessionRoster,
  getCourses,
  computeCourseFeeForMember,
  computeWeeklyCourseFee,
  computeWorkshopRefund,
  DEFAULT_WORKSHOP_REFUND_TIERS,
  getEffectiveTrialPrice,
  computeAlumniStatus,
  getSessions,
  getMakeupCandidateSessions,
  getTrialSessions,
  enrollTrial,
  removeTrialEnrollment,
  setSessionSubstitute,
  clearSessionSubstitute,
  getMemberEnrollments,
  getMemberMakeupRights,
};
