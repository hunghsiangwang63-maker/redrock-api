/**
 * 墜落測驗共用邏輯
 * 讓「登記測驗結果」在 fallTests 路由與 fallTestBookings 路由間共用一份程式。
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
async function recordFallTestResult({ memberId, result, notes, staffId, staffName }) {
  const db = getDb();
  if (!memberId || !result) {
    const e = new Error('缺少必要欄位'); e.status = 400; e.code = 'MISSING_FIELDS'; throw e;
  }
  if (!['passed', 'failed'].includes(result)) {
    const e = new Error('結果須為 passed 或 failed'); e.status = 400; e.code = 'INVALID_RESULT'; throw e;
  }

  // 未簽署同意書不可登記通過
  if (result === 'passed') {
    const sigSnap = await db.collection('fallTestSignatures')
      .where('memberId', '==', memberId).limit(1).get();
    if (sigSnap.empty) {
      const e = new Error('此會員尚未簽署墜落測驗同意書，無法登記為通過');
      e.status = 400; e.code = 'SIGNATURE_REQUIRED'; throw e;
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

module.exports = { getFallTestSettings, recordFallTestResult };
