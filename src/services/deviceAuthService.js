/**
 * 裝置綁定服務
 * 員工個人帳號登入 / 館別電腦帳號登入，首次在新裝置/瀏覽器登入時，
 * 需透過 Email 驗證碼自助完成綁定，或由 super_admin 於後台手動核准。
 * super_admin 角色本身不受此限制（避免無人能核准第一個裝置的雞生蛋問題）。
 */
const { getDb } = require('../config/firebase');
const dayjs = require('dayjs');
const crypto = require('crypto');

const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5; // OTP 錯誤嘗試上限，超過即作廢
const COLLECTION_TRUSTED = 'trustedDevices';
const COLLECTION_PENDING = 'deviceVerifications';

const toDate = (v) => (v?.toDate ? v.toDate() : v);
// 用加密安全亂數產生 6 位 OTP（避免 Math.random 可預測）
const generateCode = () => String(100000 + (crypto.randomInt(0, 900000)));

// ── 裝置綁定總開關（可逆；systemSettings/security.deviceBindingEnabled）──
// 預設 true（強制綁定）；設為 false 可暫時停用裝置驗證（測試期），改回 true 即恢復。
// 讀取失敗一律回 true（安全預設：寧可強制、不誤放行）。super_admin 另有豁免、不受此開關影響。
const isDeviceBindingEnabled = async () => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('security').get();
    if (doc.exists && doc.data().deviceBindingEnabled === false) return false;
    return true;
  } catch (e) { return true; }
};

// ── 檢查裝置是否已授權 ────────────────────────────────────────────
const isDeviceTrusted = async (accountType, accountId, deviceToken) => {
  if (!deviceToken) return false;
  const db = getDb();
  const snap = await db.collection(COLLECTION_TRUSTED)
    .where('accountType', '==', accountType)
    .where('accountId', '==', accountId)
    .where('deviceToken', '==', deviceToken)
    .limit(1).get();
  if (snap.empty) return false;
  await snap.docs[0].ref.update({ lastUsedAt: new Date() });
  return true;
};

// ── 建立新裝置驗證請求（寄送OTP為best-effort，失敗不擋流程，可改用管理員審核）──
const createDeviceVerification = async ({ accountType, accountId, accountName, accountEmail, deviceToken, deviceLabel }) => {
  const db = getDb();

  // deviceToken 可能為 undefined（client 未帶）；Firestore where/set 不接受 undefined，先防護
  if (deviceToken) {
    const existing = await db.collection(COLLECTION_PENDING)
      .where('accountType', '==', accountType)
      .where('accountId', '==', accountId)
      .where('deviceToken', '==', deviceToken)
      .where('status', '==', 'pending')
      .limit(1).get();

    if (!existing.empty) {
      const doc = existing.docs[0];
      if (dayjs(toDate(doc.data().otpExpiresAt)).isAfter(dayjs())) {
        // 沿用未過期驗證單，並「重寄」同一組驗證碼（使用者再按一次登入＝重寄；登入已有限流）
        if (accountEmail) {
          try {
            const emailService = require('./emailService');
            await emailService.sendDeviceVerificationCode(accountEmail, accountName, doc.data().otpCode);
          } catch (e) { console.error('裝置驗證碼Email重寄失敗:', e.message); }
        }
        return { verificationId: doc.id };
      }
    }
  }

  const code = generateCode();
  const now = new Date();
  const ref = db.collection(COLLECTION_PENDING).doc();
  await ref.set({
    id: ref.id, accountType, accountId,
    accountName: accountName || '', accountEmail: accountEmail || '',
    deviceToken: deviceToken || null, deviceLabel: deviceLabel || '',
    otpCode: code,
    otpExpiresAt: dayjs().add(OTP_EXPIRY_MINUTES, 'minute').toDate(),
    status: 'pending',
    createdAt: now, resolvedAt: null, resolvedBy: null,
  });

  if (accountEmail) {
    try {
      const emailService = require('./emailService');
      await emailService.sendDeviceVerificationCode(accountEmail, accountName, code);
    } catch (e) {
      console.error('裝置驗證碼Email發送失敗（可改用管理員審核）:', e.message);
    }
  }

  return { verificationId: ref.id };
};

// ── 核准裝置（OTP自助驗證 或 管理員手動核准，皆走此函式）───────────
const approveDeviceVerification = async (verificationId, approvedByLabel) => {
  const db = getDb();
  const ref = db.collection(COLLECTION_PENDING).doc(verificationId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'VERIFICATION_NOT_FOUND', message: '驗證請求不存在' };
  const v = doc.data();
  if (v.status !== 'pending') throw { code: 'ALREADY_RESOLVED', message: '此驗證請求已處理過' };

  await db.collection(COLLECTION_TRUSTED).add({
    accountType: v.accountType, accountId: v.accountId, deviceToken: v.deviceToken,
    deviceLabel: v.deviceLabel || '', approvedBy: approvedByLabel,
    approvedAt: new Date(), lastUsedAt: new Date(), createdAt: new Date(),
  });
  await ref.update({ status: 'approved', resolvedAt: new Date(), resolvedBy: approvedByLabel });
  return v;
};

// ── OTP 自助驗證 ──────────────────────────────────────────────────
const verifyDeviceOtp = async (verificationId, code) => {
  const db = getDb();
  const doc = await db.collection(COLLECTION_PENDING).doc(verificationId).get();
  if (!doc.exists) throw { code: 'VERIFICATION_NOT_FOUND', message: '驗證請求不存在' };
  const v = doc.data();
  if (v.status !== 'pending') throw { code: 'ALREADY_RESOLVED', message: '此驗證請求已處理過' };
  if (dayjs(toDate(v.otpExpiresAt)).isBefore(dayjs())) {
    throw { code: 'CODE_EXPIRED', message: '驗證碼已過期，請重新登入取得新驗證碼' };
  }
  // 嘗試次數上限：超過即作廢，防止 6 位數暴力猜測
  if ((v.otpAttempts || 0) >= OTP_MAX_ATTEMPTS) {
    await doc.ref.update({ status: 'rejected', resolvedAt: new Date(), resolvedBy: 'otp-locked' });
    throw { code: 'TOO_MANY_ATTEMPTS', message: '驗證碼錯誤次數過多，請重新登入取得新驗證碼' };
  }
  // 定長比較，降低時序側信道
  const expected = String(v.otpCode || '');
  const given = String(code || '');
  const match = expected.length === given.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  if (!match) {
    await doc.ref.update({ otpAttempts: (v.otpAttempts || 0) + 1 });
    throw { code: 'INVALID_CODE', message: '驗證碼錯誤' };
  }

  return approveDeviceVerification(verificationId, 'otp');
};

// ── 管理員拒絕 ────────────────────────────────────────────────────
const rejectDeviceVerification = async (verificationId, rejectedByLabel) => {
  const db = getDb();
  const ref = db.collection(COLLECTION_PENDING).doc(verificationId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'VERIFICATION_NOT_FOUND', message: '驗證請求不存在' };
  if (doc.data().status !== 'pending') throw { code: 'ALREADY_RESOLVED', message: '此驗證請求已處理過' };
  await ref.update({ status: 'rejected', resolvedAt: new Date(), resolvedBy: rejectedByLabel });
};

module.exports = {
  isDeviceTrusted, isDeviceBindingEnabled, createDeviceVerification, verifyDeviceOtp,
  approveDeviceVerification, rejectDeviceVerification,
};
