// 課程暫停「回課」流程（2026-10-07 政策）
//
// 暫停核准時（courseAdjustments.js approve type==='pause'）：該期未來堂數的名額釋放，並建立一筆「暫停餘額」
// （coursePauseCredits）記下剩餘堂數。學員通常是下一期才回來，所以回來時不是「恢復原課程」，而是：
//   1. 原課程結束後，系統自動把暫停餘額收尾成「待回課」（sweepPauseCredits，每小時掃，冪等）
//   2. 員工指定「回課的課程梯次」＋「開始日期」→ 從該日起依序把剩餘堂數以「補課」方式排進該梯次的上課日
//      （enrollment 標 isMakeup + pauseResume，不經補課券、不佔補課額度）
//   3. 這段期間學員享有「課程學員」免費入場（開始日～最後一堂補課日，連續區間；一般補課只有上課當天）
//   4. 補課堂數用完後若要續上該梯次剩下的堂數 → 走一般「插班報名」，從最後一堂補課日之後起算堂數與費用，
//      舊生折扣（暫停者仍算舊生；但不算「整期續報」）
//
// 狀態：paused（暫停中，同期可用 restore 端點恢復）→ awaiting_resume（原課程已結束，待安排回課）→
//       resumed（剩餘堂數全數排完）；restored＝同期以 restore 恢復。

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');
const { taiwanToday } = require('../utils/taiwanDate');

const CREDITS = 'coursePauseCredits';
const ENROLLMENTS = 'courseEnrollments';
const SESSIONS = 'courseSessions';
const COURSES = 'courses';

// 該課程是否已結束：沒有任何「今天(含)以後、未取消」的場次
const isCourseEnded = async (db, courseId) => {
  const today = taiwanToday();
  const snap = await db.collection(SESSIONS).where('courseId', '==', courseId).where('status', '==', 'scheduled')
    .select('date').get();
  return !snap.docs.some(d => (d.data().date || '') >= today);
};

// 暫停核准時建立暫停餘額（remainingSessions＝這次被暫停的堂數）
const createPauseCredit = async (db, { request, pausedCount, course }) => {
  if (!pausedCount) return null;
  const id = uuidv4();
  const now = new Date();
  const credit = {
    id, memberId: request.memberId, memberName: request.memberName || '',
    courseId: request.courseId, courseName: request.courseName || course?.name || '',
    categoryId: course?.categoryId || null, gymId: request.gymId || course?.gymId || null,
    pauseRequestId: request.id,
    totalSessions: pausedCount, remainingSessions: pausedCount,
    status: 'paused', arrangedDates: [], createdAt: now, updatedAt: now,
  };
  await db.collection(CREDITS).doc(id).set(credit);
  return credit;
};

// 原課程結束 → 暫停餘額由「paused」收尾成「awaiting_resume」（待安排回課）
const sweepPauseCredits = async () => {
  const db = getDb();
  const snap = await db.collection(CREDITS).where('status', '==', 'paused').get();
  let closed = 0;
  const endedCache = {};
  const now = new Date();
  for (const d of snap.docs) {
    const c = d.data();
    if (endedCache[c.courseId] === undefined) endedCache[c.courseId] = await isCourseEnded(db, c.courseId);
    if (!endedCache[c.courseId]) continue;
    await d.ref.update({ status: 'awaiting_resume', courseEndedAt: now, updatedAt: now });
    closed++;
  }
  return { closed };
};

// 同期以 restore 恢復 → 該會員此課程的暫停餘額標 restored
const markCreditsRestored = async (db, memberId, courseId) => {
  const snap = await db.collection(CREDITS).where('memberId', '==', memberId).get();
  const now = new Date();
  for (const d of snap.docs) {
    const c = d.data();
    if (c.courseId === courseId && ['paused', 'awaiting_resume'].includes(c.status)) {
      await d.ref.update({ status: 'restored', restoredAt: now, updatedAt: now });
    }
  }
};

// 學員在某課程「暫停回課」的最後一堂補課日（沒有則 null）——插班報名據此從該日之後起算堂數/費用
const getResumeCutoff = async (db, memberId, courseId) => {
  const snap = await db.collection(ENROLLMENTS).where('memberId', '==', memberId).where('courseId', '==', courseId)
    .where('status', '==', 'confirmed').select('pauseResume', 'date').get();
  let max = null;
  snap.docs.forEach(d => { const e = d.data(); if (e.pauseResume && e.date && (!max || e.date > max)) max = e.date; });
  return max;
};

// 安排回課：dryRun（apply=false）只回傳預計排哪幾天；apply=true 實際建立報名
const arrangeResume = async ({ creditId, targetCourseId, startDate, apply = false, staff }) => {
  const db = getDb();
  const err = (code, message) => { const e = new Error(message); e.code = code; e.status = 400; return e; };
  const cDoc = await db.collection(CREDITS).doc(creditId).get();
  if (!cDoc.exists) throw Object.assign(err('NOT_FOUND', '找不到暫停餘額'), { status: 404 });
  const credit = cDoc.data();
  if (!['paused', 'awaiting_resume'].includes(credit.status) || !(credit.remainingSessions > 0)) {
    throw err('NOTHING_TO_ARRANGE', '此暫停餘額已無剩餘堂數可安排');
  }
  if (!(await isCourseEnded(db, credit.courseId))) {
    throw err('COURSE_NOT_ENDED', '原課程尚未結束；同一期中途回來請用「恢復」，下一期回課要等原課程結束後再安排');
  }
  const today = taiwanToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) throw err('INVALID_START_DATE', '請選擇回課開始日期');
  if (startDate < today) throw err('INVALID_START_DATE', '開始日期不可早於今天');

  const tDoc = await db.collection(COURSES).doc(targetCourseId).get();
  if (!tDoc.exists) throw err('TARGET_NOT_FOUND', '找不到指定的回課梯次');
  const target = tDoc.data();
  if (target.type === 'workshop') throw err('TARGET_INVALID', '回課梯次須為週課');
  if (target.status === 'cancelled' || target.isActive === false) throw err('TARGET_INVALID', '指定的梯次已取消或停用');
  if (targetCourseId === credit.courseId) throw err('TARGET_INVALID', '回課梯次不可是原課程');
  if (credit.gymId && target.gymId && credit.gymId !== target.gymId) throw err('TARGET_INVALID', '回課梯次須與原課程同一館別');
  {
    const cs = require('./courseService');
    const groupMap = await cs.getAlumniGroupMap(db, [credit.categoryId, target.categoryId]);
    if (!cs.sameAlumniScope(credit.categoryId, target.categoryId, groupMap)) {
      throw err('TARGET_INVALID', '回課梯次須與原課程同班別（或同舊生範疇）');
    }
  }

  const sessSnap = await db.collection(SESSIONS).where('courseId', '==', targetCourseId).where('status', '==', 'scheduled').get();
  const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.date >= startDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const myEn = await db.collection(ENROLLMENTS).where('memberId', '==', credit.memberId).where('courseId', '==', targetCourseId)
    .where('status', 'in', ['confirmed', 'waitlist', 'leave']).select('sessionId').get();
  const mySessions = new Set(myEn.docs.map(d => d.data().sessionId));

  const plan = [], skipped = [];
  for (const s of sessions) {
    if (plan.length >= credit.remainingSessions) break;
    if (mySessions.has(s.id)) { skipped.push({ date: s.date, reason: '學員已在該堂名單' }); continue; }
    if ((s.enrolledCount || 0) >= (s.maxStudents || 0)) { skipped.push({ date: s.date, reason: '該堂已額滿' }); continue; }
    plan.push(s);
  }
  const shortage = credit.remainingSessions - plan.length;
  const preview = {
    credit: { id: credit.id, memberName: credit.memberName, courseName: credit.courseName, remainingSessions: credit.remainingSessions },
    target: { id: targetCourseId, name: target.name },
    startDate, dates: plan.map(s => s.date), skipped, shortage,
    accessEnd: plan.length ? plan[plan.length - 1].date : null,
  };
  if (!apply) return preview;
  if (plan.length === 0) throw err('NO_SESSIONS', '指定日期起沒有可排的場次（已額滿或場次不足）');

  const now = new Date();
  const accessEnd = plan[plan.length - 1].date;
  const memberDoc = await db.collection('members').doc(credit.memberId).get();
  const memberName = memberDoc.exists ? (memberDoc.data().name || credit.memberName) : credit.memberName;
  const staffTag = staff ? `${staff.name || staff.id}` : '';
  await db.runTransaction(async (tx) => {
    const sRefs = plan.map(s => db.collection(SESSIONS).doc(s.id));
    const sDocs = await Promise.all(sRefs.map(r => tx.get(r)));
    sDocs.forEach((sd, i) => {
      const d = sd.data() || {};
      if ((d.enrolledCount || 0) >= (d.maxStudents || 0)) throw err('SESSION_FULL', `${plan[i].date} 剛剛被補滿，請重新預覽`);
    });
    plan.forEach((s, i) => {
      const eid = uuidv4();
      tx.set(db.collection(ENROLLMENTS).doc(eid), {
        id: eid, memberId: credit.memberId, memberName, sessionId: s.id,
        courseId: targetCourseId, courseName: target.name, gymId: s.gymId || target.gymId || null,
        date: s.date, startTime: s.startTime, endTime: s.endTime,
        status: 'confirmed', isMakeup: true, makeupId: null,
        pauseResume: true, pauseCreditId: credit.id,
        resumeAccessStart: startDate, resumeAccessEnd: accessEnd, // 回課期間課程學員免費入場區間
        gymAccessStart: startDate, gymAccessEnd: accessEnd,
        enrolledBy: staff?.id || null, enrolledAt: now, createdAt: now, updatedAt: now,
        notes: `暫停回課（原課程：${credit.courseName}，補課方式；${staffTag}安排）`,
      });
      tx.update(sRefs[i], { enrolledCount: (sDocs[i].data().enrolledCount || 0) + 1, updatedAt: now });
    });
    const remaining = credit.remainingSessions - plan.length;
    tx.update(db.collection(CREDITS).doc(credit.id), {
      remainingSessions: remaining, status: remaining <= 0 ? 'resumed' : 'awaiting_resume',
      arrangedCourseId: targetCourseId, arrangedCourseName: target.name,
      arrangedDates: [...(credit.arrangedDates || []), ...plan.map(s => s.date)],
      resumeStartDate: startDate, resumeEndDate: accessEnd,
      resumedAt: now, resumedBy: staff?.id || null, updatedAt: now,
    });
  });
  return { ...preview, applied: true };
};

module.exports = { isCourseEnded, createPauseCredit, sweepPauseCredits, markCreditsRestored, getResumeCutoff, arrangeResume, CREDITS };
