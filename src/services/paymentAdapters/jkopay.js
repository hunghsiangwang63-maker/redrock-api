/**
 * 街口支付 JKOPAY 線上交易 Adapter（骨架，待簽約規格 + 各館金鑰）
 *
 * ⚠️ 與 LinePay 不同：街口線上交易 API 需與街口簽約後取得「商家整合手冊」，
 *    端點 / 參數 / 簽章(digest) 規格依合約版本而異，無法憑公開資訊寫死。
 *    本檔備好 adapter 介面、每館金鑰來源與簽章位置；實際 HTTP 呼叫處標 TODO。
 *
 * 金鑰來源（各館不同）：gymSettings.jkoPayStoreId / gymSettings.jkoPaySecret
 *   （存於 gyms/{gymId}.paymentSettings）
 *
 * 上線待辦：
 *   1. 各館完成街口特約商店申請，取得 Store ID / API Key，填入 paymentSettings
 *   2. 依街口整合手冊填入 BASE_URL、建立交易/查詢 API 路徑與 digest 演算法
 *   3. sandbox 端到端測試後，於 PaymentFlow 將 jkopay enabled 改 true
 */
const crypto = require('crypto');

const BASE_URL = process.env.JKOPAY_ENV === 'production'
  ? 'https://API_PLACEHOLDER.jkopay.com'   // TODO: 依整合手冊填正式網域
  : 'https://SANDBOX_PLACEHOLDER.jkopay.com'; // TODO: sandbox 網域

// TODO: 依街口手冊實作 digest（常見為 SHA256(排序後參數 + secret)）
function sign(secret, payload) {
  return crypto.createHash('sha256').update(payload + secret).digest('hex');
}

function creds(gymSettings) {
  const storeId = gymSettings?.jkoPayStoreId;
  const secret = gymSettings?.jkoPaySecret;
  if (!storeId || !secret) {
    throw { code: 'JKOPAY_NOT_CONFIGURED', message: '此館尚未設定街口支付商戶金鑰' };
  }
  return { storeId, secret };
}

module.exports = {
  async createPayment({ orderId, amount, productName, returnUrls, gymSettings }) {
    const { storeId, secret } = creds(gymSettings);
    // TODO: 依街口整合手冊組 request、簽 digest、呼叫建立交易 API，取回付款 URL/QR
    //   const body = { store_id: storeId, order_id: orderId, total_price: amount, ... };
    //   const digest = sign(secret, canonicalize(body));
    //   const res = await fetch(`${BASE_URL}/...`, { ... });
    //   return { paymentUrl: data.payment_url, providerTxnId: data.platform_order_id };
    throw {
      code: 'JKOPAY_NOT_IMPLEMENTED',
      message: '街口支付串接待整合手冊規格補完（adapter 介面與金鑰已就緒）',
    };
  },

  extractOrderId(req) {
    // TODO: 依街口 callback 參數名調整（常見 order_id）
    return req.body?.order_id || req.query?.order_id || req.body?.orderId || null;
  },

  async verifyCallback(req, gymSettings, payment) {
    const { storeId, secret } = creds(gymSettings);
    // TODO: 依手冊驗 callback digest；必要時呼叫查詢 API 確認交易狀態與金額(payment.amount)
    //   驗證成功且金額相符 → { success: true, providerTxnId, raw }
    throw {
      code: 'JKOPAY_NOT_IMPLEMENTED',
      message: '街口 callback 驗證待整合手冊規格補完',
    };
  },
};
