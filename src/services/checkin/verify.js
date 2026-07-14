/**
 * checkin/verify.js — 會員入場資格權威判定 verifyEntry（免費短路→付費選項→instruments→續約資訊）
 * 由 checkinService.js 拆分（2026-07-13 refactor）；函式本體逐字搬移、行為不變。
 */
const { getDb } = require('../../config/firebase');
const { getValidDiscountCards } = require('../discountCardService');
const { getMemberBlackCards } = require('../legacyCardService');
const { isActiveTeamMember, TEAM_DISCOUNT_MIN_AMOUNT } = require('../teamMemberService');
const dayjs = require('dayjs');
const { DISCOUNT_CARD_RATE, PRICES, getEntryTypePrice, getOriginalEntryPrice, getPartnerVendorConfig } = require('./pricing');
const { checkVip, getBuyablePassTypes, getCourseAccess, getRenewalInfo, getValidPasses, getValidSingleEntryTickets } = require('./eligibility');
const { runEntryGates } = require('./gates');

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
  const bonuses = await require('../bonusService').getMemberBonuses(memberId);
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
      buyDiscountCard: { available: memberType !== 'child', price: withTeam(PRICES.discount_card), originalPrice: PRICES.discount_card },
      // 入場當下購買新定期票（比照購買折扣券）；單館票僅該館可買，QR 綁該館
      buyPass: { available: buyablePassTypes.length > 0,
        passTypes: buyablePassTypes.map(pt => ({ ...pt, originalPrice: pt.price, price: withTeam(pt.price) })) },
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
module.exports = { verifyEntry };
