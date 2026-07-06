const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { authenticate, authenticateAny, authenticateMember, checkPermission, requireManagerOrStation, requireManager, auditLog } = require('../middleware/auth');
const notificationService = require('../services/notificationService');
const discountCardService = require('../services/discountCardService');
const legacyDiscountCardService = require('../services/legacyDiscountCardService');
const legacyCardService = require('../services/legacyCardService');
const bonusService = require('../services/bonusService');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// ══════════════════════════════════════════════════════
// 新優惠卡
// ══════════════════════════════════════════════════════
router.get('/discount/member/:memberId', authenticateAny, async (req, res) => {
  try { res.json({ cards: await discountCardService.getMemberDiscountCards(req.params.memberId) }); }
  catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// 新增優惠卡給會員 = Group B：僅管理員（gym_manager / super_admin）
router.post('/discount/purchase',
  authenticate, requireManager, auditLog('discount_card.purchase'),
  [body('price').isNumeric()], validate,
  async (req, res) => {
    try {
      const card = await discountCardService.purchaseDiscountCard({
        memberId: req.body.memberId || null, gymId: req.staff.gymId,
        staffId: req.staff.id, price: parseInt(req.body.price), paymentId: req.body.paymentId,
      });
      res.status(201).json({ card, message: '優惠卡購買成功' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// 轉入優惠卡 = Group A：館別電腦(值班)或管理員；立即生效 + 揭露通知管理員
router.post('/discount/bind',
  authenticate, requireManagerOrStation, auditLog('discount_card.bind'),
  [body('memberId').notEmpty(), body('remainingCredits').isInt({ min: 1, max: 10 })], validate,
  async (req, res) => {
    try {
      const card = await discountCardService.bindDiscountCard({
        memberId: req.body.memberId,
        remainingCredits: parseInt(req.body.remainingCredits),
        gymId: req.staff.gymId, staffId: req.staff.id,
        barcode: req.body.barcode || null,
      });
      // 揭露到管理員通知頁（非審核，立即生效）
      const dm = await require('../services/memberService').getMember(req.body.memberId).catch(() => null);
      notificationService.notifyCardBindDisclosure({
        kind: 'discount_bind', memberName: dm?.name || req.body.memberId,
        gymId: req.staff.gymId, staffName: req.staff.name,
        detail: `${parseInt(req.body.remainingCredits)} 次`, referenceId: card.id,
      }).catch(e => console.error('notifyCardBindDisclosure(discount) 失敗', e.message));
      res.status(201).json({ card, message: '優惠卡轉入成功' });
    } catch (err) {
      if (err.code === 'MEMBER_NOT_FOUND') return res.status(404).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

router.post('/discount/:id/transfer-preview',
  authenticate, checkPermission('products.sell'),
  [body('toMemberId').notEmpty(), body('credits').isInt({ min: 1 })], validate,
  async (req, res) => {
    try { res.json(await discountCardService.getTransferPreview(req.params.id, req.body.toMemberId, parseInt(req.body.credits))); }
    catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
  }
);

// 移轉改兩段式：發起→暫扣＋建 pending（受贈者於會員 App 接收；24h 未接收自動回沖）
router.post('/discount/:id/transfer',
  authenticate, checkPermission('products.sell'), auditLog('discount_card.transfer'),
  [body('toMemberId').notEmpty(), body('credits').isInt({ min: 1 })],
  validate,
  async (req, res) => {
    try {
      const cardTransferService = require('../services/cardTransferService');
      const t = await cardTransferService.initiateTransfer({
        cardType: 'discount', fromCardId: req.params.id, toMemberId: req.body.toMemberId,
        credits: parseInt(req.body.credits), initiatedBy: req.staff.id, initiatedByType: 'staff',
      });
      res.json({ transfer: t, message: `已送出移轉 ${t.credits} 次給 ${t.toMemberName}，待對方於會員 App 接收（24 小時內未接收將自動回沖）` });
    } catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// 舊優惠卡（拍照歸檔）
// ══════════════════════════════════════════════════════
router.get('/legacy-discount/member/:memberId', authenticateAny, async (req, res) => {
  try { res.json({ cards: await legacyDiscountCardService.getMemberLegacyDiscountCards(req.params.memberId) }); }
  catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

router.post('/legacy-discount/bind',
  authenticate, checkPermission('products.sell'), auditLog('legacy_discount_card.bind'),
  [body('memberId').notEmpty(), body('remainingCredits').isInt({ min: 1 })], validate,
  async (req, res) => {
    try {
      const card = await legacyDiscountCardService.bindLegacyDiscountCard({
        memberId: req.body.memberId,
        remainingCredits: parseInt(req.body.remainingCredits),
        gymId: req.staff.gymId, staffId: req.staff.id,
        photoUrl: req.body.photoUrl || null,
        barcode: req.body.barcode || null,
      });
      res.status(201).json({ card, message: '舊優惠卡綁定成功' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

router.post('/legacy-discount/:id/transfer-preview',
  authenticate, checkPermission('products.sell'),
  [body('toMemberId').notEmpty(), body('credits').isInt({ min: 1 })], validate,
  async (req, res) => {
    try { res.json(await legacyDiscountCardService.getTransferPreview(req.params.id, req.body.toMemberId, parseInt(req.body.credits))); }
    catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
  }
);

router.post('/legacy-discount/:id/transfer',
  authenticate, checkPermission('products.sell'), auditLog('legacy_discount_card.transfer'),
  [body('toMemberId').notEmpty(), body('credits').isInt({ min: 1 }), body('confirmedExpiry').equals('true').withMessage('請確認到期日')],
  validate,
  async (req, res) => {
    try {
      const result = await legacyDiscountCardService.transferLegacyDiscountCard({
        fromCardId: req.params.id, toMemberId: req.body.toMemberId,
        credits: parseInt(req.body.credits), staffId: req.staff.id,
      });
      const msg = result.isFirstTransfer
        ? `成功移轉 ${req.body.credits} 次（首次移轉，到期日設為 ${result.expiresAt}）`
        : `成功移轉 ${req.body.credits} 次（到期日 ${result.expiresAt} 不延長）`;
      res.json({ ...result, message: msg });
    } catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// 黑卡
// ══════════════════════════════════════════════════════
router.get('/black/member/:memberId', authenticateAny, async (req, res) => {
  try { res.json({ cards: await legacyCardService.getMemberBlackCards(req.params.memberId) }); }
  catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// 黑卡綁定 = Group A：館別電腦(值班)或管理員；立即生效 + 揭露通知管理員
router.post('/black/bind',
  authenticate, requireManagerOrStation, auditLog('black_card.bind'),
  [body('memberId').notEmpty(), body('remainingCredits').isInt({ min: 1, max: 12 })], validate,
  async (req, res) => {
    try {
      const card = await legacyCardService.bindBlackCard({
        barcode: req.body.barcode || null, memberId: req.body.memberId,
        remainingCredits: parseInt(req.body.remainingCredits),
        gymId: req.staff.gymId, staffId: req.staff.id,
      });
      // 揭露到管理員通知頁（非審核，立即生效）
      const bm = await require('../services/memberService').getMember(req.body.memberId).catch(() => null);
      notificationService.notifyCardBindDisclosure({
        kind: 'black_bind', memberName: bm?.name || req.body.memberId,
        gymId: req.staff.gymId, staffName: req.staff.name,
        detail: `${parseInt(req.body.remainingCredits)} 次`, referenceId: card.id,
      }).catch(e => console.error('notifyCardBindDisclosure(black) 失敗', e.message));
      res.status(201).json({ card, message: '黑卡綁定成功' });
    } catch (err) {
      if (err.code === 'CARD_ALREADY_BOUND') return res.status(409).json(err);
      if (err.code === 'MEMBER_NOT_FOUND') return res.status(404).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

router.post('/black/:id/transfer-preview',
  authenticate, checkPermission('products.sell'),
  [body('toMemberId').notEmpty(), body('credits').isInt({ min: 1 })], validate,
  async (req, res) => {
    try { res.json(await legacyCardService.getTransferPreview(req.params.id, req.body.toMemberId, parseInt(req.body.credits))); }
    catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
  }
);

// 移轉改兩段式：發起→暫扣＋建 pending（受贈者於會員 App 接收；24h 未接收自動回沖）
router.post('/black/:id/transfer',
  authenticate, checkPermission('products.sell'), auditLog('black_card.transfer'),
  [body('toMemberId').notEmpty(), body('credits').isInt({ min: 1 })],
  validate,
  async (req, res) => {
    try {
      const cardTransferService = require('../services/cardTransferService');
      const t = await cardTransferService.initiateTransfer({
        cardType: 'black', fromCardId: req.params.id, toMemberId: req.body.toMemberId,
        credits: parseInt(req.body.credits), initiatedBy: req.staff.id, initiatedByType: 'staff',
      });
      res.json({ transfer: t, message: `已送出移轉 ${t.credits} 次給 ${t.toMemberName}，待對方於會員 App 接收（24 小時內未接收將自動回沖）` });
    } catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ══════════════════════════════════════════════════════
// 卡片移轉（兩段式）：接收（會員）/ 取消（員工）/ 清單
// ══════════════════════════════════════════════════════
// 會員自助移轉：依電話即時帶出受贈者姓名（確認用，避免轉錯人）。僅回姓名，優先家長帳號。
router.get('/transfers/lookup', authenticateMember, async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (!phone || phone.length < 10) return res.json({ found: false });
    let m;
    try { m = await require('../services/memberService').getMemberByPhone(phone); }
    catch { return res.json({ found: false }); }
    if (m.id === req.member.id) return res.json({ found: true, self: true, name: m.name });
    res.json({ found: true, name: m.name });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
// 會員自助發起移轉（會員 App）：優惠卡/黑卡，可設定次數，走兩段式（暫扣→對方接收）
router.post('/transfers/initiate', authenticateMember, auditLog('card_transfer.initiate'), async (req, res) => {
  try {
    const { cardType, fromCardId, toPhone, credits } = req.body;
    if (!['discount', 'black'].includes(cardType)) return res.status(400).json({ error: 'BAD_TYPE', message: '卡別錯誤' });
    if (!fromCardId || !toPhone) return res.status(400).json({ error: 'MISSING_FIELDS', message: '請填寫卡片與對方手機' });
    // 解析受贈者（優先家長帳號，避開共用電話子帳號誤解析）
    let toMember;
    try { toMember = await require('../services/memberService').getMemberByPhone(String(toPhone).trim()); }
    catch { return res.status(404).json({ error: 'MEMBER_NOT_FOUND', message: '找不到此手機號碼的會員' }); }
    const t = await require('../services/cardTransferService').initiateTransfer({
      cardType, fromCardId, toMemberId: toMember.id, credits,
      initiatedBy: req.member.id, initiatedByType: 'member', expectedOwnerId: req.member.id,
    });
    res.json({ transfer: t, message: `已送出移轉 ${t.credits} 次給 ${t.toMemberName}，待對方於會員 App 接收（24 小時內未接收將自動回沖）` });
  } catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
});
// 受贈者待接收清單（會員 App）
router.get('/transfers/incoming', authenticateMember, async (req, res) => {
  try { res.json({ transfers: await require('../services/cardTransferService').getIncoming(req.member.id) }); }
  catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
// 受贈者接收（會員 App）
router.post('/transfers/:id/accept', authenticateMember, async (req, res) => {
  try {
    const r = await require('../services/cardTransferService').acceptTransfer(req.params.id, req.member.id);
    res.json({ ...r, message: '已接收，次數已入卡' });
  } catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
});
// 取消移轉中（贈送者本人於會員 App，或員工代為）→ 立即回沖
router.post('/transfers/:id/cancel', authenticateAny, auditLog('card_transfer.cancel'), async (req, res) => {
  try {
    const opts = req.member ? { byMemberId: req.member.id } : {}; // 會員需為贈送者本人；員工不限
    await require('../services/cardTransferService').cancelTransfer(req.params.id, opts);
    res.json({ message: '已取消移轉，次數已回沖' });
  } catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
});
// 贈送者本人的「移轉中」清單（會員 App）
router.get('/transfers/outgoing', authenticateMember, async (req, res) => {
  try { res.json({ transfers: await require('../services/cardTransferService').getPendingByFromMember(req.member.id) }); }
  catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
// 某會員發出中的移轉（員工端顯示「移轉中」）
router.get('/transfers/outgoing/:memberId', authenticateAny, async (req, res) => {
  try { res.json({ transfers: await require('../services/cardTransferService').getPendingByFromMember(req.params.memberId) }); }
  catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ══════════════════════════════════════════════════════
// 紅利
// ══════════════════════════════════════════════════════
router.get('/bonus/member/:memberId', authenticateAny, async (req, res) => {
  try { res.json({ bonuses: await bonusService.getMemberBonuses(req.params.memberId) }); }
  catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

router.post('/bonus/:id/transfer-preview', authenticate,
  [body('toMemberId').notEmpty()], validate,
  async (req, res) => {
    try { res.json(await bonusService.getBonusTransferPreview(req.params.id)); }
    catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
  }
);

router.post('/bonus/:id/transfer',
  authenticate, auditLog('bonus.transfer'),
  [body('toMemberId').notEmpty(), body('confirmedExpiry').equals('true').withMessage('請確認到期日')], validate,
  async (req, res) => {
    try {
      const result = await bonusService.transferBonus({
        bonusId: req.params.id, toMemberId: req.body.toMemberId,
        staffId: req.staff?.id || req.member?.id,
      });
      res.json({ ...result, message: `紅利已移轉（到期日 ${result.expiresAt} 不延長）` });
    } catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
  }
);

module.exports = router;
