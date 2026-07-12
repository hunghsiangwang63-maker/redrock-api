/**
 * 幽靈帳號清除
 * ─────────────────────────────────────────────────────────────────
 * 定義（使用者拍板）：**自助註冊**（registeredBy==='self'）、**註冊滿 15 天寬限期**仍
 * **未完成入場前置**——waiver 未完成 **或** 未簽墜落測驗同意書（任一未完成即算）→ 幽靈帳號。
 *
 * 安全把關（絕不誤刪有價值帳號）：以下任一成立即**跳過保留**——
 *   子帳號 / 攀岩隊員 / VIP / 名下有子女，或名下任一集合有資料
 *   （入場、交易、定期票、各式卡券、課程/體驗/競賽報名、分期、租借、墜測預約/測驗紀錄）。
 * 只有「真的空」的自助帳號才刪：刪 member 本身 + 殘留的未完成 waiver / 墜測同意書簽署。
 *
 * 排程：掛每日 09:00（index.js）——寬限期 15 天、每天檢查（剛註冊者不會被誤刪）。
 */
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');

const DEFAULT_GRACE_DAYS = 15;

// 會員名下「有價值資料」的集合 → 任一有資料即保留不刪（owner 欄位）
const VALUE_COLLECTIONS = [
  ['checkIns', 'memberId'],
  ['transactions', 'memberId'],
  ['memberPasses', 'memberId'],
  ['discountCards', 'ownerMemberId'],
  ['legacyBlackCards', 'memberId'],
  ['legacyDiscountCards', 'memberId'],
  ['singleEntryTickets', 'memberId'],
  ['discountBonuses', 'memberId'],
  ['courseEnrollments', 'memberId'],
  ['experienceBookings', 'memberId'],
  ['competitionRegistrations', 'memberId'],
  ['installmentPlans', 'memberId'],
  ['equipmentRentals', 'memberId'],
  ['fallTestBookings', 'memberId'],
  ['fallTests', 'memberId'],
];

const toDate = (v) =>
  v?.toDate ? v.toDate() : (v?._seconds ? new Date(v._seconds * 1000) : (v ? new Date(v) : null));

// 名下是否有任何有價值資料（子女或任一集合有紀錄）→ 回集合名，無則 null
const findValue = async (db, memberId) => {
  const kids = await db.collection(COLLECTIONS.MEMBERS).where('parentMemberId', '==', memberId).limit(1).get();
  if (!kids.empty) return 'children';
  for (const [coll, field] of VALUE_COLLECTIONS) {
    const s = await db.collection(coll).where(field, '==', memberId).limit(1).get();
    if (!s.empty) return coll;
  }
  return null;
};

// 入場前置是否未完成（任一未完成即 true）
const isOnboardingIncomplete = async (db, memberId) => {
  const w = await db.collection(COLLECTIONS.WAIVERS).doc(memberId).get();
  const waiverComplete = w.exists && w.data().isComplete === true;
  const ft = await db.collection('fallTestSignatures').where('memberId', '==', memberId).limit(1).get();
  const consentSigned = !ft.empty;
  return !waiverComplete || !consentSigned;
};

/**
 * @param {object} opts
 * @param {number} [opts.graceDays=15] 寬限期天數
 * @param {boolean} [opts.commit=true] false＝dry-run 只回候選、不刪
 * @param {number} [opts.limit=1000] 單次最多刪除數（保護）
 * @returns {Promise<{scanned:number, deleted:number, skippedWithValue:number, accounts:Array, commit:boolean}>}
 */
const sweepGhostAccounts = async ({ graceDays = DEFAULT_GRACE_DAYS, commit = true, limit = 1000 } = {}) => {
  const db = getDb();
  const cutoff = dayjs().subtract(graceDays, 'day').toDate();

  // 單一 where（避免複合索引）：自助註冊 → 記憶體過濾 createdAt / 排除保護對象
  const snap = await db.collection(COLLECTIONS.MEMBERS).where('registeredBy', '==', 'self').get();

  const deleted = [];
  let scanned = 0, skippedWithValue = 0;
  for (const doc of snap.docs) {
    const m = doc.data();
    const created = toDate(m.createdAt);
    if (!created || created > cutoff) continue;   // 未滿寬限期
    if (m.isChildAccount) continue;               // 子帳號
    if (m.isTeamMember) continue;                 // 攀岩隊員（含過往）
    if (m.memberType === 'vip') continue;         // VIP
    scanned++;

    if (!(await isOnboardingIncomplete(db, doc.id))) continue; // 前置已完成 → 非幽靈
    const value = await findValue(db, doc.id);
    if (value) { skippedWithValue++; continue; }               // 有資料 → 保留

    if (commit) {
      await db.collection(COLLECTIONS.MEMBERS).doc(doc.id).delete();
      await db.collection(COLLECTIONS.WAIVERS).doc(doc.id).delete().catch(() => {});
      const ftDocs = await db.collection('fallTestSignatures').where('memberId', '==', doc.id).get();
      for (const d of ftDocs.docs) await d.ref.delete();
    }
    deleted.push({ id: doc.id, name: m.name || '', phone: m.phone || '', registeredAt: dayjs(created).format('YYYY-MM-DD') });
    if (deleted.length >= limit) break;
  }

  return { scanned, deleted: deleted.length, skippedWithValue, accounts: deleted, commit };
};

module.exports = { sweepGhostAccounts, DEFAULT_GRACE_DAYS };
