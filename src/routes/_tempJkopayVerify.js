/**
 * TEMP — 街口支付 UAT 驗測用診斷路由（2026-08-18）。
 * 目的：產生街口驗測腳本要求的「3 筆正向訂單 + 1 筆負向訂單」逐字 request/response log。
 * super_admin 限定。驗測完成、log 已擷取後即整段移除本檔＋index.js 掛載，不留在正式環境。
 *
 * 沙盒憑證直接寫死於本檔（僅供這次驗測用，非存進任何真實館別的 paymentSettings）：
 * 出處：JKoPay Irene Wang 2026-08-18 mail 附件「onlinepay 驗測腳本_紅石攀岩有限公司.xlsx」
 *      →「測試環境資料」分頁。
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const jkopay = require('../services/paymentAdapters/jkopay');

const SANDBOX = {
  jkoPayStoreId: '25a2034b-fd2c-11ee-ba07-0050568403ed',
  jkoPayApiKey: 'a0514710d30add31e0c3ef175cd4728dc44733784f275fac866037ffe8cac0f9',
  jkoPaySecret: 'f5fe214196372707f15de1a2d6a36130296892f93e48788acf8c966c560f7220',
};

router.use((req, res, next) => authenticate(req, res, () => {
  if (req.staff?.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  next();
}));

// POST /_temp/jkopay-verify/entry  { orderId, amount }
router.post('/entry', async (req, res) => {
  try {
    const { orderId, amount } = req.body;
    const { storeId, apiKey, secret } = jkopay._creds(SANDBOX);
    const body = {
      platform_order_id: orderId,
      store_id: storeId,
      currency: 'TWD',
      total_price: Math.round(amount),
      final_price: Math.round(amount),
      unredeem: 0,
      result_url: `https://api.redrocktaiwan.com/payments/jkopay/callback?platform_order_id=${orderId}`,
      result_display_url: 'https://app.redrocktaiwan.com/payment/cancel',
    };
    const { data, requestBody } = await jkopay._callApiRaw('POST', '/platform/entry', { apiKey, secret, bodyObj: body });
    res.json({ requestBody, response: data, paymentUrl: data.result_object?.payment_url, qrImg: data.result_object?.qr_img });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message, detail: err });
  }
});

// GET /_temp/jkopay-verify/inquiry?orderIds=a,b,c
router.get('/inquiry', async (req, res) => {
  try {
    const { apiKey, secret } = jkopay._creds(SANDBOX);
    const queryStr = `platform_order_ids=${req.query.orderIds}`;
    const { data, requestBody } = await jkopay._callApiRaw('GET', '/platform/inquiry', { apiKey, secret, queryStr });
    res.json({ requestBody, response: data });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message, detail: err });
  }
});

// POST /_temp/jkopay-verify/refund  { platformOrderId, refundOrderId, refundAmount }
router.post('/refund', async (req, res) => {
  try {
    const { platformOrderId, refundOrderId, refundAmount } = req.body;
    const { apiKey, secret } = jkopay._creds(SANDBOX);
    const body = { platform_order_id: platformOrderId, refund_order_id: refundOrderId, refund_amount: Math.round(refundAmount) };
    const { data, requestBody } = await jkopay._callApiRaw('POST', '/platform/refund', { apiKey, secret, bodyObj: body });
    res.json({ requestBody, response: data });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message, detail: err });
  }
});

module.exports = router;
