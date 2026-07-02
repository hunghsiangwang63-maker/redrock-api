/**
 * Waiver Service
 */
const { getDb, getStorage, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

// ── 上傳簽名圖至 Firebase Storage ────────────────────────────────
const uploadSignature = async (memberId, type, base64Data) => {
  const bucket = getStorage().bucket();
  const fileName = `waivers/${memberId}_${type}_${Date.now()}.png`;
  const imageData = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(imageData, 'base64');

  const file = bucket.file(fileName);
  await file.save(buffer, { contentType: 'image/png' });
  // 不再 makePublic：簽名屬個資，保持私有，顯示時由後端產生短效簽名 URL（見 utils/storageUrl）
  return fileName; // 儲存物件路徑，非公開 URL
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

  // 發送家長簽名 Email
  if (isMinor && !isChildAccount && parentEmail) {
    const emailService = require('./emailService');
    const token = waiver.parentSignToken;
    try {
      await emailService.sendParentWaiverLink(memberId, memberName, parentEmail, parentName, token);
    } catch (e) {
      console.error('家長簽署Email發送失敗（會員本人簽署已成功保存）:', e.message);
    }
  }

  return { waiver, parentRequired: isMinor, blockReasons };
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

module.exports = { signWaiver, uploadSignature, resendParentWaiverLink };
