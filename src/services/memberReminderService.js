/**
 * 會員首頁自訂提醒 Service
 *
 * 需求：員工可針對特定會員（或某場比賽的全部正取報名者）手動新增/編輯/刪除一則
 * 顯示在會員 App 首頁「課程活動提醒」清單裡的自訂卡片（標題/副標/圖示/圖片/連結/顯示期間），
 * 與系統自動產生的課程/體驗提醒混在同一份清單中、依日期排序顯示。
 *
 * 與課程/體驗提醒不同：這裡完全是店員手動維護的內容，系統不會自動產生或更新。
 */
const { getDb } = require('../config/firebase');
const { taiwanToday } = require('../utils/taiwanDate');
const { v4: uuidv4 } = require('uuid');

const COLLECTION = 'memberHomeReminders';

// 建立一則提醒
async function createReminder({ memberId, title, subtitle, icon, link, imageUrl, showFrom, showUntil, staffId, staffName }) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date();
  const data = {
    memberId,
    title: (title || '').trim(),
    subtitle: (subtitle || '').trim() || null,
    icon: (icon || '').trim() || '📣',
    link: (link || '').trim() || null,
    imageUrl: (imageUrl || '').trim() || null,
    showFrom: showFrom || null,
    showUntil: showUntil || null,
    createdBy: staffId || null,
    createdByName: staffName || null,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(COLLECTION).doc(id).set(data);
  return { id, ...data };
}

// 更新一則提醒（僅允許改內容/顯示期間，不改 memberId）
async function updateReminder(id, { title, subtitle, icon, link, imageUrl, showFrom, showUntil, staffId, staffName }) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    const err = new Error('提醒不存在'); err.code = 'REMINDER_NOT_FOUND'; throw err;
  }
  const updates = { updatedAt: new Date(), updatedBy: staffId || null, updatedByName: staffName || null };
  if (title !== undefined) updates.title = (title || '').trim();
  if (subtitle !== undefined) updates.subtitle = (subtitle || '').trim() || null;
  if (icon !== undefined) updates.icon = (icon || '').trim() || '📣';
  if (link !== undefined) updates.link = (link || '').trim() || null;
  if (imageUrl !== undefined) updates.imageUrl = (imageUrl || '').trim() || null; // 空字串＝移除圖片
  if (showFrom !== undefined) updates.showFrom = showFrom || null;
  if (showUntil !== undefined) updates.showUntil = showUntil || null;
  await ref.update(updates);
  return { id, ...doc.data(), ...updates };
}

async function deleteReminder(id) {
  const db = getDb();
  await db.collection(COLLECTION).doc(id).delete();
}

// 員工端管理清單：某會員的全部提醒（含已過期/未來），依建立時間新到舊
async function getRemindersForMember(memberId) {
  const db = getDb();
  const snap = await db.collection(COLLECTION).where('memberId', '==', memberId).get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
}

// 會員端首頁：只回在顯示期間內的提醒，依 showFrom（無則用 createdAt）排序
async function getActiveRemindersForMember(memberId) {
  const today = taiwanToday();
  const all = await getRemindersForMember(memberId);
  return all
    .filter(r => (!r.showFrom || r.showFrom <= today) && (!r.showUntil || r.showUntil >= today))
    .sort((a, b) => (a.showFrom || '0000-00-00').localeCompare(b.showFrom || '0000-00-00'));
}

// 批次推播共用：對一批 memberId 各建一則相同內容的提醒（單一 batch commit，Firestore 上限 500 筆一批已足夠）
async function batchCreateForMembers(memberIds, payload, staff, sourceType, sourceId, defaultIcon) {
  if (memberIds.length === 0) return { count: 0 };
  const db = getDb();
  const batch = db.batch();
  const now = new Date();
  memberIds.forEach(memberId => {
    const id = uuidv4();
    batch.set(db.collection(COLLECTION).doc(id), {
      memberId,
      title: (payload.title || '').trim(),
      subtitle: (payload.subtitle || '').trim() || null,
      icon: (payload.icon || '').trim() || defaultIcon,
      link: (payload.link || '').trim() || null,
      imageUrl: (payload.imageUrl || '').trim() || null,
      showFrom: payload.showFrom || null,
      showUntil: payload.showUntil || null,
      sourceType,
      sourceId,
      createdBy: staff?.id || null,
      createdByName: staff?.name || null,
      createdAt: now,
      updatedAt: now,
    });
  });
  await batch.commit();
  return { count: memberIds.length };
}

// 批次推播：對某場比賽目前有效（非取消）報名的每位會員各建一則相同內容的提醒
async function broadcastToCompetitionRegistrants(competitionId, payload, staff) {
  const db = getDb();
  // 單一等值查詢 + 記憶體過濾（避免與 status 組合觸發複合索引需求，比照專案慣例）
  const snap = await db.collection('competitionRegistrations')
    .where('competitionId', '==', competitionId)
    .select('memberId', 'status')
    .get();
  const memberIds = [...new Set(
    snap.docs
      .map(d => d.data())
      .filter(r => r.status !== 'cancelled')
      .map(r => r.memberId)
      .filter(Boolean)
  )];
  return batchCreateForMembers(memberIds, payload, staff, 'competition_broadcast', competitionId, '🏆');
}

// 批次推播：對某梯次課程目前正取的常態學員（confirmed/leave，排除補課/試上/候補/已取消）各建一則相同內容的提醒
async function broadcastToCourseEnrollees(courseId, payload, staff) {
  const db = getDb();
  const snap = await db.collection('courseEnrollments')
    .where('courseId', '==', courseId)
    .select('memberId', 'status', 'isMakeup', 'isTrial')
    .get();
  const memberIds = [...new Set(
    snap.docs
      .map(d => d.data())
      .filter(e => !e.isMakeup && !e.isTrial && (e.status === 'confirmed' || e.status === 'leave'))
      .map(e => e.memberId)
      .filter(Boolean)
  )];
  return batchCreateForMembers(memberIds, payload, staff, 'course_broadcast', courseId, '📚');
}

module.exports = {
  createReminder,
  updateReminder,
  deleteReminder,
  getRemindersForMember,
  getActiveRemindersForMember,
  broadcastToCompetitionRegistrants,
  broadcastToCourseEnrollees,
};
