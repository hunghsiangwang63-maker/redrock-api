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
const CARD_VALIDITY_MONTHS = 12; // 舊寫死值（已改為可設定，見 getDiscountCardValidityMonths；保留供參照）

// 新購優惠折扣卡使用期限（月）：讀 systemSettings/discountCard.validityMonths。
// 未設定 / 0 / 讀取失敗 → 回 null（＝無限期，目前暫定）。設定僅影響「之後售出」的卡、不追溯。
const getDiscountCardValidityMonths = async () => {
  try {
    const doc = await getDb().collection('systemSettings').doc('discountCard').get();
    const n = doc.exists ? Number(doc.data().validityMonths) : NaN;
    return Number.isFinite(n) && n >= 1 ? n : null; // null = 無限期
  } catch { return null; }
};
const EXPIRY_WARNING_DAYS = 30;

// ── 轉入舊優惠卡（設定剩餘次數）──────────────────────────────────
// 直接建到 discountCards（入場資格讀此集合），沿用全部既有邏輯：8折入場、移轉。
// 轉入卡＝新的「原始卡」：totalIssuedCredits=剩餘次數、bonusTriggered=false
// → 用完（含移轉子卡累計回本卡）即觸發紅利，與購買卡一致。
const bindDiscountCard = async ({ memberId, remainingCredits, gymId, staffId, barcode }) => {
  const db = getDb();
  if (memberId) {
    const mDoc = await db.collection('members').doc(memberId).get();
    if (!mDoc.exists) throw { code: 'MEMBER_NOT_FOUND', message: '找不到會員，無法綁定優惠卡' };
  }
  const cardId = uuidv4();
  const now = new Date();
  const expiresAt = null; // 轉入（綁定）優惠卡：無使用期限（購買入場產生的卡才有一年期限）
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
  const validityMonths = await getDiscountCardValidityMonths();
  const expiresAt = validityMonths ? dayjs().add(validityMonths, 'month').toDate() : null; // null = 無限期（依系統設定）

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
  if (card.expiresAt && dayjs().isAfter(dayjs(card.expiresAt.toDate()))) { // 無期限卡（轉入）跳過過期檢查
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
      // 使用期限改讀系統設定（super_admin 可調），不再寫死 6
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

  const expDate = card.expiresAt ? (typeof card.expiresAt.toDate === 'function' ? card.expiresAt.toDate() : new Date(card.expiresAt)) : null;
  const expiresAt = expDate ? dayjs(expDate) : null;          // 無期限卡 → null
  const daysLeft = expiresAt ? expiresAt.diff(dayjs(), 'day') : null;
  const isExpiringSoon = daysLeft != null && daysLeft <= EXPIRY_WARNING_DAYS;
  const expFmt = expiresAt ? expiresAt.format('YYYY-MM-DD') : null;

  return {
    card: {
      id: card.id,
      remainingCredits: card.remainingCredits,
      creditsAfterTransfer: card.remainingCredits - credits,
      expiresAt: expFmt,
      daysLeft,
      isExpiringSoon,
    },
    transfer: {
      credits,
      receiverExpiresAt: expFmt, // 繼承，不延長（無期限則同樣無期限）
      receiverDaysLeft: daysLeft,
      isInherited: true,
    },
    warning: !expiresAt
      ? `此優惠卡無使用期限，移轉後接受方同樣無期限。`
      : isExpiringSoon
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
    expiresAt: fromCard.expiresAt
      ? dayjs(typeof fromCard.expiresAt.toDate === 'function' ? fromCard.expiresAt.toDate() : fromCard.expiresAt).format('YYYY-MM-DD')
      : null, // 無期限卡移轉後仍無期限
  };
};

// ── 查詢會員優惠卡 ────────────────────────────────────────────────
const getMemberDiscountCards = async (memberId) => {
  const db = getDb();
  // 不用 Firestore orderBy('expiresAt')：無期限卡（expiresAt=null）會被 orderBy 排除、查不到 → 記憶體排序
  const snap = await db.collection(COLLECTION)
    .where('ownerMemberId', '==', memberId)
    .where('isActive', '==', true)
    .get();

  const today = dayjs();
  const asDate = (ts) => ts ? (typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts)) : null;
  const cards = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => { const e = asDate(c.expiresAt); return !e || today.isBefore(dayjs(e)); }) // 無期限或未過期
    .map(c => {
      const e = asDate(c.expiresAt);
      return {
        ...c,
        expiresAtFormatted: e ? dayjs(e).format('YYYY-MM-DD') : null,
        daysLeft: e ? dayjs(e).diff(today, 'day') : null,
        isExpiringSoon: e ? dayjs(e).diff(today, 'day') <= EXPIRY_WARNING_DAYS : false,
      };
    })
    // 有期限的到期日近→遠優先使用，無期限的排最後
    .sort((a, b) => (a.expiresAtFormatted || '9999-12-31').localeCompare(b.expiresAtFormatted || '9999-12-31'));

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
  getDiscountCardValidityMonths,
};
