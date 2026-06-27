/**
 * 入場驗票 Service（完整版 v2）
 * 驗票順序：VIP → 定期券 → 課程入館 → 優惠卡 → 黑卡 → 單次入場券 → 無票
 * 新增：VIP、單次入場券、兒童/學生身份、墜落測驗2年+遞延、QR code流程、10分鐘取消
 */
const { getDb, COLLECTIONS } = require('../config/firebase');
const { getMember } = require('./memberService');
const { getValidDiscountCards, useDiscountCard } = require('./discountCardService');
const { getMemberBlackCards, useBlackCard } = require('./legacyCardService');
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

// ── 取得有效定期票 ───────────────────────────────────────────────
const getValidPasses = async (memberId, gymId) => {
  const db = getDb();
  const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
  const snap = await db.collection(COLLECTIONS.MEMBER_PASSES)
    .where('memberId', '==', memberId)
    .where('status', '==', 'active')
    .where('endDate', '>=', today)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.scope === 'shared' || p.targetGymId === gymId)
    .filter(p => p.credits === null || p.credits > 0);
};

// ── 取得課程入館權益 ─────────────────────────────────────────────
const getCourseAccess = async (memberId) => {
  const db = getDb();
  const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);

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
  const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
  const snap = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS)
    .where('memberId', '==', memberId)
    .where('status', '==', 'active')
    .where('expiresAt', '>=', today)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

// ── 主驗票：verifyEntry ──────────────────────────────────────────
// 用於「會員端選擇入場方式前」的資格確認
const verifyEntry = async (memberId, gymId) => {
  // 0. 同日重複入場檢查（使用台灣時間 UTC+8）
  const db = getDb();
  const _TZ = 8 * 60 * 60 * 1000;
  const _todayStrTW = new Date(Date.now() + _TZ).toISOString().slice(0, 10);
  const todayStart = new Date(_todayStrTW + 'T00:00:00+08:00');
  const todayEnd = new Date(_todayStrTW + 'T23:59:59+08:00');
  const todaySnap = await db.collection(COLLECTIONS.CHECK_INS)
    .where('memberId', '==', memberId)
    .where('gymId', '==', gymId)
    .where('isCancelled', '==', false)
    .where('checkedInAt', '>=', todayStart)
    .where('checkedInAt', '<=', todayEnd)
    .get();
  if (!todaySnap.empty) {
    const existing = todaySnap.docs[0].data();
    return {
      allowed: false, status: 'already_checked_in',
      reason: 'already_checked_in',
      message: `今日已於 ${new Date(existing.checkedInAt.toDate().getTime() + 8*3600000).toISOString().slice(11,16)} 完成入場，如需重新入場請先取消`,
      checkInId: todaySnap.docs[0].id,
      checkedInAt: existing.checkedInAt,
      member: { id: memberId },
    };
  }
  const member = await getMember(memberId);
  const memberType = getMemberType(member);

  // 1. waiver 檢查
  const waiver = await checkWaiver(memberId);
  if (!waiver.complete) {
    const isPendingParent = waiver.reason === 'incomplete';
    return {
      allowed: false, status: 'blocked',
      reason: isPendingParent ? 'parent_waiver_pending' : 'waiver_required',
      message: isPendingParent ? '已完成簽署，等待家長/監護人完成簽署' : 'Waiver 尚未完成，請先完成簽署',
      member: { id: member.id, name: member.name, phone: member.phone },
    };
  }

  // 2. 墜落測驗檢查
  const fallTest = await checkFallTest(memberId);
  if (!fallTest.passed) {
    return {
      allowed: false, status: 'blocked',
      reason: fallTest.reason === 'never_tested' ? 'fall_test_required' : 'fall_test_expired',
      message: fallTest.reason === 'never_tested' ? '尚未通過安全墜落測驗' : `墜落測驗已於 ${fallTest.expiredAt} 到期，請重新測驗`,
      member: { id: member.id, name: member.name, phone: member.phone },
    };
  }

  // 2.5 分期付款逾期檢查
  const { hasOverdueInstallment } = require('./installmentService');
  const overdueInstallment = await hasOverdueInstallment(memberId);
  if (overdueInstallment) {
    return {
      allowed: false, status: 'blocked',
      reason: 'installment_overdue',
      message: '分期付款已逾期，入場資格已暫停，請至櫃檯完成繳款',
      member: { id: member.id, name: member.name, phone: member.phone },
    };
  }

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
      pass: { id: p.id, name: p.passTypeName, scope: p.scope, endDate: p.endDate },
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

  // 折扣券入場 8 折基準（原價依會員身份）；兒童不適用折扣券
  const discountOriginalPrice = await getOriginalEntryPrice(memberType);
  const discountCardPrice = Math.round(discountOriginalPrice * DISCOUNT_CARD_RATE);
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
      buyDiscountCard: { price: PRICES.discount_card },
    },
    // 舊欄位（相容）：扁平清單
    availableOptions: [
      ...entryTypeOptions,
      {
        type: 'buy_discount_card',
        label: '購買優惠折扣券入場',
        price: PRICES.discount_card,
        note: '含本次入場＋10次八折＋紅利',
        available: true,
        requiresPayment: true,
      },
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
  passId, discountCardId, blackCardId, singleEntryTicketId, bonusId,
  paymentMethod, amount, originalAmount, isTeamDiscount,
  rentShoes, shoesPrice,
  rentChalk, chalkPrice,
}) => {
  const db = getDb();
  const member = await getMember(memberId);
  const memberType = getMemberType(member);

  // 再次確認 waiver + 墜落測驗
  const waiver = await checkWaiver(memberId);
  if (!waiver.complete) throw { code: 'WAIVER_REQUIRED', message: 'Waiver 尚未完成' };

  const fallTest = await checkFallTest(memberId);
  if (!fallTest.passed) throw { code: 'FALL_TEST_REQUIRED', message: '墜落測驗未通過或已到期' };

  // 黑卡/單次入場券：預扣點數
  if (entryType === 'black_card' && blackCardId) {
    const cardDoc = await db.collection(COLLECTIONS.BLACK_CARDS).doc(blackCardId).get();
    if (!cardDoc.exists || cardDoc.data().status !== 'active' || cardDoc.data().remainingCredits <= 0) {
      throw { code: 'CARD_INVALID', message: '黑卡無效或已無剩餘次數' };
    }
    await db.collection(COLLECTIONS.BLACK_CARDS).doc(blackCardId).update({
      remainingCredits: cardDoc.data().remainingCredits - 1,
      pendingDeduction: true,
      updatedAt: new Date(),
    });
  }

  if (entryType === 'single_entry_ticket' && singleEntryTicketId) {
    const ticketDoc = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(singleEntryTicketId).get();
    if (!ticketDoc.exists || ticketDoc.data().status !== 'active') {
      throw { code: 'TICKET_INVALID', message: '單次入場券無效' };
    }
    if (dayjs().isAfter(dayjs(ticketDoc.data().expiresAt))) {
      throw { code: 'TICKET_EXPIRED', message: '單次入場券已過期' };
    }
    await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(singleEntryTicketId).update({
      status: 'pending',
      updatedAt: new Date(),
    });
  }

  // 後端權威：依 entryTypes 設定重算入場金額（防止前端竄改）。
  // 僅對設定中的付費入場類型生效；卡/券/黑卡（各自扣點）與 buy_discount_card（固定價）維持呼叫端帶入值。
  let finalAmount = amount || 0;
  let finalOriginal = originalAmount || 0;
  let finalTeam = isTeamDiscount || false;
  {
    const etDoc = await db.collection('systemSettings').doc('entryTypes').get();
    const t = etDoc.exists
      ? (etDoc.data().types || []).find(x => x.id === entryType && x.active !== false)
      : null;
    if (t && typeof t.price === 'number') {
      const isTeam = isActiveTeamMember(member);
      finalOriginal = t.price;
      finalAmount = isTeam && t.price >= TEAM_DISCOUNT_MIN_AMOUNT
        ? Math.round(t.price * PRICES.team_discount_rate) : t.price;
      finalTeam = finalAmount < finalOriginal;
    }
  }

  // 後端權威：使用優惠折扣券 = 所選身分(baseEntryType)原價的 8 折。不與隊員折扣疊加。
  if (entryType === 'discount_card') {
    let base;
    if (baseEntryType) {
      const fb = baseEntryType === 'student_free' ? 250 : baseEntryType === 'child_free' ? 100 : PRICES.single_general;
      base = await getEntryTypePrice(baseEntryType, fb);
    } else {
      base = await getOriginalEntryPrice(memberType);
    }
    finalOriginal = base;
    finalAmount = Math.round(base * DISCOUNT_CARD_RATE);
    finalTeam = false;
  }
  // 紅利入場為免費
  if (entryType === 'bonus') {
    finalOriginal = 0;
    finalAmount = 0;
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
    paymentMethod: paymentMethod || null,
    amount: finalAmount,
    originalAmount: finalOriginal,
    isTeamDiscount: finalTeam,
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
const scanQrCode = async (qrToken) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.PENDING_CHECK_INS).doc(qrToken).get();

  if (!doc.exists) throw { code: 'QR_NOT_FOUND', message: 'QR Code 不存在' };

  const pending = doc.data();

  if (pending.status === 'confirmed') throw { code: 'QR_ALREADY_USED', message: '此 QR Code 已使用' };
  if (pending.status === 'cancelled') throw { code: 'QR_CANCELLED', message: '此 QR Code 已取消' };
  if (dayjs().isAfter(dayjs(pending.expiresAt.toDate()))) {
    throw { code: 'QR_EXPIRED', message: 'QR Code 已過期' };
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
const confirmCheckIn = async (qrToken, staffId, staffName) => {
  const db = getDb();
  const pendingRef = db.collection(COLLECTIONS.PENDING_CHECK_INS).doc(qrToken);
  const pendingDoc = await pendingRef.get();

  if (!pendingDoc.exists) throw { code: 'QR_NOT_FOUND', message: 'QR Code 不存在' };

  const pending = pendingDoc.data();
  if (pending.status !== 'pending') throw { code: 'QR_INVALID_STATUS', message: `QR Code 狀態為 ${pending.status}，無法確認` };
  if (dayjs().isAfter(dayjs(pending.expiresAt.toDate()))) throw { code: 'QR_EXPIRED', message: 'QR Code 已過期' };

  const now = new Date();
  const checkInId = uuidv4();

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
    transactionId: null,
    amountPaid: pending.amount + pending.shoesPrice + (pending.chalkPrice || 0),
    paymentMethod: pending.paymentMethod,
    isTeamDiscount: pending.isTeamDiscount,
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

  // 依入場類型處理票券扣除
  if (pending.entryType === 'buy_discount_card') {
    // 購買折扣優惠券：自動建立一張新優惠卡給會員
    const { purchaseDiscountCard } = require('./discountCardService');
    await purchaseDiscountCard({
      memberId: pending.memberId,
      gymId: pending.gymId,
      staffId,
      price: pending.amount || 0,
      paymentId: checkInId,
    });
  } else if (pending.entryType === 'discount_card' && pending.discountCardId) {
    await useDiscountCard(pending.discountCardId, pending.gymId);
  } else if (pending.entryType === 'black_card' && pending.blackCardId) {
    // 預扣已在 createPendingCheckIn 完成，這裡只清除 pending flag
    await db.collection(COLLECTIONS.BLACK_CARDS).doc(pending.blackCardId).update({
      pendingDeduction: false,
      updatedAt: now,
    });
  } else if (pending.entryType === 'single_entry_ticket' && pending.singleEntryTicketId) {
    await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(pending.singleEntryTicketId).update({
      status: 'used',
      usedAt: now,
      usedCheckInId: checkInId,
      updatedAt: now,
    });
  } else if (pending.entryType === 'bonus' && pending.bonusId) {
    // 使用紅利免費入場
    await require('./bonusService').useBonus(pending.bonusId, pending.gymId);
  }

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
      entryFee: pending.amount || 0,
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

  // 退回票券
  if (checkIn.entryType === 'black_card' && checkIn.blackCardId) {
    const cardDoc = await db.collection(COLLECTIONS.BLACK_CARDS).doc(checkIn.blackCardId).get();
    if (cardDoc.exists) {
      await db.collection(COLLECTIONS.BLACK_CARDS).doc(checkIn.blackCardId).update({
        remainingCredits: cardDoc.data().remainingCredits + 1,
        updatedAt: now,
      });
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
  recordCheckIn: confirmCheckIn, // 相容舊介面
  getTodayStats,
  getValidPasses,
  getCourseAccess,
  checkFallTest,
  tryExtendFallTest,
  checkVip,
  getValidSingleEntryTickets,
  getMemberType,
  PRICES,
};
