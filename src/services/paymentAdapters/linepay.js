/**
 * LINE Pay Online API v3 Adapter（Phase 2 骨架，待填商戶金鑰）
 *
 * 流程：createPayment → Request API 取得 paymentUrl（導轉）→ 使用者付款 →
 *       LINE 將使用者導回 confirmUrl（夾帶 transactionId & orderId）→
 *       verifyCallback 呼叫 Confirm API 實際請款 → 成功即標記 paid。
 *
 * ⚠️ 金鑰來源：各「館別」不同 → 從 gymSettings 取
 *      gymSettings.linePayChannelId / gymSettings.linePayChannelSecret
 *    （存於 gyms/{gymId}.paymentSettings，由 paymentService 載入後傳入）
 *
 * ⚠️ 上線前待辦：
 *    1. 各館到 LINE Pay 商家中心開通線上付款、取得 Channel ID / Secret，填入 paymentSettings
 *    2. 設定環境變數：LINEPAY_ENV=sandbox|production、API_URL（confirmUrl 用）、CLIENT_URL（cancelUrl 用）
 *    3. 用 sandbox 跑一次端到端（Request→付款→Confirm）確認簽章與金額一致
 *    4. 於 PaymentFlow 將 linepay 的 enabled 改為 true（並移除 mock 的 dev-only 後上線）
 */
const crypto = require('crypto');

const BASE_URL = process.env.LINEPAY_ENV === 'production'
  ? 'https://api-pay.line.me'
  : 'https://sandbox-api-pay.line.me';

// LINE Pay v3 簽章：Base64(HMAC-SHA256(channelSecret, channelSecret + uri + body + nonce))
function sign(channelSecret, uri, bodyStr, nonce) {
  return crypto.createHmac('sha256', channelSecret)
    .update(channelSecret + uri + bodyStr + nonce)
    .digest('base64');
}

function creds(gymSettings) {
  const channelId = gymSettings?.linePayChannelId;
  const channelSecret = gymSettings?.linePayChannelSecret;
  if (!channelId || !channelSecret) {
    throw { code: 'LINEPAY_NOT_CONFIGURED', message: '此館尚未設定 LINE Pay 商戶金鑰' };
  }
  return { channelId, channelSecret };
}

module.exports = {
  // 建立付款：呼叫 Request API，回傳導轉用 paymentUrl 與 LINE 交易序號
  async createPayment({ orderId, amount, productName, returnUrls, gymSettings }) {
    const { channelId, channelSecret } = creds(gymSettings);
    const uri = '/v3/payments/request';
    const nonce = crypto.randomUUID();
    const body = {
      amount,
      currency: 'TWD',
      orderId,
      packages: [{
        id: orderId,
        amount,
        products: [{ name: productName || '紅石攀岩館', quantity: 1, price: amount }],
      }],
      redirectUrls: {
        // 使用者付款後導回此處（我方 callback）；orderId 由我方帶上以便對應
        confirmUrl: `${returnUrls?.confirmUrl || (process.env.API_URL || '') + '/payments/linepay/callback'}?orderId=${orderId}`,
        cancelUrl: returnUrls?.cancelUrl || `${process.env.CLIENT_URL || ''}/payment/cancel`,
      },
    };
    const bodyStr = JSON.stringify(body);
    const nonceVal = nonce;
    const res = await fetch(`${BASE_URL}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': channelId,
        'X-LINE-Authorization-Nonce': nonceVal,
        'X-LINE-Authorization': sign(channelSecret, uri, bodyStr, nonceVal),
      },
      body: bodyStr,
    });
    const data = await res.json();
    if (data.returnCode !== '0000') {
      throw { code: 'LINEPAY_REQUEST_FAILED', message: data.returnMessage || 'LINE Pay 建立付款失敗' };
    }
    return {
      paymentUrl: data.info.paymentUrl.web, // 桌機/手機網頁；如需 App scheme 用 paymentUrl.app
      providerTxnId: String(data.info.transactionId),
    };
  },

  // LINE 導回 confirmUrl 時，從 query 取出我方 orderId（不需金鑰）
  extractOrderId(req) {
    return req.query?.orderId || req.body?.orderId || null;
  },

  // 呼叫 Confirm API 實際請款；amount 以我方 payment 文件為準（不信前端/query）
  async verifyCallback(req, gymSettings, payment) {
    const { channelId, channelSecret } = creds(gymSettings);
    const transactionId = req.query?.transactionId || req.body?.transactionId || payment?.providerTxnId;
    if (!transactionId) return { success: false, raw: { reason: 'NO_TRANSACTION_ID' } };

    const uri = `/v3/payments/${transactionId}/confirm`;
    const nonce = crypto.randomUUID();
    const body = { amount: payment.amount, currency: 'TWD' }; // 權威金額來自 payment 文件
    const bodyStr = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${uri}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': channelId,
        'X-LINE-Authorization-Nonce': nonce,
        'X-LINE-Authorization': sign(channelSecret, uri, bodyStr, nonce),
      },
      body: bodyStr,
    });
    const data = await res.json();
    return {
      success: data.returnCode === '0000',
      providerTxnId: String(transactionId),
      raw: { returnCode: data.returnCode, returnMessage: data.returnMessage }, // 不存敏感資料
    };
  },
};
