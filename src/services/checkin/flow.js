/**
 * checkin/flow.js — QR 入場流程：createPendingCheckIn・scanQrCode・confirmCheckIn・今日統計
 * 由 checkinService.js 拆分（2026-07-13 refactor）；函式本體逐字搬移、行為不變。
 */
const { taiwanToday, dateInTaiwan } = require('../../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../../config/firebase');
const { getMember } = require('../memberService');
const { useDiscountCard } = require('../discountCardService');
const { useBlackCard, getBlackCardById } = require('../legacyCardService');
const { isActiveTeamMember, TEAM_DISCOUNT_MIN_AMOUNT } = require('../teamMemberService');
const { isChild } = require('../../utils/age');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const { DISCOUNT_CARD_RATE, PRICES, computePaidEntryAmount, getEntryTypePrice, getMemberType, getOriginalEntryPrice, computeBuyDiscountCardAmount, computeUseDiscountCardAmount, computeBuyPassAmount } = require('./pricing');
const { getRenewalInfo } = require('./eligibility');
const { runEntryGates, tryExtendFallTest } = require('./gates');

const GYM_NAMES = { 'gym-hsinchu': '新竹館', 'gym-shilin': '士林館' };

const createPendingCheckIn = async ({
  memberId, gymId, entryType, baseEntryType,
  passId, discountCardId, blackCardId, singleEntryTicketId, bonusId, buyPassTypeId,
  paymentMethod, amount, originalAmount, isTeamDiscount, legacyDiscountCard, partnerVendor, partnerGymMember, paymentPlan,
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

  let ticketPartnerVendor = false, ticketPartnerGymMember = false;
  if (entryType === 'single_entry_ticket' && singleEntryTicketId) {
    const ticketDoc = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(singleEntryTicketId).get();
    if (!ticketDoc.exists || ticketDoc.data().status !== 'active') {
      throw { code: 'TICKET_INVALID', message: '單次入場券無效' };
    }
    const ticketData = ticketDoc.data();
    // 擁有權：券必須屬於入場者本人（家長代子時 memberId 已解析為子會員；轉贈後
    // memberId 已更新為受贈者，故仍成立）。防止帶他人的有效券入場。
    if (ticketData.memberId && ticketData.memberId !== memberId) {
      throw { code: 'TICKET_NOT_OWNED', message: '此單次入場券不屬於此會員' };
    }
    // expiresAt 為日期字串(YYYY-MM-DD)；過期＝台灣今天已超過該日（比日期，非 datetime，
    // 否則當天午夜後的 dayjs() 會晚於 dayjs(expiresAt=當天00:00) 被誤判過期）
    if (ticketData.expiresAt && taiwanToday() > String(ticketData.expiresAt)) {
      throw { code: 'TICKET_EXPIRED', message: '單次入場券已過期' };
    }
    // 2026-08-23：此券若在線上付款當下已一併預繳租借費用（見 paymentService.js orderHandlers.entry），
    // 後端權威覆寫租借旗標/金額——不論呼叫端（會員 App 剛付款導回，自動產生 QR）送了什麼，租借費用
    // 一律視為已收（金額 0），避免確認入場時 confirmCheckIn 的 amountPaid 又重複收一次。
    if (ticketData.rentShoes) { rentShoes = true; shoesPrice = 0; }
    if (ticketData.rentChalk) { rentChalk = true; chalkPrice = 0; }
    // 2026-08-24：此券若在線上付款當下已套用友館隊員/特約廠商優惠——先記下來，redeem 不重算折扣
    // （錢已照付款當下算好的折後金額收了），僅在下方 finalPartnerVendor/finalPartnerGymMember
    // 覆寫供掃碼提示員工核對證件（金額不受影響）。
    if (ticketData.partnerVendor) ticketPartnerVendor = true;
    if (ticketData.partnerGymMember) ticketPartnerGymMember = true;
  }

  // 後端權威：依 entryTypes 設定重算入場金額（防止前端竄改）。
  // 僅對設定中的付費入場類型生效；卡/券/黑卡（各自扣點）與 buy_discount_card（固定價）維持呼叫端帶入值。
  let finalAmount = amount || 0;
  let finalOriginal = originalAmount || 0;
  let finalTeam = isTeamDiscount || false;
  let finalLegacy = false;
  let finalPartnerVendor = false;
  let finalPartnerGymMember = false;
  {
    // 舊折扣卡 8 折：權威以後端轉換期開關 checkinLegacyDiscountCard 為準，不單信呼叫端旗標（與 /checkin/phone 同一份邏輯）
    let useLegacyDiscount = false;
    if (legacyDiscountCard === true) {
      try {
        const ts = await db.collection('systemSettings').doc('transitionSettings').get();
        useLegacyDiscount = !!(ts.exists && ts.data().checkinLegacyDiscountCard);
      } catch {}
    }
    const computed = await computePaidEntryAmount(entryType, member, { legacyDiscountCard: useLegacyDiscount, partnerVendor: partnerVendor === true, partnerGymMember: partnerGymMember === true });
    if (computed) {
      finalOriginal = computed.originalAmount;
      finalAmount = computed.amount;
      finalTeam = computed.isTeamDiscount;
      finalLegacy = !!computed.legacyDiscount;
      finalPartnerVendor = !!computed.partnerVendor;   // 後端權威：隊員/舊卡成立時一律 false
      finalPartnerGymMember = !!computed.partnerGymMember;   // 後端權威：友館隊員 9 折
    }
  }
  // 線上付款預購票（single_entry_ticket）覆寫：computePaidEntryAmount 對此 entryType 無對應
  // entryTypes 設定、上方 if(computed) 不會觸發，故獨立在此覆寫（見上方 ticketPartnerVendor 註解）。
  if (ticketPartnerVendor) finalPartnerVendor = true;
  if (ticketPartnerGymMember) finalPartnerGymMember = true;

  // 後端權威：使用優惠折扣券 = 所選身分(baseEntryType)原價 8 折；有效隊員再疊加隊員 9 折。
  // 定價邏輯抽至 pricing.js computeUseDiscountCardAmount（2026-08-27），與 paymentService.js
  // orderResolvers.entry（線上付款）共用同一份，避免各自維護。
  if (entryType === 'discount_card') {
    const r = await computeUseDiscountCardAmount(member, baseEntryType);
    finalOriginal = r.originalAmount;
    finalAmount = r.amount;
    finalTeam = r.isTeamDiscount;
  }
  // 紅利入場為免費
  if (entryType === 'bonus') {
    finalOriginal = 0;
    finalAmount = 0;
    finalTeam = false;
  }
  // 後端權威：購買優惠折扣券入場——固定券價；有效隊員 9 折（不信前端傳值）
  // 定價邏輯抽至 pricing.js computeBuyDiscountCardAmount，與 paymentService.js
  // orderResolvers.entry（線上付款）共用同一份，避免各自維護。
  if (entryType === 'buy_discount_card') {
    const r = computeBuyDiscountCardAmount(member);
    finalOriginal = r.originalAmount;
    finalAmount = r.amount;
    finalTeam = r.isTeamDiscount;
  }
  // 後端權威：購買新定期票入場——金額取票種原價、單館票僅限該館（不信前端傳值）
  // 定價邏輯抽至 pricing.js computeBuyPassAmount，同上共用。
  if (entryType === 'buy_pass') {
    const r = await computeBuyPassAmount(db, buyPassTypeId, gymId, member);
    finalOriginal = r.originalAmount;
    finalAmount = r.amount;
    finalTeam = r.isTeamDiscount;
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
    const [rpEff] = await require('../passExpiryService').attachEffectiveEndDates([rp]);
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
    fallTestWarning: gate.fallTestWarning || null, // 小蜘蛛人正式學員未過墜測/未簽同意書仍放行時的醒目提醒
    partnerVendor: finalPartnerVendor,   // 特約廠商優惠（−20，掃碼提示出示證件）
    partnerGymMember: finalPartnerGymMember,   // 友館隊員優惠（9折，掃碼提示出示證件）
    rentShoes: rentShoes || false,
    // ⚠️ 2026-08-23 修正：這裡原本用 `shoesPrice || PRICES.shoes_rental`——當上方「已線上預繳」覆寫把
    // shoesPrice 明確設為 0 時，`0 || 100` 在 JS 會被判定成 falsy 而掉回預設 100，導致租借費用被悄悄
    // 加回來重複收費（E2E 測試抓到）。改用 `!= null` 判斷，只有「完全沒帶這個欄位」才落回預設值，
    // 明確傳入的 0（代表已付款、無需再收費）會被正確保留。
    shoesPrice: rentShoes ? (shoesPrice != null ? shoesPrice : PRICES.shoes_rental) : 0,
    rentChalk: rentChalk || false,
    chalkPrice: rentChalk ? (chalkPrice != null ? chalkPrice : 50) : 0,
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
      const periods = require('../installmentService').buildRenewalPeriods(inst, s.fullPrice, s.renewalPrice, taiwanToday());
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
      // 全額基準＝pending.amount（已含隊員 9 折的後端權威金額；相容舊 pending 回退票種原價）
      const basePrice = pending.amount ?? pt.price;
      // 本次櫃檯應收：一次付清＝全額；分期＝首期（與 confirmCheckIn 分期同一份 buildPeriodsFromConfig）
      let dueNow = basePrice;
      if (plan === 'installment' && pt.installment?.enabled && basePrice > 0) {
        const periods = require('../installmentService').buildPeriodsFromConfig(pt.installment, basePrice, taiwanToday());
        if (periods && periods.length) dueNow = periods[0].amount;
      }
      buyPassInfo = { passTypeName: pt.name, fullPrice: basePrice, originalPrice: pt.price, plan, dueNow, isTeamDiscount: pending.isTeamDiscount === true };
    }
  }
  // 購買定期票分期時，本次入場應收以首期為準（pending.amount 存的是全額）
  const entryDueNow = buyPassInfo ? buyPassInfo.dueNow : pending.amount;

  // 定期票「在家線上續約」後尚未開立發票——獨立於本次入場類型（不論這次用什麼方式入場，都可能
  // 命中，因為續約與入場是完全獨立的兩件事），提示櫃檯順便開立紙本發票（見 paymentService.js
  // orderHandlers.pass_renewal、checkin/eligibility.js getPendingRenewalInvoiceHint）。
  const pendingRenewalInvoice = await require('./eligibility').getPendingRenewalInvoiceHint(pending.memberId);

  // 使用既有定期票入場：解析所用票種名稱（供櫃檯掃碼確認時標示）
  let usePassInfo = null;
  if (pending.entryType === 'pass' && pending.passId) {
    const mpDoc = await db.collection(COLLECTIONS.MEMBER_PASSES).doc(pending.passId).get();
    if (mpDoc.exists) usePassInfo = { passTypeName: mpDoc.data().passTypeName || '定期票' };
  }

  // 使用單次入場券入場：若此券當初是線上付款（街口等）購買，解析原始付款方式+金額
  // 供櫃檯掃碼確認時標示「已線上付款，免再收費」（避免現場誤以為要重複收現金）。
  // 現場店員直接發放的贈券 paymentMethod 為 null/cash，不顯示此標示。
  let onlineTicketInfo = null;
  if (pending.entryType === 'single_entry_ticket' && pending.singleEntryTicketId) {
    const tDoc = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(pending.singleEntryTicketId).get();
    if (tDoc.exists) {
      const tk = tDoc.data();
      if (tk.paymentMethod && tk.paymentMethod !== 'cash') {
        onlineTicketInfo = { paymentMethod: tk.paymentMethod, amount: tk.amount || 0 };
        // 2026-08-24：此券若線上購買的其實是優惠折扣券/定期票，供掃碼預覽提示店員「確認後將開通」
        if (tk.grantsDiscountCard) onlineTicketInfo.grantsDiscountCard = true;
        if (tk.usesDiscountCardId) onlineTicketInfo.usesDiscountCard = true;   // 2026-08-27：線上刷已持有的優惠折扣券入場
        if (tk.grantsPassTypeId) {
          const ptDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(tk.grantsPassTypeId).get();
          onlineTicketInfo.grantsPassTypeName = ptDoc.exists ? (ptDoc.data().name || '定期票') : '定期票';
        }
      }
    }
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
    onlineTicket: onlineTicketInfo,                // 使用單次入場券：若此券為線上付款購買，原始付款方式 + 金額
    pendingRenewalInvoice,                         // 定期票線上續約後尚未開發票（獨立於本次入場類型）
    isTeamDiscount: pending.isTeamDiscount,
    legacyDiscount: pending.legacyDiscount || false,
    partnerVendor: pending.partnerVendor === true,   // 特約廠商優惠 → 員工端提示出示證件
    partnerGymMember: pending.partnerGymMember === true,   // 友館隊員優惠 → 員工端提示出示證件
    fallTestWarning: pending.fallTestWarning || null,   // 小蜘蛛人正式學員未過墜測/未簽同意書 → 員工端醒目提醒
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

  // 同日重複複查（掃碼確認當下）：同日重複閘門原只在「產生 QR / 電話入場 / verify」檢查，confirm 不複查。
  // 補此縫：先產 QR（閘門過）→ 又走電話/其他路徑先入場 → 最後才掃這張早產好的 QR，會造成重複入場。
  // pending 不算 checkin，故只查「今日同館未取消的 checkIns」；已有 → 擋、不建第二筆、不扣任何卡券。
  {
    const todayStr = taiwanToday();
    const dupSnap = await db.collection(COLLECTIONS.CHECK_INS)
      .where('memberId', '==', pending.memberId)
      .where('gymId', '==', pending.gymId)
      .where('isCancelled', '==', false)
      .where('checkedInAt', '>=', new Date(todayStr + 'T00:00:00+08:00'))
      .where('checkedInAt', '<=', new Date(todayStr + 'T23:59:59+08:00'))
      .get();
    if (!dupSnap.empty) {
      const ex = dupSnap.docs[0].data();
      const hhmm = ex.checkedInAt?.toDate
        ? new Date(ex.checkedInAt.toDate().getTime() + 8 * 3600000).toISOString().slice(11, 16)
        : '';
      throw { code: 'ALREADY_CHECKED_IN', message: `此會員今日已於 ${hhmm} 完成入場，如需重新入場請先取消先前那筆` };
    }
  }

  const now = new Date();
  const checkInId = uuidv4();

  // ── 先處理票券/卡扣除（扣點失敗則 throw、不建立入場紀錄，避免「有入場、沒扣點」孤兒記錄）──
  // 黑卡/單次券改為「確認入場才扣」：產生 QR 但未入場 → 不扣卡、不鎖券。
  let buyPassInstallmentApplied = false; // 分期購定期票：票價改由分期計畫逐期記帳，本次入場交易不再記票價（避免雙重記帳）
  if (pending.entryType === 'buy_discount_card') {
    // 購買折扣優惠卡入場：建立一張新優惠卡給會員
    const { purchaseDiscountCard } = require('../discountCardService');
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
    const buyPassPrice = pending.amount ?? pt.price;   // 折後權威金額（隊員 9 折）
    if (pending.paymentPlan === 'installment' && pt.installment?.enabled && buyPassPrice > 0) {
      const installmentService = require('../installmentService');
      const periods = installmentService.buildPeriodsFromConfig(pt.installment, buyPassPrice, startDate);
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
    // 定期票 × 課程免費期間重疊補償（買票方向；買者已是課程學員 → 新票期間重疊即延長，冪等不阻斷）
    try { await require('../passOverlapService').applyCourseOverlapForMember(pending.memberId); }
    catch (e) { console.error('課程重疊補償失敗（票已開立）:', e.message); }
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
    const ticketData = ticketDoc.data();
    if (ticketData.expiresAt && taiwanToday() > String(ticketData.expiresAt)) {
      throw { code: 'TICKET_EXPIRED', message: '單次入場券已過期' };
    }
    await ticketRef.update({ status: 'used', usedAt: now, usedCheckInId: checkInId, updatedAt: now });
    // 2026-08-24：此券若在線上付款當下購買的其實是「優惠折扣券」或「定期票」（非單純付費入場，
    // 見 paymentService.js orderHandlers.entry 的 grantsDiscountCard/grantsPassTypeId）——於此
    // （實際入場/確認那一刻）才建立卡/票，比照現金流程既有的建立時機（confirmCheckIn 當下，
    // 非付款/發券當下），維持起訖日/序號等以實際入場當天為準的既有語意一致。金額已由線上付款
    // 當下收妥（此券本身 amount 即為已收金額），故只傳給卡片自身的「已付金額」記錄用，不會
    // 被下方統一營收記帳重複計算（checkIn.amountPaid 對此券恆為 0，見下方 amountPaid 組成）。
    // ⚠️ 僅支援一次付清（分期購買仍走櫃檯既有流程），故定期票分支不建 installmentPlanId。
    if (ticketData.grantsDiscountCard) {
      const { purchaseDiscountCard } = require('../discountCardService');
      await purchaseDiscountCard({ memberId: pending.memberId, gymId: pending.gymId, staffId, price: ticketData.amount || 0, paymentId: checkInId });
    } else if (ticketData.grantsPassTypeId) {
      const ptDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(ticketData.grantsPassTypeId).get();
      if (ptDoc.exists) {
        const pt = ptDoc.data();
        const startDate = taiwanToday();
        const endDate = pt.durationMonths
          ? dayjs(startDate).add(pt.durationMonths, 'month').format('YYYY-MM-DD')
          : dayjs(startDate).add(pt.durationDays || 0, 'day').format('YYYY-MM-DD');
        const newPassId = uuidv4();
        await db.collection(COLLECTIONS.MEMBER_PASSES).doc(newPassId).set({
          id: newPassId, memberId: pending.memberId, gymId: pending.gymId,
          passTypeId: ticketData.grantsPassTypeId, passTypeName: pt.name, scope: pt.scope,
          targetGymId: pt.targetGymId || null,
          startDate, endDate,
          credits: pt.credits ?? null, originalCredits: pt.credits ?? null,
          status: 'active', paymentId: checkInId, paymentStatus: 'confirmed',
          installmentPlanId: null,
          soldByStaffId: staffId || null, notes: '線上付款購買（入場時開通）', createdAt: now, updatedAt: now,
        });
        try { await require('../passOverlapService').applyCourseOverlapForMember(pending.memberId); }
        catch (e) { console.error('課程重疊補償失敗（票已開立）:', e.message); }
      }
    } else if (ticketData.usesDiscountCardId) {
      // 2026-08-27：線上付款「使用（已持有的）優惠折扣券」入場——與 grantsDiscountCard（線上購買
      // 一張全新的券）不同，這裡付款當下刷的是會員既有的某張券；比照現金流程既有時機，扣點延到
      // 實際入場/確認這一刻才做（呼叫與現場入場同一支 useDiscountCard，含完整驗證：卡存在/未停用/
      // 未過期/仍有次數）。若付款後、入場前這張卡的次數被別的管道用掉（如同一張卡在別處被刷），
      // 這裡會擲出既有的 CARD_NO_CREDITS 等錯誤、擋下這次入場——與其他票券失效情境（如上方
      // TICKET_EXPIRED）一致，不會悄悄放行卻不真的扣點。
      await useDiscountCard(ticketData.usesDiscountCardId, pending.gymId);
    }
  } else if (pending.entryType === 'bonus' && pending.bonusId) {
    await require('../bonusService').useBonus(pending.bonusId, pending.gymId);
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
      const installmentService = require('../installmentService');
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
      const { recordTransaction } = require('../../utils/revenueLedger');
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
    // 使用優惠折扣券(discount_card)時的實際身分（成人/學生原價 8 折基準）——
    // 供結帳/月銷售 entryCategory 拆分「成人使用優惠券／學生使用優惠券」；pending 本就存此欄位，之前漏帶到最終 checkIn。
    baseEntryType: pending.baseEntryType || null,
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
    entryFee: buyPassInstallmentApplied ? 0 : (pending.amount || 0), // 純入場費（不含租借；分期票價 0，由分期計畫記）——供月銷售表拆分
    // 免費入場但有加租（岩鞋/粉袋）時 paymentMethod 可能為 null → 有實收金額就預設現金（櫃檯實收），供結帳付款方式歸類
    paymentMethod: pending.paymentMethod || (((buyPassInstallmentApplied ? 0 : pending.amount) + pending.shoesPrice + (pending.chalkPrice || 0)) > 0 ? 'cash' : null),
    isTeamDiscount: pending.isTeamDiscount,
    legacyDiscount: pending.legacyDiscount || false,
    partnerVendor: pending.partnerVendor || false,   // 特約廠商優惠（供報表/掃碼顯示）
    partnerGymMember: pending.partnerGymMember || false,   // 友館隊員優惠（供報表/掃碼顯示）
    fallTestWarning: pending.fallTestWarning || null,   // 小蜘蛛人正式學員未過墜測/未簽同意書仍放行入場（稽核留痕）
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
  await require('../courseService').markTodayCourseAttendanceOnEntry({
    memberId: pending.memberId, gymId: pending.gymId, staffId,
  });

  // 寫入統一營收紀錄（供 revenue.js 報表與單日結帳使用）
  if (checkIn.amountPaid > 0) {
    const { recordTransaction } = require('../../utils/revenueLedger');
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
      entryType: pending.entryType || null, // 供營收分類（buy_pass 票款歸「定期票」大項）
    });
    await db.collection(COLLECTIONS.CHECK_INS).doc(checkInId).update({ transactionId: txn.id });
  }

  // 使用單次入場券入場：若此券當初是線上付款（街口等）購買，把原始付款方式/全額（含租借）一併
  // 回傳給前端——2026-08-23：此類入場的 checkIn.amountPaid 會是 0（租借費用已在線上付款當下收取，
  // 見 createPendingCheckIn 的權威覆寫），店員端「開立發票」原本只在 amountPaid>0 才顯示會被藏起來，
  // 需要這份資訊才能改用線上已付的全額+品項開票（見 CheckinPage.jsx confirmedCheckIn 用法）。
  let onlineTicketInfo = null;
  if (pending.entryType === 'single_entry_ticket' && pending.singleEntryTicketId) {
    const tDoc = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(pending.singleEntryTicketId).get();
    if (tDoc.exists) {
      const tk = tDoc.data();
      if (tk.paymentMethod && tk.paymentMethod !== 'cash') {
        onlineTicketInfo = { paymentMethod: tk.paymentMethod, amount: tk.amount || 0, rentShoes: !!tk.rentShoes, rentChalk: !!tk.rentChalk };
        // 2026-08-24：此券線上購買的其實是「優惠折扣券」或「定期票」——供前端開立發票時正確顯示
        // 品項名稱（否則 checkIn.entryType 恆為 'single_entry_ticket'，發票會誤標成「單次入場券」）。
        if (tk.grantsDiscountCard) onlineTicketInfo.grantsDiscountCard = true;
        if (tk.usesDiscountCardId) onlineTicketInfo.usesDiscountCard = true;   // 2026-08-27：線上刷已持有的優惠折扣券入場
        if (tk.grantsPassTypeId) {
          const ptDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(tk.grantsPassTypeId).get();
          onlineTicketInfo.grantsPassTypeName = ptDoc.exists ? (ptDoc.data().name || '定期票') : '定期票';
        }
      }
    }
  }
  // ⚠️ 2026-09-03 修復：上面這段原本只把 onlineTicketInfo 塞進本次 API 回應（下方 return），
  // 從未寫回 checkIns 文件本身——只有「剛掃碼確認的那一刻」（前端直接吃這次回應）看得到，
  // 之後任何人重新載入「今日入場」清單（改讀 Firestore 持久化資料）都會發現 onlineTicket 消失、
  // 入場費發票按鈕因此被 amountPaid===0 的既有防呆條件誤藏（真實案例：黃存澤街口付款入場，
  // 稍後在今日入場清單完全看不到開立發票鈕）。比照上面 transactionId 的既有寫法，算出來後
  // 補一次 update 存回文件，讓 GET /checkin/today 之後讀到的清單也能正確帶出。
  if (onlineTicketInfo) {
    await db.collection(COLLECTIONS.CHECK_INS).doc(checkInId).update({ onlineTicket: onlineTicketInfo });
  }

  // 定期票線上續約後尚未開發票——確認入場成功畫面同樣提示（見 scanQrCode 同款欄位說明）。
  const pendingRenewalInvoice = await require('./eligibility').getPendingRenewalInvoiceHint(pending.memberId);

  return { checkIn: { ...checkIn, onlineTicket: onlineTicketInfo, pendingRenewalInvoice } };
};

// 取消入場時還原「續約附加」：復原票期/次數、作廢續約分期計畫、一次付清記負向沖銷。
// 供 checkinService.cancelCheckIn 使用（原本另供已移除的 cancelCheckin.js 路由共用，見該檔移除記錄）。
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

// ── 事後補加租借（已入場後才決定要租岩鞋/粉袋，比照入場當下加租同一費率）──────────
// 只針對「這次新加的」項目收費（已租過的不重複收）。
// paymentMethodOverride：會員自助 QR 流程可自選付款方式（可能跟原入場不同）；未指定則沿用原入場付款方式
// （免費入場則預設現金）——沿用是為了 dailySettlements「今日付款方式」統計以「一筆入場=一種付款方式」歸類，
// 若改用不同方式覆蓋，該筆入場的付款方式統計會全部改記為新方式（總額/租借金額本身仍完全正確，只有「付款方式細項」
// 這個次要統計在混付時可能不夠精確，可接受）。
// 只更新 amountPaid/shoesPrice/chalkPrice，entryFee 不動（入場費本身不受影響）；另記一筆獨立交易
// （entryFee:0，故 revenue.js／dailySettlements 的「租借」欄會正確吃到全額、不誤算進入場費）。
const addRentalToCheckIn = async (checkInId, { addShoes, addChalk }, staffId, staffName, paymentMethodOverride = null) => {
  const db = getDb();
  const ref = db.collection(COLLECTIONS.CHECK_INS).doc(checkInId);
  const doc = await ref.get();
  if (!doc.exists) { throw { code: 'NOT_FOUND', message: '找不到此入場紀錄' }; }
  const c = doc.data();
  if (c.isCancelled) { throw { code: 'ALREADY_CANCELLED', message: '此入場已取消' }; }

  const newShoes = !!addShoes && !c.rentShoes;
  const newChalk = !!addChalk && !c.rentChalk;
  if (!newShoes && !newChalk) { throw { code: 'NOTHING_TO_ADD', message: '沒有新增項目（可能已租過）' }; }

  const addCost = (newShoes ? 100 : 0) + (newChalk ? 50 : 0);
  const paymentMethod = paymentMethodOverride || c.paymentMethod || 'cash';
  const now = new Date();
  const updates = {
    amountPaid: (c.amountPaid || 0) + addCost,
    paymentMethod,
    updatedAt: now,
  };
  if (newShoes) { updates.rentShoes = true; updates.shoesPrice = (c.shoesPrice || 0) + 100; }
  if (newChalk) { updates.rentChalk = true; updates.chalkPrice = (c.chalkPrice || 0) + 50; }
  await ref.update(updates);

  const { recordTransaction } = require('../../utils/revenueLedger');
  await recordTransaction(db, {
    gymId: c.gymId,
    type: 'checkin',
    totalAmount: addCost,
    paymentMethod,
    memberId: c.memberId,
    memberName: c.memberName,
    relatedId: checkInId,
    staffId, staffName: staffName || '',
    entryFee: 0, // 純租借加購，不含入場費
    shoesPrice: newShoes ? 100 : 0,
    entryType: c.entryType || null,
    notes: `事後補加租借：${[newShoes && '岩鞋', newChalk && '粉袋'].filter(Boolean).join('、')}`,
  });

  return { checkInId, addCost, rentShoes: c.rentShoes || newShoes, rentChalk: c.rentChalk || newChalk };
};

// ── 會員自助「補租器材」QR 流程：已入場後在 App 選補租項目+付款方式 → 產生 QR → 店員掃碼確認才真正扣費 ──
// 比照入場 QR（qr/create→scan→confirm）同一套模式，獨立集合 pendingRentalAddons（30 分鐘效期）。
const RENTAL_ADDON_COLLECTION = 'pendingRentalAddons';
const RENTAL_ADDON_TTL_MS = 30 * 60 * 1000;

const requestRentalAddon = async (checkInId, memberId, { addShoes, addChalk, paymentMethod }) => {
  const db = getDb();
  const ciDoc = await db.collection(COLLECTIONS.CHECK_INS).doc(checkInId).get();
  if (!ciDoc.exists) { throw { code: 'NOT_FOUND', message: '找不到此入場紀錄' }; }
  const c = ciDoc.data();
  if (c.memberId !== memberId) { throw { code: 'FORBIDDEN', message: '只能為自己的入場紀錄補租器材' }; }
  if (c.isCancelled) { throw { code: 'ALREADY_CANCELLED', message: '此入場已取消' }; }
  const newShoes = !!addShoes && !c.rentShoes;
  const newChalk = !!addChalk && !c.rentChalk;
  if (!newShoes && !newChalk) { throw { code: 'NOTHING_TO_ADD', message: '沒有可補租的項目（可能已租過）' }; }
  if (!paymentMethod) { throw { code: 'MISSING_PAYMENT_METHOD', message: '請選擇付款方式' }; }

  const id = uuidv4();
  const now = new Date();
  const cost = (newShoes ? 100 : 0) + (newChalk ? 50 : 0);
  await db.collection(RENTAL_ADDON_COLLECTION).doc(id).set({
    id, checkInId, memberId, memberName: c.memberName, gymId: c.gymId,
    addShoes: newShoes, addChalk: newChalk, cost, paymentMethod,
    status: 'pending', createdAt: now, expiresAt: new Date(now.getTime() + RENTAL_ADDON_TTL_MS),
  });
  // token 帶 rentaladd: 前綴（比照 compchk:/staffentry: 慣例），QR 掃到後店員端才能分流到正確流程
  return { token: `rentaladd:${id}`, cost, addShoes: newShoes, addChalk: newChalk };
};

// 擁有權驗證交由路由層（checkMemberOwnership，比照 /checkin/qr/status/:qrToken 同一套模式）。
const getRentalAddonDoc = async (token) => {
  const db = getDb();
  const doc = await db.collection(RENTAL_ADDON_COLLECTION).doc(token).get();
  return doc.exists ? doc.data() : null;
};

const scanRentalAddon = async (token, staffGymId = null, isSuperAdmin = false) => {
  const db = getDb();
  const doc = await db.collection(RENTAL_ADDON_COLLECTION).doc(token).get();
  if (!doc.exists) { throw { code: 'NOT_FOUND', message: '找不到此補租請求或已逾期' }; }
  const p = doc.data();
  if (p.status !== 'pending') { throw { code: 'ALREADY_PROCESSED', message: '此補租請求已處理過' }; }
  if (p.expiresAt && dayjs().isAfter(dayjs(p.expiresAt.toDate ? p.expiresAt.toDate() : p.expiresAt))) {
    throw { code: 'EXPIRED', message: '此補租請求已逾期，請會員重新產生' };
  }
  if (staffGymId && !isSuperAdmin && p.gymId !== staffGymId) {
    throw { code: 'GYM_MISMATCH', message: `此為「${GYM_NAMES[p.gymId] || p.gymId}」的補租請求，請至該館掃碼確認` };
  }
  return { token, memberId: p.memberId, memberName: p.memberName, gymId: p.gymId, addShoes: p.addShoes, addChalk: p.addChalk, cost: p.cost, paymentMethod: p.paymentMethod };
};

const confirmRentalAddon = async (token, staffId, staffName, staffGymId = null, isSuperAdmin = false) => {
  const db = getDb();
  const ref = db.collection(RENTAL_ADDON_COLLECTION).doc(token);
  const doc = await ref.get();
  if (!doc.exists) { throw { code: 'NOT_FOUND', message: '找不到此補租請求或已逾期' }; }
  const p = doc.data();
  if (p.status !== 'pending') { throw { code: 'ALREADY_PROCESSED', message: '此補租請求已處理過' }; }
  if (p.expiresAt && dayjs().isAfter(dayjs(p.expiresAt.toDate ? p.expiresAt.toDate() : p.expiresAt))) {
    throw { code: 'EXPIRED', message: '此補租請求已逾期，請會員重新產生' };
  }
  if (staffGymId && !isSuperAdmin && p.gymId !== staffGymId) {
    throw { code: 'GYM_MISMATCH', message: `此為「${GYM_NAMES[p.gymId] || p.gymId}」的補租請求，請至該館掃碼確認` };
  }
  const result = await addRentalToCheckIn(p.checkInId, { addShoes: p.addShoes, addChalk: p.addChalk }, staffId, staffName, p.paymentMethod);
  await ref.update({ status: 'confirmed', confirmedAt: new Date(), confirmedBy: staffId });
  // 補回開發票要用的欄位（2026-08-15 新增，供 CheckinPage.jsx 確認後渲染 InvoiceIssuer）：
  // token 就是這筆補租請求自己的文件 id（呼叫端已在路由層剝掉 rentaladd: 前綴），拿來當
  // sourceType:'rental_addon' 的 refId——刻意不沿用原入場的 checkInId 當 refId，因為原入場
  // 可能早就已經開過一張發票了（同一組 sourceType+refId 只能有一張作用中發票，見 invoices.js
  // getActiveRealInvoice），補租這筆錢要能獨立再開一張，不能被那張擋住。
  //
  // ⚠️ 2026-08-23 修正重複開發票（真實案例：同一筆入場的補租金額被開了兩張紙本——一張走這裡的
  // rental_addon 觸發、一張是店員後來從「今日入場」清單另外幫這筆入場開票）：關鍵在於「原入場此刻
  // 是否已經開過發票」——已開過（先開了入場費才補租）→ 這筆補租金額本就沒被涵蓋，維持獨立開票
  // 合理；還沒開過（本案例：先補租、原入場自己都還沒開票）→ addRentalToCheckIn 已經把補租費用
  // 併進 checkIn.amountPaid，之後店員若從入場清單開票，金額會自動包含這次補租，此時若還讓這裡
  // 也開一張獨立的補租發票，同一筆錢就會被印兩次紙本。故補算 checkinAlreadyInvoiced 旗標交給
  // 前端判斷是否要渲染這個獨立開票入口（true 才顯示；false 則提示店員改用入場自己的發票鍵）。
  let checkinAlreadyInvoiced = false;
  try {
    const { isInvoicePrintingEnabled, getActiveRealInvoice } = require('../../routes/invoices');
    if (await isInvoicePrintingEnabled(db, p.gymId)) {
      checkinAlreadyInvoiced = !!(await getActiveRealInvoice(db, 'checkin', p.checkInId));
    } else {
      const { getActiveInvoice } = require('../invoiceService');
      checkinAlreadyInvoiced = !!(await getActiveInvoice(db, 'checkin', p.checkInId));
    }
  } catch (e) { console.error('[confirmRentalAddon] 檢查原入場發票狀態失敗', e.message); }
  return { ...result, addonId: token, memberId: p.memberId, memberName: p.memberName, gymId: p.gymId,
    cost: p.cost, paymentMethod: p.paymentMethod, addShoes: p.addShoes, addChalk: p.addChalk,
    checkinAlreadyInvoiced };
};

// ── 更正入場付款方式（2026-09-04，「陳奕亘」個案引出）───────────────────────────────
// 已確認入場後才發現付款方式選錯（如原以 LinePay 產生 QR，櫃檯實際改收現金卻沒同步更正）：
// 過去只能人工直接改 Firestore，已印出的發票、已結帳的快照都不會跟著動，造成「入場紀錄查得到
// 現金，結帳報表卻沒有現金」的落差（真實案例：士林館差 300 元）。此函式一次修正三處：
//   1) checkIns 本身的 paymentMethod（＋稽核欄位，記錄原值/操作人/原因）
//   2) 對應的 type:'checkin' 交易記錄（可能不只一筆：入場本身 + 事後補租器材各一筆）
//   3) 若已開立且仍作用中（未作廢）的發票，一併同步（無則略過，非真列印館別本就無此紀錄）
// 若「今天」（台灣時間）已有該館的正式結帳快照（status:'settled'）→ 額外把 payment.<舊方式>／
// <新方式> 做精確金額搬移、重算 expectedCashBalance/difference（手動輸入模式下數字由人工填寫，
// 略過不動、請人工核對）。過去日期的已結帳快照不自動回補（跨日牽動前日餘額鏈，風險較高，維持
// 人工個案處理，見歷史「補結」案例）；今天尚無記錄或仍是暫存檔＝下次載入頁面就會自動重算，
// 同樣不需要另外處理。
// 僅限管理員（super_admin/gym_manager）呼叫（見路由層 requireManager）——付款方式異動涉及現金
// 結帳，比照轉帳確認付款方式更正（3.398.1）同一收斂範圍。
const CHECKIN_PAYMENT_METHODS = ['cash', 'linepay', 'jkopay', 'taiwanpay'];
const PAYMENT_KEY_MAP = { linepay: 'linePay', jkopay: 'jko', taiwanpay: 'taiwanPay', cash: 'cash' };
const correctPaymentMethod = async (checkInId, newMethod, { staffId, staffName, reason } = {}) => {
  if (!CHECKIN_PAYMENT_METHODS.includes(newMethod)) {
    throw { code: 'INVALID_PAYMENT_METHOD', message: '付款方式不正確' };
  }
  const db = getDb();
  const ref = db.collection(COLLECTIONS.CHECK_INS).doc(checkInId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此入場紀錄' };
  const c = doc.data();
  if (c.isCancelled) throw { code: 'ALREADY_CANCELLED', message: '此入場已取消，無法更正付款方式' };
  if (!(c.amountPaid > 0)) throw { code: 'NOTHING_TO_CORRECT', message: '此筆入場未實際收款，無付款方式可更正' };

  const oldMethod = c.paymentMethod || 'cash';
  if (oldMethod === newMethod) return { noChange: true, oldMethod, newMethod };
  const amount = Number(c.amountPaid) || 0;
  const now = new Date();

  await ref.update({
    paymentMethod: newMethod,
    paymentMethodCorrectedFrom: oldMethod,
    paymentMethodCorrectedAt: now,
    paymentMethodCorrectedBy: staffId || null,
    paymentMethodCorrectedByName: staffName || null,
    paymentMethodCorrectionReason: reason || null,
    updatedAt: now,
  });

  // 對應的 type:'checkin' 交易記錄一併同步（可能不只一筆）
  const txnSnap = await db.collection('transactions')
    .where('type', '==', 'checkin').where('relatedId', '==', checkInId).get();
  if (txnSnap.size) {
    const batch = db.batch();
    txnSnap.docs.forEach(d => batch.update(d.ref, { paymentMethod: newMethod, updatedAt: now }));
    await batch.commit();
  }

  // 已開立且仍作用中（未作廢）的發票一併同步
  let invoiceUpdated = false;
  const invSnap = await db.collection('invoices')
    .where('sourceType', '==', 'checkin').where('refId', '==', checkInId).where('status', '==', 'issued')
    .limit(1).get();
  if (!invSnap.empty) {
    await invSnap.docs[0].ref.update({
      paymentMethod: newMethod, paymentMethodCorrectedFrom: oldMethod, updatedAt: now,
    });
    invoiceUpdated = true;
  }

  // 今日（台灣時間）且已正式結帳的快照才需要回補；draft/尚無記錄下次載入自動重算，過去日期不自動回補
  let settlementPatched = false;
  let settlementSkippedReason = null;
  const entryDate = c.checkedInAt ? dateInTaiwan(c.checkedInAt.toDate ? c.checkedInAt.toDate() : c.checkedInAt) : null;
  if (entryDate !== taiwanToday()) {
    settlementSkippedReason = '此筆入場非今日，已結帳快照不自動回補，如需回補請人工核對歷史結帳記錄';
  } else {
    const setSnap = await db.collection('dailySettlements')
      .where('gymId', '==', c.gymId).where('date', '==', entryDate).limit(1).get();
    if (setSnap.empty) {
      settlementSkippedReason = '今日尚無結帳記錄，下次載入結帳頁會自動用最新資料重算';
    } else {
      const setDoc = setSnap.docs[0];
      const s = setDoc.data();
      if (s.status !== 'settled') {
        settlementSkippedReason = '今日結帳仍為暫存檔，下次載入會自動重算';
      } else if (s.paymentManual != null) {
        settlementSkippedReason = '今日結帳為付款方式手動輸入模式，數字由人工填寫，請自行核對更正';
      } else {
        const payment = { ...(s.payment || {}) };
        const oldKey = PAYMENT_KEY_MAP[oldMethod] || 'other';
        const newKey = PAYMENT_KEY_MAP[newMethod] || 'other';
        payment[oldKey] = (payment[oldKey] || 0) - amount;
        payment[newKey] = (payment[newKey] || 0) + amount;
        payment.electronic = (payment.linePay || 0) + (payment.jko || 0) + (payment.taiwanPay || 0);
        // netAdjust 計算式與 POST / 結帳送出端點（dailySettlements.js）逐字一致：sign '+' 加入抽屜、
        // 其餘（含舊資料無 sign）一律視為 '-'（減）
        const netAdjust = (s.deductions || []).reduce((sum, d) => sum + ((d.sign === '+' ? 1 : -1) * (Number(d.amount) || 0)), 0);
        const expectedCashBalance = (s.prevCashBalance || 0) + (payment.cash || 0) + netAdjust;
        const difference = (s.actualCashBalance || 0) - expectedCashBalance;
        await setDoc.ref.update({
          payment, expectedCashBalance, difference,
          differenceAlert: Math.abs(difference) > 200,
          correctionNote: `[${entryDate} 系統修正] 會員${c.memberName}入場（checkIn ${checkInId}）付款方式由${oldMethod}更正為${newMethod}，已回補結帳快照 NT$${amount}。${s.correctionNote ? '｜' + s.correctionNote : ''}`,
        });
        settlementPatched = true;
      }
    }
  }

  return { ok: true, oldMethod, newMethod, amount, invoiceUpdated, settlementPatched, settlementSkippedReason };
};

module.exports = {
  GYM_NAMES, createPendingCheckIn, scanQrCode, confirmCheckIn, countByEntryType, getTodayStats, addRentalToCheckIn,
  requestRentalAddon, getRentalAddonDoc, scanRentalAddon, confirmRentalAddon, correctPaymentMethod,
  CHECKIN_PAYMENT_METHODS,
};
