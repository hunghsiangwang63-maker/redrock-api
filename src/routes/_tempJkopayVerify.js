/**
 * TEMP — 街口支付 UAT 驗測用診斷路由（2026-08-18）。
 * 目的：產生街口驗測腳本要求的「3 筆正向訂單 + 1 筆負向訂單」逐字 request/response log。
 * super_admin 限定。驗測完成、log 已擷取後即整段移除本檔＋index.js 掛載，不留在正式環境。
 *
 * ⚠️ 刻意完全自包含、不依賴 process.env.JKOPAY_API_HOST（該環境變數尚未在 Railway 設定，
 * 避免為了這次驗測去改動 Railway 帳號設定；UAT host 與沙盒憑證直接寫死於本檔，僅供這次
 * 驗測用，非存進任何真實館別的 paymentSettings，也不影響 jkopay.js 本身的環境變數讀取邏輯）。
 * 出處：JKoPay Irene Wang 2026-08-18 mail 附件「onlinepay 驗測腳本_紅石攀岩有限公司.xlsx」
 *      →「測試環境資料」分頁。
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');

const HOST = 'https://uat-onlinepay.jkopay.app';
const STORE_ID = '25a2034b-fd2c-11ee-ba07-0050568403ed';
const API_KEY = 'a0514710d30add31e0c3ef175cd4728dc44733784f275fac866037ffe8cac0f9';
const SECRET = 'f5fe214196372707f15de1a2d6a36130296892f93e48788acf8c966c560f7220';

// digest = hex(HMAC-SHA256(payload, secret))——與 jkopay.js 的 sign() 邏輯逐字相同
function sign(payloadStr) {
  return crypto.createHmac('sha256', SECRET).update(payloadStr, 'utf8').digest('hex');
}

async function callRaw(method, path, { bodyObj, queryStr }) {
  const isGet = method === 'GET';
  const payloadStr = isGet ? (queryStr || '') : JSON.stringify(bodyObj || {});
  const digest = sign(payloadStr);
  const url = isGet ? `${HOST}${path}?${queryStr}` : `${HOST}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'api-key': API_KEY, digest },
    body: isGet ? undefined : payloadStr,
  });
  const data = await res.json();
  return { data, requestBody: isGet ? queryStr : bodyObj };
}

router.use((req, res, next) => authenticate(req, res, () => {
  if (req.staff?.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  next();
}));

// POST /_temp/jkopay-verify/entry  { orderId, amount }
router.post('/entry', async (req, res) => {
  try {
    const { orderId, amount } = req.body;
    const body = {
      platform_order_id: orderId,
      store_id: STORE_ID,
      currency: 'TWD',
      total_price: Math.round(amount),
      final_price: Math.round(amount),
      unredeem: 0,
      result_url: `https://api.redrocktaiwan.com/payments/jkopay/callback?platform_order_id=${orderId}`,
      result_display_url: 'https://app.redrocktaiwan.com/payment/cancel',
    };
    const { data, requestBody } = await callRaw('POST', '/platform/entry', { bodyObj: body });
    res.json({ requestBody, response: data, paymentUrl: data.result_object?.payment_url, qrImg: data.result_object?.qr_img });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// GET /_temp/jkopay-verify/inquiry?orderIds=a,b,c
router.get('/inquiry', async (req, res) => {
  try {
    const queryStr = `platform_order_ids=${req.query.orderIds}`;
    const { data, requestBody } = await callRaw('GET', '/platform/inquiry', { queryStr });
    res.json({ requestBody, response: data });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// POST /_temp/jkopay-verify/refund  { platformOrderId, refundOrderId, refundAmount }
router.post('/refund', async (req, res) => {
  try {
    const { platformOrderId, refundOrderId, refundAmount } = req.body;
    const body = { platform_order_id: platformOrderId, refund_order_id: refundOrderId, refund_amount: Math.round(refundAmount) };
    const { data, requestBody } = await callRaw('POST', '/platform/refund', { bodyObj: body });
    res.json({ requestBody, response: data });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
