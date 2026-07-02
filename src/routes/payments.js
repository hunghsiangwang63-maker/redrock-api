/**
 * 統一付款路由（Phase 0）
 *
 * POST /payments                 建立付款（回 paymentUrl）
 * GET  /payments/:id             查詢付款狀態（前端輪詢用）
 * POST /payments/:provider/callback   gateway 回呼（公開，由 adapter 驗簽）
 * POST /payments/mock/pay        【mock 專用】模擬使用者完成付款 → 觸發 callback
 */
const express = require('express');
const router = express.Router();
const { authenticateAny } = require('../middleware/auth');
const paymentService = require('../services/paymentService');

// ── 建立付款 ──────────────────────────────────────────────────────
router.post('/', authenticateAny, async (req, res) => {
  try {
    const { provider, orderType, orderRef, gymId, amount } = req.body;
    const payment = await paymentService.createPayment({
      provider, orderType, orderRef, gymId, amount,
      memberId: req.member?.id || req.body.memberId || null,
      memberName: req.member?.name || req.body.memberName || '',
    });
    res.status(201).json({
      paymentId: payment.id, status: payment.status,
      paymentUrl: payment.paymentUrl, amount: payment.amount, provider: payment.provider,
    });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── 某館可用的線上付款方式（per-gym + per-gateway 分段開放）──────────
router.get('/methods', authenticateAny, async (req, res) => {
  try {
    const methods = await paymentService.getAvailableMethods(req.query.gymId || null);
    res.json({ methods });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── 查詢付款狀態 ──────────────────────────────────────────────────
router.get('/:id', authenticateAny, async (req, res) => {
  try {
    const p = await paymentService.getPayment(req.params.id);
    if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
    if (req.member && p.memberId && p.memberId !== req.member.id)
      return res.status(403).json({ error: 'FORBIDDEN' });
    res.json({ id: p.id, status: p.status, amount: p.amount, provider: p.provider, paymentUrl: p.paymentUrl });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── gateway 回呼（公開，adapter 內驗簽）────────────────────────────
router.post('/:provider/callback', async (req, res) => {
  try {
    const result = await paymentService.handleCallback(req.params.provider, req);
    res.json({ received: true, status: result.payment.status });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── 【mock 專用】模擬付款完成（僅非正式環境；正式環境一律 404，避免任意標記已付）──
router.post('/mock/pay', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    const paymentId = req.body.paymentId || req.query.paymentId;
    const success = req.body.success !== false;
    const result = await paymentService.handleCallback('mock', { body: { paymentId, success } });
    res.json({ paid: result.payment.status === 'paid', status: result.payment.status });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
