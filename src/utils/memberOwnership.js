const { getDb, COLLECTIONS } = require('../config/firebase');

/**
 * 驗證登入會員（req.member）是否有權代 targetMemberId 操作（本人，或自己的子會員）。
 *
 * 集中原本散落在各路由的重複判斷：「會員只能為自己或子會員報名」。
 * 員工端（req.member 為 undefined）一律放行，權限已由 authenticate/checkPermission 控管。
 *
 * @param {object|undefined} member  req.member（會員登入時存在）
 * @param {string} targetMemberId    欲操作的會員 id
 * @param {object} [opts]
 * @param {number|'allow'} [opts.onMissing=404]
 *        查無 targetMemberId 文件時的處理：
 *          404     → 回 { status:404, body:{ error:'MEMBER_NOT_FOUND' } }
 *          403     → 視為無權，回 403 FORBIDDEN
 *          'allow' → 放行（回 null）
 * @param {string} [opts.message='只能為自己或子會員報名']  403 時的訊息
 * @returns {Promise<null|{status:number, body:object}>}
 *          null 表示允許；否則回傳可直接 res.status(x).json(y) 的物件。
 */
async function checkMemberOwnership(member, targetMemberId, opts = {}) {
  const { onMissing = 404, message = '只能為自己或子會員報名' } = opts;
  if (!member) return null;                      // 員工端呼叫，權限另行控管
  if (targetMemberId === member.id) return null; // 本人

  const forbidden = { status: 403, body: { error: 'FORBIDDEN', message } };
  const snap = await getDb().collection(COLLECTIONS.MEMBERS).doc(targetMemberId).get();
  if (!snap.exists) {
    if (onMissing === 'allow') return null;
    if (onMissing === 403) return forbidden;
    return { status: 404, body: { error: 'MEMBER_NOT_FOUND' } };
  }

  const target = snap.data();
  // 子會員判定以 parentMemberId 或 coParentIds（共同家長）為準（與 /members/my/children 一致）；
  // 不要求 isChildAccount 旗標，避免漏設旗標的子會員讓家長無法代操作（退費/請假/轉移等）。
  const isParent = target.parentMemberId === member.id || (Array.isArray(target.coParentIds) && target.coParentIds.includes(member.id));
  if (!isParent) {
    return forbidden;
  }
  return null; // 為自己的子會員（含共同家長）
}

module.exports = { checkMemberOwnership };
