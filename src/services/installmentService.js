/**
 * 分期付款 Service
 *
 * 規則：
 * - 適用範圍：課程報名、定期票購買
 * - 期數與每期金額自由輸入（不限平均分攤）
 * - 收款方式：linepay / jkopay / taiwanpay / transfer / cash（館方人工記帳，非自動扣款）
 * - 逾期未繳當期款項 → 暫停入場資格，並寄送Email提醒/逾期通知
 */
const { taiwanToday } = require('../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');

const VALID_PAYMENT_METHODS = ['linepay', 'jkopay', 'taiwanpay', 'transfer', 'cash'];

// ── 由「課程/票種的分期規則」+ 總價 + 起始日 產出各期 {amount,dueDate} ──
// config = { enabled, periods:[{ percent, dueOffsetDays }] }；percent 為佔總價比例(合計≈100)，
// 金額四捨五入、最後一期吸收餘數以確保合計＝總價；到期日＝起始日 + dueOffsetDays。
const buildPeriodsFromConfig = (config, totalPrice, startDateStr) => {
  const dayjs = require('dayjs');
  const periods = (config?.periods || []).filter(p => (Number(p.percent) || 0) > 0);
  if (periods.length < 2 || !(totalPrice > 0)) return null;
  const start = startDateStr || taiwanToday();
  let allocated = 0;
  return periods.map((p, i) => {
    const isLast = i === periods.length - 1;
    const amount = isLast ? (totalPrice - allocated) : Math.round(totalPrice * (Number(p.percent) || 0) / 100);
    allocated += amount;
    return { amount, dueDate: dayjs(start).add(Number(p.dueOffsetDays) || 0, 'day').format('YYYY-MM-DD') };
  });
};

// 續約分期：前 n-1 期照原價比例、續約折扣的差價全部集中在最後一期扣掉。
// 例：半年票 7600、9折(6840)、3期(40/40/20%) → 3040/3040/760 → 折後 3040/3040/(6840-6080)=760
//     使用者確認之例（第1期2534/第2期2533/第3期1773）為早期 round 的另一組比例；本函式一律「前期原價、末期吸收折扣」。
const buildRenewalPeriods = (config, fullPrice, renewalPrice, startDateStr) => {
  const dayjs = require('dayjs');
  const periods = (config?.periods || []).filter(p => (Number(p.percent) || 0) > 0);
  if (periods.length < 2 || !(renewalPrice > 0)) return null;
  const start = startDateStr || taiwanToday();
  let allocated = 0;
  return periods.map((p, i) => {
    const isLast = i === periods.length - 1;
    // 末期 = 續約總價 - 前面各期(照原價比例)已分配；夾在 [0, renewalPrice] 內
    const raw = isLast ? (renewalPrice - allocated) : Math.round(fullPrice * (Number(p.percent) || 0) / 100);
    const amount = Math.max(0, raw);
    allocated += amount;
    return { amount, dueDate: dayjs(start).add(Number(p.dueOffsetDays) || 0, 'day').format('YYYY-MM-DD') };
  });
};

// ── 分期繳款記帳 ──────────────────────────────────────────────────
// 每期繳款記一筆 transactions（進營收/結算）。認列日：
//   課程＝預收，認列在最後一堂（plan.recognitionDate）；定期票＝收款日即時（recognitionDate=null→paidAt）
const recordInstallmentRevenue = async (db, plan, period, paymentMethod, staffId = null, staffName = '') => {
  if (!plan.gymId) return null;   // 無館別不記（避免壞報表）；舊 manual 計畫可能無 gymId
  const { recordTransaction } = require('../utils/revenueLedger');
  const recognitionDate = plan.relatedType === 'course' ? (plan.recognitionDate || null) : null;
  return recordTransaction(db, {
    gymId: plan.gymId,
    type: plan.relatedType,        // 'course' | 'pass'（沿用 revenue 既有歸類）
    totalAmount: period.amount,
    paymentMethod: paymentMethod || 'cash',
    memberId: plan.memberId,
    memberName: plan.memberName || '',
    relatedId: plan.relatedId || plan.id,
    notes: `分期-${plan.itemName}（第${period.seq}/${(plan.installments || []).length}期）`,
    staffId, staffName,
    recognitionDate,
  });
};

// ── 建立分期付款計畫 ──────────────────────────────────────────────
const createInstallmentPlan = async ({ memberId, memberName, gymId, relatedType, relatedId, itemName, recognitionDate, installments, firstPaymentMethod, staffId, staffName }) => {
  if (!['course', 'pass'].includes(relatedType)) {
    throw { code: 'INVALID_TYPE', message: 'relatedType 必須為 course 或 pass' };
  }
  if (!Array.isArray(installments) || installments.length < 2) {
    throw { code: 'INVALID_INSTALLMENTS', message: '分期至少需要2期，否則請使用一般付款' };
  }
  for (const i of installments) {
    if (!i.amount || i.amount <= 0) throw { code: 'INVALID_AMOUNT', message: '每期金額必須大於0' };
    if (!i.dueDate) throw { code: 'INVALID_DUE_DATE', message: '請輸入每期到期日' };
  }

  const db = getDb();
  const planId = uuidv4();
  const now = new Date();
  const totalAmount = installments.reduce((sum, i) => sum + i.amount, 0);

  const periods = installments.map((i, idx) => ({
    seq: idx + 1,
    amount: i.amount,
    dueDate: i.dueDate,
    status: 'pending',
    paidAt: null,
    paymentMethod: null,
    note: i.note || '',
  }));
  // 第一期自動收款（簽約當下收頭款）
  if (firstPaymentMethod) {
    periods[0] = { ...periods[0], status: 'paid', paidAt: now, paymentMethod: firstPaymentMethod, paidBy: staffId || null };
  }

  const plan = {
    id: planId,
    memberId, memberName,
    gymId: gymId || null,
    relatedType, relatedId, itemName,
    // 課程＝最後一堂認列；定期票＝收款日即時（不存 recognitionDate）
    recognitionDate: relatedType === 'course' ? (recognitionDate || null) : null,
    totalAmount,
    installments: periods,
    status: periods.every(p => p.status === 'paid') ? 'completed' : 'active',
    createdBy: staffId,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.INSTALLMENT_PLANS).doc(planId).set(plan);
  // 第一期營收記帳
  if (firstPaymentMethod) {
    try { await recordInstallmentRevenue(db, plan, periods[0], firstPaymentMethod, staffId, staffName); }
    catch (e) { console.error('[分期] 第一期記帳失敗', e.message); }
  }
  return plan;
};

// ── 標記某期已繳款 ────────────────────────────────────────────────
const markInstallmentPaid = async ({ planId, seq, paymentMethod, staffId, staffName }) => {
  if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    throw { code: 'INVALID_PAYMENT_METHOD', message: '付款方式不正確' };
  }
  const db = getDb();
  const ref = db.collection(COLLECTIONS.INSTALLMENT_PLANS).doc(planId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此分期計畫' };

  const plan = doc.data();
  const target = plan.installments.find(i => i.seq === seq);
  if (!target) throw { code: 'INSTALLMENT_NOT_FOUND', message: '找不到此期數' };
  if (target.status === 'paid') throw { code: 'ALREADY_PAID', message: '此期已繳款，無需重複操作' };

  const now = new Date();
  const updatedInstallments = plan.installments.map(i =>
    i.seq === seq ? { ...i, status: 'paid', paidAt: now, paymentMethod, paidBy: staffId } : i
  );
  const allPaid = updatedInstallments.every(i => i.status === 'paid');
  // 仍有其他期逾期/已過到期未繳 → 維持 overdue（避免補一期就解除入場限制）
  const today = dayjs().format('YYYY-MM-DD');
  const stillOverdue = updatedInstallments.some(i =>
    i.status !== 'paid' && (i.status === 'overdue' || i.dueDate < today)
  );

  await ref.update({
    installments: updatedInstallments,
    status: allPaid ? 'completed' : (stillOverdue ? 'overdue' : 'active'),
    updatedAt: now,
  });

  // 本期繳款記帳（進營收/結算）：課程認列最後一堂、定期票收款日
  try {
    const paidPeriod = updatedInstallments.find(i => i.seq === seq);
    await recordInstallmentRevenue(db, { ...plan, installments: updatedInstallments }, paidPeriod, paymentMethod, staffId, staffName);
  } catch (e) { console.error('[分期] 繳款記帳失敗', e.message); }

  return { allPaid, plan: { ...plan, installments: updatedInstallments } };
};

// ── 每日批次：將已過到期日但未繳款的期數標記為逾期 ─────────────────
// （手動觸發版本，未來可接外部排程定時呼叫）
const runOverdueCheck = async () => {
  const db = getDb();
  const today = dayjs().format('YYYY-MM-DD');
  const snap = await db.collection(COLLECTIONS.INSTALLMENT_PLANS)
    .where('status', '==', 'active').get();

  let overdueCount = 0;
  const batch = db.batch();

  snap.docs.forEach(doc => {
    const plan = doc.data();
    let changed = false;
    const updatedInstallments = plan.installments.map(i => {
      if (i.status === 'pending' && i.dueDate < today) {
        changed = true;
        overdueCount++;
        return { ...i, status: 'overdue' };
      }
      return i;
    });
    if (changed) {
      batch.update(doc.ref, {
        installments: updatedInstallments,
        status: 'overdue',
        updatedAt: new Date(),
      });
    }
  });

  await batch.commit();
  return { overdueCount };
};

// ── 每日批次：寄送到期提醒（會員，到期前3天）、逾期通知（會員）、
//             管理員提前預警（到期前7天，站內通知）────────────────
const sendInstallmentReminders = async () => {
  const db = getDb();
  const emailService = require('./emailService');
  const memberService = require('./memberService');
  const today = dayjs().format('YYYY-MM-DD');
  const memberWarningDate = dayjs().add(3, 'day').format('YYYY-MM-DD');
  const adminWarningDate = dayjs().add(7, 'day').format('YYYY-MM-DD');

  const snap = await db.collection(COLLECTIONS.INSTALLMENT_PLANS)
    .where('status', 'in', ['active', 'overdue']).get();

  let reminderSent = 0, overdueSent = 0, adminNotified = 0;

  // 管理員清單只需查一次，所有需要預警的期數共用
  const managersSnap = await db.collection('staff').where('role', 'in', ['super_admin', 'gym_manager']).get();
  const managers = managersSnap.docs.map(d => ({ id: d.id }));
  const notifBatch = db.batch();

  for (const doc of snap.docs) {
    const plan = doc.data();
    let member;
    try { member = await memberService.getMember(plan.memberId); } catch (e) { continue; }

    for (const i of plan.installments) {
      // 管理員提前預警（到期前7天，站內通知，不論會員是否有Email都會發）
      if (i.status === 'pending' && i.dueDate >= today && i.dueDate <= adminWarningDate && !i.adminNotifiedAt) {
        managers.forEach(m => {
          const notifRef = db.collection('notifications').doc();
          notifBatch.set(notifRef, {
            type: 'installment_upcoming', title: '分期付款即將到期',
            message: `${plan.memberName}「${plan.itemName}」第 ${i.seq}/${plan.installments.length} 期將於 ${i.dueDate} 到期（NT$${i.amount.toLocaleString()}）`,
            targetStaffId: m.id, data: { planId: plan.id, seq: i.seq }, isRead: false, createdAt: new Date(),
          });
        });
        i.adminNotifiedAt = new Date();
        adminNotified++;
      }

      if (!member.email) continue;

      // 單筆 Email 失敗只記 log、不中斷整批（不標 sentAt → 下次排程重試），並確保後面 notifBatch 仍會 commit
      if (i.status === 'pending' && i.dueDate >= today && i.dueDate <= memberWarningDate && !i.reminderSentAt) {
        try {
          await emailService.sendInstallmentDueReminder({
            email: member.email, memberName: plan.memberName, itemName: plan.itemName,
            seq: i.seq, totalSeq: plan.installments.length, amount: i.amount, dueDate: i.dueDate,
          });
          i.reminderSentAt = new Date();
          reminderSent++;
        } catch (e) { console.error(`[分期提醒] 到期提醒寄送失敗 plan=${plan.id} seq=${i.seq}`, e.message); }
      }
      if (i.status === 'overdue' && !i.overdueSentAt) {
        try {
          await emailService.sendInstallmentOverdueNotice({
            email: member.email, memberName: plan.memberName, itemName: plan.itemName,
            seq: i.seq, totalSeq: plan.installments.length, amount: i.amount, dueDate: i.dueDate,
          });
          i.overdueSentAt = new Date();
          overdueSent++;
        } catch (e) { console.error(`[分期提醒] 逾期通知寄送失敗 plan=${plan.id} seq=${i.seq}`, e.message); }
      }
    }
    await doc.ref.update({ installments: plan.installments, updatedAt: new Date() });
  }

  if (adminNotified > 0) await notifBatch.commit();

  return { reminderSent, overdueSent, adminNotified };
};

// ── 確認會員是否因分期逾期被限制入場（供 checkinService 呼叫）──────
const hasOverdueInstallment = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.INSTALLMENT_PLANS)
    .where('memberId', '==', memberId)
    .where('status', '==', 'overdue')
    .limit(1).get();
  return !snap.empty;
};

// ── 查詢會員所有分期計畫 ──────────────────────────────────────────
const getMemberInstallmentPlans = async (memberId) => {
  const db = getDb();
  // 不用 .orderBy('createdAt') 搭配 where（需複合索引，正式環境會 FAILED_PRECONDITION）→ 記憶體排序（同 getAllInstallmentPlans）
  const snap = await db.collection(COLLECTIONS.INSTALLMENT_PLANS)
    .where('memberId', '==', memberId)
    .get();
  const plans = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  plans.sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
  return plans;
};

// ── 查詢所有分期計畫（管理端，可篩選狀態）──────────────────────────
const getAllInstallmentPlans = async (status) => {
  const db = getDb();
  let ref = db.collection(COLLECTIONS.INSTALLMENT_PLANS);
  if (status) ref = ref.where('status', '==', status);
  const snap = await ref.get();
  const plans = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  plans.sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
  return plans;
};

module.exports = {
  buildPeriodsFromConfig,
  buildRenewalPeriods,
  createInstallmentPlan,
  markInstallmentPaid,
  runOverdueCheck,
  sendInstallmentReminders,
  hasOverdueInstallment,
  getMemberInstallmentPlans,
  getAllInstallmentPlans,
  VALID_PAYMENT_METHODS,
};
