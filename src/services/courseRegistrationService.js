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
    pauseStatus: data.pauseStatus || null, // null | 'paused'（與 courseEnrollments 對應欄位同步，見 updateHeaderPauseStatus）
    paymentMethod: data.paymentMethod || null,
    paymentStatus: data.paymentStatus || null,
    fee: data.fee != null ? data.fee : 0,
    originalFee: data.originalFee != null ? data.originalFee : null,
    renewalDiscount: data.renewalDiscount || null,
    renewalDiscountType: data.renewalDiscountType || null,
    renewalRate: data.renewalRate ?? null,
    teamDiscountApplied: !!data.teamDiscountApplied,
    teamDiscount: data.teamDiscount || null,
    feeCalcNote: data.feeCalcNote || null, // 計算過程文字（單一折扣擇優結果），供確認收款畫面顯示
    installmentPlanId: data.installmentPlanId || null,
    healthNote: data.healthNote || null,
    staffNote: data.staffNote || null, // 管理員收款確認時填的內部備註（會員看不到）
    memberPaidAmount: data.memberPaidAmount ?? null, // 會員自填實際匯款金額（/transfers/upload）
    bankLastFive: data.bankLastFive || null,
    paymentDate: data.paymentDate || null,
    paymentConfirmed: data.paymentConfirmed !== false, // 預設 true（未明確標記為 false 即視為未被退回狀態）
    receivedAmountOverride: data.receivedAmountOverride ?? null, // 管理員在課程學員頁直接編修的實收金額
    // 扛費用/可被 PUT /course-enrollments/:enrollmentId/received-amount 編修的那筆 courseEnrollments doc id
    // （沿用現行「編修目標仍是 enrollment 文件」的設計，header 只是提供穩定的顯示/查詢入口）
    payEnrollmentId: data.payEnrollmentId || (data.sourceEnrollmentIds || [])[0] || null,
    referralSource: data.referralSource || null,
    enrollNote: data.enrollNote || null,
    enrollGender: data.enrollGender || null,
    enrollAge: data.enrollAge != null ? data.enrollAge : null,
    confirmedLeavePolicy: !!data.confirmedLeavePolicy,
    confirmedExtensionPolicy: !!data.confirmedExtensionPolicy,
    confirmedRefundPolicy: !!data.confirmedRefundPolicy,
    confirmedContractTerms: !!data.confirmedContractTerms, // 已詳閱同意合約完整條款（僅週課報名步驟出現，2026-09-06 新增）

    portraitSignature: data.portraitSignature || null,
    guardianSignature: data.guardianSignature || null,
    waitlistPosition: data.waitlistPosition != null ? data.waitlistPosition : null,
    paymentDeadline: data.paymentDeadline || null,
    sessionCount: data.sessionCount != null ? data.sessionCount : null,
    sourceEnrollmentIds: data.sourceEnrollmentIds || [],
    enrolledBy: data.enrolledBy || data.memberId,
    isGuest: !!data.isGuest,
    contactPhone: data.contactPhone || null,
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

/**
 * 同步暫停狀態到 header（courseAdjustments.js 的暫停核准／恢復兩處呼叫）。
 * 找該 memberId+courseId 目前有效（confirmed/waitlist）的 header，寫入 pauseStatus。
 * 冪等、查無 header 不視為錯誤（雙寫期舊資料尚無 header 屬正常）。
 */
const updateHeaderPauseStatus = async (db, memberId, courseId, pauseStatus) => {
  const snap = await db.collection(REGISTRATION_COLLECTION)
    .where('memberId', '==', memberId)
    .where('courseId', '==', courseId)
    .where('status', 'in', ['confirmed', 'waitlist'])
    .get();
  if (snap.empty) return 0;
  const now = new Date();
  const batch = db.batch();
  snap.docs.forEach(d => batch.update(d.ref, { pauseStatus: pauseStatus || null, updatedAt: now }));
  await batch.commit();
  return snap.size;
};

/**
 * 查一批報名 header 的「payEnrollmentId」對應的店員核對收款金額（transferRecords.confirmedAmount）
 * 與最新一筆匯款證明（末五碼/銀行/日期）。
 *
 * 2026-09-12 清查發現：這段「查 transferRecords → 取每個 refId 最新一筆 confirmed 金額／最新一筆
 * 證明」的迴圈邏輯在 members.js（課程學員報表）／courses.js（單一課程報名名單）／checkin.js
 * （今日課程學員發票資料）三處各自獨立實作，改一處忘了同步另一處會讓不同入口顯示不同金額。
 * 收斂成這支共用函式，三處都改呼叫它。
 *
 * @param {object} db
 * @param {string[]} enrollIds  header.payEnrollmentId 的集合（會自動去重、過濾空值）
 * @returns {Promise<{confirmedMap: object, proofMap: object}>}
 *   confirmedMap[enrollId] = { amount, at }；proofMap[enrollId] = { bankLastFive, bankName, paymentDate, at }
 */
const getTransferConfirmationData = async (db, enrollIds) => {
  const ids = [...new Set((enrollIds || []).filter(Boolean))];
  const confirmedMap = {};
  const proofMap = {};
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    if (!chunk.length) break;
    const snap = await db.collection('transferRecords').where('refId', 'in', chunk).get();
    snap.docs.forEach(d => {
      const t = d.data();
      if (t.status === 'confirmed' && t.confirmedAmount != null) {
        const at = t.confirmedAt?._seconds || t.confirmedAt?.seconds || 0;
        const prev = confirmedMap[t.refId];
        if (!prev || at >= prev.at) confirmedMap[t.refId] = { amount: Number(t.confirmedAmount), at };
      }
      if (t.bankLastFive || t.paymentDate) {
        const at2 = t.submittedAt?._seconds || t.submittedAt?.seconds || t.createdAt?._seconds || t.createdAt?.seconds || 0;
        const prev2 = proofMap[t.refId];
        if (!prev2 || at2 >= prev2.at) proofMap[t.refId] = { bankLastFive: t.bankLastFive || '', bankName: t.bankName || '', paymentDate: t.paymentDate || '', at: at2 };
      }
    });
  }
  return { confirmedMap, proofMap };
};

/**
 * 「實收金額」最終採用值的單一優先序（唯一權威）：
 * 管理員直接編修(receivedAmountOverride) > 店員核對(confirmedAmount) > 會員自報(memberPaidAmount)
 * > 報名應繳費用(fee)。三個消費端（members.js/courses.js/checkin.js）都改呼叫這支函式，
 * 避免各自手刻同一條 `a ?? b ?? c ?? d ?? 0` 公式、日後調整優先序時漏改其中一處。
 */
const resolveReceivedAmount = ({ receivedAmountOverride, confirmedAmount, memberPaidAmount, fee }) =>
  receivedAmountOverride ?? confirmedAmount ?? memberPaidAmount ?? fee ?? 0;

module.exports = {
  REGISTRATION_COLLECTION,
  createRegistrationHeader,
  updateRegistrationStatusByCourseMember,
  updateHeaderPauseStatus,
  getTransferConfirmationData,
  resolveReceivedAmount,
};
