/**
 * 票券移轉路由
 * POST /ticket-transfers/request     申請移轉
 * POST /ticket-transfers/:id/accept  接受移轉
 * POST /ticket-transfers/:id/reject  拒絕移轉
 * GET  /ticket-transfers/pending     我的待處理移轉
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const { authenticateAny } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

// 移轉規則
const TRANSFER_RULES = {
  discount_card: (card) => ({
    expiresAt: card.expiresAt, // 繼承原到期日
  }),
  legacy_discount_card: (card) => ({
    expiresAt: card.isFirstTransfer
      ? dayjs(card.expiresAt).add(1, 'year').toDate()
      : card.expiresAt,
    isFirstTransfer: false,
  }),
  black_card: (card) => ({
    expiresAt: card.isFirstTransfer
      ? dayjs(card.expiresAt).add(1, 'year').toDate()
      : card.expiresAt,
    isFirstTransfer: false,
  }),
  bonus: (card) => ({ expiresAt: card.expiresAt }),
  single_entry: (card) => ({ expiresAt: card.expiresAt }),
};

// ── POST /ticket-transfers/request ──────────────────────────────
router.post('/request', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const { ticketType, ticketId, targetPhone } = req.body;
    const requesterId = req.member?.id || req.staff?.id;

    if (!ticketType || !ticketId || !targetPhone)
      return res.status(400).json({ error: 'MISSING_FIELDS', message: '請填寫票券類型、票券ID和對方手機' });

    // 查詢對方會員
    const targetSnap = await db.collection('members').where('phone', '==', targetPhone).limit(1).get();
    if (targetSnap.empty)
      return res.status(404).json({ error: 'MEMBER_NOT_FOUND', message: '找不到此手機號碼的會員' });
    const target = { id: targetSnap.docs[0].id, ...targetSnap.docs[0].data() };

    // 確認票券屬於申請人
    const collectionMap = {
      discount_card: 'discountCards',
      legacy_discount_card: 'legacyDiscountCards',
      black_card: 'legacyBlackCards',
      bonus: 'bonusCards',
      single_entry: 'singleEntryTickets',
    };
    const colName = collectionMap[ticketType];
    if (!colName) return res.status(400).json({ error: 'INVALID_TICKET_TYPE' });

    const ticketDoc = await db.collection(colName).doc(ticketId).get();
    if (!ticketDoc.exists) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
    const ticket = ticketDoc.data();
    if (ticket.memberId !== requesterId)
      return res.status(403).json({ error: 'NOT_OWNER', message: '此票券不屬於你' });

    // 建立移轉申請
    const transferId = uuidv4();
    const transfer = {
      id: transferId,
      ticketType,
      ticketId,
      fromMemberId: requesterId,
      toMemberId: target.id,
      toMemberName: target.name,
      toMemberPhone: targetPhone,
      status: 'pending',
      createdAt: new Date(),
      expiresAt: dayjs().add(24, 'hour').toDate(), // 24小時內需回應
    };
    await db.collection('ticketTransfers').doc(transferId).set(transfer);

    // 系統通知對方
    await db.collection('notifications').add({
      type: 'ticket_transfer_request',
      title: '票券移轉邀請',
      message: `${req.member?.name || req.staff?.name} 想將票券移轉給你`,
      targetMemberId: target.id,
      data: { transferId, ticketType },
      isRead: false,
      createdAt: new Date(),
    });

    res.status(201).json({ transfer, message: '移轉申請已送出，等待對方確認' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /ticket-transfers/:id/accept ────────────────────────────
router.post('/:id/accept', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const transfer = (await db.collection('ticketTransfers').doc(req.params.id).get()).data();
    if (!transfer) return res.status(404).json({ error: 'NOT_FOUND' });
    if (transfer.status !== 'pending') return res.status(400).json({ error: 'ALREADY_PROCESSED' });
    if (transfer.toMemberId !== (req.member?.id || req.staff?.id))
      return res.status(403).json({ error: 'NOT_TARGET' });

    const collectionMap = {
      discount_card: 'discountCards',
      legacy_discount_card: 'legacyDiscountCards',
      black_card: 'legacyBlackCards',
      bonus: 'bonusCards',
      single_entry: 'singleEntryTickets',
    };
    const colName = collectionMap[transfer.ticketType];
    const ticketRef = db.collection(colName).doc(transfer.ticketId);
    const ticket = (await ticketRef.get()).data();

    // 計算新到期日
    const rule = TRANSFER_RULES[transfer.ticketType];
    const newFields = rule ? rule(ticket) : {};

    // 更新票券持有人
    await ticketRef.update({
      memberId: transfer.toMemberId,
      ...newFields,
      updatedAt: new Date(),
    });

    // 更新移轉狀態
    await db.collection('ticketTransfers').doc(req.params.id).update({
      status: 'accepted',
      acceptedAt: new Date(),
    });

    // 通知原持有人
    await db.collection('notifications').add({
      type: 'ticket_transfer_accepted',
      title: '票券移轉成功',
      message: `${transfer.toMemberName} 已接受你的票券移轉`,
      targetMemberId: transfer.fromMemberId,
      isRead: false,
      createdAt: new Date(),
    });

    res.json({ message: '票券移轉成功' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /ticket-transfers/:id/reject ────────────────────────────
router.post('/:id/reject', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('ticketTransfers').doc(req.params.id).update({
      status: 'rejected',
      rejectedAt: new Date(),
    });

    const transfer = (await db.collection('ticketTransfers').doc(req.params.id).get()).data();
    await db.collection('notifications').add({
      type: 'ticket_transfer_rejected',
      title: '票券移轉被拒絕',
      message: `${transfer.toMemberName} 拒絕了你的票券移轉`,
      targetMemberId: transfer.fromMemberId,
      isRead: false,
      createdAt: new Date(),
    });

    res.json({ message: '已拒絕移轉' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /ticket-transfers/pending ─────────────────────────────────
router.get('/pending', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id || req.staff?.id;
    const snap = await db.collection('ticketTransfers')
      .where('toMemberId', '==', memberId)
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .get();
    res.json({ transfers: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
