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
const notifySingleEntryTicketApproval = async ({ ticketId, memberName, gymId, issuedByStaffName }) => {
  const title = '單次入場券待審核';
  const body = `${issuedByStaffName} 為會員 ${memberName} 發放了一張單次入場券，請於 24 小時內審核。`;

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
  getUnreadNotifications,
  markAsRead,
  markAllAsRead,
};
