/**
 * Waiver Service
 */
const { getDb, getStorage, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

// ── 簽名圖：內嵌 base64 存 Firestore（消除 Firebase Storage 硬依賴）────────
// 早期版本上傳 Firebase Storage；但 Storage 在部署環境取 token 會失敗（oauth2 token
// 錯誤），且上傳在寫入 waiver 文件之前 → 整個簽署 throw、完全沒建 waiver 記錄，
// 卡死新會員入場前置流程。比照會員 QR（1.x「移除 QR 上傳 Storage」）改為直接內嵌
// base64 data URL：簽名屬個資，存 Firestore 私有文件即可，顯示時 <img> 直接吃 data URL
// （signFields 對 data:/http 值原樣放行）。舊資料的 Storage 路徑仍由 signFields 正常簽名。
const uploadSignature = async (memberId, type, base64Data) => {
  if (!base64Data || typeof base64Data !== 'string') return '';
  return base64Data.startsWith('data:')
    ? base64Data
    : `data:image/png;base64,${base64Data.replace(/^data:image\/\w+;base64,/, '')}`;
};

// ── 建立/更新 Waiver ─────────────────────────────────────────────
const signWaiver = async ({ memberId, memberName, isMinor, isChildAccount, signatureData, parentEmail, parentName, parentPhone, parentRelation, staffId, ip }) => {
  const db = getDb();

  // 檢查是否已簽（鎖定後不可修改）
  const existing = await db.collection(COLLECTIONS.WAIVERS).doc(memberId).get();
  if (existing.exists && existing.data().isComplete) {
    throw { code: 'WAIVER_LOCKED', message: 'Waiver 已簽署完成，不可修改' };
  }

  // 取得目前的 waiver 內容範本，作為簽署當下的文字快照（之後即使範本內容更新，
  // 已簽署紀錄仍會顯示簽署當時的版本，確保簽署紀錄的法律效力不受後續編輯影響）
  const contentDoc = await db.collection('systemSettings').doc('waiver').get();
  const contentSnapshot = contentDoc.exists ? { zh: contentDoc.data().zh || '', en: contentDoc.data().en || '' } : { zh: '', en: '' };

  // 上傳簽名圖
  const memberSignatureUrl = await uploadSignature(memberId, 'member', signatureData);

  const now = new Date();
  const waiver = {
    memberId,
    memberName,
    memberSignatureUrl,
    memberSignedAt: now,
    memberSignedIp: ip || null,
    memberSignedBy: staffId || 'self',
    parentRequired: isMinor,
    isComplete: !isMinor || !!isChildAccount, // 成年或子會員代簽直接完成
    source: 'new',
    lockedAt: isMinor ? null : now,
    createdAt: now,
    contentSnapshot, // 簽署當下的條款文字快照
  };

  if (isMinor && !isChildAccount) {
    // 產生家長簽名 token（子會員不需要額外的家長簽名流程）
    const token = uuidv4();
    const expiry = dayjs().add(parseInt(process.env.WAIVER_PARENT_TOKEN_HOURS) || 72, 'hour').toDate();

    Object.assign(waiver, {
      parentName: parentName || null,
      parentEmail: parentEmail,
      parentPhone: parentPhone || null,
      parentRelation: parentRelation || null,
      parentSignToken: token,
      parentSignTokenExpiry: expiry,
    });
  }

  await db.collection(COLLECTIONS.WAIVERS).doc(memberId).set(waiver, { merge: true });

  // 更新封鎖狀態
  const memberService = require('./memberService');
  const blockReasons = await memberService.refreshBlockStatus(memberId);

  // 家長簽名 Email：改為「本人 waiver + 墜測同意書皆簽完」才寄一封統一連結（見 maybeSendParentSignEmail）。
  // 此處不再直接寄；若此時墜測同意書也已簽 → helper 會立即寄，否則等墜測簽完那端觸發。
  if (isMinor && !isChildAccount && parentEmail) {
    try { await maybeSendParentSignEmail(memberId); }
    catch (e) { console.error('家長簽署 Email 觸發失敗（會員本人簽署已保存）:', e.message); }
  }

  return { waiver, parentRequired: isMinor, blockReasons };
};

// ── 統一家長簽署 Email ────────────────────────────────────────────
// 未成年會員的「風險安全聲明書」與「墜落測驗同意書」家長簽名，統一成「本人兩份都簽完後
// 寄一封 email、家長進同一頁一次簽名套用兩份」。此 helper 在 waiver 簽署端與墜測同意書
// 簽署端各呼叫一次；只有當「本人 waiver 已簽 + 本人墜測同意書已簽 + 家長尚未簽 + 尚未寄過」
// 才真正寄出（冪等，避免重複寄；提醒改用 resendParentWaiverLink）。
const maybeSendParentSignEmail = async (memberId) => {
  const db = getDb();
  const waiverDoc = await db.collection(COLLECTIONS.WAIVERS).doc(memberId).get();
  if (!waiverDoc.exists) return { sent: false, reason: 'no_waiver' };
  const w = waiverDoc.data();
  if (!w.parentRequired || w.isComplete || w.parentSignedAt) return { sent: false, reason: 'not_required_or_done' };
  if (!w.parentEmail) return { sent: false, reason: 'no_parent_email' };
  if (!w.memberSignedAt && !w.memberSignatureUrl) return { sent: false, reason: 'member_waiver_unsigned' };
  if (w.parentEmailSentAt) return { sent: false, reason: 'already_sent' }; // 冪等；提醒走 resend

  // 本人墜測同意書是否已簽（任一簽署紀錄存在即可）
  const ftSnap = await db.collection('fallTestSignatures').where('memberId', '==', memberId).limit(1).get();
  if (ftSnap.empty) return { sent: false, reason: 'consent_unsigned' };

  // 確保 token 存在
  let token = w.parentSignToken;
  if (!token) {
    token = uuidv4();
    await waiverDoc.ref.update({ parentSignToken: token, parentSignTokenExpiry: dayjs().add(72, 'hour').toDate() });
  }

  const emailService = require('./emailService');
  await emailService.sendParentWaiverLink(memberId, w.memberName, w.parentEmail, w.parentName, token);
  await waiverDoc.ref.update({ parentEmailSentAt: new Date() });
  return { sent: true };
};

// ── 重發家長簽名連結 ──────────────────────────────────────────────
const resendParentWaiverLink = async (memberId, staffId) => {
  const db = getDb();
  const waiverDoc = await db.collection(COLLECTIONS.WAIVERS).doc(memberId).get();

  if (!waiverDoc.exists) throw { code: 'WAIVER_NOT_FOUND' };

  const waiver = waiverDoc.data();
  if (waiver.isComplete) throw { code: 'WAIVER_LOCKED', message: '已完成簽署' };
  if (!waiver.parentRequired) throw { code: 'NO_PARENT_REQUIRED' };

  // 重新產生 token
  const token = uuidv4();
  const expiry = dayjs().add(72, 'hour').toDate();

  await waiverDoc.ref.update({
    parentSignToken: token,
    parentSignTokenExpiry: expiry,
  });

  const emailService = require('./emailService');
  await emailService.sendParentWaiverLink(
    memberId, waiver.memberName,
    waiver.parentEmail, waiver.parentName,
    token
  );

  return { message: '已重新發送家長簽名連結' };
};

module.exports = { signWaiver, uploadSignature, resendParentWaiverLink, maybeSendParentSignEmail };
