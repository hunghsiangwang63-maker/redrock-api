/**
 * 台灣Pay / TWQR Adapter（骨架，待收單銀行 API 規格 + 各館金鑰）
 *
 * ⚠️ 台灣Pay 是「跨行 QR（TWQR / EMVCo）」標準，由財金公司制定、但實際收款
 *    API 多由「收單銀行」提供，端點 / 認證 / QR 產生方式因銀行而異，無法用
 *    單一公開規格寫死。本檔備好 adapter 介面、每館金鑰與流程；實作處標 TODO。
 *
 * 流程：createPayment 向收單銀行請求/產生 TWQR（EMVCo 格式）→ 客人用銀行/電子
 *      支付 App 掃碼付款 → 銀行以 callback/查詢回報結果 → verifyCallback 確認。
 *
 * 金鑰來源（各館不同）：gymSettings.taiwanPayMerchantId / gymSettings.taiwanPayBankApiKey
 *   （存於 gyms/{gymId}.paymentSettings；實際欄位依收單銀行）
 *
 * 上線待辦：
 *   1. 各館與收單銀行簽約取得台灣Pay/TWQR 收款資格與 API 金鑰，填入 paymentSettings
 *   2. 依銀行 API 文件填入 BASE_URL、產生 TWQR / 查詢交易 的端點與認證方式
 *   3. sandbox 測試後，於 PaymentFlow 將 taiwanpay enabled 改 true
 */
function creds(gymSettings) {
  const merchantId = gymSettings?.taiwanPayMerchantId;
  const apiKey = gymSettings?.taiwanPayBankApiKey;
  if (!merchantId || !apiKey) {
    throw { code: 'TAIWANPAY_NOT_CONFIGURED', message: '此館尚未設定台灣Pay/TWQR 商戶金鑰' };
  }
  return { merchantId, apiKey };
}

module.exports = {
  async createPayment({ orderId, amount, productName, gymSettings }) {
    const { merchantId, apiKey } = creds(gymSettings);
    // TODO: 依收單銀行 API 產生 TWQR（EMVCo QR 字串）或交易，回傳給前端顯示 QR
    //   const res = await fetch(`${BANK_BASE}/twqr/...`, { ...merchantId/apiKey... });
    //   return { paymentUrl: data.qrCode, providerTxnId: data.txnId };  // paymentUrl 可放 QR 內容
    throw {
      code: 'TAIWANPAY_NOT_IMPLEMENTED',
      message: '台灣Pay/TWQR 串接待收單銀行 API 規格補完（adapter 介面與金鑰已就緒）',
    };
  },

  extractOrderId(req) {
    // TODO: 依銀行 callback 參數名調整
    return req.body?.orderId || req.query?.orderId || req.body?.merchantTradeNo || null;
  },

  async verifyCallback(req, gymSettings, payment) {
    const { merchantId, apiKey } = creds(gymSettings);
    // TODO: 依銀行文件驗 callback 簽章 / 查詢交易，確認狀態與金額(payment.amount)相符
    //   成功 → { success: true, providerTxnId, raw }
    throw {
      code: 'TAIWANPAY_NOT_IMPLEMENTED',
      message: '台灣Pay callback 驗證待收單銀行 API 規格補完',
    };
  },
};
