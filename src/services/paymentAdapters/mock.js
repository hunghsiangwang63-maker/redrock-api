/**
 * Mock 金流 Adapter（Phase 0 用，無需任何商戶金鑰）
 *
 * 用來打通「建立付款 → callback → 記帳 → 完成業務」全鏈路，
 * 之後 linepay/jkopay/taiwanpay 只要實作相同三個方法即可替換。
 *
 * adapter 介面：
 *   createPayment({ orderId, amount, productName, memberInfo, returnUrls }) → { paymentUrl, providerTxnId }
 *   verifyCallback(req) → { orderId, providerTxnId, success, raw }
 *   confirmPayment(...)  // 需二次確認的 gateway（如 LinePay）才實作；mock 不需要
 */
module.exports = {
  async createPayment({ orderId, amount }) {
    // 真實 gateway 會回 gateway 端的付款頁/QR；mock 回本地模擬付款頁
    return {
      paymentUrl: `/payments/mock/pay?paymentId=${orderId}&amount=${amount}`,
      providerTxnId: `MOCK-${orderId}`,
    };
  },

  async verifyCallback(req) {
    // 真實 gateway 會在此驗章；mock 直接信任 body 的 { paymentId, success }
    const { paymentId, success } = req.body || {};
    return {
      orderId: paymentId || null,
      providerTxnId: paymentId ? `MOCK-${paymentId}` : null,
      success: success !== false,
      raw: req.body || null,
    };
  },
};
