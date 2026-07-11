const { taiwanToday } = require('../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const dayjs = require('dayjs');
const { ageOf, isUnder5 } = require('../utils/age');

// ── QR Code 產生 ──────────────────────────────────────────────────
const generateQRCode = async (memberId, memberPhone) => {
  const qrCodeId = `RR-${memberId.slice(0, 8).toUpperCase()}`;
  const qrData = JSON.stringify({ type: 'member', id: memberId, qrCodeId });

  // 產生 base64 QR Code 圖片，直接內嵌回傳（不再上傳 Firebase Storage）：
  //  - 入場實際走動態 qrToken（會員 App 前端即時繪製），此靜態圖僅作身分 QR。
  //  - 無人以路徑/簽名 URL 讀取此圖；直接存 base64 data URI，與 seed 舊會員一致，
  //    並移除 Storage 依賴（避免 Storage 異常時卡死建立會員）。
  const qrBase64 = await QRCode.toDataURL(qrData, {
    width: 300,
    margin: 2,
    color: { dark: '#8B1A1A', light: '#FFFFFF' },
  });

  return { qrCodeId, qrCodeUrl: qrBase64 }; // qrCodeUrl 現為 base64 data URI（欄位名沿用）
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

  // 3. 墜落測驗：從未通過 → fall_test_required；曾通過但所有 passed 紀錄皆已過期 → fall_test_expired
  const fallTests = await db.collection(COLLECTIONS.FALL_TESTS)
    .where('memberId', '==', memberId)
    .where('result', '==', 'passed')
    .get();

  if (fallTests.empty) {
    reasons.push('fall_test_required');
  } else {
    // 是否至少一筆 passed 尚未過期（無到期日＝永久有效）；效期欄位比照 calcFallTestStatus
    const now = Date.now();
    let hasValid = false;
    fallTests.docs.forEach(d => {
      const t = d.data();
      const raw = t.currentExpiresAt || t.expiresAt;
      if (!raw) { hasValid = true; return; }
      const sec = raw?.seconds ?? raw?._seconds;
      const ms = sec != null ? sec * 1000 : new Date(raw).getTime();
      if (!isNaN(ms) && ms >= now) hasValid = true;
    });
    if (!hasValid) reasons.push('fall_test_expired');
  }

  return reasons;
};

// ── 建立新會員 ────────────────────────────────────────────────────
// 舊系統墜測效期遷移：(重新)註冊時以「電話+姓名」比對 legacyFallTests，
// 命中且效期未過、未被認領 → 在新帳號補建 passed 墜測（免重測），並標記已認領（一次性，防冒用/重複）。
// 其餘舊資料一律不匯入，會員仍須重簽 Waiver、重填資料、重簽墜測同意書。
const claimLegacyFallTest = async (db, memberId, member) => {
  try {
    if (member.isChildAccount) return null;            // 子帳號共用電話，不自動認領（避免認錯人）
    const phone = (member.phone || '').trim();
    const name = (member.name || '').replace(/\s/g, '');
    if (!phone || !name) return null;
    const snap = await db.collection('legacyFallTests').where('phone', '==', phone).get();
    if (snap.empty) return null;
    const today = taiwanToday();
    const hit = snap.docs.find(d => {
      const x = d.data();
      if (x.claimed === true) return false;
      if ((x.name || '').replace(/\s/g, '') !== name) return false;  // 姓名必須相符（防共用電話冒領）
      const exp = String(x.fallTestExpiresAt || '').slice(0, 10);
      return exp && exp >= today;                                     // 仍在效期內
    });
    if (!hit) return null;
    const exp = String(hit.data().fallTestExpiresAt).slice(0, 10);
    const now = new Date();
    const ftId = uuidv4();
    await db.collection('fallTests').doc(ftId).set({
      id: ftId, memberId, result: 'passed',
      testedBy: 'migration', testedByName: '舊系統轉移',
      testedAt: now,
      expiresAt: new Date(exp + 'T00:00:00+08:00'),
      source: 'climbio-migrated', migratedFrom: hit.id,
      notes: '舊系統墜測效期轉移（免重測）',
      createdAt: now, updatedAt: now,
    });
    await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
      fallTestPassed: true, fallTestExpiresAt: new Date(exp + 'T00:00:00+08:00'), updatedAt: now,
    });
    await hit.ref.update({ claimed: true, claimedBy: memberId, claimedAt: now });
    console.log(`[墜測遷移] ${name}/${phone} 認領舊效期至 ${exp}`);
    return { fallTestId: ftId, expiresAt: exp };
  } catch (e) { console.error('claimLegacyFallTest 失敗', e.message); return null; }
};

const createMember = async (memberData, staffId, options = {}) => {
  const db = getDb();
  const memberId = uuidv4();

  // 後端權威：未滿 5 歲無法成為會員（含子會員）。birthday 選填 → 有填才判斷。
  if (isUnder5(memberData.birthday)) {
    throw { code: 'AGE_UNDER_5', message: '未滿 5 歲無法成為會員' };
  }

  // 後端權威：子會員（家庭成員）僅限未滿 18 歲（滿 18 歲應註冊正式會員）。
  // 涵蓋所有建子會員入口（會員自助 /my/children、店員 /:id/children），不單靠路由層或前端。
  if (options?.isChildAccount) {
    const a = ageOf(memberData.birthday);
    if (a !== null && a >= 18) {
      throw { code: 'AGE_RESTRICTION', message: '家庭成員僅限未滿 18 歲，滿 18 歲請註冊正式會員' };
    }
  }

  // 檢查電話是否重複（子會員共用父會員電話，跳過此檢查）
  if (!options?.isChildAccount) {
    const existing = await db.collection(COLLECTIONS.MEMBERS)
      .where('phone', '==', memberData.phone)
      .limit(1)
      .get();
    if (!existing.empty) {
      throw { code: 'PHONE_EXISTS', message: '此電話號碼已被使用' };
    }
  }

  // 計算是否未成年（<18）—— 用共用 ageOf 工具
  const _age = ageOf(memberData.birthday);
  const isMinor = _age !== null && _age < 18;

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

  // 舊系統墜測效期自動認領（電話+姓名比對，命中即免重測）→ 在算封鎖狀態前完成，避免被誤判需墜測
  await claimLegacyFallTest(db, memberId, member);

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

// 剝除敏感認證欄位，避免經 API 外洩（passwordHash / 重設・驗證 token / 登入鎖定狀態）
// getMember/searchMembers 的所有消費端都不需要這些欄位；密碼重設/登入另以 phone/token 直接查詢。
const SENSITIVE_FIELDS = ['passwordHash', 'resetPasswordToken', 'resetPasswordExpiry', 'emailVerifyToken', 'emailVerifyExpiry', 'loginFailCount', 'loginLockedUntil'];
const sanitizeMember = (m) => {
  if (!m) return m;
  const out = { ...m };
  for (const f of SENSITIVE_FIELDS) delete out[f];
  return out;
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
    ).slice(0, limit).map(sanitizeMember);
  }

  snapshot = await ref.orderBy('createdAt', 'desc').limit(limit).get();
  return snapshot.docs.map(d => sanitizeMember({ id: d.id, ...d.data() }));
};

// ── 取得單一會員 ──────────────────────────────────────────────────
const getMember = async (memberId) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.MEMBERS).doc(memberId).get();
  if (!doc.exists) throw { code: 'MEMBER_NOT_FOUND', message: '找不到此會員' };
  return sanitizeMember({ id: doc.id, ...doc.data() });
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
  let docs;
  // 支援輸入末四碼
  if (phone.length === 4) {
    const snapshot = await db.collection(COLLECTIONS.MEMBERS)
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();
    docs = snapshot.docs.filter(d => d.data().phone?.endsWith(phone));
  } else {
    const snapshot = await db.collection(COLLECTIONS.MEMBERS)
      .where('phone', '==', phone)
      .get();
    docs = snapshot.docs;
  }
  if (!docs.length) throw { code: 'MEMBER_NOT_FOUND', message: '查無此電話' };
  // 親子共用電話：子帳號繼承家長電話，一支電話可能對應多筆。
  // 優先回傳「家長帳號」（非子帳號），避免誤解析到子會員（原 limit(1) 無排序不確定）。
  const pick = docs.find(d => { const m = d.data(); return !m.isChildAccount && !m.parentMemberId; }) || docs[0];
  return { id: pick.id, ...pick.data() };
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
  claimLegacyFallTest,
  searchMembers,
  getMember,
  getMemberByQRCode,
  getMemberByPhone,
  getBlockReasons,
  refreshBlockStatus,
  generateQRCode,
  verifyEmail,
};
