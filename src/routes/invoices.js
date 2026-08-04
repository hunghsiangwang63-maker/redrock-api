/**
 * 發票號碼管理（P2，見 docs/invoice-integration-plan.md §5.2/§5.2.1/§6）
 * GET /invoices/state?gymId=    查詢目前發票號碼狀態
 * PUT /invoices/state           換捲重設／中途校正（值班或管理員）
 *
 * ⚠️ 此檔為「WP-560 實體印表機列印」計畫（第 1-8 節）的號碼管理層，與現行已上線、
 * 走 invoiceRecords 集合的 §9 手動開立發票 modal（invoiceService.js）是不同層次，互不影響。
 * 之後 P3/P4（實際列印接線）、P6（作廢/退貨）、P7（退費報表）皆會擴充此檔。
 */
const express = require('express');
const router = express.Router();
const { authenticate, requireManagerOrStation } = require('../middleware/auth');
const invoiceNumberService = require('../services/invoiceNumberService');

// GET /invoices/state?gymId= - 查詢目前發票號碼狀態（唯讀，任何已登入員工可看，供結帳/櫃檯核對）
router.get('/state', authenticate, async (req, res) => {
  try {
    const gymId = req.query.gymId || req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const state = await invoiceNumberService.getInvoiceState(gymId);
    res.json({ invoiceState: state });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT /invoices/state - 換捲重設／中途校正（值班 operator 或管理員；見 §5.2.1 三段式權限）
router.put('/state', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const gymId = req.body.gymId || req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const { track, startNumber, reason, force } = req.body;
    const result = await invoiceNumberService.setInvoiceState(
      gymId, { track, startNumber, reason, force: !!force },
      { staffId: req.staff?.id, staffName: req.staff?.name }
    );
    if (result.warning) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
