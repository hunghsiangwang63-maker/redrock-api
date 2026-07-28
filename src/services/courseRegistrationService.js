// ── 課程報名 header（雙寫過渡階段）─────────────────────────────────
// 目的：把目前散落在「N 筆 courseEnrollments（每場次一筆）」裡、只掛在隱性 idx===0
// 那筆的「報名層級」資料（費用/付款/健康備註/簽名/規則確認…）搬到一個獨立實體。
//
// 現階段（Phase 1／雙寫）：這個集合只被「寫入」，尚未有任何讀取路徑依賴它。
// courseEnrollments（含快照欄位）維持原樣繼續寫、繼續被全系統讀取，行為零改動。
// 之後逐步把讀取路徑切過來時，才會開始真正影響功能——現在純粹是為了驗證新模型
// 在真實寫入情境下的正確性，不影響任何既有功能。
//
// header 代表「一次報名」整體：memberId+courseId 一組（可能因取消後重報而有多筆歷史 header）。
const { v4: uuidv4 } = require('uuid');

const REGISTRATION_COLLECTION = 'courseRegistrations';

/**
 * 建立報名 header。呼叫端在寫入 courseEnrollments 的同時呼叫本函式，
 * 傳入本次報名的「報名層級」資料（不含各場次的 date/startTime 等）。
 * sourceEnrollmentIds：本次報名對應的 courseEnrollments 文件 id 陣列，供雙寫期比對驗證用。
 */
const createRegistrationHeader = async (db, data) => {
  const id = uuidv4();
  const now = new Date();
  const header = {
    id,
    memberId: data.memberId,
    memberName: data.memberName || '',
    courseId: data.courseId,
    courseName: data.courseName || '',
    gymId: data.gymId || null,
    status: data.status || 'confirmed', // confirmed | waitlist | cancelled
    paymentMethod: data.paymentMethod || null,
    paymentStatus: data.paymentStatus || null,
    fee: data.fee != null ? data.fee : 0,
    originalFee: data.originalFee != null ? data.originalFee : null,
    renewalDiscount: data.renewalDiscount || null,
    renewalDiscountType: data.renewalDiscountType || null,
    teamDiscountApplied: !!data.teamDiscountApplied,
    installmentPlanId: data.installmentPlanId || null,
    healthNote: data.healthNote || null,
    referralSource: data.referralSource || null,
    enrollNote: data.enrollNote || null,
    enrollGender: data.enrollGender || null,
    enrollAge: data.enrollAge != null ? data.enrollAge : null,
    confirmedLeavePolicy: !!data.confirmedLeavePolicy,
    confirmedRefundPolicy: !!data.confirmedRefundPolicy,
    portraitSignature: data.portraitSignature || null,
    guardianSignature: data.guardianSignature || null,
    waitlistPosition: data.waitlistPosition != null ? data.waitlistPosition : null,
    paymentDeadline: data.paymentDeadline || null,
    sessionCount: data.sessionCount != null ? data.sessionCount : null,
    sourceEnrollmentIds: data.sourceEnrollmentIds || [],
    enrolledBy: data.enrolledBy || data.memberId,
    enrolledAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(REGISTRATION_COLLECTION).doc(id).set(header);
  return header;
};

/**
 * 依 memberId+courseId 找到目前有效（confirmed/waitlist）的 header 並更新狀態。
 * 用於取消整筆報名 / 轉帳確認收款等連動更新。冪等：查無 header 不視為錯誤（雙寫剛起步、舊資料尚無 header 屬正常）。
 */
const updateRegistrationStatusByCourseMember = async (db, memberId, courseId, updates) => {
  const snap = await db.collection(REGISTRATION_COLLECTION)
    .where('memberId', '==', memberId)
    .where('courseId', '==', courseId)
    .where('status', 'in', ['confirmed', 'waitlist'])
    .get();
  if (snap.empty) return 0;
  const now = new Date();
  const batch = db.batch();
  snap.docs.forEach(d => batch.update(d.ref, { ...updates, updatedAt: now }));
  await batch.commit();
  return snap.size;
};

module.exports = {
  REGISTRATION_COLLECTION,
  createRegistrationHeader,
  updateRegistrationStatusByCourseMember,
};
