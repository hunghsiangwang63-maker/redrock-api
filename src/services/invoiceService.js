/**
 * 通用「開立發票」服務（預先建立，待日後發票機串接）。
 * 共用給課程學員（sourceType:'course'，refId=enrollmentId）與比賽報名
 * （sourceType:'competition'，refId=registrationId）。
 * 規則：同一 sourceType+refId 同時最多一張 status:'issued' 的發票；
 * 開立後須先「作廢」（status:'voided'）才能重新開立。
 * 開立/作廢會分別寫入當日結帳「加減項」（＋發票開立／－發票作廢），
 * 不動原本認列的營收交易（避免與 accrual 重複計算）。
 */
const { v4: uuidv4 } = require('uuid');

const COLL = 'invoiceRecords';

const getActiveInvoice = async (db, sourceType, refId) => {
  const snap = await db.collection(COLL)
    .where('sourceType', '==', sourceType).where('refId', '==', refId).where('status', '==', 'issued').limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
};

// 發票號碼＝二聯式統一發票格式：2 碼英文字軌 + 8 碼數字（如 AB12345678）
const TRACK_RE = /^[A-Za-z]{2}$/;
const NUMBER_RE = /^\d{8}$/;

const createInvoice = async (db, {
  sourceType, refId, memberId, memberName, itemName, amount, taxId, note,
  gymId, issuedAt, staffId, staffName, meta, track, number,
}) => {
  const amt = Number(amount);
  if (!(amt > 0)) { const e = new Error('發票金額需大於 0'); e.code = 'INVALID_AMOUNT'; throw e; }
  if (!sourceType || !refId || !memberId) { const e = new Error('缺少必要資訊'); e.code = 'MISSING_FIELDS'; throw e; }
  const trackVal = String(track || '').trim().toUpperCase();
  const numberVal = String(number || '').trim();
  if (!TRACK_RE.test(trackVal)) { const e = new Error('發票字軌須為 2 碼英文字母'); e.code = 'INVALID_TRACK'; throw e; }
  if (!NUMBER_RE.test(numberVal)) { const e = new Error('發票號碼須為 8 碼數字'); e.code = 'INVALID_NUMBER'; throw e; }
  const existing = await getActiveInvoice(db, sourceType, refId);
  if (existing) { const e = new Error('已開立發票，請先作廢後再重新開立'); e.code = 'ALREADY_INVOICED'; throw e; }

  const id = uuidv4();
  const now = new Date();
  const record = {
    id, sourceType, status: 'issued', refId,
    memberId, memberName: memberName || '', gymId: gymId || null,
    itemName: itemName || '費用', amount: amt,
    track: trackVal, number: numberVal, invoiceNo: `${trackVal}${numberVal}`,
    taxId: taxId ? String(taxId).trim() : '', note: note ? String(note).trim() : '',
    issuedAt: issuedAt ? new Date(issuedAt) : now,
    staffId, staffName: staffName || '',
    createdAt: now, updatedAt: now,
    ...(meta || {}),
  };
  await db.collection(COLL).doc(id).set(record);
  // 計入當日營收（結帳加減項；不動原本認列的營收交易）
  try {
    await require('./settlementService').addCashAdjustment({
      gymId: gymId || null, amount: amt, sign: '+', type: '發票開立',
      note: `發票開立：${trackVal}${numberVal}・${memberName || ''}・${itemName || '費用'}${taxId ? '（統編 ' + taxId + '）' : ''}`,
    });
  } catch (e) { console.error('[發票加減項]', e.message); }
  return record;
};

const voidInvoice = async (db, id, staffId, staffName, voidReason) => {
  const ref = db.collection(COLL).doc(id);
  const doc = await ref.get();
  if (!doc.exists) { const e = new Error('找不到此發票紀錄'); e.code = 'NOT_FOUND'; throw e; }
  const inv = doc.data();
  if (inv.status === 'voided') { const e = new Error('此發票已作廢'); e.code = 'ALREADY_VOIDED'; throw e; }
  const now = new Date();
  await ref.update({
    status: 'voided', voidedAt: now, voidedBy: staffId, voidedByName: staffName || '',
    voidReason: voidReason ? String(voidReason).trim() : '', updatedAt: now,
  });
  // 沖銷當日結帳加減項（負向、與開立時對稱；不刪改原始開立紀錄，保留稽核軌跡）
  try {
    await require('./settlementService').addCashAdjustment({
      gymId: inv.gymId || null, amount: inv.amount, sign: '-', type: '發票作廢',
      note: `發票作廢：${inv.invoiceNo || ''}・${inv.memberName || ''}・${inv.itemName || '費用'}（原發票 NT$${inv.amount}）`,
    });
  } catch (e) { console.error('[發票作廢加減項]', e.message); }
  return { ...inv, status: 'voided' };
};

module.exports = { getActiveInvoice, createInvoice, voidInvoice };
