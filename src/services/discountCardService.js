/**
 * 優惠卡 Service（新卡）
 *
 * 紅利規則：原始卡所有次數（含移轉出去的）全部用完 → 原始持有者獲得6個月免費入場紅利
 * 移轉規則：移轉後繼承原卡到期日（不延長）
 */
const { getDb } = require('../config/firebase');
const { triggerBonus } = require('./bonusService');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const COLLECTION = 'discountCards';
const CARD_CREDITS = 10;
const CARD_VALIDITY_MONTHS = 12;
const EXPIRY_WARNING_DAYS = 30;

// ── 轉入舊優惠卡（設定剩餘次數）──────────────────────────────────
// 直接建到 discountCards（入場資格讀此集合），沿用全部既有邏輯：8折入場、移轉。
// 轉入卡＝新的「原始卡」：totalIssuedCredits=剩餘次數、bonusTriggered=false
// → 用完（含移轉子卡累計回本卡）即觸發紅利，與購買卡一致。
const bindDiscountCard = async ({ memberId, remainingCredits, gymId, staffId, barcode }) => {
  const db = getDb();
  const cardId = uuidv4();
  const now = new Date();
  const expiresAt = dayjs().add(CARD_VALIDITY_MONTHS, 'month').toDate();
  const credits = Math.min(Math.max(1, parseInt(remainingCredits) || 0), CARD_CREDITS); // 上限 10 格
  const card = {
    id: cardId,
    ownerMemberId: memberId || null,
    originalOwnerMemberId: memberId || null,
    purchasePrice: 0,
    originalCredits: credits,
    remainingCredits: credits,
    totalIssuedCredits: credits,
    totalUsedCredits: 0,
    bonusTriggered: false,     // 轉入卡用完（含移轉子卡累計）觸發紅利，與購買卡一致
    source: 'migrated',
    barcode: barcode || null,
    originalCardId: cardId,
    transferHistory: [],
    expiresAt,
    purchasedAt: now,
    gymId,
    soldByStaffId: staffId,
    paymentId: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(COLLECTION).doc(cardId).set(card);
  return card;
};

// ── 購買新優惠卡 ──────────────────────────────────────────────────
const purchaseDiscountCard = async ({ memberId, gymId, staffId, price, paymentId }) => {
  const db = getDb();
  const cardId = uuidv4();
  const now = new Date();
  const expiresAt = dayjs().add(CARD_VALIDITY_MONTHS, 'month').toDate();

  const card = {
    id: cardId,
    ownerMemberId: memberId || null,
    originalOwnerMemberId: memberId || null, // 紅利歸屬，永不改變
    purchasePrice: price,
    originalCredits: CARD_CREDITS,
    remainingCredits: CARD_CREDITS,
    // 紅利追蹤
    totalIssuedCredits: CARD_CREDITS,   // 原始發出的總次數
    totalUsedCredits: 0,                 // 全部已使用（含子卡）
    bonusTriggered: false,
    // 移轉
    source: 'new',
    originalCardId: cardId,
    transferHistory: [],
    // 期限
    expiresAt,
    purchasedAt: now,
    gymId,
    soldByStaffId: staffId,
    paymentId: paymentId || null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTION).doc(cardId).set(card);
  return card;
};

// ── 使用優惠卡（扣點＋追蹤紅利）────────────────────────────────
const useDiscountCard = async (cardId, gymId) => {
  const db = getDb();
  const cardDoc = await db.collection(COLLECTION).doc(cardId).get();
  if (!cardDoc.exists) throw { code: 'CARD_NOT_FOUND' };

  const card = cardDoc.data();
  if (!card.isActive) throw { code: 'CARD_INACTIVE', message: '此優惠卡已停用' };
  if (dayjs().isAfter(dayjs(card.expiresAt.toDate()))) {
    throw { code: 'CARD_EXPIRED', message: '優惠卡已過期' };
  }
  if (card.remainingCredits <= 0) throw { code: 'CARD_NO_CREDITS', message: '優惠卡次數已用完' };

  const newCredits = card.remainingCredits - 1;
  await cardDoc.ref.update({
    remainingCredits: newCredits,
    isActive: newCredits > 0,
    updatedAt: new Date(),
  });

  // 更新原始卡的 totalUsedCredits
  const bonusResult = await incrementUsedCredits(card.originalCardId, card.id);

  return {
    type: 'normal',
    creditsAfter: newCredits,
    bonusTriggered: bonusResult?.triggered || false,
    bonusMessage: bonusResult?.triggered
      ? `🎉 所有次數已全部使用完畢！原持有者已獲得6個月免費入場紅利`
      : null,
  };
};

// ── 累計使用次數，判斷是否觸發紅利 ─────────────────────────────
const incrementUsedCredits = async (originalCardId, usedCardId) => {
  const db = getDb();
  const origDoc = await db.collection(COLLECTION).doc(originalCardId).get();
  if (!origDoc.exists) return null;

  const orig = origDoc.data();
  if (orig.bonusTriggered) return null; // 已觸發過，不重複

  const newUsed = (orig.totalUsedCredits || 0) + 1;
  await origDoc.ref.update({ totalUsedCredits: newUsed, updatedAt: new Date() });

  // 全部次數用完 → 觸發紅利
  if (newUsed >= orig.totalIssuedCredits && orig.originalOwnerMemberId) {
    await origDoc.ref.update({ bonusTriggered: true });
    await triggerBonus({
      memberId: orig.originalOwnerMemberId,
      sourceType: 'discount_card',
      sourceId: originalCardId,
      validityMonths: 6,
    });
    return { triggered: true, memberId: orig.originalOwnerMemberId };
  }

  return { triggered: false };
};

// ── 移轉前預覽 ────────────────────────────────────────────────────
const getTransferPreview = async (fromCardId, toMemberId, credits) => {
  const db = getDb();
  const cardDoc = await db.collection(COLLECTION).doc(fromCardId).get();
  if (!cardDoc.exists) throw { code: 'CARD_NOT_FOUND' };

  const card = cardDoc.data();
  if (credits > card.remainingCredits) {
    throw { code: 'INSUFFICIENT_CREDITS', message: `剩餘次數不足（${card.remainingCredits} 次）` };
  }

  const expiresAt = dayjs(card.expiresAt.toDate());
  const daysLeft = expiresAt.diff(dayjs(), 'day');
  const isExpiringSoon = daysLeft <= EXPIRY_WARNING_DAYS;

  return {
    card: {
      id: card.id,
      remainingCredits: card.remainingCredits,
      creditsAfterTransfer: card.remainingCredits - credits,
      expiresAt: expiresAt.format('YYYY-MM-DD'),
      daysLeft,
      isExpiringSoon,
    },
    transfer: {
      credits,
      receiverExpiresAt: expiresAt.format('YYYY-MM-DD'), // 繼承，不延長
      receiverDaysLeft: daysLeft,
      isInherited: true,
    },
    warning: isExpiringSoon
      ? `⚠ 此優惠卡將於 ${expiresAt.format('YYYY/MM/DD')} 到期（剩餘 ${daysLeft} 天），移轉後接受方的使用期限相同。`
      : `移轉後接受方到期日：${expiresAt.format('YYYY/MM/DD')}（與原卡相同，不延長）`,
    bonusNote: `移轉後，所有次數（含移轉）全部使用完畢時，原購買者將獲得6個月免費入場紅利。`,
  };
};

// ── 執行移轉 ──────────────────────────────────────────────────────
const transferDiscountCard = async ({ fromCardId, toMemberId, credits, staffId }) => {
  const db = getDb();
  const fromCardDoc = await db.collection(COLLECTION).doc(fromCardId).get();
  if (!fromCardDoc.exists) throw { code: 'CARD_NOT_FOUND' };

  const fromCard = fromCardDoc.data();
  if (fromCard.remainingCredits < credits) {
    throw { code: 'INSUFFICIENT_CREDITS', message: `剩餘次數不足（${fromCard.remainingCredits} 次）` };
  }

  const now = new Date();
  const newCardId = uuidv4();

  // 子卡繼承原卡到期日
  const newCard = {
    id: newCardId,
    ownerMemberId: toMemberId,
    originalOwnerMemberId: fromCard.originalOwnerMemberId, // 保留原始持有者
    purchasePrice: 0,
    originalCredits: credits,
    remainingCredits: credits,
    totalIssuedCredits: 0,   // 子卡不追蹤（由原始卡追蹤）
    totalUsedCredits: 0,
    bonusTriggered: false,
    source: 'transferred',
    originalCardId: fromCard.originalCardId, // 指向最原始的卡
    transferredFrom: fromCardId,
    transferHistory: [],
    expiresAt: fromCard.expiresAt, // 繼承，不延長
    purchasedAt: now,
    gymId: fromCard.gymId,
    soldByStaffId: staffId,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  const newFromCredits = fromCard.remainingCredits - credits;
  await fromCardDoc.ref.update({
    remainingCredits: newFromCredits,
    isActive: newFromCredits > 0,
    transferHistory: [
      ...(fromCard.transferHistory || []),
      { toMemberId, credits, newCardId, transferredAt: now, by: staffId },
    ],
    updatedAt: now,
  });

  await db.collection(COLLECTION).doc(newCardId).set(newCard);

  return {
    fromCard: { ...fromCard, remainingCredits: newFromCredits },
    newCard,
    expiresAt: dayjs(fromCard.expiresAt.toDate()).format('YYYY-MM-DD'),
  };
};

// ── 查詢會員優惠卡 ────────────────────────────────────────────────
const getMemberDiscountCards = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTION)
    .where('ownerMemberId', '==', memberId)
    .where('isActive', '==', true)
    .orderBy('expiresAt', 'asc')
    .get();

  const today = dayjs();
  const cards = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => today.isBefore(dayjs(c.expiresAt.toDate())))
    .map(c => ({
      ...c,
      expiresAtFormatted: dayjs(c.expiresAt.toDate()).format('YYYY-MM-DD'),
      daysLeft: dayjs(c.expiresAt.toDate()).diff(today, 'day'),
      isExpiringSoon: dayjs(c.expiresAt.toDate()).diff(today, 'day') <= EXPIRY_WARNING_DAYS,
    }));

  // 移轉取得的卡：用完後紅利歸「原購買者」（非持卡人），標註 + 帶原購買者姓名
  const memberService = require('./memberService');
  for (const c of cards) {
    if (c.originalOwnerMemberId && c.originalOwnerMemberId !== c.ownerMemberId) {
      c.bonusToOriginalOwner = true;
      try { const o = await memberService.getMember(c.originalOwnerMemberId); c.originalOwnerName = o?.name || null; }
      catch { c.originalOwnerName = null; }
    }
  }
  return cards;
};

const getValidDiscountCards = async (memberId) => {
  return (await getMemberDiscountCards(memberId)).filter(c => c.remainingCredits > 0);
};

module.exports = {
  purchaseDiscountCard,
  bindDiscountCard,
  useDiscountCard,
  getTransferPreview,
  transferDiscountCard,
  getMemberDiscountCards,
  getValidDiscountCards,
  incrementUsedCredits,
  EXPIRY_WARNING_DAYS,
};
