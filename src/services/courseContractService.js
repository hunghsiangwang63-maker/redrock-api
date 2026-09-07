// ── 課程服務同意書（合約）：報名完成後（僅週課，非工作坊/體驗）自動產生 PDF 並 email 給學員/家長 ──
// 場館基本資料即時讀取 systemSettings/gymContracts（非快照，之後更新館內資料，之後產生的合約自動生效）。
// 全程 try/catch，任何失敗只記 log，絕不阻斷報名本身（比照本專案「寄信/雙寫不阻斷主流程」既有慣例）。
const { getDb, getStorage } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const { isMinor } = require('../utils/age');
const { buildCourseContractPdfBuffer } = require('../utils/courseContractPdf');
const { sendCourseContractPdf } = require('./emailService');

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

// 未成年學員的法定代理人姓名：自助註冊未成年會員存 parentName；子帳號（isChildAccount）則反查家長會員的姓名。
async function resolveGuardianName(db, member) {
  if (!member) return '';
  if (member.parentName) return member.parentName;
  if (member.parentMemberId) {
    try {
      const p = await db.collection('members').doc(member.parentMemberId).get();
      if (p.exists) return p.data().name || '';
    } catch (e) { /* 查無家長資料，維持空白 */ }
  }
  return '';
}

/**
 * @param {object} o
 * @param {string} o.memberId 報名對象 memberId（訪客為 guest_<uuid>）
 * @param {string} o.memberName
 * @param {boolean} [o.isGuest]
 * @param {string} [o.guestEmail]
 * @param {string} [o.guestPhone]
 * @param {string} [o.guestBirthday]
 * @param {object} o.course 課程文件（需含 id/name/startDate/endDate/weekdays）
 * @param {Array}  o.futureSessions 本次報名涵蓋的場次（需含 date/startTime/endTime/gymId）
 * @param {number} o.fee 本次實收金額（已套用會員/續報/隊員等折扣後的最終金額）
 * @param {string} o.paymentMethod
 * @param {object} [o.coursePlan] 分期計畫（installmentService.createInstallmentPlan 回傳值，含 installments[]）
 * @param {number} [o.refundFeeRate] 開課後退費手續費率（header 已存，缺省 fallback 0.2）
 * @param {number} [o.refundPreStartFeeRate] 開課前退費手續費率（缺省 fallback 0）
 * @param {string} o.gymId
 * @param {string} [o.portraitSignature] 學員本人簽名（base64 data URI）
 * @param {string} [o.guardianSignature] 法定代理人簽名（未成年才有）
 * @param {boolean} [o.dryRun] true 時只解析欄位＋產生 PDF 就回傳（不上傳 Storage／不寫 courseContracts／不寄信），
 *   且錯誤會直接 throw 給呼叫端（供預覽/測試用；正式報名流程呼叫時不要帶這個參數）。
 */
const issueCourseContract = async ({
  memberId, memberName, isGuest, guestEmail, guestPhone, guestBirthday,
  course, futureSessions, fee, paymentMethod, coursePlan,
  refundFeeRate, refundPreStartFeeRate, gymId,
  portraitSignature, guardianSignature, dryRun,
}) => {
  const db = getDb();

  const build = async () => {
    const contractSnap = await db.collection('systemSettings').doc('gymContracts').get();
    const gymContract = (contractSnap.exists ? (contractSnap.data() || {}) : {})[gymId] || {};
    // 合約條款文字（2026-09-07 起設定頁可編輯，二館共用）：即時讀取，無設定時 fallback 預設內容
    const { DEFAULT_COURSE_TERMS } = require('../utils/contractTermsDefaults');
    const termsSnap = await db.collection('systemSettings').doc('contractTerms').get();
    const termsData = termsSnap.exists ? termsSnap.data() : {};
    const sections = Array.isArray(termsData.course) ? termsData.course : DEFAULT_COURSE_TERMS;

    let phone = guestPhone || '';
    let email = guestEmail || '';
    let studentIsMinor = false;
    let guardianName = '';

    if (!isGuest) {
      const memberSnap = await db.collection('members').doc(memberId).get();
      const member = memberSnap.exists ? memberSnap.data() : null;
      phone = member?.phone || '';
      email = member?.email || '';
      studentIsMinor = isMinor(member?.birthday);
      if (studentIsMinor) guardianName = await resolveGuardianName(db, member);
    } else {
      studentIsMinor = isMinor(guestBirthday);
      // 訪客報名僅收集簽名檔，無法定代理人姓名文字欄位，維持空白（不臆造）。
    }

    if (!email) {
      console.warn('[課程合約] 無 email 可寄送，僅記錄不寄信：', memberId, course?.name);
    }

    const firstSession = futureSessions[0] || {};
    const weekdayLabel = (course.weekdays || []).map(w => WEEKDAY_LABELS[w]).filter(Boolean).join('、');

    const pdfBuffer = await buildCourseContractPdfBuffer({
      gymContract,
      studentName: memberName,
      guardianName,
      phone,
      vendorName: gymContract.personInCharge || '',
      isMinor: studentIsMinor,
      courseName: course.name,
      startDate: course.startDate,
      endDate: course.endDate,
      weekdayLabel,
      startTime: firstSession.startTime,
      endTime: firstSession.endTime,
      totalSessions: futureSessions.length,
      totalFee: fee,
      paymentMethod,
      installments: coursePlan?.installments || null,
      refundFeeRate,
      refundPreStartFeeRate,
      sections, transferFee: 600,
      portraitSignature: portraitSignature || null,
      guardianSignature: studentIsMinor ? (guardianSignature || null) : null,
    });

    return { pdfBuffer, email };
  };

  if (dryRun) return build(); // 供預覽/測試：不吞錯誤、不觸發任何上傳/寫入/寄信

  try {
    const { pdfBuffer, email } = await build();

    const contractId = uuidv4();
    let pdfUrl = null;
    try {
      const bucket = getStorage().bucket();
      const file = bucket.file(`course-contracts/${contractId}.pdf`);
      await file.save(pdfBuffer, { contentType: 'application/pdf' });
      const [url] = await file.getSignedUrl({ action: 'read', expires: '2035-01-01' });
      pdfUrl = url;
    } catch (e) {
      console.error('[課程合約] 上傳 Storage 失敗（仍會嘗試寄送附件）:', e.message);
    }

    await db.collection('courseContracts').doc(contractId).set({
      id: contractId,
      memberId, memberName, isGuest: !!isGuest,
      courseId: course.id, courseName: course.name, gymId,
      fee, paymentMethod,
      pdfUrl, emailTo: email || null,
      createdAt: new Date(),
    });

    if (email) {
      try {
        await sendCourseContractPdf({ to: email, memberName, courseName: course.name, pdfBuffer });
        await db.collection('courseContracts').doc(contractId).update({ emailedAt: new Date() });
      } catch (e) {
        console.error('[課程合約] 寄信失敗:', e.message);
        await db.collection('courseContracts').doc(contractId).update({ emailError: e.message }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[課程合約] 產生失敗（不影響報名本身）:', e.message);
  }
};

module.exports = { issueCourseContract };
