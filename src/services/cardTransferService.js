/**
 * 卡片次數移轉（兩段式，優惠卡 discount / 黑卡 black 共用）
 * 發起：來源卡「暫扣」次數 → 建立 pending 移轉單（不建受贈者卡）
 * 接收：受贈者於會員 App 接收 → 建受贈者卡、移轉單 completed
 * 取消：發起方/員工可取消 → 次數回沖、移轉單 cancelled
 * 逾時：24 小時未接收 → 自動回沖、移轉單 expired
 */
const { getDb } = require('../config/firebase');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');

const COLLECTION = 'cardTransfers';
const EXPIRY_HOURS = 24;
const cardColl = (type) => (type === 'black' ? 'legacyBlackCards' : 'discountCards');
const ownerField = (type) => (type === 'black' ? 'memberId' : 'ownerMemberId');

const toDate = (v) => (v?.toDate ? v.toDate() : (v?._seconds ? new Date(v._seconds * 1000) : (v ? new Date(v) : null)));

// ── 發起移轉（暫扣來源、建 pending）─────────────────────────────────
const initiateTransfer = async ({ cardType, fromCardId, toMemberId, credits, initiatedBy, initiatedByType }) => {
  const db = getDb();
  const memberService = require('./memberService');
  if (!['discount', 'black'].includes(cardType)) throw { code: 'BAD_TYPE', message: '卡別錯誤' };
  credits = parseInt(credits) || 0;
  if (credits < 1) throw { code: 'BAD_CREDITS', message: '移轉次數需至少 1' };

  const ref = db.collection(cardColl(cardType)).doc(fromCardId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'CARD_NOT_FOUND', message: '找不到卡片' };
  const card = doc.data();
  const fromMemberId = card[ownerField(cardType)];
  if (fromMemberId === toMemberId) throw { code: 'SAME_MEMBER', message: '不能移轉給自己' };
  if ((card.remainingCredits || 0) < credits) throw { code: 'INSUFFICIENT_CREDITS', message: `剩餘次數不足（${card.remainingCredits} 次）` };

  // 受贈者需存在（打錯電話→查無會員時，route 層解析階段即擋；此處再保險）
  const toMember = await memberService.getMember(toMemberId).catch(() => null);
  if (!toMember) throw { code: 'MEMBER_NOT_FOUND', message: '找不到受贈會員' };
  const fromMember = await memberService.getMember(fromMemberId).catch(() => null);

  // 受贈者卡到期日：優惠卡繼承來源；黑卡有到期日則繼承、否則自接收起 1 年（於接收時再定）
  const now = new Date();
  const targetExpiresAt = card.expiresAt || null; // 黑卡無到期日時 null → 接收時設 1 年

  const id = uuidv4();
  const transfer = {
    id, cardType,
    fromCardId, fromMemberId, fromMemberName: fromMember?.name || '',
    toMemberId, toMemberName: toMember.name || '',
    credits,
    gymId: card.gymId || null,
    originalCardId: card.originalCardId || fromCardId,
    originalOwnerMemberId: card.originalOwnerMemberId || fromMemberId, // 優惠卡紅利歸屬
    targetExpiresAt,
    status: 'pending',
    initiatedBy: initiatedBy || null, initiatedByType: initiatedByType || 'staff',
    createdAt: now,
    expiresAt: dayjs(now).add(EXPIRY_HOURS, 'hour').toDate(),
  };

  // 暫扣來源次數（先扣，接收/回沖前不可再用；用完則停用）
  const remain = (card.remainingCredits || 0) - credits;
  await ref.update({ remainingCredits: remain, isActive: remain > 0, updatedAt: now });
  await db.collection(COLLECTION).doc(id).set(transfer);
  return transfer;
};

// ── 接收（受贈者，會員 App）→ 建受贈者卡、completed ──────────────────
const acceptTransfer = async (transferId, memberId) => {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(transferId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此移轉' };
  const t = doc.data();
  if (t.toMemberId !== memberId) throw { code: 'FORBIDDEN', message: '只能接收給自己的移轉' };
  if (t.status !== 'pending') throw { code: 'ALREADY_RESOLVED', message: '此移轉已處理' };
  if (toDate(t.expiresAt) < new Date()) { await revertOne(t); throw { code: 'EXPIRED', message: '此移轉已逾期並回沖' }; }

  const now = new Date();
  const newCardId = uuidv4();
  if (t.cardType === 'discount') {
    await db.collection('discountCards').doc(newCardId).set({
      id: newCardId, ownerMemberId: t.toMemberId, originalOwnerMemberId: t.originalOwnerMemberId,
      purchasePrice: 0, originalCredits: t.credits, remainingCredits: t.credits,
      totalIssuedCredits: 0, totalUsedCredits: 0, bonusTriggered: false,
      source: 'transferred', originalCardId: t.originalCardId, transferredFrom: t.fromCardId,
      transferHistory: [], expiresAt: t.targetExpiresAt, purchasedAt: now,
      gymId: t.gymId, soldByStaffId: t.initiatedBy || null, isActive: true, createdAt: now, updatedAt: now,
    });
  } else {
    const expiresAt = t.targetExpiresAt || dayjs(now).add(12, 'month').toDate(); // 黑卡無到期日 → 自接收起 1 年
    await db.collection('legacyBlackCards').doc(newCardId).set({
      id: newCardId, barcode: null, memberId: t.toMemberId,
      originalCredits: t.credits, remainingCredits: t.credits, gymId: t.gymId,
      boundAt: now, boundBy: t.initiatedBy || null, expiresAt,
      isActive: true, source: 'transferred', originalCardId: t.originalCardId, transferredFrom: t.fromCardId,
      transferHistory: [], createdAt: now, updatedAt: now,
    });
  }
  // 來源卡的 transferHistory 補記已完成
  try {
    const fref = db.collection(cardColl(t.cardType)).doc(t.fromCardId);
    const fdoc = await fref.get();
    if (fdoc.exists) await fref.update({ transferHistory: [ ...(fdoc.data().transferHistory || []), { toMemberId: t.toMemberId, credits: t.credits, newCardId, transferredAt: now, transferId } ], updatedAt: now });
  } catch (e) {}

  await ref.update({ status: 'completed', acceptedAt: now, newCardId, updatedAt: now });
  return { newCardId };
};

// ── 回沖單筆（次數還給來源）──────────────────────────────────────────
const revertOne = async (t, status = 'expired') => {
  const db = getDb();
  const now = new Date();
  const fref = db.collection(cardColl(t.cardType)).doc(t.fromCardId);
  const fdoc = await fref.get();
  if (fdoc.exists) {
    const remain = (fdoc.data().remainingCredits || 0) + t.credits;
    await fref.update({ remainingCredits: remain, isActive: remain > 0, updatedAt: now });
  }
  await db.collection(COLLECTION).doc(t.id).update({ status, revertedAt: now, updatedAt: now });
};

// ── 取消（發起方本人／員工）→ 立即回沖 ─────────────────────────────
// byMemberId 有值＝會員自行取消，需為贈送者本人（fromMemberId）；員工則不帶此值。
const cancelTransfer = async (transferId, { byMemberId } = {}) => {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(transferId).get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此移轉' };
  const t = doc.data();
  if (t.status !== 'pending') throw { code: 'ALREADY_RESOLVED', message: '此移轉已處理' };
  if (byMemberId && t.fromMemberId !== byMemberId) throw { code: 'FORBIDDEN', message: '只能取消自己送出的移轉' };
  await revertOne(t, 'cancelled');
  return { reverted: true };
};

// ── 逾期回沖掃描（排程用）+ 惰性回沖 ────────────────────────────────
const revertExpired = async () => {
  const db = getDb();
  const snap = await db.collection(COLLECTION).where('status', '==', 'pending').get();
  const nowMs = Date.now();
  let n = 0;
  for (const d of snap.docs) {
    const t = d.data();
    if (toDate(t.expiresAt) && toDate(t.expiresAt).getTime() < nowMs) { await revertOne(t, 'expired'); n++; }
  }
  return n;
};

// ── 受贈者待接收清單（先惰性回沖逾期）─────────────────────────────────
const getIncoming = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTION).where('toMemberId', '==', memberId).where('status', '==', 'pending').get();
  const now = Date.now();
  const out = [];
  for (const d of snap.docs) {
    const t = { id: d.id, ...d.data() };
    if (toDate(t.expiresAt) && toDate(t.expiresAt).getTime() < now) { await revertOne(t, 'expired'); continue; }
    out.push({ ...t, expiresAtISO: toDate(t.expiresAt)?.toISOString() });
  }
  return out;
};

// ── 某來源卡/會員的「移轉中」清單（員工端顯示）─────────────────────────
const getPendingByFromMember = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTION).where('fromMemberId', '==', memberId).where('status', '==', 'pending').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data(), expiresAtISO: toDate(d.data().expiresAt)?.toISOString() }));
};

module.exports = { initiateTransfer, acceptTransfer, cancelTransfer, revertExpired, getIncoming, getPendingByFromMember };
