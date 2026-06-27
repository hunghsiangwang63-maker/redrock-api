/**
 * 黑卡 Service（舊有實體預付卡，已停售）
 *
 * 期限規則：
 * - 原始黑卡：無到期日（已付費）
 * - 第一次移轉：被移轉次數 expiresAt = 移轉日 + 1年（固定）
 * - 再次移轉：繼承上次 expiresAt，不延長
 * - 移轉前需確認雙方看到到期日（有期限的才需要）
 */
const { getDb } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const COLLECTION = 'legacyBlackCards';
const BLACK_CARD_CREDITS = 12;
const TRANSFER_VALIDITY_MONTHS = 12;
const EXPIRY_WARNING_DAYS = 30;

// ── 綁定舊黑卡至會員帳號 ─────────────────────────────────────────
const bindBlackCard = async ({ barcode, memberId, remainingCredits, gymId, staffId }) => {
  const db = getDb();

  if (barcode) {
    const existing = await db.collection(COLLECTION)
      .where('barcode', '==', barcode).limit(1).get();
    if (!existing.empty) throw { code: 'CARD_ALREADY_BOUND', message: '此黑卡已綁定會員' };
  }

  const cardId = uuidv4();
  const now = new Date();
  const card = {
    id: cardId,
    barcode: barcode || null,
    memberId,
    originalCredits: BLACK_CARD_CREDITS,
    remainingCredits: Math.min(Math.max(0, parseInt(remainingCredits) || 0), BLACK_CARD_CREDITS),
    gymId,
    boundAt: now,
    boundBy: staffId,
    expiresAt: null,           // 原始卡無期限
    isActive: true,
    source: 'original',
    originalCardId: cardId,    // 追蹤源頭
    transferHistory: [],
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTION).doc(cardId).set(card);
  return card;
};

// ── 移轉前預覽（顯示到期日給雙方確認）────────────────────────────
const getTransferPreview = async (fromCardId, toMemberId, credits) => {
  const db = getDb();
  const cardDoc = await db.collection(COLLECTION).doc(fromCardId).get();
  if (!cardDoc.exists) throw { code: 'CARD_NOT_FOUND', message: '找不到此黑卡' };

  const card = cardDoc.data();
  if (credits > card.remainingCredits) {
    throw { code: 'INSUFFICIENT_CREDITS', message: `剩餘次數不足，目前只有 ${card.remainingCredits} 次` };
  }
  if (credits <= 0) throw { code: 'INVALID_CREDITS', message: '移轉次數必須大於 0' };

  // 計算接受方的到期日：
  // - 若原卡已有到期日（曾被移轉過）→ 繼承，不延長
  // - 若原卡無到期日（原始卡）→ 新增1年
  let receiverExpiresAt, receiverDaysLeft, isExpiringSoon = false;

  if (card.expiresAt) {
    // 已有到期日（繼承）
    receiverExpiresAt = dayjs(card.expiresAt.toDate()).format('YYYY-MM-DD');
    receiverDaysLeft = dayjs(card.expiresAt.toDate()).diff(dayjs(), 'day');
    isExpiringSoon = receiverDaysLeft <= EXPIRY_WARNING_DAYS;
  } else {
    // 原始卡首次移轉 → 新增1年
    const newExpiry = dayjs().add(TRANSFER_VALIDITY_MONTHS, 'month');
    receiverExpiresAt = newExpiry.format('YYYY-MM-DD');
    receiverDaysLeft = TRANSFER_VALIDITY_MONTHS * 30;
    isExpiringSoon = false;
  }

  // 發送方的到期日資訊
  const senderExpiresAt = card.expiresAt
    ? dayjs(card.expiresAt.toDate()).format('YYYY-MM-DD')
    : null;
  const senderDaysLeft = card.expiresAt
    ? dayjs(card.expiresAt.toDate()).diff(dayjs(), 'day')
    : null;

  return {
    card: {
      id: card.id,
      remainingCredits: card.remainingCredits,
      creditsAfterTransfer: card.remainingCredits - credits,
      expiresAt: senderExpiresAt,
      daysLeft: senderDaysLeft,
      isOriginal: !card.expiresAt,
    },
    transfer: {
      credits,
      receiverExpiresAt,
      receiverDaysLeft,
      isInherited: !!card.expiresAt, // true = 繼承，false = 首次設定
    },
    warning: isExpiringSoon
      ? `⚠ 此黑卡將於 ${receiverExpiresAt} 到期（剩餘 ${receiverDaysLeft} 天），移轉後接受方的使用期限相同，不會延長。`
      : card.expiresAt
        ? `此黑卡到期日為 ${receiverExpiresAt}，移轉後接受方期限相同，不會延長。`
        : null,
  };
};

// ── 執行移轉 ──────────────────────────────────────────────────────
const transferBlackCard = async ({ fromCardId, toMemberId, credits, staffId }) => {
  const db = getDb();
  const fromCardDoc = await db.collection(COLLECTION).doc(fromCardId).get();
  if (!fromCardDoc.exists) throw { code: 'CARD_NOT_FOUND' };

  const fromCard = fromCardDoc.data();
  if (fromCard.remainingCredits < credits) {
    throw { code: 'INSUFFICIENT_CREDITS', message: `剩餘次數不足（${fromCard.remainingCredits} 次）` };
  }

  const now = new Date();
  const newCardId = uuidv4();

  // 決定接受方到期日
  let expiresAt;
  if (fromCard.expiresAt) {
    // 已有到期日 → 繼承，不延長
    expiresAt = fromCard.expiresAt;
  } else {
    // 原始卡首次移轉 → 設定1年
    expiresAt = dayjs().add(TRANSFER_VALIDITY_MONTHS, 'month').toDate();
  }

  const newCard = {
    id: newCardId,
    barcode: null,
    memberId: toMemberId,
    originalCredits: credits,
    remainingCredits: credits,
    gymId: fromCard.gymId,
    boundAt: now,
    boundBy: staffId,
    expiresAt,                               // 固定，不再延長
    isActive: true,
    source: 'transferred',
    originalCardId: fromCard.originalCardId || fromCardId,
    transferredFrom: fromCardId,
    transferHistory: [],
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

// ── 使用黑卡（扣點）──────────────────────────────────────────────
const useBlackCard = async (cardId) => {
  const db = getDb();
  const cardDoc = await db.collection(COLLECTION).doc(cardId).get();
  if (!cardDoc.exists) throw { code: 'CARD_NOT_FOUND' };

  const card = cardDoc.data();
  if (!card.isActive) throw { code: 'CARD_INACTIVE', message: '此黑卡已停用' };

  if (card.expiresAt && dayjs().isAfter(dayjs(card.expiresAt.toDate()))) {
    throw { code: 'CARD_EXPIRED', message: '黑卡已過期' };
  }

  if (card.remainingCredits <= 0) throw { code: 'CARD_NO_CREDITS', message: '黑卡次數已用完' };

  const newCredits = card.remainingCredits - 1;
  await cardDoc.ref.update({
    remainingCredits: newCredits,
    isActive: newCredits > 0,
    updatedAt: new Date(),
  });

  return { creditsAfter: newCredits };
};

// ── 查詢會員有效黑卡 ─────────────────────────────────────────────
const getMemberBlackCards = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTION)
    .where('memberId', '==', memberId)
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
      isExpiringSoon: c.expiresAt ? dayjs(c.expiresAt.toDate()).diff(today, 'day') <= EXPIRY_WARNING_DAYS : false,
      isOriginal: !c.expiresAt,
    }));
};

module.exports = {
  bindBlackCard,
  getTransferPreview,
  transferBlackCard,
  useBlackCard,
  getMemberBlackCards,
  EXPIRY_WARNING_DAYS,
};
