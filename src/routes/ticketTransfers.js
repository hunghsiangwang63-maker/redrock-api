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
const memberService = require('../services/memberService');

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

// 收件授權：本人，或「家長代其子女」處理（子帳號無法自行登入，須由家長 accept/reject）
async function actorCanActFor(db, req, toMemberId) {
  const actorId = req.member?.id || req.staff?.id;
  if (toMemberId === actorId) return true;
  if (!req.member?.id) return false;
  const doc = await db.collection('members').doc(toMemberId).get();
  return doc.exists && doc.data().parentMemberId === req.member.id;
}

// ── POST /ticket-transfers/request ──────────────────────────────
// 單張：帶 ticketId（原行為不變）。批次（僅 single_entry）：帶 ticketIds 陣列，一次最多
// systemSettings/cardTransferLimit.maxCredits 張（與黑卡/優惠卡點數移轉共用同一上限設定），
// 一次申請、一次接收/拒絕（整批視為同一單移轉，不接受部分接受）。
router.post('/request', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const { ticketType, ticketId, ticketIds, targetPhone } = req.body;
    const requesterId = req.member?.id || req.staff?.id;
    const isBatch = Array.isArray(ticketIds) && ticketIds.length > 0;

    if (!ticketType || (!ticketId && !isBatch) || !targetPhone)
      return res.status(400).json({ error: 'MISSING_FIELDS', message: '請填寫票券類型、票券ID和對方手機' });
    if (isBatch && ticketType !== 'single_entry')
      return res.status(400).json({ error: 'BATCH_NOT_SUPPORTED', message: '批次移轉僅支援單次入場券' });

    // 決定收件人：
    //  - 有帶 toMemberId（前端從家庭成員清單挑選，可指定子女）→ 驗證該會員電話 == targetPhone（同一家共用電話）
    //  - 未帶 → 沿用家長優先（getMemberByPhone），避開共用電話子帳號誤解析
    // 這讓「體驗券轉給指定子帳號上課使用」成立，同時擁有權維持嚴格（券歸實際入場者）。
    let target;
    if (req.body.toMemberId) {
      const doc = await db.collection('members').doc(String(req.body.toMemberId)).get();
      if (!doc.exists) return res.status(404).json({ error: 'MEMBER_NOT_FOUND', message: '找不到指定的收件會員' });
      target = { id: doc.id, ...doc.data() };
      if (String(target.phone || '').trim() !== String(targetPhone).trim())
        return res.status(400).json({ error: 'PHONE_MISMATCH', message: '指定的收件會員與手機號碼不符' });
    } else {
      try { target = await memberService.getMemberByPhone(String(targetPhone).trim()); }
      catch { return res.status(404).json({ error: 'MEMBER_NOT_FOUND', message: '找不到此手機號碼的會員' }); }
    }
    if (target.id === requesterId)
      return res.status(400).json({ error: 'SELF_TRANSFER', message: '不能移轉給自己' });

    // 確認票券屬於申請人
    const collectionMap = {
      discount_card: 'discountCards',
      legacy_discount_card: 'legacyDiscountCards',
      black_card: 'legacyBlackCards',
      bonus: 'discountBonuses',
      single_entry: 'singleEntryTickets',
    };
    const colName = collectionMap[ticketType];
    if (!colName) return res.status(400).json({ error: 'INVALID_TICKET_TYPE' });

    // 紅利用 ownerMemberId，其餘票券用 memberId（bonus 存於 discountBonuses、欄位不同）
    const ownerField = ticketType === 'bonus' ? 'ownerMemberId' : 'memberId';

    let finalTicketIds;
    if (isBatch) {
      const maxCredits = await require('../services/cardTransferService').getCardTransferLimit();
      const uniqueIds = [...new Set(ticketIds.map(String))];
      if (uniqueIds.length < 1 || uniqueIds.length > maxCredits)
        return res.status(400).json({ error: 'TRANSFER_LIMIT_EXCEEDED', message: `一次最多移轉 ${maxCredits} 張` });
      const docs = await Promise.all(uniqueIds.map(id => db.collection(colName).doc(id).get()));
      for (let i = 0; i < docs.length; i++) {
        if (!docs[i].exists) return res.status(404).json({ error: 'TICKET_NOT_FOUND', message: `票券不存在（${uniqueIds[i]}）` });
        if (docs[i].data()[ownerField] !== requesterId) return res.status(403).json({ error: 'NOT_OWNER', message: '此票券不屬於你' });
      }
      finalTicketIds = uniqueIds;
    } else {
      const ticketDoc = await db.collection(colName).doc(ticketId).get();
      if (!ticketDoc.exists) return res.status(404).json({ error: 'TICKET_NOT_FOUND' });
      if (ticketDoc.data()[ownerField] !== requesterId)
        return res.status(403).json({ error: 'NOT_OWNER', message: '此票券不屬於你' });
      finalTicketIds = [ticketId];
    }

    // 建立移轉申請（單張沿用既有 ticketId 欄位相容顯示；批次額外存 ticketIds 陣列＋張數）
    const transferId = uuidv4();
    const transfer = {
      id: transferId,
      ticketType,
      ticketId: finalTicketIds[0],
      ...(isBatch ? { ticketIds: finalTicketIds, ticketCount: finalTicketIds.length } : {}),
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
      message: `${req.member?.name || req.staff?.name} 想將${isBatch ? ` ${finalTicketIds.length} 張` : ''}票券移轉給你`,
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
    if (!(await actorCanActFor(db, req, transfer.toMemberId)))
      return res.status(403).json({ error: 'NOT_TARGET' });

    const collectionMap = {
      discount_card: 'discountCards',
      legacy_discount_card: 'legacyDiscountCards',
      black_card: 'legacyBlackCards',
      bonus: 'discountBonuses',
      single_entry: 'singleEntryTickets',
    };
    const colName = collectionMap[transfer.ticketType];
    // 批次（ticketIds 陣列）→ 逐張套用同一條規則各自計算新到期日；單張沿用原行為
    const idsToMove = Array.isArray(transfer.ticketIds) && transfer.ticketIds.length ? transfer.ticketIds : [transfer.ticketId];
    const rule = TRANSFER_RULES[transfer.ticketType];
    const ownerField = transfer.ticketType === 'bonus' ? 'ownerMemberId' : 'memberId';
    for (const tid of idsToMove) {
      const ticketRef = db.collection(colName).doc(tid);
      const ticket = (await ticketRef.get()).data();
      const newFields = rule ? rule(ticket) : {};
      await ticketRef.update({
        [ownerField]: transfer.toMemberId,
        ...newFields,
        updatedAt: new Date(),
      });
    }

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
    const transfer = (await db.collection('ticketTransfers').doc(req.params.id).get()).data();
    if (!transfer) return res.status(404).json({ error: 'NOT_FOUND' });
    if (transfer.status !== 'pending') return res.status(400).json({ error: 'ALREADY_PROCESSED' });
    if (!(await actorCanActFor(db, req, transfer.toMemberId)))
      return res.status(403).json({ error: 'NOT_TARGET' });

    await db.collection('ticketTransfers').doc(req.params.id).update({
      status: 'rejected',
      rejectedAt: new Date(),
    });
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
    // 一併納入「本人子女」被指定的待接收轉移（子帳號無法自行登入，由家長處理）
    let ids = [memberId];
    if (req.member?.id) {
      const kids = await db.collection('members')
        .where('parentMemberId', '==', req.member.id).where('isChildAccount', '==', true).get();
      ids = ids.concat(kids.docs.map(d => d.id)).slice(0, 10); // Firestore 'in' 上限 10
    }
    const snap = await db.collection('ticketTransfers')
      .where('toMemberId', 'in', ids)
      .where('status', '==', 'pending')
      .get();
    let transfers = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    // 補送出方姓名（供收件端顯示「來自 XXX」）
    const fromIds = [...new Set(transfers.map(t => t.fromMemberId).filter(Boolean))];
    if (fromIds.length) {
      const fromDocs = await Promise.all(fromIds.map(id => db.collection('members').doc(id).get()));
      const nameMap = {};
      fromDocs.forEach(d => { if (d.exists) nameMap[d.id] = d.data().name; });
      transfers = transfers.map(t => ({ ...t, fromMemberName: nameMap[t.fromMemberId] || '會員' }));
    }
    res.json({ transfers });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /ticket-transfers/recipients?phone= ───────────────────────
// 回傳該手機下的所有會員（家長 + 共用電話的子女），供轉出方挑選實際收件人。
// 讓「體驗券轉給指定子女」成為可能（子帳號無獨立電話，只能由此清單選）。
router.get('/recipients', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const phone = String(req.query.phone || '').trim();
    // 支援國際格式（+開頭）；門檻設 7 避免誤觸「輸入4碼＝末四碼模糊比對」情境
    if (!phone || phone.length < 7) return res.json({ recipients: [] });
    const snap = await db.collection('members').where('phone', '==', phone).get();
    const requesterId = req.member?.id || req.staff?.id;
    const { isChild } = require('../utils/age');
    const recipients = snap.docs
      .map(d => ({ id: d.id, name: d.data().name, isChildAccount: !!d.data().isChildAccount, under13: isChild(d.data()) }))
      .filter(m => m.id !== requesterId)                       // 不列自己
      .sort((a, b) => (a.isChildAccount ? 1 : 0) - (b.isChildAccount ? 1 : 0)); // 家長排前
    res.json({ recipients });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
