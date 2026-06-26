/**
 * 紅石攀岩隊員 Service
 *
 * 折扣規則：
 * - 隊員身份由管理員設定，有年度有效期
 * - 單項金額 ≥ NT$100 → 九折
 * - 適用範圍：入場費、商品、課程、比賽報名費
 */
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');

const TEAM_DISCOUNT_RATE = 0.9;       // 九折
const TEAM_DISCOUNT_MIN_AMOUNT = 100; // 最低適用金額
const EXPIRY_WARNING_DAYS = 30;       // 到期前幾天提醒

// ── 設定隊員身份（管理員）────────────────────────────────────────
const setTeamMember = async ({ memberId, since, until, staffId }) => {
  const db = getDb();
  const now = new Date();

  const updates = {
    isTeamMember: true,
    teamMemberSince: since,
    teamMemberUntil: until,
    teamMemberSetBy: staffId,
    teamMemberSetAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update(updates);

  // Audit Log
  await db.collection(COLLECTIONS.AUDIT_LOG).add({
    action: 'team_member.set',
    staffId,
    targetMemberId: memberId,
    detail: { since, until },
    timestamp: now,
  });

  return updates;
};

// ── 移除隊員身份（管理員）────────────────────────────────────────
const removeTeamMember = async ({ memberId, staffId }) => {
  const db = getDb();
  const now = new Date();

  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
    isTeamMember: false,
    teamMemberSince: null,
    teamMemberUntil: null,
    updatedAt: now,
  });

  await db.collection(COLLECTIONS.AUDIT_LOG).add({
    action: 'team_member.remove',
    staffId,
    targetMemberId: memberId,
    timestamp: now,
  });
};

// ── 確認隊員身份是否有效 ─────────────────────────────────────────
const isActiveTeamMember = (member) => {
  if (!member.isTeamMember) return false;
  if (!member.teamMemberUntil) return false;
  const today = dayjs().format('YYYY-MM-DD');
  return member.teamMemberSince <= today && today <= member.teamMemberUntil;
};

// ── 計算單項折扣 ──────────────────────────────────────────────────
const applyTeamDiscount = (amount, isTeamMemberActive) => {
  if (!isTeamMemberActive) {
    return { original: amount, discounted: amount, discount: 0, applied: false };
  }

  if (amount < TEAM_DISCOUNT_MIN_AMOUNT) {
    return { original: amount, discounted: amount, discount: 0, applied: false, reason: 'below_minimum' };
  }

  const discounted = Math.round(amount * TEAM_DISCOUNT_RATE);
  const discount = amount - discounted;

  return {
    original: amount,
    discounted,
    discount,
    applied: true,
    rate: TEAM_DISCOUNT_RATE,
  };
};

// ── 計算整張訂單折扣（多個項目）─────────────────────────────────
const applyTeamDiscountToOrder = (items, isTeamMemberActive) => {
  /**
   * items: [{ name, amount, type }]
   * type: 'checkin' | 'product' | 'course' | 'competition'
   */
  let totalOriginal = 0;
  let totalDiscounted = 0;
  let totalDiscount = 0;

  const calculated = items.map(item => {
    const result = applyTeamDiscount(item.amount, isTeamMemberActive);
    totalOriginal += result.original;
    totalDiscounted += result.discounted;
    totalDiscount += result.discount;
    return { ...item, ...result };
  });

  return {
    items: calculated,
    totalOriginal,
    totalDiscounted,
    totalDiscount,
    hasDiscount: totalDiscount > 0,
    discountType: isTeamMemberActive ? 'team_member' : null,
  };
};

// ── 查詢即將到期的隊員（管理員）─────────────────────────────────
const getExpiringTeamMembers = async (gymId, days = EXPIRY_WARNING_DAYS) => {
  const db = getDb();
  const today = dayjs().format('YYYY-MM-DD');
  const warningDate = dayjs().add(days, 'day').format('YYYY-MM-DD');

  const snap = await db.collection(COLLECTIONS.MEMBERS)
    .where('isTeamMember', '==', true)
    .where('teamMemberUntil', '>=', today)
    .where('teamMemberUntil', '<=', warningDate)
    .get();

  return snap.docs.map(d => ({
    id: d.id,
    name: d.data().name,
    phone: d.data().phone,
    teamMemberUntil: d.data().teamMemberUntil,
    daysLeft: dayjs(d.data().teamMemberUntil).diff(dayjs(), 'day'),
  }));
};

// ── 查詢所有有效隊員 ─────────────────────────────────────────────
const getActiveTeamMembers = async () => {
  const db = getDb();
  const today = dayjs().format('YYYY-MM-DD');

  const snap = await db.collection(COLLECTIONS.MEMBERS)
    .where('isTeamMember', '==', true)
    .where('teamMemberUntil', '>=', today)
    .get();

  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(m => m.teamMemberSince <= today);
};

module.exports = {
  setTeamMember,
  removeTeamMember,
  isActiveTeamMember,
  applyTeamDiscount,
  applyTeamDiscountToOrder,
  getExpiringTeamMembers,
  getActiveTeamMembers,
  TEAM_DISCOUNT_RATE,
  TEAM_DISCOUNT_MIN_AMOUNT,
};
