/**
 * 入場驗票 Service（完整版 v2）
 * 驗票順序：VIP → 定期券 → 課程入館 → 優惠卡 → 黑卡 → 單次入場券 → 無票
 * 新增：VIP、單次入場券、兒童/學生身份、墜落測驗2年+遞延、QR code流程、10分鐘取消
 */
const { taiwanToday } = require('../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../config/firebase');
const { getMember } = require('./memberService');
const { getValidDiscountCards, useDiscountCard } = require('./discountCardService');
const { getMemberBlackCards, useBlackCard, getBlackCardById, refundBlackCard } = require('./legacyCardService');
const { isActiveTeamMember, TEAM_DISCOUNT_MIN_AMOUNT } = require('./teamMemberService');
const { isChild } = require('../utils/age');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

// ── 票價設定 ────────────────────────────────────────────────────
const PRICES = {
  single_general: 350,
  single_child: 0,       // 兒童免費（未滿13歲）
  single_student: 0,     // 學生免費（13~22歲或已驗證學生證）
  discount_card: 600,    // 購買優惠折扣券（含本次入場）
  shoes_rental: 100,     // 岩鞋租借
  team_discount_rate: 0.9,
  team_discount_min: 100,
};

// 使用優惠折扣券入場：原價 8 折（兒童不適用）。原價依會員身份取 entryTypes 價格。
const DISCOUNT_CARD_RATE = 0.8;
// 特約廠商入場優惠：全票/學生票在「無其他折扣」時定額 −N（兒童不適用；與隊員9折/舊折扣卡8折互斥）。
// 金額與啟用開關可於員工端「系統設定 → 入場規則」設定（systemSettings/partnerVendor）；讀不到 fallback 啟用+20。
const PARTNER_VENDOR_DISCOUNT = 20;   // fallback 預設
const getPartnerVendorConfig = async () => {
  try {
    const doc = await getDb().collection('systemSettings').doc('partnerVendor').get();
    const d = doc.exists ? doc.data() : {};
    return { enabled: d.enabled !== false, discount: Number.isFinite(d.discount) ? d.discount : PARTNER_VENDOR_DISCOUNT };
  } catch { return { enabled: true, discount: PARTNER_VENDOR_DISCOUNT }; }
};

// 取得「原價」（折扣券 8 折的基準）：一般→single_ticket，學生→student_free
const getOriginalEntryPrice = async (memberType) => {
  const id = memberType === 'student' ? 'student_free' : 'single_ticket';
  const fallback = memberType === 'student' ? 250 : PRICES.single_general;
  return getEntryTypePrice(id, fallback);
};

// ── 墜落測驗：有效期 1 年，期限內每入場2次遞延1年 ────────────────
const FALL_TEST_VALID_YEARS = 1;       // 初次效期（與登記時 settings.validYears 預設一致）
const FALL_TEST_EXTENSION_VISITS = 2;  // 觸發遞延所需入場次數
const FALL_TEST_EXTENSION_YEARS = 1;   // 每次遞延年數

// 解析墜測有效期：優先 currentExpiresAt（含遞延），其次登記時的 expiresAt，最後回推 testedAt + 效期年數
const resolveFallTestExpiry = (test) => {
  if (test.currentExpiresAt) return dayjs(test.currentExpiresAt);
  const raw = test.expiresAt;
  const sec = raw?.seconds || raw?._seconds;
  if (sec) return dayjs(sec * 1000);
  if (raw) return dayjs(raw);
  return dayjs(test.testedAt.toDate()).add(FALL_TEST_VALID_YEARS, 'year');
};

// ── 身份別判斷 ──────────────────────────────────────────────────
// 優先序：VIP > 課程學員 > 攀岩隊員 > 兒童(未滿13) > 學生(13-22) > 一般
const getMemberType = (member) => {
  if (member.memberType === 'vip') return 'vip';
  if (member.memberType === 'climbing_team') return 'climbing_team';
  if (!member.birthday) return 'general';
  const age = dayjs().diff(dayjs(member.birthday), 'year');
  if (age < 13) return 'child';
  if (age <= 22) return 'student';
  if (member.memberType === 'student' && member.studentVerified) return 'student';
  return 'general';
};

const isFreeEntry = (memberType) => memberType === 'child' || memberType === 'student';

// 入場價由 systemSettings/entryTypes 設定（可隨時調整；找不到用 fallback）
const getEntryTypePrice = async (entryTypeId, fallback) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('entryTypes').get();
    if (!doc.exists) return fallback;
    const t = (doc.data().types || []).find(x => x.id === entryTypeId);
    return (t && typeof t.price === 'number') ? t.price : fallback;
  } catch (e) { return fallback; }
};

// ── 付費入場金額（唯一權威來源）─────────────────────────────────
// 依 entryTypes 設定計算付費入場金額，套用（可選）舊折扣卡 8 折 + 有效隊員 9 折。
// QR 自助入場（createPendingCheckIn）與站台電話入場（/checkin/phone）共用此邏輯，
// 折扣規則只有一份，避免站台漏帶隊員折扣。
// opts.legacyDiscountCard=true → 先套 8 折（舊實體折扣卡，轉換期用），有效隊員再疊 9 折。
// 隊員 9 折的門檻一律以「原價 >= TEAM_DISCOUNT_MIN_AMOUNT」判斷（與 discount_card 疊加規則一致）。
// 找不到對應的付費入場類型時回 null，由呼叫端沿用自身 fallback。
const computePaidEntryAmount = async (entryType, member, opts = {}) => {
  const db = getDb();
  const etDoc = await db.collection('systemSettings').doc('entryTypes').get();
  const t = etDoc.exists
    ? (etDoc.data().types || []).find(x => x.id === entryType && x.active !== false)
    : null;
  if (!t || typeof t.price !== 'number') return null;
  const originalAmount = t.price;
  // 兒童：不適用折扣卡、也不會是隊員 → 一律原價，任何折扣都不套（權威擋，涵蓋電話入場與 QR 自助）
  if (entryType === 'child_free') {
    return { amount: originalAmount, originalAmount, isTeamDiscount: false, legacyDiscount: false, partnerVendor: false };
  }
  const isTeam = isActiveTeamMember(member);
  const teamEligible = isTeam && originalAmount >= TEAM_DISCOUNT_MIN_AMOUNT;
  let amount = originalAmount;
  if (opts.legacyDiscountCard) amount = Math.round(amount * DISCOUNT_CARD_RATE); // 舊折扣卡 8 折
  if (teamEligible) amount = Math.round(amount * PRICES.team_discount_rate);      // 有效隊員再疊 9 折
  // 特約廠商：僅當【未套舊折扣卡 且 非有效隊員】且全票/學生票 → 定額 −N（權威互斥，隊員/舊卡任一成立即忽略；設定停用/金額 0 則不套）
  let partnerVendor = false;
  if (!opts.legacyDiscountCard && !teamEligible && opts.partnerVendor
      && (entryType === 'single_ticket' || entryType === 'student_free')) {
    const pv = await getPartnerVendorConfig();
    if (pv.enabled && pv.discount > 0) {
      amount = Math.max(0, originalAmount - pv.discount);
      partnerVendor = true;
    }
  }
  return {
    amount, originalAmount,
    isTeamDiscount: teamEligible,
    legacyDiscount: !!opts.legacyDiscountCard,
    partnerVendor,
  };
};

// ── 取得有效定期票 ───────────────────────────────────────────────
// endDate 改用「補償後到期日」（臨時休館延長票期，公休不補）→ 不在 Firestore 端以 endDate 預篩，
// 改抓全部 active 後在程式碼用 effectiveEndDate 判斷（會員 active 票很少，成本可忽略）。
const getValidPasses = async (memberId, gymId) => {
  const passExpiryService = require('./passExpiryService');
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
    .filter(e => e.pauseStatus !== 'paused'); // 暫停中不計入課程學員資格
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
const checkFallTest = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.FALL_TESTS)
    .where('memberId', '==', memberId)
    .where('result', '==', 'passed')
    .get();

  if (snap.empty) return { passed: false, reason: 'never_tested' };

  // 客戶端排序取最新一筆
  const tests = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
    const ta = a.testedAt?.seconds || 0;
    const tb = b.testedAt?.seconds || 0;
    return tb - ta;
  });
  const last = tests[0];
  const fallTestId = last.id;

  // 計算目前有效期（含所有遞延）
  const baseExpiry = resolveFallTestExpiry(last);

  const today = dayjs();
  const isExpired = today.isAfter(baseExpiry);

  if (isExpired) {
    return { passed: false, reason: 'expired', expiredAt: baseExpiry.format('YYYY-MM-DD') };
  }

  return {
    passed: true,
    fallTestId,
    expiresAt: baseExpiry.format('YYYY-MM-DD'),
    extensionCount: last.extensionCount || 0,
  };
};

// ── 是否已簽署墜落測驗同意書（與「是否通過」不同；體驗券入場僅需簽署）──
const hasFallTestSignature = async (memberId) => {
  const db = getDb();
  const snap = await db.collection('fallTestSignatures').where('memberId', '==', memberId).limit(1).get();
  return !snap.empty;
};

// ── 墜落測驗遞延：每入場2次延長1年 ──────────────────────────────
const tryExtendFallTest = async (memberId, checkInId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.FALL_TESTS)
    .where('memberId', '==', memberId)
    .where('result', '==', 'passed')
    .orderBy('testedAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return;

  const docRef = snap.docs[0].ref;
  const data = snap.docs[0].data();

  // 計算目前有效期
  const currentExpiry = resolveFallTestExpiry(data);

  // 統計有效期內入場次數（含本次）
  const visitsSnap = await db.collection(COLLECTIONS.CHECK_INS)
    .where('memberId', '==', memberId)
    .where('isCancelled', '==', false)
    .where('checkedInAt', '>=', data.testedAt.toDate())
    .get();

  const visitCount = visitsSnap.size; // 包含本次剛寫入的

  // 每累積 FALL_TEST_EXTENSION_VISITS 次觸發一次遞延
  const extensionCount = data.extensionCount || 0;
  const expectedExtensions = Math.floor(visitCount / FALL_TEST_EXTENSION_VISITS);

  if (expectedExtensions > extensionCount) {
    // 補齊所有未套用的遞延（避免一次跨多門檻時只加一年、其餘永久遺失）
    const missedExtensions = expectedExtensions - extensionCount;
    const previousExpiry = currentExpiry.format('YYYY-MM-DD');
    const newExpiry = currentExpiry.add(missedExtensions * FALL_TEST_EXTENSION_YEARS, 'year').format('YYYY-MM-DD');
    const extensionLog = data.extensionLog || [];
    extensionLog.push({
      extendedAt: new Date(),
      checkInId,
      previousExpiresAt: previousExpiry,
      newExpiresAt: newExpiry,
      extensionsApplied: missedExtensions,
    });
    await docRef.update({
      extensionCount: expectedExtensions,
      currentExpiresAt: newExpiry,
      extensionLog,
      updatedAt: new Date(),
    });
  }
};

// ── waiver 檢查 ──────────────────────────────────────────────────
const checkWaiver = async (memberId) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.WAIVERS).doc(memberId).get();
  if (!doc.exists) return { complete: false, reason: 'not_signed' };
  const w = doc.data();
  if (!w.isComplete) return { complete: false, reason: 'incomplete' };
  return { complete: true };
};

// ── 關卡 0：前置關卡（單一權威來源）────────────────────────────────
// 依序：同日同館重複入場 → Waiver → 墜落測驗（含當日體驗券例外）→ 分期逾期。
// 供 verifyEntry / createPendingCheckIn / /checkin/phone 共用，避免三份各自實作漂移。
// 回傳：
//   通過 → { blocked:false, member, memberType, fallTest }
//   擋下 → { blocked:true, reason, status, httpStatus, code, message, extra }
//     - reason/status：verifyEntry 回傳用
//     - httpStatus：路由 res.status() 用（already_checked_in=400，其餘=403）
//     - code：createPendingCheckIn throw 用
const runEntryGates = async (memberId, gymId, { skipDuplicate = false, expTicketMode = 'owns', expTicketId = null, installmentMemberId = null } = {}) => {
  const db = getDb();
  const today = taiwanToday();

  // 0. 同日同館重複入場
  if (!skipDuplicate) {
    const todaySnap = await db.collection(COLLECTIONS.CHECK_INS)
      .where('memberId', '==', memberId)
      .where('gymId', '==', gymId)
      .where('isCancelled', '==', false)
      .where('checkedInAt', '>=', new Date(today + 'T00:00:00+08:00'))
      .where('checkedInAt', '<=', new Date(today + 'T23:59:59+08:00'))
      .get();
    if (!todaySnap.empty) {
      const existing = todaySnap.docs[0].data();
      const hhmm = new Date(existing.checkedInAt.toDate().getTime() + 8 * 3600000).toISOString().slice(11, 16);
      return {
        blocked: true, reason: 'already_checked_in', status: 'already_checked_in',
        httpStatus: 400, code: 'ALREADY_CHECKED_IN',
        message: `今日已於 ${hhmm} 完成入場，如需重新入場請先取消`,
        extra: { checkInId: todaySnap.docs[0].id, checkedInAt: existing.checkedInAt },
      };
    }
  }

  const member = await getMember(memberId);

  // 1. Waiver
  const waiver = await checkWaiver(memberId);
  if (!waiver.complete) {
    const isPendingParent = waiver.reason === 'incomplete';
    return {
      blocked: true, member,
      reason: isPendingParent ? 'parent_waiver_pending' : 'waiver_required',
      status: 'blocked', httpStatus: 403, code: 'WAIVER_REQUIRED',
      message: isPendingParent ? '已完成簽署，等待家長/監護人完成簽署' : 'Waiver 尚未完成，請先完成簽署',
    };
  }

  // 2. 墜落測驗（例外：持當日有效體驗券者未過墜測可入場，但須簽墜測同意書）
  const fallTest = await checkFallTest(memberId);
  if (!fallTest.passed) {
    // 例外判定：'using'＝此次入場正在使用體驗券（createPendingCheckIn 實際入場，較嚴謹）；
    //           'owns' ＝會員持有當日有效體驗券（verifyEntry / 電話顯示用）
    let hasExpTicket;
    if (expTicketMode === 'using') {
      hasExpTicket = false;
      if (expTicketId) {
        const td = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(expTicketId).get();
        hasExpTicket = td.exists && td.data().ticketType === 'experience';
      }
    } else {
      hasExpTicket = (await getValidSingleEntryTickets(memberId)).some(t => t.ticketType === 'experience');
    }
    if (hasExpTicket) {
      if (!(await hasFallTestSignature(memberId))) {
        return {
          blocked: true, member, reason: 'fall_test_consent_required', status: 'blocked',
          httpStatus: 403, code: 'FALL_TEST_CONSENT_REQUIRED',
          message: '請先簽署墜落測驗同意書（體驗課程可未通過墜測入場，但須簽署同意書）',
        };
      }
      // 有簽署 → 放行
    } else {
      const isNever = fallTest.reason === 'never_tested';
      return {
        blocked: true, member,
        reason: isNever ? 'fall_test_required' : 'fall_test_expired',
        status: 'blocked', httpStatus: 403,
        code: isNever ? 'FALL_TEST_REQUIRED' : 'FALL_TEST_EXPIRED',
        message: isNever ? '尚未通過安全墜落測驗' : `墜落測驗已於 ${fallTest.expiredAt} 到期，請重新測驗`,
        extra: { expiredAt: fallTest.expiredAt || null },
      };
    }
  }

  // 3. 分期付款逾期（子女入場可指定查家長分期：installmentMemberId）
  const { hasOverdueInstallment } = require('./installmentService');
  if (await hasOverdueInstallment(installmentMemberId || memberId)) {
    return {
      blocked: true, member, reason: 'installment_overdue', status: 'blocked',
      httpStatus: 403, code: 'INSTALLMENT_OVERDUE',
      message: '分期付款已逾期，入場資格已暫停，請至櫃檯完成繳款',
    };
  }

  return { blocked: false, member, memberType: getMemberType(member), fallTest };
};

// ── 主驗票：verifyEntry ──────────────────────────────────────────
// 用於「會員端選擇入場方式前」的資格確認
const verifyEntry = async (memberId, gymId) => {
  // ── 關卡 0（同日重複 / Waiver / 墜測含體驗券例外 / 分期逾期）：共用 runEntryGates ──
  const db = getDb();
  const gate = await runEntryGates(memberId, gymId);
  if (gate.blocked) {
    const resp = { allowed: false, status: gate.status, reason: gate.reason, message: gate.message };
    if (gate.reason === 'already_checked_in') {
      resp.checkInId = gate.extra?.checkInId;
      resp.checkedInAt = gate.extra?.checkedInAt;
      resp.member = { id: memberId };
    } else {
      const m = gate.member;
      resp.member = m ? { id: m.id, name: m.name, phone: m.phone } : { id: memberId };
    }
    return resp;
  }
  const member = gate.member;
  const memberType = gate.memberType;
  const fallTest = gate.fallTest;

  const memberInfo = {
    id: member.id, name: member.name, phone: member.phone,
    memberType,
    isTeamMember: isActiveTeamMember(member),
    fallTestExpiresAt: fallTest.expiresAt,
    needsPromotion: member.isChildAccount === true && member.birthday && dayjs().diff(member.birthday, 'year') >= 18,
  };

  const isTeam = isActiveTeamMember(member);

  // 3. VIP
  const vip = await checkVip(memberId);
  if (vip) {
    return {
      allowed: true, status: 'ok', entryType: 'vip', freeEntry: true,
      vip: { id: vip.id, note: vip.note },
      member: memberInfo,
    };
  }

  // 4. 定期票
  const passes = await getValidPasses(memberId, gymId);
  if (passes.length > 0) {
    const p = passes[0];
    // 續約偵測：有效定期票中，任一張到期 ≤14 天者可於產生 QR 時一併續約（取最先偵測到者）
    let renewal = null;
    for (const vp of passes) {
      renewal = await getRenewalInfo(vp);
      if (renewal) break;
    }
    return {
      allowed: true, status: 'ok', entryType: 'pass', freeEntry: true,
      pass: { id: p.id, name: p.passTypeName, scope: p.scope, endDate: p.effectiveEndDate || p.endDate, baseEndDate: p.endDate },
      renewal,
      member: memberInfo,
    };
  }

  // 5. 課程入館（邏輯待實作，保留位置）
  const courseAccess = await getCourseAccess(memberId);
  if (courseAccess.length > 0) {
    const e = courseAccess[0];
    return {
      allowed: true, status: 'ok', entryType: 'course_access', freeEntry: true,
      courseAccess: { enrollmentId: e.id, courseName: e.courseName, gymAccessEnd: e.gymAccessEnd },
      member: memberInfo,
    };
  }

  // 6. 攀岩隊員（課程學員之後，一般票之前）
  if (memberType === 'climbing_team') {
    // 攀岩隊員沒有免費入場，但身份別優先，繼續往下找付費方式
    // 這裡只標記身份，不直接 return，讓後面的付費流程正常執行
  }

  // 7. 兒童/學生：不再固定免費，價格改由 entryTypes 設定決定（於下方付費流程處理；
  //    只有課程學員為固定免費，已於上方 course_access 處理）

  // 7. 員工（full_time / part_time）— 由 staff token 判斷，這裡不處理
  // 8. 無免費資格 → 需要選擇付費方式
  const discountCards = await getValidDiscountCards(memberId);
  const blackCards = await getMemberBlackCards(memberId);
  const singleEntryTickets = await getValidSingleEntryTickets(memberId);
  const bonuses = await require('./bonusService').getMemberBonuses(memberId);
  const buyablePassTypes = await getBuyablePassTypes(gymId);   // 入場可購買的定期票種（該館適用）

  // 折扣券入場 8 折基準（原價依會員身份）；有效隊員再疊加 9 折；兒童不適用折扣券
  const discountOriginalPrice = await getOriginalEntryPrice(memberType);
  let discountCardPrice = Math.round(discountOriginalPrice * DISCOUNT_CARD_RATE);
  if (isTeam && discountOriginalPrice >= TEAM_DISCOUNT_MIN_AMOUNT) discountCardPrice = Math.round(discountCardPrice * PRICES.team_discount_rate);
  const canUseDiscountCard = memberType !== 'child' && discountCards.length > 0;

  // 付費入場類型：與員工端同源，依 systemSettings/entryTypes 動態顯示
  //  - 過濾 active=false 與不適用身份者（memberTypes 空＝不限；course_member 需有課程權益）
  //  - 排除 course_access（課程免費入場已於上方處理，且其 price=0、memberTypes 空會誤觸免費短路）
  const withTeam = (price) => (isTeam && price >= TEAM_DISCOUNT_MIN_AMOUNT
    ? Math.round(price * PRICES.team_discount_rate) : price);
  // 特約廠商優惠設定（啟用 + 金額）；停用或金額 0 → eligible 一律 false（前端不顯示勾選）
  const pvConfig = await getPartnerVendorConfig();
  const pvOn = pvConfig.enabled && pvConfig.discount > 0;
  const etDoc = await db.collection('systemSettings').doc('entryTypes').get();
  const configuredTypes = (etDoc.exists ? (etDoc.data().types || []) : [])
    .filter(t => t && t.id !== 'course_access' && typeof t.price === 'number' && t.active !== false)
    .filter(t => {
      if (!t.memberTypes || t.memberTypes.length === 0) return true;
      if (t.memberTypes.includes(memberType)) return true;
      if (t.memberTypes.includes('course_member') && courseAccess.length > 0) return true;
      return false;
    });

  // 免費短路：此會員適用的入場類型中若有 price<=0（例如兒童/學生設 0），直接免費放行
  const freeType = configuredTypes.find(t => t.price <= 0);
  if (freeType) {
    return { allowed: true, status: 'ok', entryType: freeType.id, freeEntry: true, member: memberInfo };
  }

  // 付費入場類型選項；設定缺失/無適用類型時 fallback 至原本依身份的單一單次入場
  let entryTypeOptions = configuredTypes
    .filter(t => t.price > 0)
    .map(t => ({
      type: t.id,
      label: t.name,
      price: t.price,
      discountedPrice: withTeam(t.price),
      teamDiscount: isTeam && withTeam(t.price) < t.price,
      // 特約廠商優惠：全票/學生票且非隊員（隊員 9 折較優、不提供特約）；設定停用/金額0 則一律 false
      partnerVendorEligible: pvOn && (t.id === 'single_ticket' || t.id === 'student_free') && !isTeam,
      available: true,
      requiresPayment: true,
    }));

  if (entryTypeOptions.length === 0) {
    let singleTypeId = 'single_ticket', singleLabel = '單次購票入場';
    let singlePrice = await getEntryTypePrice('single_ticket', PRICES.single_general);
    if (memberType === 'child') {
      singleTypeId = 'child_free'; singleLabel = '兒童入場';
      singlePrice = await getEntryTypePrice('child_free', 100);
    } else if (memberType === 'student') {
      singleTypeId = 'student_free'; singleLabel = '學生入場';
      singlePrice = await getEntryTypePrice('student_free', 250);
    }
    if (singlePrice <= 0) {
      return { allowed: true, status: 'ok', entryType: singleTypeId, freeEntry: true, member: memberInfo };
    }
    entryTypeOptions = [{
      type: singleTypeId, label: singleLabel, price: singlePrice,
      discountedPrice: withTeam(singlePrice),
      teamDiscount: isTeam && withTeam(singlePrice) < singlePrice,
      partnerVendorEligible: pvOn && (singleTypeId === 'single_ticket' || singleTypeId === 'student_free') && !isTeam,
      available: true, requiresPayment: true,
    }];
  }

  return {
    allowed: true, status: 'ok', freeEntry: false,
    requiresPayment: true,
    member: memberInfo,
    partnerVendorDiscount: pvConfig.discount,   // 特約廠商定額折扣（可設定，前端顯示）
    // 兩段式流程：先選身分(entryTypeOptions)，再選要不要用票券(instruments)
    entryTypeOptions,
    instruments: {
      // 折扣券 8 折金額依所選身分價格 ×rate，由前端/後端依 baseEntryType 計算（兒童不適用）
      discountCard: {
        available: canUseDiscountCard,
        rate: DISCOUNT_CARD_RATE,
        cards: discountCards.map(c => ({ id: c.id, remainingCredits: c.remainingCredits, expiresAt: c.expiresAt })),
      },
      blackCard: {
        available: blackCards.length > 0,
        cards: blackCards.map(c => ({ id: c.id, remainingCredits: c.remainingCredits, expiresAt: c.expiresAt })),
      },
      bonus: {
        available: bonuses.length > 0,
        bonuses: bonuses.map(b => ({ id: b.id, expiresAt: b.expiresAtFormatted, daysLeft: b.daysLeft })),
      },
      singleEntryTicket: {
        available: singleEntryTickets.length > 0,
        tickets: singleEntryTickets.map(t => ({ id: t.id, expiresAt: t.expiresAt })),
      },
      // 兒童不適用折扣券 → 不提供「購買」選項
      buyDiscountCard: { available: memberType !== 'child', price: PRICES.discount_card },
      // 入場當下購買新定期票（比照購買折扣券）；單館票僅該館可買，QR 綁該館
      buyPass: { available: buyablePassTypes.length > 0, passTypes: buyablePassTypes },
    },
    // 舊欄位（相容）：扁平清單
    availableOptions: [
      ...entryTypeOptions,
      // 購買優惠折扣券入場（兒童不適用折扣券，故 child 不顯示此選項）
      ...(memberType !== 'child' ? [{
        type: 'buy_discount_card',
        label: '購買優惠折扣券入場',
        price: PRICES.discount_card,
        note: '含本次入場＋10次八折＋紅利',
        available: true,
        requiresPayment: true,
      }] : []),
      // 使用優惠折扣券：原價 8 折（兒童不適用，故 child 不顯示此選項）
      ...(memberType !== 'child' ? [{
        type: 'discount_card',
        label: '使用優惠折扣券入場（原價 8 折）',
        price: discountOriginalPrice,
        discountedPrice: discountCardPrice,
        available: canUseDiscountCard,
        requiresPayment: true,
        discountCards: discountCards.map(c => ({
          id: c.id, remainingCredits: c.remainingCredits, expiresAt: c.expiresAt,
        })),
      }] : []),
      {
        type: 'black_card',
        label: '使用黑卡入場',
        available: blackCards.length > 0,
        blackCards: blackCards.map(c => ({
          id: c.id, remainingCredits: c.remainingCredits, expiresAt: c.expiresAt,
        })),
      },
      {
        type: 'single_entry_ticket',
        label: '使用單次入場券',
        available: singleEntryTickets.length > 0,
        tickets: singleEntryTickets.map(t => ({
          id: t.id, expiresAt: t.expiresAt,
        })),
      },
      // 使用紅利：免費入場一次
      {
        type: 'bonus',
        label: '使用紅利免費入場',
        price: 0,
        available: bonuses.length > 0,
        bonuses: bonuses.map(b => ({
          id: b.id, expiresAt: b.expiresAtFormatted, daysLeft: b.daysLeft,
        })),
      },
    ],
  };
};

// ── 產生待確認入場 QR code ───────────────────────────────────────
const createPendingCheckIn = async ({
  memberId, gymId, entryType, baseEntryType,
  passId, discountCardId, blackCardId, singleEntryTicketId, bonusId, buyPassTypeId,
  paymentMethod, amount, originalAmount, isTeamDiscount, legacyDiscountCard, partnerVendor, paymentPlan,
  rentShoes, shoesPrice,
  rentChalk, chalkPrice,
  renewPassId, renewPaymentPlan,
}) => {
  const db = getDb();
  const member = await getMember(memberId);
  const memberType = getMemberType(member);

  // 後端權威：兒童（未滿 13，以出生日期判定、不受 VIP/隊員 memberType 影響）——
  //  ‧ 不適用折扣券，禁止「購買優惠折扣券入場」
  //  ‧ 不可購買定期票（buy_pass）
  // （不信前端傳值）
  if (entryType === 'buy_discount_card' && isChild(member)) {
    throw { code: 'CHILD_NO_DISCOUNT_CARD', message: '兒童不適用折扣券，無法購買' };
  }
  if (entryType === 'buy_pass' && isChild(member)) {
    throw { code: 'CHILD_NO_PASS', message: '未滿 13 歲無法購買定期票' };
  }

  // ── 關卡 0（同日重複 / Waiver / 墜測「使用中體驗券」例外 / 分期逾期）：共用 runEntryGates ──
  // 墜測例外用 'using' 語意：僅當此次入場實際使用體驗券才豁免（較 verifyEntry 的「持有」嚴謹）。
  const gate = await runEntryGates(memberId, gymId, {
    expTicketMode: 'using',
    expTicketId: entryType === 'single_entry_ticket' ? singleEntryTicketId : null,
  });
  if (gate.blocked) throw { code: gate.code, message: gate.message };

  // 黑卡/單次入場券：QR 階段只驗證可用性，「不」預扣。
  // 實際扣點延後到 confirmCheckIn（確認入場才扣）→ 產生 QR 但未入場不會扣卡/鎖券。
  if (entryType === 'black_card' && blackCardId) {
    const card = await getBlackCardById(blackCardId);
    if (!card || !card.isActive || (card.remainingCredits || 0) <= 0) {
      throw { code: 'CARD_INVALID', message: '黑卡無效或已無剩餘次數' };
    }
    if (card.expiresAt && dayjs().isAfter(dayjs(card.expiresAt.toDate()))) {
      throw { code: 'CARD_EXPIRED', message: '黑卡已過期' };
    }
  }

  if (entryType === 'single_entry_ticket' && singleEntryTicketId) {
    const ticketDoc = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(singleEntryTicketId).get();
    if (!ticketDoc.exists || ticketDoc.data().status !== 'active') {
      throw { code: 'TICKET_INVALID', message: '單次入場券無效' };
    }
    // 擁有權：券必須屬於入場者本人（家長代子時 memberId 已解析為子會員；轉贈後
    // memberId 已更新為受贈者，故仍成立）。防止帶他人的有效券入場。
    if (ticketDoc.data().memberId && ticketDoc.data().memberId !== memberId) {
      throw { code: 'TICKET_NOT_OWNED', message: '此單次入場券不屬於此會員' };
    }
    if (dayjs().isAfter(dayjs(ticketDoc.data().expiresAt))) {
      throw { code: 'TICKET_EXPIRED', message: '單次入場券已過期' };
    }
  }

  // 後端權威：依 entryTypes 設定重算入場金額（防止前端竄改）。
  // 僅對設定中的付費入場類型生效；卡/券/黑卡（各自扣點）與 buy_discount_card（固定價）維持呼叫端帶入值。
  let finalAmount = amount || 0;
  let finalOriginal = originalAmount || 0;
  let finalTeam = isTeamDiscount || false;
  let finalLegacy = false;
  let finalPartnerVendor = false;
  {
    // 舊折扣卡 8 折：權威以後端轉換期開關 checkinLegacyDiscountCard 為準，不單信呼叫端旗標（與 /checkin/phone 同一份邏輯）
    let useLegacyDiscount = false;
    if (legacyDiscountCard === true) {
      try {
        const ts = await db.collection('systemSettings').doc('transitionSettings').get();
        useLegacyDiscount = !!(ts.exists && ts.data().checkinLegacyDiscountCard);
      } catch {}
    }
    const computed = await computePaidEntryAmount(entryType, member, { legacyDiscountCard: useLegacyDiscount, partnerVendor: partnerVendor === true });
    if (computed) {
      finalOriginal = computed.originalAmount;
      finalAmount = computed.amount;
      finalTeam = computed.isTeamDiscount;
      finalLegacy = !!computed.legacyDiscount;
      finalPartnerVendor = !!computed.partnerVendor;   // 後端權威：隊員/舊卡成立時一律 false
    }
  }

  // 後端權威：使用優惠折扣券 = 所選身分(baseEntryType)原價 8 折；有效隊員再疊加隊員 9 折。
  if (entryType === 'discount_card') {
    let base;
    if (baseEntryType) {
      const fb = baseEntryType === 'student_free' ? 250 : baseEntryType === 'child_free' ? 100 : PRICES.single_general;
      base = await getEntryTypePrice(baseEntryType, fb);
    } else {
      base = await getOriginalEntryPrice(memberType);
    }
    finalOriginal = base;
    let amt = Math.round(base * DISCOUNT_CARD_RATE);            // 優惠券 8 折
    const isTeam = isActiveTeamMember(member);
    if (isTeam && base >= TEAM_DISCOUNT_MIN_AMOUNT) {
      amt = Math.round(amt * PRICES.team_discount_rate);        // 再疊加隊員 9 折
      finalTeam = true;
    } else {
      finalTeam = false;
    }
    finalAmount = amt;
  }
  // 紅利入場為免費
  if (entryType === 'bonus') {
    finalOriginal = 0;
    finalAmount = 0;
    finalTeam = false;
  }
  // 後端權威：購買新定期票入場——金額取票種原價、單館票僅限該館（不信前端傳值）
  if (entryType === 'buy_pass') {
    if (!buyPassTypeId) throw { code: 'PASS_TYPE_REQUIRED', message: '請選擇要購買的定期票種' };
    const ptDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(buyPassTypeId).get();
    if (!ptDoc.exists || ptDoc.data().isActive === false) throw { code: 'PASS_TYPE_INVALID', message: '定期票種無效或已停用' };
    const pt = ptDoc.data();
    // 場館限制：單館票（scope!=='shared'）只能在其目標館購買入場；雙館 shared 不限
    if (pt.scope !== 'shared' && (pt.targetGymId || pt.gymId) !== gymId) {
      throw { code: 'PASS_GYM_MISMATCH', message: '此為單館定期票，僅限適用場館購買入場' };
    }
    finalOriginal = pt.price;
    finalAmount = pt.price;
    finalTeam = false;
  }

  // 後端權威：續約附加（到期前 14 天）——驗票屬本人 / 到期窗 / 場館，快照折後價與新到期日
  let renewSnapshot = null;
  if (renewPassId) {
    const rpDoc = await db.collection(COLLECTIONS.MEMBER_PASSES).doc(renewPassId).get();
    if (!rpDoc.exists) throw { code: 'RENEW_PASS_NOT_FOUND', message: '要續約的定期票不存在' };
    const rp = { id: rpDoc.id, ...rpDoc.data() };
    if (rp.memberId !== memberId) throw { code: 'RENEW_PASS_NOT_OWNED', message: '此定期票不屬於此會員' };
    if (rp.status !== 'active') throw { code: 'RENEW_PASS_INACTIVE', message: '此定期票非有效狀態，無法續約' };
    // 單館票僅限其適用館續約；shared 不限
    if (rp.scope !== 'shared' && (rp.targetGymId || rp.gymId) !== gymId) {
      throw { code: 'RENEW_GYM_MISMATCH', message: '此為單館定期票，僅限適用場館續約' };
    }
    const [rpEff] = await require('./passExpiryService').attachEffectiveEndDates([rp]);
    const info = await getRenewalInfo(rpEff);
    if (!info) throw { code: 'RENEW_NOT_OPEN', message: '尚未到可續約期間（到期前 14 天開放）' };
    renewSnapshot = {
      passId: info.passId, passTypeId: info.passTypeId, passTypeName: info.passTypeName,
      fullPrice: info.fullPrice, renewalPrice: info.renewalPrice,
      currentEndDate: info.currentEndDate, newEndDate: info.newEndDate,
      installmentEnabled: !!info.installment?.enabled,
      plan: (renewPaymentPlan === 'installment' && info.installment?.enabled && info.renewalPrice > 0) ? 'installment' : 'full',
    };
  }

  const qrToken = uuidv4();
  const now = new Date();
  const expiresAt = dayjs().add(30, 'minute').toDate();

  const pending = {
    qrToken,
    memberId, gymId, entryType,
    baseEntryType: baseEntryType || null,
    passId: passId || null,
    discountCardId: discountCardId || null,
    blackCardId: blackCardId || null,
    singleEntryTicketId: singleEntryTicketId || null,
    bonusId: bonusId || null,
    buyPassTypeId: buyPassTypeId || null,
    paymentPlan: paymentPlan || 'full',           // 'full' | 'installment'（僅 buy_pass 用）
    renewPassId: renewPassId || null,             // 續約附加：要續約的定期票 id
    renewSnapshot: renewSnapshot || null,         // 續約後端權威快照（折後價 / 新到期日 / 分期）
    paymentMethod: paymentMethod || null,
    amount: finalAmount,
    originalAmount: finalOriginal,
    isTeamDiscount: finalTeam,
    legacyDiscount: finalLegacy,
    partnerVendor: finalPartnerVendor,   // 特約廠商優惠（−20，掃碼提示出示證件）
    rentShoes: rentShoes || false,
    shoesPrice: rentShoes ? (shoesPrice || PRICES.shoes_rental) : 0,
    rentChalk: rentChalk || false,
    chalkPrice: rentChalk ? (chalkPrice || 50) : 0,
    status: 'pending',
    createdAt: now,
    expiresAt,
    confirmedAt: null,
    confirmedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    checkInId: null,
    // 快照
    memberName: member.name,
    memberType,
    isTeamMember: isActiveTeamMember(member),
  };

  await db.collection(COLLECTIONS.PENDING_CHECK_INS).doc(qrToken).set(pending);

  return { qrToken, expiresAt };
};

// ── 掃描 QR code：取得入場資訊（不確認）────────────────────────
const scanQrCode = async (qrToken, staffGymId = null, isSuperAdmin = false) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.PENDING_CHECK_INS).doc(qrToken).get();

  if (!doc.exists) throw { code: 'QR_NOT_FOUND', message: 'QR Code 不存在' };

  const pending = doc.data();

  if (pending.status === 'confirmed') throw { code: 'QR_ALREADY_USED', message: '此 QR Code 已使用' };
  if (pending.status === 'cancelled') throw { code: 'QR_CANCELLED', message: '此 QR Code 已取消' };
  if (dayjs().isAfter(dayjs(pending.expiresAt.toDate()))) {
    throw { code: 'QR_EXPIRED', message: 'QR Code 已過期' };
  }
  // 場館比對：QR 綁定產生時的場館，掃碼站台須為同館（super_admin 例外；無站台館別時不擋）
  if (staffGymId && !isSuperAdmin && pending.gymId !== staffGymId) {
    throw { code: 'GYM_MISMATCH', message: `此 QR 為「${GYM_NAMES[pending.gymId] || pending.gymId}」入場碼，請至該館掃碼入場` };
  }

  // 續約附加預覽：算出櫃檯此次應收（一次付清＝折後全額；分期＝首期）
  let renewPreview = null;
  if (pending.renewPassId && pending.renewSnapshot) {
    const s = pending.renewSnapshot;
    let dueNow = s.renewalPrice;
    if (s.plan === 'installment') {
      const ptDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(s.passTypeId).get();
      const inst = ptDoc.exists ? ptDoc.data().installment : null;
      const periods = require('./installmentService').buildRenewalPeriods(inst, s.fullPrice, s.renewalPrice, taiwanToday());
      dueNow = periods ? periods[0].amount : s.renewalPrice;
    }
    renewPreview = {
      passTypeName: s.passTypeName, plan: s.plan,
      renewalPrice: s.renewalPrice, fullPrice: s.fullPrice,
      newEndDate: s.newEndDate, dueNow,
    };
  }

  // 購買定期票入場：解析票種名稱與金額，供櫃檯掃碼確認時標示
  let buyPassInfo = null;
  if (pending.entryType === 'buy_pass' && pending.buyPassTypeId) {
    const ptDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(pending.buyPassTypeId).get();
    if (ptDoc.exists) {
      const pt = ptDoc.data();
      const plan = pending.paymentPlan || 'full';
      // 本次櫃檯應收：一次付清＝全額；分期＝首期（與 confirmCheckIn 分期同一份 buildPeriodsFromConfig）
      let dueNow = pt.price;
      if (plan === 'installment' && pt.installment?.enabled && pt.price > 0) {
        const periods = require('./installmentService').buildPeriodsFromConfig(pt.installment, pt.price, taiwanToday());
        if (periods && periods.length) dueNow = periods[0].amount;
      }
      buyPassInfo = { passTypeName: pt.name, fullPrice: pt.price, plan, dueNow };
    }
  }
  // 購買定期票分期時，本次入場應收以首期為準（pending.amount 存的是全額）
  const entryDueNow = buyPassInfo ? buyPassInfo.dueNow : pending.amount;

  // 使用既有定期票入場：解析所用票種名稱（供櫃檯掃碼確認時標示）
  let usePassInfo = null;
  if (pending.entryType === 'pass' && pending.passId) {
    const mpDoc = await db.collection(COLLECTIONS.MEMBER_PASSES).doc(pending.passId).get();
    if (mpDoc.exists) usePassInfo = { passTypeName: mpDoc.data().passTypeName || '定期票' };
  }

  return {
    qrToken,
    memberId: pending.memberId,
    memberName: pending.memberName,
    memberType: pending.memberType,
    isTeamMember: pending.isTeamMember,
    gymId: pending.gymId,
    entryType: pending.entryType,
    paymentMethod: pending.paymentMethod,
    amount: pending.amount,
    originalAmount: pending.originalAmount,
    buyPass: buyPassInfo,                        // 購買定期票：票種名稱 + 金額（供掃碼標示）
    usePass: usePassInfo,                         // 使用既有定期票入場：所用票種名稱
    isTeamDiscount: pending.isTeamDiscount,
    legacyDiscount: pending.legacyDiscount || false,
    partnerVendor: pending.partnerVendor === true,   // 特約廠商優惠 → 員工端提示出示證件
    rentShoes: pending.rentShoes,
    shoesPrice: pending.shoesPrice,
    rentChalk: pending.rentChalk || false,
    chalkPrice: pending.chalkPrice || 0,
    // 續約附加：櫃檯此次應收的續約款（一次付清＝折後全額；分期＝首期）
    renewal: renewPreview,
    totalAmount: entryDueNow + pending.shoesPrice + (pending.chalkPrice || 0) + (renewPreview ? renewPreview.dueNow : 0),
    status: pending.status,
    createdAt: pending.createdAt,
  };
};

// ── 確認入場（櫃檯掃描後確認）───────────────────────────────────
const confirmCheckIn = async (qrToken, staffId, staffName, staffGymId = null, isSuperAdmin = false) => {
  const db = getDb();
  const pendingRef = db.collection(COLLECTIONS.PENDING_CHECK_INS).doc(qrToken);
  const pendingDoc = await pendingRef.get();

  if (!pendingDoc.exists) throw { code: 'QR_NOT_FOUND', message: 'QR Code 不存在' };

  const pending = pendingDoc.data();
  if (pending.status !== 'pending') throw { code: 'QR_INVALID_STATUS', message: `QR Code 狀態為 ${pending.status}，無法確認` };
  if (dayjs().isAfter(dayjs(pending.expiresAt.toDate()))) throw { code: 'QR_EXPIRED', message: 'QR Code 已過期' };
  // 權威後盾：確認入場時再次比對掃碼站台館別（與 scanQrCode 一致，防繞過掃碼直打 confirm）
  if (staffGymId && !isSuperAdmin && pending.gymId !== staffGymId) {
    throw { code: 'GYM_MISMATCH', message: `此 QR 為「${GYM_NAMES[pending.gymId] || pending.gymId}」入場碼，請至該館掃碼入場` };
  }

  const now = new Date();
  const checkInId = uuidv4();

  // ── 先處理票券/卡扣除（扣點失敗則 throw、不建立入場紀錄，避免「有入場、沒扣點」孤兒記錄）──
  // 黑卡/單次券改為「確認入場才扣」：產生 QR 但未入場 → 不扣卡、不鎖券。
  let buyPassInstallmentApplied = false; // 分期購定期票：票價改由分期計畫逐期記帳，本次入場交易不再記票價（避免雙重記帳）
  if (pending.entryType === 'buy_discount_card') {
    // 購買折扣優惠卡入場：建立一張新優惠卡給會員
    const { purchaseDiscountCard } = require('./discountCardService');
    await purchaseDiscountCard({
      memberId: pending.memberId,
      gymId: pending.gymId,
      staffId,
      price: pending.amount || 0,
      paymentId: checkInId,
    });
  } else if (pending.entryType === 'buy_pass' && pending.buyPassTypeId) {
    // 購買新定期票入場：確認收款當下開票（比照 POST /passes 建 memberPass）
    const ptDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(pending.buyPassTypeId).get();
    if (!ptDoc.exists) throw { code: 'PASS_TYPE_INVALID', message: '定期票種無效' };
    const pt = ptDoc.data();
    const startDate = taiwanToday();
    const endDate = pt.durationMonths
      ? dayjs(startDate).add(pt.durationMonths, 'month').format('YYYY-MM-DD')
      : dayjs(startDate).add(pt.durationDays || 0, 'day').format('YYYY-MM-DD');
    const newPassId = uuidv4();
    // 分期？票種有開分期規則 && 會員選分期 && 有價（比照 POST /passes 的 usePassInstallment）
    let passPlan = null;
    if (pending.paymentPlan === 'installment' && pt.installment?.enabled && pt.price > 0) {
      const installmentService = require('./installmentService');
      const periods = installmentService.buildPeriodsFromConfig(pt.installment, pt.price, startDate);
      if (periods) {
        passPlan = await installmentService.createInstallmentPlan({
          memberId: pending.memberId, memberName: pending.memberName || '',
          gymId: pending.gymId, relatedType: 'pass', relatedId: newPassId, itemName: pt.name,
          recognitionDate: null, installments: periods,
          firstPaymentMethod: pending.paymentMethod || 'cash', staffId, staffName,
        });
        // 第一期營收由 createInstallmentPlan 記帳，本次入場交易不再記票價（避免雙重記帳，比照 POST /passes 的 !passPlan 條件）
        if (passPlan) buyPassInstallmentApplied = true;
      }
    }
    await db.collection(COLLECTIONS.MEMBER_PASSES).doc(newPassId).set({
      id: newPassId, memberId: pending.memberId, gymId: pending.gymId,
      passTypeId: pending.buyPassTypeId, passTypeName: pt.name, scope: pt.scope,
      targetGymId: pt.targetGymId || null,
      startDate, endDate,
      credits: pt.credits ?? null, originalCredits: pt.credits ?? null,
      status: 'active', paymentId: checkInId, paymentStatus: 'confirmed',
      installmentPlanId: passPlan?.id || null,
      soldByStaffId: staffId || null, notes: '入場時購買', createdAt: now, updatedAt: now,
    });
  } else if (pending.entryType === 'discount_card' && pending.discountCardId) {
    await useDiscountCard(pending.discountCardId, pending.gymId);
  } else if (pending.entryType === 'black_card' && pending.blackCardId) {
    await useBlackCard(pending.blackCardId); // legacyBlackCards：與資格查詢同源，確認才扣
  } else if (pending.entryType === 'single_entry_ticket' && pending.singleEntryTicketId) {
    // 重新驗證後才標記使用（防兩張 QR 重複使用同一張券）
    const ticketRef = db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(pending.singleEntryTicketId);
    const ticketDoc = await ticketRef.get();
    if (!ticketDoc.exists || ticketDoc.data().status !== 'active') {
      throw { code: 'TICKET_INVALID', message: '單次入場券無效或已使用' };
    }
    if (dayjs().isAfter(dayjs(ticketDoc.data().expiresAt))) {
      throw { code: 'TICKET_EXPIRED', message: '單次入場券已過期' };
    }
    await ticketRef.update({ status: 'used', usedAt: now, usedCheckInId: checkInId, updatedAt: now });
  } else if (pending.entryType === 'bonus' && pending.bonusId) {
    await require('./bonusService').useBonus(pending.bonusId, pending.gymId);
  }

  // ── 續約附加（獨立於 entryType；到期前 14 天於產生 QR 時勾選）────────────────
  // 免費入場（定期票）＋當場續約：延長票期、折後價收款；分期則折扣集中於最後一期。
  let renewRevenue = 0;              // 本次入場一次付清時收的續約款（計入 amountPaid / 記帳）
  let renewPlanId = null;
  let renewMeta = null;
  if (pending.renewPassId && pending.renewSnapshot) {
    const snap = pending.renewSnapshot;
    const passRef = db.collection(COLLECTIONS.MEMBER_PASSES).doc(pending.renewPassId);
    const passDoc = await passRef.get();
    if (!passDoc.exists) throw { code: 'RENEW_PASS_NOT_FOUND', message: '要續約的定期票不存在' };
    const cur = passDoc.data();
    const ptDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(snap.passTypeId).get();
    const pt = ptDoc.exists ? ptDoc.data() : {};
    // 取消還原用：續約前快照（到期日 / 狀態 / 次數 / 既有分期計畫）
    const beforeRenew = {
      endDate: cur.endDate, status: cur.status,
      credits: cur.credits ?? null, originalCredits: cur.originalCredits ?? null,
      installmentPlanId: cur.installmentPlanId || null,
    };
    // 分期？續約選分期 && 票種開分期 && 有續約價
    let plan = null;
    if (snap.plan === 'installment' && pt.installment?.enabled && snap.renewalPrice > 0) {
      const installmentService = require('./installmentService');
      const periods = installmentService.buildRenewalPeriods(pt.installment, snap.fullPrice, snap.renewalPrice, taiwanToday());
      if (periods) {
        plan = await installmentService.createInstallmentPlan({
          memberId: pending.memberId, memberName: pending.memberName || '',
          gymId: pending.gymId, relatedType: 'pass', relatedId: pending.renewPassId, itemName: `${snap.passTypeName}（續約）`,
          recognitionDate: null, installments: periods,
          firstPaymentMethod: pending.paymentMethod || 'cash', staffId, staffName,
        });
        if (plan) renewPlanId = plan.id;
      }
    }
    // 延長票期（比照 PUT /passes renew：續約後新到期日、重置次數、狀態 active）
    await passRef.update({
      endDate: snap.newEndDate,
      status: 'active',
      credits: pt.credits ?? cur.credits ?? null,
      originalCredits: pt.credits ?? cur.originalCredits ?? null,
      installmentPlanId: renewPlanId || cur.installmentPlanId || null,
      lastRenewedAt: now, updatedAt: now,
    });
    // 一次付清：續約款於本次入場記帳（type 'pass'）；分期：首期已由計畫記帳，此處不記
    if (!renewPlanId) {
      const { recordTransaction } = require('../utils/revenueLedger');
      const rtxn = await recordTransaction(db, {
        gymId: pending.gymId, type: 'pass', totalAmount: snap.renewalPrice,
        paymentMethod: pending.paymentMethod || 'cash',
        memberId: pending.memberId, memberName: pending.memberName || '',
        relatedId: pending.renewPassId, staffId, staffName: staffName || '',
        notes: `定期票續約（${snap.passTypeName}）`,
      });
      renewRevenue = snap.renewalPrice;
      renewMeta = { transactionId: rtxn.id };
    }
    renewMeta = {
      ...(renewMeta || {}),
      passId: pending.renewPassId, plan: renewPlanId ? 'installment' : 'full',
      renewalPrice: snap.renewalPrice, fullPrice: snap.fullPrice,
      newEndDate: snap.newEndDate, planId: renewPlanId,
      before: beforeRenew,
    };
  }

  // 建立入場紀錄
  const checkIn = {
    id: checkInId,
    memberId: pending.memberId,
    memberName: pending.memberName,
    gymId: pending.gymId,
    entryType: pending.entryType,
    qrToken,
    passId: pending.passId,
    discountCardId: pending.discountCardId,
    blackCardId: pending.blackCardId,
    singleEntryTicketId: pending.singleEntryTicketId,
    bonusId: pending.bonusId || null,
    buyPassTypeId: pending.buyPassTypeId || null,
    paymentPlan: pending.paymentPlan || 'full',
    // 續約附加（獨立記帳，不計入本次 checkin 交易，避免雙重記帳）
    renewPassId: pending.renewPassId || null,
    renewalAmount: renewRevenue,           // 一次付清收的續約款；分期為 0（首期由計畫記）
    renewalPlanId: renewPlanId,
    renewMeta,                             // 取消還原用快照
    transactionId: null,
    // 分期購定期票：票價由分期計畫記帳，本次入場只認列加購（岩鞋/粉袋）；一次付清照舊含票價
    amountPaid: (buyPassInstallmentApplied ? 0 : pending.amount) + pending.shoesPrice + (pending.chalkPrice || 0),
    paymentMethod: pending.paymentMethod,
    isTeamDiscount: pending.isTeamDiscount,
    legacyDiscount: pending.legacyDiscount || false,
    partnerVendor: pending.partnerVendor || false,   // 特約廠商優惠（供報表/掃碼顯示）
    rentShoes: pending.rentShoes,
    shoesPrice: pending.shoesPrice,
    rentChalk: pending.rentChalk || false,
    chalkPrice: pending.chalkPrice || 0,
    isCancelled: false,
    cancelledAt: null,
    cancelledBy: null,
    checkedInAt: now,
    checkedInBy: staffId,
    notes: '',
    createdAt: now,
  };

  await db.collection(COLLECTIONS.CHECK_INS).doc(checkInId).set(checkIn);

  // 更新 pending 狀態
  await pendingRef.update({
    status: 'confirmed',
    confirmedAt: now,
    confirmedBy: staffId,
    checkInId,
  });

  // 墜落測驗遞延
  await tryExtendFallTest(pending.memberId, checkInId);

  // 入場連動：今日有已報名課程場次 → 自動標記出席（present，不覆蓋員工已標；不阻斷入場）
  // lazy require 避免與 courseService 頂層循環依賴
  await require('./courseService').markTodayCourseAttendanceOnEntry({
    memberId: pending.memberId, gymId: pending.gymId, staffId,
  });

  // 寫入統一營收紀錄（供 revenue.js 報表與單日結帳使用）
  if (checkIn.amountPaid > 0) {
    const { recordTransaction } = require('../utils/revenueLedger');
    const txn = await recordTransaction(db, {
      gymId: pending.gymId,
      type: 'checkin',
      totalAmount: checkIn.amountPaid,
      paymentMethod: pending.paymentMethod || 'cash',
      memberId: pending.memberId,
      memberName: pending.memberName,
      relatedId: checkInId,
      staffId,
      staffName: staffName || '',
      entryFee: buyPassInstallmentApplied ? 0 : (pending.amount || 0), // 分期票價不在此記（由分期計畫記）
      shoesPrice: pending.shoesPrice || 0,
    });
    await db.collection(COLLECTIONS.CHECK_INS).doc(checkInId).update({ transactionId: txn.id });
  }

  return { checkIn };
};

// 取消入場時還原「續約附加」：復原票期/次數、作廢續約分期計畫、一次付清記負向沖銷。
// 供 checkinService.cancelCheckIn 與 cancelCheckin.js 路由共用（兩條取消路徑一致）。
const revertRenewal = async (db, checkIn, now) => {
  const meta = checkIn.renewMeta;
  if (!meta || !meta.passId || !meta.before) return;
  const passRef = db.collection(COLLECTIONS.MEMBER_PASSES).doc(meta.passId);
  const passDoc = await passRef.get();
  if (passDoc.exists) {
    await passRef.update({
      endDate: meta.before.endDate,
      status: meta.before.status,
      credits: meta.before.credits ?? null,
      originalCredits: meta.before.originalCredits ?? null,
      installmentPlanId: meta.before.installmentPlanId || null,
      updatedAt: now,
    });
  }
  if (meta.planId) {
    // 續約分期：作廢計畫 + 沖銷已繳期營收（首期由 createInstallmentPlan 認列，取消須沖）
    await require('./installmentService').cancelInstallmentPlan(db, meta.planId, { reason: '續約取消' }).catch(() => {});
  }
  if (meta.plan === 'full' && meta.renewalPrice > 0) {
    const { recordTransaction } = require('../utils/revenueLedger');
    await recordTransaction(db, {
      gymId: checkIn.gymId, type: 'refund', totalAmount: -Math.abs(meta.renewalPrice),
      paymentMethod: checkIn.paymentMethod || 'cash',
      memberId: checkIn.memberId, memberName: checkIn.memberName || '',
      relatedId: meta.passId, notes: '定期票續約取消沖銷',
    }).catch(() => {});
  }
};

// ── 取消入場（10分鐘內）────────────────────────────────────────
const cancelCheckIn = async (checkInId, staffId, force = false) => {
  const db = getDb();

  // 防護：Firestore 文件 id 限制（保留字 __x__、空值、含 "/"、"."、".." 會丟底層錯誤）
  // 提早回乾淨的 NOT_FOUND，避免把 Firestore 內部錯誤往外拋
  if (typeof checkInId !== 'string' || !checkInId.trim()
      || checkInId.includes('/') || checkInId === '.' || checkInId === '..'
      || /^__.*__$/.test(checkInId)) {
    throw { code: 'CHECKIN_NOT_FOUND', message: '入場紀錄不存在' };
  }

  const checkInRef = db.collection(COLLECTIONS.CHECK_INS).doc(checkInId);
  const checkInDoc = await checkInRef.get();

  if (!checkInDoc.exists) throw { code: 'CHECKIN_NOT_FOUND', message: '入場紀錄不存在' };

  const checkIn = checkInDoc.data();
  if (checkIn.isCancelled) throw { code: 'ALREADY_CANCELLED', message: '此入場紀錄已取消' };

  const minutesSince = dayjs().diff(dayjs(checkIn.checkedInAt.toDate()), 'minute');
  if (minutesSince > 10 && !force) throw { code: 'CANCEL_WINDOW_EXPIRED', message: '已超過10分鐘取消時限' };

  const now = new Date();

  // 退回票券（黑卡/單次券/折扣卡/購卡入場/紅利）— 須與 cancelCheckin.js 的 restoreEntryCredits 一致
  if (checkIn.entryType === 'black_card' && checkIn.blackCardId) {
    await refundBlackCard(checkIn.blackCardId); // legacyBlackCards：與扣點同源
  } else if (checkIn.entryType === 'bonus' && checkIn.bonusId) {
    // 紅利入場取消 → 還原紅利（否則會員的免費入場永久消失）
    const bonusDoc = await db.collection('discountBonuses').doc(checkIn.bonusId).get();
    if (bonusDoc.exists) {
      await bonusDoc.ref.update({ isUsed: false, isActive: true, usedAt: null, usedAtGymId: null, updatedAt: now });
    }
  } else if (checkIn.entryType === 'single_entry_ticket' && checkIn.singleEntryTicketId) {
    await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(checkIn.singleEntryTicketId).update({
      status: 'active',
      usedAt: null,
      usedCheckInId: null,
      updatedAt: now,
    });
  } else if (checkIn.entryType === 'discount_card' && checkIn.discountCardId) {
    // 退回優惠卡次數
    const cardDoc = await db.collection(COLLECTIONS.DISCOUNT_CARDS).doc(checkIn.discountCardId).get();
    if (cardDoc.exists) {
      await db.collection(COLLECTIONS.DISCOUNT_CARDS).doc(checkIn.discountCardId).update({
        remainingCredits: cardDoc.data().remainingCredits + 1,
        updatedAt: now,
      });
    }
  } else if (checkIn.entryType === 'buy_discount_card') {
    // 購買折扣優惠卡入場取消：找到對應優惠卡並刪除（若尚未轉讓）
    const cardSnap = await db.collection(COLLECTIONS.DISCOUNT_CARDS)
      .where('paymentId', '==', checkInId)
      .limit(1).get();
    if (!cardSnap.empty) {
      const card = cardSnap.docs[0].data();
      // 若已轉讓，不可取消
      if (card.transferHistory && card.transferHistory.length > 0) {
        throw { code: 'CARD_TRANSFERRED', message: '折扣優惠卡已轉讓，無法取消入場' };
      }
      if (card.ownerMemberId !== card.originalOwnerMemberId) {
        throw { code: 'CARD_TRANSFERRED', message: '折扣優惠卡已轉讓，無法取消入場' };
      }
      // 若已使用部分次數，不可取消
      if (card.totalUsedCredits > 0) {
        throw { code: 'CARD_USED', message: '折扣優惠卡已使用，無法取消入場' };
      }
      // 作廢優惠卡
      await db.collection(COLLECTIONS.DISCOUNT_CARDS).doc(cardSnap.docs[0].id).update({
        isActive: false,
        cancelledAt: now,
        cancelReason: '入場取消',
        updatedAt: now,
      });
    }
  } else if (checkIn.entryType === 'buy_pass') {
    // 購買新定期票入場取消：作廢對應定期票（此入場即該票的購買點，10 分鐘內取消）
    const passSnap = await db.collection(COLLECTIONS.MEMBER_PASSES)
      .where('paymentId', '==', checkInId)
      .limit(1).get();
    if (!passSnap.empty) {
      const passDoc = passSnap.docs[0];
      await passDoc.ref.update({
        status: 'cancelled', cancelledAt: now, cancelReason: '入場取消', updatedAt: now,
      });
      // 分期購票：作廢分期計畫 + 沖銷已繳期營收（否則留孤兒計畫、且首期票價營收未沖 → 報表多算）
      const planId = passDoc.data().installmentPlanId;
      if (planId) {
        await require('./installmentService').cancelInstallmentPlan(db, planId, { reason: '入場取消' }).catch(() => {});
      }
    }
  }

  // 續約附加還原（獨立於 entryType）
  await revertRenewal(db, checkIn, now);

  // 標記取消
  await checkInRef.update({
    isCancelled: true,
    cancelledAt: now,
    cancelledBy: staffId,
  });

  // 入場費沖銷：原本 confirmCheckIn 對 amountPaid>0 記了一筆 checkin 交易，
  // 取消時須記負向 refund 沖銷（對齊 cancelCheckin.js），否則營收報表（認列制）會多算已取消入場。
  // （續約款已由 revertRenewal 沖銷；票券/卡退回不涉及金流交易，故只沖 amountPaid。）
  if (checkIn.amountPaid > 0) {
    const { recordTransaction } = require('../utils/revenueLedger');
    // 沖銷明細（負值）：入場費/岩鞋粉袋分開沖，讓營收日報表 entry/rental 欄對稱拆分
    const _shoes = checkIn.shoesPrice || 0, _chalk = checkIn.chalkPrice || 0;
    const _entryPortion = (checkIn.entryFee != null) ? checkIn.entryFee : Math.max(0, checkIn.amountPaid - _shoes - _chalk);
    await recordTransaction(db, {
      gymId: checkIn.gymId,
      type: 'refund',
      totalAmount: -checkIn.amountPaid,
      entryFee: -_entryPortion,        // 反向沖入場費
      shoesPrice: -(_shoes + _chalk),  // 反向沖岩鞋+粉袋
      paymentMethod: checkIn.paymentMethod || 'cash',
      memberId: checkIn.memberId,
      memberName: checkIn.memberName,
      relatedId: checkInId,
      notes: '入場取消退款',
      staffId: staffId || null,
      staffName: null,
    });
  }

  // 更新對應 pendingCheckIn
  if (checkIn.qrToken) {
    await db.collection(COLLECTIONS.PENDING_CHECK_INS).doc(checkIn.qrToken).update({
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: staffId,
    });
  }

  return { message: '入場已取消，票券已退回', checkInId };
};

// ── 今日統計 ────────────────────────────────────────────────────
const GYM_NAMES = { 'gym-hsinchu': '新竹館', 'gym-shilin': '士林館' };

const countByEntryType = (records) => ({
  pass: records.filter(x => x.entryType === 'pass').length,
  vip: records.filter(x => x.entryType === 'vip').length,
  course_access: records.filter(x => x.entryType === 'course_access').length,
  discount_card: records.filter(x => x.entryType === 'discount_card').length,
  black_card: records.filter(x => x.entryType === 'black_card').length,
  single_entry_ticket: records.filter(x => x.entryType === 'single_entry_ticket').length,
  single_ticket: records.filter(x => x.entryType === 'single_ticket').length,
  child_free: records.filter(x => x.entryType === 'child_free').length,
  student_free: records.filter(x => x.entryType === 'student_free').length,
});

const getTodayStats = async (gymId) => {
  const db = getDb();
  const _TZ2 = 8 * 60 * 60 * 1000;
  const _todayStrTW2 = new Date(Date.now() + _TZ2).toISOString().slice(0, 10);
  const start = new Date(_todayStrTW2 + 'T00:00:00+08:00');
  const end = new Date(_todayStrTW2 + 'T23:59:59+08:00');
  const gymIds = gymId ? [gymId] : ['gym-hsinchu', 'gym-shilin'];
  const snap = await db.collection(COLLECTIONS.CHECK_INS)
    .where('gymId', 'in', gymIds)
    .where('checkedInAt', '>=', start)
    .where('checkedInAt', '<=', end)
    .orderBy('checkedInAt', 'desc')
    .get();
  const c = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(x => x.isCancelled !== true && x.status !== 'cancelled');

  const statsByGym = gymIds.map(gid => {
    const records = c.filter(x => x.gymId === gid);
    return {
      gymId: gid,
      gymName: GYM_NAMES[gid] || gid,
      total: records.length,
      counts: countByEntryType(records),
    };
  });

  return {
    total: c.length,
    byType: countByEntryType(c), // 保留舊欄位相容
    statsByGym,                  // 按館別分開顯示
    recent: c.slice(0, 20),
  };
};

module.exports = {
  verifyEntry,
  createPendingCheckIn,
  scanQrCode,
  confirmCheckIn,
  cancelCheckIn,
  getTodayStats,
  getValidPasses,
  getCourseAccess,
  checkFallTest,
  tryExtendFallTest,
  checkVip,
  getValidSingleEntryTickets,
  hasFallTestSignature,
  checkWaiver,
  runEntryGates,
  getMemberType,
  computePaidEntryAmount,
  revertRenewal,
  PRICES,
};
