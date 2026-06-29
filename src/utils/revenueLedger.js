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
  recognitionDate = null, // 營收認列日（課程＝最後一堂課、比賽＝比賽前一天）；未指定＝即時認列(=paidAt)
}) {
  if (!db) db = getDb();
  const now = new Date();
  const receiptNo = `${type.toUpperCase().slice(0, 3)}${now.getTime()}`;
  // recognitionDate 可傳 Date 或 'YYYY-MM-DD' 字串；一律存成 Timestamp。未指定→即時認列＝now
  let recogAt = now;
  if (recognitionDate instanceof Date) recogAt = recognitionDate;
  else if (typeof recognitionDate === 'string' && recognitionDate) recogAt = new Date(recognitionDate + 'T00:00:00+08:00');
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
    recognitionDate: recogAt,   // 報表/日結改以此歸帳（預收期間 recognitionDate 在未來）
    createdAt: now,
    ...(entryFee !== null ? { entryFee } : {}),
    ...(shoesPrice !== null ? { shoesPrice } : {}),
  };
  const ref = await db.collection('transactions').add(txn);
  return { id: ref.id, ...txn };
}

module.exports = { recordTransaction };
