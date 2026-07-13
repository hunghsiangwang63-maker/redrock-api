/**
 * checkin/eligibility.js — 入場資格來源：定期票（含購買/續約資訊）・課程學員・VIP・單次入場券
 * 由 checkinService.js 拆分（2026-07-13 refactor）；函式本體逐字搬移、行為不變。
 * 對外 API 仍經 services/checkinService.js 門面 re-export。
 */
const { taiwanToday } = require('../../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../../config/firebase');
const dayjs = require('dayjs');

const getValidPasses = async (memberId, gymId) => {
  const passExpiryService = require('../passExpiryService');
  const db = getDb();
  const today = taiwanToday();
  const snap = await db.collection(COLLECTIONS.MEMBER_PASSES)
    .where('memberId', '==', memberId)
    .where('status', '==', 'active')
    .get();
  const withEff = await passExpiryService.attachEffectiveEndDates(
    snap.docs.map(d => ({ id: d.id, ...d.data() }))
  );
  return withEff
    .filter(p => (p.effectiveEndDate || p.endDate) >= today)
    .filter(p => !p.startDate || p.startDate <= today) // 起始日到了才算有效（未來票不提前生效）
    .filter(p => p.scope === 'shared' || p.targetGymId === gymId)
    .filter(p => p.credits === null || p.credits > 0);
};

// ── 入場可購買的定期票種（該館適用：雙館 shared 或該館單館票種）─────
// 與 GET /passes/types 的館別過濾同邏輯（!t.gymId || t.gymId === gymId）。
// 單館票種 gymId===targetGymId；雙館 shared 兩者皆 null → 不限館。
const getBuyablePassTypes = async (gymId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.PASS_TYPES).where('isActive', '==', true).get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => !t.gymId || t.gymId === gymId)
    .map(t => ({
      id: t.id, name: t.name, price: t.price, scope: t.scope,
      targetGymId: t.targetGymId || null,
      durationMonths: t.durationMonths || null,
      durationDays: t.durationDays || null,
      credits: t.credits ?? null,
      installment: t.installment || { enabled: false, periods: [] }, // 讓前端知道可否分期
      renewalDiscount: t.renewalDiscount || null,                    // 續約折扣（供續約流程）
    }))
    // 顯示順序：效期短→長；「算次數」（回數票，credits 非 null）排在「算時間」之後
    .sort((a, b) => {
      const ca = (a.credits != null) ? 1 : 0, cb = (b.credits != null) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      const da = a.durationMonths ? a.durationMonths * 30 : (a.durationDays || 0);
      const db = b.durationMonths ? b.durationMonths * 30 : (b.durationDays || 0);
      if (da !== db) return da - db;
      return (a.credits || 0) - (b.credits || 0);
    });
};

// ── 定期票續約（會員端，到期前 14 天開放）─────────────────────────
const RENEWAL_WINDOW_DAYS = 14;

// 續約後端權威價：票種 renewalDiscount（percent=打折 / amount=折抵）套用於原價，夾在 [0, price]
const computeRenewalPrice = (pt) => {
  const price = pt.price || 0;
  const rd = pt.renewalDiscount;
  if (!rd || !['percent', 'amount'].includes(rd.mode)) return price;
  const v = Number(rd.value) || 0;
  if (v <= 0) return price;
  return rd.mode === 'percent'
    ? Math.max(0, Math.round(price * (100 - Math.min(100, v)) / 100))
    : Math.max(0, price - v);
};

// 依票種算「續約後」新到期日：以現到期日（未到期）或今日（已過期）為基準加月數/天數
const computeRenewedEndDate = (currentEndDate, pt) => {
  const base = dayjs(currentEndDate).isAfter(dayjs()) ? currentEndDate : taiwanToday();
  return pt.durationMonths
    ? dayjs(base).add(pt.durationMonths, 'month').format('YYYY-MM-DD')
    : dayjs(base).add(pt.durationDays || 0, 'day').format('YYYY-MM-DD');
};

// 給一張有效定期票，若到期日 ≤ 14 天則回續約資訊（含折後價 / 分期規則），否則 null
const getRenewalInfo = async (memberPass) => {
  const db = getDb();
  const currentEndDate = memberPass.effectiveEndDate || memberPass.endDate;
  const daysLeft = dayjs(currentEndDate).diff(taiwanToday(), 'day');
  if (daysLeft > RENEWAL_WINDOW_DAYS) return null;
  if (!memberPass.passTypeId) return null;
  const ptDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(memberPass.passTypeId).get();
  if (!ptDoc.exists) return null;
  const pt = ptDoc.data();
  const fullPrice = pt.price || 0;
  const renewalPrice = computeRenewalPrice(pt);
  return {
    passId: memberPass.id,
    passTypeId: memberPass.passTypeId,
    passTypeName: pt.name || memberPass.passTypeName || '定期票',
    scope: pt.scope,
    daysLeft,
    currentEndDate,
    newEndDate: computeRenewedEndDate(currentEndDate, pt),
    fullPrice,
    renewalPrice,
    renewalDiscount: pt.renewalDiscount || null,
    installment: pt.installment?.enabled ? (pt.installment || { enabled: false, periods: [] }) : { enabled: false, periods: [] },
  };
};

// ── 取得課程入館權益 ─────────────────────────────────────────────
const getCourseAccess = async (memberId) => {
  const db = getDb();
  const today = taiwanToday();

  // 找出此會員所有「未取消、未暫停」的報名紀錄
  const enrollSnap = await db.collection(COLLECTIONS.COURSE_ENROLLMENTS)
    .where('memberId', '==', memberId)
    .where('status', '==', 'confirmed')
    .get();
  const enrollments = enrollSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(e => e.pauseStatus !== 'paused')   // 暫停中不計入課程學員資格
    .filter(e => e.refundPending !== true);    // 退費審核中：即時取消課程學員入場資格（退回時恢復）
  if (enrollments.length === 0) return [];

  const courseIds = [...new Set(enrollments.map(e => e.courseId).filter(Boolean))];
  const results = [];

  for (const courseId of courseIds) {
    const courseDoc = await db.collection('courses').doc(courseId).get();
    if (!courseDoc.exists) continue;
    const course = courseDoc.data();

    // 無限練習期間：管理員可在課程編輯頁手動設定/覆寫此區間，不一定跟課程開課/結束日綁定
    // 向下相容：舊課程若未設定此欄位，退而求其次用「開課日~最後一堂課+入館緩衝天數」估算
    const practiceStart = course.unlimitedPracticeStart || course.startDate;
    const practiceEnd = course.unlimitedPracticeEnd ||
      (course.endDate ? dayjs(course.endDate).add(course.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD') : null);
    if (!practiceStart || !practiceEnd) continue;

    // 條件1：今天在無限練習期間內
    const inPracticePeriod = practiceStart && practiceEnd && practiceStart <= today && today <= practiceEnd;

    // 條件2：今天有課程場次且該會員有報名（OR 邏輯）
    let hasSessionToday = false;
    if (!inPracticePeriod) {
      const sessionSnap = await db.collection('courseSessions')
        .where('courseId', '==', courseId)
        .where('date', '==', today)
        .limit(1)
        .get();
      if (!sessionSnap.empty) {
        const sessionId = sessionSnap.docs[0].id;
        const enrolledToday = enrollments.find(en => en.courseId === courseId && en.sessionId === sessionId);
        hasSessionToday = !!enrolledToday || enrollments.some(en => en.courseId === courseId);
      }
    }

    if (inPracticePeriod || hasSessionToday) {
      const e = enrollments.find(en => en.courseId === courseId);
      results.push({
        id: e.id, courseId, courseName: course.name,
        gymAccessStart: practiceStart, gymAccessEnd: practiceEnd,
      });
    }
  }
  return results;
};

// ── VIP 查詢 ────────────────────────────────────────────────────
const checkVip = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.VIP_MEMBERS)
    .where('memberId', '==', memberId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
};

// ── 取得有效單次入場券 ───────────────────────────────────────────
const getValidSingleEntryTickets = async (memberId) => {
  const db = getDb();
  const today = taiwanToday();
  const snap = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS)
    .where('memberId', '==', memberId)
    .where('status', '==', 'active')
    .where('expiresAt', '>=', today)
    .get();
  // 體驗入場券限「validDate 當天」使用；一般單次券無 validDate 不受限
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(t => !t.validDate || t.validDate === today);
};

// ── 墜落測驗：查詢 + 遞延邏輯 ───────────────────────────────────
module.exports = { getValidPasses, getBuyablePassTypes, RENEWAL_WINDOW_DAYS, computeRenewalPrice, computeRenewedEndDate, getRenewalInfo, getCourseAccess, checkVip, getValidSingleEntryTickets };
