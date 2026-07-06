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
    return { amount: originalAmount, originalAmount, isTeamDiscount: false, legacyDiscount: false };
  }
  const isTeam = isActiveTeamMember(member);
  const teamEligible = isTeam && originalAmount >= TEAM_DISCOUNT_MIN_AMOUNT;
  let amount = originalAmount;
  if (opts.legacyDiscountCard) amount = Math.round(amount * DISCOUNT_CARD_RATE); // 舊折扣卡 8 折
  if (teamEligible) amount = Math.round(amount * PRICES.team_discount_rate);      // 有效隊員再疊 9 折
  return {
    amount, originalAmount,
    isTeamDiscount: teamEligible,
    legacyDiscount: !!opts.legacyDiscountCard,
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
    }));
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
    return {
      allowed: true, status: 'ok', entryType: 'pass', freeEntry: true,
      pass: { id: p.id, name: p.passTypeName, scope: p.scope, endDate: p.effectiveEndDate || p.endDate, baseEndDate: p.endDate },
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
      available: true, requiresPayment: true,
    }];
  }

  return {
    allowed: true, status: 'ok', freeEntry: false,
    requiresPayment: true,
    member: memberInfo,
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
  paymentMethod, amount, originalAmount, isTeamDiscount, legacyDiscountCard, paymentPlan,
  rentShoes, shoesPrice,
  rentChalk, chalkPrice,
}) => {
  const db = getDb();
  const member = await getMember(memberId);
  const memberType = getMemberType(member);

  // 後端權威：兒童不適用折扣券，禁止「購買優惠折扣券入場」（不信前端傳值）
  if (entryType === 'buy_discount_card' && memberType === 'child') {
    throw { code: 'CHILD_NO_DISCOUNT_CARD', message: '兒童不適用折扣券，無法購買' };
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
  {
    // 舊折扣卡 8 折：權威以後端轉換期開關 checkinLegacyDiscountCard 為準，不單信呼叫端旗標（與 /checkin/phone 同一份邏輯）
    let useLegacyDiscount = false;
    if (legacyDiscountCard === true) {
      try {
        const ts = await db.collection('systemSettings').doc('transitionSettings').get();
        useLegacyDiscount = !!(ts.exists && ts.data().checkinLegacyDiscountCard);
      } catch {}
    }
    const computed = await computePaidEntryAmount(entryType, member, { legacyDiscountCard: useLegacyDiscount });
    if (computed) {
      finalOriginal = computed.originalAmount;
      finalAmount = computed.amount;
      finalTeam = computed.isTeamDiscount;
      finalLegacy = !!computed.legacyDiscount;
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
    paymentMethod: paymentMethod || null,
    amount: finalAmount,
    originalAmount: finalOriginal,
    isTeamDiscount: finalTeam,
    legacyDiscount: finalLegacy,
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
    isTeamDiscount: pending.isTeamDiscount,
    legacyDiscount: pending.legacyDiscount || false,
    rentShoes: pending.rentShoes,
    shoesPrice: pending.shoesPrice,
    rentChalk: pending.rentChalk || false,
    chalkPrice: pending.chalkPrice || 0,
    rentChalk: pending.rentChalk || false,
    chalkPrice: pending.chalkPrice || 0,
    totalAmount: pending.amount + pending.shoesPrice + (pending.chalkPrice || 0),
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
    transactionId: null,
    // 分期購定期票：票價由分期計畫記帳，本次入場只認列加購（岩鞋/粉袋）；一次付清照舊含票價
    amountPaid: (buyPassInstallmentApplied ? 0 : pending.amount) + pending.shoesPrice + (pending.chalkPrice || 0),
    paymentMethod: pending.paymentMethod,
    isTeamDiscount: pending.isTeamDiscount,
    legacyDiscount: pending.legacyDiscount || false,
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
      // 分期購票：一併作廢分期計畫（否則會留下「欠款/逾期擋入場」的孤兒計畫）
      const planId = passDoc.data().installmentPlanId;
      if (planId) {
        await db.collection(COLLECTIONS.INSTALLMENT_PLANS).doc(planId)
          .update({ status: 'cancelled', cancelledAt: now, cancelReason: '入場取消', updatedAt: now })
          .catch(() => {});
      }
    }
  }

  // 標記取消
  await checkInRef.update({
    isCancelled: true,
    cancelledAt: now,
    cancelledBy: staffId,
  });

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
  PRICES,
};
