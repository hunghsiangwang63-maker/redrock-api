/**
 * 逐帳號登入鎖定（員工 staff / 站台 station）
 * 比照會員登入的 loginFailCount/loginLockedUntil，但門檻放寬（櫃檯情境，降低誤鎖）：
 *   員工/站台：連錯 10 次鎖 10 分鐘（會員為 5 次 / 15 分鐘）
 * 用法：登入時 checkLocked(data) → 驗密碼失敗 registerFail(col, id, data) → 成功 clearFail(col, id)
 */
const { getDb } = require('../config/firebase');

const MAX_FAIL = 10;      // 放寬：連錯 10 次才鎖
const LOCK_MINUTES = 10;  // 鎖定 10 分鐘

const toDate = (v) => (v?.toDate ? v.toDate() : (v?._seconds ? new Date(v._seconds * 1000) : (v ? new Date(v) : null)));

// 是否鎖定中 → { locked:boolean, mins?:number }
function checkLocked(data, now = new Date()) {
  const lu = toDate(data && data.loginLockedUntil);
  if (lu && lu > now) return { locked: true, mins: Math.ceil((lu - now) / 60000) };
  return { locked: false };
}

// 密碼錯誤：累計並在達門檻時鎖定 → { locked:boolean, remaining?:number, mins?:number }
async function registerFail(collection, docId, data, now = new Date()) {
  const db = getDb();
  const failCount = ((data && data.loginFailCount) || 0) + 1;
  if (failCount >= MAX_FAIL) {
    const lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60000);
    await db.collection(collection).doc(docId).update({ loginFailCount: failCount, loginLockedUntil: lockUntil });
    return { locked: true, mins: LOCK_MINUTES };
  }
  await db.collection(collection).doc(docId).update({ loginFailCount: failCount });
  return { locked: false, remaining: MAX_FAIL - failCount };
}

// 登入成功：清除計數與鎖定
async function clearFail(collection, docId) {
  const db = getDb();
  await db.collection(collection).doc(docId).update({ loginFailCount: 0, loginLockedUntil: null });
}

module.exports = { checkLocked, registerFail, clearFail, MAX_FAIL, LOCK_MINUTES };
