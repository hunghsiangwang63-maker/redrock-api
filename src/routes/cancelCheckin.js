/**
 * 取消入場路由
 * POST /cancel-checkins/direct        30分鐘內直接取消
 * POST /cancel-checkins/request       超過30分鐘申請取消
 * GET  /cancel-checkins/pending       待審核取消申請
 * POST /cancel-checkins/:id/approve   管理員核准
 * POST /cancel-checkins/:id/reject    管理員拒絕
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const { authenticate, authenticateAny } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const CANCEL_WINDOW_MINUTES = 30;

// 取消入場時還原票券/卡（黑卡/單次券/折扣卡/紅利）— /direct 與 /approve 共用，
// 與 checkinService.cancelCheckIn 的還原集合一致（黑卡走 legacyBlackCards）。
const restoreEntryCredits = async (db, checkIn) => {
  if (!checkIn) return;
  const now = new Date();
  if (checkIn.entryType === 'black_card' && checkIn.blackCardId) {
    const { refundBlackCard } = require('../services/legacyCardService');
    await refundBlackCard(checkIn.blackCardId);
  } else if (checkIn.entryType === 'single_entry_ticket' && checkIn.singleEntryTicketId) {
    await db.collection('singleEntryTickets').doc(checkIn.singleEntryTicketId).update({
      status: 'active', usedAt: null, usedCheckInId: null, updatedAt: now,
    });
  } else if (checkIn.entryType === 'discount_card' && checkIn.discountCardId) {
    const cardDoc = await db.collection('discountCards').doc(checkIn.discountCardId).get();
    if (cardDoc.exists) {
      await cardDoc.ref.update({ remainingCredits: cardDoc.data().remainingCredits + 1, updatedAt: now });
    }
  } else if (checkIn.entryType === 'bonus' && checkIn.bonusId) {
    const bonusDoc = await db.collection('discountBonuses').doc(checkIn.bonusId).get();
    if (bonusDoc.exists) {
      await bonusDoc.ref.update({ isUsed: false, isActive: true, usedAt: null, usedAtGymId: null, updatedAt: now });
    }
  } else if (checkIn.entryType === 'buy_pass') {
    // 購買新定期票入場取消：作廢對應定期票（與 checkinService.cancelCheckIn 一致）
    const passSnap = await db.collection('memberPasses').where('paymentId', '==', checkIn.id).limit(1).get();
    if (!passSnap.empty) {
      await passSnap.docs[0].ref.update({ status: 'cancelled', cancelledAt: now, cancelReason: '入場取消', updatedAt: now });
    }
  }
  // 續約附加還原（獨立於 entryType，任何入場只要帶 renewMeta 都要復原票期/分期/營收）
  await require('../services/checkinService').revertRenewal(db, checkIn, now);
};

// ── POST /cancel-checkins/direct ─────────────────────────────────
router.post('/direct', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const { checkInId } = req.body;
    if (!checkInId) return res.status(400).json({ error: 'MISSING_CHECKIN_ID' });

    const ref = db.collection('checkIns').doc(checkInId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });

    const checkIn = doc.data();

    // 擁有權檢查：會員只能取消自己的入場（員工/站台不限）
    if (req.member && checkIn.memberId !== req.member.id)
      return res.status(403).json({ error: 'FORBIDDEN', message: '無權取消此入場紀錄' });
    // 防重複取消（避免重複退款）
    if (checkIn.isCancelled || checkIn.status === 'cancelled')
      return res.status(400).json({ error: 'ALREADY_CANCELLED', message: '此入場紀錄已取消' });

    const checkedInAt = dayjs(checkIn.checkedInAt?.seconds ? checkIn.checkedInAt.seconds * 1000 : checkIn.checkedInAt);
    const minutesSince = dayjs().diff(checkedInAt, 'minute');

    if (minutesSince > CANCEL_WINDOW_MINUTES)
      return res.status(400).json({
        error: 'CANCEL_WINDOW_EXPIRED',
        message: `入場超過 ${CANCEL_WINDOW_MINUTES} 分鐘，請工作人員申請取消`,
        minutesSince,
      });

    // 直接取消
    await ref.update({ status: 'cancelled', cancelledAt: new Date(), isCancelled: true });

    // 退回票券/卡（黑卡/單次券/折扣卡/紅利）
    await restoreEntryCredits(db, checkIn);

    // 退回交易紀錄
    if (checkIn.amountPaid > 0) {
      const { recordTransaction } = require('../utils/revenueLedger');
      await recordTransaction(db, {
        gymId: checkIn.gymId,
        type: 'refund',
        totalAmount: -checkIn.amountPaid,
        paymentMethod: checkIn.paymentMethod || 'cash',
        memberId: checkIn.memberId,
        memberName: checkIn.memberName,
        relatedId: checkInId,
        notes: '入場取消退款（30分鐘內自助取消）',
        staffId: req.staff?.id || null,
        staffName: req.staff?.name || (req.member ? `${req.member.name}（會員自助）` : ''),
      });
    }

    res.json({ success: true, message: '入場已取消，票券已退回' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /cancel-checkins/request ────────────────────────────────
router.post('/request', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { checkInId, reason } = req.body;
    if (!checkInId || !reason) return res.status(400).json({ error: 'MISSING_FIELDS' });

    const checkIn = (await db.collection('checkIns').doc(checkInId).get()).data();
    if (!checkIn) return res.status(404).json({ error: 'NOT_FOUND' });
    if (checkIn.status === 'cancelled') return res.status(400).json({ error: 'ALREADY_CANCELLED' });

    const reqId = uuidv4();
    await db.collection('cancelCheckinRequests').doc(reqId).set({
      id: reqId,
      checkInId,
      memberId: checkIn.memberId,
      gymId: checkIn.gymId,
      requestedBy: req.staff.id,
      requestedByName: req.staff.name,
      reason,
      status: 'pending',
      createdAt: new Date(),
    });

    // 通知管理員
    const managersSnap = await db.collection('staff')
      .where('role', 'in', ['super_admin', 'gym_manager']).get();
    const batch = db.batch();
    managersSnap.docs.forEach(m => {
      const ref = db.collection('notifications').doc();
      batch.set(ref, {
        type: 'cancel_checkin_request',
        title: '入場取消申請',
        message: `${req.staff.name} 申請取消會員入場，原因：${reason}`,
        targetStaffId: m.id,
        data: { requestId: reqId },
        isRead: false,
        createdAt: new Date(),
      });
    });
    await batch.commit();

    res.status(201).json({ requestId: reqId, message: '取消申請已送出，等待管理員審核' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /cancel-checkins/pending ──────────────────────────────────
router.get('/pending', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role !== 'super_admin' ? req.staff?.gymId : req.query.gymId;
    let ref = db.collection('cancelCheckinRequests').where('status', '==', 'pending');
    if (gymId) ref = ref.where('gymId', '==', gymId);
    const snap = await ref.orderBy('createdAt', 'desc').get();
    res.json({ requests: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /cancel-checkins/:id/approve ────────────────────────────
router.post('/:id/approve', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const reqDoc = await db.collection('cancelCheckinRequests').doc(req.params.id).get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const cancelReq = reqDoc.data();
    if (cancelReq.status !== 'pending')
      return res.status(400).json({ error: 'ALREADY_PROCESSED', message: '此申請已處理' });

    const checkInRef = db.collection('checkIns').doc(cancelReq.checkInId);
    const checkInDoc = await checkInRef.get();
    const checkIn = checkInDoc.exists ? checkInDoc.data() : null;

    await checkInRef.update({
      status: 'cancelled', cancelledAt: new Date(), isCancelled: true,
      cancelledBy: req.staff.id,
    });
    await reqDoc.ref.update({ status: 'approved', approvedBy: req.staff.id, approvedAt: new Date() });

    // 退回票券/卡（黑卡/單次券/折扣卡/紅利）
    await restoreEntryCredits(db, checkIn);

    // 退回交易紀錄
    if (checkIn?.amountPaid > 0) {
      const { recordTransaction } = require('../utils/revenueLedger');
      await recordTransaction(db, {
        gymId: checkIn.gymId,
        type: 'refund',
        totalAmount: -checkIn.amountPaid,
        paymentMethod: checkIn.paymentMethod || 'cash',
        memberId: checkIn.memberId,
        memberName: checkIn.memberName,
        relatedId: cancelReq.checkInId,
        notes: '入場取消退款（管理員核准）',
        staffId: req.staff.id,
        staffName: req.staff.name,
      });
    }

    // 通知申請的工作人員
    await db.collection('notifications').add({
      type: 'cancel_checkin_approved',
      title: '入場取消申請已核准',
      message: '你的入場取消申請已獲管理員核准',
      targetStaffId: cancelReq.requestedBy,
      isRead: false,
      createdAt: new Date(),
    });

    res.json({ success: true, message: '入場取消已核准' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /cancel-checkins/:id/reject ─────────────────────────────
router.post('/:id/reject', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const reqDoc = await db.collection('cancelCheckinRequests').doc(req.params.id).get();
    if (!reqDoc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const cancelReq = reqDoc.data();

    await reqDoc.ref.update({
      status: 'rejected',
      rejectedBy: req.staff.id,
      rejectedReason: req.body.reason || '',
      rejectedAt: new Date(),
    });

    await db.collection('notifications').add({
      type: 'cancel_checkin_rejected',
      title: '入場取消申請被拒絕',
      message: `你的入場取消申請被拒絕${req.body.reason ? `，原因：${req.body.reason}` : ''}`,
      targetStaffId: cancelReq.requestedBy,
      isRead: false,
      createdAt: new Date(),
    });

    res.json({ success: true, message: '入場取消申請已拒絕' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
module.exports.restoreEntryCredits = restoreEntryCredits; // 供測試
