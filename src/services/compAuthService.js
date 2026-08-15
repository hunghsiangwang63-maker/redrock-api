/**
 * 紅石賽事計分系統（Redrock-comp）身分驗證橋接
 *
 * 背景（2026-08-15 安全稽核發現）：redrock-comp 是純前端單檔 HTML 應用，直接用 Firebase 客戶端
 * SDK 存取 Firestore；原本的「管理密碼／裁判密碼／單場管理員密碼」全部只在瀏覽器端比對——資料庫
 * 本身完全沒有真正的存取控制（匿名登入即可寫入任何比賽資料），密碼檢查形同虛設。
 *
 * 修法：密碼驗證改到這裡（伺服器端），驗證通過才核發帶身分宣告（custom claims）的 Firebase
 * custom token；redrock-comp 前端登入成功後改用 signInWithCustomToken 換取這個 token，之後所有
 * 寫入才會被新的 Firestore 規則（見 redrock-comp/firestore.rules）根據 claims 放行/拒絕——密碼
 * 本身不再是唯一防線，資料庫規則才是。
 *
 * 2026-08-15 續：super_admin／sub_admin（總管理者／單場賽事管理員，通常本來就是 RedRock 自己的
 * 員工/館長）改為直接驗證 redrock-api 既有的員工帳號（email+密碼，比對 staff 集合的 bcrypt
 * hash），不再各自維護一組獨立密碼——帳號生命週期跟主系統員工帳號綁在一起（離職停用員工帳號，
 * 計分系統的管理權限也一併失效，不用另外去 redrock-comp 那邊改）。裁判（judge）刻意維持現狀：
 * 裁判常是外部邀請的人（非本館員工），繼續用各賽事各自匯入/設定的獨立帳密，伺服器端驗證
 * （見下方 judge 分支）與雜湊演算法皆不變。
 *
 * ⚠️ judge 分支的雜湊演算法必須與 redrock-comp/public/index.html 的 hashPw() 逐字一致
 * （SHA-256 + 固定鹽），否則既有裁判密碼全部失效——改動任一邊務必同步。
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getCompDb, getCompAuth } = require('../config/compFirebase');
const { getDb, COLLECTIONS } = require('../config/firebase');

const PW_SALT = 'RedRock_2026_#!'; // 必須與 redrock-comp 前端的 PW_SALT 完全一致（僅 judge 角色使用）

const hashPw = (plain) => crypto.createHash('sha256').update(PW_SALT + String(plain || ''), 'utf8').digest('hex');

const shortHash = (s) => crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex').slice(0, 16);

// 確保這個 uid 的 Firebase Auth 使用者存在，並把 claims 「持久化」設在使用者記錄上——
// 這樣即使之後瀏覽器靜默刷新 ID token（不會重新走一次 signInWithCustomToken），claims 仍會保留，
// 不會出現「session 用著用著、一小時後突然失去寫入權限」這種難排查的問題。
const ensureUserWithClaims = async (auth, uid, claims) => {
  try {
    await auth.createUser({ uid });
  } catch (e) {
    if (e.code !== 'auth/uid-already-exists') throw e;
  }
  await auth.setCustomUserClaims(uid, claims);
};

// 驗證「這是一個有效、啟用中的 super_admin 員工帳號」——直接查 redrock-api 自己的 staff 集合，
// 不呼叫 /auth/staff/login（同一個 process 裡沒必要繞一圈 HTTP），也刻意不比照該端點做裝置
// 綁定/登入鎖定檢查（那些是保護整個員工系統的機制，計分系統只是其中一小塊權限，沒必要牽連）。
const verifyStaffSuperAdmin = async (email, password) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.STAFF).where('email', '==', email).limit(1).get();
  if (snap.empty) return null;
  const staff = snap.docs[0].data();
  if (!staff.isActive) return null;
  if (staff.role !== 'super_admin') return null;
  if (!staff.passwordHash || !(await bcrypt.compare(password, staff.passwordHash))) return null;
  return { staffId: snap.docs[0].id, name: staff.name || email };
};

// role: 'super_admin' | 'sub_admin' | 'judge'
// super_admin/sub_admin 的 password 現在是「員工帳號密碼」；judge 的 password 仍是 redrock-comp
// 自己那組獨立密碼（見檔頭說明）。回傳 { ok:true, token } 或 { ok:false, message }
const verifyAndMintToken = async ({ role, password, email, compId }) => {
  const compDb = getCompDb();
  const auth = getCompAuth();
  if (!compDb || !auth) return { ok: false, message: '計分系統未設定金鑰（COMP_FIREBASE_SA）' };
  if (!password) return { ok: false, message: '請輸入密碼' };

  if (role === 'super_admin') {
    const em = String(email || '').trim().toLowerCase();
    if (!em) return { ok: false, message: '請輸入員工帳號 Email' };
    const staff = await verifyStaffSuperAdmin(em, password);
    if (!staff) return { ok: false, message: '帳號或密碼錯誤，或此帳號非系統管理員' };
    const uid = 'comp-super-admin-' + shortHash(staff.staffId);
    const claims = { role: 'super_admin' };
    await ensureUserWithClaims(auth, uid, claims);
    const token = await auth.createCustomToken(uid, claims);
    return { ok: true, token, name: staff.name };
  }

  if (role === 'sub_admin') {
    const em = String(email || '').trim().toLowerCase();
    if (!em) return { ok: false, message: '請輸入帳號' };
    // 驗證這是一個有效的員工帳號（角色不限，單場管理員可以是任何員工——實際可管哪些比賽
    // 仍由下面「這個 email 出現在哪些比賽的 subAdmins 名單裡」決定，跟主系統角色高低無關）
    const db = getDb();
    const staffSnap = await db.collection(COLLECTIONS.STAFF).where('email', '==', em).limit(1).get();
    if (staffSnap.empty) return { ok: false, message: '帳號或密碼錯誤' };
    const staff = staffSnap.docs[0].data();
    if (!staff.isActive) return { ok: false, message: '帳號已停用' };
    if (!staff.passwordHash || !(await bcrypt.compare(password, staff.passwordHash))) {
      return { ok: false, message: '帳號或密碼錯誤' };
    }
    // 掃描各比賽的 subAdmins 名單找出這個 email 被指派管哪些比賽（指派時只需填 email，
    // 不再需要另外設一組密碼——密碼一律驗證員工帳號本身）
    const compsSnap = await compDb.collection('competitions').get();
    const matched = [];
    let matchedName = staff.name || em;
    compsSnap.forEach((d) => {
      const subs = (d.data() || {}).subAdmins || {};
      Object.keys(subs).forEach((k) => {
        const acc = subs[k];
        if (acc && acc.email && String(acc.email).trim().toLowerCase() === em && matched.indexOf(d.id) === -1) {
          matched.push(d.id);
          if (acc.name) matchedName = acc.name;
        }
      });
    });
    if (!matched.length) return { ok: false, message: '此員工帳號尚未被指派為任何一場比賽的單場管理員' };
    const uid = 'comp-subadmin-' + shortHash(em);
    const claims = { role: 'sub_admin', compIds: matched };
    await ensureUserWithClaims(auth, uid, claims);
    const token = await auth.createCustomToken(uid, claims);
    return { ok: true, token, compIds: matched, name: matchedName };
  }

  if (role === 'judge') {
    // 裁判維持獨立密碼（常是外部邀請的人，非本館員工），驗證方式與雜湊演算法皆不變。
    const em = String(email || '').trim().toLowerCase();
    if (!em) return { ok: false, message: '請輸入帳號' };
    if (!compId) return { ok: false, message: '請先進入一場比賽' };
    const snap = await compDb.collection('competitions').doc(compId).get();
    if (!snap.exists) return { ok: false, message: '比賽不存在' };
    const accounts = (snap.data() || {}).judgeAccounts || {};
    const hash = hashPw(password);
    const found = Object.keys(accounts).some((k) => {
      const acc = accounts[k];
      return acc && acc.email && String(acc.email) === em && acc.password === hash;
    });
    if (!found) return { ok: false, message: 'Email 或密碼錯誤' };
    const uid = 'comp-judge-' + shortHash(compId + '|' + em);
    const claims = { role: 'judge', compId };
    await ensureUserWithClaims(auth, uid, claims);
    const token = await auth.createCustomToken(uid, claims);
    return { ok: true, token };
  }

  return { ok: false, message: '未知的登入類型' };
};

module.exports = { verifyAndMintToken, hashPw };
