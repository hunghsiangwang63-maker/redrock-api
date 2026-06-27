/**
 * 統一付款服務（Phase 0 骨架）
 *
 * 生命週期：pending →(callback 成功)→ paid →(可)→ refunded
 *                      └(失敗/逾時/取消)→ failed | expired | cancelled
 *
 * 只有「pending → paid」那一刻（冪等）才會：
 *   1) 執行 orderHandlers[orderType] 完成業務動作
 *   2) 呼叫既有 recordTransaction() 寫入統一營收帳
 *
 * 新增 gateway：在 adapters 註冊一個實作 createPayment/verifyCallback 的 adapter 即可。
 * 新增收費類型：在 orderHandlers / TYPE_MAP 註冊對應 orderType。
 */
const { getDb } = require('../config/firebase');
const { recordTransaction } = require('../utils/revenueLedger');
const { v4: uuidv4 } = require('uuid');

const adapters = {
  mock: require('./paymentAdapters/mock'),
  // linepay: require('./paymentAdapters/linepay'),   // Phase 2
  // jkopay: require('./paymentAdapters/jkopay'),     // Phase 3
  // taiwanpay: require('./paymentAdapters/taiwanpay'),
};

// 各 orderType 在「付款成功」時要完成的業務動作。
// 回傳可含 { relatedId } 供記帳關聯。Phase 0 先放 mock；真實流程於 Phase 1+ 插入。
const orderHandlers = {
  mock: async (_db, _payment) => ({ ok: true }),
  // course: async (db, payment) => { ...建立報名... return { relatedId } },
  // competition / experience / pass / product ...
};

// orderType → revenue.js 既有的 transaction type（報表分類用）
const TYPE_MAP = {
  mock: 'product',
  // checkin: 'checkin', course: 'course', competition: 'competition', pass: 'pass', product: 'product', experience: 'product',
};

const PROVIDERS = Object.keys(adapters);

// ── 建立付款 ──────────────────────────────────────────────────────
async function createPayment({ provider = 'mock', orderType, orderRef = {}, gymId = null, memberId = null, memberName = '', amount, returnUrls = {} }) {
  const db = getDb();
  if (!adapters[provider]) throw { code: 'INVALID_PROVIDER', message: '不支援的付款方式' };
  if (!orderType) throw { code: 'MISSING_ORDER_TYPE', message: '缺少 orderType' };
  // 註：Phase 0（mock）暫接受傳入 amount；正式串接時改由各 orderType 後端權威計算，前端不送金額。
  if (!(Number(amount) > 0)) throw { code: 'INVALID_AMOUNT', message: '金額不正確' };

  const paymentId = uuidv4();
  const now = new Date();
  const payment = {
    id: paymentId,
    provider, status: 'pending',
    amount: Number(amount), currency: 'TWD',
    gymId, memberId, memberName,
    orderType, orderRef,
    relatedId: null, providerTxnId: null, paymentUrl: null,
    idempotencyKey: paymentId,
    rawCallback: null,
    createdAt: now, updatedAt: now, paidAt: null,
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
  };

  const r = await adapters[provider].createPayment({
    orderId: paymentId, amount: payment.amount,
    productName: `${orderType} 付款`,
    memberInfo: { memberId, memberName }, returnUrls,
  });
  payment.paymentUrl = r.paymentUrl || null;
  payment.providerTxnId = r.providerTxnId || null;

  await db.collection('payments').doc(paymentId).set(payment);
  return payment;
}

// ── 查詢付款 ──────────────────────────────────────────────────────
async function getPayment(id) {
  const db = getDb();
  const doc = await db.collection('payments').doc(id).get();
  return doc.exists ? doc.data() : null;
}

// ── gateway 回呼處理：驗簽 → 冪等更新 → 記帳 + 完成業務 ──────────────
async function handleCallback(provider, req) {
  const db = getDb();
  if (!adapters[provider]) throw { code: 'INVALID_PROVIDER', message: '不支援的付款方式' };

  const parsed = await adapters[provider].verifyCallback(req); // { orderId, providerTxnId, success, raw }
  if (!parsed || !parsed.orderId) throw { code: 'INVALID_CALLBACK', message: 'callback 驗證失敗' };

  const ref = db.collection('payments').doc(parsed.orderId);

  // 用 transaction 保證冪等：只有第一次 pending→paid 會回 justPaid
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw { code: 'PAYMENT_NOT_FOUND', message: '找不到付款單' };
    const payment = snap.data();
    if (payment.status === 'paid') return { payment, alreadyPaid: true };
    if (!parsed.success) {
      tx.update(ref, { status: 'failed', updatedAt: new Date(), rawCallback: parsed.raw || null });
      return { payment: { ...payment, status: 'failed' }, failed: true };
    }
    tx.update(ref, {
      status: 'paid', paidAt: new Date(),
      providerTxnId: parsed.providerTxnId || payment.providerTxnId,
      updatedAt: new Date(), rawCallback: parsed.raw || null,
    });
    return { payment: { ...payment, status: 'paid' }, justPaid: true };
  });

  if (result.justPaid) {
    const payment = result.payment;
    // 1) 完成業務動作（建立報名/購票…）
    let business = null;
    const handler = orderHandlers[payment.orderType];
    if (handler) business = await handler(db, payment);
    const relatedId = business?.relatedId || payment.relatedId || payment.id;
    if (relatedId !== (payment.relatedId || null)) {
      await ref.update({ relatedId });
    }
    // 2) 寫入統一營收帳
    await recordTransaction(db, {
      gymId: payment.gymId,
      type: TYPE_MAP[payment.orderType] || 'product',
      totalAmount: payment.amount,
      paymentMethod: payment.provider,
      memberId: payment.memberId,
      memberName: payment.memberName,
      relatedId,
      notes: `線上付款（${payment.provider}）`,
    });
  }

  return result;
}

module.exports = { createPayment, getPayment, handleCallback, PROVIDERS };
