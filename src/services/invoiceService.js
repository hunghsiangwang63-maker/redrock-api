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
const { isValidTaiwanTaxId } = require('../utils/taiwanTaxId');

const COLL = 'invoiceRecords';

// 這些來源類型的錢，在開發票這一刻早就已經透過別的管道正確計入今日結帳
// （rental_addon：金額本就存在對應 checkIns 文件、結帳頁即時重新掃描；
//  pass_renewal：付款當下已由 recordTransaction 記為電子支付）——create/void
// 都要一起跳過現金加減項，否則同一筆錢會被重複計算。集中定義於此，讓 create 與
// void 讀同一份判斷依據，避免像過去那樣「開立時記得跳過、作廢時忘記」的不對稱。
const DOUBLE_COUNTED_SOURCE_TYPES = new Set(['rental_addon', 'pass_renewal']);

// 是否該記現金加減項：呼叫端明確要求跳過 → 一律跳過；來源類型本就雙重計算 → 跳過；
// 呼叫端有告知真實付款方式且不是現金 → 跳過（這筆錢沒有進抽屜，不該記現金異動）；
// 其餘（含呼叫端未帶 paymentMethod，向下相容尚未遷移的呼叫點）→ 維持記帳。
const shouldSkipCashAdjustment = (sourceType, paymentMethod, explicitSkip) =>
  !!explicitSkip || DOUBLE_COUNTED_SOURCE_TYPES.has(sourceType) || (paymentMethod != null && paymentMethod !== 'cash');

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
  // 2026-08-15 新增：這筆訂單的錢是否「已經」透過其他即時查詢管道算進今日結帳（例如補租器材，
  // 金額本就存在對應 checkIns 文件的 amountPaid/paymentMethod，結帳頁 GET /today 會直接重新掃描
  // checkIns 算出來，不看這裡有沒有開過發票）——這種情況再叫下面的 addCashAdjustment 多記一筆
  // 「+發票開立」加減項會把同一筆錢算兩次。預設 false（維持既有 course/competition/checkin 呼叫端
  // 沒改過的行為，不評斷/不動它們現有的正確性），只有呼叫端明確知道會重複時才傳 true 跳過。
  skipCashAdjustment = false,
  // 2026-09-13 新增：這筆訂單實際的付款方式（選填，向下相容——未帶值時完全維持舊行為，一律當現金
  // 記加減項）。有帶值且不是 'cash' 時（轉帳/LinePay/街口/台灣Pay），代表這筆錢沒有進抽屜，不該記
  // 「+發票開立」現金加減項，否則會跟今天陳錦漩工作坊保證金同一種 bug——無條件當現金導致當日現金
  // 虛增。存進發票紀錄本身，供 voidInvoice 作廢時讀同一個值對稱判斷，呼叫端不用在作廢時再傳一次。
  paymentMethod,
}) => {
  const amt = Number(amount);
  if (!(amt > 0)) { const e = new Error('發票金額需大於 0'); e.code = 'INVALID_AMOUNT'; throw e; }
  // memberId 選填：POS 銷售常見匿名交易（無會員綁定），此類發票允許 memberId 為 null
  if (!sourceType || !refId) { const e = new Error('缺少必要資訊'); e.code = 'MISSING_FIELDS'; throw e; }
  const trackVal = String(track || '').trim().toUpperCase();
  const numberVal = String(number || '').trim();
  // 2026-08-26：比賽報名不需要對應實體發票號碼（這套§9手動記帳版本就「預先建立、尚未串接發票機」，
  // track/number 純屬佔位標記——見上方檔頭說明，無真正序號配發/查重）——空值就跳過驗證，其餘四個
  // sourceType（course/checkin/rental/rental_addon/product 等）維持原本嚴格要求 2碼英文+8碼數字。
  if (!(sourceType === 'competition' && !trackVal && !numberVal)) {
    if (!TRACK_RE.test(trackVal)) { const e = new Error('發票字軌須為 2 碼英文字母'); e.code = 'INVALID_TRACK'; throw e; }
    if (!NUMBER_RE.test(numberVal)) { const e = new Error('發票號碼須為 8 碼數字'); e.code = 'INVALID_NUMBER'; throw e; }
  }
  const taxIdVal = taxId ? String(taxId).trim() : '';
  if (taxIdVal && !isValidTaiwanTaxId(taxIdVal)) { const e = new Error('統一編號檢查碼錯誤，請確認號碼是否正確'); e.code = 'INVALID_TAX_ID'; throw e; }
  const existing = await getActiveInvoice(db, sourceType, refId);
  if (existing) { const e = new Error('已開立發票，請先作廢後再重新開立'); e.code = 'ALREADY_INVOICED'; throw e; }

  const id = uuidv4();
  const now = new Date();
  const record = {
    id, sourceType, status: 'issued', refId,
    memberId: memberId || null, memberName: memberName || '', gymId: gymId || null,
    itemName: itemName || '費用', amount: amt,
    track: trackVal, number: numberVal, invoiceNo: `${trackVal}${numberVal}`,
    taxId: taxIdVal, note: note ? String(note).trim() : '',
    issuedAt: issuedAt ? new Date(issuedAt) : now,
    staffId, staffName: staffName || '',
    paymentMethod: paymentMethod || null,
    createdAt: now, updatedAt: now,
    ...(meta || {}),
  };
  await db.collection(COLL).doc(id).set(record);
  // 計入當日營收（結帳加減項；不動原本認列的營收交易）——見上方 shouldSkipCashAdjustment 判斷式
  if (!shouldSkipCashAdjustment(sourceType, paymentMethod, skipCashAdjustment)) {
    try {
      const invNoLabel = (trackVal || numberVal) ? `${trackVal}${numberVal}・` : '';
      await require('./settlementService').addCashAdjustment({
        gymId: gymId || null, amount: amt, sign: '+', type: '發票開立',
        note: `發票開立：${invNoLabel}${memberName || ''}・${itemName || '費用'}${taxId ? '（統編 ' + taxId + '）' : ''}`,
      });
    } catch (e) { console.error('[發票加減項]', e.message); }
  }
  return record;
};

// skipCashAdjustment：呼叫端仍可明確要求跳過（沿用既有參數、行為不變）；但現在**不再是唯一依據**——
// 這裡改讀 shouldSkipCashAdjustment(inv.sourceType, inv.paymentMethod, skipCashAdjustment)，用開立
// 當下就已經存在發票紀錄上的 sourceType/paymentMethod 自動比照 createInvoice 當時的判斷結果，呼叫端
// 不需要（也不太可能）在作廢時重新正確傳一次同樣的旗標。修掉一個既有的真實不對稱 bug：rental_addon
// 的開立有傳 skipCashAdjustment:true，但共用的通用作廢路由從未傳過，作廢時會誤記「－發票作廢」。
const voidInvoice = async (db, id, staffId, staffName, voidReason, { skipCashAdjustment = false } = {}) => {
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
  if (!shouldSkipCashAdjustment(inv.sourceType, inv.paymentMethod, skipCashAdjustment)) {
    try {
      const invNoLabel = inv.invoiceNo ? `${inv.invoiceNo}・` : '';
      await require('./settlementService').addCashAdjustment({
        gymId: inv.gymId || null, amount: inv.amount, sign: '-', type: '發票作廢',
        note: `發票作廢：${invNoLabel}${inv.memberName || ''}・${inv.itemName || '費用'}（原發票 NT$${inv.amount}）`,
      });
    } catch (e) { console.error('[發票作廢加減項]', e.message); }
  }
  return { ...inv, status: 'voided' };
};

module.exports = { getActiveInvoice, createInvoice, voidInvoice };
