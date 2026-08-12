/**
 * 發票號碼管理（P2，見 docs/invoice-integration-plan.md §5.2/§5.2.1/§6）
 * GET /invoices/state?gymId=    查詢目前發票號碼狀態
 * PUT /invoices/state           換捲重設／中途校正（值班或管理員）
 *
 * ⚠️ 此檔為「WP-560 實體印表機列印」計畫（第 1-8 節）的號碼管理層，與現行已上線、
 * 走 invoiceRecords 集合的 §9 手動開立發票 modal（invoiceService.js）是不同層次，互不影響。
 * 之後 P3/P4（實際列印接線）、P6（作廢/退貨）、P7（退費報表）皆會擴充此檔。
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireManagerOrStation } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const invoiceNumberService = require('../services/invoiceNumberService');
const { isValidTaiwanTaxId } = require('../utils/taiwanTaxId');
const { taiwanToday } = require('../utils/taiwanDate');
const dayjs = require('dayjs');

// ── 課程/比賽發票「延後開立」時機驗證（2026-08-10 定案，§5.3.3 簡化版）─────────
// 課程/比賽的退費多為部分金額（課程依政府公式算剩餘堂數；比賽依日期分段扣手續費），與 §4.1
// 「作廢＝全額退款」互相衝突——與其做完整的「延後開票」重新設計，先用時機把關降低衝突機率：
// 課程等到「最後一堂」（course.endDate）當天才能開票；比賽提前到「賽事當天前 3 天」開放
// （多數報名的退費時窗此時已過）。仍可能有極少數更晚才發生的退費，那種情況維持人工判斷是否
// 需要作廢（既有的手動作廢按鈕不受此限制），不做自動連動作廢——避免把「部分退費」誤判成
// 「作廢＝全額退」。§9 手動記帳版與 P3 真列印版共用同一份判斷，兩邊都擋。
async function checkInvoiceIssuanceTiming(db, sourceType, refId) {
  const today = taiwanToday();
  if (sourceType === 'course') {
    const enrollDoc = await db.collection('courseEnrollments').doc(refId).get();
    if (!enrollDoc.exists) return; // 查無報名，交由呼叫端的 NOT_FOUND 處理，此處不擋
    const courseDoc = await db.collection('courses').doc(enrollDoc.data().courseId).get();
    const endDate = courseDoc.exists ? courseDoc.data().endDate : null;
    if (endDate && today < endDate) {
      const e = new Error(`此課程最後一堂為 ${endDate}，須等課程結束當天才能開立發票`);
      e.code = 'INVOICE_TOO_EARLY'; throw e;
    }
  } else if (sourceType === 'competition') {
    const regDoc = await db.collection('competitionRegistrations').doc(refId).get();
    if (!regDoc.exists) return;
    const compDoc = await db.collection('competitions').doc(regDoc.data().competitionId).get();
    const eventDate = compDoc.exists ? compDoc.data().eventDate : null;
    if (eventDate) {
      const openFrom = dayjs(eventDate).subtract(3, 'day').format('YYYY-MM-DD');
      if (today < openFrom) {
        const e = new Error(`此賽事為 ${eventDate}，須賽事前 3 天（${openFrom}）起才能開立發票`);
        e.code = 'INVOICE_TOO_EARLY'; throw e;
      }
    }
  }
}

// ── 列印當下對應交易是否仍有效（2026-08-10 定案）──────────────────────────
// 真列印是「先印紙本、印成功才呼叫本端點配號+建紀錄」兩步驟，中間有真實網路延遲——若這個空檔
// 對應的交易被別的動作取消（如另一分頁按了取消入場），紙本已經印出去、號碼也真的消耗掉了。
// 原則（使用者拍板）：紙本已印出＝號碼已消耗，就一定要有紀錄——不能因為交易失效就默默不建紀錄
// （那樣號碼會憑空消失、稽核對不上）。做法：仍建立紀錄，但直接標記為已作廢（status:'void'）並
// 記下原因，讓「已消耗的號碼」永遠查得到對應紀錄，同時清楚標示這筆背後的交易其實已經失效。
async function checkStillValidForInvoice(db, sourceType, refId) {
  if (!sourceType || !refId) return { valid: true };
  try {
    if (sourceType === 'checkin') {
      const doc = await db.collection('checkIns').doc(refId).get();
      if (doc.exists && doc.data().isCancelled) return { valid: false, reason: '入場已取消' };
    } else if (sourceType === 'product') {
      const doc = await db.collection('productSales').doc(refId).get();
      if (doc.exists && doc.data().returned) return { valid: false, reason: '銷售已退貨' };
    } else if (sourceType === 'rental') {
      const doc = await db.collection('equipmentRentals').doc(refId).get();
      if (doc.exists && doc.data().status === 'cancelled') return { valid: false, reason: '租借已取消' };
    } else if (sourceType === 'course') {
      const doc = await db.collection('courseEnrollments').doc(refId).get();
      if (doc.exists && doc.data().status === 'cancelled') return { valid: false, reason: '課程報名已取消' };
    } else if (sourceType === 'competition') {
      const doc = await db.collection('competitionRegistrations').doc(refId).get();
      if (doc.exists && doc.data().status === 'cancelled') return { valid: false, reason: '比賽報名已取消' };
    }
  } catch (e) { console.error('[checkStillValidForInvoice]', sourceType, refId, e.message); }
  return { valid: true };
}

// GET /invoices/state?gymId= - 查詢目前發票號碼狀態（唯讀，任何已登入員工可看，供結帳/櫃檯核對）
// ⚠️ 限當館：非 super_admin 一律用自己登入/值班的館別，不接受前端傳入的 gymId 覆寫
// （比照 dailySettlements.js 既有慣例）——避免士林值班/櫃檯電腦動到新竹的發票號碼。
router.get('/state', authenticate, async (req, res) => {
  try {
    const gymId = req.staff?.role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const state = await invoiceNumberService.getInvoiceState(gymId);
    res.json({ invoiceState: state });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT /invoices/state - 換捲重設／中途校正（值班 operator/站台或管理員；見 §5.2.1 三段式權限；限當館）
router.put('/state', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const gymId = req.staff?.role === 'super_admin' ? (req.body.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const { track, startNumber, reason, force } = req.body;
    const result = await invoiceNumberService.setInvoiceState(
      gymId, { track, startNumber, reason, force: !!force },
      { staffId: req.staff?.id, staffName: req.staff?.name }
    );
    if (result.warning) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    if (err.code) return res.status(400).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// GET /invoices/printing-status?gymId= - 查詢此館是否已開啟「五流程真列印」總開關（見 §6.1）
// 任何已登入員工可查（唯讀）——POS/入場/課程/比賽報名/器材租借五個流程的收款/確認程式碼都會呼叫此端點，
// 決定要走真列印（InvoicePrinter）還是維持現有手動記帳版（InvoiceModal）。
router.get('/printing-status', authenticate, async (req, res) => {
  try {
    const gymId = req.query.gymId || req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const doc = await getDb().collection('gyms').doc(gymId).get();
    const d = doc.exists ? doc.data() : {};
    res.json({
      enabled: !!d.invoicePrintingEnabled,
      changedAt: d.invoicePrintingChangedAt || null,
      changedBy: d.invoicePrintingChangedBy || null,
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT /invoices/printing-status - 開啟/關閉此館「五流程真列印」總開關（僅 super_admin/admin）
// 一次影響 POS/入場/課程/比賽報名/器材租借五個流程；開啟前務必確認該館 local-print-agent 已正式部署、
// 發票號碼（/invoices/state）已設定妥當——這是「這個場館從此開始消耗真實發票號碼＋要求印表機正常運作」的
// 業務開關，不是單純顯示設定，故限管理員以上、不開放值班/場館電腦調整。
router.put('/printing-status', authenticate, async (req, res) => {
  try {
    if (!['super_admin', 'admin'].includes(req.staff?.role)) {
      return res.status(403).json({ error: 'SUPER_ADMIN_REQUIRED', message: '此設定僅系統管理員可調整' });
    }
    const { gymId, enabled } = req.body;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const now = new Date();
    const changedBy = req.staff?.name || null;
    await getDb().collection('gyms').doc(gymId).set({
      invoicePrintingEnabled: !!enabled,
      invoicePrintingChangedAt: now,
      invoicePrintingChangedBy: changedBy,
    }, { merge: true });
    res.json({ success: true, enabled: !!enabled, changedAt: now, changedBy });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /invoices/print-record - 真實列印後的「配號＋建立正式紀錄」（P3 起步；供五流程真列印共用）
// ⚠️ 呼叫順序（前端負責）：一定要先呼叫 local-print-agent 的 /print、確認實際印出成功之後，
// 才呼叫這個端點——印表機失敗時不應消耗真實號碼、也不該留下「印了但沒對應紀錄」的假象。
// 本端點只做「印成功之後」那一半：atomically 配號 + 寫入正式 invoices 集合（與 §9 手動記帳版的
// invoiceRecords 是不同集合，此為第 1-8 節「真實印表機」計畫專用，供日後 P5 結帳自動化讀取）。
router.post('/print-record', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const { sourceType, refId, memberId, memberName, itemName, amount, taxId, note, issuedAt } = req.body;
    // 限當館：非 super_admin 一律用自己登入/值班的館別（五流程既有呼叫本就是自己館，這裡是保險；
    // 「手動開立無來源發票」尤其需要這道權威擋，避免士林操作直接消耗新竹的號碼）
    const gymId = req.staff?.role === 'super_admin' ? (req.body.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const amt = Number(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'INVALID_AMOUNT', message: '發票金額需大於 0' });
    const taxIdVal = taxId ? String(taxId).trim() : '';
    if (taxIdVal && !isValidTaiwanTaxId(taxIdVal)) {
      return res.status(400).json({ error: 'INVALID_TAX_ID', message: '統一編號檢查碼錯誤，請確認號碼是否正確' });
    }
    const db = getDb();
    // ⚠️ 同一筆訂單只能有一張作用中發票（比照 §9 invoiceService.js 對 invoiceRecords 的既有規則）——
    // 擋在配號之前，避免重複點擊「列印發票」白白多印一張紙本、多消耗一個真實發票號碼。前端 RealPrintPanel
    // 開啟表單前也會先查 GET /invoices/active 提前擋下（一般情況根本不會顯示出可點的按鈕），這裡是
    // 後端最後一道防線（雙分頁同時操作等前端擋不住的情境）。
    const existingInvoice = await getActiveRealInvoice(db, sourceType, refId);
    if (existingInvoice) {
      return res.status(409).json({ error: 'ALREADY_INVOICED', message: '此訂單已開立發票，請勿重複列印', invoice: existingInvoice });
    }
    await checkInvoiceIssuanceTiming(db, sourceType, refId); // 課程/比賽延後開立時機把關（其餘 sourceType 不受影響）
    const allocated = await invoiceNumberService.allocateInvoiceNumber(gymId); // {track, number}
    const id = uuidv4();
    const now = new Date();
    // 紙本已於前一步（呼叫端 local-print-agent）印出、號碼已在上一行消耗——不論對應交易此刻是否仍有效，
    // 都要建立紀錄（號碼絕不能憑空消失）；若交易已在印製空檔失效，直接標記作廢並記下原因（見上方
    // checkStillValidForInvoice 說明），而不是默默不建紀錄。
    const validity = await checkStillValidForInvoice(db, sourceType, refId);
    const record = {
      id, sourceType: sourceType || null, refId: refId || null,
      status: validity.valid ? 'issued' : 'void',
      gymId, memberId: memberId || null, memberName: memberName || '',
      itemName: itemName || '費用', amount: amt,
      track: allocated.track, number: allocated.number, invoiceNo: `${allocated.track}${allocated.number}`,
      taxId: taxIdVal, note: note ? String(note).trim() : '',
      issuedAt: issuedAt ? new Date(issuedAt) : now,
      staffId: req.staff.id, staffName: req.staff.name || '',
      createdAt: now, updatedAt: now,
      ...(validity.valid ? {} : {
        voidedAt: now, voidedBy: null, voidedByName: '系統自動判定',
        voidReason: `列印當下對應交易已失效（${validity.reason}），號碼已消耗故仍記錄並直接標記作廢`,
      }),
    };
    await db.collection('invoices').doc(id).set(record);
    // 配號後的紙捲剩餘狀態（僅該館設過紙捲張數時才有意義）——供前端在列印成功畫面同步跳出
    // 「即將用完」醒目警語，不用等下次開設定頁才看到。
    res.json({
      success: true, invoice: record, autoVoided: !validity.valid, invalidReason: validity.valid ? null : validity.reason,
      rollStatus: { remaining: allocated.remaining ?? null, rollLow: !!allocated.rollLow, rollDepleted: !!allocated.rollDepleted },
    });
  } catch (err) {
    if (['INVOICE_STATE_NOT_CONFIGURED', 'INVOICE_TOO_EARLY', 'ROLL_DEPLETED'].includes(err.code)) return res.status(400).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// GET /invoices/active?sourceType=&refId= - 查此訂單目前有沒有「已開立」的真實發票（值班或管理員）
// 供前端 RealPrintPanel 開啟列印表單前先查——查到就直接顯示唯讀摘要（沒有「列印發票」按鈕可按），
// 而不是每次重新打開都又是一份空白可送出的表單。print-record 本身也有這道擋（見上方），此端點
// 純粹是讓前端提前知道、不需要等點下去才被 409 擋回來。
router.get('/active', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const { sourceType, refId } = req.query;
    if (!sourceType || !refId) return res.status(400).json({ error: 'MISSING_FIELDS', message: '缺少 sourceType/refId' });
    const invoice = await getActiveRealInvoice(getDb(), sourceType, refId);
    res.json({ invoice });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /invoices/today?gymId= - 該館今日全部發票（含已作廢），供「系統設定 → 發票號碼管理」頁面
// 直接顯示今日列表用（值班或管理員；限當館，同 /state 慣例）。依列印時間新到舊排序。
router.get('/today', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const gymId = req.staff?.role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const dayjs = require('dayjs');
    const todayStart = dayjs().startOf('day').toDate();
    const todayEnd = dayjs().endOf('day').toDate();
    const tsOf = (v) => v?.toDate ? v.toDate().getTime() : ((v?._seconds || 0) * 1000);
    const snap = await getDb().collection('invoices').where('gymId', '==', gymId).get();
    const invoices = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(inv => { const t = tsOf(inv.issuedAt); return t >= todayStart.getTime() && t <= todayEnd.getTime(); })
      .sort((a, b) => tsOf(b.issuedAt) - tsOf(a.issuedAt));
    res.json({ invoices });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /invoices/lookup?invoiceNo= - 依紙本印出的號碼查詢單張真實發票（供手動作廢 UI 用；值班或管理員）
// ⚠️ 限當館：非 super_admin 查到他館發票一律回 404（非 403）——避免透露「這個號碼存在、只是不是你的館」
// 這種跨館存在性資訊。
router.get('/lookup', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const invoiceNo = String(req.query.invoiceNo || '').trim().toUpperCase();
    if (!invoiceNo) return res.status(400).json({ error: 'MISSING_INVOICE_NO', message: '請輸入發票號碼' });
    const snap = await getDb().collection('invoices').where('invoiceNo', '==', invoiceNo).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此發票號碼' });
    const invoice = { id: snap.docs[0].id, ...snap.docs[0].data() };
    if (req.staff?.role !== 'super_admin' && invoice.gymId !== req.staff?.gymId) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '查無此發票號碼' });
    }
    res.json({ invoice });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// 該館是否已開啟「五流程真列印」總開關（供各流程的取消/退貨自動作廢連動判斷用；GET /printing-status
// 同源）。2026-08-10 定案：作廢自動連動這件事本身也要等該館「實際有列印發票」（此開關開啟）才正式開始
// ——開關關閉時，即使碰巧存在已開立的發票（如尚未正式上線前，店員自行用 §9 手動記帳版開過），取消/退貨
// 也完全不去動它，維持此功能上線前的原本行為。
async function isInvoicePrintingEnabled(db, gymId) {
  if (!gymId) return false;
  const doc = await db.collection('gyms').doc(gymId).get();
  return !!(doc.exists && doc.data().invoicePrintingEnabled === true);
}

// ── 作廢真實發票（P6 起步；§4.1 退貨＝作廢＋全額退款一律綁在一起）──────
// 供①本檔的手動作廢端點 ②各流程的取消/退貨動作自動連動（見 voidRealInvoiceIfIssued）共用。
// 作廢不影響已配發的號碼（號碼永遠不重複使用，符合「跳號」原則）。
//
// ⚠️ 刻意不寫「-發票作廢」結帳加減項（與 §9 invoiceService.js 的 voidInvoice 不同！）：
// §9 手動記帳版的「+發票開立/-發票作廢」加減項機制，是為了補「原本沒有 accrual 記帳」的情境設計的
// （課程/比賽/入場某些流程過去沒有為這筆動作記過帳，靠開發票模擬記一筆）。P3 真實列印版對應的來源
// （POS §7「當下收款當下開票」、以及日後接上的入場/課程/比賽/租借）本身**已經**有各自完整的收款/退款
// accrual 記帳（如 POS 的 recordTransaction type:'product'／退貨時的 type:'product_refund'，這些會
// 自然反映在營收報表與每日結帳「裝備銷售」等欄位裡）——真實發票只是多印一張紙+配號，不是記帳依據。
// 若在此再疊加「-發票作廢」加減項，會與流程本身的退款記帳重複扣款（已用商品退貨 E2E 驗證抓到此問題）。
async function voidRealInvoice(db, id, staffId, staffName, voidReason) {
  const ref = db.collection('invoices').doc(id);
  const doc = await ref.get();
  if (!doc.exists) { const e = new Error('找不到此發票紀錄'); e.code = 'NOT_FOUND'; throw e; }
  const inv = doc.data();
  if (inv.status === 'void') { const e = new Error('此發票已作廢'); e.code = 'ALREADY_VOID'; throw e; }
  const now = new Date();
  await ref.update({
    status: 'void', voidedAt: now, voidedBy: staffId || null, voidedByName: staffName || '',
    voidReason: voidReason ? String(voidReason).trim() : '', updatedAt: now,
  });
  return { ...inv, status: 'void' };
}

// 查該訂單目前是否有「已開立」（未作廢）的真實發票——供①print-record 開票前擋重複開立
// ②voidRealInvoiceIfIssued 找要作廢哪一筆 ③GET /invoices/active 供前端在顯示列印表單前先查，
// 三處共用同一份查詢（同一筆訂單同時最多一張 status:'issued'，比照 §9 invoiceService.js 的
// getActiveInvoice 對 invoiceRecords 集合的既有慣例）。
async function getActiveRealInvoice(db, sourceType, refId) {
  if (!sourceType || !refId) return null;
  const snap = await db.collection('invoices')
    .where('sourceType', '==', sourceType).where('refId', '==', refId).where('status', '==', 'issued').limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// 供各流程取消/退貨動作自動連動作廢（§4.1.3）：查有無對應「已開立」的真實發票，有才作廢；
// 查無或已作廢皆視為冪等成功（不拋錯），不阻斷原本的取消/退貨主流程。
async function voidRealInvoiceIfIssued(db, { sourceType, refId }, staffId, staffName, voidReason) {
  const existing = await getActiveRealInvoice(db, sourceType, refId);
  if (!existing) return null;
  try {
    return await voidRealInvoice(db, existing.id, staffId, staffName, voidReason);
  } catch (e) {
    console.error('[自動連動作廢真實發票失敗]', sourceType, refId, e.message);
    return null;
  }
}

// POST /invoices/:id/void - 手動作廢（值班或管理員；主要供例外/補救情境，日常走各流程自動連動）
// ⚠️ 限當館：非 super_admin 只能作廢自己館別的發票（先查文件比對 gymId 才執行作廢動作）。
router.post('/:id/void', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    if (req.staff?.role !== 'super_admin') {
      const doc = await db.collection('invoices').doc(req.params.id).get();
      if (doc.exists && doc.data().gymId !== req.staff?.gymId) {
        return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '僅能作廢本館發票' });
      }
    }
    const inv = await voidRealInvoice(db, req.params.id, req.staff.id, req.staff.name, req.body.voidReason);
    res.json({ success: true, invoice: inv });
  } catch (err) {
    const map = { NOT_FOUND: 404, ALREADY_VOID: 400 };
    if (err.code && map[err.code]) return res.status(map[err.code]).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
module.exports.voidRealInvoiceIfIssued = voidRealInvoiceIfIssued;
module.exports.isInvoicePrintingEnabled = isInvoicePrintingEnabled;
module.exports.checkInvoiceIssuanceTiming = checkInvoiceIssuanceTiming;
