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
  competition: async (db, payment) => {
    const regId = payment.orderRef?.registrationId;
    if (!regId) return { ok: false };
    await db.collection('competitionRegistrations').doc(regId).update({
      paymentStatus: 'confirmed',
      paidAmount: payment.amount,
      paidAt: new Date(),
      paidVia: payment.provider,
      paymentId: payment.id,
      updatedAt: new Date(),
    });
    return { relatedId: regId };
  },
  experience: async (db, payment) => {
    const id = payment.orderRef?.bookingId;
    if (!id) return { ok: false };
    await db.collection('experienceBookings').doc(id).update({
      status: 'confirmed',
      paidVia: payment.provider, paidAmount: payment.amount, paidAt: new Date(),
      paymentId: payment.id, updatedAt: new Date(),
    });
    return { relatedId: id };
  },
  course: async (db, payment) => {
    const id = payment.orderRef?.enrollmentId;
    if (!id) return { ok: false };
    await db.collection('courseEnrollments').doc(id).update({
      paymentStatus: 'confirmed',
      paidVia: payment.provider, paidAmount: payment.amount, paidAt: new Date(),
      paymentId: payment.id, updatedAt: new Date(),
    });
    return { relatedId: id };
  },
  pass: async (db, payment) => {
    const id = payment.orderRef?.passId;
    if (!id) return { ok: false };
    await db.collection('memberPasses').doc(id).update({
      paymentStatus: 'confirmed',
      paidVia: payment.provider, paidAmount: payment.amount, paidAt: new Date(),
      paymentId: payment.id, updatedAt: new Date(),
    });
    return { relatedId: id };
  },
  installment: async (db, payment) => {
    const { planId, seq } = payment.orderRef || {};
    if (!planId || seq == null) return { ok: false };
    const installmentService = require('./installmentService');
    const method = installmentService.VALID_PAYMENT_METHODS.includes(payment.provider) ? payment.provider : 'transfer';
    try {
      await installmentService.markInstallmentPaid({ planId, seq, paymentMethod: method, staffId: null });
    } catch (e) { if (e.code !== 'ALREADY_PAID') throw e; }
    return { relatedId: planId };
  },
  rental: async (db, payment) => {
    const id = payment.orderRef?.rentalId;
    if (!id) return { ok: false };
    await db.collection('equipmentRentals').doc(id).update({
      paymentStatus: 'confirmed', status: 'active',
      paidVia: payment.provider, paidAmount: payment.amount, paidAt: new Date(),
      paymentId: payment.id, updatedAt: new Date(),
    });
    return { relatedId: id };
  },
  checkin: async (db, payment) => {
    const id = payment.orderRef?.checkInId;
    if (!id) return { ok: false };
    await db.collection('checkIns').doc(id).update({
      paymentStatus: 'confirmed',
      paidVia: payment.provider, paidAmount: payment.amount, paidAt: new Date(),
      paymentId: payment.id, updatedAt: new Date(),
    });
    return { relatedId: id };
  },
  // product ... 後續階段插入
};

// orderType → 後端權威解析（金額/場館/會員），前端不送這些值。未註冊者沿用傳入值（Phase 0 mock）。
const orderResolvers = {
  competition: async (db, orderRef) => {
    const regId = orderRef?.registrationId;
    if (!regId) throw { code: 'INVALID_ORDER', message: '缺少報名 id' };
    const doc = await db.collection('competitionRegistrations').doc(regId).get();
    if (!doc.exists) throw { code: 'REGISTRATION_NOT_FOUND', message: '找不到報名紀錄' };
    const reg = doc.data();
    if (reg.paymentStatus === 'confirmed') throw { code: 'ALREADY_PAID', message: '此報名已完成付款' };
    let gymId = null;
    try { const c = await db.collection('competitions').doc(reg.competitionId).get(); if (c.exists) gymId = c.data().gymId || null; } catch (e) {}
    return { amount: reg.registrationFee, gymId, memberId: reg.memberId, memberName: reg.memberName };
  },
  experience: async (db, orderRef) => {
    const id = orderRef?.bookingId;
    if (!id) throw { code: 'INVALID_ORDER', message: '缺少預約 id' };
    const doc = await db.collection('experienceBookings').doc(id).get();
    if (!doc.exists) throw { code: 'BOOKING_NOT_FOUND', message: '找不到體驗預約' };
    const b = doc.data();
    if (b.status === 'confirmed') throw { code: 'ALREADY_PAID', message: '此預約已完成付款' };
    return { amount: b.totalFee, gymId: b.gymId || null, memberId: b.memberId || null, memberName: b.contactName || '' };
  },
  course: async (db, orderRef) => {
    const id = orderRef?.enrollmentId;
    if (!id) throw { code: 'INVALID_ORDER', message: '缺少報名 id' };
    const doc = await db.collection('courseEnrollments').doc(id).get();
    if (!doc.exists) throw { code: 'ENROLLMENT_NOT_FOUND', message: '找不到報名紀錄' };
    const e = doc.data();
    if (e.paymentStatus === 'confirmed') throw { code: 'ALREADY_PAID', message: '此報名已完成付款' };
    return { amount: e.enrollmentFee, gymId: e.gymId || null, memberId: e.memberId || null, memberName: e.memberName || '' };
  },
  pass: async (db, orderRef) => {
    const id = orderRef?.passId;
    if (!id) throw { code: 'INVALID_ORDER', message: '缺少定期票 id' };
    const doc = await db.collection('memberPasses').doc(id).get();
    if (!doc.exists) throw { code: 'PASS_NOT_FOUND', message: '找不到定期票' };
    const p = doc.data();
    if (p.paymentStatus === 'confirmed') throw { code: 'ALREADY_PAID', message: '此定期票已完成付款' };
    let price = 0;
    try { const t = await db.collection('passTypes').doc(p.passTypeId).get(); if (t.exists) price = t.data().price || 0; } catch (e) {}
    return { amount: price, gymId: p.gymId || null, memberId: p.memberId || null, memberName: p.memberName || '' };
  },
  installment: async (db, orderRef) => {
    const { planId, seq } = orderRef || {};
    if (!planId || seq == null) throw { code: 'INVALID_ORDER', message: '缺少分期計畫/期數' };
    const doc = await db.collection('installmentPlans').doc(planId).get();
    if (!doc.exists) throw { code: 'PLAN_NOT_FOUND', message: '找不到分期計畫' };
    const plan = doc.data();
    const inst = (plan.installments || []).find(i => i.seq === seq);
    if (!inst) throw { code: 'INSTALLMENT_NOT_FOUND', message: '找不到此期數' };
    if (inst.status === 'paid') throw { code: 'ALREADY_PAID', message: '此期已繳款' };
    return { amount: inst.amount, gymId: plan.gymId || null, memberId: plan.memberId || null, memberName: plan.memberName || '' };
  },
  rental: async (db, orderRef) => {
    const id = orderRef?.rentalId;
    if (!id) throw { code: 'INVALID_ORDER', message: '缺少租借 id' };
    const doc = await db.collection('equipmentRentals').doc(id).get();
    if (!doc.exists) throw { code: 'RENTAL_NOT_FOUND', message: '找不到租借申請' };
    const r = doc.data();
    if (r.paymentStatus === 'confirmed') throw { code: 'ALREADY_PAID', message: '此租借已完成付款' };
    return { amount: (r.totalRentalFee || 0) + (r.totalDeposit || 0), gymId: r.gymId || null, memberId: r.memberId || null, memberName: r.memberName || '' };
  },
  checkin: async (db, orderRef) => {
    const id = orderRef?.checkInId;
    if (!id) throw { code: 'INVALID_ORDER', message: '缺少入場 id' };
    const doc = await db.collection('checkIns').doc(id).get();
    if (!doc.exists) throw { code: 'CHECKIN_NOT_FOUND', message: '找不到入場紀錄' };
    const c = doc.data();
    if (c.paymentStatus === 'confirmed') throw { code: 'ALREADY_PAID', message: '此入場已完成付款' };
    return { amount: c.amountPaid || 0, gymId: c.gymId || null, memberId: c.memberId || null, memberName: c.memberName || '' };
  },
};

// orderType → revenue.js 既有的 transaction type（報表分類用）
const TYPE_MAP = {
  mock: 'product',
  competition: 'competition',
  experience: 'product',
  course: 'course',
  pass: 'pass',
  installment: 'pass',
  rental: 'product',
  checkin: 'checkin',
  // product: 'product',
};

const PROVIDERS = Object.keys(adapters);

// 各館的金流商戶設定（LinePay/街口/台灣Pay 帳號因館別而異），存於 gyms/{gymId}.paymentSettings。
// 機密只在後端執行期取用，不存進 payment 文件、不回傳前端。
async function loadGymPaymentSettings(db, gymId) {
  if (!gymId) return {};
  try {
    const doc = await db.collection('gyms').doc(gymId).get();
    return doc.exists ? (doc.data().paymentSettings || {}) : {};
  } catch (e) { return {}; }
}

// ── 建立付款 ──────────────────────────────────────────────────────
async function createPayment({ provider = 'mock', orderType, orderRef = {}, gymId = null, memberId = null, memberName = '', amount, returnUrls = {} }) {
  const db = getDb();
  if (!adapters[provider]) throw { code: 'INVALID_PROVIDER', message: '不支援的付款方式' };
  if (!orderType) throw { code: 'MISSING_ORDER_TYPE', message: '缺少 orderType' };
  // 已註冊的 orderType 一律後端權威解析金額/場館/會員（前端不送）；未註冊者（mock）沿用傳入值
  let finalAmount = amount, finalGymId = gymId, finalMemberId = memberId, finalMemberName = memberName;
  if (orderResolvers[orderType]) {
    const ctx = await orderResolvers[orderType](db, orderRef);
    finalAmount = ctx.amount;
    if (ctx.gymId != null) finalGymId = ctx.gymId;
    if (ctx.memberId != null) finalMemberId = ctx.memberId;
    if (ctx.memberName) finalMemberName = ctx.memberName;
  }
  if (!(Number(finalAmount) > 0)) throw { code: 'INVALID_AMOUNT', message: '金額不正確' };

  const paymentId = uuidv4();
  const now = new Date();
  const payment = {
    id: paymentId,
    provider, status: 'pending',
    amount: Number(finalAmount), currency: 'TWD',
    gymId: finalGymId, memberId: finalMemberId, memberName: finalMemberName,
    orderType, orderRef,
    relatedId: null, providerTxnId: null, paymentUrl: null,
    idempotencyKey: paymentId,
    rawCallback: null,
    createdAt: now, updatedAt: now, paidAt: null,
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
  };

  // 用「該館」的商戶設定建立付款（各館 LinePay/街口/台灣Pay 帳號不同）
  const gymSettings = await loadGymPaymentSettings(db, finalGymId);
  const r = await adapters[provider].createPayment({
    orderId: paymentId, amount: payment.amount,
    productName: `${orderType} 付款`,
    memberInfo: { memberId: finalMemberId, memberName: finalMemberName },
    returnUrls, gymSettings,
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
