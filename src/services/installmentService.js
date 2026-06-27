/**
 * 分期付款 Service
 *
 * 規則：
 * - 適用範圍：課程報名、定期票購買
 * - 期數與每期金額自由輸入（不限平均分攤）
 * - 收款方式：linepay / jkopay / taiwanpay / transfer / cash（館方人工記帳，非自動扣款）
 * - 逾期未繳當期款項 → 暫停入場資格，並寄送Email提醒/逾期通知
 */
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');

const VALID_PAYMENT_METHODS = ['linepay', 'jkopay', 'taiwanpay', 'transfer', 'cash'];

// ── 建立分期付款計畫 ──────────────────────────────────────────────
const createInstallmentPlan = async ({ memberId, memberName, relatedType, relatedId, itemName, installments, staffId }) => {
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

  const plan = {
    id: planId,
    memberId, memberName,
    relatedType, relatedId, itemName,
    totalAmount,
    installments: installments.map((i, idx) => ({
      seq: idx + 1,
      amount: i.amount,
      dueDate: i.dueDate,
      status: idx === 0 ? 'pending' : 'pending', // 第一期通常當下立即收款，由前端呼叫 markPaid 標記
      paidAt: null,
      paymentMethod: null,
      note: i.note || '',
    })),
    status: 'active',
    createdBy: staffId,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.INSTALLMENT_PLANS).doc(planId).set(plan);
  return plan;
};

// ── 標記某期已繳款 ────────────────────────────────────────────────
const markInstallmentPaid = async ({ planId, seq, paymentMethod, staffId }) => {
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
//             管理員提前預警（到期前14天，站內通知）────────────────
const sendInstallmentReminders = async () => {
  const db = getDb();
  const emailService = require('./emailService');
  const memberService = require('./memberService');
  const today = dayjs().format('YYYY-MM-DD');
  const memberWarningDate = dayjs().add(3, 'day').format('YYYY-MM-DD');
  const adminWarningDate = dayjs().add(14, 'day').format('YYYY-MM-DD');

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
      // 管理員提前預警（到期前14天，站內通知，不論會員是否有Email都會發）
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

      if (i.status === 'pending' && i.dueDate >= today && i.dueDate <= memberWarningDate && !i.reminderSentAt) {
        await emailService.sendInstallmentDueReminder({
          email: member.email, memberName: plan.memberName, itemName: plan.itemName,
          seq: i.seq, totalSeq: plan.installments.length, amount: i.amount, dueDate: i.dueDate,
        });
        i.reminderSentAt = new Date();
        reminderSent++;
      }
      if (i.status === 'overdue' && !i.overdueSentAt) {
        await emailService.sendInstallmentOverdueNotice({
          email: member.email, memberName: plan.memberName, itemName: plan.itemName,
          seq: i.seq, totalSeq: plan.installments.length, amount: i.amount, dueDate: i.dueDate,
        });
        i.overdueSentAt = new Date();
        overdueSent++;
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
  const snap = await db.collection(COLLECTIONS.INSTALLMENT_PLANS)
    .where('memberId', '==', memberId)
    .orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
  createInstallmentPlan,
  markInstallmentPaid,
  runOverdueCheck,
  sendInstallmentReminders,
  hasOverdueInstallment,
  getMemberInstallmentPlans,
  getAllInstallmentPlans,
  VALID_PAYMENT_METHODS,
};
