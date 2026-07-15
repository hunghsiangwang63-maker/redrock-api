/**
 * 紅利 Service
 * 用於優惠卡（新/舊）使用完畢後的免費入場紅利
 *
 * 紅利規格：
 * - 有效期：觸發日起 N 個月（預設6個月）
 * - 使用：免費入場一次，兩館皆可
 * - 移轉：只能整筆移轉給其他會員帳號
 * - 移轉後：繼承原到期日，不延長
 */
const { getDb } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const COLLECTION = 'discountBonuses';
const EXPIRY_WARNING_DAYS = 30;

// ── 紅利使用期限（月）：讀系統設定 systemSettings/bonus.validityMonths，預設/失敗回 6 ──
const getBonusValidityMonths = async () => {
  try {
    const doc = await getDb().collection('systemSettings').doc('bonus').get();
    const n = doc.exists ? Number(doc.data().validityMonths) : NaN;
    return (Number.isFinite(n) && n >= 1 && n <= 60) ? Math.round(n) : 6;
  } catch { return 6; }
};

// ── 觸發紅利（由各卡服務呼叫）───────────────────────────────────
// validityMonths 未指定時讀系統設定（可由 super_admin 於員工端調整），預設 6 個月。
const triggerBonus = async ({ memberId, sourceType, sourceId, validityMonths }) => {
  const db = getDb();
  const bonusId = uuidv4();
  const now = new Date();
  const months = validityMonths ?? await getBonusValidityMonths();
  const expiresAt = dayjs().add(months, 'month').toDate();

  const bonus = {
    id: bonusId,
    ownerMemberId: memberId,
    originalOwnerMemberId: memberId, // 記錄原始持有者
    sourceType,    // 'discount_card' | 'legacy_discount_card'
    sourceId,      // 原始卡 ID
    isUsed: false,
    usedAt: null,
    usedAtGymId: null,
    expiresAt,
    validityMonths: months,
    transferHistory: [],
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTION).doc(bonusId).set(bonus);

  // 發 Email 通知（非阻斷）
  try {
    const emailService = require('./emailService');
    const memberDoc = await db.collection('members').doc(memberId).get();
    if (memberDoc.exists && memberDoc.data().email) {
      await emailService.sendBonusTriggered({
        email: memberDoc.data().email,
        name: memberDoc.data().name,
        expiresAt: dayjs(expiresAt).format('YYYY-MM-DD'),
      });
    }
  } catch (e) {
    console.error('Bonus email error:', e.message);
  }

  console.log(`🎉 Bonus triggered for member ${memberId} (${sourceType}:${sourceId})`);
  return bonus;
};

// ── 使用紅利 ──────────────────────────────────────────────────────
const useBonus = async (bonusId, gymId) => {
  const db = getDb();
  const bonusDoc = await db.collection(COLLECTION).doc(bonusId).get();
  if (!bonusDoc.exists) throw { code: 'BONUS_NOT_FOUND' };

  const bonus = bonusDoc.data();
  if (!bonus.isActive || bonus.isUsed) throw { code: 'BONUS_USED', message: '紅利已使用' };
  if (dayjs().isAfter(dayjs(bonus.expiresAt.toDate()))) {
    throw { code: 'BONUS_EXPIRED', message: '紅利已過期' };
  }

  await bonusDoc.ref.update({
    isUsed: true,
    isActive: false,
    usedAt: new Date(),
    usedAtGymId: gymId,
    updatedAt: new Date(),
  });

  return { used: true };
};

// ── 移轉紅利（整筆，繼承到期日）─────────────────────────────────
const transferBonus = async ({ bonusId, toMemberId, staffId }) => {
  const db = getDb();
  const bonusDoc = await db.collection(COLLECTION).doc(bonusId).get();
  if (!bonusDoc.exists) throw { code: 'BONUS_NOT_FOUND' };

  const bonus = bonusDoc.data();
  if (!bonus.isActive || bonus.isUsed) throw { code: 'BONUS_UNAVAILABLE', message: '此紅利無法移轉' };
  if (dayjs().isAfter(dayjs(bonus.expiresAt.toDate()))) {
    throw { code: 'BONUS_EXPIRED', message: '紅利已過期，無法移轉' };
  }

  const now = new Date();
  const expiresAt = bonus.expiresAt; // 繼承，不延長

  // 更新原紅利為已移轉
  await bonusDoc.ref.update({
    isActive: false,
    transferredTo: toMemberId,
    transferredAt: now,
    transferHistory: [
      ...(bonus.transferHistory || []),
      { toMemberId, transferredAt: now, by: staffId },
    ],
    updatedAt: now,
  });

  // 建立新紅利
  const newBonusId = uuidv4();
  await db.collection(COLLECTION).doc(newBonusId).set({
    ...bonus,
    id: newBonusId,
    ownerMemberId: toMemberId,
    expiresAt,               // 繼承
    transferHistory: [
      ...(bonus.transferHistory || []),
      { fromMemberId: bonus.ownerMemberId, transferredAt: now, by: staffId },
    ],
    createdAt: now,
    updatedAt: now,
  });

  return {
    newBonusId,
    expiresAt: dayjs(expiresAt.toDate()).format('YYYY-MM-DD'),
  };
};

// ── 移轉前預覽 ────────────────────────────────────────────────────
const getBonusTransferPreview = async (bonusId) => {
  const db = getDb();
  const bonusDoc = await db.collection(COLLECTION).doc(bonusId).get();
  if (!bonusDoc.exists) throw { code: 'BONUS_NOT_FOUND' };

  const bonus = bonusDoc.data();
  const expiresAt = dayjs(bonus.expiresAt.toDate());
  const daysLeft = expiresAt.diff(dayjs(), 'day');
  const isExpiringSoon = daysLeft <= EXPIRY_WARNING_DAYS;

  return {
    bonus: {
      id: bonus.id,
      expiresAt: expiresAt.format('YYYY-MM-DD'),
      daysLeft,
      isExpiringSoon,
    },
    warning: isExpiringSoon
      ? `⚠ 此紅利將於 ${expiresAt.format('YYYY/MM/DD')} 到期（剩餘 ${daysLeft} 天），移轉後接受方期限相同。`
      : `移轉後接受方到期日：${expiresAt.format('YYYY/MM/DD')}（繼承，不延長）`,
  };
};

// ── 排程清除過期紅利（每日）──────────────────────────────────────
// 將已過期、仍為 active 的未使用紅利標記為 inactive（保留文件供歷史查詢，不硬刪除）。
// 只掃 isActive==true（已使用/已移轉皆已為 false，集合自然很小），到期判斷在 JS，免建複合索引。
const sweepExpiredBonuses = async () => {
  const db = getDb();
  const now = new Date();
  const snap = await db.collection(COLLECTION).where('isActive', '==', true).get();

  const expired = snap.docs.filter(d => {
    const b = d.data();
    if (b.isUsed) return false;
    const exp = b.expiresAt && b.expiresAt.toDate ? b.expiresAt.toDate() : b.expiresAt;
    return exp && dayjs(now).isAfter(dayjs(exp));
  });

  let processed = 0;
  for (let i = 0; i < expired.length; i += 400) {
    const chunk = expired.slice(i, i + 400);
    const batch = db.batch();
    chunk.forEach(d => batch.update(d.ref, { isActive: false, expiredAt: now, updatedAt: now }));
    await batch.commit();
    processed += chunk.length;
  }

  return { expiredCount: processed };
};

// ── 查詢會員有效紅利 ──────────────────────────────────────────────
const getMemberBonuses = async (memberId, { includeInactive = false } = {}) => {
  const db = getDb();
  // 單 where(ownerMemberId) + 記憶體過濾；includeInactive → 含已使用/已過期/停用（完整歷史）
  const snap = await db.collection(COLLECTION)
    .where('ownerMemberId', '==', memberId)
    .get();

  const today = dayjs();
  const expOf = (b) => b.expiresAt?.toDate ? b.expiresAt.toDate() : (b.expiresAt ? new Date(b.expiresAt) : null);
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!includeInactive) {
    rows = rows.filter(b => b.isActive !== false && b.isUsed !== true).filter(b => { const e = expOf(b); return e && today.isBefore(dayjs(e)); });
  }
  return rows.map(b => {
    const e = expOf(b);
    return {
      ...b,
      expiresAtFormatted: e ? dayjs(e).format('YYYY-MM-DD') : null,
      daysLeft: e ? dayjs(e).diff(today, 'day') : null,
      isExpiringSoon: e ? dayjs(e).diff(today, 'day') <= EXPIRY_WARNING_DAYS : false,
      isExpired: e ? today.isAfter(dayjs(e)) : false,
    };
  });
};

module.exports = {
  triggerBonus,
  useBonus,
  transferBonus,
  getBonusTransferPreview,
  getMemberBonuses,
  sweepExpiredBonuses,
};
