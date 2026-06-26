/**
 * 統一營收紀錄工具
 *
 * 背景：revenue.js 的報表（summary/daily/transactions/export-csv）一律從
 * transactions collection 讀取，且要求欄位為：
 *   { gymId, type, paymentMethod, totalAmount, paidAt(Timestamp),
 *     paymentStatus: 'completed', memberId, memberName, receiptNo }
 *
 * 但過去各收費點各自為政（checkin.js 用 amount/createdAt、courses.js 與
 * passes.js 完全沒寫入 transactions），造成課程/定期票收入永遠是 0，
 * 入場收入也只有 /checkin/phone 這條路徑有紀錄、QR 入場主流程完全沒寫。
 *
 * 統一改用這個函式寫入，type 採用 revenue.js 既有的 TYPE_LABEL 對應：
 *   checkin | pass | course | product | single_entry_ticket | refund | competition
 */
const { getDb } = require('../config/firebase');

async function recordTransaction(db, {
  gymId,
  type,
  totalAmount,
  paymentMethod = 'cash',
  memberId = null,
  memberName = '',
  relatedId = null,
  notes = '',
  staffId = null,
  staffName = '',
  entryFee = null,
  shoesPrice = null,
}) {
  if (!db) db = getDb();
  const now = new Date();
  const receiptNo = `${type.toUpperCase().slice(0, 3)}${now.getTime()}`;
  const txn = {
    gymId,
    type,
    paymentMethod,
    totalAmount,
    memberId,
    memberName,
    relatedId,
    notes,
    staffId,
    staffName,
    receiptNo,
    paymentStatus: 'completed',
    paidAt: now,
    createdAt: now,
    ...(entryFee !== null ? { entryFee } : {}),
    ...(shoesPrice !== null ? { shoesPrice } : {}),
  };
  const ref = await db.collection('transactions').add(txn);
  return { id: ref.id, ...txn };
}

module.exports = { recordTransaction };
