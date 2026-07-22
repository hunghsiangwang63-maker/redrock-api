/*
 * simulationService.js — 模擬報名（員工端「逐步操作真實報名表」驗證）
 *  流程：員工按「模擬報名」→ 建臨時模擬會員(isSimulation)＋簽 member token → 新分頁開真實會員報名表
 *        → 員工逐步操作每一步 → 送出時，四個真實建立端點最前面的 guard 偵測 isSimulation 會員
 *        → 短路到 handleSimulatedRegistration：算費用＋寄確認信＋記 simulationRuns 日誌，回模擬成功，
 *          【完全不跑真實建立邏輯】＝真表單零改動、真流程零風險、保證不佔名額。
 *  自動清除：模擬會員/waiver/日誌 於 simExpiresAt 後由 sweep 刪除（完成後 10 分；未送出者 30 分上限）。
 */
const jwt = require('jsonwebtoken');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');
const { taiwanToday } = require('../utils/taiwanDate');
const emailService = require('./emailService');

const MAX_LIFE_MIN = 30;   // 未送出的模擬帳號最長存活
const AFTER_DONE_MIN = 10; // 送出後幾分鐘刪除
const GYM_LABEL = { 'gym-hsinchu': '新竹館', 'gym-shilin': '士林館' };
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const esc = emailService.esc;

const isSimMember = (m) => !!(m && m.isSimulation === true);

// ── 建立臨時模擬會員（waiver 完成→不封鎖；isSimulation；email=收件信箱）──
const createSimMember = async (db, { email, gymId }) => {
  const id = 'sim-' + uuidv4();
  const now = new Date();
  const member = {
    id, name: '【模擬報名】測試', phone: '0900000000', email,
    gender: 'male', birthday: '1996-01-01',
    emailVerified: true, registeredBy: 'migration',
    isSimulation: true, simExpiresAt: new Date(now.getTime() + MAX_LIFE_MIN * 60000),
    defaultGymId: gymId || 'gym-hsinchu', createdAt: now,
  };
  await db.collection('members').doc(id).set(member);
  // waiver 完成，避免 onboarding gate / isBlocked 擋住報名
  await db.collection('waivers').doc(id).set({ memberId: id, isComplete: true, isSimulation: true, signedAt: now, createdAt: now });
  return member;
};

const signSimToken = (memberId) => jwt.sign({ memberId, type: 'member' }, process.env.JWT_SECRET, { expiresIn: '2h' });

const dateLabel = (d) => `${d}（${WD[dayjs(d).day()]}）`;

// ── 送出時的模擬處理（由四個報名建立端點的 guard 呼叫）──
// 算費用 + 寄確認信 + 記日誌，回模擬成功；不建任何真實報名紀錄。
const handleSimulatedRegistration = async (db, { type, member, targetId, payload = {} }) => {
  const to = member.email;
  const SIM_NAME = member.name || '【模擬報名】測試';
  const now = new Date();
  let summary = {};

  if (type === 'course') {
    // targetId=courseId（週課整期）或 payload.sessionId（工作坊單場）
    let courseId = targetId;
    let onlySession = null;
    if (!courseId && payload.sessionId) {
      const sd = await db.collection('courseSessions').doc(payload.sessionId).get();
      if (sd.exists) { courseId = sd.data().courseId; onlySession = { id: sd.id, ...sd.data() }; }
    }
    const course = courseId ? (await db.collection('courses').doc(courseId).get()).data() : null;
    if (!course) return { ok: true, isSimulation: true, message: '🧪 模擬報名完成（找不到課程，僅測試流程）', summary: {} };
    const isWorkshop = course.type === 'workshop';
    const today = taiwanToday();
    let sessions;
    if (isWorkshop) {
      sessions = onlySession ? [onlySession] : [];
    } else {
      const ss = await db.collection('courseSessions').where('courseId', '==', courseId).where('status', '==', 'scheduled').get();
      sessions = ss.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    }
    const fee = course.price || 0;
    const gymName = GYM_LABEL[course.gymId] || '';
    const sessionLines = sessions.map(s => `${dateLabel(s.date)} ${s.startTime || ''}~${s.endTime || ''}`);
    summary = { name: course.name, gym: gymName, isWorkshop, fee, sessionCount: sessions.length, sessions: sessionLines, paymentMethod: payload.paymentMethod || 'cash', enrollNote: payload.enrollNote || payload.healthNote || null };
    await emailService.sendEmail({
      to, subject: `【紅石攀岩・模擬】課程報名確認 — ${course.name}`,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <div style="background:#FFF4E5;border:1px solid #F0D9A8;border-radius:8px;padding:10px 14px;font-size:13px;color:#8B6914;margin-bottom:16px">🧪 這是一封<strong>模擬報名</strong>測試信，用於確認報名確認信內容，非真實報名。</div>
        <h2 style="color:#8B1A1A">課程報名確認</h2><p>親愛的 ${esc(SIM_NAME)}，</p>
        <p>您已完成報名 <strong>「${esc(course.name)}」</strong>：</p>
        <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0;font-size:14px;line-height:1.9">
          <div><strong>課程：</strong>${esc(course.name)}</div><div><strong>場館：</strong>${esc(gymName)}</div>
          <div><strong>${isWorkshop ? '場次' : '共 ' + sessions.length + ' 堂'}：</strong>${esc(sessionLines[0] || '')}${sessions.length > 1 ? ` 起，共 ${sessions.length} 堂` : ''}</div>
          <div><strong>應繳金額：</strong>NT$${esc(Number(fee).toLocaleString())}</div>
        </div><p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p></div>`,
    }).catch(() => {});
  }

  else if (type === 'experience') {
    const sDoc = await db.collection('systemSettings').doc('experienceCourses').get();
    const settings = sDoc.exists ? sDoc.data() : {};
    const ct = (settings.courseTypes || []).find(c => c.id === (payload.courseType || targetId));
    const participants = Array.isArray(payload.participants) ? payload.participants : [];
    const numPeople = participants.length || payload.numParticipants || 1;
    const resolvePrice = (t, n) => {
      if (!t) return 0;
      if (Array.isArray(t.tiers) && t.tiers.length) { const h = t.tiers.find(x => n >= (x.min ?? 1) && n <= (x.max ?? 999)); return (h ? h.price : t.tiers[0].price) || 0; }
      if (t.price != null) return t.price;
      return 0;
    };
    const fee = resolvePrice(ct, numPeople) * numPeople;
    const bookingDate = payload.bookingDate || dayjs(taiwanToday()).add(3, 'day').format('YYYY-MM-DD');
    const bookingTime = payload.bookingTime || '';
    summary = { name: ct?.label || (payload.courseType || targetId), fee, numPeople, bookingDate: dateLabel(bookingDate), bookingTime };
    await emailService.sendExperienceBookingConfirmation(to, SIM_NAME, { bookingDate, bookingTime, gymId: payload.gymId || 'gym-hsinchu', numParticipants: numPeople }).catch(() => {});
  }

  else if (type === 'competition') {
    const comp = (await db.collection('competitions').doc(targetId).get()).data();
    const division = comp ? (comp.divisions || []).find(d => d.id === payload.divisionId) || (comp.divisions || [])[0] : null;
    const fees = comp?.fees || {};
    const today2 = taiwanToday();
    const isEarly = comp?.earlyBirdDeadline && today2 <= comp.earlyBirdDeadline;
    const age = payload.birthday ? dayjs().diff(dayjs(payload.birthday), 'year') : 30;
    const isChild = age < (fees.childAgeLimit || 15);
    const fee = isChild ? (isEarly ? fees.childEarlyBird : fees.childRegular) || 950 : (isEarly ? fees.adultEarlyBird : fees.adultRegular) || 1100;
    summary = { name: comp?.name, division: division?.name, fee, isEarly, eventDate: comp?.eventDate || '' };
    await emailService.sendEmail({
      to, subject: `【紅石攀岩・模擬】比賽報名確認 — ${comp?.name || ''}`,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <div style="background:#FFF4E5;border:1px solid #F0D9A8;border-radius:8px;padding:10px 14px;font-size:13px;color:#8B6914;margin-bottom:16px">🧪 這是一封<strong>模擬報名</strong>測試信，用於確認報名確認信內容，非真實報名。</div>
        <h2 style="color:#8B1A1A">比賽報名確認</h2><p>親愛的 ${esc(SIM_NAME)}，</p>
        <p>您已完成報名 <strong>「${esc(comp?.name || '')}」</strong>：</p>
        <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0;font-size:14px;line-height:1.9">
          <div><strong>賽事：</strong>${esc(comp?.name || '')}</div><div><strong>組別：</strong>${esc(division?.name || '')}</div>
          <div><strong>比賽日：</strong>${esc(comp?.eventDate || '')}</div>
          <div><strong>報名費：</strong>NT$${esc(Number(fee).toLocaleString())}${isEarly ? '（早鳥）' : ''}</div>
        </div><p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p></div>`,
    }).catch(() => {});
  }

  // 記日誌 + 送出後 AFTER_DONE_MIN 分鐘刪帳號/紀錄
  const runId = uuidv4();
  const doneExpires = new Date(now.getTime() + AFTER_DONE_MIN * 60000);
  await db.collection('simulationRuns').doc(runId).set({ id: runId, type, targetId: targetId || null, memberId: member.id, email: to, summary, isSimulation: true, createdAt: now, expiresAt: doneExpires });
  await db.collection('members').doc(member.id).set({ simExpiresAt: doneExpires, simCompletedAt: now }, { merge: true }).catch(() => {});
  return { ok: true, isSimulation: true, runId, emailedTo: to, summary, message: '🧪 模擬報名完成！已寄確認信，此為模擬、未實際報名（未佔名額）。' };
};

// ── sweep：刪過期模擬會員 + waiver + simulationRuns ──
const sweepExpiredSimulations = async (db) => {
  try {
    const now = Date.now();
    const ms = (v) => v?.toMillis ? v.toMillis() : (v ? new Date(v).getTime() : 0);
    // 過期模擬會員
    const mSnap = await db.collection('members').where('isSimulation', '==', true).get();
    let n = 0;
    for (const d of mSnap.docs) {
      const exp = ms(d.data().simExpiresAt);
      if (exp && exp < now) {
        await db.collection('waivers').doc(d.id).delete().catch(() => {});
        await d.ref.delete().catch(() => {});
        n++;
      }
    }
    // 過期日誌
    const rSnap = await db.collection('simulationRuns').get();
    for (const d of rSnap.docs) {
      const exp = ms(d.data().expiresAt);
      if (exp && exp < now) await d.ref.delete().catch(() => {});
    }
    if (n) console.log(`[simulate] sweep 清除過期模擬帳號 ${n} 筆`);
  } catch (e) { /* ignore */ }
};
if (!global.__simSweepStarted) {
  global.__simSweepStarted = true;
  setInterval(() => sweepExpiredSimulations(getDb()), 3 * 60 * 1000);
}

module.exports = { isSimMember, createSimMember, signSimToken, handleSimulatedRegistration, sweepExpiredSimulations, MAX_LIFE_MIN, AFTER_DONE_MIN };
