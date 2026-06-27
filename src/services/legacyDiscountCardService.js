/**
 * 舊優惠卡 Service（已售出的實體舊卡）
 *
 * 移轉規則：與黑卡相同（首次移轉+1年，之後繼承）
 * 紅利規則：全部次數（含移轉）用完 → 原始持有者獲得6個月紅利
 */
const { getDb } = require('../config/firebase');
const { triggerBonus } = require('./bonusService');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const COLLECTION = 'legacyDiscountCards';
const TRANSFER_VALIDITY_MONTHS = 12;
const EXPIRY_WARNING_DAYS = 30;

// ── 綁定舊優惠卡（拍照歸檔）─────────────────────────────────────
const bindLegacyDiscountCard = async ({ memberId, remainingCredits, gymId, staffId, photoUrl, barcode }) => {
  const db = getDb();
  const cardId = uuidv4();
  const now = new Date();
  const credits = Math.max(0, parseInt(remainingCredits) || 0);

  const card = {
    id: cardId,
    ownerMemberId: memberId,
    originalOwnerMemberId: memberId,   // 紅利歸屬，永不改變
    originalCredits: credits,
    remainingCredits: credits,
    totalIssuedCredits: credits,       // 用於追蹤紅利
    totalUsedCredits: 0,
    bonusTriggered: false,
    photoUrl: photoUrl || null,        // 拍照存檔
    barcode: barcode || null,
    source: 'legacy',
    originalCardId: cardId,
    transferHistory: [],
    expiresAt: null,                   // 原始卡無期限
    gymId,
    boundAt: now,
    boundBy: staffId,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTION).doc(cardId).set(card);
  return card;
};

// ── 使用舊優惠卡（扣點＋追蹤紅利）──────────────────────────────
const useLegacyDiscountCard = async (cardId, gymId) => {
  const db = getDb();
  const cardDoc = await db.collection(COLLECTION).doc(cardId).get();
  if (!cardDoc.exists) throw { code: 'CARD_NOT_FOUND' };

  const card = cardDoc.data();
  if (!card.isActive) throw { code: 'CARD_INACTIVE' };
  if (card.expiresAt && dayjs().isAfter(dayjs(card.expiresAt.toDate()))) {
    throw { code: 'CARD_EXPIRED', message: '卡片已過期' };
  }
  if (card.remainingCredits <= 0) throw { code: 'CARD_NO_CREDITS' };

  const newCredits = card.remainingCredits - 1;
  await cardDoc.ref.update({
    remainingCredits: newCredits,
    isActive: newCredits > 0,
    updatedAt: new Date(),
  });

  const bonusResult = await incrementLegacyUsedCredits(card.originalCardId);

  return {
    creditsAfter: newCredits,
    bonusTriggered: bonusResult?.triggered || false,
    bonusMessage: bonusResult?.triggered
      ? `🎉 所有次數已全部使用完畢！原持有者已獲得6個月免費入場紅利`
      : null,
  };
};

// ── 累計使用次數，判斷是否觸發紅利 ─────────────────────────────
const incrementLegacyUsedCredits = async (originalCardId) => {
  const db = getDb();
  const origDoc = await db.collection(COLLECTION).doc(originalCardId).get();
  if (!origDoc.exists) return null;

  const orig = origDoc.data();
  if (orig.bonusTriggered) return null;

  const newUsed = (orig.totalUsedCredits || 0) + 1;
  await origDoc.ref.update({ totalUsedCredits: newUsed, updatedAt: new Date() });

  if (newUsed >= orig.totalIssuedCredits && orig.originalOwnerMemberId) {
    await origDoc.ref.update({ bonusTriggered: true });
    await triggerBonus({
      memberId: orig.originalOwnerMemberId,
      sourceType: 'legacy_discount_card',
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

  // 決定接受方到期日（與黑卡相同邏輯）
  let receiverExpiresAt, receiverDaysLeft, isExpiringSoon = false;

  if (card.expiresAt) {
    receiverExpiresAt = dayjs(card.expiresAt.toDate()).format('YYYY-MM-DD');
    receiverDaysLeft = dayjs(card.expiresAt.toDate()).diff(dayjs(), 'day');
    isExpiringSoon = receiverDaysLeft <= EXPIRY_WARNING_DAYS;
  } else {
    const newExpiry = dayjs().add(TRANSFER_VALIDITY_MONTHS, 'month');
    receiverExpiresAt = newExpiry.format('YYYY-MM-DD');
    receiverDaysLeft = TRANSFER_VALIDITY_MONTHS * 30;
  }

  return {
    card: {
      id: card.id,
      remainingCredits: card.remainingCredits,
      creditsAfterTransfer: card.remainingCredits - credits,
      expiresAt: card.expiresAt ? dayjs(card.expiresAt.toDate()).format('YYYY-MM-DD') : null,
      isOriginal: !card.expiresAt,
    },
    transfer: {
      credits,
      receiverExpiresAt,
      receiverDaysLeft,
      isFirstTransfer: !card.expiresAt,
    },
    warning: isExpiringSoon
      ? `⚠ 此卡將於 ${receiverExpiresAt} 到期（剩餘 ${receiverDaysLeft} 天），移轉後接受方期限相同。`
      : card.expiresAt
        ? `移轉後接受方到期日：${receiverExpiresAt}（繼承，不延長）`
        : null,
    bonusNote: `所有次數（含移轉）全部使用完畢時，原購買者將獲得6個月免費入場紅利。`,
  };
};

// ── 執行移轉 ──────────────────────────────────────────────────────
const transferLegacyDiscountCard = async ({ fromCardId, toMemberId, credits, staffId }) => {
  const db = getDb();
  const fromCardDoc = await db.collection(COLLECTION).doc(fromCardId).get();
  if (!fromCardDoc.exists) throw { code: 'CARD_NOT_FOUND' };

  const fromCard = fromCardDoc.data();
  if (fromCard.remainingCredits < credits) {
    throw { code: 'INSUFFICIENT_CREDITS', message: `剩餘次數不足（${fromCard.remainingCredits} 次）` };
  }

  const now = new Date();
  const newCardId = uuidv4();

  // 與黑卡相同：首次移轉設定1年，之後繼承
  const expiresAt = fromCard.expiresAt
    ? fromCard.expiresAt
    : dayjs().add(TRANSFER_VALIDITY_MONTHS, 'month').toDate();

  const newCard = {
    id: newCardId,
    ownerMemberId: toMemberId,
    originalOwnerMemberId: fromCard.originalOwnerMemberId, // 保留原始持有者
    originalCredits: credits,
    remainingCredits: credits,
    totalIssuedCredits: 0,
    totalUsedCredits: 0,
    bonusTriggered: false,
    photoUrl: null,
    barcode: null,
    source: 'transferred',
    originalCardId: fromCard.originalCardId,
    transferredFrom: fromCardId,
    transferHistory: [],
    expiresAt,
    gymId: fromCard.gymId,
    boundAt: now,
    boundBy: staffId,
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
    expiresAt: dayjs(expiresAt.toDate()).format('YYYY-MM-DD'),
    isFirstTransfer: !fromCard.expiresAt,
  };
};

// ── 查詢會員有效舊優惠卡 ─────────────────────────────────────────
const getMemberLegacyDiscountCards = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTION)
    .where('ownerMemberId', '==', memberId)
    .where('isActive', '==', true)
    .get();

  const today = dayjs();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => !c.expiresAt || today.isBefore(dayjs(c.expiresAt.toDate())))
    .map(c => ({
      ...c,
      expiresAtFormatted: c.expiresAt ? dayjs(c.expiresAt.toDate()).format('YYYY-MM-DD') : null,
      daysLeft: c.expiresAt ? dayjs(c.expiresAt.toDate()).diff(today, 'day') : null,
      isExpiringSoon: c.expiresAt
        ? dayjs(c.expiresAt.toDate()).diff(today, 'day') <= EXPIRY_WARNING_DAYS
        : false,
    }));
};

const getValidLegacyDiscountCards = async (memberId) => {
  return (await getMemberLegacyDiscountCards(memberId)).filter(c => c.remainingCredits > 0);
};

module.exports = {
  bindLegacyDiscountCard,
  useLegacyDiscountCard,
  getTransferPreview,
  transferLegacyDiscountCard,
  getMemberLegacyDiscountCards,
  getValidLegacyDiscountCards,
};
