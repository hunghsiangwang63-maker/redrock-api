// ── 定期票服務同意書（合約）：買定期票（buy_pass）或線上續約（pass_renewal）完成後自動產生 PDF
// 並 email 給會員/家長——比照 courseContractService.js 同一套模式。
// 場館基本資料即時讀取 systemSettings/gymContracts（非快照，之後更新館內資料，之後產生的合約自動生效）。
// 全程 try/catch，任何失敗只記 log，絕不阻斷入場/續約本身（比照本專案「寄信/雙寫不阻斷主流程」既有慣例）。
const { getDb, getStorage } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const { isMinor } = require('../utils/age');
const { buildPassContractPdfBuffer } = require('../utils/passContractPdf');
const { sendPassContractPdf } = require('./emailService');

// 未成年會員的法定代理人姓名：自助註冊未成年會員存 parentName；子帳號（isChildAccount）則反查家長會員的姓名。
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
 * @param {string} o.memberId 定期票持有人 memberId
 * @param {string} o.memberName
 * @param {string} o.passTypeName
 * @param {string} o.scope 'shared'（全館）或單館 scope
 * @param {string} [o.targetGymId] 單館票的限定館別
 * @param {string} o.startDate
 * @param {string} o.endDate
 * @param {number} o.fee 本次實付金額（買票原價或續約折後價）
 * @param {string} o.paymentMethod
 * @param {string} o.gymId 產生合約時參照的場館合約基本資料（買票/續約當下所在館別）
 * @param {string} [o.portraitSignature] 本人簽名（base64 data URI）
 * @param {string} [o.guardianSignature] 法定代理人簽名（未成年才有）
 * @param {boolean} [o.dryRun] true 時只解析欄位＋產生 PDF 就回傳（不上傳 Storage／不寫 passContracts／不寄信），
 *   且錯誤會直接 throw 給呼叫端（供預覽/測試用；正式流程呼叫時不要帶這個參數）。
 */
const issuePassContract = async ({
  memberId, memberName, passTypeName, scope, targetGymId, startDate, endDate,
  fee, paymentMethod, gymId, portraitSignature, guardianSignature, installments, dryRun,
}) => {
  const db = getDb();

  const build = async () => {
    const contractSnap = await db.collection('systemSettings').doc('gymContracts').get();
    const gymContract = (contractSnap.exists ? (contractSnap.data() || {}) : {})[gymId] || {};
    // 合約條款文字（2026-09-07 起設定頁可編輯，二館共用）：即時讀取，無設定時 fallback 預設內容
    const { DEFAULT_PASS_TERMS } = require('../utils/contractTermsDefaults');
    const termsSnap = await db.collection('systemSettings').doc('contractTerms').get();
    const termsData = termsSnap.exists ? termsSnap.data() : {};
    const termsText = typeof termsData.pass === 'string' && termsData.pass ? termsData.pass : DEFAULT_PASS_TERMS;

    const memberSnap = await db.collection('members').doc(memberId).get();
    const member = memberSnap.exists ? memberSnap.data() : null;
    const phone = member?.phone || '';
    const email = member?.email || '';
    const memberIsMinor = isMinor(member?.birthday);
    const guardianName = memberIsMinor ? await resolveGuardianName(db, member) : '';

    if (!email) {
      console.warn('[定期票合約] 無 email 可寄送，僅記錄不寄信：', memberId, passTypeName);
    }

    const pdfBuffer = await buildPassContractPdfBuffer({
      gymContract,
      memberName,
      guardianName,
      phone,
      vendorName: gymContract.personInCharge || '',
      isMinor: memberIsMinor,
      passTypeName, scope, targetGymId, startDate, endDate,
      totalFee: fee,
      paymentMethod,
      installments: installments || null, // 分期購買時列「按月逐月繳」期別表，比照課程合約（2026-09-07）
      termsText, refundFee: 600, transferFee: 600,
      portraitSignature: portraitSignature || null,
      guardianSignature: memberIsMinor ? (guardianSignature || null) : null,
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
      const file = bucket.file(`pass-contracts/${contractId}.pdf`);
      await file.save(pdfBuffer, { contentType: 'application/pdf' });
      const [url] = await file.getSignedUrl({ action: 'read', expires: '2035-01-01' });
      pdfUrl = url;
    } catch (e) {
      console.error('[定期票合約] 上傳 Storage 失敗（仍會嘗試寄送附件）:', e.message);
    }

    await db.collection('passContracts').doc(contractId).set({
      id: contractId,
      memberId, memberName,
      passTypeName, scope, targetGymId: targetGymId || null, gymId,
      fee, paymentMethod,
      pdfUrl, emailTo: email || null,
      createdAt: new Date(),
    });

    if (email) {
      try {
        await sendPassContractPdf({ to: email, memberName, passTypeName, pdfBuffer });
        await db.collection('passContracts').doc(contractId).update({ emailedAt: new Date() });
      } catch (e) {
        console.error('[定期票合約] 寄信失敗:', e.message);
        await db.collection('passContracts').doc(contractId).update({ emailError: e.message }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[定期票合約] 產生失敗（不影響入場/續約本身）:', e.message);
  }
};

module.exports = { issuePassContract };
