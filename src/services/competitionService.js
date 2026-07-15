/**
 * 比賽報名 Service
 *
 * 設計重點：
 * - 每場賽事可自訂組別(divisions)與報名表單欄位(customFields)
 * - 每次報名需簽署獨立的風險聲明書（與日常waiver完全無關，每次報名都要重新簽）
 * - 未滿18歲需家長共同簽署，沿用既有waiver的家長遠端簽署機制（連結+72小時效期）
 * - 報名完成（含家長簽署，若需要）後，立即webhook通知對應的計分系統
 * - 計分系統二選一：rating_system 或 competition_management_v2，建賽事時指定
 * - webhookUrl 若未設定，僅記錄為 skipped，不會報錯，待對方提供網址後可直接補上啟用
 */
const { taiwanToday } = require('../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const { uploadSignature } = require('./waiverService');

const SCORING_SYSTEMS = ['rating_system', 'competition_management_v2'];

// ══════════════════════════════════════════════════════
// 賽事管理
// ══════════════════════════════════════════════════════

const createCompetition = async ({ name, description, gymId, registrationStart, registrationEnd, earlyBirdDeadline, eventDate, divisions, customFields, waiverContent, scoringSystem, webhookUrl, fees, refundPolicies, status, paymentDeadlineDays, staffId }) => {
  if (!SCORING_SYSTEMS.includes(scoringSystem)) {
    throw { code: 'INVALID_SCORING_SYSTEM', message: 'scoringSystem 必須為 rating_system 或 competition_management_v2' };
  }
  if (!Array.isArray(divisions) || divisions.length === 0) {
    throw { code: 'INVALID_DIVISIONS', message: '請至少設定一個組別' };
  }

  const db = getDb();
  const id = uuidv4();
  const now = new Date();
  const competition = {
    id, name, description: description || '',
    gymId: gymId || null,
    registrationStart, registrationEnd, eventDate,
    earlyBirdDeadline: earlyBirdDeadline || null,
    divisions: divisions.map(d => ({
      id: d.id || uuidv4(),
      name: d.name,
      maxParticipants: d.maxParticipants || 40,
      waitlistMax: d.waitlistMax || 5,
    })),
    // 費用設定
    fees: fees || {
      adultEarlyBird: 990, adultRegular: 1100,
      childEarlyBird: 840, childRegular: 950,
      teamMemberDiscount: 0.9,
      childAgeLimit: 15, // 幾歲以下算兒童
    },
    // 繳款期限：報名日 + N 天內須完成繳費（含臨櫃繳款），逾期由排程自動剔除名單。預設 3 天。
    paymentDeadlineDays: (paymentDeadlineDays === undefined || paymentDeadlineDays === null || paymentDeadlineDays === '') ? 3 : Math.max(1, parseInt(paymentDeadlineDays) || 3),
    // 退費政策（多組截止日+退款計算）
    refundPolicies: refundPolicies || [],
    customFields: (customFields || []).map(f => ({
      key: f.key, label: f.label, type: f.type || 'text', required: !!f.required, options: f.options || null,
    })),
    waiverContent: waiverContent || { zh: '', en: '' },
    scoringSystem,
    webhookUrl: webhookUrl || null,
    status: status || 'draft',
    createdBy: staffId, createdAt: now, updatedAt: now,
  };
  await db.collection(COLLECTIONS.COMPETITIONS).doc(id).set(competition);
  return competition;
};

// 管理員手動「開始與計分系統對接」：建/取得計分系統賽事 + 啟用同步 + 把目前所有正取名單推過去
const startScoringSync = async (competitionId) => {
  const db = getDb();
  const { syncCompEvent, syncCompAthlete, isCompScoring } = require('./competitionSyncService');
  const ref = db.collection(COLLECTIONS.COMPETITIONS).doc(competitionId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此賽事' };
  let competition = { id: competitionId, ...doc.data() };
  if (!isCompScoring(competition)) throw { code: 'NOT_COMP_SCORING', message: '此賽事的計分系統不是「紅石賽事管理 V2」，無法對接' };
  const ev = await syncCompEvent(competition);
  if (ev.status === 'skipped') throw { code: 'COMP_NOT_CONFIGURED', message: ev.reason || '計分系統尚未設定金鑰' };
  const compDocId = ev.compDocId;
  await ref.update({ compDocId, scoringSyncEnabled: true, scoringSyncStartedAt: new Date() });
  competition = { ...competition, compDocId, scoringSyncEnabled: true };
  // 推送目前所有正取報名（之後新報名會即時同步）
  const regs = await getCompetitionRegistrations(competitionId);
  let synced = 0, failed = 0, totalConfirmed = 0;
  for (const reg of regs) {
    if (reg.status !== 'confirmed') continue;
    totalConfirmed++;
    const r = await syncCompAthlete(competition, reg);
    await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(reg.id).update({ webhookStatus: r.webhookStatus, webhookSentAt: r.webhookSentAt || null, webhookError: r.webhookError || null });
    if (r.webhookStatus === 'sent') synced++; else failed++;
  }
  return { compDocId, synced, failed, totalConfirmed };
};

const updateCompetition = async (competitionId, updates) => {
  const db = getDb();
  const ref = db.collection(COLLECTIONS.COMPETITIONS).doc(competitionId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此賽事' };

  if (updates.scoringSystem && !SCORING_SYSTEMS.includes(updates.scoringSystem)) {
    throw { code: 'INVALID_SCORING_SYSTEM', message: 'scoringSystem 不正確' };
  }

  const allowed = ['name', 'description', 'gymId', 'registrationStart', 'registrationEnd', 'earlyBirdDeadline', 'eventDate',
    'divisions', 'customFields', 'waiverContent', 'scoringSystem', 'webhookUrl', 'status', 'fees', 'refundPolicies', 'paymentDeadlineDays'];
  const payload = { updatedAt: new Date() };
  allowed.forEach(f => { if (updates[f] !== undefined) payload[f] = updates[f]; });
  if (payload.paymentDeadlineDays !== undefined) {
    payload.paymentDeadlineDays = (payload.paymentDeadlineDays === null || payload.paymentDeadlineDays === '') ? 3 : Math.max(1, parseInt(payload.paymentDeadlineDays) || 3);
  }

  await ref.update(payload);
  const merged = { id: competitionId, ...doc.data(), ...payload };
  // 已啟用對接的賽事改名 → 同步更新計分系統賽事名（不重建、不蓋設定）
  if (merged.scoringSyncEnabled && merged.scoringSystem === 'competition_management_v2' && merged.compDocId && updates.name) {
    try { const { syncCompEvent } = require('./competitionSyncService'); await syncCompEvent(merged); }
    catch (e) { console.error('[計分系統] 更新賽事名失敗', e.message); }
  }
  return merged;
};

const getCompetitions = async (status) => {
  const db = getDb();
  let ref = db.collection(COLLECTIONS.COMPETITIONS);
  if (status) ref = ref.where('status', '==', status);
  const snap = await ref.get();
  const comps = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
  // 各組即時報名數（正取/候補）→ 會員端顯示「剩 N 位/額滿」
  for (const c of comps) {
    try {
      const regs = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
        .where('competitionId', '==', c.id).get();
      const byDiv = {};
      regs.docs.forEach(rd => {
        const r = rd.data();
        if (!byDiv[r.divisionId]) byDiv[r.divisionId] = { confirmed: 0, waitlist: 0 };
        if (r.status === 'confirmed') byDiv[r.divisionId].confirmed++;
        else if (r.status === 'waitlist') byDiv[r.divisionId].waitlist++;
      });
      c.divisions = (c.divisions || []).map(d => ({
        ...d,
        enrolledCount: byDiv[d.id]?.confirmed || 0,
        waitlistCount: byDiv[d.id]?.waitlist || 0,
      }));
    } catch (e) { /* 統計失敗不影響清單 */ }
  }
  return comps;
};

const getCompetition = async (competitionId) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.COMPETITIONS).doc(competitionId).get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此賽事' };
  return { id: doc.id, ...doc.data() };
};

// ══════════════════════════════════════════════════════
// 報名（含風險聲明書簽署）
// ══════════════════════════════════════════════════════

const registerForCompetition = async ({
  competitionId, memberId, memberName, isMinor, birthday, divisionId,
  gender, phone, email,
  customFieldValues, signatureData, guardianSignature, parentEmail, parentName, parentPhone, parentRelation,
  // 保險用欄位
  idNumber, emergencyContact, emergencyRelation, emergencyPhone,
  // 比賽用欄位
  height, armSpan, isHonorary,
  // 付款
  paymentDate, bankLastFive, bankName, paymentMethod,
  ip
}) => {
  const db = getDb();
  const competition = await getCompetition(competitionId);

  if (competition.status !== 'open') {
    throw { code: 'REGISTRATION_CLOSED', message: '此賽事目前未開放報名' };
  }
  // 用台灣日期(UTC+8)判截止，避免伺服器 UTC 讓「截止日隔天 00:00–08:00」仍可報名
  const today = taiwanToday();
  if (competition.registrationEnd && today > competition.registrationEnd) {
    throw { code: 'REGISTRATION_ENDED', message: '報名期限已截止' };
  }
  if (competition.registrationStart && today < competition.registrationStart) {
    throw { code: 'REGISTRATION_NOT_STARTED', message: '報名尚未開始' };
  }
  if (!competition.divisions.some(d => d.id === divisionId)) {
    throw { code: 'INVALID_DIVISION', message: '組別不正確' };
  }

  // 重複報名擋（權威）：同會員同賽事已有有效（非取消）報名 → 不可重複；家庭其他成員不受影響
  const dupSnap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations')
    .where('competitionId', '==', competitionId)
    .where('memberId', '==', memberId)
    .get();
  if (dupSnap.docs.some(d => d.data().status !== 'cancelled')) {
    throw { code: 'ALREADY_REGISTERED', message: `${memberName || '此會員'} 已報名此賽事` };
  }

  // 檢查組別人數上限
  const division = competition.divisions.find(d => d.id === divisionId);
  const existingSnap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations')
    .where('competitionId', '==', competitionId)
    .where('divisionId', '==', divisionId)
    .where('status', 'in', ['confirmed', 'waitlist'])
    .get();
  const confirmedCount = existingSnap.docs.filter(d => d.data().status === 'confirmed').length;
  const waitlistCount = existingSnap.docs.filter(d => d.data().status === 'waitlist').length;
  const maxParticipants = division.maxParticipants || 40;
  const waitlistMax = division.waitlistMax || 5;
  if (confirmedCount >= maxParticipants && waitlistCount >= waitlistMax) {
    throw { code: 'DIVISION_FULL', message: '此組別已滿（含候補），無法報名' };
  }
  const isWaitlist = confirmedCount >= maxParticipants;

  // 計算費用
  const fees = competition.fees || {};
  const todayStr = taiwanToday();
  const isEarlyBird = competition.earlyBirdDeadline && todayStr <= competition.earlyBirdDeadline;
  const childAgeLimit = fees.childAgeLimit || 15;
  const age = birthday ? dayjs().diff(dayjs(birthday), 'year') : null;
  const isChild = age !== null && age < childAgeLimit;
  let registrationFee = isChild
    ? (isEarlyBird ? fees.childEarlyBird : fees.childRegular) || 950
    : (isEarlyBird ? fees.adultEarlyBird : fees.adultRegular) || 1100;

  // 必填：性別/生日/手機/Email（自動帶會員資料、會員資料缺漏由報名表補填；帶進計分系統與保險名冊）
  if (gender !== 'male' && gender !== 'female') {
    throw { code: 'MISSING_GENDER', message: '請選擇性別' };
  }
  if (!birthday) {
    throw { code: 'MISSING_BIRTHDAY', message: '請填寫生日' };
  }
  if (!phone || !String(phone).trim()) {
    throw { code: 'MISSING_PHONE', message: '請填寫手機號碼' };
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
    throw { code: 'MISSING_EMAIL', message: '請填寫有效的 Email' };
  }
  if (paymentMethod === 'cash' && !paymentDate) {
    throw { code: 'MISSING_PAYMENT_DATE', message: '請填寫臨櫃繳款日期' };
  }
  if (paymentDate) {
    const maxDate = dayjs(taiwanToday()).add(3, 'day').format('YYYY-MM-DD');
    if (paymentDate < taiwanToday() || paymentDate > maxDate) {
      throw { code: 'INVALID_PAYMENT_DATE', message: '繳費日期須為報名日起 3 日內' };
    }
  }

  // 驗證必填自訂欄位
  for (const f of competition.customFields) {
    if (f.required && !customFieldValues?.[f.key]) {
      throw { code: 'MISSING_FIELD', message: `請填寫「${f.label}」` };
    }
  }

  const registrationId = uuidv4();
  const now = new Date();
  // 簽名上傳（失敗不阻斷報名）
  let memberSignatureUrl = null;
  try {
    memberSignatureUrl = await uploadSignature(`competition_${registrationId}`, 'member', signatureData);
  } catch (sigErr) { /* 簽名上傳失敗不影響報名，後續補簽 */ }
  // 未成年「現場法定代理人簽名」（報名表單同頁簽）：有簽即完成，不必再走 email 遠端
  let guardianSignatureUrl = null;
  if (isMinor && guardianSignature) {
    try {
      guardianSignatureUrl = await uploadSignature(`competition_${registrationId}`, 'guardian', guardianSignature);
    } catch (sigErr) { /* 同上，不阻斷 */ }
  }

  const registration = {
    id: registrationId, competitionId, competitionName: competition.name,
    memberId, memberName, divisionId, divisionName: division.name,
    status: isWaitlist ? 'waitlist' : 'confirmed',
    waitlistPosition: isWaitlist ? waitlistCount + 1 : null,
    customFieldValues: customFieldValues || {},
    // 選手基本資料（必填；帶進計分系統/保險名冊/名單 CSV）
    gender, birthday: birthday || null,
    phone: String(phone).trim(), email: String(email).trim(),
    // 保險用欄位
    idNumber: idNumber || null,
    emergencyContact: emergencyContact || null,
    emergencyRelation: emergencyRelation || null,
    emergencyPhone: emergencyPhone || null,
    // 比賽欄位
    height: height || null,
    armSpan: armSpan || null,
    isHonorary: !!isHonorary,
    isMinor: !!isMinor,
    // 費用
    registrationFee,
    isEarlyBird: !!isEarlyBird,
    // 付款
    paymentMethod: paymentMethod || 'transfer',
    paymentDate: paymentDate || null,
    bankLastFive: bankLastFive || null,
    bankName: bankName || null,
    paymentStatus: 'pending', // pending | confirmed | refunded
    paidAmount: null,
    paidAt: null,
    paidConfirmedBy: null,
    memberSignatureUrl, memberSignedAt: now, memberSignedIp: ip || null,
    parentRequired: !!isMinor,
    // 未成年：現場法定代理人簽名（guardianSignature）→ 報名即完成；否則待 email 遠端簽署
    guardianSignatureUrl: guardianSignatureUrl || null,
    guardianSignedAt: guardianSignatureUrl ? now : null,
    isComplete: !isMinor || !!guardianSignatureUrl,
    webhookStatus: 'pending', webhookSentAt: null, webhookError: null,
    registeredAt: now,
  };

  if (isMinor && !guardianSignatureUrl) {
    const token = uuidv4();
    const expiry = dayjs().add(parseInt(process.env.WAIVER_PARENT_TOKEN_HOURS) || 72, 'hour').toDate();
    Object.assign(registration, {
      parentName: parentName || null, parentEmail, parentPhone: parentPhone || null, parentRelation: parentRelation || null,
      parentSignToken: token, parentSignTokenExpiry: expiry,
    });
  } else if (isMinor) {
    Object.assign(registration, {
      parentName: parentName || null, parentEmail: parentEmail || null,
      parentPhone: parentPhone || null, parentRelation: parentRelation || null,
    });
  }

  // 原子化容量判斷 + 寫入：交易內重新讀取計數，避免並發超賣（前面的檢查僅為快速失敗）
  const regRef = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(registrationId);
  await db.runTransaction(async (tx) => {
    // 權威去重（交易內原子，杜絕並發雙擊重複報名/重複收費）：同會員同賽事已有非取消報名 → 擋。
    // 上方 191 行的同款檢查僅為快速失敗（避免對明顯重複者先上傳簽名）；此處為權威把關。
    const dupTx = await tx.get(
      db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
        .where('competitionId', '==', competitionId)
        .where('memberId', '==', memberId)
    );
    if (dupTx.docs.some(d => d.data().status !== 'cancelled')) {
      throw { code: 'ALREADY_REGISTERED', message: `${memberName || '此會員'} 已報名此賽事` };
    }
    const q = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
      .where('competitionId', '==', competitionId)
      .where('divisionId', '==', divisionId)
      .where('status', 'in', ['confirmed', 'waitlist']);
    const snap = await tx.get(q);
    const cCount = snap.docs.filter(d => d.data().status === 'confirmed').length;
    const wCount = snap.docs.filter(d => d.data().status === 'waitlist').length;
    if (cCount >= maxParticipants && wCount >= waitlistMax) {
      throw { code: 'DIVISION_FULL', message: '此組別已滿（含候補），無法報名' };
    }
    const willWaitlist = cCount >= maxParticipants;
    registration.status = willWaitlist ? 'waitlist' : 'confirmed';
    registration.waitlistPosition = willWaitlist ? wCount + 1 : null;
    // 繳款期限：正取且有費用 → 報名日 + N 天內須完成繳費（含臨櫃繳款），逾期由排程自動剔除。候補不設（遞補時才設）。
    if (!willWaitlist && registrationFee > 0) {
      const N = competition.paymentDeadlineDays || 3;
      registration.paymentDeadline = dayjs(now).add(N, 'day').toDate();
    }
    tx.set(regRef, registration);
  });

  if (isMinor && !guardianSignatureUrl && parentEmail) {
    // 未成年且未現場簽 → 寄法定代理人遠端簽署連結（備用路徑）
    const emailService = require('./emailService');
    try {
      await emailService.sendParentCompetitionWaiverLink({ memberName, competitionName: competition.name, parentEmail, parentName, token: registration.parentSignToken });
    } catch (e) {
      console.error('比賽報名家長簽署Email發送失敗（會員本人報名已成功保存）:', e.message);
    }
  } else if (registration.isComplete) {
    // 成年人、或未成年已現場簽 → 報名即完成，觸發webhook
    await sendWebhook(registrationId);
  }

  return registration;
};

// ── 家長遠端簽署比賽風險聲明書（沿用waiver的token機制）─────────────
const signParentCompetitionWaiver = async (token, signatureData, ip) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
    .where('parentSignToken', '==', token).limit(1).get();
  if (snap.empty) throw { code: 'INVALID_TOKEN', message: '連結無效或已過期' };

  const doc = snap.docs[0];
  const registration = doc.data();
  if (registration.isComplete) throw { code: 'ALREADY_SIGNED', message: '已完成簽署' };
  if (dayjs().isAfter(dayjs(registration.parentSignTokenExpiry.toDate ? registration.parentSignTokenExpiry.toDate() : registration.parentSignTokenExpiry))) {
    throw { code: 'TOKEN_EXPIRED', message: '連結已過期，請聯絡館方重新發送' };
  }

  const parentSignatureUrl = await uploadSignature(`competition_${doc.id}`, 'parent', signatureData);
  const now = new Date();
  await doc.ref.update({
    parentSignatureUrl, parentSignedAt: now, parentSignedIp: ip || null,
    isComplete: true,
    // 保留 parentSignToken / expiry：讓已簽後再點連結能查到並顯示「已完成簽署」
    //（重簽由上方 isComplete 擋 ALREADY_SIGNED）
  });

  await sendWebhook(doc.id);
  return { registrationId: doc.id };
};

// ══════════════════════════════════════════════════════
// Webhook 推送至計分系統
// ══════════════════════════════════════════════════════

const sendWebhook = async (registrationId) => {
  const db = getDb();
  const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(registrationId);
  const doc = await ref.get();
  if (!doc.exists) return;
  const registration = doc.data();

  // 候補/未確認名額不推送計分系統（遞補為正取時才會推送），一次涵蓋報名/家長簽署/retry
  if (registration.status !== 'confirmed') {
    await ref.update({ webhookStatus: 'skipped', webhookError: '候補或未確認名額，暫不推送計分系統' });
    return;
  }

  const competition = await getCompetition(registration.competitionId);

  // 計分系統 v2（紅石賽事計分系統 / Redrock-comp）：跨專案直寫 Firestore，不走 HTTP webhook
  const { isCompScoring, syncCompEvent, syncCompAthlete } = require('./competitionSyncService');
  if (isCompScoring(competition)) {
    if (!competition.scoringSyncEnabled) {   // 管理員尚未按「開始與計分系統對接」→ 暫不推送
      await ref.update({ webhookStatus: 'skipped', webhookError: '尚未開始與計分系統對接（管理員未啟用）' });
      return;
    }
    let comp = competition;
    if (!comp.compDocId) {                       // 賽事尚未建到計分系統 → 先建（懶建立）
      const ev = await syncCompEvent(comp);
      if (ev.compDocId) {
        await db.collection(COLLECTIONS.COMPETITIONS).doc(comp.id).update({ compDocId: ev.compDocId });
        comp = { ...comp, compDocId: ev.compDocId };
      }
    }
    const r = await syncCompAthlete(comp, registration);
    await ref.update({ webhookStatus: r.webhookStatus, webhookSentAt: r.webhookSentAt || null, webhookError: r.webhookError || null });
    return;
  }

  if (!competition.webhookUrl) {
    await ref.update({ webhookStatus: 'skipped', webhookError: '此賽事尚未設定計分系統webhook網址' });
    return;
  }

  const payload = {
    registrationId, competitionId: competition.id, competitionName: competition.name,
    scoringSystem: competition.scoringSystem,
    memberId: registration.memberId, memberName: registration.memberName,
    divisionId: registration.divisionId,
    divisionName: competition.divisions.find(d => d.id === registration.divisionId)?.name || '',
    customFieldValues: registration.customFieldValues,
    status: registration.status,
    registeredAt: registration.registeredAt,
  };

  // SSRF 防護：只允許 https 外網位址，擋內網/本機/雲端 metadata
  const isSafeWebhookUrl = (raw) => {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:') return false;
      const h = u.hostname.toLowerCase();
      if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
      if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
      if (h === '::1' || h.startsWith('fd') || h.startsWith('fe80')) return false;
      return true;
    } catch (e) { return false; }
  };
  if (!isSafeWebhookUrl(competition.webhookUrl)) {
    await ref.update({ webhookStatus: 'failed', webhookError: 'unsafe_webhook_url' });
    return;
  }

  try {
    const res = await fetch(competition.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',                   // 不跟隨轉址，避免繞過白名單
      signal: AbortSignal.timeout(5000),   // 逾時保護
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await ref.update({ webhookStatus: 'sent', webhookSentAt: new Date(), webhookError: null });
  } catch (err) {
    await ref.update({ webhookStatus: 'failed', webhookError: err.message });
  }
};

// ── 手動重新推送（webhook失敗或URL剛補上時使用）─────────────────────
const retryWebhook = async (registrationId) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(registrationId).get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此報名紀錄' };
  if (!doc.data().isComplete) throw { code: 'NOT_COMPLETE', message: '尚未完成簽署（可能等待家長簽署中），無法推送' };
  await sendWebhook(registrationId);
  const updated = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(registrationId).get();
  return { id: registrationId, ...updated.data() };
};

// ── 取消正取後遞補：把同組別最前面的候補遞補為正取（原子操作）─────────
// 回傳被遞補的 registrationId（若有）；webhook 在交易外觸發避免重試重複送
const promoteNextWaitlist = async (competitionId, divisionId) => {
  const db = getDb();
  let promotedId = null, promotedComplete = false;
  await db.runTransaction(async (tx) => {
    const q = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
      .where('competitionId', '==', competitionId)
      .where('divisionId', '==', divisionId)
      .where('status', '==', 'waitlist');
    const snap = await tx.get(q);
    if (snap.empty) return;
    const sorted = snap.docs
      .map(d => ({ ref: d.ref, ...d.data() }))
      .sort((a, b) =>
        (a.waitlistPosition || 9999) - (b.waitlistPosition || 9999) ||
        ((a.registeredAt?.seconds || a.registeredAt?._seconds || 0) - (b.registeredAt?.seconds || b.registeredAt?._seconds || 0)));
    const next = sorted[0];
    // 遞補為正取 → 起算繳款期限（報名日制不適用，改以遞補日 + N 天）；已收款或免費者不設
    const promoteUpdate = { status: 'confirmed', waitlistPosition: null, promotedAt: new Date(), updatedAt: new Date() };
    if (next.paymentStatus !== 'confirmed' && (next.registrationFee || 0) > 0) {
      const comp = (await tx.get(db.collection(COLLECTIONS.COMPETITIONS).doc(competitionId))).data();
      const N = (comp && comp.paymentDeadlineDays) || 3;
      promoteUpdate.paymentDeadline = dayjs().add(N, 'day').toDate();
    }
    tx.update(next.ref, promoteUpdate);
    // 其餘候補位置往前遞移
    for (let i = 1; i < sorted.length; i++) {
      tx.update(sorted[i].ref, { waitlistPosition: i, updatedAt: new Date() });
    }
    promotedId = next.id;
    promotedComplete = !!next.isComplete;
  });
  // 遞補者若已完成簽署（成年人或家長已簽），立即推送計分系統；未完成者待簽署後自然推送
  if (promotedId && promotedComplete) await sendWebhook(promotedId);
  return promotedId;
};

const getCompetitionRegistrations = async (competitionId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
    .where('competitionId', '==', competitionId)
    .get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.registeredAt?._seconds || 0) - (b.registeredAt?._seconds || 0));
};

const getMemberRegistrations = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
    .where('memberId', '==', memberId)
    .get();
  return snap.docs
    .map(d => { const { staffNote, ...rest } = d.data(); return { id: d.id, ...rest }; }) // staffNote＝員工內部備註，不回傳會員
    .sort((a, b) => (b.registeredAt?._seconds || b.createdAt?._seconds || 0) - (a.registeredAt?._seconds || a.createdAt?._seconds || 0));
};

// 比賽營收記帳（認列在「比賽前一天」＝eventDate−1）。收款冪等（revenueRecorded），退費記負向。
// 供 confirm-payment / refund / 轉帳確認 三條路徑共用，避免重複記帳。
const recordCompetitionRevenue = async ({ db, regId, sign = 1, refund = false, staffId = null, staffName = '' }) => {
  if (!db) db = getDb();
  const { recordTransaction } = require('../utils/revenueLedger');
  const regRef = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(regId);
  const regSnap = await regRef.get();
  if (!regSnap.exists) return;
  const reg = regSnap.data();
  if (sign > 0 && reg.revenueRecorded) return; // 冪等：收款只記一次
  const amount = sign > 0
    ? (reg.paidAmount || reg.registrationFee || 0)
    : (reg.refundAmount || reg.paidAmount || reg.registrationFee || 0);
  if (!amount || amount <= 0) return;
  let recognitionDate = null, gymId = reg.gymId || null;
  try {
    const cSnap = await db.collection(COLLECTIONS.COMPETITIONS).doc(reg.competitionId).get();
    if (cSnap.exists) {
      const c = cSnap.data();
      gymId = gymId || c.gymId || null;
      if (c.eventDate) recognitionDate = dayjs(c.eventDate).subtract(1, 'day').format('YYYY-MM-DD');
    }
  } catch (e) {}
  await recordTransaction(db, {
    gymId,
    type: refund ? 'competition_refund' : 'competition',
    totalAmount: sign * Math.abs(amount),
    paymentMethod: refund ? 'refund' : (reg.paymentMethod || 'transfer'),
    memberId: reg.memberId || null,
    memberName: reg.memberName || '',
    relatedId: regId,
    notes: `${refund ? '比賽退費' : '比賽報名'}：${reg.competitionName || ''}`,
    staffId, staffName, recognitionDate,
  });
  if (sign > 0) await regRef.update({ revenueRecorded: true });
};

// 逾期未繳費自動剔除名單：正取 + 未繳費 + 「未填匯款資料」+ 有費用 + 逾繳款期限 → 取消、釋名額、遞補候補、Email 通知。
// 只剔除「未填匯款資料」者（pending 且無末五碼）；已填待確認(pending_confirm/有末五碼)、已收款、免費者不剔除。
const sweepExpiredCompetitionPayments = async () => {
  const db = getDb();
  const now = new Date();
  const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
    .where('status', '==', 'confirmed')
    .where('paymentStatus', '==', 'pending')
    .get();
  let cancelled = 0;
  for (const doc of snap.docs) {
    const r = doc.data();
    if (!(r.registrationFee > 0)) continue;   // 免費（榮譽）不剔除
    if (r.bankLastFive) continue;             // 已填匯款資料（待確認）→ 不剔除（球在櫃檯）
    if (!r.paymentDeadline) continue;
    const dl = r.paymentDeadline.toDate ? r.paymentDeadline.toDate()
      : new Date(r.paymentDeadline._seconds ? r.paymentDeadline._seconds * 1000 : r.paymentDeadline);
    if (dl >= now) continue;
    try {
      await doc.ref.update({ status: 'cancelled', cancelReason: 'payment_expired', paymentExpiredAt: now, updatedAt: now });
      const comp = (await db.collection(COLLECTIONS.COMPETITIONS).doc(r.competitionId).get()).data();
      const { isCompScoring, removeCompAthlete } = require('./competitionSyncService');
      if (comp && isCompScoring(comp)) { try { await removeCompAthlete(comp, doc.id); } catch (e) {} }
      try { await promoteNextWaitlist(r.competitionId, r.divisionId); } catch (e) {}
      const email = r.email || (await db.collection('members').doc(r.memberId).get()).data()?.email;
      if (email) {
        try {
          const emailService = require('./emailService');
          await emailService.sendEmail({ to: email, subject: '【紅石攀岩】比賽報名已逾期取消',
            html: `<p>您好，您報名「${r.competitionName || '比賽'}」因逾繳款期限未完成繳費，已自動取消、釋出名額。</p><p>如仍要參賽請重新報名（額滿可能改候補）。</p>` });
        } catch (e) {}
      }
      cancelled++;
    } catch (e) { console.error('sweepExpiredCompetitionPayments 單筆失敗', doc.id, e.message); }
  }
  if (cancelled > 0) console.log(`[比賽逾期] 取消 ${cancelled} 筆未繳費報名`);
  return { cancelled };
};

module.exports = {
  sweepExpiredCompetitionPayments,
  SCORING_SYSTEMS,
  createCompetition, updateCompetition, getCompetitions, getCompetition,
  registerForCompetition, signParentCompetitionWaiver,
  sendWebhook, retryWebhook, promoteNextWaitlist, startScoringSync,
  getCompetitionRegistrations, getMemberRegistrations,
  recordCompetitionRevenue,
};
