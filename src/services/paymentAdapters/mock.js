/**
 * Mock 金流 Adapter（Phase 0/1 測試用，無需任何商戶金鑰）
 *
 * adapter 介面（與 linepay 一致）：
 *   createPayment({ orderId, amount, productName, memberInfo, returnUrls, gymSettings })
 *       → { paymentUrl, providerTxnId }
 *   extractOrderId(req) → orderId            // 從 callback 取出我方訂單 id（不需金鑰）
 *   verifyCallback(req, gymSettings, payment) → { success, providerTxnId, raw }
 *                                              // 驗章 / 對 gateway 做 Confirm（如 LinePay）
 */
module.exports = {
  async createPayment({ orderId, amount }) {
    return {
      paymentUrl: `/payments/mock/pay?paymentId=${orderId}&amount=${amount}`,
      providerTxnId: `MOCK-${orderId}`,
    };
  },

  extractOrderId(req) {
    return req.body?.paymentId || req.query?.paymentId || null;
  },

  async verifyCallback(req, _gymSettings, payment) {
    const success = (req.body?.success ?? req.query?.success) !== false;
    return { success, providerTxnId: payment?.providerTxnId || null, raw: req.body || null };
  },
};
