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
const { authenticate, requireManagerOrStation, requireManager } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const invoiceNumberService = require('../services/invoiceNumberService');
const { notifyRoleInGym } = require('../services/notificationService');
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
      const openFrom = dayjs(eventDate).subtract(7, 'day').format('YYYY-MM-DD');
      if (today < openFrom) {
        const e = new Error(`此賽事為 ${eventDate}，須賽事前一週（${openFrom}）起才能開立發票`);
        e.code = 'INVOICE_TOO_EARLY'; throw e;
      }
    }
  } else if (sourceType === 'experience') {
    // 體驗課程/單堂試上：須等活動當天才能開票（2026-08-12 定案）。直接讀當下的 bookingDate——
    // 若活動日期改期過，這裡讀到的就是最新（改期後）的日期，天然「跟上最終日期」，不需要另外處理。
    const doc = await db.collection('experienceBookings').doc(refId).get();
    if (!doc.exists) return;
    const bookingDate = doc.data().bookingDate;
    if (bookingDate && today < bookingDate) {
      const e = new Error(`此預約活動日為 ${bookingDate}，須等活動當天才能開立發票`);
      e.code = 'INVOICE_TOO_EARLY'; throw e;
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
      // ⚠️ 2026-08-21 修正：refId 是 courseRegistrations.payEnrollmentId（報名建立時通常＝第一堂的
      // courseEnrollments doc id）。週課每堂各一筆 courseEnrollments，若「剛好那一堂」因休館/颱風
      // 單獨被取消（cancelReason:'closure' 等，只影響那一場，不影響整期報名——見 closureCancelSession/
      // updateSession 的單堂取消，皆不會連動整筆退課），原本直接查這筆 enrollment doc 的 status 會誤判
      // 「整筆課程報名已取消」，即使其餘場次與整筆報名本身都仍正常有效（真實案例：廖彥澄「小蜘蛛人
      // 初級班」8堂，僅第2堂颱風休館被取消，payEnrollmentId 剛好指向那一堂，其餘7堂與 header 皆
      // confirmed，卻導致當期課程發票被誤判失效自動作廢）。改查 courseRegistrations header（整筆報名
      // 層級的權威狀態，取消整筆報名/駁回退費等才會動到）——查無對應 header（雙寫前的舊資料）才退回
      // 原本直接查該筆 enrollment doc 的邏輯。
      const headerSnap = await db.collection('courseRegistrations').where('payEnrollmentId', '==', refId).limit(1).select('status').get();
      if (!headerSnap.empty) {
        if (headerSnap.docs[0].data().status === 'cancelled') return { valid: false, reason: '課程報名已取消' };
      } else {
        const doc = await db.collection('courseEnrollments').doc(refId).get();
        if (doc.exists && doc.data().status === 'cancelled') return { valid: false, reason: '課程報名已取消' };
      }
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
    const { sourceType, refId, memberId, memberName, itemName, amount, taxId, note, issuedAt, paymentMethod, mergedCheckinIds, amountModified, originalAmount } = req.body;
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
    // 列印當下金額被人工改過（跟預設值不同）一律要求備註說明原因（前端已擋，這裡是後端最後一道防線）——
    // 供結帳頁自動列出「今日發票金額異動」清單，稽核時看得到當初為何金額跟計算值不同。
    const isAmountModified = !!amountModified;
    if (isAmountModified && !(note && String(note).trim())) {
      return res.status(400).json({ error: 'NOTE_REQUIRED', message: '金額已修改，請填寫備註說明原因' });
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
    // 合併列印（refId 本身為 null，上面那道擋不到）——逐一檢查陣列裡每筆入場是否已被開過發票
    // （個別開過，或已被另一張合併發票涵蓋），任一筆已開過就整批擋下，避免同一筆入場費被重複列印。
    if (sourceType === 'checkin_merged' && Array.isArray(mergedCheckinIds) && mergedCheckinIds.length) {
      for (const checkinId of mergedCheckinIds) {
        const dup = await getActiveRealInvoice(db, 'checkin', checkinId);
        if (dup) {
          return res.status(409).json({ error: 'ALREADY_INVOICED', message: `其中一筆入場（id: ${checkinId}）已開立過發票（${dup.invoiceNo}），請重新選取後再試`, invoice: dup });
        }
      }
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
      // 2026-08-15 新增：先前完全沒存這欄（只在下面「無來源現金補入」判斷用完即丟）——結帳頁若要
      // 事後查「這張發票當初收的是哪種付款方式」（如稽核/對帳）查不到；補存，對所有 sourceType 皆存。
      paymentMethod: paymentMethod || null,
      taxId: taxIdVal, note: note ? String(note).trim() : '',
      issuedAt: issuedAt ? new Date(issuedAt) : now,
      staffId: req.staff.id, staffName: req.staff.name || '',
      createdAt: now, updatedAt: now,
      // 列印當下金額是否被人工改過原本計算值（isAmountModified 已含備註必填檢查）；originalAmount
      // 供事後對照「原本應該是多少」，僅在有改過時才有意義。
      ...(isAmountModified ? { amountModified: true, originalAmount: originalAmount != null ? Number(originalAmount) : null } : {}),
      // 合併列印（多筆入場合開一張發票，sourceType:'checkin_merged'、refId:null）——存底下實際合併的
      // checkIns id 陣列供稽核追溯；一般單筆來源的發票此欄位不存在，不影響既有任何邏輯。
      ...(Array.isArray(mergedCheckinIds) && mergedCheckinIds.length ? { mergedCheckinIds } : {}),
      ...(validity.valid ? {} : {
        voidedAt: now, voidedBy: null, voidedByName: '系統自動判定',
        voidReason: `列印當下對應交易已失效（${validity.reason}），號碼已消耗故仍記錄並直接標記作廢`,
      }),
    };
    await db.collection('invoices').doc(id).set(record);

    // 金額被人工改過 → 除了結帳頁自動彙整清單（computeTodayInvoiceAuthority），同時即時通知同館
    // 管理員（歸「結帳」通知分類，比照既有 settlement_difference 現金差異提醒），不用等結帳才知道。
    if (isAmountModified) {
      for (const role of ['gym_manager', 'super_admin']) {
        try {
          await notifyRoleInGym({
            gymId, role, type: 'invoice_amount_modified', title: '發票金額異動',
            body: `${record.invoiceNo}　${itemName || '費用'}　原 NT$${record.originalAmount ?? '?'} → 改為 NT$${amt}${req.staff.name ? `（${req.staff.name}）` : ''}${note ? `／${String(note).trim()}` : ''}`,
            referenceId: id, referenceType: 'invoice', link: '/staff/settlement',
          });
        } catch (e) { console.error('發票金額異動通知失敗', e.message); }
      }
    }

    // 「手動開立發票（無來源）」沒有任何既有訂單/收款流程會把這筆錢記進當日結帳——五個既有流程
    // （入場/課程/比賽/租借/POS）本身各自的收款確認就會記帳，發票號碼是唯一連結（2026-08-12 案例：
    // 兩張無來源發票印出後完全沒進結帳資訊，事後才發現）。
    // ⚠️ 2026-08-15 移除「現金另外記一筆加減項」的做法（原本這裡有一段 addCashAdjustment 呼叫）：
    // 已開真列印的館別（此端點唯一會被呼叫到的情境——見上方 invoiceNumberService.allocateInvoiceNumber
    // 前提），結帳的「現金」是用『發票總金額（invoices 集合逐筆加總，含這張）－線上支付合計』反推，
    // 見 dailySettlements.js 的 effectiveCash/invAuth.actualTotal——這張發票的金額已經算在「發票總金額」
    // 那一側了，若再多寫一筆「+現金補入」加減項會被算兩次（現金多報，實際點鈔會比預期少、誤觸差異
    // 警示）。真正需要補的是「電子支付合計」那一側要知道這張錢不是現金：見
    // dailySettlements.js computeTodayInvoiceAuthority 的 noSourceByMethod（依這裡剛存的 paymentMethod
    // 分組，併入 GET /today 的 payByMethod）——LinePay/街口/台灣Pay/轉帳都會正確從「發票總金額」那
    // 一大坨裡被扣出來歸類，現金則不用另外處理（本來就正確落在「發票總金額－電子支付」剩下的那份）。

    // ⚠️ 2026-08-27：移除原本（2026-08-23 加的）「開票當天補一筆－現金補入沖銷」的做法——課程/比賽
    // 的臨櫃現金在收款確認當下已寫「+現金補入」加減項（transfers.js /:id/confirm、competitions.js
    // /confirm-payment），而這兩類發票的非轉帳付款方式現在於結帳付款統計「無條件」歸「其他」（見
    // dailySettlements.js computeTodayInvoiceAuthority），開票日的 payment.cash 根本不會再算到這筆錢，
    // 沒有東西需要沖銷；若保留沖銷，「移出 cash」＋「－沖銷加減項」會疊加、讓開票當天的應有現金被
    // 雙重扣除（實際點鈔比預期多、出現假的正向差異）。

    // 定期票「在家線上續約」——refId 是那筆 payments 文件 id（見 paymentService.js
    // orderResolvers/orderHandlers.pass_renewal 說明：用付款事件自己的 id 當 refId，避免同一張票
    // 多次續約時撞到前一次已開立的發票、被誤判「已開過」）。開立成功後查回這筆付款對應的 passId，
    // 清除該票的 invoicePending 旗標——之後櫃檯掃碼/確認入場就不會再提示「尚未開發票」。
    if (sourceType === 'pass_renewal' && refId) {
      try {
        const payDoc = await db.collection('payments').doc(refId).get();
        const passId = payDoc.exists ? payDoc.data().orderRef?.passId : null;
        if (passId) {
          await db.collection('memberPasses').doc(passId).update({
            'lastOnlineRenewal.invoicePending': false,
            'lastOnlineRenewal.invoicedAt': new Date(),
          });
        }
      } catch (e) { console.error('[定期票續約開票後清除待開票旗標失敗]', e.message); }
    }

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

// GET /invoices/status?sourceType=&refId= - 純顯示用途：這筆訂單目前有沒有已開立的發票，不論走哪一套
// （真實列印版 invoices，或過渡期尚未開真列印時的 §9 手動記帳版 invoiceRecords）——供五流程「開立發票」
// 固定按鍵在畫面上直接反白顯示狀態＋號碼，不用點進去才看得到。與上面 /active（只查真實版、專門用來
// 擋「不能重複列印」的權威判斷）用途不同、刻意分開，不影響任何實際列印/開票流程。
router.get('/status', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const { sourceType, refId } = req.query;
    if (!sourceType || !refId) return res.status(400).json({ error: 'MISSING_FIELDS', message: '缺少 sourceType/refId' });
    const db = getDb();
    const real = await getActiveRealInvoice(db, sourceType, refId);
    if (real) return res.json({ invoiceNo: real.invoiceNo, amount: real.amount, merged: real.sourceType === 'checkin_merged' });
    const legacy = await require('../services/invoiceService').getActiveInvoice(db, sourceType, refId);
    res.json(legacy ? { invoiceNo: legacy.invoiceNo || '', amount: Number(legacy.amount) || 0 } : { invoiceNo: null, amount: null });
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
  if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
  // 個別入場（sourceType:'checkin'）另外檢查有沒有被「合併列印發票」涵蓋（sourceType:'checkin_merged'，
  // 本身 refId 為 null、實際涵蓋的入場 id 存在 mergedCheckinIds 陣列）——避免已被合併開票的人回頭單獨
  // 查詢時被誤判成「沒開過」而重複再開一張。單一 array-contains 查詢＋記憶體過濾狀態，避免複合索引。
  if (sourceType === 'checkin') {
    const mergedSnap = await db.collection('invoices').where('mergedCheckinIds', 'array-contains', refId).get();
    const found = mergedSnap.docs.find(d => d.data().status === 'issued');
    if (found) return { id: found.id, ...found.data() };
  }
  return null;
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
    // 定期票續約發票唯一的作廢入口就是這條手動路由（未接自動連動作廢，續約無退款/取消機制）——
    // 作廢後代表這張紙本其實沒開成，恢復 invoicePending 讓下次入場再次提示補開，避免真的漏開。
    if (inv.sourceType === 'pass_renewal' && inv.refId) {
      try {
        const payDoc = await db.collection('payments').doc(inv.refId).get();
        const passId = payDoc.exists ? payDoc.data().orderRef?.passId : null;
        if (passId) await db.collection('memberPasses').doc(passId).update({ 'lastOnlineRenewal.invoicePending': true });
      } catch (e) { console.error('[定期票續約發票作廢後恢復待開票旗標失敗]', e.message); }
    }
    res.json({ success: true, invoice: inv });
  } catch (err) {
    const map = { NOT_FOUND: 404, ALREADY_VOID: 400 };
    if (err.code && map[err.code]) return res.status(map[err.code]).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── PUT /invoices/source-payment-method - 開票當下修正付款方式（值班或管理員）─────
// 用途：會員自助流程可能選錯付款方式（如選 LinePay、實際到櫃檯付現金），值班人員在同一個
// 開立發票畫面直接改正並回寫來源記錄，不用另外找該筆訂單的編輯畫面。
//
// 課程（sourceType:'course'）比較特殊：refId 是「主報名」那筆 courseEnrollments 文件 id，
// 對應的 transactions.relatedId 存的卻是 courseId（同一門課全部學員共用同一個值，無法安全
// 定位「唯一一筆」該報名的交易）——這種情況只更正報名記錄本身（含 courseRegistrations
// header，比照既有 receivedAmountOverride 編修同一套雙寫模式），不去動 transactions。
// 其餘四種 sourceType 的 transactions.relatedId 皆等同 refId（1:1，可安全定位），一併更正
// 對應交易的付款方式，讓「今日」（尚未結帳、屬即時計算）的營收/結帳付款方式統計同步反映；
// 已凍結（已結帳）的過去日期快照不會被追溯更動——如需要請走既有「當日再次結帳」機制。
const SOURCE_PM_COLLECTION = { checkin: 'checkIns', rental: 'equipmentRentals', product: 'productSales', competition: 'competitionRegistrations', experience: 'experienceBookings' };
// ⚠️ experience 的收入交易寫 type:'course'（比照課程「教學費」歸類，見 experienceService.js
// recordExperienceRevenue），但 relatedId 存的是 experienceBookings 自己的 id（1:1，非 courseId 那種
// 多筆共用），可安全定位、不會誤傷真正的課程報名交易（那些的 relatedId 存的是 courseId）。
const SOURCE_PM_TXN_TYPE = { checkin: 'checkin', rental: 'rental', product: 'product', competition: 'competition', experience: 'course' };
const VALID_PAYMENT_METHODS = ['cash', 'transfer', 'linepay', 'jkopay', 'taiwanpay'];

router.put('/source-payment-method', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const { sourceType, refId, paymentMethod } = req.body;
    if (!sourceType || !refId) return res.status(400).json({ error: 'MISSING_FIELDS', message: '缺少 sourceType/refId' });
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) return res.status(400).json({ error: 'INVALID_METHOD', message: '付款方式不正確' });
    const db = getDb();
    const now = new Date();

    if (sourceType === 'course') {
      const ref = db.collection('courseEnrollments').doc(refId);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此報名紀錄' });
      const en = doc.data();
      await ref.update({ paymentMethod, updatedAt: now });
      if (en.memberId && en.courseId) {
        try {
          const { updateRegistrationStatusByCourseMember } = require('../services/courseRegistrationService');
          await updateRegistrationStatusByCourseMember(db, en.memberId, en.courseId, { paymentMethod });
        } catch (e) { console.error('[付款方式修正] 課程 header 同步失敗:', e.message); }
      }
      return res.json({ success: true, paymentMethod });
    }

    const coll = SOURCE_PM_COLLECTION[sourceType];
    if (!coll) return res.status(400).json({ error: 'UNSUPPORTED_SOURCE', message: '此來源類型不支援修正付款方式' });
    const ref = db.collection(coll).doc(refId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此紀錄' });
    await ref.update({ paymentMethod, updatedAt: now });

    try {
      const txnType = SOURCE_PM_TXN_TYPE[sourceType];
      const txnSnap = await db.collection('transactions').where('relatedId', '==', refId).where('type', '==', txnType).get();
      if (!txnSnap.empty) {
        const batch = db.batch();
        txnSnap.docs.forEach(d => batch.update(d.ref, { paymentMethod, updatedAt: now }));
        await batch.commit();
      }
    } catch (e) { console.error('[付款方式修正] 交易同步失敗:', e.message); }

    res.json({ success: true, paymentMethod });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /invoices/download?gymId=&from=&to= - 歷史發票號碼詳細資料下載（XLSX；僅管理員）
// 逐筆列出區間內全部發票（含已作廢）——「今日發票列表」只看得到當天，這裡供稽核/對帳查任意區間。
// ⚠️ 權限比照其餘 invoices 端點嚴格一級：requireManager（super_admin/gym_manager），值班/場館電腦不可下載。
const SOURCE_TYPE_LABEL = {
  checkin: '入場', checkin_merged: '入場（合併列印）', product: '商品銷售', rental: '器材租借', competition: '比賽報名',
  course: '課程', experience: '體驗課程／試上', null: '手動開立（無來源）',
};
router.get('/download', authenticate, requireManager, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const gymId = req.staff?.role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定館別' });
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : dayjs().startOf('month').format('YYYY-MM-DD');
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : dayjs().format('YYYY-MM-DD');
    const rangeStart = dayjs(`${from}T00:00:00+08:00`).toDate();
    const rangeEnd = dayjs(`${to}T23:59:59+08:00`).toDate();
    const tsOf = (v) => v?.toDate ? v.toDate().getTime() : ((v?._seconds || 0) * 1000);
    const fmtTs = (v) => v ? dayjs(tsOf(v)).format('YYYY/MM/DD HH:mm') : '';

    const snap = await getDb().collection('invoices').where('gymId', '==', gymId).get();
    const rows = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(inv => { const t = tsOf(inv.issuedAt); return t >= rangeStart.getTime() && t <= rangeEnd.getTime(); })
      .sort((a, b) => tsOf(a.issuedAt) - tsOf(b.issuedAt));

    const aoa = [['開立日期時間', '發票號碼', '狀態', '來源類型', '品項', '金額', '會員', '統編', '備註', '經手人', '作廢時間', '作廢人', '作廢原因']];
    rows.forEach(inv => {
      aoa.push([
        fmtTs(inv.issuedAt), inv.invoiceNo || `${inv.track || ''}${inv.number || ''}`,
        inv.status === 'void' ? '已作廢' : '已開立',
        SOURCE_TYPE_LABEL[inv.sourceType] || inv.sourceType || '手動開立（無來源）',
        inv.itemName || '', inv.amount ?? '', inv.memberName || '', inv.taxId || '', inv.note || '',
        inv.staffName || '', inv.status === 'void' ? fmtTs(inv.voidedAt) : '', inv.status === 'void' ? (inv.voidedByName || '') : '',
        inv.status === 'void' ? (inv.voidReason || '') : '',
      ]);
    });

    const ws = require('../utils/xlsxSafe').sanitizeSheet(XLSX.utils.aoa_to_sheet(aoa));
    ws['!cols'] = [{ wch:16 }, { wch:12 }, { wch:8 }, { wch:16 }, { wch:20 }, { wch:10 }, { wch:12 }, { wch:12 }, { wch:24 }, { wch:10 }, { wch:16 }, { wch:10 }, { wch:24 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '發票明細');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const gymSlug = gymId === 'gym-hsinchu' ? 'hsinchu' : gymId === 'gym-shilin' ? 'shilin' : 'all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="invoices_${gymSlug}_${from}_${to}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
module.exports.voidRealInvoiceIfIssued = voidRealInvoiceIfIssued;
module.exports.isInvoicePrintingEnabled = isInvoicePrintingEnabled;
module.exports.checkInvoiceIssuanceTiming = checkInvoiceIssuanceTiming;
module.exports.getActiveRealInvoice = getActiveRealInvoice;
