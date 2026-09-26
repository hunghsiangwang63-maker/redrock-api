/**
 * 墜落測驗共用邏輯
 * 讓「登記測驗結果」在 fallTests 路由與 fallTestBookings 路由間共用一份程式；
 * 亦讓「簽署墜落測驗同意書」在 routes/fallTests.js（單獨簽署）與 waiverService.signEntryDocs
 * （2026-09-26 合併簽署，一次簽名同時完成風險安全聲明書＋墜測同意書）間共用同一份寫入邏輯。
 */
const { getDb } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const memberService = require('./memberService');

// 取得測驗設定
const getFallTestSettings = async (db) => {
  const doc = await db.collection('systemSettings').doc('fallTest').get();
  return doc.exists ? doc.data() : {
    requiredCheckins: 2,
    validYears: 1,
    youtubeUrl: '',
    watchPercentRequired: 90,
    contentZh: '',
    contentEn: '',
  };
};

/**
 * 工作人員登記墜落測驗結果（passed / failed）。
 * passed 前先驗證已簽署同意書；通過則更新 member 效期並重算封鎖狀態。
 *
 * @returns {Promise<object>} 建立的 fallTests 文件
 * @throws  帶 { status, code, message } 的 Error（呼叫端可據此回應）
 */
async function recordFallTestResult({ memberId, result, notes, staffId, staffName, gymId }) {
  const db = getDb();
  if (!memberId || !result) {
    const e = new Error('缺少必要欄位'); e.status = 400; e.code = 'MISSING_FIELDS'; throw e;
  }
  if (!['passed', 'failed'].includes(result)) {
    const e = new Error('結果須為 passed 或 failed'); e.status = 400; e.code = 'INVALID_RESULT'; throw e;
  }

  // 未簽署同意書不可登記通過——例外：小蜘蛛人週課正式學員未完成簽署，仍可先登記通過測驗
  // （2026-09-02 政策，比照入場端的免墜測例外，同一套 hasSpiderCourseAccess 判斷）
  if (result === 'passed') {
    const sigSnap = await db.collection('fallTestSignatures')
      .where('memberId', '==', memberId).select().limit(1).get();
    if (sigSnap.empty) {
      // gymId 有帶就限定該館（較嚴謹）；沒帶（如 super_admin 無固定館別）則不分館檢查，
      // 避免無法判斷館別的呼叫端（見 routes/fallTests.js req.staff.gymId 可能為 null）誤擋
      const { hasSpiderCourseAccess } = require('./checkin/gates');
      const isSpiderStudent = await hasSpiderCourseAccess(memberId, gymId || null);
      if (!isSpiderStudent) {
        const e = new Error('此會員尚未簽署墜落測驗同意書，無法登記為通過');
        e.status = 400; e.code = 'SIGNATURE_REQUIRED'; throw e;
      }
    }
  }

  const settings = await getFallTestSettings(db);
  const now = dayjs();
  const expiresAt = now.add(settings.validYears || 1, 'year').toDate();

  const testId = uuidv4();
  const test = {
    id: testId,
    memberId,
    result, // 'passed' | 'failed'
    testedBy: staffId,
    testedByName: staffName,
    testedAt: now.toDate(),
    expiresAt: result === 'passed' ? expiresAt : null,
    notes: notes || '',
  };
  await db.collection('fallTests').doc(testId).set(test);

  if (result === 'passed') {
    await db.collection('members').doc(memberId).update({
      fallTestPassed: true,
      fallTestExpiresAt: expiresAt,
      updatedAt: new Date(),
    });
    // 正確重算封鎖狀態（清 fall_test_required，保留 waiver 等其他未完成關卡）
    await memberService.refreshBlockStatus(memberId);
  }

  return test;
}

// ── 是否已有墜測同意書簽署紀錄（不分是否通過測驗）─────────────────────
async function hasConsentSignature(memberId) {
  const db = getDb();
  const snap = await db.collection('fallTestSignatures').where('memberId', '==', memberId).select().limit(1).get();
  return !snap.empty;
}

/**
 * 簽署墜落測驗同意書（原內文自 routes/fallTests.js POST /sign 抽出，純搬移、行為不變）。
 * 供①原本的獨立簽署端點（員工協助個別重簽等修復情境）②合併簽署端點（waiverService.signEntryDocs）共用。
 *
 * @throws 帶 { status, code, message } 的 Error（呼叫端據此回應／略過）
 */
async function signConsent({ memberId, signatureData, watchPercent, agreedParagraphs, isMinor }) {
  const db = getDb();
  const settings = await getFallTestSettings(db);

  if (!(watchPercent >= settings.watchPercentRequired)) {
    const e = new Error(`請觀看至少 ${settings.watchPercentRequired}% 的影片`); e.status = 400; e.code = 'INSUFFICIENT_WATCH'; throw e;
  }
  if (!agreedParagraphs || !Array.isArray(agreedParagraphs) || agreedParagraphs.length === 0) {
    const e = new Error('請閱讀並勾選所有條款後再簽署'); e.status = 400; e.code = 'MISSING_AGREEMENT'; throw e;
  }

  // 避免重複建立：已有簽署紀錄的會員（含合併簽署時另一份文件才是真正缺項的情況）不再疊加新的一筆
  if (await hasConsentSignature(memberId)) {
    return { skipped: true, reason: 'already_signed' };
  }

  const signId = uuidv4();
  await db.collection('fallTestSignatures').doc(signId).set({
    id: signId,
    memberId,
    signatureData: signatureData || '',
    watchPercent,
    agreedParagraphs,
    contentSnapshot: {
      zh: settings.contentZh || '',
      en: settings.contentEn || '',
    },
    parentRequired: !!isMinor,        // 未成年需家長遠端簽名
    guardianSignatureData: null,      // 家長簽名（遠端 email 簽署時回填）
    guardianName: null,
    guardianSignedAt: null,
    signedAt: new Date(),
  });

  // 未成年：本人墜測同意書簽完 → 觸發統一家長簽署 email（waiver 也簽完才會真的寄）
  if (isMinor) {
    try { await require('./waiverService').maybeSendParentSignEmail(memberId); }
    catch (e) { console.error('墜測同意書觸發家長 email 失敗（簽署已保存）:', e.message); }
  }

  return { signatureId: signId, skipped: false };
}

module.exports = { getFallTestSettings, recordFallTestResult, signConsent, hasConsentSignature };
