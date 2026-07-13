/**
 * checkin/cancel.js — 入場取消：cancelCheckIn（退票券/沖銷退款）＋ revertRenewal（續約還原）
 * 由 checkinService.js 拆分（2026-07-13 refactor）；函式本體逐字搬移、行為不變。
 */
const { getDb, COLLECTIONS } = require('../../config/firebase');
const { refundBlackCard } = require('../legacyCardService');
const dayjs = require('dayjs');

const revertRenewal = async (db, checkIn, now) => {
  const meta = checkIn.renewMeta;
  if (!meta || !meta.passId || !meta.before) return;
  const passRef = db.collection(COLLECTIONS.MEMBER_PASSES).doc(meta.passId);
  const passDoc = await passRef.get();
  if (passDoc.exists) {
    await passRef.update({
      endDate: meta.before.endDate,
      status: meta.before.status,
      credits: meta.before.credits ?? null,
      originalCredits: meta.before.originalCredits ?? null,
      installmentPlanId: meta.before.installmentPlanId || null,
      updatedAt: now,
    });
  }
  if (meta.planId) {
    // 續約分期：作廢計畫 + 沖銷已繳期營收（首期由 createInstallmentPlan 認列，取消須沖）
    await require('../installmentService').cancelInstallmentPlan(db, meta.planId, { reason: '續約取消' }).catch(() => {});
  }
  if (meta.plan === 'full' && meta.renewalPrice > 0) {
    const { recordTransaction } = require('../../utils/revenueLedger');
    await recordTransaction(db, {
      gymId: checkIn.gymId, type: 'refund', totalAmount: -Math.abs(meta.renewalPrice),
      paymentMethod: checkIn.paymentMethod || 'cash',
      memberId: checkIn.memberId, memberName: checkIn.memberName || '',
      relatedId: meta.passId, notes: '定期票續約取消沖銷',
    }).catch(() => {});
  }
};

// ── 取消入場（10分鐘內）────────────────────────────────────────
const cancelCheckIn = async (checkInId, staffId, force = false) => {
  const db = getDb();

  // 防護：Firestore 文件 id 限制（保留字 __x__、空值、含 "/"、"."、".." 會丟底層錯誤）
  // 提早回乾淨的 NOT_FOUND，避免把 Firestore 內部錯誤往外拋
  if (typeof checkInId !== 'string' || !checkInId.trim()
      || checkInId.includes('/') || checkInId === '.' || checkInId === '..'
      || /^__.*__$/.test(checkInId)) {
    throw { code: 'CHECKIN_NOT_FOUND', message: '入場紀錄不存在' };
  }

  const checkInRef = db.collection(COLLECTIONS.CHECK_INS).doc(checkInId);
  const checkInDoc = await checkInRef.get();

  if (!checkInDoc.exists) throw { code: 'CHECKIN_NOT_FOUND', message: '入場紀錄不存在' };

  const checkIn = checkInDoc.data();
  if (checkIn.isCancelled) throw { code: 'ALREADY_CANCELLED', message: '此入場紀錄已取消' };

  const minutesSince = dayjs().diff(dayjs(checkIn.checkedInAt.toDate()), 'minute');
  if (minutesSince > 10 && !force) throw { code: 'CANCEL_WINDOW_EXPIRED', message: '已超過10分鐘取消時限' };

  const now = new Date();

  // 退回票券（黑卡/單次券/折扣卡/購卡入場/紅利）— 須與 cancelCheckin.js 的 restoreEntryCredits 一致
  if (checkIn.entryType === 'black_card' && checkIn.blackCardId) {
    await refundBlackCard(checkIn.blackCardId); // legacyBlackCards：與扣點同源
  } else if (checkIn.entryType === 'bonus' && checkIn.bonusId) {
    // 紅利入場取消 → 還原紅利（否則會員的免費入場永久消失）
    const bonusDoc = await db.collection('discountBonuses').doc(checkIn.bonusId).get();
    if (bonusDoc.exists) {
      await bonusDoc.ref.update({ isUsed: false, isActive: true, usedAt: null, usedAtGymId: null, updatedAt: now });
    }
  } else if (checkIn.entryType === 'single_entry_ticket' && checkIn.singleEntryTicketId) {
    await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(checkIn.singleEntryTicketId).update({
      status: 'active',
      usedAt: null,
      usedCheckInId: null,
      updatedAt: now,
    });
  } else if (checkIn.entryType === 'discount_card' && checkIn.discountCardId) {
    // 退回優惠卡次數
    const cardDoc = await db.collection(COLLECTIONS.DISCOUNT_CARDS).doc(checkIn.discountCardId).get();
    if (cardDoc.exists) {
      await db.collection(COLLECTIONS.DISCOUNT_CARDS).doc(checkIn.discountCardId).update({
        remainingCredits: cardDoc.data().remainingCredits + 1,
        updatedAt: now,
      });
    }
  } else if (checkIn.entryType === 'buy_discount_card') {
    // 購買折扣優惠卡入場取消：找到對應優惠卡並刪除（若尚未轉讓）
    const cardSnap = await db.collection(COLLECTIONS.DISCOUNT_CARDS)
      .where('paymentId', '==', checkInId)
      .limit(1).get();
    if (!cardSnap.empty) {
      const card = cardSnap.docs[0].data();
      // 若已轉讓，不可取消
      if (card.transferHistory && card.transferHistory.length > 0) {
        throw { code: 'CARD_TRANSFERRED', message: '折扣優惠卡已轉讓，無法取消入場' };
      }
      if (card.ownerMemberId !== card.originalOwnerMemberId) {
        throw { code: 'CARD_TRANSFERRED', message: '折扣優惠卡已轉讓，無法取消入場' };
      }
      // 若已使用部分次數，不可取消
      if (card.totalUsedCredits > 0) {
        throw { code: 'CARD_USED', message: '折扣優惠卡已使用，無法取消入場' };
      }
      // 作廢優惠卡
      await db.collection(COLLECTIONS.DISCOUNT_CARDS).doc(cardSnap.docs[0].id).update({
        isActive: false,
        cancelledAt: now,
        cancelReason: '入場取消',
        updatedAt: now,
      });
    }
  } else if (checkIn.entryType === 'buy_pass') {
    // 購買新定期票入場取消：作廢對應定期票（此入場即該票的購買點，10 分鐘內取消）
    const passSnap = await db.collection(COLLECTIONS.MEMBER_PASSES)
      .where('paymentId', '==', checkInId)
      .limit(1).get();
    if (!passSnap.empty) {
      const passDoc = passSnap.docs[0];
      await passDoc.ref.update({
        status: 'cancelled', cancelledAt: now, cancelReason: '入場取消', updatedAt: now,
      });
      // 分期購票：作廢分期計畫 + 沖銷已繳期營收（否則留孤兒計畫、且首期票價營收未沖 → 報表多算）
      const planId = passDoc.data().installmentPlanId;
      if (planId) {
        await require('../installmentService').cancelInstallmentPlan(db, planId, { reason: '入場取消' }).catch(() => {});
      }
    }
  }

  // 續約附加還原（獨立於 entryType）
  await revertRenewal(db, checkIn, now);

  // 標記取消
  await checkInRef.update({
    isCancelled: true,
    cancelledAt: now,
    cancelledBy: staffId,
  });

  // 入場費沖銷：原本 confirmCheckIn 對 amountPaid>0 記了一筆 checkin 交易，
  // 取消時須記負向 refund 沖銷（對齊 cancelCheckin.js），否則營收報表（認列制）會多算已取消入場。
  // （續約款已由 revertRenewal 沖銷；票券/卡退回不涉及金流交易，故只沖 amountPaid。）
  if (checkIn.amountPaid > 0) {
    const { recordTransaction } = require('../../utils/revenueLedger');
    // 沖銷明細（負值）：入場費/岩鞋粉袋分開沖，讓營收日報表 entry/rental 欄對稱拆分
    const _shoes = checkIn.shoesPrice || 0, _chalk = checkIn.chalkPrice || 0;
    const _entryPortion = (checkIn.entryFee != null) ? checkIn.entryFee : Math.max(0, checkIn.amountPaid - _shoes - _chalk);
    await recordTransaction(db, {
      gymId: checkIn.gymId,
      type: 'refund',
      entryType: checkIn.entryType || null,
      totalAmount: -checkIn.amountPaid,
      entryFee: -_entryPortion,        // 反向沖入場費
      shoesPrice: -(_shoes + _chalk),  // 反向沖岩鞋+粉袋
      paymentMethod: checkIn.paymentMethod || 'cash',
      memberId: checkIn.memberId,
      memberName: checkIn.memberName,
      relatedId: checkInId,
      notes: '入場取消退款',
      staffId: staffId || null,
      staffName: null,
    });
  }

  // 更新對應 pendingCheckIn
  if (checkIn.qrToken) {
    await db.collection(COLLECTIONS.PENDING_CHECK_INS).doc(checkIn.qrToken).update({
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: staffId,
    });
  }

  return { message: '入場已取消，票券已退回', checkInId };
};

// ── 今日統計 ────────────────────────────────────────────────────
module.exports = { revertRenewal, cancelCheckIn };
