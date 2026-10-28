// 帶課教練在「值班月曆」看自己的課程（含代班／停課／補課人數）。
// ⚠️ 課程的 instructor 是自由文字暱稱（如「晉瑋」「閎聿」「晉瑋、品翰」「讓哥/Eric」），與員工 staff.name（全名，如「黎晉瑋」）不同，
// 沒有 staffId 綁定（只有代班場次會存 coachId）。比對規則：把 instructor 以「、 , ， / ／ & ＆」切開，
// 任一段符合「等於員工姓名」「姓名包含該段（≥2 字，如晉瑋⊂黎晉瑋）」「staff.coachAliases 含該段」即視為本人。
const dayjs = require('dayjs');
const { getDb } = require('../config/firebase');
const courseService = require('./courseService');

const splitNames = (s) => String(s || '').split(/[、,，/／&＆+]/).map(x => x.trim()).filter(Boolean);

const makeMatcher = (staff) => {
  const name = String(staff.name || '').trim();
  const aliases = (Array.isArray(staff.coachAliases) ? staff.coachAliases : []).map(a => String(a).trim()).filter(Boolean);
  const lower = aliases.map(a => a.toLowerCase());
  return (instructorText) => splitNames(instructorText).some(t =>
    t === name || (t.length >= 2 && name.includes(t)) || lower.includes(t.toLowerCase()));
};

// 該員工本人在某月的授課場次（兩館全查；一般只會在一館）
const getMyMonthSessions = async (staff, month) => {
  const db = getDb();
  const from = dayjs(`${month}-01`).format('YYYY-MM-DD');
  const to = dayjs(`${month}-01`).endOf('month').format('YYYY-MM-DD');
  const isMine = makeMatcher(staff);
  const gymSnap = await db.collection('gyms').get();
  const perGym = await Promise.all(gymSnap.docs.map(g => courseService.getSessions(g.id, from, to)));
  const out = [];
  for (const s of perGym.flat()) {
    const mineNow = s.coachId === staff.id || isMine(s.instructor);
    const wasMine = !mineNow && s.isSubstitute && isMine(s.originalInstructor);
    if (!mineNow && !wasMine) continue;
    // 體驗課程（courseName 以「體驗課程・」開頭）已有「體驗連動班」排班顯示在月曆，這裡不重複列
    if (String(s.courseName || '').startsWith('體驗課程')) continue;
    out.push({
      id: s.id, courseId: s.courseId, courseName: s.courseName || '', gymId: s.gymId,
      date: s.date, startTime: s.startTime, endTime: s.endTime, status: s.status || 'scheduled',
      instructor: s.instructor || '', originalInstructor: s.originalInstructor || '',
      role: wasMine ? 'substituted_away' : (s.isSubstitute ? 'substitute' : 'teaching'),
      substituteReason: s.substituteReason || '', notes: s.notes || '',
      registeredCount: s.registeredCount, leaveCount: s.leaveCount, makeupCount: s.makeupCount,
      trialCount: s.trialCount, crossMakeupCount: s.crossMakeupCount, expectedCount: s.expectedCount,
      maxStudents: s.maxStudents ?? null,
    });
  }
  return out.sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
};

// 本人是否為該場次的教練（含已被代班走的原教練，也能看名單）
const isMySession = async (staff, sessionId) => {
  const db = getDb();
  const sd = await db.collection('courseSessions').doc(sessionId).get();
  if (!sd.exists) return false;
  const s = sd.data(); const isMine = makeMatcher(staff);
  let instr = s.instructor;
  if (!instr) { const c = await db.collection('courses').doc(s.courseId).get(); instr = c.exists ? c.data().instructor : ''; }
  return !!(s.coachId === staff.id || isMine(instr) || (s.isSubstitute && isMine(s.originalInstructor)));
};

// 教練視角名單：不含電話；保留姓名、狀態、補課／試上標記、出席、年齡與健康／備註（上課需要）
const getMyRoster = async (sessionId) => {
  const rows = await courseService.getSessionRoster(sessionId);
  return rows.map(r => ({
    id: r.id, memberName: r.memberName || '', status: r.status, isMakeup: !!r.isMakeup, isTrial: !!r.isTrial,
    isCrossMakeup: !!r.isCrossMakeup, crossNote: r.crossNote || '', attendanceStatus: r.attendanceStatus || 'pending',
    enrollAge: r.enrollAge ?? null, healthNote: r.healthNote || '', enrollNote: r.enrollNote || '',
    isPauseResume: !!r.pauseResume,
  }));
};


// ── 通知帶課教練（員工端「通知」頁＋Email）────────────────────────────
// 學員請假／銷假／補課／取消補課／新報名時呼叫。教練判定與月曆同一套（makeMatcher）；代班場次通知「現任教練」。
// 永不拋錯、不阻斷主流程。管理層（gym_manager／super_admin）本來就會收到同事件的管理員通知，這裡不再重複發站內通知，但仍寄信。
let _staffCache = { at: 0, list: [] };
const getActiveStaff = async () => {
  if (Date.now() - _staffCache.at < 5 * 60 * 1000) return _staffCache.list;
  const snap = await getDb().collection('staff').where('isActive', '==', true).get();
  _staffCache = { at: Date.now(), list: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  return _staffCache.list;
};
const findCoachStaff = async ({ courseId, sessionId }) => {
  const db = getDb();
  let instr = '', coachId = null;
  if (sessionId) {
    const sd = await db.collection('courseSessions').doc(sessionId).get();
    if (sd.exists) { instr = sd.data().instructor || ''; coachId = sd.data().coachId || null; courseId = courseId || sd.data().courseId; }
  }
  if (!instr && courseId) {
    const cd = await db.collection('courses').doc(courseId).get();
    if (cd.exists) instr = cd.data().instructor || '';
  }
  if (!instr && !coachId) return [];
  const staff = await getActiveStaff();
  return staff.filter(s => s.role && (s.id === coachId || makeMatcher(s)(instr)));
};
const notifyCoaches = async ({ gymId, courseId, sessionId, type, title, body, referenceId, referenceType = 'courseEnrollment' }) => {
  try {
    const coaches = await findCoachStaff({ courseId, sessionId });
    if (!coaches.length) return 0;
    const { createNotification } = require('./notificationService');
    const { sendCoachCourseNotice } = require('./emailService');
    await Promise.all(coaches.map(async (c) => {
      try {
        if (!['gym_manager', 'super_admin'].includes(c.role)) {
          await createNotification({ gymId, targetRole: c.role, targetStaffId: c.id, type: `coach_${type}`, title: `【帶課】${title}`, body, referenceId, referenceType, link: '/staff/schedule' });
        }
      } catch (e) { console.error('[帶課通知-站內]', c.name, e.message); }
      try {
        if (c.email) await sendCoachCourseNotice(c.email, { coachName: c.name, title, body });
      } catch (e) { console.error('[帶課通知-Email]', c.name, e.message); }
    }));
    return coaches.length;
  } catch (e) { console.error('[帶課通知]', e.message); return 0; }
};

module.exports = { notifyCoaches, findCoachStaff, getMyMonthSessions, isMySession, getMyRoster, makeMatcher, splitNames };
