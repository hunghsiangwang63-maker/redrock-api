/**
 * 定期票異動管理 Service
 *
 * 涵蓋範圍：
 * 1. 異動歷史記錄（編輯/展延/退費/轉讓/年假批次展延，統一記錄操作者/時間/原因）
 * 2. 會員申請流程（展延/退費/轉讓三選一，限一次，需上傳證明文件）
 * 3. 員工審核（核准時依規則自動計算結果）
 * 4. 年假批次展延（依場館設定假期區間，全館聯集計算實際展延天數，不佔個人申請次數）
 *
 * 業務規則（90日票適用範例，依館方公告為準）：
 * - 展延：以一次為限，展延期間不得逾6個月
 * - 退費：持發票辦理，扣除手續費NT$600後按剩餘天數比例退費（四捨五入），天數自退費日「隔日」起算
 * - 轉讓：手續費NT$300，原權益不變
 * - 三者擇一，且每張票限申請一次（年假批次展延不算在此限制內）
 */
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { isChild } = require('../utils/age');

const REFUND_FEE = 600;
const TRANSFER_FEE = 300;
const MAX_EXTENSION_MONTHS = 6;

const REQUEST_REASONS = [
  { key:'abroad', label:'因出國逾2個月以上' },
  { key:'health', label:'因傷害、疾病或身體不適致不宜運動' },
  { key:'pregnancy', label:'因懷孕或有育養出生未逾6個月嬰兒之需要' },
  { key:'relocation', label:'因職務異動或遷居致難以行使其權利' },
];

// ── 記錄一筆異動歷史（共用於所有異動類型）──────────────────────────
const logAdjustment = async ({ passId, type, beforeData, afterData, reason, operatorId, operatorName, operatorType }) => {
  const db = getDb();
  const id = uuidv4();
  await db.collection(COLLECTIONS.PASS_ADJUSTMENTS).doc(id).set({
    id, passId, type, // 'edit' | 'extension' | 'refund' | 'transfer' | 'holiday_batch'
    beforeData: beforeData || null, afterData: afterData || null,
    reason: reason || '',
    operatorId: operatorId || null, operatorName: operatorName || '',
    operatorType: operatorType || 'staff', // staff | system(批次)
    createdAt: new Date(),
  });
  return id;
};

// ── 查詢某張票的異動歷史 ──────────────────────────────────────────
const getPassAdjustmentHistory = async (passId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.PASS_ADJUSTMENTS)
    .where('passId', '==', passId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const aTime = a.createdAt?._seconds || a.createdAt?.seconds || new Date(a.createdAt).getTime() / 1000;
      const bTime = b.createdAt?._seconds || b.createdAt?.seconds || new Date(b.createdAt).getTime() / 1000;
      return bTime - aTime;
    });
};

// ══════════════════════════════════════════════════════
// 會員申請（展延/退費/轉讓 三選一，限一次）
// ══════════════════════════════════════════════════════

const createPassRequest = async ({ passId, memberId, type, reasonKey, reasonDetail, evidenceUrl, transferToPhone, transferToMemberId, suspendStart, suspendEnd }) => {
  if (!['extension', 'refund', 'transfer'].includes(type)) {
    throw { code: 'INVALID_TYPE', message: 'type 必須為 extension、refund 或 transfer' };
  }
  if (!REQUEST_REASONS.some(r => r.key === reasonKey)) {
    throw { code: 'INVALID_REASON', message: '請選擇符合的事由' };
  }
  if (!evidenceUrl) {
    throw { code: 'MISSING_EVIDENCE', message: '請上傳證明文件' };
  }

  const db = getDb();
  const passDoc = await db.collection(COLLECTIONS.MEMBER_PASSES).doc(passId).get();
  if (!passDoc.exists) throw { code: 'PASS_NOT_FOUND', message: '找不到此定期票' };
  const pass = passDoc.data();
  if (pass.memberId !== memberId) throw { code: 'FORBIDDEN', message: '只能為自己的定期票申請' };
  if (pass.requestUsed) throw { code: 'REQUEST_ALREADY_USED', message: '此張定期票已使用過展延/退費/轉讓申請（三者擇一，限一次）' };

  // 展延：會員自填停用期間（起訖日），後端權威驗證並算出延後天數與新到期日
  //  ‧ 開始日不可早於申請日（今天，台灣時間）
  //  ‧ 延後天數＝停用結束日−停用開始日；新到期日＝原到期日＋延後天數
  //  ‧ 新到期日不可比原到期日晚超過 6 個月
  let extensionDays = null, extensionNewEndDate = null;
  if (type === 'extension') {
    if (!suspendStart || !suspendEnd) throw { code: 'MISSING_SUSPEND_PERIOD', message: '請填寫停用期間（起訖日）' };
    const today = dayjs().format('YYYY-MM-DD');
    const s = dayjs(suspendStart), e = dayjs(suspendEnd);
    if (!s.isValid() || !e.isValid()) throw { code: 'INVALID_SUSPEND_PERIOD', message: '停用期間日期格式不正確' };
    if (suspendStart < today) throw { code: 'SUSPEND_START_TOO_EARLY', message: '停用開始日不可早於申請日' };
    extensionDays = e.diff(s, 'day');
    if (extensionDays <= 0) throw { code: 'INVALID_SUSPEND_PERIOD', message: '停用結束日必須晚於開始日' };
    extensionNewEndDate = dayjs(pass.endDate).add(extensionDays, 'day').format('YYYY-MM-DD');
    const maxEndDate = dayjs(pass.endDate).add(MAX_EXTENSION_MONTHS, 'month').format('YYYY-MM-DD');
    if (extensionNewEndDate > maxEndDate) {
      throw { code: 'EXTENSION_EXCEEDS_LIMIT', message: `展延後到期日不可比原到期日（${pass.endDate}）晚超過 ${MAX_EXTENSION_MONTHS} 個月` };
    }
  }

  // 轉讓：後端權威驗證接收對象（送出時就擋打錯電話/非會員/誤轉；支援選定家庭成員）
  let transferTarget = null;
  if (type === 'transfer') {
    if (!transferToMemberId) throw { code: 'MISSING_TRANSFER_TARGET', message: '請選擇轉讓對象' };
    const tDoc = await db.collection(COLLECTIONS.MEMBERS).doc(transferToMemberId).get();
    if (!tDoc.exists) throw { code: 'TARGET_MEMBER_NOT_FOUND', message: '找不到轉讓對象會員，請確認' };
    if (transferToMemberId === memberId) throw { code: 'CANNOT_TRANSFER_SELF', message: '不能轉讓給自己' };
    // 未滿 13 歲不可接收定期票轉讓（與「兒童不能買定期票/接受點數轉移」一致）
    if (isChild(tDoc.data())) throw { code: 'CHILD_NOT_ALLOWED', message: '未滿 13 歲無法接收定期票轉讓' };
    transferTarget = { id: transferToMemberId, name: tDoc.data().name || '', phone: tDoc.data().phone || (transferToPhone || '') };
  }

  // 是否已有處理中的申請
  const pendingSnap = await db.collection(COLLECTIONS.PASS_REQUESTS)
    .where('passId', '==', passId).where('status', '==', 'pending').limit(1).get();
  if (!pendingSnap.empty) throw { code: 'REQUEST_PENDING', message: '此張定期票已有申請處理中，請等待審核結果' };

  const id = uuidv4();
  const now = new Date();
  const request = {
    id, passId, memberId,
    memberName: pass.memberName || '',
    passTypeName: pass.passTypeName,
    type, reasonKey,
    reasonLabel: REQUEST_REASONS.find(r => r.key === reasonKey)?.label,
    reasonDetail: reasonDetail || '',
    evidenceUrl,
    transferToPhone: type === 'transfer' ? (transferTarget?.phone || transferToPhone || '') : null,
    transferToMemberId: type === 'transfer' ? (transferTarget?.id || null) : null,
    transferToName: type === 'transfer' ? (transferTarget?.name || '') : null,
    // 展延：停用期間 + 後端算好的延後天數/新到期日（核准時據此更新，不再由店員填月數）
    suspendStart: type === 'extension' ? suspendStart : null,
    suspendEnd: type === 'extension' ? suspendEnd : null,
    extensionDays: type === 'extension' ? extensionDays : null,
    passEndDateAtRequest: type === 'extension' ? pass.endDate : null,
    status: 'pending', // pending | approved | rejected
    reviewedBy: null, reviewedAt: null, rejectReason: null,
    createdAt: now,
  };
  await db.collection(COLLECTIONS.PASS_REQUESTS).doc(id).set(request);
  return request;
};

const getMemberPassRequests = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.PASS_REQUESTS)
    .where('memberId', '==', memberId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const aTime = a.createdAt?._seconds || a.createdAt?.seconds || new Date(a.createdAt).getTime() / 1000;
      const bTime = b.createdAt?._seconds || b.createdAt?.seconds || new Date(b.createdAt).getTime() / 1000;
      return bTime - aTime;
    });
};

const getAllPassRequests = async (status) => {
  const db = getDb();
  let ref = db.collection(COLLECTIONS.PASS_REQUESTS);
  if (status) ref = ref.where('status', '==', status);
  const snap = await ref.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const aTime = a.createdAt?._seconds || a.createdAt?.seconds || new Date(a.createdAt).getTime() / 1000;
      const bTime = b.createdAt?._seconds || b.createdAt?.seconds || new Date(b.createdAt).getTime() / 1000;
      return bTime - aTime;
    });
};

// ── 員工審核：核准 ────────────────────────────────────────────────
const approvePassRequest = async ({ requestId, operatorId, operatorName, extensionMonths, hasInvoice }) => {
  const db = getDb();
  const reqRef = db.collection(COLLECTIONS.PASS_REQUESTS).doc(requestId);
  const reqDoc = await reqRef.get();
  if (!reqDoc.exists) throw { code: 'NOT_FOUND', message: '找不到此申請' };
  const request = reqDoc.data();
  if (request.status !== 'pending') throw { code: 'ALREADY_REVIEWED', message: '此申請已處理過' };

  const passRef = db.collection(COLLECTIONS.MEMBER_PASSES).doc(request.passId);
  const passDoc = await passRef.get();
  if (!passDoc.exists) throw { code: 'PASS_NOT_FOUND', message: '找不到對應的定期票' };
  const pass = { id: passDoc.id, ...passDoc.data() };

  const now = new Date();
  let result = {};

  if (request.type === 'extension') {
    // 新制：會員申請時已填停用期間、後端算好延後天數 → 依此延長（不再由店員填月數）。
    //       核准當下以「現行 pass.endDate + 延後天數」重算，並再次守住 6 個月上限（防審核期間票期有變）。
    // 舊制相容：無 extensionDays 的舊申請 → 沿用店員填的月數（capped 6）。
    let newEndDate, afterMeta;
    if (Number.isFinite(request.extensionDays) && request.extensionDays > 0) {
      const days = request.extensionDays;
      const maxEndDate = dayjs(pass.endDate).add(MAX_EXTENSION_MONTHS, 'month').format('YYYY-MM-DD');
      newEndDate = dayjs(pass.endDate).add(days, 'day').format('YYYY-MM-DD');
      if (newEndDate > maxEndDate) newEndDate = maxEndDate;   // 權威守 6 個月上限
      afterMeta = { endDate: newEndDate, days, suspendStart: request.suspendStart, suspendEnd: request.suspendEnd };
    } else {
      const months = Math.min(parseInt(extensionMonths) || MAX_EXTENSION_MONTHS, MAX_EXTENSION_MONTHS);
      newEndDate = dayjs(pass.endDate).add(months, 'month').format('YYYY-MM-DD');
      afterMeta = { endDate: newEndDate, months };
    }
    await passRef.update({ endDate: newEndDate, requestUsed: true, updatedAt: now });
    await logAdjustment({
      passId: pass.id, type: 'extension',
      beforeData: { endDate: pass.endDate }, afterData: afterMeta,
      reason: `會員申請展延核准：${request.reasonLabel}`,
      operatorId, operatorName, operatorType: 'staff',
    });
    result = { newEndDate, ...afterMeta };

  } else if (request.type === 'refund') {
    if (!hasInvoice) throw { code: 'INVOICE_REQUIRED', message: '退費需確認會員已提供發票正本' };
    // 退費前先還原「課程重疊補償」延長（政策 2026-07-17）：補償天數是免費贈延、非付費價值，
    // 不還原會把延長天數算進 總天數/剩餘天數 → 多退錢。還原失敗不阻斷（走原 endDate 計算）。
    let effEndDate = pass.endDate;
    try {
      const reverted = await require('./passOverlapService').revertAllOverlapForPass(pass.id);
      if (reverted && reverted.newEndDate) effEndDate = reverted.newEndDate;
    } catch (e) { console.error('重疊補償還原失敗（退費照原 endDate 計）:', e.message); }
    const today = dayjs();
    const totalDays = dayjs(effEndDate).diff(dayjs(pass.startDate), 'day');
    const remainingDays = Math.max(0, dayjs(effEndDate).diff(today, 'day'));
    const passTypeDoc = await db.collection(COLLECTIONS.PASS_TYPES).doc(pass.passTypeId).get();
    const originalPrice = passTypeDoc.exists ? passTypeDoc.data().price : 0;
    const dailyRate = totalDays > 0 ? originalPrice / totalDays : 0;
    const grossRefund = Math.round(dailyRate * remainingDays);
    const netRefund = Math.max(0, grossRefund - REFUND_FEE);

    await passRef.update({ status: 'cancelled', requestUsed: true, updatedAt: now });
    await logAdjustment({
      passId: pass.id, type: 'refund',
      beforeData: { status: pass.status, endDate: pass.endDate },
      afterData: { status: 'cancelled', netRefund, grossRefund, fee: REFUND_FEE, remainingDays },
      reason: `會員申請退費核准：${request.reasonLabel}`,
      operatorId, operatorName, operatorType: 'staff',
    });
    result = { grossRefund, fee: REFUND_FEE, netRefund, remainingDays };

  } else if (request.type === 'transfer') {
    // 優先用申請時已選定的接收會員 id（避免共用電話誤解析/誤轉）；舊申請無 id 才退回依電話查
    let targetMember;
    if (request.transferToMemberId) {
      const tDoc = await db.collection(COLLECTIONS.MEMBERS).doc(request.transferToMemberId).get();
      if (!tDoc.exists) throw { code: 'TARGET_MEMBER_NOT_FOUND', message: '找不到轉讓對象會員，請確認' };
      targetMember = tDoc;
    } else {
      if (!request.transferToPhone) throw { code: 'MISSING_TRANSFER_TARGET', message: '缺少轉讓對象電話' };
      const phoneToSearch = request.transferToPhone.trim();
      let targetSnap = await db.collection(COLLECTIONS.MEMBERS).where('phone', '==', phoneToSearch).limit(1).get();
      if (targetSnap.empty && phoneToSearch.startsWith('+886')) {
        const localPhone = '0' + phoneToSearch.slice(4);
        targetSnap = await db.collection(COLLECTIONS.MEMBERS).where('phone', '==', localPhone).limit(1).get();
      }
      if (targetSnap.empty) throw { code: 'TARGET_MEMBER_NOT_FOUND', message: `找不到轉讓對象會員（${phoneToSearch}），請確認電話號碼` };
      targetMember = targetSnap.docs[0];
    }
    // 權威後盾：未滿 13 歲不可接收（涵蓋舊申請/電話路徑）
    if (isChild(targetMember.data())) throw { code: 'CHILD_NOT_ALLOWED', message: '未滿 13 歲無法接收定期票轉讓' };

    await passRef.update({
      memberId: targetMember.id, memberName: targetMember.data().name,
      requestUsed: true,
      // 轉入註記（收票人卡片顯示「由 XXX 轉入」）：原持有人 id/姓名 + 轉讓日期
      transferredFrom: pass.memberId, transferredFromName: pass.memberName || '',
      transferredAt: dayjs(now).format('YYYY-MM-DD'),
      updatedAt: now,
    });
    await logAdjustment({
      passId: pass.id, type: 'transfer',
      beforeData: { memberId: pass.memberId }, afterData: { memberId: targetMember.id, fee: TRANSFER_FEE },
      reason: `會員申請轉讓核准：${request.reasonLabel} → 轉讓予 ${targetMember.data().name}`,
      operatorId, operatorName, operatorType: 'staff',
    });
    result = { fee: TRANSFER_FEE, newOwnerName: targetMember.data().name };
  }

  await reqRef.update({ status: 'approved', reviewedBy: operatorId, reviewedAt: now, result });
  return { request: { ...request, status: 'approved', result }, result };
};

// ── 員工審核：拒絕 ────────────────────────────────────────────────
const rejectPassRequest = async ({ requestId, operatorId, rejectReason }) => {
  const db = getDb();
  const reqRef = db.collection(COLLECTIONS.PASS_REQUESTS).doc(requestId);
  const reqDoc = await reqRef.get();
  if (!reqDoc.exists) throw { code: 'NOT_FOUND', message: '找不到此申請' };
  if (reqDoc.data().status !== 'pending') throw { code: 'ALREADY_REVIEWED', message: '此申請已處理過' };

  await reqRef.update({ status: 'rejected', reviewedBy: operatorId, reviewedAt: new Date(), rejectReason: rejectReason || '' });
  return { id: requestId };
};

// ══════════════════════════════════════════════════════
// 員工直接編輯（不經申請流程，管理員/館別電腦快速調整用）
// ══════════════════════════════════════════════════════

const editPass = async ({ passId, updates, reason, operatorId, operatorName }) => {
  const db = getDb();
  const ref = db.collection(COLLECTIONS.MEMBER_PASSES).doc(passId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此定期票' };
  const before = doc.data();

  const allowed = ['endDate', 'credits', 'status', 'notes'];
  const payload = {};
  allowed.forEach(f => { if (updates[f] !== undefined) payload[f] = updates[f]; });
  payload.updatedAt = new Date();

  await ref.update(payload);
  await logAdjustment({
    passId, type: 'edit',
    beforeData: { endDate: before.endDate, credits: before.credits, status: before.status },
    afterData: payload,
    reason: reason || '管理員手動編輯',
    operatorId, operatorName, operatorType: 'staff',
  });
  return { id: passId, ...before, ...payload };
};

// ══════════════════════════════════════════════════════
// 年假批次展延
// ══════════════════════════════════════════════════════

// 計算日期區間的天數（含頭尾）
const daysBetweenInclusive = (start, end) => dayjs(end).diff(dayjs(start), 'day') + 1;

// 計算多個日期區間的聯集天數（用於全館票橫跨多館休館期間時，避免重複計算重疊天數）
const unionDaysCount = (ranges) => {
  if (ranges.length === 0) return 0;
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  let merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= dayjs(last.end).add(1, 'day').format('YYYY-MM-DD')) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged.reduce((sum, r) => sum + daysBetweenInclusive(r.start, r.end), 0);
};

// ── 執行年假批次展延 ──────────────────────────────────────────────
// holidayRanges: [{ gymId, start, end }] 各館各自設定的假期區間（可不同）
const runHolidayBatchExtension = async ({ holidayRanges, operatorId, operatorName }) => {
  if (!Array.isArray(holidayRanges) || holidayRanges.length === 0) {
    throw { code: 'MISSING_RANGES', message: '請至少設定一個場館的假期區間' };
  }

  const db = getDb();
  const rangesByGym = {};
  holidayRanges.forEach(r => { rangesByGym[r.gymId] = { start: r.start, end: r.end }; });
  const allRangesList = Object.values(rangesByGym);
  const unionDays = unionDaysCount(allRangesList);

  // 取得所有有效定期票（status active 且尚未過期）
  const today = dayjs().format('YYYY-MM-DD');
  const snap = await db.collection(COLLECTIONS.MEMBER_PASSES)
    .where('status', '==', 'active')
    .where('endDate', '>=', today)
    .get();

  let extendedCount = 0;
  let batch = db.batch();
  let batchOps = 0;
  const adjustmentLogs = [];

  for (const doc of snap.docs) {
    const pass = doc.data();
    let extendDays = 0;

    if (pass.scope === 'single') {
      // 單館票：只看該票所屬館別的假期區間
      const gymId = pass.targetGymId || pass.gymId;
      const range = rangesByGym[gymId];
      if (range) extendDays = daysBetweenInclusive(range.start, range.end);
    } else {
      // 全館票：取所有有公告假期的場館「聯集」天數，避免兩館分別公告假期時重複展延
      extendDays = unionDays;
    }

    if (extendDays > 0) {
      const newEndDate = dayjs(pass.endDate).add(extendDays, 'day').format('YYYY-MM-DD');
      batch.update(doc.ref, { endDate: newEndDate, updatedAt: new Date() });
      if (++batchOps >= 450) { await batch.commit(); batch = db.batch(); batchOps = 0; }
      adjustmentLogs.push({
        passId: doc.id, type: 'holiday_batch',
        beforeData: { endDate: pass.endDate },
        afterData: { endDate: newEndDate, extendDays, scope: pass.scope },
        reason: `年假休館批次展延（${pass.scope === 'single' ? '單館' : '全館聯集'} ${extendDays} 天）`,
        operatorId, operatorName, operatorType: 'staff',
        memberName: pass.memberName || '', memberId: pass.memberId || '',
      });
      extendedCount++;
    }
  }

  if (batchOps > 0) await batch.commit();
  // 異動記錄量可能很大，逐筆寫入（非batch，避免單一batch超過500筆限制）
  for (const log of adjustmentLogs) {
    await logAdjustment(log);
  }

  // 整理展延清單供前端顯示
  const extendedList = adjustmentLogs.map(l => ({
    passId: l.passId,
    memberId: l.memberId,
    memberName: l.memberName,
    beforeEndDate: l.beforeData.endDate,
    afterEndDate: l.afterData.endDate,
    extendDays: l.afterData.extendDays,
    scope: l.afterData.scope,
  }));

  return { extendedCount, unionDays, totalPasses: snap.docs.length, extendedList };
};

module.exports = {
  REQUEST_REASONS, REFUND_FEE, TRANSFER_FEE, MAX_EXTENSION_MONTHS,
  logAdjustment, getPassAdjustmentHistory,
  createPassRequest, getMemberPassRequests, getAllPassRequests,
  approvePassRequest, rejectPassRequest,
  editPass,
  unionDaysCount, daysBetweenInclusive, runHolidayBatchExtension,
};
