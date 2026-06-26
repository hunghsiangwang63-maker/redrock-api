const { getDb, getStorage, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const dayjs = require('dayjs');

// ── QR Code 產生 ──────────────────────────────────────────────────
const generateQRCode = async (memberId, memberPhone) => {
  const qrCodeId = `RR-${memberId.slice(0, 8).toUpperCase()}`;
  const qrData = JSON.stringify({ type: 'member', id: memberId, qrCodeId });

  // 產生 base64 QR Code 圖片
  const qrBase64 = await QRCode.toDataURL(qrData, {
    width: 300,
    margin: 2,
    color: { dark: '#8B1A1A', light: '#FFFFFF' },
  });

  // 上傳至 Firebase Storage
  const bucket = getStorage().bucket();
  const fileName = `qrcodes/${memberId}.png`;
  const base64Data = qrBase64.replace(/^data:image\/png;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const file = bucket.file(fileName);
  await file.save(buffer, { contentType: 'image/png', metadata: { memberId } });
  await file.makePublic();

  const qrCodeUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
  return { qrCodeId, qrCodeUrl };
};

// ── 判斷封鎖原因 ──────────────────────────────────────────────────
const getBlockReasons = async (memberId, memberData) => {
  const db = getDb();
  const reasons = [];

  // 1. Email 未驗證（自助註冊）
  if (memberData.registeredBy === 'self' && !memberData.emailVerified) {
    reasons.push('email_unverified');
  }

  // 2. Waiver 未簽
  const waiverDoc = await db.collection(COLLECTIONS.WAIVERS).doc(memberId).get();
  if (!waiverDoc.exists || !waiverDoc.data().isComplete) {
    if (!waiverDoc.exists) {
      reasons.push('waiver_unsigned');
    } else if (waiverDoc.data().parentRequired && !waiverDoc.data().parentSignedAt) {
      reasons.push('parent_waiver_pending');
    } else {
      reasons.push('waiver_unsigned');
    }
  }

  // 3. 從未通過墜落測驗
  const fallTests = await db.collection(COLLECTIONS.FALL_TESTS)
    .where('memberId', '==', memberId)
    .where('result', '==', 'pass')
    .limit(1)
    .get();

  if (fallTests.empty) {
    reasons.push('fall_test_required');
  }

  return reasons;
};

// ── 建立新會員 ────────────────────────────────────────────────────
const createMember = async (memberData, staffId, options = {}) => {
  const db = getDb();
  const memberId = uuidv4();

  // 檢查電話是否重複
  const existing = await db.collection(COLLECTIONS.MEMBERS)
    .where('phone', '==', memberData.phone)
    .limit(1)
    .get();

  if (!existing.empty) {
    throw { code: 'PHONE_EXISTS', message: '此電話號碼已被使用' };
  }

  // 計算是否未成年
  const birthday = memberData.birthday ? dayjs(memberData.birthday) : null;
  const isMinor = birthday ? dayjs().diff(birthday, 'year') < 18 : false;

  // 產生 QR Code
  const { qrCodeId, qrCodeUrl } = await generateQRCode(memberId, memberData.phone);

  const now = new Date();
  const member = {
    id: memberId,
    name: memberData.name,
    phone: memberData.phone,
    email: memberData.email || null,
    birthday: memberData.birthday || null,
    gender: memberData.gender || null,
    emergencyContact: memberData.emergencyContact || null,
    qrCode: qrCodeUrl,
    qrCodeId,
    isMinor,
    isChildAccount: options.isChildAccount || false,
    parentMemberId: options.parentMemberId || null,
    registeredBy: staffId ? 'staff' : 'self',
    emailVerified: staffId ? true : false, // 店員建立的預設已驗證
    emailVerifyToken: null,
    emailVerifyExpiry: null,
    isBlocked: false,
    blockReasons: [],
    notes: memberData.notes || '',
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).set(member);

  // 計算並更新封鎖狀態
  const blockReasons = await getBlockReasons(memberId, member);
  if (blockReasons.length > 0) {
    await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
      isBlocked: true,
      blockReasons,
      updatedAt: new Date(),
    });
    member.isBlocked = true;
    member.blockReasons = blockReasons;
  }

  return member;
};

// ── 搜尋會員 ─────────────────────────────────────────────────────
const searchMembers = async ({ query, gymId, role, limit = 20, cursor }) => {
  const db = getDb();
  let ref = db.collection(COLLECTIONS.MEMBERS);

  // 如果是搜尋字串，先在本地過濾（Firestore 不支援全文搜尋）
  // 實際上線建議使用 Algolia 或 Typesense
  let snapshot;
  if (query) {
    // 先取最近1000筆做本地過濾
    snapshot = await ref.orderBy('createdAt', 'desc').limit(1000).get();
    const all = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    return all.filter(m =>
      m.name?.includes(query) ||
      m.phone?.includes(query) ||
      m.email?.includes(query)
    ).slice(0, limit);
  }

  snapshot = await ref.orderBy('createdAt', 'desc').limit(limit).get();
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
};

// ── 取得單一會員 ──────────────────────────────────────────────────
const getMember = async (memberId) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.MEMBERS).doc(memberId).get();
  if (!doc.exists) throw { code: 'MEMBER_NOT_FOUND', message: '找不到此會員' };
  return { id: doc.id, ...doc.data() };
};

// ── 透過 QR Code ID 取得會員 ──────────────────────────────────────
const getMemberByQRCode = async (qrCodeId) => {
  const db = getDb();
  const snapshot = await db.collection(COLLECTIONS.MEMBERS)
    .where('qrCodeId', '==', qrCodeId)
    .limit(1)
    .get();

  if (snapshot.empty) throw { code: 'MEMBER_NOT_FOUND', message: '查無此 QR Code' };
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
};

// ── 透過電話取得會員 ─────────────────────────────────────────────
const getMemberByPhone = async (phone) => {
  const db = getDb();
  // 支援輸入末四碼
  if (phone.length === 4) {
    const snapshot = await db.collection(COLLECTIONS.MEMBERS)
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();
    const match = snapshot.docs.find(d => d.data().phone?.endsWith(phone));
    if (!match) throw { code: 'MEMBER_NOT_FOUND', message: '查無此電話' };
    return { id: match.id, ...match.data() };
  }

  const snapshot = await db.collection(COLLECTIONS.MEMBERS)
    .where('phone', '==', phone)
    .limit(1)
    .get();
  if (snapshot.empty) throw { code: 'MEMBER_NOT_FOUND', message: '查無此電話' };
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
};

// ── 更新封鎖狀態 ──────────────────────────────────────────────────
const refreshBlockStatus = async (memberId) => {
  const db = getDb();
  const member = await getMember(memberId);
  const blockReasons = await getBlockReasons(memberId, member);

  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
    isBlocked: blockReasons.length > 0,
    blockReasons,
    updatedAt: new Date(),
  });

  return blockReasons;
};

// ── 驗證 Email ────────────────────────────────────────────────────
const verifyEmail = async (token) => {
  const db = getDb();
  const snapshot = await db.collection(COLLECTIONS.MEMBERS)
    .where('emailVerifyToken', '==', token)
    .limit(1)
    .get();

  if (snapshot.empty) throw { code: 'INVALID_TOKEN', message: '無效的驗證連結' };

  const doc = snapshot.docs[0];
  const member = doc.data();

  if (dayjs().isAfter(dayjs(member.emailVerifyExpiry.toDate()))) {
    throw { code: 'TOKEN_EXPIRED', message: '驗證連結已過期，請重新申請' };
  }

  await doc.ref.update({
    emailVerified: true,
    emailVerifyToken: null,
    emailVerifyExpiry: null,
    updatedAt: new Date(),
  });

  // 重新計算封鎖狀態
  await refreshBlockStatus(doc.id);

  return { memberId: doc.id };
};

module.exports = {
  createMember,
  searchMembers,
  getMember,
  getMemberByQRCode,
  getMemberByPhone,
  getBlockReasons,
  refreshBlockStatus,
  generateQRCode,
  verifyEmail,
};
