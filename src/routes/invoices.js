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

// GET /invoices/state?gymId= - 查詢目前發票號碼狀態（唯讀，任何已登入員工可看，供結帳/櫃檯核對）
router.get('/state', authenticate, async (req, res) => {
  try {
    const gymId = req.query.gymId || req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const state = await invoiceNumberService.getInvoiceState(gymId);
    res.json({ invoiceState: state });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT /invoices/state - 換捲重設／中途校正（值班 operator 或管理員；見 §5.2.1 三段式權限）
router.put('/state', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const gymId = req.body.gymId || req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const { track, startNumber, reason, force } = req.body;
    const result = await invoiceNumberService.setInvoiceState(
      gymId, { track, startNumber, reason, force: !!force },
      { staffId: req.staff?.id, staffName: req.staff?.name }
    );
    if (result.warning) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    if (err.code) return res.status(400).json(err);
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
    const { gymId, sourceType, refId, memberId, memberName, itemName, amount, taxId, note, issuedAt } = req.body;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const amt = Number(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'INVALID_AMOUNT', message: '發票金額需大於 0' });
    const taxIdVal = taxId ? String(taxId).trim() : '';
    if (taxIdVal && !isValidTaiwanTaxId(taxIdVal)) {
      return res.status(400).json({ error: 'INVALID_TAX_ID', message: '統一編號檢查碼錯誤，請確認號碼是否正確' });
    }
    const allocated = await invoiceNumberService.allocateInvoiceNumber(gymId); // {track, number}
    const db = getDb();
    const id = uuidv4();
    const now = new Date();
    const record = {
      id, sourceType: sourceType || null, refId: refId || null, status: 'issued',
      gymId, memberId: memberId || null, memberName: memberName || '',
      itemName: itemName || '費用', amount: amt,
      track: allocated.track, number: allocated.number, invoiceNo: `${allocated.track}${allocated.number}`,
      taxId: taxIdVal, note: note ? String(note).trim() : '',
      issuedAt: issuedAt ? new Date(issuedAt) : now,
      staffId: req.staff.id, staffName: req.staff.name || '',
      createdAt: now, updatedAt: now,
    };
    await db.collection('invoices').doc(id).set(record);
    res.json({ success: true, invoice: record });
  } catch (err) {
    if (err.code === 'INVOICE_STATE_NOT_CONFIGURED') return res.status(400).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
