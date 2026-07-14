/**
 * checkin/flow.js — QR 入場流程：createPendingCheckIn・scanQrCode・confirmCheckIn・今日統計
 * 由 checkinService.js 拆分（2026-07-13 refactor）；函式本體逐字搬移、行為不變。
 */
const { taiwanToday } = require('../../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../../config/firebase');
const { getMember } = require('../memberService');
const { useDiscountCard } = require('../discountCardService');
const { useBlackCard, getBlackCardById } = require('../legacyCardService');
const { isActiveTeamMember, TEAM_DISCOUNT_MIN_AMOUNT } = require('../teamMemberService');
const { isChild } = require('../../utils/age');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const { DISCOUNT_CARD_RATE, PRICES, computePaidEntryAmount, getEntryTypePrice, getMemberType, getOriginalEntryPrice } = require('./pricing');
const { getRenewalInfo } = require('./eligibility');
const { runEntryGates, tryExtendFallTest } = require('./gates');

const GYM_NAMES = { 'gym-hsinchu': '新竹館', 'gym-shilin': '士林館' };

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
  // 後端權威：購買優惠折扣券入場——固定券價；有效隊員 9 折（不信前端傳值）
  if (entryType === 'buy_discount_card') {
    const base = PRICES.discount_card;
    finalOriginal = base;
    const isTeamBuy = isActiveTeamMember(member);
    if (isTeamBuy && base >= TEAM_DISCOUNT_MIN_AMOUNT) {
      finalAmount = Math.round(base * PRICES.team_discount_rate);
      finalTeam = true;
    } else {
      finalAmount = base;
      finalTeam = false;
    }
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
    // 有效隊員購買定期票 9 折
    const isTeamBuyPass = isActiveTeamMember(member);
    if (isTeamBuyPass && pt.price >= TEAM_DISCOUNT_MIN_AMOUNT) {
      finalAmount = Math.round(pt.price * PRICES.team_discount_rate);
      finalTeam = true;
    } else {
      finalAmount = pt.price;
      finalTeam = false;
    }
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
    // 免費入場但有加租（岩鞋/粉袋）時 paymentMethod 可能為 null → 有實收金額就預設現金（櫃檯實收），供結帳付款方式歸類
    paymentMethod: pending.paymentMethod || (((buyPassInstallmentApplied ? 0 : pending.amount) + pending.shoesPrice + (pending.chalkPrice || 0)) > 0 ? 'cash' : null),
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

  return { checkIn };
};

// 取消入場時還原「續約附加」：復原票期/次數、作廢續約分期計畫、一次付清記負向沖銷。
// 供 checkinService.cancelCheckIn 與 cancelCheckin.js 路由共用（兩條取消路徑一致）。
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

module.exports = { GYM_NAMES, createPendingCheckIn, scanQrCode, confirmCheckIn, countByEntryType, getTodayStats };
