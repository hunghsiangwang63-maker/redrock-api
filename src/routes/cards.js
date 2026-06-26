const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { authenticate, authenticateAny, checkPermission, auditLog } = require('../middleware/auth');
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

router.post('/discount/purchase',
  authenticate, checkPermission('products.sell'), auditLog('discount_card.purchase'),
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

router.post('/discount/:id/transfer-preview',
  authenticate, checkPermission('products.sell'),
  [body('toMemberId').notEmpty(), body('credits').isInt({ min: 1 })], validate,
  async (req, res) => {
    try { res.json(await discountCardService.getTransferPreview(req.params.id, req.body.toMemberId, parseInt(req.body.credits))); }
    catch (err) { res.status(err.code ? 400 : 500).json(err.code ? err : { error: 'SERVER_ERROR', message: err.message }); }
  }
);

router.post('/discount/:id/transfer',
  authenticate, checkPermission('products.sell'), auditLog('discount_card.transfer'),
  [body('toMemberId').notEmpty(), body('credits').isInt({ min: 1 }), body('confirmedExpiry').equals('true').withMessage('請確認到期日')],
  validate,
  async (req, res) => {
    try {
      const result = await discountCardService.transferDiscountCard({
        fromCardId: req.params.id, toMemberId: req.body.toMemberId,
        credits: parseInt(req.body.credits), staffId: req.staff.id,
      });
      res.json({ ...result, message: `成功移轉 ${req.body.credits} 次（到期日 ${result.expiresAt} 不變）` });
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

router.post('/black/bind',
  authenticate, checkPermission('products.sell'), auditLog('black_card.bind'),
  [body('memberId').notEmpty(), body('remainingCredits').isInt({ min: 1, max: 12 })], validate,
  async (req, res) => {
    try {
      const card = await legacyCardService.bindBlackCard({
        barcode: req.body.barcode || null, memberId: req.body.memberId,
        remainingCredits: parseInt(req.body.remainingCredits),
        gymId: req.staff.gymId, staffId: req.staff.id,
      });
      res.status(201).json({ card, message: '黑卡綁定成功' });
    } catch (err) {
      if (err.code === 'CARD_ALREADY_BOUND') return res.status(409).json(err);
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

router.post('/black/:id/transfer',
  authenticate, checkPermission('products.sell'), auditLog('black_card.transfer'),
  [body('toMemberId').notEmpty(), body('credits').isInt({ min: 1 }), body('confirmedExpiry').equals('true').withMessage('請確認到期日')],
  validate,
  async (req, res) => {
    try {
      const result = await legacyCardService.transferBlackCard({
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
