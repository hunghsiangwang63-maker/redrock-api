/**
 * 系統內通知 Service
 */
const { getDb, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

// ── 建立通知 ────────────────────────────────────────────────────
const createNotification = async ({ gymId, targetRole, targetStaffId, type, title, body, referenceId, referenceType }) => {
  const db = getDb();
  const notifId = uuidv4();
  const now = new Date();

  const notif = {
    id: notifId,
    gymId: gymId || null,
    targetRole: targetRole || null,      // 發給某角色的所有人（gym_manager / super_admin）
    targetStaffId: targetStaffId || null, // 或指定特定 staff
    type,                                 // single_entry_ticket_approval 等
    title,
    body,
    referenceId: referenceId || null,
    referenceType: referenceType || null,
    isRead: false,
    createdAt: now,
  };

  await db.collection(COLLECTIONS.NOTIFICATIONS).doc(notifId).set(notif);
  return notif;
};

// ── 批次通知某館的特定角色 ───────────────────────────────────────
const notifyRoleInGym = async ({ gymId, role, type, title, body, referenceId, referenceType }) => {
  const db = getDb();

  // 找出符合條件的 staff
  let query = db.collection(COLLECTIONS.STAFF).where('isActive', '==', true);

  if (role === 'super_admin') {
    query = query.where('role', '==', 'super_admin');
  } else {
    query = query.where('role', '==', role).where('gymId', '==', gymId);
  }

  const snap = await query.get();
  const staffList = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const promises = staffList.map(staff =>
    createNotification({
      gymId, targetRole: role, targetStaffId: staff.id,
      type, title, body, referenceId, referenceType,
    })
  );

  await Promise.all(promises);
  return staffList.length;
};

// ── 單次入場券審核通知 ───────────────────────────────────────────
const notifySingleEntryTicketApproval = async ({ ticketId, memberName, gymId, issuedByStaffName, notes }) => {
  const title = '單次入場券待審核';
  const body = `${issuedByStaffName} 為會員 ${memberName} 發放了一張單次入場券${notes ? `（備註：${notes}）` : ''}，請於 24 小時內審核。`;

  // 通知同館 gym_manager
  await notifyRoleInGym({
    gymId, role: 'gym_manager',
    type: 'single_entry_ticket_approval',
    title, body,
    referenceId: ticketId,
    referenceType: 'singleEntryTicket',
  });

  // 通知所有 super_admin
  await notifyRoleInGym({
    gymId, role: 'super_admin',
    type: 'single_entry_ticket_approval',
    title, body,
    referenceId: ticketId,
    referenceType: 'singleEntryTicket',
  });
};

// ── 卡片綁定/轉入揭露通知（立即生效，非審核；通知管理員知悉）───────
// kind: 'discount_bind'（轉入優惠卡）| 'black_bind'（黑卡綁定）| 'legacy_discount_bind'（舊優惠卡綁定/拍照歸檔）
const _BIND_LABELS = { discount_bind: '優惠卡轉入', black_bind: '黑卡綁定', legacy_discount_bind: '舊優惠卡綁定' };
const _BIND_REFS = { discount_bind: 'discountCard', black_bind: 'blackCard', legacy_discount_bind: 'legacyDiscountCard' };
const notifyCardBindDisclosure = async ({ kind, memberName, gymId, staffName, detail, referenceId }) => {
  const label = _BIND_LABELS[kind] || '卡片綁定';
  const title = `${label}揭露`;
  const body = `${staffName || '館別電腦'} 為會員 ${memberName} 進行了${label}${detail ? `（${detail}）` : ''}。`;
  const type = `${kind}_disclosure`;
  const referenceType = _BIND_REFS[kind] || null;
  await notifyRoleInGym({ gymId, role: 'gym_manager', type, title, body, referenceId: referenceId || null, referenceType });
  await notifyRoleInGym({ gymId, role: 'super_admin', type, title, body, referenceId: referenceId || null, referenceType });
};

// ── 取得未讀通知 ────────────────────────────────────────────────
const getUnreadNotifications = async (staffId, gymId, role) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.NOTIFICATIONS)
    .where('targetStaffId', '==', staffId)
    .where('isRead', '==', false)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

// ── 標記已讀 ────────────────────────────────────────────────────
const markAsRead = async (notifId) => {
  const db = getDb();
  await db.collection(COLLECTIONS.NOTIFICATIONS).doc(notifId).update({
    isRead: true,
    readAt: new Date(),
  });
};

// ── 標記全部已讀 ────────────────────────────────────────────────
const markAllAsRead = async (staffId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.NOTIFICATIONS)
    .where('targetStaffId', '==', staffId)
    .where('isRead', '==', false)
    .get();
  const batch = db.batch();
  snap.docs.forEach(doc => batch.update(doc.ref, { isRead: true, readAt: new Date() }));
  await batch.commit();
  return snap.size;
};

module.exports = {
  createNotification,
  notifyRoleInGym,
  notifySingleEntryTicketApproval,
  notifyCardBindDisclosure,
  getUnreadNotifications,
  markAsRead,
  markAllAsRead,
};
