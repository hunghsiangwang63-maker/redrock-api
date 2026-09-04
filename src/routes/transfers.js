/**
 * 轉帳確認
 * POST /transfers/upload      上傳截圖
 * GET  /transfers/pending     待確認列表（工作人員）
 * PUT  /transfers/:id/confirm 確認收款
 * PUT  /transfers/:id/reject  拒絕
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate, authenticateAny } = require('../middleware/auth');
const { getDb, getStorage } = require('../config/firebase');
const { checkMemberOwnership } = require('../utils/memberOwnership');
const { v4: uuidv4 } = require('uuid');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// 可「退回待補正」的訂單型別 → 底層集合。退回時標記 transfer_rejected（保留訂單、不釋放）；
// 重新上傳時清標記回 pending_confirm；確認收款時清標記為 confirmed。team_member 不納入（活動化流程另計）。
const REJECTABLE_COLL = {
  course: 'courseEnrollments',
  experience: 'experienceBookings',
  competition: 'competitionRegistrations',
  rental: 'equipmentRentals',
  team_member: 'teamApplications',  // 入隊申請：退回→已退回＋通知會員；補正→回待審核
};

// POST /transfers/upload - 會員提交轉帳待確認（截圖或填寫資料皆可，擇一即可）
router.post('/upload', authenticateAny, upload.single('screenshot'), async (req, res) => {
  try {
    const db = getDb();
    const id = uuidv4();
    const {
      memberName, gymId, enrollmentId, courseId, courseName, amount,
      orderType, refId, orderName, bankLastFive, bankName, paymentDate, paidAmount,
    } = req.body;
    // 會員 token 一律用自己的 id，避免偽造他人 memberId
    const memberId = req.member?.id || req.body.memberId;

    // 轉帳一律要求：銀行名稱 + 轉帳日期 + 末五碼 + 實際匯款金額（截圖選填）
    const last5 = (bankLastFive || '').trim();
    const payDate = (paymentDate || '').trim();
    const bank = (bankName || '').trim();
    if (!bank) return res.status(400).json({ error: 'MISSING_BANK_NAME', message: '請填寫匯款銀行名稱' });
    if (!payDate) return res.status(400).json({ error: 'MISSING_PAYMENT_DATE', message: '請填寫轉帳日期' });
    if (!last5) return res.status(400).json({ error: 'MISSING_BANK_LAST_FIVE', message: '請填寫匯款帳號末五碼' });
    if (!(Number(paidAmount) > 0)) return res.status(400).json({ error: 'MISSING_PAID_AMOUNT', message: '請填寫實際匯款金額' });

    const resolvedOrderType = orderType || (enrollmentId ? 'course' : null);
    const resolvedRefId = refId || enrollmentId || null;

    // 補正：會員只能為自己/子女的訂單上傳（在建立轉帳單前先驗證，避免產生孤兒單）。
    // 適用 course/experience/competition/rental；有訂單且帶 memberId 才驗擁有權。
    let linkedOrder = null;
    const linkedColl = REJECTABLE_COLL[resolvedOrderType];
    if (linkedColl && resolvedRefId) {
      const oDoc = await db.collection(linkedColl).doc(resolvedRefId).get();
      if (oDoc.exists) {
        linkedOrder = oDoc.data();
        if (req.member && linkedOrder.memberId) {
          const deny = await checkMemberOwnership(req.member, linkedOrder.memberId, { onMissing: 'allow' });
          if (deny) return res.status(deny.status).json(deny.body);
        }
      }
    }

    // 課程層可限定付款方式（如運動按摩僅接受現場現金，不論隊員或非隊員）——前端只是隱藏轉帳選項，
    // 這裡才是權威把關：課程明確設定 paymentMethods 且不含 transfer 時，一律擋下轉帳提交。
    if (resolvedOrderType === 'course' && linkedOrder?.courseId) {
      const courseDoc = await db.collection('courses').doc(linkedOrder.courseId).get();
      const allowedMethods = courseDoc.exists ? courseDoc.data().paymentMethods : null;
      if (Array.isArray(allowedMethods) && allowedMethods.length && !allowedMethods.includes('transfer')) {
        return res.status(400).json({ error: 'TRANSFER_NOT_ALLOWED', message: '此課程僅接受現場現金繳納，不接受轉帳' });
      }
    }

    // 有截圖才上傳到 Firebase Storage
    let url = null, fileName = null;
    if (req.file) {
      const storage = getStorage();
      const bucket = storage.bucket();
      fileName = `transfers/${id}_${Date.now()}.jpg`;
      const file = bucket.file(fileName);
      await file.save(req.file.buffer, { metadata: { contentType: req.file.mimetype } });
      [url] = await file.getSignedUrl({ action: 'read', expires: '2030-01-01' });
    }

    // 建立轉帳紀錄
    const now = new Date();
    const transfer = {
      id, memberId, memberName: memberName || '',
      gymId,
      // 訂單型別（course/experience/...）；相容舊欄位 enrollmentId/courseId
      orderType: orderType || (enrollmentId ? 'course' : null),
      refId: refId || enrollmentId || null,
      orderName: orderName || courseName || '',
      enrollmentId: enrollmentId || null,
      courseId: courseId || null, courseName: courseName || '',
      amount: Math.max(0, Math.min(parseInt(amount) || 0, 1000000)), // clamp：非負、上限 100 萬（防負數/超大值污染報表）
      paymentMethod: 'transfer',
      screenshotUrl: url, screenshotPath: fileName,   // 無截圖則為 null
      bankLastFive: last5 || null,
      paidAmount: paidAmount ? Number(paidAmount) : null, // 會員自填實際匯款金額
      bankName: (bankName || '').trim() || null,
      paymentDate: paymentDate || null,
      status: 'pending',
      submittedAt: now, createdAt: now, updatedAt: now,
    };
    await db.collection('transferRecords').doc(id).set(transfer);

    // 上傳/重新上傳轉帳 → 訂單回「待確認」(pending_confirm)、清除退回標記；
    // 【course 不重設 paymentDeadline】（沿用報名時原期限，退回→補正不延長時間）。
    if (linkedOrder && linkedColl && resolvedRefId) {
      try {
        await db.collection(linkedColl).doc(resolvedRefId).update({
          paymentStatus: 'pending_confirm',
          ...(paidAmount ? { memberPaidAmount: Number(paidAmount) } : {}),  // 會員自填實際匯款金額（名單/確認顯示）
          ...(resolvedOrderType === 'team_member' ? { status: 'pending' } : {}),
          paymentRejectReason: null,
          paymentRejectedAt: null,
          paymentConfirmed: false,
          updatedAt: now,
        });
        // 雙寫（Phase 1）：課程訂單連動更新 header 的 memberPaidAmount/paymentConfirmed
        if (resolvedOrderType === 'course' && linkedOrder.memberId && linkedOrder.courseId) {
          try {
            const { updateRegistrationStatusByCourseMember } = require('../services/courseRegistrationService');
            await updateRegistrationStatusByCourseMember(db, linkedOrder.memberId, linkedOrder.courseId, {
              paymentStatus: 'pending_confirm',
              ...(paidAmount ? { memberPaidAmount: Number(paidAmount) } : {}),
              paymentConfirmed: false,
            });
          } catch (e2) { console.error('[雙寫] header 轉帳上傳更新失敗（不影響上傳）:', e2.message); }
        }
      } catch (e) { console.error('transfer upload link:', e.message); }
    }

    res.status(201).json({ transfer, message: '已提交，等待工作人員確認收款' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// GET /transfers/pending - 待確認列表
router.get('/pending', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? req.query.gymId : req.staff?.gymId;
    let ref = db.collection('transferRecords').where('status', '==', 'pending');
    if (gymId) ref = ref.where('gymId', '==', gymId);
    const snap = await ref.get();
    res.json({ transfers: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT /transfers/:id/confirm
router.put('/:id/confirm', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('transferRecords').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此轉帳紀錄' });
    const t = doc.data();
    // 付款方式更正（2026-08-29）：確認收款當下可一併更正選錯的付款方式（會員選現金實刷 LinePay 等，
    // 8/16 陳以恩、8/27 洪家兄弟等真實案例先前都只能事後手動修資料）——同步寫進轉帳單＋訂單＋記帳。
    const PM_ALLOWED = ['cash', 'transfer', 'linepay', 'jkopay', 'taiwanpay'];
    const pmOverride = (req.body.paymentMethod && PM_ALLOWED.includes(req.body.paymentMethod) && req.body.paymentMethod !== t.paymentMethod)
      ? req.body.paymentMethod : null;
    const pm = pmOverride || t.paymentMethod;
    const isManager = ['super_admin', 'gym_manager'].includes(req.staff?.role);
    const isStationMode = ['operator', 'station'].includes(req.staff?.type);
    // 付款方式更正僅限管理員（2026-08-29 拍板；值班/其他員工不開放——明確 403、不靜默忽略，
    // 避免「以為改了其實沒改」）。
    if (pmOverride && !isManager) {
      return res.status(403).json({ error: 'MANAGER_REQUIRED', message: '付款方式更正限管理員' });
    }
    // 收款確認權限（原規則不變）：現金→值班 operator 或管理員；其他（轉帳等）→僅管理員。
    if (t.paymentMethod === 'cash') {
      if (!isManager && !isStationMode) return res.status(403).json({ error: 'MANAGER_OR_STATION_REQUIRED', message: '現金收款確認限值班人員或管理員' });
    } else {
      if (!isManager) return res.status(403).json({ error: 'MANAGER_REQUIRED', message: '轉帳收款確認限管理員' });
    }
    if (t.status === 'confirmed') return res.json({ message: '已確認收款' }); // 冪等：避免重複確認
    const now = new Date();

    // 硬化：確認收款前先檢查連動訂單是否存在，避免「轉帳已標確認、訂單卻沒開通」
    const ORDER_COLL = {
      experience: 'experienceBookings', course: 'courseEnrollments',
      competition: 'competitionRegistrations', rental: 'equipmentRentals', team_member: 'teamApplications',
    };
    if (t.orderType && t.refId && ORDER_COLL[t.orderType]) {
      const orderSnap = await db.collection(ORDER_COLL[t.orderType]).doc(t.refId).get();
      if (!orderSnap.exists) {
        return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: '查無對應的訂單（可能已刪除），無法確認收款。如需處理請改用「退回」。' });
      }
    }

    // 管理員可編輯備註（選填；留空不動既有值，避免無意間清空先前備註）
    const noteUpdate = req.body.staffNote != null ? { staffNote: String(req.body.staffNote).trim() } : {};
    const pmUpdate = pmOverride ? { paymentMethod: pmOverride } : {};
    await ref.update({
      status: 'confirmed', confirmedBy: req.staff.id,
      confirmedAt: now, updatedAt: now, notes: req.body.notes || '',
      confirmedAmount: req.body.confirmedAmount != null && req.body.confirmedAmount !== '' ? Number(req.body.confirmedAmount) : null, // 員工填實際收款金額
      ...noteUpdate,
      ...(pmOverride ? { paymentMethod: pmOverride, paymentMethodCorrected: { from: t.paymentMethod, by: req.staff.id, byName: req.staff.name || '', at: now } } : {}),
    });
    // 依訂單型別確認底層付款（side-effect 失敗不阻斷收款確認）
    try {
      const by = req.staff.id, byName = req.staff.name;
      // 確認收款一律清掉退回/待補正標記（paymentConfirmed:true、清 paymentRejectReason），
      // 避免曾被退回的訂單確認後仍殘留 transfer_rejected/pending_confirm 狀態。
      const clearReject = { paymentConfirmed: true, paymentRejectReason: null, paymentRejectedAt: null };
      if (t.orderType === 'experience' && t.refId) {
        const bkRef = db.collection('experienceBookings').doc(t.refId);
        // 轉帳確認這條路徑原本完全沒有寄「已確認收款」通知信給會員（只有走待辦頁「體驗預約詳情」
        // 彈窗、POST /experience-bookings/:id/confirm 那條路徑才會寄）——course/competition 兩個
        // orderType 分支都有寄、唯獨 experience 沒有，屬遺漏。補上，並比照 experienceBookings.js
        // 那邊的作法：讀取異動前的原始狀態，只在「這次真的從未確認過」才寄一次，避免重複確認/
        // 之後改教練等後續動作誤觸重寄。
        const bkDocBefore = await bkRef.get();
        const wasAlreadyConfirmed = bkDocBefore.exists && bkDocBefore.data().status === 'confirmed';
        await bkRef.update({
          status: 'confirmed', paymentStatus: 'confirmed', ...clearReject, ...noteUpdate, ...pmUpdate,
          confirmedBy: by, confirmedByName: byName, confirmedAt: now, updatedAt: now,
        });
        // 體驗/試上營收記錄（與 /experience-bookings/:id/confirm 同一 helper、冪等）
        try {
          const bkDoc = await bkRef.get();
          if (bkDoc.exists) {
            const bk = { id: bkDoc.id, ...bkDoc.data() };
            const { recordExperienceRevenue, syncExperienceTickets } = require('../services/experienceService');
            await recordExperienceRevenue(db, bkRef, bk, req.staff);
            // 試上：確認收款自動發 1 張當日體驗券（冪等；當日豁免墜測）。一般體驗維持員工手動發放。
            if (bk.kind === 'trial') await syncExperienceTickets(db, bk, req.staff, true).catch(e => console.error('[試上發券/transfers]', e.message));
            if (!wasAlreadyConfirmed && bk.contactEmail) {
              const gymDoc = await db.collection('gyms').doc(bk.gymId).get();
              const gymCc = gymDoc.exists ? gymDoc.data().email : undefined;
              require('../services/emailService').sendExperienceBookingConfirmation(bk.contactEmail, bk.contactName, bk, gymCc)
                .catch(e => console.error('[Email] 體驗轉帳確認通知', e.message));
            }
          }
        } catch (e) { console.error('[體驗營收/transfers]', e.message); }
      } else if (t.orderType === 'course' && t.refId) {
        // 課程營收已於報名時(courses.js enroll, deferPayment=false)記入(認列＝最後一堂課)，此處僅標記付款確認
        await db.collection('courseEnrollments').doc(t.refId).update({ paymentStatus: 'confirmed', ...clearReject, ...noteUpdate, ...pmUpdate, updatedAt: now });
        // 付款方式更正：課程營收在報名當下已記帳（accrual）→ 一併回改既有交易（比照 8/27 手動修正的範圍）
        if (pmOverride) {
          try {
            const txSnap = await db.collection('transactions').where('relatedId', '==', t.refId).get();
            const batch = db.batch();
            let n = 0;
            txSnap.docs.forEach(d => { if (d.data().type === 'course' && (d.data().totalAmount || 0) > 0) { batch.update(d.ref, { paymentMethod: pmOverride, updatedAt: now }); n++; } });
            if (n) await batch.commit();
          } catch (e) { console.error('付款方式更正回改課程交易失敗（收款已確認）:', e.message); }
        }
        // 定期票 × 課程免費期間重疊補償（政策 2026-07-17；收款確認後才套、冪等、不阻斷）
        try {
          const enDoc = await db.collection('courseEnrollments').doc(t.refId).get();
          if (enDoc.exists) {
            const en = enDoc.data();
            await require('../services/passOverlapService').applyCourseOverlapPassExtension({ memberId: en.memberId, courseId: en.courseId });
            // 雙寫（Phase 1）：連動更新 header 的 paymentStatus（+staffNote，若這次有填）
            try {
              const { updateRegistrationStatusByCourseMember } = require('../services/courseRegistrationService');
              await updateRegistrationStatusByCourseMember(db, en.memberId, en.courseId, {
                paymentStatus: 'confirmed', paymentConfirmed: true,
                ...(noteUpdate.staffNote !== undefined ? { staffNote: noteUpdate.staffNote } : {}),
              });
            } catch (e2) { console.error('[雙寫] header 付款確認更新失敗（不影響收款確認）:', e2.message); }
            // 工作坊保證金：收款確認當下才記入抽屜（比照器材租借押金收取時機，非報名當下）；冪等
            if (Number(en.depositAmount) > 0 && !en.depositCollectedAdjDone) {
              try {
                await require('../services/settlementService').addCashAdjustment({
                  gymId: en.gymId, sign: '+', type: '保證金收取', amount: en.depositAmount,
                  note: `${en.memberName || ''}（${en.courseName || ''}）`,
                });
                await db.collection('courseEnrollments').doc(t.refId).update({ depositCollectedAdjDone: true, updatedAt: now });
              } catch (e3) { console.error('保證金收取記帳失敗（收款已確認）:', e3.message); }
            }
          }
        } catch (e) { console.error('課程重疊補償失敗（收款已確認）:', e.message); }
        // 課程/工作坊確認收款通知信（運動按摩附注意事項；附場次清單）
        try {
          const enDoc2 = await db.collection('courseEnrollments').doc(t.refId).get();
          const en2 = enDoc2.exists ? enDoc2.data() : {};
          const cDoc = en2.courseId ? await db.collection('courses').doc(en2.courseId).get() : null;
          const c2 = cDoc && cDoc.exists ? cDoc.data() : {};
          const _rn = require('../services/registrationNotify');
          const itemName = c2.name || t.courseName || en2.courseName || '課程';
          // 該報名對象此課程的場次清單（非取消、非補課/試上；依日期排序）
          // ⚠ 用 en2.memberId（該筆報名記錄本身的擁有者）而非 t.memberId：家長代子女報名時，
          // transferRecords.memberId 出於防偽造安全考量固定是登入會員本人（家長），
          // 但實際報名對象（courseEnrollments.memberId）才是子女——若用 t.memberId 查場次會查到 0 筆。
          let sessions = null;
          if (en2.courseId && en2.memberId) {
            const enAll = await db.collection('courseEnrollments')
              .where('courseId', '==', en2.courseId).where('memberId', '==', en2.memberId)
              .where('status', 'in', ['confirmed', 'leave'])
              .select('date', 'startTime', 'endTime', 'isMakeup', 'isTrial').get();
            sessions = enAll.docs.map(d => d.data()).filter(e => !e.isMakeup && !e.isTrial && e.date)
              .map(e => ({ date: e.date, startTime: e.startTime, endTime: e.endTime }))
              .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));
          }
          _rn.notifyRegConfirmed({
            // memberId 改用 en2.memberId（實際報名對象，可能是子會員）——registrationNotify 的
            // resolveMemberEmails 對子會員會解析「主家長＋全部共同家長」的 email，兩邊都收得到；
            // 若只用上傳轉帳單的 t.memberId（登入操作者），共同家長中沒操作的那位會收不到。
            memberId: en2.memberId || t.memberId, memberName: en2.memberName || t.memberName || '',
            typeLabel: c2.type === 'workshop' ? '工作坊' : '課程',
            itemName, gymId: t.gymId || c2.gymId, massage: _rn.isMassage(itemName),
            sessions,
          });
        } catch (e) { console.error('[Email] 課程確認通知', e.message); }
      } else if (t.orderType === 'competition' && t.refId) {
        await db.collection('competitionRegistrations').doc(t.refId).update({
          paymentStatus: 'confirmed', ...clearReject, ...noteUpdate, ...pmUpdate, paidAt: now, paidConfirmedBy: by, paidConfirmedByName: byName, updatedAt: now,
        });
        // 記比賽營收（預收，認列在比賽前一天）；helper 冪等
        try { await require('../services/competitionService').recordCompetitionRevenue({ db, regId: t.refId, sign: 1, staffId: by, staffName: byName }); }
        catch (e) { console.error('比賽轉帳記帳失敗', e.message); }
        // 比賽確認收款通知信
        try {
          const regDoc = await db.collection('competitionRegistrations').doc(t.refId).get();
          const reg = regDoc.exists ? regDoc.data() : {};
          const compDoc = reg.competitionId ? await db.collection('competitions').doc(reg.competitionId).get() : null;
          const comp = compDoc && compDoc.exists ? compDoc.data() : {};
          require('../services/registrationNotify').notifyRegConfirmed({
            to: reg.email, memberId: t.memberId, memberName: reg.name || t.memberName || '',
            typeLabel: '比賽', itemName: comp.name || t.orderName || '比賽', gymId: comp.gymId || t.gymId, massage: false,
          });
        } catch (e) { console.error('[Email] 比賽確認通知', e.message); }
      } else if (t.orderType === 'rental' && t.refId) {
        await db.collection('equipmentRentals').doc(t.refId).update({
          paymentStatus: 'confirmed', status: 'active', ...clearReject, ...noteUpdate, ...pmUpdate, confirmedBy: by, confirmedByName: byName, confirmedAt: now, updatedAt: now,
        });
        // 器材租借轉帳確認收款 → 記營收（租金，冪等）
        try { await require('./rentals').recordRentalRevenue(db, t.refId, { staffId: by, staffName: byName }); }
        catch (e) { console.error('器材租借轉帳記帳失敗', e.message); }
      } else if (t.orderType === 'team_member' && t.refId) {
        const appRef = db.collection('teamApplications').doc(t.refId);
        await appRef.update({
          paymentStatus: 'confirmed', status: 'active', ...noteUpdate, ...pmUpdate, paidAt: now, paidConfirmedBy: by, paidConfirmedByName: byName, updatedAt: now,
        });
        // 開通隊員折扣資格（依年度）
        const app = (await appRef.get()).data();
        if (app?.memberId && app?.year) {
          await require('../services/teamMemberService').setTeamMember({
            memberId: app.memberId, since: `${app.year}-01-01`, until: `${app.year}-12-31`, staffId: by,
          });
        }
      }
      // 比賽/課程/入隊「臨櫃現金」收款確認 → 金額寫入該館當日結帳加減項（＋現金補入，note＝人名＋活動名）
      if (pm === 'cash' && ['course', 'competition', 'team_member'].includes(t.orderType)) { // 用更正後的方式判斷（改成電子支付就不寫現金補入；改成現金則要寫）
        try {
          await require('../services/settlementService').addCashAdjustment({
            gymId: t.gymId, amount: t.amount,
            note: `${t.memberName || ''} ${t.orderName || t.courseName || (t.orderType === 'team_member' ? '入隊隊費' : '')}`.trim(),
          });
          // 2026-08-27：抽屜現金由上面這筆「+現金補入」唯一負責——課程/比賽發票（延後開立，見
          // invoices.js checkInvoiceIssuanceTiming）的非轉帳付款方式在結帳付款統計「無條件」歸「其他」
          // （見 dailySettlements.js computeTodayInvoiceAuthority），開票日不會再把同一筆錢算進
          // payment.cash，也不再需要原本（2026-08-23）的 cashAdjustedForInvoice 旗標＋開票日沖銷機制。
        } catch (e) { console.error('現金收款寫入結帳加減項失敗', e.message); }
      }
    } catch (e) { console.error('transfer confirm side-effect:', e.message); }
    res.json({ message: '已確認收款' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// PUT /transfers/:id/reject - 退回（保留訂單、待會員補正；不釋放名額、不重算付款期限）
router.put('/:id/reject', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('transferRecords').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此轉帳紀錄' });
    const t = doc.data();
    const now = new Date();
    const reason = req.body.reason || '';
    await ref.update({
      status: 'rejected', rejectedBy: req.staff.id,
      rejectedAt: now, updatedAt: now, rejectReason: reason,
    });
    // 退回＝標記底層訂單「待補正」（course/experience/competition/rental 共用同一組欄位）：
    // 【保留訂單狀態、不釋放名額/不作廢】、【course 不動 paymentDeadline】（沿用原期限）。
    // → 會員可重新上傳轉帳（走 /transfers/upload）；course 期限一過仍未確認由 sweep 自動取消。
    try {
      if (t.orderType && t.refId && REJECTABLE_COLL[t.orderType]) {
        const orderRef = db.collection(REJECTABLE_COLL[t.orderType]).doc(t.refId);
        await orderRef.update({
          paymentStatus: 'transfer_rejected',
          paymentRejectReason: reason,
          paymentRejectedAt: now,
          paymentConfirmed: false,
          // 退回追蹤 metadata（供待辦頁「退回追蹤」列到結案）
          wasReturned: true, lastReturnType: 'payment', lastReturnReason: reason,
          lastReturnByName: req.staff?.name || '', lastReturnAt: now,
          // 入隊申請：狀態明確標「已退回」（會員端申請紀錄顯示、名冊顯示已退回）
          ...(t.orderType === 'team_member' ? { status: 'rejected' } : {}),
          updatedAt: now,
        });
        // 退回 → Email 通知會員（全訂單類型；email 以 members 集合權威解析、寄信失敗不阻斷）
        try {
          const order = (await orderRef.get()).data() || {};
          const memberId = order.memberId || t.memberId;
          let email = order.memberEmail || order.contactEmail || null;
          if (!email && memberId) {
            const mDoc = await db.collection('members').doc(memberId).get();
            if (mDoc.exists) email = mDoc.data().email || null;
          }
          if (email) {
            const TYPE_LABEL = { course:'課程報名', experience:'體驗預約', competition:'比賽報名', rental:'裝備租借', team_member:'攀岩隊入隊申請' };
            const orderName = t.orderName || t.courseName || order.courseName || order.competitionName || TYPE_LABEL[t.orderType] || '訂單';
            const { sendEmail, esc } = require('../services/emailService');
            await sendEmail({
              to: email,
              subject: `【紅石攀岩】${TYPE_LABEL[t.orderType] || ''}轉帳確認未通過`,
              html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
                <h2 style="color:#8B1A1A">紅石攀岩 RedRock</h2>
                <p>${esc(order.memberName || t.memberName || '')} 您好，</p>
                <p>您的「${esc(orderName)}」轉帳資料經確認<strong>未通過</strong>${reason ? `：<br/><strong>${esc(reason)}</strong>` : '。'}</p>
                <p>請至會員系統重新上傳轉帳資料，或聯絡櫃檯協助，謝謝。</p>
              </div>`,
            });
          }
        } catch (e) { console.error('轉帳退回通知信失敗', e.message); }
      }
    } catch (e) { console.error('transfer reject side-effect:', e.message); }
    res.json({ message: '已退回，會員可重新上傳轉帳' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
