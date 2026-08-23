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
const { getDb, COLLECTIONS } = require('../config/firebase');
const { recordTransaction } = require('../utils/revenueLedger');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const adapters = {
  mock: require('./paymentAdapters/mock'),
  linepay: require('./paymentAdapters/linepay'),     // 待各館填 Channel 金鑰（可運作）
  jkopay: require('./paymentAdapters/jkopay'),       // 骨架：待街口整合手冊 + 金鑰
  taiwanpay: require('./paymentAdapters/taiwanpay'), // 骨架：待收單銀行 API + 金鑰
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
    // 雙寫（Phase 1）：連動更新 courseRegistrations header 的 paymentStatus（比照 transfers.js
    // 轉帳確認收款那條路徑，2026-08-22 補上——此前線上付款成功只更新場次副本，header 永遠卡在
    // pending，任一 provider 真的開通前必須補齊，見 [[payment-integration-project]] 記錄的已知缺口）
    try {
      const enDoc = await db.collection('courseEnrollments').doc(id).get();
      if (enDoc.exists) {
        const en = enDoc.data();
        if (en.memberId && en.courseId) {
          const { updateRegistrationStatusByCourseMember } = require('./courseRegistrationService');
          await updateRegistrationStatusByCourseMember(db, en.memberId, en.courseId, {
            paymentStatus: 'confirmed', paymentConfirmed: true,
          });
        }
      }
    } catch (e2) { console.error('[雙寫] header 線上付款確認更新失敗（不影響付款本身）:', e2.message); }
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
  // 入場（pay-first，見 docs/payment-integration-plan.md §10/§12）：付款當下沒有任何入場紀錄可更新
  // （跟 checkin orderType 不同——checkin 是更新既有 checkIns 文件，entry 是全新的 pay-first 流程），
  // 改直接開一張單次入場券（30 天內任一天可用，validDate 不設 → 不受「限當天」限制，見 §12 修正說明）。
  entry: async (db, payment) => {
    const { gymId, entryType, rentShoes, rentChalk } = payment.orderRef || {};
    const memberId = payment.memberId;
    if (!memberId || !gymId || !entryType) return { ok: false };

    const memberService = require('./memberService');
    const member = await memberService.getMember(memberId).catch(() => null);

    const ticketId = uuidv4();
    const { taiwanToday } = require('../utils/taiwanDate');
    const issuedAt = taiwanToday();
    const expiresAt = dayjs(issuedAt).add(30, 'day').format('YYYY-MM-DD');
    const ticket = {
      id: ticketId,
      memberId, memberName: member?.name || payment.memberName || '',
      originalMemberId: memberId,
      gymId,
      baseEntryType: entryType,   // 線上預購當下選擇的入館身份（供追蹤用；redeem 時走一般單次券流程，不受此欄位限制）
      batchId: null, batchTotal: 1,
      issuedAt, expiresAt,
      validDate: null,           // 不限單日——30 天效期內任一天皆可用（與 getValidSingleEntryTickets 的「無 validDate 不受限」語意一致）
      status: 'active',          // 已透過線上金流付款，無需櫃檯審核，直接可用
      approvalDeadline: null, approvedAt: null, approvedBy: null,
      cancelledAt: null, cancelledBy: null, cancelReason: null,
      transferHistory: [],
      usedAt: null, usedCheckInId: null,
      amount: payment.amount, paymentMethod: payment.provider, paymentId: payment.id,
      // 2026-08-23：付款當下一併選了租借器材（金額已在 orderResolvers.entry 併入 payment.amount）——
      // 記在票上供 redeem（checkin/flow.js createPendingCheckIn）時權威判斷「租借已預繳、不再收費」，
      // 也讓自動產生 QR 那一步（會員 App 導回、React state 已因整頁重載被重置）知道要帶入哪些租借項目。
      rentShoes: !!rentShoes, rentChalk: !!rentChalk,
      source: 'online-entry', // 2026-08-22 由 'linepay-entry' 改中性命名（此路徑現由 jkopay 亦共用，非僅 linepay；write-only 欄位，前後端皆無讀取者，改名安全）
      notes: '會員線上付款預購入場',
      createdAt: new Date(), updatedAt: new Date(),
    };
    await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(ticketId).set(ticket);
    return { relatedId: ticketId };
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
  // 入場 pay-first：付款前沒有既有紀錄可查，orderRef 直接帶 { gymId, entryType }（會員自選館別+入館身份）；
  // memberId 一律信任 createPayment 呼叫端傳入的認證身份（見下方 createPayment 呼叫處第三參數），不信 orderRef。
  entry: async (db, orderRef, memberId) => {
    const { gymId, entryType, rentShoes, rentChalk } = orderRef || {};
    if (!memberId) throw { code: 'INVALID_ORDER', message: '缺少會員身份' };
    if (!gymId || !entryType) throw { code: 'INVALID_ORDER', message: '缺少場館或入館身份' };
    // 僅開放「單純付費入館」三種身份——卡/券/免費資格等本就有自己的（免費）入場路徑，不需要線上付款。
    if (!['single_ticket', 'student_free', 'child_free'].includes(entryType))
      throw { code: 'INVALID_ENTRY_TYPE', message: '此入館身份不支援線上付款預購' };

    const memberService = require('./memberService');
    const member = await memberService.getMember(memberId);
    if (!member) throw { code: 'MEMBER_NOT_FOUND', message: '找不到會員資料' };

    // 入場關卡（同日重複/Waiver/墜測/分期逾期）先擋，避免付了錢卻卡在入場關卡用不了——
    // 與 checkin/flow.js 的 createPendingCheckIn 共用同一份權威邏輯；redeem 該筆單次券時仍會再次通過此關卡。
    const { runEntryGates } = require('./checkin/gates');
    const gate = await runEntryGates(memberId, gymId);
    if (gate.blocked) throw { code: gate.code, message: gate.message };

    // 後端權威金額（含有效隊員 9 折；不套需現場出示證件的舊卡8折/特約廠商/友館隊員——這些無法線上驗證）
    const { computePaidEntryAmount } = require('./checkin/pricing');
    const computed = await computePaidEntryAmount(entryType, member);
    if (!computed || !(computed.amount > 0)) throw { code: 'INVALID_ENTRY_TYPE', message: '此入館身份無法線上付款' };

    // 2026-08-23 修正真實漏收案例：租借器材（岩鞋/粉袋）若在付款前已勾選，須併入線上付款總額——
    // 前端「租借器材」步驟本就在「選擇付款方式」之前，選完全部資訊才走到這裡，故 orderRef 帶來的
    // rentShoes/rentChalk 就是會員最終確認的選擇；後端權威加總金額（不信前端算好的 amount），
    // 與現金/其他方式的 handleGenerateQR 用同一組固定費率（岩鞋/粉袋，見 checkin/flow.js PRICES）。
    const { PRICES } = require('./checkin/pricing');
    const rentalAmount = (rentShoes ? (PRICES.shoes_rental || 100) : 0) + (rentChalk ? 50 : 0);
    return { amount: computed.amount + rentalAmount, gymId, memberId, memberName: member.name || '' };
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
  entry: 'checkin',
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

// 各 gateway 的顯示資訊與「該館需具備哪些金鑰」才算已設定
const PROVIDER_META = {
  linepay:   { label: 'LinePay', icon: '💚', credKeys: ['linePayChannelId', 'linePayChannelSecret'] },
  jkopay:    { label: '街口',    icon: '🔵', credKeys: ['jkoPayStoreId', 'jkoPayApiKey', 'jkoPaySecret'] },
  taiwanpay: { label: '台灣Pay', icon: '🇹🇼', credKeys: ['taiwanPayMerchantId', 'taiwanPayBankApiKey'] },
};

// 某館「可用的線上付款方式」= 全域啟用(env PAYMENT_PROVIDERS) ∩ 該館已填金鑰。
// 分段開放：加入 PAYMENT_PROVIDERS 啟用某 gateway、填某館金鑰啟用某館，皆無需改程式。
// ── 付款方式開關（權威）─────────────────────────────────────────
// 與 GET/PUT /settings/payment-methods 同源（systemSettings/paymentMethods.enabled）。
// 電子支付（linepay/jkopay/taiwanpay）預設關閉，金流 API 對接後由管理員開啟；
// rail 層在此做「權威驗證」：未開放的 provider 一律擋（不信前端顯示層）。
const PAYMENT_TOGGLE_DEFAULTS = { cash: true, transfer: true, linepay: false, jkopay: false, taiwanpay: false };
async function getEnabledPaymentToggles(db) {
  try {
    const doc = await db.collection('systemSettings').doc('paymentMethods').get();
    return { ...PAYMENT_TOGGLE_DEFAULTS, ...(doc.exists ? (doc.data().enabled || {}) : {}) };
  } catch (e) { return { ...PAYMENT_TOGGLE_DEFAULTS }; }
}

async function getAvailableMethods(gymId) {
  const db = getDb();
  const settings = await loadGymPaymentSettings(db, gymId);
  const enabled = (process.env.PAYMENT_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean);
  const toggles = await getEnabledPaymentToggles(db); // 系統設定開關（未開放者不列）
  const methods = [];
  for (const key of enabled) {
    const meta = PROVIDER_META[key];
    if (toggles[key] === false) continue;
    if (meta && meta.credKeys.every(k => settings[k])) {
      methods.push({ key, label: meta.label, icon: meta.icon });
    }
  }
  // 非正式環境加入 mock 供測試（正式環境永不出現）
  if (process.env.NODE_ENV !== 'production') {
    methods.unshift({ key: 'mock', label: '測試付款', icon: '🧪' });
  }
  return methods;
}

// ── 建立付款 ──────────────────────────────────────────────────────
async function createPayment({ provider = 'mock', orderType, orderRef = {}, gymId = null, memberId = null, memberName = '', amount, returnUrls = {} }) {
  const db = getDb();
  if (!adapters[provider]) throw { code: 'INVALID_PROVIDER', message: '不支援的付款方式' };
  // 權威驗證：付款方式須於系統設定開放（顯示層 gate 之外的後端把關；mock 僅測試用不受控）
  if (provider !== 'mock') {
    const toggles = await getEnabledPaymentToggles(db);
    if (toggles[provider] === false) throw { code: 'METHOD_DISABLED', message: '此付款方式尚未開放' };
  }
  if (!orderType) throw { code: 'MISSING_ORDER_TYPE', message: '缺少 orderType' };
  // 已註冊的 orderType 一律後端權威解析金額/場館/會員（前端不送）；未註冊者（mock）沿用傳入值
  let finalAmount = amount, finalGymId = gymId, finalMemberId = memberId, finalMemberName = memberName;
  if (orderResolvers[orderType]) {
    // 第三參數 memberId：僅 entry（pay-first）用得到，取當下呼叫端的認證身份（不信 orderRef 內容）；
    // 其餘既有 resolver 不宣告第三參數，多傳不影響。
    const ctx = await orderResolvers[orderType](db, orderRef, finalMemberId);
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
  const adapter = adapters[provider];
  if (!adapter) throw { code: 'INVALID_PROVIDER', message: '不支援的付款方式' };

  // 1) 從 callback 取出我方訂單 id（不需金鑰）
  const orderId = adapter.extractOrderId ? adapter.extractOrderId(req) : null;
  if (!orderId) throw { code: 'INVALID_CALLBACK', message: 'callback 缺少訂單 id' };

  const ref = db.collection('payments').doc(orderId);
  const snap0 = await ref.get();
  if (!snap0.exists) throw { code: 'PAYMENT_NOT_FOUND', message: '找不到付款單' };
  const payment0 = snap0.data();
  if (payment0.status === 'paid') return { payment: payment0, alreadyPaid: true }; // 冪等：已付不重複 confirm/請款

  // 2) 用「該館」設定驗章 / 對 gateway 做 Confirm（LinePay 在此實際請款，金額以 payment 文件為準）
  const gymSettings = await loadGymPaymentSettings(db, payment0.gymId);
  const verified = await adapter.verifyCallback(req, gymSettings, payment0); // { success, providerTxnId, raw }

  // 3) transaction 內冪等更新狀態
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw { code: 'PAYMENT_NOT_FOUND', message: '找不到付款單' };
    const payment = snap.data();
    if (payment.status === 'paid') return { payment, alreadyPaid: true };
    if (!verified.success) {
      tx.update(ref, { status: 'failed', updatedAt: new Date(), rawCallback: verified.raw || null });
      return { payment: { ...payment, status: 'failed' }, failed: true };
    }
    tx.update(ref, {
      status: 'paid', paidAt: new Date(),
      providerTxnId: verified.providerTxnId || payment.providerTxnId,
      updatedAt: new Date(), rawCallback: verified.raw || null,
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

// ── 退款「線上付費預購入場」單次入場券（2026-08-22，見 docs/payment-integration-plan.md §10）──
// 僅限 orderHandlers.entry 開出、尚未使用（status==='active'）的票——直接呼叫原付款 provider 的
// refundPayment 真的退錢回會員的支付帳戶，而非既有「只做內部帳務沖銷」的手動退費模式
// （見 checkin/cancel.js、passes.js /single-entry/:id/reject 兩處既有 refund：那兩處都只是內部
// 帳上沖銷，從未真的呼叫金流退款 API）。目前僅 jkopay adapter 有 refundPayment 實作，其餘 provider
// 會擋 REFUND_NOT_SUPPORTED（非硬編死 provider 名單，未來 linepay/taiwanpay 補上 refundPayment 即自動可用）。
async function refundEntryTicket(ticketId, { staffId = null, staffName = null, reason = '' } = {}) {
  const db = getDb();
  const ticketRef = db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(ticketId);
  const ticketDoc = await ticketRef.get();
  if (!ticketDoc.exists) throw { code: 'TICKET_NOT_FOUND', message: '找不到入場券' };
  const ticket = ticketDoc.data();
  if (ticket.status !== 'active') throw { code: 'TICKET_NOT_ACTIVE', message: `此票券狀態為 ${ticket.status}，無法線上退款` };
  if (!ticket.paymentId) throw { code: 'NOT_ONLINE_PAYMENT', message: '此票券非線上付款購買，無法自動退款' };

  const paymentDoc = await db.collection('payments').doc(ticket.paymentId).get();
  if (!paymentDoc.exists) throw { code: 'PAYMENT_NOT_FOUND', message: '找不到原始付款紀錄' };
  const payment = paymentDoc.data();
  if (payment.status !== 'paid') throw { code: 'PAYMENT_NOT_PAID', message: `原始付款狀態為 ${payment.status}，無法退款` };

  const adapter = adapters[payment.provider];
  if (!adapter || typeof adapter.refundPayment !== 'function') {
    throw { code: 'REFUND_NOT_SUPPORTED', message: `${PROVIDER_META[payment.provider]?.label || payment.provider} 尚未支援自動線上退款` };
  }

  const gymSettings = await loadGymPaymentSettings(db, payment.gymId);
  const refundResult = await adapter.refundPayment({
    platformOrderId: payment.id, // 對齊 createPayment：建立付款當下 platform_order_id 送的就是我方 payments/{id}
    refundOrderId: `refund-${ticketId}`,
    refundAmount: payment.amount,
    gymSettings,
  });

  const now = new Date();
  await ticketRef.update({
    status: 'cancelled',
    cancelledAt: now, cancelledBy: staffId,
    cancelReason: reason || '線上退款',
    refundedAt: now, refundProviderTxnId: refundResult.refundTradeNo || null,
    updatedAt: now,
  });
  await db.collection('payments').doc(ticket.paymentId).update({ status: 'refunded', updatedAt: now });

  await recordTransaction(db, {
    gymId: ticket.gymId, type: 'refund', totalAmount: -Number(payment.amount),
    paymentMethod: payment.provider, memberId: ticket.memberId, memberName: ticket.memberName,
    relatedId: ticketId, notes: `線上付款入場券退款（${payment.provider}）${reason ? '：' + reason : ''}`,
    staffId, staffName: staffName || '',
  });

  return { ticketId, provider: payment.provider, amount: payment.amount, refundTradeNo: refundResult.refundTradeNo || null };
}

module.exports = { createPayment, getPayment, handleCallback, getAvailableMethods, refundEntryTicket, PROVIDERS };
