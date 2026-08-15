/**
 * 紅石賽事計分系統（Redrock-comp）身分驗證橋接
 *
 * 背景（2026-08-15 安全稽核發現）：redrock-comp 是純前端單檔 HTML 應用，直接用 Firebase 客戶端
 * SDK 存取 Firestore；原本的「管理密碼／裁判密碼／單場管理員密碼」全部只在瀏覽器端比對——資料庫
 * 本身完全沒有真正的存取控制（匿名登入即可寫入任何比賽資料），密碼檢查形同虛設。
 *
 * 修法：密碼驗證改到這裡（伺服器端，用既有的 COMP_FIREBASE_SA 服務帳號讀取 redrock-comp 的
 * Firestore，Admin SDK 天生繞過任何規則），驗證通過才核發帶身分宣告（custom claims）的 Firebase
 * custom token；redrock-comp 前端登入成功後改用 signInWithCustomToken 換取這個 token，之後所有
 * 寫入才會被新的 Firestore 規則（見 redrock-comp/firestore.rules）根據 claims 放行——密碼本身
 * 不再是唯一防線，資料庫規則才是。
 *
 * ⚠️ 雜湊演算法必須與 redrock-comp/public/index.html 的 hashPw() 逐字一致（SHA-256 + 固定鹽），
 * 否則既有密碼全部失效——改動任一邊務必同步。
 */
const crypto = require('crypto');
const { getCompDb, getCompAuth } = require('../config/compFirebase');

const PW_SALT = 'RedRock_2026_#!'; // 必須與 redrock-comp 前端的 PW_SALT 完全一致

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

// role: 'super_admin' | 'sub_admin' | 'judge'
// 回傳 { ok:true, token } 或 { ok:false, message }
const verifyAndMintToken = async ({ role, password, email, compId }) => {
  const db = getCompDb();
  const auth = getCompAuth();
  if (!db || !auth) return { ok: false, message: '計分系統未設定金鑰（COMP_FIREBASE_SA）' };
  if (!password) return { ok: false, message: '請輸入密碼' };
  const hash = hashPw(password);

  if (role === 'super_admin') {
    const snap = await db.collection('config').doc('admin').get();
    const pw = snap.exists ? snap.data().pw : '';
    if (!pw || pw !== hash) return { ok: false, message: '密碼錯誤' };
    const uid = 'comp-super-admin';
    const claims = { role: 'super_admin' };
    await ensureUserWithClaims(auth, uid, claims);
    const token = await auth.createCustomToken(uid, claims);
    return { ok: true, token };
  }

  if (role === 'sub_admin') {
    const em = String(email || '').trim().toLowerCase();
    if (!em) return { ok: false, message: '請輸入帳號' };
    const compsSnap = await db.collection('competitions').get();
    const matched = [];
    let matchedName = em;
    compsSnap.forEach((d) => {
      const subs = (d.data() || {}).subAdmins || {};
      Object.keys(subs).forEach((k) => {
        const acc = subs[k];
        if (acc && acc.email && String(acc.email).trim().toLowerCase() === em && acc.password === hash) {
          if (matched.indexOf(d.id) === -1) matched.push(d.id);
          if (acc.name) matchedName = acc.name;
        }
      });
    });
    if (!matched.length) return { ok: false, message: '帳號或密碼錯誤' };
    const uid = 'comp-subadmin-' + shortHash(em);
    const claims = { role: 'sub_admin', compIds: matched };
    await ensureUserWithClaims(auth, uid, claims);
    const token = await auth.createCustomToken(uid, claims);
    return { ok: true, token, compIds: matched, name: matchedName };
  }

  if (role === 'judge') {
    const em = String(email || '').trim().toLowerCase();
    if (!em) return { ok: false, message: '請輸入帳號' };
    if (!compId) return { ok: false, message: '請先進入一場比賽' };
    const snap = await db.collection('competitions').doc(compId).get();
    if (!snap.exists) return { ok: false, message: '比賽不存在' };
    const accounts = (snap.data() || {}).judgeAccounts || {};
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

// 變更總管理者密碼——限已持有效 super_admin custom claims 的 ID token 呼叫（見 routes/compAuth.js
// 的 verifySuperAdminToken 中介層），伺服器端直接用 Admin SDK 寫入，繞過（也不需要）Firestore 規則。
const changeAdminPassword = async (newPassword) => {
  const db = getCompDb();
  if (!db) throw Object.assign(new Error('計分系統未設定金鑰'), { code: 'NOT_CONFIGURED' });
  if (!newPassword || String(newPassword).length < 1) {
    throw Object.assign(new Error('請輸入新密碼'), { code: 'INVALID_PASSWORD' });
  }
  await db.collection('config').doc('admin').set({ pw: hashPw(newPassword) }, { merge: true });
};

module.exports = { verifyAndMintToken, changeAdminPassword, hashPw };
